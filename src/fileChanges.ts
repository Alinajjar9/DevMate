import { shouldSkipProjectFile } from './projectContext';

export const MAX_FILE_CHANGES = 10;
export const MAX_FILE_CHANGE_CHARACTERS = 200_000;
export const MAX_TOTAL_CHANGE_CHARACTERS = 500_000;

export type ValidatedFileChange = {
  path: string;
  content: string;
};

const windowsReservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const windowsInvalidCharacters = /[<>:"|?*]/;
const legacyHistoryMarker = /^\[(?:omitted after execution: )?\d+ characters, sha256 [0-9a-f]{16}\]$/i;
const internalHistoryMarker = /^\[DevMate internal history summary: (?:content|text) omitted after execution; \d+ characters; sha256 [0-9a-f]{16}; never use as file content\]$/i;

export function agentHistoryOmissionMarker(
  kind: 'content' | 'text',
  characters: number,
  hash: string
): string {
  return `[DevMate internal history summary: ${kind} omitted after execution; `
    + `${characters} characters; sha256 ${hash}; never use as file content]`;
}

export function isAgentHistoryOmissionMarker(value: string): boolean {
  return legacyHistoryMarker.test(value.trim()) || internalHistoryMarker.test(value.trim());
}

export function validateFileChanges(value: unknown): ValidatedFileChange[] {
  if (!Array.isArray(value)) {
    throw new Error('The backend returned an invalid file-change list.');
  }
  if (value.length > MAX_FILE_CHANGES) {
    throw new Error(`DevMate can apply at most ${MAX_FILE_CHANGES} files at once.`);
  }

  const changes: ValidatedFileChange[] = [];
  const seenPaths = new Set<string>();
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
    if (shouldSkipProjectFile(path)) {
      throw new Error(`DevMate will not write to the protected or unsupported path ${path}.`);
    }
    if (candidate.content.includes('\0')) {
      throw new Error(`DevMate will not write binary content to ${path}.`);
    }
    if (isAgentHistoryOmissionMarker(candidate.content)) {
      throw new Error(
        `DevMate rejected an internal tool-history marker as the contents of ${path}. `
        + 'Read or move the real file instead.'
      );
    }
    if (candidate.content.length > MAX_FILE_CHANGE_CHARACTERS) {
      throw new Error(`${path} exceeds the per-file change limit.`);
    }

    totalCharacters += candidate.content.length;
    if (totalCharacters > MAX_TOTAL_CHANGE_CHARACTERS) {
      throw new Error('The proposed file changes exceed the total size limit.');
    }

    seenPaths.add(comparablePath);
    changes.push({ path, content: candidate.content });
  }

  return changes;
}

export function normalizeWorkspaceRelativePath(value: string): string {
  const path = value.trim();
  if (
    !path
    || path.startsWith('/')
    || path.startsWith('\\')
    || /^[A-Za-z]:/.test(path)
  ) {
    throw new Error('Every proposed file must use a workspace-relative path.');
  }

  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.some((part) =>
    !part
    || part === '.'
    || part === '..'
    || part.endsWith(' ')
    || part.endsWith('.')
    || windowsInvalidCharacters.test(part)
    || windowsReservedNames.test(part)
  )) {
    throw new Error(`The proposed path ${value} contains unsafe or invalid segments.`);
  }
  return parts.join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
