# DevMate

DevMate is a VS Code extension prototype for AI-assisted project help.

## Current Features

- Bottom-right Status Bar launcher that opens DevMate in a right-side editor tab
- Modes: Ideas, Code, Debug
- Scope tabs: Project, File, Selection
- Shows where DevMate will focus
- Local FastAPI backend with `/health` and `/ask`
- Configurable backend URL and clear offline feedback
- Deterministic backend answers for transport testing
- Bounded Selection and active File context with language and truncation metadata
- Bounded Project context with safe file discovery and deterministic relevance ranking
- Workspace-only multi-file attachments with a compact expandable selected-file list
- Compact model selector with reusable OpenAI and Ollama profiles
- API keys stored in VS Code SecretStorage instead of ordinary extension settings

Real LLM calls, RAG, and library docs are not connected yet.

## Model profiles

Use the model button beside **Ask** to add or select a model profile. Adding or editing opens one modal containing the display name, provider, exact model ID, optional custom base URL, and API key. The key is sent once from the modal to the extension host, cleared when the modal closes, and stored through VS Code SecretStorage. It is not kept in webview state or normal settings.

Selecting **Manage model profiles** from the same menu lets you choose, edit, or delete saved profiles. Ollama profiles default to `http://127.0.0.1:11434` and do not require an API key in the current implementation.

## Requirements

DevMate requires Visual Studio Code 1.90+, Node.js 20+, npm 9+, and Python 3.10+. Git is also recommended for development. See [REQUIREMENTS.md](REQUIREMENTS.md) for the complete tool list, version commands, and dependency-file overview.

## Context behavior

- **Selection** sends the currently highlighted text to the local backend.
- **File** sends the active editor's current in-memory content, including unsaved changes.
- Each context item is limited to the first 20,000 characters. DevMate displays when content was truncated.
- The webview receives only scope metadata; source content stays in the extension-host-to-backend request path.
- **Project** considers at most 200 text files up to 200 KB each, ranks them using question keywords, paths, and content, and sends at most five files.
- Project context is limited to 8,000 characters per file and 40,000 characters in total.
- Dependency, build, cache, binary, lock, environment, credential, and private-key files are excluded from automatic discovery.
- **Attach files** lists only eligible files from the folder opened in VS Code; it does not open a system-wide filesystem browser.
- Up to five attached files can be added or removed and combined with Project, File, or Selection scope. Each attachment is capped at 8,000 characters within the shared 40,000-character budget.

## Run the backend

The backend requires Python 3.10 or newer. Create an isolated Python environment and install its dependencies:

```powershell
py -m venv .venv
.venv\Scripts\python -m pip install -r backend\requirements-dev.txt
```

Start the local service:

```powershell
.venv\Scripts\python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --reload
```

The health endpoint is available at `http://127.0.0.1:8000/health`. The extension uses this address by default; change `devMate.backendUrl` in VS Code settings if the backend runs elsewhere.

Run the backend contract tests with:

```powershell
.venv\Scripts\python -m unittest discover -s backend\tests -v
```

## Run the extension

1. Start VS Code.
2. Open this project folder.
3. Install dependencies:

   ```powershell
   npm ci
   ```

4. Compile:

   ```bash
   npm run compile
   ```

5. Check for errors:

   ```bash
   npm run check
   ```

   Run the frontend context tests with `npm test`.

6. Press `F5`.
7. In the new VS Code window, click `DevMate` in the bottom-right Status Bar.

Keep the backend terminal running while testing the extension. If it is stopped, DevMate shows a backend-unavailable message instead of a placeholder answer.

Use the second window that opens after `F5`. That is the Extension Development Host.

The F5 window opens this project by default. To test DevMate on another project, change the last path in `.vscode/launch.json`.

Do not open another folder from inside the F5 window. VS Code may open it as a normal window, and DevMate will not be loaded there.

You can also use the command palette:

```text
DevMate: Open Chat
```

If `npm`, `node`, or `py` is not found, install the missing prerequisite listed in [REQUIREMENTS.md](REQUIREMENTS.md), then restart VS Code and the terminal.
