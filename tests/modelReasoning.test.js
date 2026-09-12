const assert = require('node:assert/strict');
const test = require('node:test');
const { createVscodeHarness } = require('./helpers/vscode');

const harness = createVscodeHarness();
const { DevMateChatViewProvider } = harness.load('chatViewProvider');
const {
  ACTIVE_LLM_PROFILE_STORAGE_KEY,
  BUILT_IN_NEMOTRON_PROFILE,
  BUILT_IN_NEMOTRON_PROFILE_ID,
  LLM_PROFILES_STORAGE_KEY,
  LLM_REASONING_EFFORT_STORAGE_KEY,
  secretKeyForProfile
} = require('../out/llmProfiles');

const customProfile = {
  id: 'custom-coder', name: 'My coder', provider: 'openai', model: 'custom-model',
  baseUrl: 'https://example.com/v1', api: 'responses',
  settings: { reasoningEffort: 'high', maxTokens: 3000 }
};

function setup(t, { profiles = [customProfile], activeId = customProfile.id, preferences = {}, keys = {} } = {}) {
  harness.configuration.clear();
  harness.workspaceConfiguration.clear();
  harness.vscode.workspace.workspaceFolders = [harness.folder];
  const storage = harness.context({ global: {
    [LLM_PROFILES_STORAGE_KEY]: profiles,
    [ACTIVE_LLM_PROFILE_STORAGE_KEY]: activeId,
    [LLM_REASONING_EFFORT_STORAGE_KEY]: preferences
  } });
  const secrets = new Map(Object.entries(keys).map(([id, value]) => [secretKeyForProfile(id), value]));
  const secretWrites = [];
  storage.secrets = {
    get: async key => secrets.get(key),
    store: async (key, value) => { secretWrites.push(key); secrets.set(key, value); },
    delete: async key => { secrets.delete(key); }
  };
  const provider = new DevMateChatViewProvider(storage, {
    start: async () => assert.fail('Profile edits must not start the backend'),
    status: { detail: 'online', state: 'running' }
  }, { show() {} });
  const messages = [];
  provider.resolveWebviewView({
    webview: {
      cspSource: 'test', asWebviewUri: uri => uri,
      postMessage: message => messages.push(message),
      onDidReceiveMessage: () => ({ dispose() {} })
    },
    onDidDispose: () => ({ dispose() {} })
  });
  t.after(() => provider.dispose());
  return {
    provider, storage, secrets, secretWrites, messages,
    send: message => provider.handleMessage(message),
    last: command => messages.filter(message => message.command === command).at(-1),
    savedProfiles: () => storage.globalState.get(LLM_PROFILES_STORAGE_KEY),
    preferences: () => storage.globalState.get(LLM_REASONING_EFFORT_STORAGE_KEY)
  };
}

function assertReasoning(run, expected) {
  assert.equal(run.last('llmProfilesUpdated').activeProfile.reasoningEffort, expected);
  assert.equal(run.provider.configuration.effective().reasoningEffort, expected);
}

test('the model editor shows the same explicit reasoning preference as the composer', async t => {
  const run = setup(t, { preferences: { [customProfile.id]: 'low' }, keys: { [customProfile.id]: 'saved-test-key' } });
  await run.send({ command: 'editLlmProfile', profileId: customProfile.id });
  const form = run.last('showLlmProfileForm');
  assert.equal(form.profile.settings.reasoningEffort, 'low');
  assert.equal(form.profile.settings.maxTokens, 3000);
  assert.equal(form.hasApiKey, true);
  assert.equal(JSON.stringify(form).includes('saved-test-key'), false);
});

test('saving model reasoning replaces an earlier menu choice while preserving its ID and saved API key', async t => {
  const run = setup(t, { preferences: { [customProfile.id]: 'low' }, keys: { [customProfile.id]: 'saved-test-key' } });
  await run.send({ command: 'saveLlmProfile', profile: {
    ...customProfile, name: 'Renamed coder', apiKey: '  ',
    settings: { ...customProfile.settings, reasoningEffort: 'high' }
  } });
  assert.equal(run.last('llmProfileFormError'), undefined);
  assert.equal(run.savedProfiles().length, 1);
  assert.equal(run.savedProfiles()[0].id, customProfile.id);
  assert.equal(run.savedProfiles()[0].name, 'Renamed coder');
  assert.equal(run.storage.globalState.get(ACTIVE_LLM_PROFILE_STORAGE_KEY), customProfile.id);
  assert.equal(run.secrets.get(secretKeyForProfile(customProfile.id)), 'saved-test-key');
  assert.deepEqual(run.secretWrites, []);
  assert.equal(run.preferences()[customProfile.id], 'high');
  assertReasoning(run, 'high');
  await run.send({ command: 'editLlmProfile', profileId: customProfile.id });
  assert.equal(run.last('showLlmProfileForm').profile.settings.reasoningEffort, 'high');
});

test('selecting Auto in the composer remains Auto when the model editor is reopened and saved', async t => {
  const run = setup(t, { preferences: { [customProfile.id]: 'low' }, keys: { [customProfile.id]: 'saved-test-key' } });
  await run.send({ command: 'setReasoningEffort', effort: 'auto' });
  assertReasoning(run, 'auto');
  await run.send({ command: 'editLlmProfile', profileId: customProfile.id });
  const form = run.last('showLlmProfileForm');
  assert.equal(form.profile.settings.reasoningEffort, 'auto');
  await run.send({ command: 'saveLlmProfile', profile: { ...form.profile, apiKey: '' } });
  assert.equal(run.last('llmProfileFormError'), undefined);
  assert.equal(run.preferences()[customProfile.id], 'auto');
  assertReasoning(run, 'auto');
});

test('a built-in profile reasoning save retains its saved key and canonical connection', async t => {
  const run = setup(t, {
    profiles: [{ ...BUILT_IN_NEMOTRON_PROFILE, settings: { reasoningEffort: 'low' } }],
    activeId: BUILT_IN_NEMOTRON_PROFILE_ID,
    preferences: { [BUILT_IN_NEMOTRON_PROFILE_ID]: 'low' },
    keys: { [BUILT_IN_NEMOTRON_PROFILE_ID]: 'saved-nvidia-key' }
  });
  await run.send({ command: 'saveLlmProfile', profile: {
    ...BUILT_IN_NEMOTRON_PROFILE, name: 'Changed by a stale form', model: 'other-model',
    baseUrl: 'https://example.com/v1', api: 'responses', apiKey: '',
    settings: { reasoningEffort: 'high', maxTokens: 2000 }
  } });
  assert.equal(run.last('llmProfileFormError'), undefined);
  const saved = run.savedProfiles().find(profile => profile.id === BUILT_IN_NEMOTRON_PROFILE_ID);
  const { settings, ...connection } = saved;
  assert.deepEqual(connection, BUILT_IN_NEMOTRON_PROFILE);
  assert.equal(settings.maxTokens, 2000);
  assert.equal(run.secrets.get(secretKeyForProfile(BUILT_IN_NEMOTRON_PROFILE_ID)), 'saved-nvidia-key');
  assert.deepEqual(run.secretWrites, []);
  assert.equal(run.preferences()[BUILT_IN_NEMOTRON_PROFILE_ID], 'high');
  assertReasoning(run, 'high');
  await run.send({ command: 'editLlmProfile', profileId: BUILT_IN_NEMOTRON_PROFILE_ID });
  assert.equal(run.last('showLlmProfileForm').profile.settings.reasoningEffort, 'high');
});

function legacyNemotron(id, name) {
  return {
    id, name, provider: BUILT_IN_NEMOTRON_PROFILE.provider,
    model: BUILT_IN_NEMOTRON_PROFILE.model, baseUrl: BUILT_IN_NEMOTRON_PROFILE.baseUrl,
    api: 'auto'
  };
}

test('legacy Nemotron migration takes the active profile preference and key and removes obsolete preferences', async t => {
  const first = legacyNemotron('first-nemotron', 'First Nemotron');
  const selected = legacyNemotron('selected-nemotron', 'Selected Nemotron');
  const run = setup(t, {
    profiles: [first, selected, customProfile], activeId: selected.id,
    preferences: { [first.id]: 'low', [selected.id]: 'high', [customProfile.id]: 'none' },
    keys: { [first.id]: 'first-key', [selected.id]: 'selected-key', [customProfile.id]: 'unrelated-key' }
  });
  await run.provider.migrateBuiltInNemotronProfile();
  assert.deepEqual(run.savedProfiles().map(profile => profile.id), [customProfile.id]);
  assert.equal(run.storage.globalState.get(ACTIVE_LLM_PROFILE_STORAGE_KEY), BUILT_IN_NEMOTRON_PROFILE_ID);
  assert.deepEqual(run.preferences(), { [customProfile.id]: 'none', [BUILT_IN_NEMOTRON_PROFILE_ID]: 'high' });
  assert.equal(run.secrets.get(secretKeyForProfile(BUILT_IN_NEMOTRON_PROFILE_ID)), 'selected-key');
  assert.equal(run.secrets.has(secretKeyForProfile(first.id)), false);
  assert.equal(run.secrets.has(secretKeyForProfile(selected.id)), false);
  assert.equal(run.secrets.get(secretKeyForProfile(customProfile.id)), 'unrelated-key');
  await run.send({ command: 'editLlmProfile', profileId: BUILT_IN_NEMOTRON_PROFILE_ID });
  assert.equal(run.last('showLlmProfileForm').profile.settings.reasoningEffort, 'high');
});

for (const existingEffort of ['auto', 'none']) {
  test(`legacy Nemotron migration preserves an explicit built-in ${existingEffort} preference and saved key`, async t => {
    const legacy = legacyNemotron('legacy-nemotron', 'Legacy Nemotron');
    const run = setup(t, {
      profiles: [legacy], activeId: legacy.id,
      preferences: { [legacy.id]: 'high', [BUILT_IN_NEMOTRON_PROFILE_ID]: existingEffort },
      keys: { [legacy.id]: 'old-key', [BUILT_IN_NEMOTRON_PROFILE_ID]: 'built-in-key' }
    });
    await run.provider.migrateBuiltInNemotronProfile();
    assert.deepEqual(run.preferences(), { [BUILT_IN_NEMOTRON_PROFILE_ID]: existingEffort });
    assert.equal(run.secrets.get(secretKeyForProfile(BUILT_IN_NEMOTRON_PROFILE_ID)), 'built-in-key');
    assert.equal(run.secrets.has(secretKeyForProfile(legacy.id)), false);
    assert.deepEqual(run.secretWrites, []);
    await run.send({ command: 'editLlmProfile', profileId: BUILT_IN_NEMOTRON_PROFILE_ID });
    assert.equal(run.last('showLlmProfileForm').profile.settings.reasoningEffort, existingEffort);
  });
}
