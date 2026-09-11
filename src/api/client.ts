/** Backend endpoint wrappers; transport details live in transport.ts and provider keys are sent only to loopback. */

import type { ApiResult, AskRequest, AskResponse, HealthResponse } from './types';
import { fetchJson, requestJson, requestStream } from './transport';
import type { AskStreamEvent, AskStreamResult } from './transport';

export type { AskStreamEvent, AskStreamResult } from './transport';

const HEALTH_TIMEOUT_MS = 2_000;
export const DEFAULT_ASK_TIMEOUT_MS = 930_000;
const PROVIDER_KEY_HEADER = 'X-DevMate-Provider-Key';

export async function health(backendUrl: string): Promise<ApiResult<HealthResponse>> {
  return fetchJson<HealthResponse>(backendUrl, '/health', { method: 'GET' }, HEALTH_TIMEOUT_MS);
}

/** Send one complete request to /ask. Provider credentials travel in a header, outside the JSON prompt payload. */
export async function ask(
  backendUrl: string,
  askRequest: AskRequest,
  providerApiKey?: string,
  timeoutMilliseconds = DEFAULT_ASK_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<ApiResult<AskResponse>> {
  if (providerApiKey && !isLoopbackBackendUrl(backendUrl)) {
    return {
      status: 'error',
      message: 'DevMate only sends provider API keys to a backend running on this computer.',
      errorKind: 'configuration'
    };
  }

  return requestJson<AskResponse>(
    backendUrl,
    '/ask',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Encoding': 'identity',
        ...(providerApiKey ? { [PROVIDER_KEY_HEADER]: providerApiKey } : {})
      },
      body: JSON.stringify(askRequest)
    },
    timeoutMilliseconds,
    signal
  );
}

/** Send the streaming request and forward progress, text and usage events; unsupported tells the runner to try JSON. */
export async function askStream(
  backendUrl: string,
  askRequest: AskRequest,
  providerApiKey?: string,
  timeoutMilliseconds = DEFAULT_ASK_TIMEOUT_MS,
  signal?: AbortSignal,
  onEvent?: (event: AskStreamEvent) => void
): Promise<AskStreamResult> {
  if (providerApiKey && !isLoopbackBackendUrl(backendUrl)) {
    return {
      result: {
        status: 'error',
        message: 'DevMate only sends provider API keys to a backend running on this computer.',
        errorKind: 'configuration'
      },
      unsupported: false
    };
  }
  return requestStream(
    backendUrl,
    '/ask/stream',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson',
        'Accept-Encoding': 'identity',
        ...(providerApiKey ? { [PROVIDER_KEY_HEADER]: providerApiKey } : {})
      },
      body: JSON.stringify(askRequest)
    },
    timeoutMilliseconds,
    signal,
    onEvent
  );
}

/** Limit credential forwarding to recognized local HTTP(S) addresses without embedded URL credentials. */
export function isLoopbackBackendUrl(backendUrl: string): boolean {
  try {
    const url = new URL(backendUrl);
    const hostname = url.hostname.toLocaleLowerCase();
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username
      && !url.password
      && (
        hostname === 'localhost'
        || hostname === '[::1]'
        || hostname === '::1'
        || isLoopbackIpv4(hostname)
      );
  } catch {
    return false;
  }
}

function isLoopbackIpv4(hostname: string): boolean {
  const parts = hostname.split('.');
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
