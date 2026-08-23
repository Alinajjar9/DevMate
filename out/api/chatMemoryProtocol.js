"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseChatMemorySaveResponse = parseChatMemorySaveResponse;
exports.parseChatMemoryLoadResponse = parseChatMemoryLoadResponse;
exports.parseChatMemoryListResponse = parseChatMemoryListResponse;
exports.parseChatMemoryDeleteResponse = parseChatMemoryDeleteResponse;
exports.parseChatMemorySummarySaveResponse = parseChatMemorySummarySaveResponse;
exports.parseChatMemorySummaryLoadResponse = parseChatMemorySummaryLoadResponse;
exports.parseChatMemorySummaryClearResponse = parseChatMemorySummaryClearResponse;
exports.parseChatMemoryCompactionResponse = parseChatMemoryCompactionResponse;
exports.parseChatMemorySummary = parseChatMemorySummary;
exports.parseChatMemorySnapshot = parseChatMemorySnapshot;
exports.parseChatMemorySession = parseChatMemorySession;
const types_1 = require("./types");
const chatMemoryIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const fileChangeKinds = new Set([
    'created',
    'updated',
    'deleted',
    'renamed',
    'moved'
]);
function parseChatMemorySaveResponse(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['savedSessionIds'])
        || !Array.isArray(value.savedSessionIds)
        || value.savedSessionIds.length === 0
        || value.savedSessionIds.length > types_1.MAX_CHAT_SESSIONS_PER_REQUEST
        || !value.savedSessionIds.every(isChatMemoryIdentifier)
        || new Set(value.savedSessionIds).size !== value.savedSessionIds.length) {
        return undefined;
    }
    return { savedSessionIds: [...value.savedSessionIds] };
}
function parseChatMemoryLoadResponse(value) {
    if (!isRecord(value) || !hasOnlyKeys(value, ['session'])) {
        return undefined;
    }
    const session = parseChatMemorySnapshot(value.session);
    return session ? { session } : undefined;
}
function parseChatMemoryListResponse(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['sessions'])
        || !Array.isArray(value.sessions)
        || value.sessions.length > types_1.MAX_CHAT_SESSIONS_RETURNED) {
        return undefined;
    }
    const sessions = [];
    for (const candidate of value.sessions) {
        const session = parseChatMemorySession(candidate);
        if (!session) {
            return undefined;
        }
        sessions.push(session);
    }
    if (new Set(sessions.map((session) => session.sessionId)).size !== sessions.length
        || sessions.some((session, index) => (index > 0 && sessions[index - 1].updatedAtMs < session.updatedAtMs))) {
        return undefined;
    }
    return { sessions };
}
function parseChatMemoryDeleteResponse(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['deleted'])
        || typeof value.deleted !== 'boolean') {
        return undefined;
    }
    return { deleted: value.deleted };
}
function parseChatMemorySummarySaveResponse(value) {
    if (!isRecord(value) || !hasOnlyKeys(value, ['summary'])) {
        return undefined;
    }
    const summary = parseChatMemorySummary(value.summary);
    return summary ? { summary } : undefined;
}
function parseChatMemorySummaryLoadResponse(value) {
    if (!isRecord(value) || !hasOnlyKeys(value, ['summary'])) {
        return undefined;
    }
    if (value.summary === null) {
        return { summary: null };
    }
    const summary = parseChatMemorySummary(value.summary);
    return summary ? { summary } : undefined;
}
function parseChatMemorySummaryClearResponse(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['cleared'])
        || typeof value.cleared !== 'boolean') {
        return undefined;
    }
    return { cleared: value.cleared };
}
function parseChatMemoryCompactionResponse(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['summary', 'compactedTurns'])
        || !isChatInteger(value.compactedTurns, 1)
        || value.compactedTurns > types_1.MAX_CHAT_TURNS_PER_SNAPSHOT) {
        return undefined;
    }
    const summary = parseChatMemorySummary(value.summary);
    return summary
        ? { summary, compactedTurns: value.compactedTurns }
        : undefined;
}
function parseChatMemorySummary(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, [
            'sessionId',
            'summaryVersion',
            'content',
            'lastCompactedTurn',
            'createdAtMs',
            'updatedAtMs'
        ])
        || !isChatMemoryIdentifier(value.sessionId)
        || value.summaryVersion !== types_1.CHAT_SUMMARY_VERSION
        || !isChatInteger(value.lastCompactedTurn, 0)
        || !isChatInteger(value.createdAtMs, 0)
        || !isChatInteger(value.updatedAtMs, value.createdAtMs)) {
        return undefined;
    }
    const content = parseChatMemorySummaryContent(value.content);
    return content
        ? {
            sessionId: value.sessionId,
            summaryVersion: types_1.CHAT_SUMMARY_VERSION,
            content,
            lastCompactedTurn: value.lastCompactedTurn,
            createdAtMs: value.createdAtMs,
            updatedAtMs: value.updatedAtMs
        }
        : undefined;
}
function parseChatMemorySummaryContent(value) {
    const itemKeys = [
        'constraints',
        'importantFiles',
        'completedWork',
        'openTasks',
        'unresolvedQuestions'
    ];
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['goal', 'decisions', ...itemKeys])
        || !isSummaryText(value.goal)
        || !Array.isArray(value.decisions)
        || value.decisions.length > types_1.MAX_CHAT_SUMMARY_ITEMS) {
        return undefined;
    }
    const decisions = [];
    for (const candidate of value.decisions) {
        if (!isRecord(candidate)
            || !hasOnlyKeys(candidate, ['decision', 'reason'])
            || !isSummaryText(candidate.decision)
            || !isSummaryText(candidate.reason)) {
            return undefined;
        }
        decisions.push({ decision: candidate.decision, reason: candidate.reason });
    }
    const lists = {
        constraints: [],
        importantFiles: [],
        completedWork: [],
        openTasks: [],
        unresolvedQuestions: []
    };
    for (const key of itemKeys) {
        const items = value[key];
        if (!Array.isArray(items)
            || items.length > types_1.MAX_CHAT_SUMMARY_ITEMS
            || !items.every(isSummaryText)) {
            return undefined;
        }
        lists[key] = [...items];
    }
    const content = {
        goal: value.goal,
        constraints: lists.constraints,
        decisions,
        importantFiles: lists.importantFiles,
        completedWork: lists.completedWork,
        openTasks: lists.openTasks,
        unresolvedQuestions: lists.unresolvedQuestions
    };
    return JSON.stringify(content).length <= types_1.MAX_CHAT_SUMMARY_CHARACTERS
        ? content
        : undefined;
}
function parseChatMemorySnapshot(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['session', 'turns'])
        || !Array.isArray(value.turns)
        || value.turns.length > types_1.MAX_CHAT_TURNS_PER_SNAPSHOT) {
        return undefined;
    }
    const session = parseChatMemorySession(value.session);
    if (!session) {
        return undefined;
    }
    const turns = [];
    for (const candidate of value.turns) {
        const turn = parseChatMemoryTurn(candidate);
        if (!turn || turn.ordinal !== turns.length) {
            return undefined;
        }
        turns.push(turn);
    }
    return { session, turns };
}
function parseChatMemorySession(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, [
            'sessionId',
            'workspaceIdentity',
            'workspaceName',
            'title',
            'createdAtMs',
            'updatedAtMs'
        ])
        || !isChatMemoryIdentifier(value.sessionId)
        || !isIdentifierText(value.workspaceIdentity, types_1.MAX_CHAT_WORKSPACE_IDENTITY_CHARACTERS)
        || !isIdentifierText(value.workspaceName, types_1.MAX_CHAT_WORKSPACE_NAME_CHARACTERS)
        || !isIdentifierText(value.title, types_1.MAX_CHAT_SESSION_TITLE_CHARACTERS)
        || !isChatInteger(value.createdAtMs, 0)
        || !isChatInteger(value.updatedAtMs, value.createdAtMs)) {
        return undefined;
    }
    return {
        sessionId: value.sessionId,
        workspaceIdentity: value.workspaceIdentity,
        workspaceName: value.workspaceName,
        title: value.title,
        createdAtMs: value.createdAtMs,
        updatedAtMs: value.updatedAtMs
    };
}
function parseChatMemoryTurn(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['ordinal', 'user', 'assistant', 'fileChanges'])
        || !isChatInteger(value.ordinal, 0)
        || !isContentText(value.user, false)
        || !isContentText(value.assistant, true)
        || !Array.isArray(value.fileChanges)
        || value.fileChanges.length > types_1.MAX_CHAT_FILE_CHANGES) {
        return undefined;
    }
    const fileChanges = [];
    for (const candidate of value.fileChanges) {
        const change = parseChatMemoryFileChange(candidate);
        if (!change) {
            return undefined;
        }
        fileChanges.push(change);
    }
    return {
        ordinal: value.ordinal,
        user: value.user,
        assistant: value.assistant,
        fileChanges
    };
}
function parseChatMemoryFileChange(value) {
    if (!isRecord(value)
        || !hasOnlyOptionalKeys(value, ['kind', 'path'], ['previousPath', 'diffId'])
        || typeof value.kind !== 'string'
        || !fileChangeKinds.has(value.kind)
        || !isIdentifierText(value.path, types_1.MAX_CHAT_FILE_CHANGE_PATH_CHARACTERS)
        || !(value.previousPath === undefined
            || isIdentifierText(value.previousPath, types_1.MAX_CHAT_FILE_CHANGE_PATH_CHARACTERS))
        || !(value.diffId === undefined
            || typeof value.diffId === 'string'
                && value.diffId.length <= types_1.MAX_CHAT_DIFF_ID_CHARACTERS
                && chatMemoryIdentifierPattern.test(value.diffId))) {
        return undefined;
    }
    const relocated = value.kind === 'renamed' || value.kind === 'moved';
    if (relocated !== (value.previousPath !== undefined)) {
        return undefined;
    }
    return {
        kind: value.kind,
        path: value.path,
        ...(value.previousPath !== undefined ? { previousPath: value.previousPath } : {}),
        ...(value.diffId !== undefined ? { diffId: value.diffId } : {})
    };
}
function isChatMemoryIdentifier(value) {
    return typeof value === 'string'
        && value.length <= types_1.MAX_CHAT_SESSION_ID_CHARACTERS
        && chatMemoryIdentifierPattern.test(value);
}
function isIdentifierText(value, maximum) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maximum
        && value === value.trim()
        && !/[\u0000-\u001f\u007f]/.test(value);
}
function isContentText(value, allowEmpty) {
    return typeof value === 'string'
        && (allowEmpty || value.trim().length > 0)
        && value.length <= types_1.MAX_CHAT_TURN_CHARACTERS
        && !value.includes('\0');
}
function isSummaryText(value) {
    return typeof value === 'string'
        && value.trim().length > 0
        && value.length <= types_1.MAX_CHAT_SUMMARY_ITEM_CHARACTERS
        && !value.includes('\0');
}
function isChatInteger(value, minimum) {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= minimum
        && value <= types_1.MAX_CHAT_INTEGER;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value, keys) {
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
function hasOnlyOptionalKeys(value, required, optional) {
    const actual = Object.keys(value);
    return required.every((key) => actual.includes(key))
        && actual.every((key) => required.includes(key) || optional.includes(key));
}
//# sourceMappingURL=chatMemoryProtocol.js.map