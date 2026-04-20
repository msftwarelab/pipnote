import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTheme, type ThemeFamily } from '../contexts/ThemeContext'
import { useSettings } from '../contexts/SettingsContext'
import { useEditor } from '../contexts/EditorContext'
import { useToast } from '../contexts/ToastContext'
import { reorganizeService, type ReorganizationPlan } from '../services/reorganize'
import { searchService, type EmbeddingModelStatus, type IndexHealthDetails } from '../services/search'
import { localAiService, type LocalAIProvider, type LocalAIModel, type LocalAIModelCapability, type LocalAIModelSelectionStatus } from '../services/localAi'
import { vaultService, type SemanticCacheStats, type TreeNode } from '../services/vault'
import { embeddingQueueService, type EmbeddingQueueStatus } from '../services/embeddingQueue'
import { notePostProcessingService, type NotePostProcessingStatus } from '../services/notePostProcessing'
import { vaultConsistencyService, type VaultConsistencyReport } from '../services/vaultConsistency'
import { clearPerfMetrics, getPerfMetricSummaries, type PerfMetricSummary } from '../utils/perfMetrics'
import { performanceScanService, type PerformanceScanReport } from '../services/performanceScan'
import {
  REORGANIZATION_STRATEGIES,
  type ReorganizationStrategy,
} from '../utils/reorganizeStrategy'
import {
  buildProjectedVaultTree,
  groupOperationsForReview,
  summarizeDestinationClusters,
  type ReorgPreviewNode,
} from '../utils/reorganizePreview'
import { getReorgReviewHint, getReorgTrustTags } from '../utils/reorganizeReviewTags'
import { summarizeReorgChange } from '../utils/reorgExplainability'
import { buildWhyThisFolder } from '../utils/reorgWhyThisFolder'
import { buildReorgOperationNarrative } from '../utils/reorgOperationNarrative'
import {
  buildReorgConfidenceSummary,
  getReorgConfidenceRank,
  summarizeReorgConfidenceCounts,
} from '../utils/reorgConfidenceSummary'

interface HeaderProps {
  onApplyLayoutPreset?: (preset: 'focus' | 'balanced' | 'research') => void
  onResetLayout?: () => void
  onToggleQAPanel?: () => void
  onToggleSidebar?: () => void
  onToggleTopBar?: () => void
  isSidebarVisible?: boolean
  isTopBarVisible?: boolean
  reorganizeRequestToken?: number
  settingsRequestToken?: number
  onOpenKeywordSearch?: () => void
  onVaultMutated?: () => Promise<void> | void
}

type CommandGroup = 'Core' | 'Layout' | 'AI'

interface CommandItem {
  id: string
  title: string
  subtitle: string
  keywords: string
  group: CommandGroup
  hotkey?: string
  detail?: string
  longRunning?: boolean
  runInBackground?: () => Promise<void>
  action: () => void | Promise<void>
}

interface MentionedFilePreview {
  path: string
  content: string
  error?: string
}

type ReorganizeReviewMode = 'list' | 'tree'

type SettingsSectionId = 'appearance' | 'editor' | 'ai' | 'performance' | 'layout'

const RECENT_COMMANDS_KEY = 'vn_recent_commands'
const PINNED_COMMANDS_KEY = 'vn_pinned_commands'
const COMMAND_USAGE_KEY = 'vn_command_usage'
const CUSTOM_SHORTCUTS_KEY = 'vn_custom_shortcuts'

const CUSTOM_SHORTCUT_OPTIONS = [
  { id: 'meta+shift+1', label: '⌘⇧1' },
  { id: 'meta+shift+2', label: '⌘⇧2' },
  { id: 'meta+shift+3', label: '⌘⇧3' },
  { id: 'meta+shift+4', label: '⌘⇧4' },
  { id: 'meta+shift+5', label: '⌘⇧5' },
  { id: 'meta+shift+6', label: '⌘⇧6' },
  { id: 'meta+shift+7', label: '⌘⇧7' },
  { id: 'meta+shift+8', label: '⌘⇧8' },
  { id: 'meta+shift+9', label: '⌘⇧9' },
]

const THEME_SWATCHES: Record<ThemeFamily, { light: string[]; dark: string[] }> = {
  cobalt: {
    light: ['#f4f7fb', '#ffffff', '#1065d6'],
    dark: ['#07111f', '#0f1c30', '#4aa2ff'],
  },
  noir: {
    light: ['#f4f5f7', '#ffffff', '#0f766e'],
    dark: ['#090a0c', '#13161c', '#5de6d8'],
  },
  linen: {
    light: ['#f8f4ed', '#fffcf7', '#b45f21'],
    dark: ['#17120d', '#251d16', '#e39a57'],
  },
  forge: {
    light: ['#f2f4f8', '#ffffff', '#ff5a1f'],
    dark: ['#0a0e16', '#151f33', '#ff7a2f'],
  },
  obsidian: {
    light: ['#f5f5f4', '#fbfbfa', '#6b6cf6'],
    dark: ['#16171a', '#1c1d21', '#8b8cff'],
  },
  codex: {
    light: ['#f4f5f7', '#ffffff', '#2f7cff'],
    dark: ['#0b0d12', '#10131a', '#4b8dff'],
  },
}

const PERF_METRIC_LABELS: Record<PerfMetricSummary['name'], string> = {
  file_open_ms: 'File Open',
  vault_tree_load_ms: 'Vault Tree Load',
  keyword_search_ms: 'Keyword Search',
  sidebar_related_ms: 'Related Notes Sidebar',
  sidebar_backlinks_ms: 'Backlinks Sidebar',
  ai_readable_load_ms: 'AI Document Load',
  search_retrieval_ms: 'Search Retrieval',
  qa_single_ms: 'Q&A (Single)',
  qa_multi_ms: 'Q&A (Multi)',
  reorg_analyze_ms: 'Vault Analyze',
  regen_all_embeddings_ms: 'Embed Regenerate (All)',
  regen_stale_embeddings_ms: 'Embed Regenerate (Stale)',
}

const SETTINGS_SECTIONS: Array<{ id: SettingsSectionId; label: string; description: string }> = [
  { id: 'appearance', label: 'Appearance', description: 'Themes, color mode, and visual feel.' },
  { id: 'editor', label: 'Editor', description: 'Default editing behavior and reading defaults.' },
  { id: 'ai', label: 'AI & Models', description: 'Local AI provider, models, embeddings, and index health.' },
  { id: 'performance', label: 'Performance', description: 'Diagnostics, scans, and runtime performance signals.' },
  { id: 'layout', label: 'Layout', description: 'Default visibility of the main app panels.' },
]

function fuzzyScore(haystack: string, query: string): number {
  if (!query) return 1
  const h = haystack.toLowerCase()
  const q = query.toLowerCase()
  let score = 0
  let hIndex = 0
  let streak = 0

  for (let i = 0; i < q.length; i += 1) {
    const ch = q[i]
    const foundAt = h.indexOf(ch, hIndex)
    if (foundAt === -1) return -1
    if (foundAt === hIndex) {
      streak += 1
      score += 4 + streak
    } else {
      streak = 0
      score += 1
    }
    if (foundAt < 8) score += 1
    hIndex = foundAt + 1
  }

  if (h.includes(q)) score += 8
  return score
}

function eventMatchesShortcut(event: KeyboardEvent, shortcutId: string): boolean {
  const parts = shortcutId.split('+')
  const key = parts[parts.length - 1]
  const expectsMeta = parts.includes('meta')
  const expectsShift = parts.includes('shift')
  const expectsAlt = parts.includes('alt')
  const expectsCtrl = parts.includes('ctrl')

  if ((event.metaKey || event.ctrlKey) !== (expectsMeta || expectsCtrl)) return false
  if (event.shiftKey !== expectsShift) return false
  if (event.altKey !== expectsAlt) return false
  return event.key.toLowerCase() === key.toLowerCase()
}

function modelCapabilityLabel(capability: LocalAIModelCapability): string {
  if (capability === 'text') return 'Text'
  if (capability === 'embedding') return 'Embedding'
  if (capability === 'both') return 'Both'
  return 'Unknown'
}

function localAiProviderLabel(provider: LocalAIProvider): string {
  return provider === 'lmstudio' ? 'LM Studio' : 'Ollama'
}

function modelCapabilityBadgeClass(capability: LocalAIModelCapability): string {
  if (capability === 'text') return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
  if (capability === 'embedding') return 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300'
  if (capability === 'both') return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
  return 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-200'
}

function isModelCapabilityAllowed(field: 'textModel' | 'embeddingModel', capability: LocalAIModelCapability): boolean {
  if (field === 'textModel') return capability !== 'embedding'
  return capability !== 'text'
}

function normalizePlanPath(path: string): string {
  return path.replace(/^notes\//i, '').trim()
}

function extractReasonPaths(reason: string): string[] {
  if (!reason) return []
  const matches = reason.match(/(?:notes\/)?[A-Za-z0-9 _.-]+(?:\/[A-Za-z0-9 _.-]+)+\.(?:md|txt|markdown)/gi) || []
  const seen = new Set<string>()
  const result: string[] = []
  for (const match of matches) {
    const normalized = normalizePlanPath(match.replace(/[),.;]+$/g, ''))
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function collectMentionedPaths(op: ReorganizationPlan['operations'][number]): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  const pushPath = (raw?: string) => {
    if (!raw) return
    const normalized = normalizePlanPath(raw)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    paths.push(normalized)
  }

  pushPath(op.sourcePath)
  pushPath(op.targetPath)
  extractReasonPaths(op.reason).forEach(pushPath)
  return paths
}

function flattenVaultFilePaths(nodes: ReorgPreviewNode[] | TreeNode[]): string[] {
  const paths: string[] = []
  const walk = (items: ReorgPreviewNode[] | TreeNode[]) => {
    items.forEach((item) => {
      if (item.type === 'file') {
        paths.push(item.path)
      } else if (item.type === 'folder' && Array.isArray(item.children)) {
        walk(item.children)
      }
    })
  }
  walk(nodes)
  return paths
}

function previewChangeMeta(kind?: ReorgPreviewNode['changeKind']): { label: string; className: string } | null {
  if (kind === 'rename') {
    return {
      label: 'Renamed',
      className: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-200',
    }
  }
  if (kind === 'move') {
    return {
      label: 'Moved',
      className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200',
    }
  }
  if (kind === 'move-rename') {
    return {
      label: 'Moved + Renamed',
      className: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-200',
    }
  }
  if (kind === 'merge-target') {
    return {
      label: 'Merged Into',
      className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200',
    }
  }
  return null
}

function VirtualPreviewTree({
  nodes,
  level = 0,
}: {
  nodes: ReorgPreviewNode[]
  level?: number
}) {
  return (
    <div className={level === 0 ? 'space-y-0.5' : 'space-y-0.5'}>
      {nodes.map((node) => {
        const changeMeta = previewChangeMeta(node.changeKind)
        return (
          <div key={`${node.type}-${node.path}`}>
            <div
              className={`flex items-center gap-2 rounded px-2 py-1.5 text-[12px] ${
                node.type === 'file'
                  ? 'text-slate-700 dark:text-slate-200 hover:bg-slate-100/70 dark:hover:bg-slate-800/50'
                  : 'text-slate-800 dark:text-slate-100'
              }`}
              style={{ paddingLeft: `${level * 16 + (node.type === 'file' ? 28 : 8)}px` }}
            >
              {node.type === 'folder' ? (
                <>
                  <svg
                    className="w-4 h-4 text-slate-400 dark:text-slate-500 flex-shrink-0 rotate-90"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <svg className="w-4 h-4 text-blue-500 dark:text-blue-300 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  <span className="font-semibold truncate">{node.name}</span>
                </>
              ) : (
                <>
                  <svg className="w-4 h-4 text-slate-400 dark:text-slate-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                  <span className="truncate">{node.name.replace(/\.md$/i, '')}</span>
                  {changeMeta && (
                    <span className={`ml-auto px-2 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap ${changeMeta.className}`}>
                      {changeMeta.label}
                    </span>
                  )}
                </>
              )}
            </div>
            {node.type === 'folder' && node.children && node.children.length > 0 && (
              <VirtualPreviewTree nodes={node.children} level={level + 1} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function isRenameCleanupOperation(op: ReorganizationPlan['operations'][number]): boolean {
  if (op.type !== 'move' || !op.targetPath) return false
  const sourceParts = op.sourcePath.replace(/^notes\//i, '').split('/').filter(Boolean)
  const targetParts = op.targetPath.replace(/^notes\//i, '').split('/').filter(Boolean)
  if (sourceParts.length === 0 || targetParts.length === 0) return false
  const sourceParent = sourceParts.slice(0, -1).join('/').toLowerCase()
  const targetParent = targetParts.slice(0, -1).join('/').toLowerCase()
  const sourceName = sourceParts[sourceParts.length - 1]?.toLowerCase() || ''
  const targetName = targetParts[targetParts.length - 1]?.toLowerCase() || ''
  return sourceParent === targetParent && sourceName !== targetName
}

function renderMarkdownPreview(content: string): ReactNode[] {
  const lines = content.split('\n').slice(0, 48)
  const elements: ReactNode[] = []
  let inCode = false

  lines.forEach((rawLine, index) => {
    const line = rawLine.replace(/\t/g, '  ')
    const trimmed = line.trim()

    if (trimmed.startsWith('```')) {
      inCode = !inCode
      elements.push(
        <div key={`fence-${index}`} className="text-[11px] font-mono text-violet-600 dark:text-violet-300">
          {trimmed || '```'}
        </div>,
      )
      return
    }

    if (inCode) {
      elements.push(
        <pre key={`code-${index}`} className="text-[11px] font-mono text-slate-700 dark:text-slate-200 whitespace-pre-wrap">
          {line || ' '}
        </pre>,
      )
      return
    }

    if (/^###\s+/.test(trimmed)) {
      elements.push(
        <h4 key={`h3-${index}`} className="text-xs font-semibold text-slate-900 dark:text-slate-100">
          {trimmed.replace(/^###\s+/, '')}
        </h4>,
      )
      return
    }
    if (/^##\s+/.test(trimmed)) {
      elements.push(
        <h3 key={`h2-${index}`} className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {trimmed.replace(/^##\s+/, '')}
        </h3>,
      )
      return
    }
    if (/^#\s+/.test(trimmed)) {
      elements.push(
        <h2 key={`h1-${index}`} className="text-sm font-bold text-slate-900 dark:text-slate-100">
          {trimmed.replace(/^#\s+/, '')}
        </h2>,
      )
      return
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      elements.push(
        <div key={`li-${index}`} className="text-xs text-slate-700 dark:text-slate-200">
          {line}
        </div>,
      )
      return
    }
    if (/^>\s?/.test(trimmed)) {
      elements.push(
        <blockquote key={`q-${index}`} className="border-l-2 border-slate-300 dark:border-slate-600 pl-2 text-xs italic text-slate-600 dark:text-slate-300">
          {trimmed.replace(/^>\s?/, '')}
        </blockquote>,
      )
      return
    }
    if (!trimmed) {
      elements.push(<div key={`sp-${index}`} className="h-1.5" />)
      return
    }

    elements.push(
      <p key={`p-${index}`} className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed">
        {line}
      </p>,
    )
  })

  return elements
}

function Header({
  onApplyLayoutPreset,
  onResetLayout,
  onToggleQAPanel,
  onToggleSidebar,
  onToggleTopBar,
  isSidebarVisible = true,
  isTopBarVisible = true,
  reorganizeRequestToken = 0,
  settingsRequestToken = 0,
  onOpenKeywordSearch,
  onVaultMutated,
}: HeaderProps) {
  const { mode, family, setMode, setFamily, themeFamilies, toggleTheme } = useTheme()
  const { settings, updateSetting, resetSettings } = useSettings()
  const { createNewNote, openFile, saveAllDirtyTabs, reconcileTabsWithVault, canGoBack, canGoForward, goBack, goForward } = useEditor()
  const { showToast } = useToast()
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showLayoutMenu, setShowLayoutMenu] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [activeSettingsSection, setActiveSettingsSection] = useState<SettingsSectionId>('appearance')
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [commandQuery, setCommandQuery] = useState('')
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)
  const [recentCommandIds, setRecentCommandIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(RECENT_COMMANDS_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw) as string[]
      return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : []
    } catch {
      return []
    }
  })
  const [pinnedCommandIds, setPinnedCommandIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(PINNED_COMMANDS_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw) as string[]
      return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : []
    } catch {
      return []
    }
  })
  const [commandUsage, setCommandUsage] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem(COMMAND_USAGE_KEY)
      if (!raw) return {}
      const parsed = JSON.parse(raw) as Record<string, number>
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  })
  const [customShortcutAssignments, setCustomShortcutAssignments] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem(CUSTOM_SHORTCUTS_KEY)
      if (!raw) return {}
      const parsed = JSON.parse(raw) as Record<string, string>
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  })
  const [showReorganizeDialog, setShowReorganizeDialog] = useState(false)
  const [localAiModels, setLocalAiModels] = useState<LocalAIModel[]>([])
  const [modelSelectionStatus, setModelSelectionStatus] = useState<LocalAIModelSelectionStatus | null>(null)
  const [embeddingModelStatus, setEmbeddingModelStatus] = useState<EmbeddingModelStatus | null>(null)
  const [indexHealthDetails, setIndexHealthDetails] = useState<IndexHealthDetails | null>(null)
  const [isLoadingModelData, setIsLoadingModelData] = useState(false)
  const [isSavingModelSelection, setIsSavingModelSelection] = useState(false)
  const [isRefreshingPerfMetrics, setIsRefreshingPerfMetrics] = useState(false)
  const [isRunningPerformanceScan, setIsRunningPerformanceScan] = useState(false)
  const [performanceScanProgress, setPerformanceScanProgress] = useState({ current: 0, total: 0, label: '' })
  const [performanceScanReport, setPerformanceScanReport] = useState<PerformanceScanReport | null>(null)
  const [isRegeneratingEmbeddings, setIsRegeneratingEmbeddings] = useState(false)
  const [regenerationProgress, setRegenerationProgress] = useState({ current: 0, total: 0 })
  const [isRegeneratingStaleEmbeddings, setIsRegeneratingStaleEmbeddings] = useState(false)
  const [staleRegenerationProgress, setStaleRegenerationProgress] = useState({ current: 0, total: 0 })
  const [isRunningConsistencyRepair, setIsRunningConsistencyRepair] = useState(false)
  const [consistencyRepairProgress, setConsistencyRepairProgress] = useState({ current: 0, total: 0 })
  const [consistencyReport, setConsistencyReport] = useState<VaultConsistencyReport | null>(null)
  const [modelDataError, setModelDataError] = useState<string | null>(null)
  const [perfMetricSummaries, setPerfMetricSummaries] = useState<PerfMetricSummary[]>(() => getPerfMetricSummaries())
  const [embeddingQueueStatus, setEmbeddingQueueStatus] = useState<EmbeddingQueueStatus>(() => embeddingQueueService.getStatus())
  const [postProcessingStatus, setPostProcessingStatus] = useState<NotePostProcessingStatus>(() => notePostProcessingService.getStatus())
  const [semanticCacheStats, setSemanticCacheStats] = useState<SemanticCacheStats>({
    queries: 0,
    hits: 0,
    misses: 0,
    rebuilds: 0,
    entries: 0,
    last_built_at: null,
  })
  const [isBackgroundAnalyzing, setIsBackgroundAnalyzing] = useState(false)
  const [isBackgroundStaleReembedding, setIsBackgroundStaleReembedding] = useState(false)
  const [backgroundStaleProgress, setBackgroundStaleProgress] = useState({ current: 0, total: 0 })
  const [backgroundStaleCancelRequested, setBackgroundStaleCancelRequested] = useState(false)
  const backgroundStaleCancelRef = useRef(false)
  const analysisCancelRef = useRef(false)
  const livePerfHideTimerRef = useRef<number | null>(null)
  const lastHandledReorganizeTokenRef = useRef(0)
  const lastHandledSettingsTokenRef = useRef(0)
  const [reorganizationPlan, setReorganizationPlan] = useState<ReorganizationPlan | null>(null)
  const [reorganizationStrategy, setReorganizationStrategy] = useState<ReorganizationStrategy>('meaning')
  const [reorganizationPlanStrategy, setReorganizationPlanStrategy] = useState<ReorganizationStrategy>('meaning')
  const [reorganizeReviewMode, setReorganizeReviewMode] = useState<ReorganizeReviewMode>('list')
  const [reorganizationSnapshotPaths, setReorganizationSnapshotPaths] = useState<string[]>([])
  const [approvedOperationIds, setApprovedOperationIds] = useState<Set<number>>(new Set())
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [isExecuting, setIsExecuting] = useState(false)
  const [showLivePerfDetails, setShowLivePerfDetails] = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0 })
  const [expandedMentionedOps, setExpandedMentionedOps] = useState<Set<number>>(new Set())
  const [selectedMentionedPathByOp, setSelectedMentionedPathByOp] = useState<Record<number, string>>({})
  const [previewByPath, setPreviewByPath] = useState<Record<string, MentionedFilePreview>>({})
  const [previewLoadingPaths, setPreviewLoadingPaths] = useState<Set<string>>(new Set())
  const analyzingFileName = (window as Window & { __vnAnalyzingFileName?: string }).__vnAnalyzingFileName
  const activeThemeFamily = useMemo(
    () => themeFamilies.find((themeOption) => themeOption.id === family),
    [family, themeFamilies],
  )
  const groupedReorganizationOperations = useMemo(
    () => (reorganizationPlan ? groupOperationsForReview(reorganizationPlan.operations) : []),
    [reorganizationPlan],
  )
  const destinationClusters = useMemo(
    () => (reorganizationPlan ? summarizeDestinationClusters(reorganizationPlan.operations, approvedOperationIds) : []),
    [approvedOperationIds, reorganizationPlan],
  )
  const projectedReorganizationTree = useMemo(
    () => (
      reorganizationPlan
        ? buildProjectedVaultTree(reorganizationSnapshotPaths, reorganizationPlan.operations, approvedOperationIds)
        : []
    ),
    [approvedOperationIds, reorganizationPlan, reorganizationSnapshotPaths],
  )

  const handleStartReorganize = useCallback(async (strategyOverride?: ReorganizationStrategy) => {
    const strategy = strategyOverride ?? reorganizationStrategy
    if (isAnalyzing) {
      return
    }
    if (reorganizationPlan && !isAnalyzing && !isExecuting && reorganizationPlanStrategy === strategy) {
      setShowReorganizeDialog(true)
      return
    }

    analysisCancelRef.current = false
    setShowReorganizeDialog(false)
    setIsBackgroundAnalyzing(true)
    setIsAnalyzing(true)
    setReorganizeReviewMode('list')
    setProgress({ current: 0, total: 0 })

    try {
      const { savedCount } = await saveAllDirtyTabs({ silent: true })
      if (savedCount > 0) {
        showToast(`Saved ${savedCount} note${savedCount === 1 ? '' : 's'} before analysis`, 'success')
      }
      const plan = await reorganizeService.analyzeVault((current, total) => {
        setProgress({ current, total })
      }, {
        shouldCancel: () => analysisCancelRef.current,
        strategy,
      })
      if (analysisCancelRef.current) {
        return
      }
      setReorganizationPlan(plan)
      setReorganizationPlanStrategy(strategy)
      try {
        const snapshotTree = await vaultService.getVaultTree()
        setReorganizationSnapshotPaths(flattenVaultFilePaths(snapshotTree))
      } catch {
        setReorganizationSnapshotPaths(
          Array.from(
            new Set(
              plan.operations.flatMap((op) => [op.sourcePath, op.targetPath].filter(Boolean) as string[]),
            ),
          ),
        )
      }
      setApprovedOperationIds(new Set(
        plan.operations
          .map((op, index) => ({ op, index }))
          .filter(({ op }) => op.suggestionLevel !== 'optional')
          .map(({ index }) => index)
      ))
      setShowReorganizeDialog(true)
    } catch (error) {
      if (error instanceof Error && error.message === 'Reorganization analysis cancelled') return
      console.error('Failed to analyze vault:', error)
      setShowReorganizeDialog(false)
      setReorganizationSnapshotPaths([])
      showToast(error instanceof Error ? error.message : 'Failed to analyze vault', 'error')
    } finally {
      setIsAnalyzing(false)
      setIsBackgroundAnalyzing(false)
    }
  }, [isAnalyzing, isExecuting, reorganizationPlan, reorganizationPlanStrategy, reorganizationStrategy, saveAllDirtyTabs, showToast])

  useEffect(() => {
    if (reorganizeRequestToken === 0) return
    if (reorganizeRequestToken === lastHandledReorganizeTokenRef.current) return
    lastHandledReorganizeTokenRef.current = reorganizeRequestToken
    void handleStartReorganize()
  }, [handleStartReorganize, reorganizeRequestToken])

  useEffect(() => {
    if (settingsRequestToken === 0) return
    if (settingsRequestToken === lastHandledSettingsTokenRef.current) return
    lastHandledSettingsTokenRef.current = settingsRequestToken
    setShowSettings(true)
  }, [settingsRequestToken])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
      if (event.key === '[') {
        event.preventDefault()
        void goBack()
      } else if (event.key === ']') {
        event.preventDefault()
        void goForward()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [goBack, goForward])

  const handleConfirmReorganize = async () => {
    if (!reorganizationPlan) return
    const approvedOperations = reorganizationPlan.operations.filter((_, index) => approvedOperationIds.has(index))
    const deniedOperations = reorganizationPlan.operations.filter((_, index) => !approvedOperationIds.has(index))
    if (approvedOperations.length === 0) {
      showToast('No operations approved. Select at least one action.', 'warning')
      return
    }

    const planToExecute: ReorganizationPlan = {
      operations: approvedOperations,
      summary: {
        totalNotes: reorganizationPlan.summary.totalNotes,
        toMove: approvedOperations.filter(op => op.type === 'move').length,
        toDelete: approvedOperations.filter(op => op.type === 'delete').length,
        toMerge: approvedOperations.filter(op => op.type === 'merge').length,
        structuralIssues: approvedOperations.filter(op => op.type === 'structural').length,
      },
    }

    setIsExecuting(true)
    setProgress({ current: 0, total: 0 })

    try {
      const { savedCount } = await saveAllDirtyTabs({ silent: true })
      if (savedCount > 0) {
        showToast(`Saved ${savedCount} note${savedCount === 1 ? '' : 's'} before applying changes`, 'success')
      }
      await reorganizeService.executeReorganization(planToExecute, (current, total) => {
        setProgress({ current, total })
      }, {
        confirmExecution: true,
        softDelete: true,
        createUndoLog: true,
      })
      await reorganizeService.rememberReviewDecisions(approvedOperations, deniedOperations)
      const reconcileResult = await reconcileTabsWithVault()
      await onVaultMutated?.()
      showToast('Vault reorganized successfully', 'success')
      if (reconcileResult.closedCount > 0) {
        showToast(`${reconcileResult.closedCount} open tab${reconcileResult.closedCount === 1 ? '' : 's'} closed because the file moved or was removed`, 'info')
      }
      setShowReorganizeDialog(false)
      setReorganizationPlan(null)
      setReorganizationSnapshotPaths([])
      setApprovedOperationIds(new Set())
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to reorganize vault', 'error')
    } finally {
      setIsExecuting(false)
    }
  }

  const handleCancelReorganize = () => {
    analysisCancelRef.current = true
    setShowReorganizeDialog(false)
    setReorganizationPlan(null)
    setReorganizationPlanStrategy(reorganizationStrategy)
    setReorganizationSnapshotPaths([])
    setApprovedOperationIds(new Set())
    setExpandedMentionedOps(new Set())
    setSelectedMentionedPathByOp({})
    setPreviewByPath({})
    setPreviewLoadingPaths(new Set())
    setIsAnalyzing(false)
    setIsExecuting(false)
  }

  const toggleMentionedFiles = useCallback((operationIndex: number, paths: string[]) => {
    setExpandedMentionedOps(prev => {
      const next = new Set(prev)
      if (next.has(operationIndex)) {
        next.delete(operationIndex)
        return next
      }
      next.add(operationIndex)
      return next
    })
    setSelectedMentionedPathByOp(prev => {
      if (prev[operationIndex]) return prev
      const first = paths[0]
      if (!first) return prev
      return { ...prev, [operationIndex]: first }
    })
  }, [])

  const ensureMentionedPreviewLoaded = useCallback(async (path: string) => {
    const normalized = normalizePlanPath(path)
    if (!normalized) return
    if (previewByPath[normalized]) return
    if (previewLoadingPaths.has(normalized)) return

    setPreviewLoadingPaths(prev => {
      const next = new Set(prev)
      next.add(normalized)
      return next
    })

    try {
      const content = await vaultService.readFile(normalized)
      setPreviewByPath(prev => ({
        ...prev,
        [normalized]: {
          path: normalized,
          content,
        },
      }))
    } catch (error) {
      setPreviewByPath(prev => ({
        ...prev,
        [normalized]: {
          path: normalized,
          content: '',
          error: error instanceof Error ? error.message : 'Failed to load file preview',
        },
      }))
    } finally {
      setPreviewLoadingPaths(prev => {
        const next = new Set(prev)
        next.delete(normalized)
        return next
      })
    }
  }, [previewByPath, previewLoadingPaths])

  const toggleOperationApproval = (index: number) => {
    setApprovedOperationIds(prev => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }

  const approveAllOperations = () => {
    if (!reorganizationPlan) return
    setApprovedOperationIds(new Set(reorganizationPlan.operations.map((_, index) => index)))
  }

  const denyAllOperations = () => {
    setApprovedOperationIds(new Set())
  }

  const getOperationMeta = (type: ReorganizationPlan['operations'][number]['type']) => {
    if (type === 'move') {
      return {
        label: 'Move',
        color: 'text-blue-600 dark:text-blue-300',
        bg: 'bg-blue-50 dark:bg-blue-900/20',
        icon: (
          <svg className="w-4 h-4 text-blue-600 dark:text-blue-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7h18M3 12h18M3 17h10" />
          </svg>
        ),
      }
    }
    if (type === 'delete') {
      return {
        label: 'Delete',
        color: 'text-red-600 dark:text-red-300',
        bg: 'bg-red-50 dark:bg-red-900/20',
        icon: (
          <svg className="w-4 h-4 text-red-600 dark:text-red-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 7h12m-9 0v11m6-11v11M9 7l1-2h4l1 2m-8 0h10a1 1 0 011 1v10a2 2 0 01-2 2H8a2 2 0 01-2-2V8a1 1 0 011-1z" />
          </svg>
        ),
      }
    }
    if (type === 'merge') {
      return {
        label: 'Merge',
        color: 'text-green-600 dark:text-green-300',
        bg: 'bg-green-50 dark:bg-green-900/20',
        icon: (
          <svg className="w-4 h-4 text-green-600 dark:text-green-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h3a3 3 0 013 3v1m0 0h2m-2 0v2m2 4h-3a3 3 0 01-3-3v-1m0 0H8m2 0v-2" />
          </svg>
        ),
      }
    }
    return {
      label: 'Structure',
      color: 'text-yellow-600 dark:text-yellow-300',
      bg: 'bg-yellow-50 dark:bg-yellow-900/20',
      icon: (
        <svg className="w-4 h-4 text-yellow-600 dark:text-yellow-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h10M4 18h7" />
        </svg>
      ),
    }
  }

  const getLevelMeta = (level: ReorganizationPlan['operations'][number]['suggestionLevel']) => {
    if (level === 'strong') return { label: 'Strong', className: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300' }
    if (level === 'recommended') return { label: 'Recommended', className: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300' }
    return { label: 'Optional', className: 'bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200' }
  }

  const getLevelRank = (level: ReorganizationPlan['operations'][number]['suggestionLevel']) => {
    if (level === 'strong') return 0
    if (level === 'recommended') return 1
    return 2
  }

  const formatBytes = (bytes?: number) => {
    if (!bytes || bytes <= 0) return ''
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = bytes
    let unitIndex = 0
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024
      unitIndex += 1
    }
    return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
  }

  const formatQueueTime = (timestamp: number | null) => {
    if (!timestamp) return 'n/a'
    try {
      return new Date(timestamp).toLocaleTimeString()
    } catch {
      return 'n/a'
    }
  }

  const formatIsoTime = (value: string | null) => {
    if (!value) return 'n/a'
    try {
      return new Date(value).toLocaleTimeString()
    } catch {
      return 'n/a'
    }
  }

  const formatDurationMs = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return '0 ms'
    if (value >= 1000) return `${(value / 1000).toFixed(2)} s`
    return `${Math.round(value)} ms`
  }

  const formatDurationCompactMs = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return 'n/a'
    if (value >= 10_000) return `${Math.round(value / 1000)}s`
    if (value >= 1000) return `${(value / 1000).toFixed(1)}s`
    return `${Math.round(value)}ms`
  }

  const refreshModelData = useCallback(async () => {
    setIsLoadingModelData(true)
    setModelDataError(null)
    try {
      const [models, status, embeddingStatus, indexHealth] = await Promise.all([
        localAiService.listLocalModels(),
        localAiService.getModelSelectionStatus(),
        searchService.getEmbeddingModelStatus().catch(() => ({
          totalEmbeddings: 0,
          upToDateCount: 0,
          staleCount: 0,
          selectedEmbeddingModel: localAiService.getSettings().embeddingModel,
          observedModels: [],
          isStale: false,
        })),
        searchService.getIndexHealthDetails().catch(() => null),
      ])
      setLocalAiModels(models)
      setModelSelectionStatus(status)
      setEmbeddingModelStatus(embeddingStatus)
      setIndexHealthDetails(indexHealth)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load model data'
      setModelDataError(message)
    } finally {
      setIsLoadingModelData(false)
    }
  }, [])

  const refreshConsistencyReport = useCallback(async () => {
    try {
      const report = await vaultConsistencyService.scan()
      setConsistencyReport(report)
    } catch {
      // Keep prior report if scan fails transiently.
    }
  }, [])

  const refreshPerfMetrics = useCallback(async () => {
    setIsRefreshingPerfMetrics(true)
    try {
      setPerfMetricSummaries(getPerfMetricSummaries())
    } finally {
      setIsRefreshingPerfMetrics(false)
    }
  }, [])

  const refreshSemanticCacheStats = useCallback(async () => {
    try {
      const stats = await vaultService.getSemanticCacheStats()
      setSemanticCacheStats(stats)
    } catch {
      // Keep last known stats if command temporarily fails.
    }
  }, [])

  useEffect(() => {
    return embeddingQueueService.subscribe((status) => {
      setEmbeddingQueueStatus(status)
    })
  }, [])

  useEffect(() => {
    return notePostProcessingService.subscribe((status) => {
      setPostProcessingStatus(status)
    })
  }, [])

  useEffect(() => {
    embeddingQueueService.setSchedulingMode(settings.embeddingQueueSchedulingMode)
  }, [settings.embeddingQueueSchedulingMode])

  useEffect(() => {
    embeddingQueueService.setConcurrency(settings.embeddingQueueConcurrency)
  }, [settings.embeddingQueueConcurrency])

  useEffect(() => {
    if (!showSettings) return
    void refreshModelData()
    void refreshPerfMetrics()
    void refreshSemanticCacheStats()
    void refreshConsistencyReport()
    const interval = window.setInterval(() => {
      setPerfMetricSummaries(getPerfMetricSummaries())
      void refreshSemanticCacheStats()
    }, 1800)
    return () => window.clearInterval(interval)
  }, [refreshConsistencyReport, refreshModelData, refreshPerfMetrics, refreshSemanticCacheStats, showSettings])

  useEffect(() => {
    void refreshSemanticCacheStats()
    const interval = window.setInterval(() => {
      setPerfMetricSummaries(getPerfMetricSummaries())
      void refreshSemanticCacheStats()
    }, 2200)
    return () => window.clearInterval(interval)
  }, [refreshSemanticCacheStats])

  const handleClearPerfMetrics = useCallback(() => {
    clearPerfMetrics()
    setPerfMetricSummaries(getPerfMetricSummaries())
    showToast('Performance metrics cleared', 'success')
  }, [showToast])

  const handleRunPerformanceScan = useCallback(async () => {
    if (isRunningPerformanceScan) return
    setIsRunningPerformanceScan(true)
    setPerformanceScanProgress({ current: 0, total: 0, label: '' })
    try {
      const report = await performanceScanService.run((current, total, label) => {
        setPerformanceScanProgress({ current, total, label })
      })
      setPerformanceScanReport(report)
      setPerfMetricSummaries(getPerfMetricSummaries())
      showToast('Performance scan complete', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Performance scan failed', 'error')
    } finally {
      setIsRunningPerformanceScan(false)
      setPerformanceScanProgress({ current: 0, total: 0, label: '' })
    }
  }, [isRunningPerformanceScan, showToast])

  const openLivePerfDetails = useCallback(() => {
    if (livePerfHideTimerRef.current) {
      window.clearTimeout(livePerfHideTimerRef.current)
      livePerfHideTimerRef.current = null
    }
    setShowLivePerfDetails(true)
  }, [])

  const scheduleHideLivePerfDetails = useCallback(() => {
    if (livePerfHideTimerRef.current) {
      window.clearTimeout(livePerfHideTimerRef.current)
    }
    livePerfHideTimerRef.current = window.setTimeout(() => {
      livePerfHideTimerRef.current = null
      setShowLivePerfDetails(false)
    }, 140)
  }, [])

  useEffect(() => {
    return () => {
      if (livePerfHideTimerRef.current) {
        window.clearTimeout(livePerfHideTimerRef.current)
      }
    }
  }, [])

  const handleBackgroundStaleReembed = useCallback(async () => {
    if (isBackgroundStaleReembedding || isRegeneratingStaleEmbeddings) {
      showToast('Stale embedding regeneration is already running', 'info')
      return
    }
    backgroundStaleCancelRef.current = false
    setBackgroundStaleCancelRequested(false)
    setIsBackgroundStaleReembedding(true)
    setBackgroundStaleProgress({ current: 0, total: 0 })
    showToast('Background stale embedding regeneration started', 'info')

    try {
      const result = await searchService.regenerateStaleEmbeddings((current, total) => {
        setBackgroundStaleProgress({ current, total })
      }, {
        shouldCancel: () => backgroundStaleCancelRef.current,
      })
      if (result.cancelled) {
        showToast(`Background stale regeneration cancelled: ${result.successCount}/${result.totalCandidates} updated`, 'warning')
      } else if (result.totalCandidates === 0) {
        showToast('Background stale regeneration complete: no stale embeddings found', 'success')
      } else if (result.successCount === result.totalCandidates) {
        showToast(`Background stale regeneration complete: ${result.successCount}/${result.totalCandidates} updated`, 'success')
      } else {
        showToast(`Background stale regeneration partial: ${result.successCount}/${result.totalCandidates} updated`, 'warning')
      }
      await refreshModelData()
    } catch {
      showToast('Background stale embedding regeneration failed', 'error')
    } finally {
      backgroundStaleCancelRef.current = false
      setBackgroundStaleCancelRequested(false)
      setIsBackgroundStaleReembedding(false)
      setBackgroundStaleProgress({ current: 0, total: 0 })
    }
  }, [isBackgroundStaleReembedding, isRegeneratingStaleEmbeddings, refreshModelData, showToast])

  const handleConsistencyRepair = useCallback(async () => {
    if (isRunningConsistencyRepair) return
    setIsRunningConsistencyRepair(true)
    setConsistencyRepairProgress({ current: 0, total: 0 })
    try {
      const report = await vaultConsistencyService.repair((current, total) => {
        setConsistencyRepairProgress({ current, total })
      })
      setConsistencyReport(report)
      await onVaultMutated?.()
      showToast(
        `Vault repair complete: ${report.removedOrphanEmbeddings} orphan embeddings removed, ${report.repairedReferences} references repaired`,
        'success',
      )
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Consistency repair failed', 'error')
    } finally {
      setIsRunningConsistencyRepair(false)
      setConsistencyRepairProgress({ current: 0, total: 0 })
      void refreshModelData()
      void refreshConsistencyReport()
    }
  }, [isRunningConsistencyRepair, onVaultMutated, refreshConsistencyReport, refreshModelData, showToast])

  const handleCancelBackgroundStaleReembed = useCallback(() => {
    if (!isBackgroundStaleReembedding || backgroundStaleCancelRef.current) return
    backgroundStaleCancelRef.current = true
    setBackgroundStaleCancelRequested(true)
    showToast('Cancel requested. Finishing current note before stopping...', 'info')
  }, [isBackgroundStaleReembedding, showToast])

  const handleModelChange = useCallback(async (field: 'textModel' | 'embeddingModel', value: string) => {
    if (!value.trim()) return
    const selectedModel = localAiModels.find((model) => model.name === value)
    if (selectedModel && !isModelCapabilityAllowed(field, selectedModel.capability)) {
      const fieldLabel = field === 'textModel' ? 'text generation' : 'embedding generation'
      showToast(
        `"${value}" is ${modelCapabilityLabel(selectedModel.capability).toLowerCase()}-oriented and cannot be used for ${fieldLabel}.`,
        'error',
      )
      return
    }
    setIsSavingModelSelection(true)
    try {
      localAiService.updateSettings({ [field]: value })
      if (field === 'embeddingModel') {
        showToast('Embedding model updated. Regenerate embeddings to keep Q&A accurate.', 'info')
      } else {
        showToast('Text model updated.', 'success')
      }
      await refreshModelData()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to update model setting', 'error')
    } finally {
      setIsSavingModelSelection(false)
    }
  }, [localAiModels, refreshModelData, showToast])

  const handleProviderChange = useCallback(async (provider: LocalAIProvider) => {
    setIsSavingModelSelection(true)
    try {
      const current = localAiService.getSettings()
      const nextBaseUrl = provider === 'lmstudio' ? 'http://127.0.0.1:1234' : 'http://localhost:11434'
      localAiService.updateSettings({
        provider,
        baseUrl: current.provider === provider ? current.baseUrl : nextBaseUrl,
      })
      showToast(`Switched local AI provider to ${localAiProviderLabel(provider)}`, 'success')
      await refreshModelData()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to update AI provider', 'error')
    } finally {
      setIsSavingModelSelection(false)
    }
  }, [refreshModelData, showToast])

  const handleRegenerateEmbeddingsFromSettings = useCallback(async () => {
    if (isBackgroundStaleReembedding) {
      showToast('Background stale regeneration is running. Cancel it or wait before regenerating all embeddings.', 'info')
      return
    }
    setIsRegeneratingEmbeddings(true)
    setRegenerationProgress({ current: 0, total: 0 })
    try {
      const successCount = await searchService.regenerateAllEmbeddings((current, total) => {
        setRegenerationProgress({ current, total })
      })
      showToast(`Successfully regenerated ${successCount} embeddings`, 'success')
      await refreshModelData()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to regenerate embeddings', 'error')
    } finally {
      setIsRegeneratingEmbeddings(false)
    }
  }, [isBackgroundStaleReembedding, refreshModelData, showToast])

  const handleRegenerateStaleEmbeddingsFromSettings = useCallback(async () => {
    if (isBackgroundStaleReembedding) {
      showToast('Background stale regeneration is already running. Cancel it from the command palette or wait for completion.', 'info')
      return
    }
    setIsRegeneratingStaleEmbeddings(true)
    setStaleRegenerationProgress({ current: 0, total: 0 })
    try {
      const result = await searchService.regenerateStaleEmbeddings((current, total) => {
        setStaleRegenerationProgress({ current, total })
      })
      if (result.totalCandidates === 0) {
        showToast('No stale or missing embeddings found.', 'success')
      } else {
        showToast(`Re-embedded ${result.successCount}/${result.totalCandidates} stale or missing embeddings`, 'success')
      }
      await refreshModelData()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to re-embed stale embeddings', 'error')
    } finally {
      setIsRegeneratingStaleEmbeddings(false)
    }
  }, [isBackgroundStaleReembedding, refreshModelData, showToast])

  const handleRetryFailedEmbeddings = useCallback(() => {
    const accepted = embeddingQueueService.retryFailed({ limit: 10 })
    if (accepted.length === 0) {
      showToast('No failed embedding jobs are ready to retry.', 'info')
      return
    }
    showToast(`Retrying ${accepted.length} failed embedding job${accepted.length === 1 ? '' : 's'}`, 'info')
  }, [showToast])

  const handleClearEmbeddingQueueErrors = useCallback(() => {
    embeddingQueueService.clearFailures()
    showToast('Embedding queue errors cleared', 'success')
  }, [showToast])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null
      if (element) {
        const tagName = element.tagName
        if (tagName === 'INPUT' || tagName === 'TEXTAREA' || element.isContentEditable) return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !event.shiftKey && !event.altKey) {
        event.preventDefault()
        setShowCommandPalette(true)
        setCommandQuery('')
        setSelectedCommandIndex(0)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      const element = target as HTMLElement | null
      if (!element) return false
      const tagName = element.tagName
      return tagName === 'INPUT' || tagName === 'TEXTAREA' || element.isContentEditable
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
      if (event.key !== ',') return
      event.preventDefault()
      setShowSettings(true)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      const element = target as HTMLElement | null
      if (!element) return false
      const tagName = element.tagName
      return tagName === 'INPUT' || tagName === 'TEXTAREA' || element.isContentEditable
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== 'e') return
      event.preventDefault()
      void handleBackgroundStaleReembed()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleBackgroundStaleReembed])

  const commands = useMemo(() => {
    const items: CommandItem[] = [
      {
        id: 'new-note',
        title: 'New Note',
        subtitle: 'Create a fresh note',
        keywords: 'create write note',
        group: 'Core',
        hotkey: '⌘N',
        detail: 'Starts a blank draft and puts cursor focus in the editor.',
        action: () => createNewNote(),
      },
      {
        id: 'keyword-search',
        title: 'Search Across Files',
        subtitle: 'Search note titles and content',
        keywords: 'search find text keyword',
        group: 'Core',
        hotkey: '⌘⇧F',
        detail: 'Traditional text search across file names and note content.',
        action: () => onOpenKeywordSearch?.(),
      },
      {
        id: 'open-settings',
        title: 'Open Settings',
        subtitle: 'Configure defaults, themes, and panel behavior',
        keywords: 'settings preferences defaults theme',
        group: 'Core',
        hotkey: '⌘,',
        detail: 'Adjust app-level behavior like editor defaults and layout.',
        action: () => setShowSettings(true),
      },
      {
        id: 'open-vault',
        title: 'Open Vault Folder',
        subtitle: 'Choose a different vault directory',
        keywords: 'folder vault open',
        group: 'Core',
        detail: 'Switch to another notes directory and reload the app context.',
        action: async () => {
          const vaultPath = await vaultService.openFolder()
          if (vaultPath) window.location.reload()
        },
      },
      {
        id: 'toggle-qa',
        title: 'Toggle Q&A Assistant',
        subtitle: 'Show or hide the right assistant panel',
        keywords: 'qa assistant panel chat',
        group: 'Core',
        hotkey: '⌘⇧K',
        detail: 'Quickly reveal the assistant when researching note context.',
        action: () => onToggleQAPanel?.(),
      },
      {
        id: 'toggle-sidebar',
        title: isSidebarVisible ? 'Hide File Tree' : 'Show File Tree',
        subtitle: 'Toggle the left notes panel',
        keywords: 'sidebar notes tree files panel',
        group: 'Core',
        hotkey: '⌘B',
        detail: 'Use this to focus writing or quickly bring back your note hierarchy.',
        action: () => onToggleSidebar?.(),
      },
      {
        id: 'toggle-topbar',
        title: isTopBarVisible ? 'Hide Top Bar' : 'Show Top Bar',
        subtitle: 'Toggle the top command bar',
        keywords: 'header top bar toolbar',
        group: 'Core',
        hotkey: '⌘⌥T',
        detail: 'Keeps screen space minimal while still letting you reopen controls fast.',
        action: () => onToggleTopBar?.(),
      },
      {
        id: 'reorganize',
        title: 'AI Reorganize Vault',
        subtitle: isBackgroundAnalyzing ? 'Background analysis in progress...' : 'Analyze and suggest structure improvements',
        keywords: 'organize sort move clean',
        group: 'AI',
        longRunning: true,
        detail: 'Runs full-vault analysis and prepares move/delete/merge suggestions.',
        runInBackground: () => handleStartReorganize(),
        action: () => handleStartReorganize(),
      },
      {
        id: 'reembed-stale',
        title: 'Re-embed Stale Embeddings',
        subtitle: isBackgroundStaleReembedding
          ? backgroundStaleCancelRequested
            ? backgroundStaleProgress.total > 0
              ? `Cancel requested... ${backgroundStaleProgress.current}/${backgroundStaleProgress.total}`
              : 'Cancel requested... stopping soon...'
            : backgroundStaleProgress.total > 0
              ? `Background stale regeneration ${backgroundStaleProgress.current}/${backgroundStaleProgress.total}...`
              : 'Background stale regeneration in progress...'
          : 'Refresh only stale/missing embeddings',
        keywords: 'embeddings stale refresh regenerate model',
        group: 'AI',
        hotkey: '⌘⇧E',
        longRunning: true,
        detail: 'Regenerates embeddings only for notes that are stale or missing for the selected embedding model.',
        runInBackground: handleBackgroundStaleReembed,
        action: () => handleBackgroundStaleReembed(),
      },
    ]

    if (onApplyLayoutPreset) {
      items.push(
        {
          id: 'layout-focus',
          title: 'Layout: Focus Writing',
          subtitle: 'Maximize writing focus with fewer side panes',
          keywords: 'layout preset focus writing',
          group: 'Layout',
          hotkey: '⌘⌥1',
          detail: 'Narrow sidebar, hide assistant panel, and prioritize writing space.',
          action: () => onApplyLayoutPreset('focus'),
        },
        {
          id: 'layout-balanced',
          title: 'Layout: Balanced',
          subtitle: 'Balanced writing and research setup',
          keywords: 'layout preset balanced',
          group: 'Layout',
          hotkey: '⌘⌥2',
          detail: 'Evenly balanced panes for writing and quick reference.',
          action: () => onApplyLayoutPreset('balanced'),
        },
        {
          id: 'layout-research',
          title: 'Layout: Research',
          subtitle: 'Wider assistant panel for analysis work',
          keywords: 'layout preset research',
          group: 'Layout',
          hotkey: '⌘⌥3',
          detail: 'Expands assistant panel for heavy Q&A and research workflows.',
          action: () => onApplyLayoutPreset('research'),
        }
      )
    }

    if (onResetLayout) {
      items.push({
        id: 'layout-reset',
        title: 'Layout: Reset Sizes',
        subtitle: 'Restore panel sizes to defaults',
        keywords: 'layout reset default',
        group: 'Layout',
        hotkey: '⌘⌥0',
        detail: 'Returns sidebar and assistant widths to default values.',
        action: () => onResetLayout(),
      })
    }

    return items
  }, [
    backgroundStaleCancelRequested,
    backgroundStaleProgress,
    createNewNote,
    handleBackgroundStaleReembed,
    handleStartReorganize,
    isBackgroundAnalyzing,
    isBackgroundStaleReembedding,
    isSidebarVisible,
    isTopBarVisible,
    onApplyLayoutPreset,
    onOpenKeywordSearch,
    onResetLayout,
    onToggleQAPanel,
    onToggleSidebar,
    onToggleTopBar,
    setShowSettings,
  ])

  const rankedCommands = useMemo(() => {
    const q = commandQuery.trim().toLowerCase()
    const recentSet = new Set(recentCommandIds)
    const base = commands
      .map(command => {
        const searchable = `${command.title} ${command.subtitle} ${command.keywords}`
        const score = q ? fuzzyScore(searchable, q) : 0
        return { command, score, isRecent: recentSet.has(command.id) }
      })
      .filter(item => (q ? item.score >= 0 : true))
      .sort((a, b) => {
        if (q) return b.score - a.score
        if (a.isRecent !== b.isRecent) return a.isRecent ? -1 : 1
        return a.command.title.localeCompare(b.command.title)
      })

    return base
  }, [commandQuery, commands, recentCommandIds])

  const visibleCommands = useMemo(() => rankedCommands.map(item => item.command), [rankedCommands])

  const commandById = useMemo(() => {
    const map = new Map<string, CommandItem>()
    commands.forEach(command => {
      map.set(command.id, command)
    })
    return map
  }, [commands])

  const shortcutLabelById = useMemo(() => {
    const map = new Map<string, string>()
    CUSTOM_SHORTCUT_OPTIONS.forEach(option => map.set(option.id, option.label))
    return map
  }, [])

  const assignedShortcutByCommandId = useMemo(() => {
    const map = new Map<string, string>()
    Object.entries(customShortcutAssignments).forEach(([shortcutId, commandId]) => {
      if (commandId) map.set(commandId, shortcutId)
    })
    return map
  }, [customShortcutAssignments])

  const getEffectiveHotkey = useCallback((command: CommandItem) => {
    const customShortcut = assignedShortcutByCommandId.get(command.id)
    if (customShortcut) {
      return shortcutLabelById.get(customShortcut) ?? command.hotkey ?? ''
    }
    return command.hotkey ?? ''
  }, [assignedShortcutByCommandId, shortcutLabelById])

  const groupedCommands = useMemo(() => {
    const groups: Array<{ name: string; commands: CommandItem[] }> = []
    const recentIdSet = new Set<string>()
    const pinnedIdSet = new Set<string>()

    const pinned = visibleCommands.filter(cmd => pinnedCommandIds.includes(cmd.id)).slice(0, 8)
    if (pinned.length > 0) {
      groups.push({ name: 'Pinned', commands: pinned })
      pinned.forEach(command => pinnedIdSet.add(command.id))
    }

    if (commandQuery.trim() === '') {
      const recent = visibleCommands
        .filter(cmd => recentCommandIds.includes(cmd.id) && !pinnedIdSet.has(cmd.id))
        .slice(0, 5)
      if (recent.length > 0) {
        groups.push({ name: 'Recent', commands: recent })
        recent.forEach(command => recentIdSet.add(command.id))
      }
    }
    ;(['Core', 'Layout', 'AI'] as CommandGroup[]).forEach(groupName => {
      const items = visibleCommands.filter(
        command => command.group === groupName && !recentIdSet.has(command.id) && !pinnedIdSet.has(command.id)
      )
      if (items.length > 0) groups.push({ name: groupName, commands: items })
    })
    return groups
  }, [commandQuery, pinnedCommandIds, recentCommandIds, visibleCommands])

  const flattenedGroupedCommands = useMemo(() => {
    return groupedCommands.flatMap(group => group.commands)
  }, [groupedCommands])

  useEffect(() => {
    const max = Math.max(0, flattenedGroupedCommands.length - 1)
    setSelectedCommandIndex(prev => Math.min(prev, max))
  }, [flattenedGroupedCommands.length])

  const commandIndexById = useMemo(() => {
    const map = new Map<string, number>()
    flattenedGroupedCommands.forEach((command, index) => {
      map.set(command.id, index)
    })
    return map
  }, [flattenedGroupedCommands])

  const selectedCommand = flattenedGroupedCommands[selectedCommandIndex] ?? null
  const selectedCommandCustomShortcut = selectedCommand ? assignedShortcutByCommandId.get(selectedCommand.id) ?? '' : ''

  const getCommandIcon = (group: CommandGroup) => {
    if (group === 'Core') {
      return (
        <svg className="w-4 h-4 text-slate-500 dark:text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 12h12M6 6h12M6 18h8" />
        </svg>
      )
    }
    if (group === 'Layout') {
      return (
        <svg className="w-4 h-4 text-blue-600 dark:text-blue-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5h16M4 12h16M4 19h16" />
        </svg>
      )
    }
    return (
      <svg className="w-4 h-4 text-violet-600 dark:text-violet-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3l1.6 3.2L17 8l-3.4 1.8L12 13l-1.6-3.2L7 8l3.4-1.8L12 3zM5 16l.9 1.8L8 18.9l-2.1 1.1L5 22l-.9-2-2.1-1.1 2.1-1.1L5 16zM19 16l.9 1.8 2.1 1.1-2.1 1.1L19 22l-.9-2-2.1-1.1 2.1-1.1L19 16z" />
      </svg>
    )
  }

  useEffect(() => {
    if (!showCommandPalette) return
    setSelectedCommandIndex(0)
  }, [commandQuery, showCommandPalette])

  const executeCommand = useCallback((selected: CommandItem, mode: 'normal' | 'background' = 'normal', closePalette = true) => {
    if (selected.id === 'reorganize' && isBackgroundAnalyzing) {
      return
    }
    if (selected.id === 'reembed-stale' && (isBackgroundStaleReembedding || isRegeneratingStaleEmbeddings)) {
      showToast('Background stale embedding regeneration is already running', 'info')
      return
    }

    if (closePalette) {
      setShowCommandPalette(false)
      setCommandQuery('')
    }

    setRecentCommandIds(prev => {
      const next = [selected.id, ...prev.filter(id => id !== selected.id)].slice(0, 8)
      localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next))
      return next
    })

    setCommandUsage(prev => {
      const next = { ...prev, [selected.id]: (prev[selected.id] ?? 0) + 1 }
      localStorage.setItem(COMMAND_USAGE_KEY, JSON.stringify(next))
      return next
    })

    const execute = mode === 'background' && selected.runInBackground ? selected.runInBackground : selected.action
    if (mode === 'background') showToast(`Running "${selected.title}" in background`, 'info')

    void Promise.resolve(execute()).catch(() => {
      showToast(`Command failed: ${selected.title}`, 'error')
    })
  }, [isBackgroundAnalyzing, isBackgroundStaleReembedding, isRegeneratingStaleEmbeddings, showToast])

  const runCommand = (index: number, mode: 'normal' | 'background' = 'normal') => {
    const selected = flattenedGroupedCommands[index]
    if (!selected) return
    executeCommand(selected, mode, true)
  }

  const runCommandById = useCallback((commandId: string, mode: 'normal' | 'background' = 'normal') => {
    const selected = commandById.get(commandId)
    if (!selected) return
    executeCommand(selected, mode, false)
  }, [commandById, executeCommand])

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      const element = target as HTMLElement | null
      if (!element) return false
      const tagName = element.tagName
      return tagName === 'INPUT' || tagName === 'TEXTAREA' || element.isContentEditable
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      for (const [shortcutId, commandId] of Object.entries(customShortcutAssignments)) {
        if (!commandId) continue
        if (!eventMatchesShortcut(event, shortcutId)) continue
        event.preventDefault()
        runCommandById(commandId)
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [customShortcutAssignments, runCommandById])

  const togglePinnedCommand = (commandId: string) => {
    setPinnedCommandIds(prev => {
      const next = prev.includes(commandId)
        ? prev.filter(id => id !== commandId)
        : [commandId, ...prev.filter(id => id !== commandId)].slice(0, 8)
      localStorage.setItem(PINNED_COMMANDS_KEY, JSON.stringify(next))
      return next
    })
  }

  const updateCustomShortcutForCommand = (commandId: string, shortcutId: string) => {
    setCustomShortcutAssignments(prev => {
      const next: Record<string, string> = {}
      Object.entries(prev).forEach(([assignedShortcut, assignedCommand]) => {
        if (assignedCommand !== commandId && assignedShortcut !== shortcutId) {
          next[assignedShortcut] = assignedCommand
        }
      })
      if (shortcutId) next[shortcutId] = commandId
      localStorage.setItem(CUSTOM_SHORTCUTS_KEY, JSON.stringify(next))
      return next
    })
  }

  const handlePaletteKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelectedCommandIndex(prev => Math.min(flattenedGroupedCommands.length - 1, prev + 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelectedCommandIndex(prev => Math.max(0, prev - 1))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if ((event.metaKey || event.ctrlKey) && selectedCommand?.longRunning) {
        runCommand(selectedCommandIndex, 'background')
        return
      }
      runCommand(selectedCommandIndex)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setShowCommandPalette(false)
      setCommandQuery('')
    }
  }

  const currentLocalAISettings = localAiService.getSettings()
  const localModelByName = useMemo(
    () => new Map(localAiModels.map((model) => [model.name, model])),
    [localAiModels],
  )

  const textModelOptions = useMemo(() => {
    const names = new Set([currentLocalAISettings.textModel, ...localAiModels.map((model) => model.name)])
    return Array.from(names)
      .map((name) => {
        const localModel = localModelByName.get(name)
        return {
          name,
          installed: Boolean(localModel),
          capability: localModel?.capability ?? 'unknown',
        }
      })
      .filter((model) => isModelCapabilityAllowed('textModel', model.capability))
      .sort((a, b) => {
        if (a.installed !== b.installed) return a.installed ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  }, [currentLocalAISettings.textModel, localModelByName, localAiModels])

  const embeddingModelOptions = useMemo(() => {
    const names = new Set([currentLocalAISettings.embeddingModel, ...localAiModels.map((model) => model.name)])
    return Array.from(names)
      .map((name) => {
        const localModel = localModelByName.get(name)
        return {
          name,
          installed: Boolean(localModel),
          capability: localModel?.capability ?? 'unknown',
        }
      })
      .filter((model) => isModelCapabilityAllowed('embeddingModel', model.capability))
      .sort((a, b) => {
        if (a.installed !== b.installed) return a.installed ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  }, [currentLocalAISettings.embeddingModel, localModelByName, localAiModels])

  const embeddingQueueBusy = embeddingQueueStatus.pending > 0 || embeddingQueueStatus.inFlight > 0
  const showEmbeddingQueueBadge = embeddingQueueBusy || Boolean(embeddingQueueStatus.lastError)
  const queueRecentFailures = embeddingQueueStatus.recentFailures.slice(0, 4)
  const staleReembeddingBusy = isRegeneratingStaleEmbeddings || isBackgroundStaleReembedding
  const perfSummaryByName = useMemo(
    () => new Map(perfMetricSummaries.map((metric) => [metric.name, metric])),
    [perfMetricSummaries],
  )
  const livePerfDetails = useMemo(
    () => ([
      { key: 'file_open_ms', label: 'File Open' },
      { key: 'vault_tree_load_ms', label: 'Vault Tree' },
      { key: 'keyword_search_ms', label: 'Keyword Search' },
      { key: 'sidebar_backlinks_ms', label: 'Backlinks' },
      { key: 'sidebar_related_ms', label: 'Related Notes' },
      { key: 'ai_readable_load_ms', label: 'AI Doc Load' },
      { key: 'search_retrieval_ms', label: 'Search Retrieval' },
      { key: 'qa_single_ms', label: 'Q&A Single' },
      { key: 'qa_multi_ms', label: 'Q&A Multi' },
      { key: 'reorg_analyze_ms', label: 'Reorganize Analyze' },
      { key: 'regen_stale_embeddings_ms', label: 'Re-embed Stale' },
      { key: 'regen_all_embeddings_ms', label: 'Re-embed All' },
    ] as const).map((item) => {
      const metric = perfSummaryByName.get(item.key)
      return {
        label: item.label,
        count: metric?.count ?? 0,
        lastMs: metric?.lastMs ?? 0,
        p95Ms: metric?.p95Ms ?? 0,
      }
    }),
    [perfSummaryByName],
  )
  const retrievalP95 = perfSummaryByName.get('search_retrieval_ms')?.p95Ms ?? 0
  const qaP95 = perfSummaryByName.get('qa_multi_ms')?.p95Ms ?? perfSummaryByName.get('qa_single_ms')?.p95Ms ?? 0
  const reorgP95 = perfSummaryByName.get('reorg_analyze_ms')?.p95Ms ?? 0
  const semanticCacheHitRatePct = semanticCacheStats.queries > 0
    ? Math.round((semanticCacheStats.hits / semanticCacheStats.queries) * 100)
    : 0

  return (
    <header className="min-h-14 vn-surface vn-glass flex items-center justify-between px-4 py-2 vn-panel-enter relative z-40 overflow-visible gap-3">
      <div className="flex items-center gap-4">
        <h1 className="text-base font-extrabold text-slate-900 dark:text-white tracking-tight">Pipnote</h1>
      </div>
      <div className="flex flex-1 min-w-0 items-center justify-end gap-3 overflow-visible">
        <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => void goBack()}
          disabled={!canGoBack}
          className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed vn-focusable vn-interactive vn-pressable"
          aria-label="Go back"
          title="Back (⌘[)"
        >
          <svg className="w-5 h-5 text-gray-600 dark:text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <button
          onClick={() => void goForward()}
          disabled={!canGoForward}
          className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed vn-focusable vn-interactive vn-pressable"
          aria-label="Go forward"
          title="Forward (⌘])"
        >
          <svg className="w-5 h-5 text-gray-600 dark:text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <button
          onClick={onToggleSidebar}
          className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors vn-focusable vn-interactive vn-pressable"
          aria-label={isSidebarVisible ? 'Hide file tree' : 'Show file tree'}
          title={`${isSidebarVisible ? 'Hide' : 'Show'} File Tree (⌘B)`}
        >
          <svg className="w-5 h-5 text-gray-600 dark:text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5h16M4 12h7m-7 7h16M15 9l3 3-3 3" />
          </svg>
        </button>
        <button
          onClick={onToggleTopBar}
          className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors vn-focusable vn-interactive vn-pressable"
          aria-label={isTopBarVisible ? 'Hide top bar' : 'Show top bar'}
          title={`${isTopBarVisible ? 'Hide' : 'Show'} Top Bar (⌘⌥T)`}
        >
          <svg className="w-5 h-5 text-gray-600 dark:text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h18v14H3V5zm0 4h18" />
          </svg>
        </button>
        {onApplyLayoutPreset && (
          <div className="relative">
            <button
              onClick={() => setShowLayoutMenu(prev => !prev)}
              className="flex items-center gap-2 px-3 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-900 dark:text-white rounded-lg text-[13px] font-medium transition-colors vn-focusable vn-interactive vn-pressable"
              title="Layout presets"
            >
              <svg className="w-4 h-4 text-slate-600 dark:text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5h7v6H4V5zm9 0h7v4h-7V5zM4 13h7v6H4v-6zm9-2h7v8h-7v-8z" />
              </svg>
              <span>Layout</span>
            </button>
            {showLayoutMenu && (
              <>
                <div className="fixed inset-0 z-[70]" onClick={() => setShowLayoutMenu(false)} />
                <div className="absolute right-0 top-12 z-[80] w-64 vn-surface rounded-xl shadow-xl p-3 space-y-2">
                  <p className="text-xs uppercase tracking-wide vn-muted px-1">Presets</p>
                  <button
                    onClick={() => {
                      onApplyLayoutPreset('focus')
                      setShowLayoutMenu(false)
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-[13px] vn-focusable vn-interactive"
                  >
                    Focus Writing
                  </button>
                  <button
                    onClick={() => {
                      onApplyLayoutPreset('balanced')
                      setShowLayoutMenu(false)
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-[13px] vn-focusable vn-interactive"
                  >
                    Balanced
                  </button>
                  <button
                    onClick={() => {
                      onApplyLayoutPreset('research')
                      setShowLayoutMenu(false)
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-[13px] vn-focusable vn-interactive"
                  >
                    Research
                  </button>
                  <div className="h-px bg-slate-200 dark:bg-slate-700 my-1" />
                  <button
                    onClick={() => {
                      onResetLayout?.()
                      setShowLayoutMenu(false)
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-[13px] vn-focusable vn-interactive"
                  >
                    Reset Sizes
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Keyboard Shortcuts Help */}
        <div className="relative">
          <button
            onClick={() => setShowShortcuts(!showShortcuts)}
            className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors vn-focusable vn-interactive vn-pressable"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts"
          >
            <svg className="w-5 h-5 text-gray-600 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>

          {showShortcuts && (
            <>
              <div className="fixed inset-0 z-[70]" onClick={() => setShowShortcuts(false)} />
              <div className="absolute right-0 top-12 z-[80] w-72 vn-surface rounded-xl shadow-xl p-4">
                <h3 className="text-[13px] font-semibold text-slate-900 dark:text-white mb-3">Keyboard Shortcuts</h3>
                <div className="space-y-2 text-[13px]">
                  <div className="flex justify-between">
                    <span className="text-slate-600 dark:text-slate-300">New Note</span>
                    <kbd className="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded text-xs">⌘N</kbd>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600 dark:text-slate-300">Find in Current File</span>
                    <kbd className="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded text-xs">⌘F</kbd>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600 dark:text-slate-300">Keyword Search</span>
                    <kbd className="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded text-xs">⌘⇧F</kbd>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600 dark:text-slate-300">Save Note</span>
                    <kbd className="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded text-xs">⌘S</kbd>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600 dark:text-slate-300">Toggle File Tree</span>
                    <kbd className="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded text-xs">⌘B</kbd>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600 dark:text-slate-300">Toggle Top Bar</span>
                    <kbd className="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded text-xs">⌘⌥T</kbd>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600 dark:text-slate-300">Focus Q&A</span>
                    <kbd className="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded text-xs">⌘⇧K</kbd>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600 dark:text-slate-300">Command Palette</span>
                    <kbd className="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded text-xs">⌘K</kbd>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600 dark:text-slate-300">Re-embed Stale</span>
                    <kbd className="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded text-xs">⌘⇧E</kbd>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600 dark:text-slate-300">Layout Presets</span>
                    <kbd className="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded text-xs">⌘⌥1/2/3</kbd>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600 dark:text-slate-300">Reset Layout</span>
                    <kbd className="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded text-xs">⌘⌥0</kbd>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600 dark:text-slate-300">Resize Sidebar</span>
                    <kbd className="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded text-xs">⌘⌥[ / ]</kbd>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600 dark:text-slate-300">Resize Q&A</span>
                    <kbd className="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded text-xs">⌘⌥- / =</kbd>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        </div>

        <div className="min-w-0 flex-1 flex items-center justify-end gap-2 overflow-visible">
        {showEmbeddingQueueBadge && (
          <div
            className={`hidden xl:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-medium border shrink-0 ${
              embeddingQueueBusy
                ? 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800'
                : 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800'
            }`}
            title={
              embeddingQueueBusy
                ? `Embedding queue running: ${embeddingQueueStatus.inFlight} processing, ${embeddingQueueStatus.pending} queued`
                : `Embedding queue warning: ${embeddingQueueStatus.lastError || 'Unknown error'}`
            }
          >
            {embeddingQueueBusy ? (
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 12a8 8 0 018-8m8 8a8 8 0 01-8 8" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M4.93 19h14.14c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.2 16c-.77 1.33.19 3 1.73 3z" />
              </svg>
            )}
            <span>
              {embeddingQueueBusy
                ? `Embedding Queue ${embeddingQueueStatus.inFlight + embeddingQueueStatus.pending}`
                : 'Embedding Queue Warning'}
            </span>
          </div>
        )}

        <div
          className="hidden xl:block relative shrink min-w-0"
          onMouseEnter={openLivePerfDetails}
          onMouseLeave={scheduleHideLivePerfDetails}
        >
          <div
            tabIndex={0}
            onFocus={openLivePerfDetails}
            onBlur={scheduleHideLivePerfDetails}
            className="flex max-w-full items-center gap-2 px-2 py-1.5 rounded-lg border border-slate-200/80 dark:border-slate-700/80 bg-white/75 dark:bg-slate-900/45 text-[10px] overflow-x-auto no-scrollbar"
          >
            <span className="uppercase tracking-wide text-[9px] font-semibold text-[color:var(--vn-brand)]">Live</span>
            <span className="text-slate-700 dark:text-slate-200">Search p95 {formatDurationCompactMs(retrievalP95)}</span>
            <span className="text-slate-700 dark:text-slate-200">Q&A p95 {formatDurationCompactMs(qaP95)}</span>
            <span className="text-slate-700 dark:text-slate-200">Reorg p95 {formatDurationCompactMs(reorgP95)}</span>
            <span className="text-slate-600 dark:text-slate-300">Queue {embeddingQueueStatus.inFlight} active • {embeddingQueueStatus.pending} queued</span>
            <span className="text-slate-600 dark:text-slate-300">PostQ {postProcessingStatus.pending}</span>
            <span className="text-slate-600 dark:text-slate-300">SemCache H{semanticCacheStats.hits} / M{semanticCacheStats.misses}</span>
            <span className={`px-1.5 py-0.5 rounded ${
              embeddingQueueStatus.typingPressure === 'high'
                ? 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-200'
                : embeddingQueueStatus.typingPressure === 'medium'
                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
                  : embeddingQueueStatus.typingPressure === 'low'
                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200'
                    : 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200'
            }`}>
              Typing {embeddingQueueStatus.typingPressure}
            </span>
          </div>

          {showLivePerfDetails && (
            <div
              className="absolute right-0 top-[calc(100%+8px)] z-[90] w-80 rounded-xl border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 shadow-xl p-3"
              onMouseEnter={openLivePerfDetails}
              onMouseLeave={scheduleHideLivePerfDetails}
            >
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-200">Performance Details</p>
              <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
                Queue: {embeddingQueueStatus.backlogSize} jobs ({embeddingQueueStatus.backlogTier}) • Workers {embeddingQueueStatus.effectiveConcurrency}/{embeddingQueueStatus.configuredMaxConcurrency} • Batch {embeddingQueueStatus.batchSize}
              </p>
              <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
                Queue wait: avg {formatDurationCompactMs(embeddingQueueStatus.queueWaitAvgMs)} • p95 {formatDurationCompactMs(embeddingQueueStatus.queueWaitP95Ms)} • Active hit {Math.round(embeddingQueueStatus.activePathHitRate * 100)}% (n={embeddingQueueStatus.activePathHitSamples})
              </p>
              <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
                Post-process queue: pending {postProcessingStatus.pending} • queued {postProcessingStatus.queued} • in-flight {postProcessingStatus.inFlight} • processed {postProcessingStatus.processed}
              </p>
              <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
                Semantic cache: entries {semanticCacheStats.entries} • hit rate {semanticCacheHitRatePct}% • hits {semanticCacheStats.hits} • misses {semanticCacheStats.misses} • rebuilds {semanticCacheStats.rebuilds}
              </p>
              <div className="mt-2 space-y-1.5">
                {livePerfDetails.map((metric) => (
                  <div key={metric.label} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-slate-700 dark:text-slate-200">{metric.label}</span>
                    <span className="text-slate-500 dark:text-slate-400">
                      last {formatDurationCompactMs(metric.lastMs)} • p95 {formatDurationCompactMs(metric.p95Ms)} • n={metric.count}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        </div>

        <button
          onClick={onOpenKeywordSearch}
          className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors vn-focusable vn-interactive vn-pressable"
          aria-label="Keyword search"
          title="Search Across Files (⌘⇧F)"
        >
          <svg className="w-5 h-5 text-gray-600 dark:text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.3-4.3M10.8 18a7.2 7.2 0 100-14.4 7.2 7.2 0 000 14.4z" />
          </svg>
        </button>

        <button
          onClick={() => setShowSettings(true)}
          className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors vn-focusable vn-interactive vn-pressable"
          aria-label="Open settings"
          title="Settings (⌘,)"
        >
          <svg className="w-5 h-5 text-gray-600 dark:text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h13M21 18h-1" />
            <circle cx="15" cy="6" r="2" />
            <circle cx="7" cy="12" r="2" />
            <circle cx="19" cy="18" r="2" />
          </svg>
        </button>

        <button
          onClick={toggleTheme}
          className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors vn-focusable vn-interactive vn-pressable"
          aria-label="Toggle light and dark mode"
          title={`Switch to ${mode === 'light' ? 'dark' : 'light'} mode (${activeThemeFamily?.name || 'Theme'})`}
        >
          {mode === 'light' ? (
            <svg className="w-5 h-5 text-gray-900 dark:text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
            </svg>
          ) : (
            <svg className="w-5 h-5 text-gray-900 dark:text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          )}
        </button>
        <button
          onClick={async () => {
            const vaultPath = await vaultService.openFolder()
            if (vaultPath) {
              window.location.reload()
            }
          }}
          className="px-4 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-900 dark:text-white rounded-lg text-sm font-medium transition-colors vn-focusable vn-interactive vn-pressable"
          title="Open Vault Folder..."
        >
          Open Vault...
        </button>
        <button
          onClick={createNewNote}
          className="px-4 py-2 vn-btn-primary text-white rounded-lg text-sm font-semibold transition-colors vn-focusable vn-interactive vn-pressable"
          title="New Note (⌘N)"
        >
          New Note
        </button>
      </div>

      {showSettings && createPortal(
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[130] flex items-center justify-center p-4">
          <div className="vn-surface rounded-2xl shadow-2xl w-full max-w-xl max-h-[86vh] overflow-hidden flex flex-col">
            <div
              className="px-5 py-4 border-b border-slate-200 dark:border-slate-700"
              style={{
                background: 'linear-gradient(110deg, color-mix(in srgb, var(--vn-brand) 14%, var(--vn-surface)), color-mix(in srgb, var(--vn-brand) 6%, var(--vn-surface-2)))',
              }}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">Settings</h3>
                <button
                  onClick={() => setShowSettings(false)}
                  className="p-1.5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 vn-interactive"
                  aria-label="Close settings"
                >
                  <svg className="w-4 h-4 text-slate-600 dark:text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
              <p className="text-[11px] vn-muted mt-1">Customize app behavior and editing defaults.</p>
            </div>

            <div className="border-b border-slate-200 dark:border-slate-700 px-5 py-3 bg-white/60 dark:bg-slate-950/30">
              <div className="flex flex-wrap gap-2">
                {SETTINGS_SECTIONS.map((section) => (
                  <button
                    key={section.id}
                    onClick={() => setActiveSettingsSection(section.id)}
                    className={`px-3 py-1.5 rounded-full text-[10px] font-semibold transition-colors vn-interactive ${
                      activeSettingsSection === section.id
                        ? 'bg-[color:var(--vn-brand)] text-white'
                        : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200'
                    }`}
                  >
                    {section.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[10px] vn-muted">
                {SETTINGS_SECTIONS.find((section) => section.id === activeSettingsSection)?.description}
              </p>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              <section className={`space-y-3 ${activeSettingsSection !== 'appearance' ? 'hidden' : ''}`}>
                <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-200">Appearance</h4>

                <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-700 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[13px] font-medium text-slate-900 dark:text-slate-100">Color Mode</p>
                      <p className="text-[11px] vn-muted">Switch between light and dark for the selected theme family.</p>
                    </div>
                    <div className="inline-flex rounded-lg border border-slate-300 dark:border-slate-600 overflow-hidden">
                      <button
                        onClick={() => setMode('light')}
                        className={`px-3 py-1.5 text-[11px] font-semibold transition-colors ${
                          mode === 'light'
                            ? 'vn-btn-primary text-white'
                            : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                        }`}
                      >
                        Light
                      </button>
                      <button
                        onClick={() => setMode('dark')}
                        className={`px-3 py-1.5 text-[11px] font-semibold transition-colors ${
                          mode === 'dark'
                            ? 'vn-btn-primary text-white'
                            : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                        }`}
                      >
                        Dark
                      </button>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {themeFamilies.map((themeOption) => {
                    const isActive = family === themeOption.id
                    const swatch = THEME_SWATCHES[themeOption.id]
                    const chips = mode === 'dark' ? swatch.dark : swatch.light
                    return (
                      <button
                        key={themeOption.id}
                        onClick={() => setFamily(themeOption.id)}
                        className={`text-left p-3 rounded-lg transition-all vn-interactive ${
                          isActive
                            ? 'border-2'
                            : 'border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-500'
                        }`}
                        style={isActive
                          ? {
                              borderColor: 'var(--vn-brand)',
                              backgroundColor: 'color-mix(in srgb, var(--vn-brand) 10%, transparent)',
                            }
                          : undefined}
                        title={`${themeOption.name} • ${themeOption.tagline}`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <p className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">{themeOption.name}</p>
                          {isActive && (
                            <span className="text-[9px] uppercase tracking-wide font-semibold text-[color:var(--vn-brand)]">
                              Active
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-600 dark:text-slate-300">{themeOption.tagline}</p>
                        <div className="mt-2 flex items-center gap-1.5">
                          {chips.map((chipColor) => (
                            <span
                              key={chipColor}
                              className="h-3 w-8 rounded-md border border-black/10 dark:border-white/15"
                              style={{ backgroundColor: chipColor }}
                            />
                          ))}
                        </div>
                        <p className="text-[10px] vn-muted mt-2">{themeOption.insight}</p>
                      </button>
                    )
                  })}
                </div>
              </section>

              <section className={`space-y-3 ${activeSettingsSection !== 'editor' ? 'hidden' : ''}`}>
                <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-200">Editor</h4>
                <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                  <p className="text-[13px] font-medium text-slate-900 dark:text-slate-100">Live Save</p>
                  <p className="text-[11px] vn-muted">Notes are saved continuously while you type.</p>
                </div>

                <label className="block p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                  <p className="text-[13px] font-medium text-slate-900 dark:text-slate-100 mb-2">Default Editor View</p>
                  <select
                    value={settings.defaultEditorViewMode}
                    onChange={(e) => updateSetting('defaultEditorViewMode', e.target.value as 'edit' | 'preview' | 'split')}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-[13px]"
                  >
                    <option value="edit">Edit</option>
                    <option value="preview">Preview</option>
                    <option value="split">Split</option>
                  </select>
                </label>

                <label className="flex items-center justify-between gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                  <div>
                    <p className="text-[13px] font-medium text-slate-900 dark:text-slate-100">Default Reading Mode</p>
                    <p className="text-[11px] vn-muted">Use reading typography by default.</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.defaultReadingMode}
                    onChange={(e) => updateSetting('defaultReadingMode', e.target.checked)}
                    className="h-4 w-4"
                  />
                </label>
              </section>

              <section className={`space-y-3 ${activeSettingsSection !== 'ai' ? 'hidden' : ''}`}>
                <div className="flex items-center justify-between">
                  <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-200">AI & Models</h4>
                  <button
                    onClick={() => void refreshModelData()}
                    disabled={isLoadingModelData || isSavingModelSelection || isRegeneratingEmbeddings || staleReembeddingBusy}
                    className="px-2 py-1 text-[10px] rounded-md bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-100 disabled:opacity-50 vn-interactive"
                  >
                    {isLoadingModelData ? 'Refreshing...' : 'Refresh'}
                  </button>
                </div>

                <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                  <p className="text-[13px] font-medium text-slate-900 dark:text-slate-100">Local AI Provider</p>
                  <select
                    value={currentLocalAISettings.provider}
                    onChange={(e) => void handleProviderChange(e.target.value === 'lmstudio' ? 'lmstudio' : 'ollama')}
                    disabled={isLoadingModelData || isSavingModelSelection || staleReembeddingBusy}
                    className="mt-2 w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-[13px] disabled:opacity-60"
                  >
                    <option value="ollama">Ollama</option>
                    <option value="lmstudio">LM Studio</option>
                  </select>
                  <p className="text-[11px] vn-muted mt-2">
                    Choose which local AI runtime Pipnote should use for text generation and embeddings.
                  </p>
                </div>

                <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                  <p className="text-[13px] font-medium text-slate-900 dark:text-slate-100">Server Base URL</p>
                  <p className="text-[11px] font-mono mt-1 text-slate-700 dark:text-slate-300">{currentLocalAISettings.baseUrl}</p>
                  <p className="text-[11px] vn-muted mt-2">
                    Pipnote is currently using {localAiProviderLabel(currentLocalAISettings.provider)} at this address.
                  </p>
                </div>

                {modelDataError && (
                  <div className="p-3 rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-[11px] text-red-700 dark:text-red-300">
                    {modelDataError}
                  </div>
                )}

                <label className="block p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                  <p className="text-[13px] font-medium text-slate-900 dark:text-slate-100 mb-2">Text Model</p>
                  <select
                    value={currentLocalAISettings.textModel}
                    onChange={(e) => void handleModelChange('textModel', e.target.value)}
                    disabled={isLoadingModelData || isSavingModelSelection || staleReembeddingBusy || textModelOptions.length === 0}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-[13px] disabled:opacity-60"
                  >
                    {textModelOptions.map((model) => (
                      <option key={model.name} value={model.name}>
                        {model.name}{model.installed ? ` (${modelCapabilityLabel(model.capability)})` : ' (Not installed)'}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] vn-muted mt-2">
                    {!modelSelectionStatus
                      ? 'Select a model for text generation.'
                      : !modelSelectionStatus.textModelAvailable
                        ? `Selected text model is missing from local ${localAiProviderLabel(currentLocalAISettings.provider)}.`
                        : !modelSelectionStatus.textModelCapabilityValid
                          ? 'Selected text model appears embedding-only. Pick a text-capable model.'
                          : 'Selected text model is installed and capability-compatible.'}
                  </p>
                </label>

                <label className="block p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                  <p className="text-[13px] font-medium text-slate-900 dark:text-slate-100 mb-2">Embedding Model</p>
                  <select
                    value={currentLocalAISettings.embeddingModel}
                    onChange={(e) => void handleModelChange('embeddingModel', e.target.value)}
                    disabled={isLoadingModelData || isSavingModelSelection || staleReembeddingBusy || embeddingModelOptions.length === 0}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-[13px] disabled:opacity-60"
                  >
                    {embeddingModelOptions.map((model) => (
                      <option key={model.name} value={model.name}>
                        {model.name}{model.installed ? ` (${modelCapabilityLabel(model.capability)})` : ' (Not installed)'}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] vn-muted mt-2">
                    {!modelSelectionStatus
                      ? 'Select a model for embedding generation.'
                      : !modelSelectionStatus.embeddingModelAvailable
                        ? `Selected embedding model is missing from local ${localAiProviderLabel(currentLocalAISettings.provider)}.`
                        : !modelSelectionStatus.embeddingModelCapabilityValid
                          ? 'Selected embedding model appears text-only. Pick an embedding-capable model.'
                          : 'Selected embedding model is installed and capability-compatible.'}
                  </p>
                </label>

                {embeddingModelStatus && (
                  <div className={`p-3 rounded-lg border text-[11px] ${
                    embeddingModelStatus.isStale
                      ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200'
                      : 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-800 dark:text-emerald-200'
                  }`}>
                    <p className="font-medium mb-1">
                      {embeddingModelStatus.isStale ? 'Embeddings need refresh' : 'Embeddings match selected model'}
                    </p>
                    <p>
                      Total: {embeddingModelStatus.totalEmbeddings} • Current-model: {embeddingModelStatus.upToDateCount} • Stale: {embeddingModelStatus.staleCount}
                    </p>
                    {embeddingModelStatus.observedModels.length > 0 && (
                      <p className="mt-1 break-all">
                        Observed models: {embeddingModelStatus.observedModels.join(', ')}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => void handleRegenerateEmbeddingsFromSettings()}
                        disabled={isRegeneratingEmbeddings || staleReembeddingBusy || isLoadingModelData}
                        className="px-3 py-1.5 rounded-md vn-btn-primary text-white text-[11px] disabled:opacity-60 vn-interactive"
                      >
                        {isRegeneratingEmbeddings ? 'Regenerating All...' : 'Regenerate All'}
                      </button>
                      <button
                        onClick={() => void handleRegenerateStaleEmbeddingsFromSettings()}
                        disabled={isRegeneratingEmbeddings || staleReembeddingBusy || isLoadingModelData}
                        className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] disabled:opacity-60 vn-interactive"
                      >
                        {isRegeneratingStaleEmbeddings ? 'Re-embedding Stale...' : isBackgroundStaleReembedding ? 'Background Stale Run Active' : 'Re-embed Stale Only'}
                      </button>
                    </div>
                    {indexHealthDetails && (
                      <div className="mt-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white/70 dark:bg-slate-950/30 p-3">
                        <p className="font-medium text-slate-900 dark:text-slate-100 mb-1">
                          Index health: {indexHealthDetails.indexedCount}/{indexHealthDetails.eligibleCount} indexed
                        </p>
                        <p className="text-slate-600 dark:text-slate-300">
                          Failed: {indexHealthDetails.failedCount} • Stale: {indexHealthDetails.staleCount} • Missing: {Math.max(0, indexHealthDetails.eligibleCount - indexHealthDetails.indexedCount)}
                        </p>
                        <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
                          AI-readable files: text notes, PDFs, DOCX, PPTX, XLSX, and CSV. Images stay preview-only for now.
                        </p>
                        {indexHealthDetails.issues.length > 0 && (
                          <div className="mt-2 space-y-2 max-h-36 overflow-y-auto pr-1">
                            {indexHealthDetails.issues.slice(0, 6).map((issue) => (
                              <div key={`${issue.type}-${issue.path}`} className="rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1.5">
                                <div className="flex items-center gap-2">
                                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${
                                    issue.type === 'failed'
                                      ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                                      : issue.type === 'missing'
                                        ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300'
                                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                                  }`}>
                                    {issue.type}
                                  </span>
                                  <span className="font-mono text-[9px] break-all">{issue.path}</span>
                                </div>
                                <p className="mt-1 text-[10px] text-slate-600 dark:text-slate-300">{issue.detail || issue.reason}</p>
                                {/\.(pdf|docx|pptx|xlsx|csv)$/i.test(issue.path) && (
                                  <p className="mt-1 text-[9px] text-sky-700 dark:text-sky-300">
                                    This document needs readable extracted text for reliable embeddings and Q&amp;A.
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {isRegeneratingEmbeddings && regenerationProgress.total > 0 && (
                      <div className="mt-2">
                        <div className="flex items-center justify-between mb-1">
                          <span>{regenerationProgress.current}/{regenerationProgress.total}</span>
                          <span>{Math.round((regenerationProgress.current / Math.max(1, regenerationProgress.total)) * 100)}%</span>
                        </div>
                        <div className="w-full bg-slate-300/70 dark:bg-slate-700/80 rounded-full h-1.5 overflow-hidden">
                          <div
                            className="h-full transition-all duration-300"
                            style={{
                              backgroundColor: 'var(--vn-brand)',
                              width: `${(regenerationProgress.current / Math.max(1, regenerationProgress.total)) * 100}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}
                    {isRegeneratingStaleEmbeddings && staleRegenerationProgress.total > 0 && (
                      <div className="mt-2">
                        <div className="flex items-center justify-between mb-1">
                          <span>{staleRegenerationProgress.current}/{staleRegenerationProgress.total}</span>
                          <span>{Math.round((staleRegenerationProgress.current / Math.max(1, staleRegenerationProgress.total)) * 100)}%</span>
                        </div>
                        <div className="w-full bg-slate-300/70 dark:bg-slate-700/80 rounded-full h-1.5 overflow-hidden">
                          <div
                            className="bg-emerald-600 h-full transition-all duration-300"
                            style={{ width: `${(staleRegenerationProgress.current / Math.max(1, staleRegenerationProgress.total)) * 100}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className={`p-3 rounded-lg border text-[11px] ${
                  embeddingQueueBusy
                    ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200'
                    : queueRecentFailures.length > 0
                      ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200'
                      : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                }`}>
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium">Embedding Queue</p>
                    <span className={`px-2 py-0.5 rounded text-[9px] font-semibold ${
                      embeddingQueueBusy
                        ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                        : queueRecentFailures.length > 0
                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                          : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                    }`}>
                      {embeddingQueueBusy ? 'Running' : queueRecentFailures.length > 0 ? 'Needs Attention' : 'Healthy'}
                    </span>
                  </div>

                  <p className="mt-1">
                    Pending: {embeddingQueueStatus.pending} • In-flight: {embeddingQueueStatus.inFlight} • Processed: {embeddingQueueStatus.processed} • Success: {embeddingQueueStatus.succeeded} • Failed: {embeddingQueueStatus.failed}
                  </p>
                  <p className="mt-1">
                    Backlog: {embeddingQueueStatus.backlogSize} jobs • Tier: {embeddingQueueStatus.backlogTier}
                  </p>
                  <p className="mt-1">
                    Mode: {embeddingQueueStatus.schedulingMode === 'adaptive' ? 'Adaptive' : 'Manual'} • Workers: {embeddingQueueStatus.effectiveConcurrency}/{embeddingQueueStatus.configuredMaxConcurrency} • Batch: {embeddingQueueStatus.batchSize} • Avg task: {formatDurationMs(embeddingQueueStatus.avgTaskMs)} • P95 task: {formatDurationMs(embeddingQueueStatus.p95TaskMs)}
                  </p>
                  <p className="mt-1">
                    Queue wait avg: {formatDurationMs(embeddingQueueStatus.queueWaitAvgMs)} • Queue wait p95: {formatDurationMs(embeddingQueueStatus.queueWaitP95Ms)}
                  </p>
                  <p className="mt-1">
                    Active-path hit rate: {Math.round(embeddingQueueStatus.activePathHitRate * 100)}% ({embeddingQueueStatus.activePathHitSamples} samples)
                  </p>
                  <p className="mt-1">
                    Typing pressure: {embeddingQueueStatus.typingPressure} • Speed: {Math.round(embeddingQueueStatus.typingCharsPerSecond * 10) / 10} chars/s
                  </p>
                  <p className="mt-1">
                    Post-process queue: pending {postProcessingStatus.pending} • queued {postProcessingStatus.queued} • scheduled {postProcessingStatus.scheduled} • in-flight {postProcessingStatus.inFlight}
                  </p>
                  <p className="mt-1">
                    Semantic cache: queries {semanticCacheStats.queries} • hit rate {semanticCacheHitRatePct}% • hits {semanticCacheStats.hits} • misses {semanticCacheStats.misses} • rebuilds {semanticCacheStats.rebuilds} • entries {semanticCacheStats.entries}
                  </p>
                  <p className="mt-1 break-all">
                    Last processed: {embeddingQueueStatus.lastProcessedPath || 'n/a'} ({formatQueueTime(embeddingQueueStatus.lastProcessedAt)})
                  </p>
                  <p className="mt-1 break-all">
                    Last success: {embeddingQueueStatus.lastSuccessPath || 'n/a'} ({formatQueueTime(embeddingQueueStatus.lastSuccessAt)})
                  </p>
                  <p className="mt-1 break-all">
                    Post-process last: {postProcessingStatus.lastProcessedPath || 'n/a'} ({formatQueueTime(postProcessingStatus.lastProcessedAt)})
                  </p>
                  <p className="mt-1 break-all">
                    Semantic cache last build: {formatIsoTime(semanticCacheStats.last_built_at)}
                  </p>

                  <label className="mt-2 flex items-center justify-between gap-3 rounded-md border border-slate-200/70 dark:border-slate-700/70 bg-white/70 dark:bg-slate-900/25 px-2.5 py-1.5">
                    <span className="text-[10px] font-medium text-slate-700 dark:text-slate-200">Scheduling Mode</span>
                    <select
                      value={settings.embeddingQueueSchedulingMode}
                      onChange={(event) => updateSetting('embeddingQueueSchedulingMode', event.target.value === 'manual' ? 'manual' : 'adaptive')}
                      className="px-2 py-1 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-[11px]"
                    >
                      <option value="adaptive">Adaptive (recommended)</option>
                      <option value="manual">Manual</option>
                    </select>
                  </label>

                  <label className="mt-2 flex items-center justify-between gap-3 rounded-md border border-slate-200/70 dark:border-slate-700/70 bg-white/70 dark:bg-slate-900/25 px-2.5 py-1.5">
                    <span className="text-[10px] font-medium text-slate-700 dark:text-slate-200">Max Workers</span>
                    <select
                      value={settings.embeddingQueueConcurrency}
                      onChange={(event) => updateSetting('embeddingQueueConcurrency', Number(event.target.value))}
                      className="px-2 py-1 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-[11px]"
                    >
                      <option value={1}>1 worker</option>
                      <option value={2}>2 workers</option>
                      <option value={3}>3 workers</option>
                      <option value={4}>4 workers</option>
                    </select>
                  </label>

                  {queueRecentFailures.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                      <p className="font-medium">Recent failures</p>
                      <div className="max-h-24 overflow-y-auto pr-1 space-y-1">
                        {queueRecentFailures.map((entry) => (
                          <div key={`${entry.path}-${entry.at}`} className="rounded-md border border-amber-200/70 dark:border-amber-700/50 bg-white/70 dark:bg-slate-900/30 p-2">
                            <p className="font-mono break-all">{entry.path}</p>
                            <p className="mt-0.5 break-words">{entry.error}</p>
                            <p className="mt-0.5 vn-muted">Retries: {entry.retryCount} • {formatQueueTime(entry.at)}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={handleRetryFailedEmbeddings}
                      disabled={queueRecentFailures.length === 0}
                      className="px-3 py-1.5 rounded-md vn-btn-primary text-white text-[11px] disabled:opacity-60 vn-interactive"
                    >
                      Retry Failed
                    </button>
                    <button
                      onClick={handleClearEmbeddingQueueErrors}
                      disabled={!embeddingQueueStatus.lastError && queueRecentFailures.length === 0}
                      className="px-3 py-1.5 rounded-md bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-800 dark:text-slate-100 text-[11px] disabled:opacity-60 vn-interactive"
                    >
                      Clear Errors
                    </button>
                  </div>

                  <div className="mt-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white/70 dark:bg-slate-900/25 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[13px] font-medium text-slate-900 dark:text-slate-100">Vault Consistency Repair</p>
                        <p className="text-[11px] vn-muted mt-1">
                          Prunes orphan embeddings, cleans stale facts/related index data, and repairs safely-resolvable wiki links.
                        </p>
                      </div>
                      <button
                        onClick={() => void handleConsistencyRepair()}
                        disabled={isRunningConsistencyRepair}
                        className="px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] disabled:opacity-60 vn-interactive"
                      >
                        {isRunningConsistencyRepair ? 'Repairing...' : 'Run Repair'}
                      </button>
                    </div>

                    {isRunningConsistencyRepair && consistencyRepairProgress.total > 0 && (
                      <div className="mt-3">
                        <div className="flex items-center justify-between text-[10px] mb-1">
                          <span>{consistencyRepairProgress.current}/{consistencyRepairProgress.total}</span>
                          <span>{Math.round((consistencyRepairProgress.current / Math.max(1, consistencyRepairProgress.total)) * 100)}%</span>
                        </div>
                        <div className="w-full bg-slate-300/70 dark:bg-slate-700/80 rounded-full h-1.5 overflow-hidden">
                          <div
                            className="h-full transition-all duration-300 bg-indigo-500"
                            style={{
                              width: `${(consistencyRepairProgress.current / Math.max(1, consistencyRepairProgress.total)) * 100}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}

                    {consistencyReport && (
                      <div className="mt-3 text-[11px] text-slate-700 dark:text-slate-300 space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <div className="rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1.5">
                            <p className="vn-muted">Valid notes</p>
                            <p className="font-semibold">{consistencyReport.validNoteCount}</p>
                          </div>
                          <div className="rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1.5">
                            <p className="vn-muted">Broken references</p>
                            <p className="font-semibold">{consistencyReport.brokenReferences.length}</p>
                          </div>
                          <div className="rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1.5">
                            <p className="vn-muted">Orphan embeddings removed</p>
                            <p className="font-semibold">{consistencyReport.removedOrphanEmbeddings}</p>
                          </div>
                          <div className="rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1.5">
                            <p className="vn-muted">References repaired</p>
                            <p className="font-semibold">{consistencyReport.repairedReferences}</p>
                          </div>
                        </div>
                        <p>
                          Facts pruned: <span className="font-semibold">{consistencyReport.prunedFacts}</span> • Related records pruned: <span className="font-semibold">{consistencyReport.prunedRelatedRecords}</span> • Related edges pruned: <span className="font-semibold">{consistencyReport.prunedRelatedEdges}</span>
                        </p>
                        {consistencyReport.brokenReferences.length > 0 && (
                          <div className="max-h-28 overflow-y-auto pr-1 space-y-1">
                            {consistencyReport.brokenReferences.slice(0, 6).map((item) => (
                              <div key={`${item.path}-${item.target}`} className="rounded-md border border-amber-200/70 dark:border-amber-700/50 bg-white/70 dark:bg-slate-900/30 p-2">
                                <p className="font-mono break-all">{item.path}</p>
                                <p className="mt-0.5 break-all">
                                  Broken {item.kind} target: <span className="font-mono">{item.target}</span>
                                </p>
                                <p className="mt-0.5 vn-muted">Reason: {item.reason}</p>
                                {item.candidates.length > 0 && (
                                  <p className="mt-0.5 vn-muted break-all">Candidates: {item.candidates.join(', ')}</p>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {localAiModels.length > 0 && (
                  <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-200 mb-2">Installed Models ({localAiModels.length})</p>
                    <div className="max-h-28 overflow-y-auto space-y-1 pr-1">
                      {localAiModels.map((model) => (
                        <div key={model.name} className="text-[11px] text-slate-700 dark:text-slate-300 flex items-center justify-between gap-3">
                          <div className="min-w-0 flex items-center gap-2">
                            <span className="font-mono truncate">{model.name}</span>
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold whitespace-nowrap ${modelCapabilityBadgeClass(model.capability)}`}>
                              {modelCapabilityLabel(model.capability)}
                            </span>
                          </div>
                          <span className="text-[10px] vn-muted whitespace-nowrap">{formatBytes(model.size) || 'size n/a'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              <section className={`space-y-3 ${activeSettingsSection !== 'performance' ? 'hidden' : ''}`}>
                <div className="flex items-center justify-between">
                  <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-200">Performance</h4>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void handleRunPerformanceScan()}
                      disabled={isRunningPerformanceScan}
                      className="px-2 py-1 text-[11px] rounded-md bg-[color:var(--vn-brand)]/90 text-white disabled:opacity-50 vn-interactive"
                    >
                      {isRunningPerformanceScan ? 'Scanning...' : 'Run Scan'}
                    </button>
                    <button
                      onClick={() => void refreshPerfMetrics()}
                      disabled={isRefreshingPerfMetrics}
                      className="px-2 py-1 text-[10px] rounded-md bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-100 disabled:opacity-50 vn-interactive"
                    >
                      {isRefreshingPerfMetrics ? 'Refreshing...' : 'Refresh'}
                    </button>
                    <button
                      onClick={handleClearPerfMetrics}
                      className="px-2 py-1 text-[10px] rounded-md bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-100 vn-interactive"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                {isRunningPerformanceScan && (
                  <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white/60 dark:bg-slate-900/30">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[13px] font-medium text-slate-900 dark:text-slate-100">Scanning current vault performance</p>
                      <p className="text-[10px] vn-muted">
                        {performanceScanProgress.current}/{performanceScanProgress.total || 0}
                      </p>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                      <div
                        className="h-full bg-[color:var(--vn-brand)] transition-all duration-200"
                        style={{
                          width: `${(performanceScanProgress.current / Math.max(1, performanceScanProgress.total)) * 100}%`,
                        }}
                      />
                    </div>
                    <p className="mt-2 text-[11px] vn-muted">{performanceScanProgress.label || 'Preparing scan...'}</p>
                  </div>
                )}

                {performanceScanReport && (
                  <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white/60 dark:bg-slate-900/30 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Latest Vault Scan</p>
                        <p className="text-[11px] vn-muted">
                          {new Date(performanceScanReport.scannedAt).toLocaleString()} • {performanceScanReport.fileCount} files • {performanceScanReport.folderCount} folders
                        </p>
                      </div>
                      <div className="text-right text-[11px] vn-muted">
                        <p>Text samples: {performanceScanReport.sampleTextFiles}</p>
                        <p>AI docs: {performanceScanReport.sampleAiDocs} • Queries: {performanceScanReport.sampleQueries}</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {performanceScanReport.operations.map((item) => (
                        <div key={item.key} className="rounded-md border border-slate-200 dark:border-slate-700 px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">{item.label}</p>
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${
                              item.severity === 'slow'
                                ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-200'
                                : item.severity === 'watch'
                                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
                                  : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'
                            }`}>
                              {item.severity === 'slow' ? 'Slow' : item.severity === 'watch' ? 'Watch' : 'Good'}
                            </span>
                          </div>
                          <p className="text-[11px] vn-muted mt-1">
                            Avg: {formatDurationMs(item.avgMs)} • Max: {formatDurationMs(item.maxMs)} • Runs: {item.runs}
                          </p>
                        </div>
                      ))}
                    </div>

                    {performanceScanReport.bottlenecks.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-200">Top Bottlenecks</p>
                        <div className="space-y-1.5">
                          {performanceScanReport.bottlenecks.map((item) => (
                            <div key={`${item.source}-${item.key}`} className="rounded-md border border-slate-200 dark:border-slate-700 px-3 py-2 text-[11px]">
                              <div className="flex items-center justify-between gap-2">
                                <p className="font-medium text-slate-800 dark:text-slate-100">{item.label}</p>
                                <span className="vn-muted">{item.source === 'scan' ? 'scan' : 'live p95'}</span>
                              </div>
                              <p className="mt-1 vn-muted">
                                Observed {formatDurationMs(item.observedMs)} • target under {formatDurationMs(item.thresholdMs)}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-200">Recommendations</p>
                      <div className="space-y-1.5">
                        {performanceScanReport.recommendations.map((item, index) => (
                          <p key={`${index}-${item}`} className="text-[11px] vn-muted rounded-md border border-slate-200 dark:border-slate-700 px-3 py-2">
                            {item}
                          </p>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {perfMetricSummaries.map((metric) => (
                    <div key={metric.name} className="p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white/60 dark:bg-slate-900/30">
                      <p className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">{PERF_METRIC_LABELS[metric.name]}</p>
                      <p className="text-[11px] vn-muted mt-1">
                        Last: {formatDurationMs(metric.lastMs)} • p50: {formatDurationMs(metric.p50Ms)} • p95: {formatDurationMs(metric.p95Ms)}
                      </p>
                      <p className="text-[11px] vn-muted mt-1">Mean: {formatDurationMs(metric.meanMs)} • Samples: {metric.count}</p>
                    </div>
                  ))}
                </div>
              </section>

              <section className={`space-y-3 ${activeSettingsSection !== 'layout' ? 'hidden' : ''}`}>
                <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-200">Layout</h4>
                <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white/60 dark:bg-slate-900/30">
                  <p className="text-[13px] font-medium text-slate-900 dark:text-slate-100">Panel visibility defaults</p>
                    <p className="text-[11px] vn-muted mt-1">
                    These options control what is visible when the app starts. You can still toggle them temporarily from the main UI at any time.
                  </p>
                </div>
                <label className="flex items-center justify-between gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                  <div>
                    <p className="text-[13px] font-medium text-slate-900 dark:text-slate-100">Show File Tree by Default</p>
                    <p className="text-[11px] vn-muted">Keep the left notes panel visible on startup.</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.showSidebarByDefault}
                    onChange={(e) => updateSetting('showSidebarByDefault', e.target.checked)}
                    className="h-4 w-4"
                  />
                </label>

                <label className="flex items-center justify-between gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                  <div>
                    <p className="text-[13px] font-medium text-slate-900 dark:text-slate-100">Show Top Bar by Default</p>
                    <p className="text-[11px] vn-muted">Keep command controls visible at the top on startup.</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.showTopBarByDefault}
                    onChange={(e) => updateSetting('showTopBarByDefault', e.target.checked)}
                    className="h-4 w-4"
                  />
                </label>

                <label className="flex items-center justify-between gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                  <div>
                    <p className="text-[13px] font-medium text-slate-900 dark:text-slate-100">Show Q&A Panel by Default</p>
                    <p className="text-[11px] vn-muted">Opens the assistant panel automatically.</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.showQAPanelByDefault}
                    onChange={(e) => updateSetting('showQAPanelByDefault', e.target.checked)}
                    className="h-4 w-4"
                  />
                </label>

                <label className="flex items-center justify-between gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                  <div>
                    <p className="text-[13px] font-medium text-slate-900 dark:text-slate-100">Pin Favorites in Sidebar</p>
                    <p className="text-[11px] vn-muted">Show the Favorites accordion at the bottom of the file tree.</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.pinFavoritesInSidebar}
                    onChange={(e) => updateSetting('pinFavoritesInSidebar', e.target.checked)}
                    className="h-4 w-4"
                  />
                </label>

                <label className="flex items-center justify-between gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-700">
                  <div>
                    <p className="text-[13px] font-medium text-slate-900 dark:text-slate-100">Pin Recent in Sidebar</p>
                    <p className="text-[11px] vn-muted">Show the Recent accordion at the bottom of the file tree.</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.pinRecentInSidebar}
                    onChange={(e) => updateSetting('pinRecentInSidebar', e.target.checked)}
                    className="h-4 w-4"
                  />
                </label>
              </section>
            </div>

            <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <button
                onClick={resetSettings}
                className="px-3 py-2 text-[11px] rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-100 vn-interactive"
              >
                Reset Defaults
              </button>
              <button
                onClick={() => setShowSettings(false)}
                className="px-3 py-2 text-[11px] rounded-lg vn-btn-primary text-white vn-interactive"
              >
                Done
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {isAnalyzing && createPortal(
        <div className="fixed bottom-4 right-4 z-[60] w-[min(420px,calc(100vw-2rem))] vn-surface rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 p-4">
          <div>
            <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Analyzing vault in background</p>
            <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
              You can keep working while Pipnote reviews note structure and prepares suggestions.
            </p>
          </div>
          <div className="flex items-start justify-end gap-3">
            <button
              onClick={handleCancelReorganize}
              className="px-2.5 py-1 rounded-md text-xs bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-900 dark:text-slate-100 vn-focusable vn-interactive"
            >
              Cancel
            </button>
          </div>

          <div className="mt-3">
            <div className="flex items-center justify-between text-[10px] text-slate-600 dark:text-slate-300">
              <span>Progress</span>
              <span>{progress.current} / {progress.total || '?'}</span>
            </div>
            <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2 mt-1.5 overflow-hidden">
              <div
                className="h-2 rounded-full transition-all"
                style={{
                  backgroundColor: 'var(--vn-brand)',
                  width: progress.total > 0 ? `${(progress.current / progress.total) * 100}%` : '8%',
                }}
              />
            </div>
            {analyzingFileName && (
              <p className="mt-2 text-[10px] text-slate-500 dark:text-slate-400 truncate">
                Current: <span className="font-mono">{analyzingFileName}</span>
              </p>
            )}
          </div>
        </div>,
        document.body
      )}

      {/* Reorganization Dialog */}
      {showReorganizeDialog && !isAnalyzing && createPortal(
        <div className="fixed inset-0 bg-black/55 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="vn-surface rounded-2xl shadow-2xl max-w-6xl w-full mx-4 max-h-[92vh] overflow-hidden flex flex-col">
            <div
              className="px-6 py-5 border-b border-slate-200 dark:border-slate-700"
              style={{
                background: 'linear-gradient(110deg, color-mix(in srgb, var(--vn-brand) 12%, var(--vn-surface)), color-mix(in srgb, var(--vn-brand) 5%, var(--vn-surface-2)))',
              }}
            >
              <h2 className="text-xl font-semibold text-slate-900 dark:text-white">
                {isAnalyzing ? 'Analyzing Vault...' : 'Reorganize Vault'}
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-300 mt-1">
                AI will analyze and reorganize your notes
              </p>
            </div>

            <div className="flex-1 overflow-y-auto p-6 min-h-0">
              <div className="mb-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-900/40 p-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Organization strategy</p>
                    <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                      Choose how Pipnote should bias folder decisions for this analysis pass.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {REORGANIZATION_STRATEGIES.map((strategyOption) => {
                      const active = reorganizationStrategy === strategyOption.id
                      return (
                        <button
                          key={strategyOption.id}
                          type="button"
                          disabled={isAnalyzing || isExecuting}
                          onClick={() => {
                            setReorganizationStrategy(strategyOption.id)
                            if (reorganizationPlan && !isAnalyzing && !isExecuting) {
                              void handleStartReorganize(strategyOption.id)
                            }
                          }}
                          className={`rounded-lg px-3 py-2 text-left transition-colors disabled:opacity-50 ${
                            active
                              ? 'bg-blue-100 text-blue-900 dark:bg-blue-900/30 dark:text-blue-100'
                              : 'bg-slate-200/80 text-slate-700 hover:bg-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'
                          }`}
                          title={strategyOption.description}
                        >
                          <div className="text-[11px] font-semibold whitespace-nowrap">{strategyOption.label}</div>
                          <div className="mt-0.5 max-w-52 text-[10px] leading-relaxed opacity-80">{strategyOption.description}</div>
                        </button>
                      )
                    })}
                  </div>
                </div>
                {reorganizationPlan && reorganizationPlanStrategy !== reorganizationStrategy && !isAnalyzing && !isExecuting && (
                  <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-100">
                    <span>
                      Showing results for <span className="font-semibold">{REORGANIZATION_STRATEGIES.find((item) => item.id === reorganizationPlanStrategy)?.label || reorganizationPlanStrategy}</span>.
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleStartReorganize(reorganizationStrategy)}
                      className="rounded-md bg-amber-100 px-2.5 py-1 font-medium hover:bg-amber-200 dark:bg-amber-900/40 dark:hover:bg-amber-900/60"
                    >
                      Re-run with {REORGANIZATION_STRATEGIES.find((item) => item.id === reorganizationStrategy)?.label || reorganizationStrategy}
                    </button>
                  </div>
                )}
              </div>

              {isAnalyzing && (
                <div className="text-center py-8">
                  <div
                    className="animate-spin rounded-full h-12 w-12 border-2 border-transparent mx-auto mb-4"
                    style={{ borderBottomColor: 'var(--vn-brand)' }}
                  />
                  <p className="text-gray-600 dark:text-gray-400">
                    Analyzing {progress.current} of {progress.total} notes...
                  </p>
                  {progress.total > 0 && (
                    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 mt-4">
                      <div
                        className="h-2 rounded-full transition-all"
                        style={{
                          backgroundColor: 'var(--vn-brand)',
                          width: `${(progress.current / progress.total) * 100}%`,
                        }}
                      />
                    </div>
                  )}
                  {/* Show filename currently being analyzed */}
                  {progress.current > 0 && analyzingFileName && (
                    <div className="mt-4 text-xs text-gray-500 dark:text-gray-400">
                      <span>Currently analyzing:</span>
                      <span className="ml-2 font-mono">{analyzingFileName}</span>
                    </div>
                  )}
                </div>
              )}

              {reorganizationPlan && !isAnalyzing && !isExecuting && (
                <div className="space-y-4 min-h-0">
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div className="rounded-md px-2 py-1 bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300">
                      Strong: {reorganizationPlan.operations.filter(op => op.suggestionLevel === 'strong').length}
                    </div>
                    <div className="rounded-md px-2 py-1 bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300">
                      Recommended: {reorganizationPlan.operations.filter(op => op.suggestionLevel === 'recommended').length}
                    </div>
                    <div className="rounded-md px-2 py-1 bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                      Optional: {reorganizationPlan.operations.filter(op => op.suggestionLevel === 'optional').length}
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        Approved operations: <span className="font-semibold text-gray-900 dark:text-gray-100">{approvedOperationIds.size}</span> / {reorganizationPlan.operations.length}
                      </p>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        Current run: <span className="font-semibold text-slate-700 dark:text-slate-200">{REORGANIZATION_STRATEGIES.find((item) => item.id === reorganizationPlanStrategy)?.label || reorganizationPlanStrategy}</span>
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={approveAllOperations}
                        className="px-3 py-1.5 text-xs font-medium rounded-md bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-300 dark:hover:bg-green-900/50 vn-focusable vn-interactive vn-pressable"
                      >
                        Approve All
                      </button>
                      <button
                        onClick={denyAllOperations}
                        className="px-3 py-1.5 text-xs font-medium rounded-md bg-gray-200 text-gray-800 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 vn-focusable vn-interactive vn-pressable"
                      >
                        Deny All
                      </button>
                    </div>
                  </div>

                  <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                    <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Summary</h3>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <span className="text-gray-600 dark:text-gray-400">Total Notes:</span>
                        <span className="ml-2 font-semibold">{reorganizationPlan.summary.totalNotes}</span>
                      </div>
                      <div>
                        <span className="text-gray-600 dark:text-gray-400">To Move:</span>
                        <span className="ml-2 font-semibold text-blue-600">{reorganizationPlan.summary.toMove}</span>
                      </div>
                      <div>
                        <span className="text-gray-600 dark:text-gray-400">To Delete:</span>
                        <span className="ml-2 font-semibold text-red-600">{reorganizationPlan.summary.toDelete}</span>
                      </div>
                      <div>
                        <span className="text-gray-600 dark:text-gray-400">To Merge:</span>
                        <span className="ml-2 font-semibold text-green-600">{reorganizationPlan.summary.toMerge}</span>
                      </div>
                      <div>
                        <span className="text-gray-600 dark:text-gray-400">Structural Issues:</span>
                        <span className="ml-2 font-semibold text-yellow-600">{reorganizationPlan.summary.structuralIssues}</span>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/80 dark:bg-emerald-900/20 p-4">
                    <h3 className="font-semibold text-slate-900 dark:text-slate-100 mb-1.5">Safety checks</h3>
                    <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed">
                      Before apply, dirty notes are saved automatically. Approved delete actions use soft delete, and every applied operation is written to
                      <span className="mx-1 font-mono">.vn-system/reorg-undo</span>
                      so the run stays reviewable.
                    </p>
                  </div>

                  <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/30 p-3 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="inline-flex rounded-lg bg-slate-200 dark:bg-slate-800 p-1">
                        <button
                          type="button"
                          onClick={() => setReorganizeReviewMode('list')}
                          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                            reorganizeReviewMode === 'list'
                              ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm'
                              : 'text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          Review List
                        </button>
                        <button
                          type="button"
                          onClick={() => setReorganizeReviewMode('tree')}
                          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                            reorganizeReviewMode === 'tree'
                              ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm'
                              : 'text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          Tree Preview
                        </button>
                      </div>

                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        Preview updates live from currently approved actions.
                      </p>
                    </div>

                    {destinationClusters.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          Main destination clusters
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {destinationClusters.map((cluster) => (
                            <span
                              key={cluster.label}
                              className="inline-flex items-center gap-1 rounded-full bg-slate-200/90 px-2.5 py-1 text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-200"
                            >
                              <span className="font-medium">{cluster.label}</span>
                              <span className="rounded-full bg-slate-300 px-1.5 py-0.5 text-[10px] dark:bg-slate-700">{cluster.count}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {reorganizeReviewMode === 'tree' ? (
                      <div className="min-h-[26rem] max-h-[56vh] overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-950/40 p-3 pr-2">
                        {projectedReorganizationTree.length > 0 ? (
                          <VirtualPreviewTree nodes={projectedReorganizationTree} />
                        ) : (
                          <div className="text-center py-10">
                            <p className="text-sm font-medium text-slate-800 dark:text-slate-100">No projected tree changes yet.</p>
                            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                              Approve one or more actions to see the virtual vault structure update here.
                            </p>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="min-h-[26rem] max-h-[56vh] overflow-y-auto space-y-4 pr-1">
                        {groupedReorganizationOperations.map((group) => (
                          <section key={group.id} className="space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="min-w-0">
                                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{group.label}</h3>
                                {(() => {
                                  const counts = summarizeReorgConfidenceCounts(group.operations.map(({ op }) => op))
                                  const chips = [
                                    counts.manual > 0 ? { label: `Manual ${counts.manual}`, className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200' } : null,
                                    counts.high > 0 ? { label: `High ${counts.high}`, className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200' } : null,
                                    counts.moderate > 0 ? { label: `Moderate ${counts.moderate}`, className: 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-200' } : null,
                                    counts.lower > 0 ? { label: `Lower ${counts.lower}`, className: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200' } : null,
                                  ].filter(Boolean) as Array<{ label: string; className: string }>
                                  if (chips.length === 0) return null
                                  return (
                                    <div className="mt-1 flex flex-wrap gap-1.5">
                                      {chips.map((chip) => (
                                        <span key={`${group.id}-${chip.label}`} className={`px-2 py-0.5 rounded text-[10px] font-semibold ${chip.className}`}>
                                          {chip.label}
                                        </span>
                                      ))}
                                    </div>
                                  )
                                })()}
                              </div>
                              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                                {group.operations.length}
                              </span>
                            </div>

                            <div className="space-y-3">
                              {group.operations
                                .slice()
                                .sort((a, b) => {
                                  const aConfidence = getReorgConfidenceRank(buildReorgConfidenceSummary(a.op))
                                  const bConfidence = getReorgConfidenceRank(buildReorgConfidenceSummary(b.op))
                                  if (aConfidence !== bConfidence) return aConfidence - bConfidence
                                  return getLevelRank(a.op.suggestionLevel) - getLevelRank(b.op.suggestionLevel)
                                })
                                .map(({ op, index: i }) => {
                                  const meta = getOperationMeta(op.type)
                                  const levelMeta = getLevelMeta(op.suggestionLevel)
                                  const trustTags = getReorgTrustTags(op.reason, op.reviewContext)
                                  const reviewHint = getReorgReviewHint(op.reviewContext)
                                  const isRenameCleanup = isRenameCleanupOperation(op)
                                  const changeSummary = summarizeReorgChange(op.sourcePath, op.targetPath)
                                  const whyThisFolder = op.targetPath ? buildWhyThisFolder(op.sourcePath, op.targetPath, op.reason) : null
                                  const opNarrative = buildReorgOperationNarrative(op)
                                  const confidenceSummary = buildReorgConfidenceSummary(op)
                                  const approved = approvedOperationIds.has(i)
                                  const mentionedPaths = collectMentionedPaths(op)
                                  const isMentionedOpen = expandedMentionedOps.has(i)
                                  const selectedMentionedPath = selectedMentionedPathByOp[i] || mentionedPaths[0] || ''
                                  const selectedPreview = selectedMentionedPath ? previewByPath[selectedMentionedPath] : undefined
                                  const isSelectedPreviewLoading = selectedMentionedPath ? previewLoadingPaths.has(selectedMentionedPath) : false
                                  return (
                                    <div
                                      key={i}
                                      className={`text-sm border rounded-lg p-3 transition-colors vn-list-enter ${
                                        approved
                                          ? 'border-blue-300 dark:border-blue-700 bg-white/90 dark:bg-gray-900'
                                          : 'border-gray-200 dark:border-gray-700 bg-gray-50/80 dark:bg-gray-800/60 opacity-75'
                                      }`}
                                    >
                                      <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                                            {meta.icon}
                                            <span className={`px-2 py-0.5 rounded text-xs font-semibold ${meta.bg} ${meta.color}`}>{meta.label}</span>
                                            <span className={`px-2 py-0.5 rounded text-xs font-semibold ${levelMeta.className}`}>{levelMeta.label}</span>
                                            {isRenameCleanup && (
                                              <span className="px-2 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-200">
                                                Rename Cleanup
                                              </span>
                                            )}
                                            {trustTags.map((tag) => (
                                              <span
                                                key={`${i}-${tag.label}`}
                                                className={`px-2 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap ${tag.className}`}
                                              >
                                                {tag.label}
                                              </span>
                                            ))}
                                            <span className="font-mono text-xs text-gray-800 dark:text-gray-200 truncate">{op.sourcePath.replace('notes/', '')}</span>
                                          </div>
                                          {op.targetPath && (
                                            <div className="text-xs text-gray-500 dark:text-gray-400 ml-6">
                                              <span className="mr-1">→</span>
                                              <span className="font-mono">{op.targetPath.replace('notes/', '')}</span>
                                            </div>
                                          )}
                                          <div className={`ml-6 mt-2 rounded-md border px-2.5 py-2 ${confidenceSummary.className}`}>
                                            <div className="text-[11px] font-semibold">{confidenceSummary.label}</div>
                                            <div className="mt-0.5 text-[11px] leading-relaxed opacity-90">
                                              {confidenceSummary.detail}
                                            </div>
                                          </div>
                                          {changeSummary && (changeSummary.folderChanged || changeSummary.titleChanged) && (
                                            <div className="ml-6 mt-2 flex flex-wrap gap-2">
                                              {changeSummary.folderChanged && (
                                                <div className="rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-1 text-[11px] text-slate-700 dark:text-slate-200">
                                                  <span className="font-semibold mr-1">Folder:</span>
                                                  <span className="font-mono">{changeSummary.currentFolder}</span>
                                                  <span className="mx-1">→</span>
                                                  <span className="font-mono">{changeSummary.targetFolder}</span>
                                                </div>
                                              )}
                                              {changeSummary.titleChanged && (
                                                <div className="rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-1 text-[11px] text-slate-700 dark:text-slate-200">
                                                  <span className="font-semibold mr-1">Title:</span>
                                                  <span className="font-mono">{changeSummary.currentTitle}</span>
                                                  <span className="mx-1">→</span>
                                                  <span className="font-mono">{changeSummary.targetTitle}</span>
                                                </div>
                                              )}
                                            </div>
                                          )}
                                          {whyThisFolder && op.type === 'move' && (
                                            <div className="ml-6 mt-2 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-900/40 px-2.5 py-2">
                                              <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">Why this folder</div>
                                              <div className="mt-1 text-[11px] text-slate-600 dark:text-slate-300">
                                                <span className="font-semibold">Current:</span> <span className="font-mono">{whyThisFolder.currentFolder}</span>
                                                <span className="mx-2">•</span>
                                                <span className="font-semibold">Suggested:</span> <span className="font-mono">{whyThisFolder.suggestedFolder}</span>
                                              </div>
                                              <div className="mt-1.5 space-y-1">
                                                {whyThisFolder.evidence.map((line, evidenceIndex) => (
                                                  <div key={`${i}-why-${evidenceIndex}`} className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                                                    {line}
                                                  </div>
                                                ))}
                                              </div>
                                              {whyThisFolder.caution && (
                                                <div className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed">
                                                  {whyThisFolder.caution}
                                                </div>
                                              )}
                                            </div>
                                          )}
                                          {opNarrative && (
                                            <div className="ml-6 mt-2 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-900/40 px-2.5 py-2">
                                              <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">{opNarrative.title}</div>
                                              <div className="mt-1.5 space-y-1">
                                                {opNarrative.bullets.map((line, narrativeIndex) => (
                                                  <div key={`${i}-narrative-${narrativeIndex}`} className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                                                    {line}
                                                  </div>
                                                ))}
                                              </div>
                                            </div>
                                          )}
                                          <div className="text-xs text-gray-500 dark:text-gray-400 ml-6 mt-1 leading-relaxed">{op.reason}</div>
                                          {reviewHint && (
                                            <div className="text-[11px] text-amber-700 dark:text-amber-300 ml-6 mt-1 leading-relaxed">
                                              {reviewHint}
                                            </div>
                                          )}

                                          {mentionedPaths.length > 0 && (
                                            <div className="ml-6 mt-3">
                                              <button
                                                onClick={() => {
                                                  toggleMentionedFiles(i, mentionedPaths)
                                                  if (!isMentionedOpen && mentionedPaths[0]) {
                                                    void ensureMentionedPreviewLoaded(mentionedPaths[0])
                                                  }
                                                }}
                                                className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-slate-200/80 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-800 dark:text-slate-100 vn-focusable vn-interactive"
                                              >
                                                {isMentionedOpen ? 'Hide mentioned files' : `Show mentioned files (${mentionedPaths.length})`}
                                              </button>

                                              {isMentionedOpen && (
                                                <div className="mt-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white/60 dark:bg-slate-900/40 p-2.5 space-y-2">
                                                  <div className="flex flex-wrap gap-1.5">
                                                    {mentionedPaths.map((path) => {
                                                      const isActive = selectedMentionedPath === path
                                                      return (
                                                        <button
                                                          key={`${i}-${path}`}
                                                          onClick={() => {
                                                            setSelectedMentionedPathByOp(prev => ({ ...prev, [i]: path }))
                                                            void ensureMentionedPreviewLoaded(path)
                                                          }}
                                                          className={`px-2 py-1 rounded-md text-[11px] font-mono transition-colors ${
                                                            isActive
                                                              ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200'
                                                              : 'bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600'
                                                          }`}
                                                          title={path}
                                                        >
                                                          {path}
                                                        </button>
                                                      )
                                                    })}
                                                  </div>

                                                  <div className="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-950/40 p-2.5">
                                                    <div className="flex items-center justify-between gap-2 mb-2">
                                                      <p className="text-[11px] font-semibold text-slate-700 dark:text-slate-200 truncate">
                                                        Markdown preview: {selectedMentionedPath || 'N/A'}
                                                      </p>
                                                      {selectedMentionedPath && (
                                                        <button
                                                          onClick={() => {
                                                            void openFile(selectedMentionedPath).catch((error) => {
                                                              showToast(error instanceof Error ? error.message : 'Failed to open file', 'error')
                                                            })
                                                          }}
                                                          className="px-2 py-1 rounded-md text-[10px] bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-100 vn-focusable vn-interactive"
                                                        >
                                                          Open file
                                                        </button>
                                                      )}
                                                    </div>

                                                    {isSelectedPreviewLoading && (
                                                      <p className="text-xs text-slate-500 dark:text-slate-400">Loading preview...</p>
                                                    )}

                                                    {!isSelectedPreviewLoading && selectedPreview?.error && (
                                                      <p className="text-xs text-red-600 dark:text-red-300">{selectedPreview.error}</p>
                                                    )}

                                                    {!isSelectedPreviewLoading && selectedPreview && !selectedPreview.error && (
                                                      <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                                                        {renderMarkdownPreview(selectedPreview.content)}
                                                        {selectedPreview.content.split('\n').length > 48 && (
                                                          <p className="text-[10px] text-slate-500 dark:text-slate-400">…truncated preview</p>
                                                        )}
                                                      </div>
                                                    )}

                                                    {!isSelectedPreviewLoading && !selectedPreview && selectedMentionedPath && (
                                                      <p className="text-xs text-slate-500 dark:text-slate-400">Click a file to load preview.</p>
                                                    )}
                                                  </div>
                                                </div>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                        <button
                                          onClick={() => toggleOperationApproval(i)}
                                          className={`flex-shrink-0 px-2.5 py-1 rounded-md text-xs font-medium vn-focusable vn-interactive vn-pressable ${
                                            approved
                                              ? 'bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-300 dark:hover:bg-green-900/50'
                                              : 'bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'
                                          }`}
                                        >
                                          {approved ? 'Approved' : 'Denied'}
                                        </button>
                                      </div>
                                    </div>
                                  )
                                })}
                            </div>
                          </section>
                        ))}
                        {reorganizationPlan.operations.length === 0 && (
                          <div className="text-center py-8">
                            <p className="text-sm font-medium text-slate-800 dark:text-slate-100">No reorganization changes suggested.</p>
                            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400 max-w-md mx-auto">
                              This usually means the current vault structure already looks healthy enough, or Pipnote did not find high-confidence changes worth suggesting right now.
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {isExecuting && (
                <div className="text-center py-8">
                  <div
                    className="animate-spin rounded-full h-12 w-12 border-2 border-transparent mx-auto mb-4"
                    style={{ borderBottomColor: 'var(--vn-brand)' }}
                  />
                  <p className="text-gray-600 dark:text-gray-400">
                    Reorganizing... {progress.current} of {progress.total} operations
                  </p>
                  {progress.total > 0 && (
                    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 mt-4">
                      <div
                        className="h-2 rounded-full transition-all"
                        style={{
                          backgroundColor: 'var(--vn-brand)',
                          width: `${(progress.current / progress.total) * 100}%`,
                        }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="p-6 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-3">
              <button
                onClick={handleCancelReorganize}
                disabled={isExecuting}
                className="px-4 py-2 bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-900 dark:text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 vn-focusable vn-interactive vn-pressable"
              >
                Cancel
              </button>
              {reorganizationPlan && !isAnalyzing && !isExecuting && (
                <button
                  onClick={handleConfirmReorganize}
                  disabled={approvedOperationIds.size === 0}
                  className="px-4 py-2 vn-btn-primary disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors vn-focusable vn-interactive vn-pressable"
                >
                  Apply Approved Actions
                </button>
              )}
            </div>
          </div>
        </div>
      , document.body)}

      {showCommandPalette && createPortal(
        <div className="fixed inset-0 z-[70] bg-black/50 backdrop-blur-sm flex items-start justify-center pt-20">
          <div className="absolute inset-0" onClick={() => setShowCommandPalette(false)} />
          <div className="relative w-full max-w-4xl mx-4 vn-surface vn-glass rounded-2xl shadow-2xl overflow-hidden vn-panel-enter">
            <div className="p-3 border-b border-slate-200 dark:border-slate-700">
              <input
                autoFocus
                value={commandQuery}
                onChange={(event) => setCommandQuery(event.target.value)}
                onKeyDown={handlePaletteKeyDown}
                placeholder="Type a command..."
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-slate-100 focus:outline-none vn-focusable"
              />
            </div>
            {isBackgroundStaleReembedding && (
              <div className="px-3 py-2 border-b border-emerald-200 dark:border-emerald-800 bg-emerald-50/80 dark:bg-emerald-900/20">
                <div className="flex items-center justify-between text-xs text-emerald-900 dark:text-emerald-200">
                  <div className="flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 12a8 8 0 018-8m8 8a8 8 0 01-8 8" />
                    </svg>
                    <span>{backgroundStaleCancelRequested ? 'Cancel requested. Stopping after current note...' : 'Background stale embedding regeneration running'}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span>
                      {backgroundStaleProgress.total > 0
                        ? `${backgroundStaleProgress.current}/${backgroundStaleProgress.total}`
                        : 'Preparing...'}
                    </span>
                    <button
                      onClick={handleCancelBackgroundStaleReembed}
                      disabled={backgroundStaleCancelRequested}
                      className="px-2 py-0.5 rounded-md border border-emerald-300/80 dark:border-emerald-700 bg-white/80 dark:bg-slate-900/40 hover:bg-white dark:hover:bg-slate-900 text-[11px] font-medium disabled:opacity-60 disabled:cursor-not-allowed vn-interactive"
                    >
                      {backgroundStaleCancelRequested ? 'Cancel requested' : 'Cancel'}
                    </button>
                  </div>
                </div>
                {backgroundStaleProgress.total > 0 && (
                  <div className="mt-2 w-full bg-emerald-100/80 dark:bg-emerald-900/40 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-emerald-600 h-full transition-all duration-300"
                      style={{ width: `${(backgroundStaleProgress.current / Math.max(1, backgroundStaleProgress.total)) * 100}%` }}
                    />
                  </div>
                )}
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_280px]">
              <div className="max-h-80 overflow-y-auto p-2 space-y-3 border-r border-slate-200 dark:border-slate-700">
                {flattenedGroupedCommands.length === 0 && (
                  <div className="px-3 py-6 text-sm vn-muted text-center">No commands found</div>
                )}
                {groupedCommands.map(group => (
                  <div key={group.name} className="space-y-1">
                    <div className="px-2 text-[11px] uppercase tracking-wide vn-muted">{group.name}</div>
                    {group.commands.map(command => {
                      const index = commandIndexById.get(command.id) ?? -1
                      return (
                      <button
                        key={command.id}
                        onClick={() => runCommand(index)}
                        className={`w-full text-left px-3 py-2 rounded-lg transition-colors vn-interactive flex items-start gap-2 ${
                            selectedCommandIndex === index
                              ? 'bg-blue-100 text-blue-900 dark:bg-blue-900/30 dark:text-blue-100'
                              : 'hover:bg-slate-100 dark:hover:bg-slate-800/80 text-slate-800 dark:text-slate-100'
                          }`}
                        >
                        <span className="mt-0.5">{getCommandIcon(command.group)}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium truncate">{command.title}</span>
                          <span className="block text-xs vn-muted truncate">{command.subtitle}</span>
                        </span>
                        {pinnedCommandIds.includes(command.id) && (
                          <svg className="w-3.5 h-3.5 mt-1 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.137 3.497a1 1 0 00.95.69h3.677c.969 0 1.371 1.24.588 1.81l-2.974 2.16a1 1 0 00-.364 1.118l1.137 3.498c.3.92-.755 1.688-1.54 1.118l-2.973-2.16a1 1 0 00-1.176 0l-2.973 2.16c-.784.57-1.838-.197-1.539-1.118l1.137-3.498a1 1 0 00-.364-1.118L2.697 8.924c-.783-.57-.38-1.81.588-1.81h3.677a1 1 0 00.951-.69l1.136-3.497z" />
                          </svg>
                        )}
                        {(commandUsage[command.id] ?? 0) > 0 && (
                          <span className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-[10px] vn-muted">
                            {commandUsage[command.id]}x
                          </span>
                        )}
                        {getEffectiveHotkey(command) && (
                          <kbd className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-[10px] vn-muted">
                            {getEffectiveHotkey(command)}
                          </kbd>
                        )}
                      </button>
                    )
                  })}
                </div>
              ))}
              </div>

              <div className="p-4 space-y-3 bg-slate-50/70 dark:bg-slate-900/40">
                {selectedCommand ? (
                  <>
                    <div className="flex items-center gap-2">
                      {getCommandIcon(selectedCommand.group)}
                      <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {selectedCommand.title}
                      </h4>
                    </div>
                    <p className="text-xs vn-muted">{selectedCommand.detail || selectedCommand.subtitle}</p>

                    <div className="flex flex-wrap gap-2">
                      <span className="px-2 py-0.5 rounded-full text-[11px] bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200">
                        {selectedCommand.group}
                      </span>
                      {getEffectiveHotkey(selectedCommand) && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-200">
                          {getEffectiveHotkey(selectedCommand)}
                        </span>
                      )}
                      {selectedCommand.longRunning && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-200">
                          Long-running
                        </span>
                      )}
                      <span className="px-2 py-0.5 rounded-full text-[11px] bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200">
                        Used {commandUsage[selectedCommand.id] ?? 0} times
                      </span>
                    </div>

                    <div className="pt-2 space-y-2">
                      <button
                        onClick={() => runCommand(selectedCommandIndex)}
                        className="w-full px-3 py-2 rounded-lg vn-btn-primary text-white text-sm font-medium vn-focusable vn-interactive vn-pressable"
                      >
                        Run Command
                      </button>
                      {selectedCommand.longRunning && (
                        <button
                          onClick={() => runCommand(selectedCommandIndex, 'background')}
                          disabled={
                            (selectedCommand.id === 'reorganize' && isBackgroundAnalyzing)
                            || (selectedCommand.id === 'reembed-stale' && (isBackgroundStaleReembedding || isRegeneratingStaleEmbeddings))
                          }
                          className="w-full px-3 py-2 rounded-lg bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 disabled:opacity-60 disabled:cursor-not-allowed text-slate-900 dark:text-white text-sm font-medium vn-focusable vn-interactive vn-pressable"
                        >
                          Run in Background
                        </button>
                      )}
                      <button
                        onClick={() => togglePinnedCommand(selectedCommand.id)}
                        className="w-full px-3 py-2 rounded-lg bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-900 dark:text-white text-sm font-medium vn-focusable vn-interactive vn-pressable"
                      >
                        {pinnedCommandIds.includes(selectedCommand.id) ? 'Unpin Command' : 'Pin Command'}
                      </button>
                    </div>

                    <div className="pt-2 space-y-1">
                      <p className="text-[11px] vn-muted">Custom Shortcut</p>
                      <select
                        value={selectedCommandCustomShortcut}
                        onChange={(event) => updateCustomShortcutForCommand(selectedCommand.id, event.target.value)}
                        className="w-full px-2 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-xs text-slate-900 dark:text-slate-100 vn-focusable"
                      >
                        <option value="">None</option>
                        {CUSTOM_SHORTCUT_OPTIONS.map(option => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="text-[11px] vn-muted pt-1">
                      Tip: press <kbd className="px-1 py-0.5 rounded bg-slate-200 dark:bg-slate-700">Enter</kbd> to run.
                      {selectedCommand.longRunning && (
                        <span> Use <kbd className="px-1 py-0.5 rounded bg-slate-200 dark:bg-slate-700">⌘Enter</kbd> for background mode.</span>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-xs vn-muted">Select a command to preview details.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      , document.body)}
    </header>
  )
}

export default Header
