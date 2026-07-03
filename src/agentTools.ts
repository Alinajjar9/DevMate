import { createHash } from 'crypto';
import { parseRunCommandArguments } from './commandTools';
import { parseInstallDependenciesArguments } from './dependencyTools';
import type { InstallDependenciesToolArguments } from './dependencyTools';
import { agentHistoryOmissionMarker } from './fileChanges';
import {
  parseCreateFileArguments,
  parseDeleteFileArguments,
  parseEditFileArguments,
  parseMoveFileArguments,
  parseRenameFileArguments
} from './fileTools';
import type { ExactTextReplacement, RelocateFileToolArguments } from './fileTools';

export const DEFAULT_AGENT_TOOL_CALL_LIMIT = 16;
export const MIN_AGENT_TOOL_CALL_LIMIT = 4;
export const MAX_AGENT_TOOL_CALL_LIMIT = 100;
export const MAX_AGENT_FILE_MUTATIONS = 6;
export const MAX_AGENT_COMMAND_CALLS = 3;
export const MAX_AGENT_DEPENDENCY_INSTALLS = 1;
export const MAX_AGENT_LIST_RESULTS = 500;
export const MAX_AGENT_SEARCH_RESULTS = 200;
export const MAX_AGENT_DIAGNOSTIC_RESULTS = 300;
export const MAX_AGENT_TERMINAL_ERROR_RESULTS = 10;
export const MAX_AGENT_CODE_NAVIGATION_RESULTS = 300;
export const MAX_AGENT_READ_LINES = 1_000;
export const MAX_AGENT_TOOL_RESULT_CHARACTERS = 10_000;
export const MAX_AGENT_TOOL_HISTORY_CHARACTERS = 80_000;
export const MAX_AGENT_TOOL_ARGUMENT_HISTORY_CHARACTERS = 3_500;
export const MAX_AGENT_CONSECUTIVE_INSPECTIONS = 16;

export function boundedAgentToolCallLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return DEFAULT_AGENT_TOOL_CALL_LIMIT;
  }
  return Math.min(MAX_AGENT_TOOL_CALL_LIMIT, Math.max(MIN_AGENT_TOOL_CALL_LIMIT, value));
}

export function isDeferredAgentPlanAnswer(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/^[\s#>*_-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || normalized.length > 1_200) {
    return false;
  }
  const action = '(?:start|begin|inspect|read|examine|review|create|implement|build|update|fix|reorganize|set up)';
  return new RegExp(
    `^(?:(?:okay|sure)[,.]?\\s+)?(?:i(?:['’]ll|\\s+will)\\s+(?:first\\s+|now\\s+)?${action}\\b|let me\\s+(?:first\\s+)?${action}\\b)`,
    'i'
  ).test(normalized);
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

export const AGENT_TOOL_NAMES = [
  'list_files',
  'read_file',
  'search_code',
  'get_symbols',
  'find_definition',
  'find_references',
  'get_diagnostics',
  'read_terminal_errors',
  'create_file',
  'edit_file',
  'delete_file',
  'rename_file',
  'move_file',
  'install_dependencies',
  'run_command'
] as const;

export type AgentToolName = typeof AGENT_TOOL_NAMES[number];

// Tool groups live here so checkpoints and loop limits cannot quietly drift apart.
export const READ_ONLY_AGENT_TOOL_NAMES = [
  'list_files',
  'read_file',
  'search_code',
  'get_symbols',
  'find_definition',
  'find_references',
  'get_diagnostics',
  'read_terminal_errors'
] as const satisfies readonly AgentToolName[];

export const FILE_MUTATION_AGENT_TOOL_NAMES = [
  'create_file',
  'edit_file',
  'delete_file',
  'rename_file',
  'move_file'
] as const satisfies readonly AgentToolName[];

const readOnlyAgentTools = new Set<AgentToolName>(READ_ONLY_AGENT_TOOL_NAMES);
const fileMutationAgentTools = new Set<AgentToolName>(FILE_MUTATION_AGENT_TOOL_NAMES);

export function isReadOnlyAgentTool(name: AgentToolName): boolean {
  return readOnlyAgentTools.has(name);
}

export function isFileMutationAgentTool(name: AgentToolName): boolean {
  return fileMutationAgentTools.has(name);
}

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

export type GetDiagnosticsToolArguments = {
  path: string;
  maxResults: number;
};

export type GetSymbolsToolArguments = {
  path: string;
  maxResults: number;
};

export type FindDefinitionToolArguments = {
  path: string;
  line: number;
  column: number;
  maxResults: number;
};

export type FindReferencesToolArguments = FindDefinitionToolArguments;

export type ReadTerminalErrorsToolArguments = {
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

export type DeleteFileToolArguments = {
  path: string;
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
  | { id: string; name: 'get_symbols'; arguments: GetSymbolsToolArguments }
  | { id: string; name: 'find_definition'; arguments: FindDefinitionToolArguments }
  | { id: string; name: 'find_references'; arguments: FindReferencesToolArguments }
  | { id: string; name: 'get_diagnostics'; arguments: GetDiagnosticsToolArguments }
  | { id: string; name: 'read_terminal_errors'; arguments: ReadTerminalErrorsToolArguments }
  | { id: string; name: 'create_file'; arguments: CreateFileToolArguments }
  | { id: string; name: 'edit_file'; arguments: EditFileToolArguments }
  | { id: string; name: 'delete_file'; arguments: DeleteFileToolArguments }
  | { id: string; name: 'rename_file'; arguments: RelocateFileToolArguments }
  | { id: string; name: 'move_file'; arguments: RelocateFileToolArguments }
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

  if (call.name === 'get_diagnostics') {
    return {
      id: call.id,
      name: call.name,
      arguments: {
        path: normalizeAgentToolPath(optionalString(call.arguments.path)),
        maxResults: boundedInteger(
          call.arguments.maxResults,
          50,
          1,
          MAX_AGENT_DIAGNOSTIC_RESULTS
        )
      }
    };
  }

  if (call.name === 'get_symbols') {
    return {
      id: call.id,
      name: call.name,
      arguments: {
        path: normalizeAgentToolPath(
          requiredString(call.arguments.path, 'get_symbols requires a path.'),
          false
        ),
        maxResults: boundedInteger(
          call.arguments.maxResults,
          100,
          1,
          MAX_AGENT_CODE_NAVIGATION_RESULTS
        )
      }
    };
  }

  if (call.name === 'find_definition' || call.name === 'find_references') {
    const commonArguments = {
      path: normalizeAgentToolPath(
        requiredString(call.arguments.path, `${call.name} requires a path.`),
        false
      ),
      line: requiredPositiveInteger(
        call.arguments.line,
        `${call.name} requires a positive one-based line.`
      ),
      column: requiredPositiveInteger(
        call.arguments.column,
        `${call.name} requires a positive one-based column.`
      ),
      maxResults: boundedInteger(
        call.arguments.maxResults,
        call.name === 'find_definition' ? 20 : 100,
        1,
        MAX_AGENT_CODE_NAVIGATION_RESULTS
      )
    };
    return call.name === 'find_definition'
      ? { id: call.id, name: call.name, arguments: commonArguments }
      : { id: call.id, name: call.name, arguments: commonArguments };
  }

  if (call.name === 'read_terminal_errors') {
    return {
      id: call.id,
      name: call.name,
      arguments: {
        maxResults: boundedInteger(
          call.arguments.maxResults,
          3,
          1,
          MAX_AGENT_TERMINAL_ERROR_RESULTS
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

  if (call.name === 'delete_file') {
    return {
      id: call.id,
      name: call.name,
      arguments: parseDeleteFileArguments(call.arguments)
    };
  }

  if (call.name === 'rename_file') {
    return {
      id: call.id,
      name: call.name,
      arguments: parseRenameFileArguments(call.arguments)
    };
  }

  if (call.name === 'move_file') {
    return {
      id: call.id,
      name: call.name,
      arguments: parseMoveFileArguments(call.arguments)
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
  const primaryArgumentName = call.name === 'run_command'
    ? 'cwd'
    : call.name === 'install_dependencies'
      ? 'manifestPath'
    : [
        'list_files',
        'read_file',
        'search_code',
        'get_symbols',
        'find_definition',
        'find_references',
        'get_diagnostics',
        'create_file',
        'edit_file',
        'delete_file',
        'rename_file',
        'move_file'
      ].includes(call.name)
      ? 'path'
      : undefined;
  const argumentNames = primaryArgumentName
    ? [primaryArgumentName, ...(['rename_file', 'move_file'].includes(call.name) ? ['newPath'] : [])]
    : [];
  if (argumentNames.length === 0) {
    return call;
  }
  const allowRoot = call.name === 'list_files'
    || call.name === 'search_code'
    || call.name === 'get_diagnostics'
    || call.name === 'run_command';
  const normalizedArguments = { ...call.arguments };
  for (const argumentName of argumentNames) {
    if (typeof normalizedArguments[argumentName] === 'string') {
      normalizedArguments[argumentName] = normalizeWorkspaceQualifiedPath(
        normalizedArguments[argumentName] as string,
        workspace,
        allowRoot
      );
    }
  }
  return { ...call, arguments: normalizedArguments };
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
    return boundedAgentToolHistoryArguments(call.name, {
      path: call.arguments.path,
      content: agentHistoryOmissionMarker(
        'content',
        call.arguments.content.length,
        hashText(call.arguments.content)
      )
    });
  }
  if (call.name === 'edit_file') {
    const serializedReplacements = JSON.stringify(call.arguments.replacements);
    return boundedAgentToolHistoryArguments(call.name, {
      path: call.arguments.path,
      replacementCount: call.arguments.replacements.length,
      replacements: agentHistoryOmissionMarker(
        'text',
        serializedReplacements.length,
        hashText(serializedReplacements)
      )
    });
  }
  return boundedAgentToolHistoryArguments(call.name, call.arguments);
}

export function boundedAgentToolHistoryArguments(
  name: string,
  argumentsValue: Record<string, unknown>
): Record<string, unknown> {
  let serialized: string;
  try {
    serialized = JSON.stringify(argumentsValue);
  } catch {
    serialized = '[unserializable tool arguments]';
  }
  if (serialized.length <= MAX_AGENT_TOOL_ARGUMENT_HISTORY_CHARACTERS) {
    return argumentsValue;
  }
  return {
    summary: agentHistoryOmissionMarker(
      'content',
      serialized.length,
      hashText(`${name}:${serialized}`)
    )
  };
}

export function consecutiveAgentInspectionCalls(
  steps: Array<{ name: string; isError: boolean }>
): number {
  let inspections = 0;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (!step.isError && [
      'create_file',
      'edit_file',
      'delete_file',
      'rename_file',
      'move_file',
      'install_dependencies',
      'run_command'
    ].includes(step.name)) {
      break;
    }
    if ([
      'list_files',
      'read_file',
      'search_code',
      'get_symbols',
      'find_definition',
      'find_references',
      'get_diagnostics',
      'read_terminal_errors'
    ].includes(step.name)) {
      inspections += 1;
    }
  }
  return inspections;
}

export function summarizeAgentToolHistory(
  steps: Array<{
    name: string;
    arguments: Record<string, unknown>;
    result: string;
    isError: boolean;
  }>,
  finalizationError: string
): string {
  const completedChanges: string[] = [];
  const verification: string[] = [];
  let failedCalls = 0;

  for (const step of steps) {
    if (step.name === 'run_command') {
      const command = commandSummary(step.arguments);
      const exitCode = /(?:^|\n)Exit code:\s*(-?\d+)/i.exec(step.result)?.[1];
      verification.push(exitCode === undefined
        ? `${command} did not return a usable exit code.`
        : `${command} exited with code ${exitCode}.`);
    }
    if (step.isError) {
      failedCalls += 1;
      continue;
    }
    const path = boundedSummaryValue(step.arguments.path);
    const newPath = boundedSummaryValue(step.arguments.newPath);
    if (step.name === 'create_file' && path) {
      completedChanges.push(`Created ${path}.`);
    } else if (step.name === 'edit_file' && path) {
      completedChanges.push(`Updated ${path}.`);
    } else if (step.name === 'delete_file' && path) {
      completedChanges.push(`Deleted ${path}.`);
    } else if (step.name === 'rename_file' && path && newPath) {
      completedChanges.push(`Renamed ${path} to ${newPath}.`);
    } else if (step.name === 'move_file' && path && newPath) {
      completedChanges.push(`Moved ${path} to ${newPath}.`);
    } else if (step.name === 'install_dependencies') {
      const manifestPath = boundedSummaryValue(step.arguments.manifestPath);
      completedChanges.push(manifestPath
        ? `Installed dependencies from ${manifestPath}.`
        : 'Installed the approved project dependencies.');
    }
  }

  const lines = [
    'DevMate completed the available project-tool work, but the model did not return a usable final summary.',
    '',
    completedChanges.length > 0 ? 'Completed:' : 'No file changes were completed.',
    ...completedChanges.map((item) => `- ${item}`)
  ];
  if (verification.length > 0) {
    lines.push('', 'Verification:', ...verification.map((item) => `- ${item}`));
  }
  if (failedCalls > 0) {
    lines.push(
      '',
      `${failedCalls} tool ${failedCalls === 1 ? 'request failed or was rejected' : 'requests failed or were rejected'}; review the tool cards for details.`
    );
  }
  lines.push(
    '',
    `Remaining issue: ${boundedSummaryValue(finalizationError, 300) || 'The model could not finalize the request.'}`,
    'Start a follow-up request if more project work is needed.'
  );
  return lines.join('\n');
}

function commandSummary(argumentsValue: Record<string, unknown>): string {
  const executable = boundedSummaryValue(argumentsValue.executable, 80) || 'Verification command';
  const args = Array.isArray(argumentsValue.args)
    ? argumentsValue.args
      .filter((value): value is string => typeof value === 'string')
      .map((value) => boundedSummaryValue(value, 80))
      .filter(Boolean)
      .slice(0, 12)
    : [];
  return [executable, ...args].join(' ');
}

function boundedSummaryValue(value: unknown, maximum = 240): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum)
    : '';
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

function requiredPositiveInteger(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10_000_000) {
    throw new Error(message);
  }
  return value;
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
  if (endValue === undefined) {
    return { startLine };
  }
  const endLine = boundedInteger(endValue, startLine, startLine, 1_000_000);
  if (endLine - startLine + 1 > MAX_AGENT_READ_LINES) {
    throw new Error(`read_file can return at most ${MAX_AGENT_READ_LINES} lines at once.`);
  }
  return { startLine, endLine };
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
