# DevMate

DevMate is a VS Code extension prototype for AI-assisted project help.

## Current Features

- Activity Bar chat view
- Modes: Ideas, Code, Fix
- Scope tabs: Project, File, Selection
- Shows where DevMate will focus
- Placeholder answers

Real LLM calls, RAG, and library docs are not connected yet.

## Run

1. Start VS Code.
2. Open this project folder.
3. Install dependencies:

   ```bash
   npm install
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

Use the second window that opens after `F5`. That is the Extension Development Host.

The F5 window opens this project by default. To test DevMate on another project, change the last path in `.vscode/launch.json`.

Do not open another folder from inside the F5 window. VS Code may open it as a normal window, and DevMate will not be loaded there.

You can also use the command palette:

```text
DevMate: Open Chat
```

If `npm` is not found, install Node.js and restart VS Code.
