import {
  isLoopbackProviderBaseUrl,
  normalizeProviderBaseUrl,
  validateProviderBaseUrl
} from './providerUrlPolicy';

export const EMBEDDING_PROFILES_STORAGE_KEY = 'devMate.embeddingProfiles.v1';
export const ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY = 'devMate.activeEmbeddingProfileId.v1';
export const EMBEDDING_PROVIDER_NAMES = ['ollama', 'openai-compatible'] as const;

export type EmbeddingProviderName = typeof EMBEDDING_PROVIDER_NAMES[number];

export type EmbeddingProfile = {
  id: string;
  provider: EmbeddingProviderName;
  model: string;
  baseUrl: string;
  remoteAllowed: boolean;
};

export type EmbeddingProfileDraft = Omit<EmbeddingProfile, 'id'>;

export type ResolvedEmbeddingProfile = EmbeddingProfile & {
  apiKey?: string;
};

export interface EmbeddingProfileReader {
  readProfiles(): unknown;
  readActiveProfileId(): unknown;
  readSecret(profileId: string): PromiseLike<string | undefined>;
}

const supportedProviders = new Set<EmbeddingProviderName>(EMBEDDING_PROVIDER_NAMES);
const profileIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

export function normalizeEmbeddingProfileDraft(
  draft: EmbeddingProfileDraft
): EmbeddingProfileDraft {
  return {
    provider: draft.provider,
    model: draft.model.trim(),
    baseUrl: normalizeProviderBaseUrl(draft.baseUrl) ?? '',
    remoteAllowed: draft.remoteAllowed === true
  };
}

export function validateEmbeddingProfileDraft(
  draft: EmbeddingProfileDraft
): string | undefined {
  const normalized = normalizeEmbeddingProfileDraft(draft);
  if (!supportedProviders.has(normalized.provider)) {
    return 'Choose a supported embedding provider.';
  }
  if (!normalized.model) {
    return 'Enter an embedding model ID.';
  }
  if (normalized.model.length > 120) {
    return 'Use an embedding model ID with 120 characters or fewer.';
  }
  if (!normalized.baseUrl) {
    return 'Enter an embedding provider base URL.';
  }

  const baseUrlError = validateProviderBaseUrl(normalized.baseUrl);
  if (baseUrlError) {
    return baseUrlError;
  }
  if (!normalized.remoteAllowed && !isLoopbackProviderBaseUrl(normalized.baseUrl)) {
    return 'Remote embedding providers require explicit opt-in.';
  }
  return undefined;
}

export function parseStoredEmbeddingProfiles(value: unknown): EmbeddingProfile[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const profiles: EmbeddingProfile[] = [];
  const seenIds = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) {
      continue;
    }

    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const draft = normalizeEmbeddingProfileDraft({
      provider: candidate.provider as EmbeddingProviderName,
      model: typeof candidate.model === 'string' ? candidate.model : '',
      baseUrl: typeof candidate.baseUrl === 'string' ? candidate.baseUrl : '',
      remoteAllowed: candidate.remoteAllowed === true
    });
    if (
      !profileIdPattern.test(id)
      || seenIds.has(id)
      || validateEmbeddingProfileDraft(draft)
    ) {
      continue;
    }

    seenIds.add(id);
    profiles.push({ id, ...draft });
  }
  return profiles;
}

export function preferredEmbeddingProfile(
  profiles: readonly EmbeddingProfile[],
  activeProfileId: unknown
): EmbeddingProfile | undefined {
  const active = typeof activeProfileId === 'string'
    ? profiles.find((profile) => profile.id === activeProfileId)
    : undefined;
  return active
    ?? profiles.find((profile) => profile.provider === 'ollama' && isLocalProfile(profile))
    ?? profiles.find(isLocalProfile)
    ?? profiles[0];
}

export function embeddingSecretKeyForProfile(profileId: string): string {
  if (!profileIdPattern.test(profileId)) {
    throw new Error('Embedding profile ID is invalid.');
  }
  return `devMate.embeddingProfile.${profileId}.apiKey`;
}

export async function readPreferredEmbeddingProfile(
  reader: EmbeddingProfileReader
): Promise<ResolvedEmbeddingProfile | undefined> {
  const profile = preferredEmbeddingProfile(
    parseStoredEmbeddingProfiles(reader.readProfiles()),
    reader.readActiveProfileId()
  );
  if (!profile) {
    return undefined;
  }
  const apiKey = await reader.readSecret(profile.id);
  return {
    ...profile,
    ...(apiKey !== undefined ? { apiKey } : {})
  };
}

function isLocalProfile(profile: EmbeddingProfile): boolean {
  return isLoopbackProviderBaseUrl(profile.baseUrl);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
