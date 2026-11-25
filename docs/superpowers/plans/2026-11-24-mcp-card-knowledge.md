# MCP Card Knowledge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an agent connected to the local MCP server combos, raw Scryfall data, related cards, oracle tags, similar cards and format rules, through eight new tools and two widened ones, all answering from the local databases.

**Architecture:** Core (`crates/grimoire-core`) gets the read commands it lacks, each a `read` entry in `commands.rs`'s table and listed on the desktop's `command_table::TABLE_ONLY` (no page calls them). The MCP module (`apps/desktop/src-tauri/src/mcp/`) gets tools that translate onto those commands through `dispatch`, plus `structuredContent` on every result, a `read_guide` tool and a `card_interactions` prompt. One corpus schema rung (9) stores each combo's template text.

**Tech Stack:** Rust (rusqlite, serde_json), Tauri 2 desktop host, TypeScript mirror (`packages/ui/lib/ipc/`), Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-11-24-mcp-card-knowledge-design.md` (approved 2026-11-24). Read it before any task; section numbers below (§6.2 etc.) are its.

## Global Constraints

- No SQL in `apps/desktop/src-tauri/src/mcp/`. Every tool calls `run(state, "<command>", json!({…}))` (`tools.rs:546`).
- Every new core command is a `read` entry in `crates/grimoire-core/src/commands.rs`, wire arguments camelCase (the macro's `rename_all`), and a `(name, reason)` row in `TABLE_ONLY` (`apps/desktop/src-tauri/src/command_table.rs:254`). A `TABLE_ONLY` name must not equal any `fn <name>(` anywhere under `apps/desktop/src-tauri/src/` (`a_table_only_command_has_no_wrapper_here`). The new names are: `combo_get`, `combos_near`, `combos_in_collection`, `card_raw`, `card_related`, `card_oracle_tags`, `cards_similar`. Tool functions use the tool names (`card_combos`, `get_combo`, `held_combos`, `card_scryfall`, `find_tags`, `similar_cards`, `format_rules`, `read_guide`), which collide with none of them.
- Every new tool uses the `read` annotation (`tools.rs:89`) and refuses out-of-range numbers through `Args::bounded` (it refuses; it never clamps).
- Feed status on answers: `comboData: { downloadedAt }` = `combos_status`'s `fetchedAt`; `tagData: { downloadedAt }` = `oracle_tags_status`'s `ingestedAt`. When `downloadedAt` is null the answer also carries `note`, one sentence: the list has not been downloaded yet, the app fetches it weekly at launch, and Settings can fetch it now.
- The combo list holds Commander-legal combos only (`combos.rs:396`); every combo tool description says so.
- No network from any tool or command.
- Corpus head becomes **9** (`CORPUS_SCHEMA_VERSION`, `schema.rs:917`). If `main` has taken 9 when this branch merges, renumber in its own commit before the merge (rename the fixture too).
- Tests that need files use `crate::scratch::path`; MCP tests use `crate::mcp::testing::state(name)` (`mcp/mod.rs:485`) and the `seed`/`done`/`refused` helpers (`tools.rs:1457-1480`).
- Per task, run only that task's own tests by name filter. `pnpm verify` runs once, in Task 12 (the repo's rule; never two verifies at once). Format with `cargo fmt -p <crate>`, never `--all`.
- Commits: Conventional Commits, ending with the `Co-Authored-By` line the session gives.

## Review Focus

1. **A colourless commander.** `deck_commander_identities` answers `Some("")`; passed on as `""` it reads as "no filter" and offers coloured missing cards. Expected: only colourless missing cards. Test in Task 8.
2. **A format typed with capitals** (`"Commander"`). The search's format arm is not lower-cased (`filters.rs:718`). Expected: accepted and matched as `commander`. Test in Task 10.
3. **A double-faced card's raw record.** Expected: `card_scryfall` drops `card_faces[].image_uris` but keeps each face's `oracle_text`. Test in Task 9.
4. **An untagged card when the tag feed is downloaded.** Expected: `tags: []` and no `note`; the `note` belongs only to a missing feed. Test in Task 9.
5. **A large collection's one-away list.** Expected: `total` counts every match while `combos` holds one page; `offset` walks it without repeats. Test in Task 3.

---

### Task 1: Store each combo's template text (corpus schema 9)

**Files:**
- Modify: `crates/grimoire-core/src/combos.rs` (`RawVariant` 227-262, `Combo` 326-366, `reduce` 389-475, `store_batch` 943-1000, `CardCombo` 1537-1563, `page_sql` columns 1836-1838 and the row mapping ending 2055, module doc 62-85)
- Modify: `crates/grimoire-core/src/schema.rs` (`CORPUS_SCHEMA_VERSION` 917 and its doc 754-916, `COMBO_TABLES_SQL` 5470-5518, `COMBO_STAGING_SQL` 9965-9980, `COMBO_V2_COLUMNS` 8909-8914, test-side `NEW_COMBO_COLUMNS` 22266, `the_combo_staging_twin_declares_the_same_defaults` 23666-23696)
- Modify: `packages/ui/lib/ipc/combos.ts` (`CardCombo` 165-234), `packages/fake/db.ts` (`FakeCombo` 3115-3160, `cardCombosPage` 6309-6327), the `CardCombo` literals in `packages/ui/features/card/CombosDialog.stories.tsx` (53, 69, 92, 125), `CombosDialog.test.tsx` (121), `combos.test.ts` (29)
- Modify: `docs/reference/commander-brackets.md` (351-352: "`requires[]` is still a count"), `docs/reference/data-and-sync.md` (562-585, the corpus schema list)

**Interfaces:**
- Produces: `combos::CardCombo.requires: String` (template names, `\n`-joined, `""` when none); TS `CardCombo.requires: string`. Corpus `combos.requires TEXT NOT NULL DEFAULT ''`.

- [ ] **Step 1: Write the failing tests**
  - In `combos.rs` tests: `a_combo_keeps_its_template_text` — ingest a variant whose `requires` is `[{"template":{"name":"a creature with flying"}},{"template":{"name":"an artifact"}}]` (the fixture shape at `combos.rs:2839`) through `parse` + `store`; read it back through `card_combos`; assert `requires == "a creature with flying\nan artifact"` and `template_count == 2`. A variant with `"requires":[]` answers `requires == ""`.
  - In `schema.rs` tests, a new section `// ---- corpus schema 9: combo template text ----`, with a fixture `corpus_missing_requires()` (head corpus with `combos` rebuilt without the column, one combo row and one `combo_meta` row), and:
    - `the_requires_rung_rebuilds_the_combo_tables_and_drops_their_meta`: after `migrate_corpus`, `combos` has a `requires` column, `combos` is empty, `combo_meta` has no row, and `combos::due_at_launch(conn, now)` is true.
    - `a_fresh_corpus_has_requires_and_owes_nothing`.
    - `a_corpus_stamped_at_head_without_requires_still_gets_it` (version 9 stamped over the old shape; the gate is the shape).

- [ ] **Step 2: Run them and see them fail**
  Run: `cargo test -p grimoire-core requires`
  Expected: FAIL (no `requires` field / column).

- [ ] **Step 3: Implement**
  - `RawVariant.requires: Vec<RawRequire>` with `struct RawRequire { template: Option<RawTemplate> }` and `struct RawTemplate { name: Option<String> }`, both `#[serde(default)]`, camelCase, shaped like `RawProduces`/`RawFeature`. `template_count` stays `requires.len() + unidentified`.
  - `Combo.requires: String`, joined exactly as `produces` is (trim, drop empties, `\n`).
  - `requires TEXT NOT NULL DEFAULT ''` added to both `COMBO_TABLES_SQL` and `COMBO_STAGING_SQL`, at the end of the column list, in the same position in both; `store_batch` inserts it (`?12`).
  - Add `"requires"` to `COMBO_V2_COLUMNS` so `combos_are_at_head` sends an older corpus through `rebuild_combo_tables` (corpus schema 2's own rung, `schema.rs:8820`); no new rung function. Bump `CORPUS_SCHEMA_VERSION` to 9 with a `**9 (2026-11-24) is …**` paragraph in its doc. Widen the test-side `NEW_COMBO_COLUMNS` and the `DEFAULT ''` count it drives.
  - `CardCombo.requires` read in `page_sql`'s columns and its mapping; `the_card_combo_dtos_use_the_camel_case_names_the_frontend_expects` (4540-4602) gains the field.
  - TS mirror, fake (`requires: c.requires ?? ""`) and the five literals gain `requires`. The page draws nothing new.
  - Docs: the commander-brackets line now says the template text is stored (corpus schema 9); data-and-sync lists schema 9.

- [ ] **Step 4: Run them and see them pass**
  Run: `cargo test -p grimoire-core requires` and `cargo test -p grimoire-core combo` and `pnpm exec vitest run packages/ui/lib/ipc.test.ts packages/ui/features/card`
  Expected: PASS.

- [ ] **Step 5: Prove the rung on a real database**
  Copy the main checkout's dev `corpus.db` (path in `docs/agent/RUNNING_AND_VERIFYING.md`) to the scratchpad. In a throwaway `#[test]` opening that copy by absolute path, run `migrate_corpus`, then print the `combos` columns, the row count (0) and `due_at_launch` (true). Delete the test and the copy; never commit them.

- [ ] **Step 6: Commit**
  `feat(combos): store each combo's template text (corpus schema 9)`

### Task 2: Read one combo whole, and filter a card's combos by what they produce

**Files:**
- Modify: `crates/grimoire-core/src/combos.rs` (`card_combos` 1968, `SEL_CTE` 1680-1686, the `ask` test helper 4267, the dispatch at 5895-5904)
- Modify: `crates/grimoire-core/src/commands.rs` (467-470; the `combos_for_card` check at 1679-1698)
- Modify: `apps/desktop/src-tauri/src/combos/mod.rs` (`combos_for_card` wrapper 134-159)
- Modify: `apps/desktop/src-tauri/src/command_table.rs` (`TABLE_ONLY`)

**Interfaces:**
- Produces: `combos::combo_by_id(conn: &Connection, id: &str) -> Result<Option<CardCombo>, String>`; command `read combo_get in combos(id: String)`.
- Produces: `card_combos(conn, oracle_id: &str, search: Option<&str>, produces: Option<&str>, card_count: Option<i64>, owned_only: bool, limit: i64, offset: i64)`; command `combos_for_card(oracle_id, search, produces: Option<String>, card_count, owned_only, limit, offset)` — `produces` third, in the table and the desktop wrapper alike.

- [ ] **Step 1: Write the failing tests** (in `combos.rs` tests, over `card_combo_db()`)
  - `one_combo_reads_whole_with_its_pieces_and_owned_counts`: `combo_by_id` of a known id answers the same `CardCombo` `card_combos` lists for it (pieces in feed order, `owned` counts, `requires`); an unknown id answers `Ok(None)`.
  - `a_card_s_combos_narrow_to_what_they_produce`: with produces `"infinite mana"`, only combos whose `produces` contains both words (case-folded, any order, across lines) are listed, and `total`/`matching`/buckets agree with the listed set's rules (`matching` counts the narrowed set); `None` and `"  "` change nothing.

- [ ] **Step 2: Run and see them fail**
  Run: `cargo test -p grimoire-core one_combo_reads_whole a_card_s_combos_narrow`
  Expected: FAIL.

- [ ] **Step 3: Implement**
  - `combo_by_id`: the page's column list and `pieces_sql` for one id.
  - `produces`: split on whitespace, lower-case, pass as a JSON array in a new fixed parameter `?6` (`"[]"` when absent), and add to `sel`: `AND NOT EXISTS (SELECT 1 FROM json_each(?6) w JOIN combos pc ON pc.id = h.combo_id WHERE instr(lower(pc.produces), lower(w.value)) = 0)`. Every statement that uses `sel` binds `?6`.
  - The page's TS wrapper sends no `produces` and needs no change (`ipc.test.ts` checks sent ⊆ declared).
  - `TABLE_ONLY`: `combo_get` — "one combo whole, for the MCP server's get_combo tool; the page reads combos a page at a time through combos_for_card".

- [ ] **Step 4: Run and see them pass**
  Run: `cargo test -p grimoire-core combo` and `cargo test -p mtg-grimoire command_table::`
  Expected: PASS.

- [ ] **Step 5: Commit** — `feat(combos): read one combo whole, filter a card's combos by what they produce`

### Task 3: Combos one card away, and combos in the collection

**Files:**
- Modify: `crates/grimoire-core/src/combos.rs` (beside `MATCH_SQL` 1405-1426 and `OWNED_CTE` 1726-1729)
- Modify: `crates/grimoire-core/src/commands.rs`, `apps/desktop/src-tauri/src/command_table.rs`

**Interfaces:**
- Produces:
  ```rust
  #[derive(Debug, Clone, Serialize, PartialEq, Eq)] #[serde(rename_all = "camelCase")]
  pub struct HeldCombo { pub id: String, pub bracket_tag: String, pub cards: Vec<String>,
      pub template_count: i64, pub produces: String, pub popularity: Option<i64>,
      pub missing: Option<ComboPiece> }
  #[derive(Debug, Clone, Serialize, PartialEq, Eq)] #[serde(rename_all = "camelCase")]
  pub struct HeldCombosPage { pub total: i64, pub combos: Vec<HeldCombo> }
  pub fn near_combos(conn: &Connection, card_ids: &[String], format: Option<&str>,
      identity: Option<&str>, limit: i64, offset: i64) -> Result<HeldCombosPage, String>
  pub fn collection_combos(conn: &Connection, near: bool, format: Option<&str>,
      identity: Option<&str>, limit: i64, offset: i64) -> Result<HeldCombosPage, String>
  ```
  Commands: `read combos_near in combos(card_ids: Vec<String>, format: Option<String>, identity: Option<String>, limit: i64, offset: i64)` and `read combos_in_collection in combos(near: bool, format: Option<String>, identity: Option<String>, limit: i64, offset: i64)`.
- `identity` is colour letters with the search's subset meaning, `"C"` for colourless (an empty string is no filter, as in `CardFilters.colors`). Callers turn a colourless identity into `"C"`.

- [ ] **Step 1: Write the failing tests** (cards seeded with `legal_mask` and `color_identity` set; extend `seed_card` or add `seed_legal_card(conn, id, oracle, name, identity, mask)`)
  - `a_deck_one_card_away_is_told_the_missing_card`: a three-card combo, the deck holds two; answers one `HeldCombo` whose `missing` names the third card, its `card_id` (the `pieces_sql` tie-break) and `owned`.
  - `a_missing_card_the_deck_cannot_play_is_not_offered`: with `format: "commander"` and a missing card whose `legal_mask` lacks the commander bit, nothing; with `identity: "UB"` and a red missing card, nothing; with `identity: "C"`, only a colourless missing card is offered.
  - `a_combo_whose_missing_card_is_not_in_the_corpus_is_left_out`.
  - `a_complete_combo_is_not_one_card_away` and a one-card combo is never "one away" (`card_count >= 2`).
  - `the_collection_holds_complete_and_near_combos`: owned cards (via `own`) make one complete combo (`near: false`, `missing: None`) and one near combo (`near: true`, the missing card's `owned == 0`).
  - `a_long_list_pages_without_repeats` (Review Focus 5): 30 near combos, `limit` 10, offsets 0/10/20 answer 30 distinct ids and `total == 30` each time.
  - Ordering in all of them: `template_count`, `popularity DESC`, `id`.

- [ ] **Step 2: Run and see them fail** — `cargo test -p grimoire-core near collection_holds long_list` → FAIL.

- [ ] **Step 3: Implement**
  - Near SQL: `MATCH_SQL`'s shape with `h.have = c.card_count - 1 AND c.card_count >= 2`; the missing piece is the one `combo_cards` row whose oracle id is not in the held set; resolve it to its printing with `pieces_sql`'s tie-break and require that row to exist; filter it with `filters::push_card_filters` over `CardFilters { format, colors: identity, ..Default::default() }` against that printing's alias. `total` is a `count(*)` over the same filtered set. `limit` clamped to `1..=MAX_PAGE`, `offset` to `>= 0`, as `card_combos` does.
  - Collection: the held set is `OWNED_CTE`'s owned oracle ids (presence), complete = `have = card_count`, near as above; `owned` on the missing piece through `copies_of_oracle`.
  - `TABLE_ONLY`: `combos_near` — "combos a deck is one card away from, for the MCP server's held_combos tool"; `combos_in_collection` — "combos the reader's whole collection holds or is one card away from, for the MCP server's held_combos tool".

- [ ] **Step 4: Run and see them pass** — the same filter plus `cargo test -p mtg-grimoire command_table::` → PASS.

- [ ] **Step 5: Measure** on a copy of the real dev database: `combos_in_collection(near: true)` and `combos_near` for the largest real deck answer in under 1 s (spec §6.2). If not, add an index in `COMBO_INDEXES_SQL` and say which in the commit.

- [ ] **Step 6: Commit** — `feat(combos): combos one card away, for a deck or the whole collection`

### Task 4: A printing's raw Scryfall record, and its direct oracle tags

**Files:**
- Modify: `crates/grimoire-core/src/card.rs`, `crates/grimoire-core/src/tags/oracle.rs`, `crates/grimoire-core/src/commands.rs`, `apps/desktop/src-tauri/src/command_table.rs`

**Interfaces:**
- Produces: `card::raw_cards(conn: &Connection, ids: &[String]) -> Result<Vec<RawRecord>, String>` with `#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct RawRecord { pub id: String, pub scryfall: Option<serde_json::Value> }` (one per asked id, in order; `None` for an id the corpus lacks or a blob that will not inflate). More than 20 ids → `Err("At most 20 cards at a time.")`. Command `read card_raw in card(ids: Vec<String>)`.
- Produces: `tags::oracle::direct_tags(conn: &Connection, card_id: &str) -> Result<Vec<TagLabel>, String>` with `#[derive(Serialize)] pub struct TagLabel { pub slug: String, pub label: String }`: the printing's oracle id's rows in `oracle_taggings` joined to `oracle_tags`, ordered by label. Command `read card_oracle_tags in tags::oracle(card_id: String)`.

- [ ] **Step 1: Write the failing tests**
  - `card.rs`: `a_raw_record_is_the_stored_scryfall_json` (a row whose `raw` is `card_row::gzip_raw(r#"{"id":"a","name":"X","all_parts":[]}"#)` answers that JSON as a value); `an_unknown_id_or_a_broken_blob_answers_none`; `more_than_twenty_ids_are_refused`.
  - `tags/oracle.rs`: `a_card_s_direct_tags_come_with_labels_and_without_ancestors` (a tagging to a child tag answers the child only, with its label); `an_untagged_card_answers_no_tags`.

- [ ] **Step 2: Run and see them fail** — `cargo test -p grimoire-core raw_record direct_tags` → FAIL.

- [ ] **Step 3: Implement** — read `CAST(raw AS BLOB)` and inflate with `card_row::raw_json`. `TABLE_ONLY` rows: `card_raw` — "a printing's whole Scryfall record, for the MCP server's card_scryfall tool"; `card_oracle_tags` — "a card's own oracle tags with labels, for the MCP server's get_card; the page reads the tag closure through oracle_tags_for_printings".

- [ ] **Step 4: Run and see them pass** — same filter, plus `cargo test -p mtg-grimoire command_table::` → PASS.

- [ ] **Step 5: Commit** — `feat(core): read a printing's raw Scryfall record and its direct oracle tags`

### Task 5: What a card brings with it

**Files:**
- Create: `crates/grimoire-core/src/card_related.rs` (and `pub mod card_related;` in `lib.rs`)
- Modify: `crates/grimoire-core/src/deck_tokens.rs` (make `MARKERS` 189-231, `Marker` 170, `rules_text` 711-725, `marker_printings` 736-765 and `TOKEN_COMPONENTS`/`EXTRA_LAYOUTS` 103-111 `pub(crate)`; no behaviour change)
- Modify: `crates/grimoire-core/src/commands.rs`, `apps/desktop/src-tauri/src/command_table.rs`

**Interfaces:**
- Produces: `card_related::related_cards(conn: &Connection, id: &str) -> Result<Vec<RelatedCard>, String>` with
  `#[derive(Debug, Clone, Serialize, PartialEq, Eq)] #[serde(rename_all = "camelCase")] pub struct RelatedCard { pub relation: String, pub name: String, pub card_id: Option<String>, pub type_line: Option<String> }`.
  `relation` is one of `token`, `emblem`, `meldPart`, `meldResult`, `comboPiece`, `helper`. Command `read card_related in card_related(id: String)`. An unknown id, a blob that will not parse, or no `all_parts` answers the markers alone (or `[]`).

- [ ] **Step 1: Write the failing tests** (cards with hand-written `raw` via `gzip_raw`)
  - `a_card_s_tokens_and_emblems_are_named` (a `token` part to a token row; a part whose target layout is `emblem` answers `emblem`).
  - `a_meld_card_names_its_partner_and_result`.
  - `the_card_itself_is_left_out_by_oracle_id_but_its_namesake_token_stays` (an Embalm card whose `all_parts` holds its own `combo_piece` entry and a same-named token: the token stays, the self entry goes).
  - `a_card_that_makes_you_the_monarch_names_the_monarch` (a marker in `oracle_text`, `relation: "helper"`).
  - `an_unresolved_part_keeps_its_name_without_a_card_id` (name and `type_line` from the `all_parts` entry).

- [ ] **Step 2: Run and see them fail** — `cargo test -p grimoire-core card_related` → FAIL.

- [ ] **Step 3: Implement** — read `oracle_id`, `CAST(raw AS BLOB)` for the id; walk `all_parts` (`id`, `name`, `component`, `type_line`); resolve each `id` in `cards` (`layout`, `oracle_id`, `type_line`); drop entries whose resolved `oracle_id` equals the card's; map `component` to `relation` (`token` → `emblem` when the target layout is in `EXTRA_LAYOUTS`; `meld_part` → `meldPart`; `meld_result` → `meldResult`; `combo_piece` → `comboPiece`); then markers through `rules_text` + `marker_printings`, each as `helper` with the resolved printing's id. `TABLE_ONLY`: `card_related` — "what one card brings with it, for the MCP server's get_card".

- [ ] **Step 4: Run and see them pass** — same filter plus `cargo test -p grimoire-core deck_tokens` and `cargo test -p mtg-grimoire command_table::` → PASS.

- [ ] **Step 5: Commit** — `feat(core): read what a card brings with it — tokens, emblems, meld, helpers`

### Task 6: Cards similar to a card, by shared oracle tags

**Files:**
- Create: `crates/grimoire-core/src/similar.rs` (and `pub mod similar;` in `lib.rs`)
- Modify: `crates/grimoire-core/src/commands.rs`, `apps/desktop/src-tauri/src/command_table.rs`

**Interfaces:**
- Produces: `similar::similar_cards(conn: &Connection, oracle_id: &str, format: Option<&str>, identity: Option<&str>, limit: i64) -> Result<Vec<SimilarCard>, String>` with
  `#[derive(Debug, Clone, Serialize, PartialEq)] #[serde(rename_all = "camelCase")] pub struct SimilarCard { pub name: String, pub card_id: String, pub oracle_id: String, pub type_line: Option<String>, pub mana_cost: Option<String>, pub score: f64, pub shared_tags: Vec<String> }`.
  Command `read cards_similar in similar(oracle_id: String, format: Option<String>, identity: Option<String>, limit: i64)`. `limit` clamped to `1..=50`.

- [ ] **Step 1: Write the failing tests**
  - `a_rare_shared_tag_outweighs_a_common_one`: card A shares one rare tag with B and one common tag with C; B ranks above C.
  - `score_is_the_sum_of_ln_n_over_df`: a fixture with N = 4 tagged cards; assert the score to 3 decimals.
  - `the_card_itself_is_never_similar_to_itself`, `ties_are_broken_by_name`, `format_and_identity_narrow_the_candidates` (`identity: "C"` keeps only colourless), `an_untagged_card_has_no_similar_cards`.
  - `shared_tags_are_the_three_highest_weighted_labels`.

- [ ] **Step 2: Run and see them fail** — `cargo test -p grimoire-core similar` → FAIL.

- [ ] **Step 3: Implement** — direct taggings only (`oracle_taggings`); `N = count(DISTINCT oracle_id)`, `df` per shared slug; candidates are other oracle ids holding any of the card's slugs; score `Σ ln(N/df)` rounded to 3 decimals; each candidate drawn as its printing by the `pieces_sql` tie-break; `format`/`identity` through `filters::push_card_filters` with `CardFilters { format, colors: identity, .. }`. If a run over the real corpus takes over 300 ms, add `idx_oracle_taggings_slug` to `TAG_INDEXES_SQL` (replayed on every corpus by `migrate_corpus`, `schema.rs:8893`). `TABLE_ONLY`: `cards_similar` — "cards that do what a card does, ranked by shared oracle tags, for the MCP server's similar_cards tool".

- [ ] **Step 4: Run and see them pass** — same filter plus `cargo test -p mtg-grimoire command_table::` → PASS.

- [ ] **Step 5: Commit** — `feat(core): rank cards similar to a card by shared oracle tags`

### Task 7: Structured results on every tool

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/rpc.rs` (`tools/call` arm 132-160; tests 197-214)

**Interfaces:**
- Produces: a `Done` result is `{"content":[{"type":"text","text": <answer JSON>}], "structuredContent": <answer>, "isError": false}`. A `Refused` result is unchanged (no `structuredContent`). Every tool already answers an object (all 18 checked); a new tool must too.

- [ ] **Step 1: Write the failing test** — `a_tool_s_answer_is_also_structured_content` in `rpc.rs`: `tools/call` of `search_collection` on a `testing::state` answers `structuredContent` equal to the parsed text, an object; a refused call carries no `structuredContent`. Also make `tools.rs`' `done` test helper (1466-1472) assert `answer.is_object()`, so every tool test, old and new, holds each tool to an object answer.
- [ ] **Step 2: Run and see it fail** — `cargo test -p mtg-grimoire mcp::rpc` → FAIL.
- [ ] **Step 3: Implement** — in the `Done` arm; `debug_assert!(answer.is_object())`.
- [ ] **Step 4: Run and see it pass** — `cargo test -p mtg-grimoire mcp::` → PASS.
- [ ] **Step 5: Commit** — `feat(mcp): answer every tool's result as structured content too`

### Task 8: The combo tools

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/tools.rs` (`list()` 88-387, `call` 419-439, the count guard in `every_tool_has_a_closed_object_schema_and_a_distinct_name` 1483-1502)

**Interfaces:**
- Consumes: `combos_for_card` (with `produces`), `combo_get` (Task 2), `combos_for_cards`, `combos_near`, `combos_in_collection` (Task 3), `combos_status`, `deck_get(id, variant)` (answers `deck.formatKey`, `cards[].cardId`, `cards[].categoryActive`), `deck_commander_identities` (answers `[{deckId, identity, theoryIdentity}]`), `format_specs_list` (`key`, `hasLegalityData`).
- Produces: tools `card_combos`, `get_combo`, `held_combos` with the arguments, short and full shapes, `comboData` and `note` of spec §6.2. Private helpers `fn combo_data(status: &Value) -> Value` and `fn bracket_word(letter: &str) -> String` (R Ruthless, S Spicy, P Powerful, O Oddball, C Core, E Exhibition, B Banned; any other letter as itself), `fn short_combo(v: &Value) -> Value`, `fn full_combo(v: &Value) -> Value` (with `url` = `https://commanderspellbook.com/combo/{id}/`). `produces`, `requires`, `steps` (from `description`) and both prerequisite fields split on `\n` into lists, empties dropped.

- [ ] **Step 1: Write the failing tests** (seed combos with direct inserts naming every column, as `combos.rs`' `seed_one` does, plus `combo_meta` for `fetchedAt`)
  - `card_combos_lists_a_card_s_combos_short`: bracket word, `produces` as a list, `comboData.downloadedAt`; an unknown `cardId` is refused naming `find_cards`.
  - `get_combo_answers_one_combo_whole` (steps, prerequisites, requires as lists; `url`); an unknown id refused.
  - `held_combos_reads_a_deck_s_active_piles_only` (a combo completed only by a switched-off pile's card is not complete).
  - `held_combos_offers_only_missing_cards_the_deck_can_play` (format from the deck; identity from its commanders).
  - `a_colourless_commander_offers_only_colourless_missing_cards` (Review Focus 1: `identity: ""` from `deck_commander_identities` becomes `"C"`).
  - `held_combos_without_a_deck_reads_the_collection`.
  - `a_non_commander_deck_is_told_the_list_is_commander_s` (`note`).
  - `a_combo_list_never_downloaded_says_so` (no `combo_meta`: `downloadedAt: null` and `note`, on all three tools).
  - The count guard becomes 21.
- [ ] **Step 2: Run and see them fail** — `cargo test -p mtg-grimoire mcp::tools` → FAIL.
- [ ] **Step 3: Implement** — descriptions say the list is Commander Spellbook's, Commander-legal combos only, and that `get_combo` has the steps. `held_combos`' deck format is used only when `format_specs_list` marks it `hasLegalityData`.
- [ ] **Step 4: Run and see them pass** — `cargo test -p mtg-grimoire mcp::` → PASS.
- [ ] **Step 5: Commit** — `feat(mcp): combo tools — a card's combos, one combo whole, combos a deck or the collection holds`

### Task 9: Raw records, tags, similar cards, format rules, and `get_card` widened

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/tools.rs` (`get_card` 648-694 and its schema 186-194; `list()`; `call`; count guard)

**Interfaces:**
- Consumes: `card_raw` (Task 4), `card_oracle_tags` (Task 4), `card_related` (Task 5), `cards_similar` (Task 6), `tag_search(text, namespace: "oracle", limit)` (answers `slug`, `label`, `cardCount`, …), `oracle_tags_status` (`ingestedAt`), `format_specs_list`, `combos_for_card` (`total`).
- Produces: tools `card_scryfall`, `find_tags`, `similar_cards`, `format_rules` per spec §6.3, §6.5, §6.6; `get_card` gains `tags`, `tagData` (+ `note`), `related`, `comboCount`, and `faces` (each `{name, typeLine, manaCost, oracleText}` from `CardDetail.faces`, which it drops today). `format_rules` answers `searchable` = `hasLegalityData`. A private `fn format_key(args: &Args, specs: &Value) -> Result<Option<String>, String>` lower-cases and accepts only `hasLegalityData` keys, refusing with a sentence naming the searchable keys (Task 10 reuses it).

- [ ] **Step 1: Write the failing tests**
  - `card_scryfall_answers_the_record_without_image_or_shop_links`; with `fields`, only those; an absent id lands in `missing`; 21 ids refused.
  - `a_two_faced_record_keeps_its_faces_text` (Review Focus 3: `card_faces[].image_uris` gone, `card_faces[].oracle_text` kept).
  - `get_card_names_tags_related_cards_faces_and_a_combo_count`.
  - `an_untagged_card_has_no_tags_and_no_note` versus `a_missing_tag_feed_says_so` (Review Focus 4).
  - `find_tags_turns_words_into_slugs`; `similar_cards_ranks_by_shared_tags` (and refuses `format: "casual"`); `format_rules_marks_which_formats_can_be_searched`.
  - The count guard becomes 25.
- [ ] **Step 2: Run and see them fail** — `cargo test -p mtg-grimoire mcp::tools` → FAIL.
- [ ] **Step 3: Implement** — `card_scryfall` strips `image_uris`, `card_faces[].image_uris`, `purchase_uris`, `related_uris` unless `fields` names them; its description says `prices` there are as of the last card sync. `get_card` keeps working when a feed or a new read fails (each extra field is left out, as `owned` is today).
- [ ] **Step 4: Run and see them pass** — `cargo test -p mtg-grimoire mcp::` → PASS.
- [ ] **Step 5: Commit** — `feat(mcp): raw Scryfall records, oracle tags, similar cards and format rules`

### Task 10: `find_cards` takes the app's filters

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/tools.rs` (`find_cards` 605-646, schema 171-185)
- Modify: `crates/grimoire-core/src/filters.rs` (`ALL_RARITIES` 1196: `pub(crate)` → `pub`)

**Interfaces:**
- Consumes: `search_cards({req})` (`SearchRequest`, search.rs:32-199), `tag_resolve({asks:[{namespace:"oracle", value}]})` (answers `null` per unknown slug), `format_key` (Task 9), `grimoire_core::cardtypes::TYPE_KEYS`, `grimoire_core::filters::ALL_RARITIES`.
- Produces: `find_cards` with optional `query` and a `filters` object of spec §6.4: `format`, `colors` (letters `WUBRG` or `C`: cards whose colour identity fits inside them, the filter bar's meaning), `colorsExact`, `types`, `rarities`, `sets`, `manaValues` (0–8, 8 meaning 8 or more), `manaX`, `owned`, `priceMin`, `priceMax`, `oracleTags`, `gameChanger`. At least one of `query` and `filters` is required. Mapping: `colors` → `colors` (joined), `colorsExact` → `colorsStrict`, `oracleTags` → `oracleTags: {include}`, `gameChanger: true` → `predicates: [{"field":"is","op":"colon","value":"gamechanger"}]`, the rest by name. Same answer shape as today.

- [ ] **Step 1: Write the failing tests**
  - `find_cards_filters_by_format_colours_types_and_mana_value`.
  - `a_format_typed_with_capitals_is_accepted` (Review Focus 2).
  - `game_changers_are_a_filter` (a seeded `game_changer = 1` card only).
  - `oracle_tags_narrow_and_an_unknown_tag_is_refused_naming_find_tags`.
  - `an_unknown_filter_value_is_refused_naming_its_field` (one each for a colour letter, a type, a rarity, a non-searchable format).
  - `find_cards_needs_a_query_or_a_filter`.
- [ ] **Step 2: Run and see them fail** — `cargo test -p mtg-grimoire mcp::tools::tests::find_cards` (and the others by name) → FAIL.
- [ ] **Step 3: Implement** — `filters` is a closed object in the schema (`additionalProperties: false`).
- [ ] **Step 4: Run and see them pass** — `cargo test -p mtg-grimoire mcp::` → PASS.
- [ ] **Step 5: Commit** — `feat(mcp): find_cards takes the app's filters, oracle tags and game changers`

### Task 11: The guide tool, the `card_interactions` prompt and the server's instructions

**Files:**
- Create: `apps/desktop/src-tauri/src/mcp/prompts/card_interactions.md`
- Modify: `apps/desktop/src-tauri/src/mcp/prompts.rs` (`PROMPTS: [Prompt; 3]` 25-51 → 4; tests 94-160), `apps/desktop/src-tauri/src/mcp/tools.rs` (`read_guide`; count guard), `apps/desktop/src-tauri/src/mcp/rpc.rs` (`INSTRUCTIONS` 33-41)

**Interfaces:**
- Consumes: `prompts::get(name, None)` (answers `messages[0].content.text`).
- Produces: prompt `card_interactions` (argument `question`); tool `read_guide(topic)` with `topic` an enum of every prompt name, answering `{ topic, guide }` where `guide` is that prompt's text with no argument; a public `prompts::names() -> Vec<&'static str>` the tool's enum is built from.

- [ ] **Step 1: Write the failing tests**
  - prompts.rs: the listed names become `["search_cards","create_widget","graphql_discovery","card_interactions"]`; `card_interactions_names_every_tool_it_teaches` (each of `get_card`, `card_combos`, `get_combo`, `held_combos`, `find_tags`, `find_cards`, `similar_cards`, `card_scryfall`, `format_rules` appears in the body, and each is in `tools::list()`).
  - tools.rs: `read_guide_answers_every_prompt` (for each of `prompts::names()`, `guide` equals `prompts::get`'s text); `read_guide_s_topics_are_the_prompt_names`; an unknown topic refused. The count guard becomes 26.
  - rpc.rs: `the_instructions_name_the_guide_and_the_new_tools` (`INSTRUCTIONS` contains `read_guide`, `card_combos`, `card_scryfall`).
- [ ] **Step 2: Run and see them fail** — `cargo test -p mtg-grimoire mcp::` → FAIL.
- [ ] **Step 3: Write `card_interactions.md`** — the content of spec §6.8: which tool answers which question, a feed that is missing is said so, combos are Commander Spellbook's (Commander-legal only) and tags the Scryfall tagger's, no rulings yet, short shapes first. Open with `# How cards fit together in MTG Grimoire`. Update `INSTRUCTIONS` to name the combo, tag and raw tools, `read_guide` and the four prompts, keeping every existing rule.
- [ ] **Step 4: Run and see them pass** — `cargo test -p mtg-grimoire mcp::` → PASS.
- [ ] **Step 5: Commit** — `feat(mcp): a guide tool and the card_interactions prompt`

### Task 12: Documentation, the whole suite, and a real request

**Files:**
- Modify: `docs/reference/local-mcp-server.md` (tool table 38-57, prompts 92-104, the stale table names 106-110, §6 273-284), `apps/desktop/src-tauri/CLAUDE.md` (the MCP bullet in §4; edit it while no `tauri dev` is running, since a `src-tauri` doc edit restarts one)

- [ ] **Step 1: Update the docs** — the tool table gains the eight tools and the widened `find_cards`/`get_card`; the prompts table gains `card_interactions` and the guide tool; lines 106-110 name only `CUSTOM_WIDGET_TABLES`, which is what exists; §6 says what is true now (prompts exist, widgets are edited and deleted here, combos/rulings/syntax/deck tools: projects B–E). The CLAUDE.md bullet names the new core commands' home on `TABLE_ONLY`, `structuredContent` and `read_guide`.
- [ ] **Step 2: Run the whole suite once** — `pnpm verify`. Expected: green. A failure is fixed in the task it belongs to, then `pnpm verify` again.
- [ ] **Step 3: Drive it for real** — take the app lock (`running-the-app` skill), start `pnpm tauri dev`, switch the server on in Settings → Integrations, and with the panel's token `curl` `tools/list` (26 tools), `tools/call` of `card_combos`, `held_combos` (a real deck), `get_card` and `card_scryfall` against the dev data. Report what came back in the hand-off. Release the lock.
- [ ] **Step 4: Commit** — `docs(mcp): the card knowledge tools in the reference and the host guide`
