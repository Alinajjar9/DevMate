const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createWebviewHarness } = require('./helpers/webviewHarness');

function readyView() {
  const view = createWebviewHarness();
  view.receive({ command: 'llmProfilesUpdated', profileCount: 1, activeProfile: {
    id: 'chat-one', name: 'Local model', provider: 'ollama', providerLabel: 'Ollama', model: 'local-chat'
  } });
  return view;
}

function ask(view, question = 'Explain this code') {
  view.element('question').value = question;
  view.element('ask').click();
}

function buttonWithText(container, text) {
  const button = container.querySelectorAll('button').find((item) => item.textContent === text);
  assert.ok(button, 'Expected a button labelled ' + text);
  return button;
}

test('the packaged browser script starts and requests its initial state', () => {
  assert.deepEqual(createWebviewHarness().messages, [
    { command: 'setScope', scope: 'project' }, { command: 'ready' }
  ]);
});

test('message input has an accessible name independent of its placeholder', () => {
  assert.equal(createWebviewHarness().element('question').getAttribute('aria-label'), 'Message to DevMate');
});

test('the HTML shell loads only the packaged styles and nonce-protected script', () => {
  const shell = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'webview.ts'), 'utf8');
  assert.match(shell, /style-src \$\{webview.cspSource\}/);
  assert.match(shell, /script-src 'nonce-\$\{nonce\}'/);
  assert.match(shell, /<link rel="stylesheet" href="\$\{stylesheetUri\}">/);
  assert.match(shell, /<script nonce="\$\{nonce\}" src="\$\{scriptUri\}"><\/script>/);
  assert.doesNotMatch(shell, /<style>|<script(?! nonce)/);
});

test('working cards retain visible motion, stable layout and a reduced-motion fallback', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'media', 'webview.css'), 'utf8');
  for (const animation of ['working-card-sheen', 'working-edge-travel', 'working-indicator-ring', 'working-phase-sweep']) {
    assert.match(css, new RegExp('@keyframes\\s+' + animation));
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.working-card\[data-state="working"\][\s\S]+position:\s*sticky/);
  assert.match(css, /\.messages\s*>\s*\*\s*\{[\s\S]*?flex:\s*0\s+0\s+auto/);
});

test('narration summaries preserve letters and normalize whitespace without extracting source text', () => {
  const view = createWebviewHarness();
  const narration = 'Now I understand the issue. The styles reference CSS classes.';
  assert.equal(view.call('compactProviderNarration', narration), narration);
  assert.equal(view.call('compactProviderNarration', 'Multiple   spaces\nstay readable.'), 'Multiple spaces stay readable.');
  assert.ok(view.call('compactProviderNarration', 'A long update '.repeat(50)).length <= 220);
});

test('only explicit request events release Send and the profile/scope controls', () => {
  const view = readyView();
  ask(view);
  for (const id of ['ask', 'attachFiles', 'llmProfileSelector', 'sessionSelector', 'newSessionButton']) {
    assert.equal(view.element(id).disabled, true, id);
  }
  view.receive({ command: 'status', text: 'Ready', level: 'info' });
  assert.equal(view.element('ask').disabled, true);
  view.receive({ command: 'requestFailed', message: 'Provider unavailable', retryable: true });
  assert.equal(view.element('ask').disabled, false);
  assert.equal(view.element('llmProfileSelector').disabled, false);
  assert.equal(view.activeIntervals(), 0);
  assert.match(view.element('messages').textContent, /Provider unavailable/);
});

test('retry sends the existing question without displaying another user turn', () => {
  const view = readyView();
  ask(view);
  view.receive({ command: 'requestFailed', message: 'Try again', retryable: true });
  buttonWithText(view.element('messages'), 'Retry now').click();
  assert.equal(view.messages.at(-1).isNewTurn, false);
  assert.equal(view.messages.at(-1).question, 'Explain this code');
  assert.equal(view.element('messages').querySelectorAll('.message.user').length, 1);
});

test('streamed preview drains before the final answer replaces it and releases Send', () => {
  const view = readyView();
  ask(view);
  view.receive({ command: 'providerStreamDelta', text: 'Reading the current implementation.' });
  view.receive({ command: 'assistantResponse', response: 'The final answer.', fileChanges: [] });
  assert.equal(view.element('ask').disabled, true);
  assert.ok(view.pendingTimeouts() > 0);
  view.flushTimeouts();
  assert.equal(view.element('ask').disabled, false);
  assert.equal(view.element('workingTurn'), null);
  assert.equal(view.element('providerNarration'), null);
  assert.match(view.element('messages').textContent, /The final answer\./);
  assert.equal(view.activeIntervals(), 0);
});

test('cancellation clears queued previews and disables pending permission decisions', () => {
  const view = readyView();
  ask(view);
  view.receive({ command: 'permissionRequest', requestId: 'edit-one', rememberable: false,
    files: [{ path: 'app.ts', operation: 'update', canReview: true }] });
  view.receive({ command: 'providerStreamDelta', text: 'An unfinished update' });
  view.receive({ command: 'requestCancelling' });
  assert.equal(buttonWithText(view.element('messages'), 'Cancelling…').disabled, true);
  view.receive({ command: 'requestCancelled' });
  assert.equal(view.pendingTimeouts(), 0);
  assert.equal(view.element('ask').disabled, false);
  const permission = view.element('messages').querySelector('.permission-card');
  assert.equal(permission.querySelectorAll('button').every((button) => button.disabled), true);
  assert.equal(permission.querySelector('.permission-resolution').textContent, 'Cancelled with request');
});

test('Markdown is rendered as safe DOM nodes, not model-supplied HTML', () => {
  const view = readyView();
  view.receive({ command: 'assistantResponse', response: '**Important**\n<script>alert(1)</script>', fileChanges: [] });
  assert.equal(view.element('messages').querySelector('strong').textContent, 'Important');
  assert.equal(view.element('messages').querySelector('script'), null);
  assert.match(view.element('messages').textContent, /<script>alert\(1\)<\/script>/);
});

test('the composer estimates input tokens and replaces the estimate with reported usage', () => {
  const view = readyView();
  view.element('question').value = '12345678';
  view.element('question').dispatch('input');
  assert.equal(view.element('tokenEstimate').textContent, '≈ 2 tokens');
  view.element('question').value = '';
  view.receive({ command: 'tokenUsageUpdated', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, exact: true } });
  assert.equal(view.element('tokenEstimate').textContent, '30 total');
});

test('backend state labels and recovery buttons follow incoming backend state', () => {
  const view = readyView();
  for (const [state, label] of Object.entries({ online: 'Online', starting: 'Starting', restarting: 'Restarting',
    disabled: 'Unmanaged', checking: 'Checking', offline: 'Offline' })) {
    view.receive({ command: 'backendStatusUpdated', label: 'Backend status', status: { state, detail: 'Detail', canRestart: true } });
    assert.equal(view.element('backendSettingsBadge').textContent, label);
  }
  view.element('restartBackend').click();
  assert.deepEqual(view.messages.at(-1), { command: 'restartBackend' });
  assert.equal(view.element('restartBackend').disabled, true);
  view.element('openBackendLogs').click();
  assert.deepEqual(view.messages.at(-1), { command: 'openBackendLogs' });
});

test('file diff review does not approve the pending operation', () => {
  const view = readyView();
  view.receive({ command: 'permissionRequest', requestId: 'edit-one', rememberable: false,
    files: [{ path: 'app.ts', operation: 'delete', canReview: true }] });
  const card = view.element('messages').querySelector('.permission-card');
  buttonWithText(card, 'Review diff').click();
  assert.deepEqual(view.messages.at(-1), { command: 'reviewPermissionDiff', requestId: 'edit-one', path: 'app.ts' });
  assert.equal(card.querySelector('.permission-resolution').hidden, true);
  assert.equal(card.querySelectorAll('button').some((button) => /Always/.test(button.textContent)), false);
  buttonWithText(card, 'Allow once').click();
  assert.deepEqual(view.messages.at(-1), { command: 'permissionDecision', requestId: 'edit-one', decision: 'allowOnce' });
});

test('non-rememberable dependency permissions offer only one-time approval or denial', () => {
  const view = readyView();
  view.receive({ command: 'commandPermissionRequest', requestId: 'dependency-one', rememberable: false,
    title: 'Install dependencies', label: 'pip install', cwd: 'C:/repo' });
  const card = view.element('messages').querySelector('.permission-card');
  assert.equal(card.querySelectorAll('button').some((button) => /Always/.test(button.textContent)), false);
  buttonWithText(card, 'Allow once').click();
  assert.deepEqual(view.messages.at(-1), { command: 'commandPermissionDecision', requestId: 'dependency-one', decision: 'allowOnce' });
});

test('chat and embedding pickers share their layout but send their own commands', () => {
  const view = readyView();
  view.receive({ command: 'showLlmProfilePicker', profiles: [{ id: 'chat-one', name: 'Chat model',
    model: 'chat', providerLabel: 'Local', builtIn: true, selected: true }] });
  const chat = view.element('llmProfilePickerList');
  assert.equal(chat.querySelector('.model-picker-name').textContent, 'Chat model');
  assert.equal(chat.querySelector('.model-picker-select').getAttribute('aria-selected'), 'true');
  buttonWithText(chat, 'Configure').click();
  assert.deepEqual(view.messages.at(-1), { command: 'editLlmProfile', profileId: 'chat-one' });

  view.receive({ command: 'showEmbeddingProfilePicker', profiles: [{ id: 'embed-one', model: 'embed',
    provider: 'ollama', providerLabel: 'Ollama', baseUrl: 'http://localhost:11434', remoteAllowed: false, selected: true }] });
  const embeddings = view.element('embeddingProfilePickerList');
  assert.equal(embeddings.querySelector('.model-picker-url').textContent, 'http://localhost:11434');
  embeddings.querySelector('.model-picker-select').click();
  assert.deepEqual(view.messages.at(-1), { command: 'selectEmbeddingProfile', profileId: 'embed-one' });
  assert.equal(view.element('permissionDialog').open, true);
});

test('built-in model fields are locked and closing its form removes the entered credential', () => {
  const view = readyView();
  view.receive({ command: 'showLlmProfileForm', hasApiKey: true, profile: { id: 'built-in', name: 'Nemotron',
    model: 'nemotron', provider: 'openai', builtIn: true } });
  for (const id of ['llmProfileName', 'llmProfileProvider', 'llmProfileModel', 'llmProfileBaseUrl']) {
    assert.equal(view.element(id).disabled, true, id);
  }
  assert.equal(view.element('deleteLlmProfile').hidden, true);
  view.element('llmProfileApiKey').value = 'not-a-real-key';
  view.element('cancelLlmProfile').click();
  assert.equal(view.element('llmProfileApiKey').value, '');
  assert.equal(view.element('llmProfileDialog').open, false);
});

test('model context-window input rejects out-of-range values and preserves Auto', () => {
  const view = readyView();
  view.receive({ command: 'showLlmProfileForm', hasApiKey: false });
  view.element('llmProfileName').value = 'Local';
  view.element('llmProfileModel').value = 'local-chat';
  view.element('llmProfileProvider').value = 'ollama';
  for (const invalid of ['512', '4000001']) {
    view.element('llmProfileContextWindowTokens').value = invalid;
    view.element('llmProfileForm').dispatch('submit');
    assert.match(view.element('llmProfileFormError').textContent, /1,024 to 4,000,000/);
  }
  view.element('llmProfileContextWindowTokens').value = '';
  view.element('llmProfileForm').dispatch('submit');
  assert.equal(view.messages.at(-1).command, 'saveLlmProfile');
  assert.equal(Object.hasOwn(view.messages.at(-1).profile, 'contextWindowTokens'), false);
});

test('remote embeddings need explicit consent and clear newly entered credentials on close', () => {
  const view = readyView();
  view.receive({ command: 'showEmbeddingProfileForm', hasApiKey: false });
  view.element('embeddingProfileModel').value = 'embedding-model';
  view.element('embeddingProfileBaseUrl').value = 'https://models.example/v1';
  view.element('embeddingProfileBaseUrl').dispatch('input');
  assert.equal(view.element('embeddingRemoteConsentField').hidden, false);
  view.element('embeddingProfileForm').dispatch('submit');
  assert.match(view.element('embeddingProfileFormError').textContent, /Confirm that this remote provider/);
  view.element('embeddingProfileRemoteAllowed').checked = true;
  view.element('embeddingProfileForm').dispatch('submit');
  assert.equal(view.messages.at(-1).profile.remoteAllowed, true);
  view.element('embeddingProfileApiKey').value = 'not-a-real-key';
  view.element('cancelEmbeddingProfile').click();
  assert.equal(view.element('embeddingProfileApiKey').value, '');
});

test('reasoning choices appear only for supported profiles and send the selected effort', () => {
  const view = readyView();
  assert.equal(view.element('intelligenceControl').hidden, true);
  view.receive({ command: 'llmProfilesUpdated', profileCount: 1, activeProfile: { id: 'reasoning', name: 'Reasoning',
    model: 'reasoner', providerLabel: 'Local', reasoningEffort: 'auto',
    reasoningEffortOptions: [{ value: 'auto', label: 'Auto' }, { value: 'high', label: 'High' }] } });
  assert.equal(view.element('intelligenceControl').hidden, false);
  view.element('intelligenceMenuOptions').querySelectorAll('button')[1].click();
  assert.deepEqual(view.messages.at(-1), { command: 'setReasoningEffort', effort: 'high' });
});

test('settings keep Auto input budgets and tool limits in separate submissions', () => {
  const view = readyView();
  view.element('settingsButton').click();
  assert.equal(view.element('settingsMaxInputContextTokens').value, '');
  view.element('permissionForm').dispatch('submit');
  assert.equal(view.messages.at(-1).settings.maxInputContextTokens, 0);
  view.element('openAgentToolSettings').click();
  assert.equal(view.element('agentToolSettingsDialog').open, true);
  view.element('agentToolSettingsForm').dispatch('submit');
  assert.equal(view.messages.at(-1).command, 'saveAgentToolSettings');
  assert.equal(view.messages.at(-1).settings.readFileMaxLines, 400);
});

test('checkpoint controls and tool usage reflect host events', () => {
  const view = readyView();
  view.receive({ command: 'agentCheckpointUpdated', available: true, used: 3, limit: 16 });
  assert.equal(view.element('continueAgent').hidden, false);
  view.element('continueAgent').click();
  assert.deepEqual(view.messages.at(-1), { command: 'continueAgentRun' });
  view.receive({ command: 'toolUsageUpdated', used: 4, limit: 16 });
  assert.equal(view.element('workingTurn').querySelector('.working-tool-usage').textContent, 'Tools 4 / 16');
});

test('sessions restore the transcript and workspace mismatch warnings return to the landing screen', () => {
  const view = readyView();
  ask(view);
  view.receive({ command: 'sessionsUpdated', sessions: [], activeSessionId: 'saved', activeTitle: 'Saved chat',
    currentWorkspaceName: 'Project A', openChat: true, messages: [{ role: 'user', text: 'Saved question' }] });
  assert.equal(view.element('messages').querySelectorAll('.message').length, 1);
  assert.match(view.element('messages').textContent, /Saved question/);
  assert.equal(view.element('chatApp').hidden, false);
  assert.equal(view.element('ask').disabled, false);
  assert.equal(view.activeIntervals(), 0);
  view.receive({ command: 'sessionProjectWarning', message: 'This chat belongs to another project.' });
  assert.equal(view.element('sessionHome').hidden, false);
  assert.equal(view.element('sessionProjectWarning').hidden, false);
});

test('attachments can be removed through their own host command', () => {
  const view = readyView();
  view.receive({ command: 'attachmentsUpdated', attachments: [{ id: 'file-one', label: 'app.ts' }] });
  assert.equal(view.element('attachmentList').querySelector('.attachment-label').textContent, 'app.ts');
  buttonWithText(view.element('attachmentList'), 'Remove').click();
  assert.deepEqual(view.messages.at(-1), { command: 'removeAttachment', id: 'file-one' });
});

test('code-copy and source-link buttons send commands to the extension', () => {
  const view = readyView();
  view.receive({ command: 'assistantResponse', fileChanges: [],
    response: 'Read `src/app.ts:12`.\n```ts\nconst answer = 42;\n```' });
  buttonWithText(view.element('messages'), 'src/app.ts:12').click();
  assert.deepEqual(view.messages.at(-1), { command: 'openWorkspaceFile', path: 'src/app.ts', line: 12 });
  buttonWithText(view.element('messages'), 'Copy').click();
  assert.deepEqual(view.messages.at(-1), { command: 'copyText', text: 'const answer = 42;' });
});

test('completed file-change summaries preserve counts and open the saved diff', () => {
  const view = readyView();
  view.receive({ command: 'assistantResponse', response: 'Updated.', fileChanges: [
    { kind: 'updated', path: 'app.ts', diffId: 'saved-diff' },
    { kind: 'deleted', path: 'old.ts' }
  ] });
  const summary = view.element('messages').querySelector('.file-change-summary');
  assert.equal(summary.querySelector('.changed').textContent, '+1');
  assert.equal(summary.querySelector('.deleted').textContent, '−1');
  buttonWithText(summary, 'app.ts').click();
  assert.deepEqual(view.messages.at(-1), { command: 'openFileChangeDiff', diffId: 'saved-diff', path: 'app.ts' });
  assert.equal(summary.querySelectorAll('button').length, 1);
});

test('session rows send distinct select, rename and delete commands', () => {
  const view = readyView();
  view.receive({ command: 'sessionsUpdated', sessions: [{ id: 'saved', title: 'Saved chat',
    belongsToCurrentWorkspace: true, workspaceName: 'Project A', turnCount: 2 }],
    activeSessionId: 'saved', activeTitle: 'Saved chat', currentWorkspaceName: 'Project A', openChat: false });
  const list = view.element('sessionList');
  list.querySelector('.session-select').click();
  assert.deepEqual(view.messages.at(-1), { command: 'selectSession', sessionId: 'saved' });
  list.querySelector('[aria-label="Rename session"]').click();
  assert.deepEqual(view.messages.at(-1), { command: 'renameSession', sessionId: 'saved' });
  list.querySelector('[aria-label="Delete session"]').click();
  assert.deepEqual(view.messages.at(-1), { command: 'deleteSession', sessionId: 'saved' });
});

test('tool-setting acknowledgements close only the open tool form and return to settings', () => {
  const view = readyView();
  view.receive({ command: 'agentToolSettingsSaved' });
  assert.equal(view.element('permissionDialog').open, false);
  view.element('openAgentToolSettings').click();
  view.receive({ command: 'agentToolSettingsSaved' });
  assert.equal(view.element('agentToolSettingsDialog').open, false);
  assert.equal(view.element('permissionDialog').open, true);
  view.receive({ command: 'settingsSaved' });
  assert.equal(view.element('permissionDialog').open, false);
});
