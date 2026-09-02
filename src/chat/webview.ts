// Build the chat HTML shell and its restricted resource URLs.
// The browser behavior and styles are packaged separately in media/.

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

export function getChatWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
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

    <section id="messages" class="messages" aria-label="Chat messages"></section>

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
          <div id="scopeDetail" class="scope-meta"></div>
        </div>
        <div id="attachmentPanel" class="attachment-panel" hidden>
          <span class="attachment-panel-title">Selected files</span>
          <div id="attachmentList" class="attachment-list" aria-label="Attached workspace files"></div>
        </div>
        <textarea id="question" aria-label="Message to DevMate" placeholder="Ask DevMate..."></textarea>
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
        <div class="profile-field">
          <label for="llmProfileContextWindowTokens">Context window tokens <span class="field-optional">optional</span></label>
          <input
            id="llmProfileContextWindowTokens"
            type="number"
            min="1024"
            max="4000000"
            step="1"
            placeholder="Auto"
          >
          <p class="field-help">Leave blank to use DevMate's conservative 32,000-token fallback.</p>
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
        <div id="llmProfileFormError" class="profile-form-error" role="alert" hidden></div>
      </div>
      <footer class="profile-form-actions">
        <button id="deleteLlmProfile" class="action-button profile-form-delete" type="button" hidden>Delete</button>
        <button id="cancelLlmProfile" class="action-button secondary" type="button">Cancel</button>
        <button id="saveLlmProfile" class="action-button primary" type="submit">Save profile</button>
      </footer>
    </form>
  </dialog>

  <dialog id="embeddingProfilePickerDialog" class="profile-dialog model-picker-dialog" aria-labelledby="embeddingProfilePickerTitle">
    <section class="profile-form">
      <header class="profile-form-header">
        <h2 id="embeddingProfilePickerTitle">Code embedding profiles</h2>
        <p>Select the model used to build DevMate's semantic code index.</p>
      </header>
      <div class="profile-form-body">
        <div id="embeddingProfilePickerList" class="model-picker-list" role="listbox" aria-label="Available embedding profiles"></div>
      </div>
      <footer class="profile-form-actions">
        <button id="cancelEmbeddingProfilePicker" class="action-button secondary" type="button">Close</button>
        <button id="addEmbeddingProfile" class="action-button primary" type="button">Add profile</button>
      </footer>
    </section>
  </dialog>

  <dialog id="embeddingProfileDialog" class="profile-dialog" aria-labelledby="embeddingProfileFormTitle">
    <form id="embeddingProfileForm" class="profile-form" novalidate>
      <header class="profile-form-header">
        <h2 id="embeddingProfileFormTitle">Add embedding profile</h2>
        <p>Embedding providers receive bounded source-code chunks while building the semantic index.</p>
      </header>
      <div class="profile-form-body">
        <input id="embeddingProfileId" type="hidden">
        <div class="profile-form-row">
          <div class="profile-field">
            <label for="embeddingProfileProvider">Provider</label>
            <select id="embeddingProfileProvider">
              <option value="ollama">Ollama</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
          </div>
          <div class="profile-field">
            <label for="embeddingProfileModel">Embedding model ID</label>
            <input
              id="embeddingProfileModel"
              type="text"
              maxlength="120"
              autocomplete="off"
              placeholder="nomic-embed-text"
              required
            >
          </div>
        </div>
        <div class="profile-field">
          <label for="embeddingProfileBaseUrl">Base URL</label>
          <input
            id="embeddingProfileBaseUrl"
            type="url"
            maxlength="2048"
            autocomplete="off"
            placeholder="http://127.0.0.1:11434"
            required
          >
          <p id="embeddingProfileBaseUrlHelp" class="field-help">Local Ollama keeps project source on this computer.</p>
        </div>
        <div class="profile-field">
          <label for="embeddingProfileApiKey">API key <span class="field-optional">optional</span></label>
          <input
            id="embeddingProfileApiKey"
            type="password"
            maxlength="8192"
            autocomplete="new-password"
            placeholder="Leave blank if the endpoint needs no key"
          >
          <p id="embeddingProfileApiKeyHelp" class="field-help">If provided, the key is saved only in VS Code SecretStorage.</p>
        </div>
        <label id="embeddingRemoteConsentField" class="embedding-remote-consent" for="embeddingProfileRemoteAllowed" hidden>
          <input id="embeddingProfileRemoteAllowed" type="checkbox">
          <span>
            <strong>Allow this remote provider to receive project source code and search queries</strong>
            <small>DevMate sends bounded code chunks to create embeddings. This permission is required for non-loopback endpoints.</small>
          </span>
        </label>
        <div id="embeddingProfileFormError" class="profile-form-error" role="alert" hidden></div>
      </div>
      <footer class="profile-form-actions">
        <button id="deleteEmbeddingProfile" class="action-button profile-form-delete" type="button" hidden>Delete</button>
        <button id="cancelEmbeddingProfile" class="action-button secondary" type="button">Cancel</button>
        <button id="saveEmbeddingProfile" class="action-button primary" type="submit">Add profile</button>
      </footer>
    </form>
  </dialog>

  <dialog id="permissionDialog" class="profile-dialog" aria-labelledby="permissionDialogTitle">
    <form id="permissionForm" class="profile-form">
      <header class="profile-form-header">
        <h2 id="permissionDialogTitle">DevMate settings</h2>
        <p>Control model requests and what DevMate may change without pausing.</p>
      </header>
      <div class="profile-form-body">
        <section class="settings-section" aria-labelledby="modelRequestSettingsTitle">
          <h3 id="modelRequestSettingsTitle" class="settings-section-title">Model requests</h3>
          <div class="settings-value-grid">
            <div class="profile-field">
              <label for="settingsTimeoutSeconds">Timeout (seconds)</label>
              <input id="settingsTimeoutSeconds" type="number" min="10" max="1800" step="1" required>
              <p id="settingsTimeoutHelp" class="field-help">Approximately 15 min.</p>
            </div>
            <div class="profile-field">
              <label for="settingsCommandTimeoutSeconds">Command timeout (seconds)</label>
              <input id="settingsCommandTimeoutSeconds" type="number" min="10" max="1800" step="1" required>
              <p class="field-help">Maximum runtime for each verification command.</p>
            </div>
            <div class="profile-field">
              <label for="settingsMaxTokens">Maximum output tokens</label>
              <input id="settingsMaxTokens" type="number" min="128" max="32000" step="1" required>
              <p class="field-help">Shared by reasoning and final output.</p>
            </div>
            <div class="profile-field">
              <label for="settingsMaxInputContextTokens">Maximum input context</label>
              <input id="settingsMaxInputContextTokens" type="number" min="128" max="4000000" step="1" placeholder="Auto">
              <p class="field-help">Leave blank for Auto, based on the selected model profile and output reserve.</p>
            </div>
            <div class="profile-field">
              <label for="settingsToolCallLimit">Tool calls per request</label>
              <input id="settingsToolCallLimit" type="number" min="4" max="100" step="1" required>
              <p class="field-help">16 recommended; 100 maximum. High limits add time, cost, context pressure, and loop risk.</p>
            </div>
            <div class="profile-field">
              <label for="settingsTemperature">Temperature</label>
              <input id="settingsTemperature" type="number" min="0" max="2" step="0.1" required>
              <p class="field-help">Lower values are more deterministic.</p>
            </div>
          </div>
          <button id="openAgentToolSettings" class="settings-subdialog-button" type="button">
            <span class="settings-subdialog-copy">
              <strong>Agent tools</strong>
              <span>Configure read ranges and result limits for project tools.</span>
            </span>
            <span class="settings-subdialog-chevron" aria-hidden="true">›</span>
          </button>
        </section>
        <section class="settings-section" aria-labelledby="embeddingSettingsTitle">
          <h3 id="embeddingSettingsTitle" class="settings-section-title">Semantic code index</h3>
          <button id="manageEmbeddingProfiles" class="settings-subdialog-button" type="button">
            <span class="settings-subdialog-copy">
              <strong id="embeddingProfileSettingsLabel">No embedding profile</strong>
              <span id="embeddingProfileSettingsDetail">Add a local Ollama or OpenAI-compatible embedding model.</span>
            </span>
            <span class="settings-subdialog-chevron" aria-hidden="true">›</span>
          </button>
          <p class="field-help">Profiles control vector generation only. Chat models and lexical fallback remain separate.</p>
        </section>
        <section class="settings-section" aria-labelledby="backendSettingsTitle">
          <h3 id="backendSettingsTitle" class="settings-section-title">Local backend</h3>
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
        </section>
        <section class="settings-section" aria-labelledby="filePermissionSettingsTitle">
          <h3 id="filePermissionSettingsTitle" class="settings-section-title">File permissions</h3>
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
            <div class="permission-setting-row">
              <span class="permission-setting-copy">
                <strong>Verification commands</strong>
                <span>New exact commands ask first and are remembered only for this workspace.</span>
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
          <p class="field-help">Instant permission never bypasses workspace boundaries, protected-file rules, or file-size limits.</p>
        </section>
      </div>
      <footer class="profile-form-actions">
        <button id="cancelPermissionSettings" class="action-button secondary" type="button">Cancel</button>
        <button class="action-button primary" type="submit">Save settings</button>
      </footer>
    </form>
  </dialog>

  <dialog id="agentToolSettingsDialog" class="profile-dialog" aria-labelledby="agentToolSettingsTitle">
    <form id="agentToolSettingsForm" class="profile-form">
      <header class="profile-form-header">
        <h2 id="agentToolSettingsTitle">Agent tools</h2>
        <p>Set how much information each tool may return in one call. Higher values use more model context.</p>
      </header>
      <div class="profile-form-body">
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
      </div>
      <footer class="profile-form-actions">
        <button id="cancelAgentToolSettings" class="action-button secondary" type="button">Back</button>
        <button class="action-button primary" type="submit">Save tool settings</button>
      </footer>
    </form>
  </dialog>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function createNonce(): string {
  return randomBytes(24).toString('base64');
}

