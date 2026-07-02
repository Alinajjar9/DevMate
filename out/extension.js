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
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const agentTools_1 = require("./agentTools");
const client_1 = require("./api/client");
const backendManager_1 = require("./backendManager");
const context_1 = require("./context");
const sessions_1 = require("./sessions");
const commandTools_1 = require("./commandTools");
const dependencyTools_1 = require("./dependencyTools");
const pythonEnvironment_1 = require("./pythonEnvironment");
const fileChanges_1 = require("./fileChanges");
const fileTools_1 = require("./fileTools");
const llmProfiles_1 = require("./llmProfiles");
const permissions_1 = require("./permissions");
const projectContext_1 = require("./projectContext");
const projectIndex_1 = require("./projectIndex");
const retryPolicy_1 = require("./retryPolicy");
class StartedCommandError extends Error {
    missingDependency;
    pythonEnvironment;
    commandAttempted = true;
    constructor(message, missingDependency, pythonEnvironment) {
        super(message);
        this.missingDependency = missingDependency;
        this.pythonEnvironment = pythonEnvironment;
    }
}
class StartedDependencyInstallError extends Error {
    installAttempted = true;
}
function activate(context) {
    const backendOutput = vscode.window.createOutputChannel('DevMate Backend');
    let chatViewProvider;
    const backendManager = new backendManager_1.LocalBackendManager({
        extensionPath: context.extensionUri.fsPath,
        getBackendUrl,
        isManagementEnabled: () => vscode.workspace.getConfiguration('devMate').get('manageLocalBackend', true),
        getConfiguredPythonPath: () => vscode.workspace.getConfiguration('devMate').get('backendPythonPath', ''),
        healthCheck: async (backendUrl) => (await (0, client_1.health)(backendUrl)).status === 'ok',
        fileExists: (filePath) => fs.existsSync(filePath),
        onStatus: (status) => chatViewProvider?.notifyBackendStatusChanged(status),
        onOutput: (value) => backendOutput.append(value)
    });
    chatViewProvider = new DevMateChatViewProvider(context, backendManager, backendOutput);
    const viewRegistration = vscode.window.registerWebviewViewProvider(DevMateChatViewProvider.viewId, chatViewProvider, {
        webviewOptions: {
            retainContextWhenHidden: true
        }
    });
    const openChatCommand = vscode.commands.registerCommand('devMate.openChat', async () => {
        try {
            await chatViewProvider.show();
        }
        catch (error) {
            void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'DevMate could not open its chat view.');
        }
    });
    const diffContentRegistration = vscode.workspace.registerTextDocumentContentProvider(DevMateChatViewProvider.diffScheme, chatViewProvider);
    const workspaceTrustRegistration = vscode.workspace.onDidGrantWorkspaceTrust(() => {
        chatViewProvider?.notifyWorkspaceTrustChanged();
    });
    const backendConfigurationRegistration = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('devMate.backendUrl')
            || event.affectsConfiguration('devMate.manageLocalBackend')
            || event.affectsConfiguration('devMate.backendPythonPath')) {
            void backendManager.reconfigure();
        }
    });
    const statusBarItem = vscode.window.createStatusBarItem('devMate.statusBar', vscode.StatusBarAlignment.Right, 1000);
    statusBarItem.text = '$(comment-discussion) DevMate';
    statusBarItem.tooltip = 'Open DevMate';
    statusBarItem.command = 'devMate.openChat';
    statusBarItem.show();
    context.subscriptions.push(chatViewProvider, backendManager, backendOutput, viewRegistration, diffContentRegistration, workspaceTrustRegistration, backendConfigurationRegistration, openChatCommand, statusBarItem);
    void backendManager.start();
}
function deactivate() {
    // VS Code disposes registered views and subscriptions.
}
class DevMateChatViewProvider {
    extensionContext;
    backendManager;
    backendOutput;
    static viewId = 'devmate.dedicatedAssistantView';
    static containerId = 'devmate-dedicated-chat';
    static diffScheme = 'devmate-diff';
    view;
    attachedFiles = new Map();
    viewDisposables = [];
    extensionUri;
    pendingPermission;
    pendingCommandPermission;
    activeRequest;
    projectIndexCache;
    diffDocuments = new Map();
    commandTerminals = new Map();
    sessionStore;
    constructor(extensionContext, backendManager, backendOutput) {
        this.extensionContext = extensionContext;
        this.backendManager = backendManager;
        this.backendOutput = backendOutput;
        this.extensionUri = extensionContext.extensionUri;
        const parsedStoredSessions = (0, sessions_1.parseConversationSessionStore)(extensionContext.globalState.get(sessions_1.CONVERSATION_SESSIONS_STORAGE_KEY));
        const storedSessions = parsedStoredSessions ?? (0, sessions_1.createEmptyConversationSessionStore)();
        const workspace = this.getConversationWorkspace();
        const legacySessions = workspace
            ? (0, sessions_1.migrateLegacyConversationSessionStore)(extensionContext.workspaceState.get(sessions_1.LEGACY_CONVERSATION_SESSIONS_STORAGE_KEY), workspace)
            : undefined;
        this.sessionStore = legacySessions
            ? (0, sessions_1.mergeConversationSessionStores)(storedSessions, legacySessions)
            : storedSessions;
        if (legacySessions) {
            void this.persistSessionStore().then((saved) => {
                if (saved) {
                    return extensionContext.workspaceState.update(sessions_1.LEGACY_CONVERSATION_SESSIONS_STORAGE_KEY, undefined);
                }
                return undefined;
            });
        }
        else if (!parsedStoredSessions) {
            void this.persistSessionStore();
        }
    }
    resolveWebviewView(webviewView) {
        this.disposeViewDisposables();
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };
        webviewView.webview.html = this.getHtml(webviewView.webview);
        this.viewDisposables.push(webviewView.webview.onDidReceiveMessage((message) => {
            void this.handleMessage(message);
        }), webviewView.onDidDispose(() => {
            this.view = undefined;
            this.disposeViewDisposables();
        }));
        this.postBackendStatus();
    }
    provideTextDocumentContent(uri) {
        return this.diffDocuments.get(uri.toString()) ?? '';
    }
    notifyWorkspaceTrustChanged() {
        this.postSettingsState();
    }
    notifyBackendStatusChanged(_status) {
        this.postBackendStatus();
    }
    async show() {
        await vscode.commands.executeCommand(`workbench.view.extension.${DevMateChatViewProvider.containerId}`);
        await vscode.commands.executeCommand(`${DevMateChatViewProvider.viewId}.focus`);
        const resolvedView = this.view;
        if (!resolvedView) {
            throw new Error('DevMate could not resolve its chat view. Run “Developer: Reload Window” and try again.');
        }
        resolvedView.show(false);
    }
    dispose() {
        this.view = undefined;
        this.disposeViewDisposables();
    }
    disposeViewDisposables() {
        this.activeRequest?.abort();
        this.activeRequest = undefined;
        this.pendingPermission?.resolve(false);
        this.pendingPermission = undefined;
        this.pendingCommandPermission?.resolve(false);
        this.pendingCommandPermission = undefined;
        this.diffDocuments.clear();
        this.disposeCommandTerminals();
        while (this.viewDisposables.length > 0) {
            this.viewDisposables.pop()?.dispose();
        }
    }
    async handleMessage(message) {
        switch (message.command) {
            case 'setScope':
                await this.updateScope(message.scope);
                return;
            case 'ask':
                if (this.activeRequest) {
                    this.postStatus('DevMate is already working on a request.', 'warning');
                    return;
                }
                const requestController = new AbortController();
                this.disposeCommandTerminals();
                this.activeRequest = requestController;
                try {
                    await this.answerQuestion(message, requestController.signal);
                }
                catch (error) {
                    if (!this.finishCancelledRequest(requestController.signal)) {
                        this.postRequestFailure(error instanceof Error ? error.message : 'DevMate could not complete the request.');
                    }
                }
                finally {
                    if (this.activeRequest === requestController) {
                        this.activeRequest = undefined;
                    }
                }
                return;
            case 'cancelRequest':
                this.cancelActiveRequest();
                return;
            case 'pickFiles':
                await this.pickWorkspaceFiles();
                return;
            case 'removeAttachment':
                this.attachedFiles.delete(message.id);
                this.postAttachmentState();
                return;
            case 'chooseLlmProfile':
                await this.chooseLlmProfile();
                return;
            case 'saveLlmProfile':
                await this.saveLlmProfile(message.profile);
                return;
            case 'saveSettings':
                await this.saveSettings(message.settings);
                return;
            case 'reviewPermissionDiff':
                await this.reviewPermissionDiff(message.requestId, message.path);
                return;
            case 'revokeRememberedCommand':
                await this.revokeRememberedCommand(message.signature);
                return;
            case 'clearRememberedCommands':
                await this.extensionContext.workspaceState.update(permissions_1.REMEMBERED_COMMANDS_STORAGE_KEY, []);
                this.postSettingsState();
                return;
            case 'restartBackend':
                if (this.activeRequest) {
                    this.postStatus('Wait for the active request to finish before restarting the backend.', 'warning');
                    return;
                }
                await this.backendManager.restart();
                this.postBackendStatus();
                return;
            case 'openBackendLogs':
                this.backendOutput.show(true);
                return;
            case 'newSession':
                await this.createSession();
                return;
            case 'selectSession':
                await this.selectSession(message.sessionId);
                return;
            case 'renameSession':
                await this.renameSession(message.sessionId);
                return;
            case 'deleteSession':
                await this.deleteSession(message.sessionId);
                return;
            case 'copyText':
                if (typeof message.text === 'string' && message.text.length <= 500_000) {
                    await vscode.env.clipboard.writeText(message.text);
                }
                return;
            case 'openWorkspaceFile':
                await this.openWorkspaceFile(message.path, message.line);
                return;
            case 'openExternalLink':
                await this.openExternalLink(message.url);
                return;
            case 'commandPermissionDecision':
                await this.handleCommandPermissionDecision(message.requestId, message.decision);
                return;
            case 'openCommandTerminal':
                this.commandTerminals.get(message.activityId)?.show(false);
                return;
            case 'permissionDecision':
                await this.handlePermissionDecision(message.requestId, message.decision);
                return;
            case 'ready':
                this.postAttachmentState();
                await this.migrateBuiltInNemotronProfile();
                await this.postLlmProfileState();
                await this.promptForBuiltInNemotronKey();
                this.postPermissionPolicyState();
                this.postSettingsState();
                this.postBackendStatus();
                this.postSessionState(false);
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
    async createSession() {
        if (!this.canChangeSession()) {
            return;
        }
        const workspace = this.getConversationWorkspace();
        if (!workspace) {
            this.postSessionWarning('Open a project folder before starting a DevMate session.');
            return;
        }
        this.sessionStore = (0, sessions_1.addConversationSession)(this.sessionStore, (0, crypto_1.randomUUID)(), Date.now(), workspace);
        await this.persistSessionStore();
        this.postSessionState(true, true);
    }
    async openWorkspaceFile(requestedPath, requestedLine) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder || typeof requestedPath !== 'string') {
            return;
        }
        const value = requestedPath.trim();
        if (!value || value.length > 2_048) {
            return;
        }
        const absolutePath = path.isAbsolute(value)
            ? path.resolve(value)
            : path.resolve(folder.uri.fsPath, value);
        const relativePath = path.relative(folder.uri.fsPath, absolutePath);
        if (!relativePath
            || relativePath === '..'
            || relativePath.startsWith(`..${path.sep}`)
            || path.isAbsolute(relativePath)) {
            return;
        }
        try {
            await this.assertNoWorkspaceSymlink(folder, normalizeRelativeWorkspacePath(relativePath), false);
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
            const line = Number.isInteger(requestedLine)
                ? Math.max(0, Math.min(document.lineCount - 1, Number(requestedLine) - 1))
                : 0;
            await vscode.window.showTextDocument(document, {
                preview: true,
                selection: new vscode.Range(line, 0, line, 0)
            });
        }
        catch {
            this.postStatus(`Could not open ${value}.`, 'warning');
        }
    }
    async openExternalLink(value) {
        try {
            const uri = vscode.Uri.parse(value, true);
            if (uri.scheme === 'http' || uri.scheme === 'https') {
                await vscode.env.openExternal(uri);
            }
        }
        catch {
            // Invalid and non-HTTP links are ignored.
        }
    }
    async selectSession(sessionId) {
        if (!this.canChangeSession()) {
            return;
        }
        const session = this.sessionStore.sessions.find((item) => item.id === sessionId);
        if (!session) {
            return;
        }
        const workspace = this.getConversationWorkspace();
        if (!(0, sessions_1.sessionBelongsToWorkspace)(session, workspace)) {
            this.postSessionWarning(`This session belongs to “${session.workspaceName}”. Open that project to continue it.`);
            return;
        }
        const nextStore = (0, sessions_1.selectConversationSession)(this.sessionStore, sessionId);
        this.sessionStore = nextStore;
        await this.persistSessionStore();
        this.postSessionState(true, true);
    }
    async renameSession(sessionId) {
        if (!this.canChangeSession()) {
            return;
        }
        const session = this.sessionStore.sessions.find((item) => item.id === sessionId);
        if (!session) {
            return;
        }
        const title = await vscode.window.showInputBox({
            title: 'Rename DevMate session',
            prompt: 'Choose a short name for this session.',
            value: session.title,
            valueSelection: [0, session.title.length],
            validateInput: (value) => value.trim() ? undefined : 'Enter a session name.'
        });
        if (title === undefined || this.activeRequest) {
            return;
        }
        this.sessionStore = (0, sessions_1.renameConversationSession)(this.sessionStore, sessionId, title);
        await this.persistSessionStore();
        this.postSessionState(false);
    }
    async deleteSession(sessionId) {
        if (!this.canChangeSession()) {
            return;
        }
        const session = this.sessionStore.sessions.find((item) => item.id === sessionId);
        if (!session) {
            return;
        }
        const decision = await vscode.window.showWarningMessage(`Delete “${session.title}”? This permanently removes its saved messages from “${session.workspaceName}”.`, { modal: true }, 'Delete');
        if (decision !== 'Delete' || this.activeRequest) {
            return;
        }
        this.sessionStore = (0, sessions_1.deleteConversationSession)(this.sessionStore, sessionId);
        await this.persistSessionStore();
        this.postSessionState(false);
    }
    canChangeSession() {
        if (!this.activeRequest) {
            return true;
        }
        this.postStatus('Wait for the active request to finish before changing sessions.', 'warning');
        return false;
    }
    async persistSessionStore() {
        try {
            await this.extensionContext.globalState.update(sessions_1.CONVERSATION_SESSIONS_STORAGE_KEY, this.sessionStore);
            return true;
        }
        catch {
            this.postStatus('The session is available now, but VS Code could not save it for the next restart.', 'warning');
            return false;
        }
    }
    postSessionState(includeMessages, openChat = false) {
        const activeSession = (0, sessions_1.activeConversationSession)(this.sessionStore);
        const workspace = this.getConversationWorkspace();
        this.postMessage({
            command: 'sessionsUpdated',
            activeSessionId: this.sessionStore.activeSessionId,
            activeTitle: activeSession?.title ?? 'Sessions',
            currentWorkspaceName: workspace?.name ?? 'No project open',
            openChat,
            sessions: this.sessionStore.sessions.map((session) => ({
                id: session.id,
                title: session.title,
                workspaceName: session.workspaceName,
                belongsToCurrentWorkspace: (0, sessions_1.sessionBelongsToWorkspace)(session, workspace),
                updatedAt: session.updatedAt,
                turnCount: session.turns.length
            })),
            ...(includeMessages && activeSession
                ? {
                    messages: activeSession.turns.flatMap((turn) => [
                        { role: 'user', text: turn.user },
                        { role: 'assistant', text: turn.assistant }
                    ])
                }
                : {})
        });
    }
    postSessionWarning(message) {
        this.postMessage({ command: 'sessionProjectWarning', message });
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
        const remainingFiles = projectContext_1.MAX_PROJECT_FILES - attachmentItems.length;
        const remainingCharacters = projectContext_1.MAX_PROJECT_CONTEXT_CHARACTERS - includedAttachmentCharacters;
        const attachedPaths = new Set(attachmentItems.map((item) => item.filePath));
        try {
            this.postStatus('Refreshing project index');
            const refresh = await this.refreshProjectIndex(folder);
            this.postStatus(refresh.changedFiles > 0 || refresh.removedFiles > 0
                ? `Indexed ${formatFileCount(refresh.index.files.length)}`
                : 'Searching project index');
            const chunks = (0, projectIndex_1.retrieveProjectChunks)(refresh.index, question, {
                maxChunks: remainingFiles,
                maxCharacters: Math.max(0, remainingCharacters - remainingFiles * 64),
                excludedFilePaths: attachedPaths
            });
            const retrievedItems = this.createRetrievedProjectItems(chunks, remainingCharacters);
            if (retrievedItems.length > 0) {
                this.postStatus(`Retrieved ${formatExcerptCount(retrievedItems.length)}`);
                return [...attachmentItems, ...retrievedItems];
            }
            this.postStatus('Using project context fallback');
        }
        catch {
            this.postStatus('Project index unavailable — using fallback');
        }
        return this.collectRankedProjectItems(folder, question, attachmentItems, remainingFiles, remainingCharacters);
    }
    async collectRankedProjectItems(folder, question, attachmentItems, remainingFiles, remainingCharacters) {
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
            maxFiles: remainingFiles,
            maxCharacters: remainingCharacters
        });
        return [...attachmentItems, ...discoveredItems];
    }
    createRetrievedProjectItems(chunks, maxCharacters) {
        const items = [];
        let remainingCharacters = Math.max(0, maxCharacters);
        for (const chunk of chunks) {
            if (items.length >= projectContext_1.MAX_PROJECT_FILES || remainingCharacters <= 0) {
                break;
            }
            const lineLabel = chunk.startLine === chunk.endLine
                ? `line ${chunk.startLine}`
                : `lines ${chunk.startLine}-${chunk.endLine}`;
            const content = `[Local index excerpt: ${lineLabel}]\n${chunk.content}`;
            const item = (0, context_1.createBoundedContextItem)('file', chunk.filePath, chunk.languageId, content, Math.min(projectContext_1.MAX_PROJECT_FILE_CHARACTERS, remainingCharacters));
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
        const uris = (await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), projectContext_1.PROJECT_EXCLUDE_GLOB, projectIndex_1.MAX_PROJECT_INDEX_FILES)).filter((uri) => !(0, projectContext_1.shouldSkipProjectFile)(vscode.workspace.asRelativePath(uri, false)))
            .sort((left, right) => vscode.workspace.asRelativePath(left, false).localeCompare(vscode.workspace.asRelativePath(right, false)));
        const indexedFiles = [];
        let changedFiles = 0;
        const batchSize = 20;
        for (let offset = 0; offset < uris.length; offset += batchSize) {
            const batchFiles = await Promise.all(uris.slice(offset, offset + batchSize).map(async (uri) => {
                const relativePath = normalizeRelativeWorkspacePath(vscode.workspace.asRelativePath(uri, false));
                try {
                    const stat = await vscode.workspace.fs.stat(uri);
                    if ((stat.type & vscode.FileType.File) === 0 || stat.size > projectContext_1.MAX_PROJECT_FILE_BYTES) {
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
        const storageDirectory = this.extensionContext.storageUri;
        if (!storageUri || !storageDirectory) {
            return;
        }
        await vscode.workspace.fs.createDirectory(storageDirectory);
        await vscode.workspace.fs.writeFile(storageUri, new TextEncoder().encode(JSON.stringify(index)));
    }
    projectIndexStorageUri() {
        const storageDirectory = this.extensionContext.storageUri;
        return storageDirectory
            ? vscode.Uri.joinPath(storageDirectory, projectIndex_1.PROJECT_INDEX_FILE_NAME)
            : undefined;
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
    getStoredLlmProfiles() {
        return (0, llmProfiles_1.parseStoredProfiles)(this.extensionContext.globalState.get(llmProfiles_1.LLM_PROFILES_STORAGE_KEY));
    }
    getLlmProfiles() {
        return (0, llmProfiles_1.profilesWithBuiltInNemotron)(this.getStoredLlmProfiles());
    }
    getActiveLlmProfile(profiles = this.getLlmProfiles()) {
        const activeProfileId = this.extensionContext.globalState.get(llmProfiles_1.ACTIVE_LLM_PROFILE_STORAGE_KEY);
        return profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
    }
    async migrateBuiltInNemotronProfile() {
        const storedProfiles = this.getStoredLlmProfiles();
        const equivalentProfiles = storedProfiles.filter(llmProfiles_1.isEquivalentNemotronProfile);
        if (equivalentProfiles.length === 0) {
            return;
        }
        const activeProfileId = this.extensionContext.globalState.get(llmProfiles_1.ACTIVE_LLM_PROFILE_STORAGE_KEY);
        const preferredProfile = equivalentProfiles.find((profile) => profile.id === activeProfileId);
        const keyCandidates = preferredProfile
            ? [preferredProfile, ...equivalentProfiles.filter((profile) => profile !== preferredProfile)]
            : equivalentProfiles;
        try {
            const builtInSecretKey = (0, llmProfiles_1.secretKeyForProfile)(llmProfiles_1.BUILT_IN_NEMOTRON_PROFILE_ID);
            const existingBuiltInKey = await this.extensionContext.secrets.get(builtInSecretKey);
            if (!existingBuiltInKey) {
                for (const candidate of keyCandidates) {
                    const candidateKey = await this.extensionContext.secrets.get((0, llmProfiles_1.secretKeyForProfile)(candidate.id));
                    if (candidateKey) {
                        await this.extensionContext.secrets.store(builtInSecretKey, candidateKey);
                        break;
                    }
                }
            }
            const equivalentIds = new Set(equivalentProfiles.map((profile) => profile.id));
            await this.extensionContext.globalState.update(llmProfiles_1.LLM_PROFILES_STORAGE_KEY, storedProfiles.filter((profile) => !equivalentIds.has(profile.id)));
            if (!activeProfileId || equivalentIds.has(activeProfileId)) {
                await this.extensionContext.globalState.update(llmProfiles_1.ACTIVE_LLM_PROFILE_STORAGE_KEY, llmProfiles_1.BUILT_IN_NEMOTRON_PROFILE_ID);
            }
            await Promise.all(equivalentProfiles.map((profile) => this.extensionContext.secrets.delete((0, llmProfiles_1.secretKeyForProfile)(profile.id))));
        }
        catch {
            this.postStatus(`Could not migrate the existing ${llmProfiles_1.BUILT_IN_NEMOTRON_PROFILE.name} profile.`, 'warning');
        }
    }
    async promptForBuiltInNemotronKey() {
        const activeProfile = this.getActiveLlmProfile();
        if (!activeProfile || !(0, llmProfiles_1.isBuiltInLlmProfile)(activeProfile)) {
            return;
        }
        const apiKey = await this.extensionContext.secrets.get((0, llmProfiles_1.secretKeyForProfile)(llmProfiles_1.BUILT_IN_NEMOTRON_PROFILE_ID));
        if (!apiKey) {
            await this.showLlmProfileForm(activeProfile);
        }
    }
    async chooseLlmProfile() {
        const profiles = this.getLlmProfiles();
        if (profiles.length === 0) {
            await this.showLlmProfileForm();
            return;
        }
        const activeProfile = this.getActiveLlmProfile(profiles);
        const choices = profiles.map((profile) => ({
            label: (0, llmProfiles_1.isBuiltInLlmProfile)(profile) ? `$(sparkle) ${profile.name}` : profile.name,
            description: [
                profile.id === activeProfile?.id ? 'Selected' : undefined,
                (0, llmProfiles_1.isBuiltInLlmProfile)(profile) ? 'Built-in' : undefined,
                (0, llmProfiles_1.providerLabelForProfile)(profile),
                profile.model
            ].filter(Boolean).join(' · '),
            detail: profile.baseUrl,
            action: 'select',
            profileId: profile.id
        }));
        choices.push({
            label: '$(add) Add model profile',
            description: 'Save another provider and model',
            action: 'add'
        }, {
            label: '$(gear) Manage model profiles',
            description: 'Configure Nemotron or edit and delete custom profiles',
            action: 'manage'
        });
        const selected = await vscode.window.showQuickPick(choices, {
            matchOnDescription: true,
            matchOnDetail: true,
            placeHolder: 'Choose the model DevMate should use',
            title: 'DevMate: Select model'
        });
        if (!selected) {
            return;
        }
        if (selected.action === 'add') {
            await this.showLlmProfileForm();
            return;
        }
        if (selected.action === 'manage') {
            await this.manageLlmProfiles();
            return;
        }
        if (selected.profileId) {
            await this.extensionContext.globalState.update(llmProfiles_1.ACTIVE_LLM_PROFILE_STORAGE_KEY, selected.profileId);
            await this.postLlmProfileState();
            await this.promptForBuiltInNemotronKey();
            this.postStatus('Ready');
        }
    }
    cancelActiveRequest() {
        if (!this.activeRequest || this.activeRequest.signal.aborted) {
            return;
        }
        this.activeRequest.abort();
        this.pendingPermission?.resolve(false);
        this.pendingPermission = undefined;
        this.pendingCommandPermission?.resolve(false);
        this.pendingCommandPermission = undefined;
        this.diffDocuments.clear();
        this.disposeCommandTerminals();
        this.postMessage({ command: 'requestCancelling' });
    }
    finishCancelledRequest(signal) {
        if (!signal.aborted) {
            return false;
        }
        this.postMessage({ command: 'requestCancelled' });
        this.postStatus('Ready');
        return true;
    }
    postRequestFailure(message, options = {}) {
        this.postMessage({
            command: 'requestFailed',
            message,
            retryable: options.retryable === true
        });
        this.postStatus(message, options.level ?? 'error');
    }
    async showLlmProfileForm(profile) {
        const hasApiKey = profile
            ? Boolean(await this.extensionContext.secrets.get((0, llmProfiles_1.secretKeyForProfile)(profile.id)))
            : false;
        this.postMessage({
            command: 'showLlmProfileForm',
            profile: profile
                ? {
                    id: profile.id,
                    name: profile.name,
                    provider: profile.provider,
                    model: profile.model,
                    baseUrl: profile.baseUrl,
                    builtIn: (0, llmProfiles_1.isBuiltInLlmProfile)(profile)
                }
                : undefined,
            hasApiKey
        });
    }
    async saveLlmProfile(submission) {
        if ((submission.id !== undefined && typeof submission.id !== 'string')
            || typeof submission.name !== 'string'
            || !['openai', 'ollama'].includes(submission.provider)
            || typeof submission.model !== 'string'
            || (submission.baseUrl !== undefined && typeof submission.baseUrl !== 'string')
            || (submission.apiKey !== undefined && typeof submission.apiKey !== 'string')) {
            this.postMessage({
                command: 'llmProfileFormError',
                message: 'The model profile contains invalid values.'
            });
            return;
        }
        const profiles = this.getLlmProfiles();
        const storedProfiles = this.getStoredLlmProfiles();
        const existingProfile = submission.id
            ? profiles.find((profile) => profile.id === submission.id)
            : undefined;
        if (submission.id && !existingProfile) {
            this.postMessage({
                command: 'llmProfileFormError',
                message: 'That model profile no longer exists.'
            });
            return;
        }
        if (existingProfile && (0, llmProfiles_1.isBuiltInLlmProfile)(existingProfile)) {
            await this.saveBuiltInNemotronApiKey(submission.apiKey);
            return;
        }
        const draft = (0, llmProfiles_1.normalizeProfileDraft)({
            name: submission.name,
            provider: submission.provider,
            model: submission.model,
            baseUrl: submission.baseUrl
        });
        const validationError = (0, llmProfiles_1.validateProfileDraft)(draft, profiles, existingProfile?.id);
        if (validationError) {
            this.postMessage({ command: 'llmProfileFormError', message: validationError });
            return;
        }
        const existingApiKey = existingProfile
            ? await this.extensionContext.secrets.get((0, llmProfiles_1.secretKeyForProfile)(existingProfile.id))
            : undefined;
        const submittedApiKey = submission.apiKey?.trim();
        if (draft.provider === 'openai' && !submittedApiKey && !existingApiKey) {
            this.postMessage({
                command: 'llmProfileFormError',
                message: 'Enter an API key for this OpenAI profile.'
            });
            return;
        }
        const profile = {
            id: existingProfile?.id ?? (0, crypto_1.randomUUID)(),
            ...draft
        };
        const secretKey = (0, llmProfiles_1.secretKeyForProfile)(profile.id);
        const updatedProfiles = existingProfile
            ? storedProfiles.map((candidate) => candidate.id === profile.id ? profile : candidate)
            : [...storedProfiles, profile];
        try {
            if (draft.provider === 'openai' && submittedApiKey) {
                await this.extensionContext.secrets.store(secretKey, submittedApiKey);
            }
            await this.extensionContext.globalState.update(llmProfiles_1.LLM_PROFILES_STORAGE_KEY, updatedProfiles);
            if (!existingProfile) {
                await this.extensionContext.globalState.update(llmProfiles_1.ACTIVE_LLM_PROFILE_STORAGE_KEY, profile.id);
            }
            if (draft.provider === 'ollama') {
                await this.extensionContext.secrets.delete(secretKey);
            }
        }
        catch {
            if (!existingProfile) {
                await this.extensionContext.secrets.delete(secretKey);
            }
            this.postMessage({
                command: 'llmProfileFormError',
                message: 'Could not save the model profile.'
            });
            return;
        }
        await this.postLlmProfileState();
        this.postMessage({ command: 'closeLlmProfileForm' });
        this.postStatus(existingProfile ? `${profile.name} updated.` : `${profile.name} selected.`);
    }
    async saveBuiltInNemotronApiKey(apiKey) {
        const secretKey = (0, llmProfiles_1.secretKeyForProfile)(llmProfiles_1.BUILT_IN_NEMOTRON_PROFILE_ID);
        const submittedApiKey = apiKey?.trim();
        const existingApiKey = await this.extensionContext.secrets.get(secretKey);
        if (!submittedApiKey && !existingApiKey) {
            this.postMessage({
                command: 'llmProfileFormError',
                message: 'Enter an NVIDIA API key for the built-in Nemotron model.'
            });
            return;
        }
        try {
            if (submittedApiKey) {
                await this.extensionContext.secrets.store(secretKey, submittedApiKey);
            }
        }
        catch {
            this.postMessage({
                command: 'llmProfileFormError',
                message: 'Could not save the NVIDIA API key.'
            });
            return;
        }
        await this.postLlmProfileState();
        this.postMessage({ command: 'closeLlmProfileForm' });
        this.postStatus(`${llmProfiles_1.BUILT_IN_NEMOTRON_PROFILE.name} is ready.`);
    }
    async manageLlmProfiles() {
        const profiles = this.getLlmProfiles();
        if (profiles.length === 0) {
            await this.showLlmProfileForm();
            return;
        }
        const selected = await vscode.window.showQuickPick(profiles.map((profile) => ({
            label: (0, llmProfiles_1.isBuiltInLlmProfile)(profile) ? `$(sparkle) ${profile.name}` : profile.name,
            description: [
                (0, llmProfiles_1.isBuiltInLlmProfile)(profile) ? 'Built-in' : undefined,
                (0, llmProfiles_1.providerLabelForProfile)(profile),
                profile.model
            ].filter(Boolean).join(' · '),
            detail: profile.baseUrl,
            profile
        })), {
            matchOnDescription: true,
            matchOnDetail: true,
            placeHolder: 'Choose a profile to manage',
            title: 'DevMate: Manage model profiles'
        });
        if (!selected) {
            return;
        }
        const activeProfile = this.getActiveLlmProfile(profiles);
        const actions = [];
        if (selected.profile.id !== activeProfile?.id) {
            actions.push({
                label: '$(check) Set as selected model',
                action: 'select'
            });
        }
        if ((0, llmProfiles_1.isBuiltInLlmProfile)(selected.profile)) {
            actions.push({ label: '$(key) Configure NVIDIA API key', action: 'configure' });
        }
        else {
            actions.push({ label: '$(edit) Edit profile', action: 'edit' }, { label: '$(trash) Delete profile', action: 'delete' });
        }
        const action = await vscode.window.showQuickPick(actions, {
            placeHolder: `Manage ${selected.profile.name}`,
            title: 'DevMate: Manage model profile'
        });
        if (!action) {
            return;
        }
        if (action.action === 'select') {
            await this.extensionContext.globalState.update(llmProfiles_1.ACTIVE_LLM_PROFILE_STORAGE_KEY, selected.profile.id);
            await this.postLlmProfileState();
            await this.promptForBuiltInNemotronKey();
            return;
        }
        if (action.action === 'edit' || action.action === 'configure') {
            await this.showLlmProfileForm(selected.profile);
            return;
        }
        await this.deleteLlmProfile(selected.profile);
    }
    async deleteLlmProfile(profile) {
        if ((0, llmProfiles_1.isBuiltInLlmProfile)(profile)) {
            this.postStatus('The built-in Nemotron profile cannot be deleted.', 'warning');
            return;
        }
        const confirmation = await vscode.window.showWarningMessage(`Delete the model profile "${profile.name}"?`, { modal: true }, 'Delete');
        if (confirmation !== 'Delete') {
            return;
        }
        const profiles = this.getLlmProfiles();
        const remainingProfiles = this.getStoredLlmProfiles().filter((candidate) => candidate.id !== profile.id);
        try {
            await this.extensionContext.globalState.update(llmProfiles_1.LLM_PROFILES_STORAGE_KEY, remainingProfiles);
            await this.extensionContext.secrets.delete((0, llmProfiles_1.secretKeyForProfile)(profile.id));
            const activeProfile = this.getActiveLlmProfile(profiles);
            if (activeProfile?.id === profile.id) {
                await this.extensionContext.globalState.update(llmProfiles_1.ACTIVE_LLM_PROFILE_STORAGE_KEY, llmProfiles_1.BUILT_IN_NEMOTRON_PROFILE_ID);
            }
        }
        catch {
            this.postStatus('Could not delete the model profile.', 'error');
            return;
        }
        await this.postLlmProfileState();
        this.postStatus(`${profile.name} deleted.`);
    }
    async postLlmProfileState() {
        const profiles = this.getLlmProfiles();
        const activeProfile = this.getActiveLlmProfile(profiles);
        if (activeProfile
            && this.extensionContext.globalState.get(llmProfiles_1.ACTIVE_LLM_PROFILE_STORAGE_KEY) !== activeProfile.id) {
            await this.extensionContext.globalState.update(llmProfiles_1.ACTIVE_LLM_PROFILE_STORAGE_KEY, activeProfile.id);
        }
        this.postMessage({
            command: 'llmProfilesUpdated',
            profileCount: profiles.length,
            activeProfile: activeProfile
                ? {
                    id: activeProfile.id,
                    name: activeProfile.name,
                    provider: activeProfile.provider,
                    providerLabel: (0, llmProfiles_1.providerLabelForProfile)(activeProfile),
                    model: activeProfile.model
                }
                : undefined
        });
    }
    getPermissionPolicy() {
        return (0, permissions_1.parseFilePermissionPolicy)(this.extensionContext.workspaceState.get(permissions_1.FILE_PERMISSION_POLICY_STORAGE_KEY));
    }
    getRememberedCommands() {
        return (0, permissions_1.parseRememberedCommands)(this.extensionContext.workspaceState.get(permissions_1.REMEMBERED_COMMANDS_STORAGE_KEY));
    }
    async revokeRememberedCommand(signature) {
        const updated = (0, permissions_1.revokeRememberedCommand)(this.getRememberedCommands(), signature);
        await this.extensionContext.workspaceState.update(permissions_1.REMEMBERED_COMMANDS_STORAGE_KEY, updated);
        this.postSettingsState();
    }
    async saveSettings(settings) {
        if (!Number.isInteger(settings.timeoutSeconds)
            || settings.timeoutSeconds < 10
            || settings.timeoutSeconds > 1800
            || !Number.isInteger(settings.commandTimeoutSeconds)
            || settings.commandTimeoutSeconds < commandTools_1.MIN_COMMAND_TIMEOUT_SECONDS
            || settings.commandTimeoutSeconds > commandTools_1.MAX_COMMAND_TIMEOUT_SECONDS
            || !Number.isInteger(settings.toolCallLimit)
            || settings.toolCallLimit < agentTools_1.MIN_AGENT_TOOL_CALL_LIMIT
            || settings.toolCallLimit > agentTools_1.MAX_AGENT_TOOL_CALL_LIMIT
            || !Number.isInteger(settings.maxTokens)
            || settings.maxTokens < 128
            || settings.maxTokens > 32_000
            || !Number.isFinite(settings.temperature)
            || settings.temperature < 0
            || settings.temperature > 2) {
            this.postStatus('The settings contain an invalid value.', 'warning');
            return;
        }
        const normalizedPolicy = (0, permissions_1.parseFilePermissionPolicy)(settings.policy);
        const config = vscode.workspace.getConfiguration('devMate');
        try {
            await Promise.all([
                config.update('requestTimeoutSeconds', settings.timeoutSeconds, vscode.ConfigurationTarget.Global),
                config.update('commandTimeoutSeconds', settings.commandTimeoutSeconds, vscode.ConfigurationTarget.Global),
                config.update('toolCallLimit', settings.toolCallLimit, vscode.ConfigurationTarget.Global),
                config.update('maxTokens', settings.maxTokens, vscode.ConfigurationTarget.Global),
                config.update('temperature', settings.temperature, vscode.ConfigurationTarget.Global),
                this.extensionContext.workspaceState.update(permissions_1.FILE_PERMISSION_POLICY_STORAGE_KEY, normalizedPolicy)
            ]);
        }
        catch {
            this.postStatus('DevMate could not save the settings.', 'error');
            return;
        }
        this.postPermissionPolicyState();
        this.postSettingsState();
        this.postMessage({ command: 'settingsSaved' });
    }
    postPermissionPolicyState() {
        const policy = this.getPermissionPolicy();
        this.postMessage({
            command: 'permissionPolicyUpdated',
            policy
        });
    }
    postSettingsState() {
        const config = vscode.workspace.getConfiguration('devMate');
        this.postMessage({
            command: 'settingsUpdated',
            settings: {
                timeoutSeconds: Math.min(1800, Math.max(10, config.get('requestTimeoutSeconds', 900))),
                commandTimeoutSeconds: Math.min(commandTools_1.MAX_COMMAND_TIMEOUT_SECONDS, Math.max(commandTools_1.MIN_COMMAND_TIMEOUT_SECONDS, config.get('commandTimeoutSeconds', commandTools_1.DEFAULT_COMMAND_TIMEOUT_SECONDS))),
                toolCallLimit: (0, agentTools_1.boundedAgentToolCallLimit)(config.get('toolCallLimit', agentTools_1.DEFAULT_AGENT_TOOL_CALL_LIMIT)),
                maxTokens: Math.min(32_000, Math.max(128, config.get('maxTokens', 16_384))),
                temperature: Math.min(2, Math.max(0, config.get('temperature', 0.2))),
                rememberedCommands: this.getRememberedCommands(),
                workspaceTrusted: vscode.workspace.isTrusted
            }
        });
    }
    postBackendStatus() {
        const status = this.backendManager.status;
        this.postMessage({
            command: 'backendStatusUpdated',
            status,
            label: (0, backendManager_1.backendStatusLabel)(status)
        });
    }
    async handlePermissionDecision(requestId, decision) {
        const pending = this.pendingPermission;
        if (!pending || pending.id !== requestId) {
            return;
        }
        this.pendingPermission = undefined;
        if (decision === 'allowAlways' && pending.rememberable) {
            try {
                const updatedPolicy = (0, permissions_1.allowActions)(this.getPermissionPolicy(), pending.actions);
                await this.extensionContext.workspaceState.update(permissions_1.FILE_PERMISSION_POLICY_STORAGE_KEY, updatedPolicy);
                this.postPermissionPolicyState();
            }
            catch {
                this.postStatus('The changes are allowed this time, but the permission preference could not be saved.', 'warning');
            }
        }
        pending.resolve(decision !== 'deny');
        for (const diff of pending.diffs.values()) {
            this.diffDocuments.delete(diff.originalUri.toString());
            this.diffDocuments.delete(diff.proposedUri.toString());
        }
    }
    requestFileChangePermission(summary, files) {
        this.pendingPermission?.resolve(false);
        this.diffDocuments.clear();
        const requestId = (0, crypto_1.randomUUID)();
        const actions = new Set(files.map((file) => file.operation));
        const rememberable = [...actions].every((action) => action === 'create' || action === 'update');
        const diffs = new Map();
        for (const file of files) {
            const encodedPath = file.path.split('/').map(encodeURIComponent).join('/');
            const originalUri = vscode.Uri.parse(`${DevMateChatViewProvider.diffScheme}:/${requestId}/original/${encodedPath}`);
            const proposedUri = vscode.Uri.parse(`${DevMateChatViewProvider.diffScheme}:/${requestId}/proposed/${encodedPath}`);
            this.diffDocuments.set(originalUri.toString(), file.originalContent);
            this.diffDocuments.set(proposedUri.toString(), file.proposedContent);
            diffs.set(file.path, {
                path: file.path,
                originalContent: file.originalContent,
                proposedContent: file.proposedContent,
                originalUri,
                proposedUri
            });
        }
        return new Promise((resolve) => {
            this.pendingPermission = { id: requestId, actions, rememberable, diffs, resolve };
            this.postMessage({
                command: 'permissionRequest',
                requestId,
                summary,
                rememberable,
                files: files.map(({ path, operation }) => ({ path, operation, canReview: true }))
            });
        });
    }
    async reviewPermissionDiff(requestId, filePath) {
        const pending = this.pendingPermission;
        const diff = pending?.id === requestId ? pending.diffs.get(filePath) : undefined;
        if (!diff) {
            this.postStatus('That proposed diff is no longer available.', 'warning');
            return;
        }
        await vscode.commands.executeCommand('vscode.diff', diff.originalUri, diff.proposedUri, `DevMate: ${diff.path}`, { preview: true });
    }
    requestCommandPermission(signature, label, cwd, options = {}) {
        const rememberable = options.rememberable !== false;
        if (rememberable && this.getRememberedCommands().some((command) => command.signature === signature)) {
            return Promise.resolve(true);
        }
        this.pendingCommandPermission?.resolve(false);
        const requestId = (0, crypto_1.randomUUID)();
        return new Promise((resolve) => {
            this.pendingCommandPermission = {
                id: requestId,
                signature,
                label: `${label} · ${cwd || 'workspace root'}`,
                rememberable,
                resolve
            };
            this.postMessage({
                command: 'commandPermissionRequest',
                requestId,
                label,
                cwd: cwd || 'Workspace root',
                rememberable,
                title: options.title,
                warning: options.warning
            });
        });
    }
    async handleCommandPermissionDecision(requestId, decision) {
        const pending = this.pendingCommandPermission;
        if (!pending || pending.id !== requestId) {
            return;
        }
        this.pendingCommandPermission = undefined;
        if (decision === 'allowAlways' && pending.rememberable) {
            const updated = (0, permissions_1.rememberCommand)(this.getRememberedCommands(), {
                signature: pending.signature,
                label: pending.label
            });
            await this.extensionContext.workspaceState.update(permissions_1.REMEMBERED_COMMANDS_STORAGE_KEY, updated);
            this.postSettingsState();
        }
        pending.resolve(decision === 'allowOnce' || (decision === 'allowAlways' && pending.rememberable));
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
    async executeAgentToolCall(call, remainingMutationCharacters = fileChanges_1.MAX_TOTAL_CHANGE_CHARACTERS) {
        let parsedCall;
        try {
            parsedCall = (0, agentTools_1.parseAgentToolCall)(call);
        }
        catch (error) {
            const result = error instanceof Error ? error.message : 'The tool request was invalid.';
            this.postAgentToolActivity(call.id, 'Tool request rejected', call.name, 'error', result);
            return {
                step: {
                    callId: call.id,
                    name: call.name,
                    arguments: call.arguments,
                    result: (0, agentTools_1.truncateAgentToolResult)(result),
                    isError: true
                },
                usedFiles: [],
                mutationCharacters: 0
            };
        }
        const activity = describeAgentToolCall(parsedCall);
        this.postAgentToolActivity(call.id, activity.title, activity.detail, 'running');
        try {
            const execution = await this.runAgentTool(parsedCall, remainingMutationCharacters);
            this.postAgentToolActivity(call.id, activity.title, activity.detail, 'completed', execution.resultSummary, (parsedCall.name === 'run_command' || parsedCall.name === 'install_dependencies')
                && this.commandTerminals.has(parsedCall.id));
            return {
                step: {
                    callId: parsedCall.id,
                    name: parsedCall.name,
                    arguments: (0, agentTools_1.summarizedAgentToolArguments)(parsedCall),
                    result: (0, agentTools_1.truncateAgentToolResult)(execution.result),
                    isError: false
                },
                usedFiles: execution.usedFiles,
                mutationCharacters: execution.mutationCharacters,
                mutationApplied: execution.mutationApplied,
                commandAttempted: execution.commandAttempted,
                missingDependency: execution.missingDependency,
                pythonEnvironment: execution.pythonEnvironment,
                installAttempted: execution.installAttempted,
                environmentChanged: execution.environmentChanged
            };
        }
        catch (error) {
            const result = error instanceof Error ? error.message : 'The tool could not be completed.';
            this.postAgentToolActivity(call.id, activity.title, activity.detail, 'error', result, (parsedCall.name === 'run_command' || parsedCall.name === 'install_dependencies')
                && this.commandTerminals.has(parsedCall.id));
            return {
                step: {
                    callId: parsedCall.id,
                    name: parsedCall.name,
                    arguments: (0, agentTools_1.summarizedAgentToolArguments)(parsedCall),
                    result: (0, agentTools_1.truncateAgentToolResult)(result),
                    isError: true
                },
                usedFiles: [],
                mutationCharacters: 0,
                commandAttempted: error instanceof StartedCommandError,
                missingDependency: error instanceof StartedCommandError
                    ? error.missingDependency
                    : undefined,
                pythonEnvironment: error instanceof StartedCommandError
                    ? error.pythonEnvironment
                    : undefined,
                installAttempted: error instanceof StartedDependencyInstallError
            };
        }
    }
    async runAgentTool(call, remainingMutationCharacters) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            throw new Error('Open a workspace folder before using project tools.');
        }
        if (call.name === 'create_file') {
            await this.assertNoWorkspaceSymlink(folder, call.arguments.path, true);
            const uri = vscode.Uri.joinPath(folder.uri, ...call.arguments.path.split('/'));
            try {
                await vscode.workspace.fs.stat(uri);
                throw new Error(`${call.arguments.path} already exists; use edit_file instead.`);
            }
            catch (error) {
                if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
                    throw error;
                }
            }
            const changes = (0, fileChanges_1.validateFileChanges)([call.arguments]);
            if (call.arguments.content.length > remainingMutationCharacters) {
                throw new Error('This request reached the total file-mutation size limit.');
            }
            const outcome = await this.confirmAndApplyFileChanges(changes, `Create ${call.arguments.path}`, this.activeRequest?.signal ?? new AbortController().signal);
            if (!outcome.startsWith('Applied file changes:')) {
                throw new Error('Permission to create the file was denied.');
            }
            return {
                result: outcome,
                resultSummary: `Created ${call.arguments.path}`,
                usedFiles: [uri.scheme === 'file' ? uri.fsPath : uri.toString()],
                mutationCharacters: call.arguments.content.length,
                mutationApplied: true
            };
        }
        if (call.name === 'edit_file') {
            await this.assertNoWorkspaceSymlink(folder, call.arguments.path, false);
            const uri = vscode.Uri.joinPath(folder.uri, ...call.arguments.path.split('/'));
            let document;
            try {
                document = await vscode.workspace.openTextDocument(uri);
            }
            catch {
                throw new Error(`${call.arguments.path} does not exist or cannot be opened.`);
            }
            if (document.isDirty) {
                throw new Error(`Save or discard your unsaved changes in ${call.arguments.path} before DevMate edits it.`);
            }
            const updatedContent = (0, fileTools_1.applyExactReplacements)(document.getText(), call.arguments.replacements);
            if (updatedContent.length > remainingMutationCharacters) {
                throw new Error('This request reached the total file-mutation size limit.');
            }
            const changes = (0, fileChanges_1.validateFileChanges)([{
                    path: call.arguments.path,
                    content: updatedContent
                }]);
            const outcome = await this.confirmAndApplyFileChanges(changes, `Edit ${call.arguments.path}`, this.activeRequest?.signal ?? new AbortController().signal);
            if (!outcome.startsWith('Applied file changes:')) {
                throw new Error('Permission to edit the file was denied.');
            }
            return {
                result: outcome,
                resultSummary: `Updated ${call.arguments.path}`,
                usedFiles: [uri.scheme === 'file' ? uri.fsPath : uri.toString()],
                mutationCharacters: updatedContent.length,
                mutationApplied: true
            };
        }
        if (call.name === 'delete_file') {
            return this.deleteAgentFile(call, folder, remainingMutationCharacters);
        }
        if (call.name === 'rename_file' || call.name === 'move_file') {
            return this.relocateAgentFile(call, folder);
        }
        if (call.name === 'list_files') {
            const uris = await this.findAgentFiles(folder, call.arguments.path);
            const relativePaths = uris
                .map((uri) => normalizeRelativeWorkspacePath(vscode.workspace.asRelativePath(uri, false)))
                .sort((left, right) => left.localeCompare(right))
                .slice(0, call.arguments.maxResults);
            const result = relativePaths.length > 0
                ? `Eligible files (${relativePaths.length}):\n${relativePaths.join('\n')}`
                : 'No eligible files were found at that path.';
            return {
                result,
                resultSummary: `${relativePaths.length} eligible ${relativePaths.length === 1 ? 'file' : 'files'}`,
                usedFiles: [],
                mutationCharacters: 0
            };
        }
        if (call.name === 'read_file') {
            const uri = vscode.Uri.joinPath(folder.uri, ...call.arguments.path.split('/'));
            const candidate = await this.readProjectCandidate(uri);
            if (!candidate
                || !agentPathMatches(normalizeRelativeWorkspacePath(candidate.relativePath), call.arguments.path)) {
                throw new Error('The file does not exist or is excluded from DevMate context.');
            }
            const lines = candidate.content.split(/\r?\n/);
            const startLine = call.arguments.startLine ?? 1;
            const endLine = Math.min(call.arguments.endLine ?? lines.length, lines.length);
            if (startLine > lines.length && lines.length > 0) {
                throw new Error(`${call.arguments.path} has only ${lines.length} lines.`);
            }
            const selectedContent = lines.slice(startLine - 1, endLine).join('\n');
            const result = (0, agentTools_1.truncateAgentToolResult)([
                `Path: ${call.arguments.path}`,
                `Language: ${candidate.languageId}`,
                `Lines: ${startLine}-${Math.max(startLine, endLine)} of ${lines.length}`,
                'Content:',
                selectedContent
            ].join('\n'));
            return {
                result,
                resultSummary: `${selectedContent.length} characters read`,
                usedFiles: [candidate.filePath],
                mutationCharacters: 0
            };
        }
        if (call.name === 'install_dependencies') {
            return this.runDependencyInstallation(call, folder);
        }
        if (call.name === 'run_command') {
            return this.runVerificationCommand(call, folder);
        }
        const uris = await this.findAgentFiles(folder, call.arguments.path);
        const query = call.arguments.query.toLocaleLowerCase();
        const matches = [];
        const usedFiles = new Set();
        const batchSize = 20;
        for (let offset = 0; offset < uris.length && matches.length < call.arguments.maxResults; offset += batchSize) {
            const candidates = await Promise.all(uris.slice(offset, offset + batchSize).map((uri) => this.readProjectCandidate(uri)));
            for (const candidate of candidates) {
                if (!candidate) {
                    continue;
                }
                const relativePath = normalizeRelativeWorkspacePath(candidate.relativePath);
                const lines = candidate.content.split(/\r?\n/);
                for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
                    if (!lines[lineIndex].toLocaleLowerCase().includes(query)) {
                        continue;
                    }
                    const snippet = lines[lineIndex].trim().slice(0, 240);
                    matches.push(`${relativePath}:${lineIndex + 1}: ${snippet}`);
                    usedFiles.add(candidate.filePath);
                    if (matches.length >= call.arguments.maxResults) {
                        break;
                    }
                }
                if (matches.length >= call.arguments.maxResults) {
                    break;
                }
            }
        }
        const result = matches.length > 0
            ? `Matches for "${call.arguments.query}" (${matches.length}):\n${matches.join('\n')}`
            : `No matches found for "${call.arguments.query}".`;
        return {
            result,
            resultSummary: `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`,
            usedFiles: [...usedFiles],
            mutationCharacters: 0
        };
    }
    async deleteAgentFile(call, folder, remainingMutationCharacters) {
        this.assertTrustedFileLifecycle();
        const source = await this.inspectAgentLifecycleFile(folder, call.arguments.path);
        if (source.content.length > remainingMutationCharacters) {
            throw new Error('This request reached the total file-mutation size limit.');
        }
        this.postStatus('Waiting for permission');
        const allowed = await this.requestFileChangePermission(`Delete ${call.arguments.path}`, [{
                path: call.arguments.path,
                operation: 'delete',
                originalContent: source.content,
                proposedContent: ''
            }]);
        if (!allowed) {
            throw new Error('Permission to delete the file was denied.');
        }
        const signal = this.activeRequest?.signal;
        if (signal?.aborted) {
            throw new Error('The file deletion was cancelled.');
        }
        this.assertTrustedFileLifecycle();
        await this.assertNoWorkspaceSymlink(folder, call.arguments.path, false);
        await this.revalidateAgentLifecycleFile(source);
        this.postStatus('Deleting file');
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.deleteFile(source.uri, { recursive: false, ignoreIfNotExists: false });
        if (!await vscode.workspace.applyEdit(workspaceEdit)) {
            throw new Error('VS Code could not delete the approved file.');
        }
        return {
            result: `Applied file changes:\n- Deleted ${call.arguments.path}`,
            resultSummary: `Deleted ${call.arguments.path}`,
            usedFiles: [source.displayPath],
            mutationCharacters: source.content.length,
            mutationApplied: true
        };
    }
    async relocateAgentFile(call, folder) {
        this.assertTrustedFileLifecycle();
        const source = await this.inspectAgentLifecycleFile(folder, call.arguments.path);
        await this.assertNoWorkspaceSymlink(folder, call.arguments.newPath, true);
        const destinationUri = vscode.Uri.joinPath(folder.uri, ...call.arguments.newPath.split('/'));
        await this.assertAgentLifecycleDestinationAvailable(destinationUri, call.arguments.newPath);
        const operation = call.name === 'rename_file' ? 'rename' : 'move';
        const operationLabel = operation === 'rename' ? 'Rename' : 'Move';
        this.postStatus('Waiting for permission');
        const allowed = await this.requestFileChangePermission(`${operationLabel} ${call.arguments.path} to ${call.arguments.newPath}`, [{
                path: `${call.arguments.path} → ${call.arguments.newPath}`,
                operation,
                originalContent: source.content,
                proposedContent: source.content
            }]);
        if (!allowed) {
            throw new Error(`Permission to ${operation} the file was denied.`);
        }
        const signal = this.activeRequest?.signal;
        if (signal?.aborted) {
            throw new Error(`The file ${operation} was cancelled.`);
        }
        this.assertTrustedFileLifecycle();
        await this.assertNoWorkspaceSymlink(folder, call.arguments.path, false);
        await this.assertNoWorkspaceSymlink(folder, call.arguments.newPath, true);
        await this.revalidateAgentLifecycleFile(source);
        await this.assertAgentLifecycleDestinationAvailable(destinationUri, call.arguments.newPath);
        const parentSegments = call.arguments.newPath.split('/').slice(0, -1);
        if (parentSegments.length > 0) {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, ...parentSegments));
        }
        this.postStatus(operation === 'rename' ? 'Renaming file' : 'Moving file');
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.renameFile(source.uri, destinationUri, {
            overwrite: false,
            ignoreIfExists: false
        });
        if (!await vscode.workspace.applyEdit(workspaceEdit)) {
            throw new Error(`VS Code could not ${operation} the approved file.`);
        }
        let openNote = '';
        try {
            const document = await vscode.workspace.openTextDocument(destinationUri);
            if (!await document.save()) {
                openNote = '\n\nThe file was relocated, but VS Code could not confirm it was saved.';
            }
            await vscode.window.showTextDocument(document, {
                viewColumn: vscode.ViewColumn.One,
                preview: false,
                preserveFocus: false
            });
        }
        catch {
            openNote = '\n\nThe file was relocated, but VS Code could not open the destination.';
        }
        return {
            result: `Applied file changes:\n- ${operation === 'rename' ? 'Renamed' : 'Moved'} `
                + `${call.arguments.path} to ${call.arguments.newPath}${openNote}`,
            resultSummary: `${operation === 'rename' ? 'Renamed' : 'Moved'} ${call.arguments.path}`,
            usedFiles: [
                source.displayPath,
                destinationUri.scheme === 'file' ? destinationUri.fsPath : destinationUri.toString()
            ],
            mutationCharacters: 0,
            mutationApplied: true
        };
    }
    assertTrustedFileLifecycle() {
        if (!vscode.workspace.isTrusted) {
            throw new Error('Trust this workspace before allowing DevMate to delete, rename, or move files.');
        }
    }
    async inspectAgentLifecycleFile(folder, relativePath) {
        await this.assertNoWorkspaceSymlink(folder, relativePath, false);
        const uri = vscode.Uri.joinPath(folder.uri, ...relativePath.split('/'));
        let stat;
        try {
            stat = await vscode.workspace.fs.stat(uri);
        }
        catch {
            throw new Error(`${relativePath} does not exist or cannot be inspected.`);
        }
        if ((stat.type & vscode.FileType.File) === 0) {
            throw new Error(`${relativePath} is not a file. Recursive directory operations are blocked.`);
        }
        if (stat.size > projectContext_1.MAX_PROJECT_FILE_BYTES) {
            throw new Error(`${relativePath} exceeds the file-size limit.`);
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        if ((0, projectContext_1.containsBinaryData)(bytes)) {
            throw new Error(`DevMate will not change binary content at ${relativePath}.`);
        }
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.isDirty) {
            throw new Error(`Save or discard your unsaved changes in ${relativePath} before DevMate changes it.`);
        }
        const content = document.getText();
        if (content.length > fileChanges_1.MAX_FILE_CHANGE_CHARACTERS) {
            throw new Error(`${relativePath} exceeds the per-file change limit.`);
        }
        return {
            path: relativePath,
            uri,
            displayPath: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
            content
        };
    }
    async revalidateAgentLifecycleFile(source) {
        let document;
        try {
            const stat = await vscode.workspace.fs.stat(source.uri);
            if ((stat.type & vscode.FileType.File) === 0) {
                throw new Error('The source is no longer a file.');
            }
            document = await vscode.workspace.openTextDocument(source.uri);
        }
        catch {
            throw new Error(`${source.path} changed while permission was pending. Review the request again.`);
        }
        if (document.isDirty || document.getText() !== source.content) {
            throw new Error(`${source.path} changed while permission was pending. Review the request again.`);
        }
    }
    async assertAgentLifecycleDestinationAvailable(uri, relativePath) {
        try {
            await vscode.workspace.fs.stat(uri);
            throw new Error(`${relativePath} already exists; choose a different destination.`);
        }
        catch (error) {
            if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
                throw error;
            }
        }
    }
    async runVerificationCommand(call, folder) {
        if (!vscode.workspace.isTrusted) {
            throw new Error('Trust this workspace before allowing DevMate to run verification commands.');
        }
        const cwdUri = call.arguments.cwd
            ? vscode.Uri.joinPath(folder.uri, ...call.arguments.cwd.split('/'))
            : folder.uri;
        if (call.arguments.cwd) {
            await this.assertNoWorkspaceSymlink(folder, call.arguments.cwd, false);
        }
        if (call.arguments.executable.startsWith('./')) {
            await this.assertNoWorkspaceSymlink(folder, [call.arguments.cwd, call.arguments.executable.slice(2)].filter(Boolean).join('/'), false);
        }
        try {
            const stat = await vscode.workspace.fs.stat(cwdUri);
            if ((stat.type & vscode.FileType.Directory) === 0) {
                throw new Error('The command working directory is not a directory.');
            }
        }
        catch (error) {
            throw new Error(error instanceof Error
                ? `Cannot use the command working directory: ${error.message}`
                : 'Cannot use the command working directory.');
        }
        const requestedCommand = call.arguments;
        const resolvedPython = await this.resolveWorkspacePythonCommand(requestedCommand, folder);
        const command = resolvedPython.command;
        const requestedLabel = (0, commandTools_1.commandLabel)(requestedCommand);
        const label = resolvedPython.environment
            ? `${requestedLabel} · ${resolvedPython.environment}`
            : requestedLabel;
        const signature = (0, commandTools_1.commandSignature)(command);
        const allowed = await this.requestCommandPermission(signature, label, command.cwd);
        if (!allowed) {
            throw new Error('Permission to run the verification command was denied.');
        }
        if (!vscode.workspace.isTrusted) {
            throw new Error('Workspace Trust changed while command permission was pending; the command was not run.');
        }
        const signal = this.activeRequest?.signal ?? new AbortController().signal;
        if (signal.aborted) {
            throw new Error('The verification command was cancelled.');
        }
        const configuredTimeout = vscode.workspace.getConfiguration('devMate').get('commandTimeoutSeconds', commandTools_1.DEFAULT_COMMAND_TIMEOUT_SECONDS);
        const timeoutSeconds = Math.min(command.timeoutSeconds, commandTools_1.MAX_COMMAND_TIMEOUT_SECONDS, Math.max(commandTools_1.MIN_COMMAND_TIMEOUT_SECONDS, configuredTimeout));
        const terminal = vscode.window.createTerminal({
            name: `DevMate: ${label.slice(0, 60)}`,
            cwd: cwdUri,
            isTransient: true
        });
        this.commandTerminals.set(call.id, terminal);
        const shellIntegration = await this.waitForShellIntegration(terminal, signal);
        if (!shellIntegration) {
            terminal.dispose();
            this.commandTerminals.delete(call.id);
            throw new Error('VS Code terminal shell integration was unavailable after 5 seconds; the command was not run.');
        }
        const execution = shellIntegration.executeCommand(command.executable, command.args);
        const startedAt = Date.now();
        let output = '';
        const outputReader = (async () => {
            for await (const data of execution.read()) {
                output = (0, commandTools_1.sanitizeCommandOutput)(output + data);
                this.postAgentToolActivity(call.id, 'Running verification command', label, 'running', output, true);
            }
        })();
        const outcome = await new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                signal.removeEventListener('abort', cancel);
                endDisposable.dispose();
                resolve(value);
            };
            const endDisposable = vscode.window.onDidEndTerminalShellExecution((event) => {
                if (event.execution === execution) {
                    finish({ state: 'completed', exitCode: event.exitCode });
                }
            });
            const cancel = () => {
                terminal.dispose();
                finish({ state: 'cancelled' });
            };
            const timeout = setTimeout(() => {
                terminal.dispose();
                finish({ state: 'timeout' });
            }, timeoutSeconds * 1_000);
            signal.addEventListener('abort', cancel, { once: true });
        });
        await Promise.race([outputReader, wait(250)]);
        const durationSeconds = Math.max(0, (Date.now() - startedAt) / 1_000);
        const modelOutput = (0, commandTools_1.boundedModelCommandOutput)(output);
        const result = [
            `Command: ${requestedLabel}`,
            ...((0, pythonEnvironment_1.isPythonVerificationCommand)(requestedCommand)
                ? [`Python environment: ${resolvedPython.environment ?? `PATH lookup (${requestedCommand.executable})`}`]
                : []),
            `Working directory: ${command.cwd || '.'}`,
            outcome.state === 'completed'
                ? `Exit code: ${outcome.exitCode ?? 'unknown'}`
                : outcome.state === 'timeout'
                    ? `Timed out after ${timeoutSeconds} seconds`
                    : 'Cancelled',
            `Duration: ${durationSeconds.toFixed(1)} seconds`,
            modelOutput ? `Output:\n${modelOutput}` : 'Output: (none)'
        ].join('\n');
        if (outcome.state === 'cancelled') {
            this.commandTerminals.delete(call.id);
            throw new StartedCommandError('The verification command was cancelled.');
        }
        if (outcome.state === 'timeout') {
            this.commandTerminals.delete(call.id);
            throw new StartedCommandError(result);
        }
        if (outcome.exitCode !== 0) {
            throw new StartedCommandError(result, (0, pythonEnvironment_1.extractMissingPythonModule)(modelOutput), resolvedPython.environment);
        }
        return {
            result,
            resultSummary: `Passed in ${durationSeconds.toFixed(1)}s`,
            usedFiles: [],
            mutationCharacters: 0,
            commandAttempted: true
        };
    }
    async runDependencyInstallation(call, folder) {
        if (!vscode.workspace.isTrusted) {
            throw new Error('Trust this workspace before allowing DevMate to install dependencies.');
        }
        if (folder.uri.scheme !== 'file') {
            throw new Error('Python dependency installation currently requires a local filesystem workspace.');
        }
        const initialManifest = await this.readDependencyManifest(folder, call.arguments.manifestPath);
        const cwdUri = call.arguments.cwd
            ? vscode.Uri.joinPath(folder.uri, ...call.arguments.cwd.split('/'))
            : folder.uri;
        const probeCommand = {
            executable: process.platform === 'win32' ? 'py' : 'python3',
            args: [],
            cwd: call.arguments.cwd,
            timeoutSeconds: call.arguments.timeoutSeconds
        };
        const existingPython = await this.resolveWorkspacePythonCommand(probeCommand, folder);
        const targetEnvironment = [call.arguments.cwd, '.venv'].filter(Boolean).join('/');
        const willCreateEnvironment = !existingPython.environment;
        if (willCreateEnvironment) {
            const targetUri = vscode.Uri.joinPath(folder.uri, ...targetEnvironment.split('/'));
            try {
                await vscode.workspace.fs.stat(targetUri);
                throw new Error(`${targetEnvironment} already exists but does not contain a supported Python interpreter. `
                    + 'Repair or remove it manually before installing dependencies.');
            }
            catch (error) {
                if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
                    throw error;
                }
            }
        }
        const environmentLabel = existingPython.environment ?? targetEnvironment;
        const requirementSummary = initialManifest.requirements.length === 1
            ? initialManifest.requirements[0]
            : `${initialManifest.requirements.length} requirements`;
        const allowed = await this.requestCommandPermission((0, crypto_1.randomUUID)(), `${willCreateEnvironment ? `Create ${targetEnvironment} and install` : 'Install'} ${requirementSummary} from ${call.arguments.manifestPath}`, call.arguments.cwd, {
            rememberable: false,
            title: 'Permission required to install Python dependencies',
            warning: 'This downloads packages and may execute package build or installation code. Installation is restricted to the validated manifest and project-local virtual environment.'
        });
        if (!allowed) {
            throw new Error('Permission to install dependencies was denied.');
        }
        if (!vscode.workspace.isTrusted) {
            throw new Error('Workspace Trust changed while installation permission was pending; nothing was installed.');
        }
        const currentManifest = await this.readDependencyManifest(folder, call.arguments.manifestPath);
        if (currentManifest.content !== initialManifest.content) {
            throw new Error('The dependency manifest changed during approval; review the updated file and try again.');
        }
        let approvedPython = existingPython;
        if (willCreateEnvironment) {
            const targetUri = vscode.Uri.joinPath(folder.uri, ...targetEnvironment.split('/'));
            try {
                await vscode.workspace.fs.stat(targetUri);
                throw new Error(`${targetEnvironment} appeared during approval; inspect it before trying again.`);
            }
            catch (error) {
                if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
                    throw error;
                }
            }
        }
        else {
            approvedPython = await this.resolveWorkspacePythonCommand(probeCommand, folder);
            if (approvedPython.environment !== existingPython.environment) {
                throw new Error('The selected Python environment changed during approval; inspect it and try again.');
            }
        }
        const signal = this.activeRequest?.signal ?? new AbortController().signal;
        if (signal.aborted) {
            throw new Error('The dependency installation was cancelled.');
        }
        const configuredTimeout = vscode.workspace.getConfiguration('devMate').get('commandTimeoutSeconds', commandTools_1.DEFAULT_COMMAND_TIMEOUT_SECONDS);
        const timeoutSeconds = Math.min(call.arguments.timeoutSeconds, commandTools_1.MAX_COMMAND_TIMEOUT_SECONDS, Math.max(commandTools_1.MIN_COMMAND_TIMEOUT_SECONDS, configuredTimeout));
        const terminal = vscode.window.createTerminal({
            name: `DevMate: install ${path.posix.basename(call.arguments.manifestPath)}`,
            cwd: cwdUri,
            isTransient: true
        });
        this.commandTerminals.set(call.id, terminal);
        const shellIntegration = await this.waitForShellIntegration(terminal, signal);
        if (!shellIntegration) {
            terminal.dispose();
            this.commandTerminals.delete(call.id);
            throw new Error('VS Code terminal shell integration was unavailable after 5 seconds; dependencies were not installed.');
        }
        const startedAt = Date.now();
        const deadline = startedAt + timeoutSeconds * 1_000;
        let combinedOutput = '';
        const runStep = async (executable, args, label) => {
            const remainingMilliseconds = Math.max(1, deadline - Date.now());
            combinedOutput = (0, commandTools_1.sanitizeCommandOutput)(`${combinedOutput}${combinedOutput ? '\n' : ''}> ${label}\n`);
            const step = await this.executeTerminalStep(terminal, shellIntegration, executable, args, remainingMilliseconds, signal, (output) => {
                combinedOutput = (0, commandTools_1.sanitizeCommandOutput)(combinedOutput + output);
                this.postAgentToolActivity(call.id, 'Installing Python dependencies', `${call.arguments.manifestPath} → ${environmentLabel}`, 'running', combinedOutput, true);
            });
            if (step.state === 'cancelled') {
                this.commandTerminals.delete(call.id);
                throw new StartedDependencyInstallError('The dependency installation was cancelled.');
            }
            if (step.state === 'timeout') {
                this.commandTerminals.delete(call.id);
                throw new StartedDependencyInstallError(`Dependency installation timed out after ${timeoutSeconds} seconds.\n\n${(0, commandTools_1.boundedModelCommandOutput)(combinedOutput)}`);
            }
            if (step.exitCode !== 0) {
                throw new StartedDependencyInstallError([
                    `${label} failed with exit code ${step.exitCode ?? 'unknown'}.`,
                    (0, commandTools_1.boundedModelCommandOutput)(combinedOutput)
                ].join('\n\n'));
            }
        };
        let pythonExecutable = approvedPython.command.executable;
        if (willCreateEnvironment) {
            const launcher = process.platform === 'win32' ? 'py' : 'python3';
            await runStep(launcher, ['-m', 'venv', '.venv'], `${launcher} -m venv .venv`);
            const createdCandidate = (0, pythonEnvironment_1.workspacePythonCandidates)(call.arguments.cwd)[0];
            await this.assertNoWorkspaceSymlink(folder, createdCandidate, false);
            const createdUri = vscode.Uri.joinPath(folder.uri, ...createdCandidate.split('/'));
            const createdStat = await vscode.workspace.fs.stat(createdUri);
            if ((createdStat.type & vscode.FileType.File) === 0) {
                throw new StartedDependencyInstallError('The virtual environment was created without a usable Python interpreter.');
            }
            pythonExecutable = (0, pythonEnvironment_1.workspacePythonExecutable)(createdCandidate, call.arguments.cwd);
        }
        const manifestName = path.posix.basename(call.arguments.manifestPath);
        await runStep(pythonExecutable, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', manifestName], `${environmentLabel} -m pip install -r ${manifestName}`);
        const durationSeconds = Math.max(0, (Date.now() - startedAt) / 1_000);
        const result = [
            `Manifest: ${call.arguments.manifestPath}`,
            `Python environment: ${environmentLabel}`,
            `Installed requirements: ${initialManifest.requirements.join(', ')}`,
            `Duration: ${durationSeconds.toFixed(1)} seconds`,
            (0, commandTools_1.boundedModelCommandOutput)(combinedOutput)
        ].join('\n');
        return {
            result,
            resultSummary: `Installed ${initialManifest.requirements.length} ${initialManifest.requirements.length === 1 ? 'requirement' : 'requirements'} into ${environmentLabel}`,
            usedFiles: [initialManifest.uri.fsPath],
            mutationCharacters: 0,
            installAttempted: true,
            environmentChanged: true
        };
    }
    async readDependencyManifest(folder, manifestPath) {
        await this.assertNoWorkspaceSymlink(folder, manifestPath, false);
        const uri = vscode.Uri.joinPath(folder.uri, ...manifestPath.split('/'));
        const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
        if (openDocument?.isDirty) {
            throw new Error(`Save or discard your unsaved changes in ${manifestPath} before installing dependencies.`);
        }
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.File) === 0 || stat.size > dependencyTools_1.MAX_DEPENDENCY_MANIFEST_BYTES) {
            throw new Error('The dependency manifest is not a supported text file or exceeds 64 KB.');
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        if ((0, projectContext_1.containsBinaryData)(bytes)) {
            throw new Error('The dependency manifest contains binary data.');
        }
        let content;
        try {
            content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        }
        catch {
            throw new Error('The dependency manifest must be valid UTF-8 text.');
        }
        return {
            uri,
            content,
            requirements: (0, dependencyTools_1.validatePythonRequirementsManifest)(content)
        };
    }
    async executeTerminalStep(terminal, shellIntegration, executable, args, timeoutMilliseconds, signal, onOutput) {
        const execution = shellIntegration.executeCommand(executable, args);
        const outputReader = (async () => {
            for await (const data of execution.read()) {
                onOutput(data);
            }
        })();
        const outcome = await new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                signal.removeEventListener('abort', cancel);
                endDisposable.dispose();
                resolve(value);
            };
            const endDisposable = vscode.window.onDidEndTerminalShellExecution((event) => {
                if (event.execution === execution) {
                    finish({ state: 'completed', exitCode: event.exitCode });
                }
            });
            const cancel = () => {
                terminal.dispose();
                finish({ state: 'cancelled' });
            };
            const timeout = setTimeout(() => {
                terminal.dispose();
                finish({ state: 'timeout' });
            }, timeoutMilliseconds);
            signal.addEventListener('abort', cancel, { once: true });
        });
        await Promise.race([outputReader, wait(250)]);
        return outcome;
    }
    async resolveWorkspacePythonCommand(command, folder) {
        if (!(0, pythonEnvironment_1.isPythonVerificationCommand)(command) || folder.uri.scheme !== 'file') {
            return { command };
        }
        for (const candidate of (0, pythonEnvironment_1.workspacePythonCandidates)(command.cwd)) {
            try {
                await this.assertNoWorkspaceSymlink(folder, candidate, false);
                const uri = vscode.Uri.joinPath(folder.uri, ...candidate.split('/'));
                const stat = await vscode.workspace.fs.stat(uri);
                if ((stat.type & vscode.FileType.File) !== 0) {
                    return {
                        command: {
                            ...command,
                            executable: (0, pythonEnvironment_1.workspacePythonExecutable)(candidate, command.cwd)
                        },
                        environment: candidate
                    };
                }
            }
            catch {
                // Missing, inaccessible, and symbolic-link environments are ignored safely.
            }
        }
        return { command };
    }
    waitForShellIntegration(terminal, signal) {
        if (terminal.shellIntegration) {
            return Promise.resolve(terminal.shellIntegration);
        }
        return new Promise((resolve) => {
            const finish = (integration) => {
                clearTimeout(timeout);
                signal.removeEventListener('abort', cancel);
                disposable.dispose();
                resolve(integration);
            };
            const cancel = () => finish();
            const disposable = vscode.window.onDidChangeTerminalShellIntegration((event) => {
                if (event.terminal === terminal) {
                    finish(event.shellIntegration);
                }
            });
            const timeout = setTimeout(() => finish(), 5_000);
            signal.addEventListener('abort', cancel, { once: true });
        });
    }
    disposeCommandTerminals() {
        for (const terminal of this.commandTerminals.values()) {
            terminal.dispose();
        }
        this.commandTerminals.clear();
    }
    async findAgentFiles(folder, requestedPath) {
        const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), projectContext_1.PROJECT_EXCLUDE_GLOB, projectContext_1.MAX_ATTACHMENT_CANDIDATES);
        return uris
            .filter((uri) => {
            const relativePath = normalizeRelativeWorkspacePath(vscode.workspace.asRelativePath(uri, false));
            return !(0, projectContext_1.shouldSkipProjectFile)(relativePath)
                && (!requestedPath
                    || agentPathMatches(relativePath, requestedPath)
                    || agentPathStartsWith(relativePath, requestedPath));
        })
            .sort((left, right) => vscode.workspace.asRelativePath(left, false).localeCompare(vscode.workspace.asRelativePath(right, false)))
            .slice(0, projectContext_1.MAX_PROJECT_CANDIDATES);
    }
    async assertNoWorkspaceSymlink(folder, relativePath, allowMissing) {
        const segments = relativePath.split('/').filter(Boolean);
        for (let index = 1; index <= segments.length; index += 1) {
            const uri = vscode.Uri.joinPath(folder.uri, ...segments.slice(0, index));
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
                    throw new Error(`DevMate will not use the symbolic-link path ${segments.slice(0, index).join('/')}.`);
                }
            }
            catch (error) {
                if (allowMissing && error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
                    return;
                }
                throw error;
            }
        }
    }
    postAgentToolActivity(id, title, detail, status, result, canOpenTerminal = false) {
        this.postMessage({
            command: 'agentToolActivity',
            activity: { id, title, detail, status, result, canOpenTerminal }
        });
    }
    enabledAgentTools(mode, fileMutationCalls, commandCalls, dependencyInstallCalls) {
        const tools = ['list_files', 'read_file', 'search_code'];
        if (mode === 'ideas' || !vscode.workspace.isTrusted) {
            return tools;
        }
        if (fileMutationCalls < agentTools_1.MAX_AGENT_FILE_MUTATIONS) {
            tools.push('create_file', 'edit_file', 'delete_file', 'rename_file', 'move_file');
        }
        if (dependencyInstallCalls < agentTools_1.MAX_AGENT_DEPENDENCY_INSTALLS) {
            tools.push('install_dependencies');
        }
        if (commandCalls < agentTools_1.MAX_AGENT_COMMAND_CALLS) {
            tools.push('run_command');
        }
        return tools;
    }
    rejectedToolExecution(call, result) {
        let historyArguments = call.arguments;
        try {
            historyArguments = (0, agentTools_1.summarizedAgentToolArguments)((0, agentTools_1.parseAgentToolCall)(call));
        }
        catch {
            // Keep the provider's bounded raw arguments for an invalid call.
        }
        this.postAgentToolActivity(call.id, 'Tool request rejected', call.name, 'error', result);
        return {
            step: {
                callId: call.id,
                name: call.name,
                arguments: historyArguments,
                result,
                isError: true
            },
            usedFiles: [],
            mutationCharacters: 0
        };
    }
    async askWithProviderRetries(backendUrl, request, providerApiKey, timeoutMilliseconds, signal) {
        let retryNumber = 0;
        while (true) {
            this.postMessage({ command: 'providerStreamReset' });
            const waitingTimer = setTimeout(() => {
                this.postStatus('Waiting for model response — the selected model is still working');
            }, 15_000);
            let receivedStreamText = false;
            let pendingStreamText = '';
            let streamFlushTimer;
            const flushStreamText = () => {
                if (!pendingStreamText) {
                    return;
                }
                this.postMessage({ command: 'providerStreamDelta', text: pendingStreamText });
                pendingStreamText = '';
            };
            let result;
            try {
                const streamAttempt = await (0, client_1.askStream)(backendUrl, request, providerApiKey, timeoutMilliseconds, signal, (event) => {
                    clearTimeout(waitingTimer);
                    if (event.type === 'delta') {
                        if (!receivedStreamText) {
                            receivedStreamText = true;
                            this.postStatus('Receiving model response');
                        }
                        pendingStreamText += event.text;
                        if (!streamFlushTimer) {
                            streamFlushTimer = setTimeout(() => {
                                streamFlushTimer = undefined;
                                flushStreamText();
                            }, 40);
                        }
                    }
                    else {
                        this.postStatus(event.phase);
                    }
                });
                if (streamAttempt.unsupported) {
                    this.postStatus('Live streaming unavailable — waiting for the completed response');
                    result = await (0, client_1.ask)(backendUrl, request, providerApiKey, timeoutMilliseconds, signal);
                    if (result.status === 'ok'
                        && result.data?.answer
                        && (result.data.toolCalls?.length ?? 0) === 0) {
                        receivedStreamText = true;
                        this.postStatus('Receiving model response');
                        pendingStreamText += result.data.answer;
                    }
                }
                else {
                    result = streamAttempt.result;
                }
            }
            finally {
                clearTimeout(waitingTimer);
                if (streamFlushTimer) {
                    clearTimeout(streamFlushTimer);
                }
                flushStreamText();
            }
            if (!(0, retryPolicy_1.isRetryableProviderFailure)(result)) {
                return { result, retriesExhausted: false };
            }
            retryNumber += 1;
            const delay = (0, retryPolicy_1.providerRetryDelay)(retryNumber);
            if (delay === undefined) {
                return { result, retriesExhausted: true };
            }
            this.postStatus(`Provider busy — retrying ${retryNumber}/${retryPolicy_1.PROVIDER_RETRY_DELAYS_MS.length} in ${delay / 1_000}s`);
            const delayCompleted = await waitForRetryDelay(delay, signal);
            if (!delayCompleted) {
                return {
                    result: {
                        status: 'error',
                        message: 'Request cancelled.',
                        errorKind: 'cancelled'
                    },
                    retriesExhausted: false
                };
            }
        }
    }
    async answerQuestion(message, signal) {
        const question = message.question.trim();
        if (!question) {
            this.postRequestFailure('Enter a question before asking.', { level: 'warning' });
            return;
        }
        const activeSession = (0, sessions_1.activeConversationSession)(this.sessionStore);
        if (!activeSession || !(0, sessions_1.sessionBelongsToWorkspace)(activeSession, this.getConversationWorkspace())) {
            this.postRequestFailure('Choose a session for the currently open project before asking.', { level: 'warning' });
            return;
        }
        const activeProfile = this.getActiveLlmProfile();
        if (!activeProfile) {
            this.postRequestFailure('Add a model profile before asking.', { level: 'warning' });
            await this.showLlmProfileForm();
            return;
        }
        this.postStatus('Checking local backend');
        if (!await this.backendManager.start()) {
            this.postRequestFailure(this.backendManager.status.detail, { level: 'warning' });
            return;
        }
        this.postStatus('Collecting context');
        const collectedScope = await this.collectScope(message.scope.kind, question);
        if (this.finishCancelledRequest(signal)) {
            return;
        }
        if (!collectedScope) {
            this.postRequestFailure(message.scope.kind === 'selection' ? 'Select code first.' : 'Open a file first.', { level: 'warning' });
            return;
        }
        this.postMessage({ command: 'scopeUpdated', scope: collectedScope.info });
        await wait(250);
        if (this.finishCancelledRequest(signal)) {
            return;
        }
        this.postStatus('Generating answer');
        await wait(350);
        if (this.finishCancelledRequest(signal)) {
            return;
        }
        const config = vscode.workspace.getConfiguration('devMate');
        const maxTokens = config.get('maxTokens', 16384);
        const temperature = config.get('temperature', 0.2);
        const toolCallLimit = (0, agentTools_1.boundedAgentToolCallLimit)(config.get('toolCallLimit', agentTools_1.DEFAULT_AGENT_TOOL_CALL_LIMIT));
        const modelTimeoutSeconds = Math.min(1800, Math.max(10, config.get('requestTimeoutSeconds', 900)));
        const providerApiKey = activeProfile.provider === 'openai'
            ? await this.extensionContext.secrets.get((0, llmProfiles_1.secretKeyForProfile)(activeProfile.id))
            : undefined;
        if (activeProfile.provider === 'openai' && !providerApiKey) {
            this.postRequestFailure('The selected model profile is missing an API key.', {
                level: 'warning',
                retryable: true
            });
            await this.showLlmProfileForm(activeProfile);
            return;
        }
        const toolHistory = [];
        const toolUsedFiles = new Set();
        const toolSignatures = new Map();
        let fileMutationCalls = 0;
        let mutationCharacters = 0;
        let commandCalls = 0;
        let dependencyInstallCalls = 0;
        let workspaceRevision = 0;
        let forceFinalAnswer = false;
        let emptyResponseRecoveryAttempted = false;
        let finalData;
        while (!finalData) {
            if (this.finishCancelledRequest(signal)) {
                return;
            }
            const forceFinalThisTurn = forceFinalAnswer
                || toolHistory.length >= toolCallLimit;
            const enabledTools = forceFinalThisTurn
                ? []
                : this.enabledAgentTools(message.mode, fileMutationCalls, commandCalls, dependencyInstallCalls);
            const toolsEnabled = enabledTools.length > 0;
            const request = {
                question,
                mode: message.mode,
                scope: collectedScope.apiScope,
                settings: {
                    provider: activeProfile.provider,
                    model: activeProfile.model,
                    baseUrl: activeProfile.baseUrl,
                    maxTokens,
                    temperature,
                    timeoutSeconds: modelTimeoutSeconds
                },
                enabledTools,
                agentEditsEnabled: message.mode === 'code' || message.mode === 'debug',
                forceFinalAnswer: forceFinalThisTurn,
                toolHistory: (0, agentTools_1.compactAgentToolHistory)(toolHistory),
                conversationHistory: (0, sessions_1.activeSessionModelHistory)(this.sessionStore)
            };
            this.postStatus(forceFinalThisTurn
                ? 'Requesting concise final answer'
                : toolsEnabled && toolHistory.length > 0
                    ? 'Continuing with project context'
                    : 'Generating answer');
            const providerAttempt = await this.askWithProviderRetries(getBackendUrl(), request, providerApiKey, (modelTimeoutSeconds + 30) * 1_000, signal);
            const result = providerAttempt.result;
            if (this.finishCancelledRequest(signal)) {
                return;
            }
            if (result.status === 'error' || !result.data) {
                const errorMessage = result.message ?? 'Ask request failed.';
                if (!forceFinalThisTurn
                    && !emptyResponseRecoveryAttempted
                    && isRecoverableEmptyModelResponse(errorMessage)) {
                    emptyResponseRecoveryAttempted = true;
                    forceFinalAnswer = true;
                    this.postStatus('Model returned no final answer — retrying without tools');
                    continue;
                }
                const backendDropped = result.errorKind === 'network';
                if (backendDropped) {
                    this.postStatus('Backend connection dropped — recovering local backend');
                    await this.backendManager.start();
                }
                this.postRequestFailure(errorMessage, {
                    retryable: providerAttempt.retriesExhausted || backendDropped
                });
                return;
            }
            const toolCalls = result.data.toolCalls ?? [];
            if (toolCalls.length === 0) {
                finalData = result.data;
                break;
            }
            if (!toolsEnabled) {
                this.postRequestFailure('The model exceeded the project-tool limit.');
                return;
            }
            let executedCalls = 0;
            for (const rawToolCall of toolCalls) {
                if (toolHistory.length >= toolCallLimit) {
                    break;
                }
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                const toolCall = workspaceFolder
                    ? (0, agentTools_1.normalizeAgentToolCallForWorkspace)(rawToolCall, {
                        name: workspaceFolder.name,
                        fsPath: workspaceFolder.uri.scheme === 'file' ? workspaceFolder.uri.fsPath : undefined
                    })
                    : rawToolCall;
                if (toolHistory.some((step) => step.callId === toolCall.id)) {
                    this.postRequestFailure('The model reused an invalid tool-call id.');
                    return;
                }
                let signature;
                try {
                    signature = (0, agentTools_1.agentToolCallSignature)(toolCall);
                }
                catch {
                    // The executor reports the validated tool error back to the model.
                }
                let execution;
                const isFileMutation = toolCall.name === 'create_file'
                    || toolCall.name === 'edit_file'
                    || toolCall.name === 'delete_file'
                    || toolCall.name === 'rename_file'
                    || toolCall.name === 'move_file';
                const isCommand = toolCall.name === 'run_command';
                const isDependencyInstall = toolCall.name === 'install_dependencies';
                const isReadOnly = toolCall.name === 'list_files'
                    || toolCall.name === 'read_file'
                    || toolCall.name === 'search_code';
                const priorSignature = signature ? toolSignatures.get(signature) : undefined;
                const repeatedAtCurrentRevision = priorSignature?.revision === workspaceRevision;
                if (isFileMutation && fileMutationCalls >= agentTools_1.MAX_AGENT_FILE_MUTATIONS) {
                    execution = this.rejectedToolExecution(toolCall, 'DevMate reached the file-mutation limit for this request.');
                    forceFinalAnswer = true;
                }
                else if (isCommand && commandCalls >= agentTools_1.MAX_AGENT_COMMAND_CALLS) {
                    execution = this.rejectedToolExecution(toolCall, 'DevMate reached the verification-command limit for this request.');
                    forceFinalAnswer = true;
                }
                else if (isDependencyInstall
                    && dependencyInstallCalls >= agentTools_1.MAX_AGENT_DEPENDENCY_INSTALLS) {
                    execution = this.rejectedToolExecution(toolCall, 'DevMate reached the dependency-installation limit for this request.');
                    forceFinalAnswer = true;
                }
                else if (signature
                    && priorSignature
                    && (isFileMutation
                        || isDependencyInstall
                        || (repeatedAtCurrentRevision && (!isReadOnly || priorSignature.executions >= 2)))) {
                    const repeatedResult = 'This identical tool call was already completed. Use its earlier result.';
                    this.postAgentToolActivity(toolCall.id, 'Skipped repeated tool call', toolCall.name, 'error', repeatedResult);
                    execution = {
                        step: {
                            callId: toolCall.id,
                            name: toolCall.name,
                            arguments: (() => {
                                try {
                                    return (0, agentTools_1.summarizedAgentToolArguments)((0, agentTools_1.parseAgentToolCall)(toolCall));
                                }
                                catch {
                                    return toolCall.arguments;
                                }
                            })(),
                            result: repeatedResult,
                            isError: true
                        },
                        usedFiles: [],
                        mutationCharacters: 0
                    };
                    forceFinalAnswer = true;
                }
                else {
                    execution = await this.executeAgentToolCall(toolCall, fileChanges_1.MAX_TOTAL_CHANGE_CHARACTERS - mutationCharacters);
                    mutationCharacters += execution.mutationCharacters;
                    if (isFileMutation && execution.mutationApplied) {
                        fileMutationCalls += 1;
                        workspaceRevision += 1;
                    }
                    if (isCommand && execution.commandAttempted) {
                        commandCalls += 1;
                    }
                    if (isDependencyInstall && execution.installAttempted) {
                        dependencyInstallCalls += 1;
                    }
                    if (execution.environmentChanged) {
                        workspaceRevision += 1;
                    }
                    if (isDependencyInstall
                        && execution.step.isError
                        && /permission to install dependencies was denied/i.test(execution.step.result)) {
                        forceFinalAnswer = true;
                    }
                    if (signature
                        && (!execution.step.isError || execution.commandAttempted || execution.installAttempted)) {
                        const previous = toolSignatures.get(signature);
                        toolSignatures.set(signature, {
                            revision: workspaceRevision,
                            executions: previous?.revision === workspaceRevision
                                ? previous.executions + 1
                                : 1
                        });
                    }
                }
                if (this.finishCancelledRequest(signal)) {
                    return;
                }
                toolHistory.push(execution.step);
                execution.usedFiles.forEach((file) => toolUsedFiles.add(file));
                executedCalls += 1;
            }
            if (executedCalls === 0) {
                this.postRequestFailure('The model could not complete a valid project tool call.');
                return;
            }
        }
        if (this.finishCancelledRequest(signal)) {
            return;
        }
        let changeOutcome = '';
        try {
            const fileChanges = (0, fileChanges_1.validateFileChanges)(finalData.changes ?? []);
            if (fileChanges.length > 0) {
                changeOutcome = await this.confirmAndApplyFileChanges(fileChanges, finalData.answer, signal);
                if (signal.aborted
                    && !changeOutcome.startsWith('Applied file changes:')
                    && this.finishCancelledRequest(signal)) {
                    return;
                }
            }
        }
        catch (error) {
            changeOutcome = error instanceof Error
                ? `Changes were not applied: ${error.message}`
                : 'Changes were not applied because the response was invalid.';
            this.postStatus(changeOutcome, 'error');
        }
        const response = [
            formatAskResponse(finalData.answer, [...new Set([...finalData.usedFiles, ...toolUsedFiles])]),
            changeOutcome
        ].filter(Boolean).join('\n\n');
        this.sessionStore = (0, sessions_1.appendConversationSessionTurn)(this.sessionStore, question, response, Date.now());
        await this.persistSessionStore();
        this.postMessage({
            command: 'assistantResponse',
            response
        });
        this.postSessionState(false);
        this.postStatus('Ready');
    }
    async confirmAndApplyFileChanges(changes, summary, signal) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            throw new Error('Open a workspace folder before applying file changes.');
        }
        if (!vscode.workspace.isTrusted) {
            throw new Error('Trust this workspace before allowing DevMate to change files.');
        }
        const plannedChanges = await Promise.all(changes.map(async (change) => {
            await this.assertNoWorkspaceSymlink(folder, change.path, true);
            const uri = vscode.Uri.joinPath(folder.uri, ...change.path.split('/'));
            let exists = false;
            let originalContent = '';
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if ((stat.type & vscode.FileType.Directory) !== 0) {
                    throw new Error(`${change.path} is a directory, not a file.`);
                }
                exists = true;
                const document = await vscode.workspace.openTextDocument(uri);
                if (document.isDirty) {
                    throw new Error(`Save or discard your unsaved changes in ${change.path} before DevMate edits it.`);
                }
                originalContent = document.getText();
            }
            catch (error) {
                if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
                    throw new Error(error instanceof Error
                        ? `Could not inspect ${change.path}: ${error.message}`
                        : `Could not inspect ${change.path}.`);
                }
            }
            return { ...change, uri, exists, originalContent };
        }));
        const permissionFiles = plannedChanges.map((change) => ({
            path: change.path,
            operation: change.exists ? 'update' : 'create',
            originalContent: change.originalContent,
            proposedContent: change.content
        }));
        const permissionPolicy = this.getPermissionPolicy();
        const requiresApproval = permissionFiles.some((file) => (0, permissions_1.permissionBehaviorForAction)(permissionPolicy, file.operation) === 'ask');
        if (requiresApproval) {
            this.postStatus('Waiting for permission');
            const allowed = await this.requestFileChangePermission(summary, permissionFiles);
            if (!allowed) {
                return 'Proposed file changes were not applied.';
            }
        }
        if (signal.aborted) {
            return 'Proposed file changes were not applied.';
        }
        if (!vscode.workspace.isTrusted) {
            throw new Error('Workspace Trust changed while permission was pending; the files were not changed.');
        }
        for (const change of plannedChanges) {
            if (change.exists) {
                const document = await vscode.workspace.openTextDocument(change.uri);
                if (document.isDirty || document.getText() !== change.originalContent) {
                    throw new Error(`${change.path} changed while permission was pending. Review the request again.`);
                }
            }
            else {
                try {
                    await vscode.workspace.fs.stat(change.uri);
                    throw new Error(`${change.path} was created while permission was pending. Review the request again.`);
                }
                catch (error) {
                    if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
                        throw error;
                    }
                }
            }
        }
        this.postStatus('Applying file changes');
        for (const change of plannedChanges.filter((item) => !item.exists)) {
            const parentSegments = change.path.split('/').slice(0, -1);
            if (parentSegments.length > 0) {
                await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, ...parentSegments));
            }
        }
        const workspaceEdit = new vscode.WorkspaceEdit();
        for (const change of plannedChanges) {
            if (change.exists) {
                const document = await vscode.workspace.openTextDocument(change.uri);
                const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
                workspaceEdit.replace(change.uri, fullRange, change.content);
            }
            else {
                workspaceEdit.createFile(change.uri, { ignoreIfExists: false, overwrite: false });
                workspaceEdit.insert(change.uri, new vscode.Position(0, 0), change.content);
            }
        }
        const applied = await vscode.workspace.applyEdit(workspaceEdit);
        if (!applied) {
            throw new Error('VS Code could not apply the proposed workspace edit.');
        }
        const saved = await Promise.all(plannedChanges.map(async (change) => {
            const document = await vscode.workspace.openTextDocument(change.uri);
            return document.save();
        }));
        if (saved.some((didSave) => !didSave)) {
            throw new Error('DevMate applied the changes, but VS Code could not save every file.');
        }
        let openNote = '';
        try {
            const primaryDocument = await vscode.workspace.openTextDocument(plannedChanges[0].uri);
            await vscode.window.showTextDocument(primaryDocument, {
                viewColumn: vscode.ViewColumn.One,
                preview: false,
                preserveFocus: false
            });
        }
        catch {
            openNote = '\n\nThe changes were applied, but VS Code could not open the first file.';
        }
        return [
            'Applied file changes:',
            ...plannedChanges.map((change) => `- ${change.exists ? 'Updated' : 'Created'} ${change.path}`)
        ].join('\n') + openNote;
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

    [hidden] {
      display: none !important;
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
    input,
    select,
    textarea {
      font: inherit;
    }

    .app {
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      height: 100vh;
      min-height: 0;
    }

    .session-home {
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      gap: 12px;
      height: 100vh;
      padding: 14px 12px 12px;
      background: var(--surface);
    }

    .session-home-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: end;
    }

    .session-home-brand {
      display: block;
      margin-bottom: 4px;
      color: var(--muted);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
    }

    .session-home-heading h1 {
      margin: 0 0 3px;
      font-size: 18px;
      font-weight: 650;
    }

    .session-home-heading p {
      margin: 0;
      color: var(--muted);
      font-size: 11px;
    }

    .session-home-list {
      min-height: 0;
      overflow-y: auto;
      scrollbar-gutter: stable;
    }

    .session-home-warning {
      padding: 9px 10px;
      border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground));
      border-radius: 6px;
      color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
      background: var(--vscode-inputValidation-warningBackground, var(--surface-soft));
      font-size: 11px;
      line-height: 1.4;
    }

    .session-empty {
      margin-top: 20px;
      padding: 20px 14px;
      border: 1px dashed var(--border);
      border-radius: 8px;
      color: var(--muted);
      text-align: center;
      font-size: 11px;
      line-height: 1.5;
    }

    .toolbar {
      display: flex;
      gap: 6px;
      align-items: center;
      padding: 6px 8px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }

    .mode-tabs {
      display: inline-flex;
      gap: 2px;
      align-items: center;
      width: fit-content;
      padding: 2px;
      border: 1px solid var(--border);
      border-radius: 7px;
      background: var(--surface-soft);
    }

    .scope-tabs {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      align-items: center;
    }

    .mode-button,
    .session-selector,
    .toolbar-new-session,
    .toolbar-settings,
    .backend-status,
    .scope-button,
    .attachment-row-remove,
    .action-button {
      border: 1px solid transparent;
      cursor: pointer;
    }

    .mode-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 24px;
      padding: 0 9px;
      border-radius: 4px;
      color: var(--muted);
      background: transparent;
      font-size: 11px;
      font-weight: 550;
    }

    .mode-button[aria-pressed="true"] {
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
    }

    .action-button.primary {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-color: var(--vscode-button-background);
    }

    .session-selector,
    .toolbar-new-session,
    .toolbar-settings,
    .backend-status {
      display: inline-flex;
      gap: 5px;
      align-items: center;
      justify-content: center;
      height: 28px;
      padding: 0;
      border-color: var(--border);
      border-radius: 5px;
      color: var(--muted);
      background: transparent;
      font-size: 11px;
    }

    .session-selector {
      min-width: 28px;
      max-width: 138px;
      margin-left: auto;
      padding: 0 7px;
      overflow: hidden;
      cursor: pointer;
    }

    .session-selector-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .session-selector-chevron {
      flex: 0 0 auto;
      font-size: 8px;
    }

    .toolbar-new-session,
    .toolbar-settings,
    .backend-status {
      flex: 0 0 28px;
      width: 28px;
    }

    .backend-status {
      cursor: pointer;
    }

    .toolbar-settings {
      margin-left: 0;
    }

    .backend-status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--muted);
    }

    .backend-status[data-state="online"] .backend-status-dot {
      background: var(--vscode-testing-iconPassed, #2ea043);
      box-shadow: 0 0 5px color-mix(in srgb, var(--vscode-testing-iconPassed, #2ea043) 55%, transparent);
    }

    .backend-status[data-state="starting"] .backend-status-dot,
    .backend-status[data-state="restarting"] .backend-status-dot,
    .backend-status[data-state="checking"] .backend-status-dot {
      background: var(--vscode-progressBar-background, var(--vscode-button-background));
      animation: tool-pulse 1.4s ease-in-out infinite;
    }

    .backend-status[data-state="offline"] .backend-status-dot {
      background: var(--vscode-editorError-foreground);
    }

    .session-selector:hover,
    .toolbar-new-session:hover,
    .toolbar-settings:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
    }

    .backend-status:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }

    .toolbar-settings-icon {
      font-size: 13px;
      line-height: 1;
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

    button:disabled {
      cursor: default;
      filter: none;
      opacity: 0.55;
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
      overflow-anchor: none;
      scrollbar-gutter: stable;
    }

    .messages > * {
      flex: 0 0 auto;
    }

    .message {
      width: fit-content;
      max-width: min(86%, 760px);
      padding: 8px 10px 9px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--surface-soft);
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    .message.user {
      align-self: flex-end;
      border-color: var(--focus);
      border-bottom-right-radius: 3px;
      background: var(--vscode-button-secondaryBackground);
    }

    .message.assistant {
      align-self: flex-start;
      border-left: 3px solid var(--vscode-button-background);
      border-bottom-left-radius: 3px;
      background: var(--vscode-editorWidget-background, var(--surface-soft));
    }

    .message-author {
      display: block;
      margin-bottom: 4px;
      color: var(--muted);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .message.user .message-author {
      text-align: right;
    }

    .message-body {
      white-space: pre-wrap;
    }

    .message-body.markdown {
      white-space: normal;
    }

    .markdown p,
    .markdown ul,
    .markdown ol,
    .markdown pre,
    .markdown h1,
    .markdown h2,
    .markdown h3,
    .markdown h4 {
      margin: 0 0 8px;
    }

    .markdown > :last-child {
      margin-bottom: 0;
    }

    .markdown h1 { font-size: 1.35em; }
    .markdown h2 { font-size: 1.22em; }
    .markdown h3 { font-size: 1.12em; }
    .markdown h4 { font-size: 1.04em; }

    .markdown ul,
    .markdown ol {
      padding-left: 20px;
    }

    .markdown table {
      width: 100%;
      margin: 0 0 8px;
      border-collapse: collapse;
      font-size: 0.94em;
    }

    .markdown th,
    .markdown td {
      padding: 5px 7px;
      border: 1px solid var(--border);
      text-align: left;
      vertical-align: top;
    }

    .markdown th {
      background: var(--surface-soft);
      font-weight: 650;
    }

    .markdown-inline-code,
    .markdown-file-link {
      padding: 1px 4px;
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--vscode-textPreformat-foreground, var(--vscode-foreground));
      background: var(--vscode-textCodeBlock-background, var(--surface));
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em;
    }

    .markdown-file-link,
    .markdown-link {
      cursor: pointer;
    }

    .markdown-link {
      padding: 0;
      border: 0;
      color: var(--vscode-textLink-foreground);
      background: transparent;
      text-decoration: underline;
    }

    .markdown-code-block {
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 7px;
      background: var(--vscode-textCodeBlock-background, var(--surface));
    }

    .markdown-code-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 28px;
      padding: 3px 6px 3px 9px;
      border-bottom: 1px solid var(--border);
      color: var(--muted);
      font-size: 10px;
    }

    .markdown-copy {
      padding: 2px 7px;
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--vscode-foreground);
      background: transparent;
      cursor: pointer;
    }

    .markdown-code-block pre {
      margin: 0;
      padding: 9px 10px;
      overflow: auto;
      white-space: pre;
    }

    .markdown-code-block code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 12px);
    }

    .markdown-token.comment { color: var(--vscode-editorLineNumber-foreground); }
    .markdown-token.string { color: var(--vscode-debugTokenExpression-string, #ce9178); }
    .markdown-token.keyword { color: var(--vscode-debugTokenExpression-name, #569cd6); font-weight: 600; }
    .markdown-token.number { color: var(--vscode-debugTokenExpression-number, #b5cea8); }

    .working-card {
      position: relative;
      isolation: isolate;
      width: min(100%, 620px);
      max-width: min(100%, 620px);
      min-height: max-content;
      padding: 10px 11px;
      overflow: hidden;
    }

    .working-card > * {
      position: relative;
      z-index: 1;
    }

    .working-card[data-state="working"] {
      position: sticky;
      z-index: 20;
      top: 8px;
      flex-shrink: 0;
      animation: working-card-breathe 4.2s ease-in-out infinite;
    }

    .working-card[data-state="working"]::before {
      position: absolute;
      z-index: 0;
      inset: 0;
      background: linear-gradient(
        110deg,
        transparent 18%,
        color-mix(in srgb, var(--vscode-progressBar-background, var(--vscode-button-background)) 7%, transparent) 48%,
        transparent 76%
      );
      content: '';
      pointer-events: none;
      transform: translateX(-120%);
      animation: working-card-sheen 5.8s ease-in-out infinite;
    }

    .working-card[data-state="working"]::after {
      position: absolute;
      z-index: 2;
      top: 0;
      bottom: auto;
      left: 0;
      width: 3px;
      height: 22%;
      border-radius: 999px;
      background: var(--vscode-progressBar-background, var(--vscode-button-background));
      box-shadow: 0 0 4px var(--vscode-progressBar-background, var(--vscode-button-background));
      content: '';
      pointer-events: none;
      animation: working-edge-travel 3.4s ease-in-out infinite;
    }

    .working-header {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 8px;
    }

    .working-indicator {
      position: relative;
      width: 8px;
      height: 8px;
      flex: 0 0 auto;
      border-radius: 50%;
      background: var(--vscode-progressBar-background, var(--vscode-button-background));
      animation: working-indicator-core 1.8s ease-in-out infinite;
    }

    .working-indicator::after {
      position: absolute;
      inset: -5px;
      border: 1px solid var(--vscode-progressBar-background, var(--vscode-button-background));
      border-radius: 50%;
      content: '';
      animation: working-indicator-ring 1.8s ease-out infinite;
    }

    .working-card[data-state="cancelled"] .working-indicator,
    .working-card[data-state="error"] .working-indicator {
      animation: none;
      background: var(--muted);
    }

    .working-card[data-state="cancelled"] .working-indicator::after,
    .working-card[data-state="error"] .working-indicator::after {
      display: none;
    }

    .working-heading {
      min-width: 0;
      color: var(--vscode-foreground);
      font-size: 12px;
      font-weight: 650;
    }

    .working-card[data-state="working"] .working-heading::after {
      display: inline-block;
      width: 0;
      overflow: hidden;
      vertical-align: bottom;
      white-space: nowrap;
      content: '...';
      animation: working-ellipsis 1.9s steps(4, end) infinite;
    }

    .working-model {
      margin-left: auto;
      overflow: hidden;
      color: var(--muted);
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 10px;
    }

    .working-phases {
      display: grid;
      gap: 5px;
      margin: 0 0 9px;
      padding: 0;
      list-style: none;
    }

    .working-stream {
      max-height: 220px;
      margin-top: 8px;
      padding: 8px 9px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--vscode-foreground);
      background: var(--vscode-textCodeBlock-background, var(--surface));
      font-size: 11px;
      line-height: 1.45;
      white-space: pre-wrap;
    }

    .working-stream::after {
      content: '▋';
      margin-left: 2px;
      color: var(--vscode-button-background);
      animation: tool-pulse 1.2s ease-in-out infinite;
    }

    .working-phase {
      display: grid;
      grid-template-columns: 14px minmax(0, 1fr);
      gap: 5px;
      align-items: start;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.35;
    }

    .working-phase[data-status="active"] {
      margin: -2px -5px;
      padding: 2px 5px;
      border-radius: 4px;
      color: var(--vscode-foreground);
      background: linear-gradient(
        90deg,
        transparent 0%,
        color-mix(in srgb, var(--vscode-progressBar-background, var(--vscode-button-background)) 8%, transparent) 45%,
        transparent 78%
      );
      background-size: 220% 100%;
      animation: working-phase-sweep 3.2s linear infinite;
    }

    .working-phase[data-status="error"] {
      color: var(--vscode-editorError-foreground);
    }

    .working-phase-icon {
      text-align: center;
    }

    .working-phase[data-status="active"] .working-phase-icon {
      color: var(--vscode-progressBar-background, var(--vscode-button-background));
      animation: working-phase-dot 1.5s ease-in-out infinite;
    }

    .working-footer {
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      padding-top: 7px;
      border-top: 1px solid var(--border);
    }

    .working-elapsed {
      color: var(--muted);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
    }

    .working-cancel,
    .working-retry {
      height: 24px;
      padding: 0 9px;
      border-radius: 4px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      font-size: 10px;
    }

    .working-retry {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }

    .working-cancel[hidden],
    .working-retry[hidden] {
      display: none;
    }

    .tool-activity {
      display: grid;
      grid-template-columns: 20px minmax(0, 1fr);
      gap: 8px;
      align-self: flex-start;
      width: min(100%, 620px);
      padding: 7px 9px;
      border: 1px solid var(--border);
      border-radius: 7px;
      color: var(--muted);
      background: var(--surface-soft);
    }

    .tool-activity-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      font-size: 11px;
      font-weight: 700;
    }

    .tool-activity[data-status="running"] .tool-activity-icon {
      animation: tool-pulse 1.1s ease-in-out infinite;
    }

    .tool-activity[data-status="error"] .tool-activity-icon {
      color: var(--vscode-editorError-foreground);
      background: var(--vscode-inputValidation-errorBackground);
    }

    .tool-activity-copy {
      display: grid;
      gap: 1px;
      min-width: 0;
    }

    .tool-activity-title {
      color: var(--vscode-foreground);
      font-size: 11px;
      font-weight: 600;
    }

    .tool-activity-detail,
    .tool-activity-result {
      overflow: auto;
      max-height: 140px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 10px;
    }

    .tool-open-terminal {
      justify-self: start;
      margin-top: 4px;
    }

    .tool-activity-result:empty {
      display: none;
    }

    @keyframes tool-pulse {
      0%, 100% { opacity: 0.55; }
      50% { opacity: 1; }
    }

    @keyframes working-card-breathe {
      0%, 100% {
        box-shadow: 0 0 0 0 transparent;
      }
      50% {
        box-shadow:
          0 0 0 1px color-mix(in srgb, var(--vscode-progressBar-background, var(--vscode-button-background)) 18%, transparent),
          0 4px 12px color-mix(in srgb, var(--vscode-progressBar-background, var(--vscode-button-background)) 6%, transparent);
      }
    }

    @keyframes working-card-sheen {
      0%, 12% { transform: translateX(-120%); }
      58%, 100% { transform: translateX(120%); }
    }

    @keyframes working-edge-travel {
      0% { opacity: 0; transform: translateY(-110%); }
      18% { opacity: 1; }
      82% { opacity: 1; }
      100% { opacity: 0; transform: translateY(440%); }
    }

    @keyframes working-indicator-core {
      0%, 100% {
        opacity: 0.78;
        transform: scale(0.9);
      }
      50% {
        opacity: 1;
        transform: scale(1.08);
      }
    }

    @keyframes working-indicator-ring {
      0% { opacity: 0.5; transform: scale(0.6); }
      78%, 100% { opacity: 0; transform: scale(1.35); }
    }

    @keyframes working-ellipsis {
      from { width: 0; }
      to { width: 1.15em; }
    }

    @keyframes working-phase-sweep {
      from { background-position: 115% 0; }
      to { background-position: -115% 0; }
    }

    @keyframes working-phase-dot {
      0%, 100% { opacity: 0.72; transform: translateY(0) scale(0.92); }
      50% { opacity: 1; transform: translateY(-1px) scale(1.05); }
    }

    @media (prefers-reduced-motion: reduce) {
      .working-card[data-state="working"],
      .working-card[data-state="working"] .working-heading::after,
      .working-phase[data-status="active"],
      .working-phase[data-status="active"] .working-phase-icon,
      .working-stream::after,
      .working-indicator,
      .working-indicator::after,
      .backend-status[data-state="checking"] .backend-status-dot,
      .backend-status[data-state="starting"] .backend-status-dot,
      .backend-status[data-state="restarting"] .backend-status-dot,
      .tool-activity[data-status="running"] .tool-activity-icon {
        animation: none;
      }

      .working-card[data-state="working"]::before,
      .working-card[data-state="working"]::after {
        display: none;
      }

      .working-card[data-state="working"] .working-heading::after {
        width: 1.15em;
      }

      .working-phase[data-status="active"] {
        background: transparent;
      }
    }

    .permission-card {
      width: min(100%, 760px);
      max-width: min(100%, 760px);
      padding: 11px 12px 12px;
      border-left-color: var(--vscode-editorWarning-foreground);
      background: var(--vscode-editorWidget-background, var(--surface-soft));
    }

    .permission-title {
      margin: 0 0 5px;
      font-size: 13px;
      font-weight: 650;
    }

    .permission-summary {
      margin: 0;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.45;
      white-space: pre-wrap;
    }

    .permission-file-list {
      display: grid;
      gap: 5px;
      margin: 10px 0;
      padding: 0;
      list-style: none;
    }

    .permission-file {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 7px;
      align-items: center;
      padding: 6px 7px;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: var(--surface);
    }

    .permission-operation {
      padding: 2px 6px;
      border-radius: 999px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .permission-path {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
    }

    .permission-actions {
      display: flex;
      gap: 6px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }

    .permission-actions .action-button {
      height: 27px;
      padding: 0 10px;
      font-size: 11px;
    }

    .permission-resolution {
      margin-top: 8px;
      color: var(--muted);
      font-size: 11px;
      text-align: right;
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

    .composer-submit {
      display: inline-flex;
      flex: 0 0 auto;
      gap: 7px;
      align-items: center;
      margin-left: auto;
    }

    .token-estimate {
      color: var(--muted);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
      line-height: 1;
      white-space: nowrap;
    }

    .token-estimate[data-active="true"] {
      color: var(--vscode-foreground);
    }

    .action-button.ask-button {
      gap: 5px;
      min-width: 0;
      height: 26px;
      padding: 0 9px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
    }

    .ask-button-icon {
      font-size: 13px;
      line-height: 1;
      transform: translateY(-0.5px);
    }

    .model-selector {
      max-width: min(260px, 70vw);
      color: var(--vscode-foreground);
      background: var(--vscode-input-background);
    }

    .model-selector-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .model-selector-chevron {
      margin-left: 6px;
      color: var(--muted);
      font-size: 9px;
    }

    .profile-dialog {
      width: min(520px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      padding: 0;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 10px;
      color: var(--vscode-foreground);
      background: var(--surface);
      box-shadow: 0 14px 42px rgba(0, 0, 0, 0.38);
    }

    .profile-dialog::backdrop {
      background: rgba(0, 0, 0, 0.52);
    }

    .profile-form {
      display: grid;
      gap: 0;
    }

    .profile-form-header {
      padding: 16px 18px 12px;
      border-bottom: 1px solid var(--border);
    }

    .profile-form-header h2 {
      margin: 0 0 4px;
      font-size: 16px;
      font-weight: 600;
    }

    .profile-form-header p,
    .field-help {
      margin: 0;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.4;
    }

    .profile-form-body {
      display: grid;
      gap: 12px;
      padding: 16px 18px;
    }

    .profile-form-row {
      display: grid;
      grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
      gap: 12px;
    }

    .profile-field {
      display: grid;
      gap: 5px;
      min-width: 0;
    }

    .profile-field[hidden] {
      display: none;
    }

    .profile-field label {
      font-size: 12px;
      font-weight: 600;
    }

    .profile-field input,
    .profile-field select {
      width: 100%;
      height: 32px;
      padding: 0 9px;
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 4px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
    }

    .profile-field input:focus,
    .profile-field select:focus {
      outline: 1px solid var(--focus);
      outline-offset: 0;
    }

    .profile-form-error {
      padding: 8px 10px;
      border: 1px solid var(--vscode-editorError-foreground);
      border-radius: 4px;
      color: var(--vscode-editorError-foreground);
      background: var(--vscode-inputValidation-errorBackground);
      font-size: 11px;
    }

    .profile-form-error[hidden] {
      display: none;
    }

    .profile-form-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      padding: 12px 18px 16px;
      border-top: 1px solid var(--border);
    }

    .session-list {
      display: grid;
      gap: 6px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .session-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px;
      align-items: center;
      padding: 6px;
      border: 1px solid var(--border);
      border-radius: 7px;
      background: var(--surface-soft);
    }

    .session-row.active {
      border-color: var(--focus);
    }

    .session-row.foreign {
      border-style: dashed;
    }

    .session-select {
      display: grid;
      gap: 2px;
      min-width: 0;
      padding: 4px 5px;
      border: 0;
      border-radius: 4px;
      color: var(--vscode-foreground);
      background: transparent;
      text-align: left;
      cursor: pointer;
    }

    .session-select:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .session-title {
      overflow: hidden;
      font-size: 12px;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .session-meta {
      color: var(--muted);
      font-size: 10px;
    }

    .session-project-badge {
      color: var(--vscode-textLink-foreground);
      font-weight: 600;
    }

    .session-actions {
      display: inline-flex;
      gap: 3px;
    }

    .session-action {
      width: 26px;
      height: 26px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 4px;
      color: var(--muted);
      background: transparent;
      cursor: pointer;
    }

    .session-action:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
    }

    .settings-section {
      display: grid;
      gap: 9px;
    }

    .settings-section + .settings-section {
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }

    .settings-section-title {
      margin: 0;
      font-size: 12px;
      font-weight: 650;
    }

    .settings-value-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px 12px;
    }

    .settings-value-grid .profile-field:last-child {
      grid-column: 1 / -1;
    }

    .permission-setting-list {
      display: grid;
      gap: 8px;
    }

    .permission-setting-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(110px, auto);
      gap: 12px;
      align-items: center;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface-soft);
    }

    .permission-setting-copy {
      display: grid;
      gap: 2px;
      min-width: 0;
    }

    .permission-setting-copy strong {
      font-size: 12px;
    }

    .permission-setting-copy span {
      color: var(--muted);
      font-size: 10px;
      line-height: 1.35;
    }

    .permission-setting-row select {
      width: 100%;
      height: 30px;
      padding: 0 7px;
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 4px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
    }

    .permission-blocked {
      color: var(--muted);
    }

    .permission-blocked-badge {
      justify-self: end;
      padding: 3px 7px;
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 10px;
      font-weight: 600;
    }

    .backend-settings-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .remembered-command-list {
      display: grid;
      gap: 6px;
      margin: 8px 0 0;
      padding: 0;
      list-style: none;
    }

    .remembered-command {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 7px 8px;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: var(--surface);
    }

    .remembered-command-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
    }

    .remembered-command button,
    .review-diff-button {
      width: auto;
      min-width: 0;
      padding: 3px 7px;
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--vscode-foreground);
      background: transparent;
      cursor: pointer;
    }

    .remembered-command-empty {
      color: var(--muted);
      font-size: 11px;
    }

    @media (max-width: 480px) {
      .session-selector {
        max-width: 34px;
      }

      .session-selector-title {
        display: none;
      }

      .profile-form-row {
        grid-template-columns: 1fr;
      }

      .settings-value-grid {
        grid-template-columns: 1fr;
      }

      .settings-value-grid .profile-field:last-child {
        grid-column: auto;
      }

      .permission-setting-row {
        grid-template-columns: 1fr;
      }

      .permission-blocked-badge {
        justify-self: start;
      }
    }
  </style>
</head>
<body>
  <section id="sessionHome" class="session-home" aria-labelledby="sessionHomeTitle">
    <header class="session-home-header">
      <div class="session-home-heading">
        <span class="session-home-brand">DEVMATE</span>
        <h1 id="sessionHomeTitle">Sessions</h1>
        <p id="currentProjectLabel">Loading project sessions…</p>
      </div>
      <button id="newSessionOnHome" class="action-button primary" type="button">New chat</button>
    </header>
    <div id="sessionProjectWarning" class="session-home-warning" role="alert" hidden></div>
    <div class="session-home-list">
      <ul id="sessionList" class="session-list" aria-label="Saved DevMate sessions"></ul>
      <div id="sessionEmpty" class="session-empty" hidden>
        No past sessions yet.<br>Start a new chat for this project.
      </div>
    </div>
  </section>

  <main id="chatApp" class="app" hidden>
    <header class="toolbar">
      <div class="mode-tabs" role="group" aria-label="Assistant mode">
        <button class="mode-button" type="button" data-mode="ideas" aria-pressed="false">Ideas</button>
        <button class="mode-button" type="button" data-mode="code" aria-pressed="true">Code</button>
        <button class="mode-button" type="button" data-mode="debug" aria-pressed="false">Debug</button>
      </div>
      <button
        id="sessionSelector"
        class="session-selector"
        type="button"
        title="Open sessions"
        aria-label="Open sessions"
      >
        <span aria-hidden="true">←</span>
        <span id="activeSessionTitle" class="session-selector-title">New session</span>
      </button>
      <button
        id="newSessionButton"
        class="toolbar-new-session"
        type="button"
        title="New session"
        aria-label="New session"
      >＋</button>
      <button
        id="backendStatus"
        class="backend-status"
        type="button"
        data-state="checking"
        title="Checking local backend"
        aria-label="Checking local backend"
      >
        <span class="backend-status-dot" aria-hidden="true"></span>
      </button>
      <button
        id="settingsButton"
        class="toolbar-settings"
        type="button"
        title="Open DevMate settings"
        aria-label="Open DevMate settings"
      >
        <span class="toolbar-settings-icon" aria-hidden="true">⚙</span>
      </button>
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
          <button
            id="llmProfileSelector"
            class="scope-button model-selector"
            type="button"
            title="Add or select a model profile"
          >
            <span id="llmProfileLabel" class="model-selector-label">Add model</span>
            <span class="model-selector-chevron" aria-hidden="true">▼</span>
          </button>
          <span class="composer-actions-spacer"></span>
          <div class="composer-submit">
            <span
              id="tokenEstimate"
              class="token-estimate"
              data-active="false"
              title="Approximate tokens in the current message; project context and the response are not included."
            >≈ 0 tokens</span>
            <button id="ask" class="action-button primary ask-button" type="button" disabled>
              <span>Ask</span>
              <span class="ask-button-icon" aria-hidden="true">↑</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  </main>

  <dialog id="llmProfileDialog" class="profile-dialog" aria-labelledby="llmProfileFormTitle">
    <form id="llmProfileForm" class="profile-form" novalidate>
      <header class="profile-form-header">
        <h2 id="llmProfileFormTitle">Add model profile</h2>
        <p id="llmProfileFormDescription">Save a reusable model configuration for DevMate.</p>
      </header>
      <div class="profile-form-body">
        <input id="llmProfileId" type="hidden">
        <div class="profile-field">
          <label for="llmProfileName">Display name</label>
          <input
            id="llmProfileName"
            type="text"
            maxlength="60"
            autocomplete="off"
            placeholder="OpenAI Fast or Local Ollama"
            required
          >
        </div>
        <div class="profile-form-row">
          <div class="profile-field">
            <label for="llmProfileProvider">Provider</label>
            <select id="llmProfileProvider">
              <option value="openai">OpenAI</option>
              <option value="ollama">Ollama</option>
            </select>
          </div>
          <div class="profile-field">
            <label for="llmProfileModel">Model ID</label>
            <input
              id="llmProfileModel"
              type="text"
              maxlength="120"
              autocomplete="off"
              placeholder="gpt-4.1-mini"
              required
            >
          </div>
        </div>
        <div class="profile-field">
          <label for="llmProfileBaseUrl">Base URL</label>
          <input
            id="llmProfileBaseUrl"
            type="url"
            autocomplete="off"
            placeholder="Optional — uses the provider default"
          >
          <p id="llmProfileBaseUrlHelp" class="field-help">Leave blank to use the OpenAI default.</p>
        </div>
        <div id="llmProfileApiKeyField" class="profile-field">
          <label for="llmProfileApiKey">API key</label>
          <input
            id="llmProfileApiKey"
            type="password"
            autocomplete="new-password"
            placeholder="Paste the provider API key"
          >
          <p id="llmProfileApiKeyHelp" class="field-help">The key is transferred to the extension and saved in VS Code SecretStorage.</p>
        </div>
        <div id="llmProfileFormError" class="profile-form-error" role="alert" hidden></div>
      </div>
      <footer class="profile-form-actions">
        <button id="cancelLlmProfile" class="action-button secondary" type="button">Cancel</button>
        <button id="saveLlmProfile" class="action-button primary" type="submit">Save profile</button>
      </footer>
    </form>
  </dialog>

  <dialog id="permissionDialog" class="profile-dialog" aria-labelledby="permissionDialogTitle">
    <form id="permissionForm" class="profile-form">
      <header class="profile-form-header">
        <h2 id="permissionDialogTitle">DevMate settings</h2>
        <p>Control model requests and what DevMate may change without pausing.</p>
      </header>
      <div class="profile-form-body">
        <section class="settings-section" aria-labelledby="modelRequestSettingsTitle">
          <h3 id="modelRequestSettingsTitle" class="settings-section-title">Model requests</h3>
          <div class="settings-value-grid">
            <div class="profile-field">
              <label for="settingsTimeoutSeconds">Timeout (seconds)</label>
              <input id="settingsTimeoutSeconds" type="number" min="10" max="1800" step="1" required>
              <p id="settingsTimeoutHelp" class="field-help">Approximately 15 min.</p>
            </div>
            <div class="profile-field">
              <label for="settingsCommandTimeoutSeconds">Command timeout (seconds)</label>
              <input id="settingsCommandTimeoutSeconds" type="number" min="10" max="1800" step="1" required>
              <p class="field-help">Maximum runtime for each verification command.</p>
            </div>
            <div class="profile-field">
              <label for="settingsMaxTokens">Maximum output tokens</label>
              <input id="settingsMaxTokens" type="number" min="128" max="32000" step="1" required>
              <p class="field-help">Shared by reasoning and final output.</p>
            </div>
            <div class="profile-field">
              <label for="settingsToolCallLimit">Tool calls per request</label>
              <input id="settingsToolCallLimit" type="number" min="4" max="100" step="1" required>
              <p class="field-help">16 recommended; 100 maximum. High limits add time, cost, context pressure, and loop risk.</p>
            </div>
            <div class="profile-field">
              <label for="settingsTemperature">Temperature</label>
              <input id="settingsTemperature" type="number" min="0" max="2" step="0.1" required>
              <p class="field-help">Lower values are more deterministic.</p>
            </div>
          </div>
        </section>
        <section class="settings-section" aria-labelledby="backendSettingsTitle">
          <h3 id="backendSettingsTitle" class="settings-section-title">Local backend</h3>
          <div class="permission-setting-list">
            <div class="permission-setting-row">
              <span class="permission-setting-copy">
                <strong id="backendSettingsLabel">Checking backend</strong>
                <span id="backendSettingsDetail">Checking the configured backend.</span>
              </span>
              <span id="backendSettingsBadge" class="permission-blocked-badge">Checking</span>
            </div>
            <div class="backend-settings-actions">
              <button id="restartBackend" class="action-button secondary" type="button">Restart backend</button>
              <button id="openBackendLogs" class="action-button secondary" type="button">Open backend logs</button>
            </div>
          </div>
        </section>
        <section class="settings-section" aria-labelledby="filePermissionSettingsTitle">
          <h3 id="filePermissionSettingsTitle" class="settings-section-title">File permissions</h3>
          <div class="permission-setting-list">
            <label class="permission-setting-row" for="permissionCreateFiles">
              <span class="permission-setting-copy">
                <strong>Create new files</strong>
                <span>Only workspace-relative text files that pass DevMate's path checks.</span>
              </span>
              <select id="permissionCreateFiles">
                <option value="ask">Ask every time</option>
                <option value="allow">Allow instantly</option>
              </select>
            </label>
            <label class="permission-setting-row" for="permissionUpdateFiles">
              <span class="permission-setting-copy">
                <strong>Update existing files</strong>
                <span>Replaces complete text-file contents through VS Code's undoable workspace edit.</span>
              </span>
              <select id="permissionUpdateFiles">
                <option value="ask">Ask every time</option>
                <option value="allow">Allow instantly</option>
              </select>
            </label>
            <div class="permission-setting-row">
              <span class="permission-setting-copy">
                <strong>Delete, rename, or move files</strong>
                <span>File lifecycle operations always require one-time approval and diff review.</span>
              </span>
              <span class="permission-blocked-badge">Always ask</span>
            </div>
            <div class="permission-setting-row">
              <span class="permission-setting-copy">
                <strong>Verification commands</strong>
                <span>New exact commands ask first and are remembered only for this workspace.</span>
              </span>
              <span id="workspaceTrustBadge" class="permission-blocked-badge" hidden>Workspace untrusted</span>
            </div>
            <div class="permission-setting-row">
              <span class="permission-setting-copy">
                <strong>Python dependency installation</strong>
                <span>Validated requirements manifests always require one-time approval and install only into a project virtual environment.</span>
              </span>
              <span class="permission-blocked-badge">Always ask</span>
            </div>
            <ul id="rememberedCommandList" class="remembered-command-list"></ul>
            <button id="clearRememberedCommands" class="action-button secondary" type="button">Clear remembered commands</button>
          </div>
          <p class="field-help">Instant permission never bypasses workspace boundaries, protected-file rules, or file-size limits.</p>
        </section>
      </div>
      <footer class="profile-form-actions">
        <button id="cancelPermissionSettings" class="action-button secondary" type="button">Cancel</button>
        <button class="action-button primary" type="submit">Save settings</button>
      </footer>
    </form>
  </dialog>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = {
      mode: 'code',
      scope: {
        kind: 'project',
        label: 'Project',
        detail: ''
      },
      attachments: [],
      attachmentsExpanded: false,
      activeProfile: undefined,
      profileCount: 0,
      permissionPolicy: {
        createFiles: 'ask',
        updateFiles: 'ask'
      },
      settings: {
        timeoutSeconds: 900,
        commandTimeoutSeconds: 300,
        toolCallLimit: 16,
        maxTokens: 16384,
        temperature: 0.2,
        rememberedCommands: [],
        workspaceTrusted: true
      },
      backendStatus: {
        state: 'checking',
        detail: 'Checking the configured backend.',
        managed: false,
        canRestart: false
      },
      backendLabel: 'Checking backend',
      sessions: [],
      activeSessionId: '',
      activeSessionTitle: 'New session',
      currentWorkspaceName: 'No project open',
      workingStartedAt: 0,
      workingTimer: undefined,
      streamQueue: '',
      streamPumpTimer: undefined,
      pendingAssistantResponse: undefined,
      lastRequest: undefined,
      askPending: false
    };

    const statusEl = document.getElementById('status');
    const sessionHomeEl = document.getElementById('sessionHome');
    const chatAppEl = document.getElementById('chatApp');
    const currentProjectLabelEl = document.getElementById('currentProjectLabel');
    const sessionProjectWarningEl = document.getElementById('sessionProjectWarning');
    const sessionEmptyEl = document.getElementById('sessionEmpty');
    const messagesEl = document.getElementById('messages');
    const questionEl = document.getElementById('question');
    const scopeDetailEl = document.getElementById('scopeDetail');
    const attachmentPanelEl = document.getElementById('attachmentPanel');
    const attachmentListEl = document.getElementById('attachmentList');
    const attachFilesEl = document.getElementById('attachFiles');
    const attachmentToggleEl = document.getElementById('toggleAttachments');
    const llmProfileSelectorEl = document.getElementById('llmProfileSelector');
    const llmProfileLabelEl = document.getElementById('llmProfileLabel');
    const tokenEstimateEl = document.getElementById('tokenEstimate');
    const askEl = document.getElementById('ask');
    const sessionSelectorEl = document.getElementById('sessionSelector');
    const activeSessionTitleEl = document.getElementById('activeSessionTitle');
    const newSessionButtonEl = document.getElementById('newSessionButton');
    const sessionListEl = document.getElementById('sessionList');
    const newSessionOnHomeEl = document.getElementById('newSessionOnHome');
    const llmProfileDialogEl = document.getElementById('llmProfileDialog');
    const llmProfileFormEl = document.getElementById('llmProfileForm');
    const llmProfileFormTitleEl = document.getElementById('llmProfileFormTitle');
    const llmProfileFormDescriptionEl = document.getElementById('llmProfileFormDescription');
    const llmProfileIdEl = document.getElementById('llmProfileId');
    const llmProfileNameEl = document.getElementById('llmProfileName');
    const llmProfileProviderEl = document.getElementById('llmProfileProvider');
    const llmProfileModelEl = document.getElementById('llmProfileModel');
    const llmProfileBaseUrlEl = document.getElementById('llmProfileBaseUrl');
    const llmProfileBaseUrlHelpEl = document.getElementById('llmProfileBaseUrlHelp');
    const llmProfileApiKeyFieldEl = document.getElementById('llmProfileApiKeyField');
    const llmProfileApiKeyEl = document.getElementById('llmProfileApiKey');
    const llmProfileApiKeyHelpEl = document.getElementById('llmProfileApiKeyHelp');
    const llmProfileFormErrorEl = document.getElementById('llmProfileFormError');
    const saveLlmProfileEl = document.getElementById('saveLlmProfile');
    const settingsButtonEl = document.getElementById('settingsButton');
    const backendStatusEl = document.getElementById('backendStatus');
    const permissionDialogEl = document.getElementById('permissionDialog');
    const permissionFormEl = document.getElementById('permissionForm');
    const permissionCreateFilesEl = document.getElementById('permissionCreateFiles');
    const permissionUpdateFilesEl = document.getElementById('permissionUpdateFiles');
    const settingsTimeoutSecondsEl = document.getElementById('settingsTimeoutSeconds');
    const settingsTimeoutHelpEl = document.getElementById('settingsTimeoutHelp');
    const settingsCommandTimeoutSecondsEl = document.getElementById('settingsCommandTimeoutSeconds');
    const settingsToolCallLimitEl = document.getElementById('settingsToolCallLimit');
    const settingsMaxTokensEl = document.getElementById('settingsMaxTokens');
    const settingsTemperatureEl = document.getElementById('settingsTemperature');
    const rememberedCommandListEl = document.getElementById('rememberedCommandList');
    const clearRememberedCommandsEl = document.getElementById('clearRememberedCommands');
    const workspaceTrustBadgeEl = document.getElementById('workspaceTrustBadge');
    const backendSettingsLabelEl = document.getElementById('backendSettingsLabel');
    const backendSettingsDetailEl = document.getElementById('backendSettingsDetail');
    const backendSettingsBadgeEl = document.getElementById('backendSettingsBadge');
    const restartBackendEl = document.getElementById('restartBackend');
    const openBackendLogsEl = document.getElementById('openBackendLogs');
    const ollamaDefaultBaseUrl = 'http://127.0.0.1:11434';

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

    askEl.addEventListener('click', () => {
      const question = questionEl.value.trim();
      if (!question) {
        setStatus('Enter a question before asking.', 'warning');
        questionEl.focus();
        return;
      }

      appendMessage(question, 'user');
      questionEl.value = '';
      renderTokenEstimate();
      state.askPending = true;
      startWorkingTurn();
      renderAskAvailability();
      state.lastRequest = {
        command: 'ask',
        mode: state.mode,
        question,
        scope: state.scope
      };
      vscode.postMessage(state.lastRequest);
    });

    questionEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        askEl.click();
      }
    });

    questionEl.addEventListener('input', renderTokenEstimate);

    attachFilesEl.addEventListener('click', () => {
      vscode.postMessage({ command: 'pickFiles' });
    });

    llmProfileSelectorEl.addEventListener('click', () => {
      vscode.postMessage({ command: 'chooseLlmProfile' });
    });

    const openSettingsDialog = () => {
      permissionCreateFilesEl.value = state.permissionPolicy.createFiles;
      permissionUpdateFilesEl.value = state.permissionPolicy.updateFiles;
      settingsTimeoutSecondsEl.value = String(state.settings.timeoutSeconds);
      settingsCommandTimeoutSecondsEl.value = String(state.settings.commandTimeoutSeconds);
      settingsToolCallLimitEl.value = String(state.settings.toolCallLimit);
      settingsMaxTokensEl.value = String(state.settings.maxTokens);
      settingsTemperatureEl.value = String(state.settings.temperature);
      renderTimeoutApproximation();
      renderRememberedCommands();
      if (!permissionDialogEl.open) {
        permissionDialogEl.showModal();
      }
      settingsTimeoutSecondsEl.focus();
    };

    settingsButtonEl.addEventListener('click', openSettingsDialog);
    sessionSelectorEl.addEventListener('click', () => {
      showSessionHome();
    });
    const requestNewSession = () => {
      if (state.askPending) {
        return;
      }
      sessionProjectWarningEl.hidden = true;
      vscode.postMessage({ command: 'newSession' });
    };
    newSessionButtonEl.addEventListener('click', requestNewSession);
    newSessionOnHomeEl.addEventListener('click', requestNewSession);
    backendStatusEl.addEventListener('click', () => {
      vscode.postMessage({ command: 'openBackendLogs' });
    });
    restartBackendEl.addEventListener('click', () => {
      if (restartBackendEl.disabled) {
        return;
      }
      restartBackendEl.disabled = true;
      vscode.postMessage({ command: 'restartBackend' });
    });
    openBackendLogsEl.addEventListener('click', () => {
      vscode.postMessage({ command: 'openBackendLogs' });
    });

    settingsTimeoutSecondsEl.addEventListener('input', renderTimeoutApproximation);

    document.getElementById('cancelPermissionSettings').addEventListener('click', () => {
      permissionDialogEl.close();
    });

    clearRememberedCommandsEl.addEventListener('click', () => {
      vscode.postMessage({ command: 'clearRememberedCommands' });
    });

    permissionFormEl.addEventListener('submit', (event) => {
      event.preventDefault();
      const timeoutSeconds = Number(settingsTimeoutSecondsEl.value);
      const commandTimeoutSeconds = Number(settingsCommandTimeoutSecondsEl.value);
      const toolCallLimit = Number(settingsToolCallLimitEl.value);
      const maxTokens = Number(settingsMaxTokensEl.value);
      const temperature = Number(settingsTemperatureEl.value);
      vscode.postMessage({
        command: 'saveSettings',
        settings: {
          timeoutSeconds,
          commandTimeoutSeconds,
          toolCallLimit,
          maxTokens,
          temperature,
          policy: {
            createFiles: permissionCreateFilesEl.value,
            updateFiles: permissionUpdateFilesEl.value
          }
        }
      });
    });

    llmProfileProviderEl.addEventListener('change', () => {
      renderLlmProfileProvider(true);
    });

    document.getElementById('cancelLlmProfile').addEventListener('click', () => {
      closeLlmProfileForm();
    });

    llmProfileDialogEl.addEventListener('close', () => {
      llmProfileApiKeyEl.value = '';
      llmProfileDialogEl.dataset.hasApiKey = 'false';
      setLlmProfileFormError('');
      setLlmProfileFormSaving(false);
    });

    llmProfileFormEl.addEventListener('submit', (event) => {
      event.preventDefault();
      setLlmProfileFormError('');

      const name = llmProfileNameEl.value.trim();
      const provider = llmProfileProviderEl.value;
      const model = llmProfileModelEl.value.trim();
      const baseUrl = llmProfileBaseUrlEl.value.trim();
      const apiKey = llmProfileApiKeyEl.value.trim();

      if (!name) {
        setLlmProfileFormError('Enter a display name.');
        llmProfileNameEl.focus();
        return;
      }
      if (!model) {
        setLlmProfileFormError('Enter a model ID.');
        llmProfileModelEl.focus();
        return;
      }
      if (baseUrl) {
        try {
          const parsedUrl = new URL(baseUrl);
          if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
            throw new Error('Invalid provider URL');
          }
        } catch {
          setLlmProfileFormError('Enter a valid HTTP or HTTPS base URL without embedded credentials.');
          llmProfileBaseUrlEl.focus();
          return;
        }
      }
      if (
        provider === 'openai'
        && !apiKey
        && llmProfileDialogEl.dataset.hasApiKey !== 'true'
      ) {
        setLlmProfileFormError('Enter an API key for this OpenAI profile.');
        llmProfileApiKeyEl.focus();
        return;
      }

      setLlmProfileFormSaving(true);
      vscode.postMessage({
        command: 'saveLlmProfile',
        profile: {
          id: llmProfileIdEl.value || undefined,
          name,
          provider,
          model,
          baseUrl: baseUrl || undefined,
          apiKey: provider === 'openai' && apiKey ? apiKey : undefined
        }
      });
    });

    attachmentToggleEl.addEventListener('click', () => {
      state.attachmentsExpanded = !state.attachmentsExpanded;
      renderAttachments();
    });

    window.addEventListener('message', (event) => {
      const message = event.data;

      if (message.command === 'status') {
        if (message.level === 'info') {
          setStatus('Ready');
          if (state.askPending && message.text !== 'Ready') {
            updateWorkingTurn(message.text);
          }
        } else {
          setStatus(message.text, message.level);
        }
      }

      if (message.command === 'scopeUpdated') {
        state.scope = message.scope;
        renderScope();
      }

      if (message.command === 'assistantResponse') {
        if (state.streamQueue || state.streamPumpTimer) {
          state.pendingAssistantResponse = message.response;
        } else {
          completeAssistantResponse(message.response);
        }
      }

      if (message.command === 'sessionsUpdated') {
        state.sessions = Array.isArray(message.sessions) ? message.sessions : [];
        state.activeSessionId = message.activeSessionId || '';
        state.activeSessionTitle = message.activeTitle || 'New session';
        state.currentWorkspaceName = message.currentWorkspaceName || 'No project open';
        sessionProjectWarningEl.hidden = true;
        renderSessions();
        if (message.openChat === true) {
          showChat();
        }
        if (Array.isArray(message.messages)) {
          renderSessionMessages(message.messages);
          state.askPending = false;
          renderAskAvailability();
        }
      }

      if (message.command === 'sessionProjectWarning') {
        sessionProjectWarningEl.textContent = message.message;
        sessionProjectWarningEl.hidden = false;
        showSessionHome(false);
      }

      if (message.command === 'requestCancelling') {
        markWorkingTurnCancelling();
      }

      if (message.command === 'requestCancelled') {
        stopWorkingTurn('cancelled', 'Request cancelled');
        cancelPendingPermissionCards();
        state.askPending = false;
        renderAskAvailability();
        setStatus('Ready');
      }

      if (message.command === 'requestFailed') {
        stopWorkingTurn('error', message.message, Boolean(message.retryable));
        cancelPendingPermissionCards();
        state.askPending = false;
        renderAskAvailability();
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

      if (message.command === 'llmProfilesUpdated') {
        state.activeProfile = message.activeProfile;
        state.profileCount = message.profileCount;
        renderLlmProfile();
      }

      if (message.command === 'showLlmProfileForm') {
        showLlmProfileForm(message.profile, message.hasApiKey);
      }

      if (message.command === 'llmProfileFormError') {
        setLlmProfileFormSaving(false);
        setLlmProfileFormError(message.message);
      }

      if (message.command === 'closeLlmProfileForm') {
        closeLlmProfileForm();
      }

      if (message.command === 'permissionPolicyUpdated') {
        state.permissionPolicy = message.policy;
      }

      if (message.command === 'settingsUpdated') {
        state.settings = message.settings;
        renderRememberedCommands();
        if (permissionDialogEl.open) {
          settingsTimeoutSecondsEl.value = String(state.settings.timeoutSeconds);
          settingsCommandTimeoutSecondsEl.value = String(state.settings.commandTimeoutSeconds);
          settingsToolCallLimitEl.value = String(state.settings.toolCallLimit);
          settingsMaxTokensEl.value = String(state.settings.maxTokens);
          settingsTemperatureEl.value = String(state.settings.temperature);
          renderTimeoutApproximation();
        }
      }

      if (message.command === 'settingsSaved' && permissionDialogEl.open) {
        permissionDialogEl.close();
      }

      if (message.command === 'backendStatusUpdated') {
        state.backendStatus = message.status;
        state.backendLabel = message.label;
        renderBackendStatus();
      }

      if (message.command === 'permissionRequest') {
        updateWorkingTurn('Waiting for permission');
        appendPermissionRequest(message);
      }

      if (message.command === 'commandPermissionRequest') {
        updateWorkingTurn(message.rememberable === false
          ? 'Waiting for dependency permission'
          : 'Waiting for command permission');
        appendCommandPermissionRequest(message);
      }

      if (message.command === 'agentToolActivity') {
        if (message.activity.status === 'running') {
          updateWorkingTurn(message.activity.title);
        }
        renderAgentToolActivity(message.activity);
      }

      if (message.command === 'providerStreamReset') {
        resetProviderStream();
      }

      if (message.command === 'providerStreamDelta') {
        appendProviderStreamDelta(message.text);
      }
    });

    renderTokenEstimate();
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

    function renderTimeoutApproximation() {
      const seconds = Number(settingsTimeoutSecondsEl.value);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        settingsTimeoutHelpEl.textContent = 'Enter a timeout from 10 to 1800 seconds.';
        return;
      }
      const roundedMinutes = (Math.round((seconds / 60) * 10) / 10)
        .toFixed(1)
        .replace(/\.0$/, '');
      settingsTimeoutHelpEl.textContent = 'Approximately ' + roundedMinutes + ' min.';
    }

    function renderTokenEstimate() {
      const characterCount = questionEl.value.trim().length;
      const tokenCount = characterCount === 0 ? 0 : Math.max(1, Math.ceil(characterCount / 4));
      let tokenLabel = String(tokenCount);
      if (tokenCount >= 1_000) {
        const roundedThousands = (Math.round((tokenCount / 1_000) * 10) / 10).toFixed(1);
        tokenLabel = (roundedThousands.endsWith('.0')
          ? roundedThousands.slice(0, -2)
          : roundedThousands) + 'k';
      }
      tokenEstimateEl.textContent = '≈ ' + tokenLabel + (tokenCount === 1 ? ' token' : ' tokens');
      tokenEstimateEl.dataset.active = String(tokenCount > 0);
      tokenEstimateEl.setAttribute(
        'aria-label',
        'Approximately ' + tokenCount + (tokenCount === 1 ? ' token' : ' tokens')
          + ' in the current message'
      );
    }

    function renderRememberedCommands() {
      const commands = Array.isArray(state.settings.rememberedCommands)
        ? state.settings.rememberedCommands
        : [];
      rememberedCommandListEl.replaceChildren();
      workspaceTrustBadgeEl.hidden = state.settings.workspaceTrusted !== false;
      clearRememberedCommandsEl.disabled = commands.length === 0;
      if (commands.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'remembered-command-empty';
        empty.textContent = 'No verification commands are remembered.';
        rememberedCommandListEl.appendChild(empty);
        return;
      }
      commands.forEach((command) => {
        const item = document.createElement('li');
        item.className = 'remembered-command';
        const label = document.createElement('span');
        label.className = 'remembered-command-label';
        label.textContent = command.label;
        label.title = command.label;
        item.appendChild(label);
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.textContent = 'Forget';
        revoke.addEventListener('click', () => {
          vscode.postMessage({
            command: 'revokeRememberedCommand',
            signature: command.signature
          });
        });
        item.appendChild(revoke);
        rememberedCommandListEl.appendChild(item);
      });
    }

    function appendMessage(text, role, scroll = true) {
      const item = document.createElement('article');
      item.className = 'message ' + role;

      const author = document.createElement('span');
      author.className = 'message-author';
      author.textContent = role === 'user' ? 'You' : 'DevMate';
      item.appendChild(author);

      const body = document.createElement('div');
      body.className = 'message-body';
      if (role === 'assistant') {
        body.classList.add('markdown');
        renderMarkdown(body, text);
      } else {
        body.textContent = text;
      }
      item.appendChild(body);
      messagesEl.appendChild(item);
      if (scroll) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }

    function renderMarkdown(container, text) {
      const lines = String(text).replace(/\\r\\n/g, '\\n').split('\\n');
      const fence = String.fromCharCode(96).repeat(3);
      let index = 0;
      while (index < lines.length) {
        const line = lines[index];
        if (!line.trim()) {
          index += 1;
          continue;
        }
        if (line.trimStart().startsWith(fence)) {
          const opening = line.trimStart().slice(fence.length).trim();
          const codeLines = [];
          index += 1;
          while (index < lines.length && !lines[index].trimStart().startsWith(fence)) {
            codeLines.push(lines[index]);
            index += 1;
          }
          if (index < lines.length) {
            index += 1;
          }
          appendCodeBlock(container, codeLines.join('\\n'), opening);
          continue;
        }
        const heading = line.match(/^(#{1,4})\\s+(.+)$/);
        if (heading) {
          const element = document.createElement('h' + heading[1].length);
          appendInlineMarkdown(element, heading[2]);
          container.appendChild(element);
          index += 1;
          continue;
        }
        if (index + 1 < lines.length && line.includes('|') && isMarkdownTableSeparator(lines[index + 1])) {
          const table = document.createElement('table');
          const head = document.createElement('thead');
          const headRow = document.createElement('tr');
          markdownTableCells(line).forEach((value) => {
            const cell = document.createElement('th');
            appendInlineMarkdown(cell, value);
            headRow.appendChild(cell);
          });
          head.appendChild(headRow);
          table.appendChild(head);
          const body = document.createElement('tbody');
          index += 2;
          while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
            const row = document.createElement('tr');
            markdownTableCells(lines[index]).forEach((value) => {
              const cell = document.createElement('td');
              appendInlineMarkdown(cell, value);
              row.appendChild(cell);
            });
            body.appendChild(row);
            index += 1;
          }
          table.appendChild(body);
          container.appendChild(table);
          continue;
        }
        if (/^\\s*[-*]\\s+/.test(line)) {
          const list = document.createElement('ul');
          while (index < lines.length && /^\\s*[-*]\\s+/.test(lines[index])) {
            const item = document.createElement('li');
            appendInlineMarkdown(item, lines[index].replace(/^\\s*[-*]\\s+/, ''));
            list.appendChild(item);
            index += 1;
          }
          container.appendChild(list);
          continue;
        }
        if (/^\\s*\\d+[.)]\\s+/.test(line)) {
          const list = document.createElement('ol');
          while (index < lines.length && /^\\s*\\d+[.)]\\s+/.test(lines[index])) {
            const item = document.createElement('li');
            appendInlineMarkdown(item, lines[index].replace(/^\\s*\\d+[.)]\\s+/, ''));
            list.appendChild(item);
            index += 1;
          }
          container.appendChild(list);
          continue;
        }

        const paragraphLines = [line];
        index += 1;
        while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index], fence)) {
          paragraphLines.push(lines[index]);
          index += 1;
        }
        const paragraph = document.createElement('p');
        paragraphLines.forEach((paragraphLine, lineIndex) => {
          if (lineIndex > 0) {
            paragraph.appendChild(document.createElement('br'));
          }
          appendInlineMarkdown(paragraph, paragraphLine);
        });
        container.appendChild(paragraph);
      }
    }

    function isMarkdownBlockStart(line, fence) {
      return line.trimStart().startsWith(fence)
        || /^(#{1,4})\\s+/.test(line)
        || /^\\s*[-*]\\s+/.test(line)
        || /^\\s*\\d+[.)]\\s+/.test(line);
    }

    function markdownTableCells(line) {
      const trimmed = line.trim().replace(/^\\|/, '').replace(/\\|$/, '');
      return trimmed.split('|').map((cell) => cell.trim());
    }

    function isMarkdownTableSeparator(line) {
      const cells = markdownTableCells(line);
      return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
    }

    function appendInlineMarkdown(container, text) {
      const pattern = /(\\*\\*[^*]+\\*\\*|\\x60[^\\x60]+\\x60|\\[[^\\]]+\\]\\([^)]+\\))/g;
      let cursor = 0;
      for (const match of text.matchAll(pattern)) {
        if (match.index > cursor) {
          container.appendChild(document.createTextNode(text.slice(cursor, match.index)));
        }
        const token = match[0];
        if (token.startsWith('**')) {
          const strong = document.createElement('strong');
          strong.textContent = token.slice(2, -2);
          container.appendChild(strong);
        } else if (token.charCodeAt(0) === 96) {
          appendInlineCode(container, token.slice(1, -1));
        } else {
          const link = token.match(/^\\[([^\\]]+)\\]\\(([^)]+)\\)$/);
          appendMarkdownLink(container, link[1], link[2]);
        }
        cursor = match.index + token.length;
      }
      if (cursor < text.length) {
        container.appendChild(document.createTextNode(text.slice(cursor)));
      }
    }

    function appendInlineCode(container, value) {
      const file = workspaceFileTarget(value);
      if (file) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'markdown-file-link';
        button.textContent = value;
        button.title = 'Open ' + file.path;
        button.addEventListener('click', () => {
          vscode.postMessage({ command: 'openWorkspaceFile', path: file.path, line: file.line });
        });
        container.appendChild(button);
        return;
      }
      const code = document.createElement('code');
      code.className = 'markdown-inline-code';
      code.textContent = value;
      container.appendChild(code);
    }

    function appendMarkdownLink(container, label, target) {
      const file = workspaceFileTarget(target);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'markdown-link';
      button.textContent = label;
      if (file) {
        button.title = 'Open ' + file.path;
        button.addEventListener('click', () => {
          vscode.postMessage({ command: 'openWorkspaceFile', path: file.path, line: file.line });
        });
      } else if (/^https?:\\/\\//i.test(target)) {
        button.title = target;
        button.addEventListener('click', () => {
          vscode.postMessage({ command: 'openExternalLink', url: target });
        });
      } else {
        button.disabled = true;
      }
      container.appendChild(button);
    }

    function workspaceFileTarget(value) {
      const normalized = String(value).trim().replace(/^file:\\/\\//i, '');
      if (!normalized || /^https?:\\/\\//i.test(normalized) || normalized.includes(String.fromCharCode(0))) {
        return undefined;
      }
      const lineMatch = normalized.match(/^(.*):(\\d+)$/);
      const filePath = lineMatch ? lineMatch[1] : normalized;
      const line = lineMatch ? Number(lineMatch[2]) : undefined;
      if (!/[\\\\/]/.test(filePath) && !/\\.[A-Za-z0-9]{1,10}$/.test(filePath)) {
        return undefined;
      }
      return { path: filePath, line };
    }

    function appendCodeBlock(container, codeText, language) {
      const wrapper = document.createElement('div');
      wrapper.className = 'markdown-code-block';
      const header = document.createElement('div');
      header.className = 'markdown-code-header';
      const label = document.createElement('span');
      label.textContent = language || 'code';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'markdown-copy';
      copy.textContent = 'Copy';
      copy.addEventListener('click', () => {
        vscode.postMessage({ command: 'copyText', text: codeText });
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
      });
      header.append(label, copy);
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      appendHighlightedCode(code, codeText);
      pre.appendChild(code);
      wrapper.append(header, pre);
      container.appendChild(wrapper);
    }

    function appendHighlightedCode(container, codeText) {
      const keywords = new Set([
        'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def',
        'else', 'export', 'false', 'finally', 'for', 'from', 'function', 'if', 'import',
        'in', 'interface', 'let', 'new', 'None', 'null', 'return', 'static', 'switch',
        'this', 'throw', 'true', 'try', 'type', 'var', 'while', 'yield'
      ]);
      const pattern = /(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*|<!--[\\s\\S]*?-->|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\\b\\d+(?:\\.\\d+)?\\b|\\b[A-Za-z_$][\\w$]*\\b)/g;
      let cursor = 0;
      for (const match of codeText.matchAll(pattern)) {
        if (match.index > cursor) {
          container.appendChild(document.createTextNode(codeText.slice(cursor, match.index)));
        }
        const token = match[0];
        const span = document.createElement('span');
        span.className = 'markdown-token ' + (
          token.startsWith('//') || token.startsWith('/*') || token.startsWith('<!--')
            ? 'comment'
            : token.startsWith('"') || token.startsWith("'")
              ? 'string'
              : /^\\d/.test(token)
                ? 'number'
                : keywords.has(token)
                  ? 'keyword'
                  : ''
        );
        span.textContent = token;
        container.appendChild(span);
        cursor = match.index + token.length;
      }
      if (cursor < codeText.length) {
        container.appendChild(document.createTextNode(codeText.slice(cursor)));
      }
    }

    function renderSessionMessages(messages) {
      clearWorkingTimer();
      messagesEl.replaceChildren();
      messages.forEach((message) => {
        if ((message.role === 'user' || message.role === 'assistant') && typeof message.text === 'string') {
          appendMessage(message.text, message.role, false);
        }
      });
      messagesEl.scrollTop = messagesEl.scrollHeight;
      questionEl.focus();
    }

    function showSessionHome(render = true) {
      chatAppEl.hidden = true;
      sessionHomeEl.hidden = false;
      if (render) {
        renderSessions();
      }
    }

    function showChat() {
      sessionHomeEl.hidden = true;
      chatAppEl.hidden = false;
    }

    function renderSessions() {
      activeSessionTitleEl.textContent = state.activeSessionTitle;
      sessionSelectorEl.title = state.activeSessionTitle + ' · Back to sessions';
      sessionSelectorEl.setAttribute('aria-label', sessionSelectorEl.title);
      currentProjectLabelEl.textContent = 'Current project: ' + state.currentWorkspaceName;
      sessionListEl.replaceChildren();
      sessionEmptyEl.hidden = state.sessions.length > 0;
      state.sessions.forEach((session) => {
        const row = document.createElement('li');
        row.className = 'session-row'
          + (session.id === state.activeSessionId && session.belongsToCurrentWorkspace ? ' active' : '')
          + (session.belongsToCurrentWorkspace ? '' : ' foreign');

        const select = document.createElement('button');
        select.type = 'button';
        select.className = 'session-select';
        const title = document.createElement('span');
        title.className = 'session-title';
        title.textContent = session.title;
        const meta = document.createElement('span');
        meta.className = 'session-meta';
        const project = document.createElement('span');
        project.className = 'session-project-badge';
        project.textContent = session.workspaceName
          + (session.belongsToCurrentWorkspace ? '' : ' · Different project');
        const turns = Number(session.turnCount) || 0;
        const updated = Number.isFinite(session.updatedAt)
          ? new Date(session.updatedAt).toLocaleString()
          : '';
        const details = document.createElement('span');
        details.textContent = ' · ' + turns + (turns === 1 ? ' turn' : ' turns')
          + (updated ? ' · ' + updated : '');
        meta.append(project, details);
        select.append(title, meta);
        select.addEventListener('click', () => {
          sessionProjectWarningEl.hidden = true;
          vscode.postMessage({ command: 'selectSession', sessionId: session.id });
        });

        const actions = document.createElement('span');
        actions.className = 'session-actions';
        const rename = document.createElement('button');
        rename.type = 'button';
        rename.className = 'session-action';
        rename.textContent = '✎';
        rename.title = 'Rename session';
        rename.setAttribute('aria-label', rename.title);
        rename.addEventListener('click', () => {
          vscode.postMessage({ command: 'renameSession', sessionId: session.id });
        });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'session-action';
        remove.textContent = '×';
        remove.title = 'Delete session';
        remove.setAttribute('aria-label', remove.title);
        remove.addEventListener('click', () => {
          vscode.postMessage({ command: 'deleteSession', sessionId: session.id });
        });
        actions.append(rename, remove);
        row.append(select, actions);
        sessionListEl.appendChild(row);
      });
    }

    function startWorkingTurn() {
      clearProviderStreamAnimation();
      document.getElementById('workingTurn')?.remove();
      clearWorkingTimer();
      state.workingStartedAt = Date.now();

      const card = document.createElement('article');
      card.id = 'workingTurn';
      card.className = 'message assistant working-card';
      card.dataset.state = 'working';
      card.setAttribute('aria-live', 'polite');

      const author = document.createElement('span');
      author.className = 'message-author';
      author.textContent = 'DevMate';
      card.appendChild(author);

      const header = document.createElement('div');
      header.className = 'working-header';
      const indicator = document.createElement('span');
      indicator.className = 'working-indicator';
      indicator.setAttribute('aria-hidden', 'true');
      header.appendChild(indicator);
      const heading = document.createElement('span');
      heading.className = 'working-heading';
      heading.textContent = 'Working on your request';
      header.appendChild(heading);
      const model = document.createElement('span');
      model.className = 'working-model';
      model.textContent = state.activeProfile?.name || 'Selected model';
      model.title = state.activeProfile
        ? state.activeProfile.providerLabel + ' · ' + state.activeProfile.model
        : '';
      header.appendChild(model);
      card.appendChild(header);

      const phases = document.createElement('ul');
      phases.className = 'working-phases';
      card.appendChild(phases);

      const stream = document.createElement('div');
      stream.className = 'working-stream';
      stream.hidden = true;
      stream.setAttribute('aria-label', 'Streaming model response');
      card.appendChild(stream);

      const footer = document.createElement('div');
      footer.className = 'working-footer';
      const elapsed = document.createElement('span');
      elapsed.className = 'working-elapsed';
      footer.appendChild(elapsed);
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'working-cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        if (cancel.disabled) {
          return;
        }
        cancel.disabled = true;
        cancel.textContent = 'Cancelling…';
        updateWorkingTurn('Cancelling request');
        vscode.postMessage({ command: 'cancelRequest' });
      });
      footer.appendChild(cancel);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'working-retry';
      retry.textContent = 'Retry now';
      retry.hidden = true;
      retry.addEventListener('click', () => {
        if (retry.disabled || !state.lastRequest || state.askPending) {
          return;
        }
        retry.disabled = true;
        state.askPending = true;
        setStatus('Ready');
        startWorkingTurn();
        renderAskAvailability();
        vscode.postMessage(state.lastRequest);
      });
      footer.appendChild(retry);
      card.appendChild(footer);
      messagesEl.appendChild(card);

      updateWorkingElapsed();
      state.workingTimer = setInterval(updateWorkingElapsed, 1000);
      updateWorkingTurn('Preparing request');
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function clearProviderStreamAnimation() {
      if (state.streamPumpTimer) {
        clearTimeout(state.streamPumpTimer);
        state.streamPumpTimer = undefined;
      }
      state.streamQueue = '';
      state.pendingAssistantResponse = undefined;
    }

    function resetProviderStream() {
      clearProviderStreamAnimation();
      const stream = document.querySelector('#workingTurn .working-stream');
      if (!stream) {
        return;
      }
      stream.textContent = '';
      stream.hidden = true;
    }

    function appendProviderStreamDelta(text) {
      if (typeof text !== 'string' || !text) {
        return;
      }
      state.streamQueue = (state.streamQueue + text).slice(-50_000);
      ensureProviderStreamPump();
    }

    function ensureProviderStreamPump() {
      if (state.streamPumpTimer) {
        return;
      }
      state.streamPumpTimer = setTimeout(pumpProviderStream, 18);
    }

    function pumpProviderStream() {
      state.streamPumpTimer = undefined;
      const stream = document.querySelector('#workingTurn .working-stream');
      if (!stream) {
        state.streamQueue = '';
        state.pendingAssistantResponse = undefined;
        return;
      }

      if (state.streamQueue) {
        const chunkSize = state.streamQueue.length > 4_000
          ? 80
          : state.streamQueue.length > 1_000
            ? 30
            : 10;
        const chunk = state.streamQueue.slice(0, chunkSize);
        state.streamQueue = state.streamQueue.slice(chunkSize);
        stream.textContent = (stream.textContent + chunk).slice(-50_000);
        stream.hidden = false;
        stream.scrollTop = stream.scrollHeight;
        messagesEl.scrollTop = messagesEl.scrollHeight;
        state.streamPumpTimer = setTimeout(pumpProviderStream, 18);
        return;
      }

      if (state.pendingAssistantResponse !== undefined) {
        const response = state.pendingAssistantResponse;
        state.pendingAssistantResponse = undefined;
        state.streamPumpTimer = setTimeout(() => {
          state.streamPumpTimer = undefined;
          completeAssistantResponse(response);
        }, 120);
      }
    }

    function completeAssistantResponse(response) {
      finishWorkingTurn(response);
      state.askPending = false;
      renderAskAvailability();
    }

    function updateWorkingTurn(text) {
      const card = document.getElementById('workingTurn');
      if (!card || card.dataset.state !== 'working' || !text || text === 'Ready') {
        return;
      }
      const phases = card.querySelector('.working-phases');
      const active = phases.querySelector('.working-phase[data-status="active"]');
      if (active?.querySelector('.working-phase-text').textContent === text) {
        return;
      }
      if (active) {
        active.dataset.status = 'completed';
        active.querySelector('.working-phase-icon').textContent = '✓';
      }

      const phase = document.createElement('li');
      phase.className = 'working-phase';
      phase.dataset.status = 'active';
      const icon = document.createElement('span');
      icon.className = 'working-phase-icon';
      icon.textContent = '●';
      phase.appendChild(icon);
      const label = document.createElement('span');
      label.className = 'working-phase-text';
      label.textContent = text;
      phase.appendChild(label);
      phases.appendChild(phase);

      while (phases.children.length > 4) {
        phases.firstElementChild.remove();
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function markWorkingTurnCancelling() {
      const card = document.getElementById('workingTurn');
      if (!card) {
        return;
      }
      const cancel = card.querySelector('.working-cancel');
      cancel.disabled = true;
      cancel.textContent = 'Cancelling…';
      updateWorkingTurn('Cancelling request');
    }

    function stopWorkingTurn(stateName, detail, retryable = false) {
      clearProviderStreamAnimation();
      const card = document.getElementById('workingTurn');
      if (!card) {
        return;
      }
      clearWorkingTimer();
      card.dataset.state = stateName;
      card.querySelector('.working-heading').textContent = stateName === 'cancelled'
        ? 'Request cancelled'
        : 'Request stopped';
      const active = card.querySelector('.working-phase[data-status="active"]');
      if (active) {
        active.dataset.status = stateName;
        active.querySelector('.working-phase-icon').textContent = stateName === 'cancelled' ? '■' : '!';
      }
      if (detail && active?.querySelector('.working-phase-text').textContent !== detail) {
        const phase = document.createElement('li');
        phase.className = 'working-phase';
        phase.dataset.status = stateName;
        const icon = document.createElement('span');
        icon.className = 'working-phase-icon';
        icon.textContent = stateName === 'cancelled' ? '■' : '!';
        phase.appendChild(icon);
        const label = document.createElement('span');
        label.className = 'working-phase-text';
        label.textContent = detail;
        phase.appendChild(label);
        card.querySelector('.working-phases').appendChild(phase);
      }
      card.querySelector('.working-cancel').hidden = true;
      card.querySelector('.working-retry').hidden = !retryable;
      updateWorkingElapsed();
      card.removeAttribute('id');
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function finishWorkingTurn(response) {
      clearProviderStreamAnimation();
      clearWorkingTimer();
      document.getElementById('workingTurn')?.remove();
      appendMessage(response, 'assistant');
    }

    function cancelPendingPermissionCards() {
      document.querySelectorAll('.permission-card').forEach((card) => {
        const resolution = card.querySelector('.permission-resolution');
        if (!resolution.hidden) {
          return;
        }
        card.querySelectorAll('button').forEach((button) => {
          button.disabled = true;
        });
        resolution.hidden = false;
        resolution.textContent = 'Cancelled with request';
      });
    }

    function updateWorkingElapsed() {
      const elapsed = document.querySelector('#workingTurn .working-elapsed');
      if (!elapsed || !state.workingStartedAt) {
        return;
      }
      const totalSeconds = Math.max(0, Math.floor((Date.now() - state.workingStartedAt) / 1000));
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      elapsed.textContent = minutes > 0
        ? 'Elapsed ' + minutes + 'm ' + String(seconds).padStart(2, '0') + 's'
        : 'Elapsed ' + seconds + 's';
    }

    function clearWorkingTimer() {
      if (state.workingTimer !== undefined) {
        clearInterval(state.workingTimer);
        state.workingTimer = undefined;
      }
    }

    function appendPermissionRequest(message) {
      const files = Array.isArray(message.files) ? message.files : [];
      const card = document.createElement('article');
      card.className = 'message assistant permission-card';
      card.dataset.requestId = message.requestId;

      const author = document.createElement('span');
      author.className = 'message-author';
      author.textContent = 'DevMate';
      card.appendChild(author);

      const title = document.createElement('h3');
      title.className = 'permission-title';
      title.textContent = files.length === 1
        ? 'Permission required for 1 file'
        : 'Permission required for ' + files.length + ' files';
      card.appendChild(title);

      if (message.summary) {
        const summary = document.createElement('p');
        summary.className = 'permission-summary';
        summary.textContent = message.summary;
        card.appendChild(summary);
      }

      const list = document.createElement('ul');
      list.className = 'permission-file-list';
      files.forEach((file) => {
        const item = document.createElement('li');
        item.className = 'permission-file';

        const operation = document.createElement('span');
        operation.className = 'permission-operation';
        operation.textContent = ({
          create: 'Create',
          update: 'Update',
          delete: 'Delete',
          rename: 'Rename',
          move: 'Move'
        })[file.operation] || 'Change';
        item.appendChild(operation);

        const filePath = document.createElement('span');
        filePath.className = 'permission-path';
        filePath.textContent = file.path;
        filePath.title = file.path;
        item.appendChild(filePath);
        if (file.canReview) {
          const review = document.createElement('button');
          review.type = 'button';
          review.className = 'review-diff-button';
          review.textContent = 'Review diff';
          review.addEventListener('click', () => {
            vscode.postMessage({
              command: 'reviewPermissionDiff',
              requestId: message.requestId,
              path: file.path
            });
          });
          item.appendChild(review);
        }
        list.appendChild(item);
      });
      card.appendChild(list);

      const actions = document.createElement('div');
      actions.className = 'permission-actions';
      const resolution = document.createElement('div');
      resolution.className = 'permission-resolution';
      resolution.hidden = true;

      const addDecisionButton = (label, decision, primary = false) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'action-button ' + (primary ? 'primary' : 'secondary');
        button.textContent = label;
        button.addEventListener('click', () => {
          actions.querySelectorAll('button').forEach((candidate) => {
            candidate.disabled = true;
          });
          resolution.hidden = false;
          resolution.textContent = decision === 'deny'
            ? 'Denied'
            : decision === 'allowAlways'
              ? 'Allowed and remembered'
              : 'Allowed once';
          vscode.postMessage({
            command: 'permissionDecision',
            requestId: message.requestId,
            decision
          });
        }, { once: true });
        actions.appendChild(button);
      };

      addDecisionButton('Deny', 'deny');
      if (message.rememberable !== false) {
        addDecisionButton('Always allow these', 'allowAlways');
      }
      addDecisionButton('Allow once', 'allowOnce', true);
      card.appendChild(actions);
      card.appendChild(resolution);
      messagesEl.appendChild(card);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendCommandPermissionRequest(message) {
      const card = document.createElement('article');
      card.className = 'message assistant permission-card';
      card.dataset.requestId = message.requestId;

      const author = document.createElement('span');
      author.className = 'message-author';
      author.textContent = 'DevMate';
      card.appendChild(author);

      const title = document.createElement('h3');
      title.className = 'permission-title';
      title.textContent = message.title || 'Permission required to run a command';
      card.appendChild(title);

      const command = document.createElement('code');
      command.className = 'permission-summary';
      command.textContent = message.label;
      card.appendChild(command);

      const cwd = document.createElement('p');
      cwd.className = 'permission-summary';
      cwd.textContent = 'Working directory: ' + message.cwd;
      card.appendChild(cwd);

      const warning = document.createElement('p');
      warning.className = 'permission-summary';
      warning.textContent = message.warning
        || 'Verification commands can execute code from this trusted workspace.';
      card.appendChild(warning);

      const actions = document.createElement('div');
      actions.className = 'permission-actions';
      const resolution = document.createElement('div');
      resolution.className = 'permission-resolution';
      resolution.hidden = true;
      const addDecisionButton = (label, decision, primary = false) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'action-button ' + (primary ? 'primary' : 'secondary');
        button.textContent = label;
        button.addEventListener('click', () => {
          actions.querySelectorAll('button').forEach((candidate) => {
            candidate.disabled = true;
          });
          resolution.hidden = false;
          resolution.textContent = decision === 'deny'
            ? 'Denied'
            : decision === 'allowAlways'
              ? 'Allowed and remembered for this workspace'
              : 'Allowed once';
          vscode.postMessage({
            command: 'commandPermissionDecision',
            requestId: message.requestId,
            decision
          });
        }, { once: true });
        actions.appendChild(button);
      };
      addDecisionButton('Deny', 'deny');
      if (message.rememberable !== false) {
        addDecisionButton('Always allow this command', 'allowAlways');
      }
      addDecisionButton('Allow once', 'allowOnce', true);
      card.appendChild(actions);
      card.appendChild(resolution);
      messagesEl.appendChild(card);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function renderAgentToolActivity(activity) {
      let item = Array.from(messagesEl.querySelectorAll('.tool-activity')).find(
        (candidate) => candidate.dataset.activityId === activity.id
      );
      if (!item) {
        item = document.createElement('article');
        item.className = 'tool-activity';
        item.dataset.activityId = activity.id;
        item.setAttribute('aria-live', 'polite');

        const icon = document.createElement('span');
        icon.className = 'tool-activity-icon';
        item.appendChild(icon);

        const copy = document.createElement('div');
        copy.className = 'tool-activity-copy';
        const title = document.createElement('span');
        title.className = 'tool-activity-title';
        copy.appendChild(title);
        const detail = document.createElement('span');
        detail.className = 'tool-activity-detail';
        copy.appendChild(detail);
        const result = document.createElement('span');
        result.className = 'tool-activity-result';
        copy.appendChild(result);
        const openTerminal = document.createElement('button');
        openTerminal.type = 'button';
        openTerminal.className = 'review-diff-button tool-open-terminal';
        openTerminal.textContent = 'Open terminal';
        openTerminal.hidden = true;
        openTerminal.addEventListener('click', () => {
          vscode.postMessage({
            command: 'openCommandTerminal',
            activityId: item.dataset.activityId
          });
        });
        copy.appendChild(openTerminal);
        item.appendChild(copy);
        messagesEl.appendChild(item);
      }

      item.dataset.status = activity.status;
      item.querySelector('.tool-activity-icon').textContent = activity.status === 'running'
        ? '…'
        : activity.status === 'completed'
          ? '✓'
          : '!';
      item.querySelector('.tool-activity-title').textContent = activity.title;
      item.querySelector('.tool-activity-detail').textContent = activity.detail;
      item.querySelector('.tool-activity-result').textContent = activity.result || '';
      item.querySelector('.tool-open-terminal').hidden = !activity.canOpenTerminal;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function renderScope() {
      scopeDetailEl.textContent = state.scope.detail;

      document.querySelectorAll('.scope-button[data-scope]').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.scope === state.scope.kind));
      });
    }

    function renderLlmProfile() {
      if (!state.activeProfile) {
        llmProfileLabelEl.textContent = 'Add model';
        llmProfileSelectorEl.title = 'Add a model profile';
        renderAskAvailability();
        return;
      }

      llmProfileLabelEl.textContent = state.activeProfile.name;
      llmProfileSelectorEl.title = state.activeProfile.providerLabel
        + ' · ' + state.activeProfile.model
        + (state.profileCount > 1 ? ' · Select another model' : ' · Manage model');
      renderAskAvailability();
    }

    function renderAskAvailability() {
      askEl.disabled = !state.activeProfile || state.askPending;
      document.querySelectorAll('.mode-button, .scope-button[data-scope]').forEach((button) => {
        button.disabled = state.askPending;
      });
      attachFilesEl.disabled = state.askPending;
      llmProfileSelectorEl.disabled = state.askPending;
      sessionSelectorEl.disabled = state.askPending;
      newSessionButtonEl.disabled = state.askPending;
      newSessionOnHomeEl.disabled = state.askPending;
      renderBackendStatus();
      askEl.title = !state.activeProfile
        ? 'Add a model profile before asking'
        : state.askPending
          ? 'DevMate is working on your request'
          : '';
    }

    function renderBackendStatus() {
      const backend = state.backendStatus;
      const label = state.backendLabel || 'Backend status';
      backendStatusEl.dataset.state = backend.state;
      backendStatusEl.title = label + (backend.detail ? ' · ' + backend.detail : '')
        + ' · Click to open logs';
      backendStatusEl.setAttribute('aria-label', backendStatusEl.title);
      backendSettingsLabelEl.textContent = label;
      backendSettingsDetailEl.textContent = backend.detail || '';
      backendSettingsBadgeEl.textContent = backend.state === 'online'
        ? 'Online'
        : backend.state === 'starting'
          ? 'Starting'
          : backend.state === 'restarting'
            ? 'Restarting'
            : backend.state === 'disabled'
              ? 'Unmanaged'
              : backend.state === 'checking'
                ? 'Checking'
                : 'Offline';
      restartBackendEl.disabled = state.askPending || !backend.canRestart;
    }

    function showLlmProfileForm(profile, hasApiKey) {
      llmProfileFormEl.reset();
      const isBuiltIn = profile?.builtIn === true;
      llmProfileIdEl.value = profile?.id || '';
      llmProfileNameEl.value = profile?.name || '';
      llmProfileProviderEl.value = profile?.provider || 'openai';
      llmProfileModelEl.value = profile?.model || '';
      llmProfileBaseUrlEl.value = profile?.baseUrl || '';
      llmProfileApiKeyEl.value = '';
      llmProfileNameEl.disabled = isBuiltIn;
      llmProfileProviderEl.disabled = isBuiltIn;
      llmProfileModelEl.disabled = isBuiltIn;
      llmProfileBaseUrlEl.disabled = isBuiltIn;
      llmProfileProviderEl.options[0].textContent = isBuiltIn ? 'NVIDIA' : 'OpenAI';
      llmProfileFormEl.dataset.builtIn = String(isBuiltIn);
      llmProfileDialogEl.dataset.hasApiKey = String(Boolean(hasApiKey));
      llmProfileDialogEl.dataset.currentProvider = llmProfileProviderEl.value;
      llmProfileFormTitleEl.textContent = isBuiltIn
        ? 'Configure built-in Nemotron'
        : profile
          ? 'Edit model profile'
          : 'Add model profile';
      llmProfileFormDescriptionEl.textContent = isBuiltIn
        ? 'Nemotron is included with DevMate. Add your NVIDIA API key to use it.'
        : 'Save a reusable model configuration for DevMate.';
      saveLlmProfileEl.textContent = isBuiltIn
        ? 'Save API key'
        : profile
          ? 'Save changes'
          : 'Add model';
      setLlmProfileFormError('');
      setLlmProfileFormSaving(false);
      renderLlmProfileProvider(false);
      if (!llmProfileDialogEl.open) {
        llmProfileDialogEl.showModal();
      }
      (isBuiltIn ? llmProfileApiKeyEl : llmProfileNameEl).focus();
    }

    function closeLlmProfileForm() {
      llmProfileApiKeyEl.value = '';
      if (llmProfileDialogEl.open) {
        llmProfileDialogEl.close();
      }
    }

    function renderLlmProfileProvider(providerChanged) {
      const provider = llmProfileProviderEl.value;
      const previousProvider = llmProfileDialogEl.dataset.currentProvider;
      const isOllama = provider === 'ollama';

      if (providerChanged && isOllama && !llmProfileBaseUrlEl.value.trim()) {
        llmProfileBaseUrlEl.value = ollamaDefaultBaseUrl;
      }
      if (
        providerChanged
        && !isOllama
        && previousProvider === 'ollama'
        && llmProfileBaseUrlEl.value.trim() === ollamaDefaultBaseUrl
      ) {
        llmProfileBaseUrlEl.value = '';
      }

      llmProfileDialogEl.dataset.currentProvider = provider;
      llmProfileApiKeyFieldEl.hidden = isOllama;
      llmProfileModelEl.placeholder = isOllama ? 'llama3.2' : 'gpt-4.1-mini';
      llmProfileBaseUrlEl.placeholder = isOllama
        ? ollamaDefaultBaseUrl
        : 'Optional — uses the OpenAI default';
      llmProfileBaseUrlHelpEl.textContent = isOllama
        ? 'Enter the URL of the Ollama server.'
        : llmProfileFormEl.dataset.builtIn === 'true'
          ? 'DevMate uses NVIDIA’s built-in OpenAI-compatible endpoint.'
          : 'Leave blank to use the OpenAI default.';
      llmProfileApiKeyHelpEl.textContent = llmProfileDialogEl.dataset.hasApiKey === 'true'
        ? 'A key is already stored. Leave this blank to keep it, or enter a replacement.'
        : llmProfileFormEl.dataset.builtIn === 'true'
          ? 'Enter an NVIDIA API key. It is saved in VS Code SecretStorage.'
          : 'The key is transferred to the extension and saved in VS Code SecretStorage.';
    }

    function setLlmProfileFormError(message) {
      llmProfileFormErrorEl.textContent = message;
      llmProfileFormErrorEl.hidden = !message;
    }

    function setLlmProfileFormSaving(saving) {
      saveLlmProfileEl.disabled = saving;
      if (saving) {
        saveLlmProfileEl.textContent = 'Saving...';
      } else {
        saveLlmProfileEl.textContent = llmProfileFormEl.dataset.builtIn === 'true'
          ? 'Save API key'
          : llmProfileIdEl.value
            ? 'Save changes'
            : 'Add model';
      }
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
function waitForRetryDelay(milliseconds, signal) {
    if (signal.aborted) {
        return Promise.resolve(false);
    }
    return new Promise((resolve) => {
        const finish = (completed) => {
            clearTimeout(timeout);
            signal.removeEventListener('abort', cancel);
            resolve(completed);
        };
        const cancel = () => finish(false);
        const timeout = setTimeout(() => finish(true), milliseconds);
        signal.addEventListener('abort', cancel, { once: true });
    });
}
function getBackendUrl() {
    return vscode.workspace
        .getConfiguration('devMate')
        .get('backendUrl', 'http://127.0.0.1:8000')
        .trim();
}
function normalizeRelativeWorkspacePath(value) {
    return value.replace(/\\/g, '/');
}
function agentPathMatches(left, right) {
    return comparableWorkspacePath(left) === comparableWorkspacePath(right);
}
function agentPathStartsWith(filePath, directoryPath) {
    return comparableWorkspacePath(filePath).startsWith(`${comparableWorkspacePath(directoryPath)}/`);
}
function comparableWorkspacePath(value) {
    return process.platform === 'win32' ? value.toLocaleLowerCase() : value;
}
function describeAgentToolCall(call) {
    if (call.name === 'list_files') {
        return {
            title: 'Listing project files',
            detail: call.arguments.path || 'Project root'
        };
    }
    if (call.name === 'read_file') {
        return {
            title: 'Reading file',
            detail: call.arguments.path
        };
    }
    if (call.name === 'create_file') {
        return {
            title: 'Creating file',
            detail: call.arguments.path
        };
    }
    if (call.name === 'edit_file') {
        return {
            title: 'Editing file',
            detail: call.arguments.path
        };
    }
    if (call.name === 'delete_file') {
        return {
            title: 'Deleting file',
            detail: call.arguments.path
        };
    }
    if (call.name === 'rename_file') {
        return {
            title: 'Renaming file',
            detail: `${call.arguments.path} → ${call.arguments.newPath}`
        };
    }
    if (call.name === 'move_file') {
        return {
            title: 'Moving file',
            detail: `${call.arguments.path} → ${call.arguments.newPath}`
        };
    }
    if (call.name === 'install_dependencies') {
        return {
            title: 'Installing Python dependencies',
            detail: call.arguments.manifestPath
        };
    }
    if (call.name === 'run_command') {
        return {
            title: 'Running verification command',
            detail: call.arguments.executable
        };
    }
    return {
        title: 'Searching code',
        detail: `"${call.arguments.query}"${call.arguments.path ? ` in ${call.arguments.path}` : ''}`
    };
}
function isRecoverableEmptyModelResponse(message) {
    const normalized = message.toLocaleLowerCase();
    return normalized.includes('response budget for reasoning')
        || normalized.includes('empty final answer')
        || normalized.includes('empty or invalid answer');
}
function formatAskResponse(answer, usedFiles) {
    if (usedFiles.length === 0) {
        return answer;
    }
    return [
        answer,
        '',
        'Used files:',
        ...usedFiles.map((file) => '- `' + file + '`')
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
function formatExcerptCount(count) {
    return count === 1 ? '1 relevant project excerpt' : `${count} relevant project excerpts`;
}
//# sourceMappingURL=extension.js.map