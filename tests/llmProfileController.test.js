const assert = require('node:assert/strict');
const test = require('node:test');

const { LlmProfileController } = require('../out/settings/llmProfileController');
const {
  ACTIVE_LLM_PROFILE_STORAGE_KEY,
  BUILT_IN_NEMOTRON_PROFILE_ID,
  LLM_PROFILES_STORAGE_KEY,
  LLM_REASONING_EFFORT_STORAGE_KEY,
  secretKeyForProfile
} = require('../out/settings/llmProfiles');

test('adds the built-in model and synchronizes the fallback selection', async () => {
  const persistence = memoryPersistence({
    [ACTIVE_LLM_PROFILE_STORAGE_KEY]: 'missing-profile'
  });
  const controller = new LlmProfileController(persistence);

  const state = await controller.synchronizedState();

  assert.equal(state.profiles.length, 1);
  assert.equal(state.activeProfile.id, BUILT_IN_NEMOTRON_PROFILE_ID);
  assert.equal(
    persistence.state.get(ACTIVE_LLM_PROFILE_STORAGE_KEY),
    BUILT_IN_NEMOTRON_PROFILE_ID
  );
  assert.deepEqual(controller.pickerItems().map((profile) => ({
    id: profile.id,
    providerLabel: profile.providerLabel,
    builtIn: profile.builtIn,
    selected: profile.selected
  })), [{
    id: BUILT_IN_NEMOTRON_PROFILE_ID,
    providerLabel: 'NVIDIA',
    builtIn: true,
    selected: true
  }]);
});

test('creates an OpenAI profile and stores its API key separately', async () => {
  const persistence = memoryPersistence();
  const controller = new LlmProfileController(persistence, () => 'openai-profile');
  const submission = {
    name: 'OpenAI model',
    provider: 'openai',
    model: 'gpt-5.2',
    baseUrl: 'https://api.openai.com/v1',
    contextWindowTokens: 128_000
  };

  const missingKey = await controller.save(submission);
  assert.equal(missingKey.ok, false);
  assert.match(missingKey.message, /API key/);

  const saved = await controller.save({ ...submission, apiKey: 'secret-key' });
  assert.equal(saved.ok, true);
  assert.equal(saved.value.created, true);
  assert.equal(controller.activeProfile().id, 'openai-profile');
  assert.equal(
    persistence.secrets.get(secretKeyForProfile('openai-profile')),
    'secret-key'
  );
  assert.equal(
    Object.hasOwn(persistence.state.get(LLM_PROFILES_STORAGE_KEY)[0], 'apiKey'),
    false
  );
});

test('keeps an existing key while editing and removes it when switching to Ollama', async () => {
  const original = profile('custom', 'OpenAI model', 'openai', 'gpt-5.2');
  const secretKey = secretKeyForProfile(original.id);
  const persistence = memoryPersistence({
    [LLM_PROFILES_STORAGE_KEY]: [original],
    [ACTIVE_LLM_PROFILE_STORAGE_KEY]: original.id
  }, { [secretKey]: 'existing-key' });
  const controller = new LlmProfileController(persistence);

  const edited = await controller.save({
    ...original,
    model: 'gpt-5.3',
    apiKey: ''
  });
  assert.equal(edited.ok, true);
  assert.equal(persistence.secrets.get(secretKey), 'existing-key');

  const switched = await controller.save({
    ...original,
    name: 'Local model',
    provider: 'ollama',
    model: 'qwen3-coder',
    baseUrl: 'http://127.0.0.1:11434'
  });
  assert.equal(switched.ok, true);
  assert.equal(persistence.secrets.has(secretKey), false);
  assert.equal(controller.activeProfile().provider, 'ollama');
});

test('stores supported reasoning preferences and rejects unsupported levels', async () => {
  const custom = profile('reasoning', 'Reasoning model', 'openai', 'gpt-5.2');
  const persistence = memoryPersistence({
    [LLM_PROFILES_STORAGE_KEY]: [custom],
    [ACTIVE_LLM_PROFILE_STORAGE_KEY]: custom.id
  });
  const controller = new LlmProfileController(persistence);

  assert.equal((await controller.setReasoningEffort('xhigh')).ok, true);
  assert.deepEqual(
    persistence.state.get(LLM_REASONING_EFFORT_STORAGE_KEY),
    { reasoning: 'xhigh' }
  );

  const local = profile('local', 'Local model', 'ollama', 'qwen3-coder');
  persistence.state.set(LLM_PROFILES_STORAGE_KEY, [custom, local]);
  assert.equal((await controller.select(local.id)).ok, true);
  const rejected = await controller.setReasoningEffort('high');
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /does not support/);
});

test('configures but never deletes the built-in Nemotron profile', async () => {
  const secretKey = secretKeyForProfile(BUILT_IN_NEMOTRON_PROFILE_ID);
  const persistence = memoryPersistence();
  const controller = new LlmProfileController(persistence);

  const formBefore = await controller.form(BUILT_IN_NEMOTRON_PROFILE_ID);
  assert.equal(formBefore.ok, true);
  assert.equal(formBefore.value.profile.builtIn, true);
  assert.equal(formBefore.value.hasApiKey, false);

  const saved = await controller.save({
    ...formBefore.value.profile,
    apiKey: 'nvidia-key'
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.value.builtIn, true);
  assert.equal(persistence.secrets.get(secretKey), 'nvidia-key');

  const deleted = await controller.delete(BUILT_IN_NEMOTRON_PROFILE_ID);
  assert.equal(deleted.ok, false);
  assert.match(deleted.message, /cannot be deleted/);
});

test('deleting the active custom profile removes its key and reasoning preference', async () => {
  const custom = profile('custom', 'Custom model', 'openai', 'gpt-5.2');
  const secretKey = secretKeyForProfile(custom.id);
  const persistence = memoryPersistence({
    [LLM_PROFILES_STORAGE_KEY]: [custom],
    [ACTIVE_LLM_PROFILE_STORAGE_KEY]: custom.id,
    [LLM_REASONING_EFFORT_STORAGE_KEY]: { custom: 'high' }
  }, { [secretKey]: 'provider-key' });
  const controller = new LlmProfileController(persistence);

  const deleted = await controller.delete(custom.id);

  assert.equal(deleted.ok, true);
  assert.deepEqual(persistence.state.get(LLM_PROFILES_STORAGE_KEY), []);
  assert.deepEqual(persistence.state.get(LLM_REASONING_EFFORT_STORAGE_KEY), {});
  assert.equal(persistence.secrets.has(secretKey), false);
  assert.equal(
    persistence.state.get(ACTIVE_LLM_PROFILE_STORAGE_KEY),
    BUILT_IN_NEMOTRON_PROFILE_ID
  );
});

test('returns readable errors when profile persistence is unavailable', async () => {
  const persistence = memoryPersistence();
  const controller = new LlmProfileController({
    ...persistence,
    writeState: async () => {
      throw new Error('storage unavailable');
    },
    readSecret: async () => {
      throw new Error('secret storage unavailable');
    }
  });

  const selection = await controller.select(BUILT_IN_NEMOTRON_PROFILE_ID);
  assert.deepEqual(selection, {
    ok: false,
    message: 'Could not select the model profile.'
  });
  const form = await controller.form(BUILT_IN_NEMOTRON_PROFILE_ID);
  assert.deepEqual(form, {
    ok: false,
    message: 'Could not read the model profile credential.'
  });
});

function profile(id, name, provider, model) {
  return {
    id,
    name,
    provider,
    model,
    baseUrl: provider === 'ollama'
      ? 'http://127.0.0.1:11434'
      : 'https://api.openai.com/v1'
  };
}

function memoryPersistence(initialState = {}, initialSecrets = {}) {
  const state = new Map(Object.entries(initialState));
  const secrets = new Map(Object.entries(initialSecrets));
  return {
    state,
    secrets,
    readState: (key) => state.get(key),
    writeState: async (key, value) => {
      if (value === undefined) {
        state.delete(key);
      } else {
        state.set(key, structuredClone(value));
      }
    },
    readSecret: async (key) => secrets.get(key),
    writeSecret: async (key, value) => {
      secrets.set(key, value);
    },
    deleteSecret: async (key) => {
      secrets.delete(key);
    }
  };
}
