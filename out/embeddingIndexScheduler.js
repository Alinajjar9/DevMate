"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmbeddingIndexScheduler = exports.DEFAULT_EMBEDDING_INDEX_CONTINUATION_MS = exports.DEFAULT_EMBEDDING_INDEX_BATCH_SIZE = exports.EMBEDDING_INDEX_VECTOR_VERSION = exports.EMBEDDING_INDEX_CAPABILITY = void 0;
const client_1 = require("./api/client");
const embeddingProfiles_1 = require("./embeddingProfiles");
exports.EMBEDDING_INDEX_CAPABILITY = 'embedding-index-v1';
exports.EMBEDDING_INDEX_VECTOR_VERSION = 1;
exports.DEFAULT_EMBEDDING_INDEX_BATCH_SIZE = 32;
exports.DEFAULT_EMBEDDING_INDEX_CONTINUATION_MS = 250;
const defaultEmbeddingIndexApi = {
    synchronize: (access, request, providerApiKey, signal) => ((0, client_1.synchronizeKnowledgeIndexEmbeddings)(access.backendUrl, request, {
        backendToken: access.backendToken,
        ...(providerApiKey !== undefined ? { providerApiKey } : {})
    }, undefined, signal))
};
const defaultTimer = {
    schedule: (callback, delayMilliseconds) => setTimeout(callback, delayMilliseconds),
    cancel: (handle) => clearTimeout(handle)
};
class EmbeddingIndexScheduler {
    profiles;
    api;
    report;
    continuationMilliseconds;
    timer;
    backendAccess;
    workspaceKey;
    activeController;
    continuationHandle;
    pending = false;
    pendingImmediately = false;
    disposed = false;
    constructor(profiles, api = defaultEmbeddingIndexApi, report = () => undefined, continuationMilliseconds = exports.DEFAULT_EMBEDDING_INDEX_CONTINUATION_MS, timer = defaultTimer) {
        this.profiles = profiles;
        this.api = api;
        this.report = report;
        this.continuationMilliseconds = continuationMilliseconds;
        this.timer = timer;
    }
    setBackendAccess(access) {
        if (this.disposed) {
            return;
        }
        if (!access) {
            this.backendAccess = undefined;
            this.invalidateWorkspace();
            return;
        }
        const nextAccess = {
            backendUrl: access.backendUrl,
            backendToken: access.backendToken,
            capabilities: [...access.capabilities]
        };
        if (!sameBackendAccess(this.backendAccess, nextAccess)) {
            this.invalidateWorkspace();
        }
        this.backendAccess = nextAccess;
    }
    scheduleWorkspace(workspaceKey) {
        if (this.disposed || !this.backendAccess) {
            return;
        }
        if (!this.backendAccess.capabilities.includes(exports.EMBEDDING_INDEX_CAPABILITY)) {
            this.report('Skipped because the backend does not support embedding indexing.');
            return;
        }
        if (!isValidWorkspaceKey(workspaceKey)) {
            this.report('Skipped because the workspace index identity is invalid.');
            return;
        }
        this.workspaceKey = workspaceKey;
        this.pending = true;
        this.pendingImmediately = true;
        this.clearContinuation();
        this.activeController?.abort();
        this.schedulePending();
    }
    invalidateWorkspace() {
        this.workspaceKey = undefined;
        this.pending = false;
        this.pendingImmediately = false;
        this.clearContinuation();
        this.activeController?.abort();
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.backendAccess = undefined;
        this.invalidateWorkspace();
    }
    schedulePending() {
        if (this.disposed
            || !this.backendAccess
            || !this.workspaceKey
            || !this.pending
            || this.activeController
            || this.continuationHandle !== undefined) {
            return;
        }
        if (this.pendingImmediately) {
            void this.runPending();
            return;
        }
        this.continuationHandle = this.timer.schedule(() => {
            this.continuationHandle = undefined;
            void this.runPending();
        }, Math.max(0, this.continuationMilliseconds));
    }
    async runPending() {
        if (this.disposed
            || !this.backendAccess
            || !this.workspaceKey
            || !this.pending
            || this.activeController) {
            return;
        }
        const access = copyBackendAccess(this.backendAccess);
        const workspaceKey = this.workspaceKey;
        const controller = new AbortController();
        this.pending = false;
        this.pendingImmediately = false;
        this.activeController = controller;
        try {
            const profile = (0, embeddingProfiles_1.preferredEmbeddingProfile)((0, embeddingProfiles_1.parseStoredEmbeddingProfiles)(this.profiles.readProfiles()), this.profiles.readActiveProfileId());
            if (!profile) {
                this.report('Skipped because no embedding profile is configured.');
                return;
            }
            const providerApiKey = await this.profiles.readSecret(profile.id);
            if (!this.isCurrent(access, workspaceKey, controller)) {
                return;
            }
            const result = await this.api.synchronize(access, {
                workspaceKey,
                profileId: profile.id,
                provider: profile.provider,
                model: profile.model,
                baseUrl: profile.baseUrl,
                remoteAllowed: profile.remoteAllowed,
                vectorVersion: exports.EMBEDDING_INDEX_VECTOR_VERSION,
                batchSize: exports.DEFAULT_EMBEDDING_INDEX_BATCH_SIZE,
                maxBatches: 1
            }, providerApiKey, controller.signal);
            if (!this.isCurrent(access, workspaceKey, controller)) {
                return;
            }
            if (result.status !== 'ok' || !result.data) {
                if (result.errorKind !== 'cancelled') {
                    this.report(`Failed: ${result.message ?? 'Embedding indexing failed.'}`);
                }
                return;
            }
            const embeddedChunks = result.data.embeddedChunks;
            if (result.data.complete) {
                this.report(embeddedChunks > 0
                    ? `Finished after storing ${embeddedChunks} code embeddings.`
                    : 'The embedding index is already complete.');
                return;
            }
            this.report(`Stored ${embeddedChunks} code embeddings; continuing.`);
            this.pending = true;
        }
        catch (error) {
            if (!controller.signal.aborted) {
                const message = error instanceof Error
                    ? error.message
                    : 'Embedding indexing failed.';
                this.report(`Failed: ${message}`);
            }
        }
        finally {
            if (this.activeController === controller) {
                this.activeController = undefined;
            }
            this.schedulePending();
        }
    }
    isCurrent(access, workspaceKey, controller) {
        return !this.disposed
            && !controller.signal.aborted
            && this.activeController === controller
            && this.workspaceKey === workspaceKey
            && sameBackendAccess(this.backendAccess, access);
    }
    clearContinuation() {
        if (this.continuationHandle === undefined) {
            return;
        }
        this.timer.cancel(this.continuationHandle);
        this.continuationHandle = undefined;
    }
}
exports.EmbeddingIndexScheduler = EmbeddingIndexScheduler;
function copyBackendAccess(access) {
    return {
        backendUrl: access.backendUrl,
        backendToken: access.backendToken,
        capabilities: [...access.capabilities]
    };
}
function sameBackendAccess(left, right) {
    if (!left) {
        return false;
    }
    return left.backendUrl === right.backendUrl
        && left.backendToken === right.backendToken
        && left.capabilities.includes(exports.EMBEDDING_INDEX_CAPABILITY)
            === right.capabilities.includes(exports.EMBEDDING_INDEX_CAPABILITY);
}
function isValidWorkspaceKey(value) {
    return value.length > 0 && value.length <= 256 && !value.includes('\0');
}
//# sourceMappingURL=embeddingIndexScheduler.js.map