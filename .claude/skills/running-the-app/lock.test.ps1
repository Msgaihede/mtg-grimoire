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

# The same, with a culture forced on the child. `-File` cannot set one, so the child takes a
# `-Command` that sets the culture and then calls the script - no loss, because lock.ps1
# exits at the end of every action, so one child was always one action. The `try` around the
# assignment is for a runtime built with invariant globalization only, where naming a culture
# throws; there the check degrades to the ambient culture rather than erroring.
function RunCultured([string]$Culture, [string[]]$ScriptArgs) {
    # Quote the values, never the `-Parameter` names - a quoted `'-What'` binds as a
    # positional argument and the script refuses it.
    $quoted = ($ScriptArgs | ForEach-Object { if ($_ -like '-*') { $_ } else { "'$_'" } }) -join ' '
    $prelude = "try { [Threading.Thread]::CurrentThread.CurrentCulture = '$Culture' } catch { }"
    $out = & pwsh -NoProfile -Command "$prelude; & '$lock' $quoted" 2>&1 | Out-String
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
    # CreateNew, so a second agent's file can land on top of ours.
    #
    # The watcher must overwrite AFTER `acquire` has written, not merely after the file
    # exists - `CreateNew` makes it exist while it is still empty. Waiting on our own
    # marker is what orders the two writes; MTG_LOCK_TEST_READBACK_DELAY_MS then holds the
    # readback open long enough for the watcher to get in. Without both, the outcome is
    # scheduler luck: this passed locally and failed on a windows-latest runner, where the
    # watcher wrote into the empty file and `acquire` then landed on top of it.
    #
    # try/finally, because a throw here used to leave the usurper's lock file behind and
    # every later Check inherited it - one real failure reported as four.
    Check 'acquire refuses when someone else lock is what actually landed on disk' {
        Remove-Item $appLock -Force -ErrorAction SilentlyContinue
        $env:MTG_LOCK_TEST_READBACK_DELAY_MS = '3000'
        try {
            $watcher = Start-Job -ScriptBlock {
                param($path)
                $usurper = @{ worktree = 'usurper'; pid = $null; process = $null; started = $null
                              what = 'usurper'; since = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
                $deadline = [datetime]::UtcNow.AddSeconds(30)
                while ([datetime]::UtcNow -lt $deadline) {
                    # Only once our own content is on disk, so the overwrite is ordered
                    # after it rather than racing it.
                    if ((Test-Path $path) -and ((Get-Content -Raw $path -ErrorAction SilentlyContinue) -match 'victim')) {
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
        } finally {
            Remove-Item Env:\MTG_LOCK_TEST_READBACK_DELAY_MS -ErrorAction SilentlyContinue
            Remove-Item $appLock -Force -ErrorAction SilentlyContinue
        }
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

    # The grace window is the one place `Test-LockLive` reads a date, and it read it with
    # `::Parse`, which takes a *string* - so PowerShell first rendered the `DateTime` that
    # `ConvertFrom-Json` produces using the **current culture**. Under any culture whose short
    # date is not `MM/dd/yyyy`, "08/14/2026 17:07:10" is not a date that culture can read:
    # `Parse` threw, `catch` answered "stale", and a lock acquired one second earlier was free
    # for the taking. That is the ten-minute window gone, and with it the thing it exists for -
    # a second agent launching the app during a cold `tauri dev` build, which is silent both
    # ways (exit 0, no window).
    #
    # `a second acquire of the same lock is refused` above already catches this, but only on a
    # machine that is *already* in such a culture - it failed on the Danish-locale dev machine
    # and passed on the US-culture CI runner, for the same commit. This one carries the culture
    # with it, so CI catches it too.
    Check 'an un-adopted lock is still HELD under a non-US culture' {
        Remove-Item $appLock -Force -ErrorAction SilentlyContinue
        $r1 = RunCultured 'da-DK' @('acquire', 'app', '-What', 'cultured-first')
        Assert ($r1.code -eq 0) "first acquire exited $($r1.code): $($r1.out)"
        $r2 = RunCultured 'da-DK' @('acquire', 'app', '-What', 'cultured-second')
        Assert ($r2.code -eq 1) "expected HELD (exit 1), got $($r2.code): $($r2.out)"
        Assert ($r2.out -match 'HELD') "no HELD line: $($r2.out)"
        Remove-Item $appLock -Force -ErrorAction SilentlyContinue
    }
    Check 'acquire -Wait on a free lock does not wait' {
        Remove-Item $appLock -Force -ErrorAction SilentlyContinue
        $r = Run acquire app -Wait -What 'uncontended'
        Assert ($r.code -eq 0) "exit $($r.code): $($r.out)"
        Assert ($r.out -match 'OK') "no OK line: $($r.out)"
        Assert ($r.out -notmatch 'WAIT') "waited on a free lock: $($r.out)"
        Remove-Item $appLock -Force -ErrorAction SilentlyContinue
    }

    # -WaitMinutes 0 puts the deadline in the past, so this exercises the give-up path
    # without spending the wait. The holder has a live pid, so the lock is HELD on its
    # own account rather than merely inside the un-adopted grace window.
    Check 'acquire -Wait gives up at the deadline and names the holder' {
        Remove-Item $appLock -Force -ErrorAction SilentlyContinue
        $r0 = Run acquire app -What 'squatter'
        Assert ($r0.code -eq 0) "setup acquire exited $($r0.code): $($r0.out)"
        $sleeper = NewSleeper
        $ra = Run adopt app -ProcessId $sleeper.Id
        Assert ($ra.code -eq 0) "setup adopt exited $($ra.code): $($ra.out)"

        $r = Run acquire app -Wait -WaitMinutes 0 -What 'waiter'
        Assert ($r.code -eq 1) "expected exit 1, got $($r.code): $($r.out)"
        Assert ($r.out -match 'still held after') "no give-up line: $($r.out)"
        Assert ($r.out -match 'squatter') "give-up report did not name the holder: $($r.out)"

        Stop-Process -Id $sleeper.Id -Force -ErrorAction SilentlyContinue
        Remove-Item $appLock -Force -ErrorAction SilentlyContinue
    }

    # The whole point of -Wait: the agent makes one call and it comes back holding the
    # lock, without a single HELD round trip in between.
    Check 'acquire -Wait takes the lock once the holder releases' {
        Remove-Item $appLock -Force -ErrorAction SilentlyContinue
        $r0 = Run acquire app -What 'holder'
        Assert ($r0.code -eq 0) "setup acquire exited $($r0.code): $($r0.out)"
        $sleeper = NewSleeper
        $ra = Run adopt app -ProcessId $sleeper.Id
        Assert ($ra.code -eq 0) "setup adopt exited $($ra.code): $($ra.out)"

        $env:MTG_LOCK_TEST_POLL_SECONDS = '1'
        $releaser = Start-Process pwsh -ArgumentList '-NoProfile', '-Command', `
            "Start-Sleep 3; Remove-Item '$appLock' -Force" -WindowStyle Hidden -PassThru
        try {
            $r = Run acquire app -Wait -WaitMinutes 1 -What 'waiter'
            Assert ($r.code -eq 0) "waiting acquire exited $($r.code): $($r.out)"
            Assert ($r.out -match 'WAIT') "no WAIT line: $($r.out)"
            Assert ($r.out -match 'OK') "never acquired: $($r.out)"
        } finally {
            $env:MTG_LOCK_TEST_POLL_SECONDS = $null
            try { Stop-Process -Id $releaser.Id -Force -ErrorAction SilentlyContinue } catch {}
            Stop-Process -Id $sleeper.Id -Force -ErrorAction SilentlyContinue
            Remove-Item $appLock -Force -ErrorAction SilentlyContinue
        }
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
