# DevMate

DevMate is a coding assistant that works inside VS Code. You can ask it about your project, discuss an approach, or let it propose a change and run a check. It uses the files you select as context and can look up more code when needed.

This is the lexical version developed on `component` and prepared for submission on `abgabe`. Project search uses words and filenames, with a local JSON index. You do not need an embedding model or a database.

## Try the extension

If you have `devmate-1.0.0.vsix`, follow the [installation guide](VSIX_README.md). The supplied Windows x64 package includes the Python backend.

After installation, open a project folder and click **DevMate** in the status bar. You can also use **DevMate: Open Chat** from the Command Palette. Open the model selector beside the Ask button and choose Nemotron, an OpenAI-compatible provider, or a local Ollama model. Add your own API key if the provider needs one.

A useful first question is: “Explain how this project starts and which files I should read first.” Start in **Ideas** mode, which can inspect code without changing it.

| Mode | When to use it |
| --- | --- |
| Ideas | Understand code or work through a plan. |
| Code | Make a change and check the result. |
| Debug | Investigate a problem and try a focused fix. |

Choose **Project** for relevant excerpts from the first workspace folder, **File** for the active file, or **Selection** for the code you have highlighted. The attachment button lets you add up to five supporting files. These choices set the starting context; the assistant can still request more files through its tools.

Press **Enter** to send and **Shift+Enter** for a new line. **Cancel** stops the current request. If a run has a saved checkpoint, **Continue** can resume it.

File changes ask for approval by default. Use **Review diff** to inspect a proposed edit. You can allow file creation or updates automatically for the current workspace, or remember an exact verification command. Delete, rename, move, and dependency installation still need approval each time. Changes and commands require a trusted workspace.

API keys are saved in VS Code SecretStorage. A remote model provider receives your question, selected code, recent conversation, and relevant tool results. Use HTTPS when setting up a remote provider. See [known issues](docs/known_issues.md) for the current limits.

## Run from source

You need VS Code 1.96.2 or later, Node.js 20 or later, npm 9 or later, and Python 3.10 or later. These instructions use Windows PowerShell:

```powershell
npm ci
py -m venv .venv
.venv\Scripts\python -m pip install -r backend\requirements-dev.txt
```

Open the repository in VS Code and press **F5** to run `Run DevMate Extension`. VS Code compiles the extension and opens an Extension Development Host. Open DevMate there to start using it. The backend starts automatically.

During development, DevMate uses the project virtual environment unless `backend-runtime/` contains a built backend. That executable takes priority, so rebuild it with `npm run build:backend` after changing Python code if it already exists.

On macOS or Linux, create the environment with `python3 -m venv .venv` and use `.venv/bin/python` instead of `.venv\Scripts\python`. Development and local testing have mainly been on Windows.

## Settings and help

The gear button opens DevMate settings. You can change timeouts, the tool-call limit, and model output settings there. The same settings are available under `devMate` in VS Code.

- **Backend offline:** Click its status indicator to open the logs. Try **Restart backend** in DevMate settings and check whether port 8000 is already in use.
- **No model response:** Check the API key, model ID, and base URL. For Ollama, make sure the service is running and the model is installed. A slow model may need a longer timeout.
- **An edit is refused:** Check workspace trust and save the affected file. DevMate also rejects unsupported paths, ambiguous replacements, and files that changed while approval was pending.
- **A command is refused:** DevMate supports selected test, lint, type-check, and build commands. Shells, Git commands, servers, and deployment are outside its tool set.

More detail about providers, storage, permissions, and settings is in the [code guide](docs/code_guide.md).

## Check or package changes

Run the full local checks with:

```powershell
npm run verify
```

This checks TypeScript, compiles from a clean `out/` directory, runs extension and backend tests, checks the shared API/tool definitions, and checks the generated JavaScript files. `npm test` runs the same checks. Provider tests use controlled responses, so they do not make paid model requests. Test the finished workflow in VS Code with your chosen model as well.

To build a Windows x64 VSIX, run this on Windows x64 after installing the development dependencies above:

```powershell
npx --yes @vscode/vsce package --target win32-x64 --readme-path VSIX_README.md --out devmate-1.0.0.vsix --allow-missing-repository
```

Packaging compiles TypeScript and builds the Python backend with PyInstaller. The backend executable is specific to the machine's operating system and architecture; the target flag does not cross-compile it. The Windows package includes its runtime dependencies, so users do not need Python separately.

The `--readme-path` option includes [VSIX_README.md](VSIX_README.md) as the extension's installation guide. Source files, tests, development notes, and temporary build files stay out of the installed extension. For a tour of the implementation, start with the [code guide](docs/code_guide.md).
