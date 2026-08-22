"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ASK_TIMEOUT_MS = void 0;
exports.health = health;
exports.openKnowledgeIndex = openKnowledgeIndex;
exports.applyKnowledgeIndexChanges = applyKnowledgeIndexChanges;
exports.updateKnowledgeIndexMetadata = updateKnowledgeIndexMetadata;
exports.searchKnowledgeIndex = searchKnowledgeIndex;
exports.ask = ask;
exports.askStream = askStream;
exports.isLoopbackBackendUrl = isLoopbackBackendUrl;
const http_1 = require("http");
const https_1 = require("https");
const string_decoder_1 = require("string_decoder");
const agentTools_1 = require("../agentTools");
const types_1 = require("./types");
const knowledgeIndexProtocol_1 = require("./knowledgeIndexProtocol");
const HEALTH_TIMEOUT_MS = 2_000;
const KNOWLEDGE_INDEX_TIMEOUT_MS = 30_000;
exports.DEFAULT_ASK_TIMEOUT_MS = 930_000;
const PROVIDER_KEY_HEADER = 'X-DevMate-Provider-Key';
const MAX_BACKEND_RESPONSE_BYTES = 4_000_000;
const MAX_BACKEND_ERROR_RESPONSE_BYTES = 64_000;
const MAX_BACKEND_ERROR_MESSAGE_CHARACTERS = 1_000;
const MAX_BACKEND_VALIDATION_ISSUES = 8;
const MAX_ASK_USED_FILES = 100;
const MAX_ASK_FILE_CHANGES = 10;
const MAX_ASK_FILE_CHANGE_CHARACTERS = 200_000;
const MAX_ASK_TOTAL_CHANGE_CHARACTERS = 500_000;
const MAX_ASK_TOOL_CALLS = 20;
const MAX_ASK_TOOL_ARGUMENT_CHARACTERS = 1_200_000;
const MAX_ASK_PATH_CHARACTERS = 2_048;
const backendErrorCodes = new Set(types_1.DEVMATE_BACKEND_ERROR_CODES);
const agentToolNames = new Set(agentTools_1.AGENT_TOOL_NAMES);
const knowledgeIndexPath = `/index/v${types_1.DEVMATE_KNOWLEDGE_INDEX_API_VERSION}`;
async function health(backendUrl, backendToken) {
    if (!isValidBackendToken(backendToken)) {
        return backendAuthenticationUnavailable();
    }
    const result = await fetchJsonRequest(backendUrl, '/health', {
        method: 'GET',
        headers: { [types_1.DEVMATE_BACKEND_TOKEN_HEADER]: backendToken }
    }, HEALTH_TIMEOUT_MS);
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
function openKnowledgeIndex(backendUrl, request, backendToken, signal) {
    return knowledgeIndexRequest(backendUrl, `${knowledgeIndexPath}/workspaces/open`, request, backendToken, knowledgeIndexProtocol_1.parseKnowledgeIndexOpenResponse, signal);
}
function applyKnowledgeIndexChanges(backendUrl, request, backendToken, signal) {
    return knowledgeIndexRequest(backendUrl, `${knowledgeIndexPath}/files/apply`, request, backendToken, knowledgeIndexProtocol_1.parseKnowledgeIndexWriteResponse, signal);
}
function updateKnowledgeIndexMetadata(backendUrl, request, backendToken, signal) {
    return knowledgeIndexRequest(backendUrl, `${knowledgeIndexPath}/metadata/update`, request, backendToken, knowledgeIndexProtocol_1.parseKnowledgeIndexMetadata, signal);
}
function searchKnowledgeIndex(backendUrl, request, backendToken, signal) {
    return knowledgeIndexRequest(backendUrl, `${knowledgeIndexPath}/search`, request, backendToken, knowledgeIndexProtocol_1.parseKnowledgeIndexSearchResponse, signal);
}
function knowledgeIndexRequest(backendUrl, requestPath, request, backendToken, decodeData, signal) {
    if (!isValidBackendToken(backendToken)) {
        return Promise.resolve(backendAuthenticationUnavailable());
    }
    if (!isLoopbackBackendUrl(backendUrl)) {
        return Promise.resolve({
            status: 'error',
            message: 'DevMate only stores workspace source in a backend running on this computer.',
            errorKind: 'configuration'
        });
    }
    return nodeHttpJsonRequest(backendUrl, requestPath, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Accept-Encoding': 'identity',
            [types_1.DEVMATE_BACKEND_TOKEN_HEADER]: backendToken
        },
        body: JSON.stringify(request)
    }, decodeData, KNOWLEDGE_INDEX_TIMEOUT_MS, signal);
}
async function ask(backendUrl, askRequest, secrets, timeoutMilliseconds = exports.DEFAULT_ASK_TIMEOUT_MS, signal) {
    if (!isValidBackendToken(secrets.backendToken)) {
        return backendAuthenticationUnavailable();
    }
    const providerApiKey = secrets.providerApiKey;
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
            [types_1.DEVMATE_BACKEND_TOKEN_HEADER]: secrets.backendToken,
            ...(providerApiKey ? { [PROVIDER_KEY_HEADER]: providerApiKey } : {})
        },
        body: JSON.stringify(askRequest)
    }, parseAskResponse, timeoutMilliseconds, signal);
}
async function askStream(backendUrl, askRequest, secrets, timeoutMilliseconds = exports.DEFAULT_ASK_TIMEOUT_MS, signal, onEvent) {
    if (!isValidBackendToken(secrets.backendToken)) {
        return {
            result: backendAuthenticationUnavailable(),
            unsupported: false
        };
    }
    const providerApiKey = secrets.providerApiKey;
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
            [types_1.DEVMATE_BACKEND_TOKEN_HEADER]: secrets.backendToken,
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
            return parseBackendHttpError(response.status, payload);
        }
        if (!isSuccessEnvelope(payload) || !hasOnlyKeys(payload, ['status', 'data'])) {
            return {
                status: 'error',
                message: 'The DevMate backend returned an invalid response.',
                errorKind: 'invalid-response'
            };
        }
        return { status: 'ok', data: payload.data };
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
async function nodeHttpJsonRequest(backendUrl, requestPath, init, decodeData, timeoutMilliseconds, externalSignal) {
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
        let receivedStart = false;
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
                finish(invalidStreamResult());
                return;
            }
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
function parseSuccessResult(value, decodeData) {
    if (!isSuccessEnvelope(value) || !hasOnlyKeys(value, ['status', 'data'])) {
        return undefined;
    }
    const data = decodeData(value.data);
    return data === undefined ? undefined : { status: 'ok', data };
}
function isSuccessEnvelope(value) {
    return isRecord(value) && value.status === 'ok' && 'data' in value;
}
function parseAskResponse(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['answer', 'usedFiles', 'changes', 'toolCalls', 'tokenUsage'])
        || typeof value.answer !== 'string'
        || value.answer.length > MAX_BACKEND_RESPONSE_BYTES
        || !Array.isArray(value.usedFiles)
        || value.usedFiles.length > MAX_ASK_USED_FILES
        || !value.usedFiles.every((file) => isResponsePath(file))
        || new Set(value.usedFiles).size !== value.usedFiles.length
        || !Array.isArray(value.changes)
        || value.changes.length > MAX_ASK_FILE_CHANGES
        || !Array.isArray(value.toolCalls)
        || value.toolCalls.length > MAX_ASK_TOOL_CALLS) {
        return undefined;
    }
    const changes = [];
    const changePaths = new Set();
    let changeCharacters = 0;
    for (const candidate of value.changes) {
        if (!isRecord(candidate)
            || !hasOnlyKeys(candidate, ['path', 'content'])
            || !isResponsePath(candidate.path)
            || typeof candidate.content !== 'string'
            || candidate.content.length > MAX_ASK_FILE_CHANGE_CHARACTERS
            || changePaths.has(candidate.path.toLocaleLowerCase())) {
            return undefined;
        }
        changeCharacters += candidate.content.length;
        if (changeCharacters > MAX_ASK_TOTAL_CHANGE_CHARACTERS) {
            return undefined;
        }
        changePaths.add(candidate.path.toLocaleLowerCase());
        changes.push({ path: candidate.path, content: candidate.content });
    }
    const toolCalls = [];
    const callIds = new Set();
    for (const candidate of value.toolCalls) {
        const toolCall = parseAgentToolCall(candidate);
        if (!toolCall || callIds.has(toolCall.id)) {
            return undefined;
        }
        callIds.add(toolCall.id);
        toolCalls.push(toolCall);
    }
    if (!value.answer && toolCalls.length === 0) {
        return undefined;
    }
    const tokenUsage = parseTokenUsage(value.tokenUsage);
    if (!tokenUsage) {
        return undefined;
    }
    return {
        answer: value.answer,
        usedFiles: [...value.usedFiles],
        changes,
        toolCalls,
        tokenUsage
    };
}
function parseAgentToolCall(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['id', 'name', 'arguments'])
        || !isBoundedNonEmptyString(value.id, 120)
        || typeof value.name !== 'string'
        || !agentToolNames.has(value.name)
        || !isRecord(value.arguments)) {
        return undefined;
    }
    try {
        if (JSON.stringify(value.arguments).length > MAX_ASK_TOOL_ARGUMENT_CHARACTERS) {
            return undefined;
        }
    }
    catch {
        return undefined;
    }
    return {
        id: value.id,
        name: value.name,
        arguments: value.arguments
    };
}
function parseTokenUsage(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['inputTokens', 'outputTokens', 'totalTokens', 'exact'])
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
function isResponsePath(value) {
    return isBoundedNonEmptyString(value, MAX_ASK_PATH_CHARACTERS)
        && !/[\u0000-\u001f\u007f]/.test(value);
}
function isBoundedNonEmptyString(value, maximum) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maximum;
}
function parseStreamError(value) {
    if (!hasOnlyKeys(value, ['type', 'message', 'statusCode', 'errorKind', 'errorCode'])
        || value.type !== 'error'
        || value.errorKind !== 'http'
        || !isBoundedNonEmptyString(value.message, MAX_BACKEND_ERROR_MESSAGE_CHARACTERS)
        || !isHttpStatusCode(value.statusCode)
        || !isBackendErrorCode(value.errorCode)) {
        return undefined;
    }
    return {
        status: 'error',
        message: value.message,
        statusCode: value.statusCode,
        errorKind: 'http',
        errorCode: value.errorCode
    };
}
function invalidStreamResult() {
    return {
        result: {
            status: 'error',
            message: 'The DevMate backend returned an invalid streaming event.',
            errorKind: 'invalid-response'
        },
        unsupported: false
    };
}
function parseBackendHttpError(statusCode, value) {
    const parsed = parseBackendError(value);
    if (!parsed) {
        return {
            status: 'error',
            message: `The DevMate backend returned HTTP ${statusCode} with an invalid error response.`,
            statusCode,
            errorKind: 'invalid-response'
        };
    }
    const validationDetail = parsed.errorCode === 'request_validation_failed'
        ? formatValidationIssues(parsed.issues)
        : undefined;
    return {
        status: 'error',
        message: validationDetail ?? parsed.message,
        statusCode,
        errorKind: 'http',
        errorCode: parsed.errorCode
    };
}
function parseBackendError(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['status', 'errorCode', 'message', 'issues'])
        || value.status !== 'error'
        || !isBackendErrorCode(value.errorCode)
        || !isBoundedNonEmptyString(value.message, MAX_BACKEND_ERROR_MESSAGE_CHARACTERS)
        || !Array.isArray(value.issues)
        || value.issues.length > MAX_BACKEND_VALIDATION_ISSUES) {
        return undefined;
    }
    const issues = [];
    for (const candidate of value.issues) {
        const issue = parseBackendValidationIssue(candidate);
        if (!issue) {
            return undefined;
        }
        issues.push(issue);
    }
    return { errorCode: value.errorCode, message: value.message, issues };
}
function parseBackendValidationIssue(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['location', 'message', 'type'])
        || !Array.isArray(value.location)
        || value.location.length > 16
        || !value.location.every((part) => ((typeof part === 'string' && part.length > 0 && part.length <= 120)
            || (typeof part === 'number' && Number.isInteger(part) && part >= 0 && part <= 1_000_000)))
        || !isBoundedNonEmptyString(value.message, 240)
        || !isBoundedNonEmptyString(value.type, 120)) {
        return undefined;
    }
    return {
        location: value.location,
        message: value.message,
        type: value.type
    };
}
function formatValidationIssues(issues) {
    const fields = issues.slice(0, 4).map((issue) => {
        const location = issue.location
            .filter((part) => part !== 'body')
            .map((part) => String(part).replace(/[\u0000-\u001f\u007f]/g, ''))
            .filter(Boolean)
            .join('.');
        const message = issue.message.replace(/[\u0000-\u001f\u007f]/g, ' ');
        return `${location || 'request'}: ${message}`;
    });
    return fields.length > 0
        ? `DevMate rejected an invalid request field: ${fields.join('; ')}`
        : undefined;
}
function isBackendErrorCode(value) {
    return typeof value === 'string' && backendErrorCodes.has(value);
}
function isHttpStatusCode(value) {
    return typeof value === 'number'
        && Number.isInteger(value)
        && value >= 400
        && value <= 599;
}
function parseCompatibleHealthResponse(value) {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['service', 'protocolVersion', 'capabilities', 'backend', 'version'])
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
function isValidBackendToken(value) {
    return value.length >= types_1.MIN_BACKEND_TOKEN_CHARACTERS
        && value.length <= types_1.MAX_BACKEND_TOKEN_CHARACTERS;
}
function backendAuthenticationUnavailable() {
    return {
        status: 'error',
        message: 'No authenticated DevMate backend connection is available.',
        errorKind: 'configuration'
    };
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
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value, keys) {
    const expected = new Set(keys);
    const actual = Object.keys(value);
    return actual.length === expected.size && actual.every((key) => expected.has(key));
}
function isAbortError(error) {
    return error instanceof Error && error.name === 'AbortError';
}
//# sourceMappingURL=client.js.map