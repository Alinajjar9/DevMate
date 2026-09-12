const assert = require('node:assert/strict');
const test = require('node:test');
const { createWebviewHarness } = require('./helpers/webviewHarness');
const { loadSettings } = require('./helpers/webviewSettings');

function readyTools() {
  const view = createWebviewHarness();
  view.receive({ command: 'llmProfilesUpdated', activeProfile: { id: 'local', name: 'Local', provider: 'ollama', model: 'test' }, profileCount: 1 });
  const { configurationState } = loadSettings(view);
  const toolNames = ['read_file', 'edit_file', 'get_project_info', 'get_git_changes', 'rename_symbol', 'format_file', 'stop_command'];
  view.receive({ ...configurationState, toolNames, configuration: { ...configurationState.configuration, enabledTools: toolNames } });
  view.receive({ command: 'commandAccessUpdated', access: 'standard', workspaceAvailable: true, workspaceTrusted: true });
  return view;
}

function openTools(view) {
  view.get('settingsButton').click();
  view.get('openAgentToolSettings').click();
  assert.equal(view.get('agentToolsDialog').open, true);
  assert.equal(view.get('permissionDialog').open, false);
}

test('tools are grouped with friendly descriptions and limits open only when requested', () => {
  const view = readyTools();
  openTools(view);
  assert.deepEqual(view.get('configurationTools').querySelectorAll('legend').map(item => item.textContent), ['Read and inspect', 'Edit', 'Commands']);
  for (const title of ['Project information', 'Git changes', 'Rename a symbol', 'Format a file', 'Stop a command']) {
    assert.ok(view.get('configurationTools').textContent.includes(title), title);
  }
  assert.equal(view.get('toolResultLimits').open, false);
  assert.equal(view.get('agentToolsDialog').querySelector('form'), null);
  assert.equal(view.get('agentToolsDialog').querySelector('#settingsScope'), null);
  assert.equal(view.get('agentToolsDialog').querySelector('#commandAccess'), null);
  assert.equal(view.get('permissionForm').querySelector('#configurationTools'), null);
  assert.equal(view.get('filePermissionSettingsTitle').textContent, 'Permissions');
  assert.ok(view.get('permissionsSettings').contains(view.get('commandAccess')));
  assert.ok(view.get('permissionsSettings').contains(view.get('permissionCreateFiles')));
});

test('popup edits stay in the draft, Done preserves them, and only the main Save persists', () => {
  const view = readyTools();
  openTools(view);
  const count = view.messages.length;
  view.get('configurationTools').querySelectorAll('input').find(input => input.value === 'format_file').checked = false;
  view.get('settingsReadFileMaxLines').value = '600';
  view.get('closeAgentTools').click();
  assert.equal(view.messages.length, count);
  assert.equal(view.get('permissionDialog').open, true);
  view.get('openAgentToolSettings').click();
  assert.equal(view.get('settingsReadFileMaxLines').value, '600');
  assert.equal(view.get('configurationTools').querySelectorAll('input').find(input => input.value === 'format_file').checked, false);
  view.get('closeAgentTools').click();
  view.get('permissionForm').dispatch('submit');
  assert.equal(view.messages.at(-1).command, 'saveSettings');
  assert.deepEqual(view.messages.at(-1).settings.agentTools, { readFileMaxLines: 600 });
  assert.ok(!view.messages.at(-1).settings.configuration.enabledTools.includes('format_file'));
});

test('grouping tools does not save a new override when the selection is unchanged', () => {
  const view = readyTools();
  openTools(view);
  view.get('closeAgentTools').click();
  view.get('permissionForm').dispatch('submit');
  assert.deepEqual(view.messages.at(-1).settings.configuration, {});
});

test('Cancel in the main dialog discards tool edits and invalid limits return to the popup', () => {
  const view = readyTools();
  openTools(view);
  view.get('settingsReadFileMaxLines').value = '600';
  view.get('closeAgentTools').click();
  view.get('cancelPermissionSettings').click();
  openTools(view);
  assert.equal(view.get('settingsReadFileMaxLines').value, '400');
  view.get('settingsReadFileMaxLines').value = '1001';
  view.get('closeAgentTools').click();
  view.get('permissionForm').dispatch('submit');
  assert.equal(view.get('agentToolsDialog').open, true);
  assert.match(view.get('agentToolsError').textContent, /100 to 1000/);
});

test('Extended access waits for approved state and cancellation restores Standard without discarding the draft', () => {
  const view = readyTools();
  openTools(view);
  view.get('settingsReadFileMaxLines').value = '600';
  view.get('closeAgentTools').click();
  view.get('permissionsSettings').open = true;
  view.get('commandAccess').value = 'extended';
  view.get('commandAccess').dispatch('change');
  assert.deepEqual(view.messages.at(-1), { command: 'setCommandAccess', access: 'extended' });
  assert.equal(view.get('commandAccess').value, 'standard');
  assert.equal(view.get('commandAccess').disabled, true);
  assert.equal(view.get('extendedAccessBadge').hidden, true);
  assert.equal(view.get('ask').disabled, true);
  view.receive({ command: 'commandAccessUpdated', access: 'standard', workspaceAvailable: true, workspaceTrusted: true });
  assert.equal(view.get('commandAccess').value, 'standard');
  assert.equal(view.get('commandAccess').disabled, false);
  assert.equal(view.get('settingsReadFileMaxLines').value, '600');
  view.receive({ command: 'commandAccessUpdated', access: 'extended', workspaceAvailable: true, workspaceTrusted: true });
  assert.equal(view.get('extendedAccessBadge').hidden, false);
  view.get('cancelPermissionSettings').click();
  assert.equal(view.get('extendedAccessBadge').hidden, false);
  openTools(view);
  view.get('closeAgentTools').click();
  view.get('permissionForm').dispatch('submit');
  assert.equal(view.messages.at(-1).settings.configuration.commandAccess, undefined);
});

test('command access is disabled without workspace trust and while an agent is running', () => {
  const view = readyTools();
  for (const state of [{ workspaceAvailable: false, workspaceTrusted: true }, { workspaceAvailable: true, workspaceTrusted: false }]) {
    view.receive({ command: 'commandAccessUpdated', access: 'standard', ...state });
    assert.equal(view.get('commandAccess').disabled, true);
  }
  view.receive({ command: 'commandAccessUpdated', access: 'standard', workspaceAvailable: true, workspaceTrusted: true });
  view.get('question').value = 'Inspect this';
  view.get('ask').click();
  assert.equal(view.get('commandAccess').disabled, true);
});

test('managed commands expose a safe Stop action during a run and survive message reconstruction', () => {
  const view = readyTools();
  view.receive({ command: 'managedCommandsUpdated', commands: [{ id: 'owned-1', label: '<script>dev server</script>' }] });
  assert.equal(view.get('managedCommandsPanel').hidden, false);
  assert.equal(view.get('managedCommandsList').querySelector('script'), null);
  view.get('question').value = 'Run tests';
  view.get('ask').click();
  const stop = view.get('managedCommandsList').querySelector('button');
  assert.equal(stop.disabled, false);
  stop.click();
  const count = view.messages.length;
  view.get('managedCommandsList').querySelector('button').click();
  assert.equal(view.messages.length, count);
  assert.deepEqual(view.messages.at(-1), { command: 'stopManagedCommand', id: 'owned-1' });
  view.receive({ command: 'sessionsUpdated', messages: [], sessions: [], openChat: true });
  assert.equal(view.get('managedCommandsList').querySelector('button').disabled, true);
  view.receive({ command: 'managedCommandsUpdated', commands: [] });
  assert.equal(view.get('managedCommandsPanel').hidden, true);
});

test('Extended command approvals offer only Deny and Allow once', () => {
  const view = readyTools();
  view.receive({ command: 'commandPermissionRequest', requestId: 'command-1', label: 'npm run dev', cwd: '.', allowRemember: false });
  const card = view.document.querySelector('.permission-card');
  assert.deepEqual(card.querySelectorAll('button').map(button => button.textContent), ['Deny', 'Allow once']);
});
