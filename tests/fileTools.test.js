const assert = require('node:assert/strict');
const test = require('node:test');

test('editor change summaries use actual affected files and omit no-op results', () => {
  const { collectFileChangeSummary } = require('../out/fileTools');
  assert.deepEqual(collectFileChangeSummary([
    { name: 'rename_symbol', arguments: { path: 'a.ts' }, isError: false, result: 'Applied file changes:\n- Updated a.ts\n- Updated b.ts' },
    { name: 'format_file', arguments: { path: 'c.ts' }, isError: false, result: 'No text changes were needed.' }
  ]), [{ kind: 'updated', path: 'a.ts' }, { kind: 'updated', path: 'b.ts' }]);
});

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

test('accepts an empty newText for partial deletion or an empty resulting file', () => {
  const parsed = parseEditFileArguments({
    path: 'src/app.ts',
    replacements: [{ oldText: 'remove this\n', newText: '' }]
  });
  assert.equal(applyExactReplacements('keep this\nremove this\n', parsed.replacements), 'keep this\n');
  assert.equal(applyExactReplacements('remove this\n', parsed.replacements), '');
});

test('replacement text preserves literal dollar sequences in source code', () => {
  const newText = "const tokens = [\"$&\", \"$$\", \"$`\", \"$'\", \"$1\"];";
  assert.equal(
    applyExactReplacements('before\nPLACEHOLDER\nafter', [{ oldText: 'PLACEHOLDER', newText }]),
    `before\n${newText}\nafter`
  );
});

test('identifies the malformed edit field and explains empty strings correctly', () => {
  const invalidCases = [
    [{ oldText: 'match' }, /replacements\[0\]\.newText is missing.*empty string ""/],
    [{ oldText: 'match', newText: null }, /replacements\[0\]\.newText must be a string; received null/],
    [{ newText: '' }, /replacements\[0\]\.oldText is missing/],
    [{ oldText: '', newText: 'insert' }, /replacements\[0\]\.oldText must not be empty.*existing anchor/],
    ['match', /replacements\[0\] must be an object/]
  ];
  for (const [replacement, expected] of invalidCases) {
    assert.throws(() => parseEditFileArguments({ path: 'app.ts', replacements: [replacement] }), expected);
  }
  assert.throws(() => parseEditFileArguments({ path: 'app.ts', replacements: {} }), /replacements must be an array/);
  assert.throws(() => parseEditFileArguments({ path: 'app.ts', replacements: [] }), /between 1 and 20 entries; received 0/);
  assert.throws(() => parseEditFileArguments({
    path: 'app.ts', replacements: [{ oldText: 'valid', newText: '' }, { oldText: 'second', newText: 0 }]
  }), /replacements\[1\]\.newText must be a string; received number/);
});

test('later match failures explain that the whole edit call leaves the file unchanged', () => {
  const original = 'first\nsecond\nlast';
  assert.throws(() => applyExactReplacements(original, [
    { oldText: 'first', newText: 'changed' },
    { oldText: 'second', newText: '' },
    { oldText: 'missing', newText: 'replacement' }
  ]), /Replacement 3 did not match.*No changes from this edit_file call were applied/);
  assert.equal(original, 'first\nsecond\nlast');
  assert.throws(() => applyExactReplacements('same same', [
    { oldText: 'same', newText: '' }
  ]), /matched more than once.*No changes from this edit_file call were applied/);
  assert.throws(() => applyExactReplacements('same', [
    { oldText: 'same', newText: 'same' }
  ]), /do not change the file/);
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
