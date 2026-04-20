import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import FolderTree from './FolderTree'
import { vaultService } from '../services/vault'
import type { TreeNode } from '../services/vault'
import { useEditor } from '../contexts/EditorContext'
import { useToast } from '../contexts/ToastContext'
import { useSettings } from '../contexts/SettingsContext'
import { noteCollectionsService } from '../services/noteCollections'

function formatCollectionTitle(path: string): string {
  return path.split('/').pop()?.replace(/\.[^/.]+$/i, '') || path
}

function formatCollectionMeta(path: string): string {
  const segments = path.split('/')
  if (segments.length <= 1) return 'Vault root'
  return segments.slice(0, -1).join(' / ')
}

function computeTreeSignature(nodes: TreeNode[]): string {
  let hash = 2166136261 >>> 0
  const prime = 16777619

  const mix = (value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i)
      hash = Math.imul(hash, prime) >>> 0
    }
  }

  const walk = (items: TreeNode[]) => {
    for (const node of items) {
      mix(node.type)
      mix(node.path)
      mix(node.name)
      if (node.type === 'folder') {
        mix(String(node.children.length))
        walk(node.children)
      }
    }
  }

  walk(nodes)
  return `${nodes.length}:${hash}`
}

function shareTreeNodes(previous: TreeNode[], next: TreeNode[]): TreeNode[] {
  const previousByPath = new Map(previous.map((node) => [node.path, node]))
  return next.map((node) => {
    const prior = previousByPath.get(node.path)
    if (!prior || prior.type !== node.type || prior.name !== node.name) {
      if (node.type === 'folder') {
        return { ...node, children: shareTreeNodes([], node.children) }
      }
      return node
    }

    if (node.type === 'file') {
      return prior
    }

    if (prior.type !== 'folder') {
      return { ...node, children: shareTreeNodes([], node.children) }
    }

    const sharedChildren = shareTreeNodes(prior.children, node.children)
    const childrenUnchanged =
      prior.children.length === sharedChildren.length
      && prior.children.every((child, index) => child === sharedChildren[index])

    if (childrenUnchanged) {
      return prior
    }

    return { ...node, children: sharedChildren }
  })
}

function Sidebar({
  onRefresh,
  width,
  onStartReorganize,
}: {
  onRefresh?: (refreshFn: () => Promise<void>) => void
  width?: number
  onStartReorganize?: () => void
}) {
  const { openFile } = useEditor()
  const { showToast } = useToast()
  const { settings } = useSettings()
  const [tree, setTree] = useState<TreeNode[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [recentNotes, setRecentNotes] = useState<string[]>([])
  const [favoriteNotes, setFavoriteNotes] = useState<string[]>([])
  const [expandedSections, setExpandedSections] = useState<{ favorites: boolean; recent: boolean; ai: boolean }>({
    favorites: false,
    recent: false,
    ai: false,
  })
  const hasLoadedRef = useRef(false)
  const treeSignatureRef = useRef('')
  const treeScrollRef = useRef<HTMLDivElement>(null)

  const stats = useMemo(() => {
    const walk = (nodes: TreeNode[]): { files: number; folders: number } => {
      return nodes.reduce(
        (acc, node) => {
          if (node.type === 'file') {
            acc.files += 1
          } else {
            acc.folders += 1
            const child = walk(node.children)
            acc.files += child.files
            acc.folders += child.folders
          }
          return acc
        },
        { files: 0, folders: 0 }
      )
    }
    return walk(tree)
  }, [tree])

  const allFilePaths = useMemo(() => {
    const result: string[] = []
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.type === 'file') {
          result.push(node.path)
        } else {
          walk(node.children)
        }
      }
    }
    walk(tree)
    return result
  }, [tree])

  const unsortedCount = useMemo(() => {
    const count = (nodes: TreeNode[]): number => {
      let total = 0
      for (const node of nodes) {
        if (node.type === 'file') {
          const inUnsortedFolder = node.path.includes('/Unsorted/')
          const inRoot = /^notes\/[^/]+\.md$/.test(node.path)
          if (inUnsortedFolder || inRoot) total += 1
          continue
        }
        total += count(node.children)
      }
      return total
    }
    return count(tree)
  }, [tree])

  const loadTree = useCallback(async (options?: { preserveScroll?: boolean; showLoading?: boolean }) => {
    const preserveScroll = options?.preserveScroll ?? false
    const showLoading = options?.showLoading ?? !hasLoadedRef.current
    const previousScrollTop = preserveScroll ? treeScrollRef.current?.scrollTop ?? 0 : 0

    try {
      if (showLoading) {
        setIsLoading(true)
      }
      const vaultTree = await vaultService.getVaultTree()
      const nextSignature = computeTreeSignature(vaultTree)
      if (nextSignature !== treeSignatureRef.current) {
        treeSignatureRef.current = nextSignature
        setTree((previous) => shareTreeNodes(previous, vaultTree))
      }
    } catch (error) {
      console.error('Failed to load vault tree:', error)
    } finally {
      if (showLoading) {
        setIsLoading(false)
      }
      hasLoadedRef.current = true
      if (preserveScroll) {
        requestAnimationFrame(() => {
          if (treeScrollRef.current) {
            treeScrollRef.current.scrollTop = previousScrollTop
          }
        })
      }
    }
  }, [])

  const loadCollections = useCallback(() => {
    setRecentNotes(noteCollectionsService.getRecentNotes())
    setFavoriteNotes(noteCollectionsService.getFavoriteNotes())
  }, [])

  useEffect(() => {
    void loadTree({ showLoading: true, preserveScroll: false })
  }, [loadTree])

  useEffect(() => {
    if (onRefresh) {
      onRefresh(() => loadTree({ preserveScroll: true, showLoading: false }))
    }
  }, [onRefresh, loadTree])

  useEffect(() => {
    loadCollections()
  }, [loadCollections])

  useEffect(() => {
    const onCollectionsChanged = () => {
      loadCollections()
    }
    window.addEventListener(noteCollectionsService.changedEvent, onCollectionsChanged)
    return () => window.removeEventListener(noteCollectionsService.changedEvent, onCollectionsChanged)
  }, [loadCollections])

  const validPathSet = useMemo(() => new Set(allFilePaths), [allFilePaths])
  useEffect(() => {
    if (validPathSet.size === 0) return
    noteCollectionsService.pruneMissing(validPathSet)
  }, [validPathSet])

  const visibleRecent = useMemo(() => recentNotes.filter((path) => validPathSet.has(path)).slice(0, 5), [recentNotes, validPathSet])
  const visibleFavorites = useMemo(() => favoriteNotes.filter((path) => validPathSet.has(path)).slice(0, 8), [favoriteNotes, validPathSet])

  const openCollectionItem = useCallback((path: string) => {
    void openFile(path).catch((error) => {
      console.error('Failed to open file from sidebar collection:', error)
      showToast(error instanceof Error ? error.message : 'Failed to open file', 'error')
    })
  }, [openFile, showToast])

  const renderPathList = (
    items: string[],
    emptyLabel: string,
    options?: {
      kind?: 'favorite' | 'recent'
      helperLabel?: string
      onClearAll?: () => void
    },
  ) => {
    if (items.length === 0) {
      return (
        <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 px-3 py-3">
          <p className="text-[11px] vn-muted">{emptyLabel}</p>
        </div>
      )
    }

    return (
      <div className="space-y-2">
        {options?.helperLabel && (
          <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide vn-muted">
            <span>{options.helperLabel}</span>
            {options.onClearAll && (
              <button
                type="button"
                onClick={options.onClearAll}
                className="rounded-md px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 vn-interactive"
              >
                Clear
              </button>
            )}
          </div>
        )}
        {items.map((path) => {
          const title = formatCollectionTitle(path)
          const meta = formatCollectionMeta(path)
          return (
            <div
              key={path}
              className="group rounded-lg border border-slate-200 dark:border-slate-700 bg-white/70 dark:bg-slate-900/30 overflow-hidden"
            >
              <button
                type="button"
                onClick={() => openCollectionItem(path)}
                className="w-full text-left px-3 pt-2.5 pb-2 hover:bg-slate-100 dark:hover:bg-slate-800/80 vn-interactive"
                title={path}
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-slate-800 dark:text-slate-100">{title}</p>
                    <p className="mt-1 truncate text-[11px] vn-muted">{meta}</p>
                  </div>
                  <span className="mt-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                    {options?.kind === 'favorite' ? 'Saved' : 'Recent'}
                  </span>
                </div>
              </button>
              <div className="flex items-center justify-end gap-1 border-t border-slate-200/70 dark:border-slate-700/70 px-2 py-1.5 bg-slate-50/80 dark:bg-slate-950/20">
                {options?.kind === 'favorite' ? (
                  <button
                    type="button"
                    onClick={() => {
                      noteCollectionsService.removeFavorite(path)
                      showToast('Removed from favorites', 'success')
                    }}
                    className="rounded-md px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800 vn-interactive"
                  >
                    Remove
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      noteCollectionsService.removeRecent(path)
                      showToast('Removed from recent notes', 'success')
                    }}
                    className="rounded-md px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800 vn-interactive"
                  >
                    Hide
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => openCollectionItem(path)}
                  className="rounded-md px-2 py-1 text-[10px] font-semibold text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-900/20 vn-interactive"
                >
                  Open
                </button>
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  const toggleSection = (key: 'favorites' | 'recent' | 'ai') => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <aside className="vn-surface overflow-hidden flex flex-col vn-panel-enter flex-none" style={{ width: width ? `${width}px` : undefined }}>
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-gradient-to-r from-blue-50 to-sky-50 dark:from-slate-900 dark:to-slate-800">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100 tracking-tight">Notes</h2>
          <span className="text-[9px] uppercase font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200">
            Vault
          </span>
        </div>
        {!isLoading && (
          <p className="mt-1 text-[10px] vn-muted">
            {stats.files} notes • {stats.folders} folders
          </p>
        )}
      </div>
      <div ref={treeScrollRef} className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-4 text-center">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500 mx-auto"></div>
          </div>
        ) : (
          <FolderTree nodes={tree} onRefresh={loadTree} scrollContainerRef={treeScrollRef} />
        )}
      </div>
      <div className="border-t border-slate-200 dark:border-slate-700 bg-white/55 dark:bg-slate-900/35 px-3 py-2 space-y-2">
        {settings.pinFavoritesInSidebar && (
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
            <button
              onClick={() => toggleSection('favorites')}
              className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 vn-interactive"
            >
              <span className="flex items-center gap-2">
                <span>Favorites</span>
                <span className="rounded-full px-1.5 py-0.5 text-[10px] bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                  {visibleFavorites.length}
                </span>
              </span>
              <span>{expandedSections.favorites ? '▾' : '▸'}</span>
            </button>
            {expandedSections.favorites && (
              <div className="px-3 pb-3 max-h-40 overflow-y-auto">
                {renderPathList(visibleFavorites, 'Star important notes to keep them one click away.', {
                  kind: 'favorite',
                  helperLabel: visibleFavorites.length >= 8 ? 'Showing top 8 favorites' : 'Pinned for quick access',
                })}
              </div>
            )}
          </div>
        )}

        {settings.pinRecentInSidebar && (
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
            <button
              onClick={() => toggleSection('recent')}
              className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 vn-interactive"
            >
              <span className="flex items-center gap-2">
                <span>Recent</span>
                <span className="rounded-full px-1.5 py-0.5 text-[10px] bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                  {visibleRecent.length}
                </span>
              </span>
              <span>{expandedSections.recent ? '▾' : '▸'}</span>
            </button>
            {expandedSections.recent && (
              <div className="px-3 pb-3 max-h-40 overflow-y-auto">
                {renderPathList(visibleRecent, 'Open a few notes and they will show up here.', {
                  kind: 'recent',
                  helperLabel: 'Last 5 opened notes',
                  onClearAll: visibleRecent.length > 0
                    ? () => {
                        noteCollectionsService.clearRecent()
                        showToast('Cleared recent notes', 'success')
                      }
                    : undefined,
                })}
              </div>
            )}
          </div>
        )}

        <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
          <button
            onClick={() => toggleSection('ai')}
            className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 vn-interactive"
          >
            <span>AI Tools</span>
            <span>{expandedSections.ai ? '▾' : '▸'}</span>
          </button>
          {expandedSections.ai && (
            <div className="px-3 pb-3 max-h-40 overflow-y-auto">
              <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-2.5 bg-white/65 dark:bg-slate-900/35">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-[10px] font-semibold text-slate-800 dark:text-slate-100">Vault Analysis</p>
                  {unsortedCount > 0 && (
                    <span className="ml-auto px-1.5 py-0.5 rounded-full text-[10px] bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
                      {unsortedCount} unsorted
                    </span>
                  )}
                </div>
                <p className="text-[10px] vn-muted mb-2">Analyze structure and review move suggestions.</p>
                <button
                  onClick={onStartReorganize}
                  className="w-full px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-semibold vn-focusable vn-interactive vn-pressable"
                >
                  Reorganize Vault
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}

export default Sidebar
