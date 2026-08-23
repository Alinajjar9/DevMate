// This file contains the shared tool names and call shape used at API boundaries.
// It must stay independent from tool implementations so contracts cannot create import cycles.
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
