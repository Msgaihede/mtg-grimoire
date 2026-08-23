# Deck Groups, Exclusivity and Recently Removed — Implementation Plan (PR 3 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the collection folder tree the **physical ledger of where every card sits** — one locked group per deck, a global `Recently removed`, and exclusivity as a fact rather than a computation. Deletes `deck_allocations`, the allocator and `is_built`. **Closes [#209](https://github.com/Msgaihede/mtg-grimoire/issues/209).**

**Architecture:** PR 2 built the cabinet and filed nothing into it. This PR fills it. A card is in a deck because its collection row sits in that deck's group — so `allocate_deck`, `allocate_every_deck` and the whole `deck_allocations` claim ledger are deleted, and `owned_by_oracle` becomes a `sum(quantity)` over the deck's own folder. The **conversion of every existing claim into a placement** is what stops the release feeling like a regression.

**Tech Stack:** Rust (rusqlite/SQLite, Tauri 2.11), React 19 + TypeScript 6, Vitest, Storybook.

**Spec:** `docs/superpowers/specs/2026-08-23-collection-folders-design.md` — §1, §5, §6 are this plan.

**Base:** `origin/main` once PR 2 (#217) has merged. Branch off it fresh; do not reuse a merged branch (`pr-auto open` reports MERGED and silently creates no second PR).

## Global Constraints

- **`SCHEMA_VERSION` goes 24 → 25.** This is the rung PR 2's split deferred. The folder table already has `kind` and `deck_id` and both partial indexes, so **v25 needs no `ALTER TABLE` on `collection_folders`** — it inserts, converts, and drops.
- **`deck_allocations`, `decks.is_built` and the `app_meta` row `deck_driven_collection` all die here.** Nothing may still read them when the rung lands.
- **Only `live` deck cards ever touch the collection.** A theory list is a plan and a plan holds no cards — no theory group, and `deck_to_collection` refuses a theory row rather than silently doing nothing.
- **The DDL is spelled out literally and never interpolated from a constant**, the rung writes literal `25`, and `ALTER TABLE … DROP COLUMN` is checked against the column's indexes first (SQLite refuses to drop an indexed column).
- Never install `@types/node`. Never rename files. **Never run `prettier --write` over `src/`.**
- **Never run two `npm run verify` at once.** A background `npm run verify` gets killed mid-vitest — shard it (`npx vitest run --shard=N/3`) in the foreground; `--reporter=basic` does not exist in vitest 4.
- Conventional commits. **Subagents do not commit** — parallel agents share one git index here.

## What PR 2 already proved, and what this PR must not undo

- The eleventh grain term works on real data: the same printing in two folders is two rows.
- `collection::fold_entry` is the **single** merge implementation, five statements, and one of those five exists *only* because `deck_allocations.collection_entry_id` is `ON DELETE CASCADE`. **When that table goes, revisit `fold_entry` and delete the statements that only served it** — but not before, and with the tests watching.
- `refile_entry` deliberately has **no** `FOLDER_NOT_YOURS` fence, precisely so this PR can file into `deck` and `removed` folders. `add_entry` *does* have one, via `folder_named`, and must keep it.
- The ghost-row class of bug: a write that removes a row must be reflected on screen, or the header disagrees with the list. Every new write here can produce one.

## Ruling: `fold_entry`'s five statements shrink to three

Once `deck_allocations` is dropped, two of `fold_entry`'s five statements — the ones that fold and repoint claims before deleting the source row — reference a table that no longer exists and will not compile. Delete them **in the same task that drops the table**, and keep the remaining three (read the source, sum into the destination, delete the source). The doc comment must lose the CASCADE reasoning with them, or it explains a constraint nobody can find.

## Test fixtures the implementers must write

The test bodies below call helpers that **do not exist yet**. Write them alongside, in the style of the fixtures already in each file:

| Helper | In | Does |
| --- | --- | --- |
| `schema_at_24(conn)` | `schema.rs` | Migrate fully, then rewind to 24: delete the `removed` and `deck` folder rows, re-create `deck_allocations` and `decks.is_built`, restore the `app_meta` flag, set `user_version` to 24. **Model it on `schema_at_23` from PR 2**, and expect the same trap: SQLite refuses `DROP COLUMN` on an indexed column, and re-adding one is not symmetrical with dropping it. |
| `seed_deck(conn, name) -> i64`, `seed_entry(conn, card, qty, folder) -> i64`, `seed_entry_full(...)`, `seed_allocation(conn, deck, entry, qty)` | `schema.rs` | Direct inserts at v24 — no command exists for an allocation any more |
| `fixture() -> (Connection, deck_id, category_id)`, `second_deck(conn)`, `add_deck_card`, `add_theory_card`, `deck_card`, `file_into_group` | `collection_alloc.rs`, `deck.rs` | The usual deck fixtures; `file_into_group` writes a placement directly, since Task 3's tests must not depend on Task 2's command |
| `root_copies`, `group_copies`, `deck_copies`, `removed_copies`, `unallocated_copies`, `group_entry` | `collection_alloc.rs` | One-line `query_row` counters. Keep them counters, not assertions — a helper that asserts hides which line failed |

**`ALPHA_BOLT`, `M10_BOLT` and `BOLT_ORACLE`** in Task 3 are two printings of one oracle card seeded into `cards`; the repo already has such fixtures — reuse rather than invent, and **never hand-write a `cards` row in a test that later measures anything**, per the root `CLAUDE.md`.

## File Structure

Nine buckets in three waves. **No two buckets in a wave share a file.**

| Wave | Bucket | Files |
| --- | --- | --- |
| 1 | **A — Schema v25** | `src-tauri/src/schema.rs` |
| 2 | **B — The two writes** | `src-tauri/src/collection_alloc.rs` (new), `src-tauri/src/lib.rs` |
| 2 | **C — Allocator removal + deck lifecycle** | `src-tauri/src/deck.rs`, **`deck_meta.rs`, `deck_undo.rs`, `import.rs`** |
| 3 | **D — Theory, reconcile, reset, fold** | `src-tauri/src/deck_theory.rs`, `reconcile.rs`, `reset.rs`, `collection.rs`, **`collection_folders.rs`, `collection_source.rs`, `deck_audit.rs`** |
| 3 | **E — `is_built` out of TypeScript** | `src/lib/ipc.ts` + the 18 files listed in Task 5 |
| 3 | **F — The pinned Decks section** | `src/features/collection/*` |
| 3 | **G — Deck editor and its confirmation** | `src/features/decks/*` |
| 3 | **H — The fake and its stories** | `.storybook/fake/*` |
| 3 | **I — Docs** | `docs/reference/*`, `CLAUDE.md`, `src-tauri/CLAUDE.md` |

---

### Task 1: Bucket A — schema v25

**Files:** Modify `src-tauri/src/schema.rs`

**Interfaces — Produces:** `SCHEMA_VERSION = 25`; exactly one `collection_folders` row with `kind='removed'`; one `kind='deck'` row per `decks` row; `deck_allocations` **gone**; `decks.is_built` **gone**; the `app_meta` row gone.

- [ ] **Step 1: Write the failing tests first**

The conversion is the step that decides whether this release feels like a regression, so it gets the most exact test:

```rust
#[test]
fn v25_converts_a_claim_into_a_placement_and_splits_the_row() {
    let conn = Connection::open_in_memory().unwrap();
    schema_at_24(&conn);
    let deck = seed_deck(&conn, "Mono-Red");
    // Four copies, two of them claimed by the deck.
    let entry = seed_entry(&conn, "bolt", 4, None);
    seed_allocation(&conn, deck, entry, 2);

    migrate(&conn).unwrap();

    let folder: i64 = conn
        .query_row(
            "SELECT id FROM collection_folders WHERE deck_id = ?1",
            params![deck],
            |r| r.get(0),
        )
        .expect("the deck got its group");
    let filed: i64 = conn
        .query_row(
            "SELECT quantity FROM collection_entries WHERE folder_id = ?1",
            params![folder],
            |r| r.get(0),
        )
        .unwrap();
    let loose: i64 = conn
        .query_row(
            "SELECT quantity FROM collection_entries WHERE folder_id IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!((filed, loose), (2, 2), "the row splits; no copy is invented or lost");
}

#[test]
fn v25_moves_the_whole_row_when_every_copy_was_claimed() {
    let conn = Connection::open_in_memory().unwrap();
    schema_at_24(&conn);
    let deck = seed_deck(&conn, "Mono-Red");
    let entry = seed_entry(&conn, "bolt", 2, None);
    seed_allocation(&conn, deck, entry, 2);
    migrate(&conn).unwrap();
    let loose: i64 = conn
        .query_row(
            "SELECT count(*) FROM collection_entries WHERE folder_id IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(loose, 0, "a fully claimed row leaves nothing behind at the root");
}

#[test]
fn v25_clamps_a_claim_that_out_counts_the_row_it_claims() {
    // The old ledger could out-claim a row later stepped down; `owned_by_oracle`'s
    // `min(a.quantity, e.quantity)` papered over it. The conversion must not invent copies.
    let conn = Connection::open_in_memory().unwrap();
    schema_at_24(&conn);
    let deck = seed_deck(&conn, "Mono-Red");
    let entry = seed_entry(&conn, "bolt", 1, None);
    seed_allocation(&conn, deck, entry, 3);
    migrate(&conn).unwrap();
    let total: i64 = conn
        .query_row("SELECT sum(quantity) FROM collection_entries", [], |r| r.get(0))
        .unwrap();
    assert_eq!(total, 1, "one copy in, one copy out");
}

#[test]
fn v25_carries_the_provenance_onto_the_placement() {
    // A split must not hand the deck a bare row: the copies in the deck are the same physical
    // cards, bought on the same day for the same money.
    let conn = Connection::open_in_memory().unwrap();
    schema_at_24(&conn);
    let deck = seed_deck(&conn, "Mono-Red");
    let entry = seed_entry_full(&conn, "bolt", 4, "LP", Some(450.0), Some("Card Kingdom"));
    seed_allocation(&conn, deck, entry, 1);
    migrate(&conn).unwrap();
    let (cond, price, source): (String, Option<f64>, Option<String>) = conn
        .query_row(
            "SELECT e.condition, e.purchase_price, e.acquisition_source
               FROM collection_entries e JOIN collection_folders f ON f.id = e.folder_id
              WHERE f.deck_id = ?1",
            params![deck],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(cond, "LP");
    assert_eq!(price, Some(450.0));
    assert_eq!(source.as_deref(), Some("Card Kingdom"));
}

#[test]
fn v25_leaves_exactly_one_removed_folder_and_one_group_per_deck() {
    let conn = Connection::open_in_memory().unwrap();
    schema_at_24(&conn);
    seed_deck(&conn, "A");
    seed_deck(&conn, "B");
    migrate(&conn).unwrap();
    let removed: i64 = conn
        .query_row("SELECT count(*) FROM collection_folders WHERE kind = 'removed'", [], |r| r.get(0))
        .unwrap();
    let groups: i64 = conn
        .query_row("SELECT count(*) FROM collection_folders WHERE kind = 'deck'", [], |r| r.get(0))
        .unwrap();
    assert_eq!((removed, groups), (1, 2));
}

#[test]
fn v25_drops_the_ledger_the_flag_and_the_built_column() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    for gone in ["deck_allocations"] {
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name = ?1",
                params![gone],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "{gone} is still here");
    }
    let built: i64 = conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('decks') WHERE name = 'is_built'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(built, 0);
    let flag: i64 = conn
        .query_row(
            "SELECT count(*) FROM app_meta WHERE key = 'deck_driven_collection'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(flag, 0);
}
```

- [ ] **Step 2: Run them and watch them fail.** Report the first-run failure *messages*, not just "it failed" — a compile error proves only that a name is new.

- [ ] **Step 3: Write the rung**

Order matters: insert the folders, convert, **then** drop.

```rust
if version < 25 {
    let now = crate::db::now();
    // One holding area, and the partial index makes a second impossible.
    tx.execute(
        "INSERT INTO collection_folders (parent_id, name, kind, sort_order, created_at, updated_at)
         VALUES (NULL, 'Recently removed', 'removed', 0, ?1, ?1)",
        params![now],
    )?;
    // One group per deck, named after it. Archived decks included: an archived deck still
    // holds its cards.
    tx.execute(
        "INSERT INTO collection_folders (parent_id, name, kind, deck_id, sort_order, created_at, updated_at)
         SELECT NULL, name, 'deck', id, 0, ?1, ?1 FROM decks",
        params![now],
    )?;
    // ... the conversion (Step 4) ...
    tx.execute_batch(
        "DROP TABLE deck_allocations;
         ALTER TABLE decks DROP COLUMN is_built;
         DELETE FROM app_meta WHERE key = 'deck_driven_collection';",
    )?;
    tx.pragma_update(None, "user_version", 25)?;
}
```

**Check `is_built` is named by no index before writing that `DROP COLUMN`** — SQLite refuses to drop an indexed column, and it would fail at the first upgrade rather than in any test that uses a fresh database. It was unindexed as of 2026-08-23; verify, do not assume.

- [ ] **Step 4: Write the conversion in Rust, not SQL**

It splits rows, so it cannot be one statement. For each `deck_allocations` row ascending by id:

1. Read the source `collection_entries` row **in full**.
2. `take = min(claim.quantity, source.quantity)` — the clamp `owned_by_oracle` used to apply at read time.
3. Insert a row into that deck's group carrying **every grain column and every provenance column** — `condition`, `condition_original`, `purchase_price`, `purchase_currency`, `acquired_at`, `acquisition_source`, `notes`, `tags`, `tradelist_quantity`, `serial_number`, `grading`, and all four flags. Merge if that grain is already taken (two claims on one entry from two decks are two placements; two claims into *one* deck's group are one).
4. Reduce the source by `take`, and **delete it if it reaches 0**.

A database with no allocations — a fresh install, or one that had deck-driven on — is unaffected: every deck gets an empty group and every card stays where it was.

- [ ] **Step 5: Run the tests, watch them pass, and re-verify by breaking it.** Drop the clamp in Step 4.2 and confirm `v25_clamps_a_claim_that_out_counts_the_row_it_claims` fails; restore it. A test that cannot fail is decoration.

- [ ] **Step 6: Update both whole-schema inventories in the same edit** — `schema.rs`'s module doc loses `deck_allocations` from the `ON DELETE` census and `ALLOCATION_GRAIN` from the grain list. Re-count both totals.

- [ ] **Step 7: Verify.** `cargo test`, `cargo fmt --all`, `cargo clippy --all-targets -- -D warnings`. **Report the number selected.**

---

### Task 2: Bucket B — the two writes

**Files:** Create `src-tauri/src/collection_alloc.rs`; modify `src-tauri/src/lib.rs`

**Interfaces — Produces:**
```rust
pub fn collection_to_deck(conn, entry_id: i64, deck_id: i64, category_id: i64, quantity: i64)
    -> Result<MoveOutcome, String>;
pub fn deck_to_collection(conn, deck_card_id: i64, quantity: i64) -> Result<MoveOutcome, String>;

#[derive(Debug, Serialize)] #[serde(rename_all = "camelCase")]
pub struct MoveOutcome {
    /// The collection row the copies ended up in — **the destination's id**, which is not the
    /// id the caller handed in whenever the write merged.
    pub entry_id: Option<i64>,
    /// Set when the copies came out of another deck, so the UI can say which one it took them
    /// from **after** the fact as well as before it.
    pub from_deck: Option<String>,
    pub quantity: i64,
}
```
Commands: `collection_to_deck`, `deck_to_collection`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_card_taken_from_the_binder_leaves_the_binder() {
    let (conn, deck, cat) = fixture();
    let entry = seed_entry(&conn, "bolt", 4, None);
    collection_to_deck(&conn, entry, deck, cat, 1).unwrap();
    assert_eq!(root_copies(&conn, "bolt"), 3);
    assert_eq!(group_copies(&conn, deck, "bolt"), 1);
    assert_eq!(deck_copies(&conn, deck, "bolt"), 1);
}

#[test]
fn taking_a_copy_from_another_deck_decrements_that_deck_too() {
    // The case the UI confirms before pressing, because the side effect lands on a deck the
    // reader is not looking at.
    let (conn, a, cat_a) = fixture();
    let (b, cat_b) = second_deck(&conn);
    let entry = seed_entry(&conn, "bolt", 1, None);
    collection_to_deck(&conn, entry, a, cat_a, 1).unwrap();
    let filed = group_entry(&conn, a, "bolt");
    let out = collection_to_deck(&conn, filed, b, cat_b, 1).unwrap();
    assert_eq!(out.from_deck.as_deref(), Some("Deck A"));
    assert_eq!(deck_copies(&conn, a, "bolt"), 0, "the first deck lost the card");
    assert_eq!(deck_copies(&conn, b, "bolt"), 1);
    assert_eq!(group_copies(&conn, a, "bolt"), 0);
}

#[test]
fn a_card_cut_from_a_deck_lands_in_recently_removed() {
    let (conn, deck, cat) = fixture();
    let entry = seed_entry(&conn, "bolt", 1, None);
    collection_to_deck(&conn, entry, deck, cat, 1).unwrap();
    let dc = deck_card(&conn, deck, "bolt");
    deck_to_collection(&conn, dc, 1).unwrap();
    assert_eq!(removed_copies(&conn, "bolt"), 1);
    assert_eq!(deck_copies(&conn, deck, "bolt"), 0);
}

#[test]
fn a_deck_card_nobody_owned_just_goes_away() {
    // Added from Normal Search as "I need to buy this". There is no backing copy, so nothing
    // lands on the reader's desk — and this is why no per-deck-card provenance flag is needed.
    let (conn, deck, cat) = fixture();
    let dc = add_deck_card(&conn, deck, cat, "bolt", 1);
    deck_to_collection(&conn, dc, 1).unwrap();
    assert_eq!(removed_copies(&conn, "bolt"), 0);
    assert_eq!(deck_copies(&conn, deck, "bolt"), 0);
}

#[test]
fn a_theory_row_never_touches_the_collection() {
    let (conn, deck, cat) = fixture();
    let dc = add_theory_card(&conn, deck, cat, "bolt", 1);
    let err = deck_to_collection(&conn, dc, 1).unwrap_err();
    assert_eq!(err, THEORY_HOLDS_NOTHING);
}

#[test]
fn a_copy_in_a_deck_group_is_not_available_to_another_deck() {
    // Exclusivity, which is the whole point: it is a fact about where the row sits, not a sum.
    let (conn, a, cat_a) = fixture();
    let entry = seed_entry(&conn, "bolt", 1, None);
    collection_to_deck(&conn, entry, a, cat_a, 1).unwrap();
    let free = unallocated_copies(&conn, "bolt");
    assert_eq!(free, 0, "the only copy is spoken for");
}
```

- [ ] **Step 2: Run and watch them fail.** Report the messages.

- [ ] **Step 3: Implement**

Both are **one transaction**, for the reason every fold in this crate is one: mid-move the copies are in both places or in neither.

`collection_to_deck`:
- Refuse in words if the deck, the category or the entry is gone, or `quantity` exceeds what the source row holds. A constraint failure names the table and not the mistake.
- Split the source, **delete it at zero**, and land the copies in the deck's group **through `refile_entry`** so the merge rule is not written a second time.
- If the source folder is another deck's group, decrement that deck's **live** list by the same quantity and report its name in `from_deck`.
- Write the `deck_cards` row.

`deck_to_collection`:
- Refuse a `theory` row with `THEORY_HOLDS_NOTHING`.
- Move whatever copies **the deck's own group** holds for that printing into `Recently removed`, merging.
- Decrement or delete the `deck_cards` row.
- A deck card with **no** backing copies just goes away — this is what makes the group itself the provenance record.

Both go through `collection_source::with_write_owned`: they move rows between folders, and the search index's `owned` dimension counts rows. **PR 1 left a comment at 13 call sites saying exactly this would happen — go and read one.**

- [ ] **Step 4: Run, watch them pass, then break the implementation to confirm each test catches it.**

- [ ] **Step 5: Register both commands in `lib.rs` and verify.**

---

### Task 3: Bucket C — delete the allocator, wire the deck lifecycle

**Files:** Modify `src-tauri/src/deck.rs`

**Interfaces — Consumes:** Task 1's schema, Task 2's writes.
**Produces:** `owned_by_oracle` reads the deck's group; no `allocate_deck`, no `kind_rank`, no `Candidate`, no `is_built`.

- [ ] **Step 1: Write the failing test for the new `owned_by_oracle`**

```rust
#[test]
fn a_deck_owns_what_its_own_group_holds_across_printings() {
    // A Bolt is a Bolt: the deck lists the Alpha printing and its group holds the M10 one,
    // and it still reads owned. The old allocator matched by oracle id and this keeps that.
    let (conn, deck, cat) = fixture();
    add_deck_card(&conn, deck, cat, ALPHA_BOLT, 1);
    file_into_group(&conn, deck, M10_BOLT, 1);
    let owned = owned_by_oracle(&conn, deck).unwrap();
    assert_eq!(owned.get(BOLT_ORACLE), Some(&1));
}

#[test]
fn another_decks_group_is_not_this_decks_owned() {
    let (conn, a, cat) = fixture();
    let (b, _) = second_deck(&conn);
    add_deck_card(&conn, a, cat, ALPHA_BOLT, 1);
    file_into_group(&conn, b, ALPHA_BOLT, 1);
    assert!(owned_by_oracle(&conn, a).unwrap().is_empty());
}
```

- [ ] **Step 2: Run, watch fail, then rewrite `owned_by_oracle`**

```sql
SELECT c.oracle_id, sum(e.quantity)
  FROM collection_entries e
  JOIN collection_folders f ON f.id = e.folder_id
  JOIN cards c ON c.id = e.card_id
 WHERE f.deck_id = ?1 AND c.oracle_id IS NOT NULL
 GROUP BY c.oracle_id
```

`JOIN cards` stays an INNER join for the reason it always was: an orphaned row names no oracle card, and it reads owned 0 until the reconciler or the next sync gives it its identity back.

- [ ] **Step 3: Delete the allocator, and its call sites are NOT all in `deck.rs`**

`allocate_deck`, `kind_rank`, `struct Candidate`, `ALLOCATION_ORDER` — and every call site. A pre-flight sweep on 2026-08-23 found the live ones spread across four files, which is why this bucket owns more than `deck.rs`:

| File | Live call sites |
| --- | --- |
| `deck.rs` | the definition, plus its own callers |
| `deck_meta.rs` | `:799` (`set_category_active`) and `:1044` (`delete_category`) |
| `deck_undo.rs` | `:1175` — one call for the whole undo step, deliberately not per row |
| `import.rs` | `:949` — one call for the whole import, deliberately not per line, and `:1997-2008` is a **test that pins that**: it counts allocator runs and fails if anyone moves the call inside the loop. That test loses its subject when the allocator goes; delete it with the code rather than leaving it asserting a number about nothing. |

The run list in `src-tauri/CLAUDE.md` (every card write, the Built toggle, `missing_to_wishlist`, `set_category_active`, `delete_category`, `clear_category`, `commit_import`, the theory list switching on) is the census to check yourself against — and it goes with the allocator in Task 9. **`attribute_owned` keeps its shape** and simply reads the new map; it already filters `variant == LIVE`, which is now true by construction rather than by the table lacking a variant column.

- [ ] **Step 4: Wire the deck lifecycle**

- **Create** → create its group, named after the deck. `deck_meta::ensure_predefined_categories` is the precedent for "every deck gets this from here on".
- **Rename** → rename its group.
- **Delete** → refile the group's cards to `Recently removed` **by hand, one at a time, before** the cascade takes the folder. One at a time is what makes two of the deck's rows that collide *with each other* at the destination merge instead of raising `UNIQUE constraint failed` — `wishlist_folders::delete_folder`'s rule, and PR 2 has a test proving it matters.
- **Duplicate** → the copy gets its **own empty group**. A duplicated deck is a draft and holds no cards; `is_built` used to say that and is gone.
- **Archive** → nothing. An archived deck still holds its cards.

- [ ] **Step 5: Remove `is_built`** — `DeckRow`, `DeckPatch`, the SELECT lists, `create_deck`'s INSERT, `deck_update`'s `coalesce`, the audit-log field, and `DECK_FIELDS`. Note the history test `"deck_update (two fields at once)"` uses `is_built` only as an arbitrary second field to prove one cursor spans two history rows — **give it another field, do not delete the test.**

- [ ] **Step 6: Verify.** `cargo test`, fmt, clippy. Report the count.

---

### Task 4: Bucket D — theory, reconcile, reset, and `fold_entry`

**Files:** `src-tauri/src/deck_theory.rs`, `reconcile.rs`, `reset.rs`, `collection.rs`

- [ ] **Step 1: `deck_theory::OWNED_SPARE_SQL` off allocations.** It subtracts built decks' claims from spare copies. "Spare" now means *not in any deck's group*: `folder_id IS NULL OR folder.kind <> 'deck'`. Write the test first — a copy in a deck group is not spare.
- [ ] **Step 2: `reconcile::fold_into_existing` loses its three allocation statements** (they move claims before deleting a row). Nothing needs repointing: `collection_folders` holds no FK *into* `collection_entries`.
- [ ] **Step 3: `collection::fold_entry` shrinks from five statements to three**, per the ruling above. Delete the CASCADE reasoning from its doc with the code, or it explains a constraint nobody can find. **The existing merge tests must stay green unchanged** — that is the evidence the shrink was safe.
- [ ] **Step 4: `reset::clear_collection` loses `CollectionCleared.allocations`** (a public DTO field the settings panel renders — Bucket E removes the render). It already wipes folders; it must now **re-create** the `removed` folder and one group per surviving deck, or a wipe leaves every deck unable to hold cards.
- [ ] **Step 5: Verify.** Report the count.

---

### Task 5: Bucket E — `is_built` out of TypeScript

**Files:** `src/lib/ipc.ts`, `ipc.test.ts`, and these 17: `App.test.tsx`, `components/menu/ContextMenu.stories.tsx`, `features/card/cardMenu.test.tsx`, `features/collection/CollectionPage.test.tsx`, `features/decks/{CategoriesDialog,CreateDeckDialog,DeckEditor,DeckEditor.stories,DeckSettingsDialog,DecksPage,deckMenu}.test.tsx`, `features/decks/DeckEditor.tsx`, `features/decks/useDeck.{ts,test.ts}`, `features/decks/useDecks.test.ts`, `features/transfer/import/{ImportDialog.test.tsx,useImport.test.ts}`.

**This is mechanical.** `isBuilt` on a type goes; a fixture literal setting it loses one line; the Built toggle and its label come out of the deck editor and the settings dialog. **Do not leave a prop defaulting to `false`** — an unread prop is what the next reader wastes an hour on.

Also remove the `allocations` figure from whatever renders `CollectionCleared`.

- [ ] Verify with `npx vitest run src/features/decks src/lib src/features/transfer` and report file and test counts.

---

### Task 6: Bucket F — the pinned Decks section

**Files:** `src/features/collection/*`

PR 2 built this section and left it rendering nothing, because no `deck` or `removed` folder existed. Now they do.

- [ ] **Step 1:** Render the pinned flat section — every `kind='deck'` folder plus `Recently removed` — **beside** the reader's own nestable tree, never inside it. No rename, no delete, no drag-to-reparent.
- [ ] **Step 2:** They are **drop targets for filing a card into a deck**? **No** — a card reaches a deck group only through `collection_to_deck`, which also writes the deck card. Dragging a card onto a deck group would create a placement with no deck card behind it. Refuse the drop and say why in a comment.
- [ ] **Step 3:** `Recently removed` **is** an ordinary drop target, and a card can be dragged out of it into any user folder. That is the whole "sort them back into your collection" story of #209.
- [ ] **Step 4:** Every new write can produce a ghost row — **PR 2 shipped exactly that bug for a few hours.** Whatever removes a row from the list must be reflected on screen, and `src/lib/query.ts` caches 30 s, so a mounted query that is merely *marked* stale never refetches.
- [ ] **Step 5:** Verify with `npx vitest run src/features/collection`.

---

### Task 7: Bucket G — the deck editor and its confirmation

**Files:** `src/features/decks/*` (not `useDeck*` — Bucket E owns those)

- [ ] **Step 1:** The deck delete confirmation says where the cards go: *"Its cards move to Recently removed."* Unconditional, per the user's decision — no checkbox.
- [ ] **Step 2:** Removing a card from a **live** deck now returns copies to `Recently removed`. Say so once, where the reader can see it, without narrating it on every press.
- [ ] **Step 3:** The Built toggle comes out of the deck editor and `DeckSettingsDialog`.
- [ ] **Step 4:** Verify with `npx vitest run src/features/decks`.

---

### Task 8: Bucket H — the fake

**Files:** `.storybook/fake/*`

Mirror v25: the `removed` folder, a group per seeded deck, both new commands, no `deck_allocations`, no `isBuilt`. **Re-count the method-count sweep in `db.test.ts` and record the move in its archaeology comment** — it went 59 → 64 in PR 2. Expect story-play breakage tree-wide; that is the controller's at fan-in.

---

### Task 9: Bucket I — docs

**Files:** `docs/reference/*`, `CLAUDE.md`, `src-tauri/CLAUDE.md`

- `collection-folders.md` gains the deck groups, `Recently removed`, and the v25 conversion.
- `decks-storage.md` **loses the allocator wholesale** — it is one of that page's largest sections, and every sentence about claims, availability and the run list goes with it.
- `deck-driven-collection.md` is already gone; check nothing links to it.
- Re-count every total touched, in the same edit.

---

### Task 10: Fan-in

- [ ] **Prove v24 → v25 on a copy of the real dev database**, seeded with allocations first. A worktree is a fresh install and can never show an upgrade bug. `Copy-Item` carries the source mtime — re-stamp the copy, or cargo re-runs a stale binary and fmt/clippy/test all pass without running.
- [ ] **Full verify, sharded.** Redirect to a file and grep it: `| tail` reports tail's exit 0 while tests fail.
- [ ] **Whole-diff review**, one fix wave, one scoped re-review.
- [ ] **Drive the real window**: file a card into a deck from the collection, cut it from the deck and find it in `Recently removed`, confirm a second deck cannot see a spoken-for copy, and delete a deck holding cards. Take the app lock; **release it when done**.
- [ ] **Ship** with `auto-pr`. PR body carries **`Closes #209`**.
