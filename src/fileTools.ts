import {
  MAX_FILE_CHANGE_CHARACTERS,
  MAX_TOTAL_CHANGE_CHARACTERS,
  normalizeWorkspaceRelativePath,
  validateFileChanges
} from './fileChanges';

export const MAX_EDIT_REPLACEMENTS = 20;

export type ExactTextReplacement = {
  oldText: string;
  newText: string;
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

export function applyExactReplacements(
  content: string,
  replacements: ExactTextReplacement[]
): string {
  let updated = content;
  for (let index = 0; index < replacements.length; index += 1) {
    const replacement = replacements[index];
    const occurrences = countOccurrences(updated, replacement.oldText, 2);
    if (occurrences === 0) {
      throw new Error(
        `Replacement ${index + 1} did not match the current file. `
        + 'Use read_file around the relevant lines and copy oldText exactly, including broken syntax and whitespace.'
      );
    }
    if (occurrences > 1) {
      throw new Error(`Replacement ${index + 1} matched more than once; provide a more specific oldText value.`);
    }
    updated = updated.replace(replacement.oldText, replacement.newText);
    if (updated.length > MAX_FILE_CHANGE_CHARACTERS) {
      throw new Error('The edited file exceeds the per-file change limit.');
    }
  }
  if (updated === content) {
    throw new Error('The requested replacements do not change the file.');
  }
  return updated;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
