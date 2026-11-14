@echo off
rem AFKLLM CLI agent. Put this folder on PATH or call it directly: scripts\afk.cmd --help
"%~dp0..\node_modules\.bin\tsx.cmd" "%~dp0..\src\cli\main.ts" %*
