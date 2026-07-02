# DevMate

DevMate is a VS Code extension prototype for AI-assisted project help.

## Current Features

- Bottom-right Status Bar launcher that opens DevMate as a sidebar Webview View
- Modes: Code (default), Ideas, Debug
- Scope tabs: Project, File, Selection
- Shows where DevMate will focus
- Local FastAPI backend with `/health` and `/ask`
- Managed local-backend startup, health monitoring, logs, restart controls, and configurable external backend URLs
- Streamed OpenAI-compatible responses with non-streaming backend fallback
- Iterative agent tools for project inspection, exact file edits, and approved verification commands
- Animated in-chat working state with real phases, elapsed time, selected model, and cancellation
- Compact segmented mode controls and a top-right in-chat Settings dialog
- Mode-aware prompts for Ideas, Code, and Debug
- Enter-to-send composer with Shift+Enter for new lines, a compact send action, and a live approximate message-token count
- Distinct You and DevMate message bubbles
- Workspace-scoped in-chat approvals, native diff review, and exact-command remembering
- Project-bound sessions with a global past-sessions landing screen
- Bounded Selection and active File context with language and truncation metadata
- Persistent workspace-local Project index with bounded chunk retrieval and deterministic fallback ranking
- Workspace-only multi-file attachments with a compact expandable selected-file list
- Built-in NVIDIA Nemotron model plus reusable custom OpenAI and Ollama profiles
- API keys stored in VS Code SecretStorage instead of ordinary extension settings

Local lexical RAG is connected for Project scope. Semantic embeddings and library-documentation retrieval are not connected yet.

## Local project retrieval

The first Project-scope request creates a private index in VS Code's workspace storage. DevMate splits up to 500 eligible text files into overlapping, line-aware chunks and retrieves the strongest matching excerpt from each relevant file. Later requests reuse unchanged entries and automatically refresh files whose saved size or modification time changed.

Retrieval is deterministic and runs entirely in the extension host using BM25-style lexical scoring; it does not send the project to a separate embedding provider. Explicit attachments remain first-class context and are excluded from automatic retrieval to avoid sending the same file twice. If the stored index is unavailable, incompatible, or has no useful match, DevMate falls back to the earlier path-and-keyword project ranking.

## Agent tools

DevMate can ask the extension host to inspect and improve the open project before answering. Read-only tools support `list_files`, ranged `read_file`, and plain-text `search_code`. In trusted workspaces, Code and Debug additionally receive `create_file`, exact-replacement `edit_file`, `delete_file`, `rename_file`, `move_file`, approved `run_command` verification, and manifest-based `install_dependencies` tools. Tool activity appears as compact cards in the chat. The per-request tool limit defaults to 16 and is configurable from 4 through 100; older results are compacted first when a longer loop approaches the bounded context budget.

`run_command` is reserved for verification and never performs filesystem management. Rejected `mkdir`, move, rename, copy, and deletion commands return guidance naming the appropriate dedicated file tool. `create_file` and `move_file` create missing parent directories automatically, so agents do not need placeholder files or separate directory commands.

Each request immediately creates a working card in the chat. It displays the selected model, elapsed time, live tool usage such as **Tools 12 / 100**, actual lifecycle phases such as context collection and tool use, and a Cancel button. The active card remains pinned near the top of the chat viewport while tool and permission cards accumulate. Chat cards are non-shrinking flex items, so a long tool run scrolls normally instead of compressing and clipping the working card. Its deliberately restrained edge, sheen, indicator, and active-phase animations run on slower cycles and respect reduced-motion preferences. Routine progress no longer occupies the top status strip; that area is reserved for warnings and errors. The working card is removed when the final assistant message arrives, while completed tool activity remains visible.

Before sending, the composer shows an approximate token count for the draft message. Once the backend assembles the real provider request, the working card switches to cumulative input and output usage across every agent round, including system instructions, conversation history, project context, tool definitions, and tool results. Streamed output updates the estimate live, the finished total remains beside the composer, and resumable checkpoints retain accumulated usage. Provider-reported usage is shown without an approximation marker when available; otherwise DevMate uses a clearly marked character-based estimate.

Provider text now appears progressively inside the working card through `/ask/stream`. The webview drains incoming text through a bounded preview queue, so even providers that deliver a completed answer in one large chunk show visible progress before the final message replaces the working card. Internal reasoning text is never exposed; DevMate shows only a generic reasoning phase until answer text or a tool call arrives. Final answers use a DOM-built Markdown renderer with headings, lists, inline code, highlighted fenced code, copy actions, HTTP links, and workspace-bound clickable file references. Raw model HTML is never injected into the webview.

Some OpenAI-compatible models, including Nemotron deployments, can serialize function calls as `<tool_call>` text instead of returning the native `tool_calls` field. DevMate recognizes only complete, response-wide blocks in that format, withholds them from the chat preview, converts them into the same validated tool pipeline, and rejects malformed or mixed-content blocks. Once tool work finishes, the model is instructed to return a concise human-readable summary rather than serialized tool syntax.

Warnings from scope selection, health checks, and other UI actions do not end an active request. Only explicit success, failure, or cancellation events release the pending state and re-enable Send. Mode, scope, attachment, and model selectors remain locked for the duration, preventing context changes or a second request from colliding with work still running in the extension host.

Temporary provider failures (`ResourceExhausted`, HTTP 429, 502, 503, or 504) are retried up to three times after 2, 5, and 10 seconds. The countdown appears as a real phase in the working card and can be cancelled. Authentication, invalid-model, malformed-response, and reasoning-budget errors are never retried. If every transient attempt fails, the stopped card offers **Retry now** without duplicating the user's message.

Read-only tools run instantly because they cannot modify the project. They remain workspace-bound and use the same exclusions as automatic project context, so dependency/build folders, binary files, lock files, environment files, and credential/key files are unavailable. File changes and commands remain in the extension host; the backend receives only bounded tool results and never receives direct filesystem access.

Tool calls are normalized before loop detection, so formatting differences cannot make DevMate reread the same file indefinitely. Harmless model path mistakes—an absolute path inside the open workspace, a repeated workspace-folder prefix, or `./`—are converted back to workspace-relative paths before strict validation; outside paths and traversal remain rejected. One fresh repeated read is allowed at the same workspace revision so an agent can recover from a failed exact replacement, while further identical reads still trigger loop protection. Failed mutations do not consume the six-mutation execution budget.

Compacted create/edit arguments are labeled as internal history summaries, and both current and legacy omission markers are rejected at every file-write boundary. This prevents a provider from copying a compacted marker into a project file. DevMate also pauses after 16 consecutive list/read/search calls without a successful mutation, installation, or verification command, preventing a raised numerical tool limit from enabling an unbounded inspection loop.

If a model repeats another completed tool call or reaches the actual tool limit, DevMate performs a tools-off final turn. A model that returns reasoning without a usable answer instead retries once with thinking disabled while retaining its remaining tools. If the provider still requests tools or returns an unusable final response during the required final turn, DevMate creates an honest local summary from completed changes, verification exit codes, and failed-call counts, saves it as the assistant response, and clears the exhausted checkpoint. Nemotron 3 requests normally reserve half of the response budget for reasoning. The default `devMate.maxTokens` is 16,384 so reasoning models and multi-file Code responses have room to finish.

DevMate opens on a past-sessions screen before showing the composer. The global catalog displays sessions from every project, labels each one with its project, and allows up to 20 sessions to be created, renamed, or deleted. Selecting a session opens its chat only when its saved project identity matches the currently open workspace; a foreign-project selection stays on the list and displays a warning. Existing workspace-local sessions are migrated into the catalog when that workspace is first opened.

Each session retains up to 30 turns within bounded per-session and total storage budgets. A user message is persisted before provider or tool work begins, so it survives failures, cancellation, and closing the view; an eventual retry completes that pending turn without duplicating it. Only completed turns are included in the model's newest-six-turn, 20,000-character history. In-progress agent state is saved as one bounded, workspace- and session-specific checkpoint after every tool result. Failed or cancelled runs expose **Continue** beside the composer and can resume with their compacted tool history after a reload; completing the run or starting a replacement request removes the checkpoint. Permission prompts, working cards, and rendered tool activity remain transient.

Directory deletion and movement, arbitrary dependency commands, arbitrary shells, Git commands, servers, generators, and writable formatters remain blocked.

## DevMate view placement

DevMate is contributed directly to VS Code's Secondary Side Bar in its own dedicated view container. Opening DevMate switches the right sidebar from Codex/Chat to DevMate; opening Codex or Chat hides DevMate in turn. It opens on the right without a placement prompt, and files opened from Explorer stay in the editor area.

## DevMate settings

Use the gear button in the top-right of the DevMate view to configure provider timeout, verification-command timeout, per-request tool-call limit, maximum output tokens, temperature, workspace-local create/update permissions, and remembered exact commands. File deletion, rename, and move always ask once and cannot be remembered. Ideas, Code, and Debug use a compact segmented control on the left side of the top bar.

## Model profiles

Nemotron 3 Ultra is always available as DevMate’s built-in default through NVIDIA’s OpenAI-compatible endpoint. On first use, DevMate asks for an NVIDIA API key and stores it through VS Code SecretStorage; no provider credential is bundled with the extension. A matching Nemotron profile created in an earlier version is migrated to the built-in entry together with its stored key.

Use the model button beside **Ask** to select Nemotron or add another model profile. Adding or editing a custom profile opens one modal containing the display name, provider, exact model ID, optional custom base URL, and API key. The key is sent once from the modal to the extension host, cleared when the modal closes, and stored through VS Code SecretStorage. It is not kept in webview state or normal settings.

Selecting **Manage model profiles** from the same menu lets you configure Nemotron’s key or choose, edit, and delete custom profiles. The built-in Nemotron entry cannot be deleted. Ollama profiles default to `http://127.0.0.1:11434` and do not require an API key in the current implementation.

Profiles without a custom OpenAI base URL use `https://api.openai.com/v1`. OpenAI-compatible services can use a custom base URL; for example, NVIDIA NIM uses `https://integrate.api.nvidia.com/v1`. Ollama server-root URLs are automatically routed to `/v1/chat/completions`.

Provider API keys are sent to the DevMate backend only when its configured URL points to the local computer (`localhost`, `127.x.x.x`, or `::1`). The backend forwards the key for that request without storing it, and provider redirects are disabled.

## Code-mode changes

Code and Debug can now inspect, edit, reorganize, verify, and repair in one bounded agent loop. New files use complete content, while existing files use sequential exact-text replacements. Exact replacements tolerate the LF-normalized text returned to the model when the underlying file uses CRLF, while preserving the file's original line-ending style. Individual eligible text files can also be deleted, renamed within a directory, or moved to a new workspace-relative path; recursive directory operations remain blocked. DevMate shows proposed changes in an in-chat permission card. Every file row includes **Review diff**, which opens VS Code's native diff editor before approval. Create/update requests offer **Deny**, **Allow once**, and **Always allow these**; lifecycle operations deliberately offer only **Deny** and **Allow once**. Approved changes use a VS Code workspace edit and participate in the editor's undo flow.

Targets with pre-existing unsaved changes are rejected instead of being overwritten or silently saved. The extension rechecks file contents after permission is granted and rejects stale proposals. Mutations are disabled entirely in untrusted workspaces. The earlier final-JSON change format remains accepted for compatibility, while new Code requests use agent editing tools and finish with normal text.

After applying a change set, DevMate opens the first created or updated file in the main left editor group instead of beside the DevMate tab.

Only workspace-relative text files in the first open folder can be changed. Absolute paths, parent traversal, symbolic-link paths, duplicate paths, occupied move destinations, dependency/build folders, binary files, lock files, environment files, and credential/key files are rejected—even when instant permission is enabled. Dirty files and lifecycle operations whose source changed during approval are left untouched. A request is limited to six mutation calls, ten files, and the existing per-file and total content limits.

## Verification commands

`run_command` accepts an executable and argument array rather than a raw shell string. Each new exact command asks inside the chat; **Always allow this command** remembers only that executable, arguments, and working directory for the current workspace. Remembered commands can be revoked from Settings. Verification requires Workspace Trust and VS Code terminal shell integration.

If a provider emits a common legacy command shape, DevMate can safely split it into an executable and arguments before validation. The parsed command still passes through the same strict registry and is executed through VS Code's executable/argument API; it is never passed to a shell as raw text.

The first registry covers common test, lint, type-check, and build commands for JavaScript/TypeScript, Python, Rust, Go, .NET, Maven, and Gradle. Output streams into a bounded chat card, while **Open terminal** exposes the complete VS Code terminal. Commands default to a five-minute limit, can be configured from 10 through 1800 seconds, and are limited to three executions per request. Locally rejected requests do not consume that execution limit.

The working directory is always workspace-relative; omitted values and `.`, `./`, or `.\\` all select the workspace root. If `pytest` is unavailable, the agent is instructed to convert compatible tests to the standard-library `unittest` format and run `python -m unittest <test-file> -v` instead of attempting package installation.

For Python verification, DevMate automatically prefers `.venv`, `venv`, or `env` inside the requested working directory and then the workspace root. Symbolic-link environments are ignored. The interpreter is launched through a workspace-relative executable path, so Windows project folders containing spaces do not break PowerShell execution. If verification reports `ModuleNotFoundError`, Code or Debug can inspect or create a requirements manifest, request installation permission, install into the project environment, and then rerun verification.

`install_dependencies` is deliberately narrower than a terminal command. It accepts only a workspace-relative `requirements.txt` or `requirements-*.txt` containing up to 100 simple registry requirements within 64 KB. URLs, local paths, editable installs, nested manifests, index options, environment markers, blocked directories, dirty files, symbolic links, and stale approvals are rejected. Installation always asks once in chat and can never be remembered. If no supported environment exists, DevMate creates `.venv`; package output streams into the tool card and remains cancellable with the configured command timeout. Packages may execute build or installation code, so the approval card states that risk explicitly.

The tool-call limit controls inspection, edit, install, and command requests made during one chat turn. A low value can force the model to summarize before it has inspected, edited, and verified the change. A high value gives difficult repairs more room, but can increase latency, provider usage, context size, permission prompts, and the damage caused by a confused model loop. The recommended default is 16; file-mutation, dependency-installation, and verification-command limits remain independently enforced.

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

The backend requires Python 3.10 or newer. For development, create an isolated Python environment and install its dependencies:

```powershell
py -m venv .venv
.venv\Scripts\python -m pip install -r backend\requirements-dev.txt
```

DevMate now starts and monitors the local service automatically when `devMate.backendUrl` is a plain HTTP loopback address with an explicit port. It prefers `devMate.backendPythonPath`, then `.venv` or `venv` beside the extension, and finally Python on `PATH`. Managed launches deliberately omit `--reload`, so slow provider requests are not disconnected by a development source reload. DevMate never installs backend Python dependencies silently.

The toolbar backend dot shows checking, starting, online, restarting, or offline state. Click it to open the **DevMate Backend** output channel. Settings also provides **Restart backend** and **Open backend logs**. A server already listening at the configured address is adopted as external and is never terminated by DevMate; if it later disappears, managed startup takes over. Crash recovery is limited to three attempts in one minute.

To run the service manually without automatic management:

```powershell
.venv\Scripts\python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

Use `--reload` only while actively editing backend Python and when no long model request is running. The health endpoint is available at `http://127.0.0.1:8000/health`. The extension uses this address by default; change `devMate.backendUrl` if the backend runs elsewhere, disable management with `devMate.manageLocalBackend`, or select another interpreter with `devMate.backendPythonPath`.

If the backend connection drops during a request, DevMate attempts local recovery and stops the interrupted request with **Retry now**. It does not replay automatically because the disconnected request may already have produced a file mutation.

DevMate waits up to fifteen minutes for each model-provider call by default, and the extension automatically adds a 30-second transport buffer. Change **DevMate: Request Timeout Seconds** (`devMate.requestTimeoutSeconds`) in VS Code Settings to any value from 10 through 1800. The value is sent with every request and controls both sides, so changing it does not require a backend restart. `DEVMATE_PROVIDER_TIMEOUT_SECONDS` remains the backend fallback for older clients or requests that omit the setting.

Long-running `/ask/stream` calls use a bounded Node HTTP transport instead of the built-in `fetch` header deadline, so slow providers can use the full configured timeout rather than disconnecting after five minutes. Cancellation still destroys the active request immediately, responses are capped at 4,000,000 bytes, and genuine connection failures remain eligible for managed-backend recovery. After fifteen seconds without a provider event, the working card changes from **Generating answer** to an explicit slow-model waiting phase; project tools can begin only after the provider returns its first tool call. Backends without the streaming endpoint fall back to `/ask`.

Verification commands default to a five-minute maximum. Configure `devMate.commandTimeoutSeconds` from the in-chat Settings dialog or VS Code Settings. A model-requested shorter timeout is honored; it cannot exceed the configured maximum.

Agent requests default to 16 tool calls. Configure `devMate.toolCallLimit` from 4 through 100 in the same dialog. Raising this value does not raise the separate six-mutation, one-installation, or three-command limits; 100 is intended as an escape hatch for unusually large inspection loops, not the recommended everyday setting.

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

When testing an externally started backend, keep its terminal running. Otherwise allow DevMate to manage the process and inspect its output through **DevMate Backend**.

Use the second window that opens after `F5`. That is the Extension Development Host.

The F5 window opens this project by default. To test DevMate on another project, change the last path in `.vscode/launch.json`.

Do not open another folder from inside the F5 window. VS Code may open it as a normal window, and DevMate will not be loaded there.

You can also use the command palette:

```text
DevMate: Open Chat
```

If `npm`, `node`, or `py` is not found, install the missing prerequisite listed in [REQUIREMENTS.md](REQUIREMENTS.md), then restart VS Code and the terminal.
