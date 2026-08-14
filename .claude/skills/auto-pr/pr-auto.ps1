#!/usr/bin/env pwsh
<#
Drive one branch's pull request to merged, on a repo where 8-10 agents are pushing at once.

`main` is protected with `strict: true` ("require branches to be up to date"), and the only
required context is `ci-ok`. That is what creates the treadmill: every merge into main
knocks EVERY other open PR to mergeStateStatus BEHIND, and a BEHIND pull request cannot
merge until main is merged into it and the whole of `ci-ok` runs green again.

What auto-merge already does, measured 2026-08-14: GitHub updates a BEHIND branch by
itself. Main's tip moved at 11:29:27Z and PR #57 got its `Merge branch 'main' into ...`
commit at 11:32:55Z - about three and a half minutes later. So arming auto-merge is most of
the job, and this script does NOT exist because that half is missing.

It exists for the two things auto-merge cannot do, and for the race it loses:

  conflict   GitHub tries the update, hits a real conflict, and gives up silently. The PR
             then sits at DIRTY forever with auto-merge still armed and nothing happening.
  red ci-ok  a failing gate is never retried on its own.
  the race   with ten PRs open and main moving every few minutes, only one can win each
             round; the rest go BEHIND again and re-run CI from scratch. Waiting three
             minutes per round for GitHub to notice makes a queue that never drains.

The split it draws:

  mechanical   BEHIND with no conflict. `gh pr update-branch` merges main in ON GITHUB
               immediately rather than in a few minutes, and touches no worktree - so it
               works while Claude is mid-edit, while the tree is dirty, and after the agent
               that opened the PR is gone. The script does this itself.
  judgement    a real conflict (DIRTY), or a red `ci-ok`. Reconciling two agents' work and
               reading a failure are Claude's, and the script only reports them.

Actions
  open      push, open the PR, arm auto-merge
  arm       arm auto-merge on an existing PR (add -All for every open PR)
  status    one-shot state of this branch's PR
  sync      clear BEHIND (add -All for every open PR)
  resolve   start the local merge so a real conflict can be resolved by hand
  watch     event stream for the Monitor tool - one line per state change, exits on merge
  fleet     read-only board of every open PR

Exit codes
  0  fine, or the mechanical work was done
  1  error - no gh, no PR, wrong branch, dirty tree
  3  needs Claude - a conflict to resolve or a red check to read
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [ValidateSet('open', 'arm', 'status', 'sync', 'resolve', 'watch', 'fleet')]
    [string]$Action,

    [int]$Pr = 0,
    [switch]$All,
    [int]$IntervalSeconds = 60,
    [int]$MaxMinutes = 0,
    [switch]$NoAutoMerge
)

$ErrorActionPreference = 'Stop'

# PowerShell 7.4 turns a native command's non-zero exit into a terminating error when
# ErrorActionPreference is Stop. Every `gh` call below reads $LASTEXITCODE deliberately -
# a BEHIND PR and a conflicted one are both "gh exited non-zero" - so that has to be off.
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

# GitHub's REST budget is 5000/hour and up to ten agents may be watching at once. 60s of
# poll costs each watcher ~180 calls/hour, which leaves headroom for the actual work.
if ($IntervalSeconds -lt 20) { $IntervalSeconds = 20 }

# release-please authors its own PR with GITHUB_TOKEN and it is nobody's branch to sync.
$ForeignBranchPrefix = 'release-please--'

# stdout, flushed per line. The Monitor tool turns each stdout line into a notification and
# batches on a 200ms window, so a buffered line is a notification that arrives late or not
# at all. Write-Host would work on a console and is a coin toss through a pipe.
#
# This writes past the PowerShell pipeline, straight to the process's stdout. Redirection
# and capture by another process - which is how Monitor reads it - work exactly as normal.
# In-process `| Out-Null` does not suppress it, which is deliberate: it also means these
# lines can never be mistaken for a function's return value, and Sync-One returns an int.
function Emit([string]$line) {
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
}

function Invoke-Gh([string[]]$GhArgs) {
    $out = & gh @GhArgs 2>&1 | Out-String
    return [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out.Trim() }
}

function Get-CurrentBranch {
    $b = (git rev-parse --abbrev-ref HEAD 2>$null)
    if (-not $b) { return $null }
    return $b.Trim()
}

function Test-CleanTree {
    $s = (git status --porcelain 2>$null | Out-String).Trim()
    return [string]::IsNullOrEmpty($s)
}

$PrFields = 'number,title,url,headRefName,baseRefName,state,isDraft,mergeable,mergeStateStatus,autoMergeRequest,author,labels'

function Get-PrData([int]$number) {
    $ghArgs = @('pr', 'view')
    if ($number -gt 0) { $ghArgs += "$number" }
    $ghArgs += @('--json', $PrFields)
    $r = Invoke-Gh $ghArgs
    if ($r.Code -ne 0) { return $null }
    try { return $r.Out | ConvertFrom-Json } catch { return $null }
}

# The one required context is `ci-ok`; a green `rust (windows-latest)` says nothing about
# the gate, so --required is not a convenience here, it is the correct question. gh exits 8
# while checks are pending and still prints the JSON.
function Get-Gate([int]$number) {
    $ghArgs = @('pr', 'checks')
    if ($number -gt 0) { $ghArgs += "$number" }
    $ghArgs += @('--required', '--json', 'name,bucket,state')
    $r = Invoke-Gh $ghArgs
    $rows = $null
    try { $rows = $r.Out | ConvertFrom-Json } catch { $rows = $null }

    if (-not $rows -or $rows.Count -eq 0) {
        # No required check has reported yet. That is a freshly pushed head, not a pass.
        return [pscustomobject]@{ Bucket = 'pending'; Detail = 'ci-ok has not reported yet' }
    }

    $names = ($rows | ForEach-Object { "$($_.name)=$($_.bucket)" }) -join ' '
    if ($rows | Where-Object { $_.bucket -eq 'fail' }) {
        return [pscustomobject]@{ Bucket = 'fail'; Detail = $names }
    }
    if ($rows | Where-Object { $_.bucket -eq 'pending' }) {
        return [pscustomobject]@{ Bucket = 'pending'; Detail = $names }
    }
    return [pscustomobject]@{ Bucket = 'pass'; Detail = $names }
}

# One word for what to do next. Everything else in this script switches on it.
#
# UNKNOWN is not a state, it is GitHub admitting it has not computed mergeability yet - it
# starts the computation when asked and answers UNKNOWN meanwhile. Measured 2026-08-14:
# PRs #58 and #51 both read UNKNOWN, then BEHIND ~60s later. Acting on UNKNOWN means
# treating a BEHIND PR as clean, so the caller re-polls instead.
function Get-State($pr) {
    if (-not $pr) { return 'NOPR' }
    if ($pr.state -eq 'MERGED') { return 'MERGED' }
    if ($pr.state -eq 'CLOSED') { return 'CLOSED' }
    if ($pr.isDraft) { return 'DRAFT' }

    switch ($pr.mergeStateStatus) {
        'UNKNOWN'  { return 'UNKNOWN' }
        'DIRTY'    { return 'CONFLICT' }
        'BEHIND'   { return 'BEHIND' }
        'DRAFT'    { return 'DRAFT' }
        'CLEAN'    { return 'CLEAN' }
        'HAS_HOOKS'{ return 'CLEAN' }
        default {
            # BLOCKED and UNSTABLE both mean "the gate is not satisfied". Which of red and
            # pending it is decides whether Claude is needed, so ask the checks.
            $gate = Get-Gate $pr.number
            if ($gate.Bucket -eq 'fail') { return 'RED' }
            if ($gate.Bucket -eq 'pending') { return 'WAITING' }
            return 'BLOCKED'
        }
    }
    return 'BLOCKED'
}

function Get-AutoMergeLabel($pr) {
    if ($pr.autoMergeRequest) { return 'auto-merge armed' }
    return 'auto-merge OFF'
}

# Not ours to touch. Three independent signals, because arming auto-merge on a release PR
# would cut a release nobody asked for, and one prefix string is a thin thing to bet a
# release on - a branch-prefix change in release-please config would silently disarm it.
#   - the branch prefix release-please uses
#   - a bot author (release-please commits as github-actions)
#   - the `autorelease:` label it puts on its own pull requests
# Any one of them is enough to disqualify a PR.
function Test-Foreign($pr) {
    if ($pr.headRefName.StartsWith($ForeignBranchPrefix)) { return $true }
    if ($pr.author -and ($pr.author.is_bot -eq $true)) { return $true }
    # gh reports this login as `app/github-actions`, not `github-actions[bot]`, so the glob
    # has to be loose at BOTH ends - anchoring it at the front matched nothing.
    if ($pr.author -and $pr.author.login -like '*github-actions*') { return $true }
    if ($pr.labels) {
        foreach ($l in $pr.labels) {
            if ($l.name -and $l.name.StartsWith('autorelease')) { return $true }
        }
    }
    return $false
}

# What a fan-out `-All` is allowed to act on: an ALLOWLIST, not a blocklist.
#
# The user's rule is that nothing may ever arm auto-merge across every open PR, because
# release-please keeps a release PR open and merging it ships a version. A blocklist gets
# that wrong the first time something unanticipated appears - the safe default for an
# unrecognised branch has to be "leave it alone", not "merge it".
#
# So `-All` only ever touches agent worktree branches, which this repo names after the
# directory in .claude/worktrees/. Anything else is skipped OUT LOUD, and `-Pr <n>` remains
# the way to act on one deliberately.
$OursBranchPrefix = 'worktree-'

function Test-Ours($pr) {
    if (Test-Foreign $pr) { return $false }
    return $pr.headRefName.StartsWith($OursBranchPrefix)
}

# Arming auto-merge IS the strategy - it is what lets the agent walk away. GitHub lands the
# PR the moment `ci-ok` goes green, so nobody has to be alive and watching at that instant.
# An unarmed PR goes green and then just sits there forever, which looks identical to a PR
# that is still working.
#
# --merge, not --squash: squash is disabled on this repo (squashMergeAllowed is false) and
# every existing autoMergeRequest on it records mergeMethod MERGE.
#
# Callers decide whether -NoAutoMerge applies; `arm` deliberately ignores it, because
# asking to arm and asking not to arm in the same breath is not a state worth honouring.
# Returns $true if the PR ends up armed - which includes gh merging it on the spot because
# it was already green and up to date. That is the goal, not a failure.
function Enable-AutoMerge($pr) {
    if ($pr.autoMergeRequest) { return $true }
    if ($pr.state -ne 'OPEN') { return $false }
    if (Test-Foreign $pr) {
        Emit "SKIP  #$($pr.number) is release-please's own PR - not ours to arm"
        return $false
    }

    $r = Invoke-Gh @('pr', 'merge', "$($pr.number)", '--auto', '--merge')
    if ($r.Code -eq 0) {
        Emit "ARMED #$($pr.number) auto-merge on - GitHub lands it once ci-ok is green"
        return $true
    }
    Emit "WARN  #$($pr.number) could not arm auto-merge: $($r.Out)"
    return $false
}

function Resolve-Pr([int]$number) {
    $pr = Get-PrData $number
    if (-not $pr) {
        if ($number -gt 0) { Emit "ERR   no pull request #$number" }
        else { Emit "ERR   no pull request for the current branch - run 'pr-auto.ps1 open' first" }
        exit 1
    }
    return $pr
}

# ---------------------------------------------------------------- open

function Invoke-Open {
    $branch = Get-CurrentBranch
    if (-not $branch) { Emit 'ERR   not inside a git repository'; exit 1 }
    if ($branch -eq 'main' -or $branch -eq 'HEAD') {
        Emit "ERR   on '$branch' - auto-pr needs a feature branch"
        exit 1
    }
    if (-not (Test-CleanTree)) {
        Emit 'ERR   working tree is dirty. Commit first - a PR opened over uncommitted work'
        Emit '      ships half of it, and the merge-main hook skips a dirty tree.'
        exit 1
    }

    & git push -u origin $branch 2>&1 | Out-String | ForEach-Object { if ($_.Trim()) { Emit "      $($_.Trim())" } }
    if ($LASTEXITCODE -ne 0) { Emit 'ERR   push failed'; exit 1 }

    $pr = Get-PrData 0
    if (-not $pr) {
        $r = Invoke-Gh @('pr', 'create', '--fill')
        if ($r.Code -ne 0) { Emit "ERR   gh pr create failed: $($r.Out)"; exit 1 }
        Emit "OK    opened $($r.Out)"
        $pr = Get-PrData 0
        if (-not $pr) { Emit 'ERR   PR created but could not be read back'; exit 1 }
    }
    else {
        Emit "OK    #$($pr.number) already open - $($pr.url)"
    }

    if (-not $NoAutoMerge) { Enable-AutoMerge $pr | Out-Null }

    Invoke-Status
}

# ---------------------------------------------------------------- arm

function Invoke-Arm {
    if ($All) {
        $r = Invoke-Gh @('pr', 'list', '--state', 'open', '--json', $PrFields, '--limit', '50')
        if ($r.Code -ne 0) { Emit "ERR   gh pr list failed: $($r.Out)"; exit 1 }
        $prs = $r.Out | ConvertFrom-Json
        $armed = 0
        $already = 0
        foreach ($p in $prs) {
            if (-not (Test-Ours $p)) {
                # Loudly, every time. A silent skip here is indistinguishable from having
                # armed it, and the whole point is that you can see a release PR was left
                # alone rather than having to trust that it was.
                $why = if (Test-Foreign $p) { 'not ours (release PR or bot-authored)' }
                       else { "branch is not $OursBranchPrefix*" }
                Emit "SKIP  #$($p.number) $($p.headRefName) - $why"
                continue
            }
            if ($p.autoMergeRequest) { $already++; continue }
            if (Enable-AutoMerge $p) { $armed++ }
        }
        Emit "OK    $armed newly armed, $already already armed"
        exit 0
    }

    $pr = Resolve-Pr $Pr
    if ($pr.autoMergeRequest) { Emit "OK    #$($pr.number) is already armed"; exit 0 }
    if (Enable-AutoMerge $pr) { exit 0 }
    exit 1
}

# ---------------------------------------------------------------- status

function Invoke-Status {
    $pr = Resolve-Pr $Pr
    $state = Get-State $pr
    if ($state -eq 'UNKNOWN') {
        Start-Sleep -Seconds 5
        $pr = Resolve-Pr $Pr
        $state = Get-State $pr
    }
    $gate = Get-Gate $pr.number
    Emit "$state #$($pr.number) $($pr.headRefName) - $(Get-AutoMergeLabel $pr) - gate: $($gate.Detail)"
    Emit "      $($pr.url)"

    switch ($state) {
        'BEHIND'   { Emit "      main has moved. Clear it: pr-auto.ps1 sync" }
        'CONFLICT' { Emit "      real conflict. Resolve it: pr-auto.ps1 resolve"; exit 3 }
        'RED'      { Emit "      ci-ok is red. Read it: gh pr checks $($pr.number) --required"; exit 3 }
        'CLEAN'    { Emit '      green and up to date - auto-merge takes it from here' }
        'WAITING'  { Emit '      CI running. Nothing to do.' }
    }
    exit 0
}

# ---------------------------------------------------------------- sync

# Clear BEHIND. Server-side on purpose: `gh pr update-branch` merges the base into the head
# ON GITHUB (a merge commit by default - never a rebase, which would strand any worktree
# tracking this branch). Nothing local is touched, so this works while Claude is mid-edit,
# while the tree is dirty, and after the agent that opened the PR has gone.
#
# The cost is that the local branch is now one commit behind its own remote, and the
# merge-main.sh hook will not fix it - that hook merges origin/main, not origin/<branch>.
# So fast-forward the local branch too, when this worktree is safely able to.
function Sync-One($pr) {
    if (Test-Foreign $pr) {
        Emit "SKIP  #$($pr.number) $($pr.headRefName) is release-please's own PR - not ours to sync"
        return 0
    }

    $r = Invoke-Gh @('pr', 'update-branch', "$($pr.number)")
    if ($r.Code -ne 0) {
        # update-branch refuses exactly when the merge would conflict, which is the
        # judgement half of the split. Re-read rather than trusting the message text.
        $after = Get-PrData $pr.number
        if ($after -and (Get-State $after) -eq 'CONFLICT') {
            Emit "CONFLICT #$($pr.number) $($pr.headRefName) - main will not merge cleanly, resolve it locally"
            return 3
        }
        Emit "WARN  #$($pr.number) update-branch failed: $($r.Out)"
        return 1
    }

    Emit "SYNCED #$($pr.number) $($pr.headRefName) - main merged on GitHub, ci-ok re-running"

    # Fast-forward this worktree if it is on that branch and clean. The remote merge commit
    # has the old local head as a parent, so --ff-only always succeeds when it applies.
    if ((Get-CurrentBranch) -eq $pr.headRefName -and (Test-CleanTree)) {
        & git fetch --quiet origin $pr.headRefName 2>&1 | Out-Null
        & git merge --ff-only FETCH_HEAD 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Emit "      local branch fast-forwarded to match" }
        else { Emit "      NOTE local branch still behind origin/$($pr.headRefName) - 'git pull' before your next push" }
    }
    return 0
}

function Invoke-Sync {
    if ($All) {
        $r = Invoke-Gh @('pr', 'list', '--state', 'open', '--json', $PrFields, '--limit', '50')
        if ($r.Code -ne 0) { Emit "ERR   gh pr list failed: $($r.Out)"; exit 1 }
        $prs = $r.Out | ConvertFrom-Json
        $worst = 0
        foreach ($p in $prs) {
            if ((Get-State $p) -ne 'BEHIND') { continue }
            if (-not (Test-Ours $p)) {
                Emit "SKIP  #$($p.number) $($p.headRefName) - not ours to sync"
                continue
            }
            $rc = Sync-One $p
            if ($rc -gt $worst) { $worst = $rc }
        }
        if ($worst -eq 0) { Emit 'OK    nothing left BEHIND' }
        exit $worst
    }

    $pr = Resolve-Pr $Pr
    $state = Get-State $pr
    if ($state -eq 'UNKNOWN') {
        Start-Sleep -Seconds 5
        $pr = Resolve-Pr $Pr
        $state = Get-State $pr
    }

    switch ($state) {
        'BEHIND'   { exit (Sync-One $pr) }
        'CONFLICT' { Emit "CONFLICT #$($pr.number) - resolve locally: pr-auto.ps1 resolve"; exit 3 }
        'MERGED'   { Emit "MERGED #$($pr.number) - nothing to do"; exit 0 }
        default    { Emit "OK    #$($pr.number) is $state - not BEHIND, nothing to sync"; exit 0 }
    }
}

# ---------------------------------------------------------------- resolve

# The local half, for a conflict only. Leaves the merge IN PROGRESS with markers in the
# tree, exactly like the merge-main.sh hook does, because resolving while the conflict is
# small is the point. The tree is verified clean first, so `git merge --abort` stays a
# lossless escape hatch at any later moment.
function Invoke-Resolve {
    $pr = Resolve-Pr $Pr
    $branch = Get-CurrentBranch

    if ($branch -ne $pr.headRefName) {
        Emit "ERR   this worktree is on '$branch' but #$($pr.number) is '$($pr.headRefName)'"
        Emit "      Resolve it from the worktree that owns the branch."
        exit 1
    }
    if (-not (Test-CleanTree)) {
        Emit 'ERR   working tree is dirty. Commit or stash first - a merge started over'
        Emit '      uncommitted work makes `git merge --abort` lossy.'
        exit 1
    }

    & git fetch --quiet origin main $branch 2>&1 | Out-Null

    # Pick up any server-side merge `sync` already landed, or the push will be rejected
    # later for reasons that look nothing like the conflict being resolved now.
    & git merge --ff-only "origin/$branch" 2>&1 | Out-Null

    & git merge --no-edit origin/main 2>&1 | Out-String | ForEach-Object {
        if ($_.Trim()) { Emit "      $($_.Trim())" }
    }
    if ($LASTEXITCODE -eq 0) {
        Emit "OK    #$($pr.number) main merged cleanly. Run 'npm run verify', then push."
        exit 0
    }

    $files = (& git diff --name-only --diff-filter=U 2>$null) | Where-Object { $_ }
    if (-not $files -or $files.Count -eq 0) {
        & git merge --abort 2>&1 | Out-Null
        Emit "ERR   the merge could not start and was rolled back - run 'git merge origin/main' by hand"
        exit 1
    }

    Emit "CONFLICT #$($pr.number) $($files.Count) files, merge IN PROGRESS:"
    foreach ($f in $files) { Emit "      $f" }
    Emit '      Reconcile BOTH sides by reading them - main is other agents shipped work.'
    Emit "      Never 'git add -A' and never 'git checkout --ours/--theirs' wholesale."
    if ($files -match 'package-lock\.json|package\.json') { Emit "      Dependencies conflicted - 'npm install' after resolving." }
    Emit "      Then: git add <each>, git commit --no-edit, npm run verify, git push."
    exit 3
}

# ---------------------------------------------------------------- watch

# The Monitor-facing loop. One stdout line per STATE CHANGE, so a PR that sits WAITING for
# twenty minutes is silent rather than twenty notifications. BEHIND is cleared here and
# reported; CONFLICT and RED are announced and left for Claude. Exits when the PR merges,
# which is what makes this safe to arm with `persistent: true`.
function Invoke-Watch {
    $pr = Resolve-Pr $Pr
    $number = $pr.number
    Emit "WATCH #$number $($pr.headRefName) - $(Get-AutoMergeLabel $pr) - $($pr.url)"

    # Arm on the way in rather than warn about it. A watch on an unarmed PR is a watch that
    # never ends: it reaches CLEAN and stops there, and the notification stream goes quiet
    # in exactly the way "still working" does.
    if (-not $NoAutoMerge) { Enable-AutoMerge $pr | Out-Null }

    $deadline = if ($MaxMinutes -gt 0) { (Get-Date).AddMinutes($MaxMinutes) } else { $null }
    $last = ''
    $unknownRuns = 0
    # GitHub can still report BEHIND for a poll or two after update-branch has landed, and
    # main may genuinely have moved again underneath. Without a floor here, a PR that keeps
    # reading BEHIND gets an update-branch every single poll - ten watchers doing that is a
    # CI stampede against a repo where each run costs minutes.
    $syncFloorSeconds = 180
    $lastSync = [DateTime]::MinValue

    while ($true) {
        if ($deadline -and (Get-Date) -gt $deadline) {
            Emit "STOP  #$number watch hit its $MaxMinutes minute limit, still $last"
            exit 0
        }

        $pr = Get-PrData $number
        if (-not $pr) {
            # A transient gh or network failure must not end the watch.
            Emit "WARN  #$number could not be read - retrying"
            Start-Sleep -Seconds $IntervalSeconds
            continue
        }

        $state = Get-State $pr

        if ($state -eq 'UNKNOWN') {
            # Asking is what makes GitHub compute it, so a short re-poll usually settles it.
            $unknownRuns++
            if ($unknownRuns -le 3) { Start-Sleep -Seconds 10; continue }
            $unknownRuns = 0
        }
        else { $unknownRuns = 0 }

        if ($state -ne $last) {
            switch ($state) {
                'MERGED' {
                    Emit "MERGED #$number $($pr.headRefName) is in. Watch over."
                    exit 0
                }
                'CLOSED' {
                    Emit "CLOSED #$number was closed without merging. Watch over."
                    exit 0
                }
                'BEHIND' {
                    if (((Get-Date) - $lastSync).TotalSeconds -lt $syncFloorSeconds) {
                        # Recently synced and still BEHIND: auto-merge is on it, or main
                        # moved again. Either way, leave it alone this round.
                        $state = 'SYNCING'
                    }
                    else {
                        $lastSync = Get-Date
                        $rc = Sync-One $pr
                        # Sync-One has already emitted its own line, including the CONFLICT
                        # one. Record the state it actually left behind so the next poll
                        # does not announce the same conflict a second time.
                        $state = if ($rc -eq 3) { 'CONFLICT' } else { 'SYNCING' }
                    }
                }
                'CONFLICT' {
                    Emit "CONFLICT #$number $($pr.headRefName) will not merge with main - Claude must resolve it. Run: pr-auto.ps1 resolve"
                }
                'RED' {
                    $gate = Get-Gate $number
                    Emit "RED   #$number ci-ok failed ($($gate.Detail)) - Claude must read it. Run: gh pr checks $number --required"
                }
                'BLOCKED' {
                    Emit "BLOCKED #$number is blocked with no failing check - review, approval, or a branch rule."
                }
                'DRAFT' {
                    Emit "DRAFT #$number is a draft - it will never merge until it is marked ready."
                }
                'CLEAN' {
                    # Green and up to date is the one state that should not persist. If it
                    # does, auto-merge came off at some point - re-arm rather than sit here
                    # watching a finished PR forever.
                    if (-not $pr.autoMergeRequest -and -not $NoAutoMerge) {
                        Emit "CLEAN #$number green and up to date, but auto-merge is off - arming it."
                        Enable-AutoMerge $pr | Out-Null
                    }
                    else {
                        Emit "CLEAN #$number green and up to date - auto-merge should take it now."
                    }
                }
                'WAITING' {
                    Emit "WAITING #$number ci-ok is running."
                }
            }
            $last = $state
        }

        Start-Sleep -Seconds $IntervalSeconds
    }
}

# ---------------------------------------------------------------- fleet

function Invoke-Fleet {
    $r = Invoke-Gh @('pr', 'list', '--state', 'open', '--json', $PrFields, '--limit', '50')
    if ($r.Code -ne 0) { Emit "ERR   gh pr list failed: $($r.Out)"; exit 1 }
    $prs = $r.Out | ConvertFrom-Json
    if (-not $prs -or $prs.Count -eq 0) { Emit 'OK    no open pull requests'; exit 0 }

    # State is resolved ONCE per PR and carried, because Get-State asks gh about the checks
    # for anything BLOCKED or UNSTABLE - recomputing it for the summary lines below doubled
    # the API calls for a board that is meant to be cheap enough to run constantly.
    $rows = @()
    foreach ($p in ($prs | Sort-Object number)) {
        $state = Get-State $p
        # `gh pr list` does not make GitHub compute mergeability - only asking about a
        # single PR does. Half this board came back UNKNOWN without this re-read.
        if ($state -eq 'UNKNOWN') {
            $fresh = Get-PrData $p.number
            if ($fresh) { $p = $fresh; $state = Get-State $fresh }
        }
        $rows += [pscustomobject]@{ Pr = $p; State = $state }
    }

    $needs = 0
    foreach ($row in $rows) {
        $p = $row.Pr
        $am = if ($p.autoMergeRequest) { 'auto' } else { '   -' }
        $tag = if (Test-Foreign $p) { ' (release PR - never armed)' }
               elseif (-not (Test-Ours $p)) { ' (not a worktree branch - -All skips it)' }
               else { '' }
        Emit ("{0,-9} #{1,-4} {2} {3}{4}" -f $row.State, $p.number, $am, $p.headRefName, $tag)
        if ($row.State -eq 'CONFLICT' -or $row.State -eq 'RED') { $needs++ }
    }

    # Both hints count only what `-All` would actually touch. Offering to fix five when the
    # command will move three is how a release PR ends up looking like it was included.
    $behind = @($rows | Where-Object { $_.State -eq 'BEHIND' -and (Test-Ours $_.Pr) })
    if ($behind.Count -gt 0) { Emit "      $($behind.Count) BEHIND - clear them with: pr-auto.ps1 sync -All" }

    # An unarmed PR is the quiet failure on this board: it can go all the way to green and
    # then stop, looking exactly like one that is still building.
    $unarmed = @($rows | Where-Object { -not $_.Pr.autoMergeRequest -and (Test-Ours $_.Pr) })
    if ($unarmed.Count -gt 0) { Emit "      $($unarmed.Count) with auto-merge OFF - arm them with: pr-auto.ps1 arm -All" }
    if ($needs -gt 0) { Emit "      $needs need Claude (CONFLICT or RED)"; exit 3 }
    exit 0
}

# ----------------------------------------------------------------

# PR_AUTO_TEST_NO_RUN is for pr-auto.test.ps1 only, and never set in real use. The test
# dot-sources this file to reach Test-Foreign and Test-Ours as functions - they are pure,
# and driving them through the CLI would need a live repo full of release PRs to assert on.
# Returning here binds the param block and defines everything above without running an
# action or requiring gh.
if ($env:PR_AUTO_TEST_NO_RUN) { return }

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Emit 'ERR   the GitHub CLI (gh) is not on PATH'
    exit 1
}

switch ($Action) {
    'open'    { Invoke-Open }
    'arm'     { Invoke-Arm }
    'status'  { Invoke-Status }
    'sync'    { Invoke-Sync }
    'resolve' { Invoke-Resolve }
    'watch'   { Invoke-Watch }
    'fleet'   { Invoke-Fleet }
}

# Every path above exits deliberately. Falling off the end instead would hand the caller
# $LASTEXITCODE from whichever `gh` ran last inside - and `gh pr checks --required` exits 1
# when nothing has reported and 8 while checks are pending. A calm `status` reported failure
# that way, so this backstop is not ceremony: 0, 1 and 3 have to mean what the header says.
exit 0
