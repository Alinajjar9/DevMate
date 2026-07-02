const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_AGENT_CHECKPOINT_AGE_MS,
  parseAgentRunCheckpoint
} = require('../out/agentCheckpoint');

const now = 1_800_000_000_000;

test('parses a bounded workspace and session agent checkpoint', () => {
  const checkpoint = validCheckpoint();
  assert.deepEqual(parseAgentRunCheckpoint(checkpoint, now), checkpoint);
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
