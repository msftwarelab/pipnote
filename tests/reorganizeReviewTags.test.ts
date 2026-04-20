import test from 'node:test'
import assert from 'node:assert/strict'

import { getReorgReviewHint, getReorgTrustTags } from '../src/utils/reorganizeReviewTags.ts'
import type { ReorganizationOperationReviewContext } from '../src/services/reorganize.ts'

test('reason-based reorganize trust tags still work without review context', () => {
  const tags = getReorgTrustTags(
    'Root or uncategorized note. Matches existing vault category structure. Similar approved note patterns: interview (2). Low-confidence refinement.',
  )

  assert.deepEqual(tags.map((tag) => tag.label), [
    'Uncategorized Fix',
    'Vault Pattern',
    'Learned From Approvals',
    'Low Confidence',
  ])
})

test('duplicate review reasons surface cleaner canonical and newer copy tags', () => {
  const cleanerTags = getReorgTrustTags('Exact duplicate of cleaner canonical file Work/Docs/Project Proposal.md')
  const newerTags = getReorgTrustTags('Exact duplicate of newer copy Finance/Exports/statement copy (2).csv')
  const finalTags = getReorgTrustTags('Exact duplicate of final version Work/Docs/Product Spec Final.md')
  const nonDraftTags = getReorgTrustTags('Superseded by non-draft file Career/Documents/Resume.md')

  assert.deepEqual(cleanerTags.map((tag) => tag.label), ['Cleaner Canonical File'])
  assert.deepEqual(newerTags.map((tag) => tag.label), ['Newer Copy'])
  assert.deepEqual(finalTags.map((tag) => tag.label), ['Final Version'])
  assert.deepEqual(nonDraftTags.map((tag) => tag.label), ['Non-Draft File'])
})

test('superseded duplicate reasons surface superseded version tag', () => {
  const tags = getReorgTrustTags('Superseded by final version Work/Docs/Product Spec Final.md')

  assert.deepEqual(tags.map((tag) => tag.label), ['Final Version'])
})

test('clutter cleanup reason surfaces clutter cleanup tag', () => {
  const tags = getReorgTrustTags("Flatten shallow clutter folder 'Finance/Exports' into 'Finance' (flatten noisy copy/export container)")

  assert.deepEqual(tags.map((tag) => tag.label), ['Clutter Cleanup'])
})

test('low extraction quality adds weak extraction tag and hint', () => {
  const reviewContext: ReorganizationOperationReviewContext = {
    aiReadableKind: 'pdf',
    extractionQuality: 'low',
    qualityReason: 'extracted text looked like a noisy form scan',
    fileRole: 'contract',
    conservativeReorganization: true,
  }

  const tags = getReorgTrustTags('Matches existing vault category structure.', reviewContext)
  const hint = getReorgReviewHint(reviewContext)

  assert.deepEqual(tags.map((tag) => tag.label), ['Vault Pattern', 'Weak Extraction'])
  assert.match(hint || '', /extracted pdf text was weak or noisy/i)
  assert.match(hint || '', /noisy form scan/i)
})

test('medium extraction quality adds limited extraction tag and hint', () => {
  const reviewContext: ReorganizationOperationReviewContext = {
    aiReadableKind: 'xlsx',
    extractionQuality: 'medium',
    qualityReason: 'sheet text was partial and heavily abbreviated',
    fileRole: 'spreadsheet',
    conservativeReorganization: true,
  }

  const tags = getReorgTrustTags('Target folder approved 3 times.', reviewContext)
  const hint = getReorgReviewHint(reviewContext)

  assert.deepEqual(tags.map((tag) => tag.label), ['Learned From Approvals', 'Limited Extraction'])
  assert.match(hint || '', /usable but limited/i)
  assert.match(hint || '', /xlsx/i)
})

test('high extraction quality does not add extraction-specific warnings', () => {
  const reviewContext: ReorganizationOperationReviewContext = {
    aiReadableKind: 'docx',
    extractionQuality: 'high',
    qualityReason: 'rich structured text was extracted cleanly',
    fileRole: 'proposal',
    conservativeReorganization: false,
  }

  const tags = getReorgTrustTags('Matches existing vault category structure.', reviewContext)
  const hint = getReorgReviewHint(reviewContext)

  assert.deepEqual(tags.map((tag) => tag.label), ['Vault Pattern'])
  assert.equal(hint, null)
})

test('plain text notes do not show extraction hints even if review context exists', () => {
  const reviewContext: ReorganizationOperationReviewContext = {
    aiReadableKind: 'text',
    extractionQuality: 'low',
    qualityReason: 'note is sparse',
    fileRole: 'text-note',
    conservativeReorganization: false,
  }

  const tags = getReorgTrustTags('Root or uncategorized note.', reviewContext)
  const hint = getReorgReviewHint(reviewContext)

  assert.deepEqual(tags.map((tag) => tag.label), ['Uncategorized Fix'])
  assert.equal(hint, null)
})

test('preview-only screenshots show visual review tags and OCR-ready hint', () => {
  const reviewContext: ReorganizationOperationReviewContext = {
    aiReadableKind: 'image',
    extractionQuality: 'medium',
    qualityReason: 'Preview-only image organized from filename and folder context because OCR is not enabled yet.',
    fileRole: 'image',
    visualKind: 'screenshot',
    visualAnalysisMode: 'path',
    conservativeReorganization: true,
  }

  const tags = getReorgTrustTags('Matches existing vault category structure.', reviewContext)
  const hint = getReorgReviewHint(reviewContext)

  assert.deepEqual(tags.map((tag) => tag.label), ['Vault Pattern', 'Visual Asset', 'Screenshot', 'Path-Based'])
  assert.match(hint || '', /screenshot/i)
  assert.match(hint || '', /ocr is not enabled yet/i)
  assert.match(hint || '', /filename and folder clues/i)
})

test('preview-only scanned docs show scanned-doc visual tags and OCR-ready hint', () => {
  const reviewContext: ReorganizationOperationReviewContext = {
    aiReadableKind: 'image',
    extractionQuality: 'medium',
    qualityReason: 'Preview-only image organized from filename and folder context because OCR is not enabled yet.',
    fileRole: 'image',
    visualKind: 'scan',
    visualAnalysisMode: 'path',
    conservativeReorganization: true,
  }

  const tags = getReorgTrustTags('Target folder approved 2 times.', reviewContext)
  const hint = getReorgReviewHint(reviewContext)

  assert.deepEqual(tags.map((tag) => tag.label), ['Learned From Approvals', 'Visual Asset', 'Scanned Doc', 'Path-Based'])
  assert.match(hint || '', /scanned image/i)
  assert.match(hint || '', /ocr is not enabled yet/i)
})

test('ocr-backed screenshots show OCR review tags instead of path-based fallback', () => {
  const reviewContext: ReorganizationOperationReviewContext = {
    aiReadableKind: 'image',
    extractionQuality: 'high',
    qualityReason: 'Extracted text looks detailed enough for file-aware organization.',
    fileRole: 'image',
    visualKind: 'screenshot',
    visualAnalysisMode: 'ocr',
    conservativeReorganization: false,
  }

  const tags = getReorgTrustTags('Matches existing vault category structure.', reviewContext)
  const hint = getReorgReviewHint(reviewContext)

  assert.deepEqual(tags.map((tag) => tag.label), ['Vault Pattern', 'Visual Asset', 'Screenshot', 'OCR Read'])
  assert.match(hint || '', /local ocr text/i)
  assert.doesNotMatch(hint || '', /not enabled yet/i)
})

test('weak OCR images surface weak OCR tag and hint', () => {
  const reviewContext: ReorganizationOperationReviewContext = {
    aiReadableKind: 'image',
    extractionQuality: 'low',
    qualityReason: 'Extracted text looks noisy, form-like, or poorly structured.',
    fileRole: 'image',
    visualKind: 'scan',
    visualAnalysisMode: 'ocr',
    conservativeReorganization: true,
  }

  const tags = getReorgTrustTags('Target folder approved 2 times.', reviewContext)
  const hint = getReorgReviewHint(reviewContext)

  assert.deepEqual(tags.map((tag) => tag.label), ['Learned From Approvals', 'Visual Asset', 'Scanned Doc', 'Weak OCR'])
  assert.match(hint || '', /weak or noisy/i)
  assert.match(hint || '', /local ocr/i)
})
