import test from 'node:test'
import assert from 'node:assert/strict'
import { extractLooseJsonObject } from '../src/utils/jsonRecovery.ts'

test('extractLooseJsonObject parses strict JSON objects', () => {
  const parsed = extractLooseJsonObject<{ ok: boolean }>('{ "ok": true }')
  assert.deepEqual(parsed, { ok: true })
})

test('extractLooseJsonObject recovers from code fences, single quotes, and trailing commas', () => {
  const raw = [
    '```json',
    "{ 'shouldKeep': true, 'suggestedPath': 'Work/Meetings/Kickoff', }",
    '```',
  ].join('\n')

  const parsed = extractLooseJsonObject<{ shouldKeep: boolean; suggestedPath: string }>(raw)
  assert.deepEqual(parsed, { shouldKeep: true, suggestedPath: 'Work/Meetings/Kickoff' })
})

test('extractLooseJsonObject parses escaped JSON strings from model responses', () => {
  const raw = '"{\\"reason\\":\\"ok\\",\\"isDuplicate\\":false}"'
  const parsed = extractLooseJsonObject<{ reason: string; isDuplicate: boolean }>(raw)
  assert.deepEqual(parsed, { reason: 'ok', isDuplicate: false })
})

test('extractLooseJsonObject recovers from bare keys, comments, and trailing semicolons', () => {
  const raw = [
    '// model said this is the answer',
    '{',
    '  shouldKeep: true,',
    '  suggestedPath: "Work/Research/API Design",',
    '  /* keep this rationale short */',
    '  reason: "Better organized under research"',
    '};',
  ].join('\n')

  const parsed = extractLooseJsonObject<{ shouldKeep: boolean; suggestedPath: string; reason: string }>(raw)
  assert.deepEqual(parsed, {
    shouldKeep: true,
    suggestedPath: 'Work/Research/API Design',
    reason: 'Better organized under research',
  })
})

test('extractLooseJsonObject returns null for non-object JSON', () => {
  assert.equal(extractLooseJsonObject<string[]>('[1,2,3]'), null)
  assert.equal(extractLooseJsonObject<{ ok: boolean }>('not json'), null)
})
