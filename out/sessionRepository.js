"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteSessionRepository = exports.defaultSessionRepositoryApi = exports.CHAT_MEMORY_CAPABILITY = void 0;
exports.conversationSessionToChatMemorySnapshot = conversationSessionToChatMemorySnapshot;
exports.chatMemorySnapshotsToConversationStore = chatMemorySnapshotsToConversationStore;
const client_1 = require("./api/client");
const chatMemoryProtocol_1 = require("./api/chatMemoryProtocol");
const sessions_1 = require("./sessions");
exports.CHAT_MEMORY_CAPABILITY = 'chat-memory-v1';
exports.defaultSessionRepositoryApi = {
    list: (access, request, signal) => (0, client_1.listChatMemorySessions)(access.backendUrl, request, access.backendToken, signal),
    load: (access, request, signal) => (0, client_1.loadChatMemorySession)(access.backendUrl, request, access.backendToken, signal),
    save: (access, request, signal) => (0, client_1.saveChatMemorySessions)(access.backendUrl, request, access.backendToken, signal),
    delete: (access, request, signal) => (0, client_1.deleteChatMemorySession)(access.backendUrl, request, access.backendToken, signal)
};
class SqliteSessionRepository {
    api;
    backendAccess;
    constructor(api = exports.defaultSessionRepositoryApi) {
        this.api = api;
    }
    setBackendAccess(access) {
        this.backendAccess = access
            ? { ...access, capabilities: [...access.capabilities] }
            : undefined;
    }
    async loadWorkspace(workspaceIdentity, signal) {
        const access = this.availableAccess();
        if (!access) {
            return unavailableResult();
        }
        if (signal?.aborted) {
            return { kind: 'cancelled' };
        }
        try {
            const listed = await this.api.list(access, {
                workspaceIdentity,
                limit: sessions_1.MAX_CONVERSATION_SESSIONS
            }, signal);
            const listFailure = apiFailure(listed);
            if (listFailure || !listed.data) {
                return listFailure ?? invalidResult('The local chat list was incomplete.');
            }
            const snapshots = [];
            for (const metadata of listed.data.sessions) {
                const loaded = await this.api.load(access, { sessionId: metadata.sessionId }, signal);
                const loadFailure = apiFailure(loaded);
                if (loadFailure || !loaded.data) {
                    return loadFailure ?? invalidResult('A local chat session was incomplete.');
                }
                if (loaded.data.session.session.workspaceIdentity !== workspaceIdentity) {
                    return invalidResult('A local chat session belonged to a different workspace.');
                }
                snapshots.push(loaded.data.session);
            }
            return {
                kind: 'completed',
                value: chatMemorySnapshotsToConversationStore(snapshots)
            };
        }
        catch (error) {
            return failedResult(error, 'DevMate could not load chats from local storage.');
        }
    }
    async saveSessions(sessions, signal) {
        if (sessions.length === 0) {
            return { kind: 'completed', value: undefined };
        }
        const access = this.availableAccess();
        if (!access) {
            return unavailableResult();
        }
        if (signal?.aborted) {
            return { kind: 'cancelled' };
        }
        try {
            const snapshots = sessions.map(conversationSessionToChatMemorySnapshot);
            const result = await this.api.save(access, { sessions: snapshots }, signal);
            return apiFailure(result) ?? { kind: 'completed', value: undefined };
        }
        catch (error) {
            return failedResult(error, 'DevMate could not save chats to local storage.');
        }
    }
    async deleteSession(sessionId, signal) {
        const access = this.availableAccess();
        if (!access) {
            return unavailableResult();
        }
        if (signal?.aborted) {
            return { kind: 'cancelled' };
        }
        try {
            const result = await this.api.delete(access, { sessionId }, signal);
            return apiFailure(result) ?? { kind: 'completed', value: undefined };
        }
        catch (error) {
            return failedResult(error, 'DevMate could not delete the chat from local storage.');
        }
    }
    availableAccess() {
        return this.backendAccess?.capabilities.includes(exports.CHAT_MEMORY_CAPABILITY)
            ? this.backendAccess
            : undefined;
    }
}
exports.SqliteSessionRepository = SqliteSessionRepository;
function conversationSessionToChatMemorySnapshot(session) {
    const candidate = {
        session: {
            sessionId: session.id,
            workspaceIdentity: session.workspaceId,
            workspaceName: session.workspaceName,
            title: session.title,
            createdAtMs: session.createdAt,
            updatedAtMs: session.updatedAt
        },
        turns: session.turns.map((turn, ordinal) => ({
            ordinal,
            user: turn.user,
            assistant: turn.assistant,
            fileChanges: (turn.fileChanges ?? []).map((change) => ({ ...change }))
        }))
    };
    const parsed = (0, chatMemoryProtocol_1.parseChatMemorySnapshot)(candidate);
    if (!parsed) {
        throw new Error(`Chat session ${session.id} does not satisfy the storage contract.`);
    }
    return parsed;
}
function chatMemorySnapshotsToConversationStore(snapshots) {
    if (snapshots.length === 0) {
        return (0, sessions_1.createEmptyConversationSessionStore)();
    }
    const candidate = {
        version: 2,
        activeSessionId: snapshots[0].session.sessionId,
        sessions: snapshots.map((snapshot) => ({
            id: snapshot.session.sessionId,
            title: snapshot.session.title,
            workspaceId: snapshot.session.workspaceIdentity,
            workspaceName: snapshot.session.workspaceName,
            createdAt: snapshot.session.createdAtMs,
            updatedAt: snapshot.session.updatedAtMs,
            turns: snapshot.turns.map((turn) => ({
                user: turn.user,
                assistant: turn.assistant,
                ...(turn.fileChanges.length > 0
                    ? { fileChanges: turn.fileChanges.map((change) => ({ ...change })) }
                    : {})
            }))
        }))
    };
    const parsed = (0, sessions_1.parseConversationSessionStore)(candidate);
    if (!parsed || parsed.sessions.length !== snapshots.length) {
        throw new Error('The local chat store returned invalid or duplicate sessions.');
    }
    return parsed;
}
function apiFailure(result) {
    if (result.status === 'ok') {
        return undefined;
    }
    if (result.errorKind === 'cancelled') {
        return { kind: 'cancelled' };
    }
    return {
        kind: 'failed',
        message: result.message ?? 'The local chat storage request failed.'
    };
}
function unavailableResult() {
    return {
        kind: 'unavailable',
        message: 'The authenticated local chat store is not available.'
    };
}
function invalidResult(message) {
    return { kind: 'failed', message };
}
function failedResult(error, fallback) {
    return {
        kind: 'failed',
        message: error instanceof Error ? error.message : fallback
    };
}
//# sourceMappingURL=sessionRepository.js.map