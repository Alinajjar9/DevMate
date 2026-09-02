// Coordinate one user question: validate, collect context, compact history,
// run the agent, apply approved changes, and save the final reply.

import type {
  ChatMemorySummaryContent,
  LlmSettings
} from '../api/types';
import type { AgentCheckpointController } from '../agent/agentCheckpointController';
import type { AgentRunController } from '../agent/agentRunController';
import type { ChatCompactionController } from '../sessions/chatCompaction';
import {
  collectFileChangeSummary,
  parseAppliedFileChangeOutcome,
  validateFileChanges
} from '../workspace/fileTools';
import type { ValidatedFileChange } from '../workspace/fileTools';
import type { LlmProfile, ReasoningEffort } from '../settings/llmProfiles';
import { reasoningEffortForProfile } from '../settings/llmProfiles';
import type { SessionController } from '../sessions/sessionController';
import {
  sessionBelongsToWorkspace,
  sessionModelHistoryAfter
} from '../sessions/sessions';
import type { AgentRunCheckpoint, ConversationWorkspace } from '../sessions/sessions';
import type { DevMateConfigurationState } from '../settings/settingsController';
import type { CollectedScope, ScopeKind } from '../context/workspaceContext';
import type {
  AskWebviewMessage,
  ExtensionToWebviewMessage
} from './webviewProtocol';

type RequestBackend = {
  start(): Promise<boolean>;
  detail(): string;
  token(): string | undefined;
  url(): string;
  appendLog(message: string): void;
};

type RequestContext = {
  workspace(): ConversationWorkspace | undefined;
  collect(
    scope: ScopeKind,
    question: string,
    signal: AbortSignal
  ): Promise<CollectedScope | undefined>;
};

type RequestProfiles = {
  active(): LlmProfile | undefined;
  reasoningPreferences(): Record<string, ReasoningEffort>;
  apiKey(profileId: string): PromiseLike<string | undefined>;
  showForm(profileId?: string): Promise<void>;
};

type RequestChanges = {
  beginRequest(): void;
  apply(
    changes: ValidatedFileChange[],
    summary: string,
    signal: AbortSignal
  ): Promise<string>;
  completedDiffId(filePath: string): string | undefined;
};

type RequestEvents = {
  postMessage(message: ExtensionToWebviewMessage): void;
  postStatus(text: string, level?: 'info' | 'warning' | 'error'): void;
  postFailure(
    message: string,
    options?: { level?: 'warning' | 'error'; retryable?: boolean }
  ): void;
  finishCancellation(signal: AbortSignal): boolean;
  sessionStateChanged(): void;
};

export type ChatRequestDependencies = {
  backend: RequestBackend;
  context: RequestContext;
  profiles: RequestProfiles;
  settings: { state(): DevMateConfigurationState };
  sessions: Pick<
    SessionController,
    'activeSession' | 'appendUserMessage' | 'modelHistory' | 'appendTurn'
  >;
  compaction: Pick<ChatCompactionController, 'compactIfNeeded'>;
  agentRuns: Pick<AgentRunController, 'run'>;
  checkpoints: Pick<AgentCheckpointController, 'current' | 'clear'>;
  changes: RequestChanges;
  events: RequestEvents;
  now(): number;
};

// This controller coordinates one chat request from validation to saved response.
export class ChatRequestController {
  constructor(
    private readonly dependencies: ChatRequestDependencies,
    private readonly delay: (milliseconds: number) => Promise<void> = wait
  ) {}

  async answer(
    message: AskWebviewMessage,
    signal: AbortSignal,
    resumedCheckpoint?: AgentRunCheckpoint
  ): Promise<void> {
    const {
      backend,
      context,
      profiles,
      settings,
      sessions,
      compaction,
      agentRuns,
      checkpoints,
      changes,
      events
    } = this.dependencies;
    const question = message.question.trim();
    if (!question) {
      events.postFailure('Enter a question before asking.', { level: 'warning' });
      return;
    }
    if (!resumedCheckpoint) {
      changes.beginRequest();
    }

    const activeSession = sessions.activeSession();
    const conversationWorkspace = context.workspace();
    if (
      !activeSession
      || !conversationWorkspace
      || !sessionBelongsToWorkspace(activeSession, conversationWorkspace)
    ) {
      events.postFailure(
        'Choose a session for the currently open project before asking.',
        { level: 'warning' }
      );
      return;
    }

    // Save the question first so provider failures do not erase the user's pending turn.
    if (!resumedCheckpoint && message.isNewTurn !== false) {
      await sessions.appendUserMessage(question, this.dependencies.now());
      events.sessionStateChanged();
    }

    const activeProfile = profiles.active();
    if (!activeProfile) {
      events.postFailure('Add a model profile before asking.', { level: 'warning' });
      await profiles.showForm();
      return;
    }

    events.postStatus('Checking local backend');
    if (!await backend.start()) {
      events.postFailure(backend.detail(), { level: 'warning' });
      return;
    }
    // Do not collect/send source or retrieve a provider key until the backend is authenticated.
    const backendToken = backend.token();
    if (!backendToken) {
      events.postFailure(
        'DevMate could not establish an authenticated backend connection.',
        { level: 'warning', retryable: true }
      );
      return;
    }

    events.postStatus('Collecting context');
    const collectedScope = await context.collect(message.scope.kind, question, signal);
    if (events.finishCancellation(signal)) {
      return;
    }
    if (!collectedScope) {
      events.postFailure(
        message.scope.kind === 'selection' ? 'Select code first.' : 'Open a file first.',
        { level: 'warning' }
      );
      return;
    }
    if (!resumedCheckpoint && checkpoints.current()) {
      await checkpoints.clear();
    }

    events.postMessage({ command: 'scopeUpdated', scope: collectedScope.info });
    await this.delay(250);
    if (events.finishCancellation(signal)) {
      return;
    }
    events.postStatus('Generating answer');
    await this.delay(350);
    if (events.finishCancellation(signal)) {
      return;
    }

    const configuration = settings.state();
    const {
      maxTokens,
      temperature,
      toolCallLimit,
      maxInputContextTokens,
      timeoutSeconds: modelTimeoutSeconds
    } = configuration;
    const llmSettings: LlmSettings = {
      provider: activeProfile.provider,
      model: activeProfile.model,
      baseUrl: activeProfile.baseUrl,
      maxTokens,
      temperature,
      reasoningEffort: reasoningEffortForProfile(
        activeProfile,
        profiles.reasoningPreferences()
      ),
      timeoutSeconds: modelTimeoutSeconds
    };

    const providerApiKey = activeProfile.provider === 'openai'
      ? await profiles.apiKey(activeProfile.id)
      : undefined;
    if (activeProfile.provider === 'openai' && !providerApiKey) {
      events.postFailure('The selected model profile is missing an API key.', {
        level: 'warning',
        retryable: true
      });
      await profiles.showForm(activeProfile.id);
      return;
    }

    let conversationHistory = sessions.modelHistory();
    let conversationSummary: ChatMemorySummaryContent | undefined;
    const currentSession = sessions.activeSession();
    // Compaction may fail without blocking the question; its previous summary can still be used.
    if (currentSession) {
      const compactionResult = await compaction.compactIfNeeded({
        session: currentSession,
        question,
        scope: collectedScope.apiScope,
        modelContextWindowTokens: activeProfile.contextWindowTokens,
        maxInputContextTokens,
        settings: llmSettings,
        access: {
          backendUrl: backend.url(),
          backendToken,
          providerApiKey
        }
      }, signal, () => events.postStatus('Compacting earlier chat context'));
      if (
        compactionResult.kind === 'cancelled'
        || events.finishCancellation(signal)
      ) {
        return;
      }
      if (compactionResult.kind === 'failed') {
        backend.appendLog(`[DevMate] Chat compaction: ${compactionResult.message}\n`);
      }
      // Replace only the model's older history with the summary, never the saved raw turns.
      if (compactionResult.summary) {
        conversationSummary = compactionResult.summary.content;
        conversationHistory = sessionModelHistoryAfter(
          currentSession,
          compactionResult.summary.lastCompactedTurn
        );
      }
    }

    const outcome = await agentRuns.run({
      question,
      mode: message.mode,
      scopeKind: message.scope.kind,
      scope: collectedScope.apiScope,
      conversationHistory,
      conversationSummary,
      modelContextWindowTokens: activeProfile.contextWindowTokens,
      maxInputContextTokens,
      settings: llmSettings,
      backendUrl: backend.url(),
      backendToken,
      providerApiKey,
      toolCallLimit,
      workspaceId: conversationWorkspace.id,
      sessionId: activeSession.id,
      resumedCheckpoint
    }, signal);
    if (outcome.kind === 'cancelled') {
      events.finishCancellation(signal);
      return;
    }
    if (outcome.kind === 'failed') {
      events.postFailure(outcome.message, { retryable: outcome.retryable });
      return;
    }

    if (events.finishCancellation(signal)) {
      return;
    }

    let changeOutcome = '';
    try {
      // Some providers return final file proposals instead of tools. They use the same safety path.
      const fileChanges = validateFileChanges(outcome.response.changes ?? []);
      if (fileChanges.length > 0) {
        changeOutcome = await changes.apply(
          fileChanges,
          outcome.response.answer,
          signal
        );
        if (
          signal.aborted
          && !changeOutcome.startsWith('Applied file changes:')
          && events.finishCancellation(signal)
        ) {
          return;
        }
      }
    } catch (error) {
      changeOutcome = error instanceof Error
        ? `Changes were not applied: ${error.message}`
        : 'Changes were not applied because the response was invalid.';
      events.postStatus(changeOutcome, 'error');
    }

    const appliedResponseChanges = parseAppliedFileChangeOutcome(changeOutcome);
    // Show changes that were actually applied, not every edit the model proposed.
    const fileChangeSummary = collectFileChangeSummary(
      outcome.toolHistory,
      appliedResponseChanges
    ).map((change) => {
      const diffId = changes.completedDiffId(change.path);
      return diffId ? { ...change, diffId } : change;
    });
    const changeNotice = changeOutcome.startsWith('Applied file changes:')
      ? changeOutcome.split('\n\n').slice(1).join('\n\n')
      : changeOutcome;
    const response = [
      formatAskResponse(
        outcome.response.answer,
        [...new Set([...outcome.response.usedFiles, ...outcome.toolUsedFiles])]
      ),
      changeNotice
    ].filter(Boolean).join('\n\n');

    await sessions.appendTurn(
      question,
      response,
      this.dependencies.now(),
      fileChangeSummary
    );
    await checkpoints.clear();

    // Publish completion only after the final conversation turn has been handed to persistence.
    events.postMessage({
      command: 'assistantResponse',
      response,
      fileChanges: fileChangeSummary
    });
    events.sessionStateChanged();
    events.postStatus('Ready');
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
