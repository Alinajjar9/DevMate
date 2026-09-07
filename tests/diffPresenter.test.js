const assert = require('node:assert/strict');
const test = require('node:test');
const { withVscodeMock } = require('./helpers/withVscodeMock');

const openedDiffs = [];
const vscode = {
  Uri: {
    parse: (value) => ({
      value,
      toString: () => value
    })
  },
  commands: {
    executeCommand: async (...args) => {
      openedDiffs.push(args);
    }
  }
};

const {
  DIFF_DOCUMENT_SCHEME,
  DiffPresenter
} = withVscodeMock(vscode, () => require('../out/workspace/diffPresenter'));

test.beforeEach(() => {
  openedDiffs.length = 0;
});

test('stores, opens, and removes pending permission diffs', async () => {
  const presenter = new DiffPresenter();
  presenter.rememberPendingFileDiffs('request-1', [{
    path: 'src/file name.ts',
    originalContent: 'before',
    proposedContent: 'after'
  }]);

  const originalUri = vscode.Uri.parse(
    `${DIFF_DOCUMENT_SCHEME}:/request-1/original/src/file%20name.ts`
  );
  assert.equal(presenter.provideTextDocumentContent(originalUri), 'before');
  assert.equal(await presenter.openPendingFileDiff('request-1', 'src/file name.ts'), true);
  assert.equal(openedDiffs[0][0], 'vscode.diff');
  assert.equal(openedDiffs[0][3], 'DevMate: src/file name.ts');

  presenter.clearPendingFileDiffs('another-request');
  assert.equal(presenter.provideTextDocumentContent(originalUri), 'before');
  presenter.clearPendingFileDiffs('request-1');
  assert.equal(presenter.provideTextDocumentContent(originalUri), '');
  assert.equal(await presenter.openPendingFileDiff('request-1', 'src/file name.ts'), false);
});

test('keeps completed diffs available after the active request ends', async () => {
  const presenter = new DiffPresenter();
  const id = presenter.rememberCompletedFileDiff(
    'src/New.ts',
    'before',
    'after',
    'src/Old.ts'
  );

  assert.equal(presenter.completedDiffId('src/New.ts'), id);
  assert.equal(await presenter.openCompletedFileDiff(id), true);
  assert.equal(openedDiffs[0][3], 'src/Old.ts → src/New.ts (DevMate changes)');

  presenter.beginRequest();
  assert.equal(presenter.completedDiffId('src/New.ts'), undefined);
  assert.equal(await presenter.openCompletedFileDiff(id), true);
});

test('keeps only the forty newest completed snapshots', async () => {
  const presenter = new DiffPresenter();
  const firstId = presenter.rememberCompletedFileDiff('src/file-0.ts', '0', '1');
  for (let index = 1; index <= 40; index += 1) {
    presenter.rememberCompletedFileDiff(
      `src/file-${index}.ts`,
      String(index),
      String(index + 1)
    );
  }

  assert.equal(await presenter.openCompletedFileDiff(firstId), false);
  assert.equal(presenter.completedDiffId('src/file-0.ts'), undefined);
  assert.notEqual(presenter.completedDiffId('src/file-40.ts'), undefined);
});

test('disposing removes all virtual documents and snapshots', async () => {
  const presenter = new DiffPresenter();
  const id = presenter.rememberCompletedFileDiff('src/app.ts', 'before', 'after');
  presenter.rememberPendingFileDiffs('request-1', [{
    path: 'src/pending.ts',
    originalContent: 'before',
    proposedContent: 'after'
  }]);

  presenter.dispose();

  assert.equal(await presenter.openCompletedFileDiff(id), false);
  assert.equal(await presenter.openPendingFileDiff('request-1', 'src/pending.ts'), false);
  assert.equal(presenter.completedDiffId('src/app.ts'), undefined);
});
