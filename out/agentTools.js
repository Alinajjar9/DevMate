"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FILE_MUTATION_AGENT_TOOL_NAMES = exports.READ_ONLY_AGENT_TOOL_NAMES = exports.AGENT_TOOL_NAMES = exports.MAX_CODE_NAVIGATION_MAX_RESULTS = exports.MIN_CODE_NAVIGATION_MAX_RESULTS = exports.DEFAULT_CODE_NAVIGATION_MAX_RESULTS = exports.MAX_TERMINAL_ERRORS_MAX_RESULTS = exports.MIN_TERMINAL_ERRORS_MAX_RESULTS = exports.DEFAULT_TERMINAL_ERRORS_MAX_RESULTS = exports.MAX_DIAGNOSTICS_MAX_RESULTS = exports.MIN_DIAGNOSTICS_MAX_RESULTS = exports.DEFAULT_DIAGNOSTICS_MAX_RESULTS = exports.MAX_SEARCH_CODE_MAX_RESULTS = exports.MIN_SEARCH_CODE_MAX_RESULTS = exports.DEFAULT_SEARCH_CODE_MAX_RESULTS = exports.MAX_LIST_FILES_MAX_RESULTS = exports.MIN_LIST_FILES_MAX_RESULTS = exports.DEFAULT_LIST_FILES_MAX_RESULTS = exports.MAX_READ_FILE_MAX_LINES = exports.MIN_READ_FILE_MAX_LINES = exports.DEFAULT_READ_FILE_MAX_LINES = exports.PROVIDER_RETRY_DELAYS_MS = exports.MAX_AGENT_CONSECUTIVE_INSPECTIONS = exports.MAX_AGENT_TOOL_ARGUMENT_HISTORY_CHARACTERS = exports.MAX_AGENT_TOOL_HISTORY_CHARACTERS = exports.MAX_AGENT_TOOL_RESULT_CHARACTERS = exports.MAX_AGENT_READ_LINES = exports.MAX_AGENT_CODE_NAVIGATION_RESULTS = exports.MAX_AGENT_TERMINAL_ERROR_RESULTS = exports.MAX_AGENT_DIAGNOSTIC_RESULTS = exports.MAX_AGENT_SEARCH_RESULTS = exports.MAX_AGENT_LIST_RESULTS = exports.MAX_AGENT_DEPENDENCY_INSTALLS = exports.MAX_AGENT_COMMAND_CALLS = exports.MAX_AGENT_FILE_MUTATIONS = exports.MAX_AGENT_TOOL_CALL_LIMIT = exports.MIN_AGENT_TOOL_CALL_LIMIT = exports.DEFAULT_AGENT_TOOL_CALL_LIMIT = exports.MAX_DEPENDENCY_REQUIREMENTS = exports.MAX_DEPENDENCY_MANIFEST_BYTES = void 0;
exports.normalizeAgentToolSettings = normalizeAgentToolSettings;
exports.emptyResponseRecoveryAction = emptyResponseRecoveryAction;
exports.isRecoverableEmptyModelResponse = isRecoverableEmptyModelResponse;
exports.isRetryableProviderFailure = isRetryableProviderFailure;
exports.providerRetryDelay = providerRetryDelay;
exports.parseInstallDependenciesArguments = parseInstallDependenciesArguments;
exports.validatePythonRequirementsManifest = validatePythonRequirementsManifest;
exports.boundedAgentToolCallLimit = boundedAgentToolCallLimit;
exports.isDeferredAgentPlanAnswer = isDeferredAgentPlanAnswer;
exports.compactAgentToolHistory = compactAgentToolHistory;
exports.isReadOnlyAgentTool = isReadOnlyAgentTool;
exports.isFileMutationAgentTool = isFileMutationAgentTool;
exports.parseAgentToolCall = parseAgentToolCall;
exports.normalizeAgentToolCallForWorkspace = normalizeAgentToolCallForWorkspace;
exports.agentToolCallSignature = agentToolCallSignature;
exports.summarizedAgentToolArguments = summarizedAgentToolArguments;
exports.boundedAgentToolHistoryArguments = boundedAgentToolHistoryArguments;
exports.consecutiveAgentInspectionCalls = consecutiveAgentInspectionCalls;
exports.summarizeAgentToolHistory = summarizeAgentToolHistory;
exports.normalizeAgentToolPath = normalizeAgentToolPath;
exports.truncateAgentToolResult = truncateAgentToolResult;
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const commandTools_1 = require("./commandTools");
const fileTools_1 = require("./fileTools");
exports.MAX_DEPENDENCY_MANIFEST_BYTES = 64_000;
exports.MAX_DEPENDENCY_REQUIREMENTS = 100;
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
exports.PROVIDER_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
exports.DEFAULT_READ_FILE_MAX_LINES = 400;
exports.MIN_READ_FILE_MAX_LINES = 100;
exports.MAX_READ_FILE_MAX_LINES = 1_000;
exports.DEFAULT_LIST_FILES_MAX_RESULTS = 200;
exports.MIN_LIST_FILES_MAX_RESULTS = 20;
exports.MAX_LIST_FILES_MAX_RESULTS = 500;
exports.DEFAULT_SEARCH_CODE_MAX_RESULTS = 50;
exports.MIN_SEARCH_CODE_MAX_RESULTS = 10;
exports.MAX_SEARCH_CODE_MAX_RESULTS = 200;
exports.DEFAULT_DIAGNOSTICS_MAX_RESULTS = 100;
exports.MIN_DIAGNOSTICS_MAX_RESULTS = 10;
exports.MAX_DIAGNOSTICS_MAX_RESULTS = 300;
exports.DEFAULT_TERMINAL_ERRORS_MAX_RESULTS = 5;
exports.MIN_TERMINAL_ERRORS_MAX_RESULTS = 1;
exports.MAX_TERMINAL_ERRORS_MAX_RESULTS = 10;
exports.DEFAULT_CODE_NAVIGATION_MAX_RESULTS = 100;
exports.MIN_CODE_NAVIGATION_MAX_RESULTS = 10;
exports.MAX_CODE_NAVIGATION_MAX_RESULTS = 300;
function normalizeAgentToolSettings(value) {
    return {
        readFileMaxLines: boundedIntegerSettings(value.readFileMaxLines, exports.DEFAULT_READ_FILE_MAX_LINES, exports.MIN_READ_FILE_MAX_LINES, exports.MAX_READ_FILE_MAX_LINES),
        listFilesMaxResults: boundedIntegerSettings(value.listFilesMaxResults, exports.DEFAULT_LIST_FILES_MAX_RESULTS, exports.MIN_LIST_FILES_MAX_RESULTS, exports.MAX_LIST_FILES_MAX_RESULTS),
        searchCodeMaxResults: boundedIntegerSettings(value.searchCodeMaxResults, exports.DEFAULT_SEARCH_CODE_MAX_RESULTS, exports.MIN_SEARCH_CODE_MAX_RESULTS, exports.MAX_SEARCH_CODE_MAX_RESULTS),
        diagnosticsMaxResults: boundedIntegerSettings(value.diagnosticsMaxResults, exports.DEFAULT_DIAGNOSTICS_MAX_RESULTS, exports.MIN_DIAGNOSTICS_MAX_RESULTS, exports.MAX_DIAGNOSTICS_MAX_RESULTS),
        terminalErrorsMaxResults: boundedIntegerSettings(value.terminalErrorsMaxResults, exports.DEFAULT_TERMINAL_ERRORS_MAX_RESULTS, exports.MIN_TERMINAL_ERRORS_MAX_RESULTS, exports.MAX_TERMINAL_ERRORS_MAX_RESULTS),
        codeNavigationMaxResults: boundedIntegerSettings(value.codeNavigationMaxResults, exports.DEFAULT_CODE_NAVIGATION_MAX_RESULTS, exports.MIN_CODE_NAVIGATION_MAX_RESULTS, exports.MAX_CODE_NAVIGATION_MAX_RESULTS)
    };
}
function boundedIntegerSettings(value, fallback, minimum, maximum) {
    return typeof value === 'number' && Number.isInteger(value)
        ? Math.min(maximum, Math.max(minimum, value))
        : fallback;
}
const retryableStatusCodes = new Set([429, 502, 503, 504]);
function emptyResponseRecoveryAction(message, recoveryAlreadyAttempted, finalAnswerAlreadyForced) {
    if (finalAnswerAlreadyForced || !isRecoverableEmptyModelResponse(message)) {
        return 'none';
    }
    return recoveryAlreadyAttempted ? 'force-final' : 'retry-without-thinking';
}
function isRecoverableEmptyModelResponse(message) {
    const normalized = message.toLocaleLowerCase();
    return normalized.includes('response budget for reasoning')
        || normalized.includes('empty final answer')
        || normalized.includes('empty or invalid answer');
}
function isRetryableProviderFailure(result) {
    if (result.status !== 'error' || result.errorKind !== 'http') {
        return false;
    }
    const message = result.message ?? '';
    if (/response budget for reasoning/i.test(message)
        || /empty (?:or invalid |final )?answer/i.test(message)
        || /file-change response/i.test(message)
        || /invalid tool/i.test(message)
        || /tool (?:after|call).*tool limit/i.test(message)
        || /tool limit was reached/i.test(message)
        || /tool when DevMate required a final answer/i.test(message)
        || /non-json response/i.test(message)
        || /returned a redirect/i.test(message)) {
        return false;
    }
    if (result.statusCode !== undefined) {
        return retryableStatusCodes.has(result.statusCode);
    }
    return /resource\s*exhausted/i.test(message);
}
function providerRetryDelay(retryNumber) {
    return exports.PROVIDER_RETRY_DELAYS_MS[retryNumber - 1];
}
const blockedManifestDirectories = new Set([
    '.git', '.venv', 'venv', 'env', 'node_modules', 'vendor', 'dist', 'build', 'target'
]);
const manifestNamePattern = /^requirements(?:-[a-z0-9._-]+)?\.txt$/i;
const requirementPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:\s*(?:(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9*+!._-]+)(?:\s*,\s*(?:(?:===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9*+!._-]+))*)?$/;
function parseInstallDependenciesArguments(value) {
    if (typeof value.manifestPath !== 'string') {
        throw new Error('install_dependencies requires a requirements manifest path.');
    }
    const manifestPath = (0, fileTools_1.normalizeWorkspaceRelativePath)(value.manifestPath);
    const parts = manifestPath.split('/');
    const fileName = parts.at(-1) ?? '';
    if (!manifestNamePattern.test(fileName)) {
        throw new Error('Dependency installation is limited to requirements*.txt manifests.');
    }
    if (parts.slice(0, -1).some((part) => blockedManifestDirectories.has(part.toLocaleLowerCase()))) {
        throw new Error('The dependency manifest is inside a blocked directory.');
    }
    const timeoutSeconds = value.timeoutSeconds === undefined
        ? commandTools_1.MAX_COMMAND_TIMEOUT_SECONDS
        : value.timeoutSeconds;
    if (typeof timeoutSeconds !== 'number' || !Number.isInteger(timeoutSeconds)) {
        throw new Error('Dependency timeoutSeconds must be an integer.');
    }
    return {
        manifestPath,
        cwd: path.posix.dirname(manifestPath) === '.' ? '' : path.posix.dirname(manifestPath),
        timeoutSeconds: Math.min(commandTools_1.MAX_COMMAND_TIMEOUT_SECONDS, Math.max(commandTools_1.MIN_COMMAND_TIMEOUT_SECONDS, timeoutSeconds))
    };
}
function validatePythonRequirementsManifest(content) {
    if (Buffer.byteLength(content, 'utf8') > exports.MAX_DEPENDENCY_MANIFEST_BYTES) {
        throw new Error('The dependency manifest exceeds the 64 KB safety limit.');
    }
    const requirements = [];
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.replace(/\s+#.*$/, '').trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        if (line.length > 300 || !requirementPattern.test(line)) {
            throw new Error('The dependency manifest contains an unsupported requirement. '
                + 'URLs, local paths, editable installs, nested manifests, options, and environment markers are blocked.');
        }
        requirements.push(line);
        if (requirements.length > exports.MAX_DEPENDENCY_REQUIREMENTS) {
            throw new Error(`A dependency installation is limited to ${exports.MAX_DEPENDENCY_REQUIREMENTS} requirements.`);
        }
    }
    if (requirements.length === 0) {
        throw new Error('The dependency manifest does not contain any installable requirements.');
    }
    return requirements;
}
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
exports.AGENT_TOOL_NAMES = [
    'list_files',
    'read_file',
    'search_code',
    'get_symbols',
    'find_definition',
    'find_references',
    'get_diagnostics',
    'read_terminal_errors',
    'create_file',
    'edit_file',
    'delete_file',
    'rename_file',
    'move_file',
    'install_dependencies',
    'run_command'
];
// Tool groups live here so checkpoints and loop limits cannot quietly drift apart.
exports.READ_ONLY_AGENT_TOOL_NAMES = [
    'list_files',
    'read_file',
    'search_code',
    'get_symbols',
    'find_definition',
    'find_references',
    'get_diagnostics',
    'read_terminal_errors'
];
exports.FILE_MUTATION_AGENT_TOOL_NAMES = [
    'create_file',
    'edit_file',
    'delete_file',
    'rename_file',
    'move_file'
];
const readOnlyAgentTools = new Set(exports.READ_ONLY_AGENT_TOOL_NAMES);
const fileMutationAgentTools = new Set(exports.FILE_MUTATION_AGENT_TOOL_NAMES);
function isReadOnlyAgentTool(name) {
    return readOnlyAgentTools.has(name);
}
function isFileMutationAgentTool(name) {
    return fileMutationAgentTools.has(name);
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
            arguments: parseInstallDependenciesArguments(call.arguments)
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
            content: (0, fileTools_1.agentHistoryOmissionMarker)('content', call.arguments.content.length, hashText(call.arguments.content))
        });
    }
    if (call.name === 'edit_file') {
        const serializedReplacements = JSON.stringify(call.arguments.replacements);
        return boundedAgentToolHistoryArguments(call.name, {
            path: call.arguments.path,
            replacementCount: call.arguments.replacements.length,
            replacements: (0, fileTools_1.agentHistoryOmissionMarker)('text', serializedReplacements.length, hashText(serializedReplacements))
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
        summary: (0, fileTools_1.agentHistoryOmissionMarker)('content', serialized.length, hashText(`${name}:${serialized}`))
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