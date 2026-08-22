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
  'strict-response-contracts'
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
  'internal_error'
] as const;
export const DEVMATE_BACKEND_TOKEN_HEADER = 'X-DevMate-Backend-Token';
export const DEVMATE_BACKEND_TOKEN_ENVIRONMENT_VARIABLE = 'DEVMATE_BACKEND_TOKEN';
export const DEVMATE_KNOWLEDGE_STORE_PATH_ENVIRONMENT_VARIABLE =
  'DEVMATE_KNOWLEDGE_STORE_PATH';
export const DEVMATE_KNOWLEDGE_STORE_FILE_NAME = 'devmate-knowledge.sqlite3';
export const MIN_BACKEND_TOKEN_CHARACTERS = 32;
export const MAX_BACKEND_TOKEN_CHARACTERS = 512;
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
