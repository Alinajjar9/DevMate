const assert = require('node:assert/strict');
const test = require('node:test');

const { SettingsPresenter } = require('../out/settings/settingsPresenter');

test('publishes saved settings with workspace permission information', () => {
  const fixture = createFixture();

  fixture.presenter.postState();

  assert.deepEqual(fixture.messages, [{
    command: 'settingsUpdated',
    settings: {
      ...configurationState(),
      rememberedCommands: [{ signature: 'npm:test', label: 'npm test' }],
      workspaceTrusted: true
    }
  }]);
});

test('saves general settings and refreshes both settings and permissions', async () => {
  let received;
  const fixture = createFixture({
    save: async (settings) => {
      received = settings;
      return { ok: true };
    }
  });
  const submission = generalSettings();

  await fixture.presenter.save(submission);

  assert.equal(received, submission);
  assert.equal(fixture.permissionUpdates, 1);
  assert.deepEqual(fixture.messages.map((message) => message.command), [
    'settingsUpdated',
    'settingsSaved'
  ]);
});

test('reports a general-settings error without publishing saved state', async () => {
  const fixture = createFixture({
    save: async () => ({
      ok: false,
      message: 'The settings contain an invalid value.',
      level: 'warning'
    })
  });

  await fixture.presenter.save(generalSettings());

  assert.deepEqual(fixture.statuses, [{
    text: 'The settings contain an invalid value.',
    level: 'warning'
  }]);
  assert.equal(fixture.messages.length, 0);
  assert.equal(fixture.permissionUpdates, 0);
});

test('saves agent-tool limits and closes their form with a ready status', async () => {
  let received;
  const fixture = createFixture({
    saveAgentToolSettings: async (settings) => {
      received = settings;
      return { ok: true };
    }
  });
  const submission = configurationState().agentTools;

  await fixture.presenter.saveAgentToolSettings(submission);

  assert.equal(received, submission);
  assert.deepEqual(fixture.messages.map((message) => message.command), [
    'settingsUpdated',
    'agentToolSettingsSaved'
  ]);
  assert.deepEqual(fixture.statuses, [{ text: 'Ready', level: 'info' }]);
});

test('reports an agent-tool storage error without closing the form', async () => {
  const fixture = createFixture({
    saveAgentToolSettings: async () => ({
      ok: false,
      message: 'DevMate could not save the agent-tool settings.',
      level: 'error'
    })
  });

  await fixture.presenter.saveAgentToolSettings(configurationState().agentTools);

  assert.deepEqual(fixture.statuses, [{
    text: 'DevMate could not save the agent-tool settings.',
    level: 'error'
  }]);
  assert.equal(fixture.messages.length, 0);
});

function createFixture(controllerOverrides = {}) {
  const messages = [];
  const statuses = [];
  let permissionUpdates = 0;
  const controller = {
    state: () => configurationState(),
    save: async () => ({ ok: true }),
    saveAgentToolSettings: async () => ({ ok: true }),
    ...controllerOverrides
  };
  const presenter = new SettingsPresenter(controller, {
    rememberedCommands: () => [{ signature: 'npm:test', label: 'npm test' }],
    workspaceTrusted: () => true,
    permissionPolicyChanged: () => {
      permissionUpdates += 1;
    },
    postMessage: (message) => messages.push(message),
    postStatus: (text, level) => statuses.push({ text, level })
  });
  return {
    presenter,
    messages,
    statuses,
    get permissionUpdates() {
      return permissionUpdates;
    }
  };
}

function configurationState() {
  return {
    timeoutSeconds: 900,
    commandTimeoutSeconds: 300,
    toolCallLimit: 16,
    maxTokens: 16_384,
    maxInputContextTokens: 24_000,
    temperature: 0.2,
    agentTools: {
      readFileMaxLines: 400,
      listFilesMaxResults: 200,
      searchCodeMaxResults: 50,
      diagnosticsMaxResults: 100,
      terminalErrorsMaxResults: 5,
      codeNavigationMaxResults: 100
    }
  };
}

function generalSettings() {
  return {
    timeoutSeconds: 900,
    commandTimeoutSeconds: 300,
    toolCallLimit: 16,
    maxTokens: 16_384,
    maxInputContextTokens: 24_000,
    temperature: 0.2,
    policy: { createFiles: 'ask', updateFiles: 'allow' }
  };
}
