# Card Search Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the card search to one row per card with a toggle back to every printing, mark
foil printings on the art through an extracted card component, and replace the foil price letter
with a glyph.

**Architecture:** The collapse is a second SQL shape in `run_search` — a `GROUP BY` step that
computes the aggregates and the representative printing's id, then a primary-key join back for that
row's columns. A new covering index makes it affordable. The frontend adds one view-mode flag to
`useCardSearch` and renders two new fields. The foil work extracts `CardGrid`'s private `Tile`
internals into `src/components/CardArt.tsx` so five surfaces draw a card the same way.

**Tech Stack:** Rust (rusqlite, SQLite FTS5), React 19, TypeScript 6, Tailwind v4, Vitest, Storybook.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-08-11-card-search-improvements-design.md` and
`CLAUDE.md`. Every task's requirements implicitly include this section.

- **Every index on `cards` goes in `schema::CARDS_INDEXES`.** `swap_staging` drops `cards` with its
  indexes on every sync and replays only that list.
- **`CARDS_COLUMNS` is frozen.** Schema changes are a new `if v < N` block in `migrate`.
- **A migration step writes its own literal `user_version`, never `SCHEMA_VERSION`.**
- **The group key is `coalesce(c.oracle_id, c.id)`.** `cards.oracle_id` is NULLABLE; a bare
  `GROUP BY c.oracle_id` merges every null-oracle printing into one card.
- **The owned/wishlist status subqueries key on `c.oracle_id` — the joined representative's own
  column — never on the group key.** Measured: the group-key form costs 1,514 ms on the browse and
  12,729 ms on the rarity sort.
- **`bm25()` cannot be aggregated except inside a `WITH … AS MATERIALIZED` CTE.** A plain CTE, a
  subquery and a direct `min(bm25(…))` all fail with *"unable to use function bm25 in the requested
  context"*. FTS5's `rank` column aggregates but carries the table's default weights, throwing away
  this app's 10× name weighting.
- **No user text is ever interpolated into SQL.** Sort keys are matched against `&'static str`
  literals; everything else is bound.
- **Dim text is `text-dim`, never `text-muted`.** `src/lib/tokens.test.ts` guards it.
- **Z-indexes come from `LAYER` in `src/lib/layers.ts`.** `src/lib/layers.test.ts` sweeps `src/`.
- **Tailwind scans source text for whole class names** — a class built by string interpolation emits
  no rule.
- **Card art is drawn with `components/CardImage`, never a bare `<img>`.**
- Run `npm run verify` before every commit. Commit with `feat:`/`fix:`/`chore:`/`test:`/`docs:`.

## File Structure

| File | Responsibility |
|---|---|
| `src-tauri/src/schema.rs` | Modify: add `idx_cards_collapse` to `CARDS_INDEXES`, a v7 step, bump `SCHEMA_VERSION` to 7 |
| `src-tauri/src/search.rs` | Modify: `collapse` on the request, three fields on `CardSummary`, the grouped query, the non-card demotion |
| `src/lib/ipc.ts` | Modify: mirror the three new response fields and the request field |
| `src/features/search/useCardSearch.ts` | Modify: `allPrintings` state, query key, request field |
| `src/features/search/FilterBar.tsx` | Modify: the "All printings" chip |
| `src/features/search/SearchPage.tsx` | Modify: printing count and price range in the table columns |
| `src/features/search/CardGrid.tsx` | Modify: a top-left corner slot; `Tile` internals move out |
| `src/components/CardArt.tsx` | **Create**: the 5:7 card frame — image, retry, fallback, foil, corner slots |
| `src/components/CardArt.test.tsx` | **Create** |
| `src/components/FinishMark.tsx` | **Create**: the finish glyph |
| `src/components/FinishMark.test.tsx` | **Create** |
| `src/lib/finish.ts` | Modify: `soleFinish`, `FINISH_MARK` removed |
| `src/features/card/CardDetailPane.tsx` | Modify: `FinishMark`, `CardArt` on the printings rows |
| `src/features/decks/ZoneColumn.tsx` | Modify: `CardArt` on the deck rows |
| `src/features/collection/CollectionTable.tsx` | Modify: `FinishMark` in the finish column |
| `src/components/CardArt.stories.tsx` | **Create** |
| `CLAUDE.md` | Modify: the measured facts this work established |

---

### Task 1: Schema v7 — the collapse index

**Files:**
- Modify: `src-tauri/src/schema.rs` — `CARDS_INDEXES` (~line 87), `SCHEMA_VERSION` (line 151), the
  end of `migrate` (~line 692), and the existing swap test (~line 1079)

**Interfaces:**
- Consumes: nothing.
- Produces: the index `idx_cards_collapse` on
  `cards(oracle_id, is_paper, released_at, id, name, price_usd)`; `SCHEMA_VERSION == 7`.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src-tauri/src/schema.rs`:

```rust
/// The collapsed search reads this index and nothing else; without it the default browse
/// costs 767 ms instead of 108 ms. It lives in `CARDS_INDEXES` because `swap_staging` drops
/// `cards` with its indexes on every sync and replays only that list — an index created
/// anywhere else is gone at the next sync, on every machine that has already migrated.
#[test]
fn the_collapse_index_exists_after_migrate_and_survives_a_swap() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();

    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_cards_collapse'",
            [],
            |r| r.get(0),
        )
        .expect("migrate must create idx_cards_collapse");
    // The column order is the whole point: `oracle_id` leads so the GROUP BY reads it in
    // group order, and the rest are there so the scan is covering.
    assert!(
        sql.contains("oracle_id, is_paper, released_at, id, name, price_usd"),
        "index column order decides whether the scan is covering: {sql}"
    );

    create_staging(&conn).unwrap();
    swap_staging(&conn).unwrap();
    let after: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master
              WHERE type='index' AND tbl_name='cards' AND name='idx_cards_collapse'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(after, 1, "the swap must replay the collapse index");
}

/// A database already at head must gain the index, and running the step twice must be a
/// no-op — every statement in `CARDS_INDEXES` is `IF NOT EXISTS`, which is what lets the v7
/// step simply re-run the whole list rather than naming one index.
#[test]
fn the_v7_step_is_idempotent_and_adds_the_index_to_an_existing_database() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    // Simulate a database that migrated before v7 existed.
    conn.execute_batch("DROP INDEX idx_cards_collapse; PRAGMA user_version = 6;")
        .unwrap();

    migrate(&conn).unwrap();
    migrate(&conn).unwrap();

    let n: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='idx_cards_collapse'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema::tests::the_collapse_index`
Expected: FAIL — `migrate must create idx_cards_collapse` (the `query_row` returns
`QueryReturnedNoRows`).

- [ ] **Step 3: Add the index, the migration step, and bump the version**

In `CARDS_INDEXES` (after the three existing entries):

```rust
    // The collapsed search's whole cost model. The group step reads `oracle_id` in order
    // and finds every other column it needs in the index, so the scan is covering: 108 ms
    // for the default collapsed browse against 767 ms without it (measured 2026-08-11 over
    // the live 107 337-row paper corpus). 14 MB, and 0.7 s added to a 92–99 s sync.
    //
    // The order is load-bearing and the trailing columns are not decoration. Widening it
    // further with `rarity`/`set_code`/`type_line` was measured and is a straight loss —
    // it made the name sort 38→61 ms and left the sorts it was meant to help unchanged,
    // because those cost row lookups rather than index reads.
    "CREATE INDEX IF NOT EXISTS idx_cards_collapse \
     ON cards(oracle_id, is_paper, released_at, id, name, price_usd)",
```

Change `pub const SCHEMA_VERSION: i64 = 6;` to `= 7`.

At the end of `migrate`, after the `if v < 6` block and before `Ok(())`:

```rust
    if v < 7 {
        let tx = conn.unchecked_transaction()?;
        // One index on `cards`, for the collapsed search. Re-running the whole
        // `CARDS_INDEXES` batch rather than naming the new one: every statement in it is
        // `IF NOT EXISTS`, so this is exactly "bring the index list up to date" and the
        // other three are untouched. A database created fresh has it from the v1 block
        // already and lands here with nothing to do.
        //
        // Nothing here reads `raw`, so `json_raw` has no part to play. Nothing here
        // touches an FTS-indexed column (`name`/`type_line`/`search_text`) and no rowid is
        // renumbered, so no `cards_fts` rebuild is owed — the reasoning
        // `the_v2_backfill_leaves_the_search_index_answering` pins.
        tx.execute_batch(&cards_indexes_sql())?;
        // Literal `7`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 7;")?;
        tx.commit()?;
    }
```

- [ ] **Step 4: Update the existing swap test, which counts index names**

`staging_swap_replaces_cards_and_fts_finds_new_rows` (~line 1079) asserts `idx == 3` over a
hardcoded name list. Change both:

```rust
                "SELECT count(*) FROM sqlite_master WHERE type='index' AND tbl_name='cards'
                 AND name IN ('idx_cards_oracle','idx_cards_set_cn','idx_cards_name',
                              'idx_cards_collapse')",
```

```rust
        assert_eq!(
            idx, 4,
            "indexes must be recreated under their original names"
        );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema::`
Expected: PASS, all of them.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/schema.rs
git commit -m "feat(schema): index cards for the collapsed search

Schema v7 adds idx_cards_collapse. It is what makes the collapsed browse
108 ms instead of 767 ms, and it goes in CARDS_INDEXES because the sync's
swap replays only that list."
```

---

### Task 2: The wire shape — `collapse` in, three fields out

Adds the fields with the **uncollapsed** values only. `collapse: true` is accepted and still returns
uncollapsed rows; Task 3 makes it mean something. This keeps the DTO change reviewable on its own.

**Files:**
- Modify: `src-tauri/src/search.rs` — `SearchRequest`, `CardSummary`, `run_search`'s `SELECT` and row
  builder, `search_response_json_uses_the_camel_case_names_the_frontend_expects`
- Modify: `src/lib/ipc.ts` — `SearchRequest`, `CardSummary`

**Interfaces:**
- Consumes: Task 1's index (not read yet).
- Produces: `SearchRequest { collapse: Option<bool>, … }`;
  `CardSummary { printings: i64, price_low: Option<f64>, price_high: Option<f64>, … }`, serialized as
  `printings`, `priceLow`, `priceHigh`. TypeScript `CardSummary` gains
  `printings: number; priceLow: number | null; priceHigh: number | null`, and `SearchRequest` gains
  `collapse?: boolean`.

- [ ] **Step 1: Write the failing test**

Replace the body of `search_response_json_uses_the_camel_case_names_the_frontend_expects` in
`src-tauri/src/search.rs`:

```rust
    #[test]
    fn search_response_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(SearchResponse {
            items: vec![CardSummary {
                id: "1".into(),
                name: "Lightning Bolt".into(),
                set_code: "lea".into(),
                set_name: None,
                collector_number: "161".into(),
                rarity: None,
                type_line: Some("Instant".into()),
                mana_cost: None,
                price_usd: Some(400.5),
                layout: "normal".into(),
                oracle_id: Some("o-bolt".into()),
                finishes: Some(r#"["nonfoil","foil"]"#.into()),
                owned_quantity: 0,
                wishlisted: false,
                printings: 1,
                price_low: Some(400.5),
                price_high: Some(400.5),
            }],
            total: 5000,
            total_is_capped: true,
        })
        .unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "items": [{
                    "id": "1", "name": "Lightning Bolt", "setCode": "lea", "setName": null,
                    "collectorNumber": "161", "rarity": null, "typeLine": "Instant",
                    "manaCost": null, "priceUsd": 400.5, "layout": "normal",
                    "oracleId": "o-bolt", "finishes": "[\"nonfoil\",\"foil\"]",
                    "ownedQuantity": 0, "wishlisted": false,
                    "printings": 1, "priceLow": 400.5, "priceHigh": 400.5
                }],
                "total": 5000,
                "totalIsCapped": true
            })
        );
    }

    /// Uncollapsed, a row stands for exactly one printing and its "range" is its own price.
    /// One shape for both modes, so no consumer has to know which produced a row.
    #[test]
    fn an_uncollapsed_row_reports_one_printing_and_a_degenerate_price_range() {
        let conn = seeded();
        let r = run_search(
            &conn,
            &SearchRequest {
                text: Some("light bol".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let card = &r.items[0];
        assert_eq!(card.printings, 1);
        assert_eq!(card.price_low, card.price_usd);
        assert_eq!(card.price_high, card.price_usd);
    }

    /// `collapse` is optional in the payload and absent means false, so every existing
    /// caller sends what it always sent and gets what it always got.
    #[test]
    fn collapse_is_absent_by_default_and_parses_when_sent() {
        let bare: SearchRequest = serde_json::from_str(r#"{"text":"bolt"}"#).unwrap();
        assert_eq!(bare.collapse, None);
        let set: SearchRequest = serde_json::from_str(r#"{"collapse":true}"#).unwrap();
        assert_eq!(set.collapse, Some(true));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml search::tests`
Expected: FAIL to compile — `struct CardSummary has no field named printings`.

- [ ] **Step 3: Add the fields**

In `SearchRequest`, after `pub sort:`:

```rust
    /// Fold every printing of one card into a single row, represented by the newest
    /// printing. Absent means **false** — the search view sends `true` explicitly, and
    /// every other caller (the deck panel aside, which shares the view's hook) keeps the
    /// shape it always had.
    pub collapse: Option<bool>,
```

In `CardSummary`, after `wishlisted`:

```rust
    /// How many printings this row stands for. `1` uncollapsed, always — a row is a
    /// printing then, and "1" is the true answer rather than a filler.
    ///
    /// Collapsed, it counts the printings that **matched the filters**, not every printing
    /// that exists: filters narrow printings first and the survivors are grouped, so a
    /// search restricted to one set says how many printings are in that set. The row
    /// summarises the answer, never the database.
    pub printings: i64,
    /// Cheapest and dearest `price_usd` among the printings this row stands for. Both equal
    /// [`Self::price_usd`] uncollapsed.
    ///
    /// `price_usd` remains what it always was — the representative printing's own value,
    /// itself a nonfoil→foil→etched fallback chain that must never be summed.
    pub price_low: Option<f64>,
    pub price_high: Option<f64>,
```

In `run_search`'s row-building loop, after `wishlisted: row.get(13)…`:

```rust
            printings: 1,
            price_low: row.get(8).map_err(|e| e.to_string())?,
            price_high: row.get(8).map_err(|e| e.to_string())?,
```

- [ ] **Step 4: Mirror it in TypeScript**

In `src/lib/ipc.ts`, add to `SearchRequest` after `sort?:`:

```ts
  /**
   * Fold every printing of one card into a single row, represented by the newest printing.
   * Absent means false. A view mode rather than a filter — see `useCardSearch`.
   */
  collapse?: boolean;
```

Add to `CardSummary` after `wishlisted`:

```ts
  /**
   * How many printings this row stands for — `1` when the search is not collapsed.
   *
   * Collapsed, it counts the printings that **matched the filters** rather than every
   * printing that exists: a search narrowed to one set reports the printings in that set.
   */
  printings: number;
  /**
   * Cheapest and dearest `priceUsd` among the printings this row stands for; both equal
   * {@link CardSummary.priceUsd} when the search is not collapsed. Render a range only when
   * the two differ — most cards have one printing, and `$2.15–$2.15` is noise.
   */
  priceLow: number | null;
  priceHigh: number | null;
```

- [ ] **Step 5: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml search::tests && npm run build`
Expected: PASS, and the TypeScript program compiles.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/search.rs src/lib/ipc.ts
git commit -m "feat(search): carry a printing count and a price range on every row

Uncollapsed values only: printings is 1 and the range is the row's own
price, so one DTO shape serves both modes and no consumer has to know
which produced a row."
```

---

### Task 3: The collapsed query — browse, count, status

**Files:**
- Modify: `src-tauri/src/search.rs` — `run_search`

**Interfaces:**
- Consumes: Task 1's index, Task 2's fields.
- Produces: `run_search` honours `collapse: Some(true)` for filtered and unfiltered browses.
  Constants `COLLAPSE_KEY`, `COLLAPSE_REP`, `ORDER_NAME_COLLAPSED` are added and used by Task 4.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src-tauri/src/search.rs`:

```rust
    /// Six printings of one card become one row, and the row says how many it stands for.
    #[test]
    fn collapse_folds_every_printing_of_a_card_into_one_row() {
        let conn = seeded();
        for (id, set, released, price) in [
            ("b1", "lea", "1993-08-05", 400.0),
            ("b2", "m10", "2009-07-17", 5.0),
            ("b3", "m11", "2010-07-16", 3.0),
        ] {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,released_at,
                                    price_usd,is_paper,oracle_id,raw)
                 VALUES (?1,'Shock',?2,'1','en','normal',?3,?4,1,'o-shock','{}')",
                rusqlite::params![id, set, released, price],
            )
            .unwrap();
        }

        let r = run_search(
            &conn,
            &SearchRequest {
                text: None,
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();

        let shocks: Vec<&CardSummary> = r.items.iter().filter(|c| c.name == "Shock").collect();
        assert_eq!(shocks.len(), 1, "three printings, one row");
        assert_eq!(shocks[0].printings, 3);
        assert_eq!(shocks[0].id, "b3", "the newest printing represents the card");
        assert_eq!(shocks[0].price_low, Some(3.0));
        assert_eq!(shocks[0].price_high, Some(400.0));
    }

    /// `total` is a count of **cards** when the rows are cards. A caption reading "3 cards"
    /// above one row would be the pager's denominator lying to the reader.
    #[test]
    fn the_total_counts_cards_when_the_search_is_collapsed() {
        let conn = seeded();
        for id in ["b1", "b2", "b3"] {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,
                                    oracle_id,raw)
                 VALUES (?1,'Shock','lea',?1,'en','normal',1,'o-shock','{}')",
                rusqlite::params![id],
            )
            .unwrap();
        }
        let collapsed = run_search(
            &conn,
            &SearchRequest {
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let flat = run_search(
            &conn,
            &SearchRequest {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(flat.total, 5, "two fixture cards plus three Shocks");
        assert_eq!(collapsed.total, 3, "two fixture cards plus one Shock");
        assert_eq!(collapsed.total as usize, collapsed.items.len());
    }

    /// `cards.oracle_id` is NULLABLE. A bare `GROUP BY c.oracle_id` puts every null-oracle
    /// printing in one group — not a wrong row but a *merged* one, showing unrelated cards
    /// under a single name with a printing count spanning all of them, and nothing anywhere
    /// would flag it. No live row is null (0 of 116 590), so this case exists only here.
    #[test]
    fn printings_with_no_oracle_id_are_each_their_own_card() {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        for (id, name) in [("n1", "Alpha"), ("n2", "Beta")] {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw)
                 VALUES (?1,?2,'lea','1','en','normal',1,'{}')",
                rusqlite::params![id, name],
            )
            .unwrap();
        }
        let r = run_search(
            &conn,
            &SearchRequest {
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.total, 2, "two cards, not one merged group");
        let names: Vec<&str> = r.items.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Alpha", "Beta"]);
        assert!(r.items.iter().all(|c| c.printings == 1));
    }

    /// Filters narrow printings first; the survivors are grouped. So the count and the
    /// range describe what matched, never the whole database.
    #[test]
    fn the_printing_count_describes_what_matched_and_not_the_database() {
        let conn = seeded();
        for (id, set, price) in [("b1", "lea", 400.0), ("b2", "m10", 5.0), ("b3", "m10", 3.0)] {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,price_usd,
                                    is_paper,oracle_id,raw)
                 VALUES (?1,'Shock',?2,?1,'en','normal',?3,1,'o-shock','{}')",
                rusqlite::params![id, set, price],
            )
            .unwrap();
        }
        let r = run_search(
            &conn,
            &SearchRequest {
                set_code: Some("m10".into()),
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.items.len(), 1);
        assert_eq!(r.items[0].printings, 2, "the two m10 printings, not all three");
        assert_eq!(r.items[0].price_high, Some(5.0), "and priced across those two");
    }

    /// "Do I have this card" is the question a collapsed row asks, so copies of *any*
    /// printing count. Uncollapsed the same fixture answers per printing.
    #[test]
    fn a_collapsed_row_counts_copies_of_every_printing_of_the_card() {
        let conn = seeded();
        for (id, set) in [("b1", "lea"), ("b2", "m10")] {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,
                                    oracle_id,released_at,raw)
                 VALUES (?1,'Shock',?2,?1,'en','normal',1,'o-shock','2009-01-01','{}')",
                rusqlite::params![id, set],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO collection_entries (card_id,set_code,collector_number,lang,finish,quantity)
             VALUES ('b1','lea','b1','en','nonfoil',2)",
            [],
        )
        .unwrap();

        let collapsed = run_search(
            &conn,
            &SearchRequest {
                text: Some("shock".into()),
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(collapsed.items.len(), 1);
        assert_eq!(collapsed.items[0].owned_quantity, 2, "copies of any printing");

        let flat = run_search(
            &conn,
            &SearchRequest {
                text: Some("shock".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let b2 = flat.items.iter().find(|c| c.id == "b2").unwrap();
        assert_eq!(b2.owned_quantity, 0, "uncollapsed is still per printing");
    }
```

Note: `seeded()` does not set `oracle_id`, so its three fixture rows each become their own card
through the `coalesce` key — which is exactly what
`printings_with_no_oracle_id_are_each_their_own_card` asserts, and why the counts above are 5 and 3.

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml search::tests::collapse`
Expected: FAIL — `three printings, one row` (collapse is accepted but ignored).

- [ ] **Step 3: Add the constants**

In `src-tauri/src/search.rs`, after `ORDER_NAME`:

```rust
/// What makes two printings the same card.
///
/// `coalesce`, not a bare `c.oracle_id`: the column is NULLABLE, and a bare `GROUP BY` puts
/// **every** null-oracle printing in one group — showing unrelated cards under one name with
/// a printing count spanning all of them, silently. No live row is null (0 of 116 590,
/// reversible printings included), so this costs 69 ms — 108 ms against 38 ms for the bare
/// column — to defend a population of zero. Spent anyway, because the failure is invisible.
///
/// An **expression index** on this does not recover it: SQLite scans such an index but will
/// not treat it as covering, and the page went to 700 ms. `idx_cards_collapse` leads with
/// the plain `oracle_id` column and the group step computes the coalesce as it scans.
const COLLAPSE_KEY: &str = "coalesce(c.oracle_id, c.id)";

/// The representative printing's `id`, straight out of the aggregate that picks it.
///
/// `released_at` is a fixed-width ISO date, so coalescing it to `'0000-00-00'` makes the
/// concatenation order exactly as `released_at DESC, id DESC` — and because that prefix is
/// always ten characters, `substr(…, 11)` is the winning row's id. That is what turns the
/// join back into a **primary-key** lookup: 108 ms against 767 ms for joining on the group
/// key and matching the composite expression again.
///
/// Ties on `released_at` break to the **greatest** id, where `ORDER_NAME` breaks them to the
/// least. Ids are UUIDs so both are arbitrary; this is the one that is stated.
const COLLAPSE_REP: &str = "substr(max(coalesce(c.released_at,'0000-00-00') || c.id), 11)";

/// Name order for a collapsed browse: the group's own name, which is also what it displays.
///
/// `min(c.name)` and not the representative's `c.name`. 71 of the 37 553 paper groups span
/// two names — all reversible cards, `Command Tower` beside `Command Tower // Command Tower`
/// — and `min` picks the canonical spelling. Sorting by one and showing the other would put
/// a row under a name it does not read as.
const ORDER_NAME_COLLAPSED: &str = "min(c.name) ASC";
```

- [ ] **Step 4: Branch `run_search` on `collapse`**

Replace the count statement and the page statement in `run_search`. After
`let order = crate::sorting::order_by(…);` and before the count, insert:

```rust
    let collapse = req.collapse.unwrap_or(false);
```

Replace the `count_sql` block with:

```rust
    // Collapsed, the denominator is a count of **cards**: the pager divides by it and the
    // caption prints it, and "3 cards" over one row would be a lie in both places. The
    // `LIMIT` inside still bounds the work — SQLite stops producing groups at the cap.
    let count_sql = if collapse {
        format!(
            "SELECT count(*) FROM (SELECT 1 FROM {from_sql} WHERE {where_sql} \
             GROUP BY {COLLAPSE_KEY} LIMIT {cap})",
            cap = TOTAL_CAP + 1
        )
    } else {
        format!(
            "SELECT count(*) FROM (SELECT 1 FROM {from_sql} WHERE {where_sql} LIMIT {cap})",
            cap = TOTAL_CAP + 1
        )
    };
```

Replace the `let sql = format!(…)` page statement with:

```rust
    let sql = if collapse {
        // Two steps. The group step computes every aggregate and the representative's id,
        // and takes the `LIMIT` — so at most 50 rows are ever fetched from `cards`. Then a
        // primary-key join back for that row's columns.
        //
        // **The two status subqueries probe `c.oracle_id` — the joined representative's own
        // indexed column — and never `g.oid`.** Writing them against the group key cost
        // 1,514 ms on the browse and 12,729 ms on the rarity sort, because `coalesce(…)` is
        // not indexable and each of 37 553 groups then re-scanned `cards`. A card whose
        // `oracle_id` is NULL therefore reads `0` copies rather than merging with another
        // card's — a fence around the type, which is how the rest of the app treats it too.
        format!(
            "WITH g AS (
                SELECT {COLLAPSE_KEY} AS oid, count(*) AS printings,
                       min(c.price_usd) AS lo, max(c.price_usd) AS hi, min(c.name) AS nm,
                       {COLLAPSE_REP} AS rep
                FROM {from_sql} WHERE {where_sql}
                GROUP BY {COLLAPSE_KEY}
                ORDER BY {group_order} LIMIT ? OFFSET ?
             )
             SELECT c.id, g.nm, c.set_code, c.set_name, c.collector_number, c.rarity,
                    c.type_line, c.mana_cost, c.price_usd, c.layout, c.oracle_id, c.finishes,
                    coalesce((SELECT sum(e.quantity) FROM collection_entries e
                               JOIN cards k ON k.id = e.card_id
                              WHERE k.oracle_id = c.oracle_id), 0),
                    EXISTS (SELECT 1 FROM wishlist_entries w
                             WHERE (w.oracle_id IS NOT NULL AND w.oracle_id = c.oracle_id)
                                OR w.card_id IN (SELECT id FROM cards
                                                  WHERE oracle_id = c.oracle_id)),
                    g.printings, g.lo, g.hi
             FROM g JOIN cards c ON c.id = g.rep
             ORDER BY {final_order}",
            group_order = format!("{ORDER_NAME_COLLAPSED}, {COLLAPSE_KEY} ASC"),
            final_order = "g.nm ASC, c.id ASC",
        )
    } else {
        format!(
            "SELECT c.id, c.name, c.set_code, c.set_name, c.collector_number, c.rarity,
                    c.type_line, c.mana_cost, c.price_usd, c.layout, c.oracle_id, c.finishes,
                    coalesce((SELECT sum(e.quantity) FROM collection_entries e
                               WHERE e.card_id = c.id), 0),
                    EXISTS (SELECT 1 FROM wishlist_entries w
                             WHERE w.card_id = c.id
                                OR (w.card_id IS NULL AND w.oracle_id IS NOT NULL
                                    AND w.oracle_id = c.oracle_id))
             FROM {from_sql} WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?"
        )
    };
```

Note the collapsed statement puts `LIMIT ? OFFSET ?` **inside** the CTE. `params.push(limit)` and
`params.push(offset)` stay exactly where they are — `?` binds by position and these are still the
last two placeholders in the string.

Finally, in the row-building loop, read the three new columns when collapsed. Replace the
`printings: 1, price_low: …, price_high: …` lines from Task 2 with:

```rust
            printings: if collapse {
                row.get(14).map_err(|e| e.to_string())?
            } else {
                1
            },
            price_low: if collapse {
                row.get(15).map_err(|e| e.to_string())?
            } else {
                row.get(8).map_err(|e| e.to_string())?
            },
            price_high: if collapse {
                row.get(16).map_err(|e| e.to_string())?
            } else {
                row.get(8).map_err(|e| e.to_string())?
            },
```

- [ ] **Step 5: Run to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml search::`
Expected: PASS, including every pre-existing search test (they all send `collapse: None`).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/search.rs
git commit -m "feat(search): collapse printings into one row per card

Group step computes the aggregates and the representative's id, then a
primary-key join back for its columns: 108 ms for the default collapsed
browse against 301 ms uncollapsed today.

The group key coalesces a null oracle_id to the row's own id, and the
status subqueries probe the representative's oracle_id rather than the
group key -- the latter measured 1,514 ms."
```

---

### Task 4: Collapsed sorting and relevance

**Files:**
- Modify: `src-tauri/src/search.rs` — `run_search`, plus a `SEARCH_SORTS_COLLAPSED` table

**Interfaces:**
- Consumes: Task 3's collapsed statement.
- Produces: collapsed searches honour `sort` and rank text searches by the group's best `bm25`.

- [ ] **Step 1: Write the failing tests**

```rust
    /// Sorting a collapsed list by price sorts by the **range**: cheapest-first ascending,
    /// dearest-available first descending. That is what pressing a range column means in
    /// each direction, and it is what the column shows.
    #[test]
    fn a_collapsed_price_sort_orders_by_the_ends_of_the_range() {
        let conn = seeded();
        for (id, name, oracle, price) in [
            ("s1", "Shock", "o-shock", 1.0),
            ("s2", "Shock", "o-shock", 90.0),
            ("t1", "Terror", "o-terror", 10.0),
            ("t2", "Terror", "o-terror", 20.0),
        ] {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,price_usd,
                                    is_paper,oracle_id,raw)
                 VALUES (?1,?2,'lea',?1,'en','normal',?3,1,?4,'{}')",
                rusqlite::params![id, name, price, oracle],
            )
            .unwrap();
        }
        let up = run_search(
            &conn,
            &SearchRequest {
                text: Some("shock OR terror".into()),
                collapse: Some(true),
                sort: Some(vec![term("price", "asc")]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let names: Vec<&str> = up.items.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Shock", "Terror"], "cheapest printing first: 1 before 10");

        let down = run_search(
            &conn,
            &SearchRequest {
                text: Some("shock OR terror".into()),
                collapse: Some(true),
                sort: Some(vec![term("price", "desc")]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let names: Vec<&str> = down.items.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Shock", "Terror"], "dearest printing first: 90 before 20");
    }

    /// Rarity, set and type are the **representative's** own columns, so the collapsed
    /// query sorts after the join rather than in the group step.
    #[test]
    fn a_collapsed_rarity_sort_uses_the_representative_and_keeps_the_rank_order() {
        let conn = seeded();
        for (id, name, oracle, rarity) in [
            ("r1", "Aa Rare", "o-rare", "rare"),
            ("r2", "Bb Common", "o-common", "common"),
            ("r3", "Cc Mythic", "o-mythic", "mythic"),
        ] {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,rarity,
                                    is_paper,oracle_id,raw)
                 VALUES (?1,?2,'zzz',?1,'en','normal',?3,1,?4,'{}')",
                rusqlite::params![id, name, rarity, oracle],
            )
            .unwrap();
        }
        let r = run_search(
            &conn,
            &SearchRequest {
                set_code: Some("zzz".into()),
                collapse: Some(true),
                sort: Some(vec![term("rarity", "asc")]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let rarities: Vec<&str> = r.items.iter().filter_map(|c| c.rarity.as_deref()).collect();
        assert_eq!(rarities, ["common", "rare", "mythic"], "rank order, not alphabetical");
    }

    /// A collapsed text search is still ranked by relevance, with the group taking the best
    /// score any of its printings scored. `bm25()` cannot be aggregated outside a
    /// MATERIALIZED CTE — a plain CTE, a subquery and a direct `min(bm25(…))` all raise
    /// "unable to use function bm25 in the requested context" — so this test is what fails
    /// if that CTE is ever "simplified".
    #[test]
    fn a_collapsed_text_search_is_ranked_by_its_best_printing() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,
                                oracle_id,search_text,raw)
             VALUES ('e1','Emeritus of Conflict // Lightning Bolt','sos','7','en','normal',1,
                     'o-emeritus','Emeritus of Conflict Lightning Bolt','{}')",
            [],
        )
        .unwrap();
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();

        let r = run_search(
            &conn,
            &SearchRequest {
                text: Some("lightning bolt".into()),
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let names: Vec<&str> = r.items.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            ["Lightning Bolt", "Emeritus of Conflict // Lightning Bolt"],
            "the exact name outranks the card that merely contains it, collapsed too"
        );
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml search::tests::a_collapsed`
Expected: FAIL — the price sort ignores `sort` entirely (Task 3 hardcodes `ORDER_NAME_COLLAPSED`).

- [ ] **Step 3: Add the collapsed sort table**

After `SEARCH_SORTS` in `src-tauri/src/search.rs`:

```rust
/// The sorts a **collapsed** search can answer inside its group step.
///
/// Same keys as [`SEARCH_SORTS`], different SQL: a group has no `c.name` or `c.price_usd`
/// of its own, it has aggregates. Price sorts by the **ends of the range** the row shows —
/// cheapest-first ascending, dearest-available first descending — which is what pressing a
/// range column means in each direction and what CLAUDE.md's rule requires: a header sorts
/// by what its column shows.
///
/// `set`, `rarity` and `type` are **deliberately absent**. They are properties of the
/// representative printing, which the group step has not resolved yet, so they are applied
/// after the join instead (see [`run_search`]). Listing them here would sort by an
/// aggregate — "the best rarity this card was ever printed at" — which is not what the
/// column shows.
const SEARCH_SORTS_COLLAPSED: &[crate::sorting::SortColumn] = &[
    crate::sorting::SortColumn {
        key: "name",
        asc: "min(c.name) ASC",
        desc: "min(c.name) DESC",
    },
    crate::sorting::SortColumn {
        key: "price",
        asc: "min(c.price_usd) ASC NULLS LAST",
        desc: "max(c.price_usd) DESC NULLS LAST",
    },
];

/// The sort keys a collapsed search has to resolve **after** the join, because they belong
/// to the representative printing rather than to the group.
const REPRESENTATIVE_SORTS: [&str; 3] = ["set", "rarity", "type"];
```

- [ ] **Step 4: Wire the orders and the ranked CTE into `run_search`**

Immediately after `let collapse = req.collapse.unwrap_or(false);`, add:

```rust
    // Which half of the collapsed query owns the ordering. A sort naming set, rarity or
    // type is about the representative printing, so it cannot be applied until after the
    // join — which means every group is joined and sorted before the limit. That is
    // 600–620 ms on a completely unfiltered browse against 108 ms for the group-step
    // orders, and ~40 ms as soon as any text narrows the set. Measured 2026-08-11.
    let sorts_after_join = collapse
        && req
            .sort
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .any(|t| REPRESENTATIVE_SORTS.contains(&t.key.as_str()));
```

Replace the collapsed `format!` from Task 3 so its two orders and its limit placement come from
variables. Before it:

```rust
    // Ranked collapsed searches need the score aggregated per group, and `bm25()` cannot be
    // aggregated: `min(bm25(…))`, the same expression in a subquery, and an ordinary CTE
    // all fail with "unable to use function bm25 in the requested context". Only
    // MATERIALIZED works — so it is load-bearing syntax, not a tidiness hint. FTS5's `rank`
    // column *does* aggregate, and carries the table's default weights, which would throw
    // away the 10× name weighting `relevance_puts_the_card_that_is_named_for_the_query_first`
    // exists to protect.
    let group_from = if ranked {
        format!(
            "(SELECT c.*, bm25(cards_fts, 10.0, 1.0, 1.0) AS score FROM {from_sql} \
              WHERE {where_sql}) c"
        )
    } else {
        from_sql.to_owned()
    };
    let group_where = if ranked { "1=1" } else { where_sql.as_str() };
    let group_fallback = if ranked {
        format!("min(c.score) ASC, {ORDER_NAME_COLLAPSED}")
    } else {
        ORDER_NAME_COLLAPSED.to_owned()
    };
    let group_order = crate::sorting::order_by(
        req.sort.as_deref(),
        SEARCH_SORTS_COLLAPSED,
        &group_fallback,
        &format!("{COLLAPSE_KEY} ASC"),
    );
    // When the sort lands after the join the group step must not take the limit, or it
    // would limit the wrong 50 groups.
    let group_limit = if sorts_after_join { "" } else { "LIMIT ? OFFSET ?" };
    let final_order = if sorts_after_join {
        format!("{order} LIMIT ? OFFSET ?")
    } else if ranked {
        "g.score ASC, g.nm ASC, c.id ASC".to_owned()
    } else {
        "g.nm ASC, c.id ASC".to_owned()
    };
```

The MATERIALIZED wrapper goes around the whole `WITH`:

```rust
        format!(
            "WITH m AS MATERIALIZED (SELECT * FROM {group_from} WHERE {group_where}),
                  g AS (
                SELECT {COLLAPSE_KEY} AS oid, count(*) AS printings,
                       min(c.price_usd) AS lo, max(c.price_usd) AS hi, min(c.name) AS nm,
                       {score_agg}
                       {COLLAPSE_REP} AS rep
                FROM m c
                GROUP BY {COLLAPSE_KEY}
                ORDER BY {group_order} {group_limit}
             )
             SELECT c.id, g.nm, c.set_code, c.set_name, c.collector_number, c.rarity,
                    c.type_line, c.mana_cost, c.price_usd, c.layout, c.oracle_id, c.finishes,
                    coalesce((SELECT sum(e.quantity) FROM collection_entries e
                               JOIN cards k ON k.id = e.card_id
                              WHERE k.oracle_id = c.oracle_id), 0),
                    EXISTS (SELECT 1 FROM wishlist_entries w
                             WHERE (w.oracle_id IS NOT NULL AND w.oracle_id = c.oracle_id)
                                OR w.card_id IN (SELECT id FROM cards
                                                  WHERE oracle_id = c.oracle_id)),
                    g.printings, g.lo, g.hi
             FROM g JOIN cards c ON c.id = g.rep
             ORDER BY {final_order}",
            score_agg = if ranked { "min(c.score) AS score," } else { "" },
        )
```

- [ ] **Step 5: Run to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml search::`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/search.rs
git commit -m "feat(search): sort and rank a collapsed search

Name and price are answered by the group step and take the limit before
the join. Set, rarity and type belong to the representative printing, so
they sort after it.

bm25() cannot be aggregated outside a MATERIALIZED CTE -- a plain CTE, a
subquery and min(bm25()) all raise 'unable to use function bm25 in the
requested context'."
```

---

### Task 5: Demote non-cards in relevance ranking

**Files:**
- Modify: `src-tauri/src/search.rs` — `run_search`'s relevance fallbacks

**Interfaces:**
- Consumes: Task 4's fallbacks.
- Produces: `NON_CARD_RANK`, applied to the relevance fallback in both modes.

- [ ] **Step 1: Write the failing test**

```rust
    /// `Lightning Bolt // Lightning Bolt` (`astx 76s`, layout `art_series`) outranks the
    /// real Lightning Bolt for the query "lightning bolt", because its name field contains
    /// the phrase twice and bm25 rewards that. Collapse does not fix it — art series carry
    /// their own `oracle_id` — so relevance demotes them instead. Nothing is hidden: the
    /// art card is still returned, below the card it depicts.
    #[test]
    fn art_cards_rank_below_the_card_they_depict() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,
                                oracle_id,search_text,raw)
             VALUES ('art','Lightning Bolt // Lightning Bolt','astx','76s','en','art_series',1,
                     'o-art','Lightning Bolt Lightning Bolt','{}')",
            [],
        )
        .unwrap();
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();

        for collapse in [None, Some(true)] {
            let r = run_search(
                &conn,
                &SearchRequest {
                    text: Some("lightning bolt".into()),
                    collapse,
                    limit: 50,
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(
                r.items[0].name, "Lightning Bolt",
                "the real card leads (collapse: {collapse:?})"
            );
            assert!(
                r.items.iter().any(|c| c.id == "art"),
                "and the art card is still returned, not hidden"
            );
        }
    }

    /// The demotion is on the relevance *fallback* only. An explicit sort is what the
    /// reader asked for, and name order puts an art card beside the card it depicts, which
    /// is where it belongs.
    #[test]
    fn an_explicit_sort_is_not_demoted() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,
                                oracle_id,search_text,raw)
             VALUES ('art','Aardvark Art','astx','1','en','art_series',1,'o-art',
                     'Aardvark Art','{}')",
            [],
        )
        .unwrap();
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();
        let r = run_search(
            &conn,
            &SearchRequest {
                sort: Some(vec![term("name", "asc")]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.items[0].id, "art", "alphabetical is alphabetical");
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml search::tests::art_cards`
Expected: FAIL — `the real card leads (collapse: None)`.

- [ ] **Step 3: Add the demotion**

After `ORDER_NAME_COLLAPSED`:

```rust
/// Layouts that are not a card anyone plays: art series and their front cards, tokens,
/// double-faced tokens, emblems.
///
/// A **ranking** term, never a filter. Every printing that matched is still returned, in
/// both modes; this only decides what a relevance-ranked page puts first.
const NON_CARD_LAYOUTS: &str =
    "('art_series','front_card','token','double_faced_token','emblem')";

/// 1 for a non-card, 0 for a card — the first term of the relevance fallback.
///
/// It exists because `Lightning Bolt // Lightning Bolt` (`astx 76s`, `art_series`) outranks
/// the real Lightning Bolt: its name field holds the phrase twice and bm25 rewards that.
/// Collapsing does not fix it — art series carry their own `oracle_id`, so they survive
/// grouping as their own rows. Measured 2026-08-11: the top five for "lightning bolt" went
/// from two art cards and three real ones, to five real ones, at **0.2 ms either way**.
///
/// Applied to the relevance fallback **only**. An explicit sort is what the reader asked
/// for, and name order already puts an art card beside the card it depicts.
const NON_CARD_RANK: &str = "(CASE WHEN c.layout IN ('art_series','front_card','token',\
                             'double_faced_token','emblem') THEN 1 ELSE 0 END) ASC";
```

In the uncollapsed `fallback`:

```rust
    let fallback = if ranked {
        format!("{NON_CARD_RANK}, bm25(cards_fts, 10.0, 1.0, 1.0) ASC, c.name ASC")
    } else {
        ORDER_NAME.to_owned()
    };
    let order = crate::sorting::order_by(req.sort.as_deref(), SEARCH_SORTS, &fallback, "c.id ASC");
```

In the collapsed `group_fallback` (Task 4), and its aggregate — a group never mixes the two kinds
(measured: 0 of 3,610 art/token-represented groups also contains a real printing), so `min` is exact:

```rust
    let group_fallback = if ranked {
        format!(
            "min(CASE WHEN c.layout IN {NON_CARD_LAYOUTS} THEN 1 ELSE 0 END) ASC, \
             min(c.score) ASC, {ORDER_NAME_COLLAPSED}"
        )
    } else {
        ORDER_NAME_COLLAPSED.to_owned()
    };
```

Add `min(CASE WHEN c.layout IN {NON_CARD_LAYOUTS} THEN 1 ELSE 0 END) AS nc,` to the group step's
select list when `ranked`, and make the ranked `final_order` `"g.nc ASC, g.score ASC, g.nm ASC, c.id ASC"`.

- [ ] **Step 4: Run to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml search::`
Expected: PASS. `relevance_puts_the_card_that_is_named_for_the_query_first` must still pass — its
fixture rows are all `layout='normal'`, so the new leading term is 0 for every one of them.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/search.rs
git commit -m "fix(search): rank art cards below the card they depict

'Lightning Bolt // Lightning Bolt' (astx 76s, art_series) outranked the
real Lightning Bolt -- its name field holds the phrase twice and bm25
rewards that. One term at the front of the relevance fallback, 0.2 ms.

A ranking term and not a filter: every printing is still returned, and an
explicit sort is left exactly as the reader asked for it."
```

---

### Task 6: The "All printings" toggle

**Files:**
- Modify: `src/features/search/useCardSearch.ts`
- Modify: `src/features/search/FilterBar.tsx`
- Modify: `src/features/search/useCardSearch.test.ts`
- Modify: `src/features/search/FilterBar.test.tsx`

**Interfaces:**
- Consumes: Task 2's `SearchRequest.collapse`.
- Produces: `useCardSearch()` returns `allPrintings: boolean` and `toggleAllPrintings: () => void`.

- [ ] **Step 1: Write the failing tests**

In `src/features/search/useCardSearch.test.ts`:

```ts
  it("collapses by default and asks the backend for it", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(searchCards).toHaveBeenCalled());
    expect(result.current.allPrintings).toBe(false);
    expect(searchCards.mock.calls[0][0]).toMatchObject({ collapse: true });
  });

  it("stops collapsing when all printings are asked for", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    await waitFor(() => expect(searchCards).toHaveBeenCalled());
    searchCards.mockClear();
    act(() => result.current.toggleAllPrintings());
    await waitFor(() => expect(searchCards).toHaveBeenCalled());
    // Absent rather than `false`: the backend's default is uncollapsed, and sending the
    // default would make the payload lie about intent.
    expect(searchCards.mock.calls[0][0].collapse).toBeUndefined();
  });

  /**
   * A view mode, not a filter. Reset all clears what you are *looking at*; it must not
   * also change whether you are looking at cards or at cardboard — the same reasoning that
   * keeps the sort out of it.
   */
  it("is not counted as a filter and survives Reset all", async () => {
    const { result } = renderHook(() => useCardSearch(), { wrapper });
    act(() => result.current.toggleAllPrintings());
    expect(result.current.activeCount).toBe(0);
    act(() => result.current.setText("bolt"));
    expect(result.current.activeCount).toBe(1);
    act(() => result.current.resetAll());
    expect(result.current.activeCount).toBe(0);
    expect(result.current.allPrintings).toBe(true);
  });
```

In `src/features/search/FilterBar.test.tsx`:

```tsx
  it("offers All printings, unpressed by default", async () => {
    renderBar();
    const chip = screen.getByRole("button", { name: /all printings/i });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/features/search/useCardSearch.test.ts src/features/search/FilterBar.test.tsx`
Expected: FAIL — `result.current.allPrintings` is `undefined`.

- [ ] **Step 3: Add the state**

In `src/features/search/useCardSearch.ts`, beside the `sort` state:

```ts
  // Not a filter, and deliberately outside `resetAll` for the same reason the sort is:
  // clearing what you are looking at should not also change *how* you are looking at it.
  // The search shows one row per card by default — 37,553 cards rather than 107,337
  // printings — because "which cards exist" is the question a search box is asked, and
  // "which printings exist" is the question the card pane answers.
  const [allPrintings, setAllPrintings] = useState(false);
```

Add to the query key, after the `owned` segment:

```ts
    allPrintings ? "all" : "collapsed",
```

Add to the `ipc.searchCards` payload, after `sort:`:

```ts
        // Absent rather than `false` when all printings are asked for: uncollapsed is the
        // backend's own default, and sending it would make the payload lie about intent —
        // the same rule `paperOnly` follows.
        collapse: allPrintings ? undefined : true,
```

Add to the returned object:

```ts
    /**
     * Show every printing rather than one row per card. `false` — one row per card — is the
     * default, and the toggle is the way back to the printings.
     */
    allPrintings,
    toggleAllPrintings: () => setAllPrintings((on) => !on),
```

- [ ] **Step 4: Add the chip**

In `src/features/search/FilterBar.tsx`, between `<ResetAll …/>` and `{layoutToggle && <ViewToggle />}`:

```tsx
      {/* A view mode rather than a filter, so it sits with the layout toggle at the end of
          the row rather than with the statements about which cards to show. The search
          answers "which cards exist"; this is the way through to "which printings". */}
      <ToggleChip
        label="All printings"
        pressed={search.allPrintings}
        onClick={search.toggleAllPrintings}
      />
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/features/search`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/search/useCardSearch.ts src/features/search/FilterBar.tsx src/features/search/useCardSearch.test.ts src/features/search/FilterBar.test.tsx
git commit -m "feat(search): show one row per card, with a way back to the printings

A view mode and not a filter: it stays out of activeFilterCount and out
of Reset all, the same as the sort."
```

---

### Task 7: Render the printing count and the price range

**Files:**
- Modify: `src/features/search/SearchPage.tsx` — the `name` and `price` columns
- Modify: `src/features/search/CardGrid.tsx` — a `topLeft` slot
- Create: `src/lib/priceRange.ts` + `src/lib/priceRange.test.ts`
- Modify: `src/features/search/SearchPage.test.tsx`

**Interfaces:**
- Consumes: Task 2's `printings`, `priceLow`, `priceHigh`.
- Produces: `priceRange(low: number | null, high: number | null): string` in
  `src/lib/priceRange.ts`; `CardGrid` accepts `topLeft?: (card: T) => ReactNode`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/priceRange.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { priceRange } from "./priceRange";

describe("priceRange", () => {
  it("renders a range when the ends differ", () => {
    expect(priceRange(0.75, 4200)).toBe("$0.75–$4,200.00");
  });

  /** Most cards have one printing, and `$2.15–$2.15` is noise, not information. */
  it("renders one price when the ends agree", () => {
    expect(priceRange(2.15, 2.15)).toBe("$2.15");
  });

  /** `usdPrice` never invents `$0.00`, and neither does this. */
  it("is an em dash when nothing is priced", () => {
    expect(priceRange(null, null)).toBe("—");
  });

  /**
   * A group where only some printings are priced. The known end is shown and the unknown
   * one is not invented — a range starting at an em dash reads as "from unknown", which is
   * the truth.
   */
  it("shows the end it knows", () => {
    expect(priceRange(null, 9)).toBe("—–$9.00");
    expect(priceRange(9, null)).toBe("$9.00–—");
  });
});
```

Add to `src/features/search/SearchPage.test.tsx`:

```tsx
  it("says how many printings a collapsed row stands for, and prices across them", async () => {
    searchCards.mockResolvedValue({
      items: [
        {
          ...summary,
          name: "Sol Ring",
          printings: 132,
          priceUsd: 2.15,
          priceLow: 0.75,
          priceHigh: 4200,
        },
      ],
      total: 1,
      totalIsCapped: false,
    });
    renderPage();
    await screen.findByText("Sol Ring");
    expect(screen.getByText("×132 printings")).toBeInTheDocument();
    expect(screen.getByText("$0.75–$4,200.00")).toBeInTheDocument();
  });

  it("says nothing about printings when a row is one printing", async () => {
    searchCards.mockResolvedValue({
      items: [{ ...summary, printings: 1, priceUsd: 2.15, priceLow: 2.15, priceHigh: 2.15 }],
      total: 1,
      totalIsCapped: false,
    });
    renderPage();
    await screen.findByText(summary.name);
    expect(screen.queryByText(/printings/)).not.toBeInTheDocument();
    expect(screen.getByText("$2.15")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/priceRange.test.ts src/features/search/SearchPage.test.tsx`
Expected: FAIL — `Cannot find module './priceRange'`.

- [ ] **Step 3: Write `priceRange`**

Create `src/lib/priceRange.ts`:

```ts
import { usdPrice } from "./prices";

/**
 * What a collapsed row's Price cell says: the spread across the printings it stands for.
 *
 * Equal ends collapse to one price rather than repeating it — most cards have one printing,
 * and `$2.15–$2.15` is noise. A missing end stays missing: `usdPrice` never invents
 * `$0.00`, and a range that quoted a price nobody quoted would be worse than a half-open
 * one.
 */
export function priceRange(low: number | null, high: number | null): string {
  if (low === null && high === null) return "—";
  if (low === high) return usdPrice(low);
  return `${usdPrice(low)}–${usdPrice(high)}`;
}
```

- [ ] **Step 4: Render it**

In `src/features/search/SearchPage.tsx`, the `name` column's `cell`, after the `<OwnedBadge …/>`:

```tsx
        {/* What a collapsed row stands for. Drawn only when it stands for more than one —
            "×1 printings" on 17 000 of 37 553 cards would be a column of noise. */}
        {card.printings > 1 && (
          <span className="shrink-0 text-xs text-dim">×{card.printings} printings</span>
        )}
```

The `price` column's `cell` becomes:

```tsx
    cell: (card) => priceRange(card.priceLow, card.priceHigh),
```

with `import { priceRange } from "@/lib/priceRange";` added.

In `src/features/search/CardGrid.tsx`, add the prop to `CardGrid` and to `Tile`:

```tsx
  /**
   * A mark over the art's **top-left** corner — the search's printing count.
   *
   * Its own slot rather than a second `badge`, because the three corners of a tile each
   * have one owner and drift is what happens when they do not: bottom-left is the
   * owned/wishlist badge, top-right the foil chip, top-left this.
   */
  topLeft?: (card: T) => ReactNode;
```

Threaded through to `Tile` and drawn beside the existing `mark`, sharing its rules — the same
backing, the same `pointer-events-none`, the same `empty:hidden`:

```tsx
      {topLeftMark && (
        <span className="pointer-events-none absolute top-1 left-1 rounded bg-bg/85 px-1.5 py-0.5 text-[0.7rem] text-dim empty:hidden">
          {topLeftMark}
        </span>
      )}
```

And in `SearchPage.tsx`'s `<CardGrid …>`:

```tsx
            topLeft={(card) => (card.printings > 1 ? <>×{card.printings}</> : null)}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/lib src/features/search`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/priceRange.ts src/lib/priceRange.test.ts src/features/search/
git commit -m "feat(search): show what a collapsed row stands for

A printing count and a price range, both drawn only when the row stands
for more than one printing."
```

---

### Task 8: Extract `CardArt` (pure refactor, no foil yet)

**Files:**
- Create: `src/components/CardArt.tsx`, `src/components/CardArt.test.tsx`
- Modify: `src/features/search/CardGrid.tsx` — `Tile` uses `CardArt`

**Interfaces:**
- Consumes: `CardImage`, `useImageRetry`, `cardImageUrl`, `CARD_ASPECT`.
- Produces:

```tsx
export function CardArt(props: {
  cardId: string | null;   // null draws the fallback and fetches nothing (an orphan)
  name: string;
  face?: number;           // default 0
  variant?: ImageVariant;  // default "grid"
  selected?: boolean;
  className?: string;
}): ReactNode
```

- [ ] **Step 1: Write the failing test**

Create `src/components/CardArt.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CardArt } from "./CardArt";

describe("CardArt", () => {
  it("draws the card's art, named by the card", () => {
    render(<CardArt cardId="bolt" name="Lightning Bolt" />);
    expect(screen.getByRole("img", { name: "Lightning Bolt" })).toBeInTheDocument();
  });

  /**
   * The whole reason `CardImage` exists, kept true through the extraction: a frame belongs
   * to a *slot*, so React hands one element a different card, and a browser keeps painting
   * the last decoded frame until the new `src` decodes. A new card must be a new element.
   */
  it("is a new element when it is a new card", () => {
    const { rerender } = render(<CardArt cardId="bolt" name="Lightning Bolt" />);
    const first = screen.getByRole("img");
    rerender(<CardArt cardId="shock" name="Shock" />);
    expect(screen.getByRole("img")).not.toBe(first);
  });

  /** An orphan has no printing to fetch. It is still a card, and its name is still known. */
  it("draws the name and fetches nothing when there is no card id", () => {
    render(<CardArt cardId={null} name="Lightning Bolt" />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/CardArt.test.tsx`
Expected: FAIL — `Cannot find module './CardArt'`.

- [ ] **Step 3: Write `CardArt`**

Create `src/components/CardArt.tsx`, moving the frame, the retry hook, the `<CardImage>` call and the
no-art fallback out of `CardGrid`'s `Tile` **verbatim** — same classes, same `alt`, same
`draggable={false}`, same `decoding="async"`, same hover scale. Doc comment:

```tsx
/**
 * One card's art in its 5:7 frame — the picture, its retry, and what is drawn when there is
 * no picture.
 *
 * Extracted from `CardGrid`'s tile because five surfaces draw a card and each had rebuilt
 * some of this: the wall's tiles, the pane's main art, the pane's printings rows, the deck
 * editor's zone rows and `PrintingPreview`. Four of them agreed on the aspect ratio and
 * disagreed about everything else, which is how a foil marking would have ended up existing
 * in four slightly different versions.
 *
 * `CardImage` stays underneath and does the one thing it has always done — key the `<img>`
 * on its URL, so a slot handed a new card paints nothing rather than the last card's art.
 * This component is the frame around it and the state machine beside it.
 */
```

- [ ] **Step 4: Use it from `Tile`**

`Tile` keeps the button, the ring, the caption and the corner marks; its art becomes:

```tsx
          <CardArt cardId={card.id} name={card.name} selected={selected} />
```

Delete the now-unused `useImageRetry`, `cardImageUrl`, `CARD_ASPECT` and `CardImage` imports from
`CardGrid.tsx`.

- [ ] **Step 5: Run the whole suite to verify nothing changed**

Run: `npm run test:run`
Expected: PASS, including `CardGrid.test.tsx` and the two integration tests that assert element
identity — the extraction must not change behaviour.

- [ ] **Step 6: Commit**

```bash
git add src/components/CardArt.tsx src/components/CardArt.test.tsx src/features/search/CardGrid.tsx
git commit -m "refactor(cards): extract the card frame into CardArt

No behaviour change. Five surfaces draw a card and each had rebuilt some
of the frame, the retry and the no-art fallback; the foil marking needs
one place to live."
```

---

### Task 9: The foil treatment

**Files:**
- Modify: `src/lib/finish.ts` — add `soleFinish`
- Modify: `src/lib/finish.test.ts`
- Modify: `src/components/CardArt.tsx`, `src/components/CardArt.test.tsx`
- Modify: `src/features/search/SearchPage.tsx`, `src/features/search/CardGrid.tsx`
- Modify: `src/features/card/CardDetailPane.tsx`, `src/features/decks/ZoneColumn.tsx`

**Interfaces:**
- Consumes: Task 8's `CardArt`.
- Produces: `soleFinish(finishesJson: string | null): Finish | null`; `CardArt` accepts
  `finish?: Finish | null`; `CardGrid` accepts `finish?: (card: T) => Finish | null`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/finish.test.ts`:

```ts
describe("soleFinish", () => {
  /**
   * The mark says what the object *is*, never what it could have been. A printing sold in
   * both finishes is a choice the buyer makes, not a property of the cardboard in a search
   * result — and 53,224 of the corpus's 107,337 paper printings have a foil version, so
   * marking those would put a sheen on 61% of every wall.
   */
  it("is the finish when there is no choice", () => {
    expect(soleFinish('["foil"]')).toBe("foil");
    expect(soleFinish('["etched"]')).toBe("etched");
  });

  it("is null when the printing offers a choice, or says nothing", () => {
    expect(soleFinish('["nonfoil","foil"]')).toBeNull();
    expect(soleFinish('["nonfoil"]')).toBeNull();
    expect(soleFinish(null)).toBeNull();
    expect(soleFinish("not json")).toBeNull();
  });
});
```

In `src/components/CardArt.test.tsx`:

```tsx
  it("lays a sheen over a foil card, and hides it from screen readers", () => {
    const { container } = render(<CardArt cardId="unf" name="Sole Performer" finish="foil" />);
    const sheen = container.querySelector("[data-foil-sheen]");
    expect(sheen).toBeInTheDocument();
    expect(sheen).toHaveAttribute("aria-hidden", "true");
    // The chip is what *says* foil; the sheen is what looks foil. Neither does the other's
    // job, and only one of them is information.
    expect(screen.getByLabelText("Foil")).toBeInTheDocument();
  });

  it("draws no sheen for a card that is not foil", () => {
    const { container } = render(<CardArt cardId="bolt" name="Lightning Bolt" />);
    expect(container.querySelector("[data-foil-sheen]")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/finish.test.ts src/components/CardArt.test.tsx`
Expected: FAIL — `soleFinish is not a function`.

- [ ] **Step 3: Add `soleFinish`**

In `src/lib/finish.ts`:

```ts
/**
 * The finish a printing leaves no choice about, or `null`.
 *
 * What a foil marking on card art is drawn from: 12,366 paper printings exist only in foil
 * and 892 only in etched, and nothing in the app said so. A printing sold in both is not
 * marked — the mark states what the object *is*, and 53,224 printings have a foil version.
 */
export function soleFinish(json: string | null): Finish | null {
  const finishes = parseFinishes(json);
  if (finishes.length !== 1) return null;
  return finishes[0] === "nonfoil" ? null : finishes[0];
}
```

- [ ] **Step 4: Add the treatment to `CardArt`**

Add `finish?: Finish | null` to the props and, inside the frame, after the image:

```tsx
      {finish && (
        <>
          {/* Tints the art, never covers it: `overlay` at 12% keeps every pixel legible,
              which is the whole requirement. `aria-hidden` because the chip beside it
              already says the word, and a screen reader does not need it twice. */}
          <span
            data-foil-sheen
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.12] mix-blend-overlay"
            style={{
              backgroundImage:
                "linear-gradient(115deg, #ff5f6d 0%, #ffc371 20%, #47e5bc 40%, " +
                "#3b8beb 60%, #a95fe8 80%, #ff5f6d 100%)",
            }}
          />
          <span className="pointer-events-none absolute top-1 right-1 rounded bg-bg/85 px-1 py-0.5">
            <FinishMark finish={finish} />
          </span>
        </>
      )}
```

The frame's wrapper needs `relative` for those two to anchor to.

- [ ] **Step 5: Feed it from the four surfaces**

`CardGrid` gains `finish?: (card: T) => Finish | null` and passes its result to `CardArt`.
`SearchPage` passes `finish={(card) => soleFinish(card.finishes)}` to `CardGrid`, and the table
gains the same mark in its Name cell. `CardDetailPane`'s printings rows and `ZoneColumn`'s deck-row
thumbnails pass `finish={soleFinish(printing.finishes)}` / `finish={soleFinish(card.finishes)}`.

- [ ] **Step 6: Run to verify they pass**

Run: `npm run test:run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/finish.ts src/lib/finish.test.ts src/components/CardArt.tsx src/components/CardArt.test.tsx src/features/
git commit -m "feat(cards): mark foil printings on the art

A holo sheen at 12% in overlay blend, which tints and never covers, plus
a chip that carries the word. The mark says what the object is: only the
12,366 foil-only and 892 etched-only printings, never the 53,224 that
merely have a foil version."
```

---

### Task 10: The finish glyph

**Files:**
- Create: `src/components/FinishMark.tsx`, `src/components/FinishMark.test.tsx`
- Modify: `src/lib/finish.ts` — remove `FINISH_MARK`
- Modify: `src/features/card/CardDetailPane.tsx`, `src/features/collection/CollectionTable.tsx`

**Interfaces:**
- Consumes: `FINISH_LABEL`, `Finish`.
- Produces: `<FinishMark finish={f} />` — an accent-tinted glyph with an accessible name.

- [ ] **Step 1: Write the failing test**

Create `src/components/FinishMark.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FinishMark } from "./FinishMark";

describe("FinishMark", () => {
  it("names the finish it marks", () => {
    render(<FinishMark finish="foil" />);
    expect(screen.getByLabelText("Foil")).toBeInTheDocument();
  });

  it("gives etched its own glyph", () => {
    const { container: foil } = render(<FinishMark finish="foil" />);
    const { container: etched } = render(<FinishMark finish="etched" />);
    expect(foil.innerHTML).not.toBe(etched.innerHTML);
  });

  /** Nonfoil is the finish a price is assumed to be, so it is unmarked. */
  it("draws nothing for nonfoil", () => {
    const { container } = render(<FinishMark finish="nonfoil" />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/FinishMark.test.tsx`
Expected: FAIL — `Cannot find module './FinishMark'`.

- [ ] **Step 3: Write it**

Create `src/components/FinishMark.tsx` using `Sparkles` and `Gem` from `lucide-react`:

```tsx
/**
 * A finish, where there is no room for the word.
 *
 * Replaces the letters `F` and `E`. A solid accent tint and **not** a gradient: these render
 * at 10px, where a gradient is not perceivable and costs an id-collision problem for
 * nothing. The gradient lives where it has area to work in, which is `CardArt`'s sheen.
 *
 * Nonfoil draws nothing — it is the finish a price is assumed to be, which is the rule the
 * `FINISH_MARK` table stated before this component replaced it.
 */
export function FinishMark({ finish, className }: { finish: Finish; className?: string }) {
  if (finish === "nonfoil") return null;
  const Icon = finish === "foil" ? Sparkles : Gem;
  return (
    <Icon
      role="img"
      aria-label={FINISH_LABEL[finish]}
      className={cn("inline-block size-3 shrink-0 text-accent", className)}
    />
  );
}
```

- [ ] **Step 4: Adopt it and delete `FINISH_MARK`**

In `CardDetailPane.tsx` the per-finish price line becomes:

```tsx
        {parseFinishes(printing.finishes).map((f) => (
          <span key={f} className="flex shrink-0 items-center gap-0.5 font-mono tabular-nums">
            <FinishMark finish={f} />
            {usdPrice(finishPrice(printing.prices, f))}
          </span>
        ))}
```

Remove `FINISH_MARK` from `src/lib/finish.ts` and from every import. `CollectionTable`'s finish
column draws `<FinishMark finish={row.finish} />` beside the word it already shows.

- [ ] **Step 5: Run to verify they pass**

Run: `npm run test:run`
Expected: PASS. Any test asserting the literal `"F"` must be updated to assert the accessible name.

- [ ] **Step 6: Commit**

```bash
git add src/components/FinishMark.tsx src/components/FinishMark.test.tsx src/lib/finish.ts src/features/
git commit -m "feat(cards): mark a foil price with a glyph instead of the letter F

Solid accent tint rather than a gradient: at 10px a gradient is not
perceivable. The full word stays in the accessible name and the tooltip."
```

---

### Task 11: Stories, the live pass, and CLAUDE.md

**Files:**
- Create: `src/components/CardArt.stories.tsx`
- Modify: `src/features/search/SearchPage.stories.tsx`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing further depends on this.

- [ ] **Step 1: Write the stories**

`CardArt.stories.tsx` with `Nonfoil`, `FoilOnly`, `EtchedOnly` and `NoArt`, each `autodocs`, using
`.storybook/fake/fixtures.ts`'s `printing()`. A `SearchPage` story per mode: `Collapsed` (default)
and `AllPrintings`, the second with a `play` that presses the chip and waits for the count to change.

- [ ] **Step 2: Run the story runner**

Run: `npx vitest run src/stories.test.tsx && npm run build-storybook`
Expected: PASS, and the static site builds.

- [ ] **Step 3: Drive the real window**

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
npm run tauri dev
```

Then, from another shell — reading `innerWidth`/`innerHeight` first, because
`clearDeviceMetricsOverride` restores nothing:

```
node scripts/cdp.mjs console out.jsonl        # leave attached; check the line count after
node scripts/cdp.mjs eval "[innerWidth, innerHeight]"
node scripts/cdp.mjs shot collapsed.png
node scripts/cdp.mjs text "All printings"
node scripts/cdp.mjs shot all-printings.png
node scripts/cdp.mjs type "sol ring"
node scripts/cdp.mjs shot foil.png
node scripts/cdp.mjs media prefers-reduced-motion reduce "getComputedStyle(document.querySelector('[data-foil-sheen]').parentElement).transitionProperty"
node scripts/cdp.mjs size 1280 800
```

Confirm by eye on the screenshots: the sheen tints without obscuring rules text at both tile widths,
the printing count and the price range read correctly, and the glyph is legible at 10px. Probe
`transitionProperty` and **never** `transitionDuration` — Tailwind's `transition-none` leaves the
duration alone, so reading the duration reports `0.15s` on a control that is correctly still.

- [ ] **Step 4: Record what was measured in CLAUDE.md**

Under **Data & sync**, replace the sorting paragraph's figures with the collapsed ones and add: the
group key's null-safety cost (108 ms against 38 ms), the primary-key join back, the status
subqueries' 1,514 ms / 12,729 ms trap, the `bm25`-cannot-be-aggregated rule and its
`MATERIALIZED` fix, and `idx_cards_collapse`'s place in `CARDS_INDEXES`. Under **Frontend design**,
add `CardArt` as the one place a card frame is built and the foil rule (`soleFinish` — the mark
states what the object is).

- [ ] **Step 5: Verify and commit**

Run: `npm run verify`
Expected: PASS — build, lint, Vitest and `cargo test`.

```bash
git add src/components/CardArt.stories.tsx src/features/search/SearchPage.stories.tsx CLAUDE.md
git commit -m "docs: record what the card search work measured

Storybook covers the three finishes and both search modes; CLAUDE.md
carries the collapse timings, the bm25 aggregation rule and the status
subquery trap."
```

---

## Self-Review

**Spec coverage.** §1 collapse → Tasks 1–4, 6, 7. §1 foil on art → Tasks 8, 9. §1 glyph → Task 10.
§1/§5 demotion → Task 5. §2.1 null-safe key → Task 3 (`printings_with_no_oracle_id_are_each_their_own_card`).
§3.3 `MATERIALIZED` → Task 4. §3.4 filter semantics → Task 3. §3.5 sorts → Task 4. §3.6 wire shape →
Task 2. §4 frontend → Tasks 6, 7. §6 extraction → Task 8. §7 glyph → Task 10. §8 verification →
spread across every task, with the live pass in Task 11. No gaps.

**Type consistency.** `collapse` is the request field in Rust, TypeScript and every test.
`printings`/`priceLow`/`priceHigh` are spelled the same in the DTO, the mirror, `priceRange` and the
render tests. `soleFinish` returns `Finish | null` in its definition, in `CardArt`'s prop and at all
four call sites. `COLLAPSE_KEY`, `COLLAPSE_REP`, `ORDER_NAME_COLLAPSED`, `NON_CARD_LAYOUTS`,
`NON_CARD_RANK`, `SEARCH_SORTS_COLLAPSED` and `REPRESENTATIVE_SORTS` are each defined once (Tasks 3–5)
and referenced by those names afterwards.

**Ordering risk.** Task 3 changes the page `SELECT`'s column count, and Task 4 rewrites the same
`format!`. They are sequential and Task 4's version is written out in full, so there is no merge to
reason about.
