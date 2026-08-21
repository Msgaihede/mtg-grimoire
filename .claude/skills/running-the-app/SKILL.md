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

**Ports are fixed — 1420 (Vite), 6006 (Storybook), 9222 (CDP) — and remapping them is not
a workaround.** `src-tauri/tauri.conf.json`'s `devCsp` and `.mcp.json` hardcode them, both
files are tracked, and the single-instance guard is not about a port anyway. Serialise
with the lock instead.

## The protocol

```powershell
$L = ".claude\skills\running-the-app\lock.ps1"

pwsh -NoProfile -File $L status
pwsh -NoProfile -File $L acquire app -Wait -What "CDP pass on the deck editor"
# ... launch, capture the process ...
pwsh -NoProfile -File $L adopt app -ProcessId $proc.Id
# ... do the work ...
pwsh -NoProfile -File $L release app
```

**`-Wait` blocks until the lock is free**, up to ten minutes, in one call — do not build a
polling loop out of tool calls. Ten, because a lock acquired but not yet adopted is held
live for exactly that long (`lock.ps1`'s `$UnadoptedGraceMinutes`), covering a cold
`tauri dev` cargo build. Without `-Wait`, `acquire` exits 1 and prints `HELD` at once.
**Never kill another agent's app**: a live CDP pass is measurements in flight.

A lock whose pid is dead, or alive as a different process (name **and** start time are
both checked, because Windows reuses pids and half this repo's processes are called
`node`), is **stale**; `acquire` takes it over and says so. So is a lock file the script
cannot parse.

**The escape hatch, and it is the last resort:** `release <name> -Force` deletes a lock
belonging to another worktree. Use it only when `status` calls the lock `STALE` and you
have confirmed with `Get-Process` that nothing is running — never to jump a `HELD` queue.

## Launching: `npm run tauri dev`

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

No console window pops; `npm.cmd`'s own stdout/stderr — including a compile error — land
in the two `*.local` files beside this file (`Start-Process` cannot redirect both streams
to one file), which the repo's gitignore already covers.

**Adopt the `mtg-grimoire` process, not the launcher.** `tauri dev` runs the exe as a
**grandchild** (`npm.cmd` → cargo → `mtg-grimoire.exe`), so `-PassThru` hands you
`npm.cmd`'s pid; adopt that and `release` stops the wrapper only — cargo and the app keep
running while the lock file is deleted, and the next agent launches into **exit code 0
with no window**, the exact failure this lock exists to prevent. The loop above is what
finds the right pid. Its 8-minute deadline sits inside the 10-minute grace window, so a
merely slow compile still finishes before the lock could go stale; if the deadline wins,
a failed compile leaves no process to find, so it reads the stderr file and releases the
lock itself.

The emptiness check above the loop is **not optional**: single-instance guarantees there
is never a second `mtg-grimoire`, so one already running from another checkout is the one
thing that makes `$app.Id` the wrong pid.

After `release`, check `Get-Process mtg-grimoire` is empty and close the `tauri dev`
window if it survived its child.

## The other three recipes — read the file, do not improvise

| You are about to | Read |
| --- | --- |
| Launch **Storybook** | `storybook.md`, beside this file |
| Measure a **release path** / built exe | `built-binary.md`, beside this file |
| Run against **real data** in a worktree | `.claude/skills/worktree-setup/live-data.md` |

Each carries traps that have cost a session. `tauri dev` above is the default; reach for
`built-binary.md` only when the release path itself is what you are measuring.

## Driving it

`scripts/cdp.mjs`, through the **PowerShell tool** — Bash refuses
`node scripts/cdp.mjs eval "<expr>"` as unverifiable. Wrap the JS in double quotes with
single quotes inside (a nested `\"` in a CSS selector reaches the page unescaped) and
avoid `$`, which PowerShell interpolates before node sees it.
`docs/reference/live-ui-verification.md` is the command vocabulary and the trap list;
this skill does not repeat it.

`CDP_PORT` overrides 9222 (`scripts/cdp.mjs:31`) — it points `cdp.mjs` at a different
debugger on an app that is already running. **It does not make a second app possible**:
the guard keys on the `com.mtggrimoire.app` identifier, not on a port. One app, one lock,
whatever port you drive it on.

## You are not done until you have released

Releasing is **stop the process, then delete the lock** — `release` does both in one
command. Do it on success, on failure, and when you abandon the task. A held lock over a
live process blocks every other agent, and nothing will clear it for you.

**Releasing is not a decision to hand back to the user.** Offering to release — "say the
word and I'll release it" — is not releasing, and it is the form this failure actually
takes: it reads as helpfulness while leaving every other agent blocked on an answer the
user did not know they owed. Release first. Then offer to bring it straight back up,
which costs seconds.

| Rationalisation | Reality |
| --- | --- |
| "I'll leave it up and offer to release it if they want" | Offering is not releasing. Release, then offer to relaunch. |
| "They might want a follow-up check" | Then relaunch for it. Booting again is cheaper than blocking every other agent. |
| "The next step needs it, I'll leave it up" | Release, then acquire again. It costs seconds. |
| "The task failed, so there is nothing to clean up" | The app is still running. Release. |
| "Another agent can just take it" | Only if the process is dead. Yours is not. |
| "The user will close the window" | They will not know it is theirs to close. |
| "I only ran Storybook, that is not the app" | It is the other lock. Release it. |

**Your final report must end with the output of `lock.ps1 status`.** Not a claim that you
released — the command's own output, both lines. It is a required part of the report, the
same way a test result is. Anything reading `HELD` and naming your worktree means you are
not finished, whatever else you were about to say.
