const configuration = {
  maxTokens: 16384, temperature: 0.2, timeoutSeconds: 900, commandTimeoutSeconds: 300,
  toolCallLimit: 16, maxFileEdits: 6, maxCommands: 3, maxRepairAttempts: 3,
  contextCharacters: 40000, historyCharacters: 80000, runTokenBudget: 0,
  instructions: '', excludedPaths: [], pinnedFiles: [], enabledTools: ['read_file', 'edit_file'],
  reasoningEffort: 'auto'
};
const agentTools = {
  readFileMaxLines: 400, listFilesMaxResults: 200, searchCodeMaxResults: 50,
  diagnosticsMaxResults: 100, terminalErrorsMaxResults: 5, codeNavigationMaxResults: 100
};

function loadSettings(view, overrides = {}, toolOverrides = {}, scope = 'workspace') {
  const configurationState = {
    command: 'configurationState', scope, workspaceAvailable: true,
    configuration: { ...configuration, ...overrides }, overrides,
    effectiveConfiguration: { ...configuration, ...overrides }, inheritedConfiguration: configuration,
    toolNames: ['read_file', 'edit_file']
  };
  const settingsState = {
    command: 'settingsUpdated', settings: {
      scope, agentTools: { ...agentTools, ...toolOverrides }, agentToolOverrides: toolOverrides,
      inheritedAgentTools: agentTools, rememberedCommands: [], workspaceTrusted: true
    }
  };
  view.receive(settingsState);
  view.receive(configurationState);
  return { configurationState, settingsState };
}

module.exports = { configuration, agentTools, loadSettings };
