# Search Faceting — Plan A: the card index and faceted filters

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Filter options on the card search page grey out when choosing them would not change the result set, backed by an in-memory index that answers any facet pass in under 60 ms.

**Architecture:** A new `legal_mask` column turns 23 JSON legality keys into one integer, which both unlocks the format facet and lets `idx_cards_collapse` cover every filter the search offers. A `CardIndex` built on a background thread holds bitsets for the low-cardinality dimensions and a `u16` ordinal array for the 986 set codes; a `facet_cards` command counts against it. The frontend greys options whose count is zero, and fails open whenever the index is cold.

**Tech Stack:** Rust (rusqlite, serde, Tauri 2.11), TypeScript 6 / React 19, TanStack Query, Vitest, Storybook 9.

**Spec:** `docs/superpowers/specs/2026-08-11-search-filter-faceting-design.md`

> **Renumbered on merge: this plan's schema step shipped as v9, not v8.** Everything below
> says "v8" because that is what it was when it was written — `main` was at v7 and the next
> number was free. While this branch was building, `main` landed the deckbuilder rebuild and
> took v8 for a different change (`deck_cards.zone` → `deck_cards.category_id`). Both were
> v8 and they meant different things, so the merge kept `main`'s v8 untouched and moved this
> plan's step to **v9**: `if v < 9`, `PRAGMA user_version = 9`, `SCHEMA_VERSION = 9`, and the
> tests and fixtures renamed to match (`v8_database` is now the "one version below head"
> fixture, `the_v9_backfill_…`, `the_v9_step_replaces_…`, `the_schema_version_is_nine`).
>
> Read every "v8" in the tasks below as "v9", and every "a database that stopped at v7" as
> "at v8". Task 2's invariant — **only the newest migration step may create from
> `CARDS_INDEXES`** — survived the renumber unchanged, because `main`'s v8 touches only the
> deck tables and so neither needs the list nor takes the title of newest creator.
> `schema::tests::every_version_ends_with_the_same_schema_as_a_fresh_install`, added by the
> merge, is what now holds that invariant to account.

## Global Constraints

- **`CARDS_COLUMNS` is frozen.** A new column is a new `if v < N` block with `ALTER TABLE`, never an edit to that constant. `create_staging` derives staging's layout from `PRAGMA table_info(cards)`, so staging follows automatically.
- **Every index on `cards` lives in `schema::CARDS_INDEXES`.** `swap_staging` drops `cards` with its indexes and replays only that list.
- **`cards` is dropped and recreated on every sync.** Nothing may declare `REFERENCES cards(...)`.
- **`raw` is a gzip BLOB.** Any migration reading it goes through `schema::json_raw`. **This plan never reads `raw`** — `legalities` is its own plain-TEXT column.
- **No `cards_fts` rebuild is owed** by this plan: nothing here touches `name`/`type_line`/`search_text` and no rowid is renumbered.
- **Reads go through `AppState.db_read`; writes through `AppState.db`** via `db::lock_for(…, WRITE_LOCK_WAIT)`. The index build uses **its own third read-only connection** — a ~0.5 s read holding `db_read` would stall searches at launch.
- **Dim text is `text-dim`, never `text-muted`.** Z-indexes come from `LAYER` in `src/lib/layers.ts`.
- **`npm run verify` before every commit** (build + lint + Vitest + cargo test).
- Commit messages use `feat:`/`fix:`/`chore:`/`test:`/`docs:` and end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

**Create:**
- `src-tauri/src/legalities.rs` — the frozen key list, `legal_mask()`, and the SQL expression the migration backfills with. One responsibility: the mapping between Scryfall's `legalities` object and one integer. Used by `card_row`, `schema` and `index`.
- `src-tauri/src/index/mod.rs` — `CardIndex`, its build, and the public read API.
- `src-tauri/src/index/bitset.rs` — a fixed-size bitset over `cards.rowid`.
- `src-tauri/src/index/facets.rs` — `FacetResponse` and the counting, including the exclude-own-dimension rule.
- `src-tauri/src/index/lifecycle.rs` — when the index is built, rebuilt and invalidated.
- `src/features/search/useCardFacets.ts` — the query hook.
- `src/features/search/facets.ts` — the greying rule as pure functions, so it is testable without React.

**Modify:**
- `src-tauri/src/card_row.rs` — `CardRow` gains `legal_mask`.
- `src-tauri/src/ingest.rs:224` (`STAGING_INSERT`) and `:170` (`write_batch`) — one more column.
- `src-tauri/src/schema.rs:87` (`CARDS_INDEXES`), `:164` (`SCHEMA_VERSION`), and the end of `migrate` — the v8 step.
- `src-tauri/src/sync.rs:80` (`AppState`) — the index handle.
- `src-tauri/src/lib.rs:182` — command registration.
- `src/lib/ipc.ts` — the hand-written mirror.
- `src/components/FilterChips.tsx` — `ManaChip`, `ManaValueChips`, `ToggleChip` gain a disabled state.
- `src/features/search/FilterBar.tsx`, `SetCombobox.tsx`, `useCardSearch.ts`.
- `.storybook/fake/db.ts` — a `facet_cards` handler.

---

### Task 1: `legal_mask` — the frozen key list

**Files:**
- Create: `src-tauri/src/legalities.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod legalities;` beside the other module declarations)

**Interfaces:**
- Produces: `legalities::LEGALITY_KEYS: [&str; 23]`, `legalities::legal_mask(&serde_json::Value) -> u64`, `legalities::bit(key: &str) -> Option<u64>`, `legalities::mask_sql(column: &str) -> String`.

> **Amended after review, 2026-08-11.** The two tests below as first written did not pin what
> their names and comments claimed, and the reviewer proved it by running them against broken
> implementations: `the_sql_expression_names_every_key_once` passed against a **fully reversed**
> key→bit mapping, because it checked that each key and each bit appeared *somewhere* in the
> string rather than in the *same term*; and `the_key_order_is_frozen` sampled four of
> twenty-three positions, so most reorders passed. Both were strengthened — per-term assertions,
> and the whole array asserted at once — along with three related fixes: `mask_sql` builds its
> `IN (…)` list from `PLAYABLE` rather than hand-writing the same pair a second time, the key
> list is asserted duplicate-free (the one input where the Rust and SQL mappings genuinely
> disagree), and `mask_sql`'s doc names `cards.legalities` and rules out `cards.raw`, which is a
> gzip BLOB whose `json_extract` failure is invisible to tests. **The code blocks below are the
> original text; the shipped tests are stronger.** See the ledger and `git log` for the fix.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/legalities.rs` with only the tests and empty stubs:

```rust
//! Scryfall's `legalities` object as one integer.
//!
//! 23 keys today and the list grows, so the format filter used to cost a `json_extract`
//! per key per row: 695 ms for one facet pass over the live 107 337-row paper corpus
//! against 16.8 ms for the mask (measured 2026-08-11). It is also what lets the format
//! filter into an index at all — a JSON path cannot be indexed, a bitwise test on a column
//! can.
//!
//! **The key order is frozen.** Bit positions are stored data: `cards.legal_mask` holds
//! them, so reordering this list silently reinterprets every row already on disk. Keys may
//! only ever be **appended**. A key Scryfall removes keeps its bit and stops being set; a
//! key Scryfall adds sets no bit until it is appended here and a sync has run.

use serde_json::Value;

/// Every `legalities` key, in the order Scryfall emits them. **Append only** — see the
/// module docs. Bit *k* of a mask is `LEGALITY_KEYS[k]`.
pub const LEGALITY_KEYS: [&str; 23] = [
    "alchemy", "brawl", "commander", "competitivebrawl", "duel", "future", "gladiator",
    "historic", "legacy", "modern", "oathbreaker", "oldschool", "pauper", "paupercommander",
    "penny", "pioneer", "predh", "premodern", "standard", "standardbrawl", "timeless", "tlr",
    "vintage",
];

/// The values that count as playable. `restricted` is playable — a Vintage search that hid
/// Black Lotus would be wrong.
const PLAYABLE: [&str; 2] = ["legal", "restricted"];

pub fn bit(key: &str) -> Option<u64> {
    todo!()
}

pub fn legal_mask(legalities: &Value) -> u64 {
    todo!()
}

pub fn mask_sql(column: &str) -> String {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The list is append-only because bit positions are on disk. This test is the fence:
    /// it fails on a reorder, a removal, or an insertion anywhere but the end.
    #[test]
    fn the_key_order_is_frozen() {
        assert_eq!(LEGALITY_KEYS[0], "alchemy");
        assert_eq!(LEGALITY_KEYS[9], "modern");
        assert_eq!(LEGALITY_KEYS[18], "standard");
        assert_eq!(LEGALITY_KEYS[22], "vintage");
        assert_eq!(LEGALITY_KEYS.len(), 23, "keys are appended, never inserted");
    }

    /// 64 bits is the ceiling, and it is not a soft one: a 65th key would silently set no
    /// bit. Scryfall is at 23.
    #[test]
    fn the_key_list_fits_in_a_u64() {
        assert!(LEGALITY_KEYS.len() <= 64);
    }

    #[test]
    fn restricted_counts_as_playable_and_the_rest_do_not() {
        let v = serde_json::json!({
            "vintage": "restricted",
            "modern": "legal",
            "standard": "not_legal",
            "pauper": "banned",
        });
        let m = legal_mask(&v);
        assert_ne!(m & bit("vintage").unwrap(), 0, "restricted is playable");
        assert_ne!(m & bit("modern").unwrap(), 0);
        assert_eq!(m & bit("standard").unwrap(), 0);
        assert_eq!(m & bit("pauper").unwrap(), 0, "banned is not playable");
        assert_eq!(m & bit("commander").unwrap(), 0, "a key that is absent sets no bit");
    }

    /// A key Scryfall invents before this list knows about it must be ignored, not panic
    /// and not shift anything.
    #[test]
    fn an_unknown_key_is_ignored() {
        assert_eq!(bit("mtg_grimoire_invented_format"), None);
        let m = legal_mask(&serde_json::json!({ "somethingnew": "legal" }));
        assert_eq!(m, 0);
    }

    #[test]
    fn a_missing_or_malformed_legalities_object_is_zero() {
        assert_eq!(legal_mask(&Value::Null), 0);
        assert_eq!(legal_mask(&serde_json::json!("not an object")), 0);
    }

    /// The migration backfills through this expression, so it has to agree with the Rust
    /// mapping key for key. Both are generated from the one constant; this pins that they
    /// are.
    #[test]
    fn the_sql_expression_names_every_key_once() {
        let sql = mask_sql("legalities");
        for (k, key) in LEGALITY_KEYS.iter().enumerate() {
            assert!(sql.contains(&format!("'$.{key}'")), "{key} missing from the SQL");
            assert!(sql.contains(&format!("{}", 1u64 << k)), "bit for {key} missing");
        }
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test legalities`
Expected: FAIL — `not yet implemented` panics from the `todo!()`s.

- [ ] **Step 3: Implement**

Replace the three `todo!()` bodies:

```rust
/// The bit for one key, or `None` when this build has never heard of it.
pub fn bit(key: &str) -> Option<u64> {
    LEGALITY_KEYS.iter().position(|k| *k == key).map(|i| 1u64 << i)
}

/// The mask for one card's `legalities` object. Anything that is not an object of known
/// keys with playable values contributes nothing — there is no error case, because a card
/// with no legalities is legal nowhere and that is a fact rather than a failure.
pub fn legal_mask(legalities: &Value) -> u64 {
    let Some(obj) = legalities.as_object() else {
        return 0;
    };
    obj.iter()
        .filter(|(_, v)| v.as_str().is_some_and(|s| PLAYABLE.contains(&s)))
        .filter_map(|(k, _)| bit(k))
        .fold(0, |m, b| m | b)
}

/// The same mapping as an SQL expression over a column holding the JSON text, for the one
/// caller that cannot run Rust per row: the v8 backfill.
///
/// Generated from [`LEGALITY_KEYS`] rather than written out, so the two cannot drift.
/// `column` is an identifier this crate supplies and never user text.
pub fn mask_sql(column: &str) -> String {
    let terms: Vec<String> = LEGALITY_KEYS
        .iter()
        .enumerate()
        .map(|(i, key)| {
            format!(
                "(CASE WHEN json_extract({column}, '$.{key}') IN ('legal','restricted') \
                 THEN {} ELSE 0 END)",
                1u64 << i
            )
        })
        .collect();
    terms.join(" + ")
}
```

Add `mod legalities;` to `src-tauri/src/lib.rs` beside the other `mod` declarations.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test legalities`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/legalities.rs src-tauri/src/lib.rs
git commit -m "feat(search): map Scryfall legalities onto one frozen bitmask"
```

---

### Task 2: Schema v8 — the column, the backfill, the widened index

**Files:**
- Modify: `src-tauri/src/schema.rs` (`CARDS_INDEXES` at :87, `SCHEMA_VERSION` at :164, the end of `migrate` after the `v < 7` block)
- Modify: `src-tauri/src/card_row.rs` (`CardRow` struct and `from_json`)
- Modify: `src-tauri/src/ingest.rs` (`STAGING_INSERT` at :224, `write_batch` at :170)

**Interfaces:**
- Consumes: `legalities::legal_mask`, `legalities::mask_sql` (Task 1).
- Produces: `cards.legal_mask` populated on every row; `idx_cards_collapse` carrying `legal_mask, cmc, color_identity`; `SCHEMA_VERSION == 8`.

- [ ] **Step 1: Write the failing tests**

Add to `schema.rs`'s `mod tests`:

```rust
/// The v8 step over a database that stopped at v7 — the shape every existing install is in.
/// `legalities` is a plain TEXT column, so this backfill needs no `json_raw` guard; the
/// test seeds a **gzip `raw`** anyway, because a step that reached for `raw` by mistake
/// would then fail here rather than in the field.
#[test]
fn the_v8_backfill_fills_legal_mask_and_leaves_gzip_raw_alone() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    conn.execute(
        "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,legalities,is_paper,raw)
         VALUES ('1','Black Lotus','lea','232','en','normal',
                 '{\"vintage\":\"restricted\",\"modern\":\"not_legal\"}',1,?1)",
        [crate::card_row::gzip_raw("{}").unwrap()],
    )
    .unwrap();
    conn.execute("UPDATE cards SET legal_mask = NULL", []).unwrap();
    conn.execute_batch("PRAGMA user_version = 7;").unwrap();

    migrate(&conn).unwrap();

    let mask: i64 = conn
        .query_row("SELECT legal_mask FROM cards WHERE id='1'", [], |r| r.get(0))
        .unwrap();
    let vintage = crate::legalities::bit("vintage").unwrap() as i64;
    let modern = crate::legalities::bit("modern").unwrap() as i64;
    assert_ne!(mask & vintage, 0, "restricted is playable");
    assert_eq!(mask & modern, 0);
}

/// The widened index is what makes a *filtered* browse cheap — 505 ms to 41 ms, measured
/// 2026-08-11. A v7 database already has the narrow definition, and every statement in
/// `CARDS_INDEXES` is `IF NOT EXISTS`, so the step has to DROP first or the widening is a
/// silent no-op on exactly the machines that need it.
#[test]
fn the_v8_step_replaces_the_narrow_collapse_index_rather_than_skipping_it() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    conn.execute_batch(
        "DROP INDEX idx_cards_collapse;
         CREATE INDEX idx_cards_collapse
             ON cards(oracle_id, is_paper, released_at, id, name, price_usd);
         PRAGMA user_version = 7;",
    )
    .unwrap();

    migrate(&conn).unwrap();

    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name='idx_cards_collapse'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(sql.contains("legal_mask"), "widened: {sql}");
    assert!(sql.contains("cmc"), "widened: {sql}");
    assert!(sql.contains("color_identity"), "widened: {sql}");
}

#[test]
fn the_schema_version_is_eight() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(v, SCHEMA_VERSION);
    assert_eq!(SCHEMA_VERSION, 8);
}
```

Add to `card_row.rs`'s `mod tests`:

```rust
/// The ingest fills the mask natively, so the backfill is only ever paid once.
#[test]
fn a_parsed_row_carries_its_legality_mask() {
    let c = parse(
        r#"{"id":"x","name":"Bolt","lang":"en","layout":"normal","set":"lea",
            "collector_number":"1","legalities":{"modern":"legal"},"games":["paper"]}"#,
    );
    assert_eq!(c.legal_mask, crate::legalities::bit("modern").unwrap());
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test v8 && cargo test legality_mask`
Expected: FAIL — `no such column: legal_mask`, and `CardRow` has no field `legal_mask`.

- [ ] **Step 3: Implement**

In `schema.rs`, widen the last entry of `CARDS_INDEXES`:

```rust
    // The collapsed search's whole cost model … (keep the existing comment, and add:)
    //
    // **The trailing three are the filter columns, and they are why a *filtered* browse is
    // cheap.** Without them every filter the search offers — format, colours, mana value —
    // knocks the group scan off this index and into row lookups: 455–505 ms against
    // 22–47 ms with them, measured 2026-08-11 over the live corpus. They cost +0.89 MB
    // (13.45 → 14.34 MB) and 4 ms on the *unfiltered* browse, which is the trade.
    //
    // `legal_mask` and not `legalities`: a JSON path is not indexable, which is the whole
    // reason [`crate::legalities`] exists.
    "CREATE INDEX IF NOT EXISTS idx_cards_collapse \
     ON cards(oracle_id, is_paper, released_at, id, name, price_usd, \
              legal_mask, cmc, color_identity)",
```

Bump `pub const SCHEMA_VERSION: i64 = 8;` and add after the `v < 7` block:

```rust
    if v < 8 {
        let tx = conn.unchecked_transaction()?;
        // One nullable column, and a widened index. `CARDS_COLUMNS` stays frozen — a fresh
        // install replays v1 and arrives here to do the same work an upgrade does.
        //
        // **The DROP is load-bearing.** Every statement in [`CARDS_INDEXES`] is
        // `IF NOT EXISTS`, so re-running the batch over a v7 database — which already has
        // `idx_cards_collapse` in its narrow form — would leave the old definition in place
        // and quietly skip the widening on exactly the machines that need it. v7 could
        // re-run the batch bare because its index was new; this one is not.
        //
        // The backfill reads `legalities`, which is plain JSON TEXT and not `raw`, so
        // [`json_raw`] has no part to play. Nothing here touches an FTS-indexed column and
        // no rowid is renumbered, so no `cards_fts` rebuild is owed.
        tx.execute_batch("ALTER TABLE cards ADD COLUMN legal_mask INTEGER;")?;
        tx.execute_batch(&format!(
            "UPDATE cards SET legal_mask = {mask};",
            mask = crate::legalities::mask_sql("legalities")
        ))?;
        tx.execute_batch("DROP INDEX IF EXISTS idx_cards_collapse;")?;
        tx.execute_batch(&cards_indexes_sql())?;
        // Literal `8`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA user_version = 8;")?;
        tx.commit()?;
    }
```

In `card_row.rs`, add the field to `CardRow` after `legalities`:

```rust
    pub legalities: Option<String>,
    /// [`crate::legalities`]' mask of the line above, so the format filter is a bitwise
    /// test rather than 23 JSON parses — and so it can live in an index.
    pub legal_mask: u64,
```

and in `from_json`, beside `legalities: compact(v, "legalities")`:

```rust
            legalities: compact(v, "legalities"),
            legal_mask: v
                .get("legalities")
                .map_or(0, crate::legalities::legal_mask),
```

In `ingest.rs`, add `legal_mask` to `STAGING_INSERT`'s column list and `?43` to its `VALUES`, and `c.legal_mask as i64,` to the `params![…]` in `write_batch` — **in the same position in both**, immediately after `c.legalities`.

**The `as i64` is required, not stylistic.** rusqlite implements `ToSql` for `i64` and for the unsigned types up to `u32`, but **not for `u64`** — SQLite's INTEGER is signed 64-bit, so the conversion cannot be infallible in general. `CardRow::legal_mask` stays `u64` because a bitmask is not a number you do arithmetic on, and the cast is lossless while `LEGALITY_KEYS.len() <= 63` — which Task 1's `the_key_list_fits_in_a_u64` already fences, and which 23 keys is nowhere near.

- [ ] **Step 4: Run the full Rust suite**

Run: `cd src-tauri && cargo test`
Expected: PASS. The migration ladder tests, the FTS tests and the swap tests all still pass.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify`

```bash
git add src-tauri/src/schema.rs src-tauri/src/card_row.rs src-tauri/src/ingest.rs
git commit -m "feat(search): add legal_mask and widen the collapse index to cover filters"
```

---

### Task 2b: Make the format filter use the mask

> **Added mid-execution, 2026-08-11.** Task 2's implementer noticed that `filters.rs` still
> filters format with `json_extract`, and it is right: **the widened index delivers nothing
> until the query stops parsing JSON.** Measured against the live corpus with the widened
> index already in place, a format-filtered collapsed browse is **40.6 ms** via `legal_mask`
> and **591 ms** via `json_extract` — slightly *worse* than the 505 ms before widening,
> because the wider index is a larger thing to scan when the predicate cannot use it. Plan A
> as first written would have shipped the whole cost of the index and none of its benefit.

**Files:**
- Modify: `src-tauri/src/filters.rs` (the `format` predicate in `push_card_filters`)
- Modify: `src-tauri/src/schema.rs` (the v8 step's `ALTER TABLE`)

**Interfaces:**
- Consumes: `legalities::bit(key) -> Option<u64>` (Task 1), `cards.legal_mask` (Task 2).
- Produces: no new symbols. `push_card_filters`'s emitted SQL changes shape.

**Two changes, and the second is why the first is safe.**

- [ ] **Step 1: Write the failing tests**

In `filters.rs`'s tests (or `search.rs`'s, wherever the format filter is currently covered —
find the existing coverage first and extend it rather than starting a parallel set):

```rust
/// The filter has to reach the index, and it cannot while it parses JSON per row. Measured
/// on the live corpus with the widened `idx_cards_collapse` in place: 40.6 ms through the
/// mask against 591 ms through `json_extract`.
#[test]
fn the_format_filter_tests_the_mask_rather_than_parsing_json() {
    let mut p = Predicates::default();
    let f = CardFilters { format: Some("modern".into()), ..Default::default() };
    push_card_filters(&mut p, &f, "c", None);
    let sql = p.where_sql();
    assert!(sql.contains("legal_mask"), "{sql}");
    assert!(!sql.contains("json_extract"), "{sql}");
}

/// `restricted` counts as playable — a Vintage search that hid Black Lotus would be wrong.
/// This survived the rewrite because the *mask* encodes it, not the SQL.
#[test]
fn the_mask_filter_still_admits_restricted_cards() {
    // Seed Black Lotus with vintage=restricted, run a search with format=vintage,
    // assert it comes back. Reuse `search::tests::seeded()`, which already has one.
}

/// A format this build has never heard of matched nothing before — `json_extract` of an
/// absent key is NULL, and `NULL IN (…)` is NULL. It must still match nothing, rather than
/// matching everything or erroring.
#[test]
fn a_format_the_build_does_not_know_matches_nothing() {
    // run_search with format: Some("some_format_scryfall_invented") — expect total 0.
}

/// An orphaned collection row has no card row to answer for it, so the LEFT JOIN gives a
/// NULL alias. `NULL & ? != 0` is NULL, which fails the filter exactly as
/// `json_extract(NULL, …)` did — the orphan still fails a format filter rather than
/// silently passing it.
#[test]
fn an_orphan_still_fails_a_format_filter() {
    // Collection list with a card_id no `cards` row has, plus format=modern: not returned.
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test format`
Expected: FAIL — the emitted SQL still says `json_extract`.

- [ ] **Step 3: Implement**

In `filters.rs`, replace the format arm:

```rust
    // **The mask, not `json_extract`.** A JSON path cannot be indexed, so the old form
    // knocked the collapsed browse's scan off `idx_cards_collapse` and into a row lookup per
    // card: 591 ms against 40.6 ms through the mask, measured 2026-08-11 over the live corpus
    // with the widened index in place. [`crate::legalities`] exists for this.
    //
    // `restricted` still counts as playable — that lives in the mask now rather than in this
    // SQL, which is why the predicate no longer says so.
    //
    // A key this build has never heard of matches nothing, which is what the old form did
    // too: `json_extract` of an absent key is NULL and `NULL IN (…)` is NULL. Spelled `0`
    // rather than left out, because leaving it out would turn an unknown format into "no
    // filter at all" and quietly return the whole corpus.
    if let Some(v) = nonblank(&f.format) {
        match crate::legalities::bit(v) {
            Some(b) => p.push(
                format!("({alias}.legal_mask & ?) != 0"),
                Box::new(b as i64),
            ),
            None => p.wheres.push("0".to_owned()),
        }
    }
```

In `schema.rs`'s v8 step, tighten the column:

```rust
        tx.execute_batch("ALTER TABLE cards ADD COLUMN legal_mask INTEGER NOT NULL DEFAULT 0;")?;
```

with the reason written down: the filter above is `legal_mask & ? != 0`, and a NULL there
drops the row silently rather than reading as "legal nowhere". No NULL can reach production
today — `mask_sql` answers `0` for a NULL `legalities`, and `STAGING_INSERT` names the column
so the ingest always binds it — but the column permitted one, and this closes it while v8 is
still unshipped. `cards_column_defs` reproduces both `NOT NULL` and `DEFAULT`, so staging
carries them and the swap survives.

- [ ] **Step 4: Run the full Rust suite**

Run: `cd src-tauri && cargo test`
Expected: PASS. Watch for existing format-filter tests in `search.rs` and `collection.rs`
that assert on SQL text rather than on results — those are the ones this can break.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify`

```bash
git add src-tauri/src/filters.rs src-tauri/src/schema.rs
git commit -m "perf(search): filter format through the mask so it can use the index"
```

---

### Task 3: The bitset

**Files:**
- Create: `src-tauri/src/index/bitset.rs`, `src-tauri/src/index/mod.rs`
- Modify: `src-tauri/src/lib.rs` (`mod index;`)

**Interfaces:**
- Produces: `index::bitset::BitSet` with `new(capacity: usize)`, `set(&mut self, doc: u32)`, `contains(&self, doc: u32) -> bool`, `and(&self, other: &BitSet) -> BitSet`, `and_count(&self, other: &BitSet) -> u32`, `count(&self) -> u32`, `for_each(&self, f: impl FnMut(u32))`, `capacity(&self) -> usize`.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/index/bitset.rs`:

```rust
//! A fixed-size bitset over `cards.rowid`, one bit per printing.
//!
//! 116 694 printings is 3 647 machine words — 14 KB — so intersecting two filters is a
//! `AND` and a `popcount` over 14 KB rather than a query. The whole low-cardinality half of
//! [`super::CardIndex`] is 40 of these.

/// One bit per rowid. Rowid 0 is never used by SQLite, so index 0 is simply always clear.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BitSet {
    words: Vec<u64>,
}

impl BitSet {
    pub fn new(capacity: usize) -> Self {
        todo!()
    }
    pub fn capacity(&self) -> usize {
        todo!()
    }
    pub fn set(&mut self, doc: u32) {
        todo!()
    }
    pub fn contains(&self, doc: u32) -> bool {
        todo!()
    }
    pub fn and(&self, other: &BitSet) -> BitSet {
        todo!()
    }
    pub fn and_count(&self, other: &BitSet) -> u32 {
        todo!()
    }
    pub fn count(&self) -> u32 {
        todo!()
    }
    pub fn for_each(&self, f: impl FnMut(u32)) {
        todo!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bit_that_was_set_is_the_only_one_present() {
        let mut b = BitSet::new(200);
        b.set(0);
        b.set(63);
        b.set(64);
        b.set(199);
        assert!(b.contains(0) && b.contains(63) && b.contains(64) && b.contains(199));
        assert!(!b.contains(1) && !b.contains(65));
        assert_eq!(b.count(), 4);
    }

    /// The word boundary is where an off-by-one lives, so it is tested on both sides.
    #[test]
    fn intersection_counts_only_what_both_hold() {
        let mut a = BitSet::new(200);
        let mut b = BitSet::new(200);
        for d in [1, 63, 64, 65, 128] {
            a.set(d);
        }
        for d in [63, 65, 199] {
            b.set(d);
        }
        assert_eq!(a.and_count(&b), 2);
        assert_eq!(a.and(&b).count(), 2);
        assert!(a.and(&b).contains(63) && a.and(&b).contains(65));
    }

    /// `for_each` is how the set-ordinal walk reads its docs, so it must visit every set bit
    /// exactly once and in ascending order.
    #[test]
    fn for_each_visits_every_set_bit_once_in_order() {
        let mut b = BitSet::new(300);
        for d in [5, 64, 130, 299] {
            b.set(d);
        }
        let mut seen = Vec::new();
        b.for_each(|d| seen.push(d));
        assert_eq!(seen, vec![5, 64, 130, 299]);
    }

    /// A capacity that is not a multiple of 64 must not let a stray high bit be counted.
    #[test]
    fn a_ragged_capacity_counts_nothing_past_its_end() {
        let b = BitSet::new(100);
        assert_eq!(b.count(), 0);
        assert!(!b.contains(99));
        assert_eq!(b.capacity(), 100);
    }

    /// Out-of-range writes are dropped rather than panicking: rowids come from a database
    /// that a sync can grow between the build and the query.
    #[test]
    fn a_doc_past_capacity_is_ignored_rather_than_panicking() {
        let mut b = BitSet::new(64);
        b.set(1000);
        assert_eq!(b.count(), 0);
        assert!(!b.contains(1000));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test bitset`
Expected: FAIL — `not yet implemented`.

- [ ] **Step 3: Implement**

```rust
const BITS: usize = 64;

impl BitSet {
    /// `capacity` is a rowid ceiling, not a count: index `capacity - 1` is the highest doc
    /// this set can hold.
    pub fn new(capacity: usize) -> Self {
        BitSet { words: vec![0; capacity.div_ceil(BITS)] }
    }

    pub fn capacity(&self) -> usize {
        self.words.len() * BITS
    }

    /// A doc past the end is dropped. The alternative is a panic on a database that grew
    /// between the build and the query, which is a crash rather than a stale answer.
    pub fn set(&mut self, doc: u32) {
        let (w, b) = (doc as usize / BITS, doc as usize % BITS);
        if let Some(word) = self.words.get_mut(w) {
            *word |= 1u64 << b;
        }
    }

    pub fn contains(&self, doc: u32) -> bool {
        let (w, b) = (doc as usize / BITS, doc as usize % BITS);
        self.words.get(w).is_some_and(|word| word & (1u64 << b) != 0)
    }

    /// Shorter operand wins: two sets built against different capacities intersect over
    /// what they share, which is the only honest answer.
    pub fn and(&self, other: &BitSet) -> BitSet {
        let n = self.words.len().min(other.words.len());
        BitSet { words: (0..n).map(|i| self.words[i] & other.words[i]).collect() }
    }

    pub fn and_count(&self, other: &BitSet) -> u32 {
        let n = self.words.len().min(other.words.len());
        (0..n).map(|i| (self.words[i] & other.words[i]).count_ones()).sum()
    }

    pub fn count(&self) -> u32 {
        self.words.iter().map(|w| w.count_ones()).sum()
    }

    /// Ascending, and skipping empty words wholesale — the sets facet walks up to 107 337
    /// docs through this on every keystroke.
    pub fn for_each(&self, mut f: impl FnMut(u32)) {
        for (i, word) in self.words.iter().enumerate() {
            let mut w = *word;
            while w != 0 {
                let bit = w.trailing_zeros();
                f((i * BITS) as u32 + bit);
                w &= w - 1;
            }
        }
    }
}
```

Create `src-tauri/src/index/mod.rs` with `pub mod bitset;` and add `mod index;` to `lib.rs`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test bitset`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/index src-tauri/src/lib.rs
git commit -m "feat(search): add the bitset the card index counts with"
```

---

### Task 4: Building the index

**Files:**
- Modify: `src-tauri/src/index/mod.rs`

**Interfaces:**
- Consumes: `BitSet` (Task 3), `cards.legal_mask` (Task 2).
- Produces: `index::CardIndex` with fields `paper: BitSet`, `colors: [BitSet; 6]`, `mana: [BitSet; 10]`, `formats: Vec<BitSet>`, `set_ord: Vec<u16>`, `set_codes: Vec<String>`, `owned: BitSet`, `capacity: usize`; and `CardIndex::build(conn: &Connection) -> rusqlite::Result<CardIndex>`, `CardIndex::rebuild_owned(&mut self, conn: &Connection) -> rusqlite::Result<()>`, `CardIndex::color_index(letter: char) -> Option<usize>`, `CardIndex::COLOR_KEYS: [char; 6]`, `CardIndex::MANA_BUCKETS: usize` (10 — 0..=7, 8-or-more, and 9 for "no cost").

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/index/mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Four printings that between them exercise every column the index reads: a colourless
    /// card, a two-colour one, a digital-only one, and one with no `cmc` at all.
    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        let modern = crate::legalities::bit("modern").unwrap() as i64;
        let rows: [(&str, &str, &str, Option<f64>, &str, i64, i64); 4] = [
            ("1", "Lightning Bolt", "lea", Some(1.0), "R", 1, modern),
            ("2", "Lightning Helix", "rav", Some(2.0), "RW", 1, modern),
            ("3", "Sol Ring", "lea", Some(1.0), "", 1, 0),
            ("4", "Digital Only", "alc", None, "B", 0, 0),
        ];
        for (id, name, set, cmc, ci, paper, mask) in rows {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,cmc,
                    color_identity,is_paper,legal_mask,raw)
                 VALUES (?1,?2,?3,'1','en','normal',?4,?5,?6,?7,'{}')",
                rusqlite::params![id, name, set, cmc, ci, paper, mask],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn the_paper_set_holds_paper_printings_and_nothing_else() {
        let ix = CardIndex::build(&seeded()).unwrap();
        assert_eq!(ix.paper.count(), 3);
    }

    /// Colour identity is per letter, and the empty identity is its own bucket — `C` means
    /// colourless, which is a fact about a card and not the absence of one.
    #[test]
    fn colour_bitsets_are_per_letter_with_colourless_its_own() {
        let ix = CardIndex::build(&seeded()).unwrap();
        let idx = |c| CardIndex::color_index(c).unwrap();
        assert_eq!(ix.colors[idx('R')].and_count(&ix.paper), 2, "Bolt and Helix");
        assert_eq!(ix.colors[idx('W')].and_count(&ix.paper), 1, "Helix");
        assert_eq!(ix.colors[idx('C')].and_count(&ix.paper), 1, "Sol Ring");
        assert_eq!(ix.colors[idx('B')].and_count(&ix.paper), 0, "the black card is digital");
    }

    /// Bucket 9 is "no mana value at all", which is not bucket 0: a card that costs nothing
    /// and a card whose cost is unknown are different answers, and `cmc` is nullable.
    #[test]
    fn mana_buckets_separate_zero_from_unknown_and_cap_at_eight() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,cmc,is_paper,raw)
             VALUES ('5','Emrakul','roe','1','en','normal',15.0,1,'{}'),
                    ('6','Ancestral','lea','2','en','normal',0.0,1,'{}')",
            [],
        )
        .unwrap();
        let ix = CardIndex::build(&conn).unwrap();
        assert_eq!(ix.mana[0].and_count(&ix.paper), 1, "the zero-cost card");
        assert_eq!(ix.mana[8].and_count(&ix.paper), 1, "15 lands in the open-ended bucket");
        assert_eq!(ix.mana[9].count(), 1, "the NULL cmc row, digital though it is");
    }

    #[test]
    fn set_ordinals_resolve_back_to_their_codes() {
        let ix = CardIndex::build(&seeded()).unwrap();
        let mut counts = vec![0u32; ix.set_codes.len()];
        ix.paper.for_each(|d| counts[ix.set_ord[d as usize] as usize] += 1);
        let lea = ix.set_codes.iter().position(|c| c == "lea").unwrap();
        let rav = ix.set_codes.iter().position(|c| c == "rav").unwrap();
        assert_eq!(counts[lea], 2);
        assert_eq!(counts[rav], 1);
    }

    #[test]
    fn formats_are_indexed_by_the_frozen_key_order() {
        let ix = CardIndex::build(&seeded()).unwrap();
        let modern = crate::legalities::LEGALITY_KEYS.iter().position(|k| *k == "modern").unwrap();
        assert_eq!(ix.formats[modern].and_count(&ix.paper), 2);
    }

    /// `owned` is the one dimension that changes while the app runs, so it rebuilds on its
    /// own rather than forcing a full rebuild on every quick-add.
    #[test]
    fn owned_rebuilds_from_the_collection_without_touching_the_rest() {
        let conn = seeded();
        let mut ix = CardIndex::build(&conn).unwrap();
        assert_eq!(ix.owned.count(), 0);
        conn.execute(
            "INSERT INTO collection_entries (card_id,set_code,collector_number,lang,finish,
                quantity,created_at,updated_at)
             VALUES ('1','lea','1','en','nonfoil',0,'2026-08-11','2026-08-11')",
            [],
        )
        .unwrap();
        ix.rebuild_owned(&conn).unwrap();
        // An **entry**, not a copy: quantity 0 still counts as owned, exactly as the
        // search's `owned` filter reads it.
        assert_eq!(ix.owned.count(), 1);
        assert_eq!(ix.paper.count(), 3, "the rest of the index is untouched");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test index::tests`
Expected: FAIL — `CardIndex` not found.

- [ ] **Step 3: Implement**

In `src-tauri/src/index/mod.rs`, above the tests:

```rust
//! An in-memory index over the card corpus, in the shape a search engine uses.
//!
//! **Why this exists rather than more SQL.** Faceting needs a count per option per
//! dimension on every filter press. Measured against the live 116 694-printing database on
//! 2026-08-11: a four-dimension pass costs 2 238 ms against `cards` as it stands, 62 ms with
//! a covering index and [`crate::legalities`]' mask, and 106–167 ms at best over a
//! rowid-aligned shadow table — because a one-character search box entry matches 100 129
//! rows and seeking those rowids is the floor. In memory the same pass is 0.31 ms, and the
//! worst case there is is 57 ms, of which 25 ms is the FTS scan nothing avoids.
//!
//! **Low cardinality gets a bitset, high cardinality an ordinal array.** Giving each of the
//! 986 set codes its own bitset was the first design and was wrong by 18× on memory and 35×
//! on speed — 14.3 MB and 11 ms against 0.78 MB and 0.12 ms. Sets get `set_ord`, a `u16` per
//! doc, and are counted by walking the base and bumping a counter.
//!
//! **It is derived, and it is rebuilt wholesale.** Nothing here is patched incrementally
//! except [`CardIndex::owned`], which is the one dimension the user changes while the app is
//! running. `cards` is dropped and recreated by every sync, which renumbers every rowid, so
//! the index is rebuilt after each swap — see [`lifecycle`].

pub mod bitset;
pub mod facets;
pub mod lifecycle;

use bitset::BitSet;
use rusqlite::Connection;

pub struct CardIndex {
    /// Rowid ceiling every bitset here was built against, **rounded up to a whole word** —
    /// see `build`. Every sibling array indexed by a doc id is this long.
    pub capacity: usize,
    /// Every printing in the corpus. Not the same as "all bits below `capacity`": rowid 0
    /// is never issued and the padding above the last row is not a card, so this is what a
    /// request with `paperOnly: false` narrows from.
    pub all: BitSet,
    pub paper: BitSet,
    /// WUBRG then C, indexed by [`CardIndex::color_index`].
    pub colors: [BitSet; 6],
    /// 0–7 exact, 8 is "8 or more", 9 is "no mana value at all".
    pub mana: [BitSet; Self::MANA_BUCKETS],
    /// One per [`crate::legalities::LEGALITY_KEYS`] entry, same order.
    pub formats: Vec<BitSet>,
    /// Set ordinal per doc, indexing [`CardIndex::set_codes`]. `u16` because 986 codes is
    /// three orders of magnitude inside its range and this array is one per printing.
    pub set_ord: Vec<u16>,
    pub set_codes: Vec<String>,
    /// Printings the collection has an **entry** for — quantity 0 included, exactly as the
    /// search's `owned` filter reads it.
    pub owned: BitSet,
}

impl CardIndex {
    pub const COLOR_KEYS: [char; 6] = ['W', 'U', 'B', 'R', 'G', 'C'];
    pub const MANA_BUCKETS: usize = 10;
    /// The bucket for a printing with no `cmc`. Not bucket 0: a card that costs nothing and
    /// a card whose cost is unknown are different answers, and no chip asks for the latter.
    pub const MANA_UNKNOWN: usize = 9;

    pub fn color_index(letter: char) -> Option<usize> {
        Self::COLOR_KEYS.iter().position(|c| *c == letter)
    }

    /// Read every facet column once and fill the arrays.
    ///
    /// **Give this its own read-only connection.** It is a full pass over `cards` and holding
    /// `AppState.db_read` for it would stall every search behind it at launch, which is the
    /// exact failure that second connection exists to prevent.
    pub fn build(conn: &Connection) -> rusqlite::Result<CardIndex> {
        let highest = conn
            .query_row("SELECT coalesce(max(rowid), 0) + 1 FROM cards", [], |r| {
                r.get::<_, i64>(0)
            })? as usize;

        // **`capacity` is the bitset's rounded figure, never the row count.** `BitSet::new`
        // rounds up to a whole word, so a set asked for 116 695 docs holds 116 736 — and
        // `set` *accepts* a doc in that padding window rather than dropping it, which is
        // exactly the leniency that lets a sync grow the corpus under a live index. Size
        // every sibling array indexed by the same doc ids from this number, or
        // `paper.for_each` can hand `set_ord` an index up to 63 past its end. The reachable
        // path is `rebuild_owned` re-reading a grown `cards` against a stale capacity.
        let paper = BitSet::new(highest);
        let capacity = paper.capacity();

        let mut ix = CardIndex {
            capacity,
            all: BitSet::new(capacity),
            paper,
            colors: std::array::from_fn(|_| BitSet::new(capacity)),
            mana: std::array::from_fn(|_| BitSet::new(capacity)),
            formats: (0..crate::legalities::LEGALITY_KEYS.len())
                .map(|_| BitSet::new(capacity))
                .collect(),
            set_ord: vec![0; capacity],
            set_codes: Vec::new(),
            owned: BitSet::new(capacity),
        };

        let mut seen: std::collections::HashMap<String, u16> = std::collections::HashMap::new();
        let mut stmt = conn.prepare(
            "SELECT rowid, set_code, cmc, color_identity, legal_mask, is_paper FROM cards",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let doc: i64 = row.get(0)?;
            let doc = doc as u32;
            let set_code: String = row.get(1)?;
            let cmc: Option<f64> = row.get(2)?;
            let identity: Option<String> = row.get(3)?;
            let mask: Option<i64> = row.get(4)?;
            let paper: bool = row.get(5)?;

            ix.all.set(doc);
            if paper {
                ix.paper.set(doc);
            }

            let next = seen.len() as u16;
            let ord = *seen.entry(set_code.clone()).or_insert_with(|| {
                ix.set_codes.push(set_code.clone());
                next
            });
            if let Some(slot) = ix.set_ord.get_mut(doc as usize) {
                *slot = ord;
            }

            // An empty identity is colourless and a NULL one is unknown; both land on the
            // colourless side, which is what `push_card_filters` does with them too.
            let identity = identity.unwrap_or_default();
            if identity.is_empty() {
                ix.colors[5].set(doc);
            } else {
                for ch in identity.chars() {
                    if let Some(i) = Self::color_index(ch) {
                        ix.colors[i].set(doc);
                    }
                }
            }

            let bucket = match cmc {
                None => Self::MANA_UNKNOWN,
                Some(v) if v >= 8.0 => 8,
                // A fractional un-card cost truncates, and matches no chip a reader can
                // press — the chips are integers.
                Some(v) => (v as usize).min(8),
            };
            ix.mana[bucket].set(doc);

            let mask = mask.unwrap_or(0) as u64;
            for (k, set) in ix.formats.iter_mut().enumerate() {
                if mask & (1u64 << k) != 0 {
                    set.set(doc);
                }
            }
        }
        drop(rows);
        drop(stmt);

        ix.rebuild_owned(conn)?;
        Ok(ix)
    }

    /// Re-read just the `owned` dimension. 10–23 ms at 200–12 000 owned printings, measured
    /// 2026-08-11 — cheap enough to run on every collection write.
    ///
    /// The join reads `cards`' primary-key index for the rowid and never the row, so the
    /// cost is one index probe per collection entry.
    pub fn rebuild_owned(&mut self, conn: &Connection) -> rusqlite::Result<()> {
        let mut owned = BitSet::new(self.capacity);
        let mut stmt = conn.prepare(
            "SELECT DISTINCT c.rowid FROM collection_entries e JOIN cards c ON c.id = e.card_id",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let doc: i64 = row.get(0)?;
            owned.set(doc as u32);
        }
        drop(rows);
        drop(stmt);
        self.owned = owned;
        Ok(())
    }
}
```

Create empty `src-tauri/src/index/facets.rs` and `src-tauri/src/index/lifecycle.rs` so the `pub mod` lines compile (Tasks 5 and 6 fill them).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test index::tests`
Expected: PASS, 6 tests.

- [ ] **Step 5: Measure the warm-up read against the live corpus**

This is the one number the spec left estimated. Copy a real database aside and time `CardIndex::build` over it — do **not** measure against `src-tauri/target/debug/data/mtg.db` while the app holds it.

```bash
cp D:/Code/mtg-grimoire/src-tauri/target/debug/data/mtg.db /tmp/warmup.db
cd src-tauri && cargo test --release warmup_timing -- --ignored --nocapture
```

Add the timing test to `index/mod.rs`'s `mod tests`:

```rust
    /// Not a unit test — a stopwatch. `--ignored`, because it needs a real database and a
    /// path only a developer has. The number it prints belongs in `CardIndex::build`'s doc
    /// comment, which is where this crate keeps its measurements.
    #[test]
    #[ignore]
    fn warmup_timing() {
        let path = std::env::var("MTG_WARMUP_DB").expect("set MTG_WARMUP_DB to a copied mtg.db");
        let conn = crate::db::open_read_only(std::path::Path::new(&path)).unwrap();
        let t = std::time::Instant::now();
        let ix = CardIndex::build(&conn).unwrap();
        println!(
            "built in {:?} — {} docs, {} sets",
            t.elapsed(),
            ix.paper.count(),
            ix.set_codes.len()
        );
    }
```

Record the measured figure in `CardIndex::build`'s doc comment, dated, replacing the estimate. **If it exceeds ~1.5 s**, stop and raise it: the spec's fallback is a covering index for the read, and that is a design change rather than a tuning knob.

- [ ] **Step 6: Verify and commit**

Run: `npm run verify`

```bash
git add src-tauri/src/index
git commit -m "feat(search): build the in-memory card index"
```

---

### Task 5: Counting facets

**Files:**
- Modify: `src-tauri/src/index/facets.rs`

**Interfaces:**
- Consumes: `CardIndex` (Task 4), `filters::CardFilters`.
- Produces: `facets::FacetResponse` (serde `camelCase`, fields `colors: BTreeMap<String, i64>`, `mana_values: BTreeMap<String, i64>`, `formats: BTreeMap<String, i64>`, `sets: BTreeMap<String, i64>`, `owned: OwnedFacets { owned: i64, missing: i64 }`, `total: i64`, `ready: bool`); `facets::compute(ix: &CardIndex, req: &crate::search::SearchRequest, text: Option<&BitSet>) -> FacetResponse`.

**The rule this task implements**, from spec §2:

- `sets`, `manaValues`, `formats` carry a **plain count over the base with that dimension's own filter removed**. The UI greys an option counting 0.
- `colors` carries the **size of the result set after toggling that chip**, because colours broaden: with `U` on, pressing `W` asks for a superset. `total` is the current result size, and the UI greys a colour when toggling would leave it unchanged or empty.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::SearchRequest;

    fn req(f: impl FnOnce(&mut SearchRequest)) -> SearchRequest {
        let mut r = SearchRequest { limit: 50, ..Default::default() };
        f(&mut r);
        r
    }

    /// The rule that keeps a multi-select usable: a dimension's counts ignore its OWN
    /// filter. Pick one set and every other set must still report what picking it *would*
    /// give, or the picker greys out the whole list the moment it is used.
    #[test]
    fn a_dimensions_counts_exclude_its_own_filter() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();
        let r = req(|r| r.sets = Some(vec!["lea".into()]));
        let f = compute(&ix, &r, None);
        assert_eq!(f.sets.get("lea").copied(), Some(2));
        assert_eq!(f.sets.get("rav").copied(), Some(1), "still offered, still counted");
    }

    /// …while every OTHER dimension does narrow by it.
    #[test]
    fn other_dimensions_do_narrow_by_the_set_filter() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();
        let f = compute(&ix, &req(|r| r.sets = Some(vec!["rav".into()])), None);
        let modern = "modern".to_string();
        assert_eq!(f.formats.get(&modern).copied(), Some(1), "only Helix is in rav");
    }

    /// Colours broaden, so their number is "what the search becomes if this is pressed",
    /// not "how many are white". With nothing selected that is a narrowing count; with `R`
    /// selected, pressing `W` must report R ∪ RW ∪ colourless.
    #[test]
    fn colour_counts_are_the_result_after_toggling() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();

        let none = compute(&ix, &req(|_| {}), None);
        assert_eq!(none.total, 3, "three paper printings");
        // Subset semantics: mono-R plus the colourless card.
        assert_eq!(none.colors.get("R").copied(), Some(2));

        let r = compute(&ix, &req(|r| r.colors = Some("R".into())), None);
        assert_eq!(r.total, 2, "Bolt and Sol Ring");
        // Adding W admits Helix.
        assert_eq!(r.colors.get("W").copied(), Some(3));
        // Pressing R again removes it — back to everything.
        assert_eq!(r.colors.get("R").copied(), Some(3));
    }

    /// A colour that brings in nothing new reports the count it already had, which is what
    /// the frontend greys on. This is the case "would return nothing" would get wrong.
    #[test]
    fn a_colour_that_adds_nothing_reports_no_change() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();
        // No blue paper printing exists in the fixture, so adding U to R changes nothing.
        let r = compute(&ix, &req(|r| r.colors = Some("R".into())), None);
        assert_eq!(r.colors.get("U").copied(), Some(r.total));
    }

    #[test]
    fn mana_buckets_are_keyed_by_the_chip_and_eight_is_open_ended() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,cmc,is_paper,raw)
             VALUES ('9','Emrakul','roe','1','en','normal',15.0,1,'{}')",
            [],
        )
        .unwrap();
        let ix = crate::index::CardIndex::build(&conn).unwrap();
        let f = compute(&ix, &req(|_| {}), None);
        assert_eq!(f.mana_values.get("1").copied(), Some(2));
        assert_eq!(f.mana_values.get("8").copied(), Some(1), "15 is 8-or-more");
        assert!(!f.mana_values.contains_key("9"), "unknown is not a chip");
    }

    /// `owned` is never greyed, so its two numbers are for the tooltip — but they still have
    /// to be right, and they are counted over the base with `owned` itself removed.
    #[test]
    fn owned_reports_both_sides_of_the_cycle() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO collection_entries (card_id,set_code,collector_number,lang,finish,
                quantity,created_at,updated_at)
             VALUES ('1','lea','1','en','nonfoil',2,'2026-08-11','2026-08-11')",
            [],
        )
        .unwrap();
        let ix = crate::index::CardIndex::build(&conn).unwrap();
        let f = compute(&ix, &req(|r| r.owned = Some(true)), None);
        assert_eq!(f.owned.owned, 1);
        assert_eq!(f.owned.missing, 2, "counted as if `owned` were not set");
    }

    /// Text is not a facet, and it narrows every base including its own.
    #[test]
    fn a_text_bitset_narrows_every_dimension() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();
        let mut text = crate::index::bitset::BitSet::new(ix.capacity);
        let doc: i64 = conn
            .query_row("SELECT rowid FROM cards WHERE id='2'", [], |r| r.get(0))
            .unwrap();
        text.set(doc as u32);
        let f = compute(&ix, &req(|_| {}), Some(&text));
        assert_eq!(f.total, 1);
        assert_eq!(f.sets.get("rav").copied(), Some(1));
        assert_eq!(f.sets.get("lea").copied(), Some(0), "offered, and empty");
    }

    /// The digital printing is behind `paperOnly`, which defaults on and is not a facet.
    #[test]
    fn the_paper_default_applies_to_every_base() {
        let conn = seeded();
        let ix = crate::index::CardIndex::build(&conn).unwrap();
        let f = compute(&ix, &req(|_| {}), None);
        assert_eq!(f.sets.get("alc").copied(), Some(0), "the digital set counts nothing");
    }
}
```

Reuse Task 4's `seeded()` by making it `pub(crate) fn seeded()` in a shared `#[cfg(test)] mod fixtures` in `index/mod.rs`, and `use crate::index::fixtures::seeded;` here.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test facets`
Expected: FAIL — `compute` not found.

- [ ] **Step 3: Implement**

```rust
//! Facet counts over [`super::CardIndex`].
//!
//! **Every dimension is counted over a base carrying every filter EXCEPT its own.** That is
//! Solr's `excludeTags` rule and it is what keeps a multi-select usable: counted over the
//! full base, picking one set would report zero for every other set and grey the whole list
//! at the moment it was first used.
//!
//! Colours are the exception that proves the rule, and the reason spec §2 words it as "would
//! not change the result set" rather than "would return nothing": `colors` is **subset**
//! semantics, so with `U` on, pressing `W` asks for "castable in WU" — a superset. Their
//! number is therefore the size of the result *after* toggling, read against
//! [`FacetResponse::total`].

use super::bitset::BitSet;
use super::CardIndex;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedFacets {
    pub owned: i64,
    pub missing: i64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetResponse {
    /// Keyed `W`/`U`/`B`/`R`/`G`/`C`. **The size of the result set after toggling that
    /// chip**, not a count of cards carrying that colour.
    pub colors: BTreeMap<String, i64>,
    /// Keyed `"0"`–`"8"`, where `8` is eight-or-more. Plain counts.
    pub mana_values: BTreeMap<String, i64>,
    /// Keyed by `legalities` key. Plain counts.
    pub formats: BTreeMap<String, i64>,
    /// Keyed by set code, and **only** codes the base can still reach. Plain counts.
    pub sets: BTreeMap<String, i64>,
    pub owned: OwnedFacets,
    /// The current result size, which is what a colour count is compared against.
    pub total: i64,
    /// False when the index was cold and nothing was counted. The UI leaves every control
    /// live on `false` — not-greyed means "we do not know", never "this is empty".
    pub ready: bool,
}

/// Which filters a base leaves out.
#[derive(Clone, Copy, PartialEq)]
enum Skip {
    Nothing,
    Colors,
    Mana,
    Sets,
    Formats,
    Owned,
}

fn base(ix: &CardIndex, req: &crate::search::SearchRequest, text: Option<&BitSet>, skip: Skip) -> BitSet {
    // `paperOnly` defaults ON and is not a facet, so it is in every base.
    //
    // **`ix.all`, not a filled bitset.** Setting every bit up to `capacity` would include
    // rowid 0, which SQLite never issues, and every doc in the word-rounded padding above
    // the last real row — so `total` would read high by up to 64 on the one request that
    // asks for digital printings too. `all` is set per row during the build, so it holds
    // exactly the docs that exist.
    let mut b = if req.paper_only.unwrap_or(true) {
        ix.paper.clone()
    } else {
        ix.all.clone()
    };
    if let Some(t) = text {
        b = b.and(t);
    }
    if skip != Skip::Formats {
        if let Some(f) = crate::filters::nonblank(&req.format) {
            if let Some(k) = crate::legalities::LEGALITY_KEYS.iter().position(|k| *k == f) {
                b = b.and(&ix.formats[k]);
            } else {
                // A format this build does not know narrows to nothing, which is what the
                // SQL path's `json_extract` of an absent key does too.
                return BitSet::new(ix.capacity);
            }
        }
    }
    if skip != Skip::Colors {
        b = apply_colors(ix, &b, crate::filters::nonblank(&req.colors));
    }
    if skip != Skip::Mana {
        if let Some(values) = req.mana_values.as_deref() {
            if let Some(u) = union_mana(ix, values) {
                b = b.and(&u);
            }
        }
    }
    if skip != Skip::Sets {
        if let Some(u) = union_sets(ix, req.sets.as_deref()) {
            b = b.and(&u);
        }
    }
    if skip != Skip::Owned {
        match req.owned {
            Some(true) => b = b.and(&ix.owned),
            Some(false) => b = and_not(&b, &ix.owned),
            None => {}
        }
    }
    b
}

/// Subset semantics, expressed the way `push_card_filters` expresses it: a card is in when
/// its identity carries no letter outside the picked set. `"C"` means colourless only.
fn apply_colors(ix: &CardIndex, base: &BitSet, picked: Option<&str>) -> BitSet {
    let Some(picked) = picked else { return base.clone() };
    let picked = picked.to_ascii_uppercase();
    if picked == "C" {
        return base.and(&ix.colors[5]);
    }
    let mut out = base.clone();
    for (i, letter) in CardIndex::COLOR_KEYS.iter().enumerate().take(5) {
        if !picked.contains(*letter) {
            out = and_not(&out, &ix.colors[i]);
        }
    }
    out
}

fn and_not(a: &BitSet, b: &BitSet) -> BitSet {
    let mut out = BitSet::new(a.capacity());
    a.for_each(|d| {
        if !b.contains(d) {
            out.set(d);
        }
    });
    out
}

fn union_mana(ix: &CardIndex, values: &[u8]) -> Option<BitSet> {
    let mut any = false;
    let mut u = BitSet::new(ix.capacity);
    for v in values {
        let bucket = (*v as usize).min(8);
        ix.mana[bucket].for_each(|d| u.set(d));
        any = true;
    }
    any.then_some(u)
}

fn union_sets(ix: &CardIndex, sets: Option<&[String]>) -> Option<BitSet> {
    let sets = sets?;
    let picked: Vec<usize> = sets
        .iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .filter_map(|s| ix.set_codes.iter().position(|c| *c == s))
        .collect();
    if picked.is_empty() {
        return None;
    }
    let wanted: std::collections::HashSet<u16> = picked.iter().map(|i| *i as u16).collect();
    let mut u = BitSet::new(ix.capacity);
    for d in 0..ix.capacity as u32 {
        if wanted.contains(&ix.set_ord[d as usize]) {
            u.set(d);
        }
    }
    Some(u)
}

pub fn compute(
    ix: &CardIndex,
    req: &crate::search::SearchRequest,
    text: Option<&BitSet>,
) -> FacetResponse {
    let full = base(ix, req, text, Skip::Nothing);
    let mut out = FacetResponse { total: i64::from(full.count()), ready: true, ..Default::default() };

    // Sets: one walk of the base, bumping a counter per ordinal. Every code the base can
    // reach is emitted, including at zero — an absent key and a zero are the same answer to
    // the frontend, but emitting it keeps the tooltip honest.
    let sets_base = base(ix, req, text, Skip::Sets);
    let mut counts = vec![0i64; ix.set_codes.len()];
    sets_base.for_each(|d| counts[ix.set_ord[d as usize] as usize] += 1);
    for (i, code) in ix.set_codes.iter().enumerate() {
        out.sets.insert(code.clone(), counts[i]);
    }

    let mana_base = base(ix, req, text, Skip::Mana);
    for bucket in 0..=8 {
        out.mana_values
            .insert(bucket.to_string(), i64::from(mana_base.and_count(&ix.mana[bucket])));
    }

    let formats_base = base(ix, req, text, Skip::Formats);
    for (k, key) in crate::legalities::LEGALITY_KEYS.iter().enumerate() {
        out.formats
            .insert((*key).to_owned(), i64::from(formats_base.and_count(&ix.formats[k])));
    }

    // Colours: the result AFTER toggling each chip, because they broaden.
    let colors_base = base(ix, req, text, Skip::Colors);
    let picked = crate::filters::nonblank(&req.colors).unwrap_or("").to_ascii_uppercase();
    for letter in CardIndex::COLOR_KEYS {
        let after = toggle_colors(&picked, letter);
        let with = apply_colors(ix, &colors_base, (!after.is_empty()).then_some(after.as_str()));
        out.colors.insert(letter.to_string(), i64::from(with.count()));
    }

    let owned_base = base(ix, req, text, Skip::Owned);
    out.owned = OwnedFacets {
        owned: i64::from(owned_base.and_count(&ix.owned)),
        missing: i64::from(and_not(&owned_base, &ix.owned).count()),
    };

    out
}

/// The picked-colour string after one chip is pressed, mirroring `toggleColor` in
/// `useCardSearch.ts`: `C` is exclusive both ways, because the backend reads exactly `"C"`
/// as colourless-only and anything else as subset-of-these-letters.
fn toggle_colors(picked: &str, letter: char) -> String {
    if picked.contains(letter) {
        return picked.chars().filter(|c| *c != letter).collect();
    }
    if letter == 'C' {
        return "C".to_owned();
    }
    let mut out: String = picked.chars().filter(|c| *c != 'C').collect();
    out.push(letter);
    // WUBRG order, so the string a facet was computed for is the string the UI will send.
    CardIndex::COLOR_KEYS
        .iter()
        .take(5)
        .filter(|c| out.contains(**c))
        .collect()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test facets`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/index/facets.rs src-tauri/src/index/mod.rs
git commit -m "feat(search): count facets over the card index"
```

---

### Task 6: Lifecycle — building it, rebuilding it, and answering while it is cold

**Files:**
- Modify: `src-tauri/src/index/lifecycle.rs`, `src-tauri/src/sync.rs` (`AppState`), `src-tauri/src/lib.rs` (`init_state`), `src-tauri/src/collection.rs` and `src-tauri/src/db.rs` as the invalidation points require.

**Interfaces:**
- Consumes: `CardIndex::build`, `CardIndex::rebuild_owned`.
- Produces: `AppState.index: std::sync::RwLock<Option<std::sync::Arc<CardIndex>>>`; `lifecycle::spawn_build(state: &Arc<AppState>)`, `lifecycle::invalidate_owned(state: &Arc<AppState>)`, `lifecycle::current(state: &AppState) -> Option<Arc<CardIndex>>`.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// Cold is a real state and the app has to answer in it — during the ~0.5 s after
    /// launch, and again after every sync swap. `current` returning `None` is what makes
    /// every facet fail OPEN.
    #[test]
    fn an_unbuilt_index_reads_as_absent_rather_than_empty() {
        let state = crate::test_support::state_with_seeded_cards();
        assert!(current(&state).is_none());
    }

    #[test]
    fn a_built_index_is_published_and_readable() {
        let state = crate::test_support::state_with_seeded_cards();
        build_now(&state).unwrap();
        assert_eq!(current(&state).unwrap().paper.count(), 3);
    }

    /// A sync renumbers every rowid, so a stale index does not merely go out of date — it
    /// points at the wrong cards. Rebuilding must replace it wholesale.
    #[test]
    fn a_rebuild_replaces_the_index_rather_than_amending_it() {
        let state = crate::test_support::state_with_seeded_cards();
        build_now(&state).unwrap();
        let before = current(&state).unwrap();
        {
            let conn = state.db.lock().unwrap();
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw)
                 VALUES ('99','New Card','neo','1','en','normal',1,'{}')",
                [],
            )
            .unwrap();
        }
        build_now(&state).unwrap();
        let after = current(&state).unwrap();
        assert_eq!(before.paper.count(), 3, "the old index is untouched, not mutated");
        assert_eq!(after.paper.count(), 4);
    }

    /// The collection changes far more often than the corpus, and a full rebuild per
    /// quick-add would be ~0.5 s of work for one row.
    #[test]
    fn a_collection_write_rebuilds_only_the_owned_dimension() {
        let state = crate::test_support::state_with_seeded_cards();
        build_now(&state).unwrap();
        assert_eq!(current(&state).unwrap().owned.count(), 0);
        {
            let conn = state.db.lock().unwrap();
            conn.execute(
                "INSERT INTO collection_entries (card_id,set_code,collector_number,lang,finish,
                    quantity,created_at,updated_at)
                 VALUES ('1','lea','1','en','nonfoil',1,'2026-08-11','2026-08-11')",
                [],
            )
            .unwrap();
        }
        invalidate_owned(&state);
        assert_eq!(current(&state).unwrap().owned.count(), 1);
    }
}
```

Add `src-tauri/src/test_support.rs` (`#[cfg(test)]`-gated in `lib.rs`) with `state_with_seeded_cards() -> Arc<AppState>`, building an `AppState` over a temp-dir database seeded with Task 4's four fixture rows. Model it on the existing setup in `search::tests::a_search_answers_while_an_ingest_holds_the_write_connection`, which already constructs an `AppState` by hand.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test lifecycle`
Expected: FAIL — `AppState` has no field `index`.

- [ ] **Step 3: Implement**

Add to `AppState` in `sync.rs`:

```rust
    /// The in-memory facet index, or `None` while it is being built.
    ///
    /// `RwLock` and not `Mutex`: every facet request reads it and only a sync or a
    /// collection write replaces it. `Arc` so a reader clones the handle and lets the lock
    /// go immediately — a facet pass must never hold a lock a sync swap is waiting on.
    pub index: std::sync::RwLock<Option<std::sync::Arc<crate::index::CardIndex>>>,
```

In `lifecycle.rs`:

```rust
//! When the index is built, rebuilt and thrown away.
//!
//! **It is derived from `cards`, which every sync drops and recreates.** That renumbers
//! rowids, so a stale index does not go gently out of date — it points at the wrong cards.
//! Every rebuild therefore replaces the whole thing; nothing is amended in place except
//! `owned`, which is the one dimension a user changes without a sync.
//!
//! **Cold is a supported state, not an error.** For the length of a build the app answers
//! `ready: false` and every filter control stays live. Not-greyed means "we do not know".

use super::CardIndex;
use crate::sync::AppState;
use std::sync::Arc;

/// The current index, or `None` while cold. Clones the `Arc` and drops the read lock at
/// once, so a long facet pass never blocks a swap's rebuild.
pub fn current(state: &AppState) -> Option<Arc<CardIndex>> {
    state.index.read().ok().and_then(|g| g.clone())
}

/// Build on **its own read-only connection**, never `db_read`. The build is a full pass over
/// `cards`; holding `db_read` for it would queue every search behind it at launch, which is
/// the exact failure that second connection exists to prevent.
pub fn build_now(state: &Arc<AppState>) -> Result<(), String> {
    let conn = crate::db::open_read_only(&state.data_dir.join("mtg.db"))
        .map_err(|e| format!("index connection: {e}"))?;
    let ix = CardIndex::build(&conn).map_err(|e| format!("index build: {e}"))?;
    if let Ok(mut slot) = state.index.write() {
        *slot = Some(Arc::new(ix));
    }
    Ok(())
}

/// Build off the IPC thread. Failure is logged and leaves the index cold — the app then runs
/// exactly as it did before this feature existed, which is why nothing here is fatal.
pub fn spawn_build(state: &Arc<AppState>) {
    let state = state.clone();
    std::thread::spawn(move || {
        if let Err(e) = build_now(&state) {
            log::warn!("card index unavailable, facets will stay open: {e}");
        }
    });
}

/// Re-read the `owned` dimension after a collection write. 10–23 ms, against ~0.5 s for a
/// full rebuild, which is why this exists as its own entry point.
pub fn invalidate_owned(state: &Arc<AppState>) {
    let Some(current) = current(state) else { return };
    let Ok(conn) = crate::db::open_read_only(&state.data_dir.join("mtg.db")) else { return };
    let mut next = CardIndex::clone_shallow(&current);
    if next.rebuild_owned(&conn).is_ok() {
        if let Ok(mut slot) = state.index.write() {
            *slot = Some(Arc::new(next));
        }
    }
}
```

Add `CardIndex::clone_shallow` to `index/mod.rs` — a `#[derive(Clone)]` on `CardIndex` plus a named wrapper, so the intent (copy-on-write for one dimension) is written down rather than inferred.

Wire the three call sites:
- `lib.rs`'s `init_state`, after `prepare_database` succeeds: `index::lifecycle::spawn_build(&state);`
- `sync.rs`, after a successful swap (where `reconcile::sweep_orphans` already runs): `index::lifecycle::spawn_build(&state);`
- `collection.rs`, at the end of every command that writes (`collection_add`, `collection_set_quantity`, `collection_update`, `collection_remove`): `index::lifecycle::invalidate_owned(&state);` — **after the busy guard is dropped**, per CLAUDE.md's rule that a command must not build its answer while holding its own guard.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test lifecycle`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify`

```bash
git add src-tauri/src
git commit -m "feat(search): build the card index at launch and after every sync"
```

---

### Task 7: The `facet_cards` command

**Files:**
- Modify: `src-tauri/src/index/facets.rs` (the command), `src-tauri/src/lib.rs` (registration), `src/lib/ipc.ts` (the mirror)

**Interfaces:**
- Consumes: `facets::compute`, `lifecycle::current`.
- Produces: the `facet_cards` Tauri command taking `{ req: SearchRequest }`; `ipc.facetCards(req)` and `FacetResponse` in TypeScript.

- [ ] **Step 1: Write the failing tests**

In `facets.rs`:

```rust
    /// The frontend mirrors these names by hand in `src/lib/ipc.ts`; a rename here that is
    /// not mirrored there is a silently `undefined` field in the UI. Whole-value equality,
    /// so a field added and never mirrored fails as loudly as a rename.
    #[test]
    fn the_facet_json_uses_the_camel_case_names_the_frontend_expects() {
        let mut f = FacetResponse { total: 3, ready: true, ..Default::default() };
        f.colors.insert("W".into(), 1);
        f.mana_values.insert("0".into(), 2);
        f.formats.insert("modern".into(), 3);
        f.sets.insert("lea".into(), 4);
        f.owned = OwnedFacets { owned: 1, missing: 2 };
        assert_eq!(
            serde_json::to_value(f).unwrap(),
            serde_json::json!({
                "colors": {"W": 1},
                "manaValues": {"0": 2},
                "formats": {"modern": 3},
                "sets": {"lea": 4},
                "owned": {"owned": 1, "missing": 2},
                "total": 3,
                "ready": true
            })
        );
    }

    /// Cold has to be answerable, not an error: an error would surface as a failed query and
    /// the UI would have to guess what it meant. `ready: false` says it.
    #[test]
    fn a_cold_index_answers_not_ready_with_no_counts() {
        let f = FacetResponse { ready: false, ..Default::default() };
        assert!(!f.ready);
        assert!(f.sets.is_empty());
    }
```

Add to `src/lib/ipc.test.ts` (or create it if absent — check first) a type-level mirror test is not possible; instead pin the shape in `src/features/search/facets.test.ts` in Task 9.

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test facet_json`
Expected: FAIL — `FacetResponse` is not `Serialize`-complete / test not found.

- [ ] **Step 3: Implement**

Append to `facets.rs`:

```rust
/// Facet counts for one search.
///
/// A **separate command** from `search_cards` on purpose: facets depend on neither `sort`
/// nor `offset`, so they must not be recomputed per page, and they must never delay page
/// one. The frontend keys them on the filter half of the search key alone.
///
/// Answers `ready: false` rather than an error while the index is cold — see
/// [`super::lifecycle`].
#[tauri::command]
pub async fn facet_cards(
    state: tauri::State<'_, std::sync::Arc<crate::sync::AppState>>,
    req: crate::search::SearchRequest,
) -> Result<FacetResponse, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(ix) = super::lifecycle::current(&state) else {
            return Ok(FacetResponse { ready: false, ..Default::default() });
        };
        // The one thing that still needs the database: FTS has no precomputed bitset, so a
        // text search resolves to rowids and is turned into one. 25 ms at 100 129 matches,
        // which is the floor for any design (measured 2026-08-11).
        let text = match crate::filters::nonblank(&req.text).and_then(crate::filters::fts_query) {
            None => None,
            Some(query) => {
                let conn = crate::sync::lock_db_read(&state);
                let mut stmt = conn
                    .prepare("SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?")
                    .map_err(|e| e.to_string())?;
                let mut rows = stmt.query([query]).map_err(|e| e.to_string())?;
                let mut b = BitSet::new(ix.capacity);
                while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    let doc: i64 = row.get(0).map_err(|e| e.to_string())?;
                    b.set(doc as u32);
                }
                Some(b)
            }
        };
        Ok(compute(&ix, &req, text.as_ref()))
    })
    .await
    .map_err(|e| format!("facets could not be computed: {e}"))?
}
```

Register `index::facets::facet_cards` in `lib.rs`'s `generate_handler!` list, after `search::list_sets`.

Add to `src/lib/ipc.ts`, after `SearchResponse`:

```ts
/**
 * Facet counts for one search — how many results each filter option would leave.
 *
 * Mirrors `src-tauri/src/index/facets.rs`. **`ready: false` means the index is still
 * building**, not that everything is empty: the UI leaves every control live, because
 * not-greyed has to mean "we don't know" rather than "this is empty".
 */
export interface FacetResponse {
  /**
   * Keyed `W`/`U`/`B`/`R`/`G`/`C`, and **the size of the result set after toggling that
   * chip** rather than a count of cards carrying that colour. Colours are subset semantics,
   * so pressing one with another already on *broadens*; compare against {@link total}.
   */
  colors: Record<string, number>;
  /** Keyed `"0"`–`"8"`, `8` meaning eight-or-more. Plain counts. */
  manaValues: Record<string, number>;
  /** Keyed by `legalities` key. Plain counts. */
  formats: Record<string, number>;
  /** Keyed by set code. Plain counts; a code absent from the map has none. */
  sets: Record<string, number>;
  /** Both sides of the tri-state chip, for its tooltip. The chip is never disabled. */
  owned: { owned: number; missing: number };
  /** The current result size, which a colour count is read against. */
  total: number;
  ready: boolean;
}
```

and to the `ipc` object:

```ts
  /** Facet counts for one search. Never blocks the page — see `useCardFacets`. */
  facetCards: (req: SearchRequest) => invoke<FacetResponse>("facet_cards", { req }),
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && cargo test facets && cd .. && npm run build`
Expected: PASS, and TypeScript compiles.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src src/lib/ipc.ts
git commit -m "feat(search): add the facet_cards command and its mirror"
```

---

### Task 8: The Storybook fake

**Files:**
- Modify: `.storybook/fake/db.ts` (`readHandlers`, around :1512), `.storybook/fake/db.test.ts`

**Interfaces:**
- Consumes: `matchesCardFilters`, `nonblank`, `cardMatchesText` — already in `db.ts` and already the TS mirror of `push_card_filters`.
- Produces: `readHandlers(db).facet_cards({ req })` returning a `FacetResponse`.

The fake sits **under** `src/lib/ipc.ts`, so every story exercises the real mirror. Without this handler every story that mounts `FilterBar` throws on an unhandled command.

- [ ] **Step 1: Write the failing test**

Add to `.storybook/fake/db.test.ts`:

```ts
describe("facet_cards", () => {
  it("counts a dimension with its OWN filter removed, so a picked set does not grey the rest", () => {
    const db = makeDb();
    const f = readHandlers(db).facet_cards({
      req: { sets: ["lea"], limit: 0, offset: 0 },
    }) as FacetResponse;
    expect(f.sets["lea"]).toBeGreaterThan(0);
    // Every other set is still counted as if `sets` were not set at all.
    expect(Object.values(f.sets).filter((n) => n > 0).length).toBeGreaterThan(1);
  });

  it("reports colours as the result AFTER toggling, because colours broaden", () => {
    const db = makeDb();
    const none = readHandlers(db).facet_cards({ req: { limit: 0, offset: 0 } }) as FacetResponse;
    const red = readHandlers(db).facet_cards({
      req: { colors: "R", limit: 0, offset: 0 },
    }) as FacetResponse;
    expect(red.total).toBeLessThan(none.total);
    // Adding a second colour cannot shrink the answer.
    expect(red.colors["W"]).toBeGreaterThanOrEqual(red.total);
  });

  it("is ready, because a fake world has no warm-up", () => {
    expect((readHandlers(makeDb()).facet_cards({ req: { limit: 0, offset: 0 } }) as FacetResponse).ready).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:run -- .storybook/fake/db.test.ts`
Expected: FAIL — `facet_cards is not a function`.

- [ ] **Step 3: Implement**

Add to `readHandlers`'s returned object, after `search_cards`:

```ts
    /**
     * `index::facets::compute`.
     *
     * Derived from the same `matchesCardFilters` the fake's `search_cards` uses, so the two
     * cannot disagree about what a filter means — which is the whole point of the fake
     * storing rows and deriving DTOs rather than storing DTOs.
     *
     * `ready` is always true: a fake world has no warm-up, and a story that wants the cold
     * state sets the `indexCold` fault instead.
     */
    facet_cards: (args: { req: SearchRequest }): FacetResponse => {
      const req = args.req;
      const text = nonblank(req.text);
      // Every base carries text and the paper default; each dimension drops its own filter.
      const base = (skip: "colors" | "mana" | "sets" | "formats" | "owned" | null) =>
        db.cards.filter((c) => {
          if (text !== null && !cardMatchesText(c, text)) return false;
          const f: SearchRequest = { ...req, text: undefined };
          if (skip === "colors") f.colors = undefined;
          if (skip === "mana") f.manaValues = undefined;
          if (skip === "sets") f.sets = undefined;
          if (skip === "formats") f.format = undefined;
          if (!matchesCardFilters(c, f, null)) return false;
          if (skip !== "owned" && req.owned !== undefined) {
            const has = db.collectionEntries.some((e) => e.cardId === c.id);
            if (req.owned !== has) return false;
          }
          return true;
        });

      const count = (rows: FakeCard[]) => rows.length;
      const sets: Record<string, number> = {};
      for (const c of base("sets")) sets[c.setCode] = (sets[c.setCode] ?? 0) + 1;

      const manaValues: Record<string, number> = {};
      const manaBase = base("mana");
      for (let v = 0; v <= 8; v++) {
        // **Exact equality below 8, a range at 8** — mirroring `push_card_filters`, which
        // spells chips 0–7 as `cmc IN (0.0, …)` and chip 8 as `cmc >= 8.0`. So a fractional
        // cost belongs to no chip below 8 but *does* belong to chip 8: `Math.trunc` here
        // would count `Little Girl` (cmc 0.5, the corpus' only fractional printing) under
        // chip 0, which the search would then not return.
        manaValues[String(v)] = manaBase.filter((c) =>
          c.cmc === null ? false : v === 8 ? c.cmc >= 8 : c.cmc === v,
        ).length;
      }

      const formats: Record<string, number> = {};
      const formatBase = base("formats");
      for (const key of LEGALITY_KEYS) {
        formats[key] = formatBase.filter((c) =>
          ["legal", "restricted"].includes(c.legalities?.[key] ?? ""),
        ).length;
      }

      // Colours: the result after toggling, mirroring `toggle_colors` in Rust.
      const colors: Record<string, number> = {};
      const colorBase = base("colors");
      for (const letter of ["W", "U", "B", "R", "G", "C"]) {
        const after = toggleColorString(req.colors ?? "", letter);
        colors[letter] = colorBase.filter((c) =>
          matchesCardFilters(c, { colors: after || undefined, limit: 0, offset: 0 }, null),
        ).length;
      }

      const ownedBase = base("owned");
      const ownedRows = ownedBase.filter((c) => db.collectionEntries.some((e) => e.cardId === c.id));
      return {
        colors,
        manaValues,
        formats,
        sets,
        owned: { owned: count(ownedRows), missing: count(ownedBase) - count(ownedRows) },
        total: count(base(null)),
        ready: db.fault !== "indexCold",
      };
    },
```

Add a module-scope `toggleColorString` helper to `db.ts` mirroring Rust's `toggle_colors`, and `LEGALITY_KEYS` (import from a shared constant if `db.ts` already has one; otherwise declare it beside the helper with a comment pointing at `src-tauri/src/legalities.rs`). Add `"indexCold"` to the fake's fault union.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:run -- .storybook/fake/db.test.ts`
Expected: PASS, 3 new tests.

- [ ] **Step 5: Commit**

```bash
git add .storybook/fake
git commit -m "test(storybook): teach the fake to answer facet_cards"
```

---

### Task 9: The greying rule, and the controls that wear it

**Files:**
- Create: `src/features/search/facets.ts`, `src/features/search/facets.test.ts`, `src/features/search/useCardFacets.ts`
- Modify: `src/components/FilterChips.tsx`, `src/features/search/FilterBar.tsx`, `src/features/search/SetCombobox.tsx`, `src/features/search/useCardSearch.ts`

**Interfaces:**
- Consumes: `ipc.facetCards`, `FacetResponse` (Task 7).
- Produces: `optionDisabled(counts, key, selected)`, `colorDisabled(after, total, selected)`, `facetTitle(label, count)`; `useCardFacets(filters) -> { facets: FacetResponse | undefined }`; `ManaChip`/`ManaValueChips`/`ToggleChip` gain optional `disabled?: boolean` and `title?: string`.

- [ ] **Step 1: Write the failing tests**

`src/features/search/facets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { colorDisabled, optionDisabled } from "./facets";

describe("the greying rule", () => {
  it("greys an option whose count is zero, and only that one", () => {
    expect(optionDisabled({ lea: 0 }, "lea", false)).toBe(true);
    expect(optionDisabled({ lea: 3 }, "lea", false)).toBe(false);
  });

  /** The way out of a dead end has to stay open, or a reader who filters into nothing is
   *  stuck with every control greyed and no way back. */
  it("never greys an option that is currently selected", () => {
    expect(optionDisabled({ lea: 0 }, "lea", true)).toBe(false);
  });

  /** Not-greyed means "we don't know". A cold index or a failed query must not disable
   *  anything, because a wrongly-greyed control hides cards that exist. */
  it("fails open when there are no counts at all", () => {
    expect(optionDisabled(undefined, "lea", false)).toBe(false);
  });

  it("treats a key the backend never mentioned as empty", () => {
    expect(optionDisabled({ lea: 2 }, "neo", false)).toBe(true);
  });

  describe("colours, which broaden rather than narrow", () => {
    /** With `U` on, pressing `W` asks for a superset — so "would return nothing" is the
     *  wrong question and "would change nothing" is the right one. */
    it("greys a colour that would leave the result set unchanged", () => {
      expect(colorDisabled(40, 40, false)).toBe(true);
    });

    it("greys a colour that would empty the result set", () => {
      expect(colorDisabled(0, 40, false)).toBe(true);
    });

    it("leaves a colour live when toggling it changes the answer", () => {
      expect(colorDisabled(58, 40, false)).toBe(false);
      expect(colorDisabled(12, 40, false)).toBe(false);
    });

    it("never greys a selected colour, and fails open without a count", () => {
      expect(colorDisabled(40, 40, true)).toBe(false);
      expect(colorDisabled(undefined, 40, false)).toBe(false);
    });
  });
});
```

Add to `src/features/search/FilterBar.test.tsx`:

```tsx
it("greys the options a facet answer reports as empty, and keeps them reachable", async () => {
  // …render FilterBar with a facets prop whose `sets` has one zero entry and whose
  // `manaValues["7"]` is 0…
  const chip = screen.getByRole("button", { name: "Mana value 7" });
  expect(chip).toHaveAttribute("aria-disabled", "true");
  // `aria-disabled`, NOT `disabled`: a disabled button leaves the tab order, and a keyboard
  // reader would watch the filter row shrink and grow as they type.
  expect(chip).not.toBeDisabled();
  await userEvent.click(chip);
  expect(onToggleManaValue).not.toHaveBeenCalled();
});

it("leaves every control live while the index is still building", async () => {
  // …render with `{ ready: false }`…
  expect(screen.getByRole("button", { name: "Mana value 7" })).not.toHaveAttribute("aria-disabled");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:run -- src/features/search`
Expected: FAIL — `./facets` does not exist.

- [ ] **Step 3: Implement**

`src/features/search/facets.ts`:

```ts
import type { FacetResponse } from "@/lib/ipc";

/**
 * Whether a filter option should be drawn as unavailable.
 *
 * **Three rules, and the order matters.** A *selected* option is never greyed — the way out
 * of a dead end has to stay open, and if a search matches nothing at all then every
 * unselected option greys and `Reset all` is the escape. **Absent counts fail open**,
 * because not-greyed means "we don't know" while greyed means "this is empty", and only one
 * of those is safe to guess. A key the answer never mentioned has none.
 */
export function optionDisabled(
  counts: Record<string, number> | undefined,
  key: string,
  selected: boolean,
): boolean {
  if (selected || !counts) return false;
  return (counts[key] ?? 0) === 0;
}

/**
 * The same question for a colour chip, which needs a different one asked.
 *
 * `colors` is subset semantics: with `U` on, pressing `W` asks for "castable in WU", which
 * is a *superset*. So a colour chip cannot be greyed for returning nothing — it is greyed
 * when pressing it would not change the result set, which covers both directions. `after`
 * is the size of the result set the press would produce.
 */
export function colorDisabled(
  after: number | undefined,
  total: number,
  selected: boolean,
): boolean {
  if (selected || after === undefined) return false;
  return after === 0 || after === total;
}

/**
 * The tooltip and the accessible name for one option.
 *
 * **The number is printings**, and says so: the search view collapses printings into cards,
 * so a facet count and the list's own total count different things. Greying is unaffected —
 * zero printings is zero cards — and the word is the whole fix.
 */
export function facetTitle(label: string, count: number | undefined): string | undefined {
  if (count === undefined) return undefined;
  if (count === 0) return `${label} — nothing in this search`;
  return `${label} — ${count.toLocaleString()} printings`;
}

/** The facet counts a control needs, or `undefined` when nothing is known. */
export function facetsOrUndefined(f: FacetResponse | undefined): FacetResponse | undefined {
  return f?.ready ? f : undefined;
}
```

`src/features/search/useCardFacets.ts`:

```ts
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ipc, type SearchRequest } from "@/lib/ipc";

/**
 * Facet counts for the current filters.
 *
 * **Keyed on the filters alone** — no sort, no offset. Facets do not depend on either, and
 * keying on the full search key would recompute them on every page and every header press.
 *
 * `keepPreviousData` so the chips hold their last answer while a new one is in flight
 * rather than flickering open and closed on every keystroke. The window is short — the worst
 * measured pass is 57 ms — and a stale answer that is one filter out of date is a better
 * reader experience than a row that blinks.
 */
export function useCardFacets(req: SearchRequest, enabled = true) {
  return useQuery({
    queryKey: ["cards", "facets", req],
    queryFn: () => ipc.facetCards(req),
    placeholderData: keepPreviousData,
    enabled,
  });
}
```

In `useCardSearch.ts`, build the facet request from the same debounced filter values the search uses (text, format, colors, sets, manaValues, owned — **not** sort, offset or collapse), call `useCardFacets`, and return `facets: facetsOrUndefined(query.data)` on the object `FilterBar` already consumes.

In `FilterChips.tsx`, give `ManaChip`, `ManaValueChips` and `ToggleChip` an optional `disabled?: boolean` and `title?: string`. Each renders `aria-disabled={disabled || undefined}`, keeps `type="button"` focusable, guards its `onClick` with `if (disabled) return;`, and adds `opacity-45` when disabled — the same treatment `SetCombobox`'s capped options already use, so the row has one vocabulary for unavailable.

In `FilterBar.tsx`, pass `disabled` and `title` from `search.facets` through `optionDisabled`/`colorDisabled`/`facetTitle`. In the format `<select>`, mark each `<option disabled={…}>` — native, and correct for a listbox.

In `SetCombobox.tsx`, thread a `counts?: Record<string, number>` prop; an option is `disabled` when `optionDisabled(counts, s.code, selected.includes(s.code))`, which the existing `disabled` path already renders. Keep the existing `cardCount > 0` filter — that hides sets with no printings **at all**, which is a fact about the corpus rather than about this search.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:run -- src/features/search src/components`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify`

```bash
git add src
git commit -m "feat(search): grey the filter options this search cannot reach"
```

---

### Task 10: Stories, the live pass, and the documentation

**Files:**
- Modify: `src/features/search/FilterBar.stories.tsx`, `src/features/search/SearchPage.stories.tsx`, `CLAUDE.md`

- [ ] **Step 1: Add the stories**

Three, on the existing seeds: a normal search where some options are greyed, a search narrowed until most of the row is unavailable, and the `indexCold` fault where **everything stays live**. Each gets a `play` asserting `aria-disabled` (or its absence), since `src/stories.test.tsx` runs every `play` under Vitest and that is what puts a story's claim inside `npm run verify`.

- [ ] **Step 2: Run the story tests**

Run: `npm run test:run -- src/stories.test.tsx`
Expected: PASS.

- [ ] **Step 3: Drive the real window**

A green Storybook proves nothing about the shipped window. Per CLAUDE.md:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
npm run tauri dev
```

Then from another shell, with `scripts/cdp.mjs`:

- `console out.jsonl` first, and check the line count at the end — a recorder dies with the window it is attached to and says nothing about it.
- Type a term, then check a greyed chip really is unpressable: `node scripts/cdp.mjs click "[aria-label='Mana value 7']"` and confirm the result count did not move.
- Confirm the greying appears at all on the **116k-card corpus**, not just on fixtures — this is the pass that would catch a facet request that never fires, or one that fires per page.
- Check the first ~500 ms after launch: every control live, nothing greyed, no flash of disabled chips.
- Time a facet pass in the real app and compare it against the spec's 57 ms worst case.

Copy a synced database in rather than syncing — see the worktree note in CLAUDE.md — and delete any seeded user rows afterwards.

- [ ] **Step 4: Update CLAUDE.md**

Add to the Data & sync section, or a new one:

- Schema is **v9** (see the renumbering note at the top of this plan); `legal_mask` and what
  freezes its key order. *Partly done by the merge that renumbered it — the "Schema is v9"
  paragraph and the `CARDS_INDEXES`-replay invariant are already in CLAUDE.md; what is still
  owed is the key-order freeze.*
- `idx_cards_collapse` now carries the filter columns, with the 505 ms → 41 ms figure and the +0.89 MB / 4 ms cost.
- The `CardIndex`: what it is, that it is derived and rebuilt wholesale, that cold means fail-open, and the measured warm-up from Task 4 Step 5.
- **The Storybook fake's fault list**, which was already three faults stale before this plan
  (`deckMeta`, `updateAvailable`, `updateError`) and gained `indexCold` in Task 8. CLAUDE.md
  names four; the union now holds eight. A prose-only edit routes to neither CI job, which is
  exactly why it rots.
- **Correct the stale 277 ms browse figure.** The uncollapsed browse is 10.5 ms and the collapsed one 54 ms, both measured 2026-08-11; `idx_cards_collapse` is why.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify`

```bash
git add src CLAUDE.md
git commit -m "docs(search): record the index, the widened index, and a corrected browse figure"
```

---

## Plan A self-review

**Spec coverage.** §2's rule → Tasks 5 and 9. §2.1's per-control table → Task 9. §5.1 schema → Task 2. §5.2 `CardIndex` and lifecycle → Tasks 3, 4, 6. §5.3 `facet_cards` → Task 7. §6 frontend → Task 9. §7 testing → every task, plus Task 10 for stories and the live pass. §5.4 (the search on the index) and §9's Plan B are **deliberately absent** — that is Plan B.

**One gap, named rather than papered over:** the spec's §7 asks for a test that the mask agrees with `json_extract` across all 23 keys over real data. Task 1 pins the mapping and Task 2 pins the backfill on a fixture, but neither compares the two over the 116k-row corpus. That comparison belongs in Task 10's live pass as a one-off query, and it is written into Step 3 above.

**Placeholders:** none. Task 9's `FilterBar.test.tsx` additions carry an ellipsis in the render setup, which is a pointer at the file's existing helper rather than an unwritten decision; the assertions themselves are complete.

**Type consistency:** `FacetResponse` is `colors`/`manaValues`/`formats`/`sets`/`owned`/`total`/`ready` in Rust (Task 5), TypeScript (Task 7), the fake (Task 8) and the frontend (Task 9). `optionDisabled(counts, key, selected)` and `colorDisabled(after, total, selected)` keep their signatures between Task 9's tests and its implementation. `CardIndex::MANA_BUCKETS` is 10 in Task 4 and bucket 9 is excluded from the response in Task 5, matching `mana_buckets_are_keyed_by_the_chip`.
