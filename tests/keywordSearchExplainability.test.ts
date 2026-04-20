import test from 'node:test'
import assert from 'node:assert/strict'

import { buildKeywordSearchExplanation } from '../src/utils/keywordSearchExplainability.ts'

test('buildKeywordSearchExplanation prefers exact title matches', () => {
  const explanation = buildKeywordSearchExplanation({
    hit: {
      path: 'Career/Interview Prep/Bedrock Notes.md',
      title: 'Bedrock Notes',
      snippet: 'Interview prep notes for Bedrock experience',
      score: 72,
    },
    queryTokens: ['bedrock', 'notes'],
    titleMatches: 2,
    pathMatches: 1,
    snippetMatches: 2,
    exactTitle: true,
    titleStartsWith: true,
  })

  assert.equal(explanation.summary, 'Exact title match for your query.')
  assert.deepEqual(explanation.tags, ['Exact title', 'Path match', 'Content match'])
})

test('buildKeywordSearchExplanation explains mixed title and content matches', () => {
  const explanation = buildKeywordSearchExplanation({
    hit: {
      path: 'Projects/API/versioning-plan.md',
      title: 'API Versioning Plan',
      snippet: 'This document outlines API versioning and rollout steps.',
      score: 40,
    },
    queryTokens: ['api', 'versioning'],
    titleMatches: 2,
    pathMatches: 1,
    snippetMatches: 2,
    exactTitle: false,
    titleStartsWith: false,
  })

  assert.match(explanation.summary, /title and content/i)
  assert.deepEqual(explanation.tags, ['Title match', 'Path match', 'Content match'])
})

test('buildKeywordSearchExplanation explains content-driven matches', () => {
  const explanation = buildKeywordSearchExplanation({
    hit: {
      path: 'Work/Research/notes.md',
      title: 'Research Notes',
      snippet: 'Execution plan for the migration and rollout.',
      score: 18,
    },
    queryTokens: ['execution', 'plan'],
    titleMatches: 0,
    pathMatches: 0,
    snippetMatches: 2,
    exactTitle: false,
    titleStartsWith: false,
  })

  assert.match(explanation.summary, /content/i)
  assert.deepEqual(explanation.tags, ['Content match'])
})
