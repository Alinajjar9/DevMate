import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { ConfigurationManager } from './configurationManager';
import { testModelConfiguration } from './modelProbe';
import { COMMAND_ACCESS_STORAGE_KEY, parseCommandAccess } from './commandTools';
import type { CommandAccess } from './commandTools';
import { normalizeAgentConfiguration, validateConfigurationOverrides, validateModelProfileSettings } from './configuration';
import type { AgentConfiguration, ConfigurationScope, ModelProfileSettings } from './configuration';
import type { AgentRunInput, AgentRunResult, AgentTransport } from './agentRunner';
import { AgentRunner } from './agentRunner';
import type { AgentToolSettings } from './agentTools';
import {
  DEFAULT_CODE_NAVIGATION_MAX_RESULTS,
  DEFAULT_DIAGNOSTICS_MAX_RESULTS,
  DEFAULT_LIST_FILES_MAX_RESULTS,
  DEFAULT_READ_FILE_MAX_LINES,
  DEFAULT_SEARCH_CODE_MAX_RESULTS,
  DEFAULT_TERMINAL_ERRORS_MAX_RESULTS,
  normalizeAgentToolSettings
} from './agentTools';
import type {
  AssistantMode
} from './api/types';
import type { ManagedBackendStatus } from './backendManager';
import { backendStatusLabel, LocalBackendManager } from './backendManager';
import {
  collectFileChangeSummary,
  parseAppliedFileChangeOutcome,
  validateFileChanges
} from './fileTools';
import type {
  LlmProfile,
  LlmProfileDraft,
  LlmProvider,
  LlmApi,
  ReasoningEffort
} from './llmProfiles';
import {
  ACTIVE_LLM_PROFILE_STORAGE_KEY,
  BUILT_IN_NEMOTRON_PROFILE,
  BUILT_IN_NEMOTRON_PROFILE_ID,
  isBuiltInLlmProfile,
  isEquivalentNemotronProfile,
  LLM_PROFILES_STORAGE_KEY,
  LLM_REASONING_EFFORT_STORAGE_KEY,
  normalizeProfileDraft,
  parseReasoningEffortPreferences,
  parseStoredProfiles,
  profilesWithBuiltInNemotron,
  providerLabelForProfile,
  reasoningEffortForProfile,
  REASONING_EFFORT_LABELS,
  reasoningEffortOptionsForProfile,
  secretKeyForProfile,
  validateProfileDraft
} from './llmProfiles';
import type {
  FilePermissionPolicy,
  RememberedCommand
} from './permissions';
import {
  FILE_PERMISSION_POLICY_STORAGE_KEY,
  parseFilePermissionPolicy,
  parseRememberedCommands,
  REMEMBERED_COMMANDS_STORAGE_KEY,
  revokeRememberedCommand
} from './permissions';
import type { AgentRunCheckpoint, ConversationSessionStore } from './sessions';
import {
  activeConversationSession,
  activeSessionModelHistory,
  addConversationSession,
  AGENT_CHECKPOINT_STORAGE_KEY,
  appendConversationSessionTurn,
  appendConversationSessionUserMessage,
  CONVERSATION_SESSIONS_STORAGE_KEY,
  createEmptyConversationSessionStore,
  deleteConversationSession,
  LEGACY_CONVERSATION_SESSIONS_STORAGE_KEY,
  mergeConversationSessionStores,
  migrateLegacyConversationSessionStore,
  parseAgentRunCheckpoint,
  parseConversationSessionStore,
  renameConversationSession,
  selectConversationSession,
  sessionBelongsToWorkspace
} from './sessions';
import { ToolExecutor } from './toolExecutor';
import { getChatWebviewHtml } from './webview';
import type { ScopeInfo, ScopeKind } from './workspaceContext';
import { WorkspaceContext } from './workspaceContext';
type LlmProfileFormSubmission = {
  id?: string;
  name: string;
  provider: LlmProvider;
  model: string;
  baseUrl?: string;
  api?: LlmApi;
  apiKey?: string;
  settings?: ModelProfileSettings;
};

type DevMateSettingsSubmission = {
  configuration?: Partial<AgentConfiguration>;
  agentTools?: Partial<AgentToolSettings>;
  // Older open webviews can finish a save while the extension is being upgraded.
  timeoutSeconds?: number;
  commandTimeoutSeconds?: number;
  toolCallLimit?: number;
  maxTokens?: number;
  temperature?: number;
  policy: FilePermissionPolicy;
  scope?: ConfigurationScope;
};

type WebviewMessage =
  | { command: 'openConfiguration' | 'setConfigurationScope' | 'saveConfiguration'; [key: string]: unknown }
  | { command: 'testLlmProfile'; profileId: string }
  | { command: 'undoRequest' }
  | { command: 'setCommandAccess'; access: CommandAccess }
  | { command: 'stopManagedCommand'; id: string }
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
  | { command: 'saveSettings'; settings: DevMateSettingsSubmission; scope?: ConfigurationScope }
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
/** Connects the chat webview to profiles, sessions, context collection and agent execution. */
export class DevMateChatViewProvider implements vscode.WebviewViewProvider, vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly workspaceContext: WorkspaceContext;
  private readonly tools: ToolExecutor;
  private readonly runner: AgentRunner;
  private readonly configuration: ConfigurationManager;
  private auxiliaryBusy = false;
  private activeRunConfiguration?: AgentConfiguration;
  private auxiliaryAbort?: AbortController;
  static readonly viewId = 'devmate.dedicatedAssistantView';

  static readonly containerId = 'devmate-dedicated-chat';

  static readonly diffScheme = ToolExecutor.diffScheme;

  private view?: vscode.WebviewView;

  private readonly viewDisposables: vscode.Disposable[] = [];

  private readonly extensionUri: vscode.Uri;

  private activeRequest?: AbortController;

  private sessionStore: ConversationSessionStore;

  private agentCheckpoint?: AgentRunCheckpoint;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly backendManager: LocalBackendManager,
    private readonly backendOutput: vscode.OutputChannel,
    transport?: AgentTransport
  ) {
    this.extensionUri = extensionContext.extensionUri;
    this.configuration = new ConfigurationManager(extensionContext, {
      postMessage: message => this.postMessage(message),
      getActiveProfile: () => this.getActiveLlmProfile(),
      getReasoningPreferences: () => this.getReasoningEffortPreferences(),
      changed: async () => { await this.postLlmProfileState(); this.postSettingsState(); }
    });
    this.workspaceContext = new WorkspaceContext(extensionContext, {
      postMessage: message => this.postMessage(message),
      postStatus: (text, level) => this.postStatus(text, level)
    });
    this.tools = new ToolExecutor(extensionContext, this.workspaceContext, {
      postMessage: message => this.postMessage(message),
      postStatus: (text, level) => this.postStatus(text, level),
      postSettingsState: () => this.postSettingsState(),
      postPermissionPolicyState: () => this.postPermissionPolicyState(),
      getAgentToolSettings: () => this.getAgentToolSettings(),
      getActiveSignal: () => this.activeRequest?.signal
    });
    this.runner = new AgentRunner(this.tools, {
      postMessage: message => this.postMessage(message),
      postStatus: (text, level) => this.postStatus(text, level),
      postRequestFailure: (message, options) => this.postRequestFailure(message, options),
      finishCancelledRequest: signal => this.finishCancelledRequest(signal),
      saveAgentCheckpoint: checkpoint => this.saveAgentCheckpoint(checkpoint),
      getConversationWorkspace: () => this.workspaceContext.getConversationWorkspace(),
      getConversationHistory: () => activeSessionModelHistory(this.sessionStore),
      ensureBackendStarted: () => this.backendManager.start(),
      getBackendUrl,
      getWorkspaceFolder: () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        return folder ? { name: folder.name, fsPath: folder.uri.scheme === 'file' ? folder.uri.fsPath : undefined } : undefined;
      }
    }, transport);
    this.agentCheckpoint = parseAgentRunCheckpoint(
      extensionContext.workspaceState.get<unknown>(AGENT_CHECKPOINT_STORAGE_KEY)
    );
    const parsedStoredSessions = parseConversationSessionStore(
      extensionContext.globalState.get<unknown>(CONVERSATION_SESSIONS_STORAGE_KEY)
    );
    const storedSessions = parsedStoredSessions ?? createEmptyConversationSessionStore();
    const workspace = this.workspaceContext.getConversationWorkspace();
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

  }

  /** Create the browser UI and connect its messages to the extension. Reopening the view replaces old listeners. */
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

  notifyWorkspaceTrustChanged(): void {
    this.postSettingsState();
    this.postCommandAccessState();
    if (!vscode.workspace.isTrusted) void this.tools.stopAllManagedCommands();
  }

  notifyConfigurationChanged(): void {
    this.postSettingsState();
    this.configuration.postState();
    void this.postLlmProfileState();
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
    this.tools.dispose();
  }

  /** Stop work tied to this view, including a request waiting for a permission decision. */
  private disposeViewDisposables(): void {
    this.auxiliaryAbort?.abort();
    this.activeRequest?.abort();
    this.activeRequest = undefined;
    this.tools.cancelPendingWork();
    while (this.viewDisposables.length > 0) {
      this.viewDisposables.pop()?.dispose();
    }
  }

  /** Route chat actions to their owners and allow only one active model request at a time. */
  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (configurationMessages.has(message.command)) {
      if (this.auxiliaryBusy || this.activeRequest && !['openConfiguration', 'setConfigurationScope'].includes(message.command)) {
        this.postMessage({ command: 'configurationError', message: 'Finish or cancel the current work before changing configuration.' });
        return;
      }
      const wasBusy = this.auxiliaryBusy;
      this.auxiliaryBusy = true;
      try { await this.configuration.handle(message as { command: string; [key: string]: unknown }); }
      finally { this.auxiliaryBusy = wasBusy; }
      return;
    }
    if (this.auxiliaryBusy && !['cancelRequest', 'ready', 'openBackendLogs', 'stopManagedCommand', 'setCommandAccess'].includes(message.command)) {
      if (message.command === 'ask' || message.command === 'continueAgentRun') {
        this.postRequestFailure('Finish the configuration test or undo before starting another request.');
      } else if (message.command === 'saveSettings') {
        this.postMessage({ command: 'settingsError', message: 'Finish the current action before saving settings.' });
      } else { this.postStatus('Finish the current configuration action first.', 'warning'); }
      return;
    }
    switch (message.command) {
      case 'setCommandAccess': await this.setCommandAccess(message.access); return;
      case 'stopManagedCommand':
        try {
          if (typeof message.id === 'string' && message.id.length <= 200) await this.tools.stopManagedCommand(message.id);
        } catch (error) {
          this.postStatus(error instanceof Error ? error.message : 'Could not stop this command.');
        } finally { this.tools.postManagedCommandState(); }
        return;
      case 'testLlmProfile': await this.testLlmProfile(message.profileId); return;
      case 'undoRequest': await this.undoLastRequest(); return;
      case 'setScope':
        await this.updateScope(message.scope);
        return;
      case 'ask':
        if (this.activeRequest) {
          this.postStatus('DevMate is already working on a request.', 'warning');
          return;
        }
        const requestController = new AbortController();
        this.tools.disposeCommandTerminals();
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
          this.activeRunConfiguration = undefined;
          await this.postUndoState();
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
        this.tools.disposeCommandTerminals();
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
          this.activeRunConfiguration = undefined;
          await this.postUndoState();
        }
        return;
      }
      case 'cancelRequest':
        this.cancelActiveRequest();
        return;
      case 'pickFiles':
        await this.workspaceContext.pickWorkspaceFiles();
        return;
      case 'removeAttachment':
        this.workspaceContext.removeAttachment(message.id);
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
        if (this.activeRequest) {
          this.postMessage({ command: 'settingsError', message: 'Finish or cancel the current request before saving settings.' });
          return;
        }
        this.auxiliaryBusy = true;
        try { await this.saveSettings({ ...message.settings, scope: message.scope ?? message.settings.scope }); }
        finally { this.auxiliaryBusy = false; }
        return;
      case 'reviewPermissionDiff':
        await this.tools.reviewPermissionDiff(message.requestId, message.path);
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
        await this.tools.openWorkspaceFile(message.path, message.line);
        return;
      case 'openFileChangeDiff':
        await this.tools.openCompletedFileDiff(message.diffId, message.path);
        return;
      case 'openExternalLink':
        await this.openExternalLink(message.url);
        return;
      case 'commandPermissionDecision':
        await this.tools.handleCommandPermissionDecision(message.requestId, message.decision);
        return;
      case 'openCommandTerminal':
        this.tools.openCommandTerminal(message.activityId);
        return;
      case 'permissionDecision':
        await this.tools.handlePermissionDecision(
          message.requestId,
          message.decision
        );
        return;
      case 'ready':
        this.workspaceContext.postAttachmentState();
        try { await this.configuration.cleanupRemovedFeatures(); }
        catch { this.postStatus('Obsolete saved presets are ignored, but their local storage could not be cleared.', 'warning'); }
        await this.migrateBuiltInNemotronProfile();
        await this.postLlmProfileState();
        await this.promptForBuiltInNemotronKey();
        this.postPermissionPolicyState();
        this.postSettingsState();
        this.postCommandAccessState();
        this.tools.postManagedCommandState();
        this.postBackendStatus();
        this.postSessionState(false);
        this.configuration.postState();
        await this.postUndoState();
        return;
      default:
        this.postStatus('Unsupported command received.', 'error');
    }
  }

  private async updateScope(scope: ScopeKind): Promise<void> {
    this.postStatus('Collecting context');

    const collectedScope = await this.workspaceContext.collectScope(scope);
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
    const workspace = this.workspaceContext.getConversationWorkspace();
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
    const workspace = this.workspaceContext.getConversationWorkspace();
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

  /** Save the current chat store across restarts; report a storage failure while retaining this window's in-memory chats. */
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
    const workspace = this.workspaceContext.getConversationWorkspace();
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

  /** Only offer Continue when the unfinished run belongs to both this workspace and the selected chat. */
  private currentAgentCheckpoint(): AgentRunCheckpoint | undefined {
    const workspace = this.workspaceContext.getConversationWorkspace();
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
    const limit = checkpoint?.configuration?.toolCallLimit ?? this.configuration.effective().toolCallLimit;
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

  /** Keep the unfinished run in memory and workspace storage; a storage failure still leaves this window usable. */
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
    await this.saveModelReasoningPreference(profile.id, effort);
    await this.postLlmProfileState();
    this.configuration.postState();
    this.postStatus('Ready');
  }

  /** The model editor and chat menu write the same preference, including an explicit Auto choice. */
  private async saveModelReasoningPreference(profileId: string, effort: ReasoningEffort): Promise<void> {
    await this.extensionContext.globalState.update(
      LLM_REASONING_EFFORT_STORAGE_KEY,
      { ...this.getReasoningEffortPreferences(), [profileId]: effort }
    );
  }

  /** Move an older equivalent profile and its saved key to the built-in profile without asking for the key again. */
  private async migrateBuiltInNemotronProfile(): Promise<void> {
    const storedProfiles = this.getStoredLlmProfiles();
    const equivalentProfiles = storedProfiles.filter(profile => profile.id !== BUILT_IN_NEMOTRON_PROFILE_ID
      && profile.settings === undefined && isEquivalentNemotronProfile(profile));
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
      const preferences = { ...this.getReasoningEffortPreferences() };
      const migratedEffort = keyCandidates.map(profile => preferences[profile.id]).find(Boolean);
      const builtInEffort = storedProfiles.find(profile => profile.id === BUILT_IN_NEMOTRON_PROFILE_ID)?.settings?.reasoningEffort;
      if (preferences[BUILT_IN_NEMOTRON_PROFILE_ID] === undefined && migratedEffort) {
        preferences[BUILT_IN_NEMOTRON_PROFILE_ID] = builtInEffort ?? migratedEffort;
      }
      for (const id of equivalentIds) delete preferences[id];
      await this.extensionContext.globalState.update(LLM_REASONING_EFFORT_STORAGE_KEY, preferences);
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
    this.configuration.postState();
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

  /** Abort provider work and release pending permissions so a cancelled request cannot remain waiting. */
  private cancelActiveRequest(): void {
    this.auxiliaryAbort?.abort();
    if (!this.activeRequest || this.activeRequest.signal.aborted) {
      return;
    }
    this.activeRequest.abort();
    this.tools.cancelPendingWork();
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
          api: profile.api ?? 'auto',
          builtIn: isBuiltInLlmProfile(profile),
          settings: { ...profile.settings, reasoningEffort: reasoningEffortForProfile(profile, this.getReasoningEffortPreferences()) }
        }
        : undefined,
      hasApiKey
    });
  }

  /** Validate profile edits, store the API key in SecretStorage, and save only profile metadata in global state. */
  private async saveLlmProfile(submission: LlmProfileFormSubmission): Promise<void> {
    if (
      (submission.id !== undefined && typeof submission.id !== 'string')
      || typeof submission.name !== 'string'
      || !['openai', 'ollama'].includes(submission.provider)
      || typeof submission.model !== 'string'
      || (submission.baseUrl !== undefined && typeof submission.baseUrl !== 'string')
      || (submission.api !== undefined && !['auto', 'chat_completions', 'responses'].includes(submission.api))
      || (submission.apiKey !== undefined && typeof submission.apiKey !== 'string')
      || (submission.settings !== undefined && Boolean(validateModelProfileSettings(submission.settings)))
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
      await this.saveBuiltInNemotronApiKey(submission.apiKey, submission.settings);
      return;
    }

    const draft: LlmProfileDraft = normalizeProfileDraft({
      name: submission.name,
      provider: submission.provider,
      model: submission.model,
      baseUrl: submission.baseUrl,
      api: submission.api ?? existingProfile?.api ?? 'auto',
      settings: submission.settings
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
      await this.saveModelReasoningPreference(profile.id, profile.settings?.reasoningEffort ?? 'auto');
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
    this.configuration.postState();
    this.postMessage({ command: 'closeLlmProfileForm' });
    this.postStatus(existingProfile ? `${profile.name} updated.` : `${profile.name} selected.`);
  }

  private async saveBuiltInNemotronApiKey(apiKey: string | undefined, settings?: ModelProfileSettings): Promise<void> {
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
      const stored = this.getStoredLlmProfiles().filter(profile => profile.id !== BUILT_IN_NEMOTRON_PROFILE_ID);
      await this.extensionContext.globalState.update(LLM_PROFILES_STORAGE_KEY, [...stored, { ...BUILT_IN_NEMOTRON_PROFILE, settings }]);
      await this.saveModelReasoningPreference(BUILT_IN_NEMOTRON_PROFILE_ID, settings?.reasoningEffort ?? 'auto');
    } catch {
      this.postMessage({
        command: 'llmProfileFormError',
        message: 'Could not save the NVIDIA API key.'
      });
      return;
    }

    await this.postLlmProfileState();
    this.configuration.postState();
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
    this.configuration.postState();
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
    const reasoningEffort = activeProfile ? this.configuration.effective(activeProfile).reasoningEffort : 'auto';
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
          reasoningEffortLabel: REASONING_EFFORT_LABELS[reasoningEffort],
          reasoningEffortOptions: reasoningOptions.map((value) => ({
            value,
            label: REASONING_EFFORT_LABELS[value]
          }))
        }
        : undefined
    });
  }

  private async revokeRememberedCommand(signature: string): Promise<void> {
    const updated = revokeRememberedCommand(this.getRememberedCommands(), signature);
    await this.extensionContext.workspaceState.update(REMEMBERED_COMMANDS_STORAGE_KEY, updated);
    this.postSettingsState();
  }

  /** Save one form after validating every section; unchanged fields keep inheriting their defaults. */
  private async saveSettings(settings: DevMateSettingsSubmission): Promise<void> {
    try {
      const scope = settings.scope ?? this.configuration.scope;
      if (scope !== 'global' && scope !== 'workspace'
        || scope === 'workspace' && !vscode.workspace.workspaceFolders?.length) {
        throw new Error('Choose an available settings scope.');
      }
      this.configuration.scope = scope;
      // Accept the old form during an upgrade, but persist request settings in one place.
      const configuration = settings.configuration ?? {
        ...this.configuration.overrides,
        timeoutSeconds: settings.timeoutSeconds, commandTimeoutSeconds: settings.commandTimeoutSeconds,
        toolCallLimit: settings.toolCallLimit, maxTokens: settings.maxTokens, temperature: settings.temperature
      };
      const issue = validateConfigurationOverrides(configuration);
      if (issue) throw new Error(issue);
      const agentTools = settings.agentTools ?? this.getAgentToolOverrides(scope);
      if (!agentTools || typeof agentTools !== 'object' || Array.isArray(agentTools)) {
        throw new Error('Tool limits must be a settings object.');
      }
      const normalizedTools = normalizeAgentToolSettings(agentTools);
      if (Object.entries(agentTools).some(([key, value]) =>
        !AGENT_TOOL_SETTING_NAMES.includes(key as keyof AgentToolSettings)
        || value !== normalizedTools[key as keyof AgentToolSettings])) {
        throw new Error('The tool limits contain an invalid value.');
      }
      const policy = parseFilePermissionPolicy(settings.policy);
      const target = scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      const config = vscode.workspace.getConfiguration('devMate');
      await this.configuration.saveConfiguration(scope, configuration);
      for (const key of AGENT_TOOL_SETTING_NAMES) {
        const saved = config.inspect(key);
        const previous = scope === 'workspace' ? saved?.workspaceValue : saved?.globalValue;
        if (previous !== agentTools[key]) await config.update(key, agentTools[key], target);
      }
      await this.extensionContext.workspaceState.update(FILE_PERMISSION_POLICY_STORAGE_KEY, policy);
      this.configuration.postState();
      this.postPermissionPolicyState();
      this.postSettingsState();
      await this.postLlmProfileState();
      this.postMessage({ command: 'settingsSaved' });
    } catch (error) {
      this.postMessage({ command: 'settingsError', message: error instanceof Error ? error.message : 'DevMate could not save the settings.' });
    }
  }

  /** Only explicitly stored tool values belong in a save; inherited values must remain inherited. */
  private getAgentToolOverrides(scope: ConfigurationScope): Partial<AgentToolSettings> {
    const config = vscode.workspace.getConfiguration('devMate');
    const result: Partial<AgentToolSettings> = {};
    for (const key of AGENT_TOOL_SETTING_NAMES) {
      const inspected = config.inspect<number>(key);
      const value = scope === 'workspace' ? inspected?.workspaceValue : inspected?.globalValue;
      if (typeof value === 'number' && Number.isFinite(value)) {
        result[key] = normalizeAgentToolSettings({ [key]: value })[key];
      }
    }
    return result;
  }

  private getAgentToolSettings(scope: ConfigurationScope = 'workspace'): AgentToolSettings {
    const config = vscode.workspace.getConfiguration('devMate');
    const read = (name: string, fallback: number) => scope === 'workspace'
      ? config.get<number>(name, fallback)
      : config.inspect<number>(name)?.globalValue ?? fallback;
    return normalizeAgentToolSettings({
      readFileMaxLines: read('readFileMaxLines', DEFAULT_READ_FILE_MAX_LINES),
      listFilesMaxResults: read(
        'listFilesMaxResults',
        DEFAULT_LIST_FILES_MAX_RESULTS
      ),
      searchCodeMaxResults: read(
        'searchCodeMaxResults',
        DEFAULT_SEARCH_CODE_MAX_RESULTS
      ),
      diagnosticsMaxResults: read(
        'diagnosticsMaxResults',
        DEFAULT_DIAGNOSTICS_MAX_RESULTS
      ),
      terminalErrorsMaxResults: read(
        'terminalErrorsMaxResults',
        DEFAULT_TERMINAL_ERRORS_MAX_RESULTS
      ),
      codeNavigationMaxResults: read(
        'codeNavigationMaxResults',
        DEFAULT_CODE_NAVIGATION_MAX_RESULTS
      )
    });
  }

  private postPermissionPolicyState(): void {
    const policy = this.getPermissionPolicy();
    this.postMessage({
      command: 'permissionPolicyUpdated',
      policy
    });
  }

  private postSettingsState(): void {
    this.postMessage({ command: 'settingsUpdated', settings: {
      ...this.configuration.base(this.configuration.scope), scope: this.configuration.scope,
      agentTools: this.getAgentToolSettings(this.configuration.scope),
      agentToolOverrides: this.getAgentToolOverrides(this.configuration.scope),
      inheritedAgentTools: this.configuration.scope === 'workspace' ? this.getAgentToolSettings('global') : normalizeAgentToolSettings({}),
      rememberedCommands: this.getRememberedCommands(),
      workspaceTrusted: vscode.workspace.isTrusted
    } });
  }

  /** This permission lives outside settings.json, so project edits cannot grant command access. */
  private postCommandAccessState(): void {
    this.postMessage({ command: 'commandAccessUpdated',
      access: parseCommandAccess(this.extensionContext.workspaceState.get(COMMAND_ACCESS_STORAGE_KEY)),
      workspaceTrusted: vscode.workspace.isTrusted,
      workspaceAvailable: Boolean(vscode.workspace.workspaceFolders?.length) });
  }

  private async setCommandAccess(access: CommandAccess): Promise<void> {
    if (access !== 'standard' && access !== 'extended') { this.postCommandAccessState(); return; }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (this.activeRequest || this.auxiliaryBusy || !folder || !vscode.workspace.isTrusted) {
      this.postStatus('Open a trusted workspace and finish the current request before changing command access.', 'warning');
      this.postCommandAccessState(); return;
    }
    this.auxiliaryBusy = true;
    try {
      const previous = parseCommandAccess(this.extensionContext.workspaceState.get(COMMAND_ACCESS_STORAGE_KEY));
      if (access === 'extended' && previous !== access) {
        const accepted = await vscode.window.showWarningMessage(
          'Enable Extended commands for this workspace? DevMate can request project scripts, formatters, dependency installation and local servers. Each command asks for approval. Commands run with your user permissions and are not sandboxed; Undo cannot reverse their effects.',
          { modal: true }, 'Enable Extended');
        if (accepted !== 'Enable Extended') return;
      }
      if (!vscode.workspace.isTrusted || vscode.workspace.workspaceFolders?.[0]?.uri.toString() !== folder.uri.toString()) {
        throw new Error('The trusted workspace changed while command access was being reviewed.');
      }
      await this.extensionContext.workspaceState.update(COMMAND_ACCESS_STORAGE_KEY, access);
      if (access === 'standard') await this.tools.stopAllManagedCommands();
    } catch (error) {
      this.postStatus(error instanceof Error ? error.message : 'Could not change command access.', 'error');
    } finally {
      this.auxiliaryBusy = false;
      this.postCommandAccessState();
    }
  }

  private postBackendStatus(): void {
    const status = this.backendManager.status;
    this.postMessage({
      command: 'backendStatusUpdated',
      status,
      label: backendStatusLabel(status)
    });
  }

  private async testLlmProfile(profileId: string): Promise<void> {
    if (this.activeRequest) {
      this.postMessage({ command: 'modelTestResult', profileId, result: {
        connection: 'Not tested', tools: 'Not tested', streaming: 'Not tested', reasoning: 'Not tested',
        detail: 'Finish or cancel the current request first.' } });
      return;
    }
    this.auxiliaryBusy = true;
    const controller = new AbortController();
    this.auxiliaryAbort = controller;
    try {
      const profile = this.getLlmProfiles().find(item => item.id === profileId);
      if (!profile) throw new Error('Save the model profile before testing it.');
      const apiKey = profile.provider === 'openai' ? await this.extensionContext.secrets.get(secretKeyForProfile(profile.id)) : undefined;
      if (profile.provider === 'openai' && !apiKey) throw new Error('Add an API key to this profile before testing it.');
      if (!await this.backendManager.start()) throw new Error(this.backendManager.status.detail);
      const settings = normalizeAgentConfiguration({ ...this.configuration.base(), ...profile.settings,
        reasoningEffort: this.getReasoningEffortPreferences()[profile.id] ?? profile.settings?.reasoningEffort ?? this.configuration.base().reasoningEffort });
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: `Testing ${profile.name} with synthetic input`, cancellable: true }, async (_progress, token) => {
        const subscription = token.onCancellationRequested(() => controller.abort());
        try {
          return await testModelConfiguration(getBackendUrl(), {
            provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl, api: profile.api,
            maxTokens: settings.maxTokens, temperature: settings.temperature,
            timeoutSeconds: settings.timeoutSeconds, reasoningEffort: settings.reasoningEffort
          }, apiKey, controller.signal);
        } finally { subscription.dispose(); }
      });
      this.postMessage({ command: 'modelTestResult', profileId, result });
    } catch (error) {
      this.postMessage({ command: 'modelTestResult', profileId, result: {
        connection: 'Not confirmed', tools: 'Not confirmed', streaming: 'Not confirmed', reasoning: 'Not confirmed',
        detail: error instanceof Error ? error.message : 'Could not finish the model test.' } });
    } finally { this.auxiliaryBusy = false; this.auxiliaryAbort = undefined; }
  }

  private async postUndoState(): Promise<void> {
    try { this.postMessage({ command: 'undoState', ...await this.tools.getUndoState() }); }
    catch { this.postMessage({ command: 'undoState', available: false, label: 'Undo is unavailable', files: 0 }); }
  }

  private async undoLastRequest(): Promise<void> {
    if (this.activeRequest) { this.postStatus('Finish or cancel the current request before undoing it.', 'warning'); await this.postUndoState(); return; }
    this.auxiliaryBusy = true;
    try {
      if (await this.tools.undoLastRequest()) {
        // A checkpoint describes the changed filesystem and must not resume after reverting it.
        await this.clearAgentCheckpoint();
        this.postStatus('Undid the last request’s direct file changes.');
      }
    } catch (error) {
      this.postStatus(error instanceof Error ? error.message : 'Could not undo the last request.', 'error');
    } finally { this.auxiliaryBusy = false; await this.postUndoState(); }
  }

  private postStatus(text: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    this.postMessage({ command: 'status', text, level });
  }

  private postMessage(message: unknown): void {
    this.view?.webview.postMessage(message);
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

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.tools.provideTextDocumentContent(uri);
  }

  /** The request flow has three stages: prepare context, run the model/tools, then save and display the result. */
  private async answerQuestion(
    message: Extract<WebviewMessage, { command: 'ask' }>,
    signal: AbortSignal,
    resumedCheckpoint?: AgentRunCheckpoint
  ): Promise<void> {
    const input = await this.prepareRequest(message, signal, resumedCheckpoint);
    if (!input) {
      return;
    }
    const result = await this.runner.run(input, signal, resumedCheckpoint);
    if (!result) {
      return;
    }
    await this.finalizeRequest(input.question, result, signal);
  }

  /**
   * Check the session and model profile, start the backend, and collect fresh context.
   * Return no input when setup fails or the user cancels; the UI has already been told why.
   */
  private async prepareRequest(
    message: Extract<WebviewMessage, { command: 'ask' }>,
    signal: AbortSignal,
    resumedCheckpoint?: AgentRunCheckpoint
  ): Promise<AgentRunInput | undefined> {
    const question = message.question.trim();
    if (!question) {
      this.postRequestFailure('Enter a question before asking.', { level: 'warning' });
      return;
    }

    const activeSession = activeConversationSession(this.sessionStore);
    if (!activeSession || !sessionBelongsToWorkspace(activeSession, this.workspaceContext.getConversationWorkspace())) {
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
    // A resumed run may follow manual file edits, so collect context again instead of reusing a saved snapshot.
    const configuration = normalizeAgentConfiguration(resumedCheckpoint?.configuration ?? this.configuration.effective(activeProfile));
    const instructions = resumedCheckpoint?.instructions ?? this.configuration.effective(activeProfile).instructions;
    if (instructions.length > 12_000) throw new Error('Project instructions exceed 12000 characters. Shorten them before asking.');
    configuration.instructions = instructions;
    const collectedScope = await this.workspaceContext.collectScope(message.scope.kind, question, configuration);
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

    const { maxTokens, temperature, toolCallLimit, timeoutSeconds: modelTimeoutSeconds } = configuration;

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

    this.tools.beginRequest(Boolean(resumedCheckpoint));
    this.activeRunConfiguration = configuration;
    return {
      question,
      configuration,
      instructions,
      mode: message.mode,
      scopeKind: message.scope.kind,
      scope: collectedScope.apiScope,
      sessionId: activeSession.id,
      getReasoningEffort: () => configuration.reasoningEffort,
      providerApiKey,
      toolCallLimit,
      settings: {
        provider: activeProfile.provider,
        api: activeProfile.api ?? 'auto',
        model: activeProfile.model,
        baseUrl: activeProfile.baseUrl,
        maxTokens,
        temperature,
        reasoningEffort: configuration.reasoningEffort,
        timeoutSeconds: modelTimeoutSeconds
      }
    };
  }

  /**
   * Review any remaining proposed edits, combine them with completed tool changes, then save the chat turn.
   * The checkpoint is cleared only once the final response has been assembled and session persistence attempted.
   */
  private async finalizeRequest(question: string, result: AgentRunResult, signal: AbortSignal): Promise<void> {
    const { response: finalData, toolHistory, toolUsedFiles } = result;
    if (this.finishCancelledRequest(signal)) {
      return;
    }

    let changeOutcome = '';
    try {
      const fileChanges = validateFileChanges(finalData.changes ?? []);
      if (fileChanges.length > 0) {
        const selected = this.activeRunConfiguration ?? this.configuration.effective();
        const usedEdits = toolHistory.filter(step => !step.isError
          && ['create_file', 'edit_file', 'delete_file', 'rename_file', 'move_file'].includes(step.name)).length;
        if (fileChanges.length > selected.maxFileEdits - usedEdits) {
          throw new Error('These proposed changes exceed the remaining file-edit budget.');
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) throw new Error('Open a project before applying file changes.');
        for (const change of fileChanges) {
          let exists = true;
          try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, change.path)); }
          catch (error) {
            if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') exists = false;
            else throw error;
          }
          if (!selected.enabledTools.includes(exists ? 'edit_file' : 'create_file')) {
            throw new Error(`This configuration does not allow ${exists ? 'editing' : 'creating'} ${change.path}.`);
          }
        }
        changeOutcome = await this.tools.confirmAndApplyFileChanges(
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
        const diffId = this.tools.diffIdForPath(change.path);
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
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getBackendUrl(): string {
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

const AGENT_TOOL_SETTING_NAMES: Array<keyof AgentToolSettings> = ['readFileMaxLines', 'listFilesMaxResults',
  'searchCodeMaxResults', 'diagnosticsMaxResults', 'terminalErrorsMaxResults', 'codeNavigationMaxResults'];

const configurationMessages = new Set(['openConfiguration', 'setConfigurationScope', 'saveConfiguration']);
