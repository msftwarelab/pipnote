export interface ReorgChangeSummary {
  currentFolder: string
  targetFolder: string
  currentTitle: string
  targetTitle: string
  folderChanged: boolean
  titleChanged: boolean
}

function splitPath(path: string): string[] {
  return path.replace(/^notes\//i, '').split('/').filter(Boolean)
}

export function summarizeReorgChange(sourcePath: string, targetPath?: string): ReorgChangeSummary | null {
  if (!targetPath) return null

  const sourceParts = splitPath(sourcePath)
  const targetParts = splitPath(targetPath)
  if (sourceParts.length === 0 || targetParts.length === 0) return null

  const currentTitle = sourceParts[sourceParts.length - 1] || ''
  const targetTitle = targetParts[targetParts.length - 1] || ''
  const currentFolder = sourceParts.slice(0, -1).join('/') || 'Vault root'
  const targetFolder = targetParts.slice(0, -1).join('/') || 'Vault root'

  return {
    currentFolder,
    targetFolder,
    currentTitle,
    targetTitle,
    folderChanged: currentFolder.toLowerCase() !== targetFolder.toLowerCase(),
    titleChanged: currentTitle.toLowerCase() !== targetTitle.toLowerCase(),
  }
}
