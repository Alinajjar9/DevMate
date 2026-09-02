# Known issues and manual checks

Last source review: 2026-09-02. This file separates confirmed implementation limits from earlier observations that still need a real-provider or installed-extension test. An automated test passing is not evidence that every model and screen size works.

## Confirmed limitations

- **First workspace folder only.** Multi-root projects are not fully supported.
- **Search tools are not all semantic.** Automatic Project-scope retrieval combines lexical and optional semantic results. The agent's `search_code` tool still does a case-insensitive text search.
- **Context sizes are estimates.** The planner uses character counts rather than the selected model's tokenizer. Set the profile's real context window when known; very large mandatory input can be rejected rather than trimmed silently.
- **The chatbox has no explicit input-length cap.** The UI and incoming message decoder accept a question string without a maximum length, and the backend question field has only a minimum length. Later context, session, index-query, and tool paths have separate limits. This is a missing early validation/usability check, not a claim that the entire system sends unlimited context. Avoid huge pasted questions for the submission demo.
- **Chat retention is bounded.** Session working sets, turns, and character counts have limits. Compaction preserves the transcript rows it summarizes, but normal session processing may shorten long messages/history. DevMate is not a permanent chat archive; keep important notes separately.
- **Provider and platform dependencies.** Semantic search needs a working embedding profile; language navigation needs VS Code language support; terminal tracking needs supported shell integration. A bundled backend must be built for the target OS/architecture.

## Earlier observations requiring manual verification

These are retained as reported observations, not confirmed current regressions:

- **Reasoning/intelligence selector compatibility.** Earlier testing reported controls being shown or having no visible effect for some models. Current options are restricted by model/provider rules in `src/settings/llmProfiles.ts`, with unit coverage in `tests/llmProfiles.test.js`. That does not prove the selected remote endpoint honors each setting. Test the exact profile used in the presentation; use Auto if uncertain.
- **Model tool behavior.** Some models have repeated inspection calls or answered immediately without using tools. The run controller now has duplicate/inspection limits and recovery rules, and the backend has a textual-tool compatibility parser. Re-test with the chosen model; do not describe these safeguards as a guarantee of good tool use.
- **Narrow-window layout.** Earlier laptop testing found the chat cramped. A submission browser check of the actual webview assets, with a simulated extension bridge, passed 20 workflows at each of 320x640, 480x800, and 900x800 without JavaScript errors or horizontal overflow. The earlier report was not reproduced in that fixture. This is not a visual test of the installed extension in VS Code; check the real presentation window as well.
- **Very long chats.** Summary updates, normal retention limits, and reload behavior should be tried together before demonstrating a long-running session. Unit tests cover individual paths, but this review does not claim an unlimited-session endurance test.

## Resolved claim removed from the old list

The old note said create/update operations did not recheck symbolic-link paths after approval. That is no longer accurate. `src/workspace/workspaceMutations.ts` revalidates these paths, and `tests/workspaceMutations.test.js` includes:

- A create parent changed to a symbolic link while approval is pending.
- An update target changed to a symbolic link while approval is pending.
- A symbolic-link path rejected before mutation.

These are regression checks for the reported gap, not a claim that all possible filesystem races are eliminated.

## Final demonstration checklist

Use a disposable project and the installed submission VSIX, not the source development host.

1. Open DevMate, confirm the backend becomes available, and send a short Ideas question.
2. Configure the presentation chat profile without putting its key in a repository file or screenshot.
3. Check lexical Project-scope retrieval without embeddings. If demonstrating semantic search, configure an actual embedding model, allow only the intended endpoint, let indexing finish, and ask about code using different wording.
4. Deny one proposed edit, then approve a separate small edit and inspect its native diff.
5. Cancel a running request and confirm another request can start afterward.
6. Reload VS Code and confirm the demo chat is available again.
7. If demonstrating compaction, exercise it with enough completed turns and a suitable input budget; do not treat a short chat as proof that compaction ran.
8. Check the real small-window layout and a supported verification command in the demo terminal.

Record the actual result of these checks in the submission verification notes. If a provider or installed-extension check was not performed, say so rather than marking it passed.
