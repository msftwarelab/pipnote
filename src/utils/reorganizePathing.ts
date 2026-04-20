const UNCATEGORIZED_FOLDERS = new Set(['untitled', 'notes', 'misc', 'general', 'tmp', 'temp'])

export function normalizeReorgPathSegment(segment: string): string {
  return segment.replace(/[/\\:*?"<>|]/g, '-').trim()
}

function getExtension(path: string): string {
  const fileName = path.split('/').pop() || path
  const idx = fileName.lastIndexOf('.')
  if (idx <= 0) return ''
  return fileName.slice(idx)
}

function removeExtension(name: string): string {
  const idx = name.lastIndexOf('.')
  if (idx <= 0) return name
  return name.slice(0, idx)
}

function stripRepeatedExtension(name: string, extension: string): string {
  if (!extension) return name
  let value = name
  const lowerExt = extension.toLowerCase()
  while (value.toLowerCase().endsWith(lowerExt)) {
    value = value.slice(0, value.length - extension.length)
  }
  return value
}

function inferCategoryFromFilename(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (lower.includes('interview') || lower.includes('resume') || lower.includes('job') || lower.includes('career')) {
    return 'Career/Interview Prep'
  }
  if (lower.includes('research') || lower.includes('analysis') || lower.includes('report') || lower.includes('competitive')) {
    return 'Work/Research'
  }
  if (lower.includes('prompt')) {
    return 'Resources/AI Prompts'
  }
  if (lower.includes('meeting') || lower.includes('script')) {
    return 'Work/Meetings'
  }
  if (lower.includes('health') || lower.includes('routine') || lower.includes('skincare')) {
    return 'Personal/Health'
  }
  if (lower.includes('tip') || lower.includes('question') || lower.includes('command')) {
    return 'Learning/Notes'
  }
  return 'Unsorted'
}

export function looksUncategorized(path: string): boolean {
  const normalized = path.replace(/^notes\//i, '')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 1) return true
  return UNCATEGORIZED_FOLDERS.has(parts[0].toLowerCase())
}

export function inferSuggestedRelativePathFromSource(sourcePath: string): string {
  const normalized = sourcePath.replace(/^notes\//i, '')
  const fileName = normalized.split('/').pop() || 'Note.md'
  const category = inferCategoryFromFilename(fileName)
  return `${category}/${fileName}`
}

export function normalizeSuggestedRelativePath(suggestedPath: string, sourcePath: string): string {
  const sourceRelative = sourcePath.replace(/^notes\//i, '')
  const sourceParts = sourceRelative.split('/').filter(Boolean)
  const sourceFile = sourceParts[sourceParts.length - 1] || sourceRelative
  const sourceBase = removeExtension(sourceFile) || 'Note'
  const sourceExt = getExtension(sourceFile)

  const cleaned = (suggestedPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^(notes\/)+/i, '')

  const segments = cleaned.split('/').map(s => s.trim()).filter(Boolean)
  let targetSegments: string[]
  if (segments.length === 0) {
    targetSegments = ['Unsorted', sourceBase]
  } else if (segments.length === 1) {
    targetSegments = ['Unsorted', segments[0]]
  } else {
    targetSegments = segments
  }

  const last = targetSegments[targetSegments.length - 1]
  if (sourceExt && !last.toLowerCase().endsWith(sourceExt.toLowerCase())) {
    targetSegments[targetSegments.length - 1] = `${removeExtension(last)}${sourceExt}`
  }
  if (sourceExt && last.toLowerCase().endsWith(sourceExt.toLowerCase())) {
    const baseWithoutRepeatedExt = stripRepeatedExtension(last, sourceExt)
    targetSegments[targetSegments.length - 1] = `${removeExtension(baseWithoutRepeatedExt)}${sourceExt}`
  }
  if (!sourceExt) {
    targetSegments[targetSegments.length - 1] = removeExtension(last)
  }

  return targetSegments.join('/')
}

export function determineMoveSuggestionLevel(
  currentRelative: string,
  targetRelative: string,
): 'strong' | 'recommended' | 'optional' {
  if (looksUncategorized(currentRelative)) {
    return 'strong'
  }

  const currentParts = currentRelative.split('/').filter(Boolean)
  const targetParts = targetRelative.split('/').filter(Boolean)
  const currentTop = currentParts[0]?.toLowerCase() || ''
  const targetTop = targetParts[0]?.toLowerCase() || ''
  const currentFile = currentParts[currentParts.length - 1]?.toLowerCase() || ''
  const targetFile = targetParts[targetParts.length - 1]?.toLowerCase() || ''
  const sameTopLevel = currentTop === targetTop
  const sameDepth = currentParts.length === targetParts.length
  const currentParent = currentParts.slice(0, -1).join('/').toLowerCase()
  const targetParent = targetParts.slice(0, -1).join('/').toLowerCase()

  if (currentFile === targetFile && currentParent === targetParent) {
    return 'optional'
  }

  if (sameTopLevel && currentParts.length >= 3 && targetParts.length >= 3) {
    return 'optional'
  }

  if (sameTopLevel && sameDepth) {
    return 'optional'
  }

  if (!sameTopLevel) {
    return 'recommended'
  }

  return 'recommended'
}
