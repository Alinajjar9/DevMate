const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const {
  applyKnowledgeIndexChanges,
  ask,
  askStream,
  compactChatMemorySummary,
  DEFAULT_CHAT_COMPACTION_TIMEOUT_MS,
  deleteChatMemorySession,
  DEFAULT_ASK_TIMEOUT_MS,
  DEFAULT_EMBEDDING_INDEX_TIMEOUT_MS,
  DEFAULT_SEMANTIC_SEARCH_TIMEOUT_MS,
  health,
  isLoopbackBackendUrl,
  listChatMemorySessions,
  loadChatMemorySession,
  loadChatMemorySummary,
  openKnowledgeIndex,
  searchKnowledgeIndex,
  searchKnowledgeIndexSemantically,
  saveChatMemorySessions,
  synchronizeKnowledgeIndexEmbeddings,
  updateKnowledgeIndexMetadata
} = require('../out/api/client');

const TEST_BACKEND_TOKEN = 'test-backend-token-that-is-long-enough';

test('API result types require data on success and a message on failure', () => {
  const ts = require('typescript');
  const fixturePath = path.join(__dirname, 'apiResult.typecheck.ts');
  const source = `
    import type { ApiResult } from '../src/api/types';
    const success: ApiResult<number> = { status: 'ok', data: 42 };
    const failure: ApiResult<number> = { status: 'error', message: 'Request failed.' };
    // @ts-expect-error A successful response cannot omit its payload.
    const missingData: ApiResult<number> = { status: 'ok' };
    // @ts-expect-error A failed response must explain the failure.
    const missingMessage: ApiResult<number> = { status: 'error' };
    // @ts-expect-error A response cannot be both successful and failed.
    const mixed: ApiResult<number> = { status: 'ok', data: 42, errorKind: 'network' };
    function value(result: ApiResult<number>): number {
      return result.status === 'ok' ? result.data : result.message.length;
    }
  `;
  const options = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10
  };
  // Compile an in-memory caller against the real contract; no fixture or build file is written.
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (filename, languageVersion, onError, shouldCreateNewSourceFile) => (
    path.resolve(filename) === fixturePath
      ? ts.createSourceFile(filename, source, languageVersion, true)
      : readSource(filename, languageVersion, onError, shouldCreateNewSourceFile)
  );
  const program = ts.createProgram([fixturePath], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map((diagnostic) => (
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  )), []);
});

test('keeps the extension timeout above the fifteen-minute provider limit', () => {
  assert.equal(DEFAULT_ASK_TIMEOUT_MS, 930_000);
  assert.equal(DEFAULT_CHAT_COMPACTION_TIMEOUT_MS, 930_000);
  assert.equal(DEFAULT_EMBEDDING_INDEX_TIMEOUT_MS, 150_000);
  assert.equal(DEFAULT_SEMANTIC_SEARCH_TIMEOUT_MS, 60_000);
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
      providerKey: request.headers['x-devmate-provider-key'],
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
    if (request.url === '/index/v1/embeddings/synchronize') {
      sendJson(response, 200, {
        status: 'ok',
        data: knowledgeIndexEmbeddingData()
      });
      return;
    }
    if (request.url === '/index/v1/embeddings/search') {
      sendJson(response, 200, {
        status: 'ok',
        data: knowledgeIndexSemanticSearchData()
      });
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
    const embedded = await synchronizeKnowledgeIndexEmbeddings(
      backendUrl,
      knowledgeIndexEmbeddingRequest(),
      backendSecrets('embedding-provider-key')
    );
    const semantic = await searchKnowledgeIndexSemantically(
      backendUrl,
      knowledgeIndexSemanticSearchRequest(),
      backendSecrets('semantic-provider-key')
    );

    assert.deepEqual(opened.data, knowledgeIndexOpenData());
    assert.deepEqual(applied.data, { upsertedFiles: 1, deletedFiles: 0 });
    assert.deepEqual(metadata.data, knowledgeIndexMetadata());
    assert.deepEqual(searched.data, knowledgeIndexSearchData());
    assert.deepEqual(embedded.data, knowledgeIndexEmbeddingData());
    assert.deepEqual(semantic.data, knowledgeIndexSemanticSearchData());
  });

  assert.deepEqual(
    received.map((request) => request.path),
    [
      '/index/v1/workspaces/open',
      '/index/v1/files/apply',
      '/index/v1/metadata/update',
      '/index/v1/search',
      '/index/v1/embeddings/synchronize',
      '/index/v1/embeddings/search'
    ]
  );
  assert.ok(received.every((request) => request.token === TEST_BACKEND_TOKEN));
  assert.deepEqual(
    received.map((request) => request.providerKey),
    [
      undefined,
      undefined,
      undefined,
      undefined,
      'embedding-provider-key',
      'semantic-provider-key'
    ]
  );
  assert.deepEqual(received.map((request) => request.body), [
    knowledgeIndexOpenRequest(),
    knowledgeIndexApplyRequest(),
    knowledgeIndexMetadataRequest(),
    knowledgeIndexSearchRequest(),
    knowledgeIndexEmbeddingRequest(),
    knowledgeIndexSemanticSearchRequest()
  ]);
});

test('sends authenticated versioned chat-memory requests and strictly decodes them', async () => {
  const received = [];
  await withServer(async (request, response) => {
    received.push({
      path: request.url,
      token: request.headers['x-devmate-backend-token'],
      providerKey: request.headers['x-devmate-provider-key'],
      body: await readRequestJson(request)
    });
    if (request.url === '/memory/v1/sessions/save') {
      sendJson(response, 200, {
        status: 'ok',
        data: { savedSessionIds: ['session-one'] }
      });
      return;
    }
    if (request.url === '/memory/v1/sessions/load') {
      sendJson(response, 200, {
        status: 'ok',
        data: { session: chatMemorySnapshot() }
      });
      return;
    }
    if (request.url === '/memory/v1/sessions/list') {
      sendJson(response, 200, {
        status: 'ok',
        data: { sessions: [chatMemorySnapshot().session] }
      });
      return;
    }
    if (request.url === '/memory/v1/summaries/load') {
      sendJson(response, 200, {
        status: 'ok',
        data: { summary: chatMemorySummary() }
      });
      return;
    }
    if (request.url === '/memory/v1/summaries/compact') {
      sendJson(response, 200, {
        status: 'ok',
        data: { summary: chatMemorySummary(), compactedTurns: 1 }
      });
      return;
    }
    sendJson(response, 200, { status: 'ok', data: { deleted: true } });
  }, async (backendUrl) => {
    const saved = await saveChatMemorySessions(
      backendUrl,
      chatMemorySaveRequest(),
      TEST_BACKEND_TOKEN
    );
    const loaded = await loadChatMemorySession(
      backendUrl,
      { sessionId: 'session-one' },
      TEST_BACKEND_TOKEN
    );
    const listed = await listChatMemorySessions(
      backendUrl,
      chatMemoryListRequest(),
      TEST_BACKEND_TOKEN
    );
    const deleted = await deleteChatMemorySession(
      backendUrl,
      { sessionId: 'session-one' },
      TEST_BACKEND_TOKEN
    );
    const summaryLoaded = await loadChatMemorySummary(
      backendUrl,
      { sessionId: 'session-one' },
      TEST_BACKEND_TOKEN
    );
    const compacted = await compactChatMemorySummary(
      backendUrl,
      chatMemoryCompactionRequest(),
      backendSecrets('compaction-provider-key')
    );

    assert.deepEqual(saved.data, { savedSessionIds: ['session-one'] });
    assert.deepEqual(loaded.data, { session: chatMemorySnapshot() });
    assert.deepEqual(listed.data, { sessions: [chatMemorySnapshot().session] });
    assert.deepEqual(deleted.data, { deleted: true });
    assert.deepEqual(summaryLoaded.data, { summary: chatMemorySummary() });
    assert.deepEqual(compacted.data, {
      summary: chatMemorySummary(),
      compactedTurns: 1
    });
  });

  assert.deepEqual(received.map((request) => request.path), [
    '/memory/v1/sessions/save',
    '/memory/v1/sessions/load',
    '/memory/v1/sessions/list',
    '/memory/v1/sessions/delete',
    '/memory/v1/summaries/load',
    '/memory/v1/summaries/compact'
  ]);
  assert.ok(received.every((request) => request.token === TEST_BACKEND_TOKEN));
  assert.deepEqual(received.map((request) => request.body), [
    chatMemorySaveRequest(),
    { sessionId: 'session-one' },
    chatMemoryListRequest(),
    { sessionId: 'session-one' },
    { sessionId: 'session-one' },
    chatMemoryCompactionRequest()
  ]);
  assert.deepEqual(received.map((request) => request.providerKey), [
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    'compaction-provider-key'
  ]);
});

test('rejects malformed or request-mismatched chat-memory responses', async (context) => {
  const cases = [
    {
      call: (backendUrl) => saveChatMemorySessions(
        backendUrl,
        chatMemorySaveRequest(),
        TEST_BACKEND_TOKEN
      ),
      data: { savedSessionIds: ['different-session'] }
    },
    {
      call: (backendUrl) => loadChatMemorySession(
        backendUrl,
        { sessionId: 'session-one' },
        TEST_BACKEND_TOKEN
      ),
      data: {
        session: {
          ...chatMemorySnapshot(),
          turns: [{ ...chatMemorySnapshot().turns[0], ordinal: 1 }]
        }
      }
    },
    {
      call: (backendUrl) => listChatMemorySessions(
        backendUrl,
        chatMemoryListRequest(),
        TEST_BACKEND_TOKEN
      ),
      data: {
        sessions: [{
          ...chatMemorySnapshot().session,
          workspaceIdentity: 'file:///another-workspace'
        }]
      }
    },
    {
      call: (backendUrl) => deleteChatMemorySession(
        backendUrl,
        { sessionId: 'session-one' },
        TEST_BACKEND_TOKEN
      ),
      data: { deleted: true, unexpected: true }
    },
    {
      call: (backendUrl) => loadChatMemorySummary(
        backendUrl,
        { sessionId: 'session-one' },
        TEST_BACKEND_TOKEN
      ),
      data: {
        summary: { ...chatMemorySummary(), sessionId: 'different-session' }
      }
    },
    {
      call: (backendUrl) => loadChatMemorySummary(
        backendUrl,
        { sessionId: 'session-one' },
        TEST_BACKEND_TOKEN
      ),
      data: {
        summary: {
          ...chatMemorySummary(),
          content: { ...chatMemorySummaryContent(), goal: '' }
        }
      }
    },
    {
      call: (backendUrl) => compactChatMemorySummary(
        backendUrl,
        chatMemoryCompactionRequest(),
        backendSecrets('compaction-provider-key')
      ),
      data: {
        summary: { ...chatMemorySummary(), lastCompactedTurn: 1 },
        compactedTurns: 1
      }
    }
  ];

  for (const item of cases) {
    await context.test(JSON.stringify(item.data), async () => {
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

test('accepts an explicit missing chat summary', async () => {
  await withServer((_request, response) => {
    sendJson(response, 200, { status: 'ok', data: { summary: null } });
  }, async (backendUrl) => {
    const result = await loadChatMemorySummary(
      backendUrl,
      { sessionId: 'session-one' },
      TEST_BACKEND_TOKEN
    );

    assert.deepEqual(result, { status: 'ok', data: { summary: null } });
  });
});

test('refuses to send chat history to a non-loopback backend', async () => {
  const result = await saveChatMemorySessions(
    'https://backend.example.com',
    chatMemorySaveRequest(),
    TEST_BACKEND_TOKEN
  );

  assert.equal(result.status, 'error');
  assert.equal(result.errorKind, 'configuration');
  assert.match(result.message, /backend running on this computer/);
});

test('rejects invalid chat-compaction secrets and timeouts before transport', async () => {
  const invalidSecret = await compactChatMemorySummary(
    'http://127.0.0.1:8000',
    chatMemoryCompactionRequest(),
    backendSecrets('invalid\nprovider-key')
  );
  const invalidTimeout = await compactChatMemorySummary(
    'http://127.0.0.1:8000',
    chatMemoryCompactionRequest(),
    backendSecrets('provider-key'),
    0
  );

  assert.equal(invalidSecret.status, 'error');
  assert.equal(invalidSecret.errorKind, 'configuration');
  assert.equal(invalidTimeout.status, 'error');
  assert.equal(invalidTimeout.errorKind, 'configuration');
});

test('memory and index requests share validation while keeping their own messages', async (context) => {
  const clients = [
    {
      name: 'chat memory',
      request: (url, secrets, timeout) => compactChatMemorySummary(
        url, chatMemoryCompactionRequest(), secrets, timeout
      ),
      nonLocalMessage: 'DevMate only sends chat history to a backend running on this computer.',
      invalidKeyMessage: 'The selected provider API key is invalid.',
      invalidTimeoutMessage: 'The chat-memory request timeout is invalid.'
    },
    {
      name: 'knowledge index',
      request: (url, secrets, timeout) => synchronizeKnowledgeIndexEmbeddings(
        url, knowledgeIndexEmbeddingRequest(), secrets, timeout
      ),
      nonLocalMessage: 'DevMate only stores workspace source in a backend running on this computer.',
      invalidKeyMessage: 'The embedding provider API key is invalid.',
      invalidTimeoutMessage: 'The knowledge-index request timeout is invalid.'
    }
  ];
  for (const client of clients) {
    await context.test(client.name, async () => {
      let receivedRequests = 0;
      await withServer((_request, response) => {
        receivedRequests += 1;
        response.end();
      }, async (backendUrl) => {
        for (const providerApiKey of ['', 'secret\nheader', 'secret\rheader']) {
          const result = await client.request(backendUrl, {
            backendToken: TEST_BACKEND_TOKEN,
            providerApiKey
          }, 1_000);
          assert.equal(result.message, client.invalidKeyMessage);
          assert.equal(result.errorKind, 'configuration');
        }
        for (const timeout of [0, -1, NaN, Infinity]) {
          const result = await client.request(backendUrl, backendSecrets(), timeout);
          assert.equal(result.message, client.invalidTimeoutMessage);
          assert.equal(result.errorKind, 'configuration');
        }
        const missingAuthentication = await client.request(
          backendUrl, { backendToken: 'short' }, 1_000
        );
        assert.equal(missingAuthentication.message, 'No authenticated DevMate backend connection is available.');
        assert.equal(receivedRequests, 0);
      });
      const remote = await client.request(
        'https://backend.example.com', backendSecrets(), 1_000
      );
      assert.equal(remote.message, client.nonLocalMessage);
      assert.equal(remote.errorKind, 'configuration');
    });
  }
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

test('rejects malformed or mismatched embedding-index responses', async (context) => {
  const cases = [
    { ...knowledgeIndexEmbeddingData(), unexpected: true },
    {
      ...knowledgeIndexEmbeddingData(),
      configuration: { ...knowledgeIndexEmbeddingData().configuration, provider: 'unknown' }
    },
    {
      ...knowledgeIndexEmbeddingData(),
      configuration: { ...knowledgeIndexEmbeddingData().configuration, dimensions: 0 }
    },
    { ...knowledgeIndexEmbeddingData(), embeddedChunks: 65, processedBatches: 1 },
    { configuration: null, embeddedChunks: 1, processedBatches: 1, complete: true },
    { ...knowledgeIndexEmbeddingData(), embeddedChunks: 0, processedBatches: 0, complete: false },
    {
      ...knowledgeIndexEmbeddingData(),
      configuration: { ...knowledgeIndexEmbeddingData().configuration, model: 'another-model' }
    }
  ];

  for (const data of cases) {
    await context.test(JSON.stringify(data), async () => {
      await withServer((_request, response) => {
        sendJson(response, 200, { status: 'ok', data });
      }, async (backendUrl) => {
        const result = await synchronizeKnowledgeIndexEmbeddings(
          backendUrl,
          knowledgeIndexEmbeddingRequest(),
          backendSecrets('embedding-provider-key')
        );
        assert.equal(result.status, 'error');
        assert.equal(result.errorKind, 'invalid-response');
      });
    });
  }
});

test('rejects malformed, unsorted, or mismatched semantic-search responses', async (context) => {
  const first = knowledgeIndexSemanticSearchData().results[0];
  const cases = [
    { ...knowledgeIndexSemanticSearchData(), unexpected: true },
    { configuration: null, results: [first] },
    { ...knowledgeIndexSemanticSearchData(), results: [{ ...first, score: 1.01 }] },
    {
      ...knowledgeIndexSemanticSearchData(),
      results: [
        { ...first, score: 0.2 },
        { ...first, relativePath: 'src/other.ts', stableId: 'other', score: 0.8 }
      ]
    },
    {
      ...knowledgeIndexSemanticSearchData(),
      configuration: {
        ...knowledgeIndexSemanticSearchData().configuration,
        model: 'another-model'
      }
    }
  ];

  for (const data of cases) {
    await context.test(JSON.stringify(data), async () => {
      await withServer((_request, response) => {
        sendJson(response, 200, { status: 'ok', data });
      }, async (backendUrl) => {
        const result = await searchKnowledgeIndexSemantically(
          backendUrl,
          knowledgeIndexSemanticSearchRequest(),
          backendSecrets('semantic-provider-key')
        );
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

test('refuses to send an embedding request or provider key to a remote index backend', async () => {
  const result = await synchronizeKnowledgeIndexEmbeddings(
    'https://backend.example.com',
    knowledgeIndexEmbeddingRequest(),
    backendSecrets('embedding-provider-key')
  );

  assert.equal(result.status, 'error');
  assert.equal(result.errorKind, 'configuration');
  assert.match(result.message, /backend running on this computer/);
});

test('rejects an invalid embedding provider key before transport', async () => {
  let receivedRequest = false;
  await withServer((_request, response) => {
    receivedRequest = true;
    sendJson(response, 200, { status: 'ok', data: knowledgeIndexEmbeddingData() });
  }, async (backendUrl) => {
    const result = await synchronizeKnowledgeIndexEmbeddings(
      backendUrl,
      knowledgeIndexEmbeddingRequest(),
      backendSecrets('x'.repeat(8_193))
    );

    assert.equal(result.status, 'error');
    assert.equal(result.errorKind, 'configuration');
    assert.equal(receivedRequest, false);
  });
});

test('times out embedding synchronization with its configurable deadline', async () => {
  await withServer(() => undefined, async (backendUrl) => {
    const result = await synchronizeKnowledgeIndexEmbeddings(
      backendUrl,
      knowledgeIndexEmbeddingRequest(),
      backendSecrets(),
      30
    );

    assert.equal(result.status, 'error');
    assert.equal(result.errorKind, 'timeout');
    assert.match(result.message, /timed out after 0\.03 seconds/);
  });
});

test('cancels active embedding synchronization', async () => {
  const controller = new AbortController();
  await withServer(() => undefined, async (backendUrl) => {
    const pending = synchronizeKnowledgeIndexEmbeddings(
      backendUrl,
      knowledgeIndexEmbeddingRequest(),
      backendSecrets(),
      10_000,
      controller.signal
    );
    controller.abort();

    const result = await pending;
    assert.equal(result.status, 'error');
    assert.equal(result.errorKind, 'cancelled');
    assert.equal(result.message, 'Request cancelled.');
  });
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

test('preserves split UTF-8 characters and a final NDJSON line without a newline', async () => {
  const answer = 'Grüße 👋';
  const receivedEvents = [];
  const bytes = Buffer.from([
    JSON.stringify({ type: 'start' }),
    JSON.stringify({ type: 'delta', text: answer }),
    JSON.stringify({ type: 'final', result: { status: 'ok', data: { ...askData(), answer } } })
  ].join('\n'));
  const firstSplit = bytes.indexOf(Buffer.from('ü')) + 1;
  const secondSplit = bytes.indexOf(Buffer.from('👋')) + 2;
  await withServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.write(bytes.subarray(0, firstSplit));
    setImmediate(() => {
      response.write(bytes.subarray(firstSplit, secondSplit));
      setImmediate(() => response.end(bytes.subarray(secondSplit)));
    });
  }, async (backendUrl) => {
    const streamed = await askStream(
      backendUrl, askRequest(), backendSecrets(), 10_000, undefined,
      (event) => receivedEvents.push(event)
    );
    assert.equal(streamed.result.status, 'ok');
    assert.equal(streamed.result.data.answer, answer);
    assert.deepEqual(receivedEvents, [{ type: 'delta', text: answer }]);
  });
});

test('rejects unknown, out-of-order, and malformed streaming events', async (context) => {
  const eventSequences = [
    [{ type: 'delta', text: 'before start' }],
    [{ type: 'start' }, { type: 'start' }],
    [{ type: 'start' }, { type: 'unknown' }],
    [{ type: 'start' }, { type: 'delta', text: 'No completed answer' }],
    [
      { type: 'start' },
      { type: 'final', result: { status: 'ok', data: askData() } },
      { type: 'delta', text: 'Too late' }
    ],
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

test('streaming size limits report invalid responses without enabling fallback', async (context) => {
  const cases = [
    { label: 'answer stream', statusCode: 200, contentType: 'application/x-ndjson', bytes: 4_000_001 },
    { label: 'HTTP error', statusCode: 502, contentType: 'application/json', bytes: 64_001 }
  ];
  for (const item of cases) {
    await context.test(item.label, async () => {
      let receivedRequests = 0;
      await withServer((_request, response) => {
        receivedRequests += 1;
        response.writeHead(item.statusCode, { 'Content-Type': item.contentType });
        response.end('x'.repeat(item.bytes));
      }, async (backendUrl) => {
        const streamed = await askStream(backendUrl, askRequest(), backendSecrets(), 10_000);
        assert.equal(streamed.result.errorKind, 'invalid-response');
        assert.match(streamed.result.message, /oversized/);
        assert.equal(streamed.unsupported, false);
        assert.equal(receivedRequests, 1);
      });
    });
  }
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

function chatMemorySaveRequest() {
  return { sessions: [chatMemorySnapshot()] };
}

function chatMemoryListRequest() {
  return { workspaceIdentity: 'file:///workspace-one', limit: 20 };
}

function chatMemoryCompactionRequest() {
  return {
    sessionId: 'session-one',
    throughTurn: 0,
    settings: {
      provider: 'openai',
      model: 'test-model',
      baseUrl: 'https://example.com/v1',
      maxTokens: 4_000,
      temperature: 0.2,
      reasoningEffort: 'medium',
      timeoutSeconds: 120
    }
  };
}

function chatMemorySummary() {
  return {
    sessionId: 'session-one',
    summaryVersion: 1,
    content: chatMemorySummaryContent(),
    lastCompactedTurn: 0,
    createdAtMs: 300,
    updatedAtMs: 300
  };
}

function chatMemorySummaryContent() {
  return {
    goal: 'Keep useful chat context compact.',
    constraints: ['Keep raw turns.'],
    decisions: [{
      decision: 'Use structured summaries.',
      reason: 'They can be validated before storage.'
    }],
    importantFiles: ['src/context/contextPlanner.ts'],
    completedWork: ['Added SQLite chat storage.'],
    openTasks: ['Generate summaries.'],
    unresolvedQuestions: ['When should compaction run?']
  };
}

function chatMemorySnapshot() {
  return {
    session: {
      sessionId: 'session-one',
      workspaceIdentity: 'file:///workspace-one',
      workspaceName: 'Workspace One',
      title: 'Chat session',
      createdAtMs: 100,
      updatedAtMs: 200
    },
    turns: [{
      ordinal: 0,
      user: 'Update the greeting',
      assistant: 'The greeting was updated.',
      fileChanges: [{
        kind: 'updated',
        path: 'src/app.ts',
        diffId: 'diff-one'
      }]
    }]
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

function knowledgeIndexEmbeddingRequest() {
  return {
    workspaceKey: 'workspace-one',
    profileId: 'local-embedding',
    provider: 'ollama',
    model: 'nomic-embed-text',
    baseUrl: 'http://127.0.0.1:11434',
    remoteAllowed: false,
    vectorVersion: 1,
    batchSize: 32,
    maxBatches: 1
  };
}

function knowledgeIndexEmbeddingData() {
  return {
    configuration: {
      profileId: 'local-embedding',
      provider: 'ollama',
      model: 'nomic-embed-text',
      dimensions: 768,
      vectorVersion: 1
    },
    embeddedChunks: 1,
    processedBatches: 1,
    complete: true
  };
}

function knowledgeIndexSemanticSearchRequest() {
  const profile = knowledgeIndexEmbeddingRequest();
  return {
    workspaceKey: profile.workspaceKey,
    query: 'session credential checks',
    profileId: profile.profileId,
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.baseUrl,
    remoteAllowed: profile.remoteAllowed,
    vectorVersion: profile.vectorVersion,
    limit: 5
  };
}

function knowledgeIndexSemanticSearchData() {
  return {
    configuration: knowledgeIndexEmbeddingData().configuration,
    results: [{
      ...knowledgeIndexSearchData().results[0],
      score: 0.8
    }]
  };
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
