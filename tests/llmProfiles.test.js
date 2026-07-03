const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BUILT_IN_NEMOTRON_PROFILE,
  BUILT_IN_NEMOTRON_PROFILE_ID,
  isBuiltInLlmProfile,
  isEquivalentNemotronProfile,
  normalizeProfileDraft,
  parseStoredProfiles,
  parseReasoningEffortPreferences,
  profilesWithBuiltInNemotron,
  providerLabelForProfile,
  reasoningEffortForProfile,
  reasoningEffortOptionsForProfile,
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
    /without credentials/
  );
  assert.match(
    validateProfileDraft(
      {
        name: 'Query URL',
        provider: 'openai',
        model: 'model-c',
        baseUrl: 'https://example.com/v1?api-version=1'
      },
      profiles
    ),
    /query parameters/
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

test('exposes intelligence levels only for recognized reasoning models', () => {
  assert.deepEqual(reasoningEffortOptionsForProfile(BUILT_IN_NEMOTRON_PROFILE), [
    'auto', 'low', 'medium', 'high'
  ]);
  assert.deepEqual(
    reasoningEffortOptionsForProfile(profile('gpt', 'GPT', 'openai', 'gpt-5.4-nano')),
    ['auto', 'low', 'medium', 'high', 'xhigh']
  );
  assert.deepEqual(
    reasoningEffortOptionsForProfile(profile('pro', 'Pro', 'openai', 'gpt-5-pro')),
    ['auto', 'high']
  );
  assert.deepEqual(
    reasoningEffortOptionsForProfile(profile('ordinary', 'Ordinary', 'openai', 'gpt-4.1-mini')),
    ['auto']
  );
  assert.deepEqual(reasoningEffortOptionsForProfile({
    ...profile('compatible', 'Compatible', 'openai', 'gpt-5.4-nano'),
    baseUrl: 'https://example.com/v1'
  }), ['auto']);
});

test('parses and clamps per-profile intelligence preferences', () => {
  const preferences = parseReasoningEffortPreferences({
    gpt: 'xhigh',
    ordinary: 'high',
    invalid: 'extreme',
    '../unsafe': 'low'
  });
  assert.deepEqual(preferences, { gpt: 'xhigh', ordinary: 'high' });
  assert.equal(
    reasoningEffortForProfile(profile('gpt', 'GPT', 'openai', 'gpt-5.4-nano'), preferences),
    'xhigh'
  );
  assert.equal(
    reasoningEffortForProfile(profile('ordinary', 'Ordinary', 'openai', 'gpt-4.1-mini'), preferences),
    'auto'
  );
});

function profile(id, name, provider, model) {
  return { id, name, provider, model };
}
