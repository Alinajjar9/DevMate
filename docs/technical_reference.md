# Technical reference

This is a source map for the current implementation. Start with the [project guide](project_guide.md) for a plain-English explanation and the [README](../README.md) for setup commands.

## Architecture

```text
Webview (media/)
  -> typed messages -> VS Code extension (src/)
  -> authenticated HTTP -> local FastAPI backend (backend/app/)
  -> configured chat or embedding provider

Model tool request
  -> extension validation and permission checks
  -> workspace action
  -> bounded result in the next model request

Backend repositories
  -> private SQLite database outside the repository
```

The extension owns project file access, edits, native diffs, and terminals. The backend owns provider communication and SQLite operations. Folders group related files; they are not extra wrappers or independently deployed services.

## TypeScript source map

| Location | Responsibility |
| --- | --- |
| `src/extension.ts` | Activation, dependency composition, registrations, index/backend lifecycle wiring |
| `src/chat/chatViewProvider.ts` | Webview lifecycle, validated message routing, controller/presenter wiring, view cancellation |
| `src/chat/chatRequestController.ts` | Request preflight, context/compaction coordination, finalization and session updates |
| `src/chat/webviewProtocol.ts` | Typed UI messages and runtime decoding of incoming commands |
| `src/chat/webview.ts` | HTML shell, content security policy, packaged asset URLs |
| `src/agent/agentRunController.ts` | Per-run state and named request, response/recovery, tool execution and checkpoint phases |
| `src/agent/toolExecutor.ts` | Validated tool dispatch, reads, navigation, mutations, terminals, dependency installation |
| `src/agent/agentTools.ts` | Tool parsing, limits, duplicate signatures, retry decisions, bounded tool history |
| `src/agent/agentToolProtocol.ts` | Shared tool names, groups, and tool-call types |
| `src/agent/agentCheckpointController.ts` | Persisting and presenting unfinished run state |
| `src/context/workspaceContext.ts` | Workspace identity, scope/attachment collection, retrieval integration and fallback context |
| `src/context/contextPlanner.ts` | Estimated token budget and context selection |
| `src/context/attachmentController.ts` | Attachment state and selection |
| `src/projectSearch/` | Source indexing, change coordination, optional embedding batches, lexical/hybrid retrieval |
| `src/sessions/` | Session state, SQLite API adapter, session UI, automatic chat compaction |
| `src/workspace/` | File/command policies, permission UI, diffs, and mutation safety |
| `src/settings/` | Chat/embedding profiles, SecretStorage adapters, settings validation and UI |
| `src/api/` | Shared contracts, strict response decoders, HTTP client, backend manager, provider URL policy |
| `src/api/client.ts` | Endpoint calls and authenticated local-backend request policy |
| `src/api/backendTransport.ts` | HTTP deadlines, cancellation, bounded responses and NDJSON stream framing |
| `src/api/backendResponseProtocol.ts` | Strict chat, health, error and token-usage decoding; index/memory decoding stays in the adjacent protocol modules |
| `media/webview.js`, `media/webview.css` | Browser state/rendering and sidebar styles |

## Python source map

| Location | Responsibility |
| --- | --- |
| `backend/app/main.py` | `create_app()`, lifecycle, authentication middleware, error handlers, router composition |
| `backend/app/dependencies.py` | Injected providers, repositories, and services used by routes |
| `backend/app/errors.py` | Shared backend API exception |
| `backend/app/knowledge_store.py` | SQLite connection, transactions, schema migrations, private database path |
| `backend/app/api/api_models.py` | Pydantic request/response models and protocol constants |
| `backend/app/api/api_routes.py` | Health, normal chat, and streamed chat HTTP routes |
| `backend/app/chat/chat_service.py` | Chat request preparation, completion/stream coordination, response validation |
| `backend/app/chat/prompts.py` | Mode instructions and model-message construction |
| `backend/app/chat/tool_catalog.py` | Model-facing tool definitions |
| `backend/app/chat/code_changes.py` | Validation of final structured file changes |
| `backend/app/chat/text_tool_calls.py` | Strict compatibility parsing for textual tool calls |
| `backend/app/providers/chat_provider.py` | Explicit completion/streaming protocols, completion-only adapter, chat payloads and HTTP implementation |
| `backend/app/providers/provider_network.py` | Shared chat/embedding URL, DNS and IP safety, pinned connections and provider errors |
| `backend/app/providers/embedding_clients.py` | Ollama/OpenAI-compatible embedding HTTP clients |
| `backend/app/providers/embedding_providers.py` | Shared embedding profile, request/result protocol and vector limits |
| `backend/app/indexing/` | Index contracts/routes, source/vector repositories, embedding indexing and semantic search |
| `backend/app/indexing/index_validation.py` | Shared repository input validation and errors; each repository still validates its own calls |
| `backend/app/memory/` | Chat storage contracts/routes, session repository and summary generation |
| `backend/run_backend.py` | Standalone runtime entry point |

The `__init__.py` files mark Python packages. They do not re-export the whole backend API.

## Startup and authentication

1. VS Code calls `activate` in `src/extension.ts` and registers the chat view and commands.
2. `LocalBackendManager` creates a per-launch token and starts the bundled backend. Source development can use a configured/local Python environment instead.
3. The database path is passed through `DEVMATE_KNOWLEDGE_STORE_PATH`. It is under `ExtensionContext.globalStorageUri`, in `knowledge/devmate-knowledge.sqlite3`.
4. `/health` requires the backend token and reports the service identity, protocol version, and capabilities. The extension checks that handshake before enabling backend access.
5. Once the backend is online, the extension loads chats and synchronizes the first workspace's source index. A configured embedding profile can then process missing vectors in bounded batches.

The backend token uses `X-DevMate-Backend-Token`, separate from the provider API key. `/health`, `/ask`, `/ask/stream`, `/index/v1/*`, and `/memory/v1/*` are authenticated. Current backend protocol version is `2`; index and memory APIs have their own `v1` paths.

`manageLocalBackend: false` is a diagnostic setting in this release. There is no extension UI for supplying an independently managed backend's token.

## Request and tool loop

1. `parseWebviewMessage` decodes the incoming value before `DevMateChatViewProvider.handleMessage` routes it.
2. `ChatRequestController` records the pending question, checks workspace/profile/backend state, and gathers initial context.
3. `ChatCompactionController` loads any existing summary and may request a new one. `AgentRunController` plans the bounded request context before model calls.
4. `src/api/client.ts` sends `/ask/stream` and validates each NDJSON event. Unsupported streaming may fall back to a normal completion; malformed streams are not silently accepted.
5. The backend validates `AskRequest`, prepares mode/tool instructions, and calls the provider.
6. A final answer ends the loop. Tool calls instead pass through parsing, loop limits, permissions, and `ToolExecutor.execute`.
7. Bounded results return to the model. Duplicate-call rules, mutation/command budgets, retries, cancellation, and checkpoints control subsequent passes.
8. The request controller applies any final approved proposals through the same mutation boundary, builds the actual change summary, and updates the session.

`AgentRunController` emits events; it does not call the webview directly. `ChatViewProvider` forwards events to UI presenters and the typed bridge.

Read-only tools are `list_files`, `read_file`, `search_code`, `get_symbols`, `find_definition`, `find_references`, `get_diagnostics`, and `read_terminal_errors`. Code and Debug may also use `create_file`, `edit_file`, `delete_file`, `rename_file`, `move_file`, `install_dependencies`, and `run_command`.

## Indexing and retrieval

The source-index path is:

1. `workspaceIndexWatcher.ts` combines file events and schedules one synchronization at a time.
2. `workspaceIndexSource.ts` reads eligible files and document symbols, and validates the file again after asynchronous reads.
3. `indexSynchronization.ts` compares content hashes and chunking versions. It writes changed files/chunks and removes deleted files through the backend API.
4. `projectChunking.ts` prefers suitable symbol boundaries and falls back to overlapping line chunks.
5. `embeddingIndexScheduler.ts` requests bounded embedding work only with an available profile and backend capability.

Automatic Project-scope retrieval uses `HybridProjectRetriever` in `src/projectSearch/projectRetriever.ts`:

- SQLite FTS5/BM25 supplies lexical matches.
- The embedding service embeds the question only when compatible stored vectors are available. `semantic_search_service.py` scans normalized vectors in pages and retains the best exact cosine matches.
- `projectSearchRanking.ts` combines result positions with Reciprocal Rank Fusion, then boosts exact code/path signals.
- Duplicate results are removed, file diversity is applied, and selected source is reread and validated before context is returned.
- `projectIndex.ts` supplies local lexical fallback when the backend or embedding path is unavailable or yields no usable matches.

There is no separate vector database server or approximate-nearest-neighbor index. Vector compatibility includes profile/model/dimensions/version information and source hashes. Remote embedding transfer requires explicit opt-in.

Important distinction: the `search_code` tool in `src/agent/toolExecutor.ts` is a bounded case-insensitive substring scan. It does not call `HybridProjectRetriever`.

## Context and memory

`src/context/contextPlanner.ts` estimates one token per four characters, reserves the configured output allowance, and leaves a 10% safety margin. An unknown model context window defaults to 32,000 tokens. `devMate.maxInputContextTokens = 0` means Auto.

Priority runs from instructions/question and explicit input, through current tool state and recent chat, to summary, project results, and older tool output. Required input is not silently dropped; overflow becomes an error for the caller to report. This is a planning estimate, not a provider-specific tokenizer.

`src/sessions/chatCompaction.ts` checks estimated demand before trimming. At 75% of usable input capacity, eligible older turns can be summarized while the latest four completed turns remain outside the summary. Pending questions are not compacted.

`backend/app/memory/chat_compaction_service.py` combines the previous summary with newly eligible turns, uses the active chat provider, validates the structured result, redacts recognizable secrets, and saves atomically. Redaction is a safeguard, not a guarantee that every possible secret pattern is detected. Failure keeps the previous summary. Compaction does not delete raw turns.

Normal session limits are separate from compaction: `src/sessions/sessions.ts` bounds the extension's working set to 20 sessions, 30 turns per session, and character limits. Model history is additionally limited before context planning. Long-history retention is not unlimited or lossless, and should not be described as a permanent archive.

Checkpoints are stored separately in VS Code workspace state through `AgentCheckpointController`. They contain the question, mode/scope, bounded tool history, counters, signatures, workspace revision, token usage, and timestamps. A checkpoint must match the current workspace and session and pass age/size validation before resume.

## Database and other storage

| Tables/data | Purpose |
| --- | --- |
| `workspaces`, `files` | Workspace identity and file fingerprints |
| `chunks`, `chunks_fts` | Exact source excerpts and synchronized full-text search index |
| `embeddings` | Normalized float32 vectors and compatibility metadata |
| `index_metadata`, `schema_migrations` | Index progress/chunking version and schema history |
| `chat_sessions`, `chat_turns`, `chat_summaries` | Workspace-bound chats and per-chat summaries |
| VS Code global state | Chat/embedding profiles and selection/preferences |
| VS Code SecretStorage | Provider keys |
| VS Code workspace state | File policies, exact command approvals, unfinished checkpoint |
| Extension workspace storage | Rebuildable fallback lexical index |

`knowledge_store.py` enables foreign keys, transactions, and WAL mode. Source chunks and chat text are stored locally; the database is not an encrypted vault. The current schema does not contain pinned memories or embeddings for every chat turn.

## Workspace safety boundary

`src/workspace/workspaceMutations.ts` keeps mutation checks together:

- Workspace trust and permission approval.
- Paths confined to the first workspace folder; protected, binary, oversized, and symbolic-link targets rejected.
- Unsaved-document handling and exact replacement validation.
- Revalidation after approval and near application, including create/update symlink checks.
- Native `WorkspaceEdit` application, save handling, and diff snapshots.

`src/workspace/fileTools.ts` applies sequential exact replacements. Each old-text match must be unique. `src/workspace/commandTools.ts` validates supported verification commands and builds exact permission signatures. Dependency installation uses a separate restricted path in `ToolExecutor`; it is not general command permission.

File application returns a typed `applied`, `denied`, or `cancelled` outcome. Applied paths and optional editor notices stay separate, so changing display text cannot change which edits appear in the final summary. Verification and dependency installation share one terminal-completion lifecycle, while keeping their own approval and command rules.

Path helper names also state their purpose: `toForwardSlashes` only formats separators, `parseToolPath` validates model tool paths, and `validateMutationPath` applies the stricter write-path policy. Formatting a path is not a security check.

Remote provider URLs must use HTTPS and resolve only to public addresses. Exact loopback services may use HTTP. The provider client rejects unsafe DNS answers and pins requests to a checked address while retaining the original host for HTTP routing and TLS. Strict decoders reject malformed backend success/error data and out-of-order stream events.

These checks reduce risk; they do not turn a local coding extension into a security sandbox. Use a disposable demo workspace and review file/command approvals.

## Main settings

| Setting | Default |
| --- | --- |
| `devMate.backendUrl` | `http://127.0.0.1:8000` |
| `devMate.manageLocalBackend` | `true` |
| `devMate.requestTimeoutSeconds` | `900` |
| `devMate.commandTimeoutSeconds` | `300` |
| `devMate.toolCallLimit` | `16` |
| `devMate.readFileMaxLines` | `400` |
| `devMate.maxTokens` | `16384` |
| `devMate.maxInputContextTokens` | `0` (Auto) |
| `devMate.temperature` | `0.2` |

The complete schema and limits are in `package.json`. Chat profile context windows and embedding profiles are configured separately.

## Verification and common changes

`npm run verify` checks TypeScript, import cycles, extension tests, Python tests, cross-language contracts, and emitted JavaScript/source correspondence. `npm run compile` cleans `out/` first. Edit source files, not generated `out/` JavaScript or `.map` files.

- **UI layout:** `media/webview.css`; browser interactions: `media/webview.js`; HTML/CSP: `src/chat/webview.ts`.
- **Request lifecycle:** `src/chat/chatRequestController.ts`; run policy: `src/agent/agentRunController.ts`.
- **New or changed tool:** update tool protocol/parsing, executor, Python catalog, and related contract/behavior tests.
- **Retrieval:** use `src/projectSearch/` and `backend/app/indexing/`; ranking fixtures are in `tests/fixtures/project-retrieval-evaluation.json`.
- **Session or summary behavior:** use `src/sessions/` and `backend/app/memory/`.
- **Permissions or mutation rules:** use `src/workspace/` and keep the race/cancellation tests in `tests/workspaceMutations.test.js`.
- **Shared API field:** check `src/api/types.ts`, the relevant TypeScript decoder, `backend/app/api/api_models.py`, and Python contract constants.

Automated tests use controlled fixtures and provider doubles. They do not prove every remote model works or replace a visual test in the actual VS Code window. See [known issues and manual checks](known_bugs.md).

`tests/agentRunController.test.js` exercises the public run workflow and its limits, recovery and cancellation. `tests/toolExecutor.test.js` checks terminal execution and permission outcomes. The browser tests execute the real webview script with a small DOM/message harness instead of extracting function text. That harness does not model layout. The scoped `withVscodeMock` helper restores Node's module loader even when an import throws.
