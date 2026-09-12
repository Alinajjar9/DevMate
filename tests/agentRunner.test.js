const assert = require('node:assert/strict');
const test = require('node:test');
const { AgentRunner } = require('../out/agentRunner');
const { withoutDelays } = require('./helpers/vscode');
const { providerState } = require('./helpers/providerState');
const { parseAgentRunCheckpoint } = require('../out/sessions');
const { AGENT_TOOL_NAMES, boundedAgentToolHistoryArguments } = require('../out/agentTools');
const { normalizeAgentConfiguration } = require('../out/configuration');
const finalResponse = {
  answer: 'Work completed.',
  usedFiles: [],
  changes: [],
  toolCalls: []
};
const readCall = (id, file = `${id}.ts`) => ({ id, name: 'read_file', arguments: { path: file } });
const toolResponse = calls => ({ ...finalResponse, answer: '', toolCalls: calls });
const ok = data => ({ status: 'ok', data });
const editCall = (id, path = 'app.ts', replacements = [{ oldText: id, newText: '' }]) => ({
  id, name: 'edit_file', arguments: { path, replacements }
});

function failedEditTools(succeeds = () => false) {
  return {
    executeAgentToolCall: async call => {
      const isMutation = ['edit_file', 'create_file', 'delete_file', 'move_file', 'rename_file'].includes(call.name);
      const isError = isMutation && !succeeds(call);
      return {
        step: {
          callId: call.id, name: call.name,
          arguments: boundedAgentToolHistoryArguments(call.name, call.arguments),
          result: isError ? 'Replacement 1 did not match the current file. No changes were applied.' : 'Completed',
          isError
        },
        usedFiles: [], mutationCharacters: isMutation && !isError ? 10 : 0,
        mutationApplied: isMutation && !isError
      };
    }
  };
}

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
    enabledAgentTools: () => [...AGENT_TOOL_NAMES],
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
  assert.equal(run.requests[1].request.agentEditsEnabled, true);
  assert.equal(run.requests[1].request.disableThinking, true);
  assert.deepEqual(run.requests[1].request.enabledTools, []);
  assert.equal(result.response.answer, 'Work completed.');
});

test('runner roundtrips provider output through summarized tool history and a resumed checkpoint', async () => {
  const state = providerState('one');
  const run = runHarness([
    ok(toolResponse([{ ...readCall('one', 'C:/project/app.ts'), providerState: state }])),
    ok(finalResponse)
  ], { tools: {
    executeAgentToolCall: async (call) => ({
      step: { callId: call.id, name: call.name, arguments: { path: 'summary.ts' }, result: 'Done', isError: false },
      usedFiles: [], mutationCharacters: 0
    })
  } });
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.deepEqual(result.toolHistory[0].providerState, state);
  assert.equal(result.toolHistory[0].arguments.path, 'summary.ts');
  assert.deepEqual(run.requests[1].request.toolHistory[0].providerState, state);
  const checkpoint = parseAgentRunCheckpoint(JSON.parse(JSON.stringify(run.checkpoints.at(-1))));
  assert.ok(checkpoint);
  assert.deepEqual(checkpoint.toolHistory[0].providerState, state);
  const resumed = runHarness([ok(finalResponse)]);
  await resumed.runner.run(resumed.input, new AbortController().signal, checkpoint);
  assert.deepEqual(resumed.requests[0].request.toolHistory[0].providerState, state);
  assert.doesNotMatch(JSON.stringify(run.messages), /opaque-encrypted-reasoning/);
});

test('runner retains provider continuation after rejecting a repeated call', async () => {
  const state = providerState('three');
  const run = runHarness([
    ok(toolResponse([readCall('one', 'app.ts'), readCall('two', 'app.ts'), { ...readCall('three', 'app.ts'), providerState: state }])),
    ok(finalResponse)
  ]);
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.equal(result.toolHistory[2].isError, true);
  assert.deepEqual(result.toolHistory[2].providerState, state);
  assert.deepEqual(run.requests[1].request.toolHistory[2].providerState, state);
});

test('runner rejects malformed continuation data before executing its tool', async () => {
  const state = providerState('one');
  state.outputItems[0].encrypted_content = 'x'.repeat(1_000_001);
  const run = runHarness([ok(toolResponse([{ ...readCall('one'), providerState: state }]))]);
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.equal(result, undefined);
  assert.equal(run.executions.length, 0);
  assert.match(run.failures[0].message, /invalid provider continuation/);
});

test('runner stops before executing a tool that would exceed the continuation history budget', async () => {
  const responses = Array.from({ length: 9 }, (_, index) => {
    const id = `call-${index}`;
    const state = providerState(id);
    state.outputItems[0].encrypted_content = 'x'.repeat(900_000);
    return ok(toolResponse([{ ...readCall(id), providerState: state }]));
  });
  const run = runHarness(responses);
  run.input.toolCallLimit = 20;
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.equal(result, undefined);
  assert.equal(run.executions.length, 8);
  assert.equal(run.checkpoints.at(-1).toolHistory.length, 8);
  assert.match(run.failures[0].message, /provider continuation limit/);
});

test('runner keeps repeated-work detection after checkpoint serialization and resume', async () => {
  const edit = { id: 'one', name: 'create_file', arguments: { path: 'app.ts', content: 'export const ready = true;' } };
  const first = runHarness([
    ok(toolResponse([edit])), ok(finalResponse)
  ]);
  await first.runner.run(first.input, new AbortController().signal);
  const checkpoint = parseAgentRunCheckpoint(JSON.parse(JSON.stringify(first.checkpoints.at(-1))));
  assert.ok(checkpoint);
  const resumed = runHarness([ok(toolResponse([{ ...edit, id: 'two' }])), ok(finalResponse)]);
  const result = await resumed.runner.run(resumed.input, new AbortController().signal, checkpoint);
  assert.equal(resumed.executions.length, 0);
  assert.match(result.toolHistory[1].result, /identical tool call/);
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

test('runner stops the third failed edit across intervening reads and discards the rest of its batch', async () => {
  const executed = [];
  const tools = failedEditTools();
  const execute = tools.executeAgentToolCall;
  tools.executeAgentToolCall = async call => {
    executed.push(call.id);
    return execute(call);
  };
  const run = runHarness([
    ok(toolResponse([editCall('first')])),
    ok(toolResponse([readCall('read-one', 'app.ts'), editCall('second')])),
    ok(toolResponse([readCall('read-two', 'app.ts'), editCall('third'), editCall('must-not-run', 'other.ts')])),
    ok({ ...finalResponse, answer: 'The edit remains blocked because its text did not match.' })
  ], { tools });
  run.input.toolCallLimit = 20;
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.deepEqual(executed, ['first', 'read-one', 'second', 'read-two', 'third']);
  assert.equal(result.toolHistory.length, 5);
  assert.match(result.toolHistory.at(-1).result, /3 failed attempts to use edit_file on app.ts/);
  assert.match(result.toolHistory.at(-1).result, /do not claim this operation succeeded/);
  assert.equal(run.requests.at(-1).request.forceFinalAnswer, true);
  assert.deepEqual(run.requests.at(-1).request.enabledTools, []);
  assert.equal(run.checkpoints.at(-1).forceFinalAnswer, true);
});

test('runner counts malformed arguments that cannot produce a tool signature', async () => {
  const run = runHarness([
    ok(toolResponse([editCall('one', 'app.ts', [])])),
    ok(toolResponse([editCall('two', 'app.ts', 'invalid')])),
    ok(toolResponse([editCall('three', 'app.ts', [{ oldText: '', newText: null }])])),
    ok(finalResponse)
  ], { tools: failedEditTools() });
  run.input.toolCallLimit = 20;
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.match(result.toolHistory.at(-1).result, /3 failed attempts/);
  assert.equal(run.requests[2].request.forceFinalAnswer, false);
  assert.equal(run.requests[3].request.forceFinalAnswer, true);
  assert.equal(run.checkpoints.at(-1).toolSignatures.length, 0);
});

test('runner allows corrected edits and resets the file repair budget on success', async () => {
  const run = runHarness([
    ok(toolResponse([editCall('first')])),
    ok(toolResponse([editCall('second')])),
    ok(toolResponse([editCall('repaired')])),
    ok(toolResponse([editCall('next-first')])),
    ok(toolResponse([editCall('next-second')])),
    ok(toolResponse([editCall('next-repaired')])),
    ok(finalResponse)
  ], { tools: failedEditTools(call => call.id.endsWith('repaired')) });
  run.input.toolCallLimit = 20;
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.equal(result.toolHistory.length, 6);
  assert.equal(result.toolHistory[2].isError, false);
  assert.equal(result.toolHistory[5].isError, false);
  assert.ok(run.requests.every(({ request }) => !request.forceFinalAnswer));
});

test('successful work on another file cannot reset the blocked file repair budget', async () => {
  const run = runHarness([
    ok(toolResponse([editCall('first')])),
    ok(toolResponse([editCall('other-file', 'other.ts')])),
    ok(toolResponse([editCall('second')])),
    ok(toolResponse([editCall('third')])),
    ok(finalResponse)
  ], { tools: failedEditTools(call => call.arguments.path === 'other.ts') });
  run.input.toolCallLimit = 20;
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.match(result.toolHistory.at(-1).result, /3 failed attempts/);
  assert.equal(run.checkpoints.at(-1).fileMutationCalls, 1);
  assert.equal(run.requests.at(-1).request.forceFinalAnswer, true);
});

test('failed edits on different files have independent repair budgets', async () => {
  const run = runHarness([
    ok(toolResponse([editCall('app-one'), editCall('other-one', 'other.ts')])),
    ok(toolResponse([editCall('app-two'), editCall('other-two', 'other.ts')])),
    ok(toolResponse([editCall('app-repaired'), editCall('other-repaired', 'other.ts')])),
    ok(finalResponse)
  ], { tools: failedEditTools(call => call.id.endsWith('repaired')) });
  run.input.toolCallLimit = 20;
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.equal(result.toolHistory.length, 6);
  assert.ok(run.requests.every(({ request }) => !request.forceFinalAnswer));
});

test('failed repairs survive checkpoint compaction and resume even with oversized malformed arguments', async () => {
  const oversized = 'not-an-array'.repeat(600);
  const first = runHarness([
    ok(toolResponse([editCall('one', 'app.ts', oversized)])),
    ok(toolResponse([editCall('two', 'app.ts', oversized)])),
    { status: 'error', message: 'Provider unavailable', errorKind: 'provider' }
  ], { tools: failedEditTools() });
  first.input.toolCallLimit = 20;
  await first.runner.run(first.input, new AbortController().signal);
  const checkpoint = parseAgentRunCheckpoint(JSON.parse(JSON.stringify(first.checkpoints.at(-1))));
  assert.ok(checkpoint);
  assert.equal(checkpoint.toolHistory[0].arguments.path, 'app.ts');
  assert.match(checkpoint.toolHistory[0].arguments.summary, /omitted after execution/);
  const resumed = runHarness([
    ok(toolResponse([readCall('read-current', 'app.ts')])),
    ok(toolResponse([editCall('three')])),
    ok(finalResponse)
  ], { tools: failedEditTools() });
  resumed.input.toolCallLimit = 20;
  const result = await resumed.runner.run(resumed.input, new AbortController().signal, checkpoint);
  assert.equal(resumed.requests[1].request.forceFinalAnswer, false);
  assert.equal(resumed.requests[2].request.forceFinalAnswer, true);
  assert.match(result.toolHistory.at(-1).result, /3 failed attempts/);
});

test('permission denial ends the batch before the model can retry through another tool', async () => {
  for (const name of ['edit_file', 'create_file', 'delete_file', 'run_command', 'install_dependencies']) {
    const denied = { id: 'denied', name, arguments: { path: 'app.ts' } };
    const executed = [];
    const run = runHarness([
      ok(toolResponse([denied, editCall('bypass', 'other.ts'), readCall('later')])),
      ok({ ...finalResponse, answer: 'The requested action was denied.' })
    ], { tools: {
      executeAgentToolCall: async call => {
        executed.push(call.id);
        return {
          step: { callId: call.id, name: call.name, arguments: call.arguments,
            result: 'Permission to perform the requested action was denied.', isError: true },
          usedFiles: [], mutationCharacters: 0
        };
      }
    } });
    run.input.toolCallLimit = 20;
    const result = await run.runner.run(run.input, new AbortController().signal);
    assert.deepEqual(executed, ['denied'], name);
    assert.equal(run.requests[1].request.forceFinalAnswer, true, name);
    assert.match(result.toolHistory[0].result, /Stop using tools/);
  }
});

test('existing repeated-call guards also stop the rest of the current tool batch', async () => {
  const run = runHarness([
    ok(toolResponse([readCall('one', 'app.ts'), readCall('two', 'app.ts'), readCall('three', 'app.ts'), editCall('later')])),
    ok(finalResponse)
  ]);
  run.input.toolCallLimit = 20;
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.equal(run.executions.length, 2);
  assert.equal(result.toolHistory.length, 3);
  assert.match(result.toolHistory[2].result, /identical tool call/);
});

test('configured tool selection is enforced at dispatch even if a model calls a disabled tool', async () => {
  const run = runHarness([ok(toolResponse([editCall('forbidden'), readCall('later')])), ok(finalResponse)]);
  run.input.configuration = normalizeAgentConfiguration({ enabledTools: ['read_file'], maxFileEdits: 0 });
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.deepEqual(run.requests[0].request.enabledTools, ['read_file']);
  assert.equal(run.requests[0].request.agentEditsEnabled, true);
  assert.equal(run.executions.length, 0);
  assert.match(result.toolHistory[0].result, /disabled by the current mode, configuration or remaining budget/);
  assert.equal(run.requests[1].request.forceFinalAnswer, true);
});

test('Code and Debug stay in agent response mode when every project tool is disabled', async () => {
  for (const mode of ['code', 'debug']) {
    const run = runHarness([ok(finalResponse)]);
    run.input.mode = mode;
    run.input.configuration = normalizeAgentConfiguration({ enabledTools: [], maxFileEdits: 0, maxCommands: 0 });
    const result = await run.runner.run(run.input, new AbortController().signal);
    assert.deepEqual(run.requests[0].request.enabledTools, []);
    assert.equal(run.requests[0].request.agentEditsEnabled, true);
    assert.equal(result.response.answer, 'Work completed.');
    assert.equal(run.executions.length, 0);
  }
});

test('runner rejects full-file proposals in read-only Code configuration', async () => {
  const run = runHarness([ok({ ...finalResponse, changes: [{ path: 'app.ts', content: 'forbidden' }] })]);
  run.input.configuration = normalizeAgentConfiguration({ enabledTools: ['read_file'], maxFileEdits: 0 });
  assert.equal(await run.runner.run(run.input, new AbortController().signal), undefined);
  assert.equal(run.executions.length, 0);
  assert.match(run.failures[0].message, /unexpected full-file changes.*No proposed changes were applied/);
});

test('a forced summary cannot add file proposals after a tool limit or failed repair', async () => {
  const unwantedChanges = ok({ ...finalResponse, changes: [{ path: 'extra.ts', content: 'must not be applied' }] });
  const atToolLimit = runHarness([
    ok(toolResponse([readCall('one'), readCall('two'), readCall('three'), readCall('four')])), unwantedChanges
  ]);
  assert.equal(await atToolLimit.runner.run(atToolLimit.input, new AbortController().signal), undefined);
  assert.equal(atToolLimit.executions.length, 4);
  assert.equal(atToolLimit.requests[1].request.forceFinalAnswer, true);
  assert.equal(atToolLimit.requests[1].request.agentEditsEnabled, true);
  assert.match(atToolLimit.failures[0].message, /No proposed changes were applied/);

  const afterRepair = runHarness([ok(toolResponse([editCall('failed')])), unwantedChanges], { tools: failedEditTools() });
  afterRepair.input.configuration = normalizeAgentConfiguration({ maxRepairAttempts: 1 });
  assert.equal(await afterRepair.runner.run(afterRepair.input, new AbortController().signal), undefined);
  assert.equal(afterRepair.requests[1].request.forceFinalAnswer, true);
  assert.equal(afterRepair.requests[1].request.agentEditsEnabled, true);
  assert.equal(afterRepair.checkpoints.at(-1).fileMutationCalls, 0);
  assert.match(afterRepair.failures[0].message, /No proposed changes were applied/);
});

test('configuration changes model settings, context length, command timeout and repair limit', async () => {
  const calls = [];
  const editTools = failedEditTools();
  const run = runHarness([
    ok(toolResponse([{ id: 'command', name: 'run_command', arguments: { executable: 'npm', args: ['test'], cwd: '', timeoutSeconds: 900 } }])),
    ok(toolResponse([editCall('one')])), ok(toolResponse([editCall('two')])), ok(finalResponse)
  ], { tools: { executeAgentToolCall: async call => { calls.push(call); return editTools.executeAgentToolCall(call); } } });
  run.input.configuration = normalizeAgentConfiguration({ maxTokens: 1024, temperature: 0.6,
    timeoutSeconds: 120, commandTimeoutSeconds: 60, contextCharacters: 1000, maxRepairAttempts: 2,
    instructions: 'Preserve the public interface.' });
  run.input.scope.items = [{ source: 'file', filePath: 'app.ts', languageId: 'typescript',
    content: 'x'.repeat(3000), includedCharacters: 3000, totalCharacters: 3000, truncated: false }];
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.equal(run.requests[0].request.settings.maxTokens, 1024);
  assert.equal(run.requests[0].request.settings.temperature, 0.6);
  assert.equal(run.requests[0].timeout, 150000);
  assert.equal(run.requests[0].request.instructions, 'Preserve the public interface.');
  assert.equal(run.requests[0].request.scope.items[0].includedCharacters, 1000);
  assert.equal(run.requests[0].request.scope.items[0].truncated, true);
  assert.equal(calls[0].arguments.timeoutSeconds, 60);
  assert.match(result.toolHistory.at(-1).result, /2 failed attempts/);
});

test('configured mutation limits can exceed the old default and still stop excess calls', async () => {
  const executed = [];
  const tools = failedEditTools(() => true);
  const execute = tools.executeAgentToolCall;
  tools.executeAgentToolCall = async call => { executed.push(call.id); return execute(call); };
  const run = runHarness([ok(toolResponse(Array.from({ length: 9 }, (_, index) => editCall(`edit-${index}`)))), ok(finalResponse)], { tools });
  run.input.configuration = normalizeAgentConfiguration({ maxFileEdits: 8, maxCommands: 0, toolCallLimit: 20 });
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.equal(executed.length, 8);
  assert.equal(run.requests[0].request.enabledTools.includes('run_command'), false);
  assert.match(result.toolHistory[8].result, /disabled by the current mode, configuration or remaining budget/);
  const checkpoint = parseAgentRunCheckpoint(JSON.parse(JSON.stringify(run.checkpoints.at(-1))));
  assert.equal(checkpoint.fileMutationCalls, 8);
});

test('run token budget ends locally before another paid model request and preserves completed tools', async () => {
  const run = runHarness([ok({ ...toolResponse([readCall('one')]), tokenUsage: {
    inputTokens: 4500, outputTokens: 600, totalTokens: 5100, exact: true
  } })]);
  run.input.configuration = normalizeAgentConfiguration({ runTokenBudget: 5000 });
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.equal(run.requests.length, 1);
  assert.equal(result.toolHistory.length, 1);
  assert.match(result.response.answer, /run token budget/i);
  assert.equal(run.checkpoints.at(-1).forceFinalAnswer, true);
  assert.equal(run.checkpoints.at(-1).totalTokens, 5100);
});

test('a token budget below estimated request overhead stops before the first provider call', async () => {
  const run = runHarness([]);
  run.input.configuration = normalizeAgentConfiguration({ runTokenBudget: 1000 });
  const result = await run.runner.run(run.input, new AbortController().signal);
  assert.equal(run.requests.length, 0);
  assert.match(result.response.answer, /budget leaves too little room for another model request/);
  assert.equal(run.checkpoints.at(-1).totalTokens, 0);
});

test('configured run settings and instructions survive checkpoint resume and history compaction', async () => {
  const first = runHarness([ok(toolResponse([readCall('one')])), ok(finalResponse)], { tools: {
    executeAgentToolCall: async call => ({ step: { callId: call.id, name: call.name,
      arguments: call.arguments, result: 'x'.repeat(9500), isError: false }, usedFiles: [], mutationCharacters: 0 })
  } });
  first.input.configuration = normalizeAgentConfiguration({ maxTokens: 777, maxCommands: 0,
    historyCharacters: 10000, instructions: 'Keep this instruction after resuming.' });
  await first.runner.run(first.input, new AbortController().signal);
  const checkpoint = parseAgentRunCheckpoint(JSON.parse(JSON.stringify(first.checkpoints.at(-1))));
  assert.ok(checkpoint);
  const resumed = runHarness([ok(toolResponse([readCall('two')])), ok(finalResponse)], { tools: {
    executeAgentToolCall: async call => ({ step: { callId: call.id, name: call.name,
      arguments: call.arguments, result: 'y'.repeat(9500), isError: false }, usedFiles: [], mutationCharacters: 0 })
  } });
  resumed.input.configuration = normalizeAgentConfiguration({ maxTokens: 888, maxCommands: 5 });
  await resumed.runner.run(resumed.input, new AbortController().signal, checkpoint);
  assert.equal(resumed.requests[0].request.settings.maxTokens, 777);
  assert.equal(resumed.requests[0].request.instructions, 'Keep this instruction after resuming.');
  assert.equal(resumed.requests[0].request.enabledTools.includes('run_command'), false);
  assert.ok(resumed.requests[1].request.toolHistory.reduce((sum, step) => sum + step.result.length, 0) <= 10000);
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
