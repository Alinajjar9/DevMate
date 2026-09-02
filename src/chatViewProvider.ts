import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentToolSettings } from './agentTools';
import { backendStatusLabel } from './backendManager';
import type { LocalBackendManager, ManagedBackendStatus } from './backendManager';
import { EmbeddingProfileController } from './embeddingProfileController';
import { getChatWebviewHtml } from './webview';
import {
  SqliteSessionRepository
} from './sessionRepository';
import type {
  ConversationSessionRepository
} from './sessionRepository';
import { SessionController } from './sessionController';
import { LlmProfileController } from './llmProfileController';
import { PermissionController } from './permissionController';
import { LexicalProjectRetriever } from './projectSearch/projectRetriever';
import type { ProjectRetriever } from './projectSearch/projectRetriever';
import {
  normalizeRelativeWorkspacePath,
  WorkspaceContext
} from './workspaceContext';
import type { CollectedScope, ScopeKind } from './workspaceContext';
import { WorkspaceMutations } from './workspaceMutations';
import { ToolExecutor } from './toolExecutor';
import { AgentRunController } from './agentRunController';
import type { AgentRunEvent } from './agentRunController';
import { ChatCompactionController } from './chatCompaction';
import { SettingsController } from './settingsController';
import { SettingsPresenter } from './settingsPresenter';
import { DIFF_DOCUMENT_SCHEME, DiffPresenter } from './diffPresenter';
import { AttachmentController } from './attachmentController';
import { ProfilePresenter } from './profilePresenter';
import { SessionPresenter } from './sessionPresenter';
import { AgentCheckpointController } from './agentCheckpointController';
import { PermissionPresenter } from './permissionPresenter';
import { ChatRequestController } from './chatRequestController';
import { parseWebviewMessage } from './webviewProtocol';
import type {
  ExtensionToWebviewMessage,
  WebviewMessage
} from './webviewProtocol';

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
  private readonly agentRunController: AgentRunController;
  private readonly chatRequestController: ChatRequestController;
  private readonly settingsController: SettingsController;
  private readonly settingsPresenter: SettingsPresenter;
  private readonly llmProfiles: LlmProfileController;
  private readonly profilePresenter: ProfilePresenter;
  private readonly permissionPresenter: PermissionPresenter;
  private readonly diffPresenter: DiffPresenter;
  private readonly attachmentController: AttachmentController;
  private activeRequest?: AbortController;
  private readonly sessionController: SessionController;
  private readonly sessionPresenter: SessionPresenter;
  private readonly agentCheckpoints: AgentCheckpointController;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly backendManager: LocalBackendManager,
    private readonly backendOutput: vscode.OutputChannel,
    projectRetriever: ProjectRetriever = new LexicalProjectRetriever(),
    onEmbeddingProfileChanged: () => void = () => undefined,
    sessionRepository: ConversationSessionRepository =
      new SqliteSessionRepository(),
    chatCompactionController: Pick<ChatCompactionController, 'compactIfNeeded'> =
      new ChatCompactionController()
  ) {
    this.extensionUri = extensionContext.extensionUri;
    this.diffPresenter = new DiffPresenter();
    this.settingsController = new SettingsController({
      readConfiguration: (key) =>
        vscode.workspace.getConfiguration('devMate').get<unknown>(key),
      writeConfiguration: (key, value) =>
        vscode.workspace.getConfiguration('devMate').update(
          key,
          value,
          vscode.ConfigurationTarget.Global
        ),
      writeWorkspaceState: (key, value) =>
        this.extensionContext.workspaceState.update(key, value)
    });
    const permissionController = new PermissionController({
      readState: (key) => this.extensionContext.workspaceState.get<unknown>(key),
      writeState: (key, value) =>
        this.extensionContext.workspaceState.update(key, value)
    });
    this.permissionPresenter = new PermissionPresenter(
      permissionController,
      this.diffPresenter,
      {
        postMessage: (message) => this.postMessage(message),
        postStatus: (text, level) => this.postStatus(text, level),
        settingsChanged: () => this.settingsPresenter.postState()
      }
    );
    this.settingsPresenter = new SettingsPresenter(
      this.settingsController,
      {
        rememberedCommands: () => this.permissionPresenter.rememberedCommands(),
        workspaceTrusted: () => vscode.workspace.isTrusted,
        permissionPolicyChanged: () => this.permissionPresenter.postPolicyState(),
        postMessage: (message) => this.postMessage(message),
        postStatus: (text, level) => this.postStatus(text, level)
      }
    );
    this.workspaceContext = new WorkspaceContext(
      extensionContext.storageUri,
      (text) => this.postStatus(text),
      projectRetriever
    );
    this.attachmentController = new AttachmentController({
      isProjectCandidate: async (uri) =>
        Boolean(await this.workspaceContext.readProjectCandidate(uri)),
      reportStatus: (text, level) => this.postStatus(text, level),
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
        getAgentToolSettings: () => this.getAgentToolSettings(),
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
    this.sessionController = new SessionController(
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
      {
        readState: (key) => this.extensionContext.workspaceState.get<unknown>(key),
        writeState: (key, value) =>
          this.extensionContext.workspaceState.update(key, value)
      },
      {
        workspaceId: () => this.getConversationWorkspace()?.id,
        activeSessionId: () => this.sessionController.activeSession()?.id,
        toolCallLimit: () => this.settingsController.state().toolCallLimit,
        stateChanged: (state) => {
          this.postMessage({ command: 'agentCheckpointUpdated', ...state });
        },
        reportWarning: (message) => this.postStatus(message, 'warning')
      }
    );
    this.sessionPresenter = new SessionPresenter(
      this.sessionController,
      this.workspaceContext,
      {
        isRequestActive: () => Boolean(this.activeRequest),
        postMessage: (message) => this.postMessage(message),
        postStatus: (text, level) => this.postStatus(text, level),
        postCheckpointState: () => this.agentCheckpoints.postState(),
        clearCheckpointForSession: (sessionId) =>
          this.agentCheckpoints.clearForSession(sessionId)
      }
    );
    this.agentRunController = new AgentRunController(this.toolExecutor, {
      saveCheckpoint: (checkpoint) => this.agentCheckpoints.save(checkpoint),
      recoverBackend: () => this.backendManager.start(),
      emit: (event) => this.handleAgentRunEvent(event)
    });
    this.llmProfiles = new LlmProfileController({
      readState: (key) => this.extensionContext.globalState.get<unknown>(key),
      writeState: (key, value) => this.extensionContext.globalState.update(key, value),
      readSecret: (key) => this.extensionContext.secrets.get(key),
      writeSecret: (key, value) => this.extensionContext.secrets.store(key, value),
      deleteSecret: (key) => this.extensionContext.secrets.delete(key)
    });
    const embeddingProfiles = new EmbeddingProfileController({
      readState: (key) => this.extensionContext.globalState.get<unknown>(key),
      writeState: (key, value) => this.extensionContext.globalState.update(key, value),
      readSecret: (key) => this.extensionContext.secrets.get(key),
      writeSecret: (key, value) => this.extensionContext.secrets.store(key, value),
      deleteSecret: (key) => this.extensionContext.secrets.delete(key)
    }, onEmbeddingProfileChanged);
    this.profilePresenter = new ProfilePresenter(
      this.llmProfiles,
      embeddingProfiles,
      {
        isRequestActive: () => Boolean(this.activeRequest),
        postMessage: (message) => this.postMessage(message),
        postStatus: (text, level) => this.postStatus(text, level)
      }
    );
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
        active: () => this.llmProfiles.activeProfile(),
        reasoningPreferences: () => this.llmProfiles.reasoningPreferences(),
        apiKey: (profileId) => this.llmProfiles.apiKey(profileId),
        showForm: (profileId) => this.profilePresenter.showLlmProfileForm(profileId)
      },
      settings: this.settingsController,
      sessions: this.sessionController,
      compaction: chatCompactionController,
      agentRuns: this.agentRunController,
      checkpoints: this.agentCheckpoints,
      changes: {
        beginRequest: () => this.diffPresenter.beginRequest(),
        apply: (changes, summary, signal) =>
          this.workspaceMutations.confirmAndApplyFileChanges(changes, summary, signal),
        completedDiffId: (filePath) => this.diffPresenter.completedDiffId(filePath)
      },
      events: {
        postMessage: (message) => this.postMessage(message),
        postStatus: (text, level) => this.postStatus(text, level),
        postFailure: (message, options) => this.postRequestFailure(message, options),
        finishCancellation: (signal) => this.finishCancelledRequest(signal),
        sessionStateChanged: () => this.sessionPresenter.postState(false)
      },
      now: () => Date.now()
    });
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
          await this.chatRequestController.answer(message, requestController.signal);
        } catch (error) {
          if (!this.finishCancelledRequest(requestController.signal)) {
            this.postRequestFailure(
              error instanceof Error ? error.message : 'DevMate could not complete the request.'
            );
          }
        } finally {
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
        const checkpoint = this.agentCheckpoints.current();
        if (!checkpoint) {
          this.postRequestFailure('There is no unfinished DevMate run for this session.', {
            level: 'warning'
          });
          this.agentCheckpoints.postState();
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
          await this.chatRequestController.answer({
            command: 'ask',
            mode: checkpoint.mode,
            question: checkpoint.question,
            scope: {
              kind: checkpoint.scopeKind,
              label: scopeLabel,
              detail: ''
            }
          }, requestController.signal, checkpoint);
        } catch (error) {
          if (!this.finishCancelledRequest(requestController.signal)) {
            this.postRequestFailure(
              error instanceof Error ? error.message : 'DevMate could not continue the request.'
            );
          }
        } finally {
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
        await this.attachmentController.pickWorkspaceFiles();
        return;
      case 'removeAttachment':
        this.attachmentController.remove(message.id);
        return;
      case 'chooseLlmProfile':
        this.profilePresenter.chooseLlmProfile();
        return;
      case 'selectLlmProfile':
        await this.profilePresenter.selectLlmProfile(message.profileId);
        return;
      case 'setReasoningEffort':
        await this.profilePresenter.setActiveReasoningEffort(message.effort);
        return;
      case 'addLlmProfile':
        await this.profilePresenter.showLlmProfileForm();
        return;
      case 'editLlmProfile':
        await this.profilePresenter.showLlmProfileForm(message.profileId);
        return;
      case 'deleteLlmProfile':
        await this.profilePresenter.deleteLlmProfile(message.profileId);
        return;
      case 'saveLlmProfile':
        await this.profilePresenter.saveLlmProfile(message.profile);
        return;
      case 'chooseEmbeddingProfile':
        this.profilePresenter.chooseEmbeddingProfile();
        return;
      case 'selectEmbeddingProfile':
        await this.profilePresenter.selectEmbeddingProfile(message.profileId);
        return;
      case 'addEmbeddingProfile':
        await this.profilePresenter.showEmbeddingProfileForm();
        return;
      case 'editEmbeddingProfile':
        await this.profilePresenter.showEmbeddingProfileForm(message.profileId);
        return;
      case 'deleteEmbeddingProfile':
        await this.profilePresenter.deleteEmbeddingProfile(message.profileId);
        return;
      case 'saveEmbeddingProfile':
        await this.profilePresenter.saveEmbeddingProfile(message.profile);
        return;
      case 'saveSettings':
        await this.settingsPresenter.save(message.settings);
        return;
      case 'saveAgentToolSettings':
        await this.settingsPresenter.saveAgentToolSettings(message.settings);
        return;
      case 'reviewPermissionDiff':
        await this.permissionPresenter.reviewFileDiff(message.requestId, message.path);
        return;
      case 'revokeRememberedCommand':
        await this.permissionPresenter.revokeRememberedCommand(message.signature);
        return;
      case 'clearRememberedCommands':
        await this.permissionPresenter.clearRememberedCommands();
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
        await this.sessionPresenter.createSession();
        return;
      case 'selectSession':
        await this.sessionPresenter.selectSession(message.sessionId);
        return;
      case 'renameSession':
        await this.sessionPresenter.renameSession(message.sessionId);
        return;
      case 'deleteSession':
        await this.sessionPresenter.deleteSession(message.sessionId);
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
        await this.permissionPresenter.decideCommandPermission(
          message.requestId,
          message.decision
        );
        return;
      case 'openCommandTerminal':
        this.toolExecutor.showCommandTerminal(message.activityId);
        return;
      case 'permissionDecision':
        await this.permissionPresenter.decideFilePermission(
          message.requestId,
          message.decision
        );
        return;
      case 'ready':
        this.attachmentController.postState();
        await this.profilePresenter.postLlmProfileState();
        await this.profilePresenter.promptForBuiltInNemotronKey();
        this.profilePresenter.postEmbeddingProfileState();
        this.permissionPresenter.postPolicyState();
        this.settingsPresenter.postState();
        this.postBackendStatus();
        this.sessionPresenter.postState(false);
        return;
      default:
        this.postStatus('Unsupported command received.', 'error');
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
        normalizeRelativeWorkspacePath(relativePath),
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

  private getAgentToolSettings(): AgentToolSettings {
    return this.settingsController.agentToolSettings();
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
