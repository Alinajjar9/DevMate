"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ASK_TIMEOUT_MS = void 0;
exports.health = health;
exports.ask = ask;
exports.askStream = askStream;
exports.isLoopbackBackendUrl = isLoopbackBackendUrl;
const http_1 = require("http");
const https_1 = require("https");
const string_decoder_1 = require("string_decoder");
const types_1 = require("./types");
const HEALTH_TIMEOUT_MS = 2_000;
exports.DEFAULT_ASK_TIMEOUT_MS = 930_000;
const PROVIDER_KEY_HEADER = 'X-DevMate-Provider-Key';
const MAX_BACKEND_RESPONSE_BYTES = 4_000_000;
const MAX_BACKEND_ERROR_RESPONSE_BYTES = 64_000;
async function health(backendUrl) {
    const result = await fetchJsonRequest(backendUrl, '/health', { method: 'GET' }, HEALTH_TIMEOUT_MS);
    if (result.status !== 'ok') {
        return {
            status: 'error',
            message: result.message,
            statusCode: result.statusCode,
            errorKind: result.errorKind
        };
    }
    const response = parseCompatibleHealthResponse(result.data);
    if (!response) {
        return {
            status: 'error',
            message: 'The service did not identify itself as a compatible DevMate backend.',
            errorKind: 'invalid-response'
        };
    }
    return { status: 'ok', data: response };
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
async function askStream(backendUrl, askRequest, providerApiKey, timeoutMilliseconds = exports.DEFAULT_ASK_TIMEOUT_MS, signal, onEvent) {
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
    return nodeHttpStreamRequest(backendUrl, '/ask/stream', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/x-ndjson',
            'Accept-Encoding': 'identity',
            ...(providerApiKey ? { [PROVIDER_KEY_HEADER]: providerApiKey } : {})
        },
        body: JSON.stringify(askRequest)
    }, timeoutMilliseconds, signal, onEvent);
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
async function nodeHttpStreamRequest(backendUrl, requestPath, init, timeoutMilliseconds, externalSignal, onEvent) {
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
        let backendRequest;
        let response;
        let timer;
        let settled = false;
        let timedOut = false;
        let cancelled = false;
        let receivedBytes = 0;
        let lineBuffer = '';
        let finalResult;
        const decoder = new string_decoder_1.StringDecoder('utf8');
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
        const processLine = (line) => {
            const normalized = line.trim();
            if (!normalized || settled) {
                return;
            }
            let value;
            try {
                value = JSON.parse(normalized);
            }
            catch {
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
                return;
            }
            if (value.type === 'delta' && typeof value.text === 'string' && value.text) {
                onEvent?.({ type: 'delta', text: value.text });
                return;
            }
            if (value.type === 'progress' && typeof value.phase === 'string' && value.phase) {
                onEvent?.({ type: 'progress', phase: value.phase.slice(0, 120) });
                return;
            }
            if (value.type === 'usage') {
                const usage = parseTokenUsage(value.usage);
                if (usage) {
                    onEvent?.({ type: 'usage', usage });
                }
                return;
            }
            if (value.type === 'final' && isApiResult(value.result)) {
                finalResult = value.result;
                return;
            }
            if (value.type === 'error' && typeof value.message === 'string') {
                finalResult = {
                    status: 'error',
                    message: value.message,
                    statusCode: typeof value.statusCode === 'number' ? value.statusCode : undefined,
                    errorKind: value.errorKind === 'http' ? 'http' : 'invalid-response'
                };
            }
        };
        try {
            const requestFunction = endpoint.protocol === 'https:' ? https_1.request : http_1.request;
            backendRequest = requestFunction(endpoint, {
                method: init.method,
                headers: init.headers
            }, (incomingResponse) => {
                response = incomingResponse;
                const statusCode = incomingResponse.statusCode ?? 0;
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
                    const chunks = [];
                    let errorBytes = 0;
                    incomingResponse.on('data', (value) => {
                        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
                        errorBytes += chunk.length;
                        if (errorBytes > MAX_BACKEND_ERROR_RESPONSE_BYTES) {
                            finish({
                                result: {
                                    status: 'error',
                                    message: `The DevMate backend returned HTTP ${statusCode} with an oversized error response.`,
                                    statusCode,
                                    errorKind: 'http'
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
                            result: {
                                status: 'error',
                                message: getHttpErrorMessage(statusCode, payload),
                                statusCode,
                                errorKind: 'http'
                            },
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
                incomingResponse.on('data', (value) => {
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
        }
        catch {
            failTransport();
        }
    });
}
function parseTokenUsage(value) {
    if (!isRecord(value)
        || !safeTokenCount(value.inputTokens)
        || !safeTokenCount(value.outputTokens)
        || !safeTokenCount(value.totalTokens)
        || typeof value.exact !== 'boolean') {
        return undefined;
    }
    return {
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        totalTokens: value.totalTokens,
        exact: value.exact
    };
}
function safeTokenCount(value) {
    return typeof value === 'number'
        && Number.isInteger(value)
        && value >= 0
        && value <= 200_000_000;
}
function parseCompatibleHealthResponse(value) {
    if (!isRecord(value)
        || value.service !== types_1.DEVMATE_BACKEND_SERVICE
        || value.protocolVersion !== types_1.DEVMATE_BACKEND_PROTOCOL_VERSION
        || value.backend !== 'online'
        || typeof value.version !== 'string'
        || value.version.trim().length === 0
        || value.version.length > 120
        || !Array.isArray(value.capabilities)) {
        return undefined;
    }
    const capabilities = value.capabilities;
    if (capabilities.length > 32
        || !capabilities.every(isValidBackendCapability)
        || new Set(capabilities).size !== capabilities.length
        || !types_1.DEVMATE_BACKEND_CAPABILITIES.every((capability) => capabilities.includes(capability))) {
        return undefined;
    }
    return {
        service: types_1.DEVMATE_BACKEND_SERVICE,
        protocolVersion: types_1.DEVMATE_BACKEND_PROTOCOL_VERSION,
        capabilities: [...value.capabilities],
        backend: 'online',
        version: value.version
    };
}
function isValidBackendCapability(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 64;
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
    if (status === 422 && isRecord(payload) && Array.isArray(payload.detail)) {
        const fields = payload.detail
            .slice(0, 4)
            .map((item) => {
            if (!isRecord(item) || !Array.isArray(item.loc) || typeof item.msg !== 'string') {
                return undefined;
            }
            const location = item.loc
                .filter((part) => part !== 'body')
                .map((part) => String(part).replace(/[\u0000-\u001f\u007f]/g, ''))
                .filter(Boolean)
                .join('.');
            const message = item.msg.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240);
            return `${location || 'request'}: ${message}`;
        })
            .filter((item) => Boolean(item));
        if (fields.length > 0) {
            return `DevMate rejected an invalid request field: ${fields.join('; ')}`;
        }
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