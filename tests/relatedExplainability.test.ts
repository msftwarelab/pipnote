import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRelatedExplanation } from '../src/utils/relatedExplainability.ts'
import type { RelatedNoteSuggestion } from '../src/services/relatedNotes.ts'

function makeRelated(partial: Partial<RelatedNoteSuggestion>): RelatedNoteSuggestion {
  return {
    path: 'Career/Interview Prep/Bedrock.md',
    score: 0.81,
    confidence: 'high',
    reason: 'Shared keywords: bedrock, interview',
    reasonTags: ['shared keywords', 'same area'],
    signals: {
      semantic: 0.76,
      keyword: 0.64,
      title: 0.2,
      entity: 0.12,
    },
    ...partial,
  }
}

test('buildRelatedExplanation describes very similar topics', () => {
  const explanation = buildRelatedExplanation(makeRelated({
    reasonTags: ['same topic', 'shared keywords'],
  }))

  assert.match(explanation.summary, /very similar topic/i)
  assert.deepEqual(explanation.tags, ['same topic', 'shared keywords'])
})

test('buildRelatedExplanation preserves shared entity explanations', () => {
  const explanation = buildRelatedExplanation(makeRelated({
    reason: 'Shared people/topics: Julian, Bedrock',
    reasonTags: ['shared person/topic', 'same area'],
    signals: {
      semantic: 0.52,
      keyword: 0.18,
      title: 0.14,
      entity: 0.7,
    },
  }))

  assert.equal(explanation.summary, 'Shared people/topics: Julian, Bedrock')
})

test('buildRelatedExplanation explains structure-backed relationships', () => {
  const explanation = buildRelatedExplanation(makeRelated({
    reason: 'Same sub-area',
    reasonTags: ['same sub-area'],
    signals: {
      semantic: 0.24,
      keyword: 0.12,
      title: 0.08,
      entity: 0.11,
    },
  }))

  assert.match(explanation.summary, /nearby vault structure/i)
})
