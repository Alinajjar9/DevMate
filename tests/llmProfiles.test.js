const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BUILT_IN_NEMOTRON_PROFILE,
  BUILT_IN_NEMOTRON_PROFILE_ID,
  isBuiltInLlmProfile,
  isEquivalentNemotronProfile,
  normalizeProfileDraft,
  parseStoredProfiles,
  profilesWithBuiltInNemotron,
  providerLabelForProfile,
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

test('provides Nemotron as the permanent built-in default profile', () => {
  const profiles = profilesWithBuiltInNemotron([
    profile('custom', 'Local', 'ollama', 'qwen-coder'),
    profile(BUILT_IN_NEMOTRON_PROFILE_ID, 'Stored duplicate', 'openai', 'other-model')
  ]);

  assert.equal(profiles[0], BUILT_IN_NEMOTRON_PROFILE);
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0].model, 'nvidia/nemotron-3-ultra-550b-a55b');
  assert.equal(profiles[0].baseUrl, 'https://integrate.api.nvidia.com/v1');
  assert.equal(isBuiltInLlmProfile(profiles[0]), true);
  assert.equal(providerLabelForProfile(profiles[0]), 'NVIDIA');
});

test('recognizes a manually configured profile equivalent to built-in Nemotron', () => {
  assert.equal(
    isEquivalentNemotronProfile({
      id: 'legacy',
      name: 'My Nemotron',
      provider: 'openai',
      model: 'nvidia/nemotron-3-ultra-550b-a55b',
      baseUrl: 'https://integrate.api.nvidia.com/v1'
    }),
    true
  );
  assert.equal(
    isEquivalentNemotronProfile(profile('other', 'Other', 'openai', 'gpt-4.1-mini')),
    false
  );
});

function profile(id, name, provider, model) {
  return { id, name, provider, model };
}
