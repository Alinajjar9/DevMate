const assert = require('node:assert/strict');
const test = require('node:test');

const {
  collectFileChangeSummary,
  formatFileChangeApplicationOutcome,
  parseFileChangeSummary
} = require('../out/workspace/fileTools');

test('collects successful file mutations into a compact net summary', () => {
  const summary = collectFileChangeSummary([
    step('create_file', { path: 'src/new.ts' }),
    step('edit_file', { path: 'src/new.ts' }),
    step('create_file', { path: 'src/temporary.ts' }),
    step('delete_file', { path: 'src/temporary.ts' }),
    step('edit_file', { path: 'src/app.ts' }),
    step('move_file', { path: 'src/app.ts', newPath: 'app/app.ts' }),
    step('edit_file', { path: 'src/old.ts' }),
    step('delete_file', { path: 'src/old.ts' }),
    step('delete_file', { path: 'ignored.ts' }, true)
  ]);

  assert.deepEqual(summary, [
    { kind: 'created', path: 'src/new.ts' },
    { kind: 'moved', path: 'app/app.ts', previousPath: 'src/app.ts' },
    { kind: 'deleted', path: 'src/old.ts' }
  ]);
});

test('formats applied changes without using display text as operation state', () => {
  assert.equal(formatFileChangeApplicationOutcome({ kind: 'applied', changes: [
    { kind: 'created', path: 'index.html' },
    { kind: 'updated', path: 'src/app.ts' }
  ] }), [
    'Applied file changes:',
    '- Created index.html',
    '- Updated src/app.ts'
  ].join('\n'));
  assert.equal(formatFileChangeApplicationOutcome({
    kind: 'applied', changes: [{ kind: 'updated', path: 'src/app.ts' }], notice: 'Could not open the editor.'
  }), 'Applied file changes:\n- Updated src/app.ts\n\nCould not open the editor.');
  for (const kind of ['denied', 'cancelled']) {
    assert.equal(formatFileChangeApplicationOutcome({ kind, message: 'Not applied.' }), 'Not applied.');
  }
});

test('keeps only bounded safe persisted summary items', () => {
  assert.deepEqual(parseFileChangeSummary([
    { kind: 'updated', path: 'src/app.ts', diffId: 'change_123-abc' },
    { kind: 'created', path: 'src/new.ts', diffId: '../unsafe' },
    { kind: 'deleted', path: '../secret.txt' },
    { kind: 'moved', path: 'src/new.ts' },
    { kind: 'unknown', path: 'src/no.ts' }
  ]), [
    { kind: 'updated', path: 'src/app.ts', diffId: 'change_123-abc' },
    { kind: 'created', path: 'src/new.ts' }
  ]);
});

function step(name, argumentsValue, isError = false) {
  return { name, arguments: argumentsValue, isError };
}
