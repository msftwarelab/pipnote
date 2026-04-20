export type FormattingAction = 'bold' | 'italic' | 'h1' | 'todo' | 'code' | 'quote'

export interface EditorSnapshot {
  content: string
  selectionStart: number
  selectionEnd: number
}

export interface EditorHistory {
  past: EditorSnapshot[]
  future: EditorSnapshot[]
  limit: number
}

export interface FormattingResult {
  content: string
  selectionStart: number
  selectionEnd: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

function normalizeSelection(content: string, start: number, end: number): { start: number; end: number } {
  const max = content.length
  const safeStart = clamp(start, 0, max)
  const safeEnd = clamp(end, 0, max)
  if (safeStart <= safeEnd) return { start: safeStart, end: safeEnd }
  return { start: safeEnd, end: safeStart }
}

function replaceRange(content: string, start: number, end: number, replacement: string): string {
  return content.slice(0, start) + replacement + content.slice(end)
}

function applyInlineWrapper(
  content: string,
  start: number,
  end: number,
  wrapper: string,
  placeholder: string,
): FormattingResult {
  const { start: s, end: e } = normalizeSelection(content, start, end)

  if (s === e) {
    const inserted = `${wrapper}${placeholder}${wrapper}`
    const next = replaceRange(content, s, e, inserted)
    const selectStart = s + wrapper.length
    return {
      content: next,
      selectionStart: selectStart,
      selectionEnd: selectStart + placeholder.length,
    }
  }

  const hasLeading = content.slice(Math.max(0, s - wrapper.length), s) === wrapper
  const hasTrailing = content.slice(e, e + wrapper.length) === wrapper
  if (hasLeading && hasTrailing) {
    const unwrapped = replaceRange(content, e, e + wrapper.length, '')
    const next = replaceRange(unwrapped, s - wrapper.length, s, '')
    const newStart = s - wrapper.length
    const newEnd = e - wrapper.length
    return { content: next, selectionStart: newStart, selectionEnd: newEnd }
  }

  const wrapped = replaceRange(content, e, e, wrapper)
  const next = replaceRange(wrapped, s, s, wrapper)
  return {
    content: next,
    selectionStart: s + wrapper.length,
    selectionEnd: e + wrapper.length,
  }
}

function selectedLineRange(content: string, start: number, end: number): { lineStart: number; lineEndExclusive: number } {
  const { start: s, end: e } = normalizeSelection(content, start, end)
  const lineStart = content.lastIndexOf('\n', Math.max(0, s - 1)) + 1
  const effectiveEnd = e > s && content[e - 1] === '\n' ? e - 1 : e
  const nextBreak = content.indexOf('\n', effectiveEnd)
  const lineEndExclusive = nextBreak === -1 ? content.length : nextBreak
  return { lineStart, lineEndExclusive }
}

function mapSelectedLines(
  content: string,
  start: number,
  end: number,
  mapper: (line: string, index: number) => string,
): FormattingResult {
  const { lineStart, lineEndExclusive } = selectedLineRange(content, start, end)
  const segment = content.slice(lineStart, lineEndExclusive)
  const lines = segment.split('\n')
  const mapped = lines.map(mapper).join('\n')
  const next = replaceRange(content, lineStart, lineEndExclusive, mapped)
  return {
    content: next,
    selectionStart: lineStart,
    selectionEnd: lineStart + mapped.length,
  }
}

function applyH1(content: string, start: number, end: number): FormattingResult {
  return mapSelectedLines(content, start, end, (line) => {
    if (line.trim().length === 0) return line
    const withoutHeading = line.replace(/^\s{0,3}#{1,6}\s+/, '')
    return `# ${withoutHeading}`
  })
}

function applyTodo(content: string, start: number, end: number): FormattingResult {
  return mapSelectedLines(content, start, end, (line) => {
    if (line.trim().length === 0) return '- [ ] '
    if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(line)) return line
    const cleaned = line
      .replace(/^\s*[-*]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      .replace(/^\s*>+\s*/, '')
    return `- [ ] ${cleaned}`
  })
}

function applyQuote(content: string, start: number, end: number): FormattingResult {
  return mapSelectedLines(content, start, end, (line) => {
    if (line.trim().length === 0) return line
    const cleaned = line.replace(/^\s*>+\s?/, '')
    return `> ${cleaned}`
  })
}

function applyCodeBlock(content: string, start: number, end: number): FormattingResult {
  const { start: s, end: e } = normalizeSelection(content, start, end)
  const selected = content.slice(s, e)

  if (s === e) {
    const inserted = '```txt\n\n```'
    const next = replaceRange(content, s, e, inserted)
    const cursor = s + '```txt\n'.length
    return { content: next, selectionStart: cursor, selectionEnd: cursor }
  }

  const trimmed = selected.trim()
  const fenced = /^```[\w-]*\n[\s\S]*\n```$/.test(trimmed)
  if (fenced) {
    const lines = trimmed.split('\n')
    const inner = lines.slice(1, -1).join('\n')
    const next = replaceRange(content, s, e, inner)
    return {
      content: next,
      selectionStart: s,
      selectionEnd: s + inner.length,
    }
  }

  const wrapped = `\`\`\`txt\n${selected}\n\`\`\``
  const next = replaceRange(content, s, e, wrapped)
  return {
    content: next,
    selectionStart: s + '```txt\n'.length,
    selectionEnd: s + '```txt\n'.length + selected.length,
  }
}

export function applyFormattingAction(
  action: FormattingAction,
  content: string,
  selectionStart: number,
  selectionEnd: number,
): FormattingResult {
  switch (action) {
    case 'bold':
      return applyInlineWrapper(content, selectionStart, selectionEnd, '**', 'bold')
    case 'italic':
      return applyInlineWrapper(content, selectionStart, selectionEnd, '*', 'italic')
    case 'h1':
      return applyH1(content, selectionStart, selectionEnd)
    case 'todo':
      return applyTodo(content, selectionStart, selectionEnd)
    case 'code':
      return applyCodeBlock(content, selectionStart, selectionEnd)
    case 'quote':
      return applyQuote(content, selectionStart, selectionEnd)
    default:
      return { content, selectionStart, selectionEnd }
  }
}

export function createEditorHistory(limit = 300): EditorHistory {
  return {
    past: [],
    future: [],
    limit,
  }
}

export function pushHistory(history: EditorHistory, snapshot: EditorSnapshot): EditorHistory {
  const last = history.past[history.past.length - 1]
  if (
    last &&
    last.content === snapshot.content &&
    last.selectionStart === snapshot.selectionStart &&
    last.selectionEnd === snapshot.selectionEnd
  ) {
    return history
  }

  const nextPast = [...history.past, snapshot]
  if (nextPast.length > history.limit) {
    nextPast.splice(0, nextPast.length - history.limit)
  }
  return {
    ...history,
    past: nextPast,
    future: [],
  }
}

export function undoHistory(
  history: EditorHistory,
  current: EditorSnapshot,
): { history: EditorHistory; snapshot: EditorSnapshot | null } {
  if (history.past.length === 0) {
    return { history, snapshot: null }
  }
  const snapshot = history.past[history.past.length - 1]
  const nextPast = history.past.slice(0, -1)
  return {
    history: {
      ...history,
      past: nextPast,
      future: [...history.future, current],
    },
    snapshot,
  }
}

export function redoHistory(
  history: EditorHistory,
  current: EditorSnapshot,
): { history: EditorHistory; snapshot: EditorSnapshot | null } {
  if (history.future.length === 0) {
    return { history, snapshot: null }
  }
  const snapshot = history.future[history.future.length - 1]
  const nextFuture = history.future.slice(0, -1)
  return {
    history: {
      ...history,
      past: [...history.past, current],
      future: nextFuture,
    },
    snapshot,
  }
}
