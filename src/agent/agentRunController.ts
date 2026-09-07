// Run the model/tool conversation until it finishes, fails, or is cancelled.
// All counters belong to one run; checkpoints let that run resume later.

import * as vscode from 'vscode';
import {
  MAX_AGENT_COMMAND_CALLS,
  MAX_AGENT_CONSECUTIVE_INSPECTIONS,
  MAX_AGENT_DEPENDENCY_INSTALLS,
  MAX_AGENT_FILE_MUTATIONS,
  PROVIDER_RETRY_DELAYS_MS,
  agentToolCallSignature,
  boundedAgentToolHistoryArguments,
  compactAgentToolHistory,
  consecutiveAgentInspectionCalls,
  emptyResponseRecoveryAction,
  isDeferredAgentPlanAnswer,
  isRetryableProviderFailure,
  normalizeAgentToolCallForWorkspace,
  parseAgentToolCall,
  providerRetryDelay,
  summarizedAgentToolArguments,
  summarizeAgentToolHistory
} from './agentTools';
import {
  FILE_MUTATION_AGENT_TOOL_NAMES,
  READ_ONLY_AGENT_TOOL_NAMES,
  isFileMutationAgentTool,
  isReadOnlyAgentTool
} from './agentToolProtocol';
import type { AgentToolCall, AgentToolName } from './agentToolProtocol';
import { ask, askStream } from '../api/client';
import type {
  AgentToolStep,
  ApiResult,
  AskRequest,
  AskResponse,
  AskScope,
  AssistantMode,
  ChatMemorySummaryContent,
  ConversationTurn,
  LlmSettings,
  TokenUsage
} from '../api/types';
import { MAX_TOTAL_CHANGE_CHARACTERS } from '../workspace/fileTools';
import type { AgentRunCheckpoint } from '../sessions/sessions';
import type { AgentToolExecution, ToolExecutor } from './toolExecutor';
import type { ScopeKind } from '../context/workspaceContext';
import { planAskRequestContext } from '../context/contextPlanner';

export type AgentRunInput = {
  question: string;
  mode: AssistantMode;
  scopeKind: ScopeKind;
  scope: AskScope;
  conversationHistory: ConversationTurn[];
  conversationSummary?: ChatMemorySummaryContent;
  modelContextWindowTokens?: number;
  maxInputContextTokens?: number;
  settings: LlmSettings;
  backendUrl: string;
  backendToken: string;
  providerApiKey?: string;
  toolCallLimit: number;
  workspaceId: string;
  sessionId: string;
  resumedCheckpoint?: AgentRunCheckpoint;
};

export type AgentRunOutcome =
  | {
    kind: 'completed';
    response: AskResponse;
    toolHistory: AgentToolStep[];
    toolUsedFiles: string[];
    tokenUsage: TokenUsage;
  }
  | {
    kind: 'failed';
    message: string;
    retryable?: boolean;
  }
  | { kind: 'cancelled' };

export type AgentRunEvent =
  | { type: 'status'; text: string }
  | { type: 'stream-reset' }
  | { type: 'stream-delta'; text: string }
  | { type: 'token-usage'; usage: TokenUsage }
  | { type: 'tool-usage'; used: number; limit: number }
  | {
    type: 'tool-activity';
    id: string;
    title: string;
    detail: string;
    status: 'running' | 'completed' | 'error';
    result?: string;
    canOpenTerminal?: boolean;
  };

export type AgentRunDependencies = {
  saveCheckpoint(checkpoint: AgentRunCheckpoint): Promise<void>;
  recoverBackend(): Promise<unknown>;
  emit(event: AgentRunEvent): void;
};

export type AgentRunTransport = {
  ask: typeof ask;
  askStream: typeof askStream;
  waitForRetryDelay(milliseconds: number, signal: AbortSignal): Promise<boolean>;
};

// This plain object belongs to one invocation. Controller instances never share a run's counters.
type AgentRunState = {
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
};

type AgentRunFailure = Extract<AgentRunOutcome, { kind: 'failed' }>;

type PreparedAgentTurn = {
  kind: 'ready';
  request: AskRequest;
  forceFinalThisTurn: boolean;
  toolsEnabled: boolean;
};

type ProviderAttempt = {
  result: ApiResult<AskResponse>;
  retriesExhausted: boolean;
};

type ProviderTurnDecision =
  | AgentRunFailure
  | { kind: 'retry' }
  | { kind: 'answer'; response: AskResponse }
  | { kind: 'tools'; toolCalls: AgentToolCall[] };

const defaultTransport: AgentRunTransport = {
  ask,
  askStream,
  waitForRetryDelay
};

export class AgentRunController {
  constructor(
    private readonly toolExecutor: Pick<ToolExecutor, 'execute'>,
    private readonly dependencies: AgentRunDependencies,
    private readonly transport: AgentRunTransport = defaultTransport
  ) {}

  async run(
    input: AgentRunInput,
    signal: AbortSignal
  ): Promise<AgentRunOutcome> {
    // Capture the input fields once; later UI changes must not switch this run to another request.
    const runInput = { ...input };
    const state = createAgentRunState(runInput.resumedCheckpoint);
    this.reportToolUsage(state.toolHistory.length, runInput.toolCallLimit);
    await this.persistCheckpoint(runInput, state);

    // Each pass plans a request, handles the reply, then either finishes or records a tool batch.
    while (true) {
      if (signal.aborted) {
        return { kind: 'cancelled' };
      }
      const turn = this.prepareTurn(runInput, state);
      if (turn.kind === 'failed') {
        return turn;
      }
      const providerAttempt = await this.askWithProviderRetries(
        runInput.backendUrl,
        turn.request,
        runInput.backendToken,
        runInput.providerApiKey,
        (runInput.settings.timeoutSeconds + 30) * 1_000,
        signal,
        (currentUsage) => {
          this.reportTokenUsage(addTokenUsage(state.completedTokenUsage, currentUsage));
        }
      );
      if (signal.aborted) {
        return { kind: 'cancelled' };
      }

      const decision = await this.handleProviderResult(runInput, state, turn, providerAttempt);
      if (decision.kind === 'failed') {
        return decision;
      }
      if (decision.kind === 'retry') {
        continue;
      }
      if (decision.kind === 'answer') {
        if (signal.aborted) {
          return { kind: 'cancelled' };
        }
        return {
          kind: 'completed',
          response: decision.response,
          toolHistory: state.toolHistory,
          toolUsedFiles: [...state.toolUsedFiles],
          tokenUsage: state.completedTokenUsage
        };
      }

      // Cancellation can arrive while the response-handling phase is yielding.
      // Do not start a tool after that new asynchronous boundary.
      if (signal.aborted) {
        return { kind: 'cancelled' };
      }
      const stopped = await this.executeToolBatch(runInput, state, decision.toolCalls, signal);
      if (stopped) {
        return stopped;
      }
    }
  }

  private async persistCheckpoint(input: AgentRunInput, state: AgentRunState): Promise<void> {
    // Store enough state to continue, but bound the tool output and duplicate-call records.
    await this.dependencies.saveCheckpoint({
      version: 1,
      workspaceId: input.workspaceId,
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

  private prepareTurn(
    input: AgentRunInput,
    state: AgentRunState
  ): PreparedAgentTurn | AgentRunFailure {
    const {
      question,
      mode,
      scope,
      conversationHistory,
      conversationSummary,
      modelContextWindowTokens,
      maxInputContextTokens,
      settings,
      toolCallLimit
    } = input;
    // A final pass disables tools so a model cannot keep working beyond the run's limits.
    const forceFinalThisTurn = state.forceFinalAnswer
      || state.toolHistory.length >= toolCallLimit;
    const enabledTools = forceFinalThisTurn
      ? []
      : this.enabledAgentTools(
        mode,
        state.fileMutationCalls,
        state.commandCalls,
        state.dependencyInstallCalls
      );
    const toolsEnabled = enabledTools.length > 0;
    const contextPlan = planAskRequestContext({
      question,
      scope,
      conversationHistory,
      compactedSummary: conversationSummary,
      toolHistory: compactAgentToolHistory(state.toolHistory),
      modelContextWindowTokens,
      maxInputContextTokens,
      reservedOutputTokens: settings.maxTokens
    });
    // Never silently truncate the question or explicit code just to make the request fit.
    if (contextPlan.overflowTokens > 0) {
      return {
        kind: 'failed',
        message: 'The required instructions, question, and explicit context exceed the configured input budget. Increase the model context or maximum input setting, reduce maximum output tokens, or remove large attachments.'
      };
    }
    const request: AskRequest = {
      question,
      mode,
      scope: contextPlan.scope,
      settings,
      enabledTools,
      agentEditsEnabled: mode === 'code' || mode === 'debug',
      forceFinalAnswer: forceFinalThisTurn,
      disableThinking: state.disableThinking || forceFinalThisTurn,
      toolHistory: contextPlan.toolHistory,
      conversationHistory: contextPlan.conversationHistory,
      conversationSummary: contextPlan.compactedSummary
    };
    this.reportStatus(forceFinalThisTurn
      ? 'Requesting concise final answer'
      : toolsEnabled && state.toolHistory.length > 0
        ? 'Continuing with project context'
        : 'Generating answer');

    return { kind: 'ready', request, forceFinalThisTurn, toolsEnabled };
  }

  private async handleProviderResult(
    input: AgentRunInput,
    state: AgentRunState,
    turn: PreparedAgentTurn,
    providerAttempt: ProviderAttempt
  ): Promise<ProviderTurnDecision> {
    const { mode } = input;
    const { forceFinalThisTurn, toolsEnabled } = turn;
    const result = providerAttempt.result;
    if (result.status === 'error' || !result.data) {
      const errorMessage = result.message ?? 'Ask request failed.';
      if (
        forceFinalThisTurn
        && state.toolHistory.length > 0
        && result.errorKind !== 'network'
        && result.errorKind !== 'timeout'
        && result.errorKind !== 'cancelled'
      ) {
        this.reportStatus('Finalizing from completed project-tool work');
        return {
          kind: 'answer',
          response: {
            answer: summarizeAgentToolHistory(state.toolHistory, errorMessage),
            usedFiles: [...state.toolUsedFiles],
            changes: [],
            toolCalls: []
          }
        };
      }
      // Recovery is bounded: first reduce reasoning, then ask for a final answer without tools.
      const emptyRecovery = emptyResponseRecoveryAction(
        errorMessage,
        state.emptyResponseRecoveryAttempted,
        forceFinalThisTurn
      );
      if (emptyRecovery === 'retry-without-thinking') {
        state.emptyResponseRecoveryAttempted = true;
        state.disableThinking = true;
        this.reportStatus('Model returned no final answer — retrying with reasoning disabled');
        await this.persistCheckpoint(input, state);
        return { kind: 'retry' };
      }
      if (emptyRecovery === 'force-final') {
        state.forceFinalAnswer = true;
        state.disableThinking = true;
        this.reportStatus('Model still returned no final answer — requesting final summary without tools');
        await this.persistCheckpoint(input, state);
        return { kind: 'retry' };
      }
      const backendDropped = result.errorKind === 'network';
      if (backendDropped) {
        this.reportStatus('Backend connection dropped — recovering local backend');
        await this.dependencies.recoverBackend();
      }
      return {
        kind: 'failed',
        message: errorMessage,
        retryable: providerAttempt.retriesExhausted || backendDropped
      };
    }

    // Add completed calls once; streamed updates are only previews of the current call's usage.
    if (result.data.tokenUsage) {
      state.completedTokenUsage = addTokenUsage(state.completedTokenUsage, result.data.tokenUsage);
      this.reportTokenUsage(state.completedTokenUsage);
    }

    const toolCalls = result.data.toolCalls ?? [];
    if (
      toolCalls.length === 0
      && mode !== 'ideas'
      && isDeferredAgentPlanAnswer(result.data.answer)
    ) {
      const deferredMessage = 'The model described future work without performing it.';
      if (forceFinalThisTurn && state.toolHistory.length > 0) {
        this.reportStatus('Finalizing from completed project-tool work');
        return {
          kind: 'answer',
          response: {
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
        this.reportStatus('Model stopped before acting — retrying with project tools');
        await this.persistCheckpoint(input, state);
        return { kind: 'retry' };
      }
      if (!forceFinalThisTurn && state.toolHistory.length > 0) {
        state.forceFinalAnswer = true;
        this.reportStatus('Model stopped before summarizing — requesting final answer without tools');
        await this.persistCheckpoint(input, state);
        return { kind: 'retry' };
      }
      return {
        kind: 'failed',
        message: 'The selected model described what it would do but did not call a project tool. Try another model or verify that this endpoint supports tool calling.'
      };
    }
    if (toolCalls.length === 0) {
      return { kind: 'answer', response: result.data };
    }
    if (!toolsEnabled) {
      return {
        kind: 'failed',
        message: 'The model exceeded the project-tool limit.'
      };
    }

    return { kind: 'tools', toolCalls };
  }

  private async executeToolBatch(
    input: AgentRunInput,
    state: AgentRunState,
    toolCalls: AgentToolCall[],
    signal: AbortSignal
  ): Promise<AgentRunFailure | { kind: 'cancelled' } | undefined> {
    let executedCalls = 0;
    for (const rawToolCall of toolCalls) {
      if (state.toolHistory.length >= input.toolCallLimit) {
        break;
      }
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const toolCall = workspaceFolder
        ? normalizeAgentToolCallForWorkspace(rawToolCall, {
          name: workspaceFolder.name,
          fsPath: workspaceFolder.uri.scheme === 'file' ? workspaceFolder.uri.fsPath : undefined
        })
        : rawToolCall;
      if (state.toolHistory.some((step) => step.callId === toolCall.id)) {
        return {
          kind: 'failed',
          message: 'The model reused an invalid tool-call id.'
        };
      }

      const execution = await this.executeGuardedToolCall(toolCall, state, signal);
      if (signal.aborted) {
        return { kind: 'cancelled' };
      }
      state.toolHistory.push(execution.step);
      this.reportToolUsage(state.toolHistory.length, input.toolCallLimit);
      execution.usedFiles.forEach((file) => state.toolUsedFiles.add(file));
      await this.persistCheckpoint(input, state);
      executedCalls += 1;
    }

    if (executedCalls === 0) {
      return {
        kind: 'failed',
        message: 'The model could not complete a valid project tool call.'
      };
    }
    return undefined;
  }

  private async executeGuardedToolCall(
    toolCall: AgentToolCall,
    state: AgentRunState,
    signal: AbortSignal
  ): Promise<AgentToolExecution> {
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
    const priorSignature = signature ? state.toolSignatures.get(signature) : undefined;
    // A read may become useful after a file/environment change; repeated mutations stay blocked.
    const repeatedAtCurrentRevision = priorSignature?.revision === state.workspaceRevision;
    if (
      isReadOnly
      && consecutiveAgentInspectionCalls(state.toolHistory) >= MAX_AGENT_CONSECUTIVE_INSPECTIONS
    ) {
      execution = this.rejectedToolExecution(
        toolCall,
        `DevMate paused the request after ${MAX_AGENT_CONSECUTIVE_INSPECTIONS} consecutive inspection calls without a file change or verification command. Use the gathered evidence and finish concisely.`
      );
      state.forceFinalAnswer = true;
    } else if (isFileMutation && state.fileMutationCalls >= MAX_AGENT_FILE_MUTATIONS) {
      execution = this.rejectedToolExecution(
        toolCall,
        'DevMate reached the file-mutation limit for this request.'
      );
      state.forceFinalAnswer = true;
    } else if (isCommand && state.commandCalls >= MAX_AGENT_COMMAND_CALLS) {
      execution = this.rejectedToolExecution(
        toolCall,
        'DevMate reached the verification-command limit for this request.'
      );
      state.forceFinalAnswer = true;
    } else if (
      isDependencyInstall
      && state.dependencyInstallCalls >= MAX_AGENT_DEPENDENCY_INSTALLS
    ) {
      execution = this.rejectedToolExecution(
        toolCall,
        'DevMate reached the dependency-installation limit for this request.'
      );
      state.forceFinalAnswer = true;
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
      this.reportToolActivity(
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
      state.forceFinalAnswer = true;
    } else {
      execution = await this.toolExecutor.execute(toolCall, {
        remainingMutationCharacters: MAX_TOTAL_CHANGE_CHARACTERS - state.mutationCharacters,
        signal
      });
      state.mutationCharacters += execution.mutationCharacters;
      // Validation failures do not spend a mutation slot; only actual writes do.
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
      if (
        isDependencyInstall
        && execution.step.isError
        && execution.permissionDenied
      ) {
        state.forceFinalAnswer = true;
      }
      if (
        signature
        && (!execution.step.isError || execution.commandAttempted || execution.installAttempted)
      ) {
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

  private reportStatus(text: string): void {
    this.dependencies.emit({ type: 'status', text });
  }

  private reportTokenUsage(usage: TokenUsage): void {
    this.dependencies.emit({ type: 'token-usage', usage });
  }

  private reportToolUsage(used: number, limit: number): void {
    this.dependencies.emit({ type: 'tool-usage', used, limit });
  }

  private reportToolActivity(
    id: string,
    title: string,
    detail: string,
    status: 'running' | 'completed' | 'error',
    result?: string,
    canOpenTerminal = false
  ): void {
    this.dependencies.emit({
      type: 'tool-activity',
      id,
      title,
      detail,
      status,
      result,
      canOpenTerminal
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
    this.reportToolActivity(
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
    backendToken: string,
    providerApiKey: string | undefined,
    timeoutMilliseconds: number,
    signal: AbortSignal,
    onTokenUsage?: (usage: TokenUsage) => void
  ): Promise<ProviderAttempt> {
    let retryNumber = 0;
    while (true) {
      this.dependencies.emit({ type: 'stream-reset' });
      const waitingTimer = setTimeout(() => {
        this.reportStatus('Waiting for model response — the selected model is still working');
      }, 15_000);
      let receivedStreamText = false;
      let pendingStreamText = '';
      let streamedOutputCharacters = 0;
      let currentUsage: TokenUsage | undefined;
      let streamFlushTimer: NodeJS.Timeout | undefined;
      // Batch small deltas so the webview is not updated for every individual provider token.
      const flushStreamText = () => {
        if (!pendingStreamText) {
          return;
        }
        this.dependencies.emit({ type: 'stream-delta', text: pendingStreamText });
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
          { backendToken, providerApiKey },
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
                this.reportStatus('Receiving model response');
              }
              pendingStreamText += event.text;
              if (!streamFlushTimer) {
                streamFlushTimer = setTimeout(() => {
                  streamFlushTimer = undefined;
                  flushStreamText();
                }, 40);
              }
            } else {
              this.reportStatus(event.phase);
            }
          }
        );
        // Unsupported streaming gets a normal completion request; a broken stream is still an error.
        if (streamAttempt.unsupported) {
          this.reportStatus('Live streaming unavailable — waiting for the completed response');
          result = await this.transport.ask(
            backendUrl,
            request,
            { backendToken, providerApiKey },
            timeoutMilliseconds,
            signal
          );
          if (
            result.status === 'ok'
            && result.data?.answer
            && (result.data.toolCalls?.length ?? 0) === 0
          ) {
            receivedStreamText = true;
            this.reportStatus('Receiving model response');
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
      this.reportStatus(
        `Provider busy — retrying ${retryNumber}/${PROVIDER_RETRY_DELAYS_MS.length} in ${delay / 1_000}s`
      );
      // Waiting for a retry must remain cancellable, just like the provider request itself.
      const delayCompleted = await this.transport.waitForRetryDelay(delay, signal);
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

function createAgentRunState(checkpoint?: AgentRunCheckpoint): AgentRunState {
  // Restore spent limits too: resuming must not give a run a fresh mutation or command budget.
  return {
    toolHistory: checkpoint ? [...checkpoint.toolHistory] : [],
    toolUsedFiles: new Set(checkpoint?.toolUsedFiles ?? []),
    toolSignatures: new Map(
      checkpoint?.toolSignatures.map((item) => [
        item.signature,
        { revision: item.revision, executions: item.executions }
      ]) ?? []
    ),
    fileMutationCalls: checkpoint?.fileMutationCalls ?? 0,
    mutationCharacters: checkpoint?.mutationCharacters ?? 0,
    commandCalls: checkpoint?.commandCalls ?? 0,
    dependencyInstallCalls: checkpoint?.dependencyInstallCalls ?? 0,
    // A resumed workspace may have changed. Allow fresh inspection instead of reusing stale evidence.
    workspaceRevision: checkpoint ? Math.min(200, checkpoint.workspaceRevision + 1) : 0,
    forceFinalAnswer: checkpoint?.forceFinalAnswer ?? false,
    disableThinking: checkpoint?.disableThinking ?? false,
    emptyResponseRecoveryAttempted: checkpoint?.emptyResponseRecoveryAttempted ?? false,
    completedTokenUsage: checkpoint
      ? {
        inputTokens: checkpoint.inputTokens,
        outputTokens: checkpoint.outputTokens,
        totalTokens: checkpoint.totalTokens,
        exact: checkpoint.tokenUsageExact
      }
      : { inputTokens: 0, outputTokens: 0, totalTokens: 0, exact: true },
    checkpointCreatedAt: checkpoint?.createdAt ?? Date.now()
  };
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
