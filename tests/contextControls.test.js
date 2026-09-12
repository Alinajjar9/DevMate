const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createVscodeHarness } = require('./helpers/vscode');
const { isContextExcluded } = require('../out/contextControls');
const harness = createVscodeHarness();
const { WorkspaceContext } = harness.load('workspaceContext.js');

function context() {
  harness.files.clear(); harness.reads.length = 0; harness.realpaths.clear();
  return new WorkspaceContext(harness.context(), { postMessage() {}, postStatus() {} });
}

test('starting-context exclusions match whole paths and supported globs', () => {
  for (const file of ['docs/a.md', 'src/docs/a.md']) assert.equal(isContextExcluded(file, ['docs']), true);
  assert.equal(isContextExcluded('docs/a.md', ['**/docs/**']), true);
  assert.equal(isContextExcluded('src/docs/a.md', ['docs/**']), false);
  assert.equal(isContextExcluded('src/a.test.ts', ['**/*.test.?s']), true);
  assert.equal(isContextExcluded('src/a.ts', ['src/*.js']), false);
  assert.equal(isContextExcluded('mydocs/a.md', ['docs']), false);
  assert.equal(isContextExcluded('src/a+b.ts', ['src/a+b.ts']), true);
});

test('pinned files come first, use fresh contents, and share the context limit', async () => {
  const workspace = context();
  harness.setFile('src/important.ts', 'pinned content '.repeat(200));
  harness.setFile('src/other.ts', 'token implementation');
  const options = { pinnedFiles: ['src/important.ts'], excludedPaths: [], contextCharacters: 1000 };
  const first = (await workspace.collectScope('project', 'token', options)).apiScope;
  assert.equal(first.items.length, 1);
  assert.match(first.items[0].filePath, /important\.ts$/);
  assert.equal(first.items[0].includedCharacters, 1000);
  assert.equal(first.items[0].truncated, true);
  harness.setFile('src/important.ts', 'updated pin', 2);
  const next = (await workspace.collectScope('project', 'token', options)).apiScope;
  assert.equal(next.items[0].content, 'updated pin');
  assert.ok(next.items.reduce((n, item) => n + item.includedCharacters, 0) <= 1000);
});

test('exclusions apply to pins and cached retrieval without suppressing unrelated files', async () => {
  const workspace = context();
  harness.setFile('docs/details.md', 'token implementation secret notes');
  harness.setFile('src/main.ts', 'token implementation');
  const options = { pinnedFiles: ['docs/details.md'], excludedPaths: [], contextCharacters: 40000 };
  await workspace.collectScope('project', 'token', options);
  const filtered = (await workspace.collectScope('project', 'token', { ...options, excludedPaths: ['docs'] })).apiScope;
  assert.ok(filtered.items.length > 0);
  assert.ok(filtered.items.every(item => !item.filePath.includes('details.md')));
});

test('pins and cache refresh refuse symlink aliases outside the project or into protected files', async () => {
  const workspace = context();
  const alias = harness.setFile('src/alias.ts', 'token private content');
  harness.setFile('src/public.ts', 'token public content');
  for (const target of [path.resolve(harness.root, '../outside.ts'), path.resolve(harness.root, '.env')]) {
    harness.realpaths.set(alias.fsPath, target);
    const scope = (await workspace.collectScope('project', 'token', {
      pinnedFiles: ['src/alias.ts'], excludedPaths: [], contextCharacters: 40000
    })).apiScope;
    assert.ok(scope.items.every(item => !item.filePath.endsWith('alias.ts')));
  }
});
