import test from 'node:test'
import assert from 'node:assert/strict'

import { detectRetrievalQueryIntent, rerankResultsForQueryIntent } from '../src/utils/retrievalRanking.ts'
import type { SearchResult } from '../src/services/localAi.ts'

test('detectRetrievalQueryIntent recognizes direct lookup style questions', () => {
  assert.equal(detectRetrievalQueryIntent('find my bedrock note'), 'lookup')
  assert.equal(detectRetrievalQueryIntent('open "wedding plan"'), 'lookup')
  assert.equal(detectRetrievalQueryIntent('where is the interview doc'), 'lookup')
})

test('detectRetrievalQueryIntent keeps exploratory questions semantic-first', () => {
  assert.equal(detectRetrievalQueryIntent('how should I structure event-driven architecture'), 'exploratory')
  assert.equal(detectRetrievalQueryIntent('compare bedrock and agentcore tradeoffs'), 'exploratory')
})

test('rerankResultsForQueryIntent boosts direct title and path matches for lookup queries', () => {
  const results: SearchResult[] = [
    {
      notePath: 'Work/Research/general_architecture.md',
      similarity: 0.71,
      retrievalSummary: 'Semantic match to the meaning of your question.',
      retrievalTags: ['Semantic match'],
    },
    {
      notePath: 'Career/Interview Prep/Bedrock Experience.md',
      similarity: 0.62,
      retrievalSummary: 'Strong direct match in the note title or folder path.',
      retrievalTags: ['Keyword match', 'Title/path match'],
    },
  ]

  const reranked = rerankResultsForQueryIntent(results, 'find bedrock experience note', 2)
  assert.equal(reranked[0].notePath, 'Career/Interview Prep/Bedrock Experience.md')
  assert.ok((reranked[0].retrievalTags || []).includes('Direct lookup match'))
})

test('rerankResultsForQueryIntent leaves exploratory ordering intact', () => {
  const results: SearchResult[] = [
    { notePath: 'Work/Research/architecture.md', similarity: 0.74, retrievalTags: ['Semantic match'] },
    { notePath: 'Career/Interview Prep/Bedrock.md', similarity: 0.68, retrievalTags: ['Keyword match', 'Title/path match'] },
  ]

  const reranked = rerankResultsForQueryIntent(results, 'how should I structure event-driven architecture', 2)
  assert.deepEqual(reranked.map((item) => item.notePath), results.map((item) => item.notePath))
})
