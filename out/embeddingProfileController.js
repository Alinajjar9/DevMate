"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmbeddingProfileController = void 0;
exports.embeddingProviderLabel = embeddingProviderLabel;
const crypto_1 = require("crypto");
const embeddingProfiles_1 = require("./embeddingProfiles");
class EmbeddingProfileController {
    persistence;
    onActiveProfileChanged;
    createId;
    constructor(persistence, onActiveProfileChanged = () => undefined, createId = crypto_1.randomUUID) {
        this.persistence = persistence;
        this.onActiveProfileChanged = onActiveProfileChanged;
        this.createId = createId;
    }
    state() {
        const profiles = (0, embeddingProfiles_1.parseStoredEmbeddingProfiles)(this.persistence.readState(embeddingProfiles_1.EMBEDDING_PROFILES_STORAGE_KEY));
        const activeProfile = (0, embeddingProfiles_1.preferredEmbeddingProfile)(profiles, this.persistence.readState(embeddingProfiles_1.ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY));
        return { profiles, activeProfile };
    }
    pickerItems() {
        const { profiles, activeProfile } = this.state();
        return profiles.map((profile) => ({
            ...profile,
            providerLabel: embeddingProviderLabel(profile.provider),
            selected: profile.id === activeProfile?.id
        }));
    }
    async form(profileId) {
        if (profileId === undefined) {
            return { ok: true, value: { hasApiKey: false } };
        }
        const profile = this.state().profiles.find((candidate) => candidate.id === profileId);
        if (!profile) {
            return { ok: false, message: 'That embedding profile no longer exists.' };
        }
        try {
            const apiKey = await this.persistence.readSecret((0, embeddingProfiles_1.embeddingSecretKeyForProfile)(profile.id));
            return { ok: true, value: { profile, hasApiKey: Boolean(apiKey) } };
        }
        catch {
            return { ok: false, message: 'Could not read the embedding profile credential.' };
        }
    }
    async select(profileId) {
        const { profiles, activeProfile } = this.state();
        const profile = profiles.find((candidate) => candidate.id === profileId);
        if (!profile) {
            return { ok: false, message: 'That embedding profile no longer exists.' };
        }
        try {
            await this.persistence.writeState(embeddingProfiles_1.ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY, profile.id);
        }
        catch {
            return { ok: false, message: 'Could not select the embedding profile.' };
        }
        if (profile.id !== activeProfile?.id) {
            this.onActiveProfileChanged();
        }
        return { ok: true, value: profile };
    }
    async save(submission) {
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
        const draft = (0, embeddingProfiles_1.normalizeEmbeddingProfileDraft)({
            provider: submission.provider,
            model: submission.model,
            baseUrl: submission.baseUrl,
            remoteAllowed: submission.remoteAllowed
        });
        const validationError = (0, embeddingProfiles_1.validateEmbeddingProfileDraft)(draft);
        if (validationError) {
            return { ok: false, message: validationError };
        }
        let profileId = existingProfile?.id;
        if (!profileId) {
            try {
                profileId = uniqueProfileId(profiles, this.createId);
            }
            catch {
                return { ok: false, message: 'Could not create the embedding profile.' };
            }
        }
        const profile = { id: profileId, ...draft };
        const updatedProfiles = existingProfile
            ? profiles.map((candidate) => candidate.id === profile.id ? profile : candidate)
            : [...profiles, profile];
        const previousActiveId = activeProfile?.id;
        const nextActiveId = existingProfile ? previousActiveId : profile.id;
        const secretKey = (0, embeddingProfiles_1.embeddingSecretKeyForProfile)(profile.id);
        let previousSecret;
        try {
            previousSecret = await this.persistence.readSecret(secretKey);
        }
        catch {
            return { ok: false, message: 'Could not read the existing embedding credential.' };
        }
        const submittedApiKey = submission.apiKey?.trim();
        try {
            if (submittedApiKey) {
                await this.persistence.writeSecret(secretKey, submittedApiKey);
            }
            await this.persistence.writeState(embeddingProfiles_1.EMBEDDING_PROFILES_STORAGE_KEY, updatedProfiles);
            if (nextActiveId !== previousActiveId) {
                await this.persistence.writeState(embeddingProfiles_1.ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY, nextActiveId);
            }
        }
        catch {
            await this.restoreSaveState(profiles, previousActiveId, secretKey, previousSecret);
            return { ok: false, message: 'Could not save the embedding profile.' };
        }
        if (!existingProfile || existingProfile.id === activeProfile?.id) {
            this.onActiveProfileChanged();
        }
        return { ok: true, value: profile };
    }
    async delete(profileId) {
        const { profiles, activeProfile } = this.state();
        const profile = profiles.find((candidate) => candidate.id === profileId);
        if (!profile) {
            return { ok: false, message: 'That embedding profile no longer exists.' };
        }
        const remainingProfiles = profiles.filter((candidate) => candidate.id !== profile.id);
        const nextActiveProfile = (0, embeddingProfiles_1.preferredEmbeddingProfile)(remainingProfiles, activeProfile?.id === profile.id ? undefined : activeProfile?.id);
        const secretKey = (0, embeddingProfiles_1.embeddingSecretKeyForProfile)(profile.id);
        let previousSecret;
        try {
            previousSecret = await this.persistence.readSecret(secretKey);
        }
        catch {
            return { ok: false, message: 'Could not read the existing embedding credential.' };
        }
        try {
            await this.persistence.writeState(embeddingProfiles_1.EMBEDDING_PROFILES_STORAGE_KEY, remainingProfiles);
            await this.persistence.writeState(embeddingProfiles_1.ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY, nextActiveProfile?.id);
            await this.persistence.deleteSecret(secretKey);
        }
        catch {
            await this.restoreSaveState(profiles, activeProfile?.id, secretKey, previousSecret);
            return { ok: false, message: 'Could not delete the embedding profile.' };
        }
        if (activeProfile?.id === profile.id) {
            this.onActiveProfileChanged();
        }
        return { ok: true, value: profile };
    }
    async restoreSaveState(profiles, activeProfileId, secretKey, previousSecret) {
        try {
            await this.persistence.writeState(embeddingProfiles_1.EMBEDDING_PROFILES_STORAGE_KEY, profiles);
            await this.persistence.writeState(embeddingProfiles_1.ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY, activeProfileId);
            if (previousSecret === undefined) {
                await this.persistence.deleteSecret(secretKey);
            }
            else {
                await this.persistence.writeSecret(secretKey, previousSecret);
            }
        }
        catch {
            // The original persistence failure remains the useful error for the UI.
        }
    }
}
exports.EmbeddingProfileController = EmbeddingProfileController;
function embeddingProviderLabel(provider) {
    return provider === 'ollama' ? 'Ollama' : 'OpenAI-compatible';
}
function validateSubmission(submission) {
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
function uniqueProfileId(profiles, createId) {
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
//# sourceMappingURL=embeddingProfileController.js.map