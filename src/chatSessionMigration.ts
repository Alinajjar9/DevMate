import { createHash } from 'crypto';
import {
  deleteChatMemorySession,
  loadChatMemorySession,
  saveChatMemorySessions
} from './api/client';
import { parseChatMemorySnapshot } from './api/chatMemoryProtocol';
import type {
  ApiResult,
  ChatMemoryDeleteResponse,
  ChatMemoryLoadResponse,
  ChatMemorySaveRequest,
  ChatMemorySaveResponse,
  ChatMemorySessionRequest,
  ChatMemorySnapshot
} from './api/types';
import type { ConversationSessionStore } from './sessions';

export const CHAT_MEMORY_CAPABILITY = 'chat-memory-v1';
export const CHAT_SESSION_MIGRATION_STORAGE_KEY = 'devMate.chatMemoryMigration.v1';
export const CHAT_SESSION_MIGRATION_VERSION = 1;

export type ChatSessionMigrationAccess = {
  backendUrl: string;
  backendToken: string;
};

export type ChatSessionMigrationMarker = {
  version: typeof CHAT_SESSION_MIGRATION_VERSION;
  sourceFingerprint: string;
  sessionIds: string[];
  completedAtMs: number;
};

export type ChatSessionMigrationStateStore = {
  read(): unknown;
  write(marker: ChatSessionMigrationMarker): PromiseLike<void>;
};

export type ChatSessionMigrationSource = {
  read(): ConversationSessionStore;
};

export type ChatSessionMigrationApi = {
  save(
    access: ChatSessionMigrationAccess,
    request: ChatMemorySaveRequest,
    signal: AbortSignal
  ): Promise<ApiResult<ChatMemorySaveResponse>>;
  load(
    access: ChatSessionMigrationAccess,
    request: ChatMemorySessionRequest,
    signal: AbortSignal
  ): Promise<ApiResult<ChatMemoryLoadResponse>>;
  delete(
    access: ChatSessionMigrationAccess,
    request: ChatMemorySessionRequest,
    signal: AbortSignal
  ): Promise<ApiResult<ChatMemoryDeleteResponse>>;
};

export type ChatSessionMigrationResult =
  | { kind: 'completed'; migratedSessions: number }
  | { kind: 'skipped'; reason: 'unsupported-backend' | 'up-to-date' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

export const defaultChatSessionMigrationApi: ChatSessionMigrationApi = {
  save: (access, request, signal) => saveChatMemorySessions(
    access.backendUrl,
    request,
    access.backendToken,
    signal
  ),
  load: (access, request, signal) => loadChatMemorySession(
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

export class ChatSessionMigration {
  private activeOperation?: Promise<ChatSessionMigrationResult>;
  private activeController?: AbortController;
  private disposed = false;

  constructor(
    private readonly source: ChatSessionMigrationSource,
    private readonly stateStore: ChatSessionMigrationStateStore,
    private readonly api: ChatSessionMigrationApi = defaultChatSessionMigrationApi,
    private readonly report: (message: string) => void = () => undefined,
    private readonly now: () => number = Date.now
  ) {}

  synchronize(
    access: ChatSessionMigrationAccess,
    capabilities: readonly string[],
    externalSignal?: AbortSignal
  ): Promise<ChatSessionMigrationResult> {
    if (this.disposed || externalSignal?.aborted) {
      return Promise.resolve({ kind: 'cancelled' });
    }
    if (!capabilities.includes(CHAT_MEMORY_CAPABILITY)) {
      return Promise.resolve({ kind: 'skipped', reason: 'unsupported-backend' });
    }
    if (this.activeOperation) {
      return this.activeOperation;
    }

    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    externalSignal?.addEventListener('abort', cancel, { once: true });
    this.activeController = controller;
    const operation = this.run(access, controller.signal)
      .catch((error) => migrationFailure(
        error,
        'DevMate could not migrate saved chats to local storage.'
      ))
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

  dispose(): void {
    this.disposed = true;
    this.activeController?.abort();
  }

  private async run(
    access: ChatSessionMigrationAccess,
    signal: AbortSignal
  ): Promise<ChatSessionMigrationResult> {
    let snapshots: ChatMemorySnapshot[];
    let marker: ChatSessionMigrationMarker | undefined;
    try {
      snapshots = conversationStoreToChatMemorySnapshots(this.source.read());
      marker = parseChatSessionMigrationMarker(this.stateStore.read());
    } catch (error) {
      return migrationFailure(error, 'DevMate could not prepare saved chats for migration.');
    }
    if (signal.aborted) {
      return { kind: 'cancelled' };
    }

    const sourceFingerprint = fingerprintChatMemorySnapshots(snapshots);
    const sessionIds = snapshots.map((snapshot) => snapshot.session.sessionId);
    const sessionIdSet = new Set(sessionIds);
    const deletedSessionIds = marker?.sessionIds.filter((id) => !sessionIdSet.has(id)) ?? [];
    const markerMatches = marker?.sourceFingerprint === sourceFingerprint
      && arraysEqual(marker.sessionIds, sessionIds);

    if (snapshots.length === 0) {
      if (markerMatches) {
        return { kind: 'skipped', reason: 'up-to-date' };
      }
      const deletion = await this.deleteSessions(access, deletedSessionIds, signal);
      if (deletion.kind !== 'verified') {
        return deletion.kind === 'cancelled'
          ? { kind: 'cancelled' }
          : { kind: 'failed', message: deletion.message };
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
    const deletion = await this.deleteSessions(access, deletedSessionIds, signal);
    if (deletion.kind === 'cancelled') {
      return { kind: 'cancelled' };
    }
    if (deletion.kind === 'failed') {
      return { kind: 'failed', message: deletion.message };
    }
    return this.saveMarker(sourceFingerprint, sessionIds, signal, snapshots.length);
  }

  private async deleteSessions(
    access: ChatSessionMigrationAccess,
    sessionIds: string[],
    signal: AbortSignal
  ): Promise<
    | { kind: 'verified' }
    | { kind: 'cancelled' }
    | { kind: 'failed'; message: string }
  > {
    for (const sessionId of sessionIds) {
      const result = await this.api.delete(access, { sessionId }, signal);
      if (signal.aborted || result.errorKind === 'cancelled') {
        return { kind: 'cancelled' };
      }
      if (result.status !== 'ok') {
        return {
          kind: 'failed',
          message: result.message ?? 'DevMate could not reconcile a deleted saved chat.'
        };
      }
    }
    return { kind: 'verified' };
  }

  private async verifySnapshots(
    access: ChatSessionMigrationAccess,
    snapshots: ChatMemorySnapshot[],
    signal: AbortSignal
  ): Promise<
    | { kind: 'verified' }
    | { kind: 'cancelled' }
    | { kind: 'failed'; message: string }
  > {
    for (const expected of snapshots) {
      const result = await this.api.load(
        access,
        { sessionId: expected.session.sessionId },
        signal
      );
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

  private async saveMarker(
    sourceFingerprint: string,
    sessionIds: string[],
    signal: AbortSignal,
    migratedSessions: number
  ): Promise<ChatSessionMigrationResult> {
    if (signal.aborted) {
      return { kind: 'cancelled' };
    }
    try {
      await this.stateStore.write({
        version: CHAT_SESSION_MIGRATION_VERSION,
        sourceFingerprint,
        sessionIds: [...sessionIds],
        completedAtMs: this.now()
      });
    } catch (error) {
      return migrationFailure(error, 'DevMate could not record the completed chat migration.');
    }
    this.report(
      `[DevMate] Chat migration: verified ${migratedSessions} saved session`
      + `${migratedSessions === 1 ? '' : 's'} in local storage.`
    );
    return { kind: 'completed', migratedSessions };
  }
}

export function conversationStoreToChatMemorySnapshots(
  store: ConversationSessionStore
): ChatMemorySnapshot[] {
  return store.sessions.map((session) => {
    const candidate: ChatMemorySnapshot = {
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
    const parsed = parseChatMemorySnapshot(candidate);
    if (!parsed) {
      throw new Error(`Saved chat ${session.id} does not satisfy the chat-memory contract.`);
    }
    return parsed;
  });
}

export function fingerprintChatMemorySnapshots(snapshots: ChatMemorySnapshot[]): string {
  return createHash('sha256').update(JSON.stringify(snapshots)).digest('hex');
}

export function parseChatSessionMigrationMarker(
  value: unknown
): ChatSessionMigrationMarker | undefined {
  if (!isRecord(value)
    || Object.keys(value).length !== 4
    || !Object.keys(value).every((key) => [
      'version',
      'sourceFingerprint',
      'sessionIds',
      'completedAtMs'
    ].includes(key))
    || value.version !== CHAT_SESSION_MIGRATION_VERSION
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
    version: CHAT_SESSION_MIGRATION_VERSION,
    sourceFingerprint: value.sourceFingerprint,
    sessionIds: [...value.sessionIds],
    completedAtMs: value.completedAtMs
  };
}

function chatMemorySnapshotsEqual(
  expected: ChatMemorySnapshot,
  actual: ChatMemorySnapshot
): boolean {
  return JSON.stringify(expected) === JSON.stringify(actual);
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function migrationFailure(error: unknown, fallback: string): ChatSessionMigrationResult {
  return {
    kind: 'failed',
    message: error instanceof Error ? error.message : fallback
  };
}

function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
