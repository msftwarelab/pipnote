import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cosineSimilarity,
  rankEmbeddingCandidates,
  rankSemanticEntries,
  type EmbeddingCandidateInput,
  type SemanticRankInput,
} from '../src/utils/indexCompute.ts'

test('cosineSimilarity handles identical and orthogonal vectors', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.equal(cosineSimilarity([], []), 0)
  assert.equal(cosineSimilarity([1, 2], [1]), 0)
})

test('rankSemanticEntries prefers best chunk similarity per note', () => {
  const input: SemanticRankInput = {
    queryEmbedding: [1, 0, 0],
    topK: 2,
    entries: [
      {
        path: 'alpha.md',
        embedding: [0.3, 0.7, 0],
        chunks: [
          {
            index: 0,
            start: 0,
            end: 12,
            excerpt: 'alpha chunk',
            embedding: [1, 0, 0],
          },
        ],
      },
      {
        path: 'beta.md',
        embedding: [0.8, 0.2, 0],
        chunks: [],
      },
      {
        path: 'gamma.md',
        embedding: [0, 1, 0],
        chunks: [],
      },
    ],
  }

  const ranked = rankSemanticEntries(input)
  assert.equal(ranked.length, 2)
  assert.equal(ranked[0].path, 'alpha.md')
  assert.equal(ranked[0].content, 'alpha chunk')
  assert.ok(ranked[0].similarity >= ranked[1].similarity)
})

test('rankEmbeddingCandidates filters source, dimensions, and limits', () => {
  const input: EmbeddingCandidateInput = {
    sourcePath: 'root/a.md',
    sourceEmbedding: [1, 0],
    minSimilarity: 0.2,
    limit: 2,
    entries: [
      { path: 'root/a.md', embedding: [1, 0] },
      { path: 'root/b.md', embedding: [0.9, 0.1] },
      { path: 'root/c.md', embedding: [0.8, 0.2] },
      { path: 'root/d.md', embedding: [0, 1] },
      { path: 'root/e.md', embedding: [1, 0, 0] },
    ],
  }

  const ranked = rankEmbeddingCandidates(input)
  assert.equal(ranked.length, 2)
  assert.deepEqual(
    ranked.map((item) => item.path),
    ['root/b.md', 'root/c.md'],
  )
  assert.ok(ranked[0].similarity >= ranked[1].similarity)
})
