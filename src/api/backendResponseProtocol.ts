// Decode chat, health, and error payloads received from the local backend.
// Keep these checks at the API boundary; a TypeScript type does not validate incoming JSON.

import { AGENT_TOOL_NAMES } from '../agent/agentToolProtocol';
import type { AgentToolCall } from '../agent/agentToolProtocol';
import {
  DEVMATE_BACKEND_ERROR_CODES,
  DEVMATE_BACKEND_PROTOCOL_VERSION,
  DEVMATE_BACKEND_SERVICE,
  DEVMATE_REQUIRED_BACKEND_CAPABILITIES
} from './types';
import type {
  ApiResult,
  AskResponse,
  BackendErrorCode,
  FileChange,
  HealthResponse,
  TokenUsage
} from './types';

export const MAX_BACKEND_RESPONSE_BYTES = 4_000_000;
const MAX_BACKEND_ERROR_MESSAGE_CHARACTERS = 1_000;
const MAX_BACKEND_VALIDATION_ISSUES = 8;
const MAX_ASK_USED_FILES = 100;
const MAX_ASK_FILE_CHANGES = 10;
const MAX_ASK_FILE_CHANGE_CHARACTERS = 200_000;
const MAX_ASK_TOTAL_CHANGE_CHARACTERS = 500_000;
const MAX_ASK_TOOL_CALLS = 20;
const MAX_ASK_TOOL_ARGUMENT_CHARACTERS = 1_200_000;
const MAX_ASK_PATH_CHARACTERS = 2_048;
const backendErrorCodes = new Set<string>(DEVMATE_BACKEND_ERROR_CODES);
const agentToolNames = new Set<string>(AGENT_TOOL_NAMES);

export function parseSuccessResult<T>(
  value: unknown,
  decodeData: (data: unknown) => T | undefined
): ApiResult<T> | undefined {
  if (!isSuccessEnvelope(value) || !hasOnlyKeys(value, ['status', 'data'])) {
    return undefined;
  }
  const data = decodeData(value.data);
  return data === undefined ? undefined : { status: 'ok', data };
}

export function isSuccessEnvelope(value: unknown): value is Record<string, unknown> & {
  status: 'ok';
  data: unknown;
} {
  return isRecord(value) && value.status === 'ok' && 'data' in value;
}

export function parseAskResponse(value: unknown): AskResponse | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['answer', 'usedFiles', 'changes', 'toolCalls', 'tokenUsage'])
    || typeof value.answer !== 'string'
    || value.answer.length > MAX_BACKEND_RESPONSE_BYTES
    || !Array.isArray(value.usedFiles)
    || value.usedFiles.length > MAX_ASK_USED_FILES
    || !value.usedFiles.every((file) => isResponsePath(file))
    || new Set(value.usedFiles).size !== value.usedFiles.length
    || !Array.isArray(value.changes)
    || value.changes.length > MAX_ASK_FILE_CHANGES
    || !Array.isArray(value.toolCalls)
    || value.toolCalls.length > MAX_ASK_TOOL_CALLS) {
    return undefined;
  }

  const changes: FileChange[] = [];
  const changePaths = new Set<string>();
  let changeCharacters = 0;
  for (const candidate of value.changes) {
    if (!isRecord(candidate)
      || !hasOnlyKeys(candidate, ['path', 'content'])
      || !isResponsePath(candidate.path)
      || typeof candidate.content !== 'string'
      || candidate.content.length > MAX_ASK_FILE_CHANGE_CHARACTERS
      || changePaths.has(candidate.path.toLocaleLowerCase())) {
      return undefined;
    }
    changeCharacters += candidate.content.length;
    if (changeCharacters > MAX_ASK_TOTAL_CHANGE_CHARACTERS) {
      return undefined;
    }
    changePaths.add(candidate.path.toLocaleLowerCase());
    changes.push({ path: candidate.path, content: candidate.content });
  }

  const toolCalls: AgentToolCall[] = [];
  const callIds = new Set<string>();
  for (const candidate of value.toolCalls) {
    const toolCall = parseAgentToolCall(candidate);
    if (!toolCall || callIds.has(toolCall.id)) {
      return undefined;
    }
    callIds.add(toolCall.id);
    toolCalls.push(toolCall);
  }
  if (!value.answer && toolCalls.length === 0) {
    return undefined;
  }

  const tokenUsage = parseTokenUsage(value.tokenUsage);
  if (!tokenUsage) {
    return undefined;
  }
  return {
    answer: value.answer,
    usedFiles: [...value.usedFiles],
    changes,
    toolCalls,
    tokenUsage
  };
}

function parseAgentToolCall(value: unknown): AgentToolCall | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['id', 'name', 'arguments'])
    || !isBoundedNonEmptyString(value.id, 120)
    || typeof value.name !== 'string'
    || !agentToolNames.has(value.name)
    || !isRecord(value.arguments)) {
    return undefined;
  }
  try {
    if (JSON.stringify(value.arguments).length > MAX_ASK_TOOL_ARGUMENT_CHARACTERS) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return {
    id: value.id,
    name: value.name as AgentToolCall['name'],
    arguments: value.arguments
  };
}

export function parseTokenUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['inputTokens', 'outputTokens', 'totalTokens', 'exact'])
    || !safeTokenCount(value.inputTokens)
    || !safeTokenCount(value.outputTokens)
    || !safeTokenCount(value.totalTokens)
    || typeof value.exact !== 'boolean') {
    return undefined;
  }
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
    exact: value.exact
  };
}

function safeTokenCount(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= 200_000_000;
}

function isResponsePath(value: unknown): value is string {
  return isBoundedNonEmptyString(value, MAX_ASK_PATH_CHARACTERS)
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isBoundedNonEmptyString(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum;
}

export function parseStreamError(value: Record<string, unknown>): ApiResult<AskResponse> | undefined {
  if (!hasOnlyKeys(value, ['type', 'message', 'statusCode', 'errorKind', 'errorCode'])
    || value.type !== 'error'
    || value.errorKind !== 'http'
    || !isBoundedNonEmptyString(value.message, MAX_BACKEND_ERROR_MESSAGE_CHARACTERS)
    || !isHttpStatusCode(value.statusCode)
    || !isBackendErrorCode(value.errorCode)) {
    return undefined;
  }
  return {
    status: 'error',
    message: value.message,
    statusCode: value.statusCode,
    errorKind: 'http',
    errorCode: value.errorCode
  };
}

export function parseBackendHttpError<T>(statusCode: number, value: unknown): ApiResult<T> {
  const parsed = parseBackendError(value);
  if (!parsed) {
    return {
      status: 'error',
      message: `The DevMate backend returned HTTP ${statusCode} with an invalid error response.`,
      statusCode,
      errorKind: 'invalid-response'
    };
  }
  const validationDetail = parsed.errorCode === 'request_validation_failed'
    ? formatValidationIssues(parsed.issues)
    : undefined;
  return {
    status: 'error',
    message: validationDetail ?? parsed.message,
    statusCode,
    errorKind: 'http',
    errorCode: parsed.errorCode
  };
}

function parseBackendError(value: unknown): {
  errorCode: BackendErrorCode;
  message: string;
  issues: BackendValidationIssue[];
} | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['status', 'errorCode', 'message', 'issues'])
    || value.status !== 'error'
    || !isBackendErrorCode(value.errorCode)
    || !isBoundedNonEmptyString(value.message, MAX_BACKEND_ERROR_MESSAGE_CHARACTERS)
    || !Array.isArray(value.issues)
    || value.issues.length > MAX_BACKEND_VALIDATION_ISSUES) {
    return undefined;
  }
  const issues: BackendValidationIssue[] = [];
  for (const candidate of value.issues) {
    const issue = parseBackendValidationIssue(candidate);
    if (!issue) {
      return undefined;
    }
    issues.push(issue);
  }
  return { errorCode: value.errorCode, message: value.message, issues };
}

type BackendValidationIssue = {
  location: Array<string | number>;
  message: string;
  type: string;
};

function parseBackendValidationIssue(value: unknown): BackendValidationIssue | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['location', 'message', 'type'])
    || !Array.isArray(value.location)
    || value.location.length > 16
    || !value.location.every((part) => (
      (typeof part === 'string' && part.length > 0 && part.length <= 120)
      || (typeof part === 'number' && Number.isInteger(part) && part >= 0 && part <= 1_000_000)
    ))
    || !isBoundedNonEmptyString(value.message, 240)
    || !isBoundedNonEmptyString(value.type, 120)) {
    return undefined;
  }
  return {
    location: value.location as Array<string | number>,
    message: value.message,
    type: value.type
  };
}

function formatValidationIssues(issues: BackendValidationIssue[]): string | undefined {
  const fields = issues.slice(0, 4).map((issue) => {
    const location = issue.location
      .filter((part) => part !== 'body')
      .map((part) => String(part).replace(/[\u0000-\u001f\u007f]/g, ''))
      .filter(Boolean)
      .join('.');
    const message = issue.message.replace(/[\u0000-\u001f\u007f]/g, ' ');
    return `${location || 'request'}: ${message}`;
  });
  return fields.length > 0
    ? `DevMate rejected an invalid request field: ${fields.join('; ')}`
    : undefined;
}

function isBackendErrorCode(value: unknown): value is BackendErrorCode {
  return typeof value === 'string' && backendErrorCodes.has(value);
}

function isHttpStatusCode(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 400
    && value <= 599;
}

export function parseCompatibleHealthResponse(value: unknown): HealthResponse | undefined {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['service', 'protocolVersion', 'capabilities', 'backend', 'version'])
    || value.service !== DEVMATE_BACKEND_SERVICE
    || value.protocolVersion !== DEVMATE_BACKEND_PROTOCOL_VERSION
    || value.backend !== 'online'
    || typeof value.version !== 'string'
    || value.version.trim().length === 0
    || value.version.length > 120
    || !Array.isArray(value.capabilities)) {
    return undefined;
  }
  const capabilities = value.capabilities;
  if (capabilities.length > 32
    || !capabilities.every(isValidBackendCapability)
    || new Set(capabilities).size !== capabilities.length
    || !DEVMATE_REQUIRED_BACKEND_CAPABILITIES.every(
      (capability) => capabilities.includes(capability)
    )) {
    return undefined;
  }
  return {
    service: DEVMATE_BACKEND_SERVICE,
    protocolVersion: DEVMATE_BACKEND_PROTOCOL_VERSION,
    capabilities: [...value.capabilities],
    backend: 'online',
    version: value.version
  };
}

function isValidBackendCapability(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}
