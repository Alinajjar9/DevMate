// Own HTTP deadlines, cancellation, response-size limits, and NDJSON framing.
// Endpoint functions and provider credentials stay in client.ts.

import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import type { ClientRequest, IncomingMessage } from 'http';
import { StringDecoder } from 'string_decoder';
import type { ApiResult, AskResponse, TokenUsage } from './types';
import {
  MAX_BACKEND_RESPONSE_BYTES,
  hasOnlyKeys,
  isBoundedNonEmptyString,
  isRecord,
  isSuccessEnvelope,
  parseAskResponse,
  parseBackendHttpError,
  parseStreamError,
  parseSuccessResult,
  parseTokenUsage
} from './backendResponseProtocol';

const MAX_BACKEND_ERROR_RESPONSE_BYTES = 64_000;

export type AskStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'progress'; phase: string }
  | { type: 'usage'; usage: TokenUsage };

export type AskStreamResult = {
  result: ApiResult<AskResponse>;
  unsupported: boolean;
};

export async function fetchJsonRequest<T>(
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
      return parseBackendHttpError(response.status, payload);
    }

    if (!isSuccessEnvelope(payload) || !hasOnlyKeys(payload, ['status', 'data'])) {
      return {
        status: 'error',
        message: 'The DevMate backend returned an invalid response.',
        errorKind: 'invalid-response'
      };
    }

    return { status: 'ok', data: payload.data as T };
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

// Node's HTTP client gives long provider calls an explicit deadline instead of fetch's header timeout.
export async function nodeHttpJsonRequest<T>(
  backendUrl: string,
  requestPath: string,
  init: NodeJsonRequestInit,
  decodeData: (value: unknown) => T | undefined,
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

    // Timeout, cancellation, and socket errors can race; complete the promise and cleanup only once.
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
          // Bound the raw response before collecting/decoding untrusted JSON.
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
            finish(parseBackendHttpError(statusCode, payload));
            return;
          }
          const result = parseSuccessResult(payload, decodeData);
          if (!result) {
            finish({
              status: 'error',
              message: 'The DevMate backend returned an invalid response.',
              errorKind: 'invalid-response'
            });
            return;
          }
          finish(result);
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

export async function nodeHttpStreamRequest(
  backendUrl: string,
  requestPath: string,
  init: NodeJsonRequestInit,
  timeoutMilliseconds: number,
  externalSignal?: AbortSignal,
  onEvent?: (event: AskStreamEvent) => void
): Promise<AskStreamResult> {
  const endpointValue = createEndpoint(backendUrl, requestPath);
  if (!endpointValue) {
    return {
      result: {
        status: 'error',
        message: `Invalid DevMate backend URL: ${backendUrl}`,
        errorKind: 'configuration'
      },
      unsupported: false
    };
  }
  if (externalSignal?.aborted) {
    return { result: cancelledResult(), unsupported: false };
  }

  const endpoint = new URL(endpointValue);
  return new Promise((resolve) => {
    let backendRequest: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let receivedBytes = 0;
    let lineBuffer = '';
    let finalResult: ApiResult<AskResponse> | undefined;
    let receivedStart = false;
    // Network chunks can split a UTF-8 character or a JSON line. Preserve both partial fragments.
    const decoder = new StringDecoder('utf8');

    const finish = (result: AskStreamResult) => {
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
          result: {
            status: 'error',
            message: `The DevMate backend request timed out after ${timeoutMilliseconds / 1_000} seconds.`,
            errorKind: 'timeout'
          },
          unsupported: false
        });
        return;
      }
      if (cancelled) {
        finish({ result: cancelledResult(), unsupported: false });
        return;
      }
      finish({
        result: {
          status: 'error',
          message: `Cannot reach the DevMate backend at ${backendUrl}. Start the local backend and try again.`,
          errorKind: 'network'
        },
        unsupported: false
      });
    };
    const cancelRequest = () => {
      cancelled = true;
      response?.destroy();
      backendRequest?.destroy();
      failTransport();
    };
    const processLine = (line: string) => {
      const normalized = line.trim();
      if (!normalized || settled) {
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(normalized) as unknown;
      } catch {
        finish({
          result: {
            status: 'error',
            message: 'The DevMate backend returned an invalid streaming event.',
            errorKind: 'invalid-response'
          },
          unsupported: false
        });
        return;
      }
      if (!isRecord(value) || typeof value.type !== 'string') {
        finish(invalidStreamResult());
        return;
      }
      // A valid stream has one start, intermediate events, and one terminal result in that order.
      if (finalResult) {
        finish(invalidStreamResult());
        return;
      }
      if (value.type === 'start') {
        if (receivedStart || !hasOnlyKeys(value, ['type'])) {
          finish(invalidStreamResult());
          return;
        }
        receivedStart = true;
        return;
      }
      if (!receivedStart) {
        finish(invalidStreamResult());
        return;
      }
      if (value.type === 'delta'
        && hasOnlyKeys(value, ['type', 'text'])
        && typeof value.text === 'string'
        && value.text.length > 0
        && value.text.length <= MAX_BACKEND_RESPONSE_BYTES) {
        onEvent?.({ type: 'delta', text: value.text });
        return;
      }
      if (value.type === 'progress'
        && hasOnlyKeys(value, ['type', 'phase'])
        && isBoundedNonEmptyString(value.phase, 120)) {
        onEvent?.({ type: 'progress', phase: value.phase });
        return;
      }
      if (value.type === 'usage' && hasOnlyKeys(value, ['type', 'usage'])) {
        const usage = parseTokenUsage(value.usage);
        if (usage) {
          onEvent?.({ type: 'usage', usage });
          return;
        }
      }
      if (value.type === 'final' && hasOnlyKeys(value, ['type', 'result'])) {
        const result = parseSuccessResult(value.result, parseAskResponse);
        if (result) {
          finalResult = result;
          return;
        }
      }
      if (value.type === 'error') {
        const errorResult = parseStreamError(value);
        if (errorResult) {
          finalResult = errorResult;
          return;
        }
      }
      finish(invalidStreamResult());
    };

    try {
      const requestFunction = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
      backendRequest = requestFunction(endpoint, {
        method: init.method,
        headers: init.headers
      }, (incomingResponse) => {
        response = incomingResponse;
        const statusCode = incomingResponse.statusCode ?? 0;
        // Only an unsupported streaming endpoint should trigger the ordinary completion fallback.
        if (statusCode === 404 || statusCode === 405) {
          incomingResponse.resume();
          finish({
            result: {
              status: 'error',
              message: 'The configured backend does not support response streaming.',
              statusCode,
              errorKind: 'http'
            },
            unsupported: true
          });
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          const chunks: Buffer[] = [];
          let errorBytes = 0;
          incomingResponse.on('data', (value: Buffer | string) => {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            errorBytes += chunk.length;
            if (errorBytes > MAX_BACKEND_ERROR_RESPONSE_BYTES) {
              finish({
                result: {
                  status: 'error',
                  message: `The DevMate backend returned HTTP ${statusCode} with an oversized error response.`,
                  statusCode,
                  errorKind: 'invalid-response'
                },
                unsupported: false
              });
              incomingResponse.destroy();
              return;
            }
            chunks.push(chunk);
          });
          incomingResponse.on('end', () => {
            const payload = readNodeJson(incomingResponse, Buffer.concat(chunks));
            finish({
              result: parseBackendHttpError(statusCode, payload),
              unsupported: false
            });
          });
          incomingResponse.on('error', failTransport);
          incomingResponse.on('aborted', failTransport);
          return;
        }
        const contentType = incomingResponse.headers['content-type'];
        const normalizedContentType = Array.isArray(contentType) ? contentType.join(';') : contentType;
        if (!normalizedContentType?.includes('application/x-ndjson')) {
          incomingResponse.resume();
          finish({
            result: {
              status: 'error',
              message: 'The configured backend does not support response streaming.',
              errorKind: 'invalid-response'
            },
            unsupported: true
          });
          return;
        }
        incomingResponse.on('data', (value: Buffer | string) => {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          receivedBytes += chunk.length;
          if (receivedBytes > MAX_BACKEND_RESPONSE_BYTES) {
            finish({
              result: {
                status: 'error',
                message: 'The DevMate backend returned an oversized streaming response.',
                errorKind: 'invalid-response'
              },
              unsupported: false
            });
            incomingResponse.destroy();
            return;
          }
          // Process complete NDJSON lines now; keep the unfinished final line for the next chunk.
          lineBuffer += decoder.write(chunk);
          let newline = lineBuffer.indexOf('\n');
          while (newline >= 0) {
            processLine(lineBuffer.slice(0, newline));
            lineBuffer = lineBuffer.slice(newline + 1);
            newline = lineBuffer.indexOf('\n');
          }
        });
        incomingResponse.on('end', () => {
          if (settled) {
            return;
          }
          lineBuffer += decoder.end();
          if (lineBuffer.trim()) {
            processLine(lineBuffer);
          }
          // Partial answer text is not a successful completion without a validated final event.
          finish({
            result: finalResult ?? {
              status: 'error',
              message: 'The DevMate backend stream ended without a final response.',
              errorKind: 'invalid-response'
            },
            unsupported: false
          });
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

function invalidStreamResult(): AskStreamResult {
  return {
    result: {
      status: 'error',
      message: 'The DevMate backend returned an invalid streaming event.',
      errorKind: 'invalid-response'
    },
    unsupported: false
  };
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
