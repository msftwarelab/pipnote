import test from 'node:test'
import assert from 'node:assert/strict'

import { assessReorgModelOutput, isHeuristicFallbackReason } from '../src/utils/reorgModelGuard.ts'
import { summarizeContentForNaming, suggestFolderFromNamingPlan } from '../src/utils/titleNaming.ts'
import type { FileIntelligence } from '../src/utils/fileIntelligence.ts'

function conservativeDocumentContext(): FileIntelligence {
  return {
    kind: 'pdf',
    extension: 'pdf',
    fileRole: 'contract',
    extractionQuality: 'low',
    extractionScore: 0.2,
    qualityReason: 'limited text extraction',
    preferredCategory: 'Career',
    preferredSubcategory: 'Documents',
    preferredTitle: 'Offer Letter',
    promptContext: 'Low-quality OCR text from a contract-like document.',
    conservativeReorganization: true,
  }
}

test('assessReorgModelOutput keeps strong aligned model output at high confidence', () => {
  const content = 'Behavioral interview preparation notes covering STAR stories, leadership examples, and follow-up practice.'
  const namingPlan = summarizeContentForNaming(content, 'Career/Interview/behavioral_notes.md')
  const expectedFolder = suggestFolderFromNamingPlan(content, 'Career/Interview/behavioral_notes.md')

  const result = assessReorgModelOutput({
    currentPath: 'Career/Documents/Behavioral Notes.md',
    suggestedPath: 'Career/Interview Prep/Behavioral Interview Notes',
    suggestedTitle: 'Behavioral Interview Notes',
    reason: 'Interview prep notes fit the existing interview-prep structure and are easier to find there.',
    isDuplicate: false,
    namingPlan,
    expectedFolder,
  })

  assert.equal(result.confidence, 'high')
  assert.deepEqual(result.flags, [])
})

test('assessReorgModelOutput marks generic weak model output as low confidence', () => {
  const content = 'Rewrite my resume experience section to match the job description and keep it concise.'
  const namingPlan = summarizeContentForNaming(content, 'Career/resume_prompt.md')
  const expectedFolder = suggestFolderFromNamingPlan(content, 'Career/resume_prompt.md')

  const result = assessReorgModelOutput({
    currentPath: 'Career/Job Search/Resume Prompt.md',
    suggestedPath: 'Misc/Yeah Just Know Really',
    suggestedTitle: 'Yeah Just Know Really',
    reason: 'Better fit.',
    isDuplicate: false,
    namingPlan,
    expectedFolder,
  })

  assert.equal(result.confidence, 'low')
  assert.equal(result.flags.includes('generic folder target'), true)
  assert.equal(result.flags.includes('messy generated title'), true)
  assert.equal(result.flags.includes('generic rationale'), true)
})

test('assessReorgModelOutput downgrades aggressive weak-extraction moves to medium confidence', () => {
  const content = 'Offer letter with compensation, benefits, start date, and employment terms.'
  const namingPlan = summarizeContentForNaming(content, 'Career/Offer Packet/CloudWave Inc Offer.pdf')
  const expectedFolder = suggestFolderFromNamingPlan(content, 'Career/Offer Packet/CloudWave Inc Offer.pdf')

  const result = assessReorgModelOutput({
    currentPath: 'Career/Documents/CloudWave Offer.pdf',
    suggestedPath: 'Work/General/CloudWave Offer Letter',
    suggestedTitle: 'CloudWave Offer Letter',
    reason: 'This looks more organized for active work files.',
    isDuplicate: false,
    namingPlan,
    expectedFolder,
    fileContext: conservativeDocumentContext(),
  })

  assert.equal(result.confidence, 'low')
  assert.equal(result.flags.includes('aggressive move despite weak extraction'), true)
  assert.equal(result.flags.includes('folder conflicts with naming plan'), true)
})

test('isHeuristicFallbackReason recognizes heuristic fallback labels', () => {
  assert.equal(isHeuristicFallbackReason('Heuristic fallback after invalid model JSON output'), true)
  assert.equal(isHeuristicFallbackReason('Heuristic fallback after model analysis error'), true)
  assert.equal(isHeuristicFallbackReason('Could not parse analysis'), true)
  assert.equal(isHeuristicFallbackReason('Interview prep notes fit the existing structure.'), false)
})
