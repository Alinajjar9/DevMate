const assert = require('node:assert/strict');
const test = require('node:test');
const { withVscodeMock } = require('./helpers/withVscodeMock');
const { AgentRunController } = withVscodeMock({ workspace: {} }, () => require('../out/agent/agentRunController'));

function input(overrides = {}) {
  return {
    question: 'Fix the code', mode: 'code', scopeKind: 'project',
    scope: { type: 'project', items: [] }, conversationHistory: [],
    settings: {
      provider: 'ollama', model: 'test-model', baseUrl: 'http://127.0.0.1:11434/v1',
      maxTokens: 2048, temperature: 0.2, reasoningEffort: 'auto', timeoutSeconds: 900
    },
    backendUrl: 'http://127.0.0.1:8000', backendToken: 'test-token-long-enough-for-the-backend',
    workspaceId: 'workspace', sessionId: 'session', toolCallLimit: 16,
    ...overrides
  };
}

function reply(toolCalls = []) {
  return { status: 'ok', data: { answer: 'Done.', usedFiles: [], changes: [], toolCalls } };
}

function read(id) {
  return { id, name: 'read_file', arguments: { path: 'src/app.ts' } };
}

function execution(call, metadata = {}) {
  return {
    step: { callId: call.id, name: call.name, arguments: call.arguments, result: 'Tool finished.', isError: false },
    usedFiles: [], mutationCharacters: 0, ...metadata
  };
}

function fixture(replies, execute = async (call) => execution(call), emit = () => undefined) {
  const requests = [];
  const checkpoints = [];
  const calls = [];
  const controller = new AgentRunController({
    execute: async (call, context) => {
      calls.push(call);
      return execute(call, context);
    }
  }, {
    saveCheckpoint: async (value) => checkpoints.push(structuredClone(value)),
    recoverBackend: async () => true,
    emit
  }, {
    ask: async () => assert.fail('Unexpected streaming fallback'),
    askStream: async (_url, request) => {
      requests.push(structuredClone(request));
      const result = replies.shift();
      assert.ok(result, 'Agent requested more replies than the scenario allows');
      return { unsupported: false, result };
    },
    waitForRetryDelay: async () => assert.fail('Unexpected provider retry')
  });
  return { controller, requests, checkpoints, calls };
}

test('dependency denial forces a final answer without depending on its English text', async () => {
  const install = { id: 'install', name: 'install_dependencies', arguments: { manifestPath: 'requirements.txt' } };
  const state = fixture([reply([install]), reply()], async (call) => execution(call, {
    permissionDenied: true,
    step: { callId: call.id, name: call.name, arguments: call.arguments, result: 'Approval declined.', isError: true }
  }));
  const outcome = await state.controller.run(input(), new AbortController().signal);
  assert.equal(outcome.kind, 'completed');
  assert.equal(state.requests[1].forceFinalAnswer, true);
  assert.deepEqual(state.requests[1].enabledTools, []);
  assert.equal(state.checkpoints.at(-1).dependencyInstallCalls, 0);
});

test('the third identical read is rejected until the workspace changes', async () => {
  const state = fixture([reply([read('one'), read('two'), read('three')]), reply()]);
  const outcome = await state.controller.run(input(), new AbortController().signal);
  assert.equal(outcome.kind, 'completed');
  assert.deepEqual(state.calls.map((call) => call.id), ['one', 'two']);
  assert.equal(outcome.toolHistory[2].isError, true);
  assert.match(outcome.toolHistory[2].result, /already completed/);
  assert.equal(state.requests[1].forceFinalAnswer, true);
});

test('an actual mutation allows a fresh inspection and spends only the applied mutation budget', async () => {
  const edit = { id: 'edit', name: 'edit_file', arguments: { path: 'src/app.ts', replacements: [] } };
  const state = fixture([reply([read('one'), read('two'), edit, read('three')]), reply()], async (call) => {
    return execution(call, call.name === 'edit_file' ? { mutationApplied: true, mutationCharacters: 7 } : {});
  });
  const outcome = await state.controller.run(input(), new AbortController().signal);
  assert.equal(outcome.kind, 'completed');
  assert.equal(state.calls.length, 4);
  assert.equal(state.checkpoints.at(-1).fileMutationCalls, 1);
  assert.equal(state.checkpoints.at(-1).mutationCharacters, 7);
  assert.equal(state.checkpoints.at(-1).workspaceRevision, 1);
});

test('reusing a tool-call ID fails before executing that call twice', async () => {
  const state = fixture([reply([read('same'), read('same')])]);
  const outcome = await state.controller.run(input(), new AbortController().signal);
  assert.equal(outcome.kind, 'failed');
  assert.match(outcome.message, /tool-call id/);
  assert.equal(state.calls.length, 1);
});

test('empty-answer recovery changes flags in two bounded steps and checkpoints both', async () => {
  const empty = { status: 'error', errorKind: 'http', message: 'The model returned an empty final answer.' };
  const state = fixture([empty, empty, reply()]);
  const outcome = await state.controller.run(input(), new AbortController().signal);
  assert.equal(outcome.kind, 'completed');
  assert.deepEqual(state.requests.map((request) => [request.disableThinking, request.forceFinalAnswer]), [
    [false, false], [true, false], [true, true]
  ]);
  assert.deepEqual(state.checkpoints.map((checkpoint) => [checkpoint.disableThinking, checkpoint.forceFinalAnswer]), [
    [false, false], [true, false], [true, true]
  ]);
});

test('a pre-cancelled run saves its initial checkpoint but never contacts the provider', async () => {
  const state = fixture([]);
  const cancellation = new AbortController();
  cancellation.abort();
  assert.deepEqual(await state.controller.run(input(), cancellation.signal), { kind: 'cancelled' });
  assert.equal(state.checkpoints.length, 1);
  assert.equal(state.requests.length, 0);
});

test('cancellation during response handling prevents the next tool from starting', async () => {
  const cancellation = new AbortController();
  const response = reply([read('not-started')]);
  response.data.tokenUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, exact: true };
  const state = fixture([response], undefined, (event) => {
    if (event.type === 'token-usage') queueMicrotask(() => cancellation.abort());
  });

  assert.deepEqual(await state.controller.run(input(), cancellation.signal), { kind: 'cancelled' });
  assert.equal(state.calls.length, 0);
  assert.equal(state.checkpoints.length, 1);
});

test('a reused controller starts each run with separate tool history and counters', async () => {
  const state = fixture([reply([read('one')]), reply(), reply()]);
  const first = await state.controller.run(input(), new AbortController().signal);
  const second = await state.controller.run(input({ sessionId: 'other-session' }), new AbortController().signal);
  assert.equal(first.toolHistory.length, 1);
  assert.equal(second.toolHistory.length, 0);
  assert.deepEqual(state.requests[2].toolHistory, []);
  assert.equal(state.checkpoints.at(-1).sessionId, 'other-session');
  assert.equal(state.checkpoints.at(-1).workspaceRevision, 0);
});
