import { createHash, randomUUID } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentToolCall, AgentToolName, AgentToolSettings, ParsedAgentToolCall } from './agentTools';
import {
  boundedAgentToolHistoryArguments,
  FILE_MUTATION_AGENT_TOOL_NAMES,
  MAX_AGENT_COMMAND_CALLS,
  MAX_AGENT_DEPENDENCY_INSTALLS,
  MAX_AGENT_FILE_MUTATIONS,
  MAX_AGENT_TOOL_RESULT_CHARACTERS,
  MAX_DEPENDENCY_MANIFEST_BYTES,
  parseAgentToolCall,
  READ_ONLY_AGENT_TOOL_NAMES,
  summarizedAgentToolArguments,
  truncateAgentToolResult,
  validatePythonRequirementsManifest
} from './agentTools';
import type {
  AgentToolStep,
  AssistantMode
} from './api/types';
import {
  extractMissingPythonModule,
  isPythonVerificationCommand,
  workspacePythonCandidates,
  workspacePythonExecutable
} from './backendManager';
import type { CapturedTerminalError, ValidatedCommand } from './commandTools';
import { commandApprovalIdentity, resolveCommandExecutable } from './commandApproval';
import { ManagedCommandRegistry } from './managedCommands';
import {
  boundedModelCommandOutput,
  commandLabel,
  COMMAND_ACCESS_STORAGE_KEY,
  commandExecutionArguments,
  commandProjectScript,
  parseCommandAccess,
  parseRunCommandArguments,
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  formatCapturedTerminalErrors,
  MAX_CAPTURED_TERMINAL_ERRORS,
  MAX_COMMAND_TIMEOUT_SECONDS,
  MIN_COMMAND_TIMEOUT_SECONDS,
  sanitizeCapturedTerminalText,
  sanitizeCommandOutput
} from './commandTools';
import type { ValidatedFileChange } from './fileTools';
import {
  applyExactReplacements,
  formatReadFileResult,
  MAX_FILE_CHANGE_CHARACTERS,
  MAX_TOTAL_CHANGE_CHARACTERS,
  normalizeWorkspaceRelativePath,
  validateFileChanges
} from './fileTools';
import {
  assertUndoSnapshotsMatch, createRequestUndo, disableRequestUndo,
  MAX_UNDO_BYTES, MAX_UNDO_STORAGE_BYTES, parseRequestUndo, recordRequestUndo, requestUndoState
} from './requestUndo';
import type { RequestUndoJournal, RequestUndoState, UndoFileSnapshot } from './requestUndo';
import type {
  FilePermissionAction,
  FilePermissionPolicy,
  RememberedCommand
} from './permissions';
import {
  allowActions,
  canRememberCommandApproval,
  FILE_PERMISSION_POLICY_STORAGE_KEY,
  parseFilePermissionPolicy,
  parseRememberedCommands,
  permissionBehaviorForAction,
  rememberCommand,
  REMEMBERED_COMMANDS_STORAGE_KEY
} from './permissions';
import {
  containsBinaryData,
  MAX_ATTACHMENT_CANDIDATES,
  MAX_PROJECT_CANDIDATES,
  MAX_PROJECT_FILE_BYTES,
  PROJECT_EXCLUDE_GLOB,
  shouldSkipProjectFile
} from './projectIndex';
import { WorkspaceContext } from './workspaceContext';
import { applyProviderTextEdits } from './editorTools';
import { collectProjectInfo, readGitChanges, matchesSearchFilePattern, searchCodeSnippets } from './projectTools';

type PendingCommandPermission = {
  id: string;
  signature: string;
  label: string;
  rememberable: boolean;
  resolve: (allowed: boolean) => void;
};

type PendingPermissionRequest = {
  id: string;
  actions: Set<FilePermissionAction>;
  rememberable: boolean;
  diffs: Map<string, PendingFileDiff>;
  resolve: (allowed: boolean) => void;
};

type PendingFileDiff = {
  path: string;
  originalContent: string;
  proposedContent: string;
  originalUri: vscode.Uri;
  proposedUri: vscode.Uri;
};

type CompletedFileDiff = {
  id: string;
  path: string;
  previousPath?: string;
  originalUri: vscode.Uri;
  proposedUri: vscode.Uri;
};

type WorkspaceCodeLocation = {
  path: string;
  line: number;
  column: number;
  filePath: string;
};

type ActiveTerminalCapture = {
  command: string;
  cwd: string;
  terminalName: string;
  output: string;
  reader?: Promise<void>;
};

class StartedCommandError extends Error {
  readonly commandAttempted = true;

  constructor(
    message: string,
    readonly missingDependency?: string,
    readonly pythonEnvironment?: string
  ) {
    super(message);
  }
}

class StartedDependencyInstallError extends Error {
  readonly installAttempted = true;
}

type AgentToolResult = {
  result: string;
  resultSummary: string;
  usedFiles: string[];
  mutationCharacters: number;
  mutationApplied?: boolean;
  mutationFiles?: number;
  commandAttempted?: boolean;
  missingDependency?: string;
  pythonEnvironment?: string;
  installAttempted?: boolean;
  environmentChanged?: boolean;
};

export type AgentToolExecution = {
  step: AgentToolStep;
  usedFiles: string[];
  mutationCharacters: number;
  mutationApplied?: boolean;
  mutationFiles?: number;
  commandAttempted?: boolean;
  missingDependency?: string;
  pythonEnvironment?: string;
  installAttempted?: boolean;
  environmentChanged?: boolean;
};
export interface ToolExecutorEvents {
  postMessage(message: unknown): void;
  postStatus(text: string, level?: 'info' | 'warning' | 'error'): void;
  postSettingsState(): void;
  postPermissionPolicyState(): void;
  getAgentToolSettings(): AgentToolSettings;
  getActiveSignal(): AbortSignal | undefined;
}

/** Owns project tool execution, permission rechecks, change snapshots and terminals. */
export class ToolExecutor implements vscode.Disposable {
  static readonly diffScheme = 'devmate-diff';
  private pendingPermission?: PendingPermissionRequest;
  private pendingCommandPermission?: PendingCommandPermission;
  private readonly diffDocuments = new Map<string, string>();
  private readonly completedFileDiffs = new Map<string, CompletedFileDiff>();
  private readonly activeRequestDiffs = new Map<string, string>();
  private readonly commandTerminals = new Map<string, vscode.Terminal>();
  private readonly managedCommands = new ManagedCommandRegistry(() => this.postManagedCommandState());
  private readonly backgroundTerminals = new Set<vscode.Terminal>();
  private readonly activeTerminalCaptures = new Map<vscode.TerminalShellExecution, ActiveTerminalCapture>();
  private readonly recentTerminalErrors: CapturedTerminalError[] = [];
  private readonly lifetimeDisposables: vscode.Disposable[] = [];
  private undoJournal?: RequestUndoJournal;
  private undoQueue: Promise<void>;
  private undoInProgress = false;
  private undoPersistenceFailed = false;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly workspaceContext: WorkspaceContext,
    private readonly events: ToolExecutorEvents
  ) {
    this.undoQueue = this.loadRequestUndo().catch(() => undefined);
    this.lifetimeDisposables.push(
      vscode.window.onDidStartTerminalShellExecution(event => this.captureWorkspaceTerminalExecution(event)),
      vscode.window.onDidEndTerminalShellExecution(event => { void this.finishWorkspaceTerminalExecution(event); })
    );
  }

  /** Clear request-specific state for a new question; a resumed run keeps the diffs from work already completed. */
  beginRequest(resuming: boolean): void {
    if (!resuming) {
      this.activeRequestDiffs.clear();
    }
    void this.queueUndo(async () => {
      const workspaceId = this.undoWorkspaceId();
      if (!workspaceId) {
        this.undoJournal = undefined;
        return;
      }
      if (!resuming || this.undoJournal?.workspaceId !== workspaceId) {
        this.undoJournal = createRequestUndo(workspaceId, randomUUID());
        if (resuming) {
          this.undoJournal = disableRequestUndo(this.undoJournal, 'Undo unavailable: earlier changes from this resumed request were not saved.');
        }
        await this.persistRequestUndo();
      }
    });
  }

  async getUndoState(): Promise<RequestUndoState> {
    await this.undoQueue;
    return requestUndoState(this.undoJournal?.workspaceId === this.undoWorkspaceId() ? this.undoJournal : undefined);
  }

  /** Review the latest request's direct file edits, then restore exact bytes only if every result is still unchanged. */
  async undoLastRequest(): Promise<boolean> {
    await this.undoQueue;
    const journal = this.undoJournal;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (this.undoInProgress || !folder || !journal || !requestUndoState(journal).available
      || journal.workspaceId !== this.undoWorkspaceId()) {
      return false;
    }
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before undoing file changes.');
    }
    this.undoInProgress = true;
    const previewUris: vscode.Uri[] = [];
    try {
      assertUndoSnapshotsMatch(journal, await this.readUndoSnapshots(folder, journal.files.map(file => file.path)));
      const choices = journal.files.map(file => ({
        label: file.path,
        description: file.before === null ? 'Remove file created by this request'
          : file.after === null ? 'Restore deleted or moved file' : 'Restore the previous contents',
        file,
        undo: false
      }));
      while (true) {
        const choice = await vscode.window.showQuickPick([
          { label: `Undo all ${journal.files.length} file changes`, description: 'Continue to confirmation', file: undefined, undo: true },
          ...choices
        ], { title: 'Review Undo last request', placeHolder: 'Select a file to review its diff, or continue to confirmation' });
        if (!choice) {
          return false;
        }
        if (choice.undo) {
          break;
        }
        const file = choice.file!;
        const id = randomUUID();
        const currentUri = vscode.Uri.parse(`${ToolExecutor.diffScheme}:/undo/${id}/current`);
        const restoredUri = vscode.Uri.parse(`${ToolExecutor.diffScheme}:/undo/${id}/restored`);
        previewUris.push(currentUri, restoredUri);
        this.diffDocuments.set(currentUri.toString(), file.after === null ? '' : Buffer.from(file.after, 'base64').toString('utf8'));
        this.diffDocuments.set(restoredUri.toString(), file.before === null ? '' : Buffer.from(file.before, 'base64').toString('utf8'));
        await vscode.commands.executeCommand('vscode.diff', currentUri, restoredUri, `Undo: ${file.path}`, { preview: true });
      }
      const confirmed = await vscode.window.showWarningMessage(
        `Undo the last request's changes to ${journal.files.length} files?`,
        { modal: true, detail: 'This restores direct DevMate file edits only. Terminal commands, installed dependencies, and created directories are not undone.' },
        'Undo request'
      );
      if (confirmed !== 'Undo request') {
        return false;
      }
      if (this.undoJournal !== journal || !vscode.workspace.isTrusted || this.undoWorkspaceId() !== journal.workspaceId) {
        throw new Error('The active request or workspace changed while Undo was being reviewed.');
      }
      for (const file of journal.files.filter(item => item.before !== null)) {
        await this.assertNoWorkspaceSymlink(folder, file.path, true);
        const parent = file.path.split('/').slice(0, -1);
        if (parent.length > 0) {
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, ...parent));
        }
      }
      assertUndoSnapshotsMatch(journal, await this.readUndoSnapshots(folder, journal.files.map(file => file.path)));
      const edit = new vscode.WorkspaceEdit();
      for (const file of journal.files) {
        const uri = vscode.Uri.joinPath(folder.uri, ...file.path.split('/'));
        if (file.before === null) {
          edit.deleteFile(uri, { recursive: false, ignoreIfNotExists: false });
        } else {
          // Resource edits preserve BOMs, line endings and encodings exactly, including restored deleted files.
          edit.createFile(uri, { overwrite: file.after !== null, ignoreIfExists: false, contents: Buffer.from(file.before, 'base64') });
        }
      }
      if (!await vscode.workspace.applyEdit(edit)) {
        throw new Error('VS Code could not apply Undo. Review the files before trying again.');
      }
      for (const file of journal.files.filter(item => item.before !== null)) {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, ...file.path.split('/')));
        if (document.isDirty || !await document.save()) {
          throw new Error('Undo applied, but a restored file could not be confirmed as saved. Review the files.');
        }
      }
      assertUndoSnapshotsMatch({ ...journal, files: journal.files.map(file => ({ ...file, after: file.before })) },
        await this.readUndoSnapshots(folder, journal.files.map(file => file.path)));
      await this.queueUndo(async () => {
        this.undoJournal = createRequestUndo(journal.workspaceId, journal.requestId);
        await this.persistRequestUndo();
      });
      this.activeRequestDiffs.clear();
      this.events.postStatus('Undid the last request’s direct file changes.');
      return true;
    } finally {
      this.undoInProgress = false;
      previewUris.forEach(uri => this.diffDocuments.delete(uri.toString()));
    }
  }

  private undoWorkspaceId(): string | undefined {
    const id = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
    return process.platform === 'win32' ? id?.toLocaleLowerCase() : id;
  }

  private undoStorageUri(): vscode.Uri | undefined {
    const base = this.extensionContext.storageUri ?? this.extensionContext.globalStorageUri;
    const workspaceId = this.undoWorkspaceId();
    return base && workspaceId ? vscode.Uri.joinPath(base, `request-undo-${createHash('sha256').update(workspaceId).digest('hex').slice(0, 20)}.json`) : undefined;
  }

  private async loadRequestUndo(): Promise<void> {
    const uri = this.undoStorageUri();
    const workspaceId = this.undoWorkspaceId();
    if (!uri || !workspaceId) {
      return;
    }
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_UNDO_STORAGE_BYTES) {
      return;
    }
    const bytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
    if (bytes.length <= MAX_UNDO_STORAGE_BYTES) {
      this.undoJournal = parseRequestUndo(JSON.parse(bytes.toString('utf8')), workspaceId);
    }
  }

  private queueUndo(work: () => Promise<void>): Promise<void> {
    this.undoQueue = this.undoQueue.then(work).catch(async () => {
      this.undoPersistenceFailed = true;
      if (this.undoJournal) {
        this.undoJournal = disableRequestUndo(this.undoJournal, 'Undo unavailable: the request snapshots could not be saved.');
        try {
          await this.persistRequestUndo();
        } catch {
          // The existing write-ahead marker already prevents offering an incomplete request after reload.
        }
      }
    });
    return this.undoQueue;
  }

  private async persistRequestUndo(value = this.undoJournal): Promise<void> {
    const uri = this.undoStorageUri();
    const base = this.extensionContext.storageUri ?? this.extensionContext.globalStorageUri;
    if (!uri || !base || !value) {
      throw new Error('Extension storage is unavailable.');
    }
    let bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > MAX_UNDO_STORAGE_BYTES) {
      this.undoJournal = disableRequestUndo(value, 'Undo unavailable: this request exceeded the snapshot storage limit.');
      bytes = Buffer.from(JSON.stringify(this.undoJournal));
    }
    await vscode.workspace.fs.createDirectory(base);
    await vscode.workspace.fs.writeFile(uri, bytes);
    this.undoPersistenceFailed = false;
  }

  private async readUndoSnapshots(folder: vscode.WorkspaceFolder, paths: string[]): Promise<UndoFileSnapshot[]> {
    const snapshots: UndoFileSnapshot[] = [];
    let totalBytes = 0;
    for (const relativePath of paths) {
      if (normalizeWorkspaceRelativePath(relativePath) !== relativePath || shouldSkipProjectFile(relativePath)) {
        throw new Error(`Undo will not access the protected or unsafe path ${relativePath}.`);
      }
      await this.assertNoWorkspaceSymlink(folder, relativePath, true);
      const uri = vscode.Uri.joinPath(folder.uri, ...relativePath.split('/'));
      if ((vscode.workspace.textDocuments ?? []).some(document => document.uri.toString() === uri.toString() && document.isDirty)) {
        throw new Error(`Save or discard your unsaved changes in ${relativePath} before using Undo.`);
      }
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.File) === 0 || totalBytes + stat.size > MAX_UNDO_BYTES) {
          throw new Error(`${relativePath} is not a supported file for Undo.`);
        }
        const bytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
        totalBytes += bytes.length;
        if (totalBytes > MAX_UNDO_BYTES) {
          throw new Error('The request snapshots exceed the 2 MB Undo limit.');
        }
        snapshots.push({ path: relativePath, bytes: bytes.toString('base64') });
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
          snapshots.push({ path: relativePath, bytes: null });
          continue;
        }
        throw error;
      }
    }
    return snapshots;
  }

  private async captureUndoBefore(folder: vscode.WorkspaceFolder, paths: string[]): Promise<UndoFileSnapshot[] | undefined> {
    await this.undoQueue;
    const folderId = process.platform === 'win32' ? folder.uri.toString().toLocaleLowerCase() : folder.uri.toString();
    if (folderId !== this.undoWorkspaceId()) {
      throw new Error('The workspace changed before the file edit could be applied.');
    }
    if (this.undoPersistenceFailed) {
      throw new Error('DevMate could not safely prepare the Undo journal before changing files.');
    }
    if (this.undoJournal?.unavailableReason) {
      return undefined;
    }
    try {
      const snapshots = await this.readUndoSnapshots(folder, paths);
      await this.queueUndo(async () => {
        this.undoJournal ??= createRequestUndo(this.undoWorkspaceId()!, randomUUID());
        // A reload between applying and recording a mutation must not offer older, incomplete snapshots.
        await this.persistRequestUndo(disableRequestUndo(this.undoJournal,
          'Undo unavailable: the last file change was interrupted before its snapshots were saved.'));
      });
      if (this.undoPersistenceFailed) {
        throw new Error('DevMate could not safely prepare the Undo journal before changing files.');
      }
      return this.undoJournal?.unavailableReason ? undefined : snapshots;
    } catch {
      await this.queueUndo(async () => {
        this.undoJournal = disableRequestUndo(this.undoJournal ?? createRequestUndo(this.undoWorkspaceId()!, randomUUID()),
          'Undo unavailable: a file could not be captured before this request changed it.');
        await this.persistRequestUndo();
      });
      if (this.undoPersistenceFailed) {
        throw new Error('DevMate could not safely prepare the Undo journal before changing files.');
      }
      return undefined;
    }
  }

  private async captureUndoAfter(folder: vscode.WorkspaceFolder, before?: UndoFileSnapshot[]): Promise<void> {
    if (!before) {
      return;
    }
    await this.queueUndo(async () => {
      const after = await this.readUndoSnapshots(folder, before.map(file => file.path));
      this.undoJournal = recordRequestUndo(this.undoJournal ?? createRequestUndo(this.undoWorkspaceId()!, randomUUID()),
        before.map((file, index) => ({ path: file.path, before: file.bytes, after: after[index].bytes })));
      await this.persistRequestUndo();
    });
  }

  diffIdForPath(filePath: string): string | undefined {
    return this.activeRequestDiffs.get(this.fileChangePathKey(filePath));
  }

  openCommandTerminal(activityId: string): void {
    this.commandTerminals.get(activityId)?.show(false);
  }

  /** Resolve outstanding permission prompts as denied and stop terminals belonging to the active request. */
  cancelPendingWork(): void {
    const pending = this.pendingPermission;
    pending?.resolve(false);
    this.clearPendingDiffDocuments(pending);
    this.pendingPermission = undefined;
    this.pendingCommandPermission?.resolve(false);
    this.pendingCommandPermission = undefined;
    this.disposeCommandTerminals();
  }

  dispose(): void {
    this.stopAllManagedCommands();
    this.cancelPendingWork();
    this.activeTerminalCaptures.clear();
    this.diffDocuments.clear();
    this.completedFileDiffs.clear();
    this.activeRequestDiffs.clear();
    while (this.lifetimeDisposables.length > 0) {
      this.lifetimeDisposables.pop()?.dispose();
    }
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.diffDocuments.get(uri.toString()) ?? '';
  }

  /** Open a source link after checking that it resolves to an eligible file in the current workspace. */
  async openWorkspaceFile(requestedPath: string, requestedLine?: number): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || typeof requestedPath !== 'string') {
      return;
    }
    const value = requestedPath.trim();
    if (!value || value.length > 2_048) {
      return;
    }
    const absolutePath = path.isAbsolute(value)
      ? path.resolve(value)
      : path.resolve(folder.uri.fsPath, value);
    const relativePath = path.relative(folder.uri.fsPath, absolutePath);
    if (
      !relativePath
      || relativePath === '..'
      || relativePath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativePath)
    ) {
      return;
    }
    try {
      await this.assertNoWorkspaceSymlink(
        folder,
        normalizeRelativeWorkspacePath(relativePath),
        false
      );
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
      const line = Number.isInteger(requestedLine)
        ? Math.max(0, Math.min(document.lineCount - 1, Number(requestedLine) - 1))
        : 0;
      await vscode.window.showTextDocument(document, {
        preview: true,
        selection: new vscode.Range(line, 0, line, 0)
      });
    } catch {
      this.events.postStatus(`Could not open ${value}.`, 'warning');
    }
  }

  async openCompletedFileDiff(diffId: string, requestedPath: string): Promise<void> {
    const diff = typeof diffId === 'string' ? this.completedFileDiffs.get(diffId) : undefined;
    if (!diff) {
      this.events.postStatus('That change snapshot is no longer available. Opening the current file instead.', 'warning');
      await this.openWorkspaceFile(requestedPath);
      return;
    }
    const title = diff.previousPath
      ? `${diff.previousPath} → ${diff.path} (DevMate changes)`
      : `${diff.path} (DevMate changes)`;
    await vscode.commands.executeCommand(
      'vscode.diff',
      diff.originalUri,
      diff.proposedUri,
      title,
      { preview: true }
    );
  }

  /** Keep bounded before/after snapshots so the user can inspect an applied change after the tool has finished. */
  private rememberCompletedFileDiff(
    filePath: string,
    originalContent: string,
    proposedContent: string,
    previousPath?: string
  ): string {
    const id = randomUUID();
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const originalUri = vscode.Uri.parse(
      `${ToolExecutor.diffScheme}:/completed/${id}/before/${encodedPath}`
    );
    const proposedUri = vscode.Uri.parse(
      `${ToolExecutor.diffScheme}:/completed/${id}/after/${encodedPath}`
    );
    this.diffDocuments.set(originalUri.toString(), originalContent);
    this.diffDocuments.set(proposedUri.toString(), proposedContent);
    this.completedFileDiffs.set(id, {
      id,
      path: filePath,
      ...(previousPath ? { previousPath } : {}),
      originalUri,
      proposedUri
    });
    this.activeRequestDiffs.set(this.fileChangePathKey(filePath), id);

    while (this.completedFileDiffs.size > 40) {
      const oldestId = this.completedFileDiffs.keys().next().value as string | undefined;
      if (!oldestId) {
        break;
      }
      const oldest = this.completedFileDiffs.get(oldestId);
      if (oldest) {
        this.diffDocuments.delete(oldest.originalUri.toString());
        this.diffDocuments.delete(oldest.proposedUri.toString());
      }
      this.completedFileDiffs.delete(oldestId);
      for (const [key, value] of this.activeRequestDiffs) {
        if (value === oldestId) {
          this.activeRequestDiffs.delete(key);
        }
      }
    }
    return id;
  }

  private fileChangePathKey(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
  }

  private getPermissionPolicy(): FilePermissionPolicy {
    return parseFilePermissionPolicy(
      this.extensionContext.workspaceState.get<unknown>(FILE_PERMISSION_POLICY_STORAGE_KEY)
    );
  }

  private getRememberedCommands(): RememberedCommand[] {
    return parseRememberedCommands(
      this.extensionContext.workspaceState.get<unknown>(REMEMBERED_COMMANDS_STORAGE_KEY)
    );
  }

  /** Apply a reply only to its matching pending request, ignoring replies from an older permission prompt. */
  async handlePermissionDecision(
    requestId: string,
    decision: 'deny' | 'allowOnce' | 'allowAlways'
  ): Promise<void> {
    const pending = this.pendingPermission;
    if (!pending || pending.id !== requestId) {
      return;
    }
    this.pendingPermission = undefined;

    if (decision === 'allowAlways' && pending.rememberable) {
      try {
        const updatedPolicy = allowActions(this.getPermissionPolicy(), pending.actions);
        await this.extensionContext.workspaceState.update(
          FILE_PERMISSION_POLICY_STORAGE_KEY,
          updatedPolicy
        );
        this.events.postPermissionPolicyState();
      } catch {
        this.events.postStatus(
          'The changes are allowed this time, but the permission preference could not be saved.',
          'warning'
        );
      }
    }

    pending.resolve(decision !== 'deny');
    this.clearPendingDiffDocuments(pending);
  }

  private clearPendingDiffDocuments(pending?: PendingPermissionRequest): void {
    if (!pending) {
      return;
    }
    for (const diff of pending.diffs.values()) {
      this.diffDocuments.delete(diff.originalUri.toString());
      this.diffDocuments.delete(diff.proposedUri.toString());
    }
  }

  /**
   * Build read-only diff documents from the exact proposed contents and wait for the user decision.
   * The caller must check the current files again before applying the approved change.
   */
  private requestFileChangePermission(
    summary: string,
    files: Array<{
      path: string;
      operation: FilePermissionAction;
      originalContent: string;
      proposedContent: string;
    }>
  ): Promise<boolean> {
    const previousPermission = this.pendingPermission;
    previousPermission?.resolve(false);
    this.clearPendingDiffDocuments(previousPermission);
    const requestId = randomUUID();
    const actions = new Set(files.map((file) => file.operation));
    const rememberable = [...actions].every(
      (action) => action === 'create' || action === 'update'
    );
    const diffs = new Map<string, PendingFileDiff>();
    for (const file of files) {
      const encodedPath = file.path.split('/').map(encodeURIComponent).join('/');
      const originalUri = vscode.Uri.parse(
        `${ToolExecutor.diffScheme}:/${requestId}/original/${encodedPath}`
      );
      const proposedUri = vscode.Uri.parse(
        `${ToolExecutor.diffScheme}:/${requestId}/proposed/${encodedPath}`
      );
      this.diffDocuments.set(originalUri.toString(), file.originalContent);
      this.diffDocuments.set(proposedUri.toString(), file.proposedContent);
      diffs.set(file.path, {
        path: file.path,
        originalContent: file.originalContent,
        proposedContent: file.proposedContent,
        originalUri,
        proposedUri
      });
    }

    return new Promise((resolve) => {
      this.pendingPermission = { id: requestId, actions, rememberable, diffs, resolve };
      this.events.postMessage({
        command: 'permissionRequest',
        requestId,
        summary,
        rememberable,
        files: files.map(({ path, operation }) => ({ path, operation, canReview: true }))
      });
    });
  }

  async reviewPermissionDiff(requestId: string, filePath: string): Promise<void> {
    const pending = this.pendingPermission;
    const diff = pending?.id === requestId ? pending.diffs.get(filePath) : undefined;
    if (!diff) {
      this.events.postStatus('That proposed diff is no longer available.', 'warning');
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      diff.originalUri,
      diff.proposedUri,
      `DevMate: ${diff.path}`,
      { preview: true }
    );
  }

  /** Reuse an exact remembered command approval when allowed; otherwise wait for a new decision in the chat. */
  private requestCommandPermission(
    signature: string,
    label: string,
    cwd: string,
    options: {
      rememberable?: boolean;
      title?: string;
      warning?: string;
    } = {}
  ): Promise<boolean> {
    const rememberable = options.rememberable !== false;
    if (rememberable && this.getRememberedCommands().some((command) => command.signature === signature)) {
      return Promise.resolve(true);
    }
    this.pendingCommandPermission?.resolve(false);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      this.pendingCommandPermission = {
        id: requestId,
        signature,
        label: `${label} · ${cwd || 'workspace root'}`,
        rememberable,
        resolve
      };
      this.events.postMessage({
        command: 'commandPermissionRequest',
        requestId,
        label,
        cwd: cwd || 'Workspace root',
        rememberable,
        allowRemember: rememberable,
        title: options.title,
        warning: options.warning
      });
    });
  }

  async handleCommandPermissionDecision(
    requestId: string,
    decision: 'deny' | 'allowOnce' | 'allowAlways'
  ): Promise<void> {
    const pending = this.pendingCommandPermission;
    if (!pending || pending.id !== requestId) {
      return;
    }
    this.pendingCommandPermission = undefined;
    if (decision === 'allowAlways' && pending.rememberable) {
      const updated = rememberCommand(this.getRememberedCommands(), {
        signature: pending.signature,
        label: pending.label
      });
      await this.extensionContext.workspaceState.update(REMEMBERED_COMMANDS_STORAGE_KEY, updated);
      this.events.postSettingsState();
    }
    pending.resolve(decision === 'allowOnce' || (decision === 'allowAlways' && pending.rememberable));
  }

  /**
   * Validate model arguments, run the tool, and return a bounded history entry for the next model turn.
   * Failures are returned as tool results so the model can react; attempt flags still count failed commands.
   */
  async executeAgentToolCall(
    call: AgentToolCall,
    remainingMutationCharacters = MAX_TOTAL_CHANGE_CHARACTERS,
    remainingFileEdits = MAX_AGENT_FILE_MUTATIONS
  ): Promise<AgentToolExecution> {
    if (this.undoInProgress) {
      return this.rejectedToolExecution(call, 'Finish or cancel the Undo review before running another project tool.');
    }
    let parsedCall: ParsedAgentToolCall;
    try {
      parsedCall = parseAgentToolCall(call);
    } catch (error) {
      const result = error instanceof Error ? error.message : 'The tool request was invalid.';
      this.postAgentToolActivity(call.id, 'Tool request rejected', call.name, 'error', result);
      return {
        step: {
          callId: call.id,
          name: call.name,
          arguments: boundedAgentToolHistoryArguments(call.name, call.arguments),
          result: truncateAgentToolResult(result),
          isError: true
        },
        usedFiles: [],
        mutationCharacters: 0
      };
    }

    const activity = describeAgentToolCall(parsedCall);
    this.postAgentToolActivity(call.id, activity.title, activity.detail, 'running');

    try {
      const execution = await this.runAgentTool(parsedCall, remainingMutationCharacters, remainingFileEdits);
      this.postAgentToolActivity(
        call.id,
        activity.title,
        activity.detail,
        'completed',
        execution.resultSummary,
        (parsedCall.name === 'run_command' || parsedCall.name === 'install_dependencies')
        && this.commandTerminals.has(parsedCall.id)
      );
      return {
        step: {
          callId: parsedCall.id,
          name: parsedCall.name,
          arguments: summarizedAgentToolArguments(parsedCall),
          result: truncateAgentToolResult(execution.result),
          isError: false
        },
        usedFiles: execution.usedFiles,
        mutationCharacters: execution.mutationCharacters,
        mutationApplied: execution.mutationApplied,
        mutationFiles: execution.mutationFiles,
        commandAttempted: execution.commandAttempted,
        missingDependency: execution.missingDependency,
        pythonEnvironment: execution.pythonEnvironment,
        installAttempted: execution.installAttempted,
        environmentChanged: execution.environmentChanged
      };
    } catch (error) {
      const result = error instanceof Error ? error.message : 'The tool could not be completed.';
      this.postAgentToolActivity(
        call.id,
        activity.title,
        activity.detail,
        'error',
        result,
        (parsedCall.name === 'run_command' || parsedCall.name === 'install_dependencies')
        && this.commandTerminals.has(parsedCall.id)
      );
      return {
        step: {
          callId: parsedCall.id,
          name: parsedCall.name,
          arguments: summarizedAgentToolArguments(parsedCall),
          result: truncateAgentToolResult(result),
          isError: true
        },
        usedFiles: [],
        mutationCharacters: 0,
        commandAttempted: error instanceof StartedCommandError,
        missingDependency: error instanceof StartedCommandError
          ? error.missingDependency
          : undefined,
        pythonEnvironment: error instanceof StartedCommandError
          ? error.pythonEnvironment
          : undefined,
        installAttempted: error instanceof StartedDependencyInstallError
      };
    }
  }

  private async runAgentTool(call: ParsedAgentToolCall, remainingMutationCharacters: number, remainingFileEdits: number): Promise<AgentToolResult> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('Open a workspace folder before using project tools.');
    }
    const settings = this.events.getAgentToolSettings();
    switch (call.name) {
      case 'create_file': return this.createAgentFile(call, folder, remainingMutationCharacters);
      case 'edit_file': return this.editAgentFile(call, folder, remainingMutationCharacters);
      case 'delete_file': return this.deleteAgentFile(call, folder, remainingMutationCharacters);
      case 'rename_file':
      case 'move_file': return this.relocateAgentFile(call, folder);
      case 'list_files': return this.listAgentFiles(call, folder, settings);
      case 'read_file': return this.readAgentFile(call, folder, settings);
      case 'search_code': return this.searchAgentCode(call, folder, settings);
      case 'get_project_info': return this.readProjectInfo(call, folder);
      case 'get_git_changes': return this.readProjectGitChanges(call, folder);
      case 'rename_symbol':
      case 'format_file': return this.applyLanguageEdits(call, folder, remainingMutationCharacters, remainingFileEdits);
      case 'get_diagnostics': return this.readWorkspaceDiagnostics(call, folder);
      case 'get_symbols': return this.readDocumentSymbols(call, folder);
      case 'find_definition':
      case 'find_references': return this.findCodeLocations(call, folder);
      case 'read_terminal_errors': return this.readTerminalErrors(call, settings);
      case 'install_dependencies': return this.runDependencyInstallation(call, folder);
      case 'run_command': return this.runVerificationCommand(call, folder);
      case 'stop_command': {
        this.stopManagedCommand(call.arguments.id);
        return { result: 'DevMate closed the owned command terminal. Detached child processes may need to be stopped manually.',
          resultSummary: 'Closed command terminal', usedFiles: [], mutationCharacters: 0 };
      }
    }
  }

  private async createAgentFile(
    call: Extract<ParsedAgentToolCall, { name: 'create_file' }>,
    folder: vscode.WorkspaceFolder,
    remainingMutationCharacters: number
  ): Promise<AgentToolResult> {
    await this.assertNoWorkspaceSymlink(folder, call.arguments.path, true);
    const uri = vscode.Uri.joinPath(folder.uri, ...call.arguments.path.split('/'));
    try {
      await vscode.workspace.fs.stat(uri);
      throw new Error(`${call.arguments.path} already exists; use edit_file instead.`);
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
        throw error;
      }
    }
    const changes = validateFileChanges([call.arguments]);
    if (call.arguments.content.length > remainingMutationCharacters) {
      throw new Error('This request reached the total file-mutation size limit.');
    }
    const outcome = await this.confirmAndApplyFileChanges(
      changes,
      `Create ${call.arguments.path}`,
      this.events.getActiveSignal() ?? new AbortController().signal
    );
    if (!outcome.startsWith('Applied file changes:')) {
      throw new Error('Permission to create the file was denied.');
    }
    return {
      result: outcome,
      resultSummary: `Created ${call.arguments.path}`,
      usedFiles: [uri.scheme === 'file' ? uri.fsPath : uri.toString()],
      mutationCharacters: call.arguments.content.length,
      mutationApplied: true
    };
  }

  /** Read a small manifest summary instead of repeatedly sending whole configuration files. */
  private async readProjectInfo(call: Extract<ParsedAgentToolCall, { name: 'get_project_info' }>, folder: vscode.WorkspaceFolder): Promise<AgentToolResult> {
    const uris = await this.findAgentFiles(folder, call.arguments.path);
    const paths = uris.map(uri => normalizeWorkspaceRelativePath(path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/')));
    const info = await collectProjectInfo(paths, async relative => {
      const candidate = await this.workspaceContext.readProjectCandidate(vscode.Uri.joinPath(folder.uri, ...relative.split('/')));
      return candidate?.content;
    }, call.arguments.path);
    const access = parseCommandAccess(this.extensionContext.workspaceState.get(COMMAND_ACCESS_STORAGE_KEY)) === 'extended' ? 'Extended (fresh approval per command)' : 'Standard';
    return { result: `${info.result}\nCommand access: ${access}.`, resultSummary: 'Project manifests and available checks',
      usedFiles: info.usedFiles.map(relative => vscode.Uri.joinPath(folder.uri, ...relative.split('/')).fsPath), mutationCharacters: 0 };
  }

  private async readProjectGitChanges(call: Extract<ParsedAgentToolCall, { name: 'get_git_changes' }>, folder: vscode.WorkspaceFolder): Promise<AgentToolResult> {
    const info = await readGitChanges({ rootPath: folder.uri.fsPath, path: call.arguments.path, staged: call.arguments.staged,
      signal: this.events.getActiveSignal(), isPathAllowed: async relative => {
        try {
          const normalized = normalizeWorkspaceRelativePath(relative);
          if (shouldSkipProjectFile(normalized)) return false;
          await this.assertNoWorkspaceSymlink(folder, normalized, true);
          const uri = vscode.Uri.joinPath(folder.uri, ...normalized.split('/'));
          try { await vscode.workspace.fs.stat(uri); }
          catch (error) { return error instanceof vscode.FileSystemError && error.code === 'FileNotFound'; }
          return Boolean(await this.workspaceContext.readProjectCandidate(uri));
        } catch { return false; }
      } });
    return { result: info.result, resultSummary: 'Current Git changes',
      usedFiles: info.usedFiles.map(relative => vscode.Uri.joinPath(folder.uri, ...relative.split('/')).fsPath), mutationCharacters: 0 };
  }

  /** Convert language-provider edits into ordinary reviewed file changes, keeping budgets and Undo intact. */
  private async applyLanguageEdits(
    call: Extract<ParsedAgentToolCall, { name: 'rename_symbol' | 'format_file' }>,
    folder: vscode.WorkspaceFolder, remainingCharacters: number, remainingFiles: number
  ): Promise<AgentToolResult> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before using editor refactoring tools.');
    const sourcePath = call.arguments.path;
    if (shouldSkipProjectFile(sourcePath)) throw new Error('This file is excluded from DevMate tools.');
    await this.assertNoWorkspaceSymlink(folder, sourcePath, false);
    const uri = vscode.Uri.joinPath(folder.uri, ...sourcePath.split('/'));
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty) throw new Error(`Save or discard unsaved changes in ${sourcePath} first.`);
    const source = document.getText();
    const openSnapshots = new Map((vscode.workspace.textDocuments ?? []).map(doc => [doc.uri.toString(), doc.getText()]));
    let entries: [vscode.Uri, vscode.TextEdit[]][];
    if (call.name === 'rename_symbol') {
      const position = new vscode.Position(call.arguments.line - 1, call.arguments.column - 1);
      // Validate the requested position without relying on VS Code's clamping of out-of-range locations.
      applyProviderTextEdits(source, [{ range: { start: position, end: position }, newText: '' }]);
      const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', uri, position, call.arguments.newName);
      if (!edit || typeof edit.entries !== 'function') throw new Error('No rename provider is available for this symbol. Check the language extension.');
      // First discover the affected files, then request fresh offsets against their saved snapshots.
      // A rename can include closed files, so snapshotting only visible editors would miss a concurrent save.
      const discovered = edit.entries();
      if (discovered.length > 10 || discovered.length > remainingFiles) throw new Error('This refactoring exceeds the remaining file-edit budget. No changes were applied.');
      for (const [target] of discovered) {
        if (target.scheme !== 'file') throw new Error('The language provider returned a non-workspace resource.');
        const relative = normalizeWorkspaceRelativePath(path.relative(folder.uri.fsPath, target.fsPath).replace(/\\/g, '/'));
        if (shouldSkipProjectFile(relative)) throw new Error('The language provider returned an excluded target.');
        await this.assertNoWorkspaceSymlink(folder, relative, false);
        const targetDocument = await vscode.workspace.openTextDocument(target);
        if (targetDocument.isDirty) throw new Error(`Save or discard unsaved changes in ${relative} first.`);
        if (!openSnapshots.has(target.toString())) openSnapshots.set(target.toString(), targetDocument.getText());
      }
      const fresh = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', uri, position, call.arguments.newName);
      if (!fresh || typeof fresh.entries !== 'function') throw new Error('The rename provider could not produce a fresh edit. No changes were applied.');
      // We rebuild text edits ourselves; provider file operations or commands are never executed.
      entries = fresh.entries();
    } else {
      const options = vscode.workspace.getConfiguration('editor', uri);
      const tabSize = options.get<unknown>('tabSize', 2);
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', uri,
        { tabSize: typeof tabSize === 'number' && Number.isInteger(tabSize) && tabSize > 0 ? tabSize : 2,
          insertSpaces: options.get<unknown>('insertSpaces', true) !== false });
      if (!edits) throw new Error('No formatter is available for this file. Configure its language formatter in VS Code.');
      entries = [[uri, edits]];
    }
    if (document.isDirty || document.getText() !== source) throw new Error('The source changed while the language provider was working. Retry after saving it.');
    if (entries.length > 10 || entries.length > remainingFiles) throw new Error('This refactoring exceeds the remaining file-edit budget. No changes were applied.');
    const originals = new Map<string, string>();
    const proposals: { path: string; content: string }[] = [];
    for (const [target, edits] of entries) {
      if (target.scheme !== 'file') throw new Error('The language provider returned a non-workspace resource.');
      const relative = normalizeWorkspaceRelativePath(path.relative(folder.uri.fsPath, target.fsPath).replace(/\\/g, '/'));
      if (shouldSkipProjectFile(relative) || originals.has(relative)) throw new Error('The language provider returned an excluded or repeated target.');
      if (call.name === 'rename_symbol' && !openSnapshots.has(target.toString())) throw new Error('The rename targets changed during preparation. Retry after saving the project.');
      await this.assertNoWorkspaceSymlink(folder, relative, false);
      const targetDocument = await vscode.workspace.openTextDocument(target);
      const original = targetDocument.getText();
      if (targetDocument.isDirty || openSnapshots.has(target.toString()) && openSnapshots.get(target.toString()) !== original) {
        throw new Error(`${relative} changed while the language provider was working.`);
      }
      const content = applyProviderTextEdits(original, edits);
      originals.set(relative, original);
      if (content !== original) proposals.push({ path: relative, content });
    }
    if (!proposals.length) return { result: 'No text changes were needed.', resultSummary: 'No changes needed', usedFiles: [uri.fsPath], mutationCharacters: 0, mutationApplied: false };
    const changes = validateFileChanges(proposals);
    const size = changes.reduce((total, change) => total + change.content.length, 0);
    if (size > remainingCharacters) throw new Error('This refactoring exceeds the remaining file-size budget. No changes were applied.');
    const outcome = await this.confirmAndApplyFileChanges(changes,
      call.name === 'rename_symbol' ? `Rename symbol to ${call.arguments.newName}` : `Format ${sourcePath}`,
      this.events.getActiveSignal() ?? new AbortController().signal, originals);
    if (!outcome.startsWith('Applied file changes:')) throw new Error('Permission to apply the editor changes was denied.');
    return { result: outcome, resultSummary: `Updated ${changes.length} ${changes.length === 1 ? 'file' : 'files'}`,
      usedFiles: changes.map(change => vscode.Uri.joinPath(folder.uri, ...change.path.split('/')).fsPath),
      mutationCharacters: size, mutationApplied: true, mutationFiles: changes.length };
  }

  /** Apply exact replacements to a saved file, then pass the full proposed contents through diff review. */
  private async editAgentFile(
    call: Extract<ParsedAgentToolCall, { name: 'edit_file' }>,
    folder: vscode.WorkspaceFolder,
    remainingMutationCharacters: number
  ): Promise<AgentToolResult> {
    await this.assertNoWorkspaceSymlink(folder, call.arguments.path, false);
    const uri = vscode.Uri.joinPath(folder.uri, ...call.arguments.path.split('/'));
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      throw new Error(`${call.arguments.path} does not exist or cannot be opened.`);
    }
    if (document.isDirty) {
      throw new Error(`Save or discard your unsaved changes in ${call.arguments.path} before DevMate edits it.`);
    }
    const updatedContent = applyExactReplacements(
      document.getText(),
      call.arguments.replacements
    );
    if (updatedContent.length > remainingMutationCharacters) {
      throw new Error('This request reached the total file-mutation size limit.');
    }
    const changes = validateFileChanges([{
      path: call.arguments.path,
      content: updatedContent
    }]);
    const outcome = await this.confirmAndApplyFileChanges(
      changes,
      `Edit ${call.arguments.path}`,
      this.events.getActiveSignal() ?? new AbortController().signal
    );
    if (!outcome.startsWith('Applied file changes:')) {
      throw new Error('Permission to edit the file was denied.');
    }
    return {
      result: outcome,
      resultSummary: `Updated ${call.arguments.path}`,
      usedFiles: [uri.scheme === 'file' ? uri.fsPath : uri.toString()],
      mutationCharacters: updatedContent.length,
      mutationApplied: true
    };
  }

  private async listAgentFiles(
    call: Extract<ParsedAgentToolCall, { name: 'list_files' }>,
    folder: vscode.WorkspaceFolder,
    toolSettings: AgentToolSettings
  ): Promise<AgentToolResult> {
    const uris = await this.findAgentFiles(folder, call.arguments.path);
    const relativePaths = uris
      .map((uri) => normalizeRelativeWorkspacePath(vscode.workspace.asRelativePath(uri, false)))
      .sort((left, right) => left.localeCompare(right))
      .slice(0, Math.min(call.arguments.maxResults, toolSettings.listFilesMaxResults));
    const result = relativePaths.length > 0
      ? `Eligible files (${relativePaths.length}):\n${relativePaths.join('\n')}`
      : 'No eligible files were found at that path.';
    return {
      result,
      resultSummary: `${relativePaths.length} eligible ${relativePaths.length === 1 ? 'file' : 'files'}`,
      usedFiles: [],
      mutationCharacters: 0
    };
  }

  /** Read an eligible file from disk and return the requested line range within the configured limits. */
  private async readAgentFile(
    call: Extract<ParsedAgentToolCall, { name: 'read_file' }>,
    folder: vscode.WorkspaceFolder,
    toolSettings: AgentToolSettings
  ): Promise<AgentToolResult> {
    const uri = vscode.Uri.joinPath(folder.uri, ...call.arguments.path.split('/'));
    const candidate = await this.workspaceContext.readProjectCandidate(uri);
    if (
      !candidate
      || !agentPathMatches(
        normalizeRelativeWorkspacePath(candidate.relativePath),
        call.arguments.path
      )
    ) {
      throw new Error('The file does not exist or is excluded from DevMate context.');
    }
    const startLine = call.arguments.startLine ?? 1;
    const requestedEndLine = call.arguments.endLine
      ?? startLine + toolSettings.readFileMaxLines - 1;
    if (requestedEndLine - startLine + 1 > toolSettings.readFileMaxLines) {
      throw new Error(
        `read_file is configured to return at most ${toolSettings.readFileMaxLines} lines per call.`
      );
    }
    const read = formatReadFileResult({
      path: call.arguments.path,
      languageId: candidate.languageId,
      content: candidate.content,
      startLine,
      endLine: requestedEndLine,
      maxCharacters: MAX_AGENT_TOOL_RESULT_CHARACTERS
    });
    return {
      ...read,
      usedFiles: [candidate.filePath],
      mutationCharacters: 0
    };
  }

  private async readTerminalErrors(
    call: Extract<ParsedAgentToolCall, { name: 'read_terminal_errors' }>,
    toolSettings: AgentToolSettings
  ): Promise<AgentToolResult> {
    const maxResults = Math.min(
      call.arguments.maxResults,
      toolSettings.terminalErrorsMaxResults
    );
    const available = Math.min(maxResults, this.recentTerminalErrors.length);
    return {
      result: formatCapturedTerminalErrors(
        this.recentTerminalErrors,
        maxResults
      ),
      resultSummary: `${available} recent terminal ${available === 1 ? 'failure' : 'failures'}`,
      usedFiles: [],
      mutationCharacters: 0
    };
  }

  /** Search eligible project files and stop at the configured match and output limits. */
  private async searchAgentCode(
    call: Extract<ParsedAgentToolCall, { name: 'search_code' }>,
    folder: vscode.WorkspaceFolder,
    toolSettings: AgentToolSettings
  ): Promise<AgentToolResult> {
    const uris = (await this.findAgentFiles(folder, call.arguments.path)).filter(uri =>
      matchesSearchFilePattern(normalizeRelativeWorkspacePath(vscode.workspace.asRelativePath(uri, false)), call.arguments.filePattern));
    const matches: string[] = [];
    const usedFiles = new Set<string>();
    const maxSearchResults = Math.min(
      call.arguments.maxResults,
      toolSettings.searchCodeMaxResults
    );
    const batchSize = 20;
    let outputCharacters = 0;
    let outputLimited = false;
    for (let offset = 0; offset < uris.length && matches.length < maxSearchResults; offset += batchSize) {
      const candidates = await Promise.all(
        uris.slice(offset, offset + batchSize).map((uri) => this.workspaceContext.readProjectCandidate(uri))
      );
      for (const candidate of candidates) {
        if (!candidate) {
          continue;
        }
        const relativePath = normalizeRelativeWorkspacePath(candidate.relativePath);
        const snippets = searchCodeSnippets(candidate.content, call.arguments.query, {
          caseSensitive: call.arguments.caseSensitive, wholeWord: call.arguments.wholeWord,
          contextLines: call.arguments.contextLines, maxResults: maxSearchResults - matches.length
        });
        for (const snippet of snippets) {
          const text = snippet.startLine === snippet.endLine
            ? `${relativePath}:${snippet.line}: ${snippet.text}`
            : `${relativePath}:${snippet.line} (lines ${snippet.startLine}-${snippet.endLine}):\n${snippet.text}`;
          if (outputCharacters + text.length > MAX_AGENT_TOOL_RESULT_CHARACTERS - 300) {
            const remaining = MAX_AGENT_TOOL_RESULT_CHARACTERS - 300 - outputCharacters;
            if (remaining > 100) {
              matches.push(text.slice(0, remaining) + '\n[Excerpt shortened.]');
              usedFiles.add(candidate.filePath);
            }
            outputLimited = true;
            offset = uris.length;
            break;
          }
          matches.push(text);
          outputCharacters += text.length + 1;
          usedFiles.add(candidate.filePath);
          if (matches.length >= maxSearchResults) {
            break;
          }
        }
        if (matches.length >= maxSearchResults || outputLimited) {
          break;
        }
      }
    }
    const result = matches.length > 0
      ? `Matches for "${call.arguments.query}" (${matches.length}):\n${matches.join('\n')}${outputLimited ? '\nOutput limit reached. Narrow the search or read the matching file.' : ''}`
      : `No matches found for "${call.arguments.query}".`;
    return {
      result,
      resultSummary: `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`,
      usedFiles: [...usedFiles],
      mutationCharacters: 0
    };
  }


  /** Read VS Code diagnostics already supplied by installed language tools; this does not run a compiler. */
  private readWorkspaceDiagnostics(
    call: Extract<ParsedAgentToolCall, { name: 'get_diagnostics' }>,
    folder: vscode.WorkspaceFolder
  ): {
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
  } {
    const maxResults = Math.min(
      call.arguments.maxResults,
      this.events.getAgentToolSettings().diagnosticsMaxResults
    );
    const diagnostics: Array<{
      severity: vscode.DiagnosticSeverity;
      path: string;
      line: number;
      column: number;
      source?: string;
      code?: string;
      message: string;
    }> = [];

    for (const [uri, fileDiagnostics] of vscode.languages.getDiagnostics()) {
      const diagnosticFolder = vscode.workspace.getWorkspaceFolder(uri);
      if (!diagnosticFolder || diagnosticFolder.uri.toString() !== folder.uri.toString()) {
        continue;
      }
      const relativePath = normalizeRelativeWorkspacePath(
        vscode.workspace.asRelativePath(uri, false)
      );
      if (shouldSkipProjectFile(relativePath)) {
        continue;
      }
      if (
        call.arguments.path
        && !agentPathMatches(relativePath, call.arguments.path)
        && !agentPathStartsWith(relativePath, call.arguments.path)
      ) {
        continue;
      }
      for (const diagnostic of fileDiagnostics) {
        if (
          diagnostic.severity !== vscode.DiagnosticSeverity.Error
          && diagnostic.severity !== vscode.DiagnosticSeverity.Warning
        ) {
          continue;
        }
        const rawCode = typeof diagnostic.code === 'object'
          ? diagnostic.code.value
          : diagnostic.code;
        diagnostics.push({
          severity: diagnostic.severity,
          path: relativePath,
          line: diagnostic.range.start.line + 1,
          column: diagnostic.range.start.character + 1,
          source: diagnostic.source,
          code: rawCode === undefined ? undefined : String(rawCode),
          message: diagnostic.message
            .replace(/[\u0000-\u001f\u007f]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 500)
        });
      }
    }

    diagnostics.sort((left, right) => left.severity - right.severity
      || left.path.localeCompare(right.path)
      || left.line - right.line
      || left.column - right.column);
    const selected = diagnostics.slice(0, maxResults);
    const errors = selected.filter((item) => item.severity === vscode.DiagnosticSeverity.Error).length;
    const warnings = selected.length - errors;
    const result = selected.length === 0
      ? `No VS Code errors or warnings were found${call.arguments.path ? ` under ${call.arguments.path}` : ' in the workspace'}.`
      : [
        `VS Code Problems (${selected.length}${diagnostics.length > selected.length ? ` of ${diagnostics.length}` : ''}):`,
        ...selected.map((item) => {
          const severity = item.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
          const owner = [item.source, item.code].filter(Boolean).join(' ');
          return `[${severity}] ${item.path}:${item.line}:${item.column}${owner ? ` (${owner})` : ''} ${item.message}`;
        })
      ].join('\n');
    return {
      result: truncateAgentToolResult(result),
      resultSummary: `${errors} ${errors === 1 ? 'error' : 'errors'}, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`,
      usedFiles: [],
      mutationCharacters: 0
    };
  }

  /** Ask the installed language provider for symbols, then keep only bounded results from this workspace. */
  private async readDocumentSymbols(
    call: Extract<ParsedAgentToolCall, { name: 'get_symbols' }>,
    folder: vscode.WorkspaceFolder
  ): Promise<{
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
  }> {
    const source = await this.openCodeNavigationSource(folder, call.arguments.path);
    const configuredLimit = this.events.getAgentToolSettings().codeNavigationMaxResults;
    const maxResults = Math.min(call.arguments.maxResults, configuredLimit);
    const provided = await vscode.commands.executeCommand<
      Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined
    >('vscode.executeDocumentSymbolProvider', source.document.uri);
    const rows: string[] = [];

    const visit = (
      symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>,
      containers: string[] = []
    ): void => {
      for (const symbol of symbols) {
        if (rows.length >= maxResults) {
          return;
        }
        if (isDocumentSymbol(symbol)) {
          const container = containers.join('.');
          rows.push(formatSymbolResult(
            symbol.kind,
            symbol.name,
            call.arguments.path,
            symbol.selectionRange.start,
            container
          ));
          visit(symbol.children, [...containers, symbol.name]);
          continue;
        }
        const location = this.workspaceCodeLocation(
          folder,
          symbol.location.uri,
          symbol.location.range
        );
        if (!location) {
          continue;
        }
        rows.push(formatSymbolResult(
          symbol.kind,
          symbol.name,
          location.path,
          new vscode.Position(location.line - 1, location.column - 1),
          symbol.containerName
        ));
      }
    };
    visit(Array.isArray(provided) ? provided : []);

    const result = rows.length > 0
      ? `Symbols in ${call.arguments.path} (${rows.length}):\n${rows.join('\n')}`
      : `No document symbols were available for ${call.arguments.path}.`;
    return {
      result: truncateAgentToolResult(result),
      resultSummary: `${rows.length} ${rows.length === 1 ? 'symbol' : 'symbols'}`,
      usedFiles: [source.filePath],
      mutationCharacters: 0
    };
  }

  /** Use VS Code definition/reference providers and exclude locations outside eligible workspace files. */
  private async findCodeLocations(
    call: Extract<ParsedAgentToolCall, { name: 'find_definition' | 'find_references' }>,
    folder: vscode.WorkspaceFolder
  ): Promise<{
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
  }> {
    const source = await this.openCodeNavigationSource(
      folder,
      call.arguments.path,
      call.arguments.line,
      call.arguments.column
    );
    const position = new vscode.Position(call.arguments.line - 1, call.arguments.column - 1);
    const provided = call.name === 'find_definition'
      ? await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(
        'vscode.executeDefinitionProvider',
        source.document.uri,
        position
      )
      : await vscode.commands.executeCommand<vscode.Location[] | undefined>(
        'vscode.executeReferenceProvider',
        source.document.uri,
        position
      );
    const configuredLimit = this.events.getAgentToolSettings().codeNavigationMaxResults;
    const maxResults = Math.min(call.arguments.maxResults, configuredLimit);
    const locations: WorkspaceCodeLocation[] = [];
    const seen = new Set<string>();
    for (const rawLocation of Array.isArray(provided) ? provided : []) {
      const providerLocation = codeLocationFromProvider(rawLocation);
      if (!providerLocation) {
        continue;
      }
      const location = this.workspaceCodeLocation(
        folder,
        providerLocation.uri,
        providerLocation.range
      );
      if (!location) {
        continue;
      }
      const signature = `${this.fileChangePathKey(location.path)}:${location.line}:${location.column}`;
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      locations.push(location);
      if (locations.length >= maxResults) {
        break;
      }
    }

    const noun = call.name === 'find_definition' ? 'definition' : 'reference';
    const sourceLabel = `${call.arguments.path}:${call.arguments.line}:${call.arguments.column}`;
    const result = locations.length > 0
      ? `${noun === 'definition' ? 'Definitions' : 'References'} for ${sourceLabel} (${locations.length}):\n`
      + locations.map((location) => `${location.path}:${location.line}:${location.column}`).join('\n')
      : `No workspace ${noun}s were found for ${sourceLabel}.`;
    return {
      result: truncateAgentToolResult(result),
      resultSummary: `${locations.length} ${locations.length === 1 ? noun : `${noun}s`}`,
      usedFiles: [
        source.filePath,
        ...locations.map((location) => location.filePath)
      ].filter((value, index, values) => values.indexOf(value) === index).slice(0, 20),
      mutationCharacters: 0
    };
  }

  private async openCodeNavigationSource(
    folder: vscode.WorkspaceFolder,
    relativePath: string,
    line?: number,
    column?: number
  ): Promise<{ document: vscode.TextDocument; filePath: string }> {
    await this.assertNoWorkspaceSymlink(folder, relativePath, false);
    const uri = vscode.Uri.joinPath(folder.uri, ...relativePath.split('/'));
    const candidate = await this.workspaceContext.readProjectCandidate(uri);
    if (
      !candidate
      || !agentPathMatches(normalizeRelativeWorkspacePath(candidate.relativePath), relativePath)
    ) {
      throw new Error('The code-navigation source does not exist or is excluded from DevMate context.');
    }
    const document = await vscode.workspace.openTextDocument(uri);
    if (line !== undefined) {
      if (line > document.lineCount) {
        throw new Error(`${relativePath} has only ${document.lineCount} lines.`);
      }
      const lineLength = document.lineAt(line - 1).text.length;
      if (column === undefined || column > lineLength + 1) {
        throw new Error(`Column ${column ?? ''} is outside line ${line} in ${relativePath}.`);
      }
    }
    return { document, filePath: candidate.filePath };
  }

  private workspaceCodeLocation(
    folder: vscode.WorkspaceFolder,
    uri: vscode.Uri,
    range: vscode.Range
  ): WorkspaceCodeLocation | undefined {
    const locationFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!locationFolder || locationFolder.uri.toString() !== folder.uri.toString()) {
      return undefined;
    }
    const relativePath = normalizeRelativeWorkspacePath(vscode.workspace.asRelativePath(uri, false));
    if (shouldSkipProjectFile(relativePath)) {
      return undefined;
    }
    return {
      path: relativePath,
      line: range.start.line + 1,
      column: range.start.character + 1,
      filePath: uri.scheme === 'file' ? uri.fsPath : uri.toString()
    };
  }

  /** Review one file deletion, then recheck the approved contents before asking VS Code to delete it. */
  private async deleteAgentFile(
    call: Extract<ParsedAgentToolCall, { name: 'delete_file' }>,
    folder: vscode.WorkspaceFolder,
    remainingMutationCharacters: number
  ): Promise<{
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
    mutationApplied: boolean;
  }> {
    this.assertTrustedFileLifecycle();
    const source = await this.inspectAgentLifecycleFile(folder, call.arguments.path);
    if (source.content.length > remainingMutationCharacters) {
      throw new Error('This request reached the total file-mutation size limit.');
    }
    this.events.postStatus('Waiting for permission');
    const allowed = await this.requestFileChangePermission(
      `Delete ${call.arguments.path}`,
      [{
        path: call.arguments.path,
        operation: 'delete',
        originalContent: source.content,
        proposedContent: ''
      }]
    );
    if (!allowed) {
      throw new Error('Permission to delete the file was denied.');
    }
    const signal = this.events.getActiveSignal();
    if (signal?.aborted) {
      throw new Error('The file deletion was cancelled.');
    }
    this.assertTrustedFileLifecycle();
    await this.assertNoWorkspaceSymlink(folder, call.arguments.path, false);
    await this.revalidateAgentLifecycleFile(source);

    this.events.postStatus('Deleting file');
    const undoBefore = await this.captureUndoBefore(folder, [call.arguments.path]);
    if (signal?.aborted) {
      await this.queueUndo(() => this.persistRequestUndo());
      throw new Error('The file deletion was cancelled.');
    }
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.deleteFile(source.uri, { recursive: false, ignoreIfNotExists: false });
    try {
      if (!await vscode.workspace.applyEdit(workspaceEdit)) {
        throw new Error('VS Code could not delete the approved file.');
      }
    } finally {
      await this.captureUndoAfter(folder, undoBefore);
    }
    this.rememberCompletedFileDiff(call.arguments.path, source.content, '');
    return {
      result: `Applied file changes:\n- Deleted ${call.arguments.path}`,
      resultSummary: `Deleted ${call.arguments.path}`,
      usedFiles: [source.displayPath],
      mutationCharacters: source.content.length,
      mutationApplied: true
    };
  }

  /** Review a rename or move and recheck both ends before relocating the file without overwriting a destination. */
  private async relocateAgentFile(
    call: Extract<ParsedAgentToolCall, { name: 'rename_file' | 'move_file' }>,
    folder: vscode.WorkspaceFolder
  ): Promise<{
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
    mutationApplied: boolean;
  }> {
    this.assertTrustedFileLifecycle();
    const source = await this.inspectAgentLifecycleFile(folder, call.arguments.path);
    await this.assertNoWorkspaceSymlink(folder, call.arguments.newPath, true);
    const destinationUri = vscode.Uri.joinPath(folder.uri, ...call.arguments.newPath.split('/'));
    await this.assertAgentLifecycleDestinationAvailable(destinationUri, call.arguments.newPath);
    const operation = call.name === 'rename_file' ? 'rename' as const : 'move' as const;
    const operationLabel = operation === 'rename' ? 'Rename' : 'Move';

    this.events.postStatus('Waiting for permission');
    const allowed = await this.requestFileChangePermission(
      `${operationLabel} ${call.arguments.path} to ${call.arguments.newPath}`,
      [{
        path: `${call.arguments.path} → ${call.arguments.newPath}`,
        operation,
        originalContent: source.content,
        proposedContent: source.content
      }]
    );
    if (!allowed) {
      throw new Error(`Permission to ${operation} the file was denied.`);
    }
    const signal = this.events.getActiveSignal();
    if (signal?.aborted) {
      throw new Error(`The file ${operation} was cancelled.`);
    }
    this.assertTrustedFileLifecycle();
    await this.assertNoWorkspaceSymlink(folder, call.arguments.path, false);
    await this.assertNoWorkspaceSymlink(folder, call.arguments.newPath, true);
    await this.revalidateAgentLifecycleFile(source);
    await this.assertAgentLifecycleDestinationAvailable(destinationUri, call.arguments.newPath);

    const parentSegments = call.arguments.newPath.split('/').slice(0, -1);
    if (parentSegments.length > 0) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, ...parentSegments));
    }
    this.events.postStatus(operation === 'rename' ? 'Renaming file' : 'Moving file');
    const undoBefore = await this.captureUndoBefore(folder, [call.arguments.path, call.arguments.newPath]);
    if (signal?.aborted) {
      await this.queueUndo(() => this.persistRequestUndo());
      throw new Error(`The file ${operation} was cancelled.`);
    }
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.renameFile(source.uri, destinationUri, {
      overwrite: false,
      ignoreIfExists: false
    });
    try {
      if (!await vscode.workspace.applyEdit(workspaceEdit)) {
        throw new Error(`VS Code could not ${operation} the approved file.`);
      }
    } finally {
      await this.captureUndoAfter(folder, undoBefore);
    }
    this.rememberCompletedFileDiff(
      call.arguments.newPath,
      source.content,
      source.content,
      call.arguments.path
    );

    let openNote = '';
    try {
      const document = await vscode.workspace.openTextDocument(destinationUri);
      if (!await document.save()) {
        openNote = '\n\nThe file was relocated, but VS Code could not confirm it was saved.';
      }
      await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
        preserveFocus: false
      });
    } catch {
      openNote = '\n\nThe file was relocated, but VS Code could not open the destination.';
    }

    return {
      result: `Applied file changes:\n- ${operation === 'rename' ? 'Renamed' : 'Moved'} `
        + `${call.arguments.path} to ${call.arguments.newPath}${openNote}`,
      resultSummary: `${operation === 'rename' ? 'Renamed' : 'Moved'} ${call.arguments.path}`,
      usedFiles: [
        source.displayPath,
        destinationUri.scheme === 'file' ? destinationUri.fsPath : destinationUri.toString()
      ],
      mutationCharacters: 0,
      mutationApplied: true
    };
  }

  private assertTrustedFileLifecycle(): void {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before allowing DevMate to delete, rename, or move files.');
    }
  }

  /** Capture the saved text used in deletion or relocation review, rejecting dirty, binary and oversized files. */
  private async inspectAgentLifecycleFile(
    folder: vscode.WorkspaceFolder,
    relativePath: string
  ): Promise<{
    path: string;
    uri: vscode.Uri;
    displayPath: string;
    content: string;
  }> {
    await this.assertNoWorkspaceSymlink(folder, relativePath, false);
    const uri = vscode.Uri.joinPath(folder.uri, ...relativePath.split('/'));
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      throw new Error(`${relativePath} does not exist or cannot be inspected.`);
    }
    if ((stat.type & vscode.FileType.File) === 0) {
      throw new Error(`${relativePath} is not a file. Recursive directory operations are blocked.`);
    }
    if (stat.size > MAX_PROJECT_FILE_BYTES) {
      throw new Error(`${relativePath} exceeds the file-size limit.`);
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (containsBinaryData(bytes)) {
      throw new Error(`DevMate will not change binary content at ${relativePath}.`);
    }
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty) {
      throw new Error(`Save or discard your unsaved changes in ${relativePath} before DevMate changes it.`);
    }
    const content = document.getText();
    if (content.length > MAX_FILE_CHANGE_CHARACTERS) {
      throw new Error(`${relativePath} exceeds the per-file change limit.`);
    }
    return {
      path: relativePath,
      uri,
      displayPath: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
      content
    };
  }

  /** Detect edits made while the permission prompt was open; approval only covered the captured source text. */
  private async revalidateAgentLifecycleFile(source: {
    path: string;
    uri: vscode.Uri;
    content: string;
  }): Promise<void> {
    let document: vscode.TextDocument;
    try {
      const stat = await vscode.workspace.fs.stat(source.uri);
      if ((stat.type & vscode.FileType.File) === 0) {
        throw new Error('The source is no longer a file.');
      }
      document = await vscode.workspace.openTextDocument(source.uri);
    } catch {
      throw new Error(`${source.path} changed while permission was pending. Review the request again.`);
    }
    if (document.isDirty || document.getText() !== source.content) {
      throw new Error(`${source.path} changed while permission was pending. Review the request again.`);
    }
  }

  private async assertAgentLifecycleDestinationAvailable(
    uri: vscode.Uri,
    relativePath: string
  ): Promise<void> {
    try {
      await vscode.workspace.fs.stat(uri);
      throw new Error(`${relativePath} already exists; choose a different destination.`);
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
        throw error;
      }
    }
  }

  /**
   * Run an approved verification command through VS Code shell integration and capture its bounded output.
   * A nonzero exit, timeout or cancellation is reported as an attempted command, not a command that never ran.
   */
  private async runVerificationCommand(
    call: Extract<ParsedAgentToolCall, { name: 'run_command' }>,
    folder: vscode.WorkspaceFolder
  ): Promise<{
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
    commandAttempted: boolean;
  }> {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before allowing DevMate to run verification commands.');
    }
    const access = parseCommandAccess(this.extensionContext.workspaceState.get(COMMAND_ACCESS_STORAGE_KEY));
    const requestedCommand = parseRunCommandArguments(call.arguments, access);
    if (requestedCommand.background) { this.managedCommands.assertCapacity(); }
    const cwdUri = requestedCommand.cwd
      ? vscode.Uri.joinPath(folder.uri, ...requestedCommand.cwd.split('/'))
      : folder.uri;
    if (call.arguments.cwd) {
      await this.assertNoWorkspaceSymlink(folder, call.arguments.cwd, false);
    }
    if (call.arguments.executable.startsWith('./')) {
      await this.assertNoWorkspaceSymlink(
        folder,
        [call.arguments.cwd, call.arguments.executable.slice(2)].filter(Boolean).join('/'),
        false
      );
    }
    try {
      const stat = await vscode.workspace.fs.stat(cwdUri);
      if ((stat.type & vscode.FileType.Directory) === 0) {
        throw new Error('The command working directory is not a directory.');
      }
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? `Cannot use the command working directory: ${error.message}`
          : 'Cannot use the command working directory.'
      );
    }

    const prepare = async () => {
      await this.validateCommandPaths(requestedCommand, folder);
      const python = await this.resolveWorkspacePythonCommand(requestedCommand, folder);
      const resolved = folder.uri.scheme === 'file'
        ? await resolveCommandExecutable(python.command, folder.uri.fsPath) : python.command;
      const command = { ...resolved, args: commandExecutionArguments(requestedCommand) };
      const identity = await commandApprovalIdentity(command, folder.uri.fsPath, {
        canonicalPath: async (value) => (await import('fs/promises')).realpath(value),
        readFile: async (value) => {
          const uri = vscode.Uri.file(value);
          try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type & vscode.FileType.SymbolicLink || stat.size > 2_000_000) {
              throw new Error('Command identity cannot include a link or oversized file.');
            }
            return await vscode.workspace.fs.readFile(uri);
          } catch (error) {
            if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') { return undefined; }
            throw error;
          }
        }
      });
      return { command, identity, environment: python.environment };
    };
    const resolvedPython = await prepare();
    const command = resolvedPython.command;
    const requestedLabel = commandLabel(requestedCommand);
    const label = resolvedPython.environment
      ? `${requestedLabel} · ${resolvedPython.environment}`
      : requestedLabel;
    const allowed = await this.requestCommandPermission(resolvedPython.identity.signature, label, command.cwd, {
      rememberable: canRememberCommandApproval(access, resolvedPython.identity.rememberable),
      title: access === 'extended' ? 'Allow Extended command once?' : 'Allow project command?',
      warning: access === 'extended'
        ? 'This command can change files, install packages, or start a server. Extended access is not a sandbox.'
        : !resolvedPython.identity.rememberable
          ? 'Project scripts can execute other code. This command needs a fresh approval because its full identity cannot be safely remembered.'
          : undefined
    });
    if (!allowed) {
      throw new Error('Permission to run the verification command was denied.');
    }
    if (!vscode.workspace.isTrusted) {
      throw new Error('Workspace Trust changed while command permission was pending; the command was not run.');
    }
    const signal = this.events.getActiveSignal() ?? new AbortController().signal;
    if (signal.aborted) {
      throw new Error('The verification command was cancelled.');
    }

    const recheck = async () => {
      if (!vscode.workspace.isTrusted || signal.aborted
        || parseCommandAccess(this.extensionContext.workspaceState.get(COMMAND_ACCESS_STORAGE_KEY)) !== access) {
        throw new Error('Command access, Workspace Trust, or cancellation changed; the command was not run.');
      }
      const current = await prepare();
      if (!vscode.workspace.isTrusted || signal.aborted
        || parseCommandAccess(this.extensionContext.workspaceState.get(COMMAND_ACCESS_STORAGE_KEY)) !== access) {
        throw new Error('Command access, Workspace Trust, or cancellation changed; the command was not run.');
      }
      if (current.identity.signature !== resolvedPython.identity.signature) {
        throw new Error('The command, script, wrapper, or configuration changed after approval. Request the command again for a fresh review.');
      }
    };
    await recheck();
    // The runner supplies the resolved user limit; never silently override it with a stale legacy setting.
    const timeoutSeconds = Math.min(command.timeoutSeconds, MAX_COMMAND_TIMEOUT_SECONDS);
    const terminal = vscode.window.createTerminal({
      name: `DevMate: ${label.slice(0, 60)}`,
      cwd: cwdUri,
      isTransient: true
    });
    this.commandTerminals.set(call.id, terminal);
    const shellIntegration = await this.waitForShellIntegration(terminal, signal);
    if (!shellIntegration) {
      terminal.dispose();
      this.commandTerminals.delete(call.id);
      throw new Error('VS Code terminal shell integration was unavailable after 5 seconds; the command was not run.');
    }

    try { await recheck(); } catch (error) {
      terminal.dispose();
      this.commandTerminals.delete(call.id);
      throw error;
    }

    const execution = shellIntegration.executeCommand(command.executable, command.args);
    if (command.background) {
      return this.trackBackgroundCommand(call.id, label, terminal, execution, timeoutSeconds, signal);
    }
    const startedAt = Date.now();
    let output = '';
    const outputReader = (async () => {
      for await (const data of execution.read()) {
        output = sanitizeCommandOutput(output + data);
        this.postAgentToolActivity(
          call.id,
          'Running verification command',
          label,
          'running',
          output,
          true
        );
      }
    })();

    const outcome = await new Promise<{
      state: 'completed' | 'cancelled' | 'timeout';
      exitCode?: number;
    }>((resolve) => {
      let settled = false;
      const finish = (value: { state: 'completed' | 'cancelled' | 'timeout'; exitCode?: number }) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        endDisposable.dispose();
        resolve(value);
      };
      const endDisposable = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution === execution) {
          finish({ state: 'completed', exitCode: event.exitCode });
        }
      });
      const cancel = () => {
        terminal.dispose();
        finish({ state: 'cancelled' });
      };
      const timeout = setTimeout(() => {
        terminal.dispose();
        finish({ state: 'timeout' });
      }, timeoutSeconds * 1_000);
      signal.addEventListener('abort', cancel, { once: true });
    });
    await Promise.race([outputReader, wait(250)]);
    const durationSeconds = Math.max(0, (Date.now() - startedAt) / 1_000);
    const modelOutput = boundedModelCommandOutput(output);
    const result = [
      `Command: ${requestedLabel}`,
      ...(isPythonVerificationCommand(requestedCommand)
        ? [`Python environment: ${resolvedPython.environment ?? `PATH lookup (${requestedCommand.executable})`}`]
        : []),
      `Working directory: ${command.cwd || '.'}`,
      outcome.state === 'completed'
        ? `Exit code: ${outcome.exitCode ?? 'unknown'}`
        : outcome.state === 'timeout'
          ? `Timed out after ${timeoutSeconds} seconds`
          : 'Cancelled',
      `Duration: ${durationSeconds.toFixed(1)} seconds`,
      modelOutput ? `Output:\n${modelOutput}` : 'Output: (none)'
    ].join('\n');

    if (outcome.state === 'cancelled') {
      this.commandTerminals.delete(call.id);
      throw new StartedCommandError('The verification command was cancelled.');
    }
    if (outcome.state === 'timeout') {
      this.commandTerminals.delete(call.id);
      throw new StartedCommandError(result);
    }
    if (outcome.exitCode !== 0) {
      throw new StartedCommandError(
        result,
        extractMissingPythonModule(modelOutput),
        resolvedPython.environment
      );
    }
    return {
      result,
      resultSummary: `Passed in ${durationSeconds.toFixed(1)}s`,
      usedFiles: [],
      mutationCharacters: 0,
      commandAttempted: true
    };
  }

  /**
   * Install a validated requirements file into a project-local virtual environment after one-time approval.
   * Recheck the manifest and environment after approval, and share one timeout across setup and installation.
   */
  private async runDependencyInstallation(
    call: Extract<ParsedAgentToolCall, { name: 'install_dependencies' }>,
    folder: vscode.WorkspaceFolder
  ): Promise<{
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
    installAttempted: boolean;
    environmentChanged: boolean;
  }> {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before allowing DevMate to install dependencies.');
    }
    if (folder.uri.scheme !== 'file') {
      throw new Error('Python dependency installation currently requires a local filesystem workspace.');
    }
    const initialManifest = await this.readDependencyManifest(
      folder,
      call.arguments.manifestPath
    );
    const cwdUri = call.arguments.cwd
      ? vscode.Uri.joinPath(folder.uri, ...call.arguments.cwd.split('/'))
      : folder.uri;
    const probeCommand: ValidatedCommand = {
      executable: process.platform === 'win32' ? 'py' : 'python3',
      args: [],
      cwd: call.arguments.cwd,
      timeoutSeconds: call.arguments.timeoutSeconds
    };
    const existingPython = await this.resolveWorkspacePythonCommand(probeCommand, folder);
    const targetEnvironment = [call.arguments.cwd, '.venv'].filter(Boolean).join('/');
    const willCreateEnvironment = !existingPython.environment;
    if (willCreateEnvironment) {
      const targetUri = vscode.Uri.joinPath(folder.uri, ...targetEnvironment.split('/'));
      try {
        await vscode.workspace.fs.stat(targetUri);
        throw new Error(
          `${targetEnvironment} already exists but does not contain a supported Python interpreter. `
          + 'Repair or remove it manually before installing dependencies.'
        );
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
          throw error;
        }
      }
    }

    const environmentLabel = existingPython.environment ?? targetEnvironment;
    const requirementSummary = initialManifest.requirements.length === 1
      ? initialManifest.requirements[0]
      : `${initialManifest.requirements.length} requirements`;
    const allowed = await this.requestCommandPermission(
      randomUUID(),
      `${willCreateEnvironment ? `Create ${targetEnvironment} and install` : 'Install'} ${requirementSummary} from ${call.arguments.manifestPath}`,
      call.arguments.cwd,
      {
        rememberable: false,
        title: 'Permission required to install Python dependencies',
        warning: 'This downloads packages and may execute package build or installation code. Installation is restricted to the validated manifest and project-local virtual environment.'
      }
    );
    if (!allowed) {
      throw new Error('Permission to install dependencies was denied.');
    }
    if (!vscode.workspace.isTrusted) {
      throw new Error('Workspace Trust changed while installation permission was pending; nothing was installed.');
    }
    // The permission covered the displayed requirements, so a changed manifest needs a new review.
    const currentManifest = await this.readDependencyManifest(
      folder,
      call.arguments.manifestPath
    );
    if (currentManifest.content !== initialManifest.content) {
      throw new Error('The dependency manifest changed during approval; review the updated file and try again.');
    }

    let approvedPython = existingPython;
    if (willCreateEnvironment) {
      const targetUri = vscode.Uri.joinPath(folder.uri, ...targetEnvironment.split('/'));
      try {
        await vscode.workspace.fs.stat(targetUri);
        throw new Error(
          `${targetEnvironment} appeared during approval; inspect it before trying again.`
        );
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
          throw error;
        }
      }
    } else {
      approvedPython = await this.resolveWorkspacePythonCommand(probeCommand, folder);
      if (approvedPython.environment !== existingPython.environment) {
        throw new Error('The selected Python environment changed during approval; inspect it and try again.');
      }
    }

    const signal = this.events.getActiveSignal() ?? new AbortController().signal;
    if (signal.aborted) {
      throw new Error('The dependency installation was cancelled.');
    }
    const configuredTimeout = vscode.workspace.getConfiguration('devMate').get<number>(
      'commandTimeoutSeconds',
      DEFAULT_COMMAND_TIMEOUT_SECONDS
    );
    const timeoutSeconds = Math.min(
      call.arguments.timeoutSeconds,
      MAX_COMMAND_TIMEOUT_SECONDS,
      Math.max(MIN_COMMAND_TIMEOUT_SECONDS, configuredTimeout)
    );
    const terminal = vscode.window.createTerminal({
      name: `DevMate: install ${path.posix.basename(call.arguments.manifestPath)}`,
      cwd: cwdUri,
      isTransient: true
    });
    this.commandTerminals.set(call.id, terminal);
    const shellIntegration = await this.waitForShellIntegration(terminal, signal);
    if (!shellIntegration) {
      terminal.dispose();
      this.commandTerminals.delete(call.id);
      throw new Error('VS Code terminal shell integration was unavailable after 5 seconds; dependencies were not installed.');
    }

    const startedAt = Date.now();
    const deadline = startedAt + timeoutSeconds * 1_000;
    let combinedOutput = '';
    const runStep = async (executable: string, args: string[], label: string) => {
      const remainingMilliseconds = Math.max(1, deadline - Date.now());
      combinedOutput = sanitizeCommandOutput(`${combinedOutput}${combinedOutput ? '\n' : ''}> ${label}\n`);
      const step = await this.executeTerminalStep(
        terminal,
        shellIntegration,
        executable,
        args,
        remainingMilliseconds,
        signal,
        (output) => {
          combinedOutput = sanitizeCommandOutput(combinedOutput + output);
          this.postAgentToolActivity(
            call.id,
            'Installing Python dependencies',
            `${call.arguments.manifestPath} → ${environmentLabel}`,
            'running',
            combinedOutput,
            true
          );
        }
      );
      if (step.state === 'cancelled') {
        this.commandTerminals.delete(call.id);
        throw new StartedDependencyInstallError('The dependency installation was cancelled.');
      }
      if (step.state === 'timeout') {
        this.commandTerminals.delete(call.id);
        throw new StartedDependencyInstallError(
          `Dependency installation timed out after ${timeoutSeconds} seconds.\n\n${boundedModelCommandOutput(combinedOutput)}`
        );
      }
      if (step.exitCode !== 0) {
        throw new StartedDependencyInstallError([
          `${label} failed with exit code ${step.exitCode ?? 'unknown'}.`,
          boundedModelCommandOutput(combinedOutput)
        ].join('\n\n'));
      }
    };

    let pythonExecutable = approvedPython.command.executable;
    if (willCreateEnvironment) {
      const launcher = process.platform === 'win32' ? 'py' : 'python3';
      await runStep(launcher, ['-m', 'venv', '.venv'], `${launcher} -m venv .venv`);
      const createdCandidate = workspacePythonCandidates(call.arguments.cwd)[0];
      await this.assertNoWorkspaceSymlink(folder, createdCandidate, false);
      const createdUri = vscode.Uri.joinPath(folder.uri, ...createdCandidate.split('/'));
      const createdStat = await vscode.workspace.fs.stat(createdUri);
      if ((createdStat.type & vscode.FileType.File) === 0) {
        throw new StartedDependencyInstallError('The virtual environment was created without a usable Python interpreter.');
      }
      pythonExecutable = workspacePythonExecutable(createdCandidate, call.arguments.cwd);
    }

    const manifestName = path.posix.basename(call.arguments.manifestPath);
    await runStep(
      pythonExecutable,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', manifestName],
      `${environmentLabel} -m pip install -r ${manifestName}`
    );
    const durationSeconds = Math.max(0, (Date.now() - startedAt) / 1_000);
    const result = [
      `Manifest: ${call.arguments.manifestPath}`,
      `Python environment: ${environmentLabel}`,
      `Installed requirements: ${initialManifest.requirements.join(', ')}`,
      `Duration: ${durationSeconds.toFixed(1)} seconds`,
      boundedModelCommandOutput(combinedOutput)
    ].join('\n');
    return {
      result,
      resultSummary: `Installed ${initialManifest.requirements.length} ${initialManifest.requirements.length === 1 ? 'requirement' : 'requirements'} into ${environmentLabel}`,
      usedFiles: [initialManifest.uri.fsPath],
      mutationCharacters: 0,
      installAttempted: true,
      environmentChanged: true
    };
  }

  private async readDependencyManifest(
    folder: vscode.WorkspaceFolder,
    manifestPath: string
  ): Promise<{ uri: vscode.Uri; content: string; requirements: string[] }> {
    await this.assertNoWorkspaceSymlink(folder, manifestPath, false);
    const uri = vscode.Uri.joinPath(folder.uri, ...manifestPath.split('/'));
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString()
    );
    if (openDocument?.isDirty) {
      throw new Error(`Save or discard your unsaved changes in ${manifestPath} before installing dependencies.`);
    }
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.File) === 0 || stat.size > MAX_DEPENDENCY_MANIFEST_BYTES) {
      throw new Error('The dependency manifest is not a supported text file or exceeds 64 KB.');
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (containsBinaryData(bytes)) {
      throw new Error('The dependency manifest contains binary data.');
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('The dependency manifest must be valid UTF-8 text.');
    }
    return {
      uri,
      content,
      requirements: validatePythonRequirementsManifest(content)
    };
  }

  /** Run one installation step, returning its exit state while forwarding output and cleaning up event listeners. */
  private async executeTerminalStep(
    terminal: vscode.Terminal,
    shellIntegration: vscode.TerminalShellIntegration,
    executable: string,
    args: string[],
    timeoutMilliseconds: number,
    signal: AbortSignal,
    onOutput: (output: string) => void
  ): Promise<{ state: 'completed' | 'cancelled' | 'timeout'; exitCode?: number }> {
    const execution = shellIntegration.executeCommand(executable, args);
    const outputReader = (async () => {
      for await (const data of execution.read()) {
        onOutput(data);
      }
    })();
    const outcome = await new Promise<{
      state: 'completed' | 'cancelled' | 'timeout';
      exitCode?: number;
    }>((resolve) => {
      let settled = false;
      const finish = (value: { state: 'completed' | 'cancelled' | 'timeout'; exitCode?: number }) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        endDisposable.dispose();
        resolve(value);
      };
      const endDisposable = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution === execution) {
          finish({ state: 'completed', exitCode: event.exitCode });
        }
      });
      const cancel = () => {
        terminal.dispose();
        finish({ state: 'cancelled' });
      };
      const timeout = setTimeout(() => {
        terminal.dispose();
        finish({ state: 'timeout' });
      }, timeoutMilliseconds);
      signal.addEventListener('abort', cancel, { once: true });
    });
    await Promise.race([outputReader, wait(250)]);
    return outcome;
  }

  /** Prefer a project virtual environment for Python checks, while preserving the requested arguments and directory. */
  private async resolveWorkspacePythonCommand(
    command: ValidatedCommand,
    folder: vscode.WorkspaceFolder
  ): Promise<{ command: ValidatedCommand; environment?: string }> {
    if (!isPythonVerificationCommand(command) || folder.uri.scheme !== 'file') {
      return { command };
    }
    for (const candidate of workspacePythonCandidates(command.cwd)) {
      try {
        await this.assertNoWorkspaceSymlink(folder, candidate, false);
        const uri = vscode.Uri.joinPath(folder.uri, ...candidate.split('/'));
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.File) !== 0) {
          return {
            command: {
              ...command,
              executable: workspacePythonExecutable(candidate, command.cwd)
            },
            environment: candidate
          };
        }
      } catch {
        // Missing, inaccessible, and symbolic-link environments are ignored safely.
      }
    }
    return { command };
  }

  /** Capture terminal executions started after activation, scoped to this workspace, for later debugging context. */
  private captureWorkspaceTerminalExecution(
    event: vscode.TerminalShellExecutionStartEvent
  ): void {
    if (event.terminal.name.startsWith('DevMate:')) {
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    const cwd = event.execution.cwd;
    if (!folder || !cwd) {
      return;
    }
    const cwdWorkspace = vscode.workspace.getWorkspaceFolder(cwd);
    if (!cwdWorkspace || cwdWorkspace.uri.toString() !== folder.uri.toString()) {
      return;
    }

    const capture: ActiveTerminalCapture = {
      command: sanitizeCapturedTerminalText(event.execution.commandLine.value),
      cwd: normalizeRelativeWorkspacePath(vscode.workspace.asRelativePath(cwd, false)),
      terminalName: sanitizeCapturedTerminalText(event.terminal.name),
      output: ''
    };
    this.activeTerminalCaptures.set(event.execution, capture);
    capture.reader = (async () => {
      try {
        for await (const data of event.execution.read()) {
          capture.output = sanitizeCapturedTerminalText(capture.output + data);
        }
      } catch {
        // Terminal output is optional context. Failed capture must not affect the terminal.
      }
    })();
  }

  /** Keep only failed captured commands, with bounded and redacted text for the read_terminal_errors tool. */
  private async finishWorkspaceTerminalExecution(
    event: vscode.TerminalShellExecutionEndEvent
  ): Promise<void> {
    const capture = this.activeTerminalCaptures.get(event.execution);
    if (!capture) {
      return;
    }
    this.activeTerminalCaptures.delete(event.execution);
    if (capture.reader) {
      await Promise.race([capture.reader, wait(250)]);
    }
    if (event.exitCode === undefined || event.exitCode === 0) {
      return;
    }

    this.recentTerminalErrors.unshift({
      command: sanitizeCapturedTerminalText(event.execution.commandLine.value) || capture.command,
      cwd: capture.cwd,
      terminalName: capture.terminalName,
      exitCode: event.exitCode,
      output: sanitizeCapturedTerminalText(capture.output),
      capturedAt: Date.now()
    });
    this.recentTerminalErrors.splice(MAX_CAPTURED_TERMINAL_ERRORS);
  }

  /** Wait briefly for VS Code to expose structured command execution; never fall back to sending raw shell text. */
  private waitForShellIntegration(
    terminal: vscode.Terminal,
    signal: AbortSignal
  ): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration) {
      return Promise.resolve(terminal.shellIntegration);
    }
    return new Promise((resolve) => {
      const finish = (integration?: vscode.TerminalShellIntegration) => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        disposable.dispose();
        resolve(integration);
      };
      const cancel = () => finish();
      const disposable = vscode.window.onDidChangeTerminalShellIntegration((event) => {
        if (event.terminal === terminal) {
          finish(event.shellIntegration);
        }
      });
      const timeout = setTimeout(() => finish(), 5_000);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  disposeCommandTerminals(): void {
    for (const [id, terminal] of this.commandTerminals) {
      if (!this.backgroundTerminals.has(terminal)) {
        terminal.dispose();
        this.commandTerminals.delete(id);
      }
    }
  }

  postManagedCommandState(): void {
    this.events.postMessage({ command: 'managedCommandsUpdated', commands: this.managedCommands.active() });
  }

  stopManagedCommand(id: string): void {
    if (!this.managedCommands.stop(id)) { throw new Error('That command ID does not belong to a DevMate command in this window.'); }
  }

  stopAllManagedCommands(): void { this.managedCommands.stopAll(); }

  /** Recheck workspace paths after permission; a relative cwd alone does not contain program behaviour. */
  private async validateCommandPaths(command: ValidatedCommand, folder: vscode.WorkspaceFolder): Promise<void> {
    if (command.cwd) { await this.assertNoWorkspaceSymlink(folder, command.cwd, false); }
    const cwdUri = command.cwd ? vscode.Uri.joinPath(folder.uri, ...command.cwd.split('/')) : folder.uri;
    if (!((await vscode.workspace.fs.stat(cwdUri)).type & vscode.FileType.Directory)) {
      throw new Error('The command working directory is not a directory.');
    }
    const script = commandProjectScript(command);
    const paths = [...(command.executable.startsWith('./') ? [command.executable.slice(2)] : []), ...(script ? [script] : [])];
    for (const relative of paths) {
      const filePath = normalizeWorkspaceRelativePath([command.cwd, relative].filter(Boolean).join('/'));
      await this.assertNoWorkspaceSymlink(folder, filePath, false);
      if (!((await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, ...filePath.split('/')))).type & vscode.FileType.File)) {
        throw new Error('The command script or wrapper must be an existing project file.');
      }
    }
    const name = command.executable.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
    if (['npm', 'pnpm', 'yarn'].includes(name)
      && !['--version', 'list', 'ls'].includes(command.args[0] ?? '')) {
      const manifest = vscode.Uri.joinPath(cwdUri, 'package.json');
      await this.assertNoWorkspaceSymlink(folder, [command.cwd, 'package.json'].filter(Boolean).join('/'), false);
      const stat = await vscode.workspace.fs.stat(manifest);
      if (stat.size > 1_000_000) { throw new Error('package.json is too large to review for command approval.'); }
      const content = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(manifest)).toString('utf8')) as { scripts?: Record<string, unknown> };
      const operation = command.args[0];
      if (!['install', 'ci', 'add'].includes(operation)) {
        const scriptName = operation === 'run' ? command.args[1] : operation;
        if (typeof content.scripts?.[scriptName] !== 'string') {
          throw new Error(`package.json does not define the requested ${scriptName} script.`);
        }
      }
    }
  }

  /** Keep bounded server logs and a stop handle, and never accept arbitrary terminal IDs from the model. */
  private async trackBackgroundCommand(
    callId: string, label: string, terminal: vscode.Terminal, execution: vscode.TerminalShellExecution,
    timeoutSeconds: number, signal: AbortSignal
  ): Promise<{ result: string; resultSummary: string; usedFiles: string[]; mutationCharacters: number; commandAttempted: boolean }> {
    let end: vscode.Disposable | undefined;
    let closed: vscode.Disposable | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    this.backgroundTerminals.add(terminal);
    const id = this.managedCommands.add(label, (stop) => {
      if (timeout) { clearTimeout(timeout); }
      end?.dispose();
      closed?.dispose();
      this.backgroundTerminals.delete(terminal);
      this.commandTerminals.delete(callId);
      this.commandTerminals.delete(id);
      if (stop) { terminal.dispose(); }
    });
    this.commandTerminals.set(id, terminal);
    end = vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.execution === execution) { this.managedCommands.finish(id, `exited (${event.exitCode ?? 'unknown'})`); }
    });
    closed = vscode.window.onDidCloseTerminal?.((value) => {
      if (value === terminal) { this.managedCommands.finish(id, 'terminal closed'); }
    });
    timeout = setTimeout(() => this.managedCommands.stop(id), timeoutSeconds * 1_000);
    const cancel = () => this.managedCommands.stop(id);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); }
    void (async () => {
      try {
        for await (const chunk of execution.read()) {
          this.managedCommands.append(id, chunk);
          const current = this.managedCommands.read(id);
          this.postAgentToolActivity(callId, 'Background command', label, 'running', current?.output, true);
        }
      } catch { /* Terminal closure can end output collection without a final chunk. */ }
    })();
    await wait(300);
    signal.removeEventListener('abort', cancel);
    const current = this.managedCommands.read(id)!;
    return { result: [`Command ID: ${id}`, `Command: ${label}`, `Status: ${current.status}`,
      `Automatic terminal stop after ${timeoutSeconds} seconds.`,
      'Use stop_command with this ID, or Stop in the DevMate panel. Readiness and network binding are determined by the project script.',
      current.output ? `Output:\n${boundedModelCommandOutput(current.output)}` : 'Output: (none yet)'].join('\n'),
      resultSummary: current.status === 'running' ? `Background command started (${id})` : current.status,
      usedFiles: [], mutationCharacters: 0, commandAttempted: true };
  }

  private async findAgentFiles(
    folder: vscode.WorkspaceFolder,
    requestedPath: string
  ): Promise<vscode.Uri[]> {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*'),
      PROJECT_EXCLUDE_GLOB,
      MAX_ATTACHMENT_CANDIDATES
    );
    return uris
      .filter((uri) => {
        const relativePath = normalizeRelativeWorkspacePath(
          vscode.workspace.asRelativePath(uri, false)
        );
        return !shouldSkipProjectFile(relativePath)
          && (!requestedPath
            || agentPathMatches(relativePath, requestedPath)
            || agentPathStartsWith(relativePath, requestedPath));
      })
      .sort((left, right) => vscode.workspace.asRelativePath(left, false).localeCompare(
        vscode.workspace.asRelativePath(right, false)
      ))
      .slice(0, MAX_PROJECT_CANDIDATES);
  }

  /**
   * Inspect each path segment because a relative path can still leave the workspace through a symbolic link.
   * Missing segments are allowed only when the caller is preparing a new path.
   */
  private async assertNoWorkspaceSymlink(
    folder: vscode.WorkspaceFolder,
    relativePath: string,
    allowMissing: boolean
  ): Promise<void> {
    const segments = relativePath.split('/').filter(Boolean);
    for (let index = 1; index <= segments.length; index += 1) {
      const uri = vscode.Uri.joinPath(folder.uri, ...segments.slice(0, index));
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
          throw new Error(`DevMate will not use the symbolic-link path ${segments.slice(0, index).join('/')}.`);
        }
      } catch (error) {
        if (allowMissing && error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
          return;
        }
        throw error;
      }
    }
  }

  postAgentToolActivity(
    id: string,
    title: string,
    detail: string,
    status: 'running' | 'completed' | 'error',
    result?: string,
    canOpenTerminal = false
  ): void {
    this.events.postMessage({
      command: 'agentToolActivity',
      activity: { id, title, detail, status, result, canOpenTerminal }
    });
  }

  /** Expose tools according to mode, Workspace Trust and remaining budgets; execution still performs its own checks. */
  enabledAgentTools(
    mode: AssistantMode,
    fileMutationCalls: number,
    commandCalls: number,
    dependencyInstallCalls: number,
    limits?: { maxFileEdits: number; maxCommands: number; enabledTools: AgentToolName[] }
  ): AgentToolName[] {
    const tools: AgentToolName[] = [...READ_ONLY_AGENT_TOOL_NAMES];
    const enabled = (available: AgentToolName[]) => limits
      ? available.filter(name => limits.enabledTools.includes(name)) : available;
    if (mode === 'ideas' || !vscode.workspace.isTrusted) {
      return enabled(tools);
    }
    if (fileMutationCalls < (limits?.maxFileEdits ?? MAX_AGENT_FILE_MUTATIONS)) {
      tools.push(...FILE_MUTATION_AGENT_TOOL_NAMES);
    }
    if (dependencyInstallCalls < MAX_AGENT_DEPENDENCY_INSTALLS) {
      tools.push('install_dependencies');
    }
    if (commandCalls < (limits?.maxCommands ?? MAX_AGENT_COMMAND_CALLS)) {
      tools.push('run_command');
    }
    tools.push('stop_command');
    return enabled(tools);
  }

  rejectedToolExecution(call: AgentToolCall, result: string): AgentToolExecution {
    let historyArguments = boundedAgentToolHistoryArguments(call.name, call.arguments);
    try {
      historyArguments = summarizedAgentToolArguments(parseAgentToolCall(call));
    } catch {
      // Keep the provider's bounded raw arguments for an invalid call.
    }
    this.postAgentToolActivity(
      call.id,
      'Tool request rejected',
      call.name,
      'error',
      result
    );
    return {
      step: {
        callId: call.id,
        name: call.name,
        arguments: historyArguments,
        result,
        isError: true
      },
      usedFiles: [],
      mutationCharacters: 0
    };
  }

  /**
   * Capture create/update proposals, request permission when needed, then apply and save one WorkspaceEdit.
   * The returned text describes the outcome for both the model and the final change summary.
   */
  async confirmAndApplyFileChanges(
    changes: ValidatedFileChange[],
    summary: string,
    signal: AbortSignal,
    expectedOriginals?: ReadonlyMap<string, string>
  ): Promise<string> {
    if (this.undoInProgress) {
      throw new Error('Finish or cancel the Undo review before applying file changes.');
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('Open a workspace folder before applying file changes.');
    }
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before allowing DevMate to change files.');
    }

    const plannedChanges = await Promise.all(
      changes.map(async (change) => {
        await this.assertNoWorkspaceSymlink(folder, change.path, true);
        const uri = vscode.Uri.joinPath(folder.uri, ...change.path.split('/'));
        let exists = false;
        let originalContent = '';
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if ((stat.type & vscode.FileType.Directory) !== 0) {
            throw new Error(`${change.path} is a directory, not a file.`);
          }
          exists = true;
          const document = await vscode.workspace.openTextDocument(uri);
          if (document.isDirty) {
            throw new Error(`Save or discard your unsaved changes in ${change.path} before DevMate edits it.`);
          }
          originalContent = document.getText();
        } catch (error) {
          if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
            throw new Error(
              error instanceof Error
                ? `Could not inspect ${change.path}: ${error.message}`
                : `Could not inspect ${change.path}.`
            );
          }
        }
        if (expectedOriginals?.has(change.path) && expectedOriginals.get(change.path) !== originalContent) {
          throw new Error(`${change.path} changed before review. No changes were applied.`);
        }
        return { ...change, uri, exists, originalContent };
      })
    );
    const permissionFiles = plannedChanges.map((change) => ({
      path: change.path,
      operation: change.exists ? 'update' as const : 'create' as const,
      originalContent: change.originalContent,
      proposedContent: change.content
    }));
    const permissionPolicy = this.getPermissionPolicy();
    const requiresApproval = permissionFiles.some(
      (file) => permissionBehaviorForAction(permissionPolicy, file.operation) === 'ask'
    );
    if (requiresApproval) {
      this.events.postStatus('Waiting for permission');
      const allowed = await this.requestFileChangePermission(summary, permissionFiles);
      if (!allowed) {
        return 'Proposed file changes were not applied.';
      }
    }
    if (signal.aborted) {
      return 'Proposed file changes were not applied.';
    }
    if (!vscode.workspace.isTrusted) {
      throw new Error('Workspace Trust changed while permission was pending; the files were not changed.');
    }

    // The user may have edited or created files during review. Do not overwrite anything outside the approved snapshot.
    for (const change of plannedChanges) {
      await this.assertNoWorkspaceSymlink(folder, change.path, !change.exists);
      if (change.exists) {
        const document = await vscode.workspace.openTextDocument(change.uri);
        if (document.isDirty || document.getText() !== change.originalContent) {
          throw new Error(`${change.path} changed while permission was pending. Review the request again.`);
        }
      } else {
        try {
          await vscode.workspace.fs.stat(change.uri);
          throw new Error(`${change.path} was created while permission was pending. Review the request again.`);
        } catch (error) {
          if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
            throw error;
          }
        }
      }
    }

    this.events.postStatus('Applying file changes');
    for (const change of plannedChanges.filter((item) => !item.exists)) {
      const parentSegments = change.path.split('/').slice(0, -1);
      if (parentSegments.length > 0) {
        await vscode.workspace.fs.createDirectory(
          vscode.Uri.joinPath(folder.uri, ...parentSegments)
        );
      }
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const change of plannedChanges) {
      if (change.exists) {
        const document = await vscode.workspace.openTextDocument(change.uri);
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length)
        );
        workspaceEdit.replace(change.uri, fullRange, change.content);
      } else {
        workspaceEdit.createFile(change.uri, { ignoreIfExists: false, overwrite: false });
        workspaceEdit.insert(change.uri, new vscode.Position(0, 0), change.content);
      }
    }

    const undoBefore = await this.captureUndoBefore(folder, plannedChanges.map(change => change.path));
    if (signal.aborted) {
      await this.queueUndo(() => this.persistRequestUndo());
      return 'Proposed file changes were not applied.';
    }
    try {
      const applied = await vscode.workspace.applyEdit(workspaceEdit);
      if (!applied) {
        throw new Error('VS Code could not apply the proposed workspace edit.');
      }

      const saved = await Promise.all(plannedChanges.map(async (change) => {
        const document = await vscode.workspace.openTextDocument(change.uri);
        return document.save();
      }));
      if (saved.some((didSave) => !didSave)) {
        throw new Error('DevMate applied the changes, but VS Code could not save every file.');
      }
    } finally {
      await this.captureUndoAfter(folder, undoBefore);
    }
    for (const change of plannedChanges) {
      this.rememberCompletedFileDiff(
        change.path,
        change.originalContent,
        change.content
      );
    }

    let openNote = '';
    try {
      const primaryDocument = await vscode.workspace.openTextDocument(plannedChanges[0].uri);
      await vscode.window.showTextDocument(primaryDocument, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
        preserveFocus: false
      });
    } catch {
      openNote = '\n\nThe changes were applied, but VS Code could not open the first file.';
    }

    return [
      'Applied file changes:',
      ...plannedChanges.map((change) => `- ${change.exists ? 'Updated' : 'Created'} ${change.path}`)
    ].join('\n') + openNote;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeRelativeWorkspacePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function agentPathMatches(left: string, right: string): boolean {
  return comparableWorkspacePath(left) === comparableWorkspacePath(right);
}

function agentPathStartsWith(filePath: string, directoryPath: string): boolean {
  return comparableWorkspacePath(filePath).startsWith(
    `${comparableWorkspacePath(directoryPath)}/`
  );
}

function comparableWorkspacePath(value: string): string {
  return process.platform === 'win32' ? value.toLocaleLowerCase() : value;
}

function isDocumentSymbol(
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation
): symbol is vscode.DocumentSymbol {
  return 'selectionRange' in symbol && Array.isArray(symbol.children);
}

function codeLocationFromProvider(
  location: vscode.Location | vscode.LocationLink
): { uri: vscode.Uri; range: vscode.Range } | undefined {
  if ('targetUri' in location) {
    return {
      uri: location.targetUri,
      range: location.targetSelectionRange ?? location.targetRange
    };
  }
  if ('uri' in location) {
    return { uri: location.uri, range: location.range };
  }
  return undefined;
}

function formatSymbolResult(
  kind: vscode.SymbolKind,
  name: string,
  filePath: string,
  position: vscode.Position,
  container?: string
): string {
  const kindLabel = vscode.SymbolKind[kind] ?? 'Symbol';
  const safeName = boundedCodeNavigationText(name, 160) || '(unnamed)';
  const safeContainer = boundedCodeNavigationText(container, 160);
  return `[${kindLabel}] ${safeName}${safeContainer ? ` · ${safeContainer}` : ''} — `
    + `${filePath}:${position.line + 1}:${position.character + 1}`;
}

function boundedCodeNavigationText(value: unknown, maximum: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum)
    : '';
}

function describeAgentToolCall(call: ParsedAgentToolCall): { title: string; detail: string } {
  if (call.name === 'get_project_info') return { title: 'Reading project setup', detail: call.arguments.path || 'Project root' };
  if (call.name === 'get_git_changes') return { title: 'Reading Git changes', detail: call.arguments.path || (call.arguments.staged ? 'Staged changes' : 'Working tree') };
  if (call.name === 'rename_symbol') return { title: 'Renaming symbol', detail: `${call.arguments.path}:${call.arguments.line} → ${call.arguments.newName}` };
  if (call.name === 'format_file') return { title: 'Formatting file', detail: call.arguments.path };
  if (call.name === 'stop_command') return { title: 'Stopping command', detail: call.arguments.id };
  if (call.name === 'list_files') {
    return {
      title: 'Listing project files',
      detail: call.arguments.path || 'Project root'
    };
  }
  if (call.name === 'read_file') {
    return {
      title: 'Reading file',
      detail: call.arguments.path
    };
  }
  if (call.name === 'get_diagnostics') {
    return {
      title: 'Reading workspace diagnostics',
      detail: call.arguments.path || 'All workspace Problems'
    };
  }
  if (call.name === 'get_symbols') {
    return {
      title: 'Reading file symbols',
      detail: call.arguments.path
    };
  }
  if (call.name === 'find_definition') {
    return {
      title: 'Finding definition',
      detail: `${call.arguments.path}:${call.arguments.line}:${call.arguments.column}`
    };
  }
  if (call.name === 'find_references') {
    return {
      title: 'Finding references',
      detail: `${call.arguments.path}:${call.arguments.line}:${call.arguments.column}`
    };
  }
  if (call.name === 'read_terminal_errors') {
    return {
      title: 'Reading recent terminal errors',
      detail: `Up to ${call.arguments.maxResults} failed commands`
    };
  }
  if (call.name === 'create_file') {
    return {
      title: 'Creating file',
      detail: call.arguments.path
    };
  }
  if (call.name === 'edit_file') {
    return {
      title: 'Editing file',
      detail: call.arguments.path
    };
  }
  if (call.name === 'delete_file') {
    return {
      title: 'Deleting file',
      detail: call.arguments.path
    };
  }
  if (call.name === 'rename_file') {
    return {
      title: 'Renaming file',
      detail: `${call.arguments.path} → ${call.arguments.newPath}`
    };
  }
  if (call.name === 'move_file') {
    return {
      title: 'Moving file',
      detail: `${call.arguments.path} → ${call.arguments.newPath}`
    };
  }
  if (call.name === 'install_dependencies') {
    return {
      title: 'Installing Python dependencies',
      detail: call.arguments.manifestPath
    };
  }
  if (call.name === 'run_command') {
    return {
      title: call.arguments.background ? 'Starting local command' : 'Running project command',
      detail: call.arguments.executable
    };
  }
  return {
    title: 'Searching code',
    detail: `"${call.arguments.query}"${call.arguments.path ? ` in ${call.arguments.path}` : ''}`
  };
}
