"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_TERMINAL_ERRORS_MAX_RESULTS = exports.MIN_TERMINAL_ERRORS_MAX_RESULTS = exports.DEFAULT_TERMINAL_ERRORS_MAX_RESULTS = exports.MAX_DIAGNOSTICS_MAX_RESULTS = exports.MIN_DIAGNOSTICS_MAX_RESULTS = exports.DEFAULT_DIAGNOSTICS_MAX_RESULTS = exports.MAX_SEARCH_CODE_MAX_RESULTS = exports.MIN_SEARCH_CODE_MAX_RESULTS = exports.DEFAULT_SEARCH_CODE_MAX_RESULTS = exports.MAX_LIST_FILES_MAX_RESULTS = exports.MIN_LIST_FILES_MAX_RESULTS = exports.DEFAULT_LIST_FILES_MAX_RESULTS = exports.MAX_READ_FILE_MAX_LINES = exports.MIN_READ_FILE_MAX_LINES = exports.DEFAULT_READ_FILE_MAX_LINES = void 0;
exports.normalizeAgentToolSettings = normalizeAgentToolSettings;
exports.DEFAULT_READ_FILE_MAX_LINES = 400;
exports.MIN_READ_FILE_MAX_LINES = 100;
exports.MAX_READ_FILE_MAX_LINES = 1_000;
exports.DEFAULT_LIST_FILES_MAX_RESULTS = 200;
exports.MIN_LIST_FILES_MAX_RESULTS = 20;
exports.MAX_LIST_FILES_MAX_RESULTS = 500;
exports.DEFAULT_SEARCH_CODE_MAX_RESULTS = 50;
exports.MIN_SEARCH_CODE_MAX_RESULTS = 10;
exports.MAX_SEARCH_CODE_MAX_RESULTS = 200;
exports.DEFAULT_DIAGNOSTICS_MAX_RESULTS = 100;
exports.MIN_DIAGNOSTICS_MAX_RESULTS = 10;
exports.MAX_DIAGNOSTICS_MAX_RESULTS = 300;
exports.DEFAULT_TERMINAL_ERRORS_MAX_RESULTS = 5;
exports.MIN_TERMINAL_ERRORS_MAX_RESULTS = 1;
exports.MAX_TERMINAL_ERRORS_MAX_RESULTS = 10;
function normalizeAgentToolSettings(value) {
    return {
        readFileMaxLines: boundedInteger(value.readFileMaxLines, exports.DEFAULT_READ_FILE_MAX_LINES, exports.MIN_READ_FILE_MAX_LINES, exports.MAX_READ_FILE_MAX_LINES),
        listFilesMaxResults: boundedInteger(value.listFilesMaxResults, exports.DEFAULT_LIST_FILES_MAX_RESULTS, exports.MIN_LIST_FILES_MAX_RESULTS, exports.MAX_LIST_FILES_MAX_RESULTS),
        searchCodeMaxResults: boundedInteger(value.searchCodeMaxResults, exports.DEFAULT_SEARCH_CODE_MAX_RESULTS, exports.MIN_SEARCH_CODE_MAX_RESULTS, exports.MAX_SEARCH_CODE_MAX_RESULTS),
        diagnosticsMaxResults: boundedInteger(value.diagnosticsMaxResults, exports.DEFAULT_DIAGNOSTICS_MAX_RESULTS, exports.MIN_DIAGNOSTICS_MAX_RESULTS, exports.MAX_DIAGNOSTICS_MAX_RESULTS),
        terminalErrorsMaxResults: boundedInteger(value.terminalErrorsMaxResults, exports.DEFAULT_TERMINAL_ERRORS_MAX_RESULTS, exports.MIN_TERMINAL_ERRORS_MAX_RESULTS, exports.MAX_TERMINAL_ERRORS_MAX_RESULTS)
    };
}
function boundedInteger(value, fallback, minimum, maximum) {
    return typeof value === 'number' && Number.isInteger(value)
        ? Math.min(maximum, Math.max(minimum, value))
        : fallback;
}
//# sourceMappingURL=agentToolSettings.js.map