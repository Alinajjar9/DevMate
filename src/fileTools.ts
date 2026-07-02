import {
  MAX_FILE_CHANGE_CHARACTERS,
  MAX_TOTAL_CHANGE_CHARACTERS,
  isAgentHistoryOmissionMarker,
  normalizeWorkspaceRelativePath,
  validateFileChanges
} from './fileChanges';
import { shouldSkipProjectFile } from './projectContext';

export const MAX_EDIT_REPLACEMENTS = 20;

export type ExactTextReplacement = {
  oldText: string;
  newText: string;
};

export type RelocateFileToolArguments = {
  path: string;
  newPath: string;
};

export function parseCreateFileArguments(value: Record<string, unknown>): {
  path: string;
  content: string;
} {
  if (typeof value.path !== 'string' || typeof value.content !== 'string') {
    throw new Error('create_file requires a path and complete text content.');
  }
  const [change] = validateFileChanges([{
    path: value.path,
    content: value.content
  }]);
  return change;
}

export function parseEditFileArguments(value: Record<string, unknown>): {
  path: string;
  replacements: ExactTextReplacement[];
} {
  if (typeof value.path !== 'string') {
    throw new Error('edit_file requires a workspace-relative path.');
  }
  if (!Array.isArray(value.replacements)
    || value.replacements.length === 0
    || value.replacements.length > MAX_EDIT_REPLACEMENTS) {
    throw new Error(`edit_file requires between 1 and ${MAX_EDIT_REPLACEMENTS} replacements.`);
  }

  const replacements: ExactTextReplacement[] = [];
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
    if (
      isAgentHistoryOmissionMarker(candidate.oldText)
      || isAgentHistoryOmissionMarker(candidate.newText)
    ) {
      throw new Error(
        'DevMate rejected an internal tool-history marker as edit text. '
        + 'Read the current file and provide real replacement text.'
      );
    }
    argumentCharacters += candidate.oldText.length + candidate.newText.length;
    if (argumentCharacters > MAX_TOTAL_CHANGE_CHARACTERS) {
      throw new Error('The edit replacements exceed the total size limit.');
    }
    replacements.push({ oldText: candidate.oldText, newText: candidate.newText });
  }

  return {
    path: normalizeWorkspaceRelativePath(value.path),
    replacements
  };
}

export function parseDeleteFileArguments(value: Record<string, unknown>): { path: string } {
  if (typeof value.path !== 'string') {
    throw new Error('delete_file requires a workspace-relative path.');
  }
  return { path: eligibleLifecyclePath(value.path) };
}

export function parseRenameFileArguments(value: Record<string, unknown>): RelocateFileToolArguments {
  const parsed = parseRelocateFileArguments(value, 'rename_file');
  if (parentPath(parsed.path).toLocaleLowerCase() !== parentPath(parsed.newPath).toLocaleLowerCase()) {
    throw new Error('rename_file must keep the file in the same directory; use move_file instead.');
  }
  return parsed;
}

export function parseMoveFileArguments(value: Record<string, unknown>): RelocateFileToolArguments {
  return parseRelocateFileArguments(value, 'move_file');
}

export function applyExactReplacements(
  content: string,
  replacements: ExactTextReplacement[]
): string {
  let updated = content;
  for (let index = 0; index < replacements.length; index += 1) {
    const replacement = replacements[index];
    const match = findReplacementMatch(updated, replacement.oldText);
    if (!match) {
      throw new Error(
        `Replacement ${index + 1} did not match the current file. `
        + 'Use read_file around the relevant lines and copy oldText exactly, including broken syntax and whitespace.'
      );
    }
    if (match.occurrences > 1) {
      throw new Error(`Replacement ${index + 1} matched more than once; provide a more specific oldText value.`);
    }
    const targetEol = lineEndingFor(match.value) ?? lineEndingFor(updated);
    const newText = targetEol
      ? normalizeLineEndings(replacement.newText, targetEol)
      : replacement.newText;
    updated = updated.replace(match.value, newText);
    if (updated.length > MAX_FILE_CHANGE_CHARACTERS) {
      throw new Error('The edited file exceeds the per-file change limit.');
    }
  }
  if (updated === content) {
    throw new Error('The requested replacements do not change the file.');
  }
  return updated;
}

function findReplacementMatch(
  content: string,
  oldText: string
): { value: string; occurrences: number } | undefined {
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

function lineEndingFor(value: string): '\r\n' | '\n' | undefined {
  if (value.includes('\r\n')) {
    return '\r\n';
  }
  return value.includes('\n') ? '\n' : undefined;
}

function normalizeLineEndings(value: string, lineEnding: '\r\n' | '\n'): string {
  return value.replace(/\r\n|\n/g, '\n').replace(/\n/g, lineEnding);
}

function countOccurrences(content: string, value: string, limit: number): number {
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

function parseRelocateFileArguments(
  value: Record<string, unknown>,
  toolName: 'rename_file' | 'move_file'
): RelocateFileToolArguments {
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

function eligibleLifecyclePath(value: string): string {
  const path = normalizeWorkspaceRelativePath(value);
  if (shouldSkipProjectFile(path)) {
    throw new Error(`DevMate will not change the protected or unsupported path ${path}.`);
  }
  return path;
}

function parentPath(value: string): string {
  return value.split('/').slice(0, -1).join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
