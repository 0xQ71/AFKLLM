---
name: commit
description: Create a clean git commit of the current work (like Claude Code's commit flow) — check what changed, stage only what belongs, write a message in the repository's style, never push.
whenToUse: The user says commit / "закоммить" / "сохрани в git", or a verified stage of a long task is finished (commit early, after each working stage).
---

# commit: one verified, well-described commit

1. Look first (read-only): `git status`, `git diff` (and `git diff --staged`), `git log -5 --oneline` for the
   message style. On the default branch (main/master) of a shared repo, ask before committing unless the project's
   AGENTS.md says direct commits are fine.
2. Stage only what belongs to this change: `git add <paths>` by name. Never stage secrets (.env, keys, tokens,
   credentials), build output, logs, large binaries or editor junk; if they show up untracked, suggest a
   `.gitignore` line instead. Do not use `git add -A` blindly.
3. Make sure it works: the build / tests / the project's check command ran green after the last edit. If not,
   say so in the commit message body or fix first.
4. Message: follow the repository's existing style (language, prefix like `feat:` / `fix:`, tense). Summary line
   ≤ 72 chars says what and why; body (optional) lists the notable changes and anything unverified.
5. `git commit -m "<summary>" -m "<body>"`. Never `--amend`, `--no-verify`, `reset --hard`, `push` or force
   anything unless the user asked for exactly that. If a hook fails, fix the cause and make a new commit.
6. Report: the commit hash (`git log -1 --oneline`) and what went in, in the user's language.
