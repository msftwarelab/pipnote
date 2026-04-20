import test from 'node:test'
import assert from 'node:assert/strict'
import {
  determineMoveSuggestionLevel,
  looksUncategorized,
  normalizeSuggestedRelativePath,
} from '../src/utils/reorganizePathing.ts'

test('normalizeSuggestedRelativePath cleans repeated notes prefixes and extension noise', () => {
  const normalized = normalizeSuggestedRelativePath(
    'notes/notes/Work/Meetings/Kickoff.md.md',
    'Untitled/Kickoff.md',
  )
  assert.equal(normalized, 'Work/Meetings/Kickoff.md')
})

test('normalizeSuggestedRelativePath falls back safely when model path is weak', () => {
  const normalized = normalizeSuggestedRelativePath('Resume', 'Career/Resume.md')
  assert.equal(normalized, 'Unsorted/Resume.md')
})

test('looksUncategorized catches root and generic folders', () => {
  assert.equal(looksUncategorized('Interview Note.md'), true)
  assert.equal(looksUncategorized('Untitled/Note.md'), true)
  assert.equal(looksUncategorized('Work/Meetings/Weekly.md'), false)
})

test('determineMoveSuggestionLevel prioritizes uncategorized files and de-emphasizes refinements', () => {
  assert.equal(
    determineMoveSuggestionLevel('Interview note 1.md', 'Career/Interviews/Interview note 1.md'),
    'strong',
  )
  assert.equal(
    determineMoveSuggestionLevel('Work/Meetings/Standup.md', 'Work/Meetings/Standup.md'),
    'optional',
  )
  assert.equal(
    determineMoveSuggestionLevel('Work/Notes/API.md', 'Projects/Architecture/API.md'),
    'recommended',
  )
})
