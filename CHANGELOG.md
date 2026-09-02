# DevMate Change Log

Record meaningful changes here before creating each commit. Keep the newest entry first and describe the result rather than listing every edited file.

## 2026-09-02 — Keep the complete chat request flow in one controller

### Changed

- Added one chat request controller for input validation, session and workspace checks, model access, backend authentication, context collection, chat compaction, agent execution, file-change completion, and saved responses.
- Kept the model/tool loop in `AgentRunController`, workspace writes in `WorkspaceMutations`, session data in `SessionController`, and cancellation ownership in `ChatViewProvider`.
- Connected the controller through grouped backend, context, profile, change, and event interfaces instead of giving it direct VS Code access.
- Moved request formatting and completion bookkeeping beside the workflow that uses them while preserving pending turns after failures and raw chat history after compaction.
- Added direct boundary tests for empty questions, missing model profiles and credentials, unsafe proposed changes, completed resumed runs, unauthenticated backends, and failed agent runs.
- Reduced `src/chatViewProvider.ts` from about 1,032 lines to about 769 lines without intentionally changing request behavior.

### Verification

- `npm run verify` — 376 extension tests and 164 backend tests passed; 67 cross-language contracts, 46 cycle-free TypeScript modules, and 46 emitted JavaScript modules verified.
- `git diff --check`

---

## 2026-09-02 — Keep settings UI flows in one presenter

### Changed

- Added one settings presenter for publishing the current settings screen, saving general preferences, saving agent-tool limits, and reporting validation or storage errors.
- Kept defaults, bounds, validation, and persistence in `SettingsController`, while the presenter adds workspace trust and remembered-command information for the UI.
- Connected workspace-trust changes and remembered-command changes to the same settings refresh path.
- Preserved the existing success messages, form-closing events, permission-policy refresh, and error levels.
- Added focused tests for current state, successful general and tool-setting saves, permission refresh, validation feedback, and storage failures.
- Reduced `src/chatViewProvider.ts` from about 1,056 lines to about 1,032 lines without intentionally changing settings behavior.

### Verification

- `npm run verify` — 372 extension tests and 164 backend tests passed; 67 cross-language contracts, 45 cycle-free TypeScript modules, and 45 emitted JavaScript modules verified.
- `git diff --check`

---

## 2026-09-02 — Keep permission UI flows in one presenter

### Changed

- Added one permission presenter for file and command prompts, decisions, diff reviews, cancellation, remembered-command changes, warnings, and typed UI updates.
- Kept permission state and persistence in `PermissionController` and kept native diff documents in `DiffPresenter`, with the new presenter coordinating the two through their public interfaces.
- Made `ChatViewProvider` use the presenter as its single permission interface for workspace mutations, tool commands, settings state, and webview routes.
- Preserved one-time approval when a saved preference fails and kept remembered commands from opening another approval prompt.
- Added focused tests for replaced requests, policy updates, missing diff previews, one-time command approval, remembered commands, storage failures, and cancellation.
- Reduced `src/chatViewProvider.ts` from about 1,177 lines to about 1,056 lines without intentionally changing permission behavior.

### Verification

- `npm run verify` — 367 extension tests and 164 backend tests passed; 67 cross-language contracts, 44 cycle-free TypeScript modules, and 44 emitted JavaScript modules verified.
- `git diff --check`

---

## 2026-09-02 — Keep unfinished agent runs in one controller

### Changed

- Added one checkpoint controller for validated loading, active workspace and chat matching, persistence, cleanup, and small UI-ready checkpoint summaries.
- Kept agent-loop execution in `AgentRunController` and kept typed message delivery in `ChatViewProvider` behind narrow callbacks.
- Connected completed runs, new runs, resumed runs, and deleted chats to the same checkpoint lifecycle.
- Preserved recoverable in-memory state when a save fails and preserved cleanup in memory when stored-state removal fails, while reporting the existing warnings.
- Added focused tests for workspace and chat isolation, expired state, token summaries, saving, cleanup, session deletion, and storage failures.
- Reduced `src/chatViewProvider.ts` from about 1,227 lines to about 1,177 lines without intentionally changing agent-resume behavior.

### Verification

- `npm run verify` — 360 extension tests and 164 backend tests passed; 67 cross-language contracts, 43 cycle-free TypeScript modules, and 43 emitted JavaScript modules verified.
- `git diff --check`

---

## 2026-09-02 — Keep session UI flows in one presenter

### Changed

- Added one session presenter for synchronization, creation, project-safe selection, rename and delete dialogs, session summaries, and restored chat-message formatting.
- Kept the in-memory store and ordered persistence in `SessionController`, while `ChatViewProvider` continues to own active requests and agent-checkpoint storage.
- Preserved the rule that sessions cannot change during an active request and rechecks that rule after native rename and delete dialogs close.
- Kept checkpoint cleanup connected to session deletion through one narrow callback.
- Added focused tests for session state formatting, synchronization, missing workspaces, active-request blocking, project ownership, rename races, and confirmed deletion.
- Reduced `src/chatViewProvider.ts` from about 1,344 lines to about 1,227 lines without intentionally changing session behavior.

### Verification

- `npm run verify` — 353 extension tests and 164 backend tests passed; 67 cross-language contracts, 42 cycle-free TypeScript modules, and 42 emitted JavaScript modules verified.
- `git diff --check`

---

## 2026-09-02 — Keep profile UI flows in one presenter

### Changed

- Added one profile presenter for model and embedding pickers, forms, selection, deletion, intelligence controls, typed UI state, and readable status messages.
- Kept profile validation, persistence, active selection, and credentials in the existing model and embedding controllers.
- Kept active model access in `ChatViewProvider` for request construction while routing all profile UI commands through the presenter.
- Preserved the built-in Nemotron API-key prompt and the rule that intelligence cannot change during an active request.
- Added focused tests for model state formatting, intelligence blocking, built-in key setup, form errors, successful model saves, and embedding selection and deletion.
- Reduced `src/chatViewProvider.ts` from about 1,546 lines to about 1,344 lines without intentionally changing profile behavior.

### Verification

- `npm run verify` — 347 extension tests and 164 backend tests passed; 67 cross-language contracts, 41 cycle-free TypeScript modules, and 41 emitted JavaScript modules verified.
- `git diff --check`

---

## 2026-09-01 — Keep file attachments in one controller

### Changed

- Added one attachment controller for selected-file state, native workspace file picking, path filtering, selection limits, candidate validation, removal, and attachment updates.
- Kept project-context collection and webview message delivery in `ChatViewProvider`, passing only the validated attachment URIs into `WorkspaceContext`.
- Preserved the existing status messages and kept the previous selection when the picker is cancelled, workspace listing fails, or too many files are selected.
- Continued to revalidate selected files for supported content and size before they become chat context.
- Added focused tests for missing workspaces, filtering and sorting, validation, ignored files, removal, selection limits, and listing failures.
- Reduced `src/chatViewProvider.ts` from about 1,642 lines to about 1,546 lines without intentionally changing attachment behavior.

### Verification

- `npm run verify` — 341 extension tests and 164 backend tests passed; 67 cross-language contracts, 40 cycle-free TypeScript modules, and 40 emitted JavaScript modules verified.
- `git diff --check`

---

## 2026-09-01 — Keep VS Code diff handling in one presenter

### Changed

- Added one diff presenter for virtual diff documents, pending permission reviews, completed file-change snapshots, path lookup, and native VS Code diff editors.
- Kept permission decisions, expired-snapshot warnings, workspace-file fallback, and webview routing in `ChatViewProvider`.
- Preserved completed snapshots across requests while keeping the existing limit of forty snapshots and clearing request-specific path links at the start of a new request.
- Kept `ChatViewProvider` as the registered text-document provider through a one-line delegate, so extension activation and the diff URI scheme remain compatible.
- Added focused tests for pending reviews, completed and renamed-file titles, request cleanup, snapshot limits, and disposal.
- Reduced `src/chatViewProvider.ts` from about 1,772 lines to about 1,642 lines without intentionally changing diff behavior.

### Verification

- `npm run verify` — 335 extension tests and 164 backend tests passed; 67 cross-language contracts, 39 cycle-free TypeScript modules, and 39 emitted JavaScript modules verified.
- `git diff --check`

---

## 2026-09-01 — Move permission decisions out of the chat view

### Changed

- Added one permission controller for file-change policy, remembered commands, pending file and command approvals, replacement, cancellation, and decision rules.
- Kept native diff documents, VS Code diff editors, webview messages, and user-facing warnings in `ChatViewProvider`.
- Kept the controller independent from VS Code and the webview through a small workspace-state interface.
- Made failed “always allow” persistence fall back to the approved one-time action and return a readable warning state instead of leaving its promise unfinished.
- Added focused tests for safe saved-state parsing, file-policy updates, remembered-command shortcuts, non-rememberable commands, replacement, cancellation, revocation, clearing, and storage failures.
- Reduced `src/chatViewProvider.ts` from about 1,810 lines to about 1,772 lines without intentionally changing normal permission behavior.

### Verification

- `npm run verify` — 331 extension tests and 164 backend tests passed; 67 cross-language contracts, 38 cycle-free TypeScript modules, and 38 emitted JavaScript modules verified.
- `git diff --check`

---

## 2026-09-01 — Move chat session state out of the chat view

### Changed

- Added one session controller that owns the in-memory session store, loaded state, local revisions, pending saves and deletes, synchronization, and the serialized repository write queue.
- Moved create, select, rename, delete, pending-question, completed-turn, and model-history operations behind that controller.
- Kept session dialogs, project warnings, webview event formatting, active-request rules, and agent-checkpoint presentation in `ChatViewProvider`.
- Kept storage failures as simple controller events so the controller does not import VS Code or display UI itself.
- Added focused tests for initial loading, failed writes, write ordering, session lifecycle operations, pending-turn completion, and slow-load protection for newer local state.
- Reduced `src/chatViewProvider.ts` from about 1,968 lines to about 1,810 lines without intentionally changing session behavior.

### Verification

- `npm run verify` — 324 extension tests and 164 backend tests passed; 67 cross-language contracts, 37 cycle-free TypeScript modules, and 37 emitted JavaScript modules verified.
- `git diff --check`

---

## 2026-09-01 — Move settings logic out of the chat view

### Changed

- Added one settings controller for general DevMate preferences and the six bounded agent-tool limits.
- Moved configuration defaults, normalization, validation, reading, and persistence behind a small interface that does not import VS Code or the webview.
- Made agent requests, checkpoint status, and the settings UI read the same normalized configuration state.
- Kept permission decisions, remembered commands, command routing, and user-facing messages in `ChatViewProvider`.
- Reused the controller's settings types in the validated webview protocol instead of maintaining duplicate form types.
- Added focused tests for defaults, bounds, explicit and Auto context limits, permission-policy persistence, tool settings, invalid values, and write failures.
- Reduced `src/chatViewProvider.ts` from about 2,130 lines to about 1,970 lines without intentionally changing valid user settings or UI behavior.

### Verification

- `npm run verify` — 321 extension tests and 164 backend tests passed; 67 cross-language contracts, 36 cycle-free TypeScript modules, and 36 emitted JavaScript modules verified.
- `git diff --check`

---

## 2026-09-01 — Move model profile management out of the chat view

### Changed

- Added one model-profile controller for stored profiles, active selection, reasoning preferences, credential access, validation, and create, edit, and delete operations.
- Kept the controller independent from VS Code and the webview through a small persistence interface, while `ChatViewProvider` still owns UI routing and presentation.
- Kept API keys in SecretStorage and made the controller return readable results instead of displaying UI messages itself.
- Reused one model-profile form type across the controller and the validated webview protocol.
- Added focused tests for built-in and custom profiles, API-key handling, provider changes, reasoning preferences, deletion cleanup, fallback selection, and persistence failures.
- Reduced `src/chatViewProvider.ts` from about 2,358 lines to about 2,130 lines without intentionally changing user-visible behavior.

### Verification

- `npm run verify` — 316 extension tests and 164 backend tests passed; 67 cross-language contracts, 35 cycle-free TypeScript modules, and 35 emitted JavaScript modules verified.
- `git diff --check`

---

## 2026-08-23 — Type messages sent to the chat UI

### Changed

- Added one discriminated union for all 32 extension-to-webview events in the existing webview protocol module.
- Replaced `postMessage(message: unknown)` with a typed sender, so incorrect event names and payloads now fail during TypeScript compilation.
- Kept related session, profile, permission, settings, token, and tool-activity view data together instead of creating one interface or file per event.
- Made restored assistant-session messages explicitly retain their `assistant` role while checking the new contract.
- Added a drift test confirming that `media/webview.js` handles exactly the event commands declared by the TypeScript protocol.
- Kept browser-side behavior and rendered UI unchanged.

### Verification

- `npm run verify` — 309 extension tests and 164 backend tests passed; 67 cross-language contracts, 34 cycle-free TypeScript modules, and 34 emitted JavaScript modules verified.
- `git diff --check`

---

## 2026-08-23 — Validate messages from the chat UI

### Changed

- Moved every webview-to-extension command shape and form submission type into `src/webviewProtocol.ts`.
- Decode messages from `unknown` before routing them instead of trusting a TypeScript annotation at the webview boundary.
- Reject unknown commands, invalid enum values, non-finite settings, malformed nested forms, and unexpected fields.
- Added table-driven coverage for every supported UI command plus malformed-message cases.
- Kept command handling and request ownership in `ChatViewProvider`, reducing it from roughly 2,422 lines to 2,357 lines without splitting the router across callback-heavy files.
- Kept valid chat UI behavior unchanged.

### Verification

- `npm run verify` — 308 extension tests and 164 backend tests passed; 67 cross-language contracts, 34 cycle-free TypeScript modules, and 34 emitted JavaScript modules verified.
- `git diff --check`

---

## 2026-08-23 — Group the project search code

### Changed

- Grouped project chunking, the local project index, result ranking, and retrieval under `src/projectSearch/`.
- Updated extension consumers, tests, and the cross-language contract checker to use the new explicit module paths.
- Kept indexing synchronization, workspace scanning, scheduling, and file watching outside the folder because they manage extension lifecycle rather than search algorithms.
- Avoided adding a barrel or controller file, so each import still shows the exact search responsibility it uses.
- Changed only file organization and import paths; search, indexing, and fallback behavior remain the same.

### Verification

- `npm run verify` — 306 extension tests and 164 backend tests passed; 67 cross-language contracts, 33 cycle-free TypeScript modules, and 33 emitted JavaScript modules verified.
- `git diff --check`

---

## 2026-08-23 — Remove the TypeScript import cycle

### Changed

- Moved shared agent tool names, groups, and call types into a small dependency-free protocol module.
- Kept `agentTools.ts` as a compatibility façade so existing callers and tests do not need a risky all-at-once migration.
- Made the API contract layer own its simple reasoning and embedding-provider types instead of importing feature modules back into the API layer.
- Updated direct protocol consumers and the TypeScript/Python contract checker to use the new boundary.
- Added an import-cycle check to the normal verification command so future circular dependencies fail early.
- Removed the only TypeScript dependency cycle without changing tool behavior, profile behavior, or backend requests.

### Verification

- `npm run verify` — 306 extension tests and 164 backend tests passed; 67 cross-language contracts, 33 cycle-free TypeScript modules, and 33 emitted JavaScript modules verified.
- `git diff --check`

---

## 2026-08-23 — Require structured verification commands

### Changed

- Removed the old mini parser for free-form `run_command` strings and string-based argument lists.
- Made the extension accept only the current `{ executable, args, cwd, timeoutSeconds }` command shape already declared by the backend tool schema.
- Rejects unknown command fields instead of silently accepting compatibility aliases.
- Added a simple comment explaining why commands stay structured and renamed one misleading legacy-labelled test.
- Audited agent checkpoints and tool-history omission markers but kept them because checkpoint resume is current behavior and marker rejection protects file writes.

### Verification

- `npm run verify` — 306 extension tests and 164 backend tests passed; 67 cross-language contracts and 32 emitted JavaScript modules verified.
- `git diff --check`

---

## 2026-08-23 — Remove the old Nemotron profile migration

### Changed

- Removed the startup migration that searched for pre-release custom Nemotron profiles, copied their API keys, rewrote the active profile, and deleted the old entries.
- Removed the profile-equivalence helper and test that existed only for that migration.
- Added a simple comment explaining that only custom profiles are stored and the permanent built-in profile is added when profiles are read.
- Kept the built-in Nemotron profile, its API-key setup, reasoning controls, and deletion protection unchanged.
- Kept the JSON project index because it is still used when authenticated SQLite retrieval is unavailable or stale.

### Verification

- `npm run verify` — 306 extension tests and 164 backend tests passed; 67 cross-language contracts and 32 emitted JavaScript modules verified.
- `git diff --check`

---

## 2026-08-23 — Remove unused manual memory code

### Changed

- Removed the manual summary save and clear API routes, TypeScript client functions, response parsers, and request types because the extension never called them.
- Removed the unfinished pinned-memory table, repository methods, limits, and unused context priority because no production feature supplied or read pinned memories.
- Kept automatic summary generation, summary loading, raw chat turns, and prompt compaction unchanged.
- Simplified the affected API, repository, schema, and context-planner tests to cover only behavior the application uses.

### Verification

- `npm run verify` — 307 extension tests and 164 backend tests passed; 67 cross-language contracts and 32 emitted JavaScript modules verified.
- `git diff --check`

---

## 2026-08-23 — Keep compiled extension output out of source control

### Changed

- Added the generated `out` directory to `.gitignore` and documented the main ignore groups in simple English.
- Removed compiled JavaScript and source maps from the tracked project files. Development, tests, and VSIX packaging continue to generate them when needed.
- Kept clean-output verification in place so stale or missing emitted modules are still detected during a full verification run.
- Added a short readability guideline for focused modules and useful plain-English comments.

### Verification

- `npm run verify` — 309 extension tests and 166 backend tests passed; 67 cross-language contracts and 32 emitted JavaScript modules verified.
- `npm run clean`

---

## 2026-08-23 — Use compact chat memory in agent requests

### Changed

- Loads the current validated summary before every fresh or resumed agent run and reuses the summary returned by automatic compaction without an extra backend request.
- Sends bounded recent exact turns after the stored compaction boundary while retaining the previous raw-history fallback when summary loading fails.
- Added compacted summaries to the context planner below current operation state and recent exact conversation but above retrieved project chunks.
- Added a strict optional structured-memory field to the TypeScript and Python ask contracts.
- Renders compacted memory as a delimited untrusted-data block in the current user context rather than as system instructions.
- Preserves cancellation behavior and lets the main request continue with raw history when local memory is unavailable.
- Intentionally omitted manual Compact, View Summary, Reset Summary, and Pin Memory controls for the university-project scope.

### Verification

- Focused memory loading, context planning, session-boundary, prompt, API, and extension integration coverage passed.
- `npm run verify` — 309 extension tests and 166 backend tests passed; 67 cross-language contracts and 32 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Compact long chats automatically

### Changed

- Added a focused automatic compaction controller that measures the full un-compacted chat, current question, collected code context, and previous summary against the selected model's usable input budget.
- Starts compaction at 75% of usable input capacity and selects a completed-turn boundary that always leaves the latest four completed turns verbatim.
- Loads the existing summary before generation so an up-to-date boundary is never regenerated and later compactions include only newly eligible turns.
- Runs compaction before a new agent request with the active model settings and authenticated provider access.
- Treats cancellation as cancellation of the active request while logging storage or provider failures and allowing the main request to continue.
- Exposed the context planner's full pre-trimming estimate for threshold decisions without changing which context is currently sent to the model.
- Kept compacted-summary prompt inclusion out of this step so its ordering and budgeting can be reviewed independently.

### Verification

- Focused compaction, context-planning, and extension integration coverage — 37 tests passed.
- `npm run verify` — 307 extension tests and 164 backend tests passed; 67 cross-language contracts and 32 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Generate safe compact chat summaries

### Changed

- Added an on-demand compaction service that asks the active chat model to merge the previous structured summary with only the newly eligible completed turns.
- Sends a bounded, untrusted transcript payload without tools or thinking and strictly accepts only the expected JSON summary structure.
- Redacts common credential patterns and validates the generated summary before atomically replacing the previous version.
- Preserves the previous summary and every raw turn when the provider fails, returns invalid output, or targets an invalid compaction boundary.
- Added an authenticated compaction endpoint and a loopback-only TypeScript client with strict request and response validation.
- Kept automatic threshold triggering and summary prompt inclusion out of this step so they can be reviewed independently.

### Verification

- Focused compaction and authenticated memory API coverage — 14 backend tests passed.
- Focused TypeScript API client coverage — 72 tests passed.
- `npm run verify` — 299 extension tests and 164 backend tests passed; 67 cross-language contracts and 31 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Add secure storage access for compact chat summaries

### Changed

- Added shared bounded contracts for structured chat summaries containing the goal, constraints, decisions and reasons, important files, completed work, open tasks, and unresolved questions.
- Added authenticated `chat-memory-v1` endpoints to save, load, and clear one session summary through the existing transactional SQLite repository.
- Keeps raw turns unchanged when summaries are written or removed and accepts compaction boundaries only at completed turns.
- Returns an explicit `null` when a chat has no summary so absence remains unambiguous across the Python and TypeScript boundary.
- Added loopback-only TypeScript client operations with strict response decoding and request matching for session, boundary, timestamp, and content.
- Added the summary version and size limits to cross-language contract verification.
- Kept model-based summary generation, automatic compaction triggers, prompt inclusion, and manual UI controls out of this step.

### Verification

- Focused authenticated summary API coverage — 7 backend tests passed.
- `npm run verify` — 297 extension tests and 157 backend tests passed; 67 cross-language contracts and 31 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Store chats directly in SQLite

### Changed

- Made the private SQLite chat store the only persistent source for the current workspace's conversations.
- Added a focused session repository that strictly converts between UI sessions and the authenticated `chat-memory-v1` API.
- Loads chats after the managed backend is verified and saves created, renamed, pending, and completed sessions directly to SQLite.
- Serializes writes so a slower older save cannot overwrite newer turns, while retaining failed writes in memory for the next backend reconnect.
- Deletes evicted and user-deleted sessions directly from SQLite and keeps the active UI selection in memory.
- Removed the VS Code session keys, legacy v1 conversion, migration markers, verified-copy reconciliation, dual-write mirror, and their obsolete tests.
- Existing pre-release chats in VS Code state are intentionally ignored rather than migrated because there are no released user histories to preserve.

### Verification

- Focused repository, provider, session, and webview coverage — 55 tests passed.
- `npm run verify` — 292 extension tests and 155 backend tests passed; 63 cross-language contracts and 31 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Keep new chat changes mirrored locally

### Changed

- Added a serialized session mirror that runs only after the existing VS Code session state has saved successfully.
- Mirrors created, renamed, pending, and completed chat sessions to the authenticated SQLite API while mirroring confirmed session deletions separately.
- Defers work while the backend is offline or lacks `chat-memory-v1`, coalesces intermediate snapshots behind an active write, and resumes after backend readiness.
- Saves only changed sessions after the initial mirror instead of rewriting every stored chat for each new message.
- Stops automatic retry loops after a failed local write while retaining the latest snapshot and deletions for the next session change or backend reconnect.
- Reconciles session identifiers removed from the rollback store before advancing the verified migration marker.
- Kept VS Code storage as the live read source and rollback fallback; SQLite reads, prompt history, summaries, and compaction remain unchanged.

### Verification

- Focused migration, mirror, and provider-boundary coverage — 36 tests passed.
- `npm run verify` — 306 extension tests and 155 backend tests passed; 63 cross-language contracts and 32 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Safely copy existing chats into local storage

### Changed

- Added a versioned migration coordinator that converts the already-validated VS Code session store into the strict chat-memory snapshot contract.
- Copies all existing sessions in one authenticated SQLite batch and reads every saved snapshot back before recording migration completion.
- Stores only a source fingerprint, session identifiers, and completion time in the migration marker; chat contents are not duplicated into VS Code migration metadata.
- Rechecks a marked database copy on startup and safely refreshes it if the private database was removed or no longer matches.
- Leaves failed and cancelled migrations unmarked and retryable without modifying the existing conversation-session storage.
- Starts migration only after authenticated backend readiness and only when `chat-memory-v1` is advertised.
- Kept the VS Code session store as the live source of truth and left chat loading, saving, deletion, prompt history, summaries, and compaction behavior unchanged.

### Verification

- Focused migration coverage — 10 tests passed.
- `npm run verify` — 295 extension tests and 155 backend tests passed; 63 cross-language contracts and 31 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Add a secure chat-memory API

### Changed

- Added versioned cross-language contracts for chat-session metadata, ordered raw turns, file-change summaries, atomic save batches, workspace lists, loads, and deletion.
- Added authenticated `/memory/v1` backend routes with stable validation, unavailable-store, missing-session, and internal-memory error codes.
- Made multi-session saves one SQLite transaction so a failed migration batch cannot leave a partial imported session set.
- Advertised the optional `chat-memory-v1` backend capability without requiring or activating the feature in the existing chat UI.
- Added loopback-only TypeScript client methods that require the managed backend token and strictly reject malformed, unknown-field, wrong-session, and wrong-workspace responses.
- Kept existing VS Code session persistence, chat loading, prompt construction, summaries, and compaction behavior unchanged.

### Verification

- Focused backend chat-memory API coverage — 5 tests passed.
- Focused API client coverage — 65 tests passed.
- `npm run verify` — 285 extension tests and 155 backend tests passed; 63 cross-language contracts and 30 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Add the local chat-memory foundation

### Changed

- Added a backward-compatible second SQLite migration for chat sessions, raw turns, structured summaries, and pinned memories in the private DevMate store.
- Kept chat history independent from code-index workspace rows so index rebuilds and deletion cannot remove conversations.
- Added a bounded transactional repository for session snapshots, pending-turn completion, ordered workspace session lists, validated structured summaries, and session-scoped pinned memories.
- Preserved raw turns when summaries are saved and cascaded only chat-owned records when a session is deleted.
- Composed the repository with the managed backend while leaving the live VS Code session store, existing chats, model requests, and compaction behavior unchanged.
- Added migration-upgrade, isolation, validation, cascade, pending-turn, pin-limit, and transaction-rollback coverage.

### Verification

- Focused chat-memory and knowledge-store coverage — 15 tests passed.
- `npm run verify` — 278 extension tests and 150 backend tests passed; 49 cross-language contracts and 29 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Budget context before every model request

### Changed

- Connected the context planner to every agent-loop provider request using the selected profile window, global input cap, configured output reserve, and ten-percent safety margin.
- Reserved 4,000 estimated tokens for backend instructions and tool definitions before selecting variable request context.
- Kept the current question plus explicit selections, active files, and attachments mandatory, and stopped before contacting the model with a clear error when that required input could not fit.
- Prioritized current tool state and newest completed chat turns before ranked project results and older tool output.
- Preserved every tool-call shell and replaced only omitted result text with a bounded marker, maintaining valid provider tool history and checkpoint behavior.
- Replanned each agent pass as new tool results arrived while leaving stored raw session history and retrieved source unchanged.
- Kept pinned memory, generated summaries, chat-database migration, and automatic compaction unchanged for later milestones.

### Verification

- Focused planner, agent-loop, tool-history, and conversation coverage — 48 tests passed.
- `npm run verify` — 278 extension tests and 142 backend tests passed; 49 cross-language contracts and 29 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Configure model context limits

### Changed

- Added an optional validated context-window size to custom chat-model profiles, with blank values retaining the conservative Auto fallback.
- Preserved context-window metadata through profile normalization, storage parsing, editing, and the model picker while safely ignoring malformed optional values from old or corrupted storage.
- Added a global **Maximum input context** setting with a blank Auto state represented as `0` in VS Code configuration.
- Bounded both controls from 1,024 to 4,000,000 tokens for model windows and from 128 to 4,000,000 tokens for explicit input caps.
- Kept built-in provider metadata locked and kept API keys in SecretStorage; these settings introduce no new credential or provider payload fields.
- Kept live request construction unchanged so configured limits are persisted but not enforced until the next context-planning milestone.

### Verification

- Focused planner, profile, settings-persistence, and webview coverage — 59 tests passed.
- `npm run verify` — 272 extension tests and 142 backend tests passed; 49 cross-language contracts and 29 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Lay the foundation for context budgeting

### Changed

- Added a pure context-budget planner with a conservative 32,000-token fallback for models whose input capacity is unknown.
- Reserved configured output capacity before calculating the input budget and applied a ten-percent safety margin for token-estimation uncertainty.
- Allowed future model-specific context windows and user input caps without adding or changing settings in this milestone.
- Defined one deterministic priority order for instructions, the current question, explicit context, operation state, pinned memory, recent conversation, compacted summaries, project results, and older tool output.
- Kept mandatory input even when it exceeds the budget and reported the overflow instead of silently dropping the user's question or required instructions.
- Kept the planner disconnected from live request construction so this commit introduces no prompt, session, retrieval, or UI behavior change.

### Verification

- Focused context-budget and priority coverage — 7 tests passed.
- `npm run verify` — 268 extension tests and 142 backend tests passed; 49 cross-language contracts and 29 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Prioritize filenames and code identifiers

### Changed

- Added query-aware ranking after Reciprocal Rank Fusion so explicitly named files, matching path terms, and exact code identifiers can move precise results above nearby conceptual matches.
- Capped the combined query-signal boost so it refines the lexical and semantic rankings without replacing strong cross-strategy agreement.
- Applied the same normalized rank scale when only lexical or semantic search succeeds, preserving deterministic fallback behavior while allowing precise query signals to help.
- Moved rank fusion and query-signal scoring into the focused `src/projectSearchRanking.ts` module so retrieval orchestration remains separate from ranking policy.
- Kept identifier matching language-neutral and local to the already retrieved bounded chunks; this step adds no database schema, provider request, or language-server dependency.
- Kept diagnostic retrieval modes, configurable ranking weights, context budgeting, and chat compaction unchanged for later milestones.

### Verification

- Focused project ranking and retriever coverage — 12 tests passed.
- `npm run verify` — 261 extension tests and 142 backend tests passed; 49 cross-language contracts and 28 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Combine semantic and exact code search

### Changed

- Replaced semantic-first project retrieval with equal-weight Reciprocal Rank Fusion over semantic cosine and SQLite lexical result positions.
- Started semantic and lexical searches together so lexical lookup does not wait for the embedding provider before beginning.
- Deduplicated chunks found by both strategies, rewarded cross-strategy agreement, retained semantic-only conceptual matches, and used deterministic tie ordering.
- Preserved raw lexical or semantic ordering whenever only one strategy is available instead of unnecessarily rewriting its scores.
- Kept cancellation terminal and retained exact-source rereads, stale-chunk rejection, per-file diversity, bounded context selection, and the legacy JSON fallback.
- Kept filename, path, and symbol boosts, diagnostic retrieval modes, context budgeting, and chat compaction unchanged for later milestones.

### Verification

- Focused hybrid retrieval and project-context coverage — 22 tests passed.
- `npm run verify` — 257 extension tests and 142 backend tests passed; 49 cross-language contracts and 27 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Search project code by meaning

### Changed

- Added a query-time semantic-search service that embeds one bounded question and exactly compares it with every compatible cached workspace vector using cosine similarity.
- Added an authenticated, capability-gated semantic-search API with strict request and response models; embedding-provider credentials remain in the bounded provider-key header and are never returned.
- Clarified that remote embedding consent covers both bounded source-code chunks and semantic search queries.
- Connected Project scope to the selected embedding profile and semantic backend capability while preserving SQLite lexical search and the JSON index as ordered fallbacks.
- Reread and hash-validated every semantic result against current workspace source before including it in model context, rejecting stale chunks just like lexical results.
- Kept search cancellation terminal, limited result counts, paged vector reads, bounded in-memory ranking, and deterministic tie ordering.
- Kept hybrid rank fusion, filename and symbol boosts, retrieval modes, context budgeting, and chat compaction unchanged for later milestones.

### Verification

- Focused semantic service, API, client, and retrieval coverage — 79 tests passed.
- `npm run verify` — 256 extension tests and 142 backend tests passed; 49 cross-language contracts and 27 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Manage code embedding profiles in settings

### Changed

- Added separate settings controls for creating, editing, selecting, and deleting Ollama and OpenAI-compatible embedding profiles without mixing them with chat-model profiles.
- Added an isolated profile controller for validated persistence, preferred-profile selection, SecretStorage access, deletion cleanup, and best-effort rollback after storage failures.
- Kept provider credentials out of profile state and displayed only whether the selected profile already has a stored key.
- Required an explicit source-code transfer checkbox for non-loopback embedding endpoints while keeping local Ollama as the new-profile default.
- Refreshed background embedding generation when the active profile, its configuration, or its credential changes, without repeating lexical synchronization.
- Added bounded host-side validation for every form field and embedding credential instead of trusting browser validation.
- Kept query embeddings, cosine ranking, hybrid retrieval, and chat-context planning unchanged.

### Verification

- Focused profile-controller, scheduler, and webview coverage — 38 tests passed.
- `npm run verify` — 247 extension tests and 136 backend tests passed; 47 cross-language contracts and 27 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Schedule code embedding generation in the extension

### Changed

- Added a separate extension-host scheduler that starts only after the authenticated lexical workspace index finishes in a fully ready state.
- Selected the explicitly active validated embedding profile, otherwise preferring a configured local Ollama profile, and read only the selected profile's credential from SecretStorage.
- Required the backend's optional `embedding-index-v1` capability before scheduling any embedding request.
- Generated at most 32 code embeddings in each one-batch request and continued incomplete indexes through delayed, independently cancellable calls.
- Cancelled active and pending embedding work when source files, the workspace, backend access, or backend authentication changed.
- Stopped cleanly for missing profiles, unsupported backends, provider failures, and completed indexes without creating an automatic failure-retry loop.
- Kept query embeddings, semantic ranking, hybrid retrieval, and embedding-profile UI behavior unchanged.

### Verification

- Focused scheduler, API-client, synchronization, and watcher coverage — 73 tests passed.
- `npm run verify` — 240 extension tests and 136 backend tests passed; 47 cross-language contracts and 26 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Add the extension client for embedding indexing

### Changed

- Added shared TypeScript request and response types for bounded embedding-index synchronization.
- Added strict runtime decoding for embedding progress and active vector configuration, including exact fields, numeric limits, cross-field consistency, and agreement with the requested profile, provider, model, and vector version.
- Added a loopback-only authenticated client method with cancellation and a configurable 150-second default timeout.
- Forwarded embedding provider credentials only through the bounded provider-key header and kept them out of request JSON.
- Kept automatic scheduling, embedding-profile selection, vector generation during normal use, and semantic retrieval disconnected for the next step.
- Added cross-language checks for seven embedding limits plus client coverage for successful transport, malformed responses, remote-backend refusal, invalid credentials, timeout, and cancellation.

### Verification

- Focused API-client coverage — 52 tests passed.
- `npm run verify` — 233 extension tests and 136 backend tests passed; 47 cross-language contracts and 25 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Expose authenticated embedding indexing to the extension

### Changed

- Added a strictly validated `POST /index/v1/embeddings/synchronize` backend route for bounded, resumable workspace embedding generation.
- Kept provider credentials out of JSON by accepting the embedding key only through the existing bounded provider-key header and never returning it in results.
- Reused the backend-token middleware so unauthenticated requests are rejected before profile validation, workspace lookup, source loading, or provider access.
- Composed the safe embedding client, resumable indexing service, and SQLite embedding repository automatically when the private knowledge store is available.
- Returned bounded progress, completion, and active vector-configuration data while mapping missing workspaces, unavailable storage, provider failures, and invalid vectors to stable existing error envelopes.
- Advertised `embedding-index-v1` as an optional backend capability while retaining the previous required capability set until the TypeScript client begins using this route.
- Added route coverage for authentication, strict inputs, credential handling, successful indexing, completed-index no-ops, app composition, missing storage and workspaces, provider failures, and malformed batches.
- Kept extension-host scheduling, profile UI changes, query embeddings, semantic ranking, and user-visible project retrieval unchanged.

### Verification

- Focused embedding API, service, client, and backend API coverage — 71 backend tests passed.
- `npm run verify` — 221 extension tests and 136 backend tests passed; 40 cross-language contracts and 25 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Generate code embeddings in resumable batches

### Changed

- Added a backend indexing service that connects the bounded embedding-provider protocol to the workspace-isolated SQLite embedding repository without exposing an HTTP route yet.
- Discovered vector dimensions from the first real source batch, then activated the exact profile, provider, model, dimension, and vector version before storing results.
- Processed only chunks missing vectors and committed every successful batch separately so provider errors, cancellation, or process restarts resume without repeating completed work.
- Limited each invocation by batch count, chunk count, and total source characters so later background scheduling can remain responsive.
- Rebuilt incompatible workspace vectors when a provider returns changed dimensions and retained exact content-hash validation across the provider-call race window.
- Added coverage for bounded continuation, provider failure, cancellation, stale source, dimension changes, malformed batches, empty workspaces, completed indexes, and request-size limits.
- Kept API routes, extension-host scheduling, semantic query ranking, and user-visible retrieval behavior unchanged in this step.

### Verification

- Focused embedding service, repository, provider-client, and provider-contract coverage — 26 backend tests passed.
- `npm run verify` — 221 extension tests and 132 backend tests passed; 40 cross-language contracts and 25 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Add the SQLite embedding repository

### Changed

- Added a separate workspace-isolated repository for embedding persistence without enlarging the existing file, chunk, metadata, and lexical repository.
- Added explicit activation and reset operations for one embedding profile, provider, model, dimension, and vector version per workspace; activating a changed configuration removes incompatible cached vectors.
- Added bounded discovery of chunks that still need vectors and retained their exact paths, source, hashes, line ranges, and stable identifiers for later provider orchestration.
- Added atomic content-hash-checked writes that reject stale targets, duplicate chunks, invalid dimensions, non-finite values, and vectors that are not normalized.
- Stored vectors as normalized little-endian float32 blobs and added bounded cursor-based reads for the future exact cosine-similarity stage.
- Preserved file-replacement, deletion, and workspace cascade cleanup so changed source is automatically requeued instead of leaving orphaned vectors.
- Kept provider execution, HTTP routes, background embedding jobs, and semantic retrieval disconnected in this step.

### Verification

- `npm run verify` — 221 extension tests and 123 backend tests passed; 40 cross-language contracts and 25 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-23 — Add safe embedding provider clients

### Changed

- Added bounded batch clients for native Ollama `/api/embed` and OpenAI-compatible `/embeddings` endpoints.
- Reused the existing HTTPS, loopback, DNS-resolution, address-pinning, redirect, timeout, and provider-error safeguards instead of creating a separate network trust path.
- Required backend-side remote-provider consent before DNS resolution or source transfer, even when a caller previously validated the embedding profile.
- Disabled silent Ollama input truncation and requested explicit floating-point output from OpenAI-compatible providers.
- Strictly validated response models, batch counts, OpenAI indexes, dimensions, numeric values, and nonzero vectors; restored request order and normalized every accepted vector to unit length.
- Kept the clients disconnected from HTTP routes, profile UI, SQLite writes, indexing, and retrieval so semantic search remains inactive in this step.

### Verification

- `npm run verify` — 221 extension tests and 118 backend tests passed; 40 cross-language contracts and 25 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-22 — Prepare configurable embedding providers

### Changed

- Added separate validated embedding profiles for Ollama and OpenAI-compatible providers without coupling them to chat-model profiles.
- Preferred explicitly selected profiles and otherwise local Ollama-compatible profiles, while requiring HTTPS and explicit consent before a remote endpoint may receive source code.
- Added profile-specific SecretStorage keys and kept API keys out of persisted profile objects.
- Extracted the existing provider URL checks into one shared security policy used by both chat and embedding profiles without changing chat-profile behavior.
- Added a narrow backend protocol for ordered batch embedding requests and results, with matching provider names checked across TypeScript and Python.
- Kept the new foundation inactive: this step adds no UI, provider network calls, vector writes, semantic ranking, or retrieval behavior changes.

### Verification

- `npm run verify` — 221 extension tests and 108 backend tests passed; 40 cross-language contracts and 25 emitted JavaScript files verified.
- `git diff --check`

---

## 2026-08-22 — Use SQLite for project code search

### Changed

- Connected Project scope to the authenticated SQLite FTS5/BM25 search API through the existing replaceable `ProjectRetriever` boundary.
- Added lazy JSON fallback for missing authentication, empty or failed searches, unavailable files, and stale indexed chunks; successful SQLite searches no longer refresh the legacy index on every request.
- Reread selected workspace files through the bounded symlink-safe source boundary and verified chunk hashes, line ranges, current paths, exclusions, and file diversity before adding source to model context.
- Forwarded request cancellation through context collection and prevented cancelled SQLite searches from starting an expensive fallback scan.
- Measured 7/11 top-one hits, 7/11 top-three hits, 0.6364 mean reciprocal rank, and 0.6364 recall at five on the shared corpus, compared with the legacy retriever's 5/11, 7/11, 0.5455, and 0.6364.
- Kept embeddings and semantic ranking out of this step; synonym-heavy conceptual queries remain documented misses for the next retrieval milestone.

### Verification

- `npm run verify` — 214 extension tests and 106 backend tests passed; 39 cross-language contracts and 23 emitted JavaScript files verified.
- Focused retrieval, context, synchronization, and workspace-source coverage — 31 extension tests and 1 backend evaluation test passed.
- `git diff --check`

---

## 2026-08-22 — Split indexed code around real symbols

### Changed

- Added symbol-aware SQLite chunking that prefers validated VS Code document-symbol boundaries while keeping every chunk within the existing size limit.
- Preserved complete source coverage and retained the overlapping line-based chunker whenever symbols are missing, invalid, excessive, or unavailable.
- Requested language-provider symbols only after a file fingerprint changes and revalidated file size, modification time, regular-file type, and parent links around the request.
- Added unique ordinal-qualified chunk identifiers and advanced the SQLite chunking version to 2 so existing indexes rebuild once with the new layout.
- Kept the active chat retriever on its existing JSON lexical index; this change improves the SQLite data prepared for later lexical and semantic retrieval.
- Added focused coverage for preferred boundaries, unsafe-range fallback, provider failure, nested and cross-file symbols, unchanged-file skips, and exact source preservation.

### Verification

- `npm run verify` — 210 extension tests and 105 backend tests passed; 39 cross-language contracts and 23 emitted JavaScript files verified.
- Focused chunking, synchronization, source, and watcher coverage — 26 tests passed.
- `git diff --check`

---

## 2026-08-22 — Keep the SQLite code index updated while files change

### Changed

- Added a workspace-change monitor for relevant create, edit, delete, rename, and workspace-folder events.
- Debounced rapid event bursts into one synchronization and guaranteed one trailing run when changes arrive during active indexing.
- Started synchronization immediately when authenticated backend access becomes available, cancelled active work when access is lost, and resumed safely after token replacement.
- Filtered ignored, generated, binary, and out-of-workspace paths before scheduling work while preserving the full reconciliation scan as the correctness boundary.
- Kept indexing in the background and left the current chat retrieval path on the existing JSON lexical index.
- Added deterministic coverage for event coalescing, active-run changes, cancellation, token replacement, path filtering, rename events, watcher rebuilding, and disposal.

### Verification

- `npm run verify` — 205 extension tests and 105 backend tests passed; 39 cross-language contracts and 22 emitted JavaScript files verified.
- Focused indexing synchronization, source, and watcher coverage — 15 tests passed.
- `git diff --check`

---

## 2026-08-22 — Synchronize workspace files into the SQLite index

### Changed

- Added a cancellable initial synchronization that starts in the background after the authenticated managed backend comes online.
- Scanned the first local workspace with the existing project exclusions and size limits, rejected symbolic-link paths, and revalidated files immediately around each read.
- Added stable workspace identities, SHA-256 file fingerprints, complete bounded-file chunking, and chunk-version rebuilds.
- Compared each scan with the stored SQLite snapshot and sent only changed files and known deletions in batches that respect the shared API limits.
- Preserved previously indexed content when a path cannot be read, exposed ready, stale, indexing, and failed states, and left chat retrieval on the existing JSON lexical index.
- Added focused coverage for initial and incremental synchronization, deletions, unavailable and binary files, rebuilds, batching, cancellation, failures, Windows path casing, and symbolic-link safety.

### Verification

- `npm run verify` — 201 extension tests and 105 backend tests passed; 39 cross-language contracts and 21 emitted JavaScript files verified.
- Focused synchronization and workspace-source coverage — 11 tests passed.
- `git diff --check`

---

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
