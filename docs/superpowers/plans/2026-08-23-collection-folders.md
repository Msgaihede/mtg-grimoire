# Collection Folders — Implementation Plan (PR 2 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the collection a nested folder tree — schema, commands, page and card-menu targets — plus the three duplicate/quantity fixes the folder makes urgent. **Closes [#215](https://github.com/Msgaihede/mtg-grimoire/issues/215).**

**Architecture:** The wishlist shipped exactly this at schema v23 and every piece is reusable: `wishlist_folders.rs` is the command template, `src/lib/folderTree.ts` is already generic, `wishDrag.ts` is the drag template, and `buildWishlistTargetItems` is the menu template. **This plan is largely a port, and where it deviates from that precedent the deviation is stated and justified.** The one genuinely new thing is the eleventh grain term and the merge rule it forces.

**Tech Stack:** Rust (rusqlite/SQLite, Tauri 2.11), React 19 + TypeScript 6, Vitest, Storybook.

**Spec:** `docs/superpowers/specs/2026-08-23-collection-folders-design.md` — §3, §7.1, §8 are this plan. §1 is why.

**Base:** `origin/main` at `02d5b51`, which contains PR 1 (#216, deck-driven removed). Branch `worktree-collection-folders`.

## Global Constraints

- **`SCHEMA_VERSION` goes 23 → 24, and this rung creates the folder table but files nothing into it.** See the ruling below on why the rung is split.
- **`deck_allocations`, `decks.is_built` and the orphaned `app_meta` row `deck_driven_collection` all survive this PR.** They are PR 3's, and the allocator must keep working unchanged throughout.
- **The DDL is spelled out literally and never interpolated from `COLLECTION_GRAIN`.** A migration step is history: a step that read the constant would silently rewrite what a *fresh* install creates the next time the grain moves, while every already-upgraded database kept the old shape. The v4, v8 and v23 steps all state this rule.
- **`idx_collection_grain` is DROPped and re-CREATEd, never added to.** SQLite has no `ALTER INDEX`, and the `DROP` has to come first or the `CREATE` is a silent no-op on exactly the machines that already carry the ten-column index.
- **`ALTER TABLE … ADD COLUMN` has no `IF NOT EXISTS`.** Probe `pragma_table_info('collection_entries')` first — a rewind fixture cannot drop `folder_id`, because SQLite refuses `DROP COLUMN` on a column an index names and this one is the grain's eleventh term.
- Never install `@types/node`. Never rename files — and **do not create a second `folderTree.ts`**: a case-insensitive filesystem makes that unsafe next to `FolderTree.tsx` (`src/features/decks/folders.ts:17-30`).
- **Never run two `npm run verify` at once** — concurrent runs fake ~18 Rust schema failures.
- `npm run verify` does **not** run `cargo fmt --check` or `cargo clippy`; both gate CI. **And a background `npm run verify` gets killed mid-vitest** — shard it (`npx vitest run --shard=N/3`) in the foreground. `--reporter=basic` does not exist in vitest 4.
- Conventional commits. **Subagents do not commit** — parallel agents share one git index here.

## Ruling: the v24 rung is split, deviating from spec §3

Spec §3 lists one rung doing everything: create the folder table, add the grain term, create the `Recently removed` folder and every deck group, convert `deck_allocations` into placements, and drop `deck_allocations` and `is_built`. **That rung cannot ship in PR 2**, because PR 2 keeps the allocator working and PR 3 is what removes it. A rung that dropped `deck_allocations` here would break the allocator that is still the app's only source of owned/missing.

So the schema work splits along the same seam the PRs do:

| Rung | PR | Does |
| --- | --- | --- |
| **v24** | 2 (this plan) | Creates `collection_folders` **with its full final shape**, including the `kind` and `deck_id` columns and both partial indexes. Adds `collection_entries.folder_id`. Rebuilds the grain index with the eleventh term. Deletes zero-quantity rows. **Files nothing** — every existing row stays at the root, which is where it already was. |
| **v25** | 3 | Inserts the single `removed` folder and one `deck` folder per deck, converts every `deck_allocations` row into a placement, then drops `deck_allocations`, `decks.is_built` and the orphaned `app_meta` row. |

Creating the `kind` and `deck_id` columns in v24 rather than v25 is deliberate: they are plain columns with no rows using them yet, and adding them now means **v25 needs no `ALTER TABLE` at all** — it only inserts, backfills and drops. Both partial indexes are created in v24 for the same reason.

*Cost if this ruling is wrong:* v24 ships two columns and two indexes that nothing writes for one release. That is invisible to the reader and cheap to carry.

## Two more deviations from the spec, both deliberate

**1. The card menu's folder targets (spec §7.3) land here, not in PR 4.** Spec §12 groups §7.3 with the deck builder. But #215 asks in its own words for "Right click > add to > Collection should support the nested groups" and "Right click > move to > folder should work on cards in the collection" — those are folder features, and a PR that closes #215 without them closes it falsely. PR 4 keeps the deck-builder tabs (§7.2) and the import toggle (§7.4). *Cost if wrong:* PR 2 is one bucket larger and PR 4 one smaller.

**2. `CollectionRow.condition` narrowing is fan-in work, not a bucket's.** PR 1's review left the field typed `Option<String>` / `string | null` over a `TEXT NOT NULL DEFAULT 'NM'` column. Narrowing it touches Rust, `ipc.ts` and three call sites across **three different buckets**, and parallel agents cannot coordinate a change that spans them. The controller does it at fan-in, in one edit, with the dead `condition === null` branches at `CollectionTable.tsx:58,190` and `.test.tsx:125`.

## Test fixtures the implementers must write

The test bodies below call helpers that **do not exist yet** — write them alongside, following the fixture style already in each file:

| Helper | In | Does |
| --- | --- | --- |
| `open()` | `collection_folders.rs` | in-memory conn, `migrate`d |
| `insert_entry(conn, card, folder, qty) -> i64` | `collection_folders.rs` | one row, returns its id |
| `insert_system_folder(conn, kind, name) -> i64` | `collection_folders.rs` | writes a `deck`/`removed` row directly, since no command creates one in this PR |
| `schema_at_23(conn)` | `schema.rs` | **the awkward one.** Migrate fully, then rewind: drop `collection_folders`, drop and re-create `idx_collection_grain` with the ten-column list, and set `user_version` to 23. It **cannot** drop `folder_id` — SQLite refuses `DROP COLUMN` on a column an index names — which is exactly why the rung probes `pragma_table_info` instead of blindly `ALTER`ing. Model it on v23's own rewind fixture. |
| `add`, `mk_folder`, `mk_deck`, `add_in`, `query`, `d()` | `collection.rs` | thin wrappers over the existing test helpers in that file |

## File Structure

Six buckets. **No two share a file.** Tasks 1–2 are the foundation and must land before 3–6; within each group the buckets are file-disjoint and run in parallel.

| Bucket | Files |
| --- | --- |
| **A — Schema** (first, alone) | `src-tauri/src/schema.rs` |
| **B — Folder commands** | `src-tauri/src/collection_folders.rs` (new), `src-tauri/src/lib.rs` |
| **C — Collection writes** | `src-tauri/src/collection.rs`, `src-tauri/src/reset.rs` |
| **D — Page UI** | `src/features/collection/*` (new folder card, breadcrumb, drag, hook; existing page and filter bar) |
| **E — Card menu + ipc** | `src/lib/ipc.ts`, `src/features/card/cardMenu.tsx`, `useCardMenuDeps.ts` |
| **F — Importer fold + fake** | `src/features/transfer/import/destinations/collection.ts`, `.storybook/fake/db.ts`, `seeds.ts` |

---

### Task 1: Bucket A — schema v24

**Files:** Modify `src-tauri/src/schema.rs`

**Interfaces — Produces.** Every later task codes against these exact names:
```rust
pub const SCHEMA_VERSION: i64 = 24;
pub const COLLECTION_GRAIN: &str = "card_id, finish, condition, lang, altered, signed, \
     proxy, misprint, coalesce(serial_number, ''), coalesce(grading, ''), \
     coalesce(folder_id, 0)";
pub const COLLECTION_FOLDER_KINDS: [&str; 3] = ["user", "deck", "removed"];
```
Table `collection_folders(id, parent_id, name, kind, deck_id, sort_order, created_at, updated_at)`; column `collection_entries.folder_id`.

- [ ] **Step 1: Write the failing test first**

Add to `schema.rs`'s `#[cfg(test)]` module. This asserts the rung exists before it does:

```rust
#[test]
fn v24_adds_collection_folders_and_the_folder_term() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION, "the rung must reach the constant");

    // The table exists with both partial indexes.
    let cols: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('collection_folders')")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for want in ["id", "parent_id", "name", "kind", "deck_id", "sort_order"] {
        assert!(cols.iter().any(|c| c == want), "missing column {want}");
    }

    // `folder_id` is the grain's eleventh term, and the index says so.
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name = 'idx_collection_grain'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        sql.contains("coalesce(folder_id, 0)"),
        "the grain index was not rebuilt with the folder term: {sql}"
    );
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd src-tauri && cargo test v24_adds_collection_folders_and_the_folder_term 2>&1 | tail -20`
Expected: FAIL — `assert_eq!(version, SCHEMA_VERSION)` mismatches, or the table query errors. **Report the number of tests selected**; a filter matching nothing exits 0 and proves nothing.

- [ ] **Step 3: Write the rung**

Bump `SCHEMA_VERSION` to 24, add the eleventh grain term to `COLLECTION_GRAIN`, and add the step. **Spelled out literally, never interpolated:**

```rust
// --- v24: the collection's folders -------------------------------------------------
//
// The wishlist's v23 rung, one table over, with two columns it did not need. Nothing is
// filed by this step: every existing row keeps `folder_id` NULL, NULL is the root, and the
// root is the list the reader already sees — so an upgrade is invisible until they make
// their first folder. The unset value is not a lie a DEFAULT is telling; it is the answer.
if version < 24 {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS collection_folders (
             id INTEGER PRIMARY KEY,
             parent_id INTEGER REFERENCES collection_folders(id) ON DELETE CASCADE,
             name TEXT NOT NULL,
             kind TEXT NOT NULL DEFAULT 'user'
                 CHECK (kind IN ('user','deck','removed')),
             deck_id INTEGER REFERENCES decks(id) ON DELETE CASCADE,
             sort_order INTEGER NOT NULL,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL,
             CHECK ((kind = 'deck') = (deck_id IS NOT NULL))
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_folder_removed
             ON collection_folders(kind) WHERE kind = 'removed';
         CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_folder_deck
             ON collection_folders(deck_id) WHERE deck_id IS NOT NULL;",
    )
    .map_err(|e| e.to_string())?;

    // ADD COLUMN has no IF NOT EXISTS, and the rewind above cannot be complete: SQLite
    // refuses DROP COLUMN on a column an index names, and this one is the grain's
    // eleventh term. A blind ALTER would answer `duplicate column name` — a failure no
    // real upgrade can produce, which is the definition of a fixture lying about what it
    // is testing.
    let has_folder: i64 = conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('collection_entries')
              WHERE name = 'folder_id'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if has_folder == 0 {
        conn.execute(
            "ALTER TABLE collection_entries ADD COLUMN folder_id INTEGER
                 REFERENCES collection_folders(id) ON DELETE SET NULL",
            [],
        )
        .map_err(|e| e.to_string())?;
    }

    // DROP first: SQLite has no ALTER INDEX, and CREATE ... IF NOT EXISTS is a silent
    // no-op on exactly the machines that already carry the ten-column index.
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_collection_grain;
         CREATE UNIQUE INDEX idx_collection_grain ON collection_entries (
             card_id, finish, condition, lang, altered, signed, proxy, misprint,
             coalesce(serial_number, ''), coalesce(grading, ''), coalesce(folder_id, 0)
         );
         DELETE FROM collection_entries WHERE quantity = 0;",
    )
    .map_err(|e| e.to_string())?;

    conn.pragma_update(None, "user_version", 24)
        .map_err(|e| e.to_string())?;
}
```

Note the literal `24`, never `SCHEMA_VERSION` — this step is what *makes* a database version 24, and the constant moves again at v25.

- [ ] **Step 4: Run it and watch it pass**

Run: `cd src-tauri && cargo test v24_adds_collection_folders_and_the_folder_term 2>&1 | tail -20`
Expected: PASS, 1 test selected.

- [ ] **Step 5: Add the three rung tests that are easy to get wrong**

```rust
#[test]
fn the_v24_rung_is_idempotent_over_an_already_upgraded_database() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    migrate(&conn).unwrap(); // the second pass must be a no-op, not `duplicate column name`
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(version, SCHEMA_VERSION);
}

#[test]
fn the_folder_is_part_of_what_makes_two_collection_rows_the_same_row() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    conn.execute(
        "INSERT INTO collection_folders (name, kind, sort_order, created_at, updated_at)
         VALUES ('Binder', 'user', 0, 0, 0)",
        [],
    )
    .unwrap();
    let folder = conn.last_insert_rowid();
    let row = |folder: Option<i64>| {
        conn.execute(
            "INSERT INTO collection_entries
                 (card_id, set_code, collector_number, finish, condition, quantity, folder_id)
             VALUES ('c1', 'lea', '1', 'nonfoil', 'NM', 1, ?1)",
            params![folder],
        )
    };
    row(None).expect("the root row inserts");
    row(Some(folder))
        .expect("the SAME printing in a folder is a DIFFERENT row — this is the whole point");
    row(None).expect_err("but two root rows for one printing still collide");
}

#[test]
fn the_v24_rung_deletes_rows_that_hold_no_copies() {
    let conn = Connection::open_in_memory().unwrap();
    schema_at_23(&conn); // fixture helper: migrate, then rewind user_version to 23
    conn.execute(
        "INSERT INTO collection_entries
             (card_id, set_code, collector_number, finish, condition, quantity)
         VALUES ('gone', 'lea', '1', 'nonfoil', 'NM', 0)",
        [],
    )
    .unwrap();
    migrate(&conn).unwrap();
    let left: i64 = conn
        .query_row(
            "SELECT count(*) FROM collection_entries WHERE card_id = 'gone'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0, "a row holding no copies is not a row the reader owns");
}
```

**`coalesce(folder_id, 0)` can never collide with a real folder** because `collection_folders.id` is `INTEGER PRIMARY KEY` and SQLite never auto-assigns rowid 0. It is a `coalesce` for the grain's other two terms' reason: NULLs in a UNIQUE index are *distinct*, so an un-coalesced term would stop enforcing anything for exactly the rows that need it most — the ones at the root, where most cards live.

- [ ] **Step 6: Update both whole-schema inventories in the same edit**

`schema.rs`'s module doc carries the inventory of every `ON DELETE` action and every grain. Add `collection_folders.parent_id` (CASCADE) and `collection_entries.folder_id` (SET NULL), and the grain's new term. **A rung that adds one half of a filing cabinet and forgets the other is exactly what those inventories exist to catch**, since a prose-only edit routes to neither CI job.

- [ ] **Step 7: Verify and report**

Run: `cd src-tauri && cargo test 2>&1 | tail -20`, then `cargo fmt --all` and `cargo clippy --all-targets -- -D warnings`.
Expected: all pass. It was **1050 passing** before this task. Report the new selected count.

---

### Task 2: Bucket B — the folder commands

**Files:** Create `src-tauri/src/collection_folders.rs`; modify `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes — Task 1's `COLLECTION_GRAIN`, `collection_folders` table, `collection_entries.folder_id`.
- Produces — seven Tauri commands and the DTO the frontend types against:
```rust
#[derive(Debug, Serialize)] #[serde(rename_all = "camelCase")]
pub struct CollectionFolder { pub id: i64, pub parent_id: Option<i64>, pub name: String,
    pub kind: String, pub deck_id: Option<i64>, pub sort_order: i64 }

#[derive(Debug, Serialize)] #[serde(rename_all = "camelCase")]
pub struct CollectionFolderSummary { pub folder_id: i64, pub cards: i64, pub value: Option<f64> }
```
| Command | Pure fn |
| --- | --- |
| `collection_folder_list` | `list_folders(conn) -> Vec<CollectionFolder>` |
| `collection_folder_create` | `create_folder(conn, parent_id: Option<i64>, name: &str) -> CollectionFolder` |
| `collection_folder_rename` | `rename_folder(conn, id, name: &str) -> CollectionFolder` |
| `collection_folder_move` | `move_folder(conn, id, parent_id: Option<i64>) -> CollectionFolder` |
| `collection_folder_delete` | `delete_folder(conn, id) -> ()` |
| `collection_set_folder` | `set_entry_folder(conn, id, folder_id: Option<i64>) -> EntryChange` |
| `collection_folder_summary` | `folder_summary(conn, Marketplace) -> Vec<CollectionFolderSummary>` |

Also produces `pub(crate) fn refile_entry(conn, id, folder_id: Option<i64>) -> Result<EntryChange, String>`, which Bucket C calls.

**This file is a port of `src-tauri/src/wishlist_folders.rs`. Read that file first and follow it.** Every rule below is one it already states and tests.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_move_that_would_write_a_loop_is_refused_in_words() {
    let conn = open();
    let a = create_folder(&conn, None, "A").unwrap();
    let b = create_folder(&conn, Some(a.id), "B").unwrap();
    let err = move_folder(&conn, a.id, Some(b.id)).unwrap_err();
    assert_eq!(err, FOLDER_CYCLE);
}

#[test]
fn a_refile_onto_a_taken_grain_merges_and_answers_the_destination() {
    let conn = open();
    let binder = create_folder(&conn, None, "Binder").unwrap();
    let root = insert_entry(&conn, "bolt", None, 3);
    let filed = insert_entry(&conn, "bolt", Some(binder.id), 2);
    let change = refile_entry(&conn, root, Some(binder.id)).unwrap();
    assert_eq!(change.id, filed, "the answer names the DESTINATION, not the id handed in");
    assert_eq!(change.quantity, 5, "the quantities sum");
    assert!(!change.removed, "the cards are emphatically still owned");
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM collection_entries WHERE card_id = 'bolt'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1, "the source row is gone");
}

#[test]
fn deleting_a_folder_refiles_its_cards_to_the_root_one_at_a_time() {
    // Two rows in the doomed sub-tree that collide WITH EACH OTHER at the root.
    // One at a time is what makes them merge instead of raising UNIQUE constraint failed.
    let conn = open();
    let outer = create_folder(&conn, None, "Outer").unwrap();
    let inner = create_folder(&conn, Some(outer.id), "Inner").unwrap();
    insert_entry(&conn, "bolt", Some(outer.id), 1);
    insert_entry(&conn, "bolt", Some(inner.id), 1);
    delete_folder(&conn, outer.id).unwrap();
    let (rows, qty): (i64, i64) = conn
        .query_row(
            "SELECT count(*), coalesce(sum(quantity), 0) FROM collection_entries
              WHERE card_id = 'bolt' AND folder_id IS NULL",
            [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!((rows, qty), (1, 2), "two collided into one row of two copies");
}

#[test]
fn a_deck_or_removed_folder_refuses_to_be_renamed_moved_or_deleted_by_hand() {
    let conn = open();
    let sys = insert_system_folder(&conn, "removed", "Recently removed");
    assert_eq!(rename_folder(&conn, sys, "Junk").unwrap_err(), FOLDER_NOT_YOURS);
    assert_eq!(move_folder(&conn, sys, None).unwrap_err(), FOLDER_NOT_YOURS);
    assert_eq!(delete_folder(&conn, sys).unwrap_err(), FOLDER_NOT_YOURS);
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd src-tauri && cargo test collection_folders 2>&1 | tail -20`
Expected: FAIL — the module does not exist. Report the selected count.

- [ ] **Step 3: Write the module**

Port `wishlist_folders.rs`. **`refile_entry` is `refile_wish`'s exact shape** and is the load-bearing function:

1. `SELECT` the source row's ten grain columns and its quantity **in one statement**, which also answers "is it still there?" — an `UPDATE` changing 0 rows cannot tell a missing row from a collision.
2. Probe the grain it is about to land on, **spelled out in SQL rather than interpolated from `COLLECTION_GRAIN`**, all eleven terms, `id <> ?source`. That constant is a list of expressions over *one row*; this compares the same list against bound values. A fold matching ten of the eleven would merge a row into another folder — precisely the bug the eleventh term exists to make impossible.
3. **Hit** → sum the quantities into the destination, take the destination's notes falling back to the source's (`add_entry`'s own `ON CONFLICT` direction — the destination is the row the reader filed and annotated, and inverting the coalesce would silently replace their own note), delete the source, and answer an `EntryChange` whose `id` is the **destination's**.
4. **Miss** → a plain `UPDATE … SET folder_id = ?2`, with NULL bound as a *value* rather than `coalesce(?2, folder_id)`, so "back to the root" is expressible at all.

`delete_folder` collects the doomed sub-tree with a recursive CTE and calls `refile_entry(&tx, row, None)` **one row at a time** — that ordering is the whole of why two colliding rows merge. One transaction throughout.

The three refusals are validated **in words**, not left to the foreign key: a constraint failure names the table and not the mistake, and `PRAGMA foreign_keys` is per-connection anyway. Reuse `FOLDER_GONE` and `FOLDER_CYCLE` from `deck_meta`; add a local `FOLDER_NOT_YOURS` for the `kind <> 'user'` refusals. The cycle walk climbs `parent_id` from the **proposed** parent, bounded at `MAX_FOLDER_DEPTH` (64), so a loop it did not write terminates rather than hanging.

**`folder_summary` answers direct counts, never recursive** — `buildFolderTree` already sums children on the TS side, and two implementations of one figure disagree the first time either changes. **An empty folder produces no row at all** (`WHERE folder_id IS NOT NULL … GROUP BY folder_id`), so a page cannot build its tree from this command: `collection_folder_list` is the census and this is a lookup layered onto it.

Writes go through `sync::with_write`; **`collection_set_folder` goes through `collection_source::with_write_owned`** — moving a row between folders changes which rows exist, and the search index's `owned` dimension counts rows. Reads use `lock_db_read`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd src-tauri && cargo test collection_folders 2>&1 | tail -20`
Expected: PASS. Report the selected count.

- [ ] **Step 5: Register the commands and verify**

Add `pub mod collection_folders;` and the seven entries to `tauri::generate_handler!` in `lib.rs`. Then `cargo test`, `cargo fmt --all`, `cargo clippy --all-targets -- -D warnings`.

---

### Task 3: Bucket C — the collection's own writes

**Files:** Modify `src-tauri/src/collection.rs`, `src-tauri/src/reset.rs`

**Interfaces:**
- Consumes — Task 1's grain, Task 2's `refile_entry`.
- Produces — `CollectionQuery` gains two fields, which Buckets D and E type against:
```rust
pub folder_id: Option<i64>,          // None = every folder
pub allocation: Option<Allocation>,  // All | Unallocated
#[derive(Debug, Deserialize)] #[serde(rename_all = "camelCase")]
pub enum Allocation { All, Unallocated }
```
Both default to today's behaviour (everything), so **every existing caller is unchanged.**

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn an_edit_onto_a_taken_grain_merges_instead_of_refusing() {
    // Before this change `update_entry` answered "You already have an entry for that
    // printing at that finish and condition" and gave up. With a folder in the grain,
    // every move into an occupied folder would hit that refusal.
    let conn = open();
    let a = add(&conn, "bolt", "NM", 2);
    let b = add(&conn, "bolt", "LP", 1);
    let change = update_entry(&conn, b, &EntryPatch { condition: Some("NM".into()), ..d() }).unwrap();
    assert_eq!(change.id, a, "the answer names the surviving row");
    assert_eq!(change.quantity, 3);
}

#[test]
fn a_quantity_taken_to_zero_removes_the_row() {
    let conn = open();
    let id = add(&conn, "bolt", "NM", 1);
    let change = set_quantity(&conn, id, 0).unwrap();
    assert!(change.removed, "no copies means the reader does not own it");
    let left: i64 = conn
        .query_row("SELECT count(*) FROM collection_entries WHERE id = ?1", params![id], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0);
}

#[test]
fn unallocated_excludes_only_deck_folders() {
    // Root, a user folder and `Recently removed` are all cards on the reader's desk.
    let conn = open();
    let user = mk_folder(&conn, "user", None);
    let removed = mk_folder(&conn, "removed", None);
    let deck = mk_folder(&conn, "deck", Some(mk_deck(&conn)));
    add_in(&conn, "a", None); add_in(&conn, "b", Some(user));
    add_in(&conn, "c", Some(removed)); add_in(&conn, "d", Some(deck));
    let page = list_entries(&conn, &query(Allocation::Unallocated)).unwrap();
    let ids: Vec<&str> = page.items.iter().map(|r| r.card_id.as_str()).collect();
    assert_eq!(ids, vec!["a", "b", "c"], "only the deck folder's copies are spoken for");
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd src-tauri && cargo test --lib collection:: 2>&1 | tail -20`. Report the selected count.

- [ ] **Step 3: Implement**

- `update_entry` stops calling `friendly()` on a grain collision and calls `refile_entry`'s merge path instead. **Delete the `friendly()` collision branch and its message** — it is now unreachable, and a message for an impossible state is the half-deleted rule the repo warns about.
- `set_quantity(id, 0)` deletes the row and answers `EntryChange { removed: true }`. `commit_import`'s `set` mode does the same.
- **Replace** the test `a_row_emptied_to_zero_still_lists_and_is_still_a_printing_the_collection_knows` and the three "tidy-ups" its doc warns against with a test asserting the new rule. Do not delete it quietly — it documented a deliberate decision that has now been reversed, and the reversal deserves the same weight. **Record in its doc what the reversal costs**: the row's condition, `condition_original`, purchase price, acquired-at, acquisition source, notes and tags go with it, which is exactly what the old behaviour was preserving.
- `list_entries` and `summarise` take the two new query fields. `Unallocated` is `folder_id IS NULL OR (SELECT kind FROM collection_folders f WHERE f.id = folder_id) <> 'deck'`.
- `CollectionRow` gains `folder_id` and `folder_name`.
- **Do NOT narrow `CollectionRow.condition` here.** It is carried from PR 1's review and spans three buckets, so the controller does it at fan-in — see the deviations section above. Leave the type as it is.
- `reset::clear_collection` empties `collection_entries` **and then** `collection_folders`, needing the second statement rather than getting it by cascade: `folder_id` is SET NULL, so a wipe that stopped at the entries would hand the reader an empty filing cabinet to take apart one drawer at a time. The reported count stays the count of **cards**.

- [ ] **Step 4: Run and watch them pass**

Run: `cd src-tauri && cargo test 2>&1 | tail -20`, then `cargo fmt --all` and `cargo clippy --all-targets -- -D warnings`. Report the selected count.

---

### Task 4: Bucket D — the collection page

**Files:** Create `src/features/collection/CollectionFolderCard.tsx`, `CollectionBreadcrumb.tsx`, `collectionDrag.ts`, `useCollectionFolders.ts` (+ tests and stories). Modify `CollectionPage.tsx`, `CollectionFilterBar.tsx`, `CollectionTable.tsx`, `useCollection.ts`.

**Interfaces:** Consumes Task 2's seven commands and Task 3's `CollectionRow.folderId`/`folderName` and query fields, via Bucket E's ipc wrappers.

**This is a port of the wishlist's folder UI.** Read `WishlistPage.tsx`, `WishFolderCard.tsx`, `WishlistBreadcrumb.tsx` and `wishDrag.ts` and follow them.

- [ ] **Step 1: Reuse `src/lib/folderTree.ts` unchanged**

It is already fully generic: a `CollectionFolder` answers `FolderLike` (`id, parentId, name, sortOrder`) and a `CollectionRow` answers `Filed` (`folderId`). **Do not copy it, do not fork it, and above all do not create a second file called `folderTree.ts`** — a case-insensitive filesystem resolves it against `FolderTree.tsx` and `tsc` stays green while every test fails with "not a function".

- [ ] **Step 2: The drag payload uses its OWN key**

```ts
// src/features/collection/collectionDrag.ts
const COLLECTION_MARK = "mtg-grimoire/collection-file-drag";
const MARK_KEY = "collectionSource";   // NOT dnd.ts's `dragSource`
```
A collection row genuinely is both things — a card you can put in a deck, and a row you can file — and both must keep working from one tile. Sharing `dragSource` would force this module's mark onto the card payload and one of the two readers would be lied to. Read the three fields one by one rather than casting: this is the app's edge with the drag library's untyped store, and "it type-checked" means nothing there.

Put `folderId` on the payload so a target can refuse **before** the drop: the folder a row already sits in draws no ring at all, rather than a ring leading to a write that moves nothing and bumps `updated_at`.

- [ ] **Step 3: Folder cards, breadcrumb, and the pinned sections**

Folder cards in the grid; **breadcrumb segments are drop targets too** — without them a drag could only ever push cards deeper, never back out. `DROP_RING` on every eligible folder the moment the row leaves its tile, `DROP_OVER` on the one under the pointer, and `DROP_MARK_ROOM` on the wall's scroller or a card flush against the content edge loses the outer 2px of its ring for the whole drag.

Deck groups and `Recently removed` render as a **separate pinned section**, flat, with no rename or delete affordance. In this PR that section is **always empty** — v25 is what creates those folders — so it renders nothing at all rather than an empty heading.

- [ ] **Step 4: Do NOT be optimistic about a folder move**

The wishlist shipped with a bug worth not repeating: `setFolder` removed the row optimistically from every cached list page and then invalidated only the summary and the card search, so **nothing ever put it back where it went** — the folder card read `1 wish` while the folder's own contents read `Nothing filed here yet`, with the row in the database the whole time. It reproduced on all three routes and cleared only on reload.

A folder move is one deliberate press, not a held stepper, and an optimistic insert would have to guess the destination's sort position and page. **Invalidate and re-read.** Note `src/lib/query.ts` caches 30 s, so a mounted query that is merely *marked* stale never refetches — invalidate the list itself, not only its root.

- [ ] **Step 5: `CollectionTable`'s folder column**

The column `DeckCountCell` vacated in PR 1 becomes the row's **folder name** — one value from the row, not a hover query. Rows at the root read `—`.

- [ ] **Step 6: Verify**

Run: `npx vitest run src/features/collection 2>&1 | tail -20`. Report file and test counts — a path matching nothing passes vacuously. Do not run story plays; they collect the whole tree and are the controller's at fan-in.

---

### Task 5: Bucket E — ipc and the card menu

**Files:** Modify `src/lib/ipc.ts`, `src/features/card/cardMenu.tsx`, `src/features/card/useCardMenuDeps.ts` (+ tests).

**Interfaces:** Consumes Task 2's commands and DTOs, Task 3's query fields.

- [ ] **Step 1: ipc wrappers and types**

Add the seven wrappers and the `CollectionFolder` / `CollectionFolderSummary` types, mirroring the wishlist folder wrappers exactly. Add `folderId`/`folderName` to `CollectionRow` and the two query fields. **Do not touch `CollectionRow.condition`** — narrowing it spans three buckets and is the controller's at fan-in.

- [ ] **Step 2: `buildCollectionTargetItems`**

Mirror `buildWishlistTargetItems` (`cardMenu.tsx:809-826`) including **both** of its rules, which differ from the deck picker's:
- **Root first and never omitted**, then a separator.
- **A leaf folder is a plain `action`; a folder with children is a `submenu` whose first item is itself** (`{...here, id: '…-here'}`, separator, then the children). So a parent folder is always pickable.
- **Empty folders are kept** — the opposite of `deckLevel`, which drops a folder with no deck under it. An empty drawer is where the next card goes.

**Deck groups and `Recently removed` are NOT offered as targets** — copies reach those only through PR 3's two writes. Filter on `kind === "user"`.

The existing finish branch composes *above* this: a card with two finishes picks finish, then folder.

- [ ] **Step 3: `Move to → folder` for collection rows**

Calls `collection_set_folder`. Follow `EditWish.tsx:190-234`'s precedent — the shared `MoveToFolder.tsx` picker is a list of buttons rather than `MenuItem[]`, so the context-menu version builds items the way Step 2 does while a popover version reuses the picker. **A drag-only affordance is half a feature, and it is the half a keyboard cannot use.**

- [ ] **Step 4: `CardMenuDeps` gains `collectionFolders`**

Filled once per page mount by a list-only hook — the wishlist's shape, which is why its submenu is eager while the deck picker is `lazy`.

- [ ] **Step 5: Verify**

Run: `npx vitest run src/features/card src/lib 2>&1 | tail -20`. Report file and test counts.

Testing note: a greyed menu row's accessible name includes its reason, so `getByRole("menuitem", {name: "Exact Label"})` fails on a disabled row and reads as "the row is missing". Use a regex where a row can be disabled.

---

### Task 6: Bucket F — the importer's fold, and the fake

**Files:** Modify `src/features/transfer/import/destinations/collection.ts`, `.storybook/fake/db.ts`, `.storybook/fake/seeds.ts`.

- [ ] **Step 1: Write the failing test for the fold**

```ts
it("does not write a second all-defaults row beside an altered copy", () => {
  // destinations/collection.ts:94 folded on (cardId, finish, condition) while the real
  // grain is eleven columns, and commit_import hard-coded altered/signed/proxy/misprint/
  // serial/grading to defaults — so a re-import could never land on the reader's altered
  // row. import-export.md:225-262 called this latent; PR 4's import toggle makes it live.
  const plan = planCollectionImport(list, resolved, options);
  expect(plan.items.filter((i) => i.cardId === "bolt")).toHaveLength(1);
});
```

- [ ] **Step 2: Run it and watch it fail**, then widen the fold key to the full grain and carry the six columns through the commit rather than defaulting them. Re-run and watch it pass.

- [ ] **Step 3: Teach the fake the folder commands**

Seven new commands and a `folder_id` on its collection rows. **Re-count anything the fake's tests count in the same edit** — `.storybook/fake/db.test.ts` carries a method-count sweep with an archaeology comment recording every move (it went 60 → 59 in PR 1). Adding seven commands moves it again; record the move.

`grep` calls some files binary on a stray NUL and then reports "no matches" as a lie. `.storybook/fake/db.ts` has done this before — if a grep comes back empty there, confirm with `git grep`.

- [ ] **Step 4: Verify**

Run: `npx vitest run src/features/transfer .storybook 2>&1 | tail -20`. Report file and test counts.

---

### Task 7: Fan-in — verify, review, ship

**Controller's, not a subagent's.**

- [ ] **Step 1: Prove the migration on a real database, not a fresh one**

**A worktree is a fresh install and can never show an upgrade bug.** The main checkout's db lags several rungs; copy it and drive `migrate` from a throwaway `cargo test`:

```
cp -r D:/Code/mtg-grimoire/src-tauri/target/debug/data /tmp/v23-real
```
Then run the rung against the copy and assert `user_version` reaches 24, the grain index carries the eleventh term, and no row was lost except zero-quantity ones. **`Copy-Item` carries the source mtime, so cargo can skip a rebuild and re-run a stale binary while fmt/clippy/test all pass without running** — reconcile the test count against the previous run before believing a green.

- [ ] **Step 2: Full verify, sharded**

```
npx vitest run --shard=1/3 > s1.log 2>&1; grep -E "Test Files|Tests  " s1.log
```
and 2/3, 3/3, then `npm run build`, `npx eslint . --max-warnings 0`, `npx tsc --noEmit`, `cargo test`, `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`. **Redirect to a file and grep it** — `| tail` reports tail's exit 0 while tests fail.

- [ ] **Step 3: Whole-diff review**, then one fix wave and one scoped re-review.

- [ ] **Step 4: Drive the real window.** Create a folder, file a card into it by drag and by `Move to → folder`, check the card menu's nested targets, delete a folder holding cards and confirm they surface at the root. Per `live-ui-verification.md`.

Harness notes from PR 1's pass: the collection page is a **div/grid table** — query `[role=row]` and `[role=gridcell]`, not `tbody tr`. `cdp.mjs` has no right-click: a synthetic `MouseEvent('contextmenu', {bubbles, clientX, clientY, button: 2})` on `[data-grid-index]` opens the card menu, and submenus need `pointerenter` + `mouseover` + `focus()` + `click()` together. Take the app lock first, and **release it when done**.

- [ ] **Step 5: Ship.** `auto-pr`, PR body carrying **`Closes #215`** and `Refs #209`. Write `docs/reference/collection-folders.md` and add its row to the root `CLAUDE.md` reference table — PR 1 deliberately left that row out because the page did not exist yet.
