# Rust Module-Boundary Cleanups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give three pieces of `src-tauri` boilerplate a single home each — the write-lock/BUSY answer, the finish vocabulary, and three small duplicated queries — without changing one byte of app behaviour.

**Architecture:** No module is created, deleted, split or merged. Every task moves a definition to the module that already owns its concept and deletes the copies, then adds the test that stops the copies coming back. The crate's own idiom is followed throughout: a vocabulary lives in `schema.rs` and is read *by index* (`schema::AUDIT_KINDS[0]`, `schema::DECK_VARIANTS[0]`) rather than respelled, and the DDL is never generated from a constant — it is a frozen literal that a test walks.

**Tech Stack:** Rust 2021, rusqlite (bundled SQLite), Tauri 2.11. All tests are inline `#[cfg(test)] mod tests` blocks; there are no integration test files (`src-tauri/tests/` holds only `fixtures/`).

**Spec:** [docs/superpowers/research/2026-08-16-rust-module-boundary-audit.md](../research/2026-08-16-rust-module-boundary-audit.md) — recommendations #1, #2 and #4. Recommendation #3 (`src/deck_folders.rs`) was **declined** and is out of scope; do not implement it.

## Global Constraints

- **Zero behaviour change.** Every task is a move plus a delete. No existing test may be edited except where a moved item's path changes, and no existing assertion's *expected value* may change. If a test fails on content rather than on a path, you have made a mistake — stop and re-read.
- **`npm run verify` from the repo root before every commit.** It runs build + lint + Vitest + `cargo test`.
- **`npm run verify` does NOT run `cargo fmt`.** CI's Linux Rust job does, and it is the only red you can get with both suites green. Run `cargo fmt` inside `src-tauri/` before every commit in this plan.
- **Never run two verifies at once.** Concurrent runs fake ~18 Rust schema failures; if you see a wall of schema errors, check for another running verify before debugging SQLite.
- **`verify`'s exit code lies through a pipe.** Do not write `npm run verify | tail`; redirect to a file and read the summary out of it.
- **Commit prefixes are `feat:` / `fix:` / `chore:` / `test:` / `docs:`.** This repo does not use `refactor:`; these commits are `chore:`.
- **Never install `@types/node`.** Not relevant to Rust work, but it is a repo-wide fence.
- Work from the worktree root: `D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components`. Cargo commands run from `src-tauri/`.
- PowerShell keeps its working directory between calls. Use absolute paths, or a stray `cd src-tauri` will make a later `src` search hit the Rust tree.

## File Structure

| File | Change | Responsibility after |
| --- | --- | --- |
| `src-tauri/src/db.rs` | Modify (+7 lines) | Gains `pub const BUSY` — the sentence a write answers when it cannot have the connection. It already owns `WRITE_LOCK_WAIT`, the bound that produces that answer. |
| `src-tauri/src/sync.rs` | Modify (+14 / −0) | Gains the one `pub(crate) fn with_write`, beside the four existing lock delegates (`lock_db`, `lock_conn`, `lock_plain`, `lock_db_read`, `sync.rs:360-400`). `note_database` becomes `pub(crate)`. |
| `src-tauri/src/collection.rs` | Modify (−17) | Loses `BUSY`, `FINISHES` and its private `with_write`. Keeps `with_write_owned`, which has behaviour of its own (the facet-index `owned` re-read) and now wraps the shared helper. |
| `src-tauri/src/schema.rs` | Modify (+12 prod, +45 test) | Gains `pub const FINISHES`, beside `CATEGORY_KINDS` / `DECK_VARIANTS` / `AUDIT_KINDS`, and the test that walks it against all three live CHECKs. |
| `src-tauri/src/sorting.rs` | Modify (+2 / −1) | `FINISH_LITERALS` becomes `finish_literals()`, derived from `schema::FINISHES`. |
| `src-tauri/src/marketplace_feed.rs` | Modify (+4) | Three module consts indexed off `schema::FINISHES`; `ck_finish` and the Mana Pool tuple read them. |
| `src-tauri/src/deck_audit.rs` | Modify (+18 / −12) | Gains `pub(crate) fn by_id` and a private `entry_from_row`; `list` reads the same row mapper. |
| `src-tauri/src/deck_undo.rs` | Modify (−24) | Loses its verbatim copy of the nine-column SELECT. |
| `src-tauri/src/index/lifecycle.rs` | Modify (−12) | Loses `note_index_failure`; calls `sync::note_database`. |
| `src-tauri/src/images.rs` | Modify (+16 / −10) | Gains `pub(crate) fn image_uri_row` — the one place the two `json_extract`s are written. |
| `src-tauri/src/card.rs` | Modify (−12) | Loses its copy of that query; keeps its own (deliberately fence-free) policy on the result. |
| `src-tauri/CLAUDE.md` | Modify (2 lines) | Line 181 names `collection::BUSY`; line 158 names `FINISH_LITERALS`. Both must move in the same commit as the code. |
| `src-tauri/src/{deck,deck_meta,deck_theory,wishlist,deck_import,deck_undo,marketplace,lib,card}.rs` | Modify (call sites) | Import the shared helpers instead of defining or inlining them. |

**Task order is load-bearing.** Task 1 moves `BUSY`; Task 2's shared `with_write` body references `db::BUSY`. Tasks 3–6 are independent of each other and of 1–2.

---

### Task 1: `db::BUSY` — the lock's sentence lives with the lock's bound

`collection::BUSY` is a *database-lock* sentence read by nine modules that have nothing to do with the collection. `db.rs` already owns `WRITE_LOCK_WAIT`, the timeout whose expiry produces it.

**Files:**
- Modify: `src-tauri/src/db.rs:71` (insert after `WRITE_LOCK_WAIT`)
- Modify: `src-tauri/src/collection.rs:26-31` (delete), `:509`, `:1822`
- Modify: `src-tauri/src/card.rs:566`, `src-tauri/src/deck.rs:3169,3176,3181`, `src-tauri/src/deck_import.rs:970,986`, `src-tauri/src/deck_meta.rs:1577,1586,1590`, `src-tauri/src/deck_theory.rs:495,503`, `src-tauri/src/deck_undo.rs:1154,1172`, `src-tauri/src/lib.rs:133`, `src-tauri/src/marketplace.rs:101,112`, `src-tauri/src/marketplace_feed.rs:650`, `src-tauri/src/wishlist.rs:14,522`, `src-tauri/src/export.rs:22`
- Modify: `src-tauri/CLAUDE.md:181`
- Test: `src-tauri/src/collection.rs` (existing test at `:1822`, path only)

**Interfaces:**
- Produces: `pub const BUSY: &str` in `crate::db`. Value unchanged, character for character.
- Consumes: nothing.

- [ ] **Step 1: Find every reference, so none is missed**

Run from the worktree root:

```powershell
Select-String -Path 'D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components\src-tauri\src\*.rs','D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components\src-tauri\src\index\*.rs' -Pattern 'BUSY' | Where-Object { $_.Line -notmatch 'BUSY_TIMEOUT' }
```

Expected: 17 lines — 11 code references to `collection::BUSY`, one definition, one test assertion, and four doc-comment mentions (`deck.rs:3169,3181`, `deck_meta.rs:1577,1590`, `deck_theory.rs:495`, `deck_import.rs:970`, `marketplace.rs:101`, `export.rs:22`, `wishlist.rs`'s doc). Doc-comment intra-doc links (`` [`crate::collection::BUSY`] ``) must be updated too — a stale one is a `cargo doc` broken link, and `-D warnings` does not catch it, so fix them by hand.

- [ ] **Step 2: Add the constant to `db.rs`**

Insert immediately after `WRITE_LOCK_WAIT` (`src-tauri/src/db.rs:71`):

```rust
/// What a user-facing write says when it could not have the database inside
/// [`WRITE_LOCK_WAIT`].
///
/// A sentence rather than a lock error, and it names the wait: since the ingest was chunked
/// the only thing that can hold the connection for five seconds is something genuinely
/// stuck, and "try again in a moment" is both true and actionable.
///
/// Here rather than in [`crate::collection`], where it began: nine modules outside the
/// collection answer with it, and it is a statement about the *lock* — the other half of
/// [`WRITE_LOCK_WAIT`], and what [`crate::sync::with_write`] returns when [`lock_for`]
/// gives up. Note the near-neighbour [`BUSY_TIMEOUT`] is a different thing entirely:
/// SQLite's own internal wait, not this app's answer to a caller.
pub const BUSY: &str = "The card database is busy finishing a sync. Try that again in a moment.";
```

- [ ] **Step 3: Delete the old definition**

Remove `src-tauri/src/collection.rs:26-31` — the five doc lines and `pub const BUSY: &str = …;`. Leave `GONE` and `ZERO_ADD` where they are; both are collection sentences and belong there.

- [ ] **Step 4: Repoint every reference**

`collection.rs:509` and `:1822` and `wishlist.rs:522` use the bare name `BUSY`. In `collection.rs` change both to `crate::db::BUSY`. In `wishlist.rs:14`, change the import from

```rust
use crate::collection::{valid_quantity, EntryChange, BUSY, FINISHES};
```

to

```rust
use crate::collection::{valid_quantity, EntryChange, FINISHES};
use crate::db::BUSY;
```

(`FINISHES` moves in Task 3, not here.) Everywhere else, replace the fully-qualified `crate::collection::BUSY` with `crate::db::BUSY`, including inside doc comments. In `lib.rs:133` the form is `collection::BUSY` (module-scoped import at the top of the file) — change it to `db::BUSY`; `db` is already imported there.

Do **not** use PowerShell `-replace` for this: it is case-insensitive, so it would also rewrite unrelated identifiers, and a backtick fix-up writes invisible BEL bytes into source. Edit the sites by hand, or drive `.Replace()` from a `.mjs` file.

- [ ] **Step 5: Update the rule file**

`src-tauri/CLAUDE.md:180-181` currently reads:

```
- Writes take `AppState.db` through `db::lock_for(…, WRITE_LOCK_WAIT)` and answer
  `collection::BUSY` if they cannot — reads go through `db_read` like everything else.
```

Replace with:

```
- Writes take `AppState.db` through the one `sync::with_write`, which is
  `db::lock_for(…, WRITE_LOCK_WAIT)` and answers `db::BUSY` if it cannot — reads go through
  `db_read` like everything else. The sentence lives beside the bound that produces it, and
  the helper beside `AppState`; both were five and eleven copies until 2026-08-16.
```

(This anticipates Task 2. Both tasks land in this branch; if you are running Task 1 alone, write only the `db::BUSY` half and add the `with_write` half in Task 2.)

- [ ] **Step 6: Format, build and test**

```powershell
cd D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components\src-tauri
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test
```

Expected: clean clippy, all tests pass. `collection.rs`'s existing `assert_eq!(answer.unwrap_err(), BUSY)` at `:1822` proves the sentence did not change — it is the regression test for this task and needs no new sibling.

- [ ] **Step 7: Verify and commit**

```powershell
cd D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components
npm run verify > verify.log 2>&1
Select-String -Path verify.log -Pattern 'Test Files|Tests  |test result|error\['
```

Expected: no `error[`, all suites pass.

```bash
git add src-tauri/src src-tauri/CLAUDE.md
git commit -m "chore(rust): move BUSY to db.rs, beside the bound that produces it"
```

---

### Task 2: One `with_write`, beside `AppState`

Five character-identical private definitions and six inlined copies of the same four lines.

**Files:**
- Modify: `src-tauri/src/sync.rs` (insert after the lock delegates, `:400`)
- Delete from: `src-tauri/src/collection.rs:498-511`, `src-tauri/src/deck.rs:3169-3178`, `src-tauri/src/deck_meta.rs:1577-1588`, `src-tauri/src/deck_theory.rs:495-505`, `src-tauri/src/wishlist.rs:513-524`
- Collapse inline: `src-tauri/src/card.rs:564-567`, `src-tauri/src/deck_import.rs:983-987`, `src-tauri/src/deck_undo.rs:1152-1155` and `:1170-1173`, `src-tauri/src/marketplace.rs:110-113`, `src-tauri/src/lib.rs:129-134`
- Test: `src-tauri/src/sync.rs` (new)

**Interfaces:**
- Consumes: `crate::db::BUSY` (Task 1).
- Produces: `pub(crate) fn with_write<T>(state: &AppState, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String>`.
  Note the parameter is `&AppState`, **not** `&Arc<AppState>`. Every call site holds an `Arc<AppState>` and writes `with_write(&state, …)`; deref coercion turns `&Arc<AppState>` into `&AppState` at the call, so **no call site changes** beyond its `use` line. `index/lifecycle.rs` already passes `&AppState` in the same shape, which is why this is the signature that fits both.

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/sync.rs`'s existing `mod tests`:

```rust
/// A write that cannot have the connection answers the one sentence, after spending the one
/// bound — and runs `f` when it can. Five copies of this helper agreed on that by accident
/// until 2026-08-16; now there is one and this is what holds it.
#[test]
fn with_write_answers_busy_rather_than_queueing_when_the_connection_is_held() {
    let (state, dir) = file_state("with-write-busy", false);
    let held = crate::db::lock_blocking(&state.db);

    let start = std::time::Instant::now();
    let answer: Result<(), String> = with_write(&state, |_| Ok(()));
    let waited = start.elapsed();

    assert_eq!(
        answer.unwrap_err(),
        crate::db::BUSY,
        "a write that cannot have the connection answers the one sentence"
    );
    // It spent the bound rather than failing instantly or queueing forever.
    assert!(
        waited >= crate::db::WRITE_LOCK_WAIT,
        "with_write must spend the whole bound before giving up, waited {waited:?}"
    );
    drop(held);

    // And with the connection free it runs `f` and hands back its answer.
    let answer = with_write(&state, |c| {
        c.query_row("SELECT 1", [], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())
    });
    assert_eq!(answer.unwrap(), 1);

    drop(state);
    let _ = std::fs::remove_dir_all(dir);
}
```

`file_state(name, syncing) -> (AppState, PathBuf)` is the existing helper at the top of `sync.rs`'s test module (`sync.rs:1126`). It builds a real file-backed pair of connections in `std::env::temp_dir()`, which is what this test needs — an in-memory pair cannot stand in, because two in-memory connections are two different databases. Note it hands back a bare `AppState`, which is exactly the shape the new helper takes.

- [ ] **Step 2: Run it and watch it fail**

```powershell
cd D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components\src-tauri
cargo test --lib sync::tests::with_write_answers_busy
```

Expected: FAIL to compile — `cannot find function 'with_write' in this scope`.

- [ ] **Step 3: Add the one definition**

Insert into `src-tauri/src/sync.rs` after the last lock delegate (`lock_db_read`, around `:400`):

```rust
/// Run `f` with the write connection, or answer [`crate::db::BUSY`].
///
/// Bounded rather than blocking: every caller is a button press on a worker thread, and the
/// one thing that can hold `AppState.db` for any length of time is a sync — which, since the
/// ingest was chunked, holds it for one batch at a time.
///
/// **This is the one definition of that rule**, the way [`crate::db::lock_plain`] is the one
/// definition of poison recovery. It was five identical private copies (`collection`, `deck`,
/// `deck_meta`, `deck_theory`, `wishlist`) plus six sites that inlined the same four lines,
/// each documented as "kept per-module the way every other one in this crate is" — which was
/// true, and was the problem.
///
/// Here rather than in [`crate::db`] because the parameter is [`AppState`]: `db` is the layer
/// below and must not learn about the app's state. `&AppState` rather than `&Arc<AppState>`
/// so that both shapes of caller fit — a command holding an `Arc` gets deref coercion for
/// free, and [`crate::index::lifecycle`], which holds a bare reference, needs no clone.
///
/// **Never call this while holding a guard on `state.db`** — it would deadlock on itself.
/// `do_sync`'s orphan-sweep arm is the site that has to remember: it passes its already-open
/// connection down instead.
pub(crate) fn with_write<T>(
    state: &AppState,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    match crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
        Some(conn) => f(&conn),
        None => Err(crate::db::BUSY.to_owned()),
    }
}
```

- [ ] **Step 4: Run the test and watch it pass**

```powershell
cargo test --lib sync::tests::with_write_answers_busy
```

Expected: PASS. (It sleeps for `WRITE_LOCK_WAIT` — five seconds — by design. That is the one slow test this plan adds; it is worth it, because the bound is the whole point of the helper.)

- [ ] **Step 5: Delete the five private copies**

In each of `collection.rs`, `deck.rs`, `deck_meta.rs`, `deck_theory.rs`, `wishlist.rs`: delete the `fn with_write` and its doc block, and add `use crate::sync::with_write;` to the file's imports (each already imports `crate::sync::AppState`, so extend that line where one exists).

**Keep all three `fn unfinished(e: tauri::Error) -> String` copies** (`deck.rs:3181`, `deck_meta.rs:1590`, `deck_theory.rs:508`). Their messages differ on purpose — "the deck could not be written", "the deck's categories, tags or folders could not be written" — and collapsing them would make one of the two wrong.

**Keep `collection::with_write_owned`** (`collection.rs:526`). It now reads:

```rust
fn with_write_owned<T>(
    state: &Arc<AppState>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let answer = crate::sync::with_write(state, f);
    if answer.is_ok() {
        crate::index::lifecycle::invalidate_owned(state);
    }
    answer
}
```

Its doc block stays as it is — the house rule it states (re-read *after* the guard is gone, never inside it) is still exactly what it does, and is now the only thing in the file that has to say it.

- [ ] **Step 6: Collapse the six inline sites**

Each is a `match crate::db::lock_for(…) { Some(conn) => …, None => Err(…) }` inside a `spawn_blocking` closure. Rewrite each as a `with_write` call. For example, `card.rs:563-568` becomes:

```rust
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store_group_by(conn, &mode))
    })
```

and `marketplace.rs:109-114`:

```rust
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &id))
    })
```

and `lib.rs:128-135`:

```rust
    tauri::async_runtime::spawn_blocking(move || {
        sync::with_write(&state, |conn| {
            errors::clear(conn).map_err(|e| format!("could not clear the error log: {e}"))
        })
    })
```

`deck_import.rs:982-988` and both `deck_undo.rs` sites follow the same shape. Note the closure argument becomes `conn: &Connection` where the old code had `&conn` on a guard — drop the `&` at the call inside, as shown.

Delete the now-false doc sentence at `deck_import.rs:970-973` ("inlined rather than borrowing a `with_write` helper the way `deck.rs` and `deck_meta.rs` do, because this module has exactly one write and a helper for one call site is a second place to read") and replace that paragraph with:

```rust
/// The **write** connection through [`crate::sync::with_write`], answering
/// [`crate::db::BUSY`] if it cannot be had.
```

Do the same for the two per-module doc sentences that claim the copy is deliberate — `deck_meta.rs:1577-1579` and `deck_theory.rs:495-496`. Leaving them in place would be a rule file that argues against its own code.

- [ ] **Step 7: Format, lint, test**

```powershell
cd D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components\src-tauri
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test
```

Expected: clean. Watch specifically for `unused_imports` on the files that used to define `with_write` — if one of them no longer needs `Connection` or `Arc`, clippy will say so.

- [ ] **Step 8: Verify and commit**

```powershell
cd D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components
npm run verify > verify.log 2>&1
Select-String -Path verify.log -Pattern 'Test Files|Tests  |test result|error\['
```

```bash
git add src-tauri/src src-tauri/CLAUDE.md
git commit -m "chore(rust): one with_write beside AppState, deleting eleven copies"
```

---

### Task 3: Bind the finish vocabulary to `schema::FINISHES`

Five independent spellings of `nonfoil|foil|etched`, with nothing checking any two against each other — the only CHECK-constrained vocabulary in the crate that escaped the `schema::CONSTANT` + walking-test rule.

**Files:**
- Modify: `src-tauri/src/schema.rs:320` (insert beside `DECK_VARIANTS`), and its `mod tests` (new test)
- Modify: `src-tauri/src/collection.rs:14-16` (delete), `:229`, `:232`, `:759`
- Modify: `src-tauri/src/wishlist.rs:14`, `:221`, `:224`
- Modify: `src-tauri/src/sorting.rs:205-213`, `:240`, and its test at `:617`
- Modify: `src-tauri/src/card.rs:30`, `:80-89`
- Modify: `src-tauri/src/marketplace_feed.rs:123`, `:332-341`, `:414-418`
- Modify: `src-tauri/CLAUDE.md:158`

**Interfaces:**
- Produces: `pub const FINISHES: [&str; 3]` in `crate::schema`, value `["nonfoil", "foil", "etched"]` — the same array, the same order.
- Produces: `pub(crate) fn finish_literals() -> [String; 3]` in `crate::sorting`, replacing `pub(crate) const FINISH_LITERALS: [&str; 3]`.
- Consumes: nothing from earlier tasks.

**Do not** rewrite the three DDL `CHECK (finish IN ('nonfoil','foil','etched'))` literals to interpolate the constant. That is forbidden here for the same reason `CATEGORY_KINDS`' doc gives: a migration step is history, and editing what it creates would rewrite the CHECK on a *fresh* install while every upgraded database kept the old one. The DDL keeps its literals and gains a test.

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/schema.rs`'s `mod tests`, beside `a_category_kind_is_one_of_the_five_and_predefined_names_round_trip`:

```rust
/// Every table that CHECKs a finish accepts exactly [`FINISHES`] and nothing else.
///
/// Three tables spell the list out in their own DDL — frozen, like every migration step —
/// so this is what holds the constant and the three literals together. It is
/// `a_category_kind_is_one_of_the_five_and_predefined_names_round_trip`'s shape, over the
/// one vocabulary that had no such test until 2026-08-16.
#[test]
fn a_finish_is_one_of_the_three_on_every_table_that_checks_it() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();

    let is_check_failure = |err: &rusqlite::Error| {
        matches!(err, rusqlite::Error::SqliteFailure(e, _)
                 if e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_CHECK)
    };

    // `collection_entries.finish` — NOT NULL, so all three and nothing else.
    let owned = |finish: &str| {
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,
                 created_at,updated_at)
             VALUES (?1,'lea','161','en',?2,'NM',1,unixepoch(),unixepoch())",
            rusqlite::params![format!("owned-{finish}"), finish],
        )
    };
    for finish in FINISHES {
        owned(finish).unwrap_or_else(|e| panic!("`{finish}` must be a legal finish, but: {e}"));
    }
    let err = owned("gilded").expect_err("`gilded` is not a finish the CHECK knows");
    assert!(is_check_failure(&err), "`gilded` was refused, but not by a CHECK: {err}");

    // `wishlist_entries.preferred_finish` — nullable, so all three *plus* NULL.
    let wished = |finish: Option<&str>| {
        conn.execute(
            "INSERT INTO wishlist_entries
                (oracle_id,name,quantity,preferred_finish,created_at,updated_at)
             VALUES (?1,'Black Lotus',1,?2,unixepoch(),unixepoch())",
            rusqlite::params![format!("wish-{}", finish.unwrap_or("any")), finish],
        )
    };
    for finish in FINISHES {
        wished(Some(finish))
            .unwrap_or_else(|e| panic!("`{finish}` must be a legal preferred finish, but: {e}"));
    }
    wished(None).expect("a wish naming no finish is legal — it is filled by any");
    let err = wished(Some("gilded")).expect_err("`gilded` is not a finish the CHECK knows");
    assert!(is_check_failure(&err), "`gilded` was refused, but not by a CHECK: {err}");

    // `marketplace_prices.finish` — NOT NULL, one row per (marketplace, card, finish).
    let priced = |finish: &str| {
        conn.execute(
            "INSERT INTO marketplace_prices (marketplace,card_id,finish,price)
             VALUES ('cardkingdom','bolt',?1,1.0)",
            rusqlite::params![finish],
        )
    };
    for finish in FINISHES {
        priced(finish).unwrap_or_else(|e| panic!("`{finish}` must be a priceable finish, but: {e}"));
    }
    let err = priced("gilded").expect_err("`gilded` is not a finish the CHECK knows");
    assert!(is_check_failure(&err), "`gilded` was refused, but not by a CHECK: {err}");
}
```

- [ ] **Step 2: Run it and watch it fail**

```powershell
cd D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components\src-tauri
cargo test --lib schema::tests::a_finish_is_one_of_the_three
```

Expected: FAIL to compile — `cannot find value 'FINISHES' in this scope`.

- [ ] **Step 3: Move the constant into `schema.rs`**

Insert immediately after `DECK_VARIANTS` (`src-tauri/src/schema.rs:320`):

```rust
/// Scryfall's finish enum. Never a boolean — `etched` is a third thing, and collapsing it
/// into `foil: true` is the single most common way an importer loses data.
///
/// CHECK-constrained on `collection_entries.finish`, `wishlist_entries.preferred_finish`
/// (which is additionally nullable, meaning "any") and `marketplace_prices.finish`. All
/// three spell the list out in their own DDL for [`CATEGORY_KINDS`]' reason — a step is
/// history — and `a_finish_is_one_of_the_three_on_every_table_that_checks_it` is what keeps
/// the copies honest. A fourth finish is a new migration step, never an edit here.
///
/// **The order is load-bearing**: it is `nonfoil → foil → etched`, cheapest first, which is
/// the order [`crate::sorting::finish_literals`] builds a price chain in and the field order
/// of the card pane's `FinishPrices`. Here rather than in [`crate::collection`], where it
/// began, because `sorting`, `card` and `marketplace_feed` all need it and none of them owns
/// a collection — it is a schema vocabulary like the four above it.
pub const FINISHES: [&str; 3] = ["nonfoil", "foil", "etched"];
```

Delete `src-tauri/src/collection.rs:14-16` (the doc block and the old definition).

- [ ] **Step 4: Run the test and watch it pass**

```powershell
cargo test --lib schema::tests::a_finish_is_one_of_the_three
```

Expected: PASS.

- [ ] **Step 5: Repoint the two direct readers**

`collection.rs` already has `use crate::schema::COLLECTION_GRAIN;` at `:8` — extend it:

```rust
use crate::schema::{COLLECTION_GRAIN, FINISHES};
```

`wishlist.rs:14` becomes (combining with Task 1's change if that has landed):

```rust
use crate::collection::{valid_quantity, EntryChange};
use crate::db::BUSY;
use crate::schema::FINISHES;
```

The three uses in `collection.rs` (`:229`, `:232`, `:759`) and two in `wishlist.rs` (`:221`, `:224`) keep the bare name and do not change.

- [ ] **Step 6: Derive `sorting`'s SQL literals from it**

Replace `src-tauri/src/sorting.rs:205-213` with:

```rust
/// The three finishes as the SQL literals [`price_expr`] takes, in the order a chain across
/// them reads: `nonfoil → foil → etched`, cheapest first.
///
/// That builder's `finish` argument is normally the *caller's expression* for the finish being
/// priced — `e.finish` on the collection, `coalesce(w.preferred_finish, 'nonfoil')` on the
/// wishlist. The two callers here price a printing in all three at once instead, so each is a
/// constant: [`printing_price_by_finish_expr`], and the card pane's `FinishPrices`, whose field
/// order this also is.
///
/// **Derived from [`crate::schema::FINISHES`] rather than respelled**, which is the rule the
/// rest of the crate's CHECK vocabularies already follow (`deck_audit::ADD` is
/// `schema::AUDIT_KINDS[0]`, `deck::LIVE` is `DECK_VARIANTS[0]`). Quoting here rather than in
/// the constant because a SQL literal is this module's concern and not the schema's — the
/// three `format!`s are built once per query alongside a SQL string of several kilobytes.
pub(crate) fn finish_literals() -> [String; 3] {
    crate::schema::FINISHES.map(|finish| format!("'{finish}'"))
}
```

Update the two production callers. `sorting.rs:239-243`:

```rust
pub fn printing_price_by_finish_expr(market: Marketplace) -> String {
    let links = finish_literals()
        .map(|finish| price_expr(market, &finish))
        .join(",\n");
    format!("coalesce({links})")
}
```

`card.rs:88-92`:

```rust
fn finish_price_columns(market: Marketplace) -> String {
    crate::sorting::finish_literals()
        .map(|finish| crate::sorting::price_expr(market, &finish))
        .join(", ")
}
```

and drop `FINISH_LITERALS` from `card.rs:30`'s import, leaving `use crate::sorting::Marketplace;`. Fix the intra-doc link at `card.rs:80` to `` [`crate::sorting::finish_literals`] ``. Update the test at `sorting.rs:617` (`for finish in FINISH_LITERALS`) to `for finish in finish_literals()` and take a reference where it passes the value on.

- [ ] **Step 7: Index the feed's three spellings off the same constant**

Add near the top of `src-tauri/src/marketplace_feed.rs`, beside the other module constants:

```rust
// The three finish names, read by index off the one vocabulary rather than respelled —
// `deck_audit::ADD = schema::AUDIT_KINDS[0]`'s shape. Both feeds file rows under these and
// `marketplace_prices.finish` CHECKs them.
const NONFOIL: &str = crate::schema::FINISHES[0];
const FOIL: &str = crate::schema::FINISHES[1];
const ETCHED: &str = crate::schema::FINISHES[2];
```

Rewrite `ck_finish`'s body (`:332-341`) to return `ETCHED` / `FOIL` / `NONFOIL` in place of the three string literals — the doc block above it, including the two-field rule and the 1 162-row measurement, stays exactly as it is. Rewrite the Mana Pool tuple (`:414-418`):

```rust
            let quoted = [
                (NONFOIL, row.price_cents_nm),
                (FOIL, row.price_cents_nm_foil),
                (ETCHED, row.price_cents_nm_etched),
            ];
```

Fix the intra-doc link at `:123` from `` [`crate::collection::FINISHES`] `` to `` [`crate::schema::FINISHES`] ``, and the comment at `schema.rs:1224` likewise.

- [ ] **Step 8: Add the feed's own round-trip test**

The Mana Pool tuple pairs each finish with a *different struct field*, so it cannot be generated from the constant — a test is what binds it. Add to `marketplace_feed.rs`'s `mod tests`:

```rust
/// A Mana Pool row quoting all three finishes files them under exactly
/// [`crate::schema::FINISHES`] and nothing else.
///
/// `ck_finish` needs no such test — indexing off the constant binds it at compile time. This
/// tuple cannot be built that way, because it pairs each finish with a *different column* of
/// the feed's row, so a test is what holds it to the vocabulary.
#[test]
fn a_mana_pool_row_quoting_every_finish_files_all_three_under_the_schema_names() {
    let body = r#"{"data": [
        {"scryfall_id": "a",
         "price_cents_nm": 100, "price_cents_nm_foil": 200, "price_cents_nm_etched": 300}
    ]}"#;

    let feed = collect(&ManaPool, body).unwrap();

    // `priced` sorts, so compare as sets — the order the tuple lists its three columns in is
    // this test's business only insofar as all three arrive.
    let mut written: Vec<&str> = priced(&feed).into_iter().map(|(_, finish, _)| finish).collect();
    written.sort_unstable();
    let mut expected = crate::schema::FINISHES.to_vec();
    expected.sort_unstable();
    assert_eq!(
        written, expected,
        "every finish the feed quotes must be filed under the one vocabulary"
    );
}
```

`collect(&ManaPool, body)` and `priced(&feed)` are the module's existing test helpers (`marketplace_feed.rs:1158` and `:1166`); `priced` returns `Vec<(String, &'static str, f64)>` sorted by `(card_id, finish)`, which is why this compares sorted sets rather than the tuple's declaration order.

- [ ] **Step 9: Update the rule file**

`src-tauri/CLAUDE.md:158` names `FINISH_LITERALS`. Change the phrase `price_expr` once per `FINISH_LITERALS` entry` to `` `price_expr` once per `schema::FINISHES` entry (through `sorting::finish_literals`) ``, and add one bullet to the **Hard rules — user data** section after the finish bullet at line 128:

```
- **`schema::FINISHES` is the one finish vocabulary and is read by index, never respelled.**
  `sorting::finish_literals` quotes it for SQL, `marketplace_feed`'s `NONFOIL`/`FOIL`/`ETCHED`
  index it, and the three DDL `CHECK`s spell it out because a migration step is history —
  `a_finish_is_one_of_the_three_on_every_table_that_checks_it` is what holds those three
  literals to the constant. A fourth finish is a new migration step.
```

- [ ] **Step 10: Format, lint, verify, commit**

```powershell
cd D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components\src-tauri
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test
cd D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components
npm run verify > verify.log 2>&1
Select-String -Path verify.log -Pattern 'Test Files|Tests  |test result|error\['
```

```bash
git add src-tauri/src src-tauri/CLAUDE.md
git commit -m "feat(rust): bind the finish vocabulary to schema::FINISHES"
```

---

### Task 4: `deck_audit::by_id` — one nine-column SELECT

`deck_undo::audit_entry` re-spells `deck_audit::list`'s nine-column SELECT and its row mapping verbatim. Adding a tenth `deck_audit` column today means finding two places.

**Files:**
- Modify: `src-tauri/src/deck_audit.rs:241-268`
- Delete from: `src-tauri/src/deck_undo.rs:1030-1055`
- Test: `src-tauri/src/deck_audit.rs` (new)

**Interfaces:**
- Produces: `pub(crate) fn by_id(conn: &Connection, audit_id: i64) -> Result<Option<DeckAuditEntry>, String>` in `crate::deck_audit`.
- Produces: `fn entry_from_row(r: &rusqlite::Row) -> rusqlite::Result<DeckAuditEntry>` (private) plus `const AUDIT_SELECT: &str`.

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/deck_audit.rs`'s `mod tests`:

```rust
/// `by_id` and `list` read the same row. They were two hand-written copies of one
/// nine-column SELECT until 2026-08-16; this is what stops them becoming two again.
#[test]
fn by_id_answers_the_row_list_answers_and_none_for_an_id_that_is_not_there() {
    let conn = seeded();
    let d = deck(&conn, "Burn");

    let id = record(
        &conn,
        d,
        "live",
        ADD,
        Some(("bolt-lea", "Lightning Bolt")),
        &json!({}),
        4,
    )
    .unwrap();

    let listed = list(&conn, d, 10).unwrap();
    assert_eq!(listed.len(), 1, "the deck has exactly the one row just written");
    let fetched = by_id(&conn, id).unwrap().expect("the row it just wrote is findable");
    assert_eq!(fetched, listed[0], "by_id and list must answer the same row");

    assert!(
        by_id(&conn, id + 1000).unwrap().is_none(),
        "an id with no row is None, not an error"
    );
}
```

`seeded()` (`deck_audit.rs:295`) and `deck(&conn, name)` (`deck_audit.rs:313`) are this test module's own helpers — three printings of two oracle cards, and a deck made through `deck::create_deck`. Do not reach for `crate::schema::tests::deck`; this module has its own.

`record`'s signature is `record(tx, deck_id, variant, kind, card: Option<(&str, &str)>, payload: &serde_json::Value, delta: i64) -> Result<i64, String>` (`deck_audit.rs:192`), and `ADD` is `crate::schema::AUDIT_KINDS[0]`, already in scope in the module. The module's tests already import `serde_json::{json, Value}`, so write the payload as `&json!({})`.

`DeckAuditEntry` derives only `Debug, Serialize` today (`deck_audit.rs:84`). Add `PartialEq`:

```rust
#[derive(Debug, PartialEq, Serialize)]
```

A derive on a plain data struct — no behaviour, and it is what makes "the two readers answer the same row" expressible as one assertion instead of nine.

- [ ] **Step 2: Run it and watch it fail**

```powershell
cd D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components\src-tauri
cargo test --lib deck_audit::tests::by_id_answers_the_row
```

Expected: FAIL to compile — `cannot find function 'by_id'`.

- [ ] **Step 3: Extract the select and the mapper, add `by_id`**

In `src-tauri/src/deck_audit.rs`, above `list`:

```rust
/// The nine columns a [`DeckAuditEntry`] is, in [`entry_from_row`]'s order.
///
/// One constant because two readers want the same row: [`list`], and [`by_id`] for the delta
/// a reversal negates. A tenth column is one edit here and one in the mapper below.
const AUDIT_SELECT: &str =
    "SELECT id, deck_id, at, variant, kind, card_id, card_name, payload, delta FROM deck_audit";

/// One row of [`AUDIT_SELECT`], in its column order.
fn entry_from_row(r: &rusqlite::Row) -> rusqlite::Result<DeckAuditEntry> {
    Ok(DeckAuditEntry {
        id: r.get(0)?,
        deck_id: r.get(1)?,
        at: r.get(2)?,
        variant: r.get(3)?,
        kind: r.get(4)?,
        card_id: r.get(5)?,
        card_name: r.get(6)?,
        payload: r.get(7)?,
        delta: r.get(8)?,
    })
}

/// One history row by id, or `None` if there is no such row.
///
/// [`crate::deck_undo`]'s, for the state command and for the delta a reversal negates. `None`
/// rather than an error for [`list`]'s reason: the history of something that is not there is
/// nothing, and `deck_audit.deck_id` CASCADEs.
pub(crate) fn by_id(conn: &Connection, audit_id: i64) -> Result<Option<DeckAuditEntry>, String> {
    conn.query_row(
        &format!("{AUDIT_SELECT} WHERE id = ?1"),
        params![audit_id],
        entry_from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}
```

Pass `entry_from_row` by name rather than wrapping it in `|r| entry_from_row(r)` — clippy's `redundant_closure` fires on the wrapper and the build runs `-D warnings`. If the compiler cannot infer the higher-ranked lifetime on the bare name, the closure form is correct and you must then add `#[allow(clippy::redundant_closure)]` with a one-line comment saying why.

Rewrite `list`'s body to use both:

```rust
pub fn list(conn: &Connection, deck_id: i64, limit: i64) -> Result<Vec<DeckAuditEntry>, String> {
    let limit = limit.clamp(1, MAX_LIMIT);
    let mut stmt = conn
        .prepare(&format!(
            "{AUDIT_SELECT}
              WHERE deck_id = ?1
              ORDER BY at DESC, id DESC
              LIMIT ?2"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id, limit], entry_from_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}
```

`list`'s existing doc block — the `idx_deck_audit_deck` reasoning and the empty-list-for-a-missing-deck rule — stays untouched above it.

`by_id`'s `.optional()` needs `OptionalExtension`, which this module does not import today. Change `deck_audit.rs:40` from

```rust
use rusqlite::{params, Connection};
```

to

```rust
use rusqlite::{params, Connection, OptionalExtension};
```

- [ ] **Step 4: Run the test and watch it pass**

```powershell
cargo test --lib deck_audit::tests::by_id_answers_the_row
```

Expected: PASS.

- [ ] **Step 5: Delete the copy in `deck_undo.rs`**

Remove `fn audit_entry` (`src-tauri/src/deck_undo.rs:1030-1055`) entirely, and replace its call sites with `crate::deck_audit::by_id(conn, audit_id)`. Find them with:

```powershell
Select-String -Path 'D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components\src-tauri\src\deck_undo.rs' -Pattern 'audit_entry'
```

The signature and return type are identical, so each call site changes by name only. Drop `OptionalExtension` from `deck_undo.rs`'s imports if nothing else there uses it — clippy will tell you.

- [ ] **Step 6: Format, lint, verify, commit**

```powershell
cd D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components\src-tauri
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test
cd D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components
npm run verify > verify.log 2>&1
Select-String -Path verify.log -Pattern 'Test Files|Tests  |test result|error\['
```

```bash
git add src-tauri/src
git commit -m "chore(rust): one deck_audit row reader, read by list and by_id"
```

---

### Task 5: One `Source::Database` / `Kind::Io` failure logger

`sync::note_database` and `index::lifecycle::note_index_failure` are the same function — the same source, the same kind, the same lock, the same best-effort contract. `lifecycle.rs:38-41` already says so in prose.

**Files:**
- Modify: `src-tauri/src/sync.rs:544-559` (visibility + doc)
- Delete from: `src-tauri/src/index/lifecycle.rs:36-64`
- Modify: `src-tauri/src/index/lifecycle.rs:198`, `:227` (call sites)

**Interfaces:**
- Consumes: nothing.
- Produces: `pub(crate) fn note_database(state: &AppState, operation: &str, message: &str)` — note the parameter widens from `&Arc<AppState>` to `&AppState`, matching Task 2's `with_write` and letting `lifecycle.rs`'s bare reference call it without a clone. `sync.rs`'s own six call sites (`:690, :694, :729, :733, :827, :831`) pass `&Arc<AppState>` and are unchanged by deref coercion.

**Leave `note_scryfall` and `update.rs`'s `note_github` alone.** They classify — `note_scryfall` calls `errors::kind_of(err)`, `note_github` pattern-matches on message text — and are not copies of anything. Leave `images.rs:568-588` alone too: it uses its own `NOTE_LOCK_WAIT` of 200 ms rather than `WRITE_LOCK_WAIT`, a deliberate divergence, and folding it in would mean a wait parameter on a function whose whole value is having none.

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/index/lifecycle.rs`'s `mod tests`:

```rust
/// A failed index build lands in `error_log` as the app's own database failing at its own
/// work — `Source::Database` + `Kind::Io`, which is `sync::note_database` and no longer a
/// second copy of it.
#[test]
fn a_failed_index_build_is_recorded_as_a_database_io_failure() {
    let state = state_with_seeded_cards("note-database");
    crate::sync::note_database(&state, "index_build", "the corpus could not be read");

    let conn = crate::db::lock_blocking(&state.db);
    let (source, kind, operation, message): (String, String, String, String) = conn
        .query_row(
            "SELECT source, kind, operation, message FROM error_log
              ORDER BY last_at DESC, rowid DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .expect("the failure was written down");
    assert_eq!(source, "database", "the app's own SQLite failing at its own work");
    assert_eq!(kind, "io", "the fix is a disk or a database, not a query");
    assert_eq!(operation, "index_build");
    assert_eq!(message, "the corpus could not be read");
}
```

`state_with_seeded_cards(name) -> Arc<AppState>` is already imported at the top of this test module (`use crate::index::fixtures::{own, state_with_seeded_cards};`). `&state` is an `&Arc<AppState>` and coerces to the `&AppState` the widened `note_database` takes.

The two column values are `Source::Database.key()` and `Kind::Io.key()` — `"database"` and `"io"` (`errors.rs:66` and `:94`). `error_log`'s upsert is keyed on `(source, operation, kind, message)`, so a second call with the same four would bump `count` rather than add a row; this test writes one and reads one.

- [ ] **Step 2: Run it and watch it fail**

```powershell
cd D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components\src-tauri
cargo test --lib index::lifecycle::tests::a_failed_index_build
```

Expected: FAIL to compile — `function 'note_database' is private`.

- [ ] **Step 3: Widen `note_database` and fold the lifecycle doc into it**

`src-tauri/src/sync.rs:544-559` becomes:

```rust
/// Note a failure of the app's own database work — a sweep, a reclaim, a compaction, a failed
/// index build.
///
/// These were `eprintln!` and nothing else, which in a release build is a message with
/// nowhere to go.
///
/// [`crate::errors::Source::Database`] with [`crate::errors::Kind::Io`]: this is the app's own
/// SQLite failing at its own work, and the fix is a disk or a database rather than a query.
/// `index/lifecycle.rs` kept an identical private copy of this until 2026-08-16.
///
/// Best-effort, and skipped rather than waited for if the write connection is busy: it
/// describes a failure that has already happened, on a path that is already returning an
/// error, and no part of it is worth blocking on.
///
/// **Take the write lock here only if you are not already holding it.** `do_sync`'s
/// orphan-sweep arm is the site that has to remember: it has the connection in hand and calls
/// [`crate::errors::record`] directly, because coming through here would deadlock on a lock
/// that scope holds. `spawn_build` holds nothing, and `collection::with_write_owned` releases
/// its guard before calling `invalidate_owned` — which its own doc names as the house rule.
pub(crate) fn note_database(state: &AppState, operation: &str, message: &str) {
    if let Some(conn) = crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
        crate::errors::record(
            &conn,
            crate::errors::Source::Database,
            operation,
            crate::errors::Kind::Io,
            message,
            None,
        );
    }
}
```

- [ ] **Step 4: Delete the copy and repoint its two callers**

Remove `fn note_index_failure` and its doc block from `src-tauri/src/index/lifecycle.rs:36-64`. At `:198` and `:227`, replace `note_index_failure(state, …)` with `crate::sync::note_database(state, …)`. Both already hold a `&AppState`, so the arguments do not change.

- [ ] **Step 5: Run the test and watch it pass**

```powershell
cargo test --lib index::lifecycle::tests::a_failed_index_build
```

Expected: PASS.

- [ ] **Step 6: Format, lint, verify, commit**

```powershell
cd D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components\src-tauri
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test
cd D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components
npm run verify > verify.log 2>&1
Select-String -Path verify.log -Pattern 'Test Files|Tests  |test result|error\['
```

```bash
git add src-tauri/src
git commit -m "chore(rust): one database-io failure logger for sync and the index"
```

---

### Task 6: One image-URI query, two policies

`card::card_image_uri_inner` re-writes the two `json_extract`s of `images::resolve` with the face pinned to `0`, deliberately skipping that function's `is_fetchable` host fence. Same query, different policy, held apart by a doc comment.

**The policy difference stays.** This task does not make `card.rs` apply the host fence — that would be a behaviour change, and the doc argues the skip is intentional. It extracts only the SQL, so the difference between the two becomes visible as "card.rs does not call the fence" instead of "card.rs has its own SQL".

**Files:**
- Modify: `src-tauri/src/images.rs:253-264`
- Modify: `src-tauri/src/card.rs:431-457`
- Test: `src-tauri/src/images.rs` (new)

**Interfaces:**
- Produces: `pub(crate) fn image_uri_row(conn: &Connection, card_id: &str, variant: &str, face: i64) -> Result<Option<(Option<String>, Option<String>)>, String>` in `crate::images`. The tuple is `(top_level, face)`, in that order — the order the SELECT lists them, and the *opposite* of the order both callers destructure them into, so keep the names.

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/images.rs`'s `mod tests`:

```rust
/// The one row both readers take. `card::card_image_uri_inner` and [`resolve`] each apply
/// their own policy to it — the card pane deliberately skips the host fence — but they must
/// never disagree about *which two columns* a printing's picture is in.
#[test]
fn image_uri_row_answers_both_columns_and_none_for_an_unknown_card() {
    let conn = seeded();

    // The plain printing: a top-level image for every variant, no per-face ones.
    let (top, face) = image_uri_row(&conn, "0000419b-0bba-4488-8f7a-6194544ce91d", "grid", 0)
        .unwrap()
        .expect("a card that is in the corpus answers a row");
    assert_eq!(
        top.as_deref(),
        Some("https://cards.scryfall.io/grid/front/0/0/x.webp?17")
    );
    assert_eq!(face, None, "a normal printing carries no per-face images");

    // The transform: per-face images and no top-level one, and face 1 is its own picture.
    // Which of the two a caller then *uses* is the caller's policy, not this function's.
    let (top, face) = image_uri_row(&conn, "ab000000-0000-0000-0000-000000000001", "grid", 1)
        .unwrap()
        .unwrap();
    assert_eq!(top, None, "a transform carries no top-level image");
    assert_eq!(
        face.as_deref(),
        Some("https://cards.scryfall.io/grid/back/a/b/y.webp?9")
    );

    assert!(
        image_uri_row(&conn, "not-a-card", "grid", 0).unwrap().is_none(),
        "an unknown card is None, not an error"
    );
}
```

`seeded()` is the module's existing fixture (`images.rs:1463`): a normal printing with all four top-level variants, a transform with per-face `grid` images on both faces, an art-series printing with no image at all, and one of the eight printings whose URI is an error page. The variant strings are `schema::IMAGE_VARIANTS` — `thumb`/`grid`/`display`/`art`, WEBP only — never Scryfall's own `normal`/`large` names.

- [ ] **Step 2: Run it and watch it fail**

```powershell
cd D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components\src-tauri
cargo test --lib images::tests::image_uri_row_answers_both_columns
```

Expected: FAIL to compile — `cannot find function 'image_uri_row'`.

- [ ] **Step 3: Extract the query**

In `src-tauri/src/images.rs`, above `resolve`:

```rust
/// The two columns a printing's picture can be in, for one variant and one face.
///
/// `(top_level, face)` — `image_uris` and `card_faces[face].image_uris`, spec §5's pair.
/// `None` for a card that is not in the corpus.
///
/// One function because two readers want the same row and apply **different policies** to it:
/// [`resolve`] falls back from face to top-level only for face 0 and then puts the answer
/// through [`is_fetchable`] and the cache-buster check, while
/// `card::card_image_uri_inner` pins the face to 0 and deliberately skips both fences. That
/// difference is real and stays; what may not differ is which two columns the picture lives
/// in, and this is now the one place that says so.
///
/// **Read-only by contract**, like [`resolve`]: every caller passes `db_read`.
pub(crate) fn image_uri_row(
    conn: &Connection,
    card_id: &str,
    variant: &str,
    face: i64,
) -> Result<Option<(Option<String>, Option<String>)>, String> {
    conn.query_row(
        "SELECT json_extract(image_uris, '$.' || ?2),
                json_extract(face_image_uris, '$[' || ?3 || '].' || ?2)
         FROM cards WHERE id = ?1",
        params![card_id, variant, face],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}
```

Replace `resolve`'s own `query_row` (`images.rs:253-264`) with:

```rust
    let row = image_uri_row(conn, &key.card_id, key.variant.key(), key.face as i64)?;
```

Everything below it in `resolve` — the `let Some((top, face)) = row else { return Ok(Resolution::Unknown) };`, the face-first comment, the fence — is unchanged.

- [ ] **Step 4: Run the test and watch it pass**

```powershell
cargo test --lib images::tests::image_uri_row_answers_both_columns
```

Expected: PASS.

- [ ] **Step 5: Point `card.rs` at it**

`src-tauri/src/card.rs:431-457` becomes:

```rust
fn card_image_uri_inner(
    conn: &Connection,
    card_id: &str,
    variant: &str,
) -> Result<Option<String>, String> {
    if !crate::schema::IMAGE_VARIANTS.contains(&variant) {
        return Err(format!("unknown image variant: {variant}"));
    }
    // The face index is the literal `0`: this command takes no face, and face 0 is the whole
    // of what a printing's picture means here.
    let row = crate::images::image_uri_row(conn, card_id, variant, 0)?;
    // Face first, top-level second — `images::resolve`'s
    // `face.or_else(|| (key.face == 0).then_some(top).flatten())` with the face pinned to 0,
    // so the two cannot answer differently about the front of a card. A `meld` printing
    // carries both, and its top-level image is its front and nothing else.
    //
    // **Deliberately without `resolve`'s host fence.** That function answers `NoImage` for a
    // URI off `cards.scryfall.io` or one with no `?<epoch>` cache-buster, because it is about
    // to cache the bytes; this command hands a URL back to a caller who is not caching, and
    // refusing one here would be a policy `resolve` owns and this does not. The query is
    // shared; the policy is not.
    Ok(row.and_then(|(top, face)| face.or(top)))
}
```

- [ ] **Step 6: Format, lint, verify, commit**

```powershell
cd D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components\src-tauri
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test
cd D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components
npm run verify > verify.log 2>&1
Select-String -Path verify.log -Pattern 'Test Files|Tests  |test result|error\['
```

```bash
git add src-tauri/src
git commit -m "chore(rust): one image-uri query for the cache and the card pane"
```

---

## Closing out

- [ ] **Delete the scratch log**

`verify.log` is not committed. Remove it before opening the PR: `Remove-Item D:\Code\mtg-grimoire\.claude\worktrees\refac-rust-components\verify.log`. (Check whether `.gitignore` already covers it; if not, do not add it — just delete the file.)

- [ ] **Re-read the two rule-file edits together**

Tasks 1, 2 and 3 each touch `src-tauri/CLAUDE.md`. Read the finished file's lines 125-135 and 178-185 as prose and make sure they still read as one voice — a prose-only edit routes to neither CI job, so nothing goes red when a rule file rots.

- [ ] **Ship**

Follow the `shipping-a-branch` skill: `npm run verify`, push, open the PR, merge `main` in (never rebase), wait for `ci-ok`. The agent does not press Merge.

## Notes for the implementer

- **The Rust coverage number will move and that is expected.** These tasks delete production lines and add test lines. `npm run test:coverage:rust` reads ~14 points high because it counts the inline `#[cfg(test)]` modules; see [test-coverage.md](../../reference/test-coverage.md) before quoting either figure.
- **`cargo test` occasionally flakes under load** on temp-dir races and 5 000 ms timeouts. A single failure in a suite that passed a moment ago is more likely that than your change — re-run the one test before investigating. Task 2's new test deliberately waits five seconds; do not "fix" it by shortening `WRITE_LOCK_WAIT`.
- **ripgrep treats `docs/reference/decks-storage.md` as binary**, so a Grep there returning "no matches" is a lie. Use `Read` or `Select-String` for that file.
- Every line number in this plan was read off the tree at commit `23d15d5`. If a merge from `main` has moved them, the surrounding code quoted here is what identifies each site.
