import type { ApiResult, AskRequest, AskResponse, HealthResponse } from './types';

const HEALTH_TIMEOUT_MS = 2_000;
export const DEFAULT_ASK_TIMEOUT_MS = 330_000;
const PROVIDER_KEY_HEADER = 'X-DevMate-Provider-Key';

export async function health(backendUrl: string): Promise<ApiResult<HealthResponse>> {
  return request<HealthResponse>(backendUrl, '/health', { method: 'GET' }, HEALTH_TIMEOUT_MS);
}

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
      message: 'DevMate only sends provider API keys to a backend running on this computer.'
    };
  }

  return request<AskResponse>(
    backendUrl,
    '/ask',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(providerApiKey ? { [PROVIDER_KEY_HEADER]: providerApiKey } : {})
      },
      body: JSON.stringify(askRequest)
    },
    timeoutMilliseconds,
    signal
  );
}

async function request<T>(
  backendUrl: string,
  path: string,
  init: RequestInit,
  timeoutMilliseconds: number,
  externalSignal?: AbortSignal
): Promise<ApiResult<T>> {
  const endpoint = createEndpoint(backendUrl, path);
  if (!endpoint) {
    return {
      status: 'error',
      message: `Invalid DevMate backend URL: ${backendUrl}`
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMilliseconds);
  const cancelRequest = () => controller.abort();
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener('abort', cancelRequest, { once: true });
  }

  try {
    const response = await fetch(endpoint, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...init.headers
      },
      signal: controller.signal
    });

    const payload = await readJson(response);
    if (!response.ok) {
      return {
        status: 'error',
        message: getHttpErrorMessage(response.status, payload)
      };
    }

    if (!isApiResult<T>(payload)) {
      return {
        status: 'error',
        message: 'The DevMate backend returned an invalid response.'
      };
    }

    return payload;
  } catch (error) {
    if (isAbortError(error)) {
      return {
        status: 'error',
        message: timedOut
          ? `The DevMate backend request timed out after ${timeoutMilliseconds / 1_000} seconds.`
          : 'Request cancelled.'
      };
    }

    return {
      status: 'error',
      message: `Cannot reach the DevMate backend at ${backendUrl}. Start the local backend and try again.`
    };
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', cancelRequest);
  }
}

function createEndpoint(backendUrl: string, path: string): string | undefined {
  try {
    const normalizedBaseUrl = backendUrl.endsWith('/') ? backendUrl : `${backendUrl}/`;
    const endpoint = new URL(path.replace(/^\//, ''), normalizedBaseUrl);
    return ['http:', 'https:'].includes(endpoint.protocol) ? endpoint.toString() : undefined;
  } catch {
    return undefined;
  }
}

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

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    return undefined;
  }

  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isApiResult<T>(value: unknown): value is ApiResult<T> {
  if (!isRecord(value)) {
    return false;
  }

  if (value.status === 'ok') {
    return 'data' in value;
  }

  return value.status === 'error' && (value.message === undefined || typeof value.message === 'string');
}

function getHttpErrorMessage(status: number, payload: unknown): string {
  if (isRecord(payload) && typeof payload.message === 'string') {
    return payload.message;
  }
  if (isRecord(payload) && typeof payload.detail === 'string') {
    return payload.detail;
  }

  return `The DevMate backend returned HTTP ${status}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
