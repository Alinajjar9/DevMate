import { BlockList, isIP } from 'node:net';

export const LLM_PROFILES_STORAGE_KEY = 'devMate.llmProfiles.v1';
export const ACTIVE_LLM_PROFILE_STORAGE_KEY = 'devMate.activeLlmProfileId.v1';
export const LLM_REASONING_EFFORT_STORAGE_KEY = 'devMate.reasoningEffortByProfile.v1';

export type LlmProvider = 'openai' | 'ollama';
export type ReasoningEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh';

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
const unsafeProviderIpv4Addresses = createUnsafeProviderIpv4BlockList();
const unsafeProviderIpv6Addresses = createUnsafeProviderIpv6BlockList();

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
      if (
        !['http:', 'https:'].includes(url.protocol)
        || url.username
        || url.password
        || url.search
        || url.hash
      ) {
        return 'Use an HTTP or HTTPS base URL without credentials, query parameters, or fragments.';
      }
      if (url.protocol === 'http:' && !isLoopbackProviderHostname(url.hostname)) {
        return 'Use HTTPS for remote providers. Plain HTTP is allowed only for local loopback providers.';
      }
      if (isUnsafeProviderAddressLiteral(url.hostname)) {
        return 'Use a public provider address or an exact local loopback address.';
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

function isLoopbackProviderHostname(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') {
    return true;
  }
  const parts = normalized.split('.');
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isUnsafeProviderAddressLiteral(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, '');
  if (isLoopbackProviderHostname(normalized)) {
    return false;
  }
  const version = isIP(normalized);
  return version === 4
    ? unsafeProviderIpv4Addresses.check(normalized, 'ipv4')
    : version === 6 && unsafeProviderIpv6Addresses.check(normalized, 'ipv6');
}

function createUnsafeProviderIpv4BlockList(): BlockList {
  const blockList = new BlockList();
  for (const [address, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
  ] as const) {
    blockList.addSubnet(address, prefix, 'ipv4');
  }
  return blockList;
}

function createUnsafeProviderIpv6BlockList(): BlockList {
  const blockList = new BlockList();
  for (const [address, prefix] of [
    ['::', 96],
    ['::ffff:0:0', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001:2::', 48],
    ['2001:db8::', 32],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8]
  ] as const) {
    blockList.addSubnet(address, prefix, 'ipv6');
  }
  return blockList;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
