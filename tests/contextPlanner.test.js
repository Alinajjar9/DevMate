const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CONTEXT_PRIORITY_ORDER,
  CONTEXT_TOKEN_SAFETY_MARGIN,
  createContextBudget,
  DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
  estimateContextTokens,
  isValidMaxInputContextTokens,
  isValidModelContextWindowTokens,
  normalizeMaxInputContextTokens,
  normalizeModelContextWindowTokens,
  omittedAgentToolResult,
  planAskRequestContext,
  planContextCandidates
} = require('../out/contextPlanner');

test('uses a conservative default context window and reserves output capacity', () => {
  const budget = createContextBudget({ reservedOutputTokens: 8_000 });

  assert.equal(budget.modelContextWindowTokens, DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS);
  assert.equal(budget.usedDefaultContextWindow, true);
  assert.equal(budget.inputTokensBeforeSafetyMargin, 24_000);
  assert.equal(budget.safetyMarginTokens, 2_400);
  assert.equal(budget.usableInputTokens, 21_600);
  assert.equal(CONTEXT_TOKEN_SAFETY_MARGIN, 0.1);
});

test('honors model and user input limits before applying the safety margin', () => {
  const budget = createContextBudget({
    modelContextWindowTokens: 128_000,
    maxInputContextTokens: 20_000,
    reservedOutputTokens: 16_000
  });

  assert.deepEqual(budget, {
    modelContextWindowTokens: 128_000,
    configuredMaxInputTokens: 20_000,
    reservedOutputTokens: 16_000,
    inputTokensBeforeSafetyMargin: 20_000,
    safetyMarginTokens: 2_000,
    usableInputTokens: 18_000,
    usedDefaultContextWindow: false
  });
});

test('returns no optional input capacity when output consumes the safe window', () => {
  const budget = createContextBudget({
    modelContextWindowTokens: 16_000,
    maxInputContextTokens: 12_000,
    reservedOutputTokens: 16_000
  });

  assert.equal(budget.inputTokensBeforeSafetyMargin, 0);
  assert.equal(budget.usableInputTokens, 0);
});

test('normalizes persisted context-window and Auto input settings', () => {
  assert.equal(normalizeModelContextWindowTokens(128_000), 128_000);
  assert.equal(normalizeModelContextWindowTokens(500), undefined);
  assert.equal(isValidModelContextWindowTokens(undefined), true);
  assert.equal(isValidModelContextWindowTokens(4_000_001), false);
  assert.equal(normalizeMaxInputContextTokens(undefined), 0);
  assert.equal(normalizeMaxInputContextTokens(0), 0);
  assert.equal(normalizeMaxInputContextTokens(24_000), 24_000);
  assert.equal(isValidMaxInputContextTokens(127), false);
});

test('estimates text deterministically from UTF-16 characters', () => {
  assert.equal(estimateContextTokens(''), 0);
  assert.equal(estimateContextTokens('1234'), 1);
  assert.equal(estimateContextTokens('12345'), 2);
  assert.equal(estimateContextTokens('😀😀'), 1);
});

test('selects optional context by the declared priority order', () => {
  const candidates = [
    candidate('old-tool', 'older-tool-result', 2),
    candidate('project', 'project-result', 4),
    candidate('question', 'question', 3, true),
    candidate('selection', 'explicit-context', 4),
    candidate('recent-chat', 'recent-conversation', 3)
  ];

  const plan = planContextCandidates(candidates, 10);

  assert.deepEqual(CONTEXT_PRIORITY_ORDER, [
    'instructions',
    'question',
    'explicit-context',
    'operation-state',
    'recent-conversation',
    'compacted-summary',
    'project-result',
    'older-tool-result'
  ]);
  assert.deepEqual(plan.selected.map((item) => item.id), [
    'question',
    'selection',
    'recent-chat'
  ]);
  assert.deepEqual(plan.omitted.map((item) => item.id), ['project', 'old-tool']);
  assert.equal(plan.usedTokens, 10);
  assert.equal(plan.remainingTokens, 0);
});

test('keeps mandatory input visible and reports budget overflow', () => {
  const plan = planContextCandidates([
    candidate('instructions', 'instructions', 6, true),
    candidate('question', 'question', 7, true),
    candidate('project', 'project-result', 1)
  ], 10);

  assert.deepEqual(plan.selected.map((item) => item.id), ['instructions', 'question']);
  assert.deepEqual(plan.omitted.map((item) => item.id), ['project']);
  assert.equal(plan.usedTokens, 13);
  assert.equal(plan.remainingTokens, 0);
  assert.equal(plan.overflowTokens, 3);
});

test('rejects ambiguous candidate identifiers and invalid estimates', () => {
  assert.throws(() => planContextCandidates([
    candidate('same', 'question', 1),
    candidate('same', 'project-result', 1)
  ], 10), /unique/);
  assert.throws(() => planContextCandidates([
    candidate('invalid', 'question', -1)
  ], 10), /non-negative integers/);
  assert.throws(() => planContextCandidates([], -1), /input-token budget/);
});

test('keeps explicit attachments and recent chat ahead of project retrieval', () => {
  const attachment = contextItem('attachment', 'notes.txt', 'a'.repeat(4_000));
  const projectResult = contextItem('file', 'src/project.ts', 'p'.repeat(8_000));
  const recentTurn = { user: 'u'.repeat(2_000), assistant: 'a'.repeat(2_000) };

  const plan = planAskRequestContext({
    question: 'Current question',
    scope: {
      type: 'project',
      workspacePath: 'C:/repo',
      items: [projectResult, attachment]
    },
    conversationHistory: [recentTurn],
    toolHistory: [],
    modelContextWindowTokens: 20_000,
    maxInputContextTokens: 8_000,
    reservedOutputTokens: 0
  });

  assert.deepEqual(plan.scope.items, [attachment]);
  assert.deepEqual(plan.conversationHistory, [recentTurn]);
  assert.ok(plan.requestedTokens > plan.usedTokens);
  assert.equal(plan.omittedContextItems, 1);
  assert.equal(plan.omittedConversationTurns, 0);
  assert.equal(plan.overflowTokens, 0);
});

test('budgets recent exact chat before a compacted summary and project results', () => {
  const recentTurn = { user: 'u'.repeat(2_000), assistant: 'a'.repeat(2_000) };
  const summary = compactedSummary('s'.repeat(4_000));
  const projectResult = contextItem('file', 'src/project.ts', 'p'.repeat(8_000));

  const plan = planAskRequestContext({
    question: 'Continue',
    scope: {
      type: 'project',
      workspacePath: 'C:/repo',
      items: [projectResult]
    },
    conversationHistory: [recentTurn],
    compactedSummary: summary,
    toolHistory: [],
    modelContextWindowTokens: 20_000,
    maxInputContextTokens: 8_000,
    reservedOutputTokens: 0
  });

  assert.deepEqual(plan.conversationHistory, [recentTurn]);
  assert.deepEqual(plan.compactedSummary, summary);
  assert.deepEqual(plan.scope.items, []);
});

test('keeps tool-call shells while compacting older results before the newest result', () => {
  const older = toolStep('older', 'o'.repeat(4_000));
  const newest = toolStep('newest', 'n'.repeat(4_000));

  const plan = planAskRequestContext({
    question: 'Continue',
    scope: { type: 'project', workspacePath: 'C:/repo', items: [] },
    conversationHistory: [],
    toolHistory: [older, newest],
    modelContextWindowTokens: 20_000,
    maxInputContextTokens: 6_500,
    reservedOutputTokens: 0
  });

  assert.equal(plan.toolHistory.length, 2);
  assert.equal(plan.toolHistory[0].callId, older.callId);
  assert.equal(plan.toolHistory[0].result, omittedAgentToolResult('read_file'));
  assert.equal(plan.toolHistory[1].result, newest.result);
  assert.equal(plan.compactedToolResults, 1);
});

test('retains an explicit selection when mandatory context exceeds the budget', () => {
  const selection = contextItem('selection', 'src/large.ts', 'x'.repeat(8_000));
  const plan = planAskRequestContext({
    question: 'Explain this selection',
    scope: { type: 'selection', workspacePath: 'C:/repo', items: [selection] },
    conversationHistory: [],
    toolHistory: [],
    modelContextWindowTokens: 1_024,
    reservedOutputTokens: 128
  });

  assert.deepEqual(plan.scope.items, [selection]);
  assert.ok(plan.overflowTokens > 0);
});

test('never sends older conversation turns across a missing newer turn', () => {
  const olderTurn = { user: 'old', assistant: 'small' };
  const newestTurn = { user: 'u'.repeat(8_000), assistant: 'a'.repeat(8_000) };
  const plan = planAskRequestContext({
    question: 'Continue',
    scope: { type: 'project', workspacePath: 'C:/repo', items: [] },
    conversationHistory: [olderTurn, newestTurn],
    toolHistory: [],
    modelContextWindowTokens: 10_000,
    maxInputContextTokens: 5_000,
    reservedOutputTokens: 0
  });

  assert.deepEqual(plan.conversationHistory, []);
  assert.equal(plan.omittedConversationTurns, 2);
});

function candidate(id, priority, estimatedTokens, required = false) {
  return {
    id,
    priority,
    estimatedTokens,
    required,
    value: id
  };
}

function contextItem(source, filePath, content) {
  return {
    source,
    filePath,
    languageId: 'typescript',
    content,
    includedCharacters: content.length,
    totalCharacters: content.length,
    truncated: false
  };
}

function compactedSummary(goal) {
  return {
    goal,
    constraints: [],
    decisions: [],
    importantFiles: [],
    completedWork: [],
    openTasks: [],
    unresolvedQuestions: []
  };
}

function toolStep(callId, result) {
  return {
    callId,
    name: 'read_file',
    arguments: { path: `src/${callId}.ts` },
    result,
    isError: false
  };
}
