# DevMate

VS Code extension prototype for compact AI-supported project guidance.

## Step 1

This slice provides a runnable chat webview only. RAG, backend services, library documentation retrieval, and real LLM calls are intentionally deferred.

## How to Run It in VS Code

Open this project as a normal VS Code extension workspace:

1. Start VS Code.
2. Choose **File > Open Folder...**.
3. Select this folder:

   ```text
   C:\Users\ali\Desktop\KI_PROJEKT
   ```

4. Open the VS Code terminal and install the dependencies:

   ```powershell
   npm install
   ```

5. Compile the extension:

   ```powershell
   npm run compile
   ```

6. Press `F5`. This opens a second VS Code window called the **Extension Development Host**.
7. In that new window, open the command palette with `Ctrl + Shift + P`.
8. Search for and run:

   ```text
   DevMate: Open Chat
   ```

The DevMate chat panel should open. At this stage it can switch modes, attach the active file or selected code as context metadata, and return a placeholder answer.

If `npm` is not recognized after installing Node.js, close VS Code completely and open it again. Windows sometimes needs a fresh terminal session before the updated PATH is available.
