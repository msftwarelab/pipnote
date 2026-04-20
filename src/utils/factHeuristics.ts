export type FactQuestionIntent = 'direct' | 'contextual'

const CONTEXTUAL_PATTERNS: RegExp[] = [
  /\bhow\b/i,
  /\bwhy\b/i,
  /\bcompare\b/i,
  /\btrade-?offs?\b/i,
  /\bstrategy\b/i,
  /\bplan\b/i,
  /\bsummar(?:ize|y)\b/i,
  /\banaly[sz]e\b/i,
]

const DIRECT_PATTERNS: RegExp[] = [
  /^\s*(when|what|who|where|which|is|are|was|were)\b/i,
  /\b(date|day|birthday|anniversary|deadline|interview|meeting|appointment|wedding)\b/i,
  /\bmy\b.+\b(is|are|was|were)\b/i,
]

export function detectFactQuestionIntent(question: string): FactQuestionIntent {
  const normalized = question.trim()
  if (!normalized) return 'contextual'
  if (CONTEXTUAL_PATTERNS.some((pattern) => pattern.test(normalized))) return 'contextual'
  if (DIRECT_PATTERNS.some((pattern) => pattern.test(normalized))) return 'direct'
  return 'contextual'
}

export function shouldPreferFactAnswer(question: string, score: number, kind: 'date' | 'attribute'): boolean {
  const intent = detectFactQuestionIntent(question)
  if (intent !== 'direct') return false
  if (kind === 'date') return score >= 0.34
  return score >= 0.4
}
