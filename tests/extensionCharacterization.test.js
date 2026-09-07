const assert = require('node:assert/strict');
const { withVscodeMock } = require('./helpers/withVscodeMock');
const path = require('node:path');
const test = require('node:test');

const TEST_BACKEND_TOKEN = 'test-backend-token-that-is-long-enough';

const configuration = new Map([
  ['backendUrl', 'http://127.0.0.1:8000'],
  ['maxTokens', 2048],
  ['maxInputContextTokens', 24_000],
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

const {
  DevMateChatViewProvider,
  AgentRunController,
  StartedCommandError,
  StartedDependencyInstallError,
  ToolExecutor,
  WorkspaceContext,
  WorkspaceMutations,
  LexicalProjectRetriever
} = withVscodeMock(vscode, () => ({
  ...require('../out/chat/chatViewProvider'),
  ...require('../out/agent/agentRunController'),
  ...require('../out/agent/toolExecutor'),
  ...require('../out/context/workspaceContext'),
  ...require('../out/workspace/workspaceMutations'),
  ...require('../out/projectSearch/projectRetriever')
}));

const { parseAgentToolCall } = require('../out/agent/agentTools');
const { LLM_PROFILES_STORAGE_KEY, secretKeyForProfile } = require('../out/settings/llmProfiles');
const {
  EMBEDDING_PROFILES_STORAGE_KEY,
  embeddingSecretKeyForProfile
} = require('../out/settings/embeddingProfiles');
const { FILE_PERMISSION_POLICY_STORAGE_KEY } = require('../out/workspace/permissions');
const {
  createEmptyProjectIndex,
  createIndexedProjectFile
} = require('../out/projectSearch/projectIndex');

const workspace = {
  id: workspaceFolder.uri.toString().toLocaleLowerCase('en-US'),
  name: workspaceFolder.name
};

// Stub only the collaborators needed for routing. Request workflows are tested in their own file.
function providerWithoutConstructor() {
  const provider = Object.create(DevMateChatViewProvider.prototype);
  provider.agentCheckpoints = {
    current: () => undefined,
    postState: () => undefined
  };
  return provider;
}

function extensionContext() {
  const globalValues = new Map();
  const workspaceValues = new Map();
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
    }
  };
}

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

test('routes asks exclusively and reconstructs resumed requests from the checkpoint', async () => {
  const provider = providerWithoutConstructor();
  const calls = [];
  const statuses = [];
  provider.activeRequest = undefined;
  provider.disposeCommandTerminals = () => undefined;
  provider.chatRequestController = {
    answer: async (...argumentsList) => calls.push(argumentsList)
  };
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
  provider.agentCheckpoints = {
    current: () => checkpoint,
    postState: () => undefined
  };
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

test('reports request failures and releases ownership for both new and resumed requests', async () => {
  const askMessage = {
    command: 'ask', mode: 'ideas', question: 'Explain this',
    scope: { kind: 'project', label: 'Project', detail: '' }
  };
  for (const resumed of [false, true]) {
    for (const failure of [new Error('Provider unavailable'), 'unexpected failure']) {
      const provider = providerWithoutConstructor();
      const messages = [];
      provider.postMessage = (message) => messages.push(message);
      provider.disposeCommandTerminals = () => undefined;
      provider.agentCheckpoints.current = () => ({
        question: askMessage.question, mode: 'ideas', scopeKind: 'project'
      });
      provider.chatRequestController = { answer: async () => { throw failure; } };

      await provider.handleMessage(resumed ? { command: 'continueAgentRun' } : askMessage);

      const expected = failure instanceof Error ? failure.message : resumed
        ? 'DevMate could not continue the request.'
        : 'DevMate could not complete the request.';
      assert.deepEqual(messages, [
        { command: 'requestFailed', message: expected, retryable: false },
        { command: 'status', text: expected, level: 'error' }
      ]);
      assert.equal(provider.activeRequest, undefined);
    }
  }
});

test('cancels new and resumed requests without allowing another request during cleanup', async () => {
  const askMessage = {
    command: 'ask', mode: 'ideas', question: 'Explain this',
    scope: { kind: 'selection', label: 'Selection', detail: '' }
  };
  for (const resumed of [false, true]) {
    const provider = providerWithoutConstructor();
    const messages = [];
    let disposedTerminals = 0;
    let cancelledPermissions = 0;
    let calls = 0;
    let requestSignal;
    let finishRequest;
    const pending = new Promise((resolve) => { finishRequest = resolve; });
    provider.postMessage = (message) => messages.push(message);
    provider.disposeCommandTerminals = () => { disposedTerminals += 1; };
    provider.permissionPresenter = {
      cancelPending: () => { cancelledPermissions += 1; }
    };
    provider.agentCheckpoints.current = () => ({
      question: askMessage.question, mode: 'ideas', scopeKind: 'selection'
    });
    provider.chatRequestController = {
      answer: async (_message, signal) => {
        calls += 1;
        requestSignal = signal;
        await pending;
        throw new Error('Cancelled while waiting');
      }
    };

    const running = provider.handleMessage(resumed ? { command: 'continueAgentRun' } : askMessage);
    const owner = provider.activeRequest;
    assert.equal(owner.signal, requestSignal);
    await provider.handleMessage({ command: 'cancelRequest' });
    await provider.handleMessage({ command: 'cancelRequest' });
    assert.equal(requestSignal.aborted, true);
    assert.equal(cancelledPermissions, 1);
    assert.equal(disposedTerminals, 2); // Once at start, once at cancellation.
    assert.equal(provider.activeRequest, owner);
    await provider.handleMessage(askMessage);
    await provider.handleMessage({ command: 'continueAgentRun' });
    assert.equal(calls, 1);

    finishRequest();
    await running;
    assert.equal(provider.activeRequest, undefined);
    assert.deepEqual(messages.filter((message) => message.command !== 'status'), [
      { command: 'requestCancelling' },
      { command: 'requestCancelled' }
    ]);
    assert.deepEqual(messages.at(-1), { command: 'status', text: 'Ready', level: 'info' });
  }
});

test('does not let a finished request clear a newer request after the view is disposed', async () => {
  for (const resumed of [false, true]) {
    const provider = providerWithoutConstructor();
    let finishRequest;
    const pending = new Promise((resolve) => { finishRequest = resolve; });
    provider.viewDisposables = [];
    provider.permissionPresenter = { cancelPending() {} };
    provider.disposeCommandTerminals = () => undefined;
    provider.chatRequestController = { answer: () => pending };
    provider.agentCheckpoints.current = () => ({
      question: 'Explain this', mode: 'ideas', scopeKind: 'project'
    });
    const running = provider.handleMessage(resumed ? { command: 'continueAgentRun' } : {
      command: 'ask', mode: 'ideas', question: 'Explain this',
      scope: { kind: 'project', label: 'Project', detail: '' }
    });
    const previousOwner = provider.activeRequest;
    provider.disposeViewDisposables();
    assert.equal(previousOwner.signal.aborted, true);
    assert.equal(provider.activeRequest, undefined);
    const newOwner = new AbortController();
    provider.activeRequest = newOwner;

    finishRequest();
    await running;
    assert.equal(provider.activeRequest, newOwner);
    assert.equal(newOwner.signal.aborted, false);
  }
});

test('checks request ownership before looking up a checkpoint and refreshes missing checkpoint state', async () => {
  const provider = providerWithoutConstructor();
  const messages = [];
  let checkpointReads = 0;
  let checkpointUpdates = 0;
  provider.postMessage = (message) => messages.push(message);
  provider.agentCheckpoints = {
    current: () => { checkpointReads += 1; },
    postState: () => { checkpointUpdates += 1; }
  };
  const owner = new AbortController();
  provider.activeRequest = owner;
  await provider.handleMessage({ command: 'continueAgentRun' });
  assert.equal(checkpointReads, 0);
  assert.equal(provider.activeRequest, owner);
  assert.match(messages[0].text, /already working/);

  provider.activeRequest = undefined;
  await provider.handleMessage({ command: 'continueAgentRun' });
  assert.equal(checkpointReads, 1);
  assert.equal(checkpointUpdates, 1);
  assert.equal(provider.activeRequest, undefined);
  assert.deepEqual(messages.slice(1), [
    {
      command: 'requestFailed',
      message: 'There is no unfinished DevMate run for this session.',
      retryable: false
    },
    {
      command: 'status',
      text: 'There is no unfinished DevMate run for this session.',
      level: 'warning'
    }
  ]);
});

test('publishes initial view state in order and waits for profile setup', async () => {
  const provider = providerWithoutConstructor();
  const calls = [];
  let finishProfileState;
  const pending = new Promise((resolve) => { finishProfileState = resolve; });
  provider.attachmentController = { postState: () => calls.push('attachments') };
  provider.profilePresenter = {
    postLlmProfileState: async () => { calls.push('llm profiles'); await pending; },
    promptForBuiltInNemotronKey: async () => { calls.push('profile key prompt'); },
    postEmbeddingProfileState: () => calls.push('embedding profiles')
  };
  provider.permissionPresenter = { postPolicyState: () => calls.push('permissions') };
  provider.settingsPresenter = { postState: () => calls.push('settings') };
  provider.postBackendStatus = () => calls.push('backend');
  provider.sessionPresenter = { postState: (replaceMessages) => calls.push(['sessions', replaceMessages]) };

  const ready = provider.handleMessage({ command: 'ready' });
  assert.deepEqual(calls, ['attachments', 'llm profiles']);
  finishProfileState();
  await ready;
  assert.deepEqual(calls, [
    'attachments', 'llm profiles', 'profile key prompt', 'embedding profiles',
    'permissions', 'settings', 'backend', ['sessions', false]
  ]);
});

test('connects profile secrets and workspace settings through the real provider constructor', async () => {
  const context = extensionContext();
  const secrets = new Map();
  context.secrets = {
    get: async (key) => secrets.get(key),
    store: async (key, value) => { secrets.set(key, value); },
    delete: async (key) => { secrets.delete(key); }
  };
  let embeddingChanges = 0;
  const provider = new DevMateChatViewProvider(
    context, {}, { append() {} }, undefined,
    () => { embeddingChanges += 1; }
  );
  const messages = [];
  provider.postMessage = (message) => messages.push(message);
  const originalConfiguration = new Map(configuration);
  try {
    await provider.handleMessage({
      command: 'saveLlmProfile',
      profile: {
        name: 'Test chat', provider: 'openai', model: 'test-chat',
        baseUrl: 'https://example.com/v1', apiKey: 'chat-secret'
      }
    });
    await provider.handleMessage({
      command: 'saveEmbeddingProfile',
      profile: {
        provider: 'ollama', model: 'test-embedding',
        baseUrl: 'http://127.0.0.1:11434', remoteAllowed: false, apiKey: 'embedding-secret'
      }
    });
    const chatProfile = context.globalValues.get(LLM_PROFILES_STORAGE_KEY)[0];
    const embeddingProfile = context.globalValues.get(EMBEDDING_PROFILES_STORAGE_KEY)[0];
    assert.equal(chatProfile.model, 'test-chat');
    assert.equal(embeddingProfile.model, 'test-embedding');
    assert.equal(secrets.get(secretKeyForProfile(chatProfile.id)), 'chat-secret');
    assert.equal(secrets.get(embeddingSecretKeyForProfile(embeddingProfile.id)), 'embedding-secret');
    assert.doesNotMatch(JSON.stringify([...context.globalValues]), /chat-secret|embedding-secret/);
    assert.equal(embeddingChanges, 1);

    // Saving settings must update the policy read by the permission presenter too.
    const policy = { createFiles: 'ask', updateFiles: 'allow' };
    await provider.handleMessage({
      command: 'saveSettings',
      settings: {
        timeoutSeconds: 1_800,
        commandTimeoutSeconds: 300,
        toolCallLimit: 16,
        maxTokens: 2_048,
        maxInputContextTokens: 24_000,
        temperature: 0.35,
        policy
      }
    });
    assert.deepEqual(context.workspaceValues.get(FILE_PERMISSION_POLICY_STORAGE_KEY), policy);
    assert.equal(context.globalValues.has(FILE_PERMISSION_POLICY_STORAGE_KEY), false);
    assert.deepEqual(provider.permissionPresenter.policy(), policy);
    assert.ok(messages.some((message) => message.command === 'settingsSaved'));

    // Both presenters must observe the current request, not a copied startup value.
    provider.activeRequest = new AbortController();
    await provider.handleMessage({ command: 'newSession' });
    assert.match(messages.at(-1).text, /Wait for the active request/);
    await provider.handleMessage({ command: 'setReasoningEffort', effort: 'auto' });
    assert.match(messages.at(-1).text, /Wait for the active request/);
    provider.activeRequest = undefined;

    await provider.handleMessage({ command: 'editLlmProfile', profileId: chatProfile.id });
    assert.equal(messages.at(-1).hasApiKey, true);
    await provider.handleMessage({ command: 'editEmbeddingProfile', profileId: embeddingProfile.id });
    assert.equal(messages.at(-1).hasApiKey, true);
    await provider.handleMessage({ command: 'deleteLlmProfile', profileId: chatProfile.id });
    assert.equal(secrets.has(secretKeyForProfile(chatProfile.id)), false);
    assert.equal(secrets.has(embeddingSecretKeyForProfile(embeddingProfile.id)), true);
    await provider.handleMessage({ command: 'deleteEmbeddingProfile', profileId: embeddingProfile.id });
    assert.equal(secrets.size, 0);
    assert.equal(embeddingChanges, 2);
  } finally {
    provider.dispose();
    configuration.clear();
    for (const [key, value] of originalConfiguration) configuration.set(key, value);
  }
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

test('agent run applies the context budget before sending a provider request', async () => {
  let capturedRequest;
  const transport = {
    ask: async () => assert.fail('streaming should remain supported'),
    askStream: async (_url, request) => {
      capturedRequest = request;
      return {
        unsupported: false,
        result: {
          status: 'ok',
          data: {
            answer: 'Done.',
            usedFiles: [],
            changes: [],
            toolCalls: [],
            tokenUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, exact: true }
          }
        }
      };
    },
    waitForRetryDelay: async () => true
  };
  const controller = new AgentRunController({
    execute: async () => assert.fail('no tool call was expected')
  }, {
    saveCheckpoint: async () => undefined,
    recoverBackend: async () => true,
    emit: () => undefined
  }, transport);
  const projectContent = 'p'.repeat(8_000);
  const recentTurn = {
    user: 'u'.repeat(2_000),
    assistant: 'a'.repeat(2_000)
  };
  const conversationSummary = {
    goal: 'Keep the requested change focused.',
    constraints: [],
    decisions: [],
    importantFiles: [],
    completedWork: [],
    openTasks: [],
    unresolvedQuestions: []
  };

  const outcome = await controller.run({
    question: 'Current question',
    mode: 'ideas',
    scopeKind: 'project',
    scope: {
      type: 'project',
      workspacePath: 'C:\\repo',
      items: [{
        source: 'file',
        filePath: 'C:\\repo\\src\\project.ts',
        languageId: 'typescript',
        content: projectContent,
        includedCharacters: projectContent.length,
        totalCharacters: projectContent.length,
        truncated: false
      }]
    },
    conversationHistory: [recentTurn],
    conversationSummary,
    modelContextWindowTokens: 10_000,
    maxInputContextTokens: 6_000,
    settings: {
      provider: 'ollama',
      model: 'qwen3-coder',
      maxTokens: 128,
      temperature: 0.2,
      reasoningEffort: 'auto',
      timeoutSeconds: 900
    },
    backendUrl: 'http://127.0.0.1:8000',
    backendToken: TEST_BACKEND_TOKEN,
    toolCallLimit: 16,
    workspaceId: workspace.id,
    sessionId: 'session'
  }, new AbortController().signal);

  assert.equal(outcome.kind, 'completed');
  assert.deepEqual(capturedRequest.scope.items, []);
  assert.deepEqual(capturedRequest.conversationHistory, [recentTurn]);
  assert.deepEqual(capturedRequest.conversationSummary, conversationSummary);
});

test('agent run reports required-context overflow before contacting the provider', async () => {
  const controller = new AgentRunController({
    execute: async () => assert.fail('no tool call was expected')
  }, {
    saveCheckpoint: async () => undefined,
    recoverBackend: async () => true,
    emit: () => undefined
  }, {
    ask: async () => assert.fail('provider should not receive an over-budget request'),
    askStream: async () => assert.fail('provider should not receive an over-budget request'),
    waitForRetryDelay: async () => true
  });

  const outcome = await controller.run({
    question: 'Explain this selection',
    mode: 'ideas',
    scopeKind: 'selection',
    scope: {
      type: 'selection',
      workspacePath: 'C:\\repo',
      items: [{
        source: 'selection',
        filePath: 'C:\\repo\\src\\large.ts',
        languageId: 'typescript',
        content: 'x'.repeat(8_000),
        includedCharacters: 8_000,
        totalCharacters: 8_000,
        truncated: false
      }]
    },
    conversationHistory: [],
    modelContextWindowTokens: 1_024,
    settings: {
      provider: 'ollama',
      model: 'qwen3-coder',
      maxTokens: 128,
      temperature: 0.2,
      reasoningEffort: 'auto',
      timeoutSeconds: 900
    },
    backendUrl: 'http://127.0.0.1:8000',
    backendToken: TEST_BACKEND_TOKEN,
    toolCallLimit: 16,
    workspaceId: workspace.id,
    sessionId: 'session'
  }, new AbortController().signal);

  assert.equal(outcome.kind, 'failed');
  assert.match(outcome.message, /required instructions, question, and explicit context exceed/i);
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
