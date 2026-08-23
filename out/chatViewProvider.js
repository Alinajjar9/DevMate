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
exports.DevMateChatViewProvider = void 0;
exports.getBackendUrl = getBackendUrl;
const crypto_1 = require("crypto");
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const agentTools_1 = require("./agentTools");
const agentTools_2 = require("./agentTools");
const sessions_1 = require("./sessions");
const backendManager_1 = require("./backendManager");
const embeddingProfileController_1 = require("./embeddingProfileController");
const webview_1 = require("./webview");
const fileTools_1 = require("./fileTools");
const sessions_2 = require("./sessions");
const sessionRepository_1 = require("./sessionRepository");
const commandTools_1 = require("./commandTools");
const fileTools_2 = require("./fileTools");
const llmProfiles_1 = require("./llmProfiles");
const permissions_1 = require("./permissions");
const projectIndex_1 = require("./projectIndex");
const projectRetriever_1 = require("./projectRetriever");
const workspaceContext_1 = require("./workspaceContext");
const workspaceMutations_1 = require("./workspaceMutations");
const toolExecutor_1 = require("./toolExecutor");
const agentRunController_1 = require("./agentRunController");
const chatCompaction_1 = require("./chatCompaction");
const contextPlanner_1 = require("./contextPlanner");
class DevMateChatViewProvider {
    extensionContext;
    backendManager;
    backendOutput;
    sessionRepository;
    static viewId = 'devmate.dedicatedAssistantView';
    static containerId = 'devmate-dedicated-chat';
    static diffScheme = 'devmate-diff';
    view;
    attachedFiles = new Map();
    viewDisposables = [];
    lifetimeDisposables = [];
    extensionUri;
    workspaceContext;
    workspaceMutations;
    toolExecutor;
    agentRunController;
    chatCompactionController;
    embeddingProfiles;
    pendingPermission;
    pendingCommandPermission;
    activeRequest;
    diffDocuments = new Map();
    completedFileDiffs = new Map();
    activeRequestDiffs = new Map();
    sessionStore;
    sessionsLoaded = false;
    sessionRevision = 0;
    dirtySessionIds = new Set();
    deletedSessionIds = new Set();
    sessionSynchronization;
    sessionWriteQueue = Promise.resolve();
    agentCheckpoint;
    constructor(extensionContext, backendManager, backendOutput, projectRetriever = new projectRetriever_1.LexicalProjectRetriever(), onEmbeddingProfileChanged = () => undefined, sessionRepository = new sessionRepository_1.SqliteSessionRepository(), chatCompactionController = new chatCompaction_1.ChatCompactionController()) {
        this.extensionContext = extensionContext;
        this.backendManager = backendManager;
        this.backendOutput = backendOutput;
        this.sessionRepository = sessionRepository;
        this.extensionUri = extensionContext.extensionUri;
        this.workspaceContext = new workspaceContext_1.WorkspaceContext(extensionContext.storageUri, (text) => this.postStatus(text), projectRetriever);
        this.workspaceMutations = new workspaceMutations_1.WorkspaceMutations({
            getPermissionPolicy: () => this.getPermissionPolicy(),
            requestPermission: (summary, files) => this.requestFileChangePermission(summary, files),
            reportStatus: (text) => this.postStatus(text),
            recordCompletedDiff: (filePath, originalContent, proposedContent, previousPath) => {
                this.rememberCompletedFileDiff(filePath, originalContent, proposedContent, previousPath);
            }
        });
        this.toolExecutor = new toolExecutor_1.ToolExecutor(this.workspaceContext, this.workspaceMutations, {
            getAgentToolSettings: () => this.getAgentToolSettings(),
            requestCommandPermission: (signature, label, cwd, options) => this.requestCommandPermission(signature, label, cwd, options),
            postAgentToolActivity: (id, title, detail, status, result, canOpenTerminal) => this.postAgentToolActivity(id, title, detail, status, result, canOpenTerminal)
        });
        this.agentCheckpoint = (0, sessions_1.parseAgentRunCheckpoint)(extensionContext.workspaceState.get(sessions_1.AGENT_CHECKPOINT_STORAGE_KEY));
        this.sessionStore = (0, sessions_2.createEmptyConversationSessionStore)();
        this.agentRunController = new agentRunController_1.AgentRunController(this.toolExecutor, {
            saveCheckpoint: (checkpoint) => this.saveAgentCheckpoint(checkpoint),
            recoverBackend: () => this.backendManager.start(),
            emit: (event) => this.handleAgentRunEvent(event)
        });
        this.chatCompactionController = chatCompactionController;
        this.embeddingProfiles = new embeddingProfileController_1.EmbeddingProfileController({
            readState: (key) => this.extensionContext.globalState.get(key),
            writeState: (key, value) => this.extensionContext.globalState.update(key, value),
            readSecret: (key) => this.extensionContext.secrets.get(key),
            writeSecret: (key, value) => this.extensionContext.secrets.store(key, value),
            deleteSecret: (key) => this.extensionContext.secrets.delete(key)
        }, onEmbeddingProfileChanged);
        this.lifetimeDisposables.push(vscode.window.onDidStartTerminalShellExecution((event) => {
            this.toolExecutor.captureWorkspaceTerminalExecution(event);
        }), vscode.window.onDidEndTerminalShellExecution((event) => {
            void this.toolExecutor.finishWorkspaceTerminalExecution(event);
        }));
    }
    resolveWebviewView(webviewView) {
        this.disposeViewDisposables();
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
        };
        webviewView.webview.html = (0, webview_1.getChatWebviewHtml)(webviewView.webview, this.extensionUri);
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
    synchronizeConversationSessions() {
        if (this.sessionSynchronization) {
            return this.sessionSynchronization;
        }
        const operation = this.runSessionSynchronization()
            .catch((error) => {
            this.backendOutput.append('[DevMate] Chat storage: '
                + `${error instanceof Error ? error.message : 'session synchronization failed.'}\n`);
        })
            .finally(() => {
            if (this.sessionSynchronization === operation) {
                this.sessionSynchronization = undefined;
            }
        });
        this.sessionSynchronization = operation;
        return operation;
    }
    async runSessionSynchronization() {
        const workspace = this.getConversationWorkspace();
        if (!workspace) {
            this.sessionsLoaded = true;
            return;
        }
        if (!this.sessionsLoaded) {
            const revision = this.sessionRevision;
            const result = await this.sessionRepository.loadWorkspace(workspace.id);
            if (result.kind !== 'completed') {
                if (result.kind !== 'cancelled') {
                    this.backendOutput.append(`[DevMate] Chat storage: ${result.message}\n`);
                }
                return;
            }
            this.sessionsLoaded = true;
            if (revision === this.sessionRevision
                && this.dirtySessionIds.size === 0
                && this.deletedSessionIds.size === 0) {
                this.sessionStore = result.value;
            }
            this.postSessionState(true);
        }
        await this.flushPendingSessionChanges();
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
        this.toolExecutor.clearActiveTerminalCaptures();
        this.diffDocuments.clear();
        this.completedFileDiffs.clear();
        this.activeRequestDiffs.clear();
        while (this.lifetimeDisposables.length > 0) {
            this.lifetimeDisposables.pop()?.dispose();
        }
    }
    disposeViewDisposables() {
        this.activeRequest?.abort();
        this.activeRequest = undefined;
        const pendingPermission = this.pendingPermission;
        pendingPermission?.resolve(false);
        this.clearPendingDiffDocuments(pendingPermission);
        this.pendingPermission = undefined;
        this.pendingCommandPermission?.resolve(false);
        this.pendingCommandPermission = undefined;
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
            case 'continueAgentRun': {
                if (this.activeRequest) {
                    this.postStatus('DevMate is already working on a request.', 'warning');
                    return;
                }
                const checkpoint = this.currentAgentCheckpoint();
                if (!checkpoint) {
                    this.postRequestFailure('There is no unfinished DevMate run for this session.', {
                        level: 'warning'
                    });
                    this.postAgentCheckpointState();
                    return;
                }
                const requestController = new AbortController();
                this.disposeCommandTerminals();
                this.activeRequest = requestController;
                const scopeLabel = checkpoint.scopeKind === 'project'
                    ? 'Project'
                    : checkpoint.scopeKind === 'activeFile'
                        ? 'File'
                        : 'Selection';
                try {
                    await this.answerQuestion({
                        command: 'ask',
                        mode: checkpoint.mode,
                        question: checkpoint.question,
                        scope: {
                            kind: checkpoint.scopeKind,
                            label: scopeLabel,
                            detail: ''
                        }
                    }, requestController.signal, checkpoint);
                }
                catch (error) {
                    if (!this.finishCancelledRequest(requestController.signal)) {
                        this.postRequestFailure(error instanceof Error ? error.message : 'DevMate could not continue the request.');
                    }
                }
                finally {
                    if (this.activeRequest === requestController) {
                        this.activeRequest = undefined;
                    }
                }
                return;
            }
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
                this.chooseLlmProfile();
                return;
            case 'selectLlmProfile':
                await this.selectLlmProfile(message.profileId);
                return;
            case 'setReasoningEffort':
                await this.setActiveReasoningEffort(message.effort);
                return;
            case 'addLlmProfile':
                await this.showLlmProfileForm();
                return;
            case 'editLlmProfile':
                await this.editLlmProfile(message.profileId);
                return;
            case 'deleteLlmProfile':
                await this.deleteLlmProfileById(message.profileId);
                return;
            case 'saveLlmProfile':
                await this.saveLlmProfile(message.profile);
                return;
            case 'chooseEmbeddingProfile':
                this.chooseEmbeddingProfile();
                return;
            case 'selectEmbeddingProfile':
                await this.selectEmbeddingProfile(message.profileId);
                return;
            case 'addEmbeddingProfile':
                await this.showEmbeddingProfileForm();
                return;
            case 'editEmbeddingProfile':
                await this.showEmbeddingProfileForm(message.profileId);
                return;
            case 'deleteEmbeddingProfile':
                await this.deleteEmbeddingProfile(message.profileId);
                return;
            case 'saveEmbeddingProfile':
                await this.saveEmbeddingProfile(message.profile);
                return;
            case 'saveSettings':
                await this.saveSettings(message.settings);
                return;
            case 'saveAgentToolSettings':
                await this.saveAgentToolSettings(message.settings);
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
            case 'openFileChangeDiff':
                await this.openCompletedFileDiff(message.diffId, message.path);
                return;
            case 'openExternalLink':
                await this.openExternalLink(message.url);
                return;
            case 'commandPermissionDecision':
                await this.handleCommandPermissionDecision(message.requestId, message.decision);
                return;
            case 'openCommandTerminal':
                this.toolExecutor.showCommandTerminal(message.activityId);
                return;
            case 'permissionDecision':
                await this.handlePermissionDecision(message.requestId, message.decision);
                return;
            case 'ready':
                this.postAttachmentState();
                await this.migrateBuiltInNemotronProfile();
                await this.postLlmProfileState();
                await this.promptForBuiltInNemotronKey();
                this.postEmbeddingProfileState();
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
        const previousSessionIds = new Set(this.sessionStore.sessions.map((session) => session.id));
        this.sessionStore = (0, sessions_2.addConversationSession)(this.sessionStore, (0, crypto_1.randomUUID)(), Date.now(), workspace);
        this.sessionRevision += 1;
        await this.persistSession(this.sessionStore.activeSessionId);
        for (const sessionId of previousSessionIds) {
            if (!this.sessionStore.sessions.some((session) => session.id === sessionId)) {
                await this.deletePersistedSession(sessionId);
            }
        }
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
            await this.assertNoWorkspaceSymlink(folder, (0, workspaceContext_1.normalizeRelativeWorkspacePath)(relativePath), false);
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
    async openCompletedFileDiff(diffId, requestedPath) {
        const diff = typeof diffId === 'string' ? this.completedFileDiffs.get(diffId) : undefined;
        if (!diff) {
            this.postStatus('That change snapshot is no longer available. Opening the current file instead.', 'warning');
            await this.openWorkspaceFile(requestedPath);
            return;
        }
        const title = diff.previousPath
            ? `${diff.previousPath} → ${diff.path} (DevMate changes)`
            : `${diff.path} (DevMate changes)`;
        await vscode.commands.executeCommand('vscode.diff', diff.originalUri, diff.proposedUri, title, { preview: true });
    }
    rememberCompletedFileDiff(filePath, originalContent, proposedContent, previousPath) {
        const id = (0, crypto_1.randomUUID)();
        const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
        const originalUri = vscode.Uri.parse(`${DevMateChatViewProvider.diffScheme}:/completed/${id}/before/${encodedPath}`);
        const proposedUri = vscode.Uri.parse(`${DevMateChatViewProvider.diffScheme}:/completed/${id}/after/${encodedPath}`);
        this.diffDocuments.set(originalUri.toString(), originalContent);
        this.diffDocuments.set(proposedUri.toString(), proposedContent);
        this.completedFileDiffs.set(id, {
            id,
            path: filePath,
            ...(previousPath ? { previousPath } : {}),
            originalUri,
            proposedUri
        });
        this.activeRequestDiffs.set(this.fileChangePathKey(filePath), id);
        while (this.completedFileDiffs.size > 40) {
            const oldestId = this.completedFileDiffs.keys().next().value;
            if (!oldestId) {
                break;
            }
            const oldest = this.completedFileDiffs.get(oldestId);
            if (oldest) {
                this.diffDocuments.delete(oldest.originalUri.toString());
                this.diffDocuments.delete(oldest.proposedUri.toString());
            }
            this.completedFileDiffs.delete(oldestId);
            for (const [key, value] of this.activeRequestDiffs) {
                if (value === oldestId) {
                    this.activeRequestDiffs.delete(key);
                }
            }
        }
        return id;
    }
    fileChangePathKey(filePath) {
        const normalized = filePath.replace(/\\/g, '/');
        return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
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
        if (!(0, sessions_2.sessionBelongsToWorkspace)(session, workspace)) {
            this.postSessionWarning(`This session belongs to “${session.workspaceName}”. Open that project to continue it.`);
            return;
        }
        const nextStore = (0, sessions_2.selectConversationSession)(this.sessionStore, sessionId);
        this.sessionStore = nextStore;
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
        this.sessionStore = (0, sessions_2.renameConversationSession)(this.sessionStore, sessionId, title);
        this.sessionRevision += 1;
        await this.persistSession(sessionId);
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
        this.sessionStore = (0, sessions_2.deleteConversationSession)(this.sessionStore, sessionId);
        this.sessionRevision += 1;
        await this.deletePersistedSession(sessionId);
        if (this.agentCheckpoint?.sessionId === sessionId) {
            await this.clearAgentCheckpoint();
        }
        this.postSessionState(false);
    }
    canChangeSession() {
        if (!this.activeRequest) {
            return true;
        }
        this.postStatus('Wait for the active request to finish before changing sessions.', 'warning');
        return false;
    }
    async persistSession(sessionId) {
        const session = this.sessionStore.sessions.find((candidate) => candidate.id === sessionId);
        if (!session) {
            return false;
        }
        const signature = JSON.stringify(session);
        this.dirtySessionIds.add(sessionId);
        this.deletedSessionIds.delete(sessionId);
        const result = await this.enqueueSessionWrite(() => this.sessionRepository.saveSessions([session]));
        if (result.kind === 'completed') {
            const current = this.sessionStore.sessions.find((candidate) => candidate.id === sessionId);
            if (current && JSON.stringify(current) === signature) {
                this.dirtySessionIds.delete(sessionId);
            }
            return true;
        }
        if (result.kind !== 'cancelled') {
            this.reportSessionStorageIssue(result.message);
        }
        return false;
    }
    async deletePersistedSession(sessionId) {
        this.dirtySessionIds.delete(sessionId);
        this.deletedSessionIds.add(sessionId);
        const result = await this.enqueueSessionWrite(() => this.sessionRepository.deleteSession(sessionId));
        if (result.kind === 'completed') {
            if (!this.sessionStore.sessions.some((session) => session.id === sessionId)) {
                this.deletedSessionIds.delete(sessionId);
            }
            return true;
        }
        if (result.kind !== 'cancelled') {
            this.reportSessionStorageIssue(result.message);
        }
        return false;
    }
    async flushPendingSessionChanges() {
        const sessions = [...this.dirtySessionIds]
            .map((id) => this.sessionStore.sessions.find((session) => session.id === id))
            .filter((session) => session !== undefined);
        if (sessions.length > 0) {
            const signatures = new Map(sessions.map((session) => [session.id, JSON.stringify(session)]));
            const result = await this.enqueueSessionWrite(() => this.sessionRepository.saveSessions(sessions));
            if (result.kind === 'completed') {
                for (const [sessionId, signature] of signatures) {
                    const current = this.sessionStore.sessions.find((session) => session.id === sessionId);
                    if (current && JSON.stringify(current) === signature) {
                        this.dirtySessionIds.delete(sessionId);
                    }
                }
            }
            else if (result.kind !== 'cancelled') {
                this.backendOutput.append(`[DevMate] Chat storage: ${result.message}\n`);
            }
        }
        for (const sessionId of [...this.deletedSessionIds]) {
            const result = await this.enqueueSessionWrite(() => this.sessionRepository.deleteSession(sessionId));
            if (result.kind === 'completed') {
                if (!this.sessionStore.sessions.some((session) => session.id === sessionId)) {
                    this.deletedSessionIds.delete(sessionId);
                }
            }
            else if (result.kind !== 'cancelled') {
                this.backendOutput.append(`[DevMate] Chat storage: ${result.message}\n`);
                break;
            }
        }
    }
    reportSessionStorageIssue(message) {
        this.backendOutput.append(`[DevMate] Chat storage: ${message}\n`);
        this.postStatus('This chat is available for now, but local storage could not save it.', 'warning');
    }
    enqueueSessionWrite(operation) {
        const result = this.sessionWriteQueue.then(operation, operation);
        this.sessionWriteQueue = result.then(() => undefined, () => undefined);
        return result;
    }
    postSessionState(includeMessages, openChat = false) {
        const activeSession = (0, sessions_2.activeConversationSession)(this.sessionStore);
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
                belongsToCurrentWorkspace: (0, sessions_2.sessionBelongsToWorkspace)(session, workspace),
                updatedAt: session.updatedAt,
                turnCount: session.turns.length
            })),
            ...(includeMessages && activeSession
                ? {
                    messages: activeSession.turns.flatMap((turn) => [
                        { role: 'user', text: turn.user },
                        ...(turn.assistant
                            ? [{
                                    role: 'assistant',
                                    text: turn.assistant,
                                    fileChanges: turn.fileChanges ?? []
                                }]
                            : [])
                    ])
                }
                : {})
        });
        this.postAgentCheckpointState();
    }
    currentAgentCheckpoint() {
        const workspace = this.getConversationWorkspace();
        const activeSession = (0, sessions_2.activeConversationSession)(this.sessionStore);
        if (!workspace
            || !activeSession
            || this.agentCheckpoint?.workspaceId !== workspace.id
            || this.agentCheckpoint.sessionId !== activeSession.id) {
            return undefined;
        }
        return this.agentCheckpoint;
    }
    postAgentCheckpointState() {
        const checkpoint = this.currentAgentCheckpoint();
        const limit = (0, agentTools_1.boundedAgentToolCallLimit)(vscode.workspace.getConfiguration('devMate').get('toolCallLimit', agentTools_1.DEFAULT_AGENT_TOOL_CALL_LIMIT));
        this.postMessage({
            command: 'agentCheckpointUpdated',
            available: Boolean(checkpoint),
            used: checkpoint?.toolHistory.length ?? 0,
            limit,
            tokenUsage: checkpoint
                ? {
                    inputTokens: checkpoint.inputTokens,
                    outputTokens: checkpoint.outputTokens,
                    totalTokens: checkpoint.totalTokens,
                    exact: checkpoint.tokenUsageExact
                }
                : undefined
        });
    }
    async saveAgentCheckpoint(checkpoint) {
        this.agentCheckpoint = checkpoint;
        try {
            await this.extensionContext.workspaceState.update(sessions_1.AGENT_CHECKPOINT_STORAGE_KEY, checkpoint);
        }
        catch {
            this.postStatus('DevMate could not persist the unfinished agent checkpoint.', 'warning');
        }
        this.postAgentCheckpointState();
    }
    async clearAgentCheckpoint() {
        this.agentCheckpoint = undefined;
        try {
            await this.extensionContext.workspaceState.update(sessions_1.AGENT_CHECKPOINT_STORAGE_KEY, undefined);
        }
        catch {
            this.postStatus('DevMate could not remove the completed agent checkpoint.', 'warning');
        }
        this.postAgentCheckpointState();
    }
    postSessionWarning(message) {
        this.postMessage({ command: 'sessionProjectWarning', message });
    }
    getConversationWorkspace() {
        return this.workspaceContext.getConversationWorkspace();
    }
    collectScope(scope, question, signal) {
        return this.workspaceContext.collectScope(scope, question, this.attachedFiles.values(), signal);
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
            uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), projectIndex_1.PROJECT_EXCLUDE_GLOB, projectIndex_1.MAX_ATTACHMENT_CANDIDATES);
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
            .filter((item) => !(0, projectIndex_1.shouldSkipProjectFile)(item.id))
            .sort((left, right) => left.label.localeCompare(right.label));
        if (choices.length === 0) {
            this.postStatus('No attachable text files were found in the open folder.', 'warning');
            return;
        }
        const selected = await vscode.window.showQuickPick(choices, {
            canPickMany: true,
            matchOnDescription: true,
            placeHolder: `Select up to ${projectIndex_1.MAX_ATTACHED_FILES} files from ${folder.name}`,
            title: 'DevMate: Attach workspace files'
        });
        if (!selected) {
            this.postStatus('Ready');
            return;
        }
        if (selected.length > projectIndex_1.MAX_ATTACHED_FILES) {
            this.postStatus(`Attach at most ${projectIndex_1.MAX_ATTACHED_FILES} files.`, 'warning');
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
    getReasoningEffortPreferences() {
        return (0, llmProfiles_1.parseReasoningEffortPreferences)(this.extensionContext.globalState.get(llmProfiles_1.LLM_REASONING_EFFORT_STORAGE_KEY));
    }
    async setActiveReasoningEffort(effort) {
        if (this.activeRequest) {
            this.postStatus('Wait for the active request to finish before changing intelligence.', 'warning');
            return;
        }
        const profile = this.getActiveLlmProfile();
        if (!profile || !(0, llmProfiles_1.reasoningEffortOptionsForProfile)(profile).includes(effort)) {
            this.postStatus('The selected model does not support that intelligence level.', 'warning');
            await this.postLlmProfileState();
            return;
        }
        const preferences = { ...this.getReasoningEffortPreferences() };
        if (effort === 'auto') {
            delete preferences[profile.id];
        }
        else {
            preferences[profile.id] = effort;
        }
        await this.extensionContext.globalState.update(llmProfiles_1.LLM_REASONING_EFFORT_STORAGE_KEY, preferences);
        await this.postLlmProfileState();
        this.postStatus('Ready');
    }
    async migrateBuiltInNemotronProfile() {
        const storedProfiles = this.getStoredLlmProfiles();
        const equivalentProfiles = storedProfiles.filter((profile) => (0, llmProfiles_1.isEquivalentNemotronProfile)(profile) && profile.contextWindowTokens === undefined);
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
    chooseLlmProfile() {
        const profiles = this.getLlmProfiles();
        const activeProfile = this.getActiveLlmProfile(profiles);
        const reasoningPreferences = this.getReasoningEffortPreferences();
        this.postMessage({
            command: 'showLlmProfilePicker',
            profiles: profiles.map((profile) => ({
                id: profile.id,
                name: profile.name,
                providerLabel: (0, llmProfiles_1.providerLabelForProfile)(profile),
                model: profile.model,
                baseUrl: profile.baseUrl,
                contextWindowTokens: profile.contextWindowTokens,
                intelligence: (0, llmProfiles_1.reasoningEffortOptionsForProfile)(profile).length > 1
                    ? llmProfiles_1.REASONING_EFFORT_LABELS[(0, llmProfiles_1.reasoningEffortForProfile)(profile, reasoningPreferences)]
                    : undefined,
                builtIn: (0, llmProfiles_1.isBuiltInLlmProfile)(profile),
                selected: profile.id === activeProfile?.id
            }))
        });
    }
    async selectLlmProfile(profileId) {
        const profiles = this.getLlmProfiles();
        const profile = profiles.find((candidate) => candidate.id === profileId);
        if (!profile) {
            this.postStatus('That model profile no longer exists.', 'warning');
            return;
        }
        await this.extensionContext.globalState.update(llmProfiles_1.ACTIVE_LLM_PROFILE_STORAGE_KEY, profile.id);
        await this.postLlmProfileState();
        await this.promptForBuiltInNemotronKey();
        this.postStatus('Ready');
    }
    async editLlmProfile(profileId) {
        const profile = this.getLlmProfiles().find((candidate) => candidate.id === profileId);
        if (!profile) {
            this.postStatus('That model profile no longer exists.', 'warning');
            return;
        }
        await this.showLlmProfileForm(profile);
    }
    cancelActiveRequest() {
        if (!this.activeRequest || this.activeRequest.signal.aborted) {
            return;
        }
        this.activeRequest.abort();
        const pendingPermission = this.pendingPermission;
        pendingPermission?.resolve(false);
        this.clearPendingDiffDocuments(pendingPermission);
        this.pendingPermission = undefined;
        this.pendingCommandPermission?.resolve(false);
        this.pendingCommandPermission = undefined;
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
                    contextWindowTokens: profile.contextWindowTokens,
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
            || !(0, contextPlanner_1.isValidModelContextWindowTokens)(submission.contextWindowTokens)
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
        const submittedDraft = {
            name: submission.name,
            provider: submission.provider,
            model: submission.model,
            baseUrl: submission.baseUrl,
            contextWindowTokens: submission.contextWindowTokens
        };
        const validationError = (0, llmProfiles_1.validateProfileDraft)(submittedDraft, profiles, existingProfile?.id);
        if (validationError) {
            this.postMessage({ command: 'llmProfileFormError', message: validationError });
            return;
        }
        const draft = (0, llmProfiles_1.normalizeProfileDraft)(submittedDraft);
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
    async deleteLlmProfileById(profileId) {
        const profile = this.getLlmProfiles().find((candidate) => candidate.id === profileId);
        if (!profile) {
            this.postMessage({
                command: 'llmProfileFormError',
                message: 'That model profile no longer exists.'
            });
            return;
        }
        if ((0, llmProfiles_1.isBuiltInLlmProfile)(profile)) {
            this.postMessage({
                command: 'llmProfileFormError',
                message: 'The built-in Nemotron profile cannot be deleted.'
            });
            return;
        }
        const profiles = this.getLlmProfiles();
        const remainingProfiles = this.getStoredLlmProfiles().filter((candidate) => candidate.id !== profile.id);
        const remainingReasoningPreferences = { ...this.getReasoningEffortPreferences() };
        delete remainingReasoningPreferences[profile.id];
        try {
            await this.extensionContext.globalState.update(llmProfiles_1.LLM_PROFILES_STORAGE_KEY, remainingProfiles);
            await this.extensionContext.globalState.update(llmProfiles_1.LLM_REASONING_EFFORT_STORAGE_KEY, remainingReasoningPreferences);
            await this.extensionContext.secrets.delete((0, llmProfiles_1.secretKeyForProfile)(profile.id));
            const activeProfile = this.getActiveLlmProfile(profiles);
            if (activeProfile?.id === profile.id) {
                await this.extensionContext.globalState.update(llmProfiles_1.ACTIVE_LLM_PROFILE_STORAGE_KEY, llmProfiles_1.BUILT_IN_NEMOTRON_PROFILE_ID);
            }
        }
        catch {
            this.postMessage({
                command: 'llmProfileFormError',
                message: 'Could not delete the model profile.'
            });
            return;
        }
        await this.postLlmProfileState();
        this.postMessage({ command: 'closeLlmProfileForm' });
        this.postStatus(`${profile.name} deleted.`);
    }
    async postLlmProfileState() {
        const profiles = this.getLlmProfiles();
        const activeProfile = this.getActiveLlmProfile(profiles);
        if (activeProfile
            && this.extensionContext.globalState.get(llmProfiles_1.ACTIVE_LLM_PROFILE_STORAGE_KEY) !== activeProfile.id) {
            await this.extensionContext.globalState.update(llmProfiles_1.ACTIVE_LLM_PROFILE_STORAGE_KEY, activeProfile.id);
        }
        const reasoningOptions = activeProfile
            ? (0, llmProfiles_1.reasoningEffortOptionsForProfile)(activeProfile)
            : ['auto'];
        const reasoningEffort = activeProfile
            ? (0, llmProfiles_1.reasoningEffortForProfile)(activeProfile, this.getReasoningEffortPreferences())
            : 'auto';
        this.postMessage({
            command: 'llmProfilesUpdated',
            profileCount: profiles.length,
            activeProfile: activeProfile
                ? {
                    id: activeProfile.id,
                    name: activeProfile.name,
                    provider: activeProfile.provider,
                    providerLabel: (0, llmProfiles_1.providerLabelForProfile)(activeProfile),
                    model: activeProfile.model,
                    reasoningEffort,
                    reasoningEffortOptions: reasoningOptions.map((value) => ({
                        value,
                        label: llmProfiles_1.REASONING_EFFORT_LABELS[value]
                    }))
                }
                : undefined
        });
    }
    postEmbeddingProfileState() {
        const { profiles, activeProfile } = this.embeddingProfiles.state();
        this.postMessage({
            command: 'embeddingProfilesUpdated',
            profileCount: profiles.length,
            activeProfile: activeProfile
                ? {
                    ...activeProfile,
                    providerLabel: (0, embeddingProfileController_1.embeddingProviderLabel)(activeProfile.provider)
                }
                : undefined
        });
    }
    chooseEmbeddingProfile() {
        this.postMessage({
            command: 'showEmbeddingProfilePicker',
            profiles: this.embeddingProfiles.pickerItems()
        });
    }
    async selectEmbeddingProfile(profileId) {
        const result = await this.embeddingProfiles.select(profileId);
        if (!result.ok) {
            this.postStatus(result.message, 'warning');
            return;
        }
        this.postEmbeddingProfileState();
        this.postStatus(`${result.value.model} selected for code embeddings.`);
    }
    async showEmbeddingProfileForm(profileId) {
        const result = await this.embeddingProfiles.form(profileId);
        if (!result.ok) {
            this.postStatus(result.message, 'warning');
            return;
        }
        this.postMessage({
            command: 'showEmbeddingProfileForm',
            profile: result.value.profile,
            hasApiKey: result.value.hasApiKey
        });
    }
    async saveEmbeddingProfile(submission) {
        const result = await this.embeddingProfiles.save(submission);
        if (!result.ok) {
            this.postMessage({
                command: 'embeddingProfileFormError',
                message: result.message
            });
            return;
        }
        this.postEmbeddingProfileState();
        this.postMessage({ command: 'closeEmbeddingProfileForm' });
        this.postStatus(submission.id
            ? `${result.value.model} embedding profile updated.`
            : `${result.value.model} selected for code embeddings.`);
    }
    async deleteEmbeddingProfile(profileId) {
        const result = await this.embeddingProfiles.delete(profileId);
        if (!result.ok) {
            this.postMessage({
                command: 'embeddingProfileFormError',
                message: result.message
            });
            return;
        }
        this.postEmbeddingProfileState();
        this.postMessage({ command: 'closeEmbeddingProfileForm' });
        this.postStatus(`${result.value.model} embedding profile deleted.`);
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
            || !(0, contextPlanner_1.isValidMaxInputContextTokens)(settings.maxInputContextTokens)
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
                config.update('maxInputContextTokens', settings.maxInputContextTokens, vscode.ConfigurationTarget.Global),
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
    getAgentToolSettings() {
        const config = vscode.workspace.getConfiguration('devMate');
        return (0, agentTools_2.normalizeAgentToolSettings)({
            readFileMaxLines: config.get('readFileMaxLines', agentTools_2.DEFAULT_READ_FILE_MAX_LINES),
            listFilesMaxResults: config.get('listFilesMaxResults', agentTools_2.DEFAULT_LIST_FILES_MAX_RESULTS),
            searchCodeMaxResults: config.get('searchCodeMaxResults', agentTools_2.DEFAULT_SEARCH_CODE_MAX_RESULTS),
            diagnosticsMaxResults: config.get('diagnosticsMaxResults', agentTools_2.DEFAULT_DIAGNOSTICS_MAX_RESULTS),
            terminalErrorsMaxResults: config.get('terminalErrorsMaxResults', agentTools_2.DEFAULT_TERMINAL_ERRORS_MAX_RESULTS),
            codeNavigationMaxResults: config.get('codeNavigationMaxResults', agentTools_2.DEFAULT_CODE_NAVIGATION_MAX_RESULTS)
        });
    }
    async saveAgentToolSettings(settings) {
        const normalized = (0, agentTools_2.normalizeAgentToolSettings)(settings);
        if (Object.entries(normalized).some(([key, value]) => settings[key] !== value)) {
            this.postStatus('The agent-tool settings contain an invalid value.', 'warning');
            return;
        }
        const config = vscode.workspace.getConfiguration('devMate');
        try {
            await Promise.all([
                config.update('readFileMaxLines', normalized.readFileMaxLines, vscode.ConfigurationTarget.Global),
                config.update('listFilesMaxResults', normalized.listFilesMaxResults, vscode.ConfigurationTarget.Global),
                config.update('searchCodeMaxResults', normalized.searchCodeMaxResults, vscode.ConfigurationTarget.Global),
                config.update('diagnosticsMaxResults', normalized.diagnosticsMaxResults, vscode.ConfigurationTarget.Global),
                config.update('terminalErrorsMaxResults', normalized.terminalErrorsMaxResults, vscode.ConfigurationTarget.Global),
                config.update('codeNavigationMaxResults', normalized.codeNavigationMaxResults, vscode.ConfigurationTarget.Global)
            ]);
        }
        catch {
            this.postStatus('DevMate could not save the agent-tool settings.', 'error');
            return;
        }
        this.postSettingsState();
        this.postMessage({ command: 'agentToolSettingsSaved' });
        this.postStatus('Ready');
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
                maxInputContextTokens: (0, contextPlanner_1.normalizeMaxInputContextTokens)(config.get('maxInputContextTokens', contextPlanner_1.AUTO_MAX_INPUT_CONTEXT_TOKENS)),
                temperature: Math.min(2, Math.max(0, config.get('temperature', 0.2))),
                agentTools: this.getAgentToolSettings(),
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
        this.clearPendingDiffDocuments(pending);
    }
    clearPendingDiffDocuments(pending) {
        if (!pending) {
            return;
        }
        for (const diff of pending.diffs.values()) {
            this.diffDocuments.delete(diff.originalUri.toString());
            this.diffDocuments.delete(diff.proposedUri.toString());
        }
    }
    requestFileChangePermission(summary, files) {
        const previousPermission = this.pendingPermission;
        previousPermission?.resolve(false);
        this.clearPendingDiffDocuments(previousPermission);
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
        return this.workspaceContext.readProjectCandidate(uri);
    }
    disposeCommandTerminals() {
        this.toolExecutor.disposeCommandTerminals();
    }
    async assertNoWorkspaceSymlink(folder, relativePath, allowMissing) {
        return this.workspaceMutations.assertNoWorkspaceSymlink(folder, relativePath, allowMissing);
    }
    postAgentToolActivity(id, title, detail, status, result, canOpenTerminal = false) {
        this.postMessage({
            command: 'agentToolActivity',
            activity: { id, title, detail, status, result, canOpenTerminal }
        });
    }
    handleAgentRunEvent(event) {
        switch (event.type) {
            case 'status':
                this.postStatus(event.text);
                return;
            case 'stream-reset':
                this.postMessage({ command: 'providerStreamReset' });
                return;
            case 'stream-delta':
                this.postMessage({ command: 'providerStreamDelta', text: event.text });
                return;
            case 'token-usage':
                this.postMessage({ command: 'tokenUsageUpdated', usage: event.usage });
                return;
            case 'tool-usage':
                this.postMessage({
                    command: 'toolUsageUpdated',
                    used: event.used,
                    limit: event.limit
                });
                return;
            case 'tool-activity':
                this.postAgentToolActivity(event.id, event.title, event.detail, event.status, event.result, event.canOpenTerminal);
        }
    }
    async answerQuestion(message, signal, resumedCheckpoint) {
        const question = message.question.trim();
        if (!question) {
            this.postRequestFailure('Enter a question before asking.', { level: 'warning' });
            return;
        }
        if (!resumedCheckpoint) {
            this.activeRequestDiffs.clear();
        }
        const activeSession = (0, sessions_2.activeConversationSession)(this.sessionStore);
        const conversationWorkspace = this.getConversationWorkspace();
        if (!activeSession
            || !conversationWorkspace
            || !(0, sessions_2.sessionBelongsToWorkspace)(activeSession, conversationWorkspace)) {
            this.postRequestFailure('Choose a session for the currently open project before asking.', { level: 'warning' });
            return;
        }
        if (!resumedCheckpoint && message.isNewTurn !== false) {
            this.sessionStore = (0, sessions_2.appendConversationSessionUserMessage)(this.sessionStore, question, Date.now());
            this.sessionRevision += 1;
            await this.persistSession(activeSession.id);
            this.postSessionState(false);
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
        const backendToken = this.backendManager.requestToken;
        if (!backendToken) {
            this.postRequestFailure('DevMate could not establish an authenticated backend connection.', { level: 'warning', retryable: true });
            return;
        }
        this.postStatus('Collecting context');
        const collectedScope = await this.collectScope(message.scope.kind, question, signal);
        if (this.finishCancelledRequest(signal)) {
            return;
        }
        if (!collectedScope) {
            this.postRequestFailure(message.scope.kind === 'selection' ? 'Select code first.' : 'Open a file first.', { level: 'warning' });
            return;
        }
        if (!resumedCheckpoint && this.currentAgentCheckpoint()) {
            await this.clearAgentCheckpoint();
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
        const settings = {
            provider: activeProfile.provider,
            model: activeProfile.model,
            baseUrl: activeProfile.baseUrl,
            maxTokens,
            temperature,
            reasoningEffort: (0, llmProfiles_1.reasoningEffortForProfile)(activeProfile, this.getReasoningEffortPreferences()),
            timeoutSeconds: modelTimeoutSeconds
        };
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
        if (!resumedCheckpoint) {
            const currentSession = (0, sessions_2.activeConversationSession)(this.sessionStore);
            if (currentSession) {
                const compaction = await this.chatCompactionController.compactIfNeeded({
                    session: currentSession,
                    question,
                    scope: collectedScope.apiScope,
                    modelContextWindowTokens: activeProfile.contextWindowTokens,
                    maxInputContextTokens: (0, contextPlanner_1.normalizeMaxInputContextTokens)(config.get('maxInputContextTokens', contextPlanner_1.AUTO_MAX_INPUT_CONTEXT_TOKENS)),
                    settings,
                    access: {
                        backendUrl: getBackendUrl(),
                        backendToken,
                        providerApiKey
                    }
                }, signal, () => this.postStatus('Compacting earlier chat context'));
                if (compaction.kind === 'cancelled' || this.finishCancelledRequest(signal)) {
                    return;
                }
                if (compaction.kind === 'failed') {
                    this.backendOutput.append(`[DevMate] Chat compaction: ${compaction.message}\n`);
                }
            }
        }
        const outcome = await this.agentRunController.run({
            question,
            mode: message.mode,
            scopeKind: message.scope.kind,
            scope: collectedScope.apiScope,
            conversationHistory: (0, sessions_2.activeSessionModelHistory)(this.sessionStore),
            modelContextWindowTokens: activeProfile.contextWindowTokens,
            maxInputContextTokens: (0, contextPlanner_1.normalizeMaxInputContextTokens)(config.get('maxInputContextTokens', contextPlanner_1.AUTO_MAX_INPUT_CONTEXT_TOKENS)),
            settings,
            backendUrl: getBackendUrl(),
            backendToken,
            providerApiKey,
            toolCallLimit,
            workspaceId: conversationWorkspace.id,
            sessionId: activeSession.id,
            resumedCheckpoint
        }, signal);
        if (outcome.kind === 'cancelled') {
            this.finishCancelledRequest(signal);
            return;
        }
        if (outcome.kind === 'failed') {
            this.postRequestFailure(outcome.message, { retryable: outcome.retryable });
            return;
        }
        const { response: finalData, toolHistory, toolUsedFiles } = outcome;
        if (this.finishCancelledRequest(signal)) {
            return;
        }
        let changeOutcome = '';
        try {
            const fileChanges = (0, fileTools_2.validateFileChanges)(finalData.changes ?? []);
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
        const appliedResponseChanges = (0, fileTools_1.parseAppliedFileChangeOutcome)(changeOutcome);
        const fileChangeSummary = (0, fileTools_1.collectFileChangeSummary)(toolHistory, appliedResponseChanges)
            .map((change) => {
            const diffId = this.activeRequestDiffs.get(this.fileChangePathKey(change.path));
            return diffId ? { ...change, diffId } : change;
        });
        const changeNotice = changeOutcome.startsWith('Applied file changes:')
            ? changeOutcome.split('\n\n').slice(1).join('\n\n')
            : changeOutcome;
        const response = [
            formatAskResponse(finalData.answer, [...new Set([...finalData.usedFiles, ...toolUsedFiles])]),
            changeNotice
        ].filter(Boolean).join('\n\n');
        this.sessionStore = (0, sessions_2.appendConversationSessionTurn)(this.sessionStore, question, response, Date.now(), fileChangeSummary);
        this.sessionRevision += 1;
        await this.persistSession(activeSession.id);
        await this.clearAgentCheckpoint();
        this.postMessage({
            command: 'assistantResponse',
            response,
            fileChanges: fileChangeSummary
        });
        this.postSessionState(false);
        this.postStatus('Ready');
    }
    async confirmAndApplyFileChanges(changes, summary, signal) {
        return this.workspaceMutations.confirmAndApplyFileChanges(changes, summary, signal);
    }
    postStatus(text, level = 'info') {
        this.postMessage({ command: 'status', text, level });
    }
    postMessage(message) {
        this.view?.webview.postMessage(message);
    }
}
exports.DevMateChatViewProvider = DevMateChatViewProvider;
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
        ...usedFiles.map((file) => '- `' + file + '`')
    ].join('\n');
}
//# sourceMappingURL=chatViewProvider.js.map