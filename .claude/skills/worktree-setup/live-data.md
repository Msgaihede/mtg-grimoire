# A database without a 93-second sync

Read this when a worktree needs to run the app against real data — a live CDP pass, a
screenshot, anything where an empty wall would be the wrong picture. A worktree that only
runs `pnpm verify` never needs it.

**Copy the folder, not the file.** `mtg.db` alone gets you a card corpus and an app that
fetches every picture cold; `data/` also carries `images/`, the picture cache, which is
what makes a deck or a search wall look like the reader's rather than like a grid of
placeholders. Measured 2026-08-14 on this machine: `mtg.db` **580.8 MB**, `images/`
**307.1 MB** across **5 434** files, **889.8 MB** total, and seconds to copy against ~93 s
and a 77 MB download for a sync that still leaves the pictures cold.

**Stop the app first, in this worktree and every other** (`running-the-app`'s lock, then
`Get-Process mtg-grimoire`) — SQLite holds `mtg.db` open and Windows refuses to overwrite
it, and the copy is the wrong shape anyway if it is taken mid-write.

```powershell
$src = "D:\Code\mtg-grimoire\target\debug\data"
$here = (Get-Location).Path
if ($here -notmatch '\\\.claude\\worktrees\\[^\\]+\\?$') { throw "Run this from a worktree's root under .claude\worktrees\, not $here" }
$dst = Join-Path $here "target\debug\data"
if ([IO.Path]::GetFullPath($dst).TrimEnd('\') -eq [IO.Path]::GetFullPath($src).TrimEnd('\')) { throw "`$dst is `$src - refusing to delete the main checkout's data" }
Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue   # never merge onto an old one
Copy-Item $src $dst -Recurse
```

**The two `throw`s are the recipe, not decoration.** `$dst` is relative to wherever the shell
stands and `Remove-Item` runs before the copy, so the same lines run from the main checkout
resolve `$dst` to `$src` and delete the real decks and collection, then fail to copy. Run it
from the worktree's root (`D:\Code\mtg-grimoire\.claude\worktrees\<name>`), never a
subfolder, and never drop the guards to make it go.

**`$src` is the main checkout's data folder**, which has been `target\debug\data` since it took
the 2026-10-08 layout (seen there 2026-10-11; `src-tauri\target` is gone). `$dst` is beside this
worktree's executable and outside its build cache, so deleting `target\cache` leaves it alone.
Only the folder is ever copied: a cargo build tree does not survive being moved (measured
2026-10-08 — Tauri's build scripts cache absolute paths to generated permission files, and a
moved tree failed with `failed to read plugin permissions`).

**`Remove-Item` first is not tidiness.** Copying `mtg.db` on top of a folder that already
has one leaves the _old_ `mtg.db-wal` and `mtg.db-shm` beside the new file — a journal
belonging to a different database — and SQLite either refuses to open it or replays the
wrong pages over it.

**What you get is the main checkout's state, not a blank corpus.** That is the point of
copying it and the thing to be careful about: today it carries real decks, folders and
collection rows, so a destructive probe is destroying a copy of the reader's own data.
Read freely; write to a deck you made yourself.

## Clean it up when you are done

889 MB per worktree, and this repo keeps dozens. It is gitignored, so nothing reminds you.

```powershell
pwsh -NoProfile -File .claude\skills\running-the-app\lock.ps1 release app
Get-Process mtg-grimoire -ErrorAction SilentlyContinue        # must be empty
$here = (Get-Location).Path
if ($here -notmatch '\\\.claude\\worktrees\\[^\\]+\\?$') { throw "Run this from a worktree's root under .claude\worktrees\, not $here" }
Remove-Item (Join-Path $here "target\debug\data") -Recurse -Force
```

The same guard, for the same reason: from the main checkout this line deletes the real data.

Delete it after the last live pass, not at the end of the branch: the next pass copies it
back in seconds. `target/cache` is the other thing to delete when the work is done (the skill's
_Finish_); `target` itself goes when the worktree does.
