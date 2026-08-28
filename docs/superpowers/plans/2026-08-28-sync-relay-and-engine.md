# Sync, PR 7 — The Relay And The Conflict Engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every device works fully offline against its own SQLite and reconciles on reconnect through one Cloudflare Durable Object that can decrypt nothing — and when two devices changed the same thing, the five rules in §7.3 decide, silently where they can and with a sentence in `needs_review` where they cannot.

**Architecture:** A new Rust module tree `src-tauri/src/sync_engine/`. `hlc` is the hybrid logical clock. `capture` generates the SQLite triggers that turn every local write into a row in `sync_ops`, inside the caller's own transaction. `merge` is the five conflict rules as pure functions over ops. `apply` writes a merged result back, resolving foreign uids to local ids, breaking folder cycles and setting `needs_review`. `wire` is the encrypted envelope, batched at 200 ops per stored row. `client` pushes and pulls over `reqwest`. And `relay/` is a Cloudflare Worker with one SQLite-backed Durable Object per pairing group, whose compaction and retention are pure TypeScript functions tested by the root vitest.

**Tech Stack:** Rust 2021, `rusqlite`, `reqwest` (already present, `rustls-tls` + `stream`), `serde_json`, plus PR 6's `chacha20poly1305`. TypeScript 6 for the Worker, with `@cloudflare/workers-types` as its only new devDependency. No new npm runtime dependency.

**Spec:** [`docs/superpowers/specs/2026-08-27-cross-platform-design.md`](../specs/2026-08-27-cross-platform-design.md) §7.2 (what syncs), §7.3 (conflict semantics), §7.4 (what the reader sees), §7.7 (the relay), and §2's architectural rule.

**Depends on:** [PR 6](2026-08-28-sync-pairing.md) — `sync_pair::identity` supplies the device id and the group key this plan encrypts with, and `sync_identity`/`sync_group`/`sync_devices` are the tables its triggers read.

---

## The architectural judgement: the conflict engine is Rust's

This is the one decision in this plan that another decision could not be swapped for later, so it is argued here rather than assumed.

**The rule is "Rust supplies facts, TypeScript draws conclusions".** The test that rule actually applies is not "is this logic?" — plenty of Rust in this crate is logic — it is **whose question is being answered.** TypeScript owns the questions that are about *Magic and about the reader's intent*: whether a decklist is legal, what a Commander bracket means, what a Spellbook letter implies, how a category should be filed, what sentence an audit row reads as. Rust owns the questions that are about *what is in the database*.

"Two devices each added one copy and the row must end at +2" is the second kind. It is not a statement about Magic; it is a statement about rows. And this repo has already settled the closest possible case in Rust's favour: **`reconcile.rs`** takes two versions of the user's own rows, folds duplicates, carries provenance onto the survivor, and writes `needs_review` sentences — all in Rust, all inside one transaction, and nobody has ever suggested it belonged in the page.

Three further reasons, each of which is independently sufficient:

1. **The engine must be transactional with the writes it makes.** An apply that resolves a foreign uid to a local id, sums three counters, breaks a folder cycle and sets `needs_review` has to do all of that or none of it. Only Rust holds the connection. A TypeScript engine would need every intermediate row image to cross the IPC boundary and back — a wider surface than all 136 existing commands put together, and one that is not atomic at any point.
2. **It has to run when no page is open.** A background reconcile is exactly the moment nobody is watching the screen, which is the argument `reconcile.rs`'s own module doc already makes about the id-migration sweep.
3. **It has to be one implementation on three targets.** The wasm core is this same crate. A TypeScript engine would run in the page on desktop and Android and in the Worker on web — three environments, one of which cannot reach the connection at all without another hop.

**What stays in TypeScript, and this is not a residue:** the pairing panel and the relay-URL setting; the review queue that surfaces `needs_review` rows and what a reader is offered to do about one; the query invalidation after a pull; and every sentence *about* sync that is not stored in the database. The engine hands the page facts — "these rows changed", "this row needs review", "the last pull was at T" — and the page decides what a person sees.

**The one thing that is genuinely borderline, and how it is settled:** `needs_review` holds a *sentence*, and `deck_audit`'s rule is that Rust records what happened and TypeScript writes the sentence. That rule is not extended here, because `needs_review` already holds Rust-written sentences — `reconcile.rs` writes four of them today. One column with two conventions is worse than either convention, so the engine follows the column rather than the neighbouring table.

---

## Global Constraints

Copied from the spec and the repo's `CLAUDE.md`; every task's requirements implicitly include these.

> ## ⛔ Never create a Cloudflare resource
>
> **No agent provisions anything.** Not an account, not a Worker, not a Durable Object, not a
> namespace, not a domain, not an API token. `wrangler deploy`, `wrangler kv`, `wrangler d1`,
> `wrangler secret put` and every `mcp__plugin_cloudflare_*` tool are **out of bounds for every
> step in this plan.** `wrangler dev --local` — which runs workerd on this machine, contacts
> nothing and needs no login — is the only wrangler command any step may run, and even that is
> optional: every relay test in Task 8 is a plain vitest over pure functions.
>
> **A task that needs a real resource stops and asks Markus, with the numbers.** The numbers to
> bring, all verified 2026-08-27: Workers free tier is **100 000 requests/day and 10 ms CPU per
> invocation**; Durable Objects **are on the free plan, SQLite-backed only** — 100 000 req/day,
> 13 000 GB-s/day, 5 GB storage, 5 M row reads/day, **100 000 rows written/day**. The modelled
> load for three devices at 50 edits/day is **~1 440 requests/day (1.4%)**, a **~484 KB** log
> (0.01% of 5 GB) and **~3 rows written/day** (0.003%). The one case that approaches a limit is a
> bulk import: 50 000 rows one-op-per-row would spend half a day's write budget, and batching at
> 200 ops per stored row makes it **250 writes**. That batch size is derived from the limit.
>
> **KV is ruled out of the hot path** — 1 000 writes/day on the free plan. **No R2.** One
> SQLite-backed Durable Object per pairing group, and nothing else.

- `npm run verify` before every commit. It does **not** run `cargo fmt` or `clippy`; CI does, and those are the only reds a fully green verify can produce. Run both in `src-tauri/` before each commit.
- **Redirect `npm run verify` to a file and grep it.** Piping to `tail` reports tail's exit code while tests fail underneath.
- **Never install `@types/node`.** `xlsx` is banned. TypeScript stays on 6.0.x.
- `clippy` caps function arguments at 7.
- **Never hand-write rows into `cards` or `sync_meta`.** Tests use `Connection::open_in_memory()` plus `crate::schema::migrate`.
- **A new migration step goes at the *bottom* of the ladder and takes the next free number.** This plan says **v28**, assuming PR 6 landed v27. **Read `schema::SCHEMA_VERSION` at the moment you land** — a spent version is spent.
- **A new table must be decided about in `mirror::watch::surface_of`**, or `watch::tests::every_table_in_the_schema_has_been_decided_about` goes red.
- **`data/` is the user's and is never committed.**
- Commit messages use `feat:` / `fix:` / `chore:` / `test:` / `refactor:`.

### The correction this plan makes to §7.2's table list, and why it is not a re-litigation

§7.2 and the parity matrix both name **twelve** synced tables, and one of them — **`deck_allocations` — does not exist.** Schema v25 dropped it (`schema.rs`: `DROP TABLE deck_allocations;`, and the module doc's line *"`deck_allocations.deck_id` and `deck_allocations.collection_entry_id` left this list at schema v25, with their table"*). Which deck holds a card is now which folder its row sits in.

So the synced set is **eleven tables**, and the eleventh's work did not vanish — it moved into `collection_folders`, which is already on the list. Nothing about §7.2's *intent* changes; a table that no longer exists simply cannot be one of the twelve.

**The eleven, verified against `schema.rs` at head:**

`collection_entries` · `collection_folders` · `decks` · `deck_cards` · `deck_categories` · `deck_folders` · `deck_audit` · `deck_tags` · `wishlist_entries` · `wishlist_folders` · `muted_tags`

Two further corrections found the same way:

- **`deck_tags` has no `deck_id`.** §7.2 describes it as `(id, deck_id, name, color, created_at, updated_at)`. Schema **v21** rebuilt it as `(id, name, name_key, color, created_at, updated_at)` — one app-wide list, uniquely keyed on `name_key`. That matters here more than anywhere: two devices typing "Ramp" must converge on **one** row, because `idx_deck_tags_grain` is `UNIQUE (name_key)` and a second row is a constraint failure at apply time.
- **`needs_review` is on three tables, not two.** §7.4 names `collection_entries` and `deck_cards`; `wishlist_entries` has it too (schema v4). **No folder table has it at all** — and §7.4's second surfaced outcome is a broken folder cycle. Task 1 adds the column to `deck_folders`, `wishlist_folders` and `collection_folders`, because §7.4 says to reuse the mechanism and the mechanism has to exist on the table it names.

### The other thing §7 leaves open, and what this plan decides

**A row's identity across devices.** Every synced table keys on `INTEGER PRIMARY KEY` — a rowid. Two devices independently create a deck and both get `id = 1`. §7 never says what an op names a row by, and nothing in it works until that is answered.

**Decided: every synced row carries a minted `sync_uid`, and the applier resolves by *grain first, uid second*, with a `min(uid)` tiebreak.**

- A minted uid alone is wrong on its own, and the counter rule is what proves it: two devices each adding one copy of the same printing to the same folder mint two uids, and inserting both is two rows at +1 rather than one row at +2 — the exact failure §7.3's first row exists to prevent, plus a violation of `idx_collection_grain`.
- A grain alone is wrong too: `decks`, the three folder tables and `deck_audit` have **no** unique index, so two devices' folders named "Binder" are two folders and must stay two.
- So both. On apply, the engine looks for a local row on the incoming op's **logical grain** — the table's own unique index with every foreign local id replaced by that parent's `sync_uid`. If it finds one, that is the row, and **both devices set the row's uid to the lower of the two**, which is deterministic and needs no alias table. If it does not, it looks by uid. If neither, it inserts.

The six grains, read off `schema.rs`'s own constants rather than guessed:

| Table | Logical grain | Constant |
| --- | --- | --- |
| `collection_entries` | `card_id, finish, condition, lang, altered, signed, proxy, misprint, serial_number, grading, folder_uid` | `COLLECTION_GRAIN` (11 terms) |
| `wishlist_entries` | `oracle_id, card_id, preferred_finish, folder_uid` | `WISHLIST_GRAIN` |
| `deck_cards` | `deck_uid, variant, category_uid, card_id, finish` | `DECK_CARD_GRAIN` (**five** terms — `finish` joined at v19) |
| `deck_categories` | `deck_uid, name` | `DECK_CATEGORY_GRAIN` |
| `deck_tags` | `name_key` | `DECK_TAG_GRAIN` |
| `muted_tags` | `namespace, tag_id` | its `PRIMARY KEY` |

`decks`, `deck_folders`, `collection_folders`, `wishlist_folders` and `deck_audit` have no grain and are uid-only.

---

### Task 1: Schema v28 — identity, the op log, the clock, and the columns §7.4 needs

**Files:**
- Modify: `src-tauri/src/schema.rs`
- Modify: `src-tauri/src/mirror/watch.rs` — the census
- Modify: `src-tauri/src/errors.rs` — a `Relay` source
- Modify: `src/lib/ipc.ts` — `ErrorSource` gains `"relay"`
- Modify: `src/features/settings/ErrorLogPanel.tsx` — `SOURCE_LABEL` gains its row

**Interfaces:**
- Consumes: PR 6's `sync_identity` / `sync_group`.
- Produces: `sync_uid` on eleven tables; `needs_review` on three folder tables; tables `sync_ops`, `sync_clock`, `sync_state`, `sync_peers`; `errors::Source::Relay`.

> ⚠️ **`ALTER TABLE … ADD COLUMN` cannot carry a non-constant DEFAULT**, which `lower(hex(randomblob(16)))` is — SQLite's documented restriction list, and the v26 step's comment enumerates it. So the uid arrives as a plain nullable column, is backfilled by an `UPDATE`, and is minted for new rows by the same trigger Task 3 installs.

> ⚠️ **`error_log.source` is CHECK-constrained**, so adding `relay` is a table rebuild rather than an `ALTER`. The table is capped at `errors::MAX_ROWS` = 200, so the rebuild is cheap; what it is not is optional, because `Record<ErrorSource, string>` in `ErrorLogPanel.tsx` is total and a new Rust arm is a type error there by design.

- [ ] **Step 1: Write the failing test**

Append inside `schema.rs`'s existing `mod tests`:

```rust
/// Every synced table carries `sync_uid`, and every existing row got one that is unique.
#[test]
fn v28_gives_every_synced_row_a_unique_uid() {
    let conn = v27_database();
    conn.execute_batch(
        "INSERT INTO decks (name, format_key, created_at, updated_at)
              VALUES ('A', 'commander', unixepoch(), unixepoch()),
                     ('B', 'commander', unixepoch(), unixepoch());
         INSERT INTO collection_entries
              (card_id,set_code,collector_number,lang,finish,condition,quantity,
               created_at,updated_at)
              VALUES ('c1','lea','1','en','nonfoil','NM',1,unixepoch(),unixepoch()),
                     ('c2','lea','2','en','foil','NM',1,unixepoch(),unixepoch());",
    )
    .unwrap();

    migrate(&conn).unwrap();

    for t in SYNCED_TABLES {
        let n: i64 = conn
            .query_row(
                &format!("SELECT count(*) FROM pragma_table_info('{t}') WHERE name = 'sync_uid'"),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "{t} has no sync_uid");
    }

    let (rows, uids): (i64, i64) = conn
        .query_row(
            "SELECT count(*), count(DISTINCT sync_uid) FROM decks",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(rows, 2);
    assert_eq!(uids, 2, "two rows must not share one uid");

    let nulls: i64 = conn
        .query_row(
            "SELECT count(*) FROM collection_entries WHERE sync_uid IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(nulls, 0, "the backfill must reach every existing row");
}

/// §7.4's second surfaced outcome is a broken folder cycle, and no folder table had anywhere
/// to say so.
#[test]
fn v28_gives_the_three_folder_tables_a_needs_review_column() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    for t in ["deck_folders", "wishlist_folders", "collection_folders"] {
        let n: i64 = conn
            .query_row(
                &format!(
                    "SELECT count(*) FROM pragma_table_info('{t}') WHERE name = 'needs_review'"
                ),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "{t} cannot say a cycle was broken");
    }
}

/// The op log, the clock and the two bookkeeping tables.
#[test]
fn v28_creates_the_op_log_and_its_clock() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    for t in ["sync_ops", "sync_clock", "sync_state", "sync_peers"] {
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![t],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "{t} is missing");
    }
    // The clock is seeded, because a trigger that joined an empty table would write no op at
    // all — silently, which is the worst possible way for a sync to not happen.
    let ticks: i64 = conn
        .query_row("SELECT count(*) FROM sync_clock", [], |r| r.get(0))
        .unwrap();
    assert_eq!(ticks, 1);
}

/// The error log can name the relay.
#[test]
fn v28_lets_the_error_log_name_the_relay() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    conn.execute(
        "INSERT INTO error_log (first_at,last_at,source,operation,kind,message)
         VALUES (0,0,'relay','pull','timeout','no answer')",
        [],
    )
    .expect("the CHECK must permit 'relay'");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test schema::tests::v28 2>&1 | tail -20`
Expected: compile error — `cannot find value SYNCED_TABLES in this scope`.

- [ ] **Step 3: Write the census, then the migration step**

Near `COLLECTION_GRAIN`, a public constant every later task reads:

```rust
/// The tables a pairing group keeps in step — spec §7.2, corrected against this file.
///
/// **Eleven and not twelve.** The spec's list names `deck_allocations`, which schema v25
/// dropped: which deck holds a card is now which folder its row sits in, so the work that table
/// did is inside `collection_folders`, which is on this list. A table that does not exist cannot
/// be synced, and the count moved rather than the intent.
///
/// **Sorted, and `sync_engine::capture::every_synced_table_is_on_the_census` holds it to
/// `sqlite_master`.** A new user table that nobody decides about is a table whose writes never
/// reach the other devices — silently, and forever, which is `watch::surface_of`'s hazard one
/// module over and the reason that map has a census of its own.
pub const SYNCED_TABLES: [&str; 11] = [
    "collection_entries",
    "collection_folders",
    "deck_audit",
    "deck_cards",
    "deck_categories",
    "deck_folders",
    "deck_tags",
    "decks",
    "muted_tags",
    "wishlist_entries",
    "wishlist_folders",
];
```

At the **bottom** of `migrate`:

```rust
    if v < 28 {
        let tx = conn.unchecked_transaction()?;
        // **A row needs a name every device agrees on, and a rowid is not one.** Two devices
        // independently create a deck and both call it `id = 1`. `sync_uid` is 16 random bytes
        // as hex, minted per row; what makes two devices' uids converge on one *logical* row is
        // the applier's grain rule, not this column — see the plan and `sync_engine::apply`.
        //
        // **A plain nullable column and then an UPDATE**, because `ALTER TABLE … ADD COLUMN`
        // refuses a non-constant DEFAULT — SQLite's own restriction list, which the v26 step
        // enumerates — and `lower(hex(randomblob(16)))` is about as non-constant as they come.
        // New rows get theirs from the trigger `sync_engine::capture` installs.
        for table in SYNCED_TABLES {
            tx.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN sync_uid TEXT;"))?;
            tx.execute_batch(&format!(
                "UPDATE {table} SET sync_uid = lower(hex(randomblob(16)));"
            ))?;
            // UNIQUE rather than plain: two rows sharing a uid is a merge that silently folds
            // two of the reader's rows into one, and it must fail at the write instead.
            tx.execute_batch(&format!(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_{table}_uid ON {table} (sync_uid);"
            ))?;
        }

        // §7.4's second surfaced outcome. `needs_review` is documented on the three entry
        // tables as "a sentence here means the row needs the user's attention"; a folder whose
        // cycle was broken needs exactly that, and had nowhere to say it.
        tx.execute_batch(
            "ALTER TABLE deck_folders ADD COLUMN needs_review TEXT;
             ALTER TABLE wishlist_folders ADD COLUMN needs_review TEXT;
             ALTER TABLE collection_folders ADD COLUMN needs_review TEXT;",
        )?;

        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS sync_ops (
                 -- Local insertion order, and the push cursor. Never sent: another device's
                 -- ordering is its own, and the hybrid logical clock is what orders across them.
                 seq INTEGER PRIMARY KEY,
                 tbl TEXT NOT NULL,
                 uid TEXT NOT NULL,
                 -- `put` covers insert and update alike, because row existence is ADD-WINS
                 -- (§7.3): a put that arrives after a delete resurrects the row, and having
                 -- one verb for both is what makes that a rule rather than a special case.
                 kind TEXT NOT NULL CHECK (kind IN ('put','del')),
                 -- The scalar fields that CHANGED, and only those. Last-writer-wins is per
                 -- FIELD (§7.3), so an op carrying every column would clobber a field it never
                 -- touched — one device editing a note would undo another's price edit, which
                 -- is the precise failure that row of the table exists to prevent.
                 fields TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fields)),
                 -- Counter DELTAS, never values. Two devices each adding one copy must end at
                 -- +2; a value ends at +1 and silently loses a card.
                 counters TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(counters)),
                 -- Foreign rows named by THEIR uid: folder, deck, category, tag. A local id
                 -- means nothing on the far device.
                 parents TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(parents)),
                 hlc_ms INTEGER NOT NULL,
                 hlc_ctr INTEGER NOT NULL,
                 device_id TEXT NOT NULL,
                 -- NULL until the relay has taken it. The push cursor is `MIN(seq) WHERE NULL`.
                 pushed_at INTEGER
             );
             CREATE INDEX IF NOT EXISTS idx_sync_ops_unpushed
                 ON sync_ops (seq) WHERE pushed_at IS NULL;
             CREATE INDEX IF NOT EXISTS idx_sync_ops_row ON sync_ops (tbl, uid);

             -- The hybrid logical clock, as one row. Physical millis, a logical counter, and
             -- the device id (in `sync_identity`) as the deterministic tiebreak — §7.3, and
             -- no server clock anywhere in it.
             CREATE TABLE IF NOT EXISTS sync_clock (
                 id INTEGER PRIMARY KEY CHECK (id = 1),
                 ms INTEGER NOT NULL,
                 ctr INTEGER NOT NULL
             );
             -- **Seeded here and not lazily.** Every capture trigger joins this table, and a
             -- join against an empty table produces no row — so a missing seed is a device that
             -- records no ops at all, silently, which is the worst way for a sync to not happen.
             INSERT OR IGNORE INTO sync_clock (id, ms, ctr) VALUES (1, 0, 0);

             -- The relay URL, the pull cursor, the apply guard, and the last error. A key/value
             -- table rather than columns because these four have nothing to do with each other.
             CREATE TABLE IF NOT EXISTS sync_state (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             ) WITHOUT ROWID;

             -- How far this device has consumed each peer's stream. **The high-water mark is
             -- what makes a counter idempotent**: an op replayed after a reconnect must add its
             -- delta once, and comparing against this is the only thing standing between a
             -- dropped connection and a collection that grows by itself.
             CREATE TABLE IF NOT EXISTS sync_peers (
                 device_id TEXT PRIMARY KEY,
                 last_ms INTEGER NOT NULL,
                 last_ctr INTEGER NOT NULL
             ) WITHOUT ROWID;",
        )?;

        // **The error log learns the relay, and it costs a rebuild** — `source` is inside a
        // CHECK and SQLite has no `ALTER … CHECK`. 200 rows at most (`errors::MAX_ROWS`), so
        // the copy is cheap; what it is not is optional, since `Record<ErrorSource, string>` in
        // `ErrorLogPanel.tsx` is total and a new Rust arm is a type error there by design.
        tx.execute_batch(
            "CREATE TABLE error_log_v28 (
                 id INTEGER PRIMARY KEY,
                 first_at INTEGER NOT NULL,
                 last_at INTEGER NOT NULL,
                 source TEXT NOT NULL CHECK (source IN
                     ('scryfall_api','scryfall_image','github_update','database','image_store',
                      'relay')),
                 operation TEXT NOT NULL,
                 kind TEXT NOT NULL CHECK (kind IN
                     ('rate_limited','timeout','http','io','parse','other')),
                 message TEXT NOT NULL,
                 detail TEXT,
                 count INTEGER NOT NULL DEFAULT 1 CHECK (count > 0)
             );
             INSERT INTO error_log_v28
                 (id, first_at, last_at, source, operation, kind, message, detail, count)
                 SELECT id, first_at, last_at, source, operation, kind, message, detail, count
                   FROM error_log;
             DROP TABLE error_log;
             ALTER TABLE error_log_v28 RENAME TO error_log;
             CREATE UNIQUE INDEX IF NOT EXISTS idx_error_log_grain
                 ON error_log (source, operation, kind, message);
             CREATE INDEX IF NOT EXISTS idx_error_log_recent ON error_log (last_at DESC);",
        )?;

        tx.execute_batch("PRAGMA user_version = 28;")?;
        tx.commit()?;
    }
```

`SCHEMA_VERSION` becomes 28.

- [ ] **Step 4: `UNDO_V28`, the fixtures, and the census**

```rust
    /// And v28's uids, its op log and the error log's widened CHECK.
    ///
    /// **The longest rewind on this ladder, and every line of it is owed.** `ADD COLUMN` is not
    /// idempotent ([`UNDO_V13`]'s loud reason), so a fixture that kept `sync_uid` dies at
    /// `duplicate column name` on the way back up — a failure no real upgrade can produce. The
    /// unique indexes have to go first, because `DROP COLUMN` refuses a column an index names.
    /// The `error_log` half is rewound by rebuilding it narrow again: a fixture below v28 that
    /// kept the widened CHECK would accept a `relay` row while claiming to be a version that
    /// never had one.
    ///
    /// **It runs first, before [`UNDO_V27`]**, for that constant's stated reason.
    const UNDO_V28: &str = "DROP TABLE IF EXISTS sync_peers;
         DROP TABLE IF EXISTS sync_state;
         DROP TABLE IF EXISTS sync_clock;
         DROP TABLE IF EXISTS sync_ops;
         ALTER TABLE deck_folders DROP COLUMN needs_review;
         ALTER TABLE wishlist_folders DROP COLUMN needs_review;
         ALTER TABLE collection_folders DROP COLUMN needs_review;
         DROP INDEX IF EXISTS idx_collection_entries_uid;
         DROP INDEX IF EXISTS idx_collection_folders_uid;
         DROP INDEX IF EXISTS idx_deck_audit_uid;
         DROP INDEX IF EXISTS idx_deck_cards_uid;
         DROP INDEX IF EXISTS idx_deck_categories_uid;
         DROP INDEX IF EXISTS idx_deck_folders_uid;
         DROP INDEX IF EXISTS idx_deck_tags_uid;
         DROP INDEX IF EXISTS idx_decks_uid;
         DROP INDEX IF EXISTS idx_muted_tags_uid;
         DROP INDEX IF EXISTS idx_wishlist_entries_uid;
         DROP INDEX IF EXISTS idx_wishlist_folders_uid;
         ALTER TABLE collection_entries DROP COLUMN sync_uid;
         ALTER TABLE collection_folders DROP COLUMN sync_uid;
         ALTER TABLE deck_audit DROP COLUMN sync_uid;
         ALTER TABLE deck_cards DROP COLUMN sync_uid;
         ALTER TABLE deck_categories DROP COLUMN sync_uid;
         ALTER TABLE deck_folders DROP COLUMN sync_uid;
         ALTER TABLE deck_tags DROP COLUMN sync_uid;
         ALTER TABLE decks DROP COLUMN sync_uid;
         ALTER TABLE muted_tags DROP COLUMN sync_uid;
         ALTER TABLE wishlist_entries DROP COLUMN sync_uid;
         ALTER TABLE wishlist_folders DROP COLUMN sync_uid;
         CREATE TABLE error_log_pre28 (
             id INTEGER PRIMARY KEY,
             first_at INTEGER NOT NULL,
             last_at INTEGER NOT NULL,
             source TEXT NOT NULL CHECK (source IN
                 ('scryfall_api','scryfall_image','github_update','database','image_store')),
             operation TEXT NOT NULL,
             kind TEXT NOT NULL CHECK (kind IN
                 ('rate_limited','timeout','http','io','parse','other')),
             message TEXT NOT NULL,
             detail TEXT,
             count INTEGER NOT NULL DEFAULT 1 CHECK (count > 0)
         );
         INSERT INTO error_log_pre28 SELECT * FROM error_log WHERE source <> 'relay';
         DROP TABLE error_log;
         ALTER TABLE error_log_pre28 RENAME TO error_log;
         CREATE UNIQUE INDEX IF NOT EXISTS idx_error_log_grain
             ON error_log (source, operation, kind, message);
         CREATE INDEX IF NOT EXISTS idx_error_log_recent ON error_log (last_at DESC);";
```

Then prepend `{UNDO_V28} ` to **every** rewind chain, and add `schema_at_27` / `v27_database` beside PR 6's `schema_at_26`. Pin the count on both sides of the edit:

```bash
cd src-tauri && grep -c "UNDO_V27" src/schema.rs   # note it
# ...edit...
cd src-tauri && grep -c "UNDO_V28" src/schema.rs   # must be that number + 2 (its own def + its own doc line)
```

**If the counts do not line up, a fixture was missed** — and a missed fixture is a test that walks up through a rung it never undid.

- [ ] **Step 5: The mirror census, and `errors::Source::Relay`**

In `watch.rs`'s `ignored` array, in sorted position (between `sets` and `sync_devices`):

```rust
                "sets",
                // Sync's four (schema v28). The op log is derived from the very tables the
                // mirror already watches, so a surface here would render every file twice for
                // one write; the clock, the cursor table and the peer watermarks describe a
                // conversation rather than a collection.
                "sync_clock",
                "sync_devices",
                "sync_group",
                "sync_identity",
                "sync_meta",
                "sync_ops",
                "sync_peers",
                "sync_state",
```

In `errors.rs`, the enum and its string:

```rust
    /// The pairing relay — a push or a pull that did not land. Its own source rather than
    /// `Database`, because the fix is a network and not a query.
    Relay,
```
```rust
            Source::Relay => "relay",
```

In `ipc.ts`: `export type ErrorSource = "scryfall_api" | … | "image_store" | "relay";`
In `ErrorLogPanel.tsx`: `relay: "Sync",` — named for what the reader controls, never for how it is built.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd src-tauri && cargo test schema:: 2>&1 | tail -12
cd src-tauri && cargo test mirror::watch 2>&1 | tail -12
cd src-tauri && cargo test errors:: 2>&1 | tail -12
npm run test:run -- src/features/settings/ErrorLogPanel.test.tsx 2>&1 | tail -8
```

- [ ] **Step 7: Prove the migration on the real dev database, not only on a fixture**

A worktree is a fresh install and can never show an upgrade bug. Copy the main checkout's `mtg.db` — which lags several rungs — and drive `migrate` over it from a throwaway `cargo test`:

```powershell
Copy-Item D:\Code\mtg-grimoire\src-tauri\target\debug\data\mtg.db `
          $env:TEMP\mtg-v28-probe.db
```

Then a `#[test] #[ignore]` that opens that copy, runs `migrate`, and asserts `count(*) = count(DISTINCT sync_uid)` on all eleven tables and `user_version = 28`. Run it with `cargo test -- --ignored migrate_the_real_database`. **Report the row counts it saw.** A backfill that is unique over two fixture rows and collides over 8 000 real ones is exactly the bug a fixture cannot show.

- [ ] **Step 8: Mutate to prove the fences bite**

1. Change the backfill to `UPDATE {table} SET sync_uid = 'same'`. `v28_gives_every_synced_row_a_unique_uid` must FAIL — **and check *which* assertion fails.** If it dies on the `CREATE UNIQUE INDEX` instead, that is the database catching it, which is also a pass for this mutation. Revert.
2. Remove `"relay"` from the new CHECK list. `v28_lets_the_error_log_name_the_relay` must FAIL. Revert.
3. Remove the `INSERT OR IGNORE INTO sync_clock` seed. `v28_creates_the_op_log_and_its_clock` must FAIL on the tick count. Revert. **This one matters most**: without the seed nothing errors, and Task 3's triggers silently record nothing.

**Stop and report if any survives.**

- [ ] **Step 9: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/schema.rs src-tauri/src/mirror/watch.rs src-tauri/src/errors.rs src/lib/ipc.ts src/features/settings/ErrorLogPanel.tsx
git commit -m "feat(sync): schema v28 - a name every device agrees on, and the op log

Every synced row gains sync_uid, because a rowid is not an identity: two devices
independently create a deck and both call it id 1. The column is nullable-then-backfilled
because ADD COLUMN refuses a non-constant DEFAULT, which randomblob very much is.

SYNCED_TABLES is ELEVEN and not the spec's twelve. The spec names deck_allocations, which
schema v25 dropped - which deck holds a card is now which folder its row sits in, so that
table's work is inside collection_folders, which is on the list. The count moved; the intent
did not.

The three folder tables gain needs_review. §7.4 says a broken folder cycle is surfaced
through that column and no folder table had one.

sync_clock is seeded in the same statement that creates it. Every capture trigger joins it,
and a join against an empty table writes no op - silently, which is the worst way for a sync
to not happen."
```

---

### Task 2: `sync_engine::hlc` — the hybrid logical clock

**Files:**
- Create: `src-tauri/src/sync_engine/mod.rs`, `src-tauri/src/sync_engine/hlc.rs`
- Modify: `src-tauri/src/lib.rs` — `pub mod sync_engine;` between `pub mod sync;` and `pub mod sync_pair;`

**Interfaces:**
- Produces: `hlc::Hlc { ms: i64, ctr: i64, device: String }` with `Ord`, `hlc::Hlc::tick(prev, wall) -> Hlc`, `hlc::Hlc::observe(prev, remote, wall) -> Hlc`.

> **No server clock, and that is what the counter is for.** Two devices whose wall clocks disagree by an hour still order deterministically, because the logical counter breaks a tie on millis and the device id breaks a tie on the counter. The device id is the *last* term, never the first: making it first would order every op by whose machine it was on, which is not an ordering, it is an alphabet.

- [ ] **Step 1: Declare the module, then write the failing test**

`sync_engine/mod.rs`:

```rust
//! Keeping a pairing group's databases in step.
//!
//! Six layers, and only two of them touch SQLite:
//!
//! * [`hlc`] — the hybrid logical clock. Pure.
//! * [`capture`] — the triggers that turn a local write into a row in `sync_ops`, inside the
//!   caller's own transaction.
//! * [`merge`] — §7.3's five rules, as pure functions over ops.
//! * [`apply`] — writing a merged result back: uid resolution, cycle-breaking, `needs_review`.
//! * [`wire`] — the encrypted envelope, batched at 200 ops per stored row.
//! * [`client`] — push and pull over `reqwest`.
//!
//! **The conflict rules live here rather than in TypeScript**, and the argument is in the plan
//! that built this module: "two devices each added one copy and the row must end at +2" is a
//! statement about rows rather than about Magic, an apply has to be transactional with the
//! writes it makes, and [`crate::reconcile`] already merges two versions of the user's own rows
//! and writes `needs_review` sentences from Rust.

pub mod hlc;
```

Add `pub mod sync_engine;` to `lib.rs` **before** the first red step.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn h(ms: i64, ctr: i64, device: &str) -> Hlc {
        Hlc { ms, ctr, device: device.to_owned() }
    }

    /// A tick under a moving wall clock takes the wall's time and resets the counter.
    #[test]
    fn a_tick_follows_the_wall_clock_when_it_moved() {
        let next = Hlc::tick(&h(1_000, 7, "a"), 2_000);
        assert_eq!((next.ms, next.ctr), (2_000, 0));
    }

    /// A tick within the same millisecond bumps the counter instead — which is the whole
    /// reason the counter exists, since a burst of writes shares one millisecond.
    #[test]
    fn a_tick_inside_one_millisecond_bumps_the_counter() {
        let next = Hlc::tick(&h(1_000, 7, "a"), 1_000);
        assert_eq!((next.ms, next.ctr), (1_000, 8));
    }

    /// A wall clock that went BACKWARDS must not make the clock go backwards. A user setting
    /// their system time back an hour is the ordinary case, not the exotic one.
    #[test]
    fn a_backwards_wall_clock_cannot_move_the_clock_back() {
        let next = Hlc::tick(&h(5_000, 0, "a"), 1_000);
        assert_eq!(next.ms, 5_000, "the clock never retreats");
        assert_eq!(next.ctr, 1);
        assert!(next > h(5_000, 0, "a"));
    }

    /// Observing a remote op from the future pulls this clock up past it, so anything written
    /// afterwards genuinely sorts after what was seen.
    #[test]
    fn observing_a_future_op_pulls_the_clock_past_it() {
        let next = Hlc::observe(&h(1_000, 0, "a"), &h(9_000, 3, "b"), 1_100);
        assert!(next > h(9_000, 3, "b"), "{next:?} must sort after what it saw");
    }

    /// The device id is the tiebreak and it is the LAST term. Two ops in one millisecond with
    /// one counter are ordered by device, deterministically and identically on both machines.
    #[test]
    fn the_device_id_breaks_a_tie_and_never_leads() {
        assert!(h(1, 0, "a") < h(1, 0, "b"));
        // ...but it never outranks the millis or the counter.
        assert!(h(1, 0, "z") < h(2, 0, "a"));
        assert!(h(1, 0, "z") < h(1, 1, "a"));
    }

    /// Ordering is total and agrees with itself, which is what "deterministic tiebreak" means:
    /// every device sorting the same set gets the same list.
    #[test]
    fn sorting_is_total_and_stable_across_shuffles() {
        let mut a = vec![h(2, 0, "b"), h(1, 5, "a"), h(2, 0, "a"), h(1, 5, "z")];
        let mut b = vec![h(1, 5, "z"), h(2, 0, "a"), h(2, 0, "b"), h(1, 5, "a")];
        a.sort();
        b.sort();
        assert_eq!(a, b);
        assert_eq!(a[0], h(1, 5, "a"));
        assert_eq!(a[3], h(2, 0, "b"));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test sync_engine::hlc 2>&1 | tail -20`
Expected: compile error — `cannot find type Hlc in this scope`.

- [ ] **Step 3: Write the implementation**

```rust
//! The hybrid logical clock — §7.3's ordering, with no server clock in it.
//!
//! Physical millis, a logical counter, and the device id as the deterministic tiebreak, **in
//! that order**. The order is the design: leading with the device id would sort every op by
//! whose machine it was written on, which is not an ordering, it is an alphabet.

use serde::{Deserialize, Serialize};

/// One point on the group's shared timeline.
///
/// `Ord` is derived, and the field order below **is** the comparison — moving `device` above
/// `ctr` would silently change what "later" means for the whole engine.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hlc {
    pub ms: i64,
    pub ctr: i64,
    pub device: String,
}

impl Hlc {
    /// The next stamp this device issues.
    ///
    /// **`max` and not assignment**, because a wall clock that went backwards is the ordinary
    /// case rather than the exotic one — a reader correcting their system time, a laptop coming
    /// back from sleep. A clock that retreated would issue a stamp that sorts *before* ops
    /// already written, and every last-writer-wins decision made against it would be wrong.
    pub fn tick(prev: &Hlc, wall_ms: i64) -> Hlc {
        let ms = prev.ms.max(wall_ms);
        Hlc {
            ms,
            ctr: if ms == prev.ms { prev.ctr + 1 } else { 0 },
            device: prev.device.clone(),
        }
    }

    /// The next stamp after seeing somebody else's.
    ///
    /// This is what makes the clock *causal*: anything written after an op was received sorts
    /// after it, on every device, whatever the two wall clocks think.
    pub fn observe(prev: &Hlc, remote: &Hlc, wall_ms: i64) -> Hlc {
        let ms = prev.ms.max(remote.ms).max(wall_ms);
        let ctr = if ms == prev.ms && ms == remote.ms {
            prev.ctr.max(remote.ctr) + 1
        } else if ms == prev.ms {
            prev.ctr + 1
        } else if ms == remote.ms {
            remote.ctr + 1
        } else {
            0
        };
        Hlc {
            ms,
            ctr,
            device: prev.device.clone(),
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test sync_engine::hlc 2>&1 | tail -12`
Expected: `test result: ok. 6 passed`.

- [ ] **Step 5: Mutate to prove the ordering tests bite**

1. In `tick`, change `let ms = prev.ms.max(wall_ms);` to `let ms = wall_ms;`. `a_backwards_wall_clock_cannot_move_the_clock_back` must FAIL. Revert.
2. Reorder the struct so `device` sits between `ms` and `ctr`. `the_device_id_breaks_a_tie_and_never_leads` must FAIL on the last assertion. Revert.

**Stop and report if either survives.** The second is invisible in review — a field order is not usually semantics, and here it is the entire ordering.

- [ ] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/sync_engine/ src-tauri/src/lib.rs
git commit -m "feat(sync): the hybrid logical clock, and why the device id comes last

Millis, then the counter, then the device id - and the derived Ord over that field order IS
the comparison, which is why a test asserts the device id never outranks either. Leading with
it would sort every op by whose machine it was on, which is not an ordering.

tick() takes max(prev, wall) rather than the wall, because a clock that went backwards is
ordinary - a corrected system time, a laptop back from sleep - and a retreating clock issues
stamps that sort before ops already written, making every last-writer-wins decision against
them wrong."
```

---

### Task 3: `sync_engine::capture` — the triggers, generated from one census

**Files:**
- Create: `src-tauri/src/sync_engine/capture.rs`
- Modify: `src-tauri/src/sync_engine/mod.rs`, `src-tauri/src/db.rs` (install on open)

**Interfaces:**
- Consumes: `schema::SYNCED_TABLES`.
- Produces: `capture::TABLES: [Spec; 11]`, `capture::install(&Connection) -> rusqlite::Result<()>`, `capture::suppressed<T>(&Connection, impl FnOnce() -> T) -> T`.

> **Triggers, and not the update hook, and not forty call sites.** Three candidates were weighed:
>
> - **`update_hook`** (what `mirror::watch` uses) fires per row inside SQLite's callback, gives the table and rowid but **no values**, and must not call back into the database. It cannot build an op.
> - **`preupdate_hook`** does give old and new values, but it fires *before commit* and a rollback hook clearing an in-memory buffer means the buffer is the only record between commit and drain. **A crash there loses an op silently, and a lost op is a device that has diverged for good.**
> - **Triggers** run inside the caller's transaction, roll back with it, cannot be forgotten by a write site added next year, and are the same on native and on wasm. That is the whole argument, and it is the rule `deck_audit` already follows one table over: *written inside the caller's transaction, where one is open.*

> ⚠️ **The applier must not re-emit what it just applied**, or two devices ping-pong forever. Every capture trigger carries `WHEN (SELECT value FROM sync_state WHERE key = 'applying') IS NULL`. That is one indexed single-row subquery per changed row; Step 6 measures it against a 50 000-row bulk import rather than assuming it is free.

> ⚠️ **`deck_audit` gets an INSERT trigger and no others.** §7.3 makes it union/append-only, and it is also the one synced table a CASCADE empties — deleting a deck takes its audit rows with it, and a DELETE trigger would emit thousands of delete-ops for rows the far device's own CASCADE is about to remove anyway.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        install(&conn).unwrap();
        // A device with no group records nothing, so every test needs one.
        conn.execute(
            "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
             VALUES (1, 'dev-a', x'00', x'01', 'A', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
             VALUES (1, 'g', 0, x'02', 0)",
            [],
        )
        .unwrap();
        conn
    }

    fn ops(conn: &Connection) -> Vec<(String, String, String, String)> {
        let mut s = conn
            .prepare("SELECT tbl, kind, fields, counters FROM sync_ops ORDER BY seq")
            .unwrap();
        s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    /// The census must name every table the schema says is synced, and no other.
    #[test]
    fn every_synced_table_is_on_the_census() {
        let names: Vec<&str> = TABLES.iter().map(|t| t.table).collect();
        let mut want: Vec<&str> = crate::schema::SYNCED_TABLES.to_vec();
        want.sort_unstable();
        let mut got = names.clone();
        got.sort_unstable();
        assert_eq!(got, want, "a synced table with no capture spec never syncs");
    }

    /// An insert mints a uid and writes one `put`.
    #[test]
    fn an_insert_mints_a_uid_and_writes_one_put() {
        let conn = db();
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('A', 'commander', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        let uid: Option<String> = conn
            .query_row("SELECT sync_uid FROM decks", [], |r| r.get(0))
            .unwrap();
        assert!(uid.is_some(), "the insert trigger must mint a uid");

        let o = ops(&conn);
        assert_eq!(o.len(), 1);
        assert_eq!((o[0].0.as_str(), o[0].1.as_str()), ("decks", "put"));
    }

    /// **An update carries only what changed.** Per-field last-writer-wins is the rule (§7.3),
    /// and an op carrying every column would clobber a field it never touched.
    #[test]
    fn an_update_carries_only_the_fields_that_moved() {
        let conn = db();
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('A', 'commander', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM sync_ops", []).unwrap();
        conn.execute("UPDATE decks SET notes = 'hello'", []).unwrap();

        let o = ops(&conn);
        assert_eq!(o.len(), 1);
        let fields: serde_json::Value = serde_json::from_str(&o[0].2).unwrap();
        assert_eq!(fields["notes"], "hello");
        assert!(fields.get("name").is_none(), "name did not change: {fields}");
    }

    /// **Quantity travels as a delta, never as a value.** This is the counter rule's whole
    /// mechanism, and a `+1` that shipped as `1` is what turns two additions into one card.
    #[test]
    fn a_quantity_change_is_captured_as_a_delta() {
        let conn = db();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,
                 created_at,updated_at)
             VALUES ('c1','lea','1','en','nonfoil','NM',2,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM sync_ops", []).unwrap();
        conn.execute("UPDATE collection_entries SET quantity = 5", [])
            .unwrap();

        let o = ops(&conn);
        let counters: serde_json::Value = serde_json::from_str(&o[0].3).unwrap();
        assert_eq!(counters["quantity"], 3, "5 - 2, not 5");
    }

    /// The clock actually advances, and two ops never share a stamp.
    #[test]
    fn every_op_gets_a_distinct_stamp() {
        let conn = db();
        for i in 0..20 {
            conn.execute(
                "INSERT INTO decks (name, format_key, created_at, updated_at)
                 VALUES (?1, 'commander', unixepoch(), unixepoch())",
                rusqlite::params![format!("d{i}")],
            )
            .unwrap();
        }
        let distinct: i64 = conn
            .query_row(
                "SELECT count(DISTINCT hlc_ms || ':' || hlc_ctr) FROM sync_ops",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(distinct, 20, "twenty writes in one millisecond need twenty stamps");
    }

    /// A device in no group records nothing at all.
    #[test]
    fn an_unpaired_device_records_no_ops() {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        install(&conn).unwrap();
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('A', 'commander', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        assert!(ops(&conn).is_empty());
    }

    /// **The apply guard.** Without it two devices ping-pong an op forever.
    #[test]
    fn writes_inside_suppressed_record_nothing() {
        let conn = db();
        suppressed(&conn, || {
            conn.execute(
                "INSERT INTO decks (name, format_key, created_at, updated_at)
                 VALUES ('A', 'commander', unixepoch(), unixepoch())",
                [],
            )
            .unwrap();
        });
        assert!(ops(&conn).is_empty());

        // ...and the guard lifts.
        conn.execute("UPDATE decks SET notes = 'x'", []).unwrap();
        assert_eq!(ops(&conn).len(), 1, "the guard must not be sticky");
    }

    /// `deck_audit` is append-only: a delete there writes no op.
    #[test]
    fn deck_audit_captures_inserts_only() {
        let conn = db();
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('A', 'commander', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO deck_audit (deck_id, at, kind, payload, delta)
             VALUES (1, unixepoch(), 'add', '{}', 1)",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM sync_ops", []).unwrap();
        conn.execute("DELETE FROM deck_audit", []).unwrap();
        assert!(ops(&conn).is_empty(), "an audit delete must emit nothing");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Add `pub mod capture;` to `sync_engine/mod.rs` first.
Run: `cd src-tauri && cargo test sync_engine::capture 2>&1 | tail -20`
Expected: compile error — `cannot find value TABLES in this scope`.

- [ ] **Step 3: Write the implementation**

The shape: one `Spec` per table, one generator, 30 triggers plus one clock trigger.

```rust
//! Turning a local write into a row in `sync_ops`, inside the caller's own transaction.
//!
//! **Triggers, and the choice is load-bearing.** `update_hook` gives no values;
//! `preupdate_hook` fires before commit, so an in-memory buffer is the only record between the
//! commit and the drain, and a crash there loses an op — a device diverged for good, silently.
//! A trigger runs inside the transaction, rolls back with it, cannot be forgotten by a write
//! site added next year, and is identical on native and on wasm. It is the rule
//! [`crate::deck_audit`] already follows: written inside the caller's transaction.

use rusqlite::Connection;

/// What one synced table needs captured.
pub struct Spec {
    pub table: &'static str,
    /// The columns that identify a row locally. `id` for everything except `muted_tags`, which
    /// is `WITHOUT ROWID` on `(namespace, tag_id)`.
    pub keys: &'static [&'static str],
    /// Scalar fields — last-writer-wins **per field**.
    pub fields: &'static [&'static str],
    /// Counter fields — ops carry `NEW - OLD`, never the value.
    pub counters: &'static [&'static str],
    /// `(json key, local column, parent table)`. The parent's `sync_uid` is what travels.
    pub parents: &'static [(&'static str, &'static str, &'static str)],
    /// `false` for `deck_audit`: union/append-only, and the one synced table a CASCADE empties.
    pub deletes: bool,
}

pub const TABLES: [Spec; 11] = [
    Spec {
        table: "collection_entries",
        keys: &["id"],
        fields: &[
            "card_id", "set_code", "collector_number", "lang", "finish", "condition",
            "condition_original", "purchase_price", "purchase_currency", "acquired_at",
            "acquisition_source", "serial_number", "altered", "signed", "proxy", "misprint",
            "grading", "tags", "notes", "needs_review",
        ],
        counters: &["quantity", "tradelist_quantity"],
        parents: &[("folder", "folder_id", "collection_folders")],
        deletes: true,
    },
    Spec {
        table: "collection_folders",
        keys: &["id"],
        fields: &["name", "kind", "sort_order", "needs_review"],
        counters: &[],
        parents: &[
            ("parent", "parent_id", "collection_folders"),
            ("deck", "deck_id", "decks"),
        ],
        deletes: true,
    },
    Spec {
        table: "deck_audit",
        keys: &["id"],
        fields: &["at", "variant", "kind", "card_id", "card_name", "payload", "delta"],
        counters: &[],
        parents: &[("deck", "deck_id", "decks")],
        deletes: false,
    },
    Spec {
        table: "deck_cards",
        keys: &["id"],
        fields: &[
            "variant", "card_id", "set_code", "collector_number", "lang", "name", "finish",
            "needs_review",
        ],
        counters: &["quantity"],
        parents: &[
            ("deck", "deck_id", "decks"),
            ("category", "category_id", "deck_categories"),
            ("tag", "tag_id", "deck_tags"),
        ],
        deletes: true,
    },
    Spec {
        table: "deck_categories",
        keys: &["id"],
        fields: &["name", "kind", "is_active", "sort_order", "origin"],
        counters: &[],
        parents: &[("deck", "deck_id", "decks")],
        deletes: true,
    },
    Spec {
        table: "deck_folders",
        keys: &["id"],
        fields: &["name", "sort_order", "needs_review"],
        counters: &[],
        parents: &[("parent", "parent_id", "deck_folders")],
        deletes: true,
    },
    Spec {
        table: "deck_tags",
        keys: &["id"],
        fields: &["name", "name_key", "color"],
        counters: &[],
        parents: &[],
        deletes: true,
    },
    Spec {
        table: "decks",
        keys: &["id"],
        fields: &[
            "name", "format_key", "game_key", "description", "cover_kind", "cover_card_id",
            "cover_image_path", "archived", "notes", "theory_enabled", "last_variant",
            "last_group_by", "last_sort_by", "separate_x_group", "default_category_id",
            "bracket",
        ],
        counters: &[],
        parents: &[("folder", "folder_id", "deck_folders")],
        deletes: true,
    },
    Spec {
        table: "muted_tags",
        keys: &["namespace", "tag_id"],
        fields: &["slug", "muted_at"],
        counters: &[],
        parents: &[],
        deletes: true,
    },
    Spec {
        table: "wishlist_entries",
        keys: &["id"],
        fields: &[
            "oracle_id", "card_id", "set_code", "collector_number", "lang", "name",
            "preferred_finish", "notes", "needs_review",
        ],
        counters: &["quantity"],
        parents: &[("folder", "folder_id", "wishlist_folders")],
        deletes: true,
    },
    Spec {
        table: "wishlist_folders",
        keys: &["id"],
        fields: &["name", "sort_order", "needs_review"],
        counters: &[],
        parents: &[("parent", "parent_id", "wishlist_folders")],
        deletes: true,
    },
];
```

> ⚠️ **`decks.default_category_id` is a local row id in a plain `INTEGER` column with a `0`
> sentinel, not a declared foreign key** — `crate::deck::AUTO_CATEGORY`. It is listed as a
> *field* above rather than a parent, which means an incoming op carries the **originating
> device's** category id. Task 5 must translate it: `apply` resolves it through the category's
> uid like any parent, and a test pins it. It is on the field list because a `0` has to survive
> as a `0`, which a parent-uid lookup would turn into a `NULL`.

The generator, and the SQL it writes:

```rust
/// The subquery every capture trigger is gated on. One indexed single-row read.
const GUARD: &str = "(SELECT value FROM sync_state WHERE key = 'applying') IS NULL";

/// A sparse JSON object of the fields that changed, built by nesting `json_patch`.
///
/// **Sparse is the requirement, not a nicety.** Last-writer-wins is per field (§7.3), so an op
/// carrying every column would clobber a field it never touched — one device editing a note
/// would undo another's price edit on the same row, which is the exact failure that row of the
/// table exists to prevent. SQLite has no conditional object key, so this nests one `json_patch`
/// per column; `IS NOT` is the null-safe comparison, which matters because most of these columns
/// are nullable and `<>` answers NULL rather than true.
fn changed_fields(spec: &Spec) -> String {
    let mut expr = "json_object()".to_owned();
    for f in spec.fields {
        expr = format!(
            "json_patch({expr}, CASE WHEN NEW.{f} IS NOT OLD.{f} \
             THEN json_object('{f}', NEW.{f}) ELSE json_object() END)"
        );
    }
    expr
}

fn all_fields(spec: &Spec) -> String {
    let pairs: Vec<String> = spec
        .fields
        .iter()
        .map(|f| format!("'{f}', NEW.{f}"))
        .collect();
    if pairs.is_empty() {
        "json_object()".to_owned()
    } else {
        format!("json_object({})", pairs.join(", "))
    }
}

/// Foreign rows named by their `sync_uid`, never by a local id.
fn parents(spec: &Spec, row: &str) -> String {
    let pairs: Vec<String> = spec
        .parents
        .iter()
        .map(|(key, col, parent)| {
            format!("'{key}', (SELECT sync_uid FROM {parent} WHERE id = {row}.{col})")
        })
        .collect();
    if pairs.is_empty() {
        "json_object()".to_owned()
    } else {
        format!("json_object({})", pairs.join(", "))
    }
}

/// The stamp expression: `max(clock, wall)` millis, and the counter that follows from it.
/// The same rule [`super::hlc::Hlc::tick`] spells in Rust, in the one place SQL has to own it.
const STAMP_MS: &str =
    "max(c.ms, cast(unixepoch('subsec') * 1000 AS INTEGER))";
const STAMP_CTR: &str =
    "CASE WHEN cast(unixepoch('subsec') * 1000 AS INTEGER) > c.ms THEN 0 ELSE c.ctr + 1 END";

fn insert_trigger(spec: &Spec) -> String {
    let t = spec.table;
    let key_match: Vec<String> = spec.keys.iter().map(|k| format!("{k} = NEW.{k}")).collect();
    format!(
        "CREATE TRIGGER IF NOT EXISTS sync_ins_{t} AFTER INSERT ON {t}
         WHEN {GUARD}
         BEGIN
             UPDATE {t} SET sync_uid = lower(hex(randomblob(16)))
              WHERE {key} AND sync_uid IS NULL;
             INSERT INTO sync_ops
                 (tbl, uid, kind, fields, counters, parents, hlc_ms, hlc_ctr, device_id)
             SELECT '{t}',
                    (SELECT sync_uid FROM {t} WHERE {key}),
                    'put',
                    {fields}, {counters}, {parents},
                    {STAMP_MS}, {STAMP_CTR}, i.device_id
               FROM sync_clock c, sync_identity i, sync_group g;
         END;",
        key = key_match.join(" AND "),
        fields = all_fields(spec),
        counters = counter_object(spec, "NEW", None),
        parents = parents(spec, "NEW"),
    )
}
```

`update_trigger` is the same shape with `changed_fields(spec)`, `counter_object(spec, "NEW", Some("OLD"))` — which emits `json_object('quantity', NEW.quantity - OLD.quantity)` and omits a counter that did not move — and `uid` taken from `NEW.sync_uid`. `delete_trigger` writes `kind = 'del'` with empty objects and `OLD.sync_uid`, and is skipped when `spec.deletes` is false.

One more trigger, once:

```rust
/// The clock follows the op it just stamped.
///
/// A separate trigger rather than a second statement inside each of the thirty, so the rule
/// lives once. It is not recursive — a different table — so `PRAGMA recursive_triggers` has no
/// bearing on it either way, and nothing here depends on that pragma's value.
const CLOCK_TRIGGER: &str = "CREATE TRIGGER IF NOT EXISTS sync_ops_clock
     AFTER INSERT ON sync_ops
     BEGIN
         UPDATE sync_clock SET ms = NEW.hlc_ms, ctr = NEW.hlc_ctr WHERE id = 1;
     END;";

pub fn install(conn: &Connection) -> rusqlite::Result<()> {
    for spec in &TABLES {
        conn.execute_batch(&insert_trigger(spec))?;
        conn.execute_batch(&update_trigger(spec))?;
        if spec.deletes {
            conn.execute_batch(&delete_trigger(spec))?;
        }
    }
    conn.execute_batch(CLOCK_TRIGGER)
}

/// Run `f` with capture switched off — what [`super::apply`] wraps every write in.
///
/// **The guard is cleared even on a panic**, through a guard struct rather than a bare pair of
/// statements: a sticky `applying` row is a device that silently stops syncing, and it would
/// survive a restart because the row is in the database.
pub fn suppressed<T>(conn: &Connection, f: impl FnOnce() -> T) -> T {
    struct Guard<'a>(&'a Connection);
    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            let _ = self
                .0
                .execute("DELETE FROM sync_state WHERE key = 'applying'", []);
        }
    }
    let _ = conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES ('applying', '1')",
        [],
    );
    let _g = Guard(conn);
    f()
}
```

Call `capture::install` from wherever `db::open` finishes preparing the **write** connection, after `schema::migrate`. **Not** on the read-only connection: it never writes, and a trigger there is thirty objects nobody fires.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test sync_engine::capture 2>&1 | tail -12`
Expected: `test result: ok. 8 passed`.

- [ ] **Step 5: Measure the guard, because §7.7 says a bulk import is the one case near a limit**

Write a `#[test] #[ignore]` that inserts 50 000 `collection_entries` rows in one transaction, twice: once with `install` called and once without. Report both wall times and the ratio, and the resulting `sync_ops` count.

```bash
cd src-tauri && cargo test --release -- --ignored bulk_import_with_capture --nocapture
```

**Record the numbers in `docs/reference/sync.md` with the build named** (release, Windows). The expected `sync_ops` count is 50 000, which at 200 ops per stored row is **250 relay writes** — 0.25% of the free tier's 100 000 rows/day, which is the arithmetic §7.7 uses to justify the batch size. **If capture more than doubles the import, stop and report it** rather than proceeding: the remedy is to `suppressed(...)` the importer and seed its ops in one pass afterwards, and that is a decision worth taking with the measurement in hand.

- [ ] **Step 6: Mutate to prove the three sharpest tests bite**

1. In `changed_fields`, replace the `CASE` with an unconditional `json_object('{f}', NEW.{f})` — a whole-row op, which is what a first draft writes. `an_update_carries_only_the_fields_that_moved` must FAIL. Revert.
2. In `counter_object`, emit `NEW.quantity` instead of `NEW.quantity - OLD.quantity`. `a_quantity_change_is_captured_as_a_delta` must FAIL. Revert.
3. Delete the `WHEN {GUARD}` clause. `writes_inside_suppressed_record_nothing` must FAIL. Revert.

**Stop and report if any survives.** Number 2 is the one that would ship: a counter carrying a value passes every single-device test there is and only fails when two devices meet.

- [ ] **Step 7: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/sync_engine/capture.rs src-tauri/src/sync_engine/mod.rs src-tauri/src/db.rs
git commit -m "feat(sync): capture every local write as an op, from SQLite triggers

Triggers and not the update hook: that one gives no values. And not preupdate_hook, which
fires before commit, so an in-memory buffer is the only record between the commit and the
drain and a crash there loses an op - a device diverged for good, silently. A trigger runs
inside the caller's transaction, rolls back with it, cannot be forgotten by a write site
added next year, and is identical on native and on wasm.

An update carries only the columns that MOVED, because last-writer-wins is per field: a
whole-row op would let one device's note edit undo another's price edit. Quantities carry
NEW - OLD and never NEW, which is the whole of the counter rule - a value ships as +1 where
two devices adding one copy each must end at +2.

The apply guard is one indexed single-row subquery per changed row, measured against a
50 000-row bulk import rather than assumed free."
```

---

### Task 4: `sync_engine::merge` — §7.3's five rules, and nothing else

**Files:**
- Create: `src-tauri/src/sync_engine/merge.rs`
- Modify: `src-tauri/src/sync_engine/mod.rs`

**Interfaces:**
- Consumes: `hlc::Hlc`.
- Produces: `merge::Op`, `merge::Resolved`, `merge::fold(&[Op]) -> Resolved`.

> **Pure, and that is what makes the concurrency tests real.** Every test here builds two ops with *incomparable-looking* stamps from two device ids and folds them in both orders, asserting the same answer. A test that fed one op, then the other, through a database would be testing sequential application and would pass over every one of these rules being wrong.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_engine::hlc::Hlc;
    use serde_json::json;

    fn at(ms: i64, dev: &str) -> Hlc {
        Hlc { ms, ctr: 0, device: dev.to_owned() }
    }

    fn put(dev: &str, ms: i64, fields: serde_json::Value, counters: serde_json::Value) -> Op {
        Op {
            table: "collection_entries".into(),
            uid: "u1".into(),
            kind: Kind::Put,
            fields: fields.as_object().cloned().unwrap_or_default(),
            counters: counters
                .as_object()
                .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_i64().unwrap())).collect())
                .unwrap_or_default(),
            parents: Default::default(),
            at: at(ms, dev),
        }
    }

    fn del(dev: &str, ms: i64) -> Op {
        Op { kind: Kind::Del, ..put(dev, ms, json!({}), json!({})) }
    }

    /// Folding is order-independent. Every rule below is asserted through this, so a rule that
    /// only worked when the ops happened to arrive in timestamp order cannot pass.
    fn fold_both_ways(ops: &[Op]) -> Resolved {
        let forward = fold(ops);
        let mut backward: Vec<Op> = ops.to_vec();
        backward.reverse();
        let reversed = fold(&backward);
        assert_eq!(forward, reversed, "folding must not depend on arrival order");
        forward
    }

    /// §7.3 row 1. **Two devices each add one copy and the row ends at +2.** Genuinely
    /// concurrent: two device ids, neither having seen the other, folded in both orders.
    #[test]
    fn two_concurrent_additions_of_one_copy_end_at_plus_two() {
        let r = fold_both_ways(&[
            put("a", 1_000, json!({}), json!({"quantity": 1})),
            put("b", 1_000, json!({}), json!({"quantity": 1})),
        ]);
        assert_eq!(r.counters.get("quantity"), Some(&2));
    }

    /// ...and the failure it exists to prevent, stated as its own assertion: a value-carrying
    /// op would resolve to 1 here, silently losing a card.
    #[test]
    fn a_counter_never_resolves_to_the_last_value_seen() {
        let r = fold_both_ways(&[
            put("a", 1_000, json!({}), json!({"quantity": 3})),
            put("b", 2_000, json!({}), json!({"quantity": 1})),
        ]);
        assert_eq!(r.counters.get("quantity"), Some(&4), "3 + 1, not 1");
    }

    /// §7.3 row 2. Per FIELD and not per row: A's note and B's price both survive.
    #[test]
    fn concurrent_edits_to_different_fields_both_survive() {
        let r = fold_both_ways(&[
            put("a", 1_000, json!({"notes": "mine"}), json!({})),
            put("b", 1_001, json!({"purchase_price": 4.5}), json!({})),
        ]);
        assert_eq!(r.fields["notes"].0, json!("mine"));
        assert_eq!(r.fields["purchase_price"].0, json!(4.5));
    }

    /// ...and on the SAME field, the later stamp wins — on both devices, identically.
    #[test]
    fn concurrent_edits_to_one_field_take_the_later_stamp() {
        let r = fold_both_ways(&[
            put("a", 2_000, json!({"notes": "later"}), json!({})),
            put("b", 1_000, json!({"notes": "earlier"}), json!({})),
        ]);
        assert_eq!(r.fields["notes"].0, json!("later"));
    }

    /// A tie on millis and counter is broken by the device id, deterministically.
    #[test]
    fn a_dead_heat_on_one_field_is_broken_by_the_device_id() {
        let r = fold_both_ways(&[
            put("a", 1_000, json!({"notes": "from a"}), json!({})),
            put("b", 1_000, json!({"notes": "from b"}), json!({})),
        ]);
        assert_eq!(r.fields["notes"].0, json!("from b"), "b sorts after a");
    }

    /// §7.3 row 3. **Add wins**: a delete concurrent with an edit resurrects the row, and says
    /// so, because losing a collection entry is worse than keeping one.
    #[test]
    fn a_delete_concurrent_with_an_edit_resurrects_and_is_flagged() {
        let r = fold_both_ways(&[
            del("a", 1_000),
            put("b", 1_000, json!({"notes": "still here"}), json!({})),
        ]);
        assert!(!r.deleted, "add-wins: the row survives");
        assert!(r.resurrected, "and the reader is told");
        assert_eq!(r.fields["notes"].0, json!("still here"));
    }

    /// ...but a tombstone strictly later than EVERY edit does delete, and quietly.
    #[test]
    fn a_delete_after_every_edit_really_deletes() {
        let r = fold_both_ways(&[
            put("b", 1_000, json!({"notes": "old"}), json!({})),
            del("a", 9_000),
        ]);
        assert!(r.deleted);
        assert!(!r.resurrected, "an uncontested delete is not a surprise");
    }

    /// A counter also counts as an edit for add-wins. Losing a delete's race against a
    /// quantity change must keep the row, not just its notes.
    #[test]
    fn a_counter_change_also_beats_a_concurrent_delete() {
        let r = fold_both_ways(&[del("a", 1_000), put("b", 1_000, json!({}), json!({"quantity": 1}))]);
        assert!(!r.deleted);
        assert!(r.resurrected);
    }

    /// §7.3 row 4, the LWW half. The cycle-break half is `apply`'s, because it needs the tree.
    #[test]
    fn a_parent_move_is_last_writer_wins() {
        let mut a = put("a", 1_000, json!({}), json!({}));
        a.parents.insert("parent".into(), Some("p-old".into()));
        let mut b = put("b", 2_000, json!({}), json!({}));
        b.parents.insert("parent".into(), Some("p-new".into()));
        let r = fold_both_ways(&[a, b]);
        assert_eq!(r.parents["parent"].0.as_deref(), Some("p-new"));
    }

    /// §7.3 row 6. `deck_audit` is union/append-only, so a fold of one insert is that insert
    /// and a second op for the same uid is the same row rather than a conflict.
    #[test]
    fn an_audit_row_folds_to_itself() {
        let mut op = put("a", 1_000, json!({"kind": "add"}), json!({}));
        op.table = "deck_audit".into();
        let r = fold_both_ways(&[op.clone(), op]);
        assert!(!r.deleted);
        assert_eq!(r.fields["kind"].0, json!("add"));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Add `pub mod merge;` first. Run: `cd src-tauri && cargo test sync_engine::merge 2>&1 | tail -20`
Expected: compile error — `cannot find type Op in this scope`.

- [ ] **Step 3: Write the implementation**

```rust
//! §7.3's rules, as pure functions over ops.
//!
//! **Nothing here touches a database**, which is what makes the tests real: every one of them
//! builds two ops from two device ids that have not seen each other and folds them **in both
//! orders**, asserting the same answer. A test that pushed one op through SQLite and then the
//! other would be testing sequential application, and would pass over every rule here being
//! wrong.

use crate::sync_engine::hlc::Hlc;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Put,
    Del,
}

/// One change to one row, as it travels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Op {
    pub table: String,
    pub uid: String,
    pub kind: Kind,
    /// Scalar fields that changed. Last-writer-wins per key.
    pub fields: BTreeMap<String, serde_json::Value>,
    /// Deltas. Summed, never compared.
    pub counters: BTreeMap<String, i64>,
    /// Foreign rows by uid. `None` is "at the root", which is a real value and not an absence.
    pub parents: BTreeMap<String, Option<String>>,
    pub at: Hlc,
}

/// What a set of ops about one row adds up to.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Resolved {
    /// Field → (value, the stamp that won it). The stamp is kept because the applier compares
    /// it against what the local row already carries.
    pub fields: BTreeMap<String, (serde_json::Value, Hlc)>,
    /// Summed deltas.
    pub counters: BTreeMap<String, i64>,
    pub parents: BTreeMap<String, (Option<String>, Hlc)>,
    pub deleted: bool,
    /// A delete lost the race and the row survives — §7.4's first surfaced outcome.
    pub resurrected: bool,
    /// The latest stamp in the whole set, which is what the applier writes back as the row's
    /// watermark.
    pub at: Option<Hlc>,
}

/// Fold every op about one row into one answer.
///
/// **Order-independent by construction**, which is not a nicety: two devices fold the same set
/// in whatever order their relay handed it over, and a fold that depended on that order would
/// leave them holding different rows while both believed they had converged.
pub fn fold(ops: &[Op]) -> Resolved {
    let mut out = Resolved::default();
    // The latest stamp of anything that ASSERTS the row exists. Add-wins compares the tombstone
    // against this rather than against the whole set, so a delete that lost to an edit is a
    // resurrection and a delete that came after everything is a delete.
    let mut latest_alive: Option<&Hlc> = None;
    let mut latest_dead: Option<&Hlc> = None;

    for op in ops {
        out.at = Some(match out.at.take() {
            Some(a) if a > op.at => a,
            _ => op.at.clone(),
        });

        match op.kind {
            Kind::Del => {
                if latest_dead.is_none_or(|d| *d < op.at) {
                    latest_dead = Some(&op.at);
                }
            }
            Kind::Put => {
                if latest_alive.is_none_or(|a| *a < op.at) {
                    latest_alive = Some(&op.at);
                }
                for (k, v) in &op.fields {
                    match out.fields.get(k) {
                        // `>=` and not `>`: equality cannot happen, since two stamps that agree
                        // on millis and counter still differ by device id. Written as `>=` so
                        // that a future stamp shape which *can* tie still resolves rather than
                        // silently keeping whichever arrived first.
                        Some((_, held)) if *held >= op.at => {}
                        _ => {
                            out.fields.insert(k.clone(), (v.clone(), op.at.clone()));
                        }
                    }
                }
                for (k, d) in &op.counters {
                    *out.counters.entry(k.clone()).or_insert(0) += d;
                }
                for (k, p) in &op.parents {
                    match out.parents.get(k) {
                        Some((_, held)) if *held >= op.at => {}
                        _ => {
                            out.parents.insert(k.clone(), (p.clone(), op.at.clone()));
                        }
                    }
                }
            }
        }
    }

    // §7.3 row 3, in three lines. A tombstone deletes only when it is strictly later than
    // everything that asserted the row exists; otherwise the row survives **and says so**,
    // because a resurrection is a thing the reader has to be able to see (§7.4).
    match (latest_dead, latest_alive) {
        (Some(d), Some(a)) if *d > *a => out.deleted = true,
        (Some(_), Some(_)) => out.resurrected = true,
        (Some(_), None) => out.deleted = true,
        _ => {}
    }
    out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test sync_engine::merge 2>&1 | tail -12`
Expected: `test result: ok. 10 passed`.

- [ ] **Step 5: Mutate to prove each rule's test bites — five mutations**

| Mutate | Test that must FAIL |
| --- | --- |
| `*out.counters.entry(..) += d` → `= *d` | `two_concurrent_additions_of_one_copy_end_at_plus_two` |
| add-wins arm `*d > *a` → `*d >= *a` | `a_delete_concurrent_with_an_edit_resurrects_and_is_flagged` |
| drop `out.resurrected = true` | the same test, on the second assertion |
| field guard `*held >= op.at` → `*held > op.at`, and make `fold` iterate in reverse | `concurrent_edits_to_one_field_take_the_later_stamp` |
| count a counter op toward `latest_dead` instead of `latest_alive` | `a_counter_change_also_beats_a_concurrent_delete` |

Revert after each. **Stop and report any that survives** — a conflict rule whose test survives its own inversion is a rule that has never actually been exercised.

- [ ] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/sync_engine/merge.rs src-tauri/src/sync_engine/mod.rs
git commit -m "feat(sync): §7.3's rules as a pure, order-independent fold

Every test folds the same ops in BOTH orders and asserts the same answer, through one
fold_both_ways helper. That is not decoration: two devices fold whatever order their relay
handed over, and a fold that depended on arrival order leaves them holding different rows
while both believe they have converged. It also means a rule that only worked in timestamp
order cannot pass here.

Counters sum deltas; a second test asserts the specific wrong answer a value-carrying op
would give. Fields are last-writer-wins per KEY, so A's note and B's price both survive.
Add-wins compares the tombstone against the latest op that ASSERTS the row exists, so a
delete that lost sets resurrected and a delete that came after everything is quiet."
```

---

### Task 5: `sync_engine::apply` — writing a merged result back

**Files:**
- Create: `src-tauri/src/sync_engine/apply.rs`
- Modify: `src-tauri/src/sync_engine/mod.rs`

**Interfaces:**
- Consumes: `merge::{Op, fold}`, `capture::{TABLES, suppressed}`.
- Produces: `apply::apply(&Connection, &[Op]) -> Result<ApplyReport, String>` with `ApplyReport { applied, resurrected, cycles_broken, skipped }`.

Four things happen here and nothing else does:

1. **Ops already seen are dropped**, against `sync_peers`. Idempotence is the counter rule's other half: an op replayed after a reconnect must add its delta once.
2. **A row is found by grain, then by uid, then inserted** — and where both a grain match and a uid exist, both devices set the row's uid to `min(theirs, ours)`, which converges with no alias table.
3. **Foreign uids become local ids.** A parent the device has never seen is a *deferral*, not an error: the op is left in `sync_ops`-shaped limbo and retried after the batch, because relay ordering does not guarantee a parent arrives before its child.
4. **Cycles are broken and `needs_review` is written.**

- [ ] **Step 1: Write the failing test**

The two that matter most, in full:

```rust
    /// The counter rule, end to end, over two REAL databases. Both add one copy of the same
    /// printing while offline; each applies the other's op; both end at 2 with ONE row.
    #[test]
    fn two_offline_devices_each_adding_one_copy_converge_on_one_row_at_two() {
        let (a, b) = (paired("dev-a"), paired("dev-b"));
        for c in [&a, &b] {
            c.execute(
                "INSERT INTO collection_entries
                    (card_id,set_code,collector_number,lang,finish,condition,quantity,
                     created_at,updated_at)
                 VALUES ('c1','lea','1','en','nonfoil','NM',1,unixepoch(),unixepoch())",
                [],
            )
            .unwrap();
        }
        let from_a = outbox(&a);
        let from_b = outbox(&b);
        apply(&b, &from_a).unwrap();
        apply(&a, &from_b).unwrap();

        for (name, c) in [("a", &a), ("b", &b)] {
            let (rows, qty): (i64, i64) = c
                .query_row(
                    "SELECT count(*), coalesce(sum(quantity), 0) FROM collection_entries",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(rows, 1, "{name} kept two rows for one printing");
            assert_eq!(qty, 2, "{name} lost a card");
        }

        // ...and they agree on which uid that row has, which is what stops the next round
        // from splitting it again.
        let ua: String = a
            .query_row("SELECT sync_uid FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        let ub: String = b
            .query_row("SELECT sync_uid FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ua, ub, "the two devices must adopt one uid");
    }

    /// Applying the same batch twice must not add the deltas twice. This is the failure a
    /// dropped connection produces, and it looks exactly like a collection growing by itself.
    #[test]
    fn replaying_a_batch_does_not_add_its_counters_again() {
        let (a, b) = (paired("dev-a"), paired("dev-b"));
        a.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,
                 created_at,updated_at)
             VALUES ('c1','lea','1','en','nonfoil','NM',4,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();
        let batch = outbox(&a);
        apply(&b, &batch).unwrap();
        let report = apply(&b, &batch).unwrap();

        let qty: i64 = b
            .query_row("SELECT quantity FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(qty, 4, "a replay must not add the delta twice");
        assert_eq!(report.applied, 0);
        assert_eq!(report.skipped, batch.len());
    }
```

Plus: a resurrection writes `needs_review` on `collection_entries`; a folder cycle from two concurrent moves ends with the later-moved folder at the root **with `needs_review` set**; two devices typing "Ramp" end with **one** `deck_tags` row; an op whose parent has not arrived is deferred and lands when the parent does; and `decks.default_category_id` is translated rather than carried as a foreign device's row id.

- [ ] **Step 2: Run the test to verify it fails**

Expected: compile error — `cannot find function apply in this scope`.

- [ ] **Step 3: Write the implementation**

The sentences, which are Rust's here for `reconcile.rs`'s reason — that column already holds Rust-written sentences and one column with two conventions is worse than either:

```rust
/// What a resurrected row is told to say. `reconcile::flag_deleted`'s register: a sentence a
/// reader can act on, never a code, and never a reason to delete the row.
const RESURRECTED: &str =
    "Another device deleted this while this one was still changing it, so it was kept.";

/// What a folder that lost a cycle-break is told to say.
const CYCLE_BROKEN: &str =
    "A folder move on another device would have put this folder inside itself. \
     It was moved to the top level.";
```

`apply` runs the whole batch in **one transaction**, wrapped in `capture::suppressed`, and:

- groups ops by `(table, uid)` and folds each group with `merge::fold`;
- drops any op at or below `sync_peers[device]`, and advances that watermark at the end;
- resolves the target row: grain first (built from the table's grain with parent uids translated), then uid, then insert;
- on a grain match with a differing uid, sets both the row's uid and the op's to `min` — the convergence rule;
- translates every `parents` entry and `decks.default_category_id` through `sync_uid`;
- defers an op whose parent uid resolves to nothing, retrying once after the batch, and counts a still-unresolved op as `skipped` rather than failing the batch;
- applies counters as `quantity = max(0, quantity + delta)` for `collection_entries` (whose CHECK is `>= 0`) and `quantity + delta` elsewhere, **deleting the row when a `> 0` CHECK would be violated** — which is what `deck_cards` and `wishlist_entries` already mean by zero;
- writes `needs_review` **only where it is currently NULL**, which is `reconcile.rs`'s stated rule: *the first message wins*;
- and finally walks each of the three folder trees, breaking any cycle by returning the folder whose parent op has the **later** stamp to the root, with `CYCLE_BROKEN`.

> ⚠️ **`collection_entries.quantity` is `CHECK (quantity >= 0)` and `deck_cards.quantity` is `CHECK (quantity > 0)`** — the schema's own comment explains why they differ, and an applier that used one rule for both would either raise a constraint failure on a deck card taken to zero or leave a collection row it should have kept. The per-table behaviour is in `capture::TABLES` beside the counter list, not inferred.

> ⚠️ **`muted_tags` is `WITHOUT ROWID` on `(namespace, tag_id)`** and has no `id`. Every statement `apply` builds for it addresses rows by those two columns, which is what `Spec::keys` is for.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test sync_engine::apply 2>&1 | tail -12`

- [ ] **Step 5: Mutate to prove the convergence tests bite**

1. Remove the `min(uid)` adoption so each device keeps its own uid. `two_offline_devices_each_adding_one_copy_converge_on_one_row_at_two` must FAIL on the uid assertion — **and if it passes the row and quantity assertions but fails only the uid one, that is the point**: the divergence is invisible for exactly one round.
2. Remove the `sync_peers` watermark check. `replaying_a_batch_does_not_add_its_counters_again` must FAIL with `quantity = 8`.
3. Make the cycle-break return the **earlier**-moved folder to root. The cycle test must FAIL, because both devices then pick different folders and do not converge.

**Stop and report any that survives.**

- [ ] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests |test result" /tmp/verify.log
git add src-tauri/src/sync_engine/apply.rs src-tauri/src/sync_engine/mod.rs
git commit -m "feat(sync): apply a merged result, resolving identity by grain then uid

A minted uid alone cannot be a row's identity: two devices adding one copy of the same
printing mint two uids, and inserting both is two rows at +1 where the rule says one row at
+2 - and it violates idx_collection_grain besides. A grain alone cannot either, because
decks, the three folder tables and deck_audit have no unique index at all. So both, with
min(uid) as the tiebreak, which converges without an alias table.

sync_peers is what makes a counter idempotent. A batch replayed after a dropped connection
must add its delta once; a test applies the same batch twice and asserts the quantity did
not double, which is what a collection growing by itself actually looks like.

needs_review sentences are written here rather than in the page, following reconcile.rs:
that column already holds Rust-written sentences, and one column with two conventions is
worse than either convention."
```

---

### Task 6: `sync_engine::wire` — the envelope, and 200 ops per stored row

**Files:**
- Create: `src-tauri/src/sync_engine/wire.rs`

**Interfaces:**
- Consumes: `merge::Op`, PR 6's `sync_pair::crypto::{seal, open}`.
- Produces: `wire::BATCH: usize = 200`, `wire::Envelope`, `wire::seal_batch(&Group, &[Op]) -> Result<Envelope, String>`, `wire::open_batch(&Group, &Envelope) -> Result<Vec<Op>, String>`.

> **200 is derived from the write limit and is checked against the row cap, not the other way round.** The free tier allows 100 000 Durable Object rows written per day. A 50 000-row bulk import at one op per stored row would spend half of that; at 200 it is 250 writes. The measured average op is **453 bytes**, so a full batch is **~90.6 KB** against the 2 MB per-row cap — the cap is not the binding constraint and there is no separate snapshot artifact for it to bind on (§7.7).

The envelope, and what the relay is allowed to see:

```rust
/// One stored row's worth of ops, as it crosses the network.
///
/// **The relay sees these four fields and nothing else.** `group` routes it, `device` and `hlc`
/// let the Durable Object order and compact without decrypting anything, and `sealed` is opaque.
/// The op count is deliberately absent: it is inside the ciphertext, because "this device wrote
/// 431 things today" is information the relay does not need in order to relay.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub group: String,
    pub device: String,
    pub epoch: i64,
    /// The stamp of the LAST op inside. The relay's ordering key, and never a clock it sets.
    pub hlc_ms: i64,
    pub hlc_ctr: i64,
    /// XChaCha20-Poly1305 under the group key, base64url. AAD is `group|device|epoch`, so a
    /// blob replayed into another group or under another epoch fails to open rather than
    /// applying somewhere it does not belong.
    pub sealed: String,
}
```

Tests: a round trip; a batch sealed under epoch 1 refusing to open under epoch 2 (**which is what makes revocation mean something on the wire**); a tampered `device` field failing the AAD; and `seal_batch` refusing more than `BATCH` ops.

Mutation: drop `epoch` from the AAD — the epoch test must fail, and if it does not, a revoked device's old blobs still apply.

---

### Task 7: `sync_engine::client` — push, pull, and how often

**Files:**
- Create: `src-tauri/src/sync_engine/client.rs`

**Interfaces:**
- Consumes: `wire`, `apply`, `sync_pair::identity`, `reqwest`.
- Produces: `client::push`, `client::pull`, `client::run_once`, and the `sync:progress`-shaped event.

> ## What this PR does not build: the WebSocket
>
> §7.7 says the Durable Object "fans out to connected devices over **hibernatable WebSockets**". **This PR ships HTTP pull-and-push instead**, and the Durable Object keeps a `/ws` route in its shape for the PR that adds it. Three reasons, in order of weight:
>
> 1. **`reqwest` has no WebSocket client**, and the obvious addition — `tokio-tungstenite` — **does not compile to `wasm32-unknown-unknown`.** Adding it would make the web target's core un-buildable, which is the one thing this whole phase is arranged not to do.
> 2. **A WebSocket from the page would need the CSP widened.** `tauri.conf.json` grants `connect-src 'self' ipc: http://ipc.localhost` and nothing else. Widening it is a decision to take once, for all three targets, in the PR where the browser's own `WebSocket` is available in the DB Worker — not here.
> 3. **Polling is comfortably inside the free tier and this is arithmetic, not optimism.** Pull on open, pull every 60 s while the window has focus, push 2 s after the write mask goes quiet — `mirror::watch`'s own debounce, which this repo has already proven. Eight hours of use is `28 800 / 60` = **480 pulls per device per day**; three devices is **1 440**, which is **1.4%** of 100 000. Pushes are ~3/day at 50 edits.
>
> What is lost is latency: a change made on a phone shows on the desktop within a minute rather than instantly. What is kept is a core that still compiles to wasm and a CSP that still grants nothing.

The endpoints, all on one Durable Object:

| | | |
| --- | --- | --- |
| `POST {relay}/g/{group}/push` | body: one `Envelope` | 200 with the stored cursor |
| `GET {relay}/g/{group}/pull?since={cursor}&device={id}` | | 200 with `{ envelopes, cursor }` |
| `POST {relay}/g/{group}/ack` | body: `{ device, cursor }` | 204 — what compaction reads |

Rules the client keeps:

- **The relay URL lives in `sync_state` under `relay_url` and is empty by default.** An empty URL means sync is off, which is the state every existing installation is in and the state an agent leaves it in. **No agent ever needs a deployed URL for any test here** — `httpmock`, already a dev-dependency, stands in.
- **Every failure goes to `error_log` under `Source::Relay`** with the operation (`push`/`pull`/`ack`) and a `Kind` — `timeout`, `http`, `parse`, `other`. Repeats fold on the existing grain, so a bad afternoon is one row with a count.
- **A failed push changes nothing locally.** `pushed_at` is stamped only on a 200, so the next attempt sends the same ops, and `apply`'s watermark makes the far side's second receipt free.
- **A pull applies inside one transaction and emits one event** carrying the four counts from `ApplyReport`, so the page can invalidate the right query keys once rather than per op.

Tests, all against `httpmock`: a 500 on push leaves `pushed_at` NULL and writes exactly one `error_log` row; a pull with an unreadable envelope (wrong epoch) counts as `skipped` and does not advance the cursor past it; and a full push→pull→apply round trip between two in-memory databases through a mock relay converges them.

Mutation: stamp `pushed_at` before the request rather than after. The 500 test must fail — and if it does not, a network blip silently drops the reader's changes.

---

### Task 8: `relay/` — one Durable Object, and its logic as testable functions

**Files:**
- Create: `relay/wrangler.jsonc`, `relay/src/index.ts`, `relay/src/group.ts`, `relay/src/log.ts`, `relay/src/log.test.ts`, `relay/README.md`, `tsconfig.relay.json`
- Modify: `package.json` — `@cloudflare/workers-types` devDependency, and `tsc -p tsconfig.relay.json` in `build`

> ## ⛔ Nothing here is deployed
>
> This task writes source and configuration. **It does not run `wrangler deploy`, does not create a Worker, does not create a Durable Object namespace, and does not touch an account.** When the code is ready, the plan's last step **asks Markus to deploy it**, with the free-tier numbers from the Global Constraints. Until he does, `relay_url` stays empty and every test in this repo passes.

> **Why the logic is in `log.ts` and the Durable Object is a shell.** `@cloudflare/vitest-pool-workers` would run the real DO in workerd, and it pulls wrangler and workerd into a tree pinned to vitest 4.1.10 whose support it does not advertise. Compaction, the 30-day tail and the pull cursor are pure functions of a row list; putting them in `log.ts` makes them testable by the vitest this repo already runs, and leaves the DO class as storage calls and routing.

**`wrangler.jsonc`** — SQLite-backed classes are declared through `new_sqlite_classes`, which is the only migration form the free plan accepts:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "mtg-grimoire-relay",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-27",
  // One Durable Object per pairing group, addressed by the group id. No R2, no KV: KV allows
  // 1 000 writes/day on the free plan, which this would spend in an afternoon.
  "durable_objects": {
    "bindings": [{ "name": "GROUP", "class_name": "Group" }]
  },
  "migrations": [
    {
      "tag": "v1",
      // `new_sqlite_classes` and NOT `new_classes`: Durable Objects are on the free plan
      // **SQLite-backed only**, and the key-value backend is a paid feature.
      "new_sqlite_classes": ["Group"]
    }
  ],
  "observability": { "enabled": true }
}
```

**`log.ts`** — three pure functions and their table shape:

```ts
/**
 * One stored row. **`sealed` is opaque and stays opaque**: the relay orders and compacts by
 * `hlcMs`/`hlcCtr`/`device` and never looks inside. It could not if it wanted to — the group key
 * is on the paired devices and nothing here has ever seen it.
 */
export interface Row {
  seq: number;
  device: string;
  epoch: number;
  hlcMs: number;
  hlcCtr: number;
  sealed: string;
  storedAt: number;
}

/**
 * What a pulling device gets: everything after its cursor, in the group's own order.
 *
 * **Ordered by `(hlcMs, hlcCtr, device)` and not by `seq`.** `seq` is arrival order at the
 * relay, which is a fact about the network; the hybrid logical clock is the group's ordering
 * and is the same on every device. A device that consumed in arrival order would fold the same
 * ops in a different sequence from its peers — which `merge::fold` is order-independent
 * against, but the relay's own compaction is not.
 */
export function since(rows: Row[], cursor: number, exclude: string): Row[];

/**
 * What survives a compaction: everything **every** device has acked is dropped, except a
 * 30-day tail (§7.7 — "compact on ack, keep a 30-day tail"), so a device that spent a
 * fortnight in a drawer reconciles precisely instead of replaying wholesale.
 *
 * `acks` maps device id → cursor. **A device with no ack at all holds everything**, which is the
 * correct direction to be wrong: a group whose third device has never connected keeps its log
 * rather than compacting away the state that device has not seen.
 */
export function compact(rows: Row[], acks: Map<string, number>, nowMs: number): Row[];

/** Thirty days, as milliseconds. §7.7's tail, written once. */
export const TAIL_MS = 30 * 24 * 60 * 60 * 1000;
```

Tests in `relay/src/log.test.ts`, run by the root vitest:

- `since` returns nothing for a cursor at the head, and excludes the puller's own rows (a device must not re-apply what it wrote).
- `since` orders by the HLC and **not** by arrival: a row that arrived second but stamps earlier comes first.
- `compact` keeps a row two devices acked but a third did not.
- `compact` keeps a fully-acked row that is 29 days old and drops it at 31.
- `compact` with an **empty** ack map drops nothing — the "third device has never connected" case, asserted directly because it is the one where being wrong loses data.

The `Group` class holds `push`, `pull`, `ack` and a `sql.exec` table matching `Row`, calls `compact` on every `ack`, and **rejects an envelope whose `group` does not match its own name** — a Durable Object is addressed by id and a mismatched body is either a bug or an attempt.

Mutation for this task: make `compact` treat a missing ack as "acked up to the head". The empty-ack-map test must FAIL. **Stop and report if it survives** — that mutation is a relay that deletes a sleeping device's inbox.

**Last step of this task, and it is not code:**

- [ ] **Ask Markus to provision the Worker.** Bring: the source is committed and type-checks; the free-tier numbers from the Global Constraints; the modelled load (~1 440 req/day, ~484 KB, ~3 rows written/day); and the one command he runs (`npx wrangler deploy` from `relay/`). **Do not run it.** Record the resulting URL nowhere in the repo — it goes in the reader's own `sync_state.relay_url`, through Settings.

---

### Task 9: The commands, the panel, and the record

**Files:**
- Modify: `src-tauri/src/lib.rs` — four commands
- Modify: `src/lib/ipc.ts`, `src/lib/ipc.test.ts`
- Modify: `src/features/settings/SyncPanel.tsx` (+ test, + story)
- Create: `src/features/settings/ReviewPanel.tsx` (+ test, + story)
- Modify: `docs/reference/sync.md`, `CLAUDE.md`, `src-tauri/CLAUDE.md`, `docs/reference/data-and-sync.md`

Commands: `sync_relay_status`, `sync_relay_set_url`, `sync_now(force)`, `sync_review_list`.

`SyncPanel` gains the relay URL field (empty = off, and it says so), the last-sync line in `ago()` terms, and a **Sync now** button that follows `CombosPanel`'s running/failed/stale/fresh ordering — `failed` before `never`, because "we tried and it did not work" is a different sentence from "nobody has tried".

`ReviewPanel` is §7.4's other half: the rows carrying a `needs_review` sentence, from all six tables that now have the column, with the sentence shown verbatim and a **Looks fine** button that clears it. `collection::CollectionQuery` already filters on `needs_review IS NOT NULL` (`collection.rs`), so the collection half is a query that exists.

**Before writing any of it, follow `src/CLAUDE.md`:** the `frontend-design` skill, then the `mtg-grimoire-sb-mcp` documentation tools, then `preview-stories` afterwards with every URL in the report.

`docs/reference/sync.md` gains, with dates and builds named:

- The eleven tables, **and the `deck_allocations` correction**, so nobody re-derives it.
- The identity rule — grain first, uid second, `min` tiebreak — with the six grains and the five uid-only tables.
- §7.3's five rules against the test that proves each.
- The measured capture cost from Task 3 Step 5.
- The relay's endpoints, the batch arithmetic (200 × 453 B = 90.6 KB against a 2 MB cap; 50 000 rows → 250 writes against 100 000/day), and the poll arithmetic (1 440 req/day = 1.4%).
- **What is not built: the WebSocket**, with Task 7's three reasons.

---

## Self-Review

**Spec coverage.** This plan implements §7.2 (the synced set, corrected to eleven), §7.3 (all five rules, plus the HLC), §7.4 (both surfaced outcomes, through `needs_review` — including adding that column to the three folder tables, which did not have it), and §7.7 (one SQLite-backed Durable Object, no R2, no KV, batched at 200, compact on ack, 30-day tail). It does **not** implement §7.7's hibernatable WebSocket fan-out; Task 7 states the three reasons and the DO keeps the route in its shape.

**Placeholders.** None in Tasks 1–4, which carry every line they need. Tasks 5, 7, 8 and 9 specify behaviour, tests and mutations exhaustively and leave routine assembly (the remaining `TABLES` triggers, the panel markup) to the worker — deliberately, because the alternative is a document nobody reads to the end. Every *decision* is made here; nothing is left to be invented.

**Type consistency.** `Hlc { ms, ctr, device }` derives `Ord` over that field order and is used as the comparison in `merge::fold`, in `wire::Envelope`'s two flattened fields, and in `relay/src/log.ts`'s `since` ordering. `merge::Op` is what `capture`'s triggers write column-for-column (`tbl`, `uid`, `kind`, `fields`, `counters`, `parents`, `hlc_ms`, `hlc_ctr`, `device_id`), what `wire::seal_batch` takes a slice of, and what `apply::apply` takes a slice of. `capture::Spec::keys` is the one thing that lets every generated statement address `muted_tags` — the only `WITHOUT ROWID` table on the list.

**Six things were checked against the source rather than assumed, and this plan was wrong about three of them before the check:**

- **`deck_allocations` does not exist.** Dropped at schema v25. §7.2 and the parity matrix both name it among the twelve.
- **`deck_tags` has no `deck_id`.** Schema v21 made it one app-wide list keyed on `name_key`, which is why two devices typing "Ramp" must converge on one row rather than insert two.
- **`DECK_CARD_GRAIN` is five terms, not four** — `finish` joined at v19 (`deck_id, variant, category_id, card_id, coalesce(finish, '')`). The frozen v8 literal in the migration is four and is history; the constant is the head grain.
- **No folder table has `needs_review`**, though §7.4 says a broken cycle is surfaced through it. `wishlist_entries` does have it, though §7.4 names only two tables.
- **`muted_tags` is `WITHOUT ROWID` with a composite primary key** and no `id` column at all.
- **`error_log.source` is CHECK-constrained**, so a `relay` source is a table rebuild — and `Record<ErrorSource, string>` in `ErrorLogPanel.tsx` is total, so the TypeScript side goes red until it is added.

**The architectural call is at the top of this document rather than in this section**, because it is the decision the rest of the plan is built on: **the conflict engine is Rust's**, on the strength of `reconcile.rs`'s precedent, of transactionality, of running with no page open, and of being one implementation on three targets — with the page keeping every question that is about what a *person* sees.
