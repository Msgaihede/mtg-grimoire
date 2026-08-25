# The plain-text mirror

`src-tauri/src/mirror/` and `src-tauri/src/transfer/`, shipped 2026-08-25. The design is
[2026-08-25-text-backed-cards-design.md](../superpowers/specs/2026-08-25-text-backed-cards-design.md);
this page is the record of what shipped, with the reason at each site. Every figure keeps the date
and the build it was taken on.

The short version: **everything the reader owns, wants or has built is continuously written to
plain text files on disk, in every format this app can write, so that the day the app will not
start their cards are still theirs.** The database stays the source of truth and **nothing ever
reads the mirror back** — it is a write-only projection. Three rules fall out of that sentence and
most of this page is one of them:

1. **It cannot cost anything the reader can feel.** Its own thread, its own read-only connection,
   debounced, and it writes only bytes that actually differ.
2. **It has to be complete without being asked.** On by default, every optional field on, every
   folder, every deck — archived decks and theory lists included.
3. **It must survive the app being killed.** A full pass runs at startup, so a mirror is correct
   after a crash rather than after the next edit.

The price is **a second implementation of the export writer, in Rust, beside the TypeScript one**.
That is a deliberate exception to this repo's boundary rule and [the golden
fence](#the-golden-fence-necessary-and-not-sufficient) is what makes it legal.

## What lands on disk

Default root `data/export/`, movable from Settings → Backup. Under `npm run tauri dev` that is
`src-tauri/target/debug/data/export/`.

```
<root>/
  README.txt                                  what the folder is, and both omissions below
  .mirror-manifest                            what the last pass wrote — see the pruner
  Decks/
    <deck folder>/<deck folder>/              deck_folders, nested as directories
      Azula/
        Azula.txt  Azula.mtgo.txt  Azula.arena.txt  Azula.moxfield.txt
        Azula.archidekt.txt  Azula.tcgplayer.txt  Azula.csv
        Theory/
          Azula.txt … Azula.csv               the theory variant, named after the deck
    Archived/                                 decks.archived = 1, with their folder tree inside
  Collection/
    Collection.txt … Collection.csv           every row
    <folder>/<Folder>.txt … <Folder>.csv      just what is filed *directly* there
  Wishlist/
    Wishlist.txt … Wishlist.csv
    <folder>/<Folder>.txt … <Folder>.csv
```

**A deck is a directory, not a file stem, because seven files belong together.** **A file is named
after the thing rather than after its role** — `Azula.archidekt.txt`, never `archidekt.txt` — so a
file dragged out of its folder still says what it is. `paths::file_name` is the **only** spelling of
that rule, and `paths::is_ours` is derived from it by sweeping `Format::ALL` rather than from a
second list of five format keys, so what the pruner claims cannot drift from what the writer wrote.

**A folder's file holds what is filed in that folder, not what is filed beneath it.** A nested
folder has its own file one directory down, and the root's `Collection.csv` is the only place every
row appears together. Rolling children up would make a card appear once per ancestor, and a reader
counting rows in two files could not tell that from owning it twice.

**The collection's automatic folders are mirrored like any other folder.** Since schema v25 the
cabinet holds a group per deck and a global `Recently removed`, and that tree *is* the physical
ledger of where every card sits ([collection-folders.md](collection-folders.md)). Leaving them out
would mirror the reader's filing while hiding the half of it the app did.

**An empty list writes a zero-byte file in all seven formats, CSV header included.** That was the
one open question the plan left to the live pass, and it was settled by looking rather than by
arguing: `formatExport` answers `""` for an empty list in every format, the goldens for the `empty`
scenario are all 0 bytes, so writing anything else would have been the *mirror* disagreeing with the
export dialog. Confirmed on disk 2026-08-25 — an empty deck, an empty wishlist and two empty
collection groups all wrote seven 0-byte files.

### Names, collisions and the two omissions

**Sanitising** (`mirror/paths.rs`): `< > : " / \ | ? *` and control characters become `-`; trailing
dots and spaces are trimmed, because Windows drops them *silently* and a folder created with one is
not the folder you later look for; an empty name becomes `Untitled`; a reserved device name
(`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`) gets a `_` **on the stem**, so `CON.txt`
becomes `CON_.txt` — Windows resolves the device by stem regardless of extension, and an underscore
after the extension would leave a name still un-creatable. `CON .txt` takes the same arm: Win32
ignores a stem's trailing spaces when it resolves a device, and the whole-name trim cannot see that
space. Nothing else is touched — NTFS takes Unicode, and a deck called `Æther Vial` should be a
folder called `Æther Vial`.

**Collisions get a ` (n)` suffix, assigned by database id**, over the *sanitised* names, because
sanitising can create a collision that did not exist in the database (`A/B` and `A-B` are two decks
and one folder name). Ordering by id is what makes the assignment stable: adding a third `Aggro`
never renames the first two, so a reader's shortcut into that folder keeps working. Matching is
case-insensitive because NTFS is, and the loop rather than a counter is for the reader who has
*called* a deck `Aggro (2)`. **Everything that lands in one directory is disambiguated together** —
the reader's folders, their decks, and the names the app claims: `Archived` is reserved in both deck
roots against folders *and* decks, and in `Collection/` and `Wishlist/` a folder is reserved against
the list's own seven **files**, at every level, because a folder called `Collection.csv` is a real
thing a reader can make.

**Two omissions remain, and `README.txt` names both**, because neither is a field the mirror could
have switched on:

- **MTGO and Arena have no maybeboard.** Both write only the piles the reader has switched on, so a
  switched-off pile is absent from those two files and present in the other five. That is the
  format, not a setting.
- **Arena's row filter stays off.** `*.arena.txt` lists every card, which makes it a complete record
  and *not* a file Arena would accept for a paper collection. The mirror is a backup first; a reader
  who wants an importable Arena list has the export dialog, where that filter is a checkbox.

Prices are quoted at whatever marketplace the reader has selected, read fresh on every pass, so a
mirrored CSV's `Price` column agrees with what the app shows them.

## How a change becomes a file

```
a user write commits
        │
        ▼
  update_hook on the one write connection      rusqlite's "hooks" feature — no new crates
        │  table name ──► surface bits
        ▼
  Mask: AtomicU8 of bits + AtomicU64 of marks
        │
        ▼
  mirror thread wakes 2 s after the last mark
        ├─ renders the dirty surfaces in memory
        ├─ hashes each file against what it last wrote
        ├─ writes only what differs
        └─ prunes what the last manifest shows it no longer intends
```

**One hook rather than forty call sites.** `sync::with_write` is the single funnel every user-facing
write in this crate passes through, on the one `Mutex<Connection>` the app writes through, so an
`update_hook` there sees every insert, update and delete with the table's name. No command has to
remember to tell the mirror anything, and no command added next year can forget to. The hook fires
inside SQLite's own callback, on the writer's thread, with the write connection's mutex held: it
does one `fetch_or` and returns. `rusqlite` 0.40.1 gates it behind a `hooks` feature whose manifest
entry is `hooks = []` — **an empty feature list, so no package is added**. The `Cargo.lock` diff is
empty, and that is the right evidence rather than a missing one: a lockfile records resolved
versions and dependency edges, not feature selections.

**A bare `DELETE FROM <table>` may not reach the hook.** SQLite's truncate optimisation empties a
table without visiting rows and is documented as not firing the update hook. It is disabled by
triggers and by foreign-key processing, which is why the Danger Zone's three clears still mark —
each empties a table other rows point at with `ON DELETE CASCADE`. Tests in `watch.rs` are what keep
that true rather than a claim about SQLite's release notes.

### The dirty map, and the row that is load-bearing

`watch::surface_of`:

| Tables | Dirties |
| --- | --- |
| `deck_cards`, `deck_categories`, `deck_tags`, `deck_folders` | Decks |
| `decks` | Decks **and** Collection |
| `collection_entries`, `collection_folders` | Collection |
| `wishlist_entries`, `wishlist_folders` | Wishlist |
| **everything else** — `cards`, `sets`, `marketplace_prices`, `image_cache`, `deck_audit`, `deck_undo`, `error_log`, the tag tables, `app_meta`, `sync_meta`, every staging twin | **nothing** |

**The last row is the one that matters, and it is the default arm rather than a list.** A sync
rewrites the whole `cards` table — ~116,700 printings on the 2026-08-25 corpus — and a price-feed
refresh rewrites `marketplace_prices` wholesale; a Card Kingdom refresh driven live the same day
wrote 149,321 rows. Mapping either to a surface would fire the hook that many times per refresh and
turn every sync into a mirror rebuild triggered a hundred thousand times over. **What those two
change instead enters through one full pass after the refresh *completes*** — `sync::run_sync` and
`marketplace_feed::refresh` each call `Mask::mark_all` — which is a bounded event rather than a
per-row storm.

**Writing it as a match on a fixed list, with `_ => None` as the default, is also how a table added
by a future migration stays safe.** A prefix test would have got `deck_audit` wrong. What keeps
`None` from being a silent decision is `every_table_in_the_schema_has_been_decided_about`, which
asserts the whole of `sqlite_master` against a written-down list: **a migration that adds a table
goes red there until somebody says which side of the match it belongs on.** That test is the reason
the rule in [`src-tauri/CLAUDE.md`](../../src-tauri/CLAUDE.md) has teeth.

`decks` dirtying the collection as well is an over-approximation of one table, kept because the cost
of being wrong in the other direction is a group folder whose name never catches up with its deck.
Hash comparison means the over-approximation writes nothing.

**`app_meta` maps to nothing on purpose, and two settings therefore mark by hand.**
`mirror::settings::set_root_now` and `marketplace::set_marketplace_now` each call `mark_all()` on
success, because both are `app_meta` rows the update hook must stay quiet about and both change what
every file would say. The marketplace one is there because a live pass found every mirrored CSV
still carrying the previous marketplace's prices; pressing `Rebuild now` moved one row from 8.25 to
5.99, which is what proved it (**debug build, 2026-08-25**, the corpus in the cost table below). Marked **only on success** — a refused path or a rejected id changed
nothing and must not cost a full render.

### The debounce is two atomics, and the second one is why it works

`Mask` is an `AtomicU8` of three bits and an `AtomicU64` counting marks. Bits alone cannot tell
"still being edited" from "dirty and quiet", because marking a surface already in the mask changes
no bit — a reader dragging thirty cards into one deck would have the pass fire in the middle of it.
The counter is bumped by **every** mark, changed or not, and the thread restarts its `DEBOUNCE`
whenever the number moves. `TICK` is 250 ms and `DEBOUNCE` is 2,000 ms; the live pass measured the
first changed file at **+2,793 ms** after a card was added (**debug build, 2026-08-25**; the same
figure is in the stamped cost table below), which is those two constants working.

`take()` is a single `swap(0)` — read and clear in one atomic — because a write landing between a
separate peek and clear would be seen by neither the pass that is starting nor the one after it, and
the file would stay stale until an unrelated edit. The startup pass deliberately takes the mask
*before* it runs: anything written between `install_hook` and the thread starting is already covered
by a full render, and a write that lands *during* the pass must stay marked because it may not be in
the rows that pass read.

### Everything that runs a full pass

Startup; a completed sync (gated on `outcome.updated`, so a launch that found nothing new spends no
render); a completed price-feed refresh; `Rebuild now`; the mirror being switched off and back on;
the root being changed; the marketplace being changed; a **failed** pass (`mark_all`, not a re-mark
of the surfaces it was carrying, because the mask cannot describe what was missed while the root was
gone); and **a pass that finds no `.mirror-manifest` under a root that exists** — see below.
Everything else is the dirty mask.

## The pass

`mirror::run::run_pass(conn, root, dirty, cache)`. `create_dir_all` first, before the four reads:
if the stick is unplugged there is no point asking the database for 350 files' worth of rows to find
out. That is the **only** `Err` the pass has; everything past it counts into `PassReport::failed` and
carries on, because an unwritable file is not a reason to abandon the other 349.

**It composes existing read functions rather than growing SQL of its own.** `deck::get_deck`,
`collection::list_entries`, `wishlist::list_wishes` and the three folder listers — the same
functions the app's own screens read through. A statement written in `mirror/read.rs` would be a
second answer to "what is in this deck" that nothing keeps in step with the first, and the mirror is
the copy a reader falls back on when the app will not open. The two list reads page at
**`read::PAGE = 500`** and stop on a short page. 500 rather than anything larger because
`collection::MAX_LIMIT` and `wishlist::MAX_LIMIT` are both 500 and both private: a page asked for at
2,000 comes back holding 500, which the short-page rule reads as end-of-list, and **a 2,007-row
collection would have mirrored as its first 500 rows with nothing raised anywhere.** That was found
by measuring during the build, not by reading. If either clamp is ever lowered, `PAGE` follows it
down; `a_collection_larger_than_one_page_is_read_whole` says so.

**The layout is a pure function of the database's shape.** `layout::plan_files(&Shape)` takes rows
and answers a `Plan { files, dirs }` — no `Connection`, no filesystem, no clock — which is what lets
the whole tree be decided and tested without a database. A `PlannedFile` names its `Source` and the
pass resolves that into cards, so a pass that only has to prune never needs the cards at all. One
read per *source* rather than per file: the plan emits a list's seven formats together, so a memo of
one turns seven reads of a deck into one.

### The digest cache, and why the root is half its key

The thread keeps the digest of every file it has written. **A cache miss reads the file** — the
digests start from what is on disk, never from an empty map. A session that trusted an empty map
would rewrite the entire mirror at every launch, roughly 10 MB into whatever folder the reader
chose, for data that had not changed since they closed the app. Measured live 2026-08-25: a relaunch
with nothing changed reported `{written: 0, unchanged: 100}` — it opened nothing for writing.

**A remembered digest never vouches for a file on its own.** `put` confirms a cache hit with a
`stat` before trusting it (`cache.get(rel) == Some(&want) && abs.is_file()`), because every way the
map and the disk come apart looks identical from inside: the reader deletes the mirror folder while
the app runs and `create_dir_all` quietly puts an empty one back; a stick comes back empty; a root
moves. Each of those was a separate special case up the stack, and the general rule let both of the
earlier two be deleted. It is deliberately **presence** and not contents — re-reading every file
would throw away the point of the cache, and a reader who hand-edits a mirrored file is answered by
`Rebuild now`, which runs with a fresh map for exactly that reason.

**The root is a field of the cache, not a note to the caller, and that is the difference between an
invariant and a habit.** The map is keyed by a *plan-relative* path — `Decks/Burn/Burn.txt` — which
is the same key under every root, so a digest taken at one folder will answer confidently about a
completely different folder's copy, and `is_file` cannot save it: presence is not content. `run_pass`
calls `cache.aim_at(root)` before it writes anything, so a hit can only ever describe the file the
pass is actually about. **This one was found live and it cost 21 orphaned files** — see [the
regression from a ruling](#the-regression-a-ruling-caused).

### The manifest, and why inference was replaced with a record

`.mirror-manifest` at the root: one root-relative path per line, `/` separators, LF, sorted, listing
every file of the current plan plus `README.txt`. It does not list itself, which is what makes it
unprunable by construction. **Prune = the previous manifest MINUS the current plan.** Files first,
then the directories that leaves empty deepest-first, then **the new manifest last** — so a pass
killed half way leaves a manifest describing a *superset* of the disk, which the next pass reconciles
by trying to delete a few files that are already gone. Written first, the same crash would leave
files nothing had any record of, orphaned for good.

**The next person will be tempted to simplify this back to stem-matching. It was tried three times
and each attempt left a hole.**

| Attempt | The hole it left |
| --- | --- |
| **R10** — claim any `.txt`/`.csv` in the tree | A reader's own `budget.csv`, dropped into a user-chosen root that may be their Dropbox, is deleted on the next pass. Narrowed to "a file named after its containing directory". |
| **R11** — every owned directory takes its own name as its stem | `Decks/Azula/Theory/Azula.txt` has stem `Azula` in directory `Theory`, so a **switched-off theory list leaves seven permanent orphans**. Fixed by having the layout publish a `Theory` directory carrying the *deck's* name as its stem whether or not the switch is on. |
| **R13** — so give every owned directory a stem | Then `Standard.csv` dropped by a reader into their deck *folder* `Decks/Standard/` is claimable — the same loss R10 was narrowed to prevent. Containers got `stem: None`. |

**R14 is what replaced all of it.** The remaining hole was that the contract for a directory *absent*
from `Plan.dirs` was undefined and both readings fail: falling back to the directory's own name makes
a reader's file claimable once a deck folder is deleted, and not falling back leaves seven files
behind on every rename. R11's Theory stem has the same shape — it publishes the *current* deck name,
so after a rename those files are unclaimable by any stem rule at all. A record of what was actually
written answers rename, delete and switched-off-theory as **one case**, survives a restart, and
cannot touch a reader's file because a reader's file was never in a manifest we wrote.

**`is_ours` and `Plan.dirs` survive anyway, as the recovery path when there is no manifest.**
`run::recover` is the only place `is_ours` is still asked anything. It looks **only inside
directories the current plan owns and gives a stem to**: a container — `Decks`, `Decks/Archived`,
every deck folder, the mirror root — carries `stem: None`, claims nothing, and so a reader's file
sitting directly in one is untouchable there too. No stem is ever invented for a directory the plan
does not name. What that reaches in practice is the one case a first manifest cannot cover: a deck
whose theory switch is off still owns its `Theory` directory with the deck's own stem, so seven files
from before the switch are claimable. **A missing or unreadable manifest prunes nothing else and
writes a fresh one** — one pass of orphans is the correct price for never guessing.

**R14b — the manifest is input, so it is fenced.** It is a file on the reader's disk that *drives
deletion*, so a corrupted or hand-edited line reading `../../Documents/taxes.csv` would be a delete
outside the root. `safe_entry` ignores any line with a leading `/`, a `\`, a `:`, or a `.`/`..`
segment. This threat model is one the manifest itself introduced, and it only ever refuses.

**`sweep_empty` uses `remove_dir`, never `remove_dir_all`**: if anything is left in a directory the
pass emptied, it is not ours. And only directories that held something taken away are even looked at.

**R15 — the manifest is also the authority on what may be *overwritten*, and that fence was
missing until 2026-08-25.** Five rulings hardened the path that deletes; nothing had looked at what
the first pass writes **into** a folder the reader chose. `settings::set_root` accepts any absolute
path whose parent exists — a drive root included — and `README.txt` is the one fixed name the mirror
puts at the top of it, so pointing **Change folder…** at a populated folder overwrote whatever
`README.txt` was already there, silently. That is the same harm the prune fence exists to prevent,
arriving by the other door.

`run::put_readme` is the fence, and the manifest decides: a `README.txt` no previous manifest names
is the reader's, is left where it is, and is counted in `PassReport::skipped` — a fifth number,
because `unchanged` means "the bytes on disk are already ours" and `failed` means "we tried and could
not", and neither is true of a file we declined to touch. The panel says **"1 left alone (yours)"**
rather than a bare count for the same reason.

Two arms make it work rather than merely refuse:

- **A `README.txt` byte-identical to ours is adopted**, not skipped. Without that, a reader who
  deletes `.mirror-manifest` — which the README tells them is safe — would freeze the README *we*
  wrote at whatever that build said, for good, because no later manifest would ever name it again.
- **A skipped README is left out of the manifest this pass writes.** Listing it would make the
  *next* pass read it back as ours, so the reader's file would survive one pass and be overwritten
  by the one two seconds later — the guard undone by the file that authorises it. It stays in
  `prune`'s `wanted` set unconditionally, so it can never be deleted either.

`mirror_set_root` was **deliberately not** made to refuse a populated folder. The only file it could
refuse over is exactly the one now protected, refusing turns a folder the mirror can use perfectly
well into one the reader cannot choose at all, and it could not cover the default root or a README
dropped in later — a second, weaker fence in front of the real one. The panel's sentence says the
rule instead: "a file the backup did not write is never overwritten either."

**`recover`'s membership test ignores ASCII case, because `is_ours` does.** Each half was right
alone and the pair was not: `is_ours` compares with `eq_ignore_ascii_case` deliberately, because
Windows does and a file this app created as `Azula.txt` can be enumerated as `AZULA.TXT` after a
reader or a sync client re-cases it — while `wanted` was a set of the plan's exact spellings. The
re-cased file was claimed by the first test, missed by the second, and **dropped in the same pass
that had just written it**, because `put` runs before `prune`. Fixed 2026-08-25 by lowercasing both
sides of that one lookup.

### What a reader loses if they delete `.mirror-manifest`

**Stale files in directories the current plan no longer names are orphaned permanently, not for one
pass** (R14a). The fresh manifest describes only the *current* plan, so no later pass has any record
that those files were ever the mirror's. The stem-based recovery above covers files in directories
the plan still names; a **deleted deck's whole directory is not one**, so those files persist until
the reader removes them. The remedy is deleting the whole folder, which is safe and rebuilds —
`README.txt` says both, in those words. This was accepted rather than fixed because every alternative
reintroduces guessing, which is the thing the manifest exists to remove.

## Settings, and what failure looks like

A `BackupPanel` beside Cache, Marketplace, Hidden tags, Update and Danger Zone. On by default; the
root with a **Change folder…** button; when the last pass ran and how it went; **Rebuild now**.

**No new permission.** The picker is `tauri-plugin-dialog`'s open verb with `directory: true`, and
`capabilities/default.json` has granted `dialog:allow-open` since the cover picker shipped. (It has
granted `dialog:allow-save` since the export dialog shipped, which `Cargo.toml`'s comment beside the
plugin went on denying for a whole plan before this one corrected it.)

**Two settings, two `app_meta` keys, no migration** — `mirror_enabled` and `mirror_root`, exactly the
shape `marketplace` settled on. Reading can never fail: a missing row, a hand-edited row, or a row a
newer build wrote all read as the default, because the pass thread consults them on every tick and
there is nothing sensible for a tick to do with an error. **Writing validates**, and the absolute-path
refusal is the one worth spelling out: a relative root resolves against the process's working
directory, and for a portable app that is wherever the shortcut pointed — a different folder on
Tuesday than on Monday, with a mirror scattered across both and neither one prunable.

**Moving the root writes a fresh mirror at the new location and leaves the old one alone.** Deleting
somebody's folder because they changed a setting is not this feature's decision to make.

**An unreachable root fails quietly and blocks nothing.** One `error_log` row per failure *kind*, not
one per file and not one per retry — the `ON CONFLICT(source, operation, kind, message)` upsert folds
them and climbs a `count`. Verified live: with the root replaced by a file, the app stayed fully
responsive and navigable, the panel said why underneath `Rebuild now` while keeping the previous good
report above it, and the log held exactly one `mirror_pass` row.

**The retry backs off 2 s, 4 s, 8 s … to a 60-second ceiling.** Without it an unreachable root is
retried every tick the mask stays dirty — roughly 1,600 times an hour, each one a `create_dir_all` at
a path that is not there. It stops at a minute rather than climbing further because the reader who
plugs the stick back in is often watching the panel while they do it, and `Rebuild now` is the
immediate way out. **A root that comes back gets a full rebuild rather than a partial one**: measured
live (**debug build, 2026-08-25**, the same 100-file corpus as the cost table), the folder held
100 files again within 5 s.

**A panic in the pass is caught rather than allowed to end the thread.** Uncaught it was survivable in
the sense that nothing else broke and invisible in every sense that matters — no `error_log` row, no
sentence in the panel, and a Backup panel reporting the last good pass forever while the folder
quietly stopped being updated.

**The `error_log` insert is the one place the mirror touches the write connection**, through
`db::lock_for(&state.db, Duration::ZERO)` — a single `try_lock`, the `images::flush_records`
precedent. An `INSERT` cannot go through a read-only connection, so the spec's letter ("`db_read`
only") was unimplementable for the one thing that records a failure; its intent (a mirror pass must
never make a button answer `db::BUSY`) is preserved exactly. A row dropped under contention costs the
log one entry, and the sentence still reaches the reader through `mirror_status`, which is the panel's
actual source.

**Both passes run on a read-only connection of their own** — the thread's and `Rebuild now`'s — never
`AppState.db_read`, following `index::lifecycle::build_now`'s precedent. A pass reads four listings
and writes up to ~350 files; held on the shared read connection it would queue every search and every
`mirror_status` poll behind it, breaking the one promise about this feature a reader would actually
feel. `rebuild_now`'s is the worse of the two, because the reader who pressed the button is sitting
in front of the window watching it; if the connection cannot be opened it falls back to the shared
one rather than refusing.

## What it costs — measured 2026-08-25, **debug** build

Driven in the real shipped window over CDP against a copy of the live database: **4 decks / 611 deck
cards / 275 collection entries / 5 collection folders / an empty wishlist, producing 100 mirrored
files and a 99-line manifest.** Wall clock measured in the page around `ipc.mirrorRebuild()`, which
is `Dirty::ALL` with a **fresh** digest cache — so each figure includes the IPC round trip and, on a
warm folder, a `stat` + read + hash of all 100 files.

| Pass | Measured | Report |
| --- | --- | --- |
| **Cold** — folder deleted, every file written | **~311 ms** (two runs, both 311) | `written 100` |
| **Warm** — folder complete, nothing to write | **263–287 ms**, six runs, median **279 ms** | `unchanged 100` |
| **Startup**, cold folder, process start → last file stamped | **≤ 3 s**, app boot and migration included | `written 100` |
| One deck edit → its seven files moved | **+2,793 ms** after the keystroke | `written 7, unchanged 86` |

**Two things to carry away from that table, and the second is the one that surprises.**

- **The warm case is within ~10% of the cold one, so a pass costs the render, not the writing.**
  Writing all 100 files costs about **30 ms more** than confirming they are already right. The digest
  cache buys **disk churn** — 350 files not handed to Windows Defender and any cloud-sync client
  every two seconds — and it does not buy wall clock. Anybody optimising this should be looking at
  `format_export` and the four reads, not at the file I/O.
- **These are debug figures and no release number may be inferred from them.** A debug build in this
  repo has run ~8× slow before. The plan's §9 estimates were a *JavaScript* ceiling taken through
  `node:sqlite` and are superseded by this table, not confirmed by it.

Two more real-world reports from the shipped thread rather than the button, same corpus and build:

- **Post-sync full pass:** the copied database was a day stale, so a sync ran at launch
  (116,700 → 116,749 cards). Ten seconds after it finished, one full pass wrote **exactly the 10
  `.csv` files** and left the other 90 untouched — the CSVs are the only format carrying a `Price`
  column, and the sync had moved prices. Change detection is not approximate.
- **Post-feed full pass:** a real Card Kingdom refresh (149,321 rows) triggered a 100-`put` pass ten
  seconds later.

Per-folder files roughly double the byte count — a card appears in its folder's file and in the root
list.

## The golden fence: necessary and not sufficient

Two writers, one behaviour, and a build that goes red the moment they disagree.

- **One corpus, shared.** `src/features/transfer/__golden__/corpus.json` — cards on all three
  surfaces, every field populated, plus the edge cases both suites already know are sharp: a `//`
  split name, a CSV cell holding a comma and a quote, a switched-off pile, a labelled card with and
  without a colour, a list a format empties for itself, and an empty list. Rust deserialises it into
  `transfer::Card` with `rename_all = "camelCase"` and `deny_unknown_fields`, which pins the two
  structs to one set of field names.
- **One golden set, committed.** Every scenario × seven formats × two field sets (everything
  available, and the format's own defaults). Both suites count what they compared and assert the
  total, so a deleted golden is a red build rather than a quietly smaller matrix.
- **TypeScript generates; both suites assert.** `npm run golden` rewrites the files from the TS
  writer, which is the behaviour of record because it is what shipped. Vitest asserts byte equality
  against them; `cargo test` asserts byte equality against the same files.
- **The round trip got stronger rather than weaker.** Vitest parses the golden files through
  `parse.ts` and asserts it recovers the cards. Since the cargo suite has already proved Rust
  reproduces those bytes exactly, the app's parser demonstrably reads what the mirror writes — a
  claim today's writer-then-parse test, closed inside one implementation, cannot make.
- **A second golden, one level up: `__golden__/fields.json`.** The rendered files fence the
  *writer*; for six of the seven formats they cannot fence the **registry**. `write_line` renders
  exactly seven ids, so every other id is invisible outside CSV — adding `FieldId::Lang` to
  `Format::Plain`'s `optional` on one side alone moves **zero golden bytes** while changing the
  fold key, and one printing held in two languages would export as two lines from the mirror and
  one from the dialog with all 70 files green. CSV was fenced all along because its header row
  **is** `available_fields` spelled out. `fields.json` holds `SURFACE_FIELDS` and what
  `availableFields`/`defaultFields` answer for all 21 (format, surface) pairs, written by
  `npm run golden` from the TypeScript side and asserted by `golden.test.ts` and
  `transfer/fields.rs`. **Measured by mutation on 2026-08-25**: that drift reddens exactly one test
  on each side and no golden file. `FieldId::key` and `Surface::key` exist for it, and are
  self-fencing — a wrong wire word is red in the same test.

**The port reproduced all of it on the first run of the finished writer** — no golden regenerated,
none unreproducible. And it held against the real corpus: driven live 2026-08-25 (debug build), all
**seven** of a real deck's mirrored files were byte-identical to what the export dialog produces
with every field ticked **and "Only cards MTG Arena has" left unticked**, `Azula.csv` included at
11,527 bytes against 11,471 characters — 56 bytes of multi-byte UTF-8 in the type lines. The fence
holds through the encoding, not only through the ASCII.

**That caveat is the design rather than a gap in the check, and it is one file of the seven.**
Spec §3.1 says the mirror leaves Arena's row filter off, so `*.arena.txt` in the backup lists every
card — a complete record and not a valid Arena import, which `README.txt` says out loud.
`export/arena.ts`'s filter has no Rust counterpart by design and `card.rs`'s `legalities` is
carried but read by nothing on this side. Ticking that box in the dialog produces a shorter file
than the mirror's, correctly.

### **A golden pins only what the fixture varies**, and this is the most transferable lesson in the plan

Three holes were found *in the fence itself*, and no golden file could have caught any of them:

1. **`SECTION_ORDER` was a sort that nothing held to being one.** Dropping the ordering argument
   entirely left every golden green, because every corpus scenario already happened to list
   its piles in section order. That is a gap in the **corpus**, not in any golden file. Closed by a
   targeted test handing in five piles reversed.
2. **Archidekt's discriminator is covered by no golden at all.** Both its field sets include
   `Category`, so only the active flag needs the discriminator, and the corpus has no two rows
   sharing a pile name across that flag. Closed by a targeted test driving it from both ends.
3. **`arena_filters_before_it_folds` could not fail on the order it names** — confirmed empirically
   by swapping filter and fold and watching it stay green. Arena's discriminator is `sectionOf`,
   which already encodes `categoryActive`, so a switched-off and a switched-on row can never fold
   whichever order runs first. Closed by two tests using the one shape the discriminator is blind
   to: a row with `category_active` but no `category_kind`.

4. **Six of the seven formats could absorb a `FORMAT_FIELDS` change with no golden byte moving**,
   which contradicted spec §6's stated guarantee — found by adding `FieldId::Lang` to
   `Format::Plain` in Rust alone and watching all 70 files stay green. That one is **not** answered
   by a targeted test: it is answered by committing the registry itself as a golden, which is the
   same fence shape applied one level up. See `fields.json` above.

**So: targeted unit tests beside the fence are what cover a rule whose inputs the corpus never
varies.** A byte-comparison suite is a strong fence against *drift* and a weak one against *a rule
nothing exercises*, and the two need different tests. The Rust writer ships its own beside
the file comparison for exactly that reason, and `write.rs`'s test module is where they are.

**One more thing about the fence that is easy to get backwards: `deny_unknown_fields` is
one-directional.** It catches a field TypeScript **adds**. Serde reads a missing `Option<T>` as
`None`, so a field TypeScript **deletes** loads silently — only the golden files catch a deletion on
the Rust side. On the TypeScript side it is caught by `golden.test.ts` deriving its field list from
`Object.keys(transferCard())` in `fixtures.ts`, which is an object literal against an explicit
`TransferCard` return type with no optional members, so adding *or* removing a field breaks it at
`tsc`.

## Bugs still open

Following [decks-live-findings.md](decks-live-findings.md)'s shape: what is written down here is what
the live pass on 2026-08-25 (debug build, the corpus above) could **not** settle. The three bugs it
*did* find were fixed in the same branch — a deleted mirror folder repaired only the surfaces the next
edit touched; a marketplace switch left every mirrored CSV quoting the old prices; and a root moved
away and back orphaned 21 files. All three now have tests.

1. **A genuinely unpluggable drive was never tested.** There is no removable drive or vanishing
   network share on this machine. The failure was produced honestly but differently — a **file** put
   where the folder should be, which reaches the same `create_dir_all` error. It does not reach, for
   instance, a half-written file on a volume that disappears mid-write.
2. **The native folder picker has never been clicked.** `Change folder…` opens the OS dialog, which
   no CDP harness can drive; every root change in the live pass went through `ipc.mirrorSetRoot`,
   which is the same command the button calls with the picker's answer. `Rebuild now` was likewise
   pressed through IPC, so the button's own disabled and pending states are unexercised outside the
   suite.
3. **`mirror_set_enabled`'s off→on full pass was never driven live.** The arm exists and is unit
   tested; nothing has watched a reader switch the mirror off, edit, switch it back on and get their
   edits.
4. **Paths past `MAX_PATH` are untested.** `write_file` deliberately caps nothing — truncating or
   hashing a name would put a file on disk whose name no longer said which deck it came from, which
   is worse than not writing it — so an over-long path is an ordinary per-file failure that shows as
   a non-zero `failed` in the panel. Nobody has produced one: it needs a deck name and a root long
   enough to cross 260 characters together, and the corpus has neither. Worth knowing if you build
   that test: a long *deck* name costs **fourteen** files, not seven, because schema v25 gives that
   deck a collection group with a matching name.
5. **The `error_log` retry cadence is only half characterised.** The row's `count` climbed 5 → 10
   over the first 35 s and then stopped moving for the next 25 s. That is either the backoff working
   or `note_failure`'s `Duration::ZERO` `try_lock` dropping rows under contention, and **the two were
   not separated**. What matters for the design — one row, never one per file — is settled; the
   cadence is not.
6. **`run_sync`'s `note_mirror_after_sync` call site is unreachable from any automated test.**
   `run_sync` takes a `tauri::AppHandle` and this crate has no mock-app harness, so nothing in the
   suite can enter it. The *condition* is extracted and tested; the single line above it is not.
   **The live pass verified it works** — the launch sync's completion produced a full pass that
   rewrote exactly the ten price-bearing CSVs — so this is a coverage gap rather than an unknown, and
   the same shape applies to `marketplace_feed::refresh`'s twin (also verified live, 149,321 rows).

### The regression a ruling caused

Worth keeping, because the lesson generalises past this feature. A class fix — "`put` confirms a
cache hit with a `stat`, so the two special cases clearing the digest cache can be deleted" — was
right about two of the three states it covered and wrong about the third. The `cached_root`
invalidation it deleted was doing a **second job nobody had written down**: the cache is keyed by
relative path, so after a root switch every remembered digest is a claim about the *other* folder,
and `is_file()` proves presence rather than that *this* root's copy holds that content. The result
was a returning folder whose manifest was never rewritten and 21 files orphaned for good, found only
by driving it.

**Deleting a guard needs the question "what else was this holding up?", not just "is it now
implied?"** The fix was not to put the special case back but to make the hazard impossible: the root
is now a field of `DigestCache` and `aim_at` is called before anything is written, so a hit can only
ever describe the file the pass is about — true by construction rather than by remembering.
