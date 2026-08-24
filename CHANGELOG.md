# Changelog

Release notes for users are published in the **GitHub Release body**
([0xQ71/AFKLLM releases](https://github.com/0xQ71/AFKLLM/releases)).
Canonical copy for each tag lives in [`docs/releases/`](docs/releases/).
That text is what AFKLLM shows in the post-update “What's new” modal
(and is mirrored in-app under Help → Version).

## 0.3.0-20260825-alpha — build 2026-08-25 (**current, pre-release**)

**Alpha.** Host-owned completeness: leaked tools execute, Think/stats stay, from-scratch
Python / Vite+React / Go / C++ / Java / C# close only on evidence (real preview, real
stdout, real compiler). Leftover “I’ll fix it” is not a closer. Static HTML is not npm.

Canonical notes (long form):
[`docs/releases/v0.3.0-20260825-alpha.md`](docs/releases/v0.3.0-20260825-alpha.md).

### Agent host

- Execute leaked `<tool_call>` XML; keep every Think + stats chip; live Think stream
- Compact history only at 99% of real ctx; pin closer before a successful preview stop
- Stack-agnostic patches (do not rewrite a backend bug into a landing)
- `apply_diff` / Ctrl+K on Chat GGUF (no second Apply model)
- Vision coresident / reuse chat VL; 8k agent completion cap
- FILE_COMPLETE does not block rewrite after a failed compile
- CLI closer only when `cliVerified` (run + stdout); next-action narration is not done
- PowerShell: `&&`/`||`, `which`, heredoc, `nul`, PTY chrome strip, TOOL_LOOP reset after edit

### Installer

- `AFKLLM-0.3.0-20260825-alpha-x64-setup.exe` (GitHub **pre-release**; 0.2 will not auto-update to this)

## 0.2.0-20260811 — build 2026-08-11

**Full 0.2 line vs public 0.1.0 / 0.1.0-20260807.** Canonical notes:
[`docs/releases/v0.2.0-20260811.md`](docs/releases/v0.2.0-20260811.md).

### Since 0.1.0 — product

- **Onboarding** — welcome screen; coding / image modes; optional Vision; models now or later
- **Vision attach** — VL GGUF + mmproj; VRAM cold-swap; photo lightbox
- **File attach** — PDF/DOCX (text + scanned pages), text files, images (drag / paste / picker)
- **Image generation** — Settings + composer Image mode; `generate_image` via sd-cli / FLUX
  (sidecars in Settings → Multimodal / Store; hires; blank detection; non-scaled T5 preferred;
  VAE on GPU in `vram` mode; default negative prompt for gibberish text)
- **Chat UX** — auto-title from first prompt; Think answers not stuck inside `<think>`; Context gauge fix

### Fixed (what we repaired)

- **Blank white FLUX images** — prefer non-scaled T5; blank detection; VAE on GPU in `vram`
- **3× Steps** on hires (base + full redo) → single hires pass (~2×), base only as fallback
- Chat title stuck as **“New agent”** in the sidebar after auto-name
- **`Edited · failed` loops** on small files — overwrite + fuzzy patch/diff
- Premature context compact; Think replies trapped in `<think>`; Context gauge arc
- Favicon / hard image-gen fail-soft; Settings overlay + write persistence (0.1.0-20260807)

### Installer

- `AFKLLM-0.2.0-20260811-x64-setup.exe`

## 0.2.0-20260810 — build 2026-08-10

First 0.2 snapshot: onboarding, vision/file attach, Image mode + `generate_image`,
Think promotion, Context gauge. Superseded by **0.2.0-20260811**.

See [`docs/releases/v0.2.0-20260810.md`](docs/releases/v0.2.0-20260810.md).

## 0.1.0-20260807 — build 2026-08-07

Agent reliability (Settings overlay, write persistence, soft tool guards) and
docs/CI/installer polish.

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
5. For `-alpha` / `-beta` / `-rc` tags, GitHub Release is **pre-release**
   (`electron-builder.yml` `releaseType: prerelease`; workflow `prerelease: true`).
   Switch `releaseType` back to `release` for a stable 0.3.0.
