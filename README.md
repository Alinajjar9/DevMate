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
- Local semantic and lexical project retrieval with a private workspace index.
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

Profile metadata is stored in VS Code global storage. API keys are stored separately through VS Code SecretStorage. Custom profiles may optionally declare their model's total context window; leaving it on **Auto** uses DevMate's conservative 32,000-token fallback.

### Built-in Nemotron

The built-in profile uses NVIDIA's OpenAI-compatible endpoint:

```text
https://integrate.api.nvidia.com/v1
```

The user must provide their own NVIDIA API key.

### OpenAI-compatible profiles

A custom profile can use the default OpenAI endpoint or another compatible base URL. Remote provider URLs must use HTTPS and resolve only to public network addresses. Plain HTTP and non-public destinations are accepted only for exact loopback hosts used by local services.

### Ollama

Ollama profiles default to:

```text
http://127.0.0.1:11434
```

The selected model must already be installed in Ollama. DevMate does not download Ollama models.
Local Ollama URLs such as `http://127.0.0.1:11434` remain supported.

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

Project scope uses the local SQLite knowledge index when the authenticated managed backend is available. DevMate:

1. Indexes eligible text files from the first workspace folder in the background.
2. Excludes dependencies, generated files, build output, credentials, lock files, symbolic links, and binary files.
3. Prefers VS Code document-symbol boundaries and falls back to bounded overlapping line chunks.
4. Generates optional local-first embeddings and ranks compatible cached vectors by exact cosine similarity.
5. Combines semantic and SQLite FTS5/BM25 positions with Reciprocal Rank Fusion, then applies small capped filename, path, and exact-identifier boosts.
6. Rereads each selected file and verifies the exact chunk hash and line range before using it.
7. Sends only the strongest bounded excerpts to the provider.

The SQLite index is stored in VS Code's private global extension storage, not inside the repository. If authenticated SQLite search is unavailable, empty, fails, or contains no usable current chunks, DevMate falls back to the previous JSON lexical index. That fallback index is refreshed lazily only when needed; cancellation stops retrieval without starting fallback work.

Embedding retrieval uses separate local-first profiles for Ollama and OpenAI-compatible providers, requires explicit consent before sending source code or queries to a remote embedding endpoint, and keeps profile credentials out of normal extension storage. The backend has bounded clients for native Ollama `/api/embed` and OpenAI-compatible `/embeddings` requests. They reuse the existing safe provider-network boundary, strictly validate batches, and normalize accepted vectors.

The SQLite embedding repository can activate one bounded configuration per workspace, discover missing chunks, atomically store normalized float32 vectors against exact chunk hashes, page through stored vectors, and invalidate stale configurations. File replacement and deletion automatically remove associated vectors through existing foreign-key cascades.

A backend embedding-index service now joins the provider and repository in bounded, resumable batches. It discovers dimensions from the first real source batch, stores each successful batch immediately, continues with only missing chunks, and rebuilds incompatible vectors when dimensions change.

The authenticated `/index/v1/embeddings/synchronize` route exposes that service through strict bounded request and response models. Provider credentials use the provider-key header rather than the JSON body, and the backend advertises the optional `embedding-index-v1` capability. After a fully ready lexical synchronization, the extension can use a configured validated embedding profile to generate missing vectors in delayed, cancellable one-batch requests. It reads only the selected profile's SecretStorage value and stops on provider failure instead of retrying indefinitely.

Embedding profiles are managed separately under **DevMate settings → Semantic code index**. Local Ollama is the default when adding a profile. Non-loopback endpoints require HTTPS and an explicit confirmation that the provider may receive bounded project source-code chunks and search queries. Saving or selecting a profile refreshes background vector generation for the last ready workspace index.

When the backend advertises semantic-search support and the selected profile has compatible cached vectors, DevMate embeds the question once and performs an exact cosine comparison over the workspace vectors in bounded pages. Semantic and lexical searches begin together. Their ranked positions are combined with equal-weight Reciprocal Rank Fusion, which rewards chunks found by both without comparing incompatible cosine and BM25 score scales. Small query-aware boosts then favor an explicitly named file, matching path terms, or an exact code identifier found in a chunk. The total boost is capped so it cannot replace the underlying retrieval rankings. Results are deterministically deduplicated and reread from disk before use. Missing profiles, incompatible vectors, and provider failures leave lexical ranking available; if neither strategy yields usable current source, DevMate uses the JSON fallback.

On the checked-in evaluation corpus, SQLite lexical retrieval produces 7 of 11 top-one hits, 7 of 11 top-three hits, and 0.6364 recall at five. These numbers remain the model-independent lexical baseline; hybrid effectiveness also depends on the configured embedding model.

## Context budgeting

Before every provider request, DevMate calculates a usable input budget from the selected profile's context window, the global input cap, the configured output reserve, and a ten-percent estimation margin. Unknown model capacities use the conservative 32,000-token fallback.

The current question and explicit selections, active files, and attachments are never silently removed. If that mandatory input plus the reserved instructions cannot fit, DevMate stops before contacting the model and reports a clear configuration error. Remaining capacity is assigned to current tool state, newest completed conversation turns, ranked project results, and older tool output in that order. When an older tool result does not fit, DevMate keeps the tool call and replaces only its result text with an omission marker so the agent history remains structurally valid.

## Chat memory storage

The private SQLite store now includes versioned foundations for chat sessions, raw turns, structured summaries, and pinned memories. Chat records use the same private database file as the project index but have an independent lifecycle, so rebuilding or deleting a code index does not delete conversation history. Deleting a chat does cascade only its turns, summary, and pinned memories.

The repository preserves pending and completed raw turns, validates the future compaction-summary structure, and bounds all stored values. This milestone does not switch the extension's live session storage from VS Code state, migrate existing chats, generate summaries, or include stored memory in model requests yet.

The managed backend advertises the optional `chat-memory-v1` capability and exposes authenticated versioned operations to atomically save bounded session batches, load one complete raw transcript, list recent sessions for one workspace, and delete one session. The TypeScript client sends chat data only to a verified loopback backend and strictly validates every response against the request. These operations are available for the migration layer but are not called by the live chat UI yet.

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

Before applying a change, DevMate checks workspace trust, path boundaries, protected files, symbolic links, file size, binary content, unsaved editor changes, and stale proposals. Create and update paths are checked for symbolic links again after approval and after creating required parent directories. Approved edits use `WorkspaceEdit` and participate in VS Code's normal undo behaviour.

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

DevMate generates a fresh in-memory authentication token whenever it launches the backend. The token is passed only to that child process and is required by `/health`, `/ask`, and `/ask/stream`. Manually started or externally managed backends are intentionally rejected until an explicit secure token-sharing flow is available.

The managed backend also receives an explicit SQLite path below VS Code's private global extension storage. The application opens the versioned knowledge store during startup and closes it during shutdown. Its authenticated `/index/v1/` API supports workspace snapshots, atomic file batches, index metadata, lexical search, embedding synchronization, and semantic search.

After the managed backend comes online, the extension performs an initial background synchronization of the first local workspace. It then watches relevant create, change, delete, rename, and workspace-folder events. Event bursts are debounced into one follow-up synchronization, and changes arriving during an active run produce one trailing run. Indexing pauses and active work is cancelled whenever authenticated backend access is unavailable.

Each synchronization reuses the existing project-file limits and exclusions, rejects symbolic-link paths, hashes the eligible files, and sends only changed files and known deletions in bounded batches. Changed files prefer validated VS Code document-symbol boundaries so declarations stay together where size limits permit. Missing, invalid, or unavailable language-provider results fall back to the existing overlapping line chunks. Symbol lookup is performed only after a fingerprint changes and is revalidated against the exact file snapshot being indexed.

Unreadable files leave the SQLite index marked stale instead of deleting previously indexed content. Project chat fuses authenticated semantic and SQLite lexical rankings when both are available, uses either strategy independently when only one succeeds, and keeps the previous JSON index as a lazy compatibility fallback.

## Settings

The gear button in the DevMate toolbar opens the main settings dialog.

| Setting | Default | Range or behaviour |
| --- | ---: | --- |
| Provider timeout | 900 seconds | 10–1800 seconds |
| Command timeout | 300 seconds | 10–1800 seconds |
| Tool calls per request | 16 | 4–100 |
| Maximum output tokens | 16384 | 128–32000 |
| Maximum input context | Auto | Auto or 128–4000000 tokens |
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

Run the complete clean verification suite (TypeScript compilation, extension tests, backend tests, cross-language contracts, and emitted-file integrity):

```powershell
npm run verify
```

Run only one part of the suite when iterating locally:

```powershell
npm run test:extension
npm run test:backend
npm run test:contracts
```

`npm test` is an alias for the complete verification suite. The backend test launcher prefers the repository's `.venv` and falls back to Python on `PATH`.

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
| `src/extension.ts` | Extension activation, registrations, and dependency composition |
| `src/chatViewProvider.ts` | Chat lifecycle, request preflight/finalization, sessions, permissions, and UI forwarding |
| `src/agentRunController.ts` | Provider retries, checkpointed agent-loop policy, recovery, and tool iteration |
| `src/toolExecutor.ts` | Validated tool dispatch, workspace inspection, terminal execution, and mutation routing |
| `src/workspaceContext.ts` | Workspace identity, scope collection, attachments, and project-index orchestration |
| `src/indexSynchronization.ts` | Cancellable workspace-to-SQLite reconciliation and bounded change batching |
| `src/embeddingIndexScheduler.ts` | Capability-gated background generation of missing workspace embeddings |
| `src/workspaceIndexSource.ts` | Safe, bounded VS Code workspace scanning and file revalidation for indexing |
| `src/workspaceIndexWatcher.ts` | Debounced workspace-change monitoring and authenticated synchronization scheduling |
| `src/projectChunking.ts` | Validated document-symbol chunk boundaries with bounded line-based fallback |
| `src/workspaceMutations.ts` | File writes, trust checks, symlink protection, and pre-apply revalidation |
| `src/webview.ts` | CSP-protected webview shell and packaged asset URLs |
| `media/webview.css` | Sidebar layout and visual styles |
| `media/webview.js` | Browser-side chat state, rendering, and interactions |
| `src/agentTools.ts` | Tool names, argument parsing, limits, and history compaction |
| `src/api/` | Extension-to-backend HTTP transport, request types, and strict knowledge-index response decoding |
| `src/api/knowledgeIndexProtocol.ts` | Runtime validation for versioned knowledge-index responses |
| `src/backendManager.ts` | Local backend startup, monitoring, and restart logic |
| `src/embeddingProfiles.ts` | Local-first embedding profile validation, selection, consent, and SecretStorage keys |
| `src/embeddingProfileController.ts` | Validated embedding-profile persistence and UI-facing operations |
| `src/providerUrlPolicy.ts` | Shared chat and embedding provider URL security policy |
| `src/contextPlanner.ts` | Token-budget calculation and deterministic context-priority policy |
| `src/projectIndex.ts` | Local index representation, chunking, and lexical scoring |
| `src/projectRetriever.ts` | Capability-gated project retrieval, exact-source validation, and lexical fallback |
| `src/projectSearchRanking.ts` | Reciprocal Rank Fusion plus bounded filename, path, and exact-identifier boosts |
| `src/sessions.ts` | Project-bound conversation storage |
| `src/permissions.ts` | File and command permission storage |
| `backend/app/api_models.py` | Backend protocol constants and validated request/response contracts |
| `backend/app/api_routes.py` | HTTP endpoints and NDJSON streaming orchestration |
| `backend/app/chat_service.py` | Model-request construction, completion normalization, and token accounting |
| `backend/app/dependencies.py` | Per-application backend dependency container and route accessors |
| `backend/app/errors.py` | Shared backend application errors |
| `backend/app/embedding_clients.py` | Safe bounded Ollama and OpenAI-compatible embedding HTTP clients |
| `backend/app/embedding_index_service.py` | Bounded resumable generation of missing workspace vectors |
| `backend/app/embedding_providers.py` | Batched embedding-provider request, result, and protocol boundary |
| `backend/app/embedding_repository.py` | Workspace-isolated normalized vector persistence and invalidation |
| `backend/app/semantic_search_service.py` | Query embedding and exact cosine ranking over cached workspace vectors |
| `backend/app/knowledge_contracts.py` | Shared version, states, and size limits for the knowledge-index protocol |
| `backend/app/knowledge_routes.py` | Authenticated version-one knowledge-index HTTP routes |
| `backend/app/knowledge_store.py` | Isolated versioned SQLite schema and transaction boundary for the code index |
| `backend/app/knowledge_repository.py` | Transactional workspace, file, chunk, metadata, and FTS data access |
| `backend/app/main.py` | FastAPI application composition, authentication, and exception handling |
| `backend/app/prompts.py` | Mode and agent-loop prompts |
| `backend/app/providers.py` | OpenAI-compatible provider client |
| `backend/app/tool_catalog.py` | Agent tool descriptions and JSON parameter schemas |
| `backend/run_backend.py` | Entry point for the standalone backend |
| `scripts/build-backend.js` | Platform-aware PyInstaller build command |
| `backend-runtime/` | Generated platform backend included in the VSIX |
| `tests/fixtures/project-retrieval-evaluation.json` | Shared corpus and relevance judgments for comparing project retrievers |
| `tests/helpers/projectRetrievalEvaluation.js` | Retrieval-quality metrics and evaluation harness |
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
- Hybrid retrieval currently uses fixed equal weights and fixed bounded query-signal boosts; it does not yet expose diagnostic retrieval modes or language-server symbol-graph ranking.
- Token counts use a conservative character estimate and fixed prompt reserve rather than each provider's exact tokenizer; chat migration, automatic summary generation, prompt inclusion, and manual memory controls are not implemented yet.
- Code navigation depends on installed VS Code language providers.
- Completed change snapshots are kept in memory, so an old native diff may be unavailable after reloading VS Code.
- Standalone backend builds are platform-specific and currently prepared for Windows x64.
- Directory operations, arbitrary shells, Git commands, servers, generators, and deployment commands are not supported.

## Security notes

- Do not commit API keys or `.env` files.
- Provider keys are stored in VS Code SecretStorage.
- Provider keys and workspace context are forwarded only after the managed loopback backend proves possession of its per-process token.
- The backend token is kept in extension-host memory, passed through the child-process environment, and never sent to the model provider.
- The SQLite knowledge database is kept below VS Code's private global extension storage rather than inside a workspace.
- Provider redirects are disabled to avoid forwarding credentials to another host.
- Remote model-provider endpoints require HTTPS; plain HTTP is limited to loopback hosts.
- Provider hostnames are resolved before each request, every answer must be public (or exact loopback for a local provider), and the connection is pinned to a checked address while retaining the original TLS identity.
- Backend protocol version 2 advertises the version-one knowledge-index capability and uses strictly decoded success, index, and streaming schemas plus stable machine-readable error codes; malformed responses are rejected without displaying untrusted error text.
- Project and tool content is treated as untrusted data in backend prompts.
- The model never receives direct filesystem, terminal, or VS Code API access.
