const assert = require('node:assert/strict');
const test = require('node:test');

const { ask, isLoopbackBackendUrl } = require('../out/api/client');

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
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called');
  };

  try {
    const result = await ask(
      'https://backend.example.com',
      askRequest(),
      'secret-provider-key'
    );

    assert.equal(result.status, 'error');
    assert.match(result.message, /only sends provider API keys/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('sends the provider key in a header to the loopback backend', async () => {
  const originalFetch = global.fetch;
  let receivedHeaders;
  global.fetch = async (_url, init) => {
    receivedHeaders = init.headers;
    return new Response(JSON.stringify({
      status: 'ok',
      data: { answer: 'Real answer', usedFiles: [], changes: [] }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const result = await ask(
      'http://127.0.0.1:8000',
      askRequest(),
      'secret-provider-key'
    );

    assert.equal(result.status, 'ok');
    assert.equal(receivedHeaders['X-DevMate-Provider-Key'], 'secret-provider-key');
  } finally {
    global.fetch = originalFetch;
  }
});

test('surfaces FastAPI provider error details', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(
    JSON.stringify({ detail: 'The model provider rejected the API key.' }),
    {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    }
  );

  try {
    const result = await ask(
      'http://localhost:8000',
      askRequest(),
      'bad-key'
    );

    assert.equal(result.status, 'error');
    assert.equal(result.message, 'The model provider rejected the API key.');
  } finally {
    global.fetch = originalFetch;
  }
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
      temperature: 0.2
    }
  };
}
