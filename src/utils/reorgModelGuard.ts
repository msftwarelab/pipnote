import type { FileIntelligence } from './fileIntelligence.ts'
import { looksLikeMessyGeneratedTitle, type FolderSuggestion, type NamingPlan } from './titleNaming.ts'

export type ReorgModelConfidence = 'high' | 'medium' | 'low'

export interface ReorgModelGuardInput {
  currentPath: string
  suggestedPath: string
  suggestedTitle: string
  reason: string
  isDuplicate: boolean
  duplicateOf?: string
  namingPlan: NamingPlan
  expectedFolder: FolderSuggestion
  fileContext?: FileIntelligence
}

export interface ReorgModelGuardResult {
  confidence: ReorgModelConfidence
  flags: string[]
}

const GENERIC_TOP_LEVELS = new Set([
  'notes',
  'misc',
  'miscellaneous',
  'general',
  'uncategorized',
  'untitled',
  'files',
  'documents',
  'document',
  'folder',
  'stuff',
  'other',
  'others',
])

const GENERIC_REASON_PATTERNS = [
  /\bbetter fit\b/i,
  /\bbetter folder\b/i,
  /\bmore appropriate\b/i,
  /\borgani[sz]ed better\b/i,
  /\bclearer category\b/i,
  /\blogical folder\b/i,
  /\bmakes sense\b/i,
  /\bimproved organization\b/i,
]

const STRICT_FOLDER_KINDS = new Set([
  'prompt',
  'resume',
  'contract',
  'document',
  'image',
  'presentation',
  'spreadsheet',
  'interview',
])

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function topLevelOf(path: string): string {
  return path
    .replace(/^\/+/, '')
    .replace(/^notes\//i, '')
    .split('/')
    .filter(Boolean)[0]
    ?.toLowerCase() || ''
}

function targetParent(path: string): string {
  const parts = path
    .replace(/^\/+/, '')
    .replace(/^notes\//i, '')
    .split('/')
    .filter(Boolean)
  return parts.slice(0, -1).join('/').toLowerCase()
}

function isWeakReason(reason: string): boolean {
  const normalized = reason.trim()
  if (!normalized) return true
  if (normalized.length < 18) return true
  const words = tokenize(normalized)
  if (words.length <= 3) return true
  return GENERIC_REASON_PATTERNS.some((pattern) => pattern.test(normalized))
}

function titlePathMismatch(suggestedPath: string, suggestedTitle: string): boolean {
  const pathLeaf = suggestedPath.split('/').filter(Boolean).pop() || ''
  const pathWords = new Set(tokenize(pathLeaf))
  const titleWords = tokenize(suggestedTitle)
  if (titleWords.length === 0) return true
  const overlap = titleWords.filter((word) => pathWords.has(word)).length
  return overlap < Math.max(1, Math.floor(titleWords.length / 2))
}

export function isHeuristicFallbackReason(reason: string): boolean {
  const normalized = reason.trim()
  return normalized.startsWith('Heuristic fallback')
    || normalized === 'Could not parse analysis'
    || normalized.startsWith('Analysis failed')
    || normalized === 'Error during analysis'
}

export function assessReorgModelOutput(input: ReorgModelGuardInput): ReorgModelGuardResult {
  const flags: string[] = []
  let score = 0

  const suggestedTop = topLevelOf(input.suggestedPath)
  const expectedTop = input.expectedFolder.category.toLowerCase()
  const expectedSubcategory = input.expectedFolder.subcategory?.toLowerCase()
  const expectedParent = [expectedTop, expectedSubcategory].filter(Boolean).join('/')
  const currentTop = topLevelOf(input.currentPath)

  if (!suggestedTop || GENERIC_TOP_LEVELS.has(suggestedTop)) {
    flags.push('generic folder target')
    score += 3
  }

  if (looksLikeMessyGeneratedTitle(input.suggestedTitle)) {
    flags.push('messy generated title')
    score += 3
  }

  if (titlePathMismatch(input.suggestedPath, input.suggestedTitle)) {
    flags.push('title/path mismatch')
    score += 2
  }

  if (isWeakReason(input.reason)) {
    flags.push('generic rationale')
    score += 2
  }

  const useStrictFolderChecks = STRICT_FOLDER_KINDS.has(input.namingPlan.kind)

  if (useStrictFolderChecks && expectedTop && suggestedTop && expectedTop !== suggestedTop) {
    flags.push('folder conflicts with naming plan')
    score += 2
  }

  const targetParentValue = targetParent(input.suggestedPath)
  if (useStrictFolderChecks && expectedParent && targetParentValue && !targetParentValue.startsWith(expectedParent)) {
    flags.push('subcategory conflicts with naming plan')
    score += 1
  }

  if (
    input.fileContext?.conservativeReorganization
    && currentTop
    && suggestedTop
    && currentTop !== suggestedTop
  ) {
    flags.push('aggressive move despite weak extraction')
    score += 2
  }

  if (input.isDuplicate && !input.duplicateOf) {
    flags.push('duplicate without target')
    score += 3
  }

  if (input.isDuplicate && isWeakReason(input.reason)) {
    flags.push('weak duplicate rationale')
    score += 1
  }

  const confidence: ReorgModelConfidence = score >= 5
    ? 'low'
    : score >= 2
      ? 'medium'
      : 'high'

  return {
    confidence,
    flags,
  }
}
