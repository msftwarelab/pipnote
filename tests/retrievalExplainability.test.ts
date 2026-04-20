import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRetrievalExplanation } from '../src/utils/retrievalExplainability.ts'

test('buildRetrievalExplanation describes hybrid matches with path evidence', () => {
  const explanation = buildRetrievalExplanation({
    semanticSimilarity: 0.81,
    keywordSimilarity: 0.63,
    matchedPathTerms: ['interview', 'bedrock'],
  })

  assert.ok(explanation)
  assert.match(explanation!.summary, /meaning/i)
  assert.match(explanation!.summary, /"interview"/i)
  assert.deepEqual(explanation!.tags, ['Semantic match', 'Keyword match', 'Title/path match'])
})

test('buildRetrievalExplanation describes semantic-only hits cleanly', () => {
  const explanation = buildRetrievalExplanation({
    semanticSimilarity: 0.77,
  })

  assert.ok(explanation)
  assert.match(explanation!.summary, /semantic/i)
  assert.deepEqual(explanation!.tags, ['Semantic match'])
})

test('buildRetrievalExplanation describes keyword path hits cleanly', () => {
  const explanation = buildRetrievalExplanation({
    keywordSimilarity: 0.58,
    matchedPathTerms: ['wedding', 'date'],
  })

  assert.ok(explanation)
  assert.match(explanation!.summary, /file name or folder path/i)
  assert.deepEqual(explanation!.tags, ['Keyword match', 'Title/path match'])
})

test('buildRetrievalExplanation returns nothing when no evidence exists', () => {
  assert.equal(buildRetrievalExplanation({}), undefined)
})
