import type { ConversationTurn } from './api/types';
import { boundConversationHistory, MAX_CONVERSATION_TURN_CHARACTERS } from './conversation';

export const CONVERSATION_SESSIONS_STORAGE_KEY = 'devMate.conversationSessions.v2';
export const LEGACY_CONVERSATION_SESSIONS_STORAGE_KEY = 'devMate.conversationSessions.v1';
export const MAX_CONVERSATION_SESSIONS = 20;
export const MAX_SESSION_TURNS = 30;
export const MAX_SESSION_CHARACTERS = 120_000;
export const MAX_SESSION_STORE_CHARACTERS = 500_000;
export const MAX_SESSION_TITLE_CHARACTERS = 80;

export type ConversationWorkspace = {
  id: string;
  name: string;
};

export type ConversationSession = {
  id: string;
  title: string;
  workspaceId: string;
  workspaceName: string;
  createdAt: number;
  updatedAt: number;
  turns: ConversationTurn[];
};

export type ConversationSessionStore = {
  version: 2;
  activeSessionId: string;
  sessions: ConversationSession[];
};

export function createEmptyConversationSessionStore(): ConversationSessionStore {
  return { version: 2, activeSessionId: '', sessions: [] };
}

export function createConversationSessionStore(
  id: string,
  now: number,
  workspace: ConversationWorkspace
): ConversationSessionStore {
  const session = emptySession(id, now, workspace);
  return {
    version: 2,
    activeSessionId: session.id,
    sessions: [session]
  };
}

export function parseConversationSessionStore(value: unknown): ConversationSessionStore | undefined {
  if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.sessions)) {
    return undefined;
  }
  return parseSessions(value.sessions, value.activeSessionId);
}

export function migrateLegacyConversationSessionStore(
  value: unknown,
  workspace: ConversationWorkspace
): ConversationSessionStore | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions)) {
    return undefined;
  }
  const migrated = value.sessions.map((candidate) => isRecord(candidate)
    ? {
      ...candidate,
      workspaceId: workspace.id,
      workspaceName: workspace.name
    }
    : candidate);
  return parseSessions(migrated, value.activeSessionId);
}

export function mergeConversationSessionStores(
  primary: ConversationSessionStore,
  imported: ConversationSessionStore
): ConversationSessionStore {
  const importedIds = new Set(imported.sessions.map((session) => session.id));
  return {
    version: 2,
    activeSessionId: imported.activeSessionId || primary.activeSessionId,
    sessions: boundStoreSessions([
      ...imported.sessions,
      ...primary.sessions.filter((session) => !importedIds.has(session.id))
    ].sort((left, right) => right.updatedAt - left.updatedAt))
  };
}

export function addConversationSession(
  store: ConversationSessionStore,
  id: string,
  now: number,
  workspace: ConversationWorkspace
): ConversationSessionStore {
  const session = emptySession(id, now, workspace);
  return {
    version: 2,
    activeSessionId: session.id,
    sessions: boundStoreSessions([
      session,
      ...store.sessions.filter((item) => item.id !== session.id)
    ])
  };
}

export function selectConversationSession(
  store: ConversationSessionStore,
  id: string
): ConversationSessionStore {
  if (!store.sessions.some((session) => session.id === id)) {
    return store;
  }
  return { ...store, activeSessionId: id };
}

export function renameConversationSession(
  store: ConversationSessionStore,
  id: string,
  title: string
): ConversationSessionStore {
  const normalizedTitle = normalizeSessionTitle(title);
  if (!normalizedTitle) {
    return store;
  }
  return {
    ...store,
    sessions: store.sessions.map((session) => session.id === id
      ? { ...session, title: normalizedTitle }
      : session)
  };
}

export function deleteConversationSession(
  store: ConversationSessionStore,
  id: string
): ConversationSessionStore {
  const remaining = store.sessions.filter((session) => session.id !== id);
  if (remaining.length === store.sessions.length) {
    return store;
  }
  return {
    version: 2,
    activeSessionId: store.activeSessionId === id ? (remaining[0]?.id ?? '') : store.activeSessionId,
    sessions: remaining
  };
}

export function appendConversationSessionTurn(
  store: ConversationSessionStore,
  user: string,
  assistant: string,
  now: number
): ConversationSessionStore {
  const turn = normalizeTurn({ user, assistant });
  if (!turn || !turn.assistant || !activeConversationSession(store)) {
    return store;
  }
  const sessions = boundStoreSessions(store.sessions.map((session) => {
    if (session.id !== store.activeSessionId) {
      return session;
    }
    const pendingTurn = session.turns.at(-1);
    const turns = pendingTurn?.user === turn.user && !pendingTurn.assistant
      ? [...session.turns.slice(0, -1), turn]
      : [...session.turns, turn];
    return {
      ...session,
      title: session.turns.length === 0 ? sessionTitleFromQuestion(turn.user) : session.title,
      updatedAt: Math.max(session.updatedAt, now),
      turns: boundSessionTurns(turns)
    };
  }).sort((left, right) => right.updatedAt - left.updatedAt));
  return { ...store, sessions };
}

export function appendConversationSessionUserMessage(
  store: ConversationSessionStore,
  user: string,
  now: number
): ConversationSessionStore {
  const normalizedUser = normalizeUserMessage(user);
  if (!normalizedUser || !activeConversationSession(store)) {
    return store;
  }
  const sessions = boundStoreSessions(store.sessions.map((session) => {
    if (session.id !== store.activeSessionId) {
      return session;
    }
    return {
      ...session,
      title: session.turns.length === 0
        ? sessionTitleFromQuestion(normalizedUser)
        : session.title,
      updatedAt: Math.max(session.updatedAt, now),
      turns: boundSessionTurns([
        ...session.turns,
        { user: normalizedUser, assistant: '' }
      ])
    };
  }).sort((left, right) => right.updatedAt - left.updatedAt));
  return { ...store, sessions };
}

export function activeConversationSession(
  store: ConversationSessionStore
): ConversationSession | undefined {
  return store.sessions.find((session) => session.id === store.activeSessionId);
}

export function activeSessionModelHistory(store: ConversationSessionStore): ConversationTurn[] {
  return boundConversationHistory(activeConversationSession(store)?.turns ?? []);
}

export function sessionBelongsToWorkspace(
  session: ConversationSession,
  workspace: ConversationWorkspace | undefined
): boolean {
  return Boolean(workspace && session.workspaceId === workspace.id);
}

export function sessionTitleFromQuestion(question: string): string {
  const normalized = question.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'New session';
  }
  const sliced = normalized.slice(0, MAX_SESSION_TITLE_CHARACTERS - 1);
  return sliced.length < normalized.length ? `${sliced.replace(/[\s.,;:!?-]+$/, '')}…` : sliced;
}

function parseSessions(value: unknown[], requestedActiveId: unknown): ConversationSessionStore | undefined {
  const seenIds = new Set<string>();
  const candidates: ConversationSession[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)
      || typeof candidate.id !== 'string'
      || !isSessionId(candidate.id)
      || seenIds.has(candidate.id)
      || typeof candidate.title !== 'string'
      || typeof candidate.workspaceId !== 'string'
      || !isWorkspaceId(candidate.workspaceId)
      || typeof candidate.workspaceName !== 'string'
      || typeof candidate.createdAt !== 'number'
      || !Number.isFinite(candidate.createdAt)
      || typeof candidate.updatedAt !== 'number'
      || !Number.isFinite(candidate.updatedAt)
      || candidate.createdAt < 0
      || candidate.updatedAt < candidate.createdAt
      || !Array.isArray(candidate.turns)) {
      continue;
    }
    seenIds.add(candidate.id);
    candidates.push({
      id: candidate.id,
      title: normalizeStoredSessionTitle(candidate.title),
      workspaceId: candidate.workspaceId,
      workspaceName: normalizeWorkspaceName(candidate.workspaceName),
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
      turns: boundSessionTurns(candidate.turns)
    });
  }
  candidates.sort((left, right) => right.updatedAt - left.updatedAt);
  const sessions = boundStoreSessions(candidates);
  if (sessions.length === 0) {
    return createEmptyConversationSessionStore();
  }
  const activeSessionId = typeof requestedActiveId === 'string'
    && sessions.some((session) => session.id === requestedActiveId)
    ? requestedActiveId
    : sessions[0].id;
  return { version: 2, activeSessionId, sessions };
}

function emptySession(
  id: string,
  now: number,
  workspace: ConversationWorkspace
): ConversationSession {
  if (!isSessionId(id)) {
    throw new Error('Session ids must be non-empty UUID-like values.');
  }
  if (!isWorkspaceId(workspace.id)) {
    throw new Error('Sessions require a valid workspace identity.');
  }
  const timestamp = Number.isFinite(now) && now >= 0 ? now : Date.now();
  return {
    id,
    title: 'New session',
    workspaceId: workspace.id,
    workspaceName: normalizeWorkspaceName(workspace.name),
    createdAt: timestamp,
    updatedAt: timestamp,
    turns: []
  };
}

function boundStoreSessions(sessions: ConversationSession[]): ConversationSession[] {
  let remaining = MAX_SESSION_STORE_CHARACTERS;
  return sessions.slice(0, MAX_CONVERSATION_SESSIONS).map((session) => {
    const turns = boundSessionTurns(
      session.turns,
      Math.min(MAX_SESSION_CHARACTERS, Math.max(0, remaining))
    );
    remaining -= conversationCharacters(turns);
    return { ...session, turns };
  });
}

function boundSessionTurns(value: unknown[], maximumCharacters = MAX_SESSION_CHARACTERS): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let characters = 0;
  for (const candidate of value.slice(-MAX_SESSION_TURNS).reverse()) {
    const turn = normalizeTurn(candidate);
    if (!turn) {
      continue;
    }
    const turnCharacters = turn.user.length + turn.assistant.length;
    if (characters + turnCharacters > maximumCharacters) {
      continue;
    }
    turns.push(turn);
    characters += turnCharacters;
  }
  return turns.reverse();
}

function normalizeTurn(value: unknown): ConversationTurn | undefined {
  if (!isRecord(value) || typeof value.user !== 'string' || typeof value.assistant !== 'string') {
    return undefined;
  }
  const user = normalizeUserMessage(value.user);
  const assistant = value.assistant.trim().slice(0, MAX_CONVERSATION_TURN_CHARACTERS);
  return user ? { user, assistant } : undefined;
}

function normalizeUserMessage(value: string): string {
  return value.trim().slice(0, MAX_CONVERSATION_TURN_CHARACTERS);
}

function normalizeSessionTitle(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SESSION_TITLE_CHARACTERS);
}

function normalizeStoredSessionTitle(value: string): string {
  const title = normalizeSessionTitle(value);
  return title.toLocaleLowerCase('en-US') === 'new conversation'
    ? 'New session'
    : title || 'New session';
}

function normalizeWorkspaceName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
    || 'Unknown project';
}

function conversationCharacters(turns: ConversationTurn[]): number {
  return turns.reduce((total, turn) => total + turn.user.length + turn.assistant.length, 0);
}

function isSessionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value);
}

function isWorkspaceId(value: string): boolean {
  return value.length > 0
    && value.length <= 2_048
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
