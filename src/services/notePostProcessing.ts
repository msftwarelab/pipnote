import { embeddingQueueService } from './embeddingQueue'
import { factsService } from './facts'
import { relatedNotesService } from './relatedNotes'
import { activityMonitorService } from './activityMonitor'
import { computeContentHash } from '../utils/contentHash'
import { isIndexableNotePath, normalizeNotePath } from '../utils/noteScope'

const EMBEDDING_DEBOUNCE_MS = 1200
const POST_PROCESS_DEBOUNCE_MS = 2200
const POST_PROCESS_BUSY_RETRY_MS = 760
const POST_PROCESS_FRAME_YIELD_MS = 24

type EmbeddingPriority = 'normal' | 'high'

interface ScheduleOptions {
  embeddingPriority?: EmbeddingPriority
}

export interface NotePostProcessingStatus {
  pending: number
  queued: number
  scheduled: number
  inFlight: number
  running: boolean
  processed: number
  lastProcessedPath: string | null
  lastProcessedAt: number | null
}

type NotePostProcessingListener = (status: NotePostProcessingStatus) => void

class NotePostProcessingService {
  private embeddingTimers = new Map<string, number>()
  private postProcessTimers = new Map<string, number>()
  private latestContent = new Map<string, string>()
  private latestHashes = new Map<string, string>()
  private latestEmbeddingPriority = new Map<string, EmbeddingPriority>()
  private lastEmbeddedHashes = new Map<string, string>()
  private lastProcessedHashes = new Map<string, string>()
  private inFlight = new Set<string>()
  private queue: string[] = []
  private queued = new Set<string>()
  private queueTimer: number | null = null
  private queueRunning = false
  private listeners = new Set<NotePostProcessingListener>()
  private processedCount = 0
  private lastProcessedPath: string | null = null
  private lastProcessedAt: number | null = null

  private snapshotStatus(): NotePostProcessingStatus {
    return {
      pending: this.queue.length + this.postProcessTimers.size + this.inFlight.size,
      queued: this.queue.length,
      scheduled: this.postProcessTimers.size,
      inFlight: this.inFlight.size,
      running: this.queueRunning,
      processed: this.processedCount,
      lastProcessedPath: this.lastProcessedPath,
      lastProcessedAt: this.lastProcessedAt,
    }
  }

  private emitStatus(): void {
    const snapshot = this.snapshotStatus()
    this.listeners.forEach((listener) => {
      try {
        listener(snapshot)
      } catch (error) {
        console.warn('⚠️ Post-processing status listener failed:', error)
      }
    })
  }

  getStatus(): NotePostProcessingStatus {
    return this.snapshotStatus()
  }

  subscribe(listener: NotePostProcessingListener): () => void {
    this.listeners.add(listener)
    listener(this.snapshotStatus())
    return () => {
      this.listeners.delete(listener)
    }
  }

  private shouldYieldForEditor(): boolean {
    const snapshot = activityMonitorService.getSnapshot()
    return snapshot.typing && (snapshot.pressure === 'high' || snapshot.pressure === 'medium')
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      window.setTimeout(() => resolve(), ms)
    })
  }

  private enqueuePostProcess(path: string, delayMs = 0): void {
    if (!this.queued.has(path)) {
      this.queued.add(path)
      this.queue.push(path)
      this.emitStatus()
    }
    this.scheduleQueuePump(delayMs)
  }

  private scheduleQueuePump(delayMs = 0): void {
    if (this.queueRunning) return
    if (this.queueTimer) return
    this.queueTimer = window.setTimeout(() => {
      this.queueTimer = null
      void this.processQueue()
    }, delayMs)
    this.emitStatus()
  }

  private async processQueue(): Promise<void> {
    if (this.queueRunning) return
    this.queueRunning = true
    this.emitStatus()
    try {
      while (this.queue.length > 0) {
        if (this.shouldYieldForEditor()) {
          await this.sleep(POST_PROCESS_BUSY_RETRY_MS)
          continue
        }

        const path = this.queue.shift()
        if (!path) continue
        this.queued.delete(path)
        this.emitStatus()
        await this.processPath(path)
        await this.sleep(POST_PROCESS_FRAME_YIELD_MS)
      }
    } finally {
      this.queueRunning = false
      this.emitStatus()
      if (this.queue.length > 0) {
        this.scheduleQueuePump(POST_PROCESS_FRAME_YIELD_MS)
      }
    }
  }

  schedule(path: string, content: string, options?: ScheduleOptions): void {
    const normalized = normalizeNotePath(path)
    if (!isIndexableNotePath(normalized)) return

    const hash = computeContentHash(content)
    const requestedPriority: EmbeddingPriority = options?.embeddingPriority === 'high' ? 'high' : 'normal'
    const existingPriority = this.latestEmbeddingPriority.get(normalized) ?? 'normal'
    const effectivePriority: EmbeddingPriority = existingPriority === 'high' || requestedPriority === 'high' ? 'high' : 'normal'
    this.latestContent.set(normalized, content)
    this.latestHashes.set(normalized, hash)
    this.latestEmbeddingPriority.set(normalized, effectivePriority)

    const embedExisting = this.embeddingTimers.get(normalized)
    if (embedExisting) {
      window.clearTimeout(embedExisting)
    }

    const embedTimer = window.setTimeout(() => {
      this.embeddingTimers.delete(normalized)
      const latestHash = this.latestHashes.get(normalized)
      if (!latestHash) return
      const lastEmbeddedHash = this.lastEmbeddedHashes.get(normalized)
      if (latestHash === lastEmbeddedHash) return
      const priority = this.latestEmbeddingPriority.get(normalized) ?? 'normal'
      embeddingQueueService.enqueue([normalized], { priority })
      this.lastEmbeddedHashes.set(normalized, latestHash)
      this.latestEmbeddingPriority.delete(normalized)
    }, EMBEDDING_DEBOUNCE_MS)
    this.embeddingTimers.set(normalized, embedTimer)

    const existing = this.postProcessTimers.get(normalized)
    if (existing) {
      window.clearTimeout(existing)
    }

    const timer = window.setTimeout(() => {
      this.postProcessTimers.delete(normalized)
      this.emitStatus()
      this.enqueuePostProcess(normalized)
    }, POST_PROCESS_DEBOUNCE_MS)
    this.postProcessTimers.set(normalized, timer)
    this.emitStatus()
  }

  private async processPath(path: string): Promise<void> {
    if (this.inFlight.has(path)) return
    this.inFlight.add(path)
    this.emitStatus()

    try {
      const content = this.latestContent.get(path) || ''
      const hash = this.latestHashes.get(path) || computeContentHash(content)
      const lastProcessedHash = this.lastProcessedHashes.get(path)
      if (hash === lastProcessedHash) return

      try {
        await factsService.updateFactsForNote(path, content)
      } catch (error) {
        console.warn(`⚠️ Failed to refresh facts for ${path}:`, error)
      }

      if (this.shouldYieldForEditor()) {
        await this.sleep(POST_PROCESS_BUSY_RETRY_MS)
      }

      try {
        await relatedNotesService.updateForNote(path, content, { forceRefresh: false })
      } catch (error) {
        console.warn(`⚠️ Failed to refresh related notes for ${path}:`, error)
      }

      this.processedCount += 1
      this.lastProcessedPath = path
      this.lastProcessedAt = Date.now()
      this.lastProcessedHashes.set(path, hash)
    } finally {
      this.inFlight.delete(path)
      this.emitStatus()
      const latestHash = this.latestHashes.get(path)
      const processedHash = this.lastProcessedHashes.get(path)
      if (latestHash && latestHash !== processedHash) {
        this.enqueuePostProcess(path, 600)
      }
    }
  }
}

export const notePostProcessingService = new NotePostProcessingService()
