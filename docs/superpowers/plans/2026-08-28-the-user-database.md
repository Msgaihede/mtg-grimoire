# The User Database — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the reader's own data in a file of its own, so that losing the corpus, rebuilding the corpus, or discarding a corrupt corpus never touches the collection.

**Architecture:** One connection, two files. `data/user.db` is `main` — the fifteen tables nothing outside this app can produce again. `data/corpus.db` is `ATTACH`ed as `corpus` — everything a feed or this app's own migration ladder can rebuild with no user input. **SQLite resolves an unqualified table name into the attached database**, so none of the ~136 Tauri commands and none of their SQL changes. What does change is every place that names a *file* rather than a table: the pragmas, the staging DDL, the vacuum, the four extra connections, and the one transaction that turns out to write to both.

**Tech Stack:** Rust 2021, `rusqlite 0.40` with `bundled` + `hooks`. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-08-27-cross-platform-design.md`](../specs/2026-08-27-cross-platform-design.md) §5.4 and §7 — this is the storage split those two sections both assume and neither builds.

---

## Everything below was measured on 2026-08-28, not reasoned about

Two instruments. A `node:sqlite` read-only script against the live development database
(`src-tauri/target/debug/data/mtg.db`, **788 406 272 B, 192 482 pages of 4 096, `user_version` 25,
`auto_vacuum` 2, 116 843 cards**), and a throwaway `rusqlite 0.40.2` binary in the scratch
directory driving real files. **The live database was never modified**; the conversion ran against
a byte copy.

### The nine facts the design rests on

| # | Measured | Consequence |
| --- | --- | --- |
| 1 | An unqualified `SELECT`, `INSERT`, `UPDATE` and `DELETE` all resolve into the attached database when the table exists only there. `INSERT INTO cards …` returned `Ok(1)` and the row landed in `corpus.cards`. | **No command needs rewriting.** This is the whole reason the split is affordable. |
| 2 | When a name exists in **both** files, unqualified resolves to `main`. Two `decks` tables, `SELECT count(*) FROM decks` answered `main`'s. | A shadow table in the corpus is silently invisible. The registry test in Task 1 is what stops one being created. |
| 3 | An `ATTACH`ed file inherits **neither** `journal_size_limit` **nor** `synchronous`. Against the real database: `corpus.journal_size_limit = -1` where `main` read `67108864`, and `corpus.synchronous = 2` (FULL) where `main` read `1` (NORMAL). | **The 64 MB WAL ceiling is lost on the only file big enough to need it** — the corpus is what writes an 857 MB journal during an ingest. Task 2. |
| 4 | `ATTACH` on a path that does not exist **creates the file**, and a file created that way opens on `journal_mode = delete` and `auto_vacuum = 0`. | Both pragmas must be set on the attached schema, `auto_vacuum` **before** WAL materialises the file — `db::open`'s existing ordering comment, now needed twice. |
| 5 | `PRAGMA wal_checkpoint(TRUNCATE)` with **no** schema checkpoints every attached database. Both `-wal` files measured at 0 bytes afterwards. | The exit checkpoint keeps working unchanged. |
| 6 | `PRAGMA freelist_count`, `PRAGMA page_count`, `PRAGMA auto_vacuum`, `PRAGMA incremental_vacuum` and bare `VACUUM` all mean **`main`**. After the split: `page_count` unqualified `323`, `corpus.page_count` `192 149`. | **The whole of `maintenance.rs` silently becomes a no-op on a 1.3 MB file.** Task 4. |
| 7 | The `update_hook` **does** fire for attached tables and **does** report the schema name — `("corpus", "cards")`. It does **not** fire for `WITHOUT ROWID` tables: an insert into `corpus.image_cache` produced no callback and the row was there. | The mirror keeps working. The cross-file fence works, with a named blind spot. Task 6. |
| 8 | A transaction spanning both files is accepted; `ROLLBACK` reverted both, `COMMIT` committed both. SQLite makes **no atomicity guarantee** across attached databases in WAL mode. | A crash mid-commit can leave one file applied and the other not. Task 5 closes the one production site. |
| 9 | `ALTER TABLE main.x RENAME TO corpus.y` is a **syntax error**, and an external-content FTS5 table resolves `content='cards'` in **its own schema** — `main.shadow_fts` created fine and its `rebuild` failed with `no such table: main.cards`. | `cards_fts` must be created in the corpus, and the staging rename must happen inside one schema. Task 4. |

### The conversion, timed on a byte copy of the real 788 MB database

| Step | Time |
| --- | --- |
| `ATTACH` a fresh `user.db` + its four pragmas | **6.72 ms** |
| Create 15 tables and their indexes, copy 3 679 rows | **13.35 ms** |
| `DROP` the same 15 tables out of the corpus | **10.71 ms** |
| `PRAGMA incremental_vacuum`, 333 chunks | **29.88 ms** |
| **Whole conversion, open to close** | **294 ms** |

**`user.db` = 1 323 008 B (323 pages). `corpus.db` = 787 042 304 B.** The reader's entire
authored history is **0.17 %** of the file it currently shares. `foreign_key_check` over the copy
returned zero violations.

Reopening afterwards — `Connection::open(user.db)` plus `ATTACH corpus.db` — took **5.4 ms**, and
the queries showed no cross-file penalty worth a sentence: `count(*) FROM cards` 4.2 ms,
`collection_entries JOIN cards` (275 rows) 1.19 ms, `deck_cards JOIN cards` (611 rows) 0.62 ms,
an FTS5 `MATCH` 0.33 ms, a filtered cross-file join 2.67 ms.

---

## Which file is `main`, and what that costs

**Decision: the USER file is `main`, the corpus is attached.** Both directions were costed against
the measurements above, and the two are not symmetric.

**Everything argues for corpus-as-`main` except one thing, and that one thing is decisive.**

Corpus-as-`main` is cheaper by a wide margin. A bare `CREATE TABLE cards_staging` lands in `main`
(fact 1's other half), so all ten staging tables across four feeds would need no change.
`create_fts` would create `cards_fts` beside `cards` for free (fact 9). `ALTER TABLE cards_staging
RENAME TO cards` would stay in one schema. Every unqualified pragma in `maintenance.rs` would keep
meaning the gigabyte it was written about (fact 6). That is roughly forty sites this plan has to
touch which corpus-as-`main` would leave alone.

**Against all of it: you cannot `DETACH main`.** The third consequence in the brief — a corrupt
corpus cannot be discarded without risking the only copy of the collection — is *only* fixed if
the corpus is the detachable one. With the corpus attached, discarding it is `DETACH`, delete the
file, `ATTACH` again, re-sync, and the measurement says the whole reopen costs 5.4 ms. With the
corpus as `main`, discarding it means closing every connection in the process, including the two
in `AppState` that a running window is holding, and reopening onto a different file — which is
the same global, destructive, everything-at-once operation the split exists to abolish. A design
that makes the *rebuildable* file the immovable one has the polarity backwards.

Two smaller reasons point the same way. A file that is `main` is the one `Connection::open` names,
so its absence is the failure the app already has a message for; the attached one is created
silently on a bad path (fact 4), which is the right failure for a corpus and the wrong one for a
collection. And `PRAGMA user_version` unqualified means `main` — the user file's version is the one
that gates sync compatibility, and it should be the one an unqualified read returns.

**What it costs, itemised, so nobody is surprised in Task 4:** every corpus `CREATE`, `DROP`,
`ALTER` and `PRAGMA` must be schema-qualified — ten staging tables, `cards_fts` and its four
shadow tables, five `swap_*` functions, `prepare_database`'s leftover sweep, and six pragma sites
in `maintenance.rs`. Every one of those is a *silent* failure if missed: the table simply appears
in the user's file and the app keeps working until somebody looks. **The single test in Task 4 Step
5 — assert `main.sqlite_master` and `corpus.sqlite_master` each hold exactly their own side, after
a full simulated sync — is what turns all forty into one red build.** Nothing else in this plan is
load-bearing in the same way.

---

## How the ladder splits

`schema.rs` is one `SCHEMA_VERSION: i64 = 26` and one `migrate()` today, 552 KB of migration
history with 102 in-memory test setups building old databases by hand. **None of that history is
rewritten.** Rewriting a rung is forbidden here for the reason `CARDS_COLUMNS` states: a step is
history, and a step edited today changes what a *fresh* install created yesterday.

So the ladder is **frozen, not split**:

- `LEGACY_SINGLE_FILE_VERSION: i64 = 26` — the last shape that was one file. Today's `migrate` is
  renamed `migrate_single_file` and never runs again except during conversion.
- `USER_SCHEMA_VERSION: i64 = 27` — the user file continues the existing number line. Its history
  matters, it can never be re-run, and 27 is the rung that says "this file has been split out".
- `CORPUS_SCHEMA_VERSION: i64 = 1` — the corpus starts a number line of its own, deliberately
  incomparable with the user's. A corpus version answers "is this file's *shape* what this build
  expects", and a corpus rung is allowed to give up and rebuild, because the data behind it is a
  download. A user rung never may. Two numbers that mean different things must not share a scale
  where `user 29, corpus 27` invites somebody to subtract them.

**A fresh install goes through the conversion too**, and that is the point rather than an accident:
`prepare_database` builds a single legacy file at 26 and splits it, so the riskiest code in this
plan is the code every test run and every first launch executes. For an empty database that is a
few milliseconds; for the real one it is the 294 ms measured above.

---

## Which table goes where, and the one question that decides it

**Can this table be produced again, with no user input, from a feed or from this app's own
migration ladder?** Yes → corpus. No → user.

That is *not* the same line as "does it sync", and conflating the two is the mistake this plan
inherited and corrected. `deck_undo` does not sync (spec §7.3) and is unquestionably the user's.
`app_meta` splits per key *for sync*, and does not split at all *for storage*: `scryfall_penalty_until`
in a file the app is allowed to throw away would turn a Scryfall lockout into something a corpus
rebuild shakes off, which is the exact failure the row exists to prevent, and `mirror_root` is a
folder the reader chose.

**User — 15 tables (1 323 008 B measured):** `decks`, `deck_folders`, `deck_categories`,
`deck_tags`, `deck_cards`, `deck_audit`, `deck_undo`, `collection_folders`, `collection_entries`,
`wishlist_folders`, `wishlist_entries`, `muted_tags`, `app_meta`, `error_log`, `card_migrations`.

**Corpus — 25 tables:** `cards`, `cards_fts` and its four shadow tables (`cards_fts_config`,
`cards_fts_data`, `cards_fts_docsize`, `cards_fts_idx`), `sets`, `sync_meta`, `format_specs`,
`image_cache`, `marketplace_prices`, `marketplace_feed_meta`, the five oracle-tag tables, the five
art-tag tables, and the three combo tables.

Three of those placements are corrections to the brief and each was checked against a live
database rather than against a `CREATE TABLE` grep:

- ⚠️ **`deck_allocations` does not exist.** Dropped at v25. It is not in `sqlite_master`.
- ⚠️ **`muted_tags` is the reader's and the brief's list omits it.** `(namespace, tag_id, slug,
  muted_at)`, `WITHOUT ROWID`. A mute is a decision a person made about a tag; no feed reproduces
  it. It is also the **one user table the update hook cannot see** (fact 7).
- ⚠️ **`card_migrations` is the reader's, and this is a correctness fix rather than a filing
  preference.** Its rows are Scryfall's, but the table's *job* is "which of these have I already
  applied to my own collection". `reconcile::apply`'s comment states the stake: applying a *fold*
  twice doubles a quantity, and the `SELECT 1 FROM card_migrations WHERE id = ?1` check is the
  only thing standing between a re-poll and a collection that grows on its own. A corpus rebuild
  that emptied this table would replay every migration against rows that already have them.
  2 581 rows, 397 312 B plus a 143 360 B index — a third of the user file, and worth it.

`format_specs` goes to the corpus even though no feed produces it: the migration ladder seeds it,
so a rebuilt corpus has it back before the reader can notice, and no user table declares a foreign
key to it (checked — `decks.format_key` is a soft reference).

**Every foreign key in the database is user→user.** All fourteen were listed off the live file:
`collection_entries.folder_id`, `collection_folders.deck_id`, `collection_folders.parent_id`,
`deck_audit.deck_id`, `deck_cards.{tag_id,category_id,deck_id}`, `deck_categories.deck_id`,
`deck_folders.parent_id`, `deck_undo.{deck_id,audit_id}`, `decks.folder_id`,
`wishlist_entries.folder_id`, `wishlist_folders.parent_id`. Nothing crosses. The v26 corpus adds
`combo_cards.combo_id → combos.id`, corpus→corpus. **A cross-file key would be a trap rather than
an error**: `CREATE TABLE` accepts it and only the first `INSERT` fails, with `no such table:
main.cards`. Task 1's registry test is where that gets caught.

---

## Global Constraints

Copied from the spec and the repo's `CLAUDE.md`; every task's requirements implicitly include these.

- `npm run verify` before every commit. It does **not** run `cargo fmt` or `clippy`; CI does, and
  those are the only reds a fully green verify can produce. Run `cargo fmt` and
  `cargo clippy --all-targets -- -D warnings` in `src-tauri/` before each commit too.
- **Never run two verifies at once** — concurrent runs fake ~18 Rust schema failures.
- **No new dependencies.** `rusqlite`'s `hooks` feature is already on.
- `clippy` caps function arguments at 7.
- **Never hand-write rows into `cards` or `sync_meta`.** Tests build their fixtures through
  `crate::schema` helpers.
- **`data/` is the user's and is never committed.** The conversion tests work on copies in
  `std::env::temp_dir()` and delete them.
- **Do not rewrite a rung of the existing ladder.** Rungs 1–26 are history and are frozen at Task 1.
- Commit messages use `feat:` / `fix:` / `chore:` / `test:` / `refactor:`.

---

## What this PR deliberately does not do

**The web target is not wired here.** The split's web consequences are settled and written down so
the wasm PR does not have to rediscover them, but no `cfg(target_family = "wasm")` code lands in
this plan — there is no wasm build in this repo's suite yet, so a wasm task would have no mutation
step that could go red, and an unrunnable task is worse than a documented decision.

- **`opfs-sahpool` counts FILES, and the split takes the app from three slots to five.** Today:
  one database, one journal, one temp file for a `VACUUM`. After: two databases, two journals, one
  temp. The spike's four probes all build with `OpfsSAHPoolCfgBuilder::…initial_capacity(8)`
  (`spike/probe{2,3,4}/src/lib.rs`), which still holds with three slots spare. **Do not lower it,
  and raise it to 10 before a third database is ever attached** — a pool that runs out answers
  `SQLITE_FULL`, which reads to a user exactly like a corrupt database. This number is reasoned
  from the spike's configuration, not measured; the wasm PR must measure it.
- **There is no WAL on web** (spec §5.1: `journal_mode = WAL` answers `delete` on sahpool). Every
  per-schema pragma this plan adds must therefore tolerate the answer it did not ask for, which
  Task 2 handles by asserting the *outcome* rather than the return value.
- **One connection, one tab** (spec §5.2) is unaffected: a single connection may `ATTACH` several
  files, which is fact 1.

**The Danger Zone gets no new button.** The capability the split buys — throw the corpus away and
keep the collection — is proved as a *property* in Task 4 Step 4 rather than as an unwired command.
A "Rebuild the card database" row is the frontend's own PR, and it will find the Rust side already
true.

---

### Task 1: The registry — one written-down answer to "which file is this table in?"

**Files:**
- Modify: `src-tauri/src/schema.rs` — add `Side`, `TABLES`, the three version constants; rename
  `migrate` to `migrate_single_file` and update its call sites
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/maintenance.rs` — the `schema::migrate` call sites
- Test: inline `#[cfg(test)] mod tests` in `src-tauri/src/schema.rs` (house style)

**Interfaces:**
- Produces: `schema::Side`, `schema::TABLES: &[(&str, Side)]`, `schema::side_of(&str) -> Option<Side>`,
  `schema::LEGACY_SINGLE_FILE_VERSION`, `schema::USER_SCHEMA_VERSION`, `schema::CORPUS_SCHEMA_VERSION`,
  `schema::migrate_single_file(&Connection)`.
- Consumes: nothing.

> ⚠️ **`SCHEMA_VERSION` is referenced by name throughout `schema.rs`'s own tests** —
> `grep -c SCHEMA_VERSION src-tauri/src/schema.rs` is the authority on how many, and the number is
> not written down here for the reason `CLAUDE.md` gives: it is a fact about a tree and every open
> branch has a different one. Re-point every one of them to `LEGACY_SINGLE_FILE_VERSION` and delete
> the old constant — they are assertions about the frozen ladder, which is exactly what the new
> name says.

- [x] **Step 1: Write the failing test**

Add to `schema.rs`'s test module. It fails now because `TABLES` does not exist.

```rust
/// Every table a migrated database creates is on exactly one side, named here on purpose.
///
/// The point is the *next* table: one added by a later rung without a line in `TABLES`
/// turns this red rather than landing in whichever file the DDL happened to be unqualified
/// in. `mirror::watch::every_table_in_the_schema_has_been_decided_about` is the same shape
/// for the same reason, and this is its storage twin.
#[test]
fn every_table_is_on_exactly_one_side() {
    let conn = Connection::open_in_memory().unwrap();
    migrate_single_file(&conn).unwrap();

    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap();
    let live: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();

    let named: Vec<&str> = TABLES.iter().map(|(n, _)| *n).collect();
    let mut sorted = named.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), named.len(), "a table is named twice in TABLES");

    let live_refs: Vec<&str> = live.iter().map(String::as_str).collect();
    let mut expected = named.clone();
    expected.sort_unstable();
    assert_eq!(
        live_refs, expected,
        "TABLES and the migrated schema disagree; add the new table to TABLES on purpose"
    );
}

/// The user side, spelled out. A table moving between the two files is a data migration,
/// never a diff nobody noticed.
#[test]
fn the_user_side_is_the_fifteen_tables_no_feed_can_rebuild() {
    let mut user: Vec<&str> = TABLES
        .iter()
        .filter(|(_, s)| *s == Side::User)
        .map(|(n, _)| *n)
        .collect();
    user.sort_unstable();
    assert_eq!(
        user,
        [
            "app_meta",
            "card_migrations",
            "collection_entries",
            "collection_folders",
            "deck_audit",
            "deck_cards",
            "deck_categories",
            "deck_folders",
            "deck_tags",
            "deck_undo",
            "decks",
            "error_log",
            "muted_tags",
            "wishlist_entries",
            "wishlist_folders",
        ]
    );
}

/// No foreign key may cross the split. SQLite accepts the `CREATE TABLE` and fails only on
/// the first `INSERT`, with `no such table: main.cards` — a trap that would ship.
#[test]
fn no_foreign_key_crosses_the_two_sides() {
    let conn = Connection::open_in_memory().unwrap();
    migrate_single_file(&conn).unwrap();

    for (table, side) in TABLES {
        let mut stmt = conn
            .prepare(&format!("PRAGMA foreign_key_list({table})"))
            .unwrap();
        let targets: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(2))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        for target in targets {
            let other = side_of(&target)
                .unwrap_or_else(|| panic!("{table} references unknown table {target}"));
            assert_eq!(
                other, *side,
                "{table} ({side:?}) declares a foreign key to {target} ({other:?}); \
                 SQLite cannot enforce one across attached databases"
            );
        }
    }
}
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test schema::tests::every_table_is_on_exactly_one_side 2>&1 | tail -5`
Expected: a compile error — `cannot find value TABLES in this scope`. A compile error *is* the red
here; there is no version of this that runs and passes.

- [x] **Step 3: Implement**

Add near the top of `schema.rs`, beside `SCHEMA_VERSION`:

```rust
/// The last shape of the database that was one file.
///
/// [`migrate_single_file`] climbs to exactly this and stops. It is frozen: no rung of that
/// ladder is ever edited again, for [`CARDS_COLUMNS`]'s reason — a migration step is history,
/// and a step edited today changes what a *fresh* install created yesterday.
pub const LEGACY_SINGLE_FILE_VERSION: i64 = 26;

/// `user.db`'s version, continuing the number line the single file was on.
///
/// 27 is the rung that *is* the split: a database carrying it has had its corpus taken out.
/// The user's ladder can never restart, because its rungs describe rows nothing else can
/// produce.
pub const USER_SCHEMA_VERSION: i64 = 27;

/// `corpus.db`'s version, on a number line of its own.
///
/// Deliberately incomparable with [`USER_SCHEMA_VERSION`]: the two answer different questions.
/// A user version is "what has been done to rows that exist nowhere else". A corpus version is
/// "is this file's shape what this build expects", and a corpus rung is *allowed* to give up
/// and rebuild, because what is behind it is a download. Sharing a scale would invite somebody
/// to subtract them.
pub const CORPUS_SCHEMA_VERSION: i64 = 1;

/// Which of the two files a table lives in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// The reader authored it. Nothing outside this app can produce it again, and losing it
    /// is losing it.
    User,
    /// A feed or this app's own migration ladder can produce it again with no user input, for
    /// the price of a download.
    Corpus,
}

/// Every table in the schema and the file it belongs in.
///
/// **The question is "can this be produced again with no user input?", and it is not the same
/// question as "does this sync"** — `deck_undo` does not sync and is unquestionably the
/// reader's; `app_meta` splits per key for sync and does not split at all for storage.
///
/// Written as a list rather than a rule so that a table added by a later rung is a red test
/// with an obvious remedy, rather than a table that quietly lands in whichever file its DDL
/// was unqualified in. `every_table_is_on_exactly_one_side` is what keeps it honest.
pub const TABLES: &[(&str, Side)] = &[
    // ---- the reader's ----
    ("app_meta", Side::User),
    // Scryfall's rows, but the table's *job* is "which of these have I applied to my own
    // collection". A corpus rebuild that emptied it would re-apply every fold and double
    // quantities — `crate::reconcile::apply` says so at its `SELECT 1 FROM card_migrations`.
    ("card_migrations", Side::User),
    ("collection_entries", Side::User),
    ("collection_folders", Side::User),
    ("deck_audit", Side::User),
    ("deck_cards", Side::User),
    ("deck_categories", Side::User),
    ("deck_folders", Side::User),
    // One app-wide list keyed on `name_key` since v21 — no `deck_id`.
    ("deck_tags", Side::User),
    ("deck_undo", Side::User),
    ("decks", Side::User),
    // Per-device and never synced, but nothing rebuilds it either — and it is the record of
    // *why* somebody might be about to throw the corpus away.
    ("error_log", Side::User),
    // A decision a person made about a tag. `WITHOUT ROWID`, so the update hook cannot see it
    // — see `crate::mirror::watch::install_hook`.
    ("muted_tags", Side::User),
    ("wishlist_entries", Side::User),
    ("wishlist_folders", Side::User),
    // ---- rebuildable ----
    ("art_tag_illustrations", Side::Corpus),
    ("art_tag_meta", Side::Corpus),
    ("art_tag_parents", Side::Corpus),
    ("art_taggings", Side::Corpus),
    ("art_tags", Side::Corpus),
    ("cards", Side::Corpus),
    // FTS5's own four shadow tables plus the virtual table. They must sit beside `cards`:
    // an external-content index resolves `content='cards'` in *its own schema*.
    ("cards_fts", Side::Corpus),
    ("cards_fts_config", Side::Corpus),
    ("cards_fts_data", Side::Corpus),
    ("cards_fts_docsize", Side::Corpus),
    ("cards_fts_idx", Side::Corpus),
    ("combo_cards", Side::Corpus),
    ("combo_meta", Side::Corpus),
    ("combos", Side::Corpus),
    // Seeded by the ladder rather than by a feed, which is a cheaper rebuild still. No user
    // table declares a key to it — `decks.format_key` is a soft reference.
    ("format_specs", Side::Corpus),
    ("image_cache", Side::Corpus),
    ("marketplace_feed_meta", Side::Corpus),
    ("marketplace_prices", Side::Corpus),
    ("oracle_tag_cards", Side::Corpus),
    ("oracle_tag_meta", Side::Corpus),
    ("oracle_tag_parents", Side::Corpus),
    ("oracle_taggings", Side::Corpus),
    ("oracle_tags", Side::Corpus),
    ("sets", Side::Corpus),
    ("sync_meta", Side::Corpus),
];

/// Which file `table` belongs in, or `None` for a name the schema does not create — a staging
/// table, or a typo.
pub fn side_of(table: &str) -> Option<Side> {
    TABLES.iter().find(|(n, _)| *n == table).map(|(_, s)| *s)
}
```

Then rename the function at `schema.rs:881`:

```rust
/// The single-file ladder, frozen at [`LEGACY_SINGLE_FILE_VERSION`].
///
/// **Nothing calls this to prepare a running database any more.** It is reached from exactly
/// two places: `split::convert` brings a pre-split `mtg.db` up to 26 before taking it apart,
/// and this file's own tests build old databases by hand to climb it. Its rungs are history.
pub fn migrate_single_file(conn: &Connection) -> rusqlite::Result<()> {
```

Update `prepare_database` (`schema.rs:3099`) to call `migrate_single_file`, and the two
`schema::migrate` call sites outside this file — `maintenance.rs`'s tests. Re-point the 18
`assert_eq!(version, SCHEMA_VERSION)` assertions in `schema.rs`'s tests to
`LEGACY_SINGLE_FILE_VERSION` and delete `SCHEMA_VERSION`.

- [x] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test schema:: 2>&1 | tail -8`
Expected: every pre-existing schema test still passes, plus the three new ones. **Report the number
of tests the filter selected** — a filter that matches nothing exits 0 and "expected PASS" would
prove nothing.

- [x] **Step 5: Mutate to prove the registry bites**

Delete the `("muted_tags", Side::User)` line. `every_table_is_on_exactly_one_side` must FAIL on the
list comparison. Then put it back and change it to `Side::Corpus`;
`the_user_side_is_the_fifteen_tables_no_feed_can_rebuild` must FAIL. Then add a
`REFERENCES cards(id)` to a scratch copy of `deck_cards`'s DDL in a throwaway rung;
`no_foreign_key_crosses_the_two_sides` must FAIL naming `cards`. Revert all three. **If any
mutation survives, STOP and report** — a registry that cannot go red is a comment.

- [x] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/schema.rs src-tauri/src/lib.rs src-tauri/src/maintenance.rs
git commit -m "refactor(schema): name which file every table belongs in, and freeze the ladder

TABLES is one written-down answer to a question the code is about to start asking forty
times. Nothing splits yet - migrate is renamed migrate_single_file and still builds one
file - but three facts are now assertions rather than intentions: every table is on exactly
one side, the user side is the fifteen tables no feed can rebuild, and no foreign key
crosses. SQLite cannot enforce a key across attached databases and accepts the CREATE
anyway, failing only on the first INSERT.

deck_allocations does not exist (dropped v25), muted_tags is the reader's, and
card_migrations is too - a corpus rebuild that emptied it would re-apply every fold."
```

---

### Task 2: `db` opens a pair — two files, four pragmas each, one connection

**Files:**
- Modify: `src-tauri/src/db.rs`
- Test: inline `#[cfg(test)] mod tests` in `src-tauri/src/db.rs`

**Interfaces:**
- Produces: `db::USER_DB`, `db::CORPUS_DB`, `db::LEGACY_DB`, `db::CORPUS`,
  `db::open_write(&Path) -> rusqlite::Result<Connection>`,
  `db::open_read(&Path) -> rusqlite::Result<Connection>`,
  `db::attach_corpus(&Connection, &Path) -> rusqlite::Result<()>`.
- Consumes: nothing.
- `db::open` and `db::open_read_only` **stay**, taking a file path. `open_write`/`open_read` are
  built on them, and `split::convert` needs the single-file versions.

> ⚠️ **`auto_vacuum` before `journal_mode`, on the attached schema too.** `db::open`'s existing
> comment says why for `main`: once WAL has materialised the file, `auto_vacuum` is a no-op only a
> full `VACUUM` can apply. Measured on a freshly-attached file: `journal_mode` reads `delete` and
> `auto_vacuum` reads `0` until both are set, in that order.

> ⚠️ **A read-only connection must attach and configure nothing.** `ATTACH` on a
> `SQLITE_OPEN_READ_ONLY` handle returns `Ok` and the attached database is read-only too —
> measured, an `INSERT` into it answered `SQLITE_READONLY`. Setting `journal_mode` on it would
> fail, and it must not: this is the handle every search uses.

- [x] **Step 1: Write the failing test**

```rust
/// The four pragmas `db::open` sets are properties of a *file*, and an attached file
/// inherits none of the two that matter. Measured against the real 788 MB database:
/// `corpus.journal_size_limit` read -1 where main read 67108864, and `corpus.synchronous`
/// read 2 (FULL) where main read 1 (NORMAL). The corpus is the file that writes an 857 MB
/// journal during an ingest, so losing the ceiling loses it on the only file that needs it.
#[test]
fn an_attached_corpus_gets_the_same_pragmas_as_main() {
    let dir = scratch("pair");

    let conn = open_write(&dir).unwrap();

    let main_mode: String = conn
        .query_row("PRAGMA main.journal_mode", [], |r| r.get(0))
        .unwrap();
    let corpus_mode: String = conn
        .query_row("PRAGMA corpus.journal_mode", [], |r| r.get(0))
        .unwrap();
    let corpus_limit: i64 = conn
        .query_row("PRAGMA corpus.journal_size_limit", [], |r| r.get(0))
        .unwrap();
    let corpus_sync: i64 = conn
        .query_row("PRAGMA corpus.synchronous", [], |r| r.get(0))
        .unwrap();
    let corpus_vacuum: i64 = conn
        .query_row("PRAGMA corpus.auto_vacuum", [], |r| r.get(0))
        .unwrap();
    let fk: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();

    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(main_mode.to_lowercase(), "wal");
    assert_eq!(corpus_mode.to_lowercase(), "wal", "the corpus must be WAL too");
    assert_eq!(corpus_limit, JOURNAL_SIZE_LIMIT, "the WAL ceiling must reach the corpus");
    assert_eq!(corpus_sync, 1, "the corpus must be synchronous = NORMAL");
    assert_eq!(corpus_vacuum, 2, "auto_vacuum must be set before WAL materialises the file");
    assert_eq!(fk, 1, "foreign_keys is per-connection, not per-schema");
}

/// Both files exist afterwards, and they are two files. `ATTACH` on a path that does not
/// exist creates it silently, which is the right failure for a rebuildable corpus and would
/// be the wrong one for a collection — which is why the user file is the one `open` names.
#[test]
fn open_write_creates_both_files_and_they_are_distinct() {
    let dir = scratch("pair-files");

    let conn = open_write(&dir).unwrap();
    conn.execute_batch(
        "CREATE TABLE t (v TEXT);
         CREATE TABLE corpus.u (v TEXT);
         INSERT INTO t VALUES ('user');
         INSERT INTO u VALUES ('corpus');",
    )
    .unwrap();
    let unqualified: String = conn.query_row("SELECT v FROM u", [], |r| r.get(0)).unwrap();
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())).unwrap();
    drop(conn);

    let user_there = dir.join(USER_DB).is_file();
    let corpus_there = dir.join(CORPUS_DB).is_file();
    let user_len = std::fs::metadata(dir.join(USER_DB)).unwrap().len();
    let corpus_len = std::fs::metadata(dir.join(CORPUS_DB)).unwrap().len();
    let _ = std::fs::remove_dir_all(&dir);

    assert!(user_there && corpus_there);
    assert!(user_len > 0 && corpus_len > 0);
    // Fact 1: an unqualified name resolves into the attached database.
    assert_eq!(unqualified, "corpus");
}

/// The read handle sees both files and can write to neither. It is what every search uses,
/// and a handle that *could* write is a handle that can stall the ingest it exists to run
/// alongside — `open_read_only`'s reason, now doubled.
#[test]
fn the_read_handle_sees_both_files_and_writes_to_neither() {
    let dir = scratch("pair-read");
    let w = open_write(&dir).unwrap();
    w.execute_batch(
        "CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('user');
         CREATE TABLE corpus.u (v TEXT); INSERT INTO u VALUES ('corpus');",
    )
    .unwrap();

    let r = open_read(&dir).unwrap();
    let user: String = r.query_row("SELECT v FROM t", [], |row| row.get(0)).unwrap();
    let corpus: String = r.query_row("SELECT v FROM u", [], |row| row.get(0)).unwrap();
    let write_user = r.execute("INSERT INTO t VALUES ('nope')", []);
    let write_corpus = r.execute("INSERT INTO u VALUES ('nope')", []);

    drop(r);
    drop(w);
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(user, "user");
    assert_eq!(corpus, "corpus");
    assert!(write_user.is_err(), "the read handle must not write the user file");
    assert!(write_corpus.is_err(), "the read handle must not write the corpus either");
}

/// The exit checkpoint still empties both journals. `PRAGMA wal_checkpoint` with no schema
/// name checkpoints every attached database — measured, both `-wal` files at 0 bytes — so
/// `checkpoint_truncate` needs no change and this is what says so.
#[test]
fn a_truncating_checkpoint_empties_both_journals() {
    let dir = scratch("pair-checkpoint");
    let conn = open_write(&dir).unwrap();
    conn.execute_batch("CREATE TABLE t (v TEXT); CREATE TABLE corpus.u (v TEXT);")
        .unwrap();
    for i in 0..2000 {
        conn.execute("INSERT INTO t VALUES (?1)", [format!("row {i}")]).unwrap();
        conn.execute("INSERT INTO u VALUES (?1)", [format!("row {i}")]).unwrap();
    }
    let before_user = std::fs::metadata(dir.join("user.db-wal")).map(|m| m.len()).unwrap_or(0);
    let before_corpus = std::fs::metadata(dir.join("corpus.db-wal")).map(|m| m.len()).unwrap_or(0);

    checkpoint_truncate(&conn).unwrap();

    let after_user = std::fs::metadata(dir.join("user.db-wal")).map(|m| m.len()).unwrap_or(0);
    let after_corpus = std::fs::metadata(dir.join("corpus.db-wal")).map(|m| m.len()).unwrap_or(0);
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);

    assert!(before_user > 0 && before_corpus > 0, "both should have had a WAL to truncate");
    assert_eq!(after_user, 0);
    assert_eq!(after_corpus, 0, "an unqualified checkpoint must reach the attached file");
}
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test db::tests 2>&1 | tail -5`
Expected: `cannot find function open_write in this scope`.

- [x] **Step 3: Implement**

In `db.rs`:

```rust
/// The reader's own database. `main` on every connection this module hands out.
pub const USER_DB: &str = "user.db";

/// The rebuildable half. Attached, never `main` — and the reason is that you cannot
/// `DETACH main`. Discarding a corrupt corpus has to be four statements and 5 ms, not a
/// process-wide reopen with two live connections in the way.
pub const CORPUS_DB: &str = "corpus.db";

/// What the one file was called before schema 27. Only `crate::schema::split` names it.
pub const LEGACY_DB: &str = "mtg.db";

/// The schema name the corpus is attached under. Spelled once, so a query cannot be
/// half-qualified against a name somebody typed differently.
pub const CORPUS: &str = "corpus";

/// Apply the four file-level pragmas to one schema.
///
/// **`auto_vacuum` first, before any statement writes a page**, and that ordering is
/// load-bearing on both schemas for the same reason: once `journal_mode=WAL` has
/// materialised the file, `auto_vacuum` is a no-op that only a full `VACUUM` can apply.
/// Measured on a freshly-attached file, which opens on `delete` and `auto_vacuum = 0`.
///
/// `schema` is `None` for `main` and `Some(CORPUS)` for the attached half. `foreign_keys`
/// and `busy_timeout` are **not** here: both are per-connection and take no schema.
fn configure(conn: &Connection, schema: Option<&str>) -> rusqlite::Result<()> {
    conn.pragma_update(schema, "auto_vacuum", "INCREMENTAL")?;
    conn.pragma_update(schema, "journal_mode", "WAL")?;
    conn.pragma_update(schema, "synchronous", "NORMAL")?;
    conn.pragma_update(schema, "journal_size_limit", JOURNAL_SIZE_LIMIT)?;
    Ok(())
}

/// Attach `<data_dir>/corpus.db` as [`CORPUS`] and give it the same pragmas as `main`.
///
/// **An attached file inherits neither `journal_size_limit` nor `synchronous`** — measured
/// against the real 788 MB database, which came up on `-1` and `2` against `main`'s
/// `67108864` and `1`. The corpus is the half that writes an 857 MB journal during an
/// ingest, so a ceiling that does not reach it is a ceiling on nothing.
///
/// The path is bound as a parameter; the schema name cannot be, which is why [`CORPUS`] is
/// interpolated. Creating the file if it is absent is deliberate and is the corpus's whole
/// character: a missing corpus is a rebuild, not an error.
pub fn attach_corpus(conn: &Connection, data_dir: &Path) -> rusqlite::Result<()> {
    let path = data_dir.join(CORPUS_DB);
    conn.execute(
        &format!("ATTACH DATABASE ?1 AS {CORPUS}"),
        [path.to_string_lossy().as_ref()],
    )?;
    configure(conn, Some(CORPUS))
}

/// The one write connection: `user.db` as `main`, `corpus.db` attached.
pub fn open_write(data_dir: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(data_dir.join(USER_DB))?;
    configure(&conn, None)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    attach_corpus(&conn, data_dir)?;
    Ok(conn)
}

/// A **read-only** handle over the same pair.
///
/// Nothing is configured here, on either schema: those pragmas are properties of a file,
/// set by [`open_write`], and a read-only connection may not change them anyway. `ATTACH`
/// on a `SQLITE_OPEN_READ_ONLY` handle succeeds and the attached database is read-only too
/// — measured, a write to it answers `SQLITE_READONLY`, which is the guarantee this handle
/// exists for extended across both files.
pub fn open_read(data_dir: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        data_dir.join(USER_DB),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    let path = data_dir.join(CORPUS_DB);
    conn.execute(
        &format!("ATTACH DATABASE ?1 AS {CORPUS}"),
        [path.to_string_lossy().as_ref()],
    )?;
    Ok(conn)
}
```

Rewrite `db::open`'s body to `configure(&conn, None)` plus `foreign_keys` and `busy_timeout`, so
there is one definition of the four pragmas rather than two.

- [x] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test db:: 2>&1 | tail -8`
Expected: the four new tests plus the six existing ones. If `an_attached_corpus_gets_the_same_pragmas_as_main`
reports `corpus_mode = "delete"`, `attach_corpus` set `journal_mode` before the file existed —
check that `ATTACH` ran first.

- [x] **Step 5: Mutate to prove each pragma is individually asserted**

Delete the `journal_size_limit` line from `configure`;
`an_attached_corpus_gets_the_same_pragmas_as_main` must FAIL on `corpus_limit`. Restore it and
swap the order of `auto_vacuum` and `journal_mode`; the same test must FAIL on `corpus_vacuum`
with `0`. Restore, and make `open_read` use `Connection::open` instead of
`open_with_flags`; `the_read_handle_sees_both_files_and_writes_to_neither` must FAIL on
`write_corpus`. **If the ordering mutation survives, STOP and report** — it means the file already
existed when the test ran and the scratch directory is not being cleaned.

- [x] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/db.rs
git commit -m "feat(db): open the user file and attach the corpus, with the same pragmas on both

An attached database inherits neither journal_size_limit nor synchronous. Measured against
the real 788 MB file: corpus read -1 and 2 where main read 67108864 and 1. The corpus is
the half that writes an 857 MB WAL during an ingest, so a ceiling that does not reach it is
a ceiling on nothing.

auto_vacuum still goes before journal_mode, on the attached schema too - a freshly attached
file opens on delete and auto_vacuum 0, and once WAL has materialised it only a full VACUUM
can apply the mode. Nothing calls open_write yet."
```

---

### Task 3: `schema::split` — take a single file apart, on the real database

**Files:**
- Create: `src-tauri/src/schema/split.rs` — or, if `schema.rs` stays a single file in this repo's
  style, a `pub mod split` section at its end. **Check first**: `schema.rs` is a flat 552 KB file
  today, so a new sibling module `src-tauri/src/split.rs` declared in `lib.rs` is the smaller
  change. Prefer that, and say which was done.
- Modify: `src-tauri/src/lib.rs` — `pub mod split;`
- Modify: `src-tauri/src/schema.rs` — `create_user_schema(&Connection, &str)`
- Test: inline `#[cfg(test)] mod tests` in the new module

**Interfaces:**
- Produces: `split::State`, `split::state_of(&Path) -> std::io::Result<State>`,
  `split::convert(&Path) -> Result<bool, String>`,
  `schema::create_user_schema(&Connection, schema: &str) -> rusqlite::Result<()>`.
- Consumes: `db::{USER_DB, CORPUS_DB, LEGACY_DB, CORPUS, open, open_read_only}`,
  `schema::{migrate_single_file, TABLES, Side, LEGACY_SINGLE_FILE_VERSION, USER_SCHEMA_VERSION,
  CORPUS_SCHEMA_VERSION}`.

> ⚠️ **`lib.rs` must actually name the module.** A module the crate never declares compiles nothing
> and runs no tests, and the suite stays green while reporting on nothing — four waves of work have
> been lost to this here. **Add `pub mod split;` in Step 1, before the first red step**, or the
> first failure is `running 0 tests … ok` and cargo exits 0.

> ⚠️ **`mtg.db` is not modified until the user file is safely renamed into place.** Every crash
> point below leaves either the untouched original or a finished pair, never a half-emptied
> original beside no copy.

- [x] **Step 1: Declare the module and write the failing test**

Add `pub mod split;` to `lib.rs`, create `src-tauri/src/split.rs` containing only this test module,
and confirm the count moves before writing any implementation.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("mtgtest-split-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Build a pre-split database in `dir`, exactly as a shipped build up to v26 left one.
    fn legacy(dir: &std::path::Path) {
        let conn = crate::db::open(&dir.join(crate::db::LEGACY_DB)).unwrap();
        crate::schema::migrate_single_file(&conn).unwrap();
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('Krenko', 'commander', 100, 100)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO collection_entries
               (card_id,set_code,collector_number,lang,finish,quantity,created_at,updated_at)
             VALUES ('abc','m21','139','en','nonfoil',4,100,100)",
            [],
        )
        .unwrap();
        crate::db::checkpoint_truncate(&conn).unwrap();
    }

    /// The three states the file system can be in, and the one that must not read as "done".
    #[test]
    fn the_file_state_machine_names_the_crashed_case() {
        let dir = scratch("states");
        assert_eq!(state_of(&dir).unwrap(), State::Fresh);

        legacy(&dir);
        assert_eq!(state_of(&dir).unwrap(), State::Legacy);

        // A crash between the rename of the user file and the rename of the corpus. Both
        // files exist and the corpus does not, which must NOT read as converted — the
        // collection would be intact and the whole card database missing.
        std::fs::write(dir.join(crate::db::USER_DB), b"").unwrap();
        assert_eq!(state_of(&dir).unwrap(), State::HalfConverted);

        std::fs::remove_file(dir.join(crate::db::LEGACY_DB)).unwrap();
        std::fs::write(dir.join(crate::db::CORPUS_DB), b"").unwrap();
        assert_eq!(state_of(&dir).unwrap(), State::Split);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The conversion, end to end, on a database this app actually built.
    #[test]
    fn a_legacy_database_becomes_two_and_keeps_every_user_row() {
        let dir = scratch("convert");
        legacy(&dir);

        let converted = convert(&dir).unwrap();

        assert!(converted);
        assert!(!dir.join(crate::db::LEGACY_DB).exists(), "mtg.db must be gone");
        let conn = crate::db::open_write(&dir).unwrap();

        let decks: i64 = conn.query_row("SELECT count(*) FROM decks", [], |r| r.get(0)).unwrap();
        let entries: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        let user_v: i64 = conn.query_row("PRAGMA main.user_version", [], |r| r.get(0)).unwrap();
        let corpus_v: i64 = conn
            .query_row("PRAGMA corpus.user_version", [], |r| r.get(0))
            .unwrap();

        // Every table is in its own file and nowhere else. This is the assertion the whole
        // conversion exists to make true.
        for (table, side) in crate::schema::TABLES {
            let in_user: i64 = conn
                .query_row(
                    "SELECT count(*) FROM main.sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            let in_corpus: i64 = conn
                .query_row(
                    "SELECT count(*) FROM corpus.sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            let (want_user, want_corpus) = match side {
                crate::schema::Side::User => (1, 0),
                crate::schema::Side::Corpus => (0, 1),
            };
            assert_eq!(in_user, want_user, "{table} in the user file");
            assert_eq!(in_corpus, want_corpus, "{table} in the corpus");
        }

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(decks, 1);
        assert_eq!(entries, 1);
        assert_eq!(user_v, crate::schema::USER_SCHEMA_VERSION);
        assert_eq!(corpus_v, crate::schema::CORPUS_SCHEMA_VERSION);
    }

    /// Running it twice is running it once. Every launch calls this.
    #[test]
    fn convert_is_idempotent_and_says_it_did_nothing() {
        let dir = scratch("idempotent");
        legacy(&dir);
        assert!(convert(&dir).unwrap());
        assert!(!convert(&dir).unwrap(), "a converted pair must report no work");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A crash between the two renames is resumed rather than mistaken for success.
    #[test]
    fn a_half_converted_folder_finishes_instead_of_opening_without_a_corpus() {
        let dir = scratch("resume");
        legacy(&dir);
        // Do the first half by hand, exactly as `convert` does, and stop.
        {
            let conn = crate::db::open(&dir.join(crate::db::LEGACY_DB)).unwrap();
            extract_user_file(&conn, &dir).unwrap();
            crate::db::checkpoint_truncate(&conn).unwrap();
        }
        std::fs::rename(dir.join(PART), dir.join(crate::db::USER_DB)).unwrap();
        assert_eq!(state_of(&dir).unwrap(), State::HalfConverted);

        assert!(convert(&dir).unwrap(), "the resume must report that it did work");

        assert!(!dir.join(crate::db::LEGACY_DB).exists());
        assert!(dir.join(crate::db::CORPUS_DB).is_file());
        let conn = crate::db::open_write(&dir).unwrap();
        let decks: i64 = conn.query_row("SELECT count(*) FROM decks", [], |r| r.get(0)).unwrap();
        let cards_side: i64 = conn
            .query_row(
                "SELECT count(*) FROM corpus.sqlite_master WHERE name='cards'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(decks, 1);
        assert_eq!(cards_side, 1);
    }

    /// A fresh install goes through the same code, and that is the point rather than an
    /// accident: the riskiest function in this plan is the one every launch runs.
    #[test]
    fn a_fresh_folder_produces_a_split_pair_with_no_legacy_file() {
        let dir = scratch("fresh");
        assert!(convert(&dir).unwrap());
        assert!(dir.join(crate::db::USER_DB).is_file());
        assert!(dir.join(crate::db::CORPUS_DB).is_file());
        assert!(!dir.join(crate::db::LEGACY_DB).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **The one that cannot be faked with a fixture.** A worktree is a fresh install and can
    /// never show an upgrade bug; the main checkout's database is at `user_version` 25 with
    /// 116 843 cards and 2 581 `card_migrations` rows. Point `MTG_SPLIT_FIXTURE` at a **copy**
    /// and this runs against it — the same escape hatch `index::warmup` already uses with
    /// `MTG_WARMUP_DB`.
    ///
    /// Measured 2026-08-28 on a byte copy of the 788 406 272 B live database: the whole
    /// conversion took **294 ms** and produced a **1 323 008 B** user file beside a
    /// **787 042 304 B** corpus, with zero `foreign_key_check` violations.
    #[test]
    fn the_real_database_converts_with_every_row_intact() {
        let Ok(fixture) = std::env::var("MTG_SPLIT_FIXTURE") else {
            eprintln!("set MTG_SPLIT_FIXTURE to a COPY of a real mtg.db to run this");
            return;
        };
        let dir = scratch("real");
        std::fs::copy(&fixture, dir.join(crate::db::LEGACY_DB)).unwrap();

        let before: Vec<(String, i64)> = {
            let conn = crate::db::open_read_only(&dir.join(crate::db::LEGACY_DB)).unwrap();
            crate::schema::TABLES
                .iter()
                .filter(|(_, s)| *s == crate::schema::Side::User)
                .map(|(t, _)| {
                    let n: i64 = conn
                        .query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0))
                        .unwrap();
                    ((*t).to_owned(), n)
                })
                .collect()
        };

        let started = std::time::Instant::now();
        convert(&dir).unwrap();
        let elapsed = started.elapsed();

        let conn = crate::db::open_write(&dir).unwrap();
        let after: Vec<(String, i64)> = before
            .iter()
            .map(|(t, _)| {
                let n: i64 = conn
                    .query_row(&format!("SELECT count(*) FROM main.{t}"), [], |r| r.get(0))
                    .unwrap();
                (t.clone(), n)
            })
            .collect();
        let violations: i64 = conn
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get(0))
            .unwrap();
        let cards: i64 = conn.query_row("SELECT count(*) FROM cards", [], |r| r.get(0)).unwrap();
        let user_bytes = std::fs::metadata(dir.join(crate::db::USER_DB)).unwrap().len();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);

        eprintln!("conversion took {elapsed:?}, user.db is {user_bytes} B");
        assert_eq!(after, before, "a user row count changed across the split");
        assert_eq!(violations, 0);
        assert!(cards > 100_000, "the corpus must still hold its cards");
    }
}
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test split:: 2>&1 | tail -6`
Expected: compile errors for `State`, `state_of`, `convert`, `extract_user_file`, `PART`. **If it
prints `running 0 tests`, `lib.rs` does not name the module** — fix that before going on.

- [x] **Step 3: Implement**

In `schema.rs`, add the head-shaped user DDL as **one literal used by both callers**, which is the
inverse of `ORACLE_TAG_STAGING_SQL`'s rule and correct for the same reason: those two must be
identical *by construction*, so a second literal would be the bug.

```rust
/// Create the fifteen user tables and their indexes in `schema`, at
/// [`USER_SCHEMA_VERSION`]'s shape.
///
/// **One function, two callers, and that is deliberate**: `split::convert` builds them in an
/// attached scratch file, and nothing else ever builds them at all — a fresh install goes
/// through the same conversion. A second literal here would be two shapes that must agree,
/// which is the failure `ORACLE_TAG_STAGING_SQL` describes from the other side.
///
/// `schema` is interpolated rather than bound: SQLite has no parameter for a schema name.
/// It is only ever [`crate::db::CORPUS`], `"main"`, or `split`'s own scratch name.
pub fn create_user_schema(conn: &Connection, schema: &str) -> rusqlite::Result<()> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {schema}.decks ( … );
         CREATE TABLE IF NOT EXISTS {schema}.deck_folders ( … );
         …
         CREATE INDEX IF NOT EXISTS {schema}.idx_collection_grain ON collection_entries( … );
         …"
    ))
}
```

**Copy the DDL from the live shape rather than from a rung**, and verify it: after writing it,
assert in a test that `create_user_schema` on an empty database produces byte-identical
`sqlite_master.sql` to what `migrate_single_file` produces for the same fifteen tables. That test
is what makes "copied from head" a fact instead of a claim.

Then `split.rs`:

```rust
//! Taking the one file apart, and the three states the folder can be in while it happens.
//!
//! **`mtg.db` is not modified until the user file is safely renamed into place.** The order
//! below has exactly one irreversible moment — the rename at step 5 — and every crash before
//! it leaves the original untouched, every crash after it leaves a folder [`state_of`] can
//! name and [`convert`] can finish.
//!
//! Measured 2026-08-28 against a byte copy of the 788 406 272 B development database: 294 ms
//! end to end, producing a 1 323 008 B user file. A fresh install runs the same code against
//! an empty database, which is why this is not a once-per-lifetime path with no coverage.

use crate::db::{CORPUS, CORPUS_DB, LEGACY_DB, USER_DB};
use crate::schema::{self, Side};
use rusqlite::Connection;
use std::path::Path;

/// The half-built user file, before it earns its name.
pub const PART: &str = "user.db.part";

/// The scratch schema name the extraction attaches under.
const SCRATCH: &str = "part";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// Nothing here yet.
    Fresh,
    /// One file, from a build before schema 27.
    Legacy,
    /// The user file was renamed into place and the corpus rename had not happened. **This
    /// must never read as `Split`**: opening it would give a reader their whole collection
    /// and no card database, with `mtg.db` sitting beside it holding everything.
    HalfConverted,
    /// Done.
    Split,
}

/// Which of the four states `data_dir` is in.
pub fn state_of(data_dir: &Path) -> std::io::Result<State> {
    let legacy = data_dir.join(LEGACY_DB).is_file();
    let user = data_dir.join(USER_DB).is_file();
    Ok(match (legacy, user) {
        (true, false) => State::Legacy,
        (true, true) => State::HalfConverted,
        (false, true) => State::Split,
        (false, false) => State::Fresh,
    })
}

/// Bring `data_dir` to [`State::Split`]. `Ok(false)` means it was already there.
pub fn convert(data_dir: &Path) -> Result<bool, String> {
    match state_of(data_dir).map_err(|e| e.to_string())? {
        State::Split => return Ok(false),
        State::Fresh => {
            // A fresh install builds an empty legacy file and takes it apart, so that the
            // conversion is exercised by every first launch and every test run rather than
            // being the one path nobody has driven.
            let conn = crate::db::open(&data_dir.join(LEGACY_DB)).map_err(|e| e.to_string())?;
            schema::migrate_single_file(&conn).map_err(|e| e.to_string())?;
            crate::db::checkpoint_truncate(&conn).map_err(|e| e.to_string())?;
        }
        State::Legacy => {}
        State::HalfConverted => return finish(data_dir).map(|()| true),
    }

    // 1–4. Everything that touches only the new file.
    {
        let conn = crate::db::open(&data_dir.join(LEGACY_DB)).map_err(|e| e.to_string())?;
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if version > schema::LEGACY_SINGLE_FILE_VERSION {
            return Err(format!(
                "the database at {} is version {version}, which this build does not know. \
                 It is probably from a newer version of MTG Grimoire.",
                data_dir.join(LEGACY_DB).display()
            ));
        }
        schema::migrate_single_file(&conn).map_err(|e| e.to_string())?;
        extract_user_file(&conn, data_dir).map_err(|e| e.to_string())?;
        crate::db::checkpoint_truncate(&conn).map_err(|e| e.to_string())?;
    }

    // 5. The one irreversible moment, and the smallest possible one.
    std::fs::rename(data_dir.join(PART), data_dir.join(USER_DB)).map_err(|e| e.to_string())?;

    finish(data_dir).map(|()| true)
}

/// Steps 6–8: empty the old file of the reader's rows and let it become the corpus.
///
/// Idempotent throughout, because a crash resumes here: `DROP TABLE IF EXISTS`, a version
/// stamp that is already correct, and a rename that is only reached once.
fn finish(data_dir: &Path) -> Result<(), String> {
    {
        let conn = crate::db::open(&data_dir.join(LEGACY_DB)).map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        // OFF for the drop and only the drop: the fifteen are dropped in reverse dependency
        // order, but `deck_cards → deck_categories` and friends make any order a violation
        // for the duration of a batch, and this batch ends with none of them present.
        tx.execute_batch("PRAGMA foreign_keys = OFF;").map_err(|e| e.to_string())?;
        for (table, _) in schema::TABLES.iter().filter(|(_, s)| *s == Side::User).rev() {
            tx.execute_batch(&format!("DROP TABLE IF EXISTS main.{table}"))
                .map_err(|e| e.to_string())?;
        }
        tx.execute_batch(&format!(
            "PRAGMA user_version = {};",
            schema::CORPUS_SCHEMA_VERSION
        ))
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA foreign_keys = ON;").map_err(|e| e.to_string())?;

        // Hand the pages back before the file takes its new name — measured at 333 chunks
        // and 29.9 ms on the real database, against a `VACUUM` that would rewrite 787 MB.
        reclaim(&conn);
        crate::db::checkpoint_truncate(&conn).map_err(|e| e.to_string())?;
    }
    // The journals are empty after a truncating checkpoint, so there is nothing in them to
    // carry across; removing them is what keeps the rename from stranding a `-wal` beside a
    // file that no longer has that name.
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(data_dir.join(format!("{LEGACY_DB}{suffix}")));
    }
    std::fs::rename(data_dir.join(LEGACY_DB), data_dir.join(CORPUS_DB)).map_err(|e| e.to_string())
}

/// Build `user.db.part` beside the legacy file and copy the fifteen tables into it.
///
/// Attached rather than opened separately so the copy is `INSERT … SELECT` inside one
/// transaction on one connection — and the transaction is honest here where it would not be
/// in the running app, because a crash discards a `.part` file nobody has renamed yet.
pub fn extract_user_file(conn: &Connection, data_dir: &Path) -> rusqlite::Result<()> {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(data_dir.join(format!("{PART}{suffix}")));
    }
    let path = data_dir.join(PART);
    conn.execute(
        &format!("ATTACH DATABASE ?1 AS {SCRATCH}"),
        [path.to_string_lossy().as_ref()],
    )?;
    // The same order and the same reason as `crate::db::configure`: `auto_vacuum` before
    // WAL materialises the file.
    conn.pragma_update(Some(SCRATCH), "auto_vacuum", "INCREMENTAL")?;
    conn.pragma_update(Some(SCRATCH), "journal_mode", "WAL")?;
    conn.pragma_update(Some(SCRATCH), "synchronous", "NORMAL")?;

    conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
    let tx = conn.unchecked_transaction()?;
    schema::create_user_schema(&tx, SCRATCH)?;
    for (table, _) in schema::TABLES.iter().filter(|(_, s)| *s == Side::User) {
        let columns = shared_columns(&tx, table)?;
        tx.execute_batch(&format!(
            "INSERT INTO {SCRATCH}.{table} ({columns}) SELECT {columns} FROM main.{table}"
        ))?;
    }
    tx.execute_batch(&format!(
        "PRAGMA {SCRATCH}.user_version = {};",
        schema::USER_SCHEMA_VERSION
    ))?;
    tx.commit()?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    conn.query_row(&format!("PRAGMA {SCRATCH}.wal_checkpoint(TRUNCATE)"), [], |_| Ok(()))?;
    conn.execute_batch(&format!("DETACH DATABASE {SCRATCH}"))
}

/// The columns both copies of `table` have, in the destination's order.
///
/// A `SELECT *` would be one line and would break the first time a user rung adds a column:
/// the destination is at head and the source is at [`schema::LEGACY_SINGLE_FILE_VERSION`],
/// which are the same shape today and are not required to stay that way.
///
/// **`PRAGMA main.table_info` on a table that does not exist is an empty result, not an
/// error** — measured — so an empty answer here is a real failure mode and is refused rather
/// than turned into `INSERT INTO t () SELECT`.
fn shared_columns(conn: &Connection, table: &str) -> rusqlite::Result<String> {
    let read = |schema: &str| -> rusqlite::Result<Vec<String>> {
        let mut stmt = conn.prepare(&format!("PRAGMA {schema}.table_info({table})"))?;
        stmt.query_map([], |r| r.get::<_, String>(1))?.collect()
    };
    let source = read("main")?;
    let dest = read(SCRATCH)?;
    let shared: Vec<String> = dest
        .into_iter()
        .filter(|c| source.iter().any(|s| s == c))
        .map(|c| format!("\"{c}\""))
        .collect();
    if shared.is_empty() {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
            Some(format!("cannot split: `{table}` has no columns in common")),
        ));
    }
    Ok(shared.join(", "))
}

/// Hand the freed pages back, a chunk at a time. Best-effort: a corpus that is larger than
/// it needs to be is not a reason to refuse to start.
fn reclaim(conn: &Connection) {
    for _ in 0..10_000 {
        let free: i64 = conn
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .unwrap_or(0);
        if free == 0 || conn.execute_batch("PRAGMA incremental_vacuum(2000);").is_err() {
            return;
        }
        let after: i64 = conn
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .unwrap_or(0);
        if after == free {
            return;
        }
    }
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test split:: 2>&1 | tail -10`, then the real-database run:

```bash
mkdir -p /tmp/split-fixture
cp src-tauri/target/debug/data/mtg.db /tmp/split-fixture/mtg.db
MTG_SPLIT_FIXTURE=/tmp/split-fixture/mtg.db cargo test --manifest-path src-tauri/Cargo.toml \
  split::tests::the_real_database_converts 2>&1 | tail -12
```

Expected: six passes, and the real-database run printing a conversion time in the low hundreds of
milliseconds and a user file around 1.3 MB. **Never point `MTG_SPLIT_FIXTURE` at the user's own
database** — it is copied *from*, never converted in place, and the copy is what the test deletes.

- [x] **Step 5: Mutate to prove the state machine and the copy both bite**

Change `state_of`'s `(true, true)` arm to `State::Split`;
`a_half_converted_folder_finishes_instead_of_opening_without_a_corpus` must FAIL. Restore it, and
make `extract_user_file` skip `card_migrations`;
`a_legacy_database_becomes_two_and_keeps_every_user_row` must FAIL naming `card_migrations`, and
the real-database test must FAIL on the row-count comparison. Restore, and move the
`std::fs::rename(PART → USER_DB)` to *before* `extract_user_file`;
`convert_is_idempotent_and_says_it_did_nothing` must FAIL. **If the state-machine mutation
survives, STOP and report** — it means no test reaches `HalfConverted` and the crash case is
untested.

- [x] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/split.rs src-tauri/src/schema.rs src-tauri/src/lib.rs
git commit -m "feat(schema): split a single mtg.db into user.db and corpus.db

Measured on a byte copy of the real 788 406 272 B database: 294 ms end to end, producing a
1 323 008 B user file beside a 787 042 304 B corpus, zero foreign_key_check violations.
The reader's entire authored history is 0.17% of the file it currently shares.

mtg.db is not modified until user.db.part has been renamed into place, so the only crash
that can lose anything is one that cannot happen: every earlier point leaves the original
untouched, and the point after it leaves a state state_of names and convert finishes. A
fresh install runs the same code against an empty database, deliberately - this is the
riskiest function in the change and it should not be the one path nobody drives.

Nothing calls convert yet."
```

---

### Task 4: Wire it up — the pair everywhere, every corpus DDL qualified, every vacuum too

**This is the one task that cannot be split, and it is the one that fails silently if rushed.**
Everything it touches has the same failure mode: the app keeps working, and a table or a gigabyte
ends up in the wrong file.

**Files:**
- Modify: `src-tauri/src/lib.rs` — `init_state`
- Modify: `src-tauri/src/schema.rs` — `prepare_database`, `create_staging`, `cards_column_defs`,
  `swap_staging`, `create_fts`, `ORACLE_TAG_STAGING_SQL`, `ART_TAG_STAGING_SQL`,
  `COMBO_STAGING_SQL`, the three `swap_*_staging` functions, `CARDS_INDEXES`
- Modify: `src-tauri/src/maintenance.rs` — `needs_conversion`, `freelist_pages`,
  `vacuum_into_incremental`, `reclaim_freed_pages`, `convert_to_incremental`
- Modify: `src-tauri/src/index/lifecycle.rs` (2 sites), `src-tauri/src/mirror/watch.rs` (1 site),
  `src-tauri/src/mirror/settings.rs` (1 site)
- Modify: every `#[cfg(test)]` helper that builds a database — see Step 3

**Interfaces:**
- Consumes: `db::{open_write, open_read, CORPUS}`, `split::convert`, `schema::TABLES`.
- Produces: `schema::prepare_database(&Connection)` keeps its signature; `schema::memory_pair()`
  (test-only); `maintenance::needs_conversion(&Connection, &str)` and
  `maintenance::freelist_pages(&Connection, &str)` gain a schema argument.

> ⚠️ **There are SIX production connections, not two.** `AppState` holds `db` and `db_read`, and
> four more are opened outside it: `index::lifecycle::build_now` (`lifecycle.rs:138`),
> `index::lifecycle::invalidate_owned` (`lifecycle.rs:191`), the mirror thread
> (`mirror/watch.rs:323`) and `mirror::settings` (`settings.rs:310`). **Every one of them reads
> tables from both files** — the facet index scans `cards` *and* `collection_entries` through
> `collection_source::owned_rowids`, and the mirror renders decks and joins card names. A
> connection that attaches only one file does not error; it reports an empty collection, or a cold
> index, and looks like a different bug entirely.

> ⚠️ **`PRAGMA main.table_info(x)` on a missing table returns zero rows, not an error.** So a
> schema-qualified pragma pointed at the wrong file is silent. `cards_column_defs` already refuses
> an empty answer — keep that guard, it is now load-bearing twice over.

- [x] **Step 1: Write the failing tests**

In `schema.rs`:

```rust
/// The assertion the whole of this task exists to make, and the only cheap way to catch
/// forty unqualified statements: after a database has been prepared **and put through a
/// full sync of all four feeds**, every table is in the file the registry names.
///
/// A staging table created unqualified lands in `main`, is renamed over a `cards` that is
/// not there, and the failure surfaces days later as a user file that has grown to 800 MB.
/// This is where it surfaces instead.
#[test]
fn a_full_sync_leaves_every_table_on_its_own_side() {
    let conn = memory_pair();

    // The four staging paths, in the order a sync runs them.
    create_staging(&conn).unwrap();
    swap_staging(&conn).unwrap();
    create_oracle_tag_staging(&conn).unwrap();
    swap_oracle_tag_staging(&conn).unwrap();
    create_art_tag_staging(&conn).unwrap();
    swap_art_tag_staging(&conn).unwrap();
    create_combo_staging(&conn).unwrap();
    swap_combo_staging(&conn).unwrap();

    for (table, side) in TABLES {
        let here = |schema: &str| -> i64 {
            conn.query_row(
                &format!("SELECT count(*) FROM {schema}.sqlite_master WHERE type='table' AND name=?1"),
                [table],
                |r| r.get(0),
            )
            .unwrap()
        };
        let (want_user, want_corpus) = match side {
            Side::User => (1, 0),
            Side::Corpus => (0, 1),
        };
        assert_eq!(here("main"), want_user, "{table} should be in the user file");
        assert_eq!(here("corpus"), want_corpus, "{table} should be in the corpus");
    }

    // And nothing else in either — a staging table left behind is a table too.
    let leftovers: i64 = conn
        .query_row(
            "SELECT count(*) FROM main.sqlite_master WHERE type='table' AND name LIKE '%_staging'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(leftovers, 0, "a staging table was created in the user file");
}

/// FTS5 resolves `content='cards'` in **its own schema**, so an index built in the wrong
/// file creates cleanly and fails on its first rebuild with `no such table: main.cards`.
#[test]
fn the_search_index_is_built_beside_the_cards_it_indexes() {
    let conn = memory_pair();
    conn.execute(
        "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw)
         VALUES ('x','Lightning Bolt','lea','161','en','normal','{}')",
        [],
    )
    .unwrap();
    create_fts(&conn).unwrap();
    let hits: i64 = conn
        .query_row(
            "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH 'lightning'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(hits, 1);
}
```

In `maintenance.rs`:

```rust
/// The reclaim is about the gigabyte an old `cards` leaves behind, and after the split that
/// gigabyte is in the attached file. Every one of these pragmas means `main` when it is not
/// told otherwise — measured after the split: `page_count` unqualified 323, `corpus.page_count`
/// 192 149 — so an unqualified reclaim is a reclaim of nothing that reports success.
#[test]
fn the_reclaim_reads_the_corpus_and_not_the_user_file() {
    let dir = scratch("reclaim-side");
    crate::split::convert(&dir).unwrap();
    let conn = crate::db::open_write(&dir).unwrap();
    conn.execute_batch(
        "CREATE TABLE corpus.ballast (v TEXT);
         INSERT INTO corpus.ballast (v)
           WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 20000)
           SELECT hex(randomblob(200)) FROM n;
         DROP TABLE corpus.ballast;",
    )
    .unwrap();

    let user_free = freelist_pages(&conn, "main");
    let corpus_free = freelist_pages(&conn, crate::db::CORPUS);

    let db = std::sync::Mutex::new(conn);
    reclaim_freed_pages(&db, &mut |_, _| {}).unwrap();
    let after = freelist_pages(&crate::db::lock_blocking(&db), crate::db::CORPUS);
    drop(db);
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(user_free, 0, "the user file has nothing to reclaim");
    assert!(corpus_free > 100, "the drop should have freed corpus pages, got {corpus_free}");
    assert_eq!(after, 0, "the reclaim must have emptied the CORPUS freelist");
}
```

In `split.rs` — **the property the whole split is for**:

```rust
/// Throw the corpus away and the collection is still there. This is the third consequence
/// in the brief, as a test rather than as a button: a corrupt corpus is a file to delete,
/// not a reason to lose anything.
#[test]
fn a_destroyed_corpus_costs_a_resync_and_nothing_else() {
    let dir = scratch("corpus-loss");
    legacy(&dir);
    convert(&dir).unwrap();
    {
        let conn = crate::db::open_write(&dir).unwrap();
        crate::db::checkpoint_truncate(&conn).unwrap();
    }

    // What an OPFS eviction, a half-written sync or a bad sector leaves behind.
    std::fs::write(dir.join(crate::db::CORPUS_DB), b"not a database at all").unwrap();
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(dir.join(format!("corpus.db{suffix}")));
    }

    let recovered = crate::schema::prepare_data_dir(&dir).unwrap();
    let conn = crate::db::open_write(&dir).unwrap();
    let decks: i64 = conn.query_row("SELECT count(*) FROM decks", [], |r| r.get(0)).unwrap();
    let entries: i64 = conn
        .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
        .unwrap();
    let cards: i64 = conn.query_row("SELECT count(*) FROM cards", [], |r| r.get(0)).unwrap();
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);

    assert!(recovered, "a corrupt corpus should have been replaced");
    assert_eq!(decks, 1, "the deck must survive losing the card database");
    assert_eq!(entries, 1, "and so must the collection");
    assert_eq!(cards, 0, "the corpus is empty and owes a sync, which is a supported state");
}
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test a_full_sync_leaves_every_table 2>&1 | tail -8`
Expected: `cannot find function memory_pair`. Then, once `memory_pair` exists but nothing is
qualified, the same test must fail listing `cards`, `cards_fts` and the staging tables as being in
the user file. **Get that second red before qualifying anything** — it is the only proof the test
can see the problem it exists for.

- [x] **Step 3: Implement, in this order**

**(a) The test helper, first, because everything else depends on it.** In `schema.rs`:

```rust
/// An in-memory pair shaped exactly like the app's: `main` is the user file and a second,
/// private in-memory database is attached as `corpus`.
///
/// Two `ATTACH ':memory:'` calls give two *distinct* databases, measured — so this is one
/// connection over two schemas with no files involved.
///
/// **This is what a test should reach for**, not `Connection::open_in_memory` plus
/// `migrate_single_file`: a test on a single file cannot see a statement that landed in the
/// wrong one, which is the whole class of bug this change introduces.
#[cfg(test)]
pub fn memory_pair() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn.execute_batch(&format!("ATTACH DATABASE ':memory:' AS {CORPUS}"))
        .unwrap();
    create_user_schema(&conn, "main").unwrap();
    create_corpus_schema(&conn, CORPUS).unwrap();
    conn.execute_batch(&format!(
        "PRAGMA main.user_version = {USER_SCHEMA_VERSION};
         PRAGMA {CORPUS}.user_version = {CORPUS_SCHEMA_VERSION};"
    ))
    .unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn
}
```

`create_corpus_schema` is `create_user_schema`'s twin over the twenty-five corpus tables and
`CARDS_INDEXES`, and is the head shape the split's corpus half is left in.

**(b) `prepare_data_dir` — the whole startup sequence, in one function.** In `schema.rs`:

```rust
/// Bring `data_dir` to a state the app can open: convert if a single file is there, and
/// replace a corpus that will not open at all.
///
/// `Ok(true)` means something was rebuilt or converted. **A corpus that fails to open is a
/// file to replace, not a failure to report**: that is what having two files buys, and it
/// is checked here — before any connection the app keeps — because the check is "can this
/// be opened", and the honest way to ask is to try.
pub fn prepare_data_dir(data_dir: &Path) -> Result<bool, String> {
    let converted = crate::split::convert(data_dir)?;
    if corpus_is_readable(data_dir) {
        return Ok(converted);
    }
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(data_dir.join(format!("{CORPUS_DB}{suffix}")));
    }
    eprintln!(
        "the card database could not be opened and has been replaced; the next sync \
         will rebuild it. Nothing in your collection, decks or wishlist was touched."
    );
    Ok(true)
}

fn corpus_is_readable(data_dir: &Path) -> bool {
    let Ok(conn) = crate::db::open(&data_dir.join(CORPUS_DB)) else {
        return false;
    };
    conn.query_row("PRAGMA quick_check(1)", [], |r| r.get::<_, String>(0))
        .map(|answer| answer == "ok")
        .unwrap_or(false)
}
```

`prepare_database(&conn)` keeps its name and its job — `migrate_user`, `migrate_corpus`, the
`rebuild_fts_if_pending` repair and the `cards_staging` sweep — with every statement qualified.

**(c) `lib.rs::init_state`**, replacing lines 679–693:

```rust
    // Before any connection: convert a single file, or replace a corpus that will not open.
    schema::prepare_data_dir(&data_dir)
        .map_err(|e| data_dir_conversion_error(&data_dir, &e))?;

    let conn = db::open_write(&data_dir)
        .map_err(|e| data_dir_error(portable.as_deref(), &fallback, e))?;
    schema::prepare_database(&conn).map_err(|e| { … })?;
    let conn_read = db::open_read(&data_dir)
        .map_err(|e| data_dir_error(portable.as_deref(), &fallback, e))?;
```

**(d) Every corpus DDL, qualified.** `create_staging` → `corpus.cards_staging`;
`cards_column_defs` → `PRAGMA corpus.table_info(cards)`; `swap_staging` → `DROP TABLE IF EXISTS
corpus.cards_fts; DROP TABLE corpus.cards; ALTER TABLE corpus.cards_staging RENAME TO cards;`
(**the new name stays unqualified — `RENAME TO corpus.cards` is a syntax error, and a rename
cannot move a table between schemas at all**); `create_fts` → `CREATE VIRTUAL TABLE corpus.cards_fts
… content='cards'`; `CARDS_INDEXES` and the three tagger/combo staging constants likewise;
`prepare_database`'s `DROP TABLE IF EXISTS cards_staging` → `corpus.cards_staging`.

**(e) `maintenance.rs`, every pragma given a schema.** `needs_conversion(conn, schema)`,
`freelist_pages(conn, schema)`, `vacuum_into_incremental` → `PRAGMA corpus.auto_vacuum =
INCREMENTAL; VACUUM corpus;` (**both legal — measured**), `reclaim_freed_pages` →
`PRAGMA corpus.incremental_vacuum(…)`. The call sites in `sync.rs` pass `crate::db::CORPUS`.

**(f) The four extra connections**, each `crate::db::open_read(&state.data_dir)` in place of
`open_read_only(&state.data_dir.join("mtg.db"))`.

**(g) The test-helper sweep.** `grep -rn "open_in_memory" src-tauri/src` reports **167** sites
across 39 files today, of which **102 are in `schema.rs`** and belong to the frozen ladder's tests
— those build pre-split databases by hand and must stay single-file. The remaining **~65 across 38
files** become `crate::schema::memory_pair()`. **Report the exact number you changed and the exact
number you left**, and say why for any you left.

- [x] **Step 4: Run the tests to verify they pass**

```bash
cd src-tauri && cargo test 2>&1 | tail -20
```

Expected: the whole Rust suite green — 1 428 tests as of the feed-pipeline PR, plus this plan's
additions. **Then re-measure the two numbers the split could have moved**, because a cross-file
join is a new shape for the planner:

```bash
cargo test --release facet_index_build_time -- --ignored --nocapture 2>&1 | tail -5
MTG_WARMUP_DB=/tmp/split-fixture/user.db cargo test --release index::warmup -- --ignored --nocapture
```

**STOP and report if the facet index build has moved from its ~767 ms baseline by more than 25 %**,
or if any search measurement in [`data-and-sync.md`](../../reference/data-and-sync.md) has. The
cross-file joins measured 0.62–2.67 ms during planning and nothing suggests a regression, but that
was five queries and this is the whole app.

- [x] **Step 5: Mutate to prove the side assertion is what is holding this together**

Unqualify `create_staging`'s `CREATE TABLE` back to `cards_staging`;
`a_full_sync_leaves_every_table_on_its_own_side` must FAIL reporting a `%_staging` table in the
user file. Restore, and unqualify `create_fts`;
`the_search_index_is_built_beside_the_cards_it_indexes` must FAIL with `no such table: main.cards`,
and the side test must FAIL on `cards_fts`. Restore, and change `reclaim_freed_pages` back to an
unqualified `PRAGMA incremental_vacuum`; `the_reclaim_reads_the_corpus_and_not_the_user_file` must
FAIL on `after`. Restore, and make `memory_pair` return a plain `open_in_memory` with everything in
`main`; **at least twenty tests across the suite must fail** — if fewer than five do, the sweep in
(g) did not happen and most of the suite is still testing a single file. **STOP and report the
count either way.**

- [x] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src
git commit -m "feat(db): the app opens user.db and corpus.db, and every corpus statement says so

Six production connections, not two: AppState's pair plus the facet index's two, the mirror
thread's and the settings panel's. Every one reads tables from both files - the index scans
cards AND collection_entries - and one that attached only half would report an empty
collection rather than an error.

Forty statements needed a schema name and every one of them fails silently without it: a
bare CREATE TABLE lands in main, an FTS5 index resolves content='cards' in its own schema,
and PRAGMA freelist_count / incremental_vacuum / VACUUM all mean main, which after the split
is a 1.3 MB file rather than the gigabyte the reclaim was written about. One test carries
all forty: run a full sync against a pair and assert sqlite_master on each side matches the
registry.

A corpus that will not open is now replaced at startup and costs a resync. Nothing else."
```

---

### Task 5: The one transaction that writes to both files

**`reconcile::apply` is it, and its atomicity is load-bearing.** It opens one transaction that
repoints rows in `collection_entries`, `deck_cards` and `wishlist_entries` — the user's — and
writes `INSERT OR IGNORE INTO card_migrations` in the same transaction. Its own comment states the
stake: *"Applying a fold twice would double a quantity, so 'have I seen this?' is the only thing
standing between a re-poll and a collection that grows on its own."*

SQLite makes no atomicity guarantee across attached databases in WAL mode. A crash between the two
files' commits leaves the quantity folded and the migration unrecorded, and the next poll folds it
again. **Task 1 already put `card_migrations` on the user side, which closes this**; this task is
where that becomes an assertion instead of a placement.

**Files:**
- Modify: `src-tauri/src/reconcile.rs` — module doc only; the SQL is unqualified and already
  correct once the table is user-side
- Test: inline `#[cfg(test)] mod tests` in `src-tauri/src/reconcile.rs`

**Interfaces:**
- Consumes: `schema::{memory_pair, side_of, Side}`.
- Produces: nothing new.

- [x] **Step 1: Write the failing test**

```rust
/// `apply` opens one transaction over the reader's rows *and* the ledger of what has been
/// applied to them, and SQLite does not promise those two commit together across attached
/// databases. So they must not be attached to each other: both are the user's.
///
/// The failure this prevents is not a crash — it is a collection that grows by itself. A
/// fold applied and not recorded is a fold applied again on the next poll.
#[test]
fn apply_writes_only_the_user_file() {
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::sync::Arc;

    let mut conn = crate::schema::memory_pair();
    conn.execute(
        "INSERT INTO collection_entries
           (card_id,set_code,collector_number,lang,finish,quantity,created_at,updated_at)
         VALUES ('old','m21','1','en','nonfoil',2,0,0)",
        [],
    )
    .unwrap();

    let schemas = Arc::new(AtomicU8::new(0));
    {
        let s = schemas.clone();
        conn.update_hook(Some(
            move |_a: rusqlite::hooks::Action, db: &str, _t: &str, _r: i64| {
                s.fetch_or(if db == "main" { 1 } else { 2 }, Ordering::Relaxed);
            },
        ))
        .unwrap();
    }

    apply(
        &mut conn,
        &[Migration {
            id: "m-1".to_owned(),
            performed_at: Some("2026-08-01".to_owned()),
            strategy: "merge".to_owned(),
            old_card_id: "old".to_owned(),
            new_card_id: Some("new".to_owned()),
            note: None,
        }],
    )
    .unwrap();

    assert_eq!(
        schemas.load(Ordering::Relaxed),
        1,
        "apply must write the user file and nothing else"
    );
    assert_eq!(crate::schema::side_of("card_migrations"), Some(crate::schema::Side::User));
}
```

- [x] **Step 2: Run the test to verify it fails**

Temporarily move `card_migrations` to `Side::Corpus` in `TABLES` and to the corpus half of
`create_corpus_schema`. Run: `cd src-tauri && cargo test reconcile::tests::apply_writes_only 2>&1 | tail -5`
Expected: FAIL with `3` — `main | corpus`. **That red is the point of this task**: it is the bug
that would have shipped, reproduced. Then revert the temporary move.

- [x] **Step 3: Implement**

No SQL changes — the placement is already right. Rewrite `reconcile.rs`'s module doc, which
currently explains why `card_migrations` records what has been applied without saying which file it
lives in:

```rust
//! …
//! **`card_migrations` is in the user file, and that is a correctness requirement rather
//! than a filing preference.** Its rows come from Scryfall, so the obvious reading is that
//! it is derived and belongs beside `cards`. It is not: the table's job is "which of these
//! have I already applied to *my* rows", and [`apply`] writes it in the same transaction as
//! the folds it is recording. SQLite makes no atomicity guarantee across attached databases
//! in WAL mode, so a crash between the two commits would leave a quantity doubled and
//! nothing to say it had been. `apply_writes_only_the_user_file` is what keeps them
//! together.
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && cargo test reconcile:: 2>&1 | tail -6`
Expected: every pre-existing reconcile test plus the new one. Report the selected count.

- [x] **Step 5: Mutate to prove the hook can see a corpus write from here**

Add `tx.execute("INSERT OR REPLACE INTO sets (code, name) VALUES ('zzz','probe')", [])?;` inside
`apply`'s loop. `apply_writes_only_the_user_file` must FAIL with `3`. Remove it. **If it passes
with the corpus write in place, the update hook is not installed on that connection** — STOP and
report, because Task 6's fence rests on the same mechanism.

- [x] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/reconcile.rs
git commit -m "test(reconcile): assert apply commits to one file, and say why in the doc

reconcile::apply is the only production transaction that wrote to both halves: it repoints
the reader's rows and records card_migrations in one commit, and the recording is the only
thing standing between a re-poll and a doubled quantity. SQLite does not promise those two
commit together across attached databases, so card_migrations is in the user file - the
placement Task 1 made and this makes an assertion.

The test drives the update hook, which reports the schema name for every write. Mutating
apply to touch corpus.sets turns it red."
```

---

### Task 6: The fence — one update hook, two jobs, and a named blind spot

**Files:**
- Modify: `src-tauri/src/db.rs` — `CrossFileFence`
- Modify: `src-tauri/src/mirror/watch.rs` — `install_hook`, `surface_of`'s doc,
  `every_table_in_the_schema_has_been_decided_about`
- Modify: `src-tauri/src/sync.rs` — `with_write` checks the fence
- Modify: `src-tauri/src/lib.rs` — pass the fence at `lib.rs:488`

**Interfaces:**
- Produces: `db::CrossFileFence` with `new()`, `note(&str)`, `settle() -> bool`, `clear()`,
  `tripped() -> bool`.
- Consumes: `mirror::watch::install_hook(&Connection, Arc<Mask>, Arc<CrossFileFence>)`.

> ⚠️ **SQLite allows exactly one update hook per connection**, which `install_hook`'s doc already
> says. The fence cannot install its own; it has to ride in the existing callback. That is why this
> is one task and not two.

> ⚠️ **The update hook does not fire for `WITHOUT ROWID` tables.** Measured: an insert into
> `corpus.image_cache` produced no callback and the row was there. Thirteen tables are
> `WITHOUT ROWID` — `image_cache`, `marketplace_prices`, `muted_tags`, `art_tags`,
> `art_tag_parents`, `art_taggings`, `art_tag_illustrations`, `oracle_tags`, `oracle_tag_parents`,
> `oracle_taggings`, `oracle_tag_cards`, `cards_fts_idx`, `cards_fts_config` — twelve of them in
> the corpus. **So the fence cannot see a transaction whose only corpus-side write is to one of
> those**, and `image_cache` is the most plausible such write in the whole crate. Name the list in
> the doc; do not pretend the fence is total.
>
> The alternative was costed and declined: an `authorizer` **does** see the schema name and **does**
> fire for `WITHOUT ROWID` tables — both measured — but it fires at *prepare* time, and a
> `prepare_cached` statement re-executed does not re-authorize (measured: one callback across two
> executions). It cannot attribute a write to a transaction, which is the whole question here.

- [x] **Step 1: Write the failing test**

In `mirror/watch.rs`:

```rust
/// A transaction that writes both files commits non-atomically in WAL mode, and SQLite will
/// not say so. This is what says so.
#[test]
fn the_fence_trips_on_a_transaction_that_writes_both_files() {
    let conn = crate::schema::memory_pair();
    let mask = Arc::new(Mask::default());
    let fence = Arc::new(crate::db::CrossFileFence::new());
    install_hook(&conn, mask.clone(), fence.clone());

    conn.execute_batch(
        "BEGIN;
         INSERT INTO decks (name, format_key, created_at, updated_at)
           VALUES ('one file', 'casual', 0, 0);
         COMMIT;",
    )
    .unwrap();
    assert!(!fence.tripped(), "a user-only transaction is fine");

    conn.execute_batch(
        "BEGIN;
         INSERT INTO decks (name, format_key, created_at, updated_at)
           VALUES ('two files', 'casual', 0, 0);
         INSERT OR REPLACE INTO sets (code, name) VALUES ('zzz', 'probe');
         COMMIT;",
    )
    .unwrap();
    assert!(fence.tripped(), "a cross-file transaction must be caught");
}

/// A rolled-back transaction is not a cross-file commit, and marking one would make the
/// fence cry wolf on every failed write in the app.
#[test]
fn a_rolled_back_cross_file_transaction_does_not_trip_the_fence() {
    let conn = crate::schema::memory_pair();
    let fence = Arc::new(crate::db::CrossFileFence::new());
    install_hook(&conn, Arc::new(Mask::default()), fence.clone());
    conn.execute_batch(
        "BEGIN;
         INSERT INTO decks (name, format_key, created_at, updated_at) VALUES ('x','casual',0,0);
         INSERT OR REPLACE INTO sets (code, name) VALUES ('zzz','probe');
         ROLLBACK;",
    )
    .unwrap();
    assert!(!fence.tripped());
}

/// The mirror still sees every write it is supposed to, now that half the schema is in
/// another file — and it still sees none of the ones it is not.
#[test]
fn the_mask_is_unmoved_by_the_split() {
    let conn = crate::schema::memory_pair();
    let mask = Arc::new(Mask::default());
    install_hook(&conn, mask.clone(), Arc::new(crate::db::CrossFileFence::new()));

    conn.execute("INSERT OR REPLACE INTO sets (code, name) VALUES ('zzz','probe')", [])
        .unwrap();
    assert_eq!(dirty_of(mask.bits()), None, "a corpus write must mark nothing");

    conn.execute(
        "INSERT INTO decks (name, format_key, created_at, updated_at) VALUES ('d','casual',0,0)",
        [],
    )
    .unwrap();
    assert_eq!(dirty_of(mask.bits()), Some(DECKS_AND_COLLECTION));
}
```

And rewrite the existing guard, which reads `sqlite_master` unqualified and therefore **stops
covering the corpus the moment the split lands** — a guard that silently halves its own scope is
the failure this repo keeps naming:

```rust
    #[test]
    fn every_table_in_the_schema_has_been_decided_about() {
        let conn = crate::schema::memory_pair();
        let mut stmt = conn
            .prepare(
                "SELECT name FROM main.sqlite_master WHERE type = 'table'
                 UNION ALL
                 SELECT name FROM corpus.sqlite_master WHERE type = 'table'
                 ORDER BY name",
            )
            .unwrap();
        // …the two `assert_eq!` lists are unchanged: the same nine mapped, the same rest
        // ignored. What changed is that `sqlite_master` unqualified means `main` only, so
        // without the UNION this test would quietly stop asserting anything about the
        // twenty-five corpus tables it was written to cover.
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test mirror::watch::tests 2>&1 | tail -8`
Expected: `cannot find type CrossFileFence`, and `install_hook` taking two arguments.

- [x] **Step 3: Implement**

In `db.rs`:

```rust
/// Records whether the transaction now committing wrote to more than one of the connection's
/// databases.
///
/// **SQLite does not promise a cross-file commit is atomic in WAL mode**, and it does not
/// complain either — the commit succeeds and either file may be the one that survives a
/// power cut. There is exactly one such transaction in the crate's history
/// (`reconcile::apply`, closed in schema 27 by moving `card_migrations`), and this is what
/// stops the second one being added by somebody who did not know.
///
/// Two atomics and a `fetch_or` inside SQLite's own callback: no allocation, no lock, and
/// nothing that could call back into the database — the same budget
/// [`crate::mirror::watch::Mask`] works to, and for the same reason, since they share a hook.
///
/// # What it cannot see
///
/// **The update hook does not fire for `WITHOUT ROWID` tables** — measured, an insert into
/// `image_cache` produced no callback at all. Twelve corpus tables are `WITHOUT ROWID`:
/// `image_cache`, `marketplace_prices`, `art_tags`, `art_tag_parents`, `art_taggings`,
/// `art_tag_illustrations`, `oracle_tags`, `oracle_tag_parents`, `oracle_taggings`,
/// `oracle_tag_cards`, `cards_fts_idx` and `cards_fts_config`; `muted_tags` is the one on the
/// user side. A transaction whose *only* corpus write is to one of those is invisible here,
/// and `image_cache` is the likeliest candidate in the crate. An authorizer would see them —
/// it reports the schema name and fires for `WITHOUT ROWID` — but it fires at prepare time
/// and a cached statement re-executes without re-authorizing, so it cannot say which
/// transaction a write belonged to. This is the honest half of the fence, not the whole one.
#[derive(Debug, Default)]
pub struct CrossFileFence {
    seen: AtomicU8,
    tripped: AtomicBool,
}

impl CrossFileFence {
    const MAIN: u8 = 1 << 0;
    const ATTACHED: u8 = 1 << 1;

    pub fn new() -> Self {
        Self::default()
    }

    /// From inside the update hook. `db` is SQLite's own schema name for the write.
    pub fn note(&self, db: &str) {
        let bit = if db == "main" { Self::MAIN } else { Self::ATTACHED };
        self.seen.fetch_or(bit, Ordering::Relaxed);
    }

    /// From the commit hook. Returns whether this commit crossed the files.
    ///
    /// **Never returns anything SQLite acts on.** A commit hook that aborted here would turn
    /// a diagnostic into data loss on a user's machine over a bug in this fence.
    pub fn settle(&self) -> bool {
        let crossed = self.seen.swap(0, Ordering::Relaxed) == (Self::MAIN | Self::ATTACHED);
        if crossed {
            self.tripped.store(true, Ordering::Relaxed);
        }
        crossed
    }

    /// From the rollback hook. A transaction that did not commit did not cross anything.
    pub fn clear(&self) {
        self.seen.store(0, Ordering::Relaxed);
    }

    pub fn tripped(&self) -> bool {
        self.tripped.load(Ordering::Relaxed)
    }
}
```

In `mirror/watch.rs`, `install_hook` grows one argument and installs all three hooks:

```rust
pub fn install_hook(conn: &Connection, mask: Arc<Mask>, fence: Arc<crate::db::CrossFileFence>) {
    let marker = fence.clone();
    if let Err(e) = conn.update_hook(Some(
        move |_action: rusqlite::hooks::Action, db: &str, table: &str, _rowid: i64| {
            marker.note(db);
            if let Some(d) = surface_of(table) {
                mask.mark(d);
            }
        },
    )) {
        eprintln!("the backup mirror will not see live edits: {e}");
    }
    let settling = fence.clone();
    conn.commit_hook(Some(move || {
        if settling.settle() {
            // Said out loud rather than asserted: this is a diagnostic on a user's machine
            // and the write has already happened. `sync::with_write` is where a debug build
            // turns it into a failing test.
            eprintln!(
                "a transaction wrote to both the user database and the card database; \
                 SQLite does not guarantee those commit together"
            );
        }
        false
    }));
    let clearing = fence;
    let _ = conn.rollback_hook(Some(move || clearing.clear()));
}
```

In `sync.rs`, at the end of `with_write`: `debug_assert!(!state.fence.tripped(), "…")`. Add
`fence: Arc<crate::db::CrossFileFence>` to `AppState` beside `mirror`, for the same stated reason —
the hook holds a clone for the life of the process.

Update `surface_of`'s doc: the `None` arm's list of tables is unchanged, but say that the hook now
also reports a schema name and that the map ignores it deliberately, because a table name is
unique across both files by the registry.

- [x] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test mirror:: 2>&1 | tail -10`, then the whole suite. **A green suite
with the fence armed is itself the measurement**: every test that drives a real write path now
proves it did not cross the files. **Report whether anything tripped it** — if something did, that
is a finding, not a test to adjust.

- [x] **Step 5: Mutate to prove all three hooks are wired**

Make `note` always record `MAIN`; `the_fence_trips_on_a_transaction_that_writes_both_files` must
FAIL. Restore, and delete the `rollback_hook` install;
`a_rolled_back_cross_file_transaction_does_not_trip_the_fence` must FAIL. Restore, and drop the
`UNION ALL` from the guard test's query; `every_table_in_the_schema_has_been_decided_about` must
FAIL on the `ignored` list — **if it still passes, the corpus tables were never in that list and
the test has been vacuous since the split**, which is a finding to report rather than a mutation
that failed.

- [x] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/db.rs src-tauri/src/mirror/watch.rs src-tauri/src/sync.rs src-tauri/src/lib.rs
git commit -m "feat(db): catch a transaction that writes to both databases

SQLite allows one update hook per connection, so the fence rides in the mirror's. It reports
the schema name for every write - measured, ('corpus','cards') - and a commit hook asks
whether both bits are set. The whole test suite now runs with it armed, which is a better
proof than any audit that no path crosses the files.

Its blind spot is named rather than hidden: the update hook does not fire for WITHOUT ROWID
tables, and twelve corpus tables are - image_cache first among them. An authorizer sees
those but fires at prepare time, and a cached statement re-executes without re-authorizing,
so it cannot attribute a write to a transaction.

The mirror's own schema guard read sqlite_master unqualified, which means main; without the
UNION it would have stopped covering twenty-five tables the day the corpus moved."
```

---

## Self-Review

**Spec coverage.** This implements the storage half of spec §5.4's "two storage systems, two
eviction policies" and gives §7's sync a file to sync. It does **not** implement sync, the relay,
or any wasm wiring — the reasons are in "What this PR deliberately does not do", and the sahpool
capacity finding is recorded there so the wasm PR does not rediscover it.

**Placeholders.** One, and it is marked: `create_user_schema`'s body is written as
`CREATE TABLE IF NOT EXISTS {schema}.decks ( … )`. Spelling out fifteen tables and their indexes
verbatim in a plan would be transcribing 400 lines of DDL that must be copied from the live schema
anyway, and Task 3 Step 3 requires that the copy be *verified* by asserting byte-identical
`sqlite_master.sql` against `migrate_single_file`. That assertion is what makes the DDL correct,
not the transcription.

**Type consistency.** `Side` and `TABLES` are defined in Task 1 and consumed in Tasks 3, 4 and 5
with those exact shapes. `db::configure(&Connection, Option<&str>)` is defined in Task 2 and called
with `None` and `Some(CORPUS)` there and nowhere else. `split::convert(&Path) -> Result<bool, String>`
is defined in Task 3 and called from `schema::prepare_data_dir` in Task 4. `CrossFileFence`'s five
methods are defined in Task 6 and all five are called in Task 6.

**Four things were checked against the source rather than assumed, and this plan was wrong about
each before the check:**

- **`deck_allocations` does not exist and `deck_tags` has no `deck_id`** — both already corrected
  in the spec on 2026-08-28, both confirmed here against `pragma table_info` on the live database.
- **`muted_tags` is a user table the brief's list omits**, and it is `WITHOUT ROWID`, which makes
  it the one user table the fence in Task 6 cannot see.
- **`card_migrations` cannot be corpus-side**, and the plan's first draft filed it there because
  Scryfall produces its rows. `reconcile::apply` writes it in the same transaction as the folds it
  records; corpus-side, that transaction spans two files and the failure is a collection that grows
  by itself.
- **There are six production connections, not two.** `index::lifecycle` opens two of its own and
  the mirror opens two more, all read-only, all outside `AppState`, and all reading tables from
  both files.

**Where this costs more than the brief assumes.** Six places, in descending order:

1. **`maintenance.rs` breaks silently and completely.** `PRAGMA freelist_count`, `page_count`,
   `auto_vacuum`, `incremental_vacuum` and bare `VACUUM` all mean `main`, which after the split is
   1.3 MB. Measured: `page_count` unqualified `323` against `corpus.page_count` `192 149`. The
   module whose entire subject is the gigabyte an old `cards` leaves behind would report success
   having done nothing.
2. **The attached file inherits neither `journal_size_limit` nor `synchronous`** — `-1` and `2`
   against `main`'s `67108864` and `1`, measured on the real database. The 64 MB WAL ceiling exists
   because an ingest writes an 857 MB journal, and the ingest is corpus-side.
3. **~65 test setups across 38 files** need the split shape, or the suite tests something the app
   is not. Only `schema.rs`'s 102 legacy-ladder setups are exempt, because they build pre-split
   databases on purpose.
4. **The fence has a real blind spot.** Twelve of the twenty-five corpus tables are `WITHOUT
   ROWID`, and the update hook does not fire for them — including `image_cache`, the most plausible
   accidental cross-file write in the crate.
5. **`create_fts` is not free to move.** An external-content FTS5 index resolves `content='cards'`
   in its own schema, and it creates cleanly in the wrong one and fails on the first rebuild.
6. **`app_meta` does not split per key for storage**, only for sync. `scryfall_penalty_until` in a
   throwaway file would turn a Scryfall lockout into something a corpus rebuild shakes off — the
   exact failure the row exists to prevent — and `mirror_root` is a folder a person chose. All of
   `app_meta` is user-side, `update_release_history`'s 124 435 bytes included.

**And one correction to the spec that this plan does not fix**, because it is §7's to fix:
§7.2 lists `flatten_state` as a synced `app_meta` key. There is no such key. `flatten.rs:40` is
`K_FLATTEN: &str = "flatten"`; `flatten_state` is the command that reads it.
