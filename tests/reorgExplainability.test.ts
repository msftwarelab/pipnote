import test from 'node:test'
import assert from 'node:assert/strict'

import { summarizeReorgChange } from '../src/utils/reorgExplainability.ts'

test('summarizeReorgChange reports folder and title changes for real moves', () => {
  const summary = summarizeReorgChange(
    'Career/Documents/Behavioral Notes.md',
    'Career/Interview Prep/Behavioral Interview Notes.md',
  )

  assert.deepEqual(summary, {
    currentFolder: 'Career/Documents',
    targetFolder: 'Career/Interview Prep',
    currentTitle: 'Behavioral Notes.md',
    targetTitle: 'Behavioral Interview Notes.md',
    folderChanged: true,
    titleChanged: true,
  })
})

test('summarizeReorgChange reports rename-only cleanup correctly', () => {
  const summary = summarizeReorgChange(
    'Career/Interview Prep/Yeah Just Know Really.md',
    'Career/Interview Prep/Interview Small Talk Practice.md',
  )

  assert.equal(summary?.folderChanged, false)
  assert.equal(summary?.titleChanged, true)
})

test('summarizeReorgChange reports folder-only change correctly', () => {
  const summary = summarizeReorgChange(
    'Untitled/Prompt Template.md',
    'Resources/AI Prompts/Prompt Template.md',
  )

  assert.equal(summary?.folderChanged, true)
  assert.equal(summary?.titleChanged, false)
})
