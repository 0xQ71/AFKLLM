---
name: debug
description: Systematic debugging — reproduce, read the exact error, form one hypothesis at a time, test it cheaply, fix the root cause, prove the fix.
whenToUse: A build, test or program fails and the cause is not obvious after reading the error once, or the same error came back after a fix.
---

# debug: evidence first, one hypothesis at a time

1. Reproduce with the smallest command; save its full output to a file inside the workspace and read the first
   error (later errors are often consequences). Quote the exact message, file and line.
2. Read the code at that line and what feeds it. Re-read the file from disk: your memory of it may be stale.
3. Write down one hypothesis and the cheapest test that would refute it (a print, a 3-line probe script, a grep in
   the official docs / class reference, `--help`). Run it. Refuted → next hypothesis. Never "explain" an error with a story
   you did not test (e.g. "the engine renamed it in this version").
4. Unknown error text or API behaviour → web_search the exact message in quotes, read the best result.
5. Fix the root cause, not the symptom. Re-run the original reproduction and the project checks; both must pass.
6. Timebox: after ~6 steps on one error without progress, step back — simplify the code path, use a plainer API,
   or stub it with a note in AGENTS.md — and move on.
7. If the fix taught something non-obvious, add one line to the project's AGENTS.md (gotchas).
