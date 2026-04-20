import test from 'node:test'
import assert from 'node:assert/strict'

import { detectFactQuestionIntent, shouldPreferFactAnswer } from '../src/utils/factHeuristics.ts'

test('detectFactQuestionIntent marks direct date and attribute questions as direct', () => {
  assert.equal(detectFactQuestionIntent('When is my wedding day?'), 'direct')
  assert.equal(detectFactQuestionIntent('What is my role?'), 'direct')
  assert.equal(detectFactQuestionIntent('Where is my interview date noted?'), 'direct')
})

test('detectFactQuestionIntent keeps strategy and comparison questions contextual', () => {
  assert.equal(detectFactQuestionIntent('How should I prepare for the interview?'), 'contextual')
  assert.equal(detectFactQuestionIntent('Compare bedrock and agentcore tradeoffs'), 'contextual')
  assert.equal(detectFactQuestionIntent('Summarize my execution plan'), 'contextual')
})

test('shouldPreferFactAnswer is stricter for attribute facts than date facts', () => {
  assert.equal(shouldPreferFactAnswer('When is my wedding day?', 0.35, 'date'), true)
  assert.equal(shouldPreferFactAnswer('What is my role?', 0.35, 'attribute'), false)
  assert.equal(shouldPreferFactAnswer('What is my role?', 0.42, 'attribute'), true)
  assert.equal(shouldPreferFactAnswer('How should I prepare for the interview?', 0.9, 'date'), false)
})
