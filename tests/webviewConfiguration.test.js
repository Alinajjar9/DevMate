const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createWebviewHarness } = require('./helpers/webviewHarness');
const { loadSettings, configuration, agentTools } = require('./helpers/webviewSettings');

function readySettings(overrides, tools) {
  const view = createWebviewHarness();
  view.receive({ command: 'llmProfilesUpdated', activeProfile: { id: 'local', name: 'Local', provider: 'ollama', model: 'test' }, profileCount: 1 });
  const snapshots = loadSettings(view, overrides, tools);
  return { view, ...snapshots };
}

test('one settings form contains each default once and removed managers are absent', () => {
  const { view } = readySettings();
  view.get('settingsButton').click();
  assert.equal(view.get('permissionDialog').open, true);
  assert.equal(view.get('settingsScope').value, 'workspace');
  assert.equal(view.get('advancedSettings').open, false);
  for (const id of ['configurationDialog', 'agentToolSettingsDialog', 'presetSelector', 'templateEditor', 'importConfiguration', 'exportConfiguration', 'configurationReasoningEffort', 'configurationInstructions', 'settingsContext', 'configurationPinnedFiles', 'configurationExcludedPaths', 'contextControls', 'scopeDetail', 'previewContext', 'contextBudget', 'contextPreviewDialog']) assert.equal(view.get(id), null, id);
  const markup = fs.readFileSync(path.join(__dirname, '../src/webview.ts'), 'utf8');
  for (const id of ['settingsScope', 'settingsMaxTokens', 'settingsTemperature', 'settingsTimeoutSeconds', 'settingsCommandTimeoutSeconds', 'settingsToolCallLimit']) {
    assert.equal(markup.match(new RegExp('id="' + id + '"', 'g')).length, 1, id);
  }
  assert.ok(view.get('configurationContextCharacters'));
  assert.ok(view.get('configurationHistoryCharacters'));
  assert.ok(view.get('attachFiles'));
  assert.deepEqual(view.document.querySelectorAll('.scope-button[data-scope]').map(button => button.textContent), ['Project', 'File', 'Selection']);
});

test('one save preserves explicit overrides and includes only changed inherited values', () => {
  const hidden = { instructions: 'Existing rule', pinnedFiles: ['src/main.ts', 'README.md'], excludedPaths: ['generated/**'] };
  const { view } = readySettings(hidden, { readFileMaxLines: 600 });
  view.get('settingsButton').click();
  view.get('configurationMaxFileEdits').value = '0';
  view.get('settingsSearchCodeMaxResults').value = '75';
  view.get('configurationTools').querySelectorAll('input')[1].checked = false;
  view.get('permissionForm').dispatch('submit');
  assert.deepEqual(view.messages.at(-1), { command: 'saveSettings', scope: 'workspace', settings: {
    configuration: { ...hidden, maxFileEdits: 0, enabledTools: ['read_file'] },
    agentTools: { readFileMaxLines: 600, searchCodeMaxResults: 75 }, policy: { createFiles: 'ask', updateFiles: 'ask' }
  } });
  assert.equal(view.get('ask').disabled, true);
  assert.equal(view.get('saveSettings').disabled, true);
  const count = view.messages.length;
  view.get('permissionForm').dispatch('submit');
  assert.equal(view.messages.length, count);
  view.receive({ command: 'settingsSaved' });
  assert.equal(view.get('permissionDialog').open, false);
  assert.equal(view.get('ask').disabled, false);
});

test('save failures preserve the draft and restore the controls', () => {
  const { view } = readySettings();
  view.get('settingsButton').click();
  view.get('settingsMaxTokens').value = '7000';
  view.get('permissionForm').dispatch('submit');
  view.receive({ command: 'settingsError', message: 'Could not save settings.' });
  assert.equal(view.get('permissionDialog').open, true);
  assert.equal(view.get('settingsError').textContent, 'Could not save settings.');
  assert.equal(view.get('settingsMaxTokens').value, '7000');
  assert.equal(view.get('saveSettings').disabled, false);
  assert.equal(view.get('ask').disabled, false);
});

test('scope changes wait for both context and tool baselines before saving', () => {
  const { view, configurationState, settingsState } = readySettings();
  view.get('settingsButton').click();
  view.get('settingsScope').value = 'global';
  view.get('settingsScope').dispatch('change');
  assert.deepEqual(view.messages.at(-1), { command: 'setConfigurationScope', scope: 'global' });
  const count = view.messages.length;
  view.receive({ ...configurationState, scope: 'global' });
  view.get('permissionForm').dispatch('submit');
  assert.equal(view.messages.length, count);
  view.receive({ ...settingsState, settings: { ...settingsState.settings, scope: 'global' } });
  view.get('permissionForm').dispatch('submit');
  assert.equal(view.messages.at(-1).scope, 'global');
});

test('reset clears only displayed overrides and preserves hidden preferences and permission choices', () => {
  const hidden = { instructions: 'Old rule', pinnedFiles: ['src/main.ts'], excludedPaths: ['generated/**'] };
  const { view } = readySettings({ maxTokens: 8000, ...hidden }, { readFileMaxLines: 800 });
  view.get('settingsButton').click();
  view.get('permissionUpdateFiles').value = 'allow';
  const count = view.messages.length;
  view.get('resetSettings').click();
  assert.equal(view.messages.length, count);
  assert.equal(view.get('settingsMaxTokens').value, String(configuration.maxTokens));
  assert.equal(view.get('settingsReadFileMaxLines').value, String(agentTools.readFileMaxLines));
  view.get('permissionForm').dispatch('submit');
  assert.deepEqual(view.messages.at(-1).settings, { configuration: hidden, agentTools: {}, policy: { createFiles: 'ask', updateFiles: 'allow' } });
});

test('edits after reset become new overrides and Cancel does not persist them', () => {
  const { view } = readySettings({ maxTokens: 8000 }, { readFileMaxLines: 800 });
  view.get('settingsButton').click();
  view.get('resetSettings').click();
  view.get('settingsMaxTokens').value = '2000';
  const count = view.messages.length;
  view.get('cancelPermissionSettings').click();
  assert.equal(view.messages.length, count);
  view.get('settingsButton').click();
  assert.equal(view.get('settingsMaxTokens').value, '8000');
  view.get('resetSettings').click();
  view.get('settingsMaxTokens').value = '2000';
  view.get('settingsReadFileMaxLines').value = '500';
  view.get('permissionForm').dispatch('submit');
  assert.deepEqual(view.messages.at(-1).settings.configuration, { maxTokens: 2000 });
  assert.deepEqual(view.messages.at(-1).settings.agentTools, { readFileMaxLines: 500 });
});

test('invalid limits stop saving without disabling the form', () => {
  const { view } = readySettings();
  view.get('settingsButton').click();
  const count = view.messages.length;
  view.get('configurationMaxRepairAttempts').value = '0';
  view.get('permissionForm').dispatch('submit');
  assert.equal(view.messages.length, count);
  assert.match(view.get('settingsError').textContent, /from 1 to 10/);
  view.get('configurationMaxRepairAttempts').value = '3';
  view.get('settingsReadFileMaxLines').value = '1001';
  view.get('permissionForm').dispatch('submit');
  assert.match(view.get('settingsError').textContent, /from 100 to 1000/);
  assert.equal(view.get('saveSettings').disabled, false);
});

test('model numeric overrides inherit when blank and reasoning uses the model preference', () => {
  const { view } = readySettings();
  view.receive({ command: 'showLlmProfileForm', profile: { id: 'local', name: 'Local', provider: 'ollama', model: 'test', settings: { maxTokens: 500, temperature: 0, reasoningEffort: 'high' } }, hasApiKey: false });
  assert.equal(view.get('profileMaxTokens').value, '500');
  assert.equal(view.get('profileReasoningEffort').value, 'high');
  view.get('profileMaxTokens').value = '';
  view.get('llmProfileForm').dispatch('submit');
  assert.deepEqual(view.messages.at(-1).profile.settings, { temperature: 0, reasoningEffort: 'high' });
});

test('reset keeps hidden fields inherited instead of saving copies of global preferences', () => {
  const { view, configurationState } = readySettings({ maxTokens: 8000 });
  const inherited = { ...configuration, instructions: 'Global rule', pinnedFiles: ['README.md'], excludedPaths: ['dist/**'] };
  view.receive({ ...configurationState, configuration: { ...inherited, maxTokens: 8000 }, inheritedConfiguration: inherited });
  view.get('settingsButton').click();
  view.get('resetSettings').click();
  view.get('permissionForm').dispatch('submit');
  assert.deepEqual(view.messages.at(-1).settings.configuration, {});
});

test('saved model tests send only a profile ID and remain synthetic in UI tests', () => {
  const { view } = readySettings();
  view.receive({ command: 'showLlmProfileForm', profile: { id: 'local', name: 'Local', provider: 'ollama', model: 'test' }, hasApiKey: false });
  view.get('testLlmProfile').click();
  assert.equal(view.get('ask').disabled, true);
  const count = view.messages.length;
  view.get('testLlmProfile').click();
  assert.equal(view.messages.length, count);
  assert.deepEqual(view.messages.at(-1), { command: 'testLlmProfile', profileId: 'local' });
  view.receive({ command: 'modelTestResult', profileId: 'local', result: { connection: 'confirmed', tools: 'confirmed', streaming: 'unknown', reasoning: 'accepted', detail: '<img src=x>' } });
  assert.equal(view.get('profileTestResult').querySelector('img'), null);
  assert.equal(view.get('ask').disabled, false);
});

test('undo associates with live file changes and becomes a workspace action after session reconstruction', () => {
  const { view } = readySettings();
  const messages = [{ role: 'assistant', text: 'Updated the file.', fileChanges: [{ kind: 'updated', path: 'src/main.ts' }] }];
  view.receive({ command: 'assistantResponse', response: 'Updated the file.', fileChanges: messages[0].fileChanges });
  view.receive({ command: 'undoState', available: true, label: 'Recent file edits', files: 1 });
  assert.equal(view.get('requestUndoPanel').parent.className, 'file-change-summary');
  view.receive({ command: 'sessionsUpdated', messages, sessions: [], openChat: true });
  assert.equal(view.get('requestUndoPanel').parent.id, 'messages');
  assert.equal(view.get('requestUndoLabel').textContent, 'Latest workspace edits');
  view.get('undoRequest').click();
  assert.equal(view.get('ask').disabled, true);
  assert.equal(view.messages.at(-1).command, 'undoRequest');
  view.receive({ command: 'undoState', available: false, label: '', files: 0 });
  assert.equal(view.get('requestUndoPanel').hidden, true);
});

test('partial runs retain an undo action even without a final changed-file summary', () => {
  const { view } = readySettings();
  view.get('question').value = 'Fix it';
  view.get('ask').click();
  view.receive({ command: 'requestFailed', message: 'Stopped after one change.', retryable: false });
  view.receive({ command: 'undoState', available: true, label: 'One file changed before stopping', files: 1 });
  assert.equal(view.get('requestUndoPanel').hidden, false);
  assert.equal(view.get('requestUndoLabel').textContent, 'Latest workspace edits');
  assert.equal(view.get('undoRequest').disabled, false);
});
