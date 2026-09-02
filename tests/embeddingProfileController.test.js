const assert = require('node:assert/strict');
const test = require('node:test');

const {
  EmbeddingProfileController
} = require('../out/settings/embeddingProfileController');
const {
  ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY,
  EMBEDDING_PROFILES_STORAGE_KEY,
  embeddingSecretKeyForProfile
} = require('../out/settings/embeddingProfiles');

test('uses validated stored profiles and prefers local Ollama by default', () => {
  const persistence = memoryPersistence({
    [EMBEDDING_PROFILES_STORAGE_KEY]: [
      profile('remote', 'openai-compatible', 'remote-embed', 'https://example.com/v1', true),
      profile('local', 'ollama', 'nomic-embed-text', 'http://127.0.0.1:11434'),
      profile('../invalid', 'ollama', 'invalid', 'http://127.0.0.1:11434')
    ],
    [ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY]: 'missing'
  });
  const controller = new EmbeddingProfileController(persistence);

  const state = controller.state();
  assert.deepEqual(state.profiles.map((item) => item.id), ['remote', 'local']);
  assert.equal(state.activeProfile.id, 'local');
  assert.deepEqual(controller.pickerItems().map((item) => ({
    id: item.id,
    providerLabel: item.providerLabel,
    selected: item.selected
  })), [
    { id: 'remote', providerLabel: 'OpenAI-compatible', selected: false },
    { id: 'local', providerLabel: 'Ollama', selected: true }
  ]);
});

test('requires explicit remote consent and stores credentials separately', async () => {
  const persistence = memoryPersistence();
  let changes = 0;
  const controller = new EmbeddingProfileController(
    persistence,
    () => { changes += 1; },
    () => 'remote-profile'
  );
  const draft = {
    provider: 'openai-compatible',
    model: 'text-embedding-model',
    baseUrl: 'https://embeddings.example.com/v1',
    remoteAllowed: false,
    apiKey: 'secret-provider-key'
  };

  const denied = await controller.save(draft);
  assert.equal(denied.ok, false);
  assert.match(denied.message, /explicit opt-in/);
  assert.equal(persistence.secrets.size, 0);

  const saved = await controller.save({ ...draft, remoteAllowed: true });
  assert.equal(saved.ok, true);
  assert.equal(changes, 1);
  assert.equal(controller.state().activeProfile.id, 'remote-profile');
  assert.equal(
    persistence.secrets.get(embeddingSecretKeyForProfile('remote-profile')),
    'secret-provider-key'
  );
  assert.equal(
    Object.hasOwn(persistence.state.get(EMBEDDING_PROFILES_STORAGE_KEY)[0], 'apiKey'),
    false
  );
});

test('editing an active profile keeps an existing key when the form is blank', async () => {
  const original = profile(
    'remote',
    'openai-compatible',
    'old-model',
    'https://embeddings.example.com/v1',
    true
  );
  const secretKey = embeddingSecretKeyForProfile(original.id);
  const persistence = memoryPersistence({
    [EMBEDDING_PROFILES_STORAGE_KEY]: [original],
    [ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY]: original.id
  }, { [secretKey]: 'existing-key' });
  let changes = 0;
  const controller = new EmbeddingProfileController(
    persistence,
    () => { changes += 1; }
  );

  const result = await controller.save({
    ...original,
    model: 'new-model',
    apiKey: ''
  });

  assert.equal(result.ok, true);
  assert.equal(controller.state().activeProfile.model, 'new-model');
  assert.equal(persistence.secrets.get(secretKey), 'existing-key');
  assert.equal(changes, 1);
  const form = await controller.form(original.id);
  assert.deepEqual(form, {
    ok: true,
    value: { profile: { ...original, model: 'new-model' }, hasApiKey: true }
  });
});

test('selection and active deletion refresh indexing and remove only the deleted secret', async () => {
  const local = profile('local', 'ollama', 'local-model', 'http://127.0.0.1:11434');
  const remote = profile(
    'remote',
    'openai-compatible',
    'remote-model',
    'https://example.com/v1',
    true
  );
  const persistence = memoryPersistence({
    [EMBEDDING_PROFILES_STORAGE_KEY]: [local, remote],
    [ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY]: local.id
  }, {
    [embeddingSecretKeyForProfile(local.id)]: 'local-key',
    [embeddingSecretKeyForProfile(remote.id)]: 'remote-key'
  });
  let changes = 0;
  const controller = new EmbeddingProfileController(
    persistence,
    () => { changes += 1; }
  );

  assert.equal((await controller.select(remote.id)).ok, true);
  assert.equal(changes, 1);
  assert.equal((await controller.delete(remote.id)).ok, true);

  assert.equal(changes, 2);
  assert.equal(controller.state().activeProfile.id, local.id);
  assert.equal(persistence.secrets.has(embeddingSecretKeyForProfile(remote.id)), false);
  assert.equal(
    persistence.secrets.get(embeddingSecretKeyForProfile(local.id)),
    'local-key'
  );
});

test('rejects malformed credentials and unknown profile operations', async () => {
  const persistence = memoryPersistence();
  const controller = new EmbeddingProfileController(
    persistence,
    () => undefined,
    () => 'local'
  );
  const malformed = await controller.save({
    provider: 'ollama',
    model: 'nomic-embed-text',
    baseUrl: 'http://127.0.0.1:11434',
    remoteAllowed: false,
    apiKey: 'bad\nkey'
  });

  assert.equal(malformed.ok, false);
  assert.match(malformed.message, /without line breaks/);
  assert.equal((await controller.select('missing')).ok, false);
  assert.equal((await controller.delete('missing')).ok, false);
  assert.equal((await controller.form('missing')).ok, false);
});

function profile(id, provider, model, baseUrl, remoteAllowed = false) {
  return { id, provider, model, baseUrl, remoteAllowed };
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
