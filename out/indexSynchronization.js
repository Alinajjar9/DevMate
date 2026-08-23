"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KnowledgeIndexSynchronizer = exports.defaultKnowledgeIndexApi = exports.KNOWLEDGE_INDEX_CHUNKING_VERSION = void 0;
exports.knowledgeIndexWorkspaceKey = knowledgeIndexWorkspaceKey;
const crypto_1 = require("crypto");
const client_1 = require("./api/client");
const types_1 = require("./api/types");
const projectChunking_1 = require("./projectChunking");
const projectIndex_1 = require("./projectIndex");
exports.KNOWLEDGE_INDEX_CHUNKING_VERSION = 2;
exports.defaultKnowledgeIndexApi = {
    open: (access, request, signal) => (0, client_1.openKnowledgeIndex)(access.backendUrl, request, access.backendToken, signal),
    apply: (access, request, signal) => (0, client_1.applyKnowledgeIndexChanges)(access.backendUrl, request, access.backendToken, signal),
    updateMetadata: (access, request, signal) => (0, client_1.updateKnowledgeIndexMetadata)(access.backendUrl, request, access.backendToken, signal)
};
class KnowledgeIndexSynchronizer {
    source;
    api;
    report;
    activeOperation;
    activeController;
    disposed = false;
    constructor(source, api = exports.defaultKnowledgeIndexApi, report = () => undefined) {
        this.source = source;
        this.api = api;
        this.report = report;
    }
    synchronize(access, externalSignal) {
        if (this.disposed) {
            return Promise.resolve({ kind: 'cancelled' });
        }
        if (this.activeOperation) {
            return this.activeOperation;
        }
        const controller = new AbortController();
        const cancel = () => controller.abort();
        if (externalSignal?.aborted) {
            controller.abort();
        }
        else {
            externalSignal?.addEventListener('abort', cancel, { once: true });
        }
        this.activeController = controller;
        const operation = this.run(access, controller.signal).finally(() => {
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
        let snapshot;
        let previousScanAt = null;
        let workspaceOpened = false;
        try {
            assertNotCancelled(signal);
            this.report('Scanning the current workspace.');
            snapshot = await this.source.scan(signal);
            assertNotCancelled(signal);
            if (!snapshot) {
                this.report('Skipped because no local workspace is open.');
                return { kind: 'skipped', reason: 'no-local-workspace' };
            }
            const opened = requireApiData(await this.api.open(access, {
                workspaceKey: snapshot.workspaceKey,
                rootPath: snapshot.rootPath,
                chunkingVersion: exports.KNOWLEDGE_INDEX_CHUNKING_VERSION
            }, signal), 'open the workspace index');
            workspaceOpened = true;
            previousScanAt = opened.metadata.lastFullScanAt;
            const rebuildAll = opened.metadata.chunkingVersion !== exports.KNOWLEDGE_INDEX_CHUNKING_VERSION;
            requireApiData(await this.api.updateMetadata(access, {
                workspaceKey: snapshot.workspaceKey,
                chunkingVersion: exports.KNOWLEDGE_INDEX_CHUNKING_VERSION,
                indexState: 'indexing',
                lastFullScanAt: previousScanAt
            }, signal), 'mark the workspace index as active');
            const storedFiles = new Map(opened.files.map((file) => [file.relativePath, file]));
            const currentPaths = new Set(snapshot.unavailablePaths);
            const unavailablePaths = new Set(snapshot.unavailablePaths);
            const writer = new KnowledgeIndexBatchWriter(access, snapshot.workspaceKey, this.api, signal);
            let unchangedFiles = 0;
            for (const file of [...snapshot.files].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
                assertNotCancelled(signal);
                if (currentPaths.has(file.relativePath)) {
                    throw new Error(`The workspace scan returned the duplicate path ${file.relativePath}.`);
                }
                currentPaths.add(file.relativePath);
                let read;
                try {
                    read = await file.read(signal);
                    assertNotCancelled(signal);
                }
                catch (error) {
                    if (isCancellation(error, signal)) {
                        throw new IndexSynchronizationCancelled();
                    }
                    unavailablePaths.add(file.relativePath);
                    continue;
                }
                if ((0, projectIndex_1.containsBinaryData)(read.bytes)) {
                    currentPaths.delete(file.relativePath);
                    continue;
                }
                const contentHash = sha256Hex(read.bytes);
                const stored = storedFiles.get(file.relativePath);
                if (!rebuildAll && fingerprintsMatch(stored, contentHash, read)) {
                    unchangedFiles += 1;
                    continue;
                }
                await writer.addUpsert(await createIndexedFile(file, read, contentHash, signal));
            }
            for (const storedPath of [...storedFiles.keys()].sort()) {
                if (!currentPaths.has(storedPath)) {
                    await writer.addDeletion(storedPath);
                }
            }
            await writer.flush();
            assertNotCancelled(signal);
            const indexState = unavailablePaths.size > 0 ? 'stale' : 'ready';
            requireApiData(await this.api.updateMetadata(access, {
                workspaceKey: snapshot.workspaceKey,
                chunkingVersion: exports.KNOWLEDGE_INDEX_CHUNKING_VERSION,
                indexState,
                lastFullScanAt: indexState === 'ready'
                    ? new Date().toISOString()
                    : previousScanAt
            }, signal), 'finish the workspace index');
            const result = {
                kind: 'completed',
                workspaceKey: snapshot.workspaceKey,
                indexState,
                scannedFiles: snapshot.files.length,
                indexedFiles: writer.upsertedFiles,
                deletedFiles: writer.deletedFiles,
                unchangedFiles,
                unavailableFiles: unavailablePaths.size
            };
            this.report(`Finished with ${writer.upsertedFiles} indexed, ${writer.deletedFiles} deleted, `
                + `${unchangedFiles} unchanged, and ${unavailablePaths.size} unavailable.`);
            return result;
        }
        catch (error) {
            if (isCancellation(error, signal)) {
                this.report('Cancelled.');
                return { kind: 'cancelled' };
            }
            if (workspaceOpened && snapshot && !signal.aborted) {
                await this.markFailed(access, snapshot.workspaceKey, previousScanAt, signal);
            }
            const message = error instanceof Error
                ? error.message
                : 'The workspace index could not be synchronized.';
            this.report(`Failed: ${message}`);
            return { kind: 'failed', message };
        }
    }
    async markFailed(access, workspaceKey, previousScanAt, signal) {
        try {
            await this.api.updateMetadata(access, {
                workspaceKey,
                chunkingVersion: exports.KNOWLEDGE_INDEX_CHUNKING_VERSION,
                indexState: 'failed',
                lastFullScanAt: previousScanAt
            }, signal);
        }
        catch {
            // The original synchronization failure remains the useful result.
        }
    }
}
exports.KnowledgeIndexSynchronizer = KnowledgeIndexSynchronizer;
function knowledgeIndexWorkspaceKey(workspaceIdentity, platform = process.platform) {
    const normalizedIdentity = platform === 'win32'
        ? workspaceIdentity.toLocaleLowerCase('en-US')
        : workspaceIdentity;
    return `workspace:${sha256Hex(normalizedIdentity)}`;
}
async function createIndexedFile(file, read, contentHash, signal) {
    const content = new TextDecoder('utf-8').decode(read.bytes);
    let symbolRanges;
    if (file.readSymbolRanges) {
        try {
            symbolRanges = await file.readSymbolRanges(read, signal);
            assertNotCancelled(signal);
        }
        catch (error) {
            if (isCancellation(error, signal)) {
                throw new IndexSynchronizationCancelled();
            }
            // Language providers are optional. Invalid or unavailable symbols use the safe fallback.
        }
    }
    const projectChunks = symbolRanges
        ? (0, projectChunking_1.splitProjectContentWithSymbols)(content, file.relativePath, symbolRanges)
        : (0, projectIndex_1.splitProjectContent)(content, file.relativePath);
    const chunks = projectChunks.map((chunk, ordinal) => ({
        stableId: `${chunk.id}:${ordinal}`,
        ordinal,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        contentHash: sha256Hex(chunk.content),
        chunkingVersion: exports.KNOWLEDGE_INDEX_CHUNKING_VERSION
    }));
    return {
        relativePath: file.relativePath,
        languageId: file.languageId,
        contentHash,
        sizeBytes: read.sizeBytes,
        modifiedAt: read.modifiedAt,
        chunks
    };
}
function fingerprintsMatch(stored, contentHash, read) {
    return stored?.contentHash === contentHash
        && stored.sizeBytes === read.sizeBytes
        && stored.modifiedAt === read.modifiedAt;
}
class KnowledgeIndexBatchWriter {
    access;
    workspaceKey;
    api;
    signal;
    upserts = [];
    deletedPaths = [];
    contentCharacters = 0;
    upsertedFiles = 0;
    deletedFiles = 0;
    constructor(access, workspaceKey, api, signal) {
        this.access = access;
        this.workspaceKey = workspaceKey;
        this.api = api;
        this.signal = signal;
    }
    async addUpsert(file) {
        const contentCharacters = file.chunks.reduce((total, chunk) => total + chunk.content.length, 0);
        if (contentCharacters > types_1.MAX_INDEX_BATCH_CONTENT_CHARACTERS) {
            throw new Error(`The indexed file ${file.relativePath} exceeds the batch content limit.`);
        }
        if (this.shouldFlush(contentCharacters)) {
            await this.flush();
        }
        this.upserts.push(file);
        this.contentCharacters += contentCharacters;
    }
    async addDeletion(relativePath) {
        if (this.shouldFlush(0)) {
            await this.flush();
        }
        this.deletedPaths.push(relativePath);
    }
    async flush() {
        if (this.upserts.length === 0 && this.deletedPaths.length === 0) {
            return;
        }
        assertNotCancelled(this.signal);
        const expectedUpserts = this.upserts.length;
        const expectedDeletions = this.deletedPaths.length;
        const result = requireApiData(await this.api.apply(this.access, {
            workspaceKey: this.workspaceKey,
            upserts: this.upserts,
            deletedPaths: this.deletedPaths
        }, this.signal), 'apply workspace index changes');
        if (result.upsertedFiles !== expectedUpserts
            || result.deletedFiles !== expectedDeletions) {
            throw new Error('The workspace index did not confirm the complete file-change batch.');
        }
        this.upsertedFiles += result.upsertedFiles;
        this.deletedFiles += result.deletedFiles;
        this.upserts = [];
        this.deletedPaths = [];
        this.contentCharacters = 0;
    }
    shouldFlush(nextContentCharacters) {
        const fileChanges = this.upserts.length + this.deletedPaths.length;
        return fileChanges > 0 && (fileChanges + 1 > types_1.MAX_FILE_CHANGES_PER_BATCH
            || this.contentCharacters + nextContentCharacters
                > types_1.MAX_INDEX_BATCH_CONTENT_CHARACTERS);
    }
}
function requireApiData(result, operation) {
    if (result.status === 'ok' && result.data !== undefined) {
        return result.data;
    }
    if (result.errorKind === 'cancelled') {
        throw new IndexSynchronizationCancelled();
    }
    throw new Error(result.message ?? `DevMate could not ${operation}.`);
}
function sha256Hex(value) {
    return (0, crypto_1.createHash)('sha256').update(value).digest('hex');
}
function assertNotCancelled(signal) {
    if (signal.aborted) {
        throw new IndexSynchronizationCancelled();
    }
}
function isCancellation(error, signal) {
    return signal.aborted
        || error instanceof IndexSynchronizationCancelled
        || (error instanceof Error && error.name === 'AbortError');
}
class IndexSynchronizationCancelled extends Error {
    constructor() {
        super('The workspace index synchronization was cancelled.');
        this.name = 'AbortError';
    }
}
//# sourceMappingURL=indexSynchronization.js.map