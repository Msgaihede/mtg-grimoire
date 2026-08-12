#!/usr/bin/env pwsh
# Exercises lock.ps1 against a throwaway lock dir. Run: pwsh -NoProfile -File lock.test.ps1
$ErrorActionPreference = 'Stop'
$lock = Join-Path $PSScriptRoot 'lock.ps1'
$env:MTG_LOCK_DIR = Join-Path ([System.IO.Path]::GetTempPath()) "mtg-lock-test-$([guid]::NewGuid())"

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
    $p = Start-Process pwsh -ArgumentList '-NoProfile', '-Command', 'Start-Sleep 300' -PassThru
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

    Check 'adopt records the pid and the process name' {
        $p = NewSleeper
        $r = Run adopt app -ProcessId $p.Id
        Assert ($r.code -eq 0) "exit $($r.code): $($r.out)"
        $json = Get-Content -Raw (Join-Path $env:MTG_LOCK_DIR 'app.lock') | ConvertFrom-Json
        Assert ($json.pid -eq $p.Id) "pid is $($json.pid), expected $($p.Id)"
        Assert ($json.process -eq 'pwsh') "process is '$($json.process)', expected 'pwsh'"
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
} finally {
    foreach ($p in $sleepers) {
        try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    if (Test-Path $env:MTG_LOCK_DIR) { Remove-Item $env:MTG_LOCK_DIR -Recurse -Force }
}

Write-Host ""
if ($failures -gt 0) { Write-Host "$failures failed"; exit 1 }
Write-Host 'all passed'
