const assert = require('node:assert/strict');
const test = require('node:test');

const {
  activeConversationSession,
  activeSessionModelHistory,
  addConversationSession,
  appendConversationSessionTurn,
  appendConversationSessionUserMessage,
  createConversationSessionStore,
  deleteConversationSession,
  MAX_CONVERSATION_SESSIONS,
  MAX_SESSION_STORE_CHARACTERS,
  MAX_SESSION_TURNS,
  mergeConversationSessionStores,
  migrateLegacyConversationSessionStore,
  parseConversationSessionStore,
  renameConversationSession,
  selectConversationSession,
  sessionBelongsToWorkspace,
  sessionTitleFromQuestion
} = require('../out/sessions');

const workspaceA = { id: 'file:///project-a', name: 'Project A' };
const workspaceB = { id: 'file:///project-b', name: 'Project B' };

test('creates, selects, renames, and deletes project-bound sessions', () => {
  let store = createConversationSessionStore('session-one', 1, workspaceA);
  store = appendConversationSessionTurn(store, 'First task', 'First answer', 2);
  store = addConversationSession(store, 'session-two', 3, workspaceB);
  store = appendConversationSessionTurn(store, 'Second task', 'Second answer', 4);

  assert.equal(activeConversationSession(store).id, 'session-two');
  assert.equal(activeConversationSession(store).workspaceName, 'Project B');
  assert.equal(sessionBelongsToWorkspace(activeConversationSession(store), workspaceA), false);
  store = selectConversationSession(store, 'session-one');
  assert.equal(activeConversationSession(store).turns[0].assistant, 'First answer');
  assert.equal(sessionBelongsToWorkspace(activeConversationSession(store), workspaceA), true);
  store = renameConversationSession(store, 'session-one', '  Renamed\nchat  ');
  assert.equal(activeConversationSession(store).title, 'Renamed chat');
  store = deleteConversationSession(store, 'session-one');
  assert.equal(store.activeSessionId, 'session-two');
  store = deleteConversationSession(store, 'session-two');
  assert.equal(store.sessions.length, 0);
  assert.equal(store.activeSessionId, '');
});

test('auto-titles the first completed turn and bounds model history separately', () => {
  let store = createConversationSessionStore('session', 1, workspaceA);
  for (let index = 0; index < MAX_SESSION_TURNS + 4; index += 1) {
    store = appendConversationSessionTurn(
      store,
      `Build a product website section ${index}`,
      `Completed section ${index}`,
      index + 2
    );
  }
  assert.match(activeConversationSession(store).title, /Build a product website/);
  assert.equal(activeConversationSession(store).turns.length, MAX_SESSION_TURNS);
  assert.ok(activeSessionModelHistory(store).length < MAX_SESSION_TURNS);
  assert.equal(sessionTitleFromQuestion(' '.repeat(10)), 'New session');
  assert.ok(sessionTitleFromQuestion('x'.repeat(200)).endsWith('…'));
  assert.ok(sessionTitleFromQuestion('x'.repeat(200)).length <= 80);
});

test('persists an unanswered user message and completes it without duplication', () => {
  let store = createConversationSessionStore('session', 1, workspaceA);
  store = appendConversationSessionUserMessage(store, '  Keep this after failure  ', 2);

  assert.equal(activeConversationSession(store).title, 'Keep this after failure');
  assert.deepEqual(activeConversationSession(store).turns, [{
    user: 'Keep this after failure',
    assistant: ''
  }]);
  assert.deepEqual(activeSessionModelHistory(store), []);

  const restored = parseConversationSessionStore(store);
  assert.deepEqual(activeConversationSession(restored).turns, [{
    user: 'Keep this after failure',
    assistant: ''
  }]);

  store = appendConversationSessionTurn(
    restored,
    'Keep this after failure',
    'Completed after retry',
    3
  );
  assert.deepEqual(activeConversationSession(store).turns, [{
    user: 'Keep this after failure',
    assistant: 'Completed after retry'
  }]);
  assert.equal(activeSessionModelHistory(store).length, 1);
});

test('persists file-change summaries without replaying them to the model', () => {
  let store = createConversationSessionStore('session', 1, workspaceA);
  const fileChanges = [
    { kind: 'updated', path: 'src/app.ts' },
    { kind: 'deleted', path: 'src/old.ts' }
  ];
  store = appendConversationSessionTurn(store, 'Update the app', 'Done.', 2, fileChanges);

  const restored = parseConversationSessionStore(store);
  assert.deepEqual(activeConversationSession(restored).turns[0].fileChanges, fileChanges);
  assert.deepEqual(activeSessionModelHistory(restored), [{
    user: 'Update the app',
    assistant: 'Done.'
  }]);
});

test('bounds total persisted turn content across project sessions', () => {
  let store = createConversationSessionStore('session-0', 1, workspaceA);
  for (let sessionIndex = 0; sessionIndex < MAX_CONVERSATION_SESSIONS; sessionIndex += 1) {
    if (sessionIndex > 0) {
      store = addConversationSession(
        store,
        `session-${sessionIndex}`,
        sessionIndex * 100,
        sessionIndex % 2 === 0 ? workspaceA : workspaceB
      );
    }
    for (let turnIndex = 0; turnIndex < 20; turnIndex += 1) {
      store = appendConversationSessionTurn(
        store,
        'q'.repeat(6_000),
        'a'.repeat(6_000),
        sessionIndex * 100 + turnIndex + 1
      );
    }
  }
  const characterCount = store.sessions.reduce((total, session) => total + session.turns.reduce(
    (sessionTotal, turn) => sessionTotal + turn.user.length + turn.assistant.length,
    0
  ), 0);
  assert.ok(characterCount <= MAX_SESSION_STORE_CHARACTERS);
});

test('parses bounded global sessions and rejects invalid project metadata', () => {
  const sessions = Array.from({ length: MAX_CONVERSATION_SESSIONS + 5 }, (_, index) => ({
    id: `session-${index}`,
    title: `Session ${index}`,
    workspaceId: workspaceA.id,
    workspaceName: workspaceA.name,
    createdAt: index,
    updatedAt: index,
    turns: [{ user: 'Question', assistant: 'Answer' }]
  }));
  sessions.push({
    id: '../unsafe',
    title: 'Unsafe',
    workspaceId: '',
    workspaceName: 'Unsafe',
    createdAt: 1,
    updatedAt: 2,
    turns: []
  });
  const parsed = parseConversationSessionStore({
    version: 2,
    activeSessionId: 'missing',
    sessions
  });
  assert.equal(parsed.sessions.length, MAX_CONVERSATION_SESSIONS);
  assert.equal(parsed.activeSessionId, parsed.sessions[0].id);
  assert.equal(parsed.sessions.some((session) => session.id === '../unsafe'), false);
  assert.equal(parseConversationSessionStore({ version: 1, sessions: [] }), undefined);
});

test('migrates workspace-local version-one sessions into the global catalog', () => {
  const legacy = migrateLegacyConversationSessionStore({
    version: 1,
    activeSessionId: 'legacy-session',
    sessions: [{
      id: 'legacy-session',
      title: 'New conversation',
      createdAt: 1,
      updatedAt: 2,
      turns: [{ user: 'Old question', assistant: 'Old answer' }]
    }]
  }, workspaceA);
  const existing = createConversationSessionStore('other-session', 3, workspaceB);
  const merged = mergeConversationSessionStores(existing, legacy);

  assert.equal(merged.sessions.length, 2);
  assert.equal(merged.activeSessionId, 'legacy-session');
  assert.equal(activeConversationSession(merged).title, 'New session');
  assert.equal(activeConversationSession(merged).workspaceId, workspaceA.id);
  assert.equal(activeConversationSession(merged).turns[0].user, 'Old question');
});
