import {
  deleteChatMemorySession,
  saveChatMemorySessions
} from './api/client';
import type {
  ApiResult,
  ChatMemoryDeleteResponse,
  ChatMemorySaveRequest,
  ChatMemorySaveResponse,
  ChatMemorySessionRequest,
  ChatMemorySnapshot
} from './api/types';
import {
  CHAT_MEMORY_CAPABILITY,
  conversationStoreToChatMemorySnapshots,
  fingerprintChatMemorySnapshots
} from './chatSessionMigration';
import type { ConversationSessionStore } from './sessions';

export type ChatSessionMirrorAccess = {
  backendUrl: string;
  backendToken: string;
  capabilities: readonly string[];
};

export type ChatSessionMirrorApi = {
  save(
    access: ChatSessionMirrorAccess,
    request: ChatMemorySaveRequest,
    signal: AbortSignal
  ): Promise<ApiResult<ChatMemorySaveResponse>>;
  delete(
    access: ChatSessionMirrorAccess,
    request: ChatMemorySessionRequest,
    signal: AbortSignal
  ): Promise<ApiResult<ChatMemoryDeleteResponse>>;
};

type PendingSnapshot = {
  snapshots: ChatMemorySnapshot[];
  fingerprint: string;
};

export const defaultChatSessionMirrorApi: ChatSessionMirrorApi = {
  save: (access, request, signal) => saveChatMemorySessions(
    access.backendUrl,
    request,
    access.backendToken,
    signal
  ),
  delete: (access, request, signal) => deleteChatMemorySession(
    access.backendUrl,
    request,
    access.backendToken,
    signal
  )
};

export class ChatSessionMirror {
  private backendAccess?: ChatSessionMirrorAccess;
  private pendingSnapshot?: PendingSnapshot;
  private readonly pendingDeletedSessionIds = new Set<string>();
  private readonly savedSessionFingerprints = new Map<string, string>();
  private lastSavedFingerprint?: string;
  private activeOperation?: Promise<void>;
  private activeController?: AbortController;
  private retryBlocked = false;
  private disposed = false;

  constructor(
    private readonly api: ChatSessionMirrorApi = defaultChatSessionMirrorApi,
    private readonly report: (message: string) => void = () => undefined
  ) {}

  setBackendAccess(access: ChatSessionMirrorAccess | undefined): void {
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

  mirror(store: ConversationSessionStore, deletedSessionId?: string): void {
    if (this.disposed) {
      return;
    }
    try {
      const snapshots = conversationStoreToChatMemorySnapshots(store);
      const fingerprint = fingerprintChatMemorySnapshots(snapshots);
      if (fingerprint !== this.lastSavedFingerprint) {
        this.pendingSnapshot = { snapshots, fingerprint };
      }
      if (deletedSessionId) {
        this.pendingDeletedSessionIds.add(deletedSessionId);
      }
      this.retryBlocked = false;
    } catch (error) {
      this.report(
        '[DevMate] Chat mirror: '
        + `${error instanceof Error ? error.message : 'could not prepare the saved chats.'}`
      );
      return;
    }
    this.startDrain();
  }

  async flush(): Promise<void> {
    this.startDrain();
    while (this.activeOperation) {
      const operation = this.activeOperation;
      await operation;
      if (this.activeOperation === operation) {
        break;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.activeController?.abort();
    this.backendAccess = undefined;
    this.pendingSnapshot = undefined;
    this.pendingDeletedSessionIds.clear();
    this.savedSessionFingerprints.clear();
  }

  private startDrain(): void {
    const access = this.backendAccess;
    if (this.disposed
      || this.activeOperation
      || this.retryBlocked
      || !access
      || !access.capabilities.includes(CHAT_MEMORY_CAPABILITY)
      || !this.hasPendingWork()) {
      return;
    }

    const controller = new AbortController();
    this.activeController = controller;
    const operation = this.drain(access, controller.signal)
      .catch((error) => {
        this.retryBlocked = true;
        this.report(
          '[DevMate] Chat mirror: '
          + `${error instanceof Error ? error.message : 'the local copy could not be updated.'}`
        );
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

  private async drain(access: ChatSessionMirrorAccess, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.hasPendingWork()) {
      const pendingSnapshot = this.pendingSnapshot;
      const deletedSessionIds = [...this.pendingDeletedSessionIds];
      this.pendingSnapshot = undefined;
      this.pendingDeletedSessionIds.clear();

      if (pendingSnapshot
        && pendingSnapshot.fingerprint !== this.lastSavedFingerprint
        && pendingSnapshot.snapshots.length > 0) {
        const changedSnapshots = pendingSnapshot.snapshots.filter((snapshot) => (
          this.savedSessionFingerprints.get(snapshot.session.sessionId)
            !== fingerprintChatMemorySnapshots([snapshot])
        ));
        if (changedSnapshots.length === 0) {
          this.lastSavedFingerprint = pendingSnapshot.fingerprint;
        } else {
          let result: ApiResult<ChatMemorySaveResponse>;
          try {
            result = await this.api.save(
              access,
              { sessions: changedSnapshots },
              signal
            );
          } catch (error) {
            this.blockOrContinueAfterFailure(pendingSnapshot, deletedSessionIds);
            this.report(
              '[DevMate] Chat mirror: '
              + `${error instanceof Error ? error.message : 'the local chat copy could not be saved.'}`
            );
            return;
          }
          if (signal.aborted || result.errorKind === 'cancelled') {
            this.restorePending(pendingSnapshot, deletedSessionIds);
            return;
          }
          if (result.status !== 'ok') {
            this.blockOrContinueAfterFailure(pendingSnapshot, deletedSessionIds);
            this.report(
              `[DevMate] Chat mirror: ${result.message ?? 'the local chat copy could not be saved.'}`
            );
            return;
          }
          for (const snapshot of changedSnapshots) {
            this.savedSessionFingerprints.set(
              snapshot.session.sessionId,
              fingerprintChatMemorySnapshots([snapshot])
            );
          }
          this.lastSavedFingerprint = pendingSnapshot.fingerprint;
        }
      } else if (pendingSnapshot?.snapshots.length === 0) {
        this.lastSavedFingerprint = pendingSnapshot.fingerprint;
      }

      for (let index = 0; index < deletedSessionIds.length; index += 1) {
        const sessionId = deletedSessionIds[index];
        let result: ApiResult<ChatMemoryDeleteResponse>;
        try {
          result = await this.api.delete(access, { sessionId }, signal);
        } catch (error) {
          this.blockOrContinueAfterFailure(
            undefined,
            deletedSessionIds.slice(index)
          );
          this.report(
            '[DevMate] Chat mirror: '
            + `${error instanceof Error ? error.message : 'a deleted chat could not be mirrored.'}`
          );
          return;
        }
        if (signal.aborted || result.errorKind === 'cancelled') {
          this.restoreDeletedSessionIds(deletedSessionIds.slice(index));
          return;
        }
        if (result.status !== 'ok') {
          this.blockOrContinueAfterFailure(
            undefined,
            deletedSessionIds.slice(index)
          );
          this.report(
            `[DevMate] Chat mirror: ${result.message ?? 'a deleted chat could not be mirrored.'}`
          );
          return;
        }
        this.savedSessionFingerprints.delete(sessionId);
      }
    }
  }

  private restorePending(
    pendingSnapshot: PendingSnapshot | undefined,
    deletedSessionIds: string[]
  ): void {
    if (this.disposed) {
      return;
    }
    if (pendingSnapshot && !this.pendingSnapshot) {
      this.pendingSnapshot = pendingSnapshot;
    }
    this.restoreDeletedSessionIds(deletedSessionIds);
  }

  private blockOrContinueAfterFailure(
    pendingSnapshot: PendingSnapshot | undefined,
    deletedSessionIds: string[]
  ): void {
    const receivedNewerWork = this.hasPendingWork();
    this.restorePending(pendingSnapshot, deletedSessionIds);
    this.retryBlocked = !receivedNewerWork;
  }

  private restoreDeletedSessionIds(sessionIds: string[]): void {
    if (this.disposed) {
      return;
    }
    for (const sessionId of sessionIds) {
      this.pendingDeletedSessionIds.add(sessionId);
    }
  }

  private hasPendingWork(): boolean {
    return Boolean(this.pendingSnapshot) || this.pendingDeletedSessionIds.size > 0;
  }
}

function sameAccess(
  left: ChatSessionMirrorAccess | undefined,
  right: ChatSessionMirrorAccess | undefined
): boolean {
  return left?.backendUrl === right?.backendUrl
    && left?.backendToken === right?.backendToken
    && left?.capabilities.includes(CHAT_MEMORY_CAPABILITY)
      === right?.capabilities.includes(CHAT_MEMORY_CAPABILITY);
}
