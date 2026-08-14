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

Write-Host 'no script parameter is spelled like a local variable, in any casing'

# PowerShell variables are case-insensitive AND its scoping is dynamic, so a function that
# assigns a local `$pr` lends that object to every function it goes on to call - and to its
# own later lines. The script parameter was `[int]$Pr`, and that one collision fired three
# ways:
#
#   Invoke-Open   assigns $pr, calls Invoke-Status, which reads $Pr and gets the PR object
#   Invoke-Status assigns $pr, then re-reads $Pr on the UNKNOWN re-poll five lines later
#   Invoke-Sync   the same shape, four lines apart
#
#   Cannot process argument transformation on parameter 'number'. Cannot convert the
#   "@{...number=64...}" value of type PSCustomObject to type System.Int32
#
# `open` hit it every time (measured on PR #64, 2026-08-14); the other two need only a PR
# whose mergeability GitHub has not computed yet, which is every PR for its first minute.
#
# This is a parse rather than a call because reproducing it needs a live PR - and the bug
# was never in one expression, it was in the *name*, so the name is what to assert on.
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot 'pr-auto.ps1'), [ref]$null, [ref]$null)

$paramNames = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })

# Only names bound *inside a function* count. A script-scope assignment to a parameter is
# the parameter itself - `$IntervalSeconds` is clamped to 20 that way on line 71, and that
# is the variable doing its job, not a shadow of it. Both ways of binding a name in a
# function are a shadow: an assignment creates a local, and so does a parameter.
$localNames = @(
    $ast.FindAll(
        { $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
        ForEach-Object {
            $fn = $_
            if ($fn.Parameters) {
                $fn.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }
            }
            if ($fn.Body.ParamBlock) {
                $fn.Body.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }
            }
            $fn.Body.FindAll(
                { $args[0] -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true) |
                ForEach-Object { $_.Left } |
                Where-Object { $_ -is [System.Management.Automation.Language.VariableExpressionAst] } |
                ForEach-Object { $_.VariablePath.UserPath }
        }
)

Assert-Eq $true ($paramNames.Count -gt 0) 'the param block parsed at all'
Assert-Eq $true ($localNames -contains 'pr') 'the scan sees the $pr locals it is here for'
foreach ($name in $paramNames) {
    # -contains is case-insensitive, which is exactly the comparison PowerShell itself makes
    # when it resolves a variable name.
    Assert-Eq $false ($localNames -contains $name) "parameter `$$name is never bound inside a function"
}

Write-Host ''
if ($script:Failures -gt 0) {
    Write-Host "FAILED - $script:Failures assertion(s)"
    exit 1
}
Write-Host 'All guard tests passed.'
exit 0
