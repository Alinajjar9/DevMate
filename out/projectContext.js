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
exports.PROJECT_EXCLUDE_GLOB = exports.MAX_PROJECT_CONTEXT_CHARACTERS = exports.MAX_PROJECT_FILE_CHARACTERS = exports.MAX_PROJECT_FILES = exports.MAX_PROJECT_FILE_BYTES = exports.MAX_PROJECT_CANDIDATES = void 0;
exports.selectProjectContext = selectProjectContext;
exports.shouldSkipProjectFile = shouldSkipProjectFile;
exports.containsBinaryData = containsBinaryData;
exports.languageIdForPath = languageIdForPath;
const path = __importStar(require("path"));
const context_1 = require("./context");
exports.MAX_PROJECT_CANDIDATES = 200;
exports.MAX_PROJECT_FILE_BYTES = 200_000;
exports.MAX_PROJECT_FILES = 5;
exports.MAX_PROJECT_FILE_CHARACTERS = 8_000;
exports.MAX_PROJECT_CONTEXT_CHARACTERS = 40_000;
exports.PROJECT_EXCLUDE_GLOB = '**/{.git,node_modules,.venv,venv,out,dist,build,coverage,.cache,__pycache__,.next,target,vendor}/**';
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
function selectProjectContext(candidates, question) {
    const tokens = tokenizeQuestion(question);
    const rankedCandidates = candidates
        .filter((candidate) => candidate.content.trim().length > 0)
        .map((candidate) => ({
        candidate,
        score: scoreCandidate(candidate, tokens)
    }))
        .sort((left, right) => right.score - left.score || left.candidate.relativePath.localeCompare(right.candidate.relativePath));
    const items = [];
    let remainingCharacters = exports.MAX_PROJECT_CONTEXT_CHARACTERS;
    for (const { candidate } of rankedCandidates) {
        if (items.length >= exports.MAX_PROJECT_FILES || remainingCharacters <= 0) {
            break;
        }
        const itemLimit = Math.min(exports.MAX_PROJECT_FILE_CHARACTERS, remainingCharacters);
        const item = (0, context_1.createBoundedContextItem)('file', candidate.filePath, candidate.languageId, candidate.content, itemLimit);
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
//# sourceMappingURL=projectContext.js.map