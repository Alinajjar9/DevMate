import { EMBEDDING_PROVIDER_NAMES } from '../embeddingProfiles';
import {
  MAX_CHUNK_CHARACTERS,
  MAX_CHUNK_STABLE_ID_CHARACTERS,
  MAX_CONTENT_HASH_CHARACTERS,
  MAX_FILE_CHANGES_PER_BATCH,
  MAX_EMBEDDING_BATCH_SIZE,
  MAX_EMBEDDING_DIMENSIONS,
  MAX_EMBEDDING_INDEX_BATCHES_PER_RUN,
  MAX_EMBEDDING_MODEL_CHARACTERS,
  MAX_EMBEDDING_PROFILE_ID_CHARACTERS,
  MAX_INDEX_INTEGER,
  MAX_LANGUAGE_ID_CHARACTERS,
  MAX_LEXICAL_RESULTS,
  MAX_RELATIVE_PATH_CHARACTERS,
  MAX_WORKSPACE_KEY_CHARACTERS,
  MAX_WORKSPACE_ROOT_CHARACTERS
} from './types';
import type {
  KnowledgeIndexFileFingerprint,
  KnowledgeIndexEmbeddingConfiguration,
  KnowledgeIndexEmbeddingResponse,
  KnowledgeIndexMetadata,
  KnowledgeIndexOpenResponse,
  KnowledgeIndexSearchItem,
  KnowledgeIndexSearchResponse,
  KnowledgeIndexWriteResponse
} from './types';

const knowledgeIndexStates = new Set<string>([
  'empty',
  'indexing',
  'ready',
  'stale',
  'failed'
]);
const embeddingProviderNames = new Set<string>(EMBEDDING_PROVIDER_NAMES);
const embeddingProfileIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

export function parseKnowledgeIndexOpenResponse(
  value: unknown
): KnowledgeIndexOpenResponse | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['workspace', 'metadata', 'files'])
    || !isRecord(value.workspace)
    || !hasOnlyKeys(value.workspace, ['id', 'workspaceKey', 'rootPath'])
    || !isIndexInteger(value.workspace.id, 1)
    || !isIndexText(value.workspace.workspaceKey, MAX_WORKSPACE_KEY_CHARACTERS)
    || !isIndexText(value.workspace.rootPath, MAX_WORKSPACE_ROOT_CHARACTERS)
    || !Array.isArray(value.files)
    || value.files.length > MAX_FILE_CHANGES_PER_BATCH) {
    return undefined;
  }
  const metadata = parseKnowledgeIndexMetadata(value.metadata);
  if (!metadata || metadata.workspaceKey !== value.workspace.workspaceKey) {
    return undefined;
  }
  const files: KnowledgeIndexFileFingerprint[] = [];
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

export function parseKnowledgeIndexMetadata(value: unknown): KnowledgeIndexMetadata | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'workspaceKey',
      'chunkingVersion',
      'indexState',
      'lastFullScanAt'
    ])
    || !isIndexText(value.workspaceKey, MAX_WORKSPACE_KEY_CHARACTERS)
    || !isIndexInteger(value.chunkingVersion, 1)
    || typeof value.indexState !== 'string'
    || !knowledgeIndexStates.has(value.indexState)
    || !(value.lastFullScanAt === null || isIndexText(value.lastFullScanAt, 128))) {
    return undefined;
  }
  return {
    workspaceKey: value.workspaceKey,
    chunkingVersion: value.chunkingVersion,
    indexState: value.indexState as KnowledgeIndexMetadata['indexState'],
    lastFullScanAt: value.lastFullScanAt
  };
}

export function parseKnowledgeIndexWriteResponse(
  value: unknown
): KnowledgeIndexWriteResponse | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['upsertedFiles', 'deletedFiles'])
    || !isBoundedInteger(value.upsertedFiles, 0, MAX_FILE_CHANGES_PER_BATCH)
    || !isBoundedInteger(value.deletedFiles, 0, MAX_FILE_CHANGES_PER_BATCH)) {
    return undefined;
  }
  return {
    upsertedFiles: value.upsertedFiles,
    deletedFiles: value.deletedFiles
  };
}

export function parseKnowledgeIndexSearchResponse(
  value: unknown
): KnowledgeIndexSearchResponse | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['results'])
    || !Array.isArray(value.results)
    || value.results.length > MAX_LEXICAL_RESULTS) {
    return undefined;
  }
  const results: KnowledgeIndexSearchItem[] = [];
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

export function parseKnowledgeIndexEmbeddingResponse(
  value: unknown
): KnowledgeIndexEmbeddingResponse | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'configuration',
      'embeddedChunks',
      'processedBatches',
      'complete'
    ])
    || !isBoundedInteger(
      value.embeddedChunks,
      0,
      MAX_EMBEDDING_BATCH_SIZE * MAX_EMBEDDING_INDEX_BATCHES_PER_RUN
    )
    || !isBoundedInteger(
      value.processedBatches,
      0,
      MAX_EMBEDDING_INDEX_BATCHES_PER_RUN
    )
    || typeof value.complete !== 'boolean'
    || value.embeddedChunks > value.processedBatches * MAX_EMBEDDING_BATCH_SIZE
    || (value.processedBatches > 0 && value.embeddedChunks < value.processedBatches)
    || (value.processedBatches === 0 && !value.complete)) {
    return undefined;
  }
  const configuration = value.configuration === null
    ? null
    : parseKnowledgeIndexEmbeddingConfiguration(value.configuration);
  if (configuration === undefined
    || (configuration === null && (
      value.embeddedChunks !== 0
      || value.processedBatches !== 0
      || !value.complete
    ))) {
    return undefined;
  }
  return {
    configuration,
    embeddedChunks: value.embeddedChunks,
    processedBatches: value.processedBatches,
    complete: value.complete
  };
}

function parseKnowledgeIndexEmbeddingConfiguration(
  value: unknown
): KnowledgeIndexEmbeddingConfiguration | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'profileId',
      'provider',
      'model',
      'dimensions',
      'vectorVersion'
    ])
    || !isIndexText(value.profileId, MAX_EMBEDDING_PROFILE_ID_CHARACTERS)
    || !embeddingProfileIdPattern.test(value.profileId)
    || typeof value.provider !== 'string'
    || !embeddingProviderNames.has(value.provider)
    || !isIndexText(value.model, MAX_EMBEDDING_MODEL_CHARACTERS)
    || !isBoundedInteger(value.dimensions, 1, MAX_EMBEDDING_DIMENSIONS)
    || !isIndexInteger(value.vectorVersion, 1)) {
    return undefined;
  }
  return {
    profileId: value.profileId,
    provider: value.provider as KnowledgeIndexEmbeddingConfiguration['provider'],
    model: value.model,
    dimensions: value.dimensions,
    vectorVersion: value.vectorVersion
  };
}

function parseKnowledgeIndexFileFingerprint(
  value: unknown
): KnowledgeIndexFileFingerprint | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['relativePath', 'contentHash', 'sizeBytes', 'modifiedAt'])
    || !isIndexText(value.relativePath, MAX_RELATIVE_PATH_CHARACTERS)
    || !isIndexText(value.contentHash, MAX_CONTENT_HASH_CHARACTERS)
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

function parseKnowledgeIndexSearchItem(value: unknown): KnowledgeIndexSearchItem | undefined {
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
    || !isIndexText(value.relativePath, MAX_RELATIVE_PATH_CHARACTERS)
    || !isIndexText(value.languageId, MAX_LANGUAGE_ID_CHARACTERS)
    || !isIndexText(value.stableId, MAX_CHUNK_STABLE_ID_CHARACTERS)
    || !isIndexInteger(value.ordinal, 0)
    || !isIndexInteger(value.startLine, 1)
    || !isIndexInteger(value.endLine, value.startLine)
    || typeof value.content !== 'string'
    || value.content.length === 0
    || value.content.length > MAX_CHUNK_CHARACTERS
    || value.content.includes('\0')
    || !isIndexText(value.contentHash, MAX_CONTENT_HASH_CHARACTERS)
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

function isIndexInteger(value: unknown, minimum: number): value is number {
  return isBoundedInteger(value, minimum, MAX_INDEX_INTEGER);
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function isIndexText(value: unknown, maximum: number): value is string {
  return isBoundedNonEmptyString(value, maximum)
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isBoundedNonEmptyString(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
