const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const vscodeState = {
  input: undefined,
  warningChoice: undefined
};
const vscode = {
  window: {
    showInputBox: async () => vscodeState.input,
    showWarningMessage: async () => vscodeState.warningChoice
  }
};

const originalModuleLoad = Module._load;
Module._load = function loadWithVscodeMock(request, parent, isMain) {
  if (request === 'vscode') {
    return vscode;
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const { SessionPresenter } = require('../out/sessionPresenter');

test.beforeEach(() => {
  vscodeState.input = undefined;
  vscodeState.warningChoice = undefined;
});

test('publishes session summaries and completed messages for the current project', () => {
  const fixture = createFixture();
  fixture.presenter.postState(true, true);

  assert.deepEqual(fixture.messages.at(-1), {
    command: 'sessionsUpdated',
    activeSessionId: 'session-1',
    activeTitle: 'First chat',
    currentWorkspaceName: 'Project A',
    openChat: true,
    sessions: [{
      id: 'session-1',
      title: 'First chat',
      workspaceName: 'Project A',
      belongsToCurrentWorkspace: true,
      updatedAt: 20,
      turnCount: 2
    }],
    messages: [
      { role: 'user', text: 'Question' },
      { role: 'assistant', text: 'Answer', fileChanges: [] },
      { role: 'user', text: 'Pending question' }
    ]
  });
  assert.equal(fixture.checkpointUpdates, 1);
});

test('synchronizes and posts only when loaded state changes', async () => {
  const fixture = createFixture();
  fixture.sessions.synchronize = async () => false;
  await fixture.presenter.synchronize();
  assert.equal(fixture.messages.length, 0);

  fixture.sessions.synchronize = async (workspace) => {
    assert.deepEqual(workspace, { id: 'workspace-a', name: 'Project A' });
    return true;
  };
  await fixture.presenter.synchronize();
  assert.equal(fixture.messages.at(-1).command, 'sessionsUpdated');
});

test('creates sessions only when a workspace is open and requests are idle', async () => {
  const noWorkspace = createFixture({ workspace: undefined });
  await noWorkspace.presenter.createSession();
  assert.match(noWorkspace.messages.at(-1).message, /Open a project folder/);

  const active = createFixture({ active: true });
  await active.presenter.createSession();
  assert.deepEqual(active.statuses.at(-1), {
    text: 'Wait for the active request to finish before changing sessions.',
    level: 'warning'
  });

  const fixture = createFixture();
  await fixture.presenter.createSession();
  assert.deepEqual(fixture.created, [{
    id: 'new-session',
    now: 100,
    workspace: { id: 'workspace-a', name: 'Project A' }
  }]);
  assert.equal(fixture.messages.at(-1).openChat, true);
});

test('selects only sessions that belong to the open project', async () => {
  const fixture = createFixture();
  fixture.sessions.store.sessions[0].workspaceId = 'another-workspace';
  fixture.sessions.store.sessions[0].workspaceName = 'Project B';
  await fixture.presenter.selectSession('session-1');
  assert.match(fixture.messages.at(-1).message, /belongs to “Project B”/);
  assert.deepEqual(fixture.selected, []);

  fixture.sessions.store.sessions[0].workspaceId = 'workspace-a';
  await fixture.presenter.selectSession('session-1');
  assert.deepEqual(fixture.selected, ['session-1']);
  assert.equal(fixture.messages.at(-1).openChat, true);
});

test('renames after confirmation but stops if a request starts while the dialog is open', async () => {
  const fixture = createFixture();
  vscodeState.input = 'Renamed chat';
  await fixture.presenter.renameSession('session-1');
  assert.deepEqual(fixture.renamed, [{ id: 'session-1', title: 'Renamed chat' }]);

  const activeAfterDialog = createFixture();
  let requestChecks = 0;
  activeAfterDialog.callbacks.isRequestActive = () => {
    requestChecks += 1;
    return requestChecks > 1;
  };
  await activeAfterDialog.presenter.renameSession('session-1');
  assert.deepEqual(activeAfterDialog.renamed, []);
});

test('deletes only after modal confirmation and clears a matching checkpoint', async () => {
  const fixture = createFixture();
  vscodeState.warningChoice = 'Cancel';
  await fixture.presenter.deleteSession('session-1');
  assert.deepEqual(fixture.deleted, []);

  vscodeState.warningChoice = 'Delete';
  await fixture.presenter.deleteSession('session-1');
  assert.deepEqual(fixture.deleted, ['session-1']);
  assert.deepEqual(fixture.clearedCheckpoints, ['session-1']);
  assert.equal(fixture.messages.at(-1).command, 'sessionsUpdated');
});

function createFixture(options = {}) {
  const workspace = options.workspace === undefined && !Object.hasOwn(options, 'workspace')
    ? { id: 'workspace-a', name: 'Project A' }
    : options.workspace;
  const session = {
    id: 'session-1',
    title: 'First chat',
    workspaceId: 'workspace-a',
    workspaceName: 'Project A',
    createdAt: 10,
    updatedAt: 20,
    turns: [
      { user: 'Question', assistant: 'Answer' },
      { user: 'Pending question', assistant: '' }
    ]
  };
  const messages = [];
  const statuses = [];
  const created = [];
  const selected = [];
  const renamed = [];
  const deleted = [];
  const clearedCheckpoints = [];
  const sessions = {
    store: { activeSessionId: 'session-1', sessions: [session] },
    activeSession: () => session,
    session: (id) => sessions.store.sessions.find((item) => item.id === id),
    synchronize: async () => false,
    create: async (id, now, selectedWorkspace) => {
      created.push({ id, now, workspace: selectedWorkspace });
    },
    select: (id) => selected.push(id),
    rename: async (id, title) => renamed.push({ id, title }),
    delete: async (id) => deleted.push(id)
  };
  const workspaceContext = {
    getConversationWorkspace: () => workspace
  };
  const callbacks = {
    isRequestActive: () => options.active === true,
    postMessage: (message) => messages.push(message),
    postStatus: (text, level = 'info') => statuses.push({ text, level }),
    postCheckpointState: () => {
      fixture.checkpointUpdates += 1;
    },
    clearCheckpointForSession: async (id) => clearedCheckpoints.push(id)
  };
  const fixture = {
    messages,
    statuses,
    created,
    selected,
    renamed,
    deleted,
    clearedCheckpoints,
    sessions,
    callbacks,
    checkpointUpdates: 0
  };
  fixture.presenter = new SessionPresenter(
    sessions,
    workspaceContext,
    callbacks,
    () => 'new-session',
    () => 100
  );
  return fixture;
}
