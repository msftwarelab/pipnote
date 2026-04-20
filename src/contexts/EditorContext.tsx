import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { recordPerfMetric, startPerfTimer } from '../utils/perfMetrics'
import { vaultService, type FilePreviewData } from '../services/vault'
import { localAiService } from '../services/localAi'
import { notePostProcessingService } from '../services/notePostProcessing'
import { embeddingQueueService } from '../services/embeddingQueue'
import type { TreeNode } from '../services/vault'

export interface EditorTab {
  id: string
  filePath: string | null
  content: string
  originalContent: string
  isNewNote: boolean
  kind: 'text' | 'preview'
  previewData?: FilePreviewData
}

interface EditorContextType {
  tabs: EditorTab[]
  activeTabId: string | null
  activeTab: EditorTab | null
  currentFile: string | null
  content: string
  hasUnsavedChanges: boolean
  isNewNote: boolean
  isSaving: boolean
  saveVersion: number
  openFile: (path: string) => Promise<void>
  createNewNote: () => void
  updateContent: (newContent: string) => void
  saveFile: (options?: { silent?: boolean }) => Promise<void>
  saveAllDirtyTabs: (options?: { silent?: boolean }) => Promise<{ savedCount: number; skippedCount: number }>
  renamePath: (oldPath: string, newName: string) => Promise<string>
  reconcileTabsWithVault: () => Promise<{ closedCount: number }>
  closeFile: () => void
  switchTab: (tabId: string) => void
  closeTab: (tabId: string) => Promise<void>
  canGoBack: boolean
  canGoForward: boolean
  goBack: () => Promise<void>
  goForward: () => Promise<void>
  onTreeRefreshNeeded?: () => void
}

const EditorContext = createContext<EditorContextType | undefined>(undefined)

interface NavigationEntry {
  tabId: string | null
  filePath: string | null
  isNewNote: boolean
}

function collectNearbyFilePaths(nodes: TreeNode[], targetPath: string, openPaths: Set<string>, limit: number = 5): string[] {
  const result: string[] = []

  const visitFolder = (items: TreeNode[]): boolean => {
    for (const node of items) {
      if (node.type === 'folder') {
        if (visitFolder(node.children)) return true
        continue
      }

      if (node.path !== targetPath) continue

      const siblingFiles = items.filter((item): item is Extract<TreeNode, { type: 'file' }> => item.type === 'file')
      const currentIndex = siblingFiles.findIndex((item) => item.path === targetPath)
      if (currentIndex === -1) return true

      for (let offset = 1; offset <= siblingFiles.length && result.length < limit; offset += 1) {
        const before = siblingFiles[currentIndex - offset]
        if (before && !openPaths.has(before.path)) {
          result.push(before.path)
          if (result.length >= limit) break
        }

        const after = siblingFiles[currentIndex + offset]
        if (after && !openPaths.has(after.path) && result.length < limit) {
          result.push(after.path)
        }
      }
      return true
    }
    return false
  }

  visitFolder(nodes)
  return result
}

function isPreviewablePath(path: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|bmp|svg|pdf|docx|pptx|xlsx)$/i.test(path)
}

export function EditorProvider({ children, onTreeRefreshNeeded }: { children: ReactNode; onTreeRefreshNeeded?: () => void }) {
  const [tabs, setTabs] = useState<EditorTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [saveVersion, setSaveVersion] = useState(0)
  const [navigationState, setNavigationState] = useState({ canGoBack: false, canGoForward: false })
  const saveInFlightRef = useRef(false)
  const tabsRef = useRef<EditorTab[]>([])
  const activeTabIdRef = useRef<string | null>(null)
  const autoSaveTimersRef = useRef<Map<string, number>>(new Map())
  const openRequestSeqRef = useRef(0)

  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  useEffect(() => {
    activeTabIdRef.current = activeTabId
  }, [activeTabId])

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
  const currentFile = activeTab?.filePath ?? null
  const content = activeTab?.content ?? ''
  const originalContent = activeTab?.originalContent ?? ''
  const isNewNote = activeTab?.isNewNote ?? false
  const hasUnsavedChanges = !!activeTab && content !== originalContent
  const navigationHistoryRef = useRef<NavigationEntry[]>([])
  const navigationIndexRef = useRef(-1)
  const suppressNavigationRecordRef = useRef(false)

  const syncNavigationState = useCallback(() => {
    setNavigationState({
      canGoBack: navigationIndexRef.current > 0,
      canGoForward:
        navigationIndexRef.current >= 0
        && navigationIndexRef.current < navigationHistoryRef.current.length - 1,
    })
  }, [])

  useEffect(() => {
    embeddingQueueService.setActivePath(currentFile)
  }, [currentFile])

  useEffect(() => {
    if (!currentFile || isPreviewablePath(currentFile)) return

    let cancelled = false
    const schedulePrefetch = async () => {
      try {
        const tree = await vaultService.getVaultTree()
        if (cancelled) return
        const openPaths = new Set(tabsRef.current.map((tab) => tab.filePath).filter((path): path is string => typeof path === 'string'))
        const nearbyPaths = collectNearbyFilePaths(tree, currentFile, openPaths, 6)
        vaultService.prefetchFiles(nearbyPaths)
      } catch {
        // Neighbor prefetch is best-effort only.
      }
    }

    const timer = window.setTimeout(() => {
      void schedulePrefetch()
    }, 140)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [currentFile])

  const clearAutoSaveTimer = useCallback((tabId: string) => {
    const timer = autoSaveTimersRef.current.get(tabId)
    if (typeof timer === 'number') {
      window.clearTimeout(timer)
      autoSaveTimersRef.current.delete(tabId)
    }
  }, [])

  const saveTabById = useCallback(async (tabId: string, options?: { silent?: boolean }): Promise<boolean> => {
    const tab = tabsRef.current.find((item) => item.id === tabId)
    if (!tab) return false
    if (tab.kind === 'preview') return false

    clearAutoSaveTimer(tabId)

    const shouldSkipEmptyNewNote = tab.isNewNote && !tab.content.trim()
    if (shouldSkipEmptyNewNote) return false

    const needsSave = tab.isNewNote ? !!tab.content.trim() : tab.content !== tab.originalContent
    if (!needsSave) return false

    const silent = options?.silent ?? false
    if (!silent) setIsSaving(true)

    try {
      if (tab.isNewNote) {
        const contentToSave = tab.content
        const classification = await localAiService.classifyNote(contentToSave)
        const fileName = `${classification.title}.md`
        const requestedPath = classification.subcategory
          ? `${classification.category}/${classification.subcategory}/${fileName}`
          : `${classification.category}/${fileName}`

        const actualPath = await vaultService.writeFile(requestedPath, contentToSave)
        notePostProcessingService.schedule(actualPath, contentToSave, { embeddingPriority: 'high' })

        setTabs((prev) =>
          prev.map((item) =>
            item.id === tabId
              ? {
                  ...item,
                  filePath: actualPath,
                  originalContent: contentToSave,
                  isNewNote: false,
                }
              : item,
          ),
        )

        onTreeRefreshNeeded?.()
        setSaveVersion((prev) => prev + 1)
        return true
      }

      if (!tab.filePath) {
        throw new Error('No file is currently open')
      }

      const contentToSave = tab.content
      const actualPath = await vaultService.writeFile(tab.filePath, contentToSave)
      notePostProcessingService.schedule(actualPath, contentToSave, { embeddingPriority: 'high' })

      setTabs((prev) =>
        prev.map((item) =>
          item.id === tabId
            ? {
                ...item,
                filePath: actualPath,
                originalContent: contentToSave,
              }
            : item,
        ),
      )

      if (actualPath !== tab.filePath) {
        onTreeRefreshNeeded?.()
      }

      setSaveVersion((prev) => prev + 1)
      return true
    } finally {
      if (!silent) setIsSaving(false)
    }
  }, [clearAutoSaveTimer, onTreeRefreshNeeded])

  const scheduleAutoSave = (tabId: string) => {
    clearAutoSaveTimer(tabId)
    const timer = window.setTimeout(() => {
      autoSaveTimersRef.current.delete(tabId)
      void saveTabById(tabId, { silent: true }).catch((error: unknown) => {
        console.error('Live save failed:', error)
      })
    }, 700)
    autoSaveTimersRef.current.set(tabId, timer)
  }

  const openFile = useCallback(async (path: string) => {
    const startTime = startPerfTimer()
    const requestSeq = ++openRequestSeqRef.current
    try {
      const existing = tabsRef.current.find((tab) => tab.filePath === path)
      if (existing) {
        setActiveTabId(existing.id)
        recordPerfMetric('file_open_ms', startTime, {
          alreadyOpen: true,
          kind: existing.kind,
          extension: path.split('.').pop()?.toLowerCase() ?? '',
        })
        return
      }

      let tab: EditorTab
      if (isPreviewablePath(path)) {
        const previewData = await vaultService.readFilePreview(path)
        if (requestSeq !== openRequestSeqRef.current) return
        tab = {
          id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          filePath: path,
          content: previewData.text || '',
          originalContent: previewData.text || '',
          isNewNote: false,
          kind: 'preview',
          previewData,
        }
      } else {
        const fileContent = await vaultService.readFile(path)
        if (requestSeq !== openRequestSeqRef.current) return
        tab = {
          id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          filePath: path,
          content: fileContent,
          originalContent: fileContent,
          isNewNote: false,
          kind: 'text',
        }
      }
      if (requestSeq !== openRequestSeqRef.current) return
      setTabs((prev) => [...prev, tab])
      setActiveTabId(tab.id)
      recordPerfMetric('file_open_ms', startTime, {
        alreadyOpen: false,
        kind: tab.kind,
        extension: path.split('.').pop()?.toLowerCase() ?? '',
      })
    } catch (error) {
      console.error('Failed to open file:', error)
      throw error
    }
  }, [])

  const createNewNote = () => {
    const tab: EditorTab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filePath: null,
      content: '',
      originalContent: '',
      isNewNote: true,
      kind: 'text',
    }
    setTabs((prev) => [...prev, tab])
    setActiveTabId(tab.id)
  }

  const updateContent = (newContent: string) => {
    if (!activeTabId) return
    if (activeTab?.kind === 'preview') return
    setTabs((prev) =>
      prev.map((tab) => (tab.id === activeTabId ? { ...tab, content: newContent } : tab))
    )
    scheduleAutoSave(activeTabId)
  }

  const saveFile = async (options?: { silent?: boolean }) => {
    if (!activeTabId) {
      throw new Error('No file is currently open')
    }

    if (saveInFlightRef.current) return
    saveInFlightRef.current = true

    const silent = options?.silent ?? false
    if (!silent) {
      setIsSaving(true)
    }
    try {
      const tab = tabsRef.current.find((item) => item.id === activeTabId)
      if (!tab) {
        throw new Error('No file is currently open')
      }
      if (tab.kind === 'preview') {
        return
      }
      await saveTabById(tab.id, { silent: true })
    } catch (error) {
      console.error('❌ Failed to save file:', error)
      throw error
    } finally {
      saveInFlightRef.current = false
      if (!silent) {
        setIsSaving(false)
      }
    }
  }

  const saveAllDirtyTabs = async (options?: { silent?: boolean }): Promise<{ savedCount: number; skippedCount: number }> => {
    const silent = options?.silent ?? false
    const dirtyTabs = tabsRef.current.filter((tab) => (tab.isNewNote ? !!tab.content.trim() : tab.content !== tab.originalContent))
    let savedCount = 0
    let skippedCount = 0
    for (const tab of dirtyTabs) {
      const saved = await saveTabById(tab.id, { silent })
      if (saved) savedCount += 1
      else skippedCount += 1
    }
    return { savedCount, skippedCount }
  }

  const renamePath = async (oldPath: string, newName: string): Promise<string> => {
    const matchingTab = tabsRef.current.find((tab) => tab.filePath === oldPath)
    if (matchingTab && matchingTab.content !== matchingTab.originalContent) {
      await saveTabById(matchingTab.id, { silent: true })
    }
    const nextPath = await vaultService.renamePath(oldPath, newName)
    setTabs((prev) =>
      prev.map((tab) => {
        if (!tab.filePath) return tab
        if (tab.filePath === oldPath) {
          return { ...tab, filePath: nextPath }
        }
        if (tab.filePath.startsWith(`${oldPath}/`)) {
          const suffix = tab.filePath.slice(oldPath.length + 1)
          return { ...tab, filePath: `${nextPath}/${suffix}` }
        }
        return tab
      }),
    )
    navigationHistoryRef.current = navigationHistoryRef.current.map((entry) => {
      if (!entry.filePath) return entry
      if (entry.filePath === oldPath) {
        return { ...entry, filePath: nextPath }
      }
      if (entry.filePath.startsWith(`${oldPath}/`)) {
        const suffix = entry.filePath.slice(oldPath.length + 1)
        return { ...entry, filePath: `${nextPath}/${suffix}` }
      }
      return entry
    })
    syncNavigationState()
    onTreeRefreshNeeded?.()
    return nextPath
  }

  const reconcileTabsWithVault = async (): Promise<{ closedCount: number }> => {
    const tree = await vaultService.getVaultTree({ forceRefresh: true })
    const validPaths = new Set<string>()
    const walk = (nodes: typeof tree) => {
      for (const node of nodes) {
        if (node.type === 'file') {
          validPaths.add(node.path)
        } else {
          walk(node.children)
        }
      }
    }
    walk(tree)

    let closedCount = 0
    setTabs((prev) => {
      const nextTabs = prev.filter((tab) => {
        if (!tab.filePath) return true
        const keep = validPaths.has(tab.filePath)
        if (!keep) closedCount += 1
        return keep
      })
      const activeStillExists = nextTabs.some((tab) => tab.id === activeTabIdRef.current)
      if (!activeStillExists) {
        setActiveTabId(nextTabs[0]?.id ?? null)
      }
      return nextTabs
    })

    return { closedCount }
  }

  const switchTab = (tabId: string) => {
    if (!tabs.some((tab) => tab.id === tabId)) return
    setActiveTabId(tabId)
  }

  const resolveNavigationTarget = useCallback(async (entry: NavigationEntry | undefined): Promise<boolean> => {
    if (!entry) return false

    if (entry.tabId) {
      const existingTab = tabsRef.current.find((tab) => tab.id === entry.tabId)
      if (existingTab) {
        setActiveTabId(existingTab.id)
        return true
      }
    }

    if (entry.filePath) {
      const existingFileTab = tabsRef.current.find((tab) => tab.filePath === entry.filePath)
      if (existingFileTab) {
        setActiveTabId(existingFileTab.id)
        return true
      }

      try {
        await openFile(entry.filePath)
        return true
      } catch {
        return false
      }
    }

    return false
  }, [openFile])

  const goToNavigationIndex = useCallback(async (direction: -1 | 1) => {
    if (navigationHistoryRef.current.length === 0) return

    let nextIndex = navigationIndexRef.current + direction
    while (nextIndex >= 0 && nextIndex < navigationHistoryRef.current.length) {
      suppressNavigationRecordRef.current = true
      const moved = await resolveNavigationTarget(navigationHistoryRef.current[nextIndex])
      if (moved) {
        navigationIndexRef.current = nextIndex
        syncNavigationState()
        return
      }
      navigationHistoryRef.current.splice(nextIndex, 1)
      syncNavigationState()
      if (direction < 0) {
        nextIndex -= 1
      }
    }
    suppressNavigationRecordRef.current = false
  }, [resolveNavigationTarget, syncNavigationState])

  const goBack = useCallback(async () => {
    if (navigationIndexRef.current <= 0) return
    await goToNavigationIndex(-1)
  }, [goToNavigationIndex])

  const goForward = useCallback(async () => {
    if (navigationIndexRef.current >= navigationHistoryRef.current.length - 1) return
    await goToNavigationIndex(1)
  }, [goToNavigationIndex])

  const closeTab = async (tabId: string) => {
    const tab = tabsRef.current.find((item) => item.id === tabId)
    if (tab && (tab.isNewNote ? !!tab.content.trim() : tab.content !== tab.originalContent)) {
      await saveTabById(tabId, { silent: true })
    }

    clearAutoSaveTimer(tabId)
    setTabs((prev) => {
      const index = prev.findIndex((item) => item.id === tabId)
      if (index === -1) return prev

      const nextTabs = prev.filter((item) => item.id !== tabId)
      if (activeTabIdRef.current === tabId) {
        const fallback = nextTabs[index] ?? nextTabs[index - 1] ?? null
        setActiveTabId(fallback?.id ?? null)
      }
      return nextTabs
    })
  }

  const closeFile = () => {
    if (!activeTabId) return
    void closeTab(activeTabId)
  }

  useEffect(() => {
    const currentEntry: NavigationEntry = {
      tabId: activeTab?.id ?? null,
      filePath: activeTab?.filePath ?? null,
      isNewNote: activeTab?.isNewNote ?? false,
    }

    if (suppressNavigationRecordRef.current) {
      suppressNavigationRecordRef.current = false
      return
    }

    if (!currentEntry.tabId && !currentEntry.filePath) {
      return
    }

    const history = navigationHistoryRef.current
    const currentIndex = navigationIndexRef.current
    const currentSnapshot = currentIndex >= 0 ? history[currentIndex] : null
    const isSameAsCurrent = currentSnapshot
      && currentSnapshot.tabId === currentEntry.tabId
      && currentSnapshot.filePath === currentEntry.filePath
      && currentSnapshot.isNewNote === currentEntry.isNewNote

    if (isSameAsCurrent) {
      return
    }

    const truncated = currentIndex >= 0 ? history.slice(0, currentIndex + 1) : []
    truncated.push(currentEntry)
    navigationHistoryRef.current = truncated.slice(-120)
    navigationIndexRef.current = navigationHistoryRef.current.length - 1
    syncNavigationState()
  }, [activeTab?.id, activeTab?.filePath, activeTab?.isNewNote, syncNavigationState])

  useEffect(() => {
    const timers = autoSaveTimersRef.current
    const flushDirtyTabsSilently = async () => {
      const dirtyTabs = tabsRef.current.filter((tab) => (tab.isNewNote ? !!tab.content.trim() : tab.content !== tab.originalContent))
      for (const tab of dirtyTabs) {
        try {
          await saveTabById(tab.id, { silent: true })
        } catch (error) {
          console.error('Failed to flush dirty tabs while app was hidden:', error)
        }
      }
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        void flushDirtyTabsSilently()
      }
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const hasDirtyTabs = tabsRef.current.some((tab) => (tab.isNewNote ? !!tab.content.trim() : tab.content !== tab.originalContent))
      if (!hasDirtyTabs && !saveInFlightRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('beforeunload', handleBeforeUnload)
      timers.forEach((timer) => window.clearTimeout(timer))
      timers.clear()
    }
  }, [saveTabById])

  return (
    <EditorContext.Provider
      value={{
        tabs,
        activeTabId,
        activeTab,
        currentFile,
        content,
        hasUnsavedChanges,
        isNewNote,
        isSaving,
        saveVersion,
        openFile,
        createNewNote,
        updateContent,
        saveFile,
        saveAllDirtyTabs,
        renamePath,
        reconcileTabsWithVault,
        closeFile,
        switchTab,
        closeTab,
        canGoBack: navigationState.canGoBack,
        canGoForward: navigationState.canGoForward,
        goBack,
        goForward,
        onTreeRefreshNeeded,
      }}
    >
      {children}
    </EditorContext.Provider>
  )
}

export function useEditor() {
  const context = useContext(EditorContext)
  if (context === undefined) {
    throw new Error('useEditor must be used within an EditorProvider')
  }
  return context
}
