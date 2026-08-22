import * as vscode from 'vscode';
import {
  MAX_RELATIVE_PATH_CHARACTERS,
  MAX_WORKSPACE_ROOT_CHARACTERS
} from './api/types';
import {
  knowledgeIndexWorkspaceKey
} from './indexSynchronization';
import type {
  WorkspaceIndexFileRead,
  WorkspaceIndexSnapshot,
  WorkspaceIndexSource,
  WorkspaceIndexSourceFile
} from './indexSynchronization';
import { MAX_PROJECT_SYMBOL_RANGES } from './projectChunking';
import type { ProjectSymbolRange } from './projectChunking';
import {
  containsBinaryData,
  languageIdForPath,
  MAX_PROJECT_FILE_BYTES,
  MAX_PROJECT_INDEX_FILES,
  PROJECT_EXCLUDE_GLOB,
  shouldSkipProjectFile
} from './projectIndex';
import { normalizeRelativeWorkspacePath } from './workspaceContext';

export type CurrentWorkspaceIndexFile = {
  filePath: string;
  relativePath: string;
  languageId: string;
  content: string;
};

export class VsCodeWorkspaceIndexSource implements WorkspaceIndexSource {
  async readCurrentFile(
    relativePath: string,
    signal?: AbortSignal
  ): Promise<CurrentWorkspaceIndexFile | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const normalizedPath = normalizeRelativeWorkspacePath(relativePath);
    if (!folder
      || folder.uri.scheme !== 'file'
      || !isSafeRelativePath(normalizedPath)
      || shouldSkipProjectFile(normalizedPath)) {
      return undefined;
    }
    const readSignal = signal ?? new AbortController().signal;
    try {
      const uri = vscode.Uri.joinPath(folder.uri, ...normalizedPath.split('/'));
      const read = await readValidatedWorkspaceFile(
        folder,
        uri,
        normalizedPath,
        readSignal
      );
      if (containsBinaryData(read.bytes)) {
        return undefined;
      }
      return {
        filePath: uri.fsPath,
        relativePath: normalizedPath,
        languageId: languageIdForPath(normalizedPath),
        content: new TextDecoder('utf-8').decode(read.bytes)
      };
    } catch (error) {
      assertNotCancelled(readSignal);
      return undefined;
    }
  }

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
        read: (readSignal) => readValidatedWorkspaceFile(
          folder,
          uri,
          relativePath,
          readSignal
        ),
        readSymbolRanges: (expectedFile, readSignal) => readDocumentSymbolRanges(
          folder,
          uri,
          relativePath,
          expectedFile,
          readSignal
        )
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

async function readValidatedWorkspaceFile(
  folder: vscode.WorkspaceFolder,
  uri: vscode.Uri,
  relativePath: string,
  signal: AbortSignal
): Promise<WorkspaceIndexFileRead> {
  assertNotCancelled(signal);
  if (!await hasSafeParentDirectories(folder, relativePath, new Set())) {
    throw new Error(`${relativePath} is behind a symbolic-link directory.`);
  }
  const initialStat = await vscode.workspace.fs.stat(uri);
  if ((initialStat.type & vscode.FileType.File) === 0
    || (initialStat.type & vscode.FileType.SymbolicLink) !== 0
    || initialStat.size > MAX_PROJECT_FILE_BYTES) {
    throw new Error(`${relativePath} is not a safe indexable file.`);
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  const currentStat = await vscode.workspace.fs.stat(uri);
  const parentsRemainSafe = await hasSafeParentDirectories(
    folder,
    relativePath,
    new Set()
  );
  assertNotCancelled(signal);
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

async function readDocumentSymbolRanges(
  folder: vscode.WorkspaceFolder,
  uri: vscode.Uri,
  relativePath: string,
  expectedFile: WorkspaceIndexFileRead,
  signal: AbortSignal
): Promise<ProjectSymbolRange[] | undefined> {
  assertNotCancelled(signal);
  try {
    if (!await hasSafeParentDirectories(folder, relativePath, new Set())) {
      return undefined;
    }
    const stat = await vscode.workspace.fs.stat(uri);
    if (!matchesExpectedFile(stat, expectedFile)) {
      return undefined;
    }
    const provided = await vscode.commands.executeCommand<
      Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined
    >('vscode.executeDocumentSymbolProvider', uri);
    assertNotCancelled(signal);
    const currentBytes = await vscode.workspace.fs.readFile(uri);
    const currentStat = await vscode.workspace.fs.stat(uri);
    if (!await hasSafeParentDirectories(folder, relativePath, new Set())
      || !matchesExpectedFile(currentStat, expectedFile)
      || !sameBytes(currentBytes, expectedFile.bytes)) {
      return undefined;
    }
    return collectDocumentSymbolRanges(uri, provided);
  } catch (error) {
    assertNotCancelled(signal);
    return undefined;
  }
}

function matchesExpectedFile(
  stat: vscode.FileStat,
  expectedFile: WorkspaceIndexFileRead
): boolean {
  return (stat.type & vscode.FileType.File) !== 0
    && (stat.type & vscode.FileType.SymbolicLink) === 0
    && stat.size <= MAX_PROJECT_FILE_BYTES
    && stat.size === expectedFile.sizeBytes
    && Math.max(0, Math.trunc(stat.mtime)) === expectedFile.modifiedAt;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function collectDocumentSymbolRanges(
  uri: vscode.Uri,
  provided: Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined
): ProjectSymbolRange[] | undefined {
  if (!Array.isArray(provided)) {
    return undefined;
  }
  const ranges: ProjectSymbolRange[] = [];
  let exceededLimit = false;
  const visit = (symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>): void => {
    for (const symbol of symbols) {
      if (ranges.length >= MAX_PROJECT_SYMBOL_RANGES) {
        exceededLimit = true;
        return;
      }
      if (isDocumentSymbol(symbol)) {
        ranges.push(projectSymbolRange(symbol.range));
        visit(symbol.children);
      } else if (sameUri(symbol.location.uri, uri)) {
        ranges.push(projectSymbolRange(symbol.location.range));
      }
    }
  };
  visit(provided);
  return ranges.length > 0 && !exceededLimit ? ranges : undefined;
}

function isDocumentSymbol(
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation
): symbol is vscode.DocumentSymbol {
  return 'selectionRange' in symbol && Array.isArray(symbol.children);
}

function projectSymbolRange(range: vscode.Range): ProjectSymbolRange {
  return {
    start: {
      line: range.start.line,
      character: range.start.character
    },
    end: {
      line: range.end.line,
      character: range.end.character
    }
  };
}

function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString(true) === right.toString(true);
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
