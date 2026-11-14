# Run a queue of stage-0 benchmarks in this (visible) console and mirror everything to
# C:\Models\_bench\console-<time>.log (UTF-8), so progress can be watched live and read back later.
#
#   powershell -NoExit -File scripts\stage0\run-bench.ps1 "q36moe --tag first" "ornith --tests tools"
#
# Each argument is "<profile> [bench.py flags...]", or "coder <profiles...>" (coder-eval/eval_coder.py),
# or "agent [--task=N] <cli profiles...>" (agent-task/run_agent_task.py).
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Jobs)

$ErrorActionPreference = 'Continue'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$log = "C:\Models\_bench\console-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
$env:PYTHONIOENCODING = 'utf-8'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# Tee-Object in PowerShell 5.1 writes UTF-16; append UTF-8 ourselves.
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Say([string]$line) { Write-Host $line; [IO.File]::AppendAllText($log, $line + "`r`n", $utf8) }
# 2>&1 turns each stderr line of a native command into an ErrorRecord; an empty one prints as
# "System.Management.Automation.RemoteException". Unwrap to the plain text line.
function Out-Line($o) {
    if ($o -is [System.Management.Automation.ErrorRecord]) {
        $t = $o.Exception.Message
        if ($t -eq 'System.Management.Automation.RemoteException') { $t = '' }
        Say $t
    } else { Say "$o" }
}

$n = 0
foreach ($job in $Jobs) {
    $n++
    $parts = $job -split '\s+' | Where-Object { $_ }
    $prof = $parts[0]
    $rest = @()
    if ($parts.Count -gt 1) { $rest = $parts[1..($parts.Count - 1)] }
    $Host.UI.RawUI.WindowTitle = "AFKLLM bench [$n/$($Jobs.Count)] $job"
    Say "`n==================== [$n/$($Jobs.Count)] $job ===================="
    if ($prof -eq 'coder') {
        & python -u (Join-Path $repo 'scripts\stage0\coder-eval\eval_coder.py') @rest 2>&1 | ForEach-Object { Out-Line $_ }
    } elseif ($prof -eq 'mtp-ab' -or $prof -eq 'mtp-tie') {
        & python -u (Join-Path $repo "scripts\stage0\$prof.py") @rest 2>&1 | ForEach-Object { Out-Line $_ }
    } elseif ($prof -eq 'agent') {
        & python -u (Join-Path $repo 'scripts\stage0\agent-task\run_agent_task.py') @rest 2>&1 | ForEach-Object { Out-Line $_ }
    } else {
        & python -u (Join-Path $repo 'scripts\stage0\bench.py') --profile $prof @rest 2>&1 |
            ForEach-Object { Out-Line $_ }
    }
}
Say "`n==================== queue done $(Get-Date -Format 'HH:mm:ss') ===================="
$Host.UI.RawUI.WindowTitle = 'AFKLLM bench - done'
