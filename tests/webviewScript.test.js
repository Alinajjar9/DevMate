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
  assert.doesNotThrow(() => new Function(script));
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
