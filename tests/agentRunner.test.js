const assert = require('node:assert/strict');
const test = require('node:test');
const { AgentRunner } = require('../out/agentRunner');
const { withoutDelays } = require('./helpers/vscode');
const finalResponse = {
  answer: 'Work completed.',
  usedFiles: [],
  changes: [],
  toolCalls: []
};
const readCall = (id, file = `${id}.ts`) => ({ id, name: 'read_file', arguments: { path: file } });
const toolResponse = calls => ({ ...finalResponse, answer: '', toolCalls: calls });
const ok = data => ({ status: 'ok', data });

function runHarness(responses, overrides = {}) {
  const requests = [];
  const checkpoints = [];
  const executions = [];
  const messages = [];
  const failures = [];
  let restarts = 0;
  let index = 0;
  const events = {
    postMessage: message => messages.push(message),
    postStatus() {},
    postRequestFailure: (message, options) => failures.push({ message, ...options }),
    finishCancelledRequest: signal => signal.aborted,
    saveAgentCheckpoint: async (checkpoint) => checkpoints.push(checkpoint),
    getConversationWorkspace: () => ({ id: 'file:///project', name: 'Project' }),
    getConversationHistory: () => [],
    ensureBackendStarted: async () => {
      restarts += 1;
      return true;
    },
    getBackendUrl: () => 'http://127.0.0.1:8000',
    getWorkspaceFolder: () => ({ name: 'Project', fsPath: 'C:/project' }),
    ...overrides.events
  };
  const toolExecution = (call, result, isError = false) => ({
    step: {
      callId: call.id,
      name: call.name,
      arguments: call.arguments,
      result,
      isError
    },
    usedFiles: [call.arguments.path],
    mutationCharacters: 0
  });
  const tools = {
    enabledAgentTools: () => ['read_file', 'edit_file', 'run_command', 'install_dependencies'],
    postAgentToolActivity() {},
    rejectedToolExecution: (call, result) => toolExecution(call, result, true),
    executeAgentToolCall: async (call, remaining) => {
      executions.push({ call, remaining });
      return toolExecution(call, 'File contents');
    },
    ...overrides.tools
  };
  const transport = {
    ask: async () => assert.fail('Unexpected non-streaming request'),
    askStream: async (url, request, key, timeout, signal) => {
      requests.push({
        url,
        request,
        key,
        timeout
      });
      assert.ok(index < responses.length, 'Runner made an unexpected extra provider call');
      const response = responses[index++];
      return { unsupported: false, result: typeof response === 'function' ? await response(signal) : response };
    },
    ...overrides.transport
  };
  const input = {
    question: 'Inspect the project',
    mode: 'code',
    scopeKind: 'project',
    scope: { type: 'project', items: [] },
    settings: {
      provider: 'ollama',
      model: 'test-model',
      maxTokens: 2048,
      temperature: 0.2,
      timeoutSeconds: 900,
      reasoningEffort: 'auto'
    },
    sessionId: 'session',
    getReasoningEffort: () => 'auto',
    toolCallLimit: 4
  };
  return {
    runner: new AgentRunner(tools, events, transport),
    input,
    requests,
    checkpoints,
    executions,
    messages,
    failures,
    get restarts() {
      return restarts;
    }
  };
}

test('runner stops at the configured call limit, saves each result and requests a final answer', async () => {
  const run = runHarness([
    ok(toolResponse([readCall('one'), readCall('two'), readCall('three'), readCall('four'), readCall('five')])),
    ok(finalResponse)
  ]);
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.equal(run.executions.length, 4);
  assert.equal(result.toolHistory.length, 4);
  assert.equal(run.checkpoints.length, 5);
  assert.deepEqual(run.checkpoints.map(checkpoint => checkpoint.toolHistory.length), [0, 1, 2, 3, 4]);
  assert.equal(run.requests[1].request.forceFinalAnswer, true);
  assert.equal(run.requests[1].request.disableThinking, true);
  assert.deepEqual(run.requests[1].request.enabledTools, []);
  assert.equal(result.response.answer, 'Work completed.');
});

test('runner detects duplicate reads at one revision without executing a third identical call', async () => {
  const run = runHarness([
    ok(toolResponse([readCall('one', 'app.ts'), readCall('two', 'app.ts'), readCall('three', 'app.ts')])),
    ok(finalResponse)
  ]);
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.equal(run.executions.length, 2);
  assert.equal(result.toolHistory[2].isError, true);
  assert.match(result.toolHistory[2].result, /identical tool call/);
  assert.equal(run.requests[1].request.forceFinalAnswer, true);
});

test('runner preserves mutation and attempted-command counters in checkpoints', async () => {
  const edit = {
    id: 'edit',
    name: 'edit_file',
    arguments: { path: 'app.ts', replacements: [{ oldText: 'old', newText: 'new' }] }
  };
  const command = { id: 'command', name: 'run_command', arguments: { executable: 'npm', args: ['test'], cwd: '' } };
  const run = runHarness([ok(toolResponse([edit, command])), ok(finalResponse)], {
    tools: {
      executeAgentToolCall: async (call) => ({
        step: {
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
          result: call.name === 'edit_file' ? 'Applied' : 'Command failed',
          isError: call.name === 'run_command'
        },
        usedFiles: [],
        mutationCharacters: call.name === 'edit_file' ? 50 : 0,
        mutationApplied: call.name === 'edit_file',
        commandAttempted: call.name === 'run_command'
      })
    }
  });
  await run.runner.run(run.input, new AbortController().signal);
  const saved = run.checkpoints.at(-1);
  assert.equal(saved.fileMutationCalls, 1);
  assert.equal(saved.mutationCharacters, 50);
  assert.equal(saved.commandCalls, 1);
  assert.equal(saved.workspaceRevision, 1);
  assert.equal(saved.toolSignatures.length, 2);
});

test('runner stops after cancellation and retains its unfinished checkpoint', async () => {
  const controller = new AbortController();
  const run = runHarness([() => {
    controller.abort();
    return ok(toolResponse([readCall('one')]));
  }]);
  const result = await run.runner.run(run.input, controller.signal);
  assert.equal(result, undefined);
  assert.equal(run.executions.length, 0);
  assert.equal(run.checkpoints.length, 1);
});

test('runner recovers a premature plan once and requests an actual tool response', async () => {
  const run = runHarness([
    ok({ ...finalResponse, answer: 'I will inspect the project first.' }),
    ok(toolResponse([readCall('one')])),
    ok(finalResponse)
  ]);
  await run.runner.run(run.input, new AbortController().signal);
  assert.equal(run.requests.length, 3);
  assert.equal(run.requests[1].request.disableThinking, true);
  assert.equal(run.requests[1].request.forceFinalAnswer, false);
  assert.equal(run.executions.length, 1);
  assert.equal(run.checkpoints[1].emptyResponseRecoveryAttempted, true);
});

test('runner keeps completed tool work when a forced final provider response fails', async () => {
  const run = runHarness([
    ok(toolResponse([readCall('one'), readCall('two'), readCall('three'), readCall('four')])),
    { status: 'error', message: 'Model returned an empty response.', errorKind: 'provider' }
  ]);
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.ok(result);
  assert.equal(result.toolHistory.length, 4);
  assert.match(result.response.answer, /read_file|project tool|tool/i);
  assert.equal(run.failures.length, 0);
});

test('runner refreshes history and reasoning settings between model turns', async () => {
  let reasoning = 'auto';
  let history = [];
  const run = runHarness([
    () => {
      reasoning = 'high';
      history = [{ user: 'Earlier', assistant: 'Answer' }];
      return ok(toolResponse([readCall('one')]));
    },
    ok(finalResponse)
  ], { events: { getConversationHistory: () => history } });
  run.input.getReasoningEffort = () => reasoning;
  await run.runner.run(run.input, new AbortController().signal);
  assert.equal(run.requests[0].request.settings.reasoningEffort, 'auto');
  assert.equal(run.requests[1].request.settings.reasoningEffort, 'high');
  assert.deepEqual(run.requests[1].request.conversationHistory, history);
});

test('provider retries stop after three retries and expose a retryable failure', async () => {
  const busy = {
    status: 'error',
    message: 'Busy',
    errorKind: 'http',
    statusCode: 429
  };
  const run = runHarness([busy, busy, busy, busy]);
  await withoutDelays(() => run.runner.run(run.input, new AbortController().signal));
  assert.equal(run.requests.length, 4);
  assert.equal(run.failures.at(-1).retryable, true);
});

test('cancelling during provider backoff prevents another request', async () => {
  const controller = new AbortController();
  const busy = {
    status: 'error',
    message: 'Busy',
    errorKind: 'http',
    statusCode: 429
  };
  const run = runHarness([busy], {
    events: {
      postStatus: message => {
        if (/retrying/.test(message)) {
          controller.abort();
        }
      }
    }
  });
  const result = await run.runner.run(run.input, controller.signal);
  assert.equal(result, undefined);
  assert.equal(run.requests.length, 1);
});

test('runner falls back to ordinary HTTP when streaming is unsupported', async () => {
  let requests = 0;
  const run = runHarness([], {
    transport: {
      askStream: async () => ({ unsupported: true }),
      ask: async () => {
        requests += 1;
        return ok(finalResponse);
      }
    }
  });
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.equal(requests, 1);
  assert.equal(result.response.answer, finalResponse.answer);
  assert.ok(run.messages.some(message => message.command === 'providerStreamDelta'));
});
