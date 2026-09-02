// Apply the shared provider URL rules used by model-profile validation.
// Remote endpoints need HTTPS; plain HTTP is limited to loopback addresses.

import { BlockList, isIP } from 'node:net';

const unsafeProviderIpv4Addresses = createUnsafeProviderIpv4BlockList();
const unsafeProviderIpv6Addresses = createUnsafeProviderIpv6BlockList();

export function normalizeProviderBaseUrl(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\/+$/, '');
  return normalized || undefined;
}

export function validateProviderBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) {
    return undefined;
  }

  try {
    const url = new URL(baseUrl);
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

  return undefined;
}

export function isLoopbackProviderBaseUrl(baseUrl: string): boolean {
  try {
    return isLoopbackProviderHostname(new URL(baseUrl).hostname);
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
