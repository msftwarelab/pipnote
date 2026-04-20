import test from 'node:test'
import assert from 'node:assert/strict'

import { buildWhyThisFolder } from '../src/utils/reorgWhyThisFolder.ts'

test('buildWhyThisFolder summarizes strong folder-fit evidence', () => {
  const summary = buildWhyThisFolder(
    'Career/Documents/Behavioral Notes.md',
    'Career/Interview Prep/Behavioral Interview Notes.md',
    'Interview prep notes fit better here. (matches existing vault category structure • target folder approved 3 times • target folder is a much stronger fit than the current location)',
  )

  assert.equal(summary.currentFolder, 'Career/Documents')
  assert.equal(summary.suggestedFolder, 'Career/Interview Prep')
  assert.deepEqual(summary.evidence, [
    'Keeps the note inside a folder pattern that already exists in your vault.',
    'Matches folder choices you already approved for similar notes.',
    'The suggested folder is a much stronger semantic fit than the current location.',
  ])
})

test('buildWhyThisFolder adds uncategorized evidence and low-confidence caution', () => {
  const summary = buildWhyThisFolder(
    'Untitled/Prompt.md',
    'Resources/AI Prompts/Prompt.md',
    'Prompt library fit. (auto-fix uncategorized path • low-confidence refinement)',
  )

  assert.equal(summary.evidence[0], 'Fixes a note that was still uncategorized or sitting in a generic location.')
  assert.match(summary.caution || '', /lighter-weight refinement/i)
})

test('buildWhyThisFolder falls back to generic explanation when reason lacks known markers', () => {
  const summary = buildWhyThisFolder(
    'Work/Notes/Plan.md',
    'Work/Research/Plan.md',
    'Cleaner organization choice.',
  )

  assert.equal(summary.evidence.length, 1)
  assert.match(summary.evidence[0] || '', /cleaner organization path/i)
})
