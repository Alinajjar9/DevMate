const assert = require('node:assert/strict');
const test = require('node:test');

const { PermissionController } = require('../out/workspace/permissionController');
const {
  FILE_PERMISSION_POLICY_STORAGE_KEY,
  REMEMBERED_COMMANDS_STORAGE_KEY
} = require('../out/workspace/permissions');

test('reads safe defaults and filters invalid saved permission data', () => {
  const persistence = memoryPersistence({
    [FILE_PERMISSION_POLICY_STORAGE_KEY]: {
      createFiles: 'allow',
      updateFiles: 'invalid'
    },
    [REMEMBERED_COMMANDS_STORAGE_KEY]: [
      { signature: 'npm:test', label: 'npm test' },
      { signature: '', label: 'invalid' }
    ]
  });
  const controller = new PermissionController(persistence);

  assert.deepEqual(controller.policy(), {
    createFiles: 'allow',
    updateFiles: 'ask'
  });
  assert.deepEqual(controller.rememberedCommands(), [
    { signature: 'npm:test', label: 'npm test' }
  ]);
});

test('remembers file actions only when they can be represented by the policy', async () => {
  const persistence = memoryPersistence();
  const controller = new PermissionController(persistence);
  const request = controller.beginFilePermission('file-1', ['create', 'update']);

  assert.equal(request.rememberable, true);
  assert.deepEqual(
    await controller.decideFilePermission('file-1', 'allowAlways'),
    { handled: true, policyChanged: true, preferenceSaveFailed: false }
  );
  assert.equal(await request.promise, true);
  assert.deepEqual(controller.policy(), {
    createFiles: 'allow',
    updateFiles: 'allow'
  });

  const deleteRequest = controller.beginFilePermission('file-2', ['delete']);
  assert.equal(deleteRequest.rememberable, false);
  assert.deepEqual(
    await controller.decideFilePermission('file-2', 'allowAlways'),
    { handled: true, policyChanged: false, preferenceSaveFailed: false }
  );
  assert.equal(await deleteRequest.promise, true);
});

test('replaces and cancels pending permission promises safely', async () => {
  const controller = new PermissionController(memoryPersistence());
  const firstFile = controller.beginFilePermission('file-1', ['update']);
  const secondFile = controller.beginFilePermission('file-2', ['update']);
  const command = controller.beginCommandPermission(
    'command-1',
    'npm:test',
    'npm test',
    true
  );

  assert.equal(secondFile.replacedRequestId, 'file-1');
  assert.equal(await firstFile.promise, false);
  assert.deepEqual(controller.cancelPending(), {
    fileRequestId: 'file-2',
    commandRequestId: 'command-1'
  });
  assert.equal(await secondFile.promise, false);
  assert.equal(await command.promise, false);
});

test('remembered commands skip the approval prompt', async () => {
  const persistence = memoryPersistence();
  const controller = new PermissionController(persistence);
  const first = controller.beginCommandPermission(
    'command-1',
    'npm:test',
    'npm test · workspace root',
    true
  );

  assert.equal(first.requiresDecision, true);
  assert.deepEqual(
    await controller.decideCommandPermission('command-1', 'allowAlways'),
    {
      handled: true,
      rememberedCommandsChanged: true,
      preferenceSaveFailed: false
    }
  );
  assert.equal(await first.promise, true);

  const repeated = controller.beginCommandPermission(
    'command-2',
    'npm:test',
    'different label',
    true
  );
  assert.equal(repeated.requiresDecision, false);
  assert.equal(await repeated.promise, true);
});

test('non-rememberable commands allow once but cannot allow always', async () => {
  const controller = new PermissionController(memoryPersistence());
  const once = controller.beginCommandPermission(
    'command-1',
    'dangerous:one',
    'dangerous command',
    false
  );
  await controller.decideCommandPermission('command-1', 'allowOnce');
  assert.equal(await once.promise, true);

  const always = controller.beginCommandPermission(
    'command-2',
    'dangerous:two',
    'dangerous command',
    false
  );
  await controller.decideCommandPermission('command-2', 'allowAlways');
  assert.equal(await always.promise, false);
});

test('revoke and clear update remembered commands without UI dependencies', async () => {
  const persistence = memoryPersistence({
    [REMEMBERED_COMMANDS_STORAGE_KEY]: [
      { signature: 'one', label: 'first' },
      { signature: 'two', label: 'second' }
    ]
  });
  const controller = new PermissionController(persistence);

  assert.deepEqual(await controller.revokeRememberedCommand('one'), {
    ok: true,
    changed: true
  });
  assert.deepEqual(controller.rememberedCommands(), [
    { signature: 'two', label: 'second' }
  ]);
  assert.deepEqual(await controller.clearRememberedCommands(), {
    ok: true,
    changed: true
  });
  assert.deepEqual(controller.rememberedCommands(), []);
});

test('storage failures keep one-time approval usable and return readable errors', async () => {
  const persistence = memoryPersistence({
    [REMEMBERED_COMMANDS_STORAGE_KEY]: [
      { signature: 'one', label: 'first' }
    ]
  });
  const controller = new PermissionController(persistence);
  persistence.failWrites = true;

  const file = controller.beginFilePermission('file-1', ['update']);
  assert.deepEqual(
    await controller.decideFilePermission('file-1', 'allowAlways'),
    { handled: true, policyChanged: false, preferenceSaveFailed: true }
  );
  assert.equal(await file.promise, true);

  const command = controller.beginCommandPermission(
    'command-1',
    'npm:test',
    'npm test',
    true
  );
  assert.deepEqual(
    await controller.decideCommandPermission('command-1', 'allowAlways'),
    {
      handled: true,
      rememberedCommandsChanged: false,
      preferenceSaveFailed: true
    }
  );
  assert.equal(await command.promise, true);
  assert.deepEqual(await controller.revokeRememberedCommand('one'), {
    ok: false,
    message: 'DevMate could not forget that command.'
  });
  assert.deepEqual(await controller.clearRememberedCommands(), {
    ok: false,
    message: 'DevMate could not clear the remembered commands.'
  });
});

function memoryPersistence(initialState = {}) {
  const state = new Map(Object.entries(initialState));
  return {
    state,
    failWrites: false,
    readState: (key) => state.get(key),
    writeState: async function writeState(key, value) {
      if (this.failWrites) {
        throw new Error('storage unavailable');
      }
      state.set(key, structuredClone(value));
    }
  };
}
