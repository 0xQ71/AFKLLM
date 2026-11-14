---
name: simplify
description: Clean up the code you just changed — reuse existing helpers, remove duplication and dead code, simplify logic — without changing behaviour, then re-run the checks.
whenToUse: The user says simplify / "упрости" / "почисти код" / "отрефактори", or a feature works but the diff grew large, repetitive or hacky.
---

# simplify: same behaviour, less code

1. Scope: `git diff` (or the files named). Read each changed file fully, and search (`grep`) the project for
   existing functions, components and utilities that already do what the new code re-implements.
2. Look for, in this order:
   - re-implemented helpers → call the existing one;
   - copy-pasted blocks → one function / loop / table;
   - dead code: unused variables, imports, parameters, commented-out code, debug prints left behind;
   - needless complexity: nested ifs that can return early, flags that are always the same, wrappers that only
     forward, state that can be derived;
   - wasted work: the same file read twice, a query in a loop, recomputation in a hot path.
   Not in scope: renaming for taste, reformatting, new abstractions "for later", changing public APIs.
3. Change in small steps; after each step run the build / tests / the project's check. If something breaks,
   undo that step.
4. Report: what you simplified (one line each, with file:line) and the check you ran with its result.
