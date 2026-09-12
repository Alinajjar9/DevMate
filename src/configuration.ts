/** Non-secret agent preferences shared by storage, the settings UI and each bounded run. */
import { AGENT_TOOL_NAMES } from './agentTools';
import type { AgentToolName } from './agentTools';
import type { ReasoningEffort } from './llmProfiles';
import { normalizeWorkspaceRelativePath } from './fileTools';

export type ConfigurationScope = 'global' | 'workspace';
export type AgentConfiguration = {
  maxTokens: number;
  temperature: number;
  timeoutSeconds: number;
  commandTimeoutSeconds: number;
  toolCallLimit: number;
  maxFileEdits: number;
  maxCommands: number;
  maxRepairAttempts: number;
  contextCharacters: number;
  historyCharacters: number;
  runTokenBudget: number;
  instructions: string;
  excludedPaths: string[];
  pinnedFiles: string[];
  enabledTools: AgentToolName[];
  reasoningEffort: ReasoningEffort;
};
export type ModelProfileSettings = Partial<Pick<AgentConfiguration,
  'maxTokens' | 'temperature' | 'timeoutSeconds' | 'reasoningEffort' | 'contextCharacters'>>;

export const CONFIGURATION_NUMBER_LIMITS = {
  maxTokens: { min: 128, max: 32_000 },
  temperature: { min: 0, max: 2 },
  timeoutSeconds: { min: 10, max: 1_800 },
  commandTimeoutSeconds: { min: 10, max: 1_800 },
  toolCallLimit: { min: 4, max: 100 },
  maxFileEdits: { min: 0, max: 100 },
  maxCommands: { min: 0, max: 100 },
  maxRepairAttempts: { min: 1, max: 10 },
  contextCharacters: { min: 1_000, max: 40_000 },
  historyCharacters: { min: 10_000, max: 80_000 },
  runTokenBudget: { min: 0, max: 5_000_000 }
} as const;

export const DEFAULT_AGENT_CONFIGURATION: AgentConfiguration = Object.freeze({
  maxTokens: 16_384, temperature: 0.2, timeoutSeconds: 900, commandTimeoutSeconds: 300,
  toolCallLimit: 16, maxFileEdits: 6, maxCommands: 3, maxRepairAttempts: 3,
  contextCharacters: 40_000, historyCharacters: 80_000, runTokenBudget: 0,
  instructions: '', excludedPaths: [], pinnedFiles: [], enabledTools: [...AGENT_TOOL_NAMES],
  reasoningEffort: 'auto'
});

const numericKeys = Object.keys(CONFIGURATION_NUMBER_LIMITS) as Array<keyof typeof CONFIGURATION_NUMBER_LIMITS>;
const profileKeys = ['maxTokens', 'temperature', 'timeoutSeconds', 'reasoningEffort', 'contextCharacters'] as const;
const configurationKeys = new Set(Object.keys(DEFAULT_AGENT_CONFIGURATION));
const efforts = new Set(['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Saving is strict: report mistakes instead of quietly changing the user's values. */
export function validateConfigurationOverrides(value: unknown): string | undefined {
  if (!isRecord(value)) return 'Configuration must be a JSON object.';
  for (const [key, item] of Object.entries(value)) {
    if (!configurationKeys.has(key)) return `Unknown configuration setting: ${key}.`;
    const issue = fieldIssue(key, item);
    if (issue) return issue;
  }
  return undefined;
}

/** Storage recovery is forgiving: retain valid individual overrides and discard damaged values. */
export function parseConfigurationOverrides(value: unknown): Partial<AgentConfiguration> {
  if (!isRecord(value)) return {};
  const parsed: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!configurationKeys.has(key) || fieldIssue(key, item)) continue;
    parsed[key] = Array.isArray(item)
      ? [...new Set(item.map(entry => typeof entry === 'string' ? entry.trim().replace(/\\/g, '/') : entry))]
      : item;
  }
  return parsed as Partial<AgentConfiguration>;
}

export function normalizeAgentConfiguration(value: unknown): AgentConfiguration {
  const parsed = parseConfigurationOverrides(value);
  return { ...DEFAULT_AGENT_CONFIGURATION, ...parsed,
    excludedPaths: [...(parsed.excludedPaths ?? [])], pinnedFiles: [...(parsed.pinnedFiles ?? [])],
    enabledTools: [...(parsed.enabledTools ?? AGENT_TOOL_NAMES)] };
}

export function validateModelProfileSettings(value: unknown): string | undefined {
  if (!isRecord(value)) return 'Model overrides must be an object.';
  if (Object.keys(value).some(key => !(profileKeys as readonly string[]).includes(key))) {
    return 'Model profiles may override output tokens, temperature, timeout, reasoning and context size only.';
  }
  return validateConfigurationOverrides(value);
}

export function parseModelProfileSettings(value: unknown): ModelProfileSettings {
  const parsed = parseConfigurationOverrides(value);
  return Object.fromEntries(profileKeys.filter(key => parsed[key] !== undefined).map(key => [key, parsed[key]]));
}

function fieldIssue(key: string, value: unknown): string | undefined {
  if ((numericKeys as string[]).includes(key)) {
    const limits = CONFIGURATION_NUMBER_LIMITS[key as keyof typeof CONFIGURATION_NUMBER_LIMITS];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < limits.min || value > limits.max
      || (key !== 'temperature' && !Number.isInteger(value))) {
      return `${key} must be ${key === 'temperature' ? 'a number' : 'a whole number'} between ${limits.min} and ${limits.max}.`;
    }
    if (key === 'runTokenBudget' && value > 0 && value < 1_000) return 'The run token budget must be 0 (off) or at least 1000.';
    return undefined;
  }
  if (key === 'instructions') return typeof value === 'string' && value.length <= 12_000
    ? undefined : 'Instructions must contain at most 12000 characters.';
  if (key === 'reasoningEffort') return efforts.has(String(value)) && typeof value === 'string'
    ? undefined : 'Choose a supported reasoning effort.';
  if (key === 'enabledTools') return Array.isArray(value) && value.length <= AGENT_TOOL_NAMES.length
    && value.every(tool => AGENT_TOOL_NAMES.includes(tool as AgentToolName)) && new Set(value).size === value.length
    ? undefined : 'Enabled tools must be a list of supported tool names without duplicates.';
  if (key === 'excludedPaths' || key === 'pinnedFiles') {
    const maximum = key === 'pinnedFiles' ? 5 : 100;
    if (!Array.isArray(value) || value.length > maximum || !value.every(path => validRelativePath(path, key === 'excludedPaths'))) {
      return `${key} must contain at most ${maximum} workspace-relative ${key === 'excludedPaths' ? 'paths or patterns using *, ** or ?' : 'file paths'}.`;
    }
  }
  return undefined;
}

function validRelativePath(value: unknown, patterns: boolean): boolean {
  if (!boundedText(value, 500)) return false;
  const path = value.trim().replace(/\\/g, '/');
  if (/[\[\]{}]/.test(path) || (!patterns && /[*?]/.test(path))) return false;
  try {
    normalizeWorkspaceRelativePath(patterns ? path.replace(/[*?]/g, 'x').replace(/\/+$/, '') : path);
    return true;
  } catch { return false; }
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
