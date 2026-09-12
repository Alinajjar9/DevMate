/** Persists scoped non-secret preferences; reasoning belongs to the selected model. */
import * as vscode from 'vscode';
import { AGENT_TOOL_NAMES } from './agentTools';
import {
  normalizeAgentConfiguration, parseConfigurationOverrides, validateConfigurationOverrides,
  CONFIGURATION_NUMBER_LIMITS
} from './configuration';
import type { AgentConfiguration, ConfigurationScope } from './configuration';
import type { LlmProfile, ReasoningEffort } from './llmProfiles';

const legacyKeys = {
  maxTokens: 'maxTokens', temperature: 'temperature', timeoutSeconds: 'requestTimeoutSeconds',
  commandTimeoutSeconds: 'commandTimeoutSeconds', toolCallLimit: 'toolCallLimit'
} as const;

export interface ConfigurationEvents {
  postMessage(message: unknown): void;
  getActiveProfile(): LlmProfile | undefined;
  getReasoningPreferences(): Record<string, ReasoningEffort>;
  changed(): Promise<void>;
}

export class ConfigurationManager {
  scope: ConfigurationScope = 'global';
  constructor(private readonly context: vscode.ExtensionContext, private readonly events: ConfigurationEvents) {}

  /** Include explicit older numeric settings so editing a different field never loses them. */
  get overrides(): Partial<AgentConfiguration> {
    return this.scopeOverrides(this.scope);
  }

  base(scope: ConfigurationScope = 'workspace'): AgentConfiguration {
    const config = vscode.workspace.getConfiguration('devMate');
    const defaults: Record<string, unknown> = {};
    for (const [key, setting] of Object.entries(legacyKeys)) {
      defaults[key] = recoverLegacyNumber(key, config.inspect(setting)?.defaultValue);
    }
    return normalizeAgentConfiguration({ ...parseConfigurationOverrides(defaults),
      ...this.scopeOverrides('global'),
      ...(scope === 'workspace' ? this.scopeOverrides('workspace') : {}) });
  }

  effective(profile = this.events.getActiveProfile()): AgentConfiguration {
    const preferred = profile && this.events.getReasoningPreferences()[profile.id];
    return normalizeAgentConfiguration({ ...this.base(), ...profile?.settings,
      reasoningEffort: preferred ?? profile?.settings?.reasoningEffort ?? 'auto' });
  }

  postState(): void {
    this.events.postMessage({ command: 'configurationState', scope: this.scope,
      workspaceAvailable: Boolean(vscode.workspace.workspaceFolders?.length),
      configuration: this.base(this.scope), overrides: this.overrides,
      inheritedConfiguration: this.scope === 'workspace' ? this.base('global') : normalizeAgentConfiguration({}),
      effectiveConfiguration: this.effective(), toolNames: [...AGENT_TOOL_NAMES] });
  }

  /** Removing saved presets must never affect unrelated model profiles, permissions or checkpoints. */
  async cleanupRemovedFeatures(): Promise<void> {
    for (const [storage, key] of [
      [this.context.globalState, 'devMate.activePreset.v1'],
      [this.context.workspaceState, 'devMate.activePreset.v1'],
      [this.context.globalState, 'devMate.agentPresets.v1'],
      [this.context.globalState, 'devMate.promptTemplates.v1']
    ] as const) {
      if (storage.get(key) !== undefined) await storage.update(key, undefined);
    }
    // Remove only the retired generic reasoning field so settings.json matches the new schema.
    const config = vscode.workspace.getConfiguration('devMate');
    const inspected = config.inspect('configuration');
    for (const [value, target] of [
      [inspected?.globalValue, vscode.ConfigurationTarget.Global],
      [inspected?.workspaceValue, vscode.ConfigurationTarget.Workspace]
    ] as const) {
      if (target === vscode.ConfigurationTarget.Workspace && !vscode.workspace.workspaceFolders?.length) continue;
      if (value && typeof value === 'object' && !Array.isArray(value)
        && Object.prototype.hasOwnProperty.call(value, 'reasoningEffort')) {
        await config.update('configuration', withoutGenericReasoning(value), target);
      }
    }
  }

  async saveConfiguration(scope: ConfigurationScope, value: unknown): Promise<void> {
    this.requireScope(scope);
    // Older settings screens may send this removed field; it never becomes a generic override again.
    const scopedValue = withoutGenericReasoning(value);
    const error = validateConfigurationOverrides(scopedValue);
    if (error) throw new Error(error);
    const config = vscode.workspace.getConfiguration('devMate');
    const target = scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update('configuration', parseConfigurationOverrides(scopedValue), target);
    // Write the complete desired override set first. Clearing legacy fields then restores honest inheritance.
    for (const setting of Object.values(legacyKeys)) {
      const previous = config.inspect(setting);
      const explicitValue = scope === 'workspace' ? previous?.workspaceValue : previous?.globalValue;
      if (explicitValue !== undefined) await config.update(setting, undefined, target);
    }
    this.scope = scope;
  }

  /** The old internal settings messages remain; removed preset/template/import/export messages are unsupported. */
  async handle(message: { command: string; [key: string]: unknown }): Promise<boolean> {
    if (!configurationCommands.has(message.command)) return false;
    try {
      switch (message.command) {
        case 'setConfigurationScope':
          this.requireScope(message.scope);
          this.scope = message.scope;
          break;
        case 'openConfiguration': break;
        case 'saveConfiguration':
          this.requireScope(message.scope);
          await this.saveConfiguration(message.scope, message.configuration);
          this.events.postMessage({ command: 'configurationSaved' });
          break;
      }
      await this.events.changed();
      this.postState();
    } catch (error) {
      this.events.postMessage({ command: 'configurationError', message: error instanceof Error ? error.message : 'Could not update configuration.' });
    }
    return true;
  }

  private scopeOverrides(scope: ConfigurationScope): Partial<AgentConfiguration> {
    const config = vscode.workspace.getConfiguration('devMate');
    const legacy: Record<string, unknown> = {};
    for (const [key, setting] of Object.entries(legacyKeys)) {
      const inspected = config.inspect(setting);
      legacy[key] = recoverLegacyNumber(key, scope === 'workspace' ? inspected?.workspaceValue : inspected?.globalValue);
    }
    const stored = config.inspect('configuration');
    return { ...parseConfigurationOverrides(legacy), ...parseConfigurationOverrides(withoutGenericReasoning(
      scope === 'workspace' ? stored?.workspaceValue : stored?.globalValue
    )) };
  }

  private requireScope(scope: unknown): asserts scope is ConfigurationScope {
    if (scope !== 'global' && scope !== 'workspace') throw new Error('Choose All projects or This project.');
    if (scope === 'workspace' && !vscode.workspace.workspaceFolders?.length) throw new Error('Open a project before saving project settings.');
  }
}

const configurationCommands = new Set(['openConfiguration', 'setConfigurationScope', 'saveConfiguration']);

/** Keep reasoning in runtime/checkpoint types, but discard it at the generic preferences boundary. */
function withoutGenericReasoning(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const { reasoningEffort: _reasoningEffort, ...preferences } = value as Record<string, unknown>;
  return preferences;
}

/** Older individual settings were clamped at request time. Preserve that recovery behavior on upgrade. */
function recoverLegacyNumber(key: string, value: unknown): unknown {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  const limits = CONFIGURATION_NUMBER_LIMITS[key as keyof typeof CONFIGURATION_NUMBER_LIMITS];
  const bounded = Math.min(limits.max, Math.max(limits.min, value));
  return key === 'temperature' ? bounded : Math.trunc(bounded);
}
