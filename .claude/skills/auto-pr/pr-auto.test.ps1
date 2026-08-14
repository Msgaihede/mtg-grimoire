#!/usr/bin/env pwsh
<#
Tests for the one part of pr-auto.ps1 that must never be wrong: which pull requests a
fan-out `-All` is allowed to touch.

Arming auto-merge on release-please's pull request would cut a release nobody asked for,
so `Test-Foreign` carries three independent signals and `Test-Ours` is an allowlist rather
than a blocklist. Both are pure functions of a PR object, which is why they are tested here
directly - reproducing this through the CLI would need a live repo with a release PR
already open, and the case worth testing is the one that has not happened yet.

Shapes below are the real ones. Measured against this repo's PR #54 on 2026-08-14:
  branch  release-please--branches--main--components--mtg-grimoire
  author  app/github-actions, is_bot true      <- NOT `github-actions[bot]`
  labels  autorelease: pending

Run: pwsh -NoProfile -File .claude/skills/auto-pr/pr-auto.test.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$env:PR_AUTO_TEST_NO_RUN = '1'
try { . (Join-Path $PSScriptRoot 'pr-auto.ps1') status }
finally { Remove-Item Env:\PR_AUTO_TEST_NO_RUN -ErrorAction SilentlyContinue }

$script:Failures = 0

function New-Pr {
    param(
        [string]$Branch = 'worktree-thing',
        [string]$Login = 'Msgaihede',
        [bool]$IsBot = $false,
        [string[]]$Labels = @()
    )
    return [pscustomobject]@{
        number      = 1
        headRefName = $Branch
        state       = 'OPEN'
        author      = [pscustomobject]@{ login = $Login; is_bot = $IsBot }
        labels      = @($Labels | ForEach-Object { [pscustomobject]@{ name = $_ } })
    }
}

function Assert-Eq($expected, $actual, [string]$what) {
    if ($expected -eq $actual) { Write-Host "  ok   $what"; return }
    Write-Host "  FAIL $what - expected '$expected', got '$actual'"
    $script:Failures++
}

Write-Host 'Test-Foreign: each signal disqualifies a PR on its own'

Assert-Eq $true (Test-Foreign (New-Pr -Branch 'release-please--branches--main--components--mtg-grimoire')) `
    'branch prefix alone'
Assert-Eq $true (Test-Foreign (New-Pr -Login 'app/github-actions' -IsBot $true)) `
    'bot author alone'
# The login is the signal most likely to drift, and it already did once: gh reports
# `app/github-actions`, so a glob anchored at the front matched nothing.
Assert-Eq $true (Test-Foreign (New-Pr -Login 'app/github-actions' -IsBot $false)) `
    'bot login alone, even with is_bot unset'
Assert-Eq $true (Test-Foreign (New-Pr -Labels @('autorelease: pending'))) `
    'autorelease label alone'
Assert-Eq $true (Test-Foreign (New-Pr -Labels @('enhancement', 'autorelease: tagged'))) `
    'autorelease label among others'

Write-Host 'Test-Foreign: an ordinary agent PR is not foreign'

Assert-Eq $false (Test-Foreign (New-Pr)) 'plain worktree branch'
Assert-Eq $false (Test-Foreign (New-Pr -Labels @('enhancement', 'ui'))) 'unrelated labels'

Write-Host 'Test-Ours: an allowlist, so anything unrecognised is left alone'

Assert-Eq $true  (Test-Ours (New-Pr -Branch 'worktree-remember-deck-format')) 'worktree branch is ours'
Assert-Eq $false (Test-Ours (New-Pr -Branch 'my-hand-made-branch')) 'unrecognised branch is NOT ours'
Assert-Eq $false (Test-Ours (New-Pr -Branch 'release-please--branches--main')) 'release branch is not ours'

# Defence in depth: the allowlist must not rescue a PR the blocklist rejected. A bot that
# ever opened a `worktree-` branch would otherwise be swept into a fan-out.
Assert-Eq $false (Test-Ours (New-Pr -Branch 'worktree-thing' -Login 'app/github-actions' -IsBot $true)) `
    'worktree branch authored by a bot is not ours'
Assert-Eq $false (Test-Ours (New-Pr -Branch 'worktree-thing' -Labels @('autorelease: pending'))) `
    'worktree branch carrying an autorelease label is not ours'

Write-Host ''
if ($script:Failures -gt 0) {
    Write-Host "FAILED - $script:Failures assertion(s)"
    exit 1
}
Write-Host 'All guard tests passed.'
exit 0
