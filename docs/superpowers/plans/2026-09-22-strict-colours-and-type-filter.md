# Strict Colours and Card-Type Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a strict ("exactly these colours") mode to every colour filter in the app, and a new
eight-type card-type filter to every expanded filter tray.

**Architecture:** Strict colour adds an inclusion clause per *picked* letter alongside the
existing exclusion-per-unpicked-letter arm on `color_identity`, in both the SQL
(`filters.rs`) and its in-memory mirror (`index/facets.rs`). The type filter lands as
`cards.type_mask`, an eight-bit integer column filled at ingest and added to the covering index —
the `legalities` → `legal_mask` precedent — so a type-filtered browse stays inside
`idx_cards_collapse`.

**Tech Stack:** Rust (rusqlite, SQLite/FTS5), React 19 + TypeScript 6, Vitest, Storybook.

**Spec:** [docs/superpowers/specs/2026-09-22-strict-colours-and-type-filter-design.md](../specs/2026-09-22-strict-colours-and-type-filter-design.md)

## Global Constraints

- **Do not run `npm run verify`, `npm run test`, or `cargo test`.** Tasks 1–10 run in parallel in
  one worktree against a tree siblings are still changing; a suite run mid-fan-out fails for
  reasons that are not yours. The dispatcher runs verify once at fan-in (Task 11).
- **Do not `git add` or `git commit`.** Parallel agents in one worktree share a single git index,
  and a commit sweeps siblings' half-finished work into it. Edit files and report what you
  changed; the dispatcher commits.
- **Touch only the files your task lists under "Files".** Every other file belongs to a sibling
  task running right now.
- Write files as **LF**, not CRLF. Some source-parsing tests read files as text and a flipped
  line ending breaks them locally while `git diff --stat` hides it.
- Never install `@types/node`. TypeScript stays on 6.0.x.
- Every index on `cards` goes in `schema::CARDS_INDEXES` — the sync's swap drops the table with
  its indexes and replays only that list.
- Rust: `cargo fmt` conventions; no `\` line continuations inside attributes (`cargo fmt` turns
  them into literal spaces).
- If you need a scratch file, put a **task-unique** name in the scratchpad directory — siblings
  share it and identical filenames silently clobber.

## Frozen vocabulary — every task depends on these exact names

```rust
// src-tauri/src/cardtypes.rs
pub const TYPE_KEYS: [&str; 8] = [
    "Artifact", "Battle", "Creature", "Enchantment",
    "Instant", "Land", "Planeswalker", "Sorcery",
];
pub fn type_mask(type_line: &str) -> u32;
pub fn mask_of(picked: &[String]) -> u32;
pub const TYPE_MASK_SQL: &str;  // the backfill expression, `{col}` where the column goes
```

```rust
// src-tauri/src/filters.rs — CardFilters gains
pub colors_strict: Option<bool>,
pub types: Option<Vec<String>>,
// src-tauri/src/search.rs — SearchRequest gains the same two
```

```ts
// src/lib/ipc.ts — SearchRequest and CardFilters each gain
colorsStrict?: boolean;
types?: string[];
```

```ts
// src/features/search/FilterBar.tsx — FilterSurface gains
colorsStrict: boolean;                 // required, beside `colors`
toggleColorsStrict: () => void;        // required, beside `toggleColor`
types?: readonly string[];             // optional, below the line
toggleType?: (type: string) => void;   // optional, below the line
```

```ts
// src/features/search/useCardSearch.ts — new exports
export const CARD_TYPES: readonly string[];  // display order, Creature first, Land last
export function typesParam(picked: readonly string[]): string[] | undefined;
```

---

## Task 1: The card-type vocabulary

**Files:**
- Create: `src-tauri/src/cardtypes.rs`
- Modify: `src-tauri/src/lib.rs` (add the `mod cardtypes;` declaration beside `mod legalities;`)

**Interfaces:**
- Consumes: nothing.
- Produces: `TYPE_KEYS`, `type_mask`, `mask_of`, `TYPE_MASK_SQL` — see the frozen vocabulary above.
  Tasks 2, 3, 4 and 6 all call into this module.

Read `src-tauri/src/legalities.rs` first. This module is its sibling and should read like it.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/cardtypes.rs` with only the test module and the signatures, then fill it in.
The tests that must exist:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn bit(name: &str) -> u32 {
        1 << TYPE_KEYS.iter().position(|k| *k == name).unwrap()
    }

    #[test]
    fn a_plain_creature_masks_to_one_bit() {
        assert_eq!(type_mask("Creature — Human Wizard"), bit("Creature"));
    }

    /// Dryad Arbor is the card the whole "contains" rule is written for: `autoCategory.ts`
    /// files it under Land alone, and a *filter* must find it under both.
    #[test]
    fn a_card_with_two_types_carries_both_bits() {
        assert_eq!(
            type_mask("Land Creature — Forest Dryad"),
            bit("Land") | bit("Creature")
        );
        assert_eq!(
            type_mask("Artifact Creature — Golem"),
            bit("Artifact") | bit("Creature")
        );
    }

    /// `cards.type_line` on a double-faced card holds both halves, and an MDFC land is a land
    /// to anyone filtering for lands.
    #[test]
    fn both_faces_count() {
        assert_eq!(
            type_mask("Sorcery // Land"),
            bit("Sorcery") | bit("Land")
        );
    }

    /// The reason matching is whole-word and not a substring: `TYPE_KEYS` is append-only, and
    /// the day anyone appends `Plane`, a substring test would match every Planeswalker.
    #[test]
    fn a_type_word_is_matched_whole_and_never_as_a_substring() {
        assert_eq!(type_mask("Legendary Planeswalker — Jace"), bit("Planeswalker"));
        // The guard that keeps the above honest as the list grows.
        assert!(!TYPE_KEYS.contains(&"Plane"), "appending `Plane` needs this test re-read");
    }

    #[test]
    fn supertypes_and_subtypes_contribute_nothing() {
        assert_eq!(
            type_mask("Legendary Enchantment Creature — God"),
            bit("Enchantment") | bit("Creature")
        );
        // `Forest` is a subtype, not a type; only the half before the dash is read.
        assert_eq!(type_mask("Land — Forest"), bit("Land"));
    }

    #[test]
    fn a_blank_or_unknown_line_masks_to_nothing() {
        assert_eq!(type_mask(""), 0);
        assert_eq!(type_mask("Vanguard"), 0);
    }

    #[test]
    fn mask_of_ors_the_named_types_and_drops_the_rest() {
        assert_eq!(
            mask_of(&["Creature".to_owned(), "Land".to_owned()]),
            bit("Creature") | bit("Land")
        );
        assert_eq!(mask_of(&["Shiny".to_owned()]), 0);
        assert_eq!(mask_of(&[]), 0);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --lib cardtypes`
Expected: FAIL — the module does not compile yet.

- [ ] **Step 3: Write the implementation**

```rust
//! The eight card types as one integer, so a type filter can live in an index.
//!
//! [`crate::legalities`]' argument, one column over: `type_line` is not in
//! `idx_cards_collapse`, and `schema.rs` records that putting it there was measured and was a
//! straight loss. A `LIKE` predicate therefore knocks the collapsed browse off its covering
//! index — the class of change that file measures at 455–505 ms against 22–47 ms. A bitwise
//! test on an integer column stays inside it.
//!
//! **The key order is frozen and append-only.** Bit positions are stored data: `cards.type_mask`
//! holds them, so reordering this list silently reinterprets every row already on disk.
//!
//! **This is a third type vocabulary and it must not be folded into either of the other two.**
//! `autoCategory.ts` files a card into exactly one bucket (Land first, so Dryad Arbor is a land)
//! and `deckBuckets.ts` into exactly one bar (Creature first, so an artifact land heads the
//! Artifact bar). They disagree with each other about Land on purpose. This one answers a third
//! question — *does this card have this type* — so Dryad Arbor is in both Land and Creature, and
//! a reader pressing `Creature` who could not find an artifact creature has been told a
//! falsehood.

/// Every card type this app filters on. **Append only** — see the module docs. Bit *k* of a
/// mask is `TYPE_KEYS[k]`.
///
/// Alphabetical, like [`crate::legalities::LEGALITY_KEYS`] and for the same non-reason: the
/// order carries no meaning and the append-only rule outranks any wish to re-sort. What a
/// reader sees is `CARD_TYPES` in `useCardSearch.ts`, which is Creature-first and Land-last —
/// a matching order and a display order are two constants here for `autoCategory.ts`'s reason.
pub const TYPE_KEYS: [&str; 8] = [
    "Artifact",
    "Battle",
    "Creature",
    "Enchantment",
    "Instant",
    "Land",
    "Planeswalker",
    "Sorcery",
];

/// The SQL that computes [`type_mask`] over a column, for the corpus schema 5 backfill.
///
/// **A mirror of the function below, and the pair is pinned by a test** — the shape
/// `legalities.rs` uses for its own backfill. `{col}` is where the column name goes.
///
/// Whole-word matching is done by padding: every separator becomes a space, the whole line is
/// wrapped in spaces, and each type is looked for as `% Word %`. That is what keeps `Plane`
/// from ever matching `Planeswalker` if the list grows.
///
/// **Only the half before the dash is read**, because `Land — Forest` must not answer a
/// `Forest` that is a subtype. The `—` is replaced with a marker the pattern cannot cross.
pub fn type_mask_sql(col: &str) -> String {
    let padded = format!(
        "(' ' || replace(replace(replace({col}, '—', ' ~ '), '//', ' '), '-', ' ~ ') || ' ')"
    );
    let terms: Vec<String> = TYPE_KEYS
        .iter()
        .enumerate()
        .map(|(k, name)| {
            format!("(CASE WHEN {padded} LIKE '% {name} %' THEN {} ELSE 0 END)", 1u32 << k)
        })
        .collect();
    format!("coalesce({}, 0)", terms.join(" + "))
}

/// The types a type line names, as a bit per [`TYPE_KEYS`] entry.
///
/// Both faces of a double-faced card count — `cards.type_line` holds `Sorcery // Land`, and an
/// MDFC land is a land to anyone filtering for lands. Within each face only the **type** half
/// is read: everything after the `—` is subtypes.
pub fn type_mask(type_line: &str) -> u32 {
    let mut mask = 0u32;
    for face in type_line.split("//") {
        // Scryfall prints an em dash; a hyphen appears in hand-written fixtures. Either ends
        // the type half.
        let types = face
            .split(['—', '-'])
            .next()
            .unwrap_or("");
        for word in types.split_whitespace() {
            if let Some(k) = TYPE_KEYS.iter().position(|name| *name == word) {
                mask |= 1 << k;
            }
        }
    }
    mask
}

/// The picked type chips as one mask — OR within, which is what a chip row means.
///
/// A word this build does not know contributes nothing, so a request naming only unknown types
/// masks to 0. The caller reads that as "no type filter at all", matching
/// [`crate::filters::picked_rarities`]' rule that a blank list adds no SQL.
pub fn mask_of(picked: &[String]) -> u32 {
    let mut mask = 0u32;
    for want in picked {
        if let Some(k) = TYPE_KEYS.iter().position(|name| *name == want) {
            mask |= 1 << k;
        }
    }
    mask
}
```

Add `mod cardtypes;` to `src-tauri/src/lib.rs` beside `mod legalities;`, matching that line's
visibility exactly (`pub mod` if `legalities` is `pub mod`).

- [ ] **Step 4: Add the SQL/Rust agreement test**

Append to the test module. This is the test that keeps the backfill and the ingest from drifting —
`legalities.rs:264-293` is the same idea.

```rust
    #[test]
    fn the_backfill_sql_and_the_rust_function_agree() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (line TEXT);").unwrap();
        let lines = [
            "Creature — Human Wizard",
            "Land Creature — Forest Dryad",
            "Artifact Creature — Golem",
            "Legendary Planeswalker — Jace",
            "Legendary Enchantment Creature — God",
            "Sorcery // Land",
            "Land — Forest",
            "Instant",
            "Battle — Siege",
            "Vanguard",
            "",
        ];
        for line in lines {
            conn.execute("INSERT INTO t (line) VALUES (?1)", [line]).unwrap();
        }
        let sql = format!("SELECT line, {} FROM t", type_mask_sql("line"));
        let mut stmt = conn.prepare(&sql).unwrap();
        let rows: Vec<(String, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(rows.len(), lines.len());
        for (line, from_sql) in rows {
            assert_eq!(
                from_sql as u32,
                type_mask(&line),
                "SQL and Rust disagree about {line:?}"
            );
        }
    }

    /// A NULL type line must mask to 0 rather than to NULL — the column is `NOT NULL`.
    #[test]
    fn a_null_type_line_masks_to_zero_in_sql() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (line TEXT); INSERT INTO t (line) VALUES (NULL);")
            .unwrap();
        let sql = format!("SELECT {} FROM t", type_mask_sql("line"));
        let got: i64 = conn.query_row(&sql, [], |r| r.get(0)).unwrap();
        assert_eq!(got, 0);
    }
```

If `coalesce` around the sum is not enough to make a NULL line answer 0, wrap the padded
expression in `coalesce({col}, '')` instead and re-run — the test is the authority, not this
sentence.

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri && cargo test --lib cardtypes`
Expected: PASS, all nine tests.

- [ ] **Step 6: Report**

Do not commit. Report the file created, the `lib.rs` line added, and the test count.

---

## Task 2: Corpus schema 5 — the `type_mask` column

**Files:**
- Modify: `src-tauri/src/schema.rs`

**Interfaces:**
- Consumes: `crate::cardtypes::type_mask_sql` (Task 1).
- Produces: `cards.type_mask INTEGER NOT NULL DEFAULT 0`, present on every launch and inside
  `idx_cards_collapse`. Tasks 3, 4 and 6 read that column.

Read `migrate_corpus` (`schema.rs:6489`), `add_produced_mana` (`:6614`), `printed_size_is_owed`
(`:6630`) and `CARDS_INDEXES` (`:171-212`) before starting. This rung is their sibling with one
difference, stated in Step 3.

- [ ] **Step 1: Write the failing tests**

Add to `schema.rs`'s test module, beside the existing corpus-rung tests:

```rust
    /// Corpus schema 5 is **shape-gated, not version-gated**, for the reason `migrate_corpus`
    /// already documents twice: every converted database and every fresh install arrives here
    /// already stamped at head with a v26-shaped `cards`. A version gate would skip exactly
    /// those two populations and the next ingest would die on
    /// `table cards_staging has no column named type_mask`.
    #[test]
    fn a_head_stamped_corpus_still_gets_type_mask() {
        let conn = corpus_at_head_without_type_mask();
        assert!(!card_columns_in(&conn, CORPUS).contains(&"type_mask".to_owned()));
        migrate_corpus(&conn).unwrap();
        assert!(card_columns_in(&conn, CORPUS).contains(&"type_mask".to_owned()));
    }

    /// Unlike corpus schema 3 and 4, this rung **backfills**, and it must: `produced_mana` and
    /// `printed_size` read NULL until the next fetch because their data is not in the database.
    /// A type line is — and with `NOT NULL DEFAULT 0` an un-backfilled column means "no type",
    /// so the new filter would answer an empty wall until the next sync.
    #[test]
    fn the_rung_backfills_type_mask_from_the_type_line() {
        let conn = corpus_at_head_without_type_mask();
        conn.execute_batch(&format!(
            "INSERT INTO {CORPUS}.cards (id,name,set_code,collector_number,lang,layout,raw,type_line)
             VALUES ('1','Dryad Arbor','fut','174','en','normal','{{}}','Land Creature — Forest Dryad');"
        ))
        .unwrap();
        migrate_corpus(&conn).unwrap();
        let got: i64 = conn
            .query_row(
                &format!("SELECT type_mask FROM {CORPUS}.cards WHERE id='1'"),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(got as u32, crate::cardtypes::type_mask("Land Creature — Forest Dryad"));
        assert_ne!(got, 0, "a backfill that leaves 0 is the failure this test exists for");
    }

    /// The widening is real. A `CREATE INDEX IF NOT EXISTS` over a name that already exists is
    /// a silent no-op, so the rung must `DROP` first.
    #[test]
    fn the_collapse_index_carries_type_mask_after_the_rung() {
        let conn = corpus_at_head_without_type_mask();
        migrate_corpus(&conn).unwrap();
        let sql: String = conn
            .query_row(
                &format!(
                    "SELECT sql FROM {CORPUS}.sqlite_master
                      WHERE type='index' AND name='idx_cards_collapse'"
                ),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(sql.contains("type_mask"), "not widened: {sql}");
    }

    /// A card can never carry a NULL mask — `push_card_filters` asks `type_mask & ? != 0`, and
    /// `NULL & ?` is NULL, which would drop the row out of every type search silently.
    #[test]
    fn a_card_can_never_carry_a_null_type_mask() {
        let conn = corpus_at_head_without_type_mask();
        migrate_corpus(&conn).unwrap();
        let err = conn
            .execute_batch(&format!(
                "INSERT INTO {CORPUS}.cards (id,name,set_code,collector_number,lang,layout,raw,type_mask)
                 VALUES ('9','x','set','1','en','normal','{{}}',NULL);"
            ))
            .unwrap_err()
            .to_string();
        assert!(err.contains("NOT NULL constraint failed: cards.type_mask"), "{err}");
    }
```

You will need a `corpus_at_head_without_type_mask()` helper. Build it the way the existing
corpus-rung tests build their fixtures — find the helper
`a_head_stamped_corpus_still_gets_produced_mana` (or whatever the schema-3 test is named) uses and
copy its shape, dropping the `type_mask` column afterwards with
`ALTER TABLE {CORPUS}.cards DROP COLUMN type_mask;`. Also find the existing `card_columns`
helper — it may already take a schema argument; if not, add `card_columns_in`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --lib schema::tests::a_head_stamped_corpus_still_gets_type_mask`
Expected: FAIL.

- [ ] **Step 3: Implement the rung**

Four edits in `schema.rs`:

**(a)** `CORPUS_SCHEMA_VERSION` (`:500`): `4` → `5`, and extend its doc comment with the new rung.

**(b)** `CORPUS_SCHEMA_SQL`'s `cards` CREATE (`:4344`) — append `type_mask INTEGER NOT NULL
DEFAULT 0` to the column list, beside `produced_mana`.

**(c)** `CARDS_INDEXES` (`:198-200`) — `idx_cards_collapse` gains `type_mask` beside
`legal_mask`:

```rust
    "CREATE INDEX IF NOT EXISTS {schema}.idx_cards_collapse \
     ON cards(oracle_id, is_paper, released_at, id, name, price_usd, \
              legal_mask, type_mask, cmc, color_identity)",
```

Update the literal at `schema.rs:4556` to match — the two must not disagree. Extend the comment
above the index to say what `type_mask` buys: without it a type-filtered browse falls off this
index into row lookups, the 455–505 ms band the comment already names for the other filter
columns.

**(d)** The rung itself, beside `add_printed_size`:

```rust
/// Whether corpus schema 5's `ALTER` is owed on `cards` in `schema` — [`produced_mana_is_owed`]'s
/// shape, and every one of its reasons.
fn type_mask_is_owed(conn: &Connection, schema: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA {schema}.table_info(cards)"))?;
    let names: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(!names.is_empty() && !names.iter().any(|n| n == "type_mask"))
}

/// Corpus schema 5: give `cards` its `type_mask` column, fill it, and widen the collapse index.
///
/// **Three statements where corpus schema 3 and 4 are one, and the second is the one that
/// matters.** Those two leave every existing row NULL because their data is not in the database
/// — `produced_mana` and `printed_size` both come from a later fetch. A type line *is* in the
/// database, and this column is `NOT NULL DEFAULT 0`, so a rung that skipped the backfill would
/// leave every card masked to "no type" and the new filter answering an empty wall until the
/// next sync. That is the fail-closed failure this repo refuses everywhere else.
///
/// **The index is dropped before it is recreated.** `CARDS_INDEXES` spells every index
/// `IF NOT EXISTS`, and over a name that already exists that is a silent no-op — so replaying
/// the widened definition over an existing `idx_cards_collapse` would change nothing and cost
/// nothing and be invisible.
///
/// No FTS rebuild is owed: this adds an unindexed column and rewrites none of
/// `name`/`type_line`/`search_text`, and renumbers no rowids — schema v2's precedent.
fn add_type_mask(conn: &Connection, schema: &str) -> rusqlite::Result<()> {
    conn.execute_batch(&on_schema(
        schema,
        "ALTER TABLE {schema}.cards ADD COLUMN type_mask INTEGER NOT NULL DEFAULT 0;",
    ))?;
    conn.execute_batch(&format!(
        "UPDATE {schema}.cards SET type_mask = {};",
        crate::cardtypes::type_mask_sql("type_line")
    ))?;
    conn.execute_batch(&on_schema(
        schema,
        "DROP INDEX IF EXISTS {schema}.idx_cards_collapse;",
    ))?;
    conn.execute_batch(&cards_indexes_sql(schema))
}
```

And in `migrate_corpus`, after the `printed_size_is_owed` arm:

```rust
        // Corpus schema 5, the same gate over `cards` for the same two populations, and the
        // first of these rungs that backfills — see [`add_type_mask`].
        if type_mask_is_owed(conn, CORPUS)? {
            add_type_mask(conn, CORPUS)?;
        }
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test --lib schema::tests`
Expected: PASS. Existing corpus-ladder tests that assert `CORPUS_SCHEMA_VERSION == 4` or list the
collapse index's columns will need updating — that is expected work, not a regression. Read each
failure before changing it and make sure you are updating an expectation rather than weakening an
assertion.

- [ ] **Step 5: Report**

Do not commit. Report the version bump, the three statements, and every existing test you had to
update with the reason.

---

## Task 3: Write `type_mask` at ingest

**Files:**
- Modify: `src-tauri/src/ingest.rs`

**Interfaces:**
- Consumes: `crate::cardtypes::type_mask` (Task 1); the `type_mask` column (Task 2).
- Produces: a synced corpus whose `type_mask` is correct without the backfill ever running again.

`legal_mask` is the model throughout — it is bound at `ingest.rs:332` and named in the `INSERT`
column list at `:374`, and there is a fixture column table at `:673-674`.

- [ ] **Step 1: Write the failing test**

Find the existing ingest test that asserts a round-tripped card's `legal_mask`, and add its
sibling. If there is no such test, add:

```rust
    #[test]
    fn an_ingested_card_carries_its_type_mask() {
        // Build the fixture the way the neighbouring ingest tests do, with a card whose
        // type line is `Land Creature — Forest Dryad`, then assert:
        let got: i64 = conn
            .query_row("SELECT type_mask FROM cards WHERE id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(
            got as u32,
            crate::cardtypes::type_mask("Land Creature — Forest Dryad")
        );
        assert_ne!(got, 0);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && cargo test --lib ingest::tests::an_ingested_card_carries_its_type_mask`
Expected: FAIL — no such column in the insert.

- [ ] **Step 3: Implement**

Three edits, each beside its `legal_mask` neighbour:

1. The struct/row the ingest builds gains a `type_mask: u32` computed with
   `crate::cardtypes::type_mask(type_line)` from whatever the ingest already has the type line
   in. If the type line is `Option<String>`, an absent one masks to 0 —
   `type_mask(line.as_deref().unwrap_or(""))`.
2. The bind list (`:332` area) gains `c.type_mask as i64,` beside `c.legal_mask as i64,`, **in the
   position matching the column list** — positional binding is the invariant; a bind in the wrong
   slot writes the mask into another column silently.
3. The `INSERT` column list (`:374`) gains `type_mask` in that same position, and the fixture
   column table at `:673-674` gains a row — follow the `("legal_mask", Some("512"))` shape with a
   value that matches the fixture's own type line.

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test --lib ingest`
Expected: PASS.

- [ ] **Step 5: Report**

Do not commit. Report the three edit sites and confirm the bind position matches the column
position.

---

## Task 4: The two SQL predicates

**Files:**
- Modify: `src-tauri/src/filters.rs`

**Interfaces:**
- Consumes: `crate::cardtypes::{mask_of, TYPE_KEYS}` (Task 1); the `type_mask` column (Task 2).
- Produces: `CardFilters::colors_strict: Option<bool>` and `CardFilters::types:
  Option<Vec<String>>`, plus `picked_types`. Task 5 clones both fields across from
  `SearchRequest`; Task 6 reads them for the facet mirror.

- [ ] **Step 1: Write the failing tests**

Use the existing `search_ids(conn, f)` harness (`filters.rs:1055`) and the SQL-shape tests
(`:678-870`) as your models.

```rust
    /// Strict is exact-set equality on `color_identity`, which is the issue's whole ask:
    /// "cards with fewer than X colors should not match. Cards must include all X colors."
    #[test]
    fn strict_colors_answer_the_exact_set_and_nothing_else() {
        // Seed: a mono-R, a mono-W, an RW, a WUBRG and a colourless.
        // Loose "RW" answers mono-R, mono-W, RW and the colourless one.
        // Strict "RW" answers the RW card alone.
    }

    /// `C` is degenerate on purpose and needs no special case: `toggleColor` makes it exclusive
    /// both ways, and the existing arm already means `color_identity = ''`, which *is* the
    /// strict reading of it.
    #[test]
    fn strict_changes_nothing_for_colourless() {
        // Same seed. `colors: "C"` answers the same ids with strict on and off.
    }

    /// Strict with no colour picked adds no SQL, matching the UI, where the chip is not drawn
    /// until a colour is picked.
    #[test]
    fn strict_with_no_colour_picked_is_not_a_filter() {
        // `colors: None, colors_strict: Some(true)` returns every seeded id.
    }

    /// A filter answers "does this card have this type", so a card with two types is in both.
    #[test]
    fn the_type_filter_matches_every_type_a_card_has() {
        // Seed Dryad Arbor (`Land Creature — Forest Dryad`), a plain Creature and a plain Land,
        // each with its `type_mask` written by `crate::cardtypes::type_mask`.
        // `types: ["Creature"]` answers Dryad Arbor and the plain Creature.
        // `types: ["Land"]`     answers Dryad Arbor and the plain Land.
    }

    /// OR within the group, the rarity chips' rule.
    #[test]
    fn two_types_or_with_each_other() {
        // `types: ["Instant", "Sorcery"]` answers both, and nothing else.
    }

    /// A blank or unrecognised list adds no SQL at all — `picked_rarities`/`picked_sets`' rule.
    #[test]
    fn an_empty_or_unknown_type_list_is_not_a_filter() {
        // `types: Some(vec![])` and `types: Some(vec!["Shiny".into()])` both return everything.
    }
```

Note the seeded-row caveat: the test harness's `INSERT INTO cards (...)` at `filters.rs` will
need `type_mask` in its column list, computed with `crate::cardtypes::type_mask` from the row's
own type line — never a hand-written integer, or the test asserts against a fiction.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd src-tauri && cargo test --lib filters`
Expected: FAIL — `colors_strict` and `types` are not fields.

- [ ] **Step 3: Add the two fields to `CardFilters`**

Beside `colors` and `rarities` respectively (`filters.rs:75-149`):

```rust
    /// Read [`Self::colors`] as an **exact** identity rather than a subset: `"RW"` answers the
    /// RW cards alone, not mono-R, mono-W or the colourless cards that fit in any deck.
    ///
    /// **Degenerate for `"C"`, and deliberately not special-cased.** A `colors` of exactly
    /// `"C"` already means `color_identity = ''`, which is the strict reading of it — and the
    /// UI's `toggleColor` makes `C` exclusive both ways, so `"WC"` is unreachable.
    ///
    /// A `true` here with no [`Self::colors`] adds no SQL: the arm is inside the `nonblank`
    /// guard, matching a UI that does not draw the chip until a colour is picked.
    pub colors_strict: Option<bool>,

    /// The card-type chips — [`crate::cardtypes::TYPE_KEYS`] entries. OR within, AND without,
    /// exactly like [`Self::rarities`].
    ///
    /// **"Does this card have this type", not "which bucket is it in".** Dryad Arbor
    /// (`Land Creature — Forest Dryad`) answers both `Land` and `Creature` — which is what a
    /// filter means and what `autoCategory.ts`'s one-bucket rule deliberately does not.
    pub types: Option<Vec<String>>,
```

- [ ] **Step 4: Rewrite the colour arm**

Replace `filters.rs:274-291` with:

```rust
    // Subset semantics by default, as in a deckbuilder: show what this identity can *cast*, so
    // "RW" returns mono-R, mono-W, RW — and colourless, which fits in any deck. Expressed as
    // exclusions so the number of clauses stays fixed and each one is a plain `instr`.
    //
    // **`colors_strict` adds the other half rather than replacing it**: an inclusion per picked
    // letter alongside the exclusion per unpicked one, so "RW" answers the RW cards alone. Five
    // `instr` clauses either way, which is what keeps the arm inside `idx_cards_collapse`'s
    // trailing `color_identity`.
    if let Some(colors) = nonblank(&f.colors) {
        let colors = colors.to_ascii_uppercase();
        let strict = f.colors_strict.unwrap_or(false);
        if colors == "C" {
            // Already exact, with or without `strict` — see `CardFilters::colors_strict`.
            p.wheres.push(format!(
                "({alias}.color_identity = '' OR {alias}.color_identity IS NULL)"
            ));
        } else {
            for ch in COLORS {
                if !colors.contains(ch) {
                    p.wheres.push(format!(
                        "instr(coalesce({alias}.color_identity,''), '{ch}') = 0"
                    ));
                } else if strict {
                    p.wheres.push(format!(
                        "instr(coalesce({alias}.color_identity,''), '{ch}') > 0"
                    ));
                }
            }
        }
    }
```

- [ ] **Step 5: Add the type arm and `picked_types`**

The arm goes beside the `rarities` arm (`filters.rs:398-407`):

```rust
    // One clause and one parameter, inside the covering index — the `format` arm's shape, and
    // the whole reason `type_mask` is a column rather than a `LIKE` on `type_line`.
    //
    // A list that names nothing this build knows masks to 0 and adds no SQL, which is
    // `picked_rarities`' rule: a cleared picker sends `[]`, and some send `[""]`.
    if let Some(types) = f.types.as_deref() {
        let mask = crate::cardtypes::mask_of(&picked_types(types));
        if mask != 0 {
            p.push(
                format!("({alias}.type_mask & ?) != 0"),
                Box::new(i64::from(mask)),
            );
        }
    }
```

And the normaliser beside `picked_rarities`:

```rust
/// The type chips this build recognises, blanks dropped.
///
/// **A shared function for [`picked_rarities`]' reason**: `crate::index::facets` counts over the
/// same list, and a facet counted over a type the search drops would report an option as live
/// that the search cannot reach.
///
/// Matched **exactly**, no case folding: [`crate::cardtypes::TYPE_KEYS`] holds the capitalised
/// words, the UI sends those same words from one constant, and a loose match here would be a
/// second spelling rule the mask does not have.
pub fn picked_types(types: &[String]) -> Vec<String> {
    types
        .iter()
        .filter(|t| crate::cardtypes::TYPE_KEYS.contains(&t.as_str()))
        .cloned()
        .collect()
}
```

- [ ] **Step 6: Run the tests**

Run: `cd src-tauri && cargo test --lib filters`
Expected: PASS. Every existing `CardFilters { .. }` literal in tests gets the two new fields for
free via `..Default::default()`; any that spells every field out needs both added.

- [ ] **Step 7: Report**

Do not commit. Report the arms added and any test literal you had to widen.

---

## Task 5: The two fields on `SearchRequest`

**Files:**
- Modify: `src-tauri/src/search.rs`

**Interfaces:**
- Consumes: `CardFilters::colors_strict` / `::types` (Task 4).
- Produces: `SearchRequest::colors_strict: Option<bool>` and `SearchRequest::types:
  Option<Vec<String>>`, which Task 6 reads off the request for the facet mirror.

- [ ] **Step 1: Write the failing test**

```rust
    /// The search's own request must carry both new filters across to the shape every other
    /// list uses, or the search and the collection answer the same filters differently.
    #[test]
    fn card_filters_carries_strict_colours_and_types() {
        let req = SearchRequest {
            colors: Some("RW".into()),
            colors_strict: Some(true),
            types: Some(vec!["Creature".into()]),
            ..Default::default()
        };
        let f = req.card_filters();
        assert_eq!(f.colors_strict, Some(true));
        assert_eq!(f.types.as_deref(), Some(&["Creature".to_owned()][..]));
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && cargo test --lib search::tests::card_filters_carries_strict_colours_and_types`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `SearchRequest` (`search.rs:39-…`), beside `colors` and `rarities`:

```rust
    /// Read [`Self::colors`] as an exact identity rather than a subset — see
    /// [`crate::filters::CardFilters::colors_strict`], which is where the rule lives.
    pub colors_strict: Option<bool>,
    /// Card-type chips — [`crate::cardtypes::TYPE_KEYS`] entries, ORed with each other. See
    /// [`crate::filters::CardFilters::types`].
    pub types: Option<Vec<String>>,
```

And two lines in `card_filters()` (`search.rs:192-209`), each beside its neighbour:

```rust
            colors_strict: self.colors_strict,
            types: self.types.clone(),
```

Also update the doc comment on `SearchRequest::colors` (`search.rs:43`), which currently reads
"Colour identity filter, e.g. `"WU"`. `"C"` means colourless only." — it must now say which mode
that describes and point at `colors_strict`.

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test --lib search`
Expected: PASS.

- [ ] **Step 5: Report**

Do not commit.

---

## Task 6: The facet mirror

**Files:**
- Modify: `src-tauri/src/index/mod.rs`
- Modify: `src-tauri/src/index/facets.rs`

**Interfaces:**
- Consumes: `crate::cardtypes::TYPE_KEYS` (Task 1), `crate::filters::picked_types` (Task 4),
  `SearchRequest::colors_strict` / `::types` (Task 5), the `type_mask` column (Task 2).
- Produces: `FacetResponse.types: BTreeMap<String, i64>`, which Task 7 mirrors into `ipc.ts` and
  Task 9 reads for the type chips' greying.

The module doc at `facets.rs:14` says this file and `push_card_filters` are one contract. Both
halves of this task are that contract.

- [ ] **Step 1: Write the failing tests**

```rust
    /// The facet mirror and the SQL are one contract. Strict must reach **both** `apply_colors`
    /// call sites — `base`, which filters the result set, and `compute`, which answers "how big
    /// is the result set after pressing this chip". Pass it at `base` alone and the search runs
    /// strict while every chip's count is still computed loose.
    #[test]
    fn strict_colours_reach_the_chip_counts_too() {
        // Seed an index holding a mono-R, a mono-W, an RW and a colourless.
        // With `colors: "R", colors_strict: true`, the count for pressing `W` must be the
        // number of RW cards (1) — not the loose answer, which also counts mono-R, mono-W and
        // the colourless one.
    }

    #[test]
    fn strict_colours_narrow_the_base() {
        // `colors: "RW", colors_strict: true` gives `total` == the RW count alone.
    }

    #[test]
    fn type_counts_are_answered_over_a_base_that_drops_the_type_question() {
        // Picking `Creature` must not grey `Land` — the rule every dimension here follows.
    }

    /// Like `rarity`, the eight bitsets do not partition: a card can be Artifact and Creature,
    /// and the corpus holds types this list does not name. Nothing may derive a total from them.
    #[test]
    fn type_counts_do_not_sum_to_total() {
        // Seed Dryad Arbor plus a Vanguard (masking to 0). The sum of the eight counts is
        // greater than `total` on the first and misses the second.
    }
```

Use `index/fixtures.rs`'s existing seeding helpers. Every seeded card's `type_mask` must be
computed with `crate::cardtypes::type_mask` from its own type line — never a hand-written integer.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd src-tauri && cargo test --lib index`
Expected: FAIL.

- [ ] **Step 3: Add the type dimension to `CardIndex`**

In `index/mod.rs`:

```rust
    /// One bitset per [`crate::cardtypes::TYPE_KEYS`] entry.
    ///
    /// **Not a partition, for [`Self::rarity`]'s reason twice over.** A card can be Artifact
    /// *and* Creature, so the bitsets overlap; and the corpus holds types this list does not
    /// name (`Vanguard`, `Plane`, `Scheme`), so a card can be in none. Their counts neither
    /// sum to the result set nor bound it, and nothing may derive a total from them.
    pub types: [BitSet; crate::cardtypes::TYPE_KEYS.len()],
```

Allocate it beside `rarity` in `build` (`mod.rs:183-201`), then:

- Add `type_mask` to the build's `SELECT` (`mod.rs:204-208`) — a ninth column on the one scan.
- **Read `type_mask`, never `type_line`.** The mask is what the SQL tests, so reading the text
  here would be a second implementation of the type rule that can disagree with the first.
- Fill it in the row loop beside the rarity block (`mod.rs:295-299`):

```rust
            let type_mask: i64 = row.get(8)?;
            for (k, set) in ix.types.iter_mut().enumerate() {
                if type_mask & (1i64 << k) != 0 {
                    set.set(doc);
                }
            }
```

Update the `build` doc comment's column count — it already says "seven" while reading eight
(a stale number; you are making it nine).

- [ ] **Step 4: Thread strict through `apply_colors`**

In `facets.rs`, give `apply_colors` a `strict: bool` and mirror Task 4's SQL:

```rust
/// Subset semantics, expressed the way `push_card_filters` expresses it: a card is in when
/// its identity carries no letter outside the picked set. `"C"` means colourless only.
///
/// **The complement of the unpicked letters, never the union of the picked ones.** The two
/// agree on mono-coloured cards and disagree on every multicolour one — a `W` union would
/// return Lightning Helix for a mono-white search, which the search itself does not.
///
/// **`strict` adds the other half**: the picked letters must all be present too, so `"RW"`
/// answers the RW cards alone. `"C"` is already exact and ignores the flag.
fn apply_colors(ix: &CardIndex, base: &BitSet, picked: Option<&str>, strict: bool) -> BitSet {
    let Some(picked) = picked else {
        return base.clone();
    };
    let picked = picked.to_ascii_uppercase();
    if picked == "C" {
        return base.and(&ix.colors[5]);
    }
    let mut out = base.clone();
    for (i, letter) in CardIndex::COLOR_KEYS.iter().enumerate().take(5) {
        if !picked.contains(*letter) {
            out = and_not(&out, &ix.colors[i]);
        } else if strict {
            out = out.and(&ix.colors[i]);
        }
    }
    out
}
```

**Both call sites take the flag.** In `base` (`facets.rs:192`):

```rust
        b = apply_colors(
            ix,
            &b,
            crate::filters::nonblank(&req.colors),
            req.colors_strict.unwrap_or(false),
        );
```

and in `compute`'s colour-counting loop (`facets.rs:469`), the same fourth argument. `toggle_colors`
is **unchanged** — it produces the picked-colour string, and strict is a sibling boolean no colour
press alters.

- [ ] **Step 5: Add the type dimension to the facet machinery**

Four edits in `facets.rs`, each mirroring `rarities`:

1. `Skip` (`:89-99`) gains a `Types` variant.
2. `Prepared` (`:106-110`) gains `types: Option<BitSet>`, built in `compute`'s `Prepared { .. }`
   (`:405-409`) with `union_types(ix, req.types.as_deref())`.
3. `base` gains, beside the rarities arm:

```rust
    if skip != Skip::Types {
        if let Some(u) = prep.types.as_ref() {
            b = b.and(u);
        }
    }
```

4. `union_types` beside `union_rarities` (`:292-304`):

```rust
/// The type chips as one bitset, or `None` when the request names none.
///
/// OR within, which is what the chip row means and what `push_card_filters` emits — so this is
/// a union, like [`union_rarities`] and unlike [`union_sets`]' two lists.
///
/// **Narrowed by exactly [`crate::filters::picked_types`]' list**, which is why that
/// normalisation is a shared function: a facet counted over a type the search dropped would
/// report an option as live that the search cannot reach.
fn union_types(ix: &CardIndex, types: Option<&[String]>) -> Option<BitSet> {
    let picked = crate::filters::picked_types(types?);
    if picked.is_empty() {
        return None;
    }
    let mut u = BitSet::new(ix.capacity);
    for t in picked {
        if let Some(i) = crate::cardtypes::TYPE_KEYS.iter().position(|k| *k == t) {
            ix.types[i].for_each(|d| u.set(d));
        }
    }
    Some(u)
}
```

5. `FacetResponse` gains the field, and `compute` the counting loop beside the rarity one:

```rust
    /// Keyed by [`crate::cardtypes::TYPE_KEYS`] entry. Plain counts, and all eight are sent on
    /// every ready response, zeros included — the chip row greys a counted zero and leaves an
    /// absent key live.
    ///
    /// **These do not sum to [`Self::total`]** and do not bound it either, for
    /// [`Self::rarities`]' reason twice over: the eight overlap (a card can be Artifact *and*
    /// Creature) and the corpus holds types no chip offers.
    pub types: BTreeMap<String, i64>,
```

```rust
    let types_base = base(Skip::Types);
    for (i, key) in crate::cardtypes::TYPE_KEYS.iter().enumerate() {
        out.types.insert(
            (*key).to_owned(),
            i64::from(types_base.and_count(&ix.types[i])),
        );
    }
```

- [ ] **Step 6: Run the tests**

Run: `cd src-tauri && cargo test --lib index`
Expected: PASS.

- [ ] **Step 7: Report**

Do not commit. Confirm explicitly that **both** `apply_colors` call sites take the flag.

---

## Task 7: The IPC contract and its fence

**Files:**
- Modify: `src/lib/ipc.ts`
- Modify: `src/lib/ipc.test.ts`

**Interfaces:**
- Consumes: the Rust field names from Tasks 4, 5 and 6 — `colorsStrict`, `types` on both requests;
  `types` on `FacetResponse`.
- Produces: the TypeScript shapes Tasks 8 and 9 import.

Read `src/CLAUDE.md`'s opening section first: `ipc.ts` is a hand-written mirror the compiler never
checks, and `ipc.test.ts`'s fence is **opt-in per struct**.

- [ ] **Step 1: Write the failing mirror rows**

None of `SearchRequest`, `CardFilters` or `FacetResponse` is on `ipc.test.ts`'s mirror tables
today, so all three drift silently. Add all three rows to the **non-card** mirror table (the one
below `ipc.test.ts:4400`, which does not demand `imageUris` or a field-count floor):

```ts
  ["SearchRequest", searchRs, "SearchRequest"],
  ["CardFilters", filtersRs, "CardFilters"],
  ["FacetResponse", facetsRs, "FacetResponse"],
```

You will need the three `?raw` imports beside the existing ones at the top of the file —
`src-tauri/src/search.rs`, `src-tauri/src/filters.rs`, `src-tauri/src/index/facets.rs`. Follow the
exact import shape the neighbouring `?raw` imports use.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/ipc.test.ts`
Expected: FAIL — the mirror reports `colorsStrict` and `types` present in Rust and missing in TS.
(If the Rust siblings have not landed yet, it fails the other way; either failure proves the fence
is live, which is the point of this step.)

- [ ] **Step 3: Add the fields**

`SearchRequest` (`ipc.ts:276`) and `CardFilters` (`ipc.ts:960`) each gain:

```ts
  /**
   * Read {@link colors} as an **exact** identity rather than a subset: `"RW"` answers the RW
   * cards alone, not mono-R, mono-W, or the colourless cards that fit in any deck.
   *
   * Degenerate for `"C"`, which already means colourless-only in both modes. A `true` with no
   * {@link colors} filters nothing — the chip is not drawn until a colour is picked.
   */
  colorsStrict?: boolean;
  /**
   * Card-type chips — `Artifact`/`Battle`/`Creature`/`Enchantment`/`Instant`/`Land`/
   * `Planeswalker`/`Sorcery`. ORed with each other, ANDed with every other filter.
   *
   * **"Does this card have this type", not "which bucket is it in".** Dryad Arbor
   * (`Land Creature — Forest Dryad`) answers both `Land` and `Creature`.
   */
  types?: string[];
```

**Both `colors` comments currently end "Subset semantics"** — each must now say which mode that
describes and point at `colorsStrict`.

`FacetResponse` (`ipc.ts:601`) gains:

```ts
  /**
   * Keyed by card type. Plain counts, and all eight are sent on every ready response, zeros
   * included.
   *
   * **These do not sum to {@link total} and do not bound it** — the eight overlap (a card can
   * be Artifact and Creature) and the corpus holds types no chip offers. The same reading
   * {@link rarities} needs.
   */
  types: Record<string, number>;
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/ipc.test.ts`
Expected: PASS.

- [ ] **Step 5: Report**

Do not commit. Report the three mirror rows and note that they are the first fence any of these
three structs has had.

---

## Task 8: The four hooks

**Files:**
- Modify: `src/features/search/useCardSearch.ts`
- Modify: `src/features/collection/useCollection.ts`
- Modify: `src/features/wishlist/useWishlist.ts`
- Modify: `src/features/decks/useCollectionSearch.ts`
- Test: `src/features/search/useCardSearch.test.ts`, `src/features/collection/useCollection.test.ts`

**Interfaces:**
- Consumes: `SearchRequest.colorsStrict` / `.types`, `CardFilters.colorsStrict` / `.types` (Task 7).
- Produces: `CARD_TYPES`, `typesParam` (exported from `useCardSearch.ts`), and on all four
  surfaces: `colorsStrict`, `toggleColorsStrict`, `types`, `toggleType`. Task 9 renders them.

**Each of the four hooks owes the same five things**, and the fourth is the one that silently
breaks the feature:

1. `useState` for both new filters.
2. Exposure on the returned surface object.
3. Clearing in `resetAll`.
4. **A segment in the React Query key.** A key that omits a filter serves a stale page on the
   first press, which reads as "the toggle does nothing".
5. The field on the IPC payload.

- [ ] **Step 1: Write the failing tests**

In `useCardSearch.test.ts`:

```ts
it("gives strict colours their own query-key segment", () => {
  // Render the hook, pick a colour, snapshot the key; toggle strict; the key must differ.
  // Without this segment the strict press is answered out of the loose search's cache.
});

it("gives the type chips their own query-key segment", () => {
  // Same shape over toggleType.
});

it("clears both new filters on resetAll", () => {
  // Pick a colour, turn strict on, pick a type; resetAll; all three are back to empty/false.
});

it("counts the type chips as one active filter however many are pressed", () => {
  // activeFilterCount is 1 after one type, still 1 after three — the `colors`/`rarities` rule.
});
```

In `useCollection.test.ts`, the query-key test for that hook's own key.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/features/search/useCardSearch.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the shared constants to `useCardSearch.ts`**

Beside `colorParam` (`:307`) and `toggleColor` (`:321`):

```ts
/**
 * The card types the chip row offers, **in the order it draws them**.
 *
 * Creature first and Land last, because that is how every decklist reads — `deckBuckets.ts`'s
 * `TYPE_BUCKETS` order, and deliberately not the alphabetical bit order `cardtypes.rs` freezes.
 * A matching order and a display order are two constants here for the reason
 * `autoCategory.ts` gives about its own pair: one constant cannot be both, and folding them
 * together breaks whichever job loses.
 *
 * The words must match `cardtypes.rs`'s `TYPE_KEYS` letter for letter — `picked_types` matches
 * exactly and drops anything it does not recognise, so a typo here is a chip that silently
 * filters nothing.
 */
export const CARD_TYPES: readonly string[] = [
  "Creature",
  "Planeswalker",
  "Instant",
  "Sorcery",
  "Artifact",
  "Enchantment",
  "Battle",
  "Land",
];

/**
 * The picked types as the backend takes them, or nothing.
 *
 * Sorted, for `setsParam`'s reason: picking Creature then Land is the same search as Land then
 * Creature and must not cost a second round trip.
 */
export function typesParam(picked: readonly string[]): string[] | undefined {
  return picked.length > 0 ? [...picked].sort() : undefined;
}
```

Add `f.types.length > 0` to `activeFilterCount` (`:256`), with a comment matching its neighbours:
one kind however many chips are pressed, the `colors`/`rarities` rule. Add `types: readonly
string[]` to the `FilterState` interface (`:219` area). **`colorsStrict` is not counted** — it
modifies the colour filter rather than being one, so counting it would caption Reset all with a
number that moves when nothing new is filtered; say so in a comment.

- [ ] **Step 4: Wire all four hooks**

For each of the four, in that hook's own idiom:

```ts
// 1. state — beside the existing `colors` useState
const [colorsStrict, setColorsStrict] = useState(false);
const [types, setTypes] = useState<readonly string[]>([]);

// 2. params — beside colorsParam
const typesParamValue = typesParam(types);

// 3. query key — beside the `colorsParam ?? ""` segment
colorsStrict ? "strict" : "",
typesParamValue?.join(",") ?? "",

// 4. payload — beside `colors: colorsParam`
colorsStrict: colorsStrict || undefined,
types: typesParamValue,

// 5. surface — beside `colors` / `toggleColor`
colorsStrict,
toggleColorsStrict: () => setColorsStrict((on) => !on),
types,
toggleType: (type: string) => setTypes((picked) => toggleIn(picked, type)),

// 6. resetAll
setColorsStrict(false);
setTypes([]);
```

`colorsStrict: colorsStrict || undefined` rather than the bare boolean: every other optional
filter on these payloads sends `undefined` when unset, and a literal `false` on the wire is a
field that reads as "the reader chose loose" when they chose nothing.

**Clearing the last colour must clear strict**, so the flag can never survive as invisible state
the UI no longer draws a control for. Put it in `toggleColor`'s wrapper in each hook:

```ts
toggleColor: (key: ColorKey) =>
  setColors((picked) => {
    const next = toggleColor(picked, key);
    // The `Exactly` chip is only drawn while a colour is picked, so a strict flag surviving an
    // empty row would be state with no control — invisible, and still in the query key.
    if (next.length === 0) setColorsStrict(false);
    return next;
  }),
```

Note: calling `setColorsStrict` inside the `setColors` updater is a state update during another
updater. If React or lint objects, hoist it — compute `next` outside the updater instead. Do not
leave a `setState` inside an effect; that fails lint only at verify.

Also extend each hook's "is anything filtered" predicate — `useCardSearch.ts:1290`'s `unfiltered`
guard, `useCollection.ts:107`, `useWishlist.ts:101` — with the types term. `colorsStrict` does not
belong in those either, for the `activeFilterCount` reason.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/features/search/useCardSearch.test.ts src/features/collection/useCollection.test.ts`
Expected: PASS.

- [ ] **Step 6: Report**

Do not commit. Report, per hook, that all five obligations were met — especially the query key.

---

## Task 9: The two controls

**Files:**
- Modify: `src/features/search/FilterBar.tsx`
- Modify: `src/features/collection/CollectionPage.tsx` (the `COLLECTION_TRAY` array at `:664` only)
- Modify: `src/features/decks/CollectionSearchTab.tsx` (the `COLLECTION_TRAY` array at `:55` only)
- Modify: `src/features/wishlist/WishlistPage.tsx` (the `WISHLIST_TRAY` array at `:324` only)
- Test: `src/features/search/FilterBar.test.tsx`
- Modify: `src/features/search/FilterBar.stories.tsx`

**Interfaces:**
- Consumes: `CARD_TYPES` from `useCardSearch.ts`, and the four surface fields (Task 8);
  `FacetResponse.types` (Task 7).
- Produces: the shipped controls.

The `mtg-grimoire-sb-mcp` server failed to connect this session, so you cannot query Storybook for
component properties. **Read `src/components/FilterChips.tsx` directly** and use only props you
can see declared there — `ToggleChip` is at `:451`, `RarityChip` at `:800`. Do not guess a prop.

- [ ] **Step 1: Write the failing tests**

In `FilterBar.test.tsx`:

```tsx
it("does not draw the Exactly chip until a colour is picked", () => {
  // Render with colors: []. `queryByRole("button", { name: /exactly/i })` is null.
});

it("draws the Exactly chip once a colour is picked", () => {
  // Render with colors: ["W"]. The chip is there and unpressed.
});

it("turns strict off when the last colour is cleared", () => {
  // This is the hook's job, not the bar's — assert instead that with colors: [] and
  // colorsStrict: true the chip is still not drawn, so the state can never be stranded
  // on screen.
});

it("draws the type cell only where the surface answers it", () => {
  // tray includes "type" but the surface has no `types`/`toggleType` — nothing is drawn.
});

it("draws all eight type chips in reading order", () => {
  // Creature first, Land last.
});

it("names the active colour filter as exact when strict is on", () => {
  // The stated-filter strip chip reads "exactly" for colors: ["W","U"], colorsStrict: true.
});
```

Note the accessible-name trap this repo has hit before: a CSS `gap` between a label and its count
breaks the computed name, and a greyed row's name includes its reason. Assert with the same
matchers the neighbouring rarity tests use rather than inventing a stricter one.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/features/search/FilterBar.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Extend `FilterSurface` and `TrayCell`**

`FilterSurface` (`FilterBar.tsx:182-183`) — **required**, beside `colors`/`toggleColor`, because
every one of the eight mounted surfaces owns colour state and so can answer this:

```ts
  /** Read {@link colors} as an exact identity rather than a subset. Required beside
   *  {@link colors}, because every surface that has colours can answer it. */
  colorsStrict: boolean;
  toggleColorsStrict: () => void;
```

and **optional**, below the line with the other per-surface capabilities:

```ts
  /** The card-type chips. Optional like every cell below this line: a surface that cannot
   *  answer it draws no cell rather than a control that does nothing. */
  types?: readonly string[];
  toggleType?: (type: string) => void;
```

`TrayCell` (`:101-113`) gains `"type"`. Add it to `SEARCH_TRAY` (`:117`) after `"rarity"`, and to
the three caller arrays — `CollectionPage.tsx:664`, `CollectionSearchTab.tsx:55`,
`WishlistPage.tsx:324` — in the same position. **Those three files get one array edit each and
nothing else.**

- [ ] **Step 4: Draw the `Exactly` chip**

Inside the colour group (`FilterBar.tsx:875-895`), after the `MANA_KEYS.map`:

```tsx
        {/* **Only once a colour is picked.** Strict with nothing picked filters nothing, so an
            always-drawn chip would be a dead control — and a sixth chip competing for the deck
            panel's 206px floor, which is the width this group's `flex-wrap` exists for. The
            reflow on the first colour press is what that buys.

            It is not in `activeFilterCount`: it modifies the colour filter rather than being
            one, and a Reset all caption that moved when nothing new was filtered would be
            counting the wrong thing. */}
        {search.colors.length > 0 && (
          <ToggleChip
            label="Exactly"
            pressed={search.colorsStrict}
            title={
              search.colorsStrict
                ? "Cards whose colour identity is exactly these colours"
                : "Cards whose colour identity fits within these colours"
            }
            onClick={search.toggleColorsStrict}
          />
        )}
```

Then the stated-filter chip (`:367-376`) — its label gains the word when strict is on, and its
`remove` clears the flag:

```tsx
      label: `Colour: ${search.colorsStrict ? "exactly " : ""}${MANA_KEYS.filter(...)...}`,
      remove: () => {
        search.colors.forEach((c) => search.toggleColor(c));
        if (search.colorsStrict) search.toggleColorsStrict();
      },
```

- [ ] **Step 5: Draw the type cell**

In the `drawn` record (`FilterBar.tsx:1633`), beside `rarity` (`:1747-1760`) and copying its
markup, including the `optionDisabled` "a selected option is never greyed" arm:

```tsx
    /* Eight chips, OR within — the rarity cell's shape, and its greying rule. A card with two
       types is under both, because this filter asks *does this card have this type* rather than
       which bucket it is in. `CARD_TYPES` is the reading order (Creature first, Land last) and
       not `cardtypes.rs`' alphabetical bit order. */
    type: search.toggleType ? (
      <TrayField key="type" label="Type">
        <div className="grid grid-cols-2 gap-1.5 @min-[640px]/fb:grid-cols-4">
          {CARD_TYPES.map((t) => (
            <ToggleChip
              key={t}
              label={t}
              pressed={search.types?.includes(t) ?? false}
              disabled={optionDisabled(facets?.types, t, search.types?.includes(t) ?? false)}
              title={facetTitle(t, facets?.types?.[t])}
              onClick={() => search.toggleType?.(t)}
            />
          ))}
        </div>
      </TrayField>
    ) : null,
```

Eight chips do not fit one row at the deck panel's floor, hence the grid — check the class against
what the rarity cell actually uses and follow it rather than this sketch if they differ.

Import `CARD_TYPES` from `./useCardSearch` alongside the existing imports there.

- [ ] **Step 6: Update the stories**

Add a story showing the tray with the type cell drawn and one with `Exactly` pressed, following
`FilterBar.stories.tsx`'s existing conventions. Every story's surface object needs the two new
**required** fields (`colorsStrict`, `toggleColorsStrict`) or the file will not type-check.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/features/search/FilterBar.test.tsx`
Expected: PASS.

- [ ] **Step 8: Report**

Do not commit. List every file touched and confirm the three tray arrays were the only change in
their files.

---

## Task 10: The reference docs

**Files:**
- Modify: `docs/reference/data-and-sync.md` (the schema ladder — corpus schema 5)
- Modify: `docs/reference/search-faceting.md` (the new dimension, and both `apply_colors` sites)
- Modify: `docs/reference/frontend-design.md` (the two new controls)
- Modify: `src-tauri/CLAUDE.md` (the corpus-rung list, which names schema 3 and 4 today)

**Interfaces:**
- Consumes: everything Tasks 1–9 build. Write from the spec, which is the authority:
  `docs/superpowers/specs/2026-09-22-strict-colours-and-type-filter-design.md`.

- [ ] **Step 1: Record corpus schema 5**

In `data-and-sync.md`'s schema ladder, add the rung. State the one thing that makes it different
from its two neighbours: **it backfills, and corpus schema 3 and 4 do not** — because their data
is not in the database and a type line is, and because the column is `NOT NULL DEFAULT 0`, so an
un-backfilled column means "no type" and the filter would answer an empty wall until the next sync.

In `src-tauri/CLAUDE.md`, extend the sentence that lists what the corpus rungs repair (it names
`produced_mana` and `printed_size`) with `type_mask`, and note that this one is shape-gated for
the same reason as the other two.

- [ ] **Step 2: Record the facet dimension**

In `search-faceting.md`: the `types` dimension, that its eight counts **neither sum to nor bound
`total`** (they overlap, and the corpus holds types no chip offers), and the `apply_colors` trap —
two call sites, `base` and `compute`, and passing the flag at `base` alone leaves the search
strict while every chip's count is computed loose.

- [ ] **Step 3: Record the controls**

In `frontend-design.md`: the `Exactly` chip appears only once a colour is picked and clears with
the last one, and it is deliberately **not** in `activeFilterCount` — it modifies the colour filter
rather than being one. The type cell is the rarity cell's shape in all four trays.

- [ ] **Step 4: Check every number you wrote**

A prose-only edit routes to neither CI job, so nothing goes red when a document rots. Do not write
down a count a build already answers. Re-read anything you copied from the spec against the code
as it now stands.

- [ ] **Step 5: Report**

Do not commit.

---

## Task 11: Fan-in — verify and fix

**Files:** any, as the failures require.

This task runs **alone**, after every other task has reported. It is the dispatcher's.

- [ ] **Step 1: Sweep for unowned files**

Grep every new symbol against the task buckets — `colorsStrict`, `colors_strict`, `types`,
`type_mask`, `CARD_TYPES`, `TYPE_KEYS` — and find any call site no task owned. `git grep` skips
untracked files, so use plain `grep` or `git status` first: `cardtypes.rs` is new.

Specifically check the surfaces that construct a `FilterSurface` object but were not in Task 9's
file list — `colorsStrict`/`toggleColorsStrict` are **required** members, so every construction
site must supply them or `tsc` fails. Tasks 8 and 9 between them should cover all eight, but the
Storybook fake and any test helper that builds a surface are the ones that get missed.

- [ ] **Step 2: Run the full verify**

Run: `npm run verify`

Do **not** pipe it through `tail` or `head` — the exit code comes from the last command in the
pipe, so a piped run reports 0 while tests fail. Do not run two verifies at once; concurrent runs
fake ~18 Rust schema failures.

- [ ] **Step 3: Fix what is red**

Expected classes of failure, and what each means:

- `tsc` errors at `FilterSurface` construction sites — Step 1 missed one.
- `ipc.test.ts` mirror failures — a field spelled differently on the two sides. The fence working.
- Rust schema tests asserting `CORPUS_SCHEMA_VERSION == 4` or the old collapse-index column list —
  expectations to update, but read each one before changing it.
- Storybook story type errors — every story's surface needs the two required fields.

- [ ] **Step 4: `cargo fmt` and `clippy`**

`npm run verify` runs neither, and CI runs both — they are the only reds a green verify allows.

Run: `cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings`

- [ ] **Step 5: Commit**

One commit per coherent slice, `feat:`/`test:`/`docs:`, each ending with the attribution line.

- [ ] **Step 6: Prove the migration on the real dev database**

A worktree can never show an upgrade bug — its database is built fresh. Back up
`src-tauri/target/debug/data/corpus.db`, then launch and confirm the rung ran: `type_mask` exists,
is non-zero for a card with a type line, and `idx_cards_collapse` carries it.

- [ ] **Step 7: Drive the shipped window**

A green suite and a green Storybook prove nothing about the shipped window. Take the `app` lock
(`.claude/skills/running-the-app/lock.ps1`), run `npm run tauri dev`, and over CDP confirm:

- The `Exactly` chip is absent with no colour picked and appears on the first press.
- A strict two-colour search really does exclude the mono-coloured and colourless cards.
- The type cell draws eight chips in the tray, on the search page **and** in the deck editor's
  docked panel at its 206px floor.
- A type chip greys when its count is zero.

`docs/reference/live-ui-verification.md` is the harness contract.

---

## Self-Review

**Spec coverage.** §2.1 axis → Task 4 Step 4. §2.2 SQL → Task 4 Step 4. §2.3 facet mirror and the
two call sites → Task 6 Step 4. §2.4 the control → Task 9 Step 4. §2.5 wiring, incl. cache keys →
Task 8. §3.1 semantics → Task 1. §3.2 `type_mask` → Tasks 1, 2, 3. §3.3 corpus schema 5 → Task 2.
§3.4 predicate → Task 4 Step 5. §3.5 facets → Task 6 Step 5. §3.6 where it appears → Task 9 Steps
3 and 5. §3.7 wiring → Task 8. §4 IPC and the fence → Task 7. §5 testing → each task's own tests,
plus Task 11 Steps 6–7. §6 out of scope → nothing to do, by definition.

**Type consistency.** `colors_strict`/`colorsStrict`, `types`, `TYPE_KEYS`, `CARD_TYPES`,
`type_mask`, `mask_of`, `picked_types`, `union_types`, `type_mask_sql`, `type_mask_is_owed`,
`add_type_mask` are each spelled one way throughout and declared in the frozen-vocabulary block.
`toggle_colors` is named as explicitly unchanged in both the spec and Task 6.

**One known gap, deliberately left to the executor:** Task 2 Step 1 and Task 3 Step 1 describe
their fixture helpers rather than spelling them out, because both must be built from helpers whose
exact current names only the file can answer. Each says which existing test to copy.
