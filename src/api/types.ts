import type { EmbeddingProviderName } from '../embeddingProfiles';

export type AssistantMode = 'ideas' | 'code' | 'debug';
export type ScopeType = 'project' | 'file' | 'selection';
export type ContextSource = 'file' | 'selection' | 'attachment';
export type ApiStatus = 'ok' | 'error';
export type BackendState = 'online' | 'offline' | 'mock';
export const DEVMATE_BACKEND_SERVICE = 'devmate-backend';
export const DEVMATE_BACKEND_PROTOCOL_VERSION = 2;
export const DEVMATE_BACKEND_CAPABILITIES = [
  'chat',
  'streaming',
  'request-authentication',
  'strict-response-contracts',
  'knowledge-index-v1',
  'embedding-index-v1',
  'semantic-search-v1',
  'chat-memory-v1'
] as const;
export const DEVMATE_REQUIRED_BACKEND_CAPABILITIES = [
  'chat',
  'streaming',
  'request-authentication',
  'strict-response-contracts',
  'knowledge-index-v1'
] as const;
export const DEVMATE_BACKEND_ERROR_CODES = [
  'backend_authentication_failed',
  'request_validation_failed',
  'route_unavailable',
  'provider_configuration',
  'provider_authentication_failed',
  'provider_not_found',
  'provider_rate_limited',
  'provider_timeout',
  'provider_unavailable',
  'provider_invalid_response',
  'model_invalid_response',
  'knowledge_store_unavailable',
  'knowledge_workspace_not_found',
  'knowledge_index_failure',
  'chat_session_not_found',
  'chat_memory_failure',
  'internal_error'
] as const;
export const DEVMATE_BACKEND_TOKEN_HEADER = 'X-DevMate-Backend-Token';
export const DEVMATE_BACKEND_TOKEN_ENVIRONMENT_VARIABLE = 'DEVMATE_BACKEND_TOKEN';
export const DEVMATE_KNOWLEDGE_STORE_PATH_ENVIRONMENT_VARIABLE =
  'DEVMATE_KNOWLEDGE_STORE_PATH';
export const DEVMATE_KNOWLEDGE_STORE_FILE_NAME = 'devmate-knowledge.sqlite3';
export const MIN_BACKEND_TOKEN_CHARACTERS = 32;
export const MAX_BACKEND_TOKEN_CHARACTERS = 512;
export const DEVMATE_KNOWLEDGE_INDEX_API_VERSION = 1;
export const DEVMATE_CHAT_MEMORY_API_VERSION = 1;
export const MAX_WORKSPACE_KEY_CHARACTERS = 256;
export const MAX_WORKSPACE_ROOT_CHARACTERS = 4_096;
export const MAX_RELATIVE_PATH_CHARACTERS = 1_024;
export const MAX_LANGUAGE_ID_CHARACTERS = 128;
export const MAX_CONTENT_HASH_CHARACTERS = 256;
export const MAX_CHUNK_STABLE_ID_CHARACTERS = 1_280;
export const MAX_CHUNK_CHARACTERS = 20_000;
export const MAX_CHUNKS_PER_FILE = 512;
export const MAX_FILE_CHANGES_PER_BATCH = 500;
export const MAX_INDEX_BATCH_CONTENT_CHARACTERS = 4_000_000;
export const MAX_LEXICAL_QUERY_CHARACTERS = 2_000;
export const MAX_LEXICAL_QUERY_TERMS = 32;
export const MAX_LEXICAL_RESULTS = 100;
export const MAX_SEMANTIC_QUERY_CHARACTERS = 2_000;
export const MAX_SEMANTIC_RESULTS = 100;
export const MAX_EMBEDDING_PROFILE_ID_CHARACTERS = 120;
export const MAX_EMBEDDING_MODEL_CHARACTERS = 120;
export const MAX_EMBEDDING_DIMENSIONS = 16_384;
export const MAX_EMBEDDING_BATCH_SIZE = 64;
export const MAX_EMBEDDING_BASE_URL_CHARACTERS = 2_048;
export const MAX_EMBEDDING_API_KEY_CHARACTERS = 8_192;
export const MAX_EMBEDDING_INDEX_BATCHES_PER_RUN = 16;
export const MAX_INDEX_INTEGER = 9_007_199_254_740_991;
export const MAX_CHAT_SESSION_ID_CHARACTERS = 120;
export const MAX_CHAT_WORKSPACE_IDENTITY_CHARACTERS = 2_048;
export const MAX_CHAT_WORKSPACE_NAME_CHARACTERS = 120;
export const MAX_CHAT_SESSION_TITLE_CHARACTERS = 80;
export const MAX_CHAT_TURN_CHARACTERS = 6_000;
export const MAX_CHAT_FILE_CHANGES = 20;
export const MAX_CHAT_FILE_CHANGE_PATH_CHARACTERS = 2_048;
export const MAX_CHAT_DIFF_ID_CHARACTERS = 120;
export const MAX_CHAT_TURNS_PER_SNAPSHOT = 1_000;
export const MAX_CHAT_SESSIONS_PER_REQUEST = 20;
export const MAX_CHAT_SESSIONS_RETURNED = 100;
export const MAX_CHAT_SUMMARY_CHARACTERS = 32_000;
export const MAX_CHAT_SUMMARY_ITEMS = 50;
export const MAX_CHAT_SUMMARY_ITEM_CHARACTERS = 1_000;
export const MAX_CHAT_INTEGER = 9_007_199_254_740_991;
export const CHAT_SUMMARY_VERSION = 1;
export type ApiErrorKind =
  | 'cancelled'
  | 'configuration'
  | 'http'
  | 'invalid-response'
  | 'network'
  | 'timeout';
export type BackendErrorCode = typeof DEVMATE_BACKEND_ERROR_CODES[number];

export type ApiResult<T> = {
  status: ApiStatus;
  data?: T;
  message?: string;
  statusCode?: number;
  errorKind?: ApiErrorKind;
  errorCode?: BackendErrorCode;
};

export type HealthResponse = {
  service: typeof DEVMATE_BACKEND_SERVICE;
  protocolVersion: typeof DEVMATE_BACKEND_PROTOCOL_VERSION;
  capabilities: string[];
  backend: 'online';
  version: string;
};

export type KnowledgeIndexState = 'empty' | 'indexing' | 'ready' | 'stale' | 'failed';

export type KnowledgeIndexChunkInput = {
  stableId: string;
  ordinal: number;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  chunkingVersion: number;
};

export type KnowledgeIndexFileInput = {
  relativePath: string;
  languageId: string;
  contentHash: string;
  sizeBytes: number;
  modifiedAt: number;
  chunks: KnowledgeIndexChunkInput[];
};

export type KnowledgeIndexMetadata = {
  workspaceKey: string;
  chunkingVersion: number;
  indexState: KnowledgeIndexState;
  lastFullScanAt: string | null;
};

export type KnowledgeIndexFileFingerprint = {
  relativePath: string;
  contentHash: string;
  sizeBytes: number;
  modifiedAt: number;
};

export type KnowledgeIndexOpenRequest = {
  workspaceKey: string;
  rootPath: string;
  chunkingVersion: number;
};

export type KnowledgeIndexOpenResponse = {
  workspace: {
    id: number;
    workspaceKey: string;
    rootPath: string;
  };
  metadata: KnowledgeIndexMetadata;
  files: KnowledgeIndexFileFingerprint[];
};

export type KnowledgeIndexApplyRequest = {
  workspaceKey: string;
  upserts: KnowledgeIndexFileInput[];
  deletedPaths: string[];
};

export type KnowledgeIndexWriteResponse = {
  upsertedFiles: number;
  deletedFiles: number;
};

export type KnowledgeIndexMetadataUpdateRequest = {
  workspaceKey: string;
  chunkingVersion: number;
  indexState: KnowledgeIndexState;
  lastFullScanAt: string | null;
};

export type KnowledgeIndexSearchRequest = {
  workspaceKey: string;
  query: string;
  limit: number;
};

export type KnowledgeIndexSearchItem = {
  relativePath: string;
  languageId: string;
  stableId: string;
  ordinal: number;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  score: number;
};

export type KnowledgeIndexSearchResponse = {
  results: KnowledgeIndexSearchItem[];
};

export type KnowledgeIndexEmbeddingRequest = {
  workspaceKey: string;
  profileId: string;
  provider: EmbeddingProviderName;
  model: string;
  baseUrl: string;
  remoteAllowed: boolean;
  vectorVersion: number;
  batchSize: number;
  maxBatches: number;
};

export type KnowledgeIndexEmbeddingConfiguration = {
  profileId: string;
  provider: EmbeddingProviderName;
  model: string;
  dimensions: number;
  vectorVersion: number;
};

export type KnowledgeIndexEmbeddingResponse = {
  configuration: KnowledgeIndexEmbeddingConfiguration | null;
  embeddedChunks: number;
  processedBatches: number;
  complete: boolean;
};

export type KnowledgeIndexSemanticSearchRequest = {
  workspaceKey: string;
  query: string;
  profileId: string;
  provider: EmbeddingProviderName;
  model: string;
  baseUrl: string;
  remoteAllowed: boolean;
  vectorVersion: number;
  limit: number;
};

export type KnowledgeIndexSemanticSearchResponse = {
  configuration: KnowledgeIndexEmbeddingConfiguration | null;
  results: KnowledgeIndexSearchItem[];
};

export type ChatMemoryFileChangeKind =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'renamed'
  | 'moved';

export type ChatMemoryFileChange = {
  kind: ChatMemoryFileChangeKind;
  path: string;
  previousPath?: string;
  diffId?: string;
};

export type ChatMemoryTurn = {
  ordinal: number;
  user: string;
  assistant: string;
  fileChanges: ChatMemoryFileChange[];
};

export type ChatMemorySession = {
  sessionId: string;
  workspaceIdentity: string;
  workspaceName: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type ChatMemorySnapshot = {
  session: ChatMemorySession;
  turns: ChatMemoryTurn[];
};

export type ChatMemorySaveRequest = {
  sessions: ChatMemorySnapshot[];
};

export type ChatMemorySaveResponse = {
  savedSessionIds: string[];
};

export type ChatMemorySessionRequest = {
  sessionId: string;
};

export type ChatMemoryLoadResponse = {
  session: ChatMemorySnapshot;
};

export type ChatMemoryListRequest = {
  workspaceIdentity: string;
  limit: number;
};

export type ChatMemoryListResponse = {
  sessions: ChatMemorySession[];
};

export type ChatMemoryDeleteResponse = {
  deleted: boolean;
};

export type ChatMemorySummaryDecision = {
  decision: string;
  reason: string;
};

export type ChatMemorySummaryContent = {
  goal: string;
  constraints: string[];
  decisions: ChatMemorySummaryDecision[];
  importantFiles: string[];
  completedWork: string[];
  openTasks: string[];
  unresolvedQuestions: string[];
};

export type ChatMemorySummary = {
  sessionId: string;
  summaryVersion: typeof CHAT_SUMMARY_VERSION;
  content: ChatMemorySummaryContent;
  lastCompactedTurn: number;
  createdAtMs: number;
  updatedAtMs: number;
};

export type ChatMemorySummarySaveRequest = {
  sessionId: string;
  content: ChatMemorySummaryContent;
  lastCompactedTurn: number;
  updatedAtMs: number;
};

export type ChatMemorySummarySaveResponse = {
  summary: ChatMemorySummary;
};

export type ChatMemorySummaryLoadResponse = {
  summary: ChatMemorySummary | null;
};

export type ChatMemorySummaryClearResponse = {
  cleared: boolean;
};

export type ChatMemoryCompactionRequest = {
  sessionId: string;
  throughTurn: number;
  settings: LlmSettings;
};

export type ChatMemoryCompactionResponse = {
  summary: ChatMemorySummary;
  compactedTurns: number;
};

export type LlmSettings = {
  provider: string;
  model: string;
  baseUrl?: string;
  maxTokens: number;
  temperature: number;
  reasoningEffort: ReasoningEffort;
  timeoutSeconds: number;
};

export type AskContextItem = {
  source: ContextSource;
  filePath: string;
  languageId: string;
  content: string;
  includedCharacters: number;
  totalCharacters: number;
  truncated: boolean;
};

export type AskScope = {
  type: ScopeType;
  workspacePath?: string;
  items: AskContextItem[];
};

export type AskRequest = {
  question: string;
  mode: AssistantMode;
  scope: AskScope;
  settings: LlmSettings;
  enabledTools?: AgentToolName[];
  toolsEnabled?: boolean;
  agentEditsEnabled?: boolean;
  forceFinalAnswer?: boolean;
  disableThinking?: boolean;
  toolHistory?: AgentToolStep[];
  conversationHistory?: ConversationTurn[];
};

export type ConversationTurn = {
  user: string;
  assistant: string;
};

export type AskResponse = {
  answer: string;
  usedFiles: string[];
  changes: FileChange[];
  toolCalls: AgentToolCall[];
  tokenUsage?: TokenUsage;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  exact: boolean;
};

export type AgentToolStep = {
  callId: string;
  name: AgentToolName;
  arguments: Record<string, unknown>;
  result: string;
  isError: boolean;
};

export type FileChange = {
  path: string;
  content: string;
};
import type { AgentToolCall, AgentToolName } from '../agentTools';
import type { ReasoningEffort } from '../llmProfiles';
