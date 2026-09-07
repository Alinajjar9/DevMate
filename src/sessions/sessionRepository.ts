// Translate chat sessions to the authenticated backend's storage contract.
// The controller depends on this interface, not on SQLite or HTTP details.

import {
  deleteChatMemorySession,
  listChatMemorySessions,
  loadChatMemorySession,
  saveChatMemorySessions
} from '../api/client';
import { parseChatMemorySnapshot } from '../api/chatMemoryProtocol';
import type {
  ApiResult,
  ChatMemoryDeleteResponse,
  ChatMemoryListRequest,
  ChatMemoryListResponse,
  ChatMemoryLoadResponse,
  ChatMemorySaveRequest,
  ChatMemorySaveResponse,
  ChatMemorySessionRequest,
  ChatMemorySnapshot
} from '../api/types';
import {
  MAX_CONVERSATION_SESSIONS,
  createEmptyConversationSessionStore,
  parseConversationSessionStore
} from './sessions';
import type {
  ConversationSession,
  ConversationSessionStore
} from './sessions';

export const CHAT_MEMORY_CAPABILITY = 'chat-memory-v1';

export type SessionRepositoryAccess = {
  backendUrl: string;
  backendToken: string;
  capabilities: readonly string[];
};

export type SessionRepositoryFailure =
  | { kind: 'unavailable'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

export type SessionRepositoryResult<T = undefined> =
  | { kind: 'completed'; value: T }
  | SessionRepositoryFailure;

export interface ConversationSessionRepository {
  loadWorkspace(
    workspaceIdentity: string,
    signal?: AbortSignal
  ): Promise<SessionRepositoryResult<ConversationSessionStore>>;
  saveSessions(
    sessions: ConversationSession[],
    signal?: AbortSignal
  ): Promise<SessionRepositoryResult>;
  deleteSession(
    sessionId: string,
    signal?: AbortSignal
  ): Promise<SessionRepositoryResult>;
}

export type SessionRepositoryApi = {
  list(
    access: SessionRepositoryAccess,
    request: ChatMemoryListRequest,
    signal: AbortSignal | undefined
  ): Promise<ApiResult<ChatMemoryListResponse>>;
  load(
    access: SessionRepositoryAccess,
    request: ChatMemorySessionRequest,
    signal: AbortSignal | undefined
  ): Promise<ApiResult<ChatMemoryLoadResponse>>;
  save(
    access: SessionRepositoryAccess,
    request: ChatMemorySaveRequest,
    signal: AbortSignal | undefined
  ): Promise<ApiResult<ChatMemorySaveResponse>>;
  delete(
    access: SessionRepositoryAccess,
    request: ChatMemorySessionRequest,
    signal: AbortSignal | undefined
  ): Promise<ApiResult<ChatMemoryDeleteResponse>>;
};

export const defaultSessionRepositoryApi: SessionRepositoryApi = {
  list: (access, request, signal) => listChatMemorySessions(
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

export class BackendSessionRepository implements ConversationSessionRepository {
  private backendAccess?: SessionRepositoryAccess;

  constructor(private readonly api: SessionRepositoryApi = defaultSessionRepositoryApi) {}

  setBackendAccess(access: SessionRepositoryAccess | undefined): void {
    this.backendAccess = access
      ? { ...access, capabilities: [...access.capabilities] }
      : undefined;
  }

  async loadWorkspace(
    workspaceIdentity: string,
    signal?: AbortSignal
  ): Promise<SessionRepositoryResult<ConversationSessionStore>> {
    const access = this.availableAccess();
    if (!access) {
      return unavailableResult();
    }
    if (signal?.aborted) {
      return { kind: 'cancelled' };
    }
    try {
      const listed = await this.api.list(access, {
        workspaceIdentity,
        limit: MAX_CONVERSATION_SESSIONS
      }, signal);
      const listFailure = apiFailure(listed);
      if (listFailure || !listed.data) {
        return listFailure ?? invalidResult('The local chat list was incomplete.');
      }

      const snapshots: ChatMemorySnapshot[] = [];
      for (const metadata of listed.data.sessions) {
        const loaded = await this.api.load(
          access,
          { sessionId: metadata.sessionId },
          signal
        );
        const loadFailure = apiFailure(loaded);
        if (loadFailure || !loaded.data) {
          return loadFailure ?? invalidResult('A local chat session was incomplete.');
        }
        if (loaded.data.session.session.workspaceIdentity !== workspaceIdentity) {
          return invalidResult('A local chat session belonged to a different workspace.');
        }
        snapshots.push(loaded.data.session);
      }
      return {
        kind: 'completed',
        value: chatMemorySnapshotsToConversationStore(snapshots)
      };
    } catch (error) {
      return failedResult(error, 'DevMate could not load chats from local storage.');
    }
  }

  async saveSessions(
    sessions: ConversationSession[],
    signal?: AbortSignal
  ): Promise<SessionRepositoryResult> {
    if (sessions.length === 0) {
      return { kind: 'completed', value: undefined };
    }
    const access = this.availableAccess();
    if (!access) {
      return unavailableResult();
    }
    if (signal?.aborted) {
      return { kind: 'cancelled' };
    }
    try {
      const snapshots = sessions.map(conversationSessionToChatMemorySnapshot);
      const result = await this.api.save(access, { sessions: snapshots }, signal);
      return apiFailure(result) ?? { kind: 'completed', value: undefined };
    } catch (error) {
      return failedResult(error, 'DevMate could not save chats to local storage.');
    }
  }

  async deleteSession(
    sessionId: string,
    signal?: AbortSignal
  ): Promise<SessionRepositoryResult> {
    const access = this.availableAccess();
    if (!access) {
      return unavailableResult();
    }
    if (signal?.aborted) {
      return { kind: 'cancelled' };
    }
    try {
      const result = await this.api.delete(access, { sessionId }, signal);
      return apiFailure(result) ?? { kind: 'completed', value: undefined };
    } catch (error) {
      return failedResult(error, 'DevMate could not delete the chat from local storage.');
    }
  }

  private availableAccess(): SessionRepositoryAccess | undefined {
    return this.backendAccess?.capabilities.includes(CHAT_MEMORY_CAPABILITY)
      ? this.backendAccess
      : undefined;
  }
}

export function conversationSessionToChatMemorySnapshot(
  session: ConversationSession
): ChatMemorySnapshot {
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
    throw new Error(`Chat session ${session.id} does not satisfy the storage contract.`);
  }
  return parsed;
}

export function chatMemorySnapshotsToConversationStore(
  snapshots: ChatMemorySnapshot[]
): ConversationSessionStore {
  if (snapshots.length === 0) {
    return createEmptyConversationSessionStore();
  }
  const candidate = {
    version: 2,
    activeSessionId: snapshots[0].session.sessionId,
    sessions: snapshots.map((snapshot) => ({
      id: snapshot.session.sessionId,
      title: snapshot.session.title,
      workspaceId: snapshot.session.workspaceIdentity,
      workspaceName: snapshot.session.workspaceName,
      createdAt: snapshot.session.createdAtMs,
      updatedAt: snapshot.session.updatedAtMs,
      turns: snapshot.turns.map((turn) => ({
        user: turn.user,
        assistant: turn.assistant,
        ...(turn.fileChanges.length > 0
          ? { fileChanges: turn.fileChanges.map((change) => ({ ...change })) }
          : {})
      }))
    }))
  };
  const parsed = parseConversationSessionStore(candidate);
  if (!parsed || parsed.sessions.length !== snapshots.length) {
    throw new Error('The local chat store returned invalid or duplicate sessions.');
  }
  return parsed;
}

function apiFailure<T>(result: ApiResult<T>): SessionRepositoryFailure | undefined {
  if (result.status === 'ok') {
    return undefined;
  }
  if (result.errorKind === 'cancelled') {
    return { kind: 'cancelled' };
  }
  return {
    kind: 'failed',
    message: result.message ?? 'The local chat storage request failed.'
  };
}

function unavailableResult(): SessionRepositoryFailure {
  return {
    kind: 'unavailable',
    message: 'The authenticated local chat store is not available.'
  };
}

function invalidResult(message: string): SessionRepositoryFailure {
  return { kind: 'failed', message };
}

function failedResult(error: unknown, fallback: string): SessionRepositoryFailure {
  return {
    kind: 'failed',
    message: error instanceof Error ? error.message : fallback
  };
}
