# Changelog

Release notes for users are published in the **GitHub Release body**
([0xQ71/AFKLLM releases](https://github.com/0xQ71/AFKLLM/releases)).
Canonical copy for each tag lives in [`docs/releases/`](docs/releases/).
That text is what AFKLLM shows in the post-update “What's new” modal
(and is mirrored in-app under Help → Version).

## 0.1.0-20260807 — build 2026-08-07

Agent reliability: keep chat mounted while Settings is open (block Settings /
Unload during generation); stop false `Edited · failed` on truncated writes;
persist successful `write_file` chunks to disk; soft guards for tool loops /
missing paths without aborting mid-stream when `relative_path` arrives late.

Also: GitHub/docs polish (README EN/RU with screenshots, release notes,
CI/release workflows), repo cleanup (drop unused bench/e2e scripts),
NSIS-only installer (no portable), local installer verify script; public
signing planned via SignPath Foundation (see docs/guides/code-signing.md).

See [`docs/releases/v0.1.0-20260807.md`](docs/releases/v0.1.0-20260807.md).

## 0.1.0 — first public release

See [`docs/releases/v0.1.0.md`](docs/releases/v0.1.0.md).

AFKLLM 0.1 is the first public version: a local AI coding IDE for Windows
(Electron + Monaco + llama.cpp). Chat, tools, and editing run on the user’s
machine; `.gguf` models are not bundled.

### Agent & chat

- Local GGUF agent with file, terminal, search, git, and web-search tools
- Composer queue, Think mode, auto-approve, checkpoints / rewind
- MCP (stdio) servers, context usage gauge, project rules / codebase index

### Editor & IDE

- Monaco with FIM ghost text and Ctrl+K inline edits
- Explorer with file-type icons, multi-repo rails, terminal, browser, git
- Problems panel; tsc / eslint diagnostics as editor squiggles
- TypeScript / JavaScript hover, go-to-definition, references
- Agent edits do not auto-open every changed file as a tab

### Models & runtime

- Hugging Face model store (GPU-aware picks + downloads)
- Thin installer: CPU / CUDA 12 / CUDA / Vulkan llama.cpp packs from
  official GitHub Releases
- First-run model wizard

### App chrome

- Close hides to tray (confirm while the agent is generating)
- Themes; UI language RU / EN
- Update check on launch; Update in Settings preserves userData

### License

MIT © 0xQ71 — see `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES.md`
(regenerate with `npm run licenses:third-party` after dependency changes).

## Unreleased

### Notes for publishers

1. Add / update `docs/releases/vX.Y.Z.md`
2. Bump `package.json` `version` if needed
3. Push tag `vX.Y.Z` (runs [`.github/workflows/release.yml`](.github/workflows/release.yml))
   or `GH_TOKEN=… npm run dist:publish` locally
4. Keep in-app `changelog.releaseNotes` in sync for the modal fallback
