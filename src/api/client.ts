import type { ApiResult, AskRequest, AskResponse, HealthResponse } from './types';

const HEALTH_TIMEOUT_MS = 2_000;
const ASK_TIMEOUT_MS = 30_000;

export async function health(backendUrl: string): Promise<ApiResult<HealthResponse>> {
  return request<HealthResponse>(backendUrl, '/health', { method: 'GET' }, HEALTH_TIMEOUT_MS);
}

export async function ask(backendUrl: string, askRequest: AskRequest): Promise<ApiResult<AskResponse>> {
  return request<AskResponse>(
    backendUrl,
    '/ask',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(askRequest)
    },
    ASK_TIMEOUT_MS
  );
}

async function request<T>(
  backendUrl: string,
  path: string,
  init: RequestInit,
  timeoutMilliseconds: number
): Promise<ApiResult<T>> {
  const endpoint = createEndpoint(backendUrl, path);
  if (!endpoint) {
    return {
      status: 'error',
      message: `Invalid DevMate backend URL: ${backendUrl}`
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);

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
        message: `The DevMate backend request timed out after ${timeoutMilliseconds / 1_000} seconds.`
      };
    }

    return {
      status: 'error',
      message: `Cannot reach the DevMate backend at ${backendUrl}. Start the local backend and try again.`
    };
  } finally {
    clearTimeout(timeout);
  }
}

function createEndpoint(backendUrl: string, path: string): string | undefined {
  try {
    const normalizedBaseUrl = backendUrl.endsWith('/') ? backendUrl : `${backendUrl}/`;
    return new URL(path.replace(/^\//, ''), normalizedBaseUrl).toString();
  } catch {
    return undefined;
  }
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

  return `The DevMate backend returned HTTP ${status}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
