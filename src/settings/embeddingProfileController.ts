// Coordinate embedding-profile validation, persistence, and secret changes.
// Notify indexing only after a profile change has been saved.

import { randomUUID } from 'crypto';
import {
  ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY,
  EMBEDDING_PROFILES_STORAGE_KEY,
  embeddingSecretKeyForProfile,
  normalizeEmbeddingProfileDraft,
  parseStoredEmbeddingProfiles,
  preferredEmbeddingProfile,
  validateEmbeddingProfileDraft
} from './embeddingProfiles';
import type {
  EmbeddingProfile,
  EmbeddingProfileDraft,
  EmbeddingProviderName
} from './embeddingProfiles';

export type EmbeddingProfileFormSubmission = {
  id?: string;
  provider: EmbeddingProviderName;
  model: string;
  baseUrl: string;
  remoteAllowed: boolean;
  apiKey?: string;
};

export type EmbeddingProfileSummary = EmbeddingProfile & {
  providerLabel: string;
  selected: boolean;
};

export type EmbeddingProfileState = {
  profiles: EmbeddingProfile[];
  activeProfile?: EmbeddingProfile;
};

export type EmbeddingProfileResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export interface EmbeddingProfilePersistence {
  readState(key: string): unknown;
  writeState(key: string, value: unknown): PromiseLike<void>;
  readSecret(key: string): PromiseLike<string | undefined>;
  writeSecret(key: string, value: string): PromiseLike<void>;
  deleteSecret(key: string): PromiseLike<void>;
}

export class EmbeddingProfileController {
  constructor(
    private readonly persistence: EmbeddingProfilePersistence,
    private readonly onActiveProfileChanged: () => void = () => undefined,
    private readonly createId: () => string = randomUUID
  ) {}

  state(): EmbeddingProfileState {
    const profiles = parseStoredEmbeddingProfiles(
      this.persistence.readState(EMBEDDING_PROFILES_STORAGE_KEY)
    );
    const activeProfile = preferredEmbeddingProfile(
      profiles,
      this.persistence.readState(ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY)
    );
    return { profiles, activeProfile };
  }

  pickerItems(): EmbeddingProfileSummary[] {
    const { profiles, activeProfile } = this.state();
    return profiles.map((profile) => ({
      ...profile,
      providerLabel: embeddingProviderLabel(profile.provider),
      selected: profile.id === activeProfile?.id
    }));
  }

  async form(
    profileId?: string
  ): Promise<EmbeddingProfileResult<{ profile?: EmbeddingProfile; hasApiKey: boolean }>> {
    if (profileId === undefined) {
      return { ok: true, value: { hasApiKey: false } };
    }
    const profile = this.state().profiles.find((candidate) => candidate.id === profileId);
    if (!profile) {
      return { ok: false, message: 'That embedding profile no longer exists.' };
    }
    try {
      const apiKey = await this.persistence.readSecret(
        embeddingSecretKeyForProfile(profile.id)
      );
      return { ok: true, value: { profile, hasApiKey: Boolean(apiKey) } };
    } catch {
      return { ok: false, message: 'Could not read the embedding profile credential.' };
    }
  }

  async select(profileId: string): Promise<EmbeddingProfileResult<EmbeddingProfile>> {
    const { profiles, activeProfile } = this.state();
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (!profile) {
      return { ok: false, message: 'That embedding profile no longer exists.' };
    }
    try {
      await this.persistence.writeState(ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY, profile.id);
    } catch {
      return { ok: false, message: 'Could not select the embedding profile.' };
    }
    if (profile.id !== activeProfile?.id) {
      this.onActiveProfileChanged();
    }
    return { ok: true, value: profile };
  }

  async save(
    submission: EmbeddingProfileFormSubmission
  ): Promise<EmbeddingProfileResult<EmbeddingProfile>> {
    const submissionError = validateSubmission(submission);
    if (submissionError) {
      return { ok: false, message: submissionError };
    }

    const { profiles, activeProfile } = this.state();
    const existingProfile = submission.id
      ? profiles.find((candidate) => candidate.id === submission.id)
      : undefined;
    if (submission.id && !existingProfile) {
      return { ok: false, message: 'That embedding profile no longer exists.' };
    }

    const draft: EmbeddingProfileDraft = normalizeEmbeddingProfileDraft({
      provider: submission.provider,
      model: submission.model,
      baseUrl: submission.baseUrl,
      remoteAllowed: submission.remoteAllowed
    });
    const validationError = validateEmbeddingProfileDraft(draft);
    if (validationError) {
      return { ok: false, message: validationError };
    }

    let profileId = existingProfile?.id;
    if (!profileId) {
      try {
        profileId = uniqueProfileId(profiles, this.createId);
      } catch {
        return { ok: false, message: 'Could not create the embedding profile.' };
      }
    }
    const profile: EmbeddingProfile = { id: profileId, ...draft };
    const updatedProfiles = existingProfile
      ? profiles.map((candidate) => candidate.id === profile.id ? profile : candidate)
      : [...profiles, profile];
    const previousActiveId = activeProfile?.id;
    const nextActiveId = existingProfile ? previousActiveId : profile.id;
    const secretKey = embeddingSecretKeyForProfile(profile.id);
    let previousSecret: string | undefined;
    try {
      previousSecret = await this.persistence.readSecret(secretKey);
    } catch {
      return { ok: false, message: 'Could not read the existing embedding credential.' };
    }
    // State and SecretStorage are separate writes. Keep the old values for best-effort rollback.
    const submittedApiKey = submission.apiKey?.trim();

    try {
      if (submittedApiKey) {
        await this.persistence.writeSecret(secretKey, submittedApiKey);
      }
      await this.persistence.writeState(EMBEDDING_PROFILES_STORAGE_KEY, updatedProfiles);
      if (nextActiveId !== previousActiveId) {
        await this.persistence.writeState(
          ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY,
          nextActiveId
        );
      }
    } catch {
      await this.restoreSaveState(
        profiles,
        previousActiveId,
        secretKey,
        previousSecret
      );
      return { ok: false, message: 'Could not save the embedding profile.' };
    }

    // Restart indexing only for an active/new profile, and only after persistence succeeded.
    if (!existingProfile || existingProfile.id === activeProfile?.id) {
      this.onActiveProfileChanged();
    }
    return { ok: true, value: profile };
  }

  async delete(profileId: string): Promise<EmbeddingProfileResult<EmbeddingProfile>> {
    const { profiles, activeProfile } = this.state();
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (!profile) {
      return { ok: false, message: 'That embedding profile no longer exists.' };
    }
    const remainingProfiles = profiles.filter((candidate) => candidate.id !== profile.id);
    const nextActiveProfile = preferredEmbeddingProfile(
      remainingProfiles,
      activeProfile?.id === profile.id ? undefined : activeProfile?.id
    );
    const secretKey = embeddingSecretKeyForProfile(profile.id);
    let previousSecret: string | undefined;
    try {
      previousSecret = await this.persistence.readSecret(secretKey);
    } catch {
      return { ok: false, message: 'Could not read the existing embedding credential.' };
    }
    try {
      await this.persistence.writeState(EMBEDDING_PROFILES_STORAGE_KEY, remainingProfiles);
      await this.persistence.writeState(
        ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY,
        nextActiveProfile?.id
      );
      await this.persistence.deleteSecret(secretKey);
    } catch {
      await this.restoreSaveState(
        profiles,
        activeProfile?.id,
        secretKey,
        previousSecret
      );
      return { ok: false, message: 'Could not delete the embedding profile.' };
    }
    if (activeProfile?.id === profile.id) {
      this.onActiveProfileChanged();
    }
    return { ok: true, value: profile };
  }

  private async restoreSaveState(
    profiles: readonly EmbeddingProfile[],
    activeProfileId: string | undefined,
    secretKey: string,
    previousSecret: string | undefined
  ): Promise<void> {
    try {
      await this.persistence.writeState(EMBEDDING_PROFILES_STORAGE_KEY, profiles);
      await this.persistence.writeState(
        ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY,
        activeProfileId
      );
      if (previousSecret === undefined) {
        await this.persistence.deleteSecret(secretKey);
      } else {
        await this.persistence.writeSecret(secretKey, previousSecret);
      }
    } catch {
      // The original persistence failure remains the useful error for the UI.
    }
  }
}

export function embeddingProviderLabel(provider: EmbeddingProviderName): string {
  return provider === 'ollama' ? 'Ollama' : 'OpenAI-compatible';
}

function validateSubmission(submission: EmbeddingProfileFormSubmission): string | undefined {
  if (!submission
    || typeof submission !== 'object'
    || (submission.id !== undefined && typeof submission.id !== 'string')
    || !['ollama', 'openai-compatible'].includes(submission.provider)
    || typeof submission.model !== 'string'
    || typeof submission.baseUrl !== 'string'
    || typeof submission.remoteAllowed !== 'boolean'
    || (submission.apiKey !== undefined && typeof submission.apiKey !== 'string')) {
    return 'The embedding profile contains invalid values.';
  }
  const apiKey = submission.apiKey?.trim();
  if (apiKey && (apiKey.length > 8_192 || /[\r\n]/.test(apiKey))) {
    return 'Use an embedding API key without line breaks and with 8192 characters or fewer.';
  }
  return undefined;
}

function uniqueProfileId(
  profiles: readonly EmbeddingProfile[],
  createId: () => string
): string {
  const existingIds = new Set(profiles.map((profile) => profile.id));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = createId();
    if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(candidate)
      && !existingIds.has(candidate)) {
      return candidate;
    }
  }
  throw new Error('Could not create a unique embedding profile ID.');
}
