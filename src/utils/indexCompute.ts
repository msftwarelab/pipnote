import type { EmbeddingChunkData } from '../types/embedding'

export interface SemanticRankEntry {
  path: string
  embedding: number[]
  chunks: EmbeddingChunkData[]
}

export interface SemanticRankInput {
  queryEmbedding: number[]
  entries: SemanticRankEntry[]
  topK: number
}

export interface SemanticRankResult {
  path: string
  similarity: number
  content?: string
}

export interface EmbeddingCandidateEntry {
  path: string
  embedding: number[]
}

export interface EmbeddingCandidateInput {
  sourcePath: string
  sourceEmbedding: number[]
  entries: EmbeddingCandidateEntry[]
  minSimilarity: number
  limit: number
}

export interface EmbeddingCandidateResult {
  path: string
  similarity: number
}

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length === 0 || vecA.length !== vecB.length) return 0

  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < vecA.length; i += 1) {
    dot += vecA[i] * vecB[i]
    magA += vecA[i] * vecA[i]
    magB += vecB[i] * vecB[i]
  }

  if (magA === 0 || magB === 0) return 0
  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

export function rankSemanticEntries(input: SemanticRankInput): SemanticRankResult[] {
  const topK = Math.max(1, input.topK)
  const query = input.queryEmbedding
  const scored: SemanticRankResult[] = []

  for (const entry of input.entries) {
    let bestSimilarity = -1
    let bestSnippet = ''

    if (Array.isArray(entry.embedding) && entry.embedding.length === query.length) {
      bestSimilarity = cosineSimilarity(query, entry.embedding)
    }

    if (Array.isArray(entry.chunks)) {
      for (const chunk of entry.chunks) {
        if (!Array.isArray(chunk.embedding) || chunk.embedding.length !== query.length) continue
        const chunkSimilarity = cosineSimilarity(query, chunk.embedding)
        if (chunkSimilarity > bestSimilarity) {
          bestSimilarity = chunkSimilarity
          bestSnippet = chunk.excerpt || bestSnippet
        }
      }
    }

    if (bestSimilarity < 0) continue
    scored.push({
      path: entry.path,
      similarity: bestSimilarity,
      content: bestSnippet || undefined,
    })
  }

  scored.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity
    return a.path.localeCompare(b.path)
  })

  return scored.slice(0, topK)
}

export function rankEmbeddingCandidates(input: EmbeddingCandidateInput): EmbeddingCandidateResult[] {
  const sourcePath = input.sourcePath
  const sourceEmbedding = input.sourceEmbedding
  const minSimilarity = Math.max(0, input.minSimilarity)
  const limit = Math.max(1, input.limit)

  const ranked: EmbeddingCandidateResult[] = []
  for (const entry of input.entries) {
    if (entry.path === sourcePath) continue
    if (!Array.isArray(entry.embedding) || entry.embedding.length !== sourceEmbedding.length) continue
    const similarity = Math.max(0, cosineSimilarity(sourceEmbedding, entry.embedding))
    if (similarity < minSimilarity) continue
    ranked.push({
      path: entry.path,
      similarity,
    })
  }

  ranked.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity
    return a.path.localeCompare(b.path)
  })

  return ranked.slice(0, limit)
}
