const assert = require('node:assert/strict');
const test = require('node:test');

const {
  collectFileChangeSummary,
  parseAppliedFileChangeOutcome,
  parseFileChangeSummary
} = require('../out/changeSummary');

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

test('parses applied legacy changes without recording denied proposals', () => {
  assert.deepEqual(parseAppliedFileChangeOutcome([
    'Applied file changes:',
    '- Created index.html',
    '- Updated src/app.ts'
  ].join('\n')), [
    { kind: 'created', path: 'index.html' },
    { kind: 'updated', path: 'src/app.ts' }
  ]);
  assert.deepEqual(parseAppliedFileChangeOutcome('Proposed file changes were not applied.'), []);
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
