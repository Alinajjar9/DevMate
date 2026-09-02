const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function readSource(...segments) {
  return fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8');
}

function readExtensionHostSource() {
  return [
    readSource('src', 'extension.ts'),
    readSource('src', 'agent', 'agentCheckpointController.ts'),
    readSource('src', 'agent', 'agentRunController.ts'),
    readSource('src', 'context', 'attachmentController.ts'),
    readSource('src', 'chat', 'chatViewProvider.ts'),
    readSource('src', 'chat', 'chatRequestController.ts'),
    readSource('src', 'workspace', 'diffPresenter.ts'),
    readSource('src', 'settings', 'llmProfileController.ts'),
    readSource('src', 'workspace', 'permissionController.ts'),
    readSource('src', 'workspace', 'permissionPresenter.ts'),
    readSource('src', 'settings', 'profilePresenter.ts'),
    readSource('src', 'settings', 'settingsController.ts'),
    readSource('src', 'settings', 'settingsPresenter.ts'),
    readSource('src', 'sessions', 'sessionController.ts'),
    readSource('src', 'sessions', 'sessionPresenter.ts'),
    readSource('src', 'agent', 'toolExecutor.ts'),
    readSource('src', 'context', 'workspaceContext.ts'),
    readSource('src', 'workspace', 'workspaceMutations.ts'),
    readSource('src', 'settings', 'embeddingProfileController.ts')
  ].join('\n');
}

function readDevMateSource() {
  return [
    readExtensionHostSource(),
    readSource('src', 'chat', 'webview.ts'),
    readSource('media', 'webview.css'),
    readSource('media', 'webview.js')
  ].join('\n');
}

test('DevMate webview script has valid JavaScript syntax', () => {
  const script = readSource('media', 'webview.js');
  assert.doesNotThrow(() => new Function(script));
});

test('chat view provider delegates webview markup to packaged UI assets', () => {
  const providerSource = readSource('src', 'chat', 'chatViewProvider.ts');
  const shellSource = readSource('src', 'chat', 'webview.ts');

  assert.match(providerSource, /getChatWebviewHtml\(webviewView\.webview, this\.extensionUri\)/);
  assert.match(
    providerSource,
    /localResourceRoots:\s*\[vscode\.Uri\.joinPath\(this\.extensionUri, 'media'\)\]/
  );
  assert.doesNotMatch(providerSource, /<style>|<script/);
  assert.match(shellSource, /asWebviewUri\([\s\S]*?'media', 'webview\.css'/);
  assert.match(shellSource, /asWebviewUri\([\s\S]*?'media', 'webview\.js'/);
  assert.match(shellSource, /style-src \$\{webview\.cspSource\}/);
  assert.match(shellSource, /script-src 'nonce-\$\{nonce\}'/);
  assert.match(shellSource, /<link rel="stylesheet" href="\$\{stylesheetUri\}">/);
  assert.match(shellSource, /<script nonce="\$\{nonce\}" src="\$\{scriptUri\}"><\/script>/);
});

test('working card has visible motion with a reduced-motion fallback', () => {
  const source = readDevMateSource();
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
  const cookedScript = readSource('media', 'webview.js');
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
  const source = readDevMateSource();
  assert.match(source, /id="settingsToolCallLimit"[^>]+min="4"[^>]+max="100"/);
  assert.match(source, /toolCallLimit:\s*16/);
});

test('dependency installation permission cannot be remembered', () => {
  const source = readDevMateSource();
  assert.match(source, /Permission required to install Python dependencies/);
  assert.match(source, /rememberable:\s*false/);
  assert.match(source, /if \(message\.rememberable !== false\)/);
});

test('file lifecycle permissions are always one-time and reviewable', () => {
  const source = readDevMateSource();
  assert.match(source, /action === 'create' \|\| action === 'update'/);
  assert.match(source, /delete: 'Delete'/);
  assert.match(source, /rename: 'Rename'/);
  assert.match(source, /move: 'Move'/);
  assert.match(source, /review\.textContent = 'Review diff'/);
});

test('only explicit request events release the pending UI state', () => {
  const source = readDevMateSource();
  assert.doesNotMatch(source, /const terminalStatus = message\.level/);
  assert.match(source, /if \(message\.command === 'requestFailed'\)[\s\S]*?state\.askPending = false/);
  assert.match(source, /postRequestFailure\('Open a file first\.|message\.scope\.kind === 'selection'/);
  assert.match(source, /finally \{[\s\S]*?this\.activeRequest = undefined/);
  assert.match(source, /button\.disabled = state\.askPending/);
  assert.match(source, /attachFilesEl\.disabled = state\.askPending/);
  assert.match(source, /llmProfileSelectorEl\.disabled = state\.askPending/);
});

test('managed backend state and recovery controls are exposed in the UI', () => {
  const source = readDevMateSource();
  const managerSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'api', 'backendManager.ts'),
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
  const source = readDevMateSource();
  assert.match(source, /Waiting for model response — the selected model is still working/);
  assert.match(source, /}, 15_000\);/);
  assert.match(source, /clearTimeout\(waitingTimer\)/);
});

test('provider streaming and safe rich answer rendering are wired into the chat', () => {
  const source = readDevMateSource();
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
  const source = readDevMateSource();
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
  const source = readDevMateSource();
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
  const source = readDevMateSource();
  assert.match(source, /profile\?\.builtIn === true/);
  assert.match(source, /llmProfileNameEl\.disabled = isBuiltIn/);
  assert.match(source, /llmProfileProviderEl\.disabled = isBuiltIn/);
  assert.match(source, /Configure built-in Nemotron/);
  assert.match(source, /Save API key/);
  assert.match(source, /The built-in Nemotron profile cannot be deleted/);
});

test('model selection uses a DevMate-styled modal instead of a native Quick Pick', () => {
  const source = readDevMateSource();
  assert.match(source, /id="llmProfilePickerDialog"/);
  assert.match(source, /class="profile-dialog model-picker-dialog"/);
  assert.match(source, /command: 'showLlmProfilePicker'/);
  assert.match(source, /command: 'selectLlmProfile'/);
  assert.match(source, /command: 'editLlmProfile'/);
  assert.match(source, /deleteLlmProfileEl\.dataset\.confirm/);
  const selectorImplementation = source.slice(
    source.indexOf('chooseLlmProfile(): void'),
    source.indexOf('async selectLlmProfile')
  );
  assert.doesNotMatch(selectorImplementation, /showQuickPick/);
});

test('recognized reasoning models expose a compact icon intelligence menu beside the model', () => {
  const source = readDevMateSource();
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
  const source = readDevMateSource();
  assert.match(source, /id="openAgentToolSettings"/);
  assert.match(source, /id="agentToolSettingsDialog"/);
  assert.match(source, /id="settingsReadFileMaxLines"[^>]*max="1000"/);
  assert.match(source, /command: 'saveAgentToolSettings'/);
  assert.match(source, /agentTools: this\.agentToolSettings\(\)/);
});

test('model and global context limits expose validated Auto controls', () => {
  const source = readDevMateSource();
  assert.match(source, /id="llmProfileContextWindowTokens"/);
  assert.match(source, /id="settingsMaxInputContextTokens"/);
  assert.match(source, /contextWindowTokens < 1024/);
  assert.match(source, /contextWindowTokens > 4000000/);
  assert.match(source, /maxInputContextTokens: 0/);
  assert.match(source, /settingsMaxInputContextTokensEl\.value\.trim\(\)/);
  assert.match(source, /contextWindowTokens,/);
  assert.match(source, /maxInputContextTokens,/);
});

test('settings manage separate embedding profiles with explicit remote consent', () => {
  const source = readDevMateSource();
  assert.match(source, /id="manageEmbeddingProfiles"/);
  assert.match(source, /id="embeddingProfilePickerDialog"/);
  assert.match(source, /id="embeddingProfileDialog"/);
  assert.match(source, /id="embeddingProfileRemoteAllowed"/);
  assert.match(
    source,
    /Allow this remote provider to receive project source code and search queries/
  );
  assert.match(source, /command: 'saveEmbeddingProfile'/);
  assert.match(source, /remoteAllowed: remote && embeddingProfileRemoteAllowedEl\.checked/);
  assert.match(source, /embeddingSecretKeyForProfile/);
  assert.match(source, /extensionContext\.secrets\.store/);
  assert.match(source, /refreshActiveProfile/);
});

test('working UI exposes tool usage and resumable agent checkpoints', () => {
  const source = readDevMateSource();
  assert.match(source, /className = 'working-tool-usage'/);
  assert.match(source, /Tools ' \+ state\.toolUsage\.used \+ ' \/ '/);
  assert.match(source, /id="continueAgent"/);
  assert.match(source, /command: 'continueAgentRun'/);
  assert.match(source, /message\.command === 'agentCheckpointUpdated'/);
  assert.match(source, /retrying with reasoning disabled/);
  assert.match(source, /requesting final summary without tools/);
});

test('agent can inspect workspace diagnostics and captured terminal failures', () => {
  const source = readDevMateSource();
  const backendSource = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'app', 'chat', 'tool_catalog.py'),
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
  const source = readDevMateSource();
  const backendSource = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'app', 'chat', 'tool_catalog.py'),
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
  const source = readDevMateSource();
  assert.match(source, /className = 'file-change-summary'/);
  assert.match(source, /className = 'file-change-row'/);
  assert.match(source, /gitDecoration-addedResourceForeground/);
  assert.match(source, /gitDecoration-deletedResourceForeground/);
  assert.match(source, /appendFileChangeSummary\(narration, fileChanges\)/);
  assert.match(source, /fileChanges: turn\.fileChanges \?\? \[\]/);
  assert.match(
    source,
    /collectFileChangeSummary\(\s*outcome\.toolHistory,\s*appliedResponseChanges\s*\)/
  );
  assert.match(source, /command: 'openFileChangeDiff'/);
  assert.match(source, /'vscode\.diff'/);
  assert.match(source, /rememberCompletedFileDiff/);
});

test('project-bound sessions open from a dedicated landing screen', () => {
  const source = readDevMateSource();
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
  assert.match(source, /repository\.loadWorkspace/);
});

test('new user messages persist independently from failed assistant requests', () => {
  const source = readDevMateSource();
  assert.match(source, /appendConversationSessionUserMessage\(/);
  assert.match(source, /isNewTurn:\s*true/);
  assert.match(source, /isNewTurn:\s*false/);
  assert.match(source, /turn\.assistant[\s\S]*?role: 'assistant'/);
});

test('exhausted agent runs finalize locally instead of looping checkpoints', () => {
  const source = readDevMateSource();
  assert.match(source, /consecutiveAgentInspectionCalls\(toolHistory\)/);
  assert.match(source, /Finalizing from completed project-tool work/);
  assert.match(source, /summarizeAgentToolHistory\(toolHistory, errorMessage\)/);
  assert.match(source, /Model stopped before acting — retrying with project tools/);
  assert.match(source, /described what it would do but did not call a project tool/);
});
