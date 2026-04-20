import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyFormattingAction,
  createEditorHistory,
  pushHistory,
  redoHistory,
  undoHistory,
} from '../src/utils/editorFormatting.ts'

test('bold wraps selected text', () => {
  const input = 'hello world'
  const result = applyFormattingAction('bold', input, 6, 11)
  assert.equal(result.content, 'hello **world**')
  assert.equal(result.selectionStart, 8)
  assert.equal(result.selectionEnd, 13)
})

test('bold toggles off when already wrapped', () => {
  const input = 'hello **world**'
  const start = input.indexOf('world')
  const end = start + 'world'.length
  const result = applyFormattingAction('bold', input, start, end)
  assert.equal(result.content, 'hello world')
  assert.equal(result.selectionStart, 6)
  assert.equal(result.selectionEnd, 11)
})

test('italic with empty selection inserts placeholder selection', () => {
  const input = 'abc'
  const result = applyFormattingAction('italic', input, 3, 3)
  assert.equal(result.content, 'abc*italic*')
  assert.equal(result.content.slice(result.selectionStart, result.selectionEnd), 'italic')
})

test('h1 converts multiple lines and strips prior heading depth', () => {
  const input = '### old title\nplain line\n'
  const result = applyFormattingAction('h1', input, 0, input.length)
  assert.equal(result.content, '# old title\n# plain line\n')
})

test('todo converts bullets and numbered list to tasks', () => {
  const input = '- item a\n2. item b\n'
  const result = applyFormattingAction('todo', input, 0, input.length)
  assert.equal(result.content, '- [ ] item a\n- [ ] item b\n')
})

test('quote normalizes nested quote markers into single quote', () => {
  const input = '>> deeply quoted'
  const result = applyFormattingAction('quote', input, 0, input.length)
  assert.equal(result.content, '> deeply quoted')
})

test('code wraps selection in fenced block', () => {
  const input = 'const x = 1;'
  const result = applyFormattingAction('code', input, 0, input.length)
  assert.equal(result.content, '```txt\nconst x = 1;\n```')
})

test('code unwraps selected fenced block', () => {
  const input = '```txt\nconst x = 1;\n```'
  const result = applyFormattingAction('code', input, 0, input.length)
  assert.equal(result.content, 'const x = 1;')
})

test('code with collapsed selection inserts editable fence body', () => {
  const input = ''
  const result = applyFormattingAction('code', input, 0, 0)
  assert.equal(result.content, '```txt\n\n```')
  assert.equal(result.selectionStart, '```txt\n'.length)
  assert.equal(result.selectionEnd, '```txt\n'.length)
})

test('formatting selection range clamps and normalizes inverted selection', () => {
  const input = 'abcdef'
  const result = applyFormattingAction('bold', input, 5, 2)
  assert.equal(result.content, 'ab**cde**f')
})

test('history undo/redo handles worst-case chain and caps length', () => {
  let history = createEditorHistory(3)
  const snapshots = [
    { content: 'a', selectionStart: 1, selectionEnd: 1 },
    { content: 'ab', selectionStart: 2, selectionEnd: 2 },
    { content: 'abc', selectionStart: 3, selectionEnd: 3 },
    { content: 'abcd', selectionStart: 4, selectionEnd: 4 },
  ]

  for (const snap of snapshots) {
    history = pushHistory(history, snap)
  }

  assert.equal(history.past.length, 3)
  assert.deepEqual(history.past.map((s) => s.content), ['ab', 'abc', 'abcd'])

  const current = { content: 'abcde', selectionStart: 5, selectionEnd: 5 }
  const undo1 = undoHistory(history, current)
  assert.equal(undo1.snapshot?.content, 'abcd')
  const undo2 = undoHistory(undo1.history, undo1.snapshot!)
  assert.equal(undo2.snapshot?.content, 'abc')

  const redo1 = redoHistory(undo2.history, undo2.snapshot!)
  assert.equal(redo1.snapshot?.content, 'abcd')
})
