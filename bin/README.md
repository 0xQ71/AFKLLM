# llama-server runtime

AFKLLM is a **thin client**: packaged installers do **not** include llama.cpp / CUDA DLLs.

## Packaged app

On first **Load**, AFKLLM downloads the matching Windows build from the official
[llama.cpp GitHub Releases](https://github.com/ggml-org/llama.cpp/releases):

- NVIDIA GPU detected → `llama-*-bin-win-cuda-12.4-x64.zip` + `cudart-llama-bin-win-cuda-12.4-x64.zip`
- otherwise → `llama-*-bin-win-cpu-x64.zip`

Files are extracted to `%APPDATA%\afkllm\llama-runtime\` (Electron `userData`).

You can force re-download from **Settings → llama.cpp runtime**.

## Local development

Place Windows CUDA/CPU builds here so `npm run dev` can spawn them without downloading:

- `llama-server.exe`
- matching `*.dll` next to it

Dev resolves `./bin/llama-server.exe` first. Models (`.gguf`) are never bundled.
