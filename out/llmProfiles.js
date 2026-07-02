"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUILT_IN_NEMOTRON_PROFILE = exports.BUILT_IN_NEMOTRON_PROFILE_ID = exports.PROVIDER_LABELS = exports.REASONING_EFFORT_LABELS = exports.LLM_REASONING_EFFORT_STORAGE_KEY = exports.ACTIVE_LLM_PROFILE_STORAGE_KEY = exports.LLM_PROFILES_STORAGE_KEY = void 0;
exports.normalizeProfileDraft = normalizeProfileDraft;
exports.validateProfileDraft = validateProfileDraft;
exports.parseStoredProfiles = parseStoredProfiles;
exports.profilesWithBuiltInNemotron = profilesWithBuiltInNemotron;
exports.isBuiltInLlmProfile = isBuiltInLlmProfile;
exports.isEquivalentNemotronProfile = isEquivalentNemotronProfile;
exports.providerLabelForProfile = providerLabelForProfile;
exports.reasoningEffortOptionsForProfile = reasoningEffortOptionsForProfile;
exports.parseReasoningEffortPreferences = parseReasoningEffortPreferences;
exports.reasoningEffortForProfile = reasoningEffortForProfile;
exports.secretKeyForProfile = secretKeyForProfile;
exports.LLM_PROFILES_STORAGE_KEY = 'devMate.llmProfiles.v1';
exports.ACTIVE_LLM_PROFILE_STORAGE_KEY = 'devMate.activeLlmProfileId.v1';
exports.LLM_REASONING_EFFORT_STORAGE_KEY = 'devMate.reasoningEffortByProfile.v1';
exports.REASONING_EFFORT_LABELS = {
    auto: 'Auto',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high'
};
exports.PROVIDER_LABELS = {
    openai: 'OpenAI',
    ollama: 'Ollama'
};
exports.BUILT_IN_NEMOTRON_PROFILE_ID = 'builtin-nemotron-3-ultra';
exports.BUILT_IN_NEMOTRON_PROFILE = Object.freeze({
    id: exports.BUILT_IN_NEMOTRON_PROFILE_ID,
    name: 'Nemotron 3 Ultra',
    provider: 'openai',
    model: 'nvidia/nemotron-3-ultra-550b-a55b',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    builtIn: true
});
const supportedProviders = new Set(['openai', 'ollama']);
const reasoningEfforts = new Set(['auto', 'low', 'medium', 'high', 'xhigh']);
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
function profilesWithBuiltInNemotron(profiles) {
    return [
        exports.BUILT_IN_NEMOTRON_PROFILE,
        ...profiles.filter((profile) => profile.id !== exports.BUILT_IN_NEMOTRON_PROFILE_ID)
    ];
}
function isBuiltInLlmProfile(profile) {
    return profile.id === exports.BUILT_IN_NEMOTRON_PROFILE_ID;
}
function isEquivalentNemotronProfile(profile) {
    return profile.provider === exports.BUILT_IN_NEMOTRON_PROFILE.provider
        && profile.model.toLocaleLowerCase() === exports.BUILT_IN_NEMOTRON_PROFILE.model.toLocaleLowerCase()
        && profile.baseUrl?.toLocaleLowerCase() === exports.BUILT_IN_NEMOTRON_PROFILE.baseUrl?.toLocaleLowerCase();
}
function providerLabelForProfile(profile) {
    return isBuiltInLlmProfile(profile) ? 'NVIDIA' : exports.PROVIDER_LABELS[profile.provider];
}
function reasoningEffortOptionsForProfile(profile) {
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
function parseReasoningEffortPreferences(value) {
    if (!isRecord(value)) {
        return {};
    }
    const entries = Object.entries(value)
        .filter(([id, effort]) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(id)
        && reasoningEfforts.has(effort))
        .slice(0, 100);
    return Object.fromEntries(entries);
}
function reasoningEffortForProfile(profile, preferences) {
    const preferred = preferences[profile.id] ?? 'auto';
    return reasoningEffortOptionsForProfile(profile).includes(preferred) ? preferred : 'auto';
}
function secretKeyForProfile(profileId) {
    return `devMate.llmProfile.${profileId}.apiKey`;
}
function isOfficialOpenAiProfile(profile) {
    if (profile.provider !== 'openai') {
        return false;
    }
    if (!profile.baseUrl) {
        return true;
    }
    try {
        return new URL(profile.baseUrl).hostname.toLocaleLowerCase() === 'api.openai.com';
    }
    catch {
        return false;
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
//# sourceMappingURL=llmProfiles.js.map