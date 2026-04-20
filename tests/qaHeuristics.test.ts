import test from 'node:test'
import assert from 'node:assert/strict'
import { isSmallTalkQuestion, keywordScoreToSimilarity, mergeHybridSearchResults } from '../src/utils/qaHeuristics.ts'

test('small talk detection catches short greetings', () => {
  assert.equal(isSmallTalkQuestion('hi'), true)
  assert.equal(isSmallTalkQuestion('Hello!'), true)
  assert.equal(isSmallTalkQuestion('how are you?'), true)
  assert.equal(isSmallTalkQuestion('thanks'), true)
})

test('small talk detection ignores real questions', () => {
  assert.equal(isSmallTalkQuestion('When is my wedding day?'), false)
  assert.equal(isSmallTalkQuestion('Show interview notes about Bedrock role'), false)
  assert.equal(isSmallTalkQuestion('How can I structure API versioning?'), false)
})

test('keyword score normalization is bounded and rank-sensitive', () => {
  const top = keywordScoreToSimilarity(120, 120, 0)
  const second = keywordScoreToSimilarity(110, 120, 1)
  const late = keywordScoreToSimilarity(110, 120, 6)
  assert.ok(top <= 1 && top >= 0)
  assert.ok(second <= top)
  assert.ok(late < second)
})

test('hybrid merge boosts notes that appear in both retrieval modes', () => {
  const semantic = [
    { notePath: 'work/plan.md', similarity: 0.62, retrievalSummary: 'Semantic match', retrievalTags: ['Semantic match'] },
    { notePath: 'personal/health.md', similarity: 0.44 },
  ]
  const keyword = [
    {
      notePath: 'work/plan.md',
      similarity: 0.58,
      retrievalSummary: 'Keyword match in path',
      retrievalTags: ['Keyword match', 'Title/path match'],
      retrievalPathTerms: ['plan'],
    },
    { notePath: 'projects/api.md', similarity: 0.53, retrievalSummary: 'Keyword match', retrievalTags: ['Keyword match'] },
  ]

  const merged = mergeHybridSearchResults(semantic, keyword, 3)
  assert.equal(merged.length, 3)
  assert.equal(merged[0].notePath, 'work/plan.md')
  assert.ok(merged[0].similarity > 0.62)
  assert.match(merged[0].retrievalSummary || '', /meaning/i)
  assert.deepEqual(merged[0].retrievalTags, ['Semantic match', 'Keyword match', 'Title/path match'])
})
