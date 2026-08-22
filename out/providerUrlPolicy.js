"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeProviderBaseUrl = normalizeProviderBaseUrl;
exports.validateProviderBaseUrl = validateProviderBaseUrl;
exports.isLoopbackProviderBaseUrl = isLoopbackProviderBaseUrl;
const node_net_1 = require("node:net");
const unsafeProviderIpv4Addresses = createUnsafeProviderIpv4BlockList();
const unsafeProviderIpv6Addresses = createUnsafeProviderIpv6BlockList();
function normalizeProviderBaseUrl(value) {
    const normalized = value?.trim().replace(/\/+$/, '');
    return normalized || undefined;
}
function validateProviderBaseUrl(baseUrl) {
    if (!baseUrl) {
        return undefined;
    }
    try {
        const url = new URL(baseUrl);
        if (!['http:', 'https:'].includes(url.protocol)
            || url.username
            || url.password
            || url.search
            || url.hash) {
            return 'Use an HTTP or HTTPS base URL without credentials, query parameters, or fragments.';
        }
        if (url.protocol === 'http:' && !isLoopbackProviderHostname(url.hostname)) {
            return 'Use HTTPS for remote providers. Plain HTTP is allowed only for local loopback providers.';
        }
        if (isUnsafeProviderAddressLiteral(url.hostname)) {
            return 'Use a public provider address or an exact local loopback address.';
        }
    }
    catch {
        return 'Enter a valid base URL.';
    }
    return undefined;
}
function isLoopbackProviderBaseUrl(baseUrl) {
    try {
        return isLoopbackProviderHostname(new URL(baseUrl).hostname);
    }
    catch {
        return false;
    }
}
function isLoopbackProviderHostname(hostname) {
    const normalized = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, '');
    if (normalized === 'localhost' || normalized === '::1') {
        return true;
    }
    const parts = normalized.split('.');
    return parts.length === 4
        && parts[0] === '127'
        && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function isUnsafeProviderAddressLiteral(hostname) {
    const normalized = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, '');
    if (isLoopbackProviderHostname(normalized)) {
        return false;
    }
    const version = (0, node_net_1.isIP)(normalized);
    return version === 4
        ? unsafeProviderIpv4Addresses.check(normalized, 'ipv4')
        : version === 6 && unsafeProviderIpv6Addresses.check(normalized, 'ipv6');
}
function createUnsafeProviderIpv4BlockList() {
    const blockList = new node_net_1.BlockList();
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
    ]) {
        blockList.addSubnet(address, prefix, 'ipv4');
    }
    return blockList;
}
function createUnsafeProviderIpv6BlockList() {
    const blockList = new node_net_1.BlockList();
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
    ]) {
        blockList.addSubnet(address, prefix, 'ipv6');
    }
    return blockList;
}
//# sourceMappingURL=providerUrlPolicy.js.map