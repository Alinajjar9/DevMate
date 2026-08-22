"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteLexicalProjectRetriever = exports.LexicalProjectRetriever = void 0;
const crypto_1 = require("crypto");
const client_1 = require("./api/client");
const types_1 = require("./api/types");
const projectIndex_1 = require("./projectIndex");
class LexicalProjectRetriever {
    async retrieve(request) {
        const index = request.index ?? await request.loadIndex?.();
        return index
            ? (0, projectIndex_1.retrieveProjectChunks)(index, request.question, request.limits)
            : [];
    }
}
exports.LexicalProjectRetriever = LexicalProjectRetriever;
class SqliteLexicalProjectRetriever {
    options;
    fallback;
    search;
    constructor(options) {
        this.options = options;
        this.fallback = options.fallback ?? new LexicalProjectRetriever();
        this.search = options.search ?? ((access, request, signal) => (0, client_1.searchKnowledgeIndex)(access.backendUrl, request, access.backendToken, signal));
    }
    async retrieve(request) {
        const access = this.options.getAccess();
        const maxChunks = Math.max(0, Math.min(request.limits.maxChunks ?? 5, 5));
        const maxCharacters = Math.max(0, request.limits.maxCharacters ?? 40_000);
        if (maxChunks === 0 || maxCharacters === 0) {
            return [];
        }
        if (!access || !request.workspaceKey) {
            return this.fallback.retrieve(request);
        }
        if (request.signal?.aborted) {
            return [];
        }
        const response = await this.search(access, {
            workspaceKey: request.workspaceKey,
            query: request.question.slice(0, types_1.MAX_LEXICAL_QUERY_CHARACTERS),
            limit: Math.min(types_1.MAX_LEXICAL_RESULTS, Math.max(20, maxChunks * 4))
        }, request.signal);
        if (request.signal?.aborted || response.errorKind === 'cancelled') {
            return [];
        }
        if (response.status !== 'ok' || !response.data || response.data.results.length === 0) {
            return this.fallback.retrieve(request);
        }
        const excludedPaths = new Set([...(request.limits.excludedFilePaths ?? [])].map(normalizeFilePath));
        const selected = [];
        const selectedFiles = new Set();
        let remainingCharacters = maxCharacters;
        for (const result of response.data.results) {
            if (selected.length >= maxChunks || remainingCharacters <= 0) {
                break;
            }
            if (request.signal?.aborted) {
                return [];
            }
            const normalizedRelativePath = normalizeFilePath(result.relativePath);
            if (selectedFiles.has(normalizedRelativePath)) {
                continue;
            }
            const currentFile = await this.options.readCurrentFile(result.relativePath, request.signal);
            if (!currentFile
                || excludedPaths.has(normalizeFilePath(currentFile.filePath))
                || normalizeFilePath(currentFile.relativePath) !== normalizedRelativePath) {
                continue;
            }
            const exactContent = exactCurrentChunk(currentFile.content, result);
            if (exactContent === undefined) {
                continue;
            }
            const content = exactContent.slice(0, remainingCharacters);
            selected.push({
                filePath: currentFile.filePath,
                relativePath: currentFile.relativePath,
                languageId: currentFile.languageId,
                totalCharacters: currentFile.content.length,
                startLine: result.startLine,
                endLine: result.endLine,
                content,
                score: result.score
            });
            selectedFiles.add(normalizedRelativePath);
            remainingCharacters -= content.length;
        }
        return selected.length > 0
            ? selected
            : this.fallback.retrieve(request);
    }
}
exports.SqliteLexicalProjectRetriever = SqliteLexicalProjectRetriever;
function exactCurrentChunk(fileContent, result) {
    if (sha256Hex(result.content) !== result.contentHash) {
        return undefined;
    }
    const lineOffsets = collectLineOffsets(fileContent);
    const expectedLineIndex = result.startLine - 1;
    if (expectedLineIndex < 0 || expectedLineIndex >= lineOffsets.length) {
        return undefined;
    }
    const firstMatchOffset = lineOffsets[expectedLineIndex];
    const maximumMatchOffset = lineOffsets[expectedLineIndex + 1] ?? fileContent.length + 1;
    let matchOffset = fileContent.indexOf(result.content, firstMatchOffset);
    while (matchOffset >= 0 && matchOffset < maximumMatchOffset) {
        const startLine = lineNumberAtOffset(lineOffsets, matchOffset);
        const endLine = lineNumberAtOffset(lineOffsets, matchOffset + Math.max(0, result.content.length - 1));
        if (startLine === result.startLine && endLine === result.endLine) {
            return fileContent.slice(matchOffset, matchOffset + result.content.length);
        }
        matchOffset = fileContent.indexOf(result.content, matchOffset + 1);
    }
    return undefined;
}
function collectLineOffsets(content) {
    const offsets = [0];
    for (let index = 0; index < content.length; index += 1) {
        if (content[index] === '\n') {
            offsets.push(index + 1);
        }
    }
    return offsets;
}
function lineNumberAtOffset(lineOffsets, offset) {
    let low = 0;
    let high = lineOffsets.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (lineOffsets[middle] <= offset) {
            low = middle + 1;
        }
        else {
            high = middle;
        }
    }
    return Math.max(1, low);
}
function sha256Hex(value) {
    return (0, crypto_1.createHash)('sha256').update(value).digest('hex');
}
function normalizeFilePath(value) {
    const normalized = value.replace(/\\/g, '/');
    return process.platform === 'win32'
        ? normalized.toLocaleLowerCase('en-US')
        : normalized;
}
//# sourceMappingURL=projectRetriever.js.map