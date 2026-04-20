import type {
  EmbeddingCandidateInput,
  EmbeddingCandidateResult,
  SemanticRankInput,
  SemanticRankResult,
} from '../utils/indexCompute'

export type IndexComputeTaskType = 'semantic-rank' | 'embedding-candidates'

export interface IndexComputeRequestPayloadByType {
  'semantic-rank': SemanticRankInput
  'embedding-candidates': EmbeddingCandidateInput
}

export interface IndexComputeResponsePayloadByType {
  'semantic-rank': SemanticRankResult[]
  'embedding-candidates': EmbeddingCandidateResult[]
}

type IndexComputeRequest<T extends IndexComputeTaskType> = {
  id: number
  type: T
  payload: IndexComputeRequestPayloadByType[T]
}

type IndexComputeSuccess<T extends IndexComputeTaskType> = {
  id: number
  ok: true
  type: T
  payload: IndexComputeResponsePayloadByType[T]
}

type IndexComputeFailure = {
  id: number
  ok: false
  type: IndexComputeTaskType
  error: string
}

export type IndexComputeWorkerRequest =
  | IndexComputeRequest<'semantic-rank'>
  | IndexComputeRequest<'embedding-candidates'>

export type IndexComputeWorkerResponse =
  | IndexComputeSuccess<'semantic-rank'>
  | IndexComputeSuccess<'embedding-candidates'>
  | IndexComputeFailure
