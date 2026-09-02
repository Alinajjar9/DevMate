# DevMate project guide

This guide explains the submitted implementation. For installation and build commands, start with the [README](../README.md). For source files and implementation details, see the [technical reference](technical_reference.md).

## The two parts

DevMate has a VS Code extension and a local Python backend.

- The extension creates the chat interface and works with the open workspace. It knows the active file, selection, unsaved documents, workspace trust, diagnostics, and terminals. It also checks and executes the model's tools.
- The backend validates requests, builds model messages, calls providers, and returns answers or tool requests. It owns the local SQLite database for the project index and chat memory.

The backend is local, but the selected model provider may be remote. Chat profiles and embedding profiles have separate settings and keys. Keys are kept in VS Code SecretStorage, then forwarded through the authenticated local backend when needed.

The backend does not apply project edits or run project commands. Those actions stay in the extension, where VS Code state and permissions can be checked.

## Modes and scopes

Modes control the agent's working style and available tools:

- **Ideas:** discussion, planning, and explanation with read-only tools.
- **Code:** implementation, with permitted file changes and approved verification commands.
- **Debug:** evidence gathering, a focused fix, and verification. It has similar tools to Code, but different instructions.

Scopes control the initial context, not every file the agent may later inspect:

- **Project:** retrieve useful source excerpts from the current project.
- **File:** start with the active editor file.
- **Selection:** start with the highlighted text and its source location.

Attachments add supporting files to any scope. They do not restrict the agent to those files. Only the first workspace folder is supported.

## A normal request

1. The user sends a question. DevMate records the pending question in the current session.
2. The extension checks the managed backend's authentication, identity, protocol, and required capabilities.
3. It collects the selected scope and attachments, resolves the chat profile, and prepares the conversation context.
4. Older completed chat turns may be summarized automatically. The context planner then selects what fits in the input budget.
5. The backend validates the request and sends the messages to the selected model provider.
6. The provider either returns an answer or asks for tools. The extension validates and executes each allowed tool, then sends bounded results in the next model request.
7. When the run ends, DevMate shows the answer and actual file changes, and saves the completed turn. A changed-file link can open a native diff while its snapshot is available.

Each model call still receives a request containing the context it needs. The database does not make a remote model remember the workspace automatically. Retrieval and context planning reduce what is sent.

## Project search

DevMate indexes eligible text files locally. File hashes identify changes, and chunks keep their source paths and line positions. Document symbols are preferred for chunk boundaries when VS Code provides them; overlapping line chunks are the fallback.

The initial Project scope combines two kinds of retrieval:

- **Lexical search:** SQLite full-text search finds matching words and technical names. It works without an embedding model.
- **Semantic search:** an optional embedding model turns source chunks and the question into vectors. Similar vectors can find related code even when it uses different words.

The two result lists are combined by rank, with extra weight for exact identifiers and file paths. Only a bounded selection is included, and indexed matches are checked against current source before use. Missing or failed embeddings do not disable lexical search. A separate local lexical index is also available as a fallback.

The `search_code` tool used during an agent run is different: it currently performs a case-insensitive text search. Hybrid retrieval is implemented for automatic Project-scope context, not every search tool call.

## Embedding profiles

A coding model and an embedding model have different jobs. The coding model writes answers and chooses tools. The embedding model returns numeric vectors for retrieval; it does not write the answer.

DevMate supports configured Ollama and OpenAI-compatible embedding endpoints. No embedding model is bundled. Without an explicit selection, a configured local profile is preferred. A remote embedding endpoint requires explicit permission to receive source chunks and search queries. Selecting a chat model does not grant that permission.

Choose an actual embedding model supported by the endpoint. A model that only supports chat cannot be used merely by entering its ID in the embedding form. If setup is unavailable for the demo, leave embeddings unconfigured: lexical retrieval remains usable.

## Context budgeting and chat compaction

The context planner reserves space for the model's output and a 10% estimation margin. It uses the profile's context-window setting, or a conservative 32,000-token fallback when the size is unknown. The global maximum input setting is optional; `0` means Auto.

The latest question and explicit context take priority. Current tool state, recent chat, a compacted summary, project excerpts, and older tool results are then fitted into the remaining budget. The estimate uses character counts, not the model's exact tokenizer. If mandatory input does not fit, the request reports the problem instead of silently removing it.

Automatic compaction starts when estimated context demand reaches 75% of usable input capacity and enough completed turns are available. It keeps the latest four completed turns outside the summary. The summary records the goal, constraints, decisions, important files, completed work, open tasks, and unresolved questions.

Summaries belong to one chat. The active chat model creates them, and the backend validates and redacts the result before saving it. If compaction fails, the earlier summary is kept. Compaction itself does not delete transcript rows, but normal session size limits still apply. This is not an unlimited chat archive. There are no manual summary or pinned-memory controls in this submission.

## Tools, edits, and permissions

The model requests a tool by name and arguments. It does not execute the tool itself. The extension parses the request, checks limits and paths, asks for permission when required, and returns a bounded result.

Read-only tools can list files, read ranges, search text, inspect symbols and references, read diagnostics, and inspect recent terminal failures. Other tools can propose file changes, run allowed verification commands, or request supported dependency installation.

Most edits use exact text replacements. Each old-text match must occur exactly once, so a stale or ambiguous edit is rejected. Before applying a change, DevMate checks workspace trust, eligible paths, symbolic links, file size/type, and unsaved user changes. It rechecks the relevant state after approval because the file may have changed while the user reviewed the diff.

Create and update choices can be remembered for the current workspace. Delete, rename, move, and dependency installation remain one-time decisions. A remembered verification command matches the exact executable, arguments, working directory, and workspace. It does not grant general shell access.

`run_command` accepts only registered test, lint, type-check, and build patterns. Shell composition, Git commands, servers, watchers, privilege changes, and unrelated commands are rejected. Dependency installation has its own restricted tool and approval path.

## Sessions and recovery

Chats are stored through the local backend in SQLite and tied to a workspace identity. The visible transcript and the smaller history sent to the model are separate views of the conversation.

Session data is bounded: the extension keeps at most 20 sessions in its working set, up to 30 turns per session, and character limits. Long messages and old history can therefore be shortened. Do not use DevMate as the only copy of important notes.

An unfinished agent run can also save a checkpoint in VS Code workspace state. This stores bounded tool history and run counters, not a second full transcript. Resume is restricted to the original workspace and chat; malformed, oversized, or expired checkpoints are rejected.

## What is stored where

| Data | Location |
| --- | --- |
| Chat and embedding profiles | VS Code global state |
| Provider keys | VS Code SecretStorage |
| Permissions, exact command approvals, unfinished checkpoint | VS Code workspace state |
| Source chunks, full-text index, optional vectors | Private extension SQLite storage, outside the repository |
| Chat sessions, turns, and summaries | The same SQLite database, isolated by workspace/chat |
| Fallback lexical index | Extension workspace storage; rebuildable |
| Backend executable, compiled JavaScript, VSIX | Generated build output; not source to edit |

The database contains source text and chat content. Local storage is not the same as encryption or a guarantee that no data leaves the computer. Selected chat context goes to the configured chat provider, and optional remote embeddings send chunks and queries after opt-in.

## Submission limitations

- Only the first workspace folder is supported.
- Semantic retrieval needs a working embedding profile and a built index. It cannot guarantee the right file will always be found.
- Tool-driven `search_code` is still lexical.
- Token counts are estimates, and long chat retention is bounded.
- Definitions, references, and symbols depend on installed VS Code language support.
- Command tracking depends on supported terminal shell integration.
- The bundled backend is specific to the operating system and processor architecture on which it was built.
- Model tool use and reasoning controls vary by provider. A compatible HTTP API does not guarantee identical model behavior.
- Small-window layout and the chosen real provider should be checked before the presentation. See [known issues](known_bugs.md).

