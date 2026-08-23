    const vscode = acquireVsCodeApi();
    const MAX_INTERMEDIATE_NARRATION_CHARACTERS = 220;
    const state = {
      mode: 'code',
      scope: {
        kind: 'project',
        label: 'Project',
        detail: ''
      },
      attachments: [],
      attachmentsExpanded: false,
      activeProfile: undefined,
      profileCount: 0,
      activeEmbeddingProfile: undefined,
      embeddingProfileCount: 0,
      permissionPolicy: {
        createFiles: 'ask',
        updateFiles: 'ask'
      },
      settings: {
        timeoutSeconds: 900,
        commandTimeoutSeconds: 300,
        toolCallLimit: 16,
        maxTokens: 16384,
        temperature: 0.2,
        agentTools: {
          readFileMaxLines: 400,
          listFilesMaxResults: 200,
          searchCodeMaxResults: 50,
          diagnosticsMaxResults: 100,
          terminalErrorsMaxResults: 5,
          codeNavigationMaxResults: 100
        },
        rememberedCommands: [],
        workspaceTrusted: true
      },
      backendStatus: {
        state: 'checking',
        detail: 'Checking the configured backend.',
        managed: false,
        canRestart: false
      },
      backendLabel: 'Checking backend',
      sessions: [],
      activeSessionId: '',
      activeSessionTitle: 'New session',
      currentWorkspaceName: 'No project open',
      workingStartedAt: 0,
      workingTimer: undefined,
      streamQueue: '',
      narrationText: '',
      streamPumpTimer: undefined,
      pendingAssistantResponse: undefined,
      toolUsage: { used: 0, limit: 16 },
      requestTokenUsage: undefined,
      checkpointAvailable: false,
      lastRequest: undefined,
      askPending: false
    };

    const statusEl = document.getElementById('status');
    const sessionHomeEl = document.getElementById('sessionHome');
    const chatAppEl = document.getElementById('chatApp');
    const currentProjectLabelEl = document.getElementById('currentProjectLabel');
    const sessionProjectWarningEl = document.getElementById('sessionProjectWarning');
    const sessionEmptyEl = document.getElementById('sessionEmpty');
    const messagesEl = document.getElementById('messages');
    const questionEl = document.getElementById('question');
    const scopeDetailEl = document.getElementById('scopeDetail');
    const attachmentPanelEl = document.getElementById('attachmentPanel');
    const attachmentListEl = document.getElementById('attachmentList');
    const attachFilesEl = document.getElementById('attachFiles');
    const attachmentToggleEl = document.getElementById('toggleAttachments');
    const llmProfileSelectorEl = document.getElementById('llmProfileSelector');
    const llmProfileLabelEl = document.getElementById('llmProfileLabel');
    const intelligenceControlEl = document.getElementById('intelligenceControl');
    const intelligenceButtonEl = document.getElementById('intelligenceButton');
    const intelligenceMenuEl = document.getElementById('intelligenceMenu');
    const intelligenceMenuOptionsEl = document.getElementById('intelligenceMenuOptions');
    const tokenEstimateEl = document.getElementById('tokenEstimate');
    const continueAgentEl = document.getElementById('continueAgent');
    const askEl = document.getElementById('ask');
    const sessionSelectorEl = document.getElementById('sessionSelector');
    const activeSessionTitleEl = document.getElementById('activeSessionTitle');
    const newSessionButtonEl = document.getElementById('newSessionButton');
    const sessionListEl = document.getElementById('sessionList');
    const newSessionOnHomeEl = document.getElementById('newSessionOnHome');
    const llmProfilePickerDialogEl = document.getElementById('llmProfilePickerDialog');
    const llmProfilePickerListEl = document.getElementById('llmProfilePickerList');
    const llmProfileDialogEl = document.getElementById('llmProfileDialog');
    const llmProfileFormEl = document.getElementById('llmProfileForm');
    const llmProfileFormTitleEl = document.getElementById('llmProfileFormTitle');
    const llmProfileFormDescriptionEl = document.getElementById('llmProfileFormDescription');
    const llmProfileIdEl = document.getElementById('llmProfileId');
    const llmProfileNameEl = document.getElementById('llmProfileName');
    const llmProfileProviderEl = document.getElementById('llmProfileProvider');
    const llmProfileModelEl = document.getElementById('llmProfileModel');
    const llmProfileBaseUrlEl = document.getElementById('llmProfileBaseUrl');
    const llmProfileBaseUrlHelpEl = document.getElementById('llmProfileBaseUrlHelp');
    const llmProfileApiKeyFieldEl = document.getElementById('llmProfileApiKeyField');
    const llmProfileApiKeyEl = document.getElementById('llmProfileApiKey');
    const llmProfileApiKeyHelpEl = document.getElementById('llmProfileApiKeyHelp');
    const llmProfileFormErrorEl = document.getElementById('llmProfileFormError');
    const deleteLlmProfileEl = document.getElementById('deleteLlmProfile');
    const saveLlmProfileEl = document.getElementById('saveLlmProfile');
    const embeddingProfileSettingsLabelEl = document.getElementById('embeddingProfileSettingsLabel');
    const embeddingProfileSettingsDetailEl = document.getElementById('embeddingProfileSettingsDetail');
    const manageEmbeddingProfilesEl = document.getElementById('manageEmbeddingProfiles');
    const embeddingProfilePickerDialogEl = document.getElementById('embeddingProfilePickerDialog');
    const embeddingProfilePickerListEl = document.getElementById('embeddingProfilePickerList');
    const embeddingProfileDialogEl = document.getElementById('embeddingProfileDialog');
    const embeddingProfileFormEl = document.getElementById('embeddingProfileForm');
    const embeddingProfileFormTitleEl = document.getElementById('embeddingProfileFormTitle');
    const embeddingProfileIdEl = document.getElementById('embeddingProfileId');
    const embeddingProfileProviderEl = document.getElementById('embeddingProfileProvider');
    const embeddingProfileModelEl = document.getElementById('embeddingProfileModel');
    const embeddingProfileBaseUrlEl = document.getElementById('embeddingProfileBaseUrl');
    const embeddingProfileBaseUrlHelpEl = document.getElementById('embeddingProfileBaseUrlHelp');
    const embeddingProfileApiKeyEl = document.getElementById('embeddingProfileApiKey');
    const embeddingProfileApiKeyHelpEl = document.getElementById('embeddingProfileApiKeyHelp');
    const embeddingRemoteConsentFieldEl = document.getElementById('embeddingRemoteConsentField');
    const embeddingProfileRemoteAllowedEl = document.getElementById('embeddingProfileRemoteAllowed');
    const embeddingProfileFormErrorEl = document.getElementById('embeddingProfileFormError');
    const deleteEmbeddingProfileEl = document.getElementById('deleteEmbeddingProfile');
    const saveEmbeddingProfileEl = document.getElementById('saveEmbeddingProfile');
    const settingsButtonEl = document.getElementById('settingsButton');
    const backendStatusEl = document.getElementById('backendStatus');
    const permissionDialogEl = document.getElementById('permissionDialog');
    const permissionFormEl = document.getElementById('permissionForm');
    const permissionCreateFilesEl = document.getElementById('permissionCreateFiles');
    const permissionUpdateFilesEl = document.getElementById('permissionUpdateFiles');
    const settingsTimeoutSecondsEl = document.getElementById('settingsTimeoutSeconds');
    const settingsTimeoutHelpEl = document.getElementById('settingsTimeoutHelp');
    const settingsCommandTimeoutSecondsEl = document.getElementById('settingsCommandTimeoutSeconds');
    const settingsToolCallLimitEl = document.getElementById('settingsToolCallLimit');
    const settingsMaxTokensEl = document.getElementById('settingsMaxTokens');
    const settingsTemperatureEl = document.getElementById('settingsTemperature');
    const agentToolSettingsDialogEl = document.getElementById('agentToolSettingsDialog');
    const agentToolSettingsFormEl = document.getElementById('agentToolSettingsForm');
    const settingsReadFileMaxLinesEl = document.getElementById('settingsReadFileMaxLines');
    const settingsListFilesMaxResultsEl = document.getElementById('settingsListFilesMaxResults');
    const settingsSearchCodeMaxResultsEl = document.getElementById('settingsSearchCodeMaxResults');
    const settingsDiagnosticsMaxResultsEl = document.getElementById('settingsDiagnosticsMaxResults');
    const settingsTerminalErrorsMaxResultsEl = document.getElementById('settingsTerminalErrorsMaxResults');
    const settingsCodeNavigationMaxResultsEl = document.getElementById('settingsCodeNavigationMaxResults');
    const rememberedCommandListEl = document.getElementById('rememberedCommandList');
    const clearRememberedCommandsEl = document.getElementById('clearRememberedCommands');
    const workspaceTrustBadgeEl = document.getElementById('workspaceTrustBadge');
    const backendSettingsLabelEl = document.getElementById('backendSettingsLabel');
    const backendSettingsDetailEl = document.getElementById('backendSettingsDetail');
    const backendSettingsBadgeEl = document.getElementById('backendSettingsBadge');
    const restartBackendEl = document.getElementById('restartBackend');
    const openBackendLogsEl = document.getElementById('openBackendLogs');
    const ollamaDefaultBaseUrl = 'http://127.0.0.1:11434';
    const openAiEmbeddingDefaultBaseUrl = 'https://api.openai.com/v1';

    document.querySelectorAll('.mode-button').forEach((button) => {
      button.addEventListener('click', () => {
        state.mode = button.dataset.mode;
        document.querySelectorAll('.mode-button').forEach((candidate) => {
          candidate.setAttribute('aria-pressed', String(candidate === button));
        });
      });
    });

    document.querySelectorAll('.scope-button[data-scope]').forEach((button) => {
      button.addEventListener('click', () => {
        vscode.postMessage({
          command: 'setScope',
          scope: button.dataset.scope
        });
      });
    });

    askEl.addEventListener('click', () => {
      const question = questionEl.value.trim();
      if (!question) {
        setStatus('Enter a question before asking.', 'warning');
        questionEl.focus();
        return;
      }

      appendMessage(question, 'user');
      questionEl.value = '';
      state.requestTokenUsage = undefined;
      renderTokenEstimate();
      state.askPending = true;
      startWorkingTurn();
      renderAskAvailability();
      state.lastRequest = {
        command: 'ask',
        mode: state.mode,
        question,
        scope: state.scope,
        isNewTurn: true
      };
      vscode.postMessage(state.lastRequest);
    });

    questionEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        askEl.click();
      }
    });

    questionEl.addEventListener('input', renderTokenEstimate);

    continueAgentEl.addEventListener('click', () => {
      if (!state.checkpointAvailable || state.askPending) {
        return;
      }
      state.askPending = true;
      setStatus('Ready');
      startWorkingTurn();
      renderAskAvailability();
      vscode.postMessage({ command: 'continueAgentRun' });
    });

    attachFilesEl.addEventListener('click', () => {
      vscode.postMessage({ command: 'pickFiles' });
    });

    llmProfileSelectorEl.addEventListener('click', () => {
      closeIntelligenceMenu();
      vscode.postMessage({ command: 'chooseLlmProfile' });
    });

    intelligenceButtonEl.addEventListener('click', (event) => {
      event.stopPropagation();
      if (intelligenceButtonEl.disabled) {
        return;
      }
      const willOpen = intelligenceMenuEl.hidden;
      intelligenceMenuEl.hidden = !willOpen;
      intelligenceButtonEl.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) {
        intelligenceMenuOptionsEl.querySelector('[aria-checked="true"]')?.focus();
      }
    });

    document.addEventListener('click', (event) => {
      if (!intelligenceControlEl.contains(event.target)) {
        closeIntelligenceMenu();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !intelligenceMenuEl.hidden) {
        closeIntelligenceMenu();
        intelligenceButtonEl.focus();
      }
    });

    document.getElementById('cancelLlmProfilePicker').addEventListener('click', () => {
      closeLlmProfilePicker();
    });

    document.getElementById('addLlmProfile').addEventListener('click', () => {
      closeLlmProfilePicker();
      vscode.postMessage({ command: 'addLlmProfile' });
    });

    const openSettingsDialog = () => {
      permissionCreateFilesEl.value = state.permissionPolicy.createFiles;
      permissionUpdateFilesEl.value = state.permissionPolicy.updateFiles;
      settingsTimeoutSecondsEl.value = String(state.settings.timeoutSeconds);
      settingsCommandTimeoutSecondsEl.value = String(state.settings.commandTimeoutSeconds);
      settingsToolCallLimitEl.value = String(state.settings.toolCallLimit);
      settingsMaxTokensEl.value = String(state.settings.maxTokens);
      settingsTemperatureEl.value = String(state.settings.temperature);
      renderTimeoutApproximation();
      renderRememberedCommands();
      renderEmbeddingProfileSettings();
      if (!permissionDialogEl.open) {
        permissionDialogEl.showModal();
      }
      settingsTimeoutSecondsEl.focus();
    };

    settingsButtonEl.addEventListener('click', openSettingsDialog);
    manageEmbeddingProfilesEl.addEventListener('click', () => {
      permissionDialogEl.close();
      vscode.postMessage({ command: 'chooseEmbeddingProfile' });
    });
    document.getElementById('openAgentToolSettings').addEventListener('click', () => {
      const settings = state.settings.agentTools;
      settingsReadFileMaxLinesEl.value = String(settings.readFileMaxLines);
      settingsListFilesMaxResultsEl.value = String(settings.listFilesMaxResults);
      settingsSearchCodeMaxResultsEl.value = String(settings.searchCodeMaxResults);
      settingsDiagnosticsMaxResultsEl.value = String(settings.diagnosticsMaxResults);
      settingsTerminalErrorsMaxResultsEl.value = String(settings.terminalErrorsMaxResults);
      settingsCodeNavigationMaxResultsEl.value = String(settings.codeNavigationMaxResults);
      permissionDialogEl.close();
      agentToolSettingsDialogEl.showModal();
      settingsReadFileMaxLinesEl.focus();
    });
    document.getElementById('cancelAgentToolSettings').addEventListener('click', () => {
      agentToolSettingsDialogEl.close();
      openSettingsDialog();
    });
    agentToolSettingsFormEl.addEventListener('submit', (event) => {
      event.preventDefault();
      vscode.postMessage({
        command: 'saveAgentToolSettings',
        settings: {
          readFileMaxLines: Number(settingsReadFileMaxLinesEl.value),
          listFilesMaxResults: Number(settingsListFilesMaxResultsEl.value),
          searchCodeMaxResults: Number(settingsSearchCodeMaxResultsEl.value),
          diagnosticsMaxResults: Number(settingsDiagnosticsMaxResultsEl.value),
          terminalErrorsMaxResults: Number(settingsTerminalErrorsMaxResultsEl.value),
          codeNavigationMaxResults: Number(settingsCodeNavigationMaxResultsEl.value)
        }
      });
    });
    sessionSelectorEl.addEventListener('click', () => {
      showSessionHome();
    });
    const requestNewSession = () => {
      if (state.askPending) {
        return;
      }
      sessionProjectWarningEl.hidden = true;
      vscode.postMessage({ command: 'newSession' });
    };
    newSessionButtonEl.addEventListener('click', requestNewSession);
    newSessionOnHomeEl.addEventListener('click', requestNewSession);
    backendStatusEl.addEventListener('click', () => {
      vscode.postMessage({ command: 'openBackendLogs' });
    });
    restartBackendEl.addEventListener('click', () => {
      if (restartBackendEl.disabled) {
        return;
      }
      restartBackendEl.disabled = true;
      vscode.postMessage({ command: 'restartBackend' });
    });
    openBackendLogsEl.addEventListener('click', () => {
      vscode.postMessage({ command: 'openBackendLogs' });
    });

    settingsTimeoutSecondsEl.addEventListener('input', renderTimeoutApproximation);

    document.getElementById('cancelPermissionSettings').addEventListener('click', () => {
      permissionDialogEl.close();
    });

    clearRememberedCommandsEl.addEventListener('click', () => {
      vscode.postMessage({ command: 'clearRememberedCommands' });
    });

    permissionFormEl.addEventListener('submit', (event) => {
      event.preventDefault();
      const timeoutSeconds = Number(settingsTimeoutSecondsEl.value);
      const commandTimeoutSeconds = Number(settingsCommandTimeoutSecondsEl.value);
      const toolCallLimit = Number(settingsToolCallLimitEl.value);
      const maxTokens = Number(settingsMaxTokensEl.value);
      const temperature = Number(settingsTemperatureEl.value);
      vscode.postMessage({
        command: 'saveSettings',
        settings: {
          timeoutSeconds,
          commandTimeoutSeconds,
          toolCallLimit,
          maxTokens,
          temperature,
          policy: {
            createFiles: permissionCreateFilesEl.value,
            updateFiles: permissionUpdateFilesEl.value
          }
        }
      });
    });

    llmProfileProviderEl.addEventListener('change', () => {
      renderLlmProfileProvider(true);
    });

    document.getElementById('cancelLlmProfile').addEventListener('click', () => {
      closeLlmProfileForm();
    });

    deleteLlmProfileEl.addEventListener('click', () => {
      const profileId = llmProfileIdEl.value;
      if (!profileId || deleteLlmProfileEl.hidden || deleteLlmProfileEl.disabled) {
        return;
      }
      if (deleteLlmProfileEl.dataset.confirm !== 'true') {
        deleteLlmProfileEl.dataset.confirm = 'true';
        deleteLlmProfileEl.textContent = 'Confirm delete';
        return;
      }
      deleteLlmProfileEl.disabled = true;
      deleteLlmProfileEl.textContent = 'Deleting…';
      vscode.postMessage({ command: 'deleteLlmProfile', profileId });
    });

    llmProfileDialogEl.addEventListener('close', () => {
      llmProfileApiKeyEl.value = '';
      llmProfileDialogEl.dataset.hasApiKey = 'false';
      setLlmProfileFormError('');
      setLlmProfileFormSaving(false);
    });

    llmProfileFormEl.addEventListener('submit', (event) => {
      event.preventDefault();
      setLlmProfileFormError('');

      const name = llmProfileNameEl.value.trim();
      const provider = llmProfileProviderEl.value;
      const model = llmProfileModelEl.value.trim();
      const baseUrl = llmProfileBaseUrlEl.value.trim();
      const apiKey = llmProfileApiKeyEl.value.trim();

      if (!name) {
        setLlmProfileFormError('Enter a display name.');
        llmProfileNameEl.focus();
        return;
      }
      if (!model) {
        setLlmProfileFormError('Enter a model ID.');
        llmProfileModelEl.focus();
        return;
      }
      if (baseUrl) {
        try {
          const parsedUrl = new URL(baseUrl);
          if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
            throw new Error('Invalid provider URL');
          }
        } catch {
          setLlmProfileFormError('Enter a valid HTTP or HTTPS base URL without embedded credentials.');
          llmProfileBaseUrlEl.focus();
          return;
        }
      }
      if (
        provider === 'openai'
        && !apiKey
        && llmProfileDialogEl.dataset.hasApiKey !== 'true'
      ) {
        setLlmProfileFormError('Enter an API key for this OpenAI profile.');
        llmProfileApiKeyEl.focus();
        return;
      }

      setLlmProfileFormSaving(true);
      vscode.postMessage({
        command: 'saveLlmProfile',
        profile: {
          id: llmProfileIdEl.value || undefined,
          name,
          provider,
          model,
          baseUrl: baseUrl || undefined,
          apiKey: provider === 'openai' && apiKey ? apiKey : undefined
        }
      });
    });

    document.getElementById('cancelEmbeddingProfilePicker').addEventListener('click', () => {
      closeEmbeddingProfilePicker();
      openSettingsDialog();
    });

    document.getElementById('addEmbeddingProfile').addEventListener('click', () => {
      closeEmbeddingProfilePicker();
      vscode.postMessage({ command: 'addEmbeddingProfile' });
    });

    embeddingProfileProviderEl.addEventListener('change', () => {
      renderEmbeddingProfileProvider(true);
    });
    embeddingProfileBaseUrlEl.addEventListener('input', () => {
      renderEmbeddingProfileProvider(false);
    });

    document.getElementById('cancelEmbeddingProfile').addEventListener('click', () => {
      closeEmbeddingProfileForm();
      openSettingsDialog();
    });

    deleteEmbeddingProfileEl.addEventListener('click', () => {
      const profileId = embeddingProfileIdEl.value;
      if (!profileId || deleteEmbeddingProfileEl.hidden || deleteEmbeddingProfileEl.disabled) {
        return;
      }
      if (deleteEmbeddingProfileEl.dataset.confirm !== 'true') {
        deleteEmbeddingProfileEl.dataset.confirm = 'true';
        deleteEmbeddingProfileEl.textContent = 'Confirm delete';
        return;
      }
      setEmbeddingProfileFormSaving(true);
      vscode.postMessage({ command: 'deleteEmbeddingProfile', profileId });
    });

    embeddingProfileDialogEl.addEventListener('close', () => {
      embeddingProfileApiKeyEl.value = '';
      embeddingProfileDialogEl.dataset.hasApiKey = 'false';
      setEmbeddingProfileFormError('');
      setEmbeddingProfileFormSaving(false);
    });

    embeddingProfileFormEl.addEventListener('submit', (event) => {
      event.preventDefault();
      setEmbeddingProfileFormError('');
      const provider = embeddingProfileProviderEl.value;
      const model = embeddingProfileModelEl.value.trim();
      const baseUrl = embeddingProfileBaseUrlEl.value.trim();
      const apiKey = embeddingProfileApiKeyEl.value.trim();
      if (!model) {
        setEmbeddingProfileFormError('Enter an embedding model ID.');
        embeddingProfileModelEl.focus();
        return;
      }
      let parsedUrl;
      try {
        parsedUrl = new URL(baseUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)
          || parsedUrl.username
          || parsedUrl.password
          || parsedUrl.search
          || parsedUrl.hash) {
          throw new Error('Invalid embedding URL');
        }
      } catch {
        setEmbeddingProfileFormError(
          'Enter a valid HTTP or HTTPS base URL without credentials, query parameters, or fragments.'
        );
        embeddingProfileBaseUrlEl.focus();
        return;
      }
      const remote = !isLoopbackEmbeddingUrl(parsedUrl);
      if (remote && !embeddingProfileRemoteAllowedEl.checked) {
        setEmbeddingProfileFormError(
          'Confirm that this remote provider may receive bounded project source-code chunks and search queries.'
        );
        embeddingProfileRemoteAllowedEl.focus();
        return;
      }

      setEmbeddingProfileFormSaving(true);
      vscode.postMessage({
        command: 'saveEmbeddingProfile',
        profile: {
          id: embeddingProfileIdEl.value || undefined,
          provider,
          model,
          baseUrl,
          remoteAllowed: remote && embeddingProfileRemoteAllowedEl.checked,
          apiKey: apiKey || undefined
        }
      });
    });

    attachmentToggleEl.addEventListener('click', () => {
      state.attachmentsExpanded = !state.attachmentsExpanded;
      renderAttachments();
    });

    window.addEventListener('message', (event) => {
      const message = event.data;

      if (message.command === 'status') {
        if (message.level === 'info') {
          setStatus('Ready');
          if (state.askPending && message.text !== 'Ready') {
            updateWorkingTurn(message.text);
          }
        } else {
          setStatus(message.text, message.level);
        }
      }

      if (message.command === 'scopeUpdated') {
        state.scope = message.scope;
        renderScope();
      }

      if (message.command === 'assistantResponse') {
        const completion = {
          response: message.response,
          fileChanges: Array.isArray(message.fileChanges) ? message.fileChanges : []
        };
        if (state.streamQueue || state.streamPumpTimer) {
          state.pendingAssistantResponse = completion;
        } else {
          completeAssistantResponse(completion.response, completion.fileChanges);
        }
      }

      if (message.command === 'sessionsUpdated') {
        state.sessions = Array.isArray(message.sessions) ? message.sessions : [];
        state.activeSessionId = message.activeSessionId || '';
        state.activeSessionTitle = message.activeTitle || 'New session';
        state.currentWorkspaceName = message.currentWorkspaceName || 'No project open';
        sessionProjectWarningEl.hidden = true;
        renderSessions();
        if (message.openChat === true) {
          showChat();
        }
        if (Array.isArray(message.messages)) {
          state.requestTokenUsage = undefined;
          renderTokenEstimate();
          renderSessionMessages(message.messages);
          state.askPending = false;
          renderAskAvailability();
        }
      }

      if (message.command === 'sessionProjectWarning') {
        sessionProjectWarningEl.textContent = message.message;
        sessionProjectWarningEl.hidden = false;
        showSessionHome(false);
      }

      if (message.command === 'requestCancelling') {
        markWorkingTurnCancelling();
      }

      if (message.command === 'requestCancelled') {
        stopWorkingTurn('cancelled', 'Request cancelled');
        cancelPendingPermissionCards();
        state.askPending = false;
        renderAskAvailability();
        setStatus('Ready');
      }

      if (message.command === 'requestFailed') {
        stopWorkingTurn('error', message.message, Boolean(message.retryable));
        cancelPendingPermissionCards();
        state.askPending = false;
        renderAskAvailability();
      }

      if (message.command === 'attachmentsUpdated') {
        const hadAttachments = state.attachments.length > 0;
        state.attachments = message.attachments;
        if (state.attachments.length === 0) {
          state.attachmentsExpanded = false;
        } else if (!hadAttachments) {
          state.attachmentsExpanded = true;
        }
        renderAttachments();
      }

      if (message.command === 'llmProfilesUpdated') {
        state.activeProfile = message.activeProfile;
        state.profileCount = message.profileCount;
        renderLlmProfile();
      }

      if (message.command === 'showLlmProfilePicker') {
        showLlmProfilePicker(message.profiles);
      }

      if (message.command === 'showLlmProfileForm') {
        showLlmProfileForm(message.profile, message.hasApiKey);
      }

      if (message.command === 'llmProfileFormError') {
        setLlmProfileFormSaving(false);
        deleteLlmProfileEl.dataset.confirm = 'false';
        deleteLlmProfileEl.textContent = 'Delete';
        setLlmProfileFormError(message.message);
      }

      if (message.command === 'closeLlmProfileForm') {
        closeLlmProfileForm();
      }

      if (message.command === 'embeddingProfilesUpdated') {
        state.activeEmbeddingProfile = message.activeProfile;
        state.embeddingProfileCount = message.profileCount;
        renderEmbeddingProfileSettings();
      }

      if (message.command === 'showEmbeddingProfilePicker') {
        showEmbeddingProfilePicker(message.profiles);
      }

      if (message.command === 'showEmbeddingProfileForm') {
        showEmbeddingProfileForm(message.profile, message.hasApiKey);
      }

      if (message.command === 'embeddingProfileFormError') {
        setEmbeddingProfileFormSaving(false);
        deleteEmbeddingProfileEl.dataset.confirm = 'false';
        deleteEmbeddingProfileEl.textContent = 'Delete';
        setEmbeddingProfileFormError(message.message);
      }

      if (message.command === 'closeEmbeddingProfileForm') {
        closeEmbeddingProfileForm();
        openSettingsDialog();
      }

      if (message.command === 'permissionPolicyUpdated') {
        state.permissionPolicy = message.policy;
      }

      if (message.command === 'settingsUpdated') {
        state.settings = message.settings;
        renderRememberedCommands();
        if (permissionDialogEl.open) {
          settingsTimeoutSecondsEl.value = String(state.settings.timeoutSeconds);
          settingsCommandTimeoutSecondsEl.value = String(state.settings.commandTimeoutSeconds);
          settingsToolCallLimitEl.value = String(state.settings.toolCallLimit);
          settingsMaxTokensEl.value = String(state.settings.maxTokens);
          settingsTemperatureEl.value = String(state.settings.temperature);
          renderTimeoutApproximation();
        }
      }

      if (message.command === 'agentToolSettingsSaved' && agentToolSettingsDialogEl.open) {
        agentToolSettingsDialogEl.close();
        openSettingsDialog();
      }

      if (message.command === 'settingsSaved' && permissionDialogEl.open) {
        permissionDialogEl.close();
      }

      if (message.command === 'backendStatusUpdated') {
        state.backendStatus = message.status;
        state.backendLabel = message.label;
        renderBackendStatus();
      }

      if (message.command === 'permissionRequest') {
        updateWorkingTurn('Waiting for permission');
        appendPermissionRequest(message);
      }

      if (message.command === 'commandPermissionRequest') {
        updateWorkingTurn(message.rememberable === false
          ? 'Waiting for dependency permission'
          : 'Waiting for command permission');
        appendCommandPermissionRequest(message);
      }

      if (message.command === 'agentToolActivity') {
        if (message.activity.status === 'running') {
          finalizeProviderNarration();
          updateWorkingTurn(message.activity.title);
        }
        renderAgentToolActivity(message.activity);
      }

      if (message.command === 'providerStreamReset') {
        resetProviderStream();
      }

      if (message.command === 'providerStreamDelta') {
        appendProviderStreamDelta(message.text);
      }

      if (message.command === 'toolUsageUpdated') {
        state.toolUsage = {
          used: Number(message.used) || 0,
          limit: Number(message.limit) || 16
        };
        renderToolUsage();
      }

      if (message.command === 'tokenUsageUpdated') {
        state.requestTokenUsage = message.usage;
        renderWorkingTokenUsage();
        renderTokenEstimate();
      }

      if (message.command === 'agentCheckpointUpdated') {
        state.checkpointAvailable = message.available === true;
        if (state.checkpointAvailable) {
          state.toolUsage = {
            used: Number(message.used) || 0,
            limit: Number(message.limit) || 16
          };
          if (message.tokenUsage) {
            state.requestTokenUsage = message.tokenUsage;
          }
        }
        renderAskAvailability();
      }
    });

    renderTokenEstimate();
    vscode.postMessage({ command: 'setScope', scope: 'project' });
    vscode.postMessage({ command: 'ready' });

    function setStatus(text, level = 'info') {
      if (text === 'Ready' && level === 'info') {
        statusEl.hidden = true;
        statusEl.textContent = '';
        return;
      }

      statusEl.hidden = false;
      statusEl.textContent = text;
      statusEl.className = 'status ' + level;
    }

    function renderTimeoutApproximation() {
      const seconds = Number(settingsTimeoutSecondsEl.value);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        settingsTimeoutHelpEl.textContent = 'Enter a timeout from 10 to 1800 seconds.';
        return;
      }
      const roundedMinutes = (Math.round((seconds / 60) * 10) / 10)
        .toFixed(1)
        .replace(/.0$/, '');
      settingsTimeoutHelpEl.textContent = 'Approximately ' + roundedMinutes + ' min.';
    }

    function renderTokenEstimate() {
      const characterCount = questionEl.value.trim().length;
      if (characterCount === 0 && state.requestTokenUsage) {
        const usage = state.requestTokenUsage;
        tokenEstimateEl.textContent = (usage.exact ? '' : '≈ ')
          + formatTokenCount(usage.totalTokens) + ' total';
        tokenEstimateEl.dataset.active = 'true';
        tokenEstimateEl.title = (usage.exact ? 'Provider-reported' : 'Estimated')
          + ' full request usage: ' + usage.inputTokens + ' input and '
          + usage.outputTokens + ' output tokens.';
        tokenEstimateEl.setAttribute(
          'aria-label',
          (usage.exact ? '' : 'Approximately ') + usage.totalTokens
            + ' total tokens in the last request'
        );
        return;
      }
      const tokenCount = characterCount === 0 ? 0 : Math.max(1, Math.ceil(characterCount / 4));
      const tokenLabel = formatTokenCount(tokenCount);
      tokenEstimateEl.textContent = '≈ ' + tokenLabel + (tokenCount === 1 ? ' token' : ' tokens');
      tokenEstimateEl.dataset.active = String(tokenCount > 0);
      tokenEstimateEl.title = 'Approximate tokens in the current message before project context is collected.';
      tokenEstimateEl.setAttribute(
        'aria-label',
        'Approximately ' + tokenCount + (tokenCount === 1 ? ' token' : ' tokens')
          + ' in the current message'
      );
    }

    function formatTokenCount(tokenCount) {
      if (tokenCount < 1_000) {
        return String(tokenCount);
      }
      const roundedThousands = (Math.round((tokenCount / 1_000) * 10) / 10).toFixed(1);
      return (roundedThousands.endsWith('.0')
        ? roundedThousands.slice(0, -2)
        : roundedThousands) + 'k';
    }

    function renderRememberedCommands() {
      const commands = Array.isArray(state.settings.rememberedCommands)
        ? state.settings.rememberedCommands
        : [];
      rememberedCommandListEl.replaceChildren();
      workspaceTrustBadgeEl.hidden = state.settings.workspaceTrusted !== false;
      clearRememberedCommandsEl.disabled = commands.length === 0;
      if (commands.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'remembered-command-empty';
        empty.textContent = 'No verification commands are remembered.';
        rememberedCommandListEl.appendChild(empty);
        return;
      }
      commands.forEach((command) => {
        const item = document.createElement('li');
        item.className = 'remembered-command';
        const label = document.createElement('span');
        label.className = 'remembered-command-label';
        label.textContent = command.label;
        label.title = command.label;
        item.appendChild(label);
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.textContent = 'Forget';
        revoke.addEventListener('click', () => {
          vscode.postMessage({
            command: 'revokeRememberedCommand',
            signature: command.signature
          });
        });
        item.appendChild(revoke);
        rememberedCommandListEl.appendChild(item);
      });
    }

    function appendMessage(text, role, scroll = true, fileChanges = []) {
      const item = document.createElement('article');
      item.className = 'message ' + role;

      const author = document.createElement('span');
      author.className = 'message-author';
      author.textContent = role === 'user' ? 'You' : 'DevMate';
      item.appendChild(author);

      const body = document.createElement('div');
      body.className = 'message-body';
      if (role === 'assistant') {
        body.classList.add('markdown');
        renderMarkdown(body, text);
      } else {
        body.textContent = text;
      }
      item.appendChild(body);
      if (role === 'assistant') {
        appendFileChangeSummary(item, fileChanges);
      }
      messagesEl.appendChild(item);
      if (scroll) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }

    function appendFileChangeSummary(messageItem, fileChanges) {
      const allowedKinds = new Set(['created', 'updated', 'deleted', 'renamed', 'moved']);
      const changes = Array.isArray(fileChanges)
        ? fileChanges.filter((change) => change
          && allowedKinds.has(change.kind)
          && typeof change.path === 'string'
          && change.path).slice(0, 20)
        : [];
      if (changes.length === 0) {
        return;
      }

      const deletedCount = changes.filter((change) => change.kind === 'deleted').length;
      const changedCount = changes.length - deletedCount;
      const summary = document.createElement('section');
      summary.className = 'file-change-summary';
      summary.setAttribute('aria-label', 'Files changed by DevMate');

      const header = document.createElement('div');
      header.className = 'file-change-summary-header';
      const title = document.createElement('span');
      title.textContent = changes.length === 1 ? '1 file changed' : changes.length + ' files changed';
      header.appendChild(title);
      const counts = document.createElement('span');
      counts.className = 'file-change-summary-counts';
      const changed = document.createElement('span');
      changed.className = 'changed';
      changed.textContent = '+' + changedCount;
      counts.appendChild(changed);
      if (deletedCount > 0) {
        const deleted = document.createElement('span');
        deleted.className = 'deleted';
        deleted.textContent = '−' + deletedCount;
        counts.appendChild(deleted);
      }
      header.appendChild(counts);
      summary.appendChild(header);

      const list = document.createElement('ul');
      list.className = 'file-change-list';
      const labels = {
        created: 'Created',
        updated: 'Updated',
        deleted: 'Deleted',
        renamed: 'Renamed',
        moved: 'Moved'
      };
      changes.forEach((change) => {
        const row = document.createElement('li');
        row.className = 'file-change-row';
        row.dataset.kind = change.kind;
        const symbol = document.createElement('span');
        symbol.className = 'file-change-symbol';
        symbol.textContent = change.kind === 'deleted' ? '−' : '+';
        row.appendChild(symbol);
        const operation = document.createElement('span');
        operation.className = 'file-change-operation';
        operation.textContent = labels[change.kind];
        row.appendChild(operation);
        const pathText = (change.kind === 'renamed' || change.kind === 'moved')
          && typeof change.previousPath === 'string'
          ? change.previousPath + ' → ' + change.path
          : change.path;
        const hasDiff = typeof change.diffId === 'string' && change.diffId.length > 0;
        const pathElement = document.createElement(hasDiff || change.kind !== 'deleted' ? 'button' : 'span');
        pathElement.className = 'file-change-path';
        pathElement.textContent = pathText;
        pathElement.title = hasDiff ? pathText + ' · Open DevMate diff' : pathText;
        if (hasDiff || change.kind !== 'deleted') {
          pathElement.type = 'button';
          pathElement.addEventListener('click', () => {
            vscode.postMessage(hasDiff
              ? { command: 'openFileChangeDiff', diffId: change.diffId, path: change.path }
              : { command: 'openWorkspaceFile', path: change.path });
          });
        }
        row.appendChild(pathElement);
        list.appendChild(row);
      });
      summary.appendChild(list);
      messageItem.appendChild(summary);
    }

    function renderMarkdown(container, text) {
      const lines = String(text).replace(/\r\n/g, '\n').split('\n');
      const fence = String.fromCharCode(96).repeat(3);
      let index = 0;
      while (index < lines.length) {
        const line = lines[index];
        if (!line.trim()) {
          index += 1;
          continue;
        }
        if (line.trimStart().startsWith(fence)) {
          const opening = line.trimStart().slice(fence.length).trim();
          const codeLines = [];
          index += 1;
          while (index < lines.length && !lines[index].trimStart().startsWith(fence)) {
            codeLines.push(lines[index]);
            index += 1;
          }
          if (index < lines.length) {
            index += 1;
          }
          appendCodeBlock(container, codeLines.join('\n'), opening);
          continue;
        }
        const heading = line.match(/^(#{1,4})\s+(.+)$/);
        if (heading) {
          const element = document.createElement('h' + heading[1].length);
          appendInlineMarkdown(element, heading[2]);
          container.appendChild(element);
          index += 1;
          continue;
        }
        if (index + 1 < lines.length && line.includes('|') && isMarkdownTableSeparator(lines[index + 1])) {
          const table = document.createElement('table');
          const head = document.createElement('thead');
          const headRow = document.createElement('tr');
          markdownTableCells(line).forEach((value) => {
            const cell = document.createElement('th');
            appendInlineMarkdown(cell, value);
            headRow.appendChild(cell);
          });
          head.appendChild(headRow);
          table.appendChild(head);
          const body = document.createElement('tbody');
          index += 2;
          while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
            const row = document.createElement('tr');
            markdownTableCells(lines[index]).forEach((value) => {
              const cell = document.createElement('td');
              appendInlineMarkdown(cell, value);
              row.appendChild(cell);
            });
            body.appendChild(row);
            index += 1;
          }
          table.appendChild(body);
          container.appendChild(table);
          continue;
        }
        if (/^\s*[-*]\s+/.test(line)) {
          const list = document.createElement('ul');
          while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
            const item = document.createElement('li');
            appendInlineMarkdown(item, lines[index].replace(/^\s*[-*]\s+/, ''));
            list.appendChild(item);
            index += 1;
          }
          container.appendChild(list);
          continue;
        }
        if (/^\s*\d+[.)]\s+/.test(line)) {
          const list = document.createElement('ol');
          while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
            const item = document.createElement('li');
            appendInlineMarkdown(item, lines[index].replace(/^\s*\d+[.)]\s+/, ''));
            list.appendChild(item);
            index += 1;
          }
          container.appendChild(list);
          continue;
        }

        const paragraphLines = [line];
        index += 1;
        while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index], fence)) {
          paragraphLines.push(lines[index]);
          index += 1;
        }
        const paragraph = document.createElement('p');
        paragraphLines.forEach((paragraphLine, lineIndex) => {
          if (lineIndex > 0) {
            paragraph.appendChild(document.createElement('br'));
          }
          appendInlineMarkdown(paragraph, paragraphLine);
        });
        container.appendChild(paragraph);
      }
    }

    function isMarkdownBlockStart(line, fence) {
      return line.trimStart().startsWith(fence)
        || /^(#{1,4})\s+/.test(line)
        || /^\s*[-*]\s+/.test(line)
        || /^\s*\d+[.)]\s+/.test(line);
    }

    function markdownTableCells(line) {
      const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
      return trimmed.split('|').map((cell) => cell.trim());
    }

    function isMarkdownTableSeparator(line) {
      const cells = markdownTableCells(line);
      return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
    }

    function appendInlineMarkdown(container, text) {
      const pattern = /(\*\*[^*]+\*\*|\x60[^\x60]+\x60|\[[^\]]+\]\([^)]+\))/g;
      let cursor = 0;
      for (const match of text.matchAll(pattern)) {
        if (match.index > cursor) {
          container.appendChild(document.createTextNode(text.slice(cursor, match.index)));
        }
        const token = match[0];
        if (token.startsWith('**')) {
          const strong = document.createElement('strong');
          strong.textContent = token.slice(2, -2);
          container.appendChild(strong);
        } else if (token.charCodeAt(0) === 96) {
          appendInlineCode(container, token.slice(1, -1));
        } else {
          const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
          appendMarkdownLink(container, link[1], link[2]);
        }
        cursor = match.index + token.length;
      }
      if (cursor < text.length) {
        container.appendChild(document.createTextNode(text.slice(cursor)));
      }
    }

    function appendInlineCode(container, value) {
      const file = workspaceFileTarget(value);
      if (file) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'markdown-file-link';
        button.textContent = value;
        button.title = 'Open ' + file.path;
        button.addEventListener('click', () => {
          vscode.postMessage({ command: 'openWorkspaceFile', path: file.path, line: file.line });
        });
        container.appendChild(button);
        return;
      }
      const code = document.createElement('code');
      code.className = 'markdown-inline-code';
      code.textContent = value;
      container.appendChild(code);
    }

    function appendMarkdownLink(container, label, target) {
      const file = workspaceFileTarget(target);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'markdown-link';
      button.textContent = label;
      if (file) {
        button.title = 'Open ' + file.path;
        button.addEventListener('click', () => {
          vscode.postMessage({ command: 'openWorkspaceFile', path: file.path, line: file.line });
        });
      } else if (/^https?:\/\//i.test(target)) {
        button.title = target;
        button.addEventListener('click', () => {
          vscode.postMessage({ command: 'openExternalLink', url: target });
        });
      } else {
        button.disabled = true;
      }
      container.appendChild(button);
    }

    function workspaceFileTarget(value) {
      const normalized = String(value).trim().replace(/^file:\/\//i, '');
      if (!normalized || /^https?:\/\//i.test(normalized) || normalized.includes(String.fromCharCode(0))) {
        return undefined;
      }
      const lineMatch = normalized.match(/^(.*):(\d+)$/);
      const filePath = lineMatch ? lineMatch[1] : normalized;
      const line = lineMatch ? Number(lineMatch[2]) : undefined;
      if (!/[\\/]/.test(filePath) && !/\.[A-Za-z0-9]{1,10}$/.test(filePath)) {
        return undefined;
      }
      return { path: filePath, line };
    }

    function appendCodeBlock(container, codeText, language) {
      const wrapper = document.createElement('div');
      wrapper.className = 'markdown-code-block';
      const header = document.createElement('div');
      header.className = 'markdown-code-header';
      const label = document.createElement('span');
      label.textContent = language || 'code';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'markdown-copy';
      copy.textContent = 'Copy';
      copy.addEventListener('click', () => {
        vscode.postMessage({ command: 'copyText', text: codeText });
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
      });
      header.append(label, copy);
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      appendHighlightedCode(code, codeText);
      pre.appendChild(code);
      wrapper.append(header, pre);
      container.appendChild(wrapper);
    }

    function appendHighlightedCode(container, codeText) {
      const keywords = new Set([
        'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def',
        'else', 'export', 'false', 'finally', 'for', 'from', 'function', 'if', 'import',
        'in', 'interface', 'let', 'new', 'None', 'null', 'return', 'static', 'switch',
        'this', 'throw', 'true', 'try', 'type', 'var', 'while', 'yield'
      ]);
      const pattern = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|<!--[\s\S]*?-->|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
      let cursor = 0;
      for (const match of codeText.matchAll(pattern)) {
        if (match.index > cursor) {
          container.appendChild(document.createTextNode(codeText.slice(cursor, match.index)));
        }
        const token = match[0];
        const span = document.createElement('span');
        span.className = 'markdown-token ' + (
          token.startsWith('//') || token.startsWith('/*') || token.startsWith('<!--')
            ? 'comment'
            : token.startsWith('"') || token.startsWith("'")
              ? 'string'
              : /^\d/.test(token)
                ? 'number'
                : keywords.has(token)
                  ? 'keyword'
                  : ''
        );
        span.textContent = token;
        container.appendChild(span);
        cursor = match.index + token.length;
      }
      if (cursor < codeText.length) {
        container.appendChild(document.createTextNode(codeText.slice(cursor)));
      }
    }

    function renderSessionMessages(messages) {
      clearWorkingTimer();
      messagesEl.replaceChildren();
      messages.forEach((message) => {
        if ((message.role === 'user' || message.role === 'assistant') && typeof message.text === 'string') {
          appendMessage(message.text, message.role, false, message.fileChanges);
        }
      });
      messagesEl.scrollTop = messagesEl.scrollHeight;
      questionEl.focus();
    }

    function showSessionHome(render = true) {
      chatAppEl.hidden = true;
      sessionHomeEl.hidden = false;
      if (render) {
        renderSessions();
      }
    }

    function showChat() {
      sessionHomeEl.hidden = true;
      chatAppEl.hidden = false;
    }

    function renderSessions() {
      activeSessionTitleEl.textContent = state.activeSessionTitle;
      sessionSelectorEl.title = state.activeSessionTitle + ' · Back to sessions';
      sessionSelectorEl.setAttribute('aria-label', sessionSelectorEl.title);
      currentProjectLabelEl.textContent = 'Current project: ' + state.currentWorkspaceName;
      sessionListEl.replaceChildren();
      sessionEmptyEl.hidden = state.sessions.length > 0;
      state.sessions.forEach((session) => {
        const row = document.createElement('li');
        row.className = 'session-row'
          + (session.id === state.activeSessionId && session.belongsToCurrentWorkspace ? ' active' : '')
          + (session.belongsToCurrentWorkspace ? '' : ' foreign');

        const select = document.createElement('button');
        select.type = 'button';
        select.className = 'session-select';
        const title = document.createElement('span');
        title.className = 'session-title';
        title.textContent = session.title;
        const meta = document.createElement('span');
        meta.className = 'session-meta';
        const project = document.createElement('span');
        project.className = 'session-project-badge';
        project.textContent = session.workspaceName
          + (session.belongsToCurrentWorkspace ? '' : ' · Different project');
        const turns = Number(session.turnCount) || 0;
        const updated = Number.isFinite(session.updatedAt)
          ? new Date(session.updatedAt).toLocaleString()
          : '';
        const details = document.createElement('span');
        details.textContent = ' · ' + turns + (turns === 1 ? ' turn' : ' turns')
          + (updated ? ' · ' + updated : '');
        meta.append(project, details);
        select.append(title, meta);
        select.addEventListener('click', () => {
          sessionProjectWarningEl.hidden = true;
          vscode.postMessage({ command: 'selectSession', sessionId: session.id });
        });

        const actions = document.createElement('span');
        actions.className = 'session-actions';
        const rename = document.createElement('button');
        rename.type = 'button';
        rename.className = 'session-action';
        rename.textContent = '✎';
        rename.title = 'Rename session';
        rename.setAttribute('aria-label', rename.title);
        rename.addEventListener('click', () => {
          vscode.postMessage({ command: 'renameSession', sessionId: session.id });
        });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'session-action';
        remove.textContent = '×';
        remove.title = 'Delete session';
        remove.setAttribute('aria-label', remove.title);
        remove.addEventListener('click', () => {
          vscode.postMessage({ command: 'deleteSession', sessionId: session.id });
        });
        actions.append(rename, remove);
        row.append(select, actions);
        sessionListEl.appendChild(row);
      });
    }

    function startWorkingTurn() {
      finalizeProviderNarration();
      clearProviderStreamAnimation();
      document.getElementById('workingTurn')?.remove();
      clearWorkingTimer();
      state.workingStartedAt = Date.now();

      const card = document.createElement('article');
      card.id = 'workingTurn';
      card.className = 'message assistant working-card';
      card.dataset.state = 'working';
      card.setAttribute('aria-live', 'polite');

      const author = document.createElement('span');
      author.className = 'message-author';
      author.textContent = 'DevMate';
      card.appendChild(author);

      const header = document.createElement('div');
      header.className = 'working-header';
      const indicator = document.createElement('span');
      indicator.className = 'working-indicator';
      indicator.setAttribute('aria-hidden', 'true');
      header.appendChild(indicator);
      const heading = document.createElement('span');
      heading.className = 'working-heading';
      heading.textContent = 'Working on your request';
      header.appendChild(heading);
      const model = document.createElement('span');
      model.className = 'working-model';
      model.textContent = state.activeProfile?.name || 'Selected model';
      model.title = state.activeProfile
        ? state.activeProfile.providerLabel + ' · ' + state.activeProfile.model
        : '';
      header.appendChild(model);
      const toolUsage = document.createElement('span');
      toolUsage.className = 'working-tool-usage';
      header.appendChild(toolUsage);
      card.appendChild(header);

      const phases = document.createElement('ul');
      phases.className = 'working-phases';
      card.appendChild(phases);

      const footer = document.createElement('div');
      footer.className = 'working-footer';
      const elapsed = document.createElement('span');
      elapsed.className = 'working-elapsed';
      footer.appendChild(elapsed);
      const tokenUsage = document.createElement('span');
      tokenUsage.className = 'working-token-usage';
      footer.appendChild(tokenUsage);
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'working-cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        if (cancel.disabled) {
          return;
        }
        cancel.disabled = true;
        cancel.textContent = 'Cancelling…';
        updateWorkingTurn('Cancelling request');
        vscode.postMessage({ command: 'cancelRequest' });
      });
      footer.appendChild(cancel);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'working-retry';
      retry.textContent = 'Retry now';
      retry.hidden = true;
      retry.addEventListener('click', () => {
        if (retry.disabled || !state.lastRequest || state.askPending) {
          return;
        }
        retry.disabled = true;
        state.askPending = true;
        setStatus('Ready');
        startWorkingTurn();
        renderAskAvailability();
        vscode.postMessage({ ...state.lastRequest, isNewTurn: false });
      });
      footer.appendChild(retry);
      card.appendChild(footer);
      messagesEl.appendChild(card);

      updateWorkingElapsed();
      renderToolUsage();
      renderWorkingTokenUsage();
      state.workingTimer = setInterval(updateWorkingElapsed, 1000);
      updateWorkingTurn('Preparing request');
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function clearProviderStreamAnimation() {
      if (state.streamPumpTimer) {
        clearTimeout(state.streamPumpTimer);
        state.streamPumpTimer = undefined;
      }
      state.streamQueue = '';
      state.narrationText = '';
      state.pendingAssistantResponse = undefined;
    }

    function resetProviderStream() {
      finalizeProviderNarration();
      clearProviderStreamAnimation();
    }

    function appendProviderStreamDelta(text) {
      if (typeof text !== 'string' || !text) {
        return;
      }
      ensureProviderNarration();
      state.streamQueue = (state.streamQueue + text).slice(-50_000);
      ensureProviderStreamPump();
    }

    function ensureProviderNarration() {
      let card = document.getElementById('providerNarration');
      if (card) {
        return card;
      }
      card = document.createElement('article');
      state.narrationText = '';
      card.id = 'providerNarration';
      card.className = 'message assistant model-narration';
      card.dataset.streaming = 'true';
      card.setAttribute('aria-live', 'polite');

      const author = document.createElement('span');
      author.className = 'message-author';
      author.textContent = 'DevMate update';
      card.appendChild(author);

      const body = document.createElement('div');
      body.className = 'message-body model-narration-body';
      card.appendChild(body);
      messagesEl.appendChild(card);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return card;
    }

    function finalizeProviderNarration() {
      const card = document.getElementById('providerNarration');
      if (!card) {
        return;
      }
      if (state.streamPumpTimer) {
        clearTimeout(state.streamPumpTimer);
        state.streamPumpTimer = undefined;
      }
      const body = card.querySelector('.model-narration-body');
      if (state.streamQueue) {
        state.narrationText = (state.narrationText + state.streamQueue).slice(0, 20_000);
        state.streamQueue = '';
      }
      body.textContent = compactProviderNarration(state.narrationText);
      card.removeAttribute('id');
      card.dataset.streaming = 'false';
      if (!body.textContent.trim()) {
        card.remove();
      }
    }

    function ensureProviderStreamPump() {
      if (state.streamPumpTimer) {
        return;
      }
      state.streamPumpTimer = setTimeout(pumpProviderStream, 18);
    }

    function pumpProviderStream() {
      state.streamPumpTimer = undefined;
      const narration = document.getElementById('providerNarration');
      const stream = narration?.querySelector('.model-narration-body');
      if (!stream) {
        state.streamQueue = '';
        state.pendingAssistantResponse = undefined;
        return;
      }

      if (state.streamQueue) {
        const chunkSize = state.streamQueue.length > 4_000
          ? 80
          : state.streamQueue.length > 1_000
            ? 30
            : 10;
        const chunk = state.streamQueue.slice(0, chunkSize);
        state.streamQueue = state.streamQueue.slice(chunkSize);
        state.narrationText = (state.narrationText + chunk).slice(0, 20_000);
        stream.textContent = compactProviderNarration(state.narrationText);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        state.streamPumpTimer = setTimeout(pumpProviderStream, 18);
        return;
      }

      if (state.pendingAssistantResponse !== undefined) {
        const completion = state.pendingAssistantResponse;
        state.pendingAssistantResponse = undefined;
        state.streamPumpTimer = setTimeout(() => {
          state.streamPumpTimer = undefined;
          completeAssistantResponse(completion.response, completion.fileChanges);
        }, 120);
      }
    }

    function compactProviderNarration(value) {
      const normalized = String(value || '')
        .replace(/\x60{3}[\s\S]*?\x60{3}/g, ' Code omitted. ')
        .replace(/^\s{0,3}(?:#{1,6}|[-*]|\d+[.)])\s+/gm, '')
        .replace(/[\x60*_>#]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (normalized.length <= MAX_INTERMEDIATE_NARRATION_CHARACTERS) {
        return normalized;
      }
      const sentences = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [normalized];
      let summary = '';
      for (const sentence of sentences.slice(0, 2)) {
        const candidate = (summary + ' ' + sentence.trim()).trim();
        if (candidate.length > MAX_INTERMEDIATE_NARRATION_CHARACTERS) {
          break;
        }
        summary = candidate;
      }
      const source = summary || normalized;
      if (source.length <= MAX_INTERMEDIATE_NARRATION_CHARACTERS) {
        return source;
      }
      const sliced = source.slice(0, MAX_INTERMEDIATE_NARRATION_CHARACTERS - 1);
      const lastSpace = sliced.lastIndexOf(' ');
      return sliced.slice(0, lastSpace > 80 ? lastSpace : sliced.length).trimEnd() + '…';
    }

    function completeAssistantResponse(response, fileChanges = []) {
      finishWorkingTurn(response, fileChanges);
      state.askPending = false;
      renderAskAvailability();
    }

    function renderToolUsage() {
      const usage = document.querySelector('#workingTurn .working-tool-usage');
      if (!usage) {
        return;
      }
      usage.textContent = 'Tools ' + state.toolUsage.used + ' / ' + state.toolUsage.limit;
      usage.title = state.toolUsage.used + ' of ' + state.toolUsage.limit
        + ' project tool calls used in this request';
    }

    function renderWorkingTokenUsage() {
      const target = document.querySelector('#workingTurn .working-token-usage');
      if (!target) {
        return;
      }
      const usage = state.requestTokenUsage;
      if (!usage) {
        target.textContent = '';
        target.hidden = true;
        return;
      }
      const marker = usage.exact ? '' : '≈';
      target.textContent = 'Input ' + marker + formatTokenCount(usage.inputTokens)
        + ' · Output ' + marker + formatTokenCount(usage.outputTokens);
      target.title = (usage.exact ? 'Provider-reported' : 'Estimated')
        + ' token usage for this request';
      target.hidden = false;
    }

    function updateWorkingTurn(text) {
      const card = document.getElementById('workingTurn');
      if (!card || card.dataset.state !== 'working' || !text || text === 'Ready') {
        return;
      }
      const phases = card.querySelector('.working-phases');
      const active = phases.querySelector('.working-phase[data-status="active"]');
      if (active?.querySelector('.working-phase-text').textContent === text) {
        return;
      }
      if (active) {
        active.dataset.status = 'completed';
        active.querySelector('.working-phase-icon').textContent = '✓';
      }

      const phase = document.createElement('li');
      phase.className = 'working-phase';
      phase.dataset.status = 'active';
      const icon = document.createElement('span');
      icon.className = 'working-phase-icon';
      icon.textContent = '●';
      phase.appendChild(icon);
      const label = document.createElement('span');
      label.className = 'working-phase-text';
      label.textContent = text;
      phase.appendChild(label);
      phases.appendChild(phase);

      while (phases.children.length > 4) {
        phases.firstElementChild.remove();
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function markWorkingTurnCancelling() {
      const card = document.getElementById('workingTurn');
      if (!card) {
        return;
      }
      const cancel = card.querySelector('.working-cancel');
      cancel.disabled = true;
      cancel.textContent = 'Cancelling…';
      updateWorkingTurn('Cancelling request');
    }

    function stopWorkingTurn(stateName, detail, retryable = false) {
      finalizeProviderNarration();
      clearProviderStreamAnimation();
      const card = document.getElementById('workingTurn');
      if (!card) {
        return;
      }
      clearWorkingTimer();
      card.dataset.state = stateName;
      card.querySelector('.working-heading').textContent = stateName === 'cancelled'
        ? 'Request cancelled'
        : 'Request stopped';
      const active = card.querySelector('.working-phase[data-status="active"]');
      if (active) {
        active.dataset.status = stateName;
        active.querySelector('.working-phase-icon').textContent = stateName === 'cancelled' ? '■' : '!';
      }
      if (detail && active?.querySelector('.working-phase-text').textContent !== detail) {
        const phase = document.createElement('li');
        phase.className = 'working-phase';
        phase.dataset.status = stateName;
        const icon = document.createElement('span');
        icon.className = 'working-phase-icon';
        icon.textContent = stateName === 'cancelled' ? '■' : '!';
        phase.appendChild(icon);
        const label = document.createElement('span');
        label.className = 'working-phase-text';
        label.textContent = detail;
        phase.appendChild(label);
        card.querySelector('.working-phases').appendChild(phase);
      }
      card.querySelector('.working-cancel').hidden = true;
      card.querySelector('.working-retry').hidden = !retryable;
      updateWorkingElapsed();
      card.removeAttribute('id');
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function finishWorkingTurn(response, fileChanges = []) {
      clearProviderStreamAnimation();
      clearWorkingTimer();
      document.getElementById('workingTurn')?.remove();
      const narration = document.getElementById('providerNarration');
      if (!narration) {
        appendMessage(response, 'assistant', true, fileChanges);
        return;
      }
      narration.removeAttribute('id');
      narration.dataset.streaming = 'false';
      narration.querySelector('.message-author').textContent = 'DevMate';
      const body = narration.querySelector('.model-narration-body');
      body.classList.add('markdown');
      body.textContent = '';
      renderMarkdown(body, response);
      appendFileChangeSummary(narration, fileChanges);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function cancelPendingPermissionCards() {
      document.querySelectorAll('.permission-card').forEach((card) => {
        const resolution = card.querySelector('.permission-resolution');
        if (!resolution.hidden) {
          return;
        }
        card.querySelectorAll('button').forEach((button) => {
          button.disabled = true;
        });
        resolution.hidden = false;
        resolution.textContent = 'Cancelled with request';
      });
    }

    function updateWorkingElapsed() {
      const elapsed = document.querySelector('#workingTurn .working-elapsed');
      if (!elapsed || !state.workingStartedAt) {
        return;
      }
      const totalSeconds = Math.max(0, Math.floor((Date.now() - state.workingStartedAt) / 1000));
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      elapsed.textContent = minutes > 0
        ? 'Elapsed ' + minutes + 'm ' + String(seconds).padStart(2, '0') + 's'
        : 'Elapsed ' + seconds + 's';
    }

    function clearWorkingTimer() {
      if (state.workingTimer !== undefined) {
        clearInterval(state.workingTimer);
        state.workingTimer = undefined;
      }
    }

    function appendPermissionRequest(message) {
      const files = Array.isArray(message.files) ? message.files : [];
      const card = document.createElement('article');
      card.className = 'message assistant permission-card';
      card.dataset.requestId = message.requestId;

      const author = document.createElement('span');
      author.className = 'message-author';
      author.textContent = 'DevMate';
      card.appendChild(author);

      const title = document.createElement('h3');
      title.className = 'permission-title';
      title.textContent = files.length === 1
        ? 'Permission required for 1 file'
        : 'Permission required for ' + files.length + ' files';
      card.appendChild(title);

      if (message.summary) {
        const summary = document.createElement('p');
        summary.className = 'permission-summary';
        summary.textContent = message.summary;
        card.appendChild(summary);
      }

      const list = document.createElement('ul');
      list.className = 'permission-file-list';
      files.forEach((file) => {
        const item = document.createElement('li');
        item.className = 'permission-file';

        const operation = document.createElement('span');
        operation.className = 'permission-operation';
        operation.textContent = ({
          create: 'Create',
          update: 'Update',
          delete: 'Delete',
          rename: 'Rename',
          move: 'Move'
        })[file.operation] || 'Change';
        item.appendChild(operation);

        const filePath = document.createElement('span');
        filePath.className = 'permission-path';
        filePath.textContent = file.path;
        filePath.title = file.path;
        item.appendChild(filePath);
        if (file.canReview) {
          const review = document.createElement('button');
          review.type = 'button';
          review.className = 'review-diff-button';
          review.textContent = 'Review diff';
          review.addEventListener('click', () => {
            vscode.postMessage({
              command: 'reviewPermissionDiff',
              requestId: message.requestId,
              path: file.path
            });
          });
          item.appendChild(review);
        }
        list.appendChild(item);
      });
      card.appendChild(list);

      const actions = document.createElement('div');
      actions.className = 'permission-actions';
      const resolution = document.createElement('div');
      resolution.className = 'permission-resolution';
      resolution.hidden = true;

      const addDecisionButton = (label, decision, primary = false) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'action-button ' + (primary ? 'primary' : 'secondary');
        button.textContent = label;
        button.addEventListener('click', () => {
          actions.querySelectorAll('button').forEach((candidate) => {
            candidate.disabled = true;
          });
          resolution.hidden = false;
          resolution.textContent = decision === 'deny'
            ? 'Denied'
            : decision === 'allowAlways'
              ? 'Allowed and remembered'
              : 'Allowed once';
          vscode.postMessage({
            command: 'permissionDecision',
            requestId: message.requestId,
            decision
          });
        }, { once: true });
        actions.appendChild(button);
      };

      addDecisionButton('Deny', 'deny');
      if (message.rememberable !== false) {
        addDecisionButton('Always allow these', 'allowAlways');
      }
      addDecisionButton('Allow once', 'allowOnce', true);
      card.appendChild(actions);
      card.appendChild(resolution);
      messagesEl.appendChild(card);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendCommandPermissionRequest(message) {
      const card = document.createElement('article');
      card.className = 'message assistant permission-card';
      card.dataset.requestId = message.requestId;

      const author = document.createElement('span');
      author.className = 'message-author';
      author.textContent = 'DevMate';
      card.appendChild(author);

      const title = document.createElement('h3');
      title.className = 'permission-title';
      title.textContent = message.title || 'Permission required to run a command';
      card.appendChild(title);

      const command = document.createElement('code');
      command.className = 'permission-summary';
      command.textContent = message.label;
      card.appendChild(command);

      const cwd = document.createElement('p');
      cwd.className = 'permission-summary';
      cwd.textContent = 'Working directory: ' + message.cwd;
      card.appendChild(cwd);

      const warning = document.createElement('p');
      warning.className = 'permission-summary';
      warning.textContent = message.warning
        || 'Verification commands can execute code from this trusted workspace.';
      card.appendChild(warning);

      const actions = document.createElement('div');
      actions.className = 'permission-actions';
      const resolution = document.createElement('div');
      resolution.className = 'permission-resolution';
      resolution.hidden = true;
      const addDecisionButton = (label, decision, primary = false) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'action-button ' + (primary ? 'primary' : 'secondary');
        button.textContent = label;
        button.addEventListener('click', () => {
          actions.querySelectorAll('button').forEach((candidate) => {
            candidate.disabled = true;
          });
          resolution.hidden = false;
          resolution.textContent = decision === 'deny'
            ? 'Denied'
            : decision === 'allowAlways'
              ? 'Allowed and remembered for this workspace'
              : 'Allowed once';
          vscode.postMessage({
            command: 'commandPermissionDecision',
            requestId: message.requestId,
            decision
          });
        }, { once: true });
        actions.appendChild(button);
      };
      addDecisionButton('Deny', 'deny');
      if (message.rememberable !== false) {
        addDecisionButton('Always allow this command', 'allowAlways');
      }
      addDecisionButton('Allow once', 'allowOnce', true);
      card.appendChild(actions);
      card.appendChild(resolution);
      messagesEl.appendChild(card);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function renderAgentToolActivity(activity) {
      let item = Array.from(messagesEl.querySelectorAll('.tool-activity')).find(
        (candidate) => candidate.dataset.activityId === activity.id
      );
      if (!item) {
        item = document.createElement('article');
        item.className = 'tool-activity';
        item.dataset.activityId = activity.id;
        item.setAttribute('aria-live', 'polite');

        const icon = document.createElement('span');
        icon.className = 'tool-activity-icon';
        item.appendChild(icon);

        const copy = document.createElement('div');
        copy.className = 'tool-activity-copy';
        const title = document.createElement('span');
        title.className = 'tool-activity-title';
        copy.appendChild(title);
        const detail = document.createElement('span');
        detail.className = 'tool-activity-detail';
        copy.appendChild(detail);
        const result = document.createElement('span');
        result.className = 'tool-activity-result';
        copy.appendChild(result);
        const openTerminal = document.createElement('button');
        openTerminal.type = 'button';
        openTerminal.className = 'review-diff-button tool-open-terminal';
        openTerminal.textContent = 'Open terminal';
        openTerminal.hidden = true;
        openTerminal.addEventListener('click', () => {
          vscode.postMessage({
            command: 'openCommandTerminal',
            activityId: item.dataset.activityId
          });
        });
        copy.appendChild(openTerminal);
        item.appendChild(copy);
        messagesEl.appendChild(item);
      }

      item.dataset.status = activity.status;
      item.querySelector('.tool-activity-icon').textContent = activity.status === 'running'
        ? '…'
        : activity.status === 'completed'
          ? '✓'
          : '!';
      item.querySelector('.tool-activity-title').textContent = activity.title;
      item.querySelector('.tool-activity-detail').textContent = activity.detail;
      item.querySelector('.tool-activity-result').textContent = activity.result || '';
      item.querySelector('.tool-open-terminal').hidden = !activity.canOpenTerminal;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function renderScope() {
      scopeDetailEl.textContent = state.scope.detail;

      document.querySelectorAll('.scope-button[data-scope]').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.scope === state.scope.kind));
      });
    }

    function renderLlmProfile() {
      if (!state.activeProfile) {
        llmProfileLabelEl.textContent = 'Add model';
        llmProfileSelectorEl.title = 'Add a model profile';
        intelligenceControlEl.hidden = true;
        closeIntelligenceMenu();
        renderAskAvailability();
        return;
      }

      llmProfileLabelEl.textContent = state.activeProfile.name;
      const reasoningOptions = Array.isArray(state.activeProfile.reasoningEffortOptions)
        ? state.activeProfile.reasoningEffortOptions
        : [];
      const selectedReasoning = reasoningOptions.find(
        (item) => item.value === state.activeProfile.reasoningEffort
      );
      intelligenceMenuOptionsEl.replaceChildren();
      intelligenceControlEl.hidden = reasoningOptions.length <= 1;
      if (reasoningOptions.length <= 1) {
        closeIntelligenceMenu();
      }
      reasoningOptions.forEach((item) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'intelligence-menu-option';
        option.setAttribute('role', 'menuitemradio');
        option.setAttribute('aria-checked', String(item.value === state.activeProfile.reasoningEffort));
        const label = document.createElement('span');
        label.textContent = item.label;
        const check = document.createElement('span');
        check.className = 'intelligence-menu-check';
        check.setAttribute('aria-hidden', 'true');
        check.textContent = item.value === state.activeProfile.reasoningEffort ? '✓' : '';
        option.append(label, check);
        option.addEventListener('click', (event) => {
          event.stopPropagation();
          state.activeProfile.reasoningEffort = item.value;
          closeIntelligenceMenu();
          renderLlmProfile();
          vscode.postMessage({ command: 'setReasoningEffort', effort: item.value });
        });
        intelligenceMenuOptionsEl.appendChild(option);
      });
      const intelligenceLabel = selectedReasoning?.label || 'Auto';
      intelligenceButtonEl.title = 'Intelligence: ' + intelligenceLabel;
      intelligenceButtonEl.setAttribute('aria-label', 'Model intelligence: ' + intelligenceLabel);
      llmProfileSelectorEl.title = state.activeProfile.providerLabel
        + ' · ' + state.activeProfile.model
        + (reasoningOptions.length > 1 ? ' · Intelligence: ' + intelligenceLabel : '')
        + (state.profileCount > 1 ? ' · Select another model' : ' · Manage model');
      renderAskAvailability();
    }

    function closeIntelligenceMenu() {
      intelligenceMenuEl.hidden = true;
      intelligenceButtonEl.setAttribute('aria-expanded', 'false');
    }

    function renderAskAvailability() {
      askEl.disabled = !state.activeProfile || state.askPending;
      document.querySelectorAll('.mode-button, .scope-button[data-scope]').forEach((button) => {
        button.disabled = state.askPending;
      });
      attachFilesEl.disabled = state.askPending;
      llmProfileSelectorEl.disabled = state.askPending;
      intelligenceButtonEl.disabled = state.askPending;
      if (state.askPending) {
        closeIntelligenceMenu();
      }
      continueAgentEl.hidden = !state.checkpointAvailable || state.askPending;
      continueAgentEl.disabled = state.askPending;
      sessionSelectorEl.disabled = state.askPending;
      newSessionButtonEl.disabled = state.askPending;
      newSessionOnHomeEl.disabled = state.askPending;
      renderBackendStatus();
      askEl.title = !state.activeProfile
        ? 'Add a model profile before asking'
        : state.askPending
          ? 'DevMate is working on your request'
          : '';
    }

    function renderBackendStatus() {
      const backend = state.backendStatus;
      const label = state.backendLabel || 'Backend status';
      backendStatusEl.dataset.state = backend.state;
      backendStatusEl.title = label + (backend.detail ? ' · ' + backend.detail : '')
        + ' · Click to open logs';
      backendStatusEl.setAttribute('aria-label', backendStatusEl.title);
      backendSettingsLabelEl.textContent = label;
      backendSettingsDetailEl.textContent = backend.detail || '';
      backendSettingsBadgeEl.textContent = backend.state === 'online'
        ? 'Online'
        : backend.state === 'starting'
          ? 'Starting'
          : backend.state === 'restarting'
            ? 'Restarting'
            : backend.state === 'disabled'
              ? 'Unmanaged'
              : backend.state === 'checking'
                ? 'Checking'
                : 'Offline';
      restartBackendEl.disabled = state.askPending || !backend.canRestart;
    }

    function showLlmProfilePicker(profiles) {
      llmProfilePickerListEl.replaceChildren();
      const availableProfiles = Array.isArray(profiles) ? profiles : [];
      availableProfiles.forEach((profile) => {
        const option = document.createElement('div');
        option.className = 'model-picker-option';
        option.dataset.selected = String(profile.selected === true);

        const select = document.createElement('button');
        select.type = 'button';
        select.className = 'model-picker-select';
        select.setAttribute('role', 'option');
        select.setAttribute('aria-selected', String(profile.selected === true));

        const icon = document.createElement('span');
        icon.className = 'model-picker-icon';
        icon.textContent = profile.builtIn ? '✦' : String(profile.name || '?').slice(0, 1);
        select.appendChild(icon);

        const copy = document.createElement('span');
        copy.className = 'model-picker-copy';
        const name = document.createElement('span');
        name.className = 'model-picker-name';
        name.textContent = profile.name;
        const meta = document.createElement('span');
        meta.className = 'model-picker-meta';
        meta.textContent = [
          profile.builtIn ? 'Built-in' : undefined,
          profile.providerLabel,
          profile.model,
          profile.intelligence ? 'Intelligence: ' + profile.intelligence : undefined
        ].filter(Boolean).join(' · ');
        copy.append(name, meta);
        if (profile.baseUrl) {
          const url = document.createElement('span');
          url.className = 'model-picker-url';
          url.textContent = profile.baseUrl;
          url.title = profile.baseUrl;
          copy.appendChild(url);
        }
        select.appendChild(copy);

        if (profile.selected) {
          const selected = document.createElement('span');
          selected.className = 'model-picker-selected';
          selected.textContent = 'Selected';
          select.appendChild(selected);
        }
        select.addEventListener('click', () => {
          closeLlmProfilePicker();
          vscode.postMessage({ command: 'selectLlmProfile', profileId: profile.id });
        });

        const manage = document.createElement('button');
        manage.type = 'button';
        manage.className = 'model-picker-manage';
        manage.textContent = profile.builtIn ? 'Configure' : 'Edit';
        manage.title = (profile.builtIn ? 'Configure ' : 'Edit ') + profile.name;
        manage.addEventListener('click', () => {
          closeLlmProfilePicker();
          vscode.postMessage({ command: 'editLlmProfile', profileId: profile.id });
        });

        option.append(select, manage);
        llmProfilePickerListEl.appendChild(option);
      });
      if (!llmProfilePickerDialogEl.open) {
        llmProfilePickerDialogEl.showModal();
      }
      llmProfilePickerListEl.querySelector('[aria-selected="true"]')?.focus();
    }

    function closeLlmProfilePicker() {
      if (llmProfilePickerDialogEl.open) {
        llmProfilePickerDialogEl.close();
      }
    }

    function showLlmProfileForm(profile, hasApiKey) {
      closeLlmProfilePicker();
      llmProfileFormEl.reset();
      const isBuiltIn = profile?.builtIn === true;
      llmProfileIdEl.value = profile?.id || '';
      llmProfileNameEl.value = profile?.name || '';
      llmProfileProviderEl.value = profile?.provider || 'openai';
      llmProfileModelEl.value = profile?.model || '';
      llmProfileBaseUrlEl.value = profile?.baseUrl || '';
      llmProfileApiKeyEl.value = '';
      llmProfileNameEl.disabled = isBuiltIn;
      llmProfileProviderEl.disabled = isBuiltIn;
      llmProfileModelEl.disabled = isBuiltIn;
      llmProfileBaseUrlEl.disabled = isBuiltIn;
      llmProfileProviderEl.options[0].textContent = isBuiltIn ? 'NVIDIA' : 'OpenAI';
      llmProfileFormEl.dataset.builtIn = String(isBuiltIn);
      llmProfileDialogEl.dataset.hasApiKey = String(Boolean(hasApiKey));
      llmProfileDialogEl.dataset.currentProvider = llmProfileProviderEl.value;
      llmProfileFormTitleEl.textContent = isBuiltIn
        ? 'Configure built-in Nemotron'
        : profile
          ? 'Edit model profile'
          : 'Add model profile';
      llmProfileFormDescriptionEl.textContent = isBuiltIn
        ? 'Nemotron is included with DevMate. Add your NVIDIA API key to use it.'
        : 'Save a reusable model configuration for DevMate.';
      saveLlmProfileEl.textContent = isBuiltIn
        ? 'Save API key'
        : profile
          ? 'Save changes'
          : 'Add model';
      deleteLlmProfileEl.hidden = !profile || isBuiltIn;
      deleteLlmProfileEl.disabled = false;
      deleteLlmProfileEl.dataset.confirm = 'false';
      deleteLlmProfileEl.textContent = 'Delete';
      setLlmProfileFormError('');
      setLlmProfileFormSaving(false);
      renderLlmProfileProvider(false);
      if (!llmProfileDialogEl.open) {
        llmProfileDialogEl.showModal();
      }
      (isBuiltIn ? llmProfileApiKeyEl : llmProfileNameEl).focus();
    }

    function closeLlmProfileForm() {
      llmProfileApiKeyEl.value = '';
      deleteLlmProfileEl.dataset.confirm = 'false';
      deleteLlmProfileEl.textContent = 'Delete';
      deleteLlmProfileEl.disabled = false;
      if (llmProfileDialogEl.open) {
        llmProfileDialogEl.close();
      }
    }

    function renderLlmProfileProvider(providerChanged) {
      const provider = llmProfileProviderEl.value;
      const previousProvider = llmProfileDialogEl.dataset.currentProvider;
      const isOllama = provider === 'ollama';

      if (providerChanged && isOllama && !llmProfileBaseUrlEl.value.trim()) {
        llmProfileBaseUrlEl.value = ollamaDefaultBaseUrl;
      }
      if (
        providerChanged
        && !isOllama
        && previousProvider === 'ollama'
        && llmProfileBaseUrlEl.value.trim() === ollamaDefaultBaseUrl
      ) {
        llmProfileBaseUrlEl.value = '';
      }

      llmProfileDialogEl.dataset.currentProvider = provider;
      llmProfileApiKeyFieldEl.hidden = isOllama;
      llmProfileModelEl.placeholder = isOllama ? 'llama3.2' : 'gpt-4.1-mini';
      llmProfileBaseUrlEl.placeholder = isOllama
        ? ollamaDefaultBaseUrl
        : 'Optional — uses the OpenAI default';
      llmProfileBaseUrlHelpEl.textContent = isOllama
        ? 'Enter the URL of the Ollama server.'
        : llmProfileFormEl.dataset.builtIn === 'true'
          ? 'DevMate uses NVIDIA’s built-in OpenAI-compatible endpoint.'
          : 'Leave blank to use the OpenAI default.';
      llmProfileApiKeyHelpEl.textContent = llmProfileDialogEl.dataset.hasApiKey === 'true'
        ? 'A key is already stored. Leave this blank to keep it, or enter a replacement.'
        : llmProfileFormEl.dataset.builtIn === 'true'
          ? 'Enter an NVIDIA API key. It is saved in VS Code SecretStorage.'
          : 'The key is transferred to the extension and saved in VS Code SecretStorage.';
    }

    function setLlmProfileFormError(message) {
      llmProfileFormErrorEl.textContent = message;
      llmProfileFormErrorEl.hidden = !message;
    }

    function setLlmProfileFormSaving(saving) {
      saveLlmProfileEl.disabled = saving;
      deleteLlmProfileEl.disabled = saving;
      if (saving) {
        saveLlmProfileEl.textContent = 'Saving...';
      } else {
        saveLlmProfileEl.textContent = llmProfileFormEl.dataset.builtIn === 'true'
          ? 'Save API key'
          : llmProfileIdEl.value
            ? 'Save changes'
            : 'Add model';
      }
    }

    function renderEmbeddingProfileSettings() {
      const profile = state.activeEmbeddingProfile;
      if (!profile) {
        embeddingProfileSettingsLabelEl.textContent = 'No embedding profile';
        embeddingProfileSettingsDetailEl.textContent =
          'Add a local Ollama or OpenAI-compatible embedding model.';
        manageEmbeddingProfilesEl.title = 'Configure code embedding profiles';
        return;
      }
      embeddingProfileSettingsLabelEl.textContent = profile.model;
      embeddingProfileSettingsDetailEl.textContent = [
        profile.providerLabel,
        profile.remoteAllowed ? 'Remote code and query transfer allowed' : 'Local endpoint',
        state.embeddingProfileCount > 1
          ? state.embeddingProfileCount + ' saved profiles'
          : undefined
      ].filter(Boolean).join(' · ');
      manageEmbeddingProfilesEl.title = profile.baseUrl;
    }

    function showEmbeddingProfilePicker(profiles) {
      embeddingProfilePickerListEl.replaceChildren();
      const availableProfiles = Array.isArray(profiles) ? profiles : [];
      if (availableProfiles.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'field-help';
        empty.textContent = 'No embedding profiles are configured yet.';
        embeddingProfilePickerListEl.appendChild(empty);
      }
      availableProfiles.forEach((profile) => {
        const option = document.createElement('div');
        option.className = 'model-picker-option';
        option.dataset.selected = String(profile.selected === true);

        const select = document.createElement('button');
        select.type = 'button';
        select.className = 'model-picker-select';
        select.setAttribute('role', 'option');
        select.setAttribute('aria-selected', String(profile.selected === true));

        const icon = document.createElement('span');
        icon.className = 'model-picker-icon';
        icon.textContent = profile.provider === 'ollama' ? 'O' : 'AI';
        const copy = document.createElement('span');
        copy.className = 'model-picker-copy';
        const name = document.createElement('span');
        name.className = 'model-picker-name';
        name.textContent = profile.model;
        const meta = document.createElement('span');
        meta.className = 'model-picker-meta';
        meta.textContent = [
          profile.providerLabel,
          profile.remoteAllowed ? 'Remote allowed' : 'Local only'
        ].join(' · ');
        const url = document.createElement('span');
        url.className = 'model-picker-url';
        url.textContent = profile.baseUrl;
        url.title = profile.baseUrl;
        copy.append(name, meta, url);
        select.append(icon, copy);
        if (profile.selected) {
          const selected = document.createElement('span');
          selected.className = 'model-picker-selected';
          selected.textContent = 'Selected';
          select.appendChild(selected);
        }
        select.addEventListener('click', () => {
          closeEmbeddingProfilePicker();
          openSettingsDialog();
          vscode.postMessage({ command: 'selectEmbeddingProfile', profileId: profile.id });
        });

        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'model-picker-manage';
        edit.textContent = 'Edit';
        edit.title = 'Edit ' + profile.model;
        edit.addEventListener('click', () => {
          closeEmbeddingProfilePicker();
          vscode.postMessage({ command: 'editEmbeddingProfile', profileId: profile.id });
        });
        option.append(select, edit);
        embeddingProfilePickerListEl.appendChild(option);
      });
      if (!embeddingProfilePickerDialogEl.open) {
        embeddingProfilePickerDialogEl.showModal();
      }
      embeddingProfilePickerListEl.querySelector('[aria-selected="true"]')?.focus();
    }

    function closeEmbeddingProfilePicker() {
      if (embeddingProfilePickerDialogEl.open) {
        embeddingProfilePickerDialogEl.close();
      }
    }

    function showEmbeddingProfileForm(profile, hasApiKey) {
      closeEmbeddingProfilePicker();
      embeddingProfileFormEl.reset();
      embeddingProfileIdEl.value = profile?.id || '';
      embeddingProfileProviderEl.value = profile?.provider || 'ollama';
      embeddingProfileModelEl.value = profile?.model || '';
      embeddingProfileBaseUrlEl.value = profile?.baseUrl || ollamaDefaultBaseUrl;
      embeddingProfileApiKeyEl.value = '';
      embeddingProfileRemoteAllowedEl.checked = profile?.remoteAllowed === true;
      embeddingProfileDialogEl.dataset.hasApiKey = String(Boolean(hasApiKey));
      embeddingProfileDialogEl.dataset.currentProvider = embeddingProfileProviderEl.value;
      embeddingProfileFormTitleEl.textContent = profile
        ? 'Edit embedding profile'
        : 'Add embedding profile';
      deleteEmbeddingProfileEl.hidden = !profile;
      deleteEmbeddingProfileEl.disabled = false;
      deleteEmbeddingProfileEl.dataset.confirm = 'false';
      deleteEmbeddingProfileEl.textContent = 'Delete';
      setEmbeddingProfileFormError('');
      setEmbeddingProfileFormSaving(false);
      renderEmbeddingProfileProvider(false);
      if (!embeddingProfileDialogEl.open) {
        embeddingProfileDialogEl.showModal();
      }
      embeddingProfileModelEl.focus();
    }

    function closeEmbeddingProfileForm() {
      embeddingProfileApiKeyEl.value = '';
      embeddingProfileRemoteAllowedEl.checked = false;
      deleteEmbeddingProfileEl.dataset.confirm = 'false';
      deleteEmbeddingProfileEl.textContent = 'Delete';
      deleteEmbeddingProfileEl.disabled = false;
      if (embeddingProfileDialogEl.open) {
        embeddingProfileDialogEl.close();
      }
    }

    function renderEmbeddingProfileProvider(providerChanged) {
      const provider = embeddingProfileProviderEl.value;
      const previousProvider = embeddingProfileDialogEl.dataset.currentProvider;
      const isOllama = provider === 'ollama';
      const currentBaseUrl = embeddingProfileBaseUrlEl.value.trim();
      if (providerChanged && isOllama
        && (!currentBaseUrl || currentBaseUrl === openAiEmbeddingDefaultBaseUrl)) {
        embeddingProfileBaseUrlEl.value = ollamaDefaultBaseUrl;
      }
      if (providerChanged && !isOllama
        && (!currentBaseUrl || currentBaseUrl === ollamaDefaultBaseUrl)) {
        embeddingProfileBaseUrlEl.value = openAiEmbeddingDefaultBaseUrl;
      }
      embeddingProfileDialogEl.dataset.currentProvider = provider;
      embeddingProfileModelEl.placeholder = isOllama
        ? 'nomic-embed-text'
        : 'text-embedding-3-small';
      const remote = isRemoteEmbeddingUrl(embeddingProfileBaseUrlEl.value.trim());
      embeddingRemoteConsentFieldEl.hidden = !remote;
      if (!remote) {
        embeddingProfileRemoteAllowedEl.checked = false;
      }
      embeddingProfileBaseUrlHelpEl.textContent = remote
        ? 'This remote endpoint requires explicit code and search-query transfer permission below.'
        : 'Loopback endpoints keep project source on this computer.';
      embeddingProfileApiKeyHelpEl.textContent =
        embeddingProfileDialogEl.dataset.hasApiKey === 'true'
          ? 'A key is already stored. Leave this blank to keep it, or enter a replacement.'
          : 'If provided, the key is saved only in VS Code SecretStorage.';
      if (previousProvider !== provider) {
        setEmbeddingProfileFormError('');
      }
    }

    function isRemoteEmbeddingUrl(value) {
      try {
        return !isLoopbackEmbeddingUrl(new URL(value));
      } catch {
        return false;
      }
    }

    function isLoopbackEmbeddingUrl(url) {
      const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      return hostname === 'localhost'
        || hostname === '::1'
        || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    }

    function setEmbeddingProfileFormError(message) {
      embeddingProfileFormErrorEl.textContent = message;
      embeddingProfileFormErrorEl.hidden = !message;
    }

    function setEmbeddingProfileFormSaving(saving) {
      saveEmbeddingProfileEl.disabled = saving;
      deleteEmbeddingProfileEl.disabled = saving;
      saveEmbeddingProfileEl.textContent = saving
        ? 'Saving...'
        : embeddingProfileIdEl.value
          ? 'Save changes'
          : 'Add profile';
    }

    function renderAttachments() {
      const attachmentCount = state.attachments.length;
      const summaryText = attachmentCount === 1
        ? '1 file selected'
        : attachmentCount + ' files selected';

      attachmentToggleEl.hidden = attachmentCount === 0;
      attachmentToggleEl.textContent = summaryText;
      attachmentToggleEl.title = state.attachmentsExpanded
        ? 'Hide selected files'
        : 'Show selected files';
      attachmentToggleEl.setAttribute('aria-expanded', String(state.attachmentsExpanded));
      attachmentPanelEl.hidden = attachmentCount === 0 || !state.attachmentsExpanded;
      attachmentListEl.replaceChildren();

      state.attachments.forEach((attachment) => {
        const item = document.createElement('div');
        item.className = 'attachment-item';

        const label = document.createElement('span');
        label.className = 'attachment-label';
        label.textContent = attachment.label;
        item.appendChild(label);

        const remove = document.createElement('button');
        remove.className = 'attachment-row-remove';
        remove.type = 'button';
        remove.title = 'Remove ' + attachment.label;
        remove.setAttribute('aria-label', 'Remove ' + attachment.label);
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => {
          vscode.postMessage({ command: 'removeAttachment', id: attachment.id });
        });
        item.appendChild(remove);
        attachmentListEl.appendChild(item);
      });
    }
