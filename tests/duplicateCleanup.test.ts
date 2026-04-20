import test from 'node:test'
import assert from 'node:assert/strict'

import {
  detectDuplicateCandidate,
  isClutterLikeFilename,
  normalizeContentForDuplicateDetection,
  type DuplicateCandidateEntry,
} from '../src/utils/duplicateCleanup.ts'

function entry(
  path: string,
  content: string,
  fileRole?: DuplicateCandidateEntry['fileRole'],
  modifiedAt?: string,
): DuplicateCandidateEntry {
  return { path, content, fileRole, modifiedAt }
}

test('normalizeContentForDuplicateDetection collapses whitespace and markdown separators', () => {
  const a = normalizeContentForDuplicateDetection('Alpha\n\n---\n\nBeta')
  const b = normalizeContentForDuplicateDetection(' alpha   beta ')

  assert.equal(a, b)
})

test('detectDuplicateCandidate flags exact duplicates even with formatting differences', () => {
  const result = detectDuplicateCandidate(
    entry(
      'Work/Notes/Plan Copy.md',
      'Alpha roadmap review\n\n---\n\nBeta launch plan with owners and timing details',
    ),
    [entry(
      'Work/Notes/Plan.md',
      'alpha roadmap review beta launch plan with owners and timing details',
    )],
  )

  assert.equal(result.kind, 'exact-delete')
  assert.equal(result.targetPath, 'Work/Notes/Plan.md')
  assert.match(result.reason || '', /cleaner canonical file/i)
})

test('detectDuplicateCandidate recommends merge for near-duplicate revisions with noisy filenames', () => {
  const result = detectDuplicateCandidate(
    entry(
      'Career/Interview Prep/Behavioral Interview Copy.md',
      'Behavioral interview prep questions.\nTell me about a conflict you resolved.\nSTAR format examples.\nLeadership examples.\nFeedback follow-ups.\n',
      'interview',
    ),
    [entry(
      'Career/Interview Prep/Behavioral Interview.md',
      'Behavioral interview prep questions.\nTell me about a conflict you resolved.\nSTAR format examples.\nLeadership examples.\nFeedback follow-ups.\nFollow-up coaching tips for the debrief.\n',
      'interview',
    )],
  )

  assert.equal(result.kind, 'merge-recommended')
  assert.equal(result.targetPath, 'Career/Interview Prep/Behavioral Interview.md')
})

test('detectDuplicateCandidate avoids false positives for notes with shared boilerplate only', () => {
  const result = detectDuplicateCandidate(
    entry(
      'Work/Meetings/Weekly Sync.md',
      'Weekly sync agenda.\nRoadmap updates.\nHiring pipeline risks.\nCustomer escalations.\n',
      'meeting',
    ),
    [entry(
      'Work/Meetings/Project Kickoff.md',
      'Weekly sync agenda.\nProject kickoff owners.\nArchitecture decisions.\nMilestone review.\n',
      'meeting',
    )],
  )

  assert.equal(result.kind, 'none')
})

test('detectDuplicateCandidate avoids cross-role duplicate guesses', () => {
  const result = detectDuplicateCandidate(
    entry(
      'Finance/Exports/Bank Statement Export.csv',
      'date,amount,merchant\n2026-03-10,12.40,Coffee Shop\n',
      'statement',
    ),
    [entry(
      'Career/Documents/Bank Statement.md',
      'Coffee shop receipt and bank statement prep notes.\n',
      'contract',
    )],
  )

  assert.equal(result.kind, 'none')
})

test('isClutterLikeFilename catches common noisy copy and export naming patterns', () => {
  assert.equal(isClutterLikeFilename('Work/Notes/Strategy final-final.md'), true)
  assert.equal(isClutterLikeFilename('Finance/Exports/statement copy (1).csv'), true)
  assert.equal(isClutterLikeFilename('Personal/Scans/scan0001.pdf'), true)
  assert.equal(isClutterLikeFilename('Photos/IMG_2455.JPG'), true)
  assert.equal(isClutterLikeFilename('Work/Notes/Testing Quality Strategy.md'), false)
})

test('detectDuplicateCandidate prefers cleaner canonical path over newer noisy duplicate', () => {
  const result = detectDuplicateCandidate(
    entry(
      'Work/Docs/Proposal final-final.md',
      'Project proposal summary with budget, scope, dependencies, and milestone details.',
      'proposal',
      '2026-03-14T10:00:00.000Z',
    ),
    [entry(
      'Work/Docs/Project Proposal.md',
      'Project proposal summary with budget, scope, dependencies, and milestone details.',
      'proposal',
      '2026-03-10T10:00:00.000Z',
    )],
  )

  assert.equal(result.kind, 'exact-delete')
  assert.equal(result.targetPath, 'Work/Docs/Project Proposal.md')
  assert.match(result.reason || '', /cleaner canonical file/i)
})

test('detectDuplicateCandidate keeps newer version when both duplicate filenames are equally noisy', () => {
  const result = detectDuplicateCandidate(
    entry(
      'Finance/Exports/statement copy (2).csv',
      'date,amount,merchant\n2026-03-10,12.40,Coffee Shop\n2026-03-11,42.10,Airline\n',
      'statement',
      '2026-03-14T10:00:00.000Z',
    ),
    [entry(
      'Finance/Exports/statement copy (1).csv',
      'date,amount,merchant\n2026-03-10,12.40,Coffee Shop\n2026-03-11,42.10,Airline\n',
      'statement',
      '2026-03-10T10:00:00.000Z',
    )],
  )

  assert.equal(result.kind, 'none')
})

test('detectDuplicateCandidate points to newer copy when both duplicate names are equally noisy and current is older', () => {
  const result = detectDuplicateCandidate(
    entry(
      'Finance/Exports/statement copy (1).csv',
      'date,amount,merchant\n2026-03-10,12.40,Coffee Shop\n2026-03-11,42.10,Airline\n',
      'statement',
      '2026-03-10T10:00:00.000Z',
    ),
    [entry(
      'Finance/Exports/statement copy (2).csv',
      'date,amount,merchant\n2026-03-10,12.40,Coffee Shop\n2026-03-11,42.10,Airline\n',
      'statement',
      '2026-03-14T10:00:00.000Z',
    )],
  )

  assert.equal(result.kind, 'exact-delete')
  assert.equal(result.targetPath, 'Finance/Exports/statement copy (2).csv')
  assert.match(result.reason || '', /newer copy/i)
})

test('detectDuplicateCandidate prefers final version over draft when both are otherwise equal', () => {
  const result = detectDuplicateCandidate(
    entry(
      'Work/Docs/Product Spec Draft.md',
      'Product spec covering onboarding flow, pricing, edge cases, rollout notes, and QA checklist.',
      'general-document',
    ),
    [entry(
      'Work/Docs/Product Spec Final.md',
      'Product spec covering onboarding flow, pricing, edge cases, rollout notes, and QA checklist.',
      'general-document',
    )],
  )

  assert.equal(result.kind, 'exact-delete')
  assert.equal(result.targetPath, 'Work/Docs/Product Spec Final.md')
  assert.match(result.reason || '', /final version/i)
})

test('detectDuplicateCandidate prefers non-draft file over draft near-duplicate revision', () => {
  const result = detectDuplicateCandidate(
    entry(
      'Career/Documents/Resume Draft.md',
      'Resume rewrite for senior backend role.\nExperience bullets.\nLeadership examples.\nMetrics.\n',
      'resume',
    ),
    [entry(
      'Career/Documents/Resume.md',
      'Resume rewrite for senior backend role.\nExperience bullets.\nLeadership examples.\nMetrics.\nAdditional polish notes.\n',
      'resume',
    )],
  )

  assert.equal(result.kind, 'superseded-delete')
  assert.equal(result.targetPath, 'Career/Documents/Resume.md')
  assert.match(result.reason || '', /superseded by non-draft file/i)
})
