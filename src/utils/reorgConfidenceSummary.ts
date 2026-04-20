import type { ReorganizationOperation, ReorganizationOperationReviewContext } from '../services/reorganize'

export interface ReorgConfidenceSummary {
  label: string
  detail: string
  className: string
}

export interface ReorgConfidenceCounts {
  high: number
  moderate: number
  lower: number
  manual: number
}

function hasLowConfidenceReason(reason: string): boolean {
  return reason.toLowerCase().includes('low-confidence refinement')
}

function hasWeakExtraction(reviewContext?: ReorganizationOperationReviewContext): boolean {
  return reviewContext?.extractionQuality === 'low'
}

function hasLimitedExtraction(reviewContext?: ReorganizationOperationReviewContext): boolean {
  return reviewContext?.extractionQuality === 'medium'
}

export function buildReorgConfidenceSummary(op: ReorganizationOperation): ReorgConfidenceSummary {
  const validated = !!op.reviewContext?.validationPassed
  const weakExtraction = hasWeakExtraction(op.reviewContext)
  const limitedExtraction = hasLimitedExtraction(op.reviewContext)
  const lowConfidence = hasLowConfidenceReason(op.reason)

  if (op.type === 'merge') {
    if (validated) {
      return {
        label: 'High confidence',
        detail: 'Strong duplicate or superseded-version signal passed Pipnote validation.',
        className: 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-200 dark:border-emerald-800/60',
      }
    }
  }

  if (op.type === 'move' && op.targetPath?.startsWith('Review/')) {
    return {
      label: 'Manual review',
      detail: 'Pipnote found enough risk to avoid auto-organizing this file.',
      className: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-900/20 dark:text-amber-200 dark:border-amber-800/60',
    }
  }

  if (lowConfidence || weakExtraction || op.suggestionLevel === 'optional') {
    return {
      label: 'Lower confidence',
      detail: weakExtraction
        ? 'Pipnote softened this suggestion because the extracted evidence was weak or noisy.'
        : 'This is a lighter refinement rather than one of Pipnote’s strongest suggestions.',
      className: 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900/30 dark:text-slate-200 dark:border-slate-700',
    }
  }

  if (limitedExtraction || op.suggestionLevel === 'recommended') {
    return {
      label: 'Moderate confidence',
      detail: validated
        ? 'This suggestion passed Pipnote validation, but it is still a moderate-confidence change.'
        : 'This suggestion looks useful, but it is not in the highest-confidence tier.',
      className: 'bg-sky-50 text-sky-800 border-sky-200 dark:bg-sky-900/20 dark:text-sky-200 dark:border-sky-800/60',
    }
  }

  return {
    label: 'High confidence',
    detail: validated
      ? 'This suggestion passed Pipnote validation and is one of the stronger recommendations.'
      : 'This is one of the stronger suggestions in the current review set.',
    className: 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-200 dark:border-emerald-800/60',
  }
}

export function getReorgConfidenceRank(summary: ReorgConfidenceSummary): number {
  if (summary.label === 'Manual review') return 0
  if (summary.label === 'High confidence') return 1
  if (summary.label === 'Moderate confidence') return 2
  return 3
}

export function summarizeReorgConfidenceCounts(operations: ReorganizationOperation[]): ReorgConfidenceCounts {
  return operations.reduce<ReorgConfidenceCounts>((counts, op) => {
    const label = buildReorgConfidenceSummary(op).label
    if (label === 'Manual review') counts.manual += 1
    else if (label === 'High confidence') counts.high += 1
    else if (label === 'Moderate confidence') counts.moderate += 1
    else counts.lower += 1
    return counts
  }, {
    high: 0,
    moderate: 0,
    lower: 0,
    manual: 0,
  })
}
