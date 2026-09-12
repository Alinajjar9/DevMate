const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertUndoSnapshotsMatch, createRequestUndo, MAX_UNDO_BYTES, parseRequestUndo,
  recordRequestUndo, requestUndoState
} = require('../out/requestUndo');

const bytes = value => value === null ? null : Buffer.from(value).toString('base64');
const change = (path, before, after) => ({ path, before: bytes(before), after: bytes(after) });

test('request undo keeps the first contents and latest result across repeated edits and relocation', () => {
  let journal = createRequestUndo('workspace', 'request-1');
  journal = recordRequestUndo(journal, [change('app.ts', 'original', 'first edit')]);
  journal = recordRequestUndo(journal, [change('app.ts', 'first edit', 'second edit')]);
  journal = recordRequestUndo(journal, [change('app.ts', 'second edit', null), change('src/app.ts', null, 'second edit')]);
  assert.deepEqual(journal.files, [change('app.ts', 'original', null), change('src/app.ts', null, 'second edit')]);
  assert.deepEqual(parseRequestUndo(JSON.parse(JSON.stringify(journal)), 'workspace'), journal);
  assert.equal(requestUndoState(journal).files, 2);
});

test('request undo cancels create-then-delete and edit-then-restore paths', () => {
  let journal = createRequestUndo('workspace', 'request-2');
  journal = recordRequestUndo(journal, [change('temp.ts', null, ''), change('app.ts', 'old', 'new')]);
  journal = recordRequestUndo(journal, [change('temp.ts', '', null), change('app.ts', 'new', 'old')]);
  assert.deepEqual(journal.files, []);
  assert.equal(requestUndoState(journal).available, false);
});

test('request undo disables the whole request when its snapshots exceed the bound or continuity breaks', () => {
  const original = recordRequestUndo(createRequestUndo('workspace', 'request-3'), [change('first.ts', 'before', 'after')]);
  const tooLarge = recordRequestUndo(original, [change('large.ts', null, 'a'.repeat(MAX_UNDO_BYTES))]);
  assert.deepEqual(tooLarge.files, []);
  assert.match(tooLarge.unavailableReason, /2 MB snapshot limit/);
  const interrupted = recordRequestUndo(original, [change('first.ts', 'manual edit', 'model edit')]);
  assert.deepEqual(interrupted.files, []);
  assert.match(interrupted.unavailableReason, /outside the recorded request/);
});

test('request undo checks exact bytes and missing destinations before any restoration', () => {
  const journal = recordRequestUndo(createRequestUndo('workspace', 'request-4'), [
    change('app.ts', '\ufeffbefore\r\n', 'after\r\n'), change('deleted.ts', 'restore me', null)
  ]);
  assert.doesNotThrow(() => assertUndoSnapshotsMatch(journal, [
    { path: 'app.ts', bytes: bytes('after\r\n') }, { path: 'deleted.ts', bytes: null }
  ]));
  assert.throws(() => assertUndoSnapshotsMatch(journal, [
    { path: 'app.ts', bytes: bytes('after\n') }, { path: 'deleted.ts', bytes: null }
  ]), /newer changes/);
  assert.throws(() => assertUndoSnapshotsMatch(journal, [
    { path: 'app.ts', bytes: bytes('after\r\n') }, { path: 'deleted.ts', bytes: bytes('new user file') }
  ]), /deleted.ts changed/);
});

test('request undo rejects another workspace, unsafe paths, malformed bytes and duplicate saved paths', () => {
  const journal = recordRequestUndo(createRequestUndo('workspace', 'request-5'), [change('app.ts', 'before', 'after')]);
  assert.equal(parseRequestUndo(journal, 'another-workspace'), undefined);
  for (const path of ['../outside.ts', 'C:/outside.ts', '.env', 'src/../../outside.ts']) {
    assert.equal(parseRequestUndo({ ...journal, files: [{ ...journal.files[0], path }] }, 'workspace'), undefined);
  }
  assert.equal(parseRequestUndo({ ...journal, files: [{ ...journal.files[0], before: 'not base64' }] }, 'workspace'), undefined);
  assert.equal(parseRequestUndo({ ...journal, files: [journal.files[0], journal.files[0]] }, 'workspace'), undefined);
});
