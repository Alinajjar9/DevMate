"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROVIDER_LABELS = exports.ACTIVE_LLM_PROFILE_STORAGE_KEY = exports.LLM_PROFILES_STORAGE_KEY = void 0;
exports.normalizeProfileDraft = normalizeProfileDraft;
exports.validateProfileDraft = validateProfileDraft;
exports.parseStoredProfiles = parseStoredProfiles;
exports.secretKeyForProfile = secretKeyForProfile;
exports.LLM_PROFILES_STORAGE_KEY = 'devMate.llmProfiles.v1';
exports.ACTIVE_LLM_PROFILE_STORAGE_KEY = 'devMate.activeLlmProfileId.v1';
exports.PROVIDER_LABELS = {
    openai: 'OpenAI',
    ollama: 'Ollama'
};
const supportedProviders = new Set(['openai', 'ollama']);
function normalizeProfileDraft(draft) {
    const baseUrl = draft.baseUrl?.trim().replace(/\/+$/, '');
    return {
        name: draft.name.trim(),
        provider: draft.provider,
        model: draft.model.trim(),
        ...(baseUrl ? { baseUrl } : {})
    };
}
function validateProfileDraft(draft, existingProfiles, editingProfileId) {
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
    if (existingProfiles.some((profile) => profile.id !== editingProfileId
        && profile.name.localeCompare(normalized.name, undefined, { sensitivity: 'accent' }) === 0)) {
        return `A model profile named "${normalized.name}" already exists.`;
    }
    if (normalized.baseUrl) {
        try {
            const url = new URL(normalized.baseUrl);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
                return 'Use an HTTP or HTTPS base URL without embedded credentials.';
            }
        }
        catch {
            return 'Enter a valid base URL.';
        }
    }
    return undefined;
}
function parseStoredProfiles(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const profiles = [];
    const seenIds = new Set();
    const seenNames = new Set();
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
        if (!id
            || !name
            || !model
            || !supportedProviders.has(provider)
            || seenIds.has(id)
            || seenNames.has(normalizedName)) {
            continue;
        }
        const profile = {
            id,
            name,
            provider: provider,
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
function secretKeyForProfile(profileId) {
    return `devMate.llmProfile.${profileId}.apiKey`;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
//# sourceMappingURL=llmProfiles.js.map