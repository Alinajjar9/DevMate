"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_FILE_CHANGE_SUMMARY_ITEMS = exports.MAX_TOTAL_CHANGE_CHARACTERS = exports.MAX_FILE_CHANGE_CHARACTERS = exports.MAX_FILE_CHANGES = exports.MAX_EDIT_REPLACEMENTS = void 0;
exports.collectFileChangeSummary = collectFileChangeSummary;
exports.parseAppliedFileChangeOutcome = parseAppliedFileChangeOutcome;
exports.parseFileChangeSummary = parseFileChangeSummary;
exports.agentHistoryOmissionMarker = agentHistoryOmissionMarker;
exports.isAgentHistoryOmissionMarker = isAgentHistoryOmissionMarker;
exports.validateFileChanges = validateFileChanges;
exports.normalizeWorkspaceRelativePath = normalizeWorkspaceRelativePath;
exports.parseCreateFileArguments = parseCreateFileArguments;
exports.parseEditFileArguments = parseEditFileArguments;
exports.parseDeleteFileArguments = parseDeleteFileArguments;
exports.parseRenameFileArguments = parseRenameFileArguments;
exports.parseMoveFileArguments = parseMoveFileArguments;
exports.applyExactReplacements = applyExactReplacements;
const projectIndex_1 = require("./projectIndex");
exports.MAX_EDIT_REPLACEMENTS = 20;
exports.MAX_FILE_CHANGES = 10;
exports.MAX_FILE_CHANGE_CHARACTERS = 200_000;
exports.MAX_TOTAL_CHANGE_CHARACTERS = 500_000;
//from changeSummary.ts
exports.MAX_FILE_CHANGE_SUMMARY_ITEMS = 20;
function collectFileChangeSummary(steps, additionalChanges = []) {
    const changes = new Map();
    for (const step of steps) {
        if (step.isError) {
            continue;
        }
        const path = safePath(step.arguments.path);
        if (!path) {
            continue;
        }
        if (step.name === 'create_file') {
            applyCreated(changes, path);
        }
        else if (step.name === 'edit_file') {
            applyUpdated(changes, path);
        }
        else if (step.name === 'delete_file') {
            applyDeleted(changes, path);
        }
        else if (step.name === 'rename_file' || step.name === 'move_file') {
            const newPath = safePath(step.arguments.newPath);
            if (newPath) {
                applyRelocated(changes, path, newPath, step.name === 'rename_file' ? 'renamed' : 'moved');
            }
        }
    }
    for (const change of parseFileChangeSummary(additionalChanges)) {
        if (change.kind === 'created') {
            applyCreated(changes, change.path);
        }
        else if (change.kind === 'updated') {
            applyUpdated(changes, change.path);
        }
        else if (change.kind === 'deleted') {
            applyDeleted(changes, change.path);
        }
        else if (change.previousPath) {
            applyRelocated(changes, change.previousPath, change.path, change.kind);
        }
    }
    return [...changes.values()].slice(0, exports.MAX_FILE_CHANGE_SUMMARY_ITEMS);
}
function parseAppliedFileChangeOutcome(value) {
    if (!value.startsWith('Applied file changes:')) {
        return [];
    }
    const parsed = [];
    for (const line of value.split(/\r?\n/).slice(1)) {
        const match = /^- (Created|Updated) (.+)$/.exec(line.trim());
        if (!match) {
            continue;
        }
        const path = safePath(match[2]);
        if (path) {
            parsed.push({
                kind: match[1] === 'Created' ? 'created' : 'updated',
                path
            });
        }
    }
    return parsed.slice(0, exports.MAX_FILE_CHANGE_SUMMARY_ITEMS);
}
function parseFileChangeSummary(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const parsed = [];
    for (const candidate of value.slice(0, exports.MAX_FILE_CHANGE_SUMMARY_ITEMS)) {
        if (!isRecordS(candidate) || !isKind(candidate.kind)) {
            continue;
        }
        const path = safePath(candidate.path);
        const previousPath = safePath(candidate.previousPath);
        const diffId = safeDiffId(candidate.diffId);
        if (!path || (candidate.kind === 'renamed' || candidate.kind === 'moved') && !previousPath) {
            continue;
        }
        parsed.push({
            kind: candidate.kind,
            path,
            ...(previousPath ? { previousPath } : {}),
            ...(diffId ? { diffId } : {})
        });
    }
    return parsed;
}
function safeDiffId(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value)
        ? value
        : undefined;
}
function applyCreated(changes, path) {
    changes.set(key(path), { kind: 'created', path });
}
function applyUpdated(changes, path) {
    const existing = changes.get(key(path));
    if (existing?.kind === 'created' || existing?.kind === 'renamed' || existing?.kind === 'moved') {
        return;
    }
    changes.set(key(path), { kind: 'updated', path });
}
function applyDeleted(changes, path) {
    const existing = changes.get(key(path));
    if (existing?.kind === 'created') {
        changes.delete(key(path));
        return;
    }
    if ((existing?.kind === 'renamed' || existing?.kind === 'moved') && existing.previousPath) {
        changes.delete(key(path));
        changes.set(key(existing.previousPath), { kind: 'deleted', path: existing.previousPath });
        return;
    }
    changes.set(key(path), { kind: 'deleted', path });
}
function applyRelocated(changes, path, newPath, kind) {
    const existing = changes.get(key(path));
    changes.delete(key(path));
    if (existing?.kind === 'created') {
        changes.set(key(newPath), { kind: 'created', path: newPath });
        return;
    }
    const previousPath = existing?.previousPath ?? path;
    if (key(previousPath) === key(newPath)) {
        if (existing?.kind === 'updated') {
            changes.set(key(newPath), { kind: 'updated', path: newPath });
        }
        return;
    }
    changes.set(key(newPath), { kind, path: newPath, previousPath });
}
function safePath(value) {
    if (typeof value !== 'string' || value.length > 2_048) {
        return undefined;
    }
    try {
        return normalizeWorkspaceRelativePath(value);
    }
    catch {
        return undefined;
    }
}
function key(value) {
    return process.platform === 'win32' ? value.toLocaleLowerCase() : value;
}
function isKind(value) {
    return value === 'created'
        || value === 'updated'
        || value === 'deleted'
        || value === 'renamed'
        || value === 'moved';
}
function isRecordS(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//end of merge from changeSummary.ts
//from fileChanges.ts
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
        if (!isRecordC(candidate) || typeof candidate.path !== 'string' || typeof candidate.content !== 'string') {
            throw new Error('The backend returned an invalid file change.');
        }
        const path = normalizeWorkspaceRelativePath(candidate.path);
        const comparablePath = path.toLocaleLowerCase();
        if (seenPaths.has(comparablePath)) {
            throw new Error(`DevMate proposed ${path} more than once.`);
        }
        if ((0, projectIndex_1.shouldSkipProjectFile)(path)) {
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
function isRecordC(value) {
    return typeof value === 'object' && value !== null;
}
function parseCreateFileArguments(value) {
    if (typeof value.path !== 'string' || typeof value.content !== 'string') {
        throw new Error('create_file requires a path and complete text content.');
    }
    const [change] = validateFileChanges([{
            path: value.path,
            content: value.content
        }]);
    return change;
}
function parseEditFileArguments(value) {
    if (typeof value.path !== 'string') {
        throw new Error('edit_file requires a workspace-relative path.');
    }
    if (!Array.isArray(value.replacements)
        || value.replacements.length === 0
        || value.replacements.length > exports.MAX_EDIT_REPLACEMENTS) {
        throw new Error(`edit_file requires between 1 and ${exports.MAX_EDIT_REPLACEMENTS} replacements.`);
    }
    const replacements = [];
    let argumentCharacters = 0;
    for (const candidate of value.replacements) {
        if (!isRecord(candidate)
            || typeof candidate.oldText !== 'string'
            || typeof candidate.newText !== 'string'
            || !candidate.oldText) {
            throw new Error('Every edit replacement requires non-empty oldText and string newText.');
        }
        if (candidate.oldText.includes('\0') || candidate.newText.includes('\0')) {
            throw new Error('DevMate will not edit binary content.');
        }
        if (isAgentHistoryOmissionMarker(candidate.oldText)
            || isAgentHistoryOmissionMarker(candidate.newText)) {
            throw new Error('DevMate rejected an internal tool-history marker as edit text. '
                + 'Read the current file and provide real replacement text.');
        }
        argumentCharacters += candidate.oldText.length + candidate.newText.length;
        if (argumentCharacters > exports.MAX_TOTAL_CHANGE_CHARACTERS) {
            throw new Error('The edit replacements exceed the total size limit.');
        }
        replacements.push({ oldText: candidate.oldText, newText: candidate.newText });
    }
    return {
        path: normalizeWorkspaceRelativePath(value.path),
        replacements
    };
}
function parseDeleteFileArguments(value) {
    if (typeof value.path !== 'string') {
        throw new Error('delete_file requires a workspace-relative path.');
    }
    return { path: eligibleLifecyclePath(value.path) };
}
function parseRenameFileArguments(value) {
    const parsed = parseRelocateFileArguments(value, 'rename_file');
    if (parentPath(parsed.path).toLocaleLowerCase() !== parentPath(parsed.newPath).toLocaleLowerCase()) {
        throw new Error('rename_file must keep the file in the same directory; use move_file instead.');
    }
    return parsed;
}
function parseMoveFileArguments(value) {
    return parseRelocateFileArguments(value, 'move_file');
}
function applyExactReplacements(content, replacements) {
    let updated = content;
    for (let index = 0; index < replacements.length; index += 1) {
        const replacement = replacements[index];
        const match = findReplacementMatch(updated, replacement.oldText);
        if (!match) {
            throw new Error(`Replacement ${index + 1} did not match the current file. `
                + 'Use read_file around the relevant lines and copy oldText exactly, including broken syntax and whitespace.');
        }
        if (match.occurrences > 1) {
            throw new Error(`Replacement ${index + 1} matched more than once; provide a more specific oldText value.`);
        }
        const targetEol = lineEndingFor(match.value) ?? lineEndingFor(updated);
        const newText = targetEol
            ? normalizeLineEndings(replacement.newText, targetEol)
            : replacement.newText;
        updated = updated.replace(match.value, newText);
        if (updated.length > exports.MAX_FILE_CHANGE_CHARACTERS) {
            throw new Error('The edited file exceeds the per-file change limit.');
        }
    }
    if (updated === content) {
        throw new Error('The requested replacements do not change the file.');
    }
    return updated;
}
function findReplacementMatch(content, oldText) {
    const exactOccurrences = countOccurrences(content, oldText, 2);
    if (exactOccurrences > 0) {
        return { value: oldText, occurrences: exactOccurrences };
    }
    if (!oldText.includes('\n')) {
        return undefined;
    }
    const normalized = oldText.replace(/\r\n/g, '\n');
    const variants = [normalized, normalized.replace(/\n/g, '\r\n')]
        .filter((value, index, values) => value !== oldText && values.indexOf(value) === index);
    for (const variant of variants) {
        const occurrences = countOccurrences(content, variant, 2);
        if (occurrences > 0) {
            return { value: variant, occurrences };
        }
    }
    return undefined;
}
function lineEndingFor(value) {
    if (value.includes('\r\n')) {
        return '\r\n';
    }
    return value.includes('\n') ? '\n' : undefined;
}
function normalizeLineEndings(value, lineEnding) {
    return value.replace(/\r\n|\n/g, '\n').replace(/\n/g, lineEnding);
}
function countOccurrences(content, value, limit) {
    let count = 0;
    let offset = 0;
    while (count < limit) {
        const index = content.indexOf(value, offset);
        if (index < 0) {
            break;
        }
        count += 1;
        offset = index + value.length;
    }
    return count;
}
function parseRelocateFileArguments(value, toolName) {
    if (typeof value.path !== 'string' || typeof value.newPath !== 'string') {
        throw new Error(`${toolName} requires workspace-relative path and newPath values.`);
    }
    const path = eligibleLifecyclePath(value.path);
    const newPath = eligibleLifecyclePath(value.newPath);
    if (path.toLocaleLowerCase() === newPath.toLocaleLowerCase()) {
        throw new Error(`${toolName} requires a different destination path.`);
    }
    return { path, newPath };
}
function eligibleLifecyclePath(value) {
    const path = normalizeWorkspaceRelativePath(value);
    if ((0, projectIndex_1.shouldSkipProjectFile)(path)) {
        throw new Error(`DevMate will not change the protected or unsupported path ${path}.`);
    }
    return path;
}
function parentPath(value) {
    return value.split('/').slice(0, -1).join('/');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=fileTools.js.map