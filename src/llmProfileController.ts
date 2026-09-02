import { randomUUID } from 'crypto';
import { isValidModelContextWindowTokens } from './contextPlanner';
import {
  ACTIVE_LLM_PROFILE_STORAGE_KEY,
  BUILT_IN_NEMOTRON_PROFILE_ID,
  isBuiltInLlmProfile,
  LLM_PROFILES_STORAGE_KEY,
  LLM_REASONING_EFFORT_STORAGE_KEY,
  normalizeProfileDraft,
  parseReasoningEffortPreferences,
  parseStoredProfiles,
  profilesWithBuiltInNemotron,
  providerLabelForProfile,
  REASONING_EFFORT_LABELS,
  reasoningEffortForProfile,
  reasoningEffortOptionsForProfile,
  secretKeyForProfile,
  validateProfileDraft
} from './llmProfiles';
import type {
  LlmProfile,
  LlmProfileDraft,
  LlmProvider,
  ReasoningEffort
} from './llmProfiles';

export type LlmProfileFormSubmission = {
  id?: string;
  name: string;
  provider: LlmProvider;
  model: string;
  baseUrl?: string;
  contextWindowTokens?: number;
  apiKey?: string;
};

export type LlmProfilePickerItem = {
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

export type LlmProfileFormState = {
  profile?: {
    id: string;
    name: string;
    provider: LlmProvider;
    model: string;
    baseUrl?: string;
    contextWindowTokens?: number;
    builtIn: boolean;
  };
  hasApiKey: boolean;
};

export type LlmProfileState = {
  profiles: LlmProfile[];
  activeProfile?: LlmProfile;
  reasoningPreferences: Record<string, ReasoningEffort>;
};

export type LlmProfileSaveOutcome = {
  profile: LlmProfile;
  created: boolean;
  builtIn: boolean;
};

export type LlmProfileResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export interface LlmProfilePersistence {
  readState(key: string): unknown;
  writeState(key: string, value: unknown): PromiseLike<void>;
  readSecret(key: string): PromiseLike<string | undefined>;
  writeSecret(key: string, value: string): PromiseLike<void>;
  deleteSecret(key: string): PromiseLike<void>;
}

// This controller owns model-profile data. It does not know anything about VS Code or the webview.
export class LlmProfileController {
  constructor(
    private readonly persistence: LlmProfilePersistence,
    private readonly createId: () => string = randomUUID
  ) {}

  storedProfiles(): LlmProfile[] {
    return parseStoredProfiles(this.persistence.readState(LLM_PROFILES_STORAGE_KEY));
  }

  profiles(): LlmProfile[] {
    // Only custom profiles are stored. The permanent built-in profile is added here.
    return profilesWithBuiltInNemotron(this.storedProfiles());
  }

  activeProfile(profiles = this.profiles()): LlmProfile | undefined {
    const activeProfileId = this.persistence.readState(ACTIVE_LLM_PROFILE_STORAGE_KEY);
    return profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
  }

  reasoningPreferences(): Record<string, ReasoningEffort> {
    return parseReasoningEffortPreferences(
      this.persistence.readState(LLM_REASONING_EFFORT_STORAGE_KEY)
    );
  }

  apiKey(profileId: string): PromiseLike<string | undefined> {
    return this.persistence.readSecret(secretKeyForProfile(profileId));
  }

  state(): LlmProfileState {
    const profiles = this.profiles();
    return {
      profiles,
      activeProfile: this.activeProfile(profiles),
      reasoningPreferences: this.reasoningPreferences()
    };
  }

  async synchronizedState(): Promise<LlmProfileState> {
    const state = this.state();
    if (
      state.activeProfile
      && this.persistence.readState(ACTIVE_LLM_PROFILE_STORAGE_KEY) !== state.activeProfile.id
    ) {
      await this.persistence.writeState(
        ACTIVE_LLM_PROFILE_STORAGE_KEY,
        state.activeProfile.id
      );
    }
    return state;
  }

  pickerItems(): LlmProfilePickerItem[] {
    const { profiles, activeProfile, reasoningPreferences } = this.state();
    return profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      providerLabel: providerLabelForProfile(profile),
      model: profile.model,
      baseUrl: profile.baseUrl,
      contextWindowTokens: profile.contextWindowTokens,
      intelligence: reasoningEffortOptionsForProfile(profile).length > 1
        ? REASONING_EFFORT_LABELS[reasoningEffortForProfile(profile, reasoningPreferences)]
        : undefined,
      builtIn: isBuiltInLlmProfile(profile),
      selected: profile.id === activeProfile?.id
    }));
  }

  async form(profileId?: string): Promise<LlmProfileResult<LlmProfileFormState>> {
    if (profileId === undefined) {
      return { ok: true, value: { hasApiKey: false } };
    }
    const profile = this.profiles().find((candidate) => candidate.id === profileId);
    if (!profile) {
      return { ok: false, message: 'That model profile no longer exists.' };
    }
    try {
      const apiKey = await this.apiKey(profile.id);
      return {
        ok: true,
        value: {
          profile: {
            id: profile.id,
            name: profile.name,
            provider: profile.provider,
            model: profile.model,
            baseUrl: profile.baseUrl,
            contextWindowTokens: profile.contextWindowTokens,
            builtIn: isBuiltInLlmProfile(profile)
          },
          hasApiKey: Boolean(apiKey)
        }
      };
    } catch {
      return { ok: false, message: 'Could not read the model profile credential.' };
    }
  }

  async select(profileId: string): Promise<LlmProfileResult<LlmProfile>> {
    const profile = this.profiles().find((candidate) => candidate.id === profileId);
    if (!profile) {
      return { ok: false, message: 'That model profile no longer exists.' };
    }
    try {
      await this.persistence.writeState(ACTIVE_LLM_PROFILE_STORAGE_KEY, profile.id);
      return { ok: true, value: profile };
    } catch {
      return { ok: false, message: 'Could not select the model profile.' };
    }
  }

  async setReasoningEffort(
    effort: ReasoningEffort
  ): Promise<LlmProfileResult<ReasoningEffort>> {
    const profile = this.activeProfile();
    if (!profile || !reasoningEffortOptionsForProfile(profile).includes(effort)) {
      return {
        ok: false,
        message: 'The selected model does not support that intelligence level.'
      };
    }
    const preferences = { ...this.reasoningPreferences() };
    // Auto is the default, so it does not need a saved override.
    if (effort === 'auto') {
      delete preferences[profile.id];
    } else {
      preferences[profile.id] = effort;
    }
    try {
      await this.persistence.writeState(LLM_REASONING_EFFORT_STORAGE_KEY, preferences);
      return { ok: true, value: effort };
    } catch {
      return { ok: false, message: 'Could not save the intelligence setting.' };
    }
  }

  async save(
    submission: LlmProfileFormSubmission
  ): Promise<LlmProfileResult<LlmProfileSaveOutcome>> {
    if (!isValidSubmission(submission)) {
      return { ok: false, message: 'The model profile contains invalid values.' };
    }

    const profiles = this.profiles();
    const storedProfiles = this.storedProfiles();
    const existingProfile = submission.id
      ? profiles.find((profile) => profile.id === submission.id)
      : undefined;
    if (submission.id && !existingProfile) {
      return { ok: false, message: 'That model profile no longer exists.' };
    }
    if (existingProfile && isBuiltInLlmProfile(existingProfile)) {
      return this.saveBuiltInApiKey(existingProfile, submission.apiKey);
    }

    const submittedDraft: LlmProfileDraft = {
      name: submission.name,
      provider: submission.provider,
      model: submission.model,
      baseUrl: submission.baseUrl,
      contextWindowTokens: submission.contextWindowTokens
    };
    const validationError = validateProfileDraft(
      submittedDraft,
      profiles,
      existingProfile?.id
    );
    if (validationError) {
      return { ok: false, message: validationError };
    }
    const draft = normalizeProfileDraft(submittedDraft);
    let existingApiKey: string | undefined;
    try {
      existingApiKey = existingProfile
        ? await this.persistence.readSecret(secretKeyForProfile(existingProfile.id))
        : undefined;
    } catch {
      return { ok: false, message: 'Could not read the model profile credential.' };
    }
    const submittedApiKey = submission.apiKey?.trim();
    if (draft.provider === 'openai' && !submittedApiKey && !existingApiKey) {
      return { ok: false, message: 'Enter an API key for this OpenAI profile.' };
    }

    const profile: LlmProfile = {
      id: existingProfile?.id ?? this.createId(),
      ...draft
    };
    // API keys stay in SecretStorage and are never included in the saved profile object.
    const secretKey = secretKeyForProfile(profile.id);
    const updatedProfiles = existingProfile
      ? storedProfiles.map((candidate) => candidate.id === profile.id ? profile : candidate)
      : [...storedProfiles, profile];

    try {
      if (draft.provider === 'openai' && submittedApiKey) {
        await this.persistence.writeSecret(secretKey, submittedApiKey);
      }
      await this.persistence.writeState(LLM_PROFILES_STORAGE_KEY, updatedProfiles);
      if (!existingProfile) {
        await this.persistence.writeState(ACTIVE_LLM_PROFILE_STORAGE_KEY, profile.id);
      }
      if (draft.provider === 'ollama') {
        await this.persistence.deleteSecret(secretKey);
      }
    } catch {
      if (!existingProfile) {
        await ignoreFailure(this.persistence.deleteSecret(secretKey));
      }
      return { ok: false, message: 'Could not save the model profile.' };
    }

    return {
      ok: true,
      value: {
        profile,
        created: !existingProfile,
        builtIn: false
      }
    };
  }

  async delete(profileId: string): Promise<LlmProfileResult<LlmProfile>> {
    const profiles = this.profiles();
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (!profile) {
      return { ok: false, message: 'That model profile no longer exists.' };
    }
    if (isBuiltInLlmProfile(profile)) {
      return { ok: false, message: 'The built-in Nemotron profile cannot be deleted.' };
    }

    const remainingProfiles = this.storedProfiles().filter(
      (candidate) => candidate.id !== profile.id
    );
    const remainingPreferences = { ...this.reasoningPreferences() };
    delete remainingPreferences[profile.id];
    try {
      await this.persistence.writeState(LLM_PROFILES_STORAGE_KEY, remainingProfiles);
      await this.persistence.writeState(
        LLM_REASONING_EFFORT_STORAGE_KEY,
        remainingPreferences
      );
      await this.persistence.deleteSecret(secretKeyForProfile(profile.id));
      if (this.activeProfile(profiles)?.id === profile.id) {
        await this.persistence.writeState(
          ACTIVE_LLM_PROFILE_STORAGE_KEY,
          BUILT_IN_NEMOTRON_PROFILE_ID
        );
      }
      return { ok: true, value: profile };
    } catch {
      return { ok: false, message: 'Could not delete the model profile.' };
    }
  }

  private async saveBuiltInApiKey(
    profile: LlmProfile,
    apiKey: string | undefined
  ): Promise<LlmProfileResult<LlmProfileSaveOutcome>> {
    const secretKey = secretKeyForProfile(profile.id);
    const submittedApiKey = apiKey?.trim();
    let existingApiKey: string | undefined;
    try {
      existingApiKey = await this.persistence.readSecret(secretKey);
    } catch {
      return { ok: false, message: 'Could not read the NVIDIA API key.' };
    }
    if (!submittedApiKey && !existingApiKey) {
      return {
        ok: false,
        message: 'Enter an NVIDIA API key for the built-in Nemotron model.'
      };
    }
    try {
      if (submittedApiKey) {
        await this.persistence.writeSecret(secretKey, submittedApiKey);
      }
      return {
        ok: true,
        value: { profile, created: false, builtIn: true }
      };
    } catch {
      return { ok: false, message: 'Could not save the NVIDIA API key.' };
    }
  }
}

function isValidSubmission(value: LlmProfileFormSubmission): boolean {
  return (value.id === undefined || typeof value.id === 'string')
    && typeof value.name === 'string'
    && (value.provider === 'openai' || value.provider === 'ollama')
    && typeof value.model === 'string'
    && (value.baseUrl === undefined || typeof value.baseUrl === 'string')
    && isValidModelContextWindowTokens(value.contextWindowTokens)
    && (value.apiKey === undefined || typeof value.apiKey === 'string');
}

async function ignoreFailure(operation: PromiseLike<void>): Promise<void> {
  try {
    await operation;
  } catch {
    // Best-effort cleanup must not replace the useful save error returned to the UI.
  }
}
