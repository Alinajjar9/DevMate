# DevMate 1.0.0 — Quick Start

DevMate is a coding assistant for Visual Studio Code. This package is for **64-bit Windows** and includes its local backend, so Python and Node.js are not required to use the installed extension. A chat-model endpoint and any required account/API key must be configured separately; models are not bundled.

## Install

1. Open Visual Studio Code.
2. Open the Extensions view with `Ctrl+Shift+X`.
3. Click the `...` menu and choose **Install from VSIX...**.
4. Select `devmate-1.0.0-win32-x64.vsix`.
5. Reload VS Code if prompted.

You can also install it from a terminal:

```powershell
code --install-extension .\devmate-1.0.0-win32-x64.vsix --force
```

## Set up a model

1. Open a project folder in VS Code.
2. Click **DevMate** in the bottom status bar.
3. Open the model selector beside the Ask button.
4. Select Nemotron or add another compatible model.
5. Enter the provider API key when required.

API keys are stored with VS Code SecretStorage and are not written to project files.

## Optional semantic search

Chat models and embedding models have different jobs. The chat model answers and requests tools; the embedding model turns source chunks and search questions into vectors used to find related code.

1. Open **DevMate settings → Semantic code index**.
2. Add an embedding profile using an already installed local Ollama embedding model, or an OpenAI-compatible embedding endpoint.
3. Enter the embedding model ID, base URL, and a key if that endpoint needs one.
4. For a remote endpoint, explicitly allow it to receive project source-code chunks and search queries. Leave this unchecked if you do not want that transfer.
5. Select the profile and let the project index build before evaluating search quality.

No embedding model is downloaded automatically. Without a working embedding profile, search falls back to lexical retrieval. Hybrid search improves the initial **Project** context; the agent's `search_code` tool remains plain-text search. Search quality depends on the chosen embedding model.

## Use DevMate

- **Ideas** discusses approaches without changing files.
- **Code** implements changes and can run approved checks.
- **Debug** investigates and fixes problems.

Choose **Project**, **File**, or **Selection** to control the initial context. Use the attachment button to add supporting files.

Press `Enter` to send and `Shift+Enter` for a new line.

DevMate asks before file changes and commands unless an applicable remembered permission already allows them. Use **Review diff** before approving file changes. Editing and commands require a trusted workspace.

Chats and the project index are stored privately by VS Code, outside your project. Context budgeting and chat-summary compaction happen automatically. Compaction keeps retained raw turns, but session count, turn count, and text-size limits still apply; this is not an unlimited transcript archive.

## Short demo checklist

Use a disposable project with saved files and a working chat profile.

1. Ask a project question, then try a concept-based question with embeddings configured. Check that the cited source is relevant; synthetic tests do not prove a real model's search quality.
2. In that disposable project, select a test embedding profile with an unavailable loopback endpoint. Confirm ordinary project retrieval still works through lexical fallback, then restore the working embedding profile.
3. Request a small edit. Review its diff, deny it once, then approve a new request. Confirm only the approved change is applied.
4. Cancel a request while it is running. Confirm the UI becomes usable again.
5. Reload VS Code and reopen the chat. Confirm the saved turns are visible.
6. Narrow the sidebar and open settings/profile forms. Confirm the controls remain reachable by scrolling.

These live-provider/native-editor checks are separate from automated tests. They still need to be completed for this rebuilt version 1.0.0 before the presentation; the release notes list the automated checks completed for this build.

## Troubleshooting

- **Backend offline:** Open DevMate Settings and choose **Restart backend**. Check that port 8000 is free.
- **Model does not answer:** Check the API key, model ID, and base URL. Slow models may need a longer timeout.
- **Files cannot be edited:** Trust the workspace and save any unsaved files first.
- **Semantic search is unavailable:** Check the separate embedding profile, model ID, endpoint, and remote-transfer consent. Lexical retrieval remains available.
- **VSIX replacement fails with a locked-file error:** Save your work, close VS Code and allow any update to finish, then retry installation from an external terminal.

## Uninstall

Find DevMate in the Extensions view and choose **Uninstall**, or run:

```powershell
code --uninstall-extension local.devmate
```
