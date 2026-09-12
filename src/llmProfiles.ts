/** Model profile metadata and validation. API keys are kept separately in VS Code SecretStorage. */
import { parseModelProfileSettings, validateModelProfileSettings } from './configuration';
import type { ModelProfileSettings } from './configuration';

export const LLM_PROFILES_STORAGE_KEY = 'devMate.llmProfiles.v1';
export const ACTIVE_LLM_PROFILE_STORAGE_KEY = 'devMate.activeLlmProfileId.v1';
export const LLM_REASONING_EFFORT_STORAGE_KEY = 'devMate.reasoningEffortByProfile.v1';

export type LlmProvider = 'openai' | 'ollama';
export type LlmApi = 'auto' | 'chat_completions' | 'responses';
export type ReasoningEffort = 'auto' | 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  auto: 'Auto',
  none: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
};

export type LlmProfile = {
  id: string;
  name: string;
  provider: LlmProvider;
  model: string;
  baseUrl?: string;
  api?: LlmApi;
  settings?: ModelProfileSettings;
  builtIn?: true;
};

export type LlmProfileDraft = Omit<LlmProfile, 'id'>;

export const PROVIDER_LABELS: Record<LlmProvider, string> = {
  openai: 'OpenAI',
  ollama: 'Ollama'
};

export const BUILT_IN_NEMOTRON_PROFILE_ID = 'builtin-nemotron-3-ultra';
export const BUILT_IN_NEMOTRON_PROFILE: LlmProfile = Object.freeze({
  id: BUILT_IN_NEMOTRON_PROFILE_ID,
  name: 'Nemotron 3 Ultra',
  provider: 'openai',
  model: 'nvidia/nemotron-3-ultra-550b-a55b',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  api: 'chat_completions',
  builtIn: true
});

const supportedProviders = new Set<LlmProvider>(['openai', 'ollama']);
const supportedApis = new Set<LlmApi>(['auto', 'chat_completions', 'responses']);
const reasoningEfforts = new Set<ReasoningEffort>(['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max']);

export function normalizeProfileDraft(draft: LlmProfileDraft): LlmProfileDraft {
  const baseUrl = draft.baseUrl?.trim().replace(/\/+$/, '');
  return {
    name: draft.name.trim(),
    provider: draft.provider,
    model: draft.model.trim(),
    api: draft.api === undefined ? 'auto' : draft.api,
    ...(draft.settings !== undefined ? { settings: draft.settings } : {}),
    ...(baseUrl ? { baseUrl } : {})
  };
}

/** Return the first user-facing validation error, or undefined when the profile can be saved. */
export function validateProfileDraft(
  draft: LlmProfileDraft,
  existingProfiles: LlmProfile[],
  editingProfileId?: string
): string | undefined {
  const normalized = normalizeProfileDraft(draft);
  if (normalized.settings !== undefined) {
    const issue = validateModelProfileSettings(normalized.settings);
    if (issue) return issue;
  }

  if (!normalized.name) {
    return 'Enter a display name.';
  }
  if (normalized.name.length > 60) {
    return 'Use a display name with 60 characters or fewer.';
  }
  if (!supportedProviders.has(normalized.provider)) {
    return 'Choose a supported provider.';
  }
  if (!supportedApis.has(normalized.api as LlmApi)) {
    return 'Choose Auto, Chat Completions, or Responses for the provider API.';
  }
  if (!normalized.model) {
    return 'Enter a model ID.';
  }
  if (normalized.model.length > 120) {
    return 'Use a model ID with 120 characters or fewer.';
  }
  if (
    existingProfiles.some(
      (profile) =>
        profile.id !== editingProfileId
        && profile.name.localeCompare(normalized.name, undefined, { sensitivity: 'accent' }) === 0
    )
  ) {
    return `A model profile named "${normalized.name}" already exists.`;
  }

  if (normalized.baseUrl) {
    try {
      const url = new URL(normalized.baseUrl);
      if (
        !['http:', 'https:'].includes(url.protocol)
        || url.username
        || url.password
        || url.search
        || url.hash
      ) {
        return 'Use an HTTP or HTTPS base URL without credentials, query parameters, or fragments.';
      }
    } catch {
      return 'Enter a valid base URL.';
    }
  }

  return undefined;
}

/** Recover usable profile metadata from storage, skipping malformed and duplicate entries. */
export function parseStoredProfiles(value: unknown): LlmProfile[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const profiles: LlmProfile[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();

  for (const candidate of value) {
    if (!isRecord(candidate)) {
      continue;
    }

    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const model = typeof candidate.model === 'string' ? candidate.model.trim() : '';
    const provider = candidate.provider;
    const baseUrl = typeof candidate.baseUrl === 'string'
      ? candidate.baseUrl.trim().replace(/\/+$/, '')
      : undefined;
    const normalizedName = name.toLocaleLowerCase();

    if (
      !id
      || !name
      || !model
      || !supportedProviders.has(provider as LlmProvider)
      || (candidate.api !== undefined && !supportedApis.has(candidate.api as LlmApi))
      || seenIds.has(id)
      || seenNames.has(normalizedName)
    ) {
      continue;
    }

    const profile: LlmProfile = {
      id,
      name,
      provider: provider as LlmProvider,
      model,
      api: (candidate.api as LlmApi | undefined) ?? 'auto',
      ...(candidate.settings !== undefined ? { settings: parseModelProfileSettings(candidate.settings) } : {}),
      ...(baseUrl ? { baseUrl } : {})
    };
    if (validateProfileDraft(profile, profiles, id)) {
      continue;
    }

    seenIds.add(id);
    seenNames.add(normalizedName);
    profiles.push(profile);
  }

  return profiles;
}

export function profilesWithBuiltInNemotron(profiles: LlmProfile[]): LlmProfile[] {
  const storedSettings = profiles.find(profile => profile.id === BUILT_IN_NEMOTRON_PROFILE_ID)?.settings;
  return [
    ...(storedSettings ? [{ ...BUILT_IN_NEMOTRON_PROFILE, settings: parseModelProfileSettings(storedSettings) }]
      : [BUILT_IN_NEMOTRON_PROFILE]),
    ...profiles.filter((profile) => profile.id !== BUILT_IN_NEMOTRON_PROFILE_ID)
  ];
}

export function isBuiltInLlmProfile(profile: LlmProfile): boolean {
  return profile.id === BUILT_IN_NEMOTRON_PROFILE_ID;
}

export function isEquivalentNemotronProfile(profile: LlmProfile): boolean {
  return profile.provider === BUILT_IN_NEMOTRON_PROFILE.provider
    && profile.api !== 'responses'
    && profile.model.toLocaleLowerCase() === BUILT_IN_NEMOTRON_PROFILE.model.toLocaleLowerCase()
    && profile.baseUrl?.toLocaleLowerCase() === BUILT_IN_NEMOTRON_PROFILE.baseUrl?.toLocaleLowerCase();
}

export function providerLabelForProfile(profile: LlmProfile): string {
  return isBuiltInLlmProfile(profile) ? 'NVIDIA' : PROVIDER_LABELS[profile.provider];
}

/** Let the provider validate explicit reasoning choices rather than guessing capabilities from model names. */
export function reasoningEffortOptionsForProfile(profile: LlmProfile): ReasoningEffort[] {
  const model = profile.model.trim().toLocaleLowerCase();
  if (/^(?:nvidia\/)?nemotron-3-ultra(?:-|$)/.test(model)) {
    // Nemotron uses its existing provider-specific thinking controls.
    return ['auto', 'none', 'low', 'medium', 'high'];
  }
  return [...reasoningEfforts];
}

export function parseReasoningEffortPreferences(value: unknown): Record<string, ReasoningEffort> {
  if (!isRecord(value)) {
    return {};
  }
  const entries = Object.entries(value)
    .filter(([id, effort]) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(id)
      && reasoningEfforts.has(effort as ReasoningEffort))
    .slice(0, 100) as Array<[string, ReasoningEffort]>;
  return Object.fromEntries(entries);
}

export function reasoningEffortForProfile(
  profile: LlmProfile,
  preferences: Record<string, ReasoningEffort>
): ReasoningEffort {
  const preferred = preferences[profile.id] ?? 'auto';
  return reasoningEfforts.has(preferred) ? preferred : 'auto';
}

export function secretKeyForProfile(profileId: string): string {
  return `devMate.llmProfile.${profileId}.apiKey`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
