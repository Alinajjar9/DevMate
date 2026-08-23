import { randomUUID } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  DEFAULT_AGENT_TOOL_CALL_LIMIT,
  MAX_AGENT_TOOL_CALL_LIMIT,
  MIN_AGENT_TOOL_CALL_LIMIT,
  boundedAgentToolCallLimit
} from './agentTools';
import {
  DEFAULT_CODE_NAVIGATION_MAX_RESULTS,
  DEFAULT_DIAGNOSTICS_MAX_RESULTS,
  DEFAULT_LIST_FILES_MAX_RESULTS,
  DEFAULT_READ_FILE_MAX_LINES,
  DEFAULT_SEARCH_CODE_MAX_RESULTS,
  DEFAULT_TERMINAL_ERRORS_MAX_RESULTS,
  normalizeAgentToolSettings
} from './agentTools';
import type { AgentToolSettings } from './agentTools';
import {
  AGENT_CHECKPOINT_STORAGE_KEY,
  parseAgentRunCheckpoint
} from './sessions';
import type { AgentRunCheckpoint } from './sessions';
import { backendStatusLabel } from './backendManager';
import type { LocalBackendManager, ManagedBackendStatus } from './backendManager';
import {
  EmbeddingProfileController,
  embeddingProviderLabel
} from './embeddingProfileController';
import type {
  EmbeddingProfileFormSubmission
} from './embeddingProfileController';
import { getChatWebviewHtml } from './webview';
import type { AssistantMode } from './api/types';
import {
  collectFileChangeSummary,
  parseAppliedFileChangeOutcome
} from './fileTools';
import {
  activeConversationSession,
  activeSessionModelHistory,
  addConversationSession,
  appendConversationSessionTurn,
  appendConversationSessionUserMessage,
  createEmptyConversationSessionStore,
  deleteConversationSession,
  renameConversationSession,
  sessionBelongsToWorkspace,
  selectConversationSession
} from './sessions';
import type { ConversationSessionStore } from './sessions';
import {
  SqliteSessionRepository
} from './sessionRepository';
import type {
  ConversationSessionRepository
} from './sessionRepository';
import {
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  MAX_COMMAND_TIMEOUT_SECONDS,
  MIN_COMMAND_TIMEOUT_SECONDS
} from './commandTools';
import type { ValidatedFileChange } from './fileTools';
import { validateFileChanges } from './fileTools';
import {
  ACTIVE_LLM_PROFILE_STORAGE_KEY,
  BUILT_IN_NEMOTRON_PROFILE,
  BUILT_IN_NEMOTRON_PROFILE_ID,
  isBuiltInLlmProfile,
  isEquivalentNemotronProfile,
  LLM_REASONING_EFFORT_STORAGE_KEY,
  LLM_PROFILES_STORAGE_KEY,
  normalizeProfileDraft,
  parseReasoningEffortPreferences,
  parseStoredProfiles,
  profilesWithBuiltInNemotron,
  providerLabelForProfile,
  REASONING_EFFORT_LABELS,
  reasoningEffortForProfile,
  reasoningEffortOptionsForProfile,
  secretKeyForProfile,
  validateProfileDraft
} from './llmProfiles';
import type {
  LlmProfile,
  LlmProfileDraft,
  LlmProvider,
  ReasoningEffort
} from './llmProfiles';
import {
  allowActions,
  FILE_PERMISSION_POLICY_STORAGE_KEY,
  parseFilePermissionPolicy,
  parseRememberedCommands,
  REMEMBERED_COMMANDS_STORAGE_KEY,
  rememberCommand,
  revokeRememberedCommand
} from './permissions';
import type {
  FilePermissionAction,
  FilePermissionPolicy,
  RememberedCommand
} from './permissions';
import {
  MAX_ATTACHMENT_CANDIDATES,
  MAX_ATTACHED_FILES,
  PROJECT_EXCLUDE_GLOB,
  shouldSkipProjectFile
} from './projectIndex';
import { LexicalProjectRetriever } from './projectRetriever';
import type { ProjectRetriever } from './projectRetriever';
import {
  normalizeRelativeWorkspacePath,
  WorkspaceContext
} from './workspaceContext';
import type { CollectedScope, ScopeInfo, ScopeKind } from './workspaceContext';
import { WorkspaceMutations } from './workspaceMutations';
import type { WorkspaceMutationPermissionFile } from './workspaceMutations';
import { ToolExecutor } from './toolExecutor';
import { AgentRunController } from './agentRunController';
import type { AgentRunEvent } from './agentRunController';
import {
  AUTO_MAX_INPUT_CONTEXT_TOKENS,
  isValidMaxInputContextTokens,
  isValidModelContextWindowTokens,
  normalizeMaxInputContextTokens
} from './contextPlanner';

type AttachmentInfo = {
  id: string;
  label: string;
};

type WorkspaceFilePickItem = vscode.QuickPickItem & {
  id: string;
  uri: vscode.Uri;
};

type LlmProfileFormSubmission = {
  id?: string;
  name: string;
  provider: LlmProvider;
  model: string;
  baseUrl?: string;
  contextWindowTokens?: number;
  apiKey?: string;
};

type DevMateSettingsSubmission = {
  timeoutSeconds: number;
  commandTimeoutSeconds: number;
  toolCallLimit: number;
  maxTokens: number;
  maxInputContextTokens: number;
  temperature: number;
  policy: FilePermissionPolicy;
};

type AgentToolSettingsSubmission = AgentToolSettings;

type PendingCommandPermission = {
  id: string;
  signature: string;
  label: string;
  rememberable: boolean;
  resolve: (allowed: boolean) => void;
};

type PendingPermissionRequest = {
  id: string;
  actions: Set<FilePermissionAction>;
  rememberable: boolean;
  diffs: Map<string, PendingFileDiff>;
  resolve: (allowed: boolean) => void;
};

type PendingFileDiff = {
  path: string;
  originalContent: string;
  proposedContent: string;
  originalUri: vscode.Uri;
  proposedUri: vscode.Uri;
};

type CompletedFileDiff = {
  id: string;
  path: string;
  previousPath?: string;
  originalUri: vscode.Uri;
  proposedUri: vscode.Uri;
};

type WebviewMessage =
  | {
    command: 'ask';
    mode: AssistantMode;
    question: string;
    scope: ScopeInfo;
    isNewTurn?: boolean;
  }
  | { command: 'continueAgentRun' }
  | { command: 'cancelRequest' }
  | { command: 'setScope'; scope: ScopeKind }
  | { command: 'pickFiles' }
  | { command: 'removeAttachment'; id: string }
  | { command: 'chooseLlmProfile' }
  | { command: 'selectLlmProfile'; profileId: string }
  | { command: 'setReasoningEffort'; effort: ReasoningEffort }
  | { command: 'addLlmProfile' }
  | { command: 'editLlmProfile'; profileId: string }
  | { command: 'deleteLlmProfile'; profileId: string }
  | { command: 'saveLlmProfile'; profile: LlmProfileFormSubmission }
  | { command: 'chooseEmbeddingProfile' }
  | { command: 'selectEmbeddingProfile'; profileId: string }
  | { command: 'addEmbeddingProfile' }
  | { command: 'editEmbeddingProfile'; profileId: string }
  | { command: 'deleteEmbeddingProfile'; profileId: string }
  | { command: 'saveEmbeddingProfile'; profile: EmbeddingProfileFormSubmission }
  | { command: 'saveSettings'; settings: DevMateSettingsSubmission }
  | { command: 'saveAgentToolSettings'; settings: AgentToolSettingsSubmission }
  | { command: 'reviewPermissionDiff'; requestId: string; path: string }
  | { command: 'revokeRememberedCommand'; signature: string }
  | { command: 'clearRememberedCommands' }
  | { command: 'restartBackend' }
  | { command: 'openBackendLogs' }
  | { command: 'newSession' }
  | { command: 'selectSession'; sessionId: string }
  | { command: 'renameSession'; sessionId: string }
  | { command: 'deleteSession'; sessionId: string }
  | { command: 'copyText'; text: string }
  | { command: 'openWorkspaceFile'; path: string; line?: number }
  | { command: 'openFileChangeDiff'; diffId: string; path: string }
  | { command: 'openExternalLink'; url: string }
  | {
      command: 'commandPermissionDecision';
      requestId: string;
      decision: 'deny' | 'allowOnce' | 'allowAlways';
    }
  | { command: 'openCommandTerminal'; activityId: string }
  | {
      command: 'permissionDecision';
      requestId: string;
      decision: 'deny' | 'allowOnce' | 'allowAlways';
    }
  | { command: 'ready' };

export class DevMateChatViewProvider implements
  vscode.WebviewViewProvider,
  vscode.TextDocumentContentProvider,
  vscode.Disposable {
  static readonly viewId = 'devmate.dedicatedAssistantView';
  static readonly containerId = 'devmate-dedicated-chat';
  static readonly diffScheme = 'devmate-diff';

  private view?: vscode.WebviewView;
  private readonly attachedFiles = new Map<string, vscode.Uri>();
  private readonly viewDisposables: vscode.Disposable[] = [];
  private readonly lifetimeDisposables: vscode.Disposable[] = [];
  private readonly extensionUri: vscode.Uri;
  private readonly workspaceContext: WorkspaceContext;
  private readonly workspaceMutations: WorkspaceMutations;
  private readonly toolExecutor: ToolExecutor;
  private readonly agentRunController: AgentRunController;
  private readonly embeddingProfiles: EmbeddingProfileController;
  private pendingPermission?: PendingPermissionRequest;
  private pendingCommandPermission?: PendingCommandPermission;
  private activeRequest?: AbortController;
  private readonly diffDocuments = new Map<string, string>();
  private readonly completedFileDiffs = new Map<string, CompletedFileDiff>();
  private readonly activeRequestDiffs = new Map<string, string>();
  private sessionStore: ConversationSessionStore;
  private sessionsLoaded = false;
  private sessionRevision = 0;
  private readonly dirtySessionIds = new Set<string>();
  private readonly deletedSessionIds = new Set<string>();
  private sessionSynchronization?: Promise<void>;
  private sessionWriteQueue: Promise<void> = Promise.resolve();
  private agentCheckpoint?: AgentRunCheckpoint;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly backendManager: LocalBackendManager,
    private readonly backendOutput: vscode.OutputChannel,
    projectRetriever: ProjectRetriever = new LexicalProjectRetriever(),
    onEmbeddingProfileChanged: () => void = () => undefined,
    private readonly sessionRepository: ConversationSessionRepository =
      new SqliteSessionRepository()
  ) {
    this.extensionUri = extensionContext.extensionUri;
    this.workspaceContext = new WorkspaceContext(
      extensionContext.storageUri,
      (text) => this.postStatus(text),
      projectRetriever
    );
    this.workspaceMutations = new WorkspaceMutations({
      getPermissionPolicy: () => this.getPermissionPolicy(),
      requestPermission: (summary, files) => this.requestFileChangePermission(summary, files),
      reportStatus: (text) => this.postStatus(text),
      recordCompletedDiff: (filePath, originalContent, proposedContent, previousPath) => {
        this.rememberCompletedFileDiff(
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
          this.requestCommandPermission(signature, label, cwd, options),
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
    this.agentCheckpoint = parseAgentRunCheckpoint(
      extensionContext.workspaceState.get<unknown>(AGENT_CHECKPOINT_STORAGE_KEY)
    );
    this.sessionStore = createEmptyConversationSessionStore();
    this.agentRunController = new AgentRunController(this.toolExecutor, {
      saveCheckpoint: (checkpoint) => this.saveAgentCheckpoint(checkpoint),
      recoverBackend: () => this.backendManager.start(),
      emit: (event) => this.handleAgentRunEvent(event)
    });
    this.embeddingProfiles = new EmbeddingProfileController({
      readState: (key) => this.extensionContext.globalState.get<unknown>(key),
      writeState: (key, value) => this.extensionContext.globalState.update(key, value),
      readSecret: (key) => this.extensionContext.secrets.get(key),
      writeSecret: (key, value) => this.extensionContext.secrets.store(key, value),
      deleteSecret: (key) => this.extensionContext.secrets.delete(key)
    }, onEmbeddingProfileChanged);
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
      webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
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
    return this.diffDocuments.get(uri.toString()) ?? '';
  }

  notifyWorkspaceTrustChanged(): void {
    this.postSettingsState();
  }

  notifyBackendStatusChanged(_status: ManagedBackendStatus): void {
    this.postBackendStatus();
  }

  synchronizeConversationSessions(): Promise<void> {
    if (this.sessionSynchronization) {
      return this.sessionSynchronization;
    }
    const operation = this.runSessionSynchronization()
      .catch((error) => {
        this.backendOutput.append(
          '[DevMate] Chat storage: '
          + `${error instanceof Error ? error.message : 'session synchronization failed.'}\n`
        );
      })
      .finally(() => {
        if (this.sessionSynchronization === operation) {
          this.sessionSynchronization = undefined;
        }
      });
    this.sessionSynchronization = operation;
    return operation;
  }

  private async runSessionSynchronization(): Promise<void> {
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
    this.diffDocuments.clear();
    this.completedFileDiffs.clear();
    this.activeRequestDiffs.clear();
    while (this.lifetimeDisposables.length > 0) {
      this.lifetimeDisposables.pop()?.dispose();
    }
  }

  private disposeViewDisposables(): void {
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
          await this.answerQuestion(message, requestController.signal);
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
        await this.extensionContext.workspaceState.update(
          REMEMBERED_COMMANDS_STORAGE_KEY,
          []
        );
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
        await this.handlePermissionDecision(
          message.requestId,
          message.decision
        );
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

  private async createSession(): Promise<void> {
    if (!this.canChangeSession()) {
      return;
    }
    const workspace = this.getConversationWorkspace();
    if (!workspace) {
      this.postSessionWarning('Open a project folder before starting a DevMate session.');
      return;
    }
    const previousSessionIds = new Set(this.sessionStore.sessions.map((session) => session.id));
    this.sessionStore = addConversationSession(
      this.sessionStore,
      randomUUID(),
      Date.now(),
      workspace
    );
    this.sessionRevision += 1;
    await this.persistSession(this.sessionStore.activeSessionId);
    for (const sessionId of previousSessionIds) {
      if (!this.sessionStore.sessions.some((session) => session.id === sessionId)) {
        await this.deletePersistedSession(sessionId);
      }
    }
    this.postSessionState(true, true);
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
    const diff = typeof diffId === 'string' ? this.completedFileDiffs.get(diffId) : undefined;
    if (!diff) {
      this.postStatus('That change snapshot is no longer available. Opening the current file instead.', 'warning');
      await this.openWorkspaceFile(requestedPath);
      return;
    }
    const title = diff.previousPath
      ? `${diff.previousPath} → ${diff.path} (DevMate changes)`
      : `${diff.path} (DevMate changes)`;
    await vscode.commands.executeCommand(
      'vscode.diff',
      diff.originalUri,
      diff.proposedUri,
      title,
      { preview: true }
    );
  }

  private rememberCompletedFileDiff(
    filePath: string,
    originalContent: string,
    proposedContent: string,
    previousPath?: string
  ): string {
    const id = randomUUID();
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const originalUri = vscode.Uri.parse(
      `${DevMateChatViewProvider.diffScheme}:/completed/${id}/before/${encodedPath}`
    );
    const proposedUri = vscode.Uri.parse(
      `${DevMateChatViewProvider.diffScheme}:/completed/${id}/after/${encodedPath}`
    );
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
      const oldestId = this.completedFileDiffs.keys().next().value as string | undefined;
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

  private fileChangePathKey(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
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

  private async selectSession(sessionId: string): Promise<void> {
    if (!this.canChangeSession()) {
      return;
    }
    const session = this.sessionStore.sessions.find((item) => item.id === sessionId);
    if (!session) {
      return;
    }
    const workspace = this.getConversationWorkspace();
    if (!sessionBelongsToWorkspace(session, workspace)) {
      this.postSessionWarning(
        `This session belongs to “${session.workspaceName}”. Open that project to continue it.`
      );
      return;
    }
    const nextStore = selectConversationSession(this.sessionStore, sessionId);
    this.sessionStore = nextStore;
    this.postSessionState(true, true);
  }

  private async renameSession(sessionId: string): Promise<void> {
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
    this.sessionStore = renameConversationSession(this.sessionStore, sessionId, title);
    this.sessionRevision += 1;
    await this.persistSession(sessionId);
    this.postSessionState(false);
  }

  private async deleteSession(sessionId: string): Promise<void> {
    if (!this.canChangeSession()) {
      return;
    }
    const session = this.sessionStore.sessions.find((item) => item.id === sessionId);
    if (!session) {
      return;
    }
    const decision = await vscode.window.showWarningMessage(
      `Delete “${session.title}”? This permanently removes its saved messages from “${session.workspaceName}”.`,
      { modal: true },
      'Delete'
    );
    if (decision !== 'Delete' || this.activeRequest) {
      return;
    }
    this.sessionStore = deleteConversationSession(this.sessionStore, sessionId);
    this.sessionRevision += 1;
    await this.deletePersistedSession(sessionId);
    if (this.agentCheckpoint?.sessionId === sessionId) {
      await this.clearAgentCheckpoint();
    }
    this.postSessionState(false);
  }

  private canChangeSession(): boolean {
    if (!this.activeRequest) {
      return true;
    }
    this.postStatus('Wait for the active request to finish before changing sessions.', 'warning');
    return false;
  }

  private async persistSession(sessionId: string): Promise<boolean> {
    const session = this.sessionStore.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      return false;
    }
    const signature = JSON.stringify(session);
    this.dirtySessionIds.add(sessionId);
    this.deletedSessionIds.delete(sessionId);
    const result = await this.enqueueSessionWrite(
      () => this.sessionRepository.saveSessions([session])
    );
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

  private async deletePersistedSession(sessionId: string): Promise<boolean> {
    this.dirtySessionIds.delete(sessionId);
    this.deletedSessionIds.add(sessionId);
    const result = await this.enqueueSessionWrite(
      () => this.sessionRepository.deleteSession(sessionId)
    );
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

  private async flushPendingSessionChanges(): Promise<void> {
    const sessions = [...this.dirtySessionIds]
      .map((id) => this.sessionStore.sessions.find((session) => session.id === id))
      .filter((session) => session !== undefined);
    if (sessions.length > 0) {
      const signatures = new Map(sessions.map((session) => [session.id, JSON.stringify(session)]));
      const result = await this.enqueueSessionWrite(
        () => this.sessionRepository.saveSessions(sessions)
      );
      if (result.kind === 'completed') {
        for (const [sessionId, signature] of signatures) {
          const current = this.sessionStore.sessions.find((session) => session.id === sessionId);
          if (current && JSON.stringify(current) === signature) {
            this.dirtySessionIds.delete(sessionId);
          }
        }
      } else if (result.kind !== 'cancelled') {
        this.backendOutput.append(`[DevMate] Chat storage: ${result.message}\n`);
      }
    }

    for (const sessionId of [...this.deletedSessionIds]) {
      const result = await this.enqueueSessionWrite(
        () => this.sessionRepository.deleteSession(sessionId)
      );
      if (result.kind === 'completed') {
        if (!this.sessionStore.sessions.some((session) => session.id === sessionId)) {
          this.deletedSessionIds.delete(sessionId);
        }
      } else if (result.kind !== 'cancelled') {
        this.backendOutput.append(`[DevMate] Chat storage: ${result.message}\n`);
        break;
      }
    }
  }

  private reportSessionStorageIssue(message: string): void {
    this.backendOutput.append(`[DevMate] Chat storage: ${message}\n`);
    this.postStatus(
      'This chat is available for now, but local storage could not save it.',
      'warning'
    );
  }

  private enqueueSessionWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sessionWriteQueue.then(operation, operation);
    this.sessionWriteQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private postSessionState(includeMessages: boolean, openChat = false): void {
    const activeSession = activeConversationSession(this.sessionStore);
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
        belongsToCurrentWorkspace: sessionBelongsToWorkspace(session, workspace),
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

  private currentAgentCheckpoint(): AgentRunCheckpoint | undefined {
    const workspace = this.getConversationWorkspace();
    const activeSession = activeConversationSession(this.sessionStore);
    if (!workspace
      || !activeSession
      || this.agentCheckpoint?.workspaceId !== workspace.id
      || this.agentCheckpoint.sessionId !== activeSession.id) {
      return undefined;
    }
    return this.agentCheckpoint;
  }

  private postAgentCheckpointState(): void {
    const checkpoint = this.currentAgentCheckpoint();
    const limit = boundedAgentToolCallLimit(
      vscode.workspace.getConfiguration('devMate').get<number>(
        'toolCallLimit',
        DEFAULT_AGENT_TOOL_CALL_LIMIT
      )
    );
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

  private async saveAgentCheckpoint(checkpoint: AgentRunCheckpoint): Promise<void> {
    this.agentCheckpoint = checkpoint;
    try {
      await this.extensionContext.workspaceState.update(
        AGENT_CHECKPOINT_STORAGE_KEY,
        checkpoint
      );
    } catch {
      this.postStatus('DevMate could not persist the unfinished agent checkpoint.', 'warning');
    }
    this.postAgentCheckpointState();
  }

  private async clearAgentCheckpoint(): Promise<void> {
    this.agentCheckpoint = undefined;
    try {
      await this.extensionContext.workspaceState.update(
        AGENT_CHECKPOINT_STORAGE_KEY,
        undefined
      );
    } catch {
      this.postStatus('DevMate could not remove the completed agent checkpoint.', 'warning');
    }
    this.postAgentCheckpointState();
  }

  private postSessionWarning(message: string): void {
    this.postMessage({ command: 'sessionProjectWarning', message });
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
      this.attachedFiles.values(),
      signal
    );
  }

  private async pickWorkspaceFiles(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.postStatus('Open a folder before attaching files.', 'warning');
      return;
    }

    this.postStatus('Finding workspace files');
    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*'),
        PROJECT_EXCLUDE_GLOB,
        MAX_ATTACHMENT_CANDIDATES
      );
    } catch {
      this.postStatus('Could not list files from the open folder.', 'error');
      return;
    }

    const choices = uris
      .map((uri): WorkspaceFilePickItem => {
        const id = vscode.workspace.asRelativePath(uri, false);
        return {
          id,
          uri,
          label: id,
          picked: this.attachedFiles.has(id)
        };
      })
      .filter((item) => !shouldSkipProjectFile(item.id))
      .sort((left, right) => left.label.localeCompare(right.label));

    if (choices.length === 0) {
      this.postStatus('No attachable text files were found in the open folder.', 'warning');
      return;
    }

    const selected = await vscode.window.showQuickPick<WorkspaceFilePickItem>(choices, {
      canPickMany: true,
      matchOnDescription: true,
      placeHolder: `Select up to ${MAX_ATTACHED_FILES} files from ${folder.name}`,
      title: 'DevMate: Attach workspace files'
    });
    if (!selected) {
      this.postStatus('Ready');
      return;
    }

    if (selected.length > MAX_ATTACHED_FILES) {
      this.postStatus(`Attach at most ${MAX_ATTACHED_FILES} files.`, 'warning');
      return;
    }

    const validated = await Promise.all(
      selected.map(async (item) => ({
        item,
        candidate: await this.readProjectCandidate(item.uri)
      }))
    );
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

  private postAttachmentState(): void {
    const attachments: AttachmentInfo[] = [...this.attachedFiles.keys()].map((id) => ({
      id,
      label: id
    }));
    this.postMessage({ command: 'attachmentsUpdated', attachments });
  }

  private getStoredLlmProfiles(): LlmProfile[] {
    return parseStoredProfiles(
      this.extensionContext.globalState.get<unknown>(LLM_PROFILES_STORAGE_KEY)
    );
  }

  private getLlmProfiles(): LlmProfile[] {
    return profilesWithBuiltInNemotron(this.getStoredLlmProfiles());
  }

  private getActiveLlmProfile(profiles = this.getLlmProfiles()): LlmProfile | undefined {
    const activeProfileId = this.extensionContext.globalState.get<string>(
      ACTIVE_LLM_PROFILE_STORAGE_KEY
    );
    return profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
  }

  private getReasoningEffortPreferences(): Record<string, ReasoningEffort> {
    return parseReasoningEffortPreferences(
      this.extensionContext.globalState.get<unknown>(LLM_REASONING_EFFORT_STORAGE_KEY)
    );
  }

  private async setActiveReasoningEffort(effort: ReasoningEffort): Promise<void> {
    if (this.activeRequest) {
      this.postStatus('Wait for the active request to finish before changing intelligence.', 'warning');
      return;
    }
    const profile = this.getActiveLlmProfile();
    if (!profile || !reasoningEffortOptionsForProfile(profile).includes(effort)) {
      this.postStatus('The selected model does not support that intelligence level.', 'warning');
      await this.postLlmProfileState();
      return;
    }
    const preferences = { ...this.getReasoningEffortPreferences() };
    if (effort === 'auto') {
      delete preferences[profile.id];
    } else {
      preferences[profile.id] = effort;
    }
    await this.extensionContext.globalState.update(
      LLM_REASONING_EFFORT_STORAGE_KEY,
      preferences
    );
    await this.postLlmProfileState();
    this.postStatus('Ready');
  }

  private async migrateBuiltInNemotronProfile(): Promise<void> {
    const storedProfiles = this.getStoredLlmProfiles();
    const equivalentProfiles = storedProfiles.filter((profile) =>
      isEquivalentNemotronProfile(profile) && profile.contextWindowTokens === undefined
    );
    if (equivalentProfiles.length === 0) {
      return;
    }

    const activeProfileId = this.extensionContext.globalState.get<string>(
      ACTIVE_LLM_PROFILE_STORAGE_KEY
    );
    const preferredProfile = equivalentProfiles.find(
      (profile) => profile.id === activeProfileId
    );
    const keyCandidates = preferredProfile
      ? [preferredProfile, ...equivalentProfiles.filter((profile) => profile !== preferredProfile)]
      : equivalentProfiles;

    try {
      const builtInSecretKey = secretKeyForProfile(BUILT_IN_NEMOTRON_PROFILE_ID);
      const existingBuiltInKey = await this.extensionContext.secrets.get(builtInSecretKey);
      if (!existingBuiltInKey) {
        for (const candidate of keyCandidates) {
          const candidateKey = await this.extensionContext.secrets.get(
            secretKeyForProfile(candidate.id)
          );
          if (candidateKey) {
            await this.extensionContext.secrets.store(builtInSecretKey, candidateKey);
            break;
          }
        }
      }

      const equivalentIds = new Set(equivalentProfiles.map((profile) => profile.id));
      await this.extensionContext.globalState.update(
        LLM_PROFILES_STORAGE_KEY,
        storedProfiles.filter((profile) => !equivalentIds.has(profile.id))
      );
      if (!activeProfileId || equivalentIds.has(activeProfileId)) {
        await this.extensionContext.globalState.update(
          ACTIVE_LLM_PROFILE_STORAGE_KEY,
          BUILT_IN_NEMOTRON_PROFILE_ID
        );
      }
      await Promise.all(
        equivalentProfiles.map((profile) =>
          this.extensionContext.secrets.delete(secretKeyForProfile(profile.id))
        )
      );
    } catch {
      this.postStatus(
        `Could not migrate the existing ${BUILT_IN_NEMOTRON_PROFILE.name} profile.`,
        'warning'
      );
    }
  }

  private async promptForBuiltInNemotronKey(): Promise<void> {
    const activeProfile = this.getActiveLlmProfile();
    if (!activeProfile || !isBuiltInLlmProfile(activeProfile)) {
      return;
    }
    const apiKey = await this.extensionContext.secrets.get(
      secretKeyForProfile(BUILT_IN_NEMOTRON_PROFILE_ID)
    );
    if (!apiKey) {
      await this.showLlmProfileForm(activeProfile);
    }
  }

  private chooseLlmProfile(): void {
    const profiles = this.getLlmProfiles();
    const activeProfile = this.getActiveLlmProfile(profiles);
    const reasoningPreferences = this.getReasoningEffortPreferences();
    this.postMessage({
      command: 'showLlmProfilePicker',
      profiles: profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        providerLabel: providerLabelForProfile(profile),
        model: profile.model,
        baseUrl: profile.baseUrl,
        contextWindowTokens: profile.contextWindowTokens,
        intelligence: reasoningEffortOptionsForProfile(profile).length > 1
          ? REASONING_EFFORT_LABELS[reasoningEffortForProfile(profile, reasoningPreferences)]
          : undefined,
        builtIn: isBuiltInLlmProfile(profile),
        selected: profile.id === activeProfile?.id
      }))
    });
  }

  private async selectLlmProfile(profileId: string): Promise<void> {
    const profiles = this.getLlmProfiles();
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (!profile) {
      this.postStatus('That model profile no longer exists.', 'warning');
      return;
    }
    await this.extensionContext.globalState.update(
      ACTIVE_LLM_PROFILE_STORAGE_KEY,
      profile.id
    );
    await this.postLlmProfileState();
    await this.promptForBuiltInNemotronKey();
    this.postStatus('Ready');
  }

  private async editLlmProfile(profileId: string): Promise<void> {
    const profile = this.getLlmProfiles().find((candidate) => candidate.id === profileId);
    if (!profile) {
      this.postStatus('That model profile no longer exists.', 'warning');
      return;
    }
    await this.showLlmProfileForm(profile);
  }

  private cancelActiveRequest(): void {
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

  private async showLlmProfileForm(profile?: LlmProfile): Promise<void> {
    const hasApiKey = profile
      ? Boolean(await this.extensionContext.secrets.get(secretKeyForProfile(profile.id)))
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
            builtIn: isBuiltInLlmProfile(profile)
          }
        : undefined,
      hasApiKey
    });
  }

  private async saveLlmProfile(submission: LlmProfileFormSubmission): Promise<void> {
    if (
      (submission.id !== undefined && typeof submission.id !== 'string')
      || typeof submission.name !== 'string'
      || !['openai', 'ollama'].includes(submission.provider)
      || typeof submission.model !== 'string'
      || (submission.baseUrl !== undefined && typeof submission.baseUrl !== 'string')
      || !isValidModelContextWindowTokens(submission.contextWindowTokens)
      || (submission.apiKey !== undefined && typeof submission.apiKey !== 'string')
    ) {
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

    if (existingProfile && isBuiltInLlmProfile(existingProfile)) {
      await this.saveBuiltInNemotronApiKey(submission.apiKey);
      return;
    }

    const submittedDraft: LlmProfileDraft = {
      name: submission.name,
      provider: submission.provider,
      model: submission.model,
      baseUrl: submission.baseUrl,
      contextWindowTokens: submission.contextWindowTokens
    };
    const validationError = validateProfileDraft(
      submittedDraft,
      profiles,
      existingProfile?.id
    );
    if (validationError) {
      this.postMessage({ command: 'llmProfileFormError', message: validationError });
      return;
    }
    const draft = normalizeProfileDraft(submittedDraft);

    const existingApiKey = existingProfile
      ? await this.extensionContext.secrets.get(secretKeyForProfile(existingProfile.id))
      : undefined;
    const submittedApiKey = submission.apiKey?.trim();
    if (draft.provider === 'openai' && !submittedApiKey && !existingApiKey) {
      this.postMessage({
        command: 'llmProfileFormError',
        message: 'Enter an API key for this OpenAI profile.'
      });
      return;
    }

    const profile: LlmProfile = {
      id: existingProfile?.id ?? randomUUID(),
      ...draft
    };
    const secretKey = secretKeyForProfile(profile.id);
    const updatedProfiles = existingProfile
      ? storedProfiles.map((candidate) => candidate.id === profile.id ? profile : candidate)
      : [...storedProfiles, profile];

    try {
      if (draft.provider === 'openai' && submittedApiKey) {
        await this.extensionContext.secrets.store(secretKey, submittedApiKey);
      }
      await this.extensionContext.globalState.update(
        LLM_PROFILES_STORAGE_KEY,
        updatedProfiles
      );
      if (!existingProfile) {
        await this.extensionContext.globalState.update(
          ACTIVE_LLM_PROFILE_STORAGE_KEY,
          profile.id
        );
      }
      if (draft.provider === 'ollama') {
        await this.extensionContext.secrets.delete(secretKey);
      }
    } catch {
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

  private async saveBuiltInNemotronApiKey(apiKey: string | undefined): Promise<void> {
    const secretKey = secretKeyForProfile(BUILT_IN_NEMOTRON_PROFILE_ID);
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
    } catch {
      this.postMessage({
        command: 'llmProfileFormError',
        message: 'Could not save the NVIDIA API key.'
      });
      return;
    }

    await this.postLlmProfileState();
    this.postMessage({ command: 'closeLlmProfileForm' });
    this.postStatus(`${BUILT_IN_NEMOTRON_PROFILE.name} is ready.`);
  }

  private async deleteLlmProfileById(profileId: string): Promise<void> {
    const profile = this.getLlmProfiles().find((candidate) => candidate.id === profileId);
    if (!profile) {
      this.postMessage({
        command: 'llmProfileFormError',
        message: 'That model profile no longer exists.'
      });
      return;
    }
    if (isBuiltInLlmProfile(profile)) {
      this.postMessage({
        command: 'llmProfileFormError',
        message: 'The built-in Nemotron profile cannot be deleted.'
      });
      return;
    }

    const profiles = this.getLlmProfiles();
    const remainingProfiles = this.getStoredLlmProfiles().filter(
      (candidate) => candidate.id !== profile.id
    );
    const remainingReasoningPreferences = { ...this.getReasoningEffortPreferences() };
    delete remainingReasoningPreferences[profile.id];
    try {
      await this.extensionContext.globalState.update(
        LLM_PROFILES_STORAGE_KEY,
        remainingProfiles
      );
      await this.extensionContext.globalState.update(
        LLM_REASONING_EFFORT_STORAGE_KEY,
        remainingReasoningPreferences
      );
      await this.extensionContext.secrets.delete(secretKeyForProfile(profile.id));
      const activeProfile = this.getActiveLlmProfile(profiles);
      if (activeProfile?.id === profile.id) {
        await this.extensionContext.globalState.update(
          ACTIVE_LLM_PROFILE_STORAGE_KEY,
          BUILT_IN_NEMOTRON_PROFILE_ID
        );
      }
    } catch {
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

  private async postLlmProfileState(): Promise<void> {
    const profiles = this.getLlmProfiles();
    const activeProfile = this.getActiveLlmProfile(profiles);
    if (
      activeProfile
      && this.extensionContext.globalState.get<string>(ACTIVE_LLM_PROFILE_STORAGE_KEY) !== activeProfile.id
    ) {
      await this.extensionContext.globalState.update(
        ACTIVE_LLM_PROFILE_STORAGE_KEY,
        activeProfile.id
      );
    }

    const reasoningOptions = activeProfile
      ? reasoningEffortOptionsForProfile(activeProfile)
      : ['auto'] as ReasoningEffort[];
    const reasoningEffort = activeProfile
      ? reasoningEffortForProfile(activeProfile, this.getReasoningEffortPreferences())
      : 'auto';
    this.postMessage({
      command: 'llmProfilesUpdated',
      profileCount: profiles.length,
      activeProfile: activeProfile
        ? {
            id: activeProfile.id,
            name: activeProfile.name,
            provider: activeProfile.provider,
            providerLabel: providerLabelForProfile(activeProfile),
            model: activeProfile.model,
            reasoningEffort,
            reasoningEffortOptions: reasoningOptions.map((value) => ({
              value,
              label: REASONING_EFFORT_LABELS[value]
            }))
          }
        : undefined
    });
  }

  private postEmbeddingProfileState(): void {
    const { profiles, activeProfile } = this.embeddingProfiles.state();
    this.postMessage({
      command: 'embeddingProfilesUpdated',
      profileCount: profiles.length,
      activeProfile: activeProfile
        ? {
            ...activeProfile,
            providerLabel: embeddingProviderLabel(activeProfile.provider)
          }
        : undefined
    });
  }

  private chooseEmbeddingProfile(): void {
    this.postMessage({
      command: 'showEmbeddingProfilePicker',
      profiles: this.embeddingProfiles.pickerItems()
    });
  }

  private async selectEmbeddingProfile(profileId: string): Promise<void> {
    const result = await this.embeddingProfiles.select(profileId);
    if (!result.ok) {
      this.postStatus(result.message, 'warning');
      return;
    }
    this.postEmbeddingProfileState();
    this.postStatus(`${result.value.model} selected for code embeddings.`);
  }

  private async showEmbeddingProfileForm(profileId?: string): Promise<void> {
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

  private async saveEmbeddingProfile(
    submission: EmbeddingProfileFormSubmission
  ): Promise<void> {
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
    this.postStatus(
      submission.id
        ? `${result.value.model} embedding profile updated.`
        : `${result.value.model} selected for code embeddings.`
    );
  }

  private async deleteEmbeddingProfile(profileId: string): Promise<void> {
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

  private getPermissionPolicy(): FilePermissionPolicy {
    return parseFilePermissionPolicy(
      this.extensionContext.workspaceState.get<unknown>(FILE_PERMISSION_POLICY_STORAGE_KEY)
    );
  }

  private getRememberedCommands(): RememberedCommand[] {
    return parseRememberedCommands(
      this.extensionContext.workspaceState.get<unknown>(REMEMBERED_COMMANDS_STORAGE_KEY)
    );
  }

  private async revokeRememberedCommand(signature: string): Promise<void> {
    const updated = revokeRememberedCommand(this.getRememberedCommands(), signature);
    await this.extensionContext.workspaceState.update(REMEMBERED_COMMANDS_STORAGE_KEY, updated);
    this.postSettingsState();
  }

  private async saveSettings(settings: DevMateSettingsSubmission): Promise<void> {
    if (
      !Number.isInteger(settings.timeoutSeconds)
      || settings.timeoutSeconds < 10
      || settings.timeoutSeconds > 1800
      || !Number.isInteger(settings.commandTimeoutSeconds)
      || settings.commandTimeoutSeconds < MIN_COMMAND_TIMEOUT_SECONDS
      || settings.commandTimeoutSeconds > MAX_COMMAND_TIMEOUT_SECONDS
      || !Number.isInteger(settings.toolCallLimit)
      || settings.toolCallLimit < MIN_AGENT_TOOL_CALL_LIMIT
      || settings.toolCallLimit > MAX_AGENT_TOOL_CALL_LIMIT
      || !Number.isInteger(settings.maxTokens)
      || settings.maxTokens < 128
      || settings.maxTokens > 32_000
      || !isValidMaxInputContextTokens(settings.maxInputContextTokens)
      || !Number.isFinite(settings.temperature)
      || settings.temperature < 0
      || settings.temperature > 2
    ) {
      this.postStatus('The settings contain an invalid value.', 'warning');
      return;
    }

    const normalizedPolicy = parseFilePermissionPolicy(settings.policy);
    const config = vscode.workspace.getConfiguration('devMate');
    try {
      await Promise.all([
        config.update(
          'requestTimeoutSeconds',
          settings.timeoutSeconds,
          vscode.ConfigurationTarget.Global
        ),
        config.update(
          'commandTimeoutSeconds',
          settings.commandTimeoutSeconds,
          vscode.ConfigurationTarget.Global
        ),
        config.update(
          'toolCallLimit',
          settings.toolCallLimit,
          vscode.ConfigurationTarget.Global
        ),
        config.update('maxTokens', settings.maxTokens, vscode.ConfigurationTarget.Global),
        config.update(
          'maxInputContextTokens',
          settings.maxInputContextTokens,
          vscode.ConfigurationTarget.Global
        ),
        config.update('temperature', settings.temperature, vscode.ConfigurationTarget.Global),
        this.extensionContext.workspaceState.update(
          FILE_PERMISSION_POLICY_STORAGE_KEY,
          normalizedPolicy
        )
      ]);
    } catch {
      this.postStatus('DevMate could not save the settings.', 'error');
      return;
    }

    this.postPermissionPolicyState();
    this.postSettingsState();
    this.postMessage({ command: 'settingsSaved' });
  }

  private getAgentToolSettings(): AgentToolSettings {
    const config = vscode.workspace.getConfiguration('devMate');
    return normalizeAgentToolSettings({
      readFileMaxLines: config.get<number>('readFileMaxLines', DEFAULT_READ_FILE_MAX_LINES),
      listFilesMaxResults: config.get<number>(
        'listFilesMaxResults',
        DEFAULT_LIST_FILES_MAX_RESULTS
      ),
      searchCodeMaxResults: config.get<number>(
        'searchCodeMaxResults',
        DEFAULT_SEARCH_CODE_MAX_RESULTS
      ),
      diagnosticsMaxResults: config.get<number>(
        'diagnosticsMaxResults',
        DEFAULT_DIAGNOSTICS_MAX_RESULTS
      ),
      terminalErrorsMaxResults: config.get<number>(
        'terminalErrorsMaxResults',
        DEFAULT_TERMINAL_ERRORS_MAX_RESULTS
      ),
      codeNavigationMaxResults: config.get<number>(
        'codeNavigationMaxResults',
        DEFAULT_CODE_NAVIGATION_MAX_RESULTS
      )
    });
  }

  private async saveAgentToolSettings(settings: AgentToolSettingsSubmission): Promise<void> {
    const normalized = normalizeAgentToolSettings(settings);
    if (Object.entries(normalized).some(([key, value]) => settings[key as keyof AgentToolSettings] !== value)) {
      this.postStatus('The agent-tool settings contain an invalid value.', 'warning');
      return;
    }
    const config = vscode.workspace.getConfiguration('devMate');
    try {
      await Promise.all([
        config.update('readFileMaxLines', normalized.readFileMaxLines, vscode.ConfigurationTarget.Global),
        config.update(
          'listFilesMaxResults',
          normalized.listFilesMaxResults,
          vscode.ConfigurationTarget.Global
        ),
        config.update(
          'searchCodeMaxResults',
          normalized.searchCodeMaxResults,
          vscode.ConfigurationTarget.Global
        ),
        config.update(
          'diagnosticsMaxResults',
          normalized.diagnosticsMaxResults,
          vscode.ConfigurationTarget.Global
        ),
        config.update(
          'terminalErrorsMaxResults',
          normalized.terminalErrorsMaxResults,
          vscode.ConfigurationTarget.Global
        ),
        config.update(
          'codeNavigationMaxResults',
          normalized.codeNavigationMaxResults,
          vscode.ConfigurationTarget.Global
        )
      ]);
    } catch {
      this.postStatus('DevMate could not save the agent-tool settings.', 'error');
      return;
    }
    this.postSettingsState();
    this.postMessage({ command: 'agentToolSettingsSaved' });
    this.postStatus('Ready');
  }

  private postPermissionPolicyState(): void {
    const policy = this.getPermissionPolicy();
    this.postMessage({
      command: 'permissionPolicyUpdated',
      policy
    });
  }

  private postSettingsState(): void {
    const config = vscode.workspace.getConfiguration('devMate');
    this.postMessage({
      command: 'settingsUpdated',
      settings: {
        timeoutSeconds: Math.min(
          1800,
          Math.max(10, config.get<number>('requestTimeoutSeconds', 900))
        ),
        commandTimeoutSeconds: Math.min(
          MAX_COMMAND_TIMEOUT_SECONDS,
          Math.max(
            MIN_COMMAND_TIMEOUT_SECONDS,
            config.get<number>('commandTimeoutSeconds', DEFAULT_COMMAND_TIMEOUT_SECONDS)
          )
        ),
        toolCallLimit: boundedAgentToolCallLimit(
          config.get<number>('toolCallLimit', DEFAULT_AGENT_TOOL_CALL_LIMIT)
        ),
        maxTokens: Math.min(
          32_000,
          Math.max(128, config.get<number>('maxTokens', 16_384))
        ),
        maxInputContextTokens: normalizeMaxInputContextTokens(
          config.get<number>(
            'maxInputContextTokens',
            AUTO_MAX_INPUT_CONTEXT_TOKENS
          )
        ),
        temperature: Math.min(
          2,
          Math.max(0, config.get<number>('temperature', 0.2))
        ),
        agentTools: this.getAgentToolSettings(),
        rememberedCommands: this.getRememberedCommands(),
        workspaceTrusted: vscode.workspace.isTrusted
      }
    });
  }

  private postBackendStatus(): void {
    const status = this.backendManager.status;
    this.postMessage({
      command: 'backendStatusUpdated',
      status,
      label: backendStatusLabel(status)
    });
  }

  private async handlePermissionDecision(
    requestId: string,
    decision: 'deny' | 'allowOnce' | 'allowAlways'
  ): Promise<void> {
    const pending = this.pendingPermission;
    if (!pending || pending.id !== requestId) {
      return;
    }
    this.pendingPermission = undefined;

    if (decision === 'allowAlways' && pending.rememberable) {
      try {
        const updatedPolicy = allowActions(this.getPermissionPolicy(), pending.actions);
        await this.extensionContext.workspaceState.update(
          FILE_PERMISSION_POLICY_STORAGE_KEY,
          updatedPolicy
        );
        this.postPermissionPolicyState();
      } catch {
        this.postStatus(
          'The changes are allowed this time, but the permission preference could not be saved.',
          'warning'
        );
      }
    }

    pending.resolve(decision !== 'deny');
    this.clearPendingDiffDocuments(pending);
  }

  private clearPendingDiffDocuments(pending?: PendingPermissionRequest): void {
    if (!pending) {
      return;
    }
    for (const diff of pending.diffs.values()) {
      this.diffDocuments.delete(diff.originalUri.toString());
      this.diffDocuments.delete(diff.proposedUri.toString());
    }
  }

  private requestFileChangePermission(
    summary: string,
    files: WorkspaceMutationPermissionFile[]
  ): Promise<boolean> {
    const previousPermission = this.pendingPermission;
    previousPermission?.resolve(false);
    this.clearPendingDiffDocuments(previousPermission);
    const requestId = randomUUID();
    const actions = new Set(files.map((file) => file.operation));
    const rememberable = [...actions].every(
      (action) => action === 'create' || action === 'update'
    );
    const diffs = new Map<string, PendingFileDiff>();
    for (const file of files) {
      const encodedPath = file.path.split('/').map(encodeURIComponent).join('/');
      const originalUri = vscode.Uri.parse(
        `${DevMateChatViewProvider.diffScheme}:/${requestId}/original/${encodedPath}`
      );
      const proposedUri = vscode.Uri.parse(
        `${DevMateChatViewProvider.diffScheme}:/${requestId}/proposed/${encodedPath}`
      );
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

  private async reviewPermissionDiff(requestId: string, filePath: string): Promise<void> {
    const pending = this.pendingPermission;
    const diff = pending?.id === requestId ? pending.diffs.get(filePath) : undefined;
    if (!diff) {
      this.postStatus('That proposed diff is no longer available.', 'warning');
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      diff.originalUri,
      diff.proposedUri,
      `DevMate: ${diff.path}`,
      { preview: true }
    );
  }

  private requestCommandPermission(
    signature: string,
    label: string,
    cwd: string,
    options: {
      rememberable?: boolean;
      title?: string;
      warning?: string;
    } = {}
  ): Promise<boolean> {
    const rememberable = options.rememberable !== false;
    if (rememberable && this.getRememberedCommands().some((command) => command.signature === signature)) {
      return Promise.resolve(true);
    }
    this.pendingCommandPermission?.resolve(false);
    const requestId = randomUUID();
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

  private async handleCommandPermissionDecision(
    requestId: string,
    decision: 'deny' | 'allowOnce' | 'allowAlways'
  ): Promise<void> {
    const pending = this.pendingCommandPermission;
    if (!pending || pending.id !== requestId) {
      return;
    }
    this.pendingCommandPermission = undefined;
    if (decision === 'allowAlways' && pending.rememberable) {
      const updated = rememberCommand(this.getRememberedCommands(), {
        signature: pending.signature,
        label: pending.label
      });
      await this.extensionContext.workspaceState.update(REMEMBERED_COMMANDS_STORAGE_KEY, updated);
      this.postSettingsState();
    }
    pending.resolve(decision === 'allowOnce' || (decision === 'allowAlways' && pending.rememberable));
  }

  private async readProjectCandidate(uri: vscode.Uri) {
    return this.workspaceContext.readProjectCandidate(uri);
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

  private async answerQuestion(
    message: Extract<WebviewMessage, { command: 'ask' }>,
    signal: AbortSignal,
    resumedCheckpoint?: AgentRunCheckpoint
  ): Promise<void> {
    const question = message.question.trim();
    if (!question) {
      this.postRequestFailure('Enter a question before asking.', { level: 'warning' });
      return;
    }
    if (!resumedCheckpoint) {
      this.activeRequestDiffs.clear();
    }

    const activeSession = activeConversationSession(this.sessionStore);
    const conversationWorkspace = this.getConversationWorkspace();
    if (
      !activeSession
      || !conversationWorkspace
      || !sessionBelongsToWorkspace(activeSession, conversationWorkspace)
    ) {
      this.postRequestFailure(
        'Choose a session for the currently open project before asking.',
        { level: 'warning' }
      );
      return;
    }

    if (!resumedCheckpoint && message.isNewTurn !== false) {
      this.sessionStore = appendConversationSessionUserMessage(
        this.sessionStore,
        question,
        Date.now()
      );
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
      this.postRequestFailure(
        'DevMate could not establish an authenticated backend connection.',
        { level: 'warning', retryable: true }
      );
      return;
    }

    this.postStatus('Collecting context');
    const collectedScope = await this.collectScope(message.scope.kind, question, signal);
    if (this.finishCancelledRequest(signal)) {
      return;
    }
    if (!collectedScope) {
      this.postRequestFailure(
        message.scope.kind === 'selection' ? 'Select code first.' : 'Open a file first.',
        { level: 'warning' }
      );
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
    const maxTokens = config.get<number>('maxTokens', 16384);
    const temperature = config.get<number>('temperature', 0.2);
    const toolCallLimit = boundedAgentToolCallLimit(
      config.get<number>('toolCallLimit', DEFAULT_AGENT_TOOL_CALL_LIMIT)
    );
    const modelTimeoutSeconds = Math.min(
      1800,
      Math.max(10, config.get<number>('requestTimeoutSeconds', 900))
    );

    const providerApiKey = activeProfile.provider === 'openai'
      ? await this.extensionContext.secrets.get(secretKeyForProfile(activeProfile.id))
      : undefined;
    if (activeProfile.provider === 'openai' && !providerApiKey) {
      this.postRequestFailure('The selected model profile is missing an API key.', {
        level: 'warning',
        retryable: true
      });
      await this.showLlmProfileForm(activeProfile);
      return;
    }

    const outcome = await this.agentRunController.run({
      question,
      mode: message.mode,
      scopeKind: message.scope.kind,
      scope: collectedScope.apiScope,
      conversationHistory: activeSessionModelHistory(this.sessionStore),
      modelContextWindowTokens: activeProfile.contextWindowTokens,
      maxInputContextTokens: normalizeMaxInputContextTokens(
        config.get<number>(
          'maxInputContextTokens',
          AUTO_MAX_INPUT_CONTEXT_TOKENS
        )
      ),
      settings: {
        provider: activeProfile.provider,
        model: activeProfile.model,
        baseUrl: activeProfile.baseUrl,
        maxTokens,
        temperature,
        reasoningEffort: reasoningEffortForProfile(
          activeProfile,
          this.getReasoningEffortPreferences()
        ),
        timeoutSeconds: modelTimeoutSeconds
      },
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
    const {
      response: finalData,
      toolHistory,
      toolUsedFiles
    } = outcome;

    if (this.finishCancelledRequest(signal)) {
      return;
    }

    let changeOutcome = '';
    try {
      const fileChanges = validateFileChanges(finalData.changes ?? []);
      if (fileChanges.length > 0) {
        changeOutcome = await this.confirmAndApplyFileChanges(
          fileChanges,
          finalData.answer,
          signal
        );
        if (
          signal.aborted
          && !changeOutcome.startsWith('Applied file changes:')
          && this.finishCancelledRequest(signal)
        ) {
          return;
        }
      }
    } catch (error) {
      changeOutcome = error instanceof Error
        ? `Changes were not applied: ${error.message}`
        : 'Changes were not applied because the response was invalid.';
      this.postStatus(changeOutcome, 'error');
    }

    const appliedResponseChanges = parseAppliedFileChangeOutcome(changeOutcome);
    const fileChangeSummary = collectFileChangeSummary(toolHistory, appliedResponseChanges)
      .map((change) => {
        const diffId = this.activeRequestDiffs.get(this.fileChangePathKey(change.path));
        return diffId ? { ...change, diffId } : change;
      });
    const changeNotice = changeOutcome.startsWith('Applied file changes:')
      ? changeOutcome.split('\n\n').slice(1).join('\n\n')
      : changeOutcome;
    const response = [
      formatAskResponse(
        finalData.answer,
        [...new Set([...finalData.usedFiles, ...toolUsedFiles])]
      ),
      changeNotice
    ].filter(Boolean).join('\n\n');

    this.sessionStore = appendConversationSessionTurn(
      this.sessionStore,
      question,
      response,
      Date.now(),
      fileChangeSummary
    );
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

  private async confirmAndApplyFileChanges(
    changes: ValidatedFileChange[],
    summary: string,
    signal: AbortSignal
  ): Promise<string> {
    return this.workspaceMutations.confirmAndApplyFileChanges(changes, summary, signal);
  }

  private postStatus(text: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    this.postMessage({ command: 'status', text, level });
  }

  private postMessage(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function getBackendUrl(): string {
  return vscode.workspace
    .getConfiguration('devMate')
    .get<string>('backendUrl', 'http://127.0.0.1:8000')
    .trim();
}

function formatAskResponse(answer: string, usedFiles: string[]): string {
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
