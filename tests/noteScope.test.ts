import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isAiReadableNotePath,
  getLowerExtension,
  isIndexableNotePath,
  isKnownBinaryExtension,
  isReorganizationEligiblePath,
  isVisualMediaPath,
  normalizeNotePath,
} from '../src/utils/noteScope.ts'

test('normalizeNotePath strips leading slashes and normalizes separators', () => {
  assert.equal(normalizeNotePath('/notes\\Work\\Plan.md'), 'notes/Work/Plan.md')
})

test('isIndexableNotePath accepts markdown and text-like extensions', () => {
  assert.equal(isIndexableNotePath('notes/Work/Plan.md'), true)
  assert.equal(isIndexableNotePath('Work/Spec.mdx'), true)
  assert.equal(isIndexableNotePath('Career/Interview.txt'), true)
  assert.equal(isIndexableNotePath('Personal/Ideas.rst'), true)
})

test('isIndexableNotePath rejects binary/system/trash/internal files', () => {
  assert.equal(isIndexableNotePath('Work/diagram.png'), false)
  assert.equal(isIndexableNotePath('Work/reference.pdf'), false)
  assert.equal(isIndexableNotePath('notes/.vn-system/related-index.json'), false)
  assert.equal(isIndexableNotePath('notes/Trash/deleted.md'), false)
  assert.equal(isIndexableNotePath('notes/index.json'), false)
  assert.equal(isIndexableNotePath('notes/embeddings.json'), false)
})

test('isAiReadableNotePath accepts text notes plus supported documents', () => {
  assert.equal(isAiReadableNotePath('notes/Work/Plan.md'), true)
  assert.equal(isAiReadableNotePath('Work/reference.pdf'), true)
  assert.equal(isAiReadableNotePath('Career/Offer Packet.docx'), true)
  assert.equal(isAiReadableNotePath('Work/Decks/Quarterly Plan.pptx'), true)
  assert.equal(isAiReadableNotePath('Finance/budget_2026.xlsx'), true)
  assert.equal(isAiReadableNotePath('Finance/budget_2026.csv'), true)
  assert.equal(isAiReadableNotePath('Work/diagram.png'), false)
})

test('isVisualMediaPath accepts preview-only image assets', () => {
  assert.equal(isVisualMediaPath('Work/diagram.png'), true)
  assert.equal(isVisualMediaPath('Personal/Photos/morning_walk.jpg'), true)
  assert.equal(isVisualMediaPath('Career/Offer Packet.docx'), false)
})

test('isReorganizationEligiblePath includes ai-readable files plus visual media', () => {
  assert.equal(isReorganizationEligiblePath('notes/Work/Plan.md'), true)
  assert.equal(isReorganizationEligiblePath('Work/reference.pdf'), true)
  assert.equal(isReorganizationEligiblePath('Work/diagram.png'), true)
  assert.equal(isReorganizationEligiblePath('notes/.vn-system/index.json'), false)
})

test('isIndexableNotePath can optionally include trash/system scopes', () => {
  assert.equal(
    isIndexableNotePath('notes/Trash/recover-me.md', { includeTrash: true }),
    true,
  )
  assert.equal(
    isIndexableNotePath('notes/.vn-system/analysis-cache.md', { includeSystem: true }),
    true,
  )
})

test('extension helpers handle edge cases', () => {
  assert.equal(getLowerExtension('README.MD'), 'md')
  assert.equal(getLowerExtension('Untitled'), '')
  assert.equal(isKnownBinaryExtension('PDF'), true)
  assert.equal(isKnownBinaryExtension('md'), false)
})
