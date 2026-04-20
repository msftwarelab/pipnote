import { vaultService, type TreeNode } from './vault'
import { indexComputeWorkerService } from './indexComputeWorker'
import { normalizeNotePath } from '../utils/noteScope'
import { filterRetrievalEligiblePaths, isPotentialRetrievalPath, isRetrievalEligibleAIReadable } from '../utils/retrievalScope'
import {
  cosineSimilarity,
  type EmbeddingCandidateEntry,
} from '../utils/indexCompute'

export type RelatedConfidence = 'high' | 'medium' | 'low'

export interface RelatedSignals {
  semantic: number
  keyword: number
  title: number
  entity: number
}

export interface RelatedNoteSuggestion {
  path: string
  score: number
  confidence: RelatedConfidence
  reason: string
  reasonTags: string[]
  signals: RelatedSignals
}

interface RelatedNoteRecord {
  path: string
  title: string
  titleTokens: string[]
  keywords: string[]
  entities: string[]
  updatedAt: string
}

interface RelatedIndexData {
  version: 1
  records: Record<string, RelatedNoteRecord>
  edges: Record<string, RelatedNoteSuggestion[]>
}

interface RelatedPairScore {
  score: number
  confidence: RelatedConfidence
  reason: string
  reasonTags: string[]
  signals: RelatedSignals
}

interface RelatedService {
  getRelatedNotes: (notePath: string) => Promise<RelatedNoteSuggestion[]>
  updateForNote: (notePath: string, content: string, options?: { forceRefresh?: boolean }) => Promise<RelatedNoteSuggestion[]>
  repairAgainstPaths: (validPaths: string[]) => Promise<{ removedRecords: number; removedEdges: number }>
}

const RELATED_INDEX_KEY = 'vn_related_index_v1'
const RELATED_INDEX_FILE_PATH = '.vn-system/related-index.json'
const RELATED_INDEX_VERSION = 1 as const
const MIN_RELATED_SCORE = 0.3
const MAX_SUGGESTIONS = 5
const MAX_EMBEDDING_CANDIDATES = 40
const MAX_FALLBACK_CANDIDATES = 36
const EMBEDDING_CANDIDATE_WORKER_THRESHOLD = 50
const CACHE_TTL_MS = 20_000
const INDEX_PERSIST_DEBOUNCE_MS = 1200

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you', 'are', 'was', 'were',
  'have', 'has', 'had', 'will', 'would', 'should', 'could', 'about', 'what', 'when', 'where', 'which',
  'their', 'there', 'then', 'than', 'them', 'they', 'our', 'out', 'not', 'can', 'just', 'like', 'also',
  'note', 'notes', 'todo', 'done', 'draft', 'untitled', 'file', 'files',
])

let cachedPaths: { expiresAt: number; paths: string[] } | null = null
let cachedEmbeddings: { expiresAt: number; map: Map<string, number[]> } | null = null
let inMemoryIndex: RelatedIndexData | null = null
let loadPromise: Promise<RelatedIndexData> | null = null
let lastPersistedSerialized: string | null = null
let pendingPersistSerialized: string | null = null
let persistTimer: number | null = null
let persistInFlight: Promise<void> | null = null

function nowIso(): string {
  return new Date().toISOString()
}

function isIndexableNote(path: string): boolean {
  return isPotentialRetrievalPath(path)
}

function flattenTreeFilePaths(nodes: TreeNode[]): string[] {
  const files: string[] = []
  for (const node of nodes) {
    if (node.type === 'file') {
      files.push(normalizeNotePath(node.path))
      continue
    }
    files.push(...flattenTreeFilePaths(node.children))
  }
  return files
}

function buildEmptyIndex(): RelatedIndexData {
  return { version: RELATED_INDEX_VERSION, records: {}, edges: {} }
}

function parseIndex(raw: string): RelatedIndexData | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RelatedIndexData>
    if (parsed.version !== RELATED_INDEX_VERSION) return null
    return {
      version: RELATED_INDEX_VERSION,
      records: parsed.records && typeof parsed.records === 'object' ? parsed.records : {},
      edges: parsed.edges && typeof parsed.edges === 'object' ? parsed.edges : {},
    }
  } catch {
    return null
  }
}

function loadLegacyIndex(): RelatedIndexData | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(RELATED_INDEX_KEY)
    if (!raw) return null
    return parseIndex(raw)
  } catch {
    return null
  }
}

async function persistIndexNow(index: RelatedIndexData): Promise<void> {
  const serialized = JSON.stringify(index)
  inMemoryIndex = index
  if (serialized === lastPersistedSerialized && !pendingPersistSerialized) return
  await vaultService.writeFile(RELATED_INDEX_FILE_PATH, serialized)
  lastPersistedSerialized = serialized
  pendingPersistSerialized = null
}

function flushPersistQueueSoon(): void {
  if (persistTimer) return
  persistTimer = window.setTimeout(() => {
    persistTimer = null
    const serialized = pendingPersistSerialized
    if (!serialized || serialized === lastPersistedSerialized) return
    persistInFlight = vaultService
      .writeFile(RELATED_INDEX_FILE_PATH, serialized)
      .then(() => {
        lastPersistedSerialized = serialized
        if (pendingPersistSerialized === serialized) {
          pendingPersistSerialized = null
        }
      })
      .catch((error) => {
        console.warn('⚠️ Failed to persist related index (debounced):', error)
      })
      .finally(() => {
        persistInFlight = null
        if (pendingPersistSerialized && pendingPersistSerialized !== lastPersistedSerialized) {
          flushPersistQueueSoon()
        }
      })
  }, INDEX_PERSIST_DEBOUNCE_MS)
}

function persistIndexDebounced(index: RelatedIndexData): void {
  const serialized = JSON.stringify(index)
  inMemoryIndex = index
  if (serialized === lastPersistedSerialized) return
  pendingPersistSerialized = serialized
  if (persistInFlight) return
  flushPersistQueueSoon()
}

async function ensureIndexLoaded(): Promise<RelatedIndexData> {
  if (inMemoryIndex) return inMemoryIndex
  if (loadPromise) return loadPromise

  loadPromise = (async () => {
    try {
      const raw = await vaultService.readFile(RELATED_INDEX_FILE_PATH)
      const parsed = parseIndex(raw)
      if (parsed) {
        inMemoryIndex = parsed
        lastPersistedSerialized = JSON.stringify(parsed)
        return parsed
      }
    } catch {
      // Missing/invalid file falls through to migration/default.
    }

    const legacy = loadLegacyIndex()
    if (legacy) {
      try {
        await persistIndexNow(legacy)
      } catch {
        inMemoryIndex = legacy
      }
      return legacy
    }

    const empty = buildEmptyIndex()
    inMemoryIndex = empty
    return empty
  })()

  try {
    return await loadPromise
  } finally {
    loadPromise = null
  }
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    .filter((token) => !STOP_WORDS.has(token))
}

function topKeywords(content: string, limit = 22): string[] {
  const tokens = tokenize(content.slice(0, 22_000))
  const freq = new Map<string, number>()
  tokens.forEach((token, index) => {
    const positionalBonus = index < 60 ? 0.7 : 0
    freq.set(token, (freq.get(token) || 0) + 1 + positionalBonus)
  })
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([token]) => token)
}

function extractEntities(content: string, limit = 14): string[] {
  const sample = content.slice(0, 30_000)
  const set = new Set<string>()

  const addMatches = (regex: RegExp, transform: (value: string) => string = (value) => value.toLowerCase()) => {
    const matches = sample.match(regex) || []
    for (const match of matches) {
      const normalized = transform(match.trim())
      if (!normalized || normalized.length < 2) continue
      set.add(normalized)
      if (set.size >= limit) break
    }
  }

  addMatches(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g)
  if (set.size < limit) addMatches(/\b[A-Z]{2,}\b/g)
  if (set.size < limit) {
    addMatches(
      /\b(?:Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|September|Oct|October|Nov|November|Dec|December)\s+\d{1,2}(?:,\s*\d{4})?\b/g,
    )
  }
  if (set.size < limit) addMatches(/\b\d{4}-\d{2}-\d{2}\b/g)

  return Array.from(set).slice(0, limit)
}

function basenameWithoutExt(path: string): string {
  return normalizeNotePath(path).split('/').pop()?.replace(/\.md$/i, '') || ''
}

function buildRecord(path: string, content: string): RelatedNoteRecord {
  const normalizedPath = normalizeNotePath(path)
  const title = basenameWithoutExt(normalizedPath)
  return {
    path: normalizedPath,
    title,
    titleTokens: tokenize(title),
    keywords: topKeywords(content),
    entities: extractEntities(content),
    updatedAt: nowIso(),
  }
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const aSet = new Set(a)
  const bSet = new Set(b)
  let intersection = 0
  aSet.forEach((item) => {
    if (bSet.has(item)) intersection += 1
  })
  const union = aSet.size + bSet.size - intersection
  if (union === 0) return 0
  return intersection / union
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function confidenceForScore(score: number): RelatedConfidence {
  if (score >= 0.74) return 'high'
  if (score >= 0.54) return 'medium'
  return 'low'
}

function getParent(path: string): string {
  const parts = normalizeNotePath(path).split('/')
  return parts.slice(0, -1).join('/')
}

function getTopLevel(path: string): string {
  return normalizeNotePath(path).split('/')[0] || ''
}

function getSecondLevel(path: string): string {
  return normalizeNotePath(path).split('/')[1] || ''
}

function sharedTokens(a: string[], b: string[], limit = 3): string[] {
  const bSet = new Set(b)
  const matches = a.filter((token) => bSet.has(token))
  return Array.from(new Set(matches)).slice(0, limit)
}

function buildReasonTags(
  signals: RelatedSignals,
  sameFolder: boolean,
  sameTopLevel: boolean,
  sameSecondLevel: boolean,
  sharedKeywordTokens: string[],
  sharedEntityTokens: string[],
): string[] {
  const reasons: string[] = []

  if (signals.semantic >= 0.78) reasons.push('same topic')
  else if (signals.semantic >= 0.58) reasons.push('similar topic')

  if (sharedEntityTokens.length > 0) reasons.push('shared person/topic')
  else if (signals.entity >= 0.24) reasons.push('shared references')

  if (sharedKeywordTokens.length > 0) reasons.push('shared keywords')
  else if (signals.keyword >= 0.28) reasons.push('keyword overlap')

  if (signals.title >= 0.34) reasons.push('related title')
  if (sameFolder) reasons.push('same folder')
  else if (sameSecondLevel) reasons.push('same sub-area')
  else if (sameTopLevel) reasons.push('same area')

  return reasons.slice(0, 3)
}

function buildReason(
  tags: string[],
  sharedKeywordTokens: string[],
  sharedEntityTokens: string[],
): string {
  if (sharedEntityTokens.length > 0) {
    return `Shared people/topics: ${sharedEntityTokens.join(', ')}`
  }
  if (sharedKeywordTokens.length > 0) {
    return `Shared keywords: ${sharedKeywordTokens.join(', ')}`
  }
  if (tags.includes('same folder')) return 'Same folder context'
  if (tags.includes('same sub-area')) return 'Same sub-area'
  if (tags.includes('same topic')) return 'Very similar topic'
  if (tags.includes('similar topic')) return 'Similar topic'
  if (tags.includes('shared references')) return 'Shared named references'
  if (tags.includes('keyword overlap')) return 'Strong keyword overlap'
  if (tags.includes('related title')) return 'Related title/topic'
  if (tags.includes('same area')) return 'Same area'
  return 'Related context detected'
}

function scorePair(
  source: RelatedNoteRecord,
  target: RelatedNoteRecord,
  sourceEmbedding: number[] | undefined,
  targetEmbedding: number[] | undefined,
): RelatedPairScore {
  const semanticRaw =
    sourceEmbedding && targetEmbedding
      ? cosineSimilarity(sourceEmbedding, targetEmbedding)
      : 0
  const semantic = clamp01(Math.max(0, semanticRaw))
  const keyword = clamp01(jaccard(source.keywords, target.keywords))
  const title = clamp01(jaccard(source.titleTokens, target.titleTokens))
  const entity = clamp01(jaccard(source.entities, target.entities))
  const sameFolder = getParent(source.path) !== '' && getParent(source.path) === getParent(target.path)
  const sameTopLevel = getTopLevel(source.path) !== '' && getTopLevel(source.path) === getTopLevel(target.path)
  const sameSecondLevel = sameTopLevel && getSecondLevel(source.path) !== '' && getSecondLevel(source.path) === getSecondLevel(target.path)

  // Bias toward meaningfully related notes instead of vague overlap.
  let score = semantic * 0.56 + keyword * 0.16 + title * 0.08 + entity * 0.2
  if (sameFolder) score += 0.09
  else if (sameSecondLevel) score += 0.05
  else if (sameTopLevel) score += 0.02
  score = clamp01(score)

  const hasStrongSemantic = semantic >= 0.48
  const hasStrongEntity = entity >= 0.22
  const hasStrongKeyword = keyword >= 0.24
  const hasStrongTitle = title >= 0.38
  const folderBackedMatch = sameFolder && (semantic >= 0.2 || entity >= 0.14 || keyword >= 0.18)

  if (!hasStrongSemantic && !hasStrongEntity && !hasStrongKeyword && !hasStrongTitle && !folderBackedMatch) {
    score = 0
  }

  if (semantic < 0.12 && keyword < 0.12 && title < 0.18 && entity < 0.12) {
    score = 0
  }

  if (sameTopLevel && !sameFolder && semantic < 0.22 && entity < 0.18 && keyword < 0.2) {
    score = Math.min(score, 0.26)
  }

  const signals: RelatedSignals = { semantic, keyword, title, entity }
  const reasonTags = buildReasonTags(
    signals,
    sameFolder,
    sameTopLevel,
    sameSecondLevel,
    sharedTokens(source.keywords, target.keywords),
    sharedTokens(source.entities, target.entities),
  )
  const reason = buildReason(
    reasonTags,
    sharedTokens(source.keywords, target.keywords),
    sharedTokens(source.entities, target.entities),
  )

  return {
    score,
    confidence: confidenceForScore(score),
    reason,
    reasonTags,
    signals,
  }
}

function normalizeSuggestions(suggestions: RelatedNoteSuggestion[]): RelatedNoteSuggestion[] {
  const deduped = new Map<string, RelatedNoteSuggestion>()
  for (const item of suggestions) {
    const path = normalizeNotePath(item.path)
    const existing = deduped.get(path)
    if (!existing || item.score > existing.score) {
      deduped.set(path, { ...item, path, reasonTags: Array.isArray(item.reasonTags) ? item.reasonTags.slice(0, 3) : [] })
    }
  }
  return Array.from(deduped.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.path.localeCompare(b.path)
    })
    .slice(0, MAX_SUGGESTIONS)
}

async function getAllNotePaths(forceRefresh = false): Promise<string[]> {
  if (!forceRefresh && cachedPaths && cachedPaths.expiresAt > Date.now()) {
    return cachedPaths.paths
  }

  const tree = await vaultService.getVaultTree()
  const paths = await filterRetrievalEligiblePaths(flattenTreeFilePaths(tree).filter((path) => isIndexableNote(path)), (path) => vaultService.readFileForAI(path), 3)
  cachedPaths = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    paths,
  }
  return paths
}

async function getEmbeddingMap(forceRefresh = false): Promise<Map<string, number[]>> {
  if (!forceRefresh && cachedEmbeddings && cachedEmbeddings.expiresAt > Date.now()) {
    return cachedEmbeddings.map
  }

  const embeddings = await vaultService.readAllEmbeddings().catch(() => [])
  const map = new Map<string, number[]>()

  for (const embedding of embeddings) {
    const path = normalizeNotePath(embedding.path)
    if (!isIndexableNote(path)) continue
    if (!Array.isArray(embedding.embedding) || embedding.embedding.length === 0) continue
    map.set(path, embedding.embedding)
  }

  cachedEmbeddings = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    map,
  }
  return map
}

async function collectEmbeddingCandidates(
  notePath: string,
  embeddingMap: Map<string, number[]>,
): Promise<string[]> {
  const source = embeddingMap.get(notePath)
  if (!source) return []

  const entries: EmbeddingCandidateEntry[] = Array.from(embeddingMap.entries()).map(([path, embedding]) => ({
    path,
    embedding,
  }))

  const ranked = await indexComputeWorkerService.rankEmbeddingCandidates(
    {
      sourcePath: notePath,
      sourceEmbedding: source,
      entries,
      minSimilarity: 0.12,
      limit: MAX_EMBEDDING_CANDIDATES,
    },
    { forceInline: entries.length < EMBEDDING_CANDIDATE_WORKER_THRESHOLD },
  )

  return ranked.map((item) => item.path)
}

function pruneIndex(index: RelatedIndexData, validPaths: Set<string>): void {
  Object.keys(index.records).forEach((path) => {
    if (!validPaths.has(path)) delete index.records[path]
  })

  Object.keys(index.edges).forEach((sourcePath) => {
    if (!validPaths.has(sourcePath)) {
      delete index.edges[sourcePath]
      return
    }
    const cleaned = index.edges[sourcePath]
      .filter((suggestion) => validPaths.has(normalizeNotePath(suggestion.path)))
      .map((suggestion) => ({ ...suggestion, path: normalizeNotePath(suggestion.path) }))
    index.edges[sourcePath] = normalizeSuggestions(cleaned)
  })
}

export const relatedNotesService: RelatedService = {
  async getRelatedNotes(notePath: string): Promise<RelatedNoteSuggestion[]> {
    const normalizedPath = normalizeNotePath(notePath)
    if (!isIndexableNote(normalizedPath)) return []

    const index = await ensureIndexLoaded()
    if (Object.prototype.hasOwnProperty.call(index.edges, normalizedPath)) {
      const cached = index.edges[normalizedPath] || []
      return normalizeSuggestions(cached)
    }
    return []
  },

  async updateForNote(notePath: string, content: string, options?: { forceRefresh?: boolean }): Promise<RelatedNoteSuggestion[]> {
    const normalizedPath = normalizeNotePath(notePath)
    if (!isIndexableNote(normalizedPath)) return []

    const forceRefresh = options?.forceRefresh ?? false
    const [allPaths, embeddingMap] = await Promise.all([
      getAllNotePaths(forceRefresh),
      getEmbeddingMap(forceRefresh),
    ])

    const allPathSet = new Set(allPaths)
    allPathSet.add(normalizedPath)

    const index = await ensureIndexLoaded()
    pruneIndex(index, allPathSet)

    index.records[normalizedPath] = buildRecord(normalizedPath, content)
    const sourceRecord = index.records[normalizedPath]
    const sourceEmbedding = embeddingMap.get(normalizedPath)

    const candidateSet = new Set<string>()
    const existingForSource = index.edges[normalizedPath] || []
    existingForSource.forEach((item) => candidateSet.add(normalizeNotePath(item.path)))
    const embeddingCandidates = await collectEmbeddingCandidates(normalizedPath, embeddingMap)
    embeddingCandidates.forEach((path) => candidateSet.add(path))

    const sourceParent = getParent(normalizedPath)
    if (sourceParent) {
      allPaths
        .filter((path) => path !== normalizedPath && getParent(path) === sourceParent)
        .slice(0, MAX_FALLBACK_CANDIDATES)
        .forEach((path) => candidateSet.add(path))
    }

    if (candidateSet.size < 8) {
      allPaths
        .filter((path) => path !== normalizedPath)
        .slice(0, MAX_FALLBACK_CANDIDATES)
        .forEach((path) => candidateSet.add(path))
    }

    const pairScoresByPath = new Map<string, RelatedPairScore>()
    const sourceSuggestions: RelatedNoteSuggestion[] = []

    for (const candidatePath of candidateSet) {
      if (candidatePath === normalizedPath || !allPathSet.has(candidatePath)) continue

      let candidateRecord = index.records[candidatePath]
      if (!candidateRecord) {
        try {
          const readable = await vaultService.readFileForAI(candidatePath)
          if (!isRetrievalEligibleAIReadable(candidatePath, readable)) {
            continue
          }
          const candidateContent = readable.content
          candidateRecord = buildRecord(candidatePath, candidateContent)
          index.records[candidatePath] = candidateRecord
        } catch {
          continue
        }
      }

      const pair = scorePair(sourceRecord, candidateRecord, sourceEmbedding, embeddingMap.get(candidatePath))
      pairScoresByPath.set(candidatePath, pair)
      if (pair.score < MIN_RELATED_SCORE) continue

      sourceSuggestions.push({
        path: candidatePath,
        score: pair.score,
        confidence: pair.confidence,
        reason: pair.reason,
        reasonTags: pair.reasonTags,
        signals: pair.signals,
      })
    }

    index.edges[normalizedPath] = normalizeSuggestions(sourceSuggestions)

    // Incremental reverse update: only adjust candidate notes affected by this save.
    for (const candidatePath of candidateSet) {
      if (candidatePath === normalizedPath || !allPathSet.has(candidatePath)) continue
      const existing = (index.edges[candidatePath] || []).filter((item) => normalizeNotePath(item.path) !== normalizedPath)
      const pair = pairScoresByPath.get(candidatePath)
      if (pair && pair.score >= MIN_RELATED_SCORE) {
        existing.push({
          path: normalizedPath,
          score: pair.score,
          confidence: pair.confidence,
          reason: pair.reason,
          reasonTags: pair.reasonTags,
          signals: pair.signals,
        })
      }
      index.edges[candidatePath] = normalizeSuggestions(existing)
    }

    persistIndexDebounced(index)
    return index.edges[normalizedPath] || []
  },

  async repairAgainstPaths(validPaths: string[]): Promise<{ removedRecords: number; removedEdges: number }> {
    const index = await ensureIndexLoaded()
    const beforeRecords = Object.keys(index.records).length
    const beforeEdges = Object.values(index.edges).reduce((total, items) => total + items.length, 0)
    pruneIndex(index, new Set(validPaths.map((path) => normalizeNotePath(path))))
    const afterRecords = Object.keys(index.records).length
    const afterEdges = Object.values(index.edges).reduce((total, items) => total + items.length, 0)
    const removedRecords = Math.max(0, beforeRecords - afterRecords)
    const removedEdges = Math.max(0, beforeEdges - afterEdges)
    if (removedRecords > 0 || removedEdges > 0) {
      await persistIndexNow(index)
    }
    return { removedRecords, removedEdges }
  },
}
