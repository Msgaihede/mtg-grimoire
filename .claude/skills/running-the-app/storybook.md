# Storybook

Read this when you are launching Storybook. The `storybook` lock and why it exists are in
`SKILL.md`; this file is only the recipe.

```powershell
$L = ".claude\skills\running-the-app\lock.ps1"
pwsh -NoProfile -File $L acquire storybook -Wait -What "component work"
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
`storybook.stdout.local` / `storybook.stderr.local` beside this file. Both match the repo's
`*.local` gitignore rule, so they never dirty `git status`. The loop gives up after 3 minutes
— comfortably past the ~70s this machine measured to bind the port — and on expiry reads
`storybook.stderr.local` and releases the lock rather than spin silently.

`npm` resolves to a `.ps1` wrapper on this machine that `Start-Process` cannot launch —
use `npm.cmd`. It also spawns Storybook as a **child** process, so adopt the pid actually
listening on 6006 (the loop above), never `Start-Process`'s own pid, or `release` stops
the wrapper and leaves node holding the port.

**You are not done until you have released.** See `SKILL.md` — the rule and its
rationalisation table cover this lock too, and "I only ran Storybook" is on the list.
