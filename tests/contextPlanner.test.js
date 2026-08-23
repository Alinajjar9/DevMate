const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CONTEXT_PRIORITY_ORDER,
  CONTEXT_TOKEN_SAFETY_MARGIN,
  createContextBudget,
  DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
  estimateContextTokens,
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
    'pinned-memory',
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

function candidate(id, priority, estimatedTokens, required = false) {
  return {
    id,
    priority,
    estimatedTokens,
    required,
    value: id
  };
}
