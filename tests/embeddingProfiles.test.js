const assert = require('node:assert/strict');
const test = require('node:test');

const {
  embeddingSecretKeyForProfile,
  normalizeEmbeddingProfileDraft,
  parseStoredEmbeddingProfiles,
  preferredEmbeddingProfile,
  validateEmbeddingProfileDraft
} = require('../out/embeddingProfiles');

test('normalizes embedding models and provider URLs without changing consent', () => {
  assert.deepEqual(normalizeEmbeddingProfileDraft({
    provider: 'ollama',
    model: '  nomic-embed-text  ',
    baseUrl: ' http://127.0.0.1:11434/// ',
    remoteAllowed: false
  }), {
    provider: 'ollama',
    model: 'nomic-embed-text',
    baseUrl: 'http://127.0.0.1:11434',
    remoteAllowed: false
  });
});

test('accepts local profiles without enabling remote source-code transfer', () => {
  assert.equal(validateEmbeddingProfileDraft({
    provider: 'ollama',
    model: 'nomic-embed-text',
    baseUrl: 'http://localhost:11434',
    remoteAllowed: false
  }), undefined);
});

test('requires explicit opt-in and HTTPS for remote embedding profiles', () => {
  const remote = {
    provider: 'openai-compatible',
    model: 'text-embedding-model',
    baseUrl: 'https://embeddings.example.com/v1',
    remoteAllowed: false
  };
  assert.match(validateEmbeddingProfileDraft(remote), /explicit opt-in/);
  assert.equal(validateEmbeddingProfileDraft({ ...remote, remoteAllowed: true }), undefined);
  assert.match(
    validateEmbeddingProfileDraft({
      ...remote,
      baseUrl: 'http://embeddings.example.com/v1',
      remoteAllowed: true
    }),
    /HTTPS for remote providers/
  );
});

test('rejects incomplete profiles and unsafe provider addresses', () => {
  assert.match(validateEmbeddingProfileDraft({
    provider: 'ollama',
    model: '',
    baseUrl: 'http://localhost:11434',
    remoteAllowed: false
  }), /model ID/);
  assert.match(validateEmbeddingProfileDraft({
    provider: 'openai-compatible',
    model: 'embed',
    baseUrl: 'https://169.254.169.254/latest',
    remoteAllowed: true
  }), /public provider address/);
});

test('parses only unique validated profiles and never persists credentials', () => {
  const parsed = parseStoredEmbeddingProfiles([
    profile('local', 'ollama', 'nomic-embed-text', 'http://127.0.0.1:11434'),
    { ...profile('local', 'ollama', 'duplicate', 'http://localhost:11434') },
    profile('../unsafe', 'ollama', 'unsafe-id', 'http://localhost:11434'),
    profile('remote-without-consent', 'openai-compatible', 'embed', 'https://example.com/v1'),
    {
      ...profile('remote', 'openai-compatible', 'embed', 'https://example.com/v1', true),
      apiKey: 'must-not-be-stored'
    }
  ]);

  assert.deepEqual(parsed.map((item) => item.id), ['local', 'remote']);
  assert.equal(Object.hasOwn(parsed[1], 'apiKey'), false);
});

test('prefers the explicit selection and otherwise a local Ollama profile', () => {
  const remote = profile(
    'remote',
    'openai-compatible',
    'embed',
    'https://example.com/v1',
    true
  );
  const localCompatible = profile(
    'local-compatible',
    'openai-compatible',
    'embed',
    'http://localhost:8080'
  );
  const localOllama = profile(
    'local-ollama',
    'ollama',
    'nomic-embed-text',
    'http://localhost:11434'
  );
  const profiles = [remote, localCompatible, localOllama];

  assert.equal(preferredEmbeddingProfile(profiles, 'remote'), remote);
  assert.equal(preferredEmbeddingProfile(profiles, 'missing'), localOllama);
  assert.equal(preferredEmbeddingProfile([], undefined), undefined);
});

test('uses a validated profile-specific SecretStorage key', () => {
  assert.equal(
    embeddingSecretKeyForProfile('local-embed'),
    'devMate.embeddingProfile.local-embed.apiKey'
  );
  assert.throws(() => embeddingSecretKeyForProfile('../unsafe'), /ID is invalid/);
});

function profile(id, provider, model, baseUrl, remoteAllowed = false) {
  return { id, provider, model, baseUrl, remoteAllowed };
}
