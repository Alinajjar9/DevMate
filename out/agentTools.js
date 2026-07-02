"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_AGENT_CONSECUTIVE_INSPECTIONS = exports.MAX_AGENT_TOOL_ARGUMENT_HISTORY_CHARACTERS = exports.MAX_AGENT_TOOL_HISTORY_CHARACTERS = exports.MAX_AGENT_TOOL_RESULT_CHARACTERS = exports.MAX_AGENT_READ_LINES = exports.MAX_AGENT_CODE_NAVIGATION_RESULTS = exports.MAX_AGENT_TERMINAL_ERROR_RESULTS = exports.MAX_AGENT_DIAGNOSTIC_RESULTS = exports.MAX_AGENT_SEARCH_RESULTS = exports.MAX_AGENT_LIST_RESULTS = exports.MAX_AGENT_DEPENDENCY_INSTALLS = exports.MAX_AGENT_COMMAND_CALLS = exports.MAX_AGENT_FILE_MUTATIONS = exports.MAX_AGENT_TOOL_CALL_LIMIT = exports.MIN_AGENT_TOOL_CALL_LIMIT = exports.DEFAULT_AGENT_TOOL_CALL_LIMIT = void 0;
exports.boundedAgentToolCallLimit = boundedAgentToolCallLimit;
exports.isDeferredAgentPlanAnswer = isDeferredAgentPlanAnswer;
exports.compactAgentToolHistory = compactAgentToolHistory;
exports.parseAgentToolCall = parseAgentToolCall;
exports.normalizeAgentToolCallForWorkspace = normalizeAgentToolCallForWorkspace;
exports.agentToolCallSignature = agentToolCallSignature;
exports.summarizedAgentToolArguments = summarizedAgentToolArguments;
exports.boundedAgentToolHistoryArguments = boundedAgentToolHistoryArguments;
exports.consecutiveAgentInspectionCalls = consecutiveAgentInspectionCalls;
exports.summarizeAgentToolHistory = summarizeAgentToolHistory;
exports.normalizeAgentToolPath = normalizeAgentToolPath;
exports.truncateAgentToolResult = truncateAgentToolResult;
const crypto_1 = require("crypto");
const commandTools_1 = require("./commandTools");
const dependencyTools_1 = require("./dependencyTools");
const fileChanges_1 = require("./fileChanges");
const fileTools_1 = require("./fileTools");
exports.DEFAULT_AGENT_TOOL_CALL_LIMIT = 16;
exports.MIN_AGENT_TOOL_CALL_LIMIT = 4;
exports.MAX_AGENT_TOOL_CALL_LIMIT = 100;
exports.MAX_AGENT_FILE_MUTATIONS = 6;
exports.MAX_AGENT_COMMAND_CALLS = 3;
exports.MAX_AGENT_DEPENDENCY_INSTALLS = 1;
exports.MAX_AGENT_LIST_RESULTS = 500;
exports.MAX_AGENT_SEARCH_RESULTS = 200;
exports.MAX_AGENT_DIAGNOSTIC_RESULTS = 300;
exports.MAX_AGENT_TERMINAL_ERROR_RESULTS = 10;
exports.MAX_AGENT_CODE_NAVIGATION_RESULTS = 300;
exports.MAX_AGENT_READ_LINES = 1_000;
exports.MAX_AGENT_TOOL_RESULT_CHARACTERS = 10_000;
exports.MAX_AGENT_TOOL_HISTORY_CHARACTERS = 80_000;
exports.MAX_AGENT_TOOL_ARGUMENT_HISTORY_CHARACTERS = 3_500;
exports.MAX_AGENT_CONSECUTIVE_INSPECTIONS = 16;
function boundedAgentToolCallLimit(value) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        return exports.DEFAULT_AGENT_TOOL_CALL_LIMIT;
    }
    return Math.min(exports.MAX_AGENT_TOOL_CALL_LIMIT, Math.max(exports.MIN_AGENT_TOOL_CALL_LIMIT, value));
}
function isDeferredAgentPlanAnswer(value) {
    if (typeof value !== 'string') {
        return false;
    }
    const normalized = value
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/^[\s#>*_-]+/, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!normalized || normalized.length > 1_200) {
        return false;
    }
    const action = '(?:start|begin|inspect|read|examine|review|create|implement|build|update|fix|reorganize|set up)';
    return new RegExp(`^(?:(?:okay|sure)[,.]?\\s+)?(?:i(?:['’]ll|\\s+will)\\s+(?:first\\s+|now\\s+)?${action}\\b|let me\\s+(?:first\\s+)?${action}\\b)`, 'i').test(normalized);
}
function compactAgentToolHistory(steps) {
    const compacted = steps.map((step) => ({ ...step }));
    let characters = compacted.reduce((total, step) => total + step.result.length, 0);
    for (let index = 0; characters > exports.MAX_AGENT_TOOL_HISTORY_CHARACTERS && index < compacted.length; index += 1) {
        const step = compacted[index];
        const marker = `[Earlier ${step.name} result omitted to stay within the agent context budget.]`;
        if (step.result.length <= marker.length) {
            continue;
        }
        characters -= step.result.length - marker.length;
        step.result = marker;
    }
    return compacted;
}
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
    if (call.name === 'get_diagnostics') {
        return {
            id: call.id,
            name: call.name,
            arguments: {
                path: normalizeAgentToolPath(optionalString(call.arguments.path)),
                maxResults: boundedInteger(call.arguments.maxResults, 50, 1, exports.MAX_AGENT_DIAGNOSTIC_RESULTS)
            }
        };
    }
    if (call.name === 'get_symbols') {
        return {
            id: call.id,
            name: call.name,
            arguments: {
                path: normalizeAgentToolPath(requiredString(call.arguments.path, 'get_symbols requires a path.'), false),
                maxResults: boundedInteger(call.arguments.maxResults, 100, 1, exports.MAX_AGENT_CODE_NAVIGATION_RESULTS)
            }
        };
    }
    if (call.name === 'find_definition' || call.name === 'find_references') {
        const commonArguments = {
            path: normalizeAgentToolPath(requiredString(call.arguments.path, `${call.name} requires a path.`), false),
            line: requiredPositiveInteger(call.arguments.line, `${call.name} requires a positive one-based line.`),
            column: requiredPositiveInteger(call.arguments.column, `${call.name} requires a positive one-based column.`),
            maxResults: boundedInteger(call.arguments.maxResults, call.name === 'find_definition' ? 20 : 100, 1, exports.MAX_AGENT_CODE_NAVIGATION_RESULTS)
        };
        return call.name === 'find_definition'
            ? { id: call.id, name: call.name, arguments: commonArguments }
            : { id: call.id, name: call.name, arguments: commonArguments };
    }
    if (call.name === 'read_terminal_errors') {
        return {
            id: call.id,
            name: call.name,
            arguments: {
                maxResults: boundedInteger(call.arguments.maxResults, 3, 1, exports.MAX_AGENT_TERMINAL_ERROR_RESULTS)
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
    if (call.name === 'delete_file') {
        return {
            id: call.id,
            name: call.name,
            arguments: (0, fileTools_1.parseDeleteFileArguments)(call.arguments)
        };
    }
    if (call.name === 'rename_file') {
        return {
            id: call.id,
            name: call.name,
            arguments: (0, fileTools_1.parseRenameFileArguments)(call.arguments)
        };
    }
    if (call.name === 'move_file') {
        return {
            id: call.id,
            name: call.name,
            arguments: (0, fileTools_1.parseMoveFileArguments)(call.arguments)
        };
    }
    if (call.name === 'install_dependencies') {
        return {
            id: call.id,
            name: call.name,
            arguments: (0, dependencyTools_1.parseInstallDependenciesArguments)(call.arguments)
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
function normalizeAgentToolCallForWorkspace(call, workspace) {
    const primaryArgumentName = call.name === 'run_command'
        ? 'cwd'
        : call.name === 'install_dependencies'
            ? 'manifestPath'
            : [
                'list_files',
                'read_file',
                'search_code',
                'get_symbols',
                'find_definition',
                'find_references',
                'get_diagnostics',
                'create_file',
                'edit_file',
                'delete_file',
                'rename_file',
                'move_file'
            ].includes(call.name)
                ? 'path'
                : undefined;
    const argumentNames = primaryArgumentName
        ? [primaryArgumentName, ...(['rename_file', 'move_file'].includes(call.name) ? ['newPath'] : [])]
        : [];
    if (argumentNames.length === 0) {
        return call;
    }
    const allowRoot = call.name === 'list_files'
        || call.name === 'search_code'
        || call.name === 'get_diagnostics'
        || call.name === 'run_command';
    const normalizedArguments = { ...call.arguments };
    for (const argumentName of argumentNames) {
        if (typeof normalizedArguments[argumentName] === 'string') {
            normalizedArguments[argumentName] = normalizeWorkspaceQualifiedPath(normalizedArguments[argumentName], workspace, allowRoot);
        }
    }
    return { ...call, arguments: normalizedArguments };
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
        return boundedAgentToolHistoryArguments(call.name, {
            path: call.arguments.path,
            content: (0, fileChanges_1.agentHistoryOmissionMarker)('content', call.arguments.content.length, hashText(call.arguments.content))
        });
    }
    if (call.name === 'edit_file') {
        const serializedReplacements = JSON.stringify(call.arguments.replacements);
        return boundedAgentToolHistoryArguments(call.name, {
            path: call.arguments.path,
            replacementCount: call.arguments.replacements.length,
            replacements: (0, fileChanges_1.agentHistoryOmissionMarker)('text', serializedReplacements.length, hashText(serializedReplacements))
        });
    }
    return boundedAgentToolHistoryArguments(call.name, call.arguments);
}
function boundedAgentToolHistoryArguments(name, argumentsValue) {
    let serialized;
    try {
        serialized = JSON.stringify(argumentsValue);
    }
    catch {
        serialized = '[unserializable tool arguments]';
    }
    if (serialized.length <= exports.MAX_AGENT_TOOL_ARGUMENT_HISTORY_CHARACTERS) {
        return argumentsValue;
    }
    return {
        summary: (0, fileChanges_1.agentHistoryOmissionMarker)('content', serialized.length, hashText(`${name}:${serialized}`))
    };
}
function consecutiveAgentInspectionCalls(steps) {
    let inspections = 0;
    for (let index = steps.length - 1; index >= 0; index -= 1) {
        const step = steps[index];
        if (!step.isError && [
            'create_file',
            'edit_file',
            'delete_file',
            'rename_file',
            'move_file',
            'install_dependencies',
            'run_command'
        ].includes(step.name)) {
            break;
        }
        if ([
            'list_files',
            'read_file',
            'search_code',
            'get_symbols',
            'find_definition',
            'find_references',
            'get_diagnostics',
            'read_terminal_errors'
        ].includes(step.name)) {
            inspections += 1;
        }
    }
    return inspections;
}
function summarizeAgentToolHistory(steps, finalizationError) {
    const completedChanges = [];
    const verification = [];
    let failedCalls = 0;
    for (const step of steps) {
        if (step.name === 'run_command') {
            const command = commandSummary(step.arguments);
            const exitCode = /(?:^|\n)Exit code:\s*(-?\d+)/i.exec(step.result)?.[1];
            verification.push(exitCode === undefined
                ? `${command} did not return a usable exit code.`
                : `${command} exited with code ${exitCode}.`);
        }
        if (step.isError) {
            failedCalls += 1;
            continue;
        }
        const path = boundedSummaryValue(step.arguments.path);
        const newPath = boundedSummaryValue(step.arguments.newPath);
        if (step.name === 'create_file' && path) {
            completedChanges.push(`Created ${path}.`);
        }
        else if (step.name === 'edit_file' && path) {
            completedChanges.push(`Updated ${path}.`);
        }
        else if (step.name === 'delete_file' && path) {
            completedChanges.push(`Deleted ${path}.`);
        }
        else if (step.name === 'rename_file' && path && newPath) {
            completedChanges.push(`Renamed ${path} to ${newPath}.`);
        }
        else if (step.name === 'move_file' && path && newPath) {
            completedChanges.push(`Moved ${path} to ${newPath}.`);
        }
        else if (step.name === 'install_dependencies') {
            const manifestPath = boundedSummaryValue(step.arguments.manifestPath);
            completedChanges.push(manifestPath
                ? `Installed dependencies from ${manifestPath}.`
                : 'Installed the approved project dependencies.');
        }
    }
    const lines = [
        'DevMate completed the available project-tool work, but the model did not return a usable final summary.',
        '',
        completedChanges.length > 0 ? 'Completed:' : 'No file changes were completed.',
        ...completedChanges.map((item) => `- ${item}`)
    ];
    if (verification.length > 0) {
        lines.push('', 'Verification:', ...verification.map((item) => `- ${item}`));
    }
    if (failedCalls > 0) {
        lines.push('', `${failedCalls} tool ${failedCalls === 1 ? 'request failed or was rejected' : 'requests failed or were rejected'}; review the tool cards for details.`);
    }
    lines.push('', `Remaining issue: ${boundedSummaryValue(finalizationError, 300) || 'The model could not finalize the request.'}`, 'Start a follow-up request if more project work is needed.');
    return lines.join('\n');
}
function commandSummary(argumentsValue) {
    const executable = boundedSummaryValue(argumentsValue.executable, 80) || 'Verification command';
    const args = Array.isArray(argumentsValue.args)
        ? argumentsValue.args
            .filter((value) => typeof value === 'string')
            .map((value) => boundedSummaryValue(value, 80))
            .filter(Boolean)
            .slice(0, 12)
        : [];
    return [executable, ...args].join(' ');
}
function boundedSummaryValue(value, maximum = 240) {
    return typeof value === 'string'
        ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum)
        : '';
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
function normalizeWorkspaceQualifiedPath(value, workspace, allowRoot) {
    const trimmed = value.trim();
    if (!trimmed) {
        return trimmed;
    }
    if (trimmed === '.' || trimmed === './' || trimmed === '.\\') {
        return allowRoot ? '' : trimmed;
    }
    let normalized = trimmed.replace(/\\/g, '/');
    while (normalized.startsWith('./')) {
        normalized = normalized.slice(2);
    }
    const rootPath = workspace.fsPath?.replace(/\\/g, '/').replace(/\/+$/, '');
    if (rootPath && isAbsoluteLike(normalized)) {
        const caseInsensitive = /^[A-Za-z]:\//.test(rootPath) || rootPath.startsWith('//');
        const comparableRoot = caseInsensitive ? rootPath.toLocaleLowerCase() : rootPath;
        const comparableValue = caseInsensitive ? normalized.toLocaleLowerCase() : normalized;
        if (comparableValue === comparableRoot) {
            return allowRoot ? '' : trimmed;
        }
        if (comparableValue.startsWith(`${comparableRoot}/`)) {
            return normalized.slice(rootPath.length + 1);
        }
        return trimmed;
    }
    const rootName = workspace.name.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!rootName) {
        return normalized;
    }
    const caseInsensitive = process.platform === 'win32';
    const comparableName = caseInsensitive ? rootName.toLocaleLowerCase() : rootName;
    const comparableValue = caseInsensitive ? normalized.toLocaleLowerCase() : normalized;
    if (comparableValue === comparableName) {
        return allowRoot ? '' : normalized;
    }
    if (comparableValue.startsWith(`${comparableName}/`)) {
        return normalized.slice(rootName.length + 1);
    }
    return normalized;
}
function isAbsoluteLike(value) {
    return value.startsWith('/') || /^[A-Za-z]:\//.test(value);
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
function requiredPositiveInteger(value, message) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10_000_000) {
        throw new Error(message);
    }
    return value;
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
    if (endValue === undefined) {
        return { startLine };
    }
    const endLine = boundedInteger(endValue, startLine, startLine, 1_000_000);
    if (endLine - startLine + 1 > exports.MAX_AGENT_READ_LINES) {
        throw new Error(`read_file can return at most ${exports.MAX_AGENT_READ_LINES} lines at once.`);
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