import type { SearchResult } from '../services/localAi'
import { buildRetrievalExplanation } from './retrievalExplainability.ts'

const SMALL_TALK_PATTERNS: RegExp[] = [
  /^(hi|hey|hello|yo|sup|hola)[!. ]*$/i,
  /^(good (morning|afternoon|evening))[!. ]*$/i,
  /^(how are you|how's it going|how is it going)[?.! ]*$/i,
  /^(thanks|thank you|thx)[!. ]*$/i,
  /^(nice to meet you)[!. ]*$/i,
]

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

export function isSmallTalkQuestion(question: string): boolean {
  const normalized = question.trim().replace(/\s+/g, ' ')
  if (!normalized) return false
  if (normalized.length > 64) return false
  return SMALL_TALK_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function keywordScoreToSimilarity(rawScore: number, maxScore: number, rank: number): number {
  if (rawScore <= 0 || maxScore <= 0) return 0
  const normalized = clamp01(rawScore / maxScore)
  const rankPenalty = Math.min(0.12, rank * 0.015)
  return clamp01(0.24 + normalized * 0.58 - rankPenalty)
}

export function mergeHybridSearchResults(
  semantic: SearchResult[],
  keyword: SearchResult[],
  topK: number,
): SearchResult[] {
  const semanticMap = new Map<string, SearchResult>()
  semantic.forEach((item) => {
    const existing = semanticMap.get(item.notePath)
    if (!existing || item.similarity > existing.similarity) {
      semanticMap.set(item.notePath, item)
    }
  })

  const keywordMap = new Map<string, SearchResult>()
  keyword.forEach((item) => {
    const existing = keywordMap.get(item.notePath)
    if (!existing || item.similarity > existing.similarity) {
      keywordMap.set(item.notePath, item)
    }
  })

  const combined = new Map<string, SearchResult>()
  const allPaths = new Set<string>([
    ...Array.from(semanticMap.keys()),
    ...Array.from(keywordMap.keys()),
  ])

  allPaths.forEach((path) => {
    const semanticHit = semanticMap.get(path)
    const keywordHit = keywordMap.get(path)
    const semanticSimilarity = semanticHit?.similarity || 0
    const keywordSimilarity = keywordHit?.similarity || 0
    let similarity = Math.max(semanticSimilarity, keywordSimilarity)
    if (semanticSimilarity > 0 && keywordSimilarity > 0) {
      similarity = Math.min(0.98, similarity + 0.06)
    }

    const retrieval = buildRetrievalExplanation({
      semanticSimilarity,
      keywordSimilarity,
      matchedPathTerms: keywordHit?.retrievalPathTerms || [],
    })

    combined.set(path, {
      notePath: path,
      similarity,
      content: semanticHit?.content || keywordHit?.content,
      retrievalSummary: retrieval?.summary,
      retrievalTags: retrieval?.tags,
      retrievalPathTerms: retrieval?.matchedPathTerms,
    })
  })

  return Array.from(combined.values())
    .sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity
      return a.notePath.localeCompare(b.notePath)
    })
    .slice(0, Math.max(1, topK))
}
