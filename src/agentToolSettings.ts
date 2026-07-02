export const DEFAULT_READ_FILE_MAX_LINES = 400;
export const MIN_READ_FILE_MAX_LINES = 100;
export const MAX_READ_FILE_MAX_LINES = 1_000;

export const DEFAULT_LIST_FILES_MAX_RESULTS = 200;
export const MIN_LIST_FILES_MAX_RESULTS = 20;
export const MAX_LIST_FILES_MAX_RESULTS = 500;

export const DEFAULT_SEARCH_CODE_MAX_RESULTS = 50;
export const MIN_SEARCH_CODE_MAX_RESULTS = 10;
export const MAX_SEARCH_CODE_MAX_RESULTS = 200;

export const DEFAULT_DIAGNOSTICS_MAX_RESULTS = 100;
export const MIN_DIAGNOSTICS_MAX_RESULTS = 10;
export const MAX_DIAGNOSTICS_MAX_RESULTS = 300;

export const DEFAULT_TERMINAL_ERRORS_MAX_RESULTS = 5;
export const MIN_TERMINAL_ERRORS_MAX_RESULTS = 1;
export const MAX_TERMINAL_ERRORS_MAX_RESULTS = 10;

export const DEFAULT_CODE_NAVIGATION_MAX_RESULTS = 100;
export const MIN_CODE_NAVIGATION_MAX_RESULTS = 10;
export const MAX_CODE_NAVIGATION_MAX_RESULTS = 300;

export type AgentToolSettings = {
  readFileMaxLines: number;
  listFilesMaxResults: number;
  searchCodeMaxResults: number;
  diagnosticsMaxResults: number;
  terminalErrorsMaxResults: number;
  codeNavigationMaxResults: number;
};

export function normalizeAgentToolSettings(value: Partial<AgentToolSettings>): AgentToolSettings {
  return {
    readFileMaxLines: boundedInteger(
      value.readFileMaxLines,
      DEFAULT_READ_FILE_MAX_LINES,
      MIN_READ_FILE_MAX_LINES,
      MAX_READ_FILE_MAX_LINES
    ),
    listFilesMaxResults: boundedInteger(
      value.listFilesMaxResults,
      DEFAULT_LIST_FILES_MAX_RESULTS,
      MIN_LIST_FILES_MAX_RESULTS,
      MAX_LIST_FILES_MAX_RESULTS
    ),
    searchCodeMaxResults: boundedInteger(
      value.searchCodeMaxResults,
      DEFAULT_SEARCH_CODE_MAX_RESULTS,
      MIN_SEARCH_CODE_MAX_RESULTS,
      MAX_SEARCH_CODE_MAX_RESULTS
    ),
    diagnosticsMaxResults: boundedInteger(
      value.diagnosticsMaxResults,
      DEFAULT_DIAGNOSTICS_MAX_RESULTS,
      MIN_DIAGNOSTICS_MAX_RESULTS,
      MAX_DIAGNOSTICS_MAX_RESULTS
    ),
    terminalErrorsMaxResults: boundedInteger(
      value.terminalErrorsMaxResults,
      DEFAULT_TERMINAL_ERRORS_MAX_RESULTS,
      MIN_TERMINAL_ERRORS_MAX_RESULTS,
      MAX_TERMINAL_ERRORS_MAX_RESULTS
    ),
    codeNavigationMaxResults: boundedInteger(
      value.codeNavigationMaxResults,
      DEFAULT_CODE_NAVIGATION_MAX_RESULTS,
      MIN_CODE_NAVIGATION_MAX_RESULTS,
      MAX_CODE_NAVIGATION_MAX_RESULTS
    )
  };
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}
