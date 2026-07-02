"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_TOTAL_CHANGE_CHARACTERS = exports.MAX_FILE_CHANGE_CHARACTERS = exports.MAX_FILE_CHANGES = void 0;
exports.agentHistoryOmissionMarker = agentHistoryOmissionMarker;
exports.isAgentHistoryOmissionMarker = isAgentHistoryOmissionMarker;
exports.validateFileChanges = validateFileChanges;
exports.normalizeWorkspaceRelativePath = normalizeWorkspaceRelativePath;
const projectContext_1 = require("./projectContext");
exports.MAX_FILE_CHANGES = 10;
exports.MAX_FILE_CHANGE_CHARACTERS = 200_000;
exports.MAX_TOTAL_CHANGE_CHARACTERS = 500_000;
const windowsReservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const windowsInvalidCharacters = /[<>:"|?*]/;
const legacyHistoryMarker = /^\[(?:omitted after execution: )?\d+ characters, sha256 [0-9a-f]{16}\]$/i;
const internalHistoryMarker = /^\[DevMate internal history summary: (?:content|text) omitted after execution; \d+ characters; sha256 [0-9a-f]{16}; never use as file content\]$/i;
function agentHistoryOmissionMarker(kind, characters, hash) {
    return `[DevMate internal history summary: ${kind} omitted after execution; `
        + `${characters} characters; sha256 ${hash}; never use as file content]`;
}
function isAgentHistoryOmissionMarker(value) {
    return legacyHistoryMarker.test(value.trim()) || internalHistoryMarker.test(value.trim());
}
function validateFileChanges(value) {
    if (!Array.isArray(value)) {
        throw new Error('The backend returned an invalid file-change list.');
    }
    if (value.length > exports.MAX_FILE_CHANGES) {
        throw new Error(`DevMate can apply at most ${exports.MAX_FILE_CHANGES} files at once.`);
    }
    const changes = [];
    const seenPaths = new Set();
    let totalCharacters = 0;
    for (const candidate of value) {
        if (!isRecord(candidate) || typeof candidate.path !== 'string' || typeof candidate.content !== 'string') {
            throw new Error('The backend returned an invalid file change.');
        }
        const path = normalizeWorkspaceRelativePath(candidate.path);
        const comparablePath = path.toLocaleLowerCase();
        if (seenPaths.has(comparablePath)) {
            throw new Error(`DevMate proposed ${path} more than once.`);
        }
        if ((0, projectContext_1.shouldSkipProjectFile)(path)) {
            throw new Error(`DevMate will not write to the protected or unsupported path ${path}.`);
        }
        if (candidate.content.includes('\0')) {
            throw new Error(`DevMate will not write binary content to ${path}.`);
        }
        if (isAgentHistoryOmissionMarker(candidate.content)) {
            throw new Error(`DevMate rejected an internal tool-history marker as the contents of ${path}. `
                + 'Read or move the real file instead.');
        }
        if (candidate.content.length > exports.MAX_FILE_CHANGE_CHARACTERS) {
            throw new Error(`${path} exceeds the per-file change limit.`);
        }
        totalCharacters += candidate.content.length;
        if (totalCharacters > exports.MAX_TOTAL_CHANGE_CHARACTERS) {
            throw new Error('The proposed file changes exceed the total size limit.');
        }
        seenPaths.add(comparablePath);
        changes.push({ path, content: candidate.content });
    }
    return changes;
}
function normalizeWorkspaceRelativePath(value) {
    const path = value.trim();
    if (!path
        || path.startsWith('/')
        || path.startsWith('\\')
        || /^[A-Za-z]:/.test(path)) {
        throw new Error('Every proposed file must use a workspace-relative path.');
    }
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/');
    if (parts.some((part) => !part
        || part === '.'
        || part === '..'
        || part.endsWith(' ')
        || part.endsWith('.')
        || windowsInvalidCharacters.test(part)
        || windowsReservedNames.test(part))) {
        throw new Error(`The proposed path ${value} contains unsafe or invalid segments.`);
    }
    return parts.join('/');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
//# sourceMappingURL=fileChanges.js.map