# Baseline Claim Emissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a baseline claim changes a row only where the row is missing something no log will bring, changes it exactly once, never lands ahead of a put it contains, and costs a device that already holds everything nothing.

**Architecture:** a claim names its emission (`Op::emission`: id, index, and on each chunk's head the count, the emitter's generation and whether it resumed). A receiver keeps a ledger in `sync_state` — consumed indices per emission, a `taken@` mark per emitter, a `gap` flag, `carried@` marks — in a new `sync_engine::emission` module, and decides each page in a new `apply::claims` submodule called from two seams in `apply_in`. Claims never touch `sync_peers`. The emitter mints the emission in the stretch that reads its rows; the client passes the batches it holds back into `apply` as held ops.

**Tech Stack:** Rust (rusqlite, serde, serde_json), the `grimoire-core` and `mtg-grimoire` crates, cargo tests over two-to-four real in-memory databases.

**Spec:** `docs/superpowers/specs/2026-10-03-baseline-claim-emissions-design.md` (revision 2). Read it first; every task cites its sections.

## Global Constraints

- **Preconditions.** Tasks 1–7 start only after the rewritten narrow fix (`fix/sync-baseline-claim-skipped-as-seen`) is merged into `main`. Tasks 8–9 start only after #761 step 6b (the sync client's move into `crates/grimoire-core`) is merged. Before each, `git fetch origin` and merge `origin/main` into the branch — **merge, never rebase**.
- Work in a worktree off a fresh `main` (`superpowers:using-git-worktrees`, then the `worktree-setup` skill: `npm install` inside it).
- **No schema rung.** Every new mark is a `sync_state` key: `logging_since`, `logging_resumed`, `gap`, `taken@<device>`, `emission@<device>`, `carried@<device>`.
- **Every new wire key is `#[serde(default, skip_serializing_if = …)]`.** An ordinary op serialises byte for byte as before; nothing on the wire is `deny_unknown_fields`.
- **Claims never read or write `sync_peers`**, never create a device block, and are never held as collateral by stamp (spec §5).
- **§8.2's never-held under-count stays exactly as it is** — `a_claim_and_a_later_delta_on_a_row_never_held_still_undercount` in `apply/tests.rs` is not edited.
- **Ops without an `emission` reference keep the narrow fix's rules unchanged** (spec §10). Do not edit the narrow fix's arms in `apply_in`; route around them.
- **Never `cargo fmt --all`** (it rewrites `crates/card-scanner`). Format with `cargo fmt -p grimoire-core` and `cargo fmt -p mtg-grimoire`.
- **Never run two `npm run verify` at once**, in this worktree or across worktrees.
- `npm run verify` before every commit; commit messages `feat:`/`fix:`/`test:`/`docs:` ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Do not write counts of tests or tables into prose (root `CLAUDE.md`, *Global rules*).

## Review Focus

1. **A claim whose chunk head is missing** (a truncated or malformed page: `emission` present, `n`/`since` absent everywhere in the page) → judged as an op with no reference, never a panic, never taken. Test: Task 4 `a_claim_whose_head_is_missing_is_judged_as_one_with_no_reference`.
2. **An emission whose `n` is 0 or below its highest index** → never taken, its claims still consumed once. Test: Task 4 `an_emission_with_no_count_is_never_taken_and_still_applies_once`.
3. **A page holding one emitter's emission from before a rejoin beside one from after it** → the older inert, the newer active. Test: Task 5 `an_emission_from_before_a_rejoin_is_inert_beside_one_from_after_it`.
4. **A `sync_state` mark that does not parse** (hand-edited, truncated) → read as absent: more work, never a failed apply. Tests: Task 2 `unparseable_marks_read_as_absent`, Task 4 `a_taken_mark_that_does_not_parse_leaves_the_emission_active`.
5. **More emissions in flight from one emitter than the ledger keeps** → the oldest record evicted, no error. Test: Task 2 `the_ledger_keeps_the_newest_emissions`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `crates/grimoire-core/src/sync_engine/merge.rs` | **Modify.** `Emission` struct; `Op::emission` field |
| `crates/grimoire-core/src/sync_engine/emission.rs` | **Create.** The ledger: clock tick, generation minting, `Ranges`, `Record`, `taken@`, `emission@`, `carried@`, `gap` |
| `crates/grimoire-core/src/sync_engine/mod.rs` | **Modify.** `pub mod emission;` |
| `crates/grimoire-core/src/sync_engine/baseline.rs` | **Modify.** `number`, `head`; `horizon` reads `carried@` |
| `crates/grimoire-core/src/sync_engine/apply/claims.rs` | **Create.** `decide` (before grouping) and `settle` (after the committed pass) |
| `crates/grimoire-core/src/sync_engine/apply.rs` | **Modify.** `mod claims`; `apply_page`; `Class::HeldBack`; seams in `apply_in`; claims out of `held_by`, `blocks_of`, `advance_watermarks`; `update_row` (Task 7) |
| `crates/grimoire-core/src/sync_engine/apply/emission_tests.rs` | **Create.** Every apply-level scenario of spec §14, with its own fixtures |
| `crates/grimoire-core/src/sync_engine/apply/tests.rs` | **Modify.** `emission: None` in two `Op` literals; the two owed tests' `#[ignore]` reasons |
| `crates/grimoire-core/src/sync_engine/capture.rs` | **Modify.** `emission: None` in `op_from_row` |
| `src-tauri/src/sync_engine/mod.rs` | **Modify (until 6b moves it).** Re-export `emission` |
| the moved `sync_pair/identity.rs` | **Modify (Task 8).** Mint the generation; keep it on leave; open the gap on forget |
| the moved `sync_engine/client.rs` and `client/tests.rs` | **Modify (Task 9).** Emission head and numbering; nothing pending; held-back batches into `apply`; the unreadable gap |
| the moved `sync_engine/wire.rs` | **Modify (Tasks 1, 9).** `emission: None` in test literals; the size test |
| `docs/reference/sync.md`, `docs/superpowers/specs/2026-08-29-sync-baseline-design.md`, `src-tauri/CLAUDE.md` | **Modify (Task 10).** The record, the amendment, the binding rule |

**Why the scenarios get their own test file:** `apply/tests.rs` is the narrow fix's file and changes under every sync branch. `emission_tests.rs` copies the half-dozen fixtures it needs, so this work merges without touching that file's body.

---

### Task 1: The wire field

**Files:**
- Modify: `crates/grimoire-core/src/sync_engine/merge.rs`
- Modify: every `Op { … }` literal — find them with `grep -rn "schema: None\|schema: Some" crates src-tauri/src --include=*.rs` (on `main` at `dfce2194` they were in `merge.rs`, `baseline.rs`, `capture.rs`, `apply/tests.rs` ×2, `wire.rs` ×2, `sync_pair/identity.rs`)
- Test: `crates/grimoire-core/src/sync_engine/merge.rs` (its `tests` module)

**Interfaces:**
- Produces: `pub struct merge::Emission { pub id: (i64, i64), pub i: u32, pub n: Option<u32>, pub since: Option<(i64, i64)>, pub resumed: bool }` and `pub emission: Option<Emission>` on `merge::Op`.

- [ ] **Step 1: Confirm the preconditions**

Run: `git fetch origin && git log origin/main --oneline -30`
Expected: the narrow fix's merge is there (its commit subject begins `fix(sync): a covered put`). If it is not, stop: this plan builds on it.

- [ ] **Step 2: Write the failing tests** — append to `merge.rs`'s `mod tests`:

```rust
    /// Design 2026-10-03 §3: an emission rides a claim and nothing else, as `[ms, ctr]` arrays,
    /// and the head's keys are left off every op but a chunk's first.
    #[test]
    fn an_emission_rides_a_claim_and_nothing_else_on_the_wire() {
        let ordinary = serde_json::to_string(&put("dev-a", 1, json!({}), json!({}))).unwrap();
        assert!(!ordinary.contains("emission"), "{ordinary}");

        let mut c = claim("dev-a", 10, json!({"quantity": 2}));
        c.emission = Some(Emission {
            id: (5, 0),
            i: 3,
            n: Some(7),
            since: Some((1, 0)),
            resumed: true,
        });
        let text = serde_json::to_string(&c).unwrap();
        assert!(
            text.contains(r#""emission":{"id":[5,0],"i":3,"n":7,"since":[1,0],"resumed":true}"#),
            "{text}"
        );
        let back: Op = serde_json::from_str(&text).unwrap();
        assert_eq!(back, c);

        let body = Emission {
            id: (5, 0),
            i: 4,
            n: None,
            since: None,
            resumed: false,
        };
        assert_eq!(serde_json::to_string(&body).unwrap(), r#"{"id":[5,0],"i":4}"#);
    }

    /// ...and an op a build before the field sent reads as having none.
    #[test]
    fn an_op_written_before_emissions_reads_as_having_none() {
        let old: Op = serde_json::from_str(
            r#"{"table":"decks","uid":"u1","kind":"put","at":{"ms":1,"ctr":0,"device":"a"},"baseline":true}"#,
        )
        .unwrap();
        assert_eq!(old.emission, None);
    }
```

- [ ] **Step 3: Run them to see them fail**

Run: `cargo test -p grimoire-core --lib sync_engine::merge::tests::an_`
Expected: compile error — `Emission` and `Op::emission` do not exist.

- [ ] **Step 4: Add the struct and the field** — in `merge.rs`, above `pub struct Op`:

```rust
/// A claim's place in the emission it belongs to — the baseline claim design of 2026-10-03, §3.
///
/// `id` is one tick of the emitter's clock as `[ms, ctr]`, unique per device and ordering its
/// emissions; `i` is the op's index in the emission, from 0. `n`, `since` and `resumed` ride the
/// first op of every chunk, as the horizon does, because each chunk is pulled on its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Emission {
    pub id: (i64, i64),
    pub i: u32,
    /// How many ops the emission sends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub n: Option<u32>,
    /// The emitter's generation: the stamp at which its capture last turned on (§4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<(i64, i64)>,
    /// The generation began after the emitter had logged in a group before (§4).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub resumed: bool,
}
```

and inside `pub struct Op`, after `schema`:

```rust
    /// A claim's emission and its place in it — design 2026-10-03 §3. Only baseline ops carry
    /// one. An older receiver ignores the key, and an op without it is judged as it always was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emission: Option<Emission>,
```

Then add `emission: None,` to every `Op { … }` literal the grep in **Files** found.

- [ ] **Step 5: Run the tests and the crates' builds**

Run: `cargo test -p grimoire-core --lib sync_engine::merge` then `cargo build -p mtg-grimoire --tests`
Expected: PASS; both build.

- [ ] **Step 6: Commit**

```bash
cargo fmt -p grimoire-core && cargo fmt -p mtg-grimoire
git add -A crates/grimoire-core/src src-tauri/src
git commit -m "feat(sync): a baseline op can name its emission on the wire"
```

---

### Task 2: The emission ledger

**Files:**
- Create: `crates/grimoire-core/src/sync_engine/emission.rs`
- Modify: `crates/grimoire-core/src/sync_engine/mod.rs` (add `pub mod emission;` and a line in the module doc's list)
- Modify: `src-tauri/src/sync_engine/mod.rs` (add `pub use grimoire_core::sync_engine::emission;` beside the other re-exports — skip if 6b has already restructured that file)
- Test: `emission.rs`'s own `mod tests`

**Interfaces:**
- Consumes: `merge::Horizon`.
- Produces (all in `crate::sync_engine::emission`):
  - `pub type Stamp = (i64, i64);`
  - `pub const LOGGING_SINCE, LOGGING_RESUMED, GAP: &str; pub const RECORDS_PER_EMITTER: usize = 4;`
  - `pub struct Begun { pub id: Stamp, pub since: Stamp, pub resumed: bool }`
  - `pub fn tick(&Connection) -> rusqlite::Result<Stamp>`
  - `pub fn begin(&Connection) -> rusqlite::Result<Begun>`
  - `pub fn start_logging(&Connection) -> rusqlite::Result<()>`
  - `pub fn keep_logging_mark(&Connection) -> rusqlite::Result<()>`
  - `pub struct Ranges` with `contains(u32) -> bool`, `insert(u32)`, `len() -> u64`, `is_empty() -> bool`
  - `pub struct Record { pub id, pub n: u32, pub since, pub resumed, pub wrote: Ranges, pub passed: Ranges }` with `new(Stamp, u32, Stamp, bool)`, `consumed(u32) -> bool`, `complete() -> bool`
  - `pub fn taken(&Connection, emitter: &str) -> rusqlite::Result<Option<Stamp>>`
  - `pub fn records(&Connection, emitter: &str) -> rusqlite::Result<Vec<Record>>`
  - `pub fn keep(&Connection, emitter: &str, record: Record) -> rusqlite::Result<()>`
  - `pub fn take(&Connection, emitter: &str, record: &Record, horizon: &Horizon, me: Option<&str>) -> rusqlite::Result<()>`
  - `pub fn carried(&Connection) -> rusqlite::Result<BTreeMap<String, Stamp>>`
  - `pub fn open_gap(&Connection) -> rusqlite::Result<()>`, `pub fn gap_open(&Connection) -> rusqlite::Result<bool>`, `pub fn close_gap_if_whole(&Connection) -> rusqlite::Result<()>`

- [ ] **Step 1: Write the failing tests** — create `emission.rs` holding only the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_engine::hlc::Hlc;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = crate::schema::memory_pair();
        crate::sync_engine::capture::install(&conn).unwrap();
        conn
    }

    fn value(conn: &Connection, key: &str) -> Option<String> {
        get(conn, key).unwrap()
    }

    #[test]
    fn ranges_coalesce_and_count() {
        let mut r = Ranges::default();
        for i in [3, 1, 2, 7, 5, 6, 2] {
            r.insert(i);
        }
        assert_eq!(r.0, vec![(1, 3), (5, 7)]);
        assert_eq!(r.len(), 6);
        assert!(r.contains(6) && !r.contains(4) && !r.contains(0));
    }

    #[test]
    fn begin_ticks_and_reads_the_generation() {
        let conn = db();
        let one = begin(&conn).unwrap();
        let two = begin(&conn).unwrap();
        assert!(two.id > one.id, "{one:?} then {two:?}");
        assert_eq!((one.since, one.resumed), ((0, 0), false), "no generation is `0`");

        start_logging(&conn).unwrap();
        let first = begin(&conn).unwrap();
        assert!(first.since > (0, 0));
        assert!(!first.resumed, "a first generation does not resume");

        start_logging(&conn).unwrap();
        let again = begin(&conn).unwrap();
        assert!(again.since > first.since);
        assert!(again.resumed, "a generation minted over one resumes");
    }

    #[test]
    fn a_device_that_logged_before_this_build_resumes_after_leaving() {
        let conn = db();
        keep_logging_mark(&conn).unwrap();
        assert_eq!(value(&conn, LOGGING_SINCE).as_deref(), Some("0:0"));
        start_logging(&conn).unwrap();
        assert!(begin(&conn).unwrap().resumed);

        // ...and the mark never overwrites a generation it finds.
        let held = value(&conn, LOGGING_SINCE);
        keep_logging_mark(&conn).unwrap();
        assert_eq!(value(&conn, LOGGING_SINCE), held);
    }

    #[test]
    fn a_record_completes_only_when_every_index_below_n_is_consumed() {
        let mut r = Record::new((9, 0), 3, (1, 0), false);
        r.wrote.insert(0);
        r.passed.insert(1);
        assert!(!r.complete());
        r.wrote.insert(2);
        assert!(r.complete());
        let mut empty = Record::new((9, 0), 0, (1, 0), false);
        empty.wrote.insert(0);
        assert!(!empty.complete(), "an emission that says it sends nothing is never taken");
    }

    #[test]
    fn the_ledger_keeps_the_newest_emissions() {
        let conn = db();
        for ms in 1..=5 {
            keep(&conn, "dev-a", Record::new((ms, 0), 1, (1, 0), false)).unwrap();
        }
        let ids: Vec<Stamp> = records(&conn, "dev-a").unwrap().iter().map(|r| r.id).collect();
        assert_eq!(ids, vec![(5, 0), (4, 0), (3, 0), (2, 0)]);
    }

    #[test]
    fn taking_an_emission_marks_it_drops_what_it_supersedes_and_carries_its_horizon() {
        let conn = db();
        keep(&conn, "dev-a", Record::new((2, 0), 1, (1, 0), false)).unwrap();
        keep(&conn, "dev-a", Record::new((6, 0), 1, (5, 0), true)).unwrap();
        let mut horizon = Horizon::default();
        for (device, ms) in [("dev-c", 900), ("dev-b", 50), ("dev-a", 70)] {
            horizon.seen.insert(
                device.to_owned(),
                Hlc { ms, ctr: 0, device: device.to_owned() },
            );
        }
        let done = Record::new((2, 0), 1, (1, 0), false);
        take(&conn, "dev-a", &done, &horizon, Some("dev-b")).unwrap();

        assert_eq!(taken(&conn, "dev-a").unwrap(), Some((1, 0)));
        let left: Vec<Stamp> = records(&conn, "dev-a").unwrap().iter().map(|r| r.id).collect();
        assert_eq!(left, vec![(6, 0)], "only the newer generation's record stays");
        let c = carried(&conn).unwrap();
        assert_eq!(c.get("dev-c"), Some(&(900, 0)));
        assert_eq!(c.get("dev-a"), Some(&(70, 0)));
        assert_eq!(c.get("dev-b"), None, "this device carries nothing of its own");
    }

    #[test]
    fn a_gap_clears_the_marks_and_closes_once_the_roster_is_taken_again() {
        let conn = db();
        let done = Record::new((2, 0), 1, (1, 0), false);
        take(&conn, "dev-a", &done, &Horizon::default(), None).unwrap();
        keep(&conn, "dev-a", Record::new((6, 0), 1, (5, 0), false)).unwrap();
        put(&conn, "absorbed@dev-a", "4:0").unwrap();
        put(&conn, LOGGING_SINCE, "3:0").unwrap();

        open_gap(&conn).unwrap();
        assert!(gap_open(&conn).unwrap());
        assert_eq!(taken(&conn, "dev-a").unwrap(), None);
        assert!(records(&conn, "dev-a").unwrap().is_empty());
        assert_eq!(value(&conn, "absorbed@dev-a").as_deref(), Some("4:0"), "not ours to clear");
        assert_eq!(value(&conn, LOGGING_SINCE).as_deref(), Some("3:0"));

        // dev-a is on the roster and has a watermark; dev-z has a watermark from an old group.
        conn.execute_batch(
            "INSERT INTO sync_peers (device_id, last_ms, last_ctr) VALUES ('dev-a', 1, 0), ('dev-z', 1, 0);
             INSERT INTO sync_devices (device_id, public_key, name, added_at) VALUES ('dev-a', x'00', 'dev-a', 0);",
        )
        .unwrap();
        close_gap_if_whole(&conn).unwrap();
        assert!(gap_open(&conn).unwrap(), "dev-a has not been taken again");
        take(&conn, "dev-a", &done, &Horizon::default(), None).unwrap();
        close_gap_if_whole(&conn).unwrap();
        assert!(!gap_open(&conn).unwrap(), "dev-z is on no roster and holds nothing open");
    }

    #[test]
    fn unparseable_marks_read_as_absent() {
        let conn = db();
        put(&conn, "taken@dev-a", "garbage").unwrap();
        put(&conn, "emission@dev-a", "{").unwrap();
        put(&conn, "carried@dev-c", "x:y").unwrap();
        put(&conn, LOGGING_SINCE, "nope").unwrap();
        assert_eq!(taken(&conn, "dev-a").unwrap(), None);
        assert!(records(&conn, "dev-a").unwrap().is_empty());
        assert!(carried(&conn).unwrap().is_empty());
        assert_eq!(begin(&conn).unwrap().since, (0, 0));
    }
}
```

and add `pub mod emission;` to `crates/grimoire-core/src/sync_engine/mod.rs`.

- [ ] **Step 2: Run them to see them fail**

Run: `cargo test -p grimoire-core --lib sync_engine::emission`
Expected: compile errors — none of the items exist.

- [ ] **Step 3: Write the module** — above the test module in `emission.rs`:

```rust
//! What a device remembers about baseline emissions — the baseline claim design of 2026-10-03
//! (`docs/superpowers/specs/2026-10-03-baseline-claim-emissions-design.md`), §4, §5, §7, §8.
//!
//! **Every mark is a `sync_state` key, and none of them is `sync_peers`.** A claim is a statement
//! about a row, not a place in its emitter's stream, so what remembers that it was consumed is a
//! ledger of its own: per emitter, the emissions in flight and the indices consumed from each;
//! the generation it has wholly taken; and what complete emissions carried into this device's
//! rows. A gap — the watermark or the cursor passing an op this device never applied — clears
//! the ledger, so the next emission from every emitter is read whole.
//!
//! **A value that does not parse reads as absent.** Absent makes an emission active, which is
//! more work and never less correctness, so a hand-edited or truncated mark costs a re-read,
//! never a failed apply.

use super::merge::Horizon;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// `(ms, ctr)` on one device's clock.
pub type Stamp = (i64, i64);

/// The stamp at which this device's capture last turned on — its generation (§4).
pub const LOGGING_SINCE: &str = "logging_since";
/// `"1"` when that generation was minted over an earlier one (§4).
pub const LOGGING_RESUMED: &str = "logging_resumed";
/// Present while this device has a gap (§7).
pub const GAP: &str = "gap";
const TAKEN: &str = "taken@";
const RECORDS: &str = "emission@";
const CARRIED: &str = "carried@";
/// How many in-flight emissions are remembered per emitter. An emission older than these is
/// one a newer emission of the same emitter has superseded or will.
pub const RECORDS_PER_EMITTER: usize = 4;

fn get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM sync_state WHERE key = ?1", [key], |r| r.get(0))
        .optional()
}

fn put(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?1, ?2)",
        params![key, value],
    )
    .map(|_| ())
}

fn parse(v: &str) -> Option<Stamp> {
    let (ms, ctr) = v.split_once(':')?;
    Some((ms.parse().ok()?, ctr.parse().ok()?))
}

fn show(s: Stamp) -> String {
    format!("{}:{}", s.0, s.1)
}

fn json<T: Serialize>(value: &T) -> rusqlite::Result<String> {
    serde_json::to_string(value).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
}

/// One tick of `sync_clock`, which is what names an emission (§3) and stamps a generation (§4).
///
/// The capture trigger's own arithmetic, so the tick sits above every op this device has
/// captured and below every op it captures next.
pub fn tick(conn: &Connection) -> rusqlite::Result<Stamp> {
    conn.query_row(
        "UPDATE sync_clock SET
             ms  = max(ms, cast(unixepoch('subsec') * 1000 AS INTEGER)),
             ctr = CASE WHEN cast(unixepoch('subsec') * 1000 AS INTEGER) > ms THEN 0
                        ELSE ctr + 1 END
           WHERE id = 1
         RETURNING ms, ctr",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

/// What an emission is named and stamped with, minted in the stretch that reads its rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Begun {
    pub id: Stamp,
    pub since: Stamp,
    pub resumed: bool,
}

/// Name an emission and read the generation it goes out under. A device that has never minted a
/// generation emits `since: 0` — "the logging that began before this build" (§4).
pub fn begin(conn: &Connection) -> rusqlite::Result<Begun> {
    let id = tick(conn)?;
    let since = get(conn, LOGGING_SINCE)?
        .as_deref()
        .and_then(parse)
        .unwrap_or((0, 0));
    let resumed = get(conn, LOGGING_RESUMED)?.as_deref() == Some("1");
    Ok(Begun { id, since, resumed })
}

/// Capture has just turned on: mint a generation (§4). It resumes when one was held before —
/// `identity::leave_group` keeps it for exactly this.
pub fn start_logging(conn: &Connection) -> rusqlite::Result<()> {
    let resumed = get(conn, LOGGING_SINCE)?.is_some();
    let since = tick(conn)?;
    put(conn, LOGGING_SINCE, &show(since))?;
    put(conn, LOGGING_RESUMED, if resumed { "1" } else { "0" })
}

/// Leaving a group: keep the generation so the next one resumes, writing `0:0` for a device that
/// logged before this build and has none (§4).
pub fn keep_logging_mark(conn: &Connection) -> rusqlite::Result<()> {
    if get(conn, LOGGING_SINCE)?.is_none() {
        put(conn, LOGGING_SINCE, "0:0")?;
    }
    Ok(())
}

/// Sorted, disjoint, inclusive index ranges — an emission's consumed indices, compactly.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Ranges(Vec<(u32, u32)>);

impl Ranges {
    pub fn contains(&self, i: u32) -> bool {
        self.0.iter().any(|&(a, b)| a <= i && i <= b)
    }

    pub fn insert(&mut self, i: u32) {
        if self.contains(i) {
            return;
        }
        self.0.push((i, i));
        self.0.sort_unstable();
        let mut out: Vec<(u32, u32)> = Vec::with_capacity(self.0.len());
        for (a, b) in self.0.drain(..) {
            match out.last_mut() {
                Some(last) if a <= last.1.saturating_add(1) => last.1 = last.1.max(b),
                _ => out.push((a, b)),
            }
        }
        self.0 = out;
    }

    pub fn len(&self) -> u64 {
        self.0.iter().map(|&(a, b)| u64::from(b - a) + 1).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// One emission in flight, as this device has consumed it (§5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub id: Stamp,
    pub n: u32,
    pub since: Stamp,
    #[serde(default)]
    pub resumed: bool,
    /// Claims that built, merged or floored their row.
    #[serde(default)]
    pub wrote: Ranges,
    /// Claims consumed without writing: a held row's claim, a moot one, one dropped and recorded.
    #[serde(default)]
    pub passed: Ranges,
}

impl Record {
    pub fn new(id: Stamp, n: u32, since: Stamp, resumed: bool) -> Record {
        Record {
            id,
            n,
            since,
            resumed,
            wrote: Ranges::default(),
            passed: Ranges::default(),
        }
    }

    pub fn consumed(&self, i: u32) -> bool {
        self.wrote.contains(i) || self.passed.contains(i)
    }

    /// Every index below `n` consumed. An emission that says it sends nothing is never complete,
    /// so a malformed head cannot mark a generation taken.
    pub fn complete(&self) -> bool {
        self.n > 0 && (0..self.n).all(|i| self.consumed(i))
    }
}

/// The generation of `emitter` this device has wholly taken, if any.
pub fn taken(conn: &Connection, emitter: &str) -> rusqlite::Result<Option<Stamp>> {
    Ok(get(conn, &format!("{TAKEN}{emitter}"))?.as_deref().and_then(parse))
}

/// The emissions of `emitter` in flight here, newest first.
pub fn records(conn: &Connection, emitter: &str) -> rusqlite::Result<Vec<Record>> {
    Ok(get(conn, &format!("{RECORDS}{emitter}"))?
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default())
}

/// Store `record`, replacing one of the same `id`, keeping the newest [`RECORDS_PER_EMITTER`].
pub fn keep(conn: &Connection, emitter: &str, record: Record) -> rusqlite::Result<()> {
    let mut all = records(conn, emitter)?;
    all.retain(|r| r.id != record.id);
    all.push(record);
    all.sort_by_key(|r| std::cmp::Reverse(r.id));
    all.truncate(RECORDS_PER_EMITTER);
    put(conn, &format!("{RECORDS}{emitter}"), &json(&all)?)
}

/// An emission wholly consumed (§5, §8): its generation is taken, every record of the emitter at
/// or below that generation goes, and what its horizon names is carried here — each device's
/// `carried@` raised to the horizon's entry, this device's own excepted.
pub fn take(
    conn: &Connection,
    emitter: &str,
    record: &Record,
    horizon: &Horizon,
    me: Option<&str>,
) -> rusqlite::Result<()> {
    let key = format!("{TAKEN}{emitter}");
    if get(conn, &key)?
        .as_deref()
        .and_then(parse)
        .is_none_or(|held| record.since > held)
    {
        put(conn, &key, &show(record.since))?;
    }
    let mut all = records(conn, emitter)?;
    all.retain(|r| r.since > record.since);
    put(conn, &format!("{RECORDS}{emitter}"), &json(&all)?)?;
    for (device, at) in &horizon.seen {
        if Some(device.as_str()) == me {
            continue;
        }
        let key = format!("{CARRIED}{device}");
        if get(conn, &key)?
            .as_deref()
            .and_then(parse)
            .is_none_or(|held| (at.ms, at.ctr) > held)
        {
            put(conn, &key, &show((at.ms, at.ctr)))?;
        }
    }
    Ok(())
}

/// Every `carried@` mark, by device — what `baseline::horizon` adds to `sync_peers` (§8).
pub fn carried(conn: &Connection) -> rusqlite::Result<BTreeMap<String, Stamp>> {
    let mut stmt = conn.prepare("SELECT key, value FROM sync_state WHERE key GLOB ?1")?;
    let rows = stmt.query_map([format!("{CARRIED}*")], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (key, value) = row?;
        if let Some(stamp) = parse(&value) {
            out.insert(key[CARRIED.len()..].to_owned(), stamp);
        }
    }
    Ok(out)
}

/// A gap (§7): every `taken@` and `emission@` mark goes, and the floor opens.
pub fn open_gap(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM sync_state WHERE key GLOB ?1 OR key GLOB ?2",
        params![format!("{TAKEN}*"), format!("{RECORDS}*")],
    )?;
    put(conn, GAP, "1")
}

pub fn gap_open(conn: &Connection) -> rusqlite::Result<bool> {
    Ok(get(conn, GAP)?.is_some())
}

/// Close the gap once every device on this group's roster that this one holds a watermark for
/// has a `taken@` mark again (§7). The roster and not `sync_peers` alone: a watermark outlives
/// its group, and a peer of an old group never emits here again.
pub fn close_gap_if_whole(conn: &Connection) -> rusqlite::Result<()> {
    if !gap_open(conn)? {
        return Ok(());
    }
    let missing: i64 = conn.query_row(
        "SELECT count(*) FROM sync_peers p
           JOIN sync_devices d ON d.device_id = p.device_id AND d.revoked_at IS NULL
          WHERE NOT EXISTS (SELECT 1 FROM sync_state s WHERE s.key = ?1 || p.device_id)",
        [TAKEN],
        |r| r.get(0),
    )?;
    if missing == 0 {
        conn.execute("DELETE FROM sync_state WHERE key = ?1", [GAP])?;
    }
    Ok(())
}
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p grimoire-core --lib sync_engine::emission`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cargo fmt -p grimoire-core && cargo fmt -p mtg-grimoire
git add crates/grimoire-core/src/sync_engine/emission.rs crates/grimoire-core/src/sync_engine/mod.rs src-tauri/src/sync_engine/mod.rs
git commit -m "feat(sync): the emission ledger - generations, taken marks, the gap and carried"
```

---

### Task 3: The emitter's numbering, and a horizon that names what claims carried

**Files:**
- Modify: `crates/grimoire-core/src/sync_engine/baseline.rs`
- Test: `baseline.rs`'s `mod tests`

**Interfaces:**
- Consumes: `emission::{Begun, carried}`, `merge::Emission`.
- Produces: `pub fn baseline::number(ops: &mut [Op], begun: &emission::Begun)` and `pub fn baseline::head(first: &mut Op, n: usize, begun: &emission::Begun)`; `baseline::horizon` now reports `max(sync_peers, carried@)` per device.

- [ ] **Step 1: Write the failing tests** — append to `baseline.rs`'s `mod tests`:

```rust
    /// Design 2026-10-03 §3: every op names the emission and its index; only a chunk's first
    /// carries the head.
    #[test]
    fn an_emission_numbers_its_ops_and_heads_a_chunk() {
        use crate::sync_engine::emission::Begun;
        use crate::sync_engine::merge::Emission;
        let conn = paired("dev-a");
        add_copy(&conn, "c1", 1);
        add_copy(&conn, "c2", 1);
        let begun = Begun { id: (7, 1), since: (3, 0), resumed: true };
        let mut ops = build(&conn, "dev-a").unwrap();
        assert_eq!(ops.len(), 3, "the seeded folder and two rows");
        number(&mut ops, &begun);
        for (i, op) in ops.iter().enumerate() {
            assert_eq!(
                op.emission,
                Some(Emission { id: (7, 1), i: i as u32, n: None, since: None, resumed: false })
            );
        }
        head(&mut ops[0], ops.len(), &begun);
        assert_eq!(
            ops[0].emission,
            Some(Emission { id: (7, 1), i: 0, n: Some(3), since: Some((3, 0)), resumed: true })
        );
        assert_eq!(ops[1].emission.as_ref().unwrap().n, None);
    }

    /// Design §8: the horizon names what complete emissions carried in — the larger of a device's
    /// watermark and its `carried@` mark.
    #[test]
    fn the_horizon_names_what_complete_emissions_carried() {
        let conn = paired("dev-a");
        conn.execute_batch(
            "INSERT INTO sync_peers (device_id, last_ms, last_ctr) VALUES ('dev-c', 500, 3);
             INSERT INTO sync_state (key, value) VALUES ('carried@dev-c', '900:0'), ('carried@dev-d', '40:2');",
        )
        .unwrap();
        let h = horizon(&conn, "dev-a").unwrap();
        let at = |d: &str| h.seen.get(d).map(|s| (s.ms, s.ctr));
        assert_eq!(at("dev-c"), Some((900, 0)));
        assert_eq!(at("dev-d"), Some((40, 2)));

        conn.execute("UPDATE sync_state SET value = '100:0' WHERE key = 'carried@dev-c'", [])
            .unwrap();
        let h = horizon(&conn, "dev-a").unwrap();
        assert_eq!(h.seen.get("dev-c").map(|s| (s.ms, s.ctr)), Some((500, 3)));
    }
```

- [ ] **Step 2: Run them to see them fail**

Run: `cargo test -p grimoire-core --lib sync_engine::baseline::tests::an_emission_numbers sync_engine::baseline::tests::the_horizon_names_what`
Expected: compile error for `number`/`head`; once those exist, the horizon test fails with `Some((500, 3))` against `Some((900, 0))`.

- [ ] **Step 3: Implement** — in `baseline.rs`, add to the imports `use super::emission::{self, Begun};` and `use super::merge::Emission;`, then add:

```rust
/// Number an emission's ops in emission order — the baseline claim design of 2026-10-03, §3.
///
/// **Called after the rows too large to send are left out**, so `n` counts what is sent and an
/// index that never arrives cannot keep the emission from being taken.
pub fn number(ops: &mut [Op], begun: &Begun) {
    for (i, op) in ops.iter_mut().enumerate() {
        op.emission = Some(Emission {
            id: begun.id,
            i: i as u32,
            n: None,
            since: None,
            resumed: false,
        });
    }
}

/// What the first op of every chunk carries beside the horizon: how many ops the emission sends,
/// and the generation it goes out under (§3).
pub fn head(first: &mut Op, n: usize, begun: &Begun) {
    if let Some(e) = first.emission.as_mut() {
        e.n = Some(n as u32);
        e.since = Some(begun.since);
        e.resumed = begun.resumed;
    }
}
```

and in `horizon`, after the `sync_peers` loop and before the emitter's own top stamp is read:

```rust
    // **What complete emissions carried in is inside these rows too** (design 2026-10-03 §8):
    // a claim never raises `sync_peers`, so a horizon read from it alone would leave a put this
    // device took in through a claim uncovered, and a receiver would count it again.
    for (device, (ms, ctr)) in emission::carried(conn).map_err(|e| e.to_string())? {
        let at = Hlc { ms, ctr, device: device.clone() };
        match out.seen.get(&device) {
            Some(held) if *held >= at => {}
            _ => {
                out.seen.insert(device, at);
            }
        }
    }
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p grimoire-core --lib sync_engine::baseline`
Expected: PASS, the existing baseline tests included.

- [ ] **Step 5: Commit**

```bash
cargo fmt -p grimoire-core
git add crates/grimoire-core/src/sync_engine/baseline.rs
git commit -m "feat(sync): number a baseline's ops and name what claims carried in its horizon"
```

---

### Task 4: Claims leave the watermark, are consumed once, and are taken or inert

**Files:**
- Create: `crates/grimoire-core/src/sync_engine/apply/claims.rs`
- Create: `crates/grimoire-core/src/sync_engine/apply/emission_tests.rs`
- Modify: `crates/grimoire-core/src/sync_engine/apply.rs`
- Modify: `crates/grimoire-core/src/sync_engine/apply/tests.rs` (only the two owed tests' `#[ignore]` reasons)

**Interfaces:**
- Consumes: `emission::*` (Task 2), `baseline::{number, head, horizon, build}` (Task 3), `merge::Emission`.
- Produces: `pub(super) fn claims::decide(conn: &Connection, ops: &[Op], me: Option<&str>, seen: &dyn Fn(&Op) -> bool) -> Result<claims::Decided, String>` with public fields `skip: BTreeSet<usize>` and `keep: BTreeSet<usize>`; `pub(super) fn claims::settle(conn: &Connection, d: &Decided, committed: &[Deferral], me: Option<&str>) -> Result<(), String>`. In this task `decide` keeps every active claim (the row table is Task 5).

- [ ] **Step 1: Create the scenario file with its fixtures and this task's failing tests**

`apply.rs`: next to `mod rehome;` add `mod claims;` and `#[cfg(test)] mod emission_tests;`. Create `claims.rs` empty for now (`//! Filled in by Step 3.`). Create `emission_tests.rs`:

```rust
//! The baseline claim design's scenarios —
//! `docs/superpowers/specs/2026-10-03-baseline-claim-emissions-design.md` §14.
//!
//! **Its own fixtures, on purpose.** `apply/tests.rs` belongs to the narrow fix and changes under
//! every sync branch; the handful of helpers here are copied so this file merges without
//! touching that one.

use super::*;
use crate::sync_engine::{baseline, capture, emission};
use rusqlite::{Connection, OptionalExtension};

fn paired(device: &str) -> Connection {
    let conn = crate::schema::memory_pair();
    capture::install(&conn).unwrap();
    conn.execute(
        "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
         VALUES (1, ?1, x'00', x'01', ?1, 0)",
        [device],
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

fn outbox(conn: &Connection) -> Vec<Op> {
    let sql = format!("{} ORDER BY seq", capture::OPS_SELECT);
    let mut stmt = conn.prepare(&sql).unwrap();
    let ops = stmt
        .query_map([], capture::op_from_row)
        .unwrap()
        .map(|r| r.unwrap().1)
        .collect();
    ops
}

fn since(conn: &Connection, mark: &mut i64) -> Vec<Op> {
    let sql = format!("{} WHERE seq > ?1 ORDER BY seq", capture::OPS_SELECT);
    let mut stmt = conn.prepare(&sql).unwrap();
    let rows: Vec<(i64, Op)> = stmt
        .query_map([*mark], capture::op_from_row)
        .unwrap()
        .map(Result::unwrap)
        .collect();
    if let Some((seq, _)) = rows.last() {
        *mark = *seq;
    }
    rows.into_iter().map(|(_, op)| op).collect()
}

/// A second that has not happened yet, and a stamp 400 ms into it: a device whose clock is set
/// here stamps its next op at exactly [`STAMP`].
const SECOND: i64 = 4_000_000_000;
const STAMP: i64 = SECOND * 1000 + 400;

fn set_clock(conn: &Connection, ms: i64) {
    conn.execute("UPDATE sync_clock SET ms = ?1, ctr = 0", [ms])
        .unwrap();
}

fn stash(conn: &Connection, card: &str, quantity: i64, updated_at: i64) {
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,
             created_at,updated_at)
         VALUES (?1,'lea','1','en','nonfoil','NM',?2,?3,?3)",
        rusqlite::params![card, quantity, updated_at],
    )
    .unwrap();
}

fn step(conn: &Connection, card: &str, by: i64, updated_at: i64) {
    conn.execute(
        "UPDATE collection_entries SET quantity = quantity + ?2, updated_at = ?3
          WHERE card_id = ?1",
        rusqlite::params![card, by, updated_at],
    )
    .unwrap();
}

fn folder(conn: &Connection, name: &str, updated_at: i64) -> i64 {
    conn.execute(
        "INSERT INTO collection_folders (parent_id, name, kind, sort_order, created_at, updated_at)
         VALUES (NULL, ?1, 'user', 1, ?2, ?2)",
        rusqlite::params![name, updated_at],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn file_in(conn: &Connection, card: &str, quantity: i64, folder_id: i64, updated_at: i64) {
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,folder_id,
             created_at,updated_at)
         VALUES (?1,'lea','1','en','nonfoil','NM',?2,?3,?4,?4)",
        rusqlite::params![card, quantity, folder_id, updated_at],
    )
    .unwrap();
}

fn copies(conn: &Connection, card: &str) -> i64 {
    conn.query_row(
        "SELECT coalesce(sum(quantity), 0) FROM collection_entries WHERE card_id = ?1",
        [card],
        |r| r.get(0),
    )
    .unwrap()
}

fn rows(conn: &Connection, card: &str) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM collection_entries WHERE card_id = ?1",
        [card],
        |r| r.get(0),
    )
    .unwrap()
}

fn note(conn: &Connection, card: &str) -> String {
    conn.query_row(
        "SELECT coalesce(notes, '-') FROM collection_entries WHERE card_id = ?1",
        [card],
        |r| r.get(0),
    )
    .optional()
    .unwrap()
    .unwrap_or_else(|| "no row".to_owned())
}

fn folder_of(conn: &Connection, card: &str) -> Option<String> {
    conn.query_row(
        "SELECT f.name FROM collection_entries e
           LEFT JOIN collection_folders f ON f.id = e.folder_id
          WHERE e.card_id = ?1",
        [card],
        |r| r.get(0),
    )
    .unwrap()
}

fn qty(conn: &Connection) -> (i64, i64) {
    conn.query_row(
        "SELECT count(*), coalesce(sum(quantity), 0) FROM collection_entries",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

/// An emission as `client::emit_baselines` sends it, in chunks of `per`: every op numbered, and
/// each chunk's first op carrying the horizon and the head.
fn emit(conn: &Connection, device: &str, per: usize) -> Vec<Vec<Op>> {
    let begun = emission::begin(conn).unwrap();
    let mut ops = baseline::build(conn, device).unwrap();
    baseline::number(&mut ops, &begun);
    let horizon = baseline::horizon(conn, device).unwrap();
    let n = ops.len();
    ops.chunks(per.max(1))
        .map(|chunk| {
            let mut chunk = chunk.to_vec();
            chunk[0].horizon = Some(horizon.clone());
            baseline::head(&mut chunk[0], n, &begun);
            chunk
        })
        .collect()
}

fn whole(conn: &Connection, device: &str) -> Vec<Op> {
    emit(conn, device, usize::MAX).concat()
}

/// The chunk of a one-op-per-chunk emission that carries `card`'s claim.
fn chunk_of(chunks: &[Vec<Op>], card: &str) -> Vec<Op> {
    chunks
        .iter()
        .find(|c| c[0].fields.get("card_id").and_then(|v| v.as_str()) == Some(card))
        .unwrap()
        .clone()
}

fn page(parts: &[&[Op]]) -> Vec<Op> {
    parts.concat()
}

// ---------------------------------------------------------------------------------------------
// Task 4 — claims leave the watermark (spec §5, §6's inert row, §14 rows 1–4, 14)
// ---------------------------------------------------------------------------------------------

/// §14 row 1. The doorbell rings on the first chunk, so a peer can pull an emission in halves.
#[test]
fn a_baseline_pulled_in_two_halves_reaches_a_device_that_held_nothing() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    stash(&a, "c1", 1, 1_700_000_300);
    stash(&a, "c2", 1, 1_700_000_200);
    stash(&a, "c3", 1, 1_700_000_100);
    let chunks = emit(&a, "dev-a", 2);
    assert_eq!(chunks.len(), 2, "the seeded folder and three rows, two to a chunk");
    apply(&b, &page(&[&outbox(&a), &chunks[0]])).unwrap();
    apply(&b, &chunks[1]).unwrap();
    assert_eq!(qty(&b), (3, 3));
    assert_eq!(emission::taken(&b, "dev-a").unwrap(), Some((0, 0)));
}

/// §14 row 2. A row held before pairing has no insert on the log; its first edit is sparse.
#[test]
fn a_sparse_op_pulled_ahead_of_its_baseline_does_not_cost_the_row() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    set_clock(&a, STAMP);
    stash(&a, "bolt", 4, SECOND - 100);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    step(&a, "bolt", 1, SECOND);
    apply(&b, &outbox(&a)).unwrap();
    apply(&b, &whole(&a, "dev-a")).unwrap();
    assert_eq!(copies(&b, "bolt"), 5);
}

/// §14 row 3. An op of a's lands first, so b's watermark sits above the binder's claim.
#[test]
fn a_first_contact_parent_below_the_watermark_lands_with_its_child() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    let binder = folder(&a, "Binder", 1_700_000_000);
    file_in(&a, "bolt", 2, binder, SECOND + 10);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    stash(&a, "opt", 1, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let report = apply(&b, &whole(&a, "dev-a")).unwrap();
    assert_eq!(report.deferred, 0, "{report:?}");
    assert_eq!(folder_of(&b, "bolt").as_deref(), Some("Binder"));
    assert_eq!(copies(&b, "bolt"), 2);
}

/// §14 row 4. The sender's clock runs ahead; an applied edit lifts the watermark above a later
/// chunk's claim for a row with no op.
#[test]
fn a_later_chunk_lands_after_an_edit_from_a_fast_clock() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    stash(&a, "opt", 1, SECOND - 5);
    a.execute("DELETE FROM sync_ops WHERE seq > ?1", [ma]).unwrap();
    set_clock(&a, STAMP + 3_600_000);
    step(&a, "bolt", 1, SECOND);
    let edit = since(&a, &mut ma);
    let chunks = emit(&a, "dev-a", 1);
    apply(&b, &page(&[&edit, &chunk_of(&chunks, "bolt")])).unwrap();
    apply(&b, &chunk_of(&chunks, "opt")).unwrap();
    assert_eq!((copies(&b, "bolt"), copies(&b, "opt")), (3, 1));
}

/// §14 row 14. A claim waiting on its parent is held alone: its emitter's ordinary op lands.
#[test]
fn a_claim_held_mid_emission_lands_once_and_holds_nothing_else() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    let binder = folder(&a, "Binder", SECOND);
    file_in(&a, "bolt", 2, binder, SECOND);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    let chunks = emit(&a, "dev-a", 1);
    stash(&a, "opt", 1, SECOND + 1);
    let later = since(&a, &mut ma);

    let first = apply(&b, &page(&[&chunk_of(&chunks, "bolt"), &later])).unwrap();
    assert_eq!(first.held_waiting, 1, "{first:?}");
    assert_eq!(copies(&b, "opt"), 1, "a held claim held its emitter's ordinary op");
    assert_eq!(emission::taken(&b, "dev-a").unwrap(), None);

    let all = chunks.concat();
    apply(&b, &page(&[&all, &later])).unwrap();
    assert_eq!((copies(&b, "bolt"), folder_of(&b, "bolt").as_deref()), (2, Some("Binder")));
    assert_eq!(emission::taken(&b, "dev-a").unwrap(), Some((0, 0)));

    let third = apply(&b, &page(&[&all, &later])).unwrap();
    assert_eq!(third.applied, 0, "{third:?}");
}

/// Spec §6's inert row: a taken generation's re-broadcast is skipped with no database work.
#[test]
fn a_taken_generations_rebroadcast_writes_nothing() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    stash(&a, "bolt", 2, 1_700_000_000);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    apply(&b, &whole(&a, "dev-a")).unwrap();
    assert_eq!(emission::taken(&b, "dev-a").unwrap(), Some((0, 0)));
    b.execute("UPDATE collection_entries SET quantity = 1", []).unwrap();
    let again = apply(&b, &whole(&a, "dev-a")).unwrap();
    assert_eq!((again.applied, copies(&b, "bolt")), (0, 1), "{again:?}");
}

/// Review Focus 1.
#[test]
fn a_claim_whose_head_is_missing_is_judged_as_one_with_no_reference() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    stash(&a, "bolt", 2, 1_700_000_000);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    let mut ops = whole(&a, "dev-a");
    for op in &mut ops {
        if let Some(e) = op.emission.as_mut() {
            e.n = None;
            e.since = None;
        }
    }
    apply(&b, &ops).unwrap();
    assert_eq!(copies(&b, "bolt"), 2);
    assert_eq!(emission::taken(&b, "dev-a").unwrap(), None);
}

/// Review Focus 2.
#[test]
fn an_emission_with_no_count_is_never_taken_and_still_applies_once() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    stash(&a, "bolt", 2, 1_700_000_000);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    let mut ops = whole(&a, "dev-a");
    ops[0].emission.as_mut().unwrap().n = Some(0);
    apply(&b, &ops).unwrap();
    b.execute("UPDATE collection_entries SET quantity = 1", []).unwrap();
    let again = apply(&b, &ops).unwrap();
    assert_eq!((again.applied, copies(&b, "bolt")), (0, 1), "{again:?}");
    assert_eq!(emission::taken(&b, "dev-a").unwrap(), None);
}

/// Review Focus 4.
#[test]
fn a_taken_mark_that_does_not_parse_leaves_the_emission_active() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    stash(&a, "bolt", 2, 1_700_000_000);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    b.execute(
        "INSERT INTO sync_state (key, value) VALUES ('taken@dev-a', 'garbage')",
        [],
    )
    .unwrap();
    apply(&b, &whole(&a, "dev-a")).unwrap();
    assert_eq!(copies(&b, "bolt"), 2);
}
```

In `apply/tests.rs`, change the two owed tests' `#[ignore]` reasons — their claims carry no emission, so they now describe an older emitter:

```rust
#[ignore = "owed for an emitter older than the claim emissions design: a baseline pulled in two halves loses the claims its first half's watermark passes"]
```

```rust
#[ignore = "owed for an emitter older than the claim emissions design: a sparse op pulled ahead of its baseline puts the watermark above the row's claim"]
```

- [ ] **Step 2: Run them to see them fail**

Run: `cargo test -p grimoire-core --lib sync_engine::apply::emission_tests`
Expected: compiles; the first four and `a_claim_held_mid_emission…` and `a_taken_generations…` FAIL (1 row of 3; 0 for 5; `deferred: 1`; `opt` 0; `opt` 0 behind the held claim; `applied` 1); the three Review Focus tests may pass already — they pin behaviour this task must keep.

- [ ] **Step 3: Write `claims.rs`** (this task keeps every active claim; Task 5 adds the row table)

```rust
//! Claims that name their emission — the baseline claim design of 2026-10-03,
//! `docs/superpowers/specs/2026-10-03-baseline-claim-emissions-design.md` §5–§7.
//!
//! **Two calls from [`super::apply_in`] and nothing else**: [`decide`] before the page is
//! grouped — which claims and covered puts go to the fold, which are consumed as they stand —
//! and [`settle`] after the committed pass, which records what each claim did and marks an
//! emission taken once it is whole. Nothing here reads or writes `sync_peers`: a claim is a
//! statement about a row, never a place in its emitter's stream.

use super::{Class, Deferral};
use crate::sync_engine::emission::{self, Record, Stamp};
use crate::sync_engine::merge::{Horizon, Op};
use rusqlite::Connection;
use std::collections::{BTreeMap, BTreeSet};

/// An emission's name: its emitter and its `id`.
type Key = (String, Stamp);

/// One emission as a page carries it.
struct InPage {
    n: u32,
    since: Stamp,
    resumed: bool,
    horizon: Horizon,
    /// `Some` while the emission is active: the ledger's record of it, or a fresh one.
    record: Option<Record>,
}

/// What [`decide`] settled before any group is formed.
#[derive(Default)]
pub(super) struct Decided {
    /// Page indices consumed without being applied.
    pub skip: BTreeSet<usize>,
    /// Page indices that go to the fold whatever `seen` and the older horizon rules say.
    pub keep: BTreeSet<usize>,
    emissions: BTreeMap<Key, InPage>,
    /// Claims this page consumed without writing.
    passed: Vec<(Key, u32)>,
    /// Claims this page sent to the fold, with their row.
    kept: Vec<(Key, u32, String, String)>,
}

fn sql(e: rusqlite::Error) -> String {
    e.to_string()
}

/// Decide a page's claims (spec §5, §6).
///
/// A claim whose chunk head is not in the page — `n` and `since` absent on every op of its
/// emission — is left undecided, and the older rules judge it as an op with no reference.
pub(super) fn decide(
    conn: &Connection,
    ops: &[Op],
    me: Option<&str>,
    seen: &dyn Fn(&Op) -> bool,
) -> Result<Decided, String> {
    let _ = seen; // read by Task 5's covered-put arm
    let mut out = Decided::default();
    for op in ops {
        let (Some(em), Some(h)) = (&op.emission, &op.horizon) else {
            continue;
        };
        let (Some(n), Some(since)) = (em.n, em.since) else {
            continue;
        };
        out.emissions
            .entry((op.at.device.clone(), em.id))
            .or_insert(InPage {
                n,
                since,
                resumed: em.resumed,
                horizon: h.clone(),
                record: None,
            });
    }
    // Active or inert, against the marks as they stood before the page (§6).
    for ((emitter, id), page) in out.emissions.iter_mut() {
        let taken = emission::taken(conn, emitter).map_err(sql)?;
        if taken.is_none_or(|t| page.since > t) {
            let held = emission::records(conn, emitter)
                .map_err(sql)?
                .into_iter()
                .find(|r| r.id == *id);
            page.record =
                Some(held.unwrap_or_else(|| Record::new(*id, page.n, page.since, page.resumed)));
        }
    }
    for (i, op) in ops.iter().enumerate() {
        let Some(em) = &op.emission else {
            continue;
        };
        if me == Some(op.at.device.as_str()) {
            continue;
        }
        let key = (op.at.device.clone(), em.id);
        let Some(page) = out.emissions.get(&key) else {
            continue;
        };
        let Some(record) = &page.record else {
            out.skip.insert(i); // inert
            continue;
        };
        if record.consumed(em.i) {
            out.skip.insert(i);
            continue;
        }
        out.keep.insert(i);
        out.kept.push((key, em.i, op.table.clone(), op.uid.clone()));
    }
    Ok(out)
}

/// Record what the committed pass did with each claim the page sent to the fold, and mark an
/// emission taken once every index is consumed (§5).
pub(super) fn settle(
    conn: &Connection,
    d: &Decided,
    committed: &[Deferral],
    me: Option<&str>,
) -> Result<(), String> {
    let classes: BTreeMap<(&str, &str), Class> = committed
        .iter()
        .map(|x| ((x.group.table, x.group.ops[0].uid.as_str()), x.class))
        .collect();
    let mut records: BTreeMap<&Key, Record> = d
        .emissions
        .iter()
        .filter_map(|(k, p)| p.record.clone().map(|r| (k, r)))
        .collect();
    for (key, i) in &d.passed {
        if let Some(r) = records.get_mut(key) {
            r.passed.insert(*i);
        }
    }
    for (key, i, table, uid) in &d.kept {
        let Some(r) = records.get_mut(key) else {
            continue;
        };
        match classes.get(&(table.as_str(), uid.as_str())) {
            Some(class) if class.holds() => {}
            Some(_) => r.passed.insert(*i),
            None => r.wrote.insert(*i),
        }
    }
    for (key, record) in records {
        if record.complete() {
            emission::take(conn, &key.0, &record, &d.emissions[key].horizon, me).map_err(sql)?;
        } else {
            emission::keep(conn, &key.0, record).map_err(sql)?;
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Wire the seams in `apply.rs`**

(a) **Claims block nothing and are never collateral by stamp** (§5). In `held_by`, `blocks_of` and `advance_watermarks`, iterate only ops with no emission:

```rust
    for op in g.ops.iter().filter(|op| op.emission.is_none()) {
```

(the same filter on `d.group.ops` in `blocks_of`, and on `g.ops` in `advance_watermarks`).

(b) **Horizons of claims with a reference are this design's, not the older rules'.** In `apply_in`, in the loop that absorbs every op's `horizon` (and, after the narrow fix, its per-emitter map), skip them first:

```rust
    for op in ops {
        if op.emission.is_some() {
            continue;
        }
        if let Some(h) = &op.horizon {
```

(c) **Decide before grouping.** After the `mine` and `seen` closures are defined and before the loop that builds `fresh`:

```rust
    // Claims that name their emission are decided here, before any older rule sees them
    // (design 2026-10-03 §5, §6): what this marks to skip or keep is final.
    let decided = claims::decide(conn, ops, me.as_deref(), &seen)?;
```

and make the loop that builds `fresh` enumerate and consult it first, leaving the narrow fix's own arms below untouched:

```rust
    let mut fresh: Vec<&Op> = Vec::new();
    for (i, op) in ops.iter().enumerate() {
        if decided.skip.contains(&i) {
            report.skipped += 1;
            continue;
        }
        if decided.keep.contains(&i) {
            fresh.push(op);
            continue;
        }
        // ...the narrow fix's arms, exactly as merged...
    }
```

(d) **Settle after the committed pass.** Directly after `advance_watermarks(conn, &groups, &committed)?;`:

```rust
    claims::settle(conn, &decided, &committed, me.as_deref())?;
```

- [ ] **Step 5: Run the scenarios and the whole apply suite**

Run: `cargo test -p grimoire-core --lib sync_engine::apply`
Expected: every test in `emission_tests` PASSES; every test in `apply/tests.rs` still passes (its claims carry no emission and take the narrow fix's path); the two owed tests stay ignored.

- [ ] **Step 6: Commit**

```bash
cargo fmt -p grimoire-core
cargo clippy -p grimoire-core --all-targets -- -D warnings
git add crates/grimoire-core/src/sync_engine/apply.rs crates/grimoire-core/src/sync_engine/apply
git commit -m "feat(sync): a claim that names its emission is consumed once and never judged by the watermark"
```

---

### Task 5: What an active claim does to each row

**Files:**
- Modify: `crates/grimoire-core/src/sync_engine/apply/claims.rs`
- Test: `crates/grimoire-core/src/sync_engine/apply/emission_tests.rs`

**Interfaces:**
- Consumes: Task 4's `decide`/`settle`; `super::meta_of`; `emission::gap_open`, `emission::start_logging`, `emission::keep_logging_mark`.
- Produces: `decide` now implements spec §6's row table and the containment rule.

- [ ] **Step 1: Write the failing tests** — append to `emission_tests.rs`:

```rust
// ---------------------------------------------------------------------------------------------
// Task 5 — the row table (spec §6, §14 rows 5–9, 11–12, 15, 18, 22)
// ---------------------------------------------------------------------------------------------

/// Moves a device's whole op log a minute into the past, so a claim stamped from a row's
/// `updated_at` (written now) reads as later than every op a peer has applied.
fn age_ops(conn: &Connection) {
    conn.execute_batch(
        "UPDATE sync_ops SET hlc_ms = hlc_ms - 60000;
         UPDATE sync_clock SET ms = ms - 60000;
         UPDATE collection_entries SET updated_at = updated_at - 60;",
    )
    .unwrap();
}

fn real_stash(conn: &Connection, card: &str, n: i64) {
    conn.execute(
        "INSERT INTO collection_entries
            (card_id,set_code,collector_number,lang,finish,condition,quantity,
             created_at,updated_at)
         VALUES (?1,'lea','1','en','nonfoil','NM',?2,unixepoch(),unixepoch())",
        rusqlite::params![card, n],
    )
    .unwrap();
}

/// §14 row 5 — the tombstone face.
#[test]
fn a_claim_does_not_lose_the_add_wins_its_own_edit_would_win() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    b.execute("DELETE FROM collection_entries", []).unwrap();
    set_clock(&a, STAMP + 3_600_000);
    step(&a, "bolt", 1, SECOND);
    let edit = since(&a, &mut ma);
    apply(&b, &page(&[&edit, &whole(&a, "dev-a")])).unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();
    assert_eq!((copies(&a, "bolt"), copies(&b, "bolt")), (3, 3));
}

fn minus_one(take_first: bool, step_at: i64) -> (i64, i64) {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    stash(&a, "bolt", 3, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    if take_first {
        apply(&b, &whole(&a, "dev-a")).unwrap();
    }
    step(&a, "bolt", -1, step_at);
    apply(&b, &page(&[&since(&a, &mut ma), &whole(&a, "dev-a")])).unwrap();
    (copies(&a, "bolt"), copies(&b, "bolt"))
}

/// §14 row 6.
#[test]
fn a_removal_sent_with_a_rebaseline_reaches_a_device_that_holds_the_row() {
    for take_first in [false, true] {
        for step_at in [SECOND, SECOND + 5] {
            assert_eq!(minus_one(take_first, step_at), (2, 2), "taken {take_first}, at {step_at}");
        }
    }
}

fn plus_one_each_side(take_first: bool) -> (i64, i64) {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    if take_first {
        apply(&b, &whole(&a, "dev-a")).unwrap();
    }
    step(&b, "bolt", 1, SECOND);
    step(&a, "bolt", 1, SECOND + 5);
    apply(&b, &page(&[&since(&a, &mut ma), &whole(&a, "dev-a")])).unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();
    (copies(&a, "bolt"), copies(&b, "bolt"))
}

/// §14 row 7.
#[test]
fn a_copy_added_on_each_side_is_two_copies() {
    for take_first in [false, true] {
        assert_eq!(plus_one_each_side(take_first), (4, 4), "taken {take_first}");
    }
}

/// §14 row 8.
#[test]
fn a_note_written_there_after_it_heard_this_devices_wins_here_too() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    b.execute("UPDATE collection_entries SET notes = 'mine'", [])
        .unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();
    a.execute("UPDATE collection_entries SET notes = 'theirs'", [])
        .unwrap();
    apply(&b, &page(&[&since(&a, &mut ma), &whole(&a, "dev-a")])).unwrap();
    assert_eq!(
        (note(&a, "bolt"), note(&b, "bolt")),
        ("theirs".to_owned(), "theirs".to_owned())
    );
}

/// §14 row 9.
#[test]
fn an_edit_whose_claim_is_in_a_later_chunk_lands_at_once() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    step(&a, "bolt", 1, SECOND);
    let edit = since(&a, &mut ma);
    let chunks = emit(&a, "dev-a", 1);
    let folder_chunk = chunks
        .iter()
        .find(|c| c[0].table == "collection_folders")
        .unwrap()
        .clone();
    apply(&b, &page(&[&edit, &folder_chunk])).unwrap();
    assert_eq!(copies(&b, "bolt"), 3, "the edit waited for a chunk it did not need");
    apply(&b, &chunk_of(&chunks, "bolt")).unwrap();
    assert_eq!(copies(&b, "bolt"), 3);
}

fn removal_meanwhile(take_first: bool) -> (i64, i64) {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let (mut ma, mut mb) = (0, 0);
    real_stash(&a, "bolt", 3);
    age_ops(&a);
    apply(&b, &since(&a, &mut ma)).unwrap();
    if take_first {
        apply(&b, &whole(&a, "dev-a")).unwrap();
    }
    b.execute("UPDATE collection_entries SET quantity = quantity - 1", [])
        .unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();
    b.execute("UPDATE collection_entries SET quantity = quantity - 1", [])
        .unwrap();
    apply(&b, &whole(&a, "dev-a")).unwrap();
    apply(&a, &since(&b, &mut mb)).unwrap();
    (copies(&a, "bolt"), copies(&b, "bolt"))
}

fn note_meanwhile(take_first: bool) -> (String, String) {
    let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
    let (mut ma, mut mc) = (0, 0);
    real_stash(&a, "bolt", 2);
    age_ops(&a);
    let seed = since(&a, &mut ma);
    apply(&b, &seed).unwrap();
    apply(&c, &seed).unwrap();
    if take_first {
        apply(&b, &whole(&a, "dev-a")).unwrap();
    }
    c.execute("UPDATE collection_entries SET purchase_price = 1.5", [])
        .unwrap();
    let price = since(&c, &mut mc);
    apply(&a, &price).unwrap();
    apply(&b, &price).unwrap();
    let rebroadcast = whole(&a, "dev-a");
    c.execute("UPDATE collection_entries SET notes = 'c'", [])
        .unwrap();
    let note_op = since(&c, &mut mc);
    apply(&b, &note_op).unwrap();
    apply(&b, &rebroadcast).unwrap();
    apply(&a, &note_op).unwrap();
    (note(&a, "bolt"), note(&b, "bolt"))
}

fn delete_meanwhile(take_first: bool) -> (i64, i64, i64) {
    let (a, b, c) = (paired("dev-a"), paired("dev-b"), paired("dev-c"));
    let (mut ma, mut mc) = (0, 0);
    real_stash(&a, "bolt", 2);
    age_ops(&a);
    let seed = since(&a, &mut ma);
    apply(&b, &seed).unwrap();
    apply(&c, &seed).unwrap();
    if take_first {
        apply(&b, &whole(&a, "dev-a")).unwrap();
    }
    c.execute("UPDATE collection_entries SET purchase_price = 1.5", [])
        .unwrap();
    let edit = since(&c, &mut mc);
    apply(&a, &edit).unwrap();
    apply(&b, &edit).unwrap();
    c.execute("DELETE FROM collection_entries", []).unwrap();
    let del = since(&c, &mut mc);
    apply(&b, &del).unwrap();
    let rebroadcast = whole(&a, "dev-a");
    apply(&b, &rebroadcast).unwrap();
    apply(&a, &del).unwrap();
    (rows(&a, "bolt"), rows(&b, "bolt"), rows(&c, "bolt"))
}

/// §14 row 11.
#[test]
fn a_rebroadcast_takes_back_nothing_this_device_did_since() {
    for take_first in [false, true] {
        assert_eq!(removal_meanwhile(take_first), (1, 1), "taken {take_first}");
        assert_eq!(
            note_meanwhile(take_first),
            ("c".to_owned(), "c".to_owned()),
            "taken {take_first}"
        );
    }
    assert_eq!(delete_meanwhile(true), (0, 0, 0));
    assert_eq!(
        delete_meanwhile(false),
        (0, 1, 0),
        "owed (design §11): a third device's delete and an active claim resurrect the row here only"
    );
}

fn leave_edit_repair(clock_ahead: bool) -> (i64, String) {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    emission::start_logging(&a).unwrap();
    if clock_ahead {
        a.execute_batch(
            "UPDATE sync_clock
                SET ms = cast(unixepoch('subsec') * 1000 AS INTEGER) + 3600000, ctr = 0;",
        )
        .unwrap();
    }
    real_stash(&a, "bolt", 2);
    age_ops(&a);
    apply(&b, &since(&a, &mut ma)).unwrap();
    apply(&b, &whole(&a, "dev-a")).unwrap();
    a.execute("DELETE FROM sync_group", []).unwrap();
    emission::keep_logging_mark(&a).unwrap();
    a.execute(
        "UPDATE collection_entries
            SET quantity = 4, notes = 'unpaired', updated_at = unixepoch()",
        [],
    )
    .unwrap();
    assert!(since(&a, &mut ma).is_empty(), "an unpaired edit was captured");
    a.execute(
        "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
         VALUES (1, 'g', 0, x'02', 0)",
        [],
    )
    .unwrap();
    emission::start_logging(&a).unwrap();
    apply(&b, &whole(&a, "dev-a")).unwrap();
    (copies(&b, "bolt"), note(&b, "bolt"))
}

/// §14 row 12, the apply half (the identity half is Task 8).
#[test]
fn a_device_back_from_time_out_of_a_group_brings_what_it_did_there() {
    for clock_ahead in [false, true] {
        assert_eq!(
            leave_edit_repair(clock_ahead),
            (4, "unpaired".to_owned()),
            "clock ahead {clock_ahead}"
        );
    }
}

/// §14 row 15.
#[test]
fn a_whole_active_page_handed_back_writes_nothing_the_second_time() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    step(&a, "bolt", 1, SECOND);
    let first = page(&[&outbox(&a), &whole(&a, "dev-a")]);
    apply(&b, &first).unwrap();
    assert_eq!(copies(&b, "bolt"), 3);
    b.execute(
        "UPDATE collection_entries SET quantity = quantity - 1, notes = 'later'",
        [],
    )
    .unwrap();
    let again = apply(&b, &first).unwrap();
    assert_eq!(again.applied, 0, "{again:?}");
    assert_eq!((copies(&b, "bolt"), note(&b, "bolt")), (2, "later".to_owned()));
}

/// §14 row 18.
#[test]
fn a_grain_twin_and_a_put_carried_through_a_claim_end_at_the_max_everywhere() {
    let (a, b, c, e) = (paired("dev-a"), paired("dev-b"), paired("dev-c"), paired("dev-e"));
    let mut mc = 0;
    stash(&a, "bolt", 2, 1_700_000_000);
    a.execute("DELETE FROM sync_ops", []).unwrap();
    stash(&b, "bolt", 3, 1_700_000_000);
    b.execute("DELETE FROM sync_ops", []).unwrap();
    apply(&c, &whole(&a, "dev-a")).unwrap();
    step(&c, "bolt", 1, 1_700_000_100);
    let put = since(&c, &mut mc);
    apply(&a, &put).unwrap();
    apply(&e, &page(&[&put, &whole(&a, "dev-a")])).unwrap();
    assert_eq!(copies(&e, "bolt"), 3);
    apply(&b, &page(&[&put, &whole(&e, "dev-e")])).unwrap();
    assert_eq!(copies(&b, "bolt"), 3, "c's +1 was counted on top of b's own row");
}

/// §14 row 22, with emissions: §8.1 and §8.2 keep their answers.
#[test]
fn the_first_pairing_twice_and_the_never_held_undercount_keep_their_answers() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    stash(&a, "bolt", 1, 1_700_000_000);
    a.execute("UPDATE collection_entries SET quantity = 5", []).unwrap();
    let first = page(&[&outbox(&a), &whole(&a, "dev-a")]);
    apply(&b, &first).unwrap();
    apply(&b, &first).unwrap();
    assert_eq!(copies(&b, "bolt"), 5, "§8.1");

    let (a, b) = (paired("dev-a"), paired("dev-b"));
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    let claims = whole(&a, "dev-a");
    step(&a, "bolt", 1, SECOND);
    let ops = outbox(&a);
    apply(&b, &page(&[&ops[..1], &claims, &ops[1..]])).unwrap();
    assert_eq!(copies(&b, "bolt"), 2, "§8.2's accepted under-count");
}

/// Review Focus 3.
#[test]
fn an_emission_from_before_a_rejoin_is_inert_beside_one_from_after_it() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    emission::start_logging(&a).unwrap();
    real_stash(&a, "bolt", 2);
    age_ops(&a);
    apply(&b, &since(&a, &mut ma)).unwrap();
    let old = whole(&a, "dev-a");
    apply(&b, &old).unwrap();
    let first = emission::taken(&b, "dev-a").unwrap();
    a.execute("DELETE FROM sync_group", []).unwrap();
    emission::keep_logging_mark(&a).unwrap();
    a.execute("UPDATE collection_entries SET quantity = 4, updated_at = unixepoch()", [])
        .unwrap();
    a.execute(
        "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
         VALUES (1, 'g', 0, x'02', 0)",
        [],
    )
    .unwrap();
    emission::start_logging(&a).unwrap();
    apply(&b, &page(&[&old, &whole(&a, "dev-a")])).unwrap();
    assert_eq!(copies(&b, "bolt"), 4);
    assert!(emission::taken(&b, "dev-a").unwrap() > first);
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cargo test -p grimoire-core --lib sync_engine::apply::emission_tests`
Expected: the new tests FAIL — e.g. the tombstone face `(3, 0)`, the `-1` `(2, 3)`, `+1` each side `(4, 3)`, the note `"mine"`, the later-chunk edit `2`, the removal `(1, 2)`, the grain twin `4`; Task 4's tests still pass.

- [ ] **Step 3: Implement the row table** — in `claims.rs`, add the imports `use super::meta_of;` and `use crate::sync_engine::merge::Kind;`, remove the `let _ = seen;` line, add a `gap` read after the active/inert loop:

```rust
    let gap = emission::gap_open(conn).map_err(sql)?;
```

replace the claims loop's last two lines (`out.keep.insert(i); out.kept.push(…);`) with the held-row arm:

```rust
        // §6: on a row held here under its uid the log brings everything, so the claim writes
        // nothing — unless the emission resumed or this device has a gap, when it is the floor.
        if row_here(conn, &op.table, &op.uid)? && !(page.resumed || gap) {
            out.skip.insert(i);
            out.passed.push((key, em.i));
        } else {
            out.keep.insert(i);
            out.kept.push((key, em.i, op.table.clone(), op.uid.clone()));
        }
```

append the covered-put arm before `Ok(out)`:

```rust
    // §6: a put an active emission's horizon covers, by its row.
    for (i, op) in ops.iter().enumerate() {
        if op.kind != Kind::Put || op.baseline || me == Some(op.at.device.as_str()) || seen(op) {
            continue;
        }
        let covering: Vec<&Key> = out
            .emissions
            .iter()
            .filter(|(_, p)| p.record.is_some() && p.horizon.covers(&op.at))
            .map(|(k, _)| k)
            .collect();
        if covering.is_empty() {
            continue;
        }
        // Containment: the page's claim for this row, from an emission that covers the put, has
        // already written the row — a page handed back after the claim built, merged or floored.
        let written = ops.iter().any(|c| {
            c.table == op.table
                && c.uid == op.uid
                && c.emission.as_ref().is_some_and(|em| {
                    let key: Key = (c.at.device.clone(), em.id);
                    covering.contains(&&key)
                        && out
                            .emissions
                            .get(&key)
                            .and_then(|p| p.record.as_ref())
                            .is_some_and(|r| r.wrote.contains(em.i))
                })
        });
        if written {
            out.skip.insert(i);
        } else if row_here(conn, &op.table, &op.uid)? || named_here(conn, &op.table, &op.uid)? {
            out.keep.insert(i); // the op path: held here, or the tombstone face
        } else {
            out.skip.insert(i); // the claim carries it: never held, or a grain twin's row
        }
    }
```

and the two reads at the end of the file:

```rust
/// Whether this device holds the row under exactly this uid.
fn row_here(conn: &Connection, table: &str, uid: &str) -> Result<bool, String> {
    let Some(meta) = meta_of(table) else {
        return Ok(false);
    };
    conn.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM {} WHERE sync_uid = ?1)",
            meta.table
        ),
        [uid],
        |r| r.get(0),
    )
    .map_err(sql)
}

/// Whether this device's own op log names the row — it held it, and perhaps deleted it.
fn named_here(conn: &Connection, table: &str, uid: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sync_ops WHERE tbl = ?1 AND uid = ?2)",
        [table, uid],
        |r| r.get(0),
    )
    .map_err(sql)
}
```

- [ ] **Step 4: Run the scenarios and the apply suite**

Run: `cargo test -p grimoire-core --lib sync_engine::apply`
Expected: PASS — every `emission_tests` test, and every `apply/tests.rs` test unchanged.

- [ ] **Step 5: Commit**

```bash
cargo fmt -p grimoire-core
cargo clippy -p grimoire-core --all-targets -- -D warnings
git add crates/grimoire-core/src/sync_engine/apply
git commit -m "feat(sync): an active claim writes nothing on a row held here, and a covered put takes the op path there"
```

---

### Task 6: Held-back ops hold their row's claim, and a gap opens the floor

**Files:**
- Modify: `crates/grimoire-core/src/sync_engine/apply.rs`
- Modify: `crates/grimoire-core/src/sync_engine/apply/claims.rs`
- Test: `crates/grimoire-core/src/sync_engine/apply/emission_tests.rs`

**Interfaces:**
- Consumes: Tasks 4–5; `emission::{open_gap, close_gap_if_whole}`.
- Produces: `pub fn apply::apply_page(conn: &Connection, ops: &[Op], held_back: &[Op], waiting: Waiting) -> Result<(ApplyReport, Held), String>` — `apply_held` becomes `apply_page(conn, ops, &[], waiting)`. `Class::HeldBack`.

- [ ] **Step 1: Write the failing tests** — append to `emission_tests.rs`:

```rust
// ---------------------------------------------------------------------------------------------
// Task 6 — held-back ops and the gap (spec §5, §7, §14 rows 10, 13)
// ---------------------------------------------------------------------------------------------

/// §14 row 10 — the third review's 6-for-3. c's +1 reaches b only later (its client holds c
/// back); e took it in through a's claim, never as an op, and e's claim for the row comes first.
#[test]
fn a_held_back_put_and_a_claim_that_contains_it_count_it_once() {
    for resumed in [false, true] {
        let (a, b, c, e) = (paired("dev-a"), paired("dev-b"), paired("dev-c"), paired("dev-e"));
        let (mut ma, mut mc) = (0, 0);
        set_clock(&a, STAMP);
        stash(&a, "bolt", 2, SECOND);
        let seed = since(&a, &mut ma);
        apply(&b, &seed).unwrap();
        apply(&c, &seed).unwrap();
        step(&c, "bolt", 1, SECOND + 1);
        let put = since(&c, &mut mc);
        apply(&a, &put).unwrap();
        apply(&e, &page(&[&seed, &put, &whole(&a, "dev-a")])).unwrap();
        assert_eq!(copies(&e, "bolt"), 3);
        if resumed {
            emission::start_logging(&e).unwrap();
            emission::start_logging(&e).unwrap();
        }
        let from_e = whole(&e, "dev-e");
        apply_page(&b, &from_e, &put, Waiting::Hold).unwrap();
        apply_page(&b, &page(&[&put, &from_e]), &[], Waiting::Hold).unwrap();
        assert_eq!(copies(&b, "bolt"), 3, "resumed {resumed}");
    }
}

/// §14 row 13, the apply half: a group dropped and recorded opens the gap; the next emission
/// floors a row held here; the gap closes when the roster is taken again.
#[test]
fn a_dropped_group_opens_the_gap_and_the_next_emission_floors() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    set_clock(&a, STAMP);
    stash(&a, "bolt", 2, SECOND);
    apply(&b, &since(&a, &mut ma)).unwrap();
    b.execute(
        "INSERT INTO sync_devices (device_id, public_key, name, added_at)
         VALUES ('dev-a', x'00', 'dev-a', 0)",
        [],
    )
    .unwrap();
    apply(&b, &whole(&a, "dev-a")).unwrap();
    assert!(emission::taken(&b, "dev-a").unwrap().is_some());

    stash(&a, "x", 1, SECOND);
    let mut future = since(&a, &mut ma);
    future[0].table = "future_table".to_owned();
    let report = apply(&b, &future).unwrap();
    assert_eq!(report.dropped, 1, "{report:?}");
    assert!(emission::gap_open(&b).unwrap());
    assert_eq!(emission::taken(&b, "dev-a").unwrap(), None);

    b.execute("UPDATE collection_entries SET quantity = 1 WHERE card_id = 'bolt'", [])
        .unwrap();
    apply(&b, &whole(&a, "dev-a")).unwrap();
    assert_eq!(copies(&b, "bolt"), 2, "a gap opens the floor (design §6, §11)");
    assert!(!emission::gap_open(&b).unwrap(), "the roster was taken again");
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cargo test -p grimoire-core --lib sync_engine::apply::emission_tests::a_held_back sync_engine::apply::emission_tests::a_dropped`
Expected: compile error — `apply_page` does not exist; after Step 3 (a) alone, the 6-for-3 reads 4 and the gap is never opened.

- [ ] **Step 3: Implement**

(a) **`apply_page` and `Class::HeldBack`** in `apply.rs`. Add the variant and keep `holds()` true for it:

```rust
    /// Held because the client held its sender back — for its clock, or behind a batch only a
    /// newer build can read — and passed it in so the claim containing it waits too (design
    /// 2026-10-03 §5). The client counts these itself, so no class of the report does.
    HeldBack,
```

```rust
    fn holds(self) -> bool {
        matches!(self, Class::Newer | Class::Waiting | Class::HeldBack)
    }
```

Rename the body of `apply_held` into a new entry point and delegate:

```rust
/// [`apply_held`], with the ops the client held back — a sender held for its clock, or behind a
/// batch only a newer build can read. They are never applied: they hold their rows' groups, so a
/// claim that contains such an op can never land ahead of it (design 2026-10-03 §5).
pub fn apply_page(
    conn: &Connection,
    ops: &[Op],
    held_back: &[Op],
    waiting: Waiting,
) -> Result<(ApplyReport, Held), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let out = capture::suppressed(&tx, || apply_in(&tx, ops, held_back, waiting))?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn apply_held(
    conn: &Connection,
    ops: &[Op],
    waiting: Waiting,
) -> Result<(ApplyReport, Held), String> {
    apply_page(conn, ops, &[], waiting)
}
```

Give `apply_in` the parameter `held_back: &[Op]` after `ops`. Where the report counts committed deferrals, add the arm `Class::HeldBack => {}`.

(b) **Held-back ops in `apply_in`.** Replace the line that groups `fresh` and the initial `blocked`:

```rust
    // The client's held-back ops join the groups they belong to, never applied: each sender is
    // blocked at its earliest op this device has not applied, so every group naming one holds.
    let held: Vec<&Op> = held_back
        .iter()
        .filter(|op| op.emission.is_none() && !mine(op) && !seen(op))
        .collect();
    let mut grouped: Vec<&Op> = fresh.clone();
    grouped.extend(held.iter().copied());
    let mut groups = group(&grouped);
```

```rust
    let mut blocked: Blocks = BTreeMap::new();
    for op in &held {
        match blocked.get(op.at.device.as_str()) {
            Some((at, _)) if *at <= op.at => {}
            _ => {
                blocked.insert(op.at.device.clone(), (op.at.clone(), Class::HeldBack));
            }
        }
    }
```

`observe` keeps reading `fresh` (never a held-back op: a clock-held stamp must not drag this clock).

(c) **The gap in `claims::settle`** — after the records loop, before `Ok(())`:

```rust
    // §7: a group dropped and recorded is an op the watermark passed and this device never
    // applied. Opened after the taken marks above, so a pass that drops a claim leaves its
    // emitter untaken even when the drop was that emission's last index.
    if committed.iter().any(|x| x.class == Class::Dropped) {
        emission::open_gap(conn).map_err(sql)?;
    } else {
        emission::close_gap_if_whole(conn).map_err(sql)?;
    }
```

- [ ] **Step 4: Run the whole engine's tests**

Run: `cargo test -p grimoire-core --lib sync_engine::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cargo fmt -p grimoire-core
cargo clippy -p grimoire-core --all-targets -- -D warnings
git add crates/grimoire-core/src/sync_engine/apply.rs crates/grimoire-core/src/sync_engine/apply
git commit -m "feat(sync): a held-back op holds the claim that contains it, and a dropped group opens the gap"
```

---

### Task 7: `update_row` stops stamping a row nothing changed

**Files:**
- Modify: `crates/grimoire-core/src/sync_engine/apply.rs` (`update_row`)
- Test: `crates/grimoire-core/src/sync_engine/apply/emission_tests.rs`

**Interfaces:**
- Consumes: nothing new. Produces: `update_row` writes `updated_at` only when a column is written or a counter changes (spec §9).

- [ ] **Step 1: Write the failing tests** — append to `emission_tests.rs`:

```rust
// ---------------------------------------------------------------------------------------------
// Task 7 — a row nothing changed keeps its modification time (spec §9, §14 row 21)
// ---------------------------------------------------------------------------------------------

fn updated_at(conn: &Connection, card: &str) -> i64 {
    conn.query_row(
        "SELECT updated_at FROM collection_entries WHERE card_id = ?1",
        [card],
        |r| r.get(0),
    )
    .unwrap()
}

/// An op whose only field loses to a later edit made here changes nothing.
#[test]
fn an_op_whose_every_field_lost_leaves_updated_at_alone() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    stash(&a, "bolt", 2, 1_700_000_000);
    apply(&b, &since(&a, &mut ma)).unwrap();
    a.execute("UPDATE collection_entries SET notes = 'old'", []).unwrap();
    let older = since(&a, &mut ma);
    set_clock(&b, STAMP);
    b.execute("UPDATE collection_entries SET notes = 'newer'", []).unwrap();
    b.execute("UPDATE collection_entries SET updated_at = 1600000000", []).unwrap();
    apply(&b, &older).unwrap();
    assert_eq!((note(&b, "bolt"), updated_at(&b, "bolt")), ("newer".to_owned(), 1_600_000_000));
}

/// A floor equal to what is here changes nothing either.
#[test]
fn a_claim_that_changes_nothing_leaves_updated_at_alone() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    stash(&a, "bolt", 2, 1_700_000_000);
    apply(&b, &since(&a, &mut ma)).unwrap();
    b.execute("UPDATE collection_entries SET updated_at = 1600000000", []).unwrap();
    emission::start_logging(&a).unwrap();
    emission::start_logging(&a).unwrap(); // resumed: the claim floors this held row
    apply(&b, &whole(&a, "dev-a")).unwrap();
    assert_eq!((copies(&b, "bolt"), updated_at(&b, "bolt")), (2, 1_600_000_000));
}

/// ...and a deck keeps its place in the gallery, which sorts by `decks.updated_at`.
#[test]
fn a_deck_a_claim_changed_nothing_on_keeps_its_place_in_the_gallery() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    let mut ma = 0;
    a.execute(
        "INSERT INTO decks (name, created_at, updated_at) VALUES ('Krenko', 1700000000, 1700000000)",
        [],
    )
    .unwrap();
    apply(&b, &since(&a, &mut ma)).unwrap();
    b.execute("UPDATE decks SET updated_at = 1600000000", []).unwrap();
    emission::start_logging(&a).unwrap();
    emission::start_logging(&a).unwrap();
    apply(&b, &whole(&a, "dev-a")).unwrap();
    let at: i64 = b
        .query_row("SELECT updated_at FROM decks WHERE name = 'Krenko'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(at, 1_600_000_000);
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cargo test -p grimoire-core --lib sync_engine::apply::emission_tests::an_op_whose_every sync_engine::apply::emission_tests::a_claim_that_changes sync_engine::apply::emission_tests::a_deck_a_claim`
Expected: FAIL — `updated_at` is now's `unixepoch()`, not `1600000000`.

- [ ] **Step 3: Rewrite `update_row`** — counters first, one `UPDATE` only if something changed:

```rust
fn update_row(
    conn: &Connection,
    meta: &Meta,
    spec: &Spec,
    g: &Group,
    combined: &Resolved,
    parents: &BTreeMap<&'static str, Sql>,
    uid: &str,
) -> Result<String, String> {
    // **A column that already holds the value is not written.** `updates` answers every field
    // the incoming ops *won*, and a claim — a whole row — wins every field this device never
    // edited, so without this a claim equal to the row would still write it and stamp it now.
    let pairs = updates(spec, g, combined, parents);
    let pairs: Vec<(String, Sql)> = if pairs.is_empty() {
        pairs
    } else {
        let cols: Vec<&str> = pairs.iter().map(|(c, _)| c.as_str()).collect();
        let current: Vec<Sql> = conn
            .query_row(
                &format!(
                    "SELECT {} FROM {} WHERE sync_uid = ?1",
                    cols.join(", "),
                    meta.table
                ),
                [uid],
                |r| (0..cols.len()).map(|i| r.get::<_, Sql>(i)).collect(),
            )
            .map_err(|e| e.to_string())?;
        pairs
            .into_iter()
            .zip(current)
            .filter(|((_, new), old)| new != old)
            .map(|(pair, _)| pair)
            .collect()
    };

    // §8.2 per counter: deltas apply to what this device holds, and a claim can only raise that
    // floor. A counter that ends where it stands is no change (design 2026-10-03 §9).
    let mut counter_sets: Vec<(&str, i64)> = Vec::new();
    for (name, floor) in meta.counters {
        let delta = g.resolved.counters.get(*name).copied().unwrap_or(0);
        let claim = g.resolved.claims.get(*name).copied();
        if delta == 0 && claim.is_none() {
            continue;
        }
        let current: i64 = conn
            .query_row(
                &format!("SELECT {name} FROM {} WHERE sync_uid = ?1", meta.table),
                [uid],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        // **A claim above zero is also a floor the row cannot fall through** — §8's named
        // consequence: a concurrent "remove the last copy" loses to it.
        let next = match claim {
            Some(c) => (current + delta).max(c),
            None => current + delta,
        };
        let value = match floor {
            Floor::DeleteAtZero if next <= 0 => {
                conn.execute(
                    &format!("DELETE FROM {} WHERE sync_uid = ?1", meta.table),
                    [uid],
                )
                .map_err(|e| e.to_string())?;
                return Ok(uid.to_owned());
            }
            Floor::Clamp => next.max(0),
            Floor::DeleteAtZero => next,
        };
        if value != current {
            counter_sets.push((name, value));
        }
    }

    // **Nothing changed, nothing written** — not even `updated_at`. A row stamped now by an
    // apply that changed nothing is claimed at now by this device's next baseline, beating
    // genuinely newer edits made between (the baseline design §10.2), and jumps to the top of the
    // deck gallery, which sorts by it.
    if pairs.is_empty() && counter_sets.is_empty() {
        return Ok(uid.to_owned());
    }
    let mut sets: Vec<String> = Vec::new();
    let mut vals: Vec<Sql> = Vec::new();
    for (c, v) in pairs {
        vals.push(v);
        sets.push(format!("{c} = ?{}", vals.len()));
    }
    for (name, value) in counter_sets {
        vals.push(Sql::Integer(value));
        sets.push(format!("{name} = ?{}", vals.len()));
    }
    if meta.timestamps {
        sets.push("updated_at = unixepoch()".to_owned());
    }
    vals.push(Sql::Text(uid.to_owned()));
    conn.execute(
        &format!(
            "UPDATE {} SET {} WHERE sync_uid = ?{}",
            meta.table,
            sets.join(", "),
            vals.len()
        ),
        rusqlite::params_from_iter(vals.iter()),
    )
    .map_err(|e| e.to_string())?;
    Ok(uid.to_owned())
}
```

Keep the doc comments the old `update_row` carried on the counter arm (the §8.2 floor, `Floor::DeleteAtZero`) where they still describe this code.

- [ ] **Step 4: Run every engine test**

Run: `cargo test -p grimoire-core --lib sync_engine::`
Expected: PASS — `apply/tests.rs`' counter, clamp and delete-at-zero tests included.

- [ ] **Step 5: Commit**

```bash
cargo fmt -p grimoire-core
git add crates/grimoire-core/src/sync_engine/apply.rs crates/grimoire-core/src/sync_engine/apply/emission_tests.rs
git commit -m "fix(sync): an apply that changes nothing leaves a row's updated_at alone"
```

---

### Task 8: The generation is minted where capture turns on (after 6b)

**Files:**
- Modify: the moved `identity.rs` — `git ls-files | grep 'sync_pair/identity.rs'` (before 6b: `src-tauri/src/sync_pair/identity.rs`)
- Test: that file's `mod tests`

**Interfaces:**
- Consumes: `emission::{start_logging, keep_logging_mark, open_gap, begin, gap_open, taken}` (Task 2), reached as `crate::sync_engine::emission`.
- Produces: `found_group` and `join_group` (from no group) mint a generation; `leave_group` keeps it; `forget_log_position` opens the gap.

- [ ] **Step 1: Confirm 6b has landed**

Run: `git fetch origin && git merge origin/main && git ls-files | grep -E 'sync_pair/identity.rs|sync_engine/client.rs'`
Expected: the paths 6b moved them to. If both are still under `src-tauri/src/`, check #761: if 6b is not merged, stop here and leave Tasks 8–9 for after it.

- [ ] **Step 2: Write the failing tests** — append to `identity.rs`'s `mod tests` (its `db()` and `ensure` fixtures):

```rust
    fn logging_since(conn: &Connection) -> Option<String> {
        conn.query_row(
            "SELECT value FROM sync_state WHERE key = 'logging_since'",
            [],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
    }

    /// The baseline claim design §4: a generation is minted when capture turns on, and only then.
    #[test]
    fn founding_and_joining_from_no_group_mint_a_generation() {
        use crate::sync_engine::emission;
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        let first = logging_since(&conn).expect("founding mints one");
        assert!(!emission::begin(&conn).unwrap().resumed);

        let g = group(&conn).unwrap().unwrap();
        join_group(&conn, &g.group_id, g.epoch, &g.group_key, &me).unwrap();
        assert_eq!(logging_since(&conn), Some(first.clone()), "the initiator's re-write mints none");

        leave_group(&conn).unwrap();
        assert_eq!(logging_since(&conn), Some(first.clone()), "leaving keeps it");
        join_group(&conn, "abc123", 0, &[1u8; 32], &me).unwrap();
        assert_ne!(logging_since(&conn), Some(first));
        assert!(emission::begin(&conn).unwrap().resumed);
    }

    #[test]
    fn a_device_that_logged_before_this_build_resumes_when_it_comes_back() {
        use crate::sync_engine::emission;
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        conn.execute(
            "DELETE FROM sync_state WHERE key IN ('logging_since', 'logging_resumed')",
            [],
        )
        .unwrap();
        leave_group(&conn).unwrap();
        join_group(&conn, "abc123", 0, &[1u8; 32], &me).unwrap();
        assert!(emission::begin(&conn).unwrap().resumed);
    }

    /// §7: forgetting this device's place in a log is a gap.
    #[test]
    fn forgetting_a_place_in_a_log_opens_the_gap() {
        use crate::sync_engine::emission;
        let conn = db();
        let me = ensure(&conn).unwrap();
        create_group(&conn, &me).unwrap();
        conn.execute_batch(
            "DELETE FROM sync_state WHERE key = 'gap';
             INSERT INTO sync_state (key, value) VALUES ('taken@dev-x', '1:0');",
        )
        .unwrap();
        leave_group(&conn).unwrap();
        assert!(emission::gap_open(&conn).unwrap());
        assert_eq!(emission::taken(&conn, "dev-x").unwrap(), None);
    }
```

(Import `rusqlite::OptionalExtension` in the test module if it is not already in scope.)

- [ ] **Step 3: Run them to see them fail**

Run: `cargo test --workspace sync_pair::identity::tests::`
Expected: the three new tests FAIL — `logging_since` is `None`; the gap stays closed.

- [ ] **Step 4: Implement** — in `identity.rs`:

`found_group`, after `write_group(conn, g)?;`:

```rust
    // Capture turns on here: a new generation (the baseline claim design §4).
    crate::sync_engine::emission::start_logging(conn)?;
```

`join_group`, at the top, before `held` is consumed: `let from_no_group = held.is_none();` then after `write_group(…)?;`:

```rust
    // Capture turns on only when this device was in no group: `pairing::confirm` re-writes the
    // initiator's own group on every pairing, and minting there would make every pairing look
    // like a device with unlogged history (the baseline claim design §4).
    if from_no_group {
        crate::sync_engine::emission::start_logging(conn)?;
    }
```

`leave_group`, beside `forget_log_position(&tx)`:

```rust
    crate::sync_engine::emission::keep_logging_mark(&tx).map_err(|e| e.to_string())?;
```

`forget_log_position`, after its `DELETE`:

```rust
    // A place in a log forgotten is a gap: the next emission from every emitter is read whole
    // (the baseline claim design §7).
    crate::sync_engine::emission::open_gap(conn)?;
```

Add a sentence to `forget_log_position`'s doc naming the gap.

- [ ] **Step 5: Run identity's and the engine's tests**

Run: `cargo test --workspace sync_pair::identity sync_engine::`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cargo fmt -p grimoire-core && cargo fmt -p mtg-grimoire
git add -A
git commit -m "feat(sync): a device mints a generation when capture turns on, and forgetting a log opens the gap"
```

---

### Task 9: The client — emission head, nothing pending, held-back batches, the unreadable gap (after 6b)

**Files:**
- Modify: the moved `client.rs` (`emit_baselines`, `pull`, `round_trip`) and `client/tests.rs`
- Modify: the moved `wire.rs` (`mod tests`)

**Interfaces:**
- Consumes: `emission::{begin, open_gap, Begun}`, `baseline::{number, head}`, `apply::apply_page`, `merge::Emission`.
- Produces: emissions on the wire as spec §3 says; `emit_baselines` no longer takes `through`.

- [ ] **Step 1: Write the failing tests** — append to `client/tests.rs` (its `paired`, `add_copy`, `grant`, `keys_mock`, `roster`, `baselined_at`, `Sent`, `tap`, `pushed_baselines`, `outbox` fixtures):

```rust
/// An emission as `emit_baselines` builds it — for the tests that put one on the relay.
fn emission_of(conn: &Connection, device: &str) -> Vec<Op> {
    use crate::sync_engine::{baseline, emission};
    let begun = emission::begin(conn).unwrap();
    let mut ops = baseline::build(conn, device).unwrap();
    baseline::number(&mut ops, &begun);
    let n = ops.len();
    ops[0].horizon = Some(baseline::horizon(conn, device).unwrap());
    baseline::head(&mut ops[0], n, &begun);
    ops
}

/// Design 2026-10-03 §5: no baseline is begun while anything is pending — here an op an earlier
/// refusal (`epoch_ahead`) left behind.
#[tokio::test]
async fn a_baseline_waits_while_an_earlier_refusal_left_an_op_pending() {
    let server = MockServer::start_async().await;
    keys_mock(&server, 0);
    let sent = Sent::default();
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/push")).is_true(tap(&sent));
        then.status(409).json_body(serde_json::json!({ "code": EPOCH_AHEAD }));
    });
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200).json_body(serde_json::json!({ "envelopes": [], "cursor": 1 }));
    });
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/ack"));
        then.status(204);
    });
    let a = paired("dev-a", 0);
    add_copy(&a, "c1", 1);
    roster(&a, "dev-b");
    set_state(&a, RELAY_URL, &server.base_url()).unwrap();
    grant(&a);
    let outcome = run_once(&a).await.unwrap().unwrap();
    assert_eq!(outcome.baseline_ops, 0, "{outcome:?}");
    let group = identity::group(&a).unwrap().unwrap();
    assert!(pushed_baselines(&sent, &group).is_empty(), "a baseline was begun beside a pending op");
    assert_eq!(baselined_at(&a, "dev-b"), None);
}

/// §3: every baseline op names one emission and its index; every chunk's first op carries the
/// head; the count is what was sent.
#[tokio::test]
async fn every_baseline_op_names_its_emission_and_every_chunk_its_head() {
    let server = MockServer::start_async().await;
    keys_mock(&server, 0);
    let sent = Sent::default();
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/push")).is_true(tap(&sent));
        then.status(200).json_body(serde_json::json!({ "cursor": 1 }));
    });
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200).json_body(serde_json::json!({ "envelopes": [], "cursor": 1 }));
    });
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/ack"));
        then.status(204);
    });
    let a = paired("dev-a", 0);
    for i in 0..wire::BATCH {
        add_copy(&a, &format!("c{i}"), 1);
    }
    // One row too large ever to send takes no index.
    add_copy(&a, "huge", 1);
    a.execute(
        "UPDATE collection_entries SET notes = ?1 WHERE card_id = 'huge'",
        ["x".repeat(wire::MAX_SEALED_CHARS)],
    )
    .unwrap();
    roster(&a, "dev-b");
    set_state(&a, RELAY_URL, &server.base_url()).unwrap();
    grant(&a);
    run_once(&a).await.unwrap().unwrap();

    let group = identity::group(&a).unwrap().unwrap();
    let batches = pushed_baselines(&sent, &group);
    let all: Vec<&Op> = batches.iter().flatten().collect();
    let n = all.len() as u32;
    assert!(all.iter().all(|op| op.fields.get("card_id").and_then(|v| v.as_str()) != Some("huge")));
    let ids: std::collections::BTreeSet<_> =
        all.iter().map(|op| op.emission.as_ref().unwrap().id).collect();
    assert_eq!(ids.len(), 1, "one emission");
    let mut indices: Vec<u32> = all.iter().map(|op| op.emission.as_ref().unwrap().i).collect();
    indices.sort_unstable();
    assert_eq!(indices, (0..n).collect::<Vec<_>>());
    for batch in &batches {
        let head = batch[0].emission.as_ref().unwrap();
        assert_eq!(head.n, Some(n));
        assert!(head.since.is_some());
        assert!(batch[1..].iter().all(|op| op.emission.as_ref().unwrap().n.is_none()));
    }
}

/// §5: a sender held for its clock is passed to `apply` as held, so another sender's claim for
/// the same row waits with it rather than landing ahead of it.
#[tokio::test]
async fn a_clock_held_senders_put_holds_the_claim_for_its_row() {
    let c = paired("dev-c", 0);
    add_copy(&c, "bolt", 2);
    c.execute("UPDATE sync_ops SET hlc_ms = hlc_ms + 2 * 86400000", []).unwrap();
    let from_c = outbox(&c);
    let e = paired("dev-e", 0);
    crate::sync_engine::apply::apply(&e, &from_c).unwrap();
    let from_e = emission_of(&e, "dev-e");

    let b = paired("dev-b", 0);
    let group = identity::group(&b).unwrap().unwrap();
    let envelopes = [
        wire::seal_batch(&group, "dev-c", &from_c).unwrap(),
        wire::seal_batch(&group, "dev-e", &from_e).unwrap(),
    ];
    let server = MockServer::start_async().await;
    keys_mock(&server, 0);
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/push"));
        then.status(200).json_body(serde_json::json!({ "cursor": 1 }));
    });
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200).json_body(serde_json::json!({
            "envelopes": envelopes.iter().map(|e| serde_json::to_value(e).unwrap()).collect::<Vec<_>>(),
            "cursor": 3,
        }));
    });
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/ack"));
        then.status(204);
    });
    set_state(&b, RELAY_URL, &server.base_url()).unwrap();
    grant(&b);
    run_once(&b).await.unwrap().unwrap();
    let held: i64 = b
        .query_row("SELECT count(*) FROM collection_entries WHERE card_id = 'bolt'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(held, 0, "the claim landed ahead of the put it contains");
}

/// §7: an envelope stepped over as unreadable opens the gap.
#[tokio::test]
async fn an_envelope_stepped_over_as_unreadable_opens_the_gap() {
    let other = paired("dev-x", 0);
    add_copy(&other, "c1", 1);
    let b = paired("dev-b", 0);
    let mut group = identity::group(&b).unwrap().unwrap();
    group.group_key = [9u8; 32];
    let altered = wire::seal_batch(&group, "dev-x", &outbox(&other)).unwrap();
    let server = MockServer::start_async().await;
    keys_mock(&server, 0);
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/push"));
        then.status(200).json_body(serde_json::json!({ "cursor": 1 }));
    });
    server.mock(|when, then| {
        when.method(GET).path(format!("/g/{GROUP}/pull"));
        then.status(200).json_body(serde_json::json!({
            "envelopes": [serde_json::to_value(&altered).unwrap()],
            "cursor": 2,
        }));
    });
    server.mock(|when, then| {
        when.method(POST).path(format!("/g/{GROUP}/ack"));
        then.status(204);
    });
    b.execute("DELETE FROM sync_state WHERE key = 'gap'", []).unwrap();
    set_state(&b, RELAY_URL, &server.base_url()).unwrap();
    grant(&b);
    run_once(&b).await.unwrap().unwrap();
    assert!(crate::sync_engine::emission::gap_open(&b).unwrap());
}
```

and to `wire.rs`'s `mod tests`, beside `a_full_batch_is_far_below_the_two_megabyte_row_cap`:

```rust
    /// The baseline claim design §3, §14 row 23: a full batch of claims with their emission
    /// references, measured.
    #[test]
    fn a_full_batch_of_claims_with_references_is_far_below_the_cap() {
        let g = group(0);
        let mut batch = ops(BATCH);
        for (i, op) in batch.iter_mut().enumerate() {
            op.baseline = true;
            op.emission = Some(crate::sync_engine::merge::Emission {
                id: (1_759_000_000_000, 4),
                i: i as u32,
                n: (i == 0).then_some(BATCH as u32),
                since: (i == 0).then_some((1_758_000_000_000, 0)),
                resumed: false,
            });
        }
        let envelope = seal_batch(&g, "0123456789abcdef", &batch).unwrap();
        let row = serde_json::to_vec(&envelope).unwrap().len();
        eprintln!("{BATCH} claims with references: {row} B as a stored row");
        assert!(row < 2 * 1024 * 1024);
        assert!(!oversized(&batch));
        assert_eq!(batches(&batch).len(), 1);
    }
```

- [ ] **Step 2: Run them to see them fail**

Run: `cargo test --workspace sync_engine::client::tests::a_baseline_waits sync_engine::client::tests::every_baseline_op_names sync_engine::client::tests::a_clock_held sync_engine::client::tests::an_envelope_stepped sync_engine::wire::tests::a_full_batch_of_claims -- --nocapture`
Expected: the four client tests FAIL (a baseline pushed; no `emission`; `bolt` built; the gap closed); the wire test PASSES and prints the row size — record it for Task 10.

- [ ] **Step 3: Implement**

(a) **`emit_baselines` begins only with nothing pending**, and mints the emission in the stretch that reads the rows. Replace the pending query and the read:

```rust
        let read = db.with(|conn| {
            // **Nothing pending at all** (design 2026-10-03 §5), not only what was written since
            // this trip read its outbox: a pending op is inside these rows and their horizon but
            // not on the relay's log, so it would arrive behind the claims with no horizon beside
            // it, onto a row a claim has just built.
            let pending: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sync_ops WHERE pushed_at IS NULL)",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if pending {
                return Ok(None);
            }
            Ok(Some((
                baseline::build(conn, &device)?,
                wall_ms(conn)?,
                baseline::horizon(conn, &device)?,
                emission::begin(conn).map_err(|e| e.to_string())?,
            )))
        })?;
        let Some((ops, wall, horizon, begun)) = read else {
            break;
        };
```

Remove the `through` parameter from `emit_baselines` and from its call in `round_trip`; rewrite the function's ⚠️ doc paragraph to say no baseline begins while anything is pending, and why (design §5).

(b) **Leave out the unsendable rows before numbering.** After the `too_far_ahead` check, replace everything up to the chunk loop with:

```rust
        // **A row too large ever to send is left out before the ops are numbered** (design §3),
        // asked of it as a chunk of one with the horizon and the head it would carry, so `n`
        // counts what is sent and an index that never arrives cannot keep the emission untaken.
        let mut sendable: Vec<Op> = Vec::with_capacity(ops.len());
        for op in ops {
            let mut probe = op.clone();
            probe.horizon = Some(horizon.clone());
            probe.emission = Some(Emission {
                id: begun.id,
                i: u32::MAX,
                n: Some(u32::MAX),
                since: Some(begun.since),
                resumed: begun.resumed,
            });
            if wire::oversized(std::slice::from_ref(&probe)) {
                say(db, "push", Kind::Other, &unsendable(&op, "a device's first sync"), Some(&op.uid));
            } else {
                sendable.push(op);
            }
        }
        let mut ops = sendable;
        if ops.is_empty() {
            db.with(|conn| baseline::mark_sent(conn, &peer))?;
            continue;
        }
        baseline::number(&mut ops, &begun);
        let n = ops.len();
        let lengths: Vec<usize> = wire::batches(&ops).iter().map(|chunk| chunk.len()).collect();
```

In the chunk loop, beside `chunk[0].horizon = Some(horizon.clone());` add `baseline::head(&mut chunk[0], n, &begun);`, and delete the `if length == 1 && wire::oversized(chunk) { … continue; }` block — the filter above has done its work.

(c) **`pull` passes what it holds back.** In the loop that splits opened batches, collect them instead of only counting:

```rust
        let mut ops: Vec<Op> = Vec::new();
        let mut held_back: Vec<Op> = Vec::new();
        let mut held_behind = 0usize;
        let mut held_clock = 0usize;
        for (envelope, mut batch) in opened {
            let at = at_of(envelope);
            let sender = envelope.device.as_str();
            if unparsed.get(sender).is_some_and(|first| at >= *first) {
                held_behind += batch.len();
                held_back.append(&mut batch);
            } else if ahead.contains_key(sender) {
                held_clock += batch.len();
                held_back.append(&mut batch);
            } else {
                ops.append(&mut batch);
            }
        }
        let (mut report, mut blocks) =
            apply::apply_page(conn, &ops, &held_back, apply::Waiting::Hold)?;
```

and the release call: `apply::apply_page(conn, &ops, &held_back, apply::Waiting::Release)?`.

(d) **The unreadable gap.** Count the envelopes stepped over — every failure that is neither held behind a rotation nor a batch only a newer build can read. Before the envelope loop:

```rust
        let mut stepped_over = 0usize;
```

at the top of the loop body `let mut kept = false;`; in the epoch arm, beside `behind = true;`, add `kept = true;`; in the `open_batch` error arm, inside `if let WireError::Newer(_) = e { … }`, add `kept = true;`; and directly after `unreadable += 1;`:

```rust
            if !kept {
                stepped_over += 1;
            }
```

After `apply_page`:

```rust
        if stepped_over > 0 {
            // An envelope stepped over is an op this device will never apply (design §7).
            emission::open_gap(conn).map_err(|e| e.to_string())?;
        }
```

Add `use crate::sync_engine::emission;` and `use crate::sync_engine::merge::Emission;` where they are not in scope.

- [ ] **Step 4: Run the client, wire and engine tests**

Run: `cargo test --workspace sync_engine::`
Expected: PASS — the existing baseline tests (`a_baseline_is_emitted_after_the_pull_and_not_before`, `every_pushed_batch_carries_a_horizon`, …) included. A test that relied on a baseline being emitted beside a pending op from an earlier refusal is now wrong by design §5; update its expectation and say so in its doc comment.

- [ ] **Step 5: Commit**

```bash
cargo fmt -p grimoire-core && cargo fmt -p mtg-grimoire
cargo clippy --workspace --all-targets -- -D warnings
git add -A
git commit -m "feat(sync): the client sends emissions, waits on anything pending, and passes held-back batches to apply"
```

---

### Task 10: The record, the amendment, the rule — and the whole build

**Files:**
- Modify: `docs/reference/sync.md`
- Modify: `docs/superpowers/specs/2026-08-29-sync-baseline-design.md`
- Modify: `src-tauri/CLAUDE.md`

- [ ] **Step 1: `sync.md`** — add a section after the narrow fix's *A covered put is dropped only where its claim is what brings it*, titled **"A claim names its emission"**, holding:
  - the rule in the spec's words (§5, §6's two tables, §7's gap sources, §8, §9), with the `sync_state` keys;
  - §1's measured table, and the wire test's printed row size from Task 9 Step 2 (`debug`, Windows, the date);
  - the older-build table (§10);
  - in *What is still owed*: strike the bullet *"A baseline op is still judged by a watermark that is about a stream it is not in"* with `~~…~~` and a dated line saying what closed it; add one bullet per spec §11 residual, each naming its scenario and, where one exists, its pinning test (`a_rebroadcast_takes_back_nothing_this_device_did_since`'s untaken delete).

- [ ] **Step 2: The baseline design** — add `### 9.3 Amended 2026-10-03: a claim names its emission` after §9.2, two paragraphs: claims leave `sync_peers`; generations replace §10.2's cheap exit (and §11's "B skips it in the first filter"); link the new spec. Append to §10.2's ⚠️ sentence: "Replaced by a generation — the claim emissions design."

- [ ] **Step 3: `src-tauri/CLAUDE.md`** — in *Hard rules — sync*, after the narrow fix's bullet, add:

```markdown
- **A claim that names its emission is never judged by `sync_peers` and never moves it**
  (2026-10-03, [the claim emissions design](../docs/superpowers/specs/2026-10-03-baseline-claim-emissions-design.md)).
  It is consumed once, tracked in `sync_state` (`emission@<device>`); a wholly consumed emission
  marks its emitter's generation `taken@`, and a taken generation's claims are **inert** — skipped
  with no database work, their horizon dropping nothing. An active claim on a row held here under
  its uid **writes nothing** unless its emission `resumed` or this device has a `gap`; a covered put
  takes the op path there, and is skipped on a re-delivery once its row's claim has written the
  row. **Every gap clears the marks** — `forget_log_position`, an envelope stepped over as
  unreadable, a group dropped or released — and **a new place a gap can come from owes the same
  call**. No baseline begins while anything is pending, and the client passes the batches it holds
  back into `apply_page` as held. Ops with no emission keep the narrow fix's rules.
```

- [ ] **Step 4: Run the whole build**

Run (once, nothing else verifying anywhere): `npm run verify`
Expected: PASS.

- [ ] **Step 5: A live two-device pass** — with the `running-the-app` skill's lock and a loopback mock relay (the 6a record in `docs/reference/light-app.md` describes one), pair two dev builds, remove a copy on one while the other re-broadcasts (pair a third device to clear every marker), hold one device's clock a day ahead for one trip, and read both collections. Write what was driven and what it showed into the `sync.md` section, with the build named (debug).

- [ ] **Step 6: Commit and ship**

```bash
git add docs/reference/sync.md docs/superpowers/specs/2026-08-29-sync-baseline-design.md src-tauri/CLAUDE.md
git commit -m "docs(sync): the record of a claim that names its emission"
```

Then the `shipping-a-branch` skill: PR, merge `main` in (never rebase), wait for `ci-ok`. Do not press Merge.
