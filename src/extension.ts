import * as fs from 'fs';
import * as vscode from 'vscode';
import { health } from './api/client';
import { DEVMATE_KNOWLEDGE_STORE_FILE_NAME } from './api/types';
import { LocalBackendManager } from './backendManager';
import { DevMateChatViewProvider, getBackendUrl } from './chatViewProvider';
import {
  KnowledgeIndexSynchronizer,
  defaultKnowledgeIndexApi
} from './indexSynchronization';
import { SqliteLexicalProjectRetriever } from './projectRetriever';
import { VsCodeWorkspaceIndexSource } from './workspaceIndexSource';
import {
  VsCodeWorkspaceIndexChangeSource,
  WorkspaceIndexCoordinator
} from './workspaceIndexWatcher';

export function activate(context: vscode.ExtensionContext): void {
  const backendOutput = vscode.window.createOutputChannel('DevMate Backend');
  const knowledgeStorePath = vscode.Uri.joinPath(
    context.globalStorageUri,
    'knowledge',
    DEVMATE_KNOWLEDGE_STORE_FILE_NAME
  ).fsPath;
  let chatViewProvider: DevMateChatViewProvider | undefined;
  const workspaceIndexSource = new VsCodeWorkspaceIndexSource();
  const knowledgeIndexSynchronizer = new KnowledgeIndexSynchronizer(
    workspaceIndexSource,
    defaultKnowledgeIndexApi,
    (message) => backendOutput.append(`[DevMate] Knowledge index: ${message}\n`)
  );
  const workspaceIndexCoordinator = new WorkspaceIndexCoordinator(
    new VsCodeWorkspaceIndexChangeSource(),
    (access, signal) => knowledgeIndexSynchronizer.synchronize(access, signal)
  );
  let backendManager: LocalBackendManager;
  backendManager = new LocalBackendManager({
    extensionPath: context.extensionUri.fsPath,
    knowledgeStorePath,
    getBackendUrl,
    isManagementEnabled: () => vscode.workspace.getConfiguration('devMate').get<boolean>(
      'manageLocalBackend',
      true
    ),
    getConfiguredPythonPath: () => vscode.workspace.getConfiguration('devMate').get<string>(
      'backendPythonPath',
      ''
    ),
    healthCheck: async (backendUrl, backendToken) => (
      await health(backendUrl, backendToken)
    ).status === 'ok',
    fileExists: (filePath) => fs.existsSync(filePath),
    onStatus: (status) => {
      chatViewProvider?.notifyBackendStatusChanged(status);
      const backendToken = backendManager.requestToken;
      if (status.state === 'online' && backendToken) {
        workspaceIndexCoordinator.setBackendAccess({
          backendUrl: getBackendUrl(),
          backendToken
        });
      } else {
        workspaceIndexCoordinator.setBackendAccess(undefined);
      }
    },
    onOutput: (value) => backendOutput.append(value)
  });
  const projectRetriever = new SqliteLexicalProjectRetriever({
    getAccess: () => {
      const backendToken = backendManager.requestToken;
      return backendToken
        ? { backendUrl: getBackendUrl(), backendToken }
        : undefined;
    },
    readCurrentFile: (relativePath, signal) =>
      workspaceIndexSource.readCurrentFile(relativePath, signal)
  });
  chatViewProvider = new DevMateChatViewProvider(
    context,
    backendManager,
    backendOutput,
    projectRetriever
  );
  const viewRegistration = vscode.window.registerWebviewViewProvider(
    DevMateChatViewProvider.viewId,
    chatViewProvider,
    {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }
  );
  const openChatCommand = vscode.commands.registerCommand('devMate.openChat', async () => {
    try {
      await chatViewProvider.show();
    } catch (error) {
      void vscode.window.showErrorMessage(
        error instanceof Error ? error.message : 'DevMate could not open its chat view.'
      );
    }
  });
  const diffContentRegistration = vscode.workspace.registerTextDocumentContentProvider(
    DevMateChatViewProvider.diffScheme,
    chatViewProvider
  );
  const workspaceTrustRegistration = vscode.workspace.onDidGrantWorkspaceTrust(() => {
    chatViewProvider?.notifyWorkspaceTrustChanged();
  });
  const backendConfigurationRegistration = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration('devMate.backendUrl')
      || event.affectsConfiguration('devMate.manageLocalBackend')
      || event.affectsConfiguration('devMate.backendPythonPath')
    ) {
      void backendManager.reconfigure();
    }
  });
  const statusBarItem = vscode.window.createStatusBarItem(
    'devMate.statusBar',
    vscode.StatusBarAlignment.Right,
    1000
  );
  statusBarItem.text = '$(comment-discussion) DevMate';
  statusBarItem.tooltip = 'Open DevMate';
  statusBarItem.command = 'devMate.openChat';
  statusBarItem.show();

  context.subscriptions.push(
    chatViewProvider,
    workspaceIndexCoordinator,
    knowledgeIndexSynchronizer,
    backendManager,
    backendOutput,
    viewRegistration,
    diffContentRegistration,
    workspaceTrustRegistration,
    backendConfigurationRegistration,
    openChatCommand,
    statusBarItem
  );
  void backendManager.start();
}

export function deactivate(): void {
  // VS Code disposes registered views and subscriptions.
}
