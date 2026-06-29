const assert = require('node:assert/strict');
const test = require('node:test');

const {
  allowActions,
  parseFilePermissionPolicy,
  permissionBehaviorForAction,
  permissionPolicyLabel
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

test('looks up and grants independent create and update permissions', () => {
  const initial = parseFilePermissionPolicy(undefined);
  const updated = allowActions(initial, ['create']);

  assert.equal(permissionBehaviorForAction(updated, 'create'), 'allow');
  assert.equal(permissionBehaviorForAction(updated, 'update'), 'ask');
  assert.equal(permissionPolicyLabel(updated), 'Creates allowed');
  assert.equal(permissionPolicyLabel(allowActions(updated, ['update'])), 'Changes allowed');
});
