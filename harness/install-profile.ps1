# Installs the AFKLLM setup into a DeepSeek Harness profile (default: the desktop app's profile "desktop"):
#   - harness\dsh-profile\cordis.patch.yml -> <DSH_HOME>\profiles\<profile>\cordis.patch.yml (the old one is kept as .bak-<date>)
#     provider "afkllm" (afk api on 127.0.0.1:18300, models q38 / q38-128k / q38-160k / flash), presets "AFKLLM" and
#     "AFKLLM + браузер", compaction for local windows, MCP tools of afk api + Context7, permission preset
#     workspace-auto, no telemetry
#   - the bundles from harness\dsh-profile\bundles.json (reasoning translation, session search, ...) into the profile
#   - plugins dsh-web-search-afkllm (search card through afk api), dsh-image-afkllm (/image) and dsh-hooks-afkllm
#     (guard, syntax check after edits, Stop check, notifications, your hooks.json; /hooks) and dsh-screen-afkllm
#     (Ctrl+Alt+S / /screen: the screen with a test or a quest goes to the chat, the model solves it), linked from this repo
#   - agent rules harness\dsh-profile\AGENTS.md -> <DSH_HOME>\AGENTS.md and skills -> <DSH_HOME>\skills (existing ones
#     are not overwritten: a different AGENTS.md is saved next to it as AGENTS.afkllm.md)
#   - user environment variable AFKLLM_API_KEY=local (the provider needs a key; llama-server accepts any)
# Run DeepSeek Harness once before this (it creates the profile). Then: scripts\harness.cmd
#   powershell -ExecutionPolicy Bypass -File harness\install-profile.ps1 [-Profile desktop] [-DshHome <dir>]
param([string]$Profile = 'desktop', [string]$DshHome = '')
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$src = Join-Path $PSScriptRoot 'dsh-profile'
if (-not $DshHome) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' } }
$env:DSH_HOME = $DshHome
$dsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
if (-not (Test-Path $dsh)) { throw "DeepSeek Harness не найден ($dsh). Установи его и запусти один раз." }
$prof = Join-Path $DshHome "profiles\$Profile"
if (-not (Test-Path (Join-Path $prof 'package.json'))) { throw "Нет профиля $prof. Запусти DeepSeek Harness один раз, чтобы он его создал." }
$utf8 = New-Object Text.UTF8Encoding $false
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# 1. profile patch
$patch = Join-Path $prof 'cordis.patch.yml'
if (Test-Path $patch) { Copy-Item $patch "$patch.bak-$stamp"; Write-Host "старый патч: $patch.bak-$stamp" }
Copy-Item (Join-Path $src 'cordis.patch.yml') $patch -Force

# 2. bundles (kept: whatever the profile already had)
$pkgPath = Join-Path $prof 'package.json'
Copy-Item $pkgPath "$pkgPath.bak-$stamp"
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{ profile = [pscustomobject]@{ bundles = @() } }) }
if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{ bundles = @() }) }
$have = @($pkg.dsh.profile.bundles)
$want = @(Get-Content (Join-Path $src 'bundles.json') -Raw | ConvertFrom-Json | ForEach-Object { $_ })
$all = @($have + ($want | Where-Object { $have -notcontains $_ }))
if ($pkg.dsh.profile.PSObject.Properties['bundles']) { $pkg.dsh.profile.bundles = $all }
else { $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $all }
[IO.File]::WriteAllText($pkgPath, ($pkg | ConvertTo-Json -Depth 20), $utf8)

# 3. plugins of this repo, linked (an update of the repo updates them)
foreach ($p in 'dsh-web-search-afkllm', 'dsh-image-afkllm', 'dsh-hooks-afkllm', 'dsh-screen-afkllm') {
  $link = 'link:' + ((Join-Path $PSScriptRoot $p) -replace '\\', '/')
  & $dsh plugin --profile $Profile add $link
  if ($LASTEXITCODE) { throw "dsh plugin add ${link}: код $LASTEXITCODE" }
}

# 4. agent rules and skills
$rules = Join-Path $DshHome 'AGENTS.md'
$newRules = Join-Path $src 'AGENTS.md'
if (-not (Test-Path $rules)) { Copy-Item $newRules $rules }
elseif ((Get-FileHash $rules).Hash -ne (Get-FileHash $newRules).Hash) {
  Copy-Item $newRules (Join-Path $DshHome 'AGENTS.afkllm.md') -Force
  Write-Host "у тебя уже есть ${rules}: правила AFKLLM положены рядом, AGENTS.afkllm.md (перенеси нужное сам)"
}
foreach ($d in Get-ChildItem (Join-Path $src 'skills') -Directory) {
  $to = Join-Path $DshHome "skills\$($d.Name)"
  if (Test-Path $to) { Write-Host "навык $($d.Name) уже есть, не трогаю" } else { Copy-Item $d.FullName $to -Recurse }
}

# 5. the key the provider reads
if ([Environment]::GetEnvironmentVariable('AFKLLM_API_KEY', 'User') -ne 'local') {
  [Environment]::SetEnvironmentVariable('AFKLLM_API_KEY', 'local', 'User')
}
$env:AFKLLM_API_KEY = 'local'

# 6. the composed profile must load. The desktop profile belongs to the Electron app (dsh refuses to boot it), so a copy
#    under another name in a throwaway DSH_HOME is composed instead.
$check = Join-Path $env:TEMP "afkllm-dsh-check-$stamp"
New-Item -ItemType Directory -Force (Join-Path $check 'profiles') | Out-Null
Copy-Item $prof (Join-Path $check 'profiles\afkcheck') -Recurse
$env:DSH_HOME = $check
& $dsh --profile afkcheck --dump-config | Out-Null
$code = $LASTEXITCODE
$env:DSH_HOME = $DshHome
Remove-Item $check -Recurse -Force -ErrorAction SilentlyContinue
if ($code) { throw "профиль $Profile не собирается (dsh --dump-config: код $code); старые файлы: *.bak-$stamp" }
Write-Host "готово: профиль $Profile настроен на AFKLLM. Запуск: $repo\scripts\harness.cmd"
