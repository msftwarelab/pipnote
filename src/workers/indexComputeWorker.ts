/// <reference lib="webworker" />

import type { IndexComputeWorkerRequest, IndexComputeWorkerResponse } from '../types/indexComputeWorker'
import { rankEmbeddingCandidates, rankSemanticEntries } from '../utils/indexCompute'

const workerScope = self as unknown as DedicatedWorkerGlobalScope

workerScope.onmessage = (event: MessageEvent<IndexComputeWorkerRequest>) => {
  const request = event.data
  const send = (response: IndexComputeWorkerResponse) => {
    workerScope.postMessage(response)
  }

  try {
    if (request.type === 'semantic-rank') {
      const ranked = rankSemanticEntries(request.payload)
      send({
        id: request.id,
        ok: true,
        type: request.type,
        payload: ranked,
      })
      return
    }

    const ranked = rankEmbeddingCandidates(request.payload)
    send({
      id: request.id,
      ok: true,
      type: request.type,
      payload: ranked,
    })
  } catch (error) {
    send({
      id: request.id,
      ok: false,
      type: request.type,
      error: error instanceof Error ? error.message : 'Worker computation failed',
    })
  }
}
