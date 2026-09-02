import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { SessionController } from './sessionController';
import { sessionBelongsToWorkspace } from './sessions';
import type { ExtensionToWebviewMessage } from './webviewProtocol';
import type { WorkspaceContext } from './workspaceContext';

export interface SessionPresenterCallbacks {
  isRequestActive(): boolean;
  postMessage(message: ExtensionToWebviewMessage): void;
  postStatus(text: string, level?: 'info' | 'warning' | 'error'): void;
  postCheckpointState(): void;
  clearCheckpointForSession(sessionId: string): Promise<void>;
}

// This presenter owns session dialogs and converts session state into chat UI messages.
export class SessionPresenter {
  constructor(
    private readonly sessions: SessionController,
    private readonly workspaceContext: WorkspaceContext,
    private readonly callbacks: SessionPresenterCallbacks,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => number = Date.now
  ) {}

  async synchronize(): Promise<void> {
    const workspace = this.workspaceContext.getConversationWorkspace();
    if (await this.sessions.synchronize(workspace)) {
      this.postState(true);
    }
  }

  async createSession(): Promise<void> {
    if (!this.canChangeSession()) {
      return;
    }
    const workspace = this.workspaceContext.getConversationWorkspace();
    if (!workspace) {
      this.postWarning('Open a project folder before starting a DevMate session.');
      return;
    }
    await this.sessions.create(this.createId(), this.now(), workspace);
    this.postState(true, true);
  }

  async selectSession(sessionId: string): Promise<void> {
    if (!this.canChangeSession()) {
      return;
    }
    const session = this.sessions.session(sessionId);
    if (!session) {
      return;
    }
    const workspace = this.workspaceContext.getConversationWorkspace();
    if (!sessionBelongsToWorkspace(session, workspace)) {
      this.postWarning(
        `This session belongs to “${session.workspaceName}”. Open that project to continue it.`
      );
      return;
    }
    this.sessions.select(sessionId);
    this.postState(true, true);
  }

  async renameSession(sessionId: string): Promise<void> {
    if (!this.canChangeSession()) {
      return;
    }
    const session = this.sessions.session(sessionId);
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
    if (title === undefined || this.callbacks.isRequestActive()) {
      return;
    }
    await this.sessions.rename(sessionId, title);
    this.postState(false);
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.canChangeSession()) {
      return;
    }
    const session = this.sessions.session(sessionId);
    if (!session) {
      return;
    }
    const decision = await vscode.window.showWarningMessage(
      `Delete “${session.title}”? This permanently removes its saved messages from “${session.workspaceName}”.`,
      { modal: true },
      'Delete'
    );
    if (decision !== 'Delete' || this.callbacks.isRequestActive()) {
      return;
    }
    await this.sessions.delete(sessionId);
    await this.callbacks.clearCheckpointForSession(sessionId);
    this.postState(false);
  }

  postState(includeMessages: boolean, openChat = false): void {
    const store = this.sessions.store;
    const activeSession = this.sessions.activeSession();
    const workspace = this.workspaceContext.getConversationWorkspace();
    this.callbacks.postMessage({
      command: 'sessionsUpdated',
      activeSessionId: store.activeSessionId,
      activeTitle: activeSession?.title ?? 'Sessions',
      currentWorkspaceName: workspace?.name ?? 'No project open',
      openChat,
      sessions: store.sessions.map((session) => ({
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
            { role: 'user' as const, text: turn.user },
            ...(turn.assistant
              ? [{
                role: 'assistant' as const,
                text: turn.assistant,
                fileChanges: turn.fileChanges ?? []
              }]
              : [])
          ])
        }
        : {})
    });
    this.callbacks.postCheckpointState();
  }

  private canChangeSession(): boolean {
    if (!this.callbacks.isRequestActive()) {
      return true;
    }
    this.callbacks.postStatus(
      'Wait for the active request to finish before changing sessions.',
      'warning'
    );
    return false;
  }

  private postWarning(message: string): void {
    this.callbacks.postMessage({ command: 'sessionProjectWarning', message });
  }
}
