const assert = require('node:assert/strict');
const test = require('node:test');
const { createVscodeHarness, withoutDelays } = require('./helpers/vscode');
const harness = createVscodeHarness();
const { vscode, folder, context, setFile } = harness;
const { DevMateChatViewProvider } = harness.load('chatViewProvider');
const { WorkspaceContext } = harness.load('workspaceContext');
const { ToolExecutor } = harness.load('toolExecutor');
const { createConversationSessionStore, appendConversationSessionTurn } = require('../out/sessions');
const workspace = { id: folder.uri.toString().toLowerCase(), name: folder.name };
const backend = { start: async () => true, status: { detail: 'online', state: 'running' } };
const events = { postMessage() {}, postStatus() {} };

function makeExecutor(extensionContext = context(), overrides = {}) {
  return new ToolExecutor(extensionContext, new WorkspaceContext(extensionContext, events), {
    ...events,
    postSettingsState() {},
    postPermissionPolicyState() {},
    getActiveSignal: () => undefined,
    getAgentToolSettings: () => ({
      readFileMaxLines: 400,
      listFilesMaxResults: 200,
      searchCodeMaxResults: 50,
      diagnosticsMaxResults: 100,
      terminalErrorsMaxResults: 5,
      codeNavigationMaxResults: 100
    }),
    ...overrides
  });
}

test('provider loads global sessions and migrates the legacy workspace session', async () => {
  const existing = createConversationSessionStore('existing', 1, { id: 'file:///other', name: 'Other' });
  const legacy = {
    version: 1,
    activeSessionId: 'legacy',
    sessions: [
      {
        id: 'legacy',
        title: 'Legacy work',
        createdAt: 2,
        updatedAt: 3,
        turns: [{ user: 'Old question', assistant: 'Old answer' }]
      }
    ]
  };
  const storage = context({
    global: { 'devMate.conversationSessions.v2': existing },
    workspace: { 'devMate.conversationSessions.v1': legacy }
  });
  const provider = new DevMateChatViewProvider(storage, backend, { show() {} });
  try {
    await new Promise(setImmediate);
    const saved = storage.globalValues.get('devMate.conversationSessions.v2');
    assert.equal(saved.sessions.length, 2);
    assert.equal(saved.activeSessionId, 'legacy');
    assert.equal(saved.sessions.find(session => session.id === 'legacy').workspaceId, workspace.id);
    assert.equal(storage.workspaceValues.has('devMate.conversationSessions.v1'), false);
  } finally {
    provider.dispose();
  }
});

test('workspace context reads actual attachments, editor content and lexical disk index', async () => {
  harness.files.clear();
  setFile('README.md', '# Project');
  const app = setFile('src/app.ts', 'export function authenticateUser() { return true; }');
  const selection = {};
  let selectedText = 'return true;';
  vscode.window.activeTextEditor = {
    selection,
    document: {
      uri: app,
      fileName: app.fsPath,
      languageId: 'typescript',
      getText: range => range === selection ? selectedText : 'unsaved editor source'
    }
  };
  const collector = new WorkspaceContext(context(), events);
  try {
    await collector.pickWorkspaceFiles();
    const fileScope = await collector.collectScope('activeFile', 'Explain');
    assert.deepEqual(fileScope.apiScope.items.map(item => item.source), ['file', 'attachment']);
    assert.equal(fileScope.apiScope.items[0].content, 'unsaved editor source');
    assert.equal(fileScope.apiScope.items[1].content, '# Project');
    const selectionScope = await collector.collectScope('selection', 'Explain');
    assert.equal(selectionScope.apiScope.items[0].content, 'return true;');
    selectedText = '  ';
    assert.equal(await collector.collectScope('selection', 'Explain'), undefined);
    const projectScope = await collector.collectScope('project', 'authenticate user');
    assert.equal(projectScope.apiScope.items[0].source, 'attachment');
    assert.match(projectScope.apiScope.items[1].content, /Local index excerpt.*\nexport function authenticate/s);
    assert.ok(harness.writes.some(name => name.endsWith('project-index-v1.json')));
  } finally {
    vscode.window.activeTextEditor = undefined;
  }
});

test('provider routes one active request and finalizes a resumed run through real services', async () => {
  harness.files.clear();
  let sessions = createConversationSessionStore('session', 1, workspace);
  sessions = appendConversationSessionTurn(sessions, 'Earlier question', 'Earlier answer', 2);
  const now = Date.now();
  const checkpoint = {
    version: 1,
    workspaceId: workspace.id,
    sessionId: 'session',
    question: 'Continue the fix',
    mode: 'debug',
    scopeKind: 'project',
    toolHistory: [
      {
        callId: 'read-1',
        name: 'read_file',
        arguments: { path: 'src/app.ts' },
        result: 'Current source',
        isError: false
      }
    ],
    toolUsedFiles: ['src/app.ts'],
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
    createdAt: now,
    updatedAt: now
  };
  const storage = context({
    global: {
      'devMate.conversationSessions.v2': sessions,
      'devMate.llmProfiles.v1': [
        {
          id: 'local',
          name: 'Local',
          provider: 'ollama',
          model: 'qwen3-coder',
          baseUrl: 'http://127.0.0.1:11434/v1'
        }
      ],
      'devMate.activeLlmProfileId.v1': 'local'
    },
    workspace: { 'devMate.agentCheckpoint.v1': checkpoint }
  });
  harness.configuration.set('requestTimeoutSeconds', 1900);
  harness.configuration.set('maxTokens', 2048);
  let completeTransport;
  let capturedRequest;
  let capturedTimeout;
  let transportCalls = 0;
  const transport = {
    ask: async () => assert.fail('Streaming should be supported'),
    askStream: async (_url, request, _key, timeout, _signal, onEvent) => {
      transportCalls += 1;
      capturedRequest = request;
      capturedTimeout = timeout;
      onEvent({
        type: 'usage',
        usage: {
          inputTokens: 2,
          outputTokens: 1,
          totalTokens: 3,
          exact: true
        }
      });
      await new Promise(resolve => {
        completeTransport = resolve;
      });
      return {
        unsupported: false,
        result: {
          status: 'ok',
          data: {
            answer: 'Fix completed.',
            usedFiles: [],
            changes: [],
            toolCalls: []
          }
        }
      };
    }
  };
  const provider = new DevMateChatViewProvider(storage, backend, { show() {} }, transport);
  const messages = [];
  let receive;
  provider.resolveWebviewView({
    webview: {
      cspSource: 'test',
      asWebviewUri: uri => uri,
      postMessage: value => messages.push(value),
      onDidReceiveMessage: callback => {
        receive = callback;
        return { dispose() {} };
      }
    },
    onDidDispose: () => ({ dispose() {} })
  });
  try {
    await withoutDelays(async () => {
      receive({ command: 'continueAgentRun' });
      for (let attempt = 0; !completeTransport && attempt < 100; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      assert.ok(completeTransport, JSON.stringify(messages));
      receive({
        command: 'ask',
        mode: 'ideas',
        question: 'Another request',
        scope: { kind: 'project' }
      });
      assert.ok(messages.some(message => /already working/.test(message.text ?? '')));
      assert.equal(transportCalls, 1);
      assert.equal(capturedTimeout, 1830000);
      assert.equal(capturedRequest.settings.maxTokens, 2048);
      assert.equal(capturedRequest.enabledTools.includes('install_dependencies'), false);
      assert.equal(capturedRequest.enabledTools.includes('run_command'), true);
      assert.deepEqual(capturedRequest.toolHistory, checkpoint.toolHistory);
      assert.deepEqual(capturedRequest.conversationHistory, [{ user: 'Earlier question', assistant: 'Earlier answer' }]);
      assert.equal(storage.workspaceValues.get('devMate.agentCheckpoint.v1').workspaceRevision, 8);
      assert.deepEqual(messages.find(message => message.command === 'tokenUsageUpdated').usage, {
        inputTokens: 12,
        outputTokens: 6,
        totalTokens: 18,
        exact: true
      });
      completeTransport();
      for (let attempt = 0; !messages.some(message => message.command === 'assistantResponse') && attempt < 100; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      assert.ok(messages.some(message => message.command === 'assistantResponse'));
    });
    assert.equal(storage.workspaceValues.has('devMate.agentCheckpoint.v1'), false);
    assert.equal(
      storage.globalValues.get('devMate.conversationSessions.v2').sessions[0].turns.at(-1).user,
      'Continue the fix'
    );
  } finally {
    provider.dispose();
    harness.configuration.clear();
  }
});

test('executor validates and dispatches actual read, list, search and diagnostics tools', async () => {
  harness.files.clear();
  setFile('src/app.ts', 'first line\nconst needle = 42;\nlast line');
  const activities = [];
  const executor = makeExecutor(context(), { postMessage: message => activities.push(message) });
  try {
    const read = await executor.executeAgentToolCall(
      { id: 'read', name: 'read_file', arguments: { path: 'src/app.ts', startLine: 2, endLine: 2 } }
    );
    assert.equal(read.step.isError, false);
    assert.match(read.step.result, /Lines: 2-2 of 3/);
    assert.match(read.step.result, /const needle = 42;/);
    const list = await executor.executeAgentToolCall({ id: 'list', name: 'list_files', arguments: {} });
    assert.match(list.step.result, /src\/app.ts/);
    const search = await executor.executeAgentToolCall({ id: 'search', name: 'search_code', arguments: { query: 'needle' } });
    assert.match(search.step.result, /src\/app.ts:2:/);
    const diagnostics = await executor.executeAgentToolCall({ id: 'diagnostics', name: 'get_diagnostics', arguments: {} });
    assert.equal(diagnostics.step.isError, false);
    const invalid = await executor.executeAgentToolCall({ id: 'bad', name: 'read_file', arguments: { path: '../outside.ts' } });
    assert.equal(invalid.step.isError, true);
    assert.match(invalid.step.result, /unsafe segments/i);
    assert.ok(activities.some(message => message.activity?.status === 'completed'));
  } finally {
    executor.dispose();
  }
});

test('executor stops mutations at the workspace trust boundary', async () => {
  const executor = makeExecutor();
  vscode.workspace.isTrusted = false;
  try {
    await assert.rejects(
      () => executor.confirmAndApplyFileChanges(
        [{ path: 'src/app.ts', content: 'changed' }],
        'Update',
        new AbortController().signal
      ),
      /Trust this workspace/
    );
    assert.equal(executor.enabledAgentTools('code', 0, 0, 0).includes('edit_file'), false);
  } finally {
    vscode.workspace.isTrusted = true;
    executor.dispose();
  }
});

test('executor rechecks trust after permission and cancels pending file work', async () => {
  harness.files.clear();
  setFile('src/existing.ts', 'unchanged');
  let executor;
  executor = makeExecutor(context(), {
    postMessage: message => {
      if (message.command === 'permissionRequest') {
        vscode.workspace.isTrusted = false;
        void executor.handlePermissionDecision(message.requestId, 'allowOnce');
      }
    }
  });
  try {
    await assert.rejects(
      () => executor.confirmAndApplyFileChanges([{ path: 'src/new.ts', content: 'new' }], 'Create', new AbortController().signal),
      /Workspace Trust changed/
    );
  } finally {
    vscode.workspace.isTrusted = true;
    executor.dispose();
  }
  const controller = new AbortController();
  executor = makeExecutor(context(), {
    postMessage: message => {
      if (message.command === 'permissionRequest') {
        controller.abort();
        executor.cancelPendingWork();
      }
    }
  });
  try {
    const result = await executor.confirmAndApplyFileChanges([{ path: 'src/new.ts', content: 'new' }], 'Create', controller.signal);
    assert.equal(result, 'Proposed file changes were not applied.');
  } finally {
    executor.dispose();
  }
});

test('executor rejects content changed while file permission was pending', async () => {
  harness.files.clear();
  setFile('src/app.ts', 'original');
  const originalOpenDocument = vscode.workspace.openTextDocument;
  let content = 'original';
  vscode.workspace.openTextDocument = async () => ({ isDirty: false, getText: () => content });
  let executor;
  executor = makeExecutor(context(), {
    postMessage: message => {
      if (message.command === 'permissionRequest') {
        content = 'changed outside DevMate';
        void executor.handlePermissionDecision(message.requestId, 'allowOnce');
      }
    }
  });
  try {
    await assert.rejects(
      () => executor.confirmAndApplyFileChanges(
        [{ path: 'src/app.ts', content: 'proposed' }],
        'Update',
        new AbortController().signal
      ),
      /changed while permission was pending/
    );
  } finally {
    vscode.workspace.openTextDocument = originalOpenDocument;
    executor.dispose();
  }
});
