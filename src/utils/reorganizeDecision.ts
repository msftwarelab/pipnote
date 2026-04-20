import { determineMoveSuggestionLevel, looksUncategorized } from './reorganizePathing.ts'

export interface ReorgDecisionTaxonomy {
  topLevels: Set<string>
  subpathsByTopLevel: Map<string, Set<string>>
}

export interface ReorgDecisionPreferences {
  acceptedTopLevelMoves: Record<string, number>
  deniedTopLevelMoves: Record<string, number>
  acceptedTargetParents: Record<string, number>
  deniedTargetParents: Record<string, number>
  acceptedTokenParents: Record<string, Record<string, number>>
}

export interface MoveDecisionInput {
  currentRelative: string
  targetRelative: string
  parseFailed: boolean
  reason: string
  currentStructured: boolean
  currentTitleMessy: boolean
}

function topLevel(relative: string): string {
  return relative.split('/').filter(Boolean)[0]?.toLowerCase() || ''
}

export function targetParentKey(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(0, -1).join('/').toLowerCase()
}

export function topLevelMoveKey(sourcePath: string, targetPath: string): string {
  const sourceTop = topLevel(sourcePath)
  const targetTop = topLevel(targetPath)
  return sourceTop && targetTop ? `${sourceTop}=>${targetTop}` : ''
}

export function tokenizeForReorgLearning(value: string): string[] {
  const normalized = value
    .toLowerCase()
    .replace(/\.[^.]+$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')

  return normalized
    .split(/\s+/)
    .filter((token) => token.length >= 4)
    .slice(0, 8)
}

function fileName(relative: string): string {
  return relative.split('/').pop() || relative
}

function currentFolderFitScore(
  currentRelative: string,
  taxonomy: ReorgDecisionTaxonomy,
  preferences: ReorgDecisionPreferences,
): number {
  const currentTop = topLevel(currentRelative)
  const currentParent = targetParentKey(currentRelative)
  const currentSubpaths = taxonomy.subpathsByTopLevel.get(currentTop)
  const tokens = tokenizeForReorgLearning(fileName(currentRelative))

  let score = 0
  if (currentTop && taxonomy.topLevels.has(currentTop)) {
    score += 2
  }
  if (currentParent && currentSubpaths?.has(currentParent)) {
    score += 3
  }

  const approvedParent = preferences.acceptedTargetParents[currentParent] || 0
  score += Math.min(3, approvedParent)

  const learnedTokenSupport = tokens.reduce((sum, token) => {
    return sum + (preferences.acceptedTokenParents[token]?.[currentParent] || 0)
  }, 0)
  score += Math.min(3, learnedTokenSupport)

  return score
}

export function targetFolderFitScore(
  currentRelative: string,
  targetRelative: string,
  taxonomy: ReorgDecisionTaxonomy,
  preferences: ReorgDecisionPreferences,
): number {
  const currentTop = topLevel(currentRelative)
  const targetTop = topLevel(targetRelative)
  const targetParent = targetParentKey(targetRelative)
  const targetSubpaths = taxonomy.subpathsByTopLevel.get(targetTop)
  const topMove = topLevelMoveKey(currentRelative, targetRelative)
  const tokens = tokenizeForReorgLearning(fileName(currentRelative))

  let score = 0

  if (targetTop && taxonomy.topLevels.has(targetTop)) {
    score += 2
  } else if (targetTop) {
    score -= 2
  }

  if (targetParent && targetSubpaths?.has(targetParent)) {
    score += 3
  } else if (targetParent && targetTop && taxonomy.topLevels.has(targetTop)) {
    score -= 1
  }

  if (currentTop && targetTop && currentTop === targetTop) {
    score += 1
  }

  score += Math.min(3, preferences.acceptedTopLevelMoves[topMove] || 0)
  score -= Math.min(3, preferences.deniedTopLevelMoves[topMove] || 0)
  score += Math.min(4, preferences.acceptedTargetParents[targetParent] || 0)
  score -= Math.min(4, preferences.deniedTargetParents[targetParent] || 0)

  const learnedTokenSupport = tokens.reduce((sum, token) => {
    return sum + (preferences.acceptedTokenParents[token]?.[targetParent] || 0)
  }, 0)
  score += Math.min(4, learnedTokenSupport)

  return score
}

function isRenameOnly(currentRelative: string, targetRelative: string): boolean {
  return targetParentKey(currentRelative) === targetParentKey(targetRelative)
}

function isUncertainReason(reason: string): boolean {
  return /heuristic pass|could not parse analysis|analysis failed|error during analysis|low-confidence/i.test(reason)
}

export function shouldMoveFromDecision(
  input: MoveDecisionInput,
  taxonomy: ReorgDecisionTaxonomy,
  preferences: ReorgDecisionPreferences,
): boolean {
  const {
    currentRelative,
    targetRelative,
    parseFailed,
    reason,
    currentStructured,
    currentTitleMessy,
  } = input

  if (looksUncategorized(currentRelative)) return true
  if (targetRelative === currentRelative) return false
  if (parseFailed && currentStructured) return false

  const suggestionLevel = determineMoveSuggestionLevel(currentRelative, targetRelative)
  const currentTop = topLevel(currentRelative)
  const targetTop = topLevel(targetRelative)
  const topLevelKey = topLevelMoveKey(currentRelative, targetRelative)
  const targetParent = targetParentKey(targetRelative)
  const acceptedTopLevel = preferences.acceptedTopLevelMoves[topLevelKey] || 0
  const deniedTopLevel = preferences.deniedTopLevelMoves[topLevelKey] || 0
  const acceptedParent = preferences.acceptedTargetParents[targetParent] || 0
  const deniedParent = preferences.deniedTargetParents[targetParent] || 0

  if (deniedTopLevel >= 2 && deniedTopLevel > acceptedTopLevel) return false
  if (deniedParent >= 2 && deniedParent > acceptedParent) return false

  if (currentStructured && currentTop && targetTop && currentTop !== targetTop && !taxonomy.topLevels.has(targetTop)) {
    return false
  }

  if (isRenameOnly(currentRelative, targetRelative)) {
    return currentTitleMessy
  }

  const currentScore = currentFolderFitScore(currentRelative, taxonomy, preferences)
  const targetScore = targetFolderFitScore(currentRelative, targetRelative, taxonomy, preferences)
  const scoreDelta = targetScore - currentScore

  if (currentStructured && isUncertainReason(reason)) {
    return scoreDelta >= 3
  }

  if (currentStructured && suggestionLevel === 'optional') {
    return scoreDelta >= 3
  }

  if (currentStructured && currentTop && targetTop && currentTop !== targetTop) {
    return scoreDelta >= 3
  }

  if (currentStructured && suggestionLevel === 'recommended') {
    return scoreDelta >= 2
  }

  return scoreDelta > 0
}

export function explainFolderFitDelta(
  currentRelative: string,
  targetRelative: string,
  taxonomy: ReorgDecisionTaxonomy,
  preferences: ReorgDecisionPreferences,
): string | null {
  const currentScore = currentFolderFitScore(currentRelative, taxonomy, preferences)
  const targetScore = targetFolderFitScore(currentRelative, targetRelative, taxonomy, preferences)
  const delta = targetScore - currentScore

  if (delta >= 3) return 'target folder is a much stronger fit than the current location'
  if (delta >= 2) return 'target folder is a better fit than the current location'
  return null
}
