# Deck Token Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the tokens and emblems a deck needs from Scryfall's `all_parts`, and let the reader pick each one's art and quantity, in a collapsible area below the deck.

**Architecture:** The list is **derived on every deck open** — ~5 ms for a 100-card deck — by inflating the `raw` gzip blob of each distinct card in the deck's active categories and reading `all_parts`. Only the reader's *deviations* are stored, in a new `deck_tokens` table grained on `(deck_id, oracle_id)`. Rust supplies the resolved facts joined to the stored override; TypeScript decides the effective quantity, the effective printing and the ordering.

**Tech Stack:** Rust (rusqlite, flate2, serde_json, Tauri commands) · React 19 + TypeScript 6 · TanStack Query · Tailwind · Vitest · Storybook

**Spec:** [`docs/superpowers/specs/2026-09-07-deck-token-management-design.md`](../specs/2026-09-07-deck-token-management-design.md) — read it before starting any task. It carries the measurements and the reasoning; this plan carries the steps.

## Global Constraints

- **Working directory is the worktree** `D:\Code\mtg-grimoire\.claude\worktrees\automated-token-management`. Subagents are pinned to the project root, not to this worktree — every path you touch must be under the worktree. Do not `cd` elsewhere.
- **Do not commit.** The git index is shared across sibling agents in this tree; a commit sweeps in other agents' in-flight files. Report what you changed; the dispatching session commits.
- **Do not run `npm run verify`, `npm test`, or Storybook.** Your slice compiles against a tree your siblings are still changing, so a suite run mid-fan-out fails for reasons that are not yours. Run only the narrow test command your task names. Never start a verify in the background and end your turn.
- **The filter rule is a union, and it is the point of the feature.** Keep an `all_parts` entry when `component == "token"` **or** when the row it resolves to has `layout = 'emblem'`. Exclude self by **`name`**, never by `id`. Spec §2 has the measured reason for every clause.
- **A *tag* in this app is a Scryfall Oracle or Art tag. A *label* is the deckbuilder's coloured per-card mark.** Neither word may be used for anything here. The new area is **"Tokens & emblems"** — never bare "Tokens", which `autoCategory.ts:130` already uses for cards that *make* tokens.
- **Never install `@types/node`.** **npm `xlsx` is banned.**
- Files must stay **LF**, not CRLF. Some editors flip line endings on write and it breaks source-parsing tests locally while CI stays green.
- **An assertion must not read its own constant.** A test that asserts `X == SOME_CONST` where the implementation also reads `SOME_CONST` passes against the exact defect it was written for.
- Every measured claim added to a doc names the build (debug or release) and the date.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src-tauri/src/schema.rs` | v35 rung, `USER_SCHEMA_SQL` lines, `UNDO_V35`, `TABLES`, `SYNCED_TABLES`, `DECK_TOKEN_GRAIN` | 1 |
| `src-tauri/src/sync_engine/capture.rs` | `Spec` for `deck_tokens`; `decks.tokens_open` field | 1 |
| `src-tauri/src/sync_engine/apply.rs` | `Meta` for `deck_tokens` | 1 |
| `src-tauri/src/mirror/watch.rs` | `surface_of` arm | 1 |
| `src-tauri/src/deck_tokens.rs` **(new)** | Resolver + the four commands | 2 |
| `src-tauri/src/lib.rs` | `pub mod deck_tokens;` | 2 |
| `src-tauri/src/desktop.rs` | `generate_handler!` registration | 2 |
| `src-tauri/src/web/route.rs` | `COMMANDS` entries + match arms | 2 |
| `src/lib/ipc.ts`, `src/lib/ipc.test.ts` | DTO types + the four methods | 3 |
| `src/features/decks/deckTokens.ts` **(new)** + test | The merge: effective quantity, printing, visibility, order | 4 |
| `src/features/decks/useDeckTokens.ts` **(new)** | Query + the four mutations | 5 |
| `src/features/decks/DeckTokensPanel.tsx` **(new)** | The collapsible area and its wall of tiles | 6 |
| `src/features/decks/TokenArtPicker.tsx` **(new)** | The printings dialog | 6 |
| `src/features/decks/DeckEditor.tsx` | Mount the panel after the stats band | 6 |
| `.storybook/fake/db.ts`, `.storybook/fake/seeds.ts` | Fake rows + handlers | 7 |
| `src/features/decks/DeckTokensPanel.stories.tsx` **(new)** | Stories | 8 |
| `docs/reference/decks-storage.md`, `src-tauri/CLAUDE.md`, `src/features/decks/CLAUDE.md` | The record | 9 |

**No two tasks write the same file.** That is what makes the waves below safe.

## Dispatch Waves

| Wave | Tasks | Why together |
| --- | --- | --- |
| A | 1, 3, 4 | No shared files, no dependency — 3 and 4 code to the interfaces pinned below |
| B | 2, 5, 7 | 2 needs Wave A's table; 5 and 7 need Wave A's ipc surface |
| C | 6 | Needs 4 and 5 |
| D | 8, 9 | 8 needs 6 and 7; 9 records what shipped |

---

## Task 1: Schema and sync registration

**Files:**
- Modify: `src-tauri/src/schema.rs`
- Modify: `src-tauri/src/sync_engine/capture.rs`
- Modify: `src-tauri/src/sync_engine/apply.rs`
- Modify: `src-tauri/src/mirror/watch.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: the `deck_tokens` table; `decks.tokens_open`; `pub const DECK_TOKEN_GRAIN: &str = "deck_id, oracle_id";`.

**Read first:** spec §4 in full. It lists all nine registrations a new synced table owes and explains each.

**The version number.** `USER_SCHEMA_VERSION` is 34 today, so this is **35**. Confirm it is still 34 before you start — v12 was numbered three times on three branches in one day, and git cannot see that collision because two `ALTER TABLE`s in two files conflict in neither.

- [ ] **Step 1: Confirm the version is still free**

Run: `grep -n "USER_SCHEMA_VERSION: i64" src-tauri/src/schema.rs`
Expected: `pub const USER_SCHEMA_VERSION: i64 = 34;`. If it says 35 or higher, use the next free number everywhere below and say so in your report.

- [ ] **Step 2: Write the failing rung test**

In `schema.rs`'s test module, beside the other rung tests:

```rust
#[test]
fn v35_adds_deck_tokens_and_the_deck_flag() {
    let conn = super::tests::user_db_at_head();
    // The table exists with the grain the app writes against.
    let grain: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_deck_tokens_grain'",
            [],
            |r| r.get(0),
        )
        .expect("idx_deck_tokens_grain is missing");
    assert!(grain.contains("deck_id"), "grain must include deck_id: {grain}");
    assert!(grain.contains("oracle_id"), "grain must include oracle_id: {grain}");

    // The state vocabulary is closed by a CHECK, not by convention.
    conn.execute_batch(
        "INSERT INTO decks (id, name, format_key, cover_kind, archived, created_at, updated_at)
         VALUES (900, 'T', 'casual', 'card_art', 0, 0, 0);",
    )
    .unwrap();
    let bad = conn.execute(
        "INSERT INTO deck_tokens (deck_id, oracle_id, state, created_at, updated_at)
         VALUES (900, 'o-1', 'nonsense', 0, 0)",
        [],
    );
    assert!(bad.is_err(), "the state CHECK must refuse an unknown word");

    // The deck carries the panel's open flag.
    let open: i64 = conn
        .query_row("SELECT tokens_open FROM decks WHERE id = 900", [], |r| r.get(0))
        .expect("decks.tokens_open is missing");
    assert_eq!(open, 0, "the area is collapsed by default");
}
```

If `user_db_at_head()` is not the helper name in this file, use whatever the neighbouring rung tests call — read two of them first and copy their setup exactly.

- [ ] **Step 3: Run it and watch it fail**

Run: `cd src-tauri && cargo test v35_adds_deck_tokens --lib`
Expected: FAIL — `idx_deck_tokens_grain is missing`.

**A `cargo test` filter that matches nothing exits 0.** Confirm the output says `1 passed` or `1 failed`, not `0 filtered out` — "expected FAIL" proves nothing if the filter selected no tests.

- [ ] **Step 4: Add the grain constant**

Beside `DECK_CARD_GRAIN` / `DECK_CATEGORY_GRAIN` / `DECK_LABEL_GRAIN` in `schema.rs`:

```rust
/// The grain of [`crate::deck_tokens`]' overrides: one row per token per deck.
///
/// **`oracle_id` and not `card_id`**, because the row survives the reader changing which
/// printing they want — the art choice *is* one of the things it stores. Every token, emblem
/// and double-faced-token row in the corpus carries an `oracle_id` (0 missing of 3 245,
/// measured 2026-09-07 on the debug corpus), so the column is safe as a grain in a way
/// `card_id` would not be.
///
/// **Deliberately not grained on `variant`.** The derived list is per-variant because deck
/// cards are; the override is not. Choosing the Treasure art for a deck and finding it
/// reverted in the theory build would be a surprise with nothing to recommend it.
pub const DECK_TOKEN_GRAIN: &str = "deck_id, oracle_id";
```

- [ ] **Step 5: Write the v35 rung**

At the **bottom** of `migrate_user`, immediately below the `if v < 34 { … }` block and above the unconditional `sync_clock` repair. Position in the file *is* order of execution.

```rust
    if v < 35 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE deck_tokens (
                 id INTEGER PRIMARY KEY,
                 deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
                 oracle_id TEXT NOT NULL,
                 card_id TEXT,
                 quantity INTEGER,
                 state TEXT NOT NULL DEFAULT 'auto'
                     CHECK (state IN ('auto','hidden','manual')),
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
              , sync_uid TEXT);
             CREATE UNIQUE INDEX idx_deck_tokens_grain ON deck_tokens (deck_id, oracle_id);
             CREATE UNIQUE INDEX idx_deck_tokens_uid ON deck_tokens (sync_uid);
             ALTER TABLE decks ADD COLUMN tokens_open INTEGER NOT NULL DEFAULT 0;",
        )?;
        // Literal `35`, for the reason every step before it writes its own: this step is what
        // *makes* a database version 35. `USER_SCHEMA_VERSION` would commit "fully migrated"
        // before any step added after it had run.
        tx.execute_batch("PRAGMA main.user_version = 35;")?;
        tx.commit()?;
    }
```

Note the `, sync_uid TEXT);` on its own line before the close. That mirrors how `USER_SCHEMA_SQL` transcribes an `ALTER TABLE` history out of `sqlite_master`, and the byte-identity test below is why it matters.

- [ ] **Step 6: Bump the version constant and its prose**

`schema.rs:313` → `pub const USER_SCHEMA_VERSION: i64 = 35;`, and extend the doc paragraph above it that narrates rungs 27→34 with a sentence for 35: the `deck_tokens` overrides table and the deck's `tokens_open` flag.

- [ ] **Step 7: Mirror it into `USER_SCHEMA_SQL`**

`USER_SCHEMA_SQL` (`schema.rs:3320`) is the literal a **fresh or converted** file is built from, and it climbs nothing. Add the `CREATE TABLE deck_tokens` (schema-qualified as `{schema}.deck_tokens`, matching its neighbours), both indexes beside the other index statements, and `tokens_open INTEGER NOT NULL DEFAULT 0` onto the end of `decks`' one-line `ALTER` tail.

`the_user_schema_is_byte_identical_to_what_the_ladder_builds` compares the ladder's output against this literal **string for string**. Expect to iterate here — run that test and let its diff tell you the exact bytes.

**Do not "fix" the two comments inside the existing DDL that say "tag".** v33 renamed the table and `RENAME` rewrites identifiers, never comments. Correcting either word is a red build.

- [ ] **Step 8: Add the rewind constant**

`ALTER TABLE ADD COLUMN` and `CREATE TABLE` (without `IF NOT EXISTS`) are not idempotent, so the rewind fixtures need an `UNDO_V35` beside the other `UNDO_V*` constants:

```rust
const UNDO_V35: &str = "DROP INDEX IF EXISTS idx_deck_tokens_uid;
     DROP INDEX IF EXISTS idx_deck_tokens_grain;
     DROP TABLE IF EXISTS deck_tokens;
     ALTER TABLE decks DROP COLUMN tokens_open;";
```

Wire it into whatever walks that list, exactly as `UNDO_V34` is wired.

- [ ] **Step 9: Register the table on both non-sync lists**

`schema::TABLES` (`schema.rs:344`), in the alphabetical run of the reader's tables:

```rust
    ("deck_tokens", Side::User),
```

`mirror::watch::surface_of` (`mirror/watch.rs:94`) — extend the existing arm so `deck_tokens` joins its neighbours:

```rust
        "deck_cards" | "deck_categories" | "deck_labels" | "deck_folders" | "deck_tokens" => {
            Some(DECKS_ONLY)
        }
```

`every_table_is_on_exactly_one_side` and `every_table_in_the_schema_has_been_decided_about` both fail until these land.

- [ ] **Step 10: Join the synced set**

`schema::SYNCED_TABLES` (`schema.rs:459`) — insert `"deck_tokens"` in sorted position (after `"deck_labels"`, before `"decks"`) and **change the array length from `[&str; 12]` to `[&str; 13]`**.

`capture::TABLES` (`capture.rs:108`) becomes `[Spec; 13]`; add:

```rust
    Spec {
        table: "deck_tokens",
        keys: &["id"],
        // **`quantity` is a field and not a counter, on two grounds.** Mechanically a counter
        // carries `NEW - OLD` and this column is nullable, so there is no arithmetic to carry;
        // `deck_cards.quantity` can be a counter precisely because it is NOT NULL.
        // Semantically last-write-wins is what is wanted: `deck_cards.quantity` sums because
        // two devices each sleeving a copy means two copies, but "how many Treasures I want to
        // bring" is a setting, and two devices each setting it to 4 must mean 4, not 8.
        fields: &["oracle_id", "card_id", "quantity", "state"],
        counters: &[],
        parents: &[Parent {
            key: "deck",
            col: "deck_id",
            table: "decks",
            absent: Absent::Null,
            soft: false,
        }],
        append_only: false,
    },
```

In the **`decks`** spec in the same file, add `"tokens_open"` to `fields`, beside `"last_group_by"`, `"last_sort_by"` and `"separate_x_group"` — those three already travel and this is the same kind of per-deck view state.

`apply::META` (`apply.rs:170`) becomes `[Meta; 13]`; add a `Meta` for `deck_tokens` with an `order` **after `decks`** (`decks` is 1 — give `deck_tokens` a rank that keeps every existing table's relative order; renumber the tail if you must, since `baseline::build` reads its rank from `apply::order_of` and hard-fails on a missing one), a single `Grain` restating `DECK_TOKEN_GRAIN` as a predicate binding `deck_id` from `Source::Parent` and `oracle_id` from `Source::Field`, `counters: &[]`, and `timestamps: true`. Copy the `deck_labels` `Meta` as the shape to follow — it is the simplest one with a grain.

- [ ] **Step 11: Run the schema and sync suites**

Run: `cd src-tauri && cargo test --lib schema::`
Then: `cd src-tauri && cargo test --lib sync_engine::`
Expected: PASS, including `the_user_schema_is_byte_identical_to_what_the_ladder_builds`, `every_table_is_on_exactly_one_side`, `every_table_in_the_schema_has_been_decided_about` and `every_synced_table_is_on_the_census`.

- [ ] **Step 12: Mutate your own test to prove it bites**

Temporarily change the rung's `CHECK (state IN ('auto','hidden','manual'))` to `CHECK (state IN ('auto','hidden','manual','nonsense'))` and re-run `v35_adds_deck_tokens_and_the_deck_flag`. It **must** fail. Then revert the mutation and confirm it passes again. Report both outcomes.

- [ ] **Step 13: Report**

Do not commit. Report: the version number you took, every file you touched, the test output from Steps 11 and 12, and any place `USER_SCHEMA_SQL` byte-identity forced a wording you would not otherwise have chosen.

---

## Task 2: The resolver and its four commands

**Files:**
- Create: `src-tauri/src/deck_tokens.rs`
- Modify: `src-tauri/src/lib.rs` (one line)
- Modify: `src-tauri/src/desktop.rs` (`generate_handler!`)
- Modify: `src-tauri/src/web/route.rs` (`COMMANDS` + match arms)

**Interfaces:**
- Consumes: Task 1's `deck_tokens` table and `schema::DECK_TOKEN_GRAIN`.
- Produces: the four commands and the `DeckTokenRow` wire shape below. Task 3 mirrors this exactly.

**Read first:** spec §2, §3 and §5. Then read `src-tauri/src/card.rs:567-728` — `meld_parts` is the precedent for reading `all_parts` out of `raw`, and this module is its sibling.

**The wire shape**, which Task 3 mirrors field for field:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSource {
    pub card_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckTokenRow {
    pub oracle_id: String,
    pub name: String,
    pub type_line: Option<String>,
    pub layout: String,
    // The four disambiguation fields. **A token's name does not identify it.** Measured on the
    // debug corpus 2026-09-07: 104 token/emblem names are shared by more than one `oracle_id` —
    // "Elemental" by 31, "Spirit" by 22, "Soldier" by 13 — and `Wurmcoil Engine` alone makes two
    // tokens both called `Wurm 3/3`, separated only by Deathtouch vs Lifelink. Power, toughness,
    // colors and oracle text together told 8 of 8 apart in both sampled names, and two tiles
    // announcing one accessible name is a bug that has already shipped once on the collection wall.
    pub power: Option<String>,
    pub toughness: Option<String>,
    pub colors: Option<String>,
    pub oracle_text: Option<String>,
    /// The printing the resolver names, deterministically. Never null for a derived row.
    pub default_card_id: String,
    /// The deck cards that make it. Empty for a `manual` row nothing derives.
    pub sources: Vec<TokenSource>,
    pub derived: bool,
    /// The stored override, joined on. All three are `None` when there is no row.
    pub card_id: Option<String>,
    pub quantity: Option<i64>,
    pub state: Option<String>,
}
```

- [ ] **Step 1: Write the failing resolver tests**

Create `src-tauri/src/deck_tokens.rs` containing only a `#[cfg(test)] mod tests` to start. Build fixtures by hand — insert `cards` rows with a gzipped `raw` you construct, and **delete them afterwards**. Never seed against synced data: a hand-written row in `cards` or `sync_meta` makes every later measurement a fiction.

Write these, each named for what it protects:

```rust
#[test]
fn a_plain_token_resolves() { /* component: "token" -> one row */ }

#[test]
fn an_emblem_arriving_as_a_combo_piece_resolves() {
    // Elspeth, Sun's Champion names her emblem as `component: "combo_piece"` with
    // `type_line: "Emblem — Elspeth"`. This is the case a `component == "token"` filter
    // misses, and it is the whole reason the rule is a union. Verified against the stored
    // blob on 2026-09-07.
}

#[test]
fn a_self_reference_under_a_different_printing_id_is_excluded() {
    // `Krenko, Mob Boss` names a *different printing of Krenko* as a `combo_piece`. An
    // id-based self-test does not exclude it; the name test does. Same rule and same measured
    // reason as `card::meld_parts` at card.rs:635.
}

#[test]
fn an_all_parts_id_absent_from_cards_is_dropped() { /* not rendered as a hole */ }

#[test]
fn a_card_in_an_inactive_category_contributes_nothing() {
    // `is_active = 0` means "counts toward nothing" — the whole of what the old `maybe` zone
    // meant. The Maybeboard makes no tokens; the Sideboard and Companion do.
}

#[test]
fn two_deck_cards_naming_one_token_collapse_and_keep_both_sources() {}

#[test]
fn one_card_making_two_same_named_tokens_yields_two_rows() {
    // `Wurmcoil Engine` makes two tokens BOTH called `Wurm 3/3`, under different `oracle_id`s,
    // separated only by Deathtouch vs Lifelink. Grouping is by `oracle_id` and never by name,
    // so this must be two rows. Measured on the debug corpus 2026-09-07; 104 token/emblem
    // names in total are shared by more than one `oracle_id`.
}

#[test]
fn the_default_printing_is_stable_across_calls() {
    // Call twice on the same deck, assert the same `default_card_id`. Unstable art on two
    // opens of one deck is the bug this prevents.
}

#[test]
fn every_failure_shape_is_an_empty_vec_not_an_err() {
    // bad gzip, unparseable JSON, missing `all_parts`, `all_parts` that is not an array.
    // A deck must not fail to open over an area most decks use lightly.
}

#[test]
fn the_grain_refuses_a_duplicate_deck_and_oracle() {}

#[test]
fn an_override_that_carries_nothing_is_deleted_rather_than_stored() {
    // state 'auto' + card_id NULL + quantity NULL is not representable.
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd src-tauri && cargo test --lib deck_tokens::`
Expected: FAIL to compile — the module has no implementation yet.

Confirm the output names your tests. A filter matching nothing exits 0.

- [ ] **Step 3: Declare the module**

`src-tauri/src/lib.rs`, in the alphabetical run:

```rust
pub mod deck_tokens;
```

**Do this before writing the implementation, and do not skip it.** An undeclared module makes every `cargo` run vacuous — 100 tests once looked green for four waves because `lib.rs` never named them.

- [ ] **Step 4: Write the resolver**

In `deck_tokens.rs`. The shape, with the reasoning that must survive in the doc comments:

```rust
/// The `all_parts` `component` values that name a token outright.
///
/// **This is half the rule, and on its own it is wrong.** A full-corpus scan on 2026-09-07
/// found exactly four component values — `combo_piece` 148 216, `token` 16 377,
/// `meld_part` 164, `meld_result` 81 — and emblems are *not* in the `token` half:
/// `Elspeth, Sun's Champion` names her emblem as a `combo_piece`. The other half of the rule
/// is [`EXTRA_LAYOUTS`], tested against the row the entry resolves to.
const TOKEN_COMPONENTS: [&str; 1] = ["token"];

/// Layouts that make a resolved `all_parts` target one of the reader's extras whatever its
/// component said. Only `emblem` — a token already arrives as `component: "token"`.
///
/// **Not an allow-list for the component half.** The layouts a `component: "token"` entry
/// resolves to are `token` 16 216, `double_faced_token` 79, **`flip` 75** and
/// `reversible_card` 3, so gating the component half on layout would silently drop 78 real
/// token relationships.
const EXTRA_LAYOUTS: [&str; 1] = ["emblem"];
```

Then `pub fn deck_token_rows(conn, deck_id, variant) -> Result<Vec<DeckTokenRow>, String>`:

1. Select the deck's distinct `(card_id, name)` from `deck_cards dc JOIN deck_categories cat ON cat.id = dc.category_id WHERE dc.deck_id = ?1 AND dc.variant = ?2 AND cat.is_active = 1`.
2. For each, `SELECT name, CAST(raw AS BLOB) FROM cards WHERE id = ?` and inflate with `crate::card_row::raw_json`. **`CAST(raw AS BLOB)` is required** — rusqlite will not hand a TEXT-declared value out as `Vec<u8>`, and `json_extract` over a gzip member is a hard `malformed JSON` error rather than a NULL, so this must never be done in SQL.
3. Parse, walk `all_parts`, and for each entry with an `id`, a `name` and a `component`: skip when `part_name == producing card's own name`; resolve the id against `cards`; keep when `TOKEN_COMPONENTS.contains(component)` **or** `EXTRA_LAYOUTS.contains(target.layout)`.
   The resolution query must select every display column the wire shape needs, not just the
   layout it filters on:
   `SELECT id, oracle_id, name, type_line, layout, power, toughness, colors, oracle_text FROM cards WHERE id = ?`.
4. Group by the target's **`oracle_id`, never by name.** `Wurmcoil Engine` makes two tokens both
   called `Wurm 3/3` under different oracle ids, and 104 token/emblem names in total are shared by
   more than one oracle id. Accumulate `sources` and a per-printing reference count.
5. `default_card_id` = the referenced printing with the highest reference count, ties broken by `released_at DESC, set_code ASC, collector_number ASC, id ASC` — the same tail `card::list_printings` orders by. **Deterministic, or the same deck draws different art on two opens.**

   **The tie-break is the common path, not a corner case.** Different maker cards name different
   printings of the same token: across 40 Treasure makers, 12 distinct Treasure printings were
   referenced (debug corpus, 2026-09-07). A deck with two Treasure makers pointing at two
   printings gives both a reference count of 1, so the tie-break is what actually chooses. Test it
   directly — build a deck with exactly two makers naming two different printings of one token and
   assert which id comes back, twice.
6. `LEFT JOIN deck_tokens` on `(deck_id, oracle_id)` for `card_id`, `quantity`, `state`.
7. Append `state = 'manual'` rows the deck derives nothing for, with `derived: false`, resolving their display fields from `cards` by `oracle_id`.

Every failure returns an empty vec, never an `Err` — an unknown id, a `raw` that will not inflate or parse, a missing `all_parts`, an `all_parts` that is not an array. Gate nothing on `layout` before touching the blob: unlike `meld_parts` (72 `meld` rows in 117 621) there is no column that predicts a token reference, and the cost is already paid — ~5 ms for a 100-card deck, because only the deck's own cards are ever inflated.

- [ ] **Step 5: Write the four commands**

```rust
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_tokens(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    variant: String,
) -> Result<Vec<DeckTokenRow>, String> { /* spawn_blocking + lock_db_read */ }
```

and three writes through plain `sync::with_write` — **not** `with_write_owned`, which is only for the four commands that move copies across the collection/deck boundary; nothing here changes what the reader owns:

```rust
deck_token_set(state, deck_id: i64, oracle_id: String, card_id: Option<String>,
               quantity: Option<i64>, state_word: Option<String>) -> Result<(), String>
deck_token_clear(state, deck_id: i64, oracle_id: String) -> Result<(), String>
deck_token_add(state, deck_id: i64, card_id: String) -> Result<(), String>
```

`deck_token_set` upserts with `ON CONFLICT({DECK_TOKEN_GRAIN})` — interpolate the constant, never retype it; a conflict target that does not match the index verbatim is a runtime error at the first write, not a compile error. It **deletes** the row instead of writing when the result would carry nothing (`state = 'auto'`, `card_id IS NULL`, `quantity IS NULL`).

`deck_token_add` resolves `oracle_id` from the given printing and writes `state = 'manual'`, `card_id = <the printing>`.

Note the parameter named `state_word`: `state` is already the Tauri state argument. Keep the **wire** name `state` by adding `#[allow(non_snake_case)]`-free serde handling — the simplest correct move is to name the Rust parameter `token_state` and have the frontend send `tokenState`. Pick one, and make Task 3's `ipc.ts` match it exactly; say which in your report.

- [ ] **Step 5b: Carry `tokens_open` onto `DeckRow` and the update command**

Task 1 added the column; the panel needs to read and write it. Follow `separate_x_group` exactly — it is the same idea (per-deck view state that travels) and it is already wired end to end:

- `deck.rs:563` — `pub separate_x_group: bool` on `DeckRow`. Add `pub tokens_open: bool` **after** it.
- `deck.rs:433` — `pub separate_x_group: Option<bool>` on the update struct. Add `pub tokens_open: Option<bool>` and the matching arm in the update writer.
- `deck.rs:877` — the `DECK_SELECT` column list. **Add `d.tokens_open` at the very END of the list, and `r.get(N)` at the end of the read.**

**That last point is not a style preference.** `read_deck_row` is positional, and a column added anywhere but the end shifts every later index into a field of the same SQLite type, silently — this is exactly how `finish` (TEXT) once landed in `needs_review` (TEXT). Adding at the end is the only safe position.

`deck.rs` is yours for this step — no sibling agent owns it. The TypeScript half (`DeckRow.tokensOpen` in `ipc.ts` and the `update` mutation in `useDeck.ts`) belongs to Task 6; do not touch those.

- [ ] **Step 6: Register on both surfaces**

`desktop.rs`'s `generate_handler!` — add the four. `generate_handler!` names a command after the **last path segment**, so `deck_tokens::deck_tokens` is the command `deck_tokens`.

`web/route.rs` — add all four to `COMMANDS` (`route.rs:35`) **and** a match arm each, following `card_meld_parts` at `route.rs:1476`. The list and the table must not drift: a test asserts every name in `COMMANDS` has a match arm.

- [ ] **Step 7: Run the tests**

Run: `cd src-tauri && cargo test --lib deck_tokens::`
Expected: PASS, all ten.
Then: `cd src-tauri && cargo test --lib web::route`
Expected: PASS — the `COMMANDS`-vs-arms completeness test included.

- [ ] **Step 8: Mutate to prove the tests bite**

Two mutations, one at a time, each reverted after:

1. Change the keep rule to `TOKEN_COMPONENTS.contains(component)` only (drop the `EXTRA_LAYOUTS` half). `an_emblem_arriving_as_a_combo_piece_resolves` **must** fail.
2. Change the self-exclusion from `name` to `id`. `a_self_reference_under_a_different_printing_id_is_excluded` **must** fail.

If either mutation leaves the suite green, the test is not testing what it claims — fix the test, not the mutation. Report both outcomes.

- [ ] **Step 9: Run `cargo fmt` and `clippy`**

Run: `cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings`
`npm run verify` runs neither, and they are the only reds you can get from a fully green local run.

Watch for a `\` continuation inside any attribute — `cargo fmt` turns it into literal spaces inside a user-facing message.

- [ ] **Step 10: Report**

Do not commit. Report the files touched, which parameter name you chose in Step 5, the Step 7 and Step 8 output, and the exact `DeckTokenRow` field names as serde emits them.

---

## Task 3: The ipc surface

**Files:**
- Modify: `src/lib/ipc.ts`
- Modify: `src/lib/ipc.test.ts`

**Interfaces:**
- Consumes: Task 2's wire shape (reproduced below — code to this, do not wait for Task 2).
- Produces: `DeckTokenRow`, `TokenSource`, `DeckTokenState`, and `ipc.deckTokens` / `deckTokenSet` / `deckTokenClear` / `deckTokenAdd`.

- [ ] **Step 1: Write the failing argument-name test**

`ipc.test.ts` is the **only fence the Rust↔`ipc.ts` boundary has** — there is no compiler between them. Add to the mirrors table it already keeps:

```ts
it("names the deck token command arguments the way Rust spells them", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  // follow the file's existing capture helper rather than inventing one
  await ipc.deckTokens(7, "live");
  await ipc.deckTokenSet(7, "o-1", { cardId: "c-9", quantity: 4, state: "auto" });
  await ipc.deckTokenClear(7, "o-1");
  await ipc.deckTokenAdd(7, "c-9");
  expect(calls).toEqual([
    { command: "deck_tokens", args: { deckId: 7, variant: "live" } },
    { command: "deck_token_set", args: { deckId: 7, oracleId: "o-1", cardId: "c-9", quantity: 4, tokenState: "auto" } },
    { command: "deck_token_clear", args: { deckId: 7, oracleId: "o-1" } },
    { command: "deck_token_add", args: { deckId: 7, cardId: "c-9" } },
  ]);
});
```

Use whatever key Task 2 reports for the state word. If Task 2 has not reported yet, use `tokenState` and flag it in your report as needing reconciliation.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/ipc.test.ts -t "deck token command arguments"`
Expected: FAIL — `ipc.deckTokens is not a function`.

- [ ] **Step 3: Add the types**

Beside `DeckCard` and `DeckDetail` in `ipc.ts`:

```ts
/** Whether a stored token row is a plain override, a dismissal, or a hand-added extra. */
export type DeckTokenState = "auto" | "hidden" | "manual";

/** A deck card that makes a token — the answer to "why is this here". */
export interface TokenSource {
  cardId: string;
  name: string;
}

/**
 * One token or emblem a deck needs, with the reader's stored override joined on.
 *
 * `cardId`, `quantity` and `state` are all `null` when the reader has not deviated — the
 * table stores only deviations. The effective values are TypeScript's conclusion, in
 * `deckTokens.ts`; this is the fact.
 */
export interface DeckTokenRow {
  oracleId: string;
  name: string;
  typeLine: string | null;
  layout: string;
  defaultCardId: string;
  sources: TokenSource[];
  derived: boolean;
  cardId: string | null;
  quantity: number | null;
  state: DeckTokenState | null;
}
```

- [ ] **Step 4: Add the four methods**

On the `ipc` object, beside `deckGet`:

```ts
  deckTokens: (deckId: number, variant: DeckVariant) =>
    invoke<DeckTokenRow[]>("deck_tokens", { deckId, variant }),
  deckTokenSet: (
    deckId: number,
    oracleId: string,
    over: { cardId?: string | null; quantity?: number | null; state?: DeckTokenState | null },
  ) =>
    invoke<void>("deck_token_set", {
      deckId,
      oracleId,
      cardId: over.cardId ?? null,
      quantity: over.quantity ?? null,
      tokenState: over.state ?? null,
    }),
  deckTokenClear: (deckId: number, oracleId: string) =>
    invoke<void>("deck_token_clear", { deckId, oracleId }),
  deckTokenAdd: (deckId: number, cardId: string) =>
    invoke<void>("deck_token_add", { deckId, cardId }),
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run src/lib/ipc.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutate to prove it bites**

Change `oracleId` to `oracle_id` in `deckTokenClear`'s args and re-run. The test **must** fail. Revert.

- [ ] **Step 7: Report** — files touched, the exact argument keys you shipped, test output. Do not commit.

---

## Task 4: The merge — TypeScript's conclusions

**Files:**
- Create: `src/features/decks/deckTokens.ts`
- Create: `src/features/decks/deckTokens.test.ts`

**Interfaces:**
- Consumes: `DeckTokenRow`, `DeckTokenState` from Task 3 (`@/lib/ipc`). If Task 3 has not landed, declare the interface locally and delete it on fan-in — do not block.
- Produces:

```ts
export const DEFAULT_TOKEN_QUANTITY = 1;
export interface DeckTokenView {
  oracleId: string;
  name: string;
  typeLine: string | null;
  layout: string;
  /** What to draw: the reader's pick, else the resolver's. */
  printingId: string;
  /** What to show in the stepper. */
  quantity: number;
  sources: TokenSource[];
  derived: boolean;
  state: DeckTokenState;
  /** True when the reader has deviated — drives the "reset" affordance. */
  overridden: boolean;
  /** The disambiguator. Null for an emblem. */
  subtitle: string | null;
}
export function deckTokenViews(
  rows: readonly DeckTokenRow[],
  opts?: { showDismissed?: boolean },
): DeckTokenView[];
export function isEmblem(row: { layout: string }): boolean;
/**
 * A one-line disambiguator, because **a token's name does not identify it**. 104 token/emblem
 * names are shared by more than one `oracle_id` (debug corpus, 2026-09-07) — "Elemental" by 31,
 * "Spirit" by 22, "Soldier" by 13 — and `Wurmcoil Engine` makes two tokens both called
 * `Wurm 3/3`, separated only by Deathtouch vs Lifelink.
 *
 * **Colors, power/toughness and oracle text must all participate**, because each alone is
 * insufficient: the corpus holds a colorless 1/1 Soldier with no text and a white 1/1 Soldier
 * with no text, which p/t and text together cannot separate.
 *
 * `power`/`toughness` are strings and must not be parsed to numbers — Scryfall writes `*`,
 * `1+*` and `∞`, and there is a real `*/*` Elemental.
 */
export function tokenSubtitle(
  row: Pick<DeckTokenRow, "power" | "toughness" | "colors" | "oracleText" | "layout" | "typeLine">,
): string | null;
```

**This is where the logic that can break lives, so this is where the tests are.** The rules, from spec §5:

- Effective quantity is `stored ?? DEFAULT_TOKEN_QUANTITY`. **No heuristic.** Parsing *"create two 1/1 white Soldier tokens"* out of oracle text is defeated by `create X`, *for each*, copy-tokens and repeatable makers like Krenko — a guess you have to correct is worse than a floor you raise.
- Effective printing is `row.cardId ?? row.defaultCardId`.
- `state` is `row.state ?? "auto"`.
- `hidden` rows are omitted unless `opts.showDismissed`.
- Order: **emblems last**, otherwise by `name` with `localeCompare`. An emblem is a one-off; a Treasure pile is what you reach for.
- `isEmblem` tests `layout === "emblem"` — the layout, not the type line, because the layout is the column and the type line is prose.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_TOKEN_QUANTITY, deckTokenViews, isEmblem } from "./deckTokens";

const row = (over: Partial<DeckTokenRow> = {}): DeckTokenRow => ({
  oracleId: "o-treasure", name: "Treasure", typeLine: "Token Artifact — Treasure",
  layout: "token", defaultCardId: "c-default", sources: [{ cardId: "d-1", name: "Smothering Tithe" }],
  derived: true, cardId: null, quantity: null, state: null, ...over,
});

it("defaults an untouched token to one copy", () => {
  expect(deckTokenViews([row()])[0].quantity).toBe(1);
});

it("prefers the reader's printing over the resolver's", () => {
  expect(deckTokenViews([row({ cardId: "c-picked" })])[0].printingId).toBe("c-picked");
});

it("falls back to the resolver's printing when nothing was picked", () => {
  expect(deckTokenViews([row()])[0].printingId).toBe("c-default");
});

it("keeps a stored quantity of zero rather than treating it as absent", () => {
  // The bug this prevents: `stored || 1` reads 0 as absent and silently shows 1.
  expect(deckTokenViews([row({ quantity: 0, state: "auto" })])[0].quantity).toBe(0);
});

it("hides a dismissed token, and shows it when asked", () => {
  const rows = [row({ state: "hidden" })];
  expect(deckTokenViews(rows)).toHaveLength(0);
  expect(deckTokenViews(rows, { showDismissed: true })).toHaveLength(1);
});

it("keeps a manual row that nothing in the deck derives", () => {
  const v = deckTokenViews([row({ state: "manual", derived: false, sources: [] })]);
  expect(v).toHaveLength(1);
  expect(v[0].derived).toBe(false);
});

it("orders emblems last and the rest by name", () => {
  const v = deckTokenViews([
    row({ oracleId: "o-e", name: "Elspeth Emblem", layout: "emblem" }),
    row({ oracleId: "o-s", name: "Soldier" }),
    row({ oracleId: "o-g", name: "Goblin" }),
  ]);
  expect(v.map((t) => t.name)).toEqual(["Goblin", "Soldier", "Elspeth Emblem"]);
});

it("marks a row overridden only when the reader deviated", () => {
  expect(deckTokenViews([row()])[0].overridden).toBe(false);
  expect(deckTokenViews([row({ quantity: 4, state: "auto" })])[0].overridden).toBe(true);
});

it("reads the layout, not the type line, for an emblem", () => {
  expect(isEmblem({ layout: "emblem" })).toBe(true);
  expect(isEmblem({ layout: "token" })).toBe(false);
});
```

The zero-quantity test is the one that matters most — `stored || 1` is the natural way to write this and it is wrong.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/features/decks/deckTokens.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `deckTokens.ts`** to the interface above. Use `??`, never `||`, for both fallbacks.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run src/features/decks/deckTokens.test.ts`
Expected: PASS, all nine.

- [ ] **Step 5: Mutate to prove it bites**

Change `row.quantity ?? DEFAULT_TOKEN_QUANTITY` to `row.quantity || DEFAULT_TOKEN_QUANTITY`. The zero test **must** fail. Revert. Report the outcome.

- [ ] **Step 6: Report** — files, test output, mutation outcome. Do not commit.

---

## Task 5: The query hook

**Files:**
- Create: `src/features/decks/useDeckTokens.ts`

**Interfaces:**
- Consumes: `ipc.deckTokens` etc. (Task 3), `deckTokenViews` (Task 4).
- Produces: `useDeckTokens(deckId: number | null, variant: DeckVariant)` returning `{ tokens, loading, failure, setPrinting, setQuantity, dismiss, restore, addToken, showDismissed, setShowDismissed }`.

**Read first:** `src/features/decks/useDeck.ts:338-520` — copy its query-key and invalidation shape rather than inventing one.

- [ ] **Step 1: Write it**

- Query key: `["decks", "tokens", deckId, variant]`. It sits under the `["decks"]` root, so `useDeck`'s existing `invalidate()` already refreshes it when a card is added or removed — which is exactly what should happen, since the derived list changes.
- Each mutation calls its `ipc` method then invalidates `["decks", "tokens", deckId]`.
- `enabled: deckId !== null`.

**Do not add a `staleTime`.** `query.ts` caches 30 s app-wide and a `staleTime` here would hide a missing invalidation — the derived list must move the moment a deck card does.

**No `setState` inside an effect.** The reflexive derived-state sync fails lint only at `npm run verify`, which you are not running. `showDismissed` is plain `useState`; the views are `useMemo(() => deckTokenViews(rows, { showDismissed }), [rows, showDismissed])`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors in your file. IDE diagnostics lag subagent writes and merges — `tsc --noEmit` is the authority.

- [ ] **Step 3: Report** — the exported signature, verbatim, so Task 6 can code to it. Do not commit.

---

## Task 6: The panel, the picker, and the wiring

**Files:**
- Create: `src/features/decks/DeckTokensPanel.tsx`
- Create: `src/features/decks/TokenArtPicker.tsx`
- Modify: `src/features/decks/DeckEditor.tsx` (mount only, ~10 lines)

**Interfaces:**
- Consumes: `useDeckTokens` (Task 5), `DeckTokenView` (Task 4), `ipc.cardPrintings` (existing).
- Produces: `<DeckTokensPanel deckId variant open onToggle />`.

**Read first:** spec §6, and `DeckEditor.tsx:4380-4455` — the comments there are load-bearing.

**Four placement constraints, each already documented in the file, one of which has already cost a session:**

1. **A `<section>`, never an `<aside>`.** A second complementary landmark broke five `App.test.tsx` pane assertions (`DeckEditor.tsx:4417`).
2. **`shrink-0` is mandatory.** The editor's root `<section>` is its only scroller and `DeckEditor.tsx:4423` says `shrink-0` on the bands below the desk "is the whole of why this editor scrolls now".
3. **Below the stats band, not between `PriceStrip` and it.** The strip's drag-remove tray sits at `-top-3`, reaching into the column's `gap-3`; splitting the pair would leave a reader dragging a card the height of four charts to reach the drop that removes it (`DeckEditor.tsx:4413`).
4. **The heading is "Tokens & emblems"**, never bare "Tokens".

- [ ] **Step 1: Write `DeckTokensPanel.tsx`**

```tsx
<section aria-label="Tokens & emblems" className="shrink-0 border-t border-border pt-3">
```

A header button (`aria-expanded`, `aria-controls`) reading `Tokens & emblems` with the count; the body renders only when open. Body is a wall of tiles at the `GridView` scale — reuse `TILE_WIDTH = 150` from `views/GridView.tsx:69` by importing it, do not retype the number. Each tile: `<CardArt>` for `view.printingId`, the name, a `<QuantityStepper size="xs">`, and a press that opens the picker.

**Accessible names must be unique and must not be broken by a CSS gap.** A label and a count in two flex children compute to `"Missing2"`; and two tiles that announce the same name are a real bug the suites cannot see — it shipped once on the collection wall, where a 2X2 and an LEA Lightning Bolt both announced "Copies of Lightning Bolt". Both names were correct and merely not unique, which is why neither suite caught it.

**Deduping by `oracleId` is not enough to make the name unique here.** 104 token/emblem names are shared by more than one `oracle_id` (debug corpus, 2026-09-07): "Elemental" by 31, "Spirit" by 22, "Soldier" by 13 — and `Wurmcoil Engine` alone puts two tokens both called `Wurm 3/3` in one deck. So:

- Draw `view.subtitle` on every tile that has one, under the name.
- Label the stepper with the subtitle folded in: ``label={view.subtitle ? `Quantity of ${view.name}, ${view.subtitle}` : `Quantity of ${view.name}`}``.

Give the name and the subtitle their own element each, and do not rely on two flex children concatenating cleanly — a CSS `gap` between them makes the computed name run the words together.

**Empty state:** when the deck derives nothing, the header says so and the body stays collapsed. Not an error, and not dependent on the Tagger datasets, the price feeds or the relay — this feature reads the corpus and nothing else.

- [ ] **Step 2: Write `TokenArtPicker.tsx`**

A dialog over `ipc.cardPrintings(oracleId, marketplace, limit)` — **no new Rust command; it already works on tokens**, because its predicate is `oracle_id = ?1 AND is_paper = 1` and every token row satisfies both. Pass `playableOnly: false` the way `DeckCoverPicker.tsx:148` already does, or tokens vanish behind the `legal_mask != 0` gate.

Treasure returns 97 printings across 70 distinct arts, so this is a grid with a scroll container, not a dropdown. Wide content scrolls inside its own `overflow-x: auto`; the page body must never scroll horizontally.

Follow the existing `Dialog` component and the `Layer` pattern — add a `Layer` arm if the editor's union is how this opens.

- [ ] **Step 3: Mount it in `DeckEditor.tsx`**

Immediately **after** the `)}` that closes the Deck stats block (near `DeckEditor.tsx:4453`) and before the overlays comment:

```tsx
      {row && (
        <DeckTokensPanel
          deckId={deckId}
          variant={variant}
          open={row.tokensOpen}
          onToggle={(next) => deck.update({ tokensOpen: next })}
        />
      )}
```

`tokensOpen` reaches the row from Task 1's `decks.tokens_open`. If `DeckRow`/`deckUpdate` do not yet carry it, add it there in the same shape as `separateXGroup` — and say so in your report, since it touches `deck.rs`'s row struct and `useDeck`'s `update`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors in your files.

- [ ] **Step 5: Report** — the props you shipped, whether you had to extend `DeckRow`, and the exact heading string. Do not commit.

---

## Task 7: The Storybook fake

**Files:**
- Modify: `.storybook/fake/db.ts`
- Modify: `.storybook/fake/seeds.ts`

**Interfaces:** Consumes Task 3's command names and DTO. Produces fake handlers for all four.

**Read first:** `.storybook/CLAUDE.md`. The fake sits **under** `src/lib/ipc.ts`, never in place of it.

- [ ] **Step 1: Add the store**

A `deckTokens` array on `FakeDb` near the other deck tables, defaulted in `makeDb` (`db.ts:1838`).

- [ ] **Step 2: Add a read handler**

Inside `readHandlers(db)`, **before** the `} satisfies Record<string, CommandHandler>` at `db.ts:7531`. **Store rows and derive the DTO** — a fake that stored DTOs would make all three layers agree and teach a reader a model the app does not have.

- [ ] **Step 3: Add three write handlers**

Inside `writeHandlers(db)` (`db.ts:9541`). They are wrapped by `journalled()` for undo automatically; add them to `NO_UNDO_STEP` (`db.ts:14362`) if a step would restore only half the state.

Argument names must match `invoke`'s object keys **exactly** — a typo is a runtime rejection, same as in the app.

- [ ] **Step 4: Seed one deck with tokens**

In `seeds.ts`, under `starter`, give a deck two tokens and one emblem so a story can show the populated state. **Do not put a NUL in any group key** — a stray `\0` once made ripgrep call `db.ts` binary, so "no matches" became a lie.

- [ ] **Step 5: Verify the fake alone**

Run: `npx vitest run .storybook/fake/db.test.ts`
Expected: PASS — including the sweep that asserts every write handler can be refused by a running sync (the `busy` fault).

**Do not run Storybook or the story plays.** `stories.test.tsx` collects the whole tree and will fail on your siblings' half-written files.

- [ ] **Step 6: Report** — handler names, the seed you added, test output. Do not commit.

---

## Task 8: Stories

**Files:** Create `src/features/decks/DeckTokensPanel.stories.tsx`

**Interfaces:** Consumes Task 6's component and Task 7's seed.

- [ ] **Step 1: Write four stories** — collapsed; expanded with tokens; a deck that derives nothing; and a dismissed token revealed via "show dismissed".

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`

**Do not run the plays.** They are unrunnable during a fan-out.

- [ ] **Step 3: Report.** Do not commit. **Do not write down a story or play count anywhere** — a count is a fact about a tree, every open branch has a different one, and the last two totals were deleted after conflicting on five consecutive merges of `main`.

---

## Task 9: The record

**Files:**
- Modify: `docs/reference/decks-storage.md` — the `deck_tokens` table, the grain, the filter rule, the four commands
- Modify: `src-tauri/CLAUDE.md` — the resolver beside `meld_parts`, **and the schema version**
- Modify: `src/features/decks/CLAUDE.md` — the panel, its placement constraints, the naming rule
- Modify: `docs/reference/data-and-sync.md` — the ladder story

**Two version statements are now wrong and neither routes to a CI job**, so nothing will go red on them (found by Task 1):

- `src-tauri/CLAUDE.md` says "`USER_SCHEMA_VERSION` **34** since collection folders learned to lock" and its ladder narrative stops at v34. That file has a documented history of carrying a wrong version for several rungs — do not let it start another.
- `docs/reference/data-and-sync.md` (~line 635) ends its ladder story at v34 and owes a v35 paragraph.

**The registration count moved from nine to ten.** `sync_engine/apply/tests.rs`'s `every_unique_index_on_a_synced_table_has_been_decided_about` is the tenth, and it is easy to miss because it sits in a `tests.rs` rather than beside the other nine. Record it wherever the list of what a synced table owes is written down.

**Read first:** the spec. Everything here is already argued there; this task moves the durable half into the docs that load with the code.

- [ ] **Step 1: Write the three edits.** Carry the measurements with their date (2026-09-07) and the build (debug corpus, 117 621 rows). Carry **why** the filter rule is a union — that is the fact a future reader will otherwise "simplify" back into a bug.

- [ ] **Step 2: Re-count anything you touched.** A prose-only edit routes to neither CI job, so nothing goes red when a document rots. If you change a list or a count, re-count it in the same edit. Better: do not write down a number a build already answers.

- [ ] **Step 2b: Sweep the synced-table count — it moved 12 → 13.**

`deck_tokens` joined `SYNCED_TABLES` at v35. These four say the old number and none of them routes to a CI job:

| file | says |
| --- | --- |
| `docs/reference/data-and-sync.md:529` | "all twelve synced tables with a unique index each" |
| `docs/reference/sync.md:1781` | "on all twelve synced tables" |
| `docs/reference/web-target.md:1126` | "`app_meta` is not one of the twelve synced tables" |
| `src/features/settings/SyncPanel.stories.tsx:722` | "the world's own **eleven** synced tables" |

**`SyncPanel.stories.tsx` was already wrong before this branch** — it said eleven when the answer had been twelve since `device_names` landed. That is the rot this step exists to stop, and it is the argument for not writing the number down at all where a build can answer it.

**Do NOT touch the dated files under `docs/superpowers/plans/` and `docs/superpowers/specs/`.** Those are historical records of what was true when written; "two of the twelve synced tables" in the 2026-08-31 live-sync spec is correct *as history* and correcting it would falsify the record. `.storybook/fake/db.ts` is already done by Task 7.

- [ ] **Step 3: Note the stale comment.** `search.rs:1252` claims token-only and memorabilia sets have no `cards` rows. Measured false on 2026-09-07: `set_type = 'token'` joins 2 950 rows, `memorabilia` 5 847. Record it as known-stale; do not fix it here.

- [ ] **Step 4: Report.** Do not commit.

---

## Fan-in (the dispatching session, not a subagent)

- [ ] Sweep for unowned files: grep every new symbol against the ownership table above. `git grep` skips untracked files, so use plain `grep` or `git status` — a wiring sweep mid-fan-out otherwise misses every new file.
- [ ] Check for CRLF flips: `git diff --stat` should show no whole-file rewrites.
- [ ] Reconcile the state-word argument name across Task 2 and Task 3. Task 3 shipped the wire key **`tokenState`**, so Task 2's Rust parameter must be `token_state`.
- [ ] Confirm Task 2 emits `colors` as a **concatenated letter string** (`"W"`, `"BGRUW"`, `""`) and not a JSON array — that is how `cards.colors` is stored and what `DeckCard.colors` already is — and `power`/`toughness` as **strings**, since a real token is `*/*`.
- [ ] **Add `DeckTokenRow` to the struct-mirror table in `ipc.test.ts`.** Task 3 could not: the row needs `import deckTokensRs from "../../src-tauri/src/deck_tokens.rs?raw"`, and that file does not exist until Task 2 lands, so the import would red the whole suite. It is the strongest available fence on the DTO — `ipc.ts` is a hand-written mirror that nothing in the build type-checks against the crate, so a field added on one side and forgotten on the other is `undefined` at the call site with no type error anywhere. It catches a `colors` typed as an array and a missing `power` automatically.
- [ ] `npm run verify` — **once, in the foreground, after fan-in.** Never two at once: concurrent runs fake ~18 Rust schema failures. Never pipe it to `tail` — the exit code through a pipe is `tail`'s 0 while tests fail.
- [ ] `cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings` — `verify` runs neither.
- [ ] Drive the real window over CDP and confirm the area, the stepper and the picker. Every UI task in Plans 2–3 found something the suite could not.
- [ ] Commit, PR via the `auto-pr` skill, link #388.

## Self-Review

**Spec coverage:** §1 → Tasks 2, 6 (no new fetch). §2 filter rule → Task 2 Steps 4, 8. §3 derivation and cost → Task 2 Step 4; the active-category rule → Task 2 test 5. §4 table, states, empty-row invariant, nine registrations → Task 1 entire; the `quantity`-is-a-field argument → Task 1 Step 10. §5 Rust facts → Task 2; TS conclusions → Task 4; no-new-Rust picker → Task 6 Step 2. §6 UI, four constraints, naming, empty states → Task 6. §7 testing → Tasks 1, 2, 4, 7, 8. §8 out-of-scope → not built; §9 stale comment → Task 9 Step 3. **No gaps.**

**Placeholder scan:** no TBD, no "handle edge cases", no "similar to Task N". Every code step carries code.

**Type consistency:** `DeckTokenRow` fields are identical in Task 2 (Rust, camelCase serde) and Task 3 (TS). `DeckTokenView` is produced by Task 4 and consumed by Tasks 5 and 6 under one name. `deckTokenViews` is spelled the same in Tasks 4, 5 and 6. `DEFAULT_TOKEN_QUANTITY` is defined once, in Task 4. **One known open item, flagged in both places rather than guessed:** the wire name for the state word (`tokenState`) is decided by Task 2 and mirrored by Task 3, and reconciled at fan-in.
