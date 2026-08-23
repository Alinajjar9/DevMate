import * as path from 'path';
import type { AskContextItem, ContextSource } from '../api/types';

export const PROJECT_INDEX_VERSION = 1;
export const PROJECT_INDEX_FILE_NAME = 'project-index-v1.json';
export const MAX_PROJECT_INDEX_FILES = 500;
export const MAX_PROJECT_INDEX_FILE_CHARACTERS = 40_000;
export const MAX_PROJECT_CHUNK_CHARACTERS = 3_200;
export const PROJECT_CHUNK_OVERLAP_CHARACTERS = 320;
export const MAX_CONTEXT_CHARACTERS = 20_000;
export const MAX_PROJECT_CANDIDATES = 200;
export const MAX_PROJECT_FILE_BYTES = 200_000;
export const MAX_PROJECT_FILES = 5;
export const MAX_PROJECT_FILE_CHARACTERS = 8_000;
export const MAX_PROJECT_CONTEXT_CHARACTERS = 40_000;
export const MAX_ATTACHMENT_CANDIDATES = 1_000;
export const MAX_ATTACHED_FILES = 5;
export const PROJECT_EXCLUDE_GLOB =
  '**/{.git,node_modules,.venv,venv,out,dist,build,coverage,.cache,__pycache__,.next,target,vendor}/**';

export type ProjectFileCandidate = {
  filePath: string;
  relativePath: string;
  languageId: string;
  content: string;
};

export type ProjectContextLimits = {
  maxFiles?: number;
  maxCharacters?: number;
};
//end
export type ProjectIndexChunk = {
  id: string;
  startLine: number;
  endLine: number;
  content: string;
};

export type ProjectIndexFile = {
  filePath: string;
  relativePath: string;
  languageId: string;
  size: number;
  modifiedAt: number;
  totalCharacters: number;
  chunks: ProjectIndexChunk[];
};

export type ProjectIndex = {
  version: typeof PROJECT_INDEX_VERSION;
  workspacePath: string;
  updatedAt: number;
  files: ProjectIndexFile[];
};

export type RetrievedProjectChunk = {
  filePath: string;
  relativePath: string;
  languageId: string;
  totalCharacters: number;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
};

export type ProjectChunkRetrievalLimits = {
  maxChunks?: number;
  maxCharacters?: number;
  excludedFilePaths?: Set<string>;
};

type ScoredChunk = RetrievedProjectChunk & {
  normalizedFilePath: string;
};

const retrievalStopWords = new Set([
  'a', 'an', 'and', 'are', 'can', 'could', 'do', 'does', 'for', 'from', 'how',
  'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'please', 'project',
  'should', 'that', 'the', 'this', 'to', 'what', 'when', 'where', 'which', 'with',
  'would', 'you'
]);
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

const baselineScores: Record<string, number> = {
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

const languageByExtension: Record<string, string> = {
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

export function selectProjectContext(
  candidates: ProjectFileCandidate[],
  question: string,
  limits: ProjectContextLimits = {}
): AskContextItem[] {
  const maxFiles = Math.min(
    Math.max(0, limits.maxFiles ?? MAX_PROJECT_FILES),
    MAX_PROJECT_FILES
  );
  const maxCharacters = Math.min(
    Math.max(0, limits.maxCharacters ?? MAX_PROJECT_CONTEXT_CHARACTERS),
    MAX_PROJECT_CONTEXT_CHARACTERS
  );
  const tokens = tokenizeQuestion(question);
  const rankedCandidates = candidates
    .filter((candidate) => candidate.content.trim().length > 0)
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, tokens)
    }))
    .sort((left, right) =>
      right.score - left.score || left.candidate.relativePath.localeCompare(right.candidate.relativePath)
    );

  const items: AskContextItem[] = [];
  let remainingCharacters = maxCharacters;

  for (const { candidate } of rankedCandidates) {
    if (items.length >= maxFiles || remainingCharacters <= 0) {
      break;
    }

    const itemLimit = Math.min(MAX_PROJECT_FILE_CHARACTERS, remainingCharacters);
    const item = createBoundedContextItem(
      'file',
      candidate.filePath,
      candidate.languageId,
      candidate.content,
      itemLimit
    );
    items.push(item);
    remainingCharacters -= item.includedCharacters;
  }

  return items;
}

export function shouldSkipProjectFile(relativePath: string): boolean {
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

export function containsBinaryData(bytes: Uint8Array): boolean {
  const inspectedLength = Math.min(bytes.length, 8_000);
  for (let index = 0; index < inspectedLength; index += 1) {
    if (bytes[index] === 0) {
      return true;
    }
  }
  return false;
}

export function languageIdForPath(filePath: string): string {
  return languageByExtension[path.extname(filePath).toLowerCase()] ?? 'plaintext';
}
export function createBoundedContextItem(
  source: ContextSource,
  filePath: string,
  languageId: string,
  content: string,
  maxCharacters = MAX_CONTEXT_CHARACTERS
): AskContextItem {
  const safeLimit = Math.min(Math.max(0, maxCharacters), MAX_CONTEXT_CHARACTERS);
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
function tokenizeQuestion(question: string): string[] {
  const words = question.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return [...new Set(words.filter((word) => word.length >= 2 && !stopWords.has(word)))].slice(0, 16);
}

function scoreCandidate(candidate: ProjectFileCandidate, tokens: string[]): number {
  const normalizedPath = candidate.relativePath.replace(/\\/g, '/').toLocaleLowerCase();
  const fileName = path.basename(normalizedPath);
  const content = candidate.content.toLocaleLowerCase();
  let score = baselineScores[fileName] ?? (normalizedPath.startsWith('src/') ? 1 : 0);

  for (const token of tokens) {
    if (fileName === token) {
      score += 20;
    } else if (fileName.includes(token)) {
      score += 12;
    }

    if (normalizedPath.includes(token)) {
      score += 6;
    }

    score += Math.min(countOccurrences(content, token), 5) * 2;
  }

  return score;
}

function countOccurrences(content: string, token: string): number {
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
export function createEmptyProjectIndex(workspacePath: string): ProjectIndex {
  return {
    version: PROJECT_INDEX_VERSION,
    workspacePath,
    updatedAt: Date.now(),
    files: []
  };
}

export function createIndexedProjectFile(
  candidate: ProjectFileCandidate,
  size: number,
  modifiedAt: number
): ProjectIndexFile {
  const indexableContent = candidate.content.slice(0, MAX_PROJECT_INDEX_FILE_CHARACTERS);
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

export function splitProjectContent(
  content: string,
  relativePath: string
): ProjectIndexChunk[] {
  if (!content.trim()) {
    return [];
  }

  const chunks: ProjectIndexChunk[] = [];
  const newlineOffsets = collectNewlineOffsets(content);
  let startOffset = 0;

  while (startOffset < content.length) {
    let endOffset = Math.min(content.length, startOffset + MAX_PROJECT_CHUNK_CHARACTERS);
    if (endOffset < content.length) {
      const newlineBoundary = content.lastIndexOf('\n', endOffset);
      if (newlineBoundary >= startOffset + Math.floor(MAX_PROJECT_CHUNK_CHARACTERS * 0.6)) {
        endOffset = newlineBoundary + 1;
      }
    }

    const chunkContent = content.slice(startOffset, endOffset);
    if (chunkContent.trim()) {
      const startLine = lineNumberAtOffset(newlineOffsets, startOffset);
      const endLine = lineNumberAtOffset(
        newlineOffsets,
        Math.max(startOffset, endOffset - 1)
      );
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
    const overlapTarget = Math.max(startOffset + 1, endOffset - PROJECT_CHUNK_OVERLAP_CHARACTERS);
    const overlapBoundary = content.lastIndexOf('\n', overlapTarget);
    startOffset = overlapBoundary >= startOffset
      ? overlapBoundary + 1
      : overlapTarget;
  }

  return chunks;
}

export function retrieveProjectChunks(
  index: ProjectIndex,
  question: string,
  limits: ProjectChunkRetrievalLimits = {}
): RetrievedProjectChunk[] {
  const queryTokens = [...new Set(tokenizeForRetrieval(question))].slice(0, 24);
  if (queryTokens.length === 0) {
    return [];
  }

  const maxChunks = Math.max(0, Math.min(limits.maxChunks ?? 5, 5));
  const maxCharacters = Math.max(0, limits.maxCharacters ?? 40_000);
  const excludedPaths = new Set(
    [...(limits.excludedFilePaths ?? [])].map(normalizeFilePath)
  );
  const documents = index.files.flatMap((file) => {
    const normalizedFilePath = normalizeFilePath(file.filePath);
    if (excludedPaths.has(normalizedFilePath)) {
      return [];
    }
    return file.chunks.map((chunk) => {
      const tokens = tokenizeForRetrieval(chunk.content);
      const frequencies = new Map<string, number>();
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
  const documentFrequency = new Map<string, number>();
  for (const token of queryTokens) {
    documentFrequency.set(
      token,
      documents.filter((document) => document.frequencies.has(token)).length
    );
  }
  const averageLength = Math.max(
    1,
    documents.reduce((total, document) => total + document.tokens.length, 0) / documents.length
  );

  const scored: ScoredChunk[] = documents.map((document) => {
    const normalizedRelativePath = document.file.relativePath.toLocaleLowerCase();
    const fileName = path.basename(normalizedRelativePath);
    let score = 0;

    for (const token of queryTokens) {
      const frequency = document.frequencies.get(token) ?? 0;
      if (frequency > 0) {
        const containingDocuments = documentFrequency.get(token) ?? 0;
        const inverseFrequency = Math.log(
          1 + (documents.length - containingDocuments + 0.5) / (containingDocuments + 0.5)
        );
        const lengthRatio = document.tokens.length / averageLength;
        score += inverseFrequency * (
          (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * lengthRatio))
        );
      }
      if (fileName === token) {
        score += 8;
      } else if (fileName.includes(token)) {
        score += 4;
      } else if (normalizedRelativePath.includes(token)) {
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
    .sort((left, right) =>
      right.score - left.score
      || left.relativePath.localeCompare(right.relativePath)
      || left.startLine - right.startLine
    );

  const selected: RetrievedProjectChunk[] = [];
  const selectedFiles = new Set<string>();
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

export function parseStoredProjectIndex(
  value: unknown,
  workspacePath: string
): ProjectIndex | undefined {
  if (!isRecord(value)
    || value.version !== PROJECT_INDEX_VERSION
    || value.workspacePath !== workspacePath
    || typeof value.updatedAt !== 'number'
    || !Array.isArray(value.files)
    || value.files.length > MAX_PROJECT_INDEX_FILES) {
    return undefined;
  }

  const files: ProjectIndexFile[] = [];
  for (const candidate of value.files) {
    if (!isStoredProjectIndexFile(candidate)) {
      return undefined;
    }
    files.push(candidate);
  }

  return {
    version: PROJECT_INDEX_VERSION,
    workspacePath,
    updatedAt: value.updatedAt,
    files
  };
}

function isStoredProjectIndexFile(value: unknown): value is ProjectIndexFile {
  if (!isRecord(value)
    || typeof value.filePath !== 'string'
    || typeof value.relativePath !== 'string'
    || typeof value.languageId !== 'string'
    || typeof value.size !== 'number'
    || typeof value.modifiedAt !== 'number'
    || typeof value.totalCharacters !== 'number'
    || !Array.isArray(value.chunks)
    || value.chunks.length > Math.ceil(MAX_PROJECT_INDEX_FILE_CHARACTERS / 1_000)) {
    return false;
  }
  return value.chunks.every((chunk) => isRecord(chunk)
    && typeof chunk.id === 'string'
    && typeof chunk.startLine === 'number'
    && typeof chunk.endLine === 'number'
    && typeof chunk.content === 'string'
    && chunk.content.length <= MAX_PROJECT_CHUNK_CHARACTERS);
}

function tokenizeForRetrieval(value: string): string[] {
  const expanded = value.replace(/([\p{Ll}\d])([\p{Lu}])/gu, '$1 $2');
  const rawTokens = expanded.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return rawTokens.filter((token) => token.length >= 2 && !retrievalStopWords.has(token));
}

function collectNewlineOffsets(content: string): number[] {
  const offsets: number[] = [];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') {
      offsets.push(index);
    }
  }
  return offsets;
}

function lineNumberAtOffset(newlineOffsets: number[], offset: number): number {
  let low = 0;
  let high = newlineOffsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (newlineOffsets[middle] < offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low + 1;
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function normalizeFilePath(value: string): string {
  return normalizeRelativePath(value).toLocaleLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
