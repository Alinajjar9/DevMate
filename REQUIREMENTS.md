# DevMate Requirements

## System prerequisites

| Tool | Minimum version | Purpose |
| --- | --- | --- |
| Visual Studio Code | 1.90 | Run and debug the extension |
| Node.js | 20 | Build the TypeScript extension |
| npm | 9 | Install the locked Node.js dependencies and run scripts |
| Python | 3.10 | Run the local FastAPI backend |
| Git | Any current version | Clone and contribute to the project |

The project has been verified with Node.js 24.16, npm 11.13, Python 3.14, and Visual Studio Code 1.125.

## Dependency files

- `package.json` declares the Node.js development dependencies and supported tool versions.
- `package-lock.json` locks the exact Node.js dependency tree; use `npm ci` for a reproducible install.
- `backend/requirements.txt` contains the Python packages needed to run the backend.
- `backend/requirements-dev.txt` includes the runtime packages plus the backend test client.
- `.nvmrc` selects the recommended Node.js major version when using nvm.
- `.python-version` selects the minimum supported Python version when using pyenv or another compatible version manager.

Node.js itself cannot be installed through `requirements.txt`; that filename belongs to Python's package tooling. Install Node.js separately, then let npm install the packages declared by `package.json`.

## Check installed versions

```powershell
code --version
node --version
npm --version
py --version
git --version
```

## Install project dependencies

Install the Node.js dependencies:

```powershell
npm ci
```

Create the Python environment and install backend development dependencies:

```powershell
py -m venv .venv
.venv\Scripts\python -m pip install -r backend\requirements-dev.txt
```
