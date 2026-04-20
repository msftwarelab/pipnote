import test from 'node:test'
import assert from 'node:assert/strict'

import { buildReorganizationAnalysisPrompt, buildReorganizationRetryPrompt } from '../src/utils/reorgPrompts.ts'
import { summarizeContentForNaming } from '../src/utils/titleNaming.ts'
import type { FileIntelligence } from '../src/utils/fileIntelligence.ts'

function context(overrides: Partial<FileIntelligence>): FileIntelligence {
  return {
    kind: 'pdf',
    extension: 'pdf',
    fileRole: 'contract',
    extractionQuality: 'high',
    extractionScore: 0.9,
    qualityReason: 'Detailed extracted text was available.',
    preferredTitle: 'Reco Universal Contract',
    preferredCategory: 'Career',
    preferredSubcategory: 'Documents',
    promptContext: 'Treat this as a formal contract or agreement.',
    conservativeReorganization: false,
    ...overrides,
  }
}

test('buildReorganizationAnalysisPrompt adds contract-specific guidance', () => {
  const namingPlan = summarizeContentForNaming(
    'Employment agreement covering compensation, confidentiality, and termination terms.',
    'Career/contracts/reco_universal_contract.pdf',
  )

  const prompt = buildReorganizationAnalysisPrompt({
    currentPath: 'Career/contracts/reco_universal_contract.pdf',
    content: 'Employment agreement covering compensation, confidentiality, and termination terms.',
    namingPlan,
    fileContext: context({ fileRole: 'contract' }),
  })

  assert.match(prompt, /formal legal or official document/i)
  assert.match(prompt, /avoid duplicate claims unless the duplicate target is explicit/i)
  assert.match(prompt, /Preferred category: Career\/Documents/)
})

test('buildReorganizationAnalysisPrompt adds prompt-library guidance for prompt files', () => {
  const namingPlan = summarizeContentForNaming(
    'Rewrite my resume experience section to match the job description and keep it concise.',
    'Career/resume_prompt.md',
  )

  const prompt = buildReorganizationAnalysisPrompt({
    currentPath: 'Career/resume_prompt.md',
    content: 'Rewrite my resume experience section to match the job description and keep it concise.',
    namingPlan,
    fileContext: context({
      kind: 'text',
      extension: 'md',
      fileRole: 'prompt',
      preferredTitle: 'Resume Rewrite Prompt',
      preferredCategory: 'Resources',
      preferredSubcategory: 'AI Prompts',
      promptContext: 'Treat this as a reusable prompt/template asset.',
    }),
  })

  assert.match(prompt, /reusable prompt or template asset/i)
  assert.match(prompt, /Do not classify instruction text as a meeting note or transcript/i)
  assert.match(prompt, /Preferred category: Resources\/AI Prompts/)
})

test('buildReorganizationAnalysisPrompt adds image-specific conservative guidance', () => {
  const namingPlan = summarizeContentForNaming('', 'Work/UI/system_design_architecture_screenshot.png')

  const prompt = buildReorganizationAnalysisPrompt({
    currentPath: 'Work/UI/system_design_architecture_screenshot.png',
    content: 'System design architecture showing API gateway, workers, and database.',
    namingPlan,
    fileContext: context({
      kind: 'image',
      extension: 'png',
      fileRole: 'image',
      extractionQuality: 'low',
      extractionScore: 0.25,
      qualityReason: 'OCR found limited text.',
      preferredTitle: 'System Design Architecture Screenshot',
      preferredCategory: 'Work',
      preferredSubcategory: 'Reference',
      promptContext: 'This is an image asset with weak OCR.',
      conservativeReorganization: true,
    }),
  })

  assert.match(prompt, /Treat this as a visual asset/i)
  assert.match(prompt, /Do not invent detailed semantic meaning/i)
  assert.match(prompt, /If extraction quality is low, be conservative/i)
})

test('buildReorganizationRetryPrompt tightens duplicate handling for images', () => {
  const namingPlan = summarizeContentForNaming('', 'Work/UI/system_design_architecture_screenshot.png')

  const prompt = buildReorganizationRetryPrompt({
    currentPath: 'Work/UI/system_design_architecture_screenshot.png',
    content: 'System design architecture showing API gateway, workers, and database.',
    namingPlan,
    fileContext: context({
      kind: 'image',
      extension: 'png',
      fileRole: 'image',
      extractionQuality: 'medium',
      extractionScore: 0.5,
      qualityReason: 'OCR found limited structured text.',
      preferredTitle: 'System Design Architecture Screenshot',
      preferredCategory: 'Work',
      preferredSubcategory: 'Reference',
      promptContext: 'This is an image asset.',
      conservativeReorganization: true,
    }),
  })

  assert.match(prompt, /Do not mark as duplicate unless the duplicate target is explicit in the path/i)
  assert.match(prompt, /Preferred destination: Work\/Reference/)
})
