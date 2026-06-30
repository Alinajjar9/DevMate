import { createHash } from 'crypto';
import { parseRunCommandArguments } from './commandTools';
import { parseInstallDependenciesArguments } from './dependencyTools';
import type { InstallDependenciesToolArguments } from './dependencyTools';
import {
  parseCreateFileArguments,
  parseEditFileArguments
} from './fileTools';
import type { ExactTextReplacement } from './fileTools';

export const DEFAULT_AGENT_TOOL_CALL_LIMIT = 16;
export const MIN_AGENT_TOOL_CALL_LIMIT = 4;
export const MAX_AGENT_TOOL_CALL_LIMIT = 32;
export const MAX_AGENT_FILE_MUTATIONS = 6;
export const MAX_AGENT_COMMAND_CALLS = 3;
export const MAX_AGENT_DEPENDENCY_INSTALLS = 1;
export const MAX_AGENT_LIST_RESULTS = 200;
export const MAX_AGENT_SEARCH_RESULTS = 50;
export const MAX_AGENT_TOOL_RESULT_CHARACTERS = 10_000;
export const MAX_AGENT_TOOL_HISTORY_CHARACTERS = 80_000;

export function boundedAgentToolCallLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return DEFAULT_AGENT_TOOL_CALL_LIMIT;
  }
  return Math.min(MAX_AGENT_TOOL_CALL_LIMIT, Math.max(MIN_AGENT_TOOL_CALL_LIMIT, value));
}

export function compactAgentToolHistory<
  T extends { name: string; result: string }
>(steps: T[]): T[] {
  const compacted = steps.map((step) => ({ ...step }));
  let characters = compacted.reduce((total, step) => total + step.result.length, 0);
  for (let index = 0; characters > MAX_AGENT_TOOL_HISTORY_CHARACTERS && index < compacted.length; index += 1) {
    const step = compacted[index];
    const marker = `[Earlier ${step.name} result omitted to stay within the agent context budget.]`;
    if (step.result.length <= marker.length) {
      continue;
    }
    characters -= step.result.length - marker.length;
    step.result = marker;
  }
  return compacted;
}

export type AgentToolName =
  | 'list_files'
  | 'read_file'
  | 'search_code'
  | 'create_file'
  | 'edit_file'
  | 'install_dependencies'
  | 'run_command';

export type AgentToolCall = {
  id: string;
  name: AgentToolName;
  arguments: Record<string, unknown>;
};

export type AgentWorkspacePathInfo = {
  name: string;
  fsPath?: string;
};

export type ListFilesToolArguments = {
  path: string;
  maxResults: number;
};

export type ReadFileToolArguments = {
  path: string;
  startLine?: number;
  endLine?: number;
};

export type SearchCodeToolArguments = {
  query: string;
  path: string;
  maxResults: number;
};

export type CreateFileToolArguments = {
  path: string;
  content: string;
};

export type EditFileToolArguments = {
  path: string;
  replacements: ExactTextReplacement[];
};

export type RunCommandToolArguments = {
  executable: string;
  args: string[];
  cwd: string;
  timeoutSeconds: number;
};

export type ParsedAgentToolCall =
  | { id: string; name: 'list_files'; arguments: ListFilesToolArguments }
  | { id: string; name: 'read_file'; arguments: ReadFileToolArguments }
  | { id: string; name: 'search_code'; arguments: SearchCodeToolArguments }
  | { id: string; name: 'create_file'; arguments: CreateFileToolArguments }
  | { id: string; name: 'edit_file'; arguments: EditFileToolArguments }
  | { id: string; name: 'install_dependencies'; arguments: InstallDependenciesToolArguments }
  | { id: string; name: 'run_command'; arguments: RunCommandToolArguments };

export function parseAgentToolCall(call: AgentToolCall): ParsedAgentToolCall {
  if (!call.id.trim()) {
    throw new Error('The model returned a tool call without an id.');
  }
  if (!isRecord(call.arguments)) {
    throw new Error('The model returned invalid tool arguments.');
  }

  if (call.name === 'list_files') {
    return {
      id: call.id,
      name: call.name,
      arguments: {
        path: normalizeAgentToolPath(optionalString(call.arguments.path)),
        maxResults: boundedInteger(
          call.arguments.maxResults,
          100,
          1,
          MAX_AGENT_LIST_RESULTS
        )
      }
    };
  }

  if (call.name === 'read_file') {
    const filePath = requiredString(call.arguments.path, 'read_file requires a path.');
    const lineRange = parseLineRange(call.arguments.startLine, call.arguments.endLine);
    return {
      id: call.id,
      name: call.name,
      arguments: {
        path: normalizeAgentToolPath(filePath, false),
        ...lineRange
      }
    };
  }

  if (call.name === 'search_code') {
    const query = requiredString(call.arguments.query, 'search_code requires a query.');
    if (query.length < 2 || query.length > 200) {
      throw new Error('The search query must contain between 2 and 200 characters.');
    }
    return {
      id: call.id,
      name: call.name,
      arguments: {
        query,
        path: normalizeAgentToolPath(optionalString(call.arguments.path)),
        maxResults: boundedInteger(
          call.arguments.maxResults,
          20,
          1,
          MAX_AGENT_SEARCH_RESULTS
        )
      }
    };
  }


  if (call.name === 'create_file') {
    return {
      id: call.id,
      name: call.name,
      arguments: parseCreateFileArguments(call.arguments)
    };
  }

  if (call.name === 'edit_file') {
    return {
      id: call.id,
      name: call.name,
      arguments: parseEditFileArguments(call.arguments)
    };
  }

  if (call.name === 'install_dependencies') {
    return {
      id: call.id,
      name: call.name,
      arguments: parseInstallDependenciesArguments(call.arguments)
    };
  }

  if (call.name === 'run_command') {
    return {
      id: call.id,
      name: call.name,
      arguments: parseRunCommandArguments(call.arguments)
    };
  }

  throw new Error('The model requested an unsupported tool.');
}

export function normalizeAgentToolCallForWorkspace(
  call: AgentToolCall,
  workspace: AgentWorkspacePathInfo
): AgentToolCall {
  const argumentName = call.name === 'run_command'
    ? 'cwd'
    : call.name === 'install_dependencies'
      ? 'manifestPath'
    : ['list_files', 'read_file', 'search_code', 'create_file', 'edit_file'].includes(call.name)
      ? 'path'
      : undefined;
  if (!argumentName || typeof call.arguments[argumentName] !== 'string') {
    return call;
  }
  const allowRoot = call.name === 'list_files'
    || call.name === 'search_code'
    || call.name === 'run_command';
  return {
    ...call,
    arguments: {
      ...call.arguments,
      [argumentName]: normalizeWorkspaceQualifiedPath(
        call.arguments[argumentName] as string,
        workspace,
        allowRoot
      )
    }
  };
}

export function agentToolCallSignature(call: AgentToolCall): string {
  const parsed = parseAgentToolCall(call);
  if (parsed.name === 'create_file') {
    return `${parsed.name}:${parsed.arguments.path}:${hashText(parsed.arguments.content)}`;
  }
  if (parsed.name === 'edit_file') {
    return `${parsed.name}:${parsed.arguments.path}:${hashText(JSON.stringify(parsed.arguments.replacements))}`;
  }
  return `${parsed.name}:${JSON.stringify(parsed.arguments)}`;
}

export function summarizedAgentToolArguments(
  call: ParsedAgentToolCall
): Record<string, unknown> {
  if (call.name === 'create_file') {
    return {
      path: call.arguments.path,
      content: `[omitted after execution: ${call.arguments.content.length} characters, sha256 ${hashText(call.arguments.content)}]`
    };
  }
  if (call.name === 'edit_file') {
    return {
      path: call.arguments.path,
      replacements: call.arguments.replacements.map((replacement) => ({
        oldText: `[${replacement.oldText.length} characters, sha256 ${hashText(replacement.oldText)}]`,
        newText: `[${replacement.newText.length} characters, sha256 ${hashText(replacement.newText)}]`
      }))
    };
  }
  return call.arguments;
}

export function normalizeAgentToolPath(value: string, allowRoot = true): string {
  const trimmed = value.trim();
  if (!trimmed && allowRoot) {
    return '';
  }
  if (
    !trimmed
    || trimmed.includes('\0')
    || trimmed.startsWith('/')
    || trimmed.startsWith('\\')
    || /^[A-Za-z]:/.test(trimmed)
  ) {
    throw new Error('Tool paths must be workspace-relative.');
  }

  const normalized = trimmed.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('The tool path contains unsafe segments.');
  }
  return normalized;
}

function normalizeWorkspaceQualifiedPath(
  value: string,
  workspace: AgentWorkspacePathInfo,
  allowRoot: boolean
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === '.' || trimmed === './' || trimmed === '.\\') {
    return allowRoot ? '' : trimmed;
  }

  let normalized = trimmed.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  const rootPath = workspace.fsPath?.replace(/\\/g, '/').replace(/\/+$/, '');
  if (rootPath && isAbsoluteLike(normalized)) {
    const caseInsensitive = /^[A-Za-z]:\//.test(rootPath) || rootPath.startsWith('//');
    const comparableRoot = caseInsensitive ? rootPath.toLocaleLowerCase() : rootPath;
    const comparableValue = caseInsensitive ? normalized.toLocaleLowerCase() : normalized;
    if (comparableValue === comparableRoot) {
      return allowRoot ? '' : trimmed;
    }
    if (comparableValue.startsWith(`${comparableRoot}/`)) {
      return normalized.slice(rootPath.length + 1);
    }
    return trimmed;
  }

  const rootName = workspace.name.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!rootName) {
    return normalized;
  }
  const caseInsensitive = process.platform === 'win32';
  const comparableName = caseInsensitive ? rootName.toLocaleLowerCase() : rootName;
  const comparableValue = caseInsensitive ? normalized.toLocaleLowerCase() : normalized;
  if (comparableValue === comparableName) {
    return allowRoot ? '' : normalized;
  }
  if (comparableValue.startsWith(`${comparableName}/`)) {
    return normalized.slice(rootName.length + 1);
  }
  return normalized;
}

function isAbsoluteLike(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value);
}

export function truncateAgentToolResult(value: string): string {
  if (value.length <= MAX_AGENT_TOOL_RESULT_CHARACTERS) {
    return value;
  }
  const marker = '\n[Tool result truncated]';
  return `${value.slice(0, MAX_AGENT_TOOL_RESULT_CHARACTERS - marker.length)}${marker}`;
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(message);
  }
  return value.trim();
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function parseLineRange(
  startValue: unknown,
  endValue: unknown
): Pick<ReadFileToolArguments, 'startLine' | 'endLine'> {
  if (startValue === undefined && endValue === undefined) {
    return {};
  }
  const startLine = boundedInteger(startValue, 1, 1, 1_000_000);
  const endLine = boundedInteger(endValue, startLine + 399, startLine, 1_000_000);
  if (endLine - startLine + 1 > 400) {
    throw new Error('read_file can return at most 400 lines at once.');
  }
  return { startLine, endLine };
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
