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
const fs = __importStar(require("fs"));
const vscode = __importStar(require("vscode"));
const client_1 = require("./api/client");
const types_1 = require("./api/types");
const backendManager_1 = require("./backendManager");
const chatViewProvider_1 = require("./chatViewProvider");
const embeddingIndexScheduler_1 = require("./embeddingIndexScheduler");
const embeddingProfiles_1 = require("./embeddingProfiles");
const indexSynchronization_1 = require("./indexSynchronization");
const projectRetriever_1 = require("./projectRetriever");
const workspaceIndexSource_1 = require("./workspaceIndexSource");
const workspaceIndexWatcher_1 = require("./workspaceIndexWatcher");
function activate(context) {
    const backendOutput = vscode.window.createOutputChannel('DevMate Backend');
    const knowledgeStorePath = vscode.Uri.joinPath(context.globalStorageUri, 'knowledge', types_1.DEVMATE_KNOWLEDGE_STORE_FILE_NAME).fsPath;
    let chatViewProvider;
    let backendCapabilities = [];
    const workspaceIndexSource = new workspaceIndexSource_1.VsCodeWorkspaceIndexSource();
    const knowledgeIndexSynchronizer = new indexSynchronization_1.KnowledgeIndexSynchronizer(workspaceIndexSource, indexSynchronization_1.defaultKnowledgeIndexApi, (message) => backendOutput.append(`[DevMate] Knowledge index: ${message}\n`));
    const embeddingIndexScheduler = new embeddingIndexScheduler_1.EmbeddingIndexScheduler({
        readProfiles: () => context.globalState.get(embeddingProfiles_1.EMBEDDING_PROFILES_STORAGE_KEY),
        readActiveProfileId: () => context.globalState.get(embeddingProfiles_1.ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY),
        readSecret: (profileId) => context.secrets.get((0, embeddingProfiles_1.embeddingSecretKeyForProfile)(profileId))
    }, undefined, (message) => backendOutput.append(`[DevMate] Embedding index: ${message}\n`));
    const workspaceIndexChangeSource = new workspaceIndexWatcher_1.VsCodeWorkspaceIndexChangeSource();
    const embeddingInvalidationSubscription = workspaceIndexChangeSource.onDidChange(() => {
        embeddingIndexScheduler.invalidateWorkspace();
    });
    const workspaceIndexCoordinator = new workspaceIndexWatcher_1.WorkspaceIndexCoordinator(workspaceIndexChangeSource, async (access, signal) => {
        embeddingIndexScheduler.invalidateWorkspace();
        const result = await knowledgeIndexSynchronizer.synchronize(access, signal);
        if (result.kind === 'completed'
            && result.indexState === 'ready'
            && !signal.aborted) {
            embeddingIndexScheduler.scheduleWorkspace(result.workspaceKey);
        }
        return result;
    });
    let backendManager;
    backendManager = new backendManager_1.LocalBackendManager({
        extensionPath: context.extensionUri.fsPath,
        knowledgeStorePath,
        getBackendUrl: chatViewProvider_1.getBackendUrl,
        isManagementEnabled: () => vscode.workspace.getConfiguration('devMate').get('manageLocalBackend', true),
        getConfiguredPythonPath: () => vscode.workspace.getConfiguration('devMate').get('backendPythonPath', ''),
        healthCheck: async (backendUrl, backendToken) => {
            const result = await (0, client_1.health)(backendUrl, backendToken);
            backendCapabilities = result.status === 'ok'
                ? result.data?.capabilities ?? []
                : [];
            return result.status === 'ok';
        },
        fileExists: (filePath) => fs.existsSync(filePath),
        onStatus: (status) => {
            chatViewProvider?.notifyBackendStatusChanged(status);
            const backendToken = backendManager.requestToken;
            if (status.state === 'online' && backendToken) {
                const access = {
                    backendUrl: (0, chatViewProvider_1.getBackendUrl)(),
                    backendToken
                };
                embeddingIndexScheduler.setBackendAccess({
                    ...access,
                    capabilities: backendCapabilities
                });
                workspaceIndexCoordinator.setBackendAccess(access);
            }
            else {
                embeddingIndexScheduler.setBackendAccess(undefined);
                workspaceIndexCoordinator.setBackendAccess(undefined);
            }
        },
        onOutput: (value) => backendOutput.append(value)
    });
    const projectRetriever = new projectRetriever_1.SqliteLexicalProjectRetriever({
        getAccess: () => {
            const backendToken = backendManager.requestToken;
            return backendToken
                ? { backendUrl: (0, chatViewProvider_1.getBackendUrl)(), backendToken }
                : undefined;
        },
        readCurrentFile: (relativePath, signal) => workspaceIndexSource.readCurrentFile(relativePath, signal)
    });
    chatViewProvider = new chatViewProvider_1.DevMateChatViewProvider(context, backendManager, backendOutput, projectRetriever, () => embeddingIndexScheduler.refreshActiveProfile());
    const viewRegistration = vscode.window.registerWebviewViewProvider(chatViewProvider_1.DevMateChatViewProvider.viewId, chatViewProvider, {
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
    const diffContentRegistration = vscode.workspace.registerTextDocumentContentProvider(chatViewProvider_1.DevMateChatViewProvider.diffScheme, chatViewProvider);
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
    context.subscriptions.push(chatViewProvider, embeddingIndexScheduler, embeddingInvalidationSubscription, workspaceIndexCoordinator, knowledgeIndexSynchronizer, backendManager, backendOutput, viewRegistration, diffContentRegistration, workspaceTrustRegistration, backendConfigurationRegistration, openChatCommand, statusBarItem);
    void backendManager.start();
}
function deactivate() {
    // VS Code disposes registered views and subscriptions.
}
//# sourceMappingURL=extension.js.map