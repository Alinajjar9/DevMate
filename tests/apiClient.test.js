const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const {
  ask,
  askStream,
  DEFAULT_ASK_TIMEOUT_MS,
  isLoopbackBackendUrl
} = require('../out/api/client');

test('keeps the extension timeout above the fifteen-minute provider limit', () => {
  assert.equal(DEFAULT_ASK_TIMEOUT_MS, 930_000);
});

test('recognizes only loopback backend URLs for provider-key handoff', () => {
  assert.equal(isLoopbackBackendUrl('http://127.0.0.1:8000'), true);
  assert.equal(isLoopbackBackendUrl('http://127.10.20.30:8000'), true);
  assert.equal(isLoopbackBackendUrl('http://localhost:8000'), true);
  assert.equal(isLoopbackBackendUrl('http://[::1]:8000'), true);
  assert.equal(isLoopbackBackendUrl('https://backend.example.com'), false);
  assert.equal(isLoopbackBackendUrl('http://user:password@127.0.0.1:8000'), false);
  assert.equal(isLoopbackBackendUrl('http://127.999.0.1:8000'), false);
  assert.equal(isLoopbackBackendUrl('file:///tmp/backend'), false);
  assert.equal(isLoopbackBackendUrl('not a URL'), false);
});

test('refuses to send a provider key to a remote backend', async () => {
  const result = await ask(
    'https://backend.example.com',
    askRequest(),
    'secret-provider-key'
  );

  assert.equal(result.status, 'error');
  assert.match(result.message, /only sends provider API keys/);
});

test('uses the configurable Node HTTP transport and sends the provider key', async () => {
  let receivedHeaders;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('long-running ask must not use fetch');
  };
  try {
    await withServer((request, response) => {
      receivedHeaders = request.headers;
      sendJson(response, 200, {
        status: 'ok',
        data: { answer: 'Real answer', usedFiles: [], changes: [], toolCalls: [] }
      });
    }, async (backendUrl) => {
      const result = await ask(
        backendUrl,
        askRequest(),
        'secret-provider-key',
        10_000
      );

      assert.equal(result.status, 'ok');
      assert.equal(receivedHeaders['x-devmate-provider-key'], 'secret-provider-key');
      assert.equal(receivedHeaders['accept-encoding'], 'identity');
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('surfaces FastAPI provider error details', async () => {
  await withServer((_request, response) => {
    sendJson(response, 401, { detail: 'The model provider rejected the API key.' });
  }, async (backendUrl) => {
    const result = await ask(
      backendUrl,
      askRequest(),
      'bad-key',
      10_000
    );

    assert.equal(result.status, 'error');
    assert.equal(result.message, 'The model provider rejected the API key.');
    assert.equal(result.statusCode, 401);
    assert.equal(result.errorKind, 'http');
  });
});

test('parses progressive backend events and returns the validated final result', async () => {
  const events = [];
  await withServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.write(JSON.stringify({ type: 'start' }) + '\n');
    response.write(JSON.stringify({
      type: 'usage',
      usage: { inputTokens: 120, outputTokens: 0, totalTokens: 120, exact: false }
    }) + '\n');
    response.write(JSON.stringify({ type: 'progress', phase: 'Model is reasoning' }) + '\n');
    response.write(JSON.stringify({ type: 'delta', text: 'Hello ' }) + '\n');
    response.write(JSON.stringify({ type: 'delta', text: 'world' }) + '\n');
    response.end(JSON.stringify({
      type: 'final',
      result: {
        status: 'ok',
        data: { answer: 'Hello world', usedFiles: [], changes: [], toolCalls: [] }
      }
    }) + '\n');
  }, async (backendUrl) => {
    const streamed = await askStream(
      backendUrl,
      askRequest(),
      undefined,
      10_000,
      undefined,
      (event) => events.push(event)
    );

    assert.equal(streamed.unsupported, false);
    assert.equal(streamed.result.status, 'ok');
    assert.equal(streamed.result.data.answer, 'Hello world');
    assert.deepEqual(events, [
      {
        type: 'usage',
        usage: { inputTokens: 120, outputTokens: 0, totalTokens: 120, exact: false }
      },
      { type: 'progress', phase: 'Model is reasoning' },
      { type: 'delta', text: 'Hello ' },
      { type: 'delta', text: 'world' }
    ]);
  });
});

test('marks an older backend stream endpoint as unsupported for fallback', async () => {
  await withServer((_request, response) => {
    sendJson(response, 404, { detail: 'Not Found' });
  }, async (backendUrl) => {
    const streamed = await askStream(backendUrl, askRequest(), undefined, 10_000);
    assert.equal(streamed.unsupported, true);
    assert.equal(streamed.result.statusCode, 404);
  });
});

test('surfaces safe FastAPI validation details from the streaming endpoint', async () => {
  await withServer((_request, response) => {
    sendJson(response, 422, {
      detail: [{
        type: 'value_error',
        loc: ['body', 'toolHistory', 3, 'arguments'],
        msg: 'Value error, tool arguments are too large',
        input: { secret: 'must-not-be-shown' }
      }]
    });
  }, async (backendUrl) => {
    const streamed = await askStream(backendUrl, askRequest(), undefined, 10_000);
    assert.equal(streamed.result.status, 'error');
    assert.equal(streamed.result.statusCode, 422);
    assert.match(streamed.result.message, /toolHistory\.3\.arguments/);
    assert.match(streamed.result.message, /tool arguments are too large/);
    assert.doesNotMatch(streamed.result.message, /must-not-be-shown/);
  });
});

test('preserves streamed provider errors for the existing retry policy', async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.end(JSON.stringify({
      type: 'error',
      message: 'Provider busy',
      statusCode: 429,
      errorKind: 'http'
    }) + '\n');
  }, async (backendUrl) => {
    const streamed = await askStream(backendUrl, askRequest(), undefined, 10_000);
    assert.equal(streamed.result.status, 'error');
    assert.equal(streamed.result.statusCode, 429);
    assert.equal(streamed.result.errorKind, 'http');
  });
});

test('cancels an active streaming backend request', async () => {
  const controller = new AbortController();
  await withServer(() => undefined, async (backendUrl) => {
    const pending = askStream(
      backendUrl,
      askRequest(),
      undefined,
      10_000,
      controller.signal
    );
    controller.abort();
    const streamed = await pending;
    assert.equal(streamed.result.errorKind, 'cancelled');
    assert.equal(streamed.unsupported, false);
  });
});

test('uses DevMate timeout instead of a fixed five-minute header deadline', async () => {
  await withServer(() => undefined, async (backendUrl) => {
    const result = await ask(
      backendUrl,
      askRequest(),
      undefined,
      30
    );

    assert.equal(result.status, 'error');
    assert.match(result.message, /timed out after 0\.03 seconds/);
    assert.equal(result.errorKind, 'timeout');
  });
});

test('cancels an active backend request through an external signal', async () => {
  const controller = new AbortController();
  await withServer(() => undefined, async (backendUrl) => {
    const pending = ask(
      backendUrl,
      askRequest(),
      undefined,
      10_000,
      controller.signal
    );
    controller.abort();

    const result = await pending;
    assert.equal(result.status, 'error');
    assert.equal(result.message, 'Request cancelled.');
    assert.equal(result.errorKind, 'cancelled');
  });
});

test('rejects oversized backend responses before parsing them', async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('x'.repeat(4_000_001));
  }, async (backendUrl) => {
    const result = await ask(backendUrl, askRequest(), undefined, 10_000);
    assert.equal(result.status, 'error');
    assert.equal(result.errorKind, 'invalid-response');
    assert.match(result.message, /oversized response/);
  });
});

function askRequest() {
  return {
    question: 'Hello',
    mode: 'ideas',
    scope: { type: 'project', items: [] },
    settings: {
      provider: 'openai',
      model: 'nvidia/example-model',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      maxTokens: 1200,
      temperature: 0.2,
      timeoutSeconds: 900
    }
  };
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}
