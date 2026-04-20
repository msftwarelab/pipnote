import { useState, useEffect, useRef } from 'react'
import { searchService, type IndexHealthDetails, type IndexHealthStatus, type QAAnswerResult } from '../services/search'
import { localAiService } from '../services/localAi'
import { useToast } from '../contexts/ToastContext'
import { useEditor } from '../contexts/EditorContext'
import { getSourceKindMeta } from '../utils/qaSourceMeta'

const SNIPPET_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'when', 'where', 'who', 'why',
  'how', 'your', 'my', 'are', 'was', 'were', 'is', 'can', 'could', 'would', 'should', 'please',
  'about', 'note', 'notes', 'tell', 'me', 'a', 'an', 'to', 'in', 'on', 'of',
])

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildHighlightPattern(terms: string[]): RegExp | null {
  if (terms.length === 0) return null
  const pattern = terms
    .map((term) => (/^[a-z0-9]+$/i.test(term) ? `\\b${escapeRegExp(term)}\\b` : escapeRegExp(term)))
    .join('|')
  return pattern ? new RegExp(`(${pattern})`, 'ig') : null
}

function getHighlightTerms(question: string): string[] {
  return Array.from(new Set((question.toLowerCase().match(/[a-z0-9]{2,}/g) || [])))
    .filter((term) => !SNIPPET_STOP_WORDS.has(term))
    .slice(0, 8)
}

export function QAPanel() {
  const [question, setQuestion] = useState('')
  const [lastAskedQuestion, setLastAskedQuestion] = useState('')
  const [answers, setAnswers] = useState<QAAnswerResult[]>([])
  const [indexHealth, setIndexHealth] = useState<IndexHealthStatus | null>(null)
  const [indexHealthDetails, setIndexHealthDetails] = useState<IndexHealthDetails | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isRegenerating, setIsRegenerating] = useState(false)
  const [isRetryingFailed, setIsRetryingFailed] = useState(false)
  const [isRepairingCoverage, setIsRepairingCoverage] = useState(false)
  const [isLoadingHealth, setIsLoadingHealth] = useState(false)
  const [regenerationProgress, setRegenerationProgress] = useState({ current: 0, total: 0 })
  const [error, setError] = useState('')
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const { showToast } = useToast()
  const { openFile } = useEditor()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const requestSequenceRef = useRef(0)

  const refreshIndexHealth = async (options?: { includeDetails?: boolean }) => {
    const includeDetails = options?.includeDetails ?? showDiagnostics
    const [health, details] = await Promise.all([
      searchService.getIndexHealthStatus(),
      includeDetails ? searchService.getIndexHealthDetails() : Promise.resolve(null),
    ])
    setIndexHealth(health)
    setIndexHealthDetails(details)
  }

  // Keyboard shortcut: Cmd+Shift+K to focus input (Cmd+K is reserved for command palette)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadHealth = async () => {
      setIsLoadingHealth(true)
      try {
        const [health, details] = await Promise.all([
          searchService.getIndexHealthStatus(),
          showDiagnostics ? searchService.getIndexHealthDetails() : Promise.resolve(null),
        ])
        if (!cancelled) {
          setIndexHealth(health)
          setIndexHealthDetails(details)
        }
      } catch {
        if (!cancelled) {
          setIndexHealth(null)
          setIndexHealthDetails(null)
        }
      } finally {
        if (!cancelled) setIsLoadingHealth(false)
      }
    }
    void loadHealth()
    const timer = window.setInterval(() => {
      void loadHealth()
    }, 20000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [showDiagnostics])

  const handleAsk = async () => {
    const nextQuestion = question.trim()
    if (!nextQuestion) return

    const requestId = requestSequenceRef.current + 1
    requestSequenceRef.current = requestId
    setIsLoading(true)
    setError('')
    setAnswers([])
    setLastAskedQuestion(nextQuestion)
    setQuestion('')

    try {
      const result = await searchService.askQuestion(nextQuestion)
      if (requestSequenceRef.current !== requestId) {
        return
      }
      setAnswers([result])
    } catch (err) {
      if (requestSequenceRef.current !== requestId) {
        return
      }
      const errorMsg = err instanceof Error ? err.message : 'Failed to answer question'
      setError(errorMsg)
      showToast(errorMsg, 'error')
    } finally {
      if (requestSequenceRef.current === requestId) {
        setIsLoading(false)
      }
    }
  }

  const handleStopAnswer = () => {
    if (!isLoading) return
    requestSequenceRef.current += 1
    setIsLoading(false)
    showToast('Stopped current answer generation', 'info')
  }

  const handleRegenerateEmbeddings = async () => {
    const healthy = await localAiService.checkHealth()
    if (!healthy) {
      showToast(
        `${localAiService.getHealthError() || 'Local AI provider is unavailable.'} Start your selected local AI provider and verify selected models in Settings.`,
        'error',
      )
      return
    }
    // Show confirmation dialog instead of window.confirm
    setShowConfirmDialog(true)
  }

  const confirmRegenerateEmbeddings = async () => {
    setShowConfirmDialog(false)
    setIsRegenerating(true)
    setRegenerationProgress({ current: 0, total: 0 })

    try {
      const successCount = await searchService.regenerateAllEmbeddings((current, total) => {
        setRegenerationProgress({ current, total })
      })
      
      showToast(`Successfully regenerated ${successCount} embeddings`, 'success')
      await refreshIndexHealth({ includeDetails: true })
      setRegenerationProgress({ current: 0, total: 0 })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to regenerate embeddings'
      showToast(errorMsg, 'error')
    } finally {
      setIsRegenerating(false)
    }
  }

  const cancelRegenerateEmbeddings = () => {
    setShowConfirmDialog(false)
  }

  const handleRetryFailed = async () => {
    setIsRetryingFailed(true)
    setRegenerationProgress({ current: 0, total: 0 })
    try {
      const successCount = await searchService.retryFailedEmbeddings((current, total) => {
        setRegenerationProgress({ current, total })
      })
      showToast(`Retried ${successCount} failed embedding${successCount === 1 ? '' : 's'}`, 'success')
      await refreshIndexHealth({ includeDetails: true })
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to retry failed embeddings', 'error')
    } finally {
      setIsRetryingFailed(false)
      setRegenerationProgress({ current: 0, total: 0 })
    }
  }

  const handleRepairCoverage = async () => {
    setIsRepairingCoverage(true)
    setRegenerationProgress({ current: 0, total: 0 })
    try {
      const successCount = await searchService.rebuildStaleAndMissingEmbeddings((current, total) => {
        setRegenerationProgress({ current, total })
      })
      showToast(`Rebuilt ${successCount} stale or missing embedding${successCount === 1 ? '' : 's'}`, 'success')
      await refreshIndexHealth({ includeDetails: true })
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to rebuild stale or missing embeddings', 'error')
    } finally {
      setIsRepairingCoverage(false)
      setRegenerationProgress({ current: 0, total: 0 })
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && isLoading) {
      e.preventDefault()
      handleStopAnswer()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (isLoading) {
        handleStopAnswer()
        return
      }
      handleAsk()
    }
  }

  const handleSourceClick = async (sourcePath: string) => {
    const normalized = sourcePath.trim()
    const isLikelyNotePath = normalized.includes('/') || normalized.endsWith('.md') || normalized.startsWith('notes/')
    if (!isLikelyNotePath) {
      return
    }

    try {
      await openFile(sourcePath)
    } catch (error) {
      console.error('Failed to open source file:', error)
      showToast('Failed to open file', 'error')
    }
  }

  const handleSnippetClick = async (result: QAAnswerResult) => {
    const sourcePath = result.source.trim()
    const snippet = result.sourceSnippet?.trim() || ''
    const isLikelyNotePath = sourcePath.includes('/') || sourcePath.endsWith('.md') || sourcePath.startsWith('notes/')
    if (!isLikelyNotePath || !snippet) return

    try {
      await openFile(sourcePath)
      window.dispatchEvent(
        new CustomEvent('vn:jump-to-source-snippet', {
          detail: {
            sourcePath,
            snippet,
          },
        }),
      )
    } catch (error) {
      console.error('Failed to jump to source snippet:', error)
      showToast('Failed to jump to source context', 'error')
    }
  }

  const highlightSnippet = (snippet: string) => {
    const terms = getHighlightTerms(lastAskedQuestion || question)
    if (!snippet || terms.length === 0) return snippet
    const pattern = buildHighlightPattern(terms)
    if (!pattern) return snippet
    const parts = snippet.split(pattern)
    return parts.map((part, index) => {
      if (terms.some((term) => term.toLowerCase() === part.toLowerCase())) {
        return (
          <mark key={`${part}-${index}`} className="bg-amber-300/80 dark:bg-amber-500/40 px-0.5 rounded text-slate-900 dark:text-slate-100">
            {part}
          </mark>
        )
      }
      return <span key={`${part}-${index}`}>{part}</span>
    })
  }

  const getModeBadgeClass = (result: QAAnswerResult) => {
    if (result.answerMode === 'grounded') return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
    if (result.answerMode === 'mixed') return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
    return 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200'
  }

  const getConfidenceClass = (confidence: QAAnswerResult['confidence']) => {
    if (confidence === 'high') return 'text-emerald-700 dark:text-emerald-300'
    if (confidence === 'medium') return 'text-amber-700 dark:text-amber-300'
    return 'text-slate-600 dark:text-slate-400'
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden bg-transparent">
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex-shrink-0 bg-gradient-to-r from-blue-50/70 to-sky-50/50 dark:from-slate-900 dark:to-slate-800">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Q&amp;A Assistant</p>
            <p className="mt-1 text-[11px] vn-muted">
              Ask naturally. Pipnote will answer from your vault when strong note evidence exists.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowDiagnostics((prev) => !prev)}
            className="rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-[10px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap vn-focusable vn-interactive"
          >
            {showDiagnostics ? 'Hide tools' : 'Show tools'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {showDiagnostics && (
          <>
            <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-900/40 px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold text-slate-900 dark:text-slate-100">Index Health</p>
                  <p className="text-[10px] vn-muted">
                    {isLoadingHealth && !indexHealth ? 'Checking indexing status...' : 'Embeddings help Q&A find the right notes faster.'}
                  </p>
                </div>
              </div>
              {indexHealth && (
                <div className="mt-3 grid grid-cols-4 gap-2 text-[11px]">
                  <div className="rounded-lg bg-white/80 dark:bg-slate-800/70 px-2 py-1.5">
                    <p className="vn-muted">Eligible</p>
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{indexHealth.eligibleCount}</p>
                  </div>
                  <div className="rounded-lg bg-white/80 dark:bg-slate-800/70 px-2 py-1.5">
                    <p className="vn-muted">Indexed</p>
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{indexHealth.indexedCount}</p>
                  </div>
                  <div className="rounded-lg bg-white/80 dark:bg-slate-800/70 px-2 py-1.5">
                    <p className="vn-muted">Stale</p>
                    <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">{indexHealth.staleCount}</p>
                  </div>
                  <div className="rounded-lg bg-white/80 dark:bg-slate-800/70 px-2 py-1.5">
                    <p className="vn-muted">Failed</p>
                    <p className="text-sm font-semibold text-red-700 dark:text-red-300">{indexHealth.failedCount}</p>
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-2">
              <button
                onClick={handleRegenerateEmbeddings}
                disabled={isRegenerating || isLoading || isRetryingFailed || isRepairingCoverage}
                title="Regenerate all embeddings for accurate Q&A"
                className="w-full px-3 py-2 bg-slate-200/90 dark:bg-slate-700/90 hover:bg-slate-300 dark:hover:bg-slate-600 disabled:opacity-50 text-slate-900 dark:text-slate-100 text-xs rounded-lg transition-colors flex items-center justify-center gap-2 font-medium vn-focusable vn-interactive vn-pressable"
              >
                <svg className={`w-4 h-4 ${isRegenerating ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.58M20 20v-5h-.58M5.5 9A7.5 7.5 0 0119 12M18.5 15A7.5 7.5 0 015 12" />
                </svg>
                {isRegenerating ? 'Regenerating...' : 'Regenerate Embeddings'}
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => void handleRepairCoverage()}
                  disabled={isRegenerating || isLoading || isRetryingFailed || isRepairingCoverage || !indexHealthDetails?.issues.some((issue) => issue.type === 'missing' || issue.type === 'stale')}
                  className="px-3 py-2 bg-amber-100/90 dark:bg-amber-900/30 hover:bg-amber-200 dark:hover:bg-amber-900/40 disabled:opacity-50 text-amber-900 dark:text-amber-100 text-xs rounded-lg transition-colors font-medium vn-focusable vn-interactive vn-pressable"
                >
                  {isRepairingCoverage ? 'Repairing...' : 'Repair Stale/Missing'}
                </button>
                <button
                  onClick={() => void handleRetryFailed()}
                  disabled={isRegenerating || isLoading || isRetryingFailed || isRepairingCoverage || !indexHealthDetails?.issues.some((issue) => issue.type === 'failed')}
                  className="px-3 py-2 bg-red-100/90 dark:bg-red-900/30 hover:bg-red-200 dark:hover:bg-red-900/40 disabled:opacity-50 text-red-900 dark:text-red-100 text-xs rounded-lg transition-colors font-medium vn-focusable vn-interactive vn-pressable"
                >
                  {isRetryingFailed ? 'Retrying...' : 'Retry Failed'}
                </button>
              </div>
            </div>

            {(isRegenerating || isRetryingFailed || isRepairingCoverage) && regenerationProgress.total > 0 && (
              <div className="p-2 bg-blue-50/90 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-medium text-blue-900 dark:text-blue-100">
                    {regenerationProgress.current}/{regenerationProgress.total}
                  </span>
                  <span className="text-[10px] text-blue-700 dark:text-blue-300">
                    {Math.round((regenerationProgress.current / regenerationProgress.total) * 100)}%
                  </span>
                </div>
                <div className="w-full bg-blue-200 dark:bg-blue-800 rounded-full h-1 overflow-hidden">
                  <div
                    className="bg-blue-600 h-full transition-all duration-300"
                    style={{
                      width: `${(regenerationProgress.current / regenerationProgress.total) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {indexHealthDetails && indexHealthDetails.issues.length > 0 && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-900/40 p-3">
            <div className="flex items-center justify-between gap-3 mb-2">
              <div>
                <p className="text-[11px] font-semibold text-slate-900 dark:text-slate-100">Index issues</p>
                <p className="text-[10px] vn-muted">Top files that need attention for reliable Q&A.</p>
              </div>
              <span className="text-[10px] px-2 py-1 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200">
                {indexHealthDetails.issues.length} issue{indexHealthDetails.issues.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
              {indexHealthDetails.issues.slice(0, 8).map((issue) => (
                <div key={`${issue.type}-${issue.path}`} className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-800/70 p-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                      issue.type === 'failed'
                        ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                        : issue.type === 'missing'
                          ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300'
                          : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                    }`}>
                      {issue.type}
                    </span>
                    <code className="text-[10px] font-mono text-slate-700 dark:text-slate-200 truncate">
                      {issue.path.replace(/^notes\//, '')}
                    </code>
                  </div>
                  <p className="text-[11px] text-slate-700 dark:text-slate-200 leading-relaxed">{issue.reason}</p>
                  {issue.detail && (
                    <p className="text-[10px] vn-muted mt-1 leading-relaxed">{issue.detail}</p>
                  )}
                  {issue.lastAttemptAt && (
                    <p className="text-[10px] vn-muted mt-1">Last attempt: {new Date(issue.lastAttemptAt).toLocaleString()}</p>
                  )}
                </div>
              ))}
            </div>
              </div>
            )}

            <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-900/40 px-3 py-2">
              <p className="text-[11px] font-semibold text-slate-900 dark:text-slate-100">Supported for AI</p>
              <p className="text-[10px] vn-muted mt-1">
                Text notes, PDFs, DOCX, PPTX, XLSX, and CSV files can be indexed for search and Q&amp;A. Images are preview-only right now.
              </p>
            </div>
          </>
        )}

        {isLoading && (
          <div className="space-y-3">
            {lastAskedQuestion && (
              <div className="flex justify-end">
                <div className="max-w-[88%] rounded-2xl rounded-br-md bg-blue-600 px-4 py-3 text-[13px] text-white shadow-sm">
                  {lastAskedQuestion}
                </div>
              </div>
            )}
            <div className="flex justify-start">
              <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-slate-200 dark:border-slate-700 bg-white/85 dark:bg-slate-900/70 px-4 py-3 shadow-sm">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
                  <p className="text-[13px] vn-muted">Searching your notes and building an answer...</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-100/95 dark:bg-red-900/30 border border-red-400 dark:border-red-700 text-red-700 dark:text-red-400 px-3 py-2 rounded-xl text-[13px]">
            <p className="font-semibold">Error</p>
            <p>{error}</p>
          </div>
        )}

        {answers.length > 0 && !isLoading && (
          <div className="space-y-4">
            {lastAskedQuestion && (
              <div className="flex justify-end">
                <div className="max-w-[88%] rounded-2xl rounded-br-md bg-blue-600 px-4 py-3 text-[13px] text-white shadow-sm">
                  {lastAskedQuestion}
                </div>
              </div>
            )}
            {answers.map((result, index) => (
              <div key={index} className="space-y-2 vn-list-enter">
                {(() => {
                  const sourceMeta = result.source && result.source !== 'N/A'
                    ? getSourceKindMeta(result.source, result.sourceContextKind ?? 'standard')
                    : null
                  const isVaultSource = !!(result.source && result.source !== 'N/A' && (result.source.includes('/') || result.source.startsWith('notes/')))
                  return (
                    <>
                <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-slate-200 dark:border-slate-700 bg-white/88 dark:bg-slate-900/72 p-3 shadow-sm">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-[13px]">
                        Answer {index + 1}
                      </h3>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                          result.sourceType === 'fact'
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
                            : result.sourceType === 'note'
                              ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
                              : 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200'
                        }`}
                      >
                        {result.sourceType === 'fact' ? 'Fact' : result.sourceType === 'note' ? 'Note' : 'General'}
                      </span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${getModeBadgeClass(result)}`}>
                        {result.answerMode === 'grounded' ? 'Grounded' : result.answerMode === 'mixed' ? 'Mixed' : 'General'}
                      </span>
                      {sourceMeta && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${sourceMeta.tone}`}>
                          {sourceMeta.label}
                        </span>
                      )}
                    </div>
                    <span className={`text-[11px] font-medium ${getConfidenceClass(result.confidence)}`}>
                      {result.confidence === 'high' ? 'High confidence' : result.confidence === 'medium' ? 'Medium confidence' : 'Low confidence'}
                    </span>
                  </div>
                  <p className="text-[10px] vn-muted mb-1">{result.provenanceLabel}</p>
                  {result.retrievalSummary && result.sourceType === 'note' && (
                    <div className="mb-2 space-y-1">
                      <p className="text-[10px] text-slate-600 dark:text-slate-300">
                        Why Pipnote chose this source: {result.retrievalSummary}
                      </p>
                      {result.retrievalTags && result.retrievalTags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {result.retrievalTags.slice(0, 3).map((tag) => (
                            <span
                              key={tag}
                              className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {result.groundingSummary && result.sourceType === 'note' && (
                    <p className="mb-2 text-[10px] text-slate-600 dark:text-slate-300">
                      Answer scope: {result.groundingSummary}
                    </p>
                  )}
                  <p className="text-slate-800 dark:text-slate-200 text-[13px] whitespace-pre-wrap leading-relaxed">
                    {result.answer}
                  </p>
                </div>

                {isVaultSource && (
                  <button
                    onClick={() => handleSourceClick(result.source)}
                    className="w-full bg-blue-50/80 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-2 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors text-left vn-focusable vn-interactive"
                  >
                    <div className="text-[11px] text-slate-700 dark:text-slate-300 flex flex-wrap items-start gap-2">
                      <span className="font-semibold">{result.sourceType === 'fact' ? 'Fact Source:' : 'Source:'} </span>
                      <code
                        title={result.source.replace('notes/', '').replace('.md', '')}
                        className="min-w-0 max-w-full flex-1 whitespace-normal break-all bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded text-[10px] font-mono hover:bg-slate-200 dark:hover:bg-slate-600"
                      >
                        {result.source.replace('notes/', '').replace('.md', '')}
                      </code>
                      <svg className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                    {sourceMeta && sourceMeta.label !== 'Note file' && (
                      <p className="text-[11px] text-blue-700 dark:text-blue-300 mt-1">
                        Open the original {sourceMeta.label.toLowerCase()} from your vault.
                      </p>
                    )}
                  </button>
                )}

                {result.sourceSnippet && isVaultSource && (
                  <button
                    onClick={() => void handleSnippetClick(result)}
                    className="w-full bg-amber-50/70 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-2 text-left hover:bg-amber-100/70 dark:hover:bg-amber-900/30 transition-colors vn-focusable vn-interactive"
                  >
                    <p className="text-[11px] font-semibold text-amber-800 dark:text-amber-300 mb-1">
                      {result.sourceType === 'fact'
                        ? 'Matched Fact (Click to jump)'
                        : result.sourceContextKind === 'ocr-image'
                          ? 'Matched OCR Text (Click to open source)'
                          : sourceMeta && sourceMeta.label !== 'Note file'
                            ? 'Matched Extracted Text (Click to open source)'
                          : 'Matched Context (Click to jump)'}
                    </p>
                    <p className="text-[11px] text-slate-700 dark:text-slate-200 leading-relaxed">
                      {highlightSnippet(result.sourceSnippet)}
                    </p>
                  </button>
                )}

                {result.sourceSnippet && !isVaultSource && (
                  <div className="w-full bg-amber-50/70 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-2">
                    <p className="text-[11px] font-semibold text-amber-800 dark:text-amber-300 mb-1">
                      {result.sourceType === 'fact' ? 'Matched Fact' : 'Matched Context'}
                    </p>
                    <p className="text-[11px] text-slate-700 dark:text-slate-200 leading-relaxed">
                      {highlightSnippet(result.sourceSnippet)}
                    </p>
                  </div>
                )}

                {(!result.source || result.source === 'N/A') && (
                  <div className="w-full bg-slate-100/80 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-700 rounded-xl p-2">
                    <p className="text-[11px] text-slate-600 dark:text-slate-300">
                      Source: <span className="font-semibold">General model answer</span> because no strong note-based evidence was found.
                    </p>
                  </div>
                )}
                    </>
                  )
                })()}
              </div>
            ))}
          </div>
        )}

        {answers.length === 0 && !isLoading && !error && (
          <div className="flex items-center justify-center min-h-[42vh]">
            <div className="text-center text-[13px] max-w-xs">
              <svg
                className="mx-auto h-8 w-8 mb-2 opacity-50"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <p className="text-slate-800 dark:text-slate-100 font-medium">Ask a question about your notes</p>
              <p className="mt-2 text-[11px] vn-muted">
              Try something concrete like “What is my execution plan?” or “When is my wedding day?”
            </p>
              {indexHealth && indexHealth.indexedCount === 0 && indexHealth.eligibleCount > 0 && (
                <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
                  No embeddings are ready yet, so answers may fall back to general model responses until indexing finishes.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-slate-200 dark:border-slate-700 bg-white/75 dark:bg-slate-950/45 backdrop-blur px-4 py-3 flex-shrink-0">
        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50/90 dark:bg-slate-900/70 p-2 shadow-sm">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={handleKeyDown}
                placeholder="Ask your vault..."
              disabled={isRegenerating}
              rows={2}
              className="flex-1 resize-none bg-transparent px-2 py-2 text-[13px] text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none disabled:bg-transparent vn-focusable"
            />
            <button
              onClick={isLoading ? handleStopAnswer : handleAsk}
              disabled={(!isLoading && !question.trim()) || isRegenerating}
              className={`h-11 w-11 rounded-xl text-sm font-semibold transition-colors flex-shrink-0 flex items-center justify-center vn-focusable vn-interactive vn-pressable ${
                isRegenerating || (!isLoading && !question.trim())
                  ? 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400 cursor-not-allowed'
                  : isLoading
                    ? 'bg-red-600 hover:bg-red-700 text-white'
                    : 'bg-blue-600 hover:bg-blue-700 text-white vn-brand-ring'
              }`}
              title={isLoading ? 'Stop answer' : 'Send question'}
            >
              {isLoading ? (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14m-5-5l5 5-5 5" />
                </svg>
              )}
            </button>
          </div>
          <div className="mt-1 flex items-center justify-between gap-3 px-2">
            <p className="text-[11px] vn-muted">{isLoading ? 'Click stop or press Escape to cancel this answer.' : 'Enter to send, Shift+Enter for a new line.'}</p>
          </div>
        </div>
      </div>

      {/* Confirmation Dialog */}
      {showConfirmDialog && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="vn-surface vn-glass rounded-2xl shadow-xl max-w-md w-full mx-4">
            <div className="p-6">
              <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-2">
                Regenerate Embeddings?
              </h2>
              <p className="vn-muted mb-6">
                This will clear all embeddings and regenerate them from scratch. This may take a few minutes. Continue?
              </p>
              <div className="flex justify-end gap-3">
                <button
                  onClick={cancelRegenerateEmbeddings}
                  className="px-4 py-2 bg-slate-200/90 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-900 dark:text-white rounded-lg text-sm font-medium transition-colors vn-focusable vn-interactive vn-pressable"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmRegenerateEmbeddings}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition-colors vn-brand-ring vn-focusable vn-interactive vn-pressable"
                >
                  OK
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
