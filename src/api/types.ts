export type AssistantMode = 'ideas' | 'code' | 'debug';
export type ScopeType = 'project' | 'file' | 'selection';
export type ContextSource = 'file' | 'selection' | 'attachment';
export type ApiStatus = 'ok' | 'error';
export type BackendState = 'online' | 'offline' | 'mock';
export type ApiErrorKind =
  | 'cancelled'
  | 'configuration'
  | 'http'
  | 'invalid-response'
  | 'network'
  | 'timeout';

export type ApiResult<T> = {
  status: ApiStatus;
  data?: T;
  message?: string;
  statusCode?: number;
  errorKind?: ApiErrorKind;
};

export type HealthResponse = {
  backend: BackendState;
  version?: string;
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
