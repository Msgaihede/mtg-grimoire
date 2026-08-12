# Worktree Agent Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three project skills under `.claude/skills/` so an agent in a fresh worktree can set the workspace up, run the real app without silently destroying another agent's session, and take its work to a green pull request.

**Architecture:** Two of the skills are prose. The third ships one reusable tool — `lock.ps1`, a PowerShell script holding two exclusive locks (`app`, `storybook`) in the shared git common dir — because "release the lock when you finish" only actually happens if releasing is one command that also stops the process. Ports are never remapped; contention is serialised.

**Tech Stack:** Markdown skills with YAML frontmatter (`agentskills.io` spec), PowerShell 7 (`pwsh`), `gh` CLI 2.95, git worktrees.

## Global Constraints

- **Ports are fixed at 1420 (Vite), 6006 (Storybook), 9222 (CDP) and must not be remapped.** `src-tauri/tauri.conf.json`'s `devCsp` hardcodes `ws://localhost:1420` and `http://localhost:1420`; `.mcp.json` hardcodes `http://localhost:6006/mcp`. Both files are tracked by git.
- **No task may modify `vite.config.ts`, `src-tauri/tauri.conf.json`, or `.mcp.json`.**
- Lock directory is `<git common dir>/locks/`. `git rev-parse --path-format=absolute --git-common-dir` returns `D:/Code/mtg-grimoire/.git` from the main checkout **and** from a worktree — verified 2026-08-12.
- Skill frontmatter has exactly two required fields, `name` and `description`; `name` is letters/numbers/hyphens only; `description` is third person, starts with "Use when", and **never summarises the skill's workflow**.
- PowerShell: never `New-Item -Force` on a file (it truncates). Never name a parameter `-Pid` (`$PID` is an automatic variable) — use `-ProcessId`.
- Commit with conventional prefixes (`feat:`/`fix:`/`chore:`/`docs:`/`test:`); release-please parses them.
- End every commit message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: The lock tool

**Files:**
- Create: `.claude/skills/running-the-app/lock.ps1`
- Test: `.claude/skills/running-the-app/lock.test.ps1`

**Interfaces:**
- Consumes: nothing.
- Produces: a script with four actions, used verbatim by Task 3's SKILL.md.
  - `lock.ps1 status [app|storybook|all]` → prints one line per lock: `FREE <name>`, `HELD <name> -> …`, or `STALE <name> -> …`. Always exits 0.
  - `lock.ps1 acquire <app|storybook> -What "<text>"` → exit 0 and prints `OK`, or exit 1 and prints `HELD`. Takes over a stale lock, printing `STALE`.
  - `lock.ps1 adopt <app|storybook> -ProcessId <int>` → records pid + process name into the lock this worktree already holds. Exit 1 if there is no lock, the lock is another worktree's (without `-Force`), or the pid is not running.
  - `lock.ps1 release <app|storybook> [-KeepProcess] [-Force]` → stops the recorded process if it is alive and its name matches, then deletes the lock. Exit 0 when there was no lock.
  - Environment: `MTG_LOCK_DIR` overrides the lock directory. **Test-only.**

- [ ] **Step 1: Write the failing test**

Create `.claude/skills/running-the-app/lock.test.ps1`:

```powershell
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run (PowerShell tool):
```
pwsh -NoProfile -File .claude\skills\running-the-app\lock.test.ps1
```
Expected: every `Check` reports `FAIL`, because `lock.ps1` does not exist. Final line `9 failed`, exit 1.

- [ ] **Step 3: Write the lock tool**

Create `.claude/skills/running-the-app/lock.ps1`:

```powershell
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run (PowerShell tool):
```
pwsh -NoProfile -File .claude\skills\running-the-app\lock.test.ps1
```
Expected: nine `pass` lines and a final `all passed`, exit 0. If `adopt` reports the process name as something other than `pwsh`, read the actual value out of the lock file and fix the test's expectation — the assertion is about the name being *recorded*, not about it being `pwsh`.

- [ ] **Step 5: Confirm the real lock dir resolves and is not inside any worktree**

Run (PowerShell tool):
```
pwsh -NoProfile -File .claude\skills\running-the-app\lock.ps1 status
```
Expected: `FREE  app` and `FREE  storybook`, and a new empty directory at `D:\Code\mtg-grimoire\.git\locks`. Confirm it is not tracked:
```
git status --short
```
Expected: no mention of `.git/locks`.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/running-the-app/lock.ps1 .claude/skills/running-the-app/lock.test.ps1
git commit -m "feat(skills): exclusive app and storybook locks for parallel worktrees

Two locks in the shared git common dir. Claim is O_EXCL; a lock whose pid is
dead or renamed is stale and gets taken over; release stops the process and
deletes the lock in one command.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The `worktree-setup` skill

**Files:**
- Create: `.claude/skills/worktree-setup/SKILL.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the skill name `worktree-setup`, referenced by Task 3 and Task 5.

- [ ] **Step 1: Establish the baseline — prove the failure this skill prevents**

This worktree has no `node_modules` (verified 2026-08-12). Before installing, run:

```
npx vitest run src/lib/mana.test.ts
```
Expected: failure mentioning `Denied ID` and a path under the **main** checkout's `node_modules`. Record the exact message — it goes in the skill. If it does not fail, `node_modules` already exists; say so and skip to Step 3 rather than inventing the symptom.

- [ ] **Step 2: Write the skill**

Create `.claude/skills/worktree-setup/SKILL.md`:

```markdown
---
name: worktree-setup
description: Use when starting work in an mtg-grimoire git worktree under .claude/worktrees/, before running npm run verify, the test suite, the app, or Storybook. Symptoms it prevents - "Denied ID .../node_modules/mana-font/css/mana.css?raw", failing mana/keyrune/iconFont suites, 403s on @fontsource woff2 files, TS2307 after a merge, and files that should exist but do not.
---

# Worktree setup

A worktree is a full second checkout. It shares the git object store with the main
checkout and **almost nothing else** — not `node_modules`, not `src-tauri/target`, not
the database. Two things before anything else.

## 1. Check your base branch

A worktree-isolated dispatch is created from `main`, not from the session's branch. Nine
of ten agents in one plan hit this, several after a long time spent on files that should
have existed and did not.

```powershell
git log --oneline -3
git branch --show-current
Test-Path "src/features/decks/DeckEditor.tsx"   # or any file your task requires
```

On `main` when you should be on a feature branch, fast-forward to it. **Use the
PowerShell tool** — the Bash tool refuses `git reset --hard`, `git merge --ff-only` and
`git switch -c` in an isolated session.

Never rebase and never `git reset` a branch another agent may be tracking.

## 2. `npm install`, inside the worktree

```powershell
npm install
```

Without it `node_modules` resolves to the main checkout, outside the worktree root,
where Vite's `server.fs.allow` denies it:

- `src/lib/mana.test.ts`, `src/lib/keyrune.test.ts` and `src/lib/iconFont.test.ts` fail
  with `Error: Denied ID D:/Code/mtg-grimoire/node_modules/mana-font/css/mana.css?raw`
- `tauri dev` logs 403s for the `@fontsource`, `mana-font` and `keyrune` woff2 files

`npm run verify` stops at the frontend tests, so its `cargo test` half never runs and the
whole thing reads as a regression you just caused. It is not.

**Run `npm install` again after any merge that brought a dependency** — otherwise `tsc`
fails TS2307 on the new import, which also reads as a real failure and is not.

## What is and is not shared

| Per worktree | Shared with every worktree |
| --- | --- |
| `node_modules` | the git object store |
| `src-tauri/target` (gigabytes) | **the stash stack** |
| `src-tauri/target/debug/data/mtg.db` | the lock dir, `.git/locks/` |

**Never use bare `git stash` or `git stash pop`.** The stack is shared and another
agent's work may be on it. Prefer a temporary WIP commit. If you must stash, use
`git stash push -u -m "<unique-tag>"`, capture the SHA, and restore with
`git stash apply <sha>`.

## A database without a 93-second sync

```powershell
$dst = "src-tauri\target\debug\data"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item "D:\Code\mtg-grimoire\src-tauri\target\debug\data\mtg.db" $dst
```

~547 MB and seconds, against ~93 s and a 77 MB download. The copy carries the card
corpus and **no collection or wishlist rows**, so those two views render their empty
state and there is no table to test until you seed one.

## The Bash tool refuses things here

In a worktree-isolated session, Bash rejects commands it cannot prove stay inside the
worktree: redirects, `eval`, several chained parts, git commands aimed elsewhere. The
PowerShell tool has no such check. Plain `npm` and `git` still work in Bash.

## Finish

```powershell
npm run verify
```

Green means the workspace is real: build, lint, Vitest and `cargo test`.

Then: the `running-the-app` skill before launching anything, and `shipping-a-branch`
when the work is done.
```

- [ ] **Step 3: Verify the skill's central claim by following it**

Run (PowerShell tool, from the worktree root):
```
npm install
```
Then:
```
npx vitest run src/lib/mana.test.ts src/lib/keyrune.test.ts src/lib/iconFont.test.ts
```
Expected: all three pass, where Step 1 had at least one failing. That transition is the skill's claim.

- [ ] **Step 4: Verify the whole suite**

Run:
```
npm run verify
```
Expected: green through build, lint, Vitest and `cargo test`. Note that `cargo test` may take several minutes on a cold `src-tauri/target`.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/worktree-setup/SKILL.md
git commit -m "docs(skills): worktree setup, and why a fresh worktree fails three suites

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The `running-the-app` skill

**Files:**
- Create: `.claude/skills/running-the-app/SKILL.md`

**Interfaces:**
- Consumes: `lock.ps1` from Task 1 — the four actions exactly as named there.
- Produces: the skill name `running-the-app`, referenced by Tasks 2, 4 and 5.

- [ ] **Step 1: Write the skill**

Create `.claude/skills/running-the-app/SKILL.md`:

```markdown
---
name: running-the-app
description: Use when launching MTG Grimoire, a live CDP pass, the Vite dev server, or Storybook from any checkout of this repo. Only one app and one Storybook can run at a time across every worktree, and both collisions are silent - a second app exits with code 0, no window and no stderr, and a second Storybook leaves the mtg-grimoire-sb-mcp server answering from the first agent's stories.
---

# Running the app

**Two things here are exclusive across every worktree, and both fail quietly.**

- **The app.** `tauri-plugin-single-instance` is registered before every other plugin
  (`src-tauri/src/lib.rs:203`) and keys on the `com.mtggrimoire.app` identifier, which
  every worktree builds. A second instance gets **exit code 0, no window, no stderr** —
  it reads as a broken build. A debug build from `target/debug` counts.
- **Storybook.** `.mcp.json` points `mtg-grimoire-sb-mcp` at `http://localhost:6006/mcp`.
  A second Storybook lands on a different port and the MCP then answers **from the first
  agent's stories**. Nothing on either side says so.

So take a lock. `lock.ps1` sits beside this file.

## Ports are fixed. Do not remap them.

1420 (Vite), 6006 (Storybook), 9222 (CDP). `src-tauri/tauri.conf.json`'s `devCsp`
hardcodes `ws://localhost:1420`, and `.mcp.json` hardcodes 6006. **Both files are
tracked**, so a per-worktree port is a dirty tracked file that rides into a pull request
— and remapping would not help anyway, because the single-instance guard is not about a
port. Serialise with the lock instead.

## The protocol

```powershell
$L = ".claude\skills\running-the-app\lock.ps1"

pwsh -NoProfile -File $L status
pwsh -NoProfile -File $L acquire app -What "CDP pass on the deck editor"
# ... launch, capture the process ...
pwsh -NoProfile -File $L adopt app -ProcessId $proc.Id
# ... do the work ...
pwsh -NoProfile -File $L release app
```

`acquire` exits 1 and prints `HELD` when another worktree has it. **Wait — poll every
15 seconds for up to 5 minutes, then tell the user who holds it.** Never kill another
agent's app: a live CDP pass is measurements in flight.

A lock whose pid is dead, or alive under a different process name, is **stale**;
`acquire` takes it over and says so.

## Launching

```powershell
Get-Process mtg-grimoire -ErrorAction SilentlyContinue   # must be empty
(Get-Item src-tauri\src\main.rs).LastWriteTime = Get-Date
npm run tauri build -- --debug --no-bundle
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
$proc = Start-Process "src-tauri\target\debug\mtg-grimoire.exe" -PassThru
```

Three traps, all measured:

- **A frontend-only edit does not reach a built binary.** `tauri build` re-runs Vite,
  then cargo sees no Rust change and leaves the old bundle inside the old exe — and
  exits 0. Touching `main.rs` first is what forces the relink. The cheap tell is
  `[...document.querySelectorAll('script')].map(s => s.src)` against `ls dist/assets`.
- **The exe cannot be relinked while it runs** — `Access is denied. (os error 5)`. Stop
  it first.
- `npm run tauri dev` has neither problem, because Vite serves the frontend. Prefer it
  unless you are specifically measuring a release path. It still takes the `app` lock.

## Driving it

`scripts/cdp.mjs`. CLAUDE.md's "Verifying UI in the real app" is the command vocabulary
and the trap list; this skill does not repeat it.

**Run cdp.mjs through the PowerShell tool.** Bash refuses
`node scripts/cdp.mjs eval "<expr>"` as unverifiable. Wrap the JS in double quotes with
single quotes inside — a nested `\"` in a CSS selector reaches the page unescaped — and
avoid `$`, which PowerShell interpolates before node sees it.

`CDP_PORT` overrides 9222 if you ever need it to.

## Storybook

```powershell
pwsh -NoProfile -File $L acquire storybook -What "component work"
$sb = Start-Process npm -ArgumentList "run","storybook" -PassThru
pwsh -NoProfile -File $L adopt storybook -ProcessId $sb.Id
# ... use the mtg-grimoire-sb-mcp tools ...
pwsh -NoProfile -File $L release storybook
```

## You are not done until you have released

Releasing is **stop the process, then delete the lock** — `release` does both in one
command. Do it on success, on failure, and when you abandon the task. A held lock over a
live process blocks every other agent, and nothing will clear it for you.

| Rationalisation | Reality |
| --- | --- |
| "The next step needs it, I'll leave it up" | Release, then acquire again. It costs seconds. |
| "The task failed, so there is nothing to clean up" | The app is still running. Release. |
| "Another agent can just take it" | Only if the process is dead. Yours is not. |
| "The user will close the window" | They will not know it is theirs to close. |
| "I only ran Storybook, that is not the app" | It is the other lock. Release it. |

Before you report finishing, run `lock.ps1 status`. Anything reading `HELD` and naming
your worktree means you are not finished.
```

- [ ] **Step 2: Verify the protocol end to end**

Run each of these (PowerShell tool) and confirm the stated output:

```
pwsh -NoProfile -File .claude\skills\running-the-app\lock.ps1 status
```
Expected: `FREE  app`, `FREE  storybook`.

```
pwsh -NoProfile -File .claude\skills\running-the-app\lock.ps1 acquire app -What "skill verification"
```
Expected: `OK    app acquired by D:/Code/mtg-grimoire/.claude/worktrees/project-skills`.

```
pwsh -NoProfile -File .claude\skills\running-the-app\lock.ps1 acquire app -What "second attempt"
```
Expected: `HELD` and exit 1.

```
pwsh -NoProfile -File .claude\skills\running-the-app\lock.ps1 release app
```
Expected: `OK    app released`, and `status` back to `FREE  app`.

- [ ] **Step 3: Verify the Storybook half against a real server**

```
pwsh -NoProfile -File .claude\skills\running-the-app\lock.ps1 acquire storybook -What "verify"
$sb = Start-Process npm -ArgumentList "run","storybook" -PassThru
pwsh -NoProfile -File .claude\skills\running-the-app\lock.ps1 adopt storybook -ProcessId $sb.Id
```
Expected: `OK    storybook now holds pid <n> (<name>)`. Then release and confirm the process is gone:
```
pwsh -NoProfile -File .claude\skills\running-the-app\lock.ps1 release storybook
Get-Process -Id $sb.Id -ErrorAction SilentlyContinue
```
Expected: `OK    stopped …`, `OK    storybook released`, and no process.

Note honestly in the task report if `npm` spawns Storybook as a **child** process, so
stopping the `npm` pid leaves node on 6006. If that happens, adopt the node pid instead
and add one line to the skill saying so.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/running-the-app/SKILL.md
git commit -m "docs(skills): running the app, and the two locks that make it safe

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The `shipping-a-branch` skill

**Files:**
- Create: `.claude/skills/shipping-a-branch/SKILL.md`

**Interfaces:**
- Consumes: the skill names `running-the-app` (Task 3) and `worktree-setup` (Task 2).
- Produces: the skill name `shipping-a-branch`, referenced by Task 5.

- [ ] **Step 1: Write the skill**

Create `.claude/skills/shipping-a-branch/SKILL.md`:

```markdown
---
name: shipping-a-branch
description: Use when work in this repo is finished and needs to reach main - running npm run verify, committing, pushing, opening a pull request with gh, and clearing conflicts against main. Also use when a PR shows conflicts, when a check is red, or when unsure which CI check actually gates a merge or who is allowed to press Merge.
---

# Shipping a branch

Take the branch to a green pull request. **You do not merge it.**

## Before you start

- Locks released and the app stopped — `lock.ps1 status` must not name your worktree.
  See the `running-the-app` skill.
- `git status` clean of anything you did not mean to commit. Never `git add -A` from a
  worktree parent directory.

## 1. Verify, and read the output

```powershell
npm run verify
```

Build, lint, Vitest and `cargo test`. **Read what it printed.** "It should pass" is not
evidence; a green run in this session is. If it fails, fix it — do not push and hope CI
disagrees with your machine.

## 2. Commit small, with a conventional prefix

`feat:` `fix:` `chore:` `docs:` `test:`. release-please parses these to decide the next
version, so the prefix is a release decision rather than a style choice. While the app is
on `0.x`, a `!` bumps the **minor**.

## 3. Push and open the pull request

```powershell
git push -u origin (git branch --show-current)
gh pr create --fill
```

## 4. Merge main in. Never rebase.

```powershell
git fetch origin main
git merge origin/main
```

**Merge, never rebase and never reset.** Other agents' worktrees may track this branch,
and rewriting its history strands their work. Every conflict resolution in this
repository's history is a merge — `d4f7281`, `39e1132`.

Resolve conflicts in the working tree, then:

- **If the merge brought a new dependency, `npm install` again** — otherwise `tsc` fails
  TS2307 on the new import and it reads as a real failure.
- Re-run `npm run verify`.
- Push.

## 5. Wait for `ci-ok`

```powershell
gh pr checks --watch
```

**`ci-ok` is the one protected check.** Branch protection pins check names as strings and
a matrix job's name embeds its matrix values, so the aggregator is what has teeth — a
green `rust (windows-latest)` says nothing about the gate.

A change only builds the half it touched, so a **skipped** `frontend` or `rust` job is
the path router working, not a failure.

## 6. Report, and stop

Give the user the pull request URL and the `ci-ok` state. **Do not merge.** Do not enable
auto-merge, do not delete the branch, do not remove the worktree. The user presses Merge.

## Two things that look broken and are not

- **A release-please PR opens in `action_required` with zero jobs.** That is GitHub's
  recursion guard on a `GITHUB_TOKEN`-authored pull request, not a broken workflow. It
  needs approving before CI runs — and it is not your PR.
- **`ci-ok` treats a skipped build job as a pass.** Deliberate, and the reason the
  `changes` router job itself must succeed.

## Red flags — stop

- About to run `git rebase`, `git reset --hard`, or `git push --force`.
- About to run `gh pr merge`, or `gh pr merge --auto`.
- About to say "tests pass" without having run them in this session.
- About to open a PR with a lock still held by your worktree.
```

- [ ] **Step 2: Verify the two factual claims that can be checked without merging anything**

```
gh pr checks 24 2>&1 | Select-Object -First 20
```
Expected: a list of check names including `ci-ok`. If `ci-ok` is absent from that list, the skill's step 5 is wrong — find the real gate name with `gh api repos/Msgaihede/mtg-grimoire/branches/main/protection` and correct the skill before committing.

```
git log --oneline --merges -12
```
Expected: merge commits resolving main into feature branches, confirming the "merge, never rebase" claim the skill cites (`d4f7281`, `39e1132`).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/shipping-a-branch/SKILL.md
git commit -m "docs(skills): take a branch to a green PR and stop there

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Point CLAUDE.md at the skills

**Files:**
- Modify: `CLAUDE.md` — insert a new section immediately after the `## Commands` block and before `## CI and releases`.

**Interfaces:**
- Consumes: all three skill names from Tasks 2–4.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Insert the pointer section**

In `CLAUDE.md`, after the `## Commands` bullet list and before `## CI and releases (measured live 2026-08-09)`, insert:

```markdown
## Project skills (`.claude/skills/`)

Three skills carry the worktree workflow and are the authority on it — this file does not
repeat them:

- **`worktree-setup`** — first thing in a fresh worktree. `npm install` inside it (without
  which three suites fail on Vite's `fs.allow` and it reads as your regression), the
  base-branch check, and what is not shared with the main checkout.
- **`running-the-app`** — **only one app and one Storybook can run across every worktree**,
  and both collisions are silent. Two locks in `.git/locks/`, claimed and released through
  `.claude/skills/running-the-app/lock.ps1`. Ports stay 1420/6006/9222; they are hardcoded
  in tracked files and must not be remapped.
- **`shipping-a-branch`** — `npm run verify` → PR → merge `main` in (never rebase) →
  wait for `ci-ok`. The agent does not press Merge.
```

- [ ] **Step 2: Verify the insertion did not break the surrounding sections**

```
grep -n "^## " CLAUDE.md | head -12
```
Expected: `## Commands`, then `## Project skills (\`.claude/skills/\`)`, then `## CI and releases (measured live 2026-08-09)`, in that order and each appearing once.

- [ ] **Step 3: Verify the three skills are discoverable**

```
ls .claude/skills/*/SKILL.md
```
Expected: exactly three paths — `worktree-setup`, `running-the-app`, `shipping-a-branch`. Confirm each file's first line is `---` and that its frontmatter has a `name` matching its directory.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: point CLAUDE.md at the three worktree skills

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Ship it, following `shipping-a-branch`

**Files:** none — this task executes the skill written in Task 4 against this branch, which is the only honest test of it.

**Interfaces:**
- Consumes: `shipping-a-branch` (Task 4).
- Produces: a pull request URL and a `ci-ok` state.

- [ ] **Step 1: Confirm no lock is held**

```
pwsh -NoProfile -File .claude\skills\running-the-app\lock.ps1 status
```
Expected: `FREE  app`, `FREE  storybook`.

- [ ] **Step 2: Verify**

```
npm run verify
```
Expected: green. Paste the tail of the output into the task report.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin worktree-project-skills
gh pr create --title "Project skills: worktree setup, exclusive app locks, and the PR flow" --body "Three skills under .claude/skills/ plus lock.ps1.

Only one app and one Storybook can run across every worktree — tauri-plugin-single-instance gives a second app exit code 0 with no window, and a second Storybook leaves the sb MCP answering from the first one's stories. Both are now lock-protected, with release stopping the process and deleting the lock in one command. Ports stay 1420/6006/9222 because tauri.conf.json's devCsp and .mcp.json hardcode them.

Design: docs/superpowers/specs/2026-08-12-worktree-agent-skills-design.md
Plan: docs/superpowers/plans/2026-08-12-worktree-agent-skills.md"
```

- [ ] **Step 4: Merge main in and clear conflicts**

```bash
git fetch origin main
git merge origin/main
```
If it conflicts, resolve in the working tree, `npm install` if a dependency arrived, re-run `npm run verify`, then push. If it is already up to date, say so.

- [ ] **Step 5: Wait for `ci-ok`**

```
gh pr checks --watch
```
Expected: `ci-ok` passes. Note that `.claude/**` is an unrecognised path to the `changes` router, which routes unrecognised paths to **both** jobs — so expect a full run rather than a skip.

- [ ] **Step 6: Report and stop**

Report the PR URL and the `ci-ok` result. **Do not merge.**

---

## Self-Review

**Spec coverage.** Every section of `docs/superpowers/specs/2026-08-12-worktree-agent-skills-design.md` maps to a task: lock home and lock file → Task 1; skill 1 → Task 2; skill 2 → Task 3; skill 3 → Task 4; the spec's Testing section → Task 1 Steps 2/4/5, Task 2 Steps 1/3/4, Task 3 Steps 2/3, Task 5 Step 3. The spec's `git-common-dir` and `CreateNew` checks were both run before this plan was written and both passed; Task 1 Step 5 and Task 5 Step 3 re-confirm them in place.

**Two spec items deliberately upgraded.** The spec said release is "stop the process, then delete the lock" as two instructions to the agent; the plan makes `release` do both, because an instruction an agent can half-perform is worse than a command it cannot. And the spec did not name a grace window for an un-adopted lock; the plan sets 10 minutes, since `acquire` and `adopt` are two calls and a crash between them must not block forever.

**Not covered, and why.** `superpowers:writing-skills` requires baseline pressure-testing with subagents before a skill is trusted. This session is under a standing instruction not to use the Agent tool unless asked, so no task dispatches one. The mechanical claims are all verified by execution instead. **If you want the discipline half of `running-the-app` — the release rule — pressure-tested with subagents, say so and it becomes Task 7.**

**Type consistency.** `lock.ps1`'s four actions and their parameters (`-What`, `-ProcessId`, `-KeepProcess`, `-Force`) are spelled identically in Task 1's interface block, Task 1's implementation, Task 1's test, Task 3's SKILL.md and Tasks 3/6's verification steps. `-ProcessId` is never written `-Pid`. `MTG_LOCK_DIR` is spelled identically in the script and the test.
