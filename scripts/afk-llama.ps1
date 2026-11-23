# The llama-server window: `afk llama` (the model alone, on port+1 = 18301) and its live work under it, in Russian:
# prompt reading progress, generation speed, MTP acceptance, how full the context is, image encoding, errors.
# Started by scripts\harness.ps1 before `afk api`, which then reuses this model; the model and its KV cache survive
# the proxy stopping or crashing. Run alone: powershell -File scripts\afk-llama.ps1 [-Model q38] [-Port 18300]
# Ctrl+C or closing the window stops the model.
param([string]$Model = 'q38', [int]$Port = 18300)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$afk = Join-Path $root 'scripts\afk.cmd'
$llamaPort = $Port + 1
$log = Join-Path $env:USERPROFILE ".afkllm\logs\llama-server-$llamaPort.log"
$Host.UI.RawUI.WindowTitle = "llama-server: $Model · 127.0.0.1:$llamaPort"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

# start reading where the old log ends: a new llama-server rewrites the file (detected below by it getting shorter)
$pos = if (Test-Path $log) { (Get-Item $log).Length } else { 0L }
$proc = Start-Process $afk -ArgumentList 'llama', '-m', $Model, '--port', $llamaPort -NoNewWindow -PassThru -WorkingDirectory $root

$ctxMax = 0
$statusLen = 0
$lastGen = $null
$imgT0 = $null
function Status([string]$s) {
  $pad = [Math]::Max(0, $script:statusLen - $s.Length)
  [Console]::Write("`r" + $s + (' ' * $pad))
  $script:statusLen = $s.Length
}
function Say([string]$s, [string]$color = 'Gray') {
  if ($script:statusLen) { [Console]::Write("`r" + (' ' * $script:statusLen) + "`r"); $script:statusLen = 0 }
  Write-Host $s -ForegroundColor $color
}
function N([double]$v) { '{0:N0}' -f $v }
function Listening([int]$p) { [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) }

# After a model switch or an image, afk api restarts llama-server on its own (detached) and `afk llama` here exits.
# The window keeps following the log while a model listens on llamaPort or the proxy is up (an image is being drawn
# and the model comes back); it ends only when both are gone.
$handedOver = $false
$done = $false
$lastCheck = [DateTime]::MinValue
function Alive {
  if (-not $proc.HasExited) { return $true }
  if (((Get-Date) - $script:lastCheck).TotalSeconds -lt 3) { return $true }
  $script:lastCheck = Get-Date
  $up = (Listening $llamaPort) -or (Listening $Port)
  if ($up -and -not $script:handedOver) {
    $script:handedOver = $true
    Say '  llama: модель перезапущена прокси (afk api), окно продолжает показывать её работу' 'DarkGray'
  }
  return $up
}

try {
$title = "llama-server: $Model · 127.0.0.1:$llamaPort"
while (Alive) {
  Start-Sleep -Milliseconds 400
  if ($Host.UI.RawUI.WindowTitle -ne $title) { $Host.UI.RawUI.WindowTitle = $title }  # cmd (afk.cmd) renames the window
  if (-not (Test-Path $log)) { continue }
  $len = (Get-Item $log).Length
  if ($len -lt $pos) { $pos = 0; Say '  llama: новый запуск сервера (смена модели или возврат после картинки)' 'DarkGray' }
  if ($len -eq $pos) { continue }
  $fs = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
  try {
    $null = $fs.Seek($pos, 'Begin')
    $chunk = (New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)).ReadToEnd()
    $pos = $fs.Position
  } finally { $fs.Dispose() }
  foreach ($l in ($chunk -split "`r?`n")) {
    if ($l -match 'n_ctx_slot = (\d+)') { $ctxMax = [int]$Matches[1]; Say ("  модель загружена, контекст {0} ток" -f (N $ctxMax)) 'DarkGray' }
    elseif ($l -match 'launch_slot_: .*processing task') { $imgT0 = Get-Date }
    elseif ($l -match 'non-consecutive token position .* with 256 new tokens' -and $imgT0) {
      # an image enters the context: the time since the request started went to the vision projector (on the CPU)
      $sec = ((Get-Date) - $imgT0).TotalSeconds
      if ($sec -ge 1) { Say ("  картинка: кодирование ~{0:N0} с (проектор зрения на CPU)" -f $sec) 'Yellow' }  # the 2nd 256-token batch of the same image
      $imgT0 = $null
    }
    elseif ($l -match 'non-consecutive token position .* with (\d+) new tokens' -and [int]$Matches[1] -lt 248) { $imgT0 = Get-Date }  # text between two images
    elseif ($l -match 'prompt processing, n_tokens =\s*(\d+), progress = ([\d.]+), t =\s*([\d.]+) s / ([\d.]+) tokens per second') {
      $imgT0 = Get-Date
      Status ("  читаю промпт: {0,3:N0}%  {1} ток · {2:N0} t/s" -f ([double]$Matches[2] * 100), (N $Matches[1]), [double]$Matches[4])
    }
    elseif ($l -match 'prompt eval time =\s*([\d.]+) ms /\s*(\d+) tokens.*?([\d.]+) tokens per second') {
      if ([int]$Matches[2] -ge 64) { Say ("  промпт: {0} новых ток за {1:N1} с ({2:N0} t/s)" -f (N $Matches[2]), ([double]$Matches[1] / 1000), [double]$Matches[3]) 'DarkCyan' }
    }
    elseif ($l -match 'n_gen =\s*(\d+), tg =\s*([\d.]+) t/s') { Status ("  пишу: {0} ток · {1:N1} t/s" -f (N $Matches[1]), [double]$Matches[2]) }
    elseif ($l -match '\|\s+eval time =\s*([\d.]+) ms /\s*(\d+) tokens.*?([\d.]+) tokens per second') {
      $lastGen = ("  ответ: {0} ток за {1:N1} с · {2:N1} t/s" -f (N $Matches[2]), ([double]$Matches[1] / 1000), [double]$Matches[3])
    }
    elseif ($l -match 'draft acceptance = ([\d.]+)') { $lastGen += ("  · MTP угадал {0:N0}%" -f ([double]$Matches[1] * 100)) }
    elseif ($l -match 'stop processing: n_tokens = (\d+)') {
      $used = [int]$Matches[1]
      if (-not $ctxMax) {  # joined a running server: its load lines were before our start
        try { $ctxMax = [int](Invoke-RestMethod "http://127.0.0.1:$llamaPort/props" -TimeoutSec 3).default_generation_settings.n_ctx } catch {}
      }
      $pct = if ($ctxMax) { ' ({0:N0}%)' -f (100 * $used / $ctxMax) } else { '' }
      if ($lastGen) { Say $lastGen 'Green'; $lastGen = $null }
      Say ("  контекст: {0} / {1} ток{2}" -f (N $used), (N $ctxMax), $pct) 'DarkGray'
    }
    # ---- Strata (profile flash): its server prints plain progress lines ----
    elseif ($l -match '^\[strata\] (still starting \((\d+) s\)|experts loaded: ([\d.]+) GiB|filling the GPU''s expert cache|almost ready)') {
      $what = if ($Matches[2]) { "загрузка: {0} с" -f $Matches[2] } elseif ($Matches[3]) { "эксперты в RAM: {0} GiB" -f $Matches[3] } elseif ($l -match 'filling') { 'заполняю кэш экспертов на GPU' } else { 'почти готово' }
      Status "  Strata: $what"
    }
    elseif ($l -match '^ready: http.*context (\d+) tokens') { $ctxMax = [int]$Matches[1]; Say ("  модель загружена (Strata), контекст {0} ток" -f (N $ctxMax)) 'DarkGray' }
    elseif ($l -match '^\[strata\] reading the prompt: ([\d,]+) of ([\d,]+) tokens, (\d+) s so far') {
      $a = [double]($Matches[1] -replace ',', ''); $b = [double]($Matches[2] -replace ',', ''); $s = [double]$Matches[3]
      Status ("  читаю промпт: {0,3:N0}%  {1} ток · {2:N0} t/s" -f (100 * $a / [Math]::Max(1, $b)), (N $a), ($a / [Math]::Max(1, $s)))
    }
    elseif ($l -match '^\[strata\] done: (\d+) tokens in (\d+) s \(([\d.]+) tok/s\)(?:.*expert cache ([\d.]+)% hit)?') {
      $hit = if ($Matches[4]) { "  · эксперты в VRAM {0}%" -f $Matches[4] } else { '' }
      Say ("  ответ: {0} ток за {1} с · {2:N1} t/s{3}" -f (N $Matches[1]), $Matches[2], [double]$Matches[3], $hit) 'Green'
      try {
        $used = [int](Invoke-RestMethod "http://127.0.0.1:$llamaPort/slots" -TimeoutSec 3)[0].n_prompt_tokens
        $pct = if ($ctxMax) { ' ({0:N0}%)' -f (100 * $used / $ctxMax) } else { '' }
        Say ("  контекст: {0} / {1} ток{2}" -f (N $used), (N $ctxMax), $pct) 'DarkGray'
      } catch {}
    }
    elseif ($l -match '^\[strata\] thinking budget reached') { Say '  размышление упёрлось в бюджет, модель переходит к ответу' 'Yellow' }
    elseif ($l -match '^\S+ E ' -or $l -match 'CUDA error|out of memory|Traceback|engine (stopped|exited)') { Say ("  ошибка модели: " + $l.Trim()) 'Red' }
  }
}
$done = $true
Say "llama-server остановлен (afk llama, код $($proc.ExitCode))." 'Yellow'
} finally {
  # Ctrl+C: this window owns the model, also the one afk api restarted detached. The whole tree: Strata's port belongs
  # to its Python server, and the engine holding the GPU and ~47 GB of RAM is its child.
  if (-not $done) {
    Get-NetTCPConnection -State Listen -LocalPort $llamaPort -ErrorAction SilentlyContinue |
      ForEach-Object { taskkill /PID $_.OwningProcess /T /F 2>$null | Out-Null }
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  }
}
