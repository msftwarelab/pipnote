import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildReorgConfidenceSummary,
  getReorgConfidenceRank,
  summarizeReorgConfidenceCounts,
} from '../src/utils/reorgConfidenceSummary.ts'
import type { ReorganizationOperation } from '../src/services/reorganize.ts'

function operation(overrides: Partial<ReorganizationOperation>): ReorganizationOperation {
  return {
    type: 'move',
    suggestionLevel: 'recommended',
    sourcePath: 'Work/Notes/File.md',
    reason: 'Matches existing vault category structure.',
    ...overrides,
  }
}

test('buildReorgConfidenceSummary marks validated strong merges as high confidence', () => {
  const summary = buildReorgConfidenceSummary(operation({
    type: 'merge',
    suggestionLevel: 'strong',
    targetPath: 'Work/Docs/Product Spec Final.md',
    reviewContext: { validationPassed: true, validationKind: 'duplicate' },
  }))

  assert.equal(summary.label, 'High confidence')
  assert.match(summary.detail, /duplicate|superseded-version/i)
})

test('buildReorgConfidenceSummary marks review moves as manual review', () => {
  const summary = buildReorgConfidenceSummary(operation({
    targetPath: 'Review/scan0001.md',
    reason: 'Unreadable export file that needs manual check',
  }))

  assert.equal(summary.label, 'Manual review')
})

test('buildReorgConfidenceSummary lowers confidence for weak extraction', () => {
  const summary = buildReorgConfidenceSummary(operation({
    suggestionLevel: 'recommended',
    reviewContext: {
      aiReadableKind: 'pdf',
      extractionQuality: 'low',
      validationPassed: true,
      validationKind: 'move',
    },
  }))

  assert.equal(summary.label, 'Lower confidence')
  assert.match(summary.detail, /weak or noisy/i)
})

test('buildReorgConfidenceSummary marks recommended validated moves as moderate confidence', () => {
  const summary = buildReorgConfidenceSummary(operation({
    suggestionLevel: 'recommended',
    reviewContext: {
      validationPassed: true,
      validationKind: 'move',
    },
  }))

  assert.equal(summary.label, 'Moderate confidence')
  assert.match(summary.detail, /passed Pipnote validation/i)
})

test('getReorgConfidenceRank orders manual review before lower-confidence refinements', () => {
  const manual = getReorgConfidenceRank(buildReorgConfidenceSummary(operation({
    targetPath: 'Review/scan0001.md',
    reason: 'Unreadable export file that needs manual check',
  })))
  const lower = getReorgConfidenceRank(buildReorgConfidenceSummary(operation({
    suggestionLevel: 'optional',
    reason: 'Small refinement (low-confidence refinement)',
  })))

  assert.equal(manual < lower, true)
})

test('summarizeReorgConfidenceCounts groups confidence labels correctly', () => {
  const counts = summarizeReorgConfidenceCounts([
    operation({
      type: 'merge',
      suggestionLevel: 'strong',
      targetPath: 'Work/Docs/Product Spec Final.md',
      reviewContext: { validationPassed: true, validationKind: 'duplicate' },
    }),
    operation({
      suggestionLevel: 'recommended',
      reviewContext: { validationPassed: true, validationKind: 'move' },
    }),
    operation({
      suggestionLevel: 'optional',
      reason: 'Small refinement (low-confidence refinement)',
    }),
    operation({
      targetPath: 'Review/scan0001.md',
      reason: 'Unreadable export file that needs manual check',
    }),
  ])

  assert.deepEqual(counts, {
    high: 1,
    moderate: 1,
    lower: 1,
    manual: 1,
  })
})
