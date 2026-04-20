import test from 'node:test'
import assert from 'node:assert/strict'
import { generateAdaptiveEmbedding, splitContentIntoAdaptiveChunks } from '../src/utils/adaptiveEmbedding.ts'

function longContent(): string {
  const paragraph = 'This is a long note paragraph about retrieval augmented generation, embeddings, and note organization.'
  return Array.from({ length: 80 }, (_, idx) => `${idx + 1}. ${paragraph}`).join('\n\n')
}

test('splitContentIntoAdaptiveChunks returns one chunk for short content', () => {
  const chunks = splitContentIntoAdaptiveChunks('short content', { chunkThresholdChars: 200 })
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].text, 'short content')
})

test('splitContentIntoAdaptiveChunks splits long content with ordering', () => {
  const chunks = splitContentIntoAdaptiveChunks(longContent(), {
    chunkThresholdChars: 400,
    targetChunkChars: 500,
    maxChunks: 6,
  })
  assert.ok(chunks.length > 1)
  for (let i = 1; i < chunks.length; i += 1) {
    assert.ok(chunks[i].start >= chunks[i - 1].start)
    assert.ok(chunks[i].end >= chunks[i].start)
  }
})

test('splitContentIntoAdaptiveChunks keeps giant documents bounded per chunk', () => {
  const giant = Array.from({ length: 1200 }, (_, idx) => `Section ${idx + 1}: ${'A'.repeat(120)}`).join('\n\n')
  const chunks = splitContentIntoAdaptiveChunks(giant, {
    chunkThresholdChars: 400,
    targetChunkChars: 500,
    maxChunks: 6,
  })

  assert.equal(chunks.length, 6)
  assert.ok(chunks.every((chunk) => chunk.text.length <= 700))
  assert.ok(chunks[0].start < chunks[chunks.length - 1].start)
})

test('splitContentIntoAdaptiveChunks sanitizes problematic control and private-use characters', () => {
  const chunks = splitContentIntoAdaptiveChunks(`Hello\u0007 world \uE201 data`, {
    chunkThresholdChars: 10,
    targetChunkChars: 40,
    maxChunks: 2,
  })

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].text.includes('\u0007'), false)
  assert.equal(chunks[0].text.includes('\uE201'), false)
})

test('generateAdaptiveEmbedding pools vectors and returns chunk metadata for long notes', async () => {
  let calls = 0
  const generated = await generateAdaptiveEmbedding(
    longContent(),
    async (chunk) => {
      calls += 1
      return {
        embedding: [chunk.length, chunk.length / 2, 1],
        model: 'mock-embed',
        created_at: '2026-03-05T00:00:00.000Z',
      }
    },
    {
      chunkThresholdChars: 400,
      targetChunkChars: 500,
      maxChunks: 5,
      chunkConcurrency: 2,
    },
  )

  assert.ok(calls > 1)
  assert.equal(generated.model, 'mock-embed')
  assert.equal(generated.created_at, '2026-03-05T00:00:00.000Z')
  assert.ok(Array.isArray(generated.embedding))
  assert.ok(generated.embedding.length === 3)
  assert.ok(Array.isArray(generated.chunks))
  assert.ok((generated.chunks || []).length > 1)
  assert.ok((generated.chunks || []).every((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length === 3))
  assert.ok((generated.chunks || []).every((chunk) => typeof chunk.excerpt === 'string' && chunk.excerpt.length > 0))
})
