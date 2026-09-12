const assert = require('node:assert/strict');
const test = require('node:test');
const { testModelConfiguration } = require('../out/modelProbe');
const { providerState } = require('./helpers/providerState');

const settings = { provider: 'openai', model: 'test-model', api: 'responses', maxTokens: 16384,
  temperature: 0.2, timeoutSeconds: 900, reasoningEffort: 'high' };
const call = { id: 'probe-call', name: 'read_file', arguments: { path: 'devmate-probe.txt' } };
const answer = (text = '', calls = []) => ({ status: 'ok', data: { answer: text, toolCalls: calls, changes: [], usedFiles: [] } });

test('model probe verifies a synthetic tool round trip and streaming without project context or execution', async () => {
  const requests = [];
  const state = providerState(call.id);
  const result = await testModelConfiguration('http://127.0.0.1:8000', settings, 'test-key', new AbortController().signal, {
    ask: async (_url, request, key) => {
      requests.push(request);
      assert.equal(key, 'test-key');
      return answer('', [{ ...call, providerState: state }]);
    },
    askStream: async (_url, request, _key, timeout, _signal, onEvent) => {
      requests.push(request);
      assert.equal(timeout, 150000);
      assert.deepEqual(request.enabledTools, []);
      assert.deepEqual(request.toolHistory[0].providerState, state);
      const marker = /testMarker: (\S+)/.exec(request.toolHistory[0].result)[1];
      onEvent({ type: 'delta', text: marker });
      return { unsupported: false, result: answer(marker) };
    }
  });
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.scope.items.length === 0 && request.settings.maxTokens === 2048));
  assert.ok(requests.every(request => request.agentEditsEnabled === false));
  assert.deepEqual(requests[0].enabledTools, ['read_file']);
  assert.equal(result.connection, 'Confirmed');
  assert.equal(result.tools, 'Round trip confirmed');
  assert.equal(result.streaming, 'Text events received');
  assert.match(result.reasoning, /accepted \(reasoning itself is not inspected\)/);
  assert.match(result.detail, /No project files or commands/);
});

test('model probe rejects malformed, extra or mutating calls before spending a second request', async () => {
  for (const first of [
    answer('I will inspect it later.'), answer('', [call, { ...call, id: 'second' }]),
    answer('', [{ ...call, arguments: { ...call.arguments, startLine: 0 } }]),
    answer('', [{ ...call, name: 'edit_file' }]),
    { ...answer('', [call]), data: { ...answer('', [call]).data, changes: [{ path: 'file.txt', content: 'forbidden' }] } }
  ]) {
    let calls = 0;
    const result = await testModelConfiguration('http://127.0.0.1:8000', settings, undefined, new AbortController().signal, {
      ask: async () => { calls += 1; return first; },
      askStream: async () => assert.fail('No second request for an invalid first tool call')
    });
    assert.equal(calls, 1);
    assert.equal(result.tools, 'Not confirmed');
    assert.match(result.detail, /No tools were executed/);
  }
});

test('model probe never retries paid failures or claims unsupported streaming worked', async () => {
  let requests = 0;
  const failed = await testModelConfiguration('http://127.0.0.1:8000', settings, undefined, new AbortController().signal, {
    ask: async () => { requests += 1; return { status: 'error', statusCode: 429, message: 'Busy' }; },
    askStream: async () => assert.fail('A failed first request must not trigger another paid call')
  });
  assert.equal(requests, 1);
  assert.equal(failed.connection, 'Not confirmed');
  assert.equal(failed.detail, 'Busy');

  requests = 0;
  const unsupported = await testModelConfiguration('http://127.0.0.1:8000', settings, undefined, new AbortController().signal, {
    ask: async () => { requests += 1; return answer('', [call]); },
    askStream: async () => { requests += 1; return { unsupported: true,
      result: { status: 'error', message: 'Streaming unavailable' } }; }
  });
  assert.equal(requests, 2);
  assert.equal(unsupported.streaming, 'Unavailable on this backend');
  assert.equal(unsupported.tools, 'Not confirmed');
});

test('model probe distinguishes a valid call from actual use of its returned result', async () => {
  const result = await testModelConfiguration('http://127.0.0.1:8000', { ...settings, reasoningEffort: 'auto' },
    undefined, new AbortController().signal, {
      ask: async () => answer('', [call]),
      askStream: async () => ({ unsupported: false, result: answer('Done') })
    });
  assert.equal(result.connection, 'Confirmed');
  assert.equal(result.tools, 'Call accepted; result use not confirmed');
  assert.equal(result.streaming, 'No text events observed');
  assert.equal(result.reasoning, 'Provider default accepted');
});
