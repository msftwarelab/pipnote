export interface NoteScopeOptions {
  includeTrash?: boolean
  includeSystem?: boolean
}

const TEXT_NOTE_EXTENSIONS = new Set([
  'md',
  'markdown',
  'mdx',
  'txt',
  'text',
  'rst',
  'org',
  'adoc',
  'asciidoc',
])

const AI_DOCUMENT_EXTENSIONS = new Set([
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'csv',
])

const VISUAL_MEDIA_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'heic',
  'svg',
])

const KNOWN_BINARY_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'ods', 'odp',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'heic', 'svg',
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'mp4', 'mov', 'mkv', 'avi',
  'zip', 'rar', '7z', 'gz', 'tar',
])

const INTERNAL_FILE_NAMES = new Set(['index.json', 'embeddings.json', '.index.json', '.embeddings.json'])

export function normalizeNotePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '')
}

export function getNoteFileName(path: string): string {
  const normalized = normalizeNotePath(path)
  return normalized.split('/').pop() || normalized
}

export function getLowerExtension(path: string): string {
  const fileName = getNoteFileName(path).toLowerCase()
  if (!fileName.includes('.')) return ''
  return fileName.split('.').pop() || ''
}

export function isKnownBinaryExtension(extension: string): boolean {
  return KNOWN_BINARY_EXTENSIONS.has(extension.toLowerCase())
}

export function isIndexableNotePath(path: string, options?: NoteScopeOptions): boolean {
  const normalized = normalizeNotePath(path).trim().toLowerCase()
  if (!normalized) return false

  const scoped = normalized.replace(/^notes\//, '')
  if (!scoped) return false

  const includeTrash = options?.includeTrash ?? false
  const includeSystem = options?.includeSystem ?? false
  if (!includeTrash && scoped.startsWith('trash/')) return false
  if (!includeSystem && scoped.startsWith('.vn-system/')) return false
  const segments = scoped.split('/').filter(Boolean)
  if (segments.some((segment, index) => segment.startsWith('.') && !(includeSystem && index === 0 && segment === '.vn-system'))) {
    return false
  }

  const fileName = getNoteFileName(scoped)
  if (!fileName || INTERNAL_FILE_NAMES.has(fileName)) return false

  const extension = getLowerExtension(fileName)
  if (extension && isKnownBinaryExtension(extension)) return false
  if (!extension) return true

  return TEXT_NOTE_EXTENSIONS.has(extension)
}

export function isAiReadableNotePath(path: string, options?: NoteScopeOptions): boolean {
  const normalized = normalizeNotePath(path).trim().toLowerCase()
  if (!normalized) return false

  const scoped = normalized.replace(/^notes\//, '')
  if (!scoped) return false

  const includeTrash = options?.includeTrash ?? false
  const includeSystem = options?.includeSystem ?? false
  if (!includeTrash && scoped.startsWith('trash/')) return false
  if (!includeSystem && scoped.startsWith('.vn-system/')) return false
  const segments = scoped.split('/').filter(Boolean)
  if (segments.some((segment, index) => segment.startsWith('.') && !(includeSystem && index === 0 && segment === '.vn-system'))) {
    return false
  }

  const fileName = getNoteFileName(scoped)
  if (!fileName || INTERNAL_FILE_NAMES.has(fileName)) return false

  const extension = getLowerExtension(fileName)
  if (!extension) return true
  if (TEXT_NOTE_EXTENSIONS.has(extension)) return true
  return AI_DOCUMENT_EXTENSIONS.has(extension)
}

export function isPotentiallyAIReadablePath(path: string, options?: NoteScopeOptions): boolean {
  return isAiReadableNotePath(path, options) || isVisualMediaPath(path, options)
}

export function isVisualMediaPath(path: string, options?: NoteScopeOptions): boolean {
  const normalized = normalizeNotePath(path).trim().toLowerCase()
  if (!normalized) return false

  const scoped = normalized.replace(/^notes\//, '')
  if (!scoped) return false

  const includeTrash = options?.includeTrash ?? false
  const includeSystem = options?.includeSystem ?? false
  if (!includeTrash && scoped.startsWith('trash/')) return false
  if (!includeSystem && scoped.startsWith('.vn-system/')) return false
  const segments = scoped.split('/').filter(Boolean)
  if (segments.some((segment, index) => segment.startsWith('.') && !(includeSystem && index === 0 && segment === '.vn-system'))) {
    return false
  }

  const fileName = getNoteFileName(scoped)
  if (!fileName || INTERNAL_FILE_NAMES.has(fileName)) return false
  const extension = getLowerExtension(fileName)
  return VISUAL_MEDIA_EXTENSIONS.has(extension)
}

export function isReorganizationEligiblePath(path: string, options?: NoteScopeOptions): boolean {
  return isPotentiallyAIReadablePath(path, options)
}
