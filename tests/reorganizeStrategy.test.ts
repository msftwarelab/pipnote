import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyReorganizationStrategy,
  type StrategyTaxonomyProfile,
} from '../src/utils/reorganizeStrategy.ts'

function taxonomyFixture(): StrategyTaxonomyProfile {
  return {
    topLevels: new Set(['career', 'work', 'resources', 'finance', 'projects', 'learning']),
    subpathsByTopLevel: new Map([
      ['career', new Set(['career/interview prep', 'career/job search', 'career/documents'])],
      ['work', new Set(['work/contracts', 'work/presentations', 'work/reference', 'work/ai', 'work/ai/toolselection'])],
      ['resources', new Set(['resources/ai prompts', 'resources/images'])],
      ['finance', new Set(['finance/documents', 'finance/reports'])],
      ['projects', new Set(['projects/planning'])],
      ['learning', new Set(['learning/ai', 'learning/notes'])],
    ]),
  }
}

test('meaning strategy keeps the semantic suggestion unchanged', () => {
  const result = applyReorganizationStrategy({
    strategy: 'meaning',
    currentRelative: 'Untitled.md',
    suggestedRelative: 'Career/Job Search/Resume Rewrite Prompt.md',
    content: 'Rewrite my resume summary for a staff backend role.',
    taxonomy: taxonomyFixture(),
  })

  assert.equal(result.targetRelative, 'Career/Job Search/Resume Rewrite Prompt.md')
})

test('type strategy groups prompt files into prompt folders instead of raw semantic destination', () => {
  const result = applyReorganizationStrategy({
    strategy: 'type',
    currentRelative: 'resume_prompt.md',
    suggestedRelative: 'Career/Job Search/Resume Rewrite Prompt.md',
    content: 'Create a prompt that rewrites my resume summary for a staff backend engineer role.',
    taxonomy: taxonomyFixture(),
  })

  assert.equal(result.targetRelative, 'Resources/AI Prompts/Resume Rewrite Prompt.md')
  assert.equal(result.rationale, 'type-based grouping')
})

test('type strategy groups employment contracts into career documents', () => {
  const result = applyReorganizationStrategy({
    strategy: 'type',
    currentRelative: 'contract_docs_examples/Reco Universal LLC Contract.docx',
    suggestedRelative: 'Work/Research/Reco Universal Contract.docx',
    content: 'Employment agreement with compensation, confidentiality, and termination clauses.',
    taxonomy: taxonomyFixture(),
  })

  assert.equal(result.targetRelative, 'Career/Documents/Reco Universal Contract.docx')
})

test('type strategy groups general contracts into work contracts', () => {
  const result = applyReorganizationStrategy({
    strategy: 'type',
    currentRelative: 'contracts/vendor_master_services_agreement.docx',
    suggestedRelative: 'Work/Research/Vendor Services Agreement.docx',
    content: 'Master services agreement covering vendor responsibilities, indemnity, and payment terms.',
    taxonomy: taxonomyFixture(),
  })

  assert.equal(result.targetRelative, 'Work/Contracts/Vendor Services Agreement.docx')
})

test('timeline strategy prefers explicit content dates over modified time', () => {
  const result = applyReorganizationStrategy({
    strategy: 'timeline',
    currentRelative: 'Meetings/Weekly Sync.md',
    suggestedRelative: 'Work/Meetings/Weekly Sync.md',
    content: 'Weekly sync notes for March 4, 2026 about launch readiness.',
    modifiedAt: '2026-03-10T15:00:00.000Z',
    taxonomy: taxonomyFixture(),
  })

  assert.equal(result.targetRelative, 'Timeline/2026/03-Mar/Weekly Sync.md')
})

test('timeline strategy falls back to modifiedAt when note content has no date', () => {
  const result = applyReorganizationStrategy({
    strategy: 'timeline',
    currentRelative: 'Untitled.md',
    suggestedRelative: 'Learning/Notes/Testing Quality Strategy.md',
    content: 'Thoughts about testing and quality assurance.',
    modifiedAt: '2025-11-21T09:30:00.000Z',
    taxonomy: taxonomyFixture(),
  })

  assert.equal(result.targetRelative, 'Timeline/2025/11-Nov/Testing Quality Strategy.md')
})

test('project strategy keeps structured notes inside the current workstream', () => {
  const result = applyReorganizationStrategy({
    strategy: 'project',
    currentRelative: 'Work/AI/ToolSelection/Local Models.md',
    suggestedRelative: 'Learning/AI/Prompting/Local Models.md',
    content: 'Notes comparing local models, prompt orchestration, and tool selection.',
    taxonomy: taxonomyFixture(),
  })

  assert.equal(result.targetRelative, 'Work/AI/Prompting/Local Models.md')
  assert.equal(result.rationale, 'kept within current project/workstream')
})

test('project strategy leaves uncategorized notes free to move semantically', () => {
  const result = applyReorganizationStrategy({
    strategy: 'project',
    currentRelative: 'Untitled.md',
    suggestedRelative: 'Projects/Planning/MVP Launch Plan.md',
    content: 'MVP launch tasks and milestones.',
    taxonomy: taxonomyFixture(),
  })

  assert.equal(result.targetRelative, 'Projects/Planning/MVP Launch Plan.md')
})
