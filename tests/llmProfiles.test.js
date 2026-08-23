const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BUILT_IN_NEMOTRON_PROFILE,
  BUILT_IN_NEMOTRON_PROFILE_ID,
  isBuiltInLlmProfile,
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
    baseUrl: 'http://127.0.0.1:11434///',
    contextWindowTokens: 128_000
  });

  assert.deepEqual(profile, {
    name: 'Local Coder',
    provider: 'ollama',
    model: 'qwen-coder',
    baseUrl: 'http://127.0.0.1:11434',
    contextWindowTokens: 128_000
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

test('allows HTTPS remotely and plain HTTP only for loopback providers', () => {
  for (const baseUrl of [
    'https://provider.example.com/v1',
    'https://8.8.8.8/v1',
    'https://[2606:4700:4700::1111]/v1',
    'http://localhost:11434',
    'http://127.42.0.1:11434/v1',
    'http://[::1]:11434/v1'
  ]) {
    assert.equal(
      validateProfileDraft(
        { name: baseUrl, provider: 'ollama', model: 'model', baseUrl },
        []
      ),
      undefined,
      baseUrl
    );
  }

  for (const baseUrl of [
    'http://provider.example.com/v1',
    'http://192.168.1.20:11434/v1',
    'http://169.254.169.254/latest',
    'http://localhost.example.com/v1'
  ]) {
    assert.match(
      validateProfileDraft(
        { name: baseUrl, provider: 'openai', model: 'model', baseUrl },
        []
      ),
      /HTTPS for remote providers/,
      baseUrl
    );
  }
});

test('rejects private and special-purpose provider IP literals', () => {
  for (const baseUrl of [
    'https://0.0.0.0/v1',
    'https://10.0.0.2/v1',
    'https://100.64.0.1/v1',
    'https://169.254.169.254/latest',
    'https://192.168.1.20/v1',
    'https://224.0.0.1/v1',
    'https://[::]/v1',
    'https://[::ffff:7f00:1]/v1',
    'https://[fc00::1]/v1',
    'https://[fe80::1]/v1'
  ]) {
    assert.match(
      validateProfileDraft(
        { name: baseUrl, provider: 'openai', model: 'model', baseUrl },
        []
      ),
      /public provider address/,
      baseUrl
    );
  }
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

test('validates optional model context windows without requiring one', () => {
  assert.equal(validateProfileDraft(
    { name: 'Auto', provider: 'ollama', model: 'model' },
    []
  ), undefined);
  assert.equal(validateProfileDraft(
    {
      name: 'Configured',
      provider: 'ollama',
      model: 'model',
      contextWindowTokens: 128_000
    },
    []
  ), undefined);
  assert.match(validateProfileDraft(
    {
      name: 'Invalid',
      provider: 'ollama',
      model: 'model',
      contextWindowTokens: 1_000
    },
    []
  ), /1,024 to 4,000,000/);
});

test('parses only complete, unique, supported stored profiles', () => {
  const parsed = parseStoredProfiles([
    profile('one', 'Cloud', 'openai', 'model-a'),
    profile('two', 'Local', 'ollama', 'model-b'),
    { ...profile('window', 'Large context', 'ollama', 'model-window'), contextWindowTokens: 256_000 },
    { ...profile('invalid-window', 'Invalid context', 'ollama', 'model-invalid'), contextWindowTokens: -1 },
    profile('one', 'Duplicate ID', 'openai', 'model-c'),
    profile('three', 'cloud', 'openai', 'model-d'),
    profile('four', 'Unsupported', 'unknown', 'model-e'),
    { id: 'five', name: '', provider: 'openai', model: 'model-f' },
    {
      id: 'six',
      name: 'Insecure remote',
      provider: 'openai',
      model: 'model-g',
      baseUrl: 'http://provider.example.com/v1'
    },
    {
      id: 'seven',
      name: 'Private destination',
      provider: 'openai',
      model: 'model-h',
      baseUrl: 'https://169.254.169.254/latest'
    },
    null
  ]);

  assert.deepEqual(parsed.map((item) => item.id), [
    'one',
    'two',
    'window',
    'invalid-window'
  ]);
  assert.equal(parsed.find((item) => item.id === 'window').contextWindowTokens, 256_000);
  assert.equal(parsed.find((item) => item.id === 'invalid-window').contextWindowTokens, undefined);
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
