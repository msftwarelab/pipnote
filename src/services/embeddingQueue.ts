import { vaultService } from './vault'
import { localAiService } from './localAi'
import { computeContentHash } from '../utils/contentHash'
import { normalizeNotePath } from '../utils/noteScope'
import { generateAdaptiveEmbedding } from '../utils/adaptiveEmbedding'
import { activityMonitorService, type ActivityPressureLevel } from './activityMonitor'
import { isPotentialRetrievalPath, isRetrievalEligibleAIReadable } from '../utils/retrievalScope'

export type EmbeddingBacklogTier = 'small' | 'medium' | 'large' | 'very_large'

export interface EmbeddingQueueStatus {
  pending: number
  inFlight: number
  processed: number
  succeeded: number
  failed: number
  running: boolean
  schedulingMode: EmbeddingQueueSchedulingMode
  configuredMaxConcurrency: number
  effectiveConcurrency: number
  batchSize: number
  avgTaskMs: number
  p95TaskMs: number
  queueWaitAvgMs: number
  queueWaitP95Ms: number
  activePathHitRate: number
  activePathHitSamples: number
  backlogSize: number
  backlogTier: EmbeddingBacklogTier
  typingActive: boolean
  typingPressure: ActivityPressureLevel
  typingCharsPerSecond: number
  lastError: string | null
  lastProcessedPath: string | null
  lastProcessedAt: number | null
  lastSuccessPath: string | null
  lastSuccessAt: number | null
  recentFailures: EmbeddingFailureEntry[]
  updatedAt: number
}

interface WaitOptions {
  maxWaitMs?: number
  priority?: 'normal' | 'high'
}

type StatusListener = (status: EmbeddingQueueStatus) => void

export interface EmbeddingFailureEntry {
  path: string
  error: string
  at: number
  retryCount: number
}

const EMBEDDING_QUEUE_CONCURRENCY_KEY = 'vn_embedding_queue_concurrency'
const EMBEDDING_QUEUE_SCHEDULING_MODE_KEY = 'vn_embedding_queue_scheduling_mode'
const DEFAULT_MAX_CONCURRENCY = 2
const MIN_CONCURRENCY = 1
const MAX_CONCURRENCY = 4
const FAILURE_COOLDOWN_MS = 60_000
const MAX_FAILURE_HISTORY = 12
const MAX_DURATION_SAMPLES = 24
const HIGH_LATENCY_P95_MS = 5_200
const LOW_LATENCY_P95_MS = 1_500
const HIGH_FAILURE_RATE = 0.25
const LOW_FAILURE_RATE = 0.08
const ADAPTIVE_VISIBLE_CAP = 2
const ADAPTIVE_VISIBLE_CAP_LARGE_BACKLOG = 3
const ADAPTIVE_TYPING_MEDIUM_CAP = 2
const ADAPTIVE_TYPING_HIGH_CAP = 1
const MID_LATENCY_P95_MS = 2_800
const BACKLOG_MEDIUM_THRESHOLD = 80
const BACKLOG_LARGE_THRESHOLD = 180
const BACKLOG_VERY_LARGE_THRESHOLD = 420
const BATCH_SIZE_SMALL = 1
const BATCH_SIZE_MEDIUM = 2
const BATCH_SIZE_LARGE = 4
const BATCH_SIZE_VERY_LARGE = 6
const BATCH_YIELD_MS_TYPING = 5
const MAX_QUEUE_WAIT_SAMPLES = 96
const ACTIVE_HIT_RATE_WINDOW = 96

export type EmbeddingQueueSchedulingMode = 'manual' | 'adaptive'

function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_CONCURRENCY
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.round(value)))
}

function readStoredConcurrency(): number {
  if (typeof window === 'undefined') return DEFAULT_MAX_CONCURRENCY
  try {
    const raw = window.localStorage.getItem(EMBEDDING_QUEUE_CONCURRENCY_KEY)
    if (!raw) return DEFAULT_MAX_CONCURRENCY
    const parsed = Number(raw)
    return clampConcurrency(parsed)
  } catch {
    return DEFAULT_MAX_CONCURRENCY
  }
}

function persistConcurrency(value: number): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(EMBEDDING_QUEUE_CONCURRENCY_KEY, String(value))
  } catch {
    // Best-effort setting persistence only.
  }
}

function readStoredSchedulingMode(): EmbeddingQueueSchedulingMode {
  if (typeof window === 'undefined') return 'adaptive'
  try {
    const raw = window.localStorage.getItem(EMBEDDING_QUEUE_SCHEDULING_MODE_KEY)
    return raw === 'manual' ? 'manual' : 'adaptive'
  } catch {
    return 'adaptive'
  }
}

function persistSchedulingMode(mode: EmbeddingQueueSchedulingMode): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(EMBEDDING_QUEUE_SCHEDULING_MODE_KEY, mode)
  } catch {
    // Best-effort setting persistence only.
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

class EmbeddingQueueService {
  private queue: string[] = []
  private queuedSet = new Set<string>()
  private queuedAt = new Map<string, number>()
  private inFlightSet = new Set<string>()
  private listeners = new Set<StatusListener>()
  private runningWorkers = 0
  private processedCount = 0
  private succeededCount = 0
  private failedCount = 0
  private failureTimestamps = new Map<string, number>()
  private successTimestamps = new Map<string, number>()
  private lastError: string | null = null
  private lastProcessedPath: string | null = null
  private lastProcessedAt: number | null = null
  private lastSuccessPath: string | null = null
  private lastSuccessAt: number | null = null
  private failureHistory: EmbeddingFailureEntry[] = []
  private maxConcurrency = readStoredConcurrency()
  private schedulingMode: EmbeddingQueueSchedulingMode = readStoredSchedulingMode()
  private adaptiveConcurrency = this.getInitialAdaptiveConcurrency()
  private recentDurationsMs: number[] = []
  private recentQueueWaitMs: number[] = []
  private recentOutcomes: Array<'success' | 'failed'> = []
  private recentActivePathHits: boolean[] = []
  private activePath: string | null = null

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (this.schedulingMode !== 'adaptive') return
        this.recalculateAdaptiveConcurrency('visibility')
      })
    }
    activityMonitorService.subscribe(() => {
      if (this.schedulingMode !== 'adaptive') return
      this.recalculateAdaptiveConcurrency('activity')
    }, { emitInitial: false })
  }

  private getBacklogSize(): number {
    return this.queue.length + this.inFlightSet.size
  }

  private getBacklogTier(): EmbeddingBacklogTier {
    const size = this.getBacklogSize()
    if (size >= BACKLOG_VERY_LARGE_THRESHOLD) return 'very_large'
    if (size >= BACKLOG_LARGE_THRESHOLD) return 'large'
    if (size >= BACKLOG_MEDIUM_THRESHOLD) return 'medium'
    return 'small'
  }

  private getBatchSize(): number {
    const activity = activityMonitorService.getSnapshot()
    if (activity.pressure === 'high') return BATCH_SIZE_SMALL
    if (activity.pressure === 'medium') return BATCH_SIZE_MEDIUM

    const tier = this.getBacklogTier()
    if (tier === 'very_large') return BATCH_SIZE_VERY_LARGE
    if (tier === 'large') return BATCH_SIZE_LARGE
    if (tier === 'medium') return BATCH_SIZE_MEDIUM
    return BATCH_SIZE_SMALL
  }

  private getVisibleConcurrencyCap(): number {
    if (typeof document === 'undefined') return MAX_CONCURRENCY
    if (document.visibilityState !== 'visible') return MAX_CONCURRENCY
    const activity = activityMonitorService.getSnapshot()
    const tier = this.getBacklogTier()
    if (!activity.typing && (tier === 'large' || tier === 'very_large')) {
      return Math.min(MAX_CONCURRENCY, ADAPTIVE_VISIBLE_CAP_LARGE_BACKLOG)
    }
    return ADAPTIVE_VISIBLE_CAP
  }

  private getInitialAdaptiveConcurrency(): number {
    const cap = Math.min(this.getVisibleConcurrencyCap(), this.getTypingConcurrencyCap())
    return Math.max(MIN_CONCURRENCY, Math.min(this.maxConcurrency, cap))
  }

  private getTypingConcurrencyCap(): number {
    const snapshot = activityMonitorService.getSnapshot()
    if (!snapshot.typing) return MAX_CONCURRENCY
    if (snapshot.pressure === 'high') return ADAPTIVE_TYPING_HIGH_CAP
    if (snapshot.pressure === 'medium') return ADAPTIVE_TYPING_MEDIUM_CAP
    return MAX_CONCURRENCY
  }

  private getFailureRate(): number {
    if (this.recentOutcomes.length === 0) return 0
    const failures = this.recentOutcomes.filter((outcome) => outcome === 'failed').length
    return failures / this.recentOutcomes.length
  }

  private getAvgDurationMs(): number {
    if (this.recentDurationsMs.length === 0) return 0
    const total = this.recentDurationsMs.reduce((sum, value) => sum + value, 0)
    return total / this.recentDurationsMs.length
  }

  private getP95DurationMs(): number {
    return percentile(this.recentDurationsMs, 95)
  }

  private getAvgQueueWaitMs(): number {
    if (this.recentQueueWaitMs.length === 0) return 0
    const total = this.recentQueueWaitMs.reduce((sum, value) => sum + value, 0)
    return total / this.recentQueueWaitMs.length
  }

  private getP95QueueWaitMs(): number {
    return percentile(this.recentQueueWaitMs, 95)
  }

  private getActivePathHitRate(): number {
    if (this.recentActivePathHits.length === 0) return 0
    const hits = this.recentActivePathHits.filter(Boolean).length
    return hits / this.recentActivePathHits.length
  }

  private getEffectiveConcurrency(): number {
    if (this.schedulingMode === 'manual') return this.maxConcurrency
    const visibleCap = this.getVisibleConcurrencyCap()
    const typingCap = this.getTypingConcurrencyCap()
    return Math.max(MIN_CONCURRENCY, Math.min(this.maxConcurrency, this.adaptiveConcurrency, visibleCap, typingCap))
  }

  private rememberTask(durationMs: number, outcome: 'success' | 'failed'): void {
    this.recentDurationsMs = [...this.recentDurationsMs, Math.max(0, durationMs)].slice(-MAX_DURATION_SAMPLES)
    this.recentOutcomes = [...this.recentOutcomes, outcome].slice(-MAX_DURATION_SAMPLES)
  }

  private rememberQueueWait(waitMs: number): void {
    this.recentQueueWaitMs = [...this.recentQueueWaitMs, Math.max(0, waitMs)].slice(-MAX_QUEUE_WAIT_SAMPLES)
  }

  private rememberActivePathHit(isHit: boolean): void {
    this.recentActivePathHits = [...this.recentActivePathHits, isHit].slice(-ACTIVE_HIT_RATE_WINDOW)
  }

  private recalculateAdaptiveConcurrency(trigger: 'task' | 'visibility' | 'settings' | 'activity'): void {
    if (this.schedulingMode !== 'adaptive') return
    const previous = this.adaptiveConcurrency
    const hardMax = this.maxConcurrency
    const visibleCap = this.getVisibleConcurrencyCap()
    const typingCap = this.getTypingConcurrencyCap()
    const p95 = this.getP95DurationMs()
    const failureRate = this.getFailureRate()
    const backlogTier = this.getBacklogTier()
    const activity = activityMonitorService.getSnapshot()

    let next = previous
    if (trigger === 'settings') {
      next = Math.min(hardMax, Math.max(MIN_CONCURRENCY, previous))
    } else if (trigger === 'activity' && typingCap <= 1) {
      next = 1
    } else if (this.queue.length === 0 && this.inFlightSet.size <= 1) {
      next = Math.max(MIN_CONCURRENCY, Math.min(previous, 1))
    } else if (failureRate >= HIGH_FAILURE_RATE || p95 >= HIGH_LATENCY_P95_MS) {
      next = Math.max(MIN_CONCURRENCY, previous - 1)
    } else if (
      backlogTier === 'very_large'
      && !activity.typing
      && failureRate <= LOW_FAILURE_RATE
      && p95 > 0
      && p95 <= MID_LATENCY_P95_MS
    ) {
      next = Math.min(hardMax, Math.max(previous, 4))
    } else if (
      backlogTier === 'large'
      && !activity.typing
      && failureRate <= LOW_FAILURE_RATE
      && p95 > 0
      && p95 <= MID_LATENCY_P95_MS
    ) {
      next = Math.min(hardMax, Math.max(previous, 3))
    } else if (this.queue.length >= previous * 2 && failureRate <= LOW_FAILURE_RATE && p95 > 0 && p95 <= LOW_LATENCY_P95_MS) {
      next = Math.min(hardMax, previous + 1)
    }

    next = Math.max(MIN_CONCURRENCY, Math.min(next, hardMax, visibleCap, typingCap))
    if (next !== this.adaptiveConcurrency) {
      this.adaptiveConcurrency = next
      this.emitStatus()
      this.kickWorkers()
    }
  }

  private snapshotStatus(): EmbeddingQueueStatus {
    const activity = activityMonitorService.getSnapshot()
    const backlogSize = this.getBacklogSize()
    const backlogTier = this.getBacklogTier()
    return {
      pending: this.queue.length,
      inFlight: this.inFlightSet.size,
      processed: this.processedCount,
      succeeded: this.succeededCount,
      failed: this.failedCount,
      running: this.runningWorkers > 0,
      schedulingMode: this.schedulingMode,
      configuredMaxConcurrency: this.maxConcurrency,
      effectiveConcurrency: this.getEffectiveConcurrency(),
      batchSize: this.getBatchSize(),
      avgTaskMs: this.getAvgDurationMs(),
      p95TaskMs: this.getP95DurationMs(),
      queueWaitAvgMs: this.getAvgQueueWaitMs(),
      queueWaitP95Ms: this.getP95QueueWaitMs(),
      activePathHitRate: this.getActivePathHitRate(),
      activePathHitSamples: this.recentActivePathHits.length,
      backlogSize,
      backlogTier,
      typingActive: activity.typing,
      typingPressure: activity.pressure,
      typingCharsPerSecond: activity.charsPerSecond,
      lastError: this.lastError,
      lastProcessedPath: this.lastProcessedPath,
      lastProcessedAt: this.lastProcessedAt,
      lastSuccessPath: this.lastSuccessPath,
      lastSuccessAt: this.lastSuccessAt,
      recentFailures: this.failureHistory.slice(0, MAX_FAILURE_HISTORY),
      updatedAt: Date.now(),
    }
  }

  private emitStatus(): void {
    const status = this.snapshotStatus()
    this.listeners.forEach((listener) => {
      try {
        listener(status)
      } catch (error) {
        console.warn('⚠️ Embedding queue listener failed:', error)
      }
    })
  }

  subscribe(listener: StatusListener, options?: { emitInitial?: boolean }): () => void {
    this.listeners.add(listener)
    if (options?.emitInitial !== false) {
      listener(this.snapshotStatus())
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  getStatus(): EmbeddingQueueStatus {
    return this.snapshotStatus()
  }

  getConcurrency(): number {
    return this.maxConcurrency
  }

  setActivePath(path: string | null): void {
    const normalized = path ? normalizeNotePath(path) : null
    const nextActive = normalized && isPotentialRetrievalPath(normalized) ? normalized : null
    if (nextActive === this.activePath) return
    this.activePath = nextActive
    if (nextActive) {
      this.boostQueuedPath(nextActive)
    }
    this.emitStatus()
    this.kickWorkers()
  }

  getSchedulingMode(): EmbeddingQueueSchedulingMode {
    return this.schedulingMode
  }

  setSchedulingMode(mode: EmbeddingQueueSchedulingMode): void {
    const next = mode === 'manual' ? 'manual' : 'adaptive'
    if (next === this.schedulingMode) return
    this.schedulingMode = next
    persistSchedulingMode(next)
    this.recalculateAdaptiveConcurrency('settings')
    this.emitStatus()
    this.kickWorkers()
  }

  setConcurrency(nextConcurrency: number): void {
    const next = clampConcurrency(nextConcurrency)
    if (next === this.maxConcurrency) return
    this.maxConcurrency = next
    this.adaptiveConcurrency = Math.min(this.adaptiveConcurrency, this.maxConcurrency)
    persistConcurrency(next)
    this.recalculateAdaptiveConcurrency('settings')
    this.emitStatus()
    this.kickWorkers()
  }

  private canRetryPath(path: string): boolean {
    const lastFailedAt = this.failureTimestamps.get(path)
    if (!lastFailedAt) return true
    if (Date.now() - lastFailedAt > FAILURE_COOLDOWN_MS) {
      this.failureTimestamps.delete(path)
      return true
    }
    return false
  }

  private boostQueuedPath(path: string): boolean {
    const index = this.queue.indexOf(path)
    if (index <= 0) return index === 0
    this.queue.splice(index, 1)
    this.queue.unshift(path)
    return true
  }

  private enqueueInternal(paths: string[], options?: { forceRetry?: boolean; priority?: 'normal' | 'high' }): string[] {
    const accepted = new Set<string>()
    const highPriorityAdds: string[] = []
    const normalPriorityAdds: string[] = []
    const unique = Array.from(new Set(paths.map((path) => normalizeNotePath(path)).filter((path) => isPotentialRetrievalPath(path))))

    for (const path of unique) {
      const isHighPriority = options?.priority === 'high' || (this.activePath !== null && path === this.activePath)

      if (this.inFlightSet.has(path)) continue

      if (this.queuedSet.has(path)) {
        if (isHighPriority && this.boostQueuedPath(path)) {
          accepted.add(path)
        }
        continue
      }

      if (!options?.forceRetry && !this.canRetryPath(path)) continue
      this.queuedSet.add(path)
      this.queuedAt.set(path, Date.now())
      accepted.add(path)
      if (isHighPriority) {
        highPriorityAdds.push(path)
      } else {
        normalPriorityAdds.push(path)
      }
    }

    for (let i = highPriorityAdds.length - 1; i >= 0; i -= 1) {
      this.queue.unshift(highPriorityAdds[i])
    }
    for (const path of normalPriorityAdds) {
      this.queue.push(path)
    }

    if (accepted.size > 0) {
      this.emitStatus()
      this.kickWorkers()
    }

    return Array.from(accepted)
  }

  enqueue(paths: string[], options?: { priority?: 'normal' | 'high' }): string[] {
    return this.enqueueInternal(paths, { priority: options?.priority })
  }

  enqueuePriority(paths: string[]): string[] {
    return this.enqueueInternal(paths, { priority: 'high' })
  }

  retryFailed(options?: { limit?: number }): string[] {
    const limit = Math.max(1, options?.limit ?? 8)
    const failedPaths = Array.from(
      new Set(
        this.failureHistory
          .slice()
          .sort((a, b) => b.at - a.at)
          .map((entry) => entry.path),
      ),
    ).slice(0, limit)

    if (failedPaths.length === 0) return []
    return this.enqueueInternal(failedPaths, { forceRetry: true })
  }

  clearFailures(): void {
    this.failureHistory = []
    this.lastError = null
    this.emitStatus()
  }

  async enqueueAndWait(paths: string[], options?: WaitOptions): Promise<number> {
    const accepted = this.enqueue(paths, { priority: options?.priority })
    if (accepted.length === 0) return 0

    const acceptedSet = new Set(accepted)
    const startTime = Date.now()
    const maxWaitMs = Math.max(200, options?.maxWaitMs ?? 1200)

    return new Promise<number>((resolve) => {
      let resolved = false
      let unsubscribe: (() => void) | null = null

      const cleanup = (result: number) => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        unsubscribe?.()
        resolve(result)
      }

      const countRecentSuccess = () => {
        let successCount = 0
        acceptedSet.forEach((path) => {
          const at = this.successTimestamps.get(path)
          if (at && at >= startTime) successCount += 1
        })
        return successCount
      }

      const timer = setTimeout(() => {
        cleanup(countRecentSuccess())
      }, maxWaitMs)

      const evaluate = () => {
        const successCount = countRecentSuccess()
        if (successCount > 0) {
          cleanup(successCount)
          return
        }

        const allDone = accepted.every((path) => !this.queuedSet.has(path) && !this.inFlightSet.has(path))
        if (allDone) {
          cleanup(0)
        }
      }

      unsubscribe = this.subscribe(() => evaluate(), { emitInitial: false })
      evaluate()
    })
  }

  private kickWorkers(): void {
    const effectiveConcurrency = this.getEffectiveConcurrency()
    while (this.runningWorkers < effectiveConcurrency && this.queue.length > 0) {
      void this.runWorker()
    }
  }

  private async runWorker(): Promise<void> {
    this.runningWorkers += 1
    this.emitStatus()

    try {
      while (this.queue.length > 0) {
        const batchSize = this.getBatchSize()
        const batch: string[] = []
        const batchQueueWaitMs = new Map<string, number>()
        const batchActiveHits = new Map<string, boolean>()
        while (batch.length < batchSize && this.queue.length > 0) {
          const path = this.queue.shift()
          if (!path) break
          const queuedAt = this.queuedAt.get(path)
          if (typeof queuedAt === 'number') {
            batchQueueWaitMs.set(path, Math.max(0, Date.now() - queuedAt))
          }
          this.queuedAt.delete(path)
          batchActiveHits.set(path, this.activePath !== null && path === this.activePath)
          this.queuedSet.delete(path)
          this.inFlightSet.add(path)
          batch.push(path)
        }
        if (batch.length === 0) break
        this.emitStatus()

        for (const nextPath of batch) {
          const taskStart = Date.now()
          let taskOutcome: 'success' | 'failed' = 'failed'

          try {
            const readable = await vaultService.readFileForAI(nextPath)
            if (!isRetrievalEligibleAIReadable(nextPath, readable)) {
              throw new Error('OCR text was not strong enough for retrieval or embedding.')
            }
            const content = readable.content
            if (!content.trim()) {
              throw new Error('Cannot embed an empty note')
            }

            const embedding = await generateAdaptiveEmbedding(content, (chunk) => localAiService.generateEmbedding(chunk))
            embedding.content_hash = computeContentHash(content).toLowerCase()
            await vaultService.writeEmbedding(nextPath, embedding)

            this.processedCount += 1
            this.succeededCount += 1
            this.successTimestamps.set(nextPath, Date.now())
            this.lastProcessedPath = nextPath
            this.lastProcessedAt = Date.now()
            this.lastSuccessPath = nextPath
            this.lastSuccessAt = Date.now()
            this.failureTimestamps.delete(nextPath)
            this.failureHistory = this.failureHistory.filter((entry) => entry.path !== nextPath)
            this.lastError = null
            taskOutcome = 'success'
          } catch (error) {
            this.processedCount += 1
            this.failedCount += 1
            const failureAt = Date.now()
            const failureMessage = error instanceof Error ? error.message : 'Unknown embedding queue error'
            const priorRetryCount = this.failureHistory.find((entry) => entry.path === nextPath)?.retryCount || 0
            this.failureTimestamps.set(nextPath, failureAt)
            this.lastProcessedPath = nextPath
            this.lastProcessedAt = failureAt
            this.lastError = failureMessage
            this.failureHistory = [
              { path: nextPath, error: failureMessage, at: failureAt, retryCount: priorRetryCount + 1 },
              ...this.failureHistory.filter((entry) => entry.path !== nextPath),
            ].slice(0, MAX_FAILURE_HISTORY)
            console.warn(`⚠️ Background embedding failed for ${nextPath}:`, error)
          } finally {
            const durationMs = Date.now() - taskStart
            this.rememberTask(durationMs, taskOutcome)
            this.rememberQueueWait(batchQueueWaitMs.get(nextPath) ?? 0)
            this.rememberActivePathHit(batchActiveHits.get(nextPath) ?? false)
            this.inFlightSet.delete(nextPath)
            this.emitStatus()
          }
        }

        this.recalculateAdaptiveConcurrency('task')

        const activity = activityMonitorService.getSnapshot()
        if (activity.typing && typeof window !== 'undefined') {
          await new Promise<void>((resolve) => window.setTimeout(resolve, BATCH_YIELD_MS_TYPING))
        }
      }
    } finally {
      this.runningWorkers = Math.max(0, this.runningWorkers - 1)
      this.emitStatus()
      if (this.queue.length > 0) {
        this.kickWorkers()
      }
    }
  }
}

export const embeddingQueueService = new EmbeddingQueueService()
