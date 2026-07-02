"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_FILE_CHANGE_SUMMARY_ITEMS = void 0;
exports.collectFileChangeSummary = collectFileChangeSummary;
exports.parseAppliedFileChangeOutcome = parseAppliedFileChangeOutcome;
exports.parseFileChangeSummary = parseFileChangeSummary;
const fileChanges_1 = require("./fileChanges");
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
        if (!isRecord(candidate) || !isKind(candidate.kind)) {
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
        return (0, fileChanges_1.normalizeWorkspaceRelativePath)(value);
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
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=changeSummary.js.map