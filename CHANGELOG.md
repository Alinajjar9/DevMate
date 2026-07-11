# DevMate Change Log

Record meaningful changes here before creating each commit. Keep the newest entry first and describe the result rather than listing every edited file.

## 2026-07-11 — Extract webview UI from the extension controller

### Changed

- Moved the webview HTML shell and Content Security Policy into `src/webview.ts`.
- Moved sidebar styles into `media/webview.css`.
- Moved browser-side chat state, rendering, and interactions into `media/webview.js`.
- Reduced `src/extension.ts` from approximately 9,400 lines to approximately 5,000 lines.
- Restricted webview local-resource access to the `media` directory.
- Updated webview tests to load and validate the separated UI assets.
- Updated the repository documentation and compiled extension output.

### Fixed

- Updated session file-change summary imports to use the consolidated `fileTools` module, restoring a clean TypeScript build.
- Removed trailing whitespace found during verification.

### Verification

- `npm run check`
- `npm test` — 134 tests passed
- `git diff --check`

---

## Entry template

Copy this section above the previous entry before each commit:

```markdown
## YYYY-MM-DD — Short change title

### Changed

- Describe user-visible or architectural changes.

### Fixed

- Describe corrected behavior, or remove this section when unused.

### Verification

- List the checks or tests that were run.
```
