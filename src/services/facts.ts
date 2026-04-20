import { vaultService } from './vault'
import { normalizeNotePath } from '../utils/noteScope'
import { isPotentialRetrievalPath } from '../utils/retrievalScope'
import { detectFactQuestionIntent, shouldPreferFactAnswer } from '../utils/factHeuristics.ts'

export interface ExtractedFact {
  id: string
  notePath: string
  subject: string
  value: string
  statement: string
  kind: 'date' | 'attribute'
  confidence: number
  updatedAt: string
}

export interface FactAnswer {
  answer: string
  source: string
  similarity: number
  fact: ExtractedFact
  matchScore: number
  matchSummary: string
}

interface FactStore {
  version: 1
  facts: ExtractedFact[]
}

interface FactsService {
  updateFactsForNote: (notePath: string, content: string) => Promise<void>
  answerQuestionFromFacts: (question: string) => Promise<FactAnswer | null>
  clearFactsForNote: (notePath: string) => Promise<void>
  pruneMissingNotes: (validPaths: string[]) => Promise<number>
}

const FACTS_STORAGE_KEY = 'vn_fact_store_v1'
const FACTS_STORAGE_VERSION = 1 as const
const FACTS_FILE_PATH = '.vn-system/facts.json'

const QUESTION_STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'being', 'been',
  'what', 'when', 'where', 'who', 'whom', 'why', 'how', 'my', 'your',
  'on', 'in', 'at', 'to', 'for', 'of', 'and', 'or', 'do', 'does', 'did',
  'can', 'could', 'would', 'should', 'please', 'tell', 'me',
])

let inMemoryStore: FactStore | null = null
let loadPromise: Promise<FactStore> | null = null

function normalizePath(path: string): string {
  return path.replace(/^\/+/, '')
}

function nowIso(): string {
  return new Date().toISOString()
}

function buildEmptyStore(): FactStore {
  return { version: FACTS_STORAGE_VERSION, facts: [] }
}

function parseFactStore(raw: string): FactStore | null {
  try {
    const parsed = JSON.parse(raw) as Partial<FactStore>
    if (parsed.version !== FACTS_STORAGE_VERSION || !Array.isArray(parsed.facts)) {
      return null
    }
    return {
      version: FACTS_STORAGE_VERSION,
      facts: parsed.facts,
    }
  } catch {
    return null
  }
}

function loadLegacyFactStore(): FactStore | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(FACTS_STORAGE_KEY)
    if (!raw) return null
    return parseFactStore(raw)
  } catch {
    return null
  }
}

async function persistStore(store: FactStore): Promise<void> {
  inMemoryStore = store
  await vaultService.writeFile(FACTS_FILE_PATH, JSON.stringify(store))
}

async function ensureStoreLoaded(): Promise<FactStore> {
  if (inMemoryStore) return inMemoryStore
  if (loadPromise) return loadPromise

  loadPromise = (async () => {
    try {
      const raw = await vaultService.readFile(FACTS_FILE_PATH)
      const parsed = parseFactStore(raw)
      if (parsed) {
        inMemoryStore = parsed
        return parsed
      }
    } catch {
      // Missing/invalid file falls through to migration/default.
    }

    const legacy = loadLegacyFactStore()
    if (legacy) {
      try {
        await persistStore(legacy)
      } catch {
        inMemoryStore = legacy
      }
      return legacy
    }

    const empty = buildEmptyStore()
    inMemoryStore = empty
    return empty
  })()

  try {
    return await loadPromise
  } finally {
    loadPromise = null
  }
}

function tokenizeQuestion(question: string): string[] {
  return (question.toLowerCase().match(/[a-z0-9]{2,}/g) || [])
    .filter((token) => !QUESTION_STOP_WORDS.has(token))
}

function looksDateLike(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(trimmed)) return true
  if (/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(trimmed)) return true
  if (/\b(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|september|oct|october|nov|november|dec|december)\b/i.test(trimmed)) return true
  if (/\b(?:today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(trimmed)) return true
  return false
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function extractFactsFromSentence(sentence: string, notePath: string, index: number): ExtractedFact[] {
  const results: ExtractedFact[] = []
  const clean = compactWhitespace(sentence)
  if (clean.length < 6) return results

  const lower = clean.toLowerCase()
  const pushFact = (subject: string, value: string, statement: string, kind: 'date' | 'attribute', confidence: number) => {
    const normalizedSubject = compactWhitespace(subject).replace(/^my\s+/i, '').trim()
    const normalizedValue = compactWhitespace(value).trim()
    if (!normalizedSubject || !normalizedValue) return
    if (normalizedSubject.length < 2 || normalizedValue.length < 2) return
    results.push({
      id: `${normalizePath(notePath)}::${index}::${normalizedSubject.toLowerCase()}::${normalizedValue.toLowerCase()}`,
      notePath: normalizePath(notePath),
      subject: normalizedSubject,
      value: normalizedValue,
      statement: compactWhitespace(statement),
      kind,
      confidence,
      updatedAt: nowIso(),
    })
  }

  // High-confidence date/event patterns, e.g. "My wedding day is on June 12, 2027"
  const eventPattern = /\b(?:my\s+)?([a-z][a-z0-9\s]{1,60}?(?:day|date|birthday|anniversary|meeting|appointment|deadline|interview|wedding|event|call))\s+(?:is|was|will be)\s+(?:on\s+)?([^.;\n]{2,80})/gi
  let eventMatch: RegExpExecArray | null
  while ((eventMatch = eventPattern.exec(clean)) !== null) {
    const subject = eventMatch[1]
    const value = eventMatch[2]
    const kind: 'date' | 'attribute' = looksDateLike(value) ? 'date' : 'attribute'
    pushFact(subject, value, clean, kind, kind === 'date' ? 0.96 : 0.82)
  }

  // Generic personal attribute pattern, e.g. "My role is backend engineer"
  const personalPattern = /\bmy\s+([a-z][a-z0-9\s]{1,40})\s+(?:is|are|was|were)\s+([^.;\n]{2,90})/gi
  let personalMatch: RegExpExecArray | null
  while ((personalMatch = personalPattern.exec(clean)) !== null) {
    const subject = personalMatch[1]
    const value = personalMatch[2]
    const kind: 'date' | 'attribute' = looksDateLike(value) ? 'date' : 'attribute'
    pushFact(subject, value, clean, kind, kind === 'date' ? 0.88 : 0.76)
  }

  // Structured line format, e.g. "Wedding day: June 12, 2027"
  const colonPattern = /^([A-Za-z][A-Za-z0-9 /-]{1,50}):\s*([^.;\n]{2,90})$/i
  const colonMatch = clean.match(colonPattern)
  if (colonMatch) {
    const subject = colonMatch[1]
    const value = colonMatch[2]
    const kind: 'date' | 'attribute' = looksDateLike(value) ? 'date' : 'attribute'
    pushFact(subject, value, clean, kind, kind === 'date' ? 0.9 : 0.74)
  }

  if (lower.includes('wedding') && lower.includes('day') && results.length === 0) {
    // Lightweight fallback for rough text like "wedding day xxxx"
    const fallback = clean.match(/(wedding day)[^a-z0-9]{0,8}([^\n.;]{2,50})/i)
    if (fallback) {
      pushFact(fallback[1], fallback[2], clean, looksDateLike(fallback[2]) ? 'date' : 'attribute', 0.7)
    }
  }

  return results
}

function extractFacts(notePath: string, content: string): ExtractedFact[] {
  if (!content.trim()) return []
  const normalizedPath = normalizeNotePath(notePath)
  if (!isPotentialRetrievalPath(normalizedPath)) return []

  const source = content.slice(0, 60_000)
  const lines = source
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.?!])\s+/))
    .map((line) => compactWhitespace(line))
    .filter((line) => line.length >= 6)

  const collected: ExtractedFact[] = []
  lines.forEach((line, index) => {
    collected.push(...extractFactsFromSentence(line, normalizedPath, index))
  })

  // Deduplicate by subject/value pair and keep highest confidence.
  const deduped = new Map<string, ExtractedFact>()
  for (const fact of collected) {
    const key = `${fact.subject.toLowerCase()}::${fact.value.toLowerCase()}`
    const existing = deduped.get(key)
    if (!existing || fact.confidence > existing.confidence) {
      deduped.set(key, fact)
    }
  }

  return Array.from(deduped.values()).slice(0, 24)
}

function overlapScore(questionTokens: string[], haystack: string): number {
  if (questionTokens.length === 0) return 0
  const text = haystack.toLowerCase()
  let hits = 0
  questionTokens.forEach((token) => {
    if (text.includes(token)) hits += 1
  })
  return hits / questionTokens.length
}

function buildFactAnswer(question: string, fact: ExtractedFact, matchScore: number): FactAnswer {
  const lowerQ = question.toLowerCase()
  let answer = `Based on your note, ${fact.subject} is ${fact.value}.`
  if (lowerQ.startsWith('when') || lowerQ.includes(' when ')) {
    answer = `${fact.subject} is ${fact.value}.`
  } else if (lowerQ.startsWith('what') || lowerQ.includes(' what ')) {
    answer = `${fact.subject}: ${fact.value}.`
  }
  return {
    answer,
    source: fact.notePath,
    similarity: Math.min(0.99, Math.max(0.7, fact.confidence)),
    fact,
    matchScore,
    matchSummary: fact.kind === 'date'
      ? 'Answered directly from an extracted date-like fact.'
      : 'Answered directly from an extracted note attribute.',
  }
}

export const factsService: FactsService = {
  async updateFactsForNote(notePath: string, content: string): Promise<void> {
    const normalizedPath = normalizePath(notePath)
    const nextFacts = extractFacts(normalizedPath, content)
    const store = await ensureStoreLoaded()
    const retained = store.facts.filter((fact) => normalizePath(fact.notePath) !== normalizedPath)
    const nextStore: FactStore = {
      version: FACTS_STORAGE_VERSION,
      facts: [...retained, ...nextFacts],
    }
    await persistStore(nextStore)
  },

  async answerQuestionFromFacts(question: string): Promise<FactAnswer | null> {
    const q = question.trim()
    if (!q) return null

    const store = await ensureStoreLoaded()
    if (store.facts.length === 0) return null

    const questionTokens = tokenizeQuestion(q)
    const asksWhen = /\bwhen\b/i.test(q)
    const intent = detectFactQuestionIntent(q)

    let best: { fact: ExtractedFact; score: number } | null = null
    for (const fact of store.facts) {
      const subjectScore = overlapScore(questionTokens, fact.subject)
      const statementScore = overlapScore(questionTokens, fact.statement)
      const valueMentionScore = overlapScore(questionTokens, fact.value)
      let score = subjectScore * 0.65 + statementScore * 0.25 + valueMentionScore * 0.1
      if (asksWhen && fact.kind === 'date') score += 0.2
      if (asksWhen && looksDateLike(fact.value)) score += 0.12
      score += fact.confidence * 0.1
      if (!best || score > best.score) {
        best = { fact, score }
      }
    }

    if (!best || best.score < 0.24) return null
    if (!shouldPreferFactAnswer(q, best.score, best.fact.kind)) return null
    const answer = buildFactAnswer(q, best.fact, best.score)
    if (intent === 'direct' && best.fact.kind === 'date') {
      answer.matchSummary = 'Answered directly from a high-confidence extracted date fact.'
    }
    return answer
  },

  async clearFactsForNote(notePath: string): Promise<void> {
    const normalizedPath = normalizePath(notePath)
    const store = await ensureStoreLoaded()
    const nextStore: FactStore = {
      version: FACTS_STORAGE_VERSION,
      facts: store.facts.filter((fact) => normalizePath(fact.notePath) !== normalizedPath),
    }
    await persistStore(nextStore)
  },

  async pruneMissingNotes(validPaths: string[]): Promise<number> {
    const valid = new Set(validPaths.map((path) => normalizePath(path)))
    const store = await ensureStoreLoaded()
    const nextFacts = store.facts.filter((fact) => valid.has(normalizePath(fact.notePath)))
    const removed = store.facts.length - nextFacts.length
    if (removed <= 0) return 0
    await persistStore({
      version: FACTS_STORAGE_VERSION,
      facts: nextFacts,
    })
    return removed
  },
}
