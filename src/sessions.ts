/** Validation and immutable updates for saved chats and unfinished runs; VS Code storage is handled by the chat view. */

import type { ConversationTurn, AgentToolStep, AssistantMode } from './api/types';
import { parseFileChangeSummary } from './fileTools';
import type { FileChangeSummaryItem } from './fileTools';
import { AGENT_TOOL_NAMES } from './agentTools';
import type { AgentToolName } from './agentTools';

export const CONVERSATION_SESSIONS_STORAGE_KEY = 'devMate.conversationSessions.v2';
export const LEGACY_CONVERSATION_SESSIONS_STORAGE_KEY = 'devMate.conversationSessions.v1';
export const MAX_CONVERSATION_SESSIONS = 20;
export const MAX_SESSION_TURNS = 30;
export const MAX_SESSION_CHARACTERS = 120_000;
export const MAX_SESSION_STORE_CHARACTERS = 500_000;
export const MAX_SESSION_TITLE_CHARACTERS = 80;
export const MAX_CONVERSATION_TURNS = 6;
export const MAX_CONVERSATION_TURN_CHARACTERS = 6_000;
export const MAX_CONVERSATION_HISTORY_CHARACTERS = 20_000;
export const AGENT_CHECKPOINT_STORAGE_KEY = 'devMate.agentCheckpoint.v1';
export const MAX_AGENT_CHECKPOINT_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export type AgentToolSignatureCheckpoint = {
  signature: string;
  revision: number;
  executions: number;
};

export type AgentRunCheckpoint = {
  version: 1;
  workspaceId: string;
  sessionId: string;
  question: string;
  mode: AssistantMode;
  scopeKind: 'project' | 'activeFile' | 'selection';
  toolHistory: AgentToolStep[];
  toolUsedFiles: string[];
  toolSignatures: AgentToolSignatureCheckpoint[];
  fileMutationCalls: number;
  mutationCharacters: number;
  commandCalls: number;
  dependencyInstallCalls: number;
  workspaceRevision: number;
  forceFinalAnswer: boolean;
  disableThinking: boolean;
  emptyResponseRecoveryAttempted: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokenUsageExact: boolean;
  createdAt: number;
  updatedAt: number;
};

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
  turns: StoredConversationTurn[];
};

export type StoredConversationTurn = ConversationTurn & {
  fileChanges?: FileChangeSummaryItem[];
};

export type ConversationSessionStore = {
  version: 2;
  activeSessionId: string;
  sessions: ConversationSession[];
};
const toolNames = new Set<AgentToolName>(AGENT_TOOL_NAMES);

// Reject incompatible, oversized, or expired runs before offering Continue.
export function parseAgentRunCheckpoint(
  value: unknown,
  now = Date.now()
): AgentRunCheckpoint | undefined {
  if (!isRecord(value)
    || value.version !== 1
    || !boundedString(value.workspaceId, 2_048)
    || !boundedString(value.sessionId, 120)
    || !boundedString(value.question, 50_000)
    || !['ideas', 'code', 'debug'].includes(String(value.mode))
    || !['project', 'activeFile', 'selection'].includes(String(value.scopeKind))
    || !Array.isArray(value.toolHistory)
    || value.toolHistory.length > 100
    || !Array.isArray(value.toolUsedFiles)
    || value.toolUsedFiles.length > 100
    || !Array.isArray(value.toolSignatures)
    || value.toolSignatures.length > 100
    || !validCounter(value.fileMutationCalls, 6)
    || !validCounter(value.mutationCharacters, 500_000)
    || !validCounter(value.commandCalls, 3)
    || !validCounter(value.dependencyInstallCalls, 1)
    || !validCounter(value.workspaceRevision, 200)
    || typeof value.forceFinalAnswer !== 'boolean'
    || typeof value.disableThinking !== 'boolean'
    || typeof value.emptyResponseRecoveryAttempted !== 'boolean'
    || !validCounter(value.inputTokens, 200_000_000)
    || !validCounter(value.outputTokens, 200_000_000)
    || !validCounter(value.totalTokens, 400_000_000)
    || value.totalTokens < value.inputTokens + value.outputTokens
    || typeof value.tokenUsageExact !== 'boolean'
    || !validTimestamp(value.createdAt)
    || !validTimestamp(value.updatedAt)
    || value.updatedAt < value.createdAt
    || value.updatedAt > now + 60_000
    || now - value.updatedAt > MAX_AGENT_CHECKPOINT_AGE_MS) {
    return undefined;
  }

  const toolHistory = parseToolHistory(value.toolHistory);
  const toolUsedFiles = value.toolUsedFiles.every((item) => boundedString(item, 2_048))
    ? [...new Set(value.toolUsedFiles as string[])]
    : undefined;
  const toolSignatures = parseToolSignatures(value.toolSignatures);
  if (!toolHistory || !toolUsedFiles || !toolSignatures) {
    return undefined;
  }

  return {
    version: 1,
    workspaceId: value.workspaceId as string,
    sessionId: value.sessionId as string,
    question: value.question as string,
    mode: value.mode as AssistantMode,
    scopeKind: value.scopeKind as AgentRunCheckpoint['scopeKind'],
    toolHistory,
    toolUsedFiles,
    toolSignatures,
    fileMutationCalls: value.fileMutationCalls as number,
    mutationCharacters: value.mutationCharacters as number,
    commandCalls: value.commandCalls as number,
    dependencyInstallCalls: value.dependencyInstallCalls as number,
    workspaceRevision: value.workspaceRevision as number,
    forceFinalAnswer: value.forceFinalAnswer,
    disableThinking: value.disableThinking,
    emptyResponseRecoveryAttempted: value.emptyResponseRecoveryAttempted,
    inputTokens: value.inputTokens as number,
    outputTokens: value.outputTokens as number,
    totalTokens: value.totalTokens as number,
    tokenUsageExact: value.tokenUsageExact,
    createdAt: value.createdAt as number,
    updatedAt: value.updatedAt as number
  };
}

function parseToolHistory(value: unknown[]): AgentToolStep[] | undefined {
  const parsed: AgentToolStep[] = [];
  const callIds = new Set<string>();
  let resultCharacters = 0;
  for (const item of value) {
    if (!isRecord(item)
      || !boundedString(item.callId, 120)
      || callIds.has(item.callId)
      || !toolNames.has(item.name as AgentToolName)
      || !isRecord(item.arguments)
      || JSON.stringify(item.arguments).length > 4_000
      || typeof item.result !== 'string'
      || item.result.length > 10_000
      || typeof item.isError !== 'boolean') {
      return undefined;
    }
    resultCharacters += item.result.length;
    if (resultCharacters > 80_000) {
      return undefined;
    }
    callIds.add(item.callId);
    parsed.push({
      callId: item.callId,
      name: item.name as AgentToolName,
      arguments: item.arguments,
      result: item.result,
      isError: item.isError
    });
  }
  return parsed;
}

function parseToolSignatures(value: unknown[]): AgentToolSignatureCheckpoint[] | undefined {
  const parsed: AgentToolSignatureCheckpoint[] = [];
  const signatures = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)
      || typeof item.signature !== 'string'
      || !/^[a-f0-9]{64}$/.test(item.signature)
      || signatures.has(item.signature)
      || !validCounter(item.revision, 200)
      || !validCounter(item.executions, 100)
      || item.executions < 1) {
      return undefined;
    }
    signatures.add(item.signature);
    parsed.push({
      signature: item.signature,
      revision: item.revision,
      executions: item.executions
    });
  }
  return parsed;
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function validCounter(value: unknown, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= maximum;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// Replay only recent complete turns; the stored chat can retain a longer history.
export function boundConversationHistory(history: ConversationTurn[]): ConversationTurn[] {
  const bounded: ConversationTurn[] = [];
  let characters = 0;
  for (const candidate of history.slice(-MAX_CONVERSATION_TURNS).reverse()) {
    if (!candidate || typeof candidate.user !== 'string' || typeof candidate.assistant !== 'string') {
      continue;
    }
    const turn = {
      user: candidate.user.trim().slice(0, MAX_CONVERSATION_TURN_CHARACTERS),
      assistant: candidate.assistant.trim().slice(0, MAX_CONVERSATION_TURN_CHARACTERS)
    };
    if (!turn.user || !turn.assistant) {
      continue;
    }
    const turnCharacters = turn.user.length + turn.assistant.length;
    if (characters + turnCharacters > MAX_CONVERSATION_HISTORY_CHARACTERS) {
      continue;
    }
    bounded.push(turn);
    characters += turnCharacters;
  }
  return bounded.reverse();
}

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

/** Validate the saved store and bound its contents before making it available to the chat UI. */
export function parseConversationSessionStore(value: unknown): ConversationSessionStore | undefined {
  if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.sessions)) {
    return undefined;
  }
  return parseSessions(value.sessions, value.activeSessionId);
}

/** Attach the current workspace identity to older workspace-local chats when importing them into the global store. */
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

/** Combine stores by session ID, preferring imported entries, then keep the newest sessions within storage limits. */
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

/** Complete the matching pending question when possible; otherwise append a new question/answer pair. */
export function appendConversationSessionTurn(
  store: ConversationSessionStore,
  user: string,
  assistant: string,
  now: number,
  fileChanges: FileChangeSummaryItem[] = []
): ConversationSessionStore {
  const turn = normalizeTurn({ user, assistant, fileChanges });
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
  // Save the question before the provider call so a failed request still remains in the session.
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

/** Build the smaller model history from saved chat text; file-change UI metadata is not part of the prompt. */
export function activeSessionModelHistory(store: ConversationSessionStore): ConversationTurn[] {
  return boundConversationHistory(
    (activeConversationSession(store)?.turns ?? []).map((turn) => ({
      user: turn.user,
      assistant: turn.assistant
    }))
  );
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

/** Keep recent sessions within both the session count and total text budget to avoid unbounded global storage. */
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

function boundSessionTurns(value: unknown[], maximumCharacters = MAX_SESSION_CHARACTERS): StoredConversationTurn[] {
  const turns: StoredConversationTurn[] = [];
  let characters = 0;
  for (const candidate of value.slice(-MAX_SESSION_TURNS).reverse()) {
    const turn = normalizeTurn(candidate);
    if (!turn) {
      continue;
    }
    const turnCharacters = turn.user.length + turn.assistant.length + fileChangeCharacters(turn.fileChanges);
    if (characters + turnCharacters > maximumCharacters) {
      continue;
    }
    turns.push(turn);
    characters += turnCharacters;
  }
  return turns.reverse();
}

function normalizeTurn(value: unknown): StoredConversationTurn | undefined {
  if (!isRecord(value) || typeof value.user !== 'string' || typeof value.assistant !== 'string') {
    return undefined;
  }
  const user = normalizeUserMessage(value.user);
  const assistant = value.assistant.trim().slice(0, MAX_CONVERSATION_TURN_CHARACTERS);
  const fileChanges = parseFileChangeSummary(value.fileChanges);
  return user
    ? {
      user,
      assistant,
      ...(fileChanges.length > 0 ? { fileChanges } : {})
    }
    : undefined;
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

function conversationCharacters(turns: StoredConversationTurn[]): number {
  return turns.reduce((total, turn) => total + turn.user.length + turn.assistant.length
    + fileChangeCharacters(turn.fileChanges), 0);
}

function fileChangeCharacters(fileChanges: FileChangeSummaryItem[] | undefined): number {
  return fileChanges?.reduce(
    (total, change) => total + change.path.length + (change.previousPath?.length ?? 0) + 16,
    0
  ) ?? 0;
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
