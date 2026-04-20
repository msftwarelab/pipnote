export interface EmbeddingChunkData {
  index: number
  start: number
  end: number
  excerpt: string
  embedding: number[]
  content_hash?: string
}

export interface EmbeddingRecord {
  embedding: number[]
  model: string
  created_at: string
  content_hash?: string
  chunks?: EmbeddingChunkData[]
}

