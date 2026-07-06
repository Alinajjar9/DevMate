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
| `src/extension.ts` | webview, messages, agent loop, local tool execution, diffs, permissions |
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
3. it uses an existing healthy backend or starts a bundled runtime.
4. source development falls back to a configured or local python environment.
5. `DevMateChatViewProvider` registers the dedicated sidebar view.


## request flow

1. `handleMessage` receives the user request.
2. `answerQuestion` saves the user turn and checks the backend.
3. `collectScope` gathers project, file, selection, and attached-file context.
4. `askStream` sends the request to `/ask/stream`.
5. the backend validates `AskRequest`, builds messages, and calls the provider.
6. final text ends the request.
7. tool calls are parsed by `parseAgentToolCall` and executed by `runAgentTool`.
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

project files are filtered, split into overlapping line aware chunks, and stored in extension workspace storage.
`retrieveProjectChunks` ranks chunks using words, identifiers, paths, and bm25-style scoring. the current system is lexical, not embedding-based.

## sessions and recovery

sessions contain workspace identity, messages, and completed file summaries. sessions cannot silently move between projects.
unfinished tool work can be stored as an agent checkpoint. checkpoints contain bounded history, counters, used files, signatures, workspace revision, and timestamps.

## the agent loop

the main agent loop is inside `answerQuestion` in `src/extension.ts`.

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

this loop at the beginning it validates the question, saves a new user turn, selects the active model, ensures the backend is healthy, collects context, loads the api key, reads settings, and restores an agent checkpoint when a request is being resumed.
the loop sends a request and waits for one of two useful results. the first result is a final answer. the second result is a list of tool calls.
when tool calls arrive, the extension normalizes workspace paths and validates every call with `parseAgentToolCall` from `src/agentTools.ts`. it checks call ids, arguments, path rules, ranges, maximum results, replacement counts, command data, and tool-specific limits.
the extension also checks total tool calls, file mutations, verification commands, dependency installations, repeated signatures, and consecutive inspection calls. `agentToolCallSignature` creates a stable signature for duplicate detection. `consecutiveAgentInspectionCalls` helps stop a model that keeps reading without acting.
after a tool finishes, its bounded result is added to tool history and sent back to the model on the next loop. large results are shortened by `truncateAgentToolResult` and old history can be compacted by `compactAgentToolHistory`.
the loop continues until the model gives a final answer, a limit is reached, the user cancels, or a non-recoverable error occurs. when the model cannot produce a final answer after useful tool work, `summarizeAgentToolHistory` can build an honest local summary instead of losing the work.
## checkpoints and recovery
agent checkpoint validation is in `src/agentCheckpoint.ts`. a checkpoint stores the question, mode, scope, bounded tool history, used files, tool signatures, counters, workspace revision, recovery flags, token usage, and timestamps.
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
- `src/extension.ts`: main extension controller, webview, tools, permissions, and agent loop
- `src/backendManager.ts`: backend startup, monitoring, restart, and shutdown
- `src/agentTools.ts`: tool types, parsing, limits, history, and duplicate signatures
- `src/fileTools.ts`: file tool arguments and exact replacements
- `src/commandTools.ts`: safe verification command registry
- `src/projectContext.ts`: file filtering and simple project ranking
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

- for sidebar layout, chat behavior, settings dialogs, tool cards, and browser-side state, start in `getHtml` inside `src/extension.ts`.
- for extension message handling and the complete agent request loop, use `handleMessage` and `answerQuestion` in `src/extension.ts`.
- for tool names, arguments, bounds, duplicate signatures, and compact history, use `src/agentTools.ts`.
- for exact replacement behavior, use `src/fileTools.ts`.
- for allowed verification commands, use `src/commandTools.ts` and update its tests at the same time.
- for dependency installation rules, use `src/dependencyTools.ts`.
- for project retrieval and chunk scoring, use `src/projectIndex.ts` and `src/projectContext.ts`.
- for model profile validation and reasoning choices, use `src/llmProfiles.ts`.
- for sessions and project binding, use `src/sessions.ts`.
- for backend lifecycle behavior, use `src/backendManager.ts`.
- for backend request schemas and tool definitions, use `backend/app/main.py`.
- for system messages and mode behavior, use `backend/app/prompts.py`.
- for provider payloads, streaming, token usage, and provider errors, use `backend/app/providers.py`.
- when a shared request field changes, check both `src/api/types.ts` and the pydantic models in `backend/app/main.py`.
