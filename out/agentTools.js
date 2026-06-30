"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_AGENT_TOOL_RESULT_CHARACTERS = exports.MAX_AGENT_SEARCH_RESULTS = exports.MAX_AGENT_LIST_RESULTS = exports.MAX_AGENT_COMMAND_CALLS = exports.MAX_AGENT_FILE_MUTATIONS = exports.MAX_AGENT_TOOL_CALLS = void 0;
exports.parseAgentToolCall = parseAgentToolCall;
exports.agentToolCallSignature = agentToolCallSignature;
exports.summarizedAgentToolArguments = summarizedAgentToolArguments;
exports.normalizeAgentToolPath = normalizeAgentToolPath;
exports.truncateAgentToolResult = truncateAgentToolResult;
const crypto_1 = require("crypto");
const commandTools_1 = require("./commandTools");
const fileTools_1 = require("./fileTools");
exports.MAX_AGENT_TOOL_CALLS = 16;
exports.MAX_AGENT_FILE_MUTATIONS = 6;
exports.MAX_AGENT_COMMAND_CALLS = 3;
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
        const lineRange = parseLineRange(call.arguments.startLine, call.arguments.endLine);
        return {
            id: call.id,
            name: call.name,
            arguments: {
                path: normalizeAgentToolPath(filePath, false),
                ...lineRange
            }
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
    if (call.name === 'create_file') {
        return {
            id: call.id,
            name: call.name,
            arguments: (0, fileTools_1.parseCreateFileArguments)(call.arguments)
        };
    }
    if (call.name === 'edit_file') {
        return {
            id: call.id,
            name: call.name,
            arguments: (0, fileTools_1.parseEditFileArguments)(call.arguments)
        };
    }
    if (call.name === 'run_command') {
        return {
            id: call.id,
            name: call.name,
            arguments: (0, commandTools_1.parseRunCommandArguments)(call.arguments)
        };
    }
    throw new Error('The model requested an unsupported tool.');
}
function agentToolCallSignature(call) {
    const parsed = parseAgentToolCall(call);
    if (parsed.name === 'create_file') {
        return `${parsed.name}:${parsed.arguments.path}:${hashText(parsed.arguments.content)}`;
    }
    if (parsed.name === 'edit_file') {
        return `${parsed.name}:${parsed.arguments.path}:${hashText(JSON.stringify(parsed.arguments.replacements))}`;
    }
    return `${parsed.name}:${JSON.stringify(parsed.arguments)}`;
}
function summarizedAgentToolArguments(call) {
    if (call.name === 'create_file') {
        return {
            path: call.arguments.path,
            content: `[omitted after execution: ${call.arguments.content.length} characters, sha256 ${hashText(call.arguments.content)}]`
        };
    }
    if (call.name === 'edit_file') {
        return {
            path: call.arguments.path,
            replacements: call.arguments.replacements.map((replacement) => ({
                oldText: `[${replacement.oldText.length} characters, sha256 ${hashText(replacement.oldText)}]`,
                newText: `[${replacement.newText.length} characters, sha256 ${hashText(replacement.newText)}]`
            }))
        };
    }
    return call.arguments;
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
function parseLineRange(startValue, endValue) {
    if (startValue === undefined && endValue === undefined) {
        return {};
    }
    const startLine = boundedInteger(startValue, 1, 1, 1_000_000);
    const endLine = boundedInteger(endValue, startLine + 399, startLine, 1_000_000);
    if (endLine - startLine + 1 > 400) {
        throw new Error('read_file can return at most 400 lines at once.');
    }
    return { startLine, endLine };
}
function hashText(value) {
    return (0, crypto_1.createHash)('sha256').update(value).digest('hex').slice(0, 16);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=agentTools.js.map