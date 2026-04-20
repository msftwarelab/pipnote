import test from 'node:test'
import assert from 'node:assert/strict'

import { getSourceKindMeta } from '../src/utils/qaSourceMeta.ts'

test('getSourceKindMeta marks OCR-grounded image sources explicitly', () => {
  const meta = getSourceKindMeta('Work/UI/system_design_screenshot.png', 'ocr-image')

  assert.equal(meta.label, 'OCR image source')
  assert.match(meta.tone, /cyan/i)
})

test('getSourceKindMeta keeps standard image sources generic when OCR flag is absent', () => {
  const meta = getSourceKindMeta('Work/UI/system_design_screenshot.png', 'standard')

  assert.equal(meta.label, 'Image file')
})

test('getSourceKindMeta still labels document sources correctly', () => {
  assert.equal(getSourceKindMeta('Work/Specs/launch_plan.pdf').label, 'PDF document')
  assert.equal(getSourceKindMeta('Finance/budget.xlsx').label, 'XLSX spreadsheet')
})
