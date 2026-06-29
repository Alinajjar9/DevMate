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
exports.activate = activate;
exports.deactivate = deactivate;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const client_1 = require("./api/client");
const context_1 = require("./context");
const projectContext_1 = require("./projectContext");
function activate(context) {
    const chatPanel = new DevMateChatPanel(context.extensionUri);
    const openChatCommand = vscode.commands.registerCommand('devMate.openChat', () => {
        chatPanel.show();
    });
    const statusBarItem = vscode.window.createStatusBarItem('devMate.statusBar', vscode.StatusBarAlignment.Right, 1000);
    statusBarItem.text = '$(comment-discussion) DevMate';
    statusBarItem.tooltip = 'Open DevMate';
    statusBarItem.command = 'devMate.openChat';
    statusBarItem.show();
    context.subscriptions.push(chatPanel, openChatCommand, statusBarItem);
}
function deactivate() {
    // No cleanup is needed for the current prototype.
}
class DevMateChatPanel {
    extensionUri;
    static viewType = 'devmate.chatPanel';
    panel;
    attachedFiles = new Map();
    panelDisposables = [];
    constructor(extensionUri) {
        this.extensionUri = extensionUri;
    }
    show() {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside);
            return;
        }
        const panel = vscode.window.createWebviewPanel(DevMateChatPanel.viewType, 'DevMate', {
            viewColumn: vscode.ViewColumn.Beside,
            preserveFocus: false
        }, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [this.extensionUri]
        });
        panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'devmate.svg');
        panel.webview.html = this.getHtml(panel.webview);
        this.panel = panel;
        this.panelDisposables.push(panel.webview.onDidReceiveMessage((message) => {
            void this.handleMessage(message);
        }), panel.onDidDispose(() => {
            this.panel = undefined;
            this.disposePanelDisposables();
        }));
        void this.checkBackendHealth();
    }
    dispose() {
        this.panel?.dispose();
        this.disposePanelDisposables();
    }
    disposePanelDisposables() {
        while (this.panelDisposables.length > 0) {
            this.panelDisposables.pop()?.dispose();
        }
    }
    async handleMessage(message) {
        switch (message.command) {
            case 'setScope':
                await this.updateScope(message.scope);
                return;
            case 'ask':
                await this.answerQuestion(message);
                return;
            case 'pickFiles':
                await this.pickWorkspaceFiles();
                return;
            case 'removeAttachment':
                this.attachedFiles.delete(message.id);
                this.postAttachmentState();
                return;
            case 'ready':
                this.postAttachmentState();
                return;
            default:
                this.postStatus('Unsupported command received.', 'error');
        }
    }
    async updateScope(scope) {
        this.postStatus('Collecting context');
        const collectedScope = await this.collectScope(scope);
        if (!collectedScope) {
            this.postStatus(scope === 'selection' ? 'Select code first.' : 'Open a file first.', 'warning');
            return;
        }
        this.postMessage({ command: 'scopeUpdated', scope: collectedScope.info });
        this.postStatus('Ready');
    }
    async collectScope(scope, question) {
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
                ? await this.collectAttachmentItems(projectContext_1.MAX_PROJECT_FILES, projectContext_1.MAX_PROJECT_CONTEXT_CHARACTERS)
                : [];
            const items = question
                ? await this.collectProjectItems(folder, question, attachmentItems)
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
        const contextItem = (0, context_1.createBoundedContextItem)(source, filePath, editor.document.languageId, content);
        const size = formatContextSize(contextItem.includedCharacters, contextItem.totalCharacters, contextItem.truncated);
        const attachmentItems = question
            ? await this.collectAttachmentItems(projectContext_1.MAX_ATTACHED_FILES, projectContext_1.MAX_PROJECT_CONTEXT_CHARACTERS - contextItem.includedCharacters, new Set([contextItem.filePath]))
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
    async collectProjectItems(folder, question, attachmentItems) {
        const includedAttachmentCharacters = attachmentItems.reduce((total, item) => total + item.includedCharacters, 0);
        if (attachmentItems.length >= projectContext_1.MAX_PROJECT_FILES
            || includedAttachmentCharacters >= projectContext_1.MAX_PROJECT_CONTEXT_CHARACTERS) {
            return attachmentItems;
        }
        let uris;
        try {
            uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), projectContext_1.PROJECT_EXCLUDE_GLOB, projectContext_1.MAX_PROJECT_CANDIDATES);
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
        const discoveredItems = (0, projectContext_1.selectProjectContext)(discoveryCandidates, question, {
            maxFiles: projectContext_1.MAX_PROJECT_FILES - attachmentItems.length,
            maxCharacters: projectContext_1.MAX_PROJECT_CONTEXT_CHARACTERS - includedAttachmentCharacters
        });
        return [...attachmentItems, ...discoveredItems];
    }
    async collectAttachmentItems(maxFiles, maxCharacters, excludedFilePaths = new Set()) {
        const items = [];
        let remainingCharacters = Math.max(0, maxCharacters);
        const currentFolder = vscode.workspace.workspaceFolders?.[0];
        if (!currentFolder) {
            return items;
        }
        for (const uri of this.attachedFiles.values()) {
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
            const item = (0, context_1.createBoundedContextItem)('attachment', candidate.filePath, candidate.languageId, candidate.content, Math.min(projectContext_1.MAX_PROJECT_FILE_CHARACTERS, remainingCharacters));
            items.push(item);
            remainingCharacters -= item.includedCharacters;
        }
        return items;
    }
    async pickWorkspaceFiles() {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            this.postStatus('Open a folder before attaching files.', 'warning');
            return;
        }
        this.postStatus('Finding workspace files');
        let uris;
        try {
            uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), projectContext_1.PROJECT_EXCLUDE_GLOB, projectContext_1.MAX_ATTACHMENT_CANDIDATES);
        }
        catch {
            this.postStatus('Could not list files from the open folder.', 'error');
            return;
        }
        const choices = uris
            .map((uri) => {
            const id = vscode.workspace.asRelativePath(uri, false);
            return {
                id,
                uri,
                label: id,
                picked: this.attachedFiles.has(id)
            };
        })
            .filter((item) => !(0, projectContext_1.shouldSkipProjectFile)(item.id))
            .sort((left, right) => left.label.localeCompare(right.label));
        if (choices.length === 0) {
            this.postStatus('No attachable text files were found in the open folder.', 'warning');
            return;
        }
        const selected = await vscode.window.showQuickPick(choices, {
            canPickMany: true,
            matchOnDescription: true,
            placeHolder: `Select up to ${projectContext_1.MAX_ATTACHED_FILES} files from ${folder.name}`,
            title: 'DevMate: Attach workspace files'
        });
        if (!selected) {
            this.postStatus('Ready');
            return;
        }
        if (selected.length > projectContext_1.MAX_ATTACHED_FILES) {
            this.postStatus(`Attach at most ${projectContext_1.MAX_ATTACHED_FILES} files.`, 'warning');
            return;
        }
        const validated = await Promise.all(selected.map(async (item) => ({
            item,
            candidate: await this.readProjectCandidate(item.uri)
        })));
        this.attachedFiles.clear();
        for (const { item, candidate } of validated) {
            if (candidate) {
                this.attachedFiles.set(item.id, item.uri);
            }
        }
        this.postAttachmentState();
        const ignoredCount = validated.filter(({ candidate }) => !candidate).length;
        if (ignoredCount > 0) {
            this.postStatus(`${ignoredCount} unsupported or oversized file(s) were ignored.`, 'warning');
            return;
        }
        this.postStatus('Ready');
    }
    postAttachmentState() {
        const attachments = [...this.attachedFiles.keys()].map((id) => ({
            id,
            label: id
        }));
        this.postMessage({ command: 'attachmentsUpdated', attachments });
    }
    async readProjectCandidate(uri) {
        const relativePath = vscode.workspace.asRelativePath(uri, false);
        if ((0, projectContext_1.shouldSkipProjectFile)(relativePath)) {
            return undefined;
        }
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if ((stat.type & vscode.FileType.File) === 0 || stat.size > projectContext_1.MAX_PROJECT_FILE_BYTES) {
                return undefined;
            }
            const bytes = await vscode.workspace.fs.readFile(uri);
            if ((0, projectContext_1.containsBinaryData)(bytes)) {
                return undefined;
            }
            return {
                filePath: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
                relativePath,
                languageId: (0, projectContext_1.languageIdForPath)(relativePath),
                content: new TextDecoder('utf-8').decode(bytes)
            };
        }
        catch {
            return undefined;
        }
    }
    async checkBackendHealth() {
        const result = await (0, client_1.health)(getBackendUrl());
        if (result.status === 'error') {
            this.postStatus(result.message ?? 'Backend unavailable.', 'warning');
        }
    }
    async answerQuestion(message) {
        const question = message.question.trim();
        if (!question) {
            this.postStatus('Enter a question before asking.', 'warning');
            return;
        }
        this.postStatus('Collecting context');
        const collectedScope = await this.collectScope(message.scope.kind, question);
        if (!collectedScope) {
            this.postStatus(message.scope.kind === 'selection' ? 'Select code first.' : 'Open a file first.', 'warning');
            return;
        }
        this.postMessage({ command: 'scopeUpdated', scope: collectedScope.info });
        await wait(250);
        this.postStatus('Generating answer');
        await wait(350);
        const config = vscode.workspace.getConfiguration('devMate');
        const provider = config.get('provider', 'openai');
        const model = config.get('model', 'gpt-4.1-mini');
        const maxTokens = config.get('maxTokens', 1200);
        const temperature = config.get('temperature', 0.2);
        const request = {
            question,
            mode: message.mode,
            scope: collectedScope.apiScope,
            settings: {
                provider,
                model,
                maxTokens,
                temperature
            }
        };
        const result = await (0, client_1.ask)(getBackendUrl(), request);
        if (result.status === 'error' || !result.data) {
            this.postStatus(result.message ?? 'Ask request failed.', 'error');
            return;
        }
        this.postMessage({
            command: 'assistantResponse',
            response: formatAskResponse(result.data.answer, result.data.usedFiles)
        });
        this.postStatus('Ready');
    }
    postStatus(text, level = 'info') {
        this.postMessage({ command: 'status', text, level });
    }
    postMessage(message) {
        this.panel?.webview.postMessage(message);
    }
    getHtml(webview) {
        const nonce = createNonce();
        const cspSource = webview.cspSource;
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>DevMate</title>
  <style>
    :root {
      color-scheme: light dark;
      --border: var(--vscode-panel-border);
      --muted: var(--vscode-descriptionForeground);
      --surface: var(--vscode-editor-background);
      --surface-soft: var(--vscode-sideBar-background);
      --focus: var(--vscode-focusBorder);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 0;
      color: var(--vscode-foreground);
      background: var(--surface);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    button,
    textarea {
      font: inherit;
    }

    .app {
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      height: 100vh;
      min-height: 0;
    }

    .toolbar {
      display: grid;
      gap: 8px;
      padding: 10px 10px 8px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }

    .mode-tabs {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
      align-items: center;
    }

    .scope-tabs {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      align-items: center;
    }

    .mode-button,
    .scope-button,
    .attachment-row-remove,
    .action-button {
      border: 1px solid transparent;
      cursor: pointer;
    }

    .mode-button {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 36px;
      border-color: var(--border);
      border-radius: 6px;
      color: var(--vscode-foreground);
      background: var(--vscode-input-background);
      font-size: 12px;
      font-weight: 600;
      overflow: hidden;
    }

    .mode-button[aria-pressed="true"],
    .action-button.primary {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-color: var(--vscode-button-background);
    }

    .mode-button[aria-pressed="true"]::after {
      position: absolute;
      left: 8px;
      right: 8px;
      bottom: 5px;
      height: 2px;
      border-radius: 999px;
      background: currentColor;
      content: "";
      opacity: 0.85;
    }

    .scope-button {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      justify-content: center;
      height: 24px;
      padding: 0 10px;
      border-color: var(--border);
      border-radius: 999px;
      color: var(--muted);
      background: transparent;
      font-size: 11px;
      white-space: nowrap;
    }

    .scope-button[aria-pressed="true"] {
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      border-color: transparent;
    }

    .action-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 30px;
      padding: 0 14px;
      border-radius: 4px;
    }

    .action-button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border-color: var(--border);
    }

    .action-button:hover,
    .mode-button:hover,
    .scope-button:hover {
      filter: brightness(1.08);
    }

    .status {
      min-height: 28px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--border);
      color: var(--muted);
    }

    .status[hidden] {
      display: none;
    }

    .status.warning {
      color: var(--vscode-editorWarning-foreground);
    }

    .status.error {
      color: var(--vscode-editorError-foreground);
    }

    .scope-bar {
      display: grid;
      gap: 6px;
      align-items: start;
    }

    .scope-row {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      justify-content: space-between;
      flex-wrap: wrap;
    }

    .scope-tools {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-left: auto;
    }

    .scope-action {
      color: var(--vscode-foreground);
      background: var(--vscode-input-background);
    }

    .scope-action[aria-expanded="true"] {
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      border-color: transparent;
    }

    .scope-action[hidden] {
      display: none;
    }

    .scope-meta {
      color: var(--muted);
      line-height: 1.35;
      overflow-wrap: anywhere;
      font-size: 11px;
    }

    .scope-meta:empty {
      display: none;
    }

    .ask-panel {
      display: grid;
      gap: 10px;
      align-items: start;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
    }

    .attachment-panel {
      display: grid;
      gap: 8px;
      padding: 8px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-soft);
    }

    .attachment-panel[hidden] {
      display: none;
    }

    .attachment-panel-title {
      color: var(--muted);
      font-size: 11px;
    }

    .attachment-list {
      display: grid;
      gap: 6px;
    }

    .attachment-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 8px 9px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface);
    }

    .attachment-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-foreground);
      font-size: 11px;
    }

    .attachment-row-remove {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 22px;
      padding: 0 8px;
      border-radius: 999px;
      color: var(--muted);
      background: transparent;
      font-size: 11px;
    }

    .attachment-row-remove:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
    }

    .messages {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: 0;
      padding: 10px;
      overflow-y: auto;
    }

    .message {
      width: 100%;
      padding: 9px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface-soft);
      white-space: pre-wrap;
      line-height: 1.45;
    }

    .message.user {
      background: var(--vscode-input-background);
    }

    .composer {
      display: grid;
      gap: 8px;
      align-self: end;
      padding: 10px;
      border-top: 1px solid var(--border);
      background: var(--surface-soft);
    }

    textarea {
      width: 100%;
      height: 86px;
      min-height: 86px;
      max-height: 86px;
      resize: none;
      padding: 0;
      border: 0;
      border-radius: 4px;
      color: var(--vscode-input-foreground);
      background: transparent;
    }

    textarea:focus,
    button:focus-visible {
      outline: 1px solid var(--focus);
      outline-offset: 2px;
    }

    .composer-actions {
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: flex-end;
      flex-wrap: wrap;
    }

    .composer-actions-spacer {
      flex: 1 1 auto;
    }
  </style>
</head>
<body>
  <main class="app">
    <header class="toolbar">
      <div class="mode-tabs" role="group" aria-label="Assistant mode">
        <button class="mode-button" type="button" data-mode="ideas" aria-pressed="true">Ideas</button>
        <button class="mode-button" type="button" data-mode="code" aria-pressed="false">Code</button>
        <button class="mode-button" type="button" data-mode="debug" aria-pressed="false">Debug</button>
      </div>
    </header>

    <section id="status" class="status" aria-live="polite" hidden></section>

    <section id="messages" class="messages" aria-label="Chat messages"></section>

    <section class="composer" aria-label="Message composer">
      <div class="ask-panel">
        <div class="scope-bar" aria-label="Context scope">
          <div class="scope-row">
            <div class="scope-tabs" role="group" aria-label="Working scope">
              <button class="scope-button" type="button" data-scope="project" aria-pressed="true">Project</button>
              <button class="scope-button" type="button" data-scope="activeFile" aria-pressed="false">File</button>
              <button class="scope-button" type="button" data-scope="selection" aria-pressed="false">Selection</button>
            </div>
            <div class="scope-tools">
              <button id="attachFiles" class="scope-button scope-action" type="button">Add files</button>
              <button
                id="toggleAttachments"
                class="scope-button scope-action"
                type="button"
                aria-expanded="false"
                hidden
              ></button>
            </div>
          </div>
          <div id="scopeDetail" class="scope-meta"></div>
        </div>
        <div id="attachmentPanel" class="attachment-panel" hidden>
          <span class="attachment-panel-title">Selected files</span>
          <div id="attachmentList" class="attachment-list" aria-label="Attached workspace files"></div>
        </div>
        <textarea id="question" placeholder="Ask DevMate..."></textarea>
        <div class="composer-actions">
          <span class="composer-actions-spacer"></span>
          <button id="ask" class="action-button primary" type="button">Ask</button>
        </div>
      </div>
    </section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = {
      mode: 'ideas',
      scope: {
        kind: 'project',
        label: 'Project',
        detail: ''
      },
      attachments: [],
      attachmentsExpanded: false
    };

    const statusEl = document.getElementById('status');
    const messagesEl = document.getElementById('messages');
    const questionEl = document.getElementById('question');
    const scopeDetailEl = document.getElementById('scopeDetail');
    const attachmentPanelEl = document.getElementById('attachmentPanel');
    const attachmentListEl = document.getElementById('attachmentList');
    const attachmentToggleEl = document.getElementById('toggleAttachments');

    document.querySelectorAll('.mode-button').forEach((button) => {
      button.addEventListener('click', () => {
        state.mode = button.dataset.mode;
        document.querySelectorAll('.mode-button').forEach((candidate) => {
          candidate.setAttribute('aria-pressed', String(candidate === button));
        });
      });
    });

    document.querySelectorAll('.scope-button[data-scope]').forEach((button) => {
      button.addEventListener('click', () => {
        vscode.postMessage({
          command: 'setScope',
          scope: button.dataset.scope
        });
      });
    });

    document.getElementById('ask').addEventListener('click', () => {
      const question = questionEl.value.trim();
      if (!question) {
        setStatus('Enter a question before asking.', 'warning');
        questionEl.focus();
        return;
      }

      appendMessage(question, 'user');
      vscode.postMessage({
        command: 'ask',
        mode: state.mode,
        question,
        scope: state.scope
      });
    });

    document.getElementById('attachFiles').addEventListener('click', () => {
      vscode.postMessage({ command: 'pickFiles' });
    });

    attachmentToggleEl.addEventListener('click', () => {
      state.attachmentsExpanded = !state.attachmentsExpanded;
      renderAttachments();
    });

    window.addEventListener('message', (event) => {
      const message = event.data;

      if (message.command === 'status') {
        setStatus(message.text, message.level);
      }

      if (message.command === 'scopeUpdated') {
        state.scope = message.scope;
        renderScope();
      }

      if (message.command === 'assistantResponse') {
        appendMessage(message.response, 'assistant');
      }

      if (message.command === 'attachmentsUpdated') {
        const hadAttachments = state.attachments.length > 0;
        state.attachments = message.attachments;
        if (state.attachments.length === 0) {
          state.attachmentsExpanded = false;
        } else if (!hadAttachments) {
          state.attachmentsExpanded = true;
        }
        renderAttachments();
      }
    });

    vscode.postMessage({ command: 'setScope', scope: 'project' });
    vscode.postMessage({ command: 'ready' });

    function setStatus(text, level = 'info') {
      if (text === 'Ready' && level === 'info') {
        statusEl.hidden = true;
        statusEl.textContent = '';
        return;
      }

      statusEl.hidden = false;
      statusEl.textContent = text;
      statusEl.className = 'status ' + level;
    }

    function appendMessage(text, role) {
      const item = document.createElement('article');
      item.className = 'message ' + role;
      item.textContent = text;
      messagesEl.appendChild(item);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function renderScope() {
      scopeDetailEl.textContent = state.scope.detail;

      document.querySelectorAll('.scope-button[data-scope]').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.scope === state.scope.kind));
      });
    }

    function renderAttachments() {
      const attachmentCount = state.attachments.length;
      const summaryText = attachmentCount === 1
        ? '1 file selected'
        : attachmentCount + ' files selected';

      attachmentToggleEl.hidden = attachmentCount === 0;
      attachmentToggleEl.textContent = summaryText;
      attachmentToggleEl.title = state.attachmentsExpanded
        ? 'Hide selected files'
        : 'Show selected files';
      attachmentToggleEl.setAttribute('aria-expanded', String(state.attachmentsExpanded));
      attachmentPanelEl.hidden = attachmentCount === 0 || !state.attachmentsExpanded;
      attachmentListEl.replaceChildren();

      state.attachments.forEach((attachment) => {
        const item = document.createElement('div');
        item.className = 'attachment-item';

        const label = document.createElement('span');
        label.className = 'attachment-label';
        label.textContent = attachment.label;
        item.appendChild(label);

        const remove = document.createElement('button');
        remove.className = 'attachment-row-remove';
        remove.type = 'button';
        remove.title = 'Remove ' + attachment.label;
        remove.setAttribute('aria-label', 'Remove ' + attachment.label);
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => {
          vscode.postMessage({ command: 'removeAttachment', id: attachment.id });
        });
        item.appendChild(remove);
        attachmentListEl.appendChild(item);
      });
    }
  </script>
</body>
</html>`;
    }
}
function createNonce() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let index = 0; index < 32; index += 1) {
        nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return nonce;
}
function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function getBackendUrl() {
    return vscode.workspace
        .getConfiguration('devMate')
        .get('backendUrl', 'http://127.0.0.1:8000')
        .trim();
}
function formatAskResponse(answer, usedFiles) {
    if (usedFiles.length === 0) {
        return answer;
    }
    return [
        answer,
        '',
        'Used files:',
        ...usedFiles.map((file) => `- ${file}`)
    ].join('\n');
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
//# sourceMappingURL=extension.js.map