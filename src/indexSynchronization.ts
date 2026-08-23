import { createHash } from 'crypto';
import {
  applyKnowledgeIndexChanges,
  openKnowledgeIndex,
  updateKnowledgeIndexMetadata
} from './api/client';
import {
  MAX_FILE_CHANGES_PER_BATCH,
  MAX_INDEX_BATCH_CONTENT_CHARACTERS
} from './api/types';
import type {
  ApiResult,
  KnowledgeIndexApplyRequest,
  KnowledgeIndexFileFingerprint,
  KnowledgeIndexFileInput,
  KnowledgeIndexMetadata,
  KnowledgeIndexOpenRequest,
  KnowledgeIndexOpenResponse,
  KnowledgeIndexWriteResponse
} from './api/types';
import {
  splitProjectContentWithSymbols
} from './projectSearch/projectChunking';
import type { ProjectSymbolRange } from './projectSearch/projectChunking';
import { containsBinaryData, splitProjectContent } from './projectSearch/projectIndex';

export const KNOWLEDGE_INDEX_CHUNKING_VERSION = 2;

export type KnowledgeIndexAccess = {
  backendUrl: string;
  backendToken: string;
};

export type WorkspaceIndexFileRead = {
  bytes: Uint8Array;
  sizeBytes: number;
  modifiedAt: number;
};

export type WorkspaceIndexSourceFile = {
  relativePath: string;
  languageId: string;
  read: (signal: AbortSignal) => Promise<WorkspaceIndexFileRead>;
  readSymbolRanges?: (
    expectedFile: WorkspaceIndexFileRead,
    signal: AbortSignal
  ) => Promise<ProjectSymbolRange[] | undefined>;
};

export type WorkspaceIndexSnapshot = {
  workspaceKey: string;
  rootPath: string;
  files: WorkspaceIndexSourceFile[];
  unavailablePaths: string[];
};

export interface WorkspaceIndexSource {
  scan(signal: AbortSignal): Promise<WorkspaceIndexSnapshot | undefined>;
}

export type KnowledgeIndexApi = {
  open: (
    access: KnowledgeIndexAccess,
    request: KnowledgeIndexOpenRequest,
    signal: AbortSignal
  ) => Promise<ApiResult<KnowledgeIndexOpenResponse>>;
  apply: (
    access: KnowledgeIndexAccess,
    request: KnowledgeIndexApplyRequest,
    signal: AbortSignal
  ) => Promise<ApiResult<KnowledgeIndexWriteResponse>>;
  updateMetadata: (
    access: KnowledgeIndexAccess,
    request: {
      workspaceKey: string;
      chunkingVersion: number;
      indexState: KnowledgeIndexMetadata['indexState'];
      lastFullScanAt: string | null;
    },
    signal: AbortSignal
  ) => Promise<ApiResult<KnowledgeIndexMetadata>>;
};

export type KnowledgeIndexSynchronizationResult =
  | {
    kind: 'completed';
    workspaceKey: string;
    indexState: 'ready' | 'stale';
    scannedFiles: number;
    indexedFiles: number;
    deletedFiles: number;
    unchangedFiles: number;
    unavailableFiles: number;
  }
  | { kind: 'skipped'; reason: 'no-local-workspace' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

export const defaultKnowledgeIndexApi: KnowledgeIndexApi = {
  open: (access, request, signal) => openKnowledgeIndex(
    access.backendUrl,
    request,
    access.backendToken,
    signal
  ),
  apply: (access, request, signal) => applyKnowledgeIndexChanges(
    access.backendUrl,
    request,
    access.backendToken,
    signal
  ),
  updateMetadata: (access, request, signal) => updateKnowledgeIndexMetadata(
    access.backendUrl,
    request,
    access.backendToken,
    signal
  )
};

export class KnowledgeIndexSynchronizer {
  private activeOperation?: Promise<KnowledgeIndexSynchronizationResult>;
  private activeController?: AbortController;
  private disposed = false;

  constructor(
    private readonly source: WorkspaceIndexSource,
    private readonly api: KnowledgeIndexApi = defaultKnowledgeIndexApi,
    private readonly report: (message: string) => void = () => undefined
  ) {}

  synchronize(
    access: KnowledgeIndexAccess,
    externalSignal?: AbortSignal
  ): Promise<KnowledgeIndexSynchronizationResult> {
    if (this.disposed) {
      return Promise.resolve({ kind: 'cancelled' });
    }
    if (this.activeOperation) {
      return this.activeOperation;
    }

    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    if (externalSignal?.aborted) {
      controller.abort();
    } else {
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

  dispose(): void {
    this.disposed = true;
    this.activeController?.abort();
  }

  private async run(
    access: KnowledgeIndexAccess,
    signal: AbortSignal
  ): Promise<KnowledgeIndexSynchronizationResult> {
    let snapshot: WorkspaceIndexSnapshot | undefined;
    let previousScanAt: string | null = null;
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

      const opened = requireApiData(
        await this.api.open(access, {
          workspaceKey: snapshot.workspaceKey,
          rootPath: snapshot.rootPath,
          chunkingVersion: KNOWLEDGE_INDEX_CHUNKING_VERSION
        }, signal),
        'open the workspace index'
      );
      workspaceOpened = true;
      previousScanAt = opened.metadata.lastFullScanAt;
      const rebuildAll = opened.metadata.chunkingVersion !== KNOWLEDGE_INDEX_CHUNKING_VERSION;

      requireApiData(
        await this.api.updateMetadata(access, {
          workspaceKey: snapshot.workspaceKey,
          chunkingVersion: KNOWLEDGE_INDEX_CHUNKING_VERSION,
          indexState: 'indexing',
          lastFullScanAt: previousScanAt
        }, signal),
        'mark the workspace index as active'
      );

      const storedFiles = new Map(
        opened.files.map((file) => [file.relativePath, file])
      );
      const currentPaths = new Set(snapshot.unavailablePaths);
      const unavailablePaths = new Set(snapshot.unavailablePaths);
      const writer = new KnowledgeIndexBatchWriter(
        access,
        snapshot.workspaceKey,
        this.api,
        signal
      );
      let unchangedFiles = 0;

      for (const file of [...snapshot.files].sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath)
      )) {
        assertNotCancelled(signal);
        if (currentPaths.has(file.relativePath)) {
          throw new Error(`The workspace scan returned the duplicate path ${file.relativePath}.`);
        }
        currentPaths.add(file.relativePath);

        let read: WorkspaceIndexFileRead;
        try {
          read = await file.read(signal);
          assertNotCancelled(signal);
        } catch (error) {
          if (isCancellation(error, signal)) {
            throw new IndexSynchronizationCancelled();
          }
          unavailablePaths.add(file.relativePath);
          continue;
        }

        if (containsBinaryData(read.bytes)) {
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
      requireApiData(
        await this.api.updateMetadata(access, {
          workspaceKey: snapshot.workspaceKey,
          chunkingVersion: KNOWLEDGE_INDEX_CHUNKING_VERSION,
          indexState,
          lastFullScanAt: indexState === 'ready'
            ? new Date().toISOString()
            : previousScanAt
        }, signal),
        'finish the workspace index'
      );

      const result: KnowledgeIndexSynchronizationResult = {
        kind: 'completed',
        workspaceKey: snapshot.workspaceKey,
        indexState,
        scannedFiles: snapshot.files.length,
        indexedFiles: writer.upsertedFiles,
        deletedFiles: writer.deletedFiles,
        unchangedFiles,
        unavailableFiles: unavailablePaths.size
      };
      this.report(
        `Finished with ${writer.upsertedFiles} indexed, ${writer.deletedFiles} deleted, `
        + `${unchangedFiles} unchanged, and ${unavailablePaths.size} unavailable.`
      );
      return result;
    } catch (error) {
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

  private async markFailed(
    access: KnowledgeIndexAccess,
    workspaceKey: string,
    previousScanAt: string | null,
    signal: AbortSignal
  ): Promise<void> {
    try {
      await this.api.updateMetadata(access, {
        workspaceKey,
        chunkingVersion: KNOWLEDGE_INDEX_CHUNKING_VERSION,
        indexState: 'failed',
        lastFullScanAt: previousScanAt
      }, signal);
    } catch {
      // The original synchronization failure remains the useful result.
    }
  }
}

export function knowledgeIndexWorkspaceKey(
  workspaceIdentity: string,
  platform: NodeJS.Platform = process.platform
): string {
  const normalizedIdentity = platform === 'win32'
    ? workspaceIdentity.toLocaleLowerCase('en-US')
    : workspaceIdentity;
  return `workspace:${sha256Hex(normalizedIdentity)}`;
}

async function createIndexedFile(
  file: WorkspaceIndexSourceFile,
  read: WorkspaceIndexFileRead,
  contentHash: string,
  signal: AbortSignal
): Promise<KnowledgeIndexFileInput> {
  const content = new TextDecoder('utf-8').decode(read.bytes);
  let symbolRanges: ProjectSymbolRange[] | undefined;
  if (file.readSymbolRanges) {
    try {
      symbolRanges = await file.readSymbolRanges(read, signal);
      assertNotCancelled(signal);
    } catch (error) {
      if (isCancellation(error, signal)) {
        throw new IndexSynchronizationCancelled();
      }
      // Language providers are optional. Invalid or unavailable symbols use the safe fallback.
    }
  }
  const projectChunks = symbolRanges
    ? splitProjectContentWithSymbols(content, file.relativePath, symbolRanges)
    : splitProjectContent(content, file.relativePath);
  const chunks = projectChunks.map((chunk, ordinal) => ({
    stableId: `${chunk.id}:${ordinal}`,
    ordinal,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content,
    contentHash: sha256Hex(chunk.content),
    chunkingVersion: KNOWLEDGE_INDEX_CHUNKING_VERSION
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

function fingerprintsMatch(
  stored: KnowledgeIndexFileFingerprint | undefined,
  contentHash: string,
  read: WorkspaceIndexFileRead
): boolean {
  return stored?.contentHash === contentHash
    && stored.sizeBytes === read.sizeBytes
    && stored.modifiedAt === read.modifiedAt;
}

class KnowledgeIndexBatchWriter {
  private upserts: KnowledgeIndexFileInput[] = [];
  private deletedPaths: string[] = [];
  private contentCharacters = 0;
  upsertedFiles = 0;
  deletedFiles = 0;

  constructor(
    private readonly access: KnowledgeIndexAccess,
    private readonly workspaceKey: string,
    private readonly api: KnowledgeIndexApi,
    private readonly signal: AbortSignal
  ) {}

  async addUpsert(file: KnowledgeIndexFileInput): Promise<void> {
    const contentCharacters = file.chunks.reduce(
      (total, chunk) => total + chunk.content.length,
      0
    );
    if (contentCharacters > MAX_INDEX_BATCH_CONTENT_CHARACTERS) {
      throw new Error(`The indexed file ${file.relativePath} exceeds the batch content limit.`);
    }
    if (this.shouldFlush(contentCharacters)) {
      await this.flush();
    }
    this.upserts.push(file);
    this.contentCharacters += contentCharacters;
  }

  async addDeletion(relativePath: string): Promise<void> {
    if (this.shouldFlush(0)) {
      await this.flush();
    }
    this.deletedPaths.push(relativePath);
  }

  async flush(): Promise<void> {
    if (this.upserts.length === 0 && this.deletedPaths.length === 0) {
      return;
    }
    assertNotCancelled(this.signal);
    const expectedUpserts = this.upserts.length;
    const expectedDeletions = this.deletedPaths.length;
    const result = requireApiData(
      await this.api.apply(this.access, {
        workspaceKey: this.workspaceKey,
        upserts: this.upserts,
        deletedPaths: this.deletedPaths
      }, this.signal),
      'apply workspace index changes'
    );
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

  private shouldFlush(nextContentCharacters: number): boolean {
    const fileChanges = this.upserts.length + this.deletedPaths.length;
    return fileChanges > 0 && (
      fileChanges + 1 > MAX_FILE_CHANGES_PER_BATCH
      || this.contentCharacters + nextContentCharacters
        > MAX_INDEX_BATCH_CONTENT_CHARACTERS
    );
  }
}

function requireApiData<T>(result: ApiResult<T>, operation: string): T {
  if (result.status === 'ok' && result.data !== undefined) {
    return result.data;
  }
  if (result.errorKind === 'cancelled') {
    throw new IndexSynchronizationCancelled();
  }
  throw new Error(result.message ?? `DevMate could not ${operation}.`);
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new IndexSynchronizationCancelled();
  }
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
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
