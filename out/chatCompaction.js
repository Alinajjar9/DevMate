"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatCompactionController = exports.defaultChatCompactionApi = exports.CHAT_COMPACTION_RECENT_TURNS = exports.CHAT_COMPACTION_TRIGGER_RATIO = void 0;
exports.chatCompactionBoundary = chatCompactionBoundary;
const client_1 = require("./api/client");
const contextPlanner_1 = require("./contextPlanner");
exports.CHAT_COMPACTION_TRIGGER_RATIO = 0.75;
exports.CHAT_COMPACTION_RECENT_TURNS = 4;
const COMPACTED_SUMMARY_OVERHEAD_TOKENS = 48;
exports.defaultChatCompactionApi = {
    load: (access, request, signal) => (0, client_1.loadChatMemorySummary)(access.backendUrl, request, access.backendToken, signal),
    compact: (access, request, signal) => (0, client_1.compactChatMemorySummary)(access.backendUrl, request, {
        backendToken: access.backendToken,
        providerApiKey: access.providerApiKey
    }, undefined, signal)
};
class ChatCompactionController {
    api;
    constructor(api = exports.defaultChatCompactionApi) {
        this.api = api;
    }
    async compactIfNeeded(input, signal, onCompactionStarted = () => undefined) {
        if (signal?.aborted) {
            return { kind: 'cancelled' };
        }
        const completedTurnCount = completedTurnPrefixLength(input.session);
        const throughTurn = chatCompactionBoundary(completedTurnCount);
        if (throughTurn === undefined) {
            return { kind: 'not-needed', reason: 'too-few-turns' };
        }
        let loaded;
        try {
            loaded = await this.api.load(input.access, { sessionId: input.session.id }, signal);
        }
        catch (error) {
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
        const contextPlan = (0, contextPlanner_1.planAskRequestContext)({
            question: input.question,
            scope: input.scope,
            conversationHistory: uncompactedHistory,
            toolHistory: [],
            modelContextWindowTokens: input.modelContextWindowTokens,
            maxInputContextTokens: input.maxInputContextTokens,
            reservedOutputTokens: input.settings.maxTokens
        });
        const summaryTokens = previousSummary
            ? (0, contextPlanner_1.estimateContextTokens)(JSON.stringify(previousSummary.content))
                + COMPACTED_SUMMARY_OVERHEAD_TOKENS
            : 0;
        const requestedTokens = contextPlan.requestedTokens + summaryTokens;
        const usableInputTokens = contextPlan.budget.usableInputTokens;
        if (usableInputTokens <= 0) {
            return { kind: 'not-needed', reason: 'no-input-capacity' };
        }
        const triggerTokens = Math.ceil(usableInputTokens * exports.CHAT_COMPACTION_TRIGGER_RATIO);
        if (requestedTokens < triggerTokens) {
            return {
                kind: 'not-needed',
                reason: 'below-threshold',
                requestedTokens,
                triggerTokens
            };
        }
        onCompactionStarted();
        let compacted;
        try {
            compacted = await this.api.compact(input.access, {
                sessionId: input.session.id,
                throughTurn,
                settings: input.settings
            }, signal);
        }
        catch (error) {
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
exports.ChatCompactionController = ChatCompactionController;
function chatCompactionBoundary(completedTurnCount) {
    if (!Number.isInteger(completedTurnCount)
        || completedTurnCount <= exports.CHAT_COMPACTION_RECENT_TURNS) {
        return undefined;
    }
    return completedTurnCount - exports.CHAT_COMPACTION_RECENT_TURNS - 1;
}
function completedTurnPrefixLength(session) {
    const pendingIndex = session.turns.findIndex((turn) => !turn.assistant.trim());
    return pendingIndex < 0 ? session.turns.length : pendingIndex;
}
function failedOutcome(error, fallback) {
    return {
        kind: 'failed',
        message: error instanceof Error ? error.message : fallback
    };
}
//# sourceMappingURL=chatCompaction.js.map