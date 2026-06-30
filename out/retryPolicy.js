"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROVIDER_RETRY_DELAYS_MS = void 0;
exports.isRetryableProviderFailure = isRetryableProviderFailure;
exports.providerRetryDelay = providerRetryDelay;
exports.PROVIDER_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
const retryableStatusCodes = new Set([429, 502, 503, 504]);
function isRetryableProviderFailure(result) {
    if (result.status !== 'error' || result.errorKind !== 'http') {
        return false;
    }
    const message = result.message ?? '';
    if (/response budget for reasoning/i.test(message)
        || /empty (?:or invalid |final )?answer/i.test(message)
        || /file-change response/i.test(message)
        || /invalid tool/i.test(message)
        || /non-json response/i.test(message)
        || /returned a redirect/i.test(message)) {
        return false;
    }
    if (result.statusCode !== undefined) {
        return retryableStatusCodes.has(result.statusCode);
    }
    return /resource\s*exhausted/i.test(message);
}
function providerRetryDelay(retryNumber) {
    return exports.PROVIDER_RETRY_DELAYS_MS[retryNumber - 1];
}
//# sourceMappingURL=retryPolicy.js.map