import * as fs from 'fs';
import * as vscode from 'vscode';
import { health } from './api/client';
import { DEVMATE_KNOWLEDGE_STORE_FILE_NAME } from './api/types';
import { LocalBackendManager } from './backendManager';
import {
  CHAT_SESSION_MIGRATION_STORAGE_KEY,
  ChatSessionMigration,
  defaultChatSessionMigrationApi
} from './chatSessionMigration';
import {
  ChatSessionMirror,
  defaultChatSessionMirrorApi
} from './chatSessionMirror';
import { DevMateChatViewProvider, getBackendUrl } from './chatViewProvider';
import { EmbeddingIndexScheduler } from './embeddingIndexScheduler';
import {
  ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY,
  EMBEDDING_PROFILES_STORAGE_KEY,
  embeddingSecretKeyForProfile,
  readPreferredEmbeddingProfile
} from './embeddingProfiles';
import {
  KnowledgeIndexSynchronizer,
  defaultKnowledgeIndexApi
} from './indexSynchronization';
import { SqliteProjectRetriever } from './projectRetriever';
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
  let chatSessionMigration: ChatSessionMigration | undefined;
  let chatSessionMirror: ChatSessionMirror | undefined;
  let backendCapabilities: readonly string[] = [];
  const workspaceIndexSource = new VsCodeWorkspaceIndexSource();
  const knowledgeIndexSynchronizer = new KnowledgeIndexSynchronizer(
    workspaceIndexSource,
    defaultKnowledgeIndexApi,
    (message) => backendOutput.append(`[DevMate] Knowledge index: ${message}\n`)
  );
  const embeddingProfileReader = {
    readProfiles: () => context.globalState.get<unknown>(EMBEDDING_PROFILES_STORAGE_KEY),
    readActiveProfileId: () => context.globalState.get<unknown>(
      ACTIVE_EMBEDDING_PROFILE_STORAGE_KEY
    ),
    readSecret: (profileId: string) => context.secrets.get(
      embeddingSecretKeyForProfile(profileId)
    )
  };
  const embeddingIndexScheduler = new EmbeddingIndexScheduler(
    embeddingProfileReader,
    undefined,
    (message) => backendOutput.append(`[DevMate] Embedding index: ${message}\n`)
  );
  const workspaceIndexChangeSource = new VsCodeWorkspaceIndexChangeSource();
  const embeddingInvalidationSubscription = workspaceIndexChangeSource.onDidChange(() => {
    embeddingIndexScheduler.invalidateWorkspace();
  });
  const workspaceIndexCoordinator = new WorkspaceIndexCoordinator(
    workspaceIndexChangeSource,
    async (access, signal) => {
      embeddingIndexScheduler.invalidateWorkspace();
      const result = await knowledgeIndexSynchronizer.synchronize(access, signal);
      if (result.kind === 'completed'
        && result.indexState === 'ready'
        && !signal.aborted) {
        embeddingIndexScheduler.scheduleWorkspace(result.workspaceKey);
      }
      return result;
    }
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
    healthCheck: async (backendUrl, backendToken) => {
      const result = await health(backendUrl, backendToken);
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
          backendUrl: getBackendUrl(),
          backendToken
        };
        embeddingIndexScheduler.setBackendAccess({
          ...access,
          capabilities: backendCapabilities
        });
        workspaceIndexCoordinator.setBackendAccess(access);
        const migration = chatSessionMigration?.synchronize(access, backendCapabilities);
        if (migration) {
          void migration.then((result) => {
            if (result.kind === 'failed') {
              backendOutput.append(`[DevMate] Chat migration: ${result.message}\n`);
            }
            if (backendManager.status.state === 'online'
              && backendManager.requestToken === backendToken) {
              chatSessionMirror?.setBackendAccess({
                ...access,
                capabilities: backendCapabilities
              });
            }
          });
        } else {
          chatSessionMirror?.setBackendAccess({
            ...access,
            capabilities: backendCapabilities
          });
        }
      } else {
        embeddingIndexScheduler.setBackendAccess(undefined);
        workspaceIndexCoordinator.setBackendAccess(undefined);
        chatSessionMirror?.setBackendAccess(undefined);
      }
    },
    onOutput: (value) => backendOutput.append(value)
  });
  const projectRetriever = new SqliteProjectRetriever({
    getAccess: () => {
      const backendToken = backendManager.requestToken;
      return backendToken
        ? {
            backendUrl: getBackendUrl(),
            backendToken,
            capabilities: [...backendCapabilities]
          }
        : undefined;
    },
    getEmbeddingProfile: () => readPreferredEmbeddingProfile(embeddingProfileReader),
    readCurrentFile: (relativePath, signal) =>
      workspaceIndexSource.readCurrentFile(relativePath, signal)
  });
  chatViewProvider = new DevMateChatViewProvider(
    context,
    backendManager,
    backendOutput,
    projectRetriever,
    () => embeddingIndexScheduler.refreshActiveProfile(),
    (store, deletedSessionId) => chatSessionMirror?.mirror(store, deletedSessionId)
  );
  chatSessionMirror = new ChatSessionMirror(
    defaultChatSessionMirrorApi,
    (message) => backendOutput.append(`${message}\n`)
  );
  const chatSessionSource = chatViewProvider;
  chatSessionMigration = new ChatSessionMigration(
    { read: () => chatSessionSource.conversationSessionSnapshot() },
    {
      read: () => context.globalState.get<unknown>(CHAT_SESSION_MIGRATION_STORAGE_KEY),
      write: (marker) => context.globalState.update(
        CHAT_SESSION_MIGRATION_STORAGE_KEY,
        marker
      )
    },
    defaultChatSessionMigrationApi,
    (message) => backendOutput.append(`${message}\n`)
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
    embeddingIndexScheduler,
    embeddingInvalidationSubscription,
    workspaceIndexCoordinator,
    chatSessionMigration,
    chatSessionMirror,
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
