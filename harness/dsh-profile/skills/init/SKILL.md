---
name: init
description: Create or refresh the project's AGENTS.md (like Claude Code's /init) so any later session knows how to build, run, test and where things are.
whenToUse: The user says init, "set up the project for the agent", "write AGENTS.md", or a project has no AGENTS.md and you will work in it for more than a few steps.
---

# init: write the project's AGENTS.md

Goal: a short, true, durable file at the project root that lets a fresh session start working in two minutes.

1. Look before writing (read-only):
   - `glob` the top two levels; read the manifest files that exist (package.json, project.godot, Cargo.toml,
     pyproject.toml, *.csproj, CMakeLists.txt, Makefile), README, existing AGENTS.md / CLAUDE.md / .cursorrules.
   - Find the real commands: scripts in the manifest, CI files (.github/workflows), test folders.
   - Run the cheapest check that proves a command works (e.g. the test or build command with a short timeout).
2. Write AGENTS.md (keep any existing content that is still true; do not duplicate the README):
   - **What it is** — one paragraph.
   - **Commands** — build, run, test, lint, each exactly as you ran it, with the expected success output.
   - **Layout** — the folders that matter and what lives there (one line each).
   - **Rules and gotchas** — conventions, generated files not to edit, ports, env vars, platform quirks you saw.
   - **Status** — what works, what is known broken (only what you verified).
3. Under 120 lines. No guesses: mark anything unverified as such. Tell the user what you wrote and what you ran.
