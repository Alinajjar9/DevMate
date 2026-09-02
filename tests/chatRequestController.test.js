const assert = require('node:assert/strict');
const test = require('node:test');

const { ChatRequestController } = require('../out/chatRequestController');

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

  assert.deepEqual(fixture.pendingUsers, ['Explain this code']);
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
  assert.match(fixture.savedTurns[0].assistant, /Changes were not applied/);
  assert.equal(fixture.clearedCheckpoints, 1);
  assert.equal(fixture.messages.at(-1).command, 'assistantResponse');
});

function createFixture(options = {}) {
  const activeProfile = Object.hasOwn(options, 'activeProfile')
    ? options.activeProfile
    : {
      id: 'local-model',
      name: 'Local model',
      provider: 'ollama',
      model: 'qwen-coder',
      baseUrl: 'http://127.0.0.1:11434/v1'
    };
  const session = {
    id: 'session-a',
    title: 'Chat',
    workspaceId: 'workspace-a',
    workspaceName: 'Workspace A',
    createdAt: 1,
    updatedAt: 1,
    turns: []
  };
  const messages = [];
  const statuses = [];
  const failures = [];
  const pendingUsers = [];
  const openedProfileForms = [];
  const savedTurns = [];
  let startedChanges = 0;
  let agentCalls = 0;
  let backendStarts = 0;
  let clearedCheckpoints = 0;
  const dependencies = {
    backend: {
      start: async () => {
        backendStarts += 1;
        return true;
      },
      detail: () => 'Backend unavailable.',
      token: () => 'test-backend-token-that-is-long-enough',
      url: () => 'http://127.0.0.1:8000',
      appendLog: () => undefined
    },
    context: {
      workspace: () => ({ id: 'workspace-a', name: 'Workspace A' }),
      collect: async () => ({
        info: { kind: 'project', label: 'Project', detail: 'Workspace A' },
        apiScope: { type: 'project', workspacePath: 'C:\\workspace', items: [] }
      })
    },
    profiles: {
      active: () => activeProfile,
      reasoningPreferences: () => ({}),
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
        }
      })
    },
    sessions: {
      activeSession: () => session,
      appendUserMessage: async (user) => {
        pendingUsers.push(user);
        session.turns.push({ user, assistant: '' });
        return true;
      },
      modelHistory: () => [],
      appendTurn: async (user, assistant, now, fileChanges) => {
        savedTurns.push({ user, assistant, now, fileChanges });
        return true;
      }
    },
    compaction: {
      compactIfNeeded: async () => ({ kind: 'not-needed', reason: 'too-few-turns' })
    },
    agentRuns: {
      run: async () => {
        agentCalls += 1;
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
      apply: async () => '',
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
    messages,
    statuses,
    failures,
    pendingUsers,
    openedProfileForms,
    savedTurns,
    get startedChanges() {
      return startedChanges;
    },
    get agentCalls() {
      return agentCalls;
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
