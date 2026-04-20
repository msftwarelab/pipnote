import test from 'node:test'
import assert from 'node:assert/strict'

import { determineQAGroundingPlan } from '../src/utils/qaGrounding.ts'
import type { SearchResult } from '../src/services/localAi.ts'

test('determineQAGroundingPlan focuses direct lookup questions on one note', () => {
  const results: SearchResult[] = [
    {
      notePath: 'Career/Interview Prep/Bedrock Experience.md',
      similarity: 0.64,
      retrievalTags: ['Direct lookup match', 'Title/path match'],
    },
    {
      notePath: 'Work/Research/General Interview Notes.md',
      similarity: 0.41,
      retrievalTags: ['Semantic match'],
    },
  ]

  const plan = determineQAGroundingPlan('find my bedrock experience note', results)
  assert.equal(plan.mode, 'focused')
  assert.equal(plan.maxPrimaryChunks, 1)
  assert.equal(plan.includeRelatedNote, false)
})

test('determineQAGroundingPlan synthesizes for broad comparison questions', () => {
  const results: SearchResult[] = [
    { notePath: 'Work/Research/Bedrock.md', similarity: 0.58, retrievalTags: ['Semantic match'] },
    { notePath: 'Work/Research/AgentCore.md', similarity: 0.52, retrievalTags: ['Semantic match'] },
  ]

  const plan = determineQAGroundingPlan('compare bedrock and agentcore tradeoffs', results)
  assert.equal(plan.mode, 'synthesized')
  assert.equal(plan.maxPrimaryChunks, 2)
  assert.equal(plan.includeRelatedNote, true)
})

test('determineQAGroundingPlan focuses when one note clearly dominates', () => {
  const results: SearchResult[] = [
    { notePath: 'Personal/Wedding Plan.md', similarity: 0.82, retrievalTags: ['Semantic match'] },
    { notePath: 'Personal/Event Notes.md', similarity: 0.49, retrievalTags: ['Semantic match'] },
  ]

  const plan = determineQAGroundingPlan('when is my wedding day', results)
  assert.equal(plan.mode, 'focused')
  assert.equal(plan.includeRelatedNote, false)
})
