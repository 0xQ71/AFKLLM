# Desktop shortcuts for AFKLLM (scripts\setup.cmd runs this; safe to run again, it replaces its own shortcuts):
#   «AFKLLM — запустить»          scripts\harness.cmd: the default model (flash on a 64 GB PC) + proxy + DeepSeek Harness
#   «AFKLLM — остановить модель»  scripts\afk-stop.cmd -KeepHarness: frees the GPU and RAM, Harness stays open
#   «AFKLLM — выключить всё»      scripts\afk-stop.cmd: model, proxy, ComfyUI and DeepSeek Harness
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$desk = [Environment]::GetFolderPath('Desktop')
$sh = New-Object -ComObject WScript.Shell
$harnessExe = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
$shell32 = Join-Path $env:SystemRoot 'System32\shell32.dll'

# older AFKLLM shortcuts that pointed into this repo
foreach ($old in 'AFKLLM + DeepSeek Harness.lnk', 'AFKLLM - остановить.lnk') {
  $p = Join-Path $desk $old
  if ((Test-Path $p) -and $sh.CreateShortcut($p).TargetPath -like "$root\*") { Remove-Item $p }
}

function Make([string]$name, [string]$target, [string]$arguments, [string]$icon, [string]$tip) {
  $l = $sh.CreateShortcut((Join-Path $desk "$name.lnk"))
  $l.TargetPath = $target
  $l.Arguments = $arguments
  $l.WorkingDirectory = $root
  $l.IconLocation = $icon
  $l.Description = $tip
  $l.Save()
  Write-Host "  ✓ $name"
}

$startIcon = if (Test-Path $harnessExe) { "$harnessExe,0" } else { "$shell32,137" }
Make 'AFKLLM — запустить' (Join-Path $root 'scripts\harness.cmd') '' $startIcon 'Модель по умолчанию + прокси + DeepSeek Harness'
Make 'AFKLLM — остановить модель' (Join-Path $root 'scripts\afk-stop.cmd') '-KeepHarness' "$shell32,109" 'Выгрузить модель (освободить видеокарту и ОЗУ), DeepSeek Harness оставить'
Make 'AFKLLM — выключить всё' (Join-Path $root 'scripts\afk-stop.cmd') '' "$shell32,27" 'Остановить модель, прокси, ComfyUI и закрыть DeepSeek Harness'
