"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatSessionMirror = exports.defaultChatSessionMirrorApi = void 0;
const client_1 = require("./api/client");
const chatSessionMigration_1 = require("./chatSessionMigration");
exports.defaultChatSessionMirrorApi = {
    save: (access, request, signal) => (0, client_1.saveChatMemorySessions)(access.backendUrl, request, access.backendToken, signal),
    delete: (access, request, signal) => (0, client_1.deleteChatMemorySession)(access.backendUrl, request, access.backendToken, signal)
};
class ChatSessionMirror {
    api;
    report;
    backendAccess;
    pendingSnapshot;
    pendingDeletedSessionIds = new Set();
    savedSessionFingerprints = new Map();
    lastSavedFingerprint;
    activeOperation;
    activeController;
    retryBlocked = false;
    disposed = false;
    constructor(api = exports.defaultChatSessionMirrorApi, report = () => undefined) {
        this.api = api;
        this.report = report;
    }
    setBackendAccess(access) {
        const nextAccess = access
            ? { ...access, capabilities: [...access.capabilities] }
            : undefined;
        this.retryBlocked = false;
        if (sameAccess(this.backendAccess, nextAccess)) {
            this.startDrain();
            return;
        }
        this.backendAccess = nextAccess;
        this.activeController?.abort();
        this.startDrain();
    }
    mirror(store, deletedSessionId) {
        if (this.disposed) {
            return;
        }
        try {
            const snapshots = (0, chatSessionMigration_1.conversationStoreToChatMemorySnapshots)(store);
            const fingerprint = (0, chatSessionMigration_1.fingerprintChatMemorySnapshots)(snapshots);
            if (fingerprint !== this.lastSavedFingerprint) {
                this.pendingSnapshot = { snapshots, fingerprint };
            }
            if (deletedSessionId) {
                this.pendingDeletedSessionIds.add(deletedSessionId);
            }
            this.retryBlocked = false;
        }
        catch (error) {
            this.report('[DevMate] Chat mirror: '
                + `${error instanceof Error ? error.message : 'could not prepare the saved chats.'}`);
            return;
        }
        this.startDrain();
    }
    async flush() {
        this.startDrain();
        while (this.activeOperation) {
            const operation = this.activeOperation;
            await operation;
            if (this.activeOperation === operation) {
                break;
            }
        }
    }
    dispose() {
        this.disposed = true;
        this.activeController?.abort();
        this.backendAccess = undefined;
        this.pendingSnapshot = undefined;
        this.pendingDeletedSessionIds.clear();
        this.savedSessionFingerprints.clear();
    }
    startDrain() {
        const access = this.backendAccess;
        if (this.disposed
            || this.activeOperation
            || this.retryBlocked
            || !access
            || !access.capabilities.includes(chatSessionMigration_1.CHAT_MEMORY_CAPABILITY)
            || !this.hasPendingWork()) {
            return;
        }
        const controller = new AbortController();
        this.activeController = controller;
        const operation = this.drain(access, controller.signal)
            .catch((error) => {
            this.retryBlocked = true;
            this.report('[DevMate] Chat mirror: '
                + `${error instanceof Error ? error.message : 'the local copy could not be updated.'}`);
        })
            .finally(() => {
            if (this.activeOperation === operation) {
                this.activeOperation = undefined;
                this.activeController = undefined;
            }
            this.startDrain();
        });
        this.activeOperation = operation;
    }
    async drain(access, signal) {
        while (!signal.aborted && this.hasPendingWork()) {
            const pendingSnapshot = this.pendingSnapshot;
            const deletedSessionIds = [...this.pendingDeletedSessionIds];
            this.pendingSnapshot = undefined;
            this.pendingDeletedSessionIds.clear();
            if (pendingSnapshot
                && pendingSnapshot.fingerprint !== this.lastSavedFingerprint
                && pendingSnapshot.snapshots.length > 0) {
                const changedSnapshots = pendingSnapshot.snapshots.filter((snapshot) => (this.savedSessionFingerprints.get(snapshot.session.sessionId)
                    !== (0, chatSessionMigration_1.fingerprintChatMemorySnapshots)([snapshot])));
                if (changedSnapshots.length === 0) {
                    this.lastSavedFingerprint = pendingSnapshot.fingerprint;
                }
                else {
                    let result;
                    try {
                        result = await this.api.save(access, { sessions: changedSnapshots }, signal);
                    }
                    catch (error) {
                        this.blockOrContinueAfterFailure(pendingSnapshot, deletedSessionIds);
                        this.report('[DevMate] Chat mirror: '
                            + `${error instanceof Error ? error.message : 'the local chat copy could not be saved.'}`);
                        return;
                    }
                    if (signal.aborted || result.errorKind === 'cancelled') {
                        this.restorePending(pendingSnapshot, deletedSessionIds);
                        return;
                    }
                    if (result.status !== 'ok') {
                        this.blockOrContinueAfterFailure(pendingSnapshot, deletedSessionIds);
                        this.report(`[DevMate] Chat mirror: ${result.message ?? 'the local chat copy could not be saved.'}`);
                        return;
                    }
                    for (const snapshot of changedSnapshots) {
                        this.savedSessionFingerprints.set(snapshot.session.sessionId, (0, chatSessionMigration_1.fingerprintChatMemorySnapshots)([snapshot]));
                    }
                    this.lastSavedFingerprint = pendingSnapshot.fingerprint;
                }
            }
            else if (pendingSnapshot?.snapshots.length === 0) {
                this.lastSavedFingerprint = pendingSnapshot.fingerprint;
            }
            for (let index = 0; index < deletedSessionIds.length; index += 1) {
                const sessionId = deletedSessionIds[index];
                let result;
                try {
                    result = await this.api.delete(access, { sessionId }, signal);
                }
                catch (error) {
                    this.blockOrContinueAfterFailure(undefined, deletedSessionIds.slice(index));
                    this.report('[DevMate] Chat mirror: '
                        + `${error instanceof Error ? error.message : 'a deleted chat could not be mirrored.'}`);
                    return;
                }
                if (signal.aborted || result.errorKind === 'cancelled') {
                    this.restoreDeletedSessionIds(deletedSessionIds.slice(index));
                    return;
                }
                if (result.status !== 'ok') {
                    this.blockOrContinueAfterFailure(undefined, deletedSessionIds.slice(index));
                    this.report(`[DevMate] Chat mirror: ${result.message ?? 'a deleted chat could not be mirrored.'}`);
                    return;
                }
                this.savedSessionFingerprints.delete(sessionId);
            }
        }
    }
    restorePending(pendingSnapshot, deletedSessionIds) {
        if (this.disposed) {
            return;
        }
        if (pendingSnapshot && !this.pendingSnapshot) {
            this.pendingSnapshot = pendingSnapshot;
        }
        this.restoreDeletedSessionIds(deletedSessionIds);
    }
    blockOrContinueAfterFailure(pendingSnapshot, deletedSessionIds) {
        const receivedNewerWork = this.hasPendingWork();
        this.restorePending(pendingSnapshot, deletedSessionIds);
        this.retryBlocked = !receivedNewerWork;
    }
    restoreDeletedSessionIds(sessionIds) {
        if (this.disposed) {
            return;
        }
        for (const sessionId of sessionIds) {
            this.pendingDeletedSessionIds.add(sessionId);
        }
    }
    hasPendingWork() {
        return Boolean(this.pendingSnapshot) || this.pendingDeletedSessionIds.size > 0;
    }
}
exports.ChatSessionMirror = ChatSessionMirror;
function sameAccess(left, right) {
    return left?.backendUrl === right?.backendUrl
        && left?.backendToken === right?.backendToken
        && left?.capabilities.includes(chatSessionMigration_1.CHAT_MEMORY_CAPABILITY)
            === right?.capabilities.includes(chatSessionMigration_1.CHAT_MEMORY_CAPABILITY);
}
//# sourceMappingURL=chatSessionMirror.js.map