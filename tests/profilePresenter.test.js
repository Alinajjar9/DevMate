const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BUILT_IN_NEMOTRON_PROFILE,
  BUILT_IN_NEMOTRON_PROFILE_ID
} = require('../out/llmProfiles');
const { ProfilePresenter } = require('../out/profilePresenter');

test('publishes a readable active model and its intelligence options', async () => {
  const profile = {
    id: 'gpt',
    name: 'GPT',
    provider: 'openai',
    model: 'gpt-5.4'
  };
  const fixture = createFixture({
    synchronizedState: async () => ({
      profiles: [profile],
      activeProfile: profile,
      reasoningPreferences: { gpt: 'high' }
    })
  });

  await fixture.presenter.postLlmProfileState();

  assert.deepEqual(fixture.messages.at(-1), {
    command: 'llmProfilesUpdated',
    profileCount: 1,
    activeProfile: {
      id: 'gpt',
      name: 'GPT',
      provider: 'openai',
      providerLabel: 'OpenAI',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      reasoningEffortOptions: [
        { value: 'auto', label: 'Auto' },
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'xhigh', label: 'Extra high' }
      ]
    }
  });
});

test('does not change intelligence during an active request', async () => {
  let changes = 0;
  const fixture = createFixture({
    setReasoningEffort: async () => {
      changes += 1;
      return { ok: true, value: 'high' };
    }
  }, {}, true);

  await fixture.presenter.setActiveReasoningEffort('high');

  assert.equal(changes, 0);
  assert.deepEqual(fixture.statuses, [{
    text: 'Wait for the active request to finish before changing intelligence.',
    level: 'warning'
  }]);
});

test('selecting built-in Nemotron asks for its missing API key', async () => {
  const fixture = createFixture({
    select: async () => ({ ok: true, value: BUILT_IN_NEMOTRON_PROFILE }),
    activeProfile: () => BUILT_IN_NEMOTRON_PROFILE,
    synchronizedState: async () => ({
      profiles: [BUILT_IN_NEMOTRON_PROFILE],
      activeProfile: BUILT_IN_NEMOTRON_PROFILE,
      reasoningPreferences: {}
    }),
    form: async (profileId) => ({
      ok: true,
      value: {
        profile: {
          ...BUILT_IN_NEMOTRON_PROFILE,
          builtIn: true
        },
        hasApiKey: false,
        profileId
      }
    })
  });

  await fixture.presenter.selectLlmProfile(BUILT_IN_NEMOTRON_PROFILE_ID);

  assert.deepEqual(
    fixture.messages.map((message) => message.command),
    ['llmProfilesUpdated', 'showLlmProfileForm']
  );
  assert.equal(fixture.messages[1].profile.id, BUILT_IN_NEMOTRON_PROFILE_ID);
  assert.equal(fixture.statuses.at(-1).text, 'Ready');
});

test('reports model form errors and closes successful saves', async () => {
  const profile = {
    id: 'local',
    name: 'Local model',
    provider: 'ollama',
    model: 'qwen'
  };
  let fail = true;
  const fixture = createFixture({
    save: async () => fail
      ? { ok: false, message: 'Invalid model profile.' }
      : { ok: true, value: { profile, created: true, builtIn: false } },
    synchronizedState: async () => ({
      profiles: [profile],
      activeProfile: profile,
      reasoningPreferences: {}
    })
  });

  await fixture.presenter.saveLlmProfile(modelSubmission());
  assert.deepEqual(fixture.messages.at(-1), {
    command: 'llmProfileFormError',
    message: 'Invalid model profile.'
  });

  fail = false;
  await fixture.presenter.saveLlmProfile(modelSubmission());
  assert.deepEqual(
    fixture.messages.slice(-2).map((message) => message.command),
    ['llmProfilesUpdated', 'closeLlmProfileForm']
  );
  assert.equal(fixture.statuses.at(-1).text, 'Local model selected.');
});

test('publishes and selects embedding profiles through the same presenter', async () => {
  const profile = {
    id: 'embedding',
    provider: 'ollama',
    model: 'nomic-embed-text',
    baseUrl: 'http://127.0.0.1:11434',
    remoteAllowed: false
  };
  const fixture = createFixture({}, {
    state: () => ({ profiles: [profile], activeProfile: profile }),
    select: async () => ({ ok: true, value: profile })
  });

  await fixture.presenter.selectEmbeddingProfile(profile.id);

  assert.deepEqual(fixture.messages.at(-1), {
    command: 'embeddingProfilesUpdated',
    profileCount: 1,
    activeProfile: {
      ...profile,
      providerLabel: 'Ollama'
    }
  });
  assert.equal(
    fixture.statuses.at(-1).text,
    'nomic-embed-text selected for code embeddings.'
  );
});

test('reports embedding form errors and closes successful deletion', async () => {
  const profile = {
    id: 'embedding',
    provider: 'openai-compatible',
    model: 'embed-model',
    baseUrl: 'https://example.com/v1',
    remoteAllowed: true
  };
  let fail = true;
  const fixture = createFixture({}, {
    delete: async () => fail
      ? { ok: false, message: 'Could not delete the embedding profile.' }
      : { ok: true, value: profile },
    state: () => ({ profiles: [], activeProfile: undefined })
  });

  await fixture.presenter.deleteEmbeddingProfile(profile.id);
  assert.deepEqual(fixture.messages.at(-1), {
    command: 'embeddingProfileFormError',
    message: 'Could not delete the embedding profile.'
  });

  fail = false;
  await fixture.presenter.deleteEmbeddingProfile(profile.id);
  assert.deepEqual(
    fixture.messages.slice(-2).map((message) => message.command),
    ['embeddingProfilesUpdated', 'closeEmbeddingProfileForm']
  );
  assert.equal(fixture.statuses.at(-1).text, 'embed-model embedding profile deleted.');
});

function createFixture(llmOverrides = {}, embeddingOverrides = {}, active = false) {
  const messages = [];
  const statuses = [];
  const llmProfiles = {
    activeProfile: () => undefined,
    pickerItems: () => [],
    form: async () => ({ ok: true, value: { hasApiKey: false } }),
    select: async () => ({ ok: false, message: 'Missing profile.' }),
    setReasoningEffort: async () => ({ ok: true, value: 'auto' }),
    save: async () => ({ ok: false, message: 'Not configured.' }),
    delete: async () => ({ ok: false, message: 'Not configured.' }),
    synchronizedState: async () => ({
      profiles: [],
      activeProfile: undefined,
      reasoningPreferences: {}
    }),
    ...llmOverrides
  };
  const embeddingProfiles = {
    state: () => ({ profiles: [], activeProfile: undefined }),
    pickerItems: () => [],
    form: async () => ({ ok: true, value: { hasApiKey: false } }),
    select: async () => ({ ok: false, message: 'Missing profile.' }),
    save: async () => ({ ok: false, message: 'Not configured.' }),
    delete: async () => ({ ok: false, message: 'Not configured.' }),
    ...embeddingOverrides
  };
  const presenter = new ProfilePresenter(llmProfiles, embeddingProfiles, {
    isRequestActive: () => active,
    postMessage: (message) => messages.push(message),
    postStatus: (text, level = 'info') => statuses.push({ text, level })
  });
  return { presenter, messages, statuses };
}

function modelSubmission() {
  return {
    name: 'Local model',
    provider: 'ollama',
    model: 'qwen',
    baseUrl: 'http://127.0.0.1:11434/v1'
  };
}
