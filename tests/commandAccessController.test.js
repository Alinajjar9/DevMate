const assert = require('node:assert/strict');
const test = require('node:test');
const { createVscodeHarness } = require('./helpers/vscode');
const harness = createVscodeHarness();
const { vscode, folder } = harness;
const { DevMateChatViewProvider } = harness.load('chatViewProvider');
function setup() {
  vscode.workspace.workspaceFolders = [folder]; vscode.workspace.isTrusted = true;
  const context = harness.context();
  const provider = new DevMateChatViewProvider(context, { start: async () => true, status: { detail: 'online', state: 'running' } }, { show() {} });
  const messages = []; provider.postMessage = message => messages.push(message);
  let stopped = 0; provider.tools.stopAllManagedCommands = async () => { stopped++; };
  return { provider, context, messages, stopped: () => stopped };
}

test('Extended requires a native confirmation and stays in workspace state', async () => {
  const run = setup();
  try {
    vscode.window.showWarningMessage = async () => undefined;
    await run.provider.handleMessage({ command: 'setCommandAccess', access: 'extended' });
    assert.equal(run.context.workspaceValues.size, 0);
    assert.equal(run.messages.at(-1).access, 'standard');
    vscode.window.showWarningMessage = async (message, options) => {
      assert.equal(options.modal, true); assert.match(message, /not sandboxed/); return 'Enable Extended';
    };
    await run.provider.handleMessage({ command: 'setCommandAccess', access: 'extended' });
    assert.equal(run.context.workspaceValues.get('devMate.commandAccess.v1'), 'extended');
    assert.equal(run.context.globalValues.has('devMate.commandAccess.v1'), false);
    assert.equal(harness.workspaceConfiguration.has('commandAccess'), false);
    await run.provider.handleMessage({ command: 'setCommandAccess', access: 'standard' });
    assert.equal(run.stopped(), 1); assert.equal(run.messages.at(-1).access, 'standard');
  } finally { run.provider.dispose(); }
});

test('busy, untrusted and changed workspaces cannot gain Extended access', async () => {
  const run = setup(); let confirmations = 0;
  vscode.window.showWarningMessage = async () => { confirmations++; return 'Enable Extended'; };
  try {
    run.provider.auxiliaryBusy = true;
    await run.provider.handleMessage({ command: 'setCommandAccess', access: 'extended' });
    assert.equal(run.messages.at(-1).command, 'commandAccessUpdated');
    run.provider.auxiliaryBusy = false; run.provider.activeRequest = new AbortController();
    await run.provider.handleMessage({ command: 'setCommandAccess', access: 'extended' });
    run.provider.activeRequest = undefined; vscode.workspace.isTrusted = false;
    await run.provider.handleMessage({ command: 'setCommandAccess', access: 'extended' });
    assert.equal(confirmations, 0);
    vscode.workspace.isTrusted = true;
    vscode.window.showWarningMessage = async () => { vscode.workspace.workspaceFolders = []; return 'Enable Extended'; };
    await run.provider.handleMessage({ command: 'setCommandAccess', access: 'extended' });
    assert.equal(run.context.workspaceValues.size, 0);
    assert.equal(run.messages.at(-1).workspaceAvailable, false);
  } finally { vscode.workspace.workspaceFolders = [folder]; run.provider.dispose(); }
});

test('Stop stays usable during agent work and refreshes controls after a failure', async () => {
  const run = setup(); let posted = 0;
  try {
    run.provider.auxiliaryBusy = true; run.provider.activeRequest = new AbortController();
    run.provider.tools.stopManagedCommand = async id => { assert.equal(id, 'owned-id'); throw new Error('Already stopped'); };
    run.provider.tools.postManagedCommandState = () => { posted++; };
    await run.provider.handleMessage({ command: 'stopManagedCommand', id: 'owned-id' });
    assert.equal(posted, 1);
    assert.ok(run.messages.some(message => message.command === 'status' && message.text === 'Already stopped'));
  } finally { run.provider.activeRequest = undefined; run.provider.dispose(); }
});
