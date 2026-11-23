@echo off
rem One-time setup of the offline translator (CPU) that afk api uses: Harness reasoning en->ru, /image prompts ru->en.
rem See scripts\mt-setup.ps1. Safe to run again.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mt-setup.ps1" %*
exit /b %errorlevel%
