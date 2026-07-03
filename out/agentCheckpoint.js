"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_AGENT_CHECKPOINT_AGE_MS = exports.AGENT_CHECKPOINT_STORAGE_KEY = void 0;
exports.parseAgentRunCheckpoint = parseAgentRunCheckpoint;
const agentTools_1 = require("./agentTools");
exports.AGENT_CHECKPOINT_STORAGE_KEY = 'devMate.agentCheckpoint.v1';
exports.MAX_AGENT_CHECKPOINT_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const toolNames = new Set(agentTools_1.AGENT_TOOL_NAMES);
function parseAgentRunCheckpoint(value, now = Date.now()) {
    if (!isRecord(value)
        || value.version !== 1
        || !boundedString(value.workspaceId, 2_048)
        || !boundedString(value.sessionId, 120)
        || !boundedString(value.question, 50_000)
        || !['ideas', 'code', 'debug'].includes(String(value.mode))
        || !['project', 'activeFile', 'selection'].includes(String(value.scopeKind))
        || !Array.isArray(value.toolHistory)
        || value.toolHistory.length > 100
        || !Array.isArray(value.toolUsedFiles)
        || value.toolUsedFiles.length > 100
        || !Array.isArray(value.toolSignatures)
        || value.toolSignatures.length > 100
        || !validCounter(value.fileMutationCalls, 6)
        || !validCounter(value.mutationCharacters, 500_000)
        || !validCounter(value.commandCalls, 3)
        || !validCounter(value.dependencyInstallCalls, 1)
        || !validCounter(value.workspaceRevision, 200)
        || typeof value.forceFinalAnswer !== 'boolean'
        || typeof value.disableThinking !== 'boolean'
        || typeof value.emptyResponseRecoveryAttempted !== 'boolean'
        || !validCounter(value.inputTokens, 200_000_000)
        || !validCounter(value.outputTokens, 200_000_000)
        || !validCounter(value.totalTokens, 400_000_000)
        || value.totalTokens < value.inputTokens + value.outputTokens
        || typeof value.tokenUsageExact !== 'boolean'
        || !validTimestamp(value.createdAt)
        || !validTimestamp(value.updatedAt)
        || value.updatedAt < value.createdAt
        || value.updatedAt > now + 60_000
        || now - value.updatedAt > exports.MAX_AGENT_CHECKPOINT_AGE_MS) {
        return undefined;
    }
    const toolHistory = parseToolHistory(value.toolHistory);
    const toolUsedFiles = value.toolUsedFiles.every((item) => boundedString(item, 2_048))
        ? [...new Set(value.toolUsedFiles)]
        : undefined;
    const toolSignatures = parseToolSignatures(value.toolSignatures);
    if (!toolHistory || !toolUsedFiles || !toolSignatures) {
        return undefined;
    }
    return {
        version: 1,
        workspaceId: value.workspaceId,
        sessionId: value.sessionId,
        question: value.question,
        mode: value.mode,
        scopeKind: value.scopeKind,
        toolHistory,
        toolUsedFiles,
        toolSignatures,
        fileMutationCalls: value.fileMutationCalls,
        mutationCharacters: value.mutationCharacters,
        commandCalls: value.commandCalls,
        dependencyInstallCalls: value.dependencyInstallCalls,
        workspaceRevision: value.workspaceRevision,
        forceFinalAnswer: value.forceFinalAnswer,
        disableThinking: value.disableThinking,
        emptyResponseRecoveryAttempted: value.emptyResponseRecoveryAttempted,
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        totalTokens: value.totalTokens,
        tokenUsageExact: value.tokenUsageExact,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt
    };
}
function parseToolHistory(value) {
    const parsed = [];
    const callIds = new Set();
    let resultCharacters = 0;
    for (const item of value) {
        if (!isRecord(item)
            || !boundedString(item.callId, 120)
            || callIds.has(item.callId)
            || !toolNames.has(item.name)
            || !isRecord(item.arguments)
            || JSON.stringify(item.arguments).length > 4_000
            || typeof item.result !== 'string'
            || item.result.length > 10_000
            || typeof item.isError !== 'boolean') {
            return undefined;
        }
        resultCharacters += item.result.length;
        if (resultCharacters > 80_000) {
            return undefined;
        }
        callIds.add(item.callId);
        parsed.push({
            callId: item.callId,
            name: item.name,
            arguments: item.arguments,
            result: item.result,
            isError: item.isError
        });
    }
    return parsed;
}
function parseToolSignatures(value) {
    const parsed = [];
    const signatures = new Set();
    for (const item of value) {
        if (!isRecord(item)
            || typeof item.signature !== 'string'
            || !/^[a-f0-9]{64}$/.test(item.signature)
            || signatures.has(item.signature)
            || !validCounter(item.revision, 200)
            || !validCounter(item.executions, 100)
            || item.executions < 1) {
            return undefined;
        }
        signatures.add(item.signature);
        parsed.push({
            signature: item.signature,
            revision: item.revision,
            executions: item.executions
        });
    }
    return parsed;
}
function boundedString(value, maximum) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}
function validCounter(value, maximum) {
    return typeof value === 'number'
        && Number.isInteger(value)
        && value >= 0
        && value <= maximum;
}
function validTimestamp(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=agentCheckpoint.js.map