const assert = require('node:assert/strict');
const test = require('node:test');
const { withVscodeMock } = require('./helpers/withVscodeMock');

const folder = { name: 'Project', uri: { scheme: 'file', fsPath: 'C:/repo' } };
const endListeners = new Set();
let activeTerminal;
const vscode = {
  FileType: { Directory: 2 },
  workspace: {
    isTrusted: true,
    workspaceFolders: [folder],
    fs: { stat: async () => ({ type: 2 }) },
    getConfiguration: () => ({ get: (_key, fallback) => fallback })
  },
  window: {
    createTerminal: () => activeTerminal,
    onDidEndTerminalShellExecution: (listener) => {
      endListeners.add(listener);
      return { dispose: () => endListeners.delete(listener) };
    }
  }
};
const { ToolExecutor, ToolPermissionDeniedError } = withVscodeMock(
  vscode, () => require('../out/agent/toolExecutor')
);

function fixture(options = {}) {
  endListeners.clear();
  vscode.workspace.isTrusted = true;
  const controller = new AbortController();
  const commands = [];
  const activities = [];
  let disposed = 0;
  let execution;
  const terminal = {
    dispose: () => { disposed += 1; },
    shellIntegration: {
      executeCommand: (executable, args) => {
        commands.push({ executable, args });
        execution = { read: async function* () { yield '\u001b[32mTest output\u001b[0m'; } };
        // VS Code reports completion separately from the output reader.
        if (options.finish !== false) {
          setImmediate(() => {
            if (options.cancel) {
              controller.abort();
            } else {
              for (const listener of [...endListeners]) {
                listener({ execution, exitCode: options.exitCode ?? 0 });
              }
            }
          });
        }
        return execution;
      }
    }
  };
  activeTerminal = terminal;
  const executor = new ToolExecutor({}, {}, {
    getAgentToolSettings: () => ({}),
    requestCommandPermission: async () => {
      if (options.revokeTrust) vscode.workspace.isTrusted = false;
      return options.permission !== false;
    },
    postAgentToolActivity: (...args) => activities.push(args)
  });
  return {
    executor, terminal, controller, commands, activities,
    get disposed() { return disposed; }
  };
}

function runCommand(fixture) {
  return fixture.executor.execute({
    id: 'verification', name: 'run_command',
    arguments: { executable: 'npm', args: ['test'], cwd: '' }
  }, { remainingMutationCharacters: 10_000, signal: fixture.controller.signal });
}

test('verification uses shell completion and returns sanitized output', async () => {
  const state = fixture();
  const result = await runCommand(state);
  assert.deepEqual(state.commands, [{ executable: 'npm', args: ['test'] }]);
  assert.equal(result.step.isError, false);
  assert.equal(result.commandAttempted, true);
  assert.match(result.step.result, /Exit code: 0/);
  assert.match(result.step.result, /Output:\nTest output/);
  assert.equal(result.step.result.includes('\u001b'), false);
  assert.equal(state.disposed, 0);
  assert.equal(endListeners.size, 0);
  assert.equal(state.activities.some((activity) => activity[1] === 'Running verification command'), true);
});

test('failed verification still records that a command was attempted', async () => {
  const state = fixture({ exitCode: 1 });
  const result = await runCommand(state);
  assert.equal(result.step.isError, true);
  assert.equal(result.commandAttempted, true);
  assert.match(result.step.result, /Exit code: 1/);
  assert.equal(endListeners.size, 0);
});

test('cancelling a running verification disposes the terminal and spends its command slot', async () => {
  const state = fixture({ cancel: true });
  const result = await runCommand(state);
  assert.equal(result.step.isError, true);
  assert.equal(result.commandAttempted, true);
  assert.match(result.step.result, /cancelled/);
  assert.equal(state.disposed, 1);
  assert.equal(endListeners.size, 0);
});

test('permission denial does not start or spend a verification command', async () => {
  const state = fixture({ permission: false });
  const result = await runCommand(state);
  assert.equal(result.permissionDenied, true);
  assert.equal(result.commandAttempted, false);
  assert.deepEqual(state.commands, []);
});

test('trust revoked during command approval is rechecked before terminal execution', async () => {
  const state = fixture({ revokeTrust: true });
  try {
    const result = await runCommand(state);
    assert.match(result.step.result, /Workspace Trust changed/);
    assert.equal(result.commandAttempted, false);
    assert.deepEqual(state.commands, []);
  } finally {
    vscode.workspace.isTrusted = true;
  }
});

test('the shared terminal lifecycle times out and releases its listener', async () => {
  const state = fixture({ finish: false });
  const output = [];
  const outcome = await state.executor.executeTerminalStep(
    state.terminal, state.terminal.shellIntegration, 'npm', ['test'], 5,
    state.controller.signal, (chunk) => output.push(chunk)
  );
  assert.deepEqual(outcome, { state: 'timeout' });
  assert.equal(output.length, 1);
  assert.equal(state.disposed, 1);
  assert.equal(endListeners.size, 0);
});

test('permission metadata is independent of display-message wording', async () => {
  const state = fixture();
  state.executor.runAgentTool = async () => { throw new ToolPermissionDeniedError('Approval declined.'); };
  const denied = await runCommand(state);
  assert.equal(denied.permissionDenied, true);
  assert.equal(denied.step.result, 'Approval declined.');
  state.executor.runAgentTool = async () => { throw new Error('Permission to install dependencies was denied.'); };
  const ordinaryFailure = await runCommand(state);
  assert.equal(ordinaryFailure.permissionDenied, false);
});
