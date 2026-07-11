# DevMate 1.0 — Quick Start

DevMate is a coding assistant for Visual Studio Code. This package is for **64-bit Windows** and includes its local backend, so Python is not required.

## Install

1. Open Visual Studio Code.
2. Open the Extensions view with `Ctrl+Shift+X`.
3. Click the `...` menu and choose **Install from VSIX...**.
4. Select `devmate-1.0.0.vsix`.
5. Reload VS Code if prompted.

You can also install it from a terminal:

```powershell
code --install-extension .\devmate-1.0.0.vsix --force
```

## Set up a model

1. Open a project folder in VS Code.
2. Click **DevMate** in the bottom status bar.
3. Open the model selector beside the Ask button.
4. Select Nemotron or add another compatible model.
5. Enter the provider API key when required.

API keys are stored with VS Code SecretStorage and are not written to project files.

## Use DevMate

- **Ideas** discusses approaches without changing files.
- **Code** implements changes and can run approved checks.
- **Debug** investigates and fixes problems.

Choose **Project**, **File**, or **Selection** to control the initial context. Use the attachment button to add supporting files.

Press `Enter` to send and `Shift+Enter` for a new line.

DevMate asks before changing files or running commands. Use **Review diff** before approving file changes. Editing and commands require a trusted workspace.

## Troubleshooting

- **Backend offline:** Open DevMate Settings and choose **Restart backend**. Check that port 8000 is free.
- **Model does not answer:** Check the API key, model ID, and base URL. Slow models may need a longer timeout.
- **Files cannot be edited:** Trust the workspace and save any unsaved files first.

## Uninstall

Find DevMate in the Extensions view and choose **Uninstall**, or run:

```powershell
code --uninstall-extension local.devmate
```
