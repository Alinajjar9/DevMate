// Keep source snapshots for native diff editors and reviewed changes.
// Virtual diff documents show snapshots rather than rereading a file that may have changed.

import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

export const DIFF_DOCUMENT_SCHEME = 'devmate-diff';

export type FileDiffInput = {
  path: string;
  originalContent: string;
  proposedContent: string;
};

type FileDiff = {
  path: string;
  originalUri: vscode.Uri;
  proposedUri: vscode.Uri;
};

type CompletedFileDiff = FileDiff & {
  id: string;
  previousPath?: string;
};

type PendingPermissionDiffs = {
  requestId: string;
  diffs: Map<string, FileDiff>;
};

// VS Code reads these virtual documents when it opens a native diff editor.
export class DiffPresenter implements
  vscode.TextDocumentContentProvider,
  vscode.Disposable {
  private readonly documents = new Map<string, string>();
  private readonly completedDiffs = new Map<string, CompletedFileDiff>();
  private readonly activeRequestDiffs = new Map<string, string>();
  private pendingPermissionDiffs?: PendingPermissionDiffs;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.toString()) ?? '';
  }

  rememberPendingFileDiffs(requestId: string, files: FileDiffInput[]): void {
    this.clearPendingFileDiffs();
    const diffs = new Map<string, FileDiff>();
    for (const file of files) {
      const { originalUri, proposedUri } = this.createUris(
        requestId,
        'original',
        'proposed',
        file.path
      );
      this.documents.set(originalUri.toString(), file.originalContent);
      this.documents.set(proposedUri.toString(), file.proposedContent);
      diffs.set(file.path, { path: file.path, originalUri, proposedUri });
    }
    this.pendingPermissionDiffs = { requestId, diffs };
  }

  async openPendingFileDiff(requestId: string, filePath: string): Promise<boolean> {
    const pending = this.pendingPermissionDiffs;
    const diff = pending?.requestId === requestId
      ? pending.diffs.get(filePath)
      : undefined;
    if (!diff) {
      return false;
    }
    await this.openDiff(diff, `DevMate: ${diff.path}`);
    return true;
  }

  clearPendingFileDiffs(requestId?: string): void {
    const pending = this.pendingPermissionDiffs;
    if (!pending || (requestId && pending.requestId !== requestId)) {
      return;
    }
    this.removeDocuments(pending.diffs.values());
    this.pendingPermissionDiffs = undefined;
  }

  rememberCompletedFileDiff(
    filePath: string,
    originalContent: string,
    proposedContent: string,
    previousPath?: string
  ): string {
    const id = randomUUID();
    const { originalUri, proposedUri } = this.createUris(
      `completed/${id}`,
      'before',
      'after',
      filePath
    );
    this.documents.set(originalUri.toString(), originalContent);
    this.documents.set(proposedUri.toString(), proposedContent);
    this.completedDiffs.set(id, {
      id,
      path: filePath,
      ...(previousPath ? { previousPath } : {}),
      originalUri,
      proposedUri
    });
    this.activeRequestDiffs.set(fileChangePathKey(filePath), id);
    this.removeOldCompletedDiffs();
    return id;
  }

  async openCompletedFileDiff(diffId: string): Promise<boolean> {
    const diff = this.completedDiffs.get(diffId);
    if (!diff) {
      return false;
    }
    const title = diff.previousPath
      ? `${diff.previousPath} → ${diff.path} (DevMate changes)`
      : `${diff.path} (DevMate changes)`;
    await this.openDiff(diff, title);
    return true;
  }

  completedDiffId(filePath: string): string | undefined {
    return this.activeRequestDiffs.get(fileChangePathKey(filePath));
  }

  beginRequest(): void {
    this.activeRequestDiffs.clear();
  }

  dispose(): void {
    this.documents.clear();
    this.completedDiffs.clear();
    this.activeRequestDiffs.clear();
    this.pendingPermissionDiffs = undefined;
  }

  private createUris(
    prefix: string,
    originalPart: string,
    proposedPart: string,
    filePath: string
  ): { originalUri: vscode.Uri; proposedUri: vscode.Uri } {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    return {
      originalUri: vscode.Uri.parse(
        `${DIFF_DOCUMENT_SCHEME}:/${prefix}/${originalPart}/${encodedPath}`
      ),
      proposedUri: vscode.Uri.parse(
        `${DIFF_DOCUMENT_SCHEME}:/${prefix}/${proposedPart}/${encodedPath}`
      )
    };
  }

  private async openDiff(diff: FileDiff, title: string): Promise<void> {
    await vscode.commands.executeCommand(
      'vscode.diff',
      diff.originalUri,
      diff.proposedUri,
      title,
      { preview: true }
    );
  }

  private removeDocuments(diffs: Iterable<FileDiff>): void {
    for (const diff of diffs) {
      this.documents.delete(diff.originalUri.toString());
      this.documents.delete(diff.proposedUri.toString());
    }
  }

  private removeOldCompletedDiffs(): void {
    while (this.completedDiffs.size > 40) {
      const oldestId = this.completedDiffs.keys().next().value as string | undefined;
      if (!oldestId) {
        return;
      }
      const oldest = this.completedDiffs.get(oldestId);
      if (oldest) {
        this.removeDocuments([oldest]);
      }
      this.completedDiffs.delete(oldestId);
      for (const [pathKey, diffId] of this.activeRequestDiffs) {
        if (diffId === oldestId) {
          this.activeRequestDiffs.delete(pathKey);
        }
      }
    }
  }
}

function fileChangePathKey(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}
