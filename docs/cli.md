# `afk` — AFKLLM in the terminal

A command-line coding agent on top of the new headless core (`src/core`). It runs fully
locally against llama-server.

```powershell
scripts\afk.cmd                      # interactive session in the current folder
scripts\afk.cmd "fix the failing test"
scripts\afk.cmd --auto               # start in AUTO MODE
scripts\afk.cmd -p "what does src/core/agent.ts do?"     # print mode (one shot)
Get-Content task.md | scripts\afk.cmd -p --auto          # multi-line prompt: pipe it (cmd.exe cuts arguments at a newline)
scripts\afk.cmd -m ornith            # pick a model profile
scripts\afk.cmd --url http://127.0.0.1:8080              # use an already running llama-server
npm run afk -- --help
```

## Models

`-m/--model` takes a profile name or a `.gguf` path. Built-in profiles (tuned on the stage-0 bench,
RTX 5060 Ti 16 GB, files under `C:\Models`):

| profile | model | ctx | notes (stage 0, thinking on) |
|---|---|---|---|
| `q38` (default below 64 GB RAM) | Qwen3.8 27B baa-ai RAM-13GB + grafted MTP + Q5_K head | 104K | **16 GB GPU only**: coder 16/16, agent tasks 2/2 (T3 140 s, T2 234 s); ~69 t/s, 750 t/s prefill, needle 6/6 at 90K; fully on the GPU |
| `q38-128k` | same, MTP draft 2, FFN of 5 layers on CPU | 128K | ~46 t/s, 620 t/s prefill — a third slower for +24K |
| `q38-160k` | same file, MTP off | 160K | ~30 t/s (15 t/s at 138K deep), needle 6/6 at 100K — for reading huge inputs |
| `flash` (default with 64 GB RAM) | Qwen3.8-Flash-Next IQ3_XXS (MoE, 47 GB of weights) on Strata | 256K (native) | **64 GB RAM**: 55–85 t/s (~60 at 200K deep), 750–1850 t/s prefill (llama.cpp b12063 on the same files: 18.5 / 300); needle 3/3 at 200K; Harness e2e: module + 18 tests in 94 s, a 12-file package + 23 tests + commit in 433 s |

### `flash`: a MoE bigger than the GPU, on Strata

[Strata](https://github.com/Niko1221/Strata) (MIT) keeps the hottest experts in VRAM (~8.6 GB) and the rest in pinned
RAM (~40 GB), computed on the CPU, with int8 KV, a DFlash2 drafter and its own prefill kernels. `scripts\strata-setup.cmd`
runs `strata launch` once (model prepared where the GGUF files lie, engine + drafter download, quick tune) and saves
the preset `afk-flash`. AFKLLM then starts Strata's own server (`serve/server.py`, bundled Python) on a copy of that
launch config in `~/.afkllm/strata/` with the profile's overrides (`src/core/server.ts`, `src/core/strata.ts`), on
:18301 where llama-server would run. Strata answers llama-server's `/health`, `/props`, `/slots/0?action=save|restore`
and OpenAI `/v1`, so the proxy, model switching and the image GPU swap (slot saved in 0.5 s, unload 1.6 s, reload
~80 s, restore 0.5 s) need no special path; the process tree is killed with `taskkill /T` because the engine is a
child of the Python server.

Profile overrides: `--conversation-cache-mib 4096` + `--conversation-cache-min-tokens 4096` park the conversation in
RAM while a side request (title, sub-agent, compaction) takes the slot (returning: 1.3 s instead of 19 s for 18K);
`--prompt-cache-every 4096` keeps the hybrid model's rewind checkpoints dense, so a client that rewrites its history
re-reads at most ~4K tokens; thinking budget 32768 per step (the Harness entry allows 40960 output tokens a step);
images capped at 1024 tokens. Sampling is the model card's thinking mode: temperature 1.0, top_p 0.95, top_k 20,
min_p 0, presence 0; reasoning effort `xhigh` (Harness "high"), which the card recommends for agent work.

Context: the native 262,144 tokens. Only 12 of the 48 layers keep K/V (2 heads x 256, int8), ~12 KB a token: 3.1 GB
of pinned RAM for the whole window, 32K cells per layer of it in VRAM. Checked at 200K: read in 108 s (1857 t/s),
3/3 needles at 10/50/90 % depth, decode 60-63 t/s at that depth, the next turn reused 200,071 tokens (4 s).
Harness compacts at ~210K.

Quantization: IQ3_XXS weights (3.0 bpw, 18 of 48 layers raised to IQ4_NL; ISTA-DASLab measured 99.4 % of BF16 on their
task average, GPQA-D 91.4 vs 91.9, LCB v6 86.3 vs 87.4); IQ3_S (+7.8 GB) does not fit next to Strata in 64 GB.

Memory: the engine commits ~61 GB, so the Windows commit limit (RAM + page file) must be about 96 GB or more; below
that Strata turns the conversation cache off itself. Update checks are off (`STRATA_UPDATE_CHECK=0`).

Why 104K and not more for the 27B: VRAM, not the model (native 262K). With MTP each 1K of context costs ~29 MiB
(q4 KV, the MTP layer's KV, and two flash-attention buffers that grow with context), and llama-server must stay
under ~15.5 GB dedicated — above that Windows silently moves memory into system RAM and generation drops to
6–40 t/s.

System RAM: llama-server reads the weights instead of memory-mapping them (`--load-mode none`): on Windows the
mapped file stayed resident even though the weights live on the GPU (13 GB working set idle, 23 GB after a long
session). Now it holds ~2 GB plus the prompt cache (`--cache-ram 4096`): when the prompt prefix changes (compaction,
a sub-agent) the old state, ~1.3 GB per 40K tokens, is parked in RAM, and returning to it takes ~3 s instead of ~70 s.
Task Manager still shows ~19 GB "committed" for the process. CUDA reserves that for its GPU buffers; it is not
physical RAM. The model files are built by `scripts/stage0/graft-mtp.py` (MTP layer grafted in, LM head swapped for
unsloth's imatrix Q5_K; tensor bytes are copied, nothing is re-quantized).

### Images (screenshots, photos)

All `q38*` profiles load the Qwen3.8 vision projector (`mmproj-Qwen3.8-27B-BF16.gguf`) **on the CPU**
(`--no-mmproj-offload`), so the full context stays on the GPU. On the GPU the projector made the 104K setup spill
into system RAM (25 s per screenshot, 44 t/s after); on the CPU a 1280×720 screenshot takes ~13 s, costs ~920
tokens of context, and generation stays at ~65 t/s. Images are capped at 2048 tokens (`--image-max-tokens`).

- attach in the prompt: `look at @shot.png and fix the layout` (or `@"C:\path with spaces\photo.jpg"`)
- or let the agent open one: the `Read` tool shows `.png .jpg .jpeg .webp .gif .bmp` files to the model

Compaction keeps only the text (`[image]` markers), so pictures do not pile up in a long session.

`afk` starts llama-server itself on port 18300 and stops it on exit (`--keep-server` leaves it running,
and the next `afk` reuses it). Override or add profiles in `~/.afkllm/cli.json`:

```json
{
  "defaultProfile": "q38",
  "llamaServer": "C:\\Models\\llama.cpp\\b12063\\llama-server.exe",
  "profiles": { "q38": { "ctx": 98304 } }
}
```

## Permission modes (shift+tab cycles)

| mode | edits | commands |
|---|---|---|
| `default` | ask | ask |
| `acceptEdits` | auto | ask |
| `plan` | refused: investigate and present a plan | refused |
| `auto` — **AUTO MODE** | auto | auto |

AUTO MODE is meant for long unattended runs: the agent keeps a todo list and the host pushes it onward
while items are still open. Even in AUTO MODE it still asks before anything that is hard to undo or
leaves the project: writes outside the project folder, `git push`, `git reset --hard`, recursive
deletes of broad paths, registry/system commands, `curl … | sh` and similar. In print mode (`-p`) and
`serve --stdio` without a client answering, those are refused instead.

## Keys and commands

`esc` interrupts the agent · `enter` while it works queues your message · `\`+`enter` or `alt+enter`
for a new line · `ctrl+o` shows the model's thinking · `ctrl+t` shows todos · `ctrl+c` twice exits.

`/help` `/auto` `/plan` `/mode <m>` `/todos` `/compact [focus]` `/clear` `/clear-history` `/sessions` `/resume [id]`
`/status` `/exit`

The ↑/↓ input history lives only while the window is open; nothing you type is written anywhere except the
chat itself (the session). `/clear-history` forgets it without closing. Web searches are cached in memory only.

Sessions are saved to `<project>/.afkllm/sessions/` after every turn; `afk -c` continues the last one.
Project instructions are read from `AFKLLM.md` (or `AGENTS.md`) in the project root.

## Thinking

Thinking is always on: the model reasons before every step, and its reasoning from earlier steps
of the current request is sent back with each call (interleaved thinking), so it does not lose its train of thought
between tool calls. `ctrl+o` prints the reasoning; otherwise the spinner shows its last line.

Each step may think for up to 16384 tokens (`--reasoning-budget`); past that the server tells the model to wrap
up and act. It is a ceiling, not a target: Qwen3.6 typically uses 1–9K. To lift it, set
`"profiles": { "q36": { "args": { "reasoning-budget": "-1" } } }` in `~/.afkllm/cli.json`.

## Tools

`Read`, `Write`, `Edit` (exact string replace; a file must be Read before it is edited), `Glob`, `Grep`,
`Shell` (PowerShell on Windows, with background jobs for dev servers), `TodoWrite`, `Task` (read-only
sub-agent with a fresh context).

## Headless protocol (`afk serve --stdio`)

One JSON object per line. In: `{"type":"run","text":"…"}`, `{"type":"abort"}`,
`{"type":"mode","mode":"auto"}`, `{"type":"permission_response","id":1,"allow":true,"remember":false}`,
`{"type":"compact"}`, `{"type":"clear"}`, `{"type":"state"}`, `{"type":"exit"}`.
Out: `ready`, every `AgentEvent` from `src/core/types.ts`, `permission_request`, `idle`.
This is the seam the desktop app will move onto.

## Backend for an agent harness (`afk api`)

`scripts\afk.cmd api` serves the model and AFKLLM's own tools to an external agent harness (DeepSeek Harness,
opencode, ...) on this PC:

- `http://127.0.0.1:18300/v1`: OpenAI-compatible chat. llama-server itself runs on :18301 with the profile's
  vision projector. A proxy in front of it fills in the profile's sampling (Qwen: temp 0.6, top_p 0.95,
  top_k 20, min_p 0) when the client sends none, maps `reasoning_effort` high/max to the template's `xhigh`, and
  converts WebP images to PNG (llama-server cannot decode WebP).
- `http://127.0.0.1:18300/mcp`: MCP (Streamable HTTP, stateless) with `generate_image` (Qwen-Image 2.1, GPU swap:
  the LLM is unloaded, ComfyUI draws, the LLM comes back with its KV cache; chat requests that arrive meanwhile
  wait), `screenshot` (a window or the screen) and `web_search` (keyless). Pictures are returned as MCP image
  content, so a vision model sees what it generated or captured.

One click for all of it: `scripts\harness.cmd` (desktop shortcut "AFKLLM + DeepSeek Harness") loads the default
profile `q38` without asking (`-Ask` asks, `-Model q38-128k` picks one; `afk models` lists them), makes it the
default for new Harness chats, and starts DeepSeek Harness (it also sets `AFKLLM_API_KEY=local` for the user, which
the Harness provider needs). It opens two windows:

- **llama-server** (`scripts\afk-llama.ps1` = `afk llama` on :18301): the model alone, and under it its live work in
  Russian — prompt reading in %, generation speed, MTP acceptance, how full the context is, how long an image took
  to encode, errors. This window owns the model: Ctrl+C or closing it stops the model.
- **AFKLLM: прокси** (`afk api` on :18300): reuses the running llama-server. If the proxy stops or crashes, the
  model and its KV cache stay; start `afk api` again and the agent continues without re-reading the conversation.
  When the proxy has to restart llama (a model switch, an image), the new server is detached, so it keeps that
  property; the llama window keeps showing its progress (same log file) and still stops it on exit.

`scripts\afk-stop.cmd` is the counterpart: it stops Harness (with its MCP children), both windows, any llama-server,
the Strata server and an engine left without it, ComfyUI on :8190 and harness-watch, then reports the freed VRAM
(`-KeepHarness` stops only the model side). Other node/python processes are left alone.

`-Watch` also opens `scripts/harness-watch.mjs`, a live view of the agent's session: its reasoning, tool calls and
results, todo progress with a rough time estimate, context use, compactions, decode speed. `-NoHarness` starts only
the model and the proxy.

Images in agent sessions are the slow part of prompt reading: the vision projector runs on the CPU, and a 1920×1080
screenshot took 36 s and 2107 tokens (ArenaFPS run: prompts with two screenshots read at ~62 t/s instead of
400-700). The Harness profiles send images at most ~1366×768 (`requestImagePixelBudget: 1048576`): 15 s and 1099
tokens, on-screen text stays readable; 1024×576 is 7 s / 643 tokens but misreads small text.

The model thinks in English. The monitor shows the reasoning in Russian, and DeepSeek Harness Desktop translates
expanded reasoning to Russian (its reasoning-translation bundle, `targetLanguage: ru`). Both use Microsoft's anonymous
Edge translator: it needs the internet, the reasoning text (which can contain code) goes to Microsoft, and the
endpoint is not an official API, so it may rate-limit or stop working; then the original English is shown. The
model, the session and the GPU are not involved. `harness-watch.mjs --en` shows the original.

Switching models: `afk api` loads the profile a chat request names as its `model` (a profile name, or a `.gguf`
path = the first profile using that file). DeepSeek Harness lists `q38` (104K), `q38-128k`, `q38-160k` and `flash` in its
model picker; choosing one reloads llama-server (~10-20 s; `flash` ~60-80 s; the conversation is re-read) while requests wait. Image
generation and switches take turns on the GPU. `GET /v1/models` lists the profiles with the loaded one marked.

In DeepSeek Harness, search runs through the harness's own `web_search` tool, so it gets the harness's search card
(how many results from which engines, then the sources with links): `harness/dsh-web-search-afkllm` is a search
provider for the harness that calls `GET http://127.0.0.1:18300/search?q=…` (JSON: `sources`, `engines`, `failed`).
Install it once per profile with `dsh plugin --profile desktop add link:<путь к AFKLLM>/harness/dsh-web-search-afkllm`;
the profile patch pins `web.searchProvider: afkllm` and connects MCP as `/mcp?exclude=web_search` so the model
does not see two search tools. Other MCP clients keep `web_search` on `/mcp`.

The search asks Yahoo, Bing, DuckDuckGo, Brave and Mojeek at once and fuses the rankings, plus Read the Docs (when the
query names a project hosted there, e.g. Godot), MDN (web topics), Stack Overflow, Wikipedia and GitHub. No keys. An
engine that answers with a captcha or a rate limit is left alone for a while (5 min, doubling up to an hour) and
the result says which engines did not answer; blocks are never worked around.

Godot API index: `node scripts/godot-api-index.mjs <godot.exe>` runs the engine's `--doctool` and writes
`~/.dsh/knowledge/godot-<version>-api.txt`, one line per class member (26K lines for 4.7.2). The harness rules
(`~/.dsh/AGENTS.md`) tell the agent to grep it before using a Godot name it is not sure of.

`--lan` also listens on the LAN for `/v1`; `/mcp` always answers this PC only. The DeepSeek Harness profile
used with it lives in `~/.dsh/profiles/desktop/cordis.patch.yml` (provider `afkllm`, presets `afkllm` and
`afkllm-web`). What it adds over the shipped `standard` preset:

- MCP `context7` (`https://mcp.context7.com/mcp`, keyless): current docs and code examples of libraries and engines
  (`resolve-library-id`, then `query-docs`); the query text goes to context7.com. The rules in `~/.dsh/AGENTS.md`
  tell the agent to look an API up there before writing code against it.
- not used: bundle `dsh-experimental-terminal-bundle` (persistent PTY terminals). On this PC `terminal_open` fails
  with "PTY shell exited during startup" with Windows PowerShell 5.1 and with a portable PowerShell 7.6.9 alike
  (2026-11-13, workspace-write sandbox); background jobs (`job_output` / `job_kill`) cover dev servers instead.
- preset **AFKLLM + браузер** (`afkllm-web`): the same agent plus MCP `browser` = Playwright MCP 0.0.84
  (`~/.dsh/mcp/playwright`, driving the installed Microsoft Edge): open a page, click, type, read the console and
  network, screenshots. Separate because its 25 tools cost ~6K tokens of every prompt.
- permission preset `workspace-auto`: writes only inside the project, no approval prompts (`/permission
  workspace-auto`); the default stays `workspace-write` (asks).
- skills in `~/.dsh/skills`: `init`, `review`, `security-review`, `test`, `debug`, `godot`, `commit`, `remember`, `simplify`, `browser-test`.

The headless profile `~/.dsh/profiles/afk-headless` has Context7 too.

Hooks in the style of Claude Code: plugin `harness/dsh-hooks-afkllm` (linked into both profiles; row `hooks-afkllm`,
config `guard` / `check` / `stopCheck` / `stopMaxContinues` / `notify` / `checkers`). It uses the Harness's own
extension points: `ctx.tools.guard()` (built-in denials: deleting a drive root or the profile, formatting,
diskpart, reboot, Defender off, HKLM deletes, writes to the hook / profile settings), `tools/pre-execute` (`ask` before
`git push --force`, `reset --hard`, `clean -f`, `branch -D`, download-and-run; user PreToolUse commands),
`fs/write-intent` + `fs/edit-intent` (which files a tool call changed), `tools/post-execute` (syntax check of those
files: Python `ast`, `node --check`, TypeScript `transpileModule` from the project's `node_modules`, JSON, the
PowerShell parser, merge-conflict markers, `checkers: { ".ext": "command {file}" }`; problems are appended to the tool
result; user PostToolUse commands), `agent/turn-stopping` (re-check of the turn's edited files and user Stop commands;
a failure goes back to the agent with `agent.inject()`, at most `stopMaxContinues` = 3 times per turn; subagents are
skipped) and `turn/end` (a Windows toast as "DeepSeek Harness" after turns of `notify.minSeconds` = 60 s or more; off
in afk-headless). User hooks: `~/.dsh/hooks.json` and `<project>/.dsh/hooks.json`, Claude Code's format (`matcher`
is a regex over the Harness tool name or its Claude Code alias: `Bash` = `pwsh`, `Edit` = `edit` / `apply_patch`,
`Write` = `write`); a command runs through cmd.exe in the project folder with the event JSON on stdin; exit 2 blocks
with stderr, JSON stdout (`decision`, `hookSpecificOutput.permissionDecision` / `additionalContext`) works too; a
hook's `allow` never bypasses the Harness approval. Stop hooks run only in turns that edited files unless
`"always": true`. The project file runs only when its SHA-256 is in `~/.dsh/hooks-trust.json` (`/hooks trust`), so a
cloned repo or the agent itself cannot add commands that run outside the sandbox. Tests: `node --test
harness/dsh-hooks-afkllm/index.test.mjs`.

Private images straight from a prompt: `/image [WxH] [seed=N] <prompt>` (plugin `harness/dsh-image-afkllm`, linked
into the desktop profile) sends the prompt as written to `generate_image` on `afk api`, without the language model.
Nothing leaves the PC (only 127.0.0.1). The prompt is not in the Harness session log (`recordInput: false`), not
in the proxy console (`private` flag, not in the tool schema the model sees), and not inside the PNG: afk strips
the PNG text chunks where ComfyUI writes its workflow and prompt, and deletes ComfyUI's copy in
`~/.afkllm/comfy-output` (both for every generated image). Pictures go to `~/.afkllm/private-images` (outside the
Pictures library) and open in the default viewer. `/image-clean` deletes them, their Windows "Recent" shortcuts and
leftover ComfyUI copies; the session itself is deleted in the Harness session list. The agent's own `generate_image`
is unchanged. Harness telemetry is off in the desktop profile: product analytics and product telemetry disabled,
session telemetry `DISABLED` (`FEEDBACK_ONLY` would upload the whole session after a rating or `/feedback`). The
reasoning translation (Microsoft) only runs when you expand the model's reasoning; `/image` has none.

## Design notes

- The system prompt is built once and never edited, so llama-server reuses the KV cache for the whole
  prefix. Stage 0 measured why: on Qwen3.6-35B-A3B an appended turn re-processed 26 tokens (1.3 s),
  a changed system prompt re-processed 15.7K tokens (50 s).
- Mode changes and host nudges ride on user messages as `<system-reminder>` blocks.
- At 80 % of the context the conversation is compacted into a summary plus the todo list.

## Project folder

`afk` works in the folder it is started from (or `--cwd <dir>`), like `git`. Reading, searching or writing outside that
folder asks first, in every mode. Starting in a risky place (a drive root, your user folder, Desktop / Downloads /
Documents, AppData, Windows, Program Files) asks whether to work there, pick another folder or exit; `-p` and `serve`
refuse such folders unless `AFK_ALLOW_FOLDER=1` is set. The desktop app asks the same when a folder is chosen, and
keeps sessions in `<project>/.afkllm/sessions`.

## Building for Windows

- `npm run build:cli` → `release/cli/afk.exe`: one file, no Node needed (esbuild bundle + Node single executable).
- `npm run dist` → `release/AFKLLM-<version>-x64-setup.exe`: the desktop installer.
