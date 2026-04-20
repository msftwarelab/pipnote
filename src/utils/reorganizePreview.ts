import type { ReorganizationPlan } from '../services/reorganize'

export interface ReorgPreviewNode {
  type: 'file' | 'folder'
  name: string
  path: string
  children?: ReorgPreviewNode[]
  changeKind?: 'move' | 'rename' | 'move-rename' | 'merge-target'
  sourcePath?: string
}

export interface ReorgPreviewSummaryCluster {
  label: string
  count: number
}

function normalizePath(path: string): string {
  return path.replace(/^notes\//i, '').replace(/^\/+/, '').trim()
}

function parentPath(path: string): string {
  const normalized = normalizePath(path)
  const parts = normalized.split('/').filter(Boolean)
  return parts.slice(0, -1).join('/')
}

function baseName(path: string): string {
  const normalized = normalizePath(path)
  return normalized.split('/').filter(Boolean).pop() || normalized
}

function compareNodes(a: ReorgPreviewNode, b: ReorgPreviewNode): number {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

function buildTree(paths: Map<string, { changeKind?: ReorgPreviewNode['changeKind']; sourcePath?: string }>): ReorgPreviewNode[] {
  type DraftNode = ReorgPreviewNode & { children?: DraftNode[] }

  const root: DraftNode = {
    type: 'folder',
    name: '',
    path: '',
    children: [],
  }

  for (const [path, meta] of paths.entries()) {
    const normalized = normalizePath(path)
    const segments = normalized.split('/').filter(Boolean)
    if (segments.length === 0) continue

    let current = root
    let currentPath = ''
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      const isFile = index === segments.length - 1
      current.children = current.children || []
      let existing = current.children.find((child) => child.name === segment && child.type === (isFile ? 'file' : 'folder')) as DraftNode | undefined
      if (!existing) {
        existing = isFile
          ? {
              type: 'file',
              name: segment,
              path: currentPath,
            }
          : {
              type: 'folder',
              name: segment,
              path: currentPath,
              children: [],
            }
        current.children.push(existing)
      }

      if (isFile) {
        existing.changeKind = meta.changeKind
        existing.sourcePath = meta.sourcePath
      }

      current = existing
    }
  }

  const sortTree = (nodes: DraftNode[]) => {
    nodes.sort(compareNodes)
    nodes.forEach((node) => {
      if (node.type === 'folder' && node.children) {
        sortTree(node.children)
      }
    })
  }

  sortTree(root.children || [])
  return root.children || []
}

function getMoveChangeKind(sourcePath: string, targetPath: string): ReorgPreviewNode['changeKind'] {
  const sourceParent = parentPath(sourcePath).toLowerCase()
  const targetParent = parentPath(targetPath).toLowerCase()
  const sourceBase = baseName(sourcePath).toLowerCase()
  const targetBase = baseName(targetPath).toLowerCase()
  if (sourceParent === targetParent && sourceBase !== targetBase) return 'rename'
  if (sourceParent !== targetParent && sourceBase === targetBase) return 'move'
  if (sourceParent !== targetParent && sourceBase !== targetBase) return 'move-rename'
  return undefined
}

export function buildProjectedVaultTree(
  currentPaths: string[],
  operations: ReorganizationPlan['operations'],
  approvedIds: Set<number>,
): ReorgPreviewNode[] {
  const projected = new Map<string, { changeKind?: ReorgPreviewNode['changeKind']; sourcePath?: string }>()

  for (const path of currentPaths) {
    const normalized = normalizePath(path)
    if (!normalized) continue
    projected.set(normalized, {})
  }

  operations.forEach((operation, index) => {
    if (!approvedIds.has(index)) return
    const source = normalizePath(operation.sourcePath)
    const target = operation.targetPath ? normalizePath(operation.targetPath) : ''

    if (operation.type === 'delete') {
      if (source) {
        projected.delete(source)
      }
      return
    }

    if (operation.type === 'merge') {
      if (source) {
        projected.delete(source)
      }
      if (target && projected.has(target)) {
        projected.set(target, {
          changeKind: 'merge-target',
          sourcePath: source || undefined,
        })
      }
      return
    }

    if ((operation.type === 'move' || operation.type === 'structural') && source && target) {
      projected.delete(source)
      projected.set(target, {
        changeKind: getMoveChangeKind(source, target),
        sourcePath: source,
      })
    }
  })

  return buildTree(projected)
}

function clusterLabelForOperation(operation: ReorganizationPlan['operations'][number]): string | null {
  if (operation.type === 'move' && operation.targetPath) {
    return parentPath(operation.targetPath) || 'Vault Root'
  }
  if (operation.type === 'merge' && operation.targetPath) {
    return parentPath(operation.targetPath) || 'Vault Root'
  }
  if (operation.type === 'delete') {
    return operation.issueType === 'emptyFolder' ? 'Empty Folder Cleanup' : 'Delete Cleanup'
  }
  if (operation.type === 'structural' && operation.targetPath) {
    return parentPath(operation.targetPath) || 'Structural Fixes'
  }
  return operation.type === 'structural' ? 'Structural Fixes' : null
}

export function summarizeDestinationClusters(
  operations: ReorganizationPlan['operations'],
  approvedIds: Set<number>,
  limit = 6,
): ReorgPreviewSummaryCluster[] {
  const counts = new Map<string, number>()
  operations.forEach((operation, index) => {
    if (!approvedIds.has(index)) return
    const label = clusterLabelForOperation(operation)
    if (!label) return
    counts.set(label, (counts.get(label) || 0) + 1)
  })

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }))
}

export function groupOperationsForReview(
  operations: ReorganizationPlan['operations'],
): Array<{ id: string; label: string; operations: Array<{ op: ReorganizationPlan['operations'][number]; index: number }> }> {
  const groups = new Map<string, { label: string; operations: Array<{ op: ReorganizationPlan['operations'][number]; index: number }> }>()

  const getGroup = (operation: ReorganizationPlan['operations'][number]) => {
    const sourceParent = parentPath(operation.sourcePath)
    const targetParent = operation.targetPath ? parentPath(operation.targetPath) : ''
    const isRenameCleanup = operation.type === 'move' && !!operation.targetPath && sourceParent.toLowerCase() === targetParent.toLowerCase()

    if (isRenameCleanup) return { id: 'rename', label: 'Rename Cleanup' }
    if (operation.type === 'move') return { id: 'move', label: 'Move Suggestions' }
    if (operation.type === 'merge') return { id: 'merge', label: 'Merge Duplicates' }
    if (operation.type === 'delete' && operation.issueType === 'emptyFolder') return { id: 'empty-folder', label: 'Delete Empty Folders' }
    if (operation.type === 'delete') return { id: 'delete', label: 'Delete Suggestions' }
    return { id: 'structural', label: 'Structural Fixes' }
  }

  operations.forEach((op, index) => {
    const group = getGroup(op)
    if (!groups.has(group.id)) {
      groups.set(group.id, { label: group.label, operations: [] })
    }
    groups.get(group.id)?.operations.push({ op, index })
  })

  const order = ['rename', 'move', 'merge', 'empty-folder', 'delete', 'structural']
  return order
    .map((id) => {
      const group = groups.get(id)
      if (!group) return null
      return { id, label: group.label, operations: group.operations }
    })
    .filter((value): value is { id: string; label: string; operations: Array<{ op: ReorganizationPlan['operations'][number]; index: number }> } => Boolean(value))
}
