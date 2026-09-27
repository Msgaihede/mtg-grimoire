# Folder Deletes Across Devices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A folder or deck deleted on one device never stops another device's sync, and a change
that names a parent deleted anywhere lands the way that parent's foreign key says.

**Architecture:** A local, unsynced tombstone table (`sync_gone`) is written by an `AFTER DELETE`
trigger on every table other rows are filed under, and `apply::gone` reads it. A delete `apply`
issues that would drop two copies onto one grain waits for `run_groups`' second attempt and then
re-homes the copies itself — merging onto the root twin, lower `sync_uid` kept — before the row
goes. The moot delete, freed by the tombstones, reaches folders again.

**Tech Stack:** Rust (rusqlite, the `sync_engine` module — every-target, so it must compile for
`wasm32-unknown-unknown`), SQLite triggers, one user-schema rung. One JSON file and one TypeScript
map line for the new table's registration.

**Spec:** `docs/superpowers/specs/2026-09-27-folder-deletes-across-devices-design.md`

## Global Constraints

- **Branch** `worktree-sync-folder-deletes`, worktree `D:\Code\mtg-grimoire\.claude\worktrees\token-stacks`.
- **No wire change, no relay change.** `Op` and `wire.rs` are not touched.
- **The rung is user schema v53** (`schema::USER_SCHEMA_VERSION` 52 → 53). At merge time the
  controller re-checks `grep USER_SCHEMA_VERSION src-tauri/src/schema.rs` on `origin/main` and
  renumbers if a rung landed first.
- **The table is exactly** `sync_gone (tbl TEXT NOT NULL, uid TEXT NOT NULL, PRIMARY KEY (tbl, uid)) WITHOUT ROWID`,
  user side, **not** in `SYNCED_TABLES`, no capture spec, no `sync_uid`.
- **The trigger is named `sync_gone_{table}`**, `AFTER DELETE`, gated on `OLD.sync_uid IS NOT NULL`
  and on nothing else — not the `applying` guard, not the device being in a group.
- **The parent tables are derived, never listed in live code:** `capture::parent_tables()` reads
  `capture::TABLES`' `parents`. (Today: `deck_folders`, `decks`, `deck_categories`, `deck_labels`,
  `deck_notes`, `collection_folders`, `wishlist_folders`.) The rung's backfill is the one place the
  seven are spelled, because a rung is history.
- **`Why::Occupied` is never classified**: only a first attempt returns it, and only the second
  attempt's reason is kept.
- **A re-homed row that folded onto a twin leaves the survivor wearing the lower of the two
  non-NULL `sync_uid`s.**
- **Every `DELETE` `apply` issues runs inside a savepoint and a refusal is never `?`.**
- **Implementers never commit and never dispatch subagents.** The controller commits per task
  after its review (agents share one git index).
- **Cargo only through the controller's wrapper**, `pwsh -NoProfile -File <workspace>\cargo.ps1
  <cargo args>` (it serialises every cargo run in this checkout behind a file-handle lock; the
  controller gives each implementer the path). **Format only your own files**: `rustfmt
  --edition 2021 <file>` — never `cargo fmt`, which rewrites a sibling's file mid-edit. The
  controller runs `cargo fmt` and `cargo clippy -- -D warnings` once at fan-in.
- **No `npm run verify`.** The user's instruction for this work: GitHub CI is the gate. Run the
  targeted tests each step names.
- Comments and doc comments follow the surrounding code's density and voice: say why, in full
  sentences, with the measured fact where there is one.

## Review Focus

1. **A row with a NULL `sync_uid`** (a legacy or suppressed-insert row) as either side of a fold —
   the re-home must still merge, and the survivor takes whichever uid exists (both NULL: none).
   Pinned in Task B.
2. **Three rows on one grain** — two doomed copies and a root copy of the same printing — must end
   as one root row with the summed count, on both devices. Pinned in Task B.
3. **A page re-delivered after a held cursor**, carrying a folder delete already applied: nothing
   may be re-homed or summed twice. Pinned in Task B.
4. **The browser build**: `sync_engine` is every-target, so `apply/rehome.rs` may call only
   every-target code (`collection_folders`, `wishlist_folders` are). The CI `wasm` leg is the
   check; Task B's report states it was considered.
5. **A delete made while the device is in no group** still leaves a tombstone, so a device that
   pairs later knows what it deleted. Pinned in Task A.

---

## Execution map

| Task | Owns | Runs |
| --- | --- | --- |
| A — tombstones | `schema.rs`, `sync_engine/capture.rs`, `changes.rs`, `mirror/watch.rs`, `src/lib/userTables.json`, `src/lib/crossWindow.ts` | with B |
| B — the stall | `sync_engine/apply.rs`, new `sync_engine/apply/rehome.rs`, `sync_engine/apply/tests.rs`, `wishlist_folders.rs` (one visibility change) | with A |
| C — moot and `gone` | `sync_engine/apply.rs`, `sync_engine/apply/tests.rs` | after A and B |
| D — docs | `docs/reference/sync.md`, `docs/reference/data-and-sync.md`, `src-tauri/CLAUDE.md`, `docs/superpowers/specs/2026-09-26-token-stacks-design.md` | with C |

A and B touch no file in common. C and D touch no file in common.

---

### Task A: Tombstones — the `sync_gone` table, its trigger and its rung

**Files:**
- Modify: `src-tauri/src/sync_engine/capture.rs` (`install`, a new `parent_tables`, a new `gone_trigger`, tests)
- Modify: `src-tauri/src/schema.rs` (`USER_SCHEMA_VERSION`, `TABLES`, `USER_SCHEMA_SQL`, `migrate_user`'s new `if v < 53` block, `tests::UNDO_V53` and every rewind chain, the table-count test's figures)
- Modify: `src-tauri/src/changes.rs` (`WRITTEN_BY_THE_APP`)
- Modify: `src-tauri/src/mirror/watch.rs` (the decided-about list in `every_table_in_the_schema_has_been_decided_about`)
- Modify: `src/lib/userTables.json`, `src/lib/crossWindow.ts` (`TABLE_KEYS`)

**Interfaces:**
- Produces: `pub(crate) fn parent_tables() -> Vec<&'static str>` in `capture.rs` — every table some
  `capture::TABLES` spec names in its `parents`, deduplicated, in `TABLES` order.
- Produces: the `sync_gone` table and one `sync_gone_{t}` trigger per parent table, installed by
  `capture::install`. Task C's `gone` reads `SELECT 1 FROM sync_gone WHERE tbl = ?1 AND uid = ?2`.

- [ ] **Step 1: Write the failing capture tests**

In `capture.rs`'s `mod tests` (its `db()` fixture installs the triggers and pairs the device):

```rust
fn gone_rows(conn: &Connection) -> Vec<(String, String)> {
    let mut stmt = conn
        .prepare("SELECT tbl, uid FROM sync_gone ORDER BY tbl, uid")
        .unwrap();
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    rows.map(Result::unwrap).collect()
}

/// **Every delete of a row other rows are filed under leaves a tombstone** — the reader's own,
/// and the one an apply makes behind the guard, and each row a cascade takes with it. That is
/// the whole of what `apply::gone` needs to answer for a delete it did not see in the page.
#[test]
fn every_delete_of_a_parent_row_leaves_a_tombstone_whatever_made_it() {
    let conn = db();
    conn.execute_batch(
        "INSERT INTO collection_folders (name, kind, sort_order, created_at, updated_at)
         VALUES ('Outer', 'user', 0, unixepoch(), unixepoch());
         INSERT INTO collection_folders (parent_id, name, kind, sort_order, created_at, updated_at)
         VALUES ((SELECT id FROM collection_folders WHERE name = 'Outer'), 'Inner', 'user', 0,
                 unixepoch(), unixepoch());
         INSERT INTO deck_folders (name, sort_order, created_at, updated_at)
         VALUES ('Shelf', 0, unixepoch(), unixepoch());",
    )
    .unwrap();
    let uid = |t: &str, name: &str| -> String {
        conn.query_row(
            &format!("SELECT sync_uid FROM {t} WHERE name = ?1"),
            [name],
            |r| r.get(0),
        )
        .unwrap()
    };
    let (outer, inner, shelf) = (
        uid("collection_folders", "Outer"),
        uid("collection_folders", "Inner"),
        uid("deck_folders", "Shelf"),
    );

    conn.execute("DELETE FROM deck_folders", []).unwrap();
    // Behind the apply's guard, and `Inner` goes by the cascade alone.
    suppressed(&conn, || {
        conn.execute("DELETE FROM collection_folders WHERE name = 'Outer'", [])
            .unwrap()
    });

    let mut want = vec![
        ("collection_folders".to_owned(), inner),
        ("collection_folders".to_owned(), outer),
        ("deck_folders".to_owned(), shelf),
    ];
    want.sort();
    assert_eq!(gone_rows(&conn), want);
}

/// **A row nothing is filed under leaves none** — a copy, a deck card, a wish. `gone` is only
/// ever asked about a parent, and every other row would be a table that grows with no reader.
#[test]
fn a_delete_of_a_row_nothing_is_filed_under_leaves_no_tombstone() {
    let conn = db();
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,
             created_at,updated_at)
         VALUES ('c1','lea','1','en','nonfoil','NM',1,unixepoch(),unixepoch())",
        [],
    )
    .unwrap();
    conn.execute("DELETE FROM collection_entries", []).unwrap();
    assert!(gone_rows(&conn).is_empty());
}

/// **A device in no group still records what it deleted**, so the day it pairs it can still
/// tell a peer's child of that row is moot rather than merely early.
#[test]
fn a_device_in_no_group_still_leaves_tombstones() {
    let conn = crate::schema::memory_pair();
    install(&conn).unwrap();
    conn.execute(
        "INSERT INTO deck_folders (name, sort_order, created_at, updated_at, sync_uid)
         VALUES ('Shelf', 0, unixepoch(), unixepoch(), 'u-shelf')",
        [],
    )
    .unwrap();
    conn.execute("DELETE FROM deck_folders", []).unwrap();
    assert_eq!(
        gone_rows(&conn),
        vec![("deck_folders".to_owned(), "u-shelf".to_owned())]
    );
}

/// **The parent tables are read off the specs**, so a synced table that grows a child is
/// tombstoned the day its spec says so.
#[test]
fn the_parent_tables_are_the_ones_the_specs_name() {
    let mut got = parent_tables();
    got.sort_unstable();
    assert_eq!(
        got,
        vec![
            "collection_folders",
            "deck_categories",
            "deck_folders",
            "deck_labels",
            "deck_notes",
            "decks",
            "wishlist_folders",
        ]
    );
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `pwsh -NoProfile -File <workspace>\cargo.ps1 test --lib sync_engine::capture::tests::`
Expected: compile error — `parent_tables` not found and `no such table: sync_gone`.

- [ ] **Step 3: The table, the rung and the registration**

In `schema.rs`:

1. `pub const USER_SCHEMA_VERSION: i64 = 53;`
2. `TABLES`: add `("sync_gone", Side::User),` beside `("sync_peers", Side::User),`.
3. `USER_SCHEMA_SQL`: after the `sync_peers` table, in `sync_peers`' own indentation:

```sql
CREATE TABLE {schema}.sync_gone (
                 tbl TEXT NOT NULL,
                 uid TEXT NOT NULL,
                 PRIMARY KEY (tbl, uid)
             ) WITHOUT ROWID;
```

4. `migrate_user`: a new block at the **bottom** of the ladder, after `if v < 52`, with a comment
   in the ladder's voice saying what it is for (spec §3.1) and that it owes `tests::UNDO_V53` for
   `UNDO_V37`'s reason (a bare `CREATE TABLE`). **The table text must match the literal above byte
   for byte once stored** — `the_user_schema_is_byte_identical_to_what_the_ladder_builds` compares
   `sqlite_master`, so copy the indentation `sync_peers`' rung uses at line ~5394:

```rust
    if v < 53 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE sync_gone (
                 tbl TEXT NOT NULL,
                 uid TEXT NOT NULL,
                 PRIMARY KEY (tbl, uid)
             ) WITHOUT ROWID;

             -- Every delete `gone` could already see, it still sees: this device's own `del`
             -- ops for the seven tables other rows are filed under. Spelled out because a rung
             -- is history; live code reads `capture::parent_tables()`.
             INSERT OR IGNORE INTO sync_gone (tbl, uid)
                 SELECT DISTINCT tbl, uid FROM sync_ops
                  WHERE kind = 'del'
                    AND tbl IN ('deck_folders', 'decks', 'deck_categories', 'deck_labels',
                                'deck_notes', 'collection_folders', 'wishlist_folders');",
        )?;
        // Literal `53`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA main.user_version = 53;")?;
        tx.commit()?;
    }
```

5. `tests`: `const UNDO_V53: &str = "DROP TABLE IF EXISTS sync_gone;";` with a doc comment in the
   style of `UNDO_V52`'s, and **`{UNDO_V53} ` prepended to every rewind chain** that starts with
   `{UNDO_V52}` (sixteen literals: `grep -n '{UNDO_V52}' src-tauri/src/schema.rs`). A chain that
   is missing it dies at `table sync_gone already exists` on the way back up.
6. The table-count test (`thirty-one tables, fifty indexes…`, line ~8521): **re-count** off the
   literal and update both the figures and the sentence. `sync_gone` is `WITHOUT ROWID`, so its
   composite primary key is the table and brings no index or autoindex of its own.

In `changes.rs`: `pub const WRITTEN_BY_THE_APP: &[&str] = &["price_snapshots", "sync_gone", "sync_peers"];`
and extend its doc comment: a tombstone is written by a trigger during the app's own writes, and no
window draws it.

In `mirror/watch.rs`, the decided-about list: add `"sync_gone",` beside `"sync_peers",` and extend
the comment above them — the tombstones describe the conversation, not the collection, and are
`WITHOUT ROWID` besides.

In `src/lib/userTables.json`: insert `"sync_gone"` between `"sync_devices"` and `"sync_group"`
(the array is sorted).

In `src/lib/crossWindow.ts`'s `TABLE_KEYS`: `sync_gone: [],` between `sync_devices` and
`sync_group`, with no comment beyond what `sync_peers: []` carries.

- [ ] **Step 4: The trigger**

In `capture.rs`:

```rust
/// Every table some spec names as a parent — the tables other rows are filed under, and so the
/// only ones [`crate::sync_engine::apply`]'s `gone` is ever asked about. **Read off [`TABLES`]
/// rather than listed**, so a synced table that grows a child is tombstoned the day its spec says
/// so.
pub(crate) fn parent_tables() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for spec in &TABLES {
        for p in spec.parents {
            if !out.contains(&p.table) {
                out.push(p.table);
            }
        }
    }
    out
}

/// The tombstone trigger: every delete of a parent row, whatever made it.
///
/// **Not gated on [`GUARD`], and that is the point of it.** A delete an apply makes runs behind
/// the guard, and so does every cascade it sets off — which is why, before this, a delete a peer
/// made left no trace here and a later child of it waited out the bound and was dropped
/// (spec 2026-09-27 §1.2). A cascaded delete fires this like any other: measured with
/// `recursive_triggers` off, a folder's delete logged its sub-folder's `AFTER DELETE` before its
/// own. Not gated on a group either, so a device that pairs later still knows what it deleted.
fn gone_trigger(table: &str) -> String {
    format!(
        "DROP TRIGGER IF EXISTS sync_gone_{table};
         CREATE TRIGGER sync_gone_{table} AFTER DELETE ON {table}
         WHEN OLD.sync_uid IS NOT NULL
         BEGIN
             INSERT OR IGNORE INTO sync_gone (tbl, uid) VALUES ('{table}', OLD.sync_uid);
         END;"
    )
}
```

and in `install`, after the loop over `TABLES` and before the clock trigger:

```rust
    for table in parent_tables() {
        conn.execute_batch(&gone_trigger(table))?;
    }
```

Update `install`'s doc comment, which lists what it installs.

- [ ] **Step 5: The backfill test**

In `schema.rs`'s `mod tests`:

```rust
/// **The v53 rung tombstones every delete `gone` could already see** — this device's own `del`
/// ops for a parent table — and nothing else: a copy's `del` is history `gone` is never asked.
#[test]
fn the_v53_rung_tombstones_this_devices_own_deletes_of_parent_rows() {
    let conn = crate::schema::memory_pair();
    crate::sync_engine::capture::install(&conn).unwrap();
    conn.execute_batch(
        "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
         VALUES (1, 'dev', x'00', x'01', 'dev', 0);
         INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
         VALUES (1, 'g', 0, x'02', 0);
         INSERT INTO decks (name, format_key, created_at, updated_at)
         VALUES ('D', 'commander', unixepoch(), unixepoch());
         INSERT INTO collection_folders (name, kind, sort_order, created_at, updated_at)
         VALUES ('Binder', 'user', 0, unixepoch(), unixepoch());
         INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,
             created_at,updated_at)
         VALUES ('c1','lea','1','en','nonfoil','NM',1,unixepoch(),unixepoch());",
    )
    .unwrap();
    let uid = |sql: &str| -> String { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
    let deck = uid("SELECT sync_uid FROM decks");
    let binder = uid("SELECT sync_uid FROM collection_folders WHERE name = 'Binder'");
    conn.execute_batch(
        "DELETE FROM collection_entries;
         DELETE FROM collection_folders WHERE name = 'Binder';
         DELETE FROM decks;",
    )
    .unwrap();

    // Back to a v52 file: no table, so the trigger's rows are gone and only `sync_ops` remains.
    conn.execute_batch(&format!("{UNDO_V53} PRAGMA main.user_version = 52;"))
        .unwrap();
    migrate_user(&conn).unwrap();

    let mut stmt = conn
        .prepare("SELECT tbl, uid FROM sync_gone ORDER BY tbl")
        .unwrap();
    let got: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        got,
        vec![
            ("collection_folders".to_owned(), binder),
            ("decks".to_owned(), deck)
        ]
    );
}
```

(`memory_pair` creating a group's `Recently removed` and a deck's group folder is not needed here:
the deck is inserted by hand and has none.) If `migrate_user` is not reachable by that name from
`tests`, use whatever the neighbouring rung tests call — `user_file_at_51`'s neighbours show it.

- [ ] **Step 6: Run the tests**

Run, one after the other:
`pwsh -NoProfile -File <workspace>\cargo.ps1 test --lib sync_engine::capture::tests::`
`pwsh -NoProfile -File <workspace>\cargo.ps1 test --lib schema::`
`pwsh -NoProfile -File <workspace>\cargo.ps1 test --lib changes::`
`pwsh -NoProfile -File <workspace>\cargo.ps1 test --lib mirror::watch::`
Expected: all pass. Then the frontend files: `npx vitest run src/lib/crossWindow` (and any test
that names `userTables.json` — `grep -rl userTables src/`).

- [ ] **Step 7: Format and report**

`rustfmt --edition 2021` on each Rust file you changed. Report to the report file; do not commit.

---

### Task B: The stall — a colliding delete waits, then merges

**Files:**
- Create: `src-tauri/src/sync_engine/apply/rehome.rs`
- Modify: `src-tauri/src/sync_engine/apply.rs` (`mod rehome;`, `enum Attempt`, `Why::Occupied`, `run_groups`, `write_group`'s delete arm)
- Modify: `src-tauri/src/wishlist_folders.rs` (`fn refile_wish` → `pub(crate) fn refile_wish`)
- Test: `src-tauri/src/sync_engine/apply/tests.rs`

**Interfaces:**
- Consumes: `crate::collection_folders::refile_entry(tx: &Connection, id: i64, folder_id: Option<i64>) -> Result<EntryChange, String>`
  and `crate::wishlist_folders::refile_wish(tx: &Connection, id: i64, folder_id: Option<i64>) -> Result<EntryChange, String>`
  — each files a row at `folder_id` (`None` is the root), folding onto the row already on that
  grain and answering the survivor's id in `EntryChange::id`.
- Produces, in `apply/rehome.rs` (`pub(super)`):
  - `struct Doomed { collection: Vec<i64>, wishlist: Vec<i64> }` — ids of the copies and wishes filed in the folders a delete would take, ascending.
  - `fn doomed(conn: &Connection, table: &str, uid: &str) -> Result<Doomed, String>`
  - `fn collides(conn: &Connection, d: &Doomed) -> Result<bool, String>`
  - `fn rehome(conn: &Connection, d: &Doomed) -> Result<(), String>`
  - `const CASCADES_INTO_FOLDERS: [(&str, &str, &str); 3]` — `(child table, column, parent table)`.
- Produces, in `apply.rs`: `enum Attempt { First, Retry }` (`Clone, Copy, PartialEq, Eq`) and
  `write_group(conn, g, report, soft, deleted, attempt: Attempt)`. Task C passes `attempt` on to
  `cascade_onto_the_row_here`.

- [ ] **Step 1: Write the failing tests**

In `apply/tests.rs`. Helpers first (the file already has `paired`, `since`, `add_copy`, `qty`,
`unwritten`, `skips`):

```rust
/// A user binder named `name`, and its id.
fn binder(conn: &Connection, name: &str, parent: Option<i64>) -> i64 {
    conn.execute(
        "INSERT INTO collection_folders (parent_id, name, kind, sort_order, created_at, updated_at)
         VALUES (?1, ?2, 'user', 0, unixepoch(), unixepoch())",
        rusqlite::params![parent, name],
    )
    .unwrap();
    conn.last_insert_rowid()
}

/// `quantity` copies of the test printing (`add_copy`'s grain) filed in `folder`.
fn file_copies(conn: &Connection, folder: Option<i64>, quantity: i64) {
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,
             created_at,updated_at)
         VALUES ('c1','lea','1','en','nonfoil','NM',?1,?2,unixepoch(),unixepoch())",
        rusqlite::params![quantity, folder],
    )
    .unwrap();
}

fn uids_of_copies(conn: &Connection) -> Vec<Option<String>> {
    let mut stmt = conn
        .prepare("SELECT sync_uid FROM collection_entries ORDER BY sync_uid")
        .unwrap();
    let rows = stmt.query_map([], |r| r.get(0)).unwrap();
    rows.map(Result::unwrap).collect()
}

fn folders(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM collection_folders WHERE kind = 'user'",
        [],
        |r| r.get(0),
    )
    .unwrap()
}
```

Then the tests:

```rust
/// **A binder deleted on one device, holding a copy the root holds too, lands on the other.**
/// The peer takes a page parents first, so the binder's `DELETE` ran while its copy was still in
/// it and `SET NULL` dropped the copy onto the root's grain: `UNIQUE constraint failed`, through
/// `?`, the whole apply failed, and the same page failed it on every pull after (spec §1.1).
///
/// **What makes it red**: the delete arm with no collision check.
#[test]
fn a_binder_deleted_with_a_copy_the_root_also_holds_lands_on_the_peer() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    add_copy(&a);
    let bin = binder(&a, "Binder", None);
    file_copies(&a, Some(bin), 2);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    crate::collection_folders::delete_folder(&a, bin).unwrap();
    let rb = apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!(unwritten(rb), (0, 0));
    for (who, c) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(c), (1, 3), "{who} does not hold one root row of three");
        assert_eq!(folders(c), 0, "{who} still holds the binder");
    }
    assert!(skips(&b).is_empty(), "{:?}", skips(&b));
}

/// **The same for a wishlist folder**: `wishlist_entries.folder_id` is `SET NULL` and the
/// wishlist's grain carries the folder too.
#[test]
fn a_wishlist_folder_deleted_with_a_wish_the_root_also_holds_lands_on_the_peer() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    a.execute(
        "INSERT INTO wishlist_folders (name, sort_order, created_at, updated_at)
         VALUES ('Wants', 0, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let wants = a.last_insert_rowid();
    for (folder, n) in [(None, 1), (Some(wants), 2)] {
        a.execute(
            "INSERT INTO wishlist_entries (oracle_id, name, quantity, folder_id, created_at, updated_at)
             VALUES ('o1', 'Bolt', ?1, ?2, unixepoch(), unixepoch())",
            rusqlite::params![n, folder],
        )
        .unwrap();
    }
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    crate::wishlist_folders::delete_folder(&a, wants).unwrap();
    let rb = apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!(unwritten(rb), (0, 0));
    for (who, c) in [("a", &a), ("b", &b)] {
        let (rows, sum): (i64, i64) = c
            .query_row(
                "SELECT count(*), coalesce(sum(quantity), 0) FROM wishlist_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((rows, sum), (1, 3), "{who}");
    }
}

/// **A deck deleted on one device, whose group holds a copy the root holds too, lands on the
/// other.** `collection_folders.deck_id` cascades, so the deck's `DELETE` (rank 1) takes its
/// group on the peer before the sender's re-filing into `Recently removed` (rank 7) arrives.
#[test]
fn a_deck_deleted_with_a_copy_its_group_and_the_root_both_hold_lands_on_the_peer() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    // The two holding areas have to have met first — see
    // `clearing_the_collection_crosses_without_two_holding_areas` for how, and do the same here.
    a.execute(
        "INSERT INTO decks (name, format_key, created_at, updated_at)
         VALUES ('D', 'commander', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let deck = a.last_insert_rowid();
    a.execute(
        "INSERT INTO collection_folders (name, kind, deck_id, sort_order, created_at, updated_at)
         VALUES ('D', 'deck', ?1, 0, unixepoch(), unixepoch())",
        [deck],
    )
    .unwrap();
    let group = a.last_insert_rowid();
    add_copy(&a);
    file_copies(&a, Some(group), 1);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    crate::deck::delete_deck(&a, deck).unwrap();
    let rb = apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!(unwritten(rb), (0, 0));
    for (who, c) in [("a", &a), ("b", &b)] {
        let decks: i64 = c.query_row("SELECT count(*) FROM decks", [], |r| r.get(0)).unwrap();
        assert_eq!(decks, 0, "{who}");
        assert_eq!(qty(c), (2, 2), "{who}: one copy at the root, one in Recently removed");
    }
}

/// **A copy filed on the peer into the binder being deleted survives on both, as one row.**
/// The page carries no re-filing for it, so no ordering saves it: the retry merges it onto the
/// root's copy, and the sender meets its put with the binder gone and grain-matches the same
/// row. Both adopt the lower uid.
#[test]
fn a_copy_filed_into_a_binder_the_peer_deletes_meets_the_roots_copy_as_one_row() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    add_copy(&a);
    let bin = binder(&a, "Binder", None);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    crate::collection_folders::delete_folder(&a, bin).unwrap();
    let b_bin: i64 = b
        .query_row("SELECT id FROM collection_folders WHERE name = 'Binder'", [], |r| r.get(0))
        .unwrap();
    file_copies(&b, Some(b_bin), 2);

    let rb = apply(&b, &since(&a, &mut ma)).unwrap();
    let ra = apply(&a, &since(&b, &mut mb)).unwrap();

    assert_eq!((unwritten(ra), unwritten(rb)), ((0, 0), (0, 0)));
    for (who, c) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(c), (1, 3), "{who}");
        assert_eq!(folders(c), 0, "{who}");
    }
    assert_eq!(uids_of_copies(&a), uids_of_copies(&b), "the two devices kept different uids");
}

/// **Two copies in two sub-folders, and a root copy, on one grain end as one root row.**
/// The sender's `delete_folder` re-files one at a time; the peer meets the sub-folders' deletes
/// first and must not drop either copy onto the other (Review Focus 2).
#[test]
fn three_copies_on_one_grain_under_a_deleted_folder_end_as_one_root_row_on_both() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    add_copy(&a);
    let outer = binder(&a, "Outer", None);
    let one = binder(&a, "One", Some(outer));
    let two = binder(&a, "Two", Some(outer));
    file_copies(&a, Some(one), 1);
    file_copies(&a, Some(two), 1);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);

    crate::collection_folders::delete_folder(&a, outer).unwrap();
    let rb = apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!(unwritten(rb), (0, 0));
    for (who, c) in [("a", &a), ("b", &b)] {
        assert_eq!(qty(c), (1, 3), "{who}");
        assert_eq!(folders(c), 0, "{who}");
    }
}

/// **A page handed back after a held cursor re-homes and sums nothing a second time**
/// (Review Focus 3): the delete is below its sender's watermark on the second delivery.
#[test]
fn a_redelivered_binder_delete_changes_nothing_the_second_time() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    add_copy(&a);
    let bin = binder(&a, "Binder", None);
    file_copies(&a, Some(bin), 2);
    apply(&b, &since(&a, &mut ma)).unwrap();

    crate::collection_folders::delete_folder(&a, bin).unwrap();
    let page = since(&a, &mut ma);
    apply(&b, &page).unwrap();
    let again = apply(&b, &page).unwrap();
    assert_eq!(unwritten(again), (0, 0));
    assert_eq!(qty(&b), (1, 3));
}

/// **A survivor with no uid takes the one the re-homed copy had** (Review Focus 1). A row
/// written behind the apply's guard can be nameless; the fold must still happen, and the name
/// a peer knows the copy by must not be thrown away.
#[test]
fn a_copy_folded_onto_a_nameless_twin_gives_the_twin_its_uid() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    let bin = binder(&a, "Binder", None);
    file_copies(&a, Some(bin), 2);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let _ = since(&b, &mut mb);
    let filed: String = b
        .query_row("SELECT sync_uid FROM collection_entries", [], |r| r.get(0))
        .unwrap();
    // A nameless root twin on `b` alone.
    crate::sync_engine::capture::suppressed(&b, || {
        file_copies(&b, None, 1);
        b.execute(
            "UPDATE collection_entries SET sync_uid = NULL WHERE folder_id IS NULL",
            [],
        )
        .unwrap();
    });

    crate::collection_folders::delete_folder(&a, bin).unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!(qty(&b), (1, 3));
    assert_eq!(uids_of_copies(&b), vec![Some(filed)]);
}

/// **A delete this database refuses is skipped and recorded, never a stall.** A TEMP trigger
/// stands in for the first refusal nothing reaches today.
#[test]
fn a_folder_delete_this_database_refuses_is_dropped_and_the_page_applies() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    let bin = binder(&a, "Binder", None);
    apply(&b, &since(&a, &mut ma)).unwrap();
    b.execute_batch(
        "CREATE TEMP TRIGGER refuse BEFORE DELETE ON collection_folders
         BEGIN SELECT RAISE(ABORT, 'refused'); END;",
    )
    .unwrap();

    crate::collection_folders::delete_folder(&a, bin).unwrap();
    add_copy(&a);
    let rb = apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!(unwritten(rb), (0, 1), "{rb:?}");
    assert_eq!(folders(&b), 1, "the refused delete took the binder anyway");
    assert_eq!(qty(&b), (1, 1), "the rest of the page did not apply");
    assert_eq!(skips(&b).len(), 1, "{:?}", skips(&b));
}

/// **A copy removed and added again before the next pull ends at the re-added count** — the
/// case a page applied "deletes last" would get wrong (spec §3.4), pinned so nobody makes it.
#[test]
fn a_copy_removed_and_added_again_in_one_page_ends_at_the_new_count() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    add_copy(&a);
    apply(&b, &since(&a, &mut ma)).unwrap();

    a.execute("DELETE FROM collection_entries", []).unwrap();
    add_copy(&a);
    apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!(qty(&b), (1, 1));
    assert_eq!(uids_of_copies(&a), uids_of_copies(&b));
}

/// **Every cascade into a folder table is one [`super::rehome::doomed`] follows.** Walks the live
/// schema's `ON DELETE CASCADE` keys backwards from the two folder tables, so a new one — a
/// token folder's own key, say — fails here until `doomed` is taught it.
#[test]
fn every_cascade_into_a_folder_table_is_one_doomed_follows() {
    let conn = paired("dev-a");
    let mut reached: Vec<String> = vec!["collection_folders".into(), "wishlist_folders".into()];
    let mut edges: Vec<(String, String, String)> = Vec::new();
    let mut i = 0;
    while i < reached.len() {
        let child = reached[i].clone();
        let mut stmt = conn
            .prepare(
                "SELECT \"from\", \"table\" FROM pragma_foreign_key_list(?1)
                  WHERE on_delete = 'CASCADE'",
            )
            .unwrap();
        let keys: Vec<(String, String)> = stmt
            .query_map([&child], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        for (col, parent) in keys {
            edges.push((child.clone(), col, parent.clone()));
            if !reached.contains(&parent) {
                reached.push(parent);
            }
        }
        i += 1;
    }
    edges.sort();
    let mut want: Vec<(String, String, String)> = super::rehome::CASCADES_INTO_FOLDERS
        .iter()
        .map(|(c, k, p)| ((*c).to_owned(), (*k).to_owned(), (*p).to_owned()))
        .collect();
    want.sort();
    assert_eq!(edges, want);
}
```

If `apply/tests.rs` has no `use rusqlite;` path for `rusqlite::params!`, add what the file's other
tests use.

- [ ] **Step 2: Run them to see them fail**

Run: `pwsh -NoProfile -File <workspace>\cargo.ps1 test --lib sync_engine::apply::tests::`
Expected: compile error on `super::rehome`. After Step 3's skeleton compiles, the stall tests fail
with `UNIQUE constraint failed` (panic on `.unwrap()` of `apply`) and the backstop test fails the
same way on `refused`; `a_copy_removed_and_added_again_in_one_page_ends_at_the_new_count` passes
already — it pins today's order.

- [ ] **Step 3: `apply/rehome.rs`**

```rust
//! What a delete `apply` issues would clear out of the two folder tables, and the re-homing that
//! stops it dropping two rows onto one grain (spec 2026-09-27 §3.3).
//!
//! `collection_entries.folder_id` and `wishlist_entries.folder_id` are `ON DELETE SET NULL`, and
//! both tables carry the folder in their grain. So a folder's `DELETE` moves every row filed in it
//! onto the root's grain at once — and where the root already holds that row, or two doomed rows
//! share one, the index refuses and the whole apply with it. The sender never meets this:
//! `collection_folders::delete_folder` re-files one row at a time through the merge first. This
//! is that merge on the receiving side, for the rows the page does not re-file itself.

use rusqlite::{Connection, OptionalExtension};

/// Every `ON DELETE CASCADE` key into a folder table, as `(child table, column, parent table)`:
/// the paths [`doomed`] follows. Held to the live schema by
/// `every_cascade_into_a_folder_table_is_one_doomed_follows`.
pub(super) const CASCADES_INTO_FOLDERS: [(&str, &str, &str); 3] = [
    ("collection_folders", "deck_id", "decks"),
    ("collection_folders", "parent_id", "collection_folders"),
    ("wishlist_folders", "parent_id", "wishlist_folders"),
];

/// The copies and wishes filed in the folders a delete would take, by id, ascending.
#[derive(Debug, Default)]
pub(super) struct Doomed {
    pub collection: Vec<i64>,
    pub wishlist: Vec<i64>,
}

/// What deleting `table`'s row `uid` would clear: a folder and its sub-tree, or a deck's group
/// folders and theirs. Any other table dooms nothing.
pub(super) fn doomed(conn: &Connection, table: &str, uid: &str) -> Result<Doomed, String> {
    let (folders, seed): (&str, &str) = match table {
        "collection_folders" => (
            "collection_folders",
            "SELECT id FROM collection_folders WHERE sync_uid = ?1",
        ),
        "decks" => (
            "collection_folders",
            "SELECT f.id FROM collection_folders f JOIN decks d ON f.deck_id = d.id
              WHERE d.sync_uid = ?1",
        ),
        "wishlist_folders" => (
            "wishlist_folders",
            "SELECT id FROM wishlist_folders WHERE sync_uid = ?1",
        ),
        _ => return Ok(Doomed::default()),
    };
    let entries = if folders == "collection_folders" {
        "collection_entries"
    } else {
        "wishlist_entries"
    };
    let sql = format!(
        "WITH RECURSIVE tree(id) AS ({seed}
                UNION SELECT f.id FROM {folders} f JOIN tree t ON f.parent_id = t.id)
         SELECT e.id FROM {entries} e WHERE e.folder_id IN (SELECT id FROM tree) ORDER BY e.id"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([uid], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<i64>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(if entries == "collection_entries" {
        Doomed { collection: ids, wishlist: Vec::new() }
    } else {
        Doomed { collection: Vec::new(), wishlist: ids }
    })
}
```

`collides` and `rehome`, with the grain spelled out in full for `refile_entry`'s reason (every
term, the folder read as "the root"):

```rust
/// Whether clearing the doomed rows' folder would drop two rows onto one grain: a doomed row
/// whose root twin exists, or two doomed rows that are each other's twin.
pub(super) fn collides(conn: &Connection, d: &Doomed) -> Result<bool, String> {
    for &id in &d.collection {
        let hit: Option<i64> = conn
            .query_row(
                "SELECT t.id FROM collection_entries e JOIN collection_entries t
                   ON t.id <> e.id
                  AND t.card_id = e.card_id AND t.finish = e.finish
                  AND t.condition = e.condition AND t.lang = e.lang
                  AND t.altered = e.altered AND t.signed = e.signed
                  AND t.proxy = e.proxy AND t.misprint = e.misprint
                  AND coalesce(t.serial_number, '') = coalesce(e.serial_number, '')
                  AND coalesce(t.grading, '') = coalesce(e.grading, '')
                WHERE e.id = ?1
                  AND (t.folder_id IS NULL OR t.id IN (SELECT value FROM json_each(?2)))
                LIMIT 1",
                rusqlite::params![id, ids_json(&d.collection)],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if hit.is_some() {
            return Ok(true);
        }
    }
    for &id in &d.wishlist {
        let hit: Option<i64> = conn
            .query_row(
                "SELECT t.id FROM wishlist_entries e JOIN wishlist_entries t
                   ON t.id <> e.id
                  AND coalesce(t.oracle_id, '') = coalesce(e.oracle_id, '')
                  AND coalesce(t.card_id, '') = coalesce(e.card_id, '')
                  AND coalesce(t.preferred_finish, '') = coalesce(e.preferred_finish, '')
                WHERE e.id = ?1
                  AND (t.folder_id IS NULL OR t.id IN (SELECT value FROM json_each(?2)))
                LIMIT 1",
                rusqlite::params![id, ids_json(&d.wishlist)],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if hit.is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn ids_json(ids: &[i64]) -> String {
    serde_json::to_string(ids).unwrap_or_else(|_| "[]".to_owned())
}

/// File every doomed row at the root, one at a time, through the crate's own merge — and where
/// one folded onto a twin, give the survivor the lower of the two uids.
///
/// **Why the lower uid**: a row re-homed here is one the page did not mention, so its own put
/// reaches the sender with its folder gone, the sender writes it without the folder, and
/// `find_row`'s grain match lands it on the same twin, adopting `min`. A nameless side takes the
/// other's uid; two nameless sides keep none (Review Focus 1).
pub(super) fn rehome(conn: &Connection, d: &Doomed) -> Result<(), String> {
    for &id in &d.collection {
        let before = uid_of(conn, "collection_entries", id)?;
        let kept = crate::collection_folders::refile_entry(conn, id, None)?.id;
        adopt_lower(conn, "collection_entries", kept, id, before)?;
    }
    for &id in &d.wishlist {
        let before = uid_of(conn, "wishlist_entries", id)?;
        let kept = crate::wishlist_folders::refile_wish(conn, id, None)?.id;
        adopt_lower(conn, "wishlist_entries", kept, id, before)?;
    }
    Ok(())
}

fn uid_of(conn: &Connection, table: &str, id: i64) -> Result<Option<String>, String> {
    conn.query_row(
        &format!("SELECT sync_uid FROM {table} WHERE id = ?1"),
        [id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

fn adopt_lower(
    conn: &Connection,
    table: &str,
    kept: i64,
    moved: i64,
    moved_uid: Option<String>,
) -> Result<(), String> {
    if kept == moved {
        return Ok(());
    }
    let Some(moved_uid) = moved_uid else {
        return Ok(());
    };
    let survivor = uid_of(conn, table, kept)?;
    if survivor.as_deref().map_or(true, |s| moved_uid.as_str() < s) {
        conn.execute(
            &format!("UPDATE {table} SET sync_uid = ?1 WHERE id = ?2"),
            rusqlite::params![moved_uid, kept],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

In `wishlist_folders.rs`: `fn refile_wish` → `pub(crate) fn refile_wish`, and one sentence added
to its doc naming the third caller (`sync_engine::apply::rehome`, re-homing a peer's folder delete).

`refile_wish` refuses a missing wish with `WISH_GONE` and `refile_entry` a missing copy with
`GONE`; a doomed id was read inside the same savepoint, so neither can fire, and if one did the
backstop in Step 4 turns it into a dropped group.

- [ ] **Step 4: `apply.rs` — the attempt, `Occupied`, and the delete arm**

Add `mod rehome;` beside `#[cfg(test)] mod tests;`. Add:

```rust
/// Which attempt at a group this is. `run_groups` tries every group once, then once more for the
/// ones that did not land — after every other group in the page, which is what lets a delete
/// that would collide wait for the sender's own re-filing (spec 2026-09-27 §3.3).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Attempt {
    First,
    Retry,
}
```

`Why` gains:

```rust
    /// A delete that would drop two rows onto one grain, asked to wait for the retry. **Never
    /// classified**: only a first attempt answers it, and only the second attempt's reason is
    /// kept.
    Occupied,
```

and `Why::text` an arm for it (the words: `waits for the page's own re-filing`).

`run_groups` passes `Attempt::First` in the first loop and `Attempt::Retry` in the second.
`write_group` takes `attempt: Attempt` last. Its delete arm becomes:

```rust
    if combined.deleted {
        if let Some(uid) = &existing.uid {
            let doomed = rehome::doomed(conn, meta.table, uid)?;
            if attempt == Attempt::First && rehome::collides(conn, &doomed)? {
                rollback()?;
                return Ok(Outcome::Deferred(Why::Occupied));
            }
            // **Never `?` from here.** A refusal rolls the group back and is a row this
            // database cannot build — dropped and recorded, or held where the sender is newer —
            // because a delete that failed through `?` failed the whole apply, and the same page
            // failed it again on every pull after (spec §1.1).
            let done = rehome::rehome(conn, &doomed).and_then(|()| {
                conn.execute(
                    &format!("DELETE FROM {} WHERE sync_uid = ?1", meta.table),
                    [uid],
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
            });
            if let Err(e) = done {
                rollback()?;
                return Ok(Outcome::Deferred(Why::Unbuildable(e)));
            }
        }
        conn.execute_batch(&format!("RELEASE {savepoint}"))
            .map_err(|e| e.to_string())?;
        report.applied += g.ops.len();
        return Ok(Outcome::Written);
    }
```

`classify`'s final `match` already sends `Occupied` to `Dropped` through `_`; leave it, and say so
in `Occupied`'s doc if you judge it needs saying. Update the module doc's four-things list with
one sentence for the re-homing.

- [ ] **Step 5: Run the tests**

Run: `pwsh -NoProfile -File <workspace>\cargo.ps1 test --lib sync_engine::`
Expected: all pass, the new ten included. Then `pwsh -NoProfile -File <workspace>\cargo.ps1 test --lib wishlist_folders:: collection_folders::`
(two filters: run twice if cargo takes one).

- [ ] **Step 6: Format and report**

`rustfmt --edition 2021` on `apply.rs`, `apply/rehome.rs`, `apply/tests.rs`, `wishlist_folders.rs`.
In the report, state that `rehome.rs` calls only every-target code (Review Focus 4). Do not commit.

---

### Task C: `gone` reads the tombstones, and the moot delete reaches folders

**Files:**
- Modify: `src-tauri/src/sync_engine/apply.rs` (`gone`, `cascade_onto_the_row_here`, `write_group`'s gone arm, `is_a_parent`, the module doc)
- Test: `src-tauri/src/sync_engine/apply/tests.rs`

**Interfaces:**
- Consumes: the `sync_gone` table and its triggers (Task A); `rehome::{doomed, collides, rehome}`
  and `Attempt` (Task B).
- Produces: `fn cascade_onto_the_row_here(conn, meta, g, p, attempt: Attempt) -> Result<Option<Why>, String>`
  — `Some(Why::Occupied)` on a first-attempt collision, `None` otherwise.

- [ ] **Step 1: Extend #574's two tests and write the new ones**

In `a_deck_filed_into_a_folder_moved_under_one_this_device_deleted_survives_on_both`: before the
line `let rb = apply(&b, &since(&a, &mut ma)).unwrap();`, have `b` — which deleted `Shelf` and has
not yet heard of the move — file a second deck `E` into `Box`:

```rust
    b.execute(
        "INSERT INTO decks (name, format_key, folder_id, created_at, updated_at)
         VALUES ('E', 'commander', (SELECT id FROM deck_folders WHERE name = 'Box'),
                 unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
```

and after the existing loop add:

```rust
    for (who, c) in [("a", &a), ("b", &b)] {
        let (folders, filed): (i64, i64) = c
            .query_row(
                "SELECT (SELECT count(*) FROM deck_folders),
                        (SELECT count(*) FROM decks WHERE folder_id IS NOT NULL)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((folders, filed), (0, 0), "{who} kept a folder or a filed deck");
        let decks: i64 = c.query_row("SELECT count(*) FROM decks", [], |r| r.get(0)).unwrap();
        assert_eq!(decks, 2, "{who} lost a deck");
    }
```

Rewrite the test's doc comment: `Box` now goes on both devices, and both decks land at the root on
both. Do the same for `a_copy_filed_into_a_binder_moved_under_one_this_device_deleted_survives_on_both`
(the deleting device files a second copy into the moved binder before hearing; after the exchange
neither device holds either binder, and every copy is at the root on both — read its current body
and mirror the change).

New tests:

```rust
/// **A third device's delete, applied on an earlier pull, is seen by a later child.** `c`
/// deletes a binder; `b` applies that on one pull; `a`'s copy filed into the binder reaches `b`
/// on the next. It lands at the root at once — no hold, no `error_log` row — where it used to
/// wait out the bound and be dropped while `a` kept it (spec §1.2).
///
/// **What makes it red**: `gone` reading this device's own `sync_ops` only.
#[test]
fn a_copy_filed_into_a_binder_a_third_device_deleted_lands_at_the_root() {
    let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
    let mut mc = 0;
    let bin = binder(&c, "Binder", None);
    let page = since(&c, &mut mc);
    apply(&a, &page).unwrap();
    apply(&b, &page).unwrap();

    crate::collection_folders::delete_folder(&c, bin).unwrap();
    apply(&b, &since(&c, &mut mc)).unwrap();

    let mut ma = 0;
    let _ = since(&a, &mut ma);
    let a_bin: i64 = a
        .query_row("SELECT id FROM collection_folders WHERE name = 'Binder'", [], |r| r.get(0))
        .unwrap();
    file_copies(&a, Some(a_bin), 1);
    let rb = apply(&b, &since(&a, &mut ma)).unwrap();

    assert_eq!((rb.held_waiting, rb.dropped), (0, 0), "{rb:?}");
    assert_eq!(qty(&b), (1, 1));
    let at_root: i64 = b
        .query_row(
            "SELECT count(*) FROM collection_entries WHERE folder_id IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(at_root, 1);
    assert!(skips(&b).is_empty(), "{:?}", skips(&b));
}

/// **`gone` answers from the tombstones alone**: a parent with a row there and no `del` in
/// this device's own history is gone.
#[test]
fn gone_answers_from_the_tombstone_table() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, _mb) = (0, 0);
    let bin = binder(&a, "Binder", None);
    let uid: String = a
        .query_row("SELECT sync_uid FROM collection_folders WHERE id = ?1", [bin], |r| r.get(0))
        .unwrap();
    file_copies(&a, Some(bin), 1);
    // `b` never heard of the binder; only a tombstone says it went.
    b.execute(
        "INSERT INTO sync_gone (tbl, uid) VALUES ('collection_folders', ?1)",
        [&uid],
    )
    .unwrap();
    let page: Vec<Op> = since(&a, &mut ma)
        .into_iter()
        .filter(|op| op.table != "collection_folders")
        .collect();
    let rb = apply(&b, &page).unwrap();
    assert_eq!((rb.held_waiting, rb.dropped), (0, 0), "{rb:?}");
    assert_eq!(qty(&b), (1, 1));
}
```

(The `binder`, `file_copies` and `qty` helpers are Task B's and `apply/tests.rs`'s.)

- [ ] **Step 2: Run them to see them fail**

Run: `pwsh -NoProfile -File <workspace>\cargo.ps1 test --lib sync_engine::apply::tests::`
Expected: the two extended tests fail on the new assertions (`Box`/`Inner` still on the deleting
device), the third-device test on `held_waiting` = 1, and the tombstone test the same way.

- [ ] **Step 3: `gone` reads `sync_gone`**

```rust
/// Whether a parent this database cannot find was deleted: in this page, or anywhere a delete
/// has ever reached this device — the reader's own, a peer's applied here, and every row a
/// cascade took with either, which is what `sync_gone` records (spec 2026-09-27 §3.1).
///
/// A delete applied before the v53 rung left no row there, and is still read as missing.
fn gone(
    conn: &Connection,
    table: &str,
    uid: &str,
    deleted: &BTreeSet<(&str, &str)>,
) -> Result<bool, String> {
    if deleted.contains(&(table, uid)) {
        return Ok(true);
    }
    conn.query_row(
        "SELECT 1 FROM sync_gone WHERE tbl = ?1 AND uid = ?2",
        [table, uid],
        |_| Ok(()),
    )
    .optional()
    .map(|hit| hit.is_some())
    .map_err(|e| e.to_string())
}
```

- [ ] **Step 4: The moot delete reaches folders, and re-homes**

`cascade_onto_the_row_here(conn, meta, g, p, attempt)` — drop the `is_a_parent` early return;
after the placement check:

```rust
    let doomed = rehome::doomed(conn, meta.table, uid)?;
    if attempt == Attempt::First && rehome::collides(conn, &doomed)? {
        return Ok(Some(Why::Occupied));
    }
    conn.execute_batch("SAVEPOINT sync_moot_row")
        .map_err(|e| e.to_string())?;
    let done = rehome::rehome(conn, &doomed).and_then(|()| {
        conn.execute(
            &format!("DELETE FROM {} WHERE sync_uid = ?1", meta.table),
            [uid],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    });
    let end = match done {
        Ok(()) => "RELEASE sync_moot_row",
        Err(_) => "ROLLBACK TO sync_moot_row; RELEASE sync_moot_row",
    };
    conn.execute_batch(end).map_err(|e| e.to_string())?;
    Ok(None)
```

(early returns before this answer `Ok(None)`). In `write_group`'s gone arm:

```rust
                if cascades(conn, meta.table, p)? {
                    if let Some(why) = cascade_onto_the_row_here(conn, meta, g, p, attempt)? {
                        return Ok(Outcome::Deferred(why));
                    }
                    return Ok(Outcome::Deferred(Why::UnknownParent {
                        table: p.table,
                        uid,
                    }));
                }
```

Delete `is_a_parent` if nothing calls it any more (`clippy -D warnings` refuses dead code).
Rewrite `cascade_onto_the_row_here`'s doc: the "Not for a table any capture spec names as a
parent" paragraph becomes the record of why it once was and why the tombstones end that (spec
§3.2), and the re-homing sentence. Update the module doc's table row and the paragraph after it
(`A folder moot here is consumed and left standing` is no longer true), and `gone`'s neighbours'
docs that mention "no tombstone table".

- [ ] **Step 5: Run the tests**

Run: `pwsh -NoProfile -File <workspace>\cargo.ps1 test --lib sync_engine::`
Expected: all pass. Then `pwsh -NoProfile -File <workspace>\cargo.ps1 test --lib` (the whole lib,
once) — expect every test to pass; a failure outside `sync_engine` that names schema or ingest code
is the concurrent-run trap (`Get-Process cargo,rustc`), not this change.

- [ ] **Step 6: Format and report**

`rustfmt --edition 2021` on `apply.rs` and `apply/tests.rs`. Do not commit.

---

### Task D: The record

**Files:**
- Modify: `docs/reference/sync.md`
- Modify: `docs/reference/data-and-sync.md`
- Modify: `src-tauri/CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-09-26-token-stacks-design.md`

**Interfaces:** none — prose, written from the spec, which is the authority. Do not state a count
a build answers (the repo rule); name the grep instead.

- [ ] **Step 1: `sync.md`**
  - *Held while it can resolve, skipped when it cannot*: the classification table's moot row loses
    "(never a folder)" and says the row goes where it stands, a folder included; `gone` reads
    `sync_gone` (a delete in this page, or any delete that ever reached this device, own, applied or
    cascaded). The bullet beginning **"Never for a table another table's spec names as a parent"**
    and the ⚠️ **"That is a lasting loss"** paragraph become the record of what was, and the fix
    (tombstones, spec 2026-09-27) with its tests' names:
    `a_deck_filed_into_a_folder_moved_under_one_this_device_deleted_survives_on_both`,
    `a_copy_filed_into_a_binder_a_third_device_deleted_lands_at_the_root`.
  - A new short subsection, after that table's bullets: **A delete that would drop two rows onto one
    grain waits, then merges** — spec §3.3 in this document's voice, with the three cascades, why
    the retry and not at once, why only on a collision, why the lower uid, and the backstop; name
    `a_binder_deleted_with_a_copy_the_root_also_holds_lands_on_the_peer` and
    `a_folder_delete_this_database_refuses_is_dropped_and_the_page_applies`.
  - *A parent deleted on a third device, and applied here on an earlier pull, leaves no trace*:
    closed — say what closed it and from which build; deletes applied before v53 still leave none.
  - *What is still owed*: remove the two folder bullets (the stall, the moved folder); add spec
    §3.5's three residuals, each with "read off the code and unmeasured".
- [ ] **Step 2: `data-and-sync.md`** — the user ladder gains v53 (`sync_gone`, one `WITHOUT ROWID`
  table, the backfill from own `del`s), in the ladder's own format.
- [ ] **Step 3: `src-tauri/CLAUDE.md`**
  - The `sync_peers is a watermark` bullet: the moot clause "— and a row this device holds under
    its uid is deleted, as the sender's cascade takes it, where the fold says the group's placement
    stands and no capture spec names its table as a parent (…)" loses the "no capture spec names its
    table as a parent" condition and gains that `gone` reads `sync_gone`; one sentence for the
    colliding delete (waits for the retry, then re-homes, lower uid kept, never `?`).
  - The rung history in "A new migration step goes at the bottom": one sentence for v53 in the
    existing voice (a tombstone table, `WITHOUT ROWID`, not synced, backfilled from own `del` ops).
  - The "Seventeen tables sync" bullet's list of sites a new user table owes stays as it is; check
    that `sync_gone` needed none it does not name, and add what was missing if it did.
- [ ] **Step 4: the token-stacks spec** — under §5's heading, one line: PR 3 (Collection tokens)
  was dropped on 2026-09-27 by the reader's decision, and user schema v53 went to `sync_gone`
  (folder deletes across devices).
- [ ] **Step 5: Report.** No build step; do not commit.
