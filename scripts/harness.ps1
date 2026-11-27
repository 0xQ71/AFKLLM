# One click: the local model + DeepSeek Harness on top of it. Windows: "llama-server" (the model and its live
# progress, scripts\afk-llama.ps1) and "AFKLLM: прокси" (afk api: /v1, MCP tools, search, image generation).
#   scripts\harness.cmd                 default model (flash with 64 GB RAM and Strata set up, else q38) + Harness, no questions
#   scripts\harness.cmd -Ask            asks which model to load first (Enter = default)
#   scripts\harness.cmd -Model q38-128k this profile (list: scripts\afk.cmd models)
#   scripts\harness.cmd -Watch          ...and a window that shows what the agent is doing (scripts/harness-watch.mjs)
#   scripts\harness.cmd -NoHarness      only the model
# The chosen model also becomes the default for new Harness chats; the Harness model picker switches it later
# (afk api reloads llama with the profile a request names).
# Settings live in one place each: sampling / context / llama flags in src/core/server.ts (profile q38: temp 0.6,
# top_p 0.95, top_k 20, min_p 0, presence 0, thinking always on, 16K thinking per step), the Harness side in
# ~/.dsh/profiles/desktop/cordis.patch.yml (provider afkllm, compaction, MCP tools) and ~/.dsh/AGENTS.md (agent rules).
param([string]$Model = '', [switch]$Ask, [switch]$Watch, [switch]$NoHarness, [int]$Port = 18300)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$afk = Join-Path $root 'scripts\afk.cmd'
$harnessExe = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
$harnessPatch = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'

# The Harness provider reads its key from AFKLLM_API_KEY (llama-server needs none, any value works). Saved for the
# user too, so Harness started from the Start menu or the tray finds it as well.
$env:AFKLLM_API_KEY = 'local'
if ([Environment]::GetEnvironmentVariable('AFKLLM_API_KEY', 'User') -ne 'local') {
  [Environment]::SetEnvironmentVariable('AFKLLM_API_KEY', 'local', 'User')
}

# Model profiles: afk's own list (built-in + ~/.afkllm/cli.json)
# (Windows PowerShell 5.1 returns a JSON array as one object: enumerate it). The first run after a reboot takes
# ~10 s (node/tsx cold start + antivirus scan) with nothing on screen, so say what is going on.
Write-Host 'AFKLLM: читаю список моделей (после перезагрузки до ~15 с)...'
$json = & $afk models --json | ConvertFrom-Json
$profiles = @($json | ForEach-Object { $_ })
if (-not $profiles.Count) { throw 'afk models вернул пустой список' }
$def = ($profiles | Where-Object { $_.default } | Select-Object -First 1).name
if (-not $def) { $def = $profiles[0].name }
if (-not $Model -and -not $Ask) { $Model = $def }
if (-not $Model) {
  Write-Host 'Какую модель загрузить?'
  for ($i = 0; $i -lt $profiles.Count; $i++) {
    $p = $profiles[$i]
    $mark = if ($p.name -eq $def) { '*' } else { ' ' }
    $miss = if ($p.available) { '' } else { '  (нет файла модели)' }
    Write-Host ("  {0}{1}) {2,-10} {3} · контекст {4}K{5}" -f $mark, ($i + 1), $p.name, $p.label, [int]($p.ctx / 1024), $miss)
  }
  $ans = Read-Host "Номер или имя (Enter = $def)"
  if (-not $ans) { $Model = $def }
  elseif ($ans -match '^\d+$' -and [int]$ans -ge 1 -and [int]$ans -le $profiles.Count) { $Model = $profiles[[int]$ans - 1].name }
  else { $Model = $ans.Trim() }
}
$chosen = $profiles | Where-Object { $_.name -eq $Model } | Select-Object -First 1
if (-not $chosen -and $Model -notmatch '\.gguf$') { throw "нет такого профиля: $Model (есть: $(($profiles | ForEach-Object { $_.name }) -join ', '))" }

# New Harness chats start on the chosen model. The q38 entry keeps the .gguf path as its id (older sessions use it).
if ($chosen -and (Test-Path $harnessPatch)) {
  $id = if ($chosen.name -eq 'q38') { $chosen.model } else { $chosen.name }
  $text = [IO.File]::ReadAllText($harnessPatch)
  $rx = New-Object Text.RegularExpressions.Regex('(?ms)(^- id: agent-default-model\b.*?^\s+model: )[^\r\n]*')
  $new = $rx.Replace($text, [Text.RegularExpressions.MatchEvaluator] { param($m) $m.Groups[1].Value + $id }, 1)
  if ($new -ne $text) { [IO.File]::WriteAllText($harnessPatch, $new, (New-Object Text.UTF8Encoding $false)) }
}

function Test-Up([int]$p) {
  try { (Invoke-WebRequest "http://127.0.0.1:$p/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $false }
}
function Test-Model { Test-Up $Port }
function Wait-Up([int]$p, [string]$what, [string]$window) {
  $t = 0
  while (-not (Test-Up $p)) {
    Start-Sleep 1; $t++
    Write-Host -NoNewline "`r$what... $t с"
    # Strata (flash) reads ~47 GB into RAM: ~80 s, longer on the first start after a reboot
    if ($t -ge 300) { Write-Host ''; throw "$what`: нет ответа за 5 минут, посмотрите окно '$window'" }
  }
  Write-Host "`r$what`: готово за $t с          "
}

# Two windows, the model first:
#   "llama-server: <model>" — scripts\afk-llama.ps1 = `afk llama` on port+1 with its live progress (owns the model);
#   "AFKLLM: прокси"         — `afk api` on port: /v1 for Harness, MCP tools, search, image generation. It reuses the
#                              running llama, so the model and its KV cache survive the proxy stopping or crashing.
$llamaPort = $Port + 1
if (-not (Test-Model)) {
  if (Test-Up $llamaPort) {
    # a model window is already up: start the proxy on the model it serves, a switch (below) loads the chosen one
    $servedPath = ''
    $isStrata = $false
    try { $isStrata = (Invoke-RestMethod "http://127.0.0.1:$llamaPort/health" -TimeoutSec 5).service -eq 'strata' } catch {}
    if (-not $isStrata) { try { $servedPath = [string](Invoke-RestMethod "http://127.0.0.1:$llamaPort/props" -TimeoutSec 5).model_path } catch {} }
    $served = if ($isStrata) { ($profiles | Where-Object { $_.engine -eq 'strata' } | Select-Object -First 1).name }
              else { ($profiles | Where-Object { $_.model -eq $servedPath } | Select-Object -First 1).name }
    $apiModel = if ($served) { $served } else { $Model }
    Write-Host "llama-server уже работает ($apiModel)."
  } else {
    $apiModel = $Model
    Write-Host "Запускаю модель ($Model) в окне 'llama-server'..."
    Start-Process powershell.exe -ArgumentList '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$root\scripts\afk-llama.ps1`"", '-Model', "`"$Model`"", '-Port', $Port -WorkingDirectory $root
    Wait-Up $llamaPort 'загрузка модели' 'llama-server'
  }
  Write-Host "Запускаю прокси и инструменты в окне 'AFKLLM: прокси'..."
  Start-Process cmd.exe -ArgumentList '/k', "chcp 65001 >nul & title AFKLLM: прокси (127.0.0.1:$Port) & `"$afk`" api -m `"$apiModel`" --port $Port" -WorkingDirectory $root
  Wait-Up $Port 'прокси' 'AFKLLM: прокси'
  Write-Host "Модель: http://127.0.0.1:$Port/v1 (+ MCP /mcp, поиск /search)"
}

if (Test-Model) {
  # already up: ask it to load the chosen profile now (afk api switches on a request naming it)
  $loaded = $null
  try { $loaded = ((Invoke-RestMethod "http://127.0.0.1:$Port/v1/models" -TimeoutSec 5).data | Where-Object { $_.loaded } | Select-Object -First 1).id } catch {}
  if ($loaded -and $loaded -ne $Model) {
    Write-Host "Работает $loaded, переключаю на $Model (llama перезагружается)..."
    $body = @{ model = $Model; max_tokens = 1; messages = @(@{ role = 'user'; content = 'ok' }) } | ConvertTo-Json -Depth 4
    try { $null = Invoke-RestMethod "http://127.0.0.1:$Port/v1/chat/completions" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 600 }
    catch { Write-Warning "переключение не удалось: $($_.Exception.Message) (см. окна 'llama-server' и 'AFKLLM: прокси')" }
  }
  Write-Host "Модель работает на 127.0.0.1:$Port ($Model)"
}

if (-not $NoHarness) {
  if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) {
    Write-Host 'DeepSeek Harness уже открыт (модель для новых чатов применится после его перезапуска; в открытом чате выберите её в списке моделей).'
  } elseif (Test-Path $harnessExe) {
    Start-Process $harnessExe
    Write-Host 'DeepSeek Harness запущен.'
  } else {
    Write-Warning "не найден $harnessExe"
  }
}

if ($Watch) {
  Start-Process cmd.exe -ArgumentList '/k', "chcp 65001 >nul & node `"$root\scripts\harness-watch.mjs`""
}
