const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CHAT_MEMORY_CAPABILITY,
  ChatSessionMigration,
  conversationStoreToChatMemorySnapshots,
  fingerprintChatMemorySnapshots,
  parseChatSessionMigrationMarker
} = require('../out/chatSessionMigration');

const ACCESS = {
  backendUrl: 'http://127.0.0.1:8000',
  backendToken: 'test-backend-token-that-is-long-enough'
};

test('converts validated VS Code sessions into ordered chat-memory snapshots', () => {
  const store = conversationStore();

  const snapshots = conversationStoreToChatMemorySnapshots(store);

  assert.deepEqual(snapshots, [
    {
      session: {
        sessionId: 'session-one',
        workspaceIdentity: 'file:///C:/repo',
        workspaceName: 'repo',
        title: 'First session',
        createdAtMs: 100,
        updatedAtMs: 300
      },
      turns: [
        {
          ordinal: 0,
          user: 'Change the file.',
          assistant: 'Done.',
          fileChanges: [{
            kind: 'renamed',
            path: 'src/new.ts',
            previousPath: 'src/old.ts',
            diffId: 'diff-one'
          }]
        },
        {
          ordinal: 1,
          user: 'What remains?',
          assistant: '',
          fileChanges: []
        }
      ]
    },
    {
      session: {
        sessionId: 'session-two',
        workspaceIdentity: 'file:///C:/other',
        workspaceName: 'other',
        title: 'Second session',
        createdAtMs: 200,
        updatedAtMs: 250
      },
      turns: []
    }
  ]);
});

test('copies every legacy session in one batch and verifies each saved snapshot', async () => {
  const store = conversationStore();
  const originalStore = JSON.stringify(store);
  const api = memoryApi();
  const state = markerState();
  const reports = [];
  const migration = new ChatSessionMigration(
    { read: () => store },
    state,
    api,
    (message) => reports.push(message),
    () => 500
  );

  const result = await migration.synchronize(ACCESS, [CHAT_MEMORY_CAPABILITY]);

  assert.deepEqual(result, { kind: 'completed', migratedSessions: 2 });
  assert.equal(api.saveCalls.length, 1);
  assert.equal(api.saveCalls[0].access, ACCESS);
  assert.equal(api.saveCalls[0].request.sessions.length, 2);
  assert.deepEqual(api.loadCalls.map((call) => call.request.sessionId), [
    'session-one',
    'session-two'
  ]);
  assert.equal(state.writes.length, 1);
  assert.deepEqual(state.writes[0], {
    version: 1,
    sourceFingerprint: fingerprintChatMemorySnapshots(api.saveCalls[0].request.sessions),
    sessionIds: ['session-one', 'session-two'],
    completedAtMs: 500
  });
  assert.equal(JSON.stringify(store), originalStore);
  assert.match(reports.at(-1), /verified 2 saved sessions/);
});

test('rechecks a completed migration without rewriting an intact database copy', async () => {
  const api = memoryApi();
  const state = markerState();
  const migration = new ChatSessionMigration(
    { read: conversationStore },
    state,
    api,
    undefined,
    () => 500
  );
  await migration.synchronize(ACCESS, [CHAT_MEMORY_CAPABILITY]);

  const result = await migration.synchronize(ACCESS, [CHAT_MEMORY_CAPABILITY]);

  assert.deepEqual(result, { kind: 'skipped', reason: 'up-to-date' });
  assert.equal(api.saveCalls.length, 1);
  assert.equal(api.loadCalls.length, 4);
  assert.equal(state.writes.length, 1);
});

test('refreshes a marked migration when its local database copy is missing', async () => {
  const api = memoryApi();
  const state = markerState();
  const migration = new ChatSessionMigration(
    { read: conversationStore },
    state,
    api,
    undefined,
    () => 500
  );
  await migration.synchronize(ACCESS, [CHAT_MEMORY_CAPABILITY]);
  api.snapshots.clear();

  const result = await migration.synchronize(ACCESS, [CHAT_MEMORY_CAPABILITY]);

  assert.deepEqual(result, { kind: 'completed', migratedSessions: 2 });
  assert.equal(api.saveCalls.length, 2);
  assert.equal(state.writes.length, 2);
});

test('does not mark a migration complete when saving or read-back verification fails', async (context) => {
  const cases = [
    {
      name: 'save failure',
      configure(api) {
        api.saveFailure = 'The batch was rejected.';
      },
      expected: 'The batch was rejected.'
    },
    {
      name: 'mismatched copy',
      configure(api) {
        api.changeLoadedSnapshot = (snapshot) => ({
          ...snapshot,
          turns: snapshot.turns.map((turn, index) => index === 0
            ? { ...turn, assistant: 'Different answer.' }
            : turn)
        });
      },
      expected: 'incomplete chat migration copy'
    }
  ];

  for (const migrationCase of cases) {
    await context.test(migrationCase.name, async () => {
      const api = memoryApi();
      const state = markerState();
      migrationCase.configure(api);
      const migration = new ChatSessionMigration(
        { read: conversationStore },
        state,
        api
      );

      const result = await migration.synchronize(ACCESS, [CHAT_MEMORY_CAPABILITY]);

      assert.equal(result.kind, 'failed');
      assert.match(result.message, new RegExp(migrationCase.expected));
      assert.equal(state.writes.length, 0);
    });
  }
});

test('a failed migration remains retryable and keeps the legacy source untouched', async () => {
  const store = conversationStore();
  const originalStore = JSON.stringify(store);
  const api = memoryApi();
  const state = markerState();
  api.saveFailure = 'Temporary failure.';
  const migration = new ChatSessionMigration(
    { read: () => store },
    state,
    api
  );

  const failed = await migration.synchronize(ACCESS, [CHAT_MEMORY_CAPABILITY]);
  api.saveFailure = undefined;
  const completed = await migration.synchronize(ACCESS, [CHAT_MEMORY_CAPABILITY]);

  assert.equal(failed.kind, 'failed');
  assert.deepEqual(completed, { kind: 'completed', migratedSessions: 2 });
  assert.equal(api.saveCalls.length, 2);
  assert.equal(state.writes.length, 1);
  assert.equal(JSON.stringify(store), originalStore);
});

test('skips migration without reading chats when the backend lacks the capability', async () => {
  let sourceReads = 0;
  const api = memoryApi();
  const migration = new ChatSessionMigration(
    {
      read: () => {
        sourceReads += 1;
        return conversationStore();
      }
    },
    markerState(),
    api
  );

  const result = await migration.synchronize(ACCESS, ['chat']);

  assert.deepEqual(result, { kind: 'skipped', reason: 'unsupported-backend' });
  assert.equal(sourceReads, 0);
  assert.equal(api.saveCalls.length, 0);
});

test('strictly parses only current, bounded migration markers', () => {
  const marker = {
    version: 1,
    sourceFingerprint: 'a'.repeat(64),
    sessionIds: ['session-one'],
    completedAtMs: 500
  };

  assert.deepEqual(parseChatSessionMigrationMarker(marker), marker);
  assert.equal(parseChatSessionMigrationMarker({ ...marker, version: 2 }), undefined);
  assert.equal(parseChatSessionMigrationMarker({
    ...marker,
    sessionIds: ['session-one', 'session-one']
  }), undefined);
  assert.equal(parseChatSessionMigrationMarker({
    ...marker,
    unexpected: true
  }), undefined);
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
        turns: [
          {
            user: 'Change the file.',
            assistant: 'Done.',
            fileChanges: [{
              kind: 'renamed',
              path: 'src/new.ts',
              previousPath: 'src/old.ts',
              diffId: 'diff-one'
            }]
          },
          { user: 'What remains?', assistant: '' }
        ]
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

function markerState(initialValue) {
  let value = initialValue;
  const writes = [];
  return {
    read: () => value,
    write: async (marker) => {
      value = structuredClone(marker);
      writes.push(structuredClone(marker));
    },
    writes
  };
}

function memoryApi() {
  const snapshots = new Map();
  const api = {
    snapshots,
    saveCalls: [],
    loadCalls: [],
    saveFailure: undefined,
    changeLoadedSnapshot: (snapshot) => snapshot,
    save: async (access, request, signal) => {
      api.saveCalls.push({ access, request: structuredClone(request), signal });
      if (api.saveFailure) {
        return { status: 'error', message: api.saveFailure, errorKind: 'http' };
      }
      for (const snapshot of request.sessions) {
        snapshots.set(snapshot.session.sessionId, structuredClone(snapshot));
      }
      return {
        status: 'ok',
        data: {
          savedSessionIds: request.sessions.map((snapshot) => snapshot.session.sessionId)
        }
      };
    },
    load: async (access, request, signal) => {
      api.loadCalls.push({ access, request, signal });
      const snapshot = snapshots.get(request.sessionId);
      return snapshot
        ? {
          status: 'ok',
          data: { session: api.changeLoadedSnapshot(structuredClone(snapshot)) }
        }
        : { status: 'error', message: 'Session not found.', errorKind: 'http' };
    }
  };
  return api;
}
