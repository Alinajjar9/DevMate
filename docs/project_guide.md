# devmate project guide

## the two parts

devmate has an extension part and a backend part.

- the extension part creates the sidebar interface and works with vs code. this part knows which project is open, which file is active, what text is selected, which files have unsaved changes, whether the workspace is trusted, and what errors vs code currently knows about.
- the backend part receives a structured request from the extension, checks the request, builds messages for the model, calls the model provider, and streams the response back.
the backend is local. the local service then talks to the selected provider. provider keys are kept in vs code secret storage and are only forwarded through the loopback backend.

## seperate fastapi backend

backend is seperate because fastapi and pydantic make api models, validation, streaming, and provider errors clear to implement and test.
the backend also creates separation. model communication stays in one place while workspace control stays in the extension. the backend does not get a general path to the user computer and does not edit files itself.


## the three modes

- ideas mode is for discussion, planning, architecture, and explanation. it receives read only tools. it cannot change files or run verification commands.
- code mode is for implementation. it can inspect the project, create or edit files, move or delete files with permission, and run approved tests or checks.
- debug mode has access to similar tools as code mode, but its instruction is different. it should start from evidence, find the likely cause, make a small fix, and verify the result.
code and debug are therefore separated by working style rather than by a completely different tool list.

## the three scopes

- project scope searches the local project index for useful parts of the workspace. it is best when the task may involve several files.
- file scope focuses the initial context on the active editor file.
- selection scope focuses the initial context on highlighted text. the source file is still known, so the model understands where the selection came from.
attachments add supporting files. they are useful when the user knows that a test, configuration file, type definition, or related document matters. attachments do not lock the agent to those files.

## tools

tools are built in a structured request way from the model. it contains a tool name and arguments. for example, a read tool contains a relative file path and optional line range.
the model does not execute the tool. the extension receives the request, parses the arguments, checks paths and limits, performs the local operation, and returns a text result to the model.
read only tools can list files, read file ranges, search code, read symbols, find definitions, find references, read diagnostics, and read recent terminal failures.
mutation tools can create, edit, delete, rename, and move eligible text files. verification tools can run a limited set of test, lint, type check, and build commands.

## commands

full permision to shell is unsafe.
devmate instead uses a command registry. the executable and arguments are separate. only known verification patterns are allowed. shell operators, installation, generators, watchers, servers, git commands, and privilege changes are rejected this makes it less flexible but easier to control


## how file editing works

the edit tool does not normally replace a complete file. it sends one or more exact text replacements. each old text must appear exactly once in the current file.
this rule protects against stale or unclear edits. if the text is missing, the file may have changed. if it appears more than once, the location is ambiguous. the model must read a smaller range and try again with more specific text.
before applying a change, devmate checks that the file belongs to the workspace, is not protected, is not binary, is not too large, is not reached through a symbolic link, and does not have unsaved user changes.
the user can review the proposed diff before approval. after approval, devmate checks the file again in case it changed while the user was reading the diff.

## permissions

permissions are connected to the workspace. allowing file creation in one project does not automatically allow it in another project.
normal create and update choices can be set to ask or allow. destructive operations are treated more carefully and remain one time decisions.
commands can be allowed once or remembered as one exact command. the executable, arguments, directory, and workspace all matter. a small change creates a new permission request.
workspace trust is a higher level switch. if vs code does not trust the workspace, devmate does not mutate files or run commands even if an old preference says allow.

## project context and retrieval

it would be wasteful to send every project file with every question. devmate builds a local index of eligible text files and splits them into chunks.
when a question arrives, the question words are compared with chunk words and file paths. uncommon matching words receive more weight. file name matches are also useful. only a small number of high scoring chunks are included
this is called lexical retrieval. it is local and predictable. it works especially well for exact technical names. semantic retrieval with embeddings could understand broader meaning, but it would add another model, storage, and more complexity.

## a normal request from start to finish

- first, the user writes a question and sends it. the message is saved to the current session before the provider call starts.
- the extension makes sure the backend is online. it collects the selected scope, attachments, conversation history, model settings, and available tools.
- the backend validates the request and builds the model messages. it sends them to the chosen provider and streams progress back.
- if the model gives a final answer, devmate shows it and saves the completed turn.
- if the model asks for tools, the extension validates and executes them one by one. results return to the model. this loop can repeat through reading, editing, testing, reading a failure, repairing, and testing again.
- when the request finishes, devmate shows a short answer and a file change summary. clicking a changed file opens a native diff when the snapshot is still available.

## sessions

sessions are saved by vs code and tied to a workspace identity. this lets devmate show previous sessions without mixing projects.
only complete user and assistant turns are replayed to the model. the visible session can keep more information than the smaller bounded model history.
if a request fails, the user question still remains. if an agent run is interrupted after tool work, a checkpoint can offer to continue.

## model profiles

devmate includes a built in nemotron profile, but the api key still belongs to the user. other openai compatible profiles and ollama profiles can be added.
a profile stores normal connection information such as its name, model id, provider type, and base url. the secret key is stored separately.
provider compatibility is not always equal. some models support normal function tools well, some return tool calls as text, and some only describe what they plan to do. devmate has recovery rules, but it cannot completely fix a provider that does not follow the expected format.

## what is stored where

- model profiles and sessions use vs code storage.
- api keys use vs code secret storage.
- permissions and remembered command signatures use workspace storage.
- the project index uses extension storage and can be rebuilt from the workspace.
- the generated backend runtime and vsix are local release artifacts and are ignored by git.
- source code, test code, and private project notes are not included in the final vsix unless they are needed at runtime.



## limitations

- devmate currently uses the first workspace folder only.
- the project index is lexical, not semantic.
- language navigation depends on installed vs code language support.
- the embedded interface makes the main extension file large.
- the bundled backend must be built separately for each operating system and processor architecture.
- the quality of tool use and final answers still depends on the selected model provider.
- view port on different window sizes can be different

