const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_CONTEXT_CHARACTERS,
  createBoundedContextItem
} = require('../out/context');

test('keeps normal file content unchanged', () => {
  const content = 'export const answer = 42;';
  const item = createBoundedContextItem('file', 'C:/repo/src/app.ts', 'typescript', content);

  assert.equal(item.content, content);
  assert.equal(item.includedCharacters, content.length);
  assert.equal(item.totalCharacters, content.length);
  assert.equal(item.truncated, false);
});

test('accepts an empty active file', () => {
  const item = createBoundedContextItem('file', 'C:/repo/src/empty.ts', 'typescript', '');

  assert.equal(item.content, '');
  assert.equal(item.includedCharacters, 0);
  assert.equal(item.totalCharacters, 0);
  assert.equal(item.truncated, false);
});

test('truncates oversized content to the context limit', () => {
  const content = 'a'.repeat(MAX_CONTEXT_CHARACTERS + 500);
  const item = createBoundedContextItem('file', 'C:/repo/src/large.ts', 'typescript', content);

  assert.equal(item.content.length, MAX_CONTEXT_CHARACTERS);
  assert.equal(item.includedCharacters, MAX_CONTEXT_CHARACTERS);
  assert.equal(item.totalCharacters, MAX_CONTEXT_CHARACTERS + 500);
  assert.equal(item.truncated, true);
});

test('applies a smaller attachment-specific limit', () => {
  const content = 'a'.repeat(10_000);
  const item = createBoundedContextItem(
    'attachment',
    'C:/repo/src/reference.ts',
    'typescript',
    content,
    8_000
  );

  assert.equal(item.source, 'attachment');
  assert.equal(item.includedCharacters, 8_000);
  assert.equal(item.totalCharacters, 10_000);
  assert.equal(item.truncated, true);
});
