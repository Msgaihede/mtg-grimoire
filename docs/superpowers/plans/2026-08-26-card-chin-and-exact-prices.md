# The card chin, and an exact price on every card — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every card in the app is drawn with the deckbuilder's bottom chin, and carries a price
for its exact printing and finish.

**Architecture:** One `CardChin` component and one `chinHeight(zoom)` sum replace three drifted
card feet. `CardGrid` gains a `money` slot and an optional tile `key`, so the collection's two
merges can split a foil from a nonfoil. Two SQL expressions in `wishlist.rs` stop asking a
foil-only printing for a nonfoil price and start picking the cheapest printing for an
any-printing wish.

**Tech Stack:** React 19 + TypeScript 6, Tailwind v4, Vitest + Testing Library, Storybook 9,
Rust + rusqlite (SQLite), Tauri 2.11.

**Spec:** `docs/superpowers/specs/2026-08-26-card-chin-and-exact-prices-design.md` — read it
first. Every task argues from it.

## Global Constraints

- **Never install `@types/node`.** It retypes `setTimeout` across the app program.
- **A computed Tailwind class emits no CSS rule.** The scanner reads source text, so anything
  built by interpolation produces nothing. Anything that moves with the zoom is an inline style or
  a `calc(… * var(--mark-scale, 1))` written out in full.
- **Do not write a class name you did not use, comments included.** This file tree is under
  Tailwind's `@source`, and the repo's transition sweep reads doc comments as markup.
- **`--mark-scale` is how a mark learns the zoom**, never a prop: `RarityGem`, `FinishMark` and
  `OwnedBadge` are each drawn on still surfaces too (tables, the card pane), which must not scale.
- **No `setState` inside an effect.** It fails lint only at `npm run verify`.
- **Do not run `npm run verify` inside a task.** Tasks compile against a tree their siblings are
  still changing. The controller runs it once after fan-in — see Task 14.
- **Do not commit from a subagent.** The git index is shared across agents in this worktree; a
  bare `git commit` takes whatever a sibling staged. Report what you changed; the controller
  commits.
- **`cargo test` filters that match nothing exit 0.** Any Rust step that claims PASS must report
  the number of tests *selected*.
- **Mutation check.** After a test passes, break the implementation, confirm the test goes red,
  restore it, and say so in your report. If a test survives the mutation, say that too.

## File structure

**Created**

| File | Responsibility |
| --- | --- |
| `src/components/CardChin.tsx` | The one card foot: felt, edges, and five slots. |
| `src/components/CardChin.test.tsx` | Slots draw and omit; `tone` and `seam` colour the right edges. |
| `src/components/CardChin.stories.tsx` | The chin on both seams, at three zooms. |

**Modified**

| File | Change |
| --- | --- |
| `src/lib/cardZoom.ts` | `CHIN_HEIGHT`, `CHIN_RISE`, `chinHeight()` |
| `src/lib/cardZoom.test.ts` | The chin scales in both directions |
| `src/features/decks/CardStack.tsx` | Render `CardChin`; re-export the promoted constants |
| `src/features/decks/views/GridView.tsx` | Render `CardChin`; delete its own foot constants |
| `src/features/search/CardGrid.tsx` | `money` slot, `GridCard.key`, action strip over the art, `CAPTION_HEIGHT` → `chinHeight` |
| `src/features/search/SearchPage.tsx` | `money` = `priceRange` |
| `src/features/tags/TagResults.tsx` | `money` = `priceRange` |
| `src/features/card/AllPrintingsDialog.tsx` | `money` = `cheapestPrice` |
| `src/features/decks/DeckSearchPanel.tsx` | `money` = `priceRange` |
| `src/features/decks/collectionTiles.ts` | Split `foldCopies` by finish; carry `unitPrice` |
| `src/features/decks/CollectionSearchTab.tsx` | `money` = the tile's `unitPrice` |
| `src/features/collection/CollectionPage.tsx` | Split tiles by finish; `money`; `openCardAsFinish` |
| `src/features/wishlist/WishlistGrid.tsx` | `money` = the wish's `unitPrice`; corner moved down |
| `src/lib/store.ts` | `paneFinish`, `openCardAsFinish` |
| `src/features/card/CardDetailPane.tsx` | Seed `foilView`; rewrite `foilViewFinish`'s note |
| `src-tauri/src/sorting.rs` | `row_price_expr`, generalized off `deck_cards` |
| `src-tauri/src/wishlist.rs` | Both pricing changes |
| `docs/reference/frontend-design.md` | The chin as the one card foot |
| `docs/reference/wishlist-folders.md` | The two pricing changes |
| `docs/reference/collection-folders.md` | Finish splits the wall |
| `docs/reference/data-and-sync.md` | The measured cost of the cheapest-printing join |

## Waves

Tasks within a wave touch disjoint files and may run in parallel. Waves are sequential.

| Wave | Tasks |
| --- | --- |
| 1 | 1 (geometry), 2+3 (Rust, one agent — same two files), 4 (store + pane) |
| 2 | 5 (`CardChin`) — needs Task 1 |
| 3 | 6 (`CardStack`), 7 (`GridView`), 8 (`CardGrid`) — need Task 5 |
| 4 | 9 (catalogue walls), 10 (wishlist), 11 (`foldCopies`), 12 (collection wall) — need Task 8 |
| 5 | 13 (docs), 14 (verify + live pass) |

---

### Task 1: The chin's geometry

The three surfaces each hold their own copy of "how tall is the foot" — 28px, 25px and 20px —
which is how they drifted. One sum, in the module that already answers "how big is a thing on a
card at this zoom".

**Files:**
- Modify: `src/lib/cardZoom.ts` (add after `scaled`, around line 256)
- Test: `src/lib/cardZoom.test.ts`

**Interfaces:**
- Consumes: `scaled(base, zoom)` from this same file — `Math.round(base * zoom)`.
- Produces: `CHIN_HEIGHT: 28`, `CHIN_RISE: 4`, `chinHeight(zoom: number): number`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/cardZoom.test.ts`, inside the existing top-level `describe`:

```ts
  /**
   * The chin moves with the card in **both** directions, and it is the same sum on all three
   * surfaces that draw one. It floored on two of them and the floor's failure mode has swapped
   * ends: 28px of empty felt under a 105px card.
   */
  it("scales the chin with the card, with no floor", () => {
    expect(chinHeight(DEFAULT_ZOOM)).toBe(CHIN_HEIGHT);
    for (const step of ZOOM_STEPS) {
      expect(chinHeight(step)).toBe(scaled(CHIN_HEIGHT, step));
    }
    expect(chinHeight(0.5)).toBeLessThan(CHIN_HEIGHT);
  });

  /**
   * The rise does **not** scale, because the thing it is derived from does not: it is a Tailwind
   * `rounded-[7px]` corner less its own 1px border, and that corner is 7px at every zoom. A rise
   * that scaled would clear the seam at 1× and show two hairlines of background at 0.5×.
   */
  it("holds the rise still at every zoom", () => {
    expect(CHIN_RISE).toBe(4);
    expect(chinHeight(2) - CHIN_RISE).toBeGreaterThan(chinHeight(1) - CHIN_RISE);
  });
```

Add `CHIN_HEIGHT`, `CHIN_RISE`, `chinHeight` to that file's existing import from `./cardZoom`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/cardZoom.test.ts`
Expected: FAIL — `chinHeight is not a function` / `CHIN_HEIGHT` undefined.

- [ ] **Step 3: Implement**

In `src/lib/cardZoom.ts`, after `scaled`:

```ts
/**
 * The card's foot at 100% zoom — the bar under the face carrying the printing's own facts.
 *
 * **Promoted out of `CardStack`, where it was `STACK_DATA_HEIGHT`**, because three surfaces drew
 * a foot and each held its own number: 28px on the deck's stacks, 25px on the five walls
 * `CardGrid` draws, and 20px on the deck's grid. Three numbers is how a shared look stops being
 * shared, and the type inside them had drifted the same way (10px, 12px, 9px). One constant here,
 * one component in `components/CardChin.tsx`, and the next surface cannot disagree.
 */
export const CHIN_HEIGHT = 28;

/**
 * How far the chin rides **up** over the face's bottom corners.
 *
 * It is what joins the two boxes into one card: the face clips its own 7px corners, and a bar
 * butted flush under them shows two hairlines of background through the gap. Four pixels is that
 * radius less its own border, so the chin's square top corners are covered exactly where the face
 * is still solid.
 *
 * **It does not zoom**, because the radius it is derived from does not — the corner is a Tailwind
 * class, 7px at every stop, so the overlap that hides the seam is 4px at every stop too.
 */
export const CHIN_RISE = 4;

/**
 * The chin's height at this zoom — it moves with the card in **both** directions.
 *
 * It floored on two of the three surfaces, and the argument for the floor was sound while it
 * lasted: the bar holds type, the type was fixed, and a plain multiply gave a 14px bar around
 * 11px words at 0.5×. The gem, the finish glyph and the words all read `--mark-scale` now, so the
 * bar and its contents are one proportion and a floored bar is 28px of empty felt under a 105px
 * card.
 */
export function chinHeight(zoom: number): number {
  return scaled(CHIN_HEIGHT, zoom);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/lib/cardZoom.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutate**

Change `chinHeight` to `return Math.max(CHIN_HEIGHT, scaled(CHIN_HEIGHT, zoom))` — the floor this
replaces. Confirm the first test goes red at 0.5×. Restore. Report whether it caught it.

- [ ] **Step 6: Report**

Do not commit. Report the files changed and the mutation result.

---

### Task 2: Rust — a wish with no preferred finish is priced at the chain

`WISH_FINISH` is `coalesce(w.preferred_finish, 'nonfoil')`, which asks a foil-only printing for a
nonfoil price and gets `NULL`. **Wakka, Devoted Guardian (FIC #477)** is the live case:
`finishes: ["foil"]`, `usd: null`, `usd_foil: 31.18`. All 88 wishes in the dev database name no
finish, and 12,849 of 116,843 printings are priced only in foil or etched.

The deck solved this at schema v18 and the wishlist never adopted it. Generalize
`deck_card_price_expr` off its hard-coded `dc.` alias rather than writing a third copy.

**Files:**
- Modify: `src-tauri/src/sorting.rs` (`deck_card_price_expr`, around line 270)
- Modify: `src-tauri/src/wishlist.rs` (`WISH_FINISH` around line 314; `list_wishes`'s `price =`
  around line 888)
- Test: `src-tauri/src/wishlist.rs`'s inline `#[cfg(test)]` module

**Interfaces:**
- Consumes: `price_expr(market, finish)`, `printing_price_by_finish_expr(market)` — both already
  in `sorting.rs`.
- Produces: `pub fn row_price_expr(market: Marketplace, finish_col: &str) -> String`.

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/wishlist.rs`'s test module. Follow the seeding helpers already in that module —
read `the_unit_price_follows_the_preferred_finish` (around line 2091) and copy its fixture shape
rather than inventing one.

```rust
    /// A wish that names **no** finish is a wish for the card, so it is priced at the printing's
    /// own chain — `nonfoil → foil → etched` — exactly as a deck row with a null finish is.
    ///
    /// This is the Wakka case, which is where the bug was reported from: FIC #477 is sold only in
    /// foil, so `coalesce(preferred_finish, 'nonfoil')` asked for a `$.usd` that does not exist
    /// and drew an em dash beside a search wall quoting the same printing at $31.18. 12 849 of
    /// 116 843 printings are priced only in foil or etched, so this is 11 % of anything a reader
    /// can wish for.
    #[test]
    fn a_wish_with_no_preferred_finish_falls_through_to_the_foil_price() {
        let conn = crate::db::test_conn();
        seed_card_with_prices(
            &conn,
            "wakka-fic",
            r#"["foil"]"#,
            r#"{"usd": null, "usd_foil": "31.18"}"#,
        );
        add_wish(&conn, "wakka-fic", None);

        let page = list_wishes(&conn, &query_at(Marketplace::Tcgplayer)).unwrap();

        assert_eq!(
            page.items[0].unit_price,
            Some(31.18),
            "a foil-only printing is quoted at its foil rate, not left unpriced"
        );
    }

    /// A wish that **does** name a finish is priced at that finish and at no other. No fallback of
    /// any kind: the reader has said which object they want, and an em dash means "this
    /// marketplace does not quote this printing in this finish", never "look somewhere else".
    #[test]
    fn a_named_finish_never_falls_back_to_another_ones_price() {
        let conn = crate::db::test_conn();
        seed_card_with_prices(
            &conn,
            "bolt-both",
            r#"["nonfoil","foil"]"#,
            r#"{"usd": "1.00", "usd_foil": "9.00"}"#,
        );
        add_wish(&conn, "bolt-both", Some("foil"));
        add_wish(&conn, "bolt-both", Some("etched"));

        let page = list_wishes(&conn, &query_at(Marketplace::Tcgplayer)).unwrap();
        let priced: Vec<Option<f64>> = page
            .items
            .iter()
            .map(|r| r.unit_price)
            .collect();

        assert!(
            priced.contains(&Some(9.00)),
            "the foil wish is quoted at the foil rate"
        );
        assert!(
            priced.contains(&None),
            "the etched wish is unpriced — this printing is not sold etched, and quoting the \
             nonfoil rate for it would be a price nobody quoted"
        );
        assert!(
            !priced.contains(&Some(1.00)),
            "and neither wish is ever quoted at the nonfoil rate"
        );
    }
```

If `seed_card_with_prices`, `add_wish` or `query_at` do not exist under those names in that
module, use whatever the neighbouring tests already use and keep the assertions identical. Do not
add a fixture row to `cards` outside a test — `cards` belongs to the sync.

- [ ] **Step 2: Run them and watch them fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml wishlist:: -- --nocapture`
Expected: the two new tests FAIL — the first with `left: None, right: Some(31.18)`.
**Report how many tests the filter selected.** A filter that matches nothing exits 0.

- [ ] **Step 3: Generalize the deck's expression**

In `src-tauri/src/sorting.rs`, replace `deck_card_price_expr`'s body and add the general form
above it:

```rust
/// What one copy of a row that **may or may not name a finish** costs at `market`.
///
/// Two arms, told apart by whether the row has said:
///
/// * **NULL** — the row has not said, so it is [`printing_price_by_finish_expr`]'s chain,
///   `nonfoil → foil → etched`. A foil-only printing is quoted at its foil rate instead of
///   reading as unpriced.
/// * **named** — [`price_expr`] at that finish and no other. **No fallback of any kind**: the
///   reader has said which object is in the sleeve, and the em dash a null answer draws means
///   "this marketplace does not quote this printing in this finish".
///
/// `finish_col` is the caller's column — `dc.finish` for a deck row, `w.preferred_finish` for a
/// wish. **The printing is always the alias `c`**, which is [`price_expr`]'s rule and not this
/// function's to relax.
///
/// **It was `deck_card_price_expr` and the deck was the only caller for one release.** The
/// wishlist coalesced its null to `'nonfoil'` instead, which is the same bug v18 fixed for decks
/// arriving one table over: 12 849 of 116 843 printings are priced only in foil or etched.
/// Generalizing is what stops it being fixed twice and spelled twice.
///
/// Cardmarket's missing `eur_etched` survives into both arms for free, because that hole lives in
/// [`price_expr`] rather than here.
pub fn row_price_expr(market: Marketplace, finish_col: &str) -> String {
    format!(
        "CASE WHEN {finish_col} IS NULL THEN {chain} ELSE {named} END",
        chain = printing_price_by_finish_expr(market),
        named = price_expr(market, finish_col),
    )
}

/// What one copy of a **deck row** costs at `market` — [`row_price_expr`] over `deck_cards`.
///
/// `dc` is the caller's alias for `deck_cards`, which is [`crate::deck`]'s throughout.
pub fn deck_card_price_expr(market: Marketplace) -> String {
    row_price_expr(market, "dc.finish")
}
```

Keep every existing doc paragraph on `deck_card_price_expr` that is still true by moving it onto
`row_price_expr` — the two-arm rule, the no-fallback rule and the euro hole are all now that
function's to state. Do not delete them.

- [ ] **Step 4: Point the wishlist at it**

In `src-tauri/src/wishlist.rs`, in `list_wishes`'s `format!`, change:

```rust
        price = crate::sorting::price_expr(q.marketplace, WISH_FINISH)
```

to:

```rust
        price = crate::sorting::row_price_expr(q.marketplace, WISH_PREFERRED_FINISH)
```

Replace the `WISH_FINISH` constant with:

```rust
/// The wish's own finish column, for [`crate::sorting::row_price_expr`] to branch on.
///
/// **It was `coalesce(w.preferred_finish, 'nonfoil')` and that coalesce was the bug.** "No
/// preference" is not nonfoil — it is a wish for the *card*, which is exactly what a deck row
/// with a null finish is, and 12 849 of 116 843 printings have no nonfoil price at any
/// marketplace. Reading the null as nonfoil left FIC #477 (sold only in foil, `usd_foil` 31.18)
/// drawing an em dash on the wishlist beside a search wall quoting it.
///
/// The column is handed over **unwrapped** now, so `row_price_expr` can tell "the reader has not
/// said" from "the reader said nonfoil" — which are two different wishes and, on a printing sold
/// only in foil, two different answers.
pub const WISH_PREFERRED_FINISH: &str = "w.preferred_finish";
```

Then fix every other reference to `WISH_FINISH` — grep for it, and for each site decide whether it
wants the raw column or the old coalesce. A site that is genuinely asking "which finish is this
wish for, defaulting to nonfoil" (a *display* question) keeps the coalesce written out locally;
only the price wants the raw column.

- [ ] **Step 5: Run them and watch them pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml wishlist:: -- --nocapture`
Expected: PASS, including every pre-existing wishlist test. **Report the selected count.**

Then the whole crate, because `row_price_expr` moved under the deck's feet:
Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS. If a deck price test fails, `deck_card_price_expr` no longer produces byte-identical
SQL — compare the two strings and fix the wrapper, not the test.

- [ ] **Step 6: Mutate**

Change `row_price_expr`'s named arm to `printing_price_by_finish_expr(market)` — i.e. give a named
finish the fallback chain. Confirm `a_named_finish_never_falls_back_to_another_ones_price` goes
red. Restore. Report.

- [ ] **Step 7: Report**

Do not commit. Report the files changed, the selected test counts, and the mutation result.

---

### Task 3: Rust — an any-printing wish takes the cheapest printing

**Do this after Task 2, in the same agent** — it edits the same two files.

The join picks the printing a wish is *drawn as*. `ORDER BY released_at DESC` means an
any-printing wish is drawn as the newest printing and priced at it, which is neither what the
reader asked for nor stable in any way they can see.

**Files:**
- Modify: `src-tauri/src/wishlist.rs` (`list_wishes`'s `from` clause, around line 782)
- Test: `src-tauri/src/wishlist.rs`'s inline test module

**Interfaces:**
- Consumes: `row_price_expr(market, finish_col)` from Task 2.
- Produces: no new symbols. Changes the meaning of `WishRow.art_card_id`, `set_code`,
  `collector_number`, `rarity` and `unit_price` for a wish with `card_id IS NULL`.

- [ ] **Step 1: Write the failing tests**

```rust
    /// An **any-printing** wish is for the card, so it is drawn as — and priced at — the cheapest
    /// printing the marketplace quotes, not the newest one released.
    ///
    /// The printing travels with the price on purpose: `art_card_id` comes off this same join, so
    /// the picture, the rarity gem and the chin's set and number all name the printing the figure
    /// beside them is about. A tile drawn as one printing and priced at another would be the one
    /// kind of wrong a reader cannot check.
    #[test]
    fn an_any_printing_wish_takes_the_cheapest_printing() {
        let conn = crate::db::test_conn();
        // Same oracle card, three printings. The newest is the dearest, which is what makes this
        // test able to fail: under the old `released_at DESC` it is the one that was chosen.
        seed_printing(&conn, "bolt-new", "oracle-bolt", "2025-01-01", r#"{"usd": "40.00"}"#);
        seed_printing(&conn, "bolt-mid", "oracle-bolt", "2015-01-01", r#"{"usd": "2.00"}"#);
        seed_printing(&conn, "bolt-old", "oracle-bolt", "1993-01-01", r#"{"usd": "9.00"}"#);
        add_any_printing_wish(&conn, "oracle-bolt", None);

        let page = list_wishes(&conn, &query_at(Marketplace::Tcgplayer)).unwrap();

        assert_eq!(page.items[0].unit_price, Some(2.00), "the cheapest, not the newest");
        assert_eq!(
            page.items[0].art_card_id.as_deref(),
            Some("bolt-mid"),
            "and the tile is drawn as that same printing"
        );
    }

    /// An oracle card **no marketplace quotes** keeps the newest printing.
    ///
    /// A wish still needs art and still needs a set code, so ordering unpriced rows last with the
    /// old clause as the tiebreak makes this change a no-op for exactly the wishes it could
    /// otherwise have left blank.
    #[test]
    fn an_unpriced_oracle_card_keeps_the_newest_printing() {
        let conn = crate::db::test_conn();
        seed_printing(&conn, "obscure-new", "oracle-obscure", "2025-01-01", r#"{}"#);
        seed_printing(&conn, "obscure-old", "oracle-obscure", "1999-01-01", r#"{}"#);
        add_any_printing_wish(&conn, "oracle-obscure", None);

        let page = list_wishes(&conn, &query_at(Marketplace::Tcgplayer)).unwrap();

        assert_eq!(page.items[0].unit_price, None);
        assert_eq!(page.items[0].art_card_id.as_deref(), Some("obscure-new"));
    }

    /// A **pinned** wish is untouched: `coalesce` short-circuits, so the subquery never runs for
    /// one, and the printing the reader chose is the printing they keep however cheap another is.
    #[test]
    fn a_pinned_wish_keeps_its_own_printing_however_dear() {
        let conn = crate::db::test_conn();
        seed_printing(&conn, "bolt-new", "oracle-bolt", "2025-01-01", r#"{"usd": "40.00"}"#);
        seed_printing(&conn, "bolt-mid", "oracle-bolt", "2015-01-01", r#"{"usd": "2.00"}"#);
        add_wish(&conn, "bolt-new", None);

        let page = list_wishes(&conn, &query_at(Marketplace::Tcgplayer)).unwrap();

        assert_eq!(page.items[0].art_card_id.as_deref(), Some("bolt-new"));
        assert_eq!(page.items[0].unit_price, Some(40.00));
    }
```

`seed_printing` and `add_any_printing_wish` may not exist — the module already seeds multiple
printings of one oracle card for `art_card_id_is_the_printing_a_wish_is_drawn_as` (around line
1173). Reuse those helpers and keep the assertions identical.

- [ ] **Step 2: Run them and watch them fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml wishlist:: -- --nocapture`
Expected: `an_any_printing_wish_takes_the_cheapest_printing` FAILS with `Some(40.0)`.
**Report the selected count.**

- [ ] **Step 3: Implement**

In `list_wishes`, the `from` clause becomes a `format!` because it now carries a price expression:

```rust
    // What one copy of this wish costs, built once and used twice: to *choose* the printing an
    // any-printing wish is drawn as, and to price whichever printing that turns out to be. One
    // expression rather than two, so the picture and the figure under it can never come from two
    // different rules.
    let price = crate::sorting::row_price_expr(q.marketplace, WISH_PREFERRED_FINISH);
    // The card a wish is *about*: its pinned printing, or the **cheapest** printing of its oracle
    // card at the marketplace this query named. A LEFT JOIN, because a wish outlives the printing
    // it was made from.
    //
    // **`ORDER BY … ASC NULLS LAST` with the old clause as the tiebreak**, which is what makes
    // this safe for the wishes it cannot answer: an oracle card no marketplace quotes keeps the
    // newest printing it has always had, so a wish never loses its art or its set code to a hole
    // in a pricelist.
    //
    // **The inner alias is `c` and it shadows the outer one deliberately.**
    // `crate::sorting::price_expr` hard-codes `c` for the printing being priced — that is what
    // keeps the join key and the price from being spelled apart across six call sites — so the
    // candidate printing inside this subquery has to wear that name. The `w.` references stay
    // correlated to the outer wish, which is the whole reason this is a subquery rather than a
    // join.
    //
    // **`coalesce` short-circuits, so this runs only for an unpinned wish.** A page is at most
    // `MAX_LIMIT` rows and this database has 0 unpinned wishes of 88; the cost is bounded by how
    // many wishes name no printing, not by the size of the corpus.
    let from = format!(
        "wishlist_entries w LEFT JOIN cards c
             ON c.id = coalesce(w.card_id,
                 (SELECT c.id FROM cards c
                   WHERE c.oracle_id = w.oracle_id
                   ORDER BY ({price}) ASC NULLS LAST, c.released_at DESC, c.id ASC
                   LIMIT 1))"
    );
```

Then make the two existing `format!`s that interpolate `{from}` take `from = from.as_str()` (or
`&from`) rather than the old `&'static str`, and change the main statement's `price =` binding to
reuse the `price` local rather than rebuilding it.

- [ ] **Step 4: Run them and watch them pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml wishlist:: -- --nocapture`
Expected: PASS, all three new plus every pre-existing wishlist test. **Report the selected count.**

Pay attention to `art_card_id_is_the_printing_a_wish_is_drawn_as` and
`elsewhere_counts_the_other_wishes_for_the_same_oracle_card`. The first may legitimately need its
expectation updated — if its fixture's printings are unpriced, it should still answer the newest
and must not change; if they are priced, update the expectation **and say why in the test's own
doc**. The second must not change at all: `elsewhere` counts by `oracle_id` and never touches this
join.

- [ ] **Step 5: Mutate**

Drop `NULLS LAST` from the ORDER BY. Confirm `an_unpriced_oracle_card_keeps_the_newest_printing`
goes red (SQLite sorts NULLs first ascending, so the unpriced printing wins). Restore. Report.

- [ ] **Step 6: Report**

Do not commit. Report the files changed, the selected counts, the mutation result, and **any
pre-existing test whose expectation you changed, with the reason**.

---

### Task 4: `paneFinish`, and the pane opening in foil view

"Clicking on a foil should display that printing, but in the foil version." The pane already does
this — `foilView` is seeded from `deckFinish?.finish != null`, so a deck row naming a foil opens
showing the sheen. What is missing is the route for the fact from a collection tile.

**Files:**
- Modify: `src/lib/store.ts` (the pane fields around lines 311–415; the defaults around 779–810)
- Modify: `src/features/card/CardDetailPane.tsx` (`foilView`'s `useState` around line 1013;
  `foilViewFinish`'s doc around line 867)
- Test: `src/lib/store.test.ts` if one exists, otherwise `src/features/card/CardDetailPane.test.tsx`

**Interfaces:**
- Consumes: `Finish` from `@/lib/finish`; `DeckFinish` from `@/lib/ipc`.
- Produces: `paneFinish: Finish | null` on the store, and
  `openCardAsFinish: (cardId: string, finish: Finish | null) => void`.

`Finish | null` rather than `DeckFinish`, deliberately: a collection tile can name `nonfoil`, and
`null` has to keep meaning "no surface named a finish". `DeckFinish` folds those two together.

- [ ] **Step 1: Write the failing test**

```ts
  /**
   * The collection's tiles are one per printing **and finish**, so opening one has to say which.
   * The pane draws the sheen from it — there is no foil photograph to fetch, so what a foil tile
   * opens is the same picture under `FoilOverlay`.
   */
  it("carries the finish a collection tile was opened as", () => {
    useAppStore.getState().openCardAsFinish("bolt-lea", "foil");
    expect(useAppStore.getState().selectedCardId).toBe("bolt-lea");
    expect(useAppStore.getState().paneFinish).toBe("foil");
  });

  /**
   * Every other opener clears it in its own `set`, which is this store's whole design: "the pane
   * came from one surface" is a fact about one write rather than an agreement between six call
   * sites that all remembered.
   */
  it("forgets the finish when the card is opened from anywhere else", () => {
    useAppStore.getState().openCardAsFinish("bolt-lea", "foil");
    useAppStore.getState().setSelectedCardId("bolt-2ed");
    expect(useAppStore.getState().paneFinish).toBeNull();

    useAppStore.getState().openCardAsFinish("bolt-lea", "foil");
    useAppStore.getState().openCardFromDeckSearch("bolt-2ed");
    expect(useAppStore.getState().paneFinish).toBeNull();
  });

  /**
   * `viewPrinting` leaves it alone: the reader is browsing printings **inside** the pane and the
   * foil view is theirs to keep. `foilViewFinish` already answers `null` for a printing with no
   * shiny finish, so a seed carried onto a nonfoil-only printing cannot draw a chip.
   */
  it("keeps the finish while browsing printings inside the pane", () => {
    useAppStore.getState().openCardAsFinish("bolt-lea", "foil");
    useAppStore.getState().viewPrinting("bolt-2ed");
    expect(useAppStore.getState().paneFinish).toBe("foil");
  });

  /** A nonfoil tile names its finish too — that is not the same as no surface having named one. */
  it("tells a nonfoil tile apart from no tile at all", () => {
    useAppStore.getState().openCardAsFinish("bolt-lea", "nonfoil");
    expect(useAppStore.getState().paneFinish).toBe("nonfoil");
  });
```

Put these in whichever file already exercises `setSelectedCardId` / `openCardFromDeck`. Find it
with `grep -rn "openCardFromDeck" --include=*.test.ts*  src`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run <that file>`
Expected: FAIL — `openCardAsFinish is not a function`.

- [ ] **Step 3: Implement the store**

In the interface, after `paneFromDeckSearch`'s block:

```ts
  /**
   * The finish the pane was opened **as**, or `null` when no surface named one.
   *
   * The collection's wall draws one tile per printing *and finish* — a foil and a played nonfoil
   * are two objects at two prices that share only a set and a number — so a press there is about
   * one of them and the pane has to be told which. It seeds the foil view: there is no foil
   * photograph to fetch, and what the view turns on is `FoilOverlay`, this app's own sheen.
   *
   * **`Finish | null`, not `DeckFinish`.** A tile can name `nonfoil`, and `null` has to go on
   * meaning "no surface named a finish" — `DeckFinish` folds those two together, which is right
   * for a deck row (where null means the reader has not said) and wrong here.
   */
  paneFinish: Finish | null;
  /**
   * Open a card **as one of its finishes** — the collection wall's opener, and the only write
   * that sets {@link paneFinish}.
   *
   * One action rather than a setter beside `setSelectedCardId`, which is {@link openCardFromDeck}'s
   * design read a third time: every other opener clears this in the same `set`, so "the finish
   * came from a tile that names one" is structural rather than a rule six call sites remember.
   */
  openCardAsFinish: (cardId: string, finish: Finish | null) => void;
```

In the store body:

```ts
  paneFinish: null,
  openCardAsFinish: (selectedCardId, paneFinish) =>
    set({ selectedCardId, paneFinish, paneDeckContext: null, paneFromDeckSearch: false }),
```

and add `paneFinish: null` to the `set({…})` of **`setSelectedCardId`**, **`openCardFromDeck`** and
**`openCardFromDeckSearch`**. Leave `viewPrinting` alone and say so in its existing doc, which
already explains why it touches nothing. Also add `paneFinish: null` wherever the store's reset
object at line ~675 lists `selectedCardId: null`.

Import `Finish` from `@/lib/finish`.

- [ ] **Step 4: Seed the pane**

In `CardDetailPane.tsx`, read `paneFinish` from the store beside the other pane fields and change:

```tsx
  const [foilView, setFoilView] = useState(deckFinish?.finish != null);
```

to:

```tsx
  // Opened from a deck row that plays a foil, or from a collection tile that *is* one: both are
  // the reader looking at their own copy, so the pane opens showing it. `nonfoil` seeds nothing,
  // which is right — it is the finish a card is assumed to be.
  const [foilView, setFoilView] = useState(
    deckFinish?.finish != null || paneFinish === "foil" || paneFinish === "etched",
  );
```

- [ ] **Step 5: Rewrite the false paragraph**

`foilViewFinish`'s doc says the view "says nothing whatever about which finish they own: that
question is answered by a collection entry's own `finish` and by nothing on this screen." **That is
now false**, and a stale doc here is worse than none — it is the paragraph the next reader will
trust. Replace that sentence with:

```
 * It says nothing about which finish the reader owns **unless a surface that knows named one**:
 * a deck row plays a specific object and a collection tile *is* one, and both seed this view
 * through the store's `paneFinish`. Opened from a search wall, from Tags or from a printings row
 * there is no such fact, and it is what it has always been — a way to see what the shiny one
 * looks like.
```

- [ ] **Step 6: Run it and watch it pass**

Run: `npx vitest run <the store test file> src/features/card/CardDetailPane.test.tsx`
Expected: PASS.

- [ ] **Step 7: Mutate**

Remove `paneFinish: null` from `setSelectedCardId`'s `set`. Confirm the "forgets the finish" test
goes red. Restore. Report.

- [ ] **Step 8: Report**

Do not commit. Report the files changed and the mutation result.

---

### Task 5: The `CardChin` component

**Needs Task 1.**

`CardStack`'s foot, lifted out with named slots and nothing else changed about it. Read
`CardStack.tsx` around lines 1130–1200 for the original and its comments — the reasoning there is
load-bearing and travels with the markup.

**Files:**
- Create: `src/components/CardChin.tsx`
- Create: `src/components/CardChin.test.tsx`
- Create: `src/components/CardChin.stories.tsx`

**Interfaces:**
- Consumes: `chinHeight`, `CHIN_RISE` from `@/lib/cardZoom`; `RarityGem`, `FinishMark`,
  `useTooltip`, `cn`; `Finish` from `@/lib/finish`; `Treatment` from `@/lib/treatment`.
- Produces:

```ts
export function CardChin(props: {
  rarity: string | null;
  zoom: number;
  printing?: ReactNode;          // defaults to `${setCode.toUpperCase()} · ${collectorNumber}`
  setCode?: string;
  collectorNumber?: string;
  printingTitle?: string | null;
  finish?: Finish | null;
  treatments?: readonly Treatment[];
  money?: ReactNode;
  extra?: ReactNode;
  seam?: "card" | "art";
  tone?: "default" | "destructive";
}): ReactElement;
```

**Why `seam` exists.** The chin's edges have to be the *card's* edges, and the two hosts own their
outline differently. `CardStack`'s card is `rounded-lg border` with the face inset at
`rounded-[7px]`, so the chin draws `border-x` only and rides `-mx-px` onto the card's own border —
its bottom edge *is* the card's. `CardGrid` and `GridView` draw `CardArt`, which has **no border**
at all, so a chin there must supply all three edges itself. Getting this wrong is not cosmetic: a
`border-b` under the stack's card sits 1px above the card's own, which is a 2px foot and a 1px
everything-else — the exact defect `CardStack`'s comment records.

- [ ] **Step 1: Write the failing tests**

`src/components/CardChin.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CHIN_RISE, chinHeight } from "@/lib/cardZoom";
import { CardChin } from "./CardChin";

describe("CardChin", () => {
  /** The default printing line is the set and the number, which is what fits on a card's foot. */
  it("writes the set and the number when given no printing of its own", () => {
    render(<CardChin rarity="rare" zoom={1} setCode="c21" collectorNumber="179" />);
    expect(screen.getByText(/C21 · 179/)).toBeInTheDocument();
  });

  /**
   * The caller's words win, because a wish for *any* printing is drawn as one and must not be
   * captioned as one — a caption reading `DSK · 123` under that art would say the reader had
   * asked for that piece of cardboard.
   */
  it("takes the caller's printing line over the default", () => {
    render(
      <CardChin rarity="rare" zoom={1} setCode="dsk" collectorNumber="123" printing="Any printing" />,
    );
    expect(screen.getByText("Any printing")).toBeInTheDocument();
    expect(screen.queryByText(/DSK · 123/)).not.toBeInTheDocument();
  });

  /** The money slot, and an em dash where a caller has nothing — never `$0.00`. */
  it("draws the money it is given", () => {
    render(<CardChin rarity="rare" zoom={1} setCode="c21" collectorNumber="179" money="$12.32" />);
    expect(screen.getByText("$12.32")).toBeInTheDocument();
  });

  /**
   * Nonfoil draws no glyph — it is the finish a price is assumed to be. The mark is `FinishMark`'s
   * own rule; the chin only has to not force one.
   */
  it("marks a foil and leaves a nonfoil unmarked", () => {
    const { rerender } = render(
      <CardChin rarity="rare" zoom={1} setCode="c21" collectorNumber="179" finish="foil" />,
    );
    expect(screen.getByLabelText("Foil")).toBeInTheDocument();
    rerender(<CardChin rarity="rare" zoom={1} setCode="c21" collectorNumber="179" finish="nonfoil" />);
    expect(screen.queryByLabelText("Foil")).not.toBeInTheDocument();
  });

  /**
   * The height is the card's, at this zoom, and the rise is what joins the two boxes into one
   * object. jsdom cannot see the seam; it can see the two numbers that make it.
   */
  it("is as tall as the card's chin at this zoom, and rides up by the rise", () => {
    const { container } = render(
      <CardChin rarity="rare" zoom={0.5} setCode="c21" collectorNumber="179" />,
    );
    const chin = container.firstElementChild as HTMLElement;
    expect(chin.style.height).toBe(`${chinHeight(0.5)}px`);
    expect(chin.style.marginTop).toBe(`-${CHIN_RISE}px`);
  });

  /**
   * **The chin's edges are the card's edges**, and the two hosts own their outline differently.
   * Under a bordered card the chin draws `border-x` only — the card's own border is the bottom
   * edge, and a `border-b` here would sit 1px above it, which is a 2px foot on a card whose
   * everything-else is 1px. Under bare art it supplies all three.
   *
   * `classList.contains`, not `className.includes`: a substring match passes on `border-x` when
   * the class is `border-x-2`, and this assertion is the only thing standing between the two seams.
   */
  it("lets the card own the bottom edge and the art not", () => {
    const { container: card } = render(
      <CardChin rarity="rare" zoom={1} setCode="c21" collectorNumber="179" seam="card" />,
    );
    const { container: art } = render(
      <CardChin rarity="rare" zoom={1} setCode="c21" collectorNumber="179" seam="art" />,
    );
    expect((card.firstElementChild as HTMLElement).classList.contains("border-b")).toBe(false);
    expect((art.firstElementChild as HTMLElement).classList.contains("border-b")).toBe(true);
  });

  /**
   * A card that breaks a rule is outlined in destructive, and the chin's border paints **over**
   * the card's along every pixel of its height — it is `relative` and later in the document. So
   * the two are one line drawn by two elements and they have to agree, or the card stops reading
   * as a single object exactly where the foot joins the face.
   */
  it("carries the card's own edge colour", () => {
    const { container } = render(
      <CardChin rarity="rare" zoom={1} setCode="c21" collectorNumber="179" tone="destructive" />,
    );
    const chin = container.firstElementChild as HTMLElement;
    expect(chin.classList.contains("border-destructive")).toBe(true);
    expect(chin.classList.contains("border-border")).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/components/CardChin.test.tsx`
Expected: FAIL — cannot resolve `./CardChin`.

- [ ] **Step 3: Implement**

`src/components/CardChin.tsx`:

```tsx
import type { ReactElement, ReactNode } from "react";
import { FinishMark } from "@/components/FinishMark";
import { RarityGem } from "@/components/RarityGem";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { CHIN_RISE, chinHeight } from "@/lib/cardZoom";
import type { Finish } from "@/lib/finish";
import type { Treatment } from "@/lib/treatment";
import { cn } from "@/lib/utils";

/**
 * **The card's foot, and the one definition of it.**
 *
 * Facts about the *printing* rather than about the list it is in, in the data face and one step
 * dimmer: rarity, which printing this is, its finish, and what one copy costs.
 *
 * ## Why this is a component
 *
 * Three surfaces drew a foot and each held its own numbers — 28px of 10px type on the deck's
 * stacks, 25px of 12px on the five walls `CardGrid` draws, 20px of 9px on the deck's grid — and
 * only the first had the felt, the edges and the rise that make a foot read as part of the card
 * rather than as a caption under it. Three copies is how a shared look stops being shared. This is
 * the stack's, which is the one that was right, and `chinHeight` in `lib/cardZoom.ts` is its
 * height.
 *
 * ## It is a sibling of the card's button, never a child of it
 *
 * Everything here is a *fact* rather than a mark, so unlike the overlays on the art it is
 * genuinely announced instead of being swallowed by the button's `aria-label`. The price and the
 * printing had no reader at all while they were inside it.
 *
 * ## The rise, and why the edges are a prop
 *
 * `marginTop: -CHIN_RISE` rides the chin up so the face's clipped corners cover its square ones:
 * butted flush, two hairlines of background show through the gap.
 *
 * {@link seam} is the other half of that join, and it is not decoration. The chin's edges have to
 * be the *card's* edges, and the two hosts own their outline differently — see the prop.
 */
export function CardChin({
  rarity,
  zoom,
  printing,
  setCode,
  collectorNumber,
  printingTitle,
  finish = null,
  treatments = [],
  money,
  extra,
  seam = "card",
  tone = "default",
}: {
  /** The gem, always drawn. `null` is a printing `cards` has forgotten, which the gem says. */
  rarity: string | null;
  /** The reader's zoom for this surface — the chin's height, and nothing else. Everything *in* it
   *  sizes itself off `--mark-scale`, which the card's own root publishes. */
  zoom: number;
  /**
   * What this line says about the printing, replacing the `SET · number` it says by default.
   *
   * The wishlist's "Any printing" and the search's "12 printings" are the live cases: a wish for
   * any printing is *drawn* as one particular one, and a caption naming that cardboard would say
   * the reader had asked for it.
   */
  printing?: ReactNode;
  /** The default line's two halves. Ignored where {@link printing} is given. */
  setCode?: string;
  collectorNumber?: string;
  /**
   * The tooltip on the printing line — the set's *name*, because `PF26` is not a word anybody
   * knows. `null` where the caller has none, which is an orphan: then the code stands on its own
   * rather than being annotated with a guess.
   *
   * No `whenClipped`: the line shows the set **code** and the tip says the set **name**, which is
   * a different string, so gating the panel on the code's own clip would gate it on something the
   * tip is not about.
   */
  printingTitle?: string | null;
  /**
   * The finish this copy **is**. `null` draws nothing, and so does `nonfoil` — that is
   * `FinishMark`'s own rule, and it is right: nonfoil is the finish a price is assumed to be, and
   * 61 % of the corpus has a foil version, so a mark on every plain card would be chrome.
   */
  finish?: Finish | null;
  /** What this copy is *called*, from `finishTreatments`. A named treatment replaces the finish's
   *  glyph and its word — a Surge Foil is not "a foil" — and outlives `nonfoil`, because
   *  serialized cardboard is serialized either way. */
  treatments?: readonly Treatment[];
  /** What one copy of this exact printing and finish costs. A node rather than a number so a
   *  caller can hang a tooltip on it; `formatPrice` is what fills it, and it draws an em dash
   *  rather than a `$0.00` nobody quoted. */
  money?: ReactNode;
  /** After the money. Only the deck passes one — the `owned/wanted` shortage. */
  extra?: ReactNode;
  /**
   * Whose outline the chin joins, and it is not decoration.
   *
   * * **`"card"`** — under a bordered card (the deck's stacks). `border-x` only, ridden `-mx-px`
   *   onto the card's own border so the two are one line rather than two. **No bottom edge**: the
   *   card's border is the bottom edge, and a `border-b` here sits 1px *above* it — a red card
   *   with a 2px foot and a 1px everything-else.
   * * **`"art"`** — under a bare `CardArt` frame, which has no border at all (the five walls
   *   `CardGrid` draws, and the deck's grid). The chin supplies all three edges itself and rounds
   *   to the art's own `lg` corner.
   */
  seam?: "card" | "art";
  /**
   * The card's own edge colour, which the chin **must** match.
   *
   * This bar is `relative` and later in the document than the face, so its border paints *over*
   * the card's along every pixel of its height. A rule break outlines the card in destructive and
   * a `border-border` chin then puts 28px of the wrong colour back through the left and right
   * edges of it — which is the one thing the outline exists to prevent.
   */
  tone?: "default" | "destructive";
}): ReactElement {
  const tip = useTooltip();
  const marked = finish !== null || treatments.length > 0;
  return (
    <span
      style={{ height: chinHeight(zoom), marginTop: -CHIN_RISE }}
      className={cn(
        "relative box-border flex items-center border-x",
        // The gutter, the right padding and the type are all sizes on a card at 100% zoom, and
        // move with the chin's own height — the bar and its contents are one proportion.
        "gap-[calc(0.375rem*var(--mark-scale,1))] pr-[calc(0.375rem*var(--mark-scale,1))]",
        "bg-surface font-mono text-[calc(0.625rem*var(--mark-scale,1))] text-dim",
        seam === "card" ? "-mx-px rounded-b-[7px]" : "rounded-b-lg border-b",
        tone === "destructive" ? "border-destructive" : "border-border",
      )}
    >
      <RarityGem rarity={rarity} className="ml-[calc(0.375rem*var(--mark-scale,1))]" />
      <span {...tip(printingTitle ?? null)} className="min-w-0 flex-1 truncate">
        {printing ?? `${(setCode ?? "").toUpperCase()} · ${collectorNumber ?? ""}`}
      </span>
      {marked && <FinishMark finish={finish ?? "nonfoil"} treatments={treatments} />}
      {money !== undefined && <span className="shrink-0 tabular-nums text-text">{money}</span>}
      {extra}
    </span>
  );
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/components/CardChin.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the stories**

**Call the `get-storybook-story-instructions` MCP tool first** and follow what it returns —
it is the source of truth for imports, story patterns and testing conventions in this repo.
Then write `src/components/CardChin.stories.tsx` covering: both seams; `tone="destructive"`; a
foil and a nonfoil; a named treatment; an unpriced chin (em dash); a caller-supplied printing
line; and the same chin at 0.5×, 1× and 2× so the type and the box can be seen scaling together.

Do **not** run Storybook — the port is a shared lock across every worktree. Story *plays* are not
runnable during a fan-out either; the controller runs them at Task 14.

- [ ] **Step 6: Mutate**

Swap the two arms of the `seam` ternary. Confirm "lets the card own the bottom edge and the art
not" goes red. Restore. Then change `tone`'s ternary to always return `border-border` and confirm
"carries the card's own edge colour" goes red. Restore. Report both.

- [ ] **Step 7: Report**

Do not commit. Report the files created and both mutation results.

---

### Task 6: `CardStack` renders the chin

**Needs Task 5.** The stack's foot *is* the chin, so this is a swap with no visual change — which
is the point: if anything moves on screen, the component is wrong, not the stack.

**Files:**
- Modify: `src/features/decks/CardStack.tsx` (constants around lines 128–165; the foot around
  lines 1130–1200)
- Test: `src/features/decks/CardStack.test.tsx`

**Interfaces:**
- Consumes: `CardChin` from `@/components/CardChin`; `CHIN_HEIGHT`, `CHIN_RISE`, `chinHeight` from
  `@/lib/cardZoom`.
- Produces: `STACK_DATA_HEIGHT`, `STACK_DATA_RISE`, `stackDataHeight` keep their names and their
  values, re-exported from the promoted constants.

- [ ] **Step 1: Re-point the constants, keeping the names**

`CardStack.test.tsx` asserts `STACK_DATA_RISE === 4` and
`STACK_CARD_HEIGHT === STACK_IMAGE_HEIGHT + 2 + STACK_DATA_HEIGHT - STACK_DATA_RISE === 319`.
Those assertions are about the card's geometry and must go on passing untouched. So:

```ts
/**
 * The chin's height at 100% zoom — **`lib/cardZoom.ts`'s `CHIN_HEIGHT`, kept under this name**
 * because every sum below and every geometry assertion in this file's tests is written in terms
 * of it.
 *
 * It moved out because three surfaces drew a foot and each held its own number. It is still 28,
 * it is still what `STACK_CARD_HEIGHT` is built from, and there is now one place to change it.
 */
export const STACK_DATA_HEIGHT = CHIN_HEIGHT;
/** How far the chin rides up over the face's bottom corners — `lib/cardZoom.ts`'s `CHIN_RISE`.
 *  Does not zoom; see there. */
export const STACK_DATA_RISE = CHIN_RISE;
```

and replace `stackDataHeight`'s body with `return chinHeight(zoom);`, keeping its doc.

- [ ] **Step 2: Run the geometry tests and watch them still pass**

Run: `npx vitest run src/features/decks/CardStack.test.tsx`
Expected: PASS, unchanged. If `STACK_CARD_HEIGHT === 319` fails, the promoted constant is not 28.

- [ ] **Step 3: Swap the markup**

Replace the whole foot `<span>` (the one carrying `style={{ height: stackDataHeight(zoom),
marginTop: -STACK_DATA_RISE }}`) with:

```tsx
      <CardChin
        zoom={zoom}
        rarity={card.rarity}
        setCode={card.setCode}
        collectorNumber={card.collectorNumber}
        // The code is what fits; the set's name is one hover away. `setName` comes from `cards`
        // and is `null` for an orphan — then the code stands on its own rather than being
        // annotated with a guess.
        printingTitle={
          card.setName === null ? null : `${card.setName} · #${card.collectorNumber}`
        }
        finish={finish}
        treatments={treatments}
        money={formatPrice(card.unitPrice, currency)}
        // The card's own edge, and the two must move together — see `CardChin`'s `tone`.
        tone={ruleBreakText !== null ? "destructive" : "default"}
        extra={
          short ? (
            <span
              aria-hidden="true"
              {...tip(`You own ${card.ownedQuantity} of the ${card.quantity} this deck wants`, {
                describes: false,
              })}
              className="shrink-0 tabular-nums text-destructive"
            >
              {card.ownedQuantity}/{card.quantity}
            </span>
          ) : undefined
        }
      />
```

Keep the long comment block above the foot — it explains why this is a sibling of the button and
why the negative margins exist, and both are still true. Add one line saying the markup now lives
in `components/CardChin.tsx`.

`seam` is left at its `"card"` default, which is this surface's: the card is `rounded-lg border`
with the face inset at `rounded-[7px]`.

- [ ] **Step 4: Run the whole deck view suite**

Run: `npx vitest run src/features/decks/CardStack.test.tsx src/features/decks/views/views.test.tsx`
Expected: PASS. Any failure is a real behaviour change — the chin renders the same five things in
the same order, so a red test here means a prop was dropped.

- [ ] **Step 5: Mutate**

Drop the `tone` prop. Confirm a rule-break test goes red — if none does, **say so**: it means the
stack has no test that a rule-breaking card's foot is outlined, and that gap should be reported
rather than filled silently in this task.

- [ ] **Step 6: Report**

Do not commit. Report the files changed, the mutation result, and any coverage gap it exposed.

---

### Task 7: `GridView` renders the chin

**Needs Task 5.** This surface's foot is the one that drifted furthest — a 20px strip of 9px type
with no felt and no edges, holding a gem and a price with the set and number missing entirely.

**Files:**
- Modify: `src/features/decks/views/GridView.tsx` (constants around lines 65–67; the foot around
  lines 512–530; the controls' offset around line 535)
- Test: `src/features/decks/views/views.test.tsx`

**Interfaces:**
- Consumes: `CardChin`; `chinHeight` from `@/lib/cardZoom`.
- Produces: nothing new. `CAPTION_HEIGHT` and `CAPTION_TEXT` are **deleted**.

- [ ] **Step 1: Write the failing test**

In `views.test.tsx`, in the `GridView` describe:

```tsx
  /**
   * The grid's foot said a rarity and a price and left out which printing the card is — the one
   * fact a reader comparing two copies of the same card needs. It is the same chin the stacks
   * draw now, so a deck read in one view and then the other says the same things.
   */
  it("names the printing in the tile's chin", () => {
    renderGridView({ cards: [deckCard({ setCode: "c21", collectorNumber: "179" })] });
    expect(screen.getByText(/C21 · 179/)).toBeInTheDocument();
  });
```

Use whatever render helper and card factory `views.test.tsx` already has — read the file, do not
invent `renderGridView`/`deckCard`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/features/decks/views/views.test.tsx -t "names the printing"`
Expected: FAIL — the text is not in the document.

- [ ] **Step 3: Implement**

Delete `CAPTION_HEIGHT` and `CAPTION_TEXT` and their paragraph in the geometry doc; replace the
`captionHeight`/`captionText` locals with:

```tsx
  // The card's foot, the same object the stacks draw — see `components/CardChin.tsx`. The
  // controls bar below is positioned off this number, which is why it is still a local.
  const footHeight = chinHeight(zoom);
```

Replace the foot `<span>` with:

```tsx
        <CardChin
          zoom={zoom}
          rarity={card.rarity}
          setCode={card.setCode}
          collectorNumber={card.collectorNumber}
          finish={playedFinish(card.finish, card.finishes)}
          treatments={finishTreatments(card.promoTypes, playedFinish(card.finish, card.finishes))}
          money={formatPrice(card.unitPrice, currency)}
          // **`"art"`, not the default.** This tile's face is `CardArt`, which has no border of
          // its own — the rule break is a `ring-2` on the face rather than an edge — so the chin
          // supplies all three of its own edges. Under the stack's bordered card it must not, or
          // the foot is 2px and everything else is 1px.
          seam="art"
          tone={ruleBreakText !== null ? "destructive" : "default"}
        />
```

Update the geometry doc at the top of the file: it currently says `CAPTION_HEIGHT` is the foot
(`h-5`) and `CAPTION_TEXT` the type (`text-[0.5625rem]`). Replace with a sentence pointing at
`chinHeight` and `CardChin`, and **delete the two class names from the prose** — the repo's
transition sweep reads doc comments as markup and a class nothing uses now goes red.

Change the controls wrapper's `style={{ bottom: captionHeight }}` to `style={{ bottom: footHeight }}`.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/features/decks/views/views.test.tsx`
Expected: PASS, the whole file.

- [ ] **Step 5: Mutate**

Change `seam="art"` to `seam="card"`. Nothing will go red — jsdom cannot see a 1px seam. **Report
that**: it is the reason Task 14's live pass exists, and the honest thing to say about this
change's test coverage.

- [ ] **Step 6: Report**

Do not commit. Report the files changed and the mutation result, including that the seam is not
test-covered.

---

### Task 8: `CardGrid` — the chin, the money slot, the tile key, the action strip

**Needs Task 5.** The biggest single task, and the one every wave-4 task consumes.

**Files:**
- Modify: `src/features/search/CardGrid.tsx`
- Test: `src/features/search/CardGrid.test.tsx`

**Interfaces:**
- Consumes: `CardChin`; `chinHeight` from `@/lib/cardZoom`.
- Produces, on `GridCard`:

```ts
  /**
   * This tile's identity, where it differs from the card's. Defaults to {@link id}.
   */
  key?: string;
```

and on `CardGrid`'s props:

```ts
  /** What this wall's chin says one copy costs. */
  money?: (card: T) => ReactNode;
```

and a **widened** `onSelect`, which is backwards compatible — six of the seven walls ignore the
second argument and change not at all:

```ts
  /**
   * Open the card a tile is about.
   *
   * **The row is passed beside the id**, because a tile is not always a printing: the collection
   * draws one per printing *and finish*, and the pane has to be told which of the two the reader
   * pressed. The id stays first because that is what every other wall opens with.
   */
  onSelect: (id: string, card: T) => void;
```

- [ ] **Step 1: Write the failing tests**

```tsx
  /**
   * The chin's money slot, which is what makes "a price on every card where one exists" true on
   * a wall rather than only in its table.
   */
  it("draws the money the wall gives it", () => {
    renderGrid({ rows: [gridCard({ id: "a" })], money: () => "$12.32" });
    expect(screen.getByText("$12.32")).toBeInTheDocument();
  });

  /**
   * **Two tiles can be one card**, which is what the collection's foil/nonfoil split needs: the
   * ring, the arrow walk and the picked set all key on the *tile*, while the press still opens
   * the *printing*. Without this, clicking either tile rings both.
   */
  it("rings the tile that was pressed, not every tile of that printing", () => {
    renderGrid({
      rows: [
        gridCard({ id: "bolt", key: "bolt:nonfoil" }),
        gridCard({ id: "bolt", key: "bolt:foil" }),
      ],
      selectedId: "bolt:foil",
    });
    const rung = document.querySelectorAll("[data-grid-index]");
    expect(rung[0].className).not.toContain(SELECTED_MARKER);
    expect(rung[1].className).toContain(SELECTED_MARKER);
  });

  /** A wall whose cards carry no `key` is untouched — six of the seven walls pass none. */
  it("falls back to the card id when a wall gives no key", () => {
    renderGrid({ rows: [gridCard({ id: "bolt" })], selectedId: "bolt" });
    expect(document.querySelector("[data-grid-index]")!.className).toContain(SELECTED_MARKER);
  });

  /**
   * The action leaves the caption for a strip over the art — there is no room for a 20px button
   * beside a price at 170px, and over the art is where the deckbuilder already puts its stepper.
   * **It stays in the tab order at all times**: "visible on hover" is not a state a keyboard has.
   */
  it("keeps the tile's action reachable without a pointer", () => {
    renderGrid({
      rows: [gridCard({ id: "a" })],
      action: () => <button type="button">Add</button>,
    });
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).not.toHaveAttribute("tabindex", "-1");
  });
```

Read the file's existing helpers for `renderGrid`/`gridCard` and for how it already asserts the
selected ring — reuse that spelling for `SELECTED_MARKER` rather than inventing one. If the file
has no ring assertion yet, assert on the class `CardArt` is given for `selected` and say so.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/features/search/CardGrid.test.tsx`
Expected: the four new tests FAIL.

- [ ] **Step 3: The tile key**

Add `key?: string` to `GridCard` with the doc above, then add at module scope:

```ts
/**
 * A tile's identity, which is **not always its card's**.
 *
 * The collection draws one tile per printing *and finish* — a foil and a played nonfoil are two
 * objects at two prices sharing only a set and a number — so two tiles there carry one `id`. The
 * ring, the arrow walk's caret and the picked set are about the *tile*; `onSelect` and the art are
 * about the *printing*. Six of the seven walls pass no `key` at all and are untouched.
 */
const tileKey = <T extends GridCard>(card: T): string => card.key ?? card.id;
```

Replace `card.id` with `tileKey(card)` at exactly these sites, and nowhere else:

- `selectionOrder` (~line 703): `rows.map((card) => tileKey(card))`
- `select`: change its signature to `(card: T, event?: …)`, read `const key = tileKey(card)` and
  `const cardId = card.id`, then `picked.pick(key, event)`, `keepCaretForCard(key)`, and
  `onSelect(cardId, card)` — the widened signature above. The `if (!cardId) return` guard stays on
  the **card** id: a tile with no printing opens nothing.
- `dragRest`: `held.dragsAll(tileKey(card))`, and the `wanted` set / `row.id === card.id` filter
  become `tileKey(row) === tileKey(card)` and `wanted.has(tileKey(row))`.
- `pickedRows`, `tileMenu`, `tileMenuKey`: `picked.selected(tileKey(card))`
- the `<Tile>` call: `selected={tileKey(card) === selectedId || picked.selected(tileKey(card))}`

Then update `Tile`'s `open` to call the caller's `onSelect` with the whole card — change `Tile`'s
`onSelect` prop type to `(card: T, event: ReactMouseEvent) => void` and its `open` to
`card.id ? (event) => onSelect(card, event) : undefined`.

**Confirm `keepCaretForCard` treats its argument as opaque** — read `src/lib/caretWalk.ts`. If it
looks the string up in the DOM against something other than the tile's own attribute, stop and
report rather than working around it.

- [ ] **Step 4: The chin**

Add the `money` prop to `CardGrid`'s props and thread it to `Tile`. In `Tile`, replace the whole
caption `<span>` — the one carrying `relative flex items-center font-mono text-dim` — with:

```tsx
      <CardChin
        zoom={zoom}
        rarity={card.rarity}
        setCode={card.setCode}
        collectorNumber={card.collectorNumber}
        printing={
          caption ? (
            caption(card)
          ) : undefined
        }
        finish={tileFinish}
        treatments={tileTreatments}
        money={money?.(card)}
        // **`"art"`.** `CardArt` has no border of its own, so the chin supplies all three of its
        // edges. See the prop.
        seam="art"
        extra={
          <>
            {/* The finish in words, because the art's chip is `aria-hidden` — it sits inside the
                tile's button, where any text of its own would join the button's accessible name
                and make a wall of foils forty buttons called "… Foil". */}
            {finishWord && <span className="sr-only">, {finishWord}</span>}
            {crowned && <span className="sr-only">, {GAME_CHANGER_LABEL}</span>}
          </>
        }
      />
```

The two `sr-only` spans move into `extra` because they must stay outside the art button and
inside the chin's own text, which is where they are today.

Then the height budget: delete `CAPTION_CONTROL`, `CAPTION_GAP` and `CAPTION_HEIGHT` and their
docs, and replace `const captionHeight = scaled(CAPTION_HEIGHT, cardZoom)` with:

```tsx
  // The chin is **attached** to the card rather than spaced under it, so there is no gap in this
  // budget any more — the tile is the art plus the chin less the rise, which is exactly what
  // `chinHeight` and `CHIN_RISE` say. It used to be a budget for the quick-add button in the
  // caption; that control is over the art now and costs the wall no height at all.
  const captionHeight = chinHeight(cardZoom) - CHIN_RISE;
```

`tileHeight` already reads `captionHeight`, so the virtualiser follows with no second edit. Also
remove the tile root's `gap-[calc(0.25rem*var(--mark-scale,1))]` — the chin's rise *is* the join
now, and a gap there would separate what the rise exists to fuse.

- [ ] **Step 5: The action strip**

Move `{action?.(card)}` out of the chin and into the art's `relative` box, as the last child:

```tsx
        {action && (
          // **Over the art, not in the chin** — there is no room for a 20px control beside a
          // price at 170px, and this is where the deck editor already puts a card's stepper. It
          // is absolutely positioned, so it costs the wall no height and `tileHeight` is
          // unchanged by its existence.
          //
          // `relative` here rather than on the chin, because it is what the 256px popup hangs
          // off: a popup on a 170px tile has to open from the tile's *left* edge, or the first
          // column's opens left of the scroller — and left overflow, unlike right, cannot be
          // scrolled back into view. Both callers pass their control `static` for exactly that,
          // and this box is the same width the caption was.
          //
          // Revealed on hover **and on focus-within**, and never removed from the tab order:
          // "visible on hover" is not a state a keyboard has.
          <span
            className={cn(
              "absolute inset-x-0 bottom-0 flex justify-end",
              "px-[calc(0.25rem*var(--mark-scale,1))] py-[calc(0.25rem*var(--mark-scale,1))]",
              REVEAL_ON_HOVER,
            )}
          >
            {action(card)}
          </span>
        )}
```

Import `REVEAL_ON_HOVER` from `@/features/collection/AddToCollection`. Update `CARET_SELECTOR`'s
doc if it names the caption as where the caller's control sits — it now sits over the art, and
that doc's `?? tile` fallback reasoning is unaffected but its example is stale.

- [ ] **Step 6: Run them and watch them pass**

Run: `npx vitest run src/features/search/CardGrid.test.tsx`
Expected: PASS.

Then every wall that draws one, because this component is seven call sites:
Run: `npx vitest run src/features/search src/features/collection src/features/wishlist src/features/tags src/features/card`
Expected: PASS. A caption-text assertion that now fails because the strings moved is a **real**
break to fix here, not in the consuming task.

- [ ] **Step 7: Mutate**

Change `tileKey` to `card.id`. Confirm "rings the tile that was pressed" goes red. Restore. Then
delete the `money` prop from the `CardChin` call and confirm "draws the money" goes red. Restore.
Report both.

- [ ] **Step 8: Report**

Do not commit. Report the files changed, both mutation results, and **the exact new prop
signatures** — the four wave-4 tasks are written against them.

---

### Task 9: The catalogue walls quote a price

**Needs Task 8.** Search, Tags, the printings modal and the deck editor's docked Search tab. All
four keep one tile per printing; only the money slot is new.

**Files:**
- Modify: `src/features/search/SearchPage.tsx` (the `CardGrid` at ~line 530)
- Modify: `src/features/tags/TagResults.tsx` (the `CardGrid` at ~line 223)
- Modify: `src/features/card/AllPrintingsDialog.tsx` (the `CardGrid` at ~line 932)
- Modify: `src/features/decks/DeckSearchPanel.tsx` (the `CardGrid` at ~line 1309)
- Test: each file's neighbouring `.test.tsx`

**Interfaces:**
- Consumes: `CardGrid`'s `money?: (card: T) => ReactNode` from Task 8.
- Consumes: `priceRange(low, high, currency)` from `@/lib/priceRange`;
  `cheapestPrice(prices)` from `@/features/card/printings`; `formatPrice` from `@/lib/prices`.

- [ ] **Step 1: Write the failing tests**

One per file. For `SearchPage.test.tsx`:

```tsx
  /**
   * A collapsed row stands for every printing that got past the filters, so its chin quotes the
   * **spread** — the same figure the table's Price column shows, from the same helper, so a wall
   * and its table cannot disagree. Equal ends collapse to one price: 17 588 of the corpus's
   * 37 553 cards have exactly one printing, and `$2.15–$2.15` is noise on every one of them.
   */
  it("quotes the spread across the printings a tile stands for", () => {
    renderSearch({ rows: [cardSummary({ priceLow: 0.45, priceHigh: 88 })], view: "grid" });
    expect(screen.getByText("$0.45–$88.00")).toBeInTheDocument();
  });
```

For `AllPrintingsDialog.test.tsx`:

```tsx
  /**
   * A printings row is one piece of cardboard sold in one to three finishes, so its chin quotes
   * the cheapest of them — `cheapestPrice`, which is what this dialog's own `price` group-by
   * already ranks on. Quoting the nonfoil price instead would leave 12 849 foil-only and 892
   * etched-only printings reading as unpriced on the one screen built for comparing prices.
   */
  it("quotes the cheapest finish a printing is sold in", () => {
    renderDialog({ printings: [printing({ finishPrices: { nonfoil: null, foil: 31.18, etched: null } })] });
    expect(screen.getByText("$31.18")).toBeInTheDocument();
  });
```

Write the Tags and DeckSearchPanel equivalents from their own rows. Use each file's existing
render helper and row factory — read them first.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/features/search/SearchPage.test.tsx src/features/tags src/features/card/AllPrintingsDialog.test.tsx src/features/decks/DeckSearchPanel.test.tsx`
Expected: the four new tests FAIL.

- [ ] **Step 3: Implement**

`SearchPage.tsx`, `TagResults.tsx` and `DeckSearchPanel.tsx` — each already has `currency` in
scope from its `marketplace`; if not, take it the way its table does:

```tsx
            // Spec §5: a price is never shown without saying how old it is — the sentence is
            // already under this wall, said once, rather than on forty tooltips.
            //
            // The **spread**, because a collapsed row stands for every printing that matched:
            // `priceRange` is the same helper the table's Price column uses, so the two drawings
            // of one search cannot quote different money. Equal ends collapse to one figure.
            money={(card) => priceRange(card.priceLow, card.priceHigh, currency)}
```

`AllPrintingsDialog.tsx`:

```tsx
            // The cheapest finish this printing is sold in — the figure this dialog's own `price`
            // group-by already ranks on, so the order the reader picked and the number under each
            // tile come from one definition. `formatPrice` draws an em dash for a printing no
            // marketplace quotes; it never invents `$0.00`.
            money={(row) => formatPrice(cheapestPrice(row.finishPrices), currency)}
```

- [ ] **Step 4: Run them and watch them pass**

Run: the same four files.
Expected: PASS.

- [ ] **Step 5: Mutate**

In `SearchPage.tsx` swap `priceRange(card.priceLow, card.priceHigh, …)` for
`formatPrice(card.priceLow, …)`. Confirm the spread test goes red. Restore. Report.

- [ ] **Step 6: Report**

Do not commit. Report the files changed and the mutation result.

---

### Task 10: The wishlist's chin, and its corner moved down

**Needs Task 8.**

**Files:**
- Modify: `src/features/wishlist/WishlistGrid.tsx` (`captionFor` ~line 71; the `topLeft` slot
  ~line 300)
- Test: `src/features/wishlist/WishlistGrid.test.tsx`

**Interfaces:**
- Consumes: `CardGrid`'s `money` slot from Task 8.
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

```tsx
  /**
   * The chin means one thing on every wall in the app: what **one copy** of this exact printing
   * and finish costs. "Still to buy" is a different question — unit × missing — and it keeps the
   * corner it already has, beside the review flag, where the header's own "Still to buy" sums it.
   */
  it("quotes one copy in the chin", () => {
    renderWishlist({ rows: [wish({ unitPrice: 12.32, quantity: 4, ownedQuantity: 2 })] });
    expect(screen.getByText("$12.32")).toBeInTheDocument();
    expect(screen.getByText("$24.64")).toBeInTheDocument();
  });

  /**
   * A wish the marketplace does not quote draws an em dash rather than another marketplace's rate
   * wearing this one's currency sign.
   */
  it("draws an em dash for a wish this marketplace cannot price", () => {
    renderWishlist({ rows: [wish({ unitPrice: null })] });
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  /**
   * The corner sat 4px in, which on the search wall is deliberately the card's printed nameplate
   * — and on a wishlist tile is the card's own **name**. It drops below the printed title bar.
   */
  it("keeps the corner clear of the card's printed name", () => {
    renderWishlist({ rows: [wish({ needsReview: "Check the printing." })] });
    const corner = screen.getByText("Needs review").closest("span[class*='absolute']")!;
    expect(corner.className).not.toContain("top-[calc(0.25rem*var(--mark-scale,1))]");
  });
```

The third test asserts on a class string, which is brittle — read how `CardGrid` positions the
`topLeft` corner before writing it, and if the offset turns out to live on `CardGrid`'s own
wrapper rather than on the wishlist's mark, **stop and report**: the corner would then have to move
for every wall or gain a prop, and that is a design question rather than an implementation one.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/features/wishlist`
Expected: the three new tests FAIL.

- [ ] **Step 3: Implement the chin's money**

On the `CardGrid`:

```tsx
      // What **one copy** costs, at the printing and finish this wish is for — the same statement
      // every other wall's chin makes. The wish's own `unitPrice`, which since this branch is
      // quoted at the printing's `nonfoil → foil → etched` chain where the wish names no finish,
      // so a foil-only printing is priced rather than left blank.
      //
      // Spec §5: a price is never shown without saying how old it is. `pricesAsOf` is under this
      // wall already, said once, which is why this is a bare figure and not a tooltip on every
      // one of forty tiles.
      money={(tile) => formatPrice(tile.wish.unitPrice, currency)}
```

Leave the `topLeft` slot's cost figure exactly as it is — it is a different question and it keeps
its tooltip.

- [ ] **Step 4: Move the corner down**

The `topLeft` mark's own wrapper gets a downward offset clearing the card's printed title bar:

```tsx
        return (
          <span
            className={cn(
              "flex flex-col items-start leading-[calc(1rem*var(--mark-scale,1))]",
              // **Below the printed title bar, not on it.** The search wall puts this corner 4px
              // in *on purpose* — there the mark is a printings count and the nameplate is the
              // quietest place for it. On a wishlist tile the same 4px lands on the card's own
              // name, which is the one thing a reader identifies a tile by. `2rem` clears the
              // printed bar at every zoom because it scales with the card, exactly as the mark
              // inside it does.
              "mt-[calc(2rem*var(--mark-scale,1))]",
            )}
          >
```

If that reads wrong against the real window, Task 14's live pass is where it is settled — record
the measured clearance there.

- [ ] **Step 5: Run them and watch them pass**

Run: `npx vitest run src/features/wishlist`
Expected: PASS, the whole directory.

- [ ] **Step 6: Mutate**

Change `money` to `formatPrice(tile.wish.unitPrice * 2, currency)`. Confirm the first test goes
red. Restore. Report.

- [ ] **Step 7: Report**

Do not commit. Report the files changed, the mutation result, and **whether the corner's offset
turned out to be the wishlist's to move** (see Step 1).

---

### Task 11: `foldCopies` splits by finish

**Needs Task 8.** The deck editor's docked Collection tab folds collection rows into tiles in
`collectionTiles.ts`, by `cardId` — the second of the app's two collection merges.

**Files:**
- Modify: `src/features/decks/collectionTiles.ts` (`CopyTile` ~line 30; `foldCopies` ~line 148)
- Modify: `src/features/decks/CollectionSearchTab.tsx` (the `CardGrid` at ~line 409)
- Test: `src/features/decks/collectionTiles.test.ts`

**Interfaces:**
- Consumes: `CardGrid`'s `money` slot and `GridCard.key` from Task 8.
- Produces: `CopyTile.key: string`, `CopyTile.finish: Finish | null` (unchanged type, but now
  never `null` for a group with entries whose finish this build can name), and
  `CopyTile.unitPrice: number | null`.

- [ ] **Step 1: Write the failing tests**

```ts
  /**
   * A foil and a played nonfoil of one printing are **two objects**: two prices, two pictures,
   * sharing only a set and a number. The wall drew them as one tile and had to ask whether the
   * entries agreed about their finish; splitting the key removes the question.
   */
  it("draws a foil and a nonfoil of one printing as two tiles", () => {
    const tiles = foldCopies(
      [row({ cardId: "bolt", finish: "foil", quantity: 1, unitPrice: 9 }),
       row({ cardId: "bolt", finish: "nonfoil", quantity: 2, unitPrice: 1 })],
      here,
    );
    expect(tiles).toHaveLength(2);
    expect(tiles.map((t) => t.finish)).toEqual(["foil", "nonfoil"]);
    expect(tiles.map((t) => t.unitPrice)).toEqual([9, 1]);
    expect(tiles.map((t) => t.copies)).toEqual([1, 2]);
  });

  /**
   * Condition, folder and language do **not** split it. Those are one object at one price, and
   * the table below is where a reader gets them apart.
   */
  it("keeps two folders' worth of one finish as one tile", () => {
    const tiles = foldCopies(
      [row({ cardId: "bolt", finish: "nonfoil", folderId: null, quantity: 1 }),
       row({ cardId: "bolt", finish: "nonfoil", folderId: 7, quantity: 3 })],
      here,
    );
    expect(tiles).toHaveLength(1);
    expect(tiles[0].copies).toBe(4);
  });

  /** Every tile is one finish, so the art can always be marked. */
  it("never leaves a tile unable to say what finish it is", () => {
    const tiles = foldCopies(
      [row({ cardId: "bolt", finish: "foil" }), row({ cardId: "bolt", finish: "nonfoil" })],
      here,
    );
    expect(tiles.every((t) => t.finish !== null)).toBe(true);
  });

  /**
   * `pickCopy` now ranks **within one finish**, which is strictly more correct: a foil tile's
   * "add" can no longer reach for a nonfoil copy the reader did not point at.
   */
  it("never offers a nonfoil copy to add from a foil tile", () => {
    const tiles = foldCopies(
      [row({ id: 1, cardId: "bolt", finish: "foil" }), row({ id: 2, cardId: "bolt", finish: "nonfoil" })],
      elsewhere,
    );
    const foil = tiles.find((t) => t.finish === "foil")!;
    expect(foil.add?.finish).toBe("foil");
  });
```

Read the file's existing test helpers (`row`, and whatever stands in for `sourceOf`) and reuse
them. If `row` has no `unitPrice`, add it there.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/features/decks/collectionTiles.test.ts`
Expected: the four new tests FAIL — the first with `toHaveLength(1)`.

- [ ] **Step 3: Implement**

Add to `CopyTile`:

```ts
  /**
   * This tile's identity — `${cardId}:${finish}`, which is **not** the card's id.
   *
   * A foil and a played nonfoil of one printing are two tiles carrying one `id`, so the wall's
   * ring, its arrow walk and its picked set all key on this instead. See `CardGrid`'s `GridCard.key`.
   */
  key: string;
  /**
   * What one copy of this printing, in **this** finish, costs at the marketplace the query named.
   *
   * Taken off the group's first row rather than reduced across them: every row in a group now
   * names the same printing *and* the same finish, so they all carry the same figure and picking
   * the first is not a choice between two answers. `null` is unpriced there, and it is never
   * filled in from another marketplace or another finish.
   */
  unitPrice: number | null;
```

Rewrite the fold's grouping key and the finish:

```ts
  const grouped = new Map<string, { row: CollectionRow; source: CopySource }[]>();
  for (const row of rows) {
    // **The finish is part of the key**, which is the whole of this wall's grain change: a foil
    // and a played nonfoil are two objects at two prices that share only a set and a number.
    // Condition, folder and language are *not* — those are one object, and the table is where a
    // reader gets them apart.
    const key = `${row.cardId}:${row.finish}`;
    const held = grouped.get(key);
    ...
  }

  for (const [key, entries] of grouped) {
    const first = entries[0].row;
    ...
      key,
      id: first.cardId,
      // Every entry in this group is the same finish now, so there is nothing to disagree about
      // — the old `finishes.size === 1 ? … : null` was the question the key change answers.
      // Still narrowed against `FINISHES` rather than cast: `finish` is TEXT with a CHECK rather
      // than an enum this side knows, so a word this build cannot name marks nothing instead of
      // marking the art with a sheen no stylesheet has.
      finish: (FINISHES as readonly string[]).includes(first.finish)
        ? (first.finish as Finish)
        : null,
      unitPrice: first.unitPrice ?? null,
    ...
  }
```

Delete the now-dead `finishes`/`only` locals. Update `CopyTile.finish`'s doc — the sentence about
"where the copies behind this tile disagree" is now false and must be replaced, not left.

In `CollectionSearchTab.tsx`, on the `CardGrid`:

```tsx
          // What one copy of this printing **in this finish** costs — the tile's own figure, so a
          // foil tile and the nonfoil beside it quote different money, which is the whole reason
          // they are two tiles.
          money={(tile) => formatPrice(tile.unitPrice, currency)}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/features/decks/collectionTiles.test.ts src/features/decks/CollectionSearchTab.test.tsx`
Expected: PASS, both files.

- [ ] **Step 5: Mutate**

Change the key back to `row.cardId`. Confirm the first and third tests go red. Restore. Report.

- [ ] **Step 6: Report**

Do not commit. Report the files changed and the mutation result.

---

### Task 12: The collection wall splits, and quotes a price

**Needs Tasks 4 and 8.** The other of the app's two collection merges.

**Files:**
- Modify: `src/features/collection/CollectionPage.tsx` (`CollectionTile` ~line 180; the `tiles`
  memo ~line 547; the `CardGrid` ~line 1346)
- Test: `src/features/collection/CollectionPage.test.tsx`

**Interfaces:**
- Consumes: `GridCard.key` and `money` from Task 8; `openCardAsFinish` and `paneFinish` from Task 4.
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

```tsx
  /**
   * A foil and a played nonfoil are two objects at two prices sharing only a set and a number.
   * The wall merged them into one piece of art and had no honest price to put under it.
   */
  it("draws a foil and a nonfoil of one printing as two priced tiles", () => {
    renderCollection({
      rows: [
        collectionRow({ cardId: "bolt", finish: "foil", quantity: 1, unitPrice: 9 }),
        collectionRow({ cardId: "bolt", finish: "nonfoil", quantity: 2, unitPrice: 1 }),
      ],
      view: "grid",
    });
    expect(screen.getByText("$9.00")).toBeInTheDocument();
    expect(screen.getByText("$1.00")).toBeInTheDocument();
  });

  /** Two folders' worth of one finish are one object and one tile — only the finish splits. */
  it("keeps one finish filed in two folders as one tile", () => {
    renderCollection({
      rows: [
        collectionRow({ cardId: "bolt", finish: "nonfoil", folderId: null, quantity: 1, unitPrice: 1 }),
        collectionRow({ cardId: "bolt", finish: "nonfoil", folderId: 7, quantity: 3, unitPrice: 1 }),
      ],
      view: "grid",
    });
    expect(screen.getAllByText("$1.00")).toHaveLength(1);
  });

  /**
   * "Clicking on a foil should display that printing, but in the foil version." The pane seeds its
   * foil view from this — there is no foil photograph to fetch, so what it turns on is
   * `FoilOverlay` over the same picture.
   */
  it("opens the pane as the finish the tile was pressed on", async () => {
    const user = userEvent.setup();
    renderCollection({
      rows: [collectionRow({ cardId: "bolt", finish: "foil", name: "Lightning Bolt" })],
      view: "grid",
    });
    await user.click(screen.getByRole("button", { name: /Lightning Bolt/ }));
    expect(useAppStore.getState().selectedCardId).toBe("bolt");
    expect(useAppStore.getState().paneFinish).toBe("foil");
  });

  /**
   * A tile that merges exactly one finish records that finish without asking — which is a fix
   * rather than a tidy-up. A reader owning two foils and no nonfoil used to fall to the menu's
   * unknown-list rule and get a silent **nonfoil** entry.
   */
  it("names the tile's one finish to the card menu", () => {
    renderCollection({
      rows: [collectionRow({ cardId: "bolt", finish: "foil" })],
      view: "grid",
    });
    // Assert through whatever this file already uses to read a tile's menu target.
  });
```

Read the file's existing helpers first. If there is no existing way to read a tile's menu target,
assert on the rendered `finishes` JSON the tile carries and say so in the test's doc.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/features/collection/CollectionPage.test.tsx`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement the split**

`CollectionTile` gains `key: string`, `finish: Finish | null` and `unitPrice: number | null`, with
the same docs Task 11 wrote for `CopyTile` — quote them, do not paraphrase, because the two shapes
are now the same idea in two places and drift between them is the failure this whole spec is about.

The `tiles` memo groups on `` `${row.cardId}:${row.finish}` `` throughout — the `copies` map, the
`finishes` map (which now always holds exactly one) and the `seen` set. `ownedFinishes` is then a
one-element list, which is what makes the menu honest; keep the function and its doc, and note in
that doc that the set is now always a singleton and why that is better rather than redundant.

- [ ] **Step 4: Wire the wall**

```tsx
              // The tile's identity, which is not the card's: two tiles here are one printing in
              // two finishes. See `CardGrid`'s `GridCard.key`.
              //
              // The ring follows it, which is why `selectedId` is a **composite** now: the pane's
              // card id alone would ring both tiles of a printing the reader opened one of.
              selectedId={
                selectedCardId === null
                  ? null
                  : `${selectedCardId}:${paneFinish ?? "nonfoil"}`
              }
              // The finish travels with the press, so the pane opens showing the object the
              // reader pointed at rather than the plain one. The tile is the second argument
              // because a tile here is a printing *and* a finish — see `CardGrid`'s `onSelect`.
              onSelect={(cardId, tile) => openCardAsFinish(cardId, tile.finish)}
              // What one copy of this printing **in this finish** costs. Already on the row and
              // priced at that entry's exact finish by `collection.rs`; the wall simply never
              // drew it.
              money={(tile) => formatPrice(tile.unitPrice, currency)}
              finish={(tile) => tile.finish}
```

The other six walls pass `onSelect={selectCard}` and ignore the second argument, which is why
widening it in Task 8 costs them nothing.

- [ ] **Step 5: Run them and watch them pass**

Run: `npx vitest run src/features/collection`
Expected: PASS, the whole directory. The wall's existing `OwnedBadge` tests may need their
expectations updated — a badge now counts one finish's copies, which is the change, and each edited
expectation gets its reason in the test's own doc.

- [ ] **Step 6: Mutate**

Group on `row.cardId` again. Confirm the first test goes red. Restore. Then drop `paneFinish` from
the composite `selectedId` and confirm a ring test goes red — **if none does, say so**.

- [ ] **Step 7: Report**

Do not commit. Report the files changed, both mutation results, any pre-existing expectation you
changed with its reason, and whether Step 4's `onSelect` needed widening.

---

### Task 13: The reference docs

A prose-only edit routes to neither CI job, so nothing goes red when a document rots. Every number
below is re-counted in this commit.

**Files:**
- Modify: `docs/reference/frontend-design.md`
- Modify: `docs/reference/wishlist-folders.md`
- Modify: `docs/reference/collection-folders.md`
- Modify: `docs/reference/data-and-sync.md`

- [ ] **Step 1: `frontend-design.md`**

Add a **The card's chin** section: that `components/CardChin.tsx` is the one card foot; the three
heights and three type sizes it replaced (28/10, 25/12, 20/9) and which surface each was; the rise
and why it does not scale; and the `seam` prop with the 2px-foot defect it exists to prevent. Point
at `chinHeight` in `lib/cardZoom.ts` for the sum.

- [ ] **Step 2: `wishlist-folders.md`**

Record both pricing changes with the measurements: 88 wishes, 1 unpriced, FIC #477 as the case,
12,849 of 116,843 printings priced only in foil or etched. State the two-arm rule and that it is
`sorting::row_price_expr` quoted rather than a new one. State that an any-printing wish now takes
the cheapest printing and that the **picture moves with the price**, with the unpriced fallback to
`released_at DESC, id ASC` and why it exists.

- [ ] **Step 3: `collection-folders.md`**

Record that the wall's grain is now the printing **and the finish**, that condition/folder/language
still merge, that there are two folds (`CollectionPage`'s memo and `collectionTiles.ts`'s
`foldCopies`) and both split, and that a tile's `finishes` list is now a singleton — with the menu
bug that fixes.

- [ ] **Step 4: `data-and-sync.md`**

Add the cheapest-printing join's measured cost beside the other search-performance numbers.
**Leave a marked blank for Task 14 to fill** — the figure has to come off the shipped window, and a
number written before it was measured is exactly the rot this step exists to prevent. Write the
row with `— pending, see Task 14` and nothing else.

- [ ] **Step 5: Re-count**

Any list or count you touched, re-count in this same edit. Do not write down a number a build
already answers.

- [ ] **Step 6: Report**

Do not commit. Report the files changed.

---

### Task 14: Verify, and drive the real window

**Controller task. Runs after every other task has been folded in.** Tests run once, at the end,
after fan-in — a suite run mid-fan-out fails for reasons that are not its own.

- [ ] **Step 1: One verify, and only one**

Never run two verifies at once — concurrent runs fake ~18 Rust schema failures.

```
npm run verify > verify.log 2>&1
```

`verify`'s exit code lies through a pipe, so **grep the log's summary** rather than trusting `$?`.
If the run gets killed, shard it: `npx vitest run --shard=1/3`, then `2/3`, then `3/3`, and sum.

- [ ] **Step 2: The two reds a green verify cannot catch**

```
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

`verify` runs neither, and CI runs both.

- [ ] **Step 3: Story plays**

Run the story-play suite the repo already has (`stories.test.tsx` collects the whole tree). Plays
are unrunnable during a fan-out, so this is where they are answered — budget a fix round.

- [ ] **Step 4: Drive the real window**

`npm run tauri dev` — take the app lock through `.claude/skills/running-the-app/lock.ps1` first;
one app runs across every worktree and a second exits with code 0, no window and no stderr. Drive
it over CDP from **PowerShell** (`scripts/cdp.mjs`; Bash refuses `eval` here), and remember: click
then read is pre-flush, so split a click and its assertion into two `eval`s; `hover --rest 200`
before a `click` or the cold pointer makes it a no-op; wrap every binding in an IIFE, because
`eval` shares one scope.

Check, and photograph:

1. **The chin's seam** on all three surfaces at 0.5×, 1× and 2× — no hairline of background
   between face and foot, and no 2px foot on a rule-breaking deck card.
2. **Wakka, Devoted Guardian** priced on the wishlist. It is already in the database.
3. **A split collection tile pair** — add a foil entry for a printing already held nonfoil, and
   confirm two tiles, two prices, and that clicking the foil opens the pane showing the sheen.
   Delete the seeded row afterwards.
4. **The wishlist corner** clear of the printed card name.
5. **The action strip** revealing on hover and reachable by Tab, with its popup opening from the
   tile's left edge in the first column.
6. **An any-printing wish** drawn as the cheapest printing. Seed one, read the tile, delete it.

- [ ] **Step 5: Measure the join, and fill the blank**

Time `wishlist_list` with an any-printing wish present, against the real corpus, and put the
figure into `data-and-sync.md`'s pending row. **Name the build** — debug or release; the same
measurement can differ by ~8×.

- [ ] **Step 6: Commit and ship**

Commit in `feat:`/`fix:` slices matching the tasks. Then use the **`auto-pr`** skill, which the
reader asked for: `pr-auto.ps1 open`, then `arm`. Watch only for the two states GitHub abandons —
a real conflict and a red `ci-ok`. Do not chase `BEHIND`, and do not press Merge.

Note: `pr-auto.ps1 open` **skips a reused branch** — if this branch has had a PR merged before, it
reports MERGED and silently creates nothing. Check, and fall back to `gh pr create` + `arm -Pr <n>`.

---

## Self-review

**Spec coverage.** Every section maps to a task: the chin component → 5; the geometry → 1; the
per-wall money table → 6, 7, 8, 9, 10, 11, 12; the action control → 8; the collection split → 12;
`foldCopies` → 11; the walk deliberately not split → stated in 12's context, no code; the pane's
foil view → 4; both Rust changes → 2, 3; the wishlist corner → 10; docs → 13; testing → every
task's mutation step plus 14.

**Naming consistency.** `row_price_expr` (2) is consumed by 3. `WISH_PREFERRED_FINISH` (2) is used
only in 2 and 3. `CHIN_HEIGHT`/`CHIN_RISE`/`chinHeight` (1) are consumed by 5, 6, 7, 8.
`GridCard.key` and `money` (8) are consumed by 9, 10, 11, 12. `paneFinish`/`openCardAsFinish` (4)
are consumed by 12. `CopyTile.key`/`unitPrice` (11) are consumed only within 11.

**One known soft spot, flagged in the task rather than papered over.** Task 10's corner-offset
assertion depends on whether the 4px inset lives on the wishlist's own mark or on `CardGrid`'s
corner wrapper — if it is the wrapper's, moving it would move every wall's corner, which is a
design question and not an implementation one. That step says "stop and report" rather than guess,
because it is a place where a wrong guess produces a green suite and a wrong screen.

(Task 12's `onSelect` was the second soft spot and is now resolved at the source: Task 8 widens the
prop to `(id, card)`, and the six walls that ignore the second argument are unaffected.)

**Task 7's `seam` has no test and cannot have one** — jsdom cannot see a 1px seam. The task says so
explicitly and Task 14's live pass is where it is answered. That is a stated gap, not an oversight.
