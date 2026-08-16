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
exports.activate = activate;
exports.deactivate = deactivate;
const fs = __importStar(require("fs"));
const vscode = __importStar(require("vscode"));
const client_1 = require("./api/client");
const backendManager_1 = require("./backendManager");
const chatViewProvider_1 = require("./chatViewProvider");
var chatViewProvider_2 = require("./chatViewProvider");
Object.defineProperty(exports, "DevMateChatViewProvider", { enumerable: true, get: function () { return chatViewProvider_2.DevMateChatViewProvider; } });
function activate(context) {
    const backendOutput = vscode.window.createOutputChannel('DevMate Backend');
    let chatViewProvider;
    const backendManager = new backendManager_1.LocalBackendManager({
        extensionPath: context.extensionUri.fsPath,
        getBackendUrl: chatViewProvider_1.getBackendUrl,
        isManagementEnabled: () => vscode.workspace.getConfiguration('devMate').get('manageLocalBackend', true),
        getConfiguredPythonPath: () => vscode.workspace.getConfiguration('devMate').get('backendPythonPath', ''),
        healthCheck: async (backendUrl) => (await (0, client_1.health)(backendUrl)).status === 'ok',
        fileExists: (filePath) => fs.existsSync(filePath),
        onStatus: (status) => chatViewProvider?.notifyBackendStatusChanged(status),
        onOutput: (value) => backendOutput.append(value)
    });
    chatViewProvider = new chatViewProvider_1.DevMateChatViewProvider(context, backendManager, backendOutput);
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
    context.subscriptions.push(chatViewProvider, backendManager, backendOutput, viewRegistration, diffContentRegistration, workspaceTrustRegistration, backendConfigurationRegistration, openChatCommand, statusBarItem);
    void backendManager.start();
}
function deactivate() {
    // VS Code disposes registered views and subscriptions.
}
//# sourceMappingURL=extension.js.map