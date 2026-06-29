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
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const agentTools_1 = require("./agentTools");
const client_1 = require("./api/client");
const context_1 = require("./context");
const fileChanges_1 = require("./fileChanges");
const llmProfiles_1 = require("./llmProfiles");
const permissions_1 = require("./permissions");
const projectContext_1 = require("./projectContext");
function activate(context) {
    const chatViewProvider = new DevMateChatViewProvider(context);
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
    const statusBarItem = vscode.window.createStatusBarItem('devMate.statusBar', vscode.StatusBarAlignment.Right, 1000);
    statusBarItem.text = '$(comment-discussion) DevMate';
    statusBarItem.tooltip = 'Open DevMate';
    statusBarItem.command = 'devMate.openChat';
    statusBarItem.show();
    context.subscriptions.push(chatViewProvider, viewRegistration, openChatCommand, statusBarItem);
}
function deactivate() {
    // VS Code disposes registered views and subscriptions.
}
class DevMateChatViewProvider {
    extensionContext;
    static viewId = 'devmate.dedicatedAssistantView';
    static containerId = 'devmate-dedicated-chat';
    view;
    attachedFiles = new Map();
    viewDisposables = [];
    extensionUri;
    pendingPermission;
    activeRequest;
    constructor(extensionContext) {
        this.extensionContext = extensionContext;
        this.extensionUri = extensionContext.extensionUri;
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
        void this.checkBackendHealth();
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
                this.activeRequest = requestController;
                try {
                    await this.answerQuestion(message, requestController.signal);
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
            case 'savePermissionPolicy':
                await this.savePermissionPolicy(message.policy);
                return;
            case 'permissionDecision':
                await this.handlePermissionDecision(message.requestId, message.decision);
                return;
            case 'ready':
                this.postAttachmentState();
                await this.postLlmProfileState();
                this.postPermissionPolicyState();
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
    getLlmProfiles() {
        return (0, llmProfiles_1.parseStoredProfiles)(this.extensionContext.globalState.get(llmProfiles_1.LLM_PROFILES_STORAGE_KEY));
    }
    getActiveLlmProfile(profiles = this.getLlmProfiles()) {
        const activeProfileId = this.extensionContext.globalState.get(llmProfiles_1.ACTIVE_LLM_PROFILE_STORAGE_KEY);
        return profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
    }
    async chooseLlmProfile() {
        const profiles = this.getLlmProfiles();
        if (profiles.length === 0) {
            await this.showLlmProfileForm();
            return;
        }
        const activeProfile = this.getActiveLlmProfile(profiles);
        const choices = profiles.map((profile) => ({
            label: profile.name,
            description: [
                profile.id === activeProfile?.id ? 'Selected' : undefined,
                llmProfiles_1.PROVIDER_LABELS[profile.provider],
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
            description: 'Edit or delete saved profiles',
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
                    baseUrl: profile.baseUrl
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
            ? profiles.map((candidate) => candidate.id === profile.id ? profile : candidate)
            : [...profiles, profile];
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
    async manageLlmProfiles() {
        const profiles = this.getLlmProfiles();
        if (profiles.length === 0) {
            await this.showLlmProfileForm();
            return;
        }
        const selected = await vscode.window.showQuickPick(profiles.map((profile) => ({
            label: profile.name,
            description: `${llmProfiles_1.PROVIDER_LABELS[profile.provider]} · ${profile.model}`,
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
        actions.push({ label: '$(edit) Edit profile', action: 'edit' }, { label: '$(trash) Delete profile', action: 'delete' });
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
            return;
        }
        if (action.action === 'edit') {
            await this.showLlmProfileForm(selected.profile);
            return;
        }
        await this.deleteLlmProfile(selected.profile);
    }
    async deleteLlmProfile(profile) {
        const confirmation = await vscode.window.showWarningMessage(`Delete the model profile "${profile.name}"?`, { modal: true }, 'Delete');
        if (confirmation !== 'Delete') {
            return;
        }
        const profiles = this.getLlmProfiles();
        const remainingProfiles = profiles.filter((candidate) => candidate.id !== profile.id);
        try {
            await this.extensionContext.globalState.update(llmProfiles_1.LLM_PROFILES_STORAGE_KEY, remainingProfiles);
            await this.extensionContext.secrets.delete((0, llmProfiles_1.secretKeyForProfile)(profile.id));
            const activeProfile = this.getActiveLlmProfile(profiles);
            if (activeProfile?.id === profile.id) {
                await this.extensionContext.globalState.update(llmProfiles_1.ACTIVE_LLM_PROFILE_STORAGE_KEY, remainingProfiles[0]?.id);
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
                    providerLabel: llmProfiles_1.PROVIDER_LABELS[activeProfile.provider],
                    model: activeProfile.model
                }
                : undefined
        });
    }
    getPermissionPolicy() {
        return (0, permissions_1.parseFilePermissionPolicy)(this.extensionContext.globalState.get(permissions_1.FILE_PERMISSION_POLICY_STORAGE_KEY));
    }
    async savePermissionPolicy(policy) {
        const normalizedPolicy = (0, permissions_1.parseFilePermissionPolicy)(policy);
        await this.extensionContext.globalState.update(permissions_1.FILE_PERMISSION_POLICY_STORAGE_KEY, normalizedPolicy);
        this.postPermissionPolicyState();
        this.postStatus('Permission settings saved.');
    }
    postPermissionPolicyState() {
        const policy = this.getPermissionPolicy();
        this.postMessage({
            command: 'permissionPolicyUpdated',
            policy,
            label: (0, permissions_1.permissionPolicyLabel)(policy)
        });
    }
    async handlePermissionDecision(requestId, decision) {
        const pending = this.pendingPermission;
        if (!pending || pending.id !== requestId) {
            return;
        }
        this.pendingPermission = undefined;
        if (decision === 'allowAlways') {
            try {
                const updatedPolicy = (0, permissions_1.allowActions)(this.getPermissionPolicy(), pending.actions);
                await this.extensionContext.globalState.update(permissions_1.FILE_PERMISSION_POLICY_STORAGE_KEY, updatedPolicy);
                this.postPermissionPolicyState();
            }
            catch {
                this.postStatus('The changes are allowed this time, but the permission preference could not be saved.', 'warning');
            }
        }
        pending.resolve(decision !== 'deny');
    }
    requestFileChangePermission(summary, files) {
        this.pendingPermission?.resolve(false);
        const requestId = (0, crypto_1.randomUUID)();
        const actions = new Set(files.map((file) => file.operation));
        return new Promise((resolve) => {
            this.pendingPermission = { id: requestId, actions, resolve };
            this.postMessage({
                command: 'permissionRequest',
                requestId,
                summary,
                files
            });
        });
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
    async executeAgentToolCall(call) {
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
                usedFiles: []
            };
        }
        const activity = describeAgentToolCall(parsedCall);
        this.postAgentToolActivity(call.id, activity.title, activity.detail, 'running');
        try {
            const execution = await this.runAgentTool(parsedCall);
            this.postAgentToolActivity(call.id, activity.title, activity.detail, 'completed', execution.resultSummary);
            return {
                step: {
                    callId: parsedCall.id,
                    name: parsedCall.name,
                    arguments: parsedCall.arguments,
                    result: (0, agentTools_1.truncateAgentToolResult)(execution.result),
                    isError: false
                },
                usedFiles: execution.usedFiles
            };
        }
        catch (error) {
            const result = error instanceof Error ? error.message : 'The tool could not be completed.';
            this.postAgentToolActivity(call.id, activity.title, activity.detail, 'error', result);
            return {
                step: {
                    callId: parsedCall.id,
                    name: parsedCall.name,
                    arguments: parsedCall.arguments,
                    result: (0, agentTools_1.truncateAgentToolResult)(result),
                    isError: true
                },
                usedFiles: []
            };
        }
    }
    async runAgentTool(call) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            throw new Error('Open a workspace folder before using project tools.');
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
                usedFiles: []
            };
        }
        if (call.name === 'read_file') {
            const uri = vscode.Uri.joinPath(folder.uri, ...call.arguments.path.split('/'));
            const candidate = await this.readProjectCandidate(uri);
            if (!candidate
                || !agentPathMatches(normalizeRelativeWorkspacePath(candidate.relativePath), call.arguments.path)) {
                throw new Error('The file does not exist or is excluded from DevMate context.');
            }
            const result = (0, agentTools_1.truncateAgentToolResult)([
                `Path: ${call.arguments.path}`,
                `Language: ${candidate.languageId}`,
                'Content:',
                candidate.content
            ].join('\n'));
            return {
                result,
                resultSummary: `${candidate.content.length} characters read`,
                usedFiles: [candidate.filePath]
            };
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
            usedFiles: [...usedFiles]
        };
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
    postAgentToolActivity(id, title, detail, status, result) {
        this.postMessage({
            command: 'agentToolActivity',
            activity: { id, title, detail, status, result }
        });
    }
    async checkBackendHealth() {
        const result = await (0, client_1.health)(getBackendUrl());
        if (result.status === 'error') {
            this.postStatus(result.message ?? 'Backend unavailable.', 'warning');
        }
    }
    async answerQuestion(message, signal) {
        const question = message.question.trim();
        if (!question) {
            this.postStatus('Enter a question before asking.', 'warning');
            return;
        }
        const activeProfile = this.getActiveLlmProfile();
        if (!activeProfile) {
            this.postStatus('Add a model profile before asking.', 'warning');
            await this.showLlmProfileForm();
            return;
        }
        this.postStatus('Collecting context');
        const collectedScope = await this.collectScope(message.scope.kind, question);
        if (this.finishCancelledRequest(signal)) {
            return;
        }
        if (!collectedScope) {
            this.postStatus(message.scope.kind === 'selection' ? 'Select code first.' : 'Open a file first.', 'warning');
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
        const maxTokens = config.get('maxTokens', 4000);
        const temperature = config.get('temperature', 0.2);
        const requestTimeoutSeconds = Math.min(1830, Math.max(30, config.get('requestTimeoutSeconds', 330)));
        const providerApiKey = activeProfile.provider === 'openai'
            ? await this.extensionContext.secrets.get((0, llmProfiles_1.secretKeyForProfile)(activeProfile.id))
            : undefined;
        if (activeProfile.provider === 'openai' && !providerApiKey) {
            this.postStatus('The selected model profile is missing an API key.', 'warning');
            return;
        }
        const toolHistory = [];
        const toolUsedFiles = new Set();
        const toolSignatures = new Set();
        let finalData;
        while (!finalData) {
            if (this.finishCancelledRequest(signal)) {
                return;
            }
            const toolsEnabled = toolHistory.length < agentTools_1.MAX_AGENT_TOOL_CALLS;
            const request = {
                question,
                mode: message.mode,
                scope: collectedScope.apiScope,
                settings: {
                    provider: activeProfile.provider,
                    model: activeProfile.model,
                    baseUrl: activeProfile.baseUrl,
                    maxTokens,
                    temperature
                },
                toolsEnabled,
                toolHistory
            };
            this.postStatus(toolsEnabled && toolHistory.length > 0
                ? 'Continuing with project context'
                : 'Generating answer');
            const result = await (0, client_1.ask)(getBackendUrl(), request, providerApiKey, requestTimeoutSeconds * 1_000, signal);
            if (this.finishCancelledRequest(signal)) {
                return;
            }
            if (result.status === 'error' || !result.data) {
                this.postStatus(result.message ?? 'Ask request failed.', 'error');
                return;
            }
            const toolCalls = result.data.toolCalls ?? [];
            if (toolCalls.length === 0) {
                finalData = result.data;
                break;
            }
            if (!toolsEnabled) {
                this.postStatus('The model exceeded the project-tool limit.', 'error');
                return;
            }
            let executedCalls = 0;
            for (const toolCall of toolCalls) {
                if (toolHistory.length >= agentTools_1.MAX_AGENT_TOOL_CALLS) {
                    break;
                }
                if (toolHistory.some((step) => step.callId === toolCall.id)) {
                    this.postStatus('The model reused an invalid tool-call id.', 'error');
                    return;
                }
                const signature = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
                let execution;
                if (toolSignatures.has(signature)) {
                    const repeatedResult = 'This identical tool call was already completed. Use its earlier result.';
                    this.postAgentToolActivity(toolCall.id, 'Skipped repeated tool call', toolCall.name, 'error', repeatedResult);
                    execution = {
                        step: {
                            callId: toolCall.id,
                            name: toolCall.name,
                            arguments: toolCall.arguments,
                            result: repeatedResult,
                            isError: true
                        },
                        usedFiles: []
                    };
                }
                else {
                    toolSignatures.add(signature);
                    execution = await this.executeAgentToolCall(toolCall);
                }
                if (this.finishCancelledRequest(signal)) {
                    return;
                }
                toolHistory.push(execution.step);
                execution.usedFiles.forEach((file) => toolUsedFiles.add(file));
                executedCalls += 1;
            }
            if (executedCalls === 0) {
                this.postStatus('The model could not complete a valid project tool call.', 'error');
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
        this.postMessage({
            command: 'assistantResponse',
            response
        });
        this.postStatus('Ready');
    }
    async confirmAndApplyFileChanges(changes, summary, signal) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            throw new Error('Open a workspace folder before applying file changes.');
        }
        const plannedChanges = await Promise.all(changes.map(async (change) => {
            const uri = vscode.Uri.joinPath(folder.uri, ...change.path.split('/'));
            let exists = false;
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if ((stat.type & vscode.FileType.Directory) !== 0) {
                    throw new Error(`${change.path} is a directory, not a file.`);
                }
                exists = true;
            }
            catch (error) {
                if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
                    throw new Error(error instanceof Error
                        ? `Could not inspect ${change.path}: ${error.message}`
                        : `Could not inspect ${change.path}.`);
                }
            }
            return { ...change, uri, exists };
        }));
        const permissionFiles = plannedChanges.map((change) => ({
            path: change.path,
            operation: change.exists ? 'update' : 'create'
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

    .working-card {
      width: min(100%, 620px);
      max-width: min(100%, 620px);
      padding: 10px 11px;
    }

    .working-header {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 8px;
    }

    .working-indicator {
      width: 8px;
      height: 8px;
      flex: 0 0 auto;
      border-radius: 50%;
      background: var(--vscode-progressBar-background, var(--vscode-button-background));
      animation: tool-pulse 1.1s ease-in-out infinite;
    }

    .working-card[data-state="cancelled"] .working-indicator,
    .working-card[data-state="error"] .working-indicator {
      animation: none;
      background: var(--muted);
    }

    .working-heading {
      min-width: 0;
      color: var(--vscode-foreground);
      font-size: 12px;
      font-weight: 650;
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
      color: var(--vscode-foreground);
    }

    .working-phase[data-status="error"] {
      color: var(--vscode-editorError-foreground);
    }

    .working-phase-icon {
      text-align: center;
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

    .working-cancel {
      height: 24px;
      padding: 0 9px;
      border-radius: 4px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      font-size: 10px;
    }

    .working-cancel[hidden] {
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
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 10px;
    }

    .tool-activity-result:empty {
      display: none;
    }

    @keyframes tool-pulse {
      0%, 100% { opacity: 0.55; }
      50% { opacity: 1; }
    }

    @media (prefers-reduced-motion: reduce) {
      .working-indicator,
      .tool-activity[data-status="running"] .tool-activity-icon {
        animation: none;
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

    .model-selector {
      max-width: min(260px, 70vw);
      color: var(--vscode-foreground);
      background: var(--vscode-input-background);
    }

    .permission-selector {
      max-width: min(200px, 60vw);
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

    @media (max-width: 480px) {
      .profile-form-row {
        grid-template-columns: 1fr;
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
          <button
            id="llmProfileSelector"
            class="scope-button model-selector"
            type="button"
            title="Add or select a model profile"
          >
            <span id="llmProfileLabel" class="model-selector-label">Add model</span>
            <span class="model-selector-chevron" aria-hidden="true">▼</span>
          </button>
          <button
            id="permissionSettingsButton"
            class="scope-button model-selector permission-selector"
            type="button"
            title="Configure what DevMate can change without asking"
          >
            <span aria-hidden="true">◆</span>
            <span id="permissionPolicyLabel" class="model-selector-label">Ask for changes</span>
          </button>
          <span class="composer-actions-spacer"></span>
          <button id="ask" class="action-button primary" type="button" disabled>Ask</button>
        </div>
      </div>
    </section>
  </main>

  <dialog id="llmProfileDialog" class="profile-dialog" aria-labelledby="llmProfileFormTitle">
    <form id="llmProfileForm" class="profile-form" novalidate>
      <header class="profile-form-header">
        <h2 id="llmProfileFormTitle">Add model profile</h2>
        <p>Save a reusable model configuration for DevMate.</p>
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
        <h2 id="permissionDialogTitle">File permissions</h2>
        <p>Choose which safe workspace changes DevMate may apply without pausing.</p>
      </header>
      <div class="profile-form-body">
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
          <div class="permission-setting-row permission-blocked">
            <span class="permission-setting-copy">
              <strong>Delete files</strong>
              <span>DevMate does not currently accept delete operations.</span>
            </span>
            <span class="permission-blocked-badge">Blocked</span>
          </div>
          <div class="permission-setting-row permission-blocked">
            <span class="permission-setting-copy">
              <strong>Run terminal commands</strong>
              <span>DevMate does not currently execute model-proposed commands.</span>
            </span>
            <span class="permission-blocked-badge">Blocked</span>
          </div>
        </div>
        <p class="field-help">Instant permission never bypasses workspace boundaries, protected-file rules, or file-size limits.</p>
      </div>
      <footer class="profile-form-actions">
        <button id="cancelPermissionSettings" class="action-button secondary" type="button">Cancel</button>
        <button class="action-button primary" type="submit">Save permissions</button>
      </footer>
    </form>
  </dialog>

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
      attachmentsExpanded: false,
      activeProfile: undefined,
      profileCount: 0,
      permissionPolicy: {
        createFiles: 'ask',
        updateFiles: 'ask'
      },
      workingStartedAt: 0,
      workingTimer: undefined,
      askPending: false
    };

    const statusEl = document.getElementById('status');
    const messagesEl = document.getElementById('messages');
    const questionEl = document.getElementById('question');
    const scopeDetailEl = document.getElementById('scopeDetail');
    const attachmentPanelEl = document.getElementById('attachmentPanel');
    const attachmentListEl = document.getElementById('attachmentList');
    const attachmentToggleEl = document.getElementById('toggleAttachments');
    const llmProfileSelectorEl = document.getElementById('llmProfileSelector');
    const llmProfileLabelEl = document.getElementById('llmProfileLabel');
    const askEl = document.getElementById('ask');
    const llmProfileDialogEl = document.getElementById('llmProfileDialog');
    const llmProfileFormEl = document.getElementById('llmProfileForm');
    const llmProfileFormTitleEl = document.getElementById('llmProfileFormTitle');
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
    const permissionSettingsButtonEl = document.getElementById('permissionSettingsButton');
    const permissionPolicyLabelEl = document.getElementById('permissionPolicyLabel');
    const permissionDialogEl = document.getElementById('permissionDialog');
    const permissionFormEl = document.getElementById('permissionForm');
    const permissionCreateFilesEl = document.getElementById('permissionCreateFiles');
    const permissionUpdateFilesEl = document.getElementById('permissionUpdateFiles');
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
      state.askPending = true;
      startWorkingTurn();
      renderAskAvailability();
      vscode.postMessage({
        command: 'ask',
        mode: state.mode,
        question,
        scope: state.scope
      });
    });

    questionEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        askEl.click();
      }
    });

    document.getElementById('attachFiles').addEventListener('click', () => {
      vscode.postMessage({ command: 'pickFiles' });
    });

    llmProfileSelectorEl.addEventListener('click', () => {
      vscode.postMessage({ command: 'chooseLlmProfile' });
    });

    permissionSettingsButtonEl.addEventListener('click', () => {
      permissionCreateFilesEl.value = state.permissionPolicy.createFiles;
      permissionUpdateFilesEl.value = state.permissionPolicy.updateFiles;
      if (!permissionDialogEl.open) {
        permissionDialogEl.showModal();
      }
      permissionCreateFilesEl.focus();
    });

    document.getElementById('cancelPermissionSettings').addEventListener('click', () => {
      permissionDialogEl.close();
    });

    permissionFormEl.addEventListener('submit', (event) => {
      event.preventDefault();
      vscode.postMessage({
        command: 'savePermissionPolicy',
        policy: {
          createFiles: permissionCreateFilesEl.value,
          updateFiles: permissionUpdateFilesEl.value
        }
      });
      permissionDialogEl.close();
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
        const terminalStatus = message.level === 'error'
          || (message.level === 'warning'
            && !message.text.startsWith('The changes are allowed this time'));
        if (state.askPending && terminalStatus) {
          stopWorkingTurn('error', message.text);
          state.askPending = false;
          renderAskAvailability();
        }
      }

      if (message.command === 'scopeUpdated') {
        state.scope = message.scope;
        renderScope();
      }

      if (message.command === 'assistantResponse') {
        finishWorkingTurn(message.response);
        state.askPending = false;
        renderAskAvailability();
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
        renderPermissionPolicy(message.label);
      }

      if (message.command === 'permissionRequest') {
        updateWorkingTurn('Waiting for permission');
        appendPermissionRequest(message);
      }

      if (message.command === 'agentToolActivity') {
        if (message.activity.status === 'running') {
          updateWorkingTurn(message.activity.title);
        }
        renderAgentToolActivity(message.activity);
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

      const author = document.createElement('span');
      author.className = 'message-author';
      author.textContent = role === 'user' ? 'You' : 'DevMate';
      item.appendChild(author);

      const body = document.createElement('div');
      body.className = 'message-body';
      body.textContent = text;
      item.appendChild(body);
      messagesEl.appendChild(item);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function startWorkingTurn() {
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
      card.appendChild(footer);
      messagesEl.appendChild(card);

      updateWorkingElapsed();
      state.workingTimer = setInterval(updateWorkingElapsed, 1000);
      updateWorkingTurn('Preparing request');
      messagesEl.scrollTop = messagesEl.scrollHeight;
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

    function stopWorkingTurn(stateName, detail) {
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
      updateWorkingElapsed();
      card.removeAttribute('id');
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function finishWorkingTurn(response) {
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
        operation.textContent = file.operation === 'update' ? 'Update' : 'Create';
        item.appendChild(operation);

        const filePath = document.createElement('span');
        filePath.className = 'permission-path';
        filePath.textContent = file.path;
        filePath.title = file.path;
        item.appendChild(filePath);
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
      addDecisionButton('Always allow these', 'allowAlways');
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

    function renderPermissionPolicy(label) {
      permissionPolicyLabelEl.textContent = label || 'Ask for changes';
      permissionSettingsButtonEl.title = 'Create files: '
        + (state.permissionPolicy.createFiles === 'allow' ? 'allow instantly' : 'ask')
        + ' · Update files: '
        + (state.permissionPolicy.updateFiles === 'allow' ? 'allow instantly' : 'ask');
    }

    function renderAskAvailability() {
      askEl.disabled = !state.activeProfile || state.askPending;
      askEl.title = !state.activeProfile
        ? 'Add a model profile before asking'
        : state.askPending
          ? 'DevMate is working on your request'
          : '';
    }

    function showLlmProfileForm(profile, hasApiKey) {
      llmProfileFormEl.reset();
      llmProfileIdEl.value = profile?.id || '';
      llmProfileNameEl.value = profile?.name || '';
      llmProfileProviderEl.value = profile?.provider || 'openai';
      llmProfileModelEl.value = profile?.model || '';
      llmProfileBaseUrlEl.value = profile?.baseUrl || '';
      llmProfileApiKeyEl.value = '';
      llmProfileDialogEl.dataset.hasApiKey = String(Boolean(hasApiKey));
      llmProfileDialogEl.dataset.currentProvider = llmProfileProviderEl.value;
      llmProfileFormTitleEl.textContent = profile ? 'Edit model profile' : 'Add model profile';
      saveLlmProfileEl.textContent = profile ? 'Save changes' : 'Add model';
      setLlmProfileFormError('');
      setLlmProfileFormSaving(false);
      renderLlmProfileProvider(false);
      if (!llmProfileDialogEl.open) {
        llmProfileDialogEl.showModal();
      }
      llmProfileNameEl.focus();
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
        : 'Leave blank to use the OpenAI default.';
      llmProfileApiKeyHelpEl.textContent = llmProfileDialogEl.dataset.hasApiKey === 'true'
        ? 'A key is already stored. Leave this blank to keep it, or enter a replacement.'
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
        saveLlmProfileEl.textContent = llmProfileIdEl.value ? 'Save changes' : 'Add model';
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
    return {
        title: 'Searching code',
        detail: `"${call.arguments.query}"${call.arguments.path ? ` in ${call.arguments.path}` : ''}`
    };
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