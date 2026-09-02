const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CHAT_MEMORY_CAPABILITY,
  SqliteSessionRepository,
  chatMemorySnapshotsToConversationStore,
  conversationSessionToChatMemorySnapshot
} = require('../out/sessions/sessionRepository');
const { createConversationSessionStore } = require('../out/sessions/sessions');

const ACCESS = {
  backendUrl: 'http://127.0.0.1:8000',
  backendToken: 'test-backend-token-that-is-long-enough',
  capabilities: [CHAT_MEMORY_CAPABILITY]
};
const WORKSPACE = { id: 'file:///C:/repo', name: 'repo' };

test('loads the current workspace list and reconstructs strict ordered sessions', async () => {
  const first = sessionSnapshot('session-one', 300, [{
    user: 'Change the file.',
    assistant: 'Done.',
    fileChanges: [{ kind: 'updated', path: 'src/app.ts', diffId: 'diff-one' }]
  }]);
  const second = sessionSnapshot('session-two', 200, []);
  const api = repositoryApi([first, second]);
  const repository = new SqliteSessionRepository(api);
  repository.setBackendAccess(ACCESS);

  const result = await repository.loadWorkspace(WORKSPACE.id);

  assert.equal(result.kind, 'completed');
  assert.equal(result.value.activeSessionId, 'session-one');
  assert.deepEqual(result.value.sessions.map((session) => session.id), [
    'session-one',
    'session-two'
  ]);
  assert.deepEqual(result.value.sessions[0].turns[0].fileChanges, [{
    kind: 'updated',
    path: 'src/app.ts',
    diffId: 'diff-one'
  }]);
  assert.equal(api.listCalls[0].access.backendToken, ACCESS.backendToken);
  assert.equal(api.listCalls[0].request.workspaceIdentity, WORKSPACE.id);
  assert.deepEqual(api.loadCalls.map((call) => call.request.sessionId), [
    'session-one',
    'session-two'
  ]);
});

test('saves only supplied sessions and deletes directly through SQLite', async () => {
  const store = createConversationSessionStore('session-one', 100, WORKSPACE);
  const api = repositoryApi([]);
  const repository = new SqliteSessionRepository(api);
  repository.setBackendAccess(ACCESS);

  const saved = await repository.saveSessions(store.sessions);
  const deleted = await repository.deleteSession('session-one');

  assert.equal(saved.kind, 'completed');
  assert.equal(deleted.kind, 'completed');
  assert.equal(api.saveCalls.length, 1);
  assert.deepEqual(api.saveCalls[0].request.sessions, [
    conversationSessionToChatMemorySnapshot(store.sessions[0])
  ]);
  assert.deepEqual(api.deleteCalls[0].request, { sessionId: 'session-one' });
});

test('does not call storage without a capable authenticated backend', async () => {
  const api = repositoryApi([]);
  const repository = new SqliteSessionRepository(api);

  const unavailable = await repository.loadWorkspace(WORKSPACE.id);
  repository.setBackendAccess({ ...ACCESS, capabilities: ['chat'] });
  const unsupported = await repository.saveSessions(
    createConversationSessionStore('session-one', 100, WORKSPACE).sessions
  );

  assert.equal(unavailable.kind, 'unavailable');
  assert.equal(unsupported.kind, 'unavailable');
  assert.equal(api.listCalls.length, 0);
  assert.equal(api.saveCalls.length, 0);
});

test('rejects loaded sessions from a different workspace', async () => {
  const snapshot = sessionSnapshot('session-one', 300, []);
  snapshot.session.workspaceIdentity = 'file:///C:/other';
  const api = repositoryApi([snapshot]);
  api.listWorkspaceIdentity = WORKSPACE.id;
  const repository = new SqliteSessionRepository(api);
  repository.setBackendAccess(ACCESS);

  const result = await repository.loadWorkspace(WORKSPACE.id);

  assert.equal(result.kind, 'failed');
  assert.match(result.message, /different workspace/);
});

test('keeps repository failures explicit and retryable', async () => {
  const api = repositoryApi([]);
  api.saveFailure = 'SQLite is busy.';
  const repository = new SqliteSessionRepository(api);
  repository.setBackendAccess(ACCESS);
  const sessions = createConversationSessionStore('session-one', 100, WORKSPACE).sessions;

  const failed = await repository.saveSessions(sessions);
  api.saveFailure = undefined;
  const retried = await repository.saveSessions(sessions);

  assert.deepEqual(failed, { kind: 'failed', message: 'SQLite is busy.' });
  assert.deepEqual(retried, { kind: 'completed', value: undefined });
  assert.equal(api.saveCalls.length, 2);
});

test('round-trips in-memory sessions without legacy storage metadata', () => {
  const store = createConversationSessionStore('session-one', 100, WORKSPACE);
  const snapshots = store.sessions.map(conversationSessionToChatMemorySnapshot);

  const restored = chatMemorySnapshotsToConversationStore(snapshots);

  assert.deepEqual(restored, store);
  assert.deepEqual(chatMemorySnapshotsToConversationStore([]), {
    version: 2,
    activeSessionId: '',
    sessions: []
  });
});

function sessionSnapshot(sessionId, updatedAtMs, turns) {
  return {
    session: {
      sessionId,
      workspaceIdentity: WORKSPACE.id,
      workspaceName: WORKSPACE.name,
      title: `Title ${sessionId}`,
      createdAtMs: 100,
      updatedAtMs
    },
    turns: turns.map((turn, ordinal) => ({
      ordinal,
      user: turn.user,
      assistant: turn.assistant,
      fileChanges: turn.fileChanges ?? []
    }))
  };
}

function repositoryApi(snapshots) {
  const byId = new Map(snapshots.map((snapshot) => [snapshot.session.sessionId, snapshot]));
  const api = {
    listCalls: [],
    loadCalls: [],
    saveCalls: [],
    deleteCalls: [],
    saveFailure: undefined,
    listWorkspaceIdentity: WORKSPACE.id,
    list: async (access, request, signal) => {
      api.listCalls.push({ access, request, signal });
      return {
        status: 'ok',
        data: {
          sessions: snapshots.map((snapshot) => ({
            ...snapshot.session,
            workspaceIdentity: api.listWorkspaceIdentity
          }))
        }
      };
    },
    load: async (access, request, signal) => {
      api.loadCalls.push({ access, request, signal });
      const snapshot = byId.get(request.sessionId);
      return snapshot
        ? { status: 'ok', data: { session: structuredClone(snapshot) } }
        : { status: 'error', message: 'Session not found.', errorKind: 'http' };
    },
    save: async (access, request, signal) => {
      api.saveCalls.push({ access, request: structuredClone(request), signal });
      return api.saveFailure
        ? { status: 'error', message: api.saveFailure, errorKind: 'http' }
        : {
          status: 'ok',
          data: {
            savedSessionIds: request.sessions.map((snapshot) => snapshot.session.sessionId)
          }
        };
    },
    delete: async (access, request, signal) => {
      api.deleteCalls.push({ access, request, signal });
      return { status: 'ok', data: { deleted: true } };
    }
  };
  return api;
}
