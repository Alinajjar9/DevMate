const assert = require('node:assert/strict');
const test = require('node:test');

const {
  allowActions,
  MAX_REMEMBERED_COMMANDS,
  parseFilePermissionPolicy,
  parseRememberedCommands,
  permissionBehaviorForAction,
  permissionPolicyLabel,
  rememberCommand,
  revokeRememberedCommand
} = require('../out/permissions');

test('defaults missing or invalid permissions to ask', () => {
  assert.deepEqual(parseFilePermissionPolicy(undefined), {
    createFiles: 'ask',
    updateFiles: 'ask'
  });
  assert.deepEqual(parseFilePermissionPolicy({
    createFiles: 'allow',
    updateFiles: 'sometimes'
  }), {
    createFiles: 'allow',
    updateFiles: 'ask'
  });
});

test('stores bounded unique remembered command approvals', () => {
  const commands = parseRememberedCommands([
    { signature: 'one', label: 'npm test' },
    { signature: 'one', label: 'duplicate' },
    { signature: '', label: 'invalid' },
    ...Array.from({ length: MAX_REMEMBERED_COMMANDS + 5 }, (_, index) => ({
      signature: `command-${index}`,
      label: `command ${index}`
    }))
  ]);

  assert.equal(commands.length, MAX_REMEMBERED_COMMANDS);
  assert.equal(commands[0].label, 'npm test');
  assert.equal(
    rememberCommand(commands, { signature: 'one', label: 'another label' }).length,
    MAX_REMEMBERED_COMMANDS
  );
  const withNewest = rememberCommand(commands, { signature: 'newest', label: 'new command' });
  assert.equal(withNewest.length, MAX_REMEMBERED_COMMANDS);
  assert.equal(withNewest.at(-1).signature, 'newest');
  assert.equal(
    revokeRememberedCommand(commands, 'one').some((command) => command.signature === 'one'),
    false
  );
});

test('looks up and grants independent create and update permissions', () => {
  const initial = parseFilePermissionPolicy(undefined);
  const updated = allowActions(initial, ['create']);

  assert.equal(permissionBehaviorForAction(updated, 'create'), 'allow');
  assert.equal(permissionBehaviorForAction(updated, 'update'), 'ask');
  assert.equal(permissionPolicyLabel(updated), 'Creates allowed');
  assert.equal(permissionPolicyLabel(allowActions(updated, ['update'])), 'Changes allowed');
  assert.equal(permissionBehaviorForAction(updated, 'delete'), 'ask');
  assert.equal(permissionBehaviorForAction(updated, 'rename'), 'ask');
  assert.equal(permissionBehaviorForAction(updated, 'move'), 'ask');
  assert.deepEqual(allowActions(updated, ['delete', 'rename', 'move']), updated);
});
