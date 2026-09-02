// Decide when older completed turns need a model-generated summary.
// Keep recent turns exact and reuse the previous summary if compaction fails.

import {
  compactChatMemorySummary,
  loadChatMemorySummary
} from '../api/client';
import type {
  ApiResult,
  AskScope,
  ChatMemoryCompactionRequest,
  ChatMemoryCompactionResponse,
  ChatMemorySessionRequest,
  ChatMemorySummary,
  ChatMemorySummaryLoadResponse,
  LlmSettings
} from '../api/types';
import { planAskRequestContext } from '../context/contextPlanner';
import type { ConversationSession } from './sessions';

// Start before the input budget is full, leaving room for the next question and its context.
export const CHAT_COMPACTION_TRIGGER_RATIO = 0.75;
export const CHAT_COMPACTION_RECENT_TURNS = 4;

export type ChatCompactionAccess = {
  backendUrl: string;
  backendToken: string;
  providerApiKey?: string;
};

export type AutomaticChatCompactionInput = {
  session: ConversationSession;
  question: string;
  scope: AskScope;
  modelContextWindowTokens?: number;
  maxInputContextTokens?: number;
  settings: LlmSettings;
  access: ChatCompactionAccess;
};

export type AutomaticChatCompactionOutcome =
  | {
    kind: 'completed';
    throughTurn: number;
    compactedTurns: number;
    requestedTokens: number;
    triggerTokens: number;
    summary: ChatMemorySummary;
  }
  | {
    kind: 'not-needed';
    reason: 'too-few-turns' | 'already-compacted' | 'below-threshold' | 'no-input-capacity';
    requestedTokens?: number;
    triggerTokens?: number;
    summary: ChatMemorySummary | null;
  }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string; summary?: ChatMemorySummary | null };

export type ChatCompactionApi = {
  load(
    access: ChatCompactionAccess,
    request: ChatMemorySessionRequest,
    signal?: AbortSignal
  ): Promise<ApiResult<ChatMemorySummaryLoadResponse>>;
  compact(
    access: ChatCompactionAccess,
    request: ChatMemoryCompactionRequest,
    signal?: AbortSignal
  ): Promise<ApiResult<ChatMemoryCompactionResponse>>;
};

export const defaultChatCompactionApi: ChatCompactionApi = {
  load: (access, request, signal) => loadChatMemorySummary(
    access.backendUrl,
    request,
    access.backendToken,
    signal
  ),
  compact: (access, request, signal) => compactChatMemorySummary(
    access.backendUrl,
    request,
    {
      backendToken: access.backendToken,
      providerApiKey: access.providerApiKey
    },
    undefined,
    signal
  )
};

export class ChatCompactionController {
  constructor(private readonly api: ChatCompactionApi = defaultChatCompactionApi) {}

  async compactIfNeeded(
    input: AutomaticChatCompactionInput,
    signal?: AbortSignal,
    onCompactionStarted: () => void = () => undefined
  ): Promise<AutomaticChatCompactionOutcome> {
    if (signal?.aborted) {
      return { kind: 'cancelled' };
    }
    const completedTurnCount = completedTurnPrefixLength(input.session);
    const throughTurn = chatCompactionBoundary(completedTurnCount);

    let loaded: ApiResult<ChatMemorySummaryLoadResponse>;
    try {
      loaded = await this.api.load(
        input.access,
        { sessionId: input.session.id },
        signal
      );
    } catch (error) {
      return failedOutcome(error, 'DevMate could not inspect the existing chat summary.');
    }
    if (signal?.aborted || loaded.errorKind === 'cancelled') {
      return { kind: 'cancelled' };
    }
    if (loaded.status !== 'ok' || !loaded.data) {
      return {
        kind: 'failed',
        message: loaded.message ?? 'DevMate could not inspect the existing chat summary.'
      };
    }

    // Load the previous summary even when no new compaction is needed; the caller still uses it.
    const previousSummary = loaded.data.summary;
    if (throughTurn === undefined) {
      return {
        kind: 'not-needed',
        reason: 'too-few-turns',
        summary: previousSummary
      };
    }
    const lastCompactedTurn = previousSummary?.lastCompactedTurn ?? -1;
    if (throughTurn <= lastCompactedTurn) {
      return {
        kind: 'not-needed',
        reason: 'already-compacted',
        summary: previousSummary
      };
    }

    // Already summarized turns must not be counted twice when deciding whether to compact again.
    const uncompactedHistory = input.session.turns
      .slice(lastCompactedTurn + 1, completedTurnCount)
      .map((turn) => ({ user: turn.user, assistant: turn.assistant }));
    const contextPlan = planAskRequestContext({
      question: input.question,
      scope: input.scope,
      conversationHistory: uncompactedHistory,
      compactedSummary: previousSummary?.content,
      toolHistory: [],
      modelContextWindowTokens: input.modelContextWindowTokens,
      maxInputContextTokens: input.maxInputContextTokens,
      reservedOutputTokens: input.settings.maxTokens
    });
    // Use demand before trimming. Measuring only selected context could hide an overfull history.
    const requestedTokens = contextPlan.requestedTokens;
    const usableInputTokens = contextPlan.budget.usableInputTokens;
    if (usableInputTokens <= 0) {
      return {
        kind: 'not-needed',
        reason: 'no-input-capacity',
        summary: previousSummary
      };
    }
    const triggerTokens = Math.ceil(
      usableInputTokens * CHAT_COMPACTION_TRIGGER_RATIO
    );
    if (requestedTokens < triggerTokens) {
      return {
        kind: 'not-needed',
        reason: 'below-threshold',
        requestedTokens,
        triggerTokens,
        summary: previousSummary
      };
    }

    onCompactionStarted();
    let compacted: ApiResult<ChatMemoryCompactionResponse>;
    try {
      compacted = await this.api.compact(input.access, {
        sessionId: input.session.id,
        throughTurn,
        settings: input.settings
      }, signal);
    } catch (error) {
      return failedOutcome(
        error,
        'DevMate could not compact the earlier chat context.',
        previousSummary
      );
    }
    if (signal?.aborted || compacted.errorKind === 'cancelled') {
      return { kind: 'cancelled' };
    }
    // A failed summary request leaves the last usable summary and raw transcript intact.
    if (compacted.status !== 'ok' || !compacted.data) {
      return {
        kind: 'failed',
        message: compacted.message ?? 'DevMate could not compact the earlier chat context.',
        summary: previousSummary
      };
    }
    return {
      kind: 'completed',
      throughTurn,
      compactedTurns: compacted.data.compactedTurns,
      requestedTokens,
      triggerTokens,
      summary: compacted.data.summary
    };
  }
}

export function chatCompactionBoundary(completedTurnCount: number): number | undefined {
  // Turn indexes are zero-based. The latest four completed turns remain outside the summary.
  if (!Number.isInteger(completedTurnCount)
    || completedTurnCount <= CHAT_COMPACTION_RECENT_TURNS) {
    return undefined;
  }
  return completedTurnCount - CHAT_COMPACTION_RECENT_TURNS - 1;
}

function completedTurnPrefixLength(session: ConversationSession): number {
  // Stop at the first unfinished question so compaction never jumps over an unanswered turn.
  const pendingIndex = session.turns.findIndex((turn) => !turn.assistant.trim());
  return pendingIndex < 0 ? session.turns.length : pendingIndex;
}

function failedOutcome(
  error: unknown,
  fallback: string,
  summary?: ChatMemorySummary | null
): AutomaticChatCompactionOutcome {
  return {
    kind: 'failed',
    message: error instanceof Error ? error.message : fallback,
    ...(summary !== undefined ? { summary } : {})
  };
}
