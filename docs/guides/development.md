# Development

AFKLLM is an Electron + React + Monaco desktop app with a local `llama-server` backend.

## Stack

| Layer | Tech |
|-------|------|
| Shell | Electron + electron-vite |
| UI | React 19 + Tailwind + Monaco |
| Inference | `llama-server` (OpenAI-compatible REST) |
| Agent | JSON-Schema tools in the Main process |

## Run locally

```bash
npm install
npm run dev
```

The packaged app is a **thin client**: it does not ship CUDA / llama-server DLLs. On first **Load** it downloads a matching Windows build from [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases) (CPU / CUDA / Vulkan packs).

For offline development you can drop an official Windows build into `./bin/`.

Defaults (overridable in Settings): `http://127.0.0.1:8080`, high GPU layer count, large context.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Electron + Vite HMR |
| `npm run typecheck` | `tsc` for main + renderer |
| `npm test` | Public unit tests (`scripts/stack-detect.test.ts`) |
| `npm run dist` | Build + NSIS setup → `./release/` (unsigned locally) |
| `npm run verify:installer` | Silent install smoke + Authenticode report (`-RequireSigned` after SignPath) |
| `npm run dist:dir` | Unpacked dir only |
| `npm run dist:publish` | Build + upload GitHub Release (`GH_TOKEN`) |
| `npm run licenses:third-party` | Regenerate `THIRD_PARTY_NOTICES.md` |

`npmRebuild` is off in `electron-builder.yml` (node-pty needs Spectre-mitigated VS libs to rebuild). Packaging reuses the prebuilt `node-pty` from `node_modules`.

## Key modules

| File | Role |
|------|------|
| `src/main/agent/AgentToolRegistry.ts` | Agent tools (fs / grep / shell) |
| `src/main/llama/LLMQueueManager.ts` | Priority queue + AbortController |
| `src/main/llama/LlamaProcessManager.ts` | Spawns / supervises llama-server |
| `src/main/llama/LlamaRuntimeManager.ts` | Downloads llama.cpp packs from GitHub |
| `src/main/updater/AppUpdater.ts` | Notify on launch; manual update from Settings |
| `src/main/tray/AppTray.ts` | System tray hide / show / quit |
| `src/renderer/src/editor/monacoFimProvider.ts` | FIM ghost text |
| `src/renderer/src/editor/InlineEditModal.tsx` | Ctrl+K + DiffEditor |

## Shortcuts

- **Tab** — accept ghost text
- **Esc** — dismiss suggestion / reject diff
- **Ctrl+K** — inline edit selected code
- **Ctrl+Enter** — accept diff

## Releases

1. Write notes in `docs/releases/vX.Y.Z.md`
2. Bump `package.json` `version` if needed
3. Push tag `vX.Y.Z` → [`.github/workflows/release.yml`](../../.github/workflows/release.yml) builds Windows artifacts and publishes the GitHub Release
4. Or run `npm run dist:publish` locally with `GH_TOKEN`

Artifact names: `AFKLLM-${version}-x64-setup.exe`, plus `latest.yml` for the in-app updater.

## Code signing (publisher)

Self-signed installers are **not** used for public distribution. Local `npm run dist`
is unsigned; that is expected.

For GitHub Releases (trusted publisher for all users), apply to
**[SignPath Foundation](https://signpath.org/)** — free Authenticode for open-source
projects. Full steps: [Code signing guide](code-signing.md).
