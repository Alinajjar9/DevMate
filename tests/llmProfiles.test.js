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
  REASONING_EFFORT_LABELS,
  reasoningEffortOptionsForProfile,
  secretKeyForProfile,
  validateProfileDraft
} = require('../out/llmProfiles');

test('profile overrides persist and built-in profiles accept settings without changing connection metadata', () => {
  const profile = { id: 'custom-model', name: 'Custom model', provider: 'openai', model: 'model',
    settings: { maxTokens: 3000, temperature: 0.8, reasoningEffort: 'high' } };
  const parsed = parseStoredProfiles([profile]);
  assert.deepEqual(parsed[0].settings, profile.settings);
  assert.deepEqual(normalizeProfileDraft(profile).settings, profile.settings);
  assert.match(validateProfileDraft({ ...profile, settings: { instructions: 'wrong place' } }, []), /Model profiles may override/);
  assert.match(validateProfileDraft({ ...profile, settings: { maxTokens: 10 } }, []), /maxTokens/);
  const builtin = profilesWithBuiltInNemotron([{ ...BUILT_IN_NEMOTRON_PROFILE,
    model: 'unauthorized-change', baseUrl: 'https://other.example/v1', settings: { maxTokens: 5000 } }])[0];
  assert.equal(builtin.model, BUILT_IN_NEMOTRON_PROFILE.model);
  assert.equal(builtin.baseUrl, BUILT_IN_NEMOTRON_PROFILE.baseUrl);
  assert.deepEqual(builtin.settings, { maxTokens: 5000 });
});

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
    api: 'auto',
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

test('normalizes and retains explicit API choices', () => {
  for (const api of ['auto', 'chat_completions', 'responses']) {
    const draft = normalizeProfileDraft({
      name: ' Custom ', provider: 'openai', model: ' a-new-model ', api,
      baseUrl: 'https://example.com/v1/responses/'
    });
    assert.equal(draft.api, api);
    assert.equal(draft.baseUrl, 'https://example.com/v1/responses');
    assert.equal(validateProfileDraft(draft, []), undefined);
  }
});

test('loads old profiles as Auto and preserves saved API choices', () => {
  const stored = [
    profile('old', 'Older profile', 'openai', 'any-model'),
    { ...profile('chat', 'Chat API', 'openai', 'any-model'), api: 'chat_completions' },
    { ...profile('response', 'Responses API', 'openai', 'any-model'), api: 'responses' },
    { ...profile('local', 'Local', 'ollama', 'local-model'), api: 'responses' }
  ];
  const loaded = parseStoredProfiles(stored);
  assert.deepEqual(loaded.map(item => item.api), ['auto', 'chat_completions', 'responses', 'responses']);
  assert.deepEqual(parseStoredProfiles(JSON.parse(JSON.stringify(loaded))), loaded);
  assert.equal(BUILT_IN_NEMOTRON_PROFILE.api, 'chat_completions');
});

test('rejects invalid API selections instead of silently replacing them', () => {
  for (const api of ['response', '', null, 42]) {
    const invalid = { ...profile('bad', 'Invalid', 'openai', 'any-model'), api };
    assert.match(validateProfileDraft(invalid, []), /provider API/);
    assert.deepEqual(parseStoredProfiles([invalid]), []);
  }
});

test('does not migrate a custom Responses profile into the built-in Chat Completions profile', () => {
  assert.equal(isEquivalentNemotronProfile({
    ...BUILT_IN_NEMOTRON_PROFILE, id: 'custom', builtIn: undefined, api: 'responses'
  }), false);
});

test('offers general reasoning choices for new, old and custom model names', () => {
  const allOptions = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];
  for (const model of ['gpt-5.6-luna', 'gpt-5.6-luna-2026-09-11', 'gpt-5-pro', 'gpt-4.1-mini', 'new-model', 'vendor/new-model']) {
    for (const baseUrl of [undefined, 'https://api.openai.com/v1', 'https://example.com/v1']) {
      for (const api of ['auto', 'chat_completions', 'responses']) {
        const custom = { ...profile('custom', 'Custom', 'openai', model), baseUrl, api };
        assert.deepEqual(reasoningEffortOptionsForProfile(custom), allOptions);
      }
    }
  }
  assert.deepEqual(reasoningEffortOptionsForProfile(profile('local', 'Local', 'ollama', 'a-local-model')), allOptions);
});

test('keeps Nemotron thinking controls including Off', () => {
  assert.deepEqual(reasoningEffortOptionsForProfile(BUILT_IN_NEMOTRON_PROFILE), ['auto', 'none', 'low', 'medium', 'high']);
  assert.deepEqual(reasoningEffortOptionsForProfile(profile('nemotron', 'Nemotron', 'openai', 'nemotron-3-ultra')), [
    'auto', 'none', 'low', 'medium', 'high'
  ]);
});

test('preserves explicit reasoning preferences without guessing provider support', () => {
  const preferences = parseReasoningEffortPreferences({
    luna: 'high', older: 'xhigh', local: 'max', off: 'none',
    [BUILT_IN_NEMOTRON_PROFILE.id]: 'max', invalid: 'extreme', '../unsafe': 'low'
  });
  assert.deepEqual(preferences, {
    luna: 'high', older: 'xhigh', local: 'max', off: 'none', [BUILT_IN_NEMOTRON_PROFILE.id]: 'max'
  });
  assert.equal(reasoningEffortForProfile(profile('luna', 'Luna', 'openai', 'gpt-5.6-luna'), preferences), 'high');
  assert.equal(reasoningEffortForProfile(profile('older', 'Older GPT', 'openai', 'gpt-4.1-mini'), preferences), 'xhigh');
  assert.equal(reasoningEffortForProfile(profile('local', 'Local', 'ollama', 'new-model'), preferences), 'max');
  assert.equal(reasoningEffortForProfile(profile('off', 'Off', 'openai', 'new-model'), preferences), 'none');
  assert.equal(reasoningEffortForProfile(BUILT_IN_NEMOTRON_PROFILE, preferences), 'max');
  assert.equal(reasoningEffortForProfile(profile('missing', 'No preference', 'openai', 'new-model'), preferences), 'auto');
  assert.equal(reasoningEffortForProfile(profile('bad', 'Invalid', 'openai', 'new-model'), { bad: 'invalid' }), 'auto');
});

test('uses plain reasoning labels without model-specific overrides', () => {
  assert.deepEqual(REASONING_EFFORT_LABELS, {
    auto: 'Auto', none: 'Off', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max'
  });
});

function profile(id, name, provider, model) {
  return { id, name, provider, model };
}
