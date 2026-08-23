const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const TEST_BACKEND_TOKEN = 'test-backend-token-that-is-long-enough';

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
  ConfigurationTarget: { Global: 1 },
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
      get: (key, fallback) => configuration.has(key) ? configuration.get(key) : fallback,
      update: async (key, value) => {
        configuration.set(key, value);
      }
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
const { DevMateChatViewProvider } = require('../out/chatViewProvider');
const { AgentRunController } = require('../out/agentRunController');
const {
  StartedCommandError,
  StartedDependencyInstallError,
  ToolExecutor
} = require('../out/toolExecutor');
const { WorkspaceContext } = require('../out/workspaceContext');
const { WorkspaceMutations } = require('../out/workspaceMutations');
const { LexicalProjectRetriever } = require('../out/projectRetriever');
Module._load = originalModuleLoad;

const {
  appendConversationSessionTurn,
  createConversationSessionStore
} = require('../out/sessions');
const { parseAgentToolCall } = require('../out/agentTools');
const {
  createEmptyProjectIndex,
  createIndexedProjectFile
} = require('../out/projectIndex');

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
  const workspaceContext = new WorkspaceContext(undefined);
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
  workspaceContext.collectAttachmentItems = async () => [{
    source: 'attachment',
    filePath: 'C:\\repo\\README.md',
    languageId: 'markdown',
    content: '# Project',
    includedCharacters: 9,
    totalCharacters: 9,
    truncated: false
  }];

  try {
    const fileScope = await workspaceContext.collectScope('activeFile', 'Explain this file');
    assert.equal(fileScope.apiScope.type, 'file');
    assert.equal(fileScope.apiScope.workspacePath, workspaceFolder.uri.fsPath);
    assert.deepEqual(fileScope.apiScope.items.map((item) => item.source), ['file', 'attachment']);
    assert.equal(fileScope.apiScope.items[0].content, 'export const answer = 42;');
    assert.match(fileScope.info.detail, /src\\app\.ts|src\/app\.ts/);

    const selectionScope = await workspaceContext.collectScope('selection', 'Explain this selection');
    assert.equal(selectionScope.apiScope.type, 'selection');
    assert.equal(selectionScope.apiScope.items[0].content, 'return answer;');

    selectedText = '   ';
    assert.equal(
      await workspaceContext.collectScope('selection', 'Explain this selection'),
      undefined
    );
  } finally {
    vscode.window.activeTextEditor = undefined;
  }
});

test('collects project context with attachments before deduplicated lexical results', async () => {
  const statuses = [];
  const retrievalRequests = [];
  const lexicalRetriever = new LexicalProjectRetriever();
  const workspaceContext = new WorkspaceContext(
    undefined,
    (status) => statuses.push(status),
    {
      retrieve: async (request) => {
        retrievalRequests.push(request);
        return lexicalRetriever.retrieve(request);
      }
    }
  );
  const attachment = {
    source: 'attachment',
    filePath: 'C:\\repo\\README.md',
    languageId: 'markdown',
    content: '# Project',
    includedCharacters: 9,
    totalCharacters: 9,
    truncated: false
  };
  const index = createEmptyProjectIndex(workspaceFolder.uri.fsPath);
  index.files = [
    createIndexedProjectFile({
      filePath: attachment.filePath,
      relativePath: 'README.md',
      languageId: 'markdown',
      content: 'login token overview'
    }, 20, 1),
    createIndexedProjectFile({
      filePath: 'C:\\repo\\src\\auth.ts',
      relativePath: 'src/auth.ts',
      languageId: 'typescript',
      content: 'export function validateLoginToken(token) { return token.length > 10; }'
    }, 69, 1)
  ];
  workspaceContext.collectAttachmentItems = async () => [attachment];
  workspaceContext.refreshProjectIndex = async () => ({
    index,
    changedFiles: 1,
    removedFiles: 0
  });

  const collected = await workspaceContext.collectScope(
    'project',
    'Where is the login token validated?'
  );

  assert.deepEqual(workspaceContext.getConversationWorkspace(), workspace);
  assert.equal(collected.apiScope.type, 'project');
  assert.equal(collected.apiScope.workspacePath, workspaceFolder.uri.fsPath);
  assert.deepEqual(
    collected.apiScope.items.map((item) => item.source),
    ['attachment', 'file']
  );
  assert.deepEqual(
    collected.apiScope.items.map((item) => item.filePath),
    [attachment.filePath, 'C:\\repo\\src\\auth.ts']
  );
  assert.equal(retrievalRequests.length, 1);
  assert.equal(retrievalRequests[0].index, undefined);
  assert.equal(typeof retrievalRequests[0].loadIndex, 'function');
  assert.equal(retrievalRequests[0].workspacePath, workspaceFolder.uri.fsPath);
  assert.match(retrievalRequests[0].workspaceKey, /^workspace:[a-f0-9]{64}$/);
  assert.equal(retrievalRequests[0].question, 'Where is the login token validated?');
  assert.equal(retrievalRequests[0].limits.maxChunks, 4);
  assert.equal(retrievalRequests[0].limits.excludedFilePaths.has(attachment.filePath), true);
  assert.match(collected.info.detail, /2 files/);
  assert.deepEqual(statuses, [
    'Searching project index',
    'Refreshing fallback project index',
    'Indexed 2 files',
    'Retrieved 1 relevant project excerpt'
  ]);
});

test('persists explicit and Auto maximum input-context settings', async () => {
  const provider = providerWithoutConstructor();
  const previousConfiguration = new Map(configuration);
  const messages = [];
  provider.extensionContext = extensionContext();
  provider.postPermissionPolicyState = () => undefined;
  provider.postSettingsState = () => undefined;
  provider.postMessage = (message) => messages.push(message);
  provider.postStatus = (message) => assert.fail(message);

  try {
    const baseSettings = {
      timeoutSeconds: 900,
      commandTimeoutSeconds: 300,
      toolCallLimit: 16,
      maxTokens: 8_000,
      temperature: 0.2,
      policy: { createFiles: 'ask', updateFiles: 'ask' }
    };
    await provider.saveSettings({
      ...baseSettings,
      maxInputContextTokens: 24_000
    });
    assert.equal(configuration.get('maxInputContextTokens'), 24_000);

    await provider.saveSettings({
      ...baseSettings,
      maxInputContextTokens: 0
    });
    assert.equal(configuration.get('maxInputContextTokens'), 0);
    assert.equal(
      messages.filter((message) => message.command === 'settingsSaved').length,
      2
    );
  } finally {
    configuration.clear();
    for (const [key, value] of previousConfiguration) {
      configuration.set(key, value);
    }
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

test('prepares a resumed agent run and persists its completed outcome', async () => {
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
  const messages = [];
  let capturedInput;
  let capturedSignal;
  let clearedCheckpoints = 0;
  let persistedSessions = 0;

  provider.sessionStore = sessionStore;
  provider.activeRequestDiffs = new Map([['existing', 'diff']]);
  provider.backendManager = {
    start: async () => true,
    requestToken: TEST_BACKEND_TOKEN,
    status: { detail: 'online' }
  };
  provider.extensionContext = { secrets: { get: async () => undefined } };
  provider.getConversationWorkspace = () => workspace;
  provider.persistSessionStore = async () => {
    persistedSessions += 1;
    return true;
  };
  provider.postSessionState = () => undefined;
  provider.getActiveLlmProfile = () => ({
    id: 'local-model',
    name: 'Local model',
    provider: 'ollama',
    model: 'qwen3-coder',
    baseUrl: 'http://127.0.0.1:11434/v1'
  });
  provider.postStatus = (text) => messages.push({ command: 'status', text });
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
  provider.clearAgentCheckpoint = async () => {
    clearedCheckpoints += 1;
  };
  provider.postRequestFailure = (message) => assert.fail(message);
  provider.agentRunController = {
    run: async (input, signal) => {
      capturedInput = input;
      capturedSignal = signal;
      return {
        kind: 'completed',
        response: {
          answer: 'Fix completed.',
          usedFiles: ['C:\\repo\\src\\app.ts'],
          changes: [],
          toolCalls: []
        },
        toolHistory: checkpoint.toolHistory,
        toolUsedFiles: checkpoint.toolUsedFiles,
        tokenUsage: {
          inputTokens: 12,
          outputTokens: 6,
          totalTokens: 18,
          exact: true
        }
      };
    }
  };

  const signal = new AbortController().signal;
  await withoutDelays(() => provider.answerQuestion({
    command: 'ask',
    mode: 'debug',
    question: '  Continue the fix  ',
    scope: { kind: 'project', label: 'Project A', detail: '' }
  }, signal, checkpoint));

  assert.equal(provider.activeRequestDiffs.has('existing'), true);
  assert.equal(capturedSignal, signal);
  assert.equal(capturedInput.question, 'Continue the fix');
  assert.equal(capturedInput.mode, 'debug');
  assert.equal(capturedInput.scopeKind, 'project');
  assert.equal(capturedInput.backendToken, TEST_BACKEND_TOKEN);
  assert.equal(capturedInput.settings.maxTokens, 2048);
  assert.equal(capturedInput.settings.temperature, 0.35);
  assert.equal(capturedInput.settings.timeoutSeconds, 1800);
  assert.equal(capturedInput.settings.reasoningEffort, 'auto');
  assert.equal(capturedInput.toolCallLimit, 16);
  assert.equal(capturedInput.workspaceId, workspace.id);
  assert.equal(capturedInput.sessionId, 'session');
  assert.equal(capturedInput.resumedCheckpoint, checkpoint);
  assert.deepEqual(capturedInput.conversationHistory, [{
    user: 'Earlier question',
    assistant: 'Earlier answer'
  }]);
  assert.equal(clearedCheckpoints, 1);
  assert.equal(persistedSessions, 1);
  assert.equal(
    provider.sessionStore.sessions[0].turns.at(-1).assistant,
    'Fix completed.\n\nUsed files:\n- `C:\\repo\\src\\app.ts`'
  );
  assert.equal(
    messages.find((message) => message.command === 'assistantResponse').response,
    'Fix completed.\n\nUsed files:\n- `C:\\repo\\src\\app.ts`'
  );
});

test('does not collect or send workspace context without an authenticated backend token', async () => {
  const provider = providerWithoutConstructor();
  let collectedContext = false;
  let failure;
  provider.sessionStore = createConversationSessionStore('session', 1, workspace);
  provider.activeRequestDiffs = new Map();
  provider.getConversationWorkspace = () => workspace;
  provider.getActiveLlmProfile = () => ({
    id: 'local-model',
    name: 'Local model',
    provider: 'ollama',
    model: 'qwen3-coder'
  });
  provider.backendManager = {
    start: async () => true,
    requestToken: undefined,
    status: { detail: 'online' }
  };
  provider.postStatus = () => undefined;
  provider.collectScope = async () => {
    collectedContext = true;
    return undefined;
  };
  provider.postRequestFailure = (message, options) => {
    failure = { message, options };
  };

  await provider.answerQuestion({
    command: 'ask',
    mode: 'ideas',
    question: 'Do not send this context',
    isNewTurn: false,
    scope: { kind: 'project', label: 'Project A', detail: '' }
  }, new AbortController().signal);

  assert.equal(collectedContext, false);
  assert.match(failure.message, /authenticated backend connection/);
  assert.deepEqual(failure.options, { level: 'warning', retryable: true });
});

test('keeps a fresh pending user turn when the agent run fails', async () => {
  const provider = providerWithoutConstructor();
  const messages = [];
  let persistedSessions = 0;
  provider.sessionStore = createConversationSessionStore('session', 1, workspace);
  provider.activeRequestDiffs = new Map([['stale', 'diff']]);
  provider.backendManager = {
    start: async () => true,
    requestToken: TEST_BACKEND_TOKEN,
    status: { detail: 'online' }
  };
  provider.extensionContext = { secrets: { get: async () => undefined } };
  provider.getConversationWorkspace = () => workspace;
  provider.persistSessionStore = async () => {
    persistedSessions += 1;
    return true;
  };
  provider.postSessionState = () => undefined;
  provider.getActiveLlmProfile = () => ({
    id: 'local-model',
    name: 'Local model',
    provider: 'ollama',
    model: 'qwen3-coder'
  });
  provider.collectScope = async () => ({
    info: { kind: 'project', label: 'Project A', detail: 'Project: Project A' },
    apiScope: { type: 'project', workspacePath: workspaceFolder.uri.fsPath, items: [] }
  });
  provider.finishCancelledRequest = () => false;
  provider.currentAgentCheckpoint = () => undefined;
  provider.clearAgentCheckpoint = async () => assert.fail('failed runs retain checkpoints');
  provider.getReasoningEffortPreferences = () => ({});
  provider.postMessage = (message) => messages.push(message);
  provider.postStatus = (text, level) => messages.push({ command: 'status', text, level });
  provider.agentRunController = {
    run: async () => ({ kind: 'failed', message: 'Provider unavailable.', retryable: true })
  };

  await withoutDelays(() => provider.answerQuestion({
    command: 'ask',
    mode: 'ideas',
    question: 'New request',
    scope: { kind: 'project', label: 'Project A', detail: '' }
  }, new AbortController().signal));

  assert.equal(provider.activeRequestDiffs.size, 0);
  assert.equal(persistedSessions, 1);
  assert.deepEqual(provider.sessionStore.sessions[0].turns.at(-1), {
    user: 'New request',
    assistant: ''
  });
  assert.deepEqual(
    messages.find((message) => message.command === 'requestFailed'),
    { command: 'requestFailed', message: 'Provider unavailable.', retryable: true }
  );
});

test('agent run restores checkpoint counters, history, and token usage', async () => {
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
  const savedCheckpoints = [];
  const events = [];
  const enabledArguments = [];
  let capturedRequest;
  let capturedSecrets;
  let capturedTimeout;
  const transport = {
    ask: async () => assert.fail('streaming should remain supported'),
    askStream: async (_url, request, secrets, timeout, _signal, onEvent) => {
      capturedRequest = request;
      capturedSecrets = secrets;
      capturedTimeout = timeout;
      onEvent({
        type: 'usage',
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, exact: true }
      });
      return {
        unsupported: false,
        result: {
          status: 'ok',
          data: {
            answer: 'Fix completed.',
            usedFiles: ['C:\\repo\\src\\app.ts'],
            changes: [],
            toolCalls: [],
            tokenUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, exact: true }
          }
        }
      };
    },
    waitForRetryDelay: async () => true
  };
  const controller = new AgentRunController({
    execute: async () => assert.fail('no tool call was expected')
  }, {
    saveCheckpoint: async (value) => savedCheckpoints.push(value),
    recoverBackend: async () => true,
    emit: (event) => events.push(event)
  }, transport);
  controller.enabledAgentTools = (...argumentsList) => {
    enabledArguments.push(argumentsList);
    return ['read_file', 'run_command'];
  };

  const outcome = await controller.run({
    question: 'Continue the fix',
    mode: 'debug',
    scopeKind: 'project',
    scope: { type: 'project', workspacePath: 'C:\\repo', items: [] },
    conversationHistory: [{ user: 'Earlier question', assistant: 'Earlier answer' }],
    settings: {
      provider: 'ollama',
      model: 'qwen3-coder',
      baseUrl: 'http://127.0.0.1:11434/v1',
      maxTokens: 2048,
      temperature: 0.35,
      reasoningEffort: 'auto',
      timeoutSeconds: 1800
    },
    backendUrl: 'http://127.0.0.1:8000',
    backendToken: TEST_BACKEND_TOKEN,
    toolCallLimit: 16,
    workspaceId: workspace.id,
    sessionId: 'session',
    resumedCheckpoint: checkpoint
  }, new AbortController().signal);

  assert.equal(outcome.kind, 'completed');
  assert.deepEqual(capturedSecrets, {
    backendToken: TEST_BACKEND_TOKEN,
    providerApiKey: undefined
  });
  assert.equal(capturedTimeout, 1_830_000);
  assert.deepEqual(enabledArguments[0], ['debug', 1, 2, 1]);
  assert.deepEqual(capturedRequest.enabledTools, ['read_file', 'run_command']);
  assert.deepEqual(capturedRequest.toolHistory, checkpoint.toolHistory);
  assert.deepEqual(capturedRequest.conversationHistory, [{
    user: 'Earlier question',
    assistant: 'Earlier answer'
  }]);
  assert.equal(savedCheckpoints[0].workspaceRevision, 8);
  assert.equal(savedCheckpoints[0].createdAt, checkpoint.createdAt);
  assert.deepEqual(
    events.find((event) => event.type === 'token-usage').usage,
    { inputTokens: 12, outputTokens: 6, totalTokens: 18, exact: true }
  );
  assert.deepEqual(outcome.tokenUsage, {
    inputTokens: 13,
    outputTokens: 7,
    totalTokens: 20,
    exact: true
  });
});

test('agent run retries transient provider failures and stops after cancellation', async () => {
  const input = {
    question: 'Explain the project',
    mode: 'ideas',
    scopeKind: 'project',
    scope: { type: 'project', workspacePath: 'C:\\repo', items: [] },
    conversationHistory: [],
    settings: {
      provider: 'ollama',
      model: 'qwen3-coder',
      baseUrl: 'http://127.0.0.1:11434/v1',
      maxTokens: 2048,
      temperature: 0.35,
      reasoningEffort: 'auto',
      timeoutSeconds: 900
    },
    backendUrl: 'http://127.0.0.1:8000',
    backendToken: TEST_BACKEND_TOKEN,
    toolCallLimit: 16,
    workspaceId: workspace.id,
    sessionId: 'session'
  };
  const busy = {
    unsupported: false,
    result: {
      status: 'error',
      message: 'Provider busy.',
      statusCode: 429,
      errorKind: 'http'
    }
  };
  const events = [];
  const retryDelays = [];
  let attempts = 0;
  const controller = new AgentRunController({
    execute: async () => assert.fail('no tool call was expected')
  }, {
    saveCheckpoint: async () => undefined,
    recoverBackend: async () => true,
    emit: (event) => events.push(event)
  }, {
    ask: async () => assert.fail('streaming should remain supported'),
    askStream: async () => {
      attempts += 1;
      return attempts === 1
        ? busy
        : {
          unsupported: false,
          result: {
            status: 'ok',
            data: {
              answer: 'Project summary.',
              usedFiles: [],
              changes: [],
              toolCalls: []
            }
          }
        };
    },
    waitForRetryDelay: async (milliseconds) => {
      retryDelays.push(milliseconds);
      return true;
    }
  });

  const completed = await controller.run(input, new AbortController().signal);
  assert.equal(completed.kind, 'completed');
  assert.equal(attempts, 2);
  assert.equal(retryDelays.length, 1);
  assert.equal(events.filter((event) => event.type === 'stream-reset').length, 2);

  const cancellation = new AbortController();
  let cancelledAttempts = 0;
  const cancelledController = new AgentRunController({
    execute: async () => assert.fail('no tool call was expected')
  }, {
    saveCheckpoint: async () => undefined,
    recoverBackend: async () => true,
    emit: () => undefined
  }, {
    ask: async () => assert.fail('streaming should remain supported'),
    askStream: async () => {
      cancelledAttempts += 1;
      return busy;
    },
    waitForRetryDelay: async () => {
      cancellation.abort();
      return false;
    }
  });

  const cancelled = await cancelledController.run(input, cancellation.signal);
  assert.deepEqual(cancelled, { kind: 'cancelled' });
  assert.equal(cancelledAttempts, 1);
});

test('validates tool calls, records outcomes, and dispatches dedicated tool families', async () => {
  const activities = [];
  let executedCall;
  let executedSignal;
  const executor = new ToolExecutor({}, {}, {
    getAgentToolSettings: () => ({
      readFileMaxLines: 400,
      listFilesMaxResults: 200,
      searchCodeMaxResults: 50,
      diagnosticsMaxResults: 100,
      terminalErrorsMaxResults: 5,
      codeNavigationMaxResults: 100
    }),
    requestCommandPermission: async () => false,
    postAgentToolActivity: (...argumentsList) => activities.push(argumentsList)
  });
  executor.runAgentTool = async (call, _remainingMutationCharacters, signal) => {
    executedCall = call;
    executedSignal = signal;
    return {
      result: 'Full tool result',
      resultSummary: 'Tool summary',
      usedFiles: ['C:\\repo\\src\\app.ts'],
      mutationCharacters: 0
    };
  };
  const signal = new AbortController().signal;

  const execution = await executor.execute(
    {
      id: 'read-1',
      name: 'read_file',
      arguments: { path: 'src/app.ts', startLine: 2, endLine: 4 }
    },
    { remainingMutationCharacters: 10_000, signal }
  );
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

  const rejected = await executor.execute(
    {
      id: 'bad-read',
      name: 'read_file',
      arguments: { path: '../outside.ts' }
    },
    { remainingMutationCharacters: 10_000, signal }
  );
  assert.equal(rejected.step.isError, true);
  assert.match(rejected.step.result, /unsafe segments/i);

  executor.runAgentTool = async () => {
    throw new StartedCommandError('Command failed.', 'pytest', '.venv/Scripts/python.exe');
  };
  const commandFailure = await executor.execute(
    {
      id: 'command-failure',
      name: 'run_command',
      arguments: { executable: 'npm', args: ['test'], cwd: '' }
    },
    { remainingMutationCharacters: 10_000, signal }
  );
  assert.equal(commandFailure.commandAttempted, true);
  assert.equal(commandFailure.missingDependency, 'pytest');
  assert.equal(commandFailure.pythonEnvironment, '.venv/Scripts/python.exe');

  executor.runAgentTool = async () => {
    throw new StartedDependencyInstallError('Installation failed.');
  };
  const installFailure = await executor.execute(
    {
      id: 'install-failure',
      name: 'install_dependencies',
      arguments: { manifestPath: 'backend/requirements.txt' }
    },
    { remainingMutationCharacters: 10_000, signal }
  );
  assert.equal(installFailure.installAttempted, true);

  const dispatchExecutor = new ToolExecutor({}, {}, {
    getAgentToolSettings: () => ({
      readFileMaxLines: 400,
      listFilesMaxResults: 200,
      searchCodeMaxResults: 50,
      diagnosticsMaxResults: 100,
      terminalErrorsMaxResults: 5,
      codeNavigationMaxResults: 100
    }),
    requestCommandPermission: async () => false,
    postAgentToolActivity: () => undefined
  });
  assert.equal(executedSignal, signal);
  const dispatched = [];
  const marker = (name) => ({
    result: name,
    resultSummary: name,
    usedFiles: [],
    mutationCharacters: 0
  });
  dispatchExecutor.readWorkspaceDiagnostics = (call) => {
    dispatched.push(call.name);
    return marker(call.name);
  };
  dispatchExecutor.readDocumentSymbols = async (call) => {
    dispatched.push(call.name);
    return marker(call.name);
  };
  dispatchExecutor.findCodeLocations = async (call) => {
    dispatched.push(call.name);
    return marker(call.name);
  };
  dispatchExecutor.deleteAgentFile = async (call) => {
    dispatched.push(call.name);
    return marker(call.name);
  };
  dispatchExecutor.relocateAgentFile = async (call) => {
    dispatched.push(call.name);
    return marker(call.name);
  };
  dispatchExecutor.runDependencyInstallation = async (call) => {
    dispatched.push(call.name);
    return marker(call.name);
  };
  dispatchExecutor.runVerificationCommand = async (call) => {
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
    const result = await dispatchExecutor.runAgentTool(parsed, 10_000, signal);
    assert.equal(result.result, call.name);
  }
  assert.deepEqual(dispatched, calls.map((call) => call.name));
});

test('agent run forwards its signal and mutation budget through a complete tool cycle', async () => {
  const signal = new AbortController().signal;
  const providerRequests = [];
  const savedCheckpoints = [];
  const events = [];
  let receivedCall;
  let receivedContext;
  let providerAttempt = 0;
  const toolExecutor = {
    execute: async (call, context) => {
      receivedCall = call;
      receivedContext = context;
      return {
        step: {
          callId: call.id,
          name: call.name,
          arguments: { path: 'src/new.ts', contentCharacters: 17 },
          result: 'Applied file changes: src/new.ts',
          isError: false
        },
        usedFiles: ['C:\\repo\\src\\new.ts'],
        mutationCharacters: 17,
        mutationApplied: true
      };
    }
  };
  const transport = {
    ask: async () => assert.fail('streaming should remain supported'),
    askStream: async (_url, request) => {
      providerRequests.push(request);
      providerAttempt += 1;
      return {
        unsupported: false,
        result: {
          status: 'ok',
          data: providerAttempt === 1
            ? {
              answer: '',
              usedFiles: [],
              changes: [],
              toolCalls: [{
                id: 'create-1',
                name: 'create_file',
                arguments: { path: 'src/new.ts', content: 'export const value = 1;' }
              }]
            }
            : {
              answer: 'Created the requested file.',
              usedFiles: [],
              changes: [],
              toolCalls: []
            }
        }
      };
    },
    waitForRetryDelay: async () => true
  };
  const controller = new AgentRunController(toolExecutor, {
    saveCheckpoint: async (checkpoint) => savedCheckpoints.push(checkpoint),
    recoverBackend: async () => true,
    emit: (event) => events.push(event)
  }, transport);

  const outcome = await controller.run({
    question: 'Create the file',
    mode: 'code',
    scopeKind: 'project',
    scope: { type: 'project', workspacePath: 'C:\\repo', items: [] },
    conversationHistory: [],
    settings: {
      provider: 'ollama',
      model: 'qwen3-coder',
      baseUrl: 'http://127.0.0.1:11434/v1',
      maxTokens: 2048,
      temperature: 0.35,
      reasoningEffort: 'auto',
      timeoutSeconds: 900
    },
    backendUrl: 'http://127.0.0.1:8000',
    backendToken: TEST_BACKEND_TOKEN,
    toolCallLimit: 16,
    workspaceId: workspace.id,
    sessionId: 'session'
  }, signal);

  assert.equal(outcome.kind, 'completed');
  assert.equal(outcome.response.answer, 'Created the requested file.');
  assert.equal(receivedCall.id, 'create-1');
  assert.equal(receivedContext.signal, signal);
  assert.equal(receivedContext.remainingMutationCharacters, 500_000);
  assert.equal(providerRequests.length, 2);
  assert.equal(providerRequests[1].toolHistory.length, 1);
  assert.equal(savedCheckpoints.length, 2);
  assert.equal(savedCheckpoints.at(-1).fileMutationCalls, 1);
  assert.equal(savedCheckpoints.at(-1).mutationCharacters, 17);
  assert.equal(savedCheckpoints.at(-1).workspaceRevision, 1);
  assert.deepEqual(outcome.toolUsedFiles, ['C:\\repo\\src\\new.ts']);
  assert.deepEqual(
    events.filter((event) => event.type === 'tool-usage').map((event) => event.used),
    [0, 1]
  );
});

test('rejects file changes at the workspace-trust boundary before inspecting files', async () => {
  const workspaceMutations = new WorkspaceMutations({
    getPermissionPolicy: () => ({ createFiles: 'ask', updateFiles: 'ask' }),
    requestPermission: async () => false,
    reportStatus: () => undefined,
    recordCompletedDiff: () => undefined
  });
  vscode.workspace.isTrusted = false;
  try {
    await assert.rejects(
      () => workspaceMutations.confirmAndApplyFileChanges(
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
