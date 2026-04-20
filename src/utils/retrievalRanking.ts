import type { SearchResult } from '../services/localAi'

export type RetrievalQueryIntent = 'lookup' | 'exploratory'

const LOOKUP_HINTS = new Set([
  'open', 'find', 'show', 'locate', 'which', 'where', 'file', 'note', 'document', 'doc', 'path', 'folder',
])

const EXPLORATORY_HINTS = new Set([
  'why', 'how', 'explain', 'summarize', 'summary', 'compare', 'tradeoffs', 'tradeoff', 'strategy', 'plan',
])

function tokenizeQuery(query: string): string[] {
  return (query.toLowerCase().match(/[a-z0-9]{2,}/g) || []).slice(0, 12)
}

function basenameWithoutExt(path: string): string {
  return path.split('/').pop()?.replace(/\.[a-z0-9]+$/i, '') || path
}

export function detectRetrievalQueryIntent(query: string): RetrievalQueryIntent {
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) return 'exploratory'
  const normalized = query.toLowerCase().trim()

  const lookupHits = tokens.filter((token) => LOOKUP_HINTS.has(token)).length
  const exploratoryHits = tokens.filter((token) => EXPLORATORY_HINTS.has(token)).length
  const quotedLookup = /["'][^"']+["']/.test(query)
  const explicitLookupPhrase = /\b(open|find|show|locate)\b/.test(normalized)
    || /\b(where|which)\b.+\b(note|file|doc|document|path|folder)\b/.test(normalized)

  if (explicitLookupPhrase) return 'lookup'
  if (quotedLookup) return 'lookup'
  if (exploratoryHits > 0) return 'exploratory'
  if (lookupHits > 0 && tokens.length <= 10) return 'lookup'
  if (tokens.length <= 5 && /\b(note|file|doc|document)\b/i.test(query)) return 'lookup'
  return 'exploratory'
}

function countDirectPathMatches(notePath: string, queryTokens: string[]): number {
  const lowerPath = notePath.toLowerCase()
  return queryTokens.filter((token) => lowerPath.includes(token) && !LOOKUP_HINTS.has(token)).length
}

function countDirectTitleMatches(notePath: string, queryTokens: string[]): number {
  const title = basenameWithoutExt(notePath).toLowerCase()
  return queryTokens.filter((token) => title.includes(token) && !LOOKUP_HINTS.has(token)).length
}

export function rerankResultsForQueryIntent(results: SearchResult[], query: string, topK: number): SearchResult[] {
  const intent = detectRetrievalQueryIntent(query)
  if (intent !== 'lookup') {
    return results.slice(0, Math.max(1, topK))
  }

  const queryTokens = tokenizeQuery(query)
  const reranked = results.map((result) => {
    const titleMatches = countDirectTitleMatches(result.notePath, queryTokens)
    const pathMatches = countDirectPathMatches(result.notePath, queryTokens)
    const exactishTitle = titleMatches > 0 && basenameWithoutExt(result.notePath).toLowerCase().includes(queryTokens.filter((token) => !LOOKUP_HINTS.has(token)).join(' ').trim())

    let boostedSimilarity = result.similarity
    boostedSimilarity += Math.min(0.12, titleMatches * 0.035)
    boostedSimilarity += Math.min(0.08, pathMatches * 0.02)
    if (exactishTitle) boostedSimilarity += 0.06

    const shouldTagLookup = titleMatches > 0 || pathMatches > 1 || exactishTitle
    const retrievalTags = shouldTagLookup
      ? Array.from(new Set(['Direct lookup match', ...(result.retrievalTags || [])])).slice(0, 4)
      : result.retrievalTags

    const retrievalSummary = shouldTagLookup
      ? 'Boosted because this looks like a direct note/file lookup and the title or path matches closely.'
      : result.retrievalSummary

    return {
      ...result,
      similarity: Math.min(0.99, boostedSimilarity),
      retrievalTags,
      retrievalSummary,
    }
  })

  return reranked
    .sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity
      return a.notePath.localeCompare(b.notePath)
    })
    .slice(0, Math.max(1, topK))
}
