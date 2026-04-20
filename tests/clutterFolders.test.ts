import test from 'node:test'
import assert from 'node:assert/strict'

import { detectShallowClutterFolder } from '../src/utils/clutterFolders.ts'

test('detectShallowClutterFolder identifies shallow exports container full of noisy files', () => {
  const result = detectShallowClutterFolder(
    'Finance/Exports',
    [
      'Finance/Exports/statement copy (1).csv',
      'Finance/Exports/statement copy (2).csv',
      'Finance/Exports/export-final.csv',
    ],
    [],
  )

  assert.deepEqual(result, {
    sourceFolder: 'Finance/Exports',
    targetFolder: 'Finance',
    filePaths: [
      'Finance/Exports/statement copy (1).csv',
      'Finance/Exports/statement copy (2).csv',
      'Finance/Exports/export-final.csv',
    ],
    reason: "Flatten shallow clutter folder 'Finance/Exports' into 'Finance'",
  })
})

test('detectShallowClutterFolder identifies scan dump folders', () => {
  const result = detectShallowClutterFolder(
    'Personal/Scans',
    [
      'Personal/Scans/scan0001.pdf',
      'Personal/Scans/scan0002.pdf',
    ],
    [],
  )

  assert.equal(result?.targetFolder, 'Personal')
})

test('detectShallowClutterFolder ignores top-level clutter folders to stay conservative', () => {
  const result = detectShallowClutterFolder(
    'Exports',
    ['Exports/statement copy (1).csv'],
    [],
  )

  assert.equal(result, null)
})

test('detectShallowClutterFolder ignores folders with meaningful filenames', () => {
  const result = detectShallowClutterFolder(
    'Work/Exports',
    [
      'Work/Exports/Q1 Revenue Report.csv',
      'Work/Exports/Q2 Revenue Report.csv',
    ],
    [],
  )

  assert.equal(result, null)
})

test('detectShallowClutterFolder ignores folders that contain subfolders', () => {
  const result = detectShallowClutterFolder(
    'Work/Exports',
    ['Work/Exports/statement copy (1).csv'],
    ['Work/Exports/Archive'],
  )

  assert.equal(result, null)
})
