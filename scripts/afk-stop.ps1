# One click: stop everything scripts\harness.cmd started and free the VRAM. Counterpart of harness.cmd.
#   - DeepSeek Harness (also when only its tray icon is left) with its MCP children (Playwright browser, ...);
#   - the "AFKLLM: прокси" window (`afk api`) and the "llama-server" window (scripts\afk-llama.ps1, `afk llama`);
#   - every llama-server.exe (afk api restarts it detached after a model switch or an image) and the Strata server
#     afk started for the profile flash (with its engine);
#   - ComfyUI that afk api starts for image generation (port 8190), the offline translator (mt-server.py) and the
#     harness-watch window.
# Other node / python processes (other projects, MCP servers of other apps) are not touched.
#   scripts\afk-stop.cmd             everything above
#   scripts\afk-stop.cmd -KeepHarness only the model side: Harness stays open
param([switch]$KeepHarness)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

function VramUsed {
  try { [int]((& nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits) | Select-Object -First 1) } catch { -1 }
}

# taskkill /T: the process with its whole tree (llama-server under `afk llama`, Playwright under Harness)
function Stop-Tree([int]$id, [string]$what) {
  if (Get-Process -Id $id -ErrorAction SilentlyContinue) {
    $null = & taskkill.exe /PID $id /T /F 2>&1
    Write-Host "  остановлено: $what (PID $id)"
    $script:stopped++
  }
}

$before = VramUsed
$stopped = 0
Write-Host 'Останавливаю AFKLLM...'

$procs = @(Get-CimInstance Win32_Process)
function Find([scriptblock]$match) { $procs | Where-Object $match }

if (-not $KeepHarness) {
  # the main Harness process = the one whose parent is not Harness itself; the rest are its children
  $harness = @(Find { $_.Name -eq 'DeepSeek Harness.exe' })
  $hids = $harness | ForEach-Object { $_.ProcessId }
  foreach ($p in $harness | Where-Object { $hids -notcontains $_.ParentProcessId }) { Stop-Tree $p.ProcessId 'DeepSeek Harness' }
}

foreach ($p in Find { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*AFKLLM: прокси*' }) { Stop-Tree $p.ProcessId "окно 'AFKLLM: прокси'" }
foreach ($p in Find { $_.Name -match '^(powershell|pwsh)\.exe$' -and $_.CommandLine -like '*afk-llama.ps1*' }) { Stop-Tree $p.ProcessId "окно 'llama-server'" }
# `afk api` / `afk llama` started some other way (a terminal, scripts\afk.cmd)
foreach ($p in Find { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*src\cli\main.ts*' -and $_.CommandLine -match '\s(api|llama)(\s|$)' }) { Stop-Tree $p.ProcessId 'afk' }
foreach ($p in Find { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*harness-watch.mjs*' }) { Stop-Tree $p.ProcessId 'harness-watch' }
foreach ($p in Find { $_.Name -eq 'python.exe' -and $_.CommandLine -like '*ComfyUI*main.py*' -and $_.CommandLine -match '--port\s+8190\b' }) { Stop-Tree $p.ProcessId 'ComfyUI (картинки)' }
# the offline translator afk api starts on demand (it also exits by itself after 15 min idle)
foreach ($p in Find { $_.Name -eq 'python.exe' -and $_.CommandLine -like '*mt-server.py*' }) { Stop-Tree $p.ProcessId 'переводчик' }
# whatever is left of the model: detached restarts, leftovers of a crashed proxy
foreach ($p in Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue) { Stop-Tree $p.Id 'llama-server' }
# Strata (profile flash): the Python server afk started on its config in ~/.afkllm/strata, with the engine under it
foreach ($p in Find { $_.Name -eq 'python.exe' -and $_.CommandLine -like '*serve.server*' -and $_.CommandLine -like '*.afkllm\strata\*' }) { Stop-Tree $p.ProcessId 'Strata (модель)' }
# an engine left without its server (the server was killed alone): it still holds the GPU and ~47 GB of RAM
$alive = @(Get-CimInstance Win32_Process | ForEach-Object { $_.ProcessId })
foreach ($p in Find { $_.Name -match '^strata(-vision)?\.exe$' -and $_.ExecutablePath -like "$env:LOCALAPPDATA\Strata\*" -and $alive -notcontains $_.ParentProcessId }) { Stop-Tree $p.ProcessId 'Strata (движок без сервера)' }

if (-not $stopped) { Write-Host '  ничего не запущено.' }

# the driver releases the memory a moment after the process exits
$after = VramUsed
for ($i = 0; $i -lt 10 -and $stopped -and $after -ge 0 -and $before - $after -lt 256; $i++) { Start-Sleep -Milliseconds 500; $after = VramUsed }
if ($after -ge 0) {
  $total = 0
  try { $total = [int]((& nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits) | Select-Object -First 1) } catch {}
  Write-Host ''
  Write-Host ("Видеопамять: занято {0:N0} из {1:N0} МБ (было {2:N0} МБ)" -f $after, $total, $before) -ForegroundColor Green
  if ($after -gt 2048) { Write-Host 'Остальное занимают другие программы (игры, браузер, редакторы).' -ForegroundColor Yellow }
}
