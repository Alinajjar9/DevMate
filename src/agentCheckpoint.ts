import { AGENT_TOOL_NAMES } from './agentTools';
import type { AgentToolName } from './agentTools';
import type { AgentToolStep, AssistantMode } from './api/types';

export const AGENT_CHECKPOINT_STORAGE_KEY = 'devMate.agentCheckpoint.v1';
export const MAX_AGENT_CHECKPOINT_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export type AgentToolSignatureCheckpoint = {
  signature: string;
  revision: number;
  executions: number;
};

export type AgentRunCheckpoint = {
  version: 1;
  workspaceId: string;
  sessionId: string;
  question: string;
  mode: AssistantMode;
  scopeKind: 'project' | 'activeFile' | 'selection';
  toolHistory: AgentToolStep[];
  toolUsedFiles: string[];
  toolSignatures: AgentToolSignatureCheckpoint[];
  fileMutationCalls: number;
  mutationCharacters: number;
  commandCalls: number;
  dependencyInstallCalls: number;
  workspaceRevision: number;
  forceFinalAnswer: boolean;
  disableThinking: boolean;
  emptyResponseRecoveryAttempted: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokenUsageExact: boolean;
  createdAt: number;
  updatedAt: number;
};

const toolNames = new Set<AgentToolName>(AGENT_TOOL_NAMES);

export function parseAgentRunCheckpoint(
  value: unknown,
  now = Date.now()
): AgentRunCheckpoint | undefined {
  if (!isRecord(value)
    || value.version !== 1
    || !boundedString(value.workspaceId, 2_048)
    || !boundedString(value.sessionId, 120)
    || !boundedString(value.question, 50_000)
    || !['ideas', 'code', 'debug'].includes(String(value.mode))
    || !['project', 'activeFile', 'selection'].includes(String(value.scopeKind))
    || !Array.isArray(value.toolHistory)
    || value.toolHistory.length > 100
    || !Array.isArray(value.toolUsedFiles)
    || value.toolUsedFiles.length > 100
    || !Array.isArray(value.toolSignatures)
    || value.toolSignatures.length > 100
    || !validCounter(value.fileMutationCalls, 6)
    || !validCounter(value.mutationCharacters, 500_000)
    || !validCounter(value.commandCalls, 3)
    || !validCounter(value.dependencyInstallCalls, 1)
    || !validCounter(value.workspaceRevision, 200)
    || typeof value.forceFinalAnswer !== 'boolean'
    || typeof value.disableThinking !== 'boolean'
    || typeof value.emptyResponseRecoveryAttempted !== 'boolean'
    || !validCounter(value.inputTokens, 200_000_000)
    || !validCounter(value.outputTokens, 200_000_000)
    || !validCounter(value.totalTokens, 400_000_000)
    || value.totalTokens < value.inputTokens + value.outputTokens
    || typeof value.tokenUsageExact !== 'boolean'
    || !validTimestamp(value.createdAt)
    || !validTimestamp(value.updatedAt)
    || value.updatedAt < value.createdAt
    || value.updatedAt > now + 60_000
    || now - value.updatedAt > MAX_AGENT_CHECKPOINT_AGE_MS) {
    return undefined;
  }

  const toolHistory = parseToolHistory(value.toolHistory);
  const toolUsedFiles = value.toolUsedFiles.every((item) => boundedString(item, 2_048))
    ? [...new Set(value.toolUsedFiles as string[])]
    : undefined;
  const toolSignatures = parseToolSignatures(value.toolSignatures);
  if (!toolHistory || !toolUsedFiles || !toolSignatures) {
    return undefined;
  }

  return {
    version: 1,
    workspaceId: value.workspaceId as string,
    sessionId: value.sessionId as string,
    question: value.question as string,
    mode: value.mode as AssistantMode,
    scopeKind: value.scopeKind as AgentRunCheckpoint['scopeKind'],
    toolHistory,
    toolUsedFiles,
    toolSignatures,
    fileMutationCalls: value.fileMutationCalls as number,
    mutationCharacters: value.mutationCharacters as number,
    commandCalls: value.commandCalls as number,
    dependencyInstallCalls: value.dependencyInstallCalls as number,
    workspaceRevision: value.workspaceRevision as number,
    forceFinalAnswer: value.forceFinalAnswer,
    disableThinking: value.disableThinking,
    emptyResponseRecoveryAttempted: value.emptyResponseRecoveryAttempted,
    inputTokens: value.inputTokens as number,
    outputTokens: value.outputTokens as number,
    totalTokens: value.totalTokens as number,
    tokenUsageExact: value.tokenUsageExact,
    createdAt: value.createdAt as number,
    updatedAt: value.updatedAt as number
  };
}

function parseToolHistory(value: unknown[]): AgentToolStep[] | undefined {
  const parsed: AgentToolStep[] = [];
  const callIds = new Set<string>();
  let resultCharacters = 0;
  for (const item of value) {
    if (!isRecord(item)
      || !boundedString(item.callId, 120)
      || callIds.has(item.callId)
      || !toolNames.has(item.name as AgentToolName)
      || !isRecord(item.arguments)
      || JSON.stringify(item.arguments).length > 4_000
      || typeof item.result !== 'string'
      || item.result.length > 10_000
      || typeof item.isError !== 'boolean') {
      return undefined;
    }
    resultCharacters += item.result.length;
    if (resultCharacters > 80_000) {
      return undefined;
    }
    callIds.add(item.callId);
    parsed.push({
      callId: item.callId,
      name: item.name as AgentToolName,
      arguments: item.arguments,
      result: item.result,
      isError: item.isError
    });
  }
  return parsed;
}

function parseToolSignatures(value: unknown[]): AgentToolSignatureCheckpoint[] | undefined {
  const parsed: AgentToolSignatureCheckpoint[] = [];
  const signatures = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)
      || typeof item.signature !== 'string'
      || !/^[a-f0-9]{64}$/.test(item.signature)
      || signatures.has(item.signature)
      || !validCounter(item.revision, 200)
      || !validCounter(item.executions, 100)
      || item.executions < 1) {
      return undefined;
    }
    signatures.add(item.signature);
    parsed.push({
      signature: item.signature,
      revision: item.revision,
      executions: item.executions
    });
  }
  return parsed;
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function validCounter(value: unknown, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= maximum;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
