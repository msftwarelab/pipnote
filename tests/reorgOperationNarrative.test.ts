import test from 'node:test'
import assert from 'node:assert/strict'

import { buildReorgOperationNarrative } from '../src/utils/reorgOperationNarrative.ts'
import type { ReorganizationOperation } from '../src/services/reorganize.ts'

function operation(overrides: Partial<ReorganizationOperation>): ReorganizationOperation {
  return {
    type: 'move',
    suggestionLevel: 'recommended',
    sourcePath: 'Work/Notes/File.md',
    reason: 'Generic reason',
    ...overrides,
  }
}

test('buildReorgOperationNarrative explains duplicate keeper choice', () => {
  const narrative = buildReorgOperationNarrative(operation({
    type: 'merge',
    targetPath: 'Work/Docs/Product Spec Final.md',
    reason: 'Superseded by final version Work/Docs/Product Spec Final.md (Cleaner canonical file • Final version)',
  }))

  assert.equal(narrative?.title, 'Why keep the other file')
  assert.equal(narrative?.bullets.some((line) => /cleaner canonical file/i.test(line)), true)
  assert.equal(narrative?.bullets.some((line) => /final version/i.test(line)), true)
})

test('buildReorgOperationNarrative explains review moves', () => {
  const narrative = buildReorgOperationNarrative(operation({
    targetPath: 'Review/scan0001.md',
    reason: 'Unreadable empty export file that needs manual check',
  }))

  assert.equal(narrative?.title, 'Why this needs review')
  assert.equal(narrative?.bullets.some((line) => /quality problem/i.test(line)), true)
})
