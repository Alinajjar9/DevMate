const assert = require('node:assert/strict');
const test = require('node:test');

const { SettingsController } = require('../out/settings/settingsController');
const { FILE_PERMISSION_POLICY_STORAGE_KEY } = require('../out/workspace/permissions');

test('reads bounded settings and fills in understandable defaults', () => {
  const persistence = memoryPersistence({
    requestTimeoutSeconds: 5_000,
    commandTimeoutSeconds: 1,
    toolCallLimit: 500,
    maxTokens: 64,
    maxInputContextTokens: -1,
    temperature: 5,
    readFileMaxLines: 700,
    searchCodeMaxResults: 80
  });
  const controller = new SettingsController(persistence);

  assert.deepEqual(controller.state(), {
    timeoutSeconds: 1_800,
    commandTimeoutSeconds: 10,
    toolCallLimit: 100,
    maxTokens: 128,
    maxInputContextTokens: 0,
    temperature: 2,
    agentTools: {
      readFileMaxLines: 700,
      listFilesMaxResults: 200,
      searchCodeMaxResults: 80,
      diagnosticsMaxResults: 100,
      terminalErrorsMaxResults: 5,
      codeNavigationMaxResults: 100
    }
  });
});

test('saves global preferences and the workspace permission policy', async () => {
  const persistence = memoryPersistence();
  const controller = new SettingsController(persistence);
  const settings = validSettings();

  assert.deepEqual(await controller.save(settings), { ok: true });
  assert.equal(persistence.configuration.get('requestTimeoutSeconds'), 900);
  assert.equal(persistence.configuration.get('maxInputContextTokens'), 24_000);
  assert.deepEqual(
    persistence.workspaceState.get(FILE_PERMISSION_POLICY_STORAGE_KEY),
    settings.policy
  );

  assert.deepEqual(await controller.save({
    ...settings,
    maxInputContextTokens: 0
  }), { ok: true });
  assert.equal(persistence.configuration.get('maxInputContextTokens'), 0);
});

test('rejects invalid general settings before writing anything', async () => {
  const persistence = memoryPersistence();
  const controller = new SettingsController(persistence);

  const result = await controller.save({
    ...validSettings(),
    timeoutSeconds: 9
  });

  assert.deepEqual(result, {
    ok: false,
    message: 'The settings contain an invalid value.',
    level: 'warning'
  });
  assert.equal(persistence.configuration.size, 0);
  assert.equal(persistence.workspaceState.size, 0);
});

test('saves all agent-tool limits together', async () => {
  const persistence = memoryPersistence();
  const controller = new SettingsController(persistence);
  const settings = validAgentToolSettings();

  assert.deepEqual(await controller.saveAgentToolSettings(settings), { ok: true });
  assert.deepEqual(Object.fromEntries(persistence.configuration), settings);
  assert.deepEqual(controller.agentToolSettings(), settings);
});

test('rejects agent-tool limits that normalization would silently change', async () => {
  const persistence = memoryPersistence();
  const controller = new SettingsController(persistence);

  const result = await controller.saveAgentToolSettings({
    ...validAgentToolSettings(),
    readFileMaxLines: 1_001
  });

  assert.deepEqual(result, {
    ok: false,
    message: 'The agent-tool settings contain an invalid value.',
    level: 'warning'
  });
  assert.equal(persistence.configuration.size, 0);
});

test('returns readable errors when configuration persistence fails', async () => {
  const persistence = memoryPersistence();
  persistence.writeConfiguration = async () => {
    throw new Error('configuration unavailable');
  };
  const controller = new SettingsController(persistence);

  assert.deepEqual(await controller.save(validSettings()), {
    ok: false,
    message: 'DevMate could not save the settings.',
    level: 'error'
  });
  assert.deepEqual(await controller.saveAgentToolSettings(validAgentToolSettings()), {
    ok: false,
    message: 'DevMate could not save the agent-tool settings.',
    level: 'error'
  });
});

function validSettings() {
  return {
    timeoutSeconds: 900,
    commandTimeoutSeconds: 300,
    toolCallLimit: 16,
    maxTokens: 8_000,
    maxInputContextTokens: 24_000,
    temperature: 0.2,
    policy: { createFiles: 'ask', updateFiles: 'allow' }
  };
}

function validAgentToolSettings() {
  return {
    readFileMaxLines: 500,
    listFilesMaxResults: 250,
    searchCodeMaxResults: 75,
    diagnosticsMaxResults: 125,
    terminalErrorsMaxResults: 6,
    codeNavigationMaxResults: 150
  };
}

function memoryPersistence(initialConfiguration = {}) {
  const configuration = new Map(Object.entries(initialConfiguration));
  const workspaceState = new Map();
  return {
    configuration,
    workspaceState,
    readConfiguration: (key) => configuration.get(key),
    writeConfiguration: async (key, value) => {
      configuration.set(key, structuredClone(value));
    },
    writeWorkspaceState: async (key, value) => {
      workspaceState.set(key, structuredClone(value));
    }
  };
}
