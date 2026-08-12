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
Start-Process npm.cmd -ArgumentList "run","storybook"
do { Start-Sleep 2; $c = Get-NetTCPConnection -LocalPort 6006 -State Listen -ErrorAction SilentlyContinue } until ($c)
pwsh -NoProfile -File $L adopt storybook -ProcessId $c.OwningProcess
# ... use the mtg-grimoire-sb-mcp tools ...
pwsh -NoProfile -File $L release storybook
```

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
