import test from 'node:test'
import assert from 'node:assert/strict'
import { duplicateBlockInContent, moveBlockInContent } from '../src/utils/blockOperations.ts'

const blocks = [
  { id: 'alpha', startLine: 2, endLine: 2 },
  { id: 'beta', startLine: 4, endLine: 5 },
  { id: 'gamma', startLine: 7, endLine: 7 },
]

const content = [
  'intro',
  '',
  'alpha',
  '',
  'beta',
  'line',
  '',
  'gamma',
].join('\n')

test('moveBlockInContent reorders block segments while preserving leading context', () => {
  const movedUp = moveBlockInContent(content, blocks, 'beta', -1)
  assert.equal(movedUp.moved, true)
  assert.equal(movedUp.content, ['intro', '', 'beta', 'line', '', 'alpha', '', 'gamma'].join('\n'))

  const movedDown = moveBlockInContent(content, blocks, 'alpha', 1)
  assert.equal(movedDown.moved, true)
  assert.equal(movedDown.content, ['intro', '', 'beta', 'line', '', 'alpha', '', 'gamma'].join('\n'))
})

test('moveBlockInContent is a no-op at boundaries or when block id is missing', () => {
  const firstUp = moveBlockInContent(content, blocks, 'alpha', -1)
  assert.equal(firstUp.moved, false)
  assert.equal(firstUp.content, content)

  const missing = moveBlockInContent(content, blocks, 'unknown', 1)
  assert.equal(missing.moved, false)
  assert.equal(missing.content, content)
})

test('duplicateBlockInContent duplicates a whole block segment and spacing', () => {
  const duplicated = duplicateBlockInContent(content, blocks, 'alpha')
  assert.equal(duplicated.duplicated, true)
  assert.equal(
    duplicated.content,
    ['intro', '', 'alpha', '', 'alpha', '', 'beta', 'line', '', 'gamma'].join('\n'),
  )
})
