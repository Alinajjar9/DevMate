import type {
  AgentToolStep,
  AskScope,
  ConversationTurn
} from './api/types';

export const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 32_000;
export const MIN_MODEL_CONTEXT_WINDOW_TOKENS = 1_024;
export const MAX_MODEL_CONTEXT_WINDOW_TOKENS = 4_000_000;
export const AUTO_MAX_INPUT_CONTEXT_TOKENS = 0;
export const MIN_MAX_INPUT_CONTEXT_TOKENS = 128;
export const CONTEXT_TOKEN_SAFETY_MARGIN = 0.1;
export const ESTIMATED_CHARACTERS_PER_TOKEN = 4;
export const CONTEXT_INSTRUCTION_RESERVE_TOKENS = 4_000;

const CONTEXT_ITEM_OVERHEAD_TOKENS = 48;
const CONVERSATION_TURN_OVERHEAD_TOKENS = 12;
const QUESTION_OVERHEAD_TOKENS = 32;
const TOOL_STEP_OVERHEAD_TOKENS = 24;
const RECENT_TOOL_RESULT_COUNT = 4;

export const CONTEXT_PRIORITY_ORDER = [
  'instructions',
  'question',
  'explicit-context',
  'operation-state',
  'pinned-memory',
  'recent-conversation',
  'compacted-summary',
  'project-result',
  'older-tool-result'
] as const;

export type ContextPriority = typeof CONTEXT_PRIORITY_ORDER[number];

export type ContextBudgetOptions = {
  modelContextWindowTokens?: number;
  maxInputContextTokens?: number;
  reservedOutputTokens: number;
};

export type ContextBudget = {
  modelContextWindowTokens: number;
  configuredMaxInputTokens?: number;
  reservedOutputTokens: number;
  inputTokensBeforeSafetyMargin: number;
  safetyMarginTokens: number;
  usableInputTokens: number;
  usedDefaultContextWindow: boolean;
};

export type ContextCandidate<T> = {
  id: string;
  priority: ContextPriority;
  estimatedTokens: number;
  required?: boolean;
  value: T;
};

export type ContextPlan<T> = {
  selected: ContextCandidate<T>[];
  omitted: ContextCandidate<T>[];
  usedTokens: number;
  remainingTokens: number;
  overflowTokens: number;
};

export type AskRequestContextPlanOptions = ContextBudgetOptions & {
  question: string;
  scope: AskScope;
  conversationHistory: readonly ConversationTurn[];
  toolHistory: readonly AgentToolStep[];
};

export type AskRequestContextPlan = {
  budget: ContextBudget;
  scope: AskScope;
  conversationHistory: ConversationTurn[];
  toolHistory: AgentToolStep[];
  usedTokens: number;
  remainingTokens: number;
  overflowTokens: number;
  omittedContextItems: number;
  omittedConversationTurns: number;
  compactedToolResults: number;
};

const priorityIndexes = new Map<ContextPriority, number>(
  CONTEXT_PRIORITY_ORDER.map((priority, index) => [priority, index])
);

export function createContextBudget(options: ContextBudgetOptions): ContextBudget {
  const configuredContextWindow = normalizeModelContextWindowTokens(
    options.modelContextWindowTokens
  );
  const usedDefaultContextWindow = configuredContextWindow === undefined;
  const modelContextWindowTokens = configuredContextWindow
    ?? DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS;
  const reservedOutputTokens = boundedNonNegativeInteger(
    options.reservedOutputTokens,
    MAX_MODEL_CONTEXT_WINDOW_TOKENS
  ) ?? 0;
  const normalizedMaxInputTokens = normalizeMaxInputContextTokens(
    options.maxInputContextTokens
  );
  const configuredMaxInputTokens = normalizedMaxInputTokens === AUTO_MAX_INPUT_CONTEXT_TOKENS
    ? undefined
    : normalizedMaxInputTokens;
  const availableAfterOutput = Math.max(
    0,
    modelContextWindowTokens - reservedOutputTokens
  );
  const inputTokensBeforeSafetyMargin = configuredMaxInputTokens === undefined
    ? availableAfterOutput
    : Math.min(availableAfterOutput, configuredMaxInputTokens);
  const safetyMarginTokens = Math.ceil(
    inputTokensBeforeSafetyMargin * CONTEXT_TOKEN_SAFETY_MARGIN
  );

  return {
    modelContextWindowTokens,
    ...(configuredMaxInputTokens !== undefined ? { configuredMaxInputTokens } : {}),
    reservedOutputTokens,
    inputTokensBeforeSafetyMargin,
    safetyMarginTokens,
    usableInputTokens: Math.max(0, inputTokensBeforeSafetyMargin - safetyMarginTokens),
    usedDefaultContextWindow
  };
}

export function estimateContextTokens(value: string): number {
  return Math.ceil(value.length / ESTIMATED_CHARACTERS_PER_TOKEN);
}

export function isValidModelContextWindowTokens(value: unknown): value is number | undefined {
  return value === undefined
    || Number.isInteger(value)
      && (value as number) >= MIN_MODEL_CONTEXT_WINDOW_TOKENS
      && (value as number) <= MAX_MODEL_CONTEXT_WINDOW_TOKENS;
}

export function normalizeModelContextWindowTokens(value: unknown): number | undefined {
  return isValidModelContextWindowTokens(value) ? value : undefined;
}

export function isValidMaxInputContextTokens(value: unknown): value is number {
  return Number.isInteger(value)
    && (value === AUTO_MAX_INPUT_CONTEXT_TOKENS
      || (value as number) >= MIN_MAX_INPUT_CONTEXT_TOKENS
        && (value as number) <= MAX_MODEL_CONTEXT_WINDOW_TOKENS);
}

export function normalizeMaxInputContextTokens(value: unknown): number {
  return isValidMaxInputContextTokens(value)
    ? value
    : AUTO_MAX_INPUT_CONTEXT_TOKENS;
}

export function planContextCandidates<T>(
  candidates: readonly ContextCandidate<T>[],
  usableInputTokens: number
): ContextPlan<T> {
  const budget = boundedNonNegativeInteger(
    usableInputTokens,
    MAX_MODEL_CONTEXT_WINDOW_TOKENS
  );
  if (budget === undefined) {
    throw new Error('The usable input-token budget must be a non-negative integer.');
  }

  const seenIds = new Set<string>();
  const ranked = candidates.map((candidate, index) => {
    if (!candidate.id.trim() || seenIds.has(candidate.id)) {
      throw new Error('Context candidate identifiers must be non-empty and unique.');
    }
    if (!priorityIndexes.has(candidate.priority)) {
      throw new Error(`Unknown context priority: ${String(candidate.priority)}.`);
    }
    if (!Number.isInteger(candidate.estimatedTokens) || candidate.estimatedTokens < 0) {
      throw new Error('Context candidate estimates must be non-negative integers.');
    }
    seenIds.add(candidate.id);
    return { candidate, index };
  }).sort((left, right) => (
    (priorityIndexes.get(left.candidate.priority) ?? Number.MAX_SAFE_INTEGER)
      - (priorityIndexes.get(right.candidate.priority) ?? Number.MAX_SAFE_INTEGER)
    || left.index - right.index
  ));

  const requiredTokens = ranked.reduce(
    (total, item) => total + (item.candidate.required ? item.candidate.estimatedTokens : 0),
    0
  );
  let remainingForOptional = Math.max(0, budget - requiredTokens);
  const selectedIds = new Set(
    ranked.filter((item) => item.candidate.required).map((item) => item.candidate.id)
  );

  for (const item of ranked) {
    const candidate = item.candidate;
    if (candidate.required || candidate.estimatedTokens > remainingForOptional) {
      continue;
    }
    selectedIds.add(candidate.id);
    remainingForOptional -= candidate.estimatedTokens;
  }

  const selected = ranked
    .filter((item) => selectedIds.has(item.candidate.id))
    .map((item) => item.candidate);
  const omitted = ranked
    .filter((item) => !selectedIds.has(item.candidate.id))
    .map((item) => item.candidate);
  const usedTokens = selected.reduce(
    (total, candidate) => total + candidate.estimatedTokens,
    0
  );

  return {
    selected,
    omitted,
    usedTokens,
    remainingTokens: Math.max(0, budget - usedTokens),
    overflowTokens: Math.max(0, usedTokens - budget)
  };
}

export function planAskRequestContext(
  options: AskRequestContextPlanOptions
): AskRequestContextPlan {
  const budget = createContextBudget(options);
  const candidates: ContextCandidate<string>[] = [
    {
      id: 'instructions',
      priority: 'instructions',
      estimatedTokens: CONTEXT_INSTRUCTION_RESERVE_TOKENS,
      required: true,
      value: 'instructions'
    },
    {
      id: 'question',
      priority: 'question',
      estimatedTokens: estimateContextTokens(options.question) + QUESTION_OVERHEAD_TOKENS,
      required: true,
      value: 'question'
    }
  ];

  options.scope.items.forEach((item, index) => {
    const explicit = item.source === 'attachment'
      || item.source === 'selection'
      || options.scope.type !== 'project';
    candidates.push({
      id: `scope:${index}`,
      priority: explicit ? 'explicit-context' : 'project-result',
      estimatedTokens: estimateContextTokens(
        `${item.filePath}\n${item.languageId}\n${item.content}`
      ) + CONTEXT_ITEM_OVERHEAD_TOKENS,
      required: explicit,
      value: `scope:${index}`
    });
  });

  for (let index = options.conversationHistory.length - 1; index >= 0; index -= 1) {
    const turn = options.conversationHistory[index];
    candidates.push({
      id: `conversation:${index}`,
      priority: 'recent-conversation',
      estimatedTokens: estimateContextTokens(`${turn.user}\n${turn.assistant}`)
        + CONVERSATION_TURN_OVERHEAD_TOKENS,
      value: `conversation:${index}`
    });
  }

  if (options.toolHistory.length > 0) {
    candidates.push({
      id: 'tool-history-shells',
      priority: 'operation-state',
      estimatedTokens: options.toolHistory.reduce((total, step) => (
        total + estimateToolStepShellTokens(step)
      ), 0),
      required: true,
      value: 'tool-history-shells'
    });
  }
  for (let index = options.toolHistory.length - 1; index >= 0; index -= 1) {
    const step = options.toolHistory[index];
    const marker = omittedAgentToolResult(step.name);
    candidates.push({
      id: `tool-result:${step.callId}`,
      priority: options.toolHistory.length - index <= RECENT_TOOL_RESULT_COUNT
        ? 'operation-state'
        : 'older-tool-result',
      estimatedTokens: Math.max(
        0,
        estimateContextTokens(step.result) - estimateContextTokens(marker)
      ),
      value: `tool-result:${step.callId}`
    });
  }

  const candidatePlan = planContextCandidates(candidates, budget.usableInputTokens);
  const selectedIds = new Set(candidatePlan.selected.map((candidate) => candidate.id));
  let newerConversationTurnWasOmitted = false;
  for (let index = options.conversationHistory.length - 1; index >= 0; index -= 1) {
    const id = `conversation:${index}`;
    if (!selectedIds.has(id)) {
      newerConversationTurnWasOmitted = true;
    } else if (newerConversationTurnWasOmitted) {
      selectedIds.delete(id);
    }
  }
  const scopeItems = options.scope.items.filter((_item, index) =>
    selectedIds.has(`scope:${index}`)
  );
  const conversationHistory = options.conversationHistory.filter((_turn, index) =>
    selectedIds.has(`conversation:${index}`)
  );
  let compactedToolResults = 0;
  const toolHistory = options.toolHistory.map((step) => {
    if (selectedIds.has(`tool-result:${step.callId}`)) {
      return { ...step };
    }
    compactedToolResults += 1;
    return { ...step, result: omittedAgentToolResult(step.name) };
  });
  const usedTokens = candidates.reduce(
    (total, candidate) => total + (selectedIds.has(candidate.id) ? candidate.estimatedTokens : 0),
    0
  );

  return {
    budget,
    scope: { ...options.scope, items: scopeItems },
    conversationHistory,
    toolHistory,
    usedTokens,
    remainingTokens: Math.max(0, budget.usableInputTokens - usedTokens),
    overflowTokens: Math.max(0, usedTokens - budget.usableInputTokens),
    omittedContextItems: options.scope.items.length - scopeItems.length,
    omittedConversationTurns: options.conversationHistory.length - conversationHistory.length,
    compactedToolResults
  };
}

export function omittedAgentToolResult(toolName: string): string {
  return `[Earlier ${toolName} result omitted to stay within the agent context budget.]`;
}

function estimateToolStepShellTokens(step: AgentToolStep): number {
  const marker = omittedAgentToolResult(step.name);
  return estimateContextTokens(
    `${step.callId}\n${step.name}\n${JSON.stringify(step.arguments)}\n${marker}`
  ) + TOOL_STEP_OVERHEAD_TOKENS;
}

function boundedNonNegativeInteger(
  value: number | undefined,
  maximum: number
): number | undefined {
  return value !== undefined
    && Number.isInteger(value)
    && value >= 0
    && value <= maximum
    ? value
    : undefined;
}
