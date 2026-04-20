import { vaultService, type EmbeddingWithPath, type TreeNode } from './vault'
import { localAiService, type SearchResult } from './localAi'
import { relatedNotesService } from './relatedNotes'
import { factsService } from './facts'
import { embeddingQueueService } from './embeddingQueue'
import { indexComputeWorkerService } from './indexComputeWorker'
import { isSmallTalkQuestion, keywordScoreToSimilarity, mergeHybridSearchResults } from '../utils/qaHeuristics'
import { buildRetrievalExplanation } from '../utils/retrievalExplainability.ts'
import { modelMatchesRequested } from '../utils/embeddingMaintenance'
import { recordPerfMetric, startPerfTimer } from '../utils/perfMetrics'
import { computeContentHash } from '../utils/contentHash'
import { normalizeNotePath } from '../utils/noteScope'
import { generateAdaptiveEmbedding } from '../utils/adaptiveEmbedding'
import { type SemanticRankEntry } from '../utils/indexCompute'
import type { EmbeddingChunkData } from '../types/embedding'
import { filterRetrievalEligiblePaths, isPotentialRetrievalPath, isRetrievalEligibleAIReadable } from '../utils/retrievalScope'
import { rerankResultsForQueryIntent } from '../utils/retrievalRanking'
import { determineQAGroundingPlan } from '../utils/qaGrounding.ts'

export interface EmbeddingModelStatus {
  totalEmbeddings: number
  upToDateCount: number
  staleCount: number
  selectedEmbeddingModel: string
  observedModels: string[]
  isStale: boolean
}

export interface IndexHealthStatus {
  eligibleCount: number
  indexedCount: number
  staleCount: number
  failedCount: number
}

export type IndexHealthIssueType = 'missing' | 'stale' | 'failed'

export interface IndexHealthIssue {
  path: string
  type: IndexHealthIssueType
  reason: string
  detail?: string
  lastAttemptAt?: string
}

export interface IndexHealthDetails extends IndexHealthStatus {
  issues: IndexHealthIssue[]
}

export interface StaleEmbeddingRegenerationResult {
  totalCandidates: number
  successCount: number
  processedCount: number
  cancelled: boolean
}

interface StaleEmbeddingRegenerationOptions {
  shouldCancel?: () => boolean
}

export interface SearchService {
  findRelevantNotes: (query: string, topK?: number) => Promise<SearchResult[]>
  askQuestion: (question: string) => Promise<QAAnswerResult>
  askQuestionMultiple: (question: string) => Promise<QAAnswerResult[]>
  regenerateAllEmbeddings: (onProgress?: (current: number, total: number) => void) => Promise<number>
  regenerateStaleEmbeddings: (
    onProgress?: (current: number, total: number) => void,
    options?: StaleEmbeddingRegenerationOptions,
  ) => Promise<StaleEmbeddingRegenerationResult>
  getEmbeddingModelStatus: () => Promise<EmbeddingModelStatus>
  getIndexHealthStatus: () => Promise<IndexHealthStatus>
  getIndexHealthDetails: () => Promise<IndexHealthDetails>
  retryFailedEmbeddings: (onProgress?: (current: number, total: number) => void) => Promise<number>
  rebuildStaleAndMissingEmbeddings: (onProgress?: (current: number, total: number) => void) => Promise<number>
}

export type QASourceType = 'note' | 'fact' | 'general'
export type QAAnswerMode = 'grounded' | 'mixed' | 'general'
export type QAConfidence = 'high' | 'medium' | 'low'

export interface QAAnswerResult {
  answer: string
  source: string
  similarity: number
  sourceType: QASourceType
  sourceSnippet?: string
  sourceContextKind?: 'ocr-image' | 'standard'
  retrievalSummary?: string
  retrievalTags?: string[]
  groundingSummary?: string
  answerMode: QAAnswerMode
  confidence: QAConfidence
  provenanceLabel: string
}

const INDEX_HEALTH_CACHE_TTL_MS = 10_000
let cachedIndexHealth:
  | {
      expiresAt: number
      details: IndexHealthDetails
    }
  | null = null
let indexHealthInFlight: Promise<IndexHealthDetails> | null = null

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractQuestionTerms(question: string): string[] {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'when', 'where', 'who', 'why',
    'how', 'your', 'my', 'are', 'was', 'were', 'is', 'can', 'could', 'would', 'should', 'please',
    'about', 'note', 'notes', 'tell', 'me', 'a', 'an', 'to', 'in', 'on', 'of',
  ])
  return Array.from(new Set((question.toLowerCase().match(/[a-z0-9]{2,}/g) || [])))
    .filter((term) => !stop.has(term))
    .slice(0, 10)
}

function extractPathOverlapTerms(path: string, questionTerms: string[]): string[] {
  if (questionTerms.length === 0) return []
  const pathTerms = new Set((path.toLowerCase().match(/[a-z0-9]{2,}/g) || []))
  return questionTerms.filter((term) => pathTerms.has(term)).slice(0, 3)
}

function extractBestSnippet(content: string, question: string, maxLength = 220): string {
  const terms = extractQuestionTerms(question)
  const lines = content
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)

  if (lines.length === 0) return ''

  let bestLine = lines[0]
  let bestScore = -1
  for (const line of lines.slice(0, 360)) {
    const lower = line.toLowerCase()
    let score = 0
    terms.forEach((term) => {
      if (lower.includes(term)) score += term.length >= 5 ? 2 : 1
    })
    if (terms.length === 0 && bestScore < 0) {
      score = 1
    }
    if (score > bestScore) {
      bestScore = score
      bestLine = line
    }
  }

  if (bestLine.length <= maxLength) return bestLine
  const termsRegex = terms.length > 0 ? new RegExp(terms.map(escapeRegExp).join('|'), 'i') : null
  if (termsRegex) {
    const match = bestLine.match(termsRegex)
    if (match && typeof match.index === 'number') {
      const start = Math.max(0, match.index - 70)
      const end = Math.min(bestLine.length, start + maxLength)
      const sliced = bestLine.slice(start, end)
      return `${start > 0 ? '…' : ''}${sliced}${end < bestLine.length ? '…' : ''}`
    }
  }
  return `${bestLine.slice(0, maxLength - 1).trimEnd()}…`
}

async function buildGeneralFallback(question: string): Promise<QAAnswerResult> {
  try {
    const fallback = await localAiService.answerGeneralQuestion(question)
    return {
      answer: fallback,
      source: 'N/A',
      similarity: 0,
      sourceType: 'general',
      sourceSnippet: 'No direct note match found for this question.',
      answerMode: 'general',
      confidence: 'low',
      provenanceLabel: 'General model answer',
    }
  } catch (error) {
    console.warn('⚠️ General fallback failed:', error)
    return {
      answer: 'I could not access local notes or the selected local AI provider right now. Please verify it is running, then try again.',
      source: 'N/A',
      similarity: 0,
      sourceType: 'general',
      sourceSnippet: 'Fallback response (model unavailable).',
      answerMode: 'general',
      confidence: 'low',
      provenanceLabel: 'General model answer',
    }
  }
}

interface LatestEmbeddingEntry {
  embedding: number[]
  model: string
  createdAt: string
  contentHash: string
  chunks: EmbeddingChunkData[]
}

const ORPHAN_EMBEDDING_PRUNE_CONCURRENCY = 2
const SEMANTIC_RANK_WORKER_THRESHOLD = 40
const EMBEDDING_FAILURES_STORAGE_KEY = 'vn_embedding_failures_v1'

interface EmbeddingFailureState {
  failures: Record<string, { message: string; at: string }>
}

interface FailureMeta {
  message: string
  at?: string
}

function readEmbeddingFailureState(): EmbeddingFailureState {
  if (typeof window === 'undefined') return { failures: {} }
  try {
    const raw = window.localStorage.getItem(EMBEDDING_FAILURES_STORAGE_KEY)
    if (!raw) return { failures: {} }
    const parsed = JSON.parse(raw) as EmbeddingFailureState
    return parsed && parsed.failures && typeof parsed.failures === 'object'
      ? { failures: parsed.failures }
      : { failures: {} }
  } catch {
    return { failures: {} }
  }
}

function writeEmbeddingFailureState(state: EmbeddingFailureState): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(EMBEDDING_FAILURES_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Best-effort only.
  }
}

function recordEmbeddingFailure(path: string, message: string): void {
  const state = readEmbeddingFailureState()
  state.failures[normalizeNotePath(path)] = {
    message,
    at: new Date().toISOString(),
  }
  writeEmbeddingFailureState(state)
}

function clearEmbeddingFailure(path: string): void {
  const normalized = normalizeNotePath(path)
  const state = readEmbeddingFailureState()
  if (!state.failures[normalized]) return
  delete state.failures[normalized]
  writeEmbeddingFailureState(state)
}

function sortHealthIssues(issues: IndexHealthIssue[]): IndexHealthIssue[] {
  const rank: Record<IndexHealthIssueType, number> = {
    failed: 0,
    missing: 1,
    stale: 2,
  }
  return [...issues].sort((a, b) => {
    const rankDiff = rank[a.type] - rank[b.type]
    if (rankDiff !== 0) return rankDiff
    return a.path.localeCompare(b.path)
  })
}

function collectFailureMeta(): Map<string, FailureMeta> {
  const state = readEmbeddingFailureState()
  const meta = new Map<string, FailureMeta>()
  Object.entries(state.failures).forEach(([path, failure]) => {
    meta.set(normalizeNotePath(path), {
      message: failure.message,
      at: failure.at,
    })
  })

  embeddingQueueService.getStatus().recentFailures.forEach((entry) => {
    const normalized = normalizeNotePath(entry.path)
    if (!meta.has(normalized)) {
      meta.set(normalized, {
        message: entry.error,
        at: new Date(entry.at).toISOString(),
      })
    }
  })
  return meta
}

async function buildIndexHealthDetailsInternal(): Promise<IndexHealthDetails> {
  const selectedEmbeddingModel = localAiService.getSettings().embeddingModel
  const [tree, allEmbeddings] = await Promise.all([
    vaultService.getVaultTree(),
    vaultService.readAllEmbeddings(),
  ])

  const eligiblePaths = await collectAiReadableVaultPaths(tree)
  const latestByPath = buildLatestEmbeddingMap(allEmbeddings)
  const failureMeta = collectFailureMeta()
  const issues: IndexHealthIssue[] = []

  let indexedCount = 0
  let staleCount = 0
  let failedCount = 0

  for (const path of eligiblePaths) {
    const entry = latestByPath.get(path)
    const failure = failureMeta.get(path)

    if (entry) {
      indexedCount += 1
      if (!modelMatchesRequested(selectedEmbeddingModel, entry.model)) {
        staleCount += 1
        issues.push({
          path,
          type: 'stale',
          reason: `Indexed with ${entry.model || 'an older model'} instead of ${selectedEmbeddingModel}`,
          detail: entry.model ? `Current embedding model on file: ${entry.model}` : 'Existing embedding has no recorded model.',
        })
      }
    } else {
      issues.push({
        path,
        type: 'missing',
        reason: 'No embedding found for this eligible note',
        detail: 'Generate or rebuild embeddings so Q&A can use this note.',
      })
    }

    if (failure) {
      failedCount += 1
      issues.push({
        path,
        type: 'failed',
        reason: 'Last embedding attempt failed',
        detail: failure.message,
        lastAttemptAt: failure.at,
      })
    }
  }

  return {
    eligibleCount: eligiblePaths.length,
    indexedCount,
    staleCount,
    failedCount,
    issues: sortHealthIssues(issues),
  }
}

async function getCachedIndexHealthDetails(forceRefresh = false): Promise<IndexHealthDetails> {
  const now = Date.now()
  if (!forceRefresh && cachedIndexHealth && cachedIndexHealth.expiresAt > now) {
    return cachedIndexHealth.details
  }

  if (!forceRefresh && indexHealthInFlight) {
    return indexHealthInFlight
  }

  indexHealthInFlight = buildIndexHealthDetailsInternal()
    .then((details) => {
      cachedIndexHealth = {
        details,
        expiresAt: Date.now() + INDEX_HEALTH_CACHE_TTL_MS,
      }
      return details
    })
    .finally(() => {
      indexHealthInFlight = null
    })

  return indexHealthInFlight
}

function invalidateIndexHealthCache(): void {
  cachedIndexHealth = null
  indexHealthInFlight = null
}

async function regenerateSpecificEmbeddings(
  candidatePaths: string[],
  onProgress?: (current: number, total: number) => void,
): Promise<number> {
  await requireOllamaFor('Repair embeddings')
  const maxConcurrency = embeddingQueueService.getConcurrency()
  const uniquePaths = Array.from(
    new Set(
      candidatePaths
        .map((path) => normalizeNotePath(path))
        .filter((path) => isPotentialRetrievalPath(path)),
    ),
  )

  if (uniquePaths.length === 0) {
    onProgress?.(0, 0)
    return 0
  }

  let successCount = 0
  let processedCount = 0

  await runWithConcurrency(uniquePaths, maxConcurrency, async (filePath) => {
    try {
      const content = await readAIContent(filePath)
      if (!content.trim()) {
        recordEmbeddingFailure(filePath, 'Note is empty, so no embedding was generated.')
        return
      }
      const embedding = await generateAdaptiveEmbedding(content, (chunk) => localAiService.generateEmbedding(chunk))
      embedding.content_hash = computeContentHash(content).toLowerCase()
      await vaultService.writeEmbedding(filePath, embedding)
      clearEmbeddingFailure(filePath)
      successCount += 1
    } catch (error) {
      recordEmbeddingFailure(filePath, error instanceof Error ? error.message : 'Embedding failed')
    } finally {
      processedCount += 1
      onProgress?.(processedCount, uniquePaths.length)
    }
  })

  return successCount
}

function classifyNoteAnswer(similarity: number): { answerMode: QAAnswerMode; confidence: QAConfidence; provenanceLabel: string } {
  if (similarity >= 0.62) {
    return {
      answerMode: 'grounded',
      confidence: 'high',
      provenanceLabel: 'Grounded in your notes',
    }
  }
  if (similarity >= 0.38) {
    return {
      answerMode: 'mixed',
      confidence: 'medium',
      provenanceLabel: 'Partially grounded in your notes',
    }
  }
  return {
    answerMode: 'mixed',
    confidence: 'low',
    provenanceLabel: 'Weak note match',
  }
}

function softenAnswerForTrust(answer: string, trust: { answerMode: QAAnswerMode; confidence: QAConfidence }): string {
  if (trust.answerMode === 'general') return answer
  if (trust.confidence === 'high') return answer
  if (trust.confidence === 'medium') {
    return `Best matching note-based answer: ${answer}`
  }
  return `Possible note-based answer from a weak match: ${answer}`
}

function isImageSourcePath(path: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|bmp|svg|heic)$/i.test(path)
}

async function requireOllamaFor(operation: string): Promise<void> {
  const healthy = await localAiService.checkHealth()
  if (healthy) return
  const reason = localAiService.getHealthError() || `Cannot complete "${operation}" because the selected local AI provider is unavailable.`
  throw new Error(`${reason} Start your selected local AI provider and verify selected models in Settings.`)
}

function flattenTreePaths(nodes: TreeNode[]): string[] {
  const files: string[] = []
  for (const node of nodes) {
    if (node.type === 'file') {
      files.push(node.path)
    } else if (node.type === 'folder') {
      files.push(...flattenTreePaths(node.children))
    }
  }
  return files
}

async function readAIContent(path: string): Promise<string> {
  const readable = await vaultService.readFileForAI(path)
  if (!isRetrievalEligibleAIReadable(path, readable)) {
    throw new Error('OCR text was not strong enough for retrieval or embedding.')
  }
  return readable.content
}

async function collectAiReadableVaultPaths(tree: TreeNode[]): Promise<string[]> {
  return filterRetrievalEligiblePaths(flattenTreePaths(tree), (path) => vaultService.readFileForAI(path), 3)
}

async function runWithConcurrency<T>(
  items: T[],
  maxConcurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return

  const queue = items.map((item, index) => ({ item, index }))
  const concurrency = Math.max(1, Math.min(maxConcurrency, items.length))

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const next = queue.shift()
        if (!next) break
        await worker(next.item, next.index)
      }
    }),
  )
}

function buildLatestEmbeddingMap(allEmbeddings: EmbeddingWithPath[]): Map<string, LatestEmbeddingEntry> {
  const map = new Map<string, LatestEmbeddingEntry>()
  for (const item of allEmbeddings) {
    const normalizedPath = normalizeNotePath(item.path)
    if (!isPotentialRetrievalPath(normalizedPath)) continue
    if (!Array.isArray(item.embedding) || item.embedding.length === 0) continue

    const current = map.get(normalizedPath)
    const nextCreatedAt = item.created_at || ''
    if (!current || nextCreatedAt > current.createdAt) {
      map.set(normalizedPath, {
        embedding: item.embedding,
        model: item.model || '',
        createdAt: nextCreatedAt,
        contentHash: (item.content_hash || '').trim().toLowerCase(),
        chunks: Array.isArray(item.chunks) ? item.chunks : [],
      })
    }
  }
  return map
}

async function pruneOrphanEmbeddingPaths(notePaths: Set<string>, embeddingPaths: string[]): Promise<number> {
  const normalizedEmbeddingPaths = Array.from(
    new Set(
      embeddingPaths
        .map((path) => normalizeNotePath(path))
        .filter((path) => path.length > 0),
    ),
  )
  const orphanPaths = normalizedEmbeddingPaths.filter((path) => !notePaths.has(path))
  if (orphanPaths.length === 0) return 0

  let pruned = 0
  await runWithConcurrency(orphanPaths, ORPHAN_EMBEDDING_PRUNE_CONCURRENCY, async (path) => {
    try {
      const deleted = await vaultService.deleteEmbedding(path)
      if (deleted) pruned += 1
    } catch (error) {
      console.warn(`⚠️ Failed to prune orphan embedding for ${path}:`, error)
    }
  })

  if (pruned > 0) {
    console.log(`🧹 Pruned ${pruned}/${orphanPaths.length} orphan embeddings`)
  }
  return pruned
}

async function buildSemanticResultsFromEmbeddingMap(
  queryEmbeddingVector: number[],
  latestEmbeddingByPath: Map<string, LatestEmbeddingEntry>,
  topK: number,
): Promise<SearchResult[]> {
  const entries: SemanticRankEntry[] = []
  for (const [path, entry] of latestEmbeddingByPath.entries()) {
    entries.push({
      path,
      embedding: entry.embedding,
      chunks: entry.chunks,
    })
  }

  const ranked = await indexComputeWorkerService.rankSemantic(
    {
      queryEmbedding: queryEmbeddingVector,
      entries,
      topK: Math.max(1, topK),
    },
    { forceInline: entries.length < SEMANTIC_RANK_WORKER_THRESHOLD },
  )

  return ranked.map((item) => {
    const retrieval = buildRetrievalExplanation({ semanticSimilarity: item.similarity })
    return {
      notePath: item.path,
      similarity: item.similarity,
      content: item.content,
      retrievalSummary: retrieval?.summary,
      retrievalTags: retrieval?.tags,
    }
  })
}

async function findRelevantNotesByKeyword(query: string, topK: number): Promise<SearchResult[]> {
  const hits = await vaultService.searchNotes(query, Math.max(topK * 4, 12))
  if (hits.length === 0) return []

  const maxScore = hits.reduce((best, hit) => Math.max(best, hit.score), 0)
  const questionTerms = extractQuestionTerms(query)
  const byPath = new Map<string, SearchResult>()

  hits.forEach((hit, index) => {
    const normalizedPath = normalizeNotePath(hit.path)
    if (!isPotentialRetrievalPath(normalizedPath)) return
    const similarity = keywordScoreToSimilarity(hit.score, maxScore, index)
    const matchedPathTerms = extractPathOverlapTerms(normalizedPath, questionTerms)
    const retrieval = buildRetrievalExplanation({
      keywordSimilarity: similarity,
      matchedPathTerms,
    })
    const existing = byPath.get(normalizedPath)
    if (!existing || similarity > existing.similarity) {
      byPath.set(normalizedPath, {
        notePath: normalizedPath,
        similarity,
        retrievalSummary: retrieval?.summary,
        retrievalTags: retrieval?.tags,
        retrievalPathTerms: retrieval?.matchedPathTerms,
      })
    }
  })

  return Array.from(byPath.values())
    .sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity
      return a.notePath.localeCompare(b.notePath)
    })
    .slice(0, Math.max(1, topK))
}

export const searchService: SearchService = {
  async findRelevantNotes(query: string, topK: number = 3): Promise<SearchResult[]> {
    console.log(`🔍 Searching for: "${query}"`)
    const perfStart = startPerfTimer()

    const normalizedTopK = Math.max(1, topK)
    const semanticLimit = Math.max(normalizedTopK * 2, 8)
    let semanticResults: SearchResult[] = []
    let keywordResults: SearchResult[] = []
    let queryEmbeddingVector: number[] | null = null
    let latestEmbeddingByPath = new Map<string, LatestEmbeddingEntry>()
    let semanticFromRust = false

    try {
      try {
        console.log('🔢 Generating query embedding...')
        const queryEmbedding = await localAiService.generateEmbedding(query)
        queryEmbeddingVector = queryEmbedding.embedding
      } catch (error) {
        console.warn('⚠️ Query embedding generation failed. Falling back to keyword retrieval:', error)
      }

      if (queryEmbeddingVector) {
        try {
          const rustHits = await vaultService.searchSemanticEmbeddings(queryEmbeddingVector, semanticLimit)
          semanticResults = rustHits
            .map((hit) => {
              const retrieval = buildRetrievalExplanation({ semanticSimilarity: hit.similarity })
              return {
                notePath: normalizeNotePath(hit.path),
                similarity: hit.similarity,
                content: hit.snippet,
                retrievalSummary: retrieval?.summary,
                retrievalTags: retrieval?.tags,
              }
            })
            .filter((item) => isPotentialRetrievalPath(item.notePath))
          semanticFromRust = semanticResults.length > 0
        } catch (error) {
          console.warn('⚠️ Rust semantic retrieval failed, falling back to JS ranking:', error)
        }
      }

      if (!semanticFromRust) {
        try {
          console.log('📂 Loading note embeddings...')
          const allEmbeddings = await vaultService.readAllEmbeddings()
          latestEmbeddingByPath = buildLatestEmbeddingMap(allEmbeddings)
          if (latestEmbeddingByPath.size === 0) {
            console.warn('⚠️ No usable note embeddings found in vault')
          }
        } catch (error) {
          console.warn('⚠️ Could not load embeddings from vault:', error)
        }
      }

      if (!semanticFromRust && queryEmbeddingVector && latestEmbeddingByPath.size > 0) {
        semanticResults = await buildSemanticResultsFromEmbeddingMap(queryEmbeddingVector, latestEmbeddingByPath, semanticLimit)
      }

      const isSemanticWeak =
        !queryEmbeddingVector
        || semanticResults.length < normalizedTopK
        || (semanticResults[0]?.similarity || 0) < 0.36

      if (isSemanticWeak) {
        try {
          keywordResults = await findRelevantNotesByKeyword(query, semanticLimit)
        } catch (error) {
          console.warn('⚠️ Keyword retrieval failed:', error)
        }
      }

      const shouldUseKeywordFallback =
        semanticResults.length < normalizedTopK || (semanticResults[0]?.similarity || 0) < 0.36

      if (shouldUseKeywordFallback) {
        if (keywordResults.length === 0) {
          try {
            keywordResults = await findRelevantNotesByKeyword(query, semanticLimit)
          } catch (error) {
            console.warn('⚠️ Keyword retrieval failed:', error)
          }
        }
      } else {
        keywordResults = []
      }

      const mergedResults = mergeHybridSearchResults(semanticResults, keywordResults, Math.max(normalizedTopK * 2, 8))
      const topResults = rerankResultsForQueryIntent(mergedResults, query, normalizedTopK)

      console.log('✅ Top results:')
      topResults.forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.notePath} (similarity: ${r.similarity.toFixed(3)})`)
      })

      return topResults
    } finally {
      recordPerfMetric('search_retrieval_ms', perfStart, {
        queryChars: query.length,
        topK: normalizedTopK,
        semanticHits: semanticResults.length,
        keywordHits: keywordResults.length,
      })
    }
  },

  async askQuestion(question: string): Promise<QAAnswerResult> {
    console.log(`❓ Question: "${question}"`)
    const perfStart = startPerfTimer()

    try {
      if (isSmallTalkQuestion(question)) {
        const fallback = await buildGeneralFallback(question)
        return {
          answer: fallback.answer,
          similarity: fallback.similarity,
          source: fallback.source,
          sourceType: fallback.sourceType,
          sourceSnippet: fallback.sourceSnippet,
          answerMode: fallback.answerMode,
          confidence: fallback.confidence,
          provenanceLabel: fallback.provenanceLabel,
        }
      }

      const factAnswer = await factsService.answerQuestionFromFacts(question)
      if (factAnswer) {
        return {
          answer: factAnswer.answer,
          similarity: factAnswer.similarity,
          source: factAnswer.source,
          sourceType: 'fact',
          sourceSnippet: factAnswer.fact.statement,
          groundingSummary: factAnswer.matchSummary,
          answerMode: 'grounded',
          confidence: 'high',
          provenanceLabel: 'Grounded in extracted facts',
        }
      }

      // 1. Find most relevant notes (get top 5 in case some files are missing)
      const results = await searchService.findRelevantNotes(question, 5)

      if (results.length === 0) {
        const fallback = await buildGeneralFallback(question)
        return {
          answer: fallback.answer,
          similarity: fallback.similarity,
          source: fallback.source,
          sourceType: fallback.sourceType,
          sourceSnippet: fallback.sourceSnippet,
          answerMode: fallback.answerMode,
          confidence: fallback.confidence,
          provenanceLabel: fallback.provenanceLabel,
        }
      }

      const groundingPlan = determineQAGroundingPlan(question, results)

      // 2. Build a context using either focused or synthesized grounding.
      const contextChunks: Array<{ path: string; content: string; similarity: number }> = []
      for (const result of results) {
        if (result.similarity < 0.22) {
          console.warn(`⚠️ Similarity too low (${result.similarity.toFixed(2)}) for ${result.notePath}`)
          continue
        }

        try {
          console.log(`📖 Reading note: ${result.notePath}`)
          const noteContent = await readAIContent(result.notePath)
          contextChunks.push({
            path: result.notePath,
            content: noteContent,
            similarity: result.similarity,
          })
          if (contextChunks.length >= groundingPlan.maxPrimaryChunks) break
        } catch (error) {
          console.warn(`⚠️ Could not read ${result.notePath}, trying next result...`, error)
          continue
        }
      }

      // 3. Extend context with one related-note chunk when synthesis is helpful.
      if (groundingPlan.includeRelatedNote && contextChunks.length > 0) {
        try {
          const related = await relatedNotesService.getRelatedNotes(contextChunks[0].path)
          for (const rel of related) {
            if (contextChunks.some((item) => item.path === rel.path)) continue
            const relContent = await readAIContent(rel.path)
            contextChunks.push({
              path: rel.path,
              content: relContent,
              similarity: rel.score,
            })
            break
          }
        } catch (error) {
          console.warn('⚠️ Related-note context enrichment failed:', error)
        }
      }

      if (contextChunks.length === 0) {
        const fallback = await buildGeneralFallback(question)
        return {
          answer: fallback.answer,
          similarity: fallback.similarity,
          source: fallback.source,
          sourceType: fallback.sourceType,
          sourceSnippet: fallback.sourceSnippet,
          answerMode: fallback.answerMode,
          confidence: fallback.confidence,
          provenanceLabel: fallback.provenanceLabel,
        }
      }

      // 4. Ask Ollama to answer using multi-note context.
      const combinedContext = contextChunks
        .map((chunk, index) => `[Source ${index + 1}: ${chunk.path}]\n${chunk.content.slice(0, 3600)}`)
        .join('\n\n---\n\n')

      const answer = await localAiService.answerQuestion(
        question,
        combinedContext,
        contextChunks.map((chunk) => chunk.path).join(', '),
      )

      const trust = classifyNoteAnswer(contextChunks[0]?.similarity ?? results[0]?.similarity ?? 0)
      const primaryResult = results.find((item) => item.notePath === contextChunks[0].path) || results[0]
      return {
        answer: softenAnswerForTrust(answer, trust),
        similarity: contextChunks[0]?.similarity ?? results[0]?.similarity ?? 0,
        source: contextChunks[0].path,
        sourceType: 'note',
        sourceSnippet: primaryResult?.content || extractBestSnippet(contextChunks[0].content, question),
        sourceContextKind: isImageSourcePath(contextChunks[0].path) ? 'ocr-image' : 'standard',
        retrievalSummary: primaryResult?.retrievalSummary,
        retrievalTags: primaryResult?.retrievalTags,
        groundingSummary: groundingPlan.summary,
        ...trust,
      }

    } catch (error) {
      console.error('❌ Q&A failed:', error)
      const fallback = await buildGeneralFallback(question)
      return {
        answer: fallback.answer,
        similarity: fallback.similarity,
        source: fallback.source,
        sourceType: fallback.sourceType,
        sourceSnippet: fallback.sourceSnippet,
        answerMode: fallback.answerMode,
        confidence: fallback.confidence,
        provenanceLabel: fallback.provenanceLabel,
      }
    } finally {
      recordPerfMetric('qa_single_ms', perfStart, {
        questionChars: question.length,
      })
    }
  },

  async askQuestionMultiple(question: string): Promise<QAAnswerResult[]> {
    console.log(`❓ Question (chat answer): "${question}"`)
    const perfStart = startPerfTimer()
    try {
      const answer = await searchService.askQuestion(question)
      return [answer]
    } finally {
      recordPerfMetric('qa_multi_ms', perfStart, {
        questionChars: question.length,
        answers: 1,
      })
    }
  },

  async regenerateAllEmbeddings(onProgress?: (current: number, total: number) => void): Promise<number> {
    console.log('🔄 Starting to regenerate all embeddings...')
    const perfStart = startPerfTimer()
    let totalNotes = 0
    let successCount = 0
    let skippedUnchangedCount = 0
    let processedCount = 0
    let prunedOrphanCount = 0

    try {
      invalidateIndexHealthCache()
      await requireOllamaFor('Regenerate embeddings')
      const selectedEmbeddingModel = localAiService.getSettings().embeddingModel
      const maxConcurrency = embeddingQueueService.getConcurrency()
      // 1. Get all notes in vault tree + latest embeddings
      const [tree, allEmbeddings] = await Promise.all([
        vaultService.getVaultTree(),
        vaultService.readAllEmbeddings(),
      ])
      const allFilePaths = await collectAiReadableVaultPaths(tree)
      totalNotes = allFilePaths.length
      console.log(`📚 Found ${allFilePaths.length} notes to process`)
      const latestEmbeddingByPath = buildLatestEmbeddingMap(allEmbeddings)
      const notePathSet = new Set(allFilePaths)
      prunedOrphanCount = await pruneOrphanEmbeddingPaths(notePathSet, Array.from(latestEmbeddingByPath.keys()))

      // 2. Generate or skip each file based on content hash + model (bounded concurrency).
      await runWithConcurrency(allFilePaths, maxConcurrency, async (rawPath, index) => {
        const filePath = normalizeNotePath(rawPath)
        try {
          const content = await readAIContent(filePath)
          if (!content.trim()) {
            console.warn(`⚠️ Skipping empty note during full regeneration: ${filePath}`)
            skippedUnchangedCount += 1
            return
          }

          const contentHash = computeContentHash(content).toLowerCase()
          const existing = latestEmbeddingByPath.get(filePath)
          const sameModel = !!existing && modelMatchesRequested(selectedEmbeddingModel, existing.model)
          const sameContent = !!existing && existing.contentHash.length > 0 && existing.contentHash === contentHash
          if (sameModel && sameContent) {
            skippedUnchangedCount += 1
            return
          }

          const embedding = await generateAdaptiveEmbedding(content, (chunk) => localAiService.generateEmbedding(chunk))
          embedding.content_hash = contentHash
          await vaultService.writeEmbedding(filePath, embedding)
          clearEmbeddingFailure(filePath)
          successCount += 1
          console.log(`✅ [${index + 1}/${allFilePaths.length}] Embedded: ${filePath}`)
        } catch (error) {
          recordEmbeddingFailure(filePath, error instanceof Error ? error.message : 'Embedding failed')
          console.warn(`⚠️ [${index + 1}/${allFilePaths.length}] Failed to embed ${filePath}:`, error)
        } finally {
          processedCount += 1
          onProgress?.(processedCount, allFilePaths.length)
        }
      })

      console.log(
        `✨ Regeneration complete! Updated ${successCount}/${allFilePaths.length} notes (skipped unchanged: ${skippedUnchangedCount})`,
      )
      return successCount
    } catch (error) {
      console.error('❌ Regeneration failed:', error)
      throw error
    } finally {
      const elapsedMs = Math.max(1, startPerfTimer() - perfStart)
      const elapsedSec = elapsedMs / 1000
      const embedsPerSec = elapsedSec > 0 ? (successCount / elapsedSec).toFixed(2) : '0.00'
      recordPerfMetric('regen_all_embeddings_ms', perfStart, {
        total: totalNotes,
        processed: processedCount,
        success: successCount,
        skipped: skippedUnchangedCount,
        prunedOrphans: prunedOrphanCount,
        eps: embedsPerSec,
      })
    }
  },

  async regenerateStaleEmbeddings(
    onProgress?: (current: number, total: number) => void,
    options?: StaleEmbeddingRegenerationOptions,
  ): Promise<StaleEmbeddingRegenerationResult> {
    console.log('♻️ Starting stale embedding regeneration...')
    const perfStart = startPerfTimer()
    let totalCandidates = 0
    let successCount = 0
    let processedCount = 0
    let cancelled = false
    let skippedUnchangedCount = 0
    let prunedOrphanCount = 0

    try {
      invalidateIndexHealthCache()
      await requireOllamaFor('Regenerate stale embeddings')
      const selectedEmbeddingModel = localAiService.getSettings().embeddingModel
      const maxConcurrency = embeddingQueueService.getConcurrency()
      const [tree, allEmbeddings] = await Promise.all([
        vaultService.getVaultTree(),
        vaultService.readAllEmbeddings(),
      ])

      const allNotePaths = await collectAiReadableVaultPaths(tree)
      const notePathSet = new Set(allNotePaths)
      const latestByPath = new Map<string, { model: string; createdAt: string; contentHash: string }>()

      for (const item of allEmbeddings) {
        const path = normalizeNotePath(item.path)
        if (!isPotentialRetrievalPath(path)) continue
        const existing = latestByPath.get(path)
        const createdAt = item.created_at || ''
        if (!existing || createdAt > existing.createdAt) {
          latestByPath.set(path, {
            model: item.model || '',
            createdAt,
            contentHash: (item.content_hash || '').trim().toLowerCase(),
          })
        }
      }

      prunedOrphanCount = await pruneOrphanEmbeddingPaths(notePathSet, Array.from(latestByPath.keys()))

      if (allNotePaths.length === 0) {
        onProgress?.(0, 0)
        console.log('✅ No indexable notes found for stale regeneration.')
        return { totalCandidates: 0, successCount: 0, processedCount: 0, cancelled: false }
      }

      totalCandidates = allNotePaths.length
      await runWithConcurrency(allNotePaths, maxConcurrency, async (notePath, index) => {
        if (cancelled || options?.shouldCancel?.()) {
          cancelled = true
          return
        }

        try {
          const content = await readAIContent(notePath)
          if (!content.trim()) {
            console.warn(`⚠️ Skipping empty note during stale regeneration: ${notePath}`)
            skippedUnchangedCount += 1
            return
          }

          const contentHash = computeContentHash(content).toLowerCase()
          const existing = latestByPath.get(notePath)
          const sameModel = !!existing && modelMatchesRequested(selectedEmbeddingModel, existing.model)
          const sameContent = !!existing && existing.contentHash.length > 0 && existing.contentHash === contentHash
          if (sameModel && sameContent) {
            skippedUnchangedCount += 1
            return
          }

          const embedding = await generateAdaptiveEmbedding(content, (chunk) => localAiService.generateEmbedding(chunk))
          embedding.content_hash = contentHash
          await vaultService.writeEmbedding(notePath, embedding)
          clearEmbeddingFailure(notePath)
          successCount += 1
          console.log(`✅ [${index + 1}/${allNotePaths.length}] Re-embedded stale/missing note: ${notePath}`)
        } catch (error) {
          recordEmbeddingFailure(notePath, error instanceof Error ? error.message : 'Embedding failed')
          console.warn(`⚠️ [${index + 1}/${allNotePaths.length}] Failed stale re-embedding for ${notePath}:`, error)
        } finally {
          processedCount += 1
          onProgress?.(processedCount, allNotePaths.length)
        }
      })

      if (cancelled) {
        console.log(`🛑 Stale regeneration cancelled at ${processedCount}/${allNotePaths.length}`)
        return {
          totalCandidates: allNotePaths.length,
          successCount,
          processedCount,
          cancelled: true,
        }
      }

      console.log(`✨ Stale regeneration complete! Re-embedded ${successCount}/${allNotePaths.length} checked notes`)
      return {
        totalCandidates: allNotePaths.length,
        successCount,
        processedCount,
        cancelled: false,
      }
    } catch (error) {
      console.error('❌ Stale regeneration failed:', error)
      throw error
    } finally {
      const elapsedMs = Math.max(1, startPerfTimer() - perfStart)
      const elapsedSec = elapsedMs / 1000
      const embedsPerSec = elapsedSec > 0 ? (successCount / elapsedSec).toFixed(2) : '0.00'
      recordPerfMetric('regen_stale_embeddings_ms', perfStart, {
        total: totalCandidates,
        processed: processedCount,
        success: successCount,
        skipped: skippedUnchangedCount,
        cancelled,
        prunedOrphans: prunedOrphanCount,
        eps: embedsPerSec,
      })
    }
  },

  async getEmbeddingModelStatus(): Promise<EmbeddingModelStatus> {
    const selectedEmbeddingModel = localAiService.getSettings().embeddingModel
    const [tree, allEmbeddings] = await Promise.all([
      vaultService.getVaultTree(),
      vaultService.readAllEmbeddings(),
    ])
    const notePathSet = new Set(await collectAiReadableVaultPaths(tree))

    const latestByPath = new Map<string, { model: string; createdAt: string }>()
    for (const item of allEmbeddings) {
      const key = normalizeNotePath(item.path)
      if (!notePathSet.has(key)) continue
      const existing = latestByPath.get(key)
      const createdAt = item.created_at || ''
      if (!existing || createdAt > existing.createdAt) {
        latestByPath.set(key, {
          model: item.model || '',
          createdAt,
        })
      }
    }

    const deduped = Array.from(latestByPath.values())
    const observedModels = Array.from(
      new Set(deduped.map((entry) => entry.model).filter((value) => value.trim().length > 0)),
    )

    let upToDateCount = 0
    for (const entry of deduped) {
      if (modelMatchesRequested(selectedEmbeddingModel, entry.model)) {
        upToDateCount += 1
      }
    }

    const totalEmbeddings = deduped.length
    const staleCount = Math.max(0, totalEmbeddings - upToDateCount)
    return {
      totalEmbeddings,
      upToDateCount,
      staleCount,
      selectedEmbeddingModel,
      observedModels,
      isStale: staleCount > 0,
    }
  },

  async getIndexHealthStatus(): Promise<IndexHealthStatus> {
    const details = await getCachedIndexHealthDetails()
    return {
      eligibleCount: details.eligibleCount,
      indexedCount: details.indexedCount,
      staleCount: details.staleCount,
      failedCount: details.failedCount,
    }
  },

  async getIndexHealthDetails(): Promise<IndexHealthDetails> {
    return getCachedIndexHealthDetails()
  },

  async retryFailedEmbeddings(onProgress?: (current: number, total: number) => void): Promise<number> {
    invalidateIndexHealthCache()
    const details = await getCachedIndexHealthDetails(true)
    const failedPaths = details.issues.filter((issue) => issue.type === 'failed').map((issue) => issue.path)
    const result = await regenerateSpecificEmbeddings(failedPaths, onProgress)
    invalidateIndexHealthCache()
    return result
  },

  async rebuildStaleAndMissingEmbeddings(onProgress?: (current: number, total: number) => void): Promise<number> {
    invalidateIndexHealthCache()
    const details = await getCachedIndexHealthDetails(true)
    const targetPaths = details.issues
      .filter((issue) => issue.type === 'stale' || issue.type === 'missing')
      .map((issue) => issue.path)
    const result = await regenerateSpecificEmbeddings(targetPaths, onProgress)
    invalidateIndexHealthCache()
    return result
  },
}
