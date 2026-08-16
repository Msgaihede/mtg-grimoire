# Rust module-boundary audit — src-tauri

**Date:** 2026-08-16. **Method:** seven cluster auditors mapped the crate, seven adversarial reviewers tried to refute what they found; 20 candidates proposed, 4 survived. Every line count below is *production* lines (before the trailing `#[cfg(test)] mod tests`), measured on this tree.

**Status:** recommendations #1, #2 and #4 were selected for implementation — see [the plan](../plans/2026-08-16-rust-module-boundary-cleanups.md). #3 (`src/deck_folders.rs`) was considered and **declined**; the reasoning below is kept so it is not re-proposed without new evidence.

> A measurement correction worth keeping: a naive scan for `#[cfg(test)]` undercounts two files badly, because both carry that attribute on *individual items* well above their test module. `scryfall.rs` is **912** production lines (not 357) and `marketplace_feed.rs` is **1 147** (not 94). Count from `mod tests {`, not from the first attribute.

---

## Verdict

The module structure is healthy. Thirty-three modules, nouns mapped cleanly onto files, real load-bearing single seams (`filters.rs`, `sorting.rs`, `schema.rs`'s vocabulary constants, `errors::record`, `deck_audit::record`), and not one genuine monolith by cohesion — `deck.rs` at 3,519 production lines is one noun over one grain, and every seam anyone proposed inside it was refuted on the code. Fifteen of nineteen candidates died on inspection.

What survives is not structure at all: it is **boilerplate that never got a home**, plus **one enum vocabulary that escaped the crate's own discipline**. Two things genuinely need doing (#1 and #2 below, roughly 3 hours together, no behaviour change). #3 is defensible and optional. #4 is marginal and I would skip it.

---

## Recommended (ranked)

### 1. One `with_write`, and move `BUSY` to where the lock lives

Delete eleven copies of the write-lock/BUSY answer and keep one, homed beside `AppState`.

**Now:** five character-identical private definitions — `collection.rs:503-511`, `deck.rs:3170-3178`, `deck_meta.rs:1580-1588`, `deck_theory.rs:497-505`, `wishlist.rs:516-524` — every body being

```rust
match crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
    Some(conn) => f(&conn),
    None => Err(BUSY.to_owned()),
}
```

differing only in whether `BUSY` is imported (`wishlist.rs:14`), owned (`collection.rs:31`), or fully qualified. Six more sites inline the same four lines inside a command body: `card.rs:564-567`, `deck_import.rs:984-987`, `deck_undo.rs:1152-1155` and `:1170-1173`, `marketplace.rs:110-113`, `lib.rs:129-134`. Eleven copies. `collection::BUSY` — a database-lock sentence — is read from nine modules outside `collection.rs`.

**After:** one `pub(crate) fn with_write<T>(state: &Arc<AppState>, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String>` beside `AppState` in `sync.rs`, and `pub const BUSY` moved to `db.rs`. Five private definitions vanish; six inline `match` bodies collapse to `with_write(&state, |c| …)`. Net about **−48 production lines** across twelve files. `collection::with_write_owned` (`collection.rs:526`) stays where it is and wraps the shared one — it is the only variant with extra behaviour (the facet-index `owned` re-read). The three `fn unfinished(e: tauri::Error)` copies (`deck.rs:3182`, `deck_meta.rs:1592`, `deck_theory.rs:508`) stay: their messages differ on purpose.

**For:** eleven copies of one four-line rule is the shape that drifts silently. `db::lock_for` is already the crate's one definition of the *lock*; this is its missing partner for the *answer*. Moving `BUSY` to `db.rs` fixes a genuine misfile — nine modules currently write `crate::collection::BUSY` for a sentence that has nothing to do with the collection.

**Against:** the duplication is self-aware, not stumbled into — `deck_theory.rs:496` says "kept per-module the way every other one in this crate is" and `deck_meta.rs:1578` says the same; `deck_import.rs:970-973` argues its inline copy explicitly. Overturning three written-down decisions to save 48 lines is a real cost. Note also that the earlier proposal to put `with_write` in `db.rs` is **wrong and should stay refuted**: that would give the crate's lowest layer its first dependency on `AppState`. Beside `AppState` is the only defensible home.

**Not touched by this:** `marketplace_feed.rs:650` holds a twelfth reference in a different shape (`FeedError::Busy(crate::collection::BUSY)`), and `oracle_tags::mark_checked` (`oracle_tags.rs:1009`) takes the same lock with a `let-else return` rather than a BUSY answer. Leave both alone.

**Risk / effort:** low; mechanical, 1–2 h, twelve files, no behaviour change. One mandatory doc edit: `src-tauri/CLAUDE.md:181` names `collection::BUSY` verbatim and must change in the same commit.

---

### 2. Bind the finish vocabulary — it has five spellings and nothing checks any two against each other

Move `FINISHES` into `schema.rs` beside the other vocabularies, index everything off it, and add the test that walks the live CHECK.

**Now:** five independent spellings of `nonfoil|foil|etched`:

1. `collection::FINISHES` (`collection.rs:16`), read at `:229`, `:232`, `:759` and by `wishlist.rs:14/221/224`;
2. `sorting::FINISH_LITERALS = ["'nonfoil'", "'foil'", "'etched'"]` (`sorting.rs:213`) — the same list, quoted, in a different module — read at `sorting.rs:240` and `card.rs:89`;
3. three DDL CHECK literals: `schema.rs:553` (`collection_entries.finish`), `:625` (`wishlist_entries.preferred_finish`), `:1241` (`marketplace_prices.finish`);
4. `marketplace_feed::ck_finish` returning bare `"etched"`/`"foil"`/`"nonfoil"` (`marketplace_feed.rs:333-341`);
5. the ManaPool parse tuple (`marketplace_feed.rs:416-418`).

The only thing tying any two together is a **comment** at `schema.rs:1224`. Contrast the discipline the crate applies to every other CHECK-constrained vocabulary: `deck_audit::ADD..DECK` are `schema::AUDIT_KINDS[0..8]` by index (`deck_audit.rs:51-59`), `deck::LIVE`/`THEORY` and `deck_theory::LIVE`/`THEORY` are `DECK_VARIANTS[0]`/`[1]`, `deck_meta::valid_variant` reads `DECK_VARIANTS`, and `KIND_PRIORITY` is pinned to `CATEGORY_KINDS` by a test.

**After:** `pub const FINISHES: [&str; 3]` in `schema.rs` beside `DECK_VARIANTS`/`CATEGORY_KINDS`/`AUDIT_KINDS`, re-exported or aliased from `collection.rs` so no caller changes. `FINISH_LITERALS`, `ck_finish` and the ManaPool tuple all index off it. One new test reading the three CHECK clauses out of `sqlite_master` and comparing them to the constant. Roughly ±0 lines; the deliverable is the binding, not the line count.

**For:** finish is the one vocabulary that escaped a working, in-repo rule. And it is the vocabulary with the worst track record: `FINISH_LITERALS` feeds `printing_price_by_finish_expr`, the builder `src-tauri/CLAUDE.md:156-163` records as having already got a finish wrong once, at a cost of **13,515 foil-only and 892 etched-only printings reading as unpriced**.

**Against:** the win is smaller than the site count suggests, because **the DDL cannot be rewritten**. `schema.rs` is emphatic in the opposite direction — `DECK_CARD_GRAIN`'s doc says "No migration step reads this, or any other grain constant… a step is history the day it ships", and `CATEGORY_KINDS`' doc explains that editing the list would rewrite the CHECK a *fresh* install creates while every upgraded database kept the old one. So the three DDL literals can only ever gain a test. Any proposal to "build the CHECK bodies from the constant" is a rule violation and must be rejected. Also: adding a fourth finish would need a new migration step regardless, so the live hazard is narrower than "five places to find" — it is the unbound `FINISHES`/`FINISH_LITERALS` pair, which is enough on its own.

**Risk / effort:** low. ~1 h for the constant, ~1 h for the tests (the tests are the real deliverable). No CLAUDE.md edit needed — the rule file names `FINISH_LITERALS` (line 158) and never `collection::FINISHES`.

---

### 3. Take the folder half out of `deck_meta.rs` — deck_meta's half only

Optional, and only if you are in `deck_meta.rs` for another reason. Two auditors found this seam and reached opposite verdicts; here is the adjudication.

**Now:** `deck_meta.rs` is 1,841 production lines and declares 18 of the crate's 82 commands, five of which (`deck_folder_list`/`create`/`rename`/`move`/`delete`, `deck_meta.rs:1780-1840`, registered `lib.rs:324-328`) are about a filing tree that *contains* decks rather than anything inside one. The folder cluster is `FOLDER_GONE` (`:102`), `FOLDER_CYCLE` (`:108`), `MAX_FOLDER_DEPTH` (`:115`), `DeckFolderRow` (`:222`), the section `1377-1571` (`folder_row`, `read_folder`, `list_folders`, `create_folder`, `rename_folder`, `move_folder`, `delete_folder`) and the five commands.

**After:** `src/deck_folders.rs`, ~290 production lines by the brief's counting convention — but **only ~198 code lines, of which 58 are command boilerplate**; the substantive logic (`create_folder`, `move_folder`'s hop-budget walk, `delete_folder`'s recursive CTE) is about 100 lines. `deck_meta.rs` falls to ~1,550 and becomes categories-and-tags, one grain, `deck_cards.category_id`/`.tag_id`. Callers change by a module path only.

**For:** the decoupling is total and I verified it line by line. Across `1377-1571` plus the commands, the only things reached from the other 1,080 production lines are `valid_name` (`deck_meta.rs:240`, two calls at `:1409` and `:1435`) and the `with_write`/`unfinished` scaffolding. It touches none of `owning_deck`, `record_category`, `record_tag`, `category_select`, `readback_marketplace`, `category_row`, `tag_row`, `TAG_SELECT`, `DeckCategoryRow`, `DeckTagRow`, or any `deck_undo` helper. Different table, different FK action, no `touch_deck`. The module's own doc at `deck_meta.rs:8-22` spends a paragraph on "folders are not of any deck at all" — the "this half is different" signal.

**Against — and this is why it is third, not first:** the folder noun stays split either way, so the new file's name would promise more than it holds. `deck::set_folder` reads `crate::deck_meta::FOLDER_GONE` (`deck.rs:1134`) and runs its own `SELECT EXISTS(… FROM deck_folders …)` (`deck.rs:1128`); `deck::folder_path` walks `deck_folders` and **cannot move**, because `deck::record_filed` calls it (`deck.rs:1198`) and `record_filed` must stay for `update_deck` and `duplicate_deck` — moving it would create a mutual module edge, strictly worse than today. The three-way contrast in `deck_meta.rs:8-22` is a claim *about categories and tags*; split, it has to be restated in both files. And no CLAUDE.md rule strains today: `deck_folders.parent_id` sits inside the single `ON DELETE` bullet beside three other tables, one rule covering four.

**Two claims from the original proposal are false and should not be used to justify it:** the "two folder-depth budgets maintained separately for the same tree" is deliberate, and `deck_meta.rs:110-115` says so ("kept separately because the two answer to different things"); they stay two constants after the move. And `deck::set_folder` should not move — it writes the `decks` row, calls `touch_deck`, `record_filed` and `read_deck`, and returns a `DeckRow`. (One correction in the split's favour: the feared `pub(crate)` widening of `json_field` is imaginary — it has two uses, both inside `set_folder`, so it never crosses the boundary. The only real visibility cost is `valid_name`.)

**Risk / effort:** medium, 3–4 h including moving the folder tests. **Sequence after #1**, or the new module needs a sixth copy of `with_write`/`unfinished`.

---

### 4. One `Source::Database`/`Kind::Io` failure logger — the minimal version only

Marginal. Do it only if you are already editing `errors.rs`.

**Now:** seven sites wrap `if let Some(conn) = crate::db::lock_for(db, WRITE_LOCK_WAIT) { crate::errors::record(&conn, …) }` — `sync.rs:531-542` (`note_scryfall`), `sync.rs:548-559` (`note_database`), `update.rs:508-530` (`note_github`), `oracle_tags.rs:986-999`, `marketplace_feed.rs:730-743`, `index/lifecycle.rs:53-64` (`note_index_failure`), and `images.rs:568-588`. Two of them are the *same call*: `note_database` and `note_index_failure` both pass `Source::Database` + `Kind::Io`, and `index/lifecycle.rs:38-41` says so in prose.

**After:** keep all the wrappers — they are thin delegates with real per-module classification (`update.rs:509-519` pattern-matches on message text; `oracle_tags` picks `ScryfallApi`; `marketplace_feed` borrows `Database` for want of a source of its own) — and add **one** shared `Source::Database`/`Kind::Io` convenience that `sync.rs` and `index/lifecycle.rs` both call. Saving: **~15–20 production lines**, one genuinely redundant function pair collapsed.

**For:** two provably redundant copies, and `sync.rs:1002-1004` documents a deadlock rule ("take the write lock only if you are not already holding it") currently restated in six doc comments and enforced by nobody.

**Against — and this is most of the case:** the original proposal to "delete `note_database` and `note_index_failure` outright" **cannot be done**. `note_database` has six call sites (`sync.rs:690, 694, 729, 733, 827, 831`) and `note_index_failure` two (`index/lifecycle.rs:198, 227`); replacing eight one-line calls with eight six-argument `errors::note(…)` calls makes the crate longer and less readable. The claimed −45 lines is fiction. Worse, the bound is **not uniform**: `images.rs:579` uses its own `NOTE_LOCK_WAIT` of 200 ms (`images.rs:484`), not `WRITE_LOCK_WAIT` — so the seventh site would either need a wait parameter or stay out, and the divergence the merge is meant to prevent has already happened deliberately. And a crate-public lock-taking `errors::note` slightly *increases* the `sync.rs:1002` deadlock hazard by making that form reachable from a scope holding the guard. (One thing the earlier objection got wrong: `errors.rs` is not a crate-dependency-free leaf — `kind_of` at `errors.rs:103-104` already takes `&crate::scryfall::ScryfallError` in a public signature.)

**Risk / effort:** low, ~30 min for the minimal version. Honestly: skip unless convenient.

---

**Two sub-refactor warts, noted rather than ranked.** `deck_undo::audit_entry` (`deck_undo.rs:1031-1055`) re-spells `deck_audit::list`'s nine-column SELECT and row mapping (`deck_audit.rs:243-266`) verbatim; that wants a `deck_audit::by_id` helper, ~25 lines, not a module boundary. And `card::card_image_uri_inner` (`card.rs:431-458`) re-writes the two `json_extract`s of `images::resolve` (`images.rs:254-263`) with the face pinned to 0, deliberately skipping that function's `is_fetchable` host fence — same query, different policy, and only a doc comment holds the two apart.

---

## Not worth doing

| Proposal | Why not |
| --- | --- |
| Split `deck.rs` at the 2405 banner into `deck/mod.rs` + `deck/read.rs` | `allocate_deck` is called from seven sites, **all in the parent** (`:976, :1859, :1943, :1974, :2062, :2221, :2397`); the region is 98 lines of I/O with an ~18-line greedy walk inside it, not a liftable algorithm; and the residue at ~2,780 lines is still the crate's largest file by 45%. |
| Split `deck.rs`'s five card-write commands into `deck/cards.rs` | The helper and audit-scope disjointness is real, but every write in both halves runs the same eleven-site transaction ritual, and CLAUDE.md states its two fences **once** for the whole module. Splitting puts one rule in two files with the sentence in only one. |
| Split `deck_meta.rs`'s folder half (as originally framed) | Superseded — adjudicated as recommendation #3 above, narrowed to deck_meta's half only. Do not re-propose moving `folder_path` or `set_folder`. |
| Split `card.rs`'s printing-group-by setting out | 112 production lines against a 250 bar, and **zero production Rust readers** outside `card.rs` — the product would immediately be a merge candidate under the same audit. |
| Split `marketplace_feed.rs`'s providers into `feeds.rs` | The design spec pins the shape by file path (`2026-08-12-marketplace-price-feeds-design.md:74`, "One module, `src-tauri/src/marketplace_feed.rs`"); two of the tests assigned to the child are database tests; the child would depend upward on a `FeedError` naming both `reqwest` and `rusqlite`. |
| Split `oracle_tags.rs`'s read path out | 176 raw lines, **90 actual code lines**; its tests seed through the ingest half's fixtures; the residue at ~1,122 lines is unchanged. |
| Split the `/cover/` route out of `images.rs` | 205 lines, ~95 of them code. `serve` (`images.rs:964-987`) tries `parse_cover_path` first and its doc is a statement about the *pair*; a test asserts exactly that pairing (`images.rs:2664-2665`). |
| Move the cover **file ops** from `images.rs` to `deck.rs` | `cover_file` (`images.rs:1036`) is called by both `serve_cover` and `deck.rs`, so it straddles any cut; `encode_cover` exists to match `COVER_VARIANT.dimensions()`, which is images.rs's competence; `deck.rs` is already the largest file. |
| Move `lib.rs`'s nine commands into their modules (proposed twice) | `Arc<update::Updater>` is `manage`d once (`lib.rs:383`) and resolved as `State` at **runtime**, in exactly the five commands proposed for the move — spreading them makes a type mismatch a first-IPC-call failure instead of a one-file fact. `errors.rs` would become lock-taking and `AppState`-aware, falsifying its own module doc. The motivating ratio was 9-of-82, not 9-of-63. |
| Put `with_write` in `db.rs` | Same change as recommendation #1 but the wrong home — it gives the crate's lowest layer a dependency on `AppState` and on a user-facing sentence. Use #1's home (beside `AppState`) instead. |
| Move `update.rs`'s three `app_meta` accessors out | 19 production lines. A new `app_meta.rs` would be the crate's 34th file holding two `query_row`s and deciding nothing; `db.rs` would gain its first table name and first app string. |
| Give all the `app_meta` preferences one home | The headline count is false: 8 callers outside `update.rs`, 8 inside; `clear_app_meta` is private with no external caller and would widen for nobody. It also requires renaming the `marketplace` module, which `src-tauri/CLAUDE.md:170` names verbatim. |
| One `unix_now` / one staleness predicate for the four services | 1–3 line pure bodies. The future-stamp rule is written down four times **and tested four times**; collapsing to one shared test is strictly less protection per module, and a shared `due(last, now, interval, force)` is worse at every call site (`force` is meaningless for two of the four). |
| Move `AppState` + the four lock delegates out of `sync.rs` | ~70 production lines against a 250 bar, and a ~45-site rename across 18 files whose whole product is "a module whose entire content is a name". |
| Embed `CardFilters` in `SearchRequest` instead of restating it | Refuted by the compiler: `SearchRequest::card_filters` (`search.rs:112-124`) is an **exhaustive** struct literal, so a twelfth filter field is a missing-field error, not a silent no-op. Cost would be 85 construction sites rewritten. |

---

## Already exemplary

Point any change at these.

- **`src/filters.rs`** (388 prod, 51 references from 7 modules) — alias-parameterised (`push_card_filters(p, f, "c", Some("e"))`), so search, collection, wishlist and the facet index filter cards identically without any of them owning the others' SQL. Its module doc states the one invariant the whole builder rests on: a fragment and its parameter are pushed together, because `?` binds by position.
- **`src/sorting.rs`** (347 prod, 140 references from 7 modules) — `price_expr` / `printing_price_expr` / `printing_price_by_finish_expr` are the only price builders in the crate, and `PRICE_HOLE` + `sorts_for` make "wired for one marketplace, forgotten for another" structurally impossible. That is why `src-tauri/CLAUDE.md:156` can assert "every price in the crate is built by `sorting::price_expr`" as a fact rather than a hope.
- **`schema.rs`'s vocabulary constants, read by index and never respelled** — `deck_audit::ADD = schema::AUDIT_KINDS[0]` and eight siblings (`deck_audit.rs:51-59`), `deck::LIVE = DECK_VARIANTS[0]`, `deck_theory::LIVE`/`THEORY`, `deck_meta::valid_variant`, and `KIND_PRIORITY` pinned to `CATEGORY_KINDS` by a test. Recommendation #2 is nothing more than extending this to the one vocabulary that escaped it. The pattern is **constant plus a test that walks the live CHECK** — never a DDL built from a constant.
- **`src/index/`** (`mod` / `bitset` / `facets` / `lifecycle`, 1,144 prod over 4 files) — the in-repo model of a good split: a parent owning the struct, a leaf with the pure data structure, a leaf with the algorithm, a leaf with the publication race. Its one cross-directory import (`facets.rs` → `search::SearchRequest`) is correct, because a facet answers about the very request the search runs.
- **`src/legalities.rs`** (112 prod, five production callers) — the shape that must never be merged: a tiny module holding one frozen fact, that bit positions are stored data and the key order can never be re-sorted. Same category as `marketplace.rs` (118 prod), which is a module because it *decides* something, not because of its size.
- **`errors::record`'s contract** — returns `()`, called inside the caller's transaction, so it can never fail the thing it describes and a rolled-back write leaves no history of having happened.
- **The TS/Rust boundary** is policed harder than most codebases manage: `marketplace.rs` stores an id and refuses to know its label; `oracle_tags.rs` stores slugs and no category names; `deck.rs` stores `default_category_id` and knows nothing about what Auto *does*; `format_specs` is rows, not branches. Three known strains, all documented at their sites and none worth restructuring: `card.rs`'s `PRINTING_GROUP_BY_MODES` whitelists a TypeScript vocabulary while `deck::set_view_state` two modules over deliberately stores the reader's word verbatim (both sites argue their own case as the rule, and both cannot be right); `deck::KIND_PRIORITY` is a domain preference compiled into the allocator; and `deck_import.rs`'s `MATCH_ORDER`/`fold_match` is ~700 lines of Rust ranking that `fold_match` "repeats in Rust and may never disagree" — a duplication with TypeScript no `cargo test` can catch.