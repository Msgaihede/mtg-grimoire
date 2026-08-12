#!/usr/bin/env pwsh
# Exercises lock.ps1 against a throwaway lock dir. Run: pwsh -NoProfile -File lock.test.ps1
$ErrorActionPreference = 'Stop'
$lock = Join-Path $PSScriptRoot 'lock.ps1'
$env:MTG_LOCK_DIR = Join-Path ([System.IO.Path]::GetTempPath()) "mtg-lock-test-$([guid]::NewGuid())"
$appLock = Join-Path $env:MTG_LOCK_DIR 'app.lock'

$failures = 0
function Check([string]$name, [scriptblock]$body) {
    try {
        & $body
        Write-Host "  pass  $name"
    } catch {
        $script:failures++
        Write-Host "  FAIL  $name -> $($_.Exception.Message)"
    }
}
function Assert([bool]$cond, [string]$msg) { if (-not $cond) { throw $msg } }

# Runs the script and returns @{ out = <text>; code = <exit code> }.
function Run() {
    $out = & pwsh -NoProfile -File $lock @args 2>&1 | Out-String
    return @{ out = $out; code = $LASTEXITCODE }
}

$sleepers = @()
function NewSleeper() {
    $p = Start-Process pwsh -ArgumentList '-NoProfile', '-Command', 'Start-Sleep 300' -WindowStyle Hidden -PassThru
    $script:sleepers += $p
    return $p
}

try {
    Check 'status of an empty lock dir reports both locks free' {
        $r = Run status
        Assert ($r.out -match 'FREE\s+app') 'app not FREE'
        Assert ($r.out -match 'FREE\s+storybook') 'storybook not FREE'
        Assert ($r.code -eq 0) "status exited $($r.code)"
    }

    Check 'acquire succeeds on a free lock' {
        $r = Run acquire app -What 'first'
        Assert ($r.code -eq 0) "exit $($r.code): $($r.out)"
        Assert ($r.out -match 'OK') 'no OK line'
    }

    Check 'a second acquire of the same lock is refused' {
        $r = Run acquire app -What 'second'
        Assert ($r.code -eq 1) "expected exit 1, got $($r.code)"
        Assert ($r.out -match 'HELD') 'no HELD line'
    }

    Check 'the two locks are independent' {
        $r = Run acquire storybook -What 'stories'
        Assert ($r.code -eq 0) "storybook refused while app held: $($r.out)"
        (Run release storybook) | Out-Null
    }

    Check 'adopt records the pid, the process name and the start time' {
        $p = NewSleeper
        $r = Run adopt app -ProcessId $p.Id
        Assert ($r.code -eq 0) "exit $($r.code): $($r.out)"
        $json = Get-Content -Raw (Join-Path $env:MTG_LOCK_DIR 'app.lock') | ConvertFrom-Json
        Assert ($json.pid -eq $p.Id) "pid is $($json.pid), expected $($p.Id)"
        Assert ($json.process -eq 'pwsh') "process is '$($json.process)', expected 'pwsh'"
        # Third identity field: pid + name alone cannot tell one `node` from another.
        Assert ($null -ne $json.started) 'no start time recorded'
        Assert (([DateTimeOffset]$json.started) -eq ([DateTimeOffset]$p.StartTime)) `
            "started is '$($json.started)', expected $($p.StartTime.ToString('o'))"
    }

    Check 'a lock held by a live process is still refused' {
        $r = Run acquire app -What 'third'
        Assert ($r.code -eq 1) "expected exit 1, got $($r.code)"
    }

    Check 'release with -KeepProcess deletes the lock and spares the process' {
        $json = Get-Content -Raw (Join-Path $env:MTG_LOCK_DIR 'app.lock') | ConvertFrom-Json
        $r = Run release app -KeepProcess
        Assert ($r.code -eq 0) "exit $($r.code): $($r.out)"
        Assert (-not (Test-Path (Join-Path $env:MTG_LOCK_DIR 'app.lock'))) 'lock file survived'
        Assert ($null -ne (Get-Process -Id $json.pid -ErrorAction SilentlyContinue)) 'process was killed'
    }

    Check 'a lock whose process is dead is stale and gets taken over' {
        $p = NewSleeper
        (Run acquire app -What 'doomed') | Out-Null
        (Run adopt app -ProcessId $p.Id) | Out-Null
        Stop-Process -Id $p.Id -Force
        $p.WaitForExit(10000) | Out-Null
        $r = Run acquire app -What 'takeover'
        Assert ($r.code -eq 0) "exit $($r.code): $($r.out)"
        Assert ($r.out -match 'STALE') 'takeover was not announced as STALE'
    }

    Check 'release stops the recorded process by default' {
        $p = NewSleeper
        (Run adopt app -ProcessId $p.Id) | Out-Null
        $r = Run release app
        Assert ($r.code -eq 0) "exit $($r.code): $($r.out)"
        $p.WaitForExit(10000) | Out-Null
        Assert ($null -eq (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) 'process survived release'
    }

    Check 'releasing a lock that does not exist is not an error' {
        $r = Run release app
        Assert ($r.code -eq 0) "exit $($r.code): $($r.out)"
    }

    # A lock the script cannot understand is not a lock anyone is holding. Throwing here
    # made `acquire` exit 1, which SKILL.md tells an agent to read as HELD - so one
    # corrupt file made every later agent wait forever.
    Check 'a lock file that is not JSON is stale, and neither status nor acquire throws' {
        Set-Content -Path $appLock -Value 'not json at all {{'
        $s = Run status app
        Assert ($s.code -eq 0) "status exited $($s.code): $($s.out)"
        Assert ($s.out -match 'STALE') "status did not call it STALE: $($s.out)"
        $r = Run acquire app -What 'after corruption'
        Assert ($r.code -eq 0) "acquire exited $($r.code): $($r.out)"
        (Run release app) | Out-Null
    }

    Check 'a lock whose JSON parses but has no since is stale, not an exception' {
        Set-Content -Path $appLock -Value '{"worktree":"elsewhere","pid":null,"process":null,"what":"half-written"}'
        $s = Run status app
        Assert ($s.code -eq 0) "status exited $($s.code): $($s.out)"
        Assert ($s.out -match 'STALE') "status did not call it STALE: $($s.out)"
        $r = Run acquire app -What 'takeover'
        Assert ($r.code -eq 0) "acquire exited $($r.code): $($r.out)"
        Assert ($r.out -match 'STALE') 'takeover was not announced as STALE'
        (Run release app) | Out-Null
    }

    Check 'a lock whose since is not a date is stale' {
        Set-Content -Path $appLock -Value '{"worktree":"elsewhere","pid":null,"process":null,"what":"x","since":"the day before yesterday"}'
        $r = Run acquire app -What 'takeover'
        Assert ($r.code -eq 0) "acquire exited $($r.code): $($r.out)"
        (Run release app) | Out-Null
    }

    # CreateNew only guards free -> claimed; a stale takeover is Remove-Item THEN
    # CreateNew, so a second agent's file can land on top of ours. A spin-watcher
    # overwrites the lock the instant it appears - the interleaving CreateNew cannot see.
    Check 'acquire refuses when someone else lock is what actually landed on disk' {
        Remove-Item $appLock -Force -ErrorAction SilentlyContinue
        $watcher = Start-Job -ScriptBlock {
            param($path)
            $usurper = @{ worktree = 'usurper'; pid = $null; process = $null; started = $null
                          what = 'usurper'; since = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
            $deadline = [datetime]::UtcNow.AddSeconds(30)
            while ([datetime]::UtcNow -lt $deadline) {
                if (Test-Path $path) {
                    try { [System.IO.File]::WriteAllText($path, $usurper); return 'overwrote' } catch {}
                }
            }
            return 'timeout'
        } -ArgumentList $appLock
        $r = Run acquire app -What 'victim'
        $w = $watcher | Wait-Job | Receive-Job
        $watcher | Remove-Job
        Assert ($w -eq 'overwrote') 'the watcher never got in - inconclusive, not a pass'
        Assert ($r.code -eq 1) "acquire claimed a lock it had lost: exit $($r.code): $($r.out)"
        Assert ($r.out -match 'HELD') "no HELD line: $($r.out)"
        Remove-Item $appLock -Force -ErrorAction SilentlyContinue
    }

    # pid + name buys nothing for `storybook`: Storybook, Vite, vitest and the MCP server
    # are all called `node`. The start time is what makes a pid a particular process.
    Check 'a live pid whose start time does not match is stale' {
        $p = NewSleeper
        (Run acquire app -What 'identity') | Out-Null
        (Run adopt app -ProcessId $p.Id) | Out-Null
        Assert ((Run acquire app -What 'held').code -eq 1) 'the freshly adopted lock was not live'
        $json = Get-Content -Raw $appLock | ConvertFrom-Json
        $json.started = ([DateTimeOffset]$p.StartTime).AddMinutes(-5).ToString('o')
        Set-Content -Path $appLock -Value ($json | ConvertTo-Json -Compress)
        $r = Run acquire app -What 'takeover'
        Assert ($r.code -eq 0) "a pid-reuse lock was not taken over: $($r.out)"
        Assert ($null -ne (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) 'acquire killed something'
        (Run release app) | Out-Null
        Stop-Process -Id $p.Id -Force
    }

    Check 'release does not stop a process whose start time does not match' {
        $p = NewSleeper
        (Run acquire app -What 'identity') | Out-Null
        (Run adopt app -ProcessId $p.Id) | Out-Null
        $json = Get-Content -Raw $appLock | ConvertFrom-Json
        $json.started = ([DateTimeOffset]$p.StartTime).AddMinutes(-5).ToString('o')
        Set-Content -Path $appLock -Value ($json | ConvertTo-Json -Compress)
        $r = Run release app
        Assert ($r.code -eq 0) "exit $($r.code): $($r.out)"
        Assert (-not (Test-Path $appLock)) 'lock file survived'
        Assert ($null -ne (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) 'release stopped a process it had not adopted'
        Stop-Process -Id $p.Id -Force
    }

    # Backward compatibility: a missing start time is "not checked", never "corrupt".
    Check 'a lock recorded without a start time is still live and still releases' {
        $p = NewSleeper
        (Run acquire app -What 'legacy') | Out-Null
        (Run adopt app -ProcessId $p.Id) | Out-Null
        $json = Get-Content -Raw $appLock | ConvertFrom-Json
        $json.PSObject.Properties.Remove('started')
        Set-Content -Path $appLock -Value ($json | ConvertTo-Json -Compress)
        $r = Run acquire app -What 'should be refused'
        Assert ($r.code -eq 1) "a legacy lock over a live process was not refused: $($r.out)"
        (Run release app) | Out-Null
        $p.WaitForExit(10000) | Out-Null
        Assert ($null -eq (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) 'legacy lock did not stop its process'
    }
} finally {
    foreach ($p in $sleepers) {
        try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    if (Test-Path $env:MTG_LOCK_DIR) { Remove-Item $env:MTG_LOCK_DIR -Recurse -Force }
}

Write-Host ""
if ($failures -gt 0) { Write-Host "$failures failed"; exit 1 }
Write-Host 'all passed'
