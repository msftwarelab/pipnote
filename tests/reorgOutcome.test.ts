import test from 'node:test'
import assert from 'node:assert/strict'

import { determineReorgOutcome, shouldSurfaceReviewSuggestion } from '../src/utils/reorgOutcome.ts'

test('determineReorgOutcome keeps rename-only cleanup visible', () => {
  const result = determineReorgOutcome({
    currentRelative: 'Career/Interview Prep/Yeah Just Know Really.md',
    targetRelative: 'Career/Interview Prep/Interview Small Talk Practice.md',
    reason: 'Cleaner professional title',
    parseFailed: false,
    currentTitleMessy: true,
    isDuplicate: false,
  })

  assert.equal(result.suppress, false)
  assert.equal(result.renameOnly, true)
  assert.equal(result.isDuplicate, false)
})

test('determineReorgOutcome suppresses weak optional low-confidence moves', () => {
  const result = determineReorgOutcome({
    currentRelative: 'Work/Engineering/API Design.md',
    targetRelative: 'Work/Research/API Design.md',
    reason: 'Slightly better fit (low-confidence refinement)',
    parseFailed: false,
    currentTitleMessy: false,
    isDuplicate: false,
  })

  assert.equal(result.suppress, true)
  assert.equal(result.renameOnly, false)
  assert.equal(result.isDuplicate, false)
})

test('determineReorgOutcome suppresses exact no-op suggestions', () => {
  const result = determineReorgOutcome({
    currentRelative: 'Career/Interview Prep/Behavioral Interview Notes.md',
    targetRelative: 'Career/Interview Prep/Behavioral Interview Notes.md',
    reason: 'Looks fine',
    parseFailed: false,
    currentTitleMessy: false,
    isDuplicate: false,
  })

  assert.equal(result.suppress, true)
})

test('determineReorgOutcome rejects low-confidence duplicate claims', () => {
  const result = determineReorgOutcome({
    currentRelative: 'Work/Research/Product Spec Draft.md',
    targetRelative: 'Work/Research/Product Spec Draft.md',
    reason: 'Seems similar (low-confidence refinement)',
    parseFailed: false,
    currentTitleMessy: false,
    isDuplicate: true,
    duplicateOf: 'Work/Research/Product Spec Final.md',
  })

  assert.equal(result.isDuplicate, false)
  assert.equal(result.suppress, false)
})

test('determineReorgOutcome keeps strong duplicate claims', () => {
  const result = determineReorgOutcome({
    currentRelative: 'Work/Research/Product Spec Draft.md',
    targetRelative: 'Work/Research/Product Spec Draft.md',
    reason: 'This draft is superseded by the final spec.',
    parseFailed: false,
    currentTitleMessy: false,
    isDuplicate: true,
    duplicateOf: 'Work/Research/Product Spec Final.md',
  })

  assert.equal(result.isDuplicate, true)
  assert.equal(result.suppress, false)
})

test('shouldSurfaceReviewSuggestion suppresses low-confidence review moves for structured notes', () => {
  assert.equal(
    shouldSurfaceReviewSuggestion({
      currentRelative: 'Work/Engineering/API Design.md',
      reason: 'Maybe not useful (low-confidence refinement)',
      parseFailed: false,
      currentTitleMessy: false,
    }),
    false,
  )
})

test('shouldSurfaceReviewSuggestion allows strong review reasons', () => {
  assert.equal(
    shouldSurfaceReviewSuggestion({
      currentRelative: 'Untitled/scan0001.md',
      reason: 'Unreadable empty export file that needs manual check',
      parseFailed: false,
      currentTitleMessy: true,
    }),
    true,
  )
})

test('shouldSurfaceReviewSuggestion suppresses parse-failed review moves', () => {
  assert.equal(
    shouldSurfaceReviewSuggestion({
      currentRelative: 'Work/Research/Product Spec.md',
      reason: 'Heuristic fallback after invalid model JSON output',
      parseFailed: true,
      currentTitleMessy: false,
    }),
    false,
  )
})
