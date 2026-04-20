import { useState, useRef, useEffect, useMemo, useCallback, type RefObject } from 'react'
import { ask } from '@tauri-apps/plugin-dialog'
import type { TreeNode } from '../services/vault'
import { useEditor } from '../contexts/EditorContext'
import { useToast } from '../contexts/ToastContext'
import { vaultService } from '../services/vault'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'

interface TreeNodeProps {
  node: TreeNode
  level: number
  onRefresh: () => void
  expandedPaths: Set<string>
  onToggleFolder: (path: string, forceExpand?: boolean) => void
  selectedPaths: Set<string>
  onSelectFile: (path: string, event: React.MouseEvent) => void
  onSelectFolder: (path: string) => void
  onDeleteSelected: () => void
  selectedCount: number
  clipboard: { paths: string[]; operation: 'copy' | 'cut' }
  onCopy: (paths: string[]) => Promise<void>
  onCut: (paths: string[]) => Promise<void>
  onPaste: (targetPath: string) => Promise<void>
  lastSelectedFolderPath: string | null
  pendingRenamePath: string | null
  onPendingRenamePathChange: (path: string | null) => void
  renderChildren?: boolean
}

function TreeNodeComponent({ node, level, onRefresh, expandedPaths, onToggleFolder, selectedPaths, onSelectFile, onSelectFolder, onDeleteSelected, selectedCount, clipboard, onCopy, onCut, onPaste, lastSelectedFolderPath, pendingRenamePath, onPendingRenamePathChange, renderChildren = true }: TreeNodeProps) {
  const INDENT_SIZE = 16
  const FILE_BASE_OFFSET = 28
  const FOLDER_BASE_OFFSET = 8
  const isExpanded = expandedPaths.has(node.path)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const { openFile, currentFile, renamePath } = useEditor()
  const { showToast } = useToast()

  const getErrorMessage = (error: unknown, fallback: string) => {
    if (error instanceof Error && error.message) return error.message
    if (typeof error === 'string') return error
    return fallback
  }

  const handleFileClick = async (event: React.MouseEvent) => {
    if (node.type !== 'file') {
      return
    }

    event.stopPropagation()
    onSelectFile(node.path, event)

    if (!event.shiftKey) {
      try {
        await openFile(node.path)
      } catch (error) {
        console.error('Failed to open file:', error)
        showToast(getErrorMessage(error, `Failed to open "${node.name}"`), 'error')
      }
    }
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  const handleDelete = async () => {
    
    const confirmMsg = node.type === 'folder' 
      ? `Delete folder "${node.name}" and all its contents?`
      : `Delete "${node.name}"?`
    
    
    try {
      const userConfirmed = await ask(confirmMsg, {
        title: 'Confirm Delete',
        kind: 'warning',
      })
      
      
      if (userConfirmed) {
        try {
          await vaultService.deletePath(node.path)
          showToast(`Deleted ${node.type === 'folder' ? 'folder' : 'file'} "${node.name}"`, 'success')
          onRefresh()
        } catch (error) {
          console.error('❌ Failed to delete:', error)
          showToast('Failed to delete. Please try again.', 'error')
        }
      }
    } catch (error) {
      console.error('❌ Dialog error:', error)
      showToast('Failed to show delete confirmation', 'error')
    }
  }

  const createDefaultNamedItem = async (kind: 'file' | 'folder') => {
    const baseName = 'Untitled'
    const maxAttempts = 500

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const candidate = attempt === 0 ? baseName : `${baseName} ${attempt}`

      try {
        if (kind === 'file') {
          const newPath = await vaultService.createFileInFolder(node.path, candidate)
          onPendingRenamePathChange(newPath)
          onToggleFolder(node.path, true)
          onRefresh()
          await openFile(newPath)
          showToast('New file created', 'success')
          return
        }

        const newFolderPath = await vaultService.createFolder(node.path, candidate)
        onPendingRenamePathChange(newFolderPath)
        onToggleFolder(node.path, true)
        onRefresh()
        showToast('New folder created', 'success')
        return
      } catch {
        // Try the next name when there is a collision.
      }
    }

    showToast(`Failed to create ${kind}. Please try again.`, 'error')
  }

  const handleCreateFile = async () => {
    await createDefaultNamedItem('file')
  }

  const handleCreateFolder = async () => {
    await createDefaultNamedItem('folder')
  }

  const handleRename = () => {
    const nameWithoutExt = node.type === 'file' ? node.name.replace(/\.md$/, '') : node.name
    setRenameValue(nameWithoutExt)
    setIsRenaming(true)
  }

  // Auto-focus and select text when renaming starts
  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isRenaming])

  useEffect(() => {
    if (pendingRenamePath !== node.path) return
    const nameWithoutExt = node.type === 'file' ? node.name.replace(/\.md$/, '') : node.name
    const timer = window.setTimeout(() => {
      setRenameValue(nameWithoutExt)
      setIsRenaming(true)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [pendingRenamePath, node.name, node.path, node.type])

  const handleRenameSubmit = async () => {
    if (!renameValue.trim()) {
      setIsRenaming(false)
      onPendingRenamePathChange(null)
      return
    }

    
    try {
      // For files, add .md extension if not present
      let finalName = renameValue.trim()
      if (node.type === 'file' && !finalName.endsWith('.md')) {
        finalName = finalName + '.md'
      }
      
      await renamePath(node.path, finalName)
      setIsRenaming(false)
      onPendingRenamePathChange(null)
    } catch (error) {
      console.error('❌ Failed to rename:', error)
      setIsRenaming(false)
    }
  }

  const handleRenameCancel = () => {
    setIsRenaming(false)
    onPendingRenamePathChange(null)
  }

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleRenameSubmit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleRenameCancel()
    }
  }

  const handleCopy = async () => {
    const pathsToCopy = selectedCount > 1 && selectedPaths.has(node.path) 
      ? Array.from(selectedPaths)
      : [node.path]
    
    await onCopy(pathsToCopy)
  }

  const handleCut = async () => {
    const pathsToCut = selectedCount > 1 && selectedPaths.has(node.path)
      ? Array.from(selectedPaths)
      : [node.path]
    
    await onCut(pathsToCut)
  }

  const handlePaste = async () => {
    const targetFolder = node.type === 'folder' ? node.path : node.path.split('/').slice(0, -1).join('/')
    await onPaste(targetFolder)
  }

  const getContextMenuItems = (): ContextMenuItem[] => {
    if (node.type === 'file') {
      const items: ContextMenuItem[] = [
        {
          label: 'Copy',
          icon: (
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          ),
          onClick: handleCopy,
        },
        {
          label: 'Cut',
          icon: (
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
            </svg>
          ),
          onClick: handleCut,
        },
        {
          label: 'Paste',
          icon: (
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          ),
          onClick: handlePaste,
          disabled: clipboard.paths.length === 0,
        },
        {
          label: 'Rename',
          icon: (
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          ),
          onClick: handleRename,
        },
        {
          label: '',
          onClick: () => {},
          separator: true,
        },
        {
          label: 'Delete',
          icon: (
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          ),
          onClick: handleDelete,
          danger: true,
        },
      ]

      if (selectedCount > 1 && selectedPaths.has(node.path)) {
        items.unshift({
          label: `Delete Selected (${selectedCount})`,
          onClick: onDeleteSelected,
          danger: true,
        })
        items.unshift({ label: '', onClick: () => {}, separator: true })
      }

      return items
    } else {
      const folderItems: ContextMenuItem[] = [
        {
          label: 'New File',
          icon: (
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          ),
          onClick: handleCreateFile,
        },
        {
          label: 'New Folder',
          icon: (
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h5l2 2h7a2 2 0 012 2v2H3V7z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 11h18v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-8z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 14v4m2-2h-4" />
            </svg>
          ),
          onClick: handleCreateFolder,
        },
        {
          label: 'Paste',
          icon: (
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          ),
          onClick: handlePaste,
          disabled: clipboard.paths.length === 0,
        },
        {
          label: 'Rename Folder',
          icon: (
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          ),
          onClick: handleRename,
        },
        {
          label: '',
          onClick: () => {},
          separator: true,
        },
        {
          label: 'Delete Folder',
          icon: (
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          ),
          onClick: handleDelete,
          danger: true,
        },
      ]

      return folderItems
    }
  }

  const isActive = node.type === 'file' && currentFile === node.path
  // Only show file as selected (blue) if it's in selectedPaths AND no folder is selected
  const isSelected = node.type === 'file' && selectedPaths.has(node.path)

  const handleFolderClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onSelectFolder(node.path)
    onToggleFolder(node.path)
  }

  if (node.type === 'file') {
    return (
      <>
        <div
          className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-[13px] vn-tree-row ${
            isSelected
              ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-900 dark:text-blue-100 border border-blue-200 dark:border-blue-700'
              : isActive
                ? 'bg-slate-200/80 dark:bg-slate-700/80 text-slate-900 dark:text-slate-100 font-medium'
                : 'hover:bg-slate-100 dark:hover:bg-slate-800/70'
          }`}
          style={{ paddingLeft: `${level * INDENT_SIZE + FILE_BASE_OFFSET}px` }}
          onClick={!isRenaming ? handleFileClick : undefined}
          onContextMenu={handleContextMenu}
        >
          <svg className="w-4 h-4 text-slate-400 dark:text-slate-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
          {isRenaming ? (
            <input
              ref={inputRef}
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={handleRenameKeyDown}
              onBlur={handleRenameSubmit}
              className="flex-1 px-1 py-0.5 text-[13px] bg-white dark:bg-slate-800 border border-blue-500 dark:border-blue-400 rounded outline-none text-slate-900 dark:text-slate-100 vn-focusable"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="text-slate-700 dark:text-slate-300 truncate">{node.name.replace(/\.md$/, '')}</span>
          )}
        </div>
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={getContextMenuItems()}
            onClose={() => setContextMenu(null)}
          />
        )}
      </>
    )
  }

  return (
    <>
      <div
        className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-[13px] vn-tree-row ${
          lastSelectedFolderPath === node.path
            ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-900 dark:text-blue-100 border border-blue-200 dark:border-blue-700'
            : 'hover:bg-slate-100 dark:hover:bg-slate-800/70'
        }`}
        style={{ paddingLeft: `${level * INDENT_SIZE + FOLDER_BASE_OFFSET}px` }}
        onClick={!isRenaming ? handleFolderClick : undefined}
        onContextMenu={handleContextMenu}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleFolder(node.path)
          }}
          className="p-0.5 hover:bg-slate-200 dark:hover:bg-slate-700 rounded vn-focusable vn-interactive vn-pressable"
        >
          <svg
            className={`w-4 h-4 text-slate-400 dark:text-slate-500 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <svg className="w-4 h-4 text-blue-500 dark:text-blue-300 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        {isRenaming ? (
          <input
            ref={inputRef}
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameSubmit}
            className="flex-1 px-1 py-0.5 text-[13px] bg-white dark:bg-slate-800 border border-blue-500 dark:border-blue-400 rounded outline-none text-slate-900 dark:text-slate-100 font-medium vn-focusable"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="text-slate-700 dark:text-slate-200 truncate font-semibold">{node.name}</span>
        )}
      </div>
      {renderChildren && isExpanded && node.children.length > 0 && (
        <div className="vn-tree-children">
          {node.children.map((child, index) => (
            <TreeNodeComponent
              key={`${child.path}-${index}`}
              node={child}
              level={level + 1}
              onRefresh={onRefresh}
              expandedPaths={expandedPaths}
              onToggleFolder={onToggleFolder}
              selectedPaths={selectedPaths}
              onSelectFile={onSelectFile}
              onSelectFolder={onSelectFolder}
              onDeleteSelected={onDeleteSelected}
              selectedCount={selectedCount}
              clipboard={clipboard}
              onCopy={onCopy}
              onCut={onCut}
              onPaste={onPaste}
              lastSelectedFolderPath={lastSelectedFolderPath}
              pendingRenamePath={pendingRenamePath}
              onPendingRenamePathChange={onPendingRenamePathChange}
            />
          ))}
        </div>
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems()}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  )
}

interface FolderTreeProps {
  nodes: TreeNode[]
  onRefresh: () => void
  scrollContainerRef?: RefObject<HTMLDivElement | null>
}

interface FlatTreeRow {
  node: TreeNode
  level: number
}

const TREE_ROW_HEIGHT = 34
const TREE_VIRTUALIZE_THRESHOLD = 320
const TREE_VIRTUAL_OVERSCAN = 18

function findNodeByPath(treeNodes: TreeNode[], path: string): TreeNode | null {
  for (const node of treeNodes) {
    if (node.path === path) {
      return node
    }
    if (node.type === 'folder' && node.children) {
      const found = findNodeByPath(node.children, path)
      if (found) return found
    }
  }
  return null
}

function FolderTree({ nodes, onRefresh, scrollContainerRef }: FolderTreeProps) {
  const getInitialClipboard = (): { paths: string[]; operation: 'copy' | 'cut' } => {
    const storedClipboard = sessionStorage.getItem('clipboard_data')
    if (!storedClipboard) {
      return { paths: [], operation: 'copy' }
    }

    try {
      const parsed = JSON.parse(storedClipboard) as { paths?: string[]; operation?: 'copy' | 'cut' }
      return {
        paths: Array.isArray(parsed.paths) ? parsed.paths : [],
        operation: parsed.operation === 'cut' ? 'cut' : 'copy',
      }
    } catch (error) {
      console.error('Failed to parse clipboard data:', error)
      return { paths: [], operation: 'copy' }
    }
  }

  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [lastSelectedPath, setLastSelectedPath] = useState<string | null>(null)
  const [lastSelectedFolderPath, setLastSelectedFolderPath] = useState<string | null>(null)
  const [pendingRenamePath, setPendingRenamePath] = useState<string | null>(null)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('vn_tree_expanded_paths')
      if (!raw) return new Set()
      const parsed = JSON.parse(raw) as string[]
      return new Set(Array.isArray(parsed) ? parsed : [])
    } catch {
      return new Set()
    }
  })
  const [clipboard, setClipboard] = useState<{ paths: string[]; operation: 'copy' | 'cut' }>(getInitialClipboard)
  const [treeScrollTop, setTreeScrollTop] = useState(0)
  const [treeViewportHeight, setTreeViewportHeight] = useState(640)
  const { showToast } = useToast()
  const { currentFile, openFile } = useEditor()

  // Debug: log state changes
  useEffect(() => {
  }, [selectedPaths, lastSelectedFolderPath])

  const flattenFilePaths = useCallback((treeNodes: TreeNode[]): string[] => {
    const result: string[] = []

    const walk = (items: TreeNode[]) => {
      items.forEach((item) => {
        if (item.type === 'file') {
          result.push(item.path)
          return
        }
        if (item.type === 'folder') {
          walk(item.children)
        }
      })
    }

    walk(treeNodes)
    return result
  }, [])

  const fileOrder = useMemo(() => flattenFilePaths(nodes), [flattenFilePaths, nodes])

  const flattenVisibleRows = useCallback((treeNodes: TreeNode[], expanded: Set<string>): FlatTreeRow[] => {
    const rows: FlatTreeRow[] = []
    const walk = (items: TreeNode[], level: number) => {
      for (const item of items) {
        rows.push({ node: item, level })
        if (item.type === 'folder' && expanded.has(item.path) && item.children.length > 0) {
          walk(item.children, level + 1)
        }
      }
    }
    walk(treeNodes, 0)
    return rows
  }, [])

  const visibleRows = useMemo(
    () => flattenVisibleRows(nodes, expandedPaths),
    [expandedPaths, flattenVisibleRows, nodes],
  )

  const shouldVirtualize = visibleRows.length >= TREE_VIRTUALIZE_THRESHOLD && !pendingRenamePath

  useEffect(() => {
    if (!shouldVirtualize) {
      return
    }

    const container = scrollContainerRef?.current
    if (!container) {
      return
    }
    let frame = 0
    const updateMetrics = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = 0
        setTreeScrollTop(container.scrollTop)
        setTreeViewportHeight(container.clientHeight)
      })
    }

    updateMetrics()
    container.addEventListener('scroll', updateMetrics, { passive: true })
    window.addEventListener('resize', updateMetrics)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      container.removeEventListener('scroll', updateMetrics)
      window.removeEventListener('resize', updateMetrics)
    }
  }, [scrollContainerRef, shouldVirtualize])

  const virtualWindow = useMemo(() => {
    if (!shouldVirtualize) {
      return {
        rows: visibleRows,
        topSpacer: 0,
        bottomSpacer: 0,
      }
    }

    const total = visibleRows.length
    const first = Math.max(0, Math.floor(treeScrollTop / TREE_ROW_HEIGHT) - TREE_VIRTUAL_OVERSCAN)
    const visibleCount = Math.ceil(treeViewportHeight / TREE_ROW_HEIGHT) + TREE_VIRTUAL_OVERSCAN * 2
    const end = Math.min(total, first + visibleCount)
    const topSpacer = first * TREE_ROW_HEIGHT
    const bottomSpacer = Math.max(0, (total - end) * TREE_ROW_HEIGHT)

    return {
      rows: visibleRows.slice(first, end),
      topSpacer,
      bottomSpacer,
    }
  }, [shouldVirtualize, visibleRows, treeScrollTop, treeViewportHeight])

  useEffect(() => {
    localStorage.setItem('vn_tree_expanded_paths', JSON.stringify(Array.from(expandedPaths)))
  }, [expandedPaths])

  const toggleFolderExpansion = (path: string, forceExpand?: boolean) => {
    setExpandedPaths(prev => {
      const next = new Set(prev)
      const shouldExpand = forceExpand === true ? true : !next.has(path)
      if (shouldExpand) {
        next.add(path)
      } else {
        next.delete(path)
      }
      return next
    })
  }

  const findAncestorFolderPaths = useCallback((treeNodes: TreeNode[], targetPath: string): string[] => {
    const walk = (items: TreeNode[], trail: string[]): string[] | null => {
      for (const item of items) {
        if (item.type === 'file') {
          if (item.path === targetPath) {
            return trail
          }
          continue
        }

        const nextTrail = [...trail, item.path]
        const result = walk(item.children, nextTrail)
        if (result) return result
      }

      return null
    }

    return walk(treeNodes, []) ?? []
  }, [])

  const effectiveSelectedPaths = useMemo(() => {
    if (!currentFile || selectedPaths.size > 1 || lastSelectedFolderPath) {
      return selectedPaths
    }
    const targetNode = findNodeByPath(nodes, currentFile)
    if (!targetNode || targetNode.type !== 'file') {
      return selectedPaths
    }
    return new Set([currentFile])
  }, [currentFile, lastSelectedFolderPath, nodes, selectedPaths])

  useEffect(() => {
    if (!currentFile) return
    const targetNode = findNodeByPath(nodes, currentFile)
    if (!targetNode || targetNode.type !== 'file') return

    const ancestorFolders = findAncestorFolderPaths(nodes, currentFile)
    if (ancestorFolders.length === 0) return

    const frame = window.requestAnimationFrame(() => {
      setExpandedPaths((prev) => {
        let changed = false
        const next = new Set(prev)
        ancestorFolders.forEach((path) => {
          if (!next.has(path)) {
            next.add(path)
            changed = true
          }
        })
        return changed ? next : prev
      })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [currentFile, findAncestorFolderPaths, nodes])

  const handleSelectFile = (path: string, event: React.MouseEvent) => {
    if (event.shiftKey && lastSelectedPath) {
      const startIndex = fileOrder.indexOf(lastSelectedPath)
      const endIndex = fileOrder.indexOf(path)

      if (startIndex !== -1 && endIndex !== -1) {
        const [from, to] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex]
        const range = fileOrder.slice(from, to + 1)
        setSelectedPaths(new Set(range))
      } else {
        setSelectedPaths(new Set([path]))
      }
    } else {
      setSelectedPaths(new Set([path]))
    }

    setLastSelectedPath(path)
    // Clear folder selection when selecting a file
    setLastSelectedFolderPath(null)
  }

  const handleSelectFolder = (path: string) => {
    // Only set the folder as selected for paste operations
    setLastSelectedFolderPath(path)
    // Clear file selection when selecting a folder
    setSelectedPaths(new Set())
    setLastSelectedPath(null)
  }

  const handleDeleteSelected = async () => {
    if (selectedPaths.size === 0) {
      return
    }

    const confirmMsg = selectedPaths.size === 1
      ? 'Delete the selected file?'
      : `Delete ${selectedPaths.size} selected files?`

    try {
      const userConfirmed = await ask(confirmMsg, {
        title: 'Confirm Delete',
        kind: 'warning',
      })

      if (!userConfirmed) {
        return
      }

      for (const path of selectedPaths) {
        await vaultService.deletePath(path)
      }

      showToast(`Deleted ${selectedPaths.size} file${selectedPaths.size > 1 ? 's' : ''}`, 'success')
      setSelectedPaths(new Set())
      setLastSelectedPath(null)
      onRefresh()
    } catch (error) {
      console.error('❌ Failed to delete selected files:', error)
      showToast('Failed to delete selected files. Please try again.', 'error')
    }
  }

  const handleCopyPaths = async (paths: string[]) => {
    const clipboardData = { paths, operation: 'copy' as const }
    sessionStorage.setItem('clipboard_data', JSON.stringify(clipboardData))
    setClipboard(clipboardData)
  }

  const handleCutPaths = async (paths: string[]) => {
    const clipboardData = { paths, operation: 'cut' as const }
    sessionStorage.setItem('clipboard_data', JSON.stringify(clipboardData))
    setClipboard(clipboardData)
  }

  const handlePastePaths = async (targetPath: string) => {
    // Always check sessionStorage for latest clipboard data
    const storedClipboard = sessionStorage.getItem('clipboard_data')
    let currentClipboard = clipboard
    
    if (storedClipboard) {
      try {
        currentClipboard = JSON.parse(storedClipboard)
      } catch (e) {
        console.error('Failed to parse clipboard:', e)
      }
    }


    if (currentClipboard.paths.length === 0) {
      showToast('Clipboard is empty', 'error')
      return
    }

    try {
      // Get the target folder
      let targetFolder = ''
      const node = findNodeByPath(nodes, targetPath)
      if (node && node.type === 'folder') {
        targetFolder = node.path
      } else if (node) {
        targetFolder = node.path.split('/').slice(0, -1).join('/')
      }

      if (!targetFolder && targetPath.includes('/')) {
        targetFolder = targetPath.split('/').slice(0, -1).join('/')
      }

      if (!targetFolder) {
        showToast('Select a target folder first', 'error')
        return
      }

      for (const srcPath of currentClipboard.paths) {
        const fileName = srcPath.split('/').pop()
        if (!fileName) continue

        try {
          const destPath = `${targetFolder}/${fileName}`
          
          // Check if file already exists
          let fileExists = false
          try {
            await vaultService.readFile(destPath)
            fileExists = true
          } catch {
            // File doesn't exist, which is fine
            fileExists = false
          }

          // If file exists, ask for confirmation
          if (fileExists) {
            const confirmed = await ask(
              `A file named "${fileName}" already exists. Do you want to replace it?`,
              {
                title: 'Replace File?',
                kind: 'warning',
              }
            )
            
            if (!confirmed) {
              continue
            }
          }

          const content = await vaultService.readFile(srcPath)
          await vaultService.writeFile(destPath, content)

          if (currentClipboard.operation === 'cut') {
            await vaultService.deletePath(srcPath)
          }
        } catch (error) {
          console.error('Failed to paste:', error)
        }
      }

      // Clear clipboard after paste if it was a cut operation
      if (currentClipboard.operation === 'cut') {
        sessionStorage.removeItem('clipboard_data')
        setClipboard({ paths: [], operation: 'copy' })
      }
      
      onRefresh()
    } catch (error) {
      console.error('Paste error:', error)
    }
  }

  const createRootDefaultNamedItem = useCallback(async (kind: 'file' | 'folder') => {
    const baseName = 'Untitled'
    const maxAttempts = 500

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const candidate = attempt === 0 ? baseName : `${baseName} ${attempt}`

      try {
        if (kind === 'file') {
          const newPath = await vaultService.createFileInFolder('', candidate)
          setPendingRenamePath(newPath)
          onRefresh()
          await openFile(newPath)
          showToast('New file created', 'success')
          return
        }

        const newFolderPath = await vaultService.createFolder('', candidate)
        setPendingRenamePath(newFolderPath)
        setExpandedPaths((prev) => new Set(prev).add(newFolderPath))
        onRefresh()
        showToast('New folder created', 'success')
        return
      } catch {
        // Try next candidate on collision.
      }
    }

    showToast(`Failed to create ${kind}. Please try again.`, 'error')
  }, [onRefresh, openFile, showToast])

  const handleRefreshTree = useCallback(() => {
    onRefresh()
  }, [onRefresh])

  const handleCollapseAllFolders = useCallback(() => {
    setExpandedPaths(new Set())
    setLastSelectedFolderPath(null)
  }, [])

  useEffect(() => {
    const handleKeyboardShortcuts = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
      const isCtrlOrCmd = isMac ? e.metaKey : e.ctrlKey

      if (!isCtrlOrCmd) return

      // Don't intercept if user is typing in an input
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return
      }

      // Don't hijack normal copy/cut when user has text selected anywhere in the app.
      const selection = window.getSelection()?.toString().trim() || ''
      if (selection.length > 0 && (e.key === 'c' || e.key === 'C' || e.key === 'x' || e.key === 'X')) {
        return
      }

      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault()
        if (selectedPaths.size > 0) {
          const pathsArray = Array.from(selectedPaths)
          handleCopyPaths(pathsArray)
        }
      } else if (e.key === 'x' || e.key === 'X') {
        e.preventDefault()
        if (selectedPaths.size > 0) {
          const pathsArray = Array.from(selectedPaths)
          handleCutPaths(pathsArray)
        }
      } else if (e.key === 'v' || e.key === 'V') {
        e.preventDefault()

        // Reload clipboard from sessionStorage to ensure we have latest data
        const storedClipboard = sessionStorage.getItem('clipboard_data')
        let currentClipboard = clipboard

        if (storedClipboard) {
          try {
            currentClipboard = JSON.parse(storedClipboard)
          } catch (error) {
            console.error('Failed to parse clipboard:', error)
          }
        }

        if (currentClipboard.paths.length === 0) {
          showToast('Clipboard is empty', 'warning')
          return
        }

        // Determine target folder:
        // 1. If a folder is selected (lastSelectedFolderPath), use it
        // 2. If a file is selected, use its parent folder
        // 3. Otherwise, show error
        let targetPath = lastSelectedFolderPath

        if (!targetPath && selectedPaths.size > 0) {
          // Get the first selected path
          const firstSelectedPath = Array.from(selectedPaths)[0]
          const node = findNodeByPath(nodes, firstSelectedPath)

          if (node && node.type === 'file') {
            // Use parent folder of the file
            targetPath = firstSelectedPath.split('/').slice(0, -1).join('/')
          } else if (node && node.type === 'folder') {
            targetPath = firstSelectedPath
          }
        }

        if (targetPath) {
          handlePastePaths(targetPath)
        } else {
          showToast('Select a file or folder to paste into', 'warning')
        }
      }
    }

    document.addEventListener('keydown', handleKeyboardShortcuts)
    return () => document.removeEventListener('keydown', handleKeyboardShortcuts)
  }, [selectedPaths, clipboard, lastSelectedFolderPath, nodes, showToast]) // eslint-disable-line react-hooks/exhaustive-deps

  if (nodes.length === 0) {
    return (
      <div className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">
        No notes yet
      </div>
    )
  }

  return (
    <div className="py-2">
      <div className="px-3 pb-2 flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={() => void createRootDefaultNamedItem('file')}
          className="h-8 w-8 rounded-lg bg-slate-200/80 dark:bg-slate-800/80 text-slate-700 dark:text-slate-200 flex items-center justify-center hover:bg-slate-300 dark:hover:bg-slate-700 vn-focusable vn-interactive"
          title="New file"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m-7-7h14" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => void createRootDefaultNamedItem('folder')}
          className="h-8 w-8 rounded-lg bg-slate-200/80 dark:bg-slate-800/80 text-slate-700 dark:text-slate-200 flex items-center justify-center hover:bg-slate-300 dark:hover:bg-slate-700 vn-focusable vn-interactive"
          title="New folder"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h5l2 2h7a2 2 0 012 2v2H3V7z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 11h18v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-8z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 14v4m2-2h-4" />
          </svg>
        </button>
        <button
          type="button"
          onClick={handleRefreshTree}
          className="h-8 w-8 rounded-lg bg-slate-200/80 dark:bg-slate-800/80 text-slate-700 dark:text-slate-200 flex items-center justify-center hover:bg-slate-300 dark:hover:bg-slate-700 vn-focusable vn-interactive"
          title="Refresh explorer"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h5M20 20v-5h-5M5.64 18.36A9 9 0 103.51 9M18.36 5.64A9 9 0 0120.49 15" />
          </svg>
        </button>
        <button
          type="button"
          onClick={handleCollapseAllFolders}
          className="h-8 w-8 rounded-lg bg-slate-200/80 dark:bg-slate-800/80 text-slate-700 dark:text-slate-200 flex items-center justify-center hover:bg-slate-300 dark:hover:bg-slate-700 vn-focusable vn-interactive"
          title="Collapse all folders"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 6h12M6 12h12M6 18h8" />
          </svg>
        </button>
      </div>
      {shouldVirtualize ? (
        <>
          {virtualWindow.topSpacer > 0 && <div style={{ height: `${virtualWindow.topSpacer}px` }} />}
          {virtualWindow.rows.map(({ node, level }, index) => (
            <TreeNodeComponent
              key={`${node.path}-virtual-${index}`}
              node={node}
              level={level}
              onRefresh={onRefresh}
              expandedPaths={expandedPaths}
              onToggleFolder={toggleFolderExpansion}
              selectedPaths={effectiveSelectedPaths}
              onSelectFile={handleSelectFile}
              onSelectFolder={handleSelectFolder}
              onDeleteSelected={handleDeleteSelected}
              selectedCount={effectiveSelectedPaths.size}
              clipboard={clipboard}
              onCopy={handleCopyPaths}
              onCut={handleCutPaths}
              onPaste={handlePastePaths}
              lastSelectedFolderPath={lastSelectedFolderPath}
              pendingRenamePath={pendingRenamePath}
              onPendingRenamePathChange={setPendingRenamePath}
              renderChildren={false}
            />
          ))}
          {virtualWindow.bottomSpacer > 0 && <div style={{ height: `${virtualWindow.bottomSpacer}px` }} />}
        </>
      ) : (
        nodes.map((node, index) => (
          <TreeNodeComponent
            key={`${node.path}-${index}`}
            node={node}
            level={0}
            onRefresh={onRefresh}
            expandedPaths={expandedPaths}
            onToggleFolder={toggleFolderExpansion}
            selectedPaths={effectiveSelectedPaths}
            onSelectFile={handleSelectFile}
            onSelectFolder={handleSelectFolder}
            onDeleteSelected={handleDeleteSelected}
            selectedCount={effectiveSelectedPaths.size}
            clipboard={clipboard}
            onCopy={handleCopyPaths}
            onCut={handleCutPaths}
            onPaste={handlePastePaths}
            lastSelectedFolderPath={lastSelectedFolderPath}
            pendingRenamePath={pendingRenamePath}
            onPendingRenamePathChange={setPendingRenamePath}
          />
        ))
      )}
    </div>
  )
}

export default FolderTree
