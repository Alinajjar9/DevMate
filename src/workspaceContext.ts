import * as path from 'path';
import * as vscode from 'vscode';
import type { AskContextItem, AskScope } from './api/types';
import { knowledgeIndexWorkspaceKey } from './indexSynchronization';
import {
  containsBinaryData,
  createBoundedContextItem,
  createEmptyProjectIndex,
  createIndexedProjectFile,
  languageIdForPath,
  MAX_ATTACHED_FILES,
  MAX_PROJECT_CANDIDATES,
  MAX_PROJECT_CONTEXT_CHARACTERS,
  MAX_PROJECT_FILE_BYTES,
  MAX_PROJECT_FILE_CHARACTERS,
  MAX_PROJECT_FILES,
  MAX_PROJECT_INDEX_FILES,
  parseStoredProjectIndex,
  PROJECT_EXCLUDE_GLOB,
  PROJECT_INDEX_FILE_NAME,
  selectProjectContext,
  shouldSkipProjectFile
} from './projectIndex';
import type {
  ProjectFileCandidate,
  ProjectIndex,
  RetrievedProjectChunk
} from './projectIndex';
import { LexicalProjectRetriever } from './projectRetriever';
import type { ProjectRetriever } from './projectRetriever';
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

export class WorkspaceContext {
  private projectIndexCache?: ProjectIndex;

  constructor(
    private readonly storageDirectory: vscode.Uri | undefined,
    private readonly reportStatus: (text: string) => void = () => undefined,
    private readonly projectRetriever: ProjectRetriever = new LexicalProjectRetriever()
  ) {}

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

  async collectScope(
    scope: ScopeKind,
    question?: string,
    attachments: Iterable<vscode.Uri> = [],
    signal?: AbortSignal
  ): Promise<CollectedScope | undefined> {
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
            attachments,
            MAX_PROJECT_FILES,
            MAX_PROJECT_CONTEXT_CHARACTERS
          )
        : [];
      const items = question
        ? await this.collectProjectItems(folder, question, attachmentItems, signal)
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

    const contextItem = createBoundedContextItem(
      source,
      filePath,
      editor.document.languageId,
      content
    );
    const size = formatContextSize(
      contextItem.includedCharacters,
      contextItem.totalCharacters,
      contextItem.truncated
    );

    const attachmentItems = question
      ? await this.collectAttachmentItems(
          attachments,
          MAX_ATTACHED_FILES,
          MAX_PROJECT_CONTEXT_CHARACTERS - contextItem.includedCharacters,
          new Set([contextItem.filePath])
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

  async readProjectCandidate(uri: vscode.Uri): Promise<ProjectFileCandidate | undefined> {
    const relativePath = vscode.workspace.asRelativePath(uri, false);
    if (shouldSkipProjectFile(relativePath)) {
      return undefined;
    }

    try {
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

  private async collectProjectItems(
    folder: vscode.WorkspaceFolder,
    question: string,
    attachmentItems: AskContextItem[],
    signal?: AbortSignal
  ): Promise<AskScope['items']> {
    const includedAttachmentCharacters = attachmentItems.reduce(
      (total, item) => total + item.includedCharacters,
      0
    );
    if (
      attachmentItems.length >= MAX_PROJECT_FILES
      || includedAttachmentCharacters >= MAX_PROJECT_CONTEXT_CHARACTERS
    ) {
      return attachmentItems;
    }

    const remainingFiles = MAX_PROJECT_FILES - attachmentItems.length;
    const remainingCharacters = MAX_PROJECT_CONTEXT_CHARACTERS - includedAttachmentCharacters;
    const attachedPaths = new Set(attachmentItems.map((item) => item.filePath));

    try {
      let refreshPromise: ReturnType<WorkspaceContext['refreshProjectIndex']> | undefined;
      const loadFallbackIndex = async (): Promise<ProjectIndex> => {
        this.reportStatus('Refreshing fallback project index');
        refreshPromise ??= this.refreshProjectIndex(folder);
        const refresh = await refreshPromise;
        this.reportStatus(refresh.changedFiles > 0 || refresh.removedFiles > 0
          ? `Indexed ${formatFileCount(refresh.index.files.length)}`
          : 'Searching fallback project index');
        return refresh.index;
      };
      this.reportStatus('Searching project index');
      const workspacePath = folder.uri.scheme === 'file'
        ? folder.uri.fsPath
        : folder.uri.toString();
      const chunks = await this.projectRetriever.retrieve({
        loadIndex: loadFallbackIndex,
        workspaceKey: folder.uri.scheme === 'file'
          ? knowledgeIndexWorkspaceKey(folder.uri.toString(true))
          : undefined,
        workspacePath,
        question,
        limits: {
          maxChunks: remainingFiles,
          maxCharacters: Math.max(0, remainingCharacters - remainingFiles * 64),
          excludedFilePaths: attachedPaths
        },
        signal
      });
      const retrievedItems = this.createRetrievedProjectItems(chunks, remainingCharacters);
      if (retrievedItems.length > 0) {
        this.reportStatus(`Retrieved ${formatExcerptCount(retrievedItems.length)}`);
        return [...attachmentItems, ...retrievedItems];
      }
      this.reportStatus('Using project context fallback');
    } catch {
      if (signal?.aborted) {
        return attachmentItems;
      }
      this.reportStatus('Project index unavailable — using fallback');
    }

    if (signal?.aborted) {
      return attachmentItems;
    }

    return this.collectRankedProjectItems(
      folder,
      question,
      attachmentItems,
      remainingFiles,
      remainingCharacters
    );
  }

  private async collectRankedProjectItems(
    folder: vscode.WorkspaceFolder,
    question: string,
    attachmentItems: AskContextItem[],
    remainingFiles: number,
    remainingCharacters: number
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
      const batch = uris.slice(offset, offset + batchSize);
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
          const stat = await vscode.workspace.fs.stat(uri);
          if ((stat.type & vscode.FileType.File) === 0 || stat.size > MAX_PROJECT_FILE_BYTES) {
            return undefined;
          }
          const existing = existingFiles.get(relativePath);
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
    if (!storageUri || !this.storageDirectory) {
      return;
    }
    await vscode.workspace.fs.createDirectory(this.storageDirectory);
    await vscode.workspace.fs.writeFile(
      storageUri,
      new TextEncoder().encode(JSON.stringify(index))
    );
  }

  private projectIndexStorageUri(): vscode.Uri | undefined {
    return this.storageDirectory
      ? vscode.Uri.joinPath(this.storageDirectory, PROJECT_INDEX_FILE_NAME)
      : undefined;
  }

  private async collectAttachmentItems(
    attachments: Iterable<vscode.Uri>,
    maxFiles: number,
    maxCharacters: number,
    excludedFilePaths: Set<string> = new Set()
  ): Promise<AskContextItem[]> {
    const items: AskContextItem[] = [];
    let remainingCharacters = Math.max(0, maxCharacters);
    const currentFolder = vscode.workspace.workspaceFolders?.[0];
    if (!currentFolder) {
      return items;
    }

    for (const uri of attachments) {
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
}

export function normalizeRelativeWorkspacePath(value: string): string {
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
