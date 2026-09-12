/** The latest request's direct file changes, stored as exact bytes without using Git history. */
import { normalizeWorkspaceRelativePath } from './fileTools';
import { shouldSkipProjectFile } from './projectIndex';

export const MAX_UNDO_BYTES = 2_000_000;
export const MAX_UNDO_FILES = 100;
export const MAX_UNDO_STORAGE_BYTES = 2_800_000;

export type UndoFileSnapshot = { path: string; bytes: string | null };
export type UndoFileChange = { path: string; before: string | null; after: string | null };
export type RequestUndoJournal = {
  version: 1;
  workspaceId: string;
  requestId: string;
  files: UndoFileChange[];
  unavailableReason?: string;
};
export type RequestUndoState = { available: boolean; label: string; files: number };

export function createRequestUndo(workspaceId: string, requestId: string): RequestUndoJournal {
  return { version: 1, workspaceId, requestId, files: [] };
}

/** Disable the whole journal when it cannot cover the whole request; never offer an incomplete rollback. */
export function disableRequestUndo(journal: RequestUndoJournal, reason: string): RequestUndoJournal {
  return { ...journal, files: [], unavailableReason: reason.slice(0, 300) };
}

export function recordRequestUndo(journal: RequestUndoJournal, changes: UndoFileChange[]): RequestUndoJournal {
  if (journal.unavailableReason) {
    return journal;
  }
  const files = new Map(journal.files.map(file => [pathKey(file.path), { ...file }]));
  for (const change of changes) {
    const key = pathKey(change.path);
    const previous = files.get(key);
    if (previous && previous.after !== change.before) {
      return disableRequestUndo(journal, 'Undo unavailable: a file changed outside the recorded request edits.');
    }
    const combined = { ...change, before: previous ? previous.before : change.before };
    if (combined.before === combined.after) {
      files.delete(key);
    } else {
      files.set(key, combined);
    }
  }
  const updated = { ...journal, files: [...files.values()] };
  if (updated.files.length > MAX_UNDO_FILES || snapshotBytes(updated.files) > MAX_UNDO_BYTES) {
    return disableRequestUndo(journal, 'Undo unavailable: this request exceeded the 2 MB snapshot limit.');
  }
  return updated;
}

/** Treat stored snapshots as untrusted input, even though they are written only in extension storage. */
export function parseRequestUndo(value: unknown, workspaceId: string): RequestUndoJournal | undefined {
  if (!isRecord(value) || value.version !== 1 || value.workspaceId !== workspaceId
    || typeof value.requestId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(value.requestId)
    || !Array.isArray(value.files) || value.files.length > MAX_UNDO_FILES
    || (value.unavailableReason !== undefined && (typeof value.unavailableReason !== 'string' || value.unavailableReason.length > 300))) {
    return undefined;
  }
  const files: UndoFileChange[] = [];
  const paths = new Set<string>();
  for (const file of value.files) {
    if (!isRecord(file) || typeof file.path !== 'string' || file.path.length > 2_048
      || !validBytes(file.before) || !validBytes(file.after)) {
      return undefined;
    }
    try {
      if (normalizeWorkspaceRelativePath(file.path) !== file.path || shouldSkipProjectFile(file.path)) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    const key = pathKey(file.path);
    if (paths.has(key) || file.before === file.after) {
      return undefined;
    }
    paths.add(key);
    files.push({ path: file.path, before: file.before, after: file.after });
  }
  if (snapshotBytes(files) > MAX_UNDO_BYTES || (value.unavailableReason && files.length > 0)) {
    return undefined;
  }
  return { version: 1, workspaceId, requestId: value.requestId, files,
    ...(typeof value.unavailableReason === 'string' ? { unavailableReason: value.unavailableReason } : {}) };
}

/** Verify all expected results before undoing any file, including files that should still be absent. */
export function assertUndoSnapshotsMatch(journal: RequestUndoJournal, current: UndoFileSnapshot[]): void {
  const snapshots = new Map(current.map(file => [pathKey(file.path), file.bytes]));
  for (const file of journal.files) {
    if (!snapshots.has(pathKey(file.path)) || snapshots.get(pathKey(file.path)) !== file.after) {
      throw new Error(`${file.path} changed after this request. Undo will not overwrite your newer changes.`);
    }
  }
}

export function requestUndoState(journal?: RequestUndoJournal): RequestUndoState {
  const files = journal?.files.length ?? 0;
  return { available: files > 0 && !journal?.unavailableReason,
    label: journal?.unavailableReason ?? (files > 0 ? 'Undo last request' : 'No file changes to undo'), files };
}

function snapshotBytes(files: UndoFileChange[]): number {
  return files.reduce((total, file) => total
    + (file.before === null ? 0 : Buffer.byteLength(file.before, 'base64'))
    + (file.after === null ? 0 : Buffer.byteLength(file.after, 'base64')), 0);
}

function validBytes(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= MAX_UNDO_STORAGE_BYTES
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    && Buffer.from(value, 'base64').toString('base64') === value);
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLocaleLowerCase() : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
