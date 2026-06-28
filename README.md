# DevMate

DevMate is a VS Code extension prototype for AI-assisted project help.

## Current Features

- Activity Bar chat view
- Modes: Ideas, Code, Debug
- Scope tabs: Project, File, Selection
- Shows where DevMate will focus
- Local FastAPI backend with `/health` and `/ask`
- Configurable backend URL and clear offline feedback
- Deterministic backend answers for transport testing

Real LLM calls, RAG, and library docs are not connected yet.

## Requirements

DevMate requires Visual Studio Code 1.90+, Node.js 20+, npm 9+, and Python 3.10+. Git is also recommended for development. See [REQUIREMENTS.md](REQUIREMENTS.md) for the complete tool list, version commands, and dependency-file overview.

## Run the backend

The backend requires Python 3.10 or newer. Create an isolated Python environment and install its dependencies:

```powershell
py -m venv .venv
.venv\Scripts\python -m pip install -r backend\requirements-dev.txt
```

Start the local service:

```powershell
.venv\Scripts\python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --reload
```

The health endpoint is available at `http://127.0.0.1:8000/health`. The extension uses this address by default; change `devMate.backendUrl` in VS Code settings if the backend runs elsewhere.

Run the backend contract tests with:

```powershell
.venv\Scripts\python -m unittest discover -s backend\tests -v
```

## Run the extension

1. Start VS Code.
2. Open this project folder.
3. Install dependencies:

   ```powershell
   npm ci
   ```

4. Compile:

   ```bash
   npm run compile
   ```

5. Check for errors:

   ```bash
   npm run check
   ```

6. Press `F5`.
7. In the new VS Code window, click the DevMate icon in the Activity Bar.

Keep the backend terminal running while testing the extension. If it is stopped, DevMate shows a backend-unavailable message instead of a placeholder answer.

Use the second window that opens after `F5`. That is the Extension Development Host.

The F5 window opens this project by default. To test DevMate on another project, change the last path in `.vscode/launch.json`.

Do not open another folder from inside the F5 window. VS Code may open it as a normal window, and DevMate will not be loaded there.

You can also use the command palette:

```text
DevMate: Open Chat
```

If `npm`, `node`, or `py` is not found, install the missing prerequisite listed in [REQUIREMENTS.md](REQUIREMENTS.md), then restart VS Code and the terminal.
