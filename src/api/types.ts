export type AssistantMode = 'ideas' | 'code' | 'debug';
export type ScopeType = 'project' | 'file' | 'selection';
export type ApiStatus = 'ok' | 'error';
export type BackendState = 'online' | 'offline' | 'mock';

export type ApiResult<T> = {
  status: ApiStatus;
  data?: T;
  message?: string;
};

export type HealthResponse = {
  backend: BackendState;
  version?: string;
};

export type LlmSettings = {
  provider: string;
  model: string;
  maxTokens: number;
  temperature: number;
};

export type AskScope = {
  type: ScopeType;
  workspacePath?: string;
  filePath?: string;
  selectedText?: string;
  selectedCharacters?: number;
};

export type AskRequest = {
  question: string;
  mode: AssistantMode;
  scope: AskScope;
  settings: LlmSettings;
};

export type AskResponse = {
  answer: string;
  usedFiles: string[];
};
