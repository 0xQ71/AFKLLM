# Verify AFKLLM NSIS installer locally.
#
# Usage:
#   npm run verify:installer              # smoke + report publisher status
#   npm run verify:installer -- -RequireSigned
#   powershell -File scripts/verify-installer.ps1 [-SetupPath path] [-SkipInstall] [-RequireSigned]
#
# Default: unsigned OK (local npm run dist). -RequireSigned fails unless Authenticode is Valid
# (expected after SignPath / CA-issued signing on CI).

[CmdletBinding()]
param(
  [string]$SetupPath = '',
  [switch]$SkipInstall,
  [switch]$RequireSigned,
  [string]$ExpectedPublisher = '',
  [int]$MinBytes = 40MB
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Ok([string]$msg) { Write-Host "  OK  $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host " WARN $msg" -ForegroundColor Yellow }
function Fail([string]$msg) {
  Write-Host " FAIL $msg" -ForegroundColor Red
  throw $msg
}

$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = [string]$pkg.version
if (-not $version) { Fail 'package.json version is empty' }

$expectedName = "AFKLLM-$version-x64-setup.exe"
if (-not $SetupPath) {
  $SetupPath = Join-Path $root "release\$expectedName"
}

Write-Host ''
Write-Host 'AFKLLM installer verify' -ForegroundColor Cyan
Write-Host "  package version: $version"
Write-Host "  setup:           $SetupPath"
Write-Host ''

Write-Host '[1/4] Artifact'
if (-not (Test-Path -LiteralPath $SetupPath)) {
  Fail "Missing installer. Run npm run dist first. Expected: release\$expectedName"
}
$setup = Get-Item -LiteralPath $SetupPath
if ($setup.Name -ne $expectedName) {
  Warn "Filename $($setup.Name) != expected $expectedName (continuing)"
} else {
  Ok "name matches $expectedName"
}
if ($setup.Length -lt $MinBytes) {
  Fail "Installer too small: $($setup.Length) bytes (min $MinBytes)"
}
Ok ('size {0:N1} MB' -f ($setup.Length / 1MB))

$blockmap = "$SetupPath.blockmap"
if (Test-Path -LiteralPath $blockmap) {
  Ok "blockmap present ($([IO.Path]::GetFileName($blockmap)))"
} else {
  Warn 'blockmap missing (updater may need it for differential downloads)'
}

Write-Host ''
Write-Host '[2/4] Publisher (Authenticode)'
$sig = Get-AuthenticodeSignature -FilePath $setup.FullName
$statusName = [string]$sig.Status
$subject = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { '' }

if ($statusName -eq 'Valid') {
  Ok 'signature Valid'
  Ok "signer: $subject"
  if ($ExpectedPublisher -and ($subject -notmatch [regex]::Escape($ExpectedPublisher))) {
    Fail "Publisher subject '$subject' does not contain '$ExpectedPublisher'"
  }
} elseif ($RequireSigned) {
  Fail @"
RequireSigned set but status is $statusName.

Public releases should be signed via SignPath Foundation (free for OSS) or a CA-issued cert.
See docs/guides/code-signing.md
"@
} else {
  Warn "signature status: $statusName - Windows will show Unknown publisher until SignPath/CA signing is enabled"
  Warn 'See docs/guides/code-signing.md (SignPath Foundation for open-source)'
}

if ($SkipInstall) {
  Write-Host ''
  Write-Host 'SkipInstall set - static checks only.' -ForegroundColor Cyan
  exit 0
}

Write-Host ''
Write-Host '[3/4] Silent install'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$installDir = Join-Path $env:TEMP "AFKLLM-verify-$stamp"
if (Test-Path -LiteralPath $installDir) {
  Remove-Item -LiteralPath $installDir -Recurse -Force
}
New-Item -ItemType Directory -Path $installDir | Out-Null

Get-Process -Name 'AFKLLM' -ErrorAction SilentlyContinue | Stop-Process -Force

$argLine = "/S /D=$installDir"
Write-Host "  running: $($setup.Name) $argLine"
$p = Start-Process -FilePath $setup.FullName -ArgumentList $argLine -Wait -PassThru
if ($null -ne $p.ExitCode -and $p.ExitCode -ne 0) {
  Fail "Installer exit code $($p.ExitCode)"
}
Ok "installer finished (exit $($p.ExitCode))"

Start-Sleep -Seconds 2
Get-Process -Name 'AFKLLM' -ErrorAction SilentlyContinue | Stop-Process -Force

$exe = Join-Path $installDir 'AFKLLM.exe'
if (-not (Test-Path -LiteralPath $exe)) {
  Fail "AFKLLM.exe not found under $installDir"
}
Ok 'AFKLLM.exe present'

$vi = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
$fileVer = [string]$vi.FileVersion
if ($fileVer -ne $version) {
  Fail "FileVersion '$fileVer' != package version '$version'"
}
Ok "FileVersion = $fileVer"

foreach ($rel in @('resources\app.asar', 'resources\elevate.exe')) {
  if (-not (Test-Path (Join-Path $installDir $rel))) {
    Fail "missing required file: $rel"
  }
  Ok $rel
}

$legalOk = (
  (Test-Path (Join-Path $installDir 'resources\legal\LICENSE')) -or
  (Test-Path (Join-Path $installDir 'LICENSE'))
)
if ($legalOk) { Ok 'LICENSE present' } else { Fail 'LICENSE missing' }

$unpackedPty = Join-Path $installDir 'resources\app.asar.unpacked\node_modules\node-pty'
if (Test-Path -LiteralPath $unpackedPty) {
  Ok 'node-pty unpacked present'
} else {
  Warn 'node-pty unpacked path not found - terminal may break'
}

if ($RequireSigned) {
  $installedSig = Get-AuthenticodeSignature -FilePath $exe
  if ([string]$installedSig.Status -ne 'Valid') {
    Fail "Installed AFKLLM.exe not signed (status: $($installedSig.Status))"
  }
  Ok ("installed publisher: {0}" -f $installedSig.SignerCertificate.Subject)
}

Write-Host ''
Write-Host '[4/4] Silent uninstall'
$uninstallers = @(
  @(
    (Join-Path $installDir 'Uninstall AFKLLM.exe'),
    (Join-Path $installDir 'uninstall.exe')
  ) | Where-Object { Test-Path -LiteralPath $_ }
)

if ($uninstallers.Count -eq 0) {
  Warn "Uninstaller not found - removing $installDir manually"
  Get-Process -Name 'AFKLLM' -ErrorAction SilentlyContinue | Stop-Process -Force
  Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
} else {
  $u = [string]$uninstallers[0]
  Write-Host ("  running: {0} /S" -f (Split-Path $u -Leaf))
  $up = Start-Process -FilePath $u -ArgumentList '/S' -Wait -PassThru
  Start-Sleep -Seconds 2
  Get-Process -Name 'AFKLLM' -ErrorAction SilentlyContinue | Stop-Process -Force
  if (Test-Path -LiteralPath $installDir) {
    Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $installDir) {
    Warn "install dir still present after uninstall: $installDir"
  } else {
    Ok 'uninstall cleaned install dir'
  }
  if ($null -ne $up.ExitCode -and $up.ExitCode -ne 0) {
    Warn "uninstaller exit code $($up.ExitCode)"
  } else {
    Ok "uninstaller finished (exit $($up.ExitCode))"
  }
}

Write-Host ''
Write-Host "Installer verify PASSED for $expectedName" -ForegroundColor Green
Write-Host ''
