// Define messages crossing the browser/extension boundary.
// Incoming values need runtime validation even though outgoing messages are typed.

import type { AssistantMode, TokenUsage } from '../api/types';
import type { ManagedBackendStatus } from '../api/backendManager';
import type {
  EmbeddingProfileFormSubmission,
  EmbeddingProfileSummary
} from '../settings/embeddingProfileController';
import type { EmbeddingProfile } from '../settings/embeddingProfiles';
import type { FileChangeSummaryItem } from '../workspace/fileTools';
import type { LlmProfileFormSubmission } from '../settings/llmProfileController';
import type { LlmProvider, ReasoningEffort } from '../settings/llmProfiles';
import type {
  AgentToolSettingsSubmission,
  DevMateConfigurationState,
  DevMateSettingsSubmission
} from '../settings/settingsController';
import type {
  FilePermissionAction,
  FilePermissionPolicy,
  RememberedCommand
} from '../workspace/permissions';
import type { ScopeInfo, ScopeKind } from '../context/workspaceContext';

export type { LlmProfileFormSubmission } from '../settings/llmProfileController';
export type {
  AgentToolSettingsSubmission,
  DevMateSettingsSubmission
} from '../settings/settingsController';

export type AskWebviewMessage = {
  command: 'ask';
  mode: AssistantMode;
  question: string;
  scope: ScopeInfo;
  isNewTurn?: boolean;
};

export type WebviewMessage =
  | AskWebviewMessage
  | { command: 'continueAgentRun' }
  | { command: 'cancelRequest' }
  | { command: 'setScope'; scope: ScopeKind }
  | { command: 'pickFiles' }
  | { command: 'removeAttachment'; id: string }
  | { command: 'chooseLlmProfile' }
  | { command: 'selectLlmProfile'; profileId: string }
  | { command: 'setReasoningEffort'; effort: ReasoningEffort }
  | { command: 'addLlmProfile' }
  | { command: 'editLlmProfile'; profileId: string }
  | { command: 'deleteLlmProfile'; profileId: string }
  | { command: 'saveLlmProfile'; profile: LlmProfileFormSubmission }
  | { command: 'chooseEmbeddingProfile' }
  | { command: 'selectEmbeddingProfile'; profileId: string }
  | { command: 'addEmbeddingProfile' }
  | { command: 'editEmbeddingProfile'; profileId: string }
  | { command: 'deleteEmbeddingProfile'; profileId: string }
  | { command: 'saveEmbeddingProfile'; profile: EmbeddingProfileFormSubmission }
  | { command: 'saveSettings'; settings: DevMateSettingsSubmission }
  | { command: 'saveAgentToolSettings'; settings: AgentToolSettingsSubmission }
  | { command: 'reviewPermissionDiff'; requestId: string; path: string }
  | { command: 'revokeRememberedCommand'; signature: string }
  | { command: 'clearRememberedCommands' }
  | { command: 'restartBackend' }
  | { command: 'openBackendLogs' }
  | { command: 'newSession' }
  | { command: 'selectSession'; sessionId: string }
  | { command: 'renameSession'; sessionId: string }
  | { command: 'deleteSession'; sessionId: string }
  | { command: 'copyText'; text: string }
  | { command: 'openWorkspaceFile'; path: string; line?: number }
  | { command: 'openFileChangeDiff'; diffId: string; path: string }
  | { command: 'openExternalLink'; url: string }
  | {
      command: 'commandPermissionDecision';
      requestId: string;
      decision: PermissionDecision;
    }
  | { command: 'openCommandTerminal'; activityId: string }
  | {
      command: 'permissionDecision';
      requestId: string;
      decision: PermissionDecision;
    }
  | { command: 'ready' };

type WebviewSessionSummary = {
  id: string;
  title: string;
  workspaceName: string;
  belongsToCurrentWorkspace: boolean;
  updatedAt: number;
  turnCount: number;
};

type WebviewSessionMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; fileChanges: FileChangeSummaryItem[] };

type LlmProfilePickerItem = {
  id: string;
  name: string;
  providerLabel: string;
  model: string;
  baseUrl?: string;
  contextWindowTokens?: number;
  intelligence?: string;
  builtIn: boolean;
  selected: boolean;
};

type LlmProfileFormValue = {
  id: string;
  name: string;
  provider: LlmProvider;
  model: string;
  baseUrl?: string;
  contextWindowTokens?: number;
  builtIn: boolean;
};

type ActiveLlmProfileView = {
  id: string;
  name: string;
  provider: LlmProvider;
  providerLabel: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  reasoningEffortOptions: Array<{ value: ReasoningEffort; label: string }>;
};

type WebviewSettings = DevMateConfigurationState & {
  rememberedCommands: RememberedCommand[];
  workspaceTrusted: boolean;
};

type WebviewToolActivity = {
  id: string;
  title: string;
  detail: string;
  status: 'running' | 'completed' | 'error';
  result?: string;
  canOpenTerminal: boolean;
};

export type ExtensionToWebviewMessage =
  | { command: 'status'; text: string; level: 'info' | 'warning' | 'error' }
  | { command: 'scopeUpdated'; scope: ScopeInfo }
  | {
      command: 'assistantResponse';
      response: string;
      fileChanges: FileChangeSummaryItem[];
    }
  | {
      command: 'sessionsUpdated';
      activeSessionId: string;
      activeTitle: string;
      currentWorkspaceName: string;
      openChat: boolean;
      sessions: WebviewSessionSummary[];
      messages?: WebviewSessionMessage[];
    }
  | { command: 'sessionProjectWarning'; message: string }
  | { command: 'requestCancelling' }
  | { command: 'requestCancelled' }
  | { command: 'requestFailed'; message: string; retryable: boolean }
  | { command: 'attachmentsUpdated'; attachments: Array<{ id: string; label: string }> }
  | {
      command: 'llmProfilesUpdated';
      profileCount: number;
      activeProfile?: ActiveLlmProfileView;
    }
  | { command: 'showLlmProfilePicker'; profiles: LlmProfilePickerItem[] }
  | { command: 'showLlmProfileForm'; profile?: LlmProfileFormValue; hasApiKey: boolean }
  | { command: 'llmProfileFormError'; message: string }
  | { command: 'closeLlmProfileForm' }
  | {
      command: 'embeddingProfilesUpdated';
      profileCount: number;
      activeProfile?: EmbeddingProfile & { providerLabel: string };
    }
  | { command: 'showEmbeddingProfilePicker'; profiles: EmbeddingProfileSummary[] }
  | { command: 'showEmbeddingProfileForm'; profile?: EmbeddingProfile; hasApiKey: boolean }
  | { command: 'embeddingProfileFormError'; message: string }
  | { command: 'closeEmbeddingProfileForm' }
  | { command: 'permissionPolicyUpdated'; policy: FilePermissionPolicy }
  | { command: 'settingsUpdated'; settings: WebviewSettings }
  | { command: 'agentToolSettingsSaved' }
  | { command: 'settingsSaved' }
  | { command: 'backendStatusUpdated'; status: ManagedBackendStatus; label: string }
  | {
      command: 'permissionRequest';
      requestId: string;
      summary: string;
      rememberable: boolean;
      files: Array<{
        path: string;
        operation: FilePermissionAction;
        canReview: boolean;
      }>;
    }
  | {
      command: 'commandPermissionRequest';
      requestId: string;
      label: string;
      cwd: string;
      rememberable: boolean;
      title?: string;
      warning?: string;
    }
  | { command: 'agentToolActivity'; activity: WebviewToolActivity }
  | { command: 'providerStreamReset' }
  | { command: 'providerStreamDelta'; text: string }
  | { command: 'toolUsageUpdated'; used: number; limit: number }
  | { command: 'tokenUsageUpdated'; usage: TokenUsage }
  | {
      command: 'agentCheckpointUpdated';
      available: boolean;
      used: number;
      limit: number;
      tokenUsage?: TokenUsage;
    };

type PermissionDecision = 'deny' | 'allowOnce' | 'allowAlways';
type UnknownRecord = Record<string, unknown>;

const noPayloadCommands = new Set<WebviewMessage['command']>([
  'continueAgentRun',
  'cancelRequest',
  'pickFiles',
  'chooseLlmProfile',
  'addLlmProfile',
  'chooseEmbeddingProfile',
  'addEmbeddingProfile',
  'clearRememberedCommands',
  'restartBackend',
  'openBackendLogs',
  'newSession',
  'ready'
]);

// Webview messages cross a runtime boundary, so TypeScript types alone are not enough.
export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (!isRecord(value) || typeof value.command !== 'string') {
    return undefined;
  }

  const command = value.command as WebviewMessage['command'];
  if (noPayloadCommands.has(command)) {
    return hasOnlyKeys(value, ['command']) ? value as WebviewMessage : undefined;
  }

  switch (command) {
    case 'ask':
      return hasOnlyKeys(value, ['command', 'mode', 'question', 'scope', 'isNewTurn'])
        && isAssistantMode(value.mode)
        && typeof value.question === 'string'
        && isScopeInfo(value.scope)
        && isOptionalBoolean(value.isNewTurn)
        ? value as AskWebviewMessage
        : undefined;
    case 'setScope':
      return validMessage(value, ['command', 'scope'], isScopeKind(value.scope));
    case 'removeAttachment':
      return validMessage(value, ['command', 'id'], typeof value.id === 'string');
    case 'selectLlmProfile':
    case 'editLlmProfile':
    case 'deleteLlmProfile':
    case 'selectEmbeddingProfile':
    case 'editEmbeddingProfile':
    case 'deleteEmbeddingProfile':
      return validMessage(
        value,
        ['command', 'profileId'],
        typeof value.profileId === 'string'
      );
    case 'setReasoningEffort':
      return validMessage(
        value,
        ['command', 'effort'],
        isReasoningEffort(value.effort)
      );
    case 'saveLlmProfile':
      return validMessage(
        value,
        ['command', 'profile'],
        isLlmProfileSubmission(value.profile)
      );
    case 'saveEmbeddingProfile':
      return validMessage(
        value,
        ['command', 'profile'],
        isEmbeddingProfileSubmission(value.profile)
      );
    case 'saveSettings':
      return validMessage(
        value,
        ['command', 'settings'],
        isDevMateSettingsSubmission(value.settings)
      );
    case 'saveAgentToolSettings':
      return validMessage(
        value,
        ['command', 'settings'],
        isAgentToolSettingsSubmission(value.settings)
      );
    case 'reviewPermissionDiff':
      return validMessage(
        value,
        ['command', 'requestId', 'path'],
        typeof value.requestId === 'string' && typeof value.path === 'string'
      );
    case 'revokeRememberedCommand':
      return validMessage(
        value,
        ['command', 'signature'],
        typeof value.signature === 'string'
      );
    case 'selectSession':
    case 'renameSession':
    case 'deleteSession':
      return validMessage(
        value,
        ['command', 'sessionId'],
        typeof value.sessionId === 'string'
      );
    case 'copyText':
      return validMessage(value, ['command', 'text'], typeof value.text === 'string');
    case 'openWorkspaceFile':
      return validMessage(
        value,
        ['command', 'path', 'line'],
        typeof value.path === 'string' && isOptionalFiniteNumber(value.line)
      );
    case 'openFileChangeDiff':
      return validMessage(
        value,
        ['command', 'diffId', 'path'],
        typeof value.diffId === 'string' && typeof value.path === 'string'
      );
    case 'openExternalLink':
      return validMessage(value, ['command', 'url'], typeof value.url === 'string');
    case 'commandPermissionDecision':
    case 'permissionDecision':
      return validMessage(
        value,
        ['command', 'requestId', 'decision'],
        typeof value.requestId === 'string' && isPermissionDecision(value.decision)
      );
    case 'openCommandTerminal':
      return validMessage(
        value,
        ['command', 'activityId'],
        typeof value.activityId === 'string'
      );
    default:
      return undefined;
  }
}

function validMessage(
  value: UnknownRecord,
  allowedKeys: readonly string[],
  fieldsAreValid: boolean
): WebviewMessage | undefined {
  return fieldsAreValid && hasOnlyKeys(value, allowedKeys)
    ? value as WebviewMessage
    : undefined;
}

function isScopeInfo(value: unknown): value is ScopeInfo {
  return isRecord(value)
    && hasOnlyKeys(value, ['kind', 'label', 'detail'])
    && isScopeKind(value.kind)
    && typeof value.label === 'string'
    && typeof value.detail === 'string';
}

function isLlmProfileSubmission(value: unknown): value is LlmProfileFormSubmission {
  return isRecord(value)
    && hasOnlyKeys(value, [
      'id',
      'name',
      'provider',
      'model',
      'baseUrl',
      'contextWindowTokens',
      'apiKey'
    ])
    && isOptionalString(value.id)
    && typeof value.name === 'string'
    && (value.provider === 'openai' || value.provider === 'ollama')
    && typeof value.model === 'string'
    && isOptionalString(value.baseUrl)
    && isOptionalFiniteNumber(value.contextWindowTokens)
    && isOptionalString(value.apiKey);
}

function isEmbeddingProfileSubmission(
  value: unknown
): value is EmbeddingProfileFormSubmission {
  return isRecord(value)
    && hasOnlyKeys(value, [
      'id',
      'provider',
      'model',
      'baseUrl',
      'remoteAllowed',
      'apiKey'
    ])
    && isOptionalString(value.id)
    && (value.provider === 'ollama' || value.provider === 'openai-compatible')
    && typeof value.model === 'string'
    && typeof value.baseUrl === 'string'
    && typeof value.remoteAllowed === 'boolean'
    && isOptionalString(value.apiKey);
}

function isDevMateSettingsSubmission(value: unknown): value is DevMateSettingsSubmission {
  return isRecord(value)
    && hasOnlyKeys(value, [
      'timeoutSeconds',
      'commandTimeoutSeconds',
      'toolCallLimit',
      'maxTokens',
      'maxInputContextTokens',
      'temperature',
      'policy'
    ])
    && isFiniteNumber(value.timeoutSeconds)
    && isFiniteNumber(value.commandTimeoutSeconds)
    && isFiniteNumber(value.toolCallLimit)
    && isFiniteNumber(value.maxTokens)
    && isFiniteNumber(value.maxInputContextTokens)
    && isFiniteNumber(value.temperature)
    && isFilePermissionPolicy(value.policy);
}

function isAgentToolSettingsSubmission(value: unknown): value is AgentToolSettingsSubmission {
  return isRecord(value)
    && hasOnlyKeys(value, [
      'readFileMaxLines',
      'listFilesMaxResults',
      'searchCodeMaxResults',
      'diagnosticsMaxResults',
      'terminalErrorsMaxResults',
      'codeNavigationMaxResults'
    ])
    && isFiniteNumber(value.readFileMaxLines)
    && isFiniteNumber(value.listFilesMaxResults)
    && isFiniteNumber(value.searchCodeMaxResults)
    && isFiniteNumber(value.diagnosticsMaxResults)
    && isFiniteNumber(value.terminalErrorsMaxResults)
    && isFiniteNumber(value.codeNavigationMaxResults);
}

function isFilePermissionPolicy(value: unknown): value is FilePermissionPolicy {
  return isRecord(value)
    && hasOnlyKeys(value, ['createFiles', 'updateFiles'])
    && (value.createFiles === 'ask' || value.createFiles === 'allow')
    && (value.updateFiles === 'ask' || value.updateFiles === 'allow');
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isAssistantMode(value: unknown): value is AssistantMode {
  return value === 'ideas' || value === 'code' || value === 'debug';
}

function isScopeKind(value: unknown): value is ScopeKind {
  return value === 'project' || value === 'activeFile' || value === 'selection';
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === 'auto'
    || value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'xhigh';
}

function isPermissionDecision(value: unknown): value is PermissionDecision {
  return value === 'deny' || value === 'allowOnce' || value === 'allowAlways';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}
