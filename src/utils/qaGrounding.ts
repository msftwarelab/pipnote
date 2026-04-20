import type { SearchResult } from '../services/localAi'
import { detectRetrievalQueryIntent } from './retrievalRanking.ts'

export type QAGroundingMode = 'focused' | 'synthesized'

export interface QAGroundingPlan {
  mode: QAGroundingMode
  maxPrimaryChunks: number
  includeRelatedNote: boolean
  summary: string
}

function isSynthesisQuestion(question: string): boolean {
  return /\b(compare|difference|tradeoffs?|trade-offs?|pros|cons|strategy|summarize|summary|how|why|analyze)\b/i.test(question)
}

export function determineQAGroundingPlan(question: string, results: SearchResult[]): QAGroundingPlan {
  const top = results[0]
  const second = results[1]
  const intent = detectRetrievalQueryIntent(question)

  if (!top) {
    return {
      mode: 'focused',
      maxPrimaryChunks: 1,
      includeRelatedNote: false,
      summary: 'No note evidence was strong enough to build a grounded answer plan.',
    }
  }

  const topGap = top.similarity - (second?.similarity || 0)
  const directLookup = (top.retrievalTags || []).includes('Direct lookup match')

  if ((intent === 'lookup' && top.similarity >= 0.46 && (directLookup || topGap >= 0.08)) || (top.similarity >= 0.78 && topGap >= 0.12)) {
    return {
      mode: 'focused',
      maxPrimaryChunks: 1,
      includeRelatedNote: false,
      summary: 'Focused on one strong note match to answer a direct lookup-style question.',
    }
  }

  if (isSynthesisQuestion(question) || ((second?.similarity || 0) >= 0.3 && topGap < 0.14)) {
    return {
      mode: 'synthesized',
      maxPrimaryChunks: 2,
      includeRelatedNote: true,
      summary: 'Synthesized across multiple related notes because the question benefits from broader context.',
    }
  }

  return {
    mode: 'focused',
    maxPrimaryChunks: 1,
    includeRelatedNote: false,
    summary: 'Focused on the strongest matching note to keep the answer precise.',
  }
}
