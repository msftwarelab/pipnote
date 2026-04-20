import test from 'node:test'
import assert from 'node:assert/strict'
import { getBaseUrlCandidates, normalizeBaseUrl } from '../src/services/localAiTypes.ts'

test('normalizeBaseUrl trims trailing slashes', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:1234///'), 'http://127.0.0.1:1234')
})

test('getBaseUrlCandidates keeps single candidate for ollama', () => {
  assert.deepEqual(getBaseUrlCandidates('ollama', 'http://localhost:11434'), ['http://localhost:11434'])
})

test('getBaseUrlCandidates adds localhost fallback for lmstudio', () => {
  assert.deepEqual(
    getBaseUrlCandidates('lmstudio', 'http://localhost:1234'),
    ['http://localhost:1234', 'http://127.0.0.1:1234'],
  )
})

test('getBaseUrlCandidates adds loopback fallback for lmstudio reverse direction', () => {
  assert.deepEqual(
    getBaseUrlCandidates('lmstudio', 'http://127.0.0.1:1234'),
    ['http://127.0.0.1:1234', 'http://localhost:1234'],
  )
})

test('getBaseUrlCandidates handles malformed urls safely', () => {
  assert.deepEqual(getBaseUrlCandidates('lmstudio', 'localhost:1234'), ['localhost:1234'])
})
