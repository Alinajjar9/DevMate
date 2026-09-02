// Validate persisted sessions and summaries returned by the backend.
// Reject malformed data before it can replace local conversation state.

import {
  CHAT_SUMMARY_VERSION,
  MAX_CHAT_DIFF_ID_CHARACTERS,
  MAX_CHAT_FILE_CHANGE_PATH_CHARACTERS,
  MAX_CHAT_FILE_CHANGES,
  MAX_CHAT_INTEGER,
  MAX_CHAT_SESSIONS_PER_REQUEST,
  MAX_CHAT_SESSIONS_RETURNED,
  MAX_CHAT_SESSION_ID_CHARACTERS,
  MAX_CHAT_SESSION_TITLE_CHARACTERS,
  MAX_CHAT_SUMMARY_CHARACTERS,
  MAX_CHAT_SUMMARY_ITEM_CHARACTERS,
  MAX_CHAT_SUMMARY_ITEMS,
  MAX_CHAT_TURNS_PER_SNAPSHOT,
  MAX_CHAT_TURN_CHARACTERS,
  MAX_CHAT_WORKSPACE_IDENTITY_CHARACTERS,
  MAX_CHAT_WORKSPACE_NAME_CHARACTERS
} from './types';
import type {
  ChatMemoryDeleteResponse,
  ChatMemoryCompactionResponse,
  ChatMemoryFileChange,
  ChatMemoryListResponse,
  ChatMemoryLoadResponse,
  ChatMemorySaveResponse,
  ChatMemorySession,
  ChatMemorySummary,
  ChatMemorySummaryContent,
  ChatMemorySummaryLoadResponse,
  ChatMemorySnapshot,
  ChatMemoryTurn
} from './types';

const chatMemoryIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const fileChangeKinds = new Set<string>([
  'created',
  'updated',
  'deleted',
  'renamed',
  'moved'
]);

export function parseChatMemorySaveResponse(
  value: unknown
): ChatMemorySaveResponse | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['savedSessionIds'])
    || !Array.isArray(value.savedSessionIds)
    || value.savedSessionIds.length === 0
    || value.savedSessionIds.length > MAX_CHAT_SESSIONS_PER_REQUEST
    || !value.savedSessionIds.every(isChatMemoryIdentifier)
    || new Set(value.savedSessionIds).size !== value.savedSessionIds.length) {
    return undefined;
  }
  return { savedSessionIds: [...value.savedSessionIds] };
}

export function parseChatMemoryLoadResponse(
  value: unknown
): ChatMemoryLoadResponse | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['session'])) {
    return undefined;
  }
  const session = parseChatMemorySnapshot(value.session);
  return session ? { session } : undefined;
}

export function parseChatMemoryListResponse(
  value: unknown
): ChatMemoryListResponse | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['sessions'])
    || !Array.isArray(value.sessions)
    || value.sessions.length > MAX_CHAT_SESSIONS_RETURNED) {
    return undefined;
  }
  const sessions: ChatMemorySession[] = [];
  for (const candidate of value.sessions) {
    const session = parseChatMemorySession(candidate);
    if (!session) {
      return undefined;
    }
    sessions.push(session);
  }
  if (new Set(sessions.map((session) => session.sessionId)).size !== sessions.length
    || sessions.some((session, index) => (
      index > 0 && sessions[index - 1].updatedAtMs < session.updatedAtMs
    ))) {
    return undefined;
  }
  return { sessions };
}

export function parseChatMemoryDeleteResponse(
  value: unknown
): ChatMemoryDeleteResponse | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['deleted'])
    || typeof value.deleted !== 'boolean') {
    return undefined;
  }
  return { deleted: value.deleted };
}

export function parseChatMemorySummaryLoadResponse(
  value: unknown
): ChatMemorySummaryLoadResponse | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['summary'])) {
    return undefined;
  }
  if (value.summary === null) {
    return { summary: null };
  }
  const summary = parseChatMemorySummary(value.summary);
  return summary ? { summary } : undefined;
}

export function parseChatMemoryCompactionResponse(
  value: unknown
): ChatMemoryCompactionResponse | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['summary', 'compactedTurns'])
    || !isChatInteger(value.compactedTurns, 1)
    || value.compactedTurns > MAX_CHAT_TURNS_PER_SNAPSHOT) {
    return undefined;
  }
  const summary = parseChatMemorySummary(value.summary);
  return summary
    ? { summary, compactedTurns: value.compactedTurns }
    : undefined;
}

export function parseChatMemorySummary(value: unknown): ChatMemorySummary | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'sessionId',
      'summaryVersion',
      'content',
      'lastCompactedTurn',
      'createdAtMs',
      'updatedAtMs'
    ])
    || !isChatMemoryIdentifier(value.sessionId)
    || value.summaryVersion !== CHAT_SUMMARY_VERSION
    || !isChatInteger(value.lastCompactedTurn, 0)
    || !isChatInteger(value.createdAtMs, 0)
    || !isChatInteger(value.updatedAtMs, value.createdAtMs)) {
    return undefined;
  }
  const content = parseChatMemorySummaryContent(value.content);
  return content
    ? {
      sessionId: value.sessionId,
      summaryVersion: CHAT_SUMMARY_VERSION,
      content,
      lastCompactedTurn: value.lastCompactedTurn,
      createdAtMs: value.createdAtMs,
      updatedAtMs: value.updatedAtMs
    }
    : undefined;
}

function parseChatMemorySummaryContent(value: unknown): ChatMemorySummaryContent | undefined {
  const itemKeys = [
    'constraints',
    'importantFiles',
    'completedWork',
    'openTasks',
    'unresolvedQuestions'
  ] as const;
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['goal', 'decisions', ...itemKeys])
    || !isSummaryText(value.goal)
    || !Array.isArray(value.decisions)
    || value.decisions.length > MAX_CHAT_SUMMARY_ITEMS) {
    return undefined;
  }
  const decisions: ChatMemorySummaryContent['decisions'] = [];
  for (const candidate of value.decisions) {
    if (!isRecord(candidate)
      || !hasOnlyKeys(candidate, ['decision', 'reason'])
      || !isSummaryText(candidate.decision)
      || !isSummaryText(candidate.reason)) {
      return undefined;
    }
    decisions.push({ decision: candidate.decision, reason: candidate.reason });
  }
  const lists: Record<(typeof itemKeys)[number], string[]> = {
    constraints: [],
    importantFiles: [],
    completedWork: [],
    openTasks: [],
    unresolvedQuestions: []
  };
  for (const key of itemKeys) {
    const items = value[key];
    if (!Array.isArray(items)
      || items.length > MAX_CHAT_SUMMARY_ITEMS
      || !items.every(isSummaryText)) {
      return undefined;
    }
    lists[key] = [...items];
  }
  const content: ChatMemorySummaryContent = {
    goal: value.goal,
    constraints: lists.constraints,
    decisions,
    importantFiles: lists.importantFiles,
    completedWork: lists.completedWork,
    openTasks: lists.openTasks,
    unresolvedQuestions: lists.unresolvedQuestions
  };
  return JSON.stringify(content).length <= MAX_CHAT_SUMMARY_CHARACTERS
    ? content
    : undefined;
}

export function parseChatMemorySnapshot(value: unknown): ChatMemorySnapshot | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['session', 'turns'])
    || !Array.isArray(value.turns)
    || value.turns.length > MAX_CHAT_TURNS_PER_SNAPSHOT) {
    return undefined;
  }
  const session = parseChatMemorySession(value.session);
  if (!session) {
    return undefined;
  }
  const turns: ChatMemoryTurn[] = [];
  for (const candidate of value.turns) {
    const turn = parseChatMemoryTurn(candidate);
    if (!turn || turn.ordinal !== turns.length) {
      return undefined;
    }
    turns.push(turn);
  }
  return { session, turns };
}

export function parseChatMemorySession(value: unknown): ChatMemorySession | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'sessionId',
      'workspaceIdentity',
      'workspaceName',
      'title',
      'createdAtMs',
      'updatedAtMs'
    ])
    || !isChatMemoryIdentifier(value.sessionId)
    || !isIdentifierText(value.workspaceIdentity, MAX_CHAT_WORKSPACE_IDENTITY_CHARACTERS)
    || !isIdentifierText(value.workspaceName, MAX_CHAT_WORKSPACE_NAME_CHARACTERS)
    || !isIdentifierText(value.title, MAX_CHAT_SESSION_TITLE_CHARACTERS)
    || !isChatInteger(value.createdAtMs, 0)
    || !isChatInteger(value.updatedAtMs, value.createdAtMs)) {
    return undefined;
  }
  return {
    sessionId: value.sessionId,
    workspaceIdentity: value.workspaceIdentity,
    workspaceName: value.workspaceName,
    title: value.title,
    createdAtMs: value.createdAtMs,
    updatedAtMs: value.updatedAtMs
  };
}

function parseChatMemoryTurn(value: unknown): ChatMemoryTurn | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['ordinal', 'user', 'assistant', 'fileChanges'])
    || !isChatInteger(value.ordinal, 0)
    || !isContentText(value.user, false)
    || !isContentText(value.assistant, true)
    || !Array.isArray(value.fileChanges)
    || value.fileChanges.length > MAX_CHAT_FILE_CHANGES) {
    return undefined;
  }
  const fileChanges: ChatMemoryFileChange[] = [];
  for (const candidate of value.fileChanges) {
    const change = parseChatMemoryFileChange(candidate);
    if (!change) {
      return undefined;
    }
    fileChanges.push(change);
  }
  return {
    ordinal: value.ordinal,
    user: value.user,
    assistant: value.assistant,
    fileChanges
  };
}

function parseChatMemoryFileChange(value: unknown): ChatMemoryFileChange | undefined {
  if (!isRecord(value)
    || !hasOnlyOptionalKeys(value, ['kind', 'path'], ['previousPath', 'diffId'])
    || typeof value.kind !== 'string'
    || !fileChangeKinds.has(value.kind)
    || !isIdentifierText(value.path, MAX_CHAT_FILE_CHANGE_PATH_CHARACTERS)
    || !(value.previousPath === undefined
      || isIdentifierText(value.previousPath, MAX_CHAT_FILE_CHANGE_PATH_CHARACTERS))
    || !(value.diffId === undefined
      || typeof value.diffId === 'string'
        && value.diffId.length <= MAX_CHAT_DIFF_ID_CHARACTERS
        && chatMemoryIdentifierPattern.test(value.diffId))) {
    return undefined;
  }
  const relocated = value.kind === 'renamed' || value.kind === 'moved';
  if (relocated !== (value.previousPath !== undefined)) {
    return undefined;
  }
  return {
    kind: value.kind as ChatMemoryFileChange['kind'],
    path: value.path,
    ...(value.previousPath !== undefined ? { previousPath: value.previousPath } : {}),
    ...(value.diffId !== undefined ? { diffId: value.diffId } : {})
  };
}

function isChatMemoryIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_CHAT_SESSION_ID_CHARACTERS
    && chatMemoryIdentifierPattern.test(value);
}

function isIdentifierText(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isContentText(value: unknown, allowEmpty: boolean): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.trim().length > 0)
    && value.length <= MAX_CHAT_TURN_CHARACTERS
    && !value.includes('\0');
}

function isSummaryText(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= MAX_CHAT_SUMMARY_ITEM_CHARACTERS
    && !value.includes('\0');
}

function isChatInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= MAX_CHAT_INTEGER;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function hasOnlyOptionalKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[]
): boolean {
  const actual = Object.keys(value);
  return required.every((key) => actual.includes(key))
    && actual.every((key) => required.includes(key) || optional.includes(key));
}
