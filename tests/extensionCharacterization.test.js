const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const configuration = new Map([
  ['backendUrl', 'http://127.0.0.1:8000'],
  ['maxTokens', 2048],
  ['temperature', 0.35],
  ['toolCallLimit', 16],
  ['requestTimeoutSeconds', 1900]
]);

function createUri(fsPath, relativePath) {
  const normalized = fsPath.replace(/\\/g, '/');
  return {
    scheme: 'file',
    fsPath,
    path: normalized,
    relativePath,
    toString() {
      return `file:///${normalized.replace(/^\/+/, '')}`;
    }
  };
}

const workspaceFolder = {
  name: 'Project A',
  uri: createUri('C:\\repo')
};

const vscode = {
  Uri: {
    file: (filePath) => createUri(filePath),
    joinPath: (base, ...segments) => createUri(
      path.join(base.fsPath, ...segments),
      segments.join('/')
    ),
    parse: (value) => ({ scheme: value.split(':', 1)[0], toString: () => value })
  },
  FileSystemError: class FileSystemError extends Error {},
  workspace: {
    workspaceFolders: [workspaceFolder],
    isTrusted: true,
    asRelativePath: (uri) => uri.relativePath ?? path.relative(workspaceFolder.uri.fsPath, uri.fsPath),
    getConfiguration: () => ({
      get: (key, fallback) => configuration.has(key) ? configuration.get(key) : fallback
    })
  },
  window: {
    activeTextEditor: undefined,
    onDidStartTerminalShellExecution: () => ({ dispose() {} }),
    onDidEndTerminalShellExecution: () => ({ dispose() {} })
  }
};

const originalModuleLoad = Module._load;
Module._load = function loadWithVscodeMock(request, parent, isMain) {
  if (request === 'vscode') {
    return vscode;
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
const { DevMateChatViewProvider } = require('../out/extension');
Module._load = originalModuleLoad;

const {
  appendConversationSessionTurn,
  createConversationSessionStore
} = require('../out/sessions');
const { parseAgentToolCall } = require('../out/agentTools');

const workspace = {
  id: workspaceFolder.uri.toString().toLocaleLowerCase('en-US'),
  name: workspaceFolder.name
};

function providerWithoutConstructor() {
  return Object.create(DevMateChatViewProvider.prototype);
}

function extensionContext({ globalStore, legacyStore, checkpoint } = {}) {
  const globalValues = new Map();
  const workspaceValues = new Map();
  if (globalStore !== undefined) {
    globalValues.set('devMate.conversationSessions.v2', globalStore);
  }
  if (legacyStore !== undefined) {
    workspaceValues.set('devMate.conversationSessions.v1', legacyStore);
  }
  if (checkpoint !== undefined) {
    workspaceValues.set('devMate.agentCheckpoint.v1', checkpoint);
  }
  return {
    extensionUri: createUri('C:\\extension'),
    globalValues,
    workspaceValues,
    globalState: {
      get: (key) => globalValues.get(key),
      update: async (key, value) => {
        if (value === undefined) {
          globalValues.delete(key);
        } else {
          globalValues.set(key, value);
        }
      }
    },
    workspaceState: {
      get: (key) => workspaceValues.get(key),
      update: async (key, value) => {
        if (value === undefined) {
          workspaceValues.delete(key);
        } else {
          workspaceValues.set(key, value);
        }
      }
    },
    secrets: { get: async () => undefined }
  };
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function withoutDelays(callback) {
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (handler, _delay, ...argumentsList) => (
    originalSetTimeout(handler, 0, ...argumentsList)
  );
  try {
    return await callback();
  } finally {
    global.setTimeout = originalSetTimeout;
  }
}

test('loads global sessions, migrates legacy workspace sessions, and saves the merged store', async () => {
  const existing = createConversationSessionStore(
    'existing-session',
    1,
    { id: 'file:///other-project', name: 'Other project' }
  );
  const legacy = {
    version: 1,
    activeSessionId: 'legacy-session',
    sessions: [{
      id: 'legacy-session',
      title: 'Legacy work',
      createdAt: 2,
      updatedAt: 3,
      turns: [{ user: 'Old question', assistant: 'Old answer' }]
    }]
  };
  const context = extensionContext({ globalStore: existing, legacyStore: legacy });
  const provider = new DevMateChatViewProvider(
    context,
    {},
    { show() {} }
  );

  try {
    await flushPromises();
    const saved = context.globalValues.get('devMate.conversationSessions.v2');
    assert.equal(saved.version, 2);
    assert.equal(saved.sessions.length, 2);
    assert.equal(saved.activeSessionId, 'legacy-session');
    assert.equal(saved.sessions.find((session) => session.id === 'legacy-session').workspaceId, workspace.id);
    assert.equal(context.workspaceValues.has('devMate.conversationSessions.v1'), false);
  } finally {
    provider.dispose();
  }
});

test('collects active-file and selection context with explicit attachments first-class', async () => {
  const provider = providerWithoutConstructor();
  const selection = { marker: 'selection' };
  const documentUri = createUri('C:\\repo\\src\\app.ts', 'src/app.ts');
  let selectedText = 'return answer;';
  vscode.window.activeTextEditor = {
    selection,
    document: {
      uri: documentUri,
      fileName: documentUri.fsPath,
      languageId: 'typescript',
      getText: (range) => range === selection ? selectedText : 'export const answer = 42;'
    }
  };
  provider.collectAttachmentItems = async () => [{
    source: 'attachment',
    filePath: 'C:\\repo\\README.md',
    languageId: 'markdown',
    content: '# Project',
    includedCharacters: 9,
    totalCharacters: 9,
    truncated: false
  }];

  try {
    const fileScope = await provider.collectScope('activeFile', 'Explain this file');
    assert.equal(fileScope.apiScope.type, 'file');
    assert.equal(fileScope.apiScope.workspacePath, workspaceFolder.uri.fsPath);
    assert.deepEqual(fileScope.apiScope.items.map((item) => item.source), ['file', 'attachment']);
    assert.equal(fileScope.apiScope.items[0].content, 'export const answer = 42;');
    assert.match(fileScope.info.detail, /src\\app\.ts|src\/app\.ts/);

    const selectionScope = await provider.collectScope('selection', 'Explain this selection');
    assert.equal(selectionScope.apiScope.type, 'selection');
    assert.equal(selectionScope.apiScope.items[0].content, 'return answer;');

    selectedText = '   ';
    assert.equal(await provider.collectScope('selection', 'Explain this selection'), undefined);
  } finally {
    vscode.window.activeTextEditor = undefined;
  }
});

test('routes asks exclusively and reconstructs resumed requests from the checkpoint', async () => {
  const provider = providerWithoutConstructor();
  const calls = [];
  const statuses = [];
  provider.activeRequest = undefined;
  provider.disposeCommandTerminals = () => undefined;
  provider.answerQuestion = async (...argumentsList) => calls.push(argumentsList);
  provider.postStatus = (...argumentsList) => statuses.push(argumentsList);

  const askMessage = {
    command: 'ask',
    mode: 'ideas',
    question: 'How does this work?',
    scope: { kind: 'project', label: 'Project A', detail: '' }
  };
  await provider.handleMessage(askMessage);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], askMessage);
  assert.equal(calls[0][1] instanceof AbortSignal, true);
  assert.equal(provider.activeRequest, undefined);

  provider.activeRequest = new AbortController();
  await provider.handleMessage(askMessage);
  assert.equal(calls.length, 1);
  assert.match(statuses.at(-1)[0], /already working/);

  const checkpoint = {
    question: 'Continue the fix',
    mode: 'debug',
    scopeKind: 'activeFile'
  };
  provider.activeRequest = undefined;
  provider.currentAgentCheckpoint = () => checkpoint;
  await provider.handleMessage({ command: 'continueAgentRun' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][0], {
    command: 'ask',
    mode: 'debug',
    question: 'Continue the fix',
    scope: { kind: 'activeFile', label: 'File', detail: '' }
  });
  assert.equal(calls[1][2], checkpoint);
  assert.equal(provider.activeRequest, undefined);
});

test('constructs a resumed agent request from stored history, limits, and checkpoint state', async () => {
  let sessionStore = createConversationSessionStore('session', 1, workspace);
  sessionStore = appendConversationSessionTurn(
    sessionStore,
    'Earlier question',
    'Earlier answer',
    2
  );
  const checkpoint = {
    version: 1,
    workspaceId: workspace.id,
    sessionId: 'session',
    question: 'Continue the fix',
    mode: 'debug',
    scopeKind: 'project',
    toolHistory: [{
      callId: 'read-1',
      name: 'read_file',
      arguments: { path: 'src/app.ts' },
      result: 'Current source',
      isError: false
    }],
    toolUsedFiles: ['C:\\repo\\src\\app.ts'],
    toolSignatures: [],
    fileMutationCalls: 1,
    mutationCharacters: 40,
    commandCalls: 2,
    dependencyInstallCalls: 1,
    workspaceRevision: 7,
    forceFinalAnswer: false,
    disableThinking: false,
    emptyResponseRecoveryAttempted: false,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    tokenUsageExact: true,
    createdAt: 100,
    updatedAt: 200
  };
  const provider = providerWithoutConstructor();
  const savedCheckpoints = [];
  const messages = [];
  const enabledArguments = [];
  let capturedRequest;
  let capturedProviderKey;
  let capturedTimeout;
  let clearedCheckpoints = 0;

  provider.sessionStore = sessionStore;
  provider.activeRequestDiffs = new Map([['existing', 'diff']]);
  provider.backendManager = {
    start: async () => true,
    status: { detail: 'online' }
  };
  provider.extensionContext = { secrets: { get: async () => undefined } };
  provider.getConversationWorkspace = () => workspace;
  provider.persistSessionStore = async () => true;
  provider.postSessionState = () => undefined;
  provider.getActiveLlmProfile = () => ({
    id: 'local-model',
    name: 'Local model',
    provider: 'ollama',
    model: 'qwen3-coder',
    baseUrl: 'http://127.0.0.1:11434/v1'
  });
  provider.postStatus = () => undefined;
  provider.collectScope = async () => ({
    info: { kind: 'project', label: 'Project A', detail: 'Project: Project A' },
    apiScope: {
      type: 'project',
      workspacePath: workspaceFolder.uri.fsPath,
      items: []
    }
  });
  provider.finishCancelledRequest = () => false;
  provider.postMessage = (message) => messages.push(message);
  provider.getReasoningEffortPreferences = () => ({ 'local-model': 'high' });
  provider.enabledAgentTools = (...argumentsList) => {
    enabledArguments.push(argumentsList);
    return ['read_file', 'run_command'];
  };
  provider.saveAgentCheckpoint = async (value) => savedCheckpoints.push(value);
  provider.clearAgentCheckpoint = async () => { clearedCheckpoints += 1; };
  provider.postRequestFailure = (message) => assert.fail(message);
  provider.askWithProviderRetries = async (
    _backendUrl,
    request,
    providerKey,
    timeout,
    _signal,
    onUsage
  ) => {
    capturedRequest = request;
    capturedProviderKey = providerKey;
    capturedTimeout = timeout;
    onUsage({ inputTokens: 2, outputTokens: 1, totalTokens: 3, exact: true });
    return {
      result: {
        status: 'ok',
        data: {
          answer: 'Fix completed.',
          usedFiles: ['C:\\repo\\src\\app.ts'],
          changes: [],
          toolCalls: [],
          tokenUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, exact: true }
        }
      },
      retriesExhausted: false
    };
  };

  await withoutDelays(() => provider.answerQuestion({
    command: 'ask',
    mode: 'debug',
    question: '  Continue the fix  ',
    scope: { kind: 'project', label: 'Project A', detail: '' }
  }, new AbortController().signal, checkpoint));

  assert.equal(provider.activeRequestDiffs.has('existing'), true);
  assert.equal(capturedProviderKey, undefined);
  assert.equal(capturedTimeout, 1_830_000);
  assert.deepEqual(enabledArguments[0], ['debug', 1, 2, 1]);
  assert.equal(capturedRequest.question, 'Continue the fix');
  assert.equal(capturedRequest.mode, 'debug');
  assert.equal(capturedRequest.settings.maxTokens, 2048);
  assert.equal(capturedRequest.settings.temperature, 0.35);
  assert.equal(capturedRequest.settings.timeoutSeconds, 1800);
  assert.equal(capturedRequest.settings.reasoningEffort, 'auto');
  assert.deepEqual(capturedRequest.enabledTools, ['read_file', 'run_command']);
  assert.equal(capturedRequest.agentEditsEnabled, true);
  assert.equal(capturedRequest.forceFinalAnswer, false);
  assert.equal(capturedRequest.disableThinking, false);
  assert.deepEqual(capturedRequest.toolHistory, checkpoint.toolHistory);
  assert.deepEqual(capturedRequest.conversationHistory, [{
    user: 'Earlier question',
    assistant: 'Earlier answer'
  }]);
  assert.equal(savedCheckpoints[0].workspaceRevision, 8);
  assert.equal(savedCheckpoints[0].createdAt, checkpoint.createdAt);
  assert.deepEqual(
    messages.find((message) => message.command === 'tokenUsageUpdated').usage,
    { inputTokens: 12, outputTokens: 6, totalTokens: 18, exact: true }
  );
  assert.equal(clearedCheckpoints, 1);
});

test('validates tool calls, records outcomes, and dispatches dedicated tool families', async () => {
  const provider = providerWithoutConstructor();
  const activities = [];
  let executedCall;
  provider.commandTerminals = new Map();
  provider.postAgentToolActivity = (...argumentsList) => activities.push(argumentsList);
  provider.runAgentTool = async (call) => {
    executedCall = call;
    return {
      result: 'Full tool result',
      resultSummary: 'Tool summary',
      usedFiles: ['C:\\repo\\src\\app.ts'],
      mutationCharacters: 0
    };
  };

  const execution = await provider.executeAgentToolCall({
    id: 'read-1',
    name: 'read_file',
    arguments: { path: 'src/app.ts', startLine: 2, endLine: 4 }
  });
  assert.equal(executedCall.name, 'read_file');
  assert.deepEqual(executedCall.arguments, {
    path: 'src/app.ts',
    startLine: 2,
    endLine: 4
  });
  assert.equal(execution.step.isError, false);
  assert.equal(execution.step.result, 'Full tool result');
  assert.deepEqual(execution.usedFiles, ['C:\\repo\\src\\app.ts']);
  assert.equal(activities.at(-1)[3], 'completed');

  const rejected = await provider.executeAgentToolCall({
    id: 'bad-read',
    name: 'read_file',
    arguments: { path: '../outside.ts' }
  });
  assert.equal(rejected.step.isError, true);
  assert.match(rejected.step.result, /unsafe segments/i);

  const dispatchProvider = providerWithoutConstructor();
  const dispatched = [];
  const marker = (name) => ({
    result: name,
    resultSummary: name,
    usedFiles: [],
    mutationCharacters: 0
  });
  dispatchProvider.getAgentToolSettings = () => ({
    readFileMaxLines: 400,
    listFilesMaxResults: 200,
    searchCodeMaxResults: 50,
    diagnosticsMaxResults: 100,
    terminalErrorsMaxResults: 5,
    codeNavigationMaxResults: 100
  });
  dispatchProvider.readWorkspaceDiagnostics = (call) => {
    dispatched.push(call.name);
    return marker(call.name);
  };
  dispatchProvider.readDocumentSymbols = async (call) => {
    dispatched.push(call.name);
    return marker(call.name);
  };
  dispatchProvider.findCodeLocations = async (call) => {
    dispatched.push(call.name);
    return marker(call.name);
  };
  dispatchProvider.deleteAgentFile = async (call) => {
    dispatched.push(call.name);
    return marker(call.name);
  };
  dispatchProvider.relocateAgentFile = async (call) => {
    dispatched.push(call.name);
    return marker(call.name);
  };
  dispatchProvider.runDependencyInstallation = async (call) => {
    dispatched.push(call.name);
    return marker(call.name);
  };
  dispatchProvider.runVerificationCommand = async (call) => {
    dispatched.push(call.name);
    return marker(call.name);
  };

  const calls = [
    { id: 'diagnostics', name: 'get_diagnostics', arguments: {} },
    { id: 'symbols', name: 'get_symbols', arguments: { path: 'src/app.ts' } },
    { id: 'definition', name: 'find_definition', arguments: { path: 'src/app.ts', line: 1, column: 1 } },
    { id: 'references', name: 'find_references', arguments: { path: 'src/app.ts', line: 1, column: 1 } },
    { id: 'delete', name: 'delete_file', arguments: { path: 'src/old.ts' } },
    { id: 'rename', name: 'rename_file', arguments: { path: 'src/a.ts', newPath: 'src/b.ts' } },
    { id: 'move', name: 'move_file', arguments: { path: 'src/b.ts', newPath: 'archive/b.ts' } },
    { id: 'dependencies', name: 'install_dependencies', arguments: { manifestPath: 'backend/requirements.txt' } },
    { id: 'command', name: 'run_command', arguments: { executable: 'npm', args: ['test'], cwd: '' } }
  ];
  for (const call of calls) {
    const parsed = parseAgentToolCall(call);
    const result = await dispatchProvider.runAgentTool(parsed, 10_000);
    assert.equal(result.result, call.name);
  }
  assert.deepEqual(dispatched, calls.map((call) => call.name));
});

test('rejects file changes at the workspace-trust boundary before inspecting files', async () => {
  const provider = providerWithoutConstructor();
  vscode.workspace.isTrusted = false;
  try {
    await assert.rejects(
      () => provider.confirmAndApplyFileChanges(
        [{ path: 'src/app.ts', content: 'export const changed = true;' }],
        'Update app.ts',
        new AbortController().signal
      ),
      /Trust this workspace/
    );
  } finally {
    vscode.workspace.isTrusted = true;
  }
});
