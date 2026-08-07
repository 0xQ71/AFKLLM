# AFKLLM Android

Standalone on-device chat client for **AFKLLM** (Kotlin + Jetpack Compose).

Same product language as the Windows app: themes, EN/RU, full settings pages, and workspace surfaces
(Agent / Explorer / Code / Terminal / Browser / Git / Console) behind a narrow **icon activity bar**.
Inference targets GGUF via a `llama.cpp` JNI module (demo engine without NDK).

## Modules

| Module | Role |
|--------|------|
| `:app` | Compose UI (rail, chat, settings) |
| `:core` | Themes, i18n, DataStore settings, chat store |
| `:llama` | JNI bridge + optional real `llama.cpp` |

## Requirements

- Android Studio Ladybug+ / JDK 17+
- Android SDK 35, minSdk 26
- Optional: NDK (for `libafkllm_llama.so`). Without NDK, build with `-Pafkllm.native=false` and use the Kotlin **demo engine**.

## Build

```bash
cd android
# Demo / no NDK:
./gradlew :app:assembleDebug -Pafkllm.native=false

# With NDK (default; builds JNI stub that accepts GGUF paths):
./gradlew :app:assembleDebug
```

Install:

```bash
./gradlew :app:installDebug -Pafkllm.native=false
```

### Real llama.cpp (default when `third_party/llama.cpp` exists)

```bash
git clone --depth 1 https://github.com/ggml-org/llama.cpp.git ../third_party/llama.cpp
cd android
./gradlew :app:assembleDebug
# optional: -Pafkllm.withLlama=false for JNI stub only
# optional: -Pafkllm.native=false for Kotlin demo engine (no NDK)
```

Requires Android NDK. Inference runs on-device CPU (arm64-v8a).

## Models

Import a `.gguf` under **Settings → Model**. Recommended:

| Model | RAM (approx.) |
|-------|----------------|
| Gemma 4 E2B IT Q4_K_M (`bartowski/google_gemma-4-E2B-it-GGUF`) | ~6 GB |
| Gemma 4 E4B IT Q4_K_M (`bartowski/google_gemma-4-E4B-it-GGUF`) | ~8 GB |

## UI map

- **Activity bar** (~52dp icons) — Agent, Explorer, Code, Terminal, Browser, Git, Console, Settings
- **Agent** — sessions sidebar + chat (Auto / Think / Plan)
- **Explorer / Code / Terminal / Browser / Git / Console** — mobile workspace panes (SAF, editor, shell, WebView)
- **Settings** — General, Appearance, Agent, Model, Performance, Memory, Generation, Runtime, MCP

## Version

`0.1.0-android`
