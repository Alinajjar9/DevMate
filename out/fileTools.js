"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_EDIT_REPLACEMENTS = void 0;
exports.parseCreateFileArguments = parseCreateFileArguments;
exports.parseEditFileArguments = parseEditFileArguments;
exports.applyExactReplacements = applyExactReplacements;
const fileChanges_1 = require("./fileChanges");
exports.MAX_EDIT_REPLACEMENTS = 20;
function parseCreateFileArguments(value) {
    if (typeof value.path !== 'string' || typeof value.content !== 'string') {
        throw new Error('create_file requires a path and complete text content.');
    }
    const [change] = (0, fileChanges_1.validateFileChanges)([{
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
        argumentCharacters += candidate.oldText.length + candidate.newText.length;
        if (argumentCharacters > fileChanges_1.MAX_TOTAL_CHANGE_CHARACTERS) {
            throw new Error('The edit replacements exceed the total size limit.');
        }
        replacements.push({ oldText: candidate.oldText, newText: candidate.newText });
    }
    return {
        path: (0, fileChanges_1.normalizeWorkspaceRelativePath)(value.path),
        replacements
    };
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
        if (updated.length > fileChanges_1.MAX_FILE_CHANGE_CHARACTERS) {
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
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=fileTools.js.map