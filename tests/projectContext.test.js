const assert = require('node:assert/strict');
const test = require('node:test');

const {
  containsBinaryData,
  languageIdForPath,
  MAX_PROJECT_CONTEXT_CHARACTERS,
  MAX_PROJECT_FILE_CHARACTERS,
  MAX_PROJECT_FILES,
  selectProjectContext,
  shouldSkipProjectFile
} = require('../out/projectContext');

test('filters dependency, generated, lock, and binary files', () => {
  assert.equal(shouldSkipProjectFile('node_modules/pkg/index.js'), true);
  assert.equal(shouldSkipProjectFile('src/generated/app.js.map'), true);
  assert.equal(shouldSkipProjectFile('package-lock.json'), true);
  assert.equal(shouldSkipProjectFile('.env.production'), true);
  assert.equal(shouldSkipProjectFile('config/private.key'), true);
  assert.equal(shouldSkipProjectFile('assets/logo.png'), true);
  assert.equal(shouldSkipProjectFile('src/app.ts'), false);
  assert.equal(containsBinaryData(Uint8Array.from([65, 0, 66])), true);
  assert.equal(containsBinaryData(Uint8Array.from([65, 66, 67])), false);
});

test('ranks path and content matches ahead of generic project files', () => {
  const items = selectProjectContext([
    candidate('README.md', '# Example project'),
    candidate('src/utils.ts', 'export const identity = value => value;'),
    candidate('src/auth/login.ts', 'export function validateLoginToken(token) { return token; }')
  ], 'Where is the login token validated?');

  assert.equal(items[0].filePath, 'C:/repo/src/auth/login.ts');
});

test('limits project context by file count, per-file size, and total size', () => {
  const candidates = Array.from({ length: 8 }, (_, index) =>
    candidate(`src/file${index}.ts`, `token-${index} `.repeat(2_000))
  );
  const items = selectProjectContext(candidates, 'token');
  const totalCharacters = items.reduce((total, item) => total + item.includedCharacters, 0);

  assert.equal(items.length, MAX_PROJECT_FILES);
  assert.equal(items.every((item) => item.includedCharacters <= MAX_PROJECT_FILE_CHARACTERS), true);
  assert.equal(totalCharacters <= MAX_PROJECT_CONTEXT_CHARACTERS, true);
  assert.equal(items.every((item) => item.truncated), true);
});

test('respects remaining limits after explicit attachments consume budget', () => {
  const candidates = Array.from({ length: 5 }, (_, index) =>
    candidate(`src/file${index}.ts`, `token-${index} `.repeat(2_000))
  );
  const items = selectProjectContext(candidates, 'token', {
    maxFiles: 2,
    maxCharacters: 9_000
  });

  assert.equal(items.length, 2);
  assert.equal(items[0].includedCharacters, 8_000);
  assert.equal(items[1].includedCharacters, 1_000);
});

test('infers common language identifiers from file paths', () => {
  assert.equal(languageIdForPath('src/app.ts'), 'typescript');
  assert.equal(languageIdForPath('backend/main.py'), 'python');
  assert.equal(languageIdForPath('notes.unknown'), 'plaintext');
});

function candidate(relativePath, content) {
  return {
    filePath: `C:/repo/${relativePath}`,
    relativePath,
    languageId: languageIdForPath(relativePath),
    content
  };
}
