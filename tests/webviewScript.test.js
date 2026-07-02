const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('embedded DevMate webview script has valid JavaScript syntax', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  const marker = '<script nonce="${nonce}">';
  const start = source.indexOf(marker);
  const end = source.indexOf('</script>', start);
  assert.ok(start >= 0 && end > start, 'webview script block was not found');
  const script = source.slice(start + marker.length, end);
  const cookedScript = new Function('return `' + script + '`;')();
  assert.doesNotThrow(() => new Function(cookedScript));
});

test('working card has visible motion with a reduced-motion fallback', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  for (const animation of [
    'working-card-sheen',
    'working-edge-travel',
    'working-indicator-ring',
    'working-phase-sweep'
  ]) {
    assert.match(source, new RegExp('@keyframes\\s+' + animation));
  }
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(source, /\.working-card\[data-state="working"\][\s\S]+position:\s*sticky/);
  assert.match(source, /\.messages\s*>\s*\*\s*\{[\s\S]*?flex:\s*0\s+0\s+auto/);
  assert.match(source, /\.working-card\[data-state="working"\][\s\S]*?flex-shrink:\s*0/);
});

test('settings expose the bounded tool-call limit', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  assert.match(source, /id="settingsToolCallLimit"[^>]+min="4"[^>]+max="32"/);
  assert.match(source, /toolCallLimit:\s*16/);
});

test('dependency installation permission cannot be remembered', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  assert.match(source, /Permission required to install Python dependencies/);
  assert.match(source, /rememberable:\s*false/);
  assert.match(source, /if \(message\.rememberable !== false\)/);
});

test('file lifecycle permissions are always one-time and reviewable', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  assert.match(source, /action === 'create' \|\| action === 'update'/);
  assert.match(source, /delete: 'Delete'/);
  assert.match(source, /rename: 'Rename'/);
  assert.match(source, /move: 'Move'/);
  assert.match(source, /review\.textContent = 'Review diff'/);
});

test('only explicit request events release the pending UI state', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  assert.doesNotMatch(source, /const terminalStatus = message\.level/);
  assert.match(source, /if \(message\.command === 'requestFailed'\)[\s\S]*?state\.askPending = false/);
  assert.match(source, /postRequestFailure\('Open a file first\.|message\.scope\.kind === 'selection'/);
  assert.match(source, /finally \{[\s\S]*?this\.activeRequest = undefined/);
  assert.match(source, /button\.disabled = state\.askPending/);
  assert.match(source, /attachFilesEl\.disabled = state\.askPending/);
  assert.match(source, /llmProfileSelectorEl\.disabled = state\.askPending/);
});

test('managed backend state and recovery controls are exposed in the UI', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  const managerSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'backendManager.ts'),
    'utf8'
  );
  assert.match(source, /id="backendStatus"/);
  assert.match(source, /id="restartBackend"/);
  assert.match(source, /id="openBackendLogs"/);
  assert.match(source, /message\.command === 'backendStatusUpdated'/);
  assert.match(source, /backendDropped[\s\S]*?retryable:/);
  assert.doesNotMatch(managerSource, /['"]--reload['"]/);
});

test('slow provider calls replace the static generating phase with a waiting heartbeat', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  assert.match(source, /Waiting for model response — the selected model is still working/);
  assert.match(source, /}, 15_000\);/);
  assert.match(source, /clearTimeout\(waitingTimer\)/);
});

test('provider streaming and safe rich answer rendering are wired into the chat', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  const clientSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'api', 'client.ts'),
    'utf8'
  );
  assert.match(clientSource, /export async function askStream/);
  assert.match(clientSource, /'\/ask\/stream'/);
  assert.match(source, /command: 'providerStreamDelta'/);
  assert.match(source, /message\.command === 'providerStreamDelta'/);
  assert.match(source, /function renderMarkdown/);
  assert.match(source, /function appendHighlightedCode/);
  assert.match(source, /command: 'copyText'/);
  assert.match(source, /command: 'openWorkspaceFile'/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
});

test('streamed output is visibly drained before the final answer replaces it', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  assert.match(source, /streamQueue:\s*''/);
  assert.match(source, /pendingAssistantResponse:\s*undefined/);
  assert.match(source, /function pumpProviderStream\(\)/);
  assert.match(source, /state\.pendingAssistantResponse = message\.response/);
  assert.match(source, /completeAssistantResponse\(response\)/);
  assert.match(source, /Live streaming unavailable — waiting for the completed response/);
});

test('composer shows a live token estimate and a compact ask action', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  assert.match(source, /id="tokenEstimate"/);
  assert.match(source, /class="action-button primary ask-button"/);
  assert.match(source, /questionEl\.addEventListener\('input', renderTokenEstimate\)/);
  assert.match(source, /Math\.ceil\(characterCount \/ 4\)/);
  assert.match(source, /project context and the response are not included/);
});

test('built-in Nemotron setup locks provider fields while keeping the API key configurable', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  assert.match(source, /profile\?\.builtIn === true/);
  assert.match(source, /llmProfileNameEl\.disabled = isBuiltIn/);
  assert.match(source, /llmProfileProviderEl\.disabled = isBuiltIn/);
  assert.match(source, /Configure built-in Nemotron/);
  assert.match(source, /Save API key/);
  assert.match(source, /The built-in Nemotron profile cannot be deleted/);
});

test('project-bound sessions open from a dedicated landing screen', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  assert.match(source, /id="sessionSelector"/);
  assert.match(source, /id="newSessionButton"/);
  assert.match(source, /id="sessionHome"/);
  assert.match(source, /id="chatApp"[^>]+hidden/);
  assert.match(source, /id="sessionProjectWarning"/);
  assert.match(source, /message\.command === 'sessionsUpdated'/);
  assert.match(source, /message\.command === 'sessionProjectWarning'/);
  assert.match(source, /command: 'selectSession'/);
  assert.match(source, /command: 'renameSession'/);
  assert.match(source, /command: 'deleteSession'/);
  assert.match(source, /sessionSelectorEl\.disabled = state\.askPending/);
  assert.match(source, /newSessionButtonEl\.disabled = state\.askPending/);
  assert.match(source, /sessionBelongsToWorkspace\(session, workspace\)/);
  assert.match(source, /extensionContext\.globalState\.get/);
});
