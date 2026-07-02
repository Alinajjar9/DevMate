"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_SESSION_TITLE_CHARACTERS = exports.MAX_SESSION_STORE_CHARACTERS = exports.MAX_SESSION_CHARACTERS = exports.MAX_SESSION_TURNS = exports.MAX_CONVERSATION_SESSIONS = exports.LEGACY_CONVERSATION_SESSIONS_STORAGE_KEY = exports.CONVERSATION_SESSIONS_STORAGE_KEY = void 0;
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
const conversation_1 = require("./conversation");
exports.CONVERSATION_SESSIONS_STORAGE_KEY = 'devMate.conversationSessions.v2';
exports.LEGACY_CONVERSATION_SESSIONS_STORAGE_KEY = 'devMate.conversationSessions.v1';
exports.MAX_CONVERSATION_SESSIONS = 20;
exports.MAX_SESSION_TURNS = 30;
exports.MAX_SESSION_CHARACTERS = 120_000;
exports.MAX_SESSION_STORE_CHARACTERS = 500_000;
exports.MAX_SESSION_TITLE_CHARACTERS = 80;
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
function appendConversationSessionTurn(store, user, assistant, now) {
    const turn = normalizeTurn({ user, assistant });
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
    return (0, conversation_1.boundConversationHistory)(activeConversationSession(store)?.turns ?? []);
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
        const turnCharacters = turn.user.length + turn.assistant.length;
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
    const assistant = value.assistant.trim().slice(0, conversation_1.MAX_CONVERSATION_TURN_CHARACTERS);
    return user ? { user, assistant } : undefined;
}
function normalizeUserMessage(value) {
    return value.trim().slice(0, conversation_1.MAX_CONVERSATION_TURN_CHARACTERS);
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
    return turns.reduce((total, turn) => total + turn.user.length + turn.assistant.length, 0);
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