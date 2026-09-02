const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AgentCheckpointController
} = require('../out/agentCheckpointController');
const {
  AGENT_CHECKPOINT_STORAGE_KEY
} = require('../out/sessions');

const NOW = 2_000_000_000_000;

test('loads a valid checkpoint only for its workspace and chat', () => {
  const persistence = memoryPersistence(validCheckpoint());
  const state = activeContext();
  const controller = new AgentCheckpointController(persistence, state.context, NOW);

  assert.equal(controller.current()?.question, 'Continue the fix');

  state.sessionId = 'another-chat';
  assert.equal(controller.current(), undefined);

  state.sessionId = 'session-a';
  state.workspaceId = 'workspace-b';
  assert.equal(controller.current(), undefined);
});

test('ignores invalid or expired stored checkpoints', () => {
  const invalid = { ...validCheckpoint(), updatedAt: NOW - 8 * 24 * 60 * 60 * 1_000 };
  const persistence = memoryPersistence(invalid);
  const state = activeContext();
  const controller = new AgentCheckpointController(persistence, state.context, NOW);

  assert.equal(controller.current(), undefined);
});

test('posts a small UI state for the active checkpoint', () => {
  const persistence = memoryPersistence(validCheckpoint({
    toolHistory: [toolStep()],
    inputTokens: 12,
    outputTokens: 7,
    totalTokens: 19,
    tokenUsageExact: true
  }));
  const state = activeContext();
  const controller = new AgentCheckpointController(persistence, state.context, NOW);

  controller.postState();

  assert.deepEqual(state.states, [{
    available: true,
    used: 1,
    limit: 16,
    tokenUsage: {
      inputTokens: 12,
      outputTokens: 7,
      totalTokens: 19,
      exact: true
    }
  }]);
});

test('saves a checkpoint before reporting the new state', async () => {
  const persistence = memoryPersistence();
  const state = activeContext();
  const controller = new AgentCheckpointController(persistence, state.context, NOW);
  const checkpoint = validCheckpoint({ question: 'Saved run' });

  await controller.save(checkpoint);

  assert.deepEqual(
    persistence.values.get(AGENT_CHECKPOINT_STORAGE_KEY),
    checkpoint
  );
  assert.equal(controller.current()?.question, 'Saved run');
  assert.equal(state.states.at(-1).available, true);
});

test('keeps the in-memory checkpoint and warns when saving fails', async () => {
  const persistence = memoryPersistence();
  persistence.writeState = async () => {
    throw new Error('storage unavailable');
  };
  const state = activeContext();
  const controller = new AgentCheckpointController(persistence, state.context, NOW);

  await controller.save(validCheckpoint());

  assert.equal(controller.current()?.question, 'Continue the fix');
  assert.deepEqual(state.warnings, [
    'DevMate could not persist the unfinished agent checkpoint.'
  ]);
  assert.equal(state.states.at(-1).available, true);
});

test('clears only the checkpoint belonging to the deleted chat', async () => {
  const persistence = memoryPersistence(validCheckpoint());
  const state = activeContext();
  const controller = new AgentCheckpointController(persistence, state.context, NOW);

  await controller.clearForSession('another-chat');
  assert.equal(controller.current()?.sessionId, 'session-a');
  assert.equal(state.states.length, 0);

  await controller.clearForSession('session-a');
  assert.equal(controller.current(), undefined);
  assert.equal(persistence.values.has(AGENT_CHECKPOINT_STORAGE_KEY), false);
  assert.deepEqual(state.states.at(-1), {
    available: false,
    used: 0,
    limit: 16,
    tokenUsage: undefined
  });
});

test('clears memory and warns even when stored checkpoint removal fails', async () => {
  const persistence = memoryPersistence(validCheckpoint());
  persistence.writeState = async () => {
    throw new Error('storage unavailable');
  };
  const state = activeContext();
  const controller = new AgentCheckpointController(persistence, state.context, NOW);

  await controller.clear();

  assert.equal(controller.current(), undefined);
  assert.deepEqual(state.warnings, [
    'DevMate could not remove the completed agent checkpoint.'
  ]);
  assert.equal(state.states.at(-1).available, false);
});

function validCheckpoint(overrides = {}) {
  return {
    version: 1,
    workspaceId: 'workspace-a',
    sessionId: 'session-a',
    question: 'Continue the fix',
    mode: 'debug',
    scopeKind: 'project',
    toolHistory: [],
    toolUsedFiles: [],
    toolSignatures: [],
    fileMutationCalls: 0,
    mutationCharacters: 0,
    commandCalls: 0,
    dependencyInstallCalls: 0,
    workspaceRevision: 0,
    forceFinalAnswer: false,
    disableThinking: false,
    emptyResponseRecoveryAttempted: false,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    tokenUsageExact: false,
    createdAt: NOW - 2_000,
    updatedAt: NOW - 1_000,
    ...overrides
  };
}

function toolStep() {
  return {
    callId: 'read-1',
    name: 'read_file',
    arguments: { path: 'src/app.ts' },
    result: 'source',
    isError: false
  };
}

function activeContext() {
  const state = {
    workspaceId: 'workspace-a',
    sessionId: 'session-a',
    states: [],
    warnings: []
  };
  state.context = {
    workspaceId: () => state.workspaceId,
    activeSessionId: () => state.sessionId,
    toolCallLimit: () => 16,
    stateChanged: (value) => state.states.push(value),
    reportWarning: (message) => state.warnings.push(message)
  };
  return state;
}

function memoryPersistence(checkpoint) {
  const values = new Map();
  if (checkpoint !== undefined) {
    values.set(AGENT_CHECKPOINT_STORAGE_KEY, structuredClone(checkpoint));
  }
  return {
    values,
    readState: (key) => values.get(key),
    writeState: async (key, value) => {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, structuredClone(value));
      }
    }
  };
}
