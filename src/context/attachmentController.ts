// Manage the files explicitly attached to a chat and the native file picker.
// Check each candidate against workspace rules and attachment limits.

import * as vscode from 'vscode';
import {
  MAX_ATTACHMENT_CANDIDATES,
  MAX_ATTACHED_FILES,
  PROJECT_EXCLUDE_GLOB,
  shouldSkipProjectFile
} from '../projectSearch/projectIndex';

export type AttachmentInfo = {
  id: string;
  label: string;
};

export interface AttachmentControllerCallbacks {
  isProjectCandidate(uri: vscode.Uri): Promise<boolean>;
  reportStatus(text: string, level?: 'info' | 'warning' | 'error'): void;
  attachmentsChanged(attachments: AttachmentInfo[]): void;
}

type WorkspaceFilePickItem = vscode.QuickPickItem & {
  id: string;
  uri: vscode.Uri;
};

// This controller keeps the selected files and owns the native VS Code file picker.
export class AttachmentController {
  private readonly attachedFiles = new Map<string, vscode.Uri>();

  constructor(private readonly callbacks: AttachmentControllerCallbacks) {}

  uris(): vscode.Uri[] {
    return [...this.attachedFiles.values()];
  }

  state(): AttachmentInfo[] {
    return [...this.attachedFiles.keys()].map((id) => ({ id, label: id }));
  }

  postState(): void {
    this.callbacks.attachmentsChanged(this.state());
  }

  remove(id: string): void {
    this.attachedFiles.delete(id);
    this.postState();
  }

  async pickWorkspaceFiles(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.callbacks.reportStatus('Open a folder before attaching files.', 'warning');
      return;
    }

    this.callbacks.reportStatus('Finding workspace files');
    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*'),
        PROJECT_EXCLUDE_GLOB,
        MAX_ATTACHMENT_CANDIDATES
      );
    } catch {
      this.callbacks.reportStatus('Could not list files from the open folder.', 'error');
      return;
    }

    const choices = uris
      .map((uri): WorkspaceFilePickItem => {
        const id = vscode.workspace.asRelativePath(uri, false);
        return {
          id,
          uri,
          label: id,
          picked: this.attachedFiles.has(id)
        };
      })
      .filter((item) => !shouldSkipProjectFile(item.id))
      .sort((left, right) => left.label.localeCompare(right.label));

    if (choices.length === 0) {
      this.callbacks.reportStatus(
        'No attachable text files were found in the open folder.',
        'warning'
      );
      return;
    }

    const selected = await vscode.window.showQuickPick<WorkspaceFilePickItem>(choices, {
      canPickMany: true,
      matchOnDescription: true,
      placeHolder: `Select up to ${MAX_ATTACHED_FILES} files from ${folder.name}`,
      title: 'DevMate: Attach workspace files'
    });
    if (!selected) {
      this.callbacks.reportStatus('Ready');
      return;
    }
    if (selected.length > MAX_ATTACHED_FILES) {
      this.callbacks.reportStatus(`Attach at most ${MAX_ATTACHED_FILES} files.`, 'warning');
      return;
    }

    const validated = await Promise.all(
      selected.map(async (item) => ({
        item,
        accepted: await this.callbacks.isProjectCandidate(item.uri)
      }))
    );
    this.attachedFiles.clear();
    for (const { item, accepted } of validated) {
      if (accepted) {
        this.attachedFiles.set(item.id, item.uri);
      }
    }
    this.postState();

    const ignoredCount = validated.filter(({ accepted }) => !accepted).length;
    if (ignoredCount > 0) {
      this.callbacks.reportStatus(
        `${ignoredCount} unsupported or oversized file(s) were ignored.`,
        'warning'
      );
      return;
    }
    this.callbacks.reportStatus('Ready');
  }
}
