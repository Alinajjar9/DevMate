"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONTEXT_PRIORITY_ORDER = exports.CONTEXT_INSTRUCTION_RESERVE_TOKENS = exports.ESTIMATED_CHARACTERS_PER_TOKEN = exports.CONTEXT_TOKEN_SAFETY_MARGIN = exports.MIN_MAX_INPUT_CONTEXT_TOKENS = exports.AUTO_MAX_INPUT_CONTEXT_TOKENS = exports.MAX_MODEL_CONTEXT_WINDOW_TOKENS = exports.MIN_MODEL_CONTEXT_WINDOW_TOKENS = exports.DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = void 0;
exports.createContextBudget = createContextBudget;
exports.estimateContextTokens = estimateContextTokens;
exports.isValidModelContextWindowTokens = isValidModelContextWindowTokens;
exports.normalizeModelContextWindowTokens = normalizeModelContextWindowTokens;
exports.isValidMaxInputContextTokens = isValidMaxInputContextTokens;
exports.normalizeMaxInputContextTokens = normalizeMaxInputContextTokens;
exports.planContextCandidates = planContextCandidates;
exports.planAskRequestContext = planAskRequestContext;
exports.omittedAgentToolResult = omittedAgentToolResult;
exports.DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 32_000;
exports.MIN_MODEL_CONTEXT_WINDOW_TOKENS = 1_024;
exports.MAX_MODEL_CONTEXT_WINDOW_TOKENS = 4_000_000;
exports.AUTO_MAX_INPUT_CONTEXT_TOKENS = 0;
exports.MIN_MAX_INPUT_CONTEXT_TOKENS = 128;
exports.CONTEXT_TOKEN_SAFETY_MARGIN = 0.1;
exports.ESTIMATED_CHARACTERS_PER_TOKEN = 4;
exports.CONTEXT_INSTRUCTION_RESERVE_TOKENS = 4_000;
const CONTEXT_ITEM_OVERHEAD_TOKENS = 48;
const CONVERSATION_TURN_OVERHEAD_TOKENS = 12;
const QUESTION_OVERHEAD_TOKENS = 32;
const TOOL_STEP_OVERHEAD_TOKENS = 24;
const RECENT_TOOL_RESULT_COUNT = 4;
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
    const configuredContextWindow = normalizeModelContextWindowTokens(options.modelContextWindowTokens);
    const usedDefaultContextWindow = configuredContextWindow === undefined;
    const modelContextWindowTokens = configuredContextWindow
        ?? exports.DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS;
    const reservedOutputTokens = boundedNonNegativeInteger(options.reservedOutputTokens, exports.MAX_MODEL_CONTEXT_WINDOW_TOKENS) ?? 0;
    const normalizedMaxInputTokens = normalizeMaxInputContextTokens(options.maxInputContextTokens);
    const configuredMaxInputTokens = normalizedMaxInputTokens === exports.AUTO_MAX_INPUT_CONTEXT_TOKENS
        ? undefined
        : normalizedMaxInputTokens;
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
function isValidModelContextWindowTokens(value) {
    return value === undefined
        || Number.isInteger(value)
            && value >= exports.MIN_MODEL_CONTEXT_WINDOW_TOKENS
            && value <= exports.MAX_MODEL_CONTEXT_WINDOW_TOKENS;
}
function normalizeModelContextWindowTokens(value) {
    return isValidModelContextWindowTokens(value) ? value : undefined;
}
function isValidMaxInputContextTokens(value) {
    return Number.isInteger(value)
        && (value === exports.AUTO_MAX_INPUT_CONTEXT_TOKENS
            || value >= exports.MIN_MAX_INPUT_CONTEXT_TOKENS
                && value <= exports.MAX_MODEL_CONTEXT_WINDOW_TOKENS);
}
function normalizeMaxInputContextTokens(value) {
    return isValidMaxInputContextTokens(value)
        ? value
        : exports.AUTO_MAX_INPUT_CONTEXT_TOKENS;
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
function planAskRequestContext(options) {
    const budget = createContextBudget(options);
    const candidates = [
        {
            id: 'instructions',
            priority: 'instructions',
            estimatedTokens: exports.CONTEXT_INSTRUCTION_RESERVE_TOKENS,
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
            estimatedTokens: estimateContextTokens(`${item.filePath}\n${item.languageId}\n${item.content}`) + CONTEXT_ITEM_OVERHEAD_TOKENS,
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
    if (options.compactedSummary) {
        candidates.push({
            id: 'compacted-summary',
            priority: 'compacted-summary',
            estimatedTokens: estimateContextTokens(JSON.stringify(options.compactedSummary))
                + CONTEXT_ITEM_OVERHEAD_TOKENS,
            value: 'compacted-summary'
        });
    }
    if (options.toolHistory.length > 0) {
        candidates.push({
            id: 'tool-history-shells',
            priority: 'operation-state',
            estimatedTokens: options.toolHistory.reduce((total, step) => (total + estimateToolStepShellTokens(step)), 0),
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
            estimatedTokens: Math.max(0, estimateContextTokens(step.result) - estimateContextTokens(marker)),
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
        }
        else if (newerConversationTurnWasOmitted) {
            selectedIds.delete(id);
        }
    }
    const scopeItems = options.scope.items.filter((_item, index) => selectedIds.has(`scope:${index}`));
    const conversationHistory = options.conversationHistory.filter((_turn, index) => selectedIds.has(`conversation:${index}`));
    let compactedToolResults = 0;
    const toolHistory = options.toolHistory.map((step) => {
        if (selectedIds.has(`tool-result:${step.callId}`)) {
            return { ...step };
        }
        compactedToolResults += 1;
        return { ...step, result: omittedAgentToolResult(step.name) };
    });
    const usedTokens = candidates.reduce((total, candidate) => total + (selectedIds.has(candidate.id) ? candidate.estimatedTokens : 0), 0);
    const requestedTokens = candidates.reduce((total, candidate) => total + candidate.estimatedTokens, 0);
    return {
        budget,
        scope: { ...options.scope, items: scopeItems },
        conversationHistory,
        ...(options.compactedSummary && selectedIds.has('compacted-summary')
            ? { compactedSummary: options.compactedSummary }
            : {}),
        toolHistory,
        requestedTokens,
        usedTokens,
        remainingTokens: Math.max(0, budget.usableInputTokens - usedTokens),
        overflowTokens: Math.max(0, usedTokens - budget.usableInputTokens),
        omittedContextItems: options.scope.items.length - scopeItems.length,
        omittedConversationTurns: options.conversationHistory.length - conversationHistory.length,
        compactedToolResults
    };
}
function omittedAgentToolResult(toolName) {
    return `[Earlier ${toolName} result omitted to stay within the agent context budget.]`;
}
function estimateToolStepShellTokens(step) {
    const marker = omittedAgentToolResult(step.name);
    return estimateContextTokens(`${step.callId}\n${step.name}\n${JSON.stringify(step.arguments)}\n${marker}`) + TOOL_STEP_OVERHEAD_TOKENS;
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