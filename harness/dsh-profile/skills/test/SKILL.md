---
name: test
description: Write or extend tests for given code (or the current change), run them, and fix until they pass — without weakening the tests to make them green.
whenToUse: The user asks for tests / "напиши тесты" / "покрой тестами" / "почини тесты", a feature is done and has no tests, or a test suite is red.
---

# test: tests that would catch a real bug, then green for the right reason

1. Find how this project tests: the runner and its config (`package.json` scripts, `pytest.ini` / `pyproject.toml`,
   `go test`, `cargo test`, Godot GUT ...), where tests live, their naming and helpers. Run the existing suite once
   to know the baseline (what already fails before you touch anything).
2. Decide what to test from the behaviour, not the lines: the normal case, edges (empty, one, many, max, unicode,
   Windows paths), invalid input and the error it must give, and the bug you just fixed (a test that fails without
   the fix). Prefer real objects and temp files over mocks; mock only the network, time and randomness.
3. Write the tests in the project's style, then run them. Scratch folders: `os.makedirs` inside the project (not
   `tempfile.mkdtemp`, see the agent rules).
4. A failing test: read the message, then decide which side is wrong — the code or the test's expectation (check the
   spec, the docs or the user's request). Fix that side. Never delete an assertion, loosen it, add `skip`, or catch
   the exception in the test just to get green; if a test cannot pass for a reason outside the task, mark it with the
   reason and tell the user.
5. Run the whole suite at the end (not only the new file) and report the real numbers: `N passed, M failed`, what
   the new tests cover, and anything left untested.
