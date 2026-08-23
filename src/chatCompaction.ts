import {
  compactChatMemorySummary,
  loadChatMemorySummary
} from './api/client';
import type {
  ApiResult,
  AskScope,
  ChatMemoryCompactionRequest,
  ChatMemoryCompactionResponse,
  ChatMemorySessionRequest,
  ChatMemorySummaryLoadResponse,
  LlmSettings
} from './api/types';
import {
  estimateContextTokens,
  planAskRequestContext
} from './contextPlanner';
import type { ConversationSession } from './sessions';

export const CHAT_COMPACTION_TRIGGER_RATIO = 0.75;
export const CHAT_COMPACTION_RECENT_TURNS = 4;

const COMPACTED_SUMMARY_OVERHEAD_TOKENS = 48;

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
  }
  | {
    kind: 'not-needed';
    reason: 'too-few-turns' | 'already-compacted' | 'below-threshold' | 'no-input-capacity';
    requestedTokens?: number;
    triggerTokens?: number;
  }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

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
    if (throughTurn === undefined) {
      return { kind: 'not-needed', reason: 'too-few-turns' };
    }

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

    const previousSummary = loaded.data.summary;
    const lastCompactedTurn = previousSummary?.lastCompactedTurn ?? -1;
    if (throughTurn <= lastCompactedTurn) {
      return { kind: 'not-needed', reason: 'already-compacted' };
    }

    const uncompactedHistory = input.session.turns
      .slice(lastCompactedTurn + 1, completedTurnCount)
      .map((turn) => ({ user: turn.user, assistant: turn.assistant }));
    const contextPlan = planAskRequestContext({
      question: input.question,
      scope: input.scope,
      conversationHistory: uncompactedHistory,
      toolHistory: [],
      modelContextWindowTokens: input.modelContextWindowTokens,
      maxInputContextTokens: input.maxInputContextTokens,
      reservedOutputTokens: input.settings.maxTokens
    });
    const summaryTokens = previousSummary
      ? estimateContextTokens(JSON.stringify(previousSummary.content))
        + COMPACTED_SUMMARY_OVERHEAD_TOKENS
      : 0;
    const requestedTokens = contextPlan.requestedTokens + summaryTokens;
    const usableInputTokens = contextPlan.budget.usableInputTokens;
    if (usableInputTokens <= 0) {
      return { kind: 'not-needed', reason: 'no-input-capacity' };
    }
    const triggerTokens = Math.ceil(
      usableInputTokens * CHAT_COMPACTION_TRIGGER_RATIO
    );
    if (requestedTokens < triggerTokens) {
      return {
        kind: 'not-needed',
        reason: 'below-threshold',
        requestedTokens,
        triggerTokens
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
      return failedOutcome(error, 'DevMate could not compact the earlier chat context.');
    }
    if (signal?.aborted || compacted.errorKind === 'cancelled') {
      return { kind: 'cancelled' };
    }
    if (compacted.status !== 'ok' || !compacted.data) {
      return {
        kind: 'failed',
        message: compacted.message ?? 'DevMate could not compact the earlier chat context.'
      };
    }
    return {
      kind: 'completed',
      throughTurn,
      compactedTurns: compacted.data.compactedTurns,
      requestedTokens,
      triggerTokens
    };
  }
}

export function chatCompactionBoundary(completedTurnCount: number): number | undefined {
  if (!Number.isInteger(completedTurnCount)
    || completedTurnCount <= CHAT_COMPACTION_RECENT_TURNS) {
    return undefined;
  }
  return completedTurnCount - CHAT_COMPACTION_RECENT_TURNS - 1;
}

function completedTurnPrefixLength(session: ConversationSession): number {
  const pendingIndex = session.turns.findIndex((turn) => !turn.assistant.trim());
  return pendingIndex < 0 ? session.turns.length : pendingIndex;
}

function failedOutcome(error: unknown, fallback: string): AutomaticChatCompactionOutcome {
  return {
    kind: 'failed',
    message: error instanceof Error ? error.message : fallback
  };
}
