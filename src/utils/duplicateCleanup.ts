import type { FileRole } from './fileIntelligence'

export interface DuplicateCandidateEntry {
  path: string
  content: string
  fileRole?: FileRole
  modifiedAt?: string
}

export interface DuplicateDetectionResult {
  kind: 'none' | 'exact-delete' | 'merge-recommended' | 'superseded-delete'
  targetPath?: string
  reason?: string
}

type DuplicatePreferenceReason =
  | 'cleaner-canonical'
  | 'better-organized'
  | 'final-version'
  | 'non-draft'
  | 'newer-copy'
  | 'shorter-path'

const DUPLICATE_NOISE_PATTERNS = [
  /\bcopy\b/gi,
  /\bfinal\b/gi,
  /\bexport\b/gi,
  /\bscan(?:ned)?\d*\b/gi,
  /\bimg[_ -]?\d+\b/gi,
  /\(\d+\)/g,
  /[_ -]v\d+\b/gi,
  /[_ -]\d{4}[-_]\d{2}[-_]\d{2}\b/g,
]

const STEM_NORMALIZE_PATTERNS = [
  ...DUPLICATE_NOISE_PATTERNS,
  /\bdraft\b/gi,
]

function basenameWithoutExt(path: string): string {
  const base = path.split('/').pop() || path
  return base.replace(/\.[^/.]+$/, '')
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2)
}

function buildTokenSet(value: string): Set<string> {
  return new Set(tokenize(value))
}

function tokenJaccard(a: string, b: string): number {
  const aTokens = buildTokenSet(a)
  const bTokens = buildTokenSet(b)
  if (aTokens.size === 0 || bTokens.size === 0) return 0
  let intersection = 0
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1
  }
  const union = aTokens.size + bTokens.size - intersection
  return union > 0 ? intersection / union : 0
}

function tokenCoverage(subsetText: string, supersetText: string): number {
  const subset = buildTokenSet(subsetText)
  const superset = buildTokenSet(supersetText)
  if (subset.size === 0 || superset.size === 0) return 0
  let covered = 0
  for (const token of subset) {
    if (superset.has(token)) covered += 1
  }
  return covered / subset.size
}

function normalizedStem(path: string): string {
  let stem = basenameWithoutExt(path)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')

  for (const pattern of STEM_NORMALIZE_PATTERNS) {
    stem = stem.replace(pattern, ' ')
  }

  return tokenize(stem).join(' ')
}

function duplicateNoiseScore(path: string): number {
  const raw = basenameWithoutExt(path)
  return DUPLICATE_NOISE_PATTERNS.reduce((score, pattern) => {
    const matches = raw.match(pattern)
    return score + (matches?.length || 0)
  }, 0)
}

export function isClutterLikeFilename(path: string): boolean {
  return duplicateNoiseScore(path) > 0
}

function versionQuality(path: string): { score: number; reason?: DuplicatePreferenceReason } {
  const raw = basenameWithoutExt(path).toLowerCase()
  const hasDraft = /\bdraft\b/.test(raw)
  const hasFinal = /\bfinal\b/.test(raw)
  const hasCopy = /\bcopy\b/.test(raw)

  if (hasDraft && !hasFinal) {
    return { score: -2, reason: 'non-draft' }
  }
  if (hasFinal && !hasDraft && !hasCopy) {
    return { score: 1, reason: 'final-version' }
  }
  return { score: 0 }
}

function draftState(path: string): 'draft' | 'final' | 'plain' {
  const raw = basenameWithoutExt(path).toLowerCase()
  if (/\bdraft\b/.test(raw)) return 'draft'
  if (/\bfinal\b/.test(raw)) return 'final'
  return 'plain'
}

function structuredPathScore(path: string): number {
  const parts = path.split('/').filter(Boolean)
  const folderDepth = Math.max(0, parts.length - 1)
  return Math.min(folderDepth, 4)
}

function parseModifiedAt(value?: string): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function pickPreferredTarget(
  current: DuplicateCandidateEntry,
  candidate: DuplicateCandidateEntry,
): { preferred: DuplicateCandidateEntry; preferenceReason: DuplicatePreferenceReason } {
  const currentDraftState = draftState(current.path)
  const candidateDraftState = draftState(candidate.path)
  if (currentDraftState !== candidateDraftState) {
    if (currentDraftState === 'draft' && candidateDraftState === 'final') {
      return { preferred: candidate, preferenceReason: 'final-version' }
    }
    if (candidateDraftState === 'draft' && currentDraftState === 'final') {
      return { preferred: current, preferenceReason: 'final-version' }
    }
    if (currentDraftState === 'draft') {
      return { preferred: candidate, preferenceReason: 'non-draft' }
    }
    if (candidateDraftState === 'draft') {
      return { preferred: current, preferenceReason: 'non-draft' }
    }
  }

  const currentNoise = duplicateNoiseScore(current.path)
  const candidateNoise = duplicateNoiseScore(candidate.path)
  if (currentNoise !== candidateNoise) {
    return {
      preferred: currentNoise < candidateNoise ? current : candidate,
      preferenceReason: 'cleaner-canonical',
    }
  }

  const currentStructure = structuredPathScore(current.path)
  const candidateStructure = structuredPathScore(candidate.path)
  if (currentStructure !== candidateStructure) {
    return {
      preferred: currentStructure > candidateStructure ? current : candidate,
      preferenceReason: 'better-organized',
    }
  }

  const currentVersion = versionQuality(current.path)
  const candidateVersion = versionQuality(candidate.path)
  if (currentVersion.score !== candidateVersion.score) {
    return {
      preferred: currentVersion.score > candidateVersion.score ? current : candidate,
      preferenceReason: currentVersion.score > candidateVersion.score
        ? (currentVersion.reason || 'shorter-path')
        : (candidateVersion.reason || 'shorter-path'),
    }
  }

  const currentModified = parseModifiedAt(current.modifiedAt)
  const candidateModified = parseModifiedAt(candidate.modifiedAt)
  if (currentModified !== null && candidateModified !== null && currentModified !== candidateModified) {
    return {
      preferred: currentModified >= candidateModified ? current : candidate,
      preferenceReason: 'newer-copy',
    }
  }

  return {
    preferred: candidate.path.length <= current.path.length ? candidate : current,
    preferenceReason: 'shorter-path',
  }
}

function duplicateReason(base: 'Exact duplicate of' | 'Probable duplicate revision of', targetPath: string, preferenceReason: DuplicatePreferenceReason): string {
  if (preferenceReason === 'cleaner-canonical') {
    return `${base} cleaner canonical file ${targetPath}`
  }
  if (preferenceReason === 'better-organized') {
    return `${base} better organized file ${targetPath}`
  }
  if (preferenceReason === 'final-version') {
    return `${base} final version ${targetPath}`
  }
  if (preferenceReason === 'non-draft') {
    return `${base} non-draft file ${targetPath}`
  }
  if (preferenceReason === 'newer-copy') {
    return `${base} newer copy ${targetPath}`
  }
  return `${base} ${targetPath}`
}

function supersededReason(targetPath: string, preferenceReason: DuplicatePreferenceReason): string {
  if (preferenceReason === 'final-version') {
    return `Superseded by final version ${targetPath}`
  }
  if (preferenceReason === 'non-draft') {
    return `Superseded by non-draft file ${targetPath}`
  }
  if (preferenceReason === 'cleaner-canonical') {
    return `Superseded by cleaner canonical file ${targetPath}`
  }
  if (preferenceReason === 'newer-copy') {
    return `Superseded by newer copy ${targetPath}`
  }
  if (preferenceReason === 'better-organized') {
    return `Superseded by better organized file ${targetPath}`
  }
  return `Superseded by ${targetPath}`
}

function shouldDeleteSupersededNearDuplicate(
  weakerContent: string,
  strongerContent: string,
  similarity: number,
  lengthRatio: number,
  preferenceReason: DuplicatePreferenceReason,
): boolean {
  if (!['cleaner-canonical', 'final-version', 'non-draft', 'newer-copy', 'better-organized'].includes(preferenceReason)) {
    return false
  }
  const weakerTrimmed = weakerContent.trim()
  const strongerTrimmed = strongerContent.trim()
  if (!weakerTrimmed || !strongerTrimmed) return false
  const coverage = tokenCoverage(weakerTrimmed, strongerTrimmed)
  const strongerContainsWeaker = strongerTrimmed.includes(weakerTrimmed)
  return similarity >= 0.78 && lengthRatio >= 0.72 && (coverage >= 0.88 || strongerContainsWeaker)
}

function rolesCompatible(a?: FileRole, b?: FileRole): boolean {
  if (!a || !b) return true
  if (a === b) return true
  const documentish = new Set<FileRole>(['text-note', 'guide', 'proposal', 'general-document'])
  return documentish.has(a) && documentish.has(b)
}

export function normalizeContentForDuplicateDetection(content: string): string {
  return normalizeWhitespace(content)
}

export function detectDuplicateCandidate(
  current: DuplicateCandidateEntry,
  previousCandidates: DuplicateCandidateEntry[],
): DuplicateDetectionResult {
  const normalizedCurrent = normalizeContentForDuplicateDetection(current.content)
  if (normalizedCurrent.length < 20) {
    return { kind: 'none' }
  }

  const currentStem = normalizedStem(current.path)
  const currentParent = current.path.split('/').slice(0, -1).join('/').toLowerCase()

  for (const candidate of previousCandidates) {
    if (!rolesCompatible(current.fileRole, candidate.fileRole)) continue

    const normalizedCandidate = normalizeContentForDuplicateDetection(candidate.content)
    if (normalizedCandidate.length < 20) continue

    if (normalizedCandidate === normalizedCurrent) {
      const { preferred, preferenceReason } = pickPreferredTarget(current, candidate)
      const targetPath = preferred.path
      if (targetPath === current.path) {
        return { kind: 'none' }
      }
      return {
        kind: 'exact-delete',
        targetPath,
        reason: duplicateReason('Exact duplicate of', targetPath, preferenceReason),
      }
    }

    const candidateStem = normalizedStem(candidate.path)
    if (!currentStem || !candidateStem || currentStem !== candidateStem) continue

    const similarity = tokenJaccard(normalizedCurrent, normalizedCandidate)
    const shortLength = Math.min(normalizedCurrent.length, normalizedCandidate.length)
    const longLength = Math.max(normalizedCurrent.length, normalizedCandidate.length)
    const lengthRatio = shortLength / Math.max(1, longLength)
    const candidateParent = candidate.path.split('/').slice(0, -1).join('/').toLowerCase()
    const sameParent = candidateParent === currentParent
    const noisyCurrent = duplicateNoiseScore(current.path) > 0
    const noisyCandidate = duplicateNoiseScore(candidate.path) > 0
    const similarityThreshold = sameParent && (noisyCurrent || noisyCandidate) ? 0.55 : 0.74

    if (similarity >= similarityThreshold && lengthRatio >= 0.72 && (sameParent || noisyCurrent || noisyCandidate)) {
      const { preferred, preferenceReason } = pickPreferredTarget(current, candidate)
      const targetPath = preferred.path
      if (targetPath === current.path) {
        return { kind: 'none' }
      }
      const weaker = preferred.path === current.path ? candidate : current
      const stronger = preferred.path === current.path ? current : candidate
      if (preferred.path !== current.path && shouldDeleteSupersededNearDuplicate(
        normalizeContentForDuplicateDetection(weaker.content),
        normalizeContentForDuplicateDetection(stronger.content),
        similarity,
        lengthRatio,
        preferenceReason,
      )) {
        return {
          kind: 'superseded-delete',
          targetPath,
          reason: supersededReason(targetPath, preferenceReason),
        }
      }
      return {
        kind: 'merge-recommended',
        targetPath,
        reason: duplicateReason('Probable duplicate revision of', targetPath, preferenceReason),
      }
    }
  }

  return { kind: 'none' }
}
