@echo off
rem AFKLLM: prepare this PC (hardware check, recommended model download + setup, DeepSeek Harness profile, desktop
rem shortcuts). Options: -Model flash^|q38, -Yes (no questions), -ModelsDir D:\Models. See scripts\setup.ps1.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
pause
