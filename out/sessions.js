"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_AGENT_CHECKPOINT_AGE_MS = exports.AGENT_CHECKPOINT_STORAGE_KEY = exports.MAX_CONVERSATION_HISTORY_CHARACTERS = exports.MAX_CONVERSATION_TURN_CHARACTERS = exports.MAX_CONVERSATION_TURNS = exports.MAX_SESSION_TITLE_CHARACTERS = exports.MAX_SESSION_STORE_CHARACTERS = exports.MAX_SESSION_CHARACTERS = exports.MAX_SESSION_TURNS = exports.MAX_CONVERSATION_SESSIONS = exports.LEGACY_CONVERSATION_SESSIONS_STORAGE_KEY = exports.CONVERSATION_SESSIONS_STORAGE_KEY = void 0;
exports.parseAgentRunCheckpoint = parseAgentRunCheckpoint;
exports.appendConversationTurn = appendConversationTurn;
exports.boundConversationHistory = boundConversationHistory;
exports.createEmptyConversationSessionStore = createEmptyConversationSessionStore;
exports.createConversationSessionStore = createConversationSessionStore;
exports.parseConversationSessionStore = parseConversationSessionStore;
exports.migrateLegacyConversationSessionStore = migrateLegacyConversationSessionStore;
exports.mergeConversationSessionStores = mergeConversationSessionStores;
exports.addConversationSession = addConversationSession;
exports.selectConversationSession = selectConversationSession;
exports.renameConversationSession = renameConversationSession;
exports.deleteConversationSession = deleteConversationSession;
exports.appendConversationSessionTurn = appendConversationSessionTurn;
exports.appendConversationSessionUserMessage = appendConversationSessionUserMessage;
exports.activeConversationSession = activeConversationSession;
exports.activeSessionModelHistory = activeSessionModelHistory;
exports.sessionBelongsToWorkspace = sessionBelongsToWorkspace;
exports.sessionTitleFromQuestion = sessionTitleFromQuestion;
const fileTools_1 = require("./fileTools");
const agentTools_1 = require("./agentTools");
exports.CONVERSATION_SESSIONS_STORAGE_KEY = 'devMate.conversationSessions.v2';
exports.LEGACY_CONVERSATION_SESSIONS_STORAGE_KEY = 'devMate.conversationSessions.v1';
exports.MAX_CONVERSATION_SESSIONS = 20;
exports.MAX_SESSION_TURNS = 30;
exports.MAX_SESSION_CHARACTERS = 120_000;
exports.MAX_SESSION_STORE_CHARACTERS = 500_000;
exports.MAX_SESSION_TITLE_CHARACTERS = 80;
exports.MAX_CONVERSATION_TURNS = 6;
exports.MAX_CONVERSATION_TURN_CHARACTERS = 6_000;
exports.MAX_CONVERSATION_HISTORY_CHARACTERS = 20_000;
exports.AGENT_CHECKPOINT_STORAGE_KEY = 'devMate.agentCheckpoint.v1';
exports.MAX_AGENT_CHECKPOINT_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
//merge from agentCheckpoint.ts
const toolNames = new Set(agentTools_1.AGENT_TOOL_NAMES);
function parseAgentRunCheckpoint(value, now = Date.now()) {
    if (!isRecordCP(value)
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
        if (!isRecordCP(item)
            || !boundedString(item.callId, 120)
            || callIds.has(item.callId)
            || !toolNames.has(item.name)
            || !isRecordCP(item.arguments)
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
        if (!isRecordCP(item)
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
function isRecordCP(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
// merge from conversation.ts
function appendConversationTurn(history, user, assistant) {
    const turn = {
        user: user.trim().slice(0, exports.MAX_CONVERSATION_TURN_CHARACTERS),
        assistant: assistant.trim().slice(0, exports.MAX_CONVERSATION_TURN_CHARACTERS)
    };
    if (!turn.user || !turn.assistant) {
        return boundConversationHistory(history);
    }
    return boundConversationHistory([...history, turn]);
}
function boundConversationHistory(history) {
    const bounded = [];
    let characters = 0;
    for (const candidate of history.slice(-exports.MAX_CONVERSATION_TURNS).reverse()) {
        if (!candidate || typeof candidate.user !== 'string' || typeof candidate.assistant !== 'string') {
            continue;
        }
        const turn = {
            user: candidate.user.trim().slice(0, exports.MAX_CONVERSATION_TURN_CHARACTERS),
            assistant: candidate.assistant.trim().slice(0, exports.MAX_CONVERSATION_TURN_CHARACTERS)
        };
        if (!turn.user || !turn.assistant) {
            continue;
        }
        const turnCharacters = turn.user.length + turn.assistant.length;
        if (characters + turnCharacters > exports.MAX_CONVERSATION_HISTORY_CHARACTERS) {
            continue;
        }
        bounded.push(turn);
        characters += turnCharacters;
    }
    return bounded.reverse();
}
// merge ends
function createEmptyConversationSessionStore() {
    return { version: 2, activeSessionId: '', sessions: [] };
}
function createConversationSessionStore(id, now, workspace) {
    const session = emptySession(id, now, workspace);
    return {
        version: 2,
        activeSessionId: session.id,
        sessions: [session]
    };
}
function parseConversationSessionStore(value) {
    if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.sessions)) {
        return undefined;
    }
    return parseSessions(value.sessions, value.activeSessionId);
}
function migrateLegacyConversationSessionStore(value, workspace) {
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions)) {
        return undefined;
    }
    const migrated = value.sessions.map((candidate) => isRecord(candidate)
        ? {
            ...candidate,
            workspaceId: workspace.id,
            workspaceName: workspace.name
        }
        : candidate);
    return parseSessions(migrated, value.activeSessionId);
}
function mergeConversationSessionStores(primary, imported) {
    const importedIds = new Set(imported.sessions.map((session) => session.id));
    return {
        version: 2,
        activeSessionId: imported.activeSessionId || primary.activeSessionId,
        sessions: boundStoreSessions([
            ...imported.sessions,
            ...primary.sessions.filter((session) => !importedIds.has(session.id))
        ].sort((left, right) => right.updatedAt - left.updatedAt))
    };
}
function addConversationSession(store, id, now, workspace) {
    const session = emptySession(id, now, workspace);
    return {
        version: 2,
        activeSessionId: session.id,
        sessions: boundStoreSessions([
            session,
            ...store.sessions.filter((item) => item.id !== session.id)
        ])
    };
}
function selectConversationSession(store, id) {
    if (!store.sessions.some((session) => session.id === id)) {
        return store;
    }
    return { ...store, activeSessionId: id };
}
function renameConversationSession(store, id, title) {
    const normalizedTitle = normalizeSessionTitle(title);
    if (!normalizedTitle) {
        return store;
    }
    return {
        ...store,
        sessions: store.sessions.map((session) => session.id === id
            ? { ...session, title: normalizedTitle }
            : session)
    };
}
function deleteConversationSession(store, id) {
    const remaining = store.sessions.filter((session) => session.id !== id);
    if (remaining.length === store.sessions.length) {
        return store;
    }
    return {
        version: 2,
        activeSessionId: store.activeSessionId === id ? (remaining[0]?.id ?? '') : store.activeSessionId,
        sessions: remaining
    };
}
function appendConversationSessionTurn(store, user, assistant, now, fileChanges = []) {
    const turn = normalizeTurn({ user, assistant, fileChanges });
    if (!turn || !turn.assistant || !activeConversationSession(store)) {
        return store;
    }
    const sessions = boundStoreSessions(store.sessions.map((session) => {
        if (session.id !== store.activeSessionId) {
            return session;
        }
        const pendingTurn = session.turns.at(-1);
        const turns = pendingTurn?.user === turn.user && !pendingTurn.assistant
            ? [...session.turns.slice(0, -1), turn]
            : [...session.turns, turn];
        return {
            ...session,
            title: session.turns.length === 0 ? sessionTitleFromQuestion(turn.user) : session.title,
            updatedAt: Math.max(session.updatedAt, now),
            turns: boundSessionTurns(turns)
        };
    }).sort((left, right) => right.updatedAt - left.updatedAt));
    return { ...store, sessions };
}
function appendConversationSessionUserMessage(store, user, now) {
    const normalizedUser = normalizeUserMessage(user);
    if (!normalizedUser || !activeConversationSession(store)) {
        return store;
    }
    // Save the question before the provider call so a failed request still remains in the session.
    const sessions = boundStoreSessions(store.sessions.map((session) => {
        if (session.id !== store.activeSessionId) {
            return session;
        }
        return {
            ...session,
            title: session.turns.length === 0
                ? sessionTitleFromQuestion(normalizedUser)
                : session.title,
            updatedAt: Math.max(session.updatedAt, now),
            turns: boundSessionTurns([
                ...session.turns,
                { user: normalizedUser, assistant: '' }
            ])
        };
    }).sort((left, right) => right.updatedAt - left.updatedAt));
    return { ...store, sessions };
}
function activeConversationSession(store) {
    return store.sessions.find((session) => session.id === store.activeSessionId);
}
function activeSessionModelHistory(store) {
    return boundConversationHistory((activeConversationSession(store)?.turns ?? []).map((turn) => ({
        user: turn.user,
        assistant: turn.assistant
    })));
}
function sessionBelongsToWorkspace(session, workspace) {
    return Boolean(workspace && session.workspaceId === workspace.id);
}
function sessionTitleFromQuestion(question) {
    const normalized = question.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return 'New session';
    }
    const sliced = normalized.slice(0, exports.MAX_SESSION_TITLE_CHARACTERS - 1);
    return sliced.length < normalized.length ? `${sliced.replace(/[\s.,;:!?-]+$/, '')}…` : sliced;
}
function parseSessions(value, requestedActiveId) {
    const seenIds = new Set();
    const candidates = [];
    for (const candidate of value) {
        if (!isRecord(candidate)
            || typeof candidate.id !== 'string'
            || !isSessionId(candidate.id)
            || seenIds.has(candidate.id)
            || typeof candidate.title !== 'string'
            || typeof candidate.workspaceId !== 'string'
            || !isWorkspaceId(candidate.workspaceId)
            || typeof candidate.workspaceName !== 'string'
            || typeof candidate.createdAt !== 'number'
            || !Number.isFinite(candidate.createdAt)
            || typeof candidate.updatedAt !== 'number'
            || !Number.isFinite(candidate.updatedAt)
            || candidate.createdAt < 0
            || candidate.updatedAt < candidate.createdAt
            || !Array.isArray(candidate.turns)) {
            continue;
        }
        seenIds.add(candidate.id);
        candidates.push({
            id: candidate.id,
            title: normalizeStoredSessionTitle(candidate.title),
            workspaceId: candidate.workspaceId,
            workspaceName: normalizeWorkspaceName(candidate.workspaceName),
            createdAt: candidate.createdAt,
            updatedAt: candidate.updatedAt,
            turns: boundSessionTurns(candidate.turns)
        });
    }
    candidates.sort((left, right) => right.updatedAt - left.updatedAt);
    const sessions = boundStoreSessions(candidates);
    if (sessions.length === 0) {
        return createEmptyConversationSessionStore();
    }
    const activeSessionId = typeof requestedActiveId === 'string'
        && sessions.some((session) => session.id === requestedActiveId)
        ? requestedActiveId
        : sessions[0].id;
    return { version: 2, activeSessionId, sessions };
}
function emptySession(id, now, workspace) {
    if (!isSessionId(id)) {
        throw new Error('Session ids must be non-empty UUID-like values.');
    }
    if (!isWorkspaceId(workspace.id)) {
        throw new Error('Sessions require a valid workspace identity.');
    }
    const timestamp = Number.isFinite(now) && now >= 0 ? now : Date.now();
    return {
        id,
        title: 'New session',
        workspaceId: workspace.id,
        workspaceName: normalizeWorkspaceName(workspace.name),
        createdAt: timestamp,
        updatedAt: timestamp,
        turns: []
    };
}
function boundStoreSessions(sessions) {
    let remaining = exports.MAX_SESSION_STORE_CHARACTERS;
    return sessions.slice(0, exports.MAX_CONVERSATION_SESSIONS).map((session) => {
        const turns = boundSessionTurns(session.turns, Math.min(exports.MAX_SESSION_CHARACTERS, Math.max(0, remaining)));
        remaining -= conversationCharacters(turns);
        return { ...session, turns };
    });
}
function boundSessionTurns(value, maximumCharacters = exports.MAX_SESSION_CHARACTERS) {
    const turns = [];
    let characters = 0;
    for (const candidate of value.slice(-exports.MAX_SESSION_TURNS).reverse()) {
        const turn = normalizeTurn(candidate);
        if (!turn) {
            continue;
        }
        const turnCharacters = turn.user.length + turn.assistant.length + fileChangeCharacters(turn.fileChanges);
        if (characters + turnCharacters > maximumCharacters) {
            continue;
        }
        turns.push(turn);
        characters += turnCharacters;
    }
    return turns.reverse();
}
function normalizeTurn(value) {
    if (!isRecord(value) || typeof value.user !== 'string' || typeof value.assistant !== 'string') {
        return undefined;
    }
    const user = normalizeUserMessage(value.user);
    const assistant = value.assistant.trim().slice(0, exports.MAX_CONVERSATION_TURN_CHARACTERS);
    const fileChanges = (0, fileTools_1.parseFileChangeSummary)(value.fileChanges);
    return user
        ? {
            user,
            assistant,
            ...(fileChanges.length > 0 ? { fileChanges } : {})
        }
        : undefined;
}
function normalizeUserMessage(value) {
    return value.trim().slice(0, exports.MAX_CONVERSATION_TURN_CHARACTERS);
}
function normalizeSessionTitle(value) {
    return value
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, exports.MAX_SESSION_TITLE_CHARACTERS);
}
function normalizeStoredSessionTitle(value) {
    const title = normalizeSessionTitle(value);
    return title.toLocaleLowerCase('en-US') === 'new conversation'
        ? 'New session'
        : title || 'New session';
}
function normalizeWorkspaceName(value) {
    return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
        || 'Unknown project';
}
function conversationCharacters(turns) {
    return turns.reduce((total, turn) => total + turn.user.length + turn.assistant.length
        + fileChangeCharacters(turn.fileChanges), 0);
}
function fileChangeCharacters(fileChanges) {
    return fileChanges?.reduce((total, change) => total + change.path.length + (change.previousPath?.length ?? 0) + 16, 0) ?? 0;
}
function isSessionId(value) {
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value);
}
function isWorkspaceId(value) {
    return value.length > 0
        && value.length <= 2_048
        && !/[\u0000-\u001f\u007f]/.test(value);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=sessions.js.map