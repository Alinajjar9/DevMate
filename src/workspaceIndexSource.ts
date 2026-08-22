import * as vscode from 'vscode';
import {
  MAX_RELATIVE_PATH_CHARACTERS,
  MAX_WORKSPACE_ROOT_CHARACTERS
} from './api/types';
import {
  knowledgeIndexWorkspaceKey
} from './indexSynchronization';
import type {
  WorkspaceIndexSnapshot,
  WorkspaceIndexSource,
  WorkspaceIndexSourceFile
} from './indexSynchronization';
import {
  languageIdForPath,
  MAX_PROJECT_FILE_BYTES,
  MAX_PROJECT_INDEX_FILES,
  PROJECT_EXCLUDE_GLOB,
  shouldSkipProjectFile
} from './projectIndex';
import { normalizeRelativeWorkspacePath } from './workspaceContext';

export class VsCodeWorkspaceIndexSource implements WorkspaceIndexSource {
  async scan(signal: AbortSignal): Promise<WorkspaceIndexSnapshot | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') {
      return undefined;
    }
    const rootPath = folder.uri.fsPath;
    if (!rootPath || rootPath.length > MAX_WORKSPACE_ROOT_CHARACTERS) {
      return undefined;
    }

    assertNotCancelled(signal);
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*'),
      PROJECT_EXCLUDE_GLOB,
      MAX_PROJECT_INDEX_FILES
    );
    const files: WorkspaceIndexSourceFile[] = [];
    const unavailablePaths: string[] = [];
    const safeDirectories = new Set<string>();

    for (const uri of [...uris].sort((left, right) =>
      vscode.workspace.asRelativePath(left, false).localeCompare(
        vscode.workspace.asRelativePath(right, false)
      )
    )) {
      assertNotCancelled(signal);
      const relativePath = normalizeRelativeWorkspacePath(
        vscode.workspace.asRelativePath(uri, false)
      );
      if (!isSafeRelativePath(relativePath) || shouldSkipProjectFile(relativePath)) {
        continue;
      }

      let stat: vscode.FileStat;
      try {
        const parentsSafe = await hasSafeParentDirectories(
          folder,
          relativePath,
          safeDirectories
        );
        if (!parentsSafe) {
          continue;
        }
        stat = await vscode.workspace.fs.stat(uri);
      } catch {
        unavailablePaths.push(relativePath);
        continue;
      }
      if ((stat.type & vscode.FileType.File) === 0
        || (stat.type & vscode.FileType.SymbolicLink) !== 0
        || stat.size > MAX_PROJECT_FILE_BYTES) {
        continue;
      }

      files.push({
        relativePath,
        languageId: languageIdForPath(relativePath),
        read: async (readSignal) => {
          assertNotCancelled(readSignal);
          if (!await hasSafeParentDirectories(folder, relativePath, new Set())) {
            throw new Error(`${relativePath} is behind a symbolic-link directory.`);
          }
          const bytes = await vscode.workspace.fs.readFile(uri);
          const currentStat = await vscode.workspace.fs.stat(uri);
          const parentsRemainSafe = await hasSafeParentDirectories(
            folder,
            relativePath,
            new Set()
          );
          assertNotCancelled(readSignal);
          if (!parentsRemainSafe
            || (currentStat.type & vscode.FileType.File) === 0
            || (currentStat.type & vscode.FileType.SymbolicLink) !== 0
            || currentStat.size > MAX_PROJECT_FILE_BYTES
            || currentStat.size !== bytes.byteLength) {
            throw new Error(`${relativePath} changed while it was being indexed.`);
          }
          return {
            bytes,
            sizeBytes: currentStat.size,
            modifiedAt: Math.max(0, Math.trunc(currentStat.mtime))
          };
        }
      });
    }

    return {
      workspaceKey: knowledgeIndexWorkspaceKey(folder.uri.toString(true)),
      rootPath,
      files,
      unavailablePaths: [...new Set(unavailablePaths)].sort()
    };
  }
}

function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath
    || relativePath.length > MAX_RELATIVE_PATH_CHARACTERS
    || relativePath.startsWith('/')
    || /[\u0000-\u001f\u007f]/.test(relativePath)) {
    return false;
  }
  const segments = relativePath.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

async function hasSafeParentDirectories(
  folder: vscode.WorkspaceFolder,
  relativePath: string,
  safeDirectories: Set<string>
): Promise<boolean> {
  const segments = relativePath.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    const directoryPath = segments.slice(0, index).join('/');
    if (safeDirectories.has(directoryPath)) {
      continue;
    }
    const stat = await vscode.workspace.fs.stat(
      vscode.Uri.joinPath(folder.uri, ...segments.slice(0, index))
    );
    if ((stat.type & vscode.FileType.Directory) === 0
      || (stat.type & vscode.FileType.SymbolicLink) !== 0) {
      return false;
    }
    safeDirectories.add(directoryPath);
  }
  return true;
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error('The workspace scan was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}
