import { synchronizeKnowledgeIndexEmbeddings } from './api/client';
import type {
  ApiResult,
  KnowledgeIndexEmbeddingRequest,
  KnowledgeIndexEmbeddingResponse
} from './api/types';
import { readPreferredEmbeddingProfile } from './embeddingProfiles';
import type { EmbeddingProfileReader } from './embeddingProfiles';

export const EMBEDDING_INDEX_CAPABILITY = 'embedding-index-v1';
export const EMBEDDING_INDEX_VECTOR_VERSION = 1;
export const DEFAULT_EMBEDDING_INDEX_BATCH_SIZE = 32;
export const DEFAULT_EMBEDDING_INDEX_CONTINUATION_MS = 250;

export type EmbeddingIndexBackendAccess = {
  backendUrl: string;
  backendToken: string;
  capabilities: readonly string[];
};

export type EmbeddingIndexProfileStore = EmbeddingProfileReader;

export type EmbeddingIndexApi = {
  synchronize: (
    access: EmbeddingIndexBackendAccess,
    request: KnowledgeIndexEmbeddingRequest,
    providerApiKey: string | undefined,
    signal: AbortSignal
  ) => Promise<ApiResult<KnowledgeIndexEmbeddingResponse>>;
};

export type EmbeddingIndexTimer = {
  schedule(callback: () => void, delayMilliseconds: number): unknown;
  cancel(handle: unknown): void;
};

const defaultEmbeddingIndexApi: EmbeddingIndexApi = {
  synchronize: (access, request, providerApiKey, signal) => (
    synchronizeKnowledgeIndexEmbeddings(
      access.backendUrl,
      request,
      {
        backendToken: access.backendToken,
        ...(providerApiKey !== undefined ? { providerApiKey } : {})
      },
      undefined,
      signal
    )
  )
};

const defaultTimer: EmbeddingIndexTimer = {
  schedule: (callback, delayMilliseconds) => setTimeout(callback, delayMilliseconds),
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout)
};

export class EmbeddingIndexScheduler {
  private backendAccess?: EmbeddingIndexBackendAccess;
  private workspaceKey?: string;
  private activeController?: AbortController;
  private continuationHandle?: unknown;
  private pending = false;
  private pendingImmediately = false;
  private disposed = false;

  constructor(
    private readonly profiles: EmbeddingIndexProfileStore,
    private readonly api: EmbeddingIndexApi = defaultEmbeddingIndexApi,
    private readonly report: (message: string) => void = () => undefined,
    private readonly continuationMilliseconds = DEFAULT_EMBEDDING_INDEX_CONTINUATION_MS,
    private readonly timer: EmbeddingIndexTimer = defaultTimer
  ) {}

  setBackendAccess(access: EmbeddingIndexBackendAccess | undefined): void {
    if (this.disposed) {
      return;
    }
    if (!access) {
      this.backendAccess = undefined;
      this.invalidateWorkspace();
      return;
    }

    const nextAccess: EmbeddingIndexBackendAccess = {
      backendUrl: access.backendUrl,
      backendToken: access.backendToken,
      capabilities: [...access.capabilities]
    };
    if (!sameBackendAccess(this.backendAccess, nextAccess)) {
      this.invalidateWorkspace();
    }
    this.backendAccess = nextAccess;
  }

  scheduleWorkspace(workspaceKey: string): void {
    if (this.disposed || !this.backendAccess) {
      return;
    }
    if (!this.backendAccess.capabilities.includes(EMBEDDING_INDEX_CAPABILITY)) {
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

  refreshActiveProfile(): void {
    if (this.workspaceKey) {
      this.scheduleWorkspace(this.workspaceKey);
    }
  }

  invalidateWorkspace(): void {
    this.workspaceKey = undefined;
    this.pending = false;
    this.pendingImmediately = false;
    this.clearContinuation();
    this.activeController?.abort();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.backendAccess = undefined;
    this.invalidateWorkspace();
  }

  private schedulePending(): void {
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

  private async runPending(): Promise<void> {
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
      const profile = await readPreferredEmbeddingProfile(this.profiles);
      if (!profile) {
        this.report('Skipped because no embedding profile is configured.');
        return;
      }

      if (!this.isCurrent(access, workspaceKey, controller)) {
        return;
      }
      const result = await this.api.synchronize(
        access,
        {
          workspaceKey,
          profileId: profile.id,
          provider: profile.provider,
          model: profile.model,
          baseUrl: profile.baseUrl,
          remoteAllowed: profile.remoteAllowed,
          vectorVersion: EMBEDDING_INDEX_VECTOR_VERSION,
          batchSize: DEFAULT_EMBEDDING_INDEX_BATCH_SIZE,
          maxBatches: 1
        },
        profile.apiKey,
        controller.signal
      );
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
        this.report(
          embeddedChunks > 0
            ? `Finished after storing ${embeddedChunks} code embeddings.`
            : 'The embedding index is already complete.'
        );
        return;
      }

      this.report(`Stored ${embeddedChunks} code embeddings; continuing.`);
      this.pending = true;
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error
          ? error.message
          : 'Embedding indexing failed.';
        this.report(`Failed: ${message}`);
      }
    } finally {
      if (this.activeController === controller) {
        this.activeController = undefined;
      }
      this.schedulePending();
    }
  }

  private isCurrent(
    access: EmbeddingIndexBackendAccess,
    workspaceKey: string,
    controller: AbortController
  ): boolean {
    return !this.disposed
      && !controller.signal.aborted
      && this.activeController === controller
      && this.workspaceKey === workspaceKey
      && sameBackendAccess(this.backendAccess, access);
  }

  private clearContinuation(): void {
    if (this.continuationHandle === undefined) {
      return;
    }
    this.timer.cancel(this.continuationHandle);
    this.continuationHandle = undefined;
  }
}

function copyBackendAccess(access: EmbeddingIndexBackendAccess): EmbeddingIndexBackendAccess {
  return {
    backendUrl: access.backendUrl,
    backendToken: access.backendToken,
    capabilities: [...access.capabilities]
  };
}

function sameBackendAccess(
  left: EmbeddingIndexBackendAccess | undefined,
  right: EmbeddingIndexBackendAccess
): boolean {
  if (!left) {
    return false;
  }
  return left.backendUrl === right.backendUrl
    && left.backendToken === right.backendToken
    && left.capabilities.includes(EMBEDDING_INDEX_CAPABILITY)
      === right.capabilities.includes(EMBEDDING_INDEX_CAPABILITY);
}

function isValidWorkspaceKey(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.includes('\0');
}
