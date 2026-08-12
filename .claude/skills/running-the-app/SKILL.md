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
15 seconds for up to 10 minutes, then tell the user who holds it.** Ten, not five,
because a lock that has been acquired but not yet adopted is held live for exactly ten
minutes (`lock.ps1`'s `$UnadoptedGraceMinutes`) — long enough to cover a cold
`tauri dev` cargo build, which is the honest reason that gap is long. Polling for less
than the grace window means an *abandoned* un-adopted lock can never be waited out.
Never kill another agent's app: a live CDP pass is measurements in flight.

A lock whose pid is dead, or alive as a different process (name **and** start time are
both checked, because Windows reuses pids and half this repo's processes are called
`node`), is **stale**; `acquire` takes it over and says so. So is a lock file the script
cannot parse.

**The escape hatch, and it is the last resort:** `release <name> -Force` deletes a lock
belonging to another worktree. Use it only when `status` calls the lock `STALE` and you
have confirmed with `Get-Process` that nothing is running — never to jump a `HELD` queue.

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
  unless you are specifically measuring a release path. It still takes the `app` lock —
  and it adopts differently, below.

### Dev mode adopts the app, not the launcher

```powershell
Get-Process mtg-grimoire -ErrorAction SilentlyContinue   # must be empty, or you adopt someone else's
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
Start-Process npm.cmd -ArgumentList "run","tauri","dev" -WindowStyle Hidden `
    -RedirectStandardOutput ".claude\skills\running-the-app\tauri-dev.stdout.local" `
    -RedirectStandardError ".claude\skills\running-the-app\tauri-dev.stderr.local"
$deadline = (Get-Date).AddMinutes(8)
do { Start-Sleep 5; $app = Get-Process mtg-grimoire -ErrorAction SilentlyContinue } until ($app -or (Get-Date) -gt $deadline)
if (-not $app) { Get-Content ".claude\skills\running-the-app\tauri-dev.stderr.local"; pwsh -NoProfile -File $L release app; throw "tauri dev never came up in 8 minutes" }
pwsh -NoProfile -File $L adopt app -ProcessId $app.Id
```

No console window pops; `npm.cmd`'s own stdout/stderr — including a `tauri dev` compile
error — land in `tauri-dev.stdout.local` / `tauri-dev.stderr.local` beside this file
(`Start-Process` cannot redirect both streams to one file). Both match the repo's `*.local`
gitignore rule, so they never dirty `git status`.

`tauri dev` runs the exe as a **grandchild** (`npm.cmd` → cargo → `mtg-grimoire.exe`), so
`Start-Process -PassThru` hands you `npm.cmd`'s pid. Adopt that and `release` stops the
wrapper only: cargo and the app keep running while the lock file is deleted, the next
agent acquires cleanly, launches, and gets **exit code 0 with no window** — the exact
failure this lock exists to prevent. **Adopt the `mtg-grimoire` process instead**, which
is the loop above and the same shape as Storybook's. It can legitimately run for minutes
on a cold cargo build, which is why the grace window is ten — the loop's own 8-minute
deadline sits inside that window, so a compile that is merely slow still finishes before
the lock could go stale out from under it. If the deadline wins instead, a failed compile
leaves no `mtg-grimoire` process for the loop to ever find, so it reads
`tauri-dev.stderr.local` and releases the lock itself rather than spin silently for the
rest of the grace window.

`Get-Process` with `-ErrorAction SilentlyContinue` returns `$null` when nothing matches
(so `$app -or (Get-Date) -gt $deadline` is what ends the loop, on success or on timeout)
and a single `Process` when one does — single-instance guarantees there is never a
second, **which is exactly why the emptiness check above the loop is not optional**: a
`mtg-grimoire` already running from another checkout is the one thing that makes
`$app.Id` the wrong pid.

After `release`, check `Get-Process mtg-grimoire` is empty and close the `tauri dev`
window if it survived its child.

## Driving it

`scripts/cdp.mjs`. `docs/reference/live-ui-verification.md` is the command vocabulary
and the trap list; this skill does not repeat it.

**Run cdp.mjs through the PowerShell tool.** Bash refuses
`node scripts/cdp.mjs eval "<expr>"` as unverifiable. Wrap the JS in double quotes with
single quotes inside — a nested `\"` in a CSS selector reaches the page unescaped — and
avoid `$`, which PowerShell interpolates before node sees it.

`CDP_PORT` overrides 9222 if you ever need it to (`scripts/cdp.mjs:31`) — it points
`cdp.mjs` at a different debugger on an app that is already running. **It does not make a
second app possible**: the single-instance guard keys on the `com.mtggrimoire.app`
identifier, not on a port, so the second one still exits 0 with no window. One app, one
lock, whatever port you drive it on.

## Storybook

```powershell
pwsh -NoProfile -File $L acquire storybook -What "component work"
Start-Process npm.cmd -ArgumentList "run","storybook" -WindowStyle Hidden `
    -RedirectStandardOutput ".claude\skills\running-the-app\storybook.stdout.local" `
    -RedirectStandardError ".claude\skills\running-the-app\storybook.stderr.local"
$deadline = (Get-Date).AddMinutes(3)
do { Start-Sleep 2; $c = Get-NetTCPConnection -LocalPort 6006 -State Listen -ErrorAction SilentlyContinue } until ($c -or (Get-Date) -gt $deadline)
if (-not $c) { Get-Content ".claude\skills\running-the-app\storybook.stderr.local"; pwsh -NoProfile -File $L release storybook; throw "storybook never bound 6006 in 3 minutes" }
pwsh -NoProfile -File $L adopt storybook -ProcessId $c.OwningProcess
# ... use the mtg-grimoire-sb-mcp tools ...
pwsh -NoProfile -File $L release storybook
```

No console window pops; Storybook's own stdout/stderr — including a boot failure — land in
`storybook.stdout.local` / `storybook.stderr.local` beside this file, same reasoning as the
dev-mode recipe above. The loop gives up after 3 minutes — comfortably past the ~70s this
machine measured to bind the port — and on expiry reads `storybook.stderr.local` and
releases the lock the same way.

`npm` resolves to a `.ps1` wrapper on this machine that `Start-Process` cannot launch —
use `npm.cmd`. It also spawns Storybook as a **child** process, so adopt the pid actually
listening on 6006 (the loop above), never `Start-Process`'s own pid, or `release` stops
the wrapper and leaves node holding the port.

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
