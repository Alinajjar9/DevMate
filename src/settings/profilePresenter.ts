// Handle the forms and pickers for chat and embedding profiles.
// Controllers own profile data and secrets; this file only prepares UI operations.

import {
  embeddingProviderLabel
} from './embeddingProfileController';
import type {
  EmbeddingProfileController,
  EmbeddingProfileFormSubmission
} from './embeddingProfileController';
import type {
  LlmProfileController,
  LlmProfileFormSubmission
} from './llmProfileController';
import {
  isBuiltInLlmProfile,
  providerLabelForProfile,
  REASONING_EFFORT_LABELS,
  reasoningEffortForProfile,
  reasoningEffortOptionsForProfile
} from './llmProfiles';
import type { ReasoningEffort } from './llmProfiles';
import type { ExtensionToWebviewMessage } from '../chat/webviewProtocol';

export interface ProfilePresenterCallbacks {
  isRequestActive(): boolean;
  postMessage(message: ExtensionToWebviewMessage): void;
  postStatus(text: string, level?: 'info' | 'warning' | 'error'): void;
}

// This presenter turns profile-controller results into typed chat UI messages.
export class ProfilePresenter {
  constructor(
    private readonly llmProfiles: LlmProfileController,
    private readonly embeddingProfiles: EmbeddingProfileController,
    private readonly callbacks: ProfilePresenterCallbacks
  ) {}

  async setActiveReasoningEffort(effort: ReasoningEffort): Promise<void> {
    if (this.callbacks.isRequestActive()) {
      this.callbacks.postStatus(
        'Wait for the active request to finish before changing intelligence.',
        'warning'
      );
      return;
    }
    const result = await this.llmProfiles.setReasoningEffort(effort);
    if (!result.ok) {
      this.callbacks.postStatus(result.message, 'warning');
      await this.postLlmProfileState();
      return;
    }
    await this.postLlmProfileState();
    this.callbacks.postStatus('Ready');
  }

  async promptForBuiltInNemotronKey(): Promise<void> {
    const activeProfile = this.llmProfiles.activeProfile();
    if (!activeProfile || !isBuiltInLlmProfile(activeProfile)) {
      return;
    }
    const form = await this.llmProfiles.form(activeProfile.id);
    if (!form.ok) {
      this.callbacks.postStatus(form.message, 'warning');
      return;
    }
    if (!form.value.hasApiKey) {
      await this.showLlmProfileForm(activeProfile.id);
    }
  }

  chooseLlmProfile(): void {
    this.callbacks.postMessage({
      command: 'showLlmProfilePicker',
      profiles: this.llmProfiles.pickerItems()
    });
  }

  async selectLlmProfile(profileId: string): Promise<void> {
    const result = await this.llmProfiles.select(profileId);
    if (!result.ok) {
      this.callbacks.postStatus(result.message, 'warning');
      return;
    }
    await this.postLlmProfileState();
    await this.promptForBuiltInNemotronKey();
    this.callbacks.postStatus('Ready');
  }

  async showLlmProfileForm(profileId?: string): Promise<void> {
    const result = await this.llmProfiles.form(profileId);
    if (!result.ok) {
      this.callbacks.postStatus(result.message, 'warning');
      return;
    }
    this.callbacks.postMessage({
      command: 'showLlmProfileForm',
      profile: result.value.profile,
      hasApiKey: result.value.hasApiKey
    });
  }

  async saveLlmProfile(submission: LlmProfileFormSubmission): Promise<void> {
    const result = await this.llmProfiles.save(submission);
    if (!result.ok) {
      this.callbacks.postMessage({
        command: 'llmProfileFormError',
        message: result.message
      });
      return;
    }
    await this.postLlmProfileState();
    this.callbacks.postMessage({ command: 'closeLlmProfileForm' });
    this.callbacks.postStatus(
      result.value.builtIn
        ? `${result.value.profile.name} is ready.`
        : result.value.created
          ? `${result.value.profile.name} selected.`
          : `${result.value.profile.name} updated.`
    );
  }

  async deleteLlmProfile(profileId: string): Promise<void> {
    const result = await this.llmProfiles.delete(profileId);
    if (!result.ok) {
      this.callbacks.postMessage({
        command: 'llmProfileFormError',
        message: result.message
      });
      return;
    }
    await this.postLlmProfileState();
    this.callbacks.postMessage({ command: 'closeLlmProfileForm' });
    this.callbacks.postStatus(`${result.value.name} deleted.`);
  }

  async postLlmProfileState(): Promise<void> {
    const { profiles, activeProfile, reasoningPreferences } =
      await this.llmProfiles.synchronizedState();
    const reasoningOptions = activeProfile
      ? reasoningEffortOptionsForProfile(activeProfile)
      : ['auto'] as ReasoningEffort[];
    const reasoningEffort = activeProfile
      ? reasoningEffortForProfile(activeProfile, reasoningPreferences)
      : 'auto';
    this.callbacks.postMessage({
      command: 'llmProfilesUpdated',
      profileCount: profiles.length,
      activeProfile: activeProfile
        ? {
            id: activeProfile.id,
            name: activeProfile.name,
            provider: activeProfile.provider,
            providerLabel: providerLabelForProfile(activeProfile),
            model: activeProfile.model,
            reasoningEffort,
            reasoningEffortOptions: reasoningOptions.map((value) => ({
              value,
              label: REASONING_EFFORT_LABELS[value]
            }))
          }
        : undefined
    });
  }

  postEmbeddingProfileState(): void {
    const { profiles, activeProfile } = this.embeddingProfiles.state();
    this.callbacks.postMessage({
      command: 'embeddingProfilesUpdated',
      profileCount: profiles.length,
      activeProfile: activeProfile
        ? {
            ...activeProfile,
            providerLabel: embeddingProviderLabel(activeProfile.provider)
          }
        : undefined
    });
  }

  chooseEmbeddingProfile(): void {
    this.callbacks.postMessage({
      command: 'showEmbeddingProfilePicker',
      profiles: this.embeddingProfiles.pickerItems()
    });
  }

  async selectEmbeddingProfile(profileId: string): Promise<void> {
    const result = await this.embeddingProfiles.select(profileId);
    if (!result.ok) {
      this.callbacks.postStatus(result.message, 'warning');
      return;
    }
    this.postEmbeddingProfileState();
    this.callbacks.postStatus(`${result.value.model} selected for code embeddings.`);
  }

  async showEmbeddingProfileForm(profileId?: string): Promise<void> {
    const result = await this.embeddingProfiles.form(profileId);
    if (!result.ok) {
      this.callbacks.postStatus(result.message, 'warning');
      return;
    }
    this.callbacks.postMessage({
      command: 'showEmbeddingProfileForm',
      profile: result.value.profile,
      hasApiKey: result.value.hasApiKey
    });
  }

  async saveEmbeddingProfile(
    submission: EmbeddingProfileFormSubmission
  ): Promise<void> {
    const result = await this.embeddingProfiles.save(submission);
    if (!result.ok) {
      this.callbacks.postMessage({
        command: 'embeddingProfileFormError',
        message: result.message
      });
      return;
    }
    this.postEmbeddingProfileState();
    this.callbacks.postMessage({ command: 'closeEmbeddingProfileForm' });
    this.callbacks.postStatus(
      submission.id
        ? `${result.value.model} embedding profile updated.`
        : `${result.value.model} selected for code embeddings.`
    );
  }

  async deleteEmbeddingProfile(profileId: string): Promise<void> {
    const result = await this.embeddingProfiles.delete(profileId);
    if (!result.ok) {
      this.callbacks.postMessage({
        command: 'embeddingProfileFormError',
        message: result.message
      });
      return;
    }
    this.postEmbeddingProfileState();
    this.callbacks.postMessage({ command: 'closeEmbeddingProfileForm' });
    this.callbacks.postStatus(`${result.value.model} embedding profile deleted.`);
  }
}
