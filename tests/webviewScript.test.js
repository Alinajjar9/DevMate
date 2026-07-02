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
  assert.doesNotMatch(source, /working-ellipsis/);
  assert.doesNotMatch(source, /\.working-heading::after/);
});

test('narration compaction preserves letters while normalizing whitespace', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  const marker = '<script nonce="' + '$' + '{nonce}">';
  const start = source.indexOf(marker);
  const end = source.indexOf('</script>', start);
  const script = source.slice(start + marker.length, end);
  const tick = String.fromCharCode(96);
  const cookedScript = new Function('return ' + tick + script + tick + ';')();
  const functionStart = cookedScript.indexOf('function compactProviderNarration(value)');
  const functionEnd = cookedScript.indexOf('function completeAssistantResponse', functionStart);
  const functionSource = cookedScript.slice(functionStart, functionEnd);
  const compact = new Function(
    'MAX_INTERMEDIATE_NARRATION_CHARACTERS',
    functionSource + '; return compactProviderNarration;'
  )(220);

  const narration = 'Now I understand the issue. The styles reference CSS classes.';
  assert.equal(compact(narration), narration);
  assert.equal(compact('Multiple   spaces\nstay readable.'), 'Multiple spaces stay readable.');
});

test('settings expose the bounded tool-call limit', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  assert.match(source, /id="settingsToolCallLimit"[^>]+min="4"[^>]+max="100"/);
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
  assert.match(source, /className = 'message assistant model-narration'/);
  assert.match(source, /MAX_INTERMEDIATE_NARRATION_CHARACTERS = 220/);
  assert.match(source, /function compactProviderNarration\(value\)/);
  assert.match(source, /author\.textContent = 'DevMate update'/);
  assert.match(source, /finalizeProviderNarration\(\);[\s\S]*?renderAgentToolActivity/);
  assert.doesNotMatch(source, /#workingTurn \.working-stream/);
  assert.match(source, /state\.pendingAssistantResponse = completion/);
  assert.match(source, /completeAssistantResponse\(completion\.response, completion\.fileChanges\)/);
  assert.match(source, /Live streaming unavailable — waiting for the completed response/);
});

test('composer shows a live token estimate and a compact ask action', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  assert.match(source, /id="tokenEstimate"/);
  assert.match(source, /class="action-button primary ask-button"/);
  assert.doesNotMatch(source, /ask-button-icon/);
  assert.match(source, /questionEl\.addEventListener\('input', renderTokenEstimate\)/);
  assert.match(source, /Math\.ceil\(characterCount \/ 4\)/);
  assert.match(source, /full prompt and response usage appears here/);
  assert.match(source, /message\.command === 'tokenUsageUpdated'/);
  assert.match(source, /Input ' \+ marker/);
  assert.match(source, /formatTokenCount\(usage\.totalTokens\) \+ ' total'/);
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

test('model selection uses a DevMate-styled modal instead of a native Quick Pick', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  assert.match(source, /id="llmProfilePickerDialog"/);
  assert.match(source, /class="profile-dialog model-picker-dialog"/);
  assert.match(source, /command: 'showLlmProfilePicker'/);
  assert.match(source, /command: 'selectLlmProfile'/);
  assert.match(source, /command: 'editLlmProfile'/);
  assert.match(source, /deleteLlmProfileEl\.dataset\.confirm/);
  const selectorImplementation = source.slice(
    source.indexOf('private chooseLlmProfile'),
    source.indexOf('private async selectLlmProfile')
  );
  assert.doesNotMatch(selectorImplementation, /showQuickPick/);
});

test('recognized reasoning models expose a compact icon intelligence menu beside the model', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  assert.match(source, /id="intelligenceButton"/);
  assert.match(source, /class="intelligence-icon-button"/);
  assert.match(source, /id="intelligenceMenu"/);
  assert.match(source, /className = 'intelligence-menu-option'/);
  assert.match(source, /command: 'setReasoningEffort'/);
  assert.match(source, /reasoningEffortOptionsForProfile/);
  assert.match(source, /intelligenceControlEl\.hidden = reasoningOptions\.length <= 1/);
  assert.match(source, /intelligenceButtonEl\.disabled = state\.askPending/);
  assert.doesNotMatch(source, /id="modelIntelligencePanel"/);
  assert.doesNotMatch(source, /id="reasoningEffort"/);
});

test('settings expose a separate bounded agent-tool limits dialog', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  assert.match(source, /id="openAgentToolSettings"/);
  assert.match(source, /id="agentToolSettingsDialog"/);
  assert.match(source, /id="settingsReadFileMaxLines"[^>]*max="1000"/);
  assert.match(source, /command: 'saveAgentToolSettings'/);
  assert.match(source, /agentTools: this\.getAgentToolSettings\(\)/);
});

test('working UI exposes tool usage and resumable agent checkpoints', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  assert.match(source, /className = 'working-tool-usage'/);
  assert.match(source, /Tools ' \+ state\.toolUsage\.used \+ ' \/ '/);
  assert.match(source, /id="continueAgent"/);
  assert.match(source, /command: 'continueAgentRun'/);
  assert.match(source, /message\.command === 'agentCheckpointUpdated'/);
  assert.match(source, /retrying with reasoning disabled/);
  assert.match(source, /requesting final summary without tools/);
});

test('agent can inspect workspace diagnostics and captured terminal failures', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  const backendSource = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'app', 'main.py'),
    'utf8'
  );
  assert.match(source, /onDidStartTerminalShellExecution/);
  assert.match(source, /vscode\.languages\.getDiagnostics\(\)/);
  assert.match(source, /event\.terminal\.name\.startsWith\('DevMate:'\)/);
  assert.match(source, /shouldSkipProjectFile\(relativePath\)/);
  assert.match(source, /'get_diagnostics'/);
  assert.match(source, /'read_terminal_errors'/);
  assert.match(backendSource, /name="get_diagnostics"/);
  assert.match(backendSource, /name="read_terminal_errors"/);
});

test('agent can navigate symbols, definitions, and references through VS Code providers', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  const backendSource = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'app', 'main.py'),
    'utf8'
  );
  assert.match(source, /'vscode\.executeDocumentSymbolProvider'/);
  assert.match(source, /'vscode\.executeDefinitionProvider'/);
  assert.match(source, /'vscode\.executeReferenceProvider'/);
  assert.match(source, /codeNavigationMaxResults/);
  assert.match(backendSource, /name="get_symbols"/);
  assert.match(backendSource, /name="find_definition"/);
  assert.match(backendSource, /name="find_references"/);
});

test('completed answers show persistent green and red file-change summaries', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  assert.match(source, /className = 'file-change-summary'/);
  assert.match(source, /className = 'file-change-row'/);
  assert.match(source, /gitDecoration-addedResourceForeground/);
  assert.match(source, /gitDecoration-deletedResourceForeground/);
  assert.match(source, /appendFileChangeSummary\(narration, fileChanges\)/);
  assert.match(source, /fileChanges: turn\.fileChanges \?\? \[\]/);
  assert.match(source, /collectFileChangeSummary\(toolHistory, appliedResponseChanges\)/);
  assert.match(source, /command: 'openFileChangeDiff'/);
  assert.match(source, /'vscode\.diff'/);
  assert.match(source, /rememberCompletedFileDiff/);
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

test('new user messages persist independently from failed assistant requests', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  assert.match(source, /appendConversationSessionUserMessage\(/);
  assert.match(source, /isNewTurn:\s*true/);
  assert.match(source, /isNewTurn:\s*false/);
  assert.match(source, /turn\.assistant[\s\S]*?role: 'assistant'/);
});

test('exhausted agent runs finalize locally instead of looping checkpoints', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  assert.match(source, /consecutiveAgentInspectionCalls\(toolHistory\)/);
  assert.match(source, /Finalizing from completed project-tool work/);
  assert.match(source, /summarizeAgentToolHistory\(toolHistory, errorMessage\)/);
  assert.match(source, /Model stopped before acting — retrying with project tools/);
  assert.match(source, /described what it would do but did not call a project tool/);
});
