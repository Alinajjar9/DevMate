# technical reference

## architecture

```text
webview
  -> typescript extension
  -> local fastapi backend
  -> model provider

model tool request
  -> extension validation
  -> permission when required
  -> local action
  -> bounded result back to model
```

the backend does not edit files or run commands. local actions are done by the extension.


## main components

| component | responsibility |
| --- | --- |
| `src/extension.ts` | activation, registrations, and dependency composition |
| `src/chatViewProvider.ts` | messages, request preflight/finalization, sessions, diffs, settings, and permission presentation |
| `src/agentRunController.ts` | provider retries, checkpointed agent-loop policy, recovery, and tool iteration |
| `src/toolExecutor.ts` | validated tool dispatch, workspace inspection, terminal execution, and mutation routing |
| `src/workspaceContext.ts` | workspace identity, scope collection, file candidates, and project-index orchestration |
| `src/workspaceMutations.ts` | file application, trust and symlink checks, and pre-apply revalidation |
| `src/webview.ts` | csp-protected webview shell and packaged asset urls |
| `media/webview.css` | sidebar layout and visual styles |
| `media/webview.js` | browser-side state, rendering, and interactions |
| `src/backendManager.ts` | starts, checks, restarts, and stops the local backend |
| `src/agentTools.ts` | tool types, parsing, limits, duplicate detection, compact history |
| `src/fileTools.ts` | file arguments and exact replacements |
| `src/commandTools.ts` | allowed verification-command registry |
| `src/projectIndex.ts` | local chunk index and lexical retrieval |
| `src/sessions.ts` | project-bound session state |
| `src/permissions.ts` | workspace file policies and remembered commands |
| `src/api/client.ts` | backend requests and streamed events |
| `backend/app/main.py` | fastapi routes, request schemas, and tool definitions |
| `backend/app/prompts.py` | system messages and mode instructions |
| `backend/app/providers.py` | provider requests, streaming, errors, and token usage |

## startup

1. vs code calls `activate` in `src/extension.ts`.
2. `LocalBackendManager` checks `devMate.backendUrl`.
3. it generates an in-memory token, starts the managed backend with that token, and accepts `/health` only when both authentication and the service/protocol/capability handshake succeed.
4. source development falls back to a configured or local python environment.
5. `DevMateChatViewProvider` registers the dedicated sidebar view.


## request flow

1. `handleMessage` receives the user request.
2. `answerQuestion` saves the user turn and checks the backend.
3. `WorkspaceContext.collectScope` gathers project, file, selection, and attached-file context.
4. `AgentRunController` builds the bounded model request and `askStream` sends it with the separate backend token to `/ask/stream`.
5. the backend validates `AskRequest`, builds messages, and calls the provider.
6. final text ends the request.
7. `ToolExecutor.execute` validates and executes requested tool calls.
8. tool results are added to bounded history and sent in the next provider request.
9. the completed answer and file summary are saved to the session.

## modes

| mode | behavior |
| --- | --- |
| ideas | read-only planning and explanation |
| code | implementation followed by verification |
| debug | evidence, cause, focused fix, and verification |

code and debug use similar tools. their backend instructions are different.

## scopes

| scope | initial context |
| --- | --- |
| project | relevant chunks from the local index |
| file | current active document |
| selection | highlighted text and its source file |
| attachments | explicit supporting files added to any scope |

## tools

read-only:
- `list_files`
- `read_file`
- `search_code`
- `get_symbols`
- `find_definition`
- `find_references`
- `get_diagnostics`
- `read_terminal_errors`

mutating or executable:
- `create_file`
- `edit_file`
- `delete_file`
- `rename_file`
- `move_file`
- `install_dependencies`
- `run_command`




## important safety rules

- mutations and commands require a trusted workspace
- paths must remain inside the first workspace folder
- protected, binary, oversized, and symbolic-link targets are rejected
- dirty documents are not edited
- approved proposals are checked again for stale content
- delete, rename, move, and dependency installation require one-time approval
- remembered commands use the exact executable, arguments, directory, and workspace
- `run_command` only accepts registered verification commands
- model context, tool output, and provider errors are bounded
- api keys use vs code `SecretStorage`

## permissions and workspace trust

permission data is in `src/permissions.ts`. create and update preferences are stored in workspace state, not globally. remembered command approvals are also limited to the current workspace.

```text
model requests a local action
             |
             v
validate workspace, path, arguments, and limits
             |
             v
      action allowed instantly?
          /              \
        yes               no
         |                 |
         |                 v
         |          show permission card
         |            /          \
         |         deny          allow
         |           |             |
         v           v             v
execute safely   return denial   revalidate current state
                                      |
                                      v
                                 execute safely
```

the second validation after approval protects against stale changes. for example, a file may have changed while the user was reading its diff.
file changes appear as permission cards inside the chat. a user can deny, allow once, or remember supported create and update behavior.
command approvals use an exact normalized signature. the signature contains the executable, arguments, and working directory. changing any part produces a different command and requires a new decision.
workspace trust is checked again near the actual mutation or command. this matters because trust could change while a permission card is waiting.


## file edits

`edit_file` sends sequential exact replacements. `applyExactReplacements` requires every old text value to occur exactly once.
`confirmAndApplyFileChanges`:
1. reads the current file
2. builds the proposed content
3. shows permission and diff review when required
4. checks the file again after approval
5. applies a `WorkspaceEdit`
6. saves the document and records snapshots

## commands

`validateVerificationCommand` permits selected test, lint, type-check, and build commands.
it rejects shells, command composition, git, installation, servers, watchers, generators, deployment, privilege changes, interpreter evaluation, and writable formatters.
full command output remains in a dedicated terminal. bounded sanitized output is returned to the model.


## context retrieval

`WorkspaceContext` finds eligible project files and coordinates the local index stored in extension workspace storage.
project files are filtered and split into overlapping line aware chunks by `src/projectIndex.ts`.
`retrieveProjectChunks` ranks chunks using words, identifiers, paths, and bm25-style scoring. the current system is lexical, not embedding-based.

## sessions and recovery

sessions contain workspace identity, messages, and completed file summaries. sessions cannot silently move between projects.
unfinished tool work can be stored as an agent checkpoint. checkpoints contain bounded history, counters, used files, signatures, workspace revision, and timestamps.

## the agent loop

`answerQuestion` in `src/chatViewProvider.ts` performs request preflight and finalization. the checkpointed provider/tool loop is in `AgentRunController.run`.

```text
question and project context
          |
          v
send request to the provider
          |
          v
   final answer available? ---- yes ----> save the turn and finish
          |
          no
          |
          v
validate requested tools
          |
          v
run or reject each tool
          |
          v
save a bounded tool result
          |
          +-----------------------------> next provider request
```

the provider validates the question, saves a new user turn, selects the active model, ensures the backend is healthy, collects context, and loads settings and the api key. it then passes an immutable input to the controller, which restores checkpoint state when a request is being resumed.
the loop sends a request and waits for one of two useful results. the first result is a final answer. the second result is a list of tool calls.
when tool calls arrive, the extension normalizes workspace paths and `ToolExecutor` validates every call with `parseAgentToolCall` from `src/agentTools.ts`. it checks call ids, arguments, path rules, ranges, maximum results, replacement counts, command data, and tool-specific limits before dispatching local work.
the controller separately checks total tool calls, file mutations, verification commands, dependency installations, repeated signatures, and consecutive inspection calls. `agentToolCallSignature` creates a stable signature for duplicate detection. `consecutiveAgentInspectionCalls` helps stop a model that keeps reading without acting.
after a tool finishes, its bounded result is added to tool history and sent back to the model on the next loop. large results are shortened by `truncateAgentToolResult` and old history can be compacted by `compactAgentToolHistory`.
the loop continues until the model gives a final answer, a limit is reached, the user cancels, or a non-recoverable error occurs. when the model cannot produce a final answer after useful tool work, `summarizeAgentToolHistory` can build an honest local summary instead of losing the work.
## checkpoints and recovery
agent checkpoint validation is in `src/sessions.ts`. a checkpoint stores the question, mode, scope, bounded tool history, used files, tool signatures, counters, workspace revision, recovery flags, token usage, and timestamps.
the extension saves this state during tool work. if the webview reloads or a long request is interrupted, it can offer to continue from the saved state. old, oversized, malformed, duplicated, or cross-workspace checkpoint data is rejected.


## local storage
| data | storage |
| --- | --- |
| model profiles | vs code global storage |
| api keys | vs code `SecretStorage` |
| sessions | vs code global storage with workspace identity |
| permissions | vs code workspace storage |
| project index | extension workspace storage |
| backend runtime | generated `backend-runtime` directory |

## main settings

| setting | default |
| --- | ---: |
| `devMate.backendUrl` | `http://127.0.0.1:8000` |
| `devMate.manageLocalBackend` | `true` |
| `devMate.requestTimeoutSeconds` | `900` |
| `devMate.commandTimeoutSeconds` | `300` |
| `devMate.toolCallLimit` | `16` |
| `devMate.readFileMaxLines` | `400` |
| `devMate.maxTokens` | `16384` |
| `devMate.temperature` | `0.2` |



## short file map

- `package.json`: extension metadata, settings, commands, and scripts
- `src/extension.ts`: extension activation, registrations, and dependency composition
- `src/chatViewProvider.ts`: chat lifecycle, preflight/finalization, sessions, permissions, settings, and UI forwarding
- `src/agentRunController.ts`: provider retries, checkpoint state, recovery, limits, and agent-loop policy
- `src/toolExecutor.ts`: validated tool dispatch, workspace inspection, terminals, and mutation routing
- `src/workspaceContext.ts`: workspace identity, context collection, attachments, and project-index orchestration
- `src/workspaceMutations.ts`: file writes, lifecycle operations, and workspace safety checks
- `src/webview.ts`: webview html shell, csp, and packaged asset urls
- `media/webview.css`: sidebar layout and visual styles
- `media/webview.js`: browser-side chat state, rendering, and interactions
- `src/backendManager.ts`: backend startup, monitoring, restart, and shutdown
- `src/agentTools.ts`: tool types, parsing, limits, history, and duplicate signatures
- `src/fileTools.ts`: file tool arguments and exact replacements
- `src/commandTools.ts`: safe verification command registry
- `src/projectIndex.ts`: chunking, persistence, and lexical retrieval
- `src/sessions.ts`: project-bound session storage
- `src/permissions.ts`: file policies and remembered command approvals
- `src/api/client.ts`: local backend http and streaming client
- `backend/app/main.py`: fastapi routes, schemas, tool definitions, and response validation
- `backend/app/prompts.py`: mode instructions and message construction
- `backend/app/providers.py`: provider requests, streaming, errors, and token usage
- `backend/app/text_tool_calls.py`: strict textual tool-call compatibility parser
- `backend/run_backend.py`: standalone backend entry point
- `scripts/build-backend.js`: pyinstaller build script
- `tests`: typescript-side tests
- `backend/tests`: python-side tests



## where to make common changes

- for sidebar layout and visual styles, use `media/webview.css`.
- for chat behavior, settings dialogs, tool cards, and browser-side state, use `media/webview.js`; the html shell and csp live in `src/webview.ts`.
- for extension message handling, request preflight, and final response presentation, use `handleMessage` and `answerQuestion` in `src/chatViewProvider.ts`.
- for provider retries, checkpointed run state, recovery, limits, and model/tool iteration, use `src/agentRunController.ts`.
- for tool names, arguments, bounds, duplicate signatures, and compact history, use `src/agentTools.ts`.
- for validated tool dispatch, workspace reads, code navigation, terminal execution, and mutation routing, use `src/toolExecutor.ts`.
- for exact replacement behavior, use `src/fileTools.ts`.
- for applying file changes and enforcing trust, symlink, dirty-document, and pre-apply checks, use `src/workspaceMutations.ts`.
- for allowed verification commands, use `src/commandTools.ts` and update its tests at the same time.
- for dependency installation execution, use `src/toolExecutor.ts`; manifest validation rules live in `src/agentTools.ts`.
- for workspace scope collection and index orchestration, use `src/workspaceContext.ts`; for chunking and lexical scoring, use `src/projectIndex.ts`.
- for model profile validation and reasoning choices, use `src/llmProfiles.ts`.
- for sessions and project binding, use `src/sessions.ts`.
- for backend lifecycle behavior, use `src/backendManager.ts`.
- for backend request schemas and tool definitions, use `backend/app/main.py`.
- for system messages and mode behavior, use `backend/app/prompts.py`.
- for provider payloads, streaming, token usage, and provider errors, use `backend/app/providers.py`.
- when a shared request field changes, check both `src/api/types.ts` and the pydantic models in `backend/app/main.py`.
