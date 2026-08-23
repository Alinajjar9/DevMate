"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentRunController = void 0;
const vscode = __importStar(require("vscode"));
const agentTools_1 = require("./agentTools");
const client_1 = require("./api/client");
const fileTools_1 = require("./fileTools");
const contextPlanner_1 = require("./contextPlanner");
const defaultTransport = {
    ask: client_1.ask,
    askStream: client_1.askStream,
    waitForRetryDelay
};
class AgentRunController {
    toolExecutor;
    dependencies;
    transport;
    constructor(toolExecutor, dependencies, transport = defaultTransport) {
        this.toolExecutor = toolExecutor;
        this.dependencies = dependencies;
        this.transport = transport;
    }
    async run(input, signal) {
        const { question, mode, scopeKind, scope, conversationHistory, modelContextWindowTokens, maxInputContextTokens, settings, backendUrl, backendToken, providerApiKey, toolCallLimit, workspaceId, sessionId, resumedCheckpoint } = input;
        const toolHistory = resumedCheckpoint
            ? [...resumedCheckpoint.toolHistory]
            : [];
        const toolUsedFiles = new Set(resumedCheckpoint?.toolUsedFiles ?? []);
        const toolSignatures = new Map(resumedCheckpoint?.toolSignatures.map((item) => [
            item.signature,
            { revision: item.revision, executions: item.executions }
        ]) ?? []);
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
        let completedTokenUsage = resumedCheckpoint
            ? {
                inputTokens: resumedCheckpoint.inputTokens,
                outputTokens: resumedCheckpoint.outputTokens,
                totalTokens: resumedCheckpoint.totalTokens,
                exact: resumedCheckpoint.tokenUsageExact
            }
            : { inputTokens: 0, outputTokens: 0, totalTokens: 0, exact: true };
        const checkpointCreatedAt = resumedCheckpoint?.createdAt ?? Date.now();
        const persistCheckpoint = async () => {
            await this.dependencies.saveCheckpoint({
                version: 1,
                workspaceId,
                sessionId,
                question,
                mode,
                scopeKind,
                toolHistory: (0, agentTools_1.compactAgentToolHistory)(toolHistory),
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
        let finalData;
        this.reportToolUsage(toolHistory.length, toolCallLimit);
        await persistCheckpoint();
        // Each pass either finishes the answer or feeds one bounded batch of tool results back to the model.
        while (!finalData) {
            if (signal.aborted) {
                return { kind: 'cancelled' };
            }
            const forceFinalThisTurn = forceFinalAnswer
                || toolHistory.length >= toolCallLimit;
            const enabledTools = forceFinalThisTurn
                ? []
                : this.enabledAgentTools(mode, fileMutationCalls, commandCalls, dependencyInstallCalls);
            const toolsEnabled = enabledTools.length > 0;
            const contextPlan = (0, contextPlanner_1.planAskRequestContext)({
                question,
                scope,
                conversationHistory,
                toolHistory: (0, agentTools_1.compactAgentToolHistory)(toolHistory),
                modelContextWindowTokens,
                maxInputContextTokens,
                reservedOutputTokens: settings.maxTokens
            });
            if (contextPlan.overflowTokens > 0) {
                return {
                    kind: 'failed',
                    message: 'The required instructions, question, and explicit context exceed the configured input budget. Increase the model context or maximum input setting, reduce maximum output tokens, or remove large attachments.'
                };
            }
            const request = {
                question,
                mode,
                scope: contextPlan.scope,
                settings,
                enabledTools,
                agentEditsEnabled: mode === 'code' || mode === 'debug',
                forceFinalAnswer: forceFinalThisTurn,
                disableThinking: disableThinking || forceFinalThisTurn,
                toolHistory: contextPlan.toolHistory,
                conversationHistory: contextPlan.conversationHistory
            };
            this.reportStatus(forceFinalThisTurn
                ? 'Requesting concise final answer'
                : toolsEnabled && toolHistory.length > 0
                    ? 'Continuing with project context'
                    : 'Generating answer');
            const providerAttempt = await this.askWithProviderRetries(backendUrl, request, backendToken, providerApiKey, (settings.timeoutSeconds + 30) * 1_000, signal, (currentUsage) => {
                this.reportTokenUsage(addTokenUsage(completedTokenUsage, currentUsage));
            });
            const result = providerAttempt.result;
            if (signal.aborted) {
                return { kind: 'cancelled' };
            }
            if (result.status === 'error' || !result.data) {
                const errorMessage = result.message ?? 'Ask request failed.';
                if (forceFinalThisTurn
                    && toolHistory.length > 0
                    && result.errorKind !== 'network'
                    && result.errorKind !== 'timeout'
                    && result.errorKind !== 'cancelled') {
                    this.reportStatus('Finalizing from completed project-tool work');
                    finalData = {
                        answer: (0, agentTools_1.summarizeAgentToolHistory)(toolHistory, errorMessage),
                        usedFiles: [...toolUsedFiles],
                        changes: [],
                        toolCalls: []
                    };
                    break;
                }
                const emptyRecovery = (0, agentTools_1.emptyResponseRecoveryAction)(errorMessage, emptyResponseRecoveryAttempted, forceFinalThisTurn);
                if (emptyRecovery === 'retry-without-thinking') {
                    emptyResponseRecoveryAttempted = true;
                    disableThinking = true;
                    this.reportStatus('Model returned no final answer — retrying with reasoning disabled');
                    await persistCheckpoint();
                    continue;
                }
                if (emptyRecovery === 'force-final') {
                    forceFinalAnswer = true;
                    disableThinking = true;
                    this.reportStatus('Model still returned no final answer — requesting final summary without tools');
                    await persistCheckpoint();
                    continue;
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
            if (result.data.tokenUsage) {
                completedTokenUsage = addTokenUsage(completedTokenUsage, result.data.tokenUsage);
                this.reportTokenUsage(completedTokenUsage);
            }
            const toolCalls = result.data.toolCalls ?? [];
            if (toolCalls.length === 0
                && mode !== 'ideas'
                && (0, agentTools_1.isDeferredAgentPlanAnswer)(result.data.answer)) {
                const deferredMessage = 'The model described future work without performing it.';
                if (forceFinalThisTurn && toolHistory.length > 0) {
                    this.reportStatus('Finalizing from completed project-tool work');
                    finalData = {
                        answer: (0, agentTools_1.summarizeAgentToolHistory)(toolHistory, deferredMessage),
                        usedFiles: [...toolUsedFiles],
                        changes: [],
                        toolCalls: []
                    };
                    break;
                }
                if (!forceFinalThisTurn && !emptyResponseRecoveryAttempted) {
                    emptyResponseRecoveryAttempted = true;
                    disableThinking = true;
                    this.reportStatus('Model stopped before acting — retrying with project tools');
                    await persistCheckpoint();
                    continue;
                }
                if (!forceFinalThisTurn && toolHistory.length > 0) {
                    forceFinalAnswer = true;
                    this.reportStatus('Model stopped before summarizing — requesting final answer without tools');
                    await persistCheckpoint();
                    continue;
                }
                return {
                    kind: 'failed',
                    message: 'The selected model described what it would do but did not call a project tool. Try another model or verify that this endpoint supports tool calling.'
                };
            }
            if (toolCalls.length === 0) {
                finalData = result.data;
                break;
            }
            if (!toolsEnabled) {
                return {
                    kind: 'failed',
                    message: 'The model exceeded the project-tool limit.'
                };
            }
            let executedCalls = 0;
            for (const rawToolCall of toolCalls) {
                if (toolHistory.length >= toolCallLimit) {
                    break;
                }
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                const toolCall = workspaceFolder
                    ? (0, agentTools_1.normalizeAgentToolCallForWorkspace)(rawToolCall, {
                        name: workspaceFolder.name,
                        fsPath: workspaceFolder.uri.scheme === 'file' ? workspaceFolder.uri.fsPath : undefined
                    })
                    : rawToolCall;
                if (toolHistory.some((step) => step.callId === toolCall.id)) {
                    return {
                        kind: 'failed',
                        message: 'The model reused an invalid tool-call id.'
                    };
                }
                let signature;
                try {
                    signature = (0, agentTools_1.agentToolCallSignature)(toolCall);
                }
                catch {
                    // The executor reports the validated tool error back to the model.
                }
                let execution;
                const isFileMutation = (0, agentTools_1.isFileMutationAgentTool)(toolCall.name);
                const isCommand = toolCall.name === 'run_command';
                const isDependencyInstall = toolCall.name === 'install_dependencies';
                const isReadOnly = (0, agentTools_1.isReadOnlyAgentTool)(toolCall.name);
                const priorSignature = signature ? toolSignatures.get(signature) : undefined;
                const repeatedAtCurrentRevision = priorSignature?.revision === workspaceRevision;
                if (isReadOnly
                    && (0, agentTools_1.consecutiveAgentInspectionCalls)(toolHistory) >= agentTools_1.MAX_AGENT_CONSECUTIVE_INSPECTIONS) {
                    execution = this.rejectedToolExecution(toolCall, `DevMate paused the request after ${agentTools_1.MAX_AGENT_CONSECUTIVE_INSPECTIONS} consecutive inspection calls without a file change or verification command. Use the gathered evidence and finish concisely.`);
                    forceFinalAnswer = true;
                }
                else if (isFileMutation && fileMutationCalls >= agentTools_1.MAX_AGENT_FILE_MUTATIONS) {
                    execution = this.rejectedToolExecution(toolCall, 'DevMate reached the file-mutation limit for this request.');
                    forceFinalAnswer = true;
                }
                else if (isCommand && commandCalls >= agentTools_1.MAX_AGENT_COMMAND_CALLS) {
                    execution = this.rejectedToolExecution(toolCall, 'DevMate reached the verification-command limit for this request.');
                    forceFinalAnswer = true;
                }
                else if (isDependencyInstall
                    && dependencyInstallCalls >= agentTools_1.MAX_AGENT_DEPENDENCY_INSTALLS) {
                    execution = this.rejectedToolExecution(toolCall, 'DevMate reached the dependency-installation limit for this request.');
                    forceFinalAnswer = true;
                }
                else if (signature
                    && priorSignature
                    && (isFileMutation
                        || isDependencyInstall
                        || (repeatedAtCurrentRevision && (!isReadOnly || priorSignature.executions >= 2)))) {
                    const repeatedResult = 'This identical tool call was already completed. Use its earlier result.';
                    this.reportToolActivity(toolCall.id, 'Skipped repeated tool call', toolCall.name, 'error', repeatedResult);
                    execution = {
                        step: {
                            callId: toolCall.id,
                            name: toolCall.name,
                            arguments: (() => {
                                try {
                                    return (0, agentTools_1.summarizedAgentToolArguments)((0, agentTools_1.parseAgentToolCall)(toolCall));
                                }
                                catch {
                                    return (0, agentTools_1.boundedAgentToolHistoryArguments)(toolCall.name, toolCall.arguments);
                                }
                            })(),
                            result: repeatedResult,
                            isError: true
                        },
                        usedFiles: [],
                        mutationCharacters: 0
                    };
                    forceFinalAnswer = true;
                }
                else {
                    execution = await this.toolExecutor.execute(toolCall, {
                        remainingMutationCharacters: fileTools_1.MAX_TOTAL_CHANGE_CHARACTERS - mutationCharacters,
                        signal
                    });
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
                    if (isDependencyInstall
                        && execution.step.isError
                        && /permission to install dependencies was denied/i.test(execution.step.result)) {
                        forceFinalAnswer = true;
                    }
                    if (signature
                        && (!execution.step.isError || execution.commandAttempted || execution.installAttempted)) {
                        const previous = toolSignatures.get(signature);
                        toolSignatures.set(signature, {
                            revision: workspaceRevision,
                            executions: previous?.revision === workspaceRevision
                                ? previous.executions + 1
                                : 1
                        });
                    }
                }
                if (signal.aborted) {
                    return { kind: 'cancelled' };
                }
                toolHistory.push(execution.step);
                this.reportToolUsage(toolHistory.length, toolCallLimit);
                execution.usedFiles.forEach((file) => toolUsedFiles.add(file));
                await persistCheckpoint();
                executedCalls += 1;
            }
            if (executedCalls === 0) {
                return {
                    kind: 'failed',
                    message: 'The model could not complete a valid project tool call.'
                };
            }
        }
        if (signal.aborted) {
            return { kind: 'cancelled' };
        }
        return {
            kind: 'completed',
            response: finalData,
            toolHistory,
            toolUsedFiles: [...toolUsedFiles],
            tokenUsage: completedTokenUsage
        };
    }
    reportStatus(text) {
        this.dependencies.emit({ type: 'status', text });
    }
    reportTokenUsage(usage) {
        this.dependencies.emit({ type: 'token-usage', usage });
    }
    reportToolUsage(used, limit) {
        this.dependencies.emit({ type: 'tool-usage', used, limit });
    }
    reportToolActivity(id, title, detail, status, result, canOpenTerminal = false) {
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
    enabledAgentTools(mode, fileMutationCalls, commandCalls, dependencyInstallCalls) {
        const tools = [...agentTools_1.READ_ONLY_AGENT_TOOL_NAMES];
        if (mode === 'ideas' || !vscode.workspace.isTrusted) {
            return tools;
        }
        if (fileMutationCalls < agentTools_1.MAX_AGENT_FILE_MUTATIONS) {
            tools.push(...agentTools_1.FILE_MUTATION_AGENT_TOOL_NAMES);
        }
        if (dependencyInstallCalls < agentTools_1.MAX_AGENT_DEPENDENCY_INSTALLS) {
            tools.push('install_dependencies');
        }
        if (commandCalls < agentTools_1.MAX_AGENT_COMMAND_CALLS) {
            tools.push('run_command');
        }
        return tools;
    }
    rejectedToolExecution(call, result) {
        let historyArguments = (0, agentTools_1.boundedAgentToolHistoryArguments)(call.name, call.arguments);
        try {
            historyArguments = (0, agentTools_1.summarizedAgentToolArguments)((0, agentTools_1.parseAgentToolCall)(call));
        }
        catch {
            // Keep the provider's bounded raw arguments for an invalid call.
        }
        this.reportToolActivity(call.id, 'Tool request rejected', call.name, 'error', result);
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
    async askWithProviderRetries(backendUrl, request, backendToken, providerApiKey, timeoutMilliseconds, signal, onTokenUsage) {
        let retryNumber = 0;
        while (true) {
            this.dependencies.emit({ type: 'stream-reset' });
            const waitingTimer = setTimeout(() => {
                this.reportStatus('Waiting for model response — the selected model is still working');
            }, 15_000);
            let receivedStreamText = false;
            let pendingStreamText = '';
            let streamedOutputCharacters = 0;
            let currentUsage;
            let streamFlushTimer;
            const flushStreamText = () => {
                if (!pendingStreamText) {
                    return;
                }
                this.dependencies.emit({ type: 'stream-delta', text: pendingStreamText });
                streamedOutputCharacters += pendingStreamText.length;
                pendingStreamText = '';
                if (currentUsage) {
                    const outputTokens = Math.max(currentUsage.outputTokens, estimatedTokenCount(streamedOutputCharacters));
                    onTokenUsage?.({
                        inputTokens: currentUsage.inputTokens,
                        outputTokens,
                        totalTokens: currentUsage.inputTokens + outputTokens,
                        exact: false
                    });
                }
            };
            let result;
            try {
                const streamAttempt = await this.transport.askStream(backendUrl, request, { backendToken, providerApiKey }, timeoutMilliseconds, signal, (event) => {
                    clearTimeout(waitingTimer);
                    if (event.type === 'usage') {
                        currentUsage = event.usage;
                        onTokenUsage?.(event.usage);
                    }
                    else if (event.type === 'delta') {
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
                    }
                    else {
                        this.reportStatus(event.phase);
                    }
                });
                if (streamAttempt.unsupported) {
                    this.reportStatus('Live streaming unavailable — waiting for the completed response');
                    result = await this.transport.ask(backendUrl, request, { backendToken, providerApiKey }, timeoutMilliseconds, signal);
                    if (result.status === 'ok'
                        && result.data?.answer
                        && (result.data.toolCalls?.length ?? 0) === 0) {
                        receivedStreamText = true;
                        this.reportStatus('Receiving model response');
                        pendingStreamText += result.data.answer;
                    }
                }
                else {
                    result = streamAttempt.result;
                }
            }
            finally {
                clearTimeout(waitingTimer);
                if (streamFlushTimer) {
                    clearTimeout(streamFlushTimer);
                }
                flushStreamText();
            }
            if (!(0, agentTools_1.isRetryableProviderFailure)(result)) {
                return { result, retriesExhausted: false };
            }
            retryNumber += 1;
            const delay = (0, agentTools_1.providerRetryDelay)(retryNumber);
            if (delay === undefined) {
                return { result, retriesExhausted: true };
            }
            this.reportStatus(`Provider busy — retrying ${retryNumber}/${agentTools_1.PROVIDER_RETRY_DELAYS_MS.length} in ${delay / 1_000}s`);
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
exports.AgentRunController = AgentRunController;
function estimatedTokenCount(characterCount) {
    return characterCount <= 0 ? 0 : Math.max(1, Math.ceil(characterCount / 4));
}
function addTokenUsage(left, right) {
    const inputTokens = left.inputTokens + right.inputTokens;
    const outputTokens = left.outputTokens + right.outputTokens;
    return {
        inputTokens,
        outputTokens,
        totalTokens: left.totalTokens + right.totalTokens,
        exact: left.exact && right.exact
    };
}
function waitForRetryDelay(milliseconds, signal) {
    if (signal.aborted) {
        return Promise.resolve(false);
    }
    return new Promise((resolve) => {
        const finish = (completed) => {
            clearTimeout(timeout);
            signal.removeEventListener('abort', cancel);
            resolve(completed);
        };
        const cancel = () => finish(false);
        const timeout = setTimeout(() => finish(true), milliseconds);
        signal.addEventListener('abort', cancel, { once: true });
    });
}
//# sourceMappingURL=agentRunController.js.map