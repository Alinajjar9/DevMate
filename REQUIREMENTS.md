# System requirements

DevMate has two parts, so it needs both Node.js and Python during development.

| Software | Minimum version | Used for |
| --- | --- | --- |
| Visual Studio Code | 1.96.2 | Running the extension |
| Node.js | 20 | Compiling the TypeScript extension |
| npm | 9 | Installing Node dependencies and running scripts |
| Python | 3.10 | Running the local backend |
| Git | Recommended | Cloning the repository and keeping version history |

The project was developed on Windows with PowerShell. Most of the code is platform independent, but the submission and setup instructions have been tested primarily on Windows.

## Check the installed versions

```powershell
code --version
node --version
npm --version
py --version
git --version
```

## Dependency files

- `package.json` declares the extension's development dependencies and npm scripts.
- `package-lock.json` locks the Node dependency versions. Use `npm ci` instead of `npm install` for a clean setup.
- `backend/requirements.txt` contains the Python packages needed to run the backend.
- `backend/requirements-dev.txt` includes the runtime requirements for development and testing.
- `.nvmrc` records the expected Node.js major version.
- `.python-version` records the minimum Python version.

Node.js packages and Python packages are separate. `npm ci` installs the extension dependencies, while `pip` installs the backend dependencies.

Continue with the [installation guide](docs/INSTALLATION.md).
