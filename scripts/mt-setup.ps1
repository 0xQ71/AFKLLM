# One-time setup of the offline translator that afk api runs on the CPU (src\core\translate.ts, scripts\mt-server.py):
#   DeepSeek Harness reasoning English -> Russian, /image prompts Russian -> English. No GPU, nothing leaves the PC.
#   1. a Python venv in %USERPROFILE%\.afkllm\mt\venv with CTranslate2 + SentencePiece (~60 MB)
#   2. OPUS-MT tc-big en->zle and zle->en (Helsinki-NLP, CC-BY 4.0) downloaded once from Hugging Face and converted to
#      CTranslate2 int8 in %AFK_MODELS_DIR% (default C:\Models)\mt (~470 MB); the converter (torch CPU + transformers,
#      ~1 GB) and the download cache are removed afterwards
#   3. mt-server.py copied to %USERPROFILE%\.afkllm\mt (afk.exe has no scripts folder), then a self-test
# Safe to run again: finished steps are skipped. Needs Python 3.10+ (python.org) on PATH.
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$root = Split-Path -Parent $PSScriptRoot
$mt = Join-Path $env:USERPROFILE '.afkllm\mt'
$venv = Join-Path $mt 'venv'
$py = Join-Path $venv 'Scripts\python.exe'
$models = if ($env:AFK_MODELS_DIR) { $env:AFK_MODELS_DIR } else { 'C:\Models' }
$out = Join-Path $models 'mt'
$pairs = @(
  @{ hf = 'Helsinki-NLP/opus-mt-tc-big-en-zle'; dir = 'opus-mt-tc-big-en-zle-ct2-int8'; what = 'английский -> русский (рассуждения)' },
  @{ hf = 'Helsinki-NLP/opus-mt-tc-big-zle-en'; dir = 'opus-mt-tc-big-zle-en-ct2-int8'; what = 'русский -> английский (промпты /image)' }
)
function Ok([string]$t) { Write-Host "  ✓ $t" -ForegroundColor Green }
function Info([string]$t) { Write-Host "  · $t" }

Write-Host '== Офлайн-переводчик (CPU)' -ForegroundColor Cyan
if (-not (Test-Path $py)) {
  $base = if (Get-Command python -ErrorAction SilentlyContinue) { 'python' } elseif (Get-Command py -ErrorAction SilentlyContinue) { 'py' } else { throw 'Нужен Python 3.10+ (https://www.python.org/downloads/), галочка "Add to PATH"' }
  Info "создаю окружение $venv"
  New-Item -ItemType Directory -Force $mt | Out-Null
  & $base -m venv $venv
  if ($LASTEXITCODE) { throw 'python -m venv не удался' }
}
& $py -m pip install -q --disable-pip-version-check 'ctranslate2==4.9.1' sentencepiece
if ($LASTEXITCODE) { throw 'pip install ctranslate2 sentencepiece не удался' }
Ok 'CTranslate2 и SentencePiece'

$todo = @($pairs | Where-Object { -not (Test-Path (Join-Path $out "$($_.dir)\model.bin")) })
if ($todo.Count) {
  Info 'ставлю конвертер (torch CPU + transformers, ~1 ГБ, удалю после)'
  & $py -m pip install -q --disable-pip-version-check torch --index-url https://download.pytorch.org/whl/cpu
  if ($LASTEXITCODE) { throw 'pip install torch не удался' }
  & $py -m pip install -q --disable-pip-version-check transformers sacremoses
  if ($LASTEXITCODE) { throw 'pip install transformers не удался' }
  $cache = Join-Path $out 'hf-cache'
  $env:HF_HOME = $cache; $env:HF_HUB_DISABLE_TELEMETRY = '1'
  foreach ($p in $todo) {
    Info "скачиваю и конвертирую $($p.hf): $($p.what)"
    & (Join-Path $venv 'Scripts\ct2-transformers-converter.exe') --model $p.hf --output_dir (Join-Path $out $p.dir) --quantization int8 --copy_files source.spm target.spm --force
    if ($LASTEXITCODE) { throw "конвертация $($p.hf) не удалась" }
  }
  Remove-Item -Recurse -Force $cache -ErrorAction SilentlyContinue
  & $py -m pip uninstall -q -y torch transformers sacremoses tokenizers safetensors huggingface-hub 2>$null
}
foreach ($p in $pairs) { Ok "$($p.what): $(Join-Path $out $p.dir)" }

Copy-Item (Join-Path $root 'scripts\mt-server.py') (Join-Path $mt 'mt-server.py') -Force
Ok "mt-server.py -> $mt"

Info 'проверка'
$port = 18399
while (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $port++ }
$srvArgs = @('-I', "`"$(Join-Path $mt 'mt-server.py')`"", '--port', $port, '--idle-exit', '60')
foreach ($p in $pairs) { $srvArgs += @('--model', "`"$(if ($p.dir -like '*-en-zle-*') { 'en-ru' } else { 'ru-en' })=$(Join-Path $out $p.dir)`"") }
$srv = Start-Process -FilePath $py -ArgumentList $srvArgs -WindowStyle Hidden -PassThru
try {
  $ok = $false
  for ($i = 0; $i -lt 60 -and -not $ok; $i++) { Start-Sleep -Milliseconds 500; if ($srv.HasExited) { throw "переводчик завершился с кодом $($srv.ExitCode)" }; try { $ok = (Invoke-WebRequest "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch {} }
  if (-not $ok) { throw 'переводчик не запустился' }
  $post = { param($q, $t) (Invoke-RestMethod "http://127.0.0.1:$port/translate/translatetext?$q" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json @($t) -Compress))))[0].translations[0].text }
  Ok ("en->ru: " + (& $post 'to=ru' 'The build passes, now I will write the camera spline.'))
  Ok ("ru->en: " + (& $post 'from=ru&to=en' 'рассвет над озером, туман над водой'))
} finally {
  Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
}
Write-Host ''
Write-Host 'Готово. afk api запускает переводчик сам при первом запросе (DeepSeek Harness: раскрыть блок мыслей; /image по-русски).'
