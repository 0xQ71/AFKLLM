# AFKLLM: prepare this PC in one go. Checks the hardware, recommends the model, downloads and sets it up, installs the
# DeepSeek Harness profile and puts the shortcuts on the desktop. Safe to run again: done steps are skipped.
#   scripts\setup.cmd                 recommended model for this PC (asks before big downloads and installs)
#   scripts\setup.cmd -Model flash    Qwen3.8-Flash-Next on Strata (64 GB RAM): ~72 GB download
#   scripts\setup.cmd -Model q38      Qwen3.8 27B on the GPU (16 GB VRAM): see README "Рекомендуемая модель"
#   scripts\setup.cmd -Yes            no questions
param([string]$Model = '', [switch]$Yes, [string]$ModelsDir = '')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$root = Split-Path -Parent $PSScriptRoot
if (-not $ModelsDir) { $ModelsDir = if ($env:AFK_MODELS_DIR) { $env:AFK_MODELS_DIR } else { 'C:\Models' } }

function Step([string]$t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }
function Ok([string]$t) { Write-Host "  ✓ $t" -ForegroundColor Green }
function Warn([string]$t) { Write-Host "  ! $t" -ForegroundColor Yellow }
function Ask([string]$q) {
  if ($Yes) { return $true }
  $a = Read-Host "  $q [Y/n]"
  return (-not $a) -or ($a -match '^(y|д|да|yes)$')
}

# ---------------------------------------------------------------- 1. hardware
Step 'Железо'
$os = Get-CimInstance Win32_OperatingSystem
$ramGb = [math]::Round($os.TotalVisibleMemorySize / 1MB)
$commitGb = [math]::Round($os.TotalVirtualMemorySize / 1MB)
$vramMb = 0; $gpu = ''
try {
  $line = (& nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits | Select-Object -First 1)
  $gpu, $vram = $line -split ',\s*'; $vramMb = [int]$vram
} catch {}
Write-Host ("  ОЗУ {0} ГБ, лимит выделения (ОЗУ + подкачка) {1} ГБ, видеокарта: {2}" -f $ramGb, $commitGb, $(if ($gpu) { "$gpu, $([math]::Round($vramMb / 1024)) ГБ" } else { 'NVIDIA не найдена' }))
if (-not $gpu) { throw 'Нужна видеокарта NVIDIA (CUDA): обе модели работают на ней.' }

$rec = if ($ramGb -ge 60 -and $vramMb -ge 11000) { 'flash' } elseif ($vramMb -ge 15000) { 'q38' } else { '' }
switch ($rec) {
  'flash' { Ok 'рекомендую flash: Qwen3.8-Flash-Next на Strata, контекст 256K, самая сильная и быстрая модель для этого ПК' }
  'q38' { Ok 'рекомендую q38: Qwen3.8 27B целиком на видеокарте, контекст 104K (для flash нужно 64 ГБ ОЗУ)' }
  default { Warn 'для готовых профилей нужно 16 ГБ видеопамяти (или 12+ ГБ и 64 ГБ ОЗУ для flash); свой профиль — в ~/.afkllm/cli.json' }
}
if (-not $Model) { $Model = $rec }
if (-not $Model) { exit 1 }

# ---------------------------------------------------------------- 2. the model
if ($Model -eq 'flash') {
  Step 'Модель flash (Qwen3.8-Flash-Next IQ3_XXS, ~72 ГБ)'
  if ($ramGb -lt 60) { Warn "у этого ПК $ramGb ГБ ОЗУ, flash рассчитан на 64 ГБ: загрузится, но может не хватить памяти" }
  if ($commitGb -lt 96) {
    Warn ("лимит выделения {0} ГБ, нужно ~96: увеличьте файл подкачки на {1} ГБ (Параметры системы → Дополнительно → " +
          'Быстродействие → Дополнительно → Виртуальная память, на NVMe), иначе Strata выключит кэш разговоров') -f $commitGb, (96 - $commitGb)
  } else { Ok "лимит выделения $commitGb ГБ" }

  $dir = Join-Path $ModelsDir 'ISTA-DASLab__Qwen3.8-Flash-Next-GSQ-RCO-GGUF\IQ3_XXS'
  $need = @('Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf', 'Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00002-of-00002.gguf', 'mmproj-Qwen3.8-Flash-Next-BF16.gguf')
  $missing = @($need | Where-Object { -not (Test-Path (Join-Path $dir "$_.verified")) })
  if ($missing.Count) {
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) { throw 'Нужен Python 3.10+ (python.org) для загрузчика моделей.' }
    $drive = (Split-Path -Qualifier $ModelsDir)
    $freeGb = [math]::Round((Get-PSDrive ($drive.TrimEnd(':'))).Free / 1GB)
    Write-Host "  на диске $drive свободно $freeGb ГБ"
    if (Ask "Скачать (или проверить уже скачанные) файлы модели в $dir ?") {
      & $python.Source -u (Join-Path $root 'scripts\stage0\download-models.py') --flash --root $ModelsDir
      if ($LASTEXITCODE) { throw 'загрузка модели не удалась (запустите setup ещё раз: докачает)' }
    } else { throw 'без модели дальше нельзя' }
  } else { Ok "модель скачана и проверена ($dir)" }

  Step 'Strata (движок для моделей больше видеокарты)'
  $strata = Join-Path $env:LOCALAPPDATA 'Strata\terminal\current\bin\strata.cmd'
  if (-not (Test-Path $strata)) {
    Write-Host '  Strata Terminal ставится официальным установщиком: https://github.com/Niko1221/Strata (MIT),'
    Write-Host '  в %LOCALAPPDATA%\Strata, без прав администратора и без изменения PATH.'
    if (Ask 'Установить Strata Terminal?') {
      $env:STRATA_UPDATE_CHECK = '0'
      Invoke-RestMethod -TimeoutSec 120 'https://github.com/Niko1221/Strata/releases/latest/download/install.ps1' | Invoke-Expression
    } else { throw 'без Strata профиль flash не запустится' }
  } else { Ok 'Strata установлена' }

  if (-not (Test-Path (Join-Path $env:LOCALAPPDATA 'Strata\launch\afk-flash.json'))) {
    Write-Host '  настраиваю пресет afk-flash: подготовка модели, драфтер, подбор настроек (5-15 минут)'
    & cmd.exe /c "`"$root\scripts\strata-setup.cmd`""
    if ($LASTEXITCODE) { throw 'strata-setup не удался' }
  } else { Ok 'пресет Strata afk-flash готов' }
} elseif ($Model -eq 'q38') {
  Step 'Модель q38'
  $q = Join-Path $ModelsDir 'baa-ai__Qwen3.8-27B-RAM-13GB-GGUF\Qwen3.8-27B-RAM-13GB-MTP-o5.gguf'
  if (Test-Path $q) { Ok "модель есть: $q" } else { Warn 'соберите файл модели по README, раздел «Рекомендуемая модель» (скачать + склеить MTP)' }
  $ls = Join-Path $ModelsDir 'llama.cpp\b12063\llama-server.exe'
  if (Test-Path $ls) { Ok 'llama.cpp b12063 есть' } elseif (Ask 'Скачать llama.cpp b12063 и всё для картинок?') {
    & python -u (Join-Path $root 'scripts\stage0\download-models.py') --root $ModelsDir
  }
}

# the model new sessions start on (afk picks flash by itself when it is ready; this pins the choice)
$cfgPath = Join-Path $env:USERPROFILE '.afkllm\cli.json'
$cfg = if (Test-Path $cfgPath) { Get-Content $cfgPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
if ($cfg.PSObject.Properties['defaultProfile']) { $cfg.defaultProfile = $Model } else { $cfg | Add-Member defaultProfile $Model }
New-Item -ItemType Directory -Force (Split-Path $cfgPath) | Out-Null
[IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))
Ok "модель по умолчанию: $Model (~/.afkllm/cli.json)"

# offline translator (CPU): Harness reasoning en->ru and /image prompts ru->en without the internet
Step 'Офлайн-переводчик (рассуждения на русском, /image по-русски)'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\mt-setup.ps1')
if ($LASTEXITCODE) { Warn 'переводчик не установлен: рассуждения останутся на английском (повторите scripts\mt-setup.cmd)' }

# ---------------------------------------------------------------- 3. DeepSeek Harness
Step 'DeepSeek Harness'
$harness = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
if (Test-Path $harness) {
  if (Test-Path (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'harness\install-profile.ps1')
  } else { Warn 'запустите DeepSeek Harness один раз (создаст профиль desktop) и повторите setup' }
} else { Warn 'DeepSeek Harness не установлен: поставьте его, потом повторите setup (работает и без него: scripts\afk.cmd)' }

# ---------------------------------------------------------------- 4. shortcuts
Step 'Ярлыки на рабочем столе'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\make-shortcuts.ps1')

Write-Host ''
Write-Host 'Готово. Запуск: ярлык «AFKLLM — запустить» (или scripts\harness.cmd).' -ForegroundColor Green
