export interface RetrievalExplanation {
  summary: string
  tags: string[]
  semanticSimilarity?: number
  keywordSimilarity?: number
  matchedPathTerms?: string[]
}

interface RetrievalExplanationInput {
  semanticSimilarity?: number
  keywordSimilarity?: number
  matchedPathTerms?: string[]
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

export function buildRetrievalExplanation(input: RetrievalExplanationInput): RetrievalExplanation | undefined {
  const semanticSimilarity = Number.isFinite(input.semanticSimilarity) ? (input.semanticSimilarity ?? 0) : 0
  const keywordSimilarity = Number.isFinite(input.keywordSimilarity) ? (input.keywordSimilarity ?? 0) : 0
  const matchedPathTerms = uniqueNonEmpty(input.matchedPathTerms || []).slice(0, 3)

  if (semanticSimilarity <= 0 && keywordSimilarity <= 0) {
    return undefined
  }

  const tags: string[] = []
  let summary = 'Retrieved as a relevant source.'

  if (semanticSimilarity > 0 && keywordSimilarity > 0) {
    tags.push('Semantic match', 'Keyword match')
    summary = matchedPathTerms.length > 0
      ? `Matched both the meaning of your question and direct path keywords like ${matchedPathTerms.map((term) => `"${term}"`).join(', ')}.`
      : 'Matched both the meaning of your question and direct keywords from the query.'
  } else if (semanticSimilarity > 0) {
    tags.push('Semantic match')
    summary = semanticSimilarity >= 0.72
      ? 'Strong semantic match to the meaning of your question.'
      : 'Semantic match to the meaning of your question.'
  } else if (keywordSimilarity > 0) {
    tags.push('Keyword match')
    summary = 'Direct keyword overlap with your question.'
  }

  if (matchedPathTerms.length > 0) {
    tags.push('Title/path match')
    if (semanticSimilarity <= 0) {
      summary = `Direct keyword match in the file name or folder path for ${matchedPathTerms.map((term) => `"${term}"`).join(', ')}.`
    }
  }

  return {
    summary,
    tags,
    semanticSimilarity: semanticSimilarity > 0 ? semanticSimilarity : undefined,
    keywordSimilarity: keywordSimilarity > 0 ? keywordSimilarity : undefined,
    matchedPathTerms: matchedPathTerms.length > 0 ? matchedPathTerms : undefined,
  }
}
