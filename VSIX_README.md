# DevMate — Quick start

DevMate brings a coding assistant into VS Code. It can explain your project, suggest changes, and run approved checks. This package is for **64-bit Windows** and includes its backend, so you do not need to install Python.

## Install

You need VS Code 1.96.2 or later.

1. Open the Extensions view with **Ctrl+Shift+X**.
2. Open the **...** menu and choose **Install from VSIX...**.
3. Select `devmate-1.0.0.vsix` and reload VS Code if prompted.

You can also install it from a terminal:

```powershell
code --install-extension .\devmate-1.0.0.vsix --force
```

## Connect a model

Open a project folder, then click **DevMate** in the status bar. Open the model selector beside the Ask button. Choose the built-in Nemotron profile or add an OpenAI-compatible or Ollama profile.

For a remote provider, enter its model ID, base URL, and your API key as needed. Use HTTPS for a remote base URL. For Ollama, start the local service and install the model before selecting it in DevMate.

API keys are kept in VS Code SecretStorage, not in project files. Your chosen provider receives the question and the code or tool context needed for the request.

## Ask your first question

Try **Ideas** mode with a question such as “What does this project do, and where does it start?”

- **Ideas** helps you understand code and plan changes. It has read-only tools.
- **Code** can make changes and run approved checks.
- **Debug** helps investigate and fix a problem.

Choose **Project**, **File**, or **Selection** for the starting context, or attach supporting files. Press **Enter** to send and **Shift+Enter** for a new line. **Cancel** stops a request.

DevMate asks before changing files by default. Open **Review diff** to see a proposed edit. Workspace settings can allow file creation or updates automatically, and you can remember approval for an exact verification command. Delete, rename, move, and dependency installation always need a fresh approval. File changes and commands require a trusted workspace.

## If something does not work

- **The backend is offline:** Open DevMate settings and choose **Restart backend**. Click the backend status indicator for logs, and check whether another service is using port 8000.
- **The model does not answer:** Check the key, model ID, and base URL. For a slow model, increase the provider timeout in settings.
- **A file cannot be changed:** Trust the workspace and save the affected file. A file that changed while you were reviewing it may need a new proposal.
- **A command cannot run:** Use a terminal with VS Code Shell Integration. DevMate only supports selected verification commands, such as tests and builds.

Tool support varies between models. Project search uses words and filenames, so selecting or attaching a relevant file can help when the assistant misses it.

## Uninstall

Find DevMate in the Extensions view and choose **Uninstall**, or run:

```powershell
code --uninstall-extension local.devmate
```
