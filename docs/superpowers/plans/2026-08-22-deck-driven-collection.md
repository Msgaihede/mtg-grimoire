# Deck Driven Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Settings toggle that makes the Collection page — and every other "what do I own"
figure in the app — read the sum of every `live` deck row instead of the reader's hand-entered
`collection_entries`.

**Architecture:** One new `app_meta` bit (`deck_driven.rs`, copied from `nav.rs`) and one new
module that owns the rule (`collection_source.rs`). The rule is `deck_cards.variant = 'live'`
and it is presented in two shapes: a **grouped row source** for the two commands that list
whole rows, and **direct-read correlated fragments** for the five readers that only ask "does
the reader own this" or "how many" — because a correlated read of a `GROUP BY` inside
`search.rs`'s 116 000-row query would recompute the whole deck sum once per candidate row.
Nothing is materialized and nothing is migrated, so the collection cannot drift out of sync
with the decks: there is nothing stored to drift.

**Tech Stack:** Rust (rusqlite, Tauri 2.11), TypeScript 6 / React 19, TanStack Query,
Vitest, Storybook.

**Spec:** [`docs/superpowers/specs/2026-08-22-deck-driven-collection-design.md`](../specs/2026-08-22-deck-driven-collection-design.md)

**Issue:** [#168](https://github.com/Msgaihede/mtg-grimoire/issues/168)

## Global Constraints

- **The rule is `deck_cards.variant = 'live'` and nothing else.** No `deck_categories` join, no
  `is_active` predicate, no `decks.archived` predicate. An inactive Maybeboard and an archived
  deck both count — the reader still has the cards.
- **`deck_cards.finish` is `NULL | 'foil' | 'etched'`; `collection_entries.finish` is
  `NOT NULL` and spells `'nonfoil'`.** Every derived read translates with
  `coalesce(dc.finish, 'nonfoil')`, in the SELECT *and* in any `GROUP BY` or equality that
  uses it. Binding the NULL straight through makes every regular copy read zero.
- **The `app_meta` key is `deck_driven_collection`, stored as `"1"` / `"0"`.** `false` writes
  `"0"`; it does not delete the row.
- **The refusal sentence, verbatim, one constant:** `"Your collection is driven by your decks.
  Turn the setting off in Settings to edit it by hand."`
- **No new dependency, no schema migration, no capabilities entry.** `app_meta` has existed
  since schema v6, and Tauri v2's ACL never gates an app's own `#[tauri::command]`.
- **No `@types/node`, ever.** Its absence is the only fence keeping Node types out of the app
  program.
- **Multi-line SQL in Rust uses real newlines, not `\` continuations.** `OWNED_SPARE_SQL`
  (`deck_theory.rs:202`) is the house style. A `\` continuation strips the newline *and* the
  leading whitespace, so it silently glues two SQL tokens together unless a trailing space is
  left before it — and `cargo fmt` will not tell you.
- **Subagents do not run `npm run verify` and do not commit.** The git index is shared across
  every agent in this worktree, so a bare `git commit` takes whatever a sibling staged. The
  controller commits after each wave and runs verify once per wave.
- **A `cargo test <filter>` that selects nothing exits 0.** Report the selected count with
  every "expected PASS", or the claim proves nothing.
- **`npm run verify`'s exit code lies through a pipe.** Redirect to a file and grep the
  summary; `| tail` reports tail's 0 while tests fail.
- **Never run two verifies at once** — concurrent runs fake ~18 Rust schema failures.

## Execution Order

Six waves. Within a wave no two tasks touch the same file, so they can be dispatched in one
message and run at once. Between waves the controller runs `npm run verify`, fixes anything
red, and commits.

| Wave | Tasks | Files |
| --- | --- | --- |
| A | 1 | `deck_driven.rs` (new), `lib.rs` |
| B | 2 | `collection_source.rs` (new), `collection.rs` (the helper move), `reset.rs`, `deck_driven.rs` (repoint) |
| C | 3, 4, 5, 6, 7 | `collection.rs` · `search.rs`+`index/mod.rs`+`wishlist.rs` · `import.rs` · `deck.rs`+`deck_theory.rs`+`deck_meta.rs`+`deck_undo.rs`+`reconcile.rs` · `collection_decks.rs` (new)+`lib.rs` |
| D | 8 | `src/lib/ipc.ts`, `src/lib/useDeckDrivenCollection.ts` (new) |
| E | 9, 10, 11, 12 | `.storybook/fake/*` · `features/settings/*` · `features/collection/Collection*` · the four write surfaces |
| F | 13, 14 | docs + stories · the real window |

Wave B is a single task on purpose: every task in wave C consumes its API.

---

### Task 1: The setting — one bit in `app_meta`

**Files:**
- Create: `src-tauri/src/deck_driven.rs`
- Modify: `src-tauri/src/lib.rs` (the `mod` list, and the `invoke_handler` list at `:375-380`)
- Test: inline `#[cfg(test)] mod tests` in `src-tauri/src/deck_driven.rs`

**Interfaces:**
- Consumes: `crate::update::get_app_meta` / `set_app_meta` (`update.rs:291`, `:302`);
  `crate::collection::with_write_owned` (`collection.rs:679`, already `pub(crate)`);
  `crate::sync::{lock_db_read, AppState}`.
- Produces:
  - `pub const K_DECK_DRIVEN: &str = "deck_driven_collection"`
  - `pub fn stored(conn: &Connection) -> bool`
  - `pub fn store(conn: &Connection, enabled: bool) -> Result<(), String>`
  - command `deck_driven_collection(state) -> bool`
  - command `set_deck_driven_collection(state, enabled: bool) -> Result<(), String>`

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/deck_driven.rs`. Model the harness on `nav.rs`'s own
`#[cfg(test)] mod tests` — open an in-memory connection and run `schema::migrate` on it, the
way every other `app_meta` module's tests do.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    fn db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        schema::migrate(&mut conn).unwrap();
        conn
    }

    #[test]
    fn a_fresh_database_is_not_deck_driven() {
        assert!(!stored(&db()));
    }

    #[test]
    fn a_stored_choice_reads_back() {
        let conn = db();
        store(&conn, true).unwrap();
        assert!(stored(&conn));
    }

    /// The case a "the row's existence is the setting" implementation reads correctly and
    /// clears wrong. `nav.rs`'s `expanding_again_clears_a_stored_collapse` is this test.
    #[test]
    fn switching_it_off_again_clears_a_stored_on() {
        let conn = db();
        store(&conn, true).unwrap();
        store(&conn, false).unwrap();
        assert!(!stored(&conn));
        assert_eq!(
            crate::update::get_app_meta(&conn, K_DECK_DRIVEN).as_deref(),
            Some("0"),
            "off must write a value, not delete the row"
        );
    }

    /// Everything that is not exactly "1" is off, and the breadth of that is the rule: a
    /// hand-edit, or a build that spelled the value differently, must not fail anything.
    #[test]
    fn junk_in_the_row_reads_as_off() {
        let conn = db();
        for junk in ["true", "yes", "2", "", "on"] {
            crate::update::set_app_meta(&conn, K_DECK_DRIVEN, junk).unwrap();
            assert!(!stored(&conn), "{junk:?} should read as off");
        }
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```
cargo test --manifest-path src-tauri/Cargo.toml deck_driven
```
Expected: FAIL to compile — `deck_driven` module does not exist. Report the selected test
count once it does compile.

- [ ] **Step 3: Write the module**

Create `src-tauri/src/deck_driven.rs`:

```rust
//! Whether the reader's collection is derived from their decks.
//!
//! One bit in `app_meta` (schema v6) — **no migration**, the same as [`crate::nav`], whose
//! shape this module copies wholesale. When it is on, every "what does the reader own"
//! query in the crate reads the sum of the `live` deck lists instead of
//! `collection_entries`; [`crate::collection_source`] owns that rule and this module owns
//! only the bit.
//!
//! **Nothing is deleted when it goes on.** The reader's hand-built rows stay on disk and
//! come back untouched the moment it goes off, which is the whole reason the switch is safe
//! to try — and the reason the five collection writes refuse while it is on rather than
//! writing somewhere invisible (see [`crate::collection`]).

use crate::sync::AppState;
use rusqlite::Connection;
use std::sync::Arc;

/// The `app_meta` key.
///
/// `app_meta` is the *application's* key/value table, deliberately not `sync_meta` — a row in
/// that one the sync did not write makes every later timing claim a fiction.
pub const K_DECK_DRIVEN: &str = "deck_driven_collection";

/// What a deck-driven collection is written as, and the *only* string that reads back as one.
///
/// Named rather than inlined because [`stored`] and [`store`] have to agree on it character
/// for character: the read is an equality test with no parser behind it, so a second spelling
/// at the write end would not fail anywhere — the reader's choice would simply never come
/// back, on every launch, with nothing logged.
const ON: &str = "1";

/// What a hand-kept collection is written as.
///
/// It matters that switching off writes a value rather than deleting the row: that is the
/// state [`stored`] answers for a missing row anyway, so the temptation is to treat the row's
/// *existence* as the setting. That implementation reads correctly and clears wrong — see
/// `switching_it_off_again_clears_a_stored_on`.
const OFF: &str = "0";

/// Is the collection derived from the reader's decks?
///
/// **Infallible, and that breadth is the rule**: no row (a fresh install, and the common
/// case), an unreadable row (`get_app_meta` swallows the error), `"true"`, `"yes"`, `"2"` —
/// every one of them answers `false`, which is the hand-kept collection the reader's rows are
/// still sitting in. That is the right floor: the degraded state shows them their own data.
///
/// Called inside query builders on a connection the caller already holds, which is the shape
/// `crate::deck_meta::readback_marketplace` established (`deck_meta.rs:431`) — a Rust value
/// that picks a SQL branch, never a bound parameter.
pub fn stored(conn: &Connection) -> bool {
    crate::update::get_app_meta(conn, K_DECK_DRIVEN).as_deref() == Some(ON)
}

/// Remember whether the collection is deck driven.
///
/// **No refusals**, unlike [`crate::zoom::store`]: a `bool` off the IPC boundary has no junk
/// state — `serde` has already rejected everything that is not `true` or `false` — so there
/// is nothing here for a validation arm to catch. The `Result` is SQLite's.
pub fn store(conn: &Connection, enabled: bool) -> Result<(), String> {
    let value = if enabled { ON } else { OFF };
    crate::update::set_app_meta(conn, K_DECK_DRIVEN, value)
        .map_err(|e| format!("could not save the collection setting: {e}"))
}

/// Whether the collection is derived from the reader's decks.
///
/// **Infallible by signature**, [`crate::nav::nav_collapsed`]'s contract for its reason: there
/// is nothing the page could do with an error here that is not "draw the hand-kept
/// collection", so this answers that instead of making the caller spell it out.
#[tauri::command(async)]
pub fn deck_driven_collection(state: tauri::State<'_, Arc<AppState>>) -> bool {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember the choice. Answers [`crate::db::BUSY`] if a sync holds the write connection.
///
/// **Through [`crate::collection::with_write_owned`], not bare `with_write`** — and that is
/// the one line of this module that is not [`crate::nav`]'s. Flipping this bit changes which
/// cards are owned without touching either table, so the facet index's `owned` dimension is
/// stale the instant the write lands. It is the one index dimension that moves without a
/// sync, and nothing on screen would say so.
///
/// **A refusal here IS surfaced**, unlike the nav rail's. That switch costs a reader one
/// launch's starting state; this one changes what their whole Collection page is a list of,
/// so a write that silently did not land would leave the page and the setting disagreeing
/// until the next restart.
#[tauri::command]
pub async fn set_deck_driven_collection(
    state: tauri::State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::collection::with_write_owned(&state, |conn| store(conn, enabled))
    })
    .await
    .map_err(|e| format!("the collection setting could not be saved: {e}"))?
}
```

- [ ] **Step 4: Register the module and its two commands**

In `src-tauri/src/lib.rs`, add `mod deck_driven;` to the module list (alphabetical, between
`deck_audit`/`deck_meta` and its neighbours as the existing list orders them), and add two
lines to `invoke_handler`, immediately after `nav::set_nav_collapsed` in the settings block
at `:375-380`:

```rust
            deck_driven::deck_driven_collection,
            deck_driven::set_deck_driven_collection,
```

- [ ] **Step 5: Run the tests to verify they pass**

```
cargo test --manifest-path src-tauri/Cargo.toml deck_driven
```
Expected: PASS, 4 tests selected. State the selected count.

- [ ] **Step 6: Report to the controller**

Do not commit. Report: files changed, the four test names, and the selected count.

---

### Task 2: `collection_source.rs` — one rule, two shapes

**Files:**
- Create: `src-tauri/src/collection_source.rs`
- Modify: `src-tauri/src/lib.rs` (`mod collection_source;`)
- Modify: `src-tauri/src/collection.rs:670-689` — delete `with_write_owned`, re-export nothing,
  and repoint the five `with_write_owned(...)` call sites at `:696`, `:709`, `:723`, `:735`,
  `:750` to `crate::collection_source::with_write_owned`
- Modify: `src-tauri/src/reset.rs` — the one `collection::with_write_owned` call in
  `collection_clear` becomes `collection_source::with_write_owned`
- Modify: `src-tauri/src/deck_driven.rs` — the same repoint in `set_deck_driven_collection`
- Test: inline `#[cfg(test)] mod tests` in `src-tauri/src/collection_source.rs`

**Interfaces:**
- Consumes: `crate::deck_driven::stored` (Task 1); `crate::sync::{with_write, lock_db_read,
  AppState}`; `crate::index::lifecycle::invalidate_owned`.
- Produces:
  - `pub const LIVE: &str = "dc.variant = 'live'"`
  - `pub fn rows(conn: &Connection, alias: &str) -> String` — a `FROM` fragment
  - `pub fn owns_printing(conn: &Connection, card_col: &str) -> String` — an `EXISTS (…)`
  - `pub fn copies_of_printing(conn: &Connection, card_col: &str) -> String` — a
    `coalesce((SELECT sum(…)), 0)`
  - `pub fn copies_of_oracle(conn: &Connection, oracle_col: &str) -> String` — the same,
    across every printing of one oracle card
  - `pub fn owned_rowids(conn: &Connection) -> String` — a whole `SELECT DISTINCT c.rowid …`
  - `pub(crate) fn with_write_owned<T>(state, f) -> Result<T, String>` — always invalidates
  - `pub(crate) fn with_write_owned_if_derived<T>(state, f) -> Result<T, String>` —
    invalidates only when the setting is on

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    /// A database with one deck holding cards, and the equivalent hand-built collection.
    /// `cards` is seeded here because a worktree database has never synced — and these rows
    /// are torn down with the connection, so no later measurement is made a fiction by them.
    fn db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        schema::migrate(&mut conn).unwrap();
        conn.execute_batch(
            "INSERT INTO cards (id, oracle_id, name, set_code, set_name, collector_number,
                                lang, rarity, layout, is_paper, finishes)
             VALUES ('p1','o1','Sol Ring','cmr','Commander Legends','472','en','uncommon',
                     'normal',1,'[\"nonfoil\",\"foil\"]'),
                    ('p2','o1','Sol Ring','ltr','Lord of the Rings','300','en','uncommon',
                     'normal',1,'[\"nonfoil\"]');

             INSERT INTO decks (id, name, created_at, updated_at)
                  VALUES (1,'Atraxa',0,0), (2,'Krenko',0,0), (3,'Plan only',0,0);
             INSERT INTO deck_categories (id, deck_id, name, kind, is_active, sort_order,
                                          created_at, updated_at)
                  VALUES (10,1,'Ramp','main',1,0,0,0),
                         (11,1,'Maybeboard','maybe',0,1,0,0),
                         (12,2,'Ramp','main',1,0,0,0),
                         (13,3,'Ramp','main',1,0,0,0);
             INSERT INTO deck_cards (deck_id, category_id, variant, card_id, set_code,
                                     collector_number, lang, name, quantity, finish,
                                     created_at, updated_at)
                  VALUES (1,10,'live','p1','cmr','472','en','Sol Ring',1,NULL,0,0),
                         (1,11,'live','p1','cmr','472','en','Sol Ring',2,NULL,0,0),
                         (1,10,'live','p1','cmr','472','en','Sol Ring',1,'foil',0,0),
                         (2,12,'live','p1','cmr','472','en','Sol Ring',1,NULL,0,0),
                         (3,13,'theory','p2','ltr','300','en','Sol Ring',4,NULL,0,0);",
        )
        .unwrap();
        conn
    }

    /// `sum(quantity)` for one printing+finish+lang out of whichever source is live.
    fn copies(conn: &Connection, card_id: &str, finish: &str) -> i64 {
        let sql = format!(
            "SELECT coalesce(sum(e.quantity), 0) FROM {}
              WHERE e.card_id = ?1 AND e.finish = ?2",
            rows(conn, "e")
        );
        conn.query_row(&sql, rusqlite::params![card_id, finish], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn off_it_is_the_table() {
        let conn = db();
        assert_eq!(rows(&conn, "e"), "collection_entries e");
    }

    /// Three live rows of the regular printing across two decks — one of them in an
    /// **inactive** category, which counts, because the reader still has the cards.
    #[test]
    fn on_it_sums_every_live_row_including_inactive_categories() {
        let conn = db();
        crate::deck_driven::store(&conn, true).unwrap();
        assert_eq!(copies(&conn, "p1", "nonfoil"), 4);
    }

    /// A theory row is a plan, not a card the reader has.
    #[test]
    fn on_it_excludes_theory() {
        let conn = db();
        crate::deck_driven::store(&conn, true).unwrap();
        assert_eq!(copies(&conn, "p2", "nonfoil"), 0);
    }

    /// `deck_cards.finish` is NULL for the regular copy and the collection spells it
    /// `nonfoil`. Binding the NULL through would make every regular line read zero.
    #[test]
    fn on_a_foil_and_a_regular_copy_are_two_rows() {
        let conn = db();
        crate::deck_driven::store(&conn, true).unwrap();
        assert_eq!(copies(&conn, "p1", "nonfoil"), 4);
        assert_eq!(copies(&conn, "p1", "foil"), 1);
    }

    #[test]
    fn on_deck_count_is_the_decks_the_printing_appears_in() {
        let conn = db();
        crate::deck_driven::store(&conn, true).unwrap();
        let sql = format!(
            "SELECT e.deck_count FROM {} WHERE e.card_id = 'p1' AND e.finish = 'nonfoil'",
            rows(&conn, "e")
        );
        let n: i64 = conn.query_row(&sql, [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2, "two decks hold the regular printing");
    }

    #[test]
    fn on_condition_is_null_rather_than_an_invented_nm() {
        let conn = db();
        crate::deck_driven::store(&conn, true).unwrap();
        let sql = format!(
            "SELECT e.condition FROM {} WHERE e.card_id = 'p1' AND e.finish = 'nonfoil'",
            rows(&conn, "e")
        );
        let c: Option<String> = conn.query_row(&sql, [], |r| r.get(0)).unwrap();
        assert_eq!(c, None);
    }

    /// The whole point of §2a: the grouped source and the correlated fragment are two
    /// spellings of one rule, and two spellings is how a rule drifts.
    #[test]
    fn the_two_shapes_agree_on_the_same_database() {
        let conn = db();
        crate::deck_driven::store(&conn, true).unwrap();

        let grouped: i64 = conn
            .query_row(
                &format!(
                    "SELECT coalesce(sum(e.quantity), 0) FROM {} WHERE e.card_id = 'p1'",
                    rows(&conn, "e")
                ),
                [],
                |r| r.get(0),
            )
            .unwrap();
        let direct: i64 = conn
            .query_row(
                &format!("SELECT {}", copies_of_printing(&conn, "'p1'")),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(grouped, direct, "5 copies of p1: 4 regular and 1 foil");
        assert_eq!(grouped, 5);
    }

    #[test]
    fn on_owns_printing_is_true_for_a_live_card_and_false_for_a_theory_one() {
        let conn = db();
        crate::deck_driven::store(&conn, true).unwrap();
        let ask = |card: &str| -> bool {
            conn.query_row(
                &format!("SELECT {}", owns_printing(&conn, &format!("'{card}'"))),
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert!(ask("p1"));
        assert!(!ask("p2"), "a theory row is not a card the reader has");
    }

    #[test]
    fn on_copies_of_oracle_crosses_printings() {
        let conn = db();
        crate::deck_driven::store(&conn, true).unwrap();
        let n: i64 = conn
            .query_row(
                &format!("SELECT {}", copies_of_oracle(&conn, "'o1'")),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 5, "p2's four copies are theory and do not count");
    }

    #[test]
    fn on_owned_rowids_lists_the_live_cards_only() {
        let conn = db();
        crate::deck_driven::store(&conn, true).unwrap();
        let mut stmt = conn.prepare(&owned_rowids(&conn)).unwrap();
        let got: Vec<i64> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let p1: i64 = conn
            .query_row("SELECT rowid FROM cards WHERE id = 'p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(got, vec![p1]);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```
cargo test --manifest-path src-tauri/Cargo.toml collection_source
```
Expected: FAIL to compile — the module does not exist.

- [ ] **Step 3: Write the module**

Create `src-tauri/src/collection_source.rs`:

```rust
//! Where "what does the reader own" is read from — the table, or the decks.
//!
//! [`crate::deck_driven`] owns the bit; this module owns the **rule**, which is one
//! predicate ([`LIVE`]) presented in two shapes. Every query in the crate that asks about
//! ownership builds its SQL through one of the functions here rather than naming a table, so
//! there is exactly one place the rule lives and exactly one place a future variant would go.
//!
//! **Why two shapes rather than one.** The obvious design is a single `FROM` fragment that is
//! either the table or a `GROUP BY` over the live deck lists, swapped in everywhere. It is
//! right for the two commands that list whole rows and wrong for the other five, which read
//! ownership from inside a *correlated subquery*: `crate::search`'s owned badge sits in a
//! query over 116 000 cards, and a correlated read of an aggregate recomputes the whole deck
//! sum once per candidate row. So [`rows`] is the grouped shape, the four builders below are
//! the direct shape, and `the_two_shapes_agree_on_the_same_database` is what holds them to
//! one answer.
//!
//! **What a derived row cannot carry.** `deck_cards` supplies `card_id`, `finish` and `lang`
//! and nothing else the collection grain names — no condition, no purchase price, no
//! acquisition story, no grading, no proxy or altered or signed flag. [`rows`] emits those as
//! constants, and `condition` as NULL rather than as the column's `'NM'` default, because a
//! default written into an export is a fact the reader never stated.

use crate::sync::AppState;
use rusqlite::Connection;
use std::sync::Arc;

/// The whole rule, once: **a card the reader owns is a card in a `live` deck list.**
///
/// No `deck_categories` join and no `is_active` term — an inactive Maybeboard is a statement
/// about how the *deck* is read, not about whether the cards are in the reader's hands, and
/// this is the one place in the crate that deliberately departs from
/// [`crate::deck::allocate_deck`]'s rule. No `decks.archived` term either: archiving is
/// filing, not disassembling. And no `theory_enabled` term, because none is needed — a deck
/// with no theory list keeps every row as `live`, so "a deck without a plan counts in full"
/// falls out of this predicate rather than needing a clause.
///
/// Spelled against the alias `dc`, which every builder below binds to `deck_cards`.
pub const LIVE: &str = "dc.variant = 'live'";

/// The grouped row source — a `FROM` fragment aliased as the caller spells it.
///
/// Off, the table. On, a subquery emitting **the same column names**, so the caller's `WHERE`,
/// `ORDER BY`, price expression and `LEFT JOIN cards` are untouched.
///
/// `min(dc.id) AS id` is unique per group because the groups partition disjoint sets of rows,
/// which is all a React key and a virtualiser need. **It is not a `collection_entries.id`** —
/// which is exactly why the five collection writes refuse while this is on: they address rows
/// by primary key, and the reader's hidden hand-built rows are still on disk.
pub fn rows(conn: &Connection, alias: &str) -> String {
    if !crate::deck_driven::stored(conn) {
        return format!("collection_entries {alias}");
    }
    format!(
        "(SELECT min(dc.id) AS id,
                 dc.card_id AS card_id,
                 dc.set_code AS set_code,
                 dc.collector_number AS collector_number,
                 dc.lang AS lang,
                 coalesce(dc.finish, 'nonfoil') AS finish,
                 NULL AS condition,
                 NULL AS condition_original,
                 sum(dc.quantity) AS quantity,
                 0 AS tradelist_quantity,
                 count(DISTINCT dc.deck_id) AS deck_count,
                 NULL AS purchase_price,
                 NULL AS purchase_currency,
                 NULL AS acquired_at,
                 NULL AS acquisition_source,
                 NULL AS serial_number,
                 0 AS altered,
                 0 AS signed,
                 0 AS proxy,
                 0 AS misprint,
                 NULL AS grading,
                 '[]' AS tags,
                 NULL AS notes,
                 max(dc.needs_review) AS needs_review,
                 min(dc.created_at) AS created_at,
                 max(dc.updated_at) AS updated_at
            FROM deck_cards dc
           WHERE {LIVE}
           GROUP BY dc.card_id, coalesce(dc.finish, 'nonfoil'), dc.lang) {alias}"
    )
}

/// `EXISTS (…)` — does the reader own this printing at all?
///
/// `card_col` is the column or literal holding the printing id, spelled by the caller
/// (`c.id`, `'p1'`). The derived arm reads `deck_cards` directly through
/// `idx_deck_cards_card`; there is no `GROUP BY` because the question is existence.
pub fn owns_printing(conn: &Connection, card_col: &str) -> String {
    if crate::deck_driven::stored(conn) {
        format!("EXISTS (SELECT 1 FROM deck_cards dc WHERE dc.card_id = {card_col} AND {LIVE})")
    } else {
        format!("EXISTS (SELECT 1 FROM collection_entries e WHERE e.card_id = {card_col})")
    }
}

/// Copies of one printing, every finish and language together. `0` when none.
pub fn copies_of_printing(conn: &Connection, card_col: &str) -> String {
    if crate::deck_driven::stored(conn) {
        format!(
            "coalesce((SELECT sum(dc.quantity) FROM deck_cards dc
                        WHERE dc.card_id = {card_col} AND {LIVE}), 0)"
        )
    } else {
        format!(
            "coalesce((SELECT sum(e.quantity) FROM collection_entries e
                        WHERE e.card_id = {card_col}), 0)"
        )
    }
}

/// Copies of every printing of one oracle card — a Bolt is a Bolt. `0` when none.
pub fn copies_of_oracle(conn: &Connection, oracle_col: &str) -> String {
    if crate::deck_driven::stored(conn) {
        format!(
            "coalesce((SELECT sum(dc.quantity) FROM deck_cards dc
                         JOIN cards k ON k.id = dc.card_id
                        WHERE k.oracle_id = {oracle_col} AND {LIVE}), 0)"
        )
    } else {
        format!(
            "coalesce((SELECT sum(e.quantity) FROM collection_entries e
                         JOIN cards k ON k.id = e.card_id
                        WHERE k.oracle_id = {oracle_col}), 0)"
        )
    }
}

/// The facet index's `owned` dimension — one `cards.rowid` per card the reader owns.
///
/// A whole statement rather than a fragment, because [`crate::index::CardIndex::rebuild_owned`]
/// prepares it as one. The join reads `cards`' primary-key index for the rowid and never the
/// row, in both arms.
pub fn owned_rowids(conn: &Connection) -> String {
    if crate::deck_driven::stored(conn) {
        format!(
            "SELECT DISTINCT c.rowid FROM deck_cards dc
               JOIN cards c ON c.id = dc.card_id
              WHERE {LIVE}"
        )
    } else {
        "SELECT DISTINCT c.rowid FROM collection_entries e JOIN cards c ON c.id = e.card_id"
            .to_owned()
    }
}

/// `crate::sync::with_write`, plus the facet index's `owned` rebuild on success.
///
/// Only on success. A refusal — [`crate::db::BUSY`], a `GONE`, a rejected quantity — changed
/// nothing, and re-reading after one would be a copy of the whole index to arrive at the same
/// answer.
///
/// Moved here from `crate::collection` when the source became switchable: its three callers
/// are now a collection write, [`crate::reset::collection_clear`], and the setting itself,
/// and the thing they have in common is this module rather than that one.
pub(crate) fn with_write_owned<T>(
    state: &Arc<AppState>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let answer = crate::sync::with_write(state, f);
    if answer.is_ok() {
        crate::index::lifecycle::invalidate_owned(state);
    }
    answer
}

/// The same, for a **deck** write — which moves what the reader owns only while the
/// collection is derived from the decks.
///
/// Rebuilding the dimension after every deck edit in the hand-kept mode would be a full index
/// clone for nothing, and *not* rebuilding it in the derived mode is the search Owned facet
/// answering from before the edit with nothing on screen to notice. So the wrapper asks.
///
/// The flag is read after the write rather than before, on the read pool, so it cannot
/// contend with the write that has already finished. Nothing a deck write does can change it.
pub(crate) fn with_write_owned_if_derived<T>(
    state: &Arc<AppState>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let answer = crate::sync::with_write(state, f);
    if answer.is_ok() && crate::deck_driven::stored(&crate::sync::lock_db_read(state)) {
        crate::index::lifecycle::invalidate_owned(state);
    }
    answer
}
```

- [ ] **Step 4: Move the helper and repoint its callers**

1. In `src-tauri/src/lib.rs`, add `mod collection_source;`.
2. In `src-tauri/src/collection.rs`, **delete** the `with_write_owned` definition at
   `:670-689` (the doc comment and the function), and change the five call sites at `:696`,
   `:709`, `:723`, `:735`, `:750` from `with_write_owned(` to
   `crate::collection_source::with_write_owned(`.
3. In `src-tauri/src/reset.rs`, change the one `crate::collection::with_write_owned` call in
   `collection_clear` to `crate::collection_source::with_write_owned`.
4. In `src-tauri/src/deck_driven.rs`, change `crate::collection::with_write_owned` in
   `set_deck_driven_collection` to `crate::collection_source::with_write_owned`, and update
   the doc comment's link from `[`crate::collection::with_write_owned`]` to
   `[`crate::collection_source::with_write_owned`]`.

The `pub(crate)` visibility is unchanged; only the path moves.

- [ ] **Step 5: Run the tests to verify they pass**

```
cargo test --manifest-path src-tauri/Cargo.toml collection_source
cargo test --manifest-path src-tauri/Cargo.toml collection::
```
Expected: PASS on both. 10 tests selected by the first. State both selected counts — the
second is the regression check that moving the helper broke nothing.

- [ ] **Step 6: Report to the controller**

Do not commit. Report the two selected counts and the exact public signatures produced, so
wave C's five tasks can be dispatched against them.

---

### Task 3: The Collection page's two commands

**Files:**
- Modify: `src-tauri/src/collection.rs` — `FROM` (`:895`), `list_entries`' SELECT (`:1086`),
  `summarise` (`:1163`), `CollectionRow` (`:798`), and the five write commands (`:690`-`:754`)
- Test: inline `#[cfg(test)] mod tests` in `src-tauri/src/collection.rs`

**Interfaces:**
- Consumes: `collection_source::{rows, with_write_owned}`, `deck_driven::stored` (Tasks 1, 2).
- Produces:
  - `pub const DECK_DRIVEN: &str` — the refusal sentence
  - `CollectionRow.condition: Option<String>` (was `String`)
  - `CollectionRow.deck_count: Option<i64>` (new, last field)

- [ ] **Step 1: Write the failing tests**

Add to `collection.rs`'s existing `#[cfg(test)] mod tests`. Reuse whatever database helper
that module already has; where it seeds `collection_entries` by hand, seed `decks`,
`deck_categories` and `deck_cards` the same way for these.

```rust
    /// The page lists the live decks' cards, summed, when the setting is on.
    #[test]
    fn the_list_reads_the_decks_when_deck_driven() {
        let conn = deck_driven_db(); // one deck, 2 × Sol Ring live, 4 × Sol Ring theory
        crate::deck_driven::store(&conn, true).unwrap();
        let page = list_entries(&conn, &CollectionQuery::default()).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].quantity, 2);
        assert_eq!(page.items[0].condition, None);
        assert_eq!(page.items[0].deck_count, Some(1));
    }

    /// Off, the same database answers from the reader's own rows and reports no deck count.
    #[test]
    fn the_list_reads_the_table_when_not_deck_driven() {
        let conn = deck_driven_db();
        let page = list_entries(&conn, &CollectionQuery::default()).unwrap();
        assert_eq!(page.total, 0, "nothing was ever added by hand");
        // …and with a hand-added row present:
        add_entry(&conn, &input("p1", "nonfoil", 3)).unwrap();
        let page = list_entries(&conn, &CollectionQuery::default()).unwrap();
        assert_eq!(page.items[0].quantity, 3);
        assert_eq!(page.items[0].condition.as_deref(), Some("NM"));
        assert_eq!(page.items[0].deck_count, None);
    }

    /// The header describes the same rows the list does — in either mode.
    #[test]
    fn the_summary_agrees_with_the_list_when_deck_driven() {
        let conn = deck_driven_db();
        crate::deck_driven::store(&conn, true).unwrap();
        let q = CollectionQuery::default();
        let page = list_entries(&conn, &q).unwrap();
        let sum = summarise(&conn, &q).unwrap();
        assert_eq!(sum.entries, page.total);
        assert_eq!(sum.total_cards, page.items.iter().map(|r| r.quantity).sum::<i64>());
        assert_eq!(sum.tradelist_cards, 0, "a deck card has no tradelist quantity");
    }

    /// The safety fence. The derived `id` is a `deck_cards.id` and can collide with a real
    /// hidden row's primary key, so a write that got through would delete the reader's data.
    #[test]
    fn every_write_refuses_while_deck_driven() {
        let conn = deck_driven_db();
        add_entry(&conn, &input("p1", "nonfoil", 3)).unwrap();
        crate::deck_driven::store(&conn, true).unwrap();

        assert_eq!(add_entry(&conn, &input("p1", "nonfoil", 1)).unwrap_err(), DECK_DRIVEN);
        assert_eq!(set_quantity(&conn, 1, 9).unwrap_err(), DECK_DRIVEN);
        assert_eq!(update_entry(&conn, 1, &EntryPatch::default()).unwrap_err(), DECK_DRIVEN);
        assert_eq!(remove_entry(&conn, 1).unwrap_err(), DECK_DRIVEN);
        assert_eq!(commit_import(&conn, &[], "add").unwrap_err(), DECK_DRIVEN);
    }

    /// The guarantee the whole "preserve, hide, restore" decision rests on.
    #[test]
    fn the_hidden_rows_are_unchanged_by_a_flip_there_and_back() {
        let conn = deck_driven_db();
        add_entry(&conn, &input("p1", "nonfoil", 3)).unwrap();
        let before = dump_entries(&conn); // every column of every row, as text
        crate::deck_driven::store(&conn, true).unwrap();
        let _ = list_entries(&conn, &CollectionQuery::default()).unwrap();
        crate::deck_driven::store(&conn, false).unwrap();
        assert_eq!(dump_entries(&conn), before);
    }
```

Write `dump_entries` beside them:

```rust
    /// Every column of every collection row as one comparable string. Blunt on purpose: the
    /// test it serves is "nothing at all changed", and naming columns would let a new one
    /// slip past it.
    fn dump_entries(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT quote(e.*) FROM collection_entries e ORDER BY e.id")
            .unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
    }
```

If `quote(e.*)` is rejected by the bundled SQLite version, fall back to
`SELECT group_concat(quote(x)) …` over an explicit `SELECT *` row mapping — but try the
one-liner first and say which you used.

- [ ] **Step 2: Run the tests to verify they fail**

```
cargo test --manifest-path src-tauri/Cargo.toml collection::tests
```
Expected: FAIL — `DECK_DRIVEN` undefined, `deck_count` not a field, `condition` is `String`.

- [ ] **Step 3: Make `FROM` a function of the connection**

Replace the `const FROM` at `collection.rs:895` with:

```rust
/// The rows every statement here reads, and the only join any of them makes.
///
/// LEFT JOIN, always: an entry whose printing is gone is the case the denormalised columns
/// exist for, and an inner join would delete exactly those rows from the view that most needs
/// them. Nothing widens this — see [`scope`] for why even the text filter reaches `cards_fts`
/// through a subquery rather than a second join.
///
/// **The left side is no longer a table name.** [`crate::collection_source::rows`] answers
/// with either `collection_entries` or the live deck lists grouped to the same columns, so
/// everything downstream of this line — the filters, the five sorts, the price expression —
/// is written once and reads whichever the reader chose.
fn from_sql(conn: &Connection) -> String {
    format!(
        "{} LEFT JOIN cards c ON c.id = e.card_id",
        crate::collection_source::rows(conn, "e")
    )
}
```

Then in `list_entries` and `summarise`, bind `let from = from_sql(conn);` before the
`format!` and change `FROM {FROM}` to `FROM {from}`. Both functions already take `conn`.

- [ ] **Step 4: Add `deck_count` and widen `condition`**

In `CollectionRow` (`collection.rs:798`):

```rust
    /// What state the copy is in — `None` when the collection is derived from the decks,
    /// because a deck card has nowhere to record one.
    ///
    /// **Not the column's `'NM'` default.** A default is a fact the reader never stated, and
    /// this field reaches their exported file through `fromCollectionRow`.
    pub condition: Option<String>,
```

and, as the last field:

```rust
    /// How many decks this row's copies are spread across — `None` unless the collection is
    /// derived from them, because the hand-kept table has no such fact.
    ///
    /// Free: it rides along in the same aggregate the quantity is summed by. The deck
    /// *names* do not — see [`crate::collection_decks`], which the row's tooltip asks
    /// lazily on hover rather than putting several hundred of them on a 100-row page.
    pub deck_count: Option<i64>,
```

In `list_entries`' SELECT (`collection.rs:1086`), change `e.condition,` to keep its position
and append the new column at the very end of the list, after `c.promo_types`:

```rust
    let deck_count = if crate::deck_driven::stored(conn) {
        "e.deck_count"
    } else {
        // `collection_entries` has no such column, and wrapping the table in a subquery to
        // manufacture one would put an aggregate-free view in front of the grain index for
        // no gain. Only this statement wants the figure, and it builds its own SELECT list.
        "NULL"
    };
```

…interpolated as `{deck_count} AS deck_count` at the end of the list, and read in the row
mapping (`collection.rs:1110-1149`) as `deck_count: r.get(32)?` with `condition: r.get(12)?`
now yielding `Option<String>`. **Count the SELECT positions after editing** — the mapping is
positional and a shifted index is a silent wrong-column bug.

- [ ] **Step 5: Add the refusal and fence the five writes**

Beside `GONE` and `ZERO_ADD` near the top of `collection.rs`:

```rust
/// What every write here answers while the collection is derived from the decks.
///
/// **A fence, not a courtesy.** The derived row's `id` is a `deck_cards.id`
/// ([`crate::collection_source::rows`]), the reader's hand-built rows are still on disk, and
/// [`set_quantity`] and [`remove_entry`] address rows by primary key — so a call that got
/// through carrying a derived id would rewrite or delete a row the reader cannot currently
/// see. Greying the buttons is the second fence; this is the first.
pub const DECK_DRIVEN: &str = "Your collection is driven by your decks. Turn the setting off \
                               in Settings to edit it by hand.";
```

> Mind the `\` continuation: it strips the newline **and** the leading whitespace, so the
> space before it is what keeps `off` and `in` apart. Verify the assembled string in the test.

Then, as the first line of `add_entry`, `set_quantity`, `update_entry`, `remove_entry` and
`commit_import`:

```rust
    if crate::deck_driven::stored(conn) {
        return Err(DECK_DRIVEN.to_owned());
    }
```

Put it in the free functions, not the command wrappers — `reset::collection_clear` calls no
free function here and must stay allowed, and `commit_import`'s transaction must refuse
before it opens.

- [ ] **Step 6: Run the tests to verify they pass**

```
cargo test --manifest-path src-tauri/Cargo.toml collection
```
Expected: PASS. State the selected count and confirm the pre-existing collection tests are in
it — several assert on `condition` and will need `Some("NM")` rather than `"NM"`.

- [ ] **Step 7: Report to the controller**

Do not commit. Report the two DTO changes verbatim so Task 8's TypeScript mirror matches.

---

### Task 4: The three read swaps — search, the facet index, the wishlist

**Files:**
- Modify: `src-tauri/src/search.rs:713-721` (the owned filter), `:922-924` and `:938-939`
  (the owned badge, both branches)
- Modify: `src-tauri/src/index/mod.rs:288-292` (`rebuild_owned`)
- Modify: `src-tauri/src/wishlist.rs:151-158` (`OWNED_SQL`)
- Test: inline `#[cfg(test)]` modules in each of the three files

**Interfaces:**
- Consumes: `collection_source::{LIVE, owns_printing, copies_of_printing, copies_of_oracle,
  owned_rowids}` (Task 2).
- Produces: nothing new. Three call-site changes and one `const` → `fn`.

- [ ] **Step 1: Write the failing tests**

In `search.rs`'s test module:

```rust
    /// The Owned chip and the owned badge both read the live deck lists when the setting is
    /// on — so the search wall and the Collection page cannot disagree about the same card.
    #[test]
    fn owned_reads_the_decks_when_deck_driven() {
        let conn = deck_driven_search_db(); // 'p1' in a live deck ×2, 'p2' in theory only
        crate::deck_driven::store(&conn, true).unwrap();

        let owned = search_ids(&conn, SearchRequest { owned: Some(true), ..Default::default() });
        assert_eq!(owned, vec!["p1"]);

        let missing = search_ids(&conn, SearchRequest { owned: Some(false), ..Default::default() });
        assert!(missing.contains(&"p2".to_owned()));
    }

    #[test]
    fn the_owned_badge_counts_live_copies_when_deck_driven() {
        let conn = deck_driven_search_db();
        crate::deck_driven::store(&conn, true).unwrap();
        let rows = search_rows(&conn, SearchRequest::default());
        let p1 = rows.iter().find(|r| r.id == "p1").unwrap();
        assert_eq!(p1.owned_quantity, 2);
    }
```

In `index/mod.rs`'s test module:

```rust
    #[test]
    fn rebuild_owned_reads_the_decks_when_deck_driven() {
        let conn = deck_driven_index_db();
        crate::deck_driven::store(&conn, true).unwrap();
        let mut index = CardIndex::build(&conn).unwrap();
        index.rebuild_owned(&conn).unwrap();
        assert_eq!(index.owned.count(), 1, "one live printing, one owned card");
    }
```

In `wishlist.rs`'s test module:

```rust
    /// A wish is filled by copies the reader has — and while the setting is on, the copies
    /// they have are the ones in their live decks. Finish still narrows; condition still
    /// does not, because a wish has nowhere to name one.
    #[test]
    fn a_wish_is_filled_by_live_deck_copies_when_deck_driven() {
        let conn = deck_driven_wishlist_db(); // wish for 'p1'; 'p1' ×2 live, 1 of them foil
        crate::deck_driven::store(&conn, true).unwrap();

        let any = list_wishes(&conn, /* preferred_finish */ None);
        assert_eq!(any[0].owned_quantity, 2);

        let foil = list_wishes(&conn, Some("foil"));
        assert_eq!(foil[0].owned_quantity, 1, "the NULL deck finish must not read as foil");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```
cargo test --manifest-path src-tauri/Cargo.toml deck_driven -- --include-ignored
```
Expected: FAIL — the three assertions read 0, because all three sites still name
`collection_entries`.

- [ ] **Step 3: Swap the search filter**

`search.rs:713-721` becomes:

```rust
    match req.owned {
        Some(true) => p
            .wheres
            .push(crate::collection_source::owns_printing(conn, "c.id")),
        Some(false) => p.wheres.push(format!(
            "NOT {}",
            crate::collection_source::owns_printing(conn, "c.id")
        )),
        None => {}
    }
```

`NOT EXISTS (…)` and `NOT (EXISTS (…))` are the same plan to SQLite, and one builder is one
place for the rule. Thread `conn` into the function if it does not already have it — the
enclosing statement builder is called with a connection at every call site.

- [ ] **Step 4: Swap the two owned badges**

`search.rs:922-924` (the collapsed branch, which asks by oracle card):

```rust
                    {owned_by_oracle},
```
bound before the `format!` as
`let owned_by_oracle = crate::collection_source::copies_of_oracle(conn, "c.oracle_id");`

`search.rs:938-939` (the uncollapsed branch, which asks by printing):

```rust
                    {owned_by_printing},
```
bound as `let owned_by_printing = crate::collection_source::copies_of_printing(conn, "c.id");`

**Position 15 in both branches is load-bearing** — the two share one row mapping. Do not move
the column; only change what fills it.

- [ ] **Step 5: Swap the facet index rebuild**

`index/mod.rs:288-292`:

```rust
    pub fn rebuild_owned(&mut self, conn: &Connection) -> rusqlite::Result<()> {
        let mut owned = BitSet::new(self.capacity);
        let mut stmt = conn.prepare(&crate::collection_source::owned_rowids(conn))?;
```

The rest of the function is unchanged. Extend its doc comment with one sentence: the statement
is now built rather than literal, and in the derived mode the per-entry index probe is per
*deck row* instead.

- [ ] **Step 6: Swap the wishlist**

Turn the `const OWNED_SQL` at `wishlist.rs:151` into a function, keeping the whole doc comment
and adding the derived arm:

```rust
/// … (existing doc comment, unchanged) …
///
/// **Both arms narrow by finish and neither by condition**, and the derived arm has to
/// translate: `deck_cards.finish` is NULL for the regular copy while
/// `wishlist_entries.preferred_finish` spells it `nonfoil`, so binding the deck's NULL
/// straight through would make every regular wish read zero owned.
fn owned_sql(conn: &Connection) -> String {
    if !crate::deck_driven::stored(conn) {
        return "coalesce((
        SELECT sum(ce.quantity) FROM collection_entries ce
         WHERE (w.card_id IS NOT NULL AND ce.card_id = w.card_id
                AND (w.preferred_finish IS NULL OR ce.finish = w.preferred_finish))
            OR (w.card_id IS NULL AND ce.card_id IN
                    (SELECT id FROM cards WHERE oracle_id = w.oracle_id)
                AND (w.preferred_finish IS NULL OR ce.finish = w.preferred_finish))), 0)"
            .to_owned();
    }
    format!(
        "coalesce((
        SELECT sum(dc.quantity) FROM deck_cards dc
         WHERE {LIVE}
           AND ((w.card_id IS NOT NULL AND dc.card_id = w.card_id
                 AND (w.preferred_finish IS NULL
                      OR coalesce(dc.finish, 'nonfoil') = w.preferred_finish))
             OR (w.card_id IS NULL AND dc.card_id IN
                     (SELECT id FROM cards WHERE oracle_id = w.oracle_id)
                 AND (w.preferred_finish IS NULL
                      OR coalesce(dc.finish, 'nonfoil') = w.preferred_finish)))), 0)",
        LIVE = crate::collection_source::LIVE
    )
}
```

Repoint every `OWNED_SQL` use in the module to `owned_sql(conn)`, binding it once per
statement build.

- [ ] **Step 7: Run the tests to verify they pass**

```
cargo test --manifest-path src-tauri/Cargo.toml search::
cargo test --manifest-path src-tauri/Cargo.toml index::
cargo test --manifest-path src-tauri/Cargo.toml wishlist::
```
Expected: PASS on all three. State each selected count — these three modules have large
existing suites and the point of running them whole is that none of them moved.

- [ ] **Step 8: Report to the controller**

Do not commit. Report the three selected counts.

---

### Task 5: The import's owned ranking, and its commit

**Files:**
- Modify: `src-tauri/src/import.rs:288-297` (`MATCH_COLUMNS`) and `:996` +
  `commit_import`'s command wrapper
- Test: inline `#[cfg(test)] mod tests` in `src-tauri/src/import.rs`

**Interfaces:**
- Consumes: `collection_source::{copies_of_printing, with_write_owned_if_derived}` (Task 2).
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

```rust
    /// Owned ranks **first** in `MATCH_ORDER`, so this decides which printing a decklist
    /// line resolves to — not merely what a badge says. With the setting on, "the printing
    /// you own" means "the printing already in one of your live decks".
    #[test]
    fn an_import_resolves_to_the_printing_a_live_deck_already_holds() {
        let conn = two_printings_db(); // 'p1' (cmr) and 'p2' (ltr), same oracle card
        seed_live_deck_card(&conn, "p2", 1);
        crate::deck_driven::store(&conn, true).unwrap();

        let matched = match_line(&conn, "Sol Ring");
        assert_eq!(matched.id, "p2", "the deck's printing outranks the newest");
        assert_eq!(matched.owned_quantity, 1);
    }

    /// A deck import moves what the reader owns while the setting is on, so the facet
    /// index's owned dimension has to be re-read — it is the one dimension that moves
    /// without a sync.
    #[test]
    fn committing_a_deck_import_moves_the_owned_facet_when_deck_driven() {
        let (state, conn) = state_with_db();
        crate::deck_driven::store(&conn, true).unwrap();
        let before = owned_facet_count(&state);
        commit_deck_import_through_command(&state, /* one new live card */);
        assert_eq!(owned_facet_count(&state), before + 1);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```
cargo test --manifest-path src-tauri/Cargo.toml import::
```
Expected: FAIL — the first resolves to the newest printing, the second's facet count does not
move.

- [ ] **Step 3: Swap the owned column**

`MATCH_COLUMNS` at `import.rs:290` is a `const` and its last line names the table. Turn it
into a function, keeping the whole doc comment:

```rust
/// … (existing doc comment, unchanged) …
///
/// **The last column is now built rather than literal.** `owned_quantity` is what
/// `MATCH_ORDER` ranks on first, so what "owned" means decides which printing a line becomes
/// — and while the collection is derived from the decks, it means "already in a live list".
fn match_columns(conn: &Connection) -> String {
    format!(
        "SELECT c.id, c.name, c.set_code, c.collector_number, c.lang,
        c.oracle_id, c.mana_cost, c.cmc, c.type_line, c.oracle_text, c.colors,
        c.color_identity, c.legalities, c.power, c.toughness, c.layout, c.rarity,
        c.faces, c.game_changer,
        EXISTS(SELECT 1 FROM cards u
                WHERE u.oracle_id = c.oracle_id AND u.rarity = 'uncommon') AS ever_uncommon,
        {owned} AS owned_quantity",
        owned = crate::collection_source::copies_of_printing(conn, "c.id")
    )
}
```

Repoint all five arms that interpolate `MATCH_COLUMNS` to `match_columns(conn)`, binding it
once per arm.

- [ ] **Step 4: Route the deck import commit through the conditional wrapper**

In `import.rs`'s `deck_import_commit` command wrapper (`:996`), change
`crate::sync::with_write(&state, …)` to
`crate::collection_source::with_write_owned_if_derived(&state, …)`.

Leave `collection_import_commit` alone — it lives in `collection.rs`, already goes through
`with_write_owned`, and Task 3 has made it refuse outright.

- [ ] **Step 5: Run the tests to verify they pass**

```
cargo test --manifest-path src-tauri/Cargo.toml import::
```
Expected: PASS. State the selected count.

- [ ] **Step 6: Report to the controller**

Do not commit.

---

### Task 6: The deck side — the allocator, the theory spare, and the invalidations

**Files:**
- Modify: `src-tauri/src/deck.rs` — `allocate_deck` (`:3381`), `attribute_owned` (`:3326`),
  and the command wrappers at `:3623`, `:3804`, `:3826`, `:3855`, `:3882`, `:3908`, `:3939`,
  `:3971`
- Modify: `src-tauri/src/deck_theory.rs` — `OWNED_SPARE_SQL` (`:202`) and its prepare at `:319`
- Modify: `src-tauri/src/deck_meta.rs` — the command wrappers at `:1836` (`set_category_active`)
  and `:1864` (`delete_category`)
- Modify: `src-tauri/src/deck_undo.rs` — the two command wrappers at `:1215`, `:1230`
- Modify: `src-tauri/src/reconcile.rs` — one explicit invalidation at the end of the sweep
- Test: inline `#[cfg(test)]` modules in `deck.rs` and `deck_theory.rs`

**Interfaces:**
- Consumes: `collection_source::{LIVE, with_write_owned_if_derived}`, `deck_driven::stored`
  (Tasks 1, 2).
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

In `deck.rs`'s test module:

```rust
    /// Under a deck-driven collection every live deck card is covered by its own copies —
    /// which is true by construction, not a fudge. No live card is ever short.
    #[test]
    fn a_live_deck_is_fully_owned_when_deck_driven() {
        let conn = deck_db(); // 3 × Sol Ring live, no collection rows at all
        crate::deck_driven::store(&conn, true).unwrap();
        let deck = get_deck(&conn, 1, LIVE, Marketplace::default()).unwrap();
        let row = &deck.cards[0];
        assert_eq!(row.owned_quantity, row.quantity);
    }

    /// A plan still reserves nothing — the rule the variant fence has always enforced.
    #[test]
    fn a_theory_row_is_still_owned_nothing_when_deck_driven() {
        let conn = deck_db_with_theory();
        crate::deck_driven::store(&conn, true).unwrap();
        let deck = get_deck(&conn, 1, THEORY, Marketplace::default()).unwrap();
        assert_eq!(deck.cards[0].owned_quantity, 0);
    }

    /// The ledger is left exactly as it was, so switching the setting back off finds it
    /// intact rather than rebuilt from a mode it does not describe.
    #[test]
    fn allocate_deck_writes_nothing_and_deletes_nothing_when_deck_driven() {
        let conn = deck_db_with_collection_and_allocations();
        let before = allocation_rows(&conn);
        crate::deck_driven::store(&conn, true).unwrap();
        allocate_deck(&conn, 1).unwrap();
        assert_eq!(allocation_rows(&conn), before);
    }

    /// An inactive category is not the allocator's rule here: the reader has the cards.
    #[test]
    fn an_inactive_category_is_owned_too_when_deck_driven() {
        let conn = deck_db_with_inactive_category();
        crate::deck_driven::store(&conn, true).unwrap();
        let deck = get_deck(&conn, 1, LIVE, Marketplace::default()).unwrap();
        let inactive = deck.cards.iter().find(|r| !r.category_active).unwrap();
        assert_eq!(inactive.owned_quantity, inactive.quantity);
    }
```

In `deck_theory.rs`'s test module:

```rust
    /// `is_built` keeps its job: a card sitting in an unbuilt deck's live list is still
    /// available to a plan, and one in a sleeved-up deck is not.
    #[test]
    fn the_theory_spare_subtracts_built_decks_when_deck_driven() {
        let conn = theory_db(); // deck 2 holds 1 × p1 live; deck 1's theory wants p1
        crate::deck_driven::store(&conn, true).unwrap();

        set_built(&conn, 2, false);
        assert_eq!(spare(&conn, "p1", None), 1);

        set_built(&conn, 2, true);
        assert_eq!(spare(&conn, "p1", None), 0);
    }

    /// The NULL-versus-nonfoil translation, on the side that already documents the trap.
    #[test]
    fn the_theory_spare_translates_the_regular_finish_when_deck_driven() {
        let conn = theory_db();
        crate::deck_driven::store(&conn, true).unwrap();
        assert_eq!(spare(&conn, "p1", None), 1, "the regular copy must not read zero");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```
cargo test --manifest-path src-tauri/Cargo.toml deck::
cargo test --manifest-path src-tauri/Cargo.toml deck_theory::
```
Expected: FAIL — every owned figure reads 0, because there are no `collection_entries`.

- [ ] **Step 3: Make the allocator stand down**

At the top of `allocate_deck` (`deck.rs:3381`):

```rust
    // **Nothing to allocate, and nothing to tear down.** A deck-driven collection *is* the
    // sum of the live lists, so every live row is covered by its own copies and the ledger
    // has nothing left to describe — `deck_allocations.collection_entry_id` is a foreign key
    // into a table this mode does not read. Returning before the DELETE is deliberate: the
    // reader's existing claims are left exactly as they were, so switching the setting back
    // off finds the ledger intact instead of emptied by a mode that never used it.
    if crate::deck_driven::stored(conn) {
        return Ok(());
    }
```

Extend the function's doc comment with the same two sentences.

- [ ] **Step 4: Make `attribute_owned` answer from the mode**

`attribute_owned` (`deck.rs:3326`) is pure and takes no connection. Give it a third argument
rather than a connection, so it stays pure:

```rust
fn attribute_owned(
    rows: &mut [DeckCardRow],
    owned_by_oracle: &HashMap<String, i64>,
    deck_driven: bool,
) {
    let mut left = owned_by_oracle.clone();
    for row in rows.iter_mut() {
        // **A plan reserves nothing, in either mode.** `deck_allocations` carries no variant,
        // so a theory read walks the live deck's claims; and under a deck-driven collection a
        // theory row is a card the reader has said they do *not* have yet. The two reasons
        // are different and the answer is the same.
        if row.variant != LIVE {
            row.owned_quantity = 0;
            continue;
        }
        // **Derived: a live row is covered by its own copies.** True by construction — the
        // collection is the sum of these very rows — and it takes the inactive category with
        // it, which is where this mode departs from `allocate_deck`'s rule on purpose: the
        // reader still has the cards in a pile they have switched off.
        if deck_driven {
            row.owned_quantity = row.quantity;
            continue;
        }
        let claimed_for = row.category_active;
        let Some(oracle) = row.oracle_id.clone().filter(|_| claimed_for) else {
            row.owned_quantity = 0;
            continue;
        };
        let remaining = left.entry(oracle).or_insert(0);
        let take = (*remaining).min(row.quantity).max(0);
        *remaining -= take;
        row.owned_quantity = take;
    }
}
```

At its one call site in `get_deck` (`deck.rs:3084`), pass
`crate::deck_driven::stored(conn)`.

> Note the refactor: the old `claimed_for` folded the variant test and the category test
> together. Splitting them is what lets the derived branch keep inactive categories while the
> hand-kept branch still drops them. `the_allocator_claims_nothing_for_the_theory_variant`
> must still pass unchanged.

- [ ] **Step 5: Swap the theory spare**

Turn `OWNED_SPARE_SQL` (`deck_theory.rs:202`) into a function, keeping the doc comment and
adding the derived arm:

```rust
/// … (existing doc comment, unchanged) …
///
/// **The derived arm has no `deck_allocations` in it**, because that ledger is not written in
/// this mode ([`crate::deck::allocate_deck`] stands down). "Copies a built deck is using"
/// becomes exactly that — a sum over the built decks' own live rows — and `is_built` keeps
/// the job it has always had: a card in an unbuilt deck is still available to a plan.
fn owned_spare_sql(conn: &Connection) -> String {
    if !crate::deck_driven::stored(conn) {
        return OWNED_SPARE_SQL_TABLE.to_owned();
    }
    format!(
        "SELECT coalesce((SELECT sum(dc.quantity) FROM deck_cards dc
                           WHERE {LIVE} AND dc.card_id = ?1
                             AND coalesce(dc.finish, 'nonfoil') = coalesce(?2, 'nonfoil')), 0) -
                coalesce((SELECT sum(dc2.quantity) FROM deck_cards dc2
                            JOIN decks d ON d.id = dc2.deck_id
                           WHERE dc2.variant = 'live' AND d.is_built = 1
                             AND dc2.card_id = ?1
                             AND coalesce(dc2.finish, 'nonfoil') = coalesce(?2, 'nonfoil')), 0)",
        LIVE = crate::collection_source::LIVE
    )
}
```

Rename the existing `const OWNED_SPARE_SQL` to `OWNED_SPARE_SQL_TABLE` and change the prepare
at `deck_theory.rs:319` to `conn.prepare(&owned_spare_sql(conn))`. The bound parameters
(`?1` the printing, `?2` the finish) are unchanged in both arms, so nothing at the call site
moves.

- [ ] **Step 6: Route every deck write through the conditional wrapper**

Change `crate::sync::with_write(&state, …)` to
`crate::collection_source::with_write_owned_if_derived(&state, …)` in exactly these command
wrappers, which are the ones that can change `deck_cards.quantity`, `.variant` or `.card_id`:

| File | Line | Command |
| --- | --- | --- |
| `deck.rs` | `:3623` | `deck_update` — carries the theory move |
| `deck.rs` | `:3643` | `deck_delete` |
| `deck.rs` | `:3688` | `deck_duplicate` |
| `deck.rs` | `:3804` | `deck_missing_to_wishlist` |
| `deck.rs` | `:3826` | `deck_add_card` |
| `deck.rs` | `:3855` | `deck_set_card_quantity` |
| `deck.rs` | `:3882` | `deck_category_clear` |
| `deck.rs` | `:3908` | `deck_move_card` |
| `deck.rs` | `:3939` | `deck_swap_printing` |
| `deck.rs` | `:3971` | `deck_set_card_finish` |
| `deck_meta.rs` | `:1864` | `deck_category_delete` |
| `deck_undo.rs` | `:1215` | `deck_undo_apply` |
| `deck_undo.rs` | `:1230` | `deck_redo_apply` |

**Leave `deck_meta.rs:1836` (`set_category_active`) on plain `with_write`** — an inactive
category counts toward a deck-driven collection, so flipping the switch changes nothing about
what the reader owns. That is the one place this feature's rule makes a wrapper *unnecessary*
where the allocator needs one, and it is worth a comment saying so.

Also leave `decks_clear` (`reset.rs`) alone only if it already invalidates; if it does not,
route it too and say so in the report — it is the largest change to `owned` a deck-driven
reader can make.

- [ ] **Step 7: Invalidate after the reconciler's sweep**

`reconcile::merge_deck_cards` (`reconcile.rs:337`) repoints and folds `deck_cards` rows after
every ingest, with no user in the loop and no command wrapper to hang a rebuild off. At the
end of the reconciler's post-ingest entry point, after the sweep has committed:

```rust
    // The one deck write with no command behind it. A migrated printing changes which
    // `cards` row a live deck row points at, which is exactly what the owned dimension is a
    // set of — and a sync is the one moment nobody is watching the screen.
    if crate::deck_driven::stored(conn) {
        crate::index::lifecycle::invalidate_owned(state);
    }
```

Thread `state` in if the function does not already have it; if it genuinely cannot reach one,
invalidate from the ingest's caller instead and say which you chose.

- [ ] **Step 8: Run the tests to verify they pass**

```
cargo test --manifest-path src-tauri/Cargo.toml deck
cargo test --manifest-path src-tauri/Cargo.toml reconcile::
```
Expected: PASS. `deck` selects `deck::`, `deck_meta::`, `deck_theory::`, `deck_undo::` and
`deck_audit::` together, which is the point — this task edits four of them. State the
selected count.

- [ ] **Step 9: Report to the controller**

Do not commit. Report which wrappers you changed, which you deliberately left, and where the
reconciler's invalidation ended up.

---

### Task 7: `collection_row_decks` — where a row's copies live

**Files:**
- Create: `src-tauri/src/collection_decks.rs`
- Modify: `src-tauri/src/lib.rs` (`mod collection_decks;` and one `invoke_handler` line)
- Test: inline `#[cfg(test)] mod tests` in `src-tauri/src/collection_decks.rs`

**Interfaces:**
- Consumes: `collection_source::LIVE` (Task 2); `crate::sync::{lock_db_read, AppState}`.
- Produces:
  - `pub struct RowDeck { deck_id: i64, deck_name: String, quantity: i64 }`, camelCase over IPC
  - command `collection_row_decks(card_id: String, finish: String, lang: String)
    -> Result<Vec<RowDeck>, String>`

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    fn db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        schema::migrate(&mut conn).unwrap();
        conn.execute_batch(
            "INSERT INTO decks (id, name, created_at, updated_at)
                  VALUES (1,'Krenko',0,0), (2,'Atraxa',0,0), (3,'Plan',0,0);
             INSERT INTO deck_categories (id, deck_id, name, kind, is_active, sort_order,
                                          created_at, updated_at)
                  VALUES (10,1,'Ramp','main',1,0,0,0),
                         (11,1,'Maybeboard','maybe',0,1,0,0),
                         (12,2,'Ramp','main',1,0,0,0),
                         (13,3,'Ramp','main',1,0,0,0);
             INSERT INTO deck_cards (deck_id, category_id, variant, card_id, set_code,
                                     collector_number, lang, name, quantity, finish,
                                     created_at, updated_at)
                  VALUES (1,10,'live','p1','cmr','472','en','Sol Ring',1,NULL,0,0),
                         (1,11,'live','p1','cmr','472','en','Sol Ring',2,NULL,0,0),
                         (1,10,'live','p1','cmr','472','en','Sol Ring',1,'foil',0,0),
                         (2,12,'live','p1','cmr','472','en','Sol Ring',1,NULL,0,0),
                         (3,13,'theory','p1','cmr','472','en','Sol Ring',9,NULL,0,0);",
        )
        .unwrap();
        conn
    }

    /// One line per deck, summed across that deck's categories — including the switched-off
    /// one, because the tooltip has to add up to the number above it.
    #[test]
    fn it_sums_a_decks_categories_into_one_line() {
        let got = row_decks(&db(), "p1", "nonfoil", "en").unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].deck_name, "Atraxa", "ordered by name, not by id");
        assert_eq!(got[0].quantity, 1);
        assert_eq!(got[1].deck_name, "Krenko");
        assert_eq!(got[1].quantity, 3, "1 in Ramp and 2 in the inactive Maybeboard");
    }

    /// The collection spells the regular copy `nonfoil` and the deck stores NULL. Asking
    /// with the row's own word must find the row.
    #[test]
    fn the_regular_finish_is_translated_back() {
        let foil = row_decks(&db(), "p1", "foil", "en").unwrap();
        assert_eq!(foil.len(), 1);
        assert_eq!(foil[0].quantity, 1);
    }

    /// The tooltip explains a row of the collection, and a theory row is not one.
    #[test]
    fn a_theory_row_is_not_listed() {
        let got = row_decks(&db(), "p1", "nonfoil", "en").unwrap();
        assert!(got.iter().all(|d| d.deck_name != "Plan"));
    }

    #[test]
    fn a_card_in_no_deck_answers_an_empty_list() {
        assert!(row_decks(&db(), "nope", "nonfoil", "en").unwrap().is_empty());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```
cargo test --manifest-path src-tauri/Cargo.toml collection_decks
```
Expected: FAIL to compile — the module does not exist.

- [ ] **Step 3: Write the module**

```rust
//! Which decks a deck-driven collection row's copies are sitting in.
//!
//! The one question a derived row creates and nothing else answers: the Collection page's
//! Actions column loses its delete button while [`crate::deck_driven`] is on, and this is
//! what fills it — a count drawn from the row itself, and these names behind a tooltip.
//!
//! **Asked lazily, per row, on hover.** A 100-row page would otherwise carry several hundred
//! deck names nobody looks at, and the count the reader actually reads is already free in the
//! aggregate [`crate::collection_source::rows`] groups by.

use crate::sync::AppState;
use rusqlite::{params, Connection};
use std::sync::Arc;

/// One deck holding copies of a collection row's printing.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowDeck {
    pub deck_id: i64,
    pub deck_name: String,
    /// Copies in **this** deck, summed across its categories — the inactive ones included,
    /// because these lines have to add up to the count the row shows.
    pub quantity: i64,
}

/// The decks holding a printing, in the finish and language the collection row names.
///
/// **`finish` arrives in the collection's spelling and is translated back.** A regular copy
/// is `'nonfoil'` on a collection row and NULL on a deck card, so the predicate is the same
/// `coalesce(dc.finish, 'nonfoil')` the derived source groups by — the same expression, for
/// the same reason, and a mismatch here would silently empty the tooltip on every regular
/// row while the count above it read three.
///
/// `live` only, matching the rule the row itself came from. Ordered by name so the tooltip
/// reads the way the Decks page does, with the id as the tiebreak two decks of one name need.
pub fn row_decks(
    conn: &Connection,
    card_id: &str,
    finish: &str,
    lang: &str,
) -> Result<Vec<RowDeck>, String> {
    let sql = format!(
        "SELECT d.id, d.name, sum(dc.quantity)
           FROM deck_cards dc
           JOIN decks d ON d.id = dc.deck_id
          WHERE {LIVE}
            AND dc.card_id = ?1
            AND coalesce(dc.finish, 'nonfoil') = ?2
            AND dc.lang = ?3
          GROUP BY d.id, d.name
          ORDER BY d.name COLLATE NOCASE ASC, d.id ASC",
        LIVE = crate::collection_source::LIVE
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![card_id, finish, lang], |r| {
            Ok(RowDeck {
                deck_id: r.get(0)?,
                deck_name: r.get(1)?,
                quantity: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Read-only connection, blocking pool — as every read in this app is, so a hovered tooltip
/// never queues behind a sync.
#[tauri::command]
pub async fn collection_row_decks(
    state: tauri::State<'_, Arc<AppState>>,
    card_id: String,
    finish: String,
    lang: String,
) -> Result<Vec<RowDeck>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        row_decks(
            &crate::sync::lock_db_read(&state),
            &card_id,
            &finish,
            &lang,
        )
    })
    .await
    .map_err(|e| format!("the decks holding this card could not be read: {e}"))?
}
```

Add `use serde::Serialize;` at the top.

- [ ] **Step 4: Register it**

`mod collection_decks;` in `lib.rs`, and `collection_decks::collection_row_decks,` in
`invoke_handler` beside the other `collection_*` commands at `:316-322`.

- [ ] **Step 5: Run the tests to verify they pass**

```
cargo test --manifest-path src-tauri/Cargo.toml collection_decks
```
Expected: PASS, 4 tests selected. State the selected count.

- [ ] **Step 6: Report to the controller**

Do not commit. Report the `RowDeck` field names as they serialize (camelCase) for Task 8.

---

### Task 8: The TypeScript mirror

**Files:**
- Modify: `src/lib/ipc.ts` — the settings block near `:3722`, the collection block near
  `:2995`, and the `CollectionRow` type at `:814`
- Create: `src/lib/useDeckDrivenCollection.ts`
- Test: `src/lib/ipc.test.ts` (extend), `src/lib/useDeckDrivenCollection.test.ts` (create)

**Interfaces:**
- Consumes: the commands from Tasks 1, 3 and 7.
- Produces:
  - `ipc.deckDrivenCollection(): Promise<boolean>`
  - `ipc.setDeckDrivenCollection(enabled: boolean): Promise<void>`
  - `ipc.collectionRowDecks(cardId, finish, lang): Promise<RowDeck[]>`
  - `export interface RowDeck { deckId: number; deckName: string; quantity: number }`
  - `CollectionRow.condition: string | null`, `CollectionRow.deckCount: number | null`
  - `export const DECK_DRIVEN_KEY = ["deckDrivenCollection"]`
  - `export function useDeckDrivenCollection(): { deckDriven: boolean; setDeckDriven: (on: boolean) => void; error: string | null }`

- [ ] **Step 1: Write the failing tests**

In `src/lib/ipc.test.ts`, following the file's existing "every wrapper names its command"
pattern:

```ts
it("names the deck driven collection commands", async () => {
  await expectInvoke(() => ipc.deckDrivenCollection(), "deck_driven_collection", {});
  await expectInvoke(
    () => ipc.setDeckDrivenCollection(true),
    "set_deck_driven_collection",
    { enabled: true },
  );
  await expectInvoke(
    () => ipc.collectionRowDecks("p1", "nonfoil", "en"),
    "collection_row_decks",
    { cardId: "p1", finish: "nonfoil", lang: "en" },
  );
});
```

Create `src/lib/useDeckDrivenCollection.test.ts`:

```ts
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { useDeckDrivenCollection } from "./useDeckDrivenCollection";
import { withQueryClient } from "@/test-setup"; // the repo's existing wrapper

describe("useDeckDrivenCollection", () => {
  it("reads the stored setting", async () => {
    vi.spyOn(ipc, "deckDrivenCollection").mockResolvedValue(true);
    const { result } = renderHook(() => useDeckDrivenCollection(), withQueryClient());
    await waitFor(() => expect(result.current.deckDriven).toBe(true));
  });

  it("shows the switch moving before the command answers", async () => {
    vi.spyOn(ipc, "deckDrivenCollection").mockResolvedValue(false);
    let settle: () => void = () => {};
    vi.spyOn(ipc, "setDeckDrivenCollection").mockReturnValue(
      new Promise<void>((r) => {
        settle = r;
      }),
    );
    const { result } = renderHook(() => useDeckDrivenCollection(), withQueryClient());
    await waitFor(() => expect(result.current.deckDriven).toBe(false));
    act(() => result.current.setDeckDriven(true));
    expect(result.current.deckDriven).toBe(true);
    act(() => settle());
  });

  /// Unlike the nav rail's, this refusal IS surfaced and the optimistic half IS rolled
  /// back — a page that lists a different set of cards than the setting says must not be
  /// left standing.
  it("rolls back and says so when the write is refused", async () => {
    vi.spyOn(ipc, "deckDrivenCollection").mockResolvedValue(false);
    vi.spyOn(ipc, "setDeckDrivenCollection").mockRejectedValue(new Error("BUSY"));
    const { result } = renderHook(() => useDeckDrivenCollection(), withQueryClient());
    await waitFor(() => expect(result.current.deckDriven).toBe(false));
    act(() => result.current.setDeckDriven(true));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.deckDriven).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```
npx vitest run src/lib/ipc.test.ts src/lib/useDeckDrivenCollection.test.ts
```
Expected: FAIL — the wrappers and the hook do not exist.

- [ ] **Step 3: Add the three wrappers and the two type changes**

In `src/lib/ipc.ts`, beside `navCollapsed` / `setNavCollapsed` at `:3722`:

```ts
  /** Whether the collection is the sum of the reader's live decks. `src-tauri/src/deck_driven.rs`. */
  deckDrivenCollection: () => invoke<boolean>("deck_driven_collection"),
  /** Remember it. Refuses under a sync, and unlike the rail's twin that refusal is surfaced. */
  setDeckDrivenCollection: (enabled: boolean) =>
    invoke<void>("set_deck_driven_collection", { enabled }),
```

Beside the collection block at `:2995`:

```ts
  /** The decks holding one deck-driven collection row's copies. `finish` is the row's own
   *  spelling — `nonfoil`, not the deck table's NULL. */
  collectionRowDecks: (cardId: string, finish: string, lang: string) =>
    invoke<RowDeck[]>("collection_row_decks", { cardId, finish, lang }),
```

with, beside `CollectionRow`:

```ts
/** One deck holding copies of a collection row's printing. `src-tauri/src/collection_decks.rs`. */
export interface RowDeck {
  deckId: number;
  deckName: string;
  /** Copies in this deck, its inactive categories included. */
  quantity: number;
}
```

And on `CollectionRow` (`:814`):

```ts
  /** `null` when the collection is derived from the decks — a deck card has nowhere to
   *  record a condition, and the column's `NM` default would be a fact nobody stated. */
  condition: string | null;
  /** How many decks these copies are spread across. `null` unless the collection is
   *  derived from them. */
  deckCount: number | null;
```

Update the file header note at `:31-45` — "Four settings carry no struct at all" becomes five,
and `deckDrivenCollection` joins `navCollapsed` as a bare `boolean` with no narrowing to do.

- [ ] **Step 4: Write the hook**

Create `src/lib/useDeckDrivenCollection.ts`:

```ts
import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, ipcError } from "@/lib/ipc";

/** Where the setting lives for the life of the window. Exported so a story or a test seeds
 *  the cache rather than mocking the command, and so one spelling cannot drift into two. */
export const DECK_DRIVEN_KEY = ["deckDrivenCollection"];

/**
 * Whether the collection is the sum of the reader's live decks — remembered across restarts.
 *
 * TanStack Query rather than the zustand store, for `useNavCollapsed`'s reason: `store.ts`
 * scopes itself to UI state and hands anything backed by the database to Query, and this is
 * one `app_meta` row that outlives the process.
 *
 * **Where this deliberately differs from `useNavCollapsed`.** That hook writes optimistically
 * and never rolls back, on the argument that a refused write costs the reader one launch's
 * starting state and snapping the rail shut under their hand is worse. Every clause of that
 * points the other way here: this switch decides what the Collection page is a *list of*, so
 * a refusal that left the switch reading "on" over a hand-kept collection would be the page
 * and the setting disagreeing until the next restart. So the optimistic half is rolled back
 * and the refusal is surfaced — `error` is what the panel's `PanelAlert` draws.
 *
 * **A read that fails is `false`** — the hand-kept collection, which is where the reader's own
 * rows are. That is the right floor: the degraded state shows them their data rather than an
 * empty page.
 *
 * The four invalidations on success are the four surfaces the flag moves — the same four
 * `AddToCollection` already fires, because the same four things change.
 */
export function useDeckDrivenCollection(): {
  deckDriven: boolean;
  setDeckDriven: (enabled: boolean) => void;
  error: string | null;
} {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: DECK_DRIVEN_KEY,
    queryFn: () => ipc.deckDrivenCollection(),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const write = useMutation({
    mutationFn: (enabled: boolean) => ipc.setDeckDrivenCollection(enabled),
    onSuccess: () => {
      setError(null);
      for (const key of [["collection"], ["cards", "search"], ["decks"], ["wishlist"]]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (e, enabled) => {
      // The rollback the rail's twin refuses to do, and the reason is the page behind it.
      queryClient.setQueryData(DECK_DRIVEN_KEY, !enabled);
      setError(ipcError(e));
    },
  });

  const startWrite = write.mutate;
  const setDeckDriven = useCallback(
    (enabled: boolean) => {
      queryClient.setQueryData(DECK_DRIVEN_KEY, enabled);
      startWrite(enabled);
    },
    [queryClient, startWrite],
  );

  return { deckDriven: query.data ?? false, setDeckDriven, error };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```
npx vitest run src/lib/ipc.test.ts src/lib/useDeckDrivenCollection.test.ts
```
Expected: PASS.

- [ ] **Step 6: Report to the controller**

Do not commit. Report the exported names so wave E's four tasks can be dispatched.

---

### Task 9: The Storybook fake

**Files:**
- Modify: `.storybook/fake/db.ts` — `FakeDb` (`:706`), `makeDb` (`:1092`), `readHandlers`
  (`:4118`), `writeHandlers` (`:6258`), and the collection / search / wishlist / deck read
  handlers
- Modify: `.storybook/fake/seeds.ts` — one seed with the setting on
- Test: `.storybook/fake/db.test.ts` (extend)

**Interfaces:**
- Consumes: the command names from Tasks 1, 3, 7.
- Produces: `FakeDb.deckDrivenCollection: boolean`; a `deckDriven` seed.

> `ripgrep treats `.storybook/fake/db.ts` as binary, so "no matches" there is a lie — Read
> the file rather than grepping it.

- [ ] **Step 1: Write the failing tests**

In `.storybook/fake/db.test.ts`:

```ts
it("answers the deck driven setting and lets a sync refuse the write", () => {
  const db = makeDb();
  const read = readHandlers(db);
  const write = writeHandlers(db);
  expect(read.deck_driven_collection()).toBe(false);
  write.set_deck_driven_collection({ enabled: true });
  expect(read.deck_driven_collection()).toBe(true);
});

it("lists the live decks as the collection when the setting is on", () => {
  const db = makeDb({ deckDrivenCollection: true, decks: /* one deck, 2 x p1 live */ });
  const page = readHandlers(db).collection_list({ limit: 100, offset: 0 });
  expect(page.total).toBe(1);
  expect(page.items[0].quantity).toBe(2);
  expect(page.items[0].condition).toBeNull();
  expect(page.items[0].deckCount).toBe(1);
});

it("refuses every collection write while the setting is on", () => {
  const db = makeDb({ deckDrivenCollection: true });
  const write = writeHandlers(db);
  expect(() => write.collection_add({ cardId: "p1", finish: "nonfoil", quantity: 1 })).toThrow(
    /driven by your decks/,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```
npx vitest run .storybook/fake/db.test.ts
```
Expected: FAIL — no such field or handlers.

- [ ] **Step 3: Add the field and the two handlers**

On `FakeDb`, beside `navCollapsed` (`:817`):

```ts
  /**
   * Whether the collection is the sum of the live deck lists — `app_meta`'s
   * `deck_driven_collection` row.
   *
   * A plain `boolean` and not `boolean | null`, `navCollapsed`'s shape for its reason: the
   * backend is infallible at the far end — a missing row, a junk row and an unreadable row
   * all answer `false` — so a third state here is one the app can never see.
   */
  deckDrivenCollection: boolean;
```

`makeDb` default: `deckDrivenCollection: init.deckDrivenCollection ?? false,`.

In `readHandlers`, beside `nav_collapsed` (`:4997`):

```ts
    deck_driven_collection: (): boolean => db.deckDrivenCollection,
```

In `writeHandlers`, beside `set_nav_collapsed` (`:8129`):

```ts
    set_deck_driven_collection: (args: { enabled: boolean }): void => {
      refuseIfBusy(db);
      db.deckDrivenCollection = args.enabled;
    },
```

`refuseIfBusy` is not optional — `db.test.ts` sweeps every write handler asserting a running
sync can refuse it.

- [ ] **Step 4: Make the reads honour the flag**

Five handlers branch on `db.deckDrivenCollection`, each summing the live deck rows the way
the Rust does — `variant === "live"`, every category, `finish ?? "nonfoil"`, grouped by
`(cardId, finish, lang)`:

- `collection_list` — derived rows, `condition: null`, `deckCount` set
- `collection_summary` — the same rows, `tradelistCards: 0`
- `cards_search` — each result's `ownedQuantity`, and the `owned` filter
- `wishlist_list` — each wish's `ownedQuantity`, finish-aware
- `deck_get` — each live row's `ownedQuantity` equal to its own `quantity`

Write one shared helper in `db.ts` (`liveDeckCopies(db)`) returning the grouped map, so the
five callers cannot drift the way five hand-written sums would.

Add `collection_row_decks` to `readHandlers`, and make the five collection write handlers
throw the refusal sentence when the flag is on.

- [ ] **Step 5: Add a seed**

In `.storybook/fake/seeds.ts`, add a `deckDriven` seed: two decks with overlapping cards, one
of them holding a foil copy, one card only in a theory list, and no `collection_entries` at
all. It is what Task 13's stories draw.

- [ ] **Step 6: Run the tests to verify they pass**

```
npx vitest run .storybook/fake/db.test.ts
```
Expected: PASS. **Expect the busy sweep's count to change** — it enumerates the write
handlers, and there is one more now.

- [ ] **Step 7: Report to the controller**

Do not commit. Report the seed's name and the new busy-sweep count.

---

### Task 10: The Settings panel

**Files:**
- Create: `src/features/settings/DeckDrivenPanel.tsx`
- Create: `src/features/settings/DeckDrivenPanel.test.tsx`
- Create: `src/features/settings/DeckDrivenPanel.stories.tsx`
- Modify: `src/features/settings/SettingsPage.tsx:55-85`
- Modify: `src/features/settings/controls.ts` — add the shared switch recipe

**Interfaces:**
- Consumes: `useDeckDrivenCollection` (Task 8); `SettingsSection` and `PanelAlert` from
  `panelChrome.tsx`; `BUTTON` from `controls.ts`.
- Produces: `<DeckDrivenPanel deckDriven={…} />` taking the hook's return value as one prop,
  the shape every other panel on this page has.

- [ ] **Step 1: Write the failing tests**

```tsx
describe("DeckDrivenPanel", () => {
  it("is a switch that says which state it is in", () => {
    render(<DeckDrivenPanel deckDriven={off()} />);
    const sw = screen.getByRole("switch", { name: /deck driven collection.*disabled/i });
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("asks for the other state when pressed", async () => {
    const setDeckDriven = vi.fn();
    render(<DeckDrivenPanel deckDriven={{ ...off(), setDeckDriven }} />);
    await userEvent.click(screen.getByRole("switch"));
    expect(setDeckDriven).toHaveBeenCalledWith(true);
  });

  it("explains what the setting does before it is touched", () => {
    render(<DeckDrivenPanel deckDriven={off()} />);
    expect(screen.getByText(/sum of the cards in your decks/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is deleted/i)).toBeInTheDocument();
  });

  it("says so when the write is refused", () => {
    render(<DeckDrivenPanel deckDriven={{ ...off(), error: "The database is busy." }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The database is busy.");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```
npx vitest run src/features/settings/DeckDrivenPanel.test.tsx
```
Expected: FAIL — no such module.

- [ ] **Step 3: Add the switch recipe to `controls.ts`**

```ts
/**
 * The panel switch — a `role="switch"` in `BUTTON`'s box.
 *
 * Two families joined: the ARIA is `DeckSettingsForm`'s `TheorySwitch`, which is the app's
 * one real switch, and the box is this file's `BUTTON`, which is what a control on this page
 * looks like. Here rather than in the panel because this file exists to hold the vocabulary
 * two panels share, and the second one that wants a switch must not invent a third look.
 */
export const SWITCH = cn(
  BUTTON,
  "h-8 shrink-0 px-2.5 text-xs transition-colors duration-150 motion-reduce:transition-none",
);

/** What a switch's box is coloured by. Accent when on, quiet-until-hovered when off. */
export const switchTone = (on: boolean): string =>
  on ? "border-accent text-accent" : "border-border text-dim hover:border-accent hover:text-accent";
```

- [ ] **Step 4: Write the panel**

```tsx
import type { JSX } from "react";
import { cn } from "@/lib/utils";
import type { useDeckDrivenCollection } from "@/lib/useDeckDrivenCollection";
import { SWITCH, switchTone } from "./controls";
import { PanelAlert, SettingsSection } from "./panelChrome";

/**
 * Whether the reader's decks *are* their collection.
 *
 * Placed with `MarketplacePanel` in the page's top half, by the ordering rule
 * `SettingsPage` states: ordered by what a press costs, and this one costs nothing — it
 * changes where a list is read from and deletes nothing, so it is free to try and free to
 * undo. It is the page's second real *setting* rather than a report or a deletion.
 *
 * **The copy has three jobs and they are all load-bearing.** It says what the collection
 * becomes (the sum of the live lists), what it leaves out and why (Theory is what a deck is
 * being built toward, so it is not something the reader has), and that nothing is deleted —
 * which is the sentence that makes the switch safe to press. The last is not reassurance: a
 * reader who believes this might throw their collection away will never find out that it
 * does not.
 */
export function DeckDrivenPanel({
  deckDriven,
}: {
  deckDriven: ReturnType<typeof useDeckDrivenCollection>;
}): JSX.Element {
  const on = deckDriven.deckDriven;
  return (
    <SettingsSection id="deck-driven" title="Deck driven collection">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <p className="text-sm text-dim">
            Track your collection as the sum of the cards in your decks, instead of adding
            cards to it by hand. Every copy in every deck counts, including sideboards and
            piles you have switched off — you still own those cards.
          </p>
          <p className="text-sm text-dim">
            A deck&rsquo;s <strong className="font-medium text-text">Theory</strong> list is
            left out: that is what the deck is being built toward, not what is sleeved up. A
            deck with no Theory list counts in full.
          </p>
          <p className="text-sm text-dim">
            While this is on the collection cannot be edited by hand, and{" "}
            <strong className="font-medium text-text">nothing is deleted</strong> — anything
            you added yourself is waiting exactly as you left it when you switch back.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          // Named by the heading beside it *and* by its own word, in that order:
          // `aria-label` would replace the visible state with something that does not
          // contain it, which is the WCAG 2.5.3 failure a control labelled by its own text
          // exists to avoid.
          aria-labelledby="deck-driven-heading deck-driven-state"
          onClick={() => deckDriven.setDeckDriven(!on)}
          className={cn(SWITCH, switchTone(on))}
        >
          <span id="deck-driven-state">{on ? "Enabled" : "Disabled"}</span>
        </button>
      </div>

      <PanelAlert tone="problem">{deckDriven.error}</PanelAlert>
    </SettingsSection>
  );
}
```

`SettingsSection`'s `id="deck-driven"` produces `<h2 id="deck-driven-heading">`, which is what
`aria-labelledby` names — the pairing is load-bearing and every panel test relies on it.

- [ ] **Step 5: Mount it on the page**

In `SettingsPage.tsx`, call the hook beside the other four and render the panel directly after
`<MarketplacePanel />`:

```tsx
  const deckDriven = useDeckDrivenCollection();
```
```tsx
      <MarketplacePanel marketplace={marketplace} />

      {/* Below the marketplace and above the undo, by the page's cost ordering: this one
          changes where a list is read from and deletes nothing. */}
      <DeckDrivenPanel deckDriven={deckDriven} />
```

- [ ] **Step 6: Write the stories**

`DeckDrivenPanel.stories.tsx` with `Disabled`, `Enabled` and `Refused` (a non-null `error`),
following the neighbouring panels' story shape.

- [ ] **Step 7: Run the tests to verify they pass**

```
npx vitest run src/features/settings
```
Expected: PASS, including `SettingsPage`'s own test if it enumerates the page's regions —
there is one more now.

- [ ] **Step 8: Report to the controller**

Do not commit.

---

### Task 11: The Collection page in this mode

**Files:**
- Modify: `src/features/collection/CollectionPage.tsx` — the mode note, the empty state, and
  the two disabled mutations
- Modify: `src/features/collection/CollectionTable.tsx:164-192` (the Finish · condition
  column) and `:261-…` (the Actions column)
- Modify: `src/features/collection/CollectionFilterBar.tsx:135-144` (the Condition chips)
- Modify: `src/features/collection/CollectionSummary.tsx` (hide the tradelist figure)
- Modify: `src/features/collection/useCollection.ts:212,244` (the flag in both query keys)
- Create: `src/features/collection/DeckCountCell.tsx` + its test
- Test: extend `CollectionPage.test.tsx`, `CollectionFilterBar.test.tsx`

**Interfaces:**
- Consumes: `useDeckDrivenCollection` (Task 8), `ipc.collectionRowDecks`, the `deckCount` and
  nullable `condition` fields on `CollectionRow`.
- Produces: `<DeckCountCell row={…} />`.

- [ ] **Step 1: Write the failing tests**

```tsx
it("says the collection is coming from the decks, and where the setting is", async () => {
  renderCollection({ deckDriven: true });
  expect(await screen.findByText(/driven by your decks/i)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
});

it("hides the condition filter, because a deck card has no condition", () => {
  renderCollection({ deckDriven: true });
  expect(screen.queryByRole("group", { name: "Condition" })).not.toBeInTheDocument();
});

it("shortens the finish column's header when there is no condition in it", async () => {
  renderCollection({ deckDriven: true });
  expect(await screen.findByRole("columnheader", { name: /^Finish$/ })).toBeInTheDocument();
});

it("draws the deck count where the delete button was", async () => {
  renderCollection({ deckDriven: true }); // seeded row has deckCount 3
  expect(await screen.findByText("3 decks")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
});

it("says one deck in the singular", async () => {
  renderCollection({ deckDriven: true, deckCount: 1 });
  expect(await screen.findByText("1 deck")).toBeInTheDocument();
});

it("disables the quantity stepper with its reason", async () => {
  renderCollection({ deckDriven: true });
  const plus = await screen.findByRole("button", { name: /add a copy.*driven by your decks/i });
  expect(plus).toHaveAttribute("aria-disabled", "true");
});

it("says there are no decks yet rather than nothing added", async () => {
  renderCollection({ deckDriven: true, rows: [] });
  expect(await screen.findByText(/no decks yet/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```
npx vitest run src/features/collection
```
Expected: FAIL.

- [ ] **Step 3: Put the flag in both query keys**

In `useCollection.ts`, take `const { deckDriven } = useDeckDrivenCollection();` and append
`deckDriven ? "decks" : ""` as the final segment of `filterKey` (`:212`). Both the list and
the summary are built from it, so one addition moves both — and it must be there, or a flip
serves the other mode's cached page against the new setting.

- [ ] **Step 4: The mode note and the empty state**

In `CollectionPage.tsx`, above the filter bar when `deckDriven` is true:

```tsx
        <p className="text-sm text-dim">
          Your collection is the sum of the cards in your decks. Theory lists are left out.{" "}
          <Link to="/settings" className={LINK}>
            Change this in Settings
          </Link>
          .
        </p>
```

and swap the empty state's sentence for "Your collection is driven by your decks, and you have
no decks yet." when the flag is on and there are no rows.

- [ ] **Step 5: The two columns**

In `CollectionTable.tsx`, the finish column's `header` becomes
`deckDriven ? "Finish" : "Finish · condition"` and its cell drops the ` · ${condition}` half
when `row.condition` is `null`. Test the **null**, not the flag — the DTO is the fact and a
cell that read the flag could disagree with the data it was handed.

The Actions column renders `<DeckCountCell row={row} />` instead of the delete button when
`deckDriven` is true.

- [ ] **Step 6: Write `DeckCountCell`**

```tsx
/**
 * How many decks this row's copies are spread across, and which.
 *
 * **Where the delete button was.** A derived row cannot be deleted — the copies are in the
 * decks, and that is where they are removed — so the column would otherwise be blank; and
 * "which decks is this in" is the one question a derived row creates that nothing else on
 * the page answers.
 *
 * **The names are fetched on hover, not with the page.** The count is free in the row, the
 * names are a query each, and a 100-row page would carry several hundred deck names nobody
 * looks at.
 */
export function DeckCountCell({ row }: { row: CollectionRow }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const decks = useQuery({
    queryKey: ["collection", "row-decks", row.cardId, row.finish, row.lang],
    queryFn: () => ipc.collectionRowDecks(row.cardId, row.finish, row.lang),
    enabled: open,
    staleTime: 30_000,
  });
  const n = row.deckCount ?? 0;
  if (n === 0) return null;
  return (
    <Tooltip
      describes={false}
      onOpenChange={setOpen}
      content={
        decks.data
          ? decks.data.map((d) => `${d.quantity} × ${d.deckName}`).join("\n")
          : "Loading…"
      }
    >
      <span className="text-xs text-dim">{n === 1 ? "1 deck" : `${n} decks`}</span>
    </Tooltip>
  );
}
```

Match the real `Tooltip` component's API from `docs/reference/tooltip` / its own file — the
props above are indicative of intent, not a contract. A `describes={false}` tooltip has **no
`role="tooltip"`**, so probe it in tests by its text and fixed position, not by role.

- [ ] **Step 7: Hide the two dead controls**

`CollectionFilterBar.tsx:135` — wrap the Condition `role="group"` in `{!deckDriven && ( … )}`,
and drop `conditions` from `activeFilterCount`'s inputs while the flag is on so the Reset all
badge cannot count a filter nobody can see.

`CollectionSummary.tsx` — hide the tradelist figure when the flag is on.

- [ ] **Step 8: Disable the stepper and the delete**

Both mutations get `aria-disabled` (not `disabled`, which is the app's rule for a control that
must stay reachable) and the reason appended to their accessible name:
`"Add a copy — your collection is driven by your decks"`. The `onClick` returns early.

- [ ] **Step 9: Run the tests to verify they pass**

```
npx vitest run src/features/collection
```
Expected: PASS.

- [ ] **Step 10: Report to the controller**

Do not commit.

---

### Task 12: The other three write surfaces

**Files:**
- Modify: `src/features/collection/AddToCollection.tsx:136` — the Collection arm
- Modify: `src/features/card/useCardMenuDeps.ts:71-73` and `src/features/card/cardMenu.tsx` —
  the Collection submenu
- Modify: `src/features/transfer/import/destinations/CollectionPreview.tsx:62` and the
  destination picker
- Modify: `src/features/settings/DangerZonePanel.tsx` — one clause on the collection button's
  sentence
- Test: extend `AddToCollection.test.tsx`, `cardMenu.test.tsx`, the import destination test

**Interfaces:**
- Consumes: `useDeckDrivenCollection` (Task 8).
- Produces: `export const DECK_DRIVEN_REASON = "Your collection is driven by your decks"` in
  `src/lib/useDeckDrivenCollection.ts`, so four surfaces cannot word it four ways.

- [ ] **Step 1: Write the failing tests**

```tsx
it("refuses the collection arm and says why", async () => {
  render(<AddToCollection … />, { deckDriven: true });
  const add = screen.getByRole("button", { name: /collection.*driven by your decks/i });
  expect(add).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(add);
  expect(ipc.collectionAdd).not.toHaveBeenCalled();
});

it("greys the card menu's Collection submenu", async () => {
  await openCardMenu({ deckDriven: true });
  // A greyed row's accessible name contains its reason, so match a regex rather than the
  // exact label — an exact-name query reads as "the row is missing".
  const row = screen.getByRole("menuitem", { name: /Collection/ });
  expect(row).toHaveAttribute("aria-disabled", "true");
});

it("refuses the collection import destination", async () => {
  render(<DestinationPicker … />, { deckDriven: true });
  expect(screen.getByRole("radio", { name: /collection.*driven by your decks/i }))
    .toHaveAttribute("aria-disabled", "true");
});

it("says the collection it clears is currently hidden", () => {
  render(<DangerZonePanel … />, { deckDriven: true });
  expect(screen.getByText(/currently hidden/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```
npx vitest run src/features/collection/AddToCollection.test.tsx src/features/card src/features/transfer src/features/settings/DangerZonePanel.test.tsx
```
Expected: FAIL.

- [ ] **Step 3: Add the shared reason**

In `src/lib/useDeckDrivenCollection.ts`:

```ts
/**
 * Why a collection write is unavailable, for the accessible name of every control that is
 * therefore inert.
 *
 * One constant for four surfaces. It is deliberately shorter than the backend's
 * `collection::DECK_DRIVEN` sentence: this is appended to a control's own label, where the
 * backend's is a whole refusal a reader reads on its own.
 */
export const DECK_DRIVEN_REASON = "Your collection is driven by your decks";
```

- [ ] **Step 4: Disable the four surfaces**

Each takes `aria-disabled`, appends `` ` — ${DECK_DRIVEN_REASON}` `` to its accessible name,
and returns early from its handler. Do **not** use the `disabled` attribute on the menu row —
a disabled menu item leaves the roving-tabindex ladder and the reader cannot read the reason.

The Danger Zone's sentence gains: `…your hand-built collection, which is currently hidden
because this collection is driven by your decks.` — conditionally, and only when the flag is
on. The button itself stays enabled: clearing the hidden rows is a legitimate thing to want.

- [ ] **Step 5: Run the tests to verify they pass**

```
npx vitest run src/features/collection src/features/card src/features/transfer src/features/settings
```
Expected: PASS.

- [ ] **Step 6: Report to the controller**

Do not commit.

---

### Task 13: Stories and documentation

**Files:**
- Create: `docs/reference/deck-driven-collection.md`
- Modify: `docs/reference/decks-storage.md`, `docs/reference/data-and-sync.md`,
  `src-tauri/CLAUDE.md`, `CLAUDE.md`
- Modify: `src/features/collection/CollectionPage.stories.tsx` — a deck-driven story

- [ ] **Step 1: Write the reference doc**

`docs/reference/deck-driven-collection.md`, holding what the spec's §2, §2a, §3, §4 and §6
hold, written as a record rather than a plan: the derived subquery in full, the two shapes and
why there are two, the table of seven readers, the five refusals and the id-collision that
makes them a fence, the allocator's early return, and the list of what a derived row cannot
carry. Name the date and say every figure is a Windows debug build.

- [ ] **Step 2: Update the four existing docs**

- `decks-storage.md` — a bullet beside the existing variant-fence note: `allocate_deck` returns
  early and leaves the ledger intact while the collection is deck driven, and
  `attribute_owned` reports full coverage on live rows including inactive categories, which is
  where this rule departs from the allocator's on purpose.
- `data-and-sync.md` — `app_meta`'s sixth key.
- `src-tauri/CLAUDE.md` — the rule: **any query that asks what the reader owns builds its SQL
  through `collection_source`, never by naming `collection_entries`.**
- `CLAUDE.md` (root) — one row in the reference-docs table.

Do **not** write down a count a build already answers. Re-count anything you do change in the
same commit.

- [ ] **Step 3: Add the story**

A `DeckDriven` story on `CollectionPage.stories.tsx` using Task 9's seed, with a play that
asserts the mode note, the deck count and the disabled stepper.

- [ ] **Step 4: Report to the controller**

Do not commit.

---

### Task 14: Live verification in the real window

Not a subagent task — the controller drives this, because it takes the app lock.

- [ ] **Step 1: Claim the lock and launch**

Per the `running-the-app` skill. Only one app runs across every worktree and the collision is
silent.

- [ ] **Step 2: Seed a real database**

Copy the main checkout's whole `data` folder (not just `mtg.db`) into
`src-tauri/target/debug/data/`, so there are real decks to derive from.

- [ ] **Step 3: Drive the pass over CDP**

Use PowerShell for `scripts/cdp.mjs` — Bash refuses the eval in a worktree. Wrap every binding
in an IIFE; a top-level `const` outlives its command. Split "click then read" into two evals:
clicking and counting in one eval answers about the frame before React re-rendered.

Check, in order:

1. Settings → the panel is there, reads Disabled, and the copy is legible at the window's
   width.
2. Press it → the Collection page changes with no restart. Note the row count before and
   after and put both numbers in the report.
3. The Finish column has no condition half; the Condition chips are gone; the Actions column
   reads "N decks"; hovering one lists the decks and the numbers **add up to the row's count**.
4. The search wall's Owned chip and the owned badges agree with the Collection page for one
   named card. This is the check the whole "every owned number" decision exists for.
5. Open a deck → no card is marked short.
6. Add a card to a deck → the Collection page's count moves without a restart, and so does
   the search Owned facet.
7. Try the Add to collection popup and the card menu's Collection submenu → both inert, both
   saying why.
8. Switch it back off → the hand-built collection returns, unchanged.

- [ ] **Step 4: Record what the window found**

Append a dated section to `docs/reference/decks-live-findings.md` — the numbers, and any bug
still open. Every UI task in Plans 2–3 found something the suite could not; assume this one
does too and write down what it was.

- [ ] **Step 5: Release the lock**

---

## Self-review

**Spec coverage.** §1 → Task 1. §2 and §2a → Task 2. §3's seven readers → Tasks 3 (collection),
4 (search, index, wishlist), 5 (import), 6 (theory) — and §3's `invalidate_owned` paragraph →
Task 6 steps 6 and 7, plus Task 5 step 4. §4's five refusals → Task 3 step 5; its four UI
surfaces → Tasks 11 and 12. §5 → Task 11, with the tooltip command in Task 7. §6 → Task 6.
§7 → Task 8. §8 → Task 9. Error handling → the refusal tests in Task 3 and the rollback test
in Task 8. Testing → each task's own steps plus Task 14. Documentation → Task 13.

**Known gaps, named rather than hidden.** Task 3's test helper names (`deck_driven_db`,
`input`, `dump_entries`) and Task 4's, 5's and 6's (`deck_driven_search_db`,
`two_printings_db`, `deck_db_with_theory`, `theory_db`, `spare`) are *new* helpers those tasks
must write against whatever harness their module already has — the seed data each one needs is
spelled out in the assertions, but the exact constructor is the module's business and is not
knowable from outside it. Task 11's `Tooltip` props are indicative: match the component's real
API.

**Type consistency.** `condition: Option<String>` / `string | null` and `deck_count: Option<i64>`
/ `deckCount: number | null` are introduced in Task 3 and consumed in Tasks 8, 9 and 11 under
those exact names. `RowDeck { deckId, deckName, quantity }` is produced in Task 7 and consumed
in Tasks 8, 9 and 11. `DECK_DRIVEN` (Rust, the full sentence) and `DECK_DRIVEN_REASON`
(TypeScript, the clause) are deliberately two different strings for two different jobs, and
Task 12 says so. `with_write_owned` and `with_write_owned_if_derived` are both defined in
Task 2 and are the only two wrappers any later task names.
