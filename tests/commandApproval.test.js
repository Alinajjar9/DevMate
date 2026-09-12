const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { commandApprovalIdentity } = require('../out/commandApproval');
const root = path.resolve('approval-project');

function fixture() {
  const files = new Map();
  const set = (name, text) => files.set(path.resolve(root, name), Buffer.from(text));
  const reader = { canonicalPath: async value => path.resolve(value), readFile: async value => files.get(path.resolve(value)) };
  const command = { executable: path.resolve(root, '../tools/npm.cmd'), args: ['run', 'test'], cwd: '', timeoutSeconds: 300 };
  set('../tools/npm.cmd', 'known executable wrapper');
  set('package.json', JSON.stringify({ scripts: { test: 'node scripts/check.js', pretest: 'node scripts/prepare.js' } }));
  set('scripts/check.js', 'check()');
  set('scripts/prepare.js', 'prepare()');
  return { set, reader, command };
}

test('approval changes when a script, hook, config, canonical directory or exact invocation changes', async () => {
  for (const change of [
    item => item.set('scripts/check.js', 'changed()'),
    item => item.set('scripts/prepare.js', 'changedHook()'),
    item => item.set('package.json', '{"scripts":{"test":"node other.js"}}'),
    item => item.set('.npmrc', 'ignore-scripts=true'),
    item => { item.command.args = ['run', 'compile']; },
    item => { item.command.timeoutSeconds = 600; },
    item => { item.reader.canonicalPath = async value => path.resolve('other-root', path.basename(value)); }
  ]) {
    const item = fixture();
    const before = await commandApprovalIdentity(item.command, root, item.reader);
    change(item);
    const after = await commandApprovalIdentity(item.command, root, item.reader);
    assert.notEqual(before.signature, after.signature);
  }
});

test('project scripts and incomplete identity cannot obtain remembered approvals', async () => {
  const item = fixture();
  assert.equal((await commandApprovalIdentity(item.command, root, item.reader)).rememberable, false);
  item.command.executable = path.resolve(root, '../tools/python.exe');
  item.set('../tools/python.exe', 'runtime bytes');
  item.command.args = ['--version'];
  assert.equal((await commandApprovalIdentity(item.command, root, item.reader)).rememberable, true);
  item.command.executable = 'npm';
  assert.equal((await commandApprovalIdentity(item.command, root, item.reader)).rememberable, false);
  item.command.executable = path.join(root, 'npm.cmd');
  assert.equal((await commandApprovalIdentity(item.command, root, item.reader)).rememberable, false);
});

test('fingerprint hashing stops at its file and byte limits and never remembers an incomplete snapshot', async () => {
  const item = fixture();
  let reads = 0;
  item.reader.readFile = async () => { reads++; return Buffer.alloc(2_000_000); };
  const identity = await commandApprovalIdentity({ ...item.command, args: ['--version'] }, root, item.reader);
  assert.equal(identity.rememberable, false);
  assert.ok(reads <= 2, `Expected bounded reads; saw ${reads}`);
});
