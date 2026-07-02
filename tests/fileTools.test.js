const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyExactReplacements,
  MAX_EDIT_REPLACEMENTS,
  parseCreateFileArguments,
  parseDeleteFileArguments,
  parseEditFileArguments,
  parseMoveFileArguments,
  parseRenameFileArguments
} = require('../out/fileTools');

test('parses safe create and edit arguments', () => {
  assert.deepEqual(parseCreateFileArguments({
    path: 'src/new.ts',
    content: 'export const value = 1;'
  }), {
    path: 'src/new.ts',
    content: 'export const value = 1;'
  });
  assert.deepEqual(parseEditFileArguments({
    path: 'src/app.ts',
    replacements: [{ oldText: 'value = 1', newText: 'value = 2' }]
  }).replacements, [{ oldText: 'value = 1', newText: 'value = 2' }]);
});

test('parses safe delete, rename, and move arguments', () => {
  assert.deepEqual(parseDeleteFileArguments({ path: 'src/old.ts' }), {
    path: 'src/old.ts'
  });
  assert.deepEqual(parseRenameFileArguments({
    path: 'src/old.ts',
    newPath: 'src/new.ts'
  }), {
    path: 'src/old.ts',
    newPath: 'src/new.ts'
  });
  assert.deepEqual(parseMoveFileArguments({
    path: 'src/new.ts',
    newPath: 'archive/new.ts'
  }), {
    path: 'src/new.ts',
    newPath: 'archive/new.ts'
  });
});

test('rejects unsafe or ambiguous lifecycle operations', () => {
  assert.throws(() => parseDeleteFileArguments({ path: '.env' }), /protected|unsupported/);
  assert.throws(() => parseDeleteFileArguments({ path: '../secret.txt' }), /workspace-relative|unsafe/);
  assert.throws(() => parseRenameFileArguments({
    path: 'src/old.ts',
    newPath: 'archive/new.ts'
  }), /same directory/);
  assert.throws(() => parseMoveFileArguments({
    path: 'src/old.ts',
    newPath: 'src/old.ts'
  }), /different destination/);
  assert.throws(() => parseMoveFileArguments({
    path: 'src/old.ts',
    newPath: 'node_modules/new.ts'
  }), /protected|unsupported/);
});

test('applies sequential exact replacements', () => {
  const updated = applyExactReplacements('const value = 1;\nuse(value);', [
    { oldText: 'value = 1', newText: 'value = 2' },
    { oldText: 'use(value)', newText: 'render(value)' }
  ]);
  assert.equal(updated, 'const value = 2;\nrender(value);');
});

test('matches model LF edits against CRLF files and preserves CRLF', () => {
  const content = "first\r\ncontent_type='application/json\r\nlast\r\n";
  const updated = applyExactReplacements(content, [{
    oldText: "content_type='application/json\nlast",
    newText: "content_type='application/json'\nlast"
  }]);

  assert.equal(updated, "first\r\ncontent_type='application/json'\r\nlast\r\n");
  assert.equal(updated.replace(/\r\n/g, '').includes('\n'), false);
});

test('rejects missing, ambiguous, unsafe, and excessive replacements', () => {
  assert.throws(() => applyExactReplacements('one', [
    { oldText: 'two', newText: 'three' }
  ]), /did not match/);
  assert.throws(() => applyExactReplacements('one one', [
    { oldText: 'one', newText: 'two' }
  ]), /more than once/);
  assert.throws(() => parseEditFileArguments({
    path: 'src/app.ts',
    replacements: Array.from({ length: MAX_EDIT_REPLACEMENTS + 1 }, () => ({
      oldText: 'a',
      newText: 'b'
    }))
  }), /between 1 and/);
  assert.throws(() => parseCreateFileArguments({
    path: '../secret.txt',
    content: 'nope'
  }), /workspace-relative|unsafe/);
  assert.throws(() => parseEditFileArguments({
    path: 'styles.css',
    replacements: [{
      oldText: 'body {}',
      newText: '[42 characters, sha256 c65bca3ac757f148]'
    }]
  }), /internal tool-history marker/);
});
