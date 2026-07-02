const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_FILE_CHANGE_CHARACTERS,
  normalizeWorkspaceRelativePath,
  validateFileChanges
} = require('../out/fileChanges');

test('accepts and normalizes safe workspace-relative changes', () => {
  const changes = validateFileChanges([
    { path: 'src\\feature.ts', content: 'export const ready = true;\n' },
    { path: 'README.md', content: '# Project\n' }
  ]);

  assert.deepEqual(changes, [
    { path: 'src/feature.ts', content: 'export const ready = true;\n' },
    { path: 'README.md', content: '# Project\n' }
  ]);
});

test('rejects absolute paths, traversal, and invalid Windows paths', () => {
  for (const path of [
    'C:\\outside.txt',
    '../outside.txt',
    '/outside.txt',
    '\\\\server\\share.txt',
    'src/CON.txt',
    'src/bad?.ts'
  ]) {
    assert.throws(() => normalizeWorkspaceRelativePath(path));
  }
});

test('rejects protected, duplicate, binary, and oversized changes', () => {
  assert.throws(() => validateFileChanges([
    { path: '.env', content: 'SECRET=value' }
  ]), /protected/);
  assert.throws(() => validateFileChanges([
    { path: 'src/app.ts', content: 'one' },
    { path: 'SRC/APP.ts', content: 'two' }
  ]), /more than once/);
  assert.throws(() => validateFileChanges([
    { path: 'src/app.ts', content: 'a\0b' }
  ]), /binary/);
  assert.throws(() => validateFileChanges([
    { path: 'src/app.ts', content: 'a'.repeat(MAX_FILE_CHANGE_CHARACTERS + 1) }
  ]), /per-file/);
  for (const marker of [
    '[omitted after execution: 33124 characters, sha256 c65bca3ac757f148]',
    '[DevMate internal history summary: content omitted after execution; 33124 characters; sha256 c65bca3ac757f148; never use as file content]'
  ]) {
    assert.throws(() => validateFileChanges([
      { path: 'static/styles.css', content: marker }
    ]), /internal tool-history marker/);
  }
});
