import type {
  IndexComputeRequestPayloadByType,
  IndexComputeResponsePayloadByType,
  IndexComputeTaskType,
  IndexComputeWorkerRequest,
  IndexComputeWorkerResponse,
} from '../types/indexComputeWorker'
import {
  rankEmbeddingCandidates,
  rankSemanticEntries,
  type EmbeddingCandidateInput,
  type EmbeddingCandidateResult,
  type SemanticRankInput,
  type SemanticRankResult,
} from '../utils/indexCompute'

const WORKER_TASK_TIMEOUT_MS = 15_000

interface PendingTask {
  type: IndexComputeTaskType
  timeoutId: number
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

class IndexComputeWorkerService {
  private worker: Worker | null = null
  private disabled = false
  private nextRequestId = 1
  private pending = new Map<number, PendingTask>()
  private loggedFallback = false

  private handleMessage = (event: MessageEvent<IndexComputeWorkerResponse>): void => {
    const response = event.data
    const pendingTask = this.pending.get(response.id)
    if (!pendingTask) return

    this.pending.delete(response.id)
    window.clearTimeout(pendingTask.timeoutId)

    if (response.ok) {
      pendingTask.resolve(response.payload)
      return
    }

    pendingTask.reject(new Error(response.error || `${pendingTask.type} worker task failed`))
  }

  private disableWorker(reason: string): void {
    if (this.disabled) return
    this.disabled = true

    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }

    for (const [id, pendingTask] of this.pending.entries()) {
      this.pending.delete(id)
      window.clearTimeout(pendingTask.timeoutId)
      pendingTask.reject(new Error(reason))
    }
  }

  private ensureWorker(): Worker | null {
    if (this.disabled || typeof Worker === 'undefined') return null
    if (this.worker) return this.worker

    try {
      const worker = new Worker(new URL('../workers/indexComputeWorker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = this.handleMessage
      worker.onerror = (event) => {
        const message = event.message || 'Index compute worker crashed'
        console.warn('⚠️ Index compute worker disabled:', message)
        this.disableWorker(message)
      }
      this.worker = worker
      return worker
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to initialize index compute worker'
      console.warn('⚠️ Index compute worker unavailable:', message)
      this.disableWorker(message)
      return null
    }
  }

  private async request<TType extends IndexComputeTaskType>(
    type: TType,
    payload: IndexComputeRequestPayloadByType[TType],
  ): Promise<IndexComputeResponsePayloadByType[TType]> {
    const worker = this.ensureWorker()
    if (!worker) {
      throw new Error('Index compute worker unavailable')
    }

    const requestId = this.nextRequestId
    this.nextRequestId += 1

    return await new Promise<IndexComputeResponsePayloadByType[TType]>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`${type} worker task timed out`))
      }, WORKER_TASK_TIMEOUT_MS)

      const task: PendingTask = {
        type,
        timeoutId,
        resolve: (value) => resolve(value as IndexComputeResponsePayloadByType[TType]),
        reject,
      }
      this.pending.set(requestId, task)

      const request: IndexComputeWorkerRequest = {
        id: requestId,
        type,
        payload,
      } as IndexComputeWorkerRequest

      worker.postMessage(request)
    })
  }

  private logFallbackOnce(error: unknown): void {
    if (this.loggedFallback) return
    this.loggedFallback = true
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`⚠️ Falling back to main-thread index compute: ${message}`)
  }

  async rankSemantic(
    input: SemanticRankInput,
    options?: { forceInline?: boolean },
  ): Promise<SemanticRankResult[]> {
    if (options?.forceInline) {
      return rankSemanticEntries(input)
    }

    try {
      return await this.request('semantic-rank', input)
    } catch (error) {
      this.logFallbackOnce(error)
      return rankSemanticEntries(input)
    }
  }

  async rankEmbeddingCandidates(
    input: EmbeddingCandidateInput,
    options?: { forceInline?: boolean },
  ): Promise<EmbeddingCandidateResult[]> {
    if (options?.forceInline) {
      return rankEmbeddingCandidates(input)
    }

    try {
      return await this.request('embedding-candidates', input)
    } catch (error) {
      this.logFallbackOnce(error)
      return rankEmbeddingCandidates(input)
    }
  }
}

export const indexComputeWorkerService = new IndexComputeWorkerService()
