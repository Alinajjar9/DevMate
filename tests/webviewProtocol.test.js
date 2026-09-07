const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { createWebviewHarness } = require('./helpers/webviewHarness');

const { parseWebviewMessage } = require('../out/chat/webviewProtocol');

const validMessages = [
  {
    command: 'ask',
    mode: 'code',
    question: 'Update the greeting.',
    scope: { kind: 'project', label: 'Project', detail: 'Current workspace' },
    isNewTurn: true
  },
  { command: 'continueAgentRun' },
  { command: 'cancelRequest' },
  { command: 'setScope', scope: 'activeFile' },
  { command: 'pickFiles' },
  { command: 'removeAttachment', id: 'attachment-one' },
  { command: 'chooseLlmProfile' },
  { command: 'selectLlmProfile', profileId: 'profile-one' },
  { command: 'setReasoningEffort', effort: 'medium' },
  { command: 'addLlmProfile' },
  { command: 'editLlmProfile', profileId: 'profile-one' },
  { command: 'deleteLlmProfile', profileId: 'profile-one' },
  {
    command: 'saveLlmProfile',
    profile: {
      id: 'profile-one',
      name: 'Local model',
      provider: 'ollama',
      model: 'qwen3-coder',
      baseUrl: 'http://127.0.0.1:11434',
      contextWindowTokens: 32_000
    }
  },
  { command: 'chooseEmbeddingProfile' },
  { command: 'selectEmbeddingProfile', profileId: 'embedding-one' },
  { command: 'addEmbeddingProfile' },
  { command: 'editEmbeddingProfile', profileId: 'embedding-one' },
  { command: 'deleteEmbeddingProfile', profileId: 'embedding-one' },
  {
    command: 'saveEmbeddingProfile',
    profile: {
      id: 'embedding-one',
      provider: 'ollama',
      model: 'nomic-embed-text',
      baseUrl: 'http://127.0.0.1:11434',
      remoteAllowed: false
    }
  },
  {
    command: 'saveSettings',
    settings: {
      timeoutSeconds: 900,
      commandTimeoutSeconds: 300,
      toolCallLimit: 16,
      maxTokens: 8_000,
      maxInputContextTokens: 32_000,
      temperature: 0.2,
      policy: { createFiles: 'ask', updateFiles: 'allow' }
    }
  },
  {
    command: 'saveAgentToolSettings',
    settings: {
      readFileMaxLines: 400,
      listFilesMaxResults: 200,
      searchCodeMaxResults: 50,
      diagnosticsMaxResults: 100,
      terminalErrorsMaxResults: 5,
      codeNavigationMaxResults: 100
    }
  },
  { command: 'reviewPermissionDiff', requestId: 'request-one', path: 'src/app.ts' },
  { command: 'revokeRememberedCommand', signature: 'npm test' },
  { command: 'clearRememberedCommands' },
  { command: 'restartBackend' },
  { command: 'openBackendLogs' },
  { command: 'newSession' },
  { command: 'selectSession', sessionId: 'session-one' },
  { command: 'renameSession', sessionId: 'session-one' },
  { command: 'deleteSession', sessionId: 'session-one' },
  { command: 'copyText', text: 'const answer = 42;' },
  { command: 'openWorkspaceFile', path: 'src/app.ts', line: 12 },
  { command: 'openFileChangeDiff', diffId: 'diff-one', path: 'src/app.ts' },
  { command: 'openExternalLink', url: 'https://example.com/docs' },
  {
    command: 'commandPermissionDecision',
    requestId: 'command-one',
    decision: 'allowOnce'
  },
  { command: 'openCommandTerminal', activityId: 'activity-one' },
  {
    command: 'permissionDecision',
    requestId: 'permission-one',
    decision: 'deny'
  },
  { command: 'ready' }
];

test('accepts every supported webview command shape', () => {
  for (const message of validMessages) {
    assert.equal(parseWebviewMessage(message), message, message.command);
  }
});

test('rejects unknown, malformed, and unexpectedly extended webview messages', () => {
  const invalidMessages = [
    undefined,
    'ready',
    { command: 'unknownCommand' },
    { command: 'ready', unexpected: true },
    { command: 'ask', mode: 'fast', question: 'Hello', scope: {} },
    { command: 'setScope', scope: 'wholeComputer' },
    {
      command: 'saveLlmProfile',
      profile: {
        name: 'Local model',
        provider: 'ollama',
        model: 'qwen3-coder',
        unexpected: true
      }
    },
    {
      command: 'saveSettings',
      settings: {
        timeoutSeconds: Number.NaN,
        commandTimeoutSeconds: 300,
        toolCallLimit: 16,
        maxTokens: 8_000,
        maxInputContextTokens: 32_000,
        temperature: 0.2,
        policy: { createFiles: 'ask', updateFiles: 'allow' }
      }
    },
    {
      command: 'permissionDecision',
      requestId: 'permission-one',
      decision: 'allowForever'
    }
  ];

  for (const message of invalidMessages) {
    assert.equal(parseWebviewMessage(message), undefined);
  }
});

test('browser-side handlers cover every typed extension event', () => {
  const repositoryRoot = path.join(__dirname, '..');
  const protocolSource = fs.readFileSync(
    path.join(repositoryRoot, 'src', 'chat', 'webviewProtocol.ts'),
    'utf8'
  );
  const syntax = ts.createSourceFile('webviewProtocol.ts', protocolSource, ts.ScriptTarget.Latest);
  const outputUnion = syntax.statements.find((node) => ts.isTypeAliasDeclaration(node)
    && node.name.text === 'ExtensionToWebviewMessage');
  assert.ok(outputUnion && ts.isUnionTypeNode(outputUnion.type));
  const typedCommands = outputUnion.type.types.map((eventType) => {
    assert.ok(ts.isTypeLiteralNode(eventType), 'Each event must declare its command.');
    const command = eventType.members.find((member) => member.name?.getText(syntax) === 'command');
    assert.ok(command?.type && ts.isLiteralTypeNode(command.type));
    return command.type.literal.text;
  }).sort();
  const handledCommands = createWebviewHarness().supportedCommands().sort();

  assert.deepEqual(handledCommands, typedCommands);
});
