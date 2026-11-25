# MCP Rulings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store Scryfall's rulings bulk file in the corpus as a weekly desktop feed, and answer it to an agent through a `card_rulings` tool, a `rulingCount` on `get_card` and the `card_interactions` prompt.

**Architecture:** Core (`crates/grimoire-core`) gets corpus schema 10 (`rulings`, `ruling_meta`), a `rulings` module (a push sink over `feed::frame`, a file-backed refresh through `scryfall::Client`, two read paths) and two `read` commands on the desktop's `command_table::TABLE_ONLY`. The desktop launch spawns the feed. The MCP module translates onto the two commands.

**Tech Stack:** Rust (rusqlite, serde_json, flate2, httpmock in tests), Tauri 2 desktop host.

**Spec:** `docs/superpowers/specs/2026-11-25-mcp-rulings-design.md` (approved 2026-11-25). Section numbers below (§6.1 etc.) are its.

## Global Constraints

- No SQL in `apps/desktop/src-tauri/src/mcp/`; tools call `run(state, "<command>", json!({…}))`.
- Both new commands are `read` entries in `crates/grimoire-core/src/commands.rs` and rows of `TABLE_ONLY` (`apps/desktop/src-tauri/src/command_table.rs`), and no `fn rulings_for_cards(` / `fn rulings_status(` exists under `apps/desktop/src-tauri/src/` (`a_table_only_command_has_no_wrapper_here`). The tool function is `card_rulings`.
- No network from a tool or a command. The feed asks `GET /bulk-data/rulings` through `state.client` and downloads the file it names; nothing else.
- Corpus head becomes **10**. If `origin/main` has taken 10 when this branch merges, renumber in its own commit first.
- Core rules: no raw I/O, threads or clocks outside `src/platform/` in shipped code (`platform::fence`); multi-line Rust strings with `concat!` (or SQL literals as the module already writes them); `cards.raw` is never read in SQL.
- Tests needing files use `crate::scratch::path` / `state::fixtures::on_files`; the refresh tests share one `tokio::sync::Mutex` so they do not race on the module's claim.
- Per task, run that task's own tests by name filter. `pnpm verify` runs once, in Task 8. `cargo fmt -p <crate>`, never `--all`.
- Commits: Conventional Commits, ending with the session's `Co-Authored-By` and `Claude-Session` lines.

## Review Focus

1. **A fresh install's corpus is stamped 10 by `split::finish` without the tables.** Expected: the shape-gated rung creates both. Test in Task 1.
2. **A ruling repeated exactly in the file.** Expected: stored once, `seq` without a gap. Test in Task 2.
3. **The feed never downloaded.** Expected: `card_rulings` answers `rulings: []` per card, `rulingData.downloadedAt: null` and the note; `get_card` answers `rulingCount: 0` with the note. Test in Task 6.
4. **A card with no rulings once the feed is in.** Expected: `rulings: []` and no `note`. Test in Task 6.
5. **The tag note.** Expected: it no longer says Settings can fetch the list; the combo note still does. Test in Task 5.

---

### Task 1: Corpus schema 10 — the rulings tables

**Files:** `crates/grimoire-core/src/schema.rs` (`CORPUS_SCHEMA_VERSION` and its doc, `TABLES`, `create_corpus_schema`, `migrate_corpus`, new `RULING_TABLES_SQL`, `RULING_STAGING_SQL`, `RULING_TABLES`, `create_ruling_staging`, `drop_ruling_staging`, `swap_ruling_staging`, `rulings_are_owed`, `add_ruling_tables`; tests).

- [ ] Tests first, in a `// ---- corpus schema 10: rulings ----` section:
  - `a_fresh_corpus_has_the_ruling_tables_and_owes_nothing`
  - `a_corpus_without_the_ruling_tables_gets_them` — head pair, both tables dropped, `user_version` 9; `migrate_corpus`; both tables exist, version 10, a `cards` row seeded beforehand is still there; a second `migrate_corpus` changes nothing.
  - `a_corpus_stamped_at_head_without_the_ruling_tables_still_gets_them` — the same at version 10.
  - `a_corpus_missing_only_ruling_meta_gets_it` — `rulings` kept with a row, `ruling_meta` dropped; the row survives.
  - `the_ruling_staging_table_matches_the_live_one` — `PRAGMA table_info` column by column (the tag/combo twins' test shape).
  - `a_ruling_swap_keeps_the_primary_key` — stage one row, swap in a transaction, `PRAGMA index_list(rulings)` / a duplicate insert is refused.
- [ ] Run `cargo test -p grimoire-core ruling` → FAIL.
- [ ] Implement: the DDL of §6.1 (`CREATE TABLE IF NOT EXISTS` in `RULING_TABLES_SQL`, plain `CREATE` in the staging literal, which drops first); `create_corpus_schema` runs `RULING_TABLES_SQL`; `migrate_corpus` gains `if rulings_are_owed(conn, CORPUS)? { add_ruling_tables(conn, CORPUS)?; }` after the schema 8 gates; `rulings_are_owed` asks `{schema}.sqlite_master` for both names; `TABLES` gains `rulings`, `ruling_meta` (`Side::Corpus`); `CORPUS_SCHEMA_VERSION = 10` with a `**10 (2026-11-25) is the rulings feed's two tables**` paragraph.
- [ ] Run the filter → PASS; also `cargo test -p grimoire-core schema::` (other corpus tests that enumerate tables).
- [ ] Commit `feat(schema): the rulings tables (corpus schema 10)`.

### Task 2: The ingest and the reads (`crates/grimoire-core/src/rulings.rs`)

**Files:** new `crates/grimoire-core/src/rulings.rs`, `lib.rs` (`pub mod rulings;`), `scryfall.rs` (`BULK_RULINGS`), `tests/fixtures/rulings.jsonl` (new).

**Interfaces:**
- `pub const BULK_NAME: &str = crate::scryfall::BULK_RULINGS;` (`"rulings"`), `REFRESH_INTERVAL_SECS = 7 * 86_400`.
- `pub struct Ruling { source, published_at, comment }`, `pub struct CardRulings { oracle_id, rulings: Vec<Ruling> }` (serde camelCase).
- `pub struct RulingStatus { updated_at, ingested_at, checked_at, ruling_count, card_count, stale, refreshing }` (camelCase).
- `pub struct RulingStats { rulings, cards, duplicates, skipped_lines }`.
- `pub enum RulingError { Io, Sql, Empty { skipped }, MostlySkipped { kept, skipped } }` with `kind()` for `errors::record`.
- `pub struct StreamRulings<'a>` with `begin(db)`, `push(chunk)`, `abandon(self)`, `finish(self, stamp, ingested_at)`; `pub fn ingest_gz(db, path, stamp, ingested_at)`.
- `pub fn rulings_for_cards(conn, oracle_ids: &[String]) -> rusqlite::Result<Vec<CardRulings>>`; `pub fn read_status(conn, now) -> RulingStatus`.

- [ ] Tests first (file fixture through `tags::testing::gz_fixture`): two cards' rulings kept in file order with `seq` 0..n; an exact repeat dropped and counted; lines with no oracle id, a non-ruling `object`, an empty comment, and not-JSON counted skipped; a file of only bad lines refused (`Empty`) and one mostly bad refused (`MostlySkipped`), each keeping the previous rows and leaving no `rulings_staging`; the meta row counts rulings and cards and carries the stamp; `rulings_for_cards` answers in the order asked, blank and repeated ids dropped, an unknown id `[]`; `read_status` on a corpus with no meta row is all `None` and stale.
- [ ] Run `cargo test -p grimoire-core rulings::` → FAIL.
- [ ] Implement per §6.2: `Decoder` + `Lines`, parse with `serde_json`, duplicate check by a `HashSet<u64>` of the hashed (oracle id, source, date, comment), per-card `seq` from a `HashMap<String, i64>`, batches of 2 000 through `db::lock_background` and `stand_aside`, refusals before the swap, the swap and the meta row in one transaction.
- [ ] Run the filter → PASS. Commit `feat(rulings): ingest Scryfall's rulings file and read a card's rulings`.

### Task 3: The refresh

**Files:** `crates/grimoire-core/src/rulings.rs`, `crates/grimoire-core/src/reset.rs` (`cache_clear`'s guard).

**Interfaces:** `pub async fn refresh(state: &Arc<State>, force: bool, progress: &mut (dyn FnMut(&str, u64, u64) + Send)) -> Result<RulingStatus, String>`; `pub async fn refresh_if_due(state: &Arc<State>)`; `pub fn due_at_launch(state: &State, now: i64) -> bool`; `pub fn status_of(state: &State) -> RulingStatus`; `pub(crate) fn any_refresh_running() -> bool`.

- [ ] Tests first (httpmock, `state::fixtures::on_files`, one serialising mutex): check → download → ingest → `done`, then a forced run 304s and downloads nothing; a run inside the week asks nothing; a 200 with the same `updated_at` stores the new ETag and downloads nothing; a size mismatch keeps the old rows and makes `due_at_launch` false (resting); a refused file rests the feed and logs to `error_log` under `rulings`; a 429 on the check is persisted (`sync::persist_penalty`); a second concurrent refresh is refused; the temporary file is gone after success and failure; under `platform::host::emulate_page` the refresh refuses and the mock sees no request; `cache_clear` refuses while a rulings refresh holds the claim.
- [ ] Run `cargo test -p grimoire-core rulings::` → FAIL.
- [ ] Implement per §6.2, after `tags::refresh_once`'s shape (claim, throttle, conditional ETag only when rows exist, `mark_checked`, `updated_at` short cut, size guard, `tmp/rulings.jsonl.gz`, `spawn::blocking` ingest, `discard_partial`, `feed::backoff`, `note_failure` with `Source::ScryfallApi`).
- [ ] Run the filter and `cargo test -p grimoire-core reset::` → PASS. Commit `feat(rulings): refresh the rulings file weekly`.

### Task 4: The commands and the desktop launch

**Files:** `crates/grimoire-core/src/commands.rs`, `apps/desktop/src-tauri/src/command_table.rs` (`TABLE_ONLY`), `apps/desktop/src-tauri/src/desktop.rs` (`spawn_optional_feeds`).

- [ ] `read rulings_for_cards in rulings(oracle_ids: Vec<String>) = |conn| …` and `read rulings_status in rulings() = |conn| …`; two `TABLE_ONLY` rows ("rulings for the MCP server's card_rulings and get_card; no page reads rulings", "the rulings feed's age, for the MCP server's rulingData").
- [ ] `spawn_optional_feeds` gains the seventh task, `grimoire_core::rulings::refresh_if_due`, with its comment; the fn's doc names it.
- [ ] Run `cargo test -p grimoire-core commands::` and `cargo test -p mtg-grimoire command_table::` → PASS. Commit `feat(rulings): read commands, and the desktop fetches the file at launch`.

### Task 5: The never-downloaded note per feed

**Files:** `apps/desktop/src-tauri/src/mcp/tools.rs` (`with_feed_data`, `with_combo_data`, `with_tag_data`, tests that assert "Settings").

- [ ] Test first: the tag note does not contain "Settings"; the combo note does.
- [ ] `with_feed_data` takes the fetch sentence; combos pass the Settings one, tags the launch-only one.
- [ ] Run `cargo test -p mtg-grimoire mcp::` → PASS. Commit `fix(mcp): the oracle tag note no longer promises a Settings button`.

### Task 6: `card_rulings` and `get_card`'s count

**Files:** `apps/desktop/src-tauri/src/mcp/tools.rs` (`list`, `call`, `card_rulings`, `get_card`, `with_ruling_data`), `apps/desktop/src-tauri/src/mcp/rpc.rs` (`INSTRUCTIONS`).

- [ ] Tests first (`mcp::testing::state`, seed rows directly in the corpus as the tag tests do): two ids, rulings oldest first with `publishedAt`, `source`, `text`; an unknown id in `missing`; a card with none `[]` and no note when downloaded; the note and `downloadedAt: null` when not; `cardIds` empty or 11 refused; `get_card`'s `rulingCount` and `rulingData`; the tool list's count and the instructions test.
- [ ] Implement per §6.4–§6.6.
- [ ] Run `cargo test -p mtg-grimoire mcp::` → PASS. Commit `feat(mcp): card_rulings, and get_card counts a card's rulings`.

### Task 7: The prompt and the documentation

**Files:** `apps/desktop/src-tauri/src/mcp/prompts/card_interactions.md`, `docs/reference/local-mcp-server.md`, `docs/reference/data-and-sync.md`, `docs/agent/EXTERNAL_SERVICES.md`, `apps/desktop/src-tauri/CLAUDE.md`.

- [ ] Per §6.7 and §6.8. Run `cargo test -p mtg-grimoire mcp::prompts` (examples still valid). Commit `docs(mcp): rulings in card_interactions and the reference docs`.

### Task 8: Verify, merge `main`, pull request

- [ ] `pnpm verify` → green.
- [ ] `git fetch origin --prune`; check `CORPUS_SCHEMA_VERSION` on `origin/main` (renumber first if 10 is taken); `git merge origin/main`; resolve; `pnpm verify` again on the merge.
- [ ] Push `claude/bold-cerf-egqkqs`; open the PR against `main`, naming what is owed on the owner's Windows machine (a real launch fetching the file; one question through a real client).
