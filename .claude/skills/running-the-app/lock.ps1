#!/usr/bin/env pwsh
<#
Exclusive locks for the two things only one agent can run at a time across every
worktree of this repo:

  app        the built exe or `tauri dev`, Vite 1420, CDP 9222. Exclusive because
             `tauri-plugin-single-instance` gives a second instance exit code 0,
             no window and no stderr.
  storybook  port 6006 and the `mtg-grimoire-sb-mcp` server pointed at it. A second
             Storybook lands elsewhere and the MCP answers from the first one.

Locks live in <git common dir>/locks, which every worktree shares and none of them
contains — so a lock can never be committed.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateSet('status', 'acquire', 'adopt', 'release')]
    [string]$Action,

    [Parameter(Position = 1)]
    [ValidateSet('app', 'storybook', 'all')]
    [string]$Name = 'all',

    [string]$What = '',
    [int]$ProcessId = 0,
    [switch]$KeepProcess,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# A lock between `acquire` and `adopt` has no pid yet. Treat it as live for this long
# so a crash in that window cannot block another agent forever.
$UnadoptedGraceMinutes = 10

function Get-LockDir {
    # MTG_LOCK_DIR is for lock.test.ps1 only. Never set it in real use.
    $dir = if ($env:MTG_LOCK_DIR) { $env:MTG_LOCK_DIR }
           else {
               $common = (git rev-parse --path-format=absolute --git-common-dir 2>$null)
               if (-not $common) { throw 'Not inside a git repository.' }
               Join-Path $common.Trim() 'locks'
           }
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    return $dir
}

function Get-LockPath([string]$n) { Join-Path (Get-LockDir) "$n.lock" }

function Get-Worktree {
    if ($env:MTG_LOCK_DIR) { return $env:MTG_LOCK_DIR }
    return (git rev-parse --path-format=absolute --show-toplevel).Trim()
}

function Read-Lock([string]$path) {
    try { Get-Content -Raw -Path $path -ErrorAction Stop | ConvertFrom-Json } catch { $null }
}

function Write-Lock([string]$path, $lock) {
    Set-Content -Path $path -Value ($lock | ConvertTo-Json -Compress) -Encoding utf8NoBOM
}

# Live means: an adopted pid that is running AND still carries the recorded process
# name — Windows reuses pids, so the pid alone is not an answer. An un-adopted lock is
# live only inside the grace window.
function Test-LockLive($lock) {
    if (-not $lock) { return $false }
    if (-not $lock.pid) {
        $age = ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($lock.since)).TotalMinutes
        return $age -lt $UnadoptedGraceMinutes
    }
    $p = Get-Process -Id $lock.pid -ErrorAction SilentlyContinue
    return ($null -ne $p) -and ($p.ProcessName -eq $lock.process)
}

function Require-Name {
    if ($Name -eq 'all') { Write-Host "ERR   $Action needs a lock name: app or storybook"; exit 2 }
}

function Invoke-Status {
    $names = if ($Name -eq 'all') { @('app', 'storybook') } else { @($Name) }
    foreach ($n in $names) {
        $path = Get-LockPath $n
        if (-not (Test-Path $path)) { Write-Host "FREE  $n"; continue }
        $lock = Read-Lock $path
        $state = if (Test-LockLive $lock) { 'HELD ' } else { 'STALE' }
        Write-Host "$state $n -> $($lock.worktree) pid=$($lock.pid) what='$($lock.what)' since=$($lock.since)"
    }
}

function Invoke-Acquire {
    Require-Name
    $path = Get-LockPath $Name

    if (Test-Path $path) {
        $existing = Read-Lock $path
        if (Test-LockLive $existing) {
            Write-Host "HELD  $Name is held by $($existing.worktree) (pid $($existing.pid), '$($existing.what)') since $($existing.since)"
            Write-Host "      Wait and retry. Do NOT kill it - another agent may be mid-measurement."
            exit 1
        }
        Write-Host "STALE $Name lock taken over (was $($existing.worktree), pid $($existing.pid), now dead)"
        Remove-Item $path -Force
    }

    # CreateNew is O_EXCL: it throws if another agent won the race since the check above.
    try { $stream = [System.IO.File]::Open($path, 'CreateNew', 'Write') }
    catch { Write-Host "HELD  $Name was claimed by another agent moments ago"; exit 1 }
    try {
        $json = [ordered]@{
            worktree = Get-Worktree
            pid      = $null
            process  = $null
            what     = $What
            since    = [DateTimeOffset]::UtcNow.ToString('o')
        } | ConvertTo-Json -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }

    Write-Host "OK    $Name acquired by $(Get-Worktree)"
    Write-Host "      Now launch, then: lock.ps1 adopt $Name -ProcessId <pid>"
}

function Invoke-Adopt {
    Require-Name
    $path = Get-LockPath $Name
    $lock = Read-Lock $path
    if (-not $lock) { Write-Host "ERR   no $Name lock to adopt into - acquire first"; exit 1 }
    if ($lock.worktree -ne (Get-Worktree) -and -not $Force) {
        Write-Host "DENY  $Name lock belongs to $($lock.worktree)"; exit 1
    }
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $p) { Write-Host "ERR   no running process with id $ProcessId"; exit 1 }
    $lock.pid = $ProcessId
    $lock.process = $p.ProcessName
    Write-Lock $path $lock
    Write-Host "OK    $Name now holds pid $ProcessId ($($p.ProcessName))"
}

function Invoke-Release {
    Require-Name
    $path = Get-LockPath $Name
    if (-not (Test-Path $path)) { Write-Host "OK    $Name was not locked"; return }
    $lock = Read-Lock $path
    if ($lock -and $lock.worktree -ne (Get-Worktree) -and -not $Force) {
        Write-Host "DENY  $Name lock belongs to $($lock.worktree). Pass -Force only if it is stale."
        exit 1
    }
    if (-not $KeepProcess -and $lock -and $lock.pid) {
        $p = Get-Process -Id $lock.pid -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -eq $lock.process) {
            Stop-Process -Id $lock.pid -Force
            $p.WaitForExit(10000) | Out-Null
            Write-Host "OK    stopped $($lock.process) (pid $($lock.pid))"
        }
    }
    Remove-Item $path -Force
    Write-Host "OK    $Name released"
}

switch ($Action) {
    'status'  { Invoke-Status }
    'acquire' { Invoke-Acquire }
    'adopt'   { Invoke-Adopt }
    'release' { Invoke-Release }
}
