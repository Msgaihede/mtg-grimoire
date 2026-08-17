# A deck card names a finish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deck can hold `1 × Sol Ring (foil)` beside `3 × Sol Ring` in the same pile; the deck's
money follows the finish; and two controls set it — the card pane's existing foil button and a row
on a deck card's right-click menu.

**Architecture:** `deck_cards` gains a nullable `finish` (schema v18) and `DECK_CARD_GRAIN` gains
`coalesce(finish, '')`, so a foil row and a regular row of one printing are two rows that fold
independently. NULL means regular and `'nonfoil'` is never stored — a CHECK enforces it and one
Rust function normalises it. Price branches on NULL: today's chain when unsaid, `price_expr` at
that finish alone when said.

**Tech Stack:** Rust (rusqlite, Tauri 2.11), React 19 + TypeScript 6, TanStack Query, Vitest,
Storybook.

**Spec:** `docs/superpowers/specs/2026-08-17-deck-card-finish-design.md` — read it before Task 1.
Every task argues from it.

## Global Constraints

- **Run `npm run verify` before every commit.** Frontend tests, tsc, eslint and `cargo test`.
  Never run two verifies at once — concurrent runs fake ~18 Rust schema failures.
- **`npm run verify` does not run `cargo fmt`.** CI's Linux rust job does. Run
  `cargo fmt --manifest-path src-tauri/Cargo.toml` before the final push.
- **`SCHEMA_VERSION` is 17 today. This branch makes it 18 and no more.** A version that has shipped
  is spent; migration steps are frozen history and are never edited.
- **Grain constants are never read by a migration step.** Every index in the DDL is spelled out as
  a literal.
- **`aria-disabled`, never the `disabled` attribute**, on any greyed menu row or control.
- **Dim text is `text-dim`, never `text-muted`.**
- **Ripgrep reads `.storybook/fake/db.ts` and `docs/reference/decks-storage.md` as binary.** A Grep
  that returns nothing in those two files is lying. Use Read or `Select-String`.
- **Never install `@types/node`.**
- **Commit small**, one commit per task, `feat:`/`fix:`/`test:`/`docs:`/`chore:`.

---

## File Structure

**Rust — `src-tauri/src/`**

| File | Responsibility in this change |
| --- | --- |
| `schema.rs` | The v18 step, `DECK_CARD_GRAIN`, and the one test that stops covering it |
| `sorting.rs` | `deck_card_price_expr` — the NULL/set branch |
| `deck.rs` | `normalise_finish`, the `finish` argument on five commands, `set_card_finish`, `DeckCardRow.finish` |
| `deck_undo.rs` | `CardRow.finish` — and `Cell` deliberately unchanged |
| `deck_import.rs` | `ImportItem.finish` |
| `deck_theory.rs` | the copy carries the finish |
| `lib.rs` | register `deck_set_card_finish` |

**TypeScript — `src/`**

| File | Responsibility in this change |
| --- | --- |
| `lib/ipc.ts` | `DeckCard.finish`, `ImportItem.finish`, the `finish` argument on five calls, `deckSetCardFinish` |
| `features/decks/useDeck.ts` | `Slot.finish`, `patchSlot`, `setCardFinish` mutation |
| `features/decks/deckCardMenu.tsx` | the finish row — the whole new menu surface |
| `features/decks/DeckEditor.tsx` | `setQuantityAt`/`applyDrop` threading, `newestWrite` gains the mutation |
| `features/decks/dnd.ts` | the `deck-card` payload carries the finish |
| `features/decks/views/*.tsx` | the mark, and the row key |
| `features/decks/import/parse.ts` | capture `*F*`/`*E*` instead of discarding |
| `features/decks/import/plan.ts` | carry it to `ImportItem` |
| `features/decks/export/format.ts` | write it in four of six formats |
| `features/card/CardDetailPane.tsx` | the button's label and its write |
| `.storybook/fake/db.ts` | the column, and a seeded foil row |

---

## Task 1: The column, the grain, and the five SQLite mechanics

**Files:**
- Modify: `src-tauri/src/schema.rs` — `SCHEMA_VERSION`, `DECK_CARD_GRAIN`, a new `v < 18` step,
  and `every_plain_grain_constant_names_the_index_the_head_schema_carries`
- Test: `src-tauri/src/schema.rs` (inline `#[cfg(test)]`)

**Interfaces:**
- Produces: `schema::DECK_CARD_GRAIN == "deck_id, variant, category_id, card_id, coalesce(finish, '')"`,
  and a `deck_cards.finish TEXT` column CHECKed to `NULL | 'foil' | 'etched'`.

- [ ] **Step 1: Write the failing tests**

Add to `schema.rs`'s test module:

```rust
/// The grain widens rather than the row changing meaning: a foil copy and a regular copy of
/// one printing, in one pile of one list, are two rows — and each folds on its own.
///
/// `coalesce(finish, '')` is what makes the second half true. SQLite treats NULLs in a UNIQUE
/// index as *distinct*, so a bare nullable column in a grain enforces nothing at all and every
/// regular add would insert a new row instead of adding to the one there.
#[test]
fn a_foil_row_and_a_regular_row_of_one_printing_are_two_rows_that_fold_apart() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    seed_one_deck(&conn);

    let sql = format!(
        "INSERT INTO deck_cards
            (deck_id, category_id, variant, card_id, set_code, collector_number, lang, name,
             finish, quantity, created_at, updated_at)
         VALUES (1, 1, 'live', 'c1', 'LEA', '1', 'en', 'Sol Ring', ?1, 1,
                 unixepoch(), unixepoch())
         ON CONFLICT({grain}) DO UPDATE SET quantity = deck_cards.quantity + excluded.quantity",
        grain = DECK_CARD_GRAIN
    );
    for finish in [None, None, None, Some("foil")] {
        conn.execute(&sql, params![finish]).unwrap();
    }

    let mut stmt = conn
        .prepare("SELECT finish, quantity FROM deck_cards ORDER BY coalesce(finish, '')")
        .unwrap();
    let rows: Vec<(Option<String>, i64)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        rows,
        vec![(None, 3), (Some("foil".to_owned()), 1)],
        "three regular adds fold into one row; the foil add is its own"
    );
}

/// `'nonfoil'` is never stored — NULL is the only spelling of regular, and the CHECK is what
/// makes any other path a hard error rather than a second row that draws identically.
#[test]
fn the_deck_card_finish_column_refuses_nonfoil() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    seed_one_deck(&conn);

    let insert = "INSERT INTO deck_cards
            (deck_id, category_id, variant, card_id, set_code, collector_number, lang, name,
             finish, quantity, created_at, updated_at)
         VALUES (1, 1, 'live', 'c1', 'LEA', '1', 'en', 'Sol Ring', ?1, 1,
                 unixepoch(), unixepoch())";
    let err = conn.execute(insert, params!["nonfoil"]).unwrap_err();
    assert!(
        err.to_string().contains("CHECK constraint failed"),
        "the column vocabulary is the database's, not a convention: {err}"
    );
    for good in [None, Some("foil"), Some("etched")] {
        conn.execute("DELETE FROM deck_cards", []).unwrap();
        conn.execute(insert, params![good]).unwrap();
    }
}

/// Every deck that predates v18 reads regular, which is what it already meant. No backfill.
#[test]
fn v17_deck_rows_come_through_the_v18_step_as_regular() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    seed_one_deck(&conn);
    conn.execute(
        "INSERT INTO deck_cards
            (deck_id, category_id, variant, card_id, set_code, collector_number, lang, name,
             quantity, created_at, updated_at)
         VALUES (1, 1, 'live', 'c1', 'LEA', '1', 'en', 'Sol Ring', 2, unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    let finish: Option<String> = conn
        .query_row("SELECT finish FROM deck_cards", [], |r| r.get(0))
        .unwrap();
    assert_eq!(finish, None, "a row that says nothing is regular");
}
```

`seed_one_deck` is a helper this module may already have in some form — if not, add it beside the
tests:

```rust
/// One deck with one category, the minimum a `deck_cards` row needs to satisfy its two real
/// foreign keys.
fn seed_one_deck(conn: &Connection) {
    conn.execute(
        "INSERT INTO decks (id, name, created_at, updated_at)
         VALUES (1, 'T', unixepoch(), unixepoch())",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO deck_categories (id, deck_id, name, kind, is_active, sort_order, origin)
         VALUES (1, 1, 'Main deck', 'main', 1, 0, 'user')",
        [],
    )
    .unwrap();
}
```

If `decks`/`deck_categories` at head require columns beyond these, read the v18-adjacent DDL and
add them — do not weaken the test to fit.

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml a_foil_row_and_a_regular_row -- --nocapture
```

Expected: FAIL — `table deck_cards has no column named finish`.

- [ ] **Step 3: Bump the version and widen the grain constant**

In `schema.rs`:

```rust
pub const SCHEMA_VERSION: i64 = 18;
```

and replace `DECK_CARD_GRAIN`'s value and the paragraph of its doc comment that begins "No
`coalesce` is needed here":

```rust
pub const DECK_CARD_GRAIN: &str = "deck_id, variant, category_id, card_id, coalesce(finish, '')";
```

Replace that paragraph with:

```
/// **`coalesce(finish, '')` is [`COLLECTION_GRAIN`]'s device, for its reason.** `finish` is
/// nullable — NULL is the regular copy, and `'nonfoil'` is never stored — and SQLite treats
/// NULLs in a UNIQUE index as *distinct*, so the bare column would enforce nothing: every
/// regular add would insert a new row rather than folding into the one already there. It is
/// v18 and it widens the grain a third time, for `category_id`'s and `variant`'s reason —
/// a foil copy and a regular copy of one printing are two intentions, not one row that
/// changed.
```

- [ ] **Step 4: Write the v18 migration step**

Append to `migrate`, after the `v < 17` block, following the shape every step above it uses:

```rust
if v < 18 {
    let tx = conn.unchecked_transaction()?;
    // The column is nullable and NULL is the regular copy, so every row that predates this
    // step is already correct and there is no backfill. `'nonfoil'` is deliberately NOT in
    // the vocabulary: two spellings of "regular" would be two rows on the grain below that
    // draw identically on screen, which is the worst shape a bug in this table can have.
    // `deck::normalise_finish` maps an incoming `nonfoil` to NULL, and this CHECK is what
    // makes any other path a hard error rather than a quiet second row.
    //
    // A literal index, not `{DECK_CARD_GRAIN}` — a step is history the day it ships. This is
    // the third time this index has been rebuilt (v5 created it, v8 widened it) and each of
    // those steps still builds the index it built then.
    tx.execute_batch(
        "ALTER TABLE deck_cards ADD COLUMN finish TEXT
            CHECK (finish IS NULL OR finish IN ('foil','etched'));
         DROP INDEX IF EXISTS idx_deck_cards_grain;
         CREATE UNIQUE INDEX idx_deck_cards_grain
            ON deck_cards (deck_id, variant, category_id, card_id, coalesce(finish, ''));",
    )?;
    // Literal `18`, for the reason every step before it writes its own.
    tx.execute_batch("PRAGMA user_version = 18;")?;
    tx.commit()?;
}
```

- [ ] **Step 5: Take `DECK_CARD_GRAIN` out of the plain-grain test**

In `every_plain_grain_constant_names_the_index_the_head_schema_carries`, remove the
`("idx_deck_cards_grain", DECK_CARD_GRAIN)` entry from the array. Then fix the two sentences in
that test's doc comment that are now false:

- "[`COLLECTION_GRAIN`], [`WISHLIST_GRAIN`] and [`DECK_CARD_GRAIN`] are held to their indexes by
  their `ON CONFLICT` targets (the test above, and every deck-card upsert); these four are held
  here." → **"…; these three are held here."** (the list drops to three)
- "The two grains with `coalesce(…)` in them cannot be checked this way" → **"The three grains
  with `coalesce(…)` in them"**

The grain is still held honest — by every `ON CONFLICT ({DECK_CARD_GRAIN})` target in `deck.rs`,
`deck_meta.rs` and `deck_theory.rs`, where a mismatch is a hard runtime error at the first write.

- [ ] **Step 6: Check the version-count test**

`schema.rs` carries `assert_eq!(SCHEMA_VERSION, 17);` (around line 5738) in a test whose job is to
catch a bump with no step behind it. Change the literal to `18`. Search for other literal `17`s in
migration-ladder fixtures — `SCHEMA_VERSION - 1` fixtures are pinned deliberately and some carry a
literal with a comment saying so; read each before touching it.

- [ ] **Step 7: Run the tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml schema -- --nocapture
```

Expected: PASS, including every existing ladder test reaching head.

- [ ] **Step 8: Commit**

```powershell
git add src-tauri/src/schema.rs
git commit -m "feat(schema): v18 — deck_cards.finish, and the grain widens with it"
```

---

## Task 2: The price branches on the finish

**Files:**
- Modify: `src-tauri/src/sorting.rs` — add `deck_card_price_expr`, rewrite
  `printing_price_by_finish_expr`'s opening doc paragraph
- Modify: `src-tauri/src/deck.rs` — `DECK_CARD_SELECT`'s price column
- Test: `src-tauri/src/sorting.rs` (inline)

**Interfaces:**
- Consumes: nothing from Task 1 at compile time; it is ordered after it because the column has to
  exist for `deck.rs` to select on.
- Produces: `pub fn deck_card_price_expr(market: Marketplace) -> String`.

- [ ] **Step 1: Write the failing test**

```rust
/// A deck row's figure, which is two rules rather than one.
///
/// **Unsaid is the chain.** A row with no finish is every row that predates v18 and every row
/// a reader has not spoken about, and `nonfoil → foil → etched` is what it has always been
/// priced at — the rule that stopped 13 515 foil-only printings reading as unpriced.
///
/// **Said is that finish alone.** No fallback, at either end: a foil row quoted at the nonfoil
/// rate is a price nobody quoted, which is the same rule `finish.rs`'s `PRICE_KEY` hole and
/// this module's Cardmarket arm already state.
#[test]
fn a_deck_card_prices_at_its_own_finish_and_falls_back_only_when_it_has_none() {
    for market in [
        Marketplace::Tcgplayer,
        Marketplace::Cardmarket,
        Marketplace::Cardkingdom,
        Marketplace::Manapool,
    ] {
        let sql = deck_card_price_expr(market);
        assert!(
            sql.contains("dc.finish IS NULL"),
            "the two arms are told apart by the column, not by a coalesce: {sql}"
        );
        // The unsaid arm is the existing chain, verbatim — never a second spelling of it.
        assert!(
            sql.contains(&printing_price_by_finish_expr(market)),
            "the NULL arm must be `printing_price_by_finish_expr`'s own text: {sql}"
        );
        // The said arm is `price_expr` reading the row's column, exactly as the collection
        // passes `e.finish`.
        assert!(
            sql.contains(&price_expr(market, "dc.finish")),
            "the set arm must be `price_expr(market, \"dc.finish\")`: {sql}"
        );
    }

    // Cardmarket's `eur_etched` hole survives into both arms rather than being papered over
    // with the nonfoil rate — it lives in `price_expr`, so it travels for free.
    let cm = deck_card_price_expr(Marketplace::Cardmarket);
    assert!(cm.contains("WHEN 'etched' THEN NULL"), "{cm}");
    assert!(!cm.contains("eur_etched"), "{cm}");
}
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml a_deck_card_prices_at_its_own_finish
```

Expected: FAIL — `cannot find function deck_card_price_expr`.

- [ ] **Step 3: Implement it**

In `sorting.rs`, beside `printing_price_by_finish_expr`:

```rust
/// What one copy of a **deck row** costs at `market` — the deck's figure since v18.
///
/// Two arms, told apart by whether the row names a finish:
///
/// * **NULL** — the row has not said, which is every row that predates v18. That is
///   [`printing_price_by_finish_expr`]'s chain, unchanged and quoted rather than respelled:
///   `nonfoil → foil → etched`, which is what stops a foil-only printing reading as unpriced.
/// * **`'foil'` / `'etched'`** — [`price_expr`] at that finish and no other. **No fallback**,
///   which is this crate's rule everywhere a finish is named: a foil row quoted at the nonfoil
///   rate is a price nobody quoted. The reader said which object is in the sleeve.
///
/// `dc` is the caller's alias for `deck_cards`, matching `deck::DECK_CARD_SELECT`.
pub fn deck_card_price_expr(market: Marketplace) -> String {
    format!(
        "CASE WHEN dc.finish IS NULL THEN {chain} ELSE {named} END",
        chain = printing_price_by_finish_expr(market),
        named = price_expr(market, "dc.finish"),
    )
}
```

- [ ] **Step 4: Point the deck's read at it**

In `deck.rs`, the deck-card SELECT builds its price with
`crate::sorting::printing_price_by_finish_expr(marketplace)` (near line 2633). Change that one call
to `crate::sorting::deck_card_price_expr(marketplace)`. Confirm the `deck_cards` alias in that
`FROM` really is `dc`; if it is not, use whatever it is and change the format string in Step 3 to
match — the alias is the contract between the two.

Then rewrite the opening of `printing_price_by_finish_expr`'s doc comment. It currently reads
"`deck_cards`' grain names a printing and stops there, so there is no finish to price at". Replace
that sentence with:

```
/// **This is the deck's figure for a row that names no finish**, which since v18 is one of the
/// two arms of [`deck_card_price_expr`] rather than the whole answer. `deck_cards.finish` is
/// NULL on every row that predates that version and on every row a reader has not spoken
/// about, and this chain is what it has always been priced at.
```

Leave the rest of that comment — the 13 515 measurement and the `price_usd` reasoning — intact.

- [ ] **Step 5: Run the Rust suite**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml sorting deck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/sorting.rs src-tauri/src/deck.rs
git commit -m "feat(deck): price a deck row at the finish it names"
```

---

## Task 3: The finish reaches the address, and `set_card_finish` exists

**Files:**
- Modify: `src-tauri/src/deck.rs` — `normalise_finish`, `DeckCardRow.finish`, the `finish`
  argument on `add_card`, `set_card_quantity`, `move_card`, `swap_printing`, `set_card_tag`, plus
  the new `set_card_finish` and its `#[tauri::command]`
- Modify: `src-tauri/src/deck_undo.rs` — `CardRow.finish`
- Modify: `src-tauri/src/deck_theory.rs` — the copy carries the finish
- Modify: `src-tauri/src/lib.rs` — register `deck_set_card_finish`
- Test: `src-tauri/src/deck.rs` (inline)

**Interfaces:**
- Consumes: `schema::DECK_CARD_GRAIN` (Task 1).
- Produces:
  - `pub fn normalise_finish(raw: Option<&str>) -> Result<Option<String>, String>`
  - `pub fn set_card_finish(conn, deck_id: i64, card_id: &str, category_id: i64, variant: &str, from_finish: Option<&str>, to_finish: Option<&str>) -> Result<SwapResult, String>`
  - `DeckCardRow.finish: Option<String>`
  - **every command above takes `finish: Option<&str>` immediately after `variant`** — one
    position, on every signature, so no call site has to remember a different one per command.
    `add_card(conn, deck_id, card_id, category_id, category_name, variant, finish, quantity)`;
    `set_card_quantity(conn, deck_id, card_id, category_id, variant, finish, quantity)`;
    `move_card(conn, deck_id, card_id, from_category_id, to_category_id, to_category_name, variant, finish)`;
    `swap_printing(conn, deck_id, from_card_id, to_card_id, category_id, variant, finish)`
  - `pub const SAME_FINISH: &str`, `pub const FINISH_NOT_SOLD: &str`

- [ ] **Step 1: Write the failing tests**

```rust
/// `nonfoil` is not a value this column stores, and the normaliser is where that becomes true.
/// One place, so the CHECK below it is a fence rather than the enforcement.
#[test]
fn nonfoil_is_normalised_to_the_regular_row() {
    assert_eq!(normalise_finish(None).unwrap(), None);
    assert_eq!(normalise_finish(Some("nonfoil")).unwrap(), None);
    assert_eq!(normalise_finish(Some("foil")).unwrap(), Some("foil".to_owned()));
    assert_eq!(
        normalise_finish(Some("etched")).unwrap(),
        Some("etched".to_owned())
    );
    assert!(
        normalise_finish(Some("holo")).is_err(),
        "a finish this app has never heard of is refused, not stored"
    );
}

/// The write the feature is named for, and its fold.
///
/// Setting a row to a finish the pile already holds is exactly `swap_printing`'s situation —
/// two rows become one — so it answers the same `SwapResult` and folds the same way.
#[test]
fn setting_a_finish_folds_into_the_row_that_is_already_there() {
    let conn = open_deck_fixture();          // one deck, one category, printing `c1` in both finishes
    add_card(&conn, 1, "c1", Some(1), None, "live", None, 3).unwrap();
    add_card(&conn, 1, "c1", Some(1), None, "live", Some("foil"), 1).unwrap();

    // The single foil copy becomes regular and joins the three already there.
    let result = set_card_finish(&conn, 1, "c1", 1, "live", Some("foil"), None).unwrap();
    assert!(result.folded, "the pile already held a regular row");

    let rows: Vec<(Option<String>, i64)> = conn
        .prepare("SELECT finish, quantity FROM deck_cards ORDER BY coalesce(finish, '')")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(rows, vec![(None, 4)], "one row of four, and no foil row left behind");
}

/// The same write with nothing to fold into: the row changes finish in place and keeps its
/// quantity, its tag and its `needs_review`.
#[test]
fn setting_a_finish_with_no_row_to_fold_into_moves_the_row() {
    let conn = open_deck_fixture();
    add_card(&conn, 1, "c1", Some(1), None, "live", None, 2).unwrap();

    let result = set_card_finish(&conn, 1, "c1", 1, "live", None, Some("foil")).unwrap();
    assert!(!result.folded);

    let rows: Vec<(Option<String>, i64)> = conn
        .prepare("SELECT finish, quantity FROM deck_cards")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(rows, vec![(Some("foil".to_owned()), 2)]);
}

/// Three refusals, each its own sentence, and none of them a panic.
#[test]
fn set_card_finish_refuses_the_three_things_it_cannot_do() {
    let conn = open_deck_fixture();
    add_card(&conn, 1, "c1", Some(1), None, "live", None, 1).unwrap();

    assert_eq!(
        set_card_finish(&conn, 1, "c1", 1, "live", None, None).unwrap_err(),
        SAME_FINISH,
        "a press that changes nothing writes nothing and does not move `updated_at`"
    );
    // `c2` is seeded sold in nonfoil only.
    add_card(&conn, 1, "c2", Some(1), None, "live", None, 1).unwrap();
    assert_eq!(
        set_card_finish(&conn, 1, "c2", 1, "live", None, Some("foil")).unwrap_err(),
        FINISH_NOT_SOLD
    );
    assert!(
        set_card_finish(&conn, 1, "c1", 1, "live", Some("etched"), None).is_err(),
        "there is no etched row in that pile to change"
    );
}

/// A foil row restored by undo comes back foil. Without `CardRow.finish` it comes back
/// regular — a silent wrong answer in the one feature whose failure cannot be seen.
#[test]
fn undo_restores_a_row_at_the_finish_it_had() {
    let conn = open_deck_fixture();
    add_card(&conn, 1, "c1", Some(1), None, "live", Some("foil"), 2).unwrap();
    set_card_quantity(&conn, 1, "c1", 1, "live", Some("foil"), 0).unwrap();
    crate::deck_undo::undo(&conn, 1).unwrap();

    let finish: Option<String> = conn
        .query_row("SELECT finish FROM deck_cards", [], |r| r.get(0))
        .unwrap();
    assert_eq!(finish, Some("foil".to_owned()));
}
```

`open_deck_fixture` is this module's existing test helper for a deck with cards — find it (search
for other tests calling `add_card`) and extend its seeded `cards` rows so that `c1` has
`finishes = '["nonfoil","foil"]'` and `c2` has `'["nonfoil"]'`. If no such helper exists, write one
modelled on the nearest existing deck test's setup. Fix the `deck_undo::undo` call to whatever that
module's public entry point is actually named.

- [ ] **Step 2: Run them to verify they fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml set_card_finish nonfoil_is_normalised
```

Expected: FAIL to compile — `cannot find function normalise_finish`.

- [ ] **Step 3: Add the normaliser and the two sentences**

```rust
/// What [`set_card_finish`] says when it is asked to change a finish to itself. The menu greys
/// the row the deck already uses, so reaching this is a double-press or a list that went stale
/// — either way there is nothing to write. [`SAME_PRINTING`]'s shape, for its reason.
pub const SAME_FINISH: &str = "That is already this finish.";

/// What [`set_card_finish`] says when the printing is not sold in the finish it was pointed at.
///
/// Read off `cards.finishes`, so this is also what a printing that has left the corpus answers
/// — the row's own list is gone with it, and "this printing is not sold in foil" is the honest
/// thing to say about a printing the database no longer has.
pub const FINISH_NOT_SOLD: &str = "That printing is not sold in that finish.";

/// The one place `'nonfoil'` becomes NULL.
///
/// **NULL is the regular copy and `'nonfoil'` is never stored** — two spellings of one thing
/// would be two rows on [`crate::schema::DECK_CARD_GRAIN`] that draw identically on screen and
/// sum apart. The column's CHECK is the fence; this is the enforcement, and it is one function
/// so that every command shares it rather than each remembering.
///
/// An unrecognised word is refused rather than dropped: a caller sending one has a bug, and
/// silently filing its card as regular would hide it.
pub fn normalise_finish(raw: Option<&str>) -> Result<Option<String>, String> {
    match raw {
        None | Some("nonfoil") => Ok(None),
        Some(f) if crate::schema::FINISHES.contains(&f) => Ok(Some(f.to_owned())),
        Some(other) => Err(format!("`{other}` is not a finish this app knows.")),
    }
}
```

- [ ] **Step 4: Thread the argument through the five commands**

Each of `add_card`, `set_card_quantity`, `move_card`, `swap_printing` and `set_card_tag` takes a
new `finish: Option<&str>` parameter **immediately after `variant`** — one position on every
signature, so no call site has to remember a different one per command — calls `normalise_finish`
as its first fence beside `valid_variant`, and adds
`AND coalesce(finish, '') = coalesce(?n, '')` to its WHERE — or, for `add_card`, binds it in the
INSERT's column list. `add_card`'s `ON CONFLICT({grain})` needs no edit: the grain is the constant.

The matching `#[tauri::command]` wrappers in the same file each take `finish: Option<String>` and
pass `finish.as_deref()`.

**`move_card` and `swap_printing` keep the finish** — moving a foil copy to another pile leaves it
foil, and swapping to another printing of the same card leaves it foil. Neither writes the column;
they only address by it.

- [ ] **Step 5: Add `set_card_finish`**

```rust
/// Change which physical object a deck row is: the regular copy, the foil, or the etched one.
///
/// **The same act as [`swap_printing`], one axis over** — the deck plays a different object of
/// the same card — so it answers the same [`SwapResult`], folds the same way, and records the
/// same `swap` audit kind rather than a tenth word (`AUDIT_KINDS` is CHECK-constrained; a new
/// word is a migration, and this is not a new kind of event).
///
/// The fold is the interesting half. Setting the foil row of a pile that already holds a
/// regular row is two rows becoming one: the quantities add and the row that moved is deleted.
/// `tag_id` and `needs_review` are the surviving row's, which is [`add_card`]'s rule — the row
/// that was already there is the one the reader labelled.
pub fn set_card_finish(
    conn: &Connection,
    deck_id: i64,
    card_id: &str,
    category_id: i64,
    variant: &str,
    from_finish: Option<&str>,
    to_finish: Option<&str>,
) -> Result<SwapResult, String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    let from = normalise_finish(from_finish)?;
    let to = normalise_finish(to_finish)?;
    // Before the transaction, so a no-op does not move `updated_at` and resort the gallery —
    // `swap_printing`'s fence, for its reason.
    if from == to {
        return Err(SAME_FINISH.to_owned());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    touch_deck(&tx, deck_id)?;
    category_of_deck(&tx, deck_id, category_id)?;

    // What the printing is actually sold in. A finish the object does not come in is not a
    // choice the reader can make, whatever the menu happened to be drawing.
    if let Some(want) = to.as_deref() {
        let sold: Option<String> = tx
            .query_row(
                "SELECT finishes FROM cards WHERE id = ?1",
                params![card_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        let sold_here = sold
            .as_deref()
            .and_then(|json| serde_json::from_str::<Vec<String>>(json).ok())
            .is_some_and(|list| list.iter().any(|f| f == want));
        if !sold_here {
            return Err(FINISH_NOT_SOLD.to_owned());
        }
    }

    // The undo scope is the printing in this pile — **both** finish rows, deliberately. This
    // write moves quantity between two of them, so a scope naming one would restore half of
    // what it touched. See `deck_undo::Op::Cards`.
    let cells = vec![crate::deck_undo::Cell::card(variant, category_id, card_id)];
    let before = crate::deck_undo::read_cells(&tx, deck_id, &cells)?;

    let moved: i64 = tx
        .query_row(
            "SELECT quantity FROM deck_cards
              WHERE deck_id = ?1 AND variant = ?2 AND category_id = ?3 AND card_id = ?4
                AND coalesce(finish, '') = coalesce(?5, '')",
            params![deck_id, variant, category_id, card_id, from],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| GONE.to_owned())?;

    let landed: Option<i64> = tx
        .query_row(
            "SELECT quantity FROM deck_cards
              WHERE deck_id = ?1 AND variant = ?2 AND category_id = ?3 AND card_id = ?4
                AND coalesce(finish, '') = coalesce(?5, '')",
            params![deck_id, variant, category_id, card_id, to],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let folded = landed.is_some();
    if let Some(there) = landed {
        tx.execute(
            "UPDATE deck_cards SET quantity = ?6, updated_at = unixepoch()
              WHERE deck_id = ?1 AND variant = ?2 AND category_id = ?3 AND card_id = ?4
                AND coalesce(finish, '') = coalesce(?5, '')",
            params![deck_id, variant, category_id, card_id, to, there + moved],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM deck_cards
              WHERE deck_id = ?1 AND variant = ?2 AND category_id = ?3 AND card_id = ?4
                AND coalesce(finish, '') = coalesce(?5, '')",
            params![deck_id, variant, category_id, card_id, from],
        )
        .map_err(|e| e.to_string())?;
    } else {
        tx.execute(
            "UPDATE deck_cards SET finish = ?6, updated_at = unixepoch()
              WHERE deck_id = ?1 AND variant = ?2 AND category_id = ?3 AND card_id = ?4
                AND coalesce(finish, '') = coalesce(?5, '')",
            params![deck_id, variant, category_id, card_id, from, to],
        )
        .map_err(|e| e.to_string())?;
    }

    // The deck wants a different object than it did a statement ago, and the allocator answers
    // about oracle cards — so nothing it reserves changes, and it runs for `swap_printing`'s
    // reason: one named list of writes reallocates, and this is a write to `deck_cards`.
    allocate_deck(&tx, deck_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(SwapResult { folded, .. })
}
```

Fill in `SwapResult`'s remaining fields from its definition — read it and match `swap_printing`'s
construction. Record the audit row and the undo step exactly as `swap_printing` does, immediately
before the commit, with `fromFinish`/`toFinish` in the payload.

- [ ] **Step 6: `CardRow.finish`, and leave `Cell` alone**

In `deck_undo.rs`, add `pub finish: Option<String>` to `CardRow` (after `lang`, matching the column
order), add `finish` to the SELECT list in **both** `read_cells` and `read_variant`, to `card_row`'s
mapper, and to the INSERT that restores rows. Add to `Cell`'s doc comment:

```
/// **A cell names no finish, on purpose.** Since v18 a printing can be two rows in one pile —
/// the regular copy and the foil — and a finish change moves quantity between them. A scope
/// naming one finish would delete half of what the write touched and restore half of what it
/// read; the wide cell deletes both and puts both back, which is what "delete exactly `scope`
/// and insert exactly `rows`" already promised.
```

- [ ] **Step 7: `deck_theory.rs` and `lib.rs`**

`deck_theory_copy_from_live`'s INSERT…SELECT gains `finish` in both lists, so a plan copied from
the live deck plays the same objects. `move_live_into_theory` is a bare `UPDATE … SET variant` and
needs no column change — add a line to its comment noting the grain has a fifth column now and its
emptiness precondition is what keeps the re-label collision-free.

Register `deck_set_card_finish` in `lib.rs`'s `invoke_handler` list, in the same block as
`deck_swap_printing`.

- [ ] **Step 8: Fix every existing caller**

`cargo check` will list them. Each existing call site passes `None` in the new position — which is
the regular row and is exactly what it meant before this branch.

- [ ] **Step 9: Run the Rust suite**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: PASS.

- [ ] **Step 10: Commit**

```powershell
git add src-tauri/src
git commit -m "feat(deck): address a deck card by finish, and set_card_finish"
```

---

## Task 4: The TypeScript mirror

**Files:**
- Modify: `src/lib/ipc.ts` — `DeckCard.finish`, `ImportItem.finish`, the argument on five calls,
  `deckSetCardFinish`
- Modify: `src/features/decks/useDeck.ts` — `Slot`, `patchSlot`, `setCardFinish`
- Modify: `src/features/decks/dnd.ts` — the `deck-card` payload
- Modify: `src/features/decks/DeckEditor.tsx` — threading, and `newestWrite`
- Test: `src/lib/ipc.test.ts`, `src/features/decks/useDeck.test.ts`

**Interfaces:**
- Consumes: Task 3's command signatures.
- Produces: `DeckCard.finish: Finish | null`; `Slot = { cardId: string; categoryId: number; finish: Finish | null }`;
  `ipc.deckSetCardFinish(deckId, cardId, categoryId, variant, fromFinish, toFinish)`;
  `useDeck().setCardFinish` as a `useMutation`.

- [ ] **Step 1: Write the failing test**

In `src/lib/ipc.test.ts`, beside the other command-shape tests:

```ts
it("sends the finish in the grain position on every deck card write", async () => {
  const calls = captureInvokes();          // this file's existing invoke spy — match its name
  await ipc.deckSetCardQuantity(1, "c1", 2, "live", "foil", 3);
  await ipc.deckSetCardFinish(1, "c1", 2, "live", "foil", null);

  expect(calls[0]).toEqual([
    "deck_set_card_quantity",
    { deckId: 1, cardId: "c1", categoryId: 2, variant: "live", finish: "foil", quantity: 3 },
  ]);
  // `null` is the regular row and is sent as null, never as "nonfoil": Rust normalises the
  // word away, and a second spelling reaching the wire is how two rows come to draw alike.
  expect(calls[1]).toEqual([
    "deck_set_card_finish",
    {
      deckId: 1,
      cardId: "c1",
      categoryId: 2,
      variant: "live",
      fromFinish: "foil",
      toFinish: null,
    },
  ]);
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npx vitest run src/lib/ipc.test.ts
```

Expected: FAIL — `ipc.deckSetCardFinish is not a function`.

- [ ] **Step 3: Grow the DTO and the calls**

In `ipc.ts`, on `DeckCard`, after `lang`:

```ts
  /**
   * Which object this row plays — `null` for the regular copy.
   *
   * **`null` is the only spelling of regular; `"nonfoil"` never arrives here.** Rust
   * normalises the word to NULL at the command boundary and `deck_cards.finish` CHECKs it
   * away, because two spellings would be two rows on the grain that draw identically. It is
   * the same shape `soleFinish` already answers in, and for the same reason — nonfoil is the
   * finish a price is assumed to be.
   *
   * A deck row is addressed by `(deckId, cardId, categoryId, variant, finish)` since schema
   * v18: a foil copy and a regular copy of one printing in one pile are two rows.
   */
  finish: Finish | null;
```

Add `finish: Finish | null` in the grain position to `deckAddCard`, `deckSetCardQuantity`,
`deckMoveCard`, `deckSwapPrinting` and `deckSetCardTag`, and add:

```ts
  /**
   * Change which object a deck row plays. Answers `swap_printing`'s `SwapResult`, and **folds**
   * the same way: setting a row to a finish the pile already holds adds the quantities and
   * takes the row that moved away.
   */
  deckSetCardFinish: (
    deckId: number,
    cardId: string,
    categoryId: number,
    variant: DeckVariant,
    fromFinish: Finish | null,
    toFinish: Finish | null,
  ) =>
    invoke<SwapResult>("deck_set_card_finish", {
      deckId,
      cardId,
      categoryId,
      variant,
      fromFinish,
      toFinish,
    }),
```

Add `finish: Finish | null` to `ImportItem`.

- [ ] **Step 4: Grow `Slot` and add the mutation**

In `useDeck.ts`, `Slot` gains `finish: Finish | null`, and `patchSlot` matches on all three fields —
**this is the load-bearing edit in this task**: a `patchSlot` still matching on `(cardId,
categoryId)` will optimistically patch the foil row and the regular row together, and the reader
will watch both change and one snap back. Then:

```ts
  /**
   * Change which object a row plays — the card menu's `Set as foil` and the pane's button.
   *
   * No optimistic patch, deliberately: the write **folds**, and a fold is two rows becoming one
   * with a quantity this side has not computed. Guessing it would show a number that is right
   * only when the pile held no row of the target finish. It invalidates like the rest.
   */
  const setCardFinish = useMutation({
    mutationFn: ({ cardId, categoryId, finish, to }: Slot & { to: Finish | null }) =>
      ipc.deckSetCardFinish(opened(id), cardId, categoryId, variant, finish, to),
    onSuccess: invalidate,
  });
```

Return it from the hook.

- [ ] **Step 5: Thread the callers**

`dnd.ts`'s `deck-card` payload gains `finish: Finish | null` (it is an address, and a drag of the
foil row must not move the regular one). `DeckEditor.tsx`'s `setQuantityAt` and `applyDrop` pass
`card.finish`, and `newestWrite([...])` gains `setCardFinish` so a refusal reaches the editor's
banner. Every view's row key gains the finish, or two rows of one printing collide in React.

`cardMenu.tsx`'s `useCardToDeck` adds with `finish: null` — an add from a card surface is a regular
copy, and the reader changes it after.

- [ ] **Step 6: Pin the rule that did not change**

`engine.ts` counts copies by card **name** and sums `quantity` across rows, so a foil row and a
regular row are four copies rather than two lots of one. Nothing in it changes — which is exactly
why it needs a test, because "the finish split the copy count" is the first thing anybody will
suspect the day a four-of validation reads wrong. In `validation/engine.test.ts`:

```ts
it("counts a foil copy and a regular copy of one card as copies of one card", () => {
  // A deck that holds `1 Sol Ring (foil)` beside `3 Sol Ring` holds four Sol Rings. The
  // grain split the *rows* in schema v18; it must never have split the count — copies are a
  // rules fact about a card, and the rules have never heard of a finish.
  const issues = validate(
    deck([
      card({ name: "Sol Ring", cardId: "c1", finish: "foil", quantity: 1 }),
      card({ name: "Sol Ring", cardId: "c1", finish: null, quantity: 3 }),
    ]),
    specFor("commander"),
  );
  expect(issues.map((i) => i.message)).toContain(
    "Commander decks are singleton: max 1 copy of Sol Ring; you have 4.",
  );
});
```

Match `validate`/`deck`/`card`/`specFor` to this file's existing helpers and the message to the
engine's own string — copy it from the source rather than retyping it.

- [ ] **Step 7: Run the frontend suite**

```powershell
npm run test:run 2>&1 | Tee-Object -FilePath verify.log; Select-String -Path verify.log -Pattern "Tests.*failed|Tests.*passed"
```

(Never `| tail` — a pipe reports the pipe's exit code, not the suite's.)

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/lib/ipc.ts src/lib/ipc.test.ts src/features/decks
git commit -m "feat(decks): carry the finish through the TS deck-card address"
```

---

## Task 5: The right-click row

**Files:**
- Modify: `src/features/decks/deckCardMenu.tsx`
- Test: `src/features/decks/deckCardMenu.test.tsx` (or wherever this menu's tests live — check
  `DeckEditor.test.tsx` first)

**Interfaces:**
- Consumes: `DeckCard.finish` (Task 4), `DeckCardMenuDeps`.
- Produces: `DeckCardMenuDeps.setFinish: (card: DeckCard, to: Finish | null) => void`, and a
  `finish` / `finish-<value>` menu item id.

- [ ] **Step 1: Write the failing test**

```tsx
describe("the finish row", () => {
  it("toggles in one press on a printing sold in two finishes", () => {
    const card = deckCard({ finishes: '["nonfoil","foil"]', finish: null });
    const items = buildDeckCardMenu(card, deps);
    const row = find(items, "finish");
    expect(row.label).toBe("Set as foil");
    expect(row.disabled).toBeFalsy();
  });

  it("names the way back when the row is already foil", () => {
    const card = deckCard({ finishes: '["nonfoil","foil"]', finish: "foil" });
    expect(find(buildDeckCardMenu(card, deps), "finish").label).toBe("Set as regular");
  });

  it("offers a submenu of the printing's own finishes when it is sold in three", () => {
    const card = deckCard({ finishes: '["nonfoil","foil","etched"]', finish: null });
    const row = find(buildDeckCardMenu(card, deps), "finish");
    expect(row.kind).toBe("submenu");
    // Scryfall's order, which is what `FINISHES` is written in — never alphabetical.
    expect(row.items.map((i) => i.label)).toEqual(["Regular", "Foil", "Etched"]);
    // The finish the row already is, greyed — so the list stays findable by position.
    expect(row.items[0].disabled).toBe(true);
  });

  it("greys silently on a printing with one finish, and says nothing", () => {
    const card = deckCard({ finishes: '["nonfoil"]', finish: null });
    const row = find(buildDeckCardMenu(card, deps), "finish");
    expect(row.disabled).toBe(true);
    // No `reason`: this menu's greyed rows say nothing, and a sentence on a row greyed this
    // often is noise on the surface a reader uses most. `zoneItem` is the precedent.
    expect(row.reason).toBeUndefined();
  });

  it("is still a row when it is greyed, so its position never moves", () => {
    const two = buildDeckCardMenu(deckCard({ finishes: '["nonfoil","foil"]' }), deps);
    const one = buildDeckCardMenu(deckCard({ finishes: '["nonfoil"]' }), deps);
    expect(one.findIndex((i) => i.id === "finish")).toBe(
      two.findIndex((i) => i.id === "finish"),
    );
  });
});
```

Write `deckCard(overrides)` as a local factory over a full `DeckCard` if this file has none.

- [ ] **Step 2: Run it to verify it fails**

```powershell
npx vitest run src/features/decks/deckCardMenu.test.tsx
```

Expected: FAIL — no item with id `finish`.

- [ ] **Step 3: Implement `finishItem`**

```tsx
/**
 * Which object this row plays, and the three shapes that question has.
 *
 * `collectionItem`'s rule in `cardMenu.tsx`, applied to a write rather than an add, and for its
 * reason: **a choice with one answer is not a choice**. Sold in two finishes — nonfoil and
 * foil, which is the overwhelming majority — the row is a toggle and costs one press. Sold in
 * three, it is a submenu of the printing's own list. Sold in one, there is nothing to pick.
 *
 * **The greyed row says nothing**, which is this menu's own precedent (`zoneItem`) rather than
 * `cardMenu.tsx`'s greyed-with-a-reason. A sentence on a row that greys on a large minority of
 * cards is noise on the surface a reader uses most; the row stays *present* so its position
 * never moves, which is what `View all printings` and the commander row are both kept by.
 *
 * The finishes are in the printing's own order — Scryfall's, which is what `FINISHES` is
 * written in — and deliberately not through `sortOptions`: the order *is* the information
 * (plain, then the premium treatments), which is one of the two exemptions `src/CLAUDE.md`
 * grants and the same one the collection picker takes.
 */
function finishItem(card: DeckCard, deps: DeckCardMenuDeps): MenuItem {
  const sold = parseFinishes(card.finishes);
  const row = { kind: "action", id: "finish", Icon: Sparkles } as const;
  const label = (f: Finish | null) => `Set as ${f === null ? "regular" : FINISH_LABEL[f].toLowerCase()}`;

  if (sold.length <= 1) {
    return { ...row, label: label("foil"), disabled: true, onSelect: () => {} };
  }
  if (sold.length === 2) {
    // The one it is not. Two finishes is one other finish, so the toggle names it outright.
    const other = choicesOf(sold).find((f) => f !== card.finish) ?? null;
    return { ...row, label: label(other), onSelect: () => deps.setFinish(card, other) };
  }
  return {
    kind: "submenu",
    id: "finish",
    label: "Finish",
    Icon: Sparkles,
    items: choicesOf(sold).map((f) => ({
      kind: "action",
      id: `finish-${f ?? "regular"}`,
      label: f === null ? "Regular" : FINISH_LABEL[f],
      ...(f === card.finish
        ? { disabled: true, onSelect: () => {} }
        : { onSelect: () => deps.setFinish(card, f) }),
    })),
  };
}

/** The printing's finishes as this menu's values: `nonfoil` is `null`, the regular row. */
function choicesOf(sold: readonly Finish[]): (Finish | null)[] {
  return sold.map((f) => (f === "nonfoil" ? null : f));
}
```

Place the row in `buildDeckCardMenu` beside `Move to` — both answer "change what this row is" —
and add `setFinish` to `DeckCardMenuDeps`. Wire it in `DeckEditor.tsx` to `setCardFinish.mutate`.

`Sparkles` is the glyph `CardDetailPane` already uses for foil; import it from `lucide-react` and
`Gem` is **not** used here, because this row is about the choice rather than about one finish.

- [ ] **Step 4: Run the test**

```powershell
npx vitest run src/features/decks/deckCardMenu.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/features/decks
git commit -m "feat(decks): a deck card's right-click sets its finish"
```

---

## Task 6: The card pane's button writes

**Files:**
- Modify: `src/features/card/CardDetailPane.tsx` — `foilViewFinish`'s consumer, the label, the write
- Modify: `src/features/decks/useSwapFromPane.ts` (or wherever the pane's deck write lives — grep
  `useSwapFromPane`)
- Test: `src/features/card/CardDetailPane.test.tsx`

**Interfaces:**
- Consumes: `useDeck().setCardFinish` (Task 4).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

```tsx
it("says what the press does: it writes in the deck editor and only looks in Search", async () => {
  const { rerender } = render(<CardDetailPane {...props} deckContext={null} />);
  expect(await screen.findByRole("button", { name: /view as foil/i })).toBeVisible();

  rerender(<CardDetailPane {...props} deckContext={deckRowContext} />);
  const button = await screen.findByRole("button", { name: /set as foil/i });
  await userEvent.click(button);
  expect(setCardFinish).toHaveBeenCalledWith(
    expect.objectContaining({ cardId: "c1", finish: null, to: "foil" }),
  );
});

it("opens showing the finish the deck row already plays", async () => {
  render(<CardDetailPane {...props} deckContext={{ ...deckRowContext, finish: "foil" }} />);
  // Seeded from the row, not from `false`: the pane shows the copy the deck plays.
  expect(await screen.findByRole("button", { name: /set as regular/i })).toBeVisible();
});
```

Match `deckContext`'s real name and shape to whatever the pane already takes for its deck-aware
behaviour — grep `paneCardId` and `PaneDeckContext` in `src/lib/store.ts` first.

- [ ] **Step 2: Run it to verify it fails**

```powershell
npx vitest run src/features/card/CardDetailPane.test.tsx
```

Expected: FAIL — no `set as foil` button.

- [ ] **Step 3: Implement**

`foilView` seeds from the deck row's `finish` rather than `false`, and the button's `onClick` calls
`setCardFinish` **as well as** flipping the view when a deck row is behind the pane. The label:

```tsx
// The label says what the press does, which is two different things by context. Inside the
// editor the pane is about *your* copy and the press is a write; in Search there is no row to
// write, so it stays what it has always been — a view.
const foilLabel = deckRow
  ? `Set as ${foilView ? FINISH_LABEL.nonfoil.toLowerCase() : FINISH_LABEL[foilable].toLowerCase()}`
  : `View as ${foilView ? FINISH_LABEL.nonfoil.toLowerCase() : FINISH_LABEL[foilable].toLowerCase()}`;
```

Replace `FINISH_LABEL.nonfoil.toLowerCase()` with `"regular"` in the **write** arm only — "set as
nonfoil" is not English and `regular` is the word the menu uses. The view arm keeps today's
wording, which has shipped.

The surface supplies the **fact** (which deck row, if any) and never a decision — `cardMenu.tsx`'s
`paneCardId` rule, applied again.

- [ ] **Step 4: Run the test**

```powershell
npx vitest run src/features/card/CardDetailPane.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/features/card src/features/decks
git commit -m "feat(card): the pane's foil button sets a deck row's finish"
```

---

## Task 7: The mark on the deck's own cards

**Files:**
- Modify: `src/features/decks/CardMarks.tsx`, `CardStack.tsx`, `views/GridView.tsx`,
  `views/TableView.tsx`, `views/TextView.tsx`
- Test: `src/features/decks/views/views.test.tsx`, `CardStack.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
it("marks a row the reader set to foil, and leaves a plain row plain", () => {
  render(<GridView {...props} cards={[card({ finish: "foil" }), card({ finish: null })]} />);
  expect(screen.getAllByRole("img", { name: /foil/i })).toHaveLength(1);
});

it("still marks a foil-only printing that the row says nothing about", () => {
  // `soleFinish`'s statement survives: it says what the *object* is, and this row has not
  // spoken. The two facts are read in order, the reader's first.
  render(<GridView {...props} cards={[card({ finish: null, finishes: '["foil"]' })]} />);
  expect(screen.getAllByRole("img", { name: /foil/i })).toHaveLength(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npx vitest run src/features/decks/views/views.test.tsx
```

Expected: FAIL — no foil mark on the first card.

- [ ] **Step 3: Implement**

Everywhere a deck card's mark is computed, the expression becomes:

```tsx
// The reader's own statement first, the printing's second. `soleFinish` says what the object
// *is* (12 366 printings exist only in foil) and deliberately says nothing about a printing
// sold in both — a sheen on 61 % of a wall is decoration. A stored finish is a different
// claim, and it is the reader's: this deck plays the shiny one.
const marked = card.finish ?? soleFinish(card.finishes);
```

The chip stays `FoilOverlay`'s in the art's top-right corner and nothing else goes there —
`GridView`'s copy count has collided with it once already. `TableView` and `TextView` draw
`FinishMark` beside the name, as the printings list does.

- [ ] **Step 4: Run the tests, then commit**

```powershell
npx vitest run src/features/decks
git add src/features/decks
git commit -m "feat(decks): draw the finish a deck row plays"
```

---

## Task 8: Import and export carry it

**Files:**
- Modify: `src/features/decks/import/parse.ts`, `import/plan.ts`, `export/format.ts`
- Test: `import/parse.test.ts`, `export/decklists.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// parse.test.ts
it("keeps the finish marker it used to throw away", () => {
  const { lines } = parseDecklist("1 Sol Ring *F*\n1 Urza's Saga *E*\n2 Shock");
  expect(lines.map((l) => l.finish)).toEqual(["foil", "etched", null]);
});

it("still reads [Foil] as decoration and never as a pile", () => {
  // A bracket is the *category* channel. A finish that arrived there is an exporter being
  // loose, not the reader naming a pile — and `*F*` is the channel the formats agree on.
  const { lines } = parseDecklist("1 Sol Ring [Foil]");
  expect(lines[0].categoryName).toBeNull();
  expect(lines[0].finish).toBeNull();
});
```

```ts
// decklists.test.ts — extend the existing matrix
it("round-trips a finish through every format that has a marker for one", () => {
  const cards = [deckCard({ name: "Sol Ring", finish: "foil" })];
  for (const format of ["plain", "moxfield", "archidekt"] as const) {
    const text = writeDecklist(cards, format);
    expect(text).toContain("*F*");
    expect(parseDecklist(text).lines[0].finish).toBe("foil");
  }
  // Arena and MTGO have no marker in the format. The loss is stated rather than discovered —
  // it is the same thing already true of a category there.
  for (const format of ["arena", "mtgo"] as const) {
    expect(writeDecklist(cards, format)).not.toContain("*F*");
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

```powershell
npx vitest run src/features/decks/import/parse.test.ts src/features/decks/export/decklists.test.ts
```

Expected: FAIL — `finish` is not on `ParsedLine`.

- [ ] **Step 3: Implement**

`parse.ts`'s `stripDecorations` currently discards the `*F*`/`*E*` match; return it instead, and
map `F → "foil"`, `E → "etched"`, absent → `null`, onto `ParsedLine.finish`. Leave `FINISH_WORDS`
and the bracket rule exactly as they are. `plan.ts` carries `line.finish` onto the `ImportItem` it
builds — it is a fact about the line, not a deck decision, so nothing else in that module changes.

`format.ts`: `plain`, `moxfield` and `archidekt` append ` *F*` / ` *E*` after the printing hint;
`csv` gains a `Finish` column writing `foil` / `etched` / empty; `arena` and `mtgo` write nothing.

- [ ] **Step 4: Run the tests**

```powershell
npx vitest run src/features/decks
```

Expected: PASS, including the existing six-format fixed point.

- [ ] **Step 5: Commit**

```powershell
git add src/features/decks
git commit -m "feat(decks): decklists carry the finish in both directions"
```

---

## Task 9: The workbench, the prose, and `npm run verify`

**Files:**
- Modify: `.storybook/fake/db.ts` — the column and a seeded foil row
- Modify: `src/features/decks/CLAUDE.md`, `src-tauri/CLAUDE.md`, `docs/reference/decks-storage.md`,
  `src/lib/finish.ts`, `src/features/card/cardMenu.tsx`, `src/features/decks/import/parse.ts`

- [ ] **Step 1: The fake**

`.storybook/fake/db.ts` needs `finish` on its deck-card rows and one seeded foil row, so a story
draws the mark. **Ripgrep reads this file as binary** — open it with Read or `Select-String`, and a
grep that finds nothing there has told you nothing.

- [ ] **Step 2: The prose**

Six places assert "a deck names a printing and never a finish" as a *reason* for something else. A
prose-only edit routes to neither CI job, so nothing goes red when one is left standing and
contradicts the code beside it. Find them all:

```powershell
Select-String -Path src-tauri\src\*.rs, src\**\*.ts, src\**\*.tsx, docs\reference\*.md, src\**\CLAUDE.md -Pattern "printing and (not|never) a finish", "no finish to price at" -List
```

Each one is rewritten to say what is true now and **why the old sentence was right until v18** —
the reasoning it was supporting usually still holds one level down. The known list:
`deck.rs`'s `DeckCardRow.finishes` doc, `sorting.rs`'s `printing_price_by_finish_expr` (done in
Task 2), `cardMenu.tsx`'s `collectionItem`, `parse.ts`'s `FINISH_WORDS`,
`src/features/decks/CLAUDE.md`'s unit-price bullet and its `[Foil]` bullet, and
`docs/reference/decks-storage.md`.

Add to `src/features/decks/CLAUDE.md`, in `## Writes`:

```markdown
- **A deck card names a finish, and the grain says so** (schema v18, 2026-08-17). `deck_cards.finish`
  is `NULL | 'foil' | 'etched'` — **NULL is the regular copy and `'nonfoil'` is never stored**,
  normalised in `deck::normalise_finish` and CHECKed away, because two spellings would be two rows
  that draw identically. `DECK_CARD_GRAIN` carries `coalesce(finish, '')` for `COLLECTION_GRAIN`'s
  reason: SQLite treats NULLs in a UNIQUE index as distinct, so the bare column would stop every
  regular add from folding. **A row's price follows it** — `sorting::deck_card_price_expr`, the
  chain when unsaid and that finish alone when said, no fallback either way. **Two rules did not
  change and both look as though they should have**: `engine.ts` counts copies by card *name* and
  sums across rows, so `1 foil + 3 regular` is four copies; and `allocate_deck` matches on oracle
  id and has always ignored finish, so a foil row reserves whatever copy is free. The undo `Cell`
  is deliberately **finish-blind** — a finish change moves quantity between two rows of one
  printing, so the scope has to cover both.
```

- [ ] **Step 3: `npm run verify`**

```powershell
npm run verify 2>&1 | Tee-Object -FilePath verify.log
Select-String -Path verify.log -Pattern "Tests.*failed|test result:|error"
```

Never pipe to `tail` — the exit code would be the pipe's. Never run two verifies at once.

- [ ] **Step 4: `cargo fmt`**

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml
```

`npm run verify` does not run it, and CI's Linux rust job is the only red you can get with both
suites green.

- [ ] **Step 5: Commit**

```powershell
git add -A
git commit -m "docs: a deck card names a finish, everywhere the old rule was quoted"
```

---

## Task 10: Drive it in the shipped window

**Files:** none — this task produces a paragraph for
`docs/reference/decks-live-findings.md` and whatever fixes it turns up.

A green suite and a green Storybook prove nothing about the shipped window; every UI task in Plans
2–3 found something the suite could not. Follow the `running-the-app` skill — **one app across
every worktree**, and the collision is silent.

- [ ] **Step 1: Take the lock and launch**

```powershell
pwsh -NoProfile -File .claude\skills\running-the-app\lock.ps1 claim app
npm run tauri dev
```

- [ ] **Step 2: Drive these five, which are the ones only this pass can answer**

1. A foil row **beside** a regular row of one printing in one pile — two cards on the desk, not one.
2. The pile's heading total and the deck's strip **moving** when a row is set to foil.
3. The sheen appearing on the **deck card**, not only in the pane.
4. The pane's button reading `Set as foil` in the editor and `View as foil` in Search.
5. Ctrl+Z after a finish change putting the row back **foil**.

Use `scripts/cdp.mjs` through **PowerShell** (Bash refuses `cdp.mjs eval` in a worktree as
unverifiable), avoid nested quotes and `$`, wrap every binding in an IIFE (the eval scope is
shared, so a top-level `const` collides with the next command), and **split click-then-read into
two evals** — one eval answers about the frame before React re-rendered, so a working control reads
as broken.

- [ ] **Step 3: Write the findings down**

Append a dated paragraph to `docs/reference/decks-live-findings.md` naming the build (debug) and
the window size, with every figure. Record what it found **and what it confirmed** — an agreement
is worth writing down when it is the thing the change exists to produce.

- [ ] **Step 4: Release the lock and clean up**

```powershell
pwsh -NoProfile -File .claude\skills\running-the-app\lock.ps1 release app
```

- [ ] **Step 5: Commit**

```powershell
git add docs/reference/decks-live-findings.md
git commit -m "docs: drive the deck-card finish in the shipped window"
```

---

## Task 11: Ship it

- [ ] **Step 1: `npm run verify` one more time, clean**
- [ ] **Step 2: Follow the `auto-pr` skill** — `pr-auto.ps1 open`, then `arm`, then watch for the
      only two states GitHub abandons: a real conflict and a red `ci-ok`.
- [ ] **Step 3: Expect three or more merges of `main`.** Merge, never rebase. After a merge that
      brought a dependency, `npm install` again — otherwise `tsc` fails TS2307 and it reads as a
      regression you caused. Re-verify even on a clean merge.
- [ ] **Step 4: The agent does not press Merge.**
