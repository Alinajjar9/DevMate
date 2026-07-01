import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import type { ClientRequest, IncomingMessage } from 'http';
import type { ApiResult, AskRequest, AskResponse, HealthResponse } from './types';

const HEALTH_TIMEOUT_MS = 2_000;
export const DEFAULT_ASK_TIMEOUT_MS = 930_000;
const PROVIDER_KEY_HEADER = 'X-DevMate-Provider-Key';
const MAX_BACKEND_RESPONSE_BYTES = 4_000_000;

export async function health(backendUrl: string): Promise<ApiResult<HealthResponse>> {
  return fetchJsonRequest<HealthResponse>(backendUrl, '/health', { method: 'GET' }, HEALTH_TIMEOUT_MS);
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
      message: 'DevMate only sends provider API keys to a backend running on this computer.',
      errorKind: 'configuration'
    };
  }

  return nodeHttpJsonRequest<AskResponse>(
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

async function fetchJsonRequest<T>(
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
      message: `Invalid DevMate backend URL: ${backendUrl}`,
      errorKind: 'configuration'
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
        message: getHttpErrorMessage(response.status, payload),
        statusCode: response.status,
        errorKind: 'http'
      };
    }

    if (!isApiResult<T>(payload)) {
      return {
        status: 'error',
        message: 'The DevMate backend returned an invalid response.',
        errorKind: 'invalid-response'
      };
    }

    return payload;
  } catch (error) {
    if (isAbortError(error)) {
      return {
        status: 'error',
        message: timedOut
          ? `The DevMate backend request timed out after ${timeoutMilliseconds / 1_000} seconds.`
          : 'Request cancelled.',
        errorKind: timedOut ? 'timeout' : 'cancelled'
      };
    }

    return {
      status: 'error',
      message: `Cannot reach the DevMate backend at ${backendUrl}. Start the local backend and try again.`,
      errorKind: 'network'
    };
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', cancelRequest);
  }
}

type NodeJsonRequestInit = {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
};

async function nodeHttpJsonRequest<T>(
  backendUrl: string,
  requestPath: string,
  init: NodeJsonRequestInit,
  timeoutMilliseconds: number,
  externalSignal?: AbortSignal
): Promise<ApiResult<T>> {
  const endpointValue = createEndpoint(backendUrl, requestPath);
  if (!endpointValue) {
    return {
      status: 'error',
      message: `Invalid DevMate backend URL: ${backendUrl}`,
      errorKind: 'configuration'
    };
  }
  if (externalSignal?.aborted) {
    return cancelledResult();
  }

  const endpoint = new URL(endpointValue);
  return new Promise((resolve) => {
    let backendRequest: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let timedOut = false;
    let cancelled = false;

    const finish = (result: ApiResult<T>) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      externalSignal?.removeEventListener('abort', cancelRequest);
      resolve(result);
    };
    const failTransport = () => {
      if (timedOut) {
        finish({
          status: 'error',
          message: `The DevMate backend request timed out after ${timeoutMilliseconds / 1_000} seconds.`,
          errorKind: 'timeout'
        });
        return;
      }
      if (cancelled) {
        finish(cancelledResult());
        return;
      }
      finish({
        status: 'error',
        message: `Cannot reach the DevMate backend at ${backendUrl}. Start the local backend and try again.`,
        errorKind: 'network'
      });
    };
    const cancelRequest = () => {
      cancelled = true;
      response?.destroy();
      backendRequest?.destroy();
      failTransport();
    };

    try {
      const requestFunction = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
      backendRequest = requestFunction(endpoint, {
        method: init.method,
        headers: init.headers
      }, (incomingResponse) => {
        response = incomingResponse;
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        incomingResponse.on('data', (value: Buffer | string) => {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          receivedBytes += chunk.length;
          if (receivedBytes > MAX_BACKEND_RESPONSE_BYTES) {
            finish({
              status: 'error',
              message: 'The DevMate backend returned an oversized response.',
              errorKind: 'invalid-response'
            });
            incomingResponse.destroy();
            return;
          }
          chunks.push(chunk);
        });
        incomingResponse.on('end', () => {
          if (settled) {
            return;
          }
          const payload = readNodeJson(incomingResponse, Buffer.concat(chunks));
          const statusCode = incomingResponse.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            finish({
              status: 'error',
              message: getHttpErrorMessage(statusCode, payload),
              statusCode,
              errorKind: 'http'
            });
            return;
          }
          if (!isApiResult<T>(payload)) {
            finish({
              status: 'error',
              message: 'The DevMate backend returned an invalid response.',
              errorKind: 'invalid-response'
            });
            return;
          }
          finish(payload);
        });
        incomingResponse.on('error', failTransport);
        incomingResponse.on('aborted', failTransport);
      });
      backendRequest.on('error', failTransport);
      timer = setTimeout(() => {
        timedOut = true;
        response?.destroy();
        backendRequest?.destroy();
        failTransport();
      }, timeoutMilliseconds);
      externalSignal?.addEventListener('abort', cancelRequest, { once: true });
      backendRequest.end(init.body);
    } catch {
      failTransport();
    }
  });
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

function readNodeJson(response: IncomingMessage, body: Buffer): unknown {
  const contentType = response.headers['content-type'];
  const normalizedContentType = Array.isArray(contentType) ? contentType.join(';') : contentType;
  if (!normalizedContentType?.includes('application/json')) {
    return undefined;
  }
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function cancelledResult<T>(): ApiResult<T> {
  return {
    status: 'error',
    message: 'Request cancelled.',
    errorKind: 'cancelled'
  };
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
