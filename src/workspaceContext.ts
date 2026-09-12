import * as path from 'path';
import * as vscode from 'vscode';
import { realpath } from 'fs/promises';
import { isContextExcluded } from './contextControls';
import type { ContextPreferences } from './contextControls';
import type {
  AskContextItem,
  AskScope
} from './api/types';
import type { ProjectFileCandidate, ProjectIndex, RetrievedProjectChunk } from './projectIndex';
import {
  containsBinaryData, createBoundedContextItem, createEmptyProjectIndex,
  createIndexedProjectFile, languageIdForPath, MAX_ATTACHED_FILES, MAX_ATTACHMENT_CANDIDATES, MAX_PROJECT_CANDIDATES,
  MAX_PROJECT_CONTEXT_CHARACTERS,
  MAX_PROJECT_FILE_BYTES,
  MAX_PROJECT_FILE_CHARACTERS,
  MAX_PROJECT_FILES, MAX_PROJECT_INDEX_FILES,
  parseStoredProjectIndex, PROJECT_EXCLUDE_GLOB, PROJECT_INDEX_FILE_NAME,
  retrieveProjectChunks, selectProjectContext,
  shouldSkipProjectFile
} from './projectIndex';
import type { ConversationWorkspace } from './sessions';

export type ScopeKind = 'project' | 'activeFile' | 'selection';

export type ScopeInfo = {
  kind: ScopeKind;
  label: string;
  detail: string;
};

export type CollectedScope = {
  info: ScopeInfo;
  apiScope: AskScope;
};
type AttachmentInfo = {
  id: string;
  label: string;
};

type WorkspaceFilePickItem = vscode.QuickPickItem & {
  id: string;
  uri: vscode.Uri;
};
export interface WorkspaceContextEvents {
  postMessage(message: unknown): void;
  postStatus(text: string, level?: 'info' | 'warning' | 'error'): void;
}

/** Collects bounded editor and disk context and maintains the lexical project index. */
export class WorkspaceContext {
  private readonly attachedFiles = new Map<string, vscode.Uri>();
  private projectIndexCache?: ProjectIndex;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly events: WorkspaceContextEvents
  ) {}

  removeAttachment(id: string): void {
    this.attachedFiles.delete(id);
    this.postAttachmentState();
  }
  getConversationWorkspace(): ConversationWorkspace | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }
    const rawId = folder.uri.toString(true);
    return {
      id: process.platform === 'win32' && folder.uri.scheme === 'file'
        ? rawId.toLocaleLowerCase('en-US')
        : rawId,
      name: folder.name
    };
  }

  /**
   * Build the selected project, file or selection context. With no question, only project metadata is collected.
   * Explicit attachments share the same character budget as the automatically selected code.
   */
  async collectScope(scope: ScopeKind, question?: string, preferences?: ContextPreferences): Promise<CollectedScope | undefined> {
    const options: ContextPreferences = preferences ?? { contextCharacters: MAX_PROJECT_CONTEXT_CHARACTERS, pinnedFiles: [], excludedPaths: [] };
    if (scope === 'project') {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        return {
          info: {
            kind: 'project',
            label: 'No folder',
            detail: ''
          },
          apiScope: {
            type: 'project',
            items: []
          }
        };
      }

      const attachmentItems = question
        ? await this.collectAttachmentItems(
          MAX_PROJECT_FILES,
          options.contextCharacters, new Set(), options
        )
        : [];
      const items = question
        ? await this.collectProjectItems(folder, question, attachmentItems, options)
        : [];
      const includedCharacters = items.reduce(
        (total, item) => total + item.includedCharacters,
        0
      );
      const detail = question
        ? `Project: ${folder.name} · ${formatFileCount(items.length)} · ${includedCharacters} chars`
        : `Project: ${folder.name}`;

      return {
        info: {
          kind: 'project',
          label: folder.name,
          detail
        },
        apiScope: {
          type: 'project',
          workspacePath: folder.uri.fsPath,
          items
        }
      };
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }

    const filePath = editor.document.uri.scheme === 'file'
      ? editor.document.uri.fsPath
      : editor.document.fileName;
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
    const fileName = path.basename(filePath);
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const source = scope === 'activeFile' ? 'file' : 'selection';
    const content = scope === 'activeFile'
      ? editor.document.getText()
      : editor.document.getText(editor.selection);

    if (scope === 'selection' && !content.trim()) {
      return undefined;
    }

    if (isContextExcluded(relativePath, options.excludedPaths)) {
      this.events.postStatus('This file is excluded from starting context. Change the context settings to include it.', 'warning');
      return undefined;
    }
    const contextItem = createBoundedContextItem(
      source,
      filePath,
      editor.document.languageId,
      content,
      Math.min(20_000, options.contextCharacters)
    );
    const size = formatContextSize(
      contextItem.includedCharacters,
      contextItem.totalCharacters,
      contextItem.truncated
    );

    const attachmentItems = question
      ? await this.collectAttachmentItems(
        MAX_ATTACHED_FILES,
        options.contextCharacters - contextItem.includedCharacters,
        new Set([contextItem.filePath]), options
      )
      : [];

    if (scope === 'activeFile') {
      return {
        info: {
          kind: 'activeFile',
          label: fileName,
          detail: `File: ${relativePath} · ${size}`
        },
        apiScope: {
          type: 'file',
          workspacePath,
          items: [contextItem, ...attachmentItems]
        }
      };
    }

    return {
      info: {
        kind: 'selection',
        label: `${fileName} selection`,
        detail: `Selection: ${size} from ${relativePath}`
      },
      apiScope: {
        type: 'selection',
        workspacePath,
        items: [contextItem, ...attachmentItems]
      }
    };
  }

  /**
   * Give attached files priority, then search the refreshed lexical index with the remaining budget.
   * If the index fails or returns no excerpts, use the simpler whole-file ranking as a fallback.
   */
  private async collectProjectItems(
    folder: vscode.WorkspaceFolder,
    question: string,
    attachmentItems: AskContextItem[],
    options: ContextPreferences
  ): Promise<AskScope['items']> {
    const includedAttachmentCharacters = attachmentItems.reduce(
      (total, item) => total + item.includedCharacters,
      0
    );
    if (
      attachmentItems.length >= MAX_PROJECT_FILES
      || includedAttachmentCharacters >= options.contextCharacters
    ) {
      return attachmentItems;
    }

    const remainingFiles = MAX_PROJECT_FILES - attachmentItems.length;
    const remainingCharacters = options.contextCharacters - includedAttachmentCharacters;
    const attachedPaths = new Set(attachmentItems.map((item) => item.filePath));

    try {
      this.events.postStatus('Refreshing project index');
      const refresh = await this.refreshProjectIndex(folder);
      this.events.postStatus(refresh.changedFiles > 0 || refresh.removedFiles > 0
        ? `Indexed ${formatFileCount(refresh.index.files.length)}`
        : 'Searching project index');
      const chunks = retrieveProjectChunks({ ...refresh.index, files: refresh.index.files.filter(file => !isContextExcluded(file.relativePath, options.excludedPaths)) }, question, {
        maxChunks: remainingFiles,
        maxCharacters: Math.max(0, remainingCharacters - remainingFiles * 64),
        excludedFilePaths: attachedPaths
      });
      const retrievedItems = this.createRetrievedProjectItems(chunks, remainingCharacters);
      if (retrievedItems.length > 0) {
        this.events.postStatus(`Retrieved ${formatExcerptCount(retrievedItems.length)}`);
        return [...attachmentItems, ...retrievedItems];
      }
      this.events.postStatus('Using project context fallback');
    } catch {
      this.events.postStatus('Project index unavailable — using fallback');
    }

    return this.collectRankedProjectItems(
      folder,
      question,
      attachmentItems,
      remainingFiles,
      remainingCharacters,
      options
    );
  }

  /** Read a bounded file sample in small batches and rank it by question words when indexed retrieval is unavailable. */
  private async collectRankedProjectItems(
    folder: vscode.WorkspaceFolder,
    question: string,
    attachmentItems: AskContextItem[],
    remainingFiles: number,
    remainingCharacters: number,
    options: ContextPreferences
  ): Promise<AskScope['items']> {
    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*'),
        PROJECT_EXCLUDE_GLOB,
        MAX_PROJECT_CANDIDATES
      );
    } catch {
      return attachmentItems;
    }

    const candidates: ProjectFileCandidate[] = [];
    const batchSize = 20;
    for (let offset = 0; offset < uris.length; offset += batchSize) {
      const batch = uris.slice(offset, offset + batchSize).filter(uri => !isContextExcluded(vscode.workspace.asRelativePath(uri, false), options.excludedPaths));
      const batchCandidates = await Promise.all(
        batch.map((uri) => this.readProjectCandidate(uri))
      );
      for (const candidate of batchCandidates) {
        if (candidate) {
          candidates.push(candidate);
        }
      }
    }

    const attachedPaths = new Set(attachmentItems.map((item) => item.filePath));
    const discoveryCandidates = candidates.filter(
      (candidate) => !attachedPaths.has(candidate.filePath)
    );
    const discoveredItems = selectProjectContext(discoveryCandidates, question, {
      maxFiles: remainingFiles,
      maxCharacters: remainingCharacters
    });

    return [...attachmentItems, ...discoveredItems];
  }

  private createRetrievedProjectItems(
    chunks: RetrievedProjectChunk[],
    maxCharacters: number
  ): AskContextItem[] {
    const items: AskContextItem[] = [];
    let remainingCharacters = Math.max(0, maxCharacters);
    for (const chunk of chunks) {
      if (items.length >= MAX_PROJECT_FILES || remainingCharacters <= 0) {
        break;
      }
      const lineLabel = chunk.startLine === chunk.endLine
        ? `line ${chunk.startLine}`
        : `lines ${chunk.startLine}-${chunk.endLine}`;
      const content = `[Local index excerpt: ${lineLabel}]\n${chunk.content}`;
      const item = createBoundedContextItem(
        'file',
        chunk.filePath,
        chunk.languageId,
        content,
        Math.min(MAX_PROJECT_FILE_CHARACTERS, remainingCharacters)
      );
      item.totalCharacters = Math.max(item.includedCharacters, chunk.totalCharacters);
      item.truncated = item.includedCharacters < item.totalCharacters;
      items.push(item);
      remainingCharacters -= item.includedCharacters;
    }
    return items;
  }

  /**
   * Refresh the JSON index before a project question, reusing files whose size and modification time match.
   * Removed and unreadable files drop out; saving the cache is optional for this request to succeed.
   */
  private async refreshProjectIndex(folder: vscode.WorkspaceFolder): Promise<{
    index: ProjectIndex;
    changedFiles: number;
    removedFiles: number;
  }> {
    const workspacePath = folder.uri.scheme === 'file'
      ? folder.uri.fsPath
      : folder.uri.toString();
    const existingIndex = await this.loadProjectIndex(workspacePath);
    const existingFiles = new Map(
      existingIndex.files.map((file) => [normalizeRelativeWorkspacePath(file.relativePath), file])
    );
    const uris = (await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*'),
      PROJECT_EXCLUDE_GLOB,
      MAX_PROJECT_INDEX_FILES
    )).filter((uri) => !shouldSkipProjectFile(vscode.workspace.asRelativePath(uri, false)))
      .sort((left, right) => vscode.workspace.asRelativePath(left, false).localeCompare(
        vscode.workspace.asRelativePath(right, false)
      ));

    const indexedFiles: ProjectIndex['files'] = [];
    let changedFiles = 0;
    const batchSize = 20;
    for (let offset = 0; offset < uris.length; offset += batchSize) {
      const batchFiles = await Promise.all(uris.slice(offset, offset + batchSize).map(async (uri) => {
        const relativePath = normalizeRelativeWorkspacePath(
          vscode.workspace.asRelativePath(uri, false)
        );
        try {
          if (!await this.isSafeProjectUri(uri)) return undefined;
          const stat = await vscode.workspace.fs.stat(uri);
          if ((stat.type & vscode.FileType.File) === 0 || stat.size > MAX_PROJECT_FILE_BYTES) {
            return undefined;
          }
          const existing = existingFiles.get(relativePath);
          // This is a metadata cache check, not content hashing, so unchanged files avoid another disk read.
          if (existing && existing.size === stat.size && existing.modifiedAt === stat.mtime) {
            return existing;
          }
          const candidate = await this.readProjectCandidate(uri);
          if (!candidate) {
            return undefined;
          }
          changedFiles += 1;
          return createIndexedProjectFile(candidate, stat.size, stat.mtime);
        } catch {
          return undefined;
        }
      }));
      for (const file of batchFiles) {
        if (file) {
          indexedFiles.push(file);
        }
      }
    }

    const indexedPaths = new Set(indexedFiles.map((file) => file.relativePath));
    const removedFiles = existingIndex.files.filter(
      (file) => !indexedPaths.has(normalizeRelativeWorkspacePath(file.relativePath))
    ).length;
    const index: ProjectIndex = {
      ...createEmptyProjectIndex(workspacePath),
      files: indexedFiles
    };
    this.projectIndexCache = index;
    if (changedFiles > 0 || removedFiles > 0 || existingIndex.files.length === 0) {
      try {
        await this.persistProjectIndex(index);
      } catch {
        // Retrieval can continue from memory when private workspace storage is unavailable.
      }
    }
    return { index, changedFiles, removedFiles };
  }

  private async loadProjectIndex(workspacePath: string): Promise<ProjectIndex> {
    if (this.projectIndexCache?.workspacePath === workspacePath) {
      return this.projectIndexCache;
    }
    const emptyIndex = createEmptyProjectIndex(workspacePath);
    const storageUri = this.projectIndexStorageUri();
    if (!storageUri) {
      this.projectIndexCache = emptyIndex;
      return emptyIndex;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(storageUri);
      const parsed = parseStoredProjectIndex(
        JSON.parse(new TextDecoder('utf-8').decode(bytes)) as unknown,
        workspacePath
      );
      this.projectIndexCache = parsed ?? emptyIndex;
    } catch {
      this.projectIndexCache = emptyIndex;
    }
    return this.projectIndexCache;
  }

  private async persistProjectIndex(index: ProjectIndex): Promise<void> {
    const storageUri = this.projectIndexStorageUri();
    const storageDirectory = this.extensionContext.storageUri;
    if (!storageUri || !storageDirectory) {
      return;
    }
    await vscode.workspace.fs.createDirectory(storageDirectory);
    await vscode.workspace.fs.writeFile(
      storageUri,
      new TextEncoder().encode(JSON.stringify(index))
    );
  }

  private projectIndexStorageUri(): vscode.Uri | undefined {
    const storageDirectory = this.extensionContext.storageUri;
    return storageDirectory
      ? vscode.Uri.joinPath(storageDirectory, PROJECT_INDEX_FILE_NAME)
      : undefined;
  }

  /** Read the current contents of chosen files and include each eligible attachment once within the shared budget. */
  private async collectAttachmentItems(
    maxFiles: number,
    maxCharacters: number,
    excludedFilePaths: Set<string> = new Set(),
    preferences?: ContextPreferences
  ): Promise<AskContextItem[]> {
    const items: AskContextItem[] = [];
    let remainingCharacters = Math.max(0, maxCharacters);
    const currentFolder = vscode.workspace.workspaceFolders?.[0];
    if (!currentFolder) {
      return items;
    }

    // Pinned files are reread for every request and take priority over automatic retrieval.
    const pinnedUris = (preferences?.pinnedFiles ?? []).map(file => vscode.Uri.joinPath(currentFolder.uri, file));
    const candidates = [...pinnedUris, ...this.attachedFiles.values()];
    const seen = new Set<string>();
    for (const uri of candidates) {
      const identity = uri.toString();
      if (seen.has(identity) || isContextExcluded(vscode.workspace.asRelativePath(uri, false), preferences?.excludedPaths ?? [])) { continue; }
      seen.add(identity);
      if (items.length >= maxFiles || remainingCharacters <= 0) {
        break;
      }

      const owningFolder = vscode.workspace.getWorkspaceFolder(uri);
      if (!owningFolder || owningFolder.uri.toString() !== currentFolder.uri.toString()) {
        continue;
      }

      const candidate = await this.readProjectCandidate(uri);
      if (!candidate || excludedFilePaths.has(candidate.filePath)) {
        continue;
      }

      const item = createBoundedContextItem(
        'attachment',
        candidate.filePath,
        candidate.languageId,
        candidate.content,
        Math.min(MAX_PROJECT_FILE_CHARACTERS, remainingCharacters)
      );
      items.push(item);
      remainingCharacters -= item.includedCharacters;
    }

    return items;
  }

  /** Offer eligible files from the first workspace folder and remember the selected URIs, not copies of their contents. */
  async pickWorkspaceFiles(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.events.postStatus('Open a folder before attaching files.', 'warning');
      return;
    }

    this.events.postStatus('Finding workspace files');
    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*'),
        PROJECT_EXCLUDE_GLOB,
        MAX_ATTACHMENT_CANDIDATES
      );
    } catch {
      this.events.postStatus('Could not list files from the open folder.', 'error');
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
      this.events.postStatus('No attachable text files were found in the open folder.', 'warning');
      return;
    }

    const selected = await vscode.window.showQuickPick<WorkspaceFilePickItem>(choices, {
      canPickMany: true,
      matchOnDescription: true,
      placeHolder: `Select up to ${MAX_ATTACHED_FILES} files from ${folder.name}`,
      title: 'DevMate: Attach workspace files'
    });
    if (!selected) {
      this.events.postStatus('Ready');
      return;
    }

    if (selected.length > MAX_ATTACHED_FILES) {
      this.events.postStatus(`Attach at most ${MAX_ATTACHED_FILES} files.`, 'warning');
      return;
    }

    const validated = await Promise.all(
      selected.map(async (item) => ({
        item,
        candidate: await this.readProjectCandidate(item.uri)
      }))
    );
    this.attachedFiles.clear();
    for (const { item, candidate } of validated) {
      if (candidate) {
        this.attachedFiles.set(item.id, item.uri);
      }
    }

    this.postAttachmentState();
    const ignoredCount = validated.filter(({ candidate }) => !candidate).length;
    if (ignoredCount > 0) {
      this.events.postStatus(`${ignoredCount} unsupported or oversized file(s) were ignored.`, 'warning');
      return;
    }
    this.events.postStatus('Ready');
  }

  postAttachmentState(): void {
    const attachments: AttachmentInfo[] = [...this.attachedFiles.keys()].map((id) => ({
      id,
      label: id
    }));
    this.events.postMessage({ command: 'attachmentsUpdated', attachments });
  }

  /** Read an eligible text file from disk, rejecting excluded paths, binary content and files over the byte limit. */
  async readProjectCandidate(uri: vscode.Uri): Promise<ProjectFileCandidate | undefined> {
    const relativePath = vscode.workspace.asRelativePath(uri, false);
    if (shouldSkipProjectFile(relativePath)) {
      return undefined;
    }

    try {
      if (!await this.isSafeProjectUri(uri)) return undefined;
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.File) === 0 || stat.size > MAX_PROJECT_FILE_BYTES) {
        return undefined;
      }

      const bytes = await vscode.workspace.fs.readFile(uri);
      if (containsBinaryData(bytes)) {
        return undefined;
      }

      return {
        filePath: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
        relativePath,
        languageId: languageIdForPath(relativePath),
        content: new TextDecoder('utf-8').decode(bytes)
      };
    } catch {
      return undefined;
    }
  }

  /** Do not let a pin or cached alias reveal a protected file through a symbolic link. */
  private async isSafeProjectUri(uri: vscode.Uri): Promise<boolean> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || uri.scheme !== folder.uri.scheme) return false;
    if (uri.scheme !== 'file') return vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === folder.uri.toString();
    try {
      const [rootPath, filePath] = await Promise.all([realpath(folder.uri.fsPath), realpath(uri.fsPath)]);
      const relative = path.relative(rootPath, filePath);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || shouldSkipProjectFile(relative)) return false;
      const expected = path.resolve(rootPath, path.relative(folder.uri.fsPath, uri.fsPath));
      return process.platform === 'win32' ? expected.toLowerCase() === filePath.toLowerCase() : expected === filePath;
    } catch { return false; }
  }
}

function normalizeRelativeWorkspacePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function formatContextSize(
  includedCharacters: number,
  totalCharacters: number,
  truncated: boolean
): string {
  if (truncated) {
    return `${includedCharacters} of ${totalCharacters} chars`;
  }

  return `${totalCharacters} chars`;
}

function formatFileCount(count: number): string {
  return count === 1 ? '1 file' : `${count} files`;
}

function formatExcerptCount(count: number): string {
  return count === 1 ? '1 relevant project excerpt' : `${count} relevant project excerpts`;
}
