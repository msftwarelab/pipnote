import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { EmbeddingChunkData } from '../types/embedding'
import { recordPerfMetric, startPerfTimer } from '../utils/perfMetrics'
import { TtlCache } from '../utils/ttlCache'

export type TreeNode = FileNode | FolderNode

export interface FileNode {
  type: 'file'
  name: string
  path: string
  modifiedAt?: string
}

export interface FolderNode {
  type: 'folder'
  name: string
  path: string
  modifiedAt?: string
  children: TreeNode[]
}

export interface EmbeddingWithPath {
  path: string
  embedding: number[]
  model: string
  created_at: string
  content_hash?: string
  chunks?: EmbeddingChunkData[]
}

export interface KeywordSearchHit {
  path: string
  title: string
  snippet: string
  score: number
}

export interface SemanticSearchHit {
  path: string
  similarity: number
  snippet?: string
}

export interface SemanticCacheStats {
  queries: number
  hits: number
  misses: number
  rebuilds: number
  entries: number
  last_built_at: string | null
}

export type FilePreviewKind = 'image' | 'pdf' | 'docx' | 'pptx' | 'xlsx'

export interface FilePreviewData {
  kind: FilePreviewKind
  file_name: string
  mime_type?: string | null
  data_url?: string | null
  text?: string | null
  message?: string | null
  size_bytes: number
}

export type AIReadableFileKind = 'text' | 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'csv' | 'image'

export interface AIReadableFileData {
  kind: AIReadableFileKind
  content: string
  message?: string | null
}

interface GetVaultTreeOptions {
  forceRefresh?: boolean
}

interface ReadAllEmbeddingsOptions {
  forceRefresh?: boolean
}

export interface VaultService {
  initVault: (customPath?: string) => Promise<string>
  openFolder: () => Promise<string | null>
  getVaultTree: (options?: GetVaultTreeOptions) => Promise<TreeNode[]>
  readFile: (path: string) => Promise<string>
  readFileForAI: (path: string) => Promise<AIReadableFileData>
  readFilePreview: (path: string) => Promise<FilePreviewData>
  writeFile: (path: string, content: string) => Promise<string>
  deletePath: (path: string) => Promise<void>
  renamePath: (oldPath: string, newName: string) => Promise<string>
  createFileInFolder: (folderPath: string, fileName: string) => Promise<string>
  createFolder: (parentPath: string, folderName: string) => Promise<string>
  writeEmbedding: (notePath: string, embedding: object) => Promise<void>
  deleteEmbedding: (notePath: string) => Promise<boolean>
  readAllEmbeddings: (options?: ReadAllEmbeddingsOptions) => Promise<EmbeddingWithPath[]>
  searchSemanticEmbeddings: (queryEmbedding: number[], limit?: number) => Promise<SemanticSearchHit[]>
  getSemanticCacheStats: () => Promise<SemanticCacheStats>
  clearAllEmbeddings: () => Promise<void>
  searchNotes: (query: string, limit?: number) => Promise<KeywordSearchHit[]>
  prefetchFiles: (paths: string[]) => void
}

function normalizeVaultPath(path: string): string {
  return path.replace(/^\/+/, '')
}

const TREE_CACHE_TTL_MS = 2_500
const EMBEDDINGS_CACHE_TTL_MS = 15_000
const FILE_CONTENT_CACHE_TTL_MS = 8_000
const AI_READABLE_CACHE_TTL_MS = 12_000
const KEYWORD_SEARCH_CACHE_TTL_MS = 2_500
const treeCache = new TtlCache<TreeNode[]>(TREE_CACHE_TTL_MS)
const embeddingsCache = new TtlCache<EmbeddingWithPath[]>(EMBEDDINGS_CACHE_TTL_MS)
const fileContentCache = new TtlCache<Map<string, string>>(FILE_CONTENT_CACHE_TTL_MS)
const aiReadableFileCache = new TtlCache<Map<string, AIReadableFileData>>(AI_READABLE_CACHE_TTL_MS)
const keywordSearchCache = new TtlCache<Map<string, KeywordSearchHit[]>>(KEYWORD_SEARCH_CACHE_TTL_MS)
const prefetchingPaths = new Set<string>()

function invalidateTreeCache(): void {
  treeCache.invalidate()
}

function invalidateEmbeddingsCache(): void {
  embeddingsCache.invalidate()
}

function invalidateFileCaches(): void {
  fileContentCache.invalidate()
  aiReadableFileCache.invalidate()
  keywordSearchCache.invalidate()
}

function cloneMap<K, V>(source: Map<K, V>): Map<K, V> {
  return new Map(source)
}

export const vaultService: VaultService = {
  async initVault(customPath?: string): Promise<string> {
    try {
      // If customPath is not provided, try to load from localStorage
      const pathToInit = customPath || localStorage.getItem('vn_vault_path') || undefined

      const vaultPath = await invoke<string>('init_vault', { customPath: pathToInit })
      console.log('Vault initialized at:', vaultPath)

      // Save it back in case it's the default and we didn't have one
      if (!localStorage.getItem('vn_vault_path')) {
        localStorage.setItem('vn_vault_path', vaultPath)
      }
      invalidateTreeCache()
      invalidateEmbeddingsCache()
      invalidateFileCaches()
      return vaultPath
    } catch (error) {
      console.error('Failed to initialize vault:', error)
      throw error
    }
  },

  async openFolder(): Promise<string | null> {
    try {
      const selectedPath = await open({
        directory: true,
        multiple: false,
      })
      if (selectedPath && typeof selectedPath === 'string') {
        const newVaultPath = await invoke<string>('set_vault_path', { path: selectedPath })
        console.log('Opened new folder as vault:', newVaultPath)
        localStorage.setItem('vn_vault_path', selectedPath)
        invalidateTreeCache()
        invalidateEmbeddingsCache()
        invalidateFileCaches()
        return newVaultPath
      }
      return null
    } catch (error) {
      console.error('Failed to open folder:', error)
      throw error
    }
  },

  async getVaultTree(options?: GetVaultTreeOptions): Promise<TreeNode[]> {
    const startTime = startPerfTimer()
    try {
      const tree = await treeCache.getOrLoad(async () => {
        const loaded = await invoke<TreeNode[]>('read_vault_tree')
        return Array.isArray(loaded) ? loaded : []
      }, { forceRefresh: options?.forceRefresh })
      recordPerfMetric('vault_tree_load_ms', startTime, {
        forceRefresh: options?.forceRefresh === true,
        nodeCount: tree.length,
      })
      console.log('Vault tree loaded:', tree)
      return tree
    } catch (error) {
      console.error('Failed to load vault tree:', error)
      throw error
    }
  },

  async readFile(path: string): Promise<string> {
    const normalizedPath = normalizeVaultPath(path)
    try {
      const cachedMap = fileContentCache.getFresh()
      const cachedContent = cachedMap?.get(normalizedPath)
      if (typeof cachedContent === 'string') {
        return cachedContent
      }

      const content = await invoke<string>('read_file', { path: normalizedPath })
      const nextMap = cloneMap(cachedMap ?? new Map<string, string>())
      nextMap.set(normalizedPath, content)
      fileContentCache.set(nextMap)
      return content
    } catch (error) {
      console.error('Failed to read file:', error)
      throw error
    }
  },

  async readFileForAI(path: string): Promise<AIReadableFileData> {
    const normalizedPath = normalizeVaultPath(path)
    const startTime = startPerfTimer()
    try {
      const cachedMap = aiReadableFileCache.getFresh()
      const cachedData = cachedMap?.get(normalizedPath)
      if (cachedData) {
        recordPerfMetric('ai_readable_load_ms', startTime, {
          extension: normalizedPath.split('.').pop()?.toLowerCase() ?? '',
          cached: true,
        })
        return cachedData
      }

      const data = await invoke<AIReadableFileData>('read_file_for_ai', { path: normalizedPath })
      const nextMap = cloneMap(cachedMap ?? new Map<string, AIReadableFileData>())
      nextMap.set(normalizedPath, data)
      aiReadableFileCache.set(nextMap)
      recordPerfMetric('ai_readable_load_ms', startTime, {
        extension: normalizedPath.split('.').pop()?.toLowerCase() ?? '',
        cached: false,
      })
      return data
    } catch (error) {
      console.error('Failed to read AI file content:', error)
      throw error
    }
  },

  async readFilePreview(path: string): Promise<FilePreviewData> {
    try {
      const normalizedPath = normalizeVaultPath(path)
      return await invoke<FilePreviewData>('read_file_preview', { path: normalizedPath })
    } catch (error) {
      console.error('Failed to read file preview:', error)
      throw error
    }
  },

  async writeFile(path: string, content: string): Promise<string> {
    try {
      const normalizedPath = normalizeVaultPath(path)
      const actualPath = await invoke<string>('write_file', { path: normalizedPath, content })
      invalidateFileCaches()
      console.log('File saved:', actualPath)
      return actualPath
    } catch (error) {
      console.error('Failed to write file:', error)
      throw error
    }
  },

  async deletePath(path: string): Promise<void> {
    try {
      await invoke('delete_path', { path })
      invalidateTreeCache()
      invalidateEmbeddingsCache()
      invalidateFileCaches()
      console.log('Deleted:', path)
    } catch (error) {
      console.error('Failed to delete:', error)
      throw error
    }
  },

  async renamePath(oldPath: string, newName: string): Promise<string> {
    try {
      const newPath = await invoke<string>('rename_path', { oldPath, newName })
      invalidateTreeCache()
      invalidateEmbeddingsCache()
      invalidateFileCaches()
      console.log('Renamed:', oldPath, 'to', newPath)
      return newPath
    } catch (error) {
      console.error('Failed to rename:', error)
      throw error
    }
  },

  async createFileInFolder(folderPath: string, fileName: string): Promise<string> {
    try {
      const newPath = await invoke<string>('create_file_in_folder', { folderPath, fileName })
      invalidateTreeCache()
      invalidateFileCaches()
      console.log('Created file:', newPath)
      return newPath
    } catch (error) {
      console.error('Failed to create file:', error)
      throw error
    }
  },

  async createFolder(parentPath: string, folderName: string): Promise<string> {
    try {
      const newPath = await invoke<string>('create_folder', { parentPath, folderName })
      invalidateTreeCache()
      invalidateFileCaches()
      console.log('Created folder:', newPath)
      return newPath
    } catch (error) {
      console.error('Failed to create folder:', error)
      throw error
    }
  },

  async writeEmbedding(notePath: string, embedding: object): Promise<void> {
    try {
      const normalizedPath = normalizeVaultPath(notePath)
      await invoke('write_embedding', { notePath: normalizedPath, embeddingData: JSON.stringify(embedding) })
      invalidateEmbeddingsCache()
      console.log('Embedding saved for:', normalizedPath)
    } catch (error) {
      console.error('Failed to write embedding:', error)
      throw error
    }
  },

  async deleteEmbedding(notePath: string): Promise<boolean> {
    try {
      const normalizedPath = normalizeVaultPath(notePath)
      const deleted = await invoke<boolean>('delete_embedding', { notePath: normalizedPath })
      invalidateEmbeddingsCache()
      return deleted === true
    } catch (error) {
      console.error('Failed to delete embedding:', error)
      throw error
    }
  },

  async readAllEmbeddings(options?: ReadAllEmbeddingsOptions): Promise<EmbeddingWithPath[]> {
    try {
      const embeddings = await embeddingsCache.getOrLoad(async () => {
        const embeddingsJson = await invoke<string>('read_all_embeddings')
        const parsed = JSON.parse(embeddingsJson)
        const list = Array.isArray(parsed) ? (parsed as EmbeddingWithPath[]) : []
        return list
      }, { forceRefresh: options?.forceRefresh })
      console.log(`Loaded ${embeddings.length} embeddings${options?.forceRefresh ? ' (forced refresh)' : ''}`)
      return embeddings
    } catch (error) {
      console.error('Failed to read embeddings:', error)
      throw error
    }
  },

  async clearAllEmbeddings(): Promise<void> {
    try {
      await invoke('clear_all_embeddings')
      invalidateEmbeddingsCache()
      invalidateFileCaches()
      console.log('✅ All embeddings cleared')
    } catch (error) {
      console.error('Failed to clear embeddings:', error)
      throw error
    }
  },

  async searchSemanticEmbeddings(queryEmbedding: number[], limit: number = 12): Promise<SemanticSearchHit[]> {
    try {
      const normalizedLimit = Math.max(1, Math.min(200, Math.floor(limit)))
      const results = await invoke<SemanticSearchHit[]>('search_semantic_embeddings', {
        queryEmbedding,
        limit: normalizedLimit,
      })
      if (!Array.isArray(results)) return []
      return results
        .filter((item) => item && typeof item.path === 'string' && typeof item.similarity === 'number')
        .map((item) => ({
          path: normalizeVaultPath(item.path),
          similarity: item.similarity,
          snippet: typeof item.snippet === 'string' ? item.snippet : undefined,
        }))
    } catch (error) {
      console.error('Failed semantic embedding search:', error)
      throw error
    }
  },

  async getSemanticCacheStats(): Promise<SemanticCacheStats> {
    try {
      const stats = await invoke<SemanticCacheStats>('get_semantic_cache_stats')
      return {
        queries: Number(stats?.queries) || 0,
        hits: Number(stats?.hits) || 0,
        misses: Number(stats?.misses) || 0,
        rebuilds: Number(stats?.rebuilds) || 0,
        entries: Number(stats?.entries) || 0,
        last_built_at: typeof stats?.last_built_at === 'string' ? stats.last_built_at : null,
      }
    } catch (error) {
      console.error('Failed to read semantic cache stats:', error)
      throw error
    }
  },

  async searchNotes(query: string, limit: number = 40): Promise<KeywordSearchHit[]> {
    const normalizedQuery = query.trim()
    const normalizedLimit = Math.max(1, Math.min(200, Math.floor(limit)))
    const cacheKey = `${normalizedQuery}::${normalizedLimit}`
    const startTime = startPerfTimer()
    try {
      const cachedMap = keywordSearchCache.getFresh()
      const cachedResults = cachedMap?.get(cacheKey)
      if (cachedResults) {
        recordPerfMetric('keyword_search_ms', startTime, {
          cached: true,
          limit: normalizedLimit,
          queryLength: normalizedQuery.length,
          hits: cachedResults.length,
        })
        return cachedResults
      }

      const results = await invoke<KeywordSearchHit[]>('search_notes', { query: normalizedQuery, limit: normalizedLimit })
      const normalizedResults = Array.isArray(results) ? results : []
      const nextMap = cloneMap(cachedMap ?? new Map<string, KeywordSearchHit[]>())
      nextMap.set(cacheKey, normalizedResults)
      keywordSearchCache.set(nextMap)
      recordPerfMetric('keyword_search_ms', startTime, {
        cached: false,
        limit: normalizedLimit,
        queryLength: normalizedQuery.length,
        hits: normalizedResults.length,
      })
      return normalizedResults
    } catch (error) {
      console.error('Failed to search notes:', error)
      throw error
    }
  },

  prefetchFiles(paths: string[]): void {
    const uniquePaths = Array.from(new Set(paths.map((path) => normalizeVaultPath(path)).filter(Boolean)))
    if (uniquePaths.length === 0 || typeof window === 'undefined') return

    const runPrefetch = async () => {
      for (const path of uniquePaths) {
        if (prefetchingPaths.has(path)) continue
        if (fileContentCache.getFresh()?.has(path)) continue
        if (/\.(png|jpg|jpeg|gif|webp|bmp|svg|pdf|docx|pptx|xlsx)$/i.test(path)) continue

        prefetchingPaths.add(path)
        try {
          const content = await invoke<string>('read_file', { path })
          const current = fileContentCache.getFresh() ?? new Map<string, string>()
          const nextMap = cloneMap(current)
          nextMap.set(path, content)
          fileContentCache.set(nextMap)
        } catch {
          // Ignore prefetch failures; normal open path will surface real errors.
        } finally {
          prefetchingPaths.delete(path)
        }
      }
    }

    const idleId = window.requestIdleCallback?.(() => {
      void runPrefetch()
    }, { timeout: 1200 })

    if (typeof idleId === 'number') return

    window.setTimeout(() => {
      void runPrefetch()
    }, 120)
  },
}
