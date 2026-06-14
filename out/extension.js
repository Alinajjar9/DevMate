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
function activate(context) {
    const disposable = vscode.commands.registerCommand('kiAssistant.openChat', () => {
        ChatPanel.createOrShow();
    });
    context.subscriptions.push(disposable);
}
function deactivate() {
    // No cleanup is needed for the step 1 prototype.
}
class ChatPanel {
    static currentPanel;
    panel;
    disposables = [];
    constructor(panel) {
        this.panel = panel;
        this.panel.webview.html = this.getHtml(this.panel.webview);
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message), null, this.disposables);
    }
    static createOrShow() {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        if (ChatPanel.currentPanel) {
            ChatPanel.currentPanel.panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel('kiAssistantChat', 'KI Assistant', column, {
            enableScripts: true,
            retainContextWhenHidden: true
        });
        ChatPanel.currentPanel = new ChatPanel(panel);
    }
    async handleMessage(message) {
        switch (message.command) {
            case 'attachActiveFile':
                await this.attachActiveFile();
                return;
            case 'attachSelection':
                await this.attachSelection();
                return;
            case 'ask':
                await this.answerPlaceholder(message);
                return;
            default:
                this.postStatus('Unsupported command received.', 'error');
        }
    }
    async attachActiveFile() {
        this.postStatus('Collecting context');
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            this.postStatus('Open a file before attaching the active file.', 'warning');
            return;
        }
        const filePath = editor.document.uri.fsPath;
        const attachment = {
            id: createId(),
            type: 'activeFile',
            label: path.basename(filePath),
            fileName: path.basename(filePath),
            filePath,
            detail: `Active file attached: ${path.basename(filePath)}`
        };
        this.panel.webview.postMessage({ command: 'attachmentAdded', attachment });
        this.postStatus('Ready');
    }
    async attachSelection() {
        this.postStatus('Collecting context');
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            this.postStatus('Open a file and select code before attaching a selection.', 'warning');
            return;
        }
        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);
        if (!selectedText.trim()) {
            this.postStatus('Select some code before attaching a selection.', 'warning');
            return;
        }
        const filePath = editor.document.uri.fsPath;
        const selectedCharacters = selectedText.length;
        const attachment = {
            id: createId(),
            type: 'selection',
            label: `${path.basename(filePath)} selection`,
            fileName: path.basename(filePath),
            filePath,
            detail: `Selection attached: ${selectedCharacters} characters from ${path.basename(filePath)}`,
            selectedCharacters
        };
        this.panel.webview.postMessage({ command: 'attachmentAdded', attachment });
        this.postStatus('Ready');
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
        const config = vscode.workspace.getConfiguration('kiAssistant');
        const provider = config.get('provider', 'openai');
        const model = config.get('model', 'gpt-4.1-mini');
        const maxTokens = config.get('maxTokens', 1200);
        const temperature = config.get('temperature', 0.2);
        const response = [
            `Mode: ${formatMode(message.mode)}`,
            `Provider: ${provider}`,
            `Model: ${model}`,
            `Max tokens: ${maxTokens}`,
            `Temperature: ${temperature}`,
            '',
            `Question: ${question}`,
            '',
            `Attached context items: ${message.attachments.length}`,
            '',
            'This is a step 1 placeholder. RAG, library documentation retrieval, backend services, and real LLM calls are not connected yet.'
        ].join('\n');
        this.panel.webview.postMessage({
            command: 'assistantResponse',
            response
        });
        this.postStatus('Ready');
    }
    postStatus(text, level = 'info') {
        this.panel.webview.postMessage({ command: 'status', text, level });
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
  <title>KI Assistant</title>
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
    textarea,
    select {
      font: inherit;
    }

    .app {
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      min-height: 100vh;
    }

    .toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      background: var(--surface-soft);
    }

    .title {
      font-weight: 600;
      white-space: nowrap;
    }

    .mode-tabs {
      display: inline-flex;
      gap: 2px;
      padding: 2px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface);
    }

    .mode-button,
    .action-button {
      min-height: 28px;
      border: 1px solid transparent;
      border-radius: 4px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      cursor: pointer;
    }

    .mode-button {
      width: 104px;
    }

    .mode-button[aria-pressed="true"] {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }

    .action-button {
      padding: 0 10px;
    }

    .action-button.primary {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }

    .action-button:hover,
    .mode-button:hover {
      filter: brightness(1.08);
    }

    .status {
      min-height: 32px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      color: var(--muted);
    }

    .status.warning {
      color: var(--vscode-editorWarning-foreground);
    }

    .status.error {
      color: var(--vscode-editorError-foreground);
    }

    .messages {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 12px;
      overflow-y: auto;
    }

    .message {
      width: min(880px, 100%);
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface-soft);
      white-space: pre-wrap;
      line-height: 1.45;
    }

    .message.user {
      align-self: flex-end;
      background: var(--vscode-input-background);
    }

    .message.assistant {
      align-self: flex-start;
    }

    .composer {
      display: grid;
      gap: 8px;
      padding: 12px;
      border-top: 1px solid var(--border);
      background: var(--surface-soft);
    }

    .attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-height: 28px;
      align-items: center;
    }

    .attachment {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
    }

    .attachment span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .attachment button {
      width: 18px;
      height: 18px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      color: inherit;
      background: transparent;
      cursor: pointer;
    }

    textarea {
      width: 100%;
      min-height: 92px;
      resize: vertical;
      padding: 8px;
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 4px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
    }

    textarea:focus,
    button:focus-visible {
      outline: 1px solid var(--focus);
      outline-offset: 2px;
    }

    .composer-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }

    @media (max-width: 620px) {
      .toolbar {
        align-items: stretch;
        flex-direction: column;
      }

      .mode-tabs,
      .mode-button {
        width: 100%;
      }

      .mode-button {
        flex: 1;
      }
    }
  </style>
</head>
<body>
  <main class="app">
    <header class="toolbar">
      <div class="title">KI Assistant</div>
      <div class="mode-tabs" role="group" aria-label="Assistant mode">
        <button class="mode-button" type="button" data-mode="ideas" aria-pressed="true">Ideas</button>
        <button class="mode-button" type="button" data-mode="programming" aria-pressed="false">Programming</button>
        <button class="mode-button" type="button" data-mode="debugging" aria-pressed="false">Debugging</button>
      </div>
    </header>

    <section id="status" class="status" aria-live="polite">Ready</section>

    <section id="messages" class="messages" aria-label="Chat messages">
      <article class="message assistant">Ask a project question, attach the active file or a selected code range, and choose the help mode. This first slice uses placeholder responses only.</article>
    </section>

    <section class="composer" aria-label="Message composer">
      <div id="attachments" class="attachments" aria-label="Attached context"></div>
      <textarea id="question" placeholder="Ask about your project..."></textarea>
      <div class="composer-actions">
        <button id="attachActiveFile" class="action-button" type="button">Attach Active File</button>
        <button id="attachSelection" class="action-button" type="button">Attach Selection</button>
        <button id="ask" class="action-button primary" type="button">Ask</button>
      </div>
    </section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = {
      mode: 'ideas',
      attachments: []
    };

    const statusEl = document.getElementById('status');
    const messagesEl = document.getElementById('messages');
    const attachmentsEl = document.getElementById('attachments');
    const questionEl = document.getElementById('question');

    document.querySelectorAll('.mode-button').forEach((button) => {
      button.addEventListener('click', () => {
        state.mode = button.dataset.mode;
        document.querySelectorAll('.mode-button').forEach((candidate) => {
          candidate.setAttribute('aria-pressed', String(candidate === button));
        });
      });
    });

    document.getElementById('attachActiveFile').addEventListener('click', () => {
      vscode.postMessage({ command: 'attachActiveFile' });
    });

    document.getElementById('attachSelection').addEventListener('click', () => {
      vscode.postMessage({ command: 'attachSelection' });
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
        attachments: state.attachments
      });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;

      if (message.command === 'status') {
        setStatus(message.text, message.level);
      }

      if (message.command === 'attachmentAdded') {
        state.attachments.push(message.attachment);
        renderAttachments();
      }

      if (message.command === 'assistantResponse') {
        appendMessage(message.response, 'assistant');
      }
    });

    function setStatus(text, level = 'info') {
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

    function renderAttachments() {
      attachmentsEl.replaceChildren();

      state.attachments.forEach((attachment) => {
        const item = document.createElement('div');
        item.className = 'attachment';
        item.title = attachment.detail;

        const label = document.createElement('span');
        label.textContent = attachment.label;

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'x';
        remove.title = 'Remove attachment';
        remove.addEventListener('click', () => {
          state.attachments = state.attachments.filter((candidate) => candidate.id !== attachment.id);
          renderAttachments();
        });

        item.append(label, remove);
        attachmentsEl.appendChild(item);
      });
    }
  </script>
</body>
</html>`;
    }
    dispose() {
        ChatPanel.currentPanel = undefined;
        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            disposable?.dispose();
        }
    }
}
function createId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
        case 'programming':
            return 'Programming';
        case 'debugging':
            return 'Debugging';
    }
}
function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
//# sourceMappingURL=extension.js.map