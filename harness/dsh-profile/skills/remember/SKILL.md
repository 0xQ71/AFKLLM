---
name: remember
description: Save a durable fact, decision or user preference so future sessions know it (like Claude Code's memory) — into the project's AGENTS.md or the user's global rules.
whenToUse: The user says remember / "запомни" / "на будущее" / "всегда делай так", corrects how you work, or you learned a non-obvious fact (a command that works, a trap, a decision) that a fresh session would otherwise rediscover.
---

# remember: write it where the next session will read it

1. Decide the scope:
   - about this project (build quirk, decision, where something lives, what is broken) → the project's
     `AGENTS.md` at the repository root (create it if missing, see the `init` skill), section `## Notes`;
   - about the user or how to work with them in every project (language, style, tools, "never do X") →
     `%USERPROFILE%\.dsh\AGENTS.md`, section `## Remembered` at the end (create the section once).
2. Read the file first. If a line already covers the fact, update that line instead of adding a duplicate; if the
   new fact contradicts an old one, replace the old one.
3. Write one or two lines per fact, concrete and checkable: the fact, then why or how to apply it. Dates as
   absolute dates (2026-11-13, not "yesterday"). No secrets, no passwords, no tokens.
4. Do not save what the code or git history already says, or what only matters for the current task.
5. Tell the user in one line what you saved and where.
