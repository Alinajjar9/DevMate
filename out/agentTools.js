"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_AGENT_TOOL_RESULT_CHARACTERS = exports.MAX_AGENT_SEARCH_RESULTS = exports.MAX_AGENT_LIST_RESULTS = exports.MAX_AGENT_TOOL_CALLS = void 0;
exports.parseAgentToolCall = parseAgentToolCall;
exports.normalizeAgentToolPath = normalizeAgentToolPath;
exports.truncateAgentToolResult = truncateAgentToolResult;
exports.MAX_AGENT_TOOL_CALLS = 8;
exports.MAX_AGENT_LIST_RESULTS = 200;
exports.MAX_AGENT_SEARCH_RESULTS = 50;
exports.MAX_AGENT_TOOL_RESULT_CHARACTERS = 10_000;
function parseAgentToolCall(call) {
    if (!call.id.trim()) {
        throw new Error('The model returned a tool call without an id.');
    }
    if (!isRecord(call.arguments)) {
        throw new Error('The model returned invalid tool arguments.');
    }
    if (call.name === 'list_files') {
        return {
            id: call.id,
            name: call.name,
            arguments: {
                path: normalizeAgentToolPath(optionalString(call.arguments.path)),
                maxResults: boundedInteger(call.arguments.maxResults, 100, 1, exports.MAX_AGENT_LIST_RESULTS)
            }
        };
    }
    if (call.name === 'read_file') {
        const filePath = requiredString(call.arguments.path, 'read_file requires a path.');
        return {
            id: call.id,
            name: call.name,
            arguments: { path: normalizeAgentToolPath(filePath, false) }
        };
    }
    if (call.name === 'search_code') {
        const query = requiredString(call.arguments.query, 'search_code requires a query.');
        if (query.length < 2 || query.length > 200) {
            throw new Error('The search query must contain between 2 and 200 characters.');
        }
        return {
            id: call.id,
            name: call.name,
            arguments: {
                query,
                path: normalizeAgentToolPath(optionalString(call.arguments.path)),
                maxResults: boundedInteger(call.arguments.maxResults, 20, 1, exports.MAX_AGENT_SEARCH_RESULTS)
            }
        };
    }
    throw new Error('The model requested an unsupported tool.');
}
function normalizeAgentToolPath(value, allowRoot = true) {
    const trimmed = value.trim();
    if (!trimmed && allowRoot) {
        return '';
    }
    if (!trimmed
        || trimmed.includes('\0')
        || trimmed.startsWith('/')
        || trimmed.startsWith('\\')
        || /^[A-Za-z]:/.test(trimmed)) {
        throw new Error('Tool paths must be workspace-relative.');
    }
    const normalized = trimmed.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error('The tool path contains unsafe segments.');
    }
    return normalized;
}
function truncateAgentToolResult(value) {
    if (value.length <= exports.MAX_AGENT_TOOL_RESULT_CHARACTERS) {
        return value;
    }
    const marker = '\n[Tool result truncated]';
    return `${value.slice(0, exports.MAX_AGENT_TOOL_RESULT_CHARACTERS - marker.length)}${marker}`;
}
function optionalString(value) {
    return typeof value === 'string' ? value : '';
}
function requiredString(value, message) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(message);
    }
    return value.trim();
}
function boundedInteger(value, fallback, minimum, maximum) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, value));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=agentTools.js.map