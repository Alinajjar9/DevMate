export const MAX_AGENT_TOOL_CALLS = 8;
export const MAX_AGENT_LIST_RESULTS = 200;
export const MAX_AGENT_SEARCH_RESULTS = 50;
export const MAX_AGENT_TOOL_RESULT_CHARACTERS = 10_000;

export type AgentToolName = 'list_files' | 'read_file' | 'search_code';

export type AgentToolCall = {
  id: string;
  name: AgentToolName;
  arguments: Record<string, unknown>;
};

export type ListFilesToolArguments = {
  path: string;
  maxResults: number;
};

export type ReadFileToolArguments = {
  path: string;
};

export type SearchCodeToolArguments = {
  query: string;
  path: string;
  maxResults: number;
};

export type ParsedAgentToolCall =
  | { id: string; name: 'list_files'; arguments: ListFilesToolArguments }
  | { id: string; name: 'read_file'; arguments: ReadFileToolArguments }
  | { id: string; name: 'search_code'; arguments: SearchCodeToolArguments };

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
    return {
      id: call.id,
      name: call.name,
      arguments: { path: normalizeAgentToolPath(filePath, false) }
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

  throw new Error('The model requested an unsupported tool.');
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
