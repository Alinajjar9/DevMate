// Define chat-model profiles, defaults, and provider-specific reasoning choices.
// Profile objects contain configuration, never stored API-key values.

import {
  normalizeProviderBaseUrl,
  validateProviderBaseUrl
} from '../api/providerUrlPolicy';
import {
  isValidModelContextWindowTokens,
  normalizeModelContextWindowTokens
} from '../context/contextPlanner';
import type { ReasoningEffort } from '../api/types';

export type { ReasoningEffort } from '../api/types';

export const LLM_PROFILES_STORAGE_KEY = 'devMate.llmProfiles.v1';
export const ACTIVE_LLM_PROFILE_STORAGE_KEY = 'devMate.activeLlmProfileId.v1';
export const LLM_REASONING_EFFORT_STORAGE_KEY = 'devMate.reasoningEffortByProfile.v1';

export type LlmProvider = 'openai' | 'ollama';

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  auto: 'Auto',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high'
};

export type LlmProfile = {
  id: string;
  name: string;
  provider: LlmProvider;
  model: string;
  baseUrl?: string;
  contextWindowTokens?: number;
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
  builtIn: true
});

const supportedProviders = new Set<LlmProvider>(['openai', 'ollama']);
const reasoningEfforts = new Set<ReasoningEffort>(['auto', 'low', 'medium', 'high', 'xhigh']);

export function normalizeProfileDraft(draft: LlmProfileDraft): LlmProfileDraft {
  const baseUrl = normalizeProviderBaseUrl(draft.baseUrl);
  const contextWindowTokens = normalizeModelContextWindowTokens(
    draft.contextWindowTokens
  );
  return {
    name: draft.name.trim(),
    provider: draft.provider,
    model: draft.model.trim(),
    ...(baseUrl ? { baseUrl } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {})
  };
}

export function validateProfileDraft(
  draft: LlmProfileDraft,
  existingProfiles: LlmProfile[],
  editingProfileId?: string
): string | undefined {
  const normalized = normalizeProfileDraft(draft);

  if (!normalized.name) {
    return 'Enter a display name.';
  }
  if (normalized.name.length > 60) {
    return 'Use a display name with 60 characters or fewer.';
  }
  if (!supportedProviders.has(normalized.provider)) {
    return 'Choose a supported provider.';
  }
  if (!normalized.model) {
    return 'Enter a model ID.';
  }
  if (normalized.model.length > 120) {
    return 'Use a model ID with 120 characters or fewer.';
  }
  if (!isValidModelContextWindowTokens(draft.contextWindowTokens)) {
    return 'Use a context window from 1,024 to 4,000,000 tokens, or leave it blank for Auto.';
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

  const baseUrlError = validateProviderBaseUrl(normalized.baseUrl);
  if (baseUrlError) {
    return baseUrlError;
  }

  return undefined;
}

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
      ? normalizeProviderBaseUrl(candidate.baseUrl)
      : undefined;
    const contextWindowTokens = normalizeModelContextWindowTokens(
      candidate.contextWindowTokens
    );
    const normalizedName = name.toLocaleLowerCase();

    if (
      !id
      || !name
      || !model
      || !supportedProviders.has(provider as LlmProvider)
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
      ...(baseUrl ? { baseUrl } : {}),
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {})
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
  return [
    BUILT_IN_NEMOTRON_PROFILE,
    ...profiles.filter((profile) => profile.id !== BUILT_IN_NEMOTRON_PROFILE_ID)
  ];
}

export function isBuiltInLlmProfile(profile: LlmProfile): boolean {
  return profile.id === BUILT_IN_NEMOTRON_PROFILE_ID;
}

export function providerLabelForProfile(profile: LlmProfile): string {
  return isBuiltInLlmProfile(profile) ? 'NVIDIA' : PROVIDER_LABELS[profile.provider];
}

export function reasoningEffortOptionsForProfile(profile: LlmProfile): ReasoningEffort[] {
  const model = profile.model.trim().toLocaleLowerCase();
  if (/^(?:nvidia\/)?nemotron-3-ultra(?:-|$)/.test(model)) {
    return ['auto', 'low', 'medium', 'high'];
  }
  if (!isOfficialOpenAiProfile(profile)) {
    return ['auto'];
  }
  if (!/^gpt-5(?:[.-]|$)/.test(model) && !/^o(?:1|3|4)(?:-|$)/.test(model)) {
    return ['auto'];
  }
  if (/(?:^|-)pro(?:-|$)/.test(model)) {
    return ['auto', 'high'];
  }
  const version = /^gpt-5\.(\d+)(?:-|$)/.exec(model)?.[1];
  return version && Number(version) >= 2
    ? ['auto', 'low', 'medium', 'high', 'xhigh']
    : ['auto', 'low', 'medium', 'high'];
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
  return reasoningEffortOptionsForProfile(profile).includes(preferred) ? preferred : 'auto';
}

export function secretKeyForProfile(profileId: string): string {
  return `devMate.llmProfile.${profileId}.apiKey`;
}

function isOfficialOpenAiProfile(profile: LlmProfile): boolean {
  if (profile.provider !== 'openai') {
    return false;
  }
  if (!profile.baseUrl) {
    return true;
  }
  try {
    return new URL(profile.baseUrl).hostname.toLocaleLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
