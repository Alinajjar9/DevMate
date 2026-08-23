const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_EMBEDDING_INDEX_BATCH_SIZE,
  DEFAULT_EMBEDDING_INDEX_CONTINUATION_MS,
  EMBEDDING_INDEX_CAPABILITY,
  EMBEDDING_INDEX_VECTOR_VERSION,
  EmbeddingIndexScheduler
} = require('../out/embeddingIndexScheduler');

const ACCESS = {
  backendUrl: 'http://127.0.0.1:8000',
  backendToken: 'test-backend-token-that-is-long-enough',
  capabilities: ['chat', EMBEDDING_INDEX_CAPABILITY]
};

test('selects one preferred profile and reads only its SecretStorage value', async () => {
  const secretReads = [];
  const calls = [];
  const reports = [];
  const profiles = profileStore([
    profile('local', 'ollama', 'nomic-embed-text', 'http://127.0.0.1:11434'),
    profile(
      'selected',
      'openai-compatible',
      'text-embedding-model',
      'https://embeddings.example.com/v1',
      true
    )
  ], 'selected', async (profileId) => {
    secretReads.push(profileId);
    return 'selected-provider-key';
  });
  const scheduler = new EmbeddingIndexScheduler(
    profiles,
    embeddingApi(async (access, request, providerApiKey, signal) => {
      calls.push({ access, request, providerApiKey, signal });
      return completedResponse(4);
    }),
    (message) => reports.push(message)
  );

  scheduler.setBackendAccess(ACCESS);
  scheduler.scheduleWorkspace('workspace:test');
  await settlePromises();

  assert.deepEqual(secretReads, ['selected']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].access, ACCESS);
  assert.deepEqual(calls[0].request, {
    workspaceKey: 'workspace:test',
    profileId: 'selected',
    provider: 'openai-compatible',
    model: 'text-embedding-model',
    baseUrl: 'https://embeddings.example.com/v1',
    remoteAllowed: true,
    vectorVersion: EMBEDDING_INDEX_VECTOR_VERSION,
    batchSize: DEFAULT_EMBEDDING_INDEX_BATCH_SIZE,
    maxBatches: 1
  });
  assert.equal(calls[0].providerApiKey, 'selected-provider-key');
  assert.equal(calls[0].signal.aborted, false);
  assert.match(reports.at(-1), /Finished after storing 4/);
  scheduler.dispose();
});

test('continues incomplete indexing as separate delayed one-batch requests', async () => {
  const timer = manualTimer();
  const requests = [];
  const scheduler = new EmbeddingIndexScheduler(
    profileStore([localProfile()]),
    embeddingApi(async (_access, request) => {
      requests.push(request);
      return requests.length === 1
        ? incompleteResponse(32)
        : completedResponse(7);
    }),
    () => undefined,
    DEFAULT_EMBEDDING_INDEX_CONTINUATION_MS,
    timer
  );

  scheduler.setBackendAccess(ACCESS);
  scheduler.scheduleWorkspace('workspace:test');
  await settlePromises();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].maxBatches, 1);
  assert.equal(timer.pendingCount(), 1);
  assert.deepEqual(timer.delays(), [DEFAULT_EMBEDDING_INDEX_CONTINUATION_MS]);

  timer.runNext();
  await settlePromises();

  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.maxBatches === 1));
  assert.equal(timer.pendingCount(), 0);
  scheduler.dispose();
});

test('workspace invalidation cancels an active batch and removes continuation work', async () => {
  const pendingResult = deferred();
  const timer = manualTimer();
  let receivedSignal;
  const reports = [];
  const scheduler = new EmbeddingIndexScheduler(
    profileStore([localProfile()]),
    embeddingApi(async (_access, _request, _providerApiKey, signal) => {
      receivedSignal = signal;
      return pendingResult.promise;
    }),
    (message) => reports.push(message),
    250,
    timer
  );

  scheduler.setBackendAccess(ACCESS);
  scheduler.scheduleWorkspace('workspace:test');
  await settlePromises();
  scheduler.invalidateWorkspace();

  assert.equal(receivedSignal.aborted, true);
  pendingResult.resolve({
    status: 'error',
    errorKind: 'cancelled',
    message: 'Request cancelled.'
  });
  await settlePromises();

  assert.equal(timer.pendingCount(), 0);
  assert.deepEqual(reports, []);
  scheduler.dispose();
});

test('a newer workspace run replaces an active stale run', async () => {
  const firstResult = deferred();
  const calls = [];
  const scheduler = new EmbeddingIndexScheduler(
    profileStore([localProfile()]),
    embeddingApi(async (_access, request, _providerApiKey, signal) => {
      calls.push({ request, signal });
      return calls.length === 1 ? firstResult.promise : completedResponse(1);
    })
  );

  scheduler.setBackendAccess(ACCESS);
  scheduler.scheduleWorkspace('workspace:first');
  await settlePromises();
  scheduler.scheduleWorkspace('workspace:second');

  assert.equal(calls[0].signal.aborted, true);
  firstResult.resolve({
    status: 'error',
    errorKind: 'cancelled',
    message: 'Request cancelled.'
  });
  await settlePromises();

  assert.deepEqual(
    calls.map((call) => call.request.workspaceKey),
    ['workspace:first', 'workspace:second']
  );
  assert.equal(calls[1].signal.aborted, false);
  scheduler.dispose();
});

test('backend credential changes cancel work until the ready workspace is scheduled again', async () => {
  const firstResult = deferred();
  const calls = [];
  const scheduler = new EmbeddingIndexScheduler(
    profileStore([localProfile()]),
    embeddingApi(async (access, request, _providerApiKey, signal) => {
      calls.push({ access, request, signal });
      return calls.length === 1 ? firstResult.promise : completedResponse(1);
    })
  );

  scheduler.setBackendAccess(ACCESS);
  scheduler.scheduleWorkspace('workspace:test');
  await settlePromises();
  const replacementAccess = {
    ...ACCESS,
    backendToken: 'replacement-backend-token-that-is-long-enough'
  };
  scheduler.setBackendAccess(replacementAccess);

  assert.equal(calls[0].signal.aborted, true);
  firstResult.resolve({
    status: 'error',
    errorKind: 'cancelled',
    message: 'Request cancelled.'
  });
  await settlePromises();
  assert.equal(calls.length, 1);

  scheduler.scheduleWorkspace('workspace:test');
  await settlePromises();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].access, replacementAccess);
  scheduler.dispose();
});

test('profile refresh reuses the last ready workspace and replaces active work', async () => {
  const firstResult = deferred();
  const calls = [];
  const scheduler = new EmbeddingIndexScheduler(
    profileStore([localProfile()]),
    embeddingApi(async (_access, request, _providerApiKey, signal) => {
      calls.push({ request, signal });
      return calls.length === 1 ? firstResult.promise : completedResponse(1);
    })
  );

  scheduler.setBackendAccess(ACCESS);
  scheduler.scheduleWorkspace('workspace:test');
  await settlePromises();
  scheduler.refreshActiveProfile();

  assert.equal(calls[0].signal.aborted, true);
  firstResult.resolve({
    status: 'error',
    errorKind: 'cancelled',
    message: 'Request cancelled.'
  });
  await settlePromises();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].request.workspaceKey, 'workspace:test');
  scheduler.dispose();
});

test('skips unsupported backends and missing profiles without reading credentials', async () => {
  const reports = [];
  let secretReads = 0;
  let apiCalls = 0;
  const scheduler = new EmbeddingIndexScheduler(
    profileStore([], undefined, async () => {
      secretReads += 1;
      return undefined;
    }),
    embeddingApi(async () => {
      apiCalls += 1;
      return completedResponse(0);
    }),
    (message) => reports.push(message)
  );

  scheduler.setBackendAccess({ ...ACCESS, capabilities: ['chat'] });
  scheduler.scheduleWorkspace('workspace:test');
  await settlePromises();
  scheduler.setBackendAccess(ACCESS);
  scheduler.scheduleWorkspace('workspace:test');
  await settlePromises();

  assert.equal(secretReads, 0);
  assert.equal(apiCalls, 0);
  assert.match(reports[0], /does not support embedding indexing/);
  assert.match(reports[1], /no embedding profile is configured/);
  scheduler.dispose();
});

test('backend failures stop instead of creating a retry loop', async () => {
  const timer = manualTimer();
  const reports = [];
  let apiCalls = 0;
  const scheduler = new EmbeddingIndexScheduler(
    profileStore([localProfile()]),
    embeddingApi(async () => {
      apiCalls += 1;
      return {
        status: 'error',
        errorKind: 'http',
        errorCode: 'provider_unavailable',
        message: 'DevMate could not reach the configured embedding provider.'
      };
    }),
    (message) => reports.push(message),
    250,
    timer
  );

  scheduler.setBackendAccess(ACCESS);
  scheduler.scheduleWorkspace('workspace:test');
  await settlePromises();

  assert.equal(apiCalls, 1);
  assert.equal(timer.pendingCount(), 0);
  assert.match(reports.at(-1), /could not reach/);
  scheduler.dispose();
});

function embeddingApi(synchronize) {
  return { synchronize };
}

function profileStore(profiles, activeProfileId, readSecret = async () => undefined) {
  return {
    readProfiles: () => profiles,
    readActiveProfileId: () => activeProfileId,
    readSecret
  };
}

function localProfile() {
  return profile('local', 'ollama', 'nomic-embed-text', 'http://127.0.0.1:11434');
}

function profile(id, provider, model, baseUrl, remoteAllowed = false) {
  return { id, provider, model, baseUrl, remoteAllowed };
}

function completedResponse(embeddedChunks) {
  return {
    status: 'ok',
    data: {
      configuration: embeddedChunks > 0
        ? {
          profileId: 'local',
          provider: 'ollama',
          model: 'nomic-embed-text',
          dimensions: 768,
          vectorVersion: 1
        }
        : null,
      embeddedChunks,
      processedBatches: embeddedChunks > 0 ? 1 : 0,
      complete: true
    }
  };
}

function incompleteResponse(embeddedChunks) {
  return {
    status: 'ok',
    data: {
      configuration: {
        profileId: 'local',
        provider: 'ollama',
        model: 'nomic-embed-text',
        dimensions: 768,
        vectorVersion: 1
      },
      embeddedChunks,
      processedBatches: 1,
      complete: false
    }
  };
}

function manualTimer() {
  let nextId = 1;
  const tasks = new Map();
  return {
    schedule(callback, delayMilliseconds) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, { callback, delayMilliseconds });
      return id;
    },
    cancel(handle) {
      tasks.delete(handle);
    },
    pendingCount() {
      return tasks.size;
    },
    delays() {
      return [...tasks.values()].map((task) => task.delayMilliseconds);
    },
    runNext() {
      const [entry] = tasks.entries();
      assert.ok(entry);
      const [id, task] = entry;
      tasks.delete(id);
      task.callback();
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function settlePromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
