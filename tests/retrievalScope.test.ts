import test from 'node:test'
import assert from 'node:assert/strict'

import { filterRetrievalEligiblePaths, isPotentialRetrievalPath, isRetrievalEligibleAIReadable } from '../src/utils/retrievalScope.ts'

test('isPotentialRetrievalPath includes supported docs and visual assets', () => {
  assert.equal(isPotentialRetrievalPath('notes/Work/Plan.md'), true)
  assert.equal(isPotentialRetrievalPath('Work/reference.pdf'), true)
  assert.equal(isPotentialRetrievalPath('Work/diagram.png'), true)
  assert.equal(isPotentialRetrievalPath('notes/.vn-system/index.json'), false)
})

test('isRetrievalEligibleAIReadable keeps non-image ai-readable files eligible', () => {
  assert.equal(
    isRetrievalEligibleAIReadable('Work/reference.pdf', {
      kind: 'pdf',
      content: 'Detailed project reference with enough structure and content to support retrieval.',
      message: 'Text extracted from PDF for search and Q&A.',
    }),
    true,
  )
})

test('isRetrievalEligibleAIReadable accepts only strong OCR images', () => {
  const strongImage = isRetrievalEligibleAIReadable('Work/UI/system_design_screenshot.png', {
    kind: 'image',
    content: 'System design architecture showing request flow, cache invalidation strategy, deployment boundaries, observability hooks, worker queues, failover routing, service responsibilities, request lifecycle, retry handling, asynchronous processing, background reconciliation, service mesh boundaries, deployment topology, scaling behavior, queue consumers, cache layers, error recovery, request tracing, authentication flow, and data ownership across the application stack.',
    message: 'Text extracted from image using local OCR.',
  })
  const weakImage = isRetrievalEligibleAIReadable('Finance/Scans/bank_statement.png', {
    kind: 'image',
    content: '03/2026 total 4432 0012 8821',
    message: 'Text extracted from image using local OCR.',
  })

  assert.equal(strongImage, true)
  assert.equal(weakImage, false)
})

test('filterRetrievalEligiblePaths includes strong OCR images and excludes weak OCR images', async () => {
  const calls: string[] = []
  const result = await filterRetrievalEligiblePaths(
    [
      'notes/Work/Plan.md',
      'Work/UI/system_design_screenshot.png',
      'Finance/Scans/bank_statement.png',
    ],
    async (path) => {
      calls.push(path)
      if (path.endsWith('.png') && path.includes('system_design')) {
        return {
          kind: 'image',
          content: 'System design architecture showing request flow, cache invalidation strategy, deployment boundaries, observability hooks, worker queues, failover routing, service responsibilities, request lifecycle, retry handling, asynchronous processing, background reconciliation, service mesh boundaries, deployment topology, scaling behavior, queue consumers, cache layers, error recovery, request tracing, authentication flow, and data ownership across the application stack.',
          message: 'Text extracted from image using local OCR.',
        }
      }
      return {
        kind: 'image',
        content: '03/2026 total 4432 0012 8821',
        message: 'Text extracted from image using local OCR.',
      }
    },
    2,
  )

  assert.deepEqual(result, ['notes/Work/Plan.md', 'Work/UI/system_design_screenshot.png'])
  assert.deepEqual(calls.sort(), ['Finance/Scans/bank_statement.png', 'Work/UI/system_design_screenshot.png'])
})
