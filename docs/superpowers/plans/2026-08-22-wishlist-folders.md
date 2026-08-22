# Wishlist Folders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the wishlist nested folders so cards can be set aside without being removed, and
let a wish's printing be changed — including back to "any printing" — from the wishlist itself.

**Architecture:** `wishlist_folders` mirrors `deck_folders` (nesting via `parent_id ON DELETE
CASCADE`, members un-filed via `ON DELETE SET NULL`). `folder_id` joins `WISHLIST_GRAIN`, which is
what makes "Add to" always add a new wish rather than move an existing one; moving is the separate
`wishlist_set_folder`, which **merges** when the destination grain is taken. The four pure tree
functions are lifted out of the decks feature into `src/lib/folderTree.ts` so both surfaces share
one implementation. A wish tile's drag payload carries **two marks**, so a pinned wish stays
droppable on a deck while every wish — pinned or not — becomes droppable on a folder.

**Tech Stack:** Rust + rusqlite (SQLite), React 19 + TypeScript 6, TanStack Query,
`@atlaskit/pragmatic-drag-and-drop`, Tailwind v4, Vitest, Storybook.

**Spec:** `docs/superpowers/specs/2026-08-22-wishlist-folders-design.md` — read it first. The plan
argues from it and does not repeat its reasoning.

---

## Global Constraints

- **Read the `CLAUDE.md` for the area you touch.** `src-tauri/CLAUDE.md` for Rust, `src/CLAUDE.md`
  for any UI, `.storybook/CLAUDE.md` for stories. They are binding and the root one does not
  repeat them.
- **Do not run `npm run verify`, `npm test` or `cargo test` inside a task.** Tasks run in parallel
  in one worktree against a tree siblings are still changing; the controller runs the suites once
  at fan-in. Report what you changed instead.
- **Do not `git commit`.** The git index is shared across parallel agents in this worktree, so a
  bare commit takes whatever a sibling staged. The controller commits.
- **Never install `@types/node`.** Never add a dependency; everything here uses what is already in
  `package.json`.
- **Match the surrounding prose density.** This codebase's comments explain *why*, at length, and
  a new file that does not read like its neighbours is a defect here. Port the reasoning from the
  deck equivalent rather than writing a bare version of it.
- **Rust `#[tauri::command]` argument casing:** declare `parent_id`, `folder_id`, `card_id` in
  snake_case; Tauri accepts the camelCase key from the webview automatically. This is what
  `deck_meta.rs:1993` does.
- **`clippy` caps a function at 7 arguments.** `npm run verify` does not run `cargo fmt` or
  `cargo clippy`; CI does, and they are the only reds a fully green verify can still produce.
- **Prose files route to neither CI job.** Any count or list you change in a doc, re-count in the
  same edit.
- No em-dash-free rule and no line-length rule beyond what Prettier/rustfmt already enforce —
  **do not run a global `prettier` pass**, it rewrites 126 unrelated files.

## Contracts every task codes against

These names are fixed. Tasks run in parallel and see only their own brief, so nothing below may be
renamed by the task that implements it.

### Rust

```rust
// src-tauri/src/schema.rs
pub const SCHEMA_VERSION: i64 = 23;
pub const WISHLIST_GRAIN: &str = "coalesce(oracle_id, ''), coalesce(card_id, ''), \
     coalesce(preferred_finish, ''), coalesce(folder_id, 0)";

// src-tauri/src/wishlist_folders.rs
pub struct WishlistFolderRow { pub id: i64, pub parent_id: Option<i64>,
                               pub name: String, pub sort_order: i64 }
pub struct WishlistFolderSummary { pub folder_id: i64, pub wishes: i64,
                                   pub missing: i64, pub cost: f64, pub unpriced: i64 }

pub fn list_folders(conn: &Connection) -> Result<Vec<WishlistFolderRow>, String>;
pub fn create_folder(conn: &Connection, parent_id: Option<i64>, name: &str)
    -> Result<WishlistFolderRow, String>;
pub fn rename_folder(conn: &Connection, id: i64, name: &str) -> Result<WishlistFolderRow, String>;
pub fn move_folder(conn: &Connection, id: i64, parent_id: Option<i64>)
    -> Result<WishlistFolderRow, String>;
pub fn delete_folder(conn: &Connection, id: i64) -> Result<(), String>;
pub fn set_wish_folder(conn: &Connection, id: i64, folder_id: Option<i64>)
    -> Result<EntryChange, String>;
pub fn folder_summary(conn: &Connection, marketplace: crate::sorting::Marketplace)
    -> Result<Vec<WishlistFolderSummary>, String>;

// #[tauri::command] wrappers, all `pub async`, all taking
// `state: tauri::State<'_, Arc<AppState>>` first:
//   wishlist_folder_list, wishlist_folder_create, wishlist_folder_rename,
//   wishlist_folder_move, wishlist_folder_delete, wishlist_set_folder,
//   wishlist_folder_summary

// src-tauri/src/wishlist.rs
pub struct WishInput  { /* existing */ pub folder_id: Option<i64> }
pub struct WishlistQuery { /* existing */ pub folder_id: Option<i64>, pub flatten: bool }
pub struct WishRow    { /* existing */ pub folder_id: Option<i64>, pub elsewhere: i64 }
pub fn set_wish_printing(conn: &Connection, id: i64, card_id: Option<&str>)
    -> Result<EntryChange, String>;
// #[tauri::command] pub async fn wishlist_set_printing(state, id: i64, card_id: Option<String>)
```

`EntryChange` is `crate::collection::EntryChange { id: i64, quantity: i64, removed: bool }`.

### TypeScript

```ts
// src/lib/folderTree.ts  (NEW — the four pure functions, widened)
export interface FolderLike { id: number; parentId: number | null; name: string; sortOrder: number }
export interface Filed { folderId: number | null; archived?: boolean }
export interface FolderNode<F extends FolderLike = FolderLike> {
  folder: F; depth: number; count: number; children: FolderNode<F>[];
}
export function indent(depth: number): { paddingLeft: number };
export function buildFolderTree<F extends FolderLike>(
  folders: readonly F[], members: readonly Filed[]): FolderNode<F>[];
export function flattenFolders<F extends FolderLike>(
  nodes: readonly FolderNode<F>[]): FolderNode<F>[];
export function folderDescendants(
  folders: readonly FolderLike[], id: number): ReadonlySet<number>;

// src/lib/ipc.ts
export interface WishlistFolder { id: number; parentId: number | null;
                                  name: string; sortOrder: number }
export interface WishlistFolderSummary { folderId: number; wishes: number;
                                         missing: number; cost: number; unpriced: number }
// WishInput      += folderId?: number | null
// WishlistQuery  += folderId?: number | null; flatten?: boolean
// WishRow        += folderId: number | null; elsewhere: number
ipc.wishlistFolderList(): Promise<WishlistFolder[]>
ipc.wishlistFolderCreate(parentId: number | null, name: string): Promise<WishlistFolder>
ipc.wishlistFolderRename(id: number, name: string): Promise<WishlistFolder>
ipc.wishlistFolderMove(id: number, parentId: number | null): Promise<WishlistFolder>
ipc.wishlistFolderDelete(id: number): Promise<void>
ipc.wishlistSetFolder(id: number, folderId: number | null): Promise<EntryChange>
ipc.wishlistFolderSummary(marketplace: MarketplaceId): Promise<WishlistFolderSummary[]>
ipc.wishlistSetPrinting(id: number, cardId: string | null): Promise<EntryChange>

// src/features/wishlist/useWishlistFolders.ts
export function useWishlistFolders(): {
  query; folders: readonly WishlistFolder[];
  summary: ReadonlyMap<number, WishlistFolderSummary>; summaryQuery;
  create; rename; move; remove;   // TanStack mutations, see Task 7
};
export type WishlistFolders = ReturnType<typeof useWishlistFolders>;

// src/features/wishlist/wishDrag.ts
export interface WishDrag { wishId: number; name: string; folderId: number | null }
export function wishDragData(drag: WishDrag): Record<string, unknown>;
export function readWishDrag(data: Record<string, unknown>): WishDrag | null;
export function useWishDropTarget(args: {
  ref: RefObject<HTMLElement | null>;
  canDrop: (drag: WishDrag) => boolean;
  onDrop: (drag: WishDrag) => void;
}): { over: boolean; armed: boolean };

// src/features/wishlist/WishFolderCard.tsx
export function WishFolderCard(props: {
  node: FolderNode<WishlistFolder>;
  summary: { wishes: number; missing: number; cost: number; unpriced: number };
  currency: string;
  onOpen: () => void;
  rowMenu: { onContextMenu: MouseEventHandler; onKeyDown: KeyboardEventHandler };
  canDrop: (drag: WishDrag) => boolean;
  onDropWish: (drag: WishDrag) => void;
}): JSX.Element;

// src/features/wishlist/WishlistBreadcrumb.tsx
export function WishlistBreadcrumb(props: {
  trail: readonly WishlistFolder[];       // root-most first; empty at the root
  flattened: boolean;
  onOpen: (folderId: number | null) => void;
  canDrop: (drag: WishDrag, folderId: number | null) => boolean;
  onDropWish: (drag: WishDrag, folderId: number | null) => void;
}): JSX.Element;

// src/features/card/cardMenu.tsx
export function buildWishlistTargetItems(
  folders: readonly WishlistFolder[],
  choose: (folderId: number | null) => void,
): MenuItem[];
// CardMenuDeps += wishlistFolders: readonly WishlistFolder[]
// CardMenuDeps.addToWishlist: (target: CardMenuTarget, folderId: number | null) => void

// src/lib/store.ts
// PrintingsRequest += wish: { id: number } | null
```

### Wave order

Tasks in the same wave touch disjoint files and run in parallel. A wave starts only when the one
before it has landed.

| Wave | Tasks |
| --- | --- |
| 1 | 1 (schema + reset) |
| 2 | 2 (wishlist_folders.rs), 3 (wishlist.rs), 4 (folderTree.ts), 5 (ipc.ts) |
| 3 | 6 (wishDrag), 7 (useWishlistFolders), 8 (folder card + breadcrumb), 9 (useWishlist + filter bar), 10 (EditWish), 11 (card menu), 12 (printings modal) |
| 4 | 13 (grid + table), 14 (WishlistPage wiring), 15 (lib.rs + storybook fake) |
| 5 | 16 (stories), 17 (fix round + docs) |

---

## Task 1: Schema v23 and the four-term grain

**Files:**
- Modify: `src-tauri/src/schema.rs` — `SCHEMA_VERSION` (line 226), `WISHLIST_GRAIN` (line 255),
  a new migration step after the v22 step (line 2134), and the tests module.
- Modify: `src-tauri/src/reset.rs:170` — `clear_wishlist`, and its tests.

**Interfaces:**
- Consumes: nothing.
- Produces: `SCHEMA_VERSION = 23`; `WISHLIST_GRAIN` with its fourth term; tables
  `wishlist_folders` and column `wishlist_entries.folder_id`; index `idx_wishlist_folder`;
  the rebuilt unique index `idx_wishlist_grain`.

- [ ] **Step 1: Write the failing tests**

In `schema.rs`'s `mod tests`, beside the existing ladder tests:

```rust
#[test]
fn migrate_creates_the_wishlist_folders_and_files_wishes_at_the_root() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    // The table exists and nests.
    conn.execute_batch(
        "INSERT INTO wishlist_folders (id, parent_id, name, sort_order, created_at, updated_at)
         VALUES (1, NULL, 'Expensive', 0, 0, 0), (2, 1, 'Someday', 0, 0, 0);",
    )
    .unwrap();
    // A wish lands at the root with no folder named.
    conn.execute(
        "INSERT INTO wishlist_entries (oracle_id, name, quantity, created_at, updated_at)
         VALUES ('o1', 'Bolt', 1, 0, 0)",
        [],
    )
    .unwrap();
    let filed: Option<i64> = conn
        .query_row("SELECT folder_id FROM wishlist_entries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(filed, None, "a wish with no folder named is at the root");
}

#[test]
fn the_wishlist_grain_separates_two_folders() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    conn.execute_batch(
        "INSERT INTO wishlist_folders (id, parent_id, name, sort_order, created_at, updated_at)
         VALUES (1, NULL, 'Ordered', 0, 0, 0);",
    )
    .unwrap();
    // The same oracle card, same (absent) printing, same (absent) finish -- twice, in two
    // places. This is what makes "Add to" always add a new wish.
    for folder in [None, Some(1i64)] {
        conn.execute(
            "INSERT INTO wishlist_entries
                (oracle_id, name, quantity, folder_id, created_at, updated_at)
             VALUES ('o1', 'Bolt', 1, ?1, 0, 0)",
            rusqlite::params![folder],
        )
        .unwrap();
    }
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM wishlist_entries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 2);
    // And the grain still bites *within* one folder.
    let again = conn.execute(
        "INSERT INTO wishlist_entries
            (oracle_id, name, quantity, folder_id, created_at, updated_at)
         VALUES ('o1', 'Bolt', 1, 1, 0, 0)",
        [],
    );
    assert!(again.is_err(), "two identical wishes in one folder are one wish");
}

#[test]
fn deleting_a_wishlist_folder_keeps_its_wishes_and_cascades_its_subfolders() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         INSERT INTO wishlist_folders (id, parent_id, name, sort_order, created_at, updated_at)
         VALUES (1, NULL, 'Expensive', 0, 0, 0), (2, 1, 'Someday', 0, 0, 0);
         INSERT INTO wishlist_entries
            (oracle_id, name, quantity, folder_id, created_at, updated_at)
         VALUES ('o1', 'Bolt', 1, 2, 0, 0);",
    )
    .unwrap();
    conn.execute("DELETE FROM wishlist_folders WHERE id = 1", []).unwrap();
    let folders: i64 = conn
        .query_row("SELECT count(*) FROM wishlist_folders", [], |r| r.get(0))
        .unwrap();
    assert_eq!(folders, 0, "the sub-folder cascades with its parent");
    let filed: Option<i64> = conn
        .query_row("SELECT folder_id FROM wishlist_entries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(filed, None, "the wish survives, un-filed");
}
```

And a **ladder** test, following `v6_deck_database`'s pattern in the same file. Add an
`UNDO_V23` constant beside the other `UNDO_V*` constants and a test that walks a v22 database
carrying wishes up to 23:

```rust
/// Rewinds v23. Joined to the other `UNDO_V*` constants by every test below this rung.
const UNDO_V23: &str = "DROP TABLE IF EXISTS wishlist_folders;
     DROP INDEX IF EXISTS idx_wishlist_folder;";

#[test]
fn migrating_a_v22_wishlist_files_every_existing_wish_at_the_root() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    conn.execute(
        "INSERT INTO wishlist_entries (oracle_id, name, quantity, created_at, updated_at)
         VALUES ('o1', 'Bolt', 3, 0, 0)",
        [],
    )
    .unwrap();
    // Rewind to 22. `folder_id` cannot be dropped -- SQLite refuses DROP COLUMN on an
    // indexed column -- so the index is rewound and the column is left, which is what the
    // v23 step's own `IF NOT EXISTS` guards have to survive anyway.
    conn.execute_batch(&format!("{UNDO_V23} PRAGMA user_version = 22;")).unwrap();
    migrate(&conn).unwrap();
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    let (qty, filed): (i64, Option<i64>) = conn
        .query_row("SELECT quantity, folder_id FROM wishlist_entries", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!((qty, filed), (3, None), "the wish survives the rung, at the root");
}
```

> The rewind leaves `folder_id` in place because SQLite refuses `DROP COLUMN` on an indexed
> column. That means **the v23 step must tolerate the column already existing**: guard the
> `ALTER TABLE` the way the v8 step's `folder_id` note (schema.rs:3044) describes, by probing
> `pragma_table_info` first rather than relying on `IF NOT EXISTS`, which `ADD COLUMN` does not
> support.

In `reset.rs`'s `mod tests`:

```rust
#[test]
fn clearing_the_wishlist_takes_its_folders_and_leaves_the_decks_alone() {
    let conn = conn();
    conn.execute_batch(
        "INSERT INTO wishlist_folders (id, parent_id, name, sort_order, created_at, updated_at)
         VALUES (1, NULL, 'Ordered', 0, 0, 0);
         INSERT INTO deck_folders (id, parent_id, name, sort_order, created_at, updated_at)
         VALUES (1, NULL, 'Standard', 0, 0, 0);",
    )
    .unwrap();
    clear_wishlist(&conn).unwrap();
    assert_eq!(count(&conn, "wishlist_folders"), 0);
    assert_eq!(count(&conn, "deck_folders"), 1);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --lib schema::tests::migrate_creates_the_wishlist_folders reset::tests::clearing_the_wishlist_takes`

Expected: FAIL — `no such table: wishlist_folders`.

> **The filter must select something.** A `cargo test` filter that matches no test exits 0 and
> reads exactly like a pass. Confirm the summary line names a non-zero number of tests run.

- [ ] **Step 3: Bump the constants**

`SCHEMA_VERSION` to `23`. `WISHLIST_GRAIN` to the four-term string in the Contracts section
above, and extend its doc comment with a paragraph saying that the fourth term is what makes an
"Add to" into a *new* wish rather than a move, and that `coalesce(folder_id, 0)` is safe because
`wishlist_folders.id` is `INTEGER PRIMARY KEY` and therefore never 0.

- [ ] **Step 4: Write the v23 migration step**

After the v22 step (schema.rs:2134), in the same `if v < N` shape the ladder uses, ending
`tx.execute_batch("PRAGMA user_version = 23;")?;`. The DDL is §1 of the spec, **spelled out
literally** — do not interpolate `WISHLIST_GRAIN`; a migration step is history. Carry a comment
block in the surrounding voice covering: why `parent_id` is CASCADE and `folder_id` is SET NULL,
why the unique index is rebuilt rather than added to, and why the `ALTER TABLE` is probed for
rather than guarded with `IF NOT EXISTS`.

The `ADD COLUMN` guard:

```rust
let has_folder: bool = tx
    .query_row(
        "SELECT count(*) FROM pragma_table_info('wishlist_entries') WHERE name = 'folder_id'",
        [],
        |r| r.get::<_, i64>(0),
    )? > 0;
if !has_folder {
    tx.execute_batch(
        "ALTER TABLE wishlist_entries ADD COLUMN folder_id INTEGER
            REFERENCES wishlist_folders(id) ON DELETE SET NULL;",
    )?;
}
```

- [ ] **Step 5: Teach `clear_wishlist` about the folders**

`reset.rs:170`. Delete the folders too; the returned count stays the number of **wishes**
deleted, because that is what the Settings sentence counts. Extend the function's doc comment —
the existing one says "Nothing references it, so nothing else moves", which stops being true.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --lib schema:: reset::`

Expected: PASS, and the pre-existing ladder tests still pass — several assert `SCHEMA_VERSION`
and several rewind through `UNDO_V*` chains that now have one more rung above them. **Any test
whose rewind chain starts above v22 needs `UNDO_V23` prepended to its `execute_batch` string.**
Grep for `UNDO_V22` and give every hit an `UNDO_V23` in front of it.

- [ ] **Step 7: Report**

Report to the controller: files changed, the tests added, and the list of pre-existing tests
whose `UNDO_V*` chain you extended.

---

## Task 2: `wishlist_folders.rs`

**Files:**
- Create: `src-tauri/src/wishlist_folders.rs`
- **Do not touch** `lib.rs` — the controller registers the commands (Task 15).

**Interfaces:**
- Consumes: Task 1's schema; `crate::collection::EntryChange`; `crate::sync::{with_write,
  lock_db_read, AppState}`; `crate::sorting::{Marketplace, price_expr}`;
  `crate::wishlist::{OWNED_SQL, WISH_FINISH}`.
- Produces: everything under "Rust" in the Contracts section.

**Read first:** `src-tauri/src/deck_meta.rs:1570-2050` — the folder half, which this ports. Keep
its structure, its refusal wording and its comment density. `wishlist.rs`'s head for how the
wishlist's own commands are shaped.

- [ ] **Step 1: Write the failing tests**

An inline `#[cfg(test)] mod tests` with a `conn()` helper that opens in memory, runs
`crate::schema::migrate`, and turns foreign keys on. Cover, one test each:

| Test | Asserts |
| --- | --- |
| `create_folder_puts_a_folder_at_the_root_and_inside_another` | `parent_id` round-trips; `sort_order` is `max+1` among siblings, counted **per parent** |
| `create_folder_refuses_a_blank_name` | `"   "` is an `Err`, and the message names the problem |
| `rename_folder_writes_the_new_name` | and refuses blank |
| `move_folder_moves_to_a_new_parent_and_then_back_to_root` | `None` reaches the root |
| `move_folder_refuses_a_cycle` | A into B, then B into A is an `Err` |
| `move_folder_refuses_moving_a_folder_into_itself_directly` | |
| `move_folder_gives_up_on_a_cycle_it_did_not_write` | Write a cycle behind the guard with raw SQL, then move into it; the walk must terminate with an `Err`, not hang |
| `delete_folder_keeps_its_wishes_and_cascades_its_subfolders` | wishes surface at the root |
| `delete_folder_is_a_success_for_an_id_that_is_not_there` | `Ok(())` |
| `list_folders_reads_the_tree_shape_and_order` | flat rows, `sort_order, id` |
| `set_wish_folder_moves_a_wish_and_back_to_the_root` | |
| `set_wish_folder_merges_onto_a_wish_the_destination_already_holds` | **the important one** — see below |
| `folder_summary_counts_only_what_is_filed_directly_in_each_folder` | a nested folder's wishes are *not* in its parent's row |
| `folder_summary_leaves_an_unpriced_wish_out_of_the_cost_and_counts_it` | |

The merge test in full, because it is the one that is easy to get wrong:

```rust
#[test]
fn set_wish_folder_merges_onto_a_wish_the_destination_already_holds() {
    let conn = conn();
    conn.execute_batch(
        "INSERT INTO wishlist_folders (id, parent_id, name, sort_order, created_at, updated_at)
         VALUES (1, NULL, 'Ordered', 0, 0, 0);
         -- The same card, twice: two copies at the root, five already in Ordered.
         INSERT INTO wishlist_entries
            (id, oracle_id, name, quantity, folder_id, created_at, updated_at)
         VALUES (10, 'o1', 'Bolt', 2, NULL, 0, 0),
                (11, 'o1', 'Bolt', 5, 1,    0, 0);",
    )
    .unwrap();

    let change = set_wish_folder(&conn, 10, Some(1)).unwrap();

    // The destination's id and its summed quantity -- not the source's.
    assert_eq!(change.id, 11);
    assert_eq!(change.quantity, 7);
    assert!(!change.removed);
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM wishlist_entries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1, "the source row is gone, not left at zero");
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib wishlist_folders::`
Expected: FAIL to compile — the module does not exist. Add `pub mod wishlist_folders;` to
`lib.rs` **temporarily** to run the tests, and **revert that line before reporting** so Task 15
owns it. Note the temporary edit in your report.

- [ ] **Step 3: Implement the five folder functions**

Port `deck_meta.rs`'s `list_folders` / `create_folder` / `rename_folder` / `move_folder` /
`delete_folder` against `wishlist_folders`, keeping the cycle walk's visited set
(`deck_meta.rs:1673`) verbatim in structure. `delete_folder` needs **no** manual un-filing —
`ON DELETE SET NULL` does it — but it must not assume foreign keys are on if `deck_meta`'s
version did something explicit; read that function before deciding, and say in a comment which
of the two mechanisms is doing the work.

- [ ] **Step 4: Implement `set_wish_folder`**

Inside a transaction:

1. Read the moving wish's `(oracle_id, card_id, preferred_finish, quantity)`. A missing id is an
   `Err` in `set_wish_quantity`'s words.
2. Look for a row in the destination folder with the same three grain terms and a different id.
3. **Found** → `UPDATE` the destination's quantity to the sum, `DELETE` the source, return the
   destination's `EntryChange`.
4. **Not found** → `UPDATE wishlist_entries SET folder_id = ?, updated_at = unixepoch()`, return
   this row's `EntryChange`.

Write the *why* above it: a `UNIQUE constraint failed` reaching the reader would be the app
telling them off for filing a card twice.

- [ ] **Step 5: Implement `folder_summary`**

One `GROUP BY folder_id` over `wishlist_entries` where `folder_id IS NOT NULL`, joined the way
`wishlist.rs`'s list query joins for a price. Reuse `crate::wishlist::OWNED_SQL` and
`crate::sorting::price_expr(marketplace)` over `WISH_FINISH` so a folder's subtotal and the page
header's total are the same arithmetic. `missing` is `sum(max(0, quantity - owned))`; `cost` is
`sum(missing * unit_price)` over the priced rows only; `unpriced` counts the rows with a missing
row still to buy and no price.

If `OWNED_SQL` or `WISH_FINISH` are not `pub`, make them `pub(crate)` — do not copy the SQL.

- [ ] **Step 6: Write the seven `#[tauri::command]` wrappers**

`deck_meta.rs:1983-2043`'s exact shape: `spawn_blocking`, `with_write` for the writes and
`lock_db_read` for the two reads, `.map_err(unfinished)?` where `deck_meta` uses it (define or
import the same helper).

- [ ] **Step 7: Run the tests**

Run: `cd src-tauri && cargo test --lib wishlist_folders::`
Expected: PASS, and the printed count matches the number of tests you wrote.

- [ ] **Step 8: Report**

Files created, tests added and their count, and confirmation that `lib.rs` is back to its
committed state.

---

## Task 3: `wishlist.rs` — folders on the wish, and the printing

**Files:**
- Modify: `src-tauri/src/wishlist.rs`

**Interfaces:**
- Consumes: Task 1's `WISHLIST_GRAIN`.
- Produces: `WishInput.folder_id`, `WishlistQuery.{folder_id, flatten}`,
  `WishRow.{folder_id, elsewhere}`, `set_wish_printing`, command `wishlist_set_printing`.
  Makes `OWNED_SQL` and `WISH_FINISH` `pub(crate)` if they are not already (Task 2 needs them).

- [ ] **Step 1: Write the failing tests**

In the existing `mod tests`:

| Test | Asserts |
| --- | --- |
| `add_wish_with_a_folder_makes_a_second_wish_beside_a_root_one` | two rows for one card, one at the root and one filed — the grain decision, proved at the command |
| `add_wish_twice_into_one_folder_folds_onto_the_same_row` | the fold still works *within* a folder |
| `list_wishes_at_the_root_leaves_out_what_is_filed` | `folder_id: None, flatten: false` |
| `list_wishes_in_a_folder_leaves_out_the_root_and_the_subfolders` | direct members only |
| `list_wishes_flattened_answers_every_wish_wherever_it_is` | `flatten: true` ignores `folder_id` |
| `elsewhere_counts_the_other_wishes_for_the_same_oracle_card` | 2 rows → each says 1; a lone wish says 0; an orphan with no `oracle_id` says 0 |
| `set_wish_printing_pins_a_wish_and_refreshes_its_set_and_number` | `set_code`/`collector_number`/`lang` come from `cards` |
| `set_wish_printing_to_none_returns_a_wish_to_any_printing` | all four columns NULL |
| `set_wish_printing_refuses_a_card_the_database_does_not_have` | `add_wish`'s wording |
| `set_wish_printing_refuses_unpinning_a_wish_that_has_no_oracle_card` | the table CHECK, said in the app's voice first |
| `set_wish_printing_merges_onto_a_wish_the_grain_already_holds` | same shape as Task 2's merge test |
| `set_wish_printing_clears_needs_review` | choosing a printing *is* the review |

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib wishlist::tests`
Expected: FAIL — `no field folder_id`, `cannot find function set_wish_printing`.

- [ ] **Step 3: Add the three struct fields**

`WishInput.folder_id: Option<i64>` (its doc: absent is the root, and it is part of the conflict
target so no `DO UPDATE` clause touches it). `WishlistQuery.folder_id` and
`WishlistQuery.flatten` — **`flatten` is what tells "the root" apart from "no folder filter"; a
nullable field alone cannot**, and that sentence belongs on the field. `WishRow.folder_id` and
`WishRow.elsewhere`.

- [ ] **Step 4: Thread `folder_id` through `add_wish`**

`wishlist.rs:302` — add the column to the INSERT's column list and its `VALUES`, renumbering the
positional parameters. The `ON CONFLICT({WISHLIST_GRAIN}) DO UPDATE SET` clause gains nothing:
`folder_id` is part of the target, so a conflict already means the same folder.

- [ ] **Step 5: Thread the two query fields through `list_wishes`**

`flatten == false` adds `AND w.folder_id IS ?n` (which matches NULL against NULL in SQLite — use
`IS`, never `=`); `flatten == true` adds nothing. `elsewhere` is a correlated subquery in the
SELECT list:

```sql
(SELECT count(*) FROM wishlist_entries o
  WHERE o.id <> w.id AND o.oracle_id IS NOT NULL AND o.oracle_id = w.oracle_id) AS elsewhere
```

`o.oracle_id IS NOT NULL` is load-bearing: without it two orphans with NULL oracle ids would
count each other, and `NULL = NULL` is not true in SQL anyway — the explicit test is the fence
and the comment says so.

- [ ] **Step 6: Implement `set_wish_printing`**

The five behaviours from the spec's §2, in a transaction, with the merge rule identical to
`set_wish_folder`'s (write the *why* once here and cross-reference it from the other, rather
than repeating the paragraph).

- [ ] **Step 7: Write the `#[tauri::command]` wrapper**

```rust
#[tauri::command]
pub async fn wishlist_set_printing(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    card_id: Option<String>,
) -> Result<EntryChange, String>
```

- [ ] **Step 8: Run the tests**

Run: `cd src-tauri && cargo test --lib wishlist::tests`
Expected: PASS, with a non-zero selected count.

- [ ] **Step 9: Report**

Include whether you had to widen `OWNED_SQL`/`WISH_FINISH` visibility, since Task 2 depends on it.

---

## Task 4: Lift the folder tree into `src/lib/folderTree.ts`

**Files:**
- Create: `src/lib/folderTree.ts`
- Create: `src/lib/folderTree.test.ts`
- Modify: `src/features/decks/folders.ts` — becomes a re-export, keeping its whole head comment
- Modify: every reader of `FolderNode.deckCount` — grep for it; at minimum
  `src/features/decks/FolderTree.tsx`, `src/features/decks/FolderCard.tsx`,
  `src/features/decks/DecksPage.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: everything under `src/lib/folderTree.ts` in the Contracts section.

**Read first:** `src/features/decks/folders.ts` in full — the four functions and the reasoning
that travels with them.

- [ ] **Step 1: Confirm the case-collision trap does not apply**

Run: `ls src/lib/ | grep -i foldertree`
Expected: no output. This repo is developed on a case-insensitive filesystem where
`./folderTree` would also resolve to a `FolderTree.tsx` beside it, which is why the decks
version is called `folders.ts`. `src/lib/` has no such sibling, so the name is free — but check,
do not assume. If anything comes back, stop and report.

- [ ] **Step 2: Write the failing test**

`src/lib/folderTree.test.ts`. Port the existing coverage of the four functions from
`src/features/decks/FolderTree.test.tsx` (the pure-function `describe` blocks only — leave the
component tests where they are) and add two that the widening makes possible:

```ts
it("counts a member with no archived flag", () => {
  // A wish cannot be archived, so `archived` is optional and an absent flag counts.
  const tree = buildFolderTree(
    [{ id: 1, parentId: null, name: "Ordered", sortOrder: 0 }],
    [{ folderId: 1 }, { folderId: 1 }],
  );
  expect(tree[0].count).toBe(2);
});

it("still skips an archived member", () => {
  const tree = buildFolderTree(
    [{ id: 1, parentId: null, name: "Standard", sortOrder: 0 }],
    [{ folderId: 1, archived: true }, { folderId: 1, archived: false }],
  );
  expect(tree[0].count).toBe(1);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/lib/folderTree.test.ts`
Expected: FAIL — cannot resolve `@/lib/folderTree`.

- [ ] **Step 4: Move the four functions**

Cut `indent`, `INDENT_STEP`, `INDENT_BASE`, `FolderNode`, `Filed`, `order`, `buildFolderTree`,
`flattenFolders` and `folderDescendants` into `src/lib/folderTree.ts` **with their comments
intact**. Widen the types per the Contracts section: `FolderLike` replaces `DeckFolder`,
`Filed.archived` becomes optional, `FolderNode` becomes generic in its folder type, and
`deckCount` becomes `count`.

`buildFolderTree`'s skip test becomes `member.archived === true`, and the field's doc says why
it is optional now: a deck can be archived and a wish cannot.

`FolderNode.count`'s doc keeps the reasoning it had — a row reading 0 over a sub-folder holding
twelve is a lie the reader can only catch by clicking — generalised from decks to members.

Move `folders.ts`'s head comment about **why the file is called `folders.ts` and not
`folderTree.ts`** into the new file too, rewritten to say the collision is a fact about
`src/features/decks/`, where the component sits, and why `src/lib/` is free of it.

- [ ] **Step 5: Turn `src/features/decks/folders.ts` into a re-export**

```ts
export {
  indent,
  buildFolderTree,
  flattenFolders,
  folderDescendants,
  type FolderNode,
  type FolderLike,
  type Filed,
} from "@/lib/folderTree";
```

Keep the existing head comment and add a paragraph saying the four moved to `@/lib/folderTree`
when the wishlist grew folders of its own, and that this stays so the eleven imports through
`./folders` and `./FolderTree` keep working.

- [ ] **Step 6: Rename `deckCount` at every reader**

Run: `grep -rn "deckCount" src/`
Rename each to `count`. This is why the field is renamed rather than kept: it counts wishes on
the other surface, and a field called `deckCount` holding a number of wishes is a lie in the
type.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/lib/folderTree.test.ts src/features/decks/FolderTree.test.tsx`
Expected: PASS — **the decks' existing tests must pass unchanged apart from the `deckCount`
rename**. That is the proof the extraction preserved behaviour.

- [ ] **Step 8: Report**

The list of files whose `deckCount` you renamed, and the test counts before and after.

---

## Task 5: `src/lib/ipc.ts`

**Files:**
- Modify: `src/lib/ipc.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3's command names and shapes.
- Produces: everything under `src/lib/ipc.ts` in the Contracts section.

- [ ] **Step 1: Add the two interfaces**

`WishlistFolder` and `WishlistFolderSummary`, placed beside `DeckFolder` (line 1249) and the
wishlist types respectively. Doc each field in the file's voice; `WishlistFolderSummary`'s
fields are **direct, not recursive** and that has to be said, because the tree sums them.

- [ ] **Step 2: Add the fields to the three existing wishlist types**

`WishInput.folderId?: number | null` — "Where a menu add files it. Absent is the root wishlist."
`WishlistQuery.folderId?: number | null` and `WishlistQuery.flatten?: boolean` — carry the
sentence about why `flatten` exists. `WishRow.folderId: number | null` and
`WishRow.elsewhere: number` (non-optional: the backend always answers them).

- [ ] **Step 3: Add the eight bindings**

Beside the existing `wishlist*` bindings (line 3015) and mirroring `deckFolder*` (line 3243) for
the folder five:

```ts
wishlistFolderList: () => invoke<WishlistFolder[]>("wishlist_folder_list"),
wishlistFolderCreate: (parentId: number | null, name: string) =>
  invoke<WishlistFolder>("wishlist_folder_create", { parentId, name }),
wishlistFolderRename: (id: number, name: string) =>
  invoke<WishlistFolder>("wishlist_folder_rename", { id, name }),
wishlistFolderMove: (id: number, parentId: number | null) =>
  invoke<WishlistFolder>("wishlist_folder_move", { id, parentId }),
wishlistFolderDelete: (id: number) => invoke<void>("wishlist_folder_delete", { id }),
wishlistSetFolder: (id: number, folderId: number | null) =>
  invoke<EntryChange>("wishlist_set_folder", { id, folderId }),
wishlistFolderSummary: (marketplace: MarketplaceId) =>
  invoke<WishlistFolderSummary[]>("wishlist_folder_summary", { marketplace }),
wishlistSetPrinting: (id: number, cardId: string | null) =>
  invoke<EntryChange>("wishlist_set_printing", { id, cardId }),
```

- [ ] **Step 4: Run the type check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: errors only in files other tasks own (the storybook fake will complain that its
`FakeWish` has no `folderId` — that is Task 15). No error inside `ipc.ts` itself.

- [ ] **Step 5: Report**

---

## Task 6: `wishDrag.ts` — two marks on one payload

**Files:**
- Create: `src/features/wishlist/wishDrag.ts`
- Create: `src/features/wishlist/wishDrag.test.ts`

**Interfaces:**
- Consumes: `@atlaskit/pragmatic-drag-and-drop/element/adapter`, `src/features/decks/dnd.ts`'s
  `NOT_A_DRAG`.
- Produces: `WishDrag`, `wishDragData`, `readWishDrag`, `useWishDropTarget`.

**Read first:** `src/features/decks/deckDrag.ts` **in full** — this is its sibling and follows
its structure. Then `src/features/decks/dnd.ts:54-90` and `:279` for the payload shape and the
field-by-field read.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { dragData, readDragData } from "@/features/decks/dnd";
import { readWishDrag, wishDragData } from "./wishDrag";

const WISH = { wishId: 7, name: "Lightning Bolt", folderId: null } as const;

describe("wishDragData / readWishDrag", () => {
  it("round-trips a wish", () => {
    expect(readWishDrag(wishDragData(WISH))).toEqual(WISH);
  });

  it("refuses a payload that is not a wish", () => {
    expect(readWishDrag({ dragSource: "mtg-grimoire/card-drag", cardId: "c1" })).toBeNull();
  });

  it("refuses a malformed wish id", () => {
    for (const wishId of [0, -1, 1.5, "7", undefined]) {
      expect(readWishDrag({ ...wishDragData(WISH), wishId })).toBeNull();
    }
  });

  /**
   * The whole reason this file uses its own key rather than `dnd.ts`'s value: a *pinned* wish
   * is both a card you can put in a deck and a wish you can file, and both readers have to say
   * yes to the same payload.
   */
  it("lets a pinned wish be read as a card and as a wish at once", () => {
    const both = { ...dragData({ kind: "card", cardId: "c1", name: "Bolt", typeLine: null }),
                   ...wishDragData(WISH) };
    expect(readDragData(both)).not.toBeNull();
    expect(readWishDrag(both)).toEqual(WISH);
  });

  /** And an any-printing wish is only the second -- there is no printing to carry. */
  it("reads an any-printing wish as a wish and not as a card", () => {
    const only = wishDragData(WISH);
    expect(readDragData(only)).toBeNull();
    expect(readWishDrag(only)).toEqual(WISH);
  });
});
```

Confirm the string in the second test matches `dnd.ts`'s actual card mark before writing it — read
the constant, do not guess it.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/features/wishlist/wishDrag.test.ts`
Expected: FAIL — cannot resolve `./wishDrag`.

- [ ] **Step 3: Implement the module**

The head comment carries the *why* from the spec's §9: `deckDrag.ts` puts a different **value**
under the same key so a deck and a card refuse each other, and that is right for decks because a
deck is never a card. A wish is both, so this uses its own **key** (`wishSource`) and a payload
may carry both sets.

```ts
const WISH_MARK = "mtg-grimoire/wish-file-drag";
const MARK_KEY = "wishSource";

export function wishDragData(drag: WishDrag): Record<string, unknown> {
  return { [MARK_KEY]: WISH_MARK, ...drag };
}

export function readWishDrag(data: Record<string, unknown>): WishDrag | null {
  if (data[MARK_KEY] !== WISH_MARK) return null;
  const { wishId, name, folderId } = data;
  if (typeof wishId !== "number" || !Number.isSafeInteger(wishId) || wishId <= 0) return null;
  if (typeof name !== "string") return null;
  if (folderId !== null && (typeof folderId !== "number" || !Number.isSafeInteger(folderId)))
    return null;
  return { wishId, name, folderId };
}
```

Field by field rather than a cast, `dnd.ts`'s boundary rule: this is the app's edge with an
untyped store every draggable in the window writes into.

- [ ] **Step 4: Implement `useWishDropTarget`**

`deckDrag.ts`'s `useDeckDropTarget`, verbatim in structure: `dropTargetForElements` for `over`,
`monitorForElements` for `armed` (is a wish in the air at all — this is what raises every
target's ring rather than only the one under the pointer). `canDrop` gates both.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/features/wishlist/wishDrag.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Report**

---

## Task 7: `useWishlistFolders.ts`

**Files:**
- Create: `src/features/wishlist/useWishlistFolders.ts`
- Create: `src/features/wishlist/useWishlistFolders.test.ts`

**Interfaces:**
- Consumes: Task 5's `ipc.wishlistFolder*` and `ipc.wishlistFolderSummary`; `useMarketplace`.
- Produces: `useWishlistFolders`, `WishlistFolders`.

**Read first:** `src/features/decks/useDeckFolders.ts` in full, and
`src/features/decks/useDeckFolders.test.ts` for how it is tested.

- [ ] **Step 1: Write the failing test**

Port `useDeckFolders.test.ts`'s shape. Cover: the list query lands at `["wishlist", "folders"]`;
each of the four mutations calls its `ipc` binding with the right arguments; **a mutation
invalidates `["wishlist"]` on error as well as on success**; the summary query's key carries the
marketplace id, so two marketplaces are two cached answers.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/features/wishlist/useWishlistFolders.test.ts`

- [ ] **Step 3: Implement**

`useDeckFolders`'s body against the wishlist bindings, plus the summary query:

```ts
const summaryQuery = useQuery({
  queryKey: ["wishlist", "folderSummary", marketplace.id],
  queryFn: () => ipc.wishlistFolderSummary(marketplace.id),
});
const summary = useMemo(
  () => new Map((summaryQuery.data ?? []).map((s) => [s.folderId, s])),
  [summaryQuery.data],
);
```

Both keys sit under `["wishlist"]`, and the doc comment must say why that matters here rather
than being tidiness: every wish write in the app already invalidates that root, so a folder
card's count and subtotal stay honest when a wish is added two views away. And a folder **delete**
un-files the wishes inside it, so a hook that refreshed only the folder list would leave the wall
drawing wishes in a folder that is gone — `useDeckFolders`' paragraph, one noun changed.

`NONE` stable-empty-array constant, as `useDeckFolders` has, for the tree builder's `useMemo`.

- [ ] **Step 4: Run the tests** — PASS.

- [ ] **Step 5: Report**

---

## Task 8: `WishFolderCard.tsx` and `WishlistBreadcrumb.tsx`

**Files:**
- Create: `src/features/wishlist/WishFolderCard.tsx`
- Create: `src/features/wishlist/WishlistBreadcrumb.tsx`
- Create: `src/features/wishlist/WishFolderCard.test.tsx`

**Interfaces:**
- Consumes: Task 4's `FolderNode`, Task 5's `WishlistFolder`, Task 6's `WishDrag` and
  `useWishDropTarget`, `@/lib/dropMarks`, `@/lib/focus`, `@/lib/counts`'s `plural`,
  `@/lib/prices`' `formatPrice`.
- Produces: the two components as typed in the Contracts section.

**Read first:** `src/features/decks/FolderCard.tsx` — the dashed treatment and the drop wiring.
`src/CLAUDE.md` — binding for any UI, and it carries the Storybook-MCP rule.

- [ ] **Step 1: Write the failing test**

`WishFolderCard.test.tsx`: renders the folder's name; renders `6 wishes · $312` from the summary
in the given currency; renders `1 wish` singular; renders the count only when `cost` is 0 and
`missing` is 0; carries the `⋯` trigger with an accessible name naming the folder
(`Manage Expensive`); calls `onOpen` on a press; and — with `canDrop` returning `false` — does
**not** carry `DROP_RING` while a drag is armed.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `WishFolderCard`**

Dashed border, because the screen's existing rule is that **dashed means provisional** and a
folder is a container rather than a thing you can buy — the same claim `FolderCard.tsx` makes for
a deck folder. Not `FolderCard`'s strip of member art: a wishlist folder's useful face is
`6 wishes · $312`, which is the number a shopping list is read for, and the reasoning goes in the
head comment.

Unpriced note beside the subtotal in the same `· 2 unpriced` shape `WishlistPage`'s header uses,
so the two agree.

Drop target via `useWishDropTarget`: `DROP_RING` while `armed && canDrop`, `DROP_OVER` on `over`.

- [ ] **Step 4: Implement `WishlistBreadcrumb`**

`Wishlist › Expensive › Someday`, each segment a button calling `onOpen`, the last one current
and inert (`aria-current="page"`). Every segment **except the last** is a drop target, because
dropping on it is how a wish gets back out — without it a drag can only ever push wishes deeper.

When `flattened`, the whole trail is replaced by the inert words `Wishlist · all folders` and no
segment takes a drop.

- [ ] **Step 5: Run the tests** — PASS.

- [ ] **Step 6: Report**

---

## Task 9: `useWishlist.ts` and `WishlistFilterBar.tsx`

**Files:**
- Modify: `src/features/wishlist/useWishlist.ts`
- Modify: `src/features/wishlist/WishlistFilterBar.tsx`

**Interfaces:**
- Consumes: Task 5's query fields.
- Produces: on the `Wishlist` type — `folderId: number | null`, `openFolder: (id: number | null)
  => void`, `flatten: boolean`, `toggleFlatten: () => void`. Both new values are part of
  `listKey` and therefore of `queryKeyString`.

- [ ] **Step 1: Write the failing test**

Extend `src/features/wishlist/WishlistPage.test.tsx`'s existing hook coverage, or add
`useWishlist.test.ts` if the hook is not directly tested today (check first). Assert:
`openFolder(3)` sends `folderId: 3, flatten: false`; `toggleFlatten()` sends `flatten: true`;
**`resetAll()` leaves both alone** — they are not filters, they are where you are standing, the
same reason the sort survives a reset; and `activeFilterCount` does not count them.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Add the state to `useWishlist`**

Two `useState`s, both added to `filters` and to `listKey`. `flatten` is sent only when `true`
(the backend's default is `false`, and sending it always would make the payload lie about
intent — the rule the file already applies to `text`).

Extend `resetAll`'s doc comment with the new exclusion, so the rule is written where it is
enforced.

- [ ] **Step 4: Add the two controls to `WishlistFilterBar`**

The **Flatten** `ToggleChip` beside "Still missing" — `pressed={wishlist.flatten}`. Its comment
says what it does to the folders: no cards, no drill-down, every wish captioned with where it is
filed.

A **`+ New folder`** button in the same row, in the `Import`/`Export` button's style. Hidden
while `flatten` is on: there is no current folder to create inside. It takes an `onNewFolder`
prop from the page rather than owning the write — the field it opens lives on the page, beside
the folder cards.

`WishlistFilterBar` now takes `{ wishlist, onNewFolder }`; update its one call site's props type
only, leaving the page's wiring to Task 14 (pass `onNewFolder={() => {}}` with a `TODO(Task 14)`
comment — **and tell the controller in your report**, because that placeholder must not ship).

- [ ] **Step 5: Run the tests** — PASS.

- [ ] **Step 6: Report** — including the placeholder above, explicitly.

---

## Task 10: `EditWish.tsx` — the printing and the folder

**Files:**
- Modify: `src/features/wishlist/EditWish.tsx`
- Create: `src/features/wishlist/EditWish.test.tsx`

**Interfaces:**
- Consumes: Task 4's `FolderNode`, Task 5's `WishlistFolder`, `MoveToFolder` from
  `@/features/decks/MoveToFolder`, `printingOf`/`wishLabel` from `./wish`.
- Produces: `EditWishButton` with four new props:

```ts
folders: readonly WishlistFolder[];
nodes: readonly FolderNode<WishlistFolder>[];
onSetFolder: (row: WishRow, folderId: number | null) => void;
onChangePrinting: (row: WishRow) => void;   // opens the printings modal; page owns it
onAnyPrinting: (row: WishRow) => void;
```

- [ ] **Step 1: Write the failing test**

Renders the current printing through `printingOf`; `Any printing` is **absent** on an
any-printing wish and calls `onAnyPrinting` on a pinned one; `Change printing…` is **disabled
with a reason** when `row.oracleId === null`; `Move to folder…` swaps the panel body to the
destination list **in place** and a pick calls `onSetFolder`; and a **wish with no `cardId` still
reaches both `Move to folder…` and the quantity stepper** — that is the whole reason these
controls are here rather than in the card context menu.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Add the printing rows**

Between "Copies wanted" and the remove button. `Change printing…` calls `onChangePrinting`;
disabled with `reason` when there is no oracle id, because there are no printings to list.
`Any printing` is drawn only when `row.cardId !== null`.

The head comment gains the sentence that carries the whole design: this panel is the **only**
control an any-printing wish has, because `WishlistPage` withholds the card context menu from
every wish with no `card_id`, deliberately.

- [ ] **Step 4: Add the folder rows, as a two-pane panel**

A `useState<"main" | "move">` inside the popup. `Move to folder…` switches to `"move"`, which
renders `MoveToFolder` inline with a `← Back` control; a pick calls `onSetFolder` and returns to
`"main"`.

**Not a nested `AnchoredPopup`.** Two layers means two Escape rungs and two focus traps for one
decision, and the app's Escape ladder is ordered by registration — write that reason in.

Widen `panelClassName` from `w-56`.

- [ ] **Step 5: Run the tests** — PASS.

- [ ] **Step 6: Report**

---

## Task 11: `Add to → Wishlist`

**Files:**
- Modify: `src/features/card/cardMenu.tsx`
- Modify: `src/features/card/useCardMenuDeps.ts`
- Modify: `src/features/card/cardMenu.test.tsx`

**Interfaces:**
- Consumes: Task 5's `WishlistFolder`, Task 7's `useWishlistFolders`, Task 4's
  `buildFolderTree`/`flattenFolders`.
- Produces: `buildWishlistTargetItems`; `CardMenuDeps.wishlistFolders`; the widened
  `addToWishlist`.

**Read first:** `cardMenu.tsx:647-731` — `buildDeckTargetItems` and `deckLevel`, which this
mirrors, and the two places it deliberately differs.

- [ ] **Step 1: Write the failing test**

In `cardMenu.test.tsx`, beside the `buildDeckTargetItems` describe:

```ts
describe("buildWishlistTargetItems", () => {
  const folder = (id: number, name: string, parentId: number | null = null) =>
    ({ id, parentId, name, sortOrder: 0 });

  it("offers the root first, then the folders", () => {
    const items = buildWishlistTargetItems([folder(1, "Ordered")], vi.fn());
    expect(items.map((i) => ("label" in i ? i.label : i.kind)))
      .toEqual(["Wishlist", "separator", "Ordered"]);
  });

  it("offers a folder with nothing in it", () => {
    // Unlike `deckLevel`, which drops an empty folder: a folder there is a container of
    // destinations, and here it IS the destination.
    expect(buildWishlistTargetItems([folder(1, "Empty")], vi.fn())).toHaveLength(3);
  });

  it("draws a folder with children as a submenu whose first row is the folder itself", () => {
    const items = buildWishlistTargetItems([folder(1, "Expensive"), folder(2, "Someday", 1)],
                                           vi.fn());
    const expensive = items.find((i) => "label" in i && i.label === "Expensive");
    expect(expensive?.kind).toBe("submenu");
    expect((expensive as MenuSubmenu).items.map((i) => ("label" in i ? i.label : i.kind)))
      .toEqual(["Expensive", "separator", "Someday"]);
  });

  it("passes the folder id to the chooser, and null for the root", () => {
    const choose = vi.fn();
    const items = buildWishlistTargetItems([folder(1, "Ordered")], choose);
    (items[0] as MenuAction).onSelect();
    expect(choose).toHaveBeenCalledWith(null);
    (items[2] as MenuAction).onSelect();
    expect(choose).toHaveBeenCalledWith(1);
  });
});
```

And, on `buildCardMenu` itself: **with no folders, `Wishlist` is a plain `action`, not a
submenu** — one press, unchanged, which is the case for every reader who has never made a
folder and must not regress.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `buildWishlistTargetItems`**

Recursive over `buildFolderTree(folders, [])` — no members, because a folder here is a
destination and its contents are irrelevant to whether it can be picked. `Heart` icon on the
root row, `Folder` on the folders. Two documented differences from `deckLevel`, written where
they happen: an empty folder is kept, and a folder with children draws its own row first inside
its own submenu.

- [ ] **Step 4: Widen `CardMenuDeps` and the wishlist row**

`addToWishlist: (target, folderId: number | null) => void`. In `buildCardMenu`, replace the
`add-wishlist` action with:

```ts
deps.wishlistFolders.length === 0
  ? { kind: "action", id: "add-wishlist", label: "Wishlist", Icon: Heart,
      onSelect: () => deps.addToWishlist(target, null) }
  : { kind: "submenu", id: "add-wishlist", label: "Wishlist", Icon: Heart,
      items: buildWishlistTargetItems(deps.wishlistFolders,
                                      (folderId) => deps.addToWishlist(target, folderId)) }
```

Comment it with the trade: this is `submenu` and not `lazy` because the folder list is one small
query the page already holds, so there is nothing to fire on a right-click — the reason the deck
picker needs `lazy` and this does not.

- [ ] **Step 5: Wire `useCardMenuDeps`**

Call `useWishlistFolders()` and put `folders` on `deps` (memoised into the existing `useMemo`
dependency list — this object holds still across a render of a wall of forty tiles and must go
on doing so). `wishlistAdd`'s `mutationFn` takes `{ target, folderId }` and passes
`folderId` to `ipc.wishlistAdd`. Its `onSuccess` invalidation is unchanged.

- [ ] **Step 6: Fix every other caller**

Run: `grep -rn "addToWishlist" src/`
Every construction of a `CardMenuDeps` — including the ones in test files and stories — needs
`wishlistFolders`. Give the test helpers `[]`, which is also the case they were asserting before.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/features/card/cardMenu.test.tsx`
Expected: PASS.

- [ ] **Step 8: Report**

---

## Task 12: Repointing a wish from the printings modal

**Files:**
- Modify: `src/lib/store.ts` — `PrintingsRequest`
- Modify: `src/features/card/AllPrintingsDialog.tsx`
- Modify: `src/features/card/AllPrintingsDialog.test.tsx`

**Interfaces:**
- Consumes: Task 5's `ipc.wishlistSetPrinting`.
- Produces: `PrintingsRequest.wish: { id: number } | null`.

- [ ] **Step 1: Write the failing test**

In `AllPrintingsDialog.test.tsx`, using its existing `openAllPrintings` door (the file's own
rule — drive the store's action, never write the field):

- opening with `wish: { id: 7 }` and pressing a printing calls `ipc.wishlistSetPrinting(7, cardId)`
  and closes the modal;
- a refusal keeps the modal open and draws the sentence beside the wall;
- **after a walk step, a press no longer repoints** — `openAllPrintings(stop)` carries no `wish`,
  so the target clears. The reader asked about wish A; arrowing to card B must not repoint A.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Add the field**

`PrintingsRequest.wish: { id: number } | null`, documented beside `deck` as the same mechanism
one field wider, and with the explicit note that **`CardWalkStop` deliberately does not gain
it** — that is what makes the third test above true.

Every construction of a `PrintingsRequest` needs the field. Run `grep -rn "openAllPrintings\|printingsRequest" src/ .storybook/`
and give each `wish: null`.

- [ ] **Step 4: Add the branch**

In the press handler (`AllPrintingsDialog.tsx:~658`), **before** the `request.deck` branch and
before the fall-through that opens the card pane. A `useMutation` over `ipc.wishlistSetPrinting`
whose `onSuccess` invalidates `["wishlist"]` and `["cards", "search"]` (the search's rows draw
`wishlisted`) and closes; whose `isError` draws beside the wall in the same place `swap.isError`
does; and whose `isPending` makes the wall inert exactly as `swapping` does.

- [ ] **Step 5: Run the tests** — PASS, and the whole existing file still green.

- [ ] **Step 6: Report**

---

## Task 13: The two views — drag, folder caption, `elsewhere`

**Files:**
- Modify: `src/features/wishlist/WishlistGrid.tsx`
- Modify: `src/features/wishlist/WishlistTable.tsx`

**Interfaces:**
- Consumes: Task 6's `wishDragData`, Task 5's `WishRow.folderId`/`elsewhere`.
- Produces: both components take three new props —

```ts
folderNameOf: (folderId: number | null) => string | null;  // null while not flattened
flattened: boolean;
onOpenEdit?: (row: WishRow) => void;   // table only: the Printing cell's press
```

plus the `EditWishButton` props Task 10 added, passed straight through.

- [ ] **Step 1: Write the failing test**

Extend `WishlistPage.test.tsx` (or add `WishlistGrid.test.tsx` if the grid has no file of its
own — check). Assert:

- a tile's drag payload carries the wish mark **and**, on a pinned wish, the card mark;
- an **any-printing** wish's tile is now draggable where it was not, and its payload carries the
  wish mark only;
- while `flattened`, each row is captioned with its folder's name, and a root wish says
  `Wishlist`;
- a row whose `elsewhere` is 0 draws no mark, and one whose `elsewhere` is 2 draws one whose
  accessible name says where.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Widen the drag payload**

`WishlistGrid.tsx:87`'s `tileDrag` stops returning `null` for an unpinned wish and instead
returns the merged payload. `CardGrid`'s `dragPayload` prop is typed `DragPayload | null` — if it
cannot express "extra keys", change the tile to register its own draggable the way
`WishlistTable`'s `DraggableRow` (line 248) does, spreading `wishDragData(...)` over
`dragData(...)` and omitting the card half when `cardId === null`. **Read `CardGrid` before
choosing**, and say in your report which route you took.

The comment at line 75 currently explains why an unpinned wish is not draggable. It is now
draggable *as a wish*; rewrite the paragraph rather than deleting it — the reason the card half
is still withheld is unchanged and still needs saying.

- [ ] **Step 4: Draw the folder caption and the `elsewhere` mark**

The caption only while `flattened`. The mark in both views, beside the printing caption:
`Copy` glyph, `text-dim`, accessible name `Also on your wishlist in 2 other places`.

- [ ] **Step 5: Make the table's Printing cell open the panel**

So the table reaches the two new writes without growing two columns.

- [ ] **Step 6: Run the tests** — PASS.

- [ ] **Step 7: Report**

---

## Task 14: `WishlistPage.tsx` — the wiring

**Files:**
- Modify: `src/features/wishlist/WishlistPage.tsx`
- Modify: `src/features/wishlist/WishlistPage.test.tsx`

**Interfaces:**
- Consumes: Tasks 4, 5, 6, 7, 8, 9, 10, 12, 13 — everything.
- Produces: the working page.

This is the integration task and it is deliberately last. Read the spec's §4 in full.

- [ ] **Step 1: Write the failing test**

- drilling into a folder shows its wishes and not the root's, and the breadcrumb names it;
- **Flatten** shows every wish, hides the folder cards, and hides `+ New folder`;
- creating a folder from `+ New folder` calls `wishlistFolderCreate` with the **current** folder
  as its parent;
- a folder card's `⋯` reaches Rename, Move and Delete, and the delete confirmation says *its
  wishes move back to your wishlist; folders inside it are deleted*;
- dropping a wish on a folder card calls `ipc.wishlistSetFolder(wishId, folderId)`;
- dropping a wish on the breadcrumb's root calls it with `null`;
- the two header figures count **what is on screen** — a folder's wishes when inside one, and
  everything when flattened;
- a folder with nothing in it says `Nothing filed here yet.` and **not** the root's
  "add cards from search" sentence.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Wire the folder state and the tree**

`useWishlistFolders()`; `buildFolderTree(folders, [])` memoised; the trail to the current folder
derived from `folderId` by walking `parentId` — resolving a missing parent **towards the root**,
`buildFolderTree`'s own rule, since a folder another surface deleted must not strand the reader.

- [ ] **Step 4: Draw the breadcrumb and the folder cards**

Direct children of the current folder, above whichever view is active. The scroller they sit in
carries `DROP_MARK_ROOM`, or a card flush against its content edge loses the outer 2px of its
ring for the whole length of a drag — the bug `lib/dropMarks.ts` records against the deck
builder's grow-views, and one jsdom cannot see.

- [ ] **Step 5: Wire the four folder writes and the folder row menu**

Rename and the new-folder field reuse `DecksPage`'s single-`Panel` arrangement so the Escape
ladder has one rung; `MoveToFolder` for the move, with `forbidden` = the folder plus
`folderDescendants(folders, id)`.

- [ ] **Step 6: Wire the two wish writes**

`wishlistSetFolder` (from the drag and from `EditWish`) and `wishlistSetPrinting`'s two entry
points — `onChangePrinting` calls `openAllPrintings({ cardId: row.artCardId, oracleId,
name: row.name, deck: null, wish: { id: row.id } })`, and `onAnyPrinting` calls the ipc directly.

Both follow the page's existing optimistic pattern: `patchWish`, `snapshot`/`restore` on error,
`settle`/`settleFailure`. A **merge** answers a different `id` than the one asked about, so the
success path cannot just patch the row — invalidate `["wishlist"]` whole when
`change.id !== row.id`. Write that reason down; it is the one thing about the merge that reaches
the UI.

- [ ] **Step 7: Remove Task 9's placeholder**

`onNewFolder={() => {}}` and its `TODO(Task 14)` comment.

- [ ] **Step 8: Run the tests** — PASS.

- [ ] **Step 9: Report**

---

## Task 15: `lib.rs` and the Storybook fake

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `.storybook/fake/db.ts`
- Modify: `.storybook/fake/seeds.ts` (or wherever the wishlist seed lives — grep
  `wishlistEntries`)

**Interfaces:**
- Consumes: everything.
- Produces: the eight commands reachable from the webview and from Storybook.

**Read first:** `.storybook/CLAUDE.md` — binding for the fake.

- [ ] **Step 1: Register the commands**

`pub mod wishlist_folders;` beside `pub mod wishlist;`, and the eight handlers in the
`invoke_handler` list beside the existing `wishlist::*` block (lib.rs:323).

- [ ] **Step 2: Run the Rust suite**

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 3: Teach the fake about folders**

`FakeWishlistFolder`, `db.wishlistFolders`, `folderId` on `FakeWish`, and handlers for all eight
commands. The fake must honour **the same refusals**: a cycle is refused, a blank name is
refused, and `wishlist_set_folder` / `wishlist_set_printing` **merge**. A fake that accepted a
cycle would let a story draw a tree the app refuses to make.

`wishlistScope` gains the `folderId`/`flatten` filter; `toWishRow` gains `folderId` and
`elsewhere`.

- [ ] **Step 4: Seed a wishlist worth looking at**

Three folders, one of them nested, one of them empty, and loose wishes at the root — so the
folder card, the breadcrumb, the empty-folder sentence, the drag and Flatten all have something
to draw. **At least one any-printing wish at the root**, since it is the one a card drag cannot
pick up and the wish drag must.

- [ ] **Step 5: Report**

> Adding fixtures to the fake's corpus has broken ~25 unrelated story plays before, in five
> files, by shifting the numbers those plays assert. Expect it and hand the list to the
> controller rather than fixing them here.

---

## Task 16: Stories

**Files:**
- Modify: `src/features/wishlist/WishlistPage.stories.tsx`
- Create: `src/features/wishlist/WishFolderCard.stories.tsx`

**Read first:** `.storybook/CLAUDE.md`, and call the `get-storybook-story-instructions` MCP tool
before writing.

- [ ] **Step 1: Add the stories**

`WishlistPage`: `WithFolders` (the root, folder cards drawn), `InsideAFolder` (breadcrumb, an
empty one), `Flattened` (every wish, each captioned). `WishFolderCard`: `Default`,
`Empty`, `Unpriced`, `DropTarget`.

- [ ] **Step 2: Preview**

Call the `preview-stories` MCP tool and put **every** returned URL in your report — the rule is
in `src/CLAUDE.md` and it is not optional after a UI change.

- [ ] **Step 3: Report**

---

## Task 17: Fix round and docs — the controller's

- [ ] **Step 1: `npm run verify`**

Redirect to a file and grep the summary. **`npm run verify | tail` reports tail's exit code
while tests fail** — do not pipe it.

- [ ] **Step 2: `cargo fmt --check` and `cargo clippy`**

`npm run verify` runs neither, and they are the only reds a fully green verify can still
produce.

- [ ] **Step 3: Fix the story plays the new fixtures moved**

- [ ] **Step 4: Docs**

- `docs/reference/decks-storage.md` — wherever it names the wishlist tables or the grain.
- A new `docs/reference/wishlist-folders.md`: the two tables, the **four-term grain and why**,
  the merge rule the two writes share, the root-add duplicate consequence and the `elsewhere`
  mark that catches it, and the two-mark drag payload.
- `CLAUDE.md`'s reference table gets the new row.

Re-count anything you change that states a number: a prose-only edit routes to neither CI job,
so nothing goes red when a document rots.

- [ ] **Step 5: Live verification**

Drive the real window over CDP per `docs/reference/live-ui-verification.md`. Every UI task in
Plans 2–3 found something the suite could not. At minimum: create a folder, drag a wish into it,
drag it back out on the breadcrumb, flatten, and change a printing back to Any printing.

---

## Self-review notes

**Spec coverage.** §1 → Task 1. §2 → Tasks 2, 3, 15. §3 → Tasks 4, 5, 7. §4 → Tasks 8, 9, 14.
§5 → Task 10. §6 → Task 12. §7 → Task 11. §8 → Tasks 15, 16. §9 → Tasks 6, 8, 13, 14. §10 is the
out-of-scope list. §11 → the tests inside each task. §12 → Task 17.

**Known cross-task hazards, listed so the controller watches for them:**

1. Task 9 leaves a deliberate `onNewFolder={() => {}}` placeholder that Task 14 removes. If Task
   14 is skipped or fails, the New folder button is dead and nothing goes red.
2. Task 2 temporarily adds `pub mod wishlist_folders;` to `lib.rs` to run its tests and reverts
   it. If the revert is missed, Task 15 will find the line already there — harmless, but check.
3. Task 4's `deckCount` → `count` rename crosses into the decks feature. Nothing else in this
   plan touches those files, but a sibling branch might.
4. Task 1's rewind test leaves `folder_id` on the table because SQLite refuses `DROP COLUMN` on
   an indexed column. The v23 step **must** probe `pragma_table_info` rather than assume.
5. Task 13's drag change depends on what `CardGrid`'s `dragPayload` prop can express. The task
   says to read it first and report which route was taken; if it took the second, the tile now
   owns a `draggable` registration that `CardGrid` used to own, and the two must not both fire.
