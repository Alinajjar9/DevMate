// Send authenticated backend requests and decode untrusted responses.
// The transport owns socket details; protocol modules validate each endpoint's response.

import {
  DEVMATE_BACKEND_TOKEN_HEADER,
  DEVMATE_CHAT_MEMORY_API_VERSION,
  DEVMATE_KNOWLEDGE_INDEX_API_VERSION,
  MAX_EMBEDDING_API_KEY_CHARACTERS,
  MAX_BACKEND_TOKEN_CHARACTERS,
  MIN_BACKEND_TOKEN_CHARACTERS
} from './types';
import type {
  ApiResult,
  AskRequest,
  AskResponse,
  ChatMemoryCompactionRequest,
  ChatMemoryCompactionResponse,
  ChatMemoryDeleteResponse,
  ChatMemoryListRequest,
  ChatMemoryListResponse,
  ChatMemoryLoadResponse,
  ChatMemorySaveRequest,
  ChatMemorySaveResponse,
  ChatMemorySessionRequest,
  ChatMemorySummaryLoadResponse,
  HealthResponse,
  KnowledgeIndexApplyRequest,
  KnowledgeIndexEmbeddingRequest,
  KnowledgeIndexEmbeddingResponse,
  KnowledgeIndexMetadata,
  KnowledgeIndexMetadataUpdateRequest,
  KnowledgeIndexOpenRequest,
  KnowledgeIndexOpenResponse,
  KnowledgeIndexSearchRequest,
  KnowledgeIndexSearchResponse,
  KnowledgeIndexSemanticSearchRequest,
  KnowledgeIndexSemanticSearchResponse,
  KnowledgeIndexWriteResponse
} from './types';
import {
  parseKnowledgeIndexMetadata,
  parseKnowledgeIndexEmbeddingResponse,
  parseKnowledgeIndexOpenResponse,
  parseKnowledgeIndexSearchResponse,
  parseKnowledgeIndexSemanticSearchResponse,
  parseKnowledgeIndexWriteResponse
} from './knowledgeIndexProtocol';
import {
  parseChatMemoryCompactionResponse,
  parseChatMemoryDeleteResponse,
  parseChatMemoryListResponse,
  parseChatMemoryLoadResponse,
  parseChatMemorySaveResponse,
  parseChatMemorySummaryLoadResponse
} from './chatMemoryProtocol';

import {
  fetchJsonRequest,
  nodeHttpJsonRequest,
  nodeHttpStreamRequest
} from './backendTransport';
import type { AskStreamEvent, AskStreamResult } from './backendTransport';
import {
  parseAskResponse,
  parseCompatibleHealthResponse
} from './backendResponseProtocol';

export type { AskStreamEvent, AskStreamResult } from './backendTransport';

const HEALTH_TIMEOUT_MS = 2_000;
const KNOWLEDGE_INDEX_TIMEOUT_MS = 30_000;
const CHAT_MEMORY_TIMEOUT_MS = 30_000;
export const DEFAULT_CHAT_COMPACTION_TIMEOUT_MS = 930_000;
export const DEFAULT_EMBEDDING_INDEX_TIMEOUT_MS = 150_000;
export const DEFAULT_SEMANTIC_SEARCH_TIMEOUT_MS = 60_000;
export const DEFAULT_ASK_TIMEOUT_MS = 930_000;
const PROVIDER_KEY_HEADER = 'X-DevMate-Provider-Key';
const knowledgeIndexPath = `/index/v${DEVMATE_KNOWLEDGE_INDEX_API_VERSION}`;
const chatMemoryPath = `/memory/v${DEVMATE_CHAT_MEMORY_API_VERSION}`;

export type BackendRequestSecrets = {
  backendToken: string;
  providerApiKey?: string;
};

export async function health(
  backendUrl: string,
  backendToken: string
): Promise<ApiResult<HealthResponse>> {
  if (!isValidBackendToken(backendToken)) {
    return backendAuthenticationUnavailable();
  }
  const result = await fetchJsonRequest<unknown>(
    backendUrl,
    '/health',
    {
      method: 'GET',
      headers: { [DEVMATE_BACKEND_TOKEN_HEADER]: backendToken }
    },
    HEALTH_TIMEOUT_MS
  );
  if (result.status !== 'ok') {
    return {
      status: 'error',
      message: result.message,
      statusCode: result.statusCode,
      errorKind: result.errorKind
    };
  }

  const response = parseCompatibleHealthResponse(result.data);
  if (!response) {
    return {
      status: 'error',
      message: 'The service did not identify itself as a compatible DevMate backend.',
      errorKind: 'invalid-response'
    };
  }
  return { status: 'ok', data: response };
}

export function saveChatMemorySessions(
  backendUrl: string,
  request: ChatMemorySaveRequest,
  backendToken: string,
  signal?: AbortSignal
): Promise<ApiResult<ChatMemorySaveResponse>> {
  const expectedIds = request.sessions.map((snapshot) => snapshot.session.sessionId);
  return chatMemoryRequest(
    backendUrl,
    `${chatMemoryPath}/sessions/save`,
    request,
    backendToken,
    (value) => {
      const response = parseChatMemorySaveResponse(value);
      return response
        && response.savedSessionIds.length === expectedIds.length
        && response.savedSessionIds.every((id, index) => id === expectedIds[index])
        ? response
        : undefined;
    },
    signal
  );
}

export function loadChatMemorySession(
  backendUrl: string,
  request: ChatMemorySessionRequest,
  backendToken: string,
  signal?: AbortSignal
): Promise<ApiResult<ChatMemoryLoadResponse>> {
  return chatMemoryRequest(
    backendUrl,
    `${chatMemoryPath}/sessions/load`,
    request,
    backendToken,
    (value) => {
      const response = parseChatMemoryLoadResponse(value);
      return response?.session.session.sessionId === request.sessionId
        ? response
        : undefined;
    },
    signal
  );
}

export function listChatMemorySessions(
  backendUrl: string,
  request: ChatMemoryListRequest,
  backendToken: string,
  signal?: AbortSignal
): Promise<ApiResult<ChatMemoryListResponse>> {
  return chatMemoryRequest(
    backendUrl,
    `${chatMemoryPath}/sessions/list`,
    request,
    backendToken,
    (value) => {
      const response = parseChatMemoryListResponse(value);
      return response
        && response.sessions.length <= request.limit
        && response.sessions.every(
          (session) => session.workspaceIdentity === request.workspaceIdentity
        )
        ? response
        : undefined;
    },
    signal
  );
}

export function deleteChatMemorySession(
  backendUrl: string,
  request: ChatMemorySessionRequest,
  backendToken: string,
  signal?: AbortSignal
): Promise<ApiResult<ChatMemoryDeleteResponse>> {
  return chatMemoryRequest(
    backendUrl,
    `${chatMemoryPath}/sessions/delete`,
    request,
    backendToken,
    parseChatMemoryDeleteResponse,
    signal
  );
}

export function loadChatMemorySummary(
  backendUrl: string,
  request: ChatMemorySessionRequest,
  backendToken: string,
  signal?: AbortSignal
): Promise<ApiResult<ChatMemorySummaryLoadResponse>> {
  return chatMemoryRequest(
    backendUrl,
    `${chatMemoryPath}/summaries/load`,
    request,
    backendToken,
    (value) => {
      const response = parseChatMemorySummaryLoadResponse(value);
      return response && (
        response.summary === null || response.summary.sessionId === request.sessionId
      )
        ? response
        : undefined;
    },
    signal
  );
}

export function compactChatMemorySummary(
  backendUrl: string,
  request: ChatMemoryCompactionRequest,
  secrets: BackendRequestSecrets,
  timeoutMilliseconds = DEFAULT_CHAT_COMPACTION_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<ApiResult<ChatMemoryCompactionResponse>> {
  return chatMemoryRequest(
    backendUrl,
    `${chatMemoryPath}/summaries/compact`,
    request,
    secrets.backendToken,
    (value) => {
      const response = parseChatMemoryCompactionResponse(value);
      return response
        && response.summary.sessionId === request.sessionId
        && response.summary.lastCompactedTurn === request.throughTurn
        && response.compactedTurns <= request.throughTurn + 1
        ? response
        : undefined;
    },
    signal,
    {
      providerApiKey: secrets.providerApiKey,
      timeoutMilliseconds
    }
  );
}

export function openKnowledgeIndex(
  backendUrl: string,
  request: KnowledgeIndexOpenRequest,
  backendToken: string,
  signal?: AbortSignal
): Promise<ApiResult<KnowledgeIndexOpenResponse>> {
  return knowledgeIndexRequest(
    backendUrl,
    `${knowledgeIndexPath}/workspaces/open`,
    request,
    backendToken,
    parseKnowledgeIndexOpenResponse,
    signal
  );
}

export function applyKnowledgeIndexChanges(
  backendUrl: string,
  request: KnowledgeIndexApplyRequest,
  backendToken: string,
  signal?: AbortSignal
): Promise<ApiResult<KnowledgeIndexWriteResponse>> {
  return knowledgeIndexRequest(
    backendUrl,
    `${knowledgeIndexPath}/files/apply`,
    request,
    backendToken,
    parseKnowledgeIndexWriteResponse,
    signal
  );
}

export function updateKnowledgeIndexMetadata(
  backendUrl: string,
  request: KnowledgeIndexMetadataUpdateRequest,
  backendToken: string,
  signal?: AbortSignal
): Promise<ApiResult<KnowledgeIndexMetadata>> {
  return knowledgeIndexRequest(
    backendUrl,
    `${knowledgeIndexPath}/metadata/update`,
    request,
    backendToken,
    parseKnowledgeIndexMetadata,
    signal
  );
}

export function searchKnowledgeIndex(
  backendUrl: string,
  request: KnowledgeIndexSearchRequest,
  backendToken: string,
  signal?: AbortSignal
): Promise<ApiResult<KnowledgeIndexSearchResponse>> {
  return knowledgeIndexRequest(
    backendUrl,
    `${knowledgeIndexPath}/search`,
    request,
    backendToken,
    parseKnowledgeIndexSearchResponse,
    signal
  );
}

export function synchronizeKnowledgeIndexEmbeddings(
  backendUrl: string,
  request: KnowledgeIndexEmbeddingRequest,
  secrets: BackendRequestSecrets,
  timeoutMilliseconds = DEFAULT_EMBEDDING_INDEX_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<ApiResult<KnowledgeIndexEmbeddingResponse>> {
  return knowledgeIndexRequest(
    backendUrl,
    `${knowledgeIndexPath}/embeddings/synchronize`,
    request,
    secrets.backendToken,
    (value) => {
      const response = parseKnowledgeIndexEmbeddingResponse(value);
      if (!response) {
        return undefined;
      }
      const configuration = response.configuration;
      if (configuration !== null && (
        configuration.profileId !== request.profileId
        || configuration.provider !== request.provider
        || configuration.model !== request.model
        || configuration.vectorVersion !== request.vectorVersion
      )) {
        return undefined;
      }
      return response;
    },
    signal,
    {
      providerApiKey: secrets.providerApiKey,
      timeoutMilliseconds
    }
  );
}

export function searchKnowledgeIndexSemantically(
  backendUrl: string,
  request: KnowledgeIndexSemanticSearchRequest,
  secrets: BackendRequestSecrets,
  timeoutMilliseconds = DEFAULT_SEMANTIC_SEARCH_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<ApiResult<KnowledgeIndexSemanticSearchResponse>> {
  return knowledgeIndexRequest(
    backendUrl,
    `${knowledgeIndexPath}/embeddings/search`,
    request,
    secrets.backendToken,
    (value) => {
      const response = parseKnowledgeIndexSemanticSearchResponse(value);
      if (!response) {
        return undefined;
      }
      const configuration = response.configuration;
      if (configuration !== null && (
        configuration.profileId !== request.profileId
        || configuration.provider !== request.provider
        || configuration.model !== request.model
        || configuration.vectorVersion !== request.vectorVersion
      )) {
        return undefined;
      }
      return response;
    },
    signal,
    {
      providerApiKey: secrets.providerApiKey,
      timeoutMilliseconds
    }
  );
}

type LocalBackendRequestOptions = {
  providerApiKey?: string;
  timeoutMilliseconds?: number;
};

type LocalBackendRequestPolicy = {
  defaultTimeoutMilliseconds: number;
  nonLocalBackendMessage: string;
  invalidApiKeyMessage: string;
  invalidTimeoutMessage: string;
};

const CHAT_MEMORY_REQUEST_POLICY: LocalBackendRequestPolicy = {
  defaultTimeoutMilliseconds: CHAT_MEMORY_TIMEOUT_MS,
  nonLocalBackendMessage: 'DevMate only sends chat history to a backend running on this computer.',
  invalidApiKeyMessage: 'The selected provider API key is invalid.',
  invalidTimeoutMessage: 'The chat-memory request timeout is invalid.'
};

const KNOWLEDGE_INDEX_REQUEST_POLICY: LocalBackendRequestPolicy = {
  defaultTimeoutMilliseconds: KNOWLEDGE_INDEX_TIMEOUT_MS,
  nonLocalBackendMessage: 'DevMate only stores workspace source in a backend running on this computer.',
  invalidApiKeyMessage: 'The embedding provider API key is invalid.',
  invalidTimeoutMessage: 'The knowledge-index request timeout is invalid.'
};

function chatMemoryRequest<T>(
  backendUrl: string,
  requestPath: string,
  request: object,
  backendToken: string,
  decodeData: (value: unknown) => T | undefined,
  signal?: AbortSignal,
  options: LocalBackendRequestOptions = {}
): Promise<ApiResult<T>> {
  return localBackendRequest(
    CHAT_MEMORY_REQUEST_POLICY,
    backendUrl,
    requestPath,
    request,
    backendToken,
    decodeData,
    signal,
    options
  );
}

function knowledgeIndexRequest<T>(
  backendUrl: string,
  requestPath: string,
  request: object,
  backendToken: string,
  decodeData: (value: unknown) => T | undefined,
  signal?: AbortSignal,
  options: LocalBackendRequestOptions = {}
): Promise<ApiResult<T>> {
  return localBackendRequest(
    KNOWLEDGE_INDEX_REQUEST_POLICY,
    backendUrl,
    requestPath,
    request,
    backendToken,
    decodeData,
    signal,
    options
  );
}

// Memory and indexing send private data. Apply the same local-only checks before either request.
function localBackendRequest<T>(
  policy: LocalBackendRequestPolicy,
  backendUrl: string,
  requestPath: string,
  request: object,
  backendToken: string,
  decodeData: (value: unknown) => T | undefined,
  signal: AbortSignal | undefined,
  options: LocalBackendRequestOptions
): Promise<ApiResult<T>> {
  if (!isValidBackendToken(backendToken)) {
    return Promise.resolve(backendAuthenticationUnavailable());
  }
  if (!isLoopbackBackendUrl(backendUrl)) {
    return Promise.resolve({
      status: 'error',
      message: policy.nonLocalBackendMessage,
      errorKind: 'configuration'
    });
  }
  const providerApiKey = options.providerApiKey;
  if (providerApiKey !== undefined && (
    providerApiKey.length === 0
    || providerApiKey.length > MAX_EMBEDDING_API_KEY_CHARACTERS
    || /[\r\n]/.test(providerApiKey)
  )) {
    return Promise.resolve({
      status: 'error',
      message: policy.invalidApiKeyMessage,
      errorKind: 'configuration'
    });
  }
  const timeoutMilliseconds = options.timeoutMilliseconds ?? policy.defaultTimeoutMilliseconds;
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    return Promise.resolve({
      status: 'error',
      message: policy.invalidTimeoutMessage,
      errorKind: 'configuration'
    });
  }
  return nodeHttpJsonRequest(
    backendUrl,
    requestPath,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Encoding': 'identity',
        [DEVMATE_BACKEND_TOKEN_HEADER]: backendToken,
        ...(providerApiKey ? { [PROVIDER_KEY_HEADER]: providerApiKey } : {})
      },
      body: JSON.stringify(request)
    },
    decodeData,
    timeoutMilliseconds,
    signal
  );
}

export async function ask(
  backendUrl: string,
  askRequest: AskRequest,
  secrets: BackendRequestSecrets,
  timeoutMilliseconds = DEFAULT_ASK_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<ApiResult<AskResponse>> {
  if (!isValidBackendToken(secrets.backendToken)) {
    return backendAuthenticationUnavailable();
  }
  const providerApiKey = secrets.providerApiKey;
  if (providerApiKey && !isLoopbackBackendUrl(backendUrl)) {
    return {
      status: 'error',
      message: 'DevMate only sends provider API keys to a backend running on this computer.',
      errorKind: 'configuration'
    };
  }

  return nodeHttpJsonRequest(
    backendUrl,
    '/ask',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Encoding': 'identity',
        [DEVMATE_BACKEND_TOKEN_HEADER]: secrets.backendToken,
        ...(providerApiKey ? { [PROVIDER_KEY_HEADER]: providerApiKey } : {})
      },
      body: JSON.stringify(askRequest)
    },
    parseAskResponse,
    timeoutMilliseconds,
    signal
  );
}

export async function askStream(
  backendUrl: string,
  askRequest: AskRequest,
  secrets: BackendRequestSecrets,
  timeoutMilliseconds = DEFAULT_ASK_TIMEOUT_MS,
  signal?: AbortSignal,
  onEvent?: (event: AskStreamEvent) => void
): Promise<AskStreamResult> {
  if (!isValidBackendToken(secrets.backendToken)) {
    return {
      result: backendAuthenticationUnavailable(),
      unsupported: false
    };
  }
  const providerApiKey = secrets.providerApiKey;
  if (providerApiKey && !isLoopbackBackendUrl(backendUrl)) {
    return {
      result: {
        status: 'error',
        message: 'DevMate only sends provider API keys to a backend running on this computer.',
        errorKind: 'configuration'
      },
      unsupported: false
    };
  }
  return nodeHttpStreamRequest(
    backendUrl,
    '/ask/stream',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson',
        'Accept-Encoding': 'identity',
        [DEVMATE_BACKEND_TOKEN_HEADER]: secrets.backendToken,
        ...(providerApiKey ? { [PROVIDER_KEY_HEADER]: providerApiKey } : {})
      },
      body: JSON.stringify(askRequest)
    },
    timeoutMilliseconds,
    signal,
    onEvent
  );
}

function isValidBackendToken(value: string): boolean {
  return value.length >= MIN_BACKEND_TOKEN_CHARACTERS
    && value.length <= MAX_BACKEND_TOKEN_CHARACTERS;
}

function backendAuthenticationUnavailable<T>(): ApiResult<T> {
  return {
    status: 'error',
    message: 'No authenticated DevMate backend connection is available.',
    errorKind: 'configuration'
  };
}

export function isLoopbackBackendUrl(backendUrl: string): boolean {
  try {
    const url = new URL(backendUrl);
    const hostname = url.hostname.toLocaleLowerCase();
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username
      && !url.password
      && (
        hostname === 'localhost'
        || hostname === '[::1]'
        || hostname === '::1'
        || isLoopbackIpv4(hostname)
      );
  } catch {
    return false;
  }
}

function isLoopbackIpv4(hostname: string): boolean {
  const parts = hostname.split('.');
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
