import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

// Keep the static shell here; browser behavior and theme styles live in media/.
export function getChatWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  // The content security policy permits only this generated page's script, rather than arbitrary inline scripts.
  const nonce = createNonce();
  const stylesheetUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'webview.css')
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'webview.js')
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <title>DevMate</title>
  <link rel="stylesheet" href="${stylesheetUri}">
</head>
<body>
  <section id="sessionHome" class="session-home" aria-labelledby="sessionHomeTitle">
    <header class="session-home-header">
      <div class="session-home-heading">
        <span class="session-home-brand">DEVMATE</span>
        <h1 id="sessionHomeTitle">Sessions</h1>
        <p id="currentProjectLabel">Loading project sessions…</p>
      </div>
      <button id="newSessionOnHome" class="action-button primary" type="button">New chat</button>
    </header>
    <div id="sessionProjectWarning" class="session-home-warning" role="alert" hidden></div>
    <div class="session-home-list">
      <ul id="sessionList" class="session-list" aria-label="Saved DevMate sessions"></ul>
      <div id="sessionEmpty" class="session-empty" hidden>
        No past sessions yet.<br>Start a new chat for this project.
      </div>
    </div>
  </section>

  <main id="chatApp" class="app" hidden>
    <header class="toolbar">
      <div class="mode-tabs" role="group" aria-label="Assistant mode">
        <button class="mode-button" type="button" data-mode="ideas" aria-pressed="false">Ideas</button>
        <button class="mode-button" type="button" data-mode="code" aria-pressed="true">Code</button>
        <button class="mode-button" type="button" data-mode="debug" aria-pressed="false">Debug</button>
      </div>
      <button
        id="sessionSelector"
        class="session-selector"
        type="button"
        title="Open sessions"
        aria-label="Open sessions"
      >
        <span aria-hidden="true">←</span>
        <span id="activeSessionTitle" class="session-selector-title">New session</span>
      </button>
      <button
        id="newSessionButton"
        class="toolbar-new-session"
        type="button"
        title="New session"
        aria-label="New session"
      >＋</button>
      <button
        id="backendStatus"
        class="backend-status"
        type="button"
        data-state="checking"
        title="Checking local backend"
        aria-label="Checking local backend"
      >
        <span class="backend-status-dot" aria-hidden="true"></span>
      </button>
      <button
        id="settingsButton"
        class="toolbar-settings"
        type="button"
        title="Open DevMate settings"
        aria-label="Open DevMate settings"
      >
        <span class="toolbar-settings-icon" aria-hidden="true">⚙</span>
      </button>
    </header>

    <section id="status" class="status" aria-live="polite" hidden></section>

    <section id="messages" class="messages" aria-label="Chat messages">
      <div id="requestUndoPanel" class="request-undo-panel" hidden><span id="requestUndoLabel"></span><button id="undoRequest" class="scope-button" type="button">Undo last request</button></div>
      <details id="managedCommandsPanel" class="managed-commands" hidden><summary id="managedCommandsSummary">Running commands</summary><div id="managedCommandsList"></div></details>
    </section>

    <section class="composer" aria-label="Message composer">
      <div class="ask-panel">
        <div class="scope-bar" aria-label="Context scope">
          <div class="scope-row">
            <div class="scope-tabs" role="group" aria-label="Working scope">
              <button class="scope-button" type="button" data-scope="project" aria-pressed="true">Project</button>
              <button class="scope-button" type="button" data-scope="activeFile" aria-pressed="false">File</button>
              <button class="scope-button" type="button" data-scope="selection" aria-pressed="false">Selection</button>
            </div>
            <div class="scope-tools">
              <button id="attachFiles" class="scope-button scope-action" type="button">Add files</button>
              <button
                id="toggleAttachments"
                class="scope-button scope-action"
                type="button"
                aria-expanded="false"
                hidden
              ></button>
            </div>
          </div>
        </div>
        <div id="attachmentPanel" class="attachment-panel" hidden>
          <span class="attachment-panel-title">Selected files</span>
          <div id="attachmentList" class="attachment-list" aria-label="Attached workspace files"></div>
        </div>
        <textarea id="question" placeholder="Ask DevMate..."></textarea>
        <div class="composer-actions">
          <button
            id="llmProfileSelector"
            class="scope-button model-selector"
            type="button"
            title="Add or select a model profile"
          >
            <span id="llmProfileLabel" class="model-selector-label">Add model</span>
            <span class="model-selector-chevron" aria-hidden="true">▼</span>
          </button>
          <span id="extendedAccessBadge" class="extended-access-badge" title="Extended command access is enabled for this workspace" hidden>Extended</span>
          <div id="intelligenceControl" class="intelligence-control" hidden>
            <button
              id="intelligenceButton"
              class="intelligence-icon-button"
              type="button"
              title="Model intelligence"
              aria-label="Choose model intelligence"
              aria-haspopup="menu"
              aria-expanded="false"
            ><span aria-hidden="true">✦</span></button>
            <div id="intelligenceMenu" class="intelligence-menu" role="menu" hidden>
              <span class="intelligence-menu-title">Intelligence</span>
              <div id="intelligenceMenuOptions" class="intelligence-menu-options"></div>
            </div>
          </div>
          <span class="composer-actions-spacer"></span>
          <div class="composer-submit">
            <button
              id="continueAgent"
              class="scope-button continue-agent-button"
              type="button"
              title="Continue the unfinished DevMate run with its saved tool history"
              hidden
            >Continue</button>
            <span
              id="tokenEstimate"
              class="token-estimate"
              data-active="false"
              title="Before sending, this estimates the current message. During a request, full prompt and response usage appears here."
            >≈ 0 tokens</span>
            <button id="ask" class="action-button primary ask-button" type="button" disabled>Ask</button>
          </div>
        </div>
      </div>
    </section>
  </main>

  <dialog id="llmProfilePickerDialog" class="profile-dialog model-picker-dialog" aria-labelledby="llmProfilePickerTitle">
    <section class="profile-form">
      <header class="profile-form-header">
        <h2 id="llmProfilePickerTitle">Choose model</h2>
        <p>Select a model for this DevMate session or manage a saved profile.</p>
      </header>
      <div class="profile-form-body">
        <div id="llmProfilePickerList" class="model-picker-list" role="listbox" aria-label="Available model profiles"></div>
      </div>
      <footer class="profile-form-actions">
        <button id="cancelLlmProfilePicker" class="action-button secondary" type="button">Close</button>
        <button id="addLlmProfile" class="action-button primary" type="button">Add model</button>
      </footer>
    </section>
  </dialog>

  <dialog id="llmProfileDialog" class="profile-dialog" aria-labelledby="llmProfileFormTitle">
    <form id="llmProfileForm" class="profile-form" novalidate>
      <header class="profile-form-header">
        <h2 id="llmProfileFormTitle">Add model profile</h2>
        <p id="llmProfileFormDescription">Save a reusable model configuration for DevMate.</p>
      </header>
      <div class="profile-form-body">
        <input id="llmProfileId" type="hidden">
        <div class="profile-field">
          <label for="llmProfileName">Display name</label>
          <input
            id="llmProfileName"
            type="text"
            maxlength="60"
            autocomplete="off"
            placeholder="OpenAI Fast or Local Ollama"
            required
          >
        </div>
        <div class="profile-form-row">
          <div class="profile-field">
            <label for="llmProfileProvider">Provider</label>
            <select id="llmProfileProvider">
              <option value="openai">OpenAI</option>
              <option value="ollama">Ollama</option>
            </select>
          </div>
          <div class="profile-field">
            <label for="llmProfileModel">Model ID</label>
            <input
              id="llmProfileModel"
              type="text"
              maxlength="120"
              autocomplete="off"
              placeholder="gpt-4.1-mini"
              required
            >
          </div>
        </div>
        <div class="profile-field">
          <label for="llmProfileBaseUrl">Base URL</label>
          <input
            id="llmProfileBaseUrl"
            type="url"
            autocomplete="off"
            placeholder="Optional — uses the provider default"
          >
          <p id="llmProfileBaseUrlHelp" class="field-help">Leave blank to use the OpenAI default.</p>
        </div>
        <div id="llmProfileApiKeyField" class="profile-field">
          <label for="llmProfileApiKey">API key</label>
          <input
            id="llmProfileApiKey"
            type="password"
            autocomplete="new-password"
            placeholder="Paste the provider API key"
          >
          <p id="llmProfileApiKeyHelp" class="field-help">The key is transferred to the extension and saved in VS Code SecretStorage.</p>
        </div>
        <div class="profile-field">
          <label for="llmProfileApi">Provider API</label>
          <select id="llmProfileApi" aria-describedby="llmProfileApiHelp">
            <option value="auto">Auto</option>
            <option value="chat_completions">Chat Completions</option>
            <option value="responses">Responses</option>
          </select>
          <p id="llmProfileApiHelp" class="field-help">Auto uses Responses at OpenAI's official endpoint and Chat Completions for other providers. A full /responses URL also selects Responses.</p>
          <p class="field-help">Reasoning levels depend on the provider and model. Auto keeps the provider default; unsupported explicit choices return an error.</p>
        </div>
        <details class="configuration-details">
          <summary>Settings for this model</summary>
          <p class="field-help">Leave numeric fields blank to use your defaults. Reasoning is shared with the control beside this model in chat.</p>
          <div class="settings-value-grid">
            <div class="profile-field"><label for="profileMaxTokens">Output tokens</label><input id="profileMaxTokens" type="number" min="128" max="32000" step="1" placeholder="Inherit"></div>
            <div class="profile-field"><label for="profileTemperature">Temperature</label><input id="profileTemperature" type="number" min="0" max="2" step="0.1" placeholder="Inherit"></div>
            <div class="profile-field"><label for="profileTimeoutSeconds">Timeout (seconds)</label><input id="profileTimeoutSeconds" type="number" min="10" max="1800" step="1" placeholder="Inherit"></div>
            <div class="profile-field"><label for="profileContextCharacters">Context characters</label><input id="profileContextCharacters" type="number" min="1000" max="40000" step="1" placeholder="Inherit"></div>
            <div class="profile-field"><label for="profileReasoningEffort">Reasoning</label><select id="profileReasoningEffort"><option value="auto">Auto</option><option value="none">Off</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option><option value="max">Maximum</option></select></div>
          </div>
        </details>
        <section id="profileTestSection" class="settings-section" hidden>
          <button id="testLlmProfile" class="action-button secondary" type="button">Test saved profile</button>
          <p class="field-help">Sends two small synthetic requests to the saved model and may incur usage. No project files are sent. Save your changes before testing.</p>
          <div id="profileTestResult" class="configuration-result" role="status" hidden></div>
        </section>
        <div id="llmProfileFormError" class="profile-form-error" role="alert" hidden></div>
      </div>
      <footer class="profile-form-actions">
        <button id="deleteLlmProfile" class="action-button profile-form-delete" type="button" hidden>Delete</button>
        <button id="cancelLlmProfile" class="action-button secondary" type="button">Cancel</button>
        <button id="saveLlmProfile" class="action-button primary" type="submit">Save profile</button>
      </footer>
    </form>
  </dialog>

  <dialog id="permissionDialog" class="profile-dialog" aria-labelledby="permissionDialogTitle">
    <form id="permissionForm" class="profile-form" novalidate>
      <header class="profile-form-header"><h2 id="permissionDialogTitle">DevMate settings</h2><p>Set your defaults. Changes apply to new requests.</p></header>
      <div class="profile-form-body">
        <div class="profile-field"><label for="settingsScope">Save settings for</label><select id="settingsScope"><option value="global">All projects</option><option value="workspace">This workspace</option></select></div>
        <section class="settings-section" aria-labelledby="modelRequestSettingsTitle">
          <h3 id="modelRequestSettingsTitle" class="settings-section-title">Model defaults</h3>
          <p class="field-help">A saved model can use its own values. Choose reasoning beside the model in chat or in its settings.</p>
          <div class="settings-value-grid">
            <div class="profile-field"><label for="settingsMaxTokens">Output tokens per call</label><input id="settingsMaxTokens" type="number" min="128" max="32000" step="1"><p class="field-help">Shared by reasoning and final output.</p></div>
            <div class="profile-field"><label for="settingsTemperature">Temperature</label><input id="settingsTemperature" type="number" min="0" max="2" step="0.1"></div>
            <div class="profile-field"><label for="settingsTimeoutSeconds">Call timeout (seconds)</label><input id="settingsTimeoutSeconds" type="number" min="10" max="1800" step="1"><p id="settingsTimeoutHelp" class="field-help">Approximately 15 min.</p></div>
            <div class="profile-field"><label for="settingsToolCallLimit">Tool calls per request</label><input id="settingsToolCallLimit" type="number" min="4" max="100" step="1"><p class="field-help">16 recommended; larger runs can take longer and cost more.</p></div>
          </div>
        </section>
        <details id="advancedSettings" class="configuration-details">
          <summary>Advanced</summary>
          <p class="field-help">Usually the defaults are enough. Lower limits can reduce context and cost.</p>
          <div class="settings-value-grid">
            <div class="profile-field"><label for="settingsCommandTimeoutSeconds">Command timeout (seconds)</label><input id="settingsCommandTimeoutSeconds" type="number" min="10" max="1800" step="1"></div>
            <div class="profile-field"><label for="configurationMaxFileEdits">File edits per request</label><input id="configurationMaxFileEdits" type="number" min="0" max="100" step="1"></div>
            <div class="profile-field"><label for="configurationMaxCommands">Commands per request</label><input id="configurationMaxCommands" type="number" min="0" max="100" step="1"></div>
            <div class="profile-field"><label for="configurationMaxRepairAttempts">Failed attempts per tool and file</label><input id="configurationMaxRepairAttempts" type="number" min="1" max="10" step="1"></div>
            <div class="profile-field"><label for="configurationContextCharacters">Starting context (characters)</label><input id="configurationContextCharacters" type="number" min="1000" max="40000" step="1"></div>
            <div class="profile-field"><label for="configurationHistoryCharacters">Tool history (characters)</label><input id="configurationHistoryCharacters" type="number" min="10000" max="80000" step="1"></div>
            <div class="profile-field"><label for="configurationRunTokenBudget">Total run token budget</label><input id="configurationRunTokenBudget" type="number" min="0" max="5000000" step="1"><p class="field-help">0 means unlimited. Checked between calls; the last call can exceed this budget. Usage may be estimated.</p></div>
          </div>
          <button id="openAgentToolSettings" class="action-button secondary" type="button">Agent tools</button>
          <p class="field-help">Choose which tools DevMate can use and how much they return.</p>
          <button id="resetSettings" class="action-button secondary" type="button">Reset defaults for this scope</button>
          <p class="field-help">Loads inherited defaults for the settings shown here. Save to apply; file permissions stay unchanged.</p>
        </details>
        <details id="permissionsSettings" class="configuration-details">
          <summary id="filePermissionSettingsTitle">Permissions</summary>
          <p class="field-help">Permissions apply only to this workspace.</p>
          <h3 class="settings-section-title">Files</h3>
          <div class="permission-setting-list">
            <label class="permission-setting-row" for="permissionCreateFiles">
              <span class="permission-setting-copy">
                <strong>Create new files</strong>
                <span>Only workspace-relative text files that pass DevMate's path checks.</span>
              </span>
              <select id="permissionCreateFiles">
                <option value="ask">Ask every time</option>
                <option value="allow">Allow instantly</option>
              </select>
            </label>
            <label class="permission-setting-row" for="permissionUpdateFiles">
              <span class="permission-setting-copy">
                <strong>Update existing files</strong>
                <span>Replaces complete text-file contents through VS Code's undoable workspace edit.</span>
              </span>
              <select id="permissionUpdateFiles">
                <option value="ask">Ask every time</option>
                <option value="allow">Allow instantly</option>
              </select>
            </label>
            <div class="permission-setting-row">
              <span class="permission-setting-copy">
                <strong>Delete, rename, or move files</strong>
                <span>File lifecycle operations always require one-time approval and diff review.</span>
              </span>
              <span class="permission-blocked-badge">Always ask</span>
            </div>
          </div>
          <p class="field-help">Instant permission never bypasses workspace boundaries, protected-file rules, or file-size limits.</p>
          <section class="settings-section" aria-labelledby="commandAccessTitle">
            <h3 id="commandAccessTitle" class="settings-section-title">Command access</h3>
            <div class="profile-field"><label for="commandAccess">For this workspace</label><select id="commandAccess" aria-describedby="commandAccessHelp" disabled><option value="standard">Standard</option><option value="extended">Extended</option></select></div>
            <p id="commandAccessHelp" class="field-help">Extended asks before each command. Commands are not sandboxed.</p>
            <p class="field-help">Access changes apply immediately after approval, separately from the settings draft. Cancel in Settings does not undo an approved access change.</p>
            <p id="commandAccessStatus" class="field-help" role="status"></p>
            <div class="permission-setting-list">
            <div class="permission-setting-row">
              <span class="permission-setting-copy">
                <strong>Runtime version commands</strong>
                <span>In Standard access, runtime version commands can be remembered for this workspace. Verification scripts ask every time.</span>
              </span>
              <span id="workspaceTrustBadge" class="permission-blocked-badge" hidden>Workspace untrusted</span>
            </div>
            <div class="permission-setting-row">
              <span class="permission-setting-copy">
                <strong>Python dependency installation</strong>
                <span>Validated requirements manifests always require one-time approval and install only into a project virtual environment.</span>
              </span>
              <span class="permission-blocked-badge">Always ask</span>
            </div>
            <ul id="rememberedCommandList" class="remembered-command-list"></ul>
            <button id="clearRememberedCommands" class="action-button secondary" type="button">Clear remembered commands</button>
            </div>
          </section>
        </details>
        <details class="configuration-details">
          <summary id="backendSettingsTitle">Local backend</summary>
          <div class="permission-setting-list">
            <div class="permission-setting-row">
              <span class="permission-setting-copy">
                <strong id="backendSettingsLabel">Checking backend</strong>
                <span id="backendSettingsDetail">Checking the configured backend.</span>
              </span>
              <span id="backendSettingsBadge" class="permission-blocked-badge">Checking</span>
            </div>
            <div class="backend-settings-actions">
              <button id="restartBackend" class="action-button secondary" type="button">Restart backend</button>
              <button id="openBackendLogs" class="action-button secondary" type="button">Open backend logs</button>
            </div>
          </div>
        </details>

        <div id="settingsError" class="profile-form-error" role="alert" hidden></div>
        <div id="settingsNotice" class="field-help" role="status" hidden></div>
      </div>
      <footer class="profile-form-actions"><button id="cancelPermissionSettings" class="action-button secondary" type="button">Cancel</button><button id="saveSettings" class="action-button primary" type="submit">Save settings</button></footer>
    </form>
  </dialog>

  <dialog id="agentToolsDialog" class="profile-dialog" aria-labelledby="agentToolsTitle">
    <section class="profile-form">
      <header class="profile-form-header"><h2 id="agentToolsTitle">Agent tools</h2><p>Tool choices stay in your settings draft. Save settings in the main dialog to apply them.</p></header>
      <div class="profile-form-body">
        <div id="configurationTools" class="agent-tool-groups" aria-label="Available agent tools"></div>
        <details id="toolResultLimits" class="configuration-details">
          <summary>Tool result limits</summary>
        <div class="settings-value-grid agent-tool-limit-grid">
          <div class="profile-field">
            <label for="settingsReadFileMaxLines">Read file — maximum lines</label>
            <input id="settingsReadFileMaxLines" type="number" min="100" max="1000" step="1" required>
            <p class="field-help">Default 400. You can raise this to 600 or 700 for larger files.</p>
          </div>
          <div class="profile-field">
            <label for="settingsListFilesMaxResults">List files — maximum results</label>
            <input id="settingsListFilesMaxResults" type="number" min="20" max="500" step="1" required>
            <p class="field-help">Default 200 files per call.</p>
          </div>
          <div class="profile-field">
            <label for="settingsSearchCodeMaxResults">Search code — maximum matches</label>
            <input id="settingsSearchCodeMaxResults" type="number" min="10" max="200" step="1" required>
            <p class="field-help">Default 50 matches per call.</p>
          </div>
          <div class="profile-field">
            <label for="settingsDiagnosticsMaxResults">Diagnostics — maximum errors</label>
            <input id="settingsDiagnosticsMaxResults" type="number" min="10" max="300" step="1" required>
            <p class="field-help">Default 100 diagnostics per call.</p>
          </div>
          <div class="profile-field">
            <label for="settingsTerminalErrorsMaxResults">Terminal errors — recent entries</label>
            <input id="settingsTerminalErrorsMaxResults" type="number" min="1" max="10" step="1" required>
            <p class="field-help">Default 5 recent terminal error groups.</p>
          </div>
          <div class="profile-field">
            <label for="settingsCodeNavigationMaxResults">Code navigation — maximum locations</label>
            <input id="settingsCodeNavigationMaxResults" type="number" min="10" max="300" step="1" required>
            <p class="field-help">Shared by symbols, definitions, and references. Default 100.</p>
          </div>
        </div>


        </details>
        <div id="agentToolsError" class="profile-form-error" role="alert" hidden></div>
      </div>
      <footer class="profile-form-actions"><button id="closeAgentTools" class="action-button primary" type="button">Done</button></footer>
    </section>
  </dialog>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function createNonce(): string {
  // Each render authorizes only its own packaged script through the CSP nonce.
  return randomBytes(24).toString('base64');
}
