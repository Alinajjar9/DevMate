import type { ConversationTurn } from './api/types';
import type { FileChangeSummaryItem } from './fileTools';
import type { ConversationSessionRepository } from './sessionRepository';
import {
  activeConversationSession,
  activeSessionModelHistory,
  addConversationSession,
  appendConversationSessionTurn,
  appendConversationSessionUserMessage,
  createEmptyConversationSessionStore,
  deleteConversationSession,
  renameConversationSession,
  selectConversationSession
} from './sessions';
import type {
  ConversationSession,
  ConversationSessionStore,
  ConversationWorkspace
} from './sessions';

export type SessionStorageIssue = {
  message: string;
  notifyUser: boolean;
};

export type SessionStorageIssueReporter = (issue: SessionStorageIssue) => void;

// This controller owns the in-memory chat store and keeps repository writes in order.
export class SessionController {
  private currentStore: ConversationSessionStore;
  private loaded = false;
  private revision = 0;
  private readonly dirtySessionIds = new Set<string>();
  private readonly deletedSessionIds = new Set<string>();
  private synchronization?: Promise<boolean>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: ConversationSessionRepository,
    private readonly reportIssue: SessionStorageIssueReporter = () => undefined,
    initialStore: ConversationSessionStore = createEmptyConversationSessionStore()
  ) {
    this.currentStore = initialStore;
  }

  get store(): ConversationSessionStore {
    return this.currentStore;
  }

  get sessionsLoaded(): boolean {
    return this.loaded;
  }

  get hasPendingChanges(): boolean {
    return this.dirtySessionIds.size > 0 || this.deletedSessionIds.size > 0;
  }

  activeSession(): ConversationSession | undefined {
    return activeConversationSession(this.currentStore);
  }

  session(sessionId: string): ConversationSession | undefined {
    return this.currentStore.sessions.find((candidate) => candidate.id === sessionId);
  }

  modelHistory(): ConversationTurn[] {
    return activeSessionModelHistory(this.currentStore);
  }

  synchronize(workspace: ConversationWorkspace | undefined): Promise<boolean> {
    if (this.synchronization) {
      return this.synchronization;
    }
    const operation = this.runSynchronization(workspace)
      .catch((error) => {
        this.reportIssue({
          message: error instanceof Error ? error.message : 'session synchronization failed.',
          notifyUser: false
        });
        return false;
      })
      .finally(() => {
        if (this.synchronization === operation) {
          this.synchronization = undefined;
        }
      });
    this.synchronization = operation;
    return operation;
  }

  async create(
    sessionId: string,
    now: number,
    workspace: ConversationWorkspace
  ): Promise<ConversationSession | undefined> {
    const previousSessionIds = new Set(
      this.currentStore.sessions.map((session) => session.id)
    );
    this.replaceStore(addConversationSession(this.currentStore, sessionId, now, workspace));
    await this.persist(this.currentStore.activeSessionId);
    for (const previousSessionId of previousSessionIds) {
      if (!this.session(previousSessionId)) {
        await this.deletePersisted(previousSessionId);
      }
    }
    return this.activeSession();
  }

  select(sessionId: string): boolean {
    const nextStore = selectConversationSession(this.currentStore, sessionId);
    if (nextStore === this.currentStore) {
      return false;
    }
    this.currentStore = nextStore;
    return true;
  }

  async rename(sessionId: string, title: string): Promise<boolean> {
    const nextStore = renameConversationSession(this.currentStore, sessionId, title);
    if (nextStore === this.currentStore) {
      return false;
    }
    this.replaceStore(nextStore);
    await this.persist(sessionId);
    return true;
  }

  async delete(sessionId: string): Promise<boolean> {
    const nextStore = deleteConversationSession(this.currentStore, sessionId);
    if (nextStore === this.currentStore) {
      return false;
    }
    this.replaceStore(nextStore);
    await this.deletePersisted(sessionId);
    return true;
  }

  async appendUserMessage(user: string, now: number): Promise<boolean> {
    const sessionId = this.currentStore.activeSessionId;
    const nextStore = appendConversationSessionUserMessage(this.currentStore, user, now);
    if (nextStore === this.currentStore) {
      return false;
    }
    this.replaceStore(nextStore);
    await this.persist(sessionId);
    return true;
  }

  async appendTurn(
    user: string,
    assistant: string,
    now: number,
    fileChanges: FileChangeSummaryItem[] = []
  ): Promise<boolean> {
    const sessionId = this.currentStore.activeSessionId;
    const nextStore = appendConversationSessionTurn(
      this.currentStore,
      user,
      assistant,
      now,
      fileChanges
    );
    if (nextStore === this.currentStore) {
      return false;
    }
    this.replaceStore(nextStore);
    await this.persist(sessionId);
    return true;
  }

  async persist(sessionId: string): Promise<boolean> {
    const session = this.session(sessionId);
    if (!session) {
      return false;
    }
    const signature = JSON.stringify(session);
    this.dirtySessionIds.add(sessionId);
    this.deletedSessionIds.delete(sessionId);
    const result = await this.enqueueWrite(() => this.repository.saveSessions([session]));
    if (result.kind === 'completed') {
      const current = this.session(sessionId);
      if (current && JSON.stringify(current) === signature) {
        this.dirtySessionIds.delete(sessionId);
      }
      return true;
    }
    if (result.kind !== 'cancelled') {
      this.reportIssue({ message: result.message, notifyUser: true });
    }
    return false;
  }

  private async runSynchronization(
    workspace: ConversationWorkspace | undefined
  ): Promise<boolean> {
    if (!workspace) {
      this.loaded = true;
      return false;
    }
    let stateChanged = false;
    if (!this.loaded) {
      const revision = this.revision;
      const result = await this.repository.loadWorkspace(workspace.id);
      if (result.kind !== 'completed') {
        if (result.kind !== 'cancelled') {
          this.reportIssue({ message: result.message, notifyUser: false });
        }
        return false;
      }
      this.loaded = true;
      if (revision === this.revision && !this.hasPendingChanges) {
        this.currentStore = result.value;
      }
      stateChanged = true;
    }
    await this.flushPendingChanges();
    return stateChanged;
  }

  private replaceStore(store: ConversationSessionStore): void {
    this.currentStore = store;
    this.revision += 1;
  }

  private async deletePersisted(sessionId: string): Promise<boolean> {
    this.dirtySessionIds.delete(sessionId);
    this.deletedSessionIds.add(sessionId);
    const result = await this.enqueueWrite(() => this.repository.deleteSession(sessionId));
    if (result.kind === 'completed') {
      if (!this.session(sessionId)) {
        this.deletedSessionIds.delete(sessionId);
      }
      return true;
    }
    if (result.kind !== 'cancelled') {
      this.reportIssue({ message: result.message, notifyUser: true });
    }
    return false;
  }

  private async flushPendingChanges(): Promise<void> {
    const sessions = [...this.dirtySessionIds]
      .map((sessionId) => this.session(sessionId))
      .filter((session) => session !== undefined);
    if (sessions.length > 0) {
      const signatures = new Map(
        sessions.map((session) => [session.id, JSON.stringify(session)])
      );
      const result = await this.enqueueWrite(() => this.repository.saveSessions(sessions));
      if (result.kind === 'completed') {
        for (const [sessionId, signature] of signatures) {
          const current = this.session(sessionId);
          if (current && JSON.stringify(current) === signature) {
            this.dirtySessionIds.delete(sessionId);
          }
        }
      } else if (result.kind !== 'cancelled') {
        this.reportIssue({ message: result.message, notifyUser: false });
      }
    }

    for (const sessionId of [...this.deletedSessionIds]) {
      const result = await this.enqueueWrite(() => this.repository.deleteSession(sessionId));
      if (result.kind === 'completed') {
        if (!this.session(sessionId)) {
          this.deletedSessionIds.delete(sessionId);
        }
      } else if (result.kind !== 'cancelled') {
        this.reportIssue({ message: result.message, notifyUser: false });
        break;
      }
    }
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
