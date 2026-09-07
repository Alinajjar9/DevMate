const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const { withVscodeMock } = require('./helpers/withVscodeMock');

test('the VS Code import helper restores the loader after successful and failed imports', () => {
  const originalLoad = Module._load;
  const vscode = { marker: 'this test only' };
  assert.equal(withVscodeMock(vscode, () => require('vscode')), vscode);
  assert.equal(Module._load, originalLoad);

  assert.throws(() => withVscodeMock(vscode, () => { throw new Error('failed import'); }), /failed import/);
  assert.equal(Module._load, originalLoad);
});
