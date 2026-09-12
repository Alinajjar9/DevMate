const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_AGENT_CONFIGURATION,
  normalizeAgentConfiguration, validateConfigurationOverrides, parseConfigurationOverrides,
  parseModelProfileSettings
} = require('../out/configuration');
const { AGENT_TOOL_NAMES } = require('../out/agentTools');

test('configuration defaults preserve current limits and recovery does not share mutable arrays', () => {
  const recovered = normalizeAgentConfiguration({ maxTokens: -1, temperature: 0.7, unknown: true });
  assert.equal(recovered.maxTokens, 16384);
  assert.equal(recovered.temperature, 0.7);
  assert.equal(recovered.toolCallLimit, 16);
  assert.equal(recovered.maxRepairAttempts, 3);
  recovered.enabledTools.pop();
  assert.deepEqual(DEFAULT_AGENT_CONFIGURATION.enabledTools, [...AGENT_TOOL_NAMES]);
  assert.deepEqual(normalizeAgentConfiguration(null), DEFAULT_AGENT_CONFIGURATION);
});

test('save validation rejects invalid bounds, unknown keys, duplicate tools and unsafe paths', () => {
  const invalid = [
    { maxTokens: 32001 }, { maxCommands: -1 }, { toolCallLimit: 3 }, { maxRepairAttempts: 0 },
    { temperature: NaN }, { timeoutSeconds: 10.5 }, { runTokenBudget: 999 }, { runTokenBudget: 5000001 },
    { maxFileEdits: '5' }, { reasoningEffort: 'maximum' }, { apiKey: 'never-store-this' },
    { enabledTools: ['edit_file', 'edit_file'] }, { enabledTools: ['shell'] },
    { instructions: 'x'.repeat(12001) }, { pinnedFiles: ['../secret'] }, { pinnedFiles: ['C:/app.ts'] },
    { pinnedFiles: ['app.ts:stream'] }, { pinnedFiles: ['CON.ts'] }, { pinnedFiles: ['src/*.ts'] },
    { pinnedFiles: Array.from({ length: 6 }, (_, index) => `${index}.ts`) },
    { excludedPaths: ['src/{one,two}'] }, { excludedPaths: ['../*'] }
  ];
  for (const value of invalid) assert.equal(typeof validateConfigurationOverrides(value), 'string', JSON.stringify(value));
  assert.equal(validateConfigurationOverrides({ maxFileEdits: 0, maxCommands: 0, runTokenBudget: 0,
    excludedPaths: ['build/', '**/*.test.ts'], pinnedFiles: ['src/app.ts'], enabledTools: [] }), undefined);
});

test('stored override recovery preserves valid values without reviving unsupported settings', () => {
  assert.deepEqual(parseConfigurationOverrides({ maxCommands: 9, instructions: 'Use simple language.',
    pinnedFiles: ['src\\app.ts'], unknown: true, toolCallLimit: Infinity }), {
    maxCommands: 9, instructions: 'Use simple language.', pinnedFiles: ['src/app.ts']
  });
  assert.deepEqual(parseModelProfileSettings({ maxTokens: 3000, instructions: 'not a profile field', reasoningEffort: 'high' }),
    { maxTokens: 3000, reasoningEffort: 'high' });
});

test('removed preset and template helpers are no longer exported', () => {
  const configuration = require('../out/configuration');
  for (const key of ['BUILT_IN_PRESETS', 'BUILT_IN_PROMPT_TEMPLATES', 'parseAgentPresets', 'parsePromptTemplates']) {
    assert.equal(key in configuration, false);
  }
});
