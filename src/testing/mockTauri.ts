import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'

interface MockTreeFileNode {
  type: 'file'
  name: string
  path: string
}

interface MockTreeFolderNode {
  type: 'folder'
  name: string
  path: string
  children: MockTreeNode[]
}

type MockTreeNode = MockTreeFileNode | MockTreeFolderNode

interface MockEmbeddingRecord {
  path: string
  embedding: number[]
  model: string
  created_at: string
  content_hash?: string
  chunks?: Array<{
    index: number
    start: number
    end: number
    excerpt: string
    embedding: number[]
    content_hash?: string
  }>
}

interface MockSearchHit {
  path: string
  title: string
  snippet: string
  score: number
}

interface MockSemanticCacheStats {
  queries: number
  hits: number
  misses: number
  rebuilds: number
  entries: number
  last_built_at: string | null
}

interface MockState {
  vaultPath: string
  files: Map<string, string>
  embeddings: Map<string, MockEmbeddingRecord>
  semanticCacheStats: MockSemanticCacheStats
}

const DEFAULT_VAULT_PATH = '/mock/vault'
const OLLAMA_SETTINGS_KEY = 'vn_ollama_settings'
const VAULT_PATH_KEY = 'vn_vault_path'
const ONBOARDING_DISMISSED_KEY = 'vn_onboarding_completed_v1'
const E2E_INSTALL_FLAG = '__vn_e2e_mocks_installed__'

const SEED_FILES: Record<string, string> = {
  'Projects/AI Knowledge Base/Execution Plan.md': [
    '# Execution Plan',
    '',
    '## MVP Goals',
    '- Build a local-first AI knowledge base',
    '- Auto-link related notes and facts',
    '- Keep answers grounded in vault context',
    '',
    '## Next Steps',
    '1. Validate retrieval quality',
    '2. Improve UI discoverability',
    '3. Add robust regression coverage',
  ].join('\n'),
  'Resources/Prompt Engineering/Prompt Generation Template.md': [
    '# Prompt Generation Template',
    '',
    'Use this prompt template to produce structured outputs:',
    '- Goal',
    '- Context',
    '- Constraints',
    '- Output format',
  ].join('\n'),
  'Interviews/Prep Call.md': [
    '# Prep Call',
    '',
    'Hello. Hi, Dio. Hi, Anna.',
    'Can you hear me now? Yeah, I can hear you.',
    'We have a 30 minute window for the interview prep call.',
  ].join('\n'),
  'Quick Notes/Welcome.md': [
    '# Welcome',
    '',
    'Welcome to Pipnote local-first knowledge base.',
  ].join('\n'),
}

function normalizePath(rawPath: string): string {
  let normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalized.startsWith('notes/')) {
    normalized = normalized.slice('notes/'.length)
  }
  return normalized
}

function withMdExtension(fileName: string): string {
  return fileName.toLowerCase().endsWith('.md') ? fileName : `${fileName}.md`
}

function withExistingExtension(path: string, newName: string): string {
  const existing = path.split('/').pop() || path
  const extension = existing.includes('.') ? existing.split('.').pop() || '' : ''
  if (!extension) return newName
  if (newName.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) return newName
  return `${newName}.${extension}`
}

function pathStem(path: string): string {
  const name = path.split('/').pop() || path
  return name.replace(/\.md$/i, '')
}

function inferCategory(content: string): { category: string; subcategory?: string } {
  const text = content.toLowerCase()
  if (/(interview|resume|job|career|hiring|cv)\b/.test(text)) return { category: 'Career', subcategory: 'Job Search' }
  if (/(api|backend|service|endpoint|schema|openapi|jwt|oauth|rbac|database|ci\/cd|monitoring)\b/.test(text)) {
    return { category: 'Work', subcategory: 'Engineering' }
  }
  if (/(meeting|agenda|minutes|standup|sync)\b/.test(text)) return { category: 'Work', subcategory: 'Meetings' }
  if (/(prompt|llm|ai|model|embedding|rag)\b/.test(text)) return { category: 'Learning', subcategory: 'AI' }
  if (/(health|routine|workout|diet|sleep|skincare)\b/.test(text)) return { category: 'Personal', subcategory: 'Health' }
  if (/(finance|budget|expense|invoice|revenue)\b/.test(text)) return { category: 'Finance' }
  if (/(project|roadmap|milestone|plan)\b/.test(text)) return { category: 'Projects', subcategory: 'Planning' }
  return { category: 'Learning', subcategory: 'Notes' }
}

function synthesizeTitle(content: string): string {
  const words = (content.match(/[A-Za-z0-9]{4,}/g) || [])
    .slice(0, 6)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
  if (words.length === 0) return 'Quick Note'
  return words.slice(0, 4).join(' ').slice(0, 60)
}

function makeEmbedding(text: string, dimension = 64): number[] {
  const vector = new Array<number>(dimension).fill(0)
  const normalizedText = text.trim().toLowerCase()
  if (!normalizedText) return vector

  for (let i = 0; i < normalizedText.length; i += 1) {
    const code = normalizedText.charCodeAt(i)
    const slot = i % dimension
    vector[slot] += ((code % 97) + 1) / 97
  }

  const magnitude = Math.sqrt(vector.reduce((acc, value) => acc + value * value, 0)) || 1
  return vector.map((value) => value / magnitude)
}

function makeSnippet(content: string, query: string, tokens: string[]): string {
  const singleLine = content.replace(/\n/g, ' ')
  const lower = singleLine.toLowerCase()
  let start = lower.indexOf(query)
  if (start === -1) {
    for (const token of tokens) {
      start = lower.indexOf(token)
      if (start !== -1) break
    }
  }

  if (start === -1) {
    return singleLine.slice(0, 180).trim()
  }

  const begin = Math.max(0, start - 70)
  const end = Math.min(singleLine.length, start + 140)
  return singleLine.slice(begin, end).trim()
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return -1
  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  if (magA <= 0 || magB <= 0) return 0
  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

function createInitialState(): MockState {
  return {
    vaultPath: DEFAULT_VAULT_PATH,
    files: new Map<string, string>(Object.entries(SEED_FILES)),
    embeddings: new Map<string, MockEmbeddingRecord>(),
    semanticCacheStats: {
      queries: 0,
      hits: 0,
      misses: 0,
      rebuilds: 0,
      entries: 0,
      last_built_at: null,
    },
  }
}

function buildTree(files: Map<string, string>): MockTreeNode[] {
  type FolderAcc = { folders: Map<string, FolderAcc>; files: Set<string> }
  const root: FolderAcc = { folders: new Map(), files: new Set() }

  for (const fullPath of files.keys()) {
    const normalized = normalizePath(fullPath)
    if (!normalized || normalized.startsWith('.')) continue
    const segments = normalized.split('/').filter(Boolean)
    if (segments.length === 0) continue

    let cursor = root
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i]
      if (!cursor.folders.has(segment)) {
        cursor.folders.set(segment, { folders: new Map(), files: new Set() })
      }
      const next = cursor.folders.get(segment)
      if (!next) break
      cursor = next
    }

    cursor.files.add(segments[segments.length - 1])
  }

  const toNodes = (folder: FolderAcc, parentPath = ''): MockTreeNode[] => {
    const folderNodes: MockTreeFolderNode[] = Array.from(folder.folders.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => {
        const path = parentPath ? `${parentPath}/${name}` : name
        return {
          type: 'folder',
          name,
          path,
          children: toNodes(value, path),
        }
      })

    const fileNodes: MockTreeFileNode[] = Array.from(folder.files)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const path = parentPath ? `${parentPath}/${name}` : name
        return {
          type: 'file',
          name,
          path,
        }
      })

    return [...folderNodes, ...fileNodes]
  }

  return toNodes(root)
}

function parsePromptContent(prompt: string): string {
  const noteContent = prompt.match(/Note Content:\s*([\s\S]*?)\n\n(?:CRITICAL|RESPONSE FORMAT|Analyze the content)/i)
  if (noteContent?.[1]) return noteContent[1].trim()

  const simpleContent = prompt.match(/Note:\s*([\s\S]*)$/i)
  if (simpleContent?.[1]) return simpleContent[1].trim()

  return ''
}

function parseCurrentPathFromPrompt(prompt: string): string {
  const match = prompt.match(/Current Path:\s*(.+)$/im) || prompt.match(/Path:\s*(.+)$/im)
  return normalizePath(match?.[1]?.trim() || 'Unsorted/Note.md')
}

function ollamaGenerateResponse(prompt: string): string {
  if (/analyze this note for reorganization/i.test(prompt) || /return only valid json/i.test(prompt)) {
    const currentPath = parseCurrentPathFromPrompt(prompt)
    const noExtPath = currentPath.replace(/\.md$/i, '')
    const suggestedTitle = pathStem(currentPath) || 'Note'
    return JSON.stringify({
      shouldKeep: true,
      suggestedPath: noExtPath,
      suggestedTitle,
      isDuplicate: false,
      duplicateOf: '',
      reason: 'Already in a clear location.',
    })
  }

  if (/expert note classification ai/i.test(prompt) || /classify this note/i.test(prompt)) {
    const noteContent = parsePromptContent(prompt)
    const inferred = inferCategory(noteContent)
    return JSON.stringify({
      title: synthesizeTitle(noteContent),
      category: inferred.category,
      subcategory: inferred.subcategory,
    })
  }

  const questionMatch = prompt.match(/QUESTION:\s*([\s\S]*?)\n\n/i)
  const question = questionMatch?.[1]?.trim() || ''
  if (/you are a helpful assistant\./i.test(prompt)) {
    if (/^hi\b|\bhello\b/i.test(question)) {
      return 'Hi! I am here and ready to help with your notes.'
    }
    return `Here is a direct answer: ${question || 'How can I help?'}`
  }

  if (/you are a helpful assistant that answers questions based on the provided note content/i.test(prompt)) {
    if (/execution plan/i.test(question.toLowerCase())) {
      return 'Your execution plan focuses on MVP goals, retrieval quality, UX improvements, and regression coverage.'
    }
    if (/^hi\b|\bhello\b/i.test(question.toLowerCase())) {
      return 'Hi! Great to see you. What would you like to know from your notes?'
    }
    return `Based on your notes: ${question || 'I found relevant context.'}`
  }

  return 'Acknowledged.'
}

function installOllamaFetchMock(): void {
  if (typeof window === 'undefined') return
  const globalWithFetch = window as Window & { __vnOriginalFetch?: typeof fetch; __vnMockFetchInstalled?: boolean }
  if (globalWithFetch.__vnMockFetchInstalled) return

  globalWithFetch.__vnOriginalFetch = window.fetch.bind(window)

  const jsonResponse = (payload: unknown, status = 200) => {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const settingsRaw = window.localStorage.getItem(OLLAMA_SETTINGS_KEY)
    const configuredBaseUrl = (() => {
      try {
        const parsed = settingsRaw ? (JSON.parse(settingsRaw) as { baseUrl?: string }) : {}
        return (parsed.baseUrl || 'http://localhost:11434').replace(/\/+$/, '')
      } catch {
        return 'http://localhost:11434'
      }
    })()

    const isOllamaRequest = url.startsWith(`${configuredBaseUrl}/api/`) || url.startsWith('http://localhost:11434/api/')

    if (!isOllamaRequest) {
      return globalWithFetch.__vnOriginalFetch!(input, init)
    }

    if (url.endsWith('/api/tags')) {
      return jsonResponse({
        models: [
          { name: 'gpt-oss:120b-cloud', size: 123456789, modified_at: new Date().toISOString() },
          { name: 'nomic-embed-text', size: 2345678, modified_at: new Date().toISOString() },
        ],
      })
    }

    if (url.endsWith('/api/show')) {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { model?: string } : {}
      const model = (body.model || '').toLowerCase()
      if (model.includes('embed')) {
        return jsonResponse({ capabilities: ['embedding'] })
      }
      return jsonResponse({ capabilities: ['completion'] })
    }

    if (url.endsWith('/api/embeddings')) {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { prompt?: string; model?: string } : {}
      return jsonResponse({
        embedding: makeEmbedding(body.prompt || ''),
        model: body.model || 'nomic-embed-text',
      })
    }

    if (url.endsWith('/api/generate')) {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { prompt?: string } : {}
      return jsonResponse({ response: ollamaGenerateResponse(body.prompt || ''), done: true })
    }

    return jsonResponse({ error: 'Unknown mocked Ollama endpoint' }, 404)
  }

  globalWithFetch.__vnMockFetchInstalled = true
}

export async function installE2EMocks(): Promise<void> {
  if (typeof window === 'undefined') return

  const globalWithFlag = window as Window & { [E2E_INSTALL_FLAG]?: boolean }
  if (globalWithFlag[E2E_INSTALL_FLAG]) return
  globalWithFlag[E2E_INSTALL_FLAG] = true

  window.localStorage.setItem(
    OLLAMA_SETTINGS_KEY,
    JSON.stringify({
      baseUrl: 'http://localhost:11434',
      textModel: 'gpt-oss:120b-cloud',
      embeddingModel: 'nomic-embed-text',
    }),
  )
  window.localStorage.setItem(VAULT_PATH_KEY, DEFAULT_VAULT_PATH)
  window.localStorage.setItem(ONBOARDING_DISMISSED_KEY, 'true')

  const state = createInitialState()

  clearMocks()
  mockWindows('main')
  installOllamaFetchMock()

  mockIPC((command, payload) => {
    const args = (payload || {}) as Record<string, unknown>

    if (command === 'init_vault') {
      const customPath = typeof args.customPath === 'string' && args.customPath.trim().length > 0
        ? args.customPath.trim()
        : DEFAULT_VAULT_PATH
      state.vaultPath = customPath
      state.semanticCacheStats.entries = state.embeddings.size
      return state.vaultPath
    }

    if (command === 'set_vault_path') {
      const nextPath = typeof args.path === 'string' && args.path.trim().length > 0
        ? args.path.trim()
        : DEFAULT_VAULT_PATH
      state.vaultPath = nextPath
      state.semanticCacheStats.entries = state.embeddings.size
      return state.vaultPath
    }

    if (command === 'read_vault_tree') {
      return buildTree(state.files)
    }

    if (command === 'local_ai_list_models') {
      const provider = typeof args.provider === 'string' ? args.provider : 'ollama'
      if (provider === 'lmstudio') {
        return [
          {
            name: 'google/gemma-3-4b',
            capability: 'text',
            capabilities: ['completion'],
          },
          {
            name: 'text-embedding-nomic-embed-text-v1.5',
            capability: 'embedding',
            capabilities: ['embedding'],
          },
        ]
      }
      return [
        {
          name: 'gpt-oss:120b-cloud',
          capability: 'text',
          capabilities: ['completion'],
        },
        {
          name: 'nomic-embed-text',
          capability: 'embedding',
          capabilities: ['embedding'],
        },
      ]
    }

    if (command === 'local_ai_generate_text') {
      const prompt = typeof args.prompt === 'string' ? args.prompt : ''
      return { text: ollamaGenerateResponse(prompt) }
    }

    if (command === 'local_ai_generate_embedding') {
      const input = typeof args.input === 'string' ? args.input : ''
      return { embedding: makeEmbedding(input) }
    }

    if (command === 'read_file') {
      const rawPath = typeof args.path === 'string' ? args.path : ''
      const normalizedPath = normalizePath(rawPath)
      const file = state.files.get(normalizedPath)
      if (typeof file !== 'string') {
        throw new Error(`File not found: ${rawPath}`)
      }
      return file
    }

    if (command === 'read_file_for_ai') {
      const rawPath = typeof args.path === 'string' ? args.path : ''
      const normalizedPath = normalizePath(rawPath)
      const file = state.files.get(normalizedPath)
      if (typeof file !== 'string') {
        throw new Error(`File not found: ${rawPath}`)
      }
      const lower = normalizedPath.toLowerCase()
      const kind = lower.endsWith('.pdf')
        ? 'pdf'
        : lower.endsWith('.docx')
          ? 'docx'
          : lower.endsWith('.pptx')
            ? 'pptx'
            : lower.endsWith('.xlsx')
              ? 'xlsx'
                : lower.endsWith('.csv')
                ? 'csv'
                : /\.(png|jpg|jpeg|gif|webp|bmp|svg|heic)$/i.test(lower)
                  ? 'image'
                  : 'text'
      return {
        kind,
        content: file,
        message: kind === 'text' ? null : kind === 'image' ? 'Mock OCR text extracted from image' : `Mock extracted ${kind.toUpperCase()} text`,
      }
    }

    if (command === 'read_file_preview') {
      const rawPath = typeof args.path === 'string' ? args.path : ''
      const normalizedPath = normalizePath(rawPath)
      const file = state.files.get(normalizedPath)
      if (typeof file !== 'string') {
        throw new Error(`File not found: ${rawPath}`)
      }
      const lower = normalizedPath.toLowerCase()
      if (/\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(lower)) {
        return {
          kind: 'image',
          file_name: normalizedPath.split('/').pop() || normalizedPath,
          mime_type: 'image/png',
          data_url: 'data:image/png;base64,',
          text: null,
          message: null,
          size_bytes: file.length,
        }
      }
      if (lower.endsWith('.pdf')) {
        return {
          kind: 'pdf',
          file_name: normalizedPath.split('/').pop() || normalizedPath,
          mime_type: 'application/pdf',
          data_url: 'data:application/pdf;base64,',
          text: null,
          message: 'Mock PDF preview',
          size_bytes: file.length,
        }
      }
      if (lower.endsWith('.docx') || lower.endsWith('.pptx') || lower.endsWith('.xlsx')) {
        const kind = lower.endsWith('.docx') ? 'docx' : lower.endsWith('.pptx') ? 'pptx' : 'xlsx'
        return {
          kind,
          file_name: normalizedPath.split('/').pop() || normalizedPath,
          mime_type: null,
          data_url: null,
          text: file,
          message: `Mock ${kind.toUpperCase()} preview`,
          size_bytes: file.length,
        }
      }
      throw new Error(`No preview renderer is available for: ${rawPath}`)
    }

    if (command === 'write_file') {
      const rawPath = typeof args.path === 'string' ? args.path : ''
      const normalizedPath = normalizePath(rawPath)
      const content = typeof args.content === 'string' ? args.content : ''
      if (!normalizedPath) throw new Error('Invalid path')
      state.files.set(normalizedPath, content)
      return normalizedPath
    }

    if (command === 'delete_path') {
      const rawPath = typeof args.path === 'string' ? args.path : ''
      const normalizedPath = normalizePath(rawPath).replace(/\/+$/, '')
      if (!normalizedPath) throw new Error('Path not found')

      const directHit = state.files.delete(normalizedPath)
      const deletedChildren: string[] = []
      for (const path of state.files.keys()) {
        if (path.startsWith(`${normalizedPath}/`)) {
          deletedChildren.push(path)
        }
      }
      for (const path of deletedChildren) {
        state.files.delete(path)
      }

      state.embeddings.delete(normalizedPath)
      for (const path of Array.from(state.embeddings.keys())) {
        if (path.startsWith(`${normalizedPath}/`)) {
          state.embeddings.delete(path)
        }
      }
      state.semanticCacheStats.entries = state.embeddings.size

      if (!directHit && deletedChildren.length === 0) {
        throw new Error(`Path not found: ${rawPath}`)
      }
      return null
    }

    if (command === 'rename_path') {
      const oldPath = normalizePath(typeof args.oldPath === 'string' ? args.oldPath : '')
      const newNameRaw = typeof args.newName === 'string' ? args.newName.trim() : ''
      if (!oldPath || !newNameRaw) throw new Error('Invalid rename input')

      if (state.files.has(oldPath)) {
        const parent = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/') + 1) : ''
        const nextName = oldPath.toLowerCase().endsWith('.md') ? withMdExtension(newNameRaw) : withExistingExtension(oldPath, newNameRaw)
        const nextPath = `${parent}${nextName}`
        if (state.files.has(nextPath)) throw new Error(`A file or folder with name '${newNameRaw}' already exists`)

        const content = state.files.get(oldPath) || ''
        state.files.delete(oldPath)
        state.files.set(nextPath, content)

        const embedding = state.embeddings.get(oldPath)
        if (embedding) {
          state.embeddings.delete(oldPath)
          state.embeddings.set(nextPath, { ...embedding, path: nextPath })
        }
        state.semanticCacheStats.entries = state.embeddings.size

        return nextPath
      }

      const folderPrefix = `${oldPath.replace(/\/+$/, '')}/`
      const folderFiles = Array.from(state.files.keys()).filter((path) => path.startsWith(folderPrefix))
      if (folderFiles.length === 0) {
        throw new Error(`Path not found: ${oldPath}`)
      }

      const parentFolder = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/') + 1) : ''
      const nextFolder = `${parentFolder}${newNameRaw}`.replace(/\/+$/, '')
      const nextPrefix = `${nextFolder}/`

      for (const existingPath of state.files.keys()) {
        if (existingPath === nextFolder || existingPath.startsWith(nextPrefix)) {
          throw new Error(`A file or folder with name '${newNameRaw}' already exists`)
        }
      }

      for (const filePath of folderFiles) {
        const content = state.files.get(filePath) || ''
        const nextPath = `${nextFolder}${filePath.slice(oldPath.length)}`
        state.files.delete(filePath)
        state.files.set(nextPath, content)

        const embedding = state.embeddings.get(filePath)
        if (embedding) {
          state.embeddings.delete(filePath)
          state.embeddings.set(nextPath, { ...embedding, path: nextPath })
        }
      }
      state.semanticCacheStats.entries = state.embeddings.size

      return nextFolder
    }

    if (command === 'create_file_in_folder') {
      const folderPath = normalizePath(typeof args.folderPath === 'string' ? args.folderPath : '').replace(/\/+$/, '')
      const fileNameRaw = typeof args.fileName === 'string' ? args.fileName.trim() : ''
      if (!fileNameRaw) throw new Error('Invalid file name')
      const fileName = withMdExtension(fileNameRaw)
      const path = folderPath ? `${folderPath}/${fileName}` : fileName
      if (state.files.has(path)) throw new Error(`File already exists: ${fileName}`)
      state.files.set(path, '')
      return path
    }

    if (command === 'create_folder') {
      const parentPath = normalizePath(typeof args.parentPath === 'string' ? args.parentPath : '').replace(/\/+$/, '')
      const folderNameRaw = typeof args.folderName === 'string' ? args.folderName.trim() : ''
      if (!folderNameRaw) throw new Error('Folder name cannot be empty')
      if (/[\\/]/.test(folderNameRaw)) throw new Error('Folder name cannot contain path separators')

      const fullPath = parentPath ? `${parentPath}/${folderNameRaw}` : folderNameRaw
      const normalizedPrefix = `${fullPath}/`
      if (state.files.has(fullPath) || Array.from(state.files.keys()).some((path) => path.startsWith(normalizedPrefix))) {
        throw new Error(`Folder already exists: ${folderNameRaw}`)
      }

      // Folder paths are implicit in this mock (derived from file paths), so return path only.
      return fullPath
    }

    if (command === 'write_embedding') {
      const notePath = normalizePath(typeof args.notePath === 'string' ? args.notePath : '')
      const embeddingDataRaw = typeof args.embeddingData === 'string' ? args.embeddingData : '{}'
      const parsed = JSON.parse(embeddingDataRaw) as Partial<MockEmbeddingRecord>
      const embeddingRecord: MockEmbeddingRecord = {
        path: notePath,
        embedding: Array.isArray(parsed.embedding) ? parsed.embedding.map((n) => Number(n) || 0) : [],
        model: typeof parsed.model === 'string' ? parsed.model : 'nomic-embed-text',
        created_at: typeof parsed.created_at === 'string' ? parsed.created_at : new Date().toISOString(),
        content_hash: typeof parsed.content_hash === 'string' ? parsed.content_hash : undefined,
        chunks: Array.isArray(parsed.chunks)
          ? parsed.chunks
            .map((chunk) => {
              if (!chunk || typeof chunk !== 'object') return null
              const candidate = chunk as {
                index?: unknown
                start?: unknown
                end?: unknown
                excerpt?: unknown
                embedding?: unknown
                content_hash?: unknown
              }
              const vector = Array.isArray(candidate.embedding)
                ? candidate.embedding.map((value) => Number(value) || 0)
                : []
              return {
                index: Number(candidate.index) || 0,
                start: Number(candidate.start) || 0,
                end: Number(candidate.end) || 0,
                excerpt: typeof candidate.excerpt === 'string' ? candidate.excerpt : '',
                embedding: vector,
                content_hash: typeof candidate.content_hash === 'string' ? candidate.content_hash : undefined,
              }
            })
            .filter((chunk): chunk is NonNullable<typeof chunk> => chunk !== null)
          : undefined,
      }
      state.embeddings.set(notePath, embeddingRecord)
      state.semanticCacheStats.entries = state.embeddings.size
      return null
    }

    if (command === 'delete_embedding') {
      const notePath = normalizePath(typeof args.notePath === 'string' ? args.notePath : '')
      const deleted = state.embeddings.delete(notePath)
      state.semanticCacheStats.entries = state.embeddings.size
      return deleted
    }

    if (command === 'read_all_embeddings') {
      return JSON.stringify(Array.from(state.embeddings.values()).sort((a, b) => a.path.localeCompare(b.path)))
    }

    if (command === 'clear_all_embeddings') {
      state.embeddings.clear()
      state.semanticCacheStats.entries = 0
      return null
    }

    if (command === 'search_semantic_embeddings') {
      const queryEmbedding = Array.isArray(args.queryEmbedding)
        ? args.queryEmbedding.map((value) => Number(value) || 0)
        : []
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 12
      if (queryEmbedding.length === 0) return []
      state.semanticCacheStats.queries += 1
      state.semanticCacheStats.hits += 1
      state.semanticCacheStats.entries = state.embeddings.size

      const hits = Array.from(state.embeddings.values())
        .map((record) => {
          let best = cosineSimilarity(queryEmbedding, record.embedding)
          let snippet: string | undefined

          for (const chunk of record.chunks || []) {
            const sim = cosineSimilarity(queryEmbedding, chunk.embedding)
            if (sim > best) {
              best = sim
              snippet = chunk.excerpt
            }
          }

          return {
            path: record.path,
            similarity: best,
            snippet,
          }
        })
        .filter((hit) => hit.similarity >= 0)
        .sort((a, b) => b.similarity - a.similarity || a.path.localeCompare(b.path))
        .slice(0, limit)

      return hits
    }

    if (command === 'get_semantic_cache_stats') {
      state.semanticCacheStats.entries = state.embeddings.size
      return { ...state.semanticCacheStats }
    }

    if (command === 'search_notes') {
      const query = (typeof args.query === 'string' ? args.query : '').trim().toLowerCase()
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 40
      if (!query) return []
      const tokens = query.split(/\s+/).filter(Boolean)
      const hits: MockSearchHit[] = []

      for (const [path, content] of state.files.entries()) {
        if (path.startsWith('.')) continue
        const lowerPath = path.toLowerCase()
        const title = pathStem(path)
        const lowerTitle = title.toLowerCase()
        const lowerContent = content.toLowerCase()

        let score = 0
        if (lowerTitle.includes(query)) score += 120
        if (lowerPath.includes(query)) score += 60
        if (lowerContent.includes(query)) score += 40

        for (const token of tokens) {
          if (lowerTitle.includes(token)) score += 20
          if (lowerPath.includes(token)) score += 10
          if (lowerContent.includes(token)) score += 4
        }

        if (score <= 0) continue
        hits.push({
          path,
          title,
          snippet: makeSnippet(content, query, tokens),
          score,
        })
      }

      hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      return hits.slice(0, limit)
    }

    if (command === 'plugin:dialog|open') {
      return state.vaultPath
    }

    if (command === 'plugin:dialog|ask' || command === 'plugin:dialog|confirm') {
      return true
    }

    if (command === 'plugin:dialog|message') {
      return null
    }

    throw new Error(`Unhandled mocked command: ${command}`)
  })

  // Pre-seed embeddings so semantic retrieval has baseline data before first regeneration.
  for (const [path, content] of state.files.entries()) {
    state.embeddings.set(path, {
      path,
      embedding: makeEmbedding(content),
      model: 'nomic-embed-text',
      created_at: new Date().toISOString(),
    })
  }
}
