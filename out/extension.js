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
function activate(context) {
    const chatProvider = new DevMateChatProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(DevMateChatProvider.viewType, chatProvider, {
        webviewOptions: {
            retainContextWhenHidden: true
        }
    }));
    const disposable = vscode.commands.registerCommand('devMate.openChat', async () => {
        await vscode.commands.executeCommand('workbench.view.extension.devmate');
        try {
            await vscode.commands.executeCommand('devmate.chatView.focus');
        }
        catch {
            // Opening the DevMate view container is enough if the generated view focus command is unavailable.
        }
    });
    context.subscriptions.push(disposable);
}
function deactivate() {
    // No cleanup is needed for the current prototype.
}
class DevMateChatProvider {
    extensionUri;
    static viewType = 'devmate.chatView';
    view;
    disposables = [];
    constructor(extensionUri) {
        this.extensionUri = extensionUri;
    }
    resolveWebviewView(webviewView) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };
        webviewView.webview.html = this.getHtml(webviewView.webview);
        webviewView.webview.onDidReceiveMessage((message) => this.handleMessage(message), null, this.disposables);
        void this.checkBackendHealth();
    }
    async handleMessage(message) {
        switch (message.command) {
            case 'setScope':
                await this.updateScope(message.scope);
                return;
            case 'ask':
                await this.answerPlaceholder(message);
                return;
            default:
                this.postStatus('Unsupported command received.', 'error');
        }
    }
    async updateScope(scope) {
        this.postStatus('Collecting context');
        const scopeInfo = this.createScopeInfo(scope);
        if (!scopeInfo) {
            this.postStatus(scope === 'selection' ? 'Select code first.' : 'Open a file first.', 'warning');
            return;
        }
        this.postMessage({ command: 'scopeUpdated', scope: scopeInfo });
        this.postStatus('Ready');
    }
    createScopeInfo(scope) {
        if (scope === 'project') {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) {
                return {
                    kind: 'project',
                    label: 'No folder',
                    detail: ''
                };
            }
            return {
                kind: 'project',
                label: folder.name,
                detail: `Project: ${folder.name}`
            };
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return undefined;
        }
        const filePath = editor.document.uri.fsPath;
        const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
        const fileName = path.basename(filePath);
        if (scope === 'activeFile') {
            return {
                kind: 'activeFile',
                label: fileName,
                fileName,
                filePath,
                detail: `File: ${relativePath}`
            };
        }
        const selectedText = editor.document.getText(editor.selection);
        if (!selectedText.trim()) {
            return undefined;
        }
        return {
            kind: 'selection',
            label: `${fileName} selection`,
            fileName,
            filePath,
            selectedText,
            selectedCharacters: selectedText.length,
            detail: `Selection: ${selectedText.length} chars from ${relativePath}`
        };
    }
    async checkBackendHealth() {
        const result = await (0, client_1.health)(getBackendUrl());
        if (result.status === 'error') {
            this.postStatus(result.message ?? 'Backend unavailable.', 'warning');
        }
    }
    async answerPlaceholder(message) {
        const question = message.question.trim();
        if (!question) {
            this.postStatus('Enter a question before asking.', 'warning');
            return;
        }
        this.postStatus('Collecting context');
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
            scope: {
                type: toApiScopeType(message.scope.kind),
                workspacePath: getWorkspacePath(),
                filePath: message.scope.filePath,
                selectedText: message.scope.selectedText,
                selectedCharacters: message.scope.selectedCharacters
            },
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
        this.view?.webview.postMessage(message);
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
      gap: 5px;
      flex-wrap: wrap;
      align-items: center;
    }

    .mode-button,
    .scope-button,
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
      height: 22px;
      padding: 0 8px;
      border-color: var(--border);
      border-radius: 999px;
      color: var(--muted);
      background: transparent;
      font-size: 11px;
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
      gap: 5px;
      align-items: start;
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
      grid-template-rows: auto auto auto;
      gap: 8px;
      align-items: start;
      padding: 9px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface);
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
          <div class="scope-tabs" role="group" aria-label="Working scope">
            <button class="scope-button" type="button" data-scope="project" aria-pressed="true">Project</button>
            <button class="scope-button" type="button" data-scope="activeFile" aria-pressed="false">File</button>
            <button class="scope-button" type="button" data-scope="selection" aria-pressed="false">Selection</button>
          </div>
          <div id="scopeDetail" class="scope-meta"></div>
        </div>
        <textarea id="question" placeholder="Ask DevMate..."></textarea>
        <div class="composer-actions">
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
      }
    };

    const statusEl = document.getElementById('status');
    const messagesEl = document.getElementById('messages');
    const questionEl = document.getElementById('question');
    const scopeDetailEl = document.getElementById('scopeDetail');

    document.querySelectorAll('.mode-button').forEach((button) => {
      button.addEventListener('click', () => {
        state.mode = button.dataset.mode;
        document.querySelectorAll('.mode-button').forEach((candidate) => {
          candidate.setAttribute('aria-pressed', String(candidate === button));
        });
      });
    });

    document.querySelectorAll('.scope-button').forEach((button) => {
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
    });

    vscode.postMessage({ command: 'setScope', scope: 'project' });

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

      document.querySelectorAll('.scope-button').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.scope === state.scope.kind));
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
function formatMode(mode) {
    switch (mode) {
        case 'ideas':
            return 'Ideas';
        case 'code':
            return 'Code';
        case 'debug':
            return 'Debug';
    }
}
function formatScope(scope) {
    switch (scope) {
        case 'project':
            return 'Project';
        case 'activeFile':
            return 'Active file';
        case 'selection':
            return 'Selection';
    }
}
function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function getWorkspacePath() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
function getBackendUrl() {
    return vscode.workspace
        .getConfiguration('devMate')
        .get('backendUrl', 'http://127.0.0.1:8000')
        .trim();
}
function toApiScopeType(scope) {
    switch (scope) {
        case 'project':
            return 'project';
        case 'activeFile':
            return 'file';
        case 'selection':
            return 'selection';
    }
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
//# sourceMappingURL=extension.js.map