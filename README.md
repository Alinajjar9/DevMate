# DevMate

DevMate is a VS Code extension prototype for AI-assisted project help.

## Current Features

- Bottom-right Status Bar launcher that opens DevMate as a sidebar Webview View
- Modes: Code (default), Ideas, Debug
- Scope tabs: Project, File, Selection
- Shows where DevMate will focus
- Local FastAPI backend with `/health` and `/ask`
- Configurable backend URL and clear offline feedback
- Real OpenAI-compatible Chat Completions requests
- Iterative agent tools for project inspection, exact file edits, and approved verification commands
- In-chat working state with real phases, elapsed time, selected model, and cancellation
- Compact segmented mode controls and a top-right in-chat Settings dialog
- Mode-aware prompts for Ideas, Code, and Debug
- Enter-to-send composer with Shift+Enter for new lines
- Distinct You and DevMate message bubbles
- Workspace-scoped in-chat approvals, native diff review, and exact-command remembering
- Bounded in-memory follow-up context for the current DevMate session
- Bounded Selection and active File context with language and truncation metadata
- Persistent workspace-local Project index with bounded chunk retrieval and deterministic fallback ranking
- Workspace-only multi-file attachments with a compact expandable selected-file list
- Compact model selector with reusable OpenAI and Ollama profiles
- API keys stored in VS Code SecretStorage instead of ordinary extension settings

Local lexical RAG is connected for Project scope. Semantic embeddings and library-documentation retrieval are not connected yet.

## Local project retrieval

The first Project-scope request creates a private index in VS Code's workspace storage. DevMate splits up to 500 eligible text files into overlapping, line-aware chunks and retrieves the strongest matching excerpt from each relevant file. Later requests reuse unchanged entries and automatically refresh files whose saved size or modification time changed.

Retrieval is deterministic and runs entirely in the extension host using BM25-style lexical scoring; it does not send the project to a separate embedding provider. Explicit attachments remain first-class context and are excluded from automatic retrieval to avoid sending the same file twice. If the stored index is unavailable, incompatible, or has no useful match, DevMate falls back to the earlier path-and-keyword project ranking.

## Agent tools

DevMate can ask the extension host to inspect and improve the open project before answering. Read-only tools support `list_files`, ranged `read_file`, and plain-text `search_code`. In trusted workspaces, Code and Debug additionally receive `create_file`, exact-replacement `edit_file`, and approved `run_command` verification tools. Tool activity appears as compact cards in the conversation, and the model can continue for up to sixteen calls before it must finish its answer.

Each request immediately creates a working card in the conversation. It displays the selected model, elapsed time, actual lifecycle phases such as context collection and tool use, and a Cancel button. Routine progress no longer occupies the top status strip; that area is reserved for warnings and errors. The working card is removed when the final assistant message arrives, while completed tool activity remains visible.

Temporary provider failures (`ResourceExhausted`, HTTP 429, 502, 503, or 504) are retried up to three times after 2, 5, and 10 seconds. The countdown appears as a real phase in the working card and can be cancelled. Authentication, invalid-model, malformed-response, and reasoning-budget errors are never retried. If every transient attempt fails, the stopped card offers **Retry now** without duplicating the user's message.

Read-only tools run instantly because they cannot modify the project. They remain workspace-bound and use the same exclusions as automatic project context, so dependency/build folders, binary files, lock files, environment files, and credential/key files are unavailable. File changes and commands remain in the extension host; the backend receives only bounded tool results and never receives direct filesystem access.

Tool calls are normalized before loop detection, so formatting differences cannot make DevMate reread the same file indefinitely. Harmless model path mistakes—an absolute path inside the open workspace, a repeated workspace-folder prefix, or `./`—are converted back to workspace-relative paths before strict validation; outside paths and traversal remain rejected. One fresh repeated read is allowed at the same workspace revision so an agent can recover from a failed exact replacement, while further identical reads still trigger loop protection. Failed mutations do not consume the six-mutation execution budget.

If a model repeats another completed tool call or returns reasoning without a final answer, DevMate performs one tools-off final turn. A model that still requests tools after the limit now fails immediately instead of being mislabeled as a busy provider and retried three times. Nemotron 3 requests reserve half of the response budget for reasoning and disable thinking during this recovery turn. The default `devMate.maxTokens` is 16,384 so reasoning models and multi-file Code responses have room to finish.

Completed user/assistant turns are retained in bounded memory for the current Extension Host session, so follow-ups such as “okay, do it” keep the immediately preceding task context. The newest six turns are kept within a 20,000-character limit. This history is not yet persisted after VS Code or the Extension Host restarts.

Model-requested deletion, rename, move, dependency installation, arbitrary shells, Git commands, servers, generators, and writable formatters remain blocked.

## DevMate view placement

DevMate is contributed directly to VS Code's Secondary Side Bar in its own dedicated view container. Opening DevMate switches the right sidebar from Codex/Chat to DevMate; opening Codex or Chat hides DevMate in turn. It opens on the right without a placement prompt, and files opened from Explorer stay in the editor area.

## DevMate settings

Use the gear button in the top-right of the DevMate view to configure provider timeout, verification-command timeout, maximum output tokens, temperature, workspace-local create/update permissions, and remembered exact commands. Ideas, Code, and Debug use a compact segmented control on the left side of the top bar.

## Model profiles

Use the model button beside **Ask** to add or select a model profile. Adding or editing opens one modal containing the display name, provider, exact model ID, optional custom base URL, and API key. The key is sent once from the modal to the extension host, cleared when the modal closes, and stored through VS Code SecretStorage. It is not kept in webview state or normal settings.

Selecting **Manage model profiles** from the same menu lets you choose, edit, or delete saved profiles. Ollama profiles default to `http://127.0.0.1:11434` and do not require an API key in the current implementation.

Profiles without a custom OpenAI base URL use `https://api.openai.com/v1`. OpenAI-compatible services can use a custom base URL; for example, NVIDIA NIM uses `https://integrate.api.nvidia.com/v1`. Ollama server-root URLs are automatically routed to `/v1/chat/completions`.

Provider API keys are sent to the DevMate backend only when its configured URL points to the local computer (`localhost`, `127.x.x.x`, or `::1`). The backend forwards the key for that request without storing it, and provider redirects are disabled.

## Code-mode changes

Code and Debug can now inspect, edit, verify, and repair in one bounded agent loop. New files use complete content, while existing files use sequential exact-text replacements. Exact replacements tolerate the LF-normalized text returned to the model when the underlying file uses CRLF, while preserving the file's original line-ending style. DevMate shows proposed changes in an in-chat permission card with **Deny**, **Allow once**, and **Always allow these** actions. Every file row includes **Review diff**, which opens VS Code's native diff editor before approval. Approved changes use a VS Code workspace edit, are saved to disk for verification, and participate in the editor's undo flow.

Targets with pre-existing unsaved changes are rejected instead of being overwritten or silently saved. The extension rechecks file contents after permission is granted and rejects stale proposals. Mutations are disabled entirely in untrusted workspaces. The earlier final-JSON change format remains accepted for compatibility, while new Code requests use agent editing tools and finish with normal text.

After applying a change set, DevMate opens the first created or updated file in the main left editor group instead of beside the DevMate tab.

Only workspace-relative text files in the first open folder can be changed. Absolute paths, parent traversal, symbolic-link paths, duplicate paths, dependency/build folders, binary files, lock files, environment files, and credential/key files are rejected—even when instant permission is enabled. DevMate still does not delete files. A request is limited to six mutation calls, ten files, and the existing per-file and total content limits.

## Verification commands

`run_command` accepts an executable and argument array rather than a raw shell string. Each new exact command asks inside the conversation; **Always allow this command** remembers only that executable, arguments, and working directory for the current workspace. Remembered commands can be revoked from Settings. Verification requires Workspace Trust and VS Code terminal shell integration.

If a provider emits a common legacy command shape, DevMate can safely split it into an executable and arguments before validation. The parsed command still passes through the same strict registry and is executed through VS Code's executable/argument API; it is never passed to a shell as raw text.

The first registry covers common test, lint, type-check, and build commands for JavaScript/TypeScript, Python, Rust, Go, .NET, Maven, and Gradle. Output streams into a bounded chat card, while **Open terminal** exposes the complete VS Code terminal. Commands default to a five-minute limit, can be configured from 10 through 1800 seconds, and are limited to three executions per request. Locally rejected requests do not consume that execution limit.

The working directory is always workspace-relative; omitted values and `.`, `./`, or `.\\` all select the workspace root. If `pytest` is unavailable, the agent is instructed to convert compatible tests to the standard-library `unittest` format and run `python -m unittest <test-file> -v` instead of attempting package installation.

## Requirements

DevMate requires Visual Studio Code 1.96.2+, Node.js 20+, npm 9+, and Python 3.10+. Git is also recommended for development. See [REQUIREMENTS.md](REQUIREMENTS.md) for the complete tool list, version commands, and dependency-file overview.

## Context behavior

- **Selection** sends the currently highlighted text to the local backend.
- **File** sends the active editor's current in-memory content, including unsaved changes.
- Each context item is limited to the first 20,000 characters. DevMate displays when content was truncated.
- The webview receives only scope metadata; source content stays in the extension-host-to-backend request path.
- **Project** incrementally indexes up to 500 eligible text files. It stores at most the first 40,000 characters per file as overlapping 3,200-character chunks and sends at most five relevant excerpts.
- Project context is limited to 8,000 characters per file and 40,000 characters in total.
- The index is stored in VS Code's private workspace storage rather than inside the repository. Saved file changes are detected on the next Project request.
- If indexed retrieval has no useful match, Project scope falls back to the original 200-file deterministic path-and-keyword ranking.
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

DevMate waits up to fifteen minutes for each model-provider call by default, and the extension automatically adds a 30-second transport buffer. Change **DevMate: Request Timeout Seconds** (`devMate.requestTimeoutSeconds`) in VS Code Settings to any value from 10 through 1800. The value is sent with every request and controls both sides, so changing it does not require a backend restart. `DEVMATE_PROVIDER_TIMEOUT_SECONDS` remains the backend fallback for older clients or requests that omit the setting.

Verification commands default to a five-minute maximum. Configure `devMate.commandTimeoutSeconds` from the in-chat Settings dialog or VS Code Settings. A model-requested shorter timeout is honored; it cannot exceed the configured maximum.

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
