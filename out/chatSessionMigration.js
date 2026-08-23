"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatSessionMigration = exports.defaultChatSessionMigrationApi = exports.CHAT_SESSION_MIGRATION_VERSION = exports.CHAT_SESSION_MIGRATION_STORAGE_KEY = exports.CHAT_MEMORY_CAPABILITY = void 0;
exports.conversationStoreToChatMemorySnapshots = conversationStoreToChatMemorySnapshots;
exports.fingerprintChatMemorySnapshots = fingerprintChatMemorySnapshots;
exports.parseChatSessionMigrationMarker = parseChatSessionMigrationMarker;
const crypto_1 = require("crypto");
const client_1 = require("./api/client");
const chatMemoryProtocol_1 = require("./api/chatMemoryProtocol");
exports.CHAT_MEMORY_CAPABILITY = 'chat-memory-v1';
exports.CHAT_SESSION_MIGRATION_STORAGE_KEY = 'devMate.chatMemoryMigration.v1';
exports.CHAT_SESSION_MIGRATION_VERSION = 1;
exports.defaultChatSessionMigrationApi = {
    save: (access, request, signal) => (0, client_1.saveChatMemorySessions)(access.backendUrl, request, access.backendToken, signal),
    load: (access, request, signal) => (0, client_1.loadChatMemorySession)(access.backendUrl, request, access.backendToken, signal)
};
class ChatSessionMigration {
    source;
    stateStore;
    api;
    report;
    now;
    activeOperation;
    activeController;
    disposed = false;
    constructor(source, stateStore, api = exports.defaultChatSessionMigrationApi, report = () => undefined, now = Date.now) {
        this.source = source;
        this.stateStore = stateStore;
        this.api = api;
        this.report = report;
        this.now = now;
    }
    synchronize(access, capabilities, externalSignal) {
        if (this.disposed || externalSignal?.aborted) {
            return Promise.resolve({ kind: 'cancelled' });
        }
        if (!capabilities.includes(exports.CHAT_MEMORY_CAPABILITY)) {
            return Promise.resolve({ kind: 'skipped', reason: 'unsupported-backend' });
        }
        if (this.activeOperation) {
            return this.activeOperation;
        }
        const controller = new AbortController();
        const cancel = () => controller.abort();
        externalSignal?.addEventListener('abort', cancel, { once: true });
        this.activeController = controller;
        const operation = this.run(access, controller.signal)
            .catch((error) => migrationFailure(error, 'DevMate could not migrate saved chats to local storage.'))
            .finally(() => {
            externalSignal?.removeEventListener('abort', cancel);
            if (this.activeOperation === operation) {
                this.activeOperation = undefined;
                this.activeController = undefined;
            }
        });
        this.activeOperation = operation;
        return operation;
    }
    dispose() {
        this.disposed = true;
        this.activeController?.abort();
    }
    async run(access, signal) {
        let snapshots;
        let marker;
        try {
            snapshots = conversationStoreToChatMemorySnapshots(this.source.read());
            marker = parseChatSessionMigrationMarker(this.stateStore.read());
        }
        catch (error) {
            return migrationFailure(error, 'DevMate could not prepare saved chats for migration.');
        }
        if (signal.aborted) {
            return { kind: 'cancelled' };
        }
        const sourceFingerprint = fingerprintChatMemorySnapshots(snapshots);
        const sessionIds = snapshots.map((snapshot) => snapshot.session.sessionId);
        const markerMatches = marker?.sourceFingerprint === sourceFingerprint
            && arraysEqual(marker.sessionIds, sessionIds);
        if (snapshots.length === 0) {
            if (markerMatches) {
                return { kind: 'skipped', reason: 'up-to-date' };
            }
            return this.saveMarker(sourceFingerprint, sessionIds, signal, 0);
        }
        if (markerMatches) {
            const verification = await this.verifySnapshots(access, snapshots, signal);
            if (verification.kind === 'verified') {
                return { kind: 'skipped', reason: 'up-to-date' };
            }
            if (verification.kind === 'cancelled') {
                return { kind: 'cancelled' };
            }
            this.report('[DevMate] Chat migration: the saved copy needs to be refreshed.');
        }
        const saveResult = await this.api.save(access, { sessions: snapshots }, signal);
        if (signal.aborted || saveResult.errorKind === 'cancelled') {
            return { kind: 'cancelled' };
        }
        if (saveResult.status !== 'ok') {
            return {
                kind: 'failed',
                message: saveResult.message ?? 'DevMate could not copy saved chats to local storage.'
            };
        }
        const verification = await this.verifySnapshots(access, snapshots, signal);
        if (verification.kind === 'cancelled') {
            return { kind: 'cancelled' };
        }
        if (verification.kind === 'failed') {
            return {
                kind: 'failed',
                message: verification.message
            };
        }
        return this.saveMarker(sourceFingerprint, sessionIds, signal, snapshots.length);
    }
    async verifySnapshots(access, snapshots, signal) {
        for (const expected of snapshots) {
            const result = await this.api.load(access, { sessionId: expected.session.sessionId }, signal);
            if (signal.aborted || result.errorKind === 'cancelled') {
                return { kind: 'cancelled' };
            }
            if (result.status !== 'ok' || !result.data) {
                return {
                    kind: 'failed',
                    message: result.message ?? 'DevMate could not verify the migrated chat copy.'
                };
            }
            if (!chatMemorySnapshotsEqual(expected, result.data.session)) {
                return {
                    kind: 'failed',
                    message: 'DevMate rejected an incomplete chat migration copy.'
                };
            }
        }
        return { kind: 'verified' };
    }
    async saveMarker(sourceFingerprint, sessionIds, signal, migratedSessions) {
        if (signal.aborted) {
            return { kind: 'cancelled' };
        }
        try {
            await this.stateStore.write({
                version: exports.CHAT_SESSION_MIGRATION_VERSION,
                sourceFingerprint,
                sessionIds: [...sessionIds],
                completedAtMs: this.now()
            });
        }
        catch (error) {
            return migrationFailure(error, 'DevMate could not record the completed chat migration.');
        }
        this.report(`[DevMate] Chat migration: verified ${migratedSessions} saved session`
            + `${migratedSessions === 1 ? '' : 's'} in local storage.`);
        return { kind: 'completed', migratedSessions };
    }
}
exports.ChatSessionMigration = ChatSessionMigration;
function conversationStoreToChatMemorySnapshots(store) {
    return store.sessions.map((session) => {
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
            throw new Error(`Saved chat ${session.id} does not satisfy the chat-memory contract.`);
        }
        return parsed;
    });
}
function fingerprintChatMemorySnapshots(snapshots) {
    return (0, crypto_1.createHash)('sha256').update(JSON.stringify(snapshots)).digest('hex');
}
function parseChatSessionMigrationMarker(value) {
    if (!isRecord(value)
        || Object.keys(value).length !== 4
        || !Object.keys(value).every((key) => [
            'version',
            'sourceFingerprint',
            'sessionIds',
            'completedAtMs'
        ].includes(key))
        || value.version !== exports.CHAT_SESSION_MIGRATION_VERSION
        || typeof value.sourceFingerprint !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint)
        || !Array.isArray(value.sessionIds)
        || value.sessionIds.length > 20
        || !value.sessionIds.every(isSessionId)
        || new Set(value.sessionIds).size !== value.sessionIds.length
        || typeof value.completedAtMs !== 'number'
        || !Number.isSafeInteger(value.completedAtMs)
        || value.completedAtMs < 0) {
        return undefined;
    }
    return {
        version: exports.CHAT_SESSION_MIGRATION_VERSION,
        sourceFingerprint: value.sourceFingerprint,
        sessionIds: [...value.sessionIds],
        completedAtMs: value.completedAtMs
    };
}
function chatMemorySnapshotsEqual(expected, actual) {
    return JSON.stringify(expected) === JSON.stringify(actual);
}
function arraysEqual(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function migrationFailure(error, fallback) {
    return {
        kind: 'failed',
        message: error instanceof Error ? error.message : fallback
    };
}
function isSessionId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=chatSessionMigration.js.map