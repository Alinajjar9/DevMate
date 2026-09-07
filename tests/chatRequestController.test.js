const assert = require('node:assert/strict');
const test = require('node:test');

const { ChatRequestController } = require('../out/chat/chatRequestController');
const { SessionController } = require('../out/sessions/sessionController');
const {
  appendConversationSessionTurn,
  createConversationSessionStore
} = require('../out/sessions/sessions');

const TEST_BACKEND_TOKEN = 'test-backend-token-that-is-long-enough';
const workspace = { id: 'workspace-a', name: 'Workspace A' };

test('rejects an empty question before starting a request', async () => {
  const fixture = createFixture();

  await fixture.controller.answer(message({ question: '   ' }), signal());

  assert.deepEqual(fixture.failures, [{
    message: 'Enter a question before asking.',
    options: { level: 'warning' }
  }]);
  assert.equal(fixture.startedChanges, 0);
  assert.equal(fixture.agentCalls, 0);
});

test('keeps a pending user turn when no model profile is configured', async () => {
  const fixture = createFixture({ activeProfile: undefined });

  await fixture.controller.answer(message(), signal());

  assert.deepEqual(fixture.sessions.activeSession().turns, [{
    user: 'Explain this code', assistant: ''
  }]);
  assert.deepEqual(fixture.openedProfileForms, [undefined]);
  assert.match(fixture.failures[0].message, /Add a model profile/);
  assert.equal(fixture.backendStarts, 0);
});

test('does not call the agent when an OpenAI-compatible profile has no key', async () => {
  const fixture = createFixture({
    activeProfile: {
      id: 'remote-model',
      name: 'Remote model',
      provider: 'openai',
      model: 'gpt-compatible',
      baseUrl: 'https://models.example/v1'
    },
    apiKey: undefined
  });

  await fixture.controller.answer(message(), signal());

  assert.equal(fixture.agentCalls, 0);
  assert.deepEqual(fixture.openedProfileForms, ['remote-model']);
  assert.deepEqual(fixture.failures.at(-1), {
    message: 'The selected model profile is missing an API key.',
    options: { level: 'warning', retryable: true }
  });
});

test('records a readable error when the model proposes an unsafe file change', async () => {
  const fixture = createFixture({
    agentOutcome: {
      kind: 'completed',
      response: {
        answer: 'I prepared the update.',
        usedFiles: [],
        changes: [{ path: '../outside.ts', content: 'unsafe' }],
        toolCalls: []
      },
      toolHistory: [],
      toolUsedFiles: [],
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        exact: true
      }
    }
  });

  await fixture.controller.answer(message(), signal());

  assert.match(
    fixture.statuses.find((item) => item.level === 'error').text,
    /unsafe or invalid/
  );
  assert.match(fixture.sessions.activeSession().turns[0].assistant, /Changes were not applied/);
  assert.equal(fixture.clearedCheckpoints, 1);
  assert.equal(fixture.messages.at(-1).command, 'assistantResponse');
});

test('prepares a resumed agent run and persists its completed outcome', async () => {
  const initialStore = appendConversationSessionTurn(
    createConversationSessionStore('session-a', 1, workspace),
    'Earlier question', 'Earlier answer', 2
  );
  const checkpoint = {
    version: 1,
    workspaceId: workspace.id,
    sessionId: 'session-a',
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
  const compactedSummaryContent = {
    goal: 'Finish the existing fix.',
    constraints: ['Keep the change focused.'],
    decisions: [],
    importantFiles: ['src/app.ts'],
    completedWork: [],
    openTasks: ['Verify the fix.'],
    unresolvedQuestions: []
  };
  const fixture = createFixture({
    initialStore,
    activeProfile: {
      id: 'local-model', name: 'Local model', provider: 'ollama',
      model: 'qwen3-coder', baseUrl: 'http://127.0.0.1:11434/v1',
      contextWindowTokens: 64_000
    },
    settings: { timeoutSeconds: 1800, temperature: 0.35 },
    reasoningPreferences: { 'local-model': 'high' },
    agentOutcome: {
      kind: 'completed',
      response: {
        answer: 'Fix completed.', usedFiles: ['C:\\repo\\src\\app.ts'],
        changes: [], toolCalls: []
      },
      toolHistory: checkpoint.toolHistory,
      toolUsedFiles: checkpoint.toolUsedFiles,
      tokenUsage: { inputTokens: 12, outputTokens: 6, totalTokens: 18, exact: true }
    },
    compactionOutcome: {
      kind: 'not-needed', reason: 'too-few-turns',
      summary: {
        sessionId: 'session-a', summaryVersion: 1, content: compactedSummaryContent,
        lastCompactedTurn: 0, createdAtMs: 100, updatedAtMs: 100
      }
    }
  });
  const requestSignal = signal();

  await fixture.controller.answer(message({
    mode: 'debug', question: '  Continue the fix  '
  }), requestSignal, checkpoint);

  // A resumed run keeps its existing change snapshots and does not append another user turn.
  assert.equal(fixture.startedChanges, 0);
  assert.equal(fixture.agentCalls, 1);
  const [{ input, signal: agentSignal }] = fixture.agentRequests;
  assert.equal(agentSignal, requestSignal);
  assert.equal(input.question, 'Continue the fix');
  assert.equal(input.mode, 'debug');
  assert.equal(input.scopeKind, 'project');
  assert.equal(input.modelContextWindowTokens, 64_000);
  assert.equal(input.maxInputContextTokens, 24_000);
  assert.equal(input.backendToken, TEST_BACKEND_TOKEN);
  assert.equal(input.settings.maxTokens, 2048);
  assert.equal(input.settings.temperature, 0.35);
  assert.equal(input.settings.timeoutSeconds, 1800);
  assert.equal(input.settings.reasoningEffort, 'auto');
  assert.equal(input.toolCallLimit, 16);
  assert.equal(input.workspaceId, workspace.id);
  assert.equal(input.sessionId, 'session-a');
  assert.equal(input.resumedCheckpoint, checkpoint);
  assert.deepEqual(input.conversationHistory, []);
  assert.deepEqual(input.conversationSummary, compactedSummaryContent);
  assert.equal(fixture.clearedCheckpoints, 1);
  assert.equal(fixture.savedSessions.length, 1);
  assert.deepEqual(fixture.failures, []);
  const response = 'Fix completed.\n\nUsed files:\n- `C:\\repo\\src\\app.ts`';
  assert.equal(fixture.sessions.activeSession().turns.at(-1).assistant, response);
  assert.equal(fixture.savedSessions[0][0].turns.at(-1).assistant, response);
  assert.equal(
    fixture.messages.find((event) => event.command === 'assistantResponse').response,
    response
  );
});

test('does not collect or send workspace context without an authenticated backend token', async () => {
  const fixture = createFixture();
  fixture.dependencies.backend.token = () => undefined;

  await fixture.controller.answer(message({
    question: 'Do not send this context', isNewTurn: false
  }), signal());

  assert.equal(fixture.contextRequests.length, 0);
  assert.equal(fixture.agentCalls, 0);
  assert.equal(fixture.compactionRequests.length, 0);
  assert.match(fixture.failures[0].message, /authenticated backend connection/);
  assert.deepEqual(fixture.failures[0].options, { level: 'warning', retryable: true });
});

test('keeps a fresh pending user turn when the agent run fails', async () => {
  const initialStore = appendConversationSessionTurn(
    createConversationSessionStore('session-a', 1, workspace),
    'Earlier request', 'Earlier answer', 2
  );
  const fixture = createFixture({
    initialStore,
    agentOutcome: { kind: 'failed', message: 'Provider unavailable.', retryable: true },
    compactionOutcome: { kind: 'failed', message: 'Summary provider unavailable.' }
  });

  await fixture.controller.answer(message({ question: 'New request' }), signal());

  assert.equal(fixture.startedChanges, 1);
  assert.equal(fixture.savedSessions.length, 1);
  assert.equal(fixture.compactionRequests.length, 1);
  const [{ input: compactionInput }] = fixture.compactionRequests;
  assert.equal(compactionInput.session.id, 'session-a');
  assert.deepEqual(compactionInput.session.turns.at(-1), {
    user: 'New request', assistant: ''
  });
  assert.equal(compactionInput.access.backendToken, TEST_BACKEND_TOKEN);
  assert.equal(compactionInput.settings.model, 'qwen3-coder');
  assert.match(fixture.backendOutput.join(''), /Summary provider unavailable/);
  assert.equal(fixture.agentCalls, 1);
  const [{ input: agentInput }] = fixture.agentRequests;
  assert.deepEqual(agentInput.conversationHistory, [{
    user: 'Earlier request', assistant: 'Earlier answer'
  }]);
  assert.equal(agentInput.conversationSummary, undefined);
  const pendingTurn = { user: 'New request', assistant: '' };
  assert.deepEqual(fixture.sessions.activeSession().turns.at(-1), pendingTurn);
  assert.deepEqual(fixture.savedSessions[0][0].turns.at(-1), pendingTurn);
  assert.equal(fixture.clearedCheckpoints, 0);
  assert.deepEqual(fixture.failures, [{
    message: 'Provider unavailable.', options: { retryable: true }
  }]);
});

test('records applied file proposals from their typed outcome, not from notice wording', async () => {
  const fixture = createFixture({ agentOutcome: proposalOutcome() });
  fixture.dependencies.changes.apply = async () => ({
    kind: 'applied', changes: [{ kind: 'updated', path: 'src/app.ts' }],
    notice: 'The editor could not be opened.'
  });
  fixture.dependencies.changes.completedDiffId = () => 'change_123';

  await fixture.controller.answer(message({ mode: 'code' }), signal());

  const response = fixture.messages.find((item) => item.command === 'assistantResponse');
  assert.equal(response.response, 'Updated the code.\n\nThe editor could not be opened.');
  assert.deepEqual(response.fileChanges, [{ kind: 'updated', path: 'src/app.ts', diffId: 'change_123' }]);
  assert.deepEqual(fixture.savedSessions.at(-1)[0].turns.at(-1).fileChanges, response.fileChanges);
});

test('a denied file proposal is not included in the applied-change summary', async () => {
  const fixture = createFixture({ agentOutcome: proposalOutcome() });
  // Even success-looking display text cannot turn a denied operation into an applied one.
  fixture.dependencies.changes.apply = async () => ({
    kind: 'denied', message: 'Applied file changes:\n- Updated src/app.ts'
  });

  await fixture.controller.answer(message({ mode: 'code' }), signal());

  assert.deepEqual(fixture.messages.find((item) => item.command === 'assistantResponse').fileChanges, []);
});

test('keeps a completed file edit in the transcript when cancellation arrives during application', async () => {
  const fixture = createFixture({ agentOutcome: proposalOutcome() });
  const controller = new AbortController();
  fixture.dependencies.events.finishCancellation = (requestSignal) => requestSignal.aborted;
  fixture.dependencies.changes.apply = async () => {
    controller.abort();
    return { kind: 'applied', changes: [{ kind: 'updated', path: 'src/app.ts' }] };
  };

  await fixture.controller.answer(message({ mode: 'code' }), controller.signal);

  assert.equal(fixture.sessions.activeSession().turns.at(-1).assistant, 'Updated the code.');
  assert.equal(fixture.clearedCheckpoints, 1);
});

test('cancellation before application leaves the user turn pending', async () => {
  const fixture = createFixture({ agentOutcome: proposalOutcome() });
  const controller = new AbortController();
  fixture.dependencies.events.finishCancellation = (requestSignal) => requestSignal.aborted;
  fixture.dependencies.changes.apply = async () => {
    controller.abort();
    return { kind: 'cancelled', message: 'Proposed file changes were not applied.' };
  };

  await fixture.controller.answer(message({ mode: 'code' }), controller.signal);

  assert.equal(fixture.sessions.activeSession().turns.at(-1).assistant, '');
  assert.equal(fixture.clearedCheckpoints, 0);
  assert.equal(fixture.messages.some((item) => item.command === 'assistantResponse'), false);
});

function proposalOutcome() {
  return {
    kind: 'completed',
    response: {
      answer: 'Updated the code.', usedFiles: [], toolCalls: [],
      changes: [{ path: 'src/app.ts', content: 'export const value = 2;' }]
    },
    toolHistory: [], toolUsedFiles: [],
    tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, exact: true }
  };
}

// Exercise the request controller through its current dependencies, without a fake VS Code view.
function createFixture(options = {}) {
  const activeProfile = Object.hasOwn(options, 'activeProfile')
    ? options.activeProfile
    : {
      id: 'local-model',
      name: 'Local model',
      provider: 'ollama',
      model: 'qwen3-coder',
      baseUrl: 'http://127.0.0.1:11434/v1'
    };
  const initialStore = options.initialStore
    ?? createConversationSessionStore('session-a', 1, workspace);
  const savedSessions = [];
  // Use the real session rules; only the database writes are replaced with in-memory snapshots.
  const sessions = new SessionController({
    loadWorkspace: async () => ({ kind: 'completed', value: initialStore }),
    saveSessions: async (saved) => {
      savedSessions.push(structuredClone(saved));
      return { kind: 'completed', value: undefined };
    },
    deleteSession: async () => ({ kind: 'completed', value: undefined })
  }, (issue) => assert.fail(issue.message), initialStore);
  const messages = [];
  const statuses = [];
  const failures = [];
  const openedProfileForms = [];
  const contextRequests = [];
  const agentRequests = [];
  const compactionRequests = [];
  const backendOutput = [];
  let startedChanges = 0;
  let backendStarts = 0;
  let clearedCheckpoints = 0;
  const dependencies = {
    backend: {
      start: async () => {
        backendStarts += 1;
        return true;
      },
      detail: () => 'Backend unavailable.',
      token: () => TEST_BACKEND_TOKEN,
      url: () => 'http://127.0.0.1:8000',
      appendLog: (value) => backendOutput.push(value)
    },
    context: {
      workspace: () => workspace,
      collect: async (scope, question, requestSignal) => {
        contextRequests.push({ scope, question, signal: requestSignal });
        return {
          info: { kind: 'project', label: 'Project', detail: 'Workspace A' },
          apiScope: { type: 'project', workspacePath: 'C:\\workspace', items: [] }
        };
      }
    },
    profiles: {
      active: () => activeProfile,
      reasoningPreferences: () => options.reasoningPreferences ?? {},
      apiKey: async () => options.apiKey,
      showForm: async (profileId) => openedProfileForms.push(profileId)
    },
    settings: {
      state: () => ({
        timeoutSeconds: 900,
        commandTimeoutSeconds: 300,
        toolCallLimit: 16,
        maxTokens: 2_048,
        maxInputContextTokens: 24_000,
        temperature: 0.2,
        agentTools: {
          readFileMaxLines: 400,
          listFilesMaxResults: 200,
          searchCodeMaxResults: 50,
          diagnosticsMaxResults: 100,
          terminalErrorsMaxResults: 5,
          codeNavigationMaxResults: 100
        },
        ...options.settings
      })
    },
    sessions,
    compaction: {
      compactIfNeeded: async (input, requestSignal) => {
        compactionRequests.push({ input, signal: requestSignal });
        return options.compactionOutcome ?? { kind: 'not-needed', reason: 'too-few-turns' };
      }
    },
    agentRuns: {
      run: async (input, requestSignal) => {
        agentRequests.push({ input, signal: requestSignal });
        return options.agentOutcome ?? {
          kind: 'completed',
          response: {
            answer: 'Done.',
            usedFiles: [],
            changes: [],
            toolCalls: []
          },
          toolHistory: [],
          toolUsedFiles: [],
          tokenUsage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            exact: true
          }
        };
      }
    },
    checkpoints: {
      current: () => undefined,
      clear: async () => {
        clearedCheckpoints += 1;
      }
    },
    changes: {
      beginRequest: () => {
        startedChanges += 1;
      },
      apply: async () => ({ kind: 'denied', message: 'Proposed file changes were not applied.' }),
      completedDiffId: () => undefined
    },
    events: {
      postMessage: (value) => messages.push(value),
      postStatus: (text, level = 'info') => statuses.push({ text, level }),
      postFailure: (failureMessage, failureOptions) => {
        failures.push({ message: failureMessage, options: failureOptions });
      },
      finishCancellation: () => false,
      sessionStateChanged: () => undefined
    },
    now: () => 100
  };
  const controller = new ChatRequestController(dependencies, async () => undefined);
  return {
    controller,
    dependencies,
    sessions,
    savedSessions,
    messages,
    statuses,
    failures,
    openedProfileForms,
    contextRequests,
    agentRequests,
    compactionRequests,
    backendOutput,
    get startedChanges() {
      return startedChanges;
    },
    get agentCalls() {
      return agentRequests.length;
    },
    get backendStarts() {
      return backendStarts;
    },
    get clearedCheckpoints() {
      return clearedCheckpoints;
    }
  };
}

function message(overrides = {}) {
  return {
    command: 'ask',
    mode: 'ideas',
    question: 'Explain this code',
    scope: { kind: 'project', label: 'Project', detail: '' },
    ...overrides
  };
}

function signal() {
  return new AbortController().signal;
}
