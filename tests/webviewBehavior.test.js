const assert = require('node:assert/strict');
const test = require('node:test');
const { createWebviewHarness } = require('./helpers/webviewHarness');
const { loadSettings } = require('./helpers/webviewSettings');

function readyWebview() {
  const view = createWebviewHarness();
  view.receive({
    command: 'llmProfilesUpdated',
    activeProfile: { id: 'local', name: 'Local model', provider: 'ollama', model: 'example' },
    profileCount: 1
  });
  return view;
}

test('webview initializes its scope and submits a trimmed question once through Enter', () => {
  const view = readyWebview();
  assert.deepEqual(view.messages, [{ command: 'setScope', scope: 'project' }, { command: 'ready' }]);
  view.get('question').value = '   ';
  view.get('ask').click();
  assert.equal(view.get('status').textContent, 'Enter a question before asking.');
  assert.equal(view.messages.length, 2);

  view.get('question').value = '  Explain the component  ';
  for (const modifier of [{ shiftKey: true }, { isComposing: true }]) {
    const event = view.get('question').dispatch('keydown', { key: 'Enter', ...modifier });
    assert.equal(event.defaultPrevented, false);
    assert.equal(view.messages.length, 2);
  }
  const event = view.get('question').dispatch('keydown', { key: 'Enter' });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(view.messages.at(-1), {
    command: 'ask', mode: 'code', question: 'Explain the component',
    scope: { kind: 'project', label: 'Project', detail: '' }, isNewTurn: true
  });
  assert.equal(view.get('question').value, '');
  assert.equal(view.get('ask').disabled, true);
  assert.equal(view.document.querySelectorAll('.message.user').length, 1);
});

test('status messages keep a request pending until a terminal request event arrives', () => {
  const view = readyWebview();
  view.get('question').value = 'Explain this';
  view.get('ask').click();
  for (const level of ['info', 'warning', 'error']) {
    view.receive({ command: 'status', level, text: 'Provider status' });
    for (const id of ['ask', 'attachFiles', 'llmProfileSelector', 'sessionSelector', 'newSessionButton']) {
      assert.equal(view.get(id).disabled, true, id + ' stays disabled');
    }
  }
  view.receive({ command: 'requestFailed', message: 'Provider disconnected', retryable: true });
  assert.equal(view.get('ask').disabled, false);
  const retry = view.document.querySelector('.working-retry');
  assert.equal(retry.hidden, false);
  retry.click();
  assert.equal(view.messages.at(-1).isNewTurn, false);
  assert.equal(view.get('ask').disabled, true);
  view.receive({ command: 'requestCancelled' });
  assert.equal(view.get('ask').disabled, false);
  assert.equal(view.get('status').hidden, true);
});

test('streamed narration preserves words and finishes draining before showing the final answer', () => {
  const view = readyWebview();
  view.get('question').value = 'Review this';
  view.get('ask').click();
  view.receive({ command: 'providerStreamDelta', text: 'Multiple   spaces\nstay readable.' });
  view.flushTimers();
  assert.equal(view.get('providerNarration').querySelector('.message-body').textContent, 'Multiple spaces stay readable.');
  view.receive({ command: 'providerStreamDelta', text: ' The styles reference CSS classes.' });
  view.receive({ command: 'assistantResponse', response: '**Review complete.**' });
  assert.equal(view.get('ask').disabled, true);
  assert.equal(view.document.querySelector('.markdown'), null);
  view.flushTimers();
  assert.equal(view.get('ask').disabled, false);
  assert.equal(view.document.querySelector('.markdown strong').textContent, 'Review complete.');
  assert.equal(view.get('providerNarration'), null);
});

test('profile form validates credentials and clears API keys when the dialog closes', () => {
  const view = readyWebview();
  view.receive({ command: 'showLlmProfileForm', hasApiKey: false });
  view.get('llmProfileName').value = 'Test profile';
  view.get('llmProfileModel').value = 'example';
  view.get('llmProfileBaseUrl').value = 'https://user:secret@example.test';
  view.get('llmProfileForm').dispatch('submit');
  assert.match(view.get('llmProfileFormError').textContent, /without embedded credentials/);
  view.get('llmProfileBaseUrl').value = 'https://example.test';
  view.get('llmProfileForm').dispatch('submit');
  assert.match(view.get('llmProfileFormError').textContent, /Enter an API key/);
  view.get('llmProfileApiKey').value = 'example-test-key';
  view.get('llmProfileForm').dispatch('submit');
  assert.equal(view.messages.at(-1).command, 'saveLlmProfile');
  assert.equal(view.messages.at(-1).profile.apiKey, 'example-test-key');
  assert.equal(view.get('saveLlmProfile').disabled, true);
  view.receive({ command: 'closeLlmProfileForm' });
  assert.equal(view.get('llmProfileDialog').open, false);
  assert.equal(view.get('llmProfileApiKey').value, '');
  assert.equal(view.get('llmProfileDialog').dataset.hasApiKey, 'false');
});

test('settings preserve tool values in the same form and close after saving', () => {
  const view = readyWebview();
  loadSettings(view, {}, {}, 'global');
  view.get('settingsButton').click();
  assert.equal(view.get('permissionDialog').open, true);
  assert.equal(view.get('settingsToolCallLimit').value, '16');
  view.get('settingsReadFileMaxLines').value = '600';
  view.get('permissionForm').dispatch('submit');
  assert.deepEqual(view.messages.at(-1), {
    command: 'saveSettings',
    scope: 'global',
    settings: {
      configuration: {}, agentTools: { readFileMaxLines: 600 },
      policy: { createFiles: 'ask', updateFiles: 'ask' }
    }
  });
  assert.equal(view.get('permissionDialog').open, true);
  view.receive({ command: 'settingsSaved' });
  assert.equal(view.get('permissionDialog').open, false);
});

test('backend recovery controls reflect status and issue only one restart while disabled', () => {
  const view = readyWebview();
  view.receive({ command: 'backendStatusUpdated', label: 'Backend offline', status: {
    state: 'offline', detail: 'Connection lost', canRestart: true
  } });
  assert.equal(view.get('backendStatus').dataset.state, 'offline');
  assert.equal(view.get('backendSettingsDetail').textContent, 'Connection lost');
  view.get('restartBackend').click();
  view.get('restartBackend').click();
  assert.equal(view.messages.filter((message) => message.command === 'restartBackend').length, 1);
  view.get('openBackendLogs').click();
  assert.equal(view.messages.at(-1).command, 'openBackendLogs');
  assert.doesNotThrow(() => view.receive({ command: 'unknownMessage' }));
});

test('dependency permission cards offer one-time decisions and resolve after one click', () => {
  const view = readyWebview();
  view.receive({ command: 'commandPermissionRequest', requestId: 'dependencies',
    title: 'Install dependencies', commandLabel: 'pip install example', rememberable: false });
  const card = view.document.querySelector('.permission-card');
  const buttons = card.querySelectorAll('button');
  assert.deepEqual(buttons.map((button) => button.textContent), ['Deny', 'Allow once']);
  buttons[1].click();
  buttons[1].click();
  assert.equal(view.messages.filter((message) => message.command === 'commandPermissionDecision').length, 1);
  assert.equal(card.querySelector('.permission-resolution').textContent, 'Allowed once');
});
