"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMBEDDING_PROVIDER_NAMES = exports.ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY = exports.EMBEDDING_PROFILES_STORAGE_KEY = void 0;
exports.normalizeEmbeddingProfileDraft = normalizeEmbeddingProfileDraft;
exports.validateEmbeddingProfileDraft = validateEmbeddingProfileDraft;
exports.parseStoredEmbeddingProfiles = parseStoredEmbeddingProfiles;
exports.preferredEmbeddingProfile = preferredEmbeddingProfile;
exports.embeddingSecretKeyForProfile = embeddingSecretKeyForProfile;
exports.readPreferredEmbeddingProfile = readPreferredEmbeddingProfile;
const providerUrlPolicy_1 = require("./providerUrlPolicy");
exports.EMBEDDING_PROFILES_STORAGE_KEY = 'devMate.embeddingProfiles.v1';
exports.ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY = 'devMate.activeEmbeddingProfileId.v1';
exports.EMBEDDING_PROVIDER_NAMES = ['ollama', 'openai-compatible'];
const supportedProviders = new Set(exports.EMBEDDING_PROVIDER_NAMES);
const profileIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
function normalizeEmbeddingProfileDraft(draft) {
    return {
        provider: draft.provider,
        model: draft.model.trim(),
        baseUrl: (0, providerUrlPolicy_1.normalizeProviderBaseUrl)(draft.baseUrl) ?? '',
        remoteAllowed: draft.remoteAllowed === true
    };
}
function validateEmbeddingProfileDraft(draft) {
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
    const baseUrlError = (0, providerUrlPolicy_1.validateProviderBaseUrl)(normalized.baseUrl);
    if (baseUrlError) {
        return baseUrlError;
    }
    if (!normalized.remoteAllowed && !(0, providerUrlPolicy_1.isLoopbackProviderBaseUrl)(normalized.baseUrl)) {
        return 'Remote embedding providers require explicit opt-in.';
    }
    return undefined;
}
function parseStoredEmbeddingProfiles(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const profiles = [];
    const seenIds = new Set();
    for (const candidate of value) {
        if (!isRecord(candidate)) {
            continue;
        }
        const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
        const draft = normalizeEmbeddingProfileDraft({
            provider: candidate.provider,
            model: typeof candidate.model === 'string' ? candidate.model : '',
            baseUrl: typeof candidate.baseUrl === 'string' ? candidate.baseUrl : '',
            remoteAllowed: candidate.remoteAllowed === true
        });
        if (!profileIdPattern.test(id)
            || seenIds.has(id)
            || validateEmbeddingProfileDraft(draft)) {
            continue;
        }
        seenIds.add(id);
        profiles.push({ id, ...draft });
    }
    return profiles;
}
function preferredEmbeddingProfile(profiles, activeProfileId) {
    const active = typeof activeProfileId === 'string'
        ? profiles.find((profile) => profile.id === activeProfileId)
        : undefined;
    return active
        ?? profiles.find((profile) => profile.provider === 'ollama' && isLocalProfile(profile))
        ?? profiles.find(isLocalProfile)
        ?? profiles[0];
}
function embeddingSecretKeyForProfile(profileId) {
    if (!profileIdPattern.test(profileId)) {
        throw new Error('Embedding profile ID is invalid.');
    }
    return `devMate.embeddingProfile.${profileId}.apiKey`;
}
async function readPreferredEmbeddingProfile(reader) {
    const profile = preferredEmbeddingProfile(parseStoredEmbeddingProfiles(reader.readProfiles()), reader.readActiveProfileId());
    if (!profile) {
        return undefined;
    }
    const apiKey = await reader.readSecret(profile.id);
    return {
        ...profile,
        ...(apiKey !== undefined ? { apiKey } : {})
    };
}
function isLocalProfile(profile) {
    return (0, providerUrlPolicy_1.isLoopbackProviderBaseUrl)(profile.baseUrl);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=embeddingProfiles.js.map