const assert = require('node:assert/strict');
const test = require('node:test');
const { applyProviderTextEdits } = require('../out/editorTools');
const edit = (sl, sc, el, ec, newText) => ({ range: { start: { line: sl, character: sc }, end: { line: el, character: ec } }, newText });

test('provider edits use UTF-16 positions, preserve CRLF and support deletion and insertion', () => {
  assert.equal(applyProviderTextEdits('😀 foo\r\nfoo\r\n', [edit(1, 0, 1, 3, ''), edit(0, 3, 0, 6, 'bar'), edit(2, 0, 2, 0, 'end')]), '😀 bar\r\n\r\nend');
  assert.equal(applyProviderTextEdits('a\rb\nc', [edit(0, 1, 2, 0, '-')]), 'a-c');
});

test('invalid or ambiguous provider ranges fail without clamping to another location', () => {
  for (const edits of [[edit(1, 0, 1, 1, '')], [edit(0, 4, 0, 4, '')], [edit(0, -1, 0, 0, '')],
    [edit(0, 2, 0, 1, '')], [edit(0, 0, 0, 2, 'x'), edit(0, 1, 0, 3, 'y')],
    [edit(0, 1, 0, 1, 'x'), edit(0, 1, 0, 1, 'y')]]) {
    assert.throws(() => applyProviderTextEdits('abc', edits), /invalid|reversed|overlapping/);
  }
  assert.equal(applyProviderTextEdits('abc', []), 'abc');
});
