"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONTEXT_PRIORITY_ORDER = exports.ESTIMATED_CHARACTERS_PER_TOKEN = exports.CONTEXT_TOKEN_SAFETY_MARGIN = exports.MAX_MODEL_CONTEXT_WINDOW_TOKENS = exports.DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = void 0;
exports.createContextBudget = createContextBudget;
exports.estimateContextTokens = estimateContextTokens;
exports.planContextCandidates = planContextCandidates;
exports.DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 32_000;
exports.MAX_MODEL_CONTEXT_WINDOW_TOKENS = 4_000_000;
exports.CONTEXT_TOKEN_SAFETY_MARGIN = 0.1;
exports.ESTIMATED_CHARACTERS_PER_TOKEN = 4;
exports.CONTEXT_PRIORITY_ORDER = [
    'instructions',
    'question',
    'explicit-context',
    'operation-state',
    'pinned-memory',
    'recent-conversation',
    'compacted-summary',
    'project-result',
    'older-tool-result'
];
const priorityIndexes = new Map(exports.CONTEXT_PRIORITY_ORDER.map((priority, index) => [priority, index]));
function createContextBudget(options) {
    const configuredContextWindow = boundedPositiveInteger(options.modelContextWindowTokens, exports.MAX_MODEL_CONTEXT_WINDOW_TOKENS);
    const usedDefaultContextWindow = configuredContextWindow === undefined;
    const modelContextWindowTokens = configuredContextWindow
        ?? exports.DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS;
    const reservedOutputTokens = boundedNonNegativeInteger(options.reservedOutputTokens, exports.MAX_MODEL_CONTEXT_WINDOW_TOKENS) ?? 0;
    const configuredMaxInputTokens = boundedPositiveInteger(options.maxInputContextTokens, exports.MAX_MODEL_CONTEXT_WINDOW_TOKENS);
    const availableAfterOutput = Math.max(0, modelContextWindowTokens - reservedOutputTokens);
    const inputTokensBeforeSafetyMargin = configuredMaxInputTokens === undefined
        ? availableAfterOutput
        : Math.min(availableAfterOutput, configuredMaxInputTokens);
    const safetyMarginTokens = Math.ceil(inputTokensBeforeSafetyMargin * exports.CONTEXT_TOKEN_SAFETY_MARGIN);
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
function estimateContextTokens(value) {
    return Math.ceil(value.length / exports.ESTIMATED_CHARACTERS_PER_TOKEN);
}
function planContextCandidates(candidates, usableInputTokens) {
    const budget = boundedNonNegativeInteger(usableInputTokens, exports.MAX_MODEL_CONTEXT_WINDOW_TOKENS);
    if (budget === undefined) {
        throw new Error('The usable input-token budget must be a non-negative integer.');
    }
    const seenIds = new Set();
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
    }).sort((left, right) => ((priorityIndexes.get(left.candidate.priority) ?? Number.MAX_SAFE_INTEGER)
        - (priorityIndexes.get(right.candidate.priority) ?? Number.MAX_SAFE_INTEGER)
        || left.index - right.index));
    const requiredTokens = ranked.reduce((total, item) => total + (item.candidate.required ? item.candidate.estimatedTokens : 0), 0);
    let remainingForOptional = Math.max(0, budget - requiredTokens);
    const selectedIds = new Set(ranked.filter((item) => item.candidate.required).map((item) => item.candidate.id));
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
    const usedTokens = selected.reduce((total, candidate) => total + candidate.estimatedTokens, 0);
    return {
        selected,
        omitted,
        usedTokens,
        remainingTokens: Math.max(0, budget - usedTokens),
        overflowTokens: Math.max(0, usedTokens - budget)
    };
}
function boundedPositiveInteger(value, maximum) {
    return value !== undefined
        && Number.isInteger(value)
        && value > 0
        && value <= maximum
        ? value
        : undefined;
}
function boundedNonNegativeInteger(value, maximum) {
    return value !== undefined
        && Number.isInteger(value)
        && value >= 0
        && value <= maximum
        ? value
        : undefined;
}
//# sourceMappingURL=contextPlanner.js.map