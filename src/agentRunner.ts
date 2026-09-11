import {
  agentToolCallSignature,
  boundedAgentToolHistoryArguments,
  compactAgentToolHistory,
  consecutiveAgentInspectionCalls,
  emptyResponseRecoveryAction,
  isDeferredAgentPlanAnswer,
  isFileMutationAgentTool,
  isReadOnlyAgentTool,
  isRetryableProviderFailure,
  MAX_AGENT_COMMAND_CALLS,
  MAX_AGENT_CONSECUTIVE_INSPECTIONS,
  MAX_AGENT_DEPENDENCY_INSTALLS,
  MAX_AGENT_FILE_MUTATIONS,
  normalizeAgentToolCallForWorkspace,
  parseAgentToolCall,
  PROVIDER_RETRY_DELAYS_MS,
  providerRetryDelay,
  summarizeAgentToolHistory,
  summarizedAgentToolArguments
} from './agentTools';
import type { AgentToolCall } from './agentTools';
import { ask, askStream } from './api/client';
import type {
  AgentToolStep,
  ApiResult,
  AskRequest,
  AskResponse,
  AskScope,
  AssistantMode,
  ConversationTurn,
  TokenUsage
} from './api/types';
import { MAX_TOTAL_CHANGE_CHARACTERS } from './fileTools';
import type { AgentRunCheckpoint, ConversationWorkspace } from './sessions';
import type { AgentToolExecution, ToolExecutor } from './toolExecutor';
import type { ScopeKind } from './workspaceContext';

export interface AgentRunInput {
  question: string;
  mode: AssistantMode;
  scopeKind: ScopeKind;
  scope: AskScope;
  settings: AskRequest['settings'];
  sessionId: string;
  getReasoningEffort(): AskRequest['settings']['reasoningEffort'];
  providerApiKey?: string;
  toolCallLimit: number;
}

export interface AgentRunnerEvents {
  postMessage(message: unknown): void;
  postStatus(text: string, level?: 'info' | 'warning' | 'error'): void;
  postRequestFailure(message: string, options?: { level?: 'warning' | 'error'; retryable?: boolean }): void;
  finishCancelledRequest(signal: AbortSignal): boolean;
  saveAgentCheckpoint(checkpoint: AgentRunCheckpoint): Promise<void>;
  getConversationWorkspace(): ConversationWorkspace | undefined;
  getConversationHistory(): ConversationTurn[];
  ensureBackendStarted(): Promise<boolean>;
  getBackendUrl(): string;
  getWorkspaceFolder(): { name: string; fsPath?: string } | undefined;
}

type ProviderAttempt = { result: ApiResult<AskResponse>; retriesExhausted: boolean };
type RunRecovery = { kind: 'retry' | 'stop' } | { kind: 'final'; response: AskResponse };

interface AgentRunState {
  toolHistory: AgentToolStep[];
  toolUsedFiles: Set<string>;
  toolSignatures: Map<string, { revision: number; executions: number }>;
  fileMutationCalls: number;
  mutationCharacters: number;
  commandCalls: number;
  dependencyInstallCalls: number;
  workspaceRevision: number;
  forceFinalAnswer: boolean;
  disableThinking: boolean;
  emptyResponseRecoveryAttempted: boolean;
  completedTokenUsage: TokenUsage;
  checkpointCreatedAt: number;
}

export interface AgentRunResult {
  response: AskResponse;
  toolHistory: AgentToolStep[];
  toolUsedFiles: Set<string>;
}

export type AgentRunTools = Pick<ToolExecutor,
  'enabledAgentTools' | 'executeAgentToolCall' | 'rejectedToolExecution' | 'postAgentToolActivity'>;

export type AgentTransport = { ask: typeof ask; askStream: typeof askStream };

/** Runs one bounded model/tool conversation; the chat view owns presentation and sessions. */
export class AgentRunner {
  constructor(
    private readonly tools: AgentRunTools,
    private readonly events: AgentRunnerEvents,
    private readonly transport: AgentTransport = { ask, askStream }
  ) {}

  /**
   * Run one question until the model answers, a guard stops it, or the user cancels.
   * A checkpoint restores completed tool work and counters; undefined means no final answer was produced.
   */
  async run(
    input: AgentRunInput,
    signal: AbortSignal,
    resumedCheckpoint?: AgentRunCheckpoint
  ): Promise<AgentRunResult | undefined> {
    const state = createRunState(resumedCheckpoint);
    this.events.postMessage({ command: 'toolUsageUpdated', used: state.toolHistory.length, limit: input.toolCallLimit });
    await this.persistCheckpoint(input, state);

    // Each pass finishes, performs a bounded recovery, or records a batch of project tools.
    while (true) {
      if (this.events.finishCancelledRequest(signal)) {
        return;
      }
      const request = this.createModelRequest(input, state);
      const providerAttempt = await this.requestModel(input, request, state, signal);
      if (this.events.finishCancelledRequest(signal)) {
        return;
      }

      const result = providerAttempt.result;
      if (result.status === 'error' || !result.data) {
        const recovery = await this.recoverProviderFailure(input, state, providerAttempt, request.forceFinalAnswer === true);
        if (recovery.kind === 'stop') {
          return;
        }
        if (recovery.kind === 'final') {
          return completedRun(recovery.response, state);
        }
        continue;
      }

      if (result.data.tokenUsage) {
        state.completedTokenUsage = addTokenUsage(state.completedTokenUsage, result.data.tokenUsage);
        this.events.postMessage({ command: 'tokenUsageUpdated', usage: state.completedTokenUsage });
      }
      const toolCalls = result.data.toolCalls ?? [];
      if (toolCalls.length === 0 && input.mode !== 'ideas' && isDeferredAgentPlanAnswer(result.data.answer)) {
        const recovery = await this.recoverDeferredAnswer(input, state, request.forceFinalAnswer === true);
        if (recovery.kind === 'stop') {
          return;
        }
        if (recovery.kind === 'final') {
          return completedRun(recovery.response, state);
        }
        continue;
      }
      if (toolCalls.length === 0) {
        return completedRun(result.data, state);
      }
      if (!request.enabledTools?.length) {
        this.events.postRequestFailure('The model exceeded the project-tool limit.');
        return;
      }
      if (!await this.executeToolBatch(input, state, toolCalls, signal)) {
        return;
      }
    }
  }

  /** Build the next model turn from current limits and compact tool history. A final turn exposes no tools. */
  private createModelRequest(input: AgentRunInput, state: AgentRunState): AskRequest {
    const forceFinalAnswer = state.forceFinalAnswer || state.toolHistory.length >= input.toolCallLimit;
    const enabledTools = forceFinalAnswer ? [] : this.tools.enabledAgentTools(
      input.mode, state.fileMutationCalls, state.commandCalls, state.dependencyInstallCalls
    );
    this.events.postStatus(forceFinalAnswer
      ? 'Requesting concise final answer'
      : enabledTools.length > 0 && state.toolHistory.length > 0
        ? 'Continuing with project context'
        : 'Generating answer');
    return {
      question: input.question,
      mode: input.mode,
      scope: input.scope,
      settings: { ...input.settings, reasoningEffort: input.getReasoningEffort() },
      enabledTools,
      agentEditsEnabled: input.mode === 'code' || input.mode === 'debug',
      forceFinalAnswer,
      disableThinking: state.disableThinking || forceFinalAnswer,
      toolHistory: compactAgentToolHistory(state.toolHistory),
      conversationHistory: this.events.getConversationHistory()
    };
  }

  private async requestModel(
    input: AgentRunInput,
    request: AskRequest,
    state: AgentRunState,
    signal: AbortSignal
  ): Promise<ProviderAttempt> {
    return this.askWithProviderRetries(this.events.getBackendUrl(), request, input.providerApiKey,
      (input.settings.timeoutSeconds + 30) * 1_000, signal, usage => {
        this.events.postMessage({ command: 'tokenUsageUpdated', usage: addTokenUsage(state.completedTokenUsage, usage) });
      });
  }

  /** Try the limited empty-answer recovery path, or report the failure while keeping the checkpoint resumable. */
  private async recoverProviderFailure(
    input: AgentRunInput,
    state: AgentRunState,
    providerAttempt: ProviderAttempt,
    forceFinalThisTurn: boolean
  ): Promise<RunRecovery> {
    const { result } = providerAttempt;
    const errorMessage = result.message ?? 'Ask request failed.';
    if (forceFinalThisTurn
      && state.toolHistory.length > 0
      && result.errorKind !== 'network'
      && result.errorKind !== 'timeout'
      && result.errorKind !== 'cancelled') {
      this.events.postStatus('Finalizing from completed project-tool work');
      return {
        kind: 'final', response: {
          answer: summarizeAgentToolHistory(state.toolHistory, errorMessage),
          usedFiles: [...state.toolUsedFiles],
          changes: [],
          toolCalls: []
        }
      };
    }
    const emptyRecovery = emptyResponseRecoveryAction(errorMessage, state.emptyResponseRecoveryAttempted, forceFinalThisTurn);
    if (emptyRecovery === 'retry-without-thinking') {
      state.emptyResponseRecoveryAttempted = true;
      state.disableThinking = true;
      this.events.postStatus('Model returned no final answer — retrying with reasoning disabled');
      await this.persistCheckpoint(input, state);
      return { kind: 'retry' };
    }
    if (emptyRecovery === 'force-final') {
      state.forceFinalAnswer = true;
      state.disableThinking = true;
      this.events.postStatus('Model still returned no final answer — requesting final summary without tools');
      await this.persistCheckpoint(input, state);
      return { kind: 'retry' };
    }
    const backendDropped = result.errorKind === 'network';
    if (backendDropped) {
      this.events.postStatus('Backend connection dropped — recovering local backend');
      await this.events.ensureBackendStarted();
    }
    this.events.postRequestFailure(errorMessage, {
      retryable: providerAttempt.retriesExhausted || backendDropped
    });
    return { kind: 'stop' };
  }

  /** Handle models that promise future work but return no tool call; Ideas mode is handled separately in run(). */
  private async recoverDeferredAnswer(
    input: AgentRunInput,
    state: AgentRunState,
    forceFinalThisTurn: boolean
  ): Promise<RunRecovery> {
    const deferredMessage = 'The model described future work without performing it.';
    if (forceFinalThisTurn && state.toolHistory.length > 0) {
      this.events.postStatus('Finalizing from completed project-tool work');
      return {
        kind: 'final', response: {
          answer: summarizeAgentToolHistory(state.toolHistory, deferredMessage),
          usedFiles: [...state.toolUsedFiles],
          changes: [],
          toolCalls: []
        }
      };
    }
    if (!forceFinalThisTurn && !state.emptyResponseRecoveryAttempted) {
      state.emptyResponseRecoveryAttempted = true;
      state.disableThinking = true;
      this.events.postStatus('Model stopped before acting — retrying with project tools');
      await this.persistCheckpoint(input, state);
      return { kind: 'retry' };
    }
    if (!forceFinalThisTurn && state.toolHistory.length > 0) {
      state.forceFinalAnswer = true;
      this.events.postStatus('Model stopped before summarizing — requesting final answer without tools');
      await this.persistCheckpoint(input, state);
      return { kind: 'retry' };
    }
    this.events.postRequestFailure('The selected model described what it would do but did not call a project tool. Try another model or verify that this endpoint supports tool calling.');
    return { kind: 'stop' };
  }

  /** Execute calls in order so later tools see earlier edits, then save each completed result for Continue. */
  private async executeToolBatch(
    input: AgentRunInput,
    state: AgentRunState,
    toolCalls: AgentToolCall[],
    signal: AbortSignal
  ): Promise<boolean> {
    let executedCalls = 0;
    for (const rawToolCall of toolCalls) {
      if (state.toolHistory.length >= input.toolCallLimit) {
        break;
      }
      const workspaceFolder = this.events.getWorkspaceFolder();
      const toolCall = workspaceFolder
        ? normalizeAgentToolCallForWorkspace(rawToolCall, {
          name: workspaceFolder.name,
          fsPath: workspaceFolder.fsPath
        })
        : rawToolCall;
      if (state.toolHistory.some((step) => step.callId === toolCall.id)) {
        this.events.postRequestFailure('The model reused an invalid tool-call id.');
        return false;
      }
      const execution = await this.executeGuardedToolCall(toolCall, state);
      if (this.events.finishCancelledRequest(signal)) {
        return false;
      }
      state.toolHistory.push(execution.step);
      this.events.postMessage({
        command: 'toolUsageUpdated',
        used: state.toolHistory.length,
        limit: input.toolCallLimit
      });
      execution.usedFiles.forEach((file) => state.toolUsedFiles.add(file));
      await this.persistCheckpoint(input, state);
      executedCalls += 1;
    }
    if (executedCalls === 0) {
      this.events.postRequestFailure('The model could not complete a valid project tool call.');
      return false;
    }
    return true;
  }

  /**
   * Enforce per-run budgets and reject repeated work before handing the call to the executor.
   * Only work actually attempted or applied consumes the corresponding command or mutation counter.
   */
  private async executeGuardedToolCall(toolCall: AgentToolCall, state: AgentRunState): Promise<AgentToolExecution> {
    let signature: string | undefined;
    try {
      signature = agentToolCallSignature(toolCall);
    }
    catch {
      // The executor reports the validated tool error back to the model.
    }
    let execution: AgentToolExecution;
    const isFileMutation = isFileMutationAgentTool(toolCall.name);
    const isCommand = toolCall.name === 'run_command';
    const isDependencyInstall = toolCall.name === 'install_dependencies';
    const isReadOnly = isReadOnlyAgentTool(toolCall.name);
    const priorSignature = signature ? state.toolSignatures.get(signature) : undefined;
    // Reads can become useful again after a file or environment change. The revision distinguishes that from a loop.
    const repeatedAtCurrentRevision = priorSignature?.revision === state.workspaceRevision;
    if (isReadOnly
      && consecutiveAgentInspectionCalls(state.toolHistory) >= MAX_AGENT_CONSECUTIVE_INSPECTIONS) {
      execution = this.tools.rejectedToolExecution(toolCall, `DevMate paused the request after ${MAX_AGENT_CONSECUTIVE_INSPECTIONS} consecutive inspection calls without a file change or verification command. Use the gathered evidence and finish concisely.`);
      state.forceFinalAnswer = true;
    }
    else if (isFileMutation && state.fileMutationCalls >= MAX_AGENT_FILE_MUTATIONS) {
      execution = this.tools.rejectedToolExecution(toolCall, 'DevMate reached the file-mutation limit for this request.');
      state.forceFinalAnswer = true;
    }
    else if (isCommand && state.commandCalls >= MAX_AGENT_COMMAND_CALLS) {
      execution = this.tools.rejectedToolExecution(toolCall, 'DevMate reached the verification-command limit for this request.');
      state.forceFinalAnswer = true;
    }
    else if (isDependencyInstall
      && state.dependencyInstallCalls >= MAX_AGENT_DEPENDENCY_INSTALLS) {
      execution = this.tools.rejectedToolExecution(toolCall, 'DevMate reached the dependency-installation limit for this request.');
      state.forceFinalAnswer = true;
    }
    else if (signature
      && priorSignature
      && (isFileMutation
        || isDependencyInstall
        || (repeatedAtCurrentRevision && (!isReadOnly || priorSignature.executions >= 2)))) {
      const repeatedResult = 'This identical tool call was already completed. Use its earlier result.';
      this.tools.postAgentToolActivity(toolCall.id, 'Skipped repeated tool call', toolCall.name, 'error', repeatedResult);
      execution = {
        step: {
          callId: toolCall.id,
          name: toolCall.name,
          arguments: (() => {
            try {
              return summarizedAgentToolArguments(parseAgentToolCall(toolCall));
            }
            catch {
              return boundedAgentToolHistoryArguments(toolCall.name, toolCall.arguments);
            }
          })(),
          result: repeatedResult,
          isError: true
        },
        usedFiles: [],
        mutationCharacters: 0
      };
      state.forceFinalAnswer = true;
    }
    else {
      execution = await this.tools.executeAgentToolCall(toolCall, MAX_TOTAL_CHANGE_CHARACTERS - state.mutationCharacters);
      state.mutationCharacters += execution.mutationCharacters;
      if (isFileMutation && execution.mutationApplied) {
        state.fileMutationCalls += 1;
        state.workspaceRevision += 1;
      }
      if (isCommand && execution.commandAttempted) {
        state.commandCalls += 1;
      }
      if (isDependencyInstall && execution.installAttempted) {
        state.dependencyInstallCalls += 1;
      }
      if (execution.environmentChanged) {
        state.workspaceRevision += 1;
      }
      if (isDependencyInstall
        && execution.step.isError
        && /permission to install dependencies was denied/i.test(execution.step.result)) {
        state.forceFinalAnswer = true;
      }
      if (signature
        && (!execution.step.isError || execution.commandAttempted || execution.installAttempted)) {
        const previous = state.toolSignatures.get(signature);
        state.toolSignatures.set(signature, {
          revision: state.workspaceRevision,
          executions: previous?.revision === state.workspaceRevision
            ? previous.executions + 1
            : 1
        });
      }
    }

    return execution;
  }

  /** Save enough completed work to resume the conversation; this is not a backup or rollback of project files. */
  private async persistCheckpoint(input: AgentRunInput, state: AgentRunState): Promise<void> {
    const workspace = this.events.getConversationWorkspace();
    if (!workspace) {
      return;
    }
    await this.events.saveAgentCheckpoint({
      version: 1,
      workspaceId: workspace.id,
      sessionId: input.sessionId,
      question: input.question,
      mode: input.mode,
      scopeKind: input.scopeKind,
      toolHistory: compactAgentToolHistory(state.toolHistory),
      toolUsedFiles: [...state.toolUsedFiles].slice(-100),
      toolSignatures: [...state.toolSignatures].slice(-100).map(([signature, value]) => ({
        signature,
        revision: value.revision,
        executions: value.executions
      })),
      fileMutationCalls: state.fileMutationCalls,
      mutationCharacters: state.mutationCharacters,
      commandCalls: state.commandCalls,
      dependencyInstallCalls: state.dependencyInstallCalls,
      workspaceRevision: state.workspaceRevision,
      forceFinalAnswer: state.forceFinalAnswer,
      disableThinking: state.disableThinking,
      emptyResponseRecoveryAttempted: state.emptyResponseRecoveryAttempted,
      inputTokens: state.completedTokenUsage.inputTokens,
      outputTokens: state.completedTokenUsage.outputTokens,
      totalTokens: state.completedTokenUsage.totalTokens,
      tokenUsageExact: state.completedTokenUsage.exact,
      createdAt: state.checkpointCreatedAt,
      updatedAt: Date.now()
    });

  }

  /**
   * Stream an answer when supported, fall back to JSON otherwise, and retry only eligible provider failures.
   * Progress updates are batched for the webview, and cancellation also interrupts retry delays.
   */
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
      this.events.postMessage({ command: 'providerStreamReset' });
      const waitingTimer = setTimeout(() => {
        this.events.postStatus('Waiting for model response — the selected model is still working');
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
        this.events.postMessage({ command: 'providerStreamDelta', text: pendingStreamText });
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
        const streamAttempt = await this.transport.askStream(
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
                this.events.postStatus('Receiving model response');
              }
              pendingStreamText += event.text;
              if (!streamFlushTimer) {
                streamFlushTimer = setTimeout(() => {
                  streamFlushTimer = undefined;
                  flushStreamText();
                }, 40);
              }
            } else {
              this.events.postStatus(event.phase);
            }
          }
        );
        if (streamAttempt.unsupported) {
          this.events.postStatus('Live streaming unavailable — waiting for the completed response');
          result = await this.transport.ask(
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
            this.events.postStatus('Receiving model response');
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
      this.events.postStatus(
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
}

/** Restore counters without replaying tools. Resuming starts a new revision because the user may have edited files. */
function createRunState(checkpoint?: AgentRunCheckpoint): AgentRunState {
  return {
    toolHistory: [...(checkpoint?.toolHistory ?? [])],
    toolUsedFiles: new Set(checkpoint?.toolUsedFiles ?? []),
    toolSignatures: new Map(checkpoint?.toolSignatures.map(item => [item.signature, { revision: item.revision, executions: item.executions }]) ?? []),
    fileMutationCalls: checkpoint?.fileMutationCalls ?? 0,
    mutationCharacters: checkpoint?.mutationCharacters ?? 0,
    commandCalls: checkpoint?.commandCalls ?? 0,
    dependencyInstallCalls: checkpoint?.dependencyInstallCalls ?? 0,
    workspaceRevision: checkpoint ? Math.min(200, checkpoint.workspaceRevision + 1) : 0,
    forceFinalAnswer: checkpoint?.forceFinalAnswer ?? false,
    disableThinking: checkpoint?.disableThinking ?? false,
    emptyResponseRecoveryAttempted: checkpoint?.emptyResponseRecoveryAttempted ?? false,
    completedTokenUsage: checkpoint ? {
      inputTokens: checkpoint.inputTokens,
      outputTokens: checkpoint.outputTokens,
      totalTokens: checkpoint.totalTokens,
      exact: checkpoint.tokenUsageExact
    } : { inputTokens: 0, outputTokens: 0, totalTokens: 0, exact: true },
    checkpointCreatedAt: checkpoint?.createdAt ?? Date.now()
  };
}
/** Approximate live usage until the provider reports totals; this estimate is not used as an exact token count. */
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

function completedRun(response: AskResponse, state: AgentRunState): AgentRunResult {
  return { response, toolHistory: state.toolHistory, toolUsedFiles: state.toolUsedFiles };
}
