const assert = require('node:assert/strict');
const test = require('node:test');
const { createVscodeHarness } = require('./helpers/vscode');
const harness = createVscodeHarness();
const { ConfigurationManager } = harness.load('configurationManager');
const { parseStoredProfiles, LLM_PROFILES_STORAGE_KEY } = require('../out/llmProfiles');
const { DEFAULT_AGENT_CONFIGURATION } = require('../out/configuration');

const profile = { id: 'local-model', name: 'Local coder', provider: 'ollama', model: 'local-model', api: 'auto' };

function setup(values = {}) {
  harness.configuration.clear();
  harness.workspaceConfiguration.clear();
  harness.files.clear();
  harness.reads.length = 0;
  harness.writes.length = 0;
  harness.vscode.workspace.workspaceFolders = [harness.folder];
  const context = harness.context(values);
  const messages = [];
  const reasoningPreferences = {};
  const manager = new ConfigurationManager(context, {
    postMessage: message => messages.push(message),
    getActiveProfile: () => parseStoredProfiles(context.globalState.get(LLM_PROFILES_STORAGE_KEY))[0],
    getReasoningPreferences: () => reasoningPreferences,
    changed: async () => {}
  });
  return { manager, context, messages, reasoningPreferences };
}

test('saved presets cannot affect new requests, even before storage cleanup finishes', () => {
  const run = setup({ global: {
    [LLM_PROFILES_STORAGE_KEY]: [{ ...profile, settings: { maxTokens: 4000, reasoningEffort: 'low' } }],
    'devMate.agentPresets.v1': [{ id: 'hidden', mode: 'debug', settings: {
      maxTokens: 5000, instructions: 'Hidden preset guidance.', enabledTools: [], maxFileEdits: 0, reasoningEffort: 'high' } }],
    'devMate.activePreset.v1': 'hidden',
    'devMate.promptTemplates.v1': [{ id: 'hidden-template', prompt: 'Hidden template guidance.' }]
  }, workspace: { 'devMate.activePreset.v1': 'hidden' } });
  harness.configuration.set('configuration', { maxTokens: 2000, reasoningEffort: 'max' });
  harness.workspaceConfiguration.set('configuration', { maxTokens: 3000, instructions: 'Project rules.', reasoningEffort: 'none' });
  assert.equal(run.manager.base().maxTokens, 3000);
  assert.equal(run.manager.base().reasoningEffort, 'auto');
  const effective = run.manager.effective();
  assert.equal(effective.maxTokens, 4000);
  assert.equal(effective.instructions, 'Project rules.');
  assert.equal(effective.reasoningEffort, 'low');
  assert.equal(effective.maxFileEdits, DEFAULT_AGENT_CONFIGURATION.maxFileEdits);
  assert.deepEqual(effective.enabledTools, DEFAULT_AGENT_CONFIGURATION.enabledTools);
});

test('reasoning resolves from explicit model preference, profile setting, then Auto only', async () => {
  const run = setup({ global: { [LLM_PROFILES_STORAGE_KEY]: [{ ...profile, settings: { reasoningEffort: 'high' } }] } });
  harness.configuration.set('configuration', { reasoningEffort: 'max' });
  harness.workspaceConfiguration.set('configuration', { reasoningEffort: 'medium' });
  assert.equal(run.manager.effective().reasoningEffort, 'high');
  run.reasoningPreferences[profile.id] = 'auto';
  assert.equal(run.manager.effective().reasoningEffort, 'auto');
  run.reasoningPreferences[profile.id] = 'none';
  assert.equal(run.manager.effective().reasoningEffort, 'none');
  delete run.reasoningPreferences[profile.id];
  assert.equal(run.manager.effective(profile).reasoningEffort, 'auto');
  assert.equal('reasoningEffort' in run.manager.overrides, false);
  await run.manager.saveConfiguration('global', { maxCommands: 2, reasoningEffort: 'max' });
  assert.deepEqual(harness.configuration.get('configuration'), { maxCommands: 2 });
  assert.equal(run.manager.effective().reasoningEffort, 'high');
});

test('removed storage is cleaned without touching checkpoints, profiles or permissions', async () => {
  const checkpoint = { saved: 'resolved runtime settings must remain' };
  const run = setup({ global: {
    'devMate.agentPresets.v1': [{ id: 'old' }], 'devMate.promptTemplates.v1': [{ id: 'old' }],
    'devMate.activePreset.v1': 'old', [LLM_PROFILES_STORAGE_KEY]: [profile], unrelated: 'keep'
  }, workspace: { 'devMate.activePreset.v1': 'old', 'devMate.agentCheckpoint.v1': checkpoint, approvals: 'keep' } });
  run.context.secrets.get = async () => assert.fail('Cleanup must not read credentials');
  run.context.secrets.delete = async () => assert.fail('Cleanup must not delete credentials');
  harness.configuration.set('configuration', { instructions: 'Keep these rules.', reasoningEffort: 'high' });
  harness.workspaceConfiguration.set('configuration', { maxCommands: 2, reasoningEffort: 'low' });
  await run.manager.cleanupRemovedFeatures();
  await run.manager.cleanupRemovedFeatures();
  assert.equal(run.context.globalState.get('devMate.activePreset.v1'), undefined);
  assert.equal(run.context.workspaceState.get('devMate.activePreset.v1'), undefined);
  assert.equal(run.context.globalState.get('devMate.agentPresets.v1'), undefined);
  assert.equal(run.context.globalState.get('devMate.promptTemplates.v1'), undefined);
  assert.deepEqual(run.context.globalState.get(LLM_PROFILES_STORAGE_KEY), [profile]);
  assert.equal(run.context.workspaceState.get('devMate.agentCheckpoint.v1'), checkpoint);
  assert.equal(run.context.workspaceState.get('approvals'), 'keep');
  assert.equal(run.context.globalState.get('unrelated'), 'keep');
  assert.deepEqual(harness.configuration.get('configuration'), { instructions: 'Keep these rules.' });
  assert.deepEqual(harness.workspaceConfiguration.get('configuration'), { maxCommands: 2 });
});

test('overrides merge explicit legacy values only at the chosen scope and save migrates them', async () => {
  const run = setup();
  harness.configuration.set('requestTimeoutSeconds', 9999);
  harness.configuration.set('maxTokens', 1000);
  harness.configuration.set('configuration', { maxTokens: 2000 });
  harness.workspaceConfiguration.set('toolCallLimit', 8);
  harness.workspaceConfiguration.set('temperature', 0.7);
  harness.workspaceConfiguration.set('configuration', { maxTokens: 3000 });
  assert.deepEqual(run.manager.overrides, { maxTokens: 2000, timeoutSeconds: 1800 });
  assert.equal(run.manager.base('global').maxTokens, 2000);
  assert.equal(run.manager.base().maxTokens, 3000);
  assert.equal(run.manager.base().temperature, 0.7);
  await run.manager.saveConfiguration('global', { ...run.manager.overrides, instructions: 'Keep public names.' });
  assert.equal(harness.configuration.has('requestTimeoutSeconds'), false);
  assert.equal(harness.configuration.has('maxTokens'), false);
  assert.deepEqual(harness.configuration.get('configuration'), {
    maxTokens: 2000, timeoutSeconds: 1800, instructions: 'Keep public names.'
  });
  run.manager.scope = 'workspace';
  assert.deepEqual(run.manager.overrides, { temperature: 0.7, toolCallLimit: 8, maxTokens: 3000 });
  assert.equal('timeoutSeconds' in run.manager.overrides, false, 'Inherited values are not frozen into workspace overrides');
  await run.manager.saveConfiguration('workspace', {});
  assert.equal(harness.workspaceConfiguration.has('toolCallLimit'), false);
  assert.equal(harness.workspaceConfiguration.has('temperature'), false);
  assert.equal(run.manager.base().maxTokens, 2000);
  assert.equal(run.manager.base().timeoutSeconds, 1800);
  assert.equal(run.manager.base().temperature, DEFAULT_AGENT_CONFIGURATION.temperature);
});

test('strict saves reject invalid new values and unavailable scopes before changing legacy settings', async () => {
  const run = setup();
  harness.configuration.set('requestTimeoutSeconds', 9999);
  harness.configuration.set('maxTokens', 1);
  harness.workspaceConfiguration.set('toolCallLimit', 1000);
  assert.equal(run.manager.base().timeoutSeconds, 1800);
  assert.equal(run.manager.base().maxTokens, 128);
  assert.equal(run.manager.base().toolCallLimit, 100);
  await assert.rejects(run.manager.saveConfiguration('global', { timeoutSeconds: 9999 }), /timeoutSeconds/);
  await assert.rejects(run.manager.saveConfiguration('global', { apiKey: 'never-store' }), /Unknown configuration/);
  assert.equal(harness.configuration.get('requestTimeoutSeconds'), 9999);
  assert.equal(harness.configuration.has('configuration'), false);
  harness.vscode.workspace.workspaceFolders = undefined;
  await assert.rejects(run.manager.saveConfiguration('workspace', {}), /Open a project/);
  assert.equal(harness.workspaceConfiguration.get('toolCallLimit'), 1000);
});

test('a failed object write cannot clear the old explicit settings', async () => {
  const run = setup();
  harness.configuration.set('maxTokens', 2000);
  const original = harness.vscode.workspace.getConfiguration;
  harness.vscode.workspace.getConfiguration = () => ({ ...original(), update: async () => { throw new Error('Storage unavailable'); } });
  try {
    await assert.rejects(run.manager.saveConfiguration('global', {}), /Storage unavailable/);
    assert.equal(harness.configuration.get('maxTokens'), 2000);
  } finally { harness.vscode.workspace.getConfiguration = original; }
});

test('settings state shows defaults or global inheritance without removed feature data', async () => {
  const run = setup({ global: { [LLM_PROFILES_STORAGE_KEY]: [{ ...profile, settings: { maxTokens: 4000 } }] } });
  harness.configuration.set('configuration', { maxTokens: 2000 });
  assert.equal(await run.manager.handle({ command: 'openConfiguration' }), true);
  let state = run.messages.at(-1);
  assert.equal(state.configuration.maxTokens, 2000);
  assert.equal(state.inheritedConfiguration.maxTokens, DEFAULT_AGENT_CONFIGURATION.maxTokens);
  assert.equal(state.effectiveConfiguration.maxTokens, 4000);
  for (const removed of ['presets', 'templates', 'activePresetId', 'profiles']) assert.equal(removed in state, false);
  await run.manager.handle({ command: 'setConfigurationScope', scope: 'workspace' });
  state = run.messages.at(-1);
  assert.equal(state.inheritedConfiguration.maxTokens, 2000);
  assert.deepEqual(state.overrides, {});
});

test('removed feature messages have no handlers and cannot access files or storage', async () => {
  const run = setup();
  for (const command of ['selectPreset', 'savePreset', 'deletePreset', 'savePromptTemplate',
    'deletePromptTemplate', 'exportConfiguration', 'importConfiguration']) {
    assert.equal(await run.manager.handle({ command }), false);
  }
  assert.equal(run.messages.length, 0);
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.reads.length, 0);
  assert.equal(run.context.globalValues.size, 0);
  assert.equal('parseConfigurationBundle' in harness.load('configurationManager'), false);
});
