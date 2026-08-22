"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceContext = void 0;
exports.normalizeRelativeWorkspacePath = normalizeRelativeWorkspacePath;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const indexSynchronization_1 = require("./indexSynchronization");
const projectIndex_1 = require("./projectIndex");
const projectRetriever_1 = require("./projectRetriever");
class WorkspaceContext {
    storageDirectory;
    reportStatus;
    projectRetriever;
    projectIndexCache;
    constructor(storageDirectory, reportStatus = () => undefined, projectRetriever = new projectRetriever_1.LexicalProjectRetriever()) {
        this.storageDirectory = storageDirectory;
        this.reportStatus = reportStatus;
        this.projectRetriever = projectRetriever;
    }
    getConversationWorkspace() {
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
    async collectScope(scope, question, attachments = [], signal) {
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
                ? await this.collectAttachmentItems(attachments, projectIndex_1.MAX_PROJECT_FILES, projectIndex_1.MAX_PROJECT_CONTEXT_CHARACTERS)
                : [];
            const items = question
                ? await this.collectProjectItems(folder, question, attachmentItems, signal)
                : [];
            const includedCharacters = items.reduce((total, item) => total + item.includedCharacters, 0);
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
        const contextItem = (0, projectIndex_1.createBoundedContextItem)(source, filePath, editor.document.languageId, content);
        const size = formatContextSize(contextItem.includedCharacters, contextItem.totalCharacters, contextItem.truncated);
        const attachmentItems = question
            ? await this.collectAttachmentItems(attachments, projectIndex_1.MAX_ATTACHED_FILES, projectIndex_1.MAX_PROJECT_CONTEXT_CHARACTERS - contextItem.includedCharacters, new Set([contextItem.filePath]))
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
    async readProjectCandidate(uri) {
        const relativePath = vscode.workspace.asRelativePath(uri, false);
        if ((0, projectIndex_1.shouldSkipProjectFile)(relativePath)) {
            return undefined;
        }
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if ((stat.type & vscode.FileType.File) === 0 || stat.size > projectIndex_1.MAX_PROJECT_FILE_BYTES) {
                return undefined;
            }
            const bytes = await vscode.workspace.fs.readFile(uri);
            if ((0, projectIndex_1.containsBinaryData)(bytes)) {
                return undefined;
            }
            return {
                filePath: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
                relativePath,
                languageId: (0, projectIndex_1.languageIdForPath)(relativePath),
                content: new TextDecoder('utf-8').decode(bytes)
            };
        }
        catch {
            return undefined;
        }
    }
    async collectProjectItems(folder, question, attachmentItems, signal) {
        const includedAttachmentCharacters = attachmentItems.reduce((total, item) => total + item.includedCharacters, 0);
        if (attachmentItems.length >= projectIndex_1.MAX_PROJECT_FILES
            || includedAttachmentCharacters >= projectIndex_1.MAX_PROJECT_CONTEXT_CHARACTERS) {
            return attachmentItems;
        }
        const remainingFiles = projectIndex_1.MAX_PROJECT_FILES - attachmentItems.length;
        const remainingCharacters = projectIndex_1.MAX_PROJECT_CONTEXT_CHARACTERS - includedAttachmentCharacters;
        const attachedPaths = new Set(attachmentItems.map((item) => item.filePath));
        try {
            let refreshPromise;
            const loadFallbackIndex = async () => {
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
                    ? (0, indexSynchronization_1.knowledgeIndexWorkspaceKey)(folder.uri.toString(true))
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
        }
        catch {
            if (signal?.aborted) {
                return attachmentItems;
            }
            this.reportStatus('Project index unavailable — using fallback');
        }
        if (signal?.aborted) {
            return attachmentItems;
        }
        return this.collectRankedProjectItems(folder, question, attachmentItems, remainingFiles, remainingCharacters);
    }
    async collectRankedProjectItems(folder, question, attachmentItems, remainingFiles, remainingCharacters) {
        let uris;
        try {
            uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), projectIndex_1.PROJECT_EXCLUDE_GLOB, projectIndex_1.MAX_PROJECT_CANDIDATES);
        }
        catch {
            return attachmentItems;
        }
        const candidates = [];
        const batchSize = 20;
        for (let offset = 0; offset < uris.length; offset += batchSize) {
            const batch = uris.slice(offset, offset + batchSize);
            const batchCandidates = await Promise.all(batch.map((uri) => this.readProjectCandidate(uri)));
            for (const candidate of batchCandidates) {
                if (candidate) {
                    candidates.push(candidate);
                }
            }
        }
        const attachedPaths = new Set(attachmentItems.map((item) => item.filePath));
        const discoveryCandidates = candidates.filter((candidate) => !attachedPaths.has(candidate.filePath));
        const discoveredItems = (0, projectIndex_1.selectProjectContext)(discoveryCandidates, question, {
            maxFiles: remainingFiles,
            maxCharacters: remainingCharacters
        });
        return [...attachmentItems, ...discoveredItems];
    }
    createRetrievedProjectItems(chunks, maxCharacters) {
        const items = [];
        let remainingCharacters = Math.max(0, maxCharacters);
        for (const chunk of chunks) {
            if (items.length >= projectIndex_1.MAX_PROJECT_FILES || remainingCharacters <= 0) {
                break;
            }
            const lineLabel = chunk.startLine === chunk.endLine
                ? `line ${chunk.startLine}`
                : `lines ${chunk.startLine}-${chunk.endLine}`;
            const content = `[Local index excerpt: ${lineLabel}]\n${chunk.content}`;
            const item = (0, projectIndex_1.createBoundedContextItem)('file', chunk.filePath, chunk.languageId, content, Math.min(projectIndex_1.MAX_PROJECT_FILE_CHARACTERS, remainingCharacters));
            item.totalCharacters = Math.max(item.includedCharacters, chunk.totalCharacters);
            item.truncated = item.includedCharacters < item.totalCharacters;
            items.push(item);
            remainingCharacters -= item.includedCharacters;
        }
        return items;
    }
    async refreshProjectIndex(folder) {
        const workspacePath = folder.uri.scheme === 'file'
            ? folder.uri.fsPath
            : folder.uri.toString();
        const existingIndex = await this.loadProjectIndex(workspacePath);
        const existingFiles = new Map(existingIndex.files.map((file) => [normalizeRelativeWorkspacePath(file.relativePath), file]));
        const uris = (await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), projectIndex_1.PROJECT_EXCLUDE_GLOB, projectIndex_1.MAX_PROJECT_INDEX_FILES)).filter((uri) => !(0, projectIndex_1.shouldSkipProjectFile)(vscode.workspace.asRelativePath(uri, false)))
            .sort((left, right) => vscode.workspace.asRelativePath(left, false).localeCompare(vscode.workspace.asRelativePath(right, false)));
        const indexedFiles = [];
        let changedFiles = 0;
        const batchSize = 20;
        for (let offset = 0; offset < uris.length; offset += batchSize) {
            const batchFiles = await Promise.all(uris.slice(offset, offset + batchSize).map(async (uri) => {
                const relativePath = normalizeRelativeWorkspacePath(vscode.workspace.asRelativePath(uri, false));
                try {
                    const stat = await vscode.workspace.fs.stat(uri);
                    if ((stat.type & vscode.FileType.File) === 0 || stat.size > projectIndex_1.MAX_PROJECT_FILE_BYTES) {
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
                    return (0, projectIndex_1.createIndexedProjectFile)(candidate, stat.size, stat.mtime);
                }
                catch {
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
        const removedFiles = existingIndex.files.filter((file) => !indexedPaths.has(normalizeRelativeWorkspacePath(file.relativePath))).length;
        const index = {
            ...(0, projectIndex_1.createEmptyProjectIndex)(workspacePath),
            files: indexedFiles
        };
        this.projectIndexCache = index;
        if (changedFiles > 0 || removedFiles > 0 || existingIndex.files.length === 0) {
            try {
                await this.persistProjectIndex(index);
            }
            catch {
                // Retrieval can continue from memory when private workspace storage is unavailable.
            }
        }
        return { index, changedFiles, removedFiles };
    }
    async loadProjectIndex(workspacePath) {
        if (this.projectIndexCache?.workspacePath === workspacePath) {
            return this.projectIndexCache;
        }
        const emptyIndex = (0, projectIndex_1.createEmptyProjectIndex)(workspacePath);
        const storageUri = this.projectIndexStorageUri();
        if (!storageUri) {
            this.projectIndexCache = emptyIndex;
            return emptyIndex;
        }
        try {
            const bytes = await vscode.workspace.fs.readFile(storageUri);
            const parsed = (0, projectIndex_1.parseStoredProjectIndex)(JSON.parse(new TextDecoder('utf-8').decode(bytes)), workspacePath);
            this.projectIndexCache = parsed ?? emptyIndex;
        }
        catch {
            this.projectIndexCache = emptyIndex;
        }
        return this.projectIndexCache;
    }
    async persistProjectIndex(index) {
        const storageUri = this.projectIndexStorageUri();
        if (!storageUri || !this.storageDirectory) {
            return;
        }
        await vscode.workspace.fs.createDirectory(this.storageDirectory);
        await vscode.workspace.fs.writeFile(storageUri, new TextEncoder().encode(JSON.stringify(index)));
    }
    projectIndexStorageUri() {
        return this.storageDirectory
            ? vscode.Uri.joinPath(this.storageDirectory, projectIndex_1.PROJECT_INDEX_FILE_NAME)
            : undefined;
    }
    async collectAttachmentItems(attachments, maxFiles, maxCharacters, excludedFilePaths = new Set()) {
        const items = [];
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
            const item = (0, projectIndex_1.createBoundedContextItem)('attachment', candidate.filePath, candidate.languageId, candidate.content, Math.min(projectIndex_1.MAX_PROJECT_FILE_CHARACTERS, remainingCharacters));
            items.push(item);
            remainingCharacters -= item.includedCharacters;
        }
        return items;
    }
}
exports.WorkspaceContext = WorkspaceContext;
function normalizeRelativeWorkspacePath(value) {
    return value.replace(/\\/g, '/');
}
function formatContextSize(includedCharacters, totalCharacters, truncated) {
    if (truncated) {
        return `${includedCharacters} of ${totalCharacters} chars`;
    }
    return `${totalCharacters} chars`;
}
function formatFileCount(count) {
    return count === 1 ? '1 file' : `${count} files`;
}
function formatExcerptCount(count) {
    return count === 1 ? '1 relevant project excerpt' : `${count} relevant project excerpts`;
}
//# sourceMappingURL=workspaceContext.js.map