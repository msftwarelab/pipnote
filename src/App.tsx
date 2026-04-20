import { Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Header from './components/Header'
import MainPanel from './components/MainPanel'
import { EditorProvider } from './contexts/EditorContext'
import { TabProvider } from './contexts/TabContext'
import { ToastProvider } from './contexts/ToastContext'
import { useSettings } from './contexts/SettingsContext'
import { vaultService } from './services/vault'
import { localAiService } from './services/localAi'
import { searchService, type IndexHealthStatus } from './services/search'
import type { LocalAIModelSelectionStatus } from './services/localAi'

const loadSidebarModule = () => import('./components/Sidebar')
const loadQAPanelModule = () => import('./components/QAPanel')
const loadKeywordSearchModalModule = () => import('./components/KeywordSearchModal')

const Sidebar = lazy(async () => {
  const module = await loadSidebarModule()
  return { default: module.default }
})

const QAPanel = lazy(async () => {
  const module = await loadQAPanelModule()
  return { default: module.QAPanel }
})

const KeywordSearchModal = lazy(async () => {
  const module = await loadKeywordSearchModalModule()
  return { default: module.KeywordSearchModal }
})

function preloadSidebar(): void {
  void loadSidebarModule()
}

function preloadQAPanel(): void {
  void loadQAPanelModule()
}

function preloadKeywordSearchModal(): void {
  void loadKeywordSearchModalModule()
}

function SidebarFallback({ width }: { width: number }) {
  return (
    <aside
      className="vn-surface vn-glass rounded-2xl overflow-hidden animate-pulse"
      style={{ width: `${width}px` }}
    >
      <div className="h-full p-4 space-y-3">
        <div className="h-6 w-24 rounded bg-slate-200/80 dark:bg-slate-700/70" />
        <div className="h-4 w-32 rounded bg-slate-200/60 dark:bg-slate-700/50" />
        <div className="space-y-2 pt-3">
          <div className="h-9 rounded-xl bg-slate-200/60 dark:bg-slate-700/50" />
          <div className="h-9 rounded-xl bg-slate-200/60 dark:bg-slate-700/50" />
          <div className="h-9 rounded-xl bg-slate-200/60 dark:bg-slate-700/50" />
        </div>
      </div>
    </aside>
  )
}

function QAPanelFallback() {
  return (
    <div className="flex-1 p-4 space-y-4 animate-pulse">
      <div className="h-10 rounded-xl bg-slate-200/80 dark:bg-slate-700/70" />
      <div className="h-12 rounded-xl bg-slate-200/60 dark:bg-slate-700/50" />
      <div className="h-24 rounded-2xl bg-slate-200/60 dark:bg-slate-700/50" />
      <div className="h-24 rounded-2xl bg-slate-200/60 dark:bg-slate-700/50" />
    </div>
  )
}

const ONBOARDING_DISMISSED_KEY = 'vn_onboarding_completed_v1'

interface OnboardingStatus {
  vaultReady: boolean
  localAiHealthy: boolean
  modelStatus: LocalAIModelSelectionStatus | null
  indexHealth: IndexHealthStatus | null
}

function hasSavedVaultSelection(): boolean {
  return typeof window !== 'undefined' && !!localStorage.getItem('vn_vault_path')
}

function hasCompletedOnboarding(): boolean {
  return typeof window !== 'undefined' && localStorage.getItem(ONBOARDING_DISMISSED_KEY) === 'true'
}

function hasVaultSelectionForOnboarding(): boolean {
  return typeof window !== 'undefined' && hasSavedVaultSelection()
}

function OnboardingStep({
  title,
  state,
  body,
  action,
}: {
  title: string
  state: 'done' | 'todo'
  body: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-900/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full text-[11px] font-semibold ${
              state === 'done'
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'
                : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
            }`}>
              {state === 'done' ? 'Done' : 'Next'}
            </span>
            <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h4>
          </div>
          <div className="mt-2 text-xs leading-5 vn-muted">{body}</div>
        </div>
        {action}
      </div>
    </div>
  )
}

function OnboardingModal({
  status,
  isRefreshing,
  isGeneratingEmbeddings,
  onRefresh,
  onChooseVault,
  onOpenSettings,
  onGenerateEmbeddings,
  onClose,
}: {
  status: OnboardingStatus | null
  isRefreshing: boolean
  isGeneratingEmbeddings: boolean
  onRefresh: () => void
  onChooseVault: () => void
  onOpenSettings: () => void
  onGenerateEmbeddings: () => void
  onClose: () => void
}) {
  const modelStatus = status?.modelStatus
  const indexHealth = status?.indexHealth
  const hasEmbeddings = (indexHealth?.indexedCount ?? 0) > 0
  const eligibleCount = indexHealth?.eligibleCount ?? 0
  const missingModels = modelStatus?.missing ?? []
  const incompatibleModels = modelStatus?.incompatible ?? []

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/55 backdrop-blur-sm px-4">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="relative w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-3xl vn-surface shadow-2xl border border-slate-200/70 dark:border-slate-700/70">
        <div className="px-6 py-5 border-b border-slate-200 dark:border-slate-700 bg-gradient-to-r from-white to-slate-50 dark:from-slate-950 dark:to-slate-900">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--vn-brand)] font-semibold">First Run</p>
              <h2 className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">Welcome to Pipnote</h2>
              <p className="mt-2 max-w-2xl text-sm vn-muted">
                Pipnote keeps your notes local, helps organize them, and lets you ask questions over your own files.
                This quick setup gets the vault, local AI, and retrieval features ready.
              </p>
            </div>
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-100 text-xs font-semibold vn-interactive"
            >
              Close setup
            </button>
          </div>
        </div>

        <div className="max-h-[calc(90vh-90px)] overflow-y-auto px-6 py-5 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="rounded-2xl border border-slate-200 dark:border-slate-700 p-4 bg-white/70 dark:bg-slate-900/40">
              <p className="text-[11px] uppercase tracking-wide vn-muted">Vault</p>
              <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">
                {status?.vaultReady ? 'Ready' : 'Choose folder'}
              </p>
              <p className="mt-1 text-xs vn-muted">Choose the folder where your notes already live.</p>
            </div>
            <div className="rounded-2xl border border-slate-200 dark:border-slate-700 p-4 bg-white/70 dark:bg-slate-900/40">
              <p className="text-[11px] uppercase tracking-wide vn-muted">Local AI</p>
              <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">
                {status?.localAiHealthy ? 'Connected' : 'Select models'}
              </p>
              <p className="mt-1 text-xs vn-muted">Point Pipnote at your local provider and installed models.</p>
            </div>
            <div className="rounded-2xl border border-slate-200 dark:border-slate-700 p-4 bg-white/70 dark:bg-slate-900/40">
              <p className="text-[11px] uppercase tracking-wide vn-muted">Embeddings</p>
              <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">
                {hasEmbeddings ? `${indexHealth?.indexedCount ?? 0} indexed` : eligibleCount > 0 ? 'Ready to generate' : 'Waiting for notes'}
              </p>
              <p className="mt-1 text-xs vn-muted">Generate once so search, Q&A, and suggestions have stronger grounding.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1.15fr_0.85fr] gap-4">
            <div className="space-y-3">
              <OnboardingStep
                title="1. Confirm your vault"
                state={status?.vaultReady ? 'done' : 'todo'}
                body={status?.vaultReady
                  ? 'Your vault is loaded. You can switch to a different notes folder any time.'
                  : 'Choose the main folder that holds your notes so Pipnote can browse, index, and organize them.'}
                action={
                  <button
                    onClick={onChooseVault}
                    className="px-3 py-2 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-slate-100 text-xs font-semibold whitespace-nowrap vn-interactive"
                  >
                    Choose Vault
                  </button>
                }
              />

              <OnboardingStep
                title="2. Verify local AI and models"
                state={status?.localAiHealthy ? 'done' : 'todo'}
                body={
                  status?.localAiHealthy ? (
                    <>Your selected provider and models are available, so Pipnote is ready to use local AI features.</>
                  ) : (
                    <>
                      <p>Pipnote uses your selected local AI runtime on this machine. Open Settings to choose installed models or fix the base URL.</p>
                      {missingModels.length > 0 && (
                        <p className="mt-1">Missing models: <span className="font-mono">{missingModels.join(', ')}</span></p>
                      )}
                      {incompatibleModels.length > 0 && (
                        <p className="mt-1">Capability mismatch: <span className="font-mono">{incompatibleModels.join(', ')}</span></p>
                      )}
                    </>
                  )
                }
                action={
                  <button
                    onClick={onOpenSettings}
                    className="px-3 py-2 rounded-lg bg-[color:var(--vn-brand)] text-white text-xs font-semibold whitespace-nowrap vn-interactive"
                  >
                    Open Settings
                  </button>
                }
              />

              <OnboardingStep
                title="3. Generate embeddings"
                state={hasEmbeddings ? 'done' : 'todo'}
                body={
                  hasEmbeddings ? (
                    <>
                      Indexed notes: <span className="font-semibold">{indexHealth?.indexedCount ?? 0}</span>
                      {indexHealth && (indexHealth.staleCount > 0 || indexHealth.failedCount > 0) && (
                        <span> • stale: <span className="font-semibold">{indexHealth.staleCount}</span> • failed: <span className="font-semibold">{indexHealth.failedCount}</span></span>
                      )}
                    </>
                  ) : (
                    <>
                      <p>Generate embeddings so Q&A, related notes, and organization suggestions can use your vault more accurately.</p>
                      {eligibleCount > 0 && <p className="mt-1">Eligible files found: <span className="font-semibold">{eligibleCount}</span></p>}
                    </>
                  )
                }
                action={
                  <button
                    onClick={onGenerateEmbeddings}
                    disabled={isGeneratingEmbeddings || !status?.localAiHealthy || eligibleCount === 0}
                    className="px-3 py-2 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-semibold whitespace-nowrap disabled:opacity-50 vn-interactive"
                  >
                    {isGeneratingEmbeddings ? 'Generating…' : 'Generate'}
                  </button>
                }
              />
            </div>

            <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white/70 dark:bg-slate-900/40 p-4 space-y-3">
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">What Pipnote does best</h4>
              <div className="space-y-2 text-xs vn-muted leading-5">
                <p><span className="font-semibold text-slate-800 dark:text-slate-100">Local-first AI:</span> your notes stay in your vault, and your selected local AI runtime runs locally.</p>
                <p><span className="font-semibold text-slate-800 dark:text-slate-100">Q&A over your notes:</span> ask natural-language questions and jump to source files.</p>
                <p><span className="font-semibold text-slate-800 dark:text-slate-100">Auto-organization:</span> analyze vault structure, review suggestions, and apply only what you approve.</p>
                <p><span className="font-semibold text-slate-800 dark:text-slate-100">Related note discovery:</span> surface backlinks, link suggestions, and neighboring context without manual tagging.</p>
              </div>

              <div className="rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-3 bg-slate-50/80 dark:bg-slate-950/40">
                <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">Good first test</p>
                <p className="mt-1 text-xs vn-muted">
                  Write a note like “My wedding day is June 14, 2026”, generate embeddings, then ask:
                  <span className="font-medium text-slate-800 dark:text-slate-100"> “When is my wedding day?”</span>
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-2">
                <button
                  onClick={onRefresh}
                  disabled={isRefreshing}
                  className="px-3 py-2 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-slate-100 text-xs font-semibold disabled:opacity-50 vn-interactive"
                >
                  {isRefreshing ? 'Refreshing…' : 'Refresh status'}
                </button>
                <button
                  onClick={onClose}
                  className="px-3 py-2 rounded-lg bg-[color:var(--vn-brand)] text-white text-xs font-semibold vn-interactive"
                >
                  Open Pipnote
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function App() {
  const { settings } = useSettings()
  const SIDEBAR_MIN = 240
  const SIDEBAR_MAX = 420
  const QA_MIN = 320
  const QA_MAX = 560
  const SIDEBAR_DEFAULT = 288
  const QA_DEFAULT = 384

  const [localAiAvailable, setLocalAiAvailable] = useState(false)
  const [localAiWarning, setLocalAiWarning] = useState<string | null>(null)
  const [isInitializing, setIsInitializing] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshTree, setRefreshTree] = useState<(() => Promise<void>) | null>(null)
  const [settingsRequestToken, setSettingsRequestToken] = useState(0)
  const refreshTreeRef = useRef<(() => Promise<void>) | null>(null)
  const refreshTimerRef = useRef<number | null>(null)
  const refreshInFlightRef = useRef(false)
  const refreshRequestedRef = useRef(false)
  const [showQAPanelState, setShowQAPanelState] = useState<boolean>(settings.showQAPanelByDefault)
  const [qaPanelUserControlled, setQaPanelUserControlled] = useState(false)
  const [showSidebarState, setShowSidebarState] = useState<boolean>(settings.showSidebarByDefault)
  const [sidebarUserControlled, setSidebarUserControlled] = useState(false)
  const [showTopBarState, setShowTopBarState] = useState<boolean>(settings.showTopBarByDefault)
  const [topBarUserControlled, setTopBarUserControlled] = useState(false)
  const showQAPanel = qaPanelUserControlled ? showQAPanelState : settings.showQAPanelByDefault
  const showSidebar = sidebarUserControlled ? showSidebarState : settings.showSidebarByDefault
  const showTopBar = topBarUserControlled ? showTopBarState : settings.showTopBarByDefault
  const [showKeywordSearch, setShowKeywordSearch] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [hasVaultConfigured, setHasVaultConfigured] = useState(false)
  const [isRefreshingOnboarding, setIsRefreshingOnboarding] = useState(false)
  const [isGeneratingOnboardingEmbeddings, setIsGeneratingOnboardingEmbeddings] = useState(false)
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | null>(null)
  const [reorganizeRequestToken, setReorganizeRequestToken] = useState(0)
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const raw = localStorage.getItem('vn_sidebar_width')
    const parsed = raw ? Number(raw) : SIDEBAR_DEFAULT
    return Number.isFinite(parsed) ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, parsed)) : SIDEBAR_DEFAULT
  })
  const [qaWidth, setQaWidth] = useState<number>(() => {
    const raw = localStorage.getItem('vn_qa_width')
    const parsed = raw ? Number(raw) : QA_DEFAULT
    return Number.isFinite(parsed) ? Math.min(QA_MAX, Math.max(QA_MIN, parsed)) : QA_DEFAULT
  })

  const openKeywordSearch = useCallback(() => {
    preloadKeywordSearchModal()
    setShowKeywordSearch(true)
  }, [])

  const markOnboardingComplete = useCallback(() => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, 'true')
    setShowOnboarding(false)
  }, [])

  const refreshOnboardingStatus = useCallback(async () => {
    setIsRefreshingOnboarding(true)
    try {
      const vaultReady = hasVaultSelectionForOnboarding()
      const [localAiHealthy, modelStatus, indexHealth] = await Promise.all([
        localAiService.checkHealth(),
        localAiService.getModelSelectionStatus().catch(() => null),
        vaultReady ? searchService.getIndexHealthStatus().catch(() => null) : Promise.resolve(null),
      ])

      setOnboardingStatus({
        vaultReady,
        localAiHealthy,
        modelStatus,
        indexHealth,
      })
    } finally {
      setIsRefreshingOnboarding(false)
    }
  }, [])

  useEffect(() => {
    refreshTreeRef.current = refreshTree
  }, [refreshTree])

  useEffect(() => {
    localStorage.setItem('vn_sidebar_width', String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    localStorage.setItem('vn_qa_width', String(qaWidth))
  }, [qaWidth])

  useEffect(() => {
    if (showSidebar) preloadSidebar()
  }, [showSidebar])

  useEffect(() => {
    if (showQAPanel) preloadQAPanel()
  }, [showQAPanel])

  useEffect(() => {
    const idleCallback = window.requestIdleCallback?.(() => {
      preloadKeywordSearchModal()
      if (showSidebar) preloadSidebar()
      if (showQAPanel) preloadQAPanel()
    }, { timeout: 1500 })

    if (typeof idleCallback === 'number') {
      return () => window.cancelIdleCallback?.(idleCallback)
    }

    const timer = window.setTimeout(() => {
      preloadKeywordSearchModal()
      if (showSidebar) preloadSidebar()
      if (showQAPanel) preloadQAPanel()
    }, 1200)

    return () => window.clearTimeout(timer)
  }, [showQAPanel, showSidebar])

  const updateShowQAPanel = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setQaPanelUserControlled(true)
    setShowQAPanelState((prev) => {
      const current = qaPanelUserControlled ? prev : settings.showQAPanelByDefault
      return typeof next === 'function' ? next(current) : next
    })
  }, [qaPanelUserControlled, settings.showQAPanelByDefault])

  const updateShowSidebar = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setSidebarUserControlled(true)
    setShowSidebarState((prev) => {
      const current = sidebarUserControlled ? prev : settings.showSidebarByDefault
      return typeof next === 'function' ? next(current) : next
    })
  }, [settings.showSidebarByDefault, sidebarUserControlled])

  const updateShowTopBar = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setTopBarUserControlled(true)
    setShowTopBarState((prev) => {
      const current = topBarUserControlled ? prev : settings.showTopBarByDefault
      return typeof next === 'function' ? next(current) : next
    })
  }, [settings.showTopBarByDefault, topBarUserControlled])

  const beginHorizontalResize = (mode: 'sidebar' | 'qa', startX: number) => {
    const startSidebarWidth = sidebarWidth
    const startQaWidth = qaWidth

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMouseMove = (event: MouseEvent) => {
      const dx = event.clientX - startX
      if (mode === 'sidebar') {
        const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startSidebarWidth + dx))
        setSidebarWidth(next)
        return
      }
      const next = Math.min(QA_MAX, Math.max(QA_MIN, startQaWidth - dx))
      setQaWidth(next)
    }

    const onMouseUp = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const resetLayout = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT)
    setQaWidth(QA_DEFAULT)
  }, [])

  const applyLayoutPreset = useCallback((preset: 'focus' | 'balanced' | 'research') => {
    if (preset === 'focus') {
      setSidebarWidth(252)
      setQaWidth(QA_DEFAULT)
      updateShowQAPanel(false)
      return
    }
    if (preset === 'balanced') {
      setSidebarWidth(300)
      setQaWidth(380)
      updateShowQAPanel(true)
      return
    }
    setSidebarWidth(272)
    setQaWidth(500)
    updateShowQAPanel(true)
  }, [updateShowQAPanel])

  const triggerReorganize = useCallback(() => {
    setReorganizeRequestToken(prev => prev + 1)
  }, [])

  const handleSidebarRefreshRegistration = useCallback((fn: () => Promise<void>) => {
    setRefreshTree(() => fn)
  }, [])

  const requestTreeRefresh = useCallback((options?: { immediate?: boolean }) => {
    const run = async () => {
      if (refreshInFlightRef.current) {
        refreshRequestedRef.current = true
        return
      }

      const refreshFn = refreshTreeRef.current
      if (!refreshFn) return

      refreshInFlightRef.current = true
      try {
        await refreshFn()
      } finally {
        refreshInFlightRef.current = false
        if (refreshRequestedRef.current) {
          refreshRequestedRef.current = false
          window.setTimeout(() => {
            void run()
          }, 60)
        }
      }
    }

    if (options?.immediate) {
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
      void run()
      return
    }

    refreshRequestedRef.current = true
    if (refreshTimerRef.current) return
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null
      refreshRequestedRef.current = false
      void run()
    }, 90)
  }, [])

  const handleChooseVaultFromOnboarding = useCallback(async () => {
    try {
      const selected = await vaultService.openFolder()
      if (selected) {
        await vaultService.initVault(selected)
        setHasVaultConfigured(true)
        requestTreeRefresh({ immediate: true })
        await refreshOnboardingStatus()
      }
    } catch {
      // Existing app-level feedback paths already log this.
    }
  }, [refreshOnboardingStatus, requestTreeRefresh])

  const handleOpenSettingsFromOnboarding = useCallback(() => {
    setSettingsRequestToken((prev) => prev + 1)
  }, [])

  const handleGenerateEmbeddingsFromOnboarding = useCallback(async () => {
    if (!onboardingStatus?.localAiHealthy) return
    setIsGeneratingOnboardingEmbeddings(true)
    try {
      const health = onboardingStatus.indexHealth
      if (health && health.indexedCount > 0) {
        await searchService.rebuildStaleAndMissingEmbeddings()
      } else {
        await searchService.regenerateAllEmbeddings()
      }
      await refreshOnboardingStatus()
    } finally {
      setIsGeneratingOnboardingEmbeddings(false)
    }
  }, [onboardingStatus, refreshOnboardingStatus])

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      const element = target as HTMLElement | null
      if (!element) return false
      const tagName = element.tagName
      return tagName === 'INPUT' || tagName === 'TEXTAREA' || element.isContentEditable
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      const hasCommand = event.metaKey || event.ctrlKey

      if (hasCommand && !event.altKey && !event.shiftKey && key === 'b') {
        event.preventDefault()
        preloadSidebar()
        updateShowSidebar(prev => !prev)
        return
      }

      if (hasCommand && event.altKey && !event.shiftKey && key === 't') {
        event.preventDefault()
        updateShowTopBar(prev => !prev)
        return
      }

      if (!hasCommand || !event.altKey) return
      if (isEditableTarget(event.target)) return

      if (key === '[') {
        event.preventDefault()
        setSidebarWidth(prev => Math.max(SIDEBAR_MIN, prev - 16))
        return
      }
      if (key === ']') {
        event.preventDefault()
        setSidebarWidth(prev => Math.min(SIDEBAR_MAX, prev + 16))
        return
      }
      if (key === '-') {
        event.preventDefault()
        updateShowQAPanel(true)
        setQaWidth(prev => Math.max(QA_MIN, prev - 16))
        return
      }
      if (key === '=' || key === '+') {
        event.preventDefault()
        updateShowQAPanel(true)
        setQaWidth(prev => Math.min(QA_MAX, prev + 16))
        return
      }
      if (key === '0') {
        event.preventDefault()
        resetLayout()
        return
      }
      if (key === '1') {
        event.preventDefault()
        applyLayoutPreset('focus')
        return
      }
      if (key === '2') {
        event.preventDefault()
        applyLayoutPreset('balanced')
        return
      }
      if (key === '3') {
        event.preventDefault()
        applyLayoutPreset('research')
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [applyLayoutPreset, resetLayout, updateShowQAPanel, updateShowSidebar, updateShowTopBar])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (event.key.toLowerCase() !== 'f') return
      // Global search stays on Cmd/Ctrl+Shift+F; Cmd/Ctrl+F is for current file search in editor.
      if (!event.shiftKey) return
      event.preventDefault()
      openKeywordSearch()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openKeywordSearch])

  useEffect(() => {
    const initialize = async () => {
      try {
        // Check local AI provider health
        const localAiHealthy = await localAiService.checkHealth()
        setLocalAiAvailable(localAiHealthy)

        if (!localAiHealthy) {
          setLocalAiWarning(localAiService.getHealthError() || 'Local AI provider is not running. Open Settings to select valid local models or start your provider.')
        }

        const seenOnboarding = hasCompletedOnboarding()
        const vaultReady = hasSavedVaultSelection()

        if (seenOnboarding && vaultReady) {
          await vaultService.initVault()
          setHasVaultConfigured(true)
        } else {
          setHasVaultConfigured(false)
        }

        if (!seenOnboarding || !vaultReady) {
          setShowOnboarding(true)
          void refreshOnboardingStatus()
        }
        setIsInitializing(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to initialize application')
        setIsInitializing(false)
      }
    }

    initialize()
  }, [refreshOnboardingStatus])

  if (error) {
    const isModelConfigError = error.toLowerCase().includes('model configuration is invalid') || error.toLowerCase().includes('missing:')
    return (
      <div className="h-screen flex items-center justify-center px-4">
        <div className="text-center max-w-lg px-6 py-8 rounded-2xl vn-surface vn-glass">
          <div className="mb-4">
            <svg className="w-16 h-16 text-red-600 dark:text-red-400 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-red-600 dark:text-red-300 mb-3">
            {localAiAvailable ? 'Initialization Error' : (isModelConfigError ? 'Local AI Models Not Ready' : 'Local AI Not Available')}
          </h1>
          <p className="vn-muted mb-4">{error}</p>
          {!localAiAvailable && (
            <div className="text-sm vn-muted bg-white/70 dark:bg-slate-900/50 rounded-xl p-4 text-left border border-slate-200/80 dark:border-slate-700/80">
              <p className="font-semibold mb-2">To fix this:</p>
              <ol className="list-decimal list-inside space-y-1">
                <li>Open Settings and confirm the selected provider is correct for your local setup.</li>
                <li>If you use Ollama, check running models with <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">ollama list</code> and start it with <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">ollama serve</code> if needed.</li>
                <li>If you use LM Studio, start the local server in LM Studio and verify the model is loaded.</li>
                <li>If needed, install Ollama from <a href="https://ollama.ai" className="text-blue-600 dark:text-blue-400 underline" target="_blank" rel="noopener noreferrer">ollama.ai</a>.</li>
                <li>Ensure the selected text and embedding models are available in your chosen provider.</li>
                <li>Restart this application</li>
              </ol>
            </div>
          )}
        </div>
      </div>
    )
  }

  if (isInitializing) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="vn-muted">Initializing application...</p>
        </div>
      </div>
    )
  }

  return (
    <ToastProvider>
      <TabProvider>
        <div className="h-screen flex flex-col overflow-hidden vn-panel-enter">
          <EditorProvider onTreeRefreshNeeded={() => requestTreeRefresh()}>
            {showTopBar ? (
              <Header
                onApplyLayoutPreset={applyLayoutPreset}
                onResetLayout={resetLayout}
                onToggleQAPanel={() => updateShowQAPanel(prev => !prev)}
                onToggleSidebar={() => updateShowSidebar(prev => !prev)}
                onToggleTopBar={() => updateShowTopBar(prev => !prev)}
                isSidebarVisible={showSidebar}
                isTopBarVisible={showTopBar}
                reorganizeRequestToken={reorganizeRequestToken}
                settingsRequestToken={settingsRequestToken}
                onOpenKeywordSearch={openKeywordSearch}
                onVaultMutated={() => requestTreeRefresh({ immediate: true })}
              />
            ) : (
              <div className="h-12 vn-surface vn-glass px-3 flex items-center justify-between gap-2 vn-panel-enter">
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">Minimal View</div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => updateShowSidebar(prev => !prev)}
                    className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-900 dark:text-slate-100 text-xs font-semibold vn-focusable vn-interactive vn-pressable"
                    title="Toggle File Tree (⌘B)"
                  >
                    {showSidebar ? 'Hide Files' : 'Show Files'}
                  </button>
                  <button
                    onMouseEnter={preloadKeywordSearchModal}
                    onFocus={preloadKeywordSearchModal}
                    onClick={openKeywordSearch}
                    className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-900 dark:text-slate-100 text-xs font-semibold vn-focusable vn-interactive vn-pressable"
                    title="Search Across Files (⌘⇧F)"
                  >
                    Search
                  </button>
                  <button
                    onClick={() => updateShowTopBar(true)}
                    className="px-3 py-1.5 rounded-lg vn-btn-primary text-white text-xs font-semibold vn-focusable vn-interactive vn-pressable"
                    title="Show Top Bar (⌘⌥T)"
                  >
                    Show Top Bar
                  </button>
                </div>
              </div>
            )}
            {localAiWarning && (
              <div className="px-4 py-2 border-b border-amber-300/80 dark:border-amber-700/80 bg-amber-50/90 dark:bg-amber-900/20 text-xs text-amber-800 dark:text-amber-200 flex items-center justify-between gap-3">
                <span className="truncate">
                  AI warning: {localAiWarning} Use Settings to choose installed models.
                </span>
                <button
                  onClick={() => setLocalAiWarning(null)}
                  className="px-2 py-1 rounded-md bg-amber-100 dark:bg-amber-900/30 hover:bg-amber-200 dark:hover:bg-amber-900/50 vn-interactive"
                >
                  Dismiss
                </button>
              </div>
            )}
            <div className="flex-1 flex overflow-hidden relative z-10">
              {/* Left Sidebar - File Tree */}
              {hasVaultConfigured && showSidebar ? (
                <>
                  <Suspense fallback={<SidebarFallback width={sidebarWidth} />}>
                    <Sidebar
                      onRefresh={handleSidebarRefreshRegistration}
                      width={sidebarWidth}
                      onStartReorganize={triggerReorganize}
                    />
                  </Suspense>
                  <div
                    className="w-1 bg-slate-300/45 dark:bg-slate-700/55 hover:bg-blue-400/70 dark:hover:bg-blue-500/70 cursor-col-resize transition-colors vn-interactive"
                    onMouseDown={(e) => beginHorizontalResize('sidebar', e.clientX)}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize sidebar"
                  />
                </>
              ) : hasVaultConfigured ? (
                <div className="flex items-center">
                  <button
                    onMouseEnter={preloadSidebar}
                    onFocus={preloadSidebar}
                    onClick={() => updateShowSidebar(true)}
                    className="h-full w-9 vn-surface vn-glass text-slate-700 dark:text-slate-200 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors vn-focusable vn-interactive vn-pressable"
                    title="Show File Tree (⌘B)"
                    aria-label="Show file tree"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5h16M4 12h8m-8 7h16M12 9l3 3-3 3" />
                    </svg>
                  </button>
                </div>
              ) : null}
              
              {/* Main Editor Area */}
              <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative vn-surface vn-panel-enter">
                {hasVaultConfigured ? (
                  <MainPanel />
                ) : (
                  <div className="h-full flex items-center justify-center p-6">
                    <div className="text-center max-w-md">
                      <div className="mx-auto mb-4 h-16 w-16 rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-100/70 dark:bg-slate-800/60 flex items-center justify-center">
                        <svg className="w-8 h-8 text-slate-500 dark:text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h5l2 2h7a2 2 0 012 2v2H3V7zm0 4h18v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-8z" />
                        </svg>
                      </div>
                      <h2 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Choose a vault to get started</h2>
                      <p className="mt-2 text-sm vn-muted">
                        Pipnote is ready, but it needs a notes folder before it can show files, search, or run AI features.
                      </p>
                      <button
                        onClick={() => {
                          void handleChooseVaultFromOnboarding()
                        }}
                        className="mt-5 px-4 py-2 rounded-xl vn-btn-primary text-white text-sm font-semibold vn-focusable vn-interactive vn-pressable"
                      >
                        Open notes folder
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {hasVaultConfigured && !showQAPanel && (
                <div className="flex items-center">
                  <button
                    onMouseEnter={preloadQAPanel}
                    onFocus={preloadQAPanel}
                    onClick={() => updateShowQAPanel(true)}
                    className="h-full w-10 border-l border-slate-200/80 dark:border-slate-700/80 bg-white/80 dark:bg-slate-900/60 text-slate-700 dark:text-slate-200 shadow-sm hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors flex flex-col items-center justify-center gap-2 vn-focusable vn-interactive vn-pressable"
                    title="Toggle Q&A Panel"
                    aria-label="Toggle Q&A Panel"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h8M8 14h5m-9 5l2.6-2A2 2 0 018 16h8a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h.2a2 2 0 011.4.6L9 19z" />
                    </svg>
                    <span
                      className="text-[10px] font-semibold uppercase tracking-[0.18em]"
                      style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
                    >
                      Assistant
                    </span>
                  </button>
                </div>
              )}
              
              {/* Right Sidebar - Q&A Panel */}
              {hasVaultConfigured && showQAPanel && (
                <>
                  <div
                    className="w-1 bg-slate-300/45 dark:bg-slate-700/55 hover:bg-blue-400/70 dark:hover:bg-blue-500/70 cursor-col-resize transition-colors vn-interactive"
                    onMouseDown={(e) => beginHorizontalResize('qa', e.clientX)}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize Q&A panel"
                  />
                  <div
                    className="flex flex-col overflow-hidden vn-surface vn-panel-enter"
                    style={{ width: `${qaWidth}px` }}
                  >
                  <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
                    <h3 className="font-semibold text-slate-900 dark:text-slate-100">Q&A Assistant</h3>
                    <button
                      onClick={() => updateShowQAPanel(false)}
                      className="p-1.5 hover:bg-blue-50 dark:hover:bg-slate-700 rounded-lg transition-colors vn-focusable vn-interactive vn-pressable"
                    >
                      <svg className="w-4 h-4 text-slate-600 dark:text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </div>
                  <Suspense fallback={<QAPanelFallback />}>
                    <QAPanel />
                  </Suspense>
                  </div>
                </>
              )}
            </div>
            {showKeywordSearch && (
              <Suspense fallback={null}>
                <KeywordSearchModal
                  isOpen={showKeywordSearch}
                  onClose={() => setShowKeywordSearch(false)}
                />
              </Suspense>
            )}
            {showOnboarding && (
              <OnboardingModal
                status={onboardingStatus}
                isRefreshing={isRefreshingOnboarding}
                isGeneratingEmbeddings={isGeneratingOnboardingEmbeddings}
                onRefresh={() => {
                  void refreshOnboardingStatus()
                }}
                onChooseVault={() => {
                  void handleChooseVaultFromOnboarding()
                }}
                onOpenSettings={handleOpenSettingsFromOnboarding}
                onGenerateEmbeddings={() => {
                  void handleGenerateEmbeddingsFromOnboarding()
                }}
                onClose={markOnboardingComplete}
              />
            )}
          </EditorProvider>
        </div>
      </TabProvider>
    </ToastProvider>
  )
}

export default App
