export const LLM_PROFILES_STORAGE_KEY = 'devMate.llmProfiles.v1';
export const ACTIVE_LLM_PROFILE_STORAGE_KEY = 'devMate.activeLlmProfileId.v1';

export type LlmProvider = 'openai' | 'ollama';

export type LlmProfile = {
  id: string;
  name: string;
  provider: LlmProvider;
  model: string;
  baseUrl?: string;
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

export function normalizeProfileDraft(draft: LlmProfileDraft): LlmProfileDraft {
  const baseUrl = draft.baseUrl?.trim().replace(/\/+$/, '');
  return {
    name: draft.name.trim(),
    provider: draft.provider,
    model: draft.model.trim(),
    ...(baseUrl ? { baseUrl } : {})
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
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        return 'Use an HTTP or HTTPS base URL without embedded credentials.';
      }
    } catch {
      return 'Enter a valid base URL.';
    }
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
      ? candidate.baseUrl.trim().replace(/\/+$/, '')
      : undefined;
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
  return [
    BUILT_IN_NEMOTRON_PROFILE,
    ...profiles.filter((profile) => profile.id !== BUILT_IN_NEMOTRON_PROFILE_ID)
  ];
}

export function isBuiltInLlmProfile(profile: LlmProfile): boolean {
  return profile.id === BUILT_IN_NEMOTRON_PROFILE_ID;
}

export function isEquivalentNemotronProfile(profile: LlmProfile): boolean {
  return profile.provider === BUILT_IN_NEMOTRON_PROFILE.provider
    && profile.model.toLocaleLowerCase() === BUILT_IN_NEMOTRON_PROFILE.model.toLocaleLowerCase()
    && profile.baseUrl?.toLocaleLowerCase() === BUILT_IN_NEMOTRON_PROFILE.baseUrl?.toLocaleLowerCase();
}

export function providerLabelForProfile(profile: LlmProfile): string {
  return isBuiltInLlmProfile(profile) ? 'NVIDIA' : PROVIDER_LABELS[profile.provider];
}

export function secretKeyForProfile(profileId: string): string {
  return `devMate.llmProfile.${profileId}.apiKey`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
