import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEditor } from '../contexts/EditorContext'
import { useToast } from '../contexts/ToastContext'
import { vaultService, type KeywordSearchHit } from '../services/vault'
import { buildKeywordSearchExplanation } from '../utils/keywordSearchExplainability'

interface KeywordSearchModalProps {
  isOpen: boolean
  onClose: () => void
}

type RankedKeywordSearchHit = KeywordSearchHit & {
  rankingScore: number
  matchKind: 'title' | 'content' | 'mixed'
  rankingSummary: string
  rankingTags: string[]
}

type RankedKeywordSearchHitWithIndex = RankedKeywordSearchHit & {
  originalIndex: number
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildSnippetPreview(snippet: string, queryTokens: string[]): string {
  const normalized = snippet.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (normalized.length <= 220) return normalized
  if (queryTokens.length === 0) return `${normalized.slice(0, 217).trimEnd()}...`

  const regex = new RegExp(queryTokens.map(escapeRegExp).join('|'), 'i')
  const match = normalized.match(regex)
  if (!match || typeof match.index !== 'number') {
    return `${normalized.slice(0, 217).trimEnd()}...`
  }

  const start = Math.max(0, match.index - 70)
  const end = Math.min(normalized.length, start + 220)
  const sliced = normalized.slice(start, end).trim()
  return `${start > 0 ? '...' : ''}${sliced}${end < normalized.length ? '...' : ''}`
}

function rankKeywordHits(hits: KeywordSearchHit[], queryTokens: string[]): RankedKeywordSearchHit[] {
  const joinedQuery = queryTokens.join(' ').trim()

  return hits
    .map((hit, index) => {
      const titleLower = hit.title.toLowerCase()
      const pathLower = hit.path.toLowerCase()
      const snippetLower = hit.snippet.toLowerCase()

      const titleMatches = queryTokens.filter((token) => titleLower.includes(token)).length
      const pathMatches = queryTokens.filter((token) => pathLower.includes(token)).length
      const snippetMatches = queryTokens.filter((token) => snippetLower.includes(token)).length
      const exactTitle = joinedQuery.length > 0 && titleLower === joinedQuery
      const titleStartsWith = joinedQuery.length > 0 && titleLower.startsWith(joinedQuery)

      let rankingScore = hit.score
      rankingScore += titleMatches * 14
      rankingScore += pathMatches * 5
      rankingScore += snippetMatches * 3
      if (exactTitle) rankingScore += 40
      if (titleStartsWith) rankingScore += 16

      const matchKind: RankedKeywordSearchHit['matchKind'] =
        titleMatches > 0 && snippetMatches > 0
          ? 'mixed'
          : titleMatches > 0
            ? 'title'
            : 'content'
      const explanation = buildKeywordSearchExplanation({
        hit,
        queryTokens,
        titleMatches,
        pathMatches,
        snippetMatches,
        exactTitle,
        titleStartsWith,
      })

      const rankedHit: RankedKeywordSearchHitWithIndex = {
        ...hit,
        rankingScore,
        matchKind,
        rankingSummary: explanation.summary,
        rankingTags: explanation.tags,
        snippet: buildSnippetPreview(hit.snippet, queryTokens),
        originalIndex: index,
      }
      return rankedHit
    })
    .sort((a, b) => {
      if (b.rankingScore !== a.rankingScore) return b.rankingScore - a.rankingScore
      if (a.matchKind !== b.matchKind) {
        const order = { mixed: 0, title: 1, content: 2 }
        return order[a.matchKind] - order[b.matchKind]
      }
      return a.originalIndex - b.originalIndex
    })
    .map((item) => {
      const rest = { ...item }
      delete (rest as Partial<RankedKeywordSearchHitWithIndex>).originalIndex
      return rest as RankedKeywordSearchHit
    })
}

export function KeywordSearchModal({ isOpen, onClose }: KeywordSearchModalProps) {
  const [query, setQuery] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [results, setResults] = useState<RankedKeywordSearchHit[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const requestIdRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const { openFile } = useEditor()
  const { showToast } = useToast()

  useEffect(() => {
    if (!isOpen) return
    setSelectedIndex(0)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const trimmed = query.trim()
    if (!trimmed) {
      setResults([])
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    requestIdRef.current += 1
    const currentRequestId = requestIdRef.current

    const timer = window.setTimeout(async () => {
      try {
        const hits = await vaultService.searchNotes(trimmed, 50)
        if (requestIdRef.current !== currentRequestId) return
        const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean)
        setResults(rankKeywordHits(hits, tokens))
      } catch {
        if (requestIdRef.current !== currentRequestId) return
        showToast('Failed to search notes', 'error')
      } finally {
        if (requestIdRef.current === currentRequestId) {
          setIsLoading(false)
        }
      }
    }, 120)

    return () => {
      window.clearTimeout(timer)
    }
  }, [isOpen, query, showToast])

  useEffect(() => {
    setSelectedIndex(prev => Math.min(prev, Math.max(0, results.length - 1)))
  }, [results.length])

  const selectedResult = useMemo(() => results[selectedIndex] ?? null, [results, selectedIndex])
  const queryTokens = useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [query]
  )
  const titleHeavyCount = useMemo(
    () => results.filter((result) => result.matchKind === 'title' || result.matchKind === 'mixed').length,
    [results],
  )
  const highlightRegex = useMemo(() => {
    if (queryTokens.length === 0) return null
    const escaped = queryTokens
      .slice()
      .sort((a, b) => b.length - a.length)
      .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    return new RegExp(`(${escaped.join('|')})`, 'ig')
  }, [queryTokens])

  const renderHighlighted = (text: string) => {
    if (!highlightRegex) return text
    const parts = text.split(highlightRegex)
    return parts.map((part, index) => {
      const isMatch = queryTokens.includes(part.toLowerCase())
      if (!isMatch) return <span key={index}>{part}</span>
      return (
        <mark
          key={index}
          className="px-0.5 rounded bg-yellow-200/80 text-slate-900 dark:bg-yellow-500/40 dark:text-yellow-50"
        >
          {part}
        </mark>
      )
    })
  }

  const handleOpenResult = async (result: KeywordSearchHit | null) => {
    if (!result) return
    try {
      await openFile(result.path)
      onClose()
    } catch {
      showToast('Failed to open file', 'error')
    }
  }

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelectedIndex(prev => Math.min(results.length - 1, prev + 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelectedIndex(prev => Math.max(0, prev - 1))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      void handleOpenResult(selectedResult)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  if (!isOpen) return null

  return createPortal(
    <div className="fixed inset-0 z-[85] bg-black/50 backdrop-blur-sm flex items-start justify-center pt-16">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="relative w-full max-w-4xl mx-4 vn-surface vn-glass rounded-2xl shadow-2xl overflow-hidden vn-panel-enter">
        <div className="p-3 border-b border-slate-200 dark:border-slate-700">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="px-2 py-1 rounded-full bg-[color:var(--vn-brand)]/10 text-[color:var(--vn-brand)] font-semibold">
              Vault search
            </span>
            <span className="px-2 py-1 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200">
              In note: Cmd/Ctrl+F
            </span>
            <span className="px-2 py-1 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200">
              Across vault: Cmd/Ctrl+Shift+F
            </span>
          </div>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Search titles, folders, and note text..."
            className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-slate-100 focus:outline-none vn-focusable"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_300px]">
          <div className="max-h-96 overflow-y-auto p-2 space-y-1 border-r border-slate-200 dark:border-slate-700">
            {query.trim() && !isLoading && results.length > 0 && (
              <div className="px-3 py-2 text-[11px] vn-muted flex items-center justify-between gap-3">
                <span>{results.length} result{results.length === 1 ? '' : 's'} found</span>
                <span>{titleHeavyCount} strong title/path match{titleHeavyCount === 1 ? '' : 'es'}</span>
              </div>
            )}
            {!query.trim() && (
              <div className="px-3 py-8 text-center">
                <p className="text-sm font-medium text-slate-800 dark:text-slate-100">Search across your vault</p>
                <p className="mt-2 text-xs vn-muted">Type a keyword, title fragment, or folder term. Use arrow keys to move and Enter to open.</p>
              </div>
            )}
            {query.trim() && isLoading && (
              <div className="px-3 py-8 text-center">
                <p className="text-sm font-medium text-slate-800 dark:text-slate-100">Searching…</p>
                <p className="mt-2 text-xs vn-muted">Looking through note titles and matching content snippets.</p>
              </div>
            )}
            {query.trim() && !isLoading && results.length === 0 && (
              <div className="px-3 py-8 text-center">
                <p className="text-sm font-medium text-slate-800 dark:text-slate-100">No matches found</p>
                <p className="mt-2 text-xs vn-muted">Try a broader keyword, fewer words, or a title fragment you expect to appear in the note.</p>
              </div>
            )}
            {results.map((hit, index) => (
              <button
                key={`${hit.path}-${index}`}
                onClick={() => void handleOpenResult(hit)}
                className={`w-full text-left px-3 py-2 rounded-lg transition-colors vn-interactive ${
                  selectedIndex === index
                    ? 'bg-blue-100 text-blue-900 dark:bg-blue-900/30 dark:text-blue-100'
                    : 'hover:bg-slate-100 dark:hover:bg-slate-800/80 text-slate-800 dark:text-slate-100'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold truncate">{renderHighlighted(hit.title)}</div>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                    hit.matchKind === 'mixed'
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'
                      : hit.matchKind === 'title'
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200'
                        : 'bg-slate-200 dark:bg-slate-700 vn-muted'
                  }`}>
                    {hit.matchKind === 'mixed' ? 'title + content' : hit.matchKind === 'title' ? 'title' : 'content'}
                  </span>
                </div>
                <div className="text-[11px] vn-muted truncate">{renderHighlighted(hit.path)}</div>
                {hit.rankingTags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {hit.rankingTags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-slate-200/90 px-1.5 py-0.5 text-[9px] font-medium text-slate-700 dark:bg-slate-700/80 dark:text-slate-200"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                <div className="text-xs text-slate-600 dark:text-slate-300 mt-1 line-clamp-2">{renderHighlighted(hit.snippet)}</div>
                <div className="mt-1 text-[10px] vn-muted">{hit.rankingSummary}</div>
              </button>
            ))}
          </div>

          <div className="p-4 bg-slate-50/70 dark:bg-slate-900/40">
            {selectedResult ? (
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{selectedResult.title}</h4>
                <div className="flex flex-wrap items-center gap-2 text-[10px]">
                  <span className={`px-1.5 py-0.5 rounded font-semibold ${
                    selectedResult.matchKind === 'mixed'
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'
                      : selectedResult.matchKind === 'title'
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200'
                        : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200'
                  }`}>
                    {selectedResult.matchKind === 'mixed'
                      ? 'Matched in title and content'
                      : selectedResult.matchKind === 'title'
                        ? 'Matched strongly in title'
                        : 'Matched in content'}
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 font-semibold">
                    Rank {Math.round(selectedResult.rankingScore)}
                  </span>
                </div>
                {selectedResult.rankingTags.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 text-[10px]">
                    {selectedResult.rankingTags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-slate-200 px-1.5 py-0.5 font-medium text-slate-700 dark:bg-slate-700 dark:text-slate-200"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                <p className="text-[11px] vn-muted break-all">{renderHighlighted(selectedResult.path)}</p>
                <p className="text-[11px] text-slate-600 dark:text-slate-300">{selectedResult.rankingSummary}</p>
                <p className="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap">{renderHighlighted(selectedResult.snippet)}</p>
                <button
                  onClick={() => void handleOpenResult(selectedResult)}
                  className="w-full px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium vn-focusable vn-interactive vn-pressable"
                >
                  Open Note
                </button>
                <p className="text-[11px] vn-muted">
                  Shortcut: <kbd className="px-1 py-0.5 rounded bg-slate-200 dark:bg-slate-700">Enter</kbd> to open selected result.
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-slate-200 dark:border-slate-700 px-3 py-3">
                <p className="text-xs font-medium text-slate-800 dark:text-slate-100">Select a result to preview it</p>
                <p className="mt-1 text-[11px] vn-muted">The right side will show the matching path and snippet before you open the note.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
