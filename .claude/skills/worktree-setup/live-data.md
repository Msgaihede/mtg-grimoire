# A database without a 93-second sync

Read this when a worktree needs to run the app against real data — a live CDP pass, a
screenshot, anything where an empty wall would be the wrong picture. A worktree that only
runs `npm run verify` never needs it.

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
$src = "D:\Code\mtg-grimoire\src-tauri\target\debug\data"
$dst = "src-tauri\target\debug\data"
Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue   # never merge onto an old one
Copy-Item $src $dst -Recurse
```

**`Remove-Item` first is not tidiness.** Copying `mtg.db` on top of a folder that already
has one leaves the *old* `mtg.db-wal` and `mtg.db-shm` beside the new file — a journal
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
Remove-Item "src-tauri\target\debug\data" -Recurse -Force
```

Delete it after the last live pass, not at the end of the branch: the next pass copies it
back in seconds. `src-tauri/target` itself goes when the worktree does.
