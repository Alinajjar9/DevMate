const assert = require('node:assert/strict');
const test = require('node:test');

const { CHAT_MEMORY_CAPABILITY } = require('../out/chatSessionMigration');
const { ChatSessionMirror } = require('../out/chatSessionMirror');

const ACCESS = {
  backendUrl: 'http://127.0.0.1:8000',
  backendToken: 'test-backend-token-that-is-long-enough',
  capabilities: [CHAT_MEMORY_CAPABILITY]
};

test('defers session mirrors until a capable authenticated backend is available', async () => {
  const api = mirrorApi();
  const mirror = new ChatSessionMirror(api);
  mirror.mirror(conversationStore());

  await mirror.flush();
  assert.equal(api.saveCalls.length, 0);

  mirror.setBackendAccess({ ...ACCESS, capabilities: ['chat'] });
  await mirror.flush();
  assert.equal(api.saveCalls.length, 0);

  mirror.setBackendAccess(ACCESS);
  await mirror.flush();
  assert.equal(api.saveCalls.length, 1);
  assert.equal(api.saveCalls[0].access.backendToken, ACCESS.backendToken);
  assert.deepEqual(
    api.saveCalls[0].request.sessions.map((item) => item.session.sessionId),
    ['session-one', 'session-two']
  );
});

test('serializes writes and coalesces intermediate snapshots behind an active save', async () => {
  const firstSave = deferred();
  const api = mirrorApi();
  api.saveImplementation = async (_access, request) => {
    if (request.sessions[0].session.title === 'First session') {
      await firstSave.promise;
    }
    return saveSuccess(request);
  };
  const mirror = new ChatSessionMirror(api);
  mirror.setBackendAccess(ACCESS);
  mirror.mirror(conversationStore());

  const second = conversationStore();
  second.sessions[0].title = 'Intermediate title';
  second.sessions[0].updatedAt = 400;
  mirror.mirror(second);
  const latest = conversationStore();
  latest.sessions[0].title = 'Latest title';
  latest.sessions[0].updatedAt = 500;
  mirror.mirror(latest);
  firstSave.resolve();
  await mirror.flush();

  assert.equal(api.saveCalls.length, 2);
  assert.equal(api.saveCalls[0].request.sessions[0].session.title, 'First session');
  assert.equal(api.saveCalls[1].request.sessions[0].session.title, 'Latest title');
});

test('mirrors a deletion only after saving the surviving session snapshot', async () => {
  const events = [];
  const api = mirrorApi(events);
  const mirror = new ChatSessionMirror(api);
  mirror.setBackendAccess(ACCESS);
  const store = conversationStore();
  store.sessions = store.sessions.filter((session) => session.id !== 'session-two');

  mirror.mirror(store, 'session-two');
  await mirror.flush();

  assert.deepEqual(events, ['save:session-one', 'delete:session-two']);
  assert.deepEqual(api.deleteCalls.map((call) => call.request.sessionId), ['session-two']);
});

test('blocks tight-loop retries after failure and retries on backend readiness', async () => {
  const reports = [];
  const api = mirrorApi();
  api.saveFailure = 'Temporary local storage failure.';
  const mirror = new ChatSessionMirror(api, (message) => reports.push(message));
  mirror.setBackendAccess(ACCESS);
  mirror.mirror(conversationStore());

  await mirror.flush();
  await mirror.flush();
  assert.equal(api.saveCalls.length, 1);
  assert.match(reports.at(-1), /Temporary local storage failure/);

  api.saveFailure = undefined;
  mirror.setBackendAccess(ACCESS);
  await mirror.flush();
  assert.equal(api.saveCalls.length, 2);
});

test('a newer session snapshot remains retryable after an older save fails', async () => {
  const firstSave = deferred();
  const api = mirrorApi();
  api.saveImplementation = async (_access, request) => {
    if (request.sessions[0].session.title === 'First session') {
      await firstSave.promise;
      return { status: 'error', message: 'First save failed.', errorKind: 'http' };
    }
    return saveSuccess(request);
  };
  const mirror = new ChatSessionMirror(api);
  mirror.setBackendAccess(ACCESS);
  mirror.mirror(conversationStore());
  const latest = conversationStore();
  latest.sessions[0].title = 'Latest title';
  latest.sessions[0].updatedAt = 500;
  mirror.mirror(latest);
  firstSave.resolve();

  await mirror.flush();

  assert.equal(api.saveCalls.length, 2);
  assert.equal(api.saveCalls.at(-1).request.sessions[0].session.title, 'Latest title');
});

test('does not resend an unchanged session snapshot after a successful mirror', async () => {
  const api = mirrorApi();
  const mirror = new ChatSessionMirror(api);
  mirror.setBackendAccess(ACCESS);

  mirror.mirror(conversationStore());
  await mirror.flush();
  mirror.mirror(conversationStore());
  await mirror.flush();

  assert.equal(api.saveCalls.length, 1);
});

test('upserts only changed sessions after the initial mirror', async () => {
  const api = mirrorApi();
  const mirror = new ChatSessionMirror(api);
  mirror.setBackendAccess(ACCESS);
  mirror.mirror(conversationStore());
  await mirror.flush();
  const updated = conversationStore();
  updated.sessions[0].title = 'Updated title';
  updated.sessions[0].updatedAt = 500;

  mirror.mirror(updated);
  await mirror.flush();

  assert.equal(api.saveCalls.length, 2);
  assert.deepEqual(
    api.saveCalls[1].request.sessions.map((item) => item.session.sessionId),
    ['session-one']
  );
});

function conversationStore() {
  return {
    version: 2,
    activeSessionId: 'session-one',
    sessions: [
      {
        id: 'session-one',
        title: 'First session',
        workspaceId: 'file:///C:/repo',
        workspaceName: 'repo',
        createdAt: 100,
        updatedAt: 300,
        turns: [{ user: 'Question', assistant: 'Answer' }]
      },
      {
        id: 'session-two',
        title: 'Second session',
        workspaceId: 'file:///C:/other',
        workspaceName: 'other',
        createdAt: 200,
        updatedAt: 250,
        turns: []
      }
    ]
  };
}

function mirrorApi(events = []) {
  const api = {
    saveCalls: [],
    deleteCalls: [],
    saveFailure: undefined,
    saveImplementation: undefined,
    save: async (access, request, signal) => {
      api.saveCalls.push({ access, request: structuredClone(request), signal });
      events.push(`save:${request.sessions.map((item) => item.session.sessionId).join(',')}`);
      if (api.saveImplementation) {
        return api.saveImplementation(access, request, signal);
      }
      return api.saveFailure
        ? { status: 'error', message: api.saveFailure, errorKind: 'http' }
        : saveSuccess(request);
    },
    delete: async (access, request, signal) => {
      api.deleteCalls.push({ access, request, signal });
      events.push(`delete:${request.sessionId}`);
      return { status: 'ok', data: { deleted: true } };
    }
  };
  return api;
}

function saveSuccess(request) {
  return {
    status: 'ok',
    data: {
      savedSessionIds: request.sessions.map((snapshot) => snapshot.session.sessionId)
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
