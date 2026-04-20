import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { useEditor } from '../contexts/EditorContext'
import { useSettings } from '../contexts/SettingsContext'
import { useToast } from '../contexts/ToastContext'
import { vaultService, type TreeNode } from '../services/vault'
import { relatedNotesService, type RelatedNoteSuggestion } from '../services/relatedNotes'
import { buildRelatedExplanation } from '../utils/relatedExplainability'
import { recordPerfMetric, startPerfTimer } from '../utils/perfMetrics'
import { noteCollectionsService } from '../services/noteCollections'
import { activityMonitorService } from '../services/activityMonitor'
import {
  applyFormattingAction,
  createEditorHistory,
  pushHistory,
  redoHistory,
  undoHistory,
  type EditorHistory,
  type EditorSnapshot,
  type FormattingAction,
} from '../utils/editorFormatting'
import { duplicateBlockInContent, moveBlockInContent } from '../utils/blockOperations'

type EditorViewMode = 'edit' | 'preview' | 'split'
type BlockType = 'heading' | 'paragraph' | 'code' | 'quote' | 'callout' | 'list' | 'todo' | 'table' | 'rule'
type CalloutType = 'info' | 'warning' | 'idea' | 'todo'

interface HeadingItem {
  id: string
  text: string
  level: number
  line: number
}

interface ParsedBlock {
  id: string
  type: BlockType
  startLine: number
  endLine: number
  raw: string
  text?: string
  level?: number
  headingId?: string
  language?: string
  items?: string[]
  calloutType?: CalloutType
  calloutTitle?: string
}

interface BacklinkItem {
  path: string
  snippet: string
}

const BACKLINK_SCAN_RESULT_LIMIT = 20

interface LinkSuggestion {
  id: string
  path: string
  targetPath: string
  title: string
  reason: string
  reasonTags: string[]
  confidence: RelatedNoteSuggestion['confidence']
  score: number
}

interface LinkSuggestionAction {
  type: 'accept' | 'dismiss'
  suggestion: LinkSuggestion
  previousSnapshot?: EditorSnapshot
}

interface RejectedLinkTargetMeta {
  count: number
  lastRejectedAt: string
}

interface PendingLinkResolution {
  rawTarget: string
  candidates: string[]
}

const SLASH_COMMANDS = [
  { id: 'h1', label: '/h1', template: '# ' },
  { id: 'todo', label: '/todo', template: '- [ ] ' },
  { id: 'code', label: '/code', template: '```txt\n\n```' },
  { id: 'quote', label: '/quote', template: '> ' },
]

const DISMISSED_LINK_SUGGESTIONS_KEY = 'vn_dismissed_link_suggestions_v1'
const REJECTED_LINK_TARGETS_KEY = 'vn_rejected_link_targets_v1'

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
}

function parseHeadings(content: string): HeadingItem[] {
  const lines = content.split('\n')
  const headings: HeadingItem[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{1,6})\s+(.*)$/)
    if (!match) continue
    const text = match[2].trim() || 'Untitled'
    headings.push({
      id: `${slugify(text)}-${i}`,
      text,
      level: match[1].length,
      line: i,
    })
  }

  return headings
}

function parseBlocks(content: string, headings: HeadingItem[]): ParsedBlock[] {
  const lines = content.split('\n')
  const blocks: ParsedBlock[] = []
  let i = 0

  const headingByLine = new Map<number, HeadingItem>()
  headings.forEach((heading) => headingByLine.set(heading.line, heading))

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed === '') {
      i += 1
      continue
    }

    if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({
        id: `block-rule-${i}`,
        type: 'rule',
        startLine: i,
        endLine: i,
        raw: line,
      })
      i += 1
      continue
    }

    const heading = headingByLine.get(i)
    if (heading) {
      blocks.push({
        id: `block-heading-${i}`,
        type: 'heading',
        startLine: i,
        endLine: i,
        raw: line,
        text: heading.text,
        level: heading.level,
        headingId: heading.id,
      })
      i += 1
      continue
    }

    if (trimmed.startsWith('```')) {
      const start = i
      const language = trimmed.replace(/^```/, '').trim() || 'txt'
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        i += 1
      }
      if (i < lines.length) i += 1
      const end = i - 1
      const raw = lines.slice(start, end + 1).join('\n')
      const body = lines.slice(start + 1, Math.max(start + 1, end)).join('\n')
      blocks.push({
        id: `block-code-${start}`,
        type: 'code',
        startLine: start,
        endLine: end,
        raw,
        text: body,
        language,
      })
      continue
    }

    if (trimmed.startsWith('>')) {
      const start = i
      i += 1
      while (i < lines.length && lines[i].trim().startsWith('>')) i += 1
      const end = i - 1
      const raw = lines.slice(start, end + 1).join('\n')
      const cleaned = lines
        .slice(start, end + 1)
        .map((row) => row.replace(/^>\s?/, ''))
        .join('\n')

      const calloutMatch = cleaned.match(/^\[!(info|warning|idea|todo)\]\s*(.*)\n?([\s\S]*)$/i)
      if (calloutMatch) {
        blocks.push({
          id: `block-callout-${start}`,
          type: 'callout',
          startLine: start,
          endLine: end,
          raw,
          calloutType: calloutMatch[1].toLowerCase() as CalloutType,
          calloutTitle: calloutMatch[2] || calloutMatch[1],
          text: calloutMatch[3] || '',
        })
      } else {
        blocks.push({
          id: `block-quote-${start}`,
          type: 'quote',
          startLine: start,
          endLine: end,
          raw,
          text: cleaned,
        })
      }
      continue
    }

    const isPotentialTableHeader = trimmed.includes('|')
    const separatorLine = i + 1 < lines.length ? lines[i + 1].trim() : ''
    const isTableSeparator = /^[:\-|\s]+$/.test(separatorLine) && separatorLine.includes('-') && separatorLine.includes('|')
    if (isPotentialTableHeader && isTableSeparator) {
      const start = i
      i += 2
      while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim() !== '') {
        i += 1
      }
      const end = i - 1
      blocks.push({
        id: `block-table-${start}`,
        type: 'table',
        startLine: start,
        endLine: end,
        raw: lines.slice(start, end + 1).join('\n'),
        items: lines.slice(start, end + 1),
      })
      continue
    }

    if (/^[-*]\s+\[[ xX]\]\s+/.test(trimmed)) {
      const start = i
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+\[[ xX]\]\s+/.test(lines[i])) {
        items.push(lines[i])
        i += 1
      }
      const end = i - 1
      blocks.push({
        id: `block-todo-${start}`,
        type: 'todo',
        startLine: start,
        endLine: end,
        raw: lines.slice(start, end + 1).join('\n'),
        items,
      })
      continue
    }

    if (/^\s*[-*]\s+/.test(trimmed) || /^\s*\d+[.)]\s+/.test(trimmed)) {
      const start = i
      const items: string[] = []
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i]))) {
        items.push(lines[i])
        i += 1
      }
      const end = i - 1
      blocks.push({
        id: `block-list-${start}`,
        type: 'list',
        startLine: start,
        endLine: end,
        raw: lines.slice(start, end + 1).join('\n'),
        items,
      })
      continue
    }

    const start = i
    i += 1
    while (i < lines.length && lines[i].trim() !== '') {
      if (/^#{1,6}\s+/.test(lines[i]) || lines[i].trim().startsWith('```') || lines[i].trim().startsWith('>')) break
      if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(lines[i]) || /^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i])) break
      i += 1
    }
    const end = i - 1
    blocks.push({
      id: `block-paragraph-${start}`,
      type: 'paragraph',
      startLine: start,
      endLine: end,
      raw: lines.slice(start, end + 1).join('\n'),
      text: lines.slice(start, end + 1).join('\n'),
    })
  }

  return blocks
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function flattenTreeFilePaths(nodes: TreeNode[]): string[] {
  const files: string[] = []
  for (const node of nodes) {
    if (node.type === 'file') {
      files.push(node.path)
      continue
    }
    files.push(...flattenTreeFilePaths(node.children))
  }
  return files
}

function normalizeVaultPath(value: string): string {
  return value.replace(/^notes\//i, '').replace(/\.md$/i, '').trim().toLowerCase()
}

function displayNotePath(path: string): string {
  return path.replace(/^notes\//i, '').replace(/\.md$/i, '')
}

function displayDocumentTitle(path: string | null, isNewNote: boolean): string {
  if (isNewNote) return 'Untitled'
  if (!path) return 'Untitled'
  const fileName = path.replace(/^notes\//i, '').split('/').pop() || 'Untitled'
  return fileName.replace(/\.md$/i, '')
}

function displayDocumentParentPath(path: string | null, isNewNote: boolean): string {
  if (!path) return isNewNote ? 'Draft' : 'Root'
  const relativePath = path.replace(/^notes\//i, '')
  const segments = relativePath.split('/')
  return segments.length > 1 ? segments.slice(0, -1).join(' / ') : (isNewNote ? 'Draft' : 'Root')
}

function getLowerExtension(path: string | null): string {
  if (!path) return ''
  const fileName = path.split('/').pop() || path
  const parts = fileName.split('.')
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
}

function getPreviewCapabilityMeta(path: string | null, previewKind?: string | null): {
  typeLabel: string
  capabilityLabel: string
  capabilityTone: string
} {
  if (previewKind === 'image') {
    return {
      typeLabel: 'Image',
      capabilityLabel: 'Preview only',
      capabilityTone: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
    }
  }
  if (previewKind === 'pdf') {
    return {
      typeLabel: 'PDF',
      capabilityLabel: 'AI-readable document',
      capabilityTone: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
    }
  }
  if (previewKind === 'docx') {
    return {
      typeLabel: 'DOCX',
      capabilityLabel: 'AI-readable document',
      capabilityTone: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
    }
  }
  if (previewKind === 'pptx') {
    return {
      typeLabel: 'PPTX',
      capabilityLabel: 'AI-readable document',
      capabilityTone: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
    }
  }
  if (previewKind === 'xlsx') {
    return {
      typeLabel: 'XLSX',
      capabilityLabel: 'AI-readable document',
      capabilityTone: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
    }
  }
  const extension = getLowerExtension(path)
  if (!extension) {
    return {
      typeLabel: 'Note',
      capabilityLabel: 'Editable note',
      capabilityTone: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    }
  }
  return {
    typeLabel: extension.toUpperCase(),
    capabilityLabel: 'Editable note',
    capabilityTone: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  }
}

function readDismissedLinkSuggestions(): Record<string, string[]> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(DISMISSED_LINK_SUGGESTIONS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, string[]>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeDismissedLinkSuggestions(value: Record<string, string[]>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(DISMISSED_LINK_SUGGESTIONS_KEY, JSON.stringify(value))
  } catch {
    // Best-effort only.
  }
}

function readRejectedLinkTargets(): Record<string, RejectedLinkTargetMeta> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(REJECTED_LINK_TARGETS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, RejectedLinkTargetMeta>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeRejectedLinkTargets(value: Record<string, RejectedLinkTargetMeta>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(REJECTED_LINK_TARGETS_KEY, JSON.stringify(value))
  } catch {
    // Best-effort only.
  }
}

function confidenceBadgeClass(confidence: RelatedNoteSuggestion['confidence']): string {
  if (confidence === 'high') return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
  if (confidence === 'medium') return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
  return 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200'
}

function normalizePathForMatch(path: string): string {
  return path.replace(/^notes\//i, '').trim().toLowerCase()
}

function snippetToSearchCandidates(snippet: string): string[] {
  const cleaned = snippet
    .replace(/[…]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned) return []

  const tokens = (cleaned.match(/[A-Za-z0-9]{3,}/g) || [])
    .filter((token) => !['the', 'and', 'for', 'with', 'that', 'this', 'from', 'when', 'what', 'where'].includes(token.toLowerCase()))

  const uniqueTokens = Array.from(new Set(tokens))
  const byLength = [...uniqueTokens].sort((a, b) => b.length - a.length)

  const candidates: string[] = []
  if (byLength[0]) candidates.push(byLength[0])
  if (byLength[1]) candidates.push(byLength[1])

  const phraseWords = cleaned.split(' ').filter(Boolean).slice(0, 6)
  if (phraseWords.length >= 2) {
    candidates.push(phraseWords.join(' '))
  }

  return Array.from(new Set(candidates)).filter((candidate) => candidate.length > 0)
}

function isInsideWikiLink(content: string, index: number): boolean {
  const open = content.lastIndexOf('[[', index)
  if (open === -1) return false
  const close = content.indexOf(']]', open)
  if (close === -1) return false
  return index >= open && index <= close + 1
}

function extractWikiTarget(rawWiki: string): { target: string; label: string } {
  const content = rawWiki.slice(2, -2).trim()
  const [base, alias] = content.split('|')
  const target = (base || '').split('#')[0].trim()
  const label = (alias || base || '').trim()
  return { target, label }
}

function splitTableRow(line: string): string[] {
  const raw = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return raw.split('|').map((cell) => cell.trim())
}

function parseTableAlignments(separatorLine: string, columnCount: number): Array<'left' | 'center' | 'right'> {
  const cols = splitTableRow(separatorLine)
  const alignments: Array<'left' | 'center' | 'right'> = []
  for (let i = 0; i < columnCount; i += 1) {
    const col = (cols[i] || '').trim()
    if (col.startsWith(':') && col.endsWith(':')) {
      alignments.push('center')
    } else if (col.endsWith(':')) {
      alignments.push('right')
    } else {
      alignments.push('left')
    }
  }
  return alignments
}

function getCodeLangKind(language: string): 'js' | 'python' | 'rust' | 'shell' | 'json' | 'generic' {
  const lang = language.toLowerCase()
  if (lang.includes('ts') || lang.includes('js') || lang.includes('jsx') || lang.includes('tsx')) return 'js'
  if (lang.includes('py')) return 'python'
  if (lang.includes('rs') || lang.includes('rust')) return 'rust'
  if (lang.includes('sh') || lang.includes('bash') || lang.includes('zsh')) return 'shell'
  if (lang.includes('json')) return 'json'
  return 'generic'
}

function highlightCodeLine(line: string, language: string): ReactNode[] {
  const kind = getCodeLangKind(language)
  let tokenRegex: RegExp
  let keywordRegex: RegExp

  if (kind === 'js') {
    tokenRegex = /(\/\/.*$|".*?"|'.*?'|`.*?`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g
    keywordRegex = /^(const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|extends|new|try|catch|finally|throw|import|export|from|default|await|async|true|false|null|undefined)$/
  } else if (kind === 'python') {
    tokenRegex = /(#.*$|".*?"|'.*?'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g
    keywordRegex = /^(def|class|return|if|elif|else|for|while|try|except|finally|raise|import|from|as|with|lambda|yield|True|False|None|and|or|not|in|is|pass|break|continue)$/
  } else if (kind === 'rust') {
    tokenRegex = /(\/\/.*$|".*?"|'.*?'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g
    keywordRegex = /^(fn|let|mut|pub|impl|struct|enum|trait|mod|use|crate|self|super|match|if|else|loop|while|for|in|return|where|async|await|move|const|static|true|false|Some|None|Result|Ok|Err)$/
  } else if (kind === 'shell') {
    tokenRegex = /(#.*$|".*?"|'.*?'|\$\w+|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][\w-]*\b)/g
    keywordRegex = /^(if|then|else|fi|for|in|do|done|case|esac|while|until|function|export|local|readonly)$/
  } else if (kind === 'json') {
    tokenRegex = /(".*?"|\b\d+(?:\.\d+)?\b|\btrue\b|\bfalse\b|\bnull\b)/g
    keywordRegex = /^$/
  } else {
    tokenRegex = /(".*?"|'.*?'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g
    keywordRegex = /^$/
  }

  const tokens: ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  while ((match = tokenRegex.exec(line)) !== null) {
    const token = match[0]
    const start = match.index
    if (start > last) {
      tokens.push(<span key={`${start}-text`}>{line.slice(last, start)}</span>)
    }

    let className = 'text-slate-100'
    if (token.startsWith('//') || token.startsWith('#')) {
      className = 'text-emerald-300/90'
    } else if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'")) ||
      token.startsWith('`')
    ) {
      className = 'text-amber-300'
    } else if (/^\d/.test(token)) {
      className = 'text-fuchsia-300'
    } else if (kind === 'json' && /^(true|false|null)$/.test(token)) {
      className = 'text-cyan-300'
    } else if (keywordRegex.test(token)) {
      className = 'text-sky-300'
    } else if (kind === 'json' && token.startsWith('"')) {
      className = 'text-green-300'
    }

    tokens.push(
      <span key={`${start}-${token}`} className={className}>
        {token}
      </span>,
    )
    last = start + token.length
  }

  if (last < line.length) {
    tokens.push(<span key={`${last}-tail`}>{line.slice(last)}</span>)
  }

  return tokens.length > 0 ? tokens : [<span key="raw">{line}</span>]
}

function findHeadingVisibilityBoundaries(headings: HeadingItem[]): Map<string, number> {
  const nextBoundary = new Map<string, number>()
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i]
    let boundary = Number.MAX_SAFE_INTEGER
    for (let j = i + 1; j < headings.length; j += 1) {
      if (headings[j].level <= heading.level) {
        boundary = headings[j].line
        break
      }
    }
    nextBoundary.set(heading.id, boundary)
  }
  return nextBoundary
}

function MainPanel() {
  const {
    tabs,
    activeTabId,
    activeTab,
    currentFile,
    content,
    hasUnsavedChanges,
    isNewNote,
    isSaving,
    openFile,
    updateContent,
    saveFile,
    renamePath,
    createNewNote,
    switchTab,
    closeTab,
  } = useEditor()
  const { settings } = useSettings()
  const { showToast } = useToast()
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const fileSearchInputRef = useRef<HTMLInputElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const contentAreaRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<EditorHistory>(createEditorHistory(400))
  const pendingSelectionRef = useRef<{ start: number; end: number; focus: boolean } | null>(null)
  const pendingPreInputSnapshotRef = useRef<EditorSnapshot | null>(null)
  const lastKnownSelectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 })
  const lastLoadedFileRef = useRef<string | null>(null)
  const backlinksCacheRef = useRef<Map<string, BacklinkItem[]>>(new Map())
  const programmaticEditorScrollTopRef = useRef<number | null>(null)
  const programmaticPreviewScrollTopRef = useRef<number | null>(null)
  const rightSidebarResizeFrameRef = useRef<number | null>(null)

  const [editorViewMode, setEditorViewMode] = useState<EditorViewMode>(settings.defaultEditorViewMode)
  const [readingMode, setReadingMode] = useState(settings.defaultReadingMode)
  const [focusMode, setFocusMode] = useState(false)
  const [presentationMode, setPresentationMode] = useState(false)

  const [showInFileSearch, setShowInFileSearch] = useState(false)
  const [inFileQuery, setInFileQuery] = useState('')
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0)
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [isRightSidebarVisible, setIsRightSidebarVisible] = useState(() => {
    try {
      const raw = localStorage.getItem('vn_editor_right_sidebar_visible')
      return raw == null ? true : raw !== 'false'
    } catch {
      return true
    }
  })
  const [rightSidebarWidth, setRightSidebarWidth] = useState(() => {
    try {
      const raw = localStorage.getItem('vn_editor_right_sidebar_width')
      const parsed = raw ? Number(raw) : NaN
      return Number.isFinite(parsed) ? Math.min(520, Math.max(220, parsed)) : 288
    } catch {
      return 288
    }
  })

  const [cursorLine, setCursorLine] = useState(1)
  const [cursorColumn, setCursorColumn] = useState(1)
  const [selectedChars, setSelectedChars] = useState(0)
  const [selectedWords, setSelectedWords] = useState(0)

  const [collapsedHeadingIds, setCollapsedHeadingIds] = useState<Set<string>>(new Set())
  const [backlinks, setBacklinks] = useState<BacklinkItem[]>([])
  const [backlinksLoading, setBacklinksLoading] = useState(false)
  const [backlinksAutoPaused, setBacklinksAutoPaused] = useState(false)
  const [relatedNotes, setRelatedNotes] = useState<RelatedNoteSuggestion[]>([])
  const [relatedLoading, setRelatedLoading] = useState(false)
  const [relatedError, setRelatedError] = useState<string | null>(null)
  const [dismissedLinkSuggestionIds, setDismissedLinkSuggestionIds] = useState<Set<string>>(new Set())
  const [lastLinkSuggestionAction, setLastLinkSuggestionAction] = useState<LinkSuggestionAction | null>(null)
  const [rejectedLinkTargets, setRejectedLinkTargets] = useState<Record<string, RejectedLinkTargetMeta>>({})
  const [pendingSourceJump, setPendingSourceJump] = useState<{ path: string; snippet: string } | null>(null)
  const [allNotePaths, setAllNotePaths] = useState<string[]>([])
  const [pendingLinkResolution, setPendingLinkResolution] = useState<PendingLinkResolution | null>(null)
  const [outlineActiveIndex, setOutlineActiveIndex] = useState(0)
  const [backlinkActiveIndex, setBacklinkActiveIndex] = useState(0)
  const [relatedActiveIndex, setRelatedActiveIndex] = useState(0)
  const [isFavorite, setIsFavorite] = useState(false)
  const [activeSidebarPanel, setActiveSidebarPanel] = useState<'outline' | 'backlinks' | 'related'>('outline')
  const [settledCurrentFile, setSettledCurrentFile] = useState<string | null>(currentFile)

  const [slashOpen, setSlashOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')

  useEffect(() => {
    setEditorViewMode(settings.defaultEditorViewMode)
  }, [settings.defaultEditorViewMode])

  useEffect(() => {
    setReadingMode(settings.defaultReadingMode)
  }, [settings.defaultReadingMode])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettledCurrentFile(currentFile)
    }, 180)

    return () => window.clearTimeout(timer)
  }, [currentFile])

  useEffect(() => {
    const storage = readDismissedLinkSuggestions()
    const pathKey = settledCurrentFile ? normalizeVaultPath(settledCurrentFile) : ''
    setDismissedLinkSuggestionIds(new Set(pathKey ? storage[pathKey] || [] : []))
    setRejectedLinkTargets(readRejectedLinkTargets())
    setLastLinkSuggestionAction(null)
  }, [settledCurrentFile])

  useEffect(() => {
    if (!settledCurrentFile || isNewNote) {
      setIsFavorite(false)
      return
    }
    noteCollectionsService.touchRecent(settledCurrentFile)
    setIsFavorite(noteCollectionsService.isFavorite(settledCurrentFile))
  }, [settledCurrentFile, isNewNote])

  useEffect(() => {
    const syncFavoriteState = () => {
      if (!settledCurrentFile || isNewNote) {
        setIsFavorite(false)
        return
      }
      setIsFavorite(noteCollectionsService.isFavorite(settledCurrentFile))
    }

    window.addEventListener(noteCollectionsService.changedEvent, syncFavoriteState)
    return () => window.removeEventListener(noteCollectionsService.changedEvent, syncFavoriteState)
  }, [settledCurrentFile, isNewNote])

  const isPreviewTab = activeTab?.kind === 'preview'
  const previewData = activeTab?.previewData ?? null
  const effectiveEditorViewMode: EditorViewMode = isPreviewTab ? 'preview' : editorViewMode
  const capabilityMeta = getPreviewCapabilityMeta(currentFile, previewData?.kind)
  const noteTitle = displayDocumentTitle(currentFile, isNewNote)
  const parentPath = displayDocumentParentPath(currentFile, isNewNote)
  const words = content.trim().length === 0 ? 0 : content.trim().split(/\s+/).length
  const chars = content.length
  const lines = content.length === 0 ? 1 : content.split('\n').length
  const readTime = isPreviewTab ? 0 : Math.max(1, Math.ceil(words / 200))

  const deferredContent = useDeferredValue(content)
  const headings = useMemo(() => parseHeadings(deferredContent), [deferredContent])
  const shouldParsePreviewBlocks = !isPreviewTab && effectiveEditorViewMode !== 'edit'
  const parsedBlocks = useMemo(
    () => (shouldParsePreviewBlocks ? parseBlocks(deferredContent, headings) : []),
    [deferredContent, headings, shouldParsePreviewBlocks],
  )
  const nextBoundaryByHeadingId = useMemo(() => findHeadingVisibilityBoundaries(headings), [headings])

  useEffect(() => {
    setIsEditingTitle(false)
    setTitleDraft(noteTitle)
  }, [noteTitle, currentFile])

  useEffect(() => {
    if (!isEditingTitle || !titleInputRef.current) return
    titleInputRef.current.focus()
    titleInputRef.current.select()
  }, [isEditingTitle])

  useEffect(() => {
    try {
      localStorage.setItem('vn_editor_right_sidebar_visible', String(isRightSidebarVisible))
    } catch {
      // Ignore localStorage failures.
    }
  }, [isRightSidebarVisible])

  useEffect(() => {
    try {
      localStorage.setItem('vn_editor_right_sidebar_width', String(rightSidebarWidth))
    } catch {
      // Ignore localStorage failures.
    }
  }, [rightSidebarWidth])

  useEffect(() => {
    if (isPreviewTab || effectiveEditorViewMode !== 'split') return

    const editor = editorRef.current
    const preview = previewRef.current
    if (!editor || !preview) return

    const syncScroll = (source: 'editor' | 'preview') => {
      const sourceEl = source === 'editor' ? editor : preview
      const targetEl = source === 'editor' ? preview : editor
      const maxSourceScroll = Math.max(1, sourceEl.scrollHeight - sourceEl.clientHeight)
      const maxTargetScroll = Math.max(0, targetEl.scrollHeight - targetEl.clientHeight)
      const ratio = sourceEl.scrollTop / maxSourceScroll
      const nextTargetScrollTop = ratio * maxTargetScroll
      if (source === 'editor') {
        programmaticPreviewScrollTopRef.current = nextTargetScrollTop
      } else {
        programmaticEditorScrollTopRef.current = nextTargetScrollTop
      }
      targetEl.scrollTop = nextTargetScrollTop
    }

    const handleEditorScroll = () => {
      if (
        programmaticEditorScrollTopRef.current !== null &&
        Math.abs(editor.scrollTop - programmaticEditorScrollTopRef.current) < 2
      ) {
        programmaticEditorScrollTopRef.current = null
        return
      }
      syncScroll('editor')
    }

    const handlePreviewScroll = () => {
      if (
        programmaticPreviewScrollTopRef.current !== null &&
        Math.abs(preview.scrollTop - programmaticPreviewScrollTopRef.current) < 2
      ) {
        programmaticPreviewScrollTopRef.current = null
        return
      }
      syncScroll('preview')
    }

    editor.addEventListener('scroll', handleEditorScroll, { passive: true })
    preview.addEventListener('scroll', handlePreviewScroll, { passive: true })

    return () => {
      editor.removeEventListener('scroll', handleEditorScroll)
      preview.removeEventListener('scroll', handlePreviewScroll)
      programmaticEditorScrollTopRef.current = null
      programmaticPreviewScrollTopRef.current = null
    }
  }, [effectiveEditorViewMode, isPreviewTab, currentFile, content])

  const beginTitleRename = useCallback(() => {
    if (isNewNote || !currentFile) {
      showToast('Save this note first, then rename it.', 'warning')
      return
    }
    setTitleDraft(noteTitle)
    setIsEditingTitle(true)
  }, [currentFile, isNewNote, noteTitle, showToast])

  const startRightSidebarResize = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    const minWidth = 220
    const maxWidth = 520
    const container = contentAreaRef.current
    if (!container) return
    const containerBounds = container.getBoundingClientRect()

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handlePointerMove = (moveEvent: MouseEvent) => {
      const boundedClientX = Math.min(containerBounds.right, Math.max(containerBounds.left, moveEvent.clientX))
      const nextWidth = containerBounds.right - boundedClientX
      if (rightSidebarResizeFrameRef.current) {
        cancelAnimationFrame(rightSidebarResizeFrameRef.current)
      }
      rightSidebarResizeFrameRef.current = window.requestAnimationFrame(() => {
        setRightSidebarWidth(Math.min(maxWidth, Math.max(minWidth, nextWidth)))
        rightSidebarResizeFrameRef.current = null
      })
    }

    const handlePointerUp = () => {
      if (rightSidebarResizeFrameRef.current) {
        cancelAnimationFrame(rightSidebarResizeFrameRef.current)
        rightSidebarResizeFrameRef.current = null
      }
      window.removeEventListener('mousemove', handlePointerMove)
      window.removeEventListener('mouseup', handlePointerUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('mousemove', handlePointerMove)
    window.addEventListener('mouseup', handlePointerUp)
  }, [])

  const submitTitleRename = useCallback(async () => {
    if (!currentFile || isNewNote) {
      setIsEditingTitle(false)
      return
    }

    const trimmed = titleDraft.trim()
    if (!trimmed) {
      setIsEditingTitle(false)
      setTitleDraft(noteTitle)
      return
    }

    try {
      await renamePath(currentFile, trimmed)
      setIsEditingTitle(false)
      showToast('Title updated', 'success')
    } catch (error) {
      console.error('Failed to rename from title input:', error)
      showToast('Failed to rename note', 'error')
    }
  }, [currentFile, isNewNote, noteTitle, renamePath, showToast, titleDraft])

  const cancelTitleRename = useCallback(() => {
    setIsEditingTitle(false)
    setTitleDraft(noteTitle)
  }, [noteTitle])

  const visibleBlocks = useMemo(() => {
    if (collapsedHeadingIds.size === 0) return parsedBlocks
    return parsedBlocks.filter((block) => {
      for (const heading of headings) {
        if (!collapsedHeadingIds.has(heading.id)) continue
        const boundary = nextBoundaryByHeadingId.get(heading.id) ?? Number.MAX_SAFE_INTEGER
        if (block.startLine > heading.line && block.startLine < boundary) {
          return false
        }
      }
      return true
    })
  }, [collapsedHeadingIds, headings, nextBoundaryByHeadingId, parsedBlocks])
  const parsedBlockIndexById = useMemo(
    () => new Map(parsedBlocks.map((block, index) => [block.id, index])),
    [parsedBlocks],
  )

  const inFileMatches = useMemo(() => {
    const q = inFileQuery.trim().toLowerCase()
    if (!q) return [] as Array<{ start: number; end: number }>
    const text = content.toLowerCase()
    const matches: Array<{ start: number; end: number }> = []
    let from = 0
    while (from < text.length) {
      const index = text.indexOf(q, from)
      if (index === -1) break
      matches.push({ start: index, end: index + q.length })
      from = index + q.length
    }
    return matches
  }, [content, inFileQuery])

  const activeMatchIndex = inFileMatches.length === 0 ? 0 : Math.min(currentMatchIndex, inFileMatches.length - 1)

  const notePathIndex = useMemo(() => {
    const byPath = new Map<string, string>()
    const byTitle = new Map<string, string[]>()

    for (const path of allNotePaths) {
      const normalized = normalizeVaultPath(path)
      byPath.set(normalized, path)

      const segments = normalized.split('/')
      const title = segments[segments.length - 1]
      if (!byTitle.has(title)) {
        byTitle.set(title, [])
      }
      byTitle.get(title)?.push(path)
    }

    return { byPath, byTitle }
  }, [allNotePaths])

  const linkSuggestions = useMemo(() => {
    if (!currentFile || relatedNotes.length === 0 || content.trim().length === 0) return [] as LinkSuggestion[]

    const suggestions: LinkSuggestion[] = []
    for (const related of relatedNotes) {
      if (related.confidence !== 'high' && related.score < 0.72) continue
      const targetPath = displayNotePath(related.path)
      const title = targetPath.split('/').pop() || targetPath
      if (!title || title.length < 3) continue

      const id = `${targetPath.toLowerCase()}::${title.toLowerCase()}`
      if (dismissedLinkSuggestionIds.has(id)) continue
      const rejectionMeta = rejectedLinkTargets[normalizeVaultPath(related.path)]
      if (rejectionMeta?.count >= 3 && related.score < 0.86) continue
      if (rejectionMeta?.count >= 2 && related.confidence !== 'high') continue

      const linkedAlreadyRegex = new RegExp(
        `\\[\\[(?:${escapeRegExp(targetPath)}|${escapeRegExp(title)})(?:\\||#|\\]\\])`,
        'i',
      )
      if (linkedAlreadyRegex.test(content)) continue

      const mentionRegex = new RegExp(`\\b${escapeRegExp(title)}\\b`, 'i')
      const mention = mentionRegex.exec(content)
      if (!mention || typeof mention.index !== 'number') continue
      if (isInsideWikiLink(content, mention.index)) continue

      suggestions.push({
        id,
        path: related.path,
        targetPath,
        title: mention[0],
        reason: related.reason,
        reasonTags: related.reasonTags || [],
        confidence: related.confidence,
        score: related.score,
      })

      if (suggestions.length >= 3) break
    }

    return suggestions
  }, [content, currentFile, dismissedLinkSuggestionIds, rejectedLinkTargets, relatedNotes])

  const getCurrentSnapshot = useCallback((): EditorSnapshot => {
    const editor = editorRef.current
    if (!editor) {
      return {
        content,
        selectionStart: lastKnownSelectionRef.current.start,
        selectionEnd: lastKnownSelectionRef.current.end,
      }
    }
    return {
      content,
      selectionStart: editor.selectionStart,
      selectionEnd: editor.selectionEnd,
    }
  }, [content])

  const applyContentUpdate = useCallback((next: EditorSnapshot, focus = true) => {
    pendingSelectionRef.current = {
      start: next.selectionStart,
      end: next.selectionEnd,
      focus,
    }
    lastKnownSelectionRef.current = {
      start: next.selectionStart,
      end: next.selectionEnd,
    }
    updateContent(next.content)
  }, [updateContent])

  const runFormattingAction = useCallback((action: FormattingAction) => {
    const editor = editorRef.current
    if (!editor) return

    const before = getCurrentSnapshot()
    const result = applyFormattingAction(action, before.content, before.selectionStart, before.selectionEnd)
    if (result.content === before.content) return

    historyRef.current = pushHistory(historyRef.current, before)
    applyContentUpdate(
      {
        content: result.content,
        selectionStart: result.selectionStart,
        selectionEnd: result.selectionEnd,
      },
      true,
    )
  }, [applyContentUpdate, getCurrentSnapshot])

  const focusAndSelectMatch = useCallback((index: number) => {
    if (!editorRef.current) return
    if (inFileMatches.length === 0) return
    const normalized = ((index % inFileMatches.length) + inFileMatches.length) % inFileMatches.length
    const match = inFileMatches[normalized]
    editorRef.current.setSelectionRange(match.start, match.end)

    const lineBefore = content.slice(0, match.start).split('\n').length - 1
    const approxLineHeight = presentationMode ? 32 : 24
    const targetTop = Math.max(0, lineBefore * approxLineHeight - editorRef.current.clientHeight / 2)
    editorRef.current.scrollTop = targetTop

    fileSearchInputRef.current?.focus()
    setCurrentMatchIndex(normalized)
  }, [content, inFileMatches, presentationMode])

  const goToNextMatch = useCallback(() => {
    if (inFileMatches.length === 0) return
    focusAndSelectMatch(activeMatchIndex + 1)
  }, [activeMatchIndex, focusAndSelectMatch, inFileMatches.length])

  const goToPreviousMatch = useCallback(() => {
    if (inFileMatches.length === 0) return
    focusAndSelectMatch(activeMatchIndex - 1)
  }, [activeMatchIndex, focusAndSelectMatch, inFileMatches.length])

  const applySourceJump = useCallback((snippet: string): boolean => {
    const candidates = snippetToSearchCandidates(snippet)
    if (candidates.length === 0) return false

    const lowerContent = content.toLowerCase()
    const matchedCandidate = candidates.find((candidate) => lowerContent.includes(candidate.toLowerCase())) || candidates[0]
    if (!matchedCandidate) return false

    setShowInFileSearch(true)
    setInFileQuery(matchedCandidate)
    setCurrentMatchIndex(0)

    window.setTimeout(() => {
      if (!editorRef.current) return
      const index = editorRef.current.value.toLowerCase().indexOf(matchedCandidate.toLowerCase())
      fileSearchInputRef.current?.focus()
      fileSearchInputRef.current?.select()
      if (index < 0) return

      editorRef.current.setSelectionRange(index, index + matchedCandidate.length)
      const lineBefore = editorRef.current.value.slice(0, index).split('\n').length - 1
      const approxLineHeight = presentationMode ? 32 : 24
      editorRef.current.scrollTop = Math.max(0, lineBefore * approxLineHeight - editorRef.current.clientHeight / 2)
      fileSearchInputRef.current?.focus()
    }, 80)

    return true
  }, [content, presentationMode])

  const moveBlock = useCallback((blockId: string, direction: -1 | 1) => {
    if (parsedBlocks.length <= 1) return
    const before = getCurrentSnapshot()
    const result = moveBlockInContent(
      before.content,
      parsedBlocks.map(({ id, startLine, endLine }) => ({ id, startLine, endLine })),
      blockId,
      direction,
    )
    if (!result.moved || result.content === before.content) return

    historyRef.current = pushHistory(historyRef.current, before)
    applyContentUpdate(
      {
        content: result.content,
        selectionStart: before.selectionStart,
        selectionEnd: before.selectionEnd,
      },
      false,
    )
  }, [applyContentUpdate, getCurrentSnapshot, parsedBlocks])

  const duplicateBlock = useCallback((blockId: string) => {
    if (parsedBlocks.length === 0) return
    const before = getCurrentSnapshot()
    const result = duplicateBlockInContent(
      before.content,
      parsedBlocks.map(({ id, startLine, endLine }) => ({ id, startLine, endLine })),
      blockId,
    )
    if (!result.duplicated || result.content === before.content) return

    historyRef.current = pushHistory(historyRef.current, before)
    applyContentUpdate(
      {
        content: result.content,
        selectionStart: before.selectionStart,
        selectionEnd: before.selectionEnd,
      },
      false,
    )
  }, [applyContentUpdate, getCurrentSnapshot, parsedBlocks])

  const handleSave = useCallback(async () => {
    try {
      await saveFile()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to save note', 'error')
    }
  }, [saveFile, showToast])

  const handleToggleFavorite = useCallback(() => {
    if (!currentFile || isNewNote) {
      showToast('Save the note first to add favorites.', 'warning')
      return
    }
    const next = noteCollectionsService.toggleFavorite(currentFile)
    setIsFavorite(next)
    showToast(next ? 'Added to favorites' : 'Removed from favorites', 'success')
  }, [currentFile, isNewNote, showToast])

  const handleUndo = useCallback(() => {
    const current = getCurrentSnapshot()
    const result = undoHistory(historyRef.current, current)
    if (!result.snapshot) return
    historyRef.current = result.history
    applyContentUpdate(result.snapshot, true)
  }, [applyContentUpdate, getCurrentSnapshot])

  const handleRedo = useCallback(() => {
    const current = getCurrentSnapshot()
    const result = redoHistory(historyRef.current, current)
    if (!result.snapshot) return
    historyRef.current = result.history
    applyContentUpdate(result.snapshot, true)
  }, [applyContentUpdate, getCurrentSnapshot])

  const handleEditorChange = useCallback((nextValue: string, selectionStart: number, selectionEnd: number) => {
    const preInputSnapshot = pendingPreInputSnapshotRef.current
    const before =
      preInputSnapshot && preInputSnapshot.content === content
        ? preInputSnapshot
        : {
            content,
            selectionStart: lastKnownSelectionRef.current.start,
            selectionEnd: lastKnownSelectionRef.current.end,
          }
    pendingPreInputSnapshotRef.current = null

    if (nextValue === before.content) return

    historyRef.current = pushHistory(historyRef.current, before)
    const changedChars = Math.max(1, Math.abs(nextValue.length - before.content.length))
    activityMonitorService.recordTyping(changedChars)
    applyContentUpdate(
      {
        content: nextValue,
        selectionStart,
        selectionEnd,
      },
      false,
    )
  }, [applyContentUpdate, content])

  const persistDismissedSuggestion = useCallback((suggestionId: string, dismissed: boolean) => {
    const pathKey = currentFile ? normalizeVaultPath(currentFile) : ''
    if (!pathKey) return
    const storage = readDismissedLinkSuggestions()
    const current = new Set(storage[pathKey] || [])
    if (dismissed) current.add(suggestionId)
    else current.delete(suggestionId)
    if (current.size === 0) delete storage[pathKey]
    else storage[pathKey] = Array.from(current)
    writeDismissedLinkSuggestions(storage)
  }, [currentFile])

  const updateRejectedTargetPreference = useCallback((targetPath: string, direction: 'increment' | 'clear' | 'decrement') => {
    const normalizedTarget = normalizeVaultPath(targetPath)
    if (!normalizedTarget) return
    setRejectedLinkTargets((prev) => {
      const next = { ...prev }
      const existing = next[normalizedTarget]
      if (direction === 'clear') {
        delete next[normalizedTarget]
      } else if (direction === 'decrement') {
        if (!existing || existing.count <= 1) delete next[normalizedTarget]
        else next[normalizedTarget] = { ...existing, count: existing.count - 1 }
      } else {
        next[normalizedTarget] = {
          count: (existing?.count || 0) + 1,
          lastRejectedAt: new Date().toISOString(),
        }
      }
      writeRejectedLinkTargets(next)
      return next
    })
  }, [])

  const dismissLinkSuggestion = useCallback((suggestion: LinkSuggestion) => {
    setDismissedLinkSuggestionIds((prev) => {
      const next = new Set(prev)
      next.add(suggestion.id)
      return next
    })
    persistDismissedSuggestion(suggestion.id, true)
    updateRejectedTargetPreference(suggestion.path, 'increment')
    setLastLinkSuggestionAction({
      type: 'dismiss',
      suggestion,
    })
  }, [persistDismissedSuggestion, updateRejectedTargetPreference])

  const undoLastLinkSuggestionAction = useCallback(() => {
    if (!lastLinkSuggestionAction) return

    if (lastLinkSuggestionAction.type === 'dismiss') {
      setDismissedLinkSuggestionIds((prev) => {
        const next = new Set(prev)
        next.delete(lastLinkSuggestionAction.suggestion.id)
        return next
      })
      persistDismissedSuggestion(lastLinkSuggestionAction.suggestion.id, false)
      updateRejectedTargetPreference(lastLinkSuggestionAction.suggestion.path, 'decrement')
      showToast('Link suggestion restored', 'success')
      setLastLinkSuggestionAction(null)
      return
    }

    if (lastLinkSuggestionAction.previousSnapshot) {
      historyRef.current = pushHistory(historyRef.current, getCurrentSnapshot())
      applyContentUpdate(lastLinkSuggestionAction.previousSnapshot, true)
    }
    setDismissedLinkSuggestionIds((prev) => {
      const next = new Set(prev)
      next.delete(lastLinkSuggestionAction.suggestion.id)
      return next
    })
    persistDismissedSuggestion(lastLinkSuggestionAction.suggestion.id, false)
    updateRejectedTargetPreference(lastLinkSuggestionAction.suggestion.path, 'clear')
    showToast('Link suggestion reverted', 'success')
    setLastLinkSuggestionAction(null)
  }, [applyContentUpdate, getCurrentSnapshot, lastLinkSuggestionAction, persistDismissedSuggestion, showToast, updateRejectedTargetPreference])

  const removeBacklinkFromSource = useCallback(async (item: BacklinkItem) => {
    if (!currentFile) return
    try {
      const source = await vaultService.readFile(item.path)
      const targetPath = normalizeVaultPath(currentFile).replace(/\.md$/i, '')
      const targetTitle = noteTitle.trim().toLowerCase()
      let removedCount = 0
      const wikiLinkRegex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g

      const next = source.replace(wikiLinkRegex, (_full, rawTarget: string, alias?: string) => {
        const normalizedTarget = normalizeVaultPath(rawTarget || '').replace(/\.md$/i, '')
        const targetLastSegment = normalizedTarget.split('/').pop()?.toLowerCase() || normalizedTarget.toLowerCase()
        const matches =
          normalizedTarget.toLowerCase() === targetPath.toLowerCase() ||
          targetLastSegment === targetTitle

        if (!matches) return _full
        removedCount += 1
        return (alias || rawTarget.split('/').pop() || rawTarget).trim()
      })

      if (removedCount === 0) {
        showToast('No removable wiki backlinks found in this note.', 'warning')
        return
      }

      await vaultService.writeFile(item.path, next)
      setBacklinks((prev) => prev.filter((backlink) => backlink.path !== item.path))
      showToast(`Removed ${removedCount} backlink${removedCount > 1 ? 's' : ''}`, 'success')
    } catch (error) {
      console.error('Failed to remove backlink:', error)
      showToast('Failed to remove backlink', 'error')
    }
  }, [currentFile, noteTitle, showToast])

  const acceptLinkSuggestion = useCallback((suggestion: LinkSuggestion) => {
    const mentionRegex = new RegExp(`\\b${escapeRegExp(suggestion.title)}\\b`, 'i')
    const match = mentionRegex.exec(content)
    if (!match || typeof match.index !== 'number') {
      dismissLinkSuggestion(suggestion)
      return
    }
    if (isInsideWikiLink(content, match.index)) {
      dismissLinkSuggestion(suggestion)
      return
    }

    const before = getCurrentSnapshot()
    const matchedText = content.slice(match.index, match.index + match[0].length)
    const wikiLink = `[[${suggestion.targetPath}|${matchedText}]]`
    const nextContent = content.slice(0, match.index) + wikiLink + content.slice(match.index + match[0].length)

    historyRef.current = pushHistory(historyRef.current, before)
    applyContentUpdate(
      {
        content: nextContent,
        selectionStart: match.index + wikiLink.length,
        selectionEnd: match.index + wikiLink.length,
      },
      true,
    )

    persistDismissedSuggestion(suggestion.id, true)
    setDismissedLinkSuggestionIds((prev) => {
      const next = new Set(prev)
      next.add(suggestion.id)
      return next
    })
    updateRejectedTargetPreference(suggestion.path, 'clear')
    setLastLinkSuggestionAction({
      type: 'accept',
      suggestion,
      previousSnapshot: before,
    })
    showToast('Link suggestion applied', 'success')
  }, [applyContentUpdate, content, dismissLinkSuggestion, getCurrentSnapshot, persistDismissedSuggestion, showToast, updateRejectedTargetPreference])

  const resolveAndOpenInternalLink = useCallback(async (rawTarget: string) => {
    const target = normalizeVaultPath(rawTarget)
    if (!target) return

    const exact = notePathIndex.byPath.get(target) || notePathIndex.byPath.get(target.replace(/^\.\//, ''))
    if (exact) {
      await openFile(exact)
      return
    }

    const title = target.split('/').pop() || target
    const titleMatches = notePathIndex.byTitle.get(title) || []
    if (titleMatches.length > 0) {
      if (titleMatches.length === 1) {
        await openFile(titleMatches[0])
        return
      }
      setPendingLinkResolution({
        rawTarget,
        candidates: titleMatches.slice(0, 8),
      })
      return
    }

    showToast(`Linked note not found: ${rawTarget}`, 'error')
  }, [notePathIndex.byPath, notePathIndex.byTitle, openFile, showToast])

  const applyResolvedLinkCandidate = useCallback(async (candidate: string, options?: { openAfter?: boolean }) => {
    if (!pendingLinkResolution) return

    const rawTarget = pendingLinkResolution.rawTarget.trim()
    if (rawTarget) {
      const before = getCurrentSnapshot()
      const rawPattern = escapeRegExp(rawTarget)
      const wikiLinkRegex = new RegExp(`\\[\\[${rawPattern}(\\|[^\\]]+)?\\]\\]`, 'g')
      const nextContent = content.replace(wikiLinkRegex, (_full, aliasPart?: string) => {
        return aliasPart ? `[[${candidate}${aliasPart}]]` : `[[${candidate}]]`
      })

      if (nextContent !== content) {
        historyRef.current = pushHistory(historyRef.current, before)
        applyContentUpdate(
          {
            content: nextContent,
            selectionStart: before.selectionStart,
            selectionEnd: before.selectionEnd,
          },
          false,
        )
        showToast('Updated ambiguous link target in this note', 'success')
      }
    }

    setPendingLinkResolution(null)
    if (options?.openAfter !== false) {
      await openFile(candidate)
    }
  }, [applyContentUpdate, content, getCurrentSnapshot, openFile, pendingLinkResolution, showToast])

  const toggleTodoLine = useCallback((lineNumber: number) => {
    const sourceLines = content.split('\n')
    if (lineNumber < 0 || lineNumber >= sourceLines.length) return
    const row = sourceLines[lineNumber]
    const before = getCurrentSnapshot()
    if (/^\s*[-*]\s+\[x\]\s+/i.test(row)) {
      sourceLines[lineNumber] = row.replace(/\[[xX]\]/, '[ ]')
      const nextContent = sourceLines.join('\n')
      historyRef.current = pushHistory(historyRef.current, before)
      applyContentUpdate({
        content: nextContent,
        selectionStart: before.selectionStart,
        selectionEnd: before.selectionEnd,
      }, false)
      return
    }
    if (/^\s*[-*]\s+\[\s\]\s+/.test(row)) {
      sourceLines[lineNumber] = row.replace(/\[\s\]/, '[x]')
      const nextContent = sourceLines.join('\n')
      historyRef.current = pushHistory(historyRef.current, before)
      applyContentUpdate({
        content: nextContent,
        selectionStart: before.selectionStart,
        selectionEnd: before.selectionEnd,
      }, false)
    }
  }, [applyContentUpdate, content, getCurrentSnapshot])

  const renderInlineContent = useCallback((text: string): ReactNode[] => {
    const tokenRegex = /(\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s)]+|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g
    const parts = text.split(tokenRegex)

    return parts.map((part, index) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={index}>{part.slice(2, -2)}</strong>
      }
      if (part.startsWith('*') && part.endsWith('*')) {
        return <em key={index}>{part.slice(1, -1)}</em>
      }
      if (part.startsWith('`') && part.endsWith('`')) {
        return <code key={index} className="px-1 rounded bg-slate-200/80 dark:bg-slate-700/80">{part.slice(1, -1)}</code>
      }
      if (part.startsWith('[[') && part.endsWith(']]')) {
        const { target, label } = extractWikiTarget(part)
        return (
          <button
            key={index}
            type="button"
            onClick={() => void resolveAndOpenInternalLink(target)}
            className="inline text-blue-600 dark:text-blue-300 underline decoration-blue-400/60 hover:decoration-blue-500 vn-interactive"
          >
            {label}
          </button>
        )
      }
      if (/^\[[^\]]+\]\([^)]+\)$/.test(part)) {
        const match = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
        if (!match) return <span key={index}>{part}</span>
        const isLocalTarget = !/^https?:\/\//i.test(match[2]) && !match[2].startsWith('#')
        if (isLocalTarget) {
          return (
            <button
              key={index}
              type="button"
              onClick={() => void resolveAndOpenInternalLink(match[2])}
              className="inline text-cyan-600 dark:text-cyan-300 underline hover:opacity-80 vn-interactive"
            >
              {match[1]}
            </button>
          )
        }
        return (
          <a key={index} href={match[2]} target="_blank" rel="noreferrer" className="text-cyan-600 dark:text-cyan-300 underline hover:opacity-80">
            {match[1]}
          </a>
        )
      }
      if (/^https?:\/\//.test(part)) {
        return (
          <a key={index} href={part} target="_blank" rel="noreferrer" className="text-cyan-600 dark:text-cyan-300 underline hover:opacity-80">
            {part}
          </a>
        )
      }
      return <span key={index}>{part}</span>
    })
  }, [resolveAndOpenInternalLink])

  const toggleHeadingCollapsed = (headingId: string) => {
    setCollapsedHeadingIds((prev) => {
      const next = new Set(prev)
      if (next.has(headingId)) {
        next.delete(headingId)
      } else {
        next.add(headingId)
      }
      return next
    })
  }

  const jumpToHeading = useCallback((heading: HeadingItem) => {
    if (effectiveEditorViewMode === 'preview' && previewRef.current) {
      const el = previewRef.current.querySelector<HTMLElement>(`[data-heading-id="${heading.id}"]`)
      if (el) {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' })
      }
      return
    }

    if (!editorRef.current) return
    const linesToHeading = content.split('\n').slice(0, heading.line).join('\n')
    const start = linesToHeading.length + (heading.line > 0 ? 1 : 0)
    editorRef.current.focus()
    editorRef.current.setSelectionRange(start, start)

    const approxLineHeight = presentationMode ? 32 : 24
    editorRef.current.scrollTop = Math.max(0, heading.line * approxLineHeight - editorRef.current.clientHeight / 2)
  }, [content, effectiveEditorViewMode, presentationMode])

  const handleOutlineKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (headings.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOutlineActiveIndex((prev) => Math.min(prev + 1, headings.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setOutlineActiveIndex((prev) => Math.max(prev - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      jumpToHeading(headings[Math.min(outlineActiveIndex, headings.length - 1)])
    }
  }

  const handleBacklinksKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (backlinks.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setBacklinkActiveIndex((prev) => Math.min(prev + 1, backlinks.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setBacklinkActiveIndex((prev) => Math.max(prev - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const target = backlinks[Math.min(backlinkActiveIndex, backlinks.length - 1)]
      if (target) {
        void openFile(target.path).catch(() => showToast('Failed to open reference', 'error'))
      }
    }
  }

  const handleRelatedKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (relatedNotes.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setRelatedActiveIndex((prev) => Math.min(prev + 1, relatedNotes.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setRelatedActiveIndex((prev) => Math.max(prev - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const target = relatedNotes[Math.min(relatedActiveIndex, relatedNotes.length - 1)]
      if (target) {
        void openFile(target.path).catch(() => showToast('Failed to open related note', 'error'))
      }
    }
  }

  const openActiveOutlineItem = useCallback(() => {
    if (headings.length === 0) return
    const target = headings[Math.min(outlineActiveIndex, headings.length - 1)]
    if (target) jumpToHeading(target)
  }, [headings, jumpToHeading, outlineActiveIndex])

  const openActiveBacklinkItem = useCallback(() => {
    if (backlinks.length === 0) return
    const target = backlinks[Math.min(backlinkActiveIndex, backlinks.length - 1)]
    if (target) {
      void openFile(target.path).catch(() => showToast('Failed to open reference', 'error'))
    }
  }, [backlinkActiveIndex, backlinks, openFile, showToast])

  const openActiveRelatedItem = useCallback(() => {
    if (relatedNotes.length === 0) return
    const target = relatedNotes[Math.min(relatedActiveIndex, relatedNotes.length - 1)]
    if (target) {
      void openFile(target.path).catch(() => showToast('Failed to open related note', 'error'))
    }
  }, [openFile, relatedActiveIndex, relatedNotes, showToast])

  const goToAdjacentTab = useCallback((direction: 1 | -1) => {
    if (tabs.length <= 1 || !activeTabId) return
    const index = tabs.findIndex((tab) => tab.id === activeTabId)
    if (index === -1) return
    const nextIndex = (index + direction + tabs.length) % tabs.length
    switchTab(tabs[nextIndex].id)
  }, [activeTabId, switchTab, tabs])

  const updateCursorMetrics = useCallback(() => {
    if (!editorRef.current) return
    const start = editorRef.current.selectionStart
    const end = editorRef.current.selectionEnd
    lastKnownSelectionRef.current = { start, end }
    const selectedText = content.slice(start, end)
    setSelectedChars(Math.max(0, end - start))
    setSelectedWords(selectedText.trim() ? selectedText.trim().split(/\s+/).length : 0)

    const before = content.slice(0, start)
    const line = before.split('\n').length
    const col = start - before.lastIndexOf('\n')
    setCursorLine(line)
    setCursorColumn(col)

    const currentLineStart = before.lastIndexOf('\n') + 1
    const currentLineEnd = content.indexOf('\n', start)
    const lineText = content.slice(currentLineStart, currentLineEnd === -1 ? content.length : currentLineEnd)
    const slashCandidate = lineText.trim()
    if (slashCandidate.startsWith('/')) {
      setSlashOpen(true)
      setSlashQuery(slashCandidate.slice(1).toLowerCase())
    } else {
      setSlashOpen(false)
      setSlashQuery('')
    }
  }, [content])

  const capturePreInputSnapshot = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    pendingPreInputSnapshotRef.current = {
      content,
      selectionStart: editor.selectionStart,
      selectionEnd: editor.selectionEnd,
    }
  }, [content])

  const filteredSlashCommands = useMemo(() => {
    if (!slashOpen) return []
    if (!slashQuery) return SLASH_COMMANDS
    return SLASH_COMMANDS.filter((cmd) => cmd.id.includes(slashQuery) || cmd.label.includes(slashQuery))
  }, [slashOpen, slashQuery])

  const applySlashCommand = (commandId: string) => {
    if (!editorRef.current) return
    const command = SLASH_COMMANDS.find((cmd) => cmd.id === commandId)
    if (!command) return

    const start = editorRef.current.selectionStart
    const before = content.slice(0, start)
    const lineStart = before.lastIndexOf('\n') + 1
    const lineEnd = content.indexOf('\n', start)
    const end = lineEnd === -1 ? content.length : lineEnd

    const next = content.slice(0, lineStart) + command.template + content.slice(end)
    historyRef.current = pushHistory(historyRef.current, getCurrentSnapshot())
    setSlashOpen(false)
    const pos = lineStart + command.template.length
    applyContentUpdate(
      {
        content: next,
        selectionStart: pos,
        selectionEnd: pos,
      },
      true,
    )
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isInputLike =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true

      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
        if (target === editorRef.current || target === document.body) {
          event.preventDefault()
          handleUndo()
        }
        return
      }

      if (
        ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'z') ||
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y')
      ) {
        if (target === editorRef.current || target === document.body) {
          event.preventDefault()
          handleRedo()
        }
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') {
        if (activeTabId) {
          event.preventDefault()
          void closeTab(activeTabId)
        }
        return
      }

      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault()
        goToAdjacentTab(event.shiftKey ? -1 : 1)
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (currentFile || isNewNote) {
          void handleSave()
        }
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        createNewNote()
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && !event.shiftKey) {
        event.preventDefault()
        setShowInFileSearch(true)
        window.setTimeout(() => {
          fileSearchInputRef.current?.focus()
          fileSearchInputRef.current?.select()
        }, 0)
      }

      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        if (isInputLike && target !== document.body) return
        event.preventDefault()
        if (activeSidebarPanel === 'backlinks') {
          openActiveBacklinkItem()
        } else if (activeSidebarPanel === 'related') {
          openActiveRelatedItem()
        } else {
          openActiveOutlineItem()
        }
      }

      if (event.key === 'Escape') {
        if (pendingLinkResolution) {
          event.preventDefault()
          setPendingLinkResolution(null)
          return
        }
        if (showInFileSearch) {
          event.preventDefault()
          setShowInFileSearch(false)
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    activeSidebarPanel,
    applyContentUpdate,
    closeTab,
    createNewNote,
    currentFile,
    getCurrentSnapshot,
    handleRedo,
    handleSave,
    handleUndo,
    isNewNote,
    goToAdjacentTab,
    openActiveBacklinkItem,
    openActiveOutlineItem,
    activeTabId,
    pendingLinkResolution,
    showInFileSearch,
    openActiveRelatedItem,
  ])

  useEffect(() => {
    const onJumpRequest = (event: Event) => {
      const customEvent = event as CustomEvent<{ sourcePath?: string; snippet?: string }>
      const sourcePath = customEvent.detail?.sourcePath?.trim()
      const snippet = customEvent.detail?.snippet?.trim()
      if (!sourcePath || !snippet) return

      setPendingSourceJump({
        path: normalizePathForMatch(sourcePath),
        snippet,
      })
    }

    window.addEventListener('vn:jump-to-source-snippet', onJumpRequest as EventListener)
    return () => {
      window.removeEventListener('vn:jump-to-source-snippet', onJumpRequest as EventListener)
    }
  }, [])

  useEffect(() => {
    if (!pendingSourceJump || !currentFile) return
    const current = normalizePathForMatch(currentFile)
    if (current !== pendingSourceJump.path) return

    const applied = applySourceJump(pendingSourceJump.snippet)
    if (applied) {
      setPendingSourceJump(null)
    }
  }, [applySourceJump, currentFile, pendingSourceJump])

  useEffect(() => {
    let cancelled = false
    const loadPaths = async () => {
      try {
        const tree = await vaultService.getVaultTree()
        if (!cancelled) {
          setAllNotePaths(flattenTreeFilePaths(tree))
        }
      } catch {
        if (!cancelled) {
          setAllNotePaths([])
        }
      }
    }
    void loadPaths()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!currentFile) return
    setAllNotePaths((prev) => (prev.includes(currentFile) ? prev : [...prev, currentFile]))
  }, [currentFile])

  useEffect(() => {
    const tabKey = activeTabId ?? '__none__'
    if (lastLoadedFileRef.current === tabKey) return
    lastLoadedFileRef.current = tabKey
    historyRef.current = createEditorHistory(400)
    pendingSelectionRef.current = null
    lastKnownSelectionRef.current = { start: 0, end: 0 }
  }, [activeTabId])

  useEffect(() => {
    if (activeSidebarPanel !== 'backlinks' || !settledCurrentFile || !noteTitle || isPreviewTab) {
      setBacklinks([])
      setBacklinksAutoPaused(false)
      setBacklinksLoading(false)
      return
    }

    const normalizedCurrent = normalizeVaultPath(settledCurrentFile)
    const cacheKey = `${normalizedCurrent}|${noteTitle.toLowerCase()}`
    const cached = backlinksCacheRef.current.get(cacheKey)
    if (Array.isArray(cached)) {
      setBacklinks(cached)
      setBacklinksLoading(false)
      setBacklinksAutoPaused(false)
      recordPerfMetric('sidebar_backlinks_ms', startPerfTimer(), {
        cached: true,
        noteTitleLength: noteTitle.length,
        hits: cached.length,
      })
      return
    }

    let cancelled = false
    const titlePattern = escapeRegExp(noteTitle)
    const textRegex = new RegExp(`\\b${titlePattern}\\b`, 'i')

    const scan = async () => {
      const startTime = startPerfTimer()
      setBacklinksLoading(true)
      setBacklinksAutoPaused(false)
      try {
        const query = noteTitle.trim()
        if (query.length < 2) {
          if (!cancelled) {
            setBacklinks([])
            backlinksCacheRef.current.set(cacheKey, [])
          }
          return
        }

        const searchHits = await vaultService.searchNotes(query, Math.max(BACKLINK_SCAN_RESULT_LIMIT * 4, 24))
        const byPath = new Map<string, BacklinkItem>()
        for (const hit of searchHits) {
          const normalizedHitPath = normalizeVaultPath(hit.path)
          if (normalizedHitPath === normalizedCurrent) continue
          const snippet = (hit.snippet || '').replace(/\n/g, ' ').trim()
          if (!snippet || !textRegex.test(snippet)) continue
          if (!byPath.has(hit.path)) {
            byPath.set(hit.path, {
              path: hit.path,
              snippet,
            })
          }
          if (byPath.size >= BACKLINK_SCAN_RESULT_LIMIT) break
        }

        const hits = Array.from(byPath.values())

        if (!cancelled) {
          setBacklinks(hits)
          backlinksCacheRef.current.set(cacheKey, hits)
          recordPerfMetric('sidebar_backlinks_ms', startTime, {
            cached: false,
            noteTitleLength: noteTitle.length,
            hits: hits.length,
          })
        }
      } finally {
        if (!cancelled) {
          setBacklinksLoading(false)
        }
      }
    }

    const timer = window.setTimeout(() => {
      void scan()
    }, 300)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activeSidebarPanel, isPreviewTab, noteTitle, settledCurrentFile])

  useEffect(() => {
    if (activeSidebarPanel !== 'related' || !settledCurrentFile || isPreviewTab) {
      setRelatedNotes([])
      setRelatedError(null)
      setRelatedLoading(false)
      return
    }

    let cancelled = false
    const load = async () => {
      const startTime = startPerfTimer()
      setRelatedLoading(true)
      setRelatedError(null)
      try {
        const suggestions = await relatedNotesService.getRelatedNotes(settledCurrentFile)
        if (!cancelled) {
          setRelatedNotes(suggestions)
          recordPerfMetric('sidebar_related_ms', startTime, {
            hits: suggestions.length,
          })
        }
      } catch (error) {
        if (!cancelled) {
          setRelatedNotes([])
          setRelatedError(error instanceof Error ? error.message : 'Could not load related notes')
        }
      } finally {
        if (!cancelled) {
          setRelatedLoading(false)
        }
      }
    }

    const timer = window.setTimeout(() => {
      void load()
    }, 180)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activeSidebarPanel, isPreviewTab, settledCurrentFile])

  useEffect(() => {
    setOutlineActiveIndex((prev) => Math.min(prev, Math.max(0, headings.length - 1)))
  }, [headings.length])

  useEffect(() => {
    setBacklinkActiveIndex((prev) => Math.min(prev, Math.max(0, backlinks.length - 1)))
  }, [backlinks.length])

  useEffect(() => {
    setRelatedActiveIndex((prev) => Math.min(prev, Math.max(0, relatedNotes.length - 1)))
  }, [relatedNotes.length])

  useEffect(() => {
    const pending = pendingSelectionRef.current
    if (!pending || !editorRef.current) return
    window.requestAnimationFrame(() => {
      if (!editorRef.current) return
      if (pending.focus) {
        editorRef.current.focus()
      }
      editorRef.current.setSelectionRange(pending.start, pending.end)
      updateCursorMetrics()
      pendingSelectionRef.current = null
    })
  }, [content, updateCursorMetrics])

  const renderCode = (code: string, lang: string) => {
    const linesList = code.split('\n')
    return (
      <div className="rounded-xl border border-slate-300/70 dark:border-slate-600/80 overflow-hidden bg-slate-950 text-slate-100">
        <div className="flex items-center justify-between px-3 py-2 bg-slate-900 border-b border-slate-700 text-xs">
          <span className="uppercase tracking-wide text-slate-300">{lang}</span>
          <button
            onClick={() => navigator.clipboard.writeText(code).then(() => showToast('Code copied', 'success'))}
            className="px-2 py-1 rounded-md bg-slate-700 hover:bg-slate-600 text-slate-100 vn-interactive"
          >
            Copy
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <tbody>
              {linesList.map((row, index) => (
                <tr key={index} className="align-top">
                  <td className="select-none text-right pr-3 pl-2 text-slate-500 w-10 border-r border-slate-800">{index + 1}</td>
                  <td className="px-3 py-0.5 font-mono whitespace-pre">{highlightCodeLine(row, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  const renderCallout = (block: ParsedBlock) => {
    const styles: Record<CalloutType, string> = {
      info: 'border-blue-300/70 bg-blue-100/70 dark:border-blue-700 dark:bg-blue-900/20',
      warning: 'border-amber-300/70 bg-amber-100/70 dark:border-amber-700 dark:bg-amber-900/20',
      idea: 'border-violet-300/70 bg-violet-100/70 dark:border-violet-700 dark:bg-violet-900/20',
      todo: 'border-emerald-300/70 bg-emerald-100/70 dark:border-emerald-700 dark:bg-emerald-900/20',
    }
    const type = block.calloutType || 'info'
    const title = block.calloutTitle || type
    return (
      <div className={`rounded-xl border p-3 ${styles[type]}`}>
        <div className="text-xs uppercase tracking-wide font-semibold mb-1">{title}</div>
        <div className="text-sm whitespace-pre-wrap">{renderInlineContent(block.text || '')}</div>
      </div>
    )
  }

  const renderHeadingText = (level: number, text: ReactNode) => {
    const clamped = Math.min(6, Math.max(1, level))
    const headingSize = presentationMode
      ? ['text-5xl', 'text-4xl', 'text-3xl', 'text-2xl', 'text-xl', 'text-lg'][clamped - 1]
      : ['text-3xl', 'text-2xl', 'text-xl', 'text-lg', 'text-base', 'text-sm'][clamped - 1]
    const className = `font-bold tracking-tight ${headingSize}`

    switch (clamped) {
      case 1:
        return <h1 className={className}>{text}</h1>
      case 2:
        return <h2 className={className}>{text}</h2>
      case 3:
        return <h3 className={className}>{text}</h3>
      case 4:
        return <h4 className={className}>{text}</h4>
      case 5:
        return <h5 className={className}>{text}</h5>
      default:
        return <h6 className={className}>{text}</h6>
    }
  }

  const renderBlockQuickActions = useCallback((block: ParsedBlock) => {
    const parsedIndex = parsedBlockIndexById.get(block.id) ?? -1
    if (parsedIndex < 0) return null
    const canMoveUp = parsedIndex > 0
    const canMoveDown = parsedIndex < parsedBlocks.length - 1

    return (
      <div className="absolute right-2 top-2 z-10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
        <div className="inline-flex items-center rounded-md border border-slate-300/80 dark:border-slate-600/80 bg-white/90 dark:bg-slate-900/85 shadow-sm overflow-hidden">
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              moveBlock(block.id, -1)
            }}
            disabled={!canMoveUp}
            title="Move block up"
            className="px-1.5 py-1 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed vn-interactive"
          >
            Up
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              moveBlock(block.id, 1)
            }}
            disabled={!canMoveDown}
            title="Move block down"
            className="px-1.5 py-1 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border-l border-slate-200 dark:border-slate-700 disabled:opacity-40 disabled:cursor-not-allowed vn-interactive"
          >
            Down
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              duplicateBlock(block.id)
            }}
            title="Duplicate block"
            className="px-1.5 py-1 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border-l border-slate-200 dark:border-slate-700 vn-interactive"
          >
            Dup
          </button>
        </div>
      </div>
    )
  }, [duplicateBlock, moveBlock, parsedBlockIndexById, parsedBlocks.length])

  const isWriterStyleEditor = effectiveEditorViewMode === 'edit' || effectiveEditorViewMode === 'split'

  const editorTypographyClass = presentationMode
    ? 'text-[20px] leading-[2rem]'
    : readingMode
      ? 'text-[16px] leading-8'
      : isWriterStyleEditor
        ? 'text-[16px] leading-6'
        : 'text-sm leading-6'

  const previewTypographyClass = presentationMode
    ? 'text-[20px] leading-[2rem]'
    : readingMode
      ? 'text-[16px] leading-8'
      : 'text-sm leading-6'

  const editorPane = (
    <div className="h-full relative overflow-hidden">
      {showInFileSearch && (
        <div className="border-b border-slate-200 dark:border-slate-700 px-4 py-2 flex flex-wrap items-center gap-2 bg-white/60 dark:bg-slate-900/40">
          <svg className="w-4 h-4 text-slate-500 dark:text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.3-4.3M10.8 18a7.2 7.2 0 100-14.4 7.2 7.2 0 000 14.4z" />
          </svg>
          <input
            ref={fileSearchInputRef}
            value={inFileQuery}
            onChange={(e) => {
              setInFileQuery(e.target.value)
              setCurrentMatchIndex(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault()
                goToPreviousMatch()
                return
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                goToNextMatch()
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setShowInFileSearch(false)
              }
            }}
            placeholder="Find in current file..."
            className="min-w-[220px] flex-[1_1_260px] px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-slate-100 focus:outline-none vn-focusable"
          />
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <span className="text-xs vn-muted min-w-[56px] text-right flex-shrink-0">
              {inFileMatches.length === 0 ? '0 results' : `${activeMatchIndex + 1}/${inFileMatches.length}`}
            </span>
            <button
              onClick={goToPreviousMatch}
              disabled={inFileMatches.length === 0}
              className="h-8 w-8 rounded-lg bg-slate-200 dark:bg-slate-700 disabled:opacity-50 flex items-center justify-center flex-shrink-0 vn-focusable vn-interactive"
              title="Previous match"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <button
              onClick={goToNextMatch}
              disabled={inFileMatches.length === 0}
              className="h-8 w-8 rounded-lg bg-slate-200 dark:bg-slate-700 disabled:opacity-50 flex items-center justify-center flex-shrink-0 vn-focusable vn-interactive"
              title="Next match"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <button
              onClick={() => setShowInFileSearch(false)}
              className="h-8 w-8 rounded-lg bg-slate-200 dark:bg-slate-700 flex items-center justify-center flex-shrink-0 vn-focusable vn-interactive"
              title="Close search"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            {focusMode && (
              <button
                onClick={() => setFocusMode(false)}
                className="h-8 px-3 rounded-lg text-xs font-semibold bg-slate-200/90 dark:bg-slate-700/90 text-slate-800 dark:text-slate-100 backdrop-blur-sm flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap vn-interactive vn-focusable"
                title="Exit focus mode"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M15 19l-7-7 7-7" />
                </svg>
                Exit Focus
              </button>
            )}
          </div>
        </div>
      )}

      <div className={`relative h-full ${isWriterStyleEditor ? 'bg-slate-50/30 dark:bg-slate-900/20' : ''}`}>
        <textarea
          ref={editorRef}
          value={content}
          onChange={(e) => handleEditorChange(e.target.value, e.target.selectionStart, e.target.selectionEnd)}
          onBeforeInput={capturePreInputSnapshot}
          onKeyDown={capturePreInputSnapshot}
          onPaste={capturePreInputSnapshot}
          onCut={capturePreInputSnapshot}
          onClick={updateCursorMetrics}
          onKeyUp={updateCursorMetrics}
          onSelect={updateCursorMetrics}
          style={{ height: '100%', width: '100%' }}
          className={`vn-editor-textarea ${isWriterStyleEditor ? 'vn-editor-writer font-sans' : 'font-mono'} p-6 bg-transparent text-slate-900 dark:text-slate-100 resize-none focus:outline-none vn-focusable ${editorTypographyClass} border-none placeholder:text-slate-400 dark:placeholder:text-slate-500`}
          placeholder="Start writing..."
          disabled={isSaving}
          autoFocus
          spellCheck={isWriterStyleEditor}
        />

        {slashOpen && filteredSlashCommands.length > 0 && (
          <div className="absolute top-2 right-2 w-56 vn-surface rounded-xl shadow-xl p-1 z-20">
            {filteredSlashCommands.map((cmd) => (
              <button
                key={cmd.id}
                onClick={() => applySlashCommand(cmd.id)}
                className="w-full text-left px-2 py-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 text-sm vn-interactive"
              >
                <span className="font-semibold">{cmd.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )

  const filePreviewPane = (
    <div className="h-full overflow-auto p-6">
      <div className={`mx-auto ${readingMode ? 'max-w-4xl' : 'max-w-none'} min-h-full`}>
        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white/70 dark:bg-slate-900/50 shadow-sm min-h-full overflow-hidden flex flex-col">
          <div className="border-b border-slate-200 dark:border-slate-700 px-4 py-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {previewData?.kind === 'image'
                  ? 'Image Preview'
                  : previewData?.kind === 'pdf'
                    ? 'PDF Preview'
                    : previewData?.kind === 'pptx'
                      ? 'PPTX Preview'
                      : previewData?.kind === 'xlsx'
                        ? 'XLSX Preview'
                        : 'DOCX Preview'}
              </p>
              <p className="text-xs vn-muted mt-1">
                {previewData?.mime_type || 'Preview available'}
                {typeof previewData?.size_bytes === 'number' ? ` • ${previewData.size_bytes.toLocaleString()} bytes` : ''}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className={`text-[10px] px-2 py-1 rounded-full font-semibold ${capabilityMeta.capabilityTone}`}>
                {capabilityMeta.capabilityLabel}
              </span>
              {previewData?.message && <p className="text-xs vn-muted max-w-xs text-right">{previewData.message}</p>}
            </div>
          </div>

          <div className="flex-1 min-h-[420px]">
            {previewData?.kind === 'image' && previewData.data_url && (
              <div className="h-full w-full flex items-center justify-center bg-slate-950/70 p-6">
                <img
                  src={previewData.data_url}
                  alt={noteTitle}
                  className="max-w-full max-h-full object-contain rounded-xl shadow-2xl"
                />
              </div>
            )}

            {previewData?.kind === 'pdf' && previewData.data_url && (
              <div className="flex h-full min-h-[72vh] flex-col">
                <div className="px-4 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50/90 dark:bg-slate-800/40 text-xs text-slate-700 dark:text-slate-300">
                  Search, Q&amp;A, and embeddings can use extracted PDF text when available.
                </div>
                <iframe
                  src={previewData.data_url}
                  title={noteTitle}
                  className="block min-h-[68vh] w-full flex-1 bg-white"
                  allowFullScreen
                />
              </div>
            )}

            {previewData && ['docx', 'pptx', 'xlsx'].includes(previewData.kind) && (
              <div className={`h-full overflow-y-auto p-6 ${previewTypographyClass}`}>
                <div className={`mx-auto ${readingMode ? 'max-w-3xl' : 'max-w-4xl'} space-y-4`}>
                  <div className="rounded-xl border border-sky-200 dark:border-sky-800 bg-sky-50/90 dark:bg-sky-950/20 px-4 py-3 text-sm text-sky-800 dark:text-sky-200">
                    This {previewData.kind.toUpperCase()} file is previewed from extracted text, and that same extracted text is used for search, Q&amp;A, and embeddings.
                  </div>
                  {previewData.text ? (
                    <div className="whitespace-pre-wrap text-slate-800 dark:text-slate-100">
                      {previewData.text}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-amber-300/60 dark:border-amber-700/70 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
                      This {previewData.kind.toUpperCase()} file could not be converted into readable text yet. It will stay preview-only until extraction succeeds.
                    </div>
                  )}
                </div>
              </div>
            )}

            {!previewData && (
              <div className="h-full flex items-center justify-center p-6">
                <div className="rounded-xl border border-amber-300/60 dark:border-amber-700/70 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-200 max-w-md text-center">
                  Preview is not available for this file yet.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )

  const previewPane = (
    <div ref={previewRef} className={`h-full overflow-y-auto p-6 ${previewTypographyClass}`}>
      <div className={`mx-auto ${readingMode ? 'max-w-3xl' : 'max-w-none'} space-y-4`}>
        {visibleBlocks.map((block) => {
          if (block.type === 'heading') {
            const level = Math.min(6, Math.max(1, block.level || 1))
            return (
              <div key={block.id} className="group relative" data-heading-id={block.headingId}>
                {renderBlockQuickActions(block)}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => block.headingId && toggleHeadingCollapsed(block.headingId)}
                    className="w-5 h-5 rounded bg-slate-200 dark:bg-slate-700 text-xs"
                    title="Collapse section"
                  >
                    {block.headingId && collapsedHeadingIds.has(block.headingId) ? '+' : '-'}
                  </button>
                  {renderHeadingText(level, renderInlineContent(block.text || 'Untitled'))}
                </div>
              </div>
            )
          }

          if (block.type === 'code') {
            return (
              <div key={block.id} className="group relative">
                {renderBlockQuickActions(block)}
                {renderCode(block.text || '', block.language || 'txt')}
              </div>
            )
          }

          if (block.type === 'quote') {
            return (
              <div key={block.id} className="group relative">
                {renderBlockQuickActions(block)}
                <blockquote className="border-l-4 border-slate-300 dark:border-slate-600 pl-4 italic text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
                  {renderInlineContent(block.text || '')}
                </blockquote>
              </div>
            )
          }

          if (block.type === 'rule') {
            return (
              <div key={block.id} className="group relative py-1">
                {renderBlockQuickActions(block)}
                <hr className="border-0 h-px bg-gradient-to-r from-transparent via-slate-400/60 dark:via-slate-500/70 to-transparent" />
              </div>
            )
          }

          if (block.type === 'callout') {
            return (
              <div key={block.id} className="group relative">
                {renderBlockQuickActions(block)}
                {renderCallout(block)}
              </div>
            )
          }

          if (block.type === 'todo') {
            return (
              <div key={block.id} className="group relative">
                {renderBlockQuickActions(block)}
                <ul className="space-y-1">
                  {(block.items || []).map((item, idx) => {
                    const checked = /\[[xX]\]/.test(item)
                    const label = item.replace(/^\s*[-*]\s+\[[ xX]\]\s+/, '')
                    return (
                      <li key={idx} className="flex items-start gap-2">
                        <button
                          type="button"
                          onClick={() => toggleTodoLine(block.startLine + idx)}
                          className="text-base leading-none mt-0.5 vn-interactive"
                          title="Toggle task"
                        >
                          {checked ? '☑' : '☐'}
                        </button>
                        <span className={checked ? 'line-through opacity-70' : ''}>{renderInlineContent(label)}</span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          }

          if (block.type === 'table') {
            const tableRows = (block.items || []).map(splitTableRow)
            const header = tableRows[0] || []
            const separator = (block.items || [])[1] || ''
            const alignments = parseTableAlignments(separator, header.length)
            const body = tableRows.slice(2)
            const alignClassFor = (index: number) => {
              const align = alignments[index] || 'left'
              if (align === 'center') return 'text-center'
              if (align === 'right') return 'text-right'
              return 'text-left'
            }
            return (
              <div key={block.id} className="group relative">
                {renderBlockQuickActions(block)}
                <div className="overflow-x-auto rounded-xl border border-slate-300/70 dark:border-slate-600/70">
                  <table className="w-full text-sm border-collapse">
                    <thead className="bg-slate-100/80 dark:bg-slate-800/70">
                      <tr>
                        {header.map((cell, idx) => (
                          <th key={idx} className={`${alignClassFor(idx)} font-semibold px-3 py-2 border-b border-slate-300/70 dark:border-slate-600/70`}>
                            {renderInlineContent(cell)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {body.map((row, rowIdx) => (
                        <tr key={rowIdx} className="even:bg-slate-50/60 dark:even:bg-slate-800/30">
                          {row.map((cell, cellIdx) => (
                            <td key={cellIdx} className={`${alignClassFor(cellIdx)} px-3 py-2 border-t border-slate-200/70 dark:border-slate-700/70 align-top`}>
                              {renderInlineContent(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          }

          if (block.type === 'list') {
            return (
              <div key={block.id} className="group relative">
                {renderBlockQuickActions(block)}
                <ul className="list-disc ml-6 space-y-1">
                  {(block.items || []).map((item, idx) => (
                    <li key={idx}>{renderInlineContent(item.replace(/^\s*[-*]\s+/, '').replace(/^\s*\d+[.)]\s+/, ''))}</li>
                  ))}
                </ul>
              </div>
            )
          }

          return (
            <div key={block.id} className="group relative">
              {renderBlockQuickActions(block)}
              <p className="whitespace-pre-wrap text-slate-800 dark:text-slate-100">
                {renderInlineContent(block.text || block.raw)}
              </p>
            </div>
          )
        })}
      </div>
    </div>
  )

  const viewContainer = () => {
    if (isPreviewTab) {
      return <div className="h-full">{filePreviewPane}</div>
    }
    if (effectiveEditorViewMode === 'edit') {
      return <div className="h-full">{editorPane}</div>
    }
    if (effectiveEditorViewMode === 'preview') {
      return <div className="h-full">{previewPane}</div>
    }
    return (
      <div className="h-full min-h-0 grid grid-cols-2 divide-x divide-slate-200 dark:divide-slate-700 overflow-hidden">
        <div className="h-full min-h-0 overflow-hidden">{editorPane}</div>
        <div className="h-full min-h-0 overflow-hidden">{previewPane}</div>
      </div>
    )
  }

  if (!currentFile && !isNewNote) {
    return (
      <main className="flex-1 overflow-y-auto bg-transparent">
        <div className="h-full flex items-center justify-center">
          <div className="text-center px-6 py-8 rounded-2xl vn-glass vn-panel-enter">
            <svg className="w-16 h-16 text-blue-500/60 dark:text-blue-300/60 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <h2 className="text-2xl font-semibold text-slate-900 dark:text-white mb-2">Welcome to Pipnote</h2>
            <p className="text-slate-600 dark:text-slate-300">Select a note to get started</p>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className={`h-full w-full bg-transparent flex flex-col relative ${presentationMode ? 'text-lg' : ''}`}>
      {isSaving && (
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="vn-surface rounded-2xl p-6 shadow-xl max-w-sm w-full mx-4 vn-panel-enter">
            <div className="flex items-center space-x-4">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
              <div>
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-1">{isNewNote ? 'Classifying & Saving...' : 'Saving...'}</h3>
                <p className="text-sm text-slate-600 dark:text-slate-300">{isNewNote ? 'AI is analyzing your note' : 'Please wait'}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {!focusMode && tabs.length > 0 && (
        <div className="border-b border-slate-200 dark:border-slate-700 bg-slate-100/60 dark:bg-slate-900/40 px-2 py-0.5 pr-16">
          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId
              const tabTitle = displayDocumentTitle(tab.filePath, tab.isNewNote)
              const tabDirty = tab.content !== tab.originalContent

              return (
                <button
                  key={tab.id}
                  onClick={() => switchTab(tab.id)}
                  className={`group flex items-center gap-2 min-w-0 max-w-[220px] px-3 py-1 rounded-md text-xs border transition-colors vn-interactive ${
                    isActive
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border-blue-400/70'
                      : 'bg-slate-200/70 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300 border-transparent hover:bg-slate-200 dark:hover:bg-slate-700'
                  }`}
                  title={tab.filePath ?? 'New note'}
                >
                  <span className="truncate">{tabTitle}</span>
                  {tabDirty && <span className="text-amber-500 text-[10px]">●</span>}
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      event.stopPropagation()
                      void closeTab(tab.id)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        event.stopPropagation()
                        void closeTab(tab.id)
                      }
                    }}
                    className={`h-4 w-4 rounded flex items-center justify-center text-[10px] ${
                      isActive
                        ? 'text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700'
                        : 'text-slate-400 hover:bg-slate-300/70 dark:hover:bg-slate-700'
                    }`}
                    aria-label={`Close ${tabTitle}`}
                  >
                    ×
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {!focusMode && (
        <>
          <div className="border-b border-slate-200 dark:border-slate-700 px-5 py-2.5 flex items-center justify-between flex-shrink-0 bg-gradient-to-r from-blue-50/80 to-sky-50/60 dark:from-slate-900 dark:to-slate-800">
            <div className="min-w-0">
              {isEditingTitle ? (
                <input
                  ref={titleInputRef}
                  type="text"
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onBlur={() => void submitTitleRename()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void submitTitleRename()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      cancelTitleRename()
                    }
                  }}
                  className="w-full max-w-[65ch] text-[1.05rem] font-semibold text-slate-900 dark:text-white bg-white/80 dark:bg-slate-800/70 border border-blue-400 rounded px-2 py-1 outline-none vn-focusable"
                />
              ) : (
                <button
                  type="button"
                  onClick={beginTitleRename}
                  className="text-left text-[1.05rem] leading-tight font-semibold text-slate-900 dark:text-white truncate max-w-[65ch] rounded px-1 -mx-1 hover:bg-slate-200/50 dark:hover:bg-slate-700/50 vn-focusable"
                  title={isNewNote ? 'Save note to rename title' : 'Click to rename'}
                >
                  {noteTitle}
                </button>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] vn-muted">
                <span className="truncate max-w-[40ch]">{parentPath}</span>
                <span>•</span>
                {isPreviewTab ? (
                  <span>{previewData?.kind?.toUpperCase() || 'Preview'} file</span>
                ) : (
                  <>
                    <span>{words} words</span>
                    <span>•</span>
                    <span>{readTime} min read</span>
                  </>
                )}
                <span className="text-[10px] px-2 py-1 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 font-semibold">
                  {capabilityMeta.typeLabel}
                </span>
                <span className={`text-[10px] px-2 py-1 rounded-full font-semibold ${capabilityMeta.capabilityTone}`}>
                  {capabilityMeta.capabilityLabel}
                </span>
                {isPreviewTab && previewData?.message && (
                  <span className="text-[10px] px-2 py-1 rounded-full bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300 font-medium">
                    Extraction available
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleToggleFavorite}
                className={`h-8 w-8 rounded-lg flex items-center justify-center border vn-focusable vn-interactive ${
                  isFavorite
                    ? 'bg-amber-100 border-amber-300 text-amber-700 dark:bg-amber-900/30 dark:border-amber-700 dark:text-amber-300'
                    : 'bg-slate-200 dark:bg-slate-700 border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-200'
                }`}
                title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              >
                {isFavorite ? '★' : '☆'}
              </button>
              <div className="w-8"></div>
            </div>
          </div>

          <div className="border-b border-slate-200 dark:border-slate-700 px-4 py-1.5 flex flex-wrap items-center gap-2 bg-white/50 dark:bg-slate-900/30">
            <div className="inline-flex rounded-lg border border-slate-300 dark:border-slate-600 overflow-hidden">
              {(['edit', 'preview', 'split'] as EditorViewMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => !isPreviewTab && setEditorViewMode(mode)}
                  disabled={isPreviewTab}
                  className={`px-3 py-1 text-xs font-semibold ${
                    effectiveEditorViewMode === mode
                      ? 'bg-blue-600 text-white'
                      : 'bg-transparent text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                  } ${isPreviewTab ? 'cursor-not-allowed opacity-50' : ''}`}
                >
                  {mode === 'edit' ? 'Edit' : mode === 'preview' ? 'Preview' : 'Split'}
                </button>
              ))}
            </div>

            {isPreviewTab ? (
              <div className="px-3 py-1 rounded-lg bg-slate-200/80 dark:bg-slate-700/70 text-xs vn-muted">
                Preview only
              </div>
            ) : (
              <>
                <button onClick={() => runFormattingAction('bold')} className="px-2 py-1 rounded bg-slate-200 dark:bg-slate-700 text-xs vn-interactive"><b>B</b></button>
                <button onClick={() => runFormattingAction('italic')} className="px-2 py-1 rounded bg-slate-200 dark:bg-slate-700 text-xs vn-interactive"><i>I</i></button>
                <button onClick={() => runFormattingAction('h1')} className="px-2 py-1 rounded bg-slate-200 dark:bg-slate-700 text-xs vn-interactive">H1</button>
                <button onClick={() => runFormattingAction('todo')} className="px-2 py-1 rounded bg-slate-200 dark:bg-slate-700 text-xs vn-interactive">Todo</button>
                <button onClick={() => runFormattingAction('code')} className="px-2 py-1 rounded bg-slate-200 dark:bg-slate-700 text-xs vn-interactive">Code</button>
                <button onClick={() => runFormattingAction('quote')} className="px-2 py-1 rounded bg-slate-200 dark:bg-slate-700 text-xs vn-interactive">Quote</button>
              </>
            )}

            <div className="ml-auto flex items-center gap-2">
              <button onClick={() => setReadingMode((prev) => !prev)} className={`px-2 py-1 rounded text-xs ${readingMode ? 'bg-blue-600 text-white' : 'bg-slate-200 dark:bg-slate-700'}`}>Reading</button>
              <button onClick={() => setFocusMode((prev) => !prev)} className={`px-2 py-1 rounded text-xs ${focusMode ? 'bg-blue-600 text-white' : 'bg-slate-200 dark:bg-slate-700'}`}>Focus</button>
              <button onClick={() => setPresentationMode((prev) => !prev)} className={`px-2 py-1 rounded text-xs ${presentationMode ? 'bg-blue-600 text-white' : 'bg-slate-200 dark:bg-slate-700'}`}>Present</button>
            </div>
          </div>
        </>
      )}

      <div ref={contentAreaRef} className="flex-1 min-h-0 flex overflow-hidden relative">
        <div className="flex-1 min-w-0">{viewContainer()}</div>

        {!focusMode && !isPreviewTab && isRightSidebarVisible && (
          <>
            <div className="relative flex items-stretch">
              <button
                type="button"
                onMouseDown={startRightSidebarResize}
                className="group relative w-2 cursor-col-resize bg-transparent hover:bg-blue-500/6 active:bg-blue-500/10 vn-focusable"
                title="Resize right panel"
                aria-label="Resize right panel"
              >
                <span className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-slate-300/80 dark:bg-slate-700/80 group-hover:bg-blue-500/70" />
              </button>
              <button
                type="button"
                onClick={() => setIsRightSidebarVisible(false)}
                className="absolute top-3 -left-3 z-20 h-6 w-6 rounded-full border border-slate-300 dark:border-slate-700 bg-white/90 dark:bg-slate-900/90 text-slate-600 dark:text-slate-300 shadow-sm flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-800 vn-focusable"
                title="Hide right panel"
                aria-label="Hide right panel"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            </div>
            <aside
              className="border-l border-slate-200 dark:border-slate-700 bg-white/40 dark:bg-slate-900/30 overflow-y-auto flex-shrink-0"
              style={{ width: `${rightSidebarWidth}px` }}
            >
            <div className="p-3 border-b border-slate-200 dark:border-slate-700 bg-white/70 dark:bg-slate-900/40">
              <div className="flex items-center justify-between gap-2 mb-2">
                <h4 className="text-[11px] uppercase tracking-wide font-semibold text-slate-700 dark:text-slate-200">Link Suggestions</h4>
                <div className="flex items-center gap-1.5">
                  {linkSuggestions.length > 0 && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200">
                      {linkSuggestions.length} strong
                    </span>
                  )}
                  {(dismissedLinkSuggestionIds.size > 0 || Object.keys(rejectedLinkTargets).length > 0) && (
                    <button
                      onClick={() => {
                        const pathKey = currentFile ? normalizeVaultPath(currentFile) : ''
                        setDismissedLinkSuggestionIds(new Set())
                        if (pathKey) {
                          const storage = readDismissedLinkSuggestions()
                          delete storage[pathKey]
                          writeDismissedLinkSuggestions(storage)
                        }
                        setRejectedLinkTargets({})
                        writeRejectedLinkTargets({})
                        setLastLinkSuggestionAction(null)
                        showToast('Cleared remembered link suggestion preferences', 'success')
                      }}
                      className="text-[9px] px-1.5 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 vn-focusable vn-interactive"
                    >
                      Reset hidden
                    </button>
                  )}
                </div>
              </div>
              {lastLinkSuggestionAction && (
                <div className="mb-2 rounded-lg border border-sky-200 dark:border-sky-800 bg-sky-50/90 dark:bg-sky-900/20 p-2">
                  <p className="text-[10px] text-sky-800 dark:text-sky-200 leading-relaxed">
                    {lastLinkSuggestionAction.type === 'accept' ? 'Applied link suggestion.' : 'Dismissed link suggestion.'}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={undoLastLinkSuggestionAction}
                      className="px-2 py-1 rounded-md bg-sky-600 hover:bg-sky-700 text-white text-[10px] font-semibold vn-focusable vn-interactive"
                    >
                      Undo
                    </button>
                    <button
                      onClick={() => setLastLinkSuggestionAction(null)}
                      className="px-2 py-1 rounded-md bg-slate-200 dark:bg-slate-700 text-[10px] text-slate-700 dark:text-slate-200 vn-focusable vn-interactive"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}
              {linkSuggestions.length === 0 && (
                <div className="rounded-lg border border-dashed border-slate-200 dark:border-slate-700 px-3 py-3">
                  <p className="text-[11px] font-medium text-slate-800 dark:text-slate-100">No inline link suggestions right now.</p>
                  <p className="mt-1 text-[10px] vn-muted">
                    This usually means the note is already well linked, is still too short, or there is not enough high-confidence overlap with other notes yet.
                  </p>
                </div>
              )}
              <div className="space-y-2">
                {linkSuggestions.map((suggestion) => (
                  <div
                    key={suggestion.id}
                    className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/60 p-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold text-slate-800 dark:text-slate-100 truncate">{displayNotePath(suggestion.path)}</p>
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold whitespace-nowrap ${confidenceBadgeClass(suggestion.confidence)}`}>
                        {suggestion.confidence}
                      </span>
                    </div>
                    {suggestion.reasonTags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {suggestion.reasonTags.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="px-1.5 py-0.5 rounded-full bg-slate-200/90 dark:bg-slate-700/80 text-[9px] font-medium text-slate-700 dark:text-slate-200"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="text-[10px] vn-muted mt-1 line-clamp-2">{suggestion.reason}</p>
                    <p className="text-[9px] vn-muted mt-1">{Math.round(suggestion.score * 100)}% match</p>
                    <div className="mt-2 flex items-center gap-1.5">
                      <button
                        onClick={() => acceptLinkSuggestion(suggestion)}
                        className="px-2 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-semibold vn-focusable vn-interactive"
                      >
                        Accept
                      </button>
                      <button
                        onClick={() => dismissLinkSuggestion(suggestion)}
                        className="px-2 py-1 rounded-md bg-slate-200 dark:bg-slate-700 text-[10px] text-slate-700 dark:text-slate-200 vn-focusable vn-interactive"
                      >
                        Dismiss
                      </button>
                      <button
                        onClick={() => void openFile(suggestion.path).catch(() => showToast('Failed to open suggested note', 'error'))}
                        className="px-2 py-1 rounded-md bg-slate-200 dark:bg-slate-700 text-[10px] text-slate-700 dark:text-slate-200 vn-focusable vn-interactive"
                      >
                        Open
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="sticky top-0 z-10 bg-white/80 dark:bg-slate-900/70 backdrop-blur px-3 py-2 border-b border-slate-200 dark:border-slate-700">
              <h4 className="text-[11px] uppercase tracking-wide font-semibold text-slate-700 dark:text-slate-200">Outline</h4>
            </div>
            <div className="p-3 space-y-1">
              <div
                tabIndex={0}
                onKeyDown={handleOutlineKeyDown}
                onFocus={() => setActiveSidebarPanel('outline')}
                onClick={() => setActiveSidebarPanel('outline')}
                className="rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400/70"
              >
                {headings.length === 0 && (
                  <div className="rounded-lg border border-dashed border-slate-200 dark:border-slate-700 px-3 py-3">
                    <p className="text-[11px] font-medium text-slate-800 dark:text-slate-100">No headings yet.</p>
                    <p className="mt-1 text-[10px] vn-muted">
                      Add headings like <span className="font-mono">#</span>, <span className="font-mono">##</span>, or use the toolbar so this outline becomes clickable.
                    </p>
                  </div>
                )}
                {headings.map((heading, idx) => (
                  <button
                    key={heading.id}
                    onClick={() => {
                      setActiveSidebarPanel('outline')
                      setOutlineActiveIndex(idx)
                      jumpToHeading(heading)
                    }}
                    className={`w-full text-left text-[13px] px-2 py-1 rounded vn-interactive ${outlineActiveIndex === idx ? 'bg-blue-100 dark:bg-blue-900/30' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                    style={{ paddingLeft: `${Math.max(8, heading.level * 10)}px` }}
                  >
                    <span className="mr-1 text-[10px]">{collapsedHeadingIds.has(heading.id) ? '▸' : '▾'}</span>
                    {heading.text}
                  </button>
                ))}
              </div>
            </div>

            <div className="sticky top-[36px] z-10 bg-white/80 dark:bg-slate-900/70 backdrop-blur px-3 py-2 border-y border-slate-200 dark:border-slate-700 mt-3">
              <h4 className="text-[11px] uppercase tracking-wide font-semibold text-slate-700 dark:text-slate-200">Backlinks</h4>
            </div>
            <div className="p-3 space-y-2">
              <div
                tabIndex={0}
                onKeyDown={handleBacklinksKeyDown}
                onFocus={() => setActiveSidebarPanel('backlinks')}
                onClick={() => setActiveSidebarPanel('backlinks')}
                className="rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400/70"
              >
                {backlinksLoading && (
                  <div className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-3">
                    <p className="text-[11px] font-medium text-slate-800 dark:text-slate-100">Scanning vault for references…</p>
                    <p className="mt-1 text-[10px] vn-muted">
                      Pipnote is checking other notes for mentions of this file title and linked references.
                    </p>
                  </div>
                )}
                {!backlinksLoading && backlinksAutoPaused && (
                  <div className="rounded-lg border border-dashed border-slate-200 dark:border-slate-700 px-3 py-3">
                    <p className="text-[11px] font-medium text-slate-800 dark:text-slate-100">Backlink auto-scan is paused.</p>
                    <p className="mt-1 text-[10px] vn-muted">
                      This happens on larger vaults to keep navigation responsive. Backlinks will still appear when the app has enough idle time.
                    </p>
                  </div>
                )}
                {!backlinksLoading && !backlinksAutoPaused && backlinks.length === 0 && (
                  <div className="rounded-lg border border-dashed border-slate-200 dark:border-slate-700 px-3 py-3">
                    <p className="text-[11px] font-medium text-slate-800 dark:text-slate-100">No backlinks found yet.</p>
                    <p className="mt-1 text-[10px] vn-muted">
                      No other note currently references this one by title or link. Once you mention it elsewhere, it will show up here.
                    </p>
                  </div>
                )}
                {backlinks.map((item, idx) => (
                  <div
                    key={`${item.path}-${idx}`}
                    className={`w-full text-left p-2 rounded-lg border vn-interactive mb-2 ${backlinkActiveIndex === idx ? 'bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700' : 'border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                  >
                    <p className="text-[11px] font-semibold truncate text-slate-800 dark:text-slate-100">{item.path}</p>
                    <p className="text-[10px] vn-muted line-clamp-2 mt-1">{item.snippet}</p>
                    <div className="mt-2 flex items-center gap-1.5">
                      <button
                        onClick={() => {
                          setActiveSidebarPanel('backlinks')
                          setBacklinkActiveIndex(idx)
                          void openFile(item.path).catch(() => showToast('Failed to open reference', 'error'))
                        }}
                        className="px-2 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-semibold vn-focusable vn-interactive"
                      >
                        Open Source
                      </button>
                      <button
                        onClick={() => void removeBacklinkFromSource(item)}
                        className="px-2 py-1 rounded-md bg-slate-200 dark:bg-slate-700 text-[10px] text-slate-700 dark:text-slate-200 vn-focusable vn-interactive"
                      >
                        Remove Link
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="sticky top-[72px] z-10 bg-white/80 dark:bg-slate-900/70 backdrop-blur px-3 py-2 border-y border-slate-200 dark:border-slate-700 mt-3">
              <h4 className="text-[11px] uppercase tracking-wide font-semibold text-slate-700 dark:text-slate-200">Related Notes</h4>
            </div>
            <div className="p-3 space-y-2">
              <div
                tabIndex={0}
                onKeyDown={handleRelatedKeyDown}
                onFocus={() => setActiveSidebarPanel('related')}
                onClick={() => setActiveSidebarPanel('related')}
                className="rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400/70"
              >
                {relatedLoading && (
                  <div className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-3">
                    <p className="text-[11px] font-medium text-slate-800 dark:text-slate-100">Finding related notes…</p>
                    <p className="mt-1 text-[10px] vn-muted">
                      Pipnote is comparing topics, keywords, people, and nearby structure to find useful relationships.
                    </p>
                  </div>
                )}
                {!relatedLoading && relatedError && (
                  <div className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50/70 dark:bg-red-900/15 px-3 py-3">
                    <p className="text-[11px] font-medium text-red-700 dark:text-red-300">Related notes could not load.</p>
                    <p className="mt-1 text-[10px] text-red-600/90 dark:text-red-300/90">{relatedError}</p>
                  </div>
                )}
                {!relatedLoading && !relatedError && relatedNotes.length === 0 && (
                  <div className="rounded-lg border border-dashed border-slate-200 dark:border-slate-700 px-3 py-3">
                    <p className="text-[11px] font-medium text-slate-800 dark:text-slate-100">No strong related notes yet.</p>
                    <p className="mt-1 text-[10px] vn-muted">
                      This note may be too short, too unique, or still waiting on stronger embeddings before Pipnote can suggest confident relationships.
                    </p>
                  </div>
                )}
                {relatedNotes.map((item, idx) => {
                  const relatedExplanation = buildRelatedExplanation(item)
                  return (
                  <button
                    key={`${item.path}-${idx}`}
                    onClick={() => {
                      setActiveSidebarPanel('related')
                      setRelatedActiveIndex(idx)
                      void openFile(item.path).catch(() => showToast('Failed to open related note', 'error'))
                    }}
                    className={`w-full text-left p-2 rounded-lg border vn-interactive mb-2 ${
                      relatedActiveIndex === idx
                        ? 'bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700'
                        : 'border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                    title={item.reason}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold truncate text-slate-800 dark:text-slate-100">{displayNotePath(item.path)}</p>
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold whitespace-nowrap ${confidenceBadgeClass(item.confidence)}`}>
                        {item.confidence}
                      </span>
                    </div>
                    {relatedExplanation.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {relatedExplanation.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="px-1.5 py-0.5 rounded-full bg-slate-200/90 dark:bg-slate-700/80 text-[9px] font-medium text-slate-700 dark:text-slate-200"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="text-[10px] vn-muted mt-1">{Math.round(item.score * 100)}% match</p>
                    <p className="text-[10px] vn-muted line-clamp-2 mt-1">{relatedExplanation.summary}</p>
                  </button>
                  )
                })}
              </div>
            </div>
            </aside>
          </>
        )}

        {!focusMode && !isPreviewTab && !isRightSidebarVisible && (
          <button
            type="button"
            onClick={() => setIsRightSidebarVisible(true)}
            className="absolute right-2 top-1/2 -translate-y-1/2 z-20 h-10 w-7 rounded-full border border-slate-300 dark:border-slate-700 bg-white/92 dark:bg-slate-900/92 text-slate-600 dark:text-slate-300 shadow-sm flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-800 vn-focusable"
            title="Show right panel"
            aria-label="Show right panel"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}
      </div>

      {pendingLinkResolution && (
        <div className="absolute inset-0 z-40 bg-black/40 backdrop-blur-[1px] flex items-center justify-center p-4">
          <div className="w-full max-w-xl vn-surface rounded-2xl border border-slate-200 dark:border-slate-700 shadow-2xl">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Choose Linked Note</h3>
              <p className="text-xs vn-muted mt-1">Multiple matches found for "{pendingLinkResolution.rawTarget}"</p>
            </div>
            <div className="p-3 max-h-72 overflow-y-auto space-y-2">
              {pendingLinkResolution.candidates.map((candidate) => (
                <div
                  key={candidate}
                  className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium break-all">{candidate}</span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void applyResolvedLinkCandidate(candidate, { openAfter: false })}
                        className="px-2 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-semibold vn-interactive"
                      >
                        Use Link
                      </button>
                      <button
                        type="button"
                        onClick={() => void applyResolvedLinkCandidate(candidate, { openAfter: true }).catch(() => showToast('Failed to open note', 'error'))}
                        className="px-2 py-1 rounded-md bg-slate-200 dark:bg-slate-700 text-[11px] text-slate-700 dark:text-slate-200 vn-interactive"
                      >
                        Open
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-700 flex justify-end">
              <button
                onClick={() => setPendingLinkResolution(null)}
                className="px-3 py-1.5 text-xs rounded-lg bg-slate-200 dark:bg-slate-700 vn-interactive"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {focusMode && !showInFileSearch && (
        <button
          onClick={() => setFocusMode(false)}
          className="absolute top-3 right-4 z-20 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-200/90 dark:bg-slate-700/90 text-slate-800 dark:text-slate-100 backdrop-blur-sm vn-interactive vn-focusable"
        >
          Exit Focus
        </button>
      )}

      <div className="h-8 px-6 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between text-[11px] vn-muted bg-white/45 dark:bg-slate-900/30">
        <span>
          {isPreviewTab
            ? `${previewData?.kind?.toUpperCase() || 'Preview'} • ${typeof previewData?.size_bytes === 'number' ? `${previewData.size_bytes.toLocaleString()} bytes` : 'Read-only preview'}`
            : `Lines ${lines} • Characters ${chars} • Cursor Ln ${cursorLine}, Col ${cursorColumn} • Selection ${selectedChars} chars, ${selectedWords} words`}
        </span>
        <span>{isPreviewTab ? 'Preview only' : isSaving ? 'Saving...' : hasUnsavedChanges ? 'Unsaved changes' : 'Saved in vault'}</span>
      </div>
    </main>
  )
}

export default MainPanel
