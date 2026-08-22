# DevMate Change Log

Record meaningful changes here before creating each commit. Keep the newest entry first and describe the result rather than listing every edited file.

## 2026-08-22 — Establish the project-retrieval evaluation baseline

### Changed

- Added a deterministic 12-file retrieval corpus with 11 exact-identifier, exact-text, conceptual, architectural, and ambiguous questions plus known relevant files.
- Added a reusable retriever evaluation harness reporting top-one and top-three hits, mean reciprocal rank, recall at five, category results, individual rankings, and complete misses.
- Characterized the current lexical retriever at 5/11 top-one hits, 7/11 top-three hits, 0.5455 mean reciprocal rank, and 0.6364 mean recall at five.
- Recorded 100% recall for exact identifiers and the multi-file architecture case, while all four synonym-based conceptual cases remain missed targets for future semantic and hybrid retrieval.
- Kept production indexing, retrieval, prompts, and user-visible behavior unchanged.

### Verification

- `npm run verify` — 190 extension tests and 105 backend tests passed; 39 cross-language contracts and 19 emitted JavaScript files verified.
- Focused retrieval evaluation coverage — 2 tests passed.
- `git diff --check`

---

## 2026-08-22 — Add the authenticated knowledge-index API

### Changed

- Added a versioned `/index/v1/` backend API for opening a workspace index, applying atomic file batches, updating index metadata, and running lexical searches.
- Isolated index handlers in their own router and injected the repository through the application factory without coupling index operations to chat routes.
- Required backend-token authentication across the complete index namespace and added stable unavailable, missing-workspace, and index-failure error codes.
- Added shared TypeScript/Python index versions, states, limits, and the `knowledge-index-v1` health capability.
- Added extension-side index clients with loopback-only source transfer and strict response decoding; automatic indexing and project retrieval remain unchanged.
- Added backend round-trip, authentication, validation, unavailable-store, client transport, and malformed-response coverage.

### Verification

- `npm run verify` — 188 extension tests and 105 backend tests passed; 39 cross-language contracts and 19 emitted JavaScript files verified.
- Focused index API and client coverage — 4 backend API tests and 7 new extension client tests passed.
- `git diff --check`

---

## 2026-08-22 — Add the SQLite knowledge-index repository

### Changed

- Added a backend-only `KnowledgeRepository` with bounded records for indexed files, chunks, fingerprints, metadata, and lexical results.
- Added idempotent workspace registration, stale-version detection, atomic batches for file replacement and deletion, workspace cleanup, and explicit index-state transitions.
- Added workspace-isolated SQLite FTS/BM25 search with generated safe query expressions, deterministic ordering, and bounded result limits.
- Kept database access separate from filesystem collection, chunking, HTTP routes, and VS Code integration; the extension still uses its existing lexical JSON index.
- Added focused coverage for replacement, deletion, metadata, chunk-version consistency, workspace isolation, input validation, cascades, safe search parsing, and whole-batch rollback.

### Verification

- `npm run verify` — 181 extension tests and 101 backend tests passed; 23 cross-language contracts and 18 emitted JavaScript files verified.
- Focused knowledge-repository suite — 6 tests passed.
- `git diff --check`

---

## 2026-08-22 — Wire the private knowledge-store lifecycle

### Changed

- Derived a fixed SQLite path from VS Code's private global extension storage and passed it only to backend processes managed by DevMate.
- Added strict backend validation for the database environment variable, requiring a bounded absolute path and the shared knowledge-store filename.
- Opened and migrated the injected `KnowledgeStore` through the FastAPI lifespan and closed it cleanly during shutdown.
- Kept manual and external backends optional and left project retrieval on the existing lexical JSON index; this change adds no indexing routes or user-visible retrieval behavior.
- Added shared TypeScript/Python contract checks plus focused coverage for child-environment isolation, path validation, and application lifecycle ownership.

### Verification

- `npm run verify` — 181 extension tests and 95 backend tests passed; 23 cross-language contracts and 18 emitted JavaScript files verified.
- Focused knowledge-store and lifecycle coverage — 7 knowledge-store tests and 1 application-lifecycle test passed within the backend suite.
- `git diff --check`

---

## 2026-08-22 — Add the SQLite knowledge-store foundation

### Changed

- Added an isolated `KnowledgeStore` that requires an explicit absolute database path and is not yet connected to backend routes or project indexing.
- Added an idempotent version-one schema for migrations, workspaces, files, chunks, FTS content, normalized float32 embeddings, and index metadata.
- Enabled foreign-key enforcement, WAL journaling, bounded lock waits, cascade cleanup, and automatic FTS synchronization through database triggers.
- Added explicit transaction handling and atomic migration rollback so failed writes or future schema upgrades do not leave partial state.
- Added temporary-database coverage for schema initialization, reopening, transactions, migration failure, foreign keys, embedding storage, FTS lookup, and cascade deletion.

### Verification

- `npm run verify` — 181 extension tests and 92 backend tests passed; 21 cross-language contracts and 18 emitted JavaScript files verified.
- Focused knowledge-store suite — 5 temporary-database tests passed.
- `git diff --check`

---

## 2026-08-22 — Introduce the project retriever boundary

### Changed

- Added an asynchronous `ProjectRetriever` contract with a request shape that keeps retrieval limits, exclusions, the question, and the current index explicit.
- Wrapped the existing lexical ranking algorithm in `LexicalProjectRetriever` without changing its scoring, limits, ordering, or fallback behavior.
- Injected the lexical implementation into `WorkspaceContext` at the chat-provider composition boundary instead of calling the ranking function directly.
- Added equivalence and injection coverage so a later SQLite or hybrid implementation can replace retrieval without changing project-context assembly.

### Verification

- `npm run verify` — 181 extension tests and 87 backend tests passed; 21 cross-language contracts and 18 emitted JavaScript files verified.
- Focused retrieval and context-integration suite — 13 tests passed.
- `git diff --check`

---

## 2026-08-22 — Revalidate symlink safety before file writes

### Changed

- Recheck every approved create and update path for symbolic-link segments before performing directory or file mutations.
- Repeat the path check after creating required parent directories and immediately before assembling the VS Code workspace edit.
- Added regression coverage for a create parent and an update target changing into symbolic links while permission is pending.
- Keep normal approved file updates unchanged while rejecting both race scenarios before any workspace edit is applied.

### Verification

- `npm run verify` — 180 extension tests and 87 backend tests passed; 21 cross-language contracts and 17 emitted JavaScript files verified.
- Focused workspace-mutation regression suite — 9 tests passed.
- `git diff --check`

---

## 2026-08-22 — Extract backend API routes

### Changed

- Moved `/health`, `/ask`, `/ask/stream`, and the existing NDJSON streaming state machine into `backend/app/api_routes.py` without changing their request or response contracts.
- Moved the per-application dependency container and typed route accessors into `backend/app/dependencies.py`, preserving application-factory isolation.
- Kept authentication and exception translation in the application boundary while establishing one-way dependencies from `main.py` into routes and lower-level services.
- Reduced `backend/app/main.py` from 386 lines to 154 lines, leaving it focused on FastAPI composition, authentication, and exception handling.

### Verification

- `npm run verify` — 178 extension tests and 87 backend tests passed; 21 cross-language contracts and 17 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-22 — Extract the backend tool catalog

### Changed

- Moved all agent tool names, descriptions, JSON parameter schemas, and their existing order into `backend/app/tool_catalog.py` without changing their contents.
- Kept the application factory responsible for injecting the catalog into `ChatService`, preserving one-way dependencies from routes and composition into the catalog.
- Updated API characterization tests to import the catalog directly and continue verifying that every supported agent tool has exactly one definition.
- Reduced `backend/app/main.py` from 728 lines to 386 lines, leaving it focused on FastAPI composition, authentication, errors, routes, and streaming.

### Verification

- `npm run verify` — 178 extension tests and 87 backend tests passed; 21 cross-language contracts and 17 emitted JavaScript files verified.
- Exact tool-catalog comparison against the previous `main.py` definition block.
- `git diff --check`

---

## 2026-08-22 — Extract the backend chat service

### Changed

- Moved completion-request construction, mode-specific tool filtering, response normalization, textual tool-call compatibility, file-change parsing, used-file tracking, and token accounting into `backend/app/chat_service.py`.
- Injected one `ChatService` per FastAPI application through the existing application factory while keeping provider calls and NDJSON streaming orchestration in the routes.
- Moved the shared `BackendApiError` into a lower-level error boundary so the service and routes remain independent without circular imports.
- Added direct service coverage for bounded provider requests, tool filtering, provider-key normalization, used-file deduplication, and validated tool results.
- Reduced `backend/app/main.py` from 981 lines to 728 lines without intentionally changing behavior.

### Verification

- `npm run verify` — 178 extension tests and 87 backend tests passed; 21 cross-language contracts and 17 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-22 — Extract backend API contracts

### Changed

- Moved backend protocol constants, shared literal types, validation limits, and Pydantic request and response models into `backend/app/api_models.py`.
- Made the contract module a low-level dependency with no imports from routes, prompts, or providers, preserving a one-way backend import graph.
- Updated provider and prompt modules to consume shared provider, reasoning, mode, and scope types from the contract boundary.
- Pointed API tests and TypeScript/Python contract verification directly at the new module while preserving every HTTP and streaming response shape.
- Reduced `backend/app/main.py` from 1,237 lines to 981 lines without intentionally changing behavior.

### Verification

- `npm run verify` — 178 extension tests and 85 backend tests passed; 21 cross-language contracts and 17 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-21 — Add an isolated backend application factory

### Changed

- Added `create_app()` as the single FastAPI composition boundary while keeping the module-level `app` entry point used by VS Code, Uvicorn, and packaged builds.
- Inject the chat provider and backend-token source per application instead of relying on a module-global provider or test-only dependency overrides.
- Register authentication, exception handlers, and API routes for every application instance without changing endpoint paths or response contracts.
- Build a fresh backend application for each API test and verify that provider and authentication state cannot leak between application instances.

### Verification

- `npm run verify` — 178 extension tests and 85 backend tests passed; 21 cross-language contracts and 17 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-21 — Enforce strict backend response contracts

### Changed

- Bumped the managed backend protocol to version 2 and added the required `strict-response-contracts` capability.
- Added a shared machine-readable error-code vocabulary for authentication, validation, provider, model-response, routing, and internal failures.
- Strictly decode completed answers, file changes, tool calls, token usage, validation issues, HTTP errors, and every NDJSON stream event before the extension uses them.
- Reject unknown, malformed, oversized, duplicated, or out-of-order response data without displaying untrusted backend error text.
- Use stable provider error codes for retry decisions while retaining the legacy status/message fallback for transport compatibility.

### Verification

- `npm run verify` — 178 extension tests and 83 backend tests passed; 21 cross-language contracts and 17 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-21 — Restrict provider network destinations

### Changed

- Reject private, link-local, metadata-service, multicast, reserved, unspecified, and other non-public provider destinations while retaining exact loopback support for local providers.
- Resolve every remote provider hostname before each request and reject the full destination when any DNS answer is unsafe.
- Pin outbound provider requests to a checked address while preserving the original HTTP host and TLS SNI, preventing a second DNS lookup from redirecting credentials or context to a different destination.
- Added early TypeScript validation for unsafe IP literals and authoritative Python coverage for literal addresses, mixed DNS results, localhost resolution, address pinning, and credential non-forwarding.

### Verification

- `npm run verify` — 165 extension tests and 81 backend tests passed; 20 cross-language contracts and 17 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-21 — Require HTTPS for remote provider endpoints

### Changed

- Reject remote plain-HTTP model-provider URLs in both profile validation and the Python provider boundary.
- Continue allowing HTTP for exact loopback providers, including local Ollama on `localhost`, `127.0.0.0/8`, and `::1`.
- Reject insecure stored profiles during parsing and prevent provider credentials from reaching the HTTP transport when the endpoint is unsafe.
- Documented HTTPS requirements and retained private-network/DNS protections as the next separate SSRF-hardening increment.

### Verification

- `npm run verify` — 164 extension tests and 75 backend tests passed; 20 cross-language contracts and 17 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-21 — Authenticate managed backend requests

### Changed

- Generate a new cryptographically random backend token for every managed backend process and keep it only in extension-host memory and the child-process environment.
- Require the token before handling `/health`, `/ask`, or `/ask/stream`, using constant-time comparison and a generic unauthorized response.
- Send backend authentication separately from provider credentials and refuse to collect workspace context when no authenticated managed backend is available.
- Reject unconfigured external listeners instead of adopting them, and invalidate the previous token when the backend is relaunched.
- Added lifecycle, transport, middleware, token-rotation, context-boundary, and shared-contract coverage.

### Verification

- `npm run verify` — 163 extension tests and 73 backend tests passed; 20 cross-language contracts and 17 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-20 — Verify the backend identity handshake

### Changed

- Added an explicit DevMate service identity, protocol version, and capability list to `/health`.
- Strictly decoded health data in the extension and rejected generic, malformed, incompatible, or incomplete listeners before treating them as healthy.
- Added shared TypeScript/Python contract checks and handshake characterization coverage.
- Documented that cryptographic request authentication remains the next security increment.

### Verification

- `npm run verify` — 160 extension tests and 71 backend tests passed; 16 cross-language contracts and 17 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-19 — Remove obsolete artifacts and compatibility remnants

### Changed

- Removed the old tracked release ZIP and excluded future ZIP archives from source control and VSIX packaging.
- Removed the obsolete component-merge ledger and source comments that only described already-completed file merges.
- Removed an unused legacy permission storage key and an unused webview CSS rule.
- Removed the temporary `DevMateChatViewProvider` re-export from the extension entry point and updated its characterization test to import the provider directly.

### Verification

- `npm run verify` — 154 extension tests and 71 backend tests passed; 13 cross-language contracts and 17 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-16 — Refactor chat provider responsibilities

### Changed

- Moved workspace identity, context collection, project retrieval orchestration, index persistence, and candidate reading into `src/workspaceContext.ts`.
- Moved file application and workspace mutation safety checks into `src/workspaceMutations.ts`, while keeping permission and diff presentation in the provider.
- Moved tool validation and execution, workspace reads and search, code navigation, terminal commands, dependency installation, and terminal-error capture into `src/toolExecutor.ts`.
- Moved provider streaming and retries, checkpointed run state, tool limits, duplicate-call handling, recovery, token accounting, and the model/tool loop into `src/agentRunController.ts`.
- Kept webview routing, native UI, profiles and SecretStorage, settings, permissions, session persistence, request preflight and finalization, diff presentation, and active-request ownership in `src/chatViewProvider.ts`.
- Established one-way dependencies from `chatViewProvider` through the extracted controller and services without importing the provider from lower-level modules.
- Added characterization coverage for project context, mutation safety, tool execution, resumed runs, checkpoints, retries, cancellation, signal and mutation-budget forwarding, and pending-turn preservation on failure.
- Documented the existing create/update symlink revalidation gap for a separate security-hardening change rather than altering behavior during extraction.
- Reduced `src/chatViewProvider.ts` from 4,918 lines to 2,141 lines without intentionally changing user-visible behavior.

### Verification

- `npm run verify` — 154 extension tests and 71 backend tests passed; 13 cross-language contracts and 17 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-16 — Extract the chat provider from the composition root

### Changed

- Moved `DevMateChatViewProvider` and its existing helpers from `src/extension.ts` to `src/chatViewProvider.ts` without changing their behavior.
- Reduced `src/extension.ts` from 5,001 lines to 89 lines containing activation, registrations, backend composition, and disposal wiring.
- Kept a compatibility re-export for the provider while consumers migrate.
- Updated source-based tests and architecture documentation for the new file boundary.

### Verification

- `npm run verify` — 142 extension tests and 71 backend tests passed; 13 cross-language contracts and 13 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-16 — Characterize pre-refactor behavior

### Changed

- Added behavioral coverage for session loading, legacy migration, and persistence through the extension host.
- Characterized active-file, selection, attachment, and current lexical-ranking behavior.
- Characterized webview ask routing, concurrent-request rejection, and checkpoint resume routing.
- Captured the exact agent request built from model settings, session history, and resumed checkpoint state.
- Added tool validation and dispatch coverage plus an explicit workspace-trust mutation boundary test.
- Added concurrent backend-start serialization and the exact six-turn backend conversation boundary.
- Exported the existing chat view provider as a test seam without changing its runtime behavior.

### Verification

- `npm run verify` — 142 extension tests and 71 backend tests passed; 13 cross-language contracts and 12 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-16 — Repair clean build and test verification

### Changed

- Added a cross-platform clean compile that removes `out` before emitting JavaScript.
- Switched extension tests to automatic Node test discovery supported by the declared runtime.
- Added one `npm run verify` command for TypeScript checks, clean extension tests, Python backend tests, TypeScript/Python contract checks, and emitted-file integrity.
- Added GitLab CI coverage for Node.js 20 and 24 plus the Python 3.10 backend.
- Added a backend test launcher that prefers the repository virtual environment.

### Fixed

- Updated 11 tests that still imported deleted source modules through orphaned compiled JavaScript.
- Removed the 22 obsolete JavaScript and source-map artifacts exposed by a clean build.

### Verification

- `npm run verify` — 134 extension tests and 70 backend tests passed; 13 cross-language contracts and 12 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-07-11 — Extract webview UI from the extension controller

### Changed

- Moved the webview HTML shell and Content Security Policy into `src/webview.ts`.
- Moved sidebar styles into `media/webview.css`.
- Moved browser-side chat state, rendering, and interactions into `media/webview.js`.
- Reduced `src/extension.ts` from approximately 9,400 lines to approximately 5,000 lines.
- Restricted webview local-resource access to the `media` directory.
- Updated webview tests to load and validate the separated UI assets.
- Updated the repository documentation and compiled extension output.

### Fixed

- Updated session file-change summary imports to use the consolidated `fileTools` module, restoring a clean TypeScript build.
- Removed trailing whitespace found during verification.

### Verification

- `npm run check`
- `npm test` — 134 tests passed
- `git diff --check`

---

## Entry template

Copy this section above the previous entry before each commit:

```markdown
## YYYY-MM-DD — Short change title

### Changed

- Describe user-visible or architectural changes.

### Fixed

- Describe corrected behavior, or remove this section when unused.

### Verification

- List the checks or tests that were run.
```
