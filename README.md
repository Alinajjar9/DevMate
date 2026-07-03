# DevMate

DevMate is a VS Code extension that can inspect a project, answer questions about its code, make approved file changes, and run a restricted set of verification commands. It is designed around a simple rule: the language model can request actions, but the extension keeps control of the local machine.

The project contains two applications:

- A TypeScript VS Code extension for the chat interface, project context, tools, permissions, and sessions.
- A local Python/FastAPI backend for prompt construction, provider requests, and response streaming.

## Features

- Dedicated chat view in VS Code's Secondary Side Bar.
- Ideas, Code, and Debug modes.
- Project, active-file, selection, and attached-file context.
- Persistent sessions that are tied to their original workspace.
- Built-in NVIDIA Nemotron profile plus custom OpenAI-compatible and Ollama profiles.
- Streaming responses, cancellation, configurable timeouts, and retry handling.
- Local lexical project retrieval with a private workspace index.
- File listing, ranged reading, and plain-text code search.
- VS Code diagnostics, document symbols, definitions, and references.
- Access to recent failed terminal commands captured through VS Code Shell Integration.
- File creation, exact-text editing, deletion, rename, and move operations.
- In-chat permission cards and native VS Code diff review.
- Approved test, lint, type-check, and build commands.
- Python dependency installation from validated requirements files.
- Bounded recovery for repeated tools, empty provider responses, and unfinished model answers.

## Requirements

| Software | Minimum version |
| --- | --- |
| Visual Studio Code | 1.96.2 |
| Node.js | 20 |
| npm | 9 |
| Python | 3.10 |
| Git | Recommended |

The project is developed and tested primarily on Windows with PowerShell.

Check the installed versions with:

```powershell
code --version
node --version
npm --version
py --version
git --version
```

## Development setup

Clone or extract the repository, open a terminal in its root directory, and install the Node dependencies:

```powershell
npm ci
```

Create a Python virtual environment and install the backend dependencies:

```powershell
py -m venv .venv
.venv\Scripts\python -m pip install -r backend\requirements-dev.txt
```

On macOS or Linux, activate the environment with `.venv/bin/python` instead of `.venv\Scripts\python`.

Compile the extension:

```powershell
npm run compile
```

## Running DevMate from source

1. Open the repository folder in VS Code.
2. Press `F5` or select **Run DevMate Extension** from the Run and Debug view.
3. Wait for the Extension Development Host window to open.
4. Click **DevMate** in the bottom-right status bar.

The development extension is installed only in the Extension Development Host window. If a different demo project is needed, change the workspace path in `.vscode/launch.json` before pressing `F5`.

The backend starts automatically when `devMate.manageLocalBackend` is enabled and `devMate.backendUrl` points to a local HTTP address. DevMate prefers a bundled backend executable when one is available for the current platform. Development builds then fall back to `.venv`, `venv`, a configured interpreter, or Python on `PATH`.

## Configuring a model

DevMate does not include provider credentials.

1. Open DevMate.
2. Click the model selector beside the Ask button.
3. Configure the built-in Nemotron profile or add a custom profile.
4. Enter an API key if the selected provider requires one.

Profile metadata is stored in VS Code global storage. API keys are stored separately through VS Code SecretStorage.

### Built-in Nemotron

The built-in profile uses NVIDIA's OpenAI-compatible endpoint:

```text
https://integrate.api.nvidia.com/v1
```

The user must provide their own NVIDIA API key.

### OpenAI-compatible profiles

A custom profile can use the default OpenAI endpoint or another compatible base URL. DevMate sends provider keys to the backend only when the configured backend address is local.

### Ollama

Ollama profiles default to:

```text
http://127.0.0.1:11434
```

The selected model must already be installed in Ollama. DevMate does not download Ollama models.

### Intelligence levels

Models recognised as reasoning models show an intelligence icon beside the model selector. The available Auto, Low, Medium, High, and Extra High choices depend on the selected model. Unknown compatible endpoints keep their provider defaults.

## Using the chat

Press `Enter` to send a message and `Shift+Enter` to insert a new line.

### Modes

- **Ideas** is read-only and focuses on approaches and trade-offs.
- **Code** can inspect the project, edit files, and verify its work.
- **Debug** focuses on failures, diagnostics, small fixes, and rerunning verification.

### Context scopes

- **Project** retrieves relevant chunks from the open workspace.
- **File** sends the active editor's current content.
- **Selection** sends the highlighted text.
- **Add files** attaches specific workspace files to any scope.

Source content is collected by the extension host. The webview receives labels and status information rather than direct filesystem access.

### Sessions

DevMate opens on a session list. Each session stores its project identity, messages, and final file-change summaries. A session cannot be opened while a different project is active.

An unfinished tool run is stored as a bounded checkpoint. If the request fails or VS Code is reloaded, the **Continue** button can resume it with its saved tool history.

## Project retrieval

Project scope uses a local lexical index. DevMate:

1. Finds eligible text files in the first workspace folder.
2. Excludes dependencies, generated files, build output, credentials, lock files, and binary files.
3. Splits files into overlapping, line-aware chunks.
4. Scores chunks using paths, identifiers, keywords, and BM25-style text matching.
5. Sends only the strongest bounded excerpts to the provider.

The index is stored in VS Code's private workspace storage, not inside the repository. Changed files are refreshed on the next Project request.

This version does not use embeddings. Lexical retrieval is predictable and works well for code identifiers, while semantic or hybrid retrieval remains possible future work.

## Agent tools

Read-only tools are available in every mode:

- `list_files`
- `read_file`
- `search_code`
- `get_symbols`
- `find_definition`
- `find_references`
- `get_diagnostics`
- `read_terminal_errors`

Code and Debug can additionally request:

- `create_file`
- `edit_file`
- `delete_file`
- `rename_file`
- `move_file`
- `install_dependencies`
- `run_command`

The tool-call limit is configurable, but mutations, commands, installations, file counts, and changed characters have separate hard limits.

## File changes and permissions

File operations are executed by the extension, not the backend.

- Create and update actions can be set to **Ask every time** or **Allow instantly** for each workspace.
- Delete, rename, and move actions always require one-time approval.
- Dependency installation always requires one-time approval.
- Verification commands can be allowed once or remembered as an exact command for the workspace.
- Proposed file changes can be reviewed in VS Code's native diff editor.

Before applying a change, DevMate checks workspace trust, path boundaries, protected files, symbolic links, file size, binary content, unsaved editor changes, and stale proposals. Approved edits use `WorkspaceEdit` and participate in VS Code's normal undo behaviour.

## Verification commands

`run_command` is not a general terminal. It accepts an executable and an argument array, then validates them against a registry of test, lint, type-check, and build commands.

The registry includes common commands for JavaScript/TypeScript, Python, Rust, Go, .NET, Maven, and Gradle. Shell composition, Git commands, installation commands, servers, generators, deployment commands, privilege escalation, and writable formatters are blocked.

Command output is shown in a bounded chat card. The full output remains available in a dedicated VS Code terminal.

## Python dependency recovery

When Python verification reports a missing module, Code or Debug can use `install_dependencies`. The tool accepts only a simple workspace-relative `requirements.txt` or `requirements-*.txt` file.

URLs, editable packages, local paths, nested manifests, custom indexes, and environment markers are rejected. Installation runs inside a project virtual environment and always asks for permission.

## Backend management

The default backend URL is:

```text
http://127.0.0.1:8000
```

The status indicator in the DevMate toolbar shows whether the backend is checking, starting, online, restarting, unmanaged, or offline. Click the indicator to open the backend output channel.

The backend can also be started manually:

```powershell
.venv\Scripts\python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

Check it at:

```text
http://127.0.0.1:8000/health
```

When an external server is already listening at the configured address, DevMate uses it without trying to stop or replace it.

## Settings

The gear button in the DevMate toolbar opens the main settings dialog.

| Setting | Default | Range or behaviour |
| --- | ---: | --- |
| Provider timeout | 900 seconds | 10–1800 seconds |
| Command timeout | 300 seconds | 10–1800 seconds |
| Tool calls per request | 16 | 4–100 |
| Maximum output tokens | 16384 | 128–32000 |
| Temperature | 0.2 | 0–2 |
| Create files | Ask | Workspace-specific |
| Update files | Ask | Workspace-specific |

The separate **Agent tools** settings screen controls maximum read lines and result counts for listing, searching, diagnostics, terminal errors, symbols, definitions, and references.

The same values can be edited through normal VS Code settings under the `devMate` namespace.

## Running the tests

Type-check the extension without writing output:

```powershell
npm run check
```

Run the extension test suite:

```powershell
npm test
```

Run the backend test suite:

```powershell
.venv\Scripts\python -m unittest discover -s backend\tests -v
```

The tests do not make paid provider requests. Provider behaviour is tested with mocked responses.

## Packaging a VSIX

Install the development dependencies, including PyInstaller for the backend build:

```powershell
npm ci
py -m venv .venv
.venv\Scripts\python -m pip install -r backend\requirements-dev.txt
```

Build the standalone backend for the current operating system and architecture:

```powershell
npm run build:backend
```

Run the tests and create an installable VSIX:

```powershell
npm test
npx --yes @vscode/vsce package --out devmate-1.0.0.vsix --allow-missing-repository
```

The `vscode:prepublish` script rebuilds the backend and TypeScript extension automatically. PyInstaller builds for the computer it runs on, so a Windows x64 VSIX must be built on Windows x64.

Install it with:

```powershell
code --install-extension .\devmate-1.0.0.vsix
```

It can also be installed from VS Code through **Extensions: Install from VSIX**.

### Backend in the installed extension

The Windows x64 VSIX includes a self-contained backend executable. DevMate starts it when VS Code opens, monitors its health, restarts it after a failure, and stops the process it owns when VS Code closes. Users do not need to install Python or configure `devMate.backendPythonPath` for that build.

The Python backend source remains in the package as a fallback for development or an unsupported platform. In that case, install `backend/requirements.txt` and set **DevMate: Backend Python Path** to the interpreter.

## Repository structure

| Path | Purpose |
| --- | --- |
| `src/extension.ts` | Extension activation, webview, agent loop, and tool execution |
| `src/agentTools.ts` | Tool names, argument parsing, limits, and history compaction |
| `src/agentToolSettings.ts` | Configurable per-tool result limits |
| `src/api/` | Extension-to-backend HTTP transport and request types |
| `src/backendManager.ts` | Local backend startup, monitoring, and restart logic |
| `src/projectIndex.ts` | Local chunking and lexical retrieval |
| `src/sessions.ts` | Project-bound conversation storage |
| `src/permissions.ts` | File and command permission storage |
| `backend/app/main.py` | FastAPI routes, validation, and tool schemas |
| `backend/app/prompts.py` | Mode and agent-loop prompts |
| `backend/app/providers.py` | OpenAI-compatible provider client |
| `backend/run_backend.py` | Entry point for the standalone backend |
| `scripts/build-backend.js` | Platform-aware PyInstaller build command |
| `backend-runtime/` | Generated platform backend included in the VSIX |
| `tests/` | Extension tests |
| `backend/tests/` | Backend tests |
| `out/` | Compiled JavaScript used by VS Code |

## Troubleshooting

### DevMate cannot reach the backend

- Open the DevMate backend logs and check whether the bundled executable started.
- Check whether port 8000 is already in use.
- Restart the backend from the settings dialog.
- On a platform without a bundled runtime, install `backend/requirements.txt` and configure **DevMate: Backend Python Path**.

### The provider times out

Increase the provider timeout in DevMate settings. Slow reasoning models may need several minutes before returning the first tool call or text event.

### A model returns no tools or only describes future work

Check that the selected endpoint supports OpenAI-compatible function tools. DevMate can parse the native tool-call format and one bounded textual format used by some compatible models, but not every provider implements tools correctly.

### Symbols, definitions, or references are empty

Install the relevant VS Code language extension and open the target file once so its language server starts. Results outside the current workspace are filtered out.

### Verification cannot start

The workspace must be trusted and VS Code Terminal Shell Integration must be available. The requested command must also match DevMate's verification registry.

## Known limitations

- Only the first folder in a multi-root workspace is used.
- Project retrieval is lexical rather than embedding-based.
- Code navigation depends on installed VS Code language providers.
- Completed change snapshots are kept in memory, so an old native diff may be unavailable after reloading VS Code.
- Standalone backend builds are platform-specific and currently prepared for Windows x64.
- Directory operations, arbitrary shells, Git commands, servers, generators, and deployment commands are not supported.

## Security notes

- Do not commit API keys or `.env` files.
- Provider keys are stored in VS Code SecretStorage.
- Keys are forwarded only through a loopback DevMate backend.
- Provider redirects are disabled to avoid forwarding credentials to another host.
- Project and tool content is treated as untrusted data in backend prompts.
- The model never receives direct filesystem, terminal, or VS Code API access.
