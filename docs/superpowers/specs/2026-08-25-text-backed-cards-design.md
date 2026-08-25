# Text-backed cards: a plain-text mirror of the collection, the decks and the wishlist

**Date:** 2026-08-25. **Branch:** `worktree-text-backed-cards`.

## 1. The model, in one line

**Everything the reader owns, wants or has built is continuously mirrored to plain text files on
disk, in every format this app can write, so that the day the app will not start their cards are
still theirs.**

The database stays the source of truth and nothing ever reads the mirror back. It is a
**write-only projection**, maintained by Rust, that a reader can open in Notepad, paste into
Archidekt, or import into whatever they use next. Three consequences fall straight out of that
sentence and most of this spec is one of them:

1. **It cannot be allowed to cost anything the reader can feel.** It runs on its own thread,
   against the read-only connection, debounced, and writes only bytes that actually changed.
2. **It has to be complete without being asked.** On by default, every optional field on, every
   folder, every deck — including archived decks and theory lists.
3. **It must survive the app being killed.** A full pass runs at startup, so a mirror is correct
   after a crash rather than after the next edit.

### What this costs, stated up front

**A second implementation of the export writer, in Rust, beside the one in TypeScript.** The
alternative — moving the writer to Rust and having the export dialog ask for its text over IPC —
was considered and rejected: it turns the dialog's live field preview into a round trip per
checkbox, strands the writer-to-parser round-trip test that vitest owns, and forces the Storybook
fake to grow a third writer. The price of keeping both is drift, and §6 is the fence that turns
drift into a red build rather than into a file that quietly disagrees with the dialog.

## 2. Scope

**In:** a mirror root the reader can move; decks (with their folder tree, archived decks and
theory lists); the collection (with its folder tree, including the automatic deck groups and
`Recently removed`); the wishlist (with its folder tree); all seven formats everywhere; every
optional field on; change detection through a SQLite update hook; a debounced background writer
with hash-comparison and pruning; a Settings panel; a golden-file conformance fence between the
Rust writer and the TypeScript one.

**Out:** reading the mirror back (it is never an import source — the app has an import dialog and
this is not it); folders as a *field* inside a format (the seven formats carry cards, and a folder
is not one — the decision `wishlist-folders.md` and the collection-folders spec both record; here
a folder is a **directory**, which is a different thing); any change to the export or import
dialogs; any change to what the seven formats say about a card; syncing the mirror anywhere
(a reader who points the root at a synced folder has thereby synced it, and that is the whole
feature); a mirror of `cards`, prices, images or app settings.

## 3. What lands on disk

```
<root>/                                     default data/export/, movable from Settings
  README.txt
  Decks/
    <deck folder>/<deck folder>/            deck_folders, nested as directories
      Azula/
        Azula.txt          plain
        Azula.mtgo.txt
        Azula.arena.txt
        Azula.moxfield.txt
        Azula.archidekt.txt
        Azula.tcgplayer.txt
        Azula.csv
        Theory/
          Azula.txt … Azula.csv             only when the deck has a theory list
    Archived/                               decks.archived = 1, with their folder tree inside
  Collection/
    Collection.txt … Collection.csv         every row, seven formats
    <folder>/
      <Folder>.txt … <Folder>.csv           just what is filed there, seven formats
      <nested folder>/…
  Wishlist/
    Wishlist.txt … Wishlist.csv
    <folder>/
      <Folder>.txt … <Folder>.csv
```

**A deck is a directory, not a file stem, because seven files belong together.** **A file is named
after the thing rather than after its role** (`Azula.archidekt.txt`, never `archidekt.txt`) so a
file dragged out of the folder still says what it is. Extensions come from the existing
`EXPORT_FORMAT_EXTENSION` — six `.txt` and one `.csv` — with the format in the stem for the five
that would otherwise collide.

**The collection's automatic folders are mirrored like any other folder.** Since v25 the cabinet
holds a group per deck and a global `Recently removed`, and that tree *is* the physical ledger of
where every card sits ([collection-folders.md](../../reference/collection-folders.md)). Leaving
them out would mirror the reader's filing while hiding the half of it the app did.

**A folder's file holds what is filed in that folder, not what is filed beneath it.** A nested
folder has its own file one directory down, and the root's `Collection.csv` is the only place
every row appears together. Rolling children up would make every card appear once per ancestor,
and a reader counting rows in two files could not tell the difference.

### 3.1 Every optional field on, and the two things that are still absent

`availableFields(format, surface)` decides what a file *can* say; the mirror turns all of it on.
A collection CSV therefore carries every fact a physical card has except a pile; an Archidekt deck
file carries printing, finish, category and the `^Label,#colour^` group.

Two omissions remain, and `README.txt` names both because neither is a field the mirror could
have switched on:

- **Arena and MTGO have no maybeboard.** Both write only the piles the reader has switched on, so
  a switched-off pile is absent from those two files and present in the other five. That is the
  format, not a setting.
- **Arena's row filter stays off.** `*.arena.txt` lists every card, which makes it a complete
  record and *not* a file Arena would accept for a paper collection. The mirror is a backup
  first; a reader who wants an importable Arena list has the export dialog, which is where that
  checkbox lives.

Prices are quoted at whatever marketplace the reader has selected, read from the database like
every other read, so the CSV's `Price` column agrees with what the app shows them.

### 3.2 Names, collisions and pruning

**Sanitising.** `< > : " / \ | ? *` and control characters become `-`; trailing dots and spaces
are trimmed; an empty name becomes `Untitled`; the Windows device names (`CON`, `PRN`, `AUX`,
`NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`) get a trailing `_`. Nothing else is touched — NTFS takes
Unicode, and a deck called `Æther Vial` should be a folder called `Æther Vial`.

**Collisions get a suffix, assigned by database id.** Two decks called `Aggro` in one folder sort
by `id`; the first keeps `Aggro` and the second becomes `Aggro (2)`. Ordering by id rather than by
iteration order is what makes the assignment stable: adding a third `Aggro` never renames the
first two, so a reader's shortcut into that folder keeps working. Sanitising can *create* a
collision (`A/B` and `A-B` both become `A-B`), which is why the suffix pass runs after it.

**Pruning is conservative, because the root is user-choosable.** Each pass deletes only files
whose name this app would itself have written (`.txt`/`.csv` matching a known stem) and
directories it has just emptied. A file the reader dropped in there survives. The cost of being
conservative is that a directory whose name no longer matches anything — a deck renamed while the
app was closed and the mirror root was on an unplugged stick — can linger; `README.txt` says the
whole root is safe to delete and will rebuild, which is the honest remedy.

**`README.txt` is part of the deliverable**, not decoration: it says what the folder is, that it is
generated, that edits to it are overwritten, that the app never reads it back, which two omissions
§3.1 lists, and that deleting the root is safe.

## 4. What Rust gains

The writer, and only the writer. The TypeScript side is untouched — no deletions, no rewiring, no
new commands for the dialogs, no changes to the Storybook fake.

| TypeScript today | Rust gains |
| --- | --- |
| `transfer/fields.ts` — the field registry, `FORMAT_FIELDS`, `SURFACE_FIELDS` | `transfer/fields.rs` |
| `transfer/export/format.ts`, `fold.ts`, `csv.ts` | `transfer/write.rs` |
| `transfer/TransferCard.ts` — three row adapters | `transfer::Card`, built from the rows Rust already reads |
| `transfer/import/parse.ts` | **nothing — the parser stays TypeScript-only** |
| `transfer/export/arena.ts` — the Arena row filter | **nothing — the mirror leaves it off (§3.1)** |

**The parser does not move, and §6 explains why the round trip survives anyway.** The mirror never
reads a file; a Rust parser would exist only to be tested.

**The mirror composes existing read functions rather than growing SQL of its own.** Every command
in this app is a thin async wrapper over a plain function taking `&Connection` —
`collection::list_entries`, `wishlist::list_wishes`, `deck::get_deck`,
`collection_folders::list_folders` and its two siblings. The mirror calls those directly on the
read-only connection, which is what guarantees a mirrored file says exactly what the same list
says on screen. The collection and the wishlist are read in pages of 2,000 rows to bound memory,
stopping on a short page, for the reason `export/scope.ts` already documents about its own sweep:
a write landing mid-pass moves the total, so the total is not the stop condition.

## 5. How a change becomes a file

```
a user write commits
        │
        ▼
  update_hook on the one write connection      rusqlite's "hooks" feature — no new crates
        │  table name ──► surface bit
        ▼
  AtomicU8 dirty mask
        │
        ▼
  mirror thread wakes 2 s after the last write
        ├─ renders the dirty surfaces in memory
        ├─ hashes each file against what it last wrote
        ├─ writes only what differs
        └─ prunes what it would no longer write
```

**One hook rather than forty call sites.** `sync::with_write` is the single funnel every
user-facing write in this crate passes through, on the one `Mutex<Connection>` the app writes
through. A `update_hook` there sees every insert, update and delete with the table's name, so no
command has to remember to tell the mirror anything and no command added next year can forget to.
`rusqlite` 0.40.1 gates that behind a `hooks` feature which pulls in **no additional crates** —
verified in the vendored manifest on 2026-08-25.

**The table-to-surface map, and what is deliberately absent from it:**

| Tables | Dirties |
| --- | --- |
| `deck_cards`, `deck_categories`, `deck_tags`, `deck_folders` | Decks |
| `decks` | Decks **and** Collection — a deck's name titles its group folder in the cabinet |
| `collection_entries`, `collection_folders` | Collection |
| `wishlist_entries`, `wishlist_folders` | Wishlist |
| `cards`, `sets`, `marketplace_prices`, `image_cache`, `deck_audit`, `deck_undo`, `error_log`, the tag tables, `app_meta`, `sync_meta` | **nothing** |

The last row is the load-bearing one. A sync rewrites 116,700 card rows and a price-feed refresh
rewrites the price table; mapping either to a surface would make every refresh a full mirror
rebuild triggered a hundred thousand times over. What those two change — a corrected card name, a
moved price — instead enters through **one full pass after a completed sync or feed refresh**,
which is a bounded event rather than a per-row storm.

`decks` dirtying the collection as well is an over-approximation of one table, kept because the
cost of being wrong in the other direction is a group folder whose name never catches up with its
deck. Hash-comparison means the over-approximation writes nothing.

**Four things run a full pass:** startup, the completion of a sync or price-feed refresh, the
Settings panel's own button, and the first pass after an unreachable root becomes reachable again
(§7). Everything else is the dirty mask.

**Hash-comparison is what makes the debounce safe.** The thread keeps the digest of every file it
has written; a rendered file whose digest is unchanged is never opened. Steady-state cost during
an editing session is therefore render-and-hash — tens of milliseconds — with seven actual writes
for the one deck that changed, rather than 350 files handed to Windows Defender and any cloud-sync
client every two seconds.

**The digests start from the files on disk, not from an empty map.** A session that began with an
empty one would rewrite the entire mirror at every launch — about 10 MB into whatever the reader
pointed the root at, including a synced folder — for data that had not changed since they closed
the app. So the startup pass hashes what is already there before deciding what to write, which
costs one read of each existing file (~350 small reads, cheaper than the writes it avoids) and
makes a relaunch with no edits a pass that opens nothing for writing.

**It runs on its own thread against `db_read`.** It never takes the write lock, so it can never
make a button answer `db::BUSY`, and it never blocks a search.

## 6. The golden fence

Two writers, one behaviour, and a build that goes red the moment they disagree.

- **One corpus, shared.** `src/features/transfer/__golden__/corpus.json` — cards on all three
  surfaces, every field populated, plus the edge cases the existing suites already know are sharp:
  a `//` split name, a CSV cell holding a comma and a quote, a switched-off pile, a labelled card
  with and without a colour, a list a format empties for itself, and an empty list. Both suites
  read this file, so the *data* cannot drift either. Rust deserialises it into `transfer::Card`
  with `rename_all = "camelCase"`, which pins the two structs to one set of field names.
- **One golden set, committed.** 7 formats × 3 surfaces × 2 field sets (everything available, and
  the format's own defaults) plus the targeted edge cases.
- **TypeScript generates; both suites assert.** `npm run golden` rewrites the files from the TS
  writer, which is the behaviour of record because it is what shipped. The vitest suite asserts
  byte equality against them; the cargo suite asserts byte equality against the same files. A
  change to either writer is a red suite with an obvious remedy.
- **The round trip survives, and gets stronger.** The vitest round-trip test parses the golden
  files through `parse.ts` and asserts it recovers the cards. Since the cargo suite has already
  proved Rust reproduces those bytes exactly, the app's parser demonstrably reads what the mirror
  writes — a claim that today's writer-then-parse test, closed inside one implementation, cannot
  make.

**Adding a field is therefore three edits and a regeneration**: `fields.ts`, `fields.rs`,
`corpus.json` if the field needs a value, then `npm run golden`. Skipping the Rust half is a red
`cargo test`, which is the whole point of the fence.

**Corrected 2026-08-25, by mutation rather than by reading.** The rendered `.txt` goldens fence
that claim for **CSV only**. `write_line` renders exactly seven ids, so in the six line formats
every other id is invisible: adding `FieldId::Lang` to `Format::Plain`'s `optional` on one side
alone moves **zero golden bytes** while changing the *fold key*, and one printing held in two
languages would then export as two lines from the mirror and one from the dialog with all 70
files green. What actually fences it is a second golden one level up —
`__golden__/fields.json`, holding `SURFACE_FIELDS` and what `availableFields`/`defaultFields`
answer for all 21 (format, surface) pairs, written by `npm run golden` and asserted by
`golden.test.ts` and `transfer/fields.rs`. The drift above now reddens exactly one test on each
side and no golden file.

## 7. Settings, and what failure looks like

A `BackupPanel` beside the existing Cache, Marketplace, Hidden tags, Update and Danger Zone panels,
following `panelChrome.tsx` like the rest:

- On/off, **on by default**.
- The root, with a **Change folder…** button. Directory selection goes through
  `tauri-plugin-dialog`'s open verb with `directory: true`; `dialog:allow-open` is already granted
  in `capabilities/default.json`, so **this feature needs no new permission**. (Note for the
  implementer: `Cargo.toml`'s comment beside that plugin still claims save is not permitted, which
  stopped being true when the export dialog shipped. Correct it in the same commit.)
- When the last pass ran, and how it went.
- **Rebuild now**, which runs a full pass.
- Moving the root writes a fresh mirror at the new location and leaves the old one alone. Deleting
  somebody's folder because they changed a setting is not this feature's decision to make; the
  panel says so.

**An unreachable root fails quietly and blocks nothing.** A stick unplugged, a sync folder
uninstalled, a permission revoked: the pass records one `error_log` row, the panel shows the state,
and the next pass tries again — a root that comes back gets a full rebuild rather than a partial
one, because the dirty mask cannot describe what was missed while it was gone. No database write
ever waits on a mirror write, and no mirror failure is ever raised to the reader as a dialog.

## 8. Testing

**Rust.** The golden conformance suite (§6). Path sanitising, including each Windows device name,
a trailing dot, an empty name, and a name that is only illegal characters. Collision suffixing,
including two names that only collide after sanitising, and stability when a third is added.
Pruning: a renamed deck leaves nothing behind, a reader's own file survives, an emptied directory
is removed and a non-empty one is not. Hash-skip: a second pass over unchanged data opens no file
for writing. The dirty map, table by table, including the tables that must map to nothing. An
unwritable root, a root that disappears mid-pass, and a root that comes back. Every filesystem
test runs against a `tempfile` root — nothing in this suite may touch `data/`.

**TypeScript.** The golden assertions and the round trip (§6). The existing writer suites are
untouched and stay the behaviour of record.

**Live.** One pass driving the real window over CDP: edit a deck, watch seven files change and the
other decks' files not; rename it, watch the old directory go; unplug the root and confirm the app
keeps writing to the database and the panel says why.

**Mutation.** Every test author breaks their own subject and confirms the test catches it —
particularly the hash-skip and the prune, where a test that passes vacuously looks exactly like a
test that works.

## 9. Cost

Measured 2026-08-25 on this machine against the live dev database (787 MB, 116,700 printings),
read through `node:sqlite`, read-only, no app lock. **These are a JavaScript ceiling** — the same
string building and writes in Rust will be under them, and the figure to re-measure once the Rust
writer exists:

| Work | Cost |
| --- | --- |
| Read 20,000 rows, warm | 85 ms |
| The same read, cold page cache (the first one after launch) | 2.3 s |
| Render 20,000 cards × 7 formats | 47 ms, 4.97 MB |
| Write those seven files | 15 ms |
| One deck of 100 cards × 7 files | 3.4 ms |
| 50 decks × 7 files = 350 files | 161 ms |

So: **~3 ms for a deck edit, ~0.3–0.5 s for a full pass** over 50 decks and a 20,000-card
collection, all of it on a background thread. The startup pass is the one that pays the cold-cache
2.3 s, which is why it is a startup pass and not something that happens while somebody is typing.

Per-folder files roughly double the byte count — a card appears in its folder's file and in the
root list — which is about 10 MB for a 20,000-card collection.

## 10. Documentation this changes

- `CLAUDE.md` — the Rust/TypeScript boundary paragraph. Export *writing* now exists on both sides
  by design; the fence in §6 is what makes that legal, and the sentence has to say so rather than
  reading as a violation.
- `src/features/transfer/CLAUDE.md` — the golden corpus and what regenerating it obliges.
- `docs/reference/import-export.md` — the second writer, and the two omissions in §3.1.
- A new `docs/reference/text-mirror.md` once it ships: the layout, the dirty map, the measured
  costs on the Rust build, and the bugs found driving it.
- `src-tauri/CLAUDE.md` — the update hook, and the rule that a new user table must be added to the
  dirty map.

## 11. Open questions

None blocking. Two the implementation will settle:

1. **Whether 2 s is the right debounce.** It is a guess informed by the measurements, not a
   measurement. Drive a bulk import and a fast drag session and see whether it collapses the burst
   without feeling stale.
2. **Whether the collection's per-folder files should be skipped for a folder holding nothing.**
   An empty folder currently produces seven empty files, and `formatExport` answers `""` for an
   empty list in every format, CSV header included. Seven zero-byte files per empty drawer is
   tidy-looking noise; writing nothing at all leaves a directory that exists with nothing in it.
   Decide it with the folder tree in front of you.
