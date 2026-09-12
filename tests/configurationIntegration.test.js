const assert = require('node:assert/strict');
const test = require('node:test');
const { createVscodeHarness } = require('./helpers/vscode');
const harness = createVscodeHarness();
const { DevMateChatViewProvider } = harness.load('chatViewProvider');
const { BUILT_IN_NEMOTRON_PROFILE, LLM_PROFILES_STORAGE_KEY, ACTIVE_LLM_PROFILE_STORAGE_KEY,
  secretKeyForProfile } = require('../out/llmProfiles');

function setup(profiles = []) {
  harness.configuration.clear(); harness.workspaceConfiguration.clear();
  const context = harness.context({ global: { [LLM_PROFILES_STORAGE_KEY]: profiles,
    [ACTIVE_LLM_PROFILE_STORAGE_KEY]: profiles[0]?.id } });
  const keys = new Map();
  context.secrets = { get: async key => keys.get(key), store: async (key, value) => keys.set(key, value),
    delete: async key => keys.delete(key) };
  const provider = new DevMateChatViewProvider(context,
    { start: async () => true, status: { detail: 'online', state: 'running' } }, { show() {} });
  const messages = [];
  provider.postMessage = message => messages.push(message);
  return { provider, context, keys, messages };
}

test('legacy model migration preserves built-in credentials and explicitly configured duplicate profiles', async () => {
  const builtIn = { ...BUILT_IN_NEMOTRON_PROFILE, settings: { maxTokens: 4096 } };
  const custom = { ...BUILT_IN_NEMOTRON_PROFILE, id: 'my-nemotron', name: 'My Nemotron', settings: {} };
  const run = setup([builtIn, custom]);
  const key = secretKeyForProfile(builtIn.id);
  run.keys.set(key, 'test-key');
  try {
    await run.provider.migrateBuiltInNemotronProfile();
    assert.equal(run.keys.get(key), 'test-key');
    assert.equal(run.provider.getLlmProfiles().find(profile => profile.id === builtIn.id).settings.maxTokens, 4096);
    assert.ok(run.provider.getLlmProfiles().some(profile => profile.id === custom.id));
  } finally { run.provider.dispose(); }
});

test('an explicit Auto choice overrides a model profile that defaults to high reasoning', async () => {
  const run = setup([{ id: 'local-model', name: 'Local model', provider: 'ollama', model: 'example',
    settings: { reasoningEffort: 'high' } }]);
  try {
    assert.equal(run.provider.configuration.effective().reasoningEffort, 'high');
    await run.provider.handleMessage({ command: 'setReasoningEffort', effort: 'auto' });
    assert.equal(run.provider.configuration.effective().reasoningEffort, 'auto');
    const state = run.messages.filter(message => message.command === 'llmProfilesUpdated').at(-1);
    assert.equal(state.activeProfile.reasoningEffort, 'auto');
  } finally { run.provider.dispose(); }
});

test('the settings controller accepts the UI scope field without changing other projects', async () => {
  const run = setup();
  try {
    await run.provider.handleMessage({ command: 'saveSettings', scope: 'workspace', settings: {
      timeoutSeconds: 60, commandTimeoutSeconds: 30, toolCallLimit: 12, maxTokens: 2048, temperature: 0.4,
      policy: { createFiles: 'ask', updateFiles: 'ask' }
    } });
    assert.equal(harness.configuration.size, 0);
    assert.equal(harness.workspaceConfiguration.has('requestTimeoutSeconds'), false);
    assert.equal(harness.workspaceConfiguration.get('configuration').timeoutSeconds, 60);
    assert.equal(harness.workspaceConfiguration.get('configuration').maxTokens, 2048);
    assert.ok(run.messages.some(message => message.command === 'settingsSaved'));
  } finally { run.provider.dispose(); }
});

test('one settings save preserves inheritance and includes project rules, tools and permissions', async () => {
  const run = setup();
  harness.configuration.set('configuration', { maxTokens: 8192, instructions: 'Global rules.' });
  harness.configuration.set('readFileMaxLines', 650);
  try {
    await run.provider.handleMessage({ command: 'saveSettings', scope: 'workspace', settings: {
      configuration: { instructions: 'Use project conventions.', maxRepairAttempts: 2 },
      agentTools: { searchCodeMaxResults: 70 }, policy: { createFiles: 'ask', updateFiles: 'allow' }
    } });
    assert.deepEqual(harness.workspaceConfiguration.get('configuration'), {
      instructions: 'Use project conventions.', maxRepairAttempts: 2
    });
    assert.equal(harness.workspaceConfiguration.has('readFileMaxLines'), false);
    assert.equal(harness.workspaceConfiguration.get('searchCodeMaxResults'), 70);
    assert.equal(run.provider.configuration.effective().maxTokens, 8192);
    harness.configuration.set('configuration', { maxTokens: 4096 });
    assert.equal(run.provider.configuration.effective().maxTokens, 4096, 'unchanged fields still follow global settings');
    const settings = run.messages.filter(message => message.command === 'settingsUpdated').at(-1).settings;
    assert.deepEqual(settings.agentToolOverrides, { searchCodeMaxResults: 70 });
    assert.equal(settings.inheritedAgentTools.readFileMaxLines, 650);
    assert.equal(run.provider.getPermissionPolicy().updateFiles, 'allow');
    assert.ok(run.messages.some(message => message.command === 'settingsSaved'));
  } finally { run.provider.dispose(); }
});

test('invalid merged settings are rejected before any preferences or permissions are written', async () => {
  const run = setup();
  try {
    for (const settings of [
      { configuration: { instructions: 'New rules' }, agentTools: { readFileMaxLines: 20 } },
      { configuration: { maxCommands: -1 }, agentTools: { readFileMaxLines: 500 } },
      { configuration: {}, agentTools: { unsupportedTool: 5 } }
    ]) {
      await run.provider.handleMessage({ command: 'saveSettings', scope: 'workspace', settings: {
        ...settings, policy: { createFiles: 'allow', updateFiles: 'allow' }
      } });
      assert.equal(run.messages.at(-1).command, 'settingsError');
      assert.equal(harness.configuration.size, 0);
      assert.equal(harness.workspaceConfiguration.size, 0);
      assert.equal(run.context.workspaceValues.size, 0);
      assert.equal(run.provider.auxiliaryBusy, false);
    }
  } finally { run.provider.dispose(); }
});

test('resetting a scope removes its legacy and tool overrides without changing global defaults', async () => {
  const run = setup();
  harness.configuration.set('configuration', { maxTokens: 4096, instructions: 'Global rules.' });
  harness.configuration.set('readFileMaxLines', 600);
  harness.workspaceConfiguration.set('configuration', { maxTokens: 2048, instructions: 'Project rules.' });
  harness.workspaceConfiguration.set('requestTimeoutSeconds', 50);
  harness.workspaceConfiguration.set('readFileMaxLines', 700);
  try {
    await run.provider.handleMessage({ command: 'saveSettings', scope: 'workspace', settings: {
      configuration: {}, agentTools: {}, policy: { createFiles: 'ask', updateFiles: 'ask' }
    } });
    assert.deepEqual(harness.workspaceConfiguration.get('configuration'), {});
    assert.equal(harness.workspaceConfiguration.has('readFileMaxLines'), false);
    assert.equal(harness.workspaceConfiguration.has('requestTimeoutSeconds'), false);
    assert.equal(run.provider.configuration.effective().maxTokens, 4096);
    assert.equal(run.provider.configuration.effective().instructions, 'Global rules.');
    assert.equal(run.provider.getAgentToolSettings().readFileMaxLines, 600);
  } finally { run.provider.dispose(); }
});

test('saving settings blocks a new run until persistence finishes', async () => {
  const run = setup();
  let finish;
  run.provider.configuration.saveConfiguration = () => new Promise(resolve => { finish = resolve; });
  try {
    const saving = run.provider.handleMessage({ command: 'saveSettings', scope: 'global', settings: {
      configuration: {}, agentTools: {}, policy: { createFiles: 'ask', updateFiles: 'ask' }
    } });
    await run.provider.handleMessage({ command: 'ask', mode: 'ideas', question: 'Explain this', scope: { kind: 'project' } });
    assert.ok(run.messages.some(message => message.command === 'requestFailed'));
    finish(); await saving;
    assert.equal(run.provider.auxiliaryBusy, false);
    assert.equal(run.messages.at(-1).command, 'settingsSaved');
  } finally { run.provider.dispose(); }
});

test('a pending undo review blocks a fresh agent run until the user decides', async () => {
  const run = setup();
  let finish;
  run.provider.tools.undoLastRequest = () => new Promise(resolve => { finish = resolve; });
  run.provider.tools.getUndoState = async () => ({ available: false, files: 0, label: 'No changes' });
  try {
    const undoing = run.provider.handleMessage({ command: 'undoRequest' });
    await run.provider.handleMessage({ command: 'ask', mode: 'code', question: 'Edit this', scope: { kind: 'project' } });
    assert.ok(run.messages.some(message => message.command === 'requestFailed' && /undo/.test(message.message)));
    finish(false); await undoing;
    assert.equal(run.provider.auxiliaryBusy, false);
    assert.equal(run.messages.at(-1).command, 'undoState');
  } finally { run.provider.dispose(); }
});
