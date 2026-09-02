const assert = require('node:assert/strict');
const test = require('node:test');

const { SessionController } = require('../out/sessionController');
const {
  createConversationSessionStore
} = require('../out/sessions');

const workspace = {
  id: 'file:///workspace-one',
  name: 'Workspace One'
};

test('loads the current workspace directly from the repository', async () => {
  const stored = createConversationSessionStore('stored-session', 100, workspace);
  const repository = repositoryStub({
    loadWorkspace: async (workspaceIdentity) => {
      assert.equal(workspaceIdentity, workspace.id);
      return { kind: 'completed', value: stored };
    }
  });
  const controller = new SessionController(repository);

  assert.equal(await controller.synchronize(workspace), true);
  assert.equal(controller.sessionsLoaded, true);
  assert.deepEqual(controller.store, stored);
});

test('keeps failed repository writes pending and reports a visible issue', async () => {
  const issues = [];
  const repository = repositoryStub({
    saveSessions: async () => ({ kind: 'failed', message: 'Database unavailable.' })
  });
  const controller = new SessionController(
    repository,
    (issue) => issues.push(issue),
    createConversationSessionStore('session-one', 100, workspace)
  );

  assert.equal(await controller.persist('session-one'), false);
  assert.equal(controller.hasPendingChanges, true);
  assert.deepEqual(issues, [{
    message: 'Database unavailable.',
    notifyUser: true
  }]);
});

test('serializes writes so an older session cannot overwrite a newer one', async () => {
  const writes = [];
  let releaseFirstWrite;
  const firstWrite = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  const repository = repositoryStub({
    saveSessions: async (sessions) => {
      writes.push(structuredClone(sessions));
      if (writes.length === 1) {
        await firstWrite;
      }
      return { kind: 'completed', value: undefined };
    }
  });
  const controller = new SessionController(
    repository,
    undefined,
    createConversationSessionStore('session-one', 100, workspace)
  );

  const olderSave = controller.persist('session-one');
  await new Promise((resolve) => setImmediate(resolve));
  const newerSave = controller.rename('session-one', 'Newer session state');
  releaseFirstWrite();
  await Promise.all([olderSave, newerSave]);

  assert.deepEqual(writes.map((sessions) => sessions[0].title), [
    'New session',
    'Newer session state'
  ]);
  assert.equal(controller.hasPendingChanges, false);
});

test('creates, selects, renames, and deletes sessions through one state owner', async () => {
  const savedIds = [];
  const deletedIds = [];
  const repository = repositoryStub({
    saveSessions: async (sessions) => {
      savedIds.push(...sessions.map((session) => session.id));
      return { kind: 'completed', value: undefined };
    },
    deleteSession: async (sessionId) => {
      deletedIds.push(sessionId);
      return { kind: 'completed', value: undefined };
    }
  });
  const controller = new SessionController(repository);

  await controller.create('first-session', 100, workspace);
  await controller.create('second-session', 200, workspace);
  assert.equal(controller.select('first-session'), true);
  assert.equal(controller.activeSession().id, 'first-session');
  assert.equal(await controller.rename('first-session', 'Planning'), true);
  assert.equal(controller.session('first-session').title, 'Planning');
  assert.equal(await controller.delete('first-session'), true);
  assert.equal(controller.activeSession().id, 'second-session');
  assert.deepEqual(savedIds, ['first-session', 'second-session', 'first-session']);
  assert.deepEqual(deletedIds, ['first-session']);
});

test('keeps the pending question and then completes the same turn', async () => {
  const savedTurns = [];
  const repository = repositoryStub({
    saveSessions: async (sessions) => {
      savedTurns.push(structuredClone(sessions[0].turns));
      return { kind: 'completed', value: undefined };
    }
  });
  const controller = new SessionController(
    repository,
    undefined,
    createConversationSessionStore('session-one', 100, workspace)
  );

  assert.equal(await controller.appendUserMessage('Fix the bug', 200), true);
  assert.deepEqual(controller.activeSession().turns.at(-1), {
    user: 'Fix the bug',
    assistant: ''
  });
  assert.equal(await controller.appendTurn('Fix the bug', 'Fixed.', 300), true);
  assert.deepEqual(controller.activeSession().turns.at(-1), {
    user: 'Fix the bug',
    assistant: 'Fixed.'
  });
  assert.equal(savedTurns.length, 2);
});

test('does not replace newer local state when a slower initial load finishes', async () => {
  const loadedStore = createConversationSessionStore('stored-session', 100, workspace);
  let finishLoad;
  const load = new Promise((resolve) => {
    finishLoad = resolve;
  });
  const repository = repositoryStub({
    loadWorkspace: async () => load
  });
  const controller = new SessionController(
    repository,
    undefined,
    createConversationSessionStore('local-session', 200, workspace)
  );

  const synchronization = controller.synchronize(workspace);
  await controller.appendUserMessage('New local question', 300);
  finishLoad({ kind: 'completed', value: loadedStore });
  assert.equal(await synchronization, true);

  assert.equal(controller.store.activeSessionId, 'local-session');
  assert.equal(controller.activeSession().turns.at(-1).user, 'New local question');
});

function repositoryStub(overrides = {}) {
  return {
    loadWorkspace: async () => ({
      kind: 'completed',
      value: createConversationSessionStore('default-session', 1, workspace)
    }),
    saveSessions: async () => ({ kind: 'completed', value: undefined }),
    deleteSession: async () => ({ kind: 'completed', value: undefined }),
    ...overrides
  };
}
