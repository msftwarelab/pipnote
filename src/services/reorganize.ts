import { vaultService, type TreeNode } from './vault'
import { localAiService } from './localAi'
import {
  determineMoveSuggestionLevel,
  inferSuggestedRelativePathFromSource,
  looksUncategorized,
  normalizeReorgPathSegment,
  normalizeSuggestedRelativePath,
} from '../utils/reorganizePathing'
import {
  explainFolderFitDelta,
  shouldMoveFromDecision,
  targetParentKey,
  tokenizeForReorgLearning,
  topLevelMoveKey,
} from '../utils/reorganizeDecision'
import {
  applyReorganizationStrategy,
  type ReorganizationStrategy,
} from '../utils/reorganizeStrategy'
import { recordPerfMetric, startPerfTimer } from '../utils/perfMetrics'
import { computeContentHash } from '../utils/contentHash'
import { isReorganizationEligiblePath, normalizeNotePath } from '../utils/noteScope'
import { activityMonitorService } from './activityMonitor'
import { needsProfessionalTitleCleanup } from '../utils/titleNaming'
import { detectDuplicateCandidate, type DuplicateCandidateEntry } from '../utils/duplicateCleanup'
import { detectShallowClutterFolder } from '../utils/clutterFolders'
import { isHeuristicFallbackReason } from '../utils/reorgModelGuard'
import { determineReorgOutcome, shouldSurfaceReviewSuggestion } from '../utils/reorgOutcome'
import {
  analyzeAIReadableFile,
  analyzePreviewOnlyImageFile,
  type ExtractionQuality,
  type FileIntelligence,
  type FileRole,
  type VisualAnalysisMode,
  type VisualAssetKind,
  isPreviewOnlyImagePath,
} from '../utils/fileIntelligence'

export interface ReorganizationOperationReviewContext {
  aiReadableKind?: 'text' | 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'csv' | 'image'
  extractionQuality?: ExtractionQuality
  qualityReason?: string
  fileRole?: FileRole
  visualKind?: VisualAssetKind
  visualAnalysisMode?: VisualAnalysisMode
  conservativeReorganization?: boolean
  validationPassed?: boolean
  validationKind?: 'move' | 'duplicate' | 'review'
}

export interface ReorganizationOperation {
  type: 'move' | 'delete' | 'merge' | 'structural'
  suggestionLevel: 'strong' | 'recommended' | 'optional'
  sourcePath: string
  targetPath?: string
  reason: string
  issueType?: 'nestedFolders' | 'repeatedExtension' | 'emptyFolder' | 'redundantFolder' | 'orphanedFile' | 'inconsistentNaming'
  reviewContext?: ReorganizationOperationReviewContext
}

export interface ReorganizationPlan {
  operations: ReorganizationOperation[]
  summary: {
    totalNotes: number
    toMove: number
    toDelete: number
    toMerge: number
    structuralIssues: number
  }
}

export interface ReorganizationExecutionOptions {
  confirmExecution?: boolean
  softDelete?: boolean
  createUndoLog?: boolean
}

export interface ReorganizationAnalyzeOptions {
  shouldCancel?: () => boolean
  strategy?: ReorganizationStrategy
}

export interface ReorganizeService {
  analyzeVault: (
    onProgress?: (current: number, total: number) => void,
    options?: ReorganizationAnalyzeOptions,
  ) => Promise<ReorganizationPlan>
  executeReorganization: (
    plan: ReorganizationPlan,
    onProgress?: (current: number, total: number) => void,
    options?: ReorganizationExecutionOptions
  ) => Promise<void>
  rememberReviewDecisions: (
    approvedOperations: ReorganizationOperation[],
    deniedOperations: ReorganizationOperation[],
  ) => Promise<void>
}

interface UndoEntry {
  operation: string
  sourcePath: string
  targetPath?: string
  backupPath?: string
  trashPath?: string
  reason: string
}

interface ExecutionFailure {
  path: string
  operation: string
  message: string
}

interface ReorganizationAnalysisResult {
  shouldKeep: boolean
  suggestedPath: string
  suggestedTitle: string
  isDuplicate: boolean
  duplicateOf?: string
  reason: string
}

interface ReorgAnalysisCacheEntry {
  contentHash: string
  model: string
  updatedAt: string
  result: ReorganizationAnalysisResult
}

interface ReorgAnalysisCacheStore {
  version: 1
  entries: Record<string, ReorgAnalysisCacheEntry>
}

interface VaultTaxonomyProfile {
  topLevels: Set<string>
  subpathsByTopLevel: Map<string, Set<string>>
}

interface VaultFileEntry {
  path: string
  modifiedAt?: string
}

interface ReorgPreferenceStore {
  version: 1
  acceptedTopLevelMoves: Record<string, number>
  deniedTopLevelMoves: Record<string, number>
  acceptedTargetParents: Record<string, number>
  deniedTargetParents: Record<string, number>
  acceptedTokenParents: Record<string, Record<string, number>>
}

const TRASH_ROOT = 'Trash'
const UNDO_LOG_ROOT = '.vn-system/reorg-undo'
const REORG_ANALYSIS_CACHE_PATH = '.vn-system/reorg-analysis-cache.json'
const REORG_PREFERENCES_PATH = '.vn-system/reorg-preferences.json'
const REORG_ANALYSIS_CACHE_VERSION = 1 as const
const REORG_PREFERENCES_VERSION = 1 as const
const IGNORED_FILE_NAMES = new Set(['index.json', 'embeddings.json'])
const IGNORED_PATH_PREFIXES = ['Trash/', 'Recovered/', '.vn-system/']
const IGNORED_FILE_EXTENSIONS = new Set(['base'])
const ANALYSIS_UI_YIELD_EVERY_VISIBLE = 4
const ANALYSIS_UI_YIELD_EVERY_HIDDEN = 14
const ANALYSIS_NOTES_LARGE = 400
const ANALYSIS_NOTES_HUGE = 1_000
const ANALYSIS_UI_YIELD_EVERY_VISIBLE_LARGE = 6
const ANALYSIS_UI_YIELD_EVERY_VISIBLE_HUGE = 9
const ANALYSIS_UI_YIELD_EVERY_HIDDEN_LARGE = 18
const ANALYSIS_UI_YIELD_EVERY_HIDDEN_HUGE = 24

function buildReviewContext(
  fileIntel: FileIntelligence,
  validationKind?: ReorganizationOperationReviewContext['validationKind'],
): ReorganizationOperationReviewContext {
  return {
    aiReadableKind: fileIntel.kind,
    extractionQuality: fileIntel.extractionQuality,
    qualityReason: fileIntel.qualityReason,
    fileRole: fileIntel.fileRole,
    visualKind: fileIntel.visualKind,
    visualAnalysisMode: fileIntel.visualAnalysisMode,
    conservativeReorganization: fileIntel.conservativeReorganization,
    validationPassed: !!validationKind,
    validationKind,
  }
}

async function yieldToUiIfNeeded(index: number, totalNotes: number): Promise<void> {
  const noteIndex = index + 1
  if (typeof window === 'undefined') return
  const visible = typeof document !== 'undefined' ? document.visibilityState === 'visible' : true
  const baseEvery = visible
    ? totalNotes >= ANALYSIS_NOTES_HUGE
      ? ANALYSIS_UI_YIELD_EVERY_VISIBLE_HUGE
      : totalNotes >= ANALYSIS_NOTES_LARGE
        ? ANALYSIS_UI_YIELD_EVERY_VISIBLE_LARGE
        : ANALYSIS_UI_YIELD_EVERY_VISIBLE
    : totalNotes >= ANALYSIS_NOTES_HUGE
      ? ANALYSIS_UI_YIELD_EVERY_HIDDEN_HUGE
      : totalNotes >= ANALYSIS_NOTES_LARGE
        ? ANALYSIS_UI_YIELD_EVERY_HIDDEN_LARGE
        : ANALYSIS_UI_YIELD_EVERY_HIDDEN
  const activity = activityMonitorService.getSnapshot()
  const typingPressure = activity.pressure
  const every = typingPressure === 'high'
    ? 1
    : typingPressure === 'medium'
      ? Math.max(2, Math.floor(baseEvery / 2))
      : typingPressure === 'low'
        ? Math.max(3, baseEvery - 1)
        : baseEvery
  if (noteIndex % every !== 0) return

  await new Promise<void>((resolve) => {
    if (visible && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve())
      return
    }
    window.setTimeout(() => resolve(), 0)
  })

  if (visible && typingPressure === 'high') {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 8))
  } else if (visible && typingPressure === 'medium') {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 4))
  }
}

async function requireOllamaFor(operation: string): Promise<void> {
  const healthy = await localAiService.checkHealth()
  if (healthy) return
  const reason = localAiService.getHealthError() || `Cannot complete "${operation}" because the selected local AI provider is unavailable.`
  throw new Error(`${reason} Start your selected local AI provider and verify selected models in Settings.`)
}

function stampNow(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function safePathPart(part: string): string {
  return part.replace(/[^a-zA-Z0-9._-]/g, '-')
}

function shouldSkipAnalysis(path: string): boolean {
  const normalized = normalizeNotePath(path).replace(/^notes\//i, '')
  const fileName = normalized.split('/').pop() || normalized
  if (IGNORED_FILE_NAMES.has(fileName)) return true
  const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() || '' : ''
  if (IGNORED_FILE_EXTENSIONS.has(ext)) return true
  return IGNORED_PATH_PREFIXES.some(prefix => normalized.startsWith(prefix.replace(/^notes\//i, '')))
}

function normalizeCachePath(path: string): string {
  return normalizeNotePath(path)
}

function normalizeModelId(model: string): string {
  return model.trim().toLowerCase().replace(/@sha256:[a-f0-9]+$/i, '')
}

function modelMatchesCache(requestedModel: string, cachedModel: string): boolean {
  const requested = normalizeModelId(requestedModel)
  const cached = normalizeModelId(cachedModel)
  if (!requested || !cached) return false
  if (requested === cached) return true
  if (!requested.includes(':')) {
    return cached === requested || cached.startsWith(`${requested}:`)
  }
  return cached.startsWith(`${requested}:`)
}

function buildEmptyAnalysisCache(): ReorgAnalysisCacheStore {
  return { version: REORG_ANALYSIS_CACHE_VERSION, entries: {} }
}

function parseAnalysisCache(raw: string): ReorgAnalysisCacheStore | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ReorgAnalysisCacheStore>
    if (parsed.version !== REORG_ANALYSIS_CACHE_VERSION) return null
    const entries = parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {}
    return {
      version: REORG_ANALYSIS_CACHE_VERSION,
      entries,
    }
  } catch {
    return null
  }
}

async function loadAnalysisCache(): Promise<ReorgAnalysisCacheStore> {
  try {
    const raw = await vaultService.readFile(REORG_ANALYSIS_CACHE_PATH)
    return parseAnalysisCache(raw) || buildEmptyAnalysisCache()
  } catch {
    return buildEmptyAnalysisCache()
  }
}

async function persistAnalysisCache(cache: ReorgAnalysisCacheStore): Promise<void> {
  await vaultService.writeFile(REORG_ANALYSIS_CACHE_PATH, JSON.stringify(cache))
}

function currentRelativePath(path: string): string {
  return normalizeCachePath(path).replace(/^notes\//i, '')
}

function basenameWithoutExt(path: string): string {
  const base = path.split('/').pop() || 'Note'
  const stem = base.replace(/\.[^/.]+$/, '')
  return normalizeReorgPathSegment(stem) || 'Note'
}

function extensionWithDot(path: string): string {
  const base = path.split('/').pop() || path
  const idx = base.lastIndexOf('.')
  return idx > 0 ? base.slice(idx) : ''
}

function hasGenericTitle(path: string): boolean {
  const title = basenameWithoutExt(path).toLowerCase()
  return title === 'untitled'
    || title === 'note'
    || title === 'new note'
    || title.startsWith('untitled ')
    || title.startsWith('note ')
}

function looksLikeMessyGeneratedTitle(path: string): boolean {
  return needsProfessionalTitleCleanup(basenameWithoutExt(path))
}

function buildRenamedPathKeepingFolder(currentRelative: string, suggestedTitle: string): string {
  const parts = currentRelative.split('/').filter(Boolean)
  const ext = extensionWithDot(currentRelative)
  const cleanedTitle = normalizeReorgPathSegment(suggestedTitle).replace(/\.[^/.]+$/, '').trim() || 'Note'
  if (parts.length === 0) {
    return `${cleanedTitle}${ext}`
  }
  parts[parts.length - 1] = `${cleanedTitle}${ext}`
  return parts.join('/')
}

function isStructuredEnough(path: string): boolean {
  const relative = currentRelativePath(path)
  const parts = relative.split('/').filter(Boolean)
  if (parts.length < 2) return false
  if (looksUncategorized(relative)) return false
  return parts.length >= 3 || !hasGenericTitle(relative)
}

function buildVaultTaxonomyProfile(paths: string[]): VaultTaxonomyProfile {
  const topLevels = new Set<string>()
  const subpathsByTopLevel = new Map<string, Set<string>>()

  for (const path of paths) {
    const relative = currentRelativePath(path)
    if (!isStructuredEnough(relative)) continue
    const parts = relative.split('/').filter(Boolean)
    const topLevel = parts[0]
    if (!topLevel) continue
    topLevels.add(topLevel.toLowerCase())
    const existing = subpathsByTopLevel.get(topLevel.toLowerCase()) || new Set<string>()
    if (parts.length >= 3) {
      existing.add(parts.slice(0, -1).join('/').toLowerCase())
    }
    subpathsByTopLevel.set(topLevel.toLowerCase(), existing)
  }

  return { topLevels, subpathsByTopLevel }
}

function buildEmptyPreferenceStore(): ReorgPreferenceStore {
  return {
    version: REORG_PREFERENCES_VERSION,
    acceptedTopLevelMoves: {},
    deniedTopLevelMoves: {},
    acceptedTargetParents: {},
    deniedTargetParents: {},
    acceptedTokenParents: {},
  }
}

function parsePreferenceStore(raw: string): ReorgPreferenceStore | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ReorgPreferenceStore>
    if (parsed.version !== REORG_PREFERENCES_VERSION) return null
    return {
      version: REORG_PREFERENCES_VERSION,
      acceptedTopLevelMoves: parsed.acceptedTopLevelMoves || {},
      deniedTopLevelMoves: parsed.deniedTopLevelMoves || {},
      acceptedTargetParents: parsed.acceptedTargetParents || {},
      deniedTargetParents: parsed.deniedTargetParents || {},
      acceptedTokenParents: parsed.acceptedTokenParents || {},
    }
  } catch {
    return null
  }
}

async function loadPreferenceStore(): Promise<ReorgPreferenceStore> {
  try {
    const raw = await vaultService.readFile(REORG_PREFERENCES_PATH)
    return parsePreferenceStore(raw) || buildEmptyPreferenceStore()
  } catch {
    return buildEmptyPreferenceStore()
  }
}

async function persistPreferenceStore(store: ReorgPreferenceStore): Promise<void> {
  await vaultService.writeFile(REORG_PREFERENCES_PATH, JSON.stringify(store, null, 2))
}

function incrementCounter(record: Record<string, number>, key: string): void {
  if (!key) return
  record[key] = (record[key] || 0) + 1
}

function incrementNestedCounter(record: Record<string, Record<string, number>>, outerKey: string, innerKey: string): void {
  if (!outerKey || !innerKey) return
  record[outerKey] = record[outerKey] || {}
  record[outerKey][innerKey] = (record[outerKey][innerKey] || 0) + 1
}

function applyLearnedTargetParent(
  sourcePath: string,
  suggestedRelative: string,
  preferences: ReorgPreferenceStore,
  taxonomy: VaultTaxonomyProfile,
): string {
  const tokens = tokenizeForReorgLearning(sourcePath.split('/').pop() || sourcePath)
  if (tokens.length === 0) return suggestedRelative

  const candidateScores = new Map<string, number>()
  for (const token of tokens) {
    const learnedParents = preferences.acceptedTokenParents[token]
    if (!learnedParents) continue
    for (const [parent, count] of Object.entries(learnedParents)) {
      candidateScores.set(parent, (candidateScores.get(parent) || 0) + count)
    }
  }

  if (candidateScores.size === 0) return suggestedRelative

  const rankedCandidates = Array.from(candidateScores.entries())
    .sort((a, b) => b[1] - a[1])
  const [bestParent, bestScore] = rankedCandidates[0]
  if (!bestParent || bestScore < 2) return suggestedRelative

  const suggestedParts = suggestedRelative.split('/').filter(Boolean)
  const fileName = suggestedParts[suggestedParts.length - 1]
  if (!fileName) return suggestedRelative

  const bestTop = bestParent.split('/')[0]?.toLowerCase() || ''
  if (taxonomy.topLevels.size > 0 && bestTop && !taxonomy.topLevels.has(bestTop)) {
    return suggestedRelative
  }

  return `${bestParent}/${fileName}`
}

function explainMoveReason(
  currentRelative: string,
  targetRelative: string,
  baseReason: string,
  taxonomy: VaultTaxonomyProfile,
  preferences: ReorgPreferenceStore,
): string {
  const explanationBits: string[] = []
  const currentParts = currentRelative.split('/').filter(Boolean)
  const targetParts = targetRelative.split('/').filter(Boolean)
  const currentTop = currentParts[0]?.toLowerCase() || ''
  const targetTop = targetParts[0]?.toLowerCase() || ''
  const targetParent = targetParentKey(targetRelative)
  const topLevelKey = topLevelMoveKey(currentRelative, targetRelative)
  const tokens = tokenizeForReorgLearning(currentParts[currentParts.length - 1] || currentRelative)

  if (looksUncategorized(currentRelative)) {
    explanationBits.push('root or uncategorized note')
  }

  if (targetTop && taxonomy.topLevels.has(targetTop)) {
    explanationBits.push('matches existing vault category structure')
  }

  if (currentTop && targetTop && currentTop !== targetTop) {
    const acceptedTop = preferences.acceptedTopLevelMoves[topLevelKey] || 0
    if (acceptedTop > 0) {
      explanationBits.push(`similar top-level move approved ${acceptedTop} time${acceptedTop === 1 ? '' : 's'}`)
    }
  }

  const acceptedParent = preferences.acceptedTargetParents[targetParent] || 0
  if (acceptedParent > 0) {
    explanationBits.push(`target folder approved ${acceptedParent} time${acceptedParent === 1 ? '' : 's'}`)
  }

  const tokenMatches = tokens
    .map((token) => ({
      token,
      count: preferences.acceptedTokenParents[token]?.[targetParent] || 0,
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 2)

  if (tokenMatches.length > 0) {
    const tokenText = tokenMatches
      .map((entry) => `${entry.token} (${entry.count})`)
      .join(', ')
    explanationBits.push(`similar approved note patterns: ${tokenText}`)
  }

  const fitExplanation = explainFolderFitDelta(currentRelative, targetRelative, taxonomy, preferences)
  if (fitExplanation) {
    explanationBits.push(fitExplanation)
  }

  if (explanationBits.length === 0 && determineMoveSuggestionLevel(currentRelative, targetRelative) === 'optional') {
    explanationBits.push('low-confidence refinement')
  }

  if (explanationBits.length === 0) {
    return baseReason
  }

  return `${baseReason} (${explanationBits.join(' • ')})`
}

function alignSuggestedPathToTaxonomy(
  currentRelative: string,
  suggestedRelative: string,
  taxonomy: VaultTaxonomyProfile,
): string {
  const currentParts = currentRelative.split('/').filter(Boolean)
  const suggestedParts = suggestedRelative.split('/').filter(Boolean)
  const currentTop = currentParts[0]?.toLowerCase() || ''
  const suggestedTop = suggestedParts[0]?.toLowerCase() || ''

  if (!suggestedTop) return currentRelative
  if (taxonomy.topLevels.size === 0) return suggestedRelative
  if (taxonomy.topLevels.has(suggestedTop)) return suggestedRelative

  if (isStructuredEnough(currentRelative) && currentTop && taxonomy.topLevels.has(currentTop)) {
    return currentRelative
  }

  return suggestedRelative
}

function shouldRunLlmAnalysis(path: string, content: string): boolean {
  const relative = currentRelativePath(path)
  if (looksUncategorized(relative)) return true
  if (hasGenericTitle(relative)) return true
  if (relative.split('/').length <= 1) return true
  const trimmedLength = content.trim().length
  if (trimmedLength >= 1800) return true
  if (trimmedLength >= 700 && /(^|\n)#\s+/.test(content)) return true
  return false
}

function buildHeuristicAnalysis(path: string): ReorganizationAnalysisResult {
  const relative = currentRelativePath(path)
  const inferred = inferSuggestedRelativePathFromSource(relative) || relative
  const suggestedRelative = normalizeSuggestedRelativePath(inferred, relative)
  return {
    shouldKeep: true,
    suggestedPath: suggestedRelative,
    suggestedTitle: basenameWithoutExt(relative),
    isDuplicate: false,
    reason: suggestedRelative === relative
      ? 'Heuristic pass: path already looks organized'
      : 'Heuristic pass: moved from uncategorized/generic location',
  }
}

function getAllFileEntries(nodes: TreeNode[]): VaultFileEntry[] {
  const entries: VaultFileEntry[] = []

  function walk(items: TreeNode[]) {
    items.forEach(item => {
      if (item.type === 'file') {
        entries.push({
          path: item.path,
          modifiedAt: item.modifiedAt,
        })
      } else if (item.type === 'folder') {
        walk(item.children)
      }
    })
  }

  walk(nodes)
  return entries
}

async function backupFileForUndo(sourcePath: string, runId: string): Promise<string | null> {
  try {
    const content = await vaultService.readFile(sourcePath)
    const fileName = sourcePath.split('/').pop() || 'note.md'
    const backupPath = `${UNDO_LOG_ROOT}/${runId}/files/${Date.now()}-${safePathPart(fileName)}`
    const writtenPath = await vaultService.writeFile(backupPath, content)
    return writtenPath
  } catch {
    // Most likely a folder path (or missing file); skip file backup.
    return null
  }
}

async function moveToTrash(sourcePath: string, runId: string): Promise<string | null> {
  try {
    const content = await vaultService.readFile(sourcePath)
    const fileName = sourcePath.split('/').pop() || 'note.md'
    const trashPath = `${TRASH_ROOT}/${runId}/${safePathPart(fileName)}`
    const writtenPath = await vaultService.writeFile(trashPath, content)
    await vaultService.deletePath(sourcePath)
    return writtenPath
  } catch {
    // Folders can still be deleted if they are empty/redundant.
    await vaultService.deletePath(sourcePath)
    return null
  }
}

export const reorganizeService: ReorganizeService = {
  async analyzeVault(onProgress, options) {
    console.log('🔍 Starting vault analysis...')
    const perfStart = startPerfTimer()
    const strategy = options?.strategy ?? 'meaning'
    let totalNotes = 0
    let operationCount = 0
    let llmCalls = 0
    let cacheHits = 0
    let heuristicOnly = 0
    await requireOllamaFor('Reorganize vault')
    const selectedTextModel = localAiService.getSettings().textModel

    try {
      const analysisCache = await loadAnalysisCache()
      let cacheDirty = false
      // Get all notes
      const tree = await vaultService.getVaultTree()
      const allEntries = getAllFileEntries(tree).filter((entry) => {
        const path = entry.path
        if (shouldSkipAnalysis(path)) return false
        return isReorganizationEligiblePath(path)
      })
      const allPaths = allEntries.map((entry) => entry.path)
      const modifiedAtByPath = new Map(allEntries.map((entry) => [normalizeCachePath(entry.path), entry.modifiedAt]))
      const taxonomy = buildVaultTaxonomyProfile(allPaths)
      const preferences = await loadPreferenceStore()
      totalNotes = allPaths.length
      const activePathSet = new Set(allPaths.map((path) => normalizeCachePath(path)))
      Object.keys(analysisCache.entries).forEach((cachedPath) => {
        if (!activePathSet.has(normalizeCachePath(cachedPath))) {
          delete analysisCache.entries[cachedPath]
          cacheDirty = true
        }
      })

      const operations: ReorganizationPlan['operations'] = []
      const seenDuplicateCandidates: DuplicateCandidateEntry[] = []
      const structurallyHandledPaths = new Set<string>()

      // --- Structural analysis ---
      // 1. Find nested folders with the same name (e.g., notes/notes/notes)
      function walkFolders(nodes: TreeNode[], parentPath = '') {
        nodes.forEach(node => {
          if (node.type === 'folder') {
            const fullPath = parentPath ? `${parentPath}/${node.name}` : node.name
            // Check for repeated folder names in the path
            const pathParts = fullPath.split('/')
            const nameCounts = pathParts.reduce((acc, part) => {
              acc[part] = (acc[part] || 0) + 1
              return acc
            }, {} as Record<string, number>)
            if (nameCounts[node.name] > 1) {
              operations.push({
                type: 'structural',
                suggestionLevel: 'recommended',
                sourcePath: fullPath,
                reason: `Nested/repeated folder name: '${node.name}' appears multiple times in path`,
                issueType: 'nestedFolders',
              })
            }
            // Check for empty folders
            if (!node.children || node.children.length === 0) {
              operations.push({
                type: 'delete',
                suggestionLevel: 'strong',
                sourcePath: fullPath,
                reason: `Delete empty folder: '${fullPath}'`,
                issueType: 'emptyFolder',
              })
            }
            const childFiles = (node.children || []).filter((child) => child.type === 'file').map((child) => child.path)
            const childFolders = (node.children || []).filter((child) => child.type === 'folder').map((child) => child.path)
            const clutterCandidate = detectShallowClutterFolder(fullPath, childFiles, childFolders)
            if (clutterCandidate) {
              clutterCandidate.filePaths.forEach((filePath) => {
                const targetPath = `${clutterCandidate.targetFolder}/${filePath.split('/').pop() || 'File'}`
                operations.push({
                  type: 'move',
                  suggestionLevel: 'recommended',
                  sourcePath: filePath,
                  targetPath,
                  reason: `${clutterCandidate.reason} (flatten noisy copy/export container)`,
                })
                structurallyHandledPaths.add(normalizeCachePath(filePath))
              })
            }
            walkFolders(node.children, fullPath)
          }
        })
      }
      walkFolders(tree)

      // 2. Find files with repeated .md extensions
      allPaths.forEach(path => {
        if (/\.md(\.md)+$/i.test(path)) {
          operations.push({
            type: 'structural',
            suggestionLevel: 'recommended',
            sourcePath: path,
            reason: `File has repeated .md extensions`,
            issueType: 'repeatedExtension',
          })
        }
      })

      // Analyze each note
      for (let i = 0; i < allPaths.length; i++) {
        await yieldToUiIfNeeded(i, allPaths.length)
        if (options?.shouldCancel?.()) {
          throw new Error('Reorganization analysis cancelled')
        }

        const path = allPaths[i]
        if (structurallyHandledPaths.has(normalizeCachePath(path))) {
          continue
        }
        // Set global variable for UI display
        if (typeof window !== 'undefined') {
          ;(window as Window & { __vnAnalyzingFileName?: string }).__vnAnalyzingFileName = path.split('/').pop()
        }
        if (onProgress) {
          onProgress(i + 1, allPaths.length)
        }

        try {
          const isVisualAsset = isPreviewOnlyImagePath(path)
          let fileIntel: FileIntelligence
          let content: string
          if (isVisualAsset) {
            try {
              const readable = await vaultService.readFileForAI(path)
              fileIntel = analyzeAIReadableFile(path, readable)
              content = readable.content
            } catch {
              fileIntel = analyzePreviewOnlyImageFile(path)
              content = `Visual asset path: ${path}\nThis image could not be read through OCR, so Pipnote is using filename and folder context only.`
            }
          } else {
            const readable = await vaultService.readFileForAI(path)
            fileIntel = analyzeAIReadableFile(path, readable)
            content = readable.content
          }
          if (options?.shouldCancel?.()) {
            throw new Error('Reorganization analysis cancelled')
          }
          const contentHash = computeContentHash(`${fileIntel.kind}:${content}`).toLowerCase()
          const pathKey = normalizeCachePath(path)
          const duplicateCandidate = detectDuplicateCandidate(
            {
              path,
              content,
              fileRole: fileIntel.fileRole,
              modifiedAt: modifiedAtByPath.get(pathKey),
            },
            seenDuplicateCandidates,
          )
          if (duplicateCandidate.kind === 'exact-delete' && duplicateCandidate.targetPath) {
            console.log(`⚠️ Exact duplicate detected: ${path} duplicates ${duplicateCandidate.targetPath}`)
            operations.push({
              type: 'delete',
              suggestionLevel: 'strong',
              sourcePath: path,
              reason: duplicateCandidate.reason || `Exact duplicate of ${duplicateCandidate.targetPath}`,
              reviewContext: buildReviewContext(fileIntel),
            })
            continue
          }
          if (duplicateCandidate.kind === 'superseded-delete' && duplicateCandidate.targetPath) {
            console.log(`⚠️ Superseded near-duplicate detected: ${path} is covered by ${duplicateCandidate.targetPath}`)
            operations.push({
              type: 'delete',
              suggestionLevel: 'recommended',
              sourcePath: path,
              reason: duplicateCandidate.reason || `Superseded by ${duplicateCandidate.targetPath}`,
              reviewContext: buildReviewContext(fileIntel),
            })
            continue
          }
          if (duplicateCandidate.kind === 'merge-recommended' && duplicateCandidate.targetPath) {
            console.log(`⚠️ Near duplicate detected: ${path} likely overlaps ${duplicateCandidate.targetPath}`)
            operations.push({
              type: 'merge',
              suggestionLevel: 'recommended',
              sourcePath: path,
              targetPath: duplicateCandidate.targetPath,
              reason: duplicateCandidate.reason || `Probable duplicate revision of ${duplicateCandidate.targetPath}`,
              reviewContext: buildReviewContext(fileIntel),
            })
            continue
          }
          seenDuplicateCandidates.push({
            path,
            content,
            fileRole: fileIntel.fileRole,
            modifiedAt: modifiedAtByPath.get(pathKey),
          })

          const cached = analysisCache.entries[pathKey]
          let analysis: ReorganizationAnalysisResult

          if (cached && cached.contentHash === contentHash && modelMatchesCache(selectedTextModel, cached.model)) {
            cacheHits += 1
            analysis = cached.result
          } else if (!shouldRunLlmAnalysis(path, content)) {
            heuristicOnly += 1
            analysis = buildHeuristicAnalysis(path)
            if (fileIntel.conservativeReorganization) {
              analysis.reason = `${analysis.reason} (${fileIntel.qualityReason})`
            }
            analysisCache.entries[pathKey] = {
              contentHash,
              model: selectedTextModel,
              updatedAt: new Date().toISOString(),
              result: analysis,
            }
            cacheDirty = true
          } else {
            llmCalls += 1
            const analysisInput = content.trim().length > 0
              ? content
              : `Filename: ${path}\nThis note is empty. Suggest a meaningful folder based on file name.`
            analysis = await localAiService.analyzeNoteForReorganization(analysisInput, path, fileIntel)
            if (options?.shouldCancel?.()) {
              throw new Error('Reorganization analysis cancelled')
            }
            analysisCache.entries[pathKey] = {
              contentHash,
              model: selectedTextModel,
              updatedAt: new Date().toISOString(),
              result: analysis,
            }
            cacheDirty = true
          }

          // If should be deleted
          if (!analysis.shouldKeep) {
            const currentRelative = path.replace(/^notes\//i, '')
            const parseFailed = isHeuristicFallbackReason(analysis.reason)
            const currentTitleMessy = looksLikeMessyGeneratedTitle(currentRelative)
            if (!shouldSurfaceReviewSuggestion({
              currentRelative,
              reason: analysis.reason,
              parseFailed,
              currentTitleMessy,
            })) {
              continue
            }
            const fallbackTarget = `Review/${safePathPart(path.split('/').pop() || 'Note')}`
            operations.push({
              type: 'move',
              suggestionLevel: 'recommended',
              sourcePath: path,
              targetPath: fallbackTarget,
              reason: `${analysis.reason} (moved to Review for manual check)`,
              reviewContext: buildReviewContext(fileIntel, 'review'),
            })
            continue
          }

          // determine whether the AI suggested a different location/title
          // normalize both current and suggested paths to remove any leading
          // "notes/" segments (there may be multiple if the model erroneously
          // prefixed repeatedly) and drop any `.md` extension. this gives a
          // clean relative path to compare against the current one.
          const currentRelative = path.replace(/^notes\//i, '')
          const suggestedRelative = normalizeSuggestedRelativePath(analysis.suggestedPath || '', currentRelative)
          const fallbackUnsorted = `Unsorted/${path.split('/').pop() || 'Note'}`
          const parseFailed = isHeuristicFallbackReason(analysis.reason)

          let finalSuggestedRelative = suggestedRelative
          if (parseFailed) {
            if (looksUncategorized(currentRelative)) {
              const inferred = inferSuggestedRelativePathFromSource(currentRelative) || fallbackUnsorted
              finalSuggestedRelative = normalizeSuggestedRelativePath(inferred, currentRelative)
            } else {
              // Keep already-categorized files in place if AI output is unreliable.
              finalSuggestedRelative = currentRelative
            }
          }

          finalSuggestedRelative = alignSuggestedPathToTaxonomy(
            currentRelative,
            finalSuggestedRelative,
            taxonomy,
          )
          finalSuggestedRelative = applyLearnedTargetParent(
            currentRelative,
            finalSuggestedRelative,
            preferences,
            taxonomy,
          )
          const strategyAdjusted = applyReorganizationStrategy({
            strategy,
            currentRelative,
            suggestedRelative: finalSuggestedRelative,
            content,
            modifiedAt: modifiedAtByPath.get(pathKey),
            taxonomy,
          })
          finalSuggestedRelative = strategyAdjusted.targetRelative

          const currentTitleMessy = looksLikeMessyGeneratedTitle(currentRelative)
          const suggestedTitleClean = normalizeReorgPathSegment(analysis.suggestedTitle || '').replace(/\.[^/.]+$/, '').trim()
          if (
            !fileIntel.conservativeReorganization &&
            currentTitleMessy
            && suggestedTitleClean
            && suggestedTitleClean.toLowerCase() !== basenameWithoutExt(currentRelative).toLowerCase()
          ) {
            const renamedRelative = buildRenamedPathKeepingFolder(finalSuggestedRelative, suggestedTitleClean)
            finalSuggestedRelative = renamedRelative
          }

          if (
            fileIntel.conservativeReorganization
            && isStructuredEnough(currentRelative)
            && !looksUncategorized(currentRelative)
            && !currentTitleMessy
          ) {
            finalSuggestedRelative = currentRelative
            if (!analysis.reason.toLowerCase().includes(fileIntel.qualityReason.toLowerCase())) {
              analysis.reason = `${analysis.reason} (${fileIntel.qualityReason})`
            }
          }

          const outcome = determineReorgOutcome({
            currentRelative,
            targetRelative: finalSuggestedRelative,
            reason: analysis.reason,
            parseFailed,
            currentTitleMessy,
            isDuplicate: analysis.isDuplicate,
            duplicateOf: analysis.duplicateOf,
          })

          if (outcome.suppress) {
            continue
          }

          if (outcome.isDuplicate && analysis.duplicateOf) {
            operations.push({
              type: 'merge',
              suggestionLevel: 'strong',
              sourcePath: path,
              targetPath: analysis.duplicateOf,
              reason: analysis.reason,
              reviewContext: buildReviewContext(fileIntel, 'duplicate'),
            })
            continue
          }

          const currentStructured = isStructuredEnough(currentRelative)
          const shouldMove = shouldMoveFromDecision({
            currentRelative,
            targetRelative: finalSuggestedRelative,
            parseFailed,
            reason: analysis.reason,
            currentStructured,
            currentTitleMessy,
          },
            taxonomy,
            preferences,
          )

          if (shouldMove) {
            const suggestedFullPath = finalSuggestedRelative
            const suggestionLevel = determineMoveSuggestionLevel(currentRelative, finalSuggestedRelative)
            const moveReason = explainMoveReason(
              currentRelative,
              finalSuggestedRelative,
              (() => {
                const baseReason = looksUncategorized(currentRelative)
                  ? `${analysis.reason} (auto-fix uncategorized path)`
                  : analysis.reason
                if (strategyAdjusted.rationale && strategy !== 'meaning') {
                  return `${baseReason} (${strategyAdjusted.rationale})`
                }
                return baseReason
              })(),
              taxonomy,
              preferences,
            )
            operations.push({
              type: 'move',
              suggestionLevel: currentTitleMessy && currentRelative.split('/').slice(0, -1).join('/') === finalSuggestedRelative.split('/').slice(0, -1).join('/')
                ? 'recommended'
                : suggestionLevel,
              sourcePath: path,
              targetPath: suggestedFullPath,
              reason: moveReason,
              reviewContext: buildReviewContext(fileIntel, 'move'),
            })
          }
        } catch (error) {
          if (error instanceof Error && error.message === 'Reorganization analysis cancelled') {
            throw error
          }
          console.error(`Failed to analyze ${path}:`, error)
        }
      }

      // Calculate summary
      const summary = {
        totalNotes: allPaths.length,
        toMove: operations.filter(op => op.type === 'move').length,
        toDelete: operations.filter(op => op.type === 'delete').length,
        toMerge: operations.filter(op => op.type === 'merge').length,
        structuralIssues: operations.filter(op => op.type === 'structural').length,
      }

      operationCount = operations.length
      if (cacheDirty) {
        await persistAnalysisCache(analysisCache)
      }
      console.log('✅ Analysis complete:', summary)

      return { operations, summary }
    } finally {
      recordPerfMetric('reorg_analyze_ms', perfStart, {
        notes: totalNotes,
        operations: operationCount,
        llmCalls,
        cacheHits,
        heuristicOnly,
      })
    }
  },

  async executeReorganization(plan, onProgress, options) {
    await requireOllamaFor('Reorganize vault')
    const config: Required<ReorganizationExecutionOptions> = {
      confirmExecution: options?.confirmExecution ?? false,
      softDelete: options?.softDelete ?? true,
      createUndoLog: options?.createUndoLog ?? true,
    }

    if (!config.confirmExecution) {
      throw new Error('Execution blocked: confirmExecution must be true to run reorganization.')
    }

    console.log('🚀 Executing reorganization plan...')
    const runId = stampNow()
    const undoEntries: UndoEntry[] = []
    const failures: ExecutionFailure[] = []

    const total = plan.operations.length

    for (let i = 0; i < plan.operations.length; i++) {
      const op = plan.operations[i]
      if (onProgress) {
        onProgress(i + 1, total)
      }
      try {
        switch (op.type) {
          case 'delete':
            {
              const backupPath = config.createUndoLog ? await backupFileForUndo(op.sourcePath, runId) : null
              const trashPath = config.softDelete ? await moveToTrash(op.sourcePath, runId) : null
              if (!config.softDelete) {
                await vaultService.deletePath(op.sourcePath)
              }
              undoEntries.push({
                operation: op.type,
                sourcePath: op.sourcePath,
                backupPath: backupPath || undefined,
                trashPath: trashPath || undefined,
                reason: op.reason,
              })
              console.log(`🗑️ Deleted: ${op.sourcePath}`)
            }
            break
          case 'move':
            if (op.targetPath) {
              const backupPath = config.createUndoLog ? await backupFileForUndo(op.sourcePath, runId) : null
              const content = await vaultService.readFile(op.sourcePath)
              await vaultService.writeFile(op.targetPath, content)
              await vaultService.deletePath(op.sourcePath)
              undoEntries.push({
                operation: op.type,
                sourcePath: op.sourcePath,
                targetPath: op.targetPath,
                backupPath: backupPath || undefined,
                reason: op.reason,
              })
              console.log(`📦 Moved: ${op.sourcePath} → ${op.targetPath}`)
            }
            break
          case 'merge':
            if (op.targetPath) {
              const sourceBackup = config.createUndoLog ? await backupFileForUndo(op.sourcePath, runId) : null
              const targetBackup = config.createUndoLog ? await backupFileForUndo(op.targetPath, runId) : null
              const sourceContent = await vaultService.readFile(op.sourcePath)
              const targetContent = await vaultService.readFile(op.targetPath)
              const mergedContent = `${targetContent}\n\n---\n\n${sourceContent}`
              await vaultService.writeFile(op.targetPath, mergedContent)
              if (config.softDelete) {
                await moveToTrash(op.sourcePath, runId)
              } else {
                await vaultService.deletePath(op.sourcePath)
              }
              undoEntries.push({
                operation: op.type,
                sourcePath: op.sourcePath,
                targetPath: op.targetPath,
                backupPath: [sourceBackup, targetBackup].filter(Boolean).join(',') || undefined,
                reason: op.reason,
              })
              console.log(`🔀 Merged: ${op.sourcePath} → ${op.targetPath}`)
            }
            break
          case 'structural':
            // Handle all structural issues suggested by AI or scan
            switch (op.issueType) {
              case 'repeatedExtension': {
                const backupPath = config.createUndoLog ? await backupFileForUndo(op.sourcePath, runId) : null
                const newPath = op.sourcePath.replace(/(\.md)+$/i, '.md')
                const content = await vaultService.readFile(op.sourcePath)
                await vaultService.writeFile(newPath, content)
                await vaultService.deletePath(op.sourcePath)
                undoEntries.push({
                  operation: `${op.type}:${op.issueType}`,
                  sourcePath: op.sourcePath,
                  targetPath: newPath,
                  backupPath: backupPath || undefined,
                  reason: op.reason,
                })
                console.log(`✏️ Renamed file: ${op.sourcePath} → ${newPath}`)
                break
              }
              case 'emptyFolder': {
                await vaultService.deletePath(op.sourcePath)
                undoEntries.push({
                  operation: `${op.type}:${op.issueType}`,
                  sourcePath: op.sourcePath,
                  reason: op.reason,
                })
                console.log(`🗑️ Deleted empty folder: ${op.sourcePath}`)
                break
              }
              case 'nestedFolders':
              case 'redundantFolder': {
                // Move all files to Recovered/ before deleting folder
                const folderPath = op.sourcePath
                const tree = await vaultService.getVaultTree()
                type FolderNode = { type: 'folder', name: string, path: string, children: TreeNode[] }
                function findFolder(node: TreeNode, path: string): FolderNode | null {
                  if (node.type === 'folder' && node.path === path) return node as FolderNode
                  if (node.type === 'folder') {
                    for (const child of node.children) {
                      const found = findFolder(child, path)
                      if (found) return found
                    }
                  }
                  return null
                }
                let folderNode: FolderNode | null = null
                for (const node of tree) {
                  folderNode = findFolder(node, folderPath)
                  if (folderNode) break
                }
                if (folderNode) {
                  const recoveredPath = 'Recovered'
                  for (const child of folderNode.children) {
                    if (child.type === 'file') {
                      // Move file to Recovered
                      const newPath = `${recoveredPath}/${child.name}`
                      const content = await vaultService.readFile(child.path)
                      await vaultService.writeFile(newPath, content)
                      await vaultService.deletePath(child.path)
                      console.log(`📦 Moved to Recovered: ${child.path} → ${newPath}`)
                    }
                  }
                  // Delete the now-empty folder
                  await vaultService.deletePath(folderPath)
                  undoEntries.push({
                    operation: `${op.type}:${op.issueType}`,
                    sourcePath: op.sourcePath,
                    reason: op.reason,
                  })
                  console.log(`🗑️ Deleted redundant/nested folder: ${folderPath}`)
                } else {
                  console.log(`⚠️ Could not find folder node for: ${folderPath}`)
                }
                break
              }
              case 'orphanedFile': {
                const backupPath = config.createUndoLog ? await backupFileForUndo(op.sourcePath, runId) : null
                const trashPath = config.softDelete ? await moveToTrash(op.sourcePath, runId) : null
                if (!config.softDelete) {
                  await vaultService.deletePath(op.sourcePath)
                }
                undoEntries.push({
                  operation: `${op.type}:${op.issueType}`,
                  sourcePath: op.sourcePath,
                  backupPath: backupPath || undefined,
                  trashPath: trashPath || undefined,
                  reason: op.reason,
                })
                console.log(`🗑️ Deleted orphaned file: ${op.sourcePath}`)
                break
              }
              case 'inconsistentNaming': {
                if (op.targetPath) {
                  const backupPath = config.createUndoLog ? await backupFileForUndo(op.sourcePath, runId) : null
                  const content = await vaultService.readFile(op.sourcePath)
                  await vaultService.writeFile(op.targetPath, content)
                  await vaultService.deletePath(op.sourcePath)
                  undoEntries.push({
                    operation: `${op.type}:${op.issueType}`,
                    sourcePath: op.sourcePath,
                    targetPath: op.targetPath,
                    backupPath: backupPath || undefined,
                    reason: op.reason,
                  })
                  console.log(`✏️ Renamed for clarity: ${op.sourcePath} → ${op.targetPath}`)
                } else {
                  console.log(`⚠️ Inconsistent naming detected: ${op.sourcePath}. Please manually review.`)
                }
                break
              }
              default: {
                // For any other structural issue, just log for now
                console.log(`⚠️ Structural issue detected: ${op.sourcePath} (${op.issueType || 'unknown'})`)
                break
              }
            }
            break
        }
      } catch (error) {
        console.error(`Failed to execute operation on ${op.sourcePath}:`, error)
        failures.push({
          path: op.sourcePath,
          operation: op.type,
          message: error instanceof Error ? error.message : 'Unknown execution error',
        })
      }
    }

    let manifestPath: string | null = null
    if (config.createUndoLog) {
      manifestPath = `${UNDO_LOG_ROOT}/${runId}/undo-manifest.json`
      await vaultService.writeFile(
        manifestPath,
        JSON.stringify(
          {
            runId,
            createdAt: new Date().toISOString(),
            options: config,
            operationCount: undoEntries.length,
            entries: undoEntries,
            failures,
          },
          null,
          2
        )
      )
      console.log(`🧾 Undo manifest written: ${manifestPath}`)
    }

    if (failures.length > 0) {
      const sample = failures[0]
      const manifestHint = manifestPath ? ` Review ${manifestPath} for the undo log and failure list.` : ''
      throw new Error(
        `Reorganization completed with ${failures.length} failed operation${failures.length === 1 ? '' : 's'}. First failure: ${sample.path} (${sample.operation}) - ${sample.message}.${manifestHint}`,
      )
    }

    console.log('✅ Reorganization complete')
  },

  async rememberReviewDecisions(approvedOperations, deniedOperations) {
    const store = await loadPreferenceStore()

    for (const op of approvedOperations) {
      if (op.type !== 'move' || !op.targetPath) continue
      incrementCounter(store.acceptedTopLevelMoves, topLevelMoveKey(op.sourcePath, op.targetPath))
      incrementCounter(store.acceptedTargetParents, targetParentKey(op.targetPath))
      const parent = targetParentKey(op.targetPath)
      const tokens = tokenizeForReorgLearning(op.sourcePath.split('/').pop() || op.sourcePath)
      for (const token of tokens) {
        incrementNestedCounter(store.acceptedTokenParents, token, parent)
      }
    }

    for (const op of deniedOperations) {
      if (op.type !== 'move' || !op.targetPath) continue
      incrementCounter(store.deniedTopLevelMoves, topLevelMoveKey(op.sourcePath, op.targetPath))
      incrementCounter(store.deniedTargetParents, targetParentKey(op.targetPath))
    }

    await persistPreferenceStore(store)
  },
}
