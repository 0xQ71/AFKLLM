@echo off
rem One-time setup of the Strata preset "afk-flash" that the AFKLLM profile `flash` starts (src\core\strata.ts).
rem Needs Strata Terminal installed (github.com/Niko1221/Strata, installs to %LOCALAPPDATA%\Strata) and
rem Qwen3.8-Flash-Next IQ3_XXS in %AFK_MODELS_DIR% (default C:\Models)\ISTA-DASLab__Qwen3.8-Flash-Next-GSQ-RCO-GGUF\IQ3_XXS.
rem `strata launch` prepares the model where the GGUF files lie (+~1.7 GB in %LOCALAPPDATA%\Strata), downloads the
rem engine and the DFlash2 drafter, tunes it (thorough: ~15-20 min once) and saves the preset. It then serves on
rem :18302 to check it; this script stops that server again: afk starts the preset itself on :18301.
rem After `strata update` (new engine) run this again: the preset is re-tuned for the new engine (--retune).
setlocal
chcp 65001 >nul
set "STRATA=%LOCALAPPDATA%\Strata\terminal\current\bin\strata.cmd"
if not "%STRATA_DATA_DIR%"=="" set "STRATA=%STRATA_DATA_DIR%\terminal\current\bin\strata.cmd"
if not exist "%STRATA%" (
  echo Strata не установлен: нет %STRATA%
  echo Установите Strata Terminal: https://github.com/Niko1221/Strata
  exit /b 1
)
set "MODELS=%AFK_MODELS_DIR%"
if "%MODELS%"=="" set "MODELS=C:\Models"
set "MODEL=%MODELS%\ISTA-DASLab__Qwen3.8-Flash-Next-GSQ-RCO-GGUF\IQ3_XXS"
if not exist "%MODEL%\Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf" (
  echo Нет модели в %MODEL%
  echo Скачайте IQ3_XXS из https://huggingface.co/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF
  exit /b 1
)
rem no update checks and no prompts; the drafter vocabulary keeps Cyrillic tokens (Russian answers draft well)
set STRATA_UPDATE_CHECK=0
call "%STRATA%" launch --model-path "%MODEL%" --model iq3_xxs --context 256k --vision cpu --parallel 1 ^
  --tune thorough --retune --port 18302 --draft-vocab cyrillic --save-preset afk-flash --yes --no-tui
if errorlevel 1 exit /b 1
call "%STRATA%" launch --stop --preset afk-flash >nul 2>&1
echo.
echo Готово: пресет afk-flash. Запуск: scripts\harness.cmd -Model flash  или  scripts\afk.cmd api -m flash
