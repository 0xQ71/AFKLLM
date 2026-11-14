@echo off
rem Local model (llama-server window + afk api proxy window) + DeepSeek Harness. Options: -Ask, -Model q38-128k, -Watch, -NoHarness (see harness.ps1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0harness.ps1" %*
if errorlevel 1 pause
