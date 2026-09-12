const assert = require('node:assert/strict');
const test = require('node:test');
const { createVscodeHarness } = require('./helpers/vscode');
const harness = createVscodeHarness();
const { vscode, setFile } = harness;
const ended = new Set();
const closed = new Set();
vscode.window.onDidEndTerminalShellExecution = callback => { ended.add(callback); return { dispose: () => ended.delete(callback) }; };
vscode.window.onDidCloseTerminal = callback => { closed.add(callback); return { dispose: () => closed.delete(callback) }; };
const { ToolExecutor } = harness.load('toolExecutor');
const { COMMAND_ACCESS_STORAGE_KEY } = require('../out/commandTools');

function make(options = {}) {
  harness.files.clear();
  vscode.workspace.isTrusted = true;
  setFile('package.json', JSON.stringify({ scripts: { test: 'node scripts/check.js', dev: 'vite' } }));
  setFile('scripts/check.js', 'console.log("check")');
  const state = harness.context({ workspace: { [COMMAND_ACCESS_STORAGE_KEY]: options.access ?? 'standard' } });
  const messages = [];
  const invocations = [];
  const terminals = [];
  const controller = new AbortController();
  vscode.window.createTerminal = (settings) => {
    const terminal = { name: settings.name, disposed: false, show() {}, dispose() {
      if (this.disposed) return;
      this.disposed = true;
      for (const callback of [...closed]) callback(terminal);
    }, shellIntegration: { executeCommand(executable, args) {
      invocations.push({ executable, args });
      const execution = { async *read() { yield 'ready\n'; } };
      if (!options.background) setImmediate(() => {
        for (const callback of [...ended]) callback({ execution, exitCode: 0, terminal });
      });
      options.started?.({ controller, terminal });
      return execution;
    } } };
    terminals.push(terminal);
    options.terminalCreated?.();
    return terminal;
  };
  let executor;
  const events = {
    postMessage(message) {
      messages.push(message);
      if (message.command === 'commandPermissionRequest') queueMicrotask(async () => {
        await options.beforeApproval?.({ state, message, controller });
        await executor.handleCommandPermissionDecision(message.requestId, options.decision ?? 'allowOnce');
      });
    },
    postStatus() {}, postSettingsState() {}, postPermissionPolicyState() {},
    getActiveSignal: () => controller.signal, getAgentToolSettings: () => ({})
  };
  executor = new ToolExecutor(state, {}, events);
  const run = (args, id = 'call') => executor.executeAgentToolCall({ id, name: 'run_command', arguments: args });
  return { executor, state, messages, invocations, terminals, controller, run };
}

test('executor reads real workspace access, ignoring model-supplied Extended selection', async () => {
  const item = make();
  try {
    const result = await item.run({ executable: 'npm', args: ['install'], access: 'extended' });
    assert.equal(result.step.isError, true);
    assert.equal(item.invocations.length, 0);
    assert.equal(item.messages.some(message => message.command === 'commandPermissionRequest'), false);
  } finally { item.executor.dispose(); }
});

test('scripts and hooks changed while permission is pending require a fresh review', async () => {
  const item = make({ beforeApproval() { setFile('scripts/check.js', 'changed()'); } });
  try {
    const result = await item.run({ executable: 'npm', args: ['test'] });
    assert.equal(result.step.isError, true);
    assert.match(result.step.result, /changed after approval/);
    assert.equal(item.invocations.length, 0);
    assert.equal(item.messages.find(message => message.command === 'commandPermissionRequest').rememberable, false);
  } finally { item.executor.dispose(); }
});

test('downgrade or cancellation during approval prevents any command execution', async () => {
  for (const beforeApproval of [
    ({ state }) => state.workspaceState.update(COMMAND_ACCESS_STORAGE_KEY, 'standard'),
    ({ controller }) => controller.abort()
  ]) {
    const item = make({ access: 'extended', beforeApproval });
    try {
      const result = await item.run({ executable: 'node', args: ['scripts/check.js'] });
      assert.equal(result.step.isError, true);
      assert.equal(item.invocations.length, 0);
    } finally { item.executor.dispose(); }
  }
});

test('final script recheck after terminal startup closes the terminal without executing changed code', async () => {
  const item = make({ terminalCreated() { setFile('scripts/check.js', 'changed while terminal initialized'); } });
  try {
    const result = await item.run({ executable: 'npm', args: ['test'] });
    assert.equal(result.step.isError, true);
    assert.match(result.step.result, /changed after approval/);
    assert.equal(item.invocations.length, 0);
    assert.equal(item.terminals[0].disposed, true);
  } finally { item.executor.dispose(); }
});

test('Extended requests cannot remember approvals and denial cannot be bypassed with allowAlways', async () => {
  const item = make({ access: 'extended', decision: 'allowAlways' });
  try {
    const result = await item.run({ executable: 'node', args: ['scripts/check.js'] });
    assert.equal(result.step.isError, true);
    assert.match(result.step.result, /denied/);
    assert.equal(item.invocations.length, 0);
    assert.equal(item.messages.find(message => message.command === 'commandPermissionRequest').allowRemember, false);
    assert.equal(item.state.workspaceValues.has('devMate.rememberedCommands.v1'), false);
  } finally { item.executor.dispose(); }
});

test('approved foreground command reports its exit and leaves no active managed server', async () => {
  const item = make();
  try {
    const result = await item.run({ executable: 'npm', args: ['test'], timeoutSeconds: 600 });
    assert.equal(result.step.isError, false, result.step.result);
    assert.equal(result.commandAttempted, true);
    assert.match(result.step.result, /Exit code: 0/);
    assert.equal(item.invocations.length, 1);
    item.executor.postManagedCommandState();
    assert.deepEqual(item.messages.at(-1).commands, []);
  } finally { item.executor.dispose(); }
});

test('managed server persists between requests and unknown IDs cannot close other terminals', async () => {
  const item = make({ access: 'extended', background: true });
  try {
    const result = await item.run({ executable: 'npm', args: ['run', 'dev'], background: true });
    assert.equal(result.step.isError, false, result.step.result);
    const id = result.step.result.match(/Command ID: ([^\n]+)/)[1];
    assert.match(result.step.result, /Status: running/);
    item.executor.disposeCommandTerminals();
    item.executor.cancelPendingWork();
    assert.equal(item.terminals[0].disposed, false);
    assert.throws(() => item.executor.stopManagedCommand('user-terminal'), /does not belong/);
    assert.equal(item.terminals[0].disposed, false);
    const stopped = await item.executor.executeAgentToolCall({ id: 'stop', name: 'stop_command', arguments: { id } });
    assert.equal(stopped.step.isError, false, stopped.step.result);
    assert.equal(stopped.commandAttempted, undefined);
    assert.equal(item.terminals[0].disposed, true);
    assert.ok(item.executor.enabledAgentTools('code', 999, 999, 999,
      { maxFileEdits: 0, maxCommands: 0, enabledTools: ['stop_command'] }).includes('stop_command'));
  } finally { item.executor.dispose(); }
});

test('request cancellation during server startup and executor disposal stop owned terminals', async () => {
  const cancelled = make({ access: 'extended', background: true, started: ({ controller }) => controller.abort() });
  try {
    const result = await cancelled.run({ executable: 'npm', args: ['run', 'dev'], background: true });
    assert.equal(result.commandAttempted, true);
    assert.equal(cancelled.terminals[0].disposed, true);
    assert.match(result.step.result, /terminal closed/);
  } finally { cancelled.executor.dispose(); }
  const disposed = make({ access: 'extended', background: true });
  await disposed.run({ executable: 'npm', args: ['run', 'dev'], background: true });
  disposed.executor.dispose();
  assert.equal(disposed.terminals[0].disposed, true);
});
