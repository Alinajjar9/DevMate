// Connect the chat view to its controllers and presenters.
// This is the UI wiring layer; request and tool logic live elsewhere.

import * as path from 'path';
import * as vscode from 'vscode';
import { backendStatusLabel } from '../api/backendManager';
import type { LocalBackendManager, ManagedBackendStatus } from '../api/backendManager';
import { EmbeddingProfileController } from '../settings/embeddingProfileController';
import { getChatWebviewHtml } from './webview';
import {
  BackendSessionRepository
} from '../sessions/sessionRepository';
import type {
  ConversationSessionRepository
} from '../sessions/sessionRepository';
import type { AgentRunCheckpoint } from '../sessions/sessions';
import { SessionController } from '../sessions/sessionController';
import { LlmProfileController } from '../settings/llmProfileController';
import { PermissionController } from '../workspace/permissionController';
import { LexicalProjectRetriever } from '../projectSearch/projectRetriever';
import type { ProjectRetriever } from '../projectSearch/projectRetriever';
import {
  toForwardSlashes,
  WorkspaceContext
} from '../context/workspaceContext';
import type { CollectedScope, ScopeKind } from '../context/workspaceContext';
import { WorkspaceMutations } from '../workspace/workspaceMutations';
import { ToolExecutor } from '../agent/toolExecutor';
import { AgentRunController } from '../agent/agentRunController';
import type { AgentRunEvent } from '../agent/agentRunController';
import { ChatCompactionController } from '../sessions/chatCompaction';
import { SettingsController } from '../settings/settingsController';
import { SettingsPresenter } from '../settings/settingsPresenter';
import { DIFF_DOCUMENT_SCHEME, DiffPresenter } from '../workspace/diffPresenter';
import { AttachmentController } from '../context/attachmentController';
import { ProfilePresenter } from '../settings/profilePresenter';
import { SessionPresenter } from '../sessions/sessionPresenter';
import { AgentCheckpointController } from '../agent/agentCheckpointController';
import { PermissionPresenter } from '../workspace/permissionPresenter';
import { ChatRequestController } from './chatRequestController';
import { parseWebviewMessage } from './webviewProtocol';
import type {
  AskWebviewMessage,
  ExtensionToWebviewMessage,
  WebviewMessage
} from './webviewProtocol';

// Connect the chat features here; keep their workflows in their controllers and presenters.
export class DevMateChatViewProvider implements
  vscode.WebviewViewProvider,
  vscode.TextDocumentContentProvider,
  vscode.Disposable {
  static readonly viewId = 'devmate.dedicatedAssistantView';
  static readonly containerId = 'devmate-dedicated-chat';
  static readonly diffScheme = DIFF_DOCUMENT_SCHEME;

  private view?: vscode.WebviewView;
  private readonly viewDisposables: vscode.Disposable[] = [];
  private readonly lifetimeDisposables: vscode.Disposable[] = [];
  private readonly extensionUri: vscode.Uri;
  private readonly workspaceContext: WorkspaceContext;
  private readonly workspaceMutations: WorkspaceMutations;
  private readonly toolExecutor: ToolExecutor;
  private readonly chatRequestController: ChatRequestController;
  private readonly settingsPresenter: SettingsPresenter;
  private readonly profilePresenter: ProfilePresenter;
  private readonly permissionPresenter: PermissionPresenter;
  private readonly diffPresenter: DiffPresenter;
  private readonly attachmentController: AttachmentController;
  private activeRequest?: AbortController;
  private readonly sessionPresenter: SessionPresenter;
  private readonly agentCheckpoints: AgentCheckpointController;

  constructor(
    extensionContext: vscode.ExtensionContext,
    private readonly backendManager: LocalBackendManager,
    private readonly backendOutput: vscode.OutputChannel,
    projectRetriever: ProjectRetriever = new LexicalProjectRetriever(),
    onEmbeddingProfileChanged: () => void = () => undefined,
    sessionRepository: ConversationSessionRepository =
      new BackendSessionRepository(),
    chatCompactionController: Pick<ChatCompactionController, 'compactIfNeeded'> =
      new ChatCompactionController()
  ) {
    this.extensionUri = extensionContext.extensionUri;

    // Share the VS Code adapters, not the state owned by each feature.
    const viewMessages = {
      postMessage: (message: ExtensionToWebviewMessage) => this.postMessage(message),
      postStatus: (text: string, level?: 'info' | 'warning' | 'error') =>
        this.postStatus(text, level)
    };
    const workspaceState = {
      readState: (key: string) => extensionContext.workspaceState.get<unknown>(key),
      writeState: (key: string, value: unknown) =>
        extensionContext.workspaceState.update(key, value)
    };
    const profileStorage = {
      readState: (key: string) => extensionContext.globalState.get<unknown>(key),
      writeState: (key: string, value: unknown) => extensionContext.globalState.update(key, value),
      readSecret: (key: string) => extensionContext.secrets.get(key),
      writeSecret: (key: string, value: string) => extensionContext.secrets.store(key, value),
      deleteSecret: (key: string) => extensionContext.secrets.delete(key)
    };

    // Settings and permissions share updates, but each keeps its own rules.
    this.diffPresenter = new DiffPresenter();
    const settingsController = new SettingsController({
      readConfiguration: (key) =>
        vscode.workspace.getConfiguration('devMate').get<unknown>(key),
      writeConfiguration: (key, value) =>
        vscode.workspace.getConfiguration('devMate').update(
          key,
          value,
          vscode.ConfigurationTarget.Global
        ),
      writeWorkspaceState: workspaceState.writeState
    });
    const permissionController = new PermissionController(workspaceState);
    this.permissionPresenter = new PermissionPresenter(
      permissionController,
      this.diffPresenter,
      {
        ...viewMessages,
        settingsChanged: () => this.settingsPresenter.postState()
      }
    );
    this.settingsPresenter = new SettingsPresenter(
      settingsController,
      {
        ...viewMessages,
        rememberedCommands: () => this.permissionPresenter.rememberedCommands(),
        workspaceTrusted: () => vscode.workspace.isTrusted,
        permissionPolicyChanged: () => this.permissionPresenter.postPolicyState()
      }
    );

    // Workspace tools use the same context, permission prompts, and diff snapshots.
    this.workspaceContext = new WorkspaceContext(
      extensionContext.storageUri,
      (text) => this.postStatus(text),
      projectRetriever
    );
    this.attachmentController = new AttachmentController({
      isProjectCandidate: async (uri) =>
        Boolean(await this.workspaceContext.readProjectCandidate(uri)),
      reportStatus: viewMessages.postStatus,
      attachmentsChanged: (attachments) => {
        this.postMessage({ command: 'attachmentsUpdated', attachments });
      }
    });
    this.workspaceMutations = new WorkspaceMutations({
      getPermissionPolicy: () => this.permissionPresenter.policy(),
      requestPermission: (summary, files) =>
        this.permissionPresenter.requestFileChanges(summary, files),
      reportStatus: (text) => this.postStatus(text),
      recordCompletedDiff: (filePath, originalContent, proposedContent, previousPath) => {
        this.diffPresenter.rememberCompletedFileDiff(
          filePath,
          originalContent,
          proposedContent,
          previousPath
        );
      }
    });
    this.toolExecutor = new ToolExecutor(
      this.workspaceContext,
      this.workspaceMutations,
      {
        getAgentToolSettings: () => settingsController.agentToolSettings(),
        requestCommandPermission: (signature, label, cwd, options) =>
          this.permissionPresenter.requestCommand(signature, label, cwd, options),
        postAgentToolActivity: (id, title, detail, status, result, canOpenTerminal) =>
          this.postAgentToolActivity(
            id,
            title,
            detail,
            status,
            result,
            canOpenTerminal
          )
      }
    );

    // Sessions store the conversation; checkpoints store only an unfinished run.
    const sessionController = new SessionController(
      sessionRepository,
      (issue) => {
        this.backendOutput.append(`[DevMate] Chat storage: ${issue.message}\n`);
        if (issue.notifyUser) {
          this.postStatus(
            'This chat is available for now, but local storage could not save it.',
            'warning'
          );
        }
      }
    );
    this.agentCheckpoints = new AgentCheckpointController(
      workspaceState,
      {
        workspaceId: () => this.getConversationWorkspace()?.id,
        activeSessionId: () => sessionController.activeSession()?.id,
        toolCallLimit: () => settingsController.state().toolCallLimit,
        stateChanged: (state) => {
          this.postMessage({ command: 'agentCheckpointUpdated', ...state });
        },
        reportWarning: (message) => this.postStatus(message, 'warning')
      }
    );
    this.sessionPresenter = new SessionPresenter(
      sessionController,
      this.workspaceContext,
      {
        ...viewMessages,
        isRequestActive: () => Boolean(this.activeRequest),
        postCheckpointState: () => this.agentCheckpoints.postState(),
        clearCheckpointForSession: (sessionId) =>
          this.agentCheckpoints.clearForSession(sessionId)
      }
    );

    // Chat and embedding profiles share storage access, but keep separate storage keys.
    const llmProfiles = new LlmProfileController(profileStorage);
    const embeddingProfiles = new EmbeddingProfileController(
      profileStorage,
      onEmbeddingProfileChanged
    );
    this.profilePresenter = new ProfilePresenter(
      llmProfiles,
      embeddingProfiles,
      {
        ...viewMessages,
        isRequestActive: () => Boolean(this.activeRequest)
      }
    );

    // The request controller coordinates these features; the view only forwards its events.
    const agentRunController = new AgentRunController(this.toolExecutor, {
      saveCheckpoint: (checkpoint) => this.agentCheckpoints.save(checkpoint),
      recoverBackend: () => this.backendManager.start(),
      emit: (event) => this.handleAgentRunEvent(event)
    });
    this.chatRequestController = new ChatRequestController({
      backend: {
        start: () => this.backendManager.start(),
        detail: () => this.backendManager.status.detail,
        token: () => this.backendManager.requestToken,
        url: () => getBackendUrl(),
        appendLog: (message) => this.backendOutput.append(message)
      },
      context: {
        workspace: () => this.getConversationWorkspace(),
        collect: (scope, question, signal) =>
          this.collectScope(scope, question, signal)
      },
      profiles: {
        active: () => llmProfiles.activeProfile(),
        reasoningPreferences: () => llmProfiles.reasoningPreferences(),
        apiKey: (profileId) => llmProfiles.apiKey(profileId),
        showForm: (profileId) => this.profilePresenter.showLlmProfileForm(profileId)
      },
      settings: settingsController,
      sessions: sessionController,
      compaction: chatCompactionController,
      agentRuns: agentRunController,
      checkpoints: this.agentCheckpoints,
      changes: {
        beginRequest: () => this.diffPresenter.beginRequest(),
        apply: (changes, summary, signal) =>
          this.workspaceMutations.confirmAndApplyFileChanges(changes, summary, signal),
        completedDiffId: (filePath) => this.diffPresenter.completedDiffId(filePath)
      },
      events: {
        ...viewMessages,
        postFailure: (message, options) => this.postRequestFailure(message, options),
        finishCancellation: (signal) => this.finishCancelledRequest(signal),
        sessionStateChanged: () => this.sessionPresenter.postState(false)
      },
      now: () => Date.now()
    });

    // Terminal listeners live as long as the provider, even when the view is closed.
    this.lifetimeDisposables.push(
      vscode.window.onDidStartTerminalShellExecution((event) => {
        this.toolExecutor.captureWorkspaceTerminalExecution(event);
      }),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        void this.toolExecutor.finishWorkspaceTerminalExecution(event);
      })
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.disposeViewDisposables();
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };
    webviewView.webview.html = getChatWebviewHtml(webviewView.webview, this.extensionUri);

    this.viewDisposables.push(
      webviewView.webview.onDidReceiveMessage((value: unknown) => {
        const message = parseWebviewMessage(value);
        if (!message) {
          this.postStatus('Unsupported or invalid command received.', 'error');
          return;
        }
        void this.handleMessage(message);
      }),
      webviewView.onDidDispose(() => {
        this.view = undefined;
        this.disposeViewDisposables();
      })
    );

    this.postBackendStatus();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.diffPresenter.provideTextDocumentContent(uri);
  }

  notifyWorkspaceTrustChanged(): void {
    this.settingsPresenter.postState();
  }

  notifyBackendStatusChanged(_status: ManagedBackendStatus): void {
    this.postBackendStatus();
  }

  synchronizeConversationSessions(): Promise<void> {
    return this.sessionPresenter.synchronize();
  }

  async show(): Promise<void> {
    await vscode.commands.executeCommand(
      `workbench.view.extension.${DevMateChatViewProvider.containerId}`
    );
    await vscode.commands.executeCommand(`${DevMateChatViewProvider.viewId}.focus`);
    const resolvedView = this.view as vscode.WebviewView | undefined;
    if (!resolvedView) {
      throw new Error(
        'DevMate could not resolve its chat view. Run “Developer: Reload Window” and try again.'
      );
    }
    resolvedView.show(false);
  }

  dispose(): void {
    this.view = undefined;
    this.disposeViewDisposables();
    this.toolExecutor.clearActiveTerminalCaptures();
    this.diffPresenter.dispose();
    while (this.lifetimeDisposables.length > 0) {
      this.lifetimeDisposables.pop()?.dispose();
    }
  }

  private disposeViewDisposables(): void {
    this.activeRequest?.abort();
    this.activeRequest = undefined;
    this.permissionPresenter.cancelPending();
    this.disposeCommandTerminals();
    while (this.viewDisposables.length > 0) {
      this.viewDisposables.pop()?.dispose();
    }
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    // Keep every command visible here so its owner is easy to find.
    switch (message.command) {
      // Requests and their context.
      case 'setScope':
        return this.updateScope(message.scope);
      case 'ask':
        return this.runRequest(message);
      case 'continueAgentRun':
        return this.resumeRequest();
      case 'cancelRequest':
        return this.cancelActiveRequest();
      case 'pickFiles':
        return this.attachmentController.pickWorkspaceFiles();
      case 'removeAttachment':
        return this.attachmentController.remove(message.id);

      // Chat-model and embedding profiles.
      case 'chooseLlmProfile':
        return this.profilePresenter.chooseLlmProfile();
      case 'selectLlmProfile':
        return this.profilePresenter.selectLlmProfile(message.profileId);
      case 'setReasoningEffort':
        return this.profilePresenter.setActiveReasoningEffort(message.effort);
      case 'addLlmProfile':
        return this.profilePresenter.showLlmProfileForm();
      case 'editLlmProfile':
        return this.profilePresenter.showLlmProfileForm(message.profileId);
      case 'deleteLlmProfile':
        return this.profilePresenter.deleteLlmProfile(message.profileId);
      case 'saveLlmProfile':
        return this.profilePresenter.saveLlmProfile(message.profile);
      case 'chooseEmbeddingProfile':
        return this.profilePresenter.chooseEmbeddingProfile();
      case 'selectEmbeddingProfile':
        return this.profilePresenter.selectEmbeddingProfile(message.profileId);
      case 'addEmbeddingProfile':
        return this.profilePresenter.showEmbeddingProfileForm();
      case 'editEmbeddingProfile':
        return this.profilePresenter.showEmbeddingProfileForm(message.profileId);
      case 'deleteEmbeddingProfile':
        return this.profilePresenter.deleteEmbeddingProfile(message.profileId);
      case 'saveEmbeddingProfile':
        return this.profilePresenter.saveEmbeddingProfile(message.profile);

      // Settings and permission decisions.
      case 'saveSettings':
        return this.settingsPresenter.save(message.settings);
      case 'saveAgentToolSettings':
        return this.settingsPresenter.saveAgentToolSettings(message.settings);
      case 'reviewPermissionDiff':
        return this.permissionPresenter.reviewFileDiff(message.requestId, message.path);
      case 'revokeRememberedCommand':
        return this.permissionPresenter.revokeRememberedCommand(message.signature);
      case 'clearRememberedCommands':
        return this.permissionPresenter.clearRememberedCommands();
      case 'commandPermissionDecision':
        return this.permissionPresenter.decideCommandPermission(message.requestId, message.decision);
      case 'permissionDecision':
        return this.permissionPresenter.decideFilePermission(message.requestId, message.decision);

      // Backend controls and saved chats.
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
        return this.sessionPresenter.createSession();
      case 'selectSession':
        return this.sessionPresenter.selectSession(message.sessionId);
      case 'renameSession':
        return this.sessionPresenter.renameSession(message.sessionId);
      case 'deleteSession':
        return this.sessionPresenter.deleteSession(message.sessionId);

      // Native editor actions and initial view state.
      case 'copyText':
        if (typeof message.text === 'string' && message.text.length <= 500_000) {
          await vscode.env.clipboard.writeText(message.text);
        }
        return;
      case 'openWorkspaceFile':
        return this.openWorkspaceFile(message.path, message.line);
      case 'openFileChangeDiff':
        return this.openCompletedFileDiff(message.diffId, message.path);
      case 'openExternalLink':
        return this.openExternalLink(message.url);
      case 'openCommandTerminal':
        return this.toolExecutor.showCommandTerminal(message.activityId);
      case 'ready':
        return this.postInitialViewState();
      default:
        this.postStatus('Unsupported command received.', 'error');
    }
  }

  private async postInitialViewState(): Promise<void> {
    this.attachmentController.postState();
    await this.profilePresenter.postLlmProfileState();
    await this.profilePresenter.promptForBuiltInNemotronKey();
    this.profilePresenter.postEmbeddingProfileState();
    this.permissionPresenter.postPolicyState();
    this.settingsPresenter.postState();
    this.postBackendStatus();
    this.sessionPresenter.postState(false);
  }

  private async resumeRequest(): Promise<void> {
    // Check before reading the checkpoint: the current run may still be updating it.
    if (this.activeRequest) {
      this.postStatus('DevMate is already working on a request.', 'warning');
      return;
    }
    const checkpoint = this.agentCheckpoints.current();
    if (!checkpoint) {
      this.postRequestFailure('There is no unfinished DevMate run for this session.', {
        level: 'warning'
      });
      this.agentCheckpoints.postState();
      return;
    }
    const scopeLabels = { project: 'Project', activeFile: 'File', selection: 'Selection' };
    await this.runRequest({
      command: 'ask',
      mode: checkpoint.mode,
      question: checkpoint.question,
      scope: {
        kind: checkpoint.scopeKind,
        label: scopeLabels[checkpoint.scopeKind],
        detail: ''
      }
    }, checkpoint);
  }

  private async runRequest(
    message: AskWebviewMessage,
    checkpoint?: AgentRunCheckpoint
  ): Promise<void> {
    if (this.activeRequest) {
      this.postStatus('DevMate is already working on a request.', 'warning');
      return;
    }
    // New and resumed requests share the same cancellation and cleanup rules.
    const abortController = new AbortController();
    this.disposeCommandTerminals();
    this.activeRequest = abortController;
    try {
      await this.chatRequestController.answer(message, abortController.signal, checkpoint);
    } catch (error) {
      if (!this.finishCancelledRequest(abortController.signal)) {
        const fallbackMessage = checkpoint
          ? 'DevMate could not continue the request.'
          : 'DevMate could not complete the request.';
        this.postRequestFailure(error instanceof Error ? error.message : fallbackMessage);
      }
    } finally {
      // An older request must not clear a newer one after the view has reopened.
      if (this.activeRequest === abortController) {
        this.activeRequest = undefined;
      }
    }
  }

  private async updateScope(scope: ScopeKind): Promise<void> {
    this.postStatus('Collecting context');

    const collectedScope = await this.collectScope(scope);
    if (!collectedScope) {
      this.postStatus(scope === 'selection' ? 'Select code first.' : 'Open a file first.', 'warning');
      return;
    }

    this.postMessage({ command: 'scopeUpdated', scope: collectedScope.info });
    this.postStatus('Ready');
  }

  private async openWorkspaceFile(requestedPath: string, requestedLine?: number): Promise<void> {
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
    if (
      !relativePath
      || relativePath === '..'
      || relativePath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativePath)
    ) {
      return;
    }
    try {
      await this.assertNoWorkspaceSymlink(
        folder,
        toForwardSlashes(relativePath),
        false
      );
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
      const line = Number.isInteger(requestedLine)
        ? Math.max(0, Math.min(document.lineCount - 1, Number(requestedLine) - 1))
        : 0;
      await vscode.window.showTextDocument(document, {
        preview: true,
        selection: new vscode.Range(line, 0, line, 0)
      });
    } catch {
      this.postStatus(`Could not open ${value}.`, 'warning');
    }
  }

  private async openCompletedFileDiff(diffId: string, requestedPath: string): Promise<void> {
    if (!await this.diffPresenter.openCompletedFileDiff(diffId)) {
      this.postStatus('That change snapshot is no longer available. Opening the current file instead.', 'warning');
      await this.openWorkspaceFile(requestedPath);
    }
  }

  private async openExternalLink(value: string): Promise<void> {
    try {
      const uri = vscode.Uri.parse(value, true);
      if (uri.scheme === 'http' || uri.scheme === 'https') {
        await vscode.env.openExternal(uri);
      }
    } catch {
      // Invalid and non-HTTP links are ignored.
    }
  }

  private getConversationWorkspace() {
    return this.workspaceContext.getConversationWorkspace();
  }

  private collectScope(
    scope: ScopeKind,
    question?: string,
    signal?: AbortSignal
  ): Promise<CollectedScope | undefined> {
    return this.workspaceContext.collectScope(
      scope,
      question,
      this.attachmentController.uris(),
      signal
    );
  }

  private cancelActiveRequest(): void {
    if (!this.activeRequest || this.activeRequest.signal.aborted) {
      return;
    }
    this.activeRequest.abort();
    this.permissionPresenter.cancelPending();
    this.disposeCommandTerminals();
    this.postMessage({ command: 'requestCancelling' });
  }

  private finishCancelledRequest(signal: AbortSignal): boolean {
    if (!signal.aborted) {
      return false;
    }
    this.postMessage({ command: 'requestCancelled' });
    this.postStatus('Ready');
    return true;
  }

  private postRequestFailure(
    message: string,
    options: { level?: 'warning' | 'error'; retryable?: boolean } = {}
  ): void {
    this.postMessage({
      command: 'requestFailed',
      message,
      retryable: options.retryable === true
    });
    this.postStatus(message, options.level ?? 'error');
  }

  private postBackendStatus(): void {
    const status = this.backendManager.status;
    this.postMessage({
      command: 'backendStatusUpdated',
      status,
      label: backendStatusLabel(status)
    });
  }

  private disposeCommandTerminals(): void {
    this.toolExecutor.disposeCommandTerminals();
  }

  private async assertNoWorkspaceSymlink(
    folder: vscode.WorkspaceFolder,
    relativePath: string,
    allowMissing: boolean
  ): Promise<void> {
    return this.workspaceMutations.assertNoWorkspaceSymlink(folder, relativePath, allowMissing);
  }

  private postAgentToolActivity(
    id: string,
    title: string,
    detail: string,
    status: 'running' | 'completed' | 'error',
    result?: string,
    canOpenTerminal = false
  ): void {
    this.postMessage({
      command: 'agentToolActivity',
      activity: { id, title, detail, status, result, canOpenTerminal }
    });
  }

  private handleAgentRunEvent(event: AgentRunEvent): void {
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
        this.postAgentToolActivity(
          event.id,
          event.title,
          event.detail,
          event.status,
          event.result,
          event.canOpenTerminal
        );
    }
  }

  private postStatus(text: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    this.postMessage({ command: 'status', text, level });
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    this.view?.webview.postMessage(message);
  }

}

export function getBackendUrl(): string {
  return vscode.workspace
    .getConfiguration('devMate')
    .get<string>('backendUrl', 'http://127.0.0.1:8000')
    .trim();
}
