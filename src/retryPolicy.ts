import type { ApiResult } from './api/types';

export const PROVIDER_RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const;

const retryableStatusCodes = new Set([429, 502, 503, 504]);

export function isRetryableProviderFailure(result: ApiResult<unknown>): boolean {
  if (result.status !== 'error' || result.errorKind !== 'http') {
    return false;
  }
  const message = result.message ?? '';
  if (
    /response budget for reasoning/i.test(message)
    || /empty (?:or invalid |final )?answer/i.test(message)
    || /file-change response/i.test(message)
    || /invalid tool/i.test(message)
    || /non-json response/i.test(message)
    || /returned a redirect/i.test(message)
  ) {
    return false;
  }
  if (result.statusCode !== undefined) {
    return retryableStatusCodes.has(result.statusCode);
  }
  return /resource\s*exhausted/i.test(message);
}

export function providerRetryDelay(retryNumber: number): number | undefined {
  return PROVIDER_RETRY_DELAYS_MS[retryNumber - 1];
}
