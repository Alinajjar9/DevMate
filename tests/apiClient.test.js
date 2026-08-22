const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const {
  applyKnowledgeIndexChanges,
  ask,
  askStream,
  DEFAULT_ASK_TIMEOUT_MS,
  health,
  isLoopbackBackendUrl,
  openKnowledgeIndex,
  searchKnowledgeIndex,
  updateKnowledgeIndexMetadata
} = require('../out/api/client');

const TEST_BACKEND_TOKEN = 'test-backend-token-that-is-long-enough';

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

test('accepts a backend with the expected identity, protocol, and capabilities', async () => {
  let receivedToken;
  await withServer((request, response) => {
    receivedToken = request.headers['x-devmate-backend-token'];
    sendJson(response, 200, compatibleHealthResult());
  }, async (backendUrl) => {
    const result = await health(backendUrl, TEST_BACKEND_TOKEN);

    assert.deepEqual(result, compatibleHealthResult());
    assert.equal(receivedToken, TEST_BACKEND_TOKEN);
  });
});

test('rejects a generic healthy listener that does not identify as DevMate', async () => {
  await withServer((_request, response) => {
    sendJson(response, 200, {
      status: 'ok',
      data: { backend: 'online', version: '1.0.0' }
    });
  }, async (backendUrl) => {
    const result = await health(backendUrl, TEST_BACKEND_TOKEN);

    assert.equal(result.status, 'error');
    assert.equal(result.errorKind, 'invalid-response');
    assert.match(result.message, /compatible DevMate backend/);
  });
});

test('rejects incompatible protocols and missing required capabilities', async (context) => {
  const incompatibleData = [
    {
      ...compatibleHealthResult().data,
      protocolVersion: 3
    },
    {
      ...compatibleHealthResult().data,
      capabilities: ['chat']
    },
    {
      ...compatibleHealthResult().data,
      capabilities: [
        'chat',
        'streaming',
        'request-authentication',
        'strict-response-contracts',
        'streaming'
      ]
    }
  ];

  for (const data of incompatibleData) {
    await context.test(JSON.stringify(data), async () => {
      await withServer((_request, response) => {
        sendJson(response, 200, { status: 'ok', data });
      }, async (backendUrl) => {
        const result = await health(backendUrl, TEST_BACKEND_TOKEN);
        assert.equal(result.status, 'error');
        assert.equal(result.errorKind, 'invalid-response');
      });
    });
  }
});

test('sends authenticated versioned knowledge-index requests and strictly decodes them', async () => {
  const received = [];
  await withServer(async (request, response) => {
    received.push({
      path: request.url,
      token: request.headers['x-devmate-backend-token'],
      body: await readRequestJson(request)
    });
    if (request.url === '/index/v1/workspaces/open') {
      sendJson(response, 200, { status: 'ok', data: knowledgeIndexOpenData() });
      return;
    }
    if (request.url === '/index/v1/files/apply') {
      sendJson(response, 200, {
        status: 'ok',
        data: { upsertedFiles: 1, deletedFiles: 0 }
      });
      return;
    }
    if (request.url === '/index/v1/metadata/update') {
      sendJson(response, 200, { status: 'ok', data: knowledgeIndexMetadata() });
      return;
    }
    sendJson(response, 200, { status: 'ok', data: knowledgeIndexSearchData() });
  }, async (backendUrl) => {
    const opened = await openKnowledgeIndex(
      backendUrl,
      knowledgeIndexOpenRequest(),
      TEST_BACKEND_TOKEN
    );
    const applied = await applyKnowledgeIndexChanges(
      backendUrl,
      knowledgeIndexApplyRequest(),
      TEST_BACKEND_TOKEN
    );
    const metadata = await updateKnowledgeIndexMetadata(
      backendUrl,
      knowledgeIndexMetadataRequest(),
      TEST_BACKEND_TOKEN
    );
    const searched = await searchKnowledgeIndex(
      backendUrl,
      knowledgeIndexSearchRequest(),
      TEST_BACKEND_TOKEN
    );

    assert.deepEqual(opened.data, knowledgeIndexOpenData());
    assert.deepEqual(applied.data, { upsertedFiles: 1, deletedFiles: 0 });
    assert.deepEqual(metadata.data, knowledgeIndexMetadata());
    assert.deepEqual(searched.data, knowledgeIndexSearchData());
  });

  assert.deepEqual(
    received.map((request) => request.path),
    [
      '/index/v1/workspaces/open',
      '/index/v1/files/apply',
      '/index/v1/metadata/update',
      '/index/v1/search'
    ]
  );
  assert.ok(received.every((request) => request.token === TEST_BACKEND_TOKEN));
  assert.deepEqual(received.map((request) => request.body), [
    knowledgeIndexOpenRequest(),
    knowledgeIndexApplyRequest(),
    knowledgeIndexMetadataRequest(),
    knowledgeIndexSearchRequest()
  ]);
});

test('rejects malformed knowledge-index responses field by field', async (context) => {
  const cases = [
    {
      label: 'open response',
      call: (backendUrl) => openKnowledgeIndex(
        backendUrl,
        knowledgeIndexOpenRequest(),
        TEST_BACKEND_TOKEN
      ),
      data: { ...knowledgeIndexOpenData(), unexpected: true }
    },
    {
      label: 'write response',
      call: (backendUrl) => applyKnowledgeIndexChanges(
        backendUrl,
        knowledgeIndexApplyRequest(),
        TEST_BACKEND_TOKEN
      ),
      data: { upsertedFiles: -1, deletedFiles: 0 }
    },
    {
      label: 'metadata response',
      call: (backendUrl) => updateKnowledgeIndexMetadata(
        backendUrl,
        knowledgeIndexMetadataRequest(),
        TEST_BACKEND_TOKEN
      ),
      data: { ...knowledgeIndexMetadata(), indexState: 'unknown' }
    },
    {
      label: 'search response',
      call: (backendUrl) => searchKnowledgeIndex(
        backendUrl,
        knowledgeIndexSearchRequest(),
        TEST_BACKEND_TOKEN
      ),
      data: {
        results: [{ ...knowledgeIndexSearchData().results[0], score: Number.POSITIVE_INFINITY }]
      }
    }
  ];

  for (const item of cases) {
    await context.test(item.label, async () => {
      await withServer((_request, response) => {
        sendJson(response, 200, { status: 'ok', data: item.data });
      }, async (backendUrl) => {
        const result = await item.call(backendUrl);
        assert.equal(result.status, 'error');
        assert.equal(result.errorKind, 'invalid-response');
      });
    });
  }
});

test('refuses to send workspace source to a non-loopback index backend', async () => {
  const result = await applyKnowledgeIndexChanges(
    'https://backend.example.com',
    knowledgeIndexApplyRequest(),
    TEST_BACKEND_TOKEN
  );

  assert.equal(result.status, 'error');
  assert.equal(result.errorKind, 'configuration');
  assert.match(result.message, /backend running on this computer/);
});

test('refuses to send a provider key to a remote backend', async () => {
  const result = await ask(
    'https://backend.example.com',
    askRequest(),
    backendSecrets('secret-provider-key')
  );

  assert.equal(result.status, 'error');
  assert.match(result.message, /only sends provider API keys/);
});

test('refuses to send a request without a valid backend token', async () => {
  let receivedRequest = false;
  await withServer((_request, response) => {
    receivedRequest = true;
    sendJson(response, 200, compatibleHealthResult());
  }, async (backendUrl) => {
    const invalidToken = 'short-secret';
    const result = await ask(
      backendUrl,
      askRequest(),
      { backendToken: invalidToken },
      10_000
    );

    assert.equal(result.status, 'error');
    assert.equal(result.errorKind, 'configuration');
    assert.doesNotMatch(result.message, new RegExp(invalidToken));
    assert.equal(receivedRequest, false);
  });
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
        data: {
          answer: 'Real answer',
          usedFiles: [],
          changes: [],
          toolCalls: [],
          tokenUsage: tokenUsage()
        }
      });
    }, async (backendUrl) => {
      const result = await ask(
        backendUrl,
        askRequest(),
        backendSecrets('secret-provider-key'),
        10_000
      );

      assert.equal(result.status, 'ok');
      assert.equal(receivedHeaders['x-devmate-backend-token'], TEST_BACKEND_TOKEN);
      assert.equal(receivedHeaders['x-devmate-provider-key'], 'secret-provider-key');
      assert.equal(receivedHeaders['accept-encoding'], 'identity');
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects malformed successful ask responses field by field', async (context) => {
  const malformedData = [
    { ...askData(), answer: undefined },
    { ...askData(), usedFiles: 'src/app.ts' },
    { ...askData(), changes: [{ path: 'src/app.ts', content: 42 }] },
    {
      ...askData(),
      toolCalls: [{ id: 'call-1', name: 'unknown_tool', arguments: {} }]
    },
    {
      ...askData(),
      tokenUsage: { inputTokens: -1, outputTokens: 2, totalTokens: 1, exact: true }
    },
    { ...askData(), unexpected: true }
  ];

  for (const data of malformedData) {
    await context.test(JSON.stringify(data), async () => {
      await withServer((_request, response) => {
        sendJson(response, 200, { status: 'ok', data });
      }, async (backendUrl) => {
        const result = await ask(backendUrl, askRequest(), backendSecrets(), 10_000);
        assert.equal(result.status, 'error');
        assert.equal(result.errorKind, 'invalid-response');
      });
    });
  }
});

test('rejects malformed backend error envelopes without echoing them', async () => {
  await withServer((_request, response) => {
    sendJson(response, 502, {
      detail: 'untrusted backend text that should not be surfaced'
    });
  }, async (backendUrl) => {
    const result = await ask(backendUrl, askRequest(), backendSecrets(), 10_000);
    assert.equal(result.status, 'error');
    assert.equal(result.statusCode, 502);
    assert.equal(result.errorKind, 'invalid-response');
    assert.doesNotMatch(result.message, /untrusted backend text/);
  });
});

test('surfaces FastAPI provider error details', async () => {
  await withServer((_request, response) => {
    sendJson(response, 401, backendError(
      'provider_authentication_failed',
      'The model provider rejected the API key.'
    ));
  }, async (backendUrl) => {
    const result = await ask(
      backendUrl,
      askRequest(),
      backendSecrets('bad-key'),
      10_000
    );

    assert.equal(result.status, 'error');
    assert.equal(result.message, 'The model provider rejected the API key.');
    assert.equal(result.statusCode, 401);
    assert.equal(result.errorKind, 'http');
    assert.equal(result.errorCode, 'provider_authentication_failed');
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
        data: {
          answer: 'Hello world',
          usedFiles: [],
          changes: [],
          toolCalls: [],
          tokenUsage: tokenUsage()
        }
      }
    }) + '\n');
  }, async (backendUrl) => {
    const streamed = await askStream(
      backendUrl,
      askRequest(),
      backendSecrets(),
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

test('rejects unknown, out-of-order, and malformed streaming events', async (context) => {
  const eventSequences = [
    [{ type: 'delta', text: 'before start' }],
    [{ type: 'start' }, { type: 'unknown' }],
    [{ type: 'start' }, { type: 'usage', usage: { inputTokens: -1 } }],
    [{
      type: 'start',
    }, {
      type: 'final',
      result: {
        status: 'ok',
        data: { ...askData(), tokenUsage: undefined }
      }
    }]
  ];

  for (const events of eventSequences) {
    await context.test(JSON.stringify(events), async () => {
      await withServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        response.end(events.map((event) => JSON.stringify(event)).join('\n') + '\n');
      }, async (backendUrl) => {
        const streamed = await askStream(
          backendUrl,
          askRequest(),
          backendSecrets(),
          10_000
        );
        assert.equal(streamed.result.status, 'error');
        assert.equal(streamed.result.errorKind, 'invalid-response');
      });
    });
  }
});

test('marks an older backend stream endpoint as unsupported for fallback', async () => {
  await withServer((_request, response) => {
    sendJson(response, 404, { detail: 'Not Found' });
  }, async (backendUrl) => {
    const streamed = await askStream(backendUrl, askRequest(), backendSecrets(), 10_000);
    assert.equal(streamed.unsupported, true);
    assert.equal(streamed.result.statusCode, 404);
  });
});

test('surfaces safe FastAPI validation details from the streaming endpoint', async () => {
  await withServer((_request, response) => {
    sendJson(response, 422, backendError(
      'request_validation_failed',
      'The DevMate request contains invalid fields.',
      [{
        type: 'value_error',
        location: ['body', 'toolHistory', 3, 'arguments'],
        message: 'Value error, tool arguments are too large'
      }]
    ));
  }, async (backendUrl) => {
    const streamed = await askStream(backendUrl, askRequest(), backendSecrets(), 10_000);
    assert.equal(streamed.result.status, 'error');
    assert.equal(streamed.result.statusCode, 422);
    assert.equal(streamed.result.errorCode, 'request_validation_failed');
    assert.match(streamed.result.message, /toolHistory\.3\.arguments/);
    assert.match(streamed.result.message, /tool arguments are too large/);
    assert.doesNotMatch(streamed.result.message, /must-not-be-shown/);
  });
});

test('preserves streamed provider errors for the existing retry policy', async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.write(JSON.stringify({ type: 'start' }) + '\n');
    response.end(JSON.stringify({
      type: 'error',
      message: 'Provider busy',
      statusCode: 429,
      errorKind: 'http',
      errorCode: 'provider_rate_limited'
    }) + '\n');
  }, async (backendUrl) => {
    const streamed = await askStream(backendUrl, askRequest(), backendSecrets(), 10_000);
    assert.equal(streamed.result.status, 'error');
    assert.equal(streamed.result.statusCode, 429);
    assert.equal(streamed.result.errorKind, 'http');
    assert.equal(streamed.result.errorCode, 'provider_rate_limited');
  });
});

test('cancels an active streaming backend request', async () => {
  const controller = new AbortController();
  await withServer(() => undefined, async (backendUrl) => {
    const pending = askStream(
      backendUrl,
      askRequest(),
      backendSecrets(),
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
      backendSecrets(),
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
      backendSecrets(),
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
    const result = await ask(backendUrl, askRequest(), backendSecrets(), 10_000);
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

function compatibleHealthResult() {
  return {
    status: 'ok',
    data: {
      service: 'devmate-backend',
      protocolVersion: 2,
      capabilities: [
        'chat',
        'streaming',
        'request-authentication',
        'strict-response-contracts',
        'knowledge-index-v1'
      ],
      backend: 'online',
      version: '1.0.0'
    }
  };
}

function knowledgeIndexOpenRequest() {
  return {
    workspaceKey: 'workspace-one',
    rootPath: 'C:\\repo',
    chunkingVersion: 1
  };
}

function knowledgeIndexApplyRequest() {
  return {
    workspaceKey: 'workspace-one',
    upserts: [{
      relativePath: 'src/auth.ts',
      languageId: 'typescript',
      contentHash: 'file-hash',
      sizeBytes: 42,
      modifiedAt: 100,
      chunks: [{
        stableId: 'src/auth.ts:1-1',
        ordinal: 0,
        startLine: 1,
        endLine: 1,
        content: 'export const loginToken = true;',
        contentHash: 'chunk-hash',
        chunkingVersion: 1
      }]
    }],
    deletedPaths: []
  };
}

function knowledgeIndexMetadataRequest() {
  return {
    workspaceKey: 'workspace-one',
    chunkingVersion: 1,
    indexState: 'ready',
    lastFullScanAt: '2026-08-22T12:00:00Z'
  };
}

function knowledgeIndexSearchRequest() {
  return { workspaceKey: 'workspace-one', query: 'login token', limit: 5 };
}

function knowledgeIndexMetadata() {
  return {
    workspaceKey: 'workspace-one',
    chunkingVersion: 1,
    indexState: 'ready',
    lastFullScanAt: '2026-08-22T12:00:00Z'
  };
}

function knowledgeIndexOpenData() {
  return {
    workspace: { id: 1, workspaceKey: 'workspace-one', rootPath: 'C:\\repo' },
    metadata: knowledgeIndexMetadata(),
    files: [{
      relativePath: 'src/auth.ts',
      contentHash: 'file-hash',
      sizeBytes: 42,
      modifiedAt: 100
    }]
  };
}

function knowledgeIndexSearchData() {
  return {
    results: [{
      relativePath: 'src/auth.ts',
      languageId: 'typescript',
      stableId: 'src/auth.ts:1-1',
      ordinal: 0,
      startLine: 1,
      endLine: 1,
      content: 'export const loginToken = true;',
      contentHash: 'chunk-hash',
      score: 0.75
    }]
  };
}

function tokenUsage() {
  return { inputTokens: 10, outputTokens: 5, totalTokens: 15, exact: true };
}

function askData() {
  return {
    answer: 'Real answer',
    usedFiles: [],
    changes: [],
    toolCalls: [],
    tokenUsage: tokenUsage()
  };
}

function backendError(errorCode, message, issues = []) {
  return { status: 'error', errorCode, message, issues };
}

function backendSecrets(providerApiKey) {
  return {
    backendToken: TEST_BACKEND_TOKEN,
    ...(providerApiKey ? { providerApiKey } : {})
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

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
