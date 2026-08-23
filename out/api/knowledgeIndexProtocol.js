"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseKnowledgeIndexOpenResponse = parseKnowledgeIndexOpenResponse;
exports.parseKnowledgeIndexMetadata = parseKnowledgeIndexMetadata;
exports.parseKnowledgeIndexWriteResponse = parseKnowledgeIndexWriteResponse;
exports.parseKnowledgeIndexSearchResponse = parseKnowledgeIndexSearchResponse;
exports.parseKnowledgeIndexEmbeddingResponse = parseKnowledgeIndexEmbeddingResponse;
const embeddingProfiles_1 = require("../embeddingProfiles");
const types_1 = require("./types");
const knowledgeIndexStates = new Set([
    'empty',
    'indexing',
    'ready',
    'stale',
    'failed'
]);
const embeddingProviderNames = new Set(embeddingProfiles_1.EMBEDDING_PROVIDER_NAMES);
const embeddingProfileIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
function parseKnowledgeIndexOpenResponse(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['workspace', 'metadata', 'files'])
        || !isRecord(value.workspace)
        || !hasOnlyKeys(value.workspace, ['id', 'workspaceKey', 'rootPath'])
        || !isIndexInteger(value.workspace.id, 1)
        || !isIndexText(value.workspace.workspaceKey, types_1.MAX_WORKSPACE_KEY_CHARACTERS)
        || !isIndexText(value.workspace.rootPath, types_1.MAX_WORKSPACE_ROOT_CHARACTERS)
        || !Array.isArray(value.files)
        || value.files.length > types_1.MAX_FILE_CHANGES_PER_BATCH) {
        return undefined;
    }
    const metadata = parseKnowledgeIndexMetadata(value.metadata);
    if (!metadata || metadata.workspaceKey !== value.workspace.workspaceKey) {
        return undefined;
    }
    const files = [];
    for (const candidate of value.files) {
        const fingerprint = parseKnowledgeIndexFileFingerprint(candidate);
        if (!fingerprint) {
            return undefined;
        }
        files.push(fingerprint);
    }
    if (new Set(files.map((file) => file.relativePath)).size !== files.length) {
        return undefined;
    }
    return {
        workspace: {
            id: value.workspace.id,
            workspaceKey: value.workspace.workspaceKey,
            rootPath: value.workspace.rootPath
        },
        metadata,
        files
    };
}
function parseKnowledgeIndexMetadata(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, [
            'workspaceKey',
            'chunkingVersion',
            'indexState',
            'lastFullScanAt'
        ])
        || !isIndexText(value.workspaceKey, types_1.MAX_WORKSPACE_KEY_CHARACTERS)
        || !isIndexInteger(value.chunkingVersion, 1)
        || typeof value.indexState !== 'string'
        || !knowledgeIndexStates.has(value.indexState)
        || !(value.lastFullScanAt === null || isIndexText(value.lastFullScanAt, 128))) {
        return undefined;
    }
    return {
        workspaceKey: value.workspaceKey,
        chunkingVersion: value.chunkingVersion,
        indexState: value.indexState,
        lastFullScanAt: value.lastFullScanAt
    };
}
function parseKnowledgeIndexWriteResponse(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['upsertedFiles', 'deletedFiles'])
        || !isBoundedInteger(value.upsertedFiles, 0, types_1.MAX_FILE_CHANGES_PER_BATCH)
        || !isBoundedInteger(value.deletedFiles, 0, types_1.MAX_FILE_CHANGES_PER_BATCH)) {
        return undefined;
    }
    return {
        upsertedFiles: value.upsertedFiles,
        deletedFiles: value.deletedFiles
    };
}
function parseKnowledgeIndexSearchResponse(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['results'])
        || !Array.isArray(value.results)
        || value.results.length > types_1.MAX_LEXICAL_RESULTS) {
        return undefined;
    }
    const results = [];
    for (const candidate of value.results) {
        const result = parseKnowledgeIndexSearchItem(candidate);
        if (!result) {
            return undefined;
        }
        results.push(result);
    }
    const signatures = results.map((result) => `${result.relativePath}\0${result.stableId}`);
    if (new Set(signatures).size !== signatures.length) {
        return undefined;
    }
    return { results };
}
function parseKnowledgeIndexEmbeddingResponse(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, [
            'configuration',
            'embeddedChunks',
            'processedBatches',
            'complete'
        ])
        || !isBoundedInteger(value.embeddedChunks, 0, types_1.MAX_EMBEDDING_BATCH_SIZE * types_1.MAX_EMBEDDING_INDEX_BATCHES_PER_RUN)
        || !isBoundedInteger(value.processedBatches, 0, types_1.MAX_EMBEDDING_INDEX_BATCHES_PER_RUN)
        || typeof value.complete !== 'boolean'
        || value.embeddedChunks > value.processedBatches * types_1.MAX_EMBEDDING_BATCH_SIZE
        || (value.processedBatches > 0 && value.embeddedChunks < value.processedBatches)
        || (value.processedBatches === 0 && !value.complete)) {
        return undefined;
    }
    const configuration = value.configuration === null
        ? null
        : parseKnowledgeIndexEmbeddingConfiguration(value.configuration);
    if (configuration === undefined
        || (configuration === null && (value.embeddedChunks !== 0
            || value.processedBatches !== 0
            || !value.complete))) {
        return undefined;
    }
    return {
        configuration,
        embeddedChunks: value.embeddedChunks,
        processedBatches: value.processedBatches,
        complete: value.complete
    };
}
function parseKnowledgeIndexEmbeddingConfiguration(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, [
            'profileId',
            'provider',
            'model',
            'dimensions',
            'vectorVersion'
        ])
        || !isIndexText(value.profileId, types_1.MAX_EMBEDDING_PROFILE_ID_CHARACTERS)
        || !embeddingProfileIdPattern.test(value.profileId)
        || typeof value.provider !== 'string'
        || !embeddingProviderNames.has(value.provider)
        || !isIndexText(value.model, types_1.MAX_EMBEDDING_MODEL_CHARACTERS)
        || !isBoundedInteger(value.dimensions, 1, types_1.MAX_EMBEDDING_DIMENSIONS)
        || !isIndexInteger(value.vectorVersion, 1)) {
        return undefined;
    }
    return {
        profileId: value.profileId,
        provider: value.provider,
        model: value.model,
        dimensions: value.dimensions,
        vectorVersion: value.vectorVersion
    };
}
function parseKnowledgeIndexFileFingerprint(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['relativePath', 'contentHash', 'sizeBytes', 'modifiedAt'])
        || !isIndexText(value.relativePath, types_1.MAX_RELATIVE_PATH_CHARACTERS)
        || !isIndexText(value.contentHash, types_1.MAX_CONTENT_HASH_CHARACTERS)
        || !isIndexInteger(value.sizeBytes, 0)
        || !isIndexInteger(value.modifiedAt, 0)) {
        return undefined;
    }
    return {
        relativePath: value.relativePath,
        contentHash: value.contentHash,
        sizeBytes: value.sizeBytes,
        modifiedAt: value.modifiedAt
    };
}
function parseKnowledgeIndexSearchItem(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, [
            'relativePath',
            'languageId',
            'stableId',
            'ordinal',
            'startLine',
            'endLine',
            'content',
            'contentHash',
            'score'
        ])
        || !isIndexText(value.relativePath, types_1.MAX_RELATIVE_PATH_CHARACTERS)
        || !isIndexText(value.languageId, types_1.MAX_LANGUAGE_ID_CHARACTERS)
        || !isIndexText(value.stableId, types_1.MAX_CHUNK_STABLE_ID_CHARACTERS)
        || !isIndexInteger(value.ordinal, 0)
        || !isIndexInteger(value.startLine, 1)
        || !isIndexInteger(value.endLine, value.startLine)
        || typeof value.content !== 'string'
        || value.content.length === 0
        || value.content.length > types_1.MAX_CHUNK_CHARACTERS
        || value.content.includes('\0')
        || !isIndexText(value.contentHash, types_1.MAX_CONTENT_HASH_CHARACTERS)
        || typeof value.score !== 'number'
        || !Number.isFinite(value.score)
        || value.score < 0) {
        return undefined;
    }
    return {
        relativePath: value.relativePath,
        languageId: value.languageId,
        stableId: value.stableId,
        ordinal: value.ordinal,
        startLine: value.startLine,
        endLine: value.endLine,
        content: value.content,
        contentHash: value.contentHash,
        score: value.score
    };
}
function isIndexInteger(value, minimum) {
    return isBoundedInteger(value, minimum, types_1.MAX_INDEX_INTEGER);
}
function isBoundedInteger(value, minimum, maximum) {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= minimum
        && value <= maximum;
}
function isIndexText(value, maximum) {
    return isBoundedNonEmptyString(value, maximum)
        && !/[\u0000-\u001f\u007f]/.test(value);
}
function isBoundedNonEmptyString(value, maximum) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maximum;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value, keys) {
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
//# sourceMappingURL=knowledgeIndexProtocol.js.map