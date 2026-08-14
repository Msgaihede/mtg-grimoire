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
# so a crash in that window cannot block another agent forever. It has to cover the
# longest honest acquire->adopt gap, which is a cold `npm run tauri dev` cargo build -
# shorten it and an agent steals a lock out from under a build that is still going.
# SKILL.md's poll ceiling matches it; change one and change the other.
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

# Process identity is pid + process name + start time, and the third field is not
# ceremony: Windows reuses pids, and the name check buys nothing for the `storybook`
# lock because Storybook, Vite, vitest and the MCP server are ALL named `node` — a
# reused pid belonging to an unrelated node would pass both of the first two, and
# `release` would stop it. The start time is what makes a pid a particular process.
# A lock written before this field existed records none; then it is simply not checked.
function Get-StartTime($p) {
    # Not every process yields its start time (access denied on some), so both the
    # writing and the reading side have to tolerate not having one.
    try { return [DateTimeOffset]$p.StartTime } catch { return $null }
}

function Get-StartTimeStamp($p) {
    $t = Get-StartTime $p
    if ($null -eq $t) { return $null }
    return $t.ToString('o')
}

function Get-ProcessById($id) {
    # A garbage pid in a hand-edited lock must not throw out of a parameter bind.
    try { return Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue } catch { return $null }
}

function Test-SameProcess($lock, $p) {
    if (-not $p) { return $false }
    if ($p.ProcessName -ne $lock.process) { return $false }
    if (-not $lock.started) { return $true }   # written before this field existed
    # Compared as instants: ConvertFrom-Json hands `started` back as a DateTime, and
    # `-eq` against a formatted string would compare two different renderings and
    # always disagree.
    $recorded = $null
    try { $recorded = [DateTimeOffset]$lock.started } catch { return $false }
    $actual = Get-StartTime $p
    if ($null -eq $actual) { return $true }    # unreadable now; pid + name is all there is
    return $recorded -eq $actual
}

# Live means: an adopted pid still running as the same process it was adopted as. An
# un-adopted lock is live only inside the grace window.
#
# A lock this function cannot understand — unreadable JSON, no `since`, a `since` that
# is not a date — is **stale**, never an exception. Throwing here made `acquire` exit 1,
# which SKILL.md tells an agent to read as HELD, so one corrupt file made every later
# agent wait forever on a lock nobody was holding. A lock the script cannot read is not
# a lock anyone is holding.
function Test-LockLive($lock) {
    if (-not $lock) { return $false }
    if (-not $lock.pid) {
        if (-not $lock.since) { return $false }
        # A **cast**, not `::Parse`, for the same reason `Test-SameProcess` casts `started`
        # 20 lines down: `ConvertFrom-Json` hands these back as `DateTime`, already shifted
        # to local time. `::Parse` takes a string, so PowerShell rendered that `DateTime`
        # with the *current culture* first — and on any machine whose short date is not
        # `MM/dd/yyyy` the result ("08/14/2026 17:07:10") is not a date that culture can
        # read. It threw, `catch` answered `$false`, and a lock acquired one second ago was
        # reported stale: the whole ten-minute grace window below was dead on arrival, and
        # a second agent could take the `app` lock out from under a cold `tauri dev` build.
        # Invisible on a US-culture CI runner, which is exactly where the test passes.
        try { $since = [DateTimeOffset]$lock.since } catch { return $false }
        $age = ([DateTimeOffset]::UtcNow - $since).TotalMinutes
        return $age -lt $UnadoptedGraceMinutes
    }
    return (Test-SameProcess $lock (Get-ProcessById $lock.pid))
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
    $since = [DateTimeOffset]::UtcNow.ToString('o')
    try { $stream = [System.IO.File]::Open($path, 'CreateNew', 'Write') }
    catch { Write-Host "HELD  $Name was claimed by another agent moments ago"; exit 1 }
    try {
        $json = [ordered]@{
            worktree = Get-Worktree
            pid      = $null
            process  = $null
            started  = $null
            what     = $What
            since    = $since
        } | ConvertTo-Json -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }

    # CreateNew only guards free -> claimed. A stale takeover is Remove-Item THEN
    # CreateNew, which is two operations: two agents reading the same stale lock can
    # both delete and both create, and B's Remove-Item takes A's fresh file with it.
    # So read back what is actually on disk and only claim the lock if the `since`
    # there is the one we just wrote. Whoever wrote last holds it; everyone else is
    # told HELD and exits 1, which is what they would have been told anyway.
    # (Compared as instants, because ConvertFrom-Json hands `since` back as a DateTime
    # rather than as the string that was written.)
    #
    # MTG_LOCK_TEST_READBACK_DELAY_MS is for lock.test.ps1 only, like MTG_LOCK_DIR, and is
    # a no-op unless set. It widens this window on purpose: the loser of this race is
    # whoever wrote first, so a test that merely spins a second writer decides the outcome
    # by scheduler luck — it passed locally and failed on a GitHub windows-latest runner,
    # where the watcher landed its file before `acquire` had written its own at all.
    if ($env:MTG_LOCK_TEST_READBACK_DELAY_MS) {
        Start-Sleep -Milliseconds ([int]$env:MTG_LOCK_TEST_READBACK_DELAY_MS)
    }

    $landed = Read-Lock $path
    $landedSince = $null
    if ($landed -and $landed.since) {
        try { $landedSince = [DateTimeOffset]$landed.since } catch { $landedSince = $null }
    }
    if ($null -eq $landedSince -or $landedSince -ne [DateTimeOffset]$since) {
        Write-Host "HELD  $Name was claimed by another agent moments ago"
        exit 1
    }

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
    $lock | Add-Member -NotePropertyName pid     -NotePropertyValue $ProcessId       -Force
    $lock | Add-Member -NotePropertyName process -NotePropertyValue $p.ProcessName   -Force
    $lock | Add-Member -NotePropertyName started -NotePropertyValue (Get-StartTimeStamp $p) -Force
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
        $p = Get-ProcessById $lock.pid
        # All three identity fields, or nothing is stopped. Stopping a reused pid that
        # merely happens to be a `node` would take out somebody's vitest run.
        if (Test-SameProcess $lock $p) {
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
