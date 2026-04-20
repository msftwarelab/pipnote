import test from 'node:test'
import assert from 'node:assert/strict'
import { computeContentHash } from '../src/utils/contentHash.ts'

test('computeContentHash is deterministic for the same input', () => {
  const input = 'Execution plan with milestones and embedding strategy.'
  const first = computeContentHash(input)
  const second = computeContentHash(input)
  assert.equal(first, second)
})

test('computeContentHash changes when content changes', () => {
  const a = computeContentHash('alpha')
  const b = computeContentHash('alpha ')
  assert.notEqual(a, b)
})

test('computeContentHash handles unicode content safely', () => {
  const hash = computeContentHash('emoji \u{1F680} and private use \u{E201} chars')
  assert.equal(typeof hash, 'string')
  assert.equal(hash.length, 8)
  assert.match(hash, /^[0-9a-f]{8}$/)
})

