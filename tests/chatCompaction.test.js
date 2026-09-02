const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CHAT_COMPACTION_RECENT_TURNS,
  CHAT_COMPACTION_TRIGGER_RATIO,
  ChatCompactionController,
  chatCompactionBoundary
} = require('../out/sessions/chatCompaction');

const ACCESS = {
  backendUrl: 'http://127.0.0.1:8000',
  backendToken: 'backend-token-that-is-long-enough',
  providerApiKey: 'provider-secret'
};
const SETTINGS = {
  provider: 'openai',
  model: 'test-model',
  baseUrl: 'https://provider.example/v1',
  maxTokens: 128,
  temperature: 0.2,
  reasoningEffort: 'auto',
  timeoutSeconds: 900
};

test('derives a compaction boundary that leaves the latest four completed turns verbatim', () => {
  assert.equal(CHAT_COMPACTION_TRIGGER_RATIO, 0.75);
  assert.equal(CHAT_COMPACTION_RECENT_TURNS, 4);
  assert.equal(chatCompactionBoundary(4), undefined);
  assert.equal(chatCompactionBoundary(5), 0);
  assert.equal(chatCompactionBoundary(8), 3);
  assert.equal(chatCompactionBoundary(-1), undefined);
  assert.equal(chatCompactionBoundary(5.5), undefined);
});

test('loads an existing summary even when too few turns exist for new compaction', async () => {
  const storedSummary = summaryThrough(0);
  const controller = new ChatCompactionController({
    load: async () => ok({ summary: storedSummary }),
    compact: async () => assert.fail('the model should not be called')
  });

  const result = await controller.compactIfNeeded(inputWithTurns(4, 'short'));

  assert.deepEqual(result, {
    kind: 'not-needed',
    reason: 'too-few-turns',
    summary: storedSummary
  });
});

test('does not compact a short chat below seventy-five percent of usable input', async () => {
  let compactCalls = 0;
  const controller = new ChatCompactionController({
    load: async () => ok({ summary: null }),
    compact: async () => {
      compactCalls += 1;
      return assert.fail('the model should not be called below the threshold');
    }
  });

  const result = await controller.compactIfNeeded(inputWithTurns(5, 'short'));

  assert.equal(result.kind, 'not-needed');
  assert.equal(result.reason, 'below-threshold');
  assert.equal(result.summary, null);
  assert.ok(result.requestedTokens < result.triggerTokens);
  assert.equal(compactCalls, 0);
});

test('compacts only older completed turns after the planned context reaches the threshold', async () => {
  let compactRequest;
  let compactAccess;
  let started = 0;
  const controller = new ChatCompactionController({
    load: async (access, request) => {
      assert.deepEqual(access, ACCESS);
      assert.deepEqual(request, { sessionId: 'session-one' });
      return ok({ summary: null });
    },
    compact: async (access, request) => {
      compactAccess = access;
      compactRequest = request;
      return ok({
        summary: summaryThrough(request.throughTurn),
        compactedTurns: request.throughTurn + 1
      });
    }
  });

  const result = await controller.compactIfNeeded(
    inputWithTurns(8, 'large'),
    undefined,
    () => {
      started += 1;
    }
  );

  assert.equal(result.kind, 'completed');
  assert.equal(result.throughTurn, 3);
  assert.equal(result.compactedTurns, 4);
  assert.equal(result.summary.lastCompactedTurn, 3);
  assert.ok(result.requestedTokens >= result.triggerTokens);
  assert.equal(started, 1);
  assert.deepEqual(compactAccess, ACCESS);
  assert.deepEqual(compactRequest, {
    sessionId: 'session-one',
    throughTurn: 3,
    settings: SETTINGS
  });
});

test('merges only newly eligible turns after the previous compaction boundary', async () => {
  const calls = [];
  const controller = new ChatCompactionController({
    load: async () => ok({ summary: summaryThrough(0) }),
    compact: async (_access, request) => {
      calls.push(request);
      return ok({ summary: summaryThrough(request.throughTurn), compactedTurns: 1 });
    }
  });
  const input = inputWithTurns(6, 'large');
  input.scope.items.push(contextItem('x'.repeat(20_000)));

  const result = await controller.compactIfNeeded(input);

  assert.equal(result.kind, 'completed');
  assert.equal(result.throughTurn, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].throughTurn, 1);
});

test('avoids repeated model calls when the eligible boundary is already summarized', async () => {
  const controller = new ChatCompactionController({
    load: async () => ok({ summary: summaryThrough(3) }),
    compact: async () => assert.fail('an up-to-date summary must not be regenerated')
  });

  const result = await controller.compactIfNeeded(inputWithTurns(8, 'large'));

  assert.deepEqual(result, {
    kind: 'not-needed',
    reason: 'already-compacted',
    summary: summaryThrough(3)
  });
});

test('treats storage and provider failures as non-throwing maintenance failures', async () => {
  const loadFailure = new ChatCompactionController({
    load: async () => ({ status: 'error', message: 'Summary unavailable.' }),
    compact: async () => assert.fail('compaction should not follow a load failure')
  });
  const providerFailure = new ChatCompactionController({
    load: async () => ok({ summary: null }),
    compact: async () => {
      throw new Error('Provider unavailable.');
    }
  });

  assert.deepEqual(await loadFailure.compactIfNeeded(inputWithTurns(8, 'large')), {
    kind: 'failed',
    message: 'Summary unavailable.'
  });
  assert.deepEqual(await providerFailure.compactIfNeeded(inputWithTurns(8, 'large')), {
    kind: 'failed',
    message: 'Provider unavailable.',
    summary: null
  });
});

test('propagates cancellation without starting or continuing compaction', async () => {
  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  const untouched = new ChatCompactionController({
    load: async () => assert.fail('cancelled work should not start'),
    compact: async () => assert.fail('cancelled work should not start')
  });
  assert.deepEqual(
    await untouched.compactIfNeeded(inputWithTurns(8, 'large'), alreadyCancelled.signal),
    { kind: 'cancelled' }
  );

  const controller = new ChatCompactionController({
    load: async () => ({ status: 'error', errorKind: 'cancelled' }),
    compact: async () => assert.fail('cancelled loading should stop compaction')
  });
  assert.deepEqual(await controller.compactIfNeeded(inputWithTurns(8, 'large')), {
    kind: 'cancelled'
  });
});

function inputWithTurns(count, size) {
  const content = size === 'large' ? 'x'.repeat(6_000) : 'short';
  return {
    session: {
      id: 'session-one',
      title: 'Chat',
      workspaceId: 'file:///workspace',
      workspaceName: 'Workspace',
      createdAt: 100,
      updatedAt: 200,
      turns: Array.from({ length: count }, (_, index) => ({
        user: `${index}:${content}`,
        assistant: `${index}:${content}`
      }))
    },
    question: 'Continue the work',
    scope: { type: 'project', workspacePath: 'C:/workspace', items: [] },
    modelContextWindowTokens: 32_000,
    maxInputContextTokens: 0,
    settings: { ...SETTINGS },
    access: { ...ACCESS }
  };
}

function contextItem(content) {
  return {
    source: 'file',
    filePath: 'src/large.ts',
    languageId: 'typescript',
    content,
    includedCharacters: content.length,
    totalCharacters: content.length,
    truncated: false
  };
}

function summaryThrough(lastCompactedTurn) {
  return {
    sessionId: 'session-one',
    summaryVersion: 1,
    content: {
      goal: 'Keep the conversation compact.',
      constraints: [],
      decisions: [],
      importantFiles: [],
      completedWork: [],
      openTasks: [],
      unresolvedQuestions: []
    },
    lastCompactedTurn,
    createdAtMs: 300,
    updatedAtMs: 300
  };
}

function ok(data) {
  return { status: 'ok', data };
}
