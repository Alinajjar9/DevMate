const assert = require('node:assert/strict');
const test = require('node:test');

const { PermissionController } = require('../out/workspace/permissionController');
const { PermissionPresenter } = require('../out/workspace/permissionPresenter');
const {
  REMEMBERED_COMMANDS_STORAGE_KEY
} = require('../out/workspace/permissions');

test('publishes file requests and removes the replaced diff review', async () => {
  const fixture = createFixture();
  const first = fixture.presenter.requestFileChanges('First change', [fileChange()]);
  const second = fixture.presenter.requestFileChanges('Second change', [
    fileChange({ path: 'src/other.ts', operation: 'create' })
  ]);

  assert.equal(await first, false);
  assert.deepEqual(fixture.clearedDiffs, [undefined, 'request-1']);
  assert.deepEqual(fixture.rememberedDiffs.map((item) => item.requestId), [
    'request-1',
    'request-2'
  ]);
  assert.deepEqual(fixture.messages.at(-1), {
    command: 'permissionRequest',
    requestId: 'request-2',
    summary: 'Second change',
    rememberable: true,
    files: [{ path: 'src/other.ts', operation: 'create', canReview: true }]
  });

  await fixture.presenter.decideFilePermission('request-2', 'deny');
  assert.equal(await second, false);
});

test('remembering a file decision publishes the updated policy', async () => {
  const fixture = createFixture();
  const allowed = fixture.presenter.requestFileChanges('Update app', [fileChange()]);

  await fixture.presenter.decideFilePermission('request-1', 'allowAlways');

  assert.equal(await allowed, true);
  assert.deepEqual(fixture.messages.at(-1), {
    command: 'permissionPolicyUpdated',
    policy: { createFiles: 'ask', updateFiles: 'allow' }
  });
  assert.equal(fixture.clearedDiffs.at(-1), 'request-1');
});

test('reports when a proposed diff is no longer available', async () => {
  const fixture = createFixture({ canOpenDiff: false });

  await fixture.presenter.reviewFileDiff('missing', 'src/app.ts');

  assert.deepEqual(fixture.statuses, [{
    text: 'That proposed diff is no longer available.',
    level: 'warning'
  }]);
});

test('publishes command requests and supports one-time approval', async () => {
  const fixture = createFixture();
  const allowed = fixture.presenter.requestCommand(
    'npm:test',
    'npm test',
    '',
    { title: 'Run tests', warning: 'This starts a process.' }
  );

  assert.deepEqual(fixture.messages.at(-1), {
    command: 'commandPermissionRequest',
    requestId: 'request-1',
    label: 'npm test',
    cwd: 'Workspace root',
    rememberable: true,
    title: 'Run tests',
    warning: 'This starts a process.'
  });

  await fixture.presenter.decideCommandPermission('request-1', 'allowOnce');
  assert.equal(await allowed, true);
  assert.equal(fixture.settingsChanges, 0);
});

test('remembered commands skip the UI and refresh settings after changes', async () => {
  const fixture = createFixture({
    initialState: {
      [REMEMBERED_COMMANDS_STORAGE_KEY]: [
        { signature: 'npm:test', label: 'npm test · workspace root' }
      ]
    }
  });

  assert.equal(await fixture.presenter.requestCommand(
    'npm:test',
    'npm test',
    ''
  ), true);
  assert.equal(fixture.messages.length, 0);

  await fixture.presenter.revokeRememberedCommand('npm:test');
  await fixture.presenter.clearRememberedCommands();
  assert.equal(fixture.settingsChanges, 2);
});

test('reports preference and remembered-command storage failures', async () => {
  const fixture = createFixture({ failWrites: true });
  const file = fixture.presenter.requestFileChanges('Update app', [fileChange()]);
  await fixture.presenter.decideFilePermission('request-1', 'allowAlways');
  assert.equal(await file, true);

  const command = fixture.presenter.requestCommand('npm:test', 'npm test', '');
  await fixture.presenter.decideCommandPermission('request-2', 'allowAlways');
  assert.equal(await command, true);

  await fixture.presenter.revokeRememberedCommand('npm:test');
  await fixture.presenter.clearRememberedCommands();

  assert.deepEqual(fixture.statuses, [
    {
      text: 'The changes are allowed this time, but the permission preference could not be saved.',
      level: 'warning'
    },
    {
      text: 'The command is allowed this time, but it could not be remembered.',
      level: 'warning'
    },
    { text: 'DevMate could not forget that command.', level: 'error' },
    { text: 'DevMate could not clear the remembered commands.', level: 'error' }
  ]);
});

test('cancels both pending decisions and clears the open file review', async () => {
  const fixture = createFixture();
  const file = fixture.presenter.requestFileChanges('Update app', [fileChange()]);
  const command = fixture.presenter.requestCommand('npm:test', 'npm test', '');

  fixture.presenter.cancelPending();

  assert.equal(await file, false);
  assert.equal(await command, false);
  assert.equal(fixture.clearedDiffs.at(-1), 'request-1');
});

function createFixture(options = {}) {
  const values = new Map(Object.entries(options.initialState ?? {}));
  const persistence = {
    readState: (key) => values.get(key),
    writeState: async (key, value) => {
      if (options.failWrites) {
        throw new Error('storage unavailable');
      }
      values.set(key, structuredClone(value));
    }
  };
  const controller = new PermissionController(persistence);
  const messages = [];
  const statuses = [];
  const clearedDiffs = [];
  const rememberedDiffs = [];
  let settingsChanges = 0;
  let nextId = 1;
  const presenter = new PermissionPresenter(
    controller,
    {
      clearPendingFileDiffs: (requestId) => clearedDiffs.push(requestId),
      rememberPendingFileDiffs: (requestId, files) => {
        rememberedDiffs.push({ requestId, files });
      },
      openPendingFileDiff: async () => options.canOpenDiff !== false
    },
    {
      postMessage: (message) => messages.push(message),
      postStatus: (text, level) => statuses.push({ text, level }),
      settingsChanged: () => {
        settingsChanges += 1;
      }
    },
    () => `request-${nextId++}`
  );
  return {
    presenter,
    values,
    messages,
    statuses,
    clearedDiffs,
    rememberedDiffs,
    get settingsChanges() {
      return settingsChanges;
    }
  };
}

function fileChange(overrides = {}) {
  return {
    path: 'src/app.ts',
    operation: 'update',
    originalContent: 'before',
    proposedContent: 'after',
    ...overrides
  };
}
