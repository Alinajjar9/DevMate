"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteProjectRetriever = exports.LexicalProjectRetriever = exports.RECIPROCAL_RANK_FUSION_CONSTANT = exports.SEMANTIC_SEARCH_CAPABILITY = void 0;
exports.fuseProjectSearchResults = fuseProjectSearchResults;
const crypto_1 = require("crypto");
const client_1 = require("./api/client");
const types_1 = require("./api/types");
const projectIndex_1 = require("./projectIndex");
exports.SEMANTIC_SEARCH_CAPABILITY = 'semantic-search-v1';
exports.RECIPROCAL_RANK_FUSION_CONSTANT = 60;
class LexicalProjectRetriever {
    async retrieve(request) {
        const index = request.index ?? await request.loadIndex?.();
        return index
            ? (0, projectIndex_1.retrieveProjectChunks)(index, request.question, request.limits)
            : [];
    }
}
exports.LexicalProjectRetriever = LexicalProjectRetriever;
class SqliteProjectRetriever {
    options;
    fallback;
    search;
    semanticSearch;
    constructor(options) {
        this.options = options;
        this.fallback = options.fallback ?? new LexicalProjectRetriever();
        this.search = options.search ?? ((access, request, signal) => (0, client_1.searchKnowledgeIndex)(access.backendUrl, request, access.backendToken, signal));
        this.semanticSearch = options.semanticSearch ?? ((access, request, providerApiKey, signal) => (0, client_1.searchKnowledgeIndexSemantically)(access.backendUrl, request, {
            backendToken: access.backendToken,
            ...(providerApiKey !== undefined ? { providerApiKey } : {})
        }, undefined, signal));
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
        const resultLimit = Math.max(20, maxChunks * 4);
        const [lexicalResponse, semanticResponse] = await Promise.all([
            this.tryLexicalSearch(access, request, Math.min(types_1.MAX_LEXICAL_RESULTS, resultLimit)),
            this.trySemanticSearch(access, request, Math.min(types_1.MAX_SEMANTIC_RESULTS, resultLimit))
        ]);
        if (request.signal?.aborted
            || lexicalResponse?.errorKind === 'cancelled'
            || semanticResponse?.errorKind === 'cancelled') {
            return [];
        }
        const lexicalResults = successfulResults(lexicalResponse);
        const semanticResults = successfulResults(semanticResponse);
        const rankedResults = lexicalResults.length > 0 && semanticResults.length > 0
            ? fuseProjectSearchResults(lexicalResults, semanticResults, resultLimit)
            : semanticResults.length > 0
                ? semanticResults
                : lexicalResults;
        if (rankedResults.length === 0) {
            return this.fallback.retrieve(request);
        }
        const chunks = await this.currentChunks(rankedResults, request, maxChunks, maxCharacters);
        if (request.signal?.aborted) {
            return [];
        }
        return chunks.length > 0
            ? chunks
            : this.fallback.retrieve(request);
    }
    async tryLexicalSearch(access, request, limit) {
        try {
            return await this.search(access, {
                workspaceKey: request.workspaceKey ?? '',
                query: request.question.slice(0, types_1.MAX_LEXICAL_QUERY_CHARACTERS),
                limit
            }, request.signal);
        }
        catch {
            return undefined;
        }
    }
    async trySemanticSearch(access, request, limit) {
        if (!access.capabilities?.includes(exports.SEMANTIC_SEARCH_CAPABILITY)
            || !this.options.getEmbeddingProfile) {
            return undefined;
        }
        try {
            const profile = await this.options.getEmbeddingProfile();
            if (!profile || request.signal?.aborted) {
                return undefined;
            }
            return await this.semanticSearch(access, {
                workspaceKey: request.workspaceKey ?? '',
                query: request.question.slice(0, types_1.MAX_SEMANTIC_QUERY_CHARACTERS),
                profileId: profile.id,
                provider: profile.provider,
                model: profile.model,
                baseUrl: profile.baseUrl,
                remoteAllowed: profile.remoteAllowed,
                vectorVersion: 1,
                limit
            }, profile.apiKey, request.signal);
        }
        catch {
            return undefined;
        }
    }
    async currentChunks(results, request, maxChunks, maxCharacters) {
        const excludedPaths = new Set([...(request.limits.excludedFilePaths ?? [])].map(normalizeFilePath));
        const selected = [];
        const selectedFiles = new Set();
        let remainingCharacters = maxCharacters;
        for (const result of results) {
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
        return selected;
    }
}
exports.SqliteProjectRetriever = SqliteProjectRetriever;
function fuseProjectSearchResults(lexicalResults, semanticResults, limit) {
    const boundedLimit = Number.isFinite(limit)
        ? Math.max(0, Math.floor(limit))
        : 0;
    if (boundedLimit === 0) {
        return [];
    }
    const entries = new Map();
    const addRanking = (results) => {
        const seen = new Set();
        for (let index = 0; index < results.length; index += 1) {
            const result = results[index];
            const key = searchResultKey(result);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            const rank = index + 1;
            const contribution = 1 / (exports.RECIPROCAL_RANK_FUSION_CONSTANT + rank);
            const existing = entries.get(key);
            if (existing) {
                existing.score += contribution;
                existing.bestRank = Math.min(existing.bestRank, rank);
                existing.sourceCount += 1;
            }
            else {
                entries.set(key, {
                    result,
                    score: contribution,
                    bestRank: rank,
                    sourceCount: 1
                });
            }
        }
    };
    addRanking(lexicalResults);
    addRanking(semanticResults);
    return [...entries.values()]
        .sort((left, right) => (right.score - left.score
        || right.sourceCount - left.sourceCount
        || left.bestRank - right.bestRank
        || compareSearchResults(left.result, right.result)))
        .slice(0, boundedLimit)
        .map((entry) => ({ ...entry.result, score: entry.score }));
}
function successfulResults(response) {
    return response?.status === 'ok' && response.data
        ? response.data.results
        : [];
}
function searchResultKey(result) {
    return `${normalizeFilePath(result.relativePath)}\0${result.stableId}`;
}
function compareSearchResults(left, right) {
    return compareText(left.relativePath.toLocaleLowerCase('en-US'), right.relativePath.toLocaleLowerCase('en-US'))
        || compareText(left.relativePath, right.relativePath)
        || left.ordinal - right.ordinal
        || compareText(left.stableId, right.stableId);
}
function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
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