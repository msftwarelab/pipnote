import { isClutterLikeFilename } from './duplicateCleanup.ts'

export interface ClutterFolderCandidate {
  sourceFolder: string
  targetFolder: string
  filePaths: string[]
  reason: string
}

const CLUTTER_FOLDER_NAMES = new Set([
  'copies',
  'copy',
  'exports',
  'export',
  'imports',
  'import',
  'scans',
  'scan',
  'uploads',
  'upload',
  'tmp',
  'temp',
])

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').trim()
}

function folderName(path: string): string {
  const parts = normalizePath(path).split('/').filter(Boolean)
  return (parts[parts.length - 1] || '').toLowerCase()
}

function parentPath(path: string): string {
  const parts = normalizePath(path).split('/').filter(Boolean)
  return parts.slice(0, -1).join('/')
}

function baseName(path: string): string {
  const parts = normalizePath(path).split('/').filter(Boolean)
  return parts[parts.length - 1] || path
}

export function detectShallowClutterFolder(
  folderPath: string,
  childFilePaths: string[],
  childFolderPaths: string[],
): ClutterFolderCandidate | null {
  const normalizedFolder = normalizePath(folderPath)
  const targetFolder = parentPath(normalizedFolder)
  const folderParts = normalizedFolder.split('/').filter(Boolean)
  if (folderParts.length < 2) return null
  if (!targetFolder) return null
  if (!CLUTTER_FOLDER_NAMES.has(folderName(normalizedFolder))) return null
  if (childFolderPaths.length > 0) return null
  if (childFilePaths.length === 0 || childFilePaths.length > 8) return null

  const noisyFiles = childFilePaths.filter((filePath) => isClutterLikeFilename(baseName(filePath)))
  if (noisyFiles.length !== childFilePaths.length) return null

  return {
    sourceFolder: normalizedFolder,
    targetFolder,
    filePaths: childFilePaths.map(normalizePath),
    reason: `Flatten shallow clutter folder '${normalizedFolder}' into '${targetFolder}'`,
  }
}
