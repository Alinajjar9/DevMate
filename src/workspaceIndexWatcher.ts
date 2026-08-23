import * as path from 'path';
import * as vscode from 'vscode';
import type {
  KnowledgeIndexAccess,
  KnowledgeIndexSynchronizationResult
} from './indexSynchronization';
import { shouldSkipProjectFile } from './projectSearch/projectIndex';

export const DEFAULT_WORKSPACE_INDEX_DEBOUNCE_MS = 750;

export interface WorkspaceIndexChangeSource extends vscode.Disposable {
  onDidChange(listener: () => void): vscode.Disposable;
}

export type WorkspaceIndexSynchronization = (
  access: KnowledgeIndexAccess,
  signal: AbortSignal
) => Promise<KnowledgeIndexSynchronizationResult>;

export type WorkspaceIndexTimer = {
  schedule(callback: () => void, delayMilliseconds: number): unknown;
  cancel(handle: unknown): void;
};

const defaultTimer: WorkspaceIndexTimer = {
  schedule: (callback, delayMilliseconds) => setTimeout(callback, delayMilliseconds),
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout)
};

export class WorkspaceIndexCoordinator implements vscode.Disposable {
  private readonly changeSubscription: vscode.Disposable;
  private backendAccess?: KnowledgeIndexAccess;
  private activeController?: AbortController;
  private debounceHandle?: unknown;
  private pending = false;
  private pendingImmediately = false;
  private disposed = false;

  constructor(
    private readonly changeSource: WorkspaceIndexChangeSource,
    private readonly synchronize: WorkspaceIndexSynchronization,
    private readonly debounceMilliseconds = DEFAULT_WORKSPACE_INDEX_DEBOUNCE_MS,
    private readonly timer: WorkspaceIndexTimer = defaultTimer
  ) {
    this.changeSubscription = changeSource.onDidChange(() => {
      this.requestSynchronization(false);
    });
  }

  setBackendAccess(access: KnowledgeIndexAccess | undefined): void {
    if (this.disposed) {
      return;
    }
    if (!access) {
      this.backendAccess = undefined;
      this.pending = false;
      this.pendingImmediately = false;
      this.clearDebounce();
      this.activeController?.abort();
      return;
    }

    const accessChanged = !sameAccess(this.backendAccess, access);
    this.backendAccess = { ...access };
    if (accessChanged) {
      this.activeController?.abort();
    }
    this.requestSynchronization(true);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.backendAccess = undefined;
    this.pending = false;
    this.pendingImmediately = false;
    this.clearDebounce();
    this.activeController?.abort();
    this.changeSubscription.dispose();
    this.changeSource.dispose();
  }

  private requestSynchronization(immediately: boolean): void {
    if (this.disposed || !this.backendAccess) {
      return;
    }
    this.pending = true;
    this.pendingImmediately ||= immediately;
    if (this.activeController) {
      return;
    }
    this.schedulePending();
  }

  private schedulePending(): void {
    if (this.disposed || !this.backendAccess || !this.pending) {
      return;
    }
    this.clearDebounce();
    if (this.pendingImmediately) {
      void this.runPending();
      return;
    }
    this.debounceHandle = this.timer.schedule(() => {
      this.debounceHandle = undefined;
      void this.runPending();
    }, Math.max(0, this.debounceMilliseconds));
  }

  private async runPending(): Promise<void> {
    if (this.disposed
      || !this.backendAccess
      || !this.pending
      || this.activeController) {
      return;
    }
    const access = { ...this.backendAccess };
    const controller = new AbortController();
    this.pending = false;
    this.pendingImmediately = false;
    this.activeController = controller;
    try {
      await this.synchronize(access, controller.signal);
    } finally {
      if (this.activeController === controller) {
        this.activeController = undefined;
      }
      this.schedulePending();
    }
  }

  private clearDebounce(): void {
    if (this.debounceHandle === undefined) {
      return;
    }
    this.timer.cancel(this.debounceHandle);
    this.debounceHandle = undefined;
  }
}

export class VsCodeWorkspaceIndexChangeSource implements WorkspaceIndexChangeSource {
  private readonly listeners = new Set<() => void>();
  private readonly workspaceFolderSubscription: vscode.Disposable;
  private readonly renameSubscription: vscode.Disposable;
  private watcher?: vscode.FileSystemWatcher;
  private watcherSubscriptions: vscode.Disposable[] = [];
  private disposed = false;

  constructor() {
    this.workspaceFolderSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.rebuildWatcher();
      this.emitChange();
    });
    this.renameSubscription = vscode.workspace.onDidRenameFiles((event) => {
      const folder = currentLocalWorkspaceFolder();
      if (folder && event.files.some((file) =>
        shouldWatchUri(folder, file.oldUri) || shouldWatchUri(folder, file.newUri)
      )) {
        this.emitChange();
      }
    });
    this.rebuildWatcher();
  }

  onDidChange(listener: () => void): vscode.Disposable {
    if (this.disposed) {
      return { dispose: () => undefined };
    }
    this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener)
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeWatcher();
    this.workspaceFolderSubscription.dispose();
    this.renameSubscription.dispose();
    this.listeners.clear();
  }

  private rebuildWatcher(): void {
    this.disposeWatcher();
    if (this.disposed) {
      return;
    }
    const folder = currentLocalWorkspaceFolder();
    if (!folder) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '**/*')
    );
    const handleUri = (uri: vscode.Uri): void => {
      if (shouldWatchUri(folder, uri)) {
        this.emitChange();
      }
    };
    this.watcher = watcher;
    this.watcherSubscriptions = [
      watcher.onDidCreate(handleUri),
      watcher.onDidChange(handleUri),
      watcher.onDidDelete(handleUri)
    ];
  }

  private disposeWatcher(): void {
    for (const subscription of this.watcherSubscriptions) {
      subscription.dispose();
    }
    this.watcherSubscriptions = [];
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function currentLocalWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.scheme === 'file' ? folder : undefined;
}

function shouldWatchUri(folder: vscode.WorkspaceFolder, uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file') {
    return false;
  }
  const relativePath = path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
  if (!relativePath) {
    return true;
  }
  if (path.isAbsolute(relativePath)
    || relativePath === '..'
    || relativePath.startsWith('../')) {
    return false;
  }
  return !shouldSkipProjectFile(relativePath);
}

function sameAccess(
  left: KnowledgeIndexAccess | undefined,
  right: KnowledgeIndexAccess
): boolean {
  return left?.backendUrl === right.backendUrl
    && left.backendToken === right.backendToken;
}
