# Deck undo and redo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Ctrl+Z` / `Ctrl+Y` in the deck editor, undoing as far back as the deck's recorded
history and redoing for the length of the session.

**Architecture:** A new `deck_undo` journal table, keyed 1:1 to a `deck_audit` row, holds a JSON
step of four restore primitives (`cards`, `categories`, `tags`, `deck`). Every deck write records
one beside its audit row, in the same transaction. Undo applies `step.undo` and stamps
`undone_at`; redo applies `step.redo` from an in-memory queue. `deck_audit` and `auditText.ts`'s
payload contract are untouched.

**Tech Stack:** Rust (rusqlite, serde_json), React 19 + TypeScript 6, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-15-deck-undo-redo-design.md`

## Global Constraints

- Schema step is **v17** and goes at the **bottom** of `migrate`'s ladder, taking the
  `CARDS_INDEXES` replay from the step below it. `SCHEMA_VERSION` becomes `17`.
- `AUDIT_KINDS` **stays at nine**. An undo is `kind: "deck"`, payload
  `{ field: "undo" | "redo", of: <auditId> }`.
- `deck_audit_list`'s SELECT, `DeckAuditEntry` and `auditText.ts`'s existing arms do not change.
- `deck_undo::record_step` is called **inside the caller's open transaction**, never opening one
  — the rule `deck_audit::record` already follows, for the same reason.
- Every apply command ends with **one** `deck::allocate_deck` run.
- `aria-disabled`, never the `disabled` attribute, on the toolbar buttons.
- Never install `@types/node`. TypeScript stays on 6.0.x.
- Run `npm run verify` before every commit; never two at once.

---

### Task 1: Schema v17 — the `deck_undo` table

**Files:**
- Modify: `src-tauri/src/schema.rs` (`SCHEMA_VERSION`, a new `if v < 17` block at the bottom of
  `migrate`, a `UNDO_V17` rewind constant beside `UNDO_V16`)
- Test: `src-tauri/src/schema.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: nothing.
- Produces: table `deck_undo (audit_id INTEGER PRIMARY KEY, deck_id INTEGER NOT NULL, step TEXT
  NOT NULL, undone_at INTEGER)` and `idx_deck_undo_deck`.

- [ ] **Step 1: Write the failing test**

In `schema.rs`'s test module:

```rust
/// The undo journal is 1:1 with a history row and dies with it — both CASCADEs, because a
/// journal entry for a change nobody can see is a step undo would apply into nothing.
#[test]
fn the_undo_journal_cascades_from_its_history_row_and_its_deck() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    conn.execute_batch(
        "INSERT INTO decks (id, name, created_at, updated_at)
             VALUES (1, 'Burn', unixepoch(), unixepoch());
         INSERT INTO deck_audit (id, deck_id, at, variant, kind, payload, delta)
             VALUES (7, 1, unixepoch(), 'live', 'add', '{}', 1);
         INSERT INTO deck_undo (audit_id, deck_id, step)
             VALUES (7, 1, '{\"undo\":[],\"redo\":[]}');",
    )
    .unwrap();
    let left = |conn: &Connection| -> i64 {
        conn.query_row("SELECT count(*) FROM deck_undo", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(left(&conn), 1);
    conn.execute("DELETE FROM deck_audit WHERE id = 7", []).unwrap();
    assert_eq!(left(&conn), 0, "a deleted history row takes its step with it");
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd src-tauri && cargo test the_undo_journal_cascades`
Expected: FAIL — `no such table: deck_undo`.

- [ ] **Step 3: Add the migration step**

`SCHEMA_VERSION` → `17`. At the **bottom** of `migrate`, after the `if v < 16` block:

```rust
if v < 17 {
    let tx = conn.unchecked_transaction()?;
    // Undo's own journal, and deliberately not a column on `deck_audit`.
    //
    // That table is append-only, never pruned, and read whole every time the history drawer
    // opens; a category delete's step carries the rows the CASCADE took, which is orders of
    // magnitude larger than the sentence it would sit beside. `auditText.ts` is the only
    // reader of `payload` and stays so — `deck_audit_list`'s SELECT does not change here.
    //
    // `audit_id` is the primary key, so the journal is 1:1 with a history row by construction
    // and a step cannot be recorded twice for one change. `deck_id` is denormalized from
    // `deck_audit` because it is what the cursor's index needs, and the cursor is the hottest
    // query in the feature.
    //
    // **Both CASCADEs are load-bearing**: a deleted deck takes its history and its journal,
    // which is what keeps `deleting_a_deck_takes_its_history_with_it` true of this table for
    // free, and a step for a change nobody can see is a step undo would apply into nothing.
    //
    // `undone_at` NULL means "still applied". It **persists**, so undo survives a restart and
    // continues below where it stopped; redo is deliberately in memory and does not.
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS deck_undo (
            audit_id INTEGER PRIMARY KEY
                REFERENCES deck_audit(id) ON DELETE CASCADE,
            deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
            -- The reversal, both ways: {\"undo\":[Op,...],\"redo\":[Op,...]}. JSON for
            -- `payload`'s reason one table over — the shapes are Rust's and a step written by
            -- a newer build must not fail an older one's read of the row beside it.
            step TEXT NOT NULL CHECK (json_valid(step)),
            undone_at INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_deck_undo_deck
            ON deck_undo (deck_id, audit_id DESC);",
    )?;
    tx.execute_batch("PRAGMA user_version = 17;")?;
    tx.commit()?;
}
```

Add beside `UNDO_V16` in the test module:

```rust
/// Undoes v17 for a rewind fixture. `CREATE TABLE IF NOT EXISTS` is idempotent, so this is
/// only needed by fixtures that claim a version below 17 and must not find the table already
/// there when the step replays.
const UNDO_V17: &str = "DROP TABLE IF EXISTS deck_undo;";
```

…and append `{UNDO_V17}` to every rewind fixture that already interpolates `{UNDO_V16}`.

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test schema::`
Expected: PASS, including `the_migration_reaches_the_current_version`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/schema.rs
git commit -m "feat(decks): schema v17 adds the deck_undo journal"
```

---

### Task 2: `deck_undo.rs` — the step, the four primitives, the cursor

**Files:**
- Create: `src-tauri/src/deck_undo.rs`
- Modify: `src-tauri/src/lib.rs` (`mod deck_undo;`)

**Interfaces:**
- Consumes: `crate::deck::allocate_deck`, `crate::deck_meta::valid_variant`.
- Produces:
  - `pub struct CardRow { category_id, variant, card_id, set_code, collector_number, lang, name, tag_id, quantity, needs_review }`
  - `pub struct Cell { variant: String, category_id: i64, card_id: Option<String> }` — `card_id`
    `None` means every card of that `(variant, category)`
  - `pub enum Op { Cards { scope: Vec<Cell>, rows: Vec<CardRow> }, WholeVariant { variant: String, rows: Vec<CardRow> }, Categories { rows: Vec<CategoryRow>, delete: Vec<i64>, default_category_id: Option<i64> }, Tags { rows: Vec<TagRow>, delete: Vec<i64>, carriers: Vec<(i64, Option<i64>)> }, Deck { fields: serde_json::Map<String, Value> } }`
  - `pub struct Step { undo: Vec<Op>, redo: Vec<Op> }`
  - `pub fn record_step(tx: &Connection, audit_id: i64, deck_id: i64, step: &Step) -> Result<(), String>`
  - `pub fn last_audit_id(tx: &Connection) -> i64` — `tx.last_insert_rowid()`, named so the
    call sites read as intent
  - `pub fn read_cells(tx: &Connection, deck_id: i64, cells: &[Cell]) -> Result<Vec<CardRow>, String>`
  - `pub fn read_variant(tx: &Connection, deck_id: i64, variant: &str) -> Result<Vec<CardRow>, String>`
  - `pub fn apply(tx: &Connection, deck_id: i64, ops: &[Op]) -> Result<(), String>`
  - `pub fn next_undo(conn: &Connection, deck_id: i64) -> Result<Option<i64>, String>`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn a_cards_op_restores_exactly_the_cells_it_names_and_nothing_else() {
    let conn = seeded();
    let id = deck(&conn, "Burn");
    let ramp = category(&conn, id, "Ramp");
    let other = category(&conn, id, "Draw");
    crate::deck::add_card(&conn, id, "bolt-lea", Some(ramp), None, "live", 2).unwrap();
    crate::deck::add_card(&conn, id, "serra-lea", Some(other), None, "live", 1).unwrap();

    let cells = vec![Cell {
        variant: "live".to_owned(),
        category_id: ramp,
        card_id: Some("bolt-lea".to_owned()),
    }];
    let before = read_cells(&conn, id, &cells).unwrap();
    crate::deck::set_card_quantity(&conn, id, "bolt-lea", ramp, "live", 5).unwrap();

    apply(&conn, id, &[Op::Cards { scope: cells.clone(), rows: before }]).unwrap();

    let qty = |cat: i64, card: &str| -> i64 {
        conn.query_row(
            "SELECT coalesce(sum(quantity), 0) FROM deck_cards
              WHERE deck_id = ?1 AND category_id = ?2 AND card_id = ?3 AND variant = 'live'",
            params![id, cat, card],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(qty(ramp, "bolt-lea"), 2, "the named cell is back as it was");
    assert_eq!(qty(other, "serra-lea"), 1, "a cell the scope did not name is untouched");
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd src-tauri && cargo test deck_undo::`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module**

`Op` is `#[serde(tag = "op", rename_all = "camelCase")]`. `apply` matches each arm:

- `Cards` — for each `Cell`, `DELETE FROM deck_cards WHERE deck_id = ?1 AND variant = ?2 AND
  category_id = ?3 AND (?4 IS NULL OR card_id = ?4)`; then insert every `CardRow` verbatim with
  fresh `created_at`/`updated_at`. **`id` is not restored** — a restored row is a new row, and
  `deck_allocations` holds `collection_entry_id`s, so nothing points at the old one.
- `WholeVariant` — the same with one `DELETE … WHERE deck_id = ?1 AND variant = ?2`.
- `Categories` — `DELETE FROM deck_categories WHERE id IN (delete)`, then for each `CategoryRow`
  an `INSERT … ON CONFLICT(id) DO UPDATE` naming `id` explicitly. If the id is taken by a
  category of another deck, insert under a new id and `UPDATE deck_cards SET category_id = <new>
  WHERE category_id = <old> AND deck_id = ?`. Then `UPDATE decks SET default_category_id = ?`
  when `default_category_id` is `Some`.
- `Tags` — the mirror, plus `UPDATE deck_cards SET tag_id = ?2 WHERE id = ?1` for each carrier.
- `Deck` — one `UPDATE decks SET <col> = ?` per key in `fields`, whitelisted against a fixed
  const array so a step cannot name an arbitrary column.

`record_step` inserts into `deck_undo` and takes `&Connection` for `record`'s reason
(`Transaction` derefs to it). `next_undo` is:

```sql
SELECT audit_id FROM deck_undo
 WHERE deck_id = ?1 AND undone_at IS NULL
 ORDER BY audit_id DESC LIMIT 1
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test deck_undo::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/deck_undo.rs src-tauri/src/lib.rs
git commit -m "feat(decks): the undo step and its four restore primitives"
```

---

### Task 3: Record a step at every card write

**Files:**
- Modify: `src-tauri/src/deck.rs` — `add_card`, `set_card_quantity`, `clear_category`,
  `move_card`, `swap_printing`
- Test: `src-tauri/src/deck_undo.rs` tests

**Interfaces:**
- Consumes: Task 2's `read_cells`, `record_step`, `last_audit_id`, `Cell`, `Op`, `Step`.
- Produces: a `deck_undo` row for each of the five commands.

Each site reads the cells it is about to change **before** the write, records the audit row as it
does today, then records the step keyed to `tx.last_insert_rowid()`.

- [ ] **Step 1: Write the failing test** — the sweep, mirroring
  `every_deck_write_leaves_exactly_one_audit_row`:

```rust
/// Every deck write records a step, and undoing it puts the deck back exactly.
///
/// Written as a list of closures for `every_deck_write_leaves_exactly_one_audit_row`'s reason:
/// the claim is about the *set* of commands, and a new write that records no step fails here
/// the moment its line is added. **Count the list, never a remembered number.**
#[test]
fn undoing_any_deck_write_restores_the_deck_exactly() {
    for (name, drive) in card_write_cases() {
        let (conn, id) = fresh();
        let before = snapshot(&conn, id);
        drive(&conn, id);
        let step = next_undo(&conn, id).unwrap().expect(name);
        undo(&conn, id, step).unwrap();
        assert_eq!(snapshot(&conn, id), before, "`{name}` must undo exactly");
    }
}
```

`snapshot` reads `deck_cards` (every column but `id`/`created_at`/`updated_at`),
`deck_categories`, `deck_tags` and the `decks` columns into a sorted `Vec<String>`.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd src-tauri && cargo test undoing_any_deck_write`
Expected: FAIL — `next_undo` answers `None`.

- [ ] **Step 3: Wire the five sites**

`add_card` / `set_card_quantity` / `set_card_tag`-shaped: one `Cell`.
`move_card`: two cells (from and to).
`swap_printing`: two cells, which is what carries the **fold** back — both pre-fold rows are in
`rows`.
`clear_category`: one `Cell` with `card_id: None`.

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test deck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/deck.rs src-tauri/src/deck_undo.rs
git commit -m "feat(decks): record an undo step at every card write"
```

---

### Task 4: Record a step at every deck-row, import and theory write

**Files:**
- Modify: `src-tauri/src/deck.rs` (`update_deck`, `set_folder`, `set_cover_image`),
  `src-tauri/src/deck_import.rs` (`commit_import`), `src-tauri/src/deck_theory.rs`
  (`copy_from_live`)

- [ ] **Step 1: Add these cases to `undoing_any_deck_write_restores_the_deck_exactly`**, one per
  command, including `update_deck` with **two** changed fields (one step, two audit rows) and
  `commit_import` in both modes.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Wire them.** `update_deck` records **one** step keyed to its *last* audit row,
  carrying an `Op::Deck` of the changed columns — **plus** an `Op::WholeVariant` for each variant
  when `move_live_into_theory` ran. `commit_import` reads the whole variant before it writes and
  records one `Op::WholeVariant`, both modes. `copy_from_live` records one on `theory`.
- [ ] **Step 4: Run `cargo test`.**
- [ ] **Step 5: Commit** `feat(decks): record an undo step at every deck-row write`.

---

### Task 5: Record a step at every category, tag and folder write

**Files:**
- Modify: `src-tauri/src/deck_meta.rs` — `create_category`, `rename_category`,
  `set_category_active`, `reorder_categories`, `delete_category`, `create_tag`, `update_tag`,
  `delete_tag`, `set_card_tag`, `delete_folder`

- [ ] **Step 1: Add these ten cases to the sweep**, plus the id-collision test:

```rust
/// A category comes back with its own id, and the cards under it still resolve — even when
/// that id has been taken since, which is the case a plain re-insert gets silently wrong.
#[test]
fn a_restored_category_keeps_its_cards_even_when_its_id_was_reused() { /* … */ }
```

- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Wire them.** `delete_category` reads its `deck_categories` row, both variants'
  cards under it and the deck's `default_category_id` before the DELETE. `delete_tag` reads the
  tag row and every `deck_cards.id` wearing it. `reorder_categories` reads every id's
  `sort_order`. `delete_folder` records one `Op::Deck` per re-filed deck, keyed to its last audit
  row.
- [ ] **Step 4: Run `cargo test`.**
- [ ] **Step 5: Commit** `feat(decks): record an undo step at every category and tag write`.

---

### Task 6: The three commands

**Files:**
- Modify: `src-tauri/src/deck_undo.rs` (the commands), `src-tauri/src/lib.rs` (registration)

**Interfaces:**
- Produces:
  - `deck_undo_state(deckId) -> DeckUndoState { undo: Option<DeckAuditEntry>, redo: Option<DeckAuditEntry> }`
  - `deck_undo_apply(deckId, auditId) -> ()`
  - `deck_redo_apply(deckId, auditId) -> ()`

- [ ] **Step 1: Write the failing tests** — apply/refuse on a stale id, the round trip (undo then
  redo leaves the deck as it was after the write), and that a refused apply leaves no history and
  no `undone_at`.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.** Both apply commands: take the write lock, open one transaction,
  check the id **is** the cursor (else refuse in words), `apply` the ops, stamp/clear `undone_at`,
  `record` a `deck` audit row with `{field: "undo"|"redo", of: <auditId>}` and the negated/original
  delta, record **no** step for it, `allocate_deck`, commit.
- [ ] **Step 4: Run `cargo test && cargo clippy -- -D warnings`.**
- [ ] **Step 5: Commit** `feat(decks): deck_undo_state, deck_undo_apply and deck_redo_apply`.

---

### Task 7: The TypeScript mirror, the session redo queue and the sentences

**Files:**
- Modify: `src/lib/ipc.ts`, `src/features/decks/auditText.ts`
- Create: `src/features/decks/useDeckUndo.ts`
- Test: `src/features/decks/useDeckUndo.test.ts`, `src/features/decks/auditText.test.ts`

**Interfaces:**
- Produces: `interface DeckUndoState { undo: DeckAuditEntry | null; redo: DeckAuditEntry | null }`,
  `ipc.deckUndoState`, `ipc.deckUndoApply`, `ipc.deckRedoApply`, and
  `useDeckUndo(deckId): { undo, redo, canUndo, canRedo, undoLabel, redoLabel }`.

- [ ] **Step 1: Write the failing tests.** `auditText`: a `deck` row with `field: "undo"` renders
  `Undid: <the sentence of the row it names>` and falls back to a bare `Undid a change` when that
  row is not in the list. `useDeckUndo`: the redo queue is cleared by any other deck write, and is
  empty on mount (it is memory, not storage).
- [ ] **Step 2: Run `npm run test:run -- auditText useDeckUndo`.** Expected: FAIL.
- [ ] **Step 3: Implement.** `auditSentence` gains an optional second argument — the day's entries
  — so the `undo`/`redo` arms can look up `of` and recurse. The redo queue is `useState` in the
  hook, keyed by deck id, cleared in `useDeck`'s shared `onSuccess`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(decks): the undo hook, its session redo queue and its sentences`.

---

### Task 8: The buttons, the shortcuts and the greyed history rows

**Files:**
- Modify: `src/features/decks/DeckEditor.tsx`, `src/features/decks/DeckHistoryDialog.tsx`
- Test: `src/features/decks/DeckEditor.test.tsx`, `src/features/decks/DeckHistoryDialog.test.tsx`

- [ ] **Step 1: Write the failing tests.** `Ctrl+Z` calls the undo mutation; `Ctrl+Y` and
  `Ctrl+Shift+Z` call redo; **a `Ctrl+Z` with the caret in the quick-add field calls neither**
  (`isTextField` from `useContextMenu.ts`); both buttons carry `aria-disabled` with a reason when
  there is nothing to do.
- [ ] **Step 2: Run `npm run test:run -- DeckEditor`.** Expected: FAIL.
- [ ] **Step 3: Implement.** One `keydown` listener on `window`, registered in `DeckEditor`, that
  returns early on `isTextField(e.target)`. Two buttons in the header's actions block at
  `FILTER_CONTROL` height, each labelled from `undoLabel`/`redoLabel`. Both mutations join
  `newestWrite([...])`. `DeckHistoryDialog` dims a row whose `id` is in the undone set.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(decks): undo and redo in the deck editor toolbar and on Ctrl+Z`.

---

### Task 9: The Storybook fake, and the docs

**Files:**
- Modify: `.storybook/fake/db.ts` (the three new commands), `docs/reference/decks-storage.md`,
  `src-tauri/CLAUDE.md`, `src/features/decks/CLAUDE.md`, `CLAUDE.md`'s schema line

- [ ] **Step 1: Add the three commands to the fake** so the deck editor's stories still render —
  `deck_undo_state` answering `{undo: null, redo: null}` is the floor, and one seeded step is what
  makes the buttons drawable in a story.
- [ ] **Step 2: Correct the prose that this change falsifies.** `decks-storage.md` says the audit
  log is "**not undoable**"; `src-tauri/CLAUDE.md` says schema is at **v16** and lists the
  allocator's write sites. Both need the new sentence, and the allocator list gains the two apply
  commands.
- [ ] **Step 3: Run `npm run verify`.** Expected: green.
- [ ] **Step 4: Commit** `docs(decks): record undo and redo`.

---

## Self-review

**Spec coverage.** §2 → Task 1. §3, §4 → Task 2. §5's cursor → Task 2 + 6; its audit row → Task 6
+ 7. §6's table of write sites → Tasks 3, 4, 5. §7 → Task 6. §8 is a set of deliberate absences
and needs no task beyond the prose in Task 9. §9 → Task 8. §10 → the test step of each task.

**Known gap, deliberately left:** §8.3 — `deck_folder_delete` puts the decks back but does not
resurrect the folder row, because `deck_audit.deck_id` is `NOT NULL` and a folder belongs to no
deck. Task 5 implements exactly that and Task 9 writes it down.
