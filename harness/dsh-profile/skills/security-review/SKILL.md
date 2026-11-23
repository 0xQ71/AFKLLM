---
name: security-review
description: Security review of the pending changes (or given files / a commit range) — injection, path traversal, secrets, unsafe deserialization, auth and permission gaps — with every finding proven before it is reported.
whenToUse: The user asks for a security review / "проверь безопасность" / "есть ли уязвимости", before publishing code that handles input from users, files or the network, or after adding auth, file upload, shell or SQL code.
---

# security-review: real, exploitable issues only

1. Scope: `git status` + `git diff` (or `git diff <base>..HEAD`, or the files named). Find where untrusted data enters:
   HTTP handlers, CLI arguments, files and archives read, environment, IPC, messages from other processes, LLM output.
2. Follow each input to where it is used and check, in this order:
   - injection: shell strings built from input (prefer argument arrays), SQL by concatenation (use parameters),
     HTML/JS output without escaping (XSS), template injection, `eval` / `new Function` / `pickle` / `yaml.load`;
   - paths: joins with user input without normalising and checking the result stays inside the allowed folder
     (`..`, absolute paths, symlinks, Windows `C:` and UNC paths), archive extraction (zip slip);
   - secrets: keys or passwords in code, config or logs; tokens in URLs; secrets sent to third parties;
   - auth: missing checks on a route or action, checks done on the client only, IDs taken from the request and
     trusted (IDOR), CORS `*` with credentials, default or empty credentials;
   - resource abuse: unbounded uploads, reads or loops on input size, regexes with catastrophic backtracking, missing
     timeouts on network calls;
   - crypto: home-made crypto, MD5/SHA-1 for passwords, `Math.random()` / `random` for tokens, disabled TLS checks.
3. Prove each finding: name the input, the path through the code (file:line at each hop) and a concrete payload that
   triggers it; run a probe when it is cheap (a unit test or a one-line script against a local build — never against
   someone else's system). Drop what you cannot support; "could be risky" without a path is not a finding.
4. Report: `severity — file:line — the issue — the payload and its effect — the fix`, most severe first; then the
   areas checked with no findings. If you wrote the code, fix the confirmed findings, add a test for each, re-run.
