const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeAgentToolSettings } = require('../out/agentToolSettings');

test('keeps valid configurable agent-tool limits', () => {
  assert.deepEqual(normalizeAgentToolSettings({
    readFileMaxLines: 700,
    listFilesMaxResults: 350,
    searchCodeMaxResults: 120,
    diagnosticsMaxResults: 240,
    terminalErrorsMaxResults: 8
  }), {
    readFileMaxLines: 700,
    listFilesMaxResults: 350,
    searchCodeMaxResults: 120,
    diagnosticsMaxResults: 240,
    terminalErrorsMaxResults: 8
  });
});

test('defaults invalid values and clamps integer limits', () => {
  assert.deepEqual(normalizeAgentToolSettings({
    readFileMaxLines: 10,
    listFilesMaxResults: 900,
    searchCodeMaxResults: Number.NaN,
    diagnosticsMaxResults: 20.5,
    terminalErrorsMaxResults: 0
  }), {
    readFileMaxLines: 100,
    listFilesMaxResults: 500,
    searchCodeMaxResults: 50,
    diagnosticsMaxResults: 100,
    terminalErrorsMaxResults: 1
  });
});
