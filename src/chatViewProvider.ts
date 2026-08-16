import { randomUUID } from 'crypto';
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
} from './agentTools';
import type { AgentToolSettings } from './agentTools';
import {
  AGENT_CHECKPOINT_STORAGE_KEY,
  parseAgentRunCheckpoint
} from './sessions';
import type { AgentRunCheckpoint } from './sessions';
import { ask, askStream } from './api/client';
import { backendStatusLabel } from './backendManager';
import type { LocalBackendManager, ManagedBackendStatus } from './backendManager';
import { getChatWebviewHtml } from './webview';
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
import { createBoundedContextItem } from './projectIndex';
import {
  collectFileChangeSummary,
  parseAppliedFileChangeOutcome
} from './fileTools';
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
} from './commandTools';
import type { CapturedTerminalError } from './commandTools';
import {
  MAX_DEPENDENCY_MANIFEST_BYTES,
  validatePythonRequirementsManifest
} from './agentTools';
import {
  extractMissingPythonModule,
  isPythonVerificationCommand,
  workspacePythonCandidates,
  workspacePythonExecutable
} from './backendManager';
import type { ValidatedFileChange } from './fileTools';
import { applyExactReplacements,
         MAX_FILE_CHANGE_CHARACTERS,
         MAX_TOTAL_CHANGE_CHARACTERS,
         validateFileChanges 
} from './fileTools';
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
} from './projectIndex';
import type { ProjectFileCandidate } from './projectIndex';
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
} from './agentTools';

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

export function getBackendUrl(): string {
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
