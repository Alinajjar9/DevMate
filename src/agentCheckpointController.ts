import {
  AGENT_CHECKPOINT_STORAGE_KEY,
  parseAgentRunCheckpoint
} from './sessions';
import type { AgentRunCheckpoint } from './sessions';
import type { TokenUsage } from './api/types';

export type AgentCheckpointViewState = {
  available: boolean;
  used: number;
  limit: number;
  tokenUsage?: TokenUsage;
};

export type AgentCheckpointPersistence = {
  readState(key: string): unknown;
  writeState(key: string, value: unknown): PromiseLike<void>;
};

export type AgentCheckpointContext = {
  workspaceId(): string | undefined;
  activeSessionId(): string | undefined;
  toolCallLimit(): number;
  stateChanged(state: AgentCheckpointViewState): void;
  reportWarning(message: string): void;
};

// This controller stores an unfinished run and only exposes it to the chat it belongs to.
export class AgentCheckpointController {
  private checkpoint?: AgentRunCheckpoint;

  constructor(
    private readonly persistence: AgentCheckpointPersistence,
    private readonly context: AgentCheckpointContext,
    now = Date.now()
  ) {
    this.checkpoint = parseAgentRunCheckpoint(
      persistence.readState(AGENT_CHECKPOINT_STORAGE_KEY),
      now
    );
  }

  current(): AgentRunCheckpoint | undefined {
    const workspaceId = this.context.workspaceId();
    const sessionId = this.context.activeSessionId();
    if (!workspaceId
      || !sessionId
      || this.checkpoint?.workspaceId !== workspaceId
      || this.checkpoint.sessionId !== sessionId) {
      return undefined;
    }
    return this.checkpoint;
  }

  postState(): void {
    const checkpoint = this.current();
    this.context.stateChanged({
      available: Boolean(checkpoint),
      used: checkpoint?.toolHistory.length ?? 0,
      limit: this.context.toolCallLimit(),
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

  async save(checkpoint: AgentRunCheckpoint): Promise<void> {
    this.checkpoint = checkpoint;
    try {
      await this.persistence.writeState(AGENT_CHECKPOINT_STORAGE_KEY, checkpoint);
    } catch {
      this.context.reportWarning(
        'DevMate could not persist the unfinished agent checkpoint.'
      );
    }
    this.postState();
  }

  async clear(): Promise<void> {
    this.checkpoint = undefined;
    try {
      await this.persistence.writeState(AGENT_CHECKPOINT_STORAGE_KEY, undefined);
    } catch {
      this.context.reportWarning(
        'DevMate could not remove the completed agent checkpoint.'
      );
    }
    this.postState();
  }

  async clearForSession(sessionId: string): Promise<void> {
    if (this.checkpoint?.sessionId === sessionId) {
      await this.clear();
    }
  }
}
