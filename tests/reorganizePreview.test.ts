import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildProjectedVaultTree,
  groupOperationsForReview,
  summarizeDestinationClusters,
} from '../src/utils/reorganizePreview.ts'
import type { ReorganizationPlan } from '../src/services/reorganize.ts'

function flattenPaths(nodes: ReturnType<typeof buildProjectedVaultTree>): string[] {
  const paths: string[] = []
  const walk = (items: typeof nodes) => {
    for (const item of items) {
      if (item.type === 'file') {
        paths.push(item.path)
      } else if (item.children) {
        walk(item.children)
      }
    }
  }
  walk(nodes)
  return paths
}

function fixtureOperations(): ReorganizationPlan['operations'] {
  return [
    {
      type: 'move',
      suggestionLevel: 'strong',
      sourcePath: 'Untitled/Prompt User Requirement Expert.md',
      targetPath: 'Resources/AI Prompts/Prompt User Requirement Expert.md',
      reason: 'Move to prompt folder',
    },
    {
      type: 'move',
      suggestionLevel: 'recommended',
      sourcePath: 'Career/Job Search/Interviewer Yeah Today Pretty.md',
      targetPath: 'Career/Job Search/Interview Small Talk Practice.md',
      reason: 'Rename cleanup',
    },
    {
      type: 'merge',
      suggestionLevel: 'strong',
      sourcePath: 'Work/Research/Competitive Analysis Copy.md',
      targetPath: 'Work/Research/Competitive Analysis.md',
      reason: 'Duplicate note',
    },
    {
      type: 'delete',
      suggestionLevel: 'strong',
      sourcePath: 'Work/Old',
      reason: 'Delete empty folder: Work/Old',
      issueType: 'emptyFolder',
    },
  ]
}

test('buildProjectedVaultTree applies approved move, rename, merge, and delete operations', () => {
  const currentPaths = [
    'Untitled/Prompt User Requirement Expert.md',
    'Career/Job Search/Interviewer Yeah Today Pretty.md',
    'Work/Research/Competitive Analysis Copy.md',
    'Work/Research/Competitive Analysis.md',
    'Work/Notes/Testing Quality Strategy.md',
  ]
  const tree = buildProjectedVaultTree(currentPaths, fixtureOperations(), new Set([0, 1, 2, 3]))
  const paths = flattenPaths(tree)

  assert.deepEqual(paths.sort(), [
    'Career/Job Search/Interview Small Talk Practice.md',
    'Resources/AI Prompts/Prompt User Requirement Expert.md',
    'Work/Notes/Testing Quality Strategy.md',
    'Work/Research/Competitive Analysis.md',
  ].sort())
})

test('buildProjectedVaultTree ignores denied operations and keeps original files', () => {
  const currentPaths = [
    'Untitled/Prompt User Requirement Expert.md',
    'Career/Job Search/Interviewer Yeah Today Pretty.md',
  ]
  const tree = buildProjectedVaultTree(currentPaths, fixtureOperations(), new Set([1]))
  const paths = flattenPaths(tree)

  assert.deepEqual(paths.sort(), [
    'Untitled/Prompt User Requirement Expert.md',
    'Career/Job Search/Interview Small Talk Practice.md',
  ].sort())
})

test('summarizeDestinationClusters groups approved operations by destination intent', () => {
  const clusters = summarizeDestinationClusters(fixtureOperations(), new Set([0, 1, 2, 3]))

  assert.deepEqual(clusters.slice(0, 3), [
    { label: 'Career/Job Search', count: 1 },
    { label: 'Empty Folder Cleanup', count: 1 },
    { label: 'Resources/AI Prompts', count: 1 },
  ])
})

test('groupOperationsForReview separates rename cleanup from moves and deletes', () => {
  const groups = groupOperationsForReview(fixtureOperations())

  assert.deepEqual(groups.map((group) => group.label), [
    'Rename Cleanup',
    'Move Suggestions',
    'Merge Duplicates',
    'Delete Empty Folders',
  ])
  assert.equal(groups[0].operations[0]?.op.sourcePath, 'Career/Job Search/Interviewer Yeah Today Pretty.md')
})
