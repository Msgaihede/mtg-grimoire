# Token stacks, PR 1 — stack parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw the deck's Tokens & Emblems pile with the deck's own pile components (one-row heading with a count pill and price, `DeckCardFace` + `CardChin`, theory marks), let the reader drag and arrow it to any place in the right-hand rail, give every pile heading the one-row pill layout, and offer `Any card` on the deck search's Collection tab.

**Architecture:** Rust gains the chin facts and a marketplace price on each `DeckTokenRow`, and one `decks.token_rail_index` column (user schema v51) written through the existing `deck_update` path so the move is audited and undoable. TypeScript narrows `GroupHeader` and `DeckCardFace` to the fields they read so a token can be fed through them, rebuilds `TokenPile.tsx` on those parts, places the pile by a pure `tokenRail.ts` helper in Stacks, Grid and Text, and builds a token theory plan from the theory list's tokens with the existing `theoryMatch.ts` functions.

**Tech Stack:** Tauri 2 / Rust (rusqlite), React 19, TypeScript 6.0, Vitest, dnd-kit (`@dnd-kit/dom` via `src/lib/dndTarget.ts`), Tailwind v4, Storybook fake (`.storybook/fake/db.ts`).

**Spec:** `docs/superpowers/specs/2026-09-26-token-stacks-design.md` — §3 is this PR. Read §1–§3 and §6 before starting any task.

## Global Constraints

- A token is **never** a deck card: never a `deck_cards` row, never in `groups`, never in a pile total, the ledger, the stats or validation. Token prices are summed only in the token pile's own heading.
- A token card is not a drag source, not a drop target, has no deck card menu, no card modal, no selection ring, and is not in `StackView`'s arrow walk. The **pile** (its heading) is draggable.
- The count pill counts **copies** on every pile, the token pile and the band included.
- Visible digits are `aria-hidden`; one `sr-only` string spells the phrase (`N card`/`N cards`, `N token or emblem`/`N tokens and emblems`). Never two sibling elements assembled into an accessible name.
- `TOKENS_HEADING` (`"Tokens & Emblems"`) is the one spelling of the pile's name.
- User schema **v51**. Written as v50 and renumbered before merging, because `main` shipped its own v50 (`price_snapshots.copies`) first (memory: `schema-rung-collisions-with-main`).
- `decks.token_rail_index INTEGER NOT NULL DEFAULT -1`; `-1` (or any value outside `[0, rail.length]`) means **last**. Moving the pile to the last slot writes `-1`.
- Z-indexes only from `LAYER`; tooltips only through `useTooltip()`; `aria-disabled`, never `disabled`; no `@types/node`; TypeScript stays 6.0.x.
- **Tests run once, at fan-in**, not inside each subagent (`src/features/decks/CLAUDE.md` / root `CLAUDE.md`). A subagent may run its **own** new test file with `npx vitest run <file>` or `cargo test <name>` to see red/green, but never `npm run verify`, and never two cargo runs at once.
- Subagents **do not commit** (one shared index — memory `shared-index-sweeps-sibling-commits`). The orchestrator commits after fan-in.

## Review Focus

1. **A one-row heading at the narrowest zoom** — at 0.5× a stack column is ~117px; the Sideboard carries `RULE` + `INACTIVE` + pill + price. Expected: the row wraps the figures under the name, nothing overflows the column. Pinned in Task B by a class assertion (`flex-wrap`, figures `shrink-0`, name `min-w-0 truncate`) and in Task F by a live measurement at 0.5×.
2. **A stored rail index the rail no longer has** — the reader put the pile at 3, then switched two piles back on. Expected: the pile draws last, not nowhere and not at a stale slot. Pinned in Task D1's `tokenRailSlot` tests (index > length, `-1`, `NaN`).
3. **A token pile where some or all printings have no price** (common on Card Kingdom and Mana Pool). Expected: the chin shows an em dash for the unpriced card; the heading sums the priced ones and shows an em dash only when none is priced — `grouping.ts`' `totals` rule. Pinned in Task C.
4. **A deck with a plan whose theory tokens have not loaded yet.** Expected: no mark on any token (never a wall of ✗). Pinned in Task D2's `tokenTheoryPlan(undefined, …)` test.
5. **`Any format` on the Collection tab now means "legal somewhere"**, so an orphan copy (printing gone from the corpus) is hidden under it and shown under `Any card`. Expected: `Any card` sends neither `format` nor `playableOnly`. Pinned in Task E.

---

## File map

| File | Task | Change |
| --- | --- | --- |
| `src-tauri/src/deck_tokens.rs` | A1 | `DeckTokenRow` chin facts + price; `deck_tokens` takes `marketplace` |
| `src-tauri/src/schema.rs` | A1 | v51 rung, `USER_SCHEMA_SQL`, `USER_SCHEMA_VERSION`, `UNDO_V51` + rung test |
| `src-tauri/src/deck.rs` | A1 | `DeckPatch`/`DeckRow`/`DeckBefore.token_rail_index`, `?23`, `record_deck_edit` arm, `duplicate_deck` |
| `src-tauri/src/deck_undo.rs` | A1 | `DECK_FIELDS` gains `token_rail_index` |
| `src-tauri/src/sync_engine/capture.rs` | A1 | `decks` field list gains `token_rail_index` |
| `src-tauri/src/mirror/layout.rs` | A1 | `DeckRow` literal gains the field |
| `src/lib/ipc.ts`, `src/lib/ipc.test.ts` | A2 | mirror both structs; `deckTokens(deckId, variant, marketplace)` |
| `src/features/decks/deckTokens.ts` (+test) | A2 | import the wire types from `ipc.ts`; `DeckTokenView` chin facts |
| `src/features/decks/useDeckTokens.ts` | A2 | marketplace in call and key |
| `src/features/decks/auditText.ts` (+test) | A2 | `tokenRail` field sentence |
| `.storybook/fake/db.ts`, `db.test.ts` | A2 | chin facts, price, `tokenRailIndex` |
| `src/features/decks/CountPill.tsx` (+test) | B | new, the shared pill |
| `src/features/decks/views/GroupHeader.tsx` (+test) | B | one row, pill, narrowed `group` |
| `src/features/decks/DeckTokensPanel.tsx`, `DeckTokensPanel.stories.tsx` | B | band pill → `CountPill`, copies |
| `src/features/decks/DeckCardFace.tsx` | C | `card` narrowed to `DeckCardFaceFacts` |
| `src/features/decks/CardStack.tsx` | C | export `STACKED_CARD_BODY` + `stackedCardShadow` |
| `src/features/decks/views/TokenPile.tsx` (+test, stories) | C | rebuilt on the deck's parts |
| `src/features/decks/views/tokenRail.ts` (+test) | D1 | new: slot math, drag data, grip, hooks |
| `src/features/decks/views/StackView.tsx`, `GridView.tsx`, `TextView.tsx`, `views.test.tsx` | D1 | place the pile; grip; drop |
| `src/features/decks/tokenTheory.ts` (+test) | D2 | new: token theory plan |
| `src/features/decks/DeckEditor.tsx`, `DeckEditor.test.tsx` | D2 | wire rail index, move, theory marks |
| `src/features/decks/useCollectionSearch.ts` (+test), `DeckSearchPanel.test.tsx` | E | `Any card` ladder |
| docs, `TokenCountPill.tsx` deletion, verify, live pass, PR | F | orchestrator |

**Waves.** A1, A2, B, C, D1, D2 and E touch disjoint files and run **in parallel**. Each builds against the interfaces written below, not against a sibling's tree. F runs after all seven report.

---

### Task A1: Rust — token chin facts and price; `decks.token_rail_index` (v51)

**Files:**
- Modify: `src-tauri/src/deck_tokens.rs` (struct `DeckTokenRow` ~L118, `Printing` ~L136, `PRINTING_COLUMNS` ~L195, `deck_token_rows` ~L336, command `deck_tokens` ~L727, tests module)
- Modify: `src-tauri/src/schema.rs` (`USER_SCHEMA_VERSION` L538, `USER_SCHEMA_SQL` `decks` line ~L3914, migration ladder after v49, `tests::UNDO_*` constants ~L8420, rung tests ~L12265)
- Modify: `src-tauri/src/deck.rs` (`DeckPatch` ~L489, `DeckRow` ~L767, `DECK_SELECT` ~L1095, `deck_row` ~L1249, `DeckBefore` ~L1895, `update_deck` UPDATE ~L2194, `record_deck_edit` ~L2443, `duplicate_deck` ~L3087, tests)
- Modify: `src-tauri/src/deck_undo.rs` (`DECK_FIELDS`)
- Modify: `src-tauri/src/sync_engine/capture.rs` (~L404, `decks` field list)
- Modify: `src-tauri/src/mirror/layout.rs` (~L649, the `DeckRow` literal)

**Interfaces:**
- Produces (wire, camelCase): `DeckTokenRow` gains `setCode: string | null`, `collectorNumber: string | null`, `setName: string | null`, `rarity: string | null`, `finishes: string | null` (the printing's JSON finishes text, as `cards.finishes`), `unitPrice: number | null` (the effective printing at its default finish in the asked marketplace).
- Produces: command `deck_tokens(deck_id: i64, variant: String, marketplace: Marketplace)` — `marketplace` deserialises exactly as `card_printings`' does.
- Produces: `DeckRow.token_rail_index: i64` (wire `tokenRailIndex: number`), `DeckPatch.token_rail_index: Option<i64>` (wire `tokenRailIndex?: number`).
- Produces: audit row `{ field: "tokenRail", from: <i64>, to: <i64> }` of kind `deck` when the index changes.

- [ ] **Step 1: Write the failing tests.** In `deck_tokens.rs`' test module, beside `a_plain_token_resolves`, add a test that the resolved row carries the printing's set code, collector number, rarity and a TCGplayer price. Use the module's existing `Card` fixture builder (`treasure()` etc.); give the treasure printing `prices: {"usd": "0.25"}` and `finishes: ["nonfoil"]` through whatever fields the builder exposes (read `fn raw(&self)` ~L865 — it serialises the fixture into `cards.raw`/columns; add fields there if it lacks `prices`/`finishes`/`rarity`/`set_name`).

```rust
#[test]
fn a_resolved_token_carries_its_printings_chin_and_price() {
    let conn = open();
    let (deck, main, _) = deck_with_piles(&conn);
    tithe().insert(&conn);
    treasure().insert(&conn);
    play(&conn, deck, main, &tithe(), "live");
    let rows = deck_token_rows(&conn, deck, "live", Marketplace::Tcgplayer).unwrap();
    let t = rows.iter().find(|r| r.name == "Treasure").unwrap();
    assert_eq!(t.set_code.as_deref(), Some(treasure().set_code));
    assert_eq!(t.collector_number.as_deref(), Some(treasure().collector_number));
    assert_eq!(t.rarity.as_deref(), Some("common"));
    assert_eq!(t.unit_price, Some(0.25));
}

#[test]
fn a_foil_only_token_is_priced_at_its_foil_price() {
    let conn = open();
    let (deck, main, _) = deck_with_piles(&conn);
    tithe().insert(&conn);
    // The fixture builder's own fields; add `finishes`/`prices` to `Card` if it lacks them.
    Card { finishes: r#"["foil"]"#, prices: r#"{"usd":null,"usd_foil":"3.10"}"#, ..treasure() }.insert(&conn);
    play(&conn, deck, main, &tithe(), "live");
    let rows = deck_token_rows(&conn, deck, "live", Marketplace::Tcgplayer).unwrap();
    let t = rows.iter().find(|r| r.name == "Treasure").unwrap();
    assert_eq!(t.unit_price, Some(3.10));
    assert_eq!(t.finishes.as_deref(), Some(r#"["foil"]"#));
}

#[test]
fn an_unpriced_token_answers_none_rather_than_zero() {
    let conn = open();
    let (deck, main, _) = deck_with_piles(&conn);
    tithe().insert(&conn);
    Card { prices: "{}", ..treasure() }.insert(&conn);
    play(&conn, deck, main, &tithe(), "live");
    let rows = deck_token_rows(&conn, deck, "live", Marketplace::Tcgplayer).unwrap();
    assert_eq!(rows.iter().find(|r| r.name == "Treasure").unwrap().unit_price, None);
}
``` In `schema.rs`' tests, add a v51 rung test beside the v47 one (~L12265), same shape:

```rust
#[test]
fn v51_adds_token_rail_index_at_minus_one() {
    let conn = at_version(50); // use whatever helper the v47 test uses to build a v50 file
    conn.execute("INSERT INTO decks (...) VALUES (...)", []).unwrap(); // copy v47's fixture row
    migrate(&conn).unwrap();
    assert_eq!(has_column(&conn, "decks", "token_rail_index"), 1);
    let index: i64 = conn
        .query_row("SELECT token_rail_index FROM decks WHERE id = 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(index, -1, "every existing deck keeps its pile last");
}
```

In `deck.rs`' tests, beside the `token_stack` round-trip (~L10823), add:

```rust
#[test]
fn token_rail_index_round_trips_audits_and_undoes() {
    let conn = open_test_db();
    let deck = create_deck(&conn, &DeckInput { name: "R".into(), ..Default::default() }).unwrap();
    assert_eq!(deck.token_rail_index, -1);
    let moved = update_deck(&conn, deck.id, &DeckPatch { token_rail_index: Some(1), ..Default::default() }).unwrap();
    assert_eq!(moved.token_rail_index, 1);
    let audit: String = conn.query_row(
        "SELECT payload FROM deck_audit WHERE deck_id = ?1 ORDER BY id DESC LIMIT 1",
        [deck.id], |r| r.get(0)).unwrap();
    assert!(audit.contains("\"tokenRail\""));
    crate::deck_undo::undo(&conn, deck.id).unwrap(); // the module's public undo entry point
    assert_eq!(read_deck(&conn, deck.id).unwrap().unwrap().token_rail_index, -1);
    let copy = duplicate_deck(&conn, moved.id).unwrap();
    assert_eq!(copy.token_rail_index, 1, "an arrangement comes across with the deck");
}
```

Adapt helper names to the ones the neighbouring tests use (`open_test_db`, `create_deck`, `DeckInput`, the undo entry point) — read the `token_stack` tests first and copy their scaffolding verbatim.

- [ ] **Step 2: Run to verify they fail.** `cd src-tauri; cargo test deck_tokens::tests::a_resolved_token token_rail_index v51_adds` — expected: compile errors (missing fields / argument).

- [ ] **Step 3: Implement the schema rung.** After the last block in the ladder — `main`'s v50 once merged, v49's until then:

```rust
    // v51 (2026-09-26, the token-stacks spec §3.4): `decks.token_rail_index` — where the Tokens &
    // Emblems pile sits in the rail, as the number of rail piles drawn above it. `-1` is last,
    // today's place and every existing deck's; a value the rail no longer reaches also draws last
    // (`tokenRail.tsx`). v47's shape, one `ADD COLUMN`, and owes [`tests::UNDO_V51`].
    //
    // **`NOT NULL DEFAULT -1` and never a nullable column**: `deck::update_deck` writes every
    // field through `coalesce(?n, col)`, which reads a bound NULL as *leave it*, so a NULL "last"
    // could never be written back once the reader had moved the pile.
    if v < 51 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch("ALTER TABLE decks ADD COLUMN token_rail_index INTEGER NOT NULL DEFAULT -1;")?;
        // Literal `51`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA main.user_version = 51;")?;
        tx.commit()?;
    }
```

Set `USER_SCHEMA_VERSION` to `51`; append `, token_rail_index INTEGER NOT NULL DEFAULT -1` to the `decks` line of `USER_SCHEMA_SQL` exactly where the ladder would place it (after `managed_wishlist_mode`) so `the_user_schema_is_byte_identical_to_what_the_ladder_builds` stays green; add `const UNDO_V51: &str = "ALTER TABLE decks DROP COLUMN token_rail_index;";` beside `UNDO_V47` and thread it wherever the other `UNDO_V*` constants are listed. Grep `UNDO_V49` for every site.

- [ ] **Step 4: Thread the column through `deck.rs`.**
  - `DeckPatch`: `pub token_rail_index: Option<i64>,` beside `token_stack`, with a doc line pointing at the v51 rung.
  - `DeckRow`: `pub token_rail_index: i64,`.
  - `DECK_SELECT`: append `d.token_rail_index` after `d.managed_wishlist_mode`; `deck_row` reads it at the next index (grep the `r.get(27)` neighbours and update the "moved it to N" comment).
  - `DeckBefore`: `token_rail_index: i64,` and wherever `DeckBefore` is read, read it.
  - `update_deck`: add `token_rail_index = coalesce(?23, token_rail_index),` after `managed_wishlist_mode`, and bind `patch.token_rail_index` as the 23rd parameter. The existing comment pattern: "`?23`, the next number at the **end**, same rule one rung later."
  - `record_deck_edit`: after the last `field(...)` arm add
    ```rust
    if let Some(to) = patch.token_rail_index.filter(|i| *i != before.token_rail_index) {
        field("tokenRail", json!(before.token_rail_index), json!(to))?;
    }
    ```
  - `duplicate_deck`: copy `token_rail_index` in both column lists beside `token_stack`.
  - `deck_undo.rs` `DECK_FIELDS`: add `"token_rail_index"` with a comment: *an arrangement, like a category's `sort_order` — the reader moved it and Ctrl+Z moves it back; unlike `token_stack`, which is a view setting.*
  - `capture.rs`: add `"token_rail_index"` to the `decks` field list beside `"token_stack"`.
  - `mirror/layout.rs`: add `token_rail_index: -1,` to the literal.

- [ ] **Step 5: Chin facts and price in `deck_tokens.rs`.**
  - Extend `Printing` with `set_name: Option<String>`, `rarity: Option<String>`, `finishes: Option<String>` and `PRINTING_COLUMNS` with `set_name, rarity, finishes` **before** the image columns; bump `IMAGE_COL` accordingly (the comment at `printing_from` explains why the offset is load-bearing — update it).
  - Extend `DeckTokenRow` with `set_code: Option<String>`, `collector_number: Option<String>`, `set_name`, `rarity`, `finishes: Option<String>`, `unit_price: Option<f64>`, each doc-commented as *the effective printing's* (the one `image_uris` already describes).
  - Add `marketplace: crate::marketplace::Marketplace` (use the type `card.rs:126` uses) to `deck_token_rows` and the command, and fill the price with one read per row of the effective printing:
    ```rust
    /// The finish a token printing is priced and drawn at: its sole finish when it has exactly one
    /// that is not nonfoil, else nonfoil — `src/lib/finish.ts`' `playedFinish(null, finishes)`.
    fn default_finish(finishes: Option<&str>) -> &'static str {
        let listed: Vec<String> = finishes
            .and_then(|f| serde_json::from_str(f).ok())
            .unwrap_or_default();
        match listed.as_slice() {
            [only] if only == "foil" => "foil",
            [only] if only == "etched" => "etched",
            _ => "nonfoil",
        }
    }

    fn printing_price(conn: &Connection, card_id: &str, finishes: Option<&str>, market: Marketplace)
        -> Result<Option<f64>, String> {
        let finish = format!("'{}'", default_finish(finishes));
        conn.query_row(
            &format!("SELECT {} FROM cards c WHERE c.id = ?1", crate::sorting::price_expr(market, &finish)),
            params![card_id],
            |r| r.get::<_, Option<f64>>(0),
        )
        .optional()
        .map(Option::flatten)
        .map_err(|e| e.to_string())
    }
    ```
    `row_of` (or wherever `image_uris` is resolved for the effective printing) fills the six new fields from the effective `Printing`; an effective printing that is gone from the corpus answers `None` for all six.
  - The command gains `marketplace` and passes it through.

- [ ] **Step 6: Run the new tests and the module's existing ones.** `cargo test deck_tokens` then `cargo test token_rail_index` then `cargo test schema::tests::v51` then `cargo test the_user_schema_is_byte_identical`. Expected: all PASS. Fix the existing `deck_tokens` tests that now need a `marketplace` argument by passing `Marketplace::Tcgplayer`.

- [ ] **Step 7: Report** the list of files changed and any existing test you had to adapt, with why. Do not commit.

---

### Task A2: TypeScript data plumbing — mirror, views, hook, audit text, fake

**Files:**
- Modify: `src/lib/ipc.ts` (`DeckRow` ~L3874, `DeckPatch` ~L3447, `DeckTokenRow` ~L4456, `deckTokens` ~L7855), `src/lib/ipc.test.ts`
- Modify: `src/features/decks/deckTokens.ts`, `src/features/decks/deckTokens.test.ts`
- Modify: `src/features/decks/useDeckTokens.ts`
- Modify: `src/features/decks/auditText.ts`, `src/features/decks/auditText.test.ts`
- Modify: `.storybook/fake/db.ts` (`deck_tokens` ~L9882, deck row shape ~L680/L7147, create ~L16126, `deck_update` ~L16280, `deck_duplicate`), `.storybook/fake/db.test.ts`

**Interfaces:**
- Consumes (from A1, wire): the six `DeckTokenRow` fields, `tokenRailIndex`, the `deck_tokens` `marketplace` argument, the `tokenRail` audit field.
- Produces: `DeckTokenView` gains `setCode: string | null`, `collectorNumber: string | null`, `setName: string | null`, `rarity: string | null`, `finishes: string | null`, `unitPrice: number | null` — passed through from the row, no conclusion drawn — **and** `imageUris: Partial<Record<ImageVariant, string>> | null` (the row's map, passed through beside the resolved `imageUrl`, because `DeckCardFace` picks its own variant, `DECK_CARD_VARIANT`, off the map).
- Produces: `ipc.deckTokens(deckId: number, variant: DeckVariant, marketplace: MarketplaceKey): Promise<DeckTokenRow[]>` (use the same marketplace type `ipc.cardPrintings` takes).
- Produces: `DeckRow.tokenRailIndex: number`, `DeckPatch.tokenRailIndex?: number`.
- Produces: `useDeckTokens(deckId, variant)` — **signature unchanged**; it reads `useMarketplace()` itself and its query key becomes `["decks", "tokens", deckId, variant, marketplace]` (invalidation still drops to `["decks", "tokens", deckId]`).

- [ ] **Step 1: Failing tests.**
  - `ipc.test.ts`: if `DeckTokenRow` is not on the struct-field table, add it (`deck_tokens.rs`, `DeckTokenRow`); add `token_rail_index`/`tokenRailIndex` wherever `DeckRow` and `DeckPatch` are compared (the table compares field lists — adding the Rust field without the TS one goes red). Add a command case pinning `deck_tokens`' argument names `deckId`, `variant`, `marketplace`.
  - `deckTokens.test.ts`: a row with `setCode: "tclb", collectorNumber: "5", rarity: "common", finishes: '["nonfoil"]', unitPrice: 0.25` yields a view carrying the same six values.
  - `auditText.test.ts`: `{ field: "tokenRail", from: -1, to: 1 }` reads `Moved Tokens & Emblems` with detail `null`.
  - `db.test.ts`: `deck_tokens` rows carry the six fields (the fake's printing's set code etc. and a price read the way the fake prices `card_printings`); a created deck reads `tokenRailIndex: -1`; `deck_update({ patch: { tokenRailIndex: 2 } })` reads back `2`; `deck_duplicate` carries it.

- [ ] **Step 2: Run to verify failure.** `npx vitest run src/features/decks/deckTokens.test.ts src/features/decks/auditText.test.ts .storybook/fake/db.test.ts src/lib/ipc.test.ts` — expected FAIL (missing fields). `ipc.test.ts` may pass or fail depending on A1's progress; that is fine.

- [ ] **Step 3: Implement.**
  - `ipc.ts`: add the fields with doc comments pointing at `deck_tokens.rs`; `deckTokens: (deckId, variant, marketplace) => core.call("deck_tokens", { deckId, variant, marketplace })` (match the file's existing wrapper shape exactly).
  - `deckTokens.ts`: **delete the local wire mirror** (the block between "The wire shape, mirrored locally" and "end of the mirror") and replace it with `import type { DeckTokenRow, DeckTokenState, TokenSource } from "@/lib/ipc";` plus `export type { DeckTokenRow, DeckTokenState, TokenSource };` — the fan-in that block's own comment asked for. If `ipc.ts` does not export `DeckTokenState`/`TokenSource` by those names, export them there. Add the six fields to `DeckTokenView` and copy them in `viewOf`.
  - `useDeckTokens.ts`: `const { marketplace } = useMarketplace();` (import from `@/lib/marketplace` as other hooks do), key and call as in Interfaces.
  - `auditText.ts` `deckLine`: a `case "tokenRail": return { text: \`Moved ${TOKENS_HEADING}\`, detail: null };` — import `TOKENS_HEADING` from `./DeckTokensPanel`; if that import makes a cycle lint complains about, spell the literal with a comment naming the constant.
  - Fake: mirror every A1 change (deck rows default `tokenRailIndex: -1`, `deck_update` coalesces it, `deck_duplicate` copies it, `deck_tokens` accepts and uses `marketplace` and fills the six fields from the fake's printing row and its price function).

- [ ] **Step 4: Run the same files.** Expected PASS (ipc.test.ts once A1 has landed).

- [ ] **Step 5: Report** files changed. Do not commit.

---

### Task B: The one-row pile heading and the shared count pill

**Files:**
- Create: `src/features/decks/CountPill.tsx`, `src/features/decks/CountPill.test.tsx`
- Modify: `src/features/decks/views/GroupHeader.tsx`, `src/features/decks/views/GroupHeader.test.tsx`
- Modify: `src/features/decks/DeckTokensPanel.tsx`, `src/features/decks/DeckTokensPanel.stories.tsx`

**Interfaces:**
- Produces: `CountPill({ count, words }: { count: number; words: string }): JSX.Element` — the pill `TokenCountPill` draws today, taking its phrase from the caller.
- Produces: `cardCountWords(count: number): string` → `"1 card"` / `"N cards"` (from `plural`).
- Produces: `tokenCountWords(count: number): string` → `"1 token or emblem"` / `"N tokens and emblems"` — **moved** into `CountPill.tsx` and **without** the old `" to bring"` suffix.
- Produces: `export type GroupHeading = Pick<CardGroup, "name" | "count" | "totalPrice" | "isActive" | "kind">;` and `GroupHeader`'s prop `group: GroupHeading` (every existing caller passes a `CardGroup`, which satisfies it). New optional prop `words?: (count: number) => string` defaulting to `cardCountWords`, so the token pile passes `tokenCountWords`.

- [ ] **Step 1: Failing tests.** `CountPill.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { CountPill, cardCountWords, tokenCountWords } from "./CountPill";

it("spells the phrase once, for a screen reader, and shows the bare number", () => {
  const { container } = render(<CountPill count={3} words={cardCountWords(3)} />);
  expect(container.firstElementChild).toHaveTextContent("3");
  expect(screen.getByText("3 cards")).toHaveClass("sr-only");
  expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(/^3$/);
});

it.each([
  [1, "1 card", "1 token or emblem"],
  [2, "2 cards", "2 tokens and emblems"],
  [0, "0 cards", "0 tokens and emblems"],
])("words %i", (n, cards, tokens) => {
  expect(cardCountWords(n)).toBe(cards);
  expect(tokenCountWords(n)).toBe(tokens);
});
```

`GroupHeader.test.tsx`, added cases:

```tsx
it("states the count as a pill whose words a screen reader hears", () => {
  renderHeader({ count: 4 });           // use the file's existing render helper
  expect(screen.getByText("4 cards")).toHaveClass("sr-only");
  expect(screen.queryByText(/^4 cards$/, { selector: ":not(.sr-only)" })).toBeNull();
});

it("draws the stacked heading as one wrapping row, name first and figures after", () => {
  const { container } = renderHeader({ layout: "stacked" });
  const root = container.firstElementChild as HTMLElement;
  expect(root).toHaveClass("flex-wrap");
  expect(root).not.toHaveClass("flex-col");
  const name = screen.getByText("Ramp");  // the fixture group's name
  expect(name).toHaveClass("min-w-0", "truncate");
  const price = screen.getByText("$4.97");
  expect(price.parentElement).toHaveClass("shrink-0");
});

it("takes the caller's words for the token pile", () => {
  render(<GroupHeader group={{ name: "Tokens & Emblems", count: 5, totalPrice: null, isActive: true, kind: null }}
    marketplace={MARKETPLACES.tcgplayer} words={tokenCountWords} />);
  expect(screen.getByText("5 tokens and emblems")).toHaveClass("sr-only");
});
```

- [ ] **Step 2: Run** `npx vitest run src/features/decks/CountPill.test.tsx src/features/decks/views/GroupHeader.test.tsx` — expected FAIL.

- [ ] **Step 3: Implement `CountPill.tsx`** by moving `TokenCountPill`'s markup and its doc comment (edit the doc: it now counts **copies** on every pile — the spec §3.1 reversal — and is the heading's figure in all four views). `TokenCountPill.tsx` becomes a one-line deprecated re-export for this wave only (`export { CountPill as TokenCountPill } …` is **not** enough — its signature changed; leave `TokenCountPill.tsx` untouched instead; Task C stops importing it and Task F deletes it).

- [ ] **Step 4: Implement the heading.** In `GroupHeader.tsx`:
  - Replace the `group: CardGroup` prop type with `GroupHeading`; add `words`.
  - The root: `"flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5"` for **every** layout (drop the `flex-col` arm). `stacked` and `spread` give the name block `flex-1`; `tight` does not (unchanged rule).
  - The figures block: `"flex shrink-0 items-center gap-1.5 font-mono text-[0.625rem] tabular-nums text-dim"`, holding `<CountPill count={group.count} words={(words ?? cardCountWords)(group.count)} />` then the price span (tooltip unchanged). Delete the `·` separator and the `justify-between` arm.
  - Rewrite the `layout` doc: `stacked` is now "one row that wraps its figures under the name only when the column is too narrow for both" — keep the reasoning about why a 224px column differs from a band.
- [ ] **Step 5: The band.** In `DeckTokensPanel.tsx` swap `TokenCountPill` for `<CountPill count={copies} words={tokenCountWords(copies)} />` where `copies` is the sum of `quantity` over the tokens the band's header counted before (the kept, non-dismissed tokens). Update the story's assertions from the old `… to bring` words to the new ones.
- [ ] **Step 6: Run** the two test files plus `npx vitest run src/features/decks/CategoriesDialog.test.tsx` (it draws `GroupHeader` and asserts `"N cards"` by text — the `sr-only` span must still satisfy it). Expected PASS.
- [ ] **Step 7: Report.** Do not commit.

---

### Task C: The token pile on the deck's own parts

**Files:**
- Modify: `src/features/decks/DeckCardFace.tsx`
- Modify: `src/features/decks/CardStack.tsx`
- Modify: `src/features/decks/views/TokenPile.tsx`, `TokenPile.test.tsx`, `TokenPile.stories.tsx`

**Interfaces:**
- Consumes (A2): `DeckTokenView` with `setCode`, `collectorNumber`, `setName`, `rarity`, `finishes`, `unitPrice`.
- Consumes (B): `GroupHeader` with `group: GroupHeading` and `words`; `tokenCountWords` from `../CountPill`.
- Produces: `export type DeckCardFaceFacts = Pick<DeckCard, "cardId" | "needsReview" | "imageUris" | "finish" | "finishes" | "name" | "manaCost" | "typeLine" | "quantity" | "labelName" | "labelColor" | "gameChanger">;` and `DeckCardFace`'s `card: DeckCardFaceFacts`.
- Produces from `CardStack.tsx`: `export const STACKED_CARD_BODY = "relative block rounded-lg border bg-surface";` and `export function stackedCardShadow(open: boolean): string` (the two shadow strings `StackedCard` uses today) — `StackedCard` switches to both.
- Produces in `TokenPile.tsx` — the `TokenPile` interface (D1 and D2 build against this exactly):

```ts
export interface TokenPile {
  tokens: readonly DeckTokenView[];
  setQuantity: (oracleId: string, quantity: number) => void;
  pickArt: (oracleId: string) => void;
  /** The deck's stored rail index — `decks.token_rail_index`; `-1` is last. */
  railIndex: number;
  /** Move the pile to rail slot `index` (`-1` = last). Absent: the pile draws no grip. */
  moveTo?: (index: number) => void;
  /** The plan's mark for one token, or `null`. Absent: no marks (no plan, or on the plan). */
  theoryMark?: (view: DeckTokenView) => TheoryMark | null;
}
```

- Produces: `TokenStackPile({ pile, zoom, handle, sourceRef }: { pile: TokenPile; zoom: number; handle?: ReactNode; sourceRef?: (node: HTMLElement | null) => void | (() => void) })` — `handle` is drawn in `GroupHeader`'s `handle` slot; `sourceRef` is attached to the heading's wrapper `<div>` (the element a category's `attachSource` goes on). D1 supplies both.
- Produces: `tokenFaceFacts(view: DeckTokenView): DeckCardFaceFacts` and `tokenPileHeading(tokens: readonly DeckTokenView[]): GroupHeading` (exported for D1/tests).
- Deletes: `tokenStackCardHeight`, `tokenStackHeight` (D1 switches `StackView` to `stackHeight`).

- [ ] **Step 1: Failing tests** in `TokenPile.test.tsx` (keep the file's `token()` helper; give it the six new fields with defaults `setCode: "tclb", collectorNumber: "5", setName: "Commander Legends", rarity: "common", finishes: '["nonfoil"]', unitPrice: 0.25`; give `pileOf` `railIndex: -1`):

```tsx
it("heads the pile with GroupHeader: the name, the copies and the priced total", () => {
  renderStack(pileOf([token({ quantity: 3 }), token({ oracleId: "o-soldier", name: "Soldier", quantity: 2, unitPrice: null })]));
  const group = screen.getByRole("group", { name: TOKENS_HEADING });
  expect(within(group).getByText("5 tokens and emblems")).toHaveClass("sr-only");
  expect(within(group).getByText("$0.75")).toBeInTheDocument(); // 3 × 0.25; the unpriced Soldier adds nothing
});

it("shows an em dash for a pile no printing of which is priced", () => {
  renderStack(pileOf([token({ unitPrice: null })]));
  expect(within(screen.getByRole("group", { name: TOKENS_HEADING })).getAllByText("—").length).toBeGreaterThan(0);
});

it("draws each token as a deck card face with the quantity tag and a chin", () => {
  renderStack(pileOf([token({ quantity: 4 })]));
  const card = screen.getByRole("button", { name: /^Change the art for Treasure/ }).closest("li")!;
  expect(within(card).getByText("TCLB · 5")).toBeInTheDocument();          // the chin
  // `QuantityTag` forwards to `CountTag`, which is `aria-hidden` and carries its number as text —
  // `CardStack.test.tsx`'s own way of finding it (~L1144).
  const tag = within(card).getByText("4");
  expect(tag).toHaveAttribute("aria-hidden", "true");
});

it("wears the plan's mark when the pile is given one", () => {
  renderStack({ ...pileOf([token()]), theoryMark: () => ({ tier: "exact", delta: 0 }) });
  expect(document.querySelector(`[${THEORY_MATCH_ATTR}]`)).not.toBeNull();
});

it("is exactly the deck stack's height for the same count", () => {
  renderStack(pileOf([token(), token({ oracleId: "o2" }), token({ oracleId: "o3" })]));
  const list = screen.getByRole("list", { name: TOKENS_HEADING });
  expect(list).toHaveStyle({ height: `${stackHeight(3, DEFAULT_ZOOM)}px` });
});
```

Delete the tests of `tokenStackCardHeight` / `tokenStackHeight` and update every existing assertion that read `TokenCountPill`'s old `… to bring` words.

- [ ] **Step 2: Run** `npx vitest run src/features/decks/views/TokenPile.test.tsx` — FAIL.

- [ ] **Step 3: Narrow `DeckCardFace`.** Change the prop type to `DeckCardFaceFacts` (export it). No behaviour change; both existing callers pass a `DeckCard`.

- [ ] **Step 4: Share the stacked card's body.** In `CardStack.tsx` export `STACKED_CARD_BODY` and `stackedCardShadow(open)`; `StackedCard`'s `className` uses them (the long comments stay where they are, now above the constant).

- [ ] **Step 5: Rebuild `TokenPile.tsx`.**
  - `tokenFaceFacts(view)` returns `{ cardId: view.printingId, needsReview: null, imageUris: view.imageUris, finish: null, finishes: view.finishes, name: view.name, manaCost: null, typeLine: view.typeLine, quantity: view.quantity, labelName: null, labelColor: null, gameChanger: false }` (`imageUris` is A2's passthrough; `finish: null` is `DeckFinish`'s "not said", so `DeckCardFace`'s `playedFinish` falls to the printing's sole finish exactly as for a deck card).
  - `tokenPileHeading(tokens)`: `name: TOKENS_HEADING`, `count: Σ quantity`, `totalPrice`: Σ `unitPrice × quantity` over priced tokens, `null` if none priced (`grouping.ts`' `totals` rule, restated with a pointer to it), `isActive: true`, `kind: null`.
  - `TokenStackPile`: the root keeps `pileRootProps` and `p-1.5 border border-transparent rounded-lg`; the heading is `<div ref={sourceRef}><GroupHeader group={tokenPileHeading(pile.tokens)} marketplace={marketplace} layout="stacked" id={headingId} handle={handle} words={tokenCountWords} className="px-1 pb-1.5" /></div>` — `marketplace` comes from `useMarketplace()` inside the pile (it is one value app-wide; `StackView` does not need to thread it). The list: `style={{ height: stackHeight(pile.tokens.length, zoom) }}`; each `motion.li` animates `marginBottom` between `STACK_LIFTED_MARGIN` and `stackCollapsedMargin(zoom)` and carries `cn(STACKED_CARD_BODY, "border-border", stackedCardShadow(open))`; inside: the art-picker `<button>` wrapping `<DeckCardFace card={tokenFaceFacts(view)} width={stackCardWidth(zoom)} ruleBreakText={null} theoryMark={pile.theoryMark?.(view) ?? null} landedKey={undefined} />`, then `<CardChin zoom={zoom} rarity={view.rarity} setCode={view.setCode ?? ""} collectorNumber={view.collectorNumber ?? ""} printingTitle={view.setName === null ? null : \`${view.setName} · #${view.collectorNumber}\`} finish={playedFinish(null, view.finishes)} money={formatPrice(view.unitPrice, marketplace.currency)} seam="card" />`, then the stepper column as today.
  - `TokenGridPile`: same heading (`layout="tight"`), tiles draw `DeckCardFace` + `CardChin` at `tileWidth`.
  - `TokenTextPile` / `TokenTablePile`: swap `TokenPileHeading` for `GroupHeader` with `layout="spread"`.
  - Delete `TokenPileHeading`, `tokenStackCardHeight`, `tokenStackHeight` and the `TokenCountPill` import; rewrite the module doc's "The pile's heading carries no card count and no price" paragraph — it now carries copies and a price that never reaches the deck's totals.
- [ ] **Step 6: Stories.** `TokenPile.stories.tsx`: give the fixtures the six fields; add a story `WithPlanMarks` passing `theoryMark` answering exact for one token and unplanned for another.
- [ ] **Step 7: Run** `npx vitest run src/features/decks/views/TokenPile.test.tsx src/features/decks/CardStack.test.tsx` — PASS.
- [ ] **Step 8: Report.** Do not commit.

---

### Task D1: Placing, dragging and arrowing the pile in the rail

**Files:**
- Create: `src/features/decks/views/tokenRail.ts`, `src/features/decks/views/tokenRail.test.ts`
- Modify: `src/features/decks/views/StackView.tsx`, `GridView.tsx`, `TextView.tsx`, `views.test.tsx`

**Interfaces:**
- Consumes (C): `TokenPile.railIndex`, `TokenPile.moveTo`, `TokenStackPile`'s `handle` and `sourceRef`, `stackHeight`.
- Produces (`tokenRail.ts`):

```ts
/** Where the pile sits among `railLength` rail piles: `stored` when it is a slot the rail has,
 *  else `railLength` (last). `-1` is last by definition. */
export function tokenRailSlot(stored: number, railLength: number): number;
/** The value to store for slot `slot` of a rail of `railLength`: `-1` for the last slot. */
export function storedRailIndex(slot: number, railLength: number): number;
/** `items` with `pile` inserted at `slot`. */
export function withTokenPile<T, P>(items: readonly T[], slot: number, pile: P): (T | P)[];
export const TOKEN_PILE_DRAG = "mtg-grimoire/token-pile";
export function tokenPileDragData(): Record<string, unknown>;
export function isTokenPileDrag(data: Record<string, unknown>): boolean;
/** A rail pile's acceptance of the token pile, landing it at `slot`. */
export function useTokenPileDrop(slot: number | null, onMove?: (slot: number) => void): { attach: (el: HTMLElement | null) => void | (() => void); over: boolean; eligible: boolean };
/** The pile's own drag source — `useCategoryDragSource`'s shape, with the token payload. */
export function useTokenPileDragSource(enabled: boolean): { attachSource: (el: HTMLElement | null) => void | (() => void); attachHandle: (el: HTMLElement | null) => () => void };
export function TokenPileGrip(props: { ref: (el: HTMLElement | null) => void; slot: number; railLength: number; onMove: (slot: number) => void }): JSX.Element;
```

- [ ] **Step 1: Failing tests.** `tokenRail.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isTokenPileDrag, storedRailIndex, tokenPileDragData, tokenRailSlot, withTokenPile } from "./tokenRail";

describe("tokenRailSlot", () => {
  it.each([
    [-1, 3, 3], [0, 3, 0], [2, 3, 2], [3, 3, 3], [5, 3, 3], [2, 0, 0], [Number.NaN, 2, 2],
  ])("stored %d over %d rail piles is slot %d", (stored, len, slot) => {
    expect(tokenRailSlot(stored, len)).toBe(slot);
  });
});

describe("storedRailIndex", () => {
  it("stores the last slot as -1, so piles added later stay above the pile", () => {
    expect(storedRailIndex(3, 3)).toBe(-1);
    expect(storedRailIndex(1, 3)).toBe(1);
  });
});

it("inserts the pile at its slot", () => {
  expect(withTokenPile(["side", "maybe"], 1, "T")).toEqual(["side", "T", "maybe"]);
  expect(withTokenPile([], 0, "T")).toEqual(["T"]);
});

it("recognises its own payload and nobody else's", () => {
  expect(isTokenPileDrag(tokenPileDragData())).toBe(true);
  expect(isTokenPileDrag({ "mtg-grimoire/category-order": true, categoryId: 3 })).toBe(false);
});
```

`views.test.tsx` (use the file's existing StackView/GridView/TextView render helpers and its token fixtures):
  - Stacks, a deck with Sideboard + Maybeboard railed and `tokenPile.railIndex = 1`: inside `[data-deck-rail]` the children read, in order, Sideboard, `Tokens & Emblems`, Maybeboard (read group names off `aria-labelledby`/headings).
  - Stacks with `railIndex = 7`: the pile is the rail's last child.
  - Stacks: the pile's grip is named `Move Tokens & Emblems, 2 of 3` at slot 1; ArrowRight calls `moveTo(-1)` (last), ArrowLeft calls `moveTo(0)`; both `preventDefault` (the view's own arrow handler does not also fire — assert the selection callback was not called).
  - Stacks: no grip when `moveTo` is absent.
  - Grid: the token group sits between the Sideboard's and the Maybeboard's groups at `railIndex = 1`.
  - Text: same order inside its rail.
  - Table: unchanged — the token section still follows the table.

- [ ] **Step 2: Run** `npx vitest run src/features/decks/views/tokenRail.test.ts src/features/decks/views/views.test.tsx -t "token"` — FAIL.

- [ ] **Step 3: Implement `tokenRail.ts`.** `tokenRailSlot`: `Number.isInteger(stored) && stored >= 0 && stored <= railLength ? stored : railLength`. `storedRailIndex`: `slot >= railLength ? -1 : slot`. The drag and drop hooks copy `categoryDrag.ts`' `useCategoryDragSource` / `useCategoryReorderDrop` with the payload swapped for `tokenPileDragData()` and the reader for `isTokenPileDrag` (a `read` that returns `true` or `null`); `canDrop` is `slot !== null`. `TokenPileGrip` copies `StackView.tsx`'s `CategoryGrip` (the `GripVertical` button, `GRIP_ATTR`, `FOCUS`, the tooltip, the `preventDefault` on both arrows including the no-op ends) with `aria-label={\`Move ${TOKENS_HEADING}, ${slot + 1} of ${railLength + 1}\`}` and steps `onMove(slot ± 1)` within `[0, railLength]`. Document at the top of the file why this is not a category (spec §3.4: an index, not an anchor; the pile is in no run).

- [ ] **Step 4: `StackView.tsx`.**
  - `const slot = drawsTokens ? tokenRailSlot(tokenPile.railIndex, rail.length) : 0;`
  - Render the rail as `withTokenPile(rail.map(group => ({ group })), slot, TOKEN_ITEM)` — each rail `StackGroup` keeps its key; the token item renders `<TokenStackPile pile={tokenPile} zoom={cardZoom} handle={grip} sourceRef={attachSource} />` where the grip and source come from `useTokenPileDragSource(tokenPile.moveTo !== undefined)` and `TokenPileGrip` (`onMove={(s) => tokenPile.moveTo?.(storedRailIndex(s, rail.length))}`). The hook call has to live in a component, so wrap the token item in a small `RailTokenPile` component in this file.
  - Each railed `StackGroup` gets a new optional prop `tokenSlot?: number` (its own index in the rail **counting the token pile**'s shift: the slot the pile would take if dropped on it — its rail index, since dropping above a pile puts the token pile at that pile's index) and `onTokenMove`; inside, `useTokenPileDrop(tokenSlot ?? null, onTokenMove)` attaches to the same reorder wrapper `<div>` that `attachReorder` uses (compose the two refs in one callback that returns both cleanups), and its `eligible`/`over` join the existing `DROP_RING`/`DROP_OVER`/`DropIndicator` expressions. Flow piles and the command zone pass nothing.
  - `liftRoom`: replace the token clause with `(drawsTokens && tokenPile.tokens.length > 1)` unchanged in meaning — a token card now has a chin, so it lifts exactly as a deck card does.
- [ ] **Step 5: `GridView.tsx`.** `const ordered = [...command, ...flow, ...withTokenPile(rail, slot, TOKEN_ITEM)]`; render the token item as today's `TokenGridPile` in its place instead of after the loop. No grip in Grid (the spec gives the gesture to the rail, which Grid does not draw); the index is spent as order.
- [ ] **Step 6: `TextView.tsx`.** Same insertion inside its rail's `map`.
- [ ] **Step 7: Run** the Step 2 command — PASS. Then `npx vitest run src/features/decks/views/views.test.tsx` whole — PASS.
- [ ] **Step 8: Report.** Do not commit.

---

### Task D2: The editor — rail index, move and the token theory plan

**Files:**
- Create: `src/features/decks/tokenTheory.ts`, `src/features/decks/tokenTheory.test.ts`
- Modify: `src/features/decks/DeckEditor.tsx` (~L3915–3975), `src/features/decks/DeckEditor.test.tsx`

**Interfaces:**
- Consumes (A2): `DeckRow.tokenRailIndex`, `DeckPatch.tokenRailIndex`, `useDeckTokens`.
- Consumes (C): the `TokenPile` interface above.
- Consumes: `theoryMatchPlan`, `theoryMatchMark`, `theorySlot`, `type TheoryPlan`, `type TheoryMarkSwitches`, `type TheoryMark` from `./theoryMatch`.
- Produces (`tokenTheory.ts`):

```ts
/** The plan's tokens as `TheorySlot`s — each effective printing, keyed exactly as a deck card's
 *  slot is (`theorySlot({ cardId, finish: null })`), named by the token's name. `undefined` in,
 *  `undefined` out: a plan that has not loaded marks nothing. */
export function tokenTheorySlots(plan: readonly DeckTokenView[] | undefined): TheorySlot[] | undefined;
/** `theoryMatchPlan` over the live tokens, as cards. */
export function tokenTheoryPlan(
  plan: readonly DeckTokenView[] | undefined,
  live: readonly DeckTokenView[],
  marks: TheoryMarkSwitches,
): TheoryPlan | undefined;
/** One live token's mark. */
export function tokenTheoryMark(plan: TheoryPlan | undefined, view: DeckTokenView): TheoryMark | null;
```

- [ ] **Step 1: Failing tests.** `tokenTheory.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { tokenTheoryMark, tokenTheoryPlan } from "./tokenTheory";
import type { DeckTokenView } from "./deckTokens";

const ON = { exact: true, name: true, unplanned: true };
function view(over: Partial<DeckTokenView>): DeckTokenView { /* same defaults as TokenPile.test's token() */ }

describe("tokenTheoryPlan", () => {
  it("marks nothing while the plan has not loaded", () => {
    const plan = tokenTheoryPlan(undefined, [view({})], ON);
    expect(tokenTheoryMark(plan, view({}))).toBeNull();
  });
  it("ticks a token the plan makes in the same printing", () => {
    const t = view({ printingId: "p1", quantity: 1 });
    expect(tokenTheoryMark(tokenTheoryPlan([t], [t], ON), t)).toEqual({ tier: "exact", delta: 0 });
  });
  it("crosses a token only a substitute makes", () => {
    const live = view({ oracleId: "o-goblin", name: "Goblin", printingId: "p-g" });
    expect(tokenTheoryMark(tokenTheoryPlan([], [live], ON), live)).toEqual({ tier: "unplanned", delta: 0 });
  });
  it("names the mismatch when the plan makes a same-named token in another printing", () => {
    const live = view({ printingId: "p-a" });
    const planned = view({ printingId: "p-b" });
    expect(tokenTheoryMark(tokenTheoryPlan([planned], [live], ON), live)?.tier).toBe("name");
  });
  it("honours a switched-off tier", () => {
    const live = view({ oracleId: "o-goblin", name: "Goblin", printingId: "p-g" });
    expect(tokenTheoryMark(tokenTheoryPlan([], [live], { ...ON, unplanned: false }), live)).toBeNull();
  });
});
```

`DeckEditor.test.tsx` (use the file's existing harness that mounts a deck with `tokenStack: true` and mocked `ipc`; grep `tokenStack` in it for the fixture):
  - the pile's grip ArrowLeft calls `ipc.deckUpdate` with `{ tokenRailIndex: <slot - 1> }`;
  - on a deck with `theoryEnabled` on the Live list, `ipc.deckTokens` is called for `"theory"` too, and a token the theory list also makes wears `[data-theory-match]`.

- [ ] **Step 2: Run** `npx vitest run src/features/decks/tokenTheory.test.ts` — FAIL.

- [ ] **Step 3: Implement `tokenTheory.ts`.** `tokenTheorySlots`: `plan?.map(v => ({ key: theorySlot({ cardId: v.printingId, finish: null }), nameKey: v.name, quantity: v.quantity }))`. `tokenTheoryPlan`: `theoryMatchPlan(tokenTheorySlots(plan), live.map(v => ({ cardId: v.printingId, finish: null, name: v.name, quantity: v.quantity, categoryActive: true })), marks)`. `tokenTheoryMark`: `theoryMatchMark(plan, { cardId: view.printingId, finish: null, name: view.name })`. Module doc: spec §3.5, and why until PR 2 the delta is always 0.

- [ ] **Step 4: Wire `DeckEditor.tsx`.**
  - `const planTokens = useDeckTokens(theoryEnabled && variant === "live" ? deckId : null, "theory");` — a `null` deck id disables the query (the hook already gates on it). Only its `tokens` are read; never its writes.
  - `const tokenPlan = useMemo(() => row === null || !(theoryEnabled && variant === "live") ? undefined : tokenTheoryPlan(planTokens.query.isSuccess ? planTokens.tokens.filter(v => v.state !== "hidden") : undefined, tokenList, { exact: row.theoryMarkExact, name: row.theoryMarkName, unplanned: row.theoryMarkUnplanned }), [...])`.
  - `const moveTokenPile = useCallback((index: number) => update({ tokenRailIndex: index }), [update])` — `update` is the editor's existing `useDeck` patch mutation (grep how `tokensOpen` is written).
  - `tokenPile` gains `railIndex: row?.tokenRailIndex ?? -1`, `moveTo: moveTokenPile`, `theoryMark: tokenPlan === undefined ? undefined : (v) => tokenTheoryMark(tokenPlan, v)`; add the new values to the `useMemo` deps.
- [ ] **Step 5: Run** `npx vitest run src/features/decks/tokenTheory.test.ts` and the two new `DeckEditor.test.tsx` cases (`-t "token"`) — PASS.
- [ ] **Step 6: Report.** Do not commit.

---

### Task E: `Any card` on the deck search's Collection tab

**Files:**
- Modify: `src/features/decks/useCollectionSearch.ts` (~L424 `format: format || undefined`; the returned surface ~L590), `src/features/decks/useCollectionSearch.test.ts`
- Modify: `src/features/decks/DeckSearchPanel.test.tsx`

**Interfaces:**
- Consumes: `ANY_CARD`, `formatParams` from `@/features/search/useCardSearch`.
- Produces: the Collection tab's `FilterSurface` sets `anyCard: true`; its request carries `...formatParams(format)`.

- [ ] **Step 1: Failing tests.** `useCollectionSearch.test.ts` (use its existing `renderHook` harness and `ipc.collectionList` mock):

```ts
it.each([
  ["any-card", {}],
  ["", { playableOnly: true }],
  ["modern", { format: "modern", playableOnly: true }],
])("the %s row sends %o", async (row, expected) => {
  const { result } = renderSearch();                    // the file's helper
  act(() => result.current.setFormat(row));
  await waitFor(() => expect(lastCollectionQuery()).toMatchObject(expected));
  const q = lastCollectionQuery();
  if (!("format" in expected)) expect(q.format).toBeUndefined();
  if (!("playableOnly" in expected)) expect(q.playableOnly).toBeUndefined();
});

it("offers Any card", () => {
  expect(renderSearch().result.current.anyCard).toBe(true);
});
```

`DeckSearchPanel.test.tsx`, one case per tab: open the Format dropdown (`pickOption(user, "Format", "Any card")` — the helper the file already imports), advance past the debounce, and assert the trigger still reads `Any card` and the last request (`collectionList` on Collection, `searchCards` on All cards) carries neither `format` nor `playableOnly`.

- [ ] **Step 2: Run** `npx vitest run src/features/decks/useCollectionSearch.test.ts src/features/decks/DeckSearchPanel.test.tsx -t "Any card|any-card|row sends"` — FAIL.
- [ ] **Step 3: Implement.** Replace `format: format || undefined,` with `...formatParams(format),` and add `anyCard: true,` to the returned surface, with a comment: the Collection tab now draws the All cards tab's ladder (spec §3.6) — `Any format` is *legal somewhere*, so an orphan copy is hidden under it and shown under `Any card`; the collection **page** (`useCollection`) is untouched because it does not narrow the corpus. Rust needs nothing: `collection.rs` keeps `q.cards.playable_only` (only `paper_only` is forced off). Check `activeFilterCount`'s format term still counts `ANY_CARD` as a filter and `Any format` as none (it compares with `""`).
- [ ] **Step 4: Run** Step 2 — PASS.
- [ ] **Step 5: Report.** Do not commit.

---

### Task F (orchestrator): fan-in, docs, verify, live pass, ship

**Files:**
- Delete: `src/features/decks/TokenCountPill.tsx` once `grep -rn TokenCountPill src .storybook` is empty.
- Modify: `src/features/decks/CLAUDE.md` (the *Tokens & Emblems* section: the pill counts copies; the pile is drawn with `GroupHeader`/`DeckCardFace`/`CardChin`; "no marketplace in the key" is now false; the rail index and its drag; theory marks), `docs/reference/decks-storage.md` (the six new `DeckTokenRow` fields and the marketplace argument; `decks.token_rail_index`), `docs/reference/data-and-sync.md` (schema ladder row for v51), `src/CLAUDE.md` (the `CardArt` bullet says `DeckTokensPanel` and `TokenArtPicker` are the non-wall callers — `TokenPile` no longer draws `CardArt`; check the sentence still holds).

- [ ] **Step 1:** `git status` — confirm only planned files changed; read every subagent's report for anything it flagged.
- [ ] **Step 2:** `npx tsc --noEmit` — fix cross-task type seams (the `TokenPile` interface, `GroupHeading`, `DeckCardFaceFacts`, `DeckTokenView` fields).
- [ ] **Step 3:** Delete `TokenCountPill.tsx`; update the docs above; re-count any number a doc states.
- [ ] **Step 4:** `npm run verify` (never piped through `tail` — memory `verify-exit-code-lies-through-a-pipe`), then `cd src-tauri; cargo fmt --check; cargo clippy --all-targets -- -D warnings` (verify runs neither). Fix, repeat until green.
- [ ] **Step 5: Live pass** (`running-the-app` skill: take the `app` lock; copy the whole `src-tauri/target/debug/data` from the main checkout with the app stopped — memory `mtg-grimoire-worktree-live-testing`). On a Commander deck with `tokenStack` on and a Sideboard + Maybeboard, over `scripts/cdp.mjs` (PowerShell), at 0.5×, 1× and 2× `cardZoom.deck`:
  - every stacked heading is one row at 1× and 2×; at 0.5× nothing overflows its column (`scrollWidth === clientWidth` on each `[data-deck-stack]` and the rail);
  - the token card and a deck card measured in the **same frame**: equal width, equal face height, equal chin height;
  - drag the token pile's heading onto the Sideboard — it lands above it; reload; it is still there; Ctrl+Z puts it back, Ctrl+Shift+Z moves it again; the history dialog reads *Moved Tokens & Emblems*;
  - arrow the grip to the end; `tokenRailIndex` reads `-1`;
  - on a deck with a plan, on Live: a token both lists make wears the tick, one only Live makes wears the X;
  - deck search: Collection tab, pick `Any card` — it sticks and owned tokens appear.
  Record the figures in `docs/reference/decks-live-findings.md` under a 2026-09-26 heading.
- [ ] **Step 6: Commit** in small commits by concern (`feat: …` Rust, TS data, headers, token pile, rail, theory, collection tab; `docs: …`), each after `npm run verify` is green on the whole tree.
- [ ] **Step 7: Ship** with the `auto-pr` skill (`pr-auto.ps1`): PR titled `feat: token stacks look and move like the deck's own piles`, body linking the spec and listing PR 2 and PR 3 as follow-ups.
