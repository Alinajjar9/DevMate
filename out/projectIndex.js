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
exports.PROJECT_EXCLUDE_GLOB = exports.MAX_ATTACHED_FILES = exports.MAX_ATTACHMENT_CANDIDATES = exports.MAX_PROJECT_CONTEXT_CHARACTERS = exports.MAX_PROJECT_FILE_CHARACTERS = exports.MAX_PROJECT_FILES = exports.MAX_PROJECT_FILE_BYTES = exports.MAX_PROJECT_CANDIDATES = exports.MAX_CONTEXT_CHARACTERS = exports.PROJECT_CHUNK_OVERLAP_CHARACTERS = exports.MAX_PROJECT_CHUNK_CHARACTERS = exports.MAX_PROJECT_INDEX_FILE_CHARACTERS = exports.MAX_PROJECT_INDEX_FILES = exports.PROJECT_INDEX_FILE_NAME = exports.PROJECT_INDEX_VERSION = void 0;
exports.selectProjectContext = selectProjectContext;
exports.shouldSkipProjectFile = shouldSkipProjectFile;
exports.containsBinaryData = containsBinaryData;
exports.languageIdForPath = languageIdForPath;
exports.createBoundedContextItem = createBoundedContextItem;
exports.createEmptyProjectIndex = createEmptyProjectIndex;
exports.createIndexedProjectFile = createIndexedProjectFile;
exports.splitProjectContent = splitProjectContent;
exports.retrieveProjectChunks = retrieveProjectChunks;
exports.parseStoredProjectIndex = parseStoredProjectIndex;
const path = __importStar(require("path"));
exports.PROJECT_INDEX_VERSION = 1;
exports.PROJECT_INDEX_FILE_NAME = 'project-index-v1.json';
exports.MAX_PROJECT_INDEX_FILES = 500;
exports.MAX_PROJECT_INDEX_FILE_CHARACTERS = 40_000;
exports.MAX_PROJECT_CHUNK_CHARACTERS = 3_200;
exports.PROJECT_CHUNK_OVERLAP_CHARACTERS = 320;
//from projectContext.ts
exports.MAX_CONTEXT_CHARACTERS = 20_000;
exports.MAX_PROJECT_CANDIDATES = 200;
exports.MAX_PROJECT_FILE_BYTES = 200_000;
exports.MAX_PROJECT_FILES = 5;
exports.MAX_PROJECT_FILE_CHARACTERS = 8_000;
exports.MAX_PROJECT_CONTEXT_CHARACTERS = 40_000;
exports.MAX_ATTACHMENT_CANDIDATES = 1_000;
exports.MAX_ATTACHED_FILES = 5;
exports.PROJECT_EXCLUDE_GLOB = '**/{.git,node_modules,.venv,venv,out,dist,build,coverage,.cache,__pycache__,.next,target,vendor}/**';
const retrievalStopWords = new Set([
    'a', 'an', 'and', 'are', 'can', 'could', 'do', 'does', 'for', 'from', 'how',
    'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'please', 'project',
    'should', 'that', 'the', 'this', 'to', 'what', 'when', 'where', 'which', 'with',
    'would', 'you'
]);
//from projectContext.ts
const ignoredDirectoryNames = new Set([
    '.git',
    'node_modules',
    '.venv',
    'venv',
    'out',
    'dist',
    'build',
    'coverage',
    '.cache',
    '__pycache__',
    '.next',
    'target',
    'vendor'
]);
const ignoredFileNames = new Set([
    '.env',
    '.npmrc',
    '.pypirc',
    'credentials',
    'credentials.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'secrets.json',
    'yarn.lock',
    'poetry.lock'
]);
const binaryExtensions = new Set([
    '.7z', '.avi', '.bmp', '.class', '.dll', '.doc', '.docx', '.eot', '.exe', '.gif',
    '.gz', '.ico', '.jar', '.jpeg', '.jpg', '.key', '.lockb', '.mov', '.mp3', '.mp4', '.o',
    '.obj', '.otf', '.p12', '.pdf', '.pem', '.pfx', '.png', '.pyc', '.rar', '.so', '.tar', '.ttf', '.wav',
    '.webm', '.webp', '.woff', '.woff2', '.xls', '.xlsx', '.zip'
]);
const stopWords = new Set([
    'a', 'an', 'and', 'are', 'can', 'does', 'explain', 'for', 'from', 'how', 'in',
    'is', 'it', 'me', 'of', 'on', 'please', 'project', 'show', 'that', 'the', 'this',
    'to', 'what', 'where', 'which', 'with'
]);
const baselineScores = {
    'readme.md': 8,
    'package.json': 7,
    'pyproject.toml': 7,
    'requirements.txt': 6,
    'cargo.toml': 7,
    'go.mod': 7,
    'pom.xml': 7,
    'build.gradle': 7,
    'settings.gradle': 6,
    'tsconfig.json': 5
};
const languageByExtension = {
    '.c': 'c',
    '.cpp': 'cpp',
    '.cs': 'csharp',
    '.css': 'css',
    '.go': 'go',
    '.html': 'html',
    '.java': 'java',
    '.js': 'javascript',
    '.json': 'json',
    '.jsx': 'javascriptreact',
    '.kt': 'kotlin',
    '.md': 'markdown',
    '.php': 'php',
    '.py': 'python',
    '.rb': 'ruby',
    '.rs': 'rust',
    '.scss': 'scss',
    '.sh': 'shellscript',
    '.sql': 'sql',
    '.swift': 'swift',
    '.toml': 'toml',
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.xml': 'xml',
    '.yaml': 'yaml',
    '.yml': 'yaml'
};
function selectProjectContext(candidates, question, limits = {}) {
    const maxFiles = Math.min(Math.max(0, limits.maxFiles ?? exports.MAX_PROJECT_FILES), exports.MAX_PROJECT_FILES);
    const maxCharacters = Math.min(Math.max(0, limits.maxCharacters ?? exports.MAX_PROJECT_CONTEXT_CHARACTERS), exports.MAX_PROJECT_CONTEXT_CHARACTERS);
    const tokens = tokenizeQuestion(question);
    const rankedCandidates = candidates
        .filter((candidate) => candidate.content.trim().length > 0)
        .map((candidate) => ({
        candidate,
        score: scoreCandidate(candidate, tokens)
    }))
        .sort((left, right) => right.score - left.score || left.candidate.relativePath.localeCompare(right.candidate.relativePath));
    const items = [];
    let remainingCharacters = maxCharacters;
    for (const { candidate } of rankedCandidates) {
        if (items.length >= maxFiles || remainingCharacters <= 0) {
            break;
        }
        const itemLimit = Math.min(exports.MAX_PROJECT_FILE_CHARACTERS, remainingCharacters);
        const item = createBoundedContextItem('file', candidate.filePath, candidate.languageId, candidate.content, itemLimit);
        items.push(item);
        remainingCharacters -= item.includedCharacters;
    }
    return items;
}
function shouldSkipProjectFile(relativePath) {
    const normalizedPath = relativePath.replace(/\\/g, '/').toLowerCase();
    const parts = normalizedPath.split('/');
    const fileName = parts.at(-1) ?? '';
    const extension = path.extname(fileName);
    return parts.slice(0, -1).some((part) => ignoredDirectoryNames.has(part))
        || ignoredFileNames.has(fileName)
        || fileName.startsWith('.env.')
        || fileName.endsWith('.min.js')
        || fileName.endsWith('.min.css')
        || fileName.endsWith('.map')
        || binaryExtensions.has(extension);
}
function containsBinaryData(bytes) {
    const inspectedLength = Math.min(bytes.length, 8_000);
    for (let index = 0; index < inspectedLength; index += 1) {
        if (bytes[index] === 0) {
            return true;
        }
    }
    return false;
}
function languageIdForPath(filePath) {
    return languageByExtension[path.extname(filePath).toLowerCase()] ?? 'plaintext';
}
// merge from context.ts
function createBoundedContextItem(source, filePath, languageId, content, maxCharacters = exports.MAX_CONTEXT_CHARACTERS) {
    const safeLimit = Math.min(Math.max(0, maxCharacters), exports.MAX_CONTEXT_CHARACTERS);
    const boundedContent = content.slice(0, safeLimit);
    return {
        source,
        filePath,
        languageId,
        content: boundedContent,
        includedCharacters: boundedContent.length,
        totalCharacters: content.length,
        truncated: boundedContent.length < content.length
    };
}
// merge ends
function tokenizeQuestion(question) {
    const words = question.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
    return [...new Set(words.filter((word) => word.length >= 2 && !stopWords.has(word)))].slice(0, 16);
}
function scoreCandidate(candidate, tokens) {
    const normalizedPath = candidate.relativePath.replace(/\\/g, '/').toLocaleLowerCase();
    const fileName = path.basename(normalizedPath);
    const content = candidate.content.toLocaleLowerCase();
    let score = baselineScores[fileName] ?? (normalizedPath.startsWith('src/') ? 1 : 0);
    for (const token of tokens) {
        if (fileName === token) {
            score += 20;
        }
        else if (fileName.includes(token)) {
            score += 12;
        }
        if (normalizedPath.includes(token)) {
            score += 6;
        }
        score += Math.min(countOccurrences(content, token), 5) * 2;
    }
    return score;
}
function countOccurrences(content, token) {
    let count = 0;
    let offset = 0;
    while (count < 5) {
        const index = content.indexOf(token, offset);
        if (index < 0) {
            break;
        }
        count += 1;
        offset = index + token.length;
    }
    return count;
}
//end of merge from context.ts
function createEmptyProjectIndex(workspacePath) {
    return {
        version: exports.PROJECT_INDEX_VERSION,
        workspacePath,
        updatedAt: Date.now(),
        files: []
    };
}
function createIndexedProjectFile(candidate, size, modifiedAt) {
    const indexableContent = candidate.content.slice(0, exports.MAX_PROJECT_INDEX_FILE_CHARACTERS);
    return {
        filePath: candidate.filePath,
        relativePath: normalizeRelativePath(candidate.relativePath),
        languageId: candidate.languageId,
        size,
        modifiedAt,
        totalCharacters: candidate.content.length,
        chunks: splitProjectContent(indexableContent, candidate.relativePath)
    };
}
function splitProjectContent(content, relativePath) {
    if (!content.trim()) {
        return [];
    }
    const chunks = [];
    const newlineOffsets = collectNewlineOffsets(content);
    let startOffset = 0;
    while (startOffset < content.length) {
        let endOffset = Math.min(content.length, startOffset + exports.MAX_PROJECT_CHUNK_CHARACTERS);
        if (endOffset < content.length) {
            const newlineBoundary = content.lastIndexOf('\n', endOffset);
            if (newlineBoundary >= startOffset + Math.floor(exports.MAX_PROJECT_CHUNK_CHARACTERS * 0.6)) {
                endOffset = newlineBoundary + 1;
            }
        }
        const chunkContent = content.slice(startOffset, endOffset);
        if (chunkContent.trim()) {
            const startLine = lineNumberAtOffset(newlineOffsets, startOffset);
            const endLine = lineNumberAtOffset(newlineOffsets, Math.max(startOffset, endOffset - 1));
            chunks.push({
                id: `${normalizeRelativePath(relativePath)}:${startLine}-${endLine}`,
                startLine,
                endLine,
                content: chunkContent
            });
        }
        if (endOffset >= content.length) {
            break;
        }
        // A small overlap keeps declarations and their surrounding code together across chunk boundaries.
        const overlapTarget = Math.max(startOffset + 1, endOffset - exports.PROJECT_CHUNK_OVERLAP_CHARACTERS);
        const overlapBoundary = content.lastIndexOf('\n', overlapTarget);
        startOffset = overlapBoundary >= startOffset
            ? overlapBoundary + 1
            : overlapTarget;
    }
    return chunks;
}
function retrieveProjectChunks(index, question, limits = {}) {
    const queryTokens = [...new Set(tokenizeForRetrieval(question))].slice(0, 24);
    if (queryTokens.length === 0) {
        return [];
    }
    const maxChunks = Math.max(0, Math.min(limits.maxChunks ?? 5, 5));
    const maxCharacters = Math.max(0, limits.maxCharacters ?? 40_000);
    const excludedPaths = new Set([...(limits.excludedFilePaths ?? [])].map(normalizeFilePath));
    const documents = index.files.flatMap((file) => {
        const normalizedFilePath = normalizeFilePath(file.filePath);
        if (excludedPaths.has(normalizedFilePath)) {
            return [];
        }
        return file.chunks.map((chunk) => {
            const tokens = tokenizeForRetrieval(chunk.content);
            const frequencies = new Map();
            for (const token of tokens) {
                if (queryTokens.includes(token)) {
                    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
                }
            }
            return { file, chunk, normalizedFilePath, tokens, frequencies };
        });
    });
    if (documents.length === 0) {
        return [];
    }
    // Rare matching terms carry more weight than words repeated throughout the project.
    const documentFrequency = new Map();
    for (const token of queryTokens) {
        documentFrequency.set(token, documents.filter((document) => document.frequencies.has(token)).length);
    }
    const averageLength = Math.max(1, documents.reduce((total, document) => total + document.tokens.length, 0) / documents.length);
    const scored = documents.map((document) => {
        const normalizedRelativePath = document.file.relativePath.toLocaleLowerCase();
        const fileName = path.basename(normalizedRelativePath);
        let score = 0;
        for (const token of queryTokens) {
            const frequency = document.frequencies.get(token) ?? 0;
            if (frequency > 0) {
                const containingDocuments = documentFrequency.get(token) ?? 0;
                const inverseFrequency = Math.log(1 + (documents.length - containingDocuments + 0.5) / (containingDocuments + 0.5));
                const lengthRatio = document.tokens.length / averageLength;
                score += inverseFrequency * ((frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * lengthRatio)));
            }
            if (fileName === token) {
                score += 8;
            }
            else if (fileName.includes(token)) {
                score += 4;
            }
            else if (normalizedRelativePath.includes(token)) {
                score += 2;
            }
        }
        return {
            filePath: document.file.filePath,
            relativePath: document.file.relativePath,
            languageId: document.file.languageId,
            totalCharacters: document.file.totalCharacters,
            startLine: document.chunk.startLine,
            endLine: document.chunk.endLine,
            content: document.chunk.content,
            score,
            normalizedFilePath: document.normalizedFilePath
        };
    }).filter((chunk) => chunk.score > 0)
        .sort((left, right) => right.score - left.score
        || left.relativePath.localeCompare(right.relativePath)
        || left.startLine - right.startLine);
    const selected = [];
    const selectedFiles = new Set();
    let remainingCharacters = maxCharacters;
    for (const chunk of scored) {
        if (selected.length >= maxChunks || remainingCharacters <= 0) {
            break;
        }
        if (selectedFiles.has(chunk.normalizedFilePath)) {
            continue;
        }
        const boundedContent = chunk.content.slice(0, remainingCharacters);
        if (!boundedContent.trim()) {
            continue;
        }
        const { normalizedFilePath: _normalizedFilePath, ...retrievedChunk } = chunk;
        selected.push({ ...retrievedChunk, content: boundedContent });
        selectedFiles.add(chunk.normalizedFilePath);
        remainingCharacters -= boundedContent.length;
    }
    return selected;
}
function parseStoredProjectIndex(value, workspacePath) {
    if (!isRecord(value)
        || value.version !== exports.PROJECT_INDEX_VERSION
        || value.workspacePath !== workspacePath
        || typeof value.updatedAt !== 'number'
        || !Array.isArray(value.files)
        || value.files.length > exports.MAX_PROJECT_INDEX_FILES) {
        return undefined;
    }
    const files = [];
    for (const candidate of value.files) {
        if (!isStoredProjectIndexFile(candidate)) {
            return undefined;
        }
        files.push(candidate);
    }
    return {
        version: exports.PROJECT_INDEX_VERSION,
        workspacePath,
        updatedAt: value.updatedAt,
        files
    };
}
function isStoredProjectIndexFile(value) {
    if (!isRecord(value)
        || typeof value.filePath !== 'string'
        || typeof value.relativePath !== 'string'
        || typeof value.languageId !== 'string'
        || typeof value.size !== 'number'
        || typeof value.modifiedAt !== 'number'
        || typeof value.totalCharacters !== 'number'
        || !Array.isArray(value.chunks)
        || value.chunks.length > Math.ceil(exports.MAX_PROJECT_INDEX_FILE_CHARACTERS / 1_000)) {
        return false;
    }
    return value.chunks.every((chunk) => isRecord(chunk)
        && typeof chunk.id === 'string'
        && typeof chunk.startLine === 'number'
        && typeof chunk.endLine === 'number'
        && typeof chunk.content === 'string'
        && chunk.content.length <= exports.MAX_PROJECT_CHUNK_CHARACTERS);
}
function tokenizeForRetrieval(value) {
    const expanded = value.replace(/([\p{Ll}\d])([\p{Lu}])/gu, '$1 $2');
    const rawTokens = expanded.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    return rawTokens.filter((token) => token.length >= 2 && !retrievalStopWords.has(token));
}
function collectNewlineOffsets(content) {
    const offsets = [];
    for (let index = 0; index < content.length; index += 1) {
        if (content[index] === '\n') {
            offsets.push(index);
        }
    }
    return offsets;
}
function lineNumberAtOffset(newlineOffsets, offset) {
    let low = 0;
    let high = newlineOffsets.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (newlineOffsets[middle] < offset) {
            low = middle + 1;
        }
        else {
            high = middle;
        }
    }
    return low + 1;
}
function normalizeRelativePath(value) {
    return value.replace(/\\/g, '/');
}
function normalizeFilePath(value) {
    return normalizeRelativePath(value).toLocaleLowerCase();
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=projectIndex.js.map