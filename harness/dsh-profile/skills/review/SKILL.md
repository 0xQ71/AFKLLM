---
name: review
description: Review code changes (the current git diff, a commit range or given files) for real bugs and rule violations, then verify each finding before reporting.
whenToUse: The user asks for a review / "проверь код" / "найди баги", before a final report on a big task, or at a milestone of a long autonomous task.
---

# review: find real defects, prove them, report briefly

1. Scope: `git status` + `git diff` (or `git diff <base>..HEAD`, or the files named). Read the project's AGENTS.md /
   SPEC for its rules. Read each changed file around the change, not only the diff lines.
2. Look for, in this order:
   - correctness: wrong condition, off-by-one, null/empty cases, wrong API or signature (check the docs or the
     installed package / official docs — never from memory), state not reset, resource not freed, race;
   - contract breaks: callers of a changed function, file formats, save-data compatibility, public APIs;
   - project rules from AGENTS.md / SPEC (each rule is a checklist item);
   - error handling that hides failures; security (paths from input, shell strings, secrets in logs).
   Skip style and naming unless a rule requires it.
3. Verify every finding before reporting it: reproduce (run the test / a probe script / the build), or point to the
   exact lines that make it certain. Drop what you cannot support.
4. Report: one line per finding — `file:line — what is wrong — concrete failing case`, most severe first; then
   "checked, no issues" for the areas you covered. If you are the one who wrote the code: fix the confirmed
   findings, re-run the checks, and say what changed.
