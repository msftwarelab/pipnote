import test from 'node:test'
import assert from 'node:assert/strict'

import {
  explainFolderFitDelta,
  shouldMoveFromDecision,
  targetFolderFitScore,
  type ReorgDecisionPreferences,
  type ReorgDecisionTaxonomy,
} from '../src/utils/reorganizeDecision.ts'

function taxonomyFixture(): ReorgDecisionTaxonomy {
  return {
    topLevels: new Set(['career', 'work', 'resources']),
    subpathsByTopLevel: new Map([
      ['career', new Set(['career/interview prep', 'career/job search', 'career/documents'])],
      ['work', new Set(['work/engineering', 'work/research', 'work/meetings'])],
      ['resources', new Set(['resources/ai prompts'])],
    ]),
  }
}

function emptyPreferences(): ReorgDecisionPreferences {
  return {
    acceptedTopLevelMoves: {},
    deniedTopLevelMoves: {},
    acceptedTargetParents: {},
    deniedTargetParents: {},
    acceptedTokenParents: {},
  }
}

test('shouldMoveFromDecision keeps structured notes in place for optional low-fit refinements', () => {
  const taxonomy = taxonomyFixture()
  const preferences = emptyPreferences()

  assert.equal(
    shouldMoveFromDecision({
      currentRelative: 'Work/Engineering/API Design.md',
      targetRelative: 'Work/Research/API Design.md',
      parseFailed: false,
      reason: 'Slightly more specific folder suggestion',
      currentStructured: true,
      currentTitleMessy: false,
    }, taxonomy, preferences),
    false,
  )
})

test('shouldMoveFromDecision allows rename-only cleanup when title is messy', () => {
  const taxonomy = taxonomyFixture()
  const preferences = emptyPreferences()

  assert.equal(
    shouldMoveFromDecision({
      currentRelative: 'Career/Interview Prep/Yeah Just Know Really.md',
      targetRelative: 'Career/Interview Prep/Interview Small Talk Practice.md',
      parseFailed: false,
      reason: 'Cleaner professional title',
      currentStructured: true,
      currentTitleMessy: true,
    }, taxonomy, preferences),
    true,
  )
})

test('shouldMoveFromDecision blocks parse-failed cross-folder churn for structured notes', () => {
  const taxonomy = taxonomyFixture()
  const preferences = emptyPreferences()

  assert.equal(
    shouldMoveFromDecision({
      currentRelative: 'Career/Interview Prep/Bedrock Prep.md',
      targetRelative: 'Resources/AI Prompts/Bedrock Prep.md',
      parseFailed: true,
      reason: 'Could not parse analysis',
      currentStructured: true,
      currentTitleMessy: false,
    }, taxonomy, preferences),
    false,
  )
})

test('shouldMoveFromDecision allows strong learned target folders to win', () => {
  const taxonomy = taxonomyFixture()
  const preferences = emptyPreferences()
  preferences.acceptedTargetParents['career/interview prep'] = 4
  preferences.acceptedTokenParents.interview = { 'career/interview prep': 3 }
  preferences.acceptedTokenParents.behavioral = { 'career/interview prep': 2 }

  assert.equal(
    shouldMoveFromDecision({
      currentRelative: 'Career/Documents/Behavioral Interview Notes.md',
      targetRelative: 'Career/Interview Prep/Behavioral Interview Notes.md',
      parseFailed: false,
      reason: 'Matches prior approved interview-prep organization',
      currentStructured: true,
      currentTitleMessy: false,
    }, taxonomy, preferences),
    true,
  )
})

test('targetFolderFitScore rewards learned and taxonomy-aligned destinations', () => {
  const taxonomy = taxonomyFixture()
  const preferences = emptyPreferences()
  preferences.acceptedTargetParents['career/interview prep'] = 3
  preferences.acceptedTokenParents.interview = { 'career/interview prep': 2 }

  const targetScore = targetFolderFitScore(
    'Career/Documents/Interview Questions.md',
    'Career/Interview Prep/Interview Questions.md',
    taxonomy,
    preferences,
  )
  const weakerScore = targetFolderFitScore(
    'Career/Documents/Interview Questions.md',
    'Resources/AI Prompts/Interview Questions.md',
    taxonomy,
    preferences,
  )

  assert.equal(targetScore > weakerScore, true)
})

test('explainFolderFitDelta surfaces stronger-fit language for clearly better destinations', () => {
  const taxonomy = taxonomyFixture()
  const preferences = emptyPreferences()
  preferences.acceptedTargetParents['career/interview prep'] = 4
  preferences.acceptedTokenParents.interview = { 'career/interview prep': 3 }

  assert.equal(
    explainFolderFitDelta(
      'Career/Documents/Interview Questions.md',
      'Career/Interview Prep/Interview Questions.md',
      taxonomy,
      preferences,
    ),
    'target folder is a much stronger fit than the current location',
  )
})
