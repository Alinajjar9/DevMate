const assert = require('node:assert/strict');
const test = require('node:test');
const { providerState } = require('./helpers/providerState');
const { normalizeAgentConfiguration } = require('../out/configuration');

const {
  MAX_AGENT_CHECKPOINT_AGE_MS,
  parseAgentRunCheckpoint
} = require('../out/sessions');

const now = 1_800_000_000_000;

test('parses a bounded workspace and session agent checkpoint', () => {
  const checkpoint = validCheckpoint();
  assert.deepEqual(parseAgentRunCheckpoint(checkpoint, now), checkpoint);
});

test('accepts every read-only tool in checkpoint history', () => {
  const checkpoint = validCheckpoint();
  checkpoint.toolHistory = [
    { ...toolStep(1), name: 'get_diagnostics', arguments: { path: '' } },
    { ...toolStep(2), name: 'read_terminal_errors', arguments: { maxResults: 3 } },
    { ...toolStep(3), name: 'get_symbols', arguments: { path: 'main.py' } },
    { ...toolStep(4), name: 'find_definition', arguments: { path: 'main.py', line: 4, column: 1 } },
    { ...toolStep(5), name: 'find_references', arguments: { path: 'main.py', line: 4, column: 1 } }
  ];
  assert.deepEqual(parseAgentRunCheckpoint(checkpoint, now), checkpoint);
});

test('restores provider continuation data and refuses invalid or excessive saved state', () => {
  const checkpoint = validCheckpoint();
  checkpoint.toolHistory[0].providerState = providerState(checkpoint.toolHistory[0].callId);
  const restored = parseAgentRunCheckpoint(JSON.parse(JSON.stringify(checkpoint)), now);
  assert.deepEqual(restored, checkpoint);
  checkpoint.toolHistory[0].providerState.outputItems[0].summary = ['private'];
  assert.equal(parseAgentRunCheckpoint(checkpoint, now), undefined);

  const largeCheckpoint = validCheckpoint();
  largeCheckpoint.toolHistory = Array.from({ length: 9 }, (_, index) => {
    const state = providerState(`call-${index}`);
    state.outputItems[0].encrypted_content = 'x'.repeat(999_900);
    return { ...toolStep(index), providerState: state };
  });
  assert.equal(parseAgentRunCheckpoint(largeCheckpoint, now), undefined);
});

test('checkpoints preserve configuration and reject invalid or oversized instruction overrides', () => {
  const checkpoint = { ...validCheckpoint(), configuration: normalizeAgentConfiguration({ maxFileEdits: 12, maxCommands: 8 }),
    instructions: 'Use the saved project conventions.', fileMutationCalls: 7, commandCalls: 4 };
  assert.deepEqual(parseAgentRunCheckpoint(JSON.parse(JSON.stringify(checkpoint)), now), checkpoint);
  assert.equal(parseAgentRunCheckpoint({ ...checkpoint, configuration: { maxCommands: -1 } }, now), undefined);
  assert.equal(parseAgentRunCheckpoint({ ...checkpoint, instructions: 'x'.repeat(12001) }, now), undefined);
});

test('rejects stale, oversized, duplicate, and invalid agent checkpoints', () => {
  const cases = [
    { ...validCheckpoint(), updatedAt: now - MAX_AGENT_CHECKPOINT_AGE_MS - 1 },
    { ...validCheckpoint(), workspaceId: '' },
    { ...validCheckpoint(), toolHistory: Array.from({ length: 101 }, (_, index) => toolStep(index)) },
    { ...validCheckpoint(), toolHistory: [toolStep(1), toolStep(1)] },
    { ...validCheckpoint(), toolHistory: [{ ...toolStep(1), name: 'shell' }] },
    { ...validCheckpoint(), toolSignatures: [{ signature: 'unsafe', revision: 0, executions: 1 }] }
  ];
  for (const value of cases) {
    assert.equal(parseAgentRunCheckpoint(value, now), undefined);
  }
});

function validCheckpoint() {
  return {
    version: 1,
    workspaceId: 'file:///workspace',
    sessionId: 'session-1',
    question: 'Continue building the backend.',
    mode: 'code',
    scopeKind: 'project',
    toolHistory: [toolStep(1)],
    toolUsedFiles: ['main.py'],
    toolSignatures: [{ signature: 'a'.repeat(64), revision: 0, executions: 1 }],
    fileMutationCalls: 0,
    mutationCharacters: 0,
    commandCalls: 0,
    dependencyInstallCalls: 0,
    workspaceRevision: 0,
    forceFinalAnswer: false,
    disableThinking: true,
    emptyResponseRecoveryAttempted: true,
    inputTokens: 1200,
    outputTokens: 80,
    totalTokens: 1280,
    tokenUsageExact: false,
    createdAt: now - 1_000,
    updatedAt: now
  };
}

function toolStep(index) {
  return {
    callId: `call-${index}`,
    name: 'read_file',
    arguments: { path: 'main.py' },
    result: 'file content',
    isError: false
  };
}
