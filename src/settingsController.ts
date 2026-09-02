import {
  boundedAgentToolCallLimit,
  MAX_AGENT_TOOL_CALL_LIMIT,
  MIN_AGENT_TOOL_CALL_LIMIT,
  normalizeAgentToolSettings
} from './agentTools';
import type { AgentToolSettings } from './agentTools';
import {
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  MAX_COMMAND_TIMEOUT_SECONDS,
  MIN_COMMAND_TIMEOUT_SECONDS
} from './commandTools';
import {
  AUTO_MAX_INPUT_CONTEXT_TOKENS,
  isValidMaxInputContextTokens,
  normalizeMaxInputContextTokens
} from './contextPlanner';
import {
  FILE_PERMISSION_POLICY_STORAGE_KEY,
  parseFilePermissionPolicy
} from './permissions';
import type { FilePermissionPolicy } from './permissions';

export type DevMateSettingsSubmission = {
  timeoutSeconds: number;
  commandTimeoutSeconds: number;
  toolCallLimit: number;
  maxTokens: number;
  maxInputContextTokens: number;
  temperature: number;
  policy: FilePermissionPolicy;
};

export type AgentToolSettingsSubmission = AgentToolSettings;

export type DevMateConfigurationState = {
  timeoutSeconds: number;
  commandTimeoutSeconds: number;
  toolCallLimit: number;
  maxTokens: number;
  maxInputContextTokens: number;
  temperature: number;
  agentTools: AgentToolSettings;
};

export type SettingsSaveResult =
  | { ok: true }
  | { ok: false; message: string; level: 'warning' | 'error' };

export interface SettingsPersistence {
  readConfiguration(key: string): unknown;
  writeConfiguration(key: string, value: unknown): PromiseLike<void>;
  writeWorkspaceState(key: string, value: unknown): PromiseLike<void>;
}

// This controller handles saved configuration values without knowing about VS Code or the UI.
export class SettingsController {
  constructor(private readonly persistence: SettingsPersistence) {}

  state(): DevMateConfigurationState {
    return {
      timeoutSeconds: boundedNumber(
        this.persistence.readConfiguration('requestTimeoutSeconds'),
        900,
        10,
        1800
      ),
      commandTimeoutSeconds: boundedNumber(
        this.persistence.readConfiguration('commandTimeoutSeconds'),
        DEFAULT_COMMAND_TIMEOUT_SECONDS,
        MIN_COMMAND_TIMEOUT_SECONDS,
        MAX_COMMAND_TIMEOUT_SECONDS
      ),
      toolCallLimit: boundedAgentToolCallLimit(
        this.persistence.readConfiguration('toolCallLimit')
      ),
      maxTokens: boundedNumber(
        this.persistence.readConfiguration('maxTokens'),
        16_384,
        128,
        32_000
      ),
      maxInputContextTokens: normalizeMaxInputContextTokens(
        this.persistence.readConfiguration('maxInputContextTokens')
          ?? AUTO_MAX_INPUT_CONTEXT_TOKENS
      ),
      temperature: boundedNumber(
        this.persistence.readConfiguration('temperature'),
        0.2,
        0,
        2
      ),
      agentTools: this.agentToolSettings()
    };
  }

  agentToolSettings(): AgentToolSettings {
    return normalizeAgentToolSettings({
      readFileMaxLines: optionalNumber(
        this.persistence.readConfiguration('readFileMaxLines')
      ),
      listFilesMaxResults: optionalNumber(
        this.persistence.readConfiguration('listFilesMaxResults')
      ),
      searchCodeMaxResults: optionalNumber(
        this.persistence.readConfiguration('searchCodeMaxResults')
      ),
      diagnosticsMaxResults: optionalNumber(
        this.persistence.readConfiguration('diagnosticsMaxResults')
      ),
      terminalErrorsMaxResults: optionalNumber(
        this.persistence.readConfiguration('terminalErrorsMaxResults')
      ),
      codeNavigationMaxResults: optionalNumber(
        this.persistence.readConfiguration('codeNavigationMaxResults')
      )
    });
  }

  async save(settings: DevMateSettingsSubmission): Promise<SettingsSaveResult> {
    if (!isValidSettings(settings)) {
      return {
        ok: false,
        message: 'The settings contain an invalid value.',
        level: 'warning'
      };
    }

    // Permission choices belong to the workspace. The remaining values are global preferences.
    const normalizedPolicy = parseFilePermissionPolicy(settings.policy);
    try {
      await Promise.all([
        this.persistence.writeConfiguration('requestTimeoutSeconds', settings.timeoutSeconds),
        this.persistence.writeConfiguration(
          'commandTimeoutSeconds',
          settings.commandTimeoutSeconds
        ),
        this.persistence.writeConfiguration('toolCallLimit', settings.toolCallLimit),
        this.persistence.writeConfiguration('maxTokens', settings.maxTokens),
        this.persistence.writeConfiguration(
          'maxInputContextTokens',
          settings.maxInputContextTokens
        ),
        this.persistence.writeConfiguration('temperature', settings.temperature),
        this.persistence.writeWorkspaceState(
          FILE_PERMISSION_POLICY_STORAGE_KEY,
          normalizedPolicy
        )
      ]);
      return { ok: true };
    } catch {
      return {
        ok: false,
        message: 'DevMate could not save the settings.',
        level: 'error'
      };
    }
  }

  async saveAgentToolSettings(
    settings: AgentToolSettingsSubmission
  ): Promise<SettingsSaveResult> {
    const normalized = normalizeAgentToolSettings(settings);
    const changedByNormalization = Object.entries(normalized).some(
      ([key, value]) => settings[key as keyof AgentToolSettings] !== value
    );
    if (changedByNormalization) {
      return {
        ok: false,
        message: 'The agent-tool settings contain an invalid value.',
        level: 'warning'
      };
    }

    try {
      await Promise.all([
        this.persistence.writeConfiguration('readFileMaxLines', normalized.readFileMaxLines),
        this.persistence.writeConfiguration('listFilesMaxResults', normalized.listFilesMaxResults),
        this.persistence.writeConfiguration('searchCodeMaxResults', normalized.searchCodeMaxResults),
        this.persistence.writeConfiguration('diagnosticsMaxResults', normalized.diagnosticsMaxResults),
        this.persistence.writeConfiguration(
          'terminalErrorsMaxResults',
          normalized.terminalErrorsMaxResults
        ),
        this.persistence.writeConfiguration(
          'codeNavigationMaxResults',
          normalized.codeNavigationMaxResults
        )
      ]);
      return { ok: true };
    } catch {
      return {
        ok: false,
        message: 'DevMate could not save the agent-tool settings.',
        level: 'error'
      };
    }
  }
}

function isValidSettings(settings: DevMateSettingsSubmission): boolean {
  return Number.isInteger(settings.timeoutSeconds)
    && settings.timeoutSeconds >= 10
    && settings.timeoutSeconds <= 1800
    && Number.isInteger(settings.commandTimeoutSeconds)
    && settings.commandTimeoutSeconds >= MIN_COMMAND_TIMEOUT_SECONDS
    && settings.commandTimeoutSeconds <= MAX_COMMAND_TIMEOUT_SECONDS
    && Number.isInteger(settings.toolCallLimit)
    && settings.toolCallLimit >= MIN_AGENT_TOOL_CALL_LIMIT
    && settings.toolCallLimit <= MAX_AGENT_TOOL_CALL_LIMIT
    && Number.isInteger(settings.maxTokens)
    && settings.maxTokens >= 128
    && settings.maxTokens <= 32_000
    && isValidMaxInputContextTokens(settings.maxInputContextTokens)
    && Number.isFinite(settings.temperature)
    && settings.temperature >= 0
    && settings.temperature <= 2;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
