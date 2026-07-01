"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ASK_TIMEOUT_MS = void 0;
exports.health = health;
exports.ask = ask;
exports.isLoopbackBackendUrl = isLoopbackBackendUrl;
const http_1 = require("http");
const https_1 = require("https");
const HEALTH_TIMEOUT_MS = 2_000;
exports.DEFAULT_ASK_TIMEOUT_MS = 930_000;
const PROVIDER_KEY_HEADER = 'X-DevMate-Provider-Key';
const MAX_BACKEND_RESPONSE_BYTES = 4_000_000;
async function health(backendUrl) {
    return fetchJsonRequest(backendUrl, '/health', { method: 'GET' }, HEALTH_TIMEOUT_MS);
}
async function ask(backendUrl, askRequest, providerApiKey, timeoutMilliseconds = exports.DEFAULT_ASK_TIMEOUT_MS, signal) {
    if (providerApiKey && !isLoopbackBackendUrl(backendUrl)) {
        return {
            status: 'error',
            message: 'DevMate only sends provider API keys to a backend running on this computer.',
            errorKind: 'configuration'
        };
    }
    return nodeHttpJsonRequest(backendUrl, '/ask', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Accept-Encoding': 'identity',
            ...(providerApiKey ? { [PROVIDER_KEY_HEADER]: providerApiKey } : {})
        },
        body: JSON.stringify(askRequest)
    }, timeoutMilliseconds, signal);
}
async function fetchJsonRequest(backendUrl, path, init, timeoutMilliseconds, externalSignal) {
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
    }
    else {
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
        if (!isApiResult(payload)) {
            return {
                status: 'error',
                message: 'The DevMate backend returned an invalid response.',
                errorKind: 'invalid-response'
            };
        }
        return payload;
    }
    catch (error) {
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
    }
    finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener('abort', cancelRequest);
    }
}
async function nodeHttpJsonRequest(backendUrl, requestPath, init, timeoutMilliseconds, externalSignal) {
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
        let backendRequest;
        let response;
        let timer;
        let settled = false;
        let timedOut = false;
        let cancelled = false;
        const finish = (result) => {
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
            const requestFunction = endpoint.protocol === 'https:' ? https_1.request : http_1.request;
            backendRequest = requestFunction(endpoint, {
                method: init.method,
                headers: init.headers
            }, (incomingResponse) => {
                response = incomingResponse;
                const chunks = [];
                let receivedBytes = 0;
                incomingResponse.on('data', (value) => {
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
                    if (!isApiResult(payload)) {
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
        }
        catch {
            failTransport();
        }
    });
}
function createEndpoint(backendUrl, path) {
    try {
        const normalizedBaseUrl = backendUrl.endsWith('/') ? backendUrl : `${backendUrl}/`;
        const endpoint = new URL(path.replace(/^\//, ''), normalizedBaseUrl);
        return ['http:', 'https:'].includes(endpoint.protocol) ? endpoint.toString() : undefined;
    }
    catch {
        return undefined;
    }
}
function isLoopbackBackendUrl(backendUrl) {
    try {
        const url = new URL(backendUrl);
        const hostname = url.hostname.toLocaleLowerCase();
        return ['http:', 'https:'].includes(url.protocol)
            && !url.username
            && !url.password
            && (hostname === 'localhost'
                || hostname === '[::1]'
                || hostname === '::1'
                || isLoopbackIpv4(hostname));
    }
    catch {
        return false;
    }
}
function isLoopbackIpv4(hostname) {
    const parts = hostname.split('.');
    return parts.length === 4
        && parts[0] === '127'
        && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function readNodeJson(response, body) {
    const contentType = response.headers['content-type'];
    const normalizedContentType = Array.isArray(contentType) ? contentType.join(';') : contentType;
    if (!normalizedContentType?.includes('application/json')) {
        return undefined;
    }
    try {
        return JSON.parse(body.toString('utf8'));
    }
    catch {
        return undefined;
    }
}
function cancelledResult() {
    return {
        status: 'error',
        message: 'Request cancelled.',
        errorKind: 'cancelled'
    };
}
async function readJson(response) {
    const contentType = response.headers.get('content-type');
    if (!contentType?.includes('application/json')) {
        return undefined;
    }
    try {
        return await response.json();
    }
    catch {
        return undefined;
    }
}
function isApiResult(value) {
    if (!isRecord(value)) {
        return false;
    }
    if (value.status === 'ok') {
        return 'data' in value;
    }
    return value.status === 'error' && (value.message === undefined || typeof value.message === 'string');
}
function getHttpErrorMessage(status, payload) {
    if (isRecord(payload) && typeof payload.message === 'string') {
        return payload.message;
    }
    if (isRecord(payload) && typeof payload.detail === 'string') {
        return payload.detail;
    }
    return `The DevMate backend returned HTTP ${status}.`;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function isAbortError(error) {
    return error instanceof Error && error.name === 'AbortError';
}
//# sourceMappingURL=client.js.map