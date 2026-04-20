import { computeContentHash } from './contentHash.ts'
import type { EmbeddingChunkData, EmbeddingRecord } from '../types/embedding.ts'

const DEFAULT_CHUNK_THRESHOLD_CHARS = 2200
const DEFAULT_TARGET_CHUNK_CHARS = 1200
const DEFAULT_CHUNK_OVERLAP_CHARS = 180
const DEFAULT_MAX_CHUNKS = 8
const DEFAULT_CHUNK_CONCURRENCY = 2
const DEFAULT_MIN_CHUNK_CHARS = 420
const DEFAULT_EXCERPT_CHARS = 220

export interface AdaptiveEmbeddingOptions {
  chunkThresholdChars?: number
  targetChunkChars?: number
  chunkOverlapChars?: number
  maxChunks?: number
  chunkConcurrency?: number
  excerptChars?: number
}

interface ChunkDraft {
  index: number
  start: number
  end: number
  text: string
}

interface EmbeddingGenerateResult {
  embedding: number[]
  model?: string
  created_at?: string
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function stripProblematicCharacters(value: string): string {
  let next = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    const isControl = (code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || (code >= 127 && code <= 159)
    const isPrivateUse = code >= 0xe000 && code <= 0xf8ff
    next += isControl || isPrivateUse ? ' ' : char
  }
  return next
}

function sanitizeEmbeddingText(value: string): string {
  return stripProblematicCharacters(value.normalize('NFKC'))
    .replace(/\s+/g, ' ')
    .trim()
}

function chunkExcerpt(text: string, maxChars: number): string {
  const compact = normalizeSpace(text)
  if (compact.length <= maxChars) return compact
  return `${compact.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
}

function pickChunkEnd(content: string, start: number, targetChars: number, minChunkChars: number): number {
  const len = content.length
  if (start >= len) return len

  const ideal = Math.min(len, start + targetChars)
  if (ideal >= len) return len

  const minEnd = Math.min(len, start + minChunkChars)
  const breakCandidates = ['\n\n', '\n', '. ', '! ', '? ', '; ', ', ']
  let best = -1

  for (const marker of breakCandidates) {
    const idx = content.lastIndexOf(marker, ideal)
    if (idx >= minEnd) {
      const candidateEnd = idx + marker.length
      if (candidateEnd > best) {
        best = candidateEnd
      }
    }
  }

  if (best > 0) return best
  return ideal
}

export function splitContentIntoAdaptiveChunks(content: string, options?: AdaptiveEmbeddingOptions): ChunkDraft[] {
  const normalized = sanitizeEmbeddingText(content.replace(/\r\n/g, '\n'))
  if (!normalized) return []

  const targetChunkChars = Math.max(520, options?.targetChunkChars ?? DEFAULT_TARGET_CHUNK_CHARS)
  const chunkOverlapChars = Math.max(40, Math.min(targetChunkChars / 2, options?.chunkOverlapChars ?? DEFAULT_CHUNK_OVERLAP_CHARS))
  const maxChunks = Math.max(1, options?.maxChunks ?? DEFAULT_MAX_CHUNKS)
  const minChunkChars = Math.max(220, Math.min(targetChunkChars - 80, DEFAULT_MIN_CHUNK_CHARS))

  if (normalized.length <= (options?.chunkThresholdChars ?? DEFAULT_CHUNK_THRESHOLD_CHARS)) {
    return [{ index: 0, start: 0, end: normalized.length, text: normalized }]
  }

  const chunks: ChunkDraft[] = []
  let start = 0
  let guard = 0
  const hardMaxCoveredChars = targetChunkChars * maxChunks

  if (normalized.length > hardMaxCoveredChars) {
    const stride = Math.max(targetChunkChars, Math.floor((normalized.length - targetChunkChars) / Math.max(1, maxChunks - 1)))
    for (let index = 0; index < maxChunks; index += 1) {
      const rawStart = Math.min(
        normalized.length - targetChunkChars,
        Math.max(0, index * stride),
      )
      const end = pickChunkEnd(normalized, rawStart, targetChunkChars, minChunkChars)
      const text = normalized.slice(rawStart, Math.min(normalized.length, Math.max(end, rawStart + minChunkChars))).trim()
      if (!text) continue
      chunks.push({
        index: chunks.length,
        start: rawStart,
        end: Math.min(normalized.length, rawStart + text.length),
        text,
      })
    }

    return chunks.length > 0 ? chunks : [{ index: 0, start: 0, end: Math.min(normalized.length, targetChunkChars), text: normalized.slice(0, targetChunkChars).trim() }]
  }

  while (start < normalized.length && guard < 3000) {
    guard += 1
    const end = pickChunkEnd(normalized, start, targetChunkChars, minChunkChars)

    const text = normalized.slice(start, end).trim()
    if (text.length > 0) {
      chunks.push({
        index: chunks.length,
        start,
        end,
        text,
      })
    }

    if (end >= normalized.length || chunks.length >= maxChunks) {
      break
    }

    const nextStart = Math.max(start + 1, end - chunkOverlapChars)
    if (nextStart <= start) break
    start = nextStart
  }

  if (chunks.length === 0) {
    chunks.push({ index: 0, start: 0, end: normalized.length, text: normalized })
  }

  return chunks
}

function meanPoolVectors(vectors: number[][]): number[] {
  if (vectors.length === 0) return []
  const dimension = vectors[0].length
  if (dimension === 0) return []
  const compatible = vectors.filter((vector) => vector.length === dimension)
  if (compatible.length === 0) return []

  const sums = new Array<number>(dimension).fill(0)
  for (const vector of compatible) {
    for (let i = 0; i < dimension; i += 1) {
      sums[i] += vector[i]
    }
  }
  return sums.map((sum) => sum / compatible.length)
}

async function runWithConcurrency<T>(
  items: T[],
  maxConcurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return

  const queue = items.map((item, index) => ({ item, index }))
  const concurrency = Math.max(1, Math.min(maxConcurrency, items.length))

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const next = queue.shift()
        if (!next) break
        await worker(next.item, next.index)
      }
    }),
  )
}

export async function generateAdaptiveEmbedding(
  content: string,
  generate: (contentChunk: string) => Promise<EmbeddingGenerateResult>,
  options?: AdaptiveEmbeddingOptions,
): Promise<EmbeddingRecord> {
  const chunks = splitContentIntoAdaptiveChunks(content, options)
  if (chunks.length === 0) {
    throw new Error('Cannot generate embedding for empty content')
  }

  if (chunks.length === 1) {
    const single = await generate(chunks[0].text)
    return {
      embedding: single.embedding,
      model: single.model || 'unknown',
      created_at: single.created_at || new Date().toISOString(),
    }
  }

  const excerptChars = Math.max(80, options?.excerptChars ?? DEFAULT_EXCERPT_CHARS)
  const chunkConcurrency = Math.max(1, options?.chunkConcurrency ?? DEFAULT_CHUNK_CONCURRENCY)
  const generated: Array<{ chunk: ChunkDraft; embedding: EmbeddingGenerateResult }> = []

  await runWithConcurrency(chunks, chunkConcurrency, async (chunk) => {
    const embedded = await generate(chunk.text)
    if (!Array.isArray(embedded.embedding) || embedded.embedding.length === 0) return
    generated.push({ chunk, embedding: embedded })
  })

  if (generated.length === 0) {
    throw new Error('Failed to generate adaptive embeddings for all chunks')
  }

  generated.sort((a, b) => a.chunk.index - b.chunk.index)

  const vectors = generated.map((entry) => entry.embedding.embedding)
  const pooled = meanPoolVectors(vectors)
  const first = generated[0].embedding
  const chunkPayloads: EmbeddingChunkData[] = generated.map(({ chunk, embedding }) => ({
    index: chunk.index,
    start: chunk.start,
    end: chunk.end,
    excerpt: chunkExcerpt(chunk.text, excerptChars),
    embedding: embedding.embedding,
    content_hash: computeContentHash(chunk.text).toLowerCase(),
  }))

  return {
    embedding: pooled.length > 0 ? pooled : first.embedding,
    model: first.model || 'unknown',
    created_at: first.created_at || new Date().toISOString(),
    chunks: chunkPayloads,
  }
}
