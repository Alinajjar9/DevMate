import * as path from 'path';
import type { AskContextItem } from './api/types';
import { createBoundedContextItem } from './context';

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
