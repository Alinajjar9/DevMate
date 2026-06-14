# DevMate

DevMate is a VS Code extension prototype for AI-assisted project help.

## Current Features

- Activity Bar chat view
- Modes: Ideas, Programming, Debugging
- Attach active file
- Attach selected code
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

5. Press `F5`.
6. In the new VS Code window, click the DevMate icon in the Activity Bar.

You can also use the command palette:

```text
DevMate: Focus Chat
```

If `npm` is not found, install Node.js and restart VS Code.
