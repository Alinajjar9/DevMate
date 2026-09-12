import { createHash } from 'crypto';
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
  MAX_AGENT_CONSECUTIVE_INSPECTIONS,
  MAX_AGENT_DEPENDENCY_INSTALLS,
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
import { MAX_PROVIDER_HISTORY_CHARACTERS, parseProviderState } from './providerState';
import { normalizeAgentConfiguration } from './configuration';
import type { AgentConfiguration } from './configuration';

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
  configuration?: AgentConfiguration;
  instructions?: string;
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
  configuration: AgentConfiguration;
  instructions: string;
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
    const configuration = normalizeAgentConfiguration(resumedCheckpoint?.configuration ?? input.configuration ?? {
      ...input.settings, toolCallLimit: input.toolCallLimit
    });
    const state = createRunState(configuration,
      resumedCheckpoint?.instructions ?? input.instructions ?? configuration.instructions, resumedCheckpoint);
    input = { ...input, configuration: resumedCheckpoint?.configuration ?? input.configuration,
      toolCallLimit: configuration.toolCallLimit };
    this.events.postMessage({ command: 'toolUsageUpdated', used: state.toolHistory.length, limit: input.toolCallLimit });
    await this.persistCheckpoint(input, state);

    // Each pass finishes, performs a bounded recovery, or records a batch of project tools.
    while (true) {
      if (this.events.finishCancelledRequest(signal)) {
        return;
      }
      const request = this.createModelRequest(input, state);
      const estimatedInputTokens = estimateRequestTokens(request);
      const remainingTokens = configuration.runTokenBudget - state.completedTokenUsage.totalTokens;
      if (configuration.runTokenBudget > 0
        && (remainingTokens <= 0 || remainingTokens <= estimatedInputTokens + 128)) {
        state.forceFinalAnswer = true;
        await this.persistCheckpoint(input, state);
        this.events.postStatus('Run token budget reached — summarizing completed work locally', 'warning');
        return completedRun({
          answer: summarizeAgentToolHistory(state.toolHistory,
            'Input token counts are estimates when the provider has not reported usage. Increase the run token budget to continue.',
            'DevMate stopped because the run token budget leaves too little room for another model request.'),
          usedFiles: [...state.toolUsedFiles], changes: [], toolCalls: []
        }, state);
      }
      if (configuration.runTokenBudget > 0) {
        request.settings.maxTokens = Math.min(request.settings.maxTokens, Math.floor(remainingTokens - estimatedInputTokens));
      }
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

      const outputTokens = estimatedTokenCount(JSON.stringify({ answer: result.data.answer,
        toolCalls: result.data.toolCalls?.map(({ providerState: _providerState, ...call }) => call) }).length);
      state.completedTokenUsage = addTokenUsage(state.completedTokenUsage, result.data.tokenUsage ?? {
        inputTokens: estimatedInputTokens, outputTokens, totalTokens: estimatedInputTokens + outputTokens, exact: false
      });
      this.events.postMessage({ command: 'tokenUsageUpdated', usage: state.completedTokenUsage });
      if ((request.agentEditsEnabled || request.forceFinalAnswer) && result.data.changes?.length) {
        // Full-file proposals must never bypass the tool permissions or a stop reached during this run.
        await this.persistCheckpoint(input, state);
        this.events.postRequestFailure('The model returned unexpected full-file changes instead of a summary or project tool call. No proposed changes were applied.');
        return;
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
    const enabledTools = forceFinalAnswer ? [] : this.availableTools(input, state);
    this.events.postStatus(forceFinalAnswer
      ? 'Requesting concise final answer'
      : enabledTools.length > 0 && state.toolHistory.length > 0
        ? 'Continuing with project context'
        : 'Generating answer');
    const request: AskRequest = {
      question: input.question,
      ...(state.instructions ? { instructions: state.instructions } : {}),
      mode: input.mode,
      scope: boundedScope(input.scope, state.configuration.contextCharacters),
      settings: { ...input.settings, maxTokens: state.configuration.maxTokens,
        temperature: state.configuration.temperature, timeoutSeconds: state.configuration.timeoutSeconds,
        reasoningEffort: input.getReasoningEffort() },
      enabledTools,
      // This selects the response format for the entire run, not permission to edit on this turn.
      agentEditsEnabled: input.mode === 'code' || input.mode === 'debug',
      forceFinalAnswer,
      disableThinking: state.disableThinking || forceFinalAnswer,
      toolHistory: compactAgentToolHistory(state.toolHistory, state.configuration.historyCharacters),
      conversationHistory: this.events.getConversationHistory()
    };
    return request;
  }

  private availableTools(input: AgentRunInput, state: AgentRunState) {
    const config = state.configuration;
    return this.tools.enabledAgentTools(input.mode, state.fileMutationCalls, state.commandCalls,
      state.dependencyInstallCalls, config).filter(name => config.enabledTools.includes(name)
      && (!isFileMutationAgentTool(name) || state.fileMutationCalls < config.maxFileEdits)
      && (name !== 'run_command' || state.commandCalls < config.maxCommands));
  }

  private async requestModel(
    input: AgentRunInput,
    request: AskRequest,
    state: AgentRunState,
    signal: AbortSignal
  ): Promise<ProviderAttempt> {
    return this.askWithProviderRetries(this.events.getBackendUrl(), request, input.providerApiKey,
      (request.settings.timeoutSeconds + 30) * 1_000, signal, usage => {
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
    let providerStateCharacters = state.toolHistory.reduce(
      (total, step) => total + (step.providerState ? JSON.stringify(step.providerState).length : 0), 0
    );
    for (const rawToolCall of toolCalls) {
      // A guard can stop in the middle of a provider batch. Its remaining calls must never run.
      if (state.forceFinalAnswer || state.toolHistory.length >= input.toolCallLimit) {
        break;
      }
      const providerState = rawToolCall.providerState === undefined
        ? undefined
        : parseProviderState(rawToolCall.providerState);
      if (rawToolCall.providerState !== undefined && !providerState) {
        this.events.postRequestFailure('The model returned invalid provider continuation data.');
        return false;
      }
      providerStateCharacters += providerState ? JSON.stringify(providerState).length : 0;
      if (providerStateCharacters > MAX_PROVIDER_HISTORY_CHARACTERS) {
        this.events.postRequestFailure('DevMate reached the provider continuation limit. Start a new request to continue.');
        return false;
      }
      const workspaceFolder = this.events.getWorkspaceFolder();
      let toolCall = workspaceFolder
        ? normalizeAgentToolCallForWorkspace(rawToolCall, {
          name: workspaceFolder.name,
          fsPath: workspaceFolder.fsPath
        })
        : rawToolCall;
      if (toolCall.name === 'run_command' && input.configuration) {
        const requestedTimeout = toolCall.arguments.timeoutSeconds;
        toolCall = { ...toolCall, arguments: { ...toolCall.arguments,
          timeoutSeconds: typeof requestedTimeout === 'number'
            ? Math.min(requestedTimeout, state.configuration.commandTimeoutSeconds)
            : state.configuration.commandTimeoutSeconds } };
      }
      if (state.toolHistory.some((step) => step.callId === toolCall.id)) {
        this.events.postRequestFailure('The model reused an invalid tool-call id.');
        return false;
      }
      const permitted = this.availableTools(input, state).includes(toolCall.name);
      const execution = !permitted
        ? this.tools.rejectedToolExecution(toolCall, 'This tool is disabled by the current mode, configuration or remaining budget. Do not retry it through another tool.')
        : await this.executeGuardedToolCall(toolCall, state);
      if (!permitted) state.forceFinalAnswer = true;
      if (this.events.finishCancelledRequest(signal)) {
        return false;
      }
      // Tool execution may summarize large arguments. Continuation data belongs to the provider turn and stays intact.
      state.toolHistory.push({
        ...execution.step,
        ...(providerState ? { providerState } : {})
      });
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
      // Checkpoints store bounded digests so large argument strings never enter the loop-detection map.
      signature = createHash('sha256').update(agentToolCallSignature(toolCall)).digest('hex');
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
    else if (isFileMutation && state.fileMutationCalls >= state.configuration.maxFileEdits) {
      execution = this.tools.rejectedToolExecution(toolCall, 'DevMate reached the file-mutation limit for this request.');
      state.forceFinalAnswer = true;
    }
    else if (isCommand && state.commandCalls >= state.configuration.maxCommands) {
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
      execution = await this.tools.executeAgentToolCall(toolCall, MAX_TOTAL_CHANGE_CHARACTERS - state.mutationCharacters,
        state.configuration.maxFileEdits - state.fileMutationCalls);
      state.mutationCharacters += execution.mutationCharacters;
      if (isFileMutation && execution.mutationApplied) {
        state.fileMutationCalls += execution.mutationFiles ?? 1;
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

    if (execution.step.isError && !state.forceFinalAnswer) {
      if (/^Permission to .+ was denied\b/i.test(execution.step.result)) {
        // A denied action ends this run rather than inviting a retry through another tool.
        execution.step.result += '\nThe user denied this action. Stop using tools and explain what remains blocked.';
        this.events.postStatus('Permission denied — requesting a final summary', 'warning');
        state.forceFinalAnswer = true;
      }
      else if (failedToolAttempts(state.toolHistory, execution.step) >= state.configuration.maxRepairAttempts) {
        const target = toolRepairTarget(execution.step.arguments);
        const blocker = `DevMate stopped after ${state.configuration.maxRepairAttempts} failed attempts to use ${toolCall.name}${target ? ` on ${target}` : ''} without progress. Explain the blocker and any work already completed; do not claim this operation succeeded.`;
        // Keep this first so history compaction cannot hide why the next model turn has no tools.
        execution.step.result = `${blocker}\nLast tool error: ${execution.step.result}`;
        this.events.postStatus('Stopped repeated failed tool calls — requesting a final summary', 'warning');
        state.forceFinalAnswer = true;
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
      configuration: state.configuration,
      instructions: state.instructions,
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

/**
 * Count unsuccessful repairs from retained history, even when argument parsing failed.
 * Reading a file does not repair a failed edit. Only a successful mutation of that
 * file resets its repair budget; other tools reset their own budget on success.
 * Keeping this derived from tool history also preserves it across checkpoints.
 */
function failedToolAttempts(history: AgentToolStep[], current: AgentToolStep): number {
  const target = toolRepairTarget(current.arguments);
  let failures = 1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const step = history[index];
    const sameTarget = toolRepairTarget(step.arguments) === target;
    if (!step.isError) {
      const changedTarget = isFileMutationAgentTool(step.name)
        && target !== undefined
        && (sameTarget || toolRepairTarget({ path: step.arguments.newPath }) === target);
      if (changedTarget || (sameTarget && step.name === current.name)) {
        break;
      }
    }
    else if (sameTarget && step.name === current.name) {
      failures += 1;
    }
  }
  return failures;
}

/** Targets remain available in compact history, unlike full edit text or command arguments. */
function toolRepairTarget(argumentsValue: Record<string, unknown>): string | undefined {
  const value = argumentsValue.path ?? argumentsValue.manifestPath ?? argumentsValue.cwd;
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Restore counters without replaying tools. Resuming starts a new revision because the user may have edited files. */
function createRunState(configuration: AgentConfiguration, instructions: string, checkpoint?: AgentRunCheckpoint): AgentRunState {
  return {
    configuration,
    instructions: instructions.slice(0, 12_000),
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

/** Limit visible starting context while preserving the required file/selection item and honest length metadata. */
function boundedScope(scope: AskScope, maximumCharacters: number): AskScope {
  let remaining = maximumCharacters;
  return { ...scope, items: scope.items.flatMap(item => {
    if (remaining === 0 && (scope.type === 'project' || item.source === 'attachment')) return [];
    let content = item.content.slice(0, remaining);
    if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1);
    remaining -= content.length;
    return [{ ...item, content, includedCharacters: content.length, truncated: content.length < item.totalCharacters }];
  }) };
}

/** Estimate visible input plus the preview's 3000-token prompt allowance; encrypted reasoning cost remains unknown. */
function estimateRequestTokens(request: AskRequest): number {
  return 3_000 + estimatedTokenCount(JSON.stringify({ question: request.question, instructions: request.instructions,
    scope: request.scope, conversationHistory: request.conversationHistory, enabledTools: request.enabledTools,
    toolHistory: request.toolHistory?.map(({ providerState: _providerState, ...step }) => step)
  }).length);
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
