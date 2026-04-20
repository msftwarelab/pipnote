import { determineMoveSuggestionLevel, looksUncategorized } from './reorganizePathing.ts'

export interface ReorgOutcomeInput {
  currentRelative: string
  targetRelative: string
  reason: string
  parseFailed: boolean
  currentTitleMessy: boolean
  isDuplicate: boolean
  duplicateOf?: string
}

export interface ReorgOutcomeResult {
  suppress: boolean
  isDuplicate: boolean
  renameOnly: boolean
}

export interface ReviewSuggestionInput {
  currentRelative: string
  reason: string
  parseFailed: boolean
  currentTitleMessy: boolean
}

function parentPath(path: string): string {
  return path.split('/').slice(0, -1).join('/').toLowerCase()
}

function basename(path: string): string {
  return path.split('/').pop()?.toLowerCase() || ''
}

function hasLowConfidenceReason(reason: string): boolean {
  return reason.toLowerCase().includes('low-confidence refinement')
}

function hasStrongReviewReason(reason: string): boolean {
  return /\b(empty|blank|orphaned|broken|corrupt|garbage|junk|temporary|temp|unsupported|manual check|required|unreadable|failed)\b/i.test(reason)
}

export function determineReorgOutcome(input: ReorgOutcomeInput): ReorgOutcomeResult {
  const renameOnly =
    parentPath(input.currentRelative) === parentPath(input.targetRelative)
    && basename(input.currentRelative) !== basename(input.targetRelative)

  const invalidDuplicate =
    input.isDuplicate
    && (
      input.parseFailed
      || !input.duplicateOf
      || input.duplicateOf.toLowerCase() === input.currentRelative.toLowerCase()
      || hasLowConfidenceReason(input.reason)
    )

  const weakOptionalMove =
    !input.isDuplicate
    && !invalidDuplicate
    && !renameOnly
    && !looksUncategorized(input.currentRelative)
    && !input.currentTitleMessy
    && determineMoveSuggestionLevel(input.currentRelative, input.targetRelative) === 'optional'
    && hasLowConfidenceReason(input.reason)

  if (input.currentRelative.toLowerCase() === input.targetRelative.toLowerCase() && !renameOnly && !input.isDuplicate) {
    return {
      suppress: true,
      isDuplicate: false,
      renameOnly: false,
    }
  }

  if (weakOptionalMove) {
    return {
      suppress: true,
      isDuplicate: false,
      renameOnly,
    }
  }

  return {
    suppress: false,
    isDuplicate: input.isDuplicate && !invalidDuplicate,
    renameOnly,
  }
}

export function shouldSurfaceReviewSuggestion(input: ReviewSuggestionInput): boolean {
  if (input.parseFailed) {
    return false
  }

  if (hasLowConfidenceReason(input.reason) && !input.currentTitleMessy && !looksUncategorized(input.currentRelative)) {
    return false
  }

  if (input.reason.trim().length < 18 && !hasStrongReviewReason(input.reason)) {
    return false
  }

  if (!hasStrongReviewReason(input.reason) && !input.currentTitleMessy && !looksUncategorized(input.currentRelative)) {
    return false
  }

  return true
}
