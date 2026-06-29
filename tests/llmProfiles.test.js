const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeProfileDraft,
  parseStoredProfiles,
  secretKeyForProfile,
  validateProfileDraft
} = require('../out/llmProfiles');

test('normalizes profile labels, model IDs, and trailing URL slashes', () => {
  const profile = normalizeProfileDraft({
    name: '  Local Coder  ',
    provider: 'ollama',
    model: '  qwen-coder  ',
    baseUrl: 'http://127.0.0.1:11434///'
  });

  assert.deepEqual(profile, {
    name: 'Local Coder',
    provider: 'ollama',
    model: 'qwen-coder',
    baseUrl: 'http://127.0.0.1:11434'
  });
});

test('rejects duplicate names and unsafe base URLs', () => {
  const profiles = [profile('one', 'OpenAI Fast', 'openai', 'model-a')];

  assert.match(
    validateProfileDraft(
      { name: 'openai fast', provider: 'openai', model: 'model-b' },
      profiles
    ),
    /already exists/
  );
  assert.match(
    validateProfileDraft(
      {
        name: 'Remote',
        provider: 'ollama',
        model: 'model-b',
        baseUrl: 'https://user:password@example.com'
      },
      profiles
    ),
    /without embedded credentials/
  );
});

test('allows an edited profile to keep its own display name', () => {
  const profiles = [profile('one', 'OpenAI Fast', 'openai', 'model-a')];

  assert.equal(
    validateProfileDraft(
      { name: 'OpenAI Fast', provider: 'openai', model: 'model-b' },
      profiles,
      'one'
    ),
    undefined
  );
});

test('parses only complete, unique, supported stored profiles', () => {
  const parsed = parseStoredProfiles([
    profile('one', 'Cloud', 'openai', 'model-a'),
    profile('two', 'Local', 'ollama', 'model-b'),
    profile('one', 'Duplicate ID', 'openai', 'model-c'),
    profile('three', 'cloud', 'openai', 'model-d'),
    profile('four', 'Unsupported', 'unknown', 'model-e'),
    { id: 'five', name: '', provider: 'openai', model: 'model-f' },
    null
  ]);

  assert.deepEqual(parsed.map((item) => item.id), ['one', 'two']);
});

test('uses a profile-specific secret-storage key', () => {
  assert.equal(
    secretKeyForProfile('profile-123'),
    'devMate.llmProfile.profile-123.apiKey'
  );
});

function profile(id, name, provider, model) {
  return { id, name, provider, model };
}
