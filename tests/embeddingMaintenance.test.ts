import test from 'node:test'
import assert from 'node:assert/strict'
import { collectStaleOrMissingPaths, modelMatchesRequested, pickAutoReembedTargets } from '../src/utils/embeddingMaintenance.ts'

test('modelMatchesRequested handles tags and digests', () => {
  assert.equal(modelMatchesRequested('nomic-embed-text', 'nomic-embed-text:latest'), true)
  assert.equal(modelMatchesRequested('nomic-embed-text:latest', 'nomic-embed-text:latest@sha256:abc123'), true)
  assert.equal(modelMatchesRequested('bge-m3', 'nomic-embed-text:latest'), false)
})

test('pickAutoReembedTargets returns missing embeddings first', () => {
  const latest = new Map([
    ['a.md', { model: 'nomic-embed-text:latest' }],
  ])
  const candidates = ['b.md', 'a.md', 'c.md']
  const targets = pickAutoReembedTargets(candidates, latest, 'nomic-embed-text', 5)
  assert.deepEqual(targets, ['b.md', 'c.md'])
})

test('pickAutoReembedTargets includes stale model paths and respects limit', () => {
  const latest = new Map([
    ['a.md', { model: 'old-embed:latest' }],
    ['b.md', { model: 'nomic-embed-text:latest' }],
    ['c.md', { model: 'legacy-embed:v2' }],
  ])
  const candidates = ['a.md', 'b.md', 'c.md', 'a.md']
  const targets = pickAutoReembedTargets(candidates, latest, 'nomic-embed-text', 2)
  assert.deepEqual(targets, ['a.md', 'c.md'])
})

test('collectStaleOrMissingPaths includes missing and mismatched model paths', () => {
  const latest = new Map([
    ['a.md', { model: 'nomic-embed-text:latest' }],
    ['b.md', { model: 'old-embed:latest' }],
  ])
  const all = ['a.md', 'b.md', 'c.md', 'b.md']
  const stale = collectStaleOrMissingPaths(all, latest, 'nomic-embed-text')
  assert.deepEqual(stale, ['b.md', 'c.md'])
})
