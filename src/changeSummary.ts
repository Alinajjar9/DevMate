import { normalizeWorkspaceRelativePath } from './fileChanges';

export const MAX_FILE_CHANGE_SUMMARY_ITEMS = 20;

export type FileChangeSummaryKind =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'renamed'
  | 'moved';

export type FileChangeSummaryItem = {
  kind: FileChangeSummaryKind;
  path: string;
  previousPath?: string;
  diffId?: string;
};

type FileChangeToolStep = {
  name: string;
  arguments: Record<string, unknown>;
  isError: boolean;
};

export function collectFileChangeSummary(
  steps: FileChangeToolStep[],
  additionalChanges: FileChangeSummaryItem[] = []
): FileChangeSummaryItem[] {
  const changes = new Map<string, FileChangeSummaryItem>();
  for (const step of steps) {
    if (step.isError) {
      continue;
    }
    const path = safePath(step.arguments.path);
    if (!path) {
      continue;
    }
    if (step.name === 'create_file') {
      applyCreated(changes, path);
    } else if (step.name === 'edit_file') {
      applyUpdated(changes, path);
    } else if (step.name === 'delete_file') {
      applyDeleted(changes, path);
    } else if (step.name === 'rename_file' || step.name === 'move_file') {
      const newPath = safePath(step.arguments.newPath);
      if (newPath) {
        applyRelocated(changes, path, newPath, step.name === 'rename_file' ? 'renamed' : 'moved');
      }
    }
  }
  for (const change of parseFileChangeSummary(additionalChanges)) {
    if (change.kind === 'created') {
      applyCreated(changes, change.path);
    } else if (change.kind === 'updated') {
      applyUpdated(changes, change.path);
    } else if (change.kind === 'deleted') {
      applyDeleted(changes, change.path);
    } else if (change.previousPath) {
      applyRelocated(changes, change.previousPath, change.path, change.kind);
    }
  }
  return [...changes.values()].slice(0, MAX_FILE_CHANGE_SUMMARY_ITEMS);
}

export function parseAppliedFileChangeOutcome(value: string): FileChangeSummaryItem[] {
  if (!value.startsWith('Applied file changes:')) {
    return [];
  }
  const parsed: FileChangeSummaryItem[] = [];
  for (const line of value.split(/\r?\n/).slice(1)) {
    const match = /^- (Created|Updated) (.+)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const path = safePath(match[2]);
    if (path) {
      parsed.push({
        kind: match[1] === 'Created' ? 'created' : 'updated',
        path
      });
    }
  }
  return parsed.slice(0, MAX_FILE_CHANGE_SUMMARY_ITEMS);
}

export function parseFileChangeSummary(value: unknown): FileChangeSummaryItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const parsed: FileChangeSummaryItem[] = [];
  for (const candidate of value.slice(0, MAX_FILE_CHANGE_SUMMARY_ITEMS)) {
    if (!isRecord(candidate) || !isKind(candidate.kind)) {
      continue;
    }
    const path = safePath(candidate.path);
    const previousPath = safePath(candidate.previousPath);
    const diffId = safeDiffId(candidate.diffId);
    if (!path || (candidate.kind === 'renamed' || candidate.kind === 'moved') && !previousPath) {
      continue;
    }
    parsed.push({
      kind: candidate.kind,
      path,
      ...(previousPath ? { previousPath } : {}),
      ...(diffId ? { diffId } : {})
    });
  }
  return parsed;
}

function safeDiffId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value)
    ? value
    : undefined;
}

function applyCreated(changes: Map<string, FileChangeSummaryItem>, path: string): void {
  changes.set(key(path), { kind: 'created', path });
}

function applyUpdated(changes: Map<string, FileChangeSummaryItem>, path: string): void {
  const existing = changes.get(key(path));
  if (existing?.kind === 'created' || existing?.kind === 'renamed' || existing?.kind === 'moved') {
    return;
  }
  changes.set(key(path), { kind: 'updated', path });
}

function applyDeleted(changes: Map<string, FileChangeSummaryItem>, path: string): void {
  const existing = changes.get(key(path));
  if (existing?.kind === 'created') {
    changes.delete(key(path));
    return;
  }
  if ((existing?.kind === 'renamed' || existing?.kind === 'moved') && existing.previousPath) {
    changes.delete(key(path));
    changes.set(key(existing.previousPath), { kind: 'deleted', path: existing.previousPath });
    return;
  }
  changes.set(key(path), { kind: 'deleted', path });
}

function applyRelocated(
  changes: Map<string, FileChangeSummaryItem>,
  path: string,
  newPath: string,
  kind: 'renamed' | 'moved'
): void {
  const existing = changes.get(key(path));
  changes.delete(key(path));
  if (existing?.kind === 'created') {
    changes.set(key(newPath), { kind: 'created', path: newPath });
    return;
  }
  const previousPath = existing?.previousPath ?? path;
  if (key(previousPath) === key(newPath)) {
    if (existing?.kind === 'updated') {
      changes.set(key(newPath), { kind: 'updated', path: newPath });
    }
    return;
  }
  changes.set(key(newPath), { kind, path: newPath, previousPath });
}

function safePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_048) {
    return undefined;
  }
  try {
    return normalizeWorkspaceRelativePath(value);
  } catch {
    return undefined;
  }
}

function key(value: string): string {
  return process.platform === 'win32' ? value.toLocaleLowerCase() : value;
}

function isKind(value: unknown): value is FileChangeSummaryKind {
  return value === 'created'
    || value === 'updated'
    || value === 'deleted'
    || value === 'renamed'
    || value === 'moved';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
