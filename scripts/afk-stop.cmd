@echo off
rem Stops the model (llama-server, afk api, ComfyUI) and DeepSeek Harness, frees the VRAM. Option: -KeepHarness (see afk-stop.ps1)
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0afk-stop.ps1" %*
if errorlevel 1 (pause) else (timeout /t 5 >nul)
