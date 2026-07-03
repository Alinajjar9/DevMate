import { randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  DEFAULT_AGENT_TOOL_CALL_LIMIT,
  MAX_AGENT_CONSECUTIVE_INSPECTIONS,
  MAX_AGENT_TOOL_CALL_LIMIT,
  MIN_AGENT_TOOL_CALL_LIMIT,
  MAX_AGENT_COMMAND_CALLS,
  MAX_AGENT_DEPENDENCY_INSTALLS,
  MAX_AGENT_FILE_MUTATIONS,
  FILE_MUTATION_AGENT_TOOL_NAMES,
  READ_ONLY_AGENT_TOOL_NAMES,
  agentToolCallSignature,
  boundedAgentToolHistoryArguments,
  boundedAgentToolCallLimit,
  compactAgentToolHistory,
  consecutiveAgentInspectionCalls,
  isDeferredAgentPlanAnswer,
  isFileMutationAgentTool,
  isReadOnlyAgentTool,
  normalizeAgentToolCallForWorkspace,
  parseAgentToolCall,
  summarizedAgentToolArguments,
  summarizeAgentToolHistory,
  truncateAgentToolResult
} from './agentTools';
import type { AgentToolCall, AgentToolName, ParsedAgentToolCall } from './agentTools';
import {
  DEFAULT_CODE_NAVIGATION_MAX_RESULTS,
  DEFAULT_DIAGNOSTICS_MAX_RESULTS,
  DEFAULT_LIST_FILES_MAX_RESULTS,
  DEFAULT_READ_FILE_MAX_LINES,
  DEFAULT_SEARCH_CODE_MAX_RESULTS,
  DEFAULT_TERMINAL_ERRORS_MAX_RESULTS,
  normalizeAgentToolSettings
} from './agentToolSettings';
import type { AgentToolSettings } from './agentToolSettings';
import {
  AGENT_CHECKPOINT_STORAGE_KEY,
  parseAgentRunCheckpoint
} from './agentCheckpoint';
import type { AgentRunCheckpoint } from './agentCheckpoint';
import { ask, askStream, health } from './api/client';
import { backendStatusLabel, LocalBackendManager } from './backendManager';
import type { ManagedBackendStatus } from './backendManager';
import type {
  AgentToolStep,
  ApiResult,
  AskContextItem,
  AskRequest,
  AskResponse,
  AskScope,
  AssistantMode,
  TokenUsage
} from './api/types';
import { createBoundedContextItem } from './context';
import {
  collectFileChangeSummary,
  parseAppliedFileChangeOutcome
} from './changeSummary';
import {
  CONVERSATION_SESSIONS_STORAGE_KEY,
  LEGACY_CONVERSATION_SESSIONS_STORAGE_KEY,
  activeConversationSession,
  activeSessionModelHistory,
  addConversationSession,
  appendConversationSessionTurn,
  appendConversationSessionUserMessage,
  createEmptyConversationSessionStore,
  deleteConversationSession,
  mergeConversationSessionStores,
  migrateLegacyConversationSessionStore,
  parseConversationSessionStore,
  renameConversationSession,
  sessionBelongsToWorkspace,
  selectConversationSession
} from './sessions';
import type { ConversationSessionStore, ConversationWorkspace } from './sessions';
import {
  boundedModelCommandOutput,
  commandLabel,
  commandSignature,
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  MAX_COMMAND_TIMEOUT_SECONDS,
  MIN_COMMAND_TIMEOUT_SECONDS,
  sanitizeCommandOutput
} from './commandTools';
import type { ValidatedCommand } from './commandTools';
import {
  formatCapturedTerminalErrors,
  MAX_CAPTURED_TERMINAL_ERRORS,
  sanitizeCapturedTerminalText
} from './errorContext';
import type { CapturedTerminalError } from './errorContext';
import {
  MAX_DEPENDENCY_MANIFEST_BYTES,
  validatePythonRequirementsManifest
} from './dependencyTools';
import {
  extractMissingPythonModule,
  isPythonVerificationCommand,
  workspacePythonCandidates,
  workspacePythonExecutable
} from './pythonEnvironment';
import {
  MAX_FILE_CHANGE_CHARACTERS,
  MAX_TOTAL_CHANGE_CHARACTERS,
  validateFileChanges
} from './fileChanges';
import type { ValidatedFileChange } from './fileChanges';
import { applyExactReplacements } from './fileTools';
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
  permissionBehaviorForAction,
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
  containsBinaryData,
  languageIdForPath,
  MAX_ATTACHMENT_CANDIDATES,
  MAX_ATTACHED_FILES,
  MAX_PROJECT_CANDIDATES,
  MAX_PROJECT_CONTEXT_CHARACTERS,
  MAX_PROJECT_FILE_BYTES,
  MAX_PROJECT_FILE_CHARACTERS,
  MAX_PROJECT_FILES,
  PROJECT_EXCLUDE_GLOB,
  selectProjectContext,
  shouldSkipProjectFile
} from './projectContext';
import type { ProjectFileCandidate } from './projectContext';
import {
  createEmptyProjectIndex,
  createIndexedProjectFile,
  MAX_PROJECT_INDEX_FILES,
  parseStoredProjectIndex,
  PROJECT_INDEX_FILE_NAME,
  retrieveProjectChunks
} from './projectIndex';
import type { ProjectIndex, RetrievedProjectChunk } from './projectIndex';
import {
  emptyResponseRecoveryAction,
  isRetryableProviderFailure,
  providerRetryDelay,
  PROVIDER_RETRY_DELAYS_MS
} from './retryPolicy';

type ScopeKind = 'project' | 'activeFile' | 'selection';

type ScopeInfo = {
  kind: ScopeKind;
  label: string;
  detail: string;
};

type CollectedScope = {
  info: ScopeInfo;
  apiScope: AskScope;
};

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
  apiKey?: string;
};

type DevMateSettingsSubmission = {
  timeoutSeconds: number;
  commandTimeoutSeconds: number;
  toolCallLimit: number;
  maxTokens: number;
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

type WorkspaceCodeLocation = {
  path: string;
  line: number;
  column: number;
  filePath: string;
};

type AgentToolExecution = {
  step: AgentToolStep;
  usedFiles: string[];
  mutationCharacters: number;
  mutationApplied?: boolean;
  commandAttempted?: boolean;
  missingDependency?: string;
  pythonEnvironment?: string;
  installAttempted?: boolean;
  environmentChanged?: boolean;
};

type ActiveTerminalCapture = {
  command: string;
  cwd: string;
  terminalName: string;
  output: string;
  reader?: Promise<void>;
};

class StartedCommandError extends Error {
  readonly commandAttempted = true;

  constructor(
    message: string,
    readonly missingDependency?: string,
    readonly pythonEnvironment?: string
  ) {
    super(message);
  }
}

class StartedDependencyInstallError extends Error {
  readonly installAttempted = true;
}

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

export function activate(context: vscode.ExtensionContext): void {
  const backendOutput = vscode.window.createOutputChannel('DevMate Backend');
  let chatViewProvider: DevMateChatViewProvider | undefined;
  const backendManager = new LocalBackendManager({
    extensionPath: context.extensionUri.fsPath,
    getBackendUrl,
    isManagementEnabled: () => vscode.workspace.getConfiguration('devMate').get<boolean>(
      'manageLocalBackend',
      true
    ),
    getConfiguredPythonPath: () => vscode.workspace.getConfiguration('devMate').get<string>(
      'backendPythonPath',
      ''
    ),
    healthCheck: async (backendUrl) => (await health(backendUrl)).status === 'ok',
    fileExists: (filePath) => fs.existsSync(filePath),
    onStatus: (status) => chatViewProvider?.notifyBackendStatusChanged(status),
    onOutput: (value) => backendOutput.append(value)
  });
  chatViewProvider = new DevMateChatViewProvider(context, backendManager, backendOutput);
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

class DevMateChatViewProvider implements
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
  private pendingPermission?: PendingPermissionRequest;
  private pendingCommandPermission?: PendingCommandPermission;
  private activeRequest?: AbortController;
  private projectIndexCache?: ProjectIndex;
  private readonly diffDocuments = new Map<string, string>();
  private readonly completedFileDiffs = new Map<string, CompletedFileDiff>();
  private readonly activeRequestDiffs = new Map<string, string>();
  private readonly commandTerminals = new Map<string, vscode.Terminal>();
  private readonly activeTerminalCaptures = new Map<vscode.TerminalShellExecution, ActiveTerminalCapture>();
  private readonly recentTerminalErrors: CapturedTerminalError[] = [];
  private sessionStore: ConversationSessionStore;
  private agentCheckpoint?: AgentRunCheckpoint;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly backendManager: LocalBackendManager,
    private readonly backendOutput: vscode.OutputChannel
  ) {
    this.extensionUri = extensionContext.extensionUri;
    this.agentCheckpoint = parseAgentRunCheckpoint(
      extensionContext.workspaceState.get<unknown>(AGENT_CHECKPOINT_STORAGE_KEY)
    );
    const parsedStoredSessions = parseConversationSessionStore(
      extensionContext.globalState.get<unknown>(CONVERSATION_SESSIONS_STORAGE_KEY)
    );
    const storedSessions = parsedStoredSessions ?? createEmptyConversationSessionStore();
    const workspace = this.getConversationWorkspace();
    const legacySessions = workspace
      ? migrateLegacyConversationSessionStore(
        extensionContext.workspaceState.get<unknown>(LEGACY_CONVERSATION_SESSIONS_STORAGE_KEY),
        workspace
      )
      : undefined;
    this.sessionStore = legacySessions
      ? mergeConversationSessionStores(storedSessions, legacySessions)
      : storedSessions;
    if (legacySessions) {
      void this.persistSessionStore().then((saved) => {
        if (saved) {
          return extensionContext.workspaceState.update(
            LEGACY_CONVERSATION_SESSIONS_STORAGE_KEY,
            undefined
          );
        }
        return undefined;
      });
    } else if (!parsedStoredSessions) {
      void this.persistSessionStore();
    }
    this.lifetimeDisposables.push(
      vscode.window.onDidStartTerminalShellExecution((event) => {
        this.captureWorkspaceTerminalExecution(event);
      }),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        void this.finishWorkspaceTerminalExecution(event);
      })
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.disposeViewDisposables();
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

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
    this.activeTerminalCaptures.clear();
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
        this.commandTerminals.get(message.activityId)?.show(false);
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
    this.sessionStore = addConversationSession(
      this.sessionStore,
      randomUUID(),
      Date.now(),
      workspace
    );
    await this.persistSessionStore();
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
    await this.persistSessionStore();
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
    await this.persistSessionStore();
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
    await this.persistSessionStore();
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

  private async persistSessionStore(): Promise<boolean> {
    try {
      await this.extensionContext.globalState.update(
        CONVERSATION_SESSIONS_STORAGE_KEY,
        this.sessionStore
      );
      return true;
    } catch {
      this.postStatus(
        'The session is available now, but VS Code could not save it for the next restart.',
        'warning'
      );
      return false;
    }
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

  private getConversationWorkspace(): ConversationWorkspace | undefined {
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

  private async collectScope(scope: ScopeKind, question?: string): Promise<CollectedScope | undefined> {
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
        ? await this.collectAttachmentItems(
            MAX_PROJECT_FILES,
            MAX_PROJECT_CONTEXT_CHARACTERS
          )
        : [];
      const items = question
        ? await this.collectProjectItems(folder, question, attachmentItems)
        : [];
      const includedCharacters = items.reduce(
        (total, item) => total + item.includedCharacters,
        0
      );
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

    const contextItem = createBoundedContextItem(
      source,
      filePath,
      editor.document.languageId,
      content
    );
    const size = formatContextSize(
      contextItem.includedCharacters,
      contextItem.totalCharacters,
      contextItem.truncated
    );

    const attachmentItems = question
      ? await this.collectAttachmentItems(
          MAX_ATTACHED_FILES,
          MAX_PROJECT_CONTEXT_CHARACTERS - contextItem.includedCharacters,
          new Set([contextItem.filePath])
        )
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

  private async collectProjectItems(
    folder: vscode.WorkspaceFolder,
    question: string,
    attachmentItems: AskContextItem[]
  ): Promise<AskScope['items']> {
    const includedAttachmentCharacters = attachmentItems.reduce(
      (total, item) => total + item.includedCharacters,
      0
    );
    if (
      attachmentItems.length >= MAX_PROJECT_FILES
      || includedAttachmentCharacters >= MAX_PROJECT_CONTEXT_CHARACTERS
    ) {
      return attachmentItems;
    }

    const remainingFiles = MAX_PROJECT_FILES - attachmentItems.length;
    const remainingCharacters = MAX_PROJECT_CONTEXT_CHARACTERS - includedAttachmentCharacters;
    const attachedPaths = new Set(attachmentItems.map((item) => item.filePath));

    try {
      this.postStatus('Refreshing project index');
      const refresh = await this.refreshProjectIndex(folder);
      this.postStatus(refresh.changedFiles > 0 || refresh.removedFiles > 0
        ? `Indexed ${formatFileCount(refresh.index.files.length)}`
        : 'Searching project index');
      const chunks = retrieveProjectChunks(refresh.index, question, {
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
    } catch {
      this.postStatus('Project index unavailable — using fallback');
    }

    return this.collectRankedProjectItems(
      folder,
      question,
      attachmentItems,
      remainingFiles,
      remainingCharacters
    );
  }

  private async collectRankedProjectItems(
    folder: vscode.WorkspaceFolder,
    question: string,
    attachmentItems: AskContextItem[],
    remainingFiles: number,
    remainingCharacters: number
  ): Promise<AskScope['items']> {
    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*'),
        PROJECT_EXCLUDE_GLOB,
        MAX_PROJECT_CANDIDATES
      );
    } catch {
      return attachmentItems;
    }

    const candidates: ProjectFileCandidate[] = [];
    const batchSize = 20;
    for (let offset = 0; offset < uris.length; offset += batchSize) {
      const batch = uris.slice(offset, offset + batchSize);
      const batchCandidates = await Promise.all(
        batch.map((uri) => this.readProjectCandidate(uri))
      );
      for (const candidate of batchCandidates) {
        if (candidate) {
          candidates.push(candidate);
        }
      }
    }

    const attachedPaths = new Set(attachmentItems.map((item) => item.filePath));
    const discoveryCandidates = candidates.filter(
      (candidate) => !attachedPaths.has(candidate.filePath)
    );
    const discoveredItems = selectProjectContext(discoveryCandidates, question, {
      maxFiles: remainingFiles,
      maxCharacters: remainingCharacters
    });

    return [...attachmentItems, ...discoveredItems];
  }

  private createRetrievedProjectItems(
    chunks: RetrievedProjectChunk[],
    maxCharacters: number
  ): AskContextItem[] {
    const items: AskContextItem[] = [];
    let remainingCharacters = Math.max(0, maxCharacters);
    for (const chunk of chunks) {
      if (items.length >= MAX_PROJECT_FILES || remainingCharacters <= 0) {
        break;
      }
      const lineLabel = chunk.startLine === chunk.endLine
        ? `line ${chunk.startLine}`
        : `lines ${chunk.startLine}-${chunk.endLine}`;
      const content = `[Local index excerpt: ${lineLabel}]\n${chunk.content}`;
      const item = createBoundedContextItem(
        'file',
        chunk.filePath,
        chunk.languageId,
        content,
        Math.min(MAX_PROJECT_FILE_CHARACTERS, remainingCharacters)
      );
      item.totalCharacters = Math.max(item.includedCharacters, chunk.totalCharacters);
      item.truncated = item.includedCharacters < item.totalCharacters;
      items.push(item);
      remainingCharacters -= item.includedCharacters;
    }
    return items;
  }

  private async refreshProjectIndex(folder: vscode.WorkspaceFolder): Promise<{
    index: ProjectIndex;
    changedFiles: number;
    removedFiles: number;
  }> {
    const workspacePath = folder.uri.scheme === 'file'
      ? folder.uri.fsPath
      : folder.uri.toString();
    const existingIndex = await this.loadProjectIndex(workspacePath);
    const existingFiles = new Map(
      existingIndex.files.map((file) => [normalizeRelativeWorkspacePath(file.relativePath), file])
    );
    const uris = (await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*'),
      PROJECT_EXCLUDE_GLOB,
      MAX_PROJECT_INDEX_FILES
    )).filter((uri) => !shouldSkipProjectFile(vscode.workspace.asRelativePath(uri, false)))
      .sort((left, right) => vscode.workspace.asRelativePath(left, false).localeCompare(
        vscode.workspace.asRelativePath(right, false)
      ));

    const indexedFiles: ProjectIndex['files'] = [];
    let changedFiles = 0;
    const batchSize = 20;
    for (let offset = 0; offset < uris.length; offset += batchSize) {
      const batchFiles = await Promise.all(uris.slice(offset, offset + batchSize).map(async (uri) => {
        const relativePath = normalizeRelativeWorkspacePath(
          vscode.workspace.asRelativePath(uri, false)
        );
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if ((stat.type & vscode.FileType.File) === 0 || stat.size > MAX_PROJECT_FILE_BYTES) {
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
          return createIndexedProjectFile(candidate, stat.size, stat.mtime);
        } catch {
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
    const removedFiles = existingIndex.files.filter(
      (file) => !indexedPaths.has(normalizeRelativeWorkspacePath(file.relativePath))
    ).length;
    const index: ProjectIndex = {
      ...createEmptyProjectIndex(workspacePath),
      files: indexedFiles
    };
    this.projectIndexCache = index;
    if (changedFiles > 0 || removedFiles > 0 || existingIndex.files.length === 0) {
      try {
        await this.persistProjectIndex(index);
      } catch {
        // Retrieval can continue from memory when private workspace storage is unavailable.
      }
    }
    return { index, changedFiles, removedFiles };
  }

  private async loadProjectIndex(workspacePath: string): Promise<ProjectIndex> {
    if (this.projectIndexCache?.workspacePath === workspacePath) {
      return this.projectIndexCache;
    }
    const emptyIndex = createEmptyProjectIndex(workspacePath);
    const storageUri = this.projectIndexStorageUri();
    if (!storageUri) {
      this.projectIndexCache = emptyIndex;
      return emptyIndex;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(storageUri);
      const parsed = parseStoredProjectIndex(
        JSON.parse(new TextDecoder('utf-8').decode(bytes)) as unknown,
        workspacePath
      );
      this.projectIndexCache = parsed ?? emptyIndex;
    } catch {
      this.projectIndexCache = emptyIndex;
    }
    return this.projectIndexCache;
  }

  private async persistProjectIndex(index: ProjectIndex): Promise<void> {
    const storageUri = this.projectIndexStorageUri();
    const storageDirectory = this.extensionContext.storageUri;
    if (!storageUri || !storageDirectory) {
      return;
    }
    await vscode.workspace.fs.createDirectory(storageDirectory);
    await vscode.workspace.fs.writeFile(
      storageUri,
      new TextEncoder().encode(JSON.stringify(index))
    );
  }

  private projectIndexStorageUri(): vscode.Uri | undefined {
    const storageDirectory = this.extensionContext.storageUri;
    return storageDirectory
      ? vscode.Uri.joinPath(storageDirectory, PROJECT_INDEX_FILE_NAME)
      : undefined;
  }

  private async collectAttachmentItems(
    maxFiles: number,
    maxCharacters: number,
    excludedFilePaths: Set<string> = new Set()
  ): Promise<AskContextItem[]> {
    const items: AskContextItem[] = [];
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

      const item = createBoundedContextItem(
        'attachment',
        candidate.filePath,
        candidate.languageId,
        candidate.content,
        Math.min(MAX_PROJECT_FILE_CHARACTERS, remainingCharacters)
      );
      items.push(item);
      remainingCharacters -= item.includedCharacters;
    }

    return items;
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
    const equivalentProfiles = storedProfiles.filter(isEquivalentNemotronProfile);
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

    const draft: LlmProfileDraft = normalizeProfileDraft({
      name: submission.name,
      provider: submission.provider,
      model: submission.model,
      baseUrl: submission.baseUrl
    });
    const validationError = validateProfileDraft(draft, profiles, existingProfile?.id);
    if (validationError) {
      this.postMessage({ command: 'llmProfileFormError', message: validationError });
      return;
    }

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
    files: Array<{
      path: string;
      operation: FilePermissionAction;
      originalContent: string;
      proposedContent: string;
    }>
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

  private async readProjectCandidate(uri: vscode.Uri): Promise<ProjectFileCandidate | undefined> {
    const relativePath = vscode.workspace.asRelativePath(uri, false);
    if (shouldSkipProjectFile(relativePath)) {
      return undefined;
    }

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.File) === 0 || stat.size > MAX_PROJECT_FILE_BYTES) {
        return undefined;
      }

      const bytes = await vscode.workspace.fs.readFile(uri);
      if (containsBinaryData(bytes)) {
        return undefined;
      }

      return {
        filePath: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
        relativePath,
        languageId: languageIdForPath(relativePath),
        content: new TextDecoder('utf-8').decode(bytes)
      };
    } catch {
      return undefined;
    }
  }

  private async executeAgentToolCall(
    call: AgentToolCall,
    remainingMutationCharacters = MAX_TOTAL_CHANGE_CHARACTERS
  ): Promise<AgentToolExecution> {
    let parsedCall: ParsedAgentToolCall;
    try {
      parsedCall = parseAgentToolCall(call);
    } catch (error) {
      const result = error instanceof Error ? error.message : 'The tool request was invalid.';
      this.postAgentToolActivity(call.id, 'Tool request rejected', call.name, 'error', result);
      return {
        step: {
          callId: call.id,
          name: call.name,
          arguments: boundedAgentToolHistoryArguments(call.name, call.arguments),
          result: truncateAgentToolResult(result),
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
      this.postAgentToolActivity(
        call.id,
        activity.title,
        activity.detail,
        'completed',
        execution.resultSummary,
        (parsedCall.name === 'run_command' || parsedCall.name === 'install_dependencies')
          && this.commandTerminals.has(parsedCall.id)
      );
      return {
        step: {
          callId: parsedCall.id,
          name: parsedCall.name,
          arguments: summarizedAgentToolArguments(parsedCall),
          result: truncateAgentToolResult(execution.result),
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
    } catch (error) {
      const result = error instanceof Error ? error.message : 'The tool could not be completed.';
      this.postAgentToolActivity(
        call.id,
        activity.title,
        activity.detail,
        'error',
        result,
        (parsedCall.name === 'run_command' || parsedCall.name === 'install_dependencies')
          && this.commandTerminals.has(parsedCall.id)
      );
      return {
        step: {
          callId: parsedCall.id,
          name: parsedCall.name,
            arguments: summarizedAgentToolArguments(parsedCall),
          result: truncateAgentToolResult(result),
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

  private async runAgentTool(
    call: ParsedAgentToolCall,
    remainingMutationCharacters: number
  ): Promise<{
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
    mutationApplied?: boolean;
    commandAttempted?: boolean;
    missingDependency?: string;
    pythonEnvironment?: string;
    installAttempted?: boolean;
    environmentChanged?: boolean;
  }> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('Open a workspace folder before using project tools.');
    }
    const toolSettings = this.getAgentToolSettings();

    if (call.name === 'create_file') {
      await this.assertNoWorkspaceSymlink(folder, call.arguments.path, true);
      const uri = vscode.Uri.joinPath(folder.uri, ...call.arguments.path.split('/'));
      try {
        await vscode.workspace.fs.stat(uri);
        throw new Error(`${call.arguments.path} already exists; use edit_file instead.`);
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
          throw error;
        }
      }
      const changes = validateFileChanges([call.arguments]);
      if (call.arguments.content.length > remainingMutationCharacters) {
        throw new Error('This request reached the total file-mutation size limit.');
      }
      const outcome = await this.confirmAndApplyFileChanges(
        changes,
        `Create ${call.arguments.path}`,
        this.activeRequest?.signal ?? new AbortController().signal
      );
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
      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(uri);
      } catch {
        throw new Error(`${call.arguments.path} does not exist or cannot be opened.`);
      }
      if (document.isDirty) {
        throw new Error(`Save or discard your unsaved changes in ${call.arguments.path} before DevMate edits it.`);
      }
      const updatedContent = applyExactReplacements(
        document.getText(),
        call.arguments.replacements
      );
      if (updatedContent.length > remainingMutationCharacters) {
        throw new Error('This request reached the total file-mutation size limit.');
      }
      const changes = validateFileChanges([{
        path: call.arguments.path,
        content: updatedContent
      }]);
      const outcome = await this.confirmAndApplyFileChanges(
        changes,
        `Edit ${call.arguments.path}`,
        this.activeRequest?.signal ?? new AbortController().signal
      );
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
        .slice(0, Math.min(call.arguments.maxResults, toolSettings.listFilesMaxResults));
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
      if (
        !candidate
        || !agentPathMatches(
          normalizeRelativeWorkspacePath(candidate.relativePath),
          call.arguments.path
        )
      ) {
        throw new Error('The file does not exist or is excluded from DevMate context.');
      }
      const lines = candidate.content.split(/\r?\n/);
      const startLine = call.arguments.startLine ?? 1;
      const requestedEndLine = call.arguments.endLine
        ?? startLine + toolSettings.readFileMaxLines - 1;
      if (requestedEndLine - startLine + 1 > toolSettings.readFileMaxLines) {
        throw new Error(
          `read_file is configured to return at most ${toolSettings.readFileMaxLines} lines per call.`
        );
      }
      const endLine = Math.min(requestedEndLine, lines.length);
      if (startLine > lines.length && lines.length > 0) {
        throw new Error(`${call.arguments.path} has only ${lines.length} lines.`);
      }
      const selectedContent = lines.slice(startLine - 1, endLine).join('\n');
      const result = truncateAgentToolResult([
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

    if (call.name === 'get_diagnostics') {
      return this.readWorkspaceDiagnostics(call, folder);
    }

    if (call.name === 'get_symbols') {
      return this.readDocumentSymbols(call, folder);
    }

    if (call.name === 'find_definition' || call.name === 'find_references') {
      return this.findCodeLocations(call, folder);
    }

    if (call.name === 'read_terminal_errors') {
      const maxResults = Math.min(
        call.arguments.maxResults,
        toolSettings.terminalErrorsMaxResults
      );
      const available = Math.min(maxResults, this.recentTerminalErrors.length);
      return {
        result: formatCapturedTerminalErrors(
          this.recentTerminalErrors,
          maxResults
        ),
        resultSummary: `${available} recent terminal ${available === 1 ? 'failure' : 'failures'}`,
        usedFiles: [],
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
    const matches: string[] = [];
    const usedFiles = new Set<string>();
    const maxSearchResults = Math.min(
      call.arguments.maxResults,
      toolSettings.searchCodeMaxResults
    );
    const batchSize = 20;
    for (let offset = 0; offset < uris.length && matches.length < maxSearchResults; offset += batchSize) {
      const candidates = await Promise.all(
        uris.slice(offset, offset + batchSize).map((uri) => this.readProjectCandidate(uri))
      );
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
          if (matches.length >= maxSearchResults) {
            break;
          }
        }
        if (matches.length >= maxSearchResults) {
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

  private readWorkspaceDiagnostics(
    call: Extract<ParsedAgentToolCall, { name: 'get_diagnostics' }>,
    folder: vscode.WorkspaceFolder
  ): {
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
  } {
    const maxResults = Math.min(
      call.arguments.maxResults,
      this.getAgentToolSettings().diagnosticsMaxResults
    );
    const diagnostics: Array<{
      severity: vscode.DiagnosticSeverity;
      path: string;
      line: number;
      column: number;
      source?: string;
      code?: string;
      message: string;
    }> = [];

    for (const [uri, fileDiagnostics] of vscode.languages.getDiagnostics()) {
      const diagnosticFolder = vscode.workspace.getWorkspaceFolder(uri);
      if (!diagnosticFolder || diagnosticFolder.uri.toString() !== folder.uri.toString()) {
        continue;
      }
      const relativePath = normalizeRelativeWorkspacePath(
        vscode.workspace.asRelativePath(uri, false)
      );
      if (shouldSkipProjectFile(relativePath)) {
        continue;
      }
      if (
        call.arguments.path
        && !agentPathMatches(relativePath, call.arguments.path)
        && !agentPathStartsWith(relativePath, call.arguments.path)
      ) {
        continue;
      }
      for (const diagnostic of fileDiagnostics) {
        if (
          diagnostic.severity !== vscode.DiagnosticSeverity.Error
          && diagnostic.severity !== vscode.DiagnosticSeverity.Warning
        ) {
          continue;
        }
        const rawCode = typeof diagnostic.code === 'object'
          ? diagnostic.code.value
          : diagnostic.code;
        diagnostics.push({
          severity: diagnostic.severity,
          path: relativePath,
          line: diagnostic.range.start.line + 1,
          column: diagnostic.range.start.character + 1,
          source: diagnostic.source,
          code: rawCode === undefined ? undefined : String(rawCode),
          message: diagnostic.message
            .replace(/[\u0000-\u001f\u007f]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 500)
        });
      }
    }

    diagnostics.sort((left, right) => left.severity - right.severity
      || left.path.localeCompare(right.path)
      || left.line - right.line
      || left.column - right.column);
    const selected = diagnostics.slice(0, maxResults);
    const errors = selected.filter((item) => item.severity === vscode.DiagnosticSeverity.Error).length;
    const warnings = selected.length - errors;
    const result = selected.length === 0
      ? `No VS Code errors or warnings were found${call.arguments.path ? ` under ${call.arguments.path}` : ' in the workspace'}.`
      : [
        `VS Code Problems (${selected.length}${diagnostics.length > selected.length ? ` of ${diagnostics.length}` : ''}):`,
        ...selected.map((item) => {
          const severity = item.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
          const owner = [item.source, item.code].filter(Boolean).join(' ');
          return `[${severity}] ${item.path}:${item.line}:${item.column}${owner ? ` (${owner})` : ''} ${item.message}`;
        })
      ].join('\n');
    return {
      result: truncateAgentToolResult(result),
      resultSummary: `${errors} ${errors === 1 ? 'error' : 'errors'}, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`,
      usedFiles: [],
      mutationCharacters: 0
    };
  }

  private async readDocumentSymbols(
    call: Extract<ParsedAgentToolCall, { name: 'get_symbols' }>,
    folder: vscode.WorkspaceFolder
  ): Promise<{
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
  }> {
    const source = await this.openCodeNavigationSource(folder, call.arguments.path);
    const configuredLimit = this.getAgentToolSettings().codeNavigationMaxResults;
    const maxResults = Math.min(call.arguments.maxResults, configuredLimit);
    const provided = await vscode.commands.executeCommand<
      Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined
    >('vscode.executeDocumentSymbolProvider', source.document.uri);
    const rows: string[] = [];

    const visit = (
      symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>,
      containers: string[] = []
    ): void => {
      for (const symbol of symbols) {
        if (rows.length >= maxResults) {
          return;
        }
        if (isDocumentSymbol(symbol)) {
          const container = containers.join('.');
          rows.push(formatSymbolResult(
            symbol.kind,
            symbol.name,
            call.arguments.path,
            symbol.selectionRange.start,
            container
          ));
          visit(symbol.children, [...containers, symbol.name]);
          continue;
        }
        const location = this.workspaceCodeLocation(
          folder,
          symbol.location.uri,
          symbol.location.range
        );
        if (!location) {
          continue;
        }
        rows.push(formatSymbolResult(
          symbol.kind,
          symbol.name,
          location.path,
          new vscode.Position(location.line - 1, location.column - 1),
          symbol.containerName
        ));
      }
    };
    visit(Array.isArray(provided) ? provided : []);

    const result = rows.length > 0
      ? `Symbols in ${call.arguments.path} (${rows.length}):\n${rows.join('\n')}`
      : `No document symbols were available for ${call.arguments.path}.`;
    return {
      result: truncateAgentToolResult(result),
      resultSummary: `${rows.length} ${rows.length === 1 ? 'symbol' : 'symbols'}`,
      usedFiles: [source.filePath],
      mutationCharacters: 0
    };
  }

  private async findCodeLocations(
    call: Extract<ParsedAgentToolCall, { name: 'find_definition' | 'find_references' }>,
    folder: vscode.WorkspaceFolder
  ): Promise<{
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
  }> {
    const source = await this.openCodeNavigationSource(
      folder,
      call.arguments.path,
      call.arguments.line,
      call.arguments.column
    );
    const position = new vscode.Position(call.arguments.line - 1, call.arguments.column - 1);
    const provided = call.name === 'find_definition'
      ? await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(
          'vscode.executeDefinitionProvider',
          source.document.uri,
          position
        )
      : await vscode.commands.executeCommand<vscode.Location[] | undefined>(
          'vscode.executeReferenceProvider',
          source.document.uri,
          position
        );
    const configuredLimit = this.getAgentToolSettings().codeNavigationMaxResults;
    const maxResults = Math.min(call.arguments.maxResults, configuredLimit);
    const locations: WorkspaceCodeLocation[] = [];
    const seen = new Set<string>();
    for (const rawLocation of Array.isArray(provided) ? provided : []) {
      const providerLocation = codeLocationFromProvider(rawLocation);
      if (!providerLocation) {
        continue;
      }
      const location = this.workspaceCodeLocation(
        folder,
        providerLocation.uri,
        providerLocation.range
      );
      if (!location) {
        continue;
      }
      const signature = `${this.fileChangePathKey(location.path)}:${location.line}:${location.column}`;
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      locations.push(location);
      if (locations.length >= maxResults) {
        break;
      }
    }

    const noun = call.name === 'find_definition' ? 'definition' : 'reference';
    const sourceLabel = `${call.arguments.path}:${call.arguments.line}:${call.arguments.column}`;
    const result = locations.length > 0
      ? `${noun === 'definition' ? 'Definitions' : 'References'} for ${sourceLabel} (${locations.length}):\n`
        + locations.map((location) => `${location.path}:${location.line}:${location.column}`).join('\n')
      : `No workspace ${noun}s were found for ${sourceLabel}.`;
    return {
      result: truncateAgentToolResult(result),
      resultSummary: `${locations.length} ${locations.length === 1 ? noun : `${noun}s`}`,
      usedFiles: [
        source.filePath,
        ...locations.map((location) => location.filePath)
      ].filter((value, index, values) => values.indexOf(value) === index).slice(0, 20),
      mutationCharacters: 0
    };
  }

  private async openCodeNavigationSource(
    folder: vscode.WorkspaceFolder,
    relativePath: string,
    line?: number,
    column?: number
  ): Promise<{ document: vscode.TextDocument; filePath: string }> {
    await this.assertNoWorkspaceSymlink(folder, relativePath, false);
    const uri = vscode.Uri.joinPath(folder.uri, ...relativePath.split('/'));
    const candidate = await this.readProjectCandidate(uri);
    if (
      !candidate
      || !agentPathMatches(normalizeRelativeWorkspacePath(candidate.relativePath), relativePath)
    ) {
      throw new Error('The code-navigation source does not exist or is excluded from DevMate context.');
    }
    const document = await vscode.workspace.openTextDocument(uri);
    if (line !== undefined) {
      if (line > document.lineCount) {
        throw new Error(`${relativePath} has only ${document.lineCount} lines.`);
      }
      const lineLength = document.lineAt(line - 1).text.length;
      if (column === undefined || column > lineLength + 1) {
        throw new Error(`Column ${column ?? ''} is outside line ${line} in ${relativePath}.`);
      }
    }
    return { document, filePath: candidate.filePath };
  }

  private workspaceCodeLocation(
    folder: vscode.WorkspaceFolder,
    uri: vscode.Uri,
    range: vscode.Range
  ): WorkspaceCodeLocation | undefined {
    const locationFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!locationFolder || locationFolder.uri.toString() !== folder.uri.toString()) {
      return undefined;
    }
    const relativePath = normalizeRelativeWorkspacePath(vscode.workspace.asRelativePath(uri, false));
    if (shouldSkipProjectFile(relativePath)) {
      return undefined;
    }
    return {
      path: relativePath,
      line: range.start.line + 1,
      column: range.start.character + 1,
      filePath: uri.scheme === 'file' ? uri.fsPath : uri.toString()
    };
  }

  private async deleteAgentFile(
    call: Extract<ParsedAgentToolCall, { name: 'delete_file' }>,
    folder: vscode.WorkspaceFolder,
    remainingMutationCharacters: number
  ): Promise<{
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
    mutationApplied: boolean;
  }> {
    this.assertTrustedFileLifecycle();
    const source = await this.inspectAgentLifecycleFile(folder, call.arguments.path);
    if (source.content.length > remainingMutationCharacters) {
      throw new Error('This request reached the total file-mutation size limit.');
    }
    this.postStatus('Waiting for permission');
    const allowed = await this.requestFileChangePermission(
      `Delete ${call.arguments.path}`,
      [{
        path: call.arguments.path,
        operation: 'delete',
        originalContent: source.content,
        proposedContent: ''
      }]
    );
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
    this.rememberCompletedFileDiff(call.arguments.path, source.content, '');
    return {
      result: `Applied file changes:\n- Deleted ${call.arguments.path}`,
      resultSummary: `Deleted ${call.arguments.path}`,
      usedFiles: [source.displayPath],
      mutationCharacters: source.content.length,
      mutationApplied: true
    };
  }

  private async relocateAgentFile(
    call: Extract<ParsedAgentToolCall, { name: 'rename_file' | 'move_file' }>,
    folder: vscode.WorkspaceFolder
  ): Promise<{
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
    mutationApplied: boolean;
  }> {
    this.assertTrustedFileLifecycle();
    const source = await this.inspectAgentLifecycleFile(folder, call.arguments.path);
    await this.assertNoWorkspaceSymlink(folder, call.arguments.newPath, true);
    const destinationUri = vscode.Uri.joinPath(folder.uri, ...call.arguments.newPath.split('/'));
    await this.assertAgentLifecycleDestinationAvailable(destinationUri, call.arguments.newPath);
    const operation = call.name === 'rename_file' ? 'rename' as const : 'move' as const;
    const operationLabel = operation === 'rename' ? 'Rename' : 'Move';

    this.postStatus('Waiting for permission');
    const allowed = await this.requestFileChangePermission(
      `${operationLabel} ${call.arguments.path} to ${call.arguments.newPath}`,
      [{
        path: `${call.arguments.path} → ${call.arguments.newPath}`,
        operation,
        originalContent: source.content,
        proposedContent: source.content
      }]
    );
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
    this.rememberCompletedFileDiff(
      call.arguments.newPath,
      source.content,
      source.content,
      call.arguments.path
    );

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
    } catch {
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

  private assertTrustedFileLifecycle(): void {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before allowing DevMate to delete, rename, or move files.');
    }
  }

  private async inspectAgentLifecycleFile(
    folder: vscode.WorkspaceFolder,
    relativePath: string
  ): Promise<{
    path: string;
    uri: vscode.Uri;
    displayPath: string;
    content: string;
  }> {
    await this.assertNoWorkspaceSymlink(folder, relativePath, false);
    const uri = vscode.Uri.joinPath(folder.uri, ...relativePath.split('/'));
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      throw new Error(`${relativePath} does not exist or cannot be inspected.`);
    }
    if ((stat.type & vscode.FileType.File) === 0) {
      throw new Error(`${relativePath} is not a file. Recursive directory operations are blocked.`);
    }
    if (stat.size > MAX_PROJECT_FILE_BYTES) {
      throw new Error(`${relativePath} exceeds the file-size limit.`);
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (containsBinaryData(bytes)) {
      throw new Error(`DevMate will not change binary content at ${relativePath}.`);
    }
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty) {
      throw new Error(`Save or discard your unsaved changes in ${relativePath} before DevMate changes it.`);
    }
    const content = document.getText();
    if (content.length > MAX_FILE_CHANGE_CHARACTERS) {
      throw new Error(`${relativePath} exceeds the per-file change limit.`);
    }
    return {
      path: relativePath,
      uri,
      displayPath: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
      content
    };
  }

  private async revalidateAgentLifecycleFile(source: {
    path: string;
    uri: vscode.Uri;
    content: string;
  }): Promise<void> {
    let document: vscode.TextDocument;
    try {
      const stat = await vscode.workspace.fs.stat(source.uri);
      if ((stat.type & vscode.FileType.File) === 0) {
        throw new Error('The source is no longer a file.');
      }
      document = await vscode.workspace.openTextDocument(source.uri);
    } catch {
      throw new Error(`${source.path} changed while permission was pending. Review the request again.`);
    }
    if (document.isDirty || document.getText() !== source.content) {
      throw new Error(`${source.path} changed while permission was pending. Review the request again.`);
    }
  }

  private async assertAgentLifecycleDestinationAvailable(
    uri: vscode.Uri,
    relativePath: string
  ): Promise<void> {
    try {
      await vscode.workspace.fs.stat(uri);
      throw new Error(`${relativePath} already exists; choose a different destination.`);
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
        throw error;
      }
    }
  }

  private async runVerificationCommand(
    call: Extract<ParsedAgentToolCall, { name: 'run_command' }>,
    folder: vscode.WorkspaceFolder
  ): Promise<{
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
    commandAttempted: boolean;
  }> {
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
      await this.assertNoWorkspaceSymlink(
        folder,
        [call.arguments.cwd, call.arguments.executable.slice(2)].filter(Boolean).join('/'),
        false
      );
    }
    try {
      const stat = await vscode.workspace.fs.stat(cwdUri);
      if ((stat.type & vscode.FileType.Directory) === 0) {
        throw new Error('The command working directory is not a directory.');
      }
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? `Cannot use the command working directory: ${error.message}`
          : 'Cannot use the command working directory.'
      );
    }

    const requestedCommand: ValidatedCommand = call.arguments;
    const resolvedPython = await this.resolveWorkspacePythonCommand(requestedCommand, folder);
    const command = resolvedPython.command;
    const requestedLabel = commandLabel(requestedCommand);
    const label = resolvedPython.environment
      ? `${requestedLabel} · ${resolvedPython.environment}`
      : requestedLabel;
    const signature = commandSignature(command);
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

    const configuredTimeout = vscode.workspace.getConfiguration('devMate').get<number>(
      'commandTimeoutSeconds',
      DEFAULT_COMMAND_TIMEOUT_SECONDS
    );
    const timeoutSeconds = Math.min(
      command.timeoutSeconds,
      MAX_COMMAND_TIMEOUT_SECONDS,
      Math.max(MIN_COMMAND_TIMEOUT_SECONDS, configuredTimeout)
    );
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
        output = sanitizeCommandOutput(output + data);
        this.postAgentToolActivity(
          call.id,
          'Running verification command',
          label,
          'running',
          output,
          true
        );
      }
    })();

    const outcome = await new Promise<{
      state: 'completed' | 'cancelled' | 'timeout';
      exitCode?: number;
    }>((resolve) => {
      let settled = false;
      const finish = (value: { state: 'completed' | 'cancelled' | 'timeout'; exitCode?: number }) => {
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
    const modelOutput = boundedModelCommandOutput(output);
    const result = [
      `Command: ${requestedLabel}`,
      ...(isPythonVerificationCommand(requestedCommand)
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
      throw new StartedCommandError(
        result,
        extractMissingPythonModule(modelOutput),
        resolvedPython.environment
      );
    }
    return {
      result,
      resultSummary: `Passed in ${durationSeconds.toFixed(1)}s`,
      usedFiles: [],
      mutationCharacters: 0,
      commandAttempted: true
    };
  }

  private async runDependencyInstallation(
    call: Extract<ParsedAgentToolCall, { name: 'install_dependencies' }>,
    folder: vscode.WorkspaceFolder
  ): Promise<{
    result: string;
    resultSummary: string;
    usedFiles: string[];
    mutationCharacters: number;
    installAttempted: boolean;
    environmentChanged: boolean;
  }> {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before allowing DevMate to install dependencies.');
    }
    if (folder.uri.scheme !== 'file') {
      throw new Error('Python dependency installation currently requires a local filesystem workspace.');
    }
    const initialManifest = await this.readDependencyManifest(
      folder,
      call.arguments.manifestPath
    );
    const cwdUri = call.arguments.cwd
      ? vscode.Uri.joinPath(folder.uri, ...call.arguments.cwd.split('/'))
      : folder.uri;
    const probeCommand: ValidatedCommand = {
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
        throw new Error(
          `${targetEnvironment} already exists but does not contain a supported Python interpreter. `
          + 'Repair or remove it manually before installing dependencies.'
        );
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
          throw error;
        }
      }
    }

    const environmentLabel = existingPython.environment ?? targetEnvironment;
    const requirementSummary = initialManifest.requirements.length === 1
      ? initialManifest.requirements[0]
      : `${initialManifest.requirements.length} requirements`;
    const allowed = await this.requestCommandPermission(
      randomUUID(),
      `${willCreateEnvironment ? `Create ${targetEnvironment} and install` : 'Install'} ${requirementSummary} from ${call.arguments.manifestPath}`,
      call.arguments.cwd,
      {
        rememberable: false,
        title: 'Permission required to install Python dependencies',
        warning: 'This downloads packages and may execute package build or installation code. Installation is restricted to the validated manifest and project-local virtual environment.'
      }
    );
    if (!allowed) {
      throw new Error('Permission to install dependencies was denied.');
    }
    if (!vscode.workspace.isTrusted) {
      throw new Error('Workspace Trust changed while installation permission was pending; nothing was installed.');
    }
    const currentManifest = await this.readDependencyManifest(
      folder,
      call.arguments.manifestPath
    );
    if (currentManifest.content !== initialManifest.content) {
      throw new Error('The dependency manifest changed during approval; review the updated file and try again.');
    }

    let approvedPython = existingPython;
    if (willCreateEnvironment) {
      const targetUri = vscode.Uri.joinPath(folder.uri, ...targetEnvironment.split('/'));
      try {
        await vscode.workspace.fs.stat(targetUri);
        throw new Error(
          `${targetEnvironment} appeared during approval; inspect it before trying again.`
        );
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
          throw error;
        }
      }
    } else {
      approvedPython = await this.resolveWorkspacePythonCommand(probeCommand, folder);
      if (approvedPython.environment !== existingPython.environment) {
        throw new Error('The selected Python environment changed during approval; inspect it and try again.');
      }
    }

    const signal = this.activeRequest?.signal ?? new AbortController().signal;
    if (signal.aborted) {
      throw new Error('The dependency installation was cancelled.');
    }
    const configuredTimeout = vscode.workspace.getConfiguration('devMate').get<number>(
      'commandTimeoutSeconds',
      DEFAULT_COMMAND_TIMEOUT_SECONDS
    );
    const timeoutSeconds = Math.min(
      call.arguments.timeoutSeconds,
      MAX_COMMAND_TIMEOUT_SECONDS,
      Math.max(MIN_COMMAND_TIMEOUT_SECONDS, configuredTimeout)
    );
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
    const runStep = async (executable: string, args: string[], label: string) => {
      const remainingMilliseconds = Math.max(1, deadline - Date.now());
      combinedOutput = sanitizeCommandOutput(`${combinedOutput}${combinedOutput ? '\n' : ''}> ${label}\n`);
      const step = await this.executeTerminalStep(
        terminal,
        shellIntegration,
        executable,
        args,
        remainingMilliseconds,
        signal,
        (output) => {
          combinedOutput = sanitizeCommandOutput(combinedOutput + output);
          this.postAgentToolActivity(
            call.id,
            'Installing Python dependencies',
            `${call.arguments.manifestPath} → ${environmentLabel}`,
            'running',
            combinedOutput,
            true
          );
        }
      );
      if (step.state === 'cancelled') {
        this.commandTerminals.delete(call.id);
        throw new StartedDependencyInstallError('The dependency installation was cancelled.');
      }
      if (step.state === 'timeout') {
        this.commandTerminals.delete(call.id);
        throw new StartedDependencyInstallError(
          `Dependency installation timed out after ${timeoutSeconds} seconds.\n\n${boundedModelCommandOutput(combinedOutput)}`
        );
      }
      if (step.exitCode !== 0) {
        throw new StartedDependencyInstallError([
          `${label} failed with exit code ${step.exitCode ?? 'unknown'}.`,
          boundedModelCommandOutput(combinedOutput)
        ].join('\n\n'));
      }
    };

    let pythonExecutable = approvedPython.command.executable;
    if (willCreateEnvironment) {
      const launcher = process.platform === 'win32' ? 'py' : 'python3';
      await runStep(launcher, ['-m', 'venv', '.venv'], `${launcher} -m venv .venv`);
      const createdCandidate = workspacePythonCandidates(call.arguments.cwd)[0];
      await this.assertNoWorkspaceSymlink(folder, createdCandidate, false);
      const createdUri = vscode.Uri.joinPath(folder.uri, ...createdCandidate.split('/'));
      const createdStat = await vscode.workspace.fs.stat(createdUri);
      if ((createdStat.type & vscode.FileType.File) === 0) {
        throw new StartedDependencyInstallError('The virtual environment was created without a usable Python interpreter.');
      }
      pythonExecutable = workspacePythonExecutable(createdCandidate, call.arguments.cwd);
    }

    const manifestName = path.posix.basename(call.arguments.manifestPath);
    await runStep(
      pythonExecutable,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', manifestName],
      `${environmentLabel} -m pip install -r ${manifestName}`
    );
    const durationSeconds = Math.max(0, (Date.now() - startedAt) / 1_000);
    const result = [
      `Manifest: ${call.arguments.manifestPath}`,
      `Python environment: ${environmentLabel}`,
      `Installed requirements: ${initialManifest.requirements.join(', ')}`,
      `Duration: ${durationSeconds.toFixed(1)} seconds`,
      boundedModelCommandOutput(combinedOutput)
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

  private async readDependencyManifest(
    folder: vscode.WorkspaceFolder,
    manifestPath: string
  ): Promise<{ uri: vscode.Uri; content: string; requirements: string[] }> {
    await this.assertNoWorkspaceSymlink(folder, manifestPath, false);
    const uri = vscode.Uri.joinPath(folder.uri, ...manifestPath.split('/'));
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString()
    );
    if (openDocument?.isDirty) {
      throw new Error(`Save or discard your unsaved changes in ${manifestPath} before installing dependencies.`);
    }
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.File) === 0 || stat.size > MAX_DEPENDENCY_MANIFEST_BYTES) {
      throw new Error('The dependency manifest is not a supported text file or exceeds 64 KB.');
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (containsBinaryData(bytes)) {
      throw new Error('The dependency manifest contains binary data.');
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('The dependency manifest must be valid UTF-8 text.');
    }
    return {
      uri,
      content,
      requirements: validatePythonRequirementsManifest(content)
    };
  }

  private async executeTerminalStep(
    terminal: vscode.Terminal,
    shellIntegration: vscode.TerminalShellIntegration,
    executable: string,
    args: string[],
    timeoutMilliseconds: number,
    signal: AbortSignal,
    onOutput: (output: string) => void
  ): Promise<{ state: 'completed' | 'cancelled' | 'timeout'; exitCode?: number }> {
    const execution = shellIntegration.executeCommand(executable, args);
    const outputReader = (async () => {
      for await (const data of execution.read()) {
        onOutput(data);
      }
    })();
    const outcome = await new Promise<{
      state: 'completed' | 'cancelled' | 'timeout';
      exitCode?: number;
    }>((resolve) => {
      let settled = false;
      const finish = (value: { state: 'completed' | 'cancelled' | 'timeout'; exitCode?: number }) => {
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

  private async resolveWorkspacePythonCommand(
    command: ValidatedCommand,
    folder: vscode.WorkspaceFolder
  ): Promise<{ command: ValidatedCommand; environment?: string }> {
    if (!isPythonVerificationCommand(command) || folder.uri.scheme !== 'file') {
      return { command };
    }
    for (const candidate of workspacePythonCandidates(command.cwd)) {
      try {
        await this.assertNoWorkspaceSymlink(folder, candidate, false);
        const uri = vscode.Uri.joinPath(folder.uri, ...candidate.split('/'));
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.File) !== 0) {
          return {
            command: {
              ...command,
              executable: workspacePythonExecutable(candidate, command.cwd)
            },
            environment: candidate
          };
        }
      } catch {
        // Missing, inaccessible, and symbolic-link environments are ignored safely.
      }
    }
    return { command };
  }

  private captureWorkspaceTerminalExecution(
    event: vscode.TerminalShellExecutionStartEvent
  ): void {
    if (event.terminal.name.startsWith('DevMate:')) {
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    const cwd = event.execution.cwd;
    if (!folder || !cwd) {
      return;
    }
    const cwdWorkspace = vscode.workspace.getWorkspaceFolder(cwd);
    if (!cwdWorkspace || cwdWorkspace.uri.toString() !== folder.uri.toString()) {
      return;
    }

    const capture: ActiveTerminalCapture = {
      command: sanitizeCapturedTerminalText(event.execution.commandLine.value),
      cwd: normalizeRelativeWorkspacePath(vscode.workspace.asRelativePath(cwd, false)),
      terminalName: sanitizeCapturedTerminalText(event.terminal.name),
      output: ''
    };
    this.activeTerminalCaptures.set(event.execution, capture);
    capture.reader = (async () => {
      try {
        for await (const data of event.execution.read()) {
          capture.output = sanitizeCapturedTerminalText(capture.output + data);
        }
      } catch {
        // Terminal output is optional context. Failed capture must not affect the terminal.
      }
    })();
  }

  private async finishWorkspaceTerminalExecution(
    event: vscode.TerminalShellExecutionEndEvent
  ): Promise<void> {
    const capture = this.activeTerminalCaptures.get(event.execution);
    if (!capture) {
      return;
    }
    this.activeTerminalCaptures.delete(event.execution);
    if (capture.reader) {
      await Promise.race([capture.reader, wait(250)]);
    }
    if (event.exitCode === undefined || event.exitCode === 0) {
      return;
    }

    this.recentTerminalErrors.unshift({
      command: sanitizeCapturedTerminalText(event.execution.commandLine.value) || capture.command,
      cwd: capture.cwd,
      terminalName: capture.terminalName,
      exitCode: event.exitCode,
      output: sanitizeCapturedTerminalText(capture.output),
      capturedAt: Date.now()
    });
    this.recentTerminalErrors.splice(MAX_CAPTURED_TERMINAL_ERRORS);
  }

  private waitForShellIntegration(
    terminal: vscode.Terminal,
    signal: AbortSignal
  ): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration) {
      return Promise.resolve(terminal.shellIntegration);
    }
    return new Promise((resolve) => {
      const finish = (integration?: vscode.TerminalShellIntegration) => {
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

  private disposeCommandTerminals(): void {
    for (const terminal of this.commandTerminals.values()) {
      terminal.dispose();
    }
    this.commandTerminals.clear();
  }

  private async findAgentFiles(
    folder: vscode.WorkspaceFolder,
    requestedPath: string
  ): Promise<vscode.Uri[]> {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*'),
      PROJECT_EXCLUDE_GLOB,
      MAX_ATTACHMENT_CANDIDATES
    );
    return uris
      .filter((uri) => {
        const relativePath = normalizeRelativeWorkspacePath(
          vscode.workspace.asRelativePath(uri, false)
        );
        return !shouldSkipProjectFile(relativePath)
          && (!requestedPath
            || agentPathMatches(relativePath, requestedPath)
            || agentPathStartsWith(relativePath, requestedPath));
      })
      .sort((left, right) => vscode.workspace.asRelativePath(left, false).localeCompare(
        vscode.workspace.asRelativePath(right, false)
      ))
      .slice(0, MAX_PROJECT_CANDIDATES);
  }

  private async assertNoWorkspaceSymlink(
    folder: vscode.WorkspaceFolder,
    relativePath: string,
    allowMissing: boolean
  ): Promise<void> {
    const segments = relativePath.split('/').filter(Boolean);
    for (let index = 1; index <= segments.length; index += 1) {
      const uri = vscode.Uri.joinPath(folder.uri, ...segments.slice(0, index));
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
          throw new Error(`DevMate will not use the symbolic-link path ${segments.slice(0, index).join('/')}.`);
        }
      } catch (error) {
        if (allowMissing && error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
          return;
        }
        throw error;
      }
    }
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

  private enabledAgentTools(
    mode: AssistantMode,
    fileMutationCalls: number,
    commandCalls: number,
    dependencyInstallCalls: number
  ): AgentToolName[] {
    const tools: AgentToolName[] = [...READ_ONLY_AGENT_TOOL_NAMES];
    if (mode === 'ideas' || !vscode.workspace.isTrusted) {
      return tools;
    }
    if (fileMutationCalls < MAX_AGENT_FILE_MUTATIONS) {
      tools.push(...FILE_MUTATION_AGENT_TOOL_NAMES);
    }
    if (dependencyInstallCalls < MAX_AGENT_DEPENDENCY_INSTALLS) {
      tools.push('install_dependencies');
    }
    if (commandCalls < MAX_AGENT_COMMAND_CALLS) {
      tools.push('run_command');
    }
    return tools;
  }

  private rejectedToolExecution(call: AgentToolCall, result: string): AgentToolExecution {
    let historyArguments = boundedAgentToolHistoryArguments(call.name, call.arguments);
    try {
      historyArguments = summarizedAgentToolArguments(parseAgentToolCall(call));
    } catch {
      // Keep the provider's bounded raw arguments for an invalid call.
    }
    this.postAgentToolActivity(
      call.id,
      'Tool request rejected',
      call.name,
      'error',
      result
    );
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

  private async askWithProviderRetries(
    backendUrl: string,
    request: AskRequest,
    providerApiKey: string | undefined,
    timeoutMilliseconds: number,
    signal: AbortSignal,
    onTokenUsage?: (usage: TokenUsage) => void
  ): Promise<{ result: ApiResult<AskResponse>; retriesExhausted: boolean }> {
    let retryNumber = 0;
    while (true) {
      this.postMessage({ command: 'providerStreamReset' });
      const waitingTimer = setTimeout(() => {
        this.postStatus('Waiting for model response — the selected model is still working');
      }, 15_000);
      let receivedStreamText = false;
      let pendingStreamText = '';
      let streamedOutputCharacters = 0;
      let currentUsage: TokenUsage | undefined;
      let streamFlushTimer: NodeJS.Timeout | undefined;
      const flushStreamText = () => {
        if (!pendingStreamText) {
          return;
        }
        this.postMessage({ command: 'providerStreamDelta', text: pendingStreamText });
        streamedOutputCharacters += pendingStreamText.length;
        pendingStreamText = '';
        if (currentUsage) {
          const outputTokens = Math.max(
            currentUsage.outputTokens,
            estimatedTokenCount(streamedOutputCharacters)
          );
          onTokenUsage?.({
            inputTokens: currentUsage.inputTokens,
            outputTokens,
            totalTokens: currentUsage.inputTokens + outputTokens,
            exact: false
          });
        }
      };
      let result: ApiResult<AskResponse>;
      try {
        const streamAttempt = await askStream(
          backendUrl,
          request,
          providerApiKey,
          timeoutMilliseconds,
          signal,
          (event) => {
            clearTimeout(waitingTimer);
            if (event.type === 'usage') {
              currentUsage = event.usage;
              onTokenUsage?.(event.usage);
            } else if (event.type === 'delta') {
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
            } else {
              this.postStatus(event.phase);
            }
          }
        );
        if (streamAttempt.unsupported) {
          this.postStatus('Live streaming unavailable — waiting for the completed response');
          result = await ask(
            backendUrl,
            request,
            providerApiKey,
            timeoutMilliseconds,
            signal
          );
          if (
            result.status === 'ok'
            && result.data?.answer
            && (result.data.toolCalls?.length ?? 0) === 0
          ) {
            receivedStreamText = true;
            this.postStatus('Receiving model response');
            pendingStreamText += result.data.answer;
          }
        } else {
          result = streamAttempt.result;
        }
      } finally {
        clearTimeout(waitingTimer);
        if (streamFlushTimer) {
          clearTimeout(streamFlushTimer);
        }
        flushStreamText();
      }
      if (!isRetryableProviderFailure(result)) {
        return { result, retriesExhausted: false };
      }

      retryNumber += 1;
      const delay = providerRetryDelay(retryNumber);
      if (delay === undefined) {
        return { result, retriesExhausted: true };
      }
      this.postStatus(
        `Provider busy — retrying ${retryNumber}/${PROVIDER_RETRY_DELAYS_MS.length} in ${delay / 1_000}s`
      );
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
    if (!activeSession || !sessionBelongsToWorkspace(activeSession, this.getConversationWorkspace())) {
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
      await this.persistSessionStore();
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

    this.postStatus('Collecting context');
    const collectedScope = await this.collectScope(message.scope.kind, question);
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

    const toolHistory: AgentToolStep[] = resumedCheckpoint
      ? [...resumedCheckpoint.toolHistory]
      : [];
    const toolUsedFiles = new Set<string>(resumedCheckpoint?.toolUsedFiles ?? []);
    const toolSignatures = new Map<string, { revision: number; executions: number }>(
      resumedCheckpoint?.toolSignatures.map((item) => [
        item.signature,
        { revision: item.revision, executions: item.executions }
      ]) ?? []
    );
    let fileMutationCalls = resumedCheckpoint?.fileMutationCalls ?? 0;
    let mutationCharacters = resumedCheckpoint?.mutationCharacters ?? 0;
    let commandCalls = resumedCheckpoint?.commandCalls ?? 0;
    let dependencyInstallCalls = resumedCheckpoint?.dependencyInstallCalls ?? 0;
    let workspaceRevision = resumedCheckpoint
      ? Math.min(200, resumedCheckpoint.workspaceRevision + 1)
      : 0;
    let forceFinalAnswer = resumedCheckpoint?.forceFinalAnswer ?? false;
    let disableThinking = resumedCheckpoint?.disableThinking ?? false;
    let emptyResponseRecoveryAttempted = resumedCheckpoint?.emptyResponseRecoveryAttempted ?? false;
    let completedTokenUsage: TokenUsage = resumedCheckpoint
      ? {
        inputTokens: resumedCheckpoint.inputTokens,
        outputTokens: resumedCheckpoint.outputTokens,
        totalTokens: resumedCheckpoint.totalTokens,
        exact: resumedCheckpoint.tokenUsageExact
      }
      : { inputTokens: 0, outputTokens: 0, totalTokens: 0, exact: true };
    const checkpointCreatedAt = resumedCheckpoint?.createdAt ?? Date.now();
    const persistCheckpoint = async () => {
      const workspace = this.getConversationWorkspace();
      if (!workspace) {
        return;
      }
      await this.saveAgentCheckpoint({
        version: 1,
        workspaceId: workspace.id,
        sessionId: activeSession.id,
        question,
        mode: message.mode,
        scopeKind: message.scope.kind,
        toolHistory: compactAgentToolHistory(toolHistory),
        toolUsedFiles: [...toolUsedFiles].slice(-100),
        toolSignatures: [...toolSignatures].slice(-100).map(([signature, value]) => ({
          signature,
          revision: value.revision,
          executions: value.executions
        })),
        fileMutationCalls,
        mutationCharacters,
        commandCalls,
        dependencyInstallCalls,
        workspaceRevision,
        forceFinalAnswer,
        disableThinking,
        emptyResponseRecoveryAttempted,
        inputTokens: completedTokenUsage.inputTokens,
        outputTokens: completedTokenUsage.outputTokens,
        totalTokens: completedTokenUsage.totalTokens,
        tokenUsageExact: completedTokenUsage.exact,
        createdAt: checkpointCreatedAt,
        updatedAt: Date.now()
      });
    };
    let finalData: AskResponse | undefined;
    this.postMessage({
      command: 'toolUsageUpdated',
      used: toolHistory.length,
      limit: toolCallLimit
    });
    await persistCheckpoint();

    // Each pass either finishes the answer or feeds one bounded batch of tool results back to the model.
    while (!finalData) {
      if (this.finishCancelledRequest(signal)) {
        return;
      }
      const forceFinalThisTurn = forceFinalAnswer
        || toolHistory.length >= toolCallLimit;
      const enabledTools = forceFinalThisTurn
        ? []
        : this.enabledAgentTools(
          message.mode,
          fileMutationCalls,
          commandCalls,
          dependencyInstallCalls
        );
      const toolsEnabled = enabledTools.length > 0;
      const request: AskRequest = {
        question,
        mode: message.mode,
        scope: collectedScope.apiScope,
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
        enabledTools,
        agentEditsEnabled: message.mode === 'code' || message.mode === 'debug',
        forceFinalAnswer: forceFinalThisTurn,
        disableThinking: disableThinking || forceFinalThisTurn,
        toolHistory: compactAgentToolHistory(toolHistory),
        conversationHistory: activeSessionModelHistory(this.sessionStore)
      };
      this.postStatus(forceFinalThisTurn
        ? 'Requesting concise final answer'
        : toolsEnabled && toolHistory.length > 0
          ? 'Continuing with project context'
          : 'Generating answer');

      const providerAttempt = await this.askWithProviderRetries(
        getBackendUrl(),
        request,
        providerApiKey,
        (modelTimeoutSeconds + 30) * 1_000,
        signal,
        (currentUsage) => {
          this.postMessage({
            command: 'tokenUsageUpdated',
            usage: addTokenUsage(completedTokenUsage, currentUsage)
          });
        }
      );
      const result = providerAttempt.result;
      if (this.finishCancelledRequest(signal)) {
        return;
      }
      if (result.status === 'error' || !result.data) {
        const errorMessage = result.message ?? 'Ask request failed.';
        if (
          forceFinalThisTurn
          && toolHistory.length > 0
          && result.errorKind !== 'network'
          && result.errorKind !== 'timeout'
          && result.errorKind !== 'cancelled'
        ) {
          this.postStatus('Finalizing from completed project-tool work');
          finalData = {
            answer: summarizeAgentToolHistory(toolHistory, errorMessage),
            usedFiles: [...toolUsedFiles],
            changes: [],
            toolCalls: []
          };
          break;
        }
        const emptyRecovery = emptyResponseRecoveryAction(
          errorMessage,
          emptyResponseRecoveryAttempted,
          forceFinalThisTurn
        );
        if (emptyRecovery === 'retry-without-thinking') {
          emptyResponseRecoveryAttempted = true;
          disableThinking = true;
          this.postStatus('Model returned no final answer — retrying with reasoning disabled');
          await persistCheckpoint();
          continue;
        }
        if (emptyRecovery === 'force-final') {
          forceFinalAnswer = true;
          disableThinking = true;
          this.postStatus('Model still returned no final answer — requesting final summary without tools');
          await persistCheckpoint();
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

      if (result.data.tokenUsage) {
        completedTokenUsage = addTokenUsage(completedTokenUsage, result.data.tokenUsage);
        this.postMessage({ command: 'tokenUsageUpdated', usage: completedTokenUsage });
      }

      const toolCalls = result.data.toolCalls ?? [];
      if (
        toolCalls.length === 0
        && message.mode !== 'ideas'
        && isDeferredAgentPlanAnswer(result.data.answer)
      ) {
        const deferredMessage = 'The model described future work without performing it.';
        if (forceFinalThisTurn && toolHistory.length > 0) {
          this.postStatus('Finalizing from completed project-tool work');
          finalData = {
            answer: summarizeAgentToolHistory(toolHistory, deferredMessage),
            usedFiles: [...toolUsedFiles],
            changes: [],
            toolCalls: []
          };
          break;
        }
        if (!forceFinalThisTurn && !emptyResponseRecoveryAttempted) {
          emptyResponseRecoveryAttempted = true;
          disableThinking = true;
          this.postStatus('Model stopped before acting — retrying with project tools');
          await persistCheckpoint();
          continue;
        }
        if (!forceFinalThisTurn && toolHistory.length > 0) {
          forceFinalAnswer = true;
          this.postStatus('Model stopped before summarizing — requesting final answer without tools');
          await persistCheckpoint();
          continue;
        }
        this.postRequestFailure(
          'The selected model described what it would do but did not call a project tool. Try another model or verify that this endpoint supports tool calling.'
        );
        return;
      }
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
          ? normalizeAgentToolCallForWorkspace(rawToolCall, {
            name: workspaceFolder.name,
            fsPath: workspaceFolder.uri.scheme === 'file' ? workspaceFolder.uri.fsPath : undefined
          })
          : rawToolCall;
        if (toolHistory.some((step) => step.callId === toolCall.id)) {
          this.postRequestFailure('The model reused an invalid tool-call id.');
          return;
        }

        let signature: string | undefined;
        try {
          signature = agentToolCallSignature(toolCall);
        } catch {
          // The executor reports the validated tool error back to the model.
        }
        let execution: AgentToolExecution;
        const isFileMutation = isFileMutationAgentTool(toolCall.name);
        const isCommand = toolCall.name === 'run_command';
        const isDependencyInstall = toolCall.name === 'install_dependencies';
        const isReadOnly = isReadOnlyAgentTool(toolCall.name);
        const priorSignature = signature ? toolSignatures.get(signature) : undefined;
        const repeatedAtCurrentRevision = priorSignature?.revision === workspaceRevision;
        if (
          isReadOnly
          && consecutiveAgentInspectionCalls(toolHistory) >= MAX_AGENT_CONSECUTIVE_INSPECTIONS
        ) {
          execution = this.rejectedToolExecution(
            toolCall,
            `DevMate paused the request after ${MAX_AGENT_CONSECUTIVE_INSPECTIONS} consecutive inspection calls without a file change or verification command. Use the gathered evidence and finish concisely.`
          );
          forceFinalAnswer = true;
        } else if (isFileMutation && fileMutationCalls >= MAX_AGENT_FILE_MUTATIONS) {
          execution = this.rejectedToolExecution(
            toolCall,
            'DevMate reached the file-mutation limit for this request.'
          );
          forceFinalAnswer = true;
        } else if (isCommand && commandCalls >= MAX_AGENT_COMMAND_CALLS) {
          execution = this.rejectedToolExecution(
            toolCall,
            'DevMate reached the verification-command limit for this request.'
          );
          forceFinalAnswer = true;
        } else if (
          isDependencyInstall
          && dependencyInstallCalls >= MAX_AGENT_DEPENDENCY_INSTALLS
        ) {
          execution = this.rejectedToolExecution(
            toolCall,
            'DevMate reached the dependency-installation limit for this request.'
          );
          forceFinalAnswer = true;
        } else if (
          signature
          && priorSignature
          && (
            isFileMutation
            || isDependencyInstall
            || (repeatedAtCurrentRevision && (!isReadOnly || priorSignature.executions >= 2))
          )
        ) {
          const repeatedResult = 'This identical tool call was already completed. Use its earlier result.';
          this.postAgentToolActivity(
            toolCall.id,
            'Skipped repeated tool call',
            toolCall.name,
            'error',
            repeatedResult
          );
          execution = {
            step: {
              callId: toolCall.id,
              name: toolCall.name,
              arguments: (() => {
                try {
                  return summarizedAgentToolArguments(parseAgentToolCall(toolCall));
                } catch {
                  return boundedAgentToolHistoryArguments(toolCall.name, toolCall.arguments);
                }
              })(),
              result: repeatedResult,
              isError: true
            },
            usedFiles: [],
            mutationCharacters: 0
          };
          forceFinalAnswer = true;
        } else {
          execution = await this.executeAgentToolCall(
            toolCall,
            MAX_TOTAL_CHANGE_CHARACTERS - mutationCharacters
          );
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
          if (
            isDependencyInstall
            && execution.step.isError
            && /permission to install dependencies was denied/i.test(execution.step.result)
          ) {
            forceFinalAnswer = true;
          }
          if (
            signature
            && (!execution.step.isError || execution.commandAttempted || execution.installAttempted)
          ) {
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
        this.postMessage({
          command: 'toolUsageUpdated',
          used: toolHistory.length,
          limit: toolCallLimit
        });
        execution.usedFiles.forEach((file) => toolUsedFiles.add(file));
        await persistCheckpoint();
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
    await this.persistSessionStore();
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
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('Open a workspace folder before applying file changes.');
    }
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before allowing DevMate to change files.');
    }

    const plannedChanges = await Promise.all(
      changes.map(async (change) => {
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
        } catch (error) {
          if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
            throw new Error(
              error instanceof Error
                ? `Could not inspect ${change.path}: ${error.message}`
                : `Could not inspect ${change.path}.`
            );
          }
        }
        return { ...change, uri, exists, originalContent };
      })
    );
    const permissionFiles = plannedChanges.map((change) => ({
      path: change.path,
      operation: change.exists ? 'update' as const : 'create' as const,
      originalContent: change.originalContent,
      proposedContent: change.content
    }));
    const permissionPolicy = this.getPermissionPolicy();
    const requiresApproval = permissionFiles.some(
      (file) => permissionBehaviorForAction(permissionPolicy, file.operation) === 'ask'
    );
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
      } else {
        try {
          await vscode.workspace.fs.stat(change.uri);
          throw new Error(`${change.path} was created while permission was pending. Review the request again.`);
        } catch (error) {
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
        await vscode.workspace.fs.createDirectory(
          vscode.Uri.joinPath(folder.uri, ...parentSegments)
        );
      }
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const change of plannedChanges) {
      if (change.exists) {
        const document = await vscode.workspace.openTextDocument(change.uri);
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length)
        );
        workspaceEdit.replace(change.uri, fullRange, change.content);
      } else {
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
    for (const change of plannedChanges) {
      this.rememberCompletedFileDiff(
        change.path,
        change.originalContent,
        change.content
      );
    }

    let openNote = '';
    try {
      const primaryDocument = await vscode.workspace.openTextDocument(plannedChanges[0].uri);
      await vscode.window.showTextDocument(primaryDocument, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
        preserveFocus: false
      });
    } catch {
      openNote = '\n\nThe changes were applied, but VS Code could not open the first file.';
    }

    return [
      'Applied file changes:',
      ...plannedChanges.map((change) => `- ${change.exists ? 'Updated' : 'Created'} ${change.path}`)
    ].join('\n') + openNote;
  }

  private postStatus(text: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    this.postMessage({ command: 'status', text, level });
  }

  private postMessage(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
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

    .file-change-summary {
      display: grid;
      gap: 6px;
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid var(--border);
    }

    .file-change-summary-header {
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      color: var(--muted);
      font-size: 10px;
      font-weight: 650;
      letter-spacing: 0.02em;
    }

    .file-change-summary-counts {
      font-family: var(--vscode-editor-font-family, monospace);
      font-weight: 700;
    }

    .file-change-summary-counts .changed {
      color: var(--vscode-gitDecoration-addedResourceForeground, #2ea043);
    }

    .file-change-summary-counts .deleted {
      margin-left: 5px;
      color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
    }

    .file-change-list {
      display: grid;
      gap: 3px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .file-change-row {
      display: grid;
      grid-template-columns: 14px 52px minmax(0, 1fr);
      gap: 5px;
      align-items: baseline;
      min-width: 0;
      color: var(--vscode-gitDecoration-addedResourceForeground, #2ea043);
      font-size: 10px;
    }

    .file-change-row[data-kind="deleted"] {
      color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
    }

    .file-change-symbol,
    .file-change-operation {
      font-weight: 700;
    }

    .file-change-path {
      min-width: 0;
      padding: 0;
      overflow: hidden;
      border: 0;
      color: inherit;
      background: transparent;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: inherit;
      text-align: left;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    button.file-change-path {
      cursor: pointer;
    }

    button.file-change-path:hover {
      text-decoration: underline;
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

    .working-model {
      margin-left: auto;
      overflow: hidden;
      color: var(--muted);
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 10px;
    }

    .working-tool-usage {
      flex: 0 0 auto;
      padding: 2px 5px;
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--muted);
      font-size: 9px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .working-phases {
      display: grid;
      gap: 5px;
      margin: 0 0 9px;
      padding: 0;
      list-style: none;
    }

    .model-narration {
      width: fit-content;
      max-width: min(82%, 620px);
      padding: 7px 9px;
      font-size: 11px;
    }

    .model-narration[data-streaming="true"] .model-narration-body::after {
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

    .working-token-usage {
      margin-right: auto;
      color: var(--muted);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
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
      .working-phase[data-status="active"],
      .working-phase[data-status="active"] .working-phase-icon,
      .model-narration[data-streaming="true"] .model-narration-body::after,
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
      min-width: 0;
      height: 26px;
      padding: 0 9px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
    }

    .continue-agent-button {
      height: 26px;
      border-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      background: color-mix(in srgb, var(--vscode-button-background) 72%, transparent);
      font-weight: 600;
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

    .intelligence-control {
      position: relative;
      display: inline-flex;
      flex: 0 0 auto;
    }

    .intelligence-control[hidden] {
      display: none;
    }

    .intelligence-icon-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      padding: 0;
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 6px;
      color: var(--muted);
      background: var(--vscode-input-background);
      cursor: pointer;
    }

    .intelligence-icon-button:hover,
    .intelligence-icon-button[aria-expanded="true"] {
      border-color: var(--focus);
      color: var(--vscode-foreground);
      background: var(--vscode-list-hoverBackground);
    }

    .intelligence-icon-button span {
      font-size: 12px;
      line-height: 1;
    }

    .intelligence-menu {
      position: absolute;
      bottom: calc(100% + 7px);
      left: 0;
      z-index: 30;
      display: grid;
      gap: 3px;
      width: 164px;
      padding: 6px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.36);
    }

    .intelligence-menu[hidden] {
      display: none;
    }

    .intelligence-menu-title {
      padding: 3px 7px 5px;
      color: var(--muted);
      font-size: 9px;
      font-weight: 650;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    .intelligence-menu-options {
      display: grid;
      gap: 2px;
    }

    .intelligence-menu-option {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      min-height: 28px;
      padding: 0 7px;
      border: 0;
      border-radius: 5px;
      color: var(--vscode-foreground);
      background: transparent;
      font-size: 11px;
      text-align: left;
      cursor: pointer;
    }

    .intelligence-menu-option:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .intelligence-menu-option[aria-checked="true"] {
      color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
      background: var(--vscode-list-activeSelectionBackground);
    }

    .intelligence-menu-check {
      width: 12px;
      color: var(--vscode-list-activeSelectionForeground, var(--focus));
      font-size: 10px;
      text-align: center;
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
      align-items: center;
      justify-content: flex-end;
      padding: 12px 18px 16px;
      border-top: 1px solid var(--border);
    }

    .model-picker-dialog {
      width: min(500px, calc(100vw - 24px));
    }

    .model-picker-list {
      display: grid;
      gap: 7px;
      max-height: min(440px, 58vh);
      overflow-y: auto;
    }

    .model-picker-option {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px;
      align-items: stretch;
      padding: 5px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-soft);
    }

    .model-picker-option[data-selected="true"] {
      border-color: var(--focus);
      background: color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 36%, var(--surface-soft));
    }

    .model-picker-select {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr) auto;
      gap: 9px;
      align-items: center;
      min-width: 0;
      padding: 6px;
      border: 0;
      border-radius: 5px;
      color: var(--vscode-foreground);
      background: transparent;
      text-align: left;
      cursor: pointer;
    }

    .model-picker-select:hover,
    .model-picker-manage:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .model-picker-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 7px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .model-picker-copy {
      display: grid;
      gap: 2px;
      min-width: 0;
    }

    .model-picker-name,
    .model-picker-meta,
    .model-picker-url {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .model-picker-name {
      font-size: 12px;
      font-weight: 650;
    }

    .model-picker-meta,
    .model-picker-url {
      color: var(--muted);
      font-size: 10px;
    }

    .model-picker-selected {
      padding: 2px 6px;
      border-radius: 999px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      font-size: 9px;
      font-weight: 650;
    }

    .model-picker-manage {
      align-self: center;
      height: 30px;
      padding: 0 8px;
      border: 1px solid transparent;
      border-radius: 5px;
      color: var(--muted);
      background: transparent;
      font-size: 10px;
      cursor: pointer;
    }

    .profile-form-delete {
      margin-right: auto;
      color: var(--vscode-errorForeground, var(--vscode-editorError-foreground));
      background: transparent;
      border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-editorError-foreground));
    }

    .profile-form-delete[data-confirm="true"] {
      color: var(--vscode-button-foreground);
      background: var(--vscode-inputValidation-errorBorder, var(--vscode-editorError-foreground));
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

    .settings-subdialog-button {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      width: 100%;
      margin-top: 10px;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--vscode-foreground);
      background: var(--surface-soft);
      text-align: left;
      cursor: pointer;
    }

    .settings-subdialog-button:hover {
      border-color: var(--focus);
      background: var(--vscode-list-hoverBackground);
    }

    .settings-subdialog-copy {
      display: grid;
      gap: 2px;
    }

    .settings-subdialog-copy strong {
      font-size: 12px;
      font-weight: 650;
    }

    .settings-subdialog-copy span,
    .settings-subdialog-chevron {
      color: var(--muted);
      font-size: 10px;
      line-height: 1.4;
    }

    .agent-tool-limit-grid .profile-field:last-child {
      grid-column: auto;
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
          <div id="intelligenceControl" class="intelligence-control" hidden>
            <button
              id="intelligenceButton"
              class="intelligence-icon-button"
              type="button"
              title="Model intelligence"
              aria-label="Choose model intelligence"
              aria-haspopup="menu"
              aria-expanded="false"
            ><span aria-hidden="true">✦</span></button>
            <div id="intelligenceMenu" class="intelligence-menu" role="menu" hidden>
              <span class="intelligence-menu-title">Intelligence</span>
              <div id="intelligenceMenuOptions" class="intelligence-menu-options"></div>
            </div>
          </div>
          <span class="composer-actions-spacer"></span>
          <div class="composer-submit">
            <button
              id="continueAgent"
              class="scope-button continue-agent-button"
              type="button"
              title="Continue the unfinished DevMate run with its saved tool history"
              hidden
            >Continue</button>
            <span
              id="tokenEstimate"
              class="token-estimate"
              data-active="false"
              title="Before sending, this estimates the current message. During a request, full prompt and response usage appears here."
            >≈ 0 tokens</span>
            <button id="ask" class="action-button primary ask-button" type="button" disabled>Ask</button>
          </div>
        </div>
      </div>
    </section>
  </main>

  <dialog id="llmProfilePickerDialog" class="profile-dialog model-picker-dialog" aria-labelledby="llmProfilePickerTitle">
    <section class="profile-form">
      <header class="profile-form-header">
        <h2 id="llmProfilePickerTitle">Choose model</h2>
        <p>Select a model for this DevMate session or manage a saved profile.</p>
      </header>
      <div class="profile-form-body">
        <div id="llmProfilePickerList" class="model-picker-list" role="listbox" aria-label="Available model profiles"></div>
      </div>
      <footer class="profile-form-actions">
        <button id="cancelLlmProfilePicker" class="action-button secondary" type="button">Close</button>
        <button id="addLlmProfile" class="action-button primary" type="button">Add model</button>
      </footer>
    </section>
  </dialog>

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
        <button id="deleteLlmProfile" class="action-button profile-form-delete" type="button" hidden>Delete</button>
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
          <button id="openAgentToolSettings" class="settings-subdialog-button" type="button">
            <span class="settings-subdialog-copy">
              <strong>Agent tools</strong>
              <span>Configure read ranges and result limits for project tools.</span>
            </span>
            <span class="settings-subdialog-chevron" aria-hidden="true">›</span>
          </button>
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

  <dialog id="agentToolSettingsDialog" class="profile-dialog" aria-labelledby="agentToolSettingsTitle">
    <form id="agentToolSettingsForm" class="profile-form">
      <header class="profile-form-header">
        <h2 id="agentToolSettingsTitle">Agent tools</h2>
        <p>Set how much information each tool may return in one call. Higher values use more model context.</p>
      </header>
      <div class="profile-form-body">
        <div class="settings-value-grid agent-tool-limit-grid">
          <div class="profile-field">
            <label for="settingsReadFileMaxLines">Read file — maximum lines</label>
            <input id="settingsReadFileMaxLines" type="number" min="100" max="1000" step="1" required>
            <p class="field-help">Default 400. You can raise this to 600 or 700 for larger files.</p>
          </div>
          <div class="profile-field">
            <label for="settingsListFilesMaxResults">List files — maximum results</label>
            <input id="settingsListFilesMaxResults" type="number" min="20" max="500" step="1" required>
            <p class="field-help">Default 200 files per call.</p>
          </div>
          <div class="profile-field">
            <label for="settingsSearchCodeMaxResults">Search code — maximum matches</label>
            <input id="settingsSearchCodeMaxResults" type="number" min="10" max="200" step="1" required>
            <p class="field-help">Default 50 matches per call.</p>
          </div>
          <div class="profile-field">
            <label for="settingsDiagnosticsMaxResults">Diagnostics — maximum errors</label>
            <input id="settingsDiagnosticsMaxResults" type="number" min="10" max="300" step="1" required>
            <p class="field-help">Default 100 diagnostics per call.</p>
          </div>
          <div class="profile-field">
            <label for="settingsTerminalErrorsMaxResults">Terminal errors — recent entries</label>
            <input id="settingsTerminalErrorsMaxResults" type="number" min="1" max="10" step="1" required>
            <p class="field-help">Default 5 recent terminal error groups.</p>
          </div>
          <div class="profile-field">
            <label for="settingsCodeNavigationMaxResults">Code navigation — maximum locations</label>
            <input id="settingsCodeNavigationMaxResults" type="number" min="10" max="300" step="1" required>
            <p class="field-help">Shared by symbols, definitions, and references. Default 100.</p>
          </div>
        </div>
      </div>
      <footer class="profile-form-actions">
        <button id="cancelAgentToolSettings" class="action-button secondary" type="button">Back</button>
        <button class="action-button primary" type="submit">Save tool settings</button>
      </footer>
    </form>
  </dialog>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const MAX_INTERMEDIATE_NARRATION_CHARACTERS = 220;
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
        agentTools: {
          readFileMaxLines: 400,
          listFilesMaxResults: 200,
          searchCodeMaxResults: 50,
          diagnosticsMaxResults: 100,
          terminalErrorsMaxResults: 5,
          codeNavigationMaxResults: 100
        },
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
      narrationText: '',
      streamPumpTimer: undefined,
      pendingAssistantResponse: undefined,
      toolUsage: { used: 0, limit: 16 },
      requestTokenUsage: undefined,
      checkpointAvailable: false,
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
    const intelligenceControlEl = document.getElementById('intelligenceControl');
    const intelligenceButtonEl = document.getElementById('intelligenceButton');
    const intelligenceMenuEl = document.getElementById('intelligenceMenu');
    const intelligenceMenuOptionsEl = document.getElementById('intelligenceMenuOptions');
    const tokenEstimateEl = document.getElementById('tokenEstimate');
    const continueAgentEl = document.getElementById('continueAgent');
    const askEl = document.getElementById('ask');
    const sessionSelectorEl = document.getElementById('sessionSelector');
    const activeSessionTitleEl = document.getElementById('activeSessionTitle');
    const newSessionButtonEl = document.getElementById('newSessionButton');
    const sessionListEl = document.getElementById('sessionList');
    const newSessionOnHomeEl = document.getElementById('newSessionOnHome');
    const llmProfilePickerDialogEl = document.getElementById('llmProfilePickerDialog');
    const llmProfilePickerListEl = document.getElementById('llmProfilePickerList');
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
    const deleteLlmProfileEl = document.getElementById('deleteLlmProfile');
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
    const agentToolSettingsDialogEl = document.getElementById('agentToolSettingsDialog');
    const agentToolSettingsFormEl = document.getElementById('agentToolSettingsForm');
    const settingsReadFileMaxLinesEl = document.getElementById('settingsReadFileMaxLines');
    const settingsListFilesMaxResultsEl = document.getElementById('settingsListFilesMaxResults');
    const settingsSearchCodeMaxResultsEl = document.getElementById('settingsSearchCodeMaxResults');
    const settingsDiagnosticsMaxResultsEl = document.getElementById('settingsDiagnosticsMaxResults');
    const settingsTerminalErrorsMaxResultsEl = document.getElementById('settingsTerminalErrorsMaxResults');
    const settingsCodeNavigationMaxResultsEl = document.getElementById('settingsCodeNavigationMaxResults');
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
      state.requestTokenUsage = undefined;
      renderTokenEstimate();
      state.askPending = true;
      startWorkingTurn();
      renderAskAvailability();
      state.lastRequest = {
        command: 'ask',
        mode: state.mode,
        question,
        scope: state.scope,
        isNewTurn: true
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

    continueAgentEl.addEventListener('click', () => {
      if (!state.checkpointAvailable || state.askPending) {
        return;
      }
      state.askPending = true;
      setStatus('Ready');
      startWorkingTurn();
      renderAskAvailability();
      vscode.postMessage({ command: 'continueAgentRun' });
    });

    attachFilesEl.addEventListener('click', () => {
      vscode.postMessage({ command: 'pickFiles' });
    });

    llmProfileSelectorEl.addEventListener('click', () => {
      closeIntelligenceMenu();
      vscode.postMessage({ command: 'chooseLlmProfile' });
    });

    intelligenceButtonEl.addEventListener('click', (event) => {
      event.stopPropagation();
      if (intelligenceButtonEl.disabled) {
        return;
      }
      const willOpen = intelligenceMenuEl.hidden;
      intelligenceMenuEl.hidden = !willOpen;
      intelligenceButtonEl.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) {
        intelligenceMenuOptionsEl.querySelector('[aria-checked="true"]')?.focus();
      }
    });

    document.addEventListener('click', (event) => {
      if (!intelligenceControlEl.contains(event.target)) {
        closeIntelligenceMenu();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !intelligenceMenuEl.hidden) {
        closeIntelligenceMenu();
        intelligenceButtonEl.focus();
      }
    });

    document.getElementById('cancelLlmProfilePicker').addEventListener('click', () => {
      closeLlmProfilePicker();
    });

    document.getElementById('addLlmProfile').addEventListener('click', () => {
      closeLlmProfilePicker();
      vscode.postMessage({ command: 'addLlmProfile' });
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
    document.getElementById('openAgentToolSettings').addEventListener('click', () => {
      const settings = state.settings.agentTools;
      settingsReadFileMaxLinesEl.value = String(settings.readFileMaxLines);
      settingsListFilesMaxResultsEl.value = String(settings.listFilesMaxResults);
      settingsSearchCodeMaxResultsEl.value = String(settings.searchCodeMaxResults);
      settingsDiagnosticsMaxResultsEl.value = String(settings.diagnosticsMaxResults);
      settingsTerminalErrorsMaxResultsEl.value = String(settings.terminalErrorsMaxResults);
      settingsCodeNavigationMaxResultsEl.value = String(settings.codeNavigationMaxResults);
      permissionDialogEl.close();
      agentToolSettingsDialogEl.showModal();
      settingsReadFileMaxLinesEl.focus();
    });
    document.getElementById('cancelAgentToolSettings').addEventListener('click', () => {
      agentToolSettingsDialogEl.close();
      openSettingsDialog();
    });
    agentToolSettingsFormEl.addEventListener('submit', (event) => {
      event.preventDefault();
      vscode.postMessage({
        command: 'saveAgentToolSettings',
        settings: {
          readFileMaxLines: Number(settingsReadFileMaxLinesEl.value),
          listFilesMaxResults: Number(settingsListFilesMaxResultsEl.value),
          searchCodeMaxResults: Number(settingsSearchCodeMaxResultsEl.value),
          diagnosticsMaxResults: Number(settingsDiagnosticsMaxResultsEl.value),
          terminalErrorsMaxResults: Number(settingsTerminalErrorsMaxResultsEl.value),
          codeNavigationMaxResults: Number(settingsCodeNavigationMaxResultsEl.value)
        }
      });
    });
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

    deleteLlmProfileEl.addEventListener('click', () => {
      const profileId = llmProfileIdEl.value;
      if (!profileId || deleteLlmProfileEl.hidden || deleteLlmProfileEl.disabled) {
        return;
      }
      if (deleteLlmProfileEl.dataset.confirm !== 'true') {
        deleteLlmProfileEl.dataset.confirm = 'true';
        deleteLlmProfileEl.textContent = 'Confirm delete';
        return;
      }
      deleteLlmProfileEl.disabled = true;
      deleteLlmProfileEl.textContent = 'Deleting…';
      vscode.postMessage({ command: 'deleteLlmProfile', profileId });
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
        const completion = {
          response: message.response,
          fileChanges: Array.isArray(message.fileChanges) ? message.fileChanges : []
        };
        if (state.streamQueue || state.streamPumpTimer) {
          state.pendingAssistantResponse = completion;
        } else {
          completeAssistantResponse(completion.response, completion.fileChanges);
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
          state.requestTokenUsage = undefined;
          renderTokenEstimate();
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

      if (message.command === 'showLlmProfilePicker') {
        showLlmProfilePicker(message.profiles);
      }

      if (message.command === 'showLlmProfileForm') {
        showLlmProfileForm(message.profile, message.hasApiKey);
      }

      if (message.command === 'llmProfileFormError') {
        setLlmProfileFormSaving(false);
        deleteLlmProfileEl.dataset.confirm = 'false';
        deleteLlmProfileEl.textContent = 'Delete';
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

      if (message.command === 'agentToolSettingsSaved' && agentToolSettingsDialogEl.open) {
        agentToolSettingsDialogEl.close();
        openSettingsDialog();
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
          finalizeProviderNarration();
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

      if (message.command === 'toolUsageUpdated') {
        state.toolUsage = {
          used: Number(message.used) || 0,
          limit: Number(message.limit) || 16
        };
        renderToolUsage();
      }

      if (message.command === 'tokenUsageUpdated') {
        state.requestTokenUsage = message.usage;
        renderWorkingTokenUsage();
        renderTokenEstimate();
      }

      if (message.command === 'agentCheckpointUpdated') {
        state.checkpointAvailable = message.available === true;
        if (state.checkpointAvailable) {
          state.toolUsage = {
            used: Number(message.used) || 0,
            limit: Number(message.limit) || 16
          };
          if (message.tokenUsage) {
            state.requestTokenUsage = message.tokenUsage;
          }
        }
        renderAskAvailability();
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
      if (characterCount === 0 && state.requestTokenUsage) {
        const usage = state.requestTokenUsage;
        tokenEstimateEl.textContent = (usage.exact ? '' : '≈ ')
          + formatTokenCount(usage.totalTokens) + ' total';
        tokenEstimateEl.dataset.active = 'true';
        tokenEstimateEl.title = (usage.exact ? 'Provider-reported' : 'Estimated')
          + ' full request usage: ' + usage.inputTokens + ' input and '
          + usage.outputTokens + ' output tokens.';
        tokenEstimateEl.setAttribute(
          'aria-label',
          (usage.exact ? '' : 'Approximately ') + usage.totalTokens
            + ' total tokens in the last request'
        );
        return;
      }
      const tokenCount = characterCount === 0 ? 0 : Math.max(1, Math.ceil(characterCount / 4));
      const tokenLabel = formatTokenCount(tokenCount);
      tokenEstimateEl.textContent = '≈ ' + tokenLabel + (tokenCount === 1 ? ' token' : ' tokens');
      tokenEstimateEl.dataset.active = String(tokenCount > 0);
      tokenEstimateEl.title = 'Approximate tokens in the current message before project context is collected.';
      tokenEstimateEl.setAttribute(
        'aria-label',
        'Approximately ' + tokenCount + (tokenCount === 1 ? ' token' : ' tokens')
          + ' in the current message'
      );
    }

    function formatTokenCount(tokenCount) {
      if (tokenCount < 1_000) {
        return String(tokenCount);
      }
      const roundedThousands = (Math.round((tokenCount / 1_000) * 10) / 10).toFixed(1);
      return (roundedThousands.endsWith('.0')
        ? roundedThousands.slice(0, -2)
        : roundedThousands) + 'k';
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

    function appendMessage(text, role, scroll = true, fileChanges = []) {
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
      if (role === 'assistant') {
        appendFileChangeSummary(item, fileChanges);
      }
      messagesEl.appendChild(item);
      if (scroll) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }

    function appendFileChangeSummary(messageItem, fileChanges) {
      const allowedKinds = new Set(['created', 'updated', 'deleted', 'renamed', 'moved']);
      const changes = Array.isArray(fileChanges)
        ? fileChanges.filter((change) => change
          && allowedKinds.has(change.kind)
          && typeof change.path === 'string'
          && change.path).slice(0, 20)
        : [];
      if (changes.length === 0) {
        return;
      }

      const deletedCount = changes.filter((change) => change.kind === 'deleted').length;
      const changedCount = changes.length - deletedCount;
      const summary = document.createElement('section');
      summary.className = 'file-change-summary';
      summary.setAttribute('aria-label', 'Files changed by DevMate');

      const header = document.createElement('div');
      header.className = 'file-change-summary-header';
      const title = document.createElement('span');
      title.textContent = changes.length === 1 ? '1 file changed' : changes.length + ' files changed';
      header.appendChild(title);
      const counts = document.createElement('span');
      counts.className = 'file-change-summary-counts';
      const changed = document.createElement('span');
      changed.className = 'changed';
      changed.textContent = '+' + changedCount;
      counts.appendChild(changed);
      if (deletedCount > 0) {
        const deleted = document.createElement('span');
        deleted.className = 'deleted';
        deleted.textContent = '−' + deletedCount;
        counts.appendChild(deleted);
      }
      header.appendChild(counts);
      summary.appendChild(header);

      const list = document.createElement('ul');
      list.className = 'file-change-list';
      const labels = {
        created: 'Created',
        updated: 'Updated',
        deleted: 'Deleted',
        renamed: 'Renamed',
        moved: 'Moved'
      };
      changes.forEach((change) => {
        const row = document.createElement('li');
        row.className = 'file-change-row';
        row.dataset.kind = change.kind;
        const symbol = document.createElement('span');
        symbol.className = 'file-change-symbol';
        symbol.textContent = change.kind === 'deleted' ? '−' : '+';
        row.appendChild(symbol);
        const operation = document.createElement('span');
        operation.className = 'file-change-operation';
        operation.textContent = labels[change.kind];
        row.appendChild(operation);
        const pathText = (change.kind === 'renamed' || change.kind === 'moved')
          && typeof change.previousPath === 'string'
          ? change.previousPath + ' → ' + change.path
          : change.path;
        const hasDiff = typeof change.diffId === 'string' && change.diffId.length > 0;
        const pathElement = document.createElement(hasDiff || change.kind !== 'deleted' ? 'button' : 'span');
        pathElement.className = 'file-change-path';
        pathElement.textContent = pathText;
        pathElement.title = hasDiff ? pathText + ' · Open DevMate diff' : pathText;
        if (hasDiff || change.kind !== 'deleted') {
          pathElement.type = 'button';
          pathElement.addEventListener('click', () => {
            vscode.postMessage(hasDiff
              ? { command: 'openFileChangeDiff', diffId: change.diffId, path: change.path }
              : { command: 'openWorkspaceFile', path: change.path });
          });
        }
        row.appendChild(pathElement);
        list.appendChild(row);
      });
      summary.appendChild(list);
      messageItem.appendChild(summary);
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
          appendMessage(message.text, message.role, false, message.fileChanges);
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
      finalizeProviderNarration();
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
      const toolUsage = document.createElement('span');
      toolUsage.className = 'working-tool-usage';
      header.appendChild(toolUsage);
      card.appendChild(header);

      const phases = document.createElement('ul');
      phases.className = 'working-phases';
      card.appendChild(phases);

      const footer = document.createElement('div');
      footer.className = 'working-footer';
      const elapsed = document.createElement('span');
      elapsed.className = 'working-elapsed';
      footer.appendChild(elapsed);
      const tokenUsage = document.createElement('span');
      tokenUsage.className = 'working-token-usage';
      footer.appendChild(tokenUsage);
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
        vscode.postMessage({ ...state.lastRequest, isNewTurn: false });
      });
      footer.appendChild(retry);
      card.appendChild(footer);
      messagesEl.appendChild(card);

      updateWorkingElapsed();
      renderToolUsage();
      renderWorkingTokenUsage();
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
      state.narrationText = '';
      state.pendingAssistantResponse = undefined;
    }

    function resetProviderStream() {
      finalizeProviderNarration();
      clearProviderStreamAnimation();
    }

    function appendProviderStreamDelta(text) {
      if (typeof text !== 'string' || !text) {
        return;
      }
      ensureProviderNarration();
      state.streamQueue = (state.streamQueue + text).slice(-50_000);
      ensureProviderStreamPump();
    }

    function ensureProviderNarration() {
      let card = document.getElementById('providerNarration');
      if (card) {
        return card;
      }
      card = document.createElement('article');
      state.narrationText = '';
      card.id = 'providerNarration';
      card.className = 'message assistant model-narration';
      card.dataset.streaming = 'true';
      card.setAttribute('aria-live', 'polite');

      const author = document.createElement('span');
      author.className = 'message-author';
      author.textContent = 'DevMate update';
      card.appendChild(author);

      const body = document.createElement('div');
      body.className = 'message-body model-narration-body';
      card.appendChild(body);
      messagesEl.appendChild(card);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return card;
    }

    function finalizeProviderNarration() {
      const card = document.getElementById('providerNarration');
      if (!card) {
        return;
      }
      if (state.streamPumpTimer) {
        clearTimeout(state.streamPumpTimer);
        state.streamPumpTimer = undefined;
      }
      const body = card.querySelector('.model-narration-body');
      if (state.streamQueue) {
        state.narrationText = (state.narrationText + state.streamQueue).slice(0, 20_000);
        state.streamQueue = '';
      }
      body.textContent = compactProviderNarration(state.narrationText);
      card.removeAttribute('id');
      card.dataset.streaming = 'false';
      if (!body.textContent.trim()) {
        card.remove();
      }
    }

    function ensureProviderStreamPump() {
      if (state.streamPumpTimer) {
        return;
      }
      state.streamPumpTimer = setTimeout(pumpProviderStream, 18);
    }

    function pumpProviderStream() {
      state.streamPumpTimer = undefined;
      const narration = document.getElementById('providerNarration');
      const stream = narration?.querySelector('.model-narration-body');
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
        state.narrationText = (state.narrationText + chunk).slice(0, 20_000);
        stream.textContent = compactProviderNarration(state.narrationText);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        state.streamPumpTimer = setTimeout(pumpProviderStream, 18);
        return;
      }

      if (state.pendingAssistantResponse !== undefined) {
        const completion = state.pendingAssistantResponse;
        state.pendingAssistantResponse = undefined;
        state.streamPumpTimer = setTimeout(() => {
          state.streamPumpTimer = undefined;
          completeAssistantResponse(completion.response, completion.fileChanges);
        }, 120);
      }
    }

    function compactProviderNarration(value) {
      const normalized = String(value || '')
        .replace(/\\x60{3}[\\s\\S]*?\\x60{3}/g, ' Code omitted. ')
        .replace(/^\\s{0,3}(?:#{1,6}|[-*]|\\d+[.)])\\s+/gm, '')
        .replace(/[\\x60*_>#]+/g, '')
        .replace(/\\s+/g, ' ')
        .trim();
      if (normalized.length <= MAX_INTERMEDIATE_NARRATION_CHARACTERS) {
        return normalized;
      }
      const sentences = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [normalized];
      let summary = '';
      for (const sentence of sentences.slice(0, 2)) {
        const candidate = (summary + ' ' + sentence.trim()).trim();
        if (candidate.length > MAX_INTERMEDIATE_NARRATION_CHARACTERS) {
          break;
        }
        summary = candidate;
      }
      const source = summary || normalized;
      if (source.length <= MAX_INTERMEDIATE_NARRATION_CHARACTERS) {
        return source;
      }
      const sliced = source.slice(0, MAX_INTERMEDIATE_NARRATION_CHARACTERS - 1);
      const lastSpace = sliced.lastIndexOf(' ');
      return sliced.slice(0, lastSpace > 80 ? lastSpace : sliced.length).trimEnd() + '…';
    }

    function completeAssistantResponse(response, fileChanges = []) {
      finishWorkingTurn(response, fileChanges);
      state.askPending = false;
      renderAskAvailability();
    }

    function renderToolUsage() {
      const usage = document.querySelector('#workingTurn .working-tool-usage');
      if (!usage) {
        return;
      }
      usage.textContent = 'Tools ' + state.toolUsage.used + ' / ' + state.toolUsage.limit;
      usage.title = state.toolUsage.used + ' of ' + state.toolUsage.limit
        + ' project tool calls used in this request';
    }

    function renderWorkingTokenUsage() {
      const target = document.querySelector('#workingTurn .working-token-usage');
      if (!target) {
        return;
      }
      const usage = state.requestTokenUsage;
      if (!usage) {
        target.textContent = '';
        target.hidden = true;
        return;
      }
      const marker = usage.exact ? '' : '≈';
      target.textContent = 'Input ' + marker + formatTokenCount(usage.inputTokens)
        + ' · Output ' + marker + formatTokenCount(usage.outputTokens);
      target.title = (usage.exact ? 'Provider-reported' : 'Estimated')
        + ' token usage for this request';
      target.hidden = false;
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
      finalizeProviderNarration();
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

    function finishWorkingTurn(response, fileChanges = []) {
      clearProviderStreamAnimation();
      clearWorkingTimer();
      document.getElementById('workingTurn')?.remove();
      const narration = document.getElementById('providerNarration');
      if (!narration) {
        appendMessage(response, 'assistant', true, fileChanges);
        return;
      }
      narration.removeAttribute('id');
      narration.dataset.streaming = 'false';
      narration.querySelector('.message-author').textContent = 'DevMate';
      const body = narration.querySelector('.model-narration-body');
      body.classList.add('markdown');
      body.textContent = '';
      renderMarkdown(body, response);
      appendFileChangeSummary(narration, fileChanges);
      messagesEl.scrollTop = messagesEl.scrollHeight;
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
        intelligenceControlEl.hidden = true;
        closeIntelligenceMenu();
        renderAskAvailability();
        return;
      }

      llmProfileLabelEl.textContent = state.activeProfile.name;
      const reasoningOptions = Array.isArray(state.activeProfile.reasoningEffortOptions)
        ? state.activeProfile.reasoningEffortOptions
        : [];
      const selectedReasoning = reasoningOptions.find(
        (item) => item.value === state.activeProfile.reasoningEffort
      );
      intelligenceMenuOptionsEl.replaceChildren();
      intelligenceControlEl.hidden = reasoningOptions.length <= 1;
      if (reasoningOptions.length <= 1) {
        closeIntelligenceMenu();
      }
      reasoningOptions.forEach((item) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'intelligence-menu-option';
        option.setAttribute('role', 'menuitemradio');
        option.setAttribute('aria-checked', String(item.value === state.activeProfile.reasoningEffort));
        const label = document.createElement('span');
        label.textContent = item.label;
        const check = document.createElement('span');
        check.className = 'intelligence-menu-check';
        check.setAttribute('aria-hidden', 'true');
        check.textContent = item.value === state.activeProfile.reasoningEffort ? '✓' : '';
        option.append(label, check);
        option.addEventListener('click', (event) => {
          event.stopPropagation();
          state.activeProfile.reasoningEffort = item.value;
          closeIntelligenceMenu();
          renderLlmProfile();
          vscode.postMessage({ command: 'setReasoningEffort', effort: item.value });
        });
        intelligenceMenuOptionsEl.appendChild(option);
      });
      const intelligenceLabel = selectedReasoning?.label || 'Auto';
      intelligenceButtonEl.title = 'Intelligence: ' + intelligenceLabel;
      intelligenceButtonEl.setAttribute('aria-label', 'Model intelligence: ' + intelligenceLabel);
      llmProfileSelectorEl.title = state.activeProfile.providerLabel
        + ' · ' + state.activeProfile.model
        + (reasoningOptions.length > 1 ? ' · Intelligence: ' + intelligenceLabel : '')
        + (state.profileCount > 1 ? ' · Select another model' : ' · Manage model');
      renderAskAvailability();
    }

    function closeIntelligenceMenu() {
      intelligenceMenuEl.hidden = true;
      intelligenceButtonEl.setAttribute('aria-expanded', 'false');
    }

    function renderAskAvailability() {
      askEl.disabled = !state.activeProfile || state.askPending;
      document.querySelectorAll('.mode-button, .scope-button[data-scope]').forEach((button) => {
        button.disabled = state.askPending;
      });
      attachFilesEl.disabled = state.askPending;
      llmProfileSelectorEl.disabled = state.askPending;
      intelligenceButtonEl.disabled = state.askPending;
      if (state.askPending) {
        closeIntelligenceMenu();
      }
      continueAgentEl.hidden = !state.checkpointAvailable || state.askPending;
      continueAgentEl.disabled = state.askPending;
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

    function showLlmProfilePicker(profiles) {
      llmProfilePickerListEl.replaceChildren();
      const availableProfiles = Array.isArray(profiles) ? profiles : [];
      availableProfiles.forEach((profile) => {
        const option = document.createElement('div');
        option.className = 'model-picker-option';
        option.dataset.selected = String(profile.selected === true);

        const select = document.createElement('button');
        select.type = 'button';
        select.className = 'model-picker-select';
        select.setAttribute('role', 'option');
        select.setAttribute('aria-selected', String(profile.selected === true));

        const icon = document.createElement('span');
        icon.className = 'model-picker-icon';
        icon.textContent = profile.builtIn ? '✦' : String(profile.name || '?').slice(0, 1);
        select.appendChild(icon);

        const copy = document.createElement('span');
        copy.className = 'model-picker-copy';
        const name = document.createElement('span');
        name.className = 'model-picker-name';
        name.textContent = profile.name;
        const meta = document.createElement('span');
        meta.className = 'model-picker-meta';
        meta.textContent = [
          profile.builtIn ? 'Built-in' : undefined,
          profile.providerLabel,
          profile.model,
          profile.intelligence ? 'Intelligence: ' + profile.intelligence : undefined
        ].filter(Boolean).join(' · ');
        copy.append(name, meta);
        if (profile.baseUrl) {
          const url = document.createElement('span');
          url.className = 'model-picker-url';
          url.textContent = profile.baseUrl;
          url.title = profile.baseUrl;
          copy.appendChild(url);
        }
        select.appendChild(copy);

        if (profile.selected) {
          const selected = document.createElement('span');
          selected.className = 'model-picker-selected';
          selected.textContent = 'Selected';
          select.appendChild(selected);
        }
        select.addEventListener('click', () => {
          closeLlmProfilePicker();
          vscode.postMessage({ command: 'selectLlmProfile', profileId: profile.id });
        });

        const manage = document.createElement('button');
        manage.type = 'button';
        manage.className = 'model-picker-manage';
        manage.textContent = profile.builtIn ? 'Configure' : 'Edit';
        manage.title = (profile.builtIn ? 'Configure ' : 'Edit ') + profile.name;
        manage.addEventListener('click', () => {
          closeLlmProfilePicker();
          vscode.postMessage({ command: 'editLlmProfile', profileId: profile.id });
        });

        option.append(select, manage);
        llmProfilePickerListEl.appendChild(option);
      });
      if (!llmProfilePickerDialogEl.open) {
        llmProfilePickerDialogEl.showModal();
      }
      llmProfilePickerListEl.querySelector('[aria-selected="true"]')?.focus();
    }

    function closeLlmProfilePicker() {
      if (llmProfilePickerDialogEl.open) {
        llmProfilePickerDialogEl.close();
      }
    }

    function showLlmProfileForm(profile, hasApiKey) {
      closeLlmProfilePicker();
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
      deleteLlmProfileEl.hidden = !profile || isBuiltIn;
      deleteLlmProfileEl.disabled = false;
      deleteLlmProfileEl.dataset.confirm = 'false';
      deleteLlmProfileEl.textContent = 'Delete';
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
      deleteLlmProfileEl.dataset.confirm = 'false';
      deleteLlmProfileEl.textContent = 'Delete';
      deleteLlmProfileEl.disabled = false;
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
      deleteLlmProfileEl.disabled = saving;
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

function createNonce(): string {
  return randomBytes(24).toString('base64');
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function estimatedTokenCount(characterCount: number): number {
  return characterCount <= 0 ? 0 : Math.max(1, Math.ceil(characterCount / 4));
}

function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const inputTokens = left.inputTokens + right.inputTokens;
  const outputTokens = left.outputTokens + right.outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    exact: left.exact && right.exact
  };
}

function waitForRetryDelay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const finish = (completed: boolean) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
      resolve(completed);
    };
    const cancel = () => finish(false);
    const timeout = setTimeout(() => finish(true), milliseconds);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

function getBackendUrl(): string {
  return vscode.workspace
    .getConfiguration('devMate')
    .get<string>('backendUrl', 'http://127.0.0.1:8000')
    .trim();
}

function normalizeRelativeWorkspacePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function agentPathMatches(left: string, right: string): boolean {
  return comparableWorkspacePath(left) === comparableWorkspacePath(right);
}

function agentPathStartsWith(filePath: string, directoryPath: string): boolean {
  return comparableWorkspacePath(filePath).startsWith(
    `${comparableWorkspacePath(directoryPath)}/`
  );
}

function comparableWorkspacePath(value: string): string {
  return process.platform === 'win32' ? value.toLocaleLowerCase() : value;
}

function isDocumentSymbol(
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation
): symbol is vscode.DocumentSymbol {
  return 'selectionRange' in symbol && Array.isArray(symbol.children);
}

function codeLocationFromProvider(
  location: vscode.Location | vscode.LocationLink
): { uri: vscode.Uri; range: vscode.Range } | undefined {
  if ('targetUri' in location) {
    return {
      uri: location.targetUri,
      range: location.targetSelectionRange ?? location.targetRange
    };
  }
  if ('uri' in location) {
    return { uri: location.uri, range: location.range };
  }
  return undefined;
}

function formatSymbolResult(
  kind: vscode.SymbolKind,
  name: string,
  filePath: string,
  position: vscode.Position,
  container?: string
): string {
  const kindLabel = vscode.SymbolKind[kind] ?? 'Symbol';
  const safeName = boundedCodeNavigationText(name, 160) || '(unnamed)';
  const safeContainer = boundedCodeNavigationText(container, 160);
  return `[${kindLabel}] ${safeName}${safeContainer ? ` · ${safeContainer}` : ''} — `
    + `${filePath}:${position.line + 1}:${position.character + 1}`;
}

function boundedCodeNavigationText(value: unknown, maximum: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum)
    : '';
}

function describeAgentToolCall(call: ParsedAgentToolCall): { title: string; detail: string } {
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
  if (call.name === 'get_diagnostics') {
    return {
      title: 'Reading workspace diagnostics',
      detail: call.arguments.path || 'All workspace Problems'
    };
  }
  if (call.name === 'get_symbols') {
    return {
      title: 'Reading file symbols',
      detail: call.arguments.path
    };
  }
  if (call.name === 'find_definition') {
    return {
      title: 'Finding definition',
      detail: `${call.arguments.path}:${call.arguments.line}:${call.arguments.column}`
    };
  }
  if (call.name === 'find_references') {
    return {
      title: 'Finding references',
      detail: `${call.arguments.path}:${call.arguments.line}:${call.arguments.column}`
    };
  }
  if (call.name === 'read_terminal_errors') {
    return {
      title: 'Reading recent terminal errors',
      detail: `Up to ${call.arguments.maxResults} failed commands`
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

function formatContextSize(includedCharacters: number, totalCharacters: number, truncated: boolean): string {
  if (truncated) {
    return `${includedCharacters} of ${totalCharacters} chars`;
  }

  return `${totalCharacters} chars`;
}

function formatFileCount(count: number): string {
  return count === 1 ? '1 file' : `${count} files`;
}

function formatExcerptCount(count: number): string {
  return count === 1 ? '1 relevant project excerpt' : `${count} relevant project excerpts`;
}
