# Pairing Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** a device that joins a pairing group ends up holding the group's collection, decks,
folders, wishlist and tags — measured as *the phone's collection reads 275*.

**Architecture:** a device that has never heard from a peer builds one `put` op per synced row
**in memory**, seals them in the ordinary envelope and pushes them over the existing relay log.
Counters in those ops are *claims* resolved by `max`, not deltas; a *horizon* rides along saying
what the emitter had already absorbed, and filters this batch so nothing is counted twice.
Nothing is written to `sync_ops`, and there is no second apply path.

**Tech Stack:** Rust (rusqlite, serde), TypeScript/React 19, Vitest, `cargo test`.

**Spec:** [`docs/superpowers/specs/2026-08-29-sync-baseline-design.md`](../specs/2026-08-29-sync-baseline-design.md)
— read §5, §8, §9, §10 and §12 before starting. The plan argues from the spec; both travel
together.

## Global Constraints

- **The schema head is `USER_SCHEMA_VERSION = 29`, so the new rung is v30.** Re-read the constant
  when you land — a spent version is spent. `schema::SCHEMA_VERSION` does not exist; there are
  three constants (`LEGACY_SINGLE_FILE_VERSION = 26`, frozen; `USER_SCHEMA_VERSION`;
  `CORPUS_SCHEMA_VERSION`).
- **Counters are deltas, never values** — except a baseline claim, which is a value and is marked
  as one. Two devices each adding one copy must still end at **+2**.
- **A baseline may never invent a card.** Every rule must be checked in the over-count direction
  first; §8.2's table is the fixture.
- **Removing a device changes no card on any other device** (spec §12.3).
- **Nothing in this repository knows a relay URL**, and nothing may learn one. Tests stand a
  mock server on localhost.
- **Every module under `sync_engine/` compiles for `wasm32-unknown-unknown`.** No
  `SystemTime::now()`, no `std::time` — read the wall clock through SQLite
  (`unixepoch('subsec')`) as `apply::observe` does.
- `cargo fmt` and `clippy` are **not** in `npm run verify` but CI runs both, including
  `clippy --lib --target wasm32-unknown-unknown`. Clippy caps function arguments at 7.
- **Do not run `npm run verify`** while sibling agents are active — the controller runs it once
  at fan-in. Two concurrent runs fake ~18 Rust schema failures.
- **Do not `git commit`.** Agents in one worktree share a git index; the controller commits.

---

## File Structure

| File | Owned by | Responsibility |
| --- | --- | --- |
| `src-tauri/src/schema.rs` | Task 1 | the v30 rung and the fresh-install shape |
| `src-tauri/src/sync_engine/merge.rs` | Task 2 | `Op.baseline`, `Op.horizon`, `Horizon`, `Resolved.claims` |
| `src-tauri/src/sync_engine/apply.rs` + `apply/tests.rs` | Task 3 | the horizon filter and the counter arm |
| `src-tauri/src/sync_engine/baseline.rs` *(new)* + `mod.rs` | Task 4 | building the ops, the trigger, the marker |
| `src-tauri/src/sync_engine/client.rs` + `client/tests.rs` | Task 5 | emit-and-push inside a round trip |
| `src-tauri/src/sync_pair/identity.rs`, `sync_pair/pairing.rs` | Task 6 | revocation: pull first, re-arm, and the invariant test |
| `src/lib/ipc.ts`, `src/features/settings/SyncPanel.tsx` (+ test, stories) | Task 7 | what the reader is told |

**No two tasks write the same file.** Tasks 2–5 are compile-coupled, so their interfaces are
pinned below and every task writes against the *written* signature rather than against a sibling's
working tree.

**Shipping:** two PRs. **PR A** = Tasks 1 + 6 (schema and revocation; green on their own).
**PR B** = Tasks 2–5 + 7 (the engine and the panel). The controller opens both through the
`auto-pr` skill and does not press Merge.

---

## Interfaces, pinned

Every task writes against exactly this. Do not improvise a name.

```rust
// merge.rs — new public items

/// What the emitter had already folded into its claims when it read its tables.
///
/// Not a watermark write. See spec §9.1: this filters ONE batch and `sync_peers` is untouched.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Horizon {
    /// device id → the highest stamp from that device already inside the claims.
    pub seen: BTreeMap<String, Hlc>,
}

impl Horizon {
    /// Is `op` already inside the claims this horizon belongs to?
    ///
    /// **Only ever asked of a non-baseline `Put`** — the caller enforces the other two
    /// exemptions, because a `Horizon` cannot see an op's kind without being handed one.
    pub fn covers(&self, at: &Hlc) -> bool;
    /// Fold another horizon in, keeping the greater stamp per device.
    pub fn absorb(&mut self, other: &Horizon);
}

pub struct Op {
    // ...existing seven fields, unchanged...
    /// A state CLAIM rather than a change: `counters` hold values. Spec §8.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub baseline: bool,
    /// Carried by the FIRST op of each baseline batch, so every stored relay row has one.
    /// The receiver unions whatever it finds. Spec §9.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub horizon: Option<Horizon>,
}

pub struct Resolved {
    // ...existing six fields, unchanged...
    /// Per counter key, the greatest value any baseline op claimed. Spec §8.2.
    pub claims: BTreeMap<String, i64>,
}
```

```rust
// apply.rs — one item promoted from private

/// A synced table's parents-first rank, so `baseline` emits in the order `apply` expects.
pub(crate) fn order_of(table: &str) -> Option<u8>;
```

```rust
// baseline.rs — the whole surface

/// Peers that need a baseline: on the roster, not revoked, not this device, no watermark, and
/// no marker or one older than the relay's tail. Spec §10 and §10.1.
pub fn peers_needing(conn: &Connection) -> Result<Vec<String>, String>;

/// Every synced row as a baseline `put`, parents first. Spec §7, §10.2.
pub fn build(conn: &Connection, device: &str) -> Result<Vec<Op>, String>;

/// What this device has already absorbed: its `sync_peers`, plus its own highest
/// `sync_ops` stamp. Spec §9.
pub fn horizon(conn: &Connection, device: &str) -> Result<Horizon, String>;

/// Stamp the marker once the whole baseline has been handed over. Spec §10.1.
pub fn mark_sent(conn: &Connection, peer: &str) -> Result<(), String>;

/// `deck_audit` rows among `ops` — what the panel names separately. Spec §7, §13.
pub fn history_count(ops: &[Op]) -> usize;

/// The relay's tail, in seconds. Mirrors `relay/src/log.ts`'s `TAIL_MS`.
pub const TAIL_SECS: i64 = 30 * 24 * 60 * 60;
```

```rust
// client.rs — one new helper, and two new RelayOutcome fields

/// Seal and POST `ops` without touching `sync_ops`. Factored out of `push`, which keeps its
/// own `pushed_at` bookkeeping and calls this for the bytes.
async fn post_ops(conn: &Connection, base: &str, group: &Group, device: &str, ops: &[Op])
    -> Result<(), String>;

pub struct RelayOutcome {
    // ...existing eight fields...
    /// Ops sent as a first-contact baseline.
    pub baseline_ops: usize,
    /// The `deck_audit` rows among them, named separately because they can surprise.
    pub baseline_history: usize,
}
```

```ts
// ipc.ts
export interface RelayOutcome {
  // ...existing eight...
  baselineOps: number;
  baselineHistory: number;
}
```

---

## Task 1: Schema v30 — `sync_devices.baselined_at`

**Files:**
- Modify: `src-tauri/src/schema.rs` — the constant, `USER_SCHEMA_SQL`, a rung in `migrate_user`

**Interfaces:**
- Consumes: nothing
- Produces: the column `sync_devices.baselined_at INTEGER`, nullable, no default

- [ ] **Step 1: Write the failing test**

In `schema.rs`'s `mod tests`:

```rust
/// v30's column exists on an UPGRADED file, and the ladder is what put it there.
#[test]
fn the_roster_learns_when_a_peer_was_baselined() {
    let conn = Connection::open_in_memory().unwrap();
    migrate_single_file(&conn).unwrap();
    migrate_user(&conn).unwrap();
    let n: i64 = conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('sync_devices')
              WHERE name = 'baselined_at'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1, "the ladder did not add baselined_at");
    let version: i64 = conn.query_row("PRAGMA main.user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(version, USER_SCHEMA_VERSION);
    assert_eq!(USER_SCHEMA_VERSION, 30);
}
```

- [ ] **Step 2: Run it and watch it fail**

`cd src-tauri && cargo test --lib -- schema::tests::the_roster_learns_when_a_peer_was_baselined`
Expected: FAIL, `assert_eq!(n, 1)` — left `0`, right `1`.

- [ ] **Step 3: Bump the constant**

`pub const USER_SCHEMA_VERSION: i64 = 30;` — and read its doc comment, which names the rung
count; update it in the same edit.

- [ ] **Step 4: Add the rung, at the very bottom of `migrate_user`, above the `sync_clock` repair**

```rust
    // v30: the roster learns when each peer was last handed a baseline.
    //
    // **`ADD COLUMN` and never a rebuild.** `sync_devices` is `WITHOUT ROWID` on a TEXT primary
    // key, and measured with `node:sqlite` on 2026-08-29 the ALTER replaces the closing paren
    // and leaves the table option where it was: `revoked_at INTEGER\n             ,
    // baselined_at INTEGER) WITHOUT ROWID`. `USER_SCHEMA_SQL` wears that exact shape, which is
    // what `the_user_schema_is_byte_identical_to_what_the_ladder_builds` compares.
    //
    // NULL means "never baselined", which is the state every existing row is in and the state
    // the trigger reads. No seed, no repair, and nothing for `split::convert` to miss —
    // deliberately, because a control row that only a rung seeds is the bug that cost a
    // shipping week (see this function's `sync_clock` paragraph below).
    if v < 30 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch("ALTER TABLE sync_devices ADD COLUMN baselined_at INTEGER;")?;
        // Literal `30`, for the reason every step before it writes its own: this step is what
        // *makes* a database version 30.
        tx.execute_batch("PRAGMA main.user_version = 30;")?;
        tx.commit()?;
    }
```

- [ ] **Step 5: Match `USER_SCHEMA_SQL` byte for byte**

The `sync_devices` block must end **exactly** like this — note the comma on its own indent, which
is SQLite's rendering and not a style choice:

```
                 revoked_at INTEGER
             , baselined_at INTEGER) WITHOUT ROWID;
```

- [ ] **Step 6: Run the fence and the new test together**

```
cd src-tauri && cargo test --lib schema::tests::the_roster_learns_when_a_peer_was_baselined \
    schema::tests::the_user_schema_is_byte_identical_to_what_the_ladder_builds
```
Expected: **2 passed**. Report the selected count — a filter that matched nothing exits 0 and
proves nothing.

- [ ] **Step 7: Mutate, for real**

Delete the `ALTER TABLE` line, re-run, confirm **both** tests go red, restore, confirm green.
Then change the `USER_SCHEMA_SQL` line to `, baselined_at INTEGER ) WITHOUT ROWID;` (one extra
space) and confirm the fence alone goes red. **If either mutation survives, stop and report it.**

- [ ] **Step 8: Report**

Name the files touched and paste the test output. Do not commit.

---

## Task 2: `merge` — the claim, the horizon, and the fold

**Files:**
- Modify: `src-tauri/src/sync_engine/merge.rs` (definition + its own `mod tests`)
- Modify: `src-tauri/src/sync_engine/capture.rs` — `op_from_row` only, to fill the two new fields
- Modify: `src-tauri/src/sync_engine/wire.rs` — the `realistic()` test helper only

**Interfaces:**
- Consumes: nothing
- Produces: `Horizon`, `Op.baseline`, `Op.horizon`, `Resolved.claims` — exactly as pinned above

- [ ] **Step 1: Write the failing tests**

```rust
/// §8.2, row 2: two claims about one row resolve to the LARGER, never their sum.
#[test]
fn two_baselines_claim_rather_than_add() {
    let a = claim("dev-a", 10, json!({"quantity": 4}));
    let b = claim("dev-b", 20, json!({"quantity": 3}));
    for pair in [vec![a.clone(), b.clone()], vec![b, a]] {
        let r = fold(&pair);
        assert_eq!(r.claims.get("quantity"), Some(&4), "claims must not sum");
        assert_eq!(r.counters.get("quantity"), None, "a claim is not a delta");
    }
}

/// A baseline op's counters never reach `counters`, and an ordinary op's never reach `claims`.
/// This is the whole separation, and folding them together is the +1 bug in §8.1.
#[test]
fn a_claim_and_a_delta_are_kept_apart() {
    let ops = vec![
        claim("dev-a", 10, json!({"quantity": 5})),
        put("dev-a", 20, json!({}), json!({"quantity": 1})),
    ];
    let r = fold(&ops);
    assert_eq!(r.claims.get("quantity"), Some(&5));
    assert_eq!(r.counters.get("quantity"), Some(&1));
}

/// The founding constraint, unchanged: with no baseline in the set, deltas still sum.
#[test]
fn two_ordinary_adds_still_sum_to_two() {
    let ops = vec![
        put("dev-a", 10, json!({}), json!({"quantity": 1})),
        put("dev-b", 20, json!({}), json!({"quantity": 1})),
    ];
    assert_eq!(fold(&ops).counters.get("quantity"), Some(&2));
    assert!(fold(&ops).claims.is_empty());
}

/// A horizon covers a stamp at or below its own for that device, and nothing from a device
/// it says nothing about.
#[test]
fn a_horizon_covers_only_what_it_names() {
    let mut h = Horizon::default();
    h.seen.insert("dev-a".into(), at(50, "dev-a"));
    assert!(h.covers(&at(50, "dev-a")), "at the horizon is inside it");
    assert!(h.covers(&at(49, "dev-a")));
    assert!(!h.covers(&at(51, "dev-a")));
    assert!(!h.covers(&at(1, "dev-b")), "a device it never heard of is not covered");
}

/// Unioning two horizons keeps the greater stamp per device, so a page carrying two
/// baselines is filtered by both.
#[test]
fn absorbing_a_horizon_keeps_the_greater_stamp() {
    let mut a = Horizon::default();
    a.seen.insert("x".into(), at(10, "x"));
    a.seen.insert("y".into(), at(90, "y"));
    let mut b = Horizon::default();
    b.seen.insert("x".into(), at(50, "x"));
    b.seen.insert("z".into(), at(7, "z"));
    a.absorb(&b);
    assert_eq!(a.seen.get("x"), Some(&at(50, "x")));
    assert_eq!(a.seen.get("y"), Some(&at(90, "y")));
    assert_eq!(a.seen.get("z"), Some(&at(7, "z")));
}

/// The wire keeps its shape for a peer on an older build: an ordinary op serialises with
/// neither new key, so nothing that reads it today has to change.
#[test]
fn an_ordinary_op_carries_no_baseline_keys_on_the_wire() {
    let json = serde_json::to_string(&put("dev-a", 1, json!({}), json!({}))).unwrap();
    assert!(!json.contains("baseline"), "{json}");
    assert!(!json.contains("horizon"), "{json}");
    let back: Op = serde_json::from_str(&json).unwrap();
    assert!(!back.baseline);
    assert_eq!(back.horizon, None);
}
```

Add a `claim` helper beside the existing `put`/`del`:

```rust
fn claim(dev: &str, ms: i64, counters: serde_json::Value) -> Op {
    Op { baseline: true, ..put(dev, ms, json!({}), counters) }
}
```

...which requires `put` and `del` to fill the two new fields. Give `Op` no `Default`; set them
explicitly in the three helpers.

- [ ] **Step 2: Run them and watch them fail**

`cd src-tauri && cargo test --lib sync_engine::merge`
Expected: compile error, `no field 'claims' on type 'Resolved'`.

- [ ] **Step 3: Add the fields**

Exactly as pinned. `Horizon` derives `Eq`; `Op` does **not** (it holds `serde_json::Value`), so
keep its existing derive list and add nothing.

- [ ] **Step 4: Split the counter arm in `fold`**

Inside the `Kind::Put` arm, replace the counter loop with:

```rust
                // **A claim is not a delta and the two must never meet in one map.** Summing
                // them is §8.1's failure: a baseline claiming 5 plus the `+1` already inside
                // that 5 inserts the row at 6. `max` across claims is §8's rule — two devices
                // holding 4 and 3 of one printing hold 4 between them, not 7.
                if op.baseline {
                    for (k, v) in &op.counters {
                        let held = out.claims.entry(k.clone()).or_insert(*v);
                        *held = (*held).max(*v);
                    }
                } else {
                    for (k, d) in &op.counters {
                        *out.counters.entry(k.clone()).or_insert(0) += d;
                    }
                }
```

`Horizon::covers` and `absorb`:

```rust
impl Horizon {
    /// `<=` and not `<`: a stamp exactly at the horizon is one the emitter had folded in.
    pub fn covers(&self, at: &Hlc) -> bool {
        self.seen.get(&at.device).is_some_and(|h| at <= h)
    }

    pub fn absorb(&mut self, other: &Horizon) {
        for (device, stamp) in &other.seen {
            match self.seen.get(device) {
                Some(held) if held >= stamp => {}
                _ => {
                    self.seen.insert(device.clone(), stamp.clone());
                }
            }
        }
    }
}
```

- [ ] **Step 5: Fill the two new fields at the other three construction sites**

`capture::op_from_row` — a stored op is never a baseline (spec §5.1), so:
`baseline: false, horizon: None,` with a one-line comment saying why it is a constant and not a
column read.
`wire::tests::realistic` — same two lines.

- [ ] **Step 6: Run the module and the wire suite**

`cd src-tauri && cargo test --lib -- sync_engine::merge sync_engine::wire`

**Note the bare `--`.** `cargo test --lib a b` exits 1 with `unexpected argument 'b' found` — cargo takes one positional TESTNAME and the rest must go to the harness. Found by Task 2.
Expected: all pass. Report the selected count.

- [ ] **Step 7: Mutate, for real**

Four mutations, each restored after:
1. `max` → `+` in the claim arm — `two_baselines_claim_rather_than_add` must go red.
2. Drop the `if op.baseline` branch so claims fall through to `counters` —
   `a_claim_and_a_delta_are_kept_apart` must go red.
3. `at <= h` → `at < h` in `covers` — `a_horizon_covers_only_what_it_names` must go red.
4. Remove `skip_serializing_if` from `baseline` —
   `an_ordinary_op_carries_no_baseline_keys_on_the_wire` must go red.

**Any mutation that survives is a finding to report, not a test to adjust.**

- [ ] **Step 8: Report** — files, test output, and the four mutation results. Do not commit.

---

## Task 3: `apply` — the horizon filter and the counter arm

**Files:**
- Modify: `src-tauri/src/sync_engine/apply.rs`
- Modify: `src-tauri/src/sync_engine/apply/tests.rs`

**Interfaces:**
- Consumes: `merge::{Horizon, Op, Resolved}` exactly as pinned in Task 2. **Write against the
  signature, not against the sibling's working tree.**
- Produces: `pub(crate) fn order_of(table: &str) -> Option<u8>`

- [ ] **Step 1: Write the failing tests** in `apply/tests.rs`

```rust
/// §1's live scenario, over two real databases. A pours its collection into B while its own
/// `+1` is still in the same page. B must land on 5 and not 6.
#[test]
fn a_claim_and_the_delta_already_inside_it_do_not_both_count() {
    let (a, b) = (paired("dev-a"), paired("dev-b"));
    add_copy(&a);
    a.execute("UPDATE collection_entries SET quantity = 5", []).unwrap();
    let mut page: Vec<Op> = outbox(&a);              // the ordinary ops, including the +1
    let mut base = baseline_ops(&a, "dev-a");        // claims quantity = 5, horizon covers them
    page.append(&mut base);
    apply(&b, &page).unwrap();
    assert_eq!(qty(&b), (1, 5), "the claim already held the delta");
}

/// §8.2 row 2 end to end: overlapping stashes converge on the larger, never the sum.
#[test]
fn two_devices_that_both_baseline_converge_on_the_larger_count() { /* 4 vs 3 → 4 both sides */ }

/// The founding constraint, through the new arm: no baseline anywhere, +1 each, ends at 2.
#[test]
fn an_ordinary_exchange_still_lands_at_two() { /* unchanged behaviour, guarded */ }

/// §9.1, exemption one: a baseline op is NEVER suppressed by the horizon it travels with —
/// the horizon covers the emitter's own top stamp, which is above every backdated claim.
#[test]
fn a_horizon_does_not_suppress_the_baseline_it_arrived_with() { /* B ends non-empty */ }

/// §9.1, exemption two, and the one whose failure is permanent: a tombstone below the horizon
/// is still applied, because a claim cannot say "and this row is gone".
#[test]
fn a_tombstone_below_the_horizon_is_still_applied() { /* B's row is deleted */ }

/// §9.1: and none of it writes a watermark.
#[test]
fn the_horizon_never_writes_to_sync_peers() {
    // snapshot sync_peers, apply a page whose horizon names a device with no ops in the page,
    // assert sync_peers is byte-identical afterwards
}

/// Emitting order agrees with the order `apply` sorts by, so a first sync is one pass.
#[test]
fn every_synced_table_has_a_parents_first_rank() {
    for spec in &capture::TABLES {
        assert!(order_of(spec.table).is_some(), "{} has no rank", spec.table);
    }
}
```

- [ ] **Step 2: Run and watch them fail** — `cargo test --lib sync_engine::apply`

- [ ] **Step 3: Promote `order_of`**

```rust
pub(crate) fn order_of(table: &str) -> Option<u8> {
    meta_of(table).map(|m| m.order)
}
```

- [ ] **Step 4: Gather and apply the horizon in `apply_in`, above the existing filter**

```rust
    // **The horizon filters this batch and writes nothing.** Spec §9.1: raising `sync_peers`
    // instead is wrong twice — it would suppress the baseline itself, whose ops are stamped
    // from each row's `updated_at` and therefore sit BELOW the emitter's own top stamp; and a
    // watermark write is durable, so a `del` below the horizon would be skipped now and never
    // offered again, leaving this device holding a row the group deleted.
    let mut horizon = Horizon::default();
    for op in ops {
        if let Some(h) = &op.horizon {
            horizon.absorb(h);
        }
    }
```

and inside the existing loop, beside `mine` and `seen`:

```rust
        // Exemptions in spec §9.1's table: a baseline op describes the horizon rather than
        // being described by it, and a tombstone is the one thing a claim cannot express.
        let inside = op.kind == Kind::Put && !op.baseline && horizon.covers(&op.at);
        if mine || seen || inside {
```

`inside` counts as `skipped`, like the other two.

- [ ] **Step 5: The counter arm in `update_row`**

Replace the delta loop's head and tail:

```rust
    for (name, floor) in meta.counters {
        let delta = g.resolved.counters.get(*name).copied().unwrap_or(0);
        let claim = g.resolved.claims.get(*name).copied();
        // A zero delta with no claim is nothing to do. **With a claim it is not** — the claim
        // may still raise the row, which is the whole of §8.2.
        if delta == 0 && claim.is_none() {
            continue;
        }
        let current: i64 = /* unchanged read */;
        // §8.2. Deltas apply to what this device already holds — the existing, correct
        // op-path answer — and the claim can only RAISE that floor. It can therefore never
        // over-count, which is the direction that invents a card.
        let next = match claim {
            Some(c) => (current + delta).max(c),
            None => current + delta,
        };
```

The `Floor` match below is unchanged. **Note in a comment** that while a claim is present `next`
cannot reach zero, so `Floor::DeleteAtZero` does not fire — spec §8's named consequence.

- [ ] **Step 6: The counter arm in `insert_row`**

```rust
    for (name, _) in meta.counters {
        let sum = combined.counters.get(*name).copied().unwrap_or(0);
        let claim = combined.claims.get(*name).copied().unwrap_or(0);
        cols.push((*name).to_owned());
        // The row does not exist here, so "what this device already holds" is zero and §8.2's
        // rule reduces to this.
        vals.push(Sql::Integer(sum.max(claim)));
    }
```

- [ ] **Step 7: Run the whole apply suite** — `cargo test --lib sync_engine::apply`. Report the
  selected count.

- [ ] **Step 8: Mutate, for real**

1. `(current + delta).max(c)` → `current + delta + c` —
   `a_claim_and_the_delta_already_inside_it_do_not_both_count` must go red.
2. Drop `!op.baseline` from `inside` —
   `a_horizon_does_not_suppress_the_baseline_it_arrived_with` must go red.
3. Drop `op.kind == Kind::Put` from `inside` —
   `a_tombstone_below_the_horizon_is_still_applied` must go red.
4. `sum.max(claim)` → `sum + claim` in `insert_row` — a test must go red; if none does, **that
   is a missing test and a finding**.

- [ ] **Step 9: Report** — files, output, all four mutation results. Do not commit.

---

## Task 4: `sync_engine::baseline` — building it

**Files:**
- Create: `src-tauri/src/sync_engine/baseline.rs`
- Modify: `src-tauri/src/sync_engine/mod.rs` — one `pub mod baseline;` and a doc line

**Interfaces:**
- Consumes: `merge::{Horizon, Kind, Op}`, `capture::{Spec, TABLES}`, `apply::order_of`
- Produces: the five functions and `TAIL_SECS`, exactly as pinned

- [ ] **Step 1: Write the failing tests** (an inline `#[cfg(test)] mod tests` over
  `schema::memory_pair`)

```rust
/// A fresh paired database offers its one seeded folder and nothing else, and the op is a
/// claim rather than a change.
#[test]
fn a_fresh_database_baselines_its_seeded_folder() { /* 1 op, table collection_folders, baseline */ }

/// Parents before children, so a first sync is one pass rather than several.
#[test]
fn rows_are_emitted_parents_first() {
    // build over a database holding a folder and a card in it; assert the folder's op index
    // is below the card's, and that every op's `order_of` is non-decreasing
}

/// §10.2: the stamp is the row's own modification time, never "now" — and `acquired_at` is
/// never read, because it is user data and often years old.
#[test]
fn a_baseline_op_is_stamped_from_the_rows_own_column() {
    // set updated_at to a known past second and acquired_at to a different one;
    // assert op.at.ms == updated_at * 1000 and NOT acquired_at
}

/// Every op in one emission has a distinct stamp, so `fold`'s same-stamp dedupe cannot
/// silently drop a row that happens to share a second with another.
#[test]
fn no_two_ops_in_one_baseline_share_a_stamp() { /* seed 5 rows with one updated_at */ }

/// The trigger's four conditions, each alone.
#[test]
fn a_revoked_peer_is_never_baselined() { /* revoked_at set → not in peers_needing */ }
#[test]
fn a_peer_that_has_spoken_is_not_baselined() { /* a sync_peers row → excluded */ }
#[test]
fn this_device_never_baselines_itself() { /* own device_id → excluded */ }
#[test]
fn a_marked_peer_is_left_alone_until_the_tail_has_passed() {
    // baselined_at = now → excluded; baselined_at = now - TAIL_SECS - 1 → included again
}

/// §9: the horizon is this device's own `sync_peers` plus its own top stamp.
#[test]
fn the_horizon_names_this_device_and_every_peer_it_has_heard() { /* both halves present */ }

/// §7/§13: history is counted separately because it is the part that can surprise.
#[test]
fn history_is_counted_on_its_own() { /* deck_audit rows only */ }
```

- [ ] **Step 2: Run and watch them fail** — the module does not exist yet.

- [ ] **Step 3: `peers_needing`**

```rust
pub fn peers_needing(conn: &Connection) -> Result<Vec<String>, String> {
    // **The marker is advisory, not final.** Spec §10.1: a peer whose own baseline never got
    // out is invisible to the relay's compaction floor, so its inbox can be collected while
    // this device believes it has done its part. Re-offering after the relay's tail closes
    // that, at a cost of one wasted re-send a month for a device that never came back.
    let sql = "SELECT d.device_id
                 FROM sync_devices d
                 LEFT JOIN sync_peers p ON p.device_id = d.device_id
                WHERE d.revoked_at IS NULL
                  AND d.device_id <> (SELECT device_id FROM sync_identity WHERE id = 1)
                  AND p.device_id IS NULL
                  AND (d.baselined_at IS NULL OR d.baselined_at < unixepoch() - ?1)
                ORDER BY d.added_at, d.device_id";
    /* query_map over TAIL_SECS */
}
```

- [ ] **Step 4: `build`**

One `SELECT` per table, in `order_of` order, shaped like the capture trigger's: `sync_uid`, every
`spec.fields` column, every `spec.counters` column, the stamp column, and one correlated
subquery per parent — `(SELECT sync_uid FROM <p.table> WHERE id = t.<p.col>)`.

The stamp column, by table (spec §10.2 — **read off the live database, never off `schema.rs`,
which is a ladder**):

```rust
/// `updated_at` for nine, and the two that carry their own stamp as an ordinary field.
///
/// ⚠️ `collection_entries.acquired_at` is NOT a modification time. It is the date the reader
/// says they acquired the card — user data, frequently NULL, sometimes years old.
fn stamp_column(table: &str) -> &'static str {
    match table {
        "deck_audit" => "at",
        "muted_tags" => "muted_at",
        _ => "updated_at",
    }
}
```

The stamp itself:

```rust
    // `ms` from the row's own column, `ctr` from a running index so that two rows sharing a
    // second still get distinct stamps — `merge::fold` treats two ops with one stamp as one op
    // and skips the second, which would silently drop a row.
    at: Hlc { ms: stamp_secs * 1000, ctr: index as i64, device: device.to_owned() },
```

Every op: `kind: Kind::Put`, `baseline: true`, `horizon: None` (Task 5 stamps it on the first of
each batch), `counters` holding **values**.

- [ ] **Step 5: `horizon`, `mark_sent`, `history_count`** — small and direct;
  `horizon` reads `sync_peers` and `SELECT max(hlc_ms), ... FROM sync_ops WHERE device_id = ?`.

- [ ] **Step 6: Run** — `cargo test --lib sync_engine::baseline`. Report the selected count.

- [ ] **Step 7: Mutate, for real**

1. `stamp_column` → always `"updated_at"` — the `deck_audit`/`muted_tags` case must go red.
2. `ctr: index` → `ctr: 0` — `no_two_ops_in_one_baseline_share_a_stamp` must go red.
3. Drop `d.revoked_at IS NULL` — `a_revoked_peer_is_never_baselined` must go red.
4. Drop the `baselined_at` clause — `a_marked_peer_is_left_alone…` must go red.
5. Sort by table name instead of `order_of` — `rows_are_emitted_parents_first` must go red.

- [ ] **Step 8: Report.** Do not commit.

---

## Task 5: `client` — emitting inside a round trip

**Files:**
- Modify: `src-tauri/src/sync_engine/client.rs`
- Modify: `src-tauri/src/sync_engine/client/tests.rs`

**Interfaces:**
- Consumes: `baseline::{build, history_count, horizon, mark_sent, peers_needing}`
- Produces: `RelayOutcome.baseline_ops`, `RelayOutcome.baseline_history`

- [ ] **Step 1: Write the failing tests** against `httpmock`, following the file's existing shape

```rust
/// The order in §10.2: a device that is behind must not speak for the group, so the pull
/// completes before anything is emitted.
#[tokio::test]
async fn a_baseline_is_emitted_after_the_pull_and_not_before() { /* assert request order */ }

/// The marker is stamped only on success, so a failed push is simply done again.
#[tokio::test]
async fn a_failed_baseline_push_leaves_the_marker_unset() { /* 500 → baselined_at IS NULL */ }

/// ...and a successful one is not repeated on the next run.
#[tokio::test]
async fn a_baseline_is_sent_once_per_peer() { /* second run_once sends 0 baseline ops */ }

/// §5.1: the outbox never holds a baseline op.
#[tokio::test]
async fn baseline_ops_are_never_written_to_sync_ops() {
    // count sync_ops before and after; the delta is 0
}

/// §9: the first op of each batch carries the horizon, so every stored relay row has one.
#[tokio::test]
async fn every_pushed_batch_carries_a_horizon() { /* decode the mock's bodies */ }
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Factor `post_ops` out of `push`** — `push` keeps its `pushed_at` bookkeeping and
  calls it; nothing else about `push` changes.

- [ ] **Step 4: `emit_baselines`**

```rust
/// Hand a full baseline to every peer that needs one. Spec §10.
///
/// **Built, sealed and pushed without ever touching `sync_ops`** (§5.1). The outbox's contract
/// is "deltas, never values", and a baseline holds values; it is also a table scan away at any
/// moment, so there is nothing worth filing.
async fn emit_baselines(conn: &Connection, base: &str, ...) -> Result<(usize, usize), String> {
    // for each peer in peers_needing:
    //   ops = baseline::build(...); if empty, mark_sent and continue
    //   horizon = baseline::horizon(...)
    //   for each chunk in wire::batches(&ops): stamp chunk[0].horizon = Some(horizon.clone());
    //       post_ops(...).await?
    //   baseline::mark_sent(conn, &peer)?      // only after every chunk landed
}
```

- [ ] **Step 5: Wire it into `run_once`** — the order becomes **push, pull, emit-baselines,
  ack**. Keep the existing "push first" paragraph and extend it: the pull is what makes the
  emitter current, and the baseline goes out behind it.

- [ ] **Step 6: Run** — `cargo test --lib sync_engine::client`. Report the selected count.

- [ ] **Step 7: Mutate, for real**

1. Move `mark_sent` above the push loop — `a_failed_baseline_push_leaves_the_marker_unset`
   must go red.
2. Emit before the pull — `a_baseline_is_emitted_after_the_pull_and_not_before` must go red.
3. Stamp the horizon on no op — `every_pushed_batch_carries_a_horizon` must go red.

- [ ] **Step 8: Report.** Do not commit.

---

## Task 6: Revocation — pull first, re-arm, and the invariant

**Files:**
- Modify: `src-tauri/src/sync_pair/identity.rs`
- Modify: `src-tauri/src/sync_pair/pairing.rs` — the `sync_device_revoke` command only

**Interfaces:**
- Consumes: `sync_devices.baselined_at` from Task 1
- Produces: nothing other tasks call

- [ ] **Step 1: Write the failing tests**

```rust
/// **Spec §12.3, and the one test here whose failure is a reader losing cards.** Removing a
/// device withdraws nothing it contributed.
#[test]
fn removing_a_device_changes_no_row_it_contributed() {
    // two databases converge on a collection, a deck and a folder built by BOTH
    // snapshot every synced table on B, ordered, sync_uid included
    // B revokes A
    // assert the snapshot is identical afterwards, table by table, row by row
    // `sync_devices` and `sync_group` are the only tables allowed to differ, named explicitly
}

/// §12.4: a rotation re-arms the baseline for the devices that remain, so the next sync
/// repairs whatever the epoch boundary swallowed.
#[test]
fn a_rotation_re_arms_the_baseline_for_the_devices_that_remain() {
    // three on the roster, all with baselined_at set; revoke one;
    // the two survivors' baselined_at are NULL, the revoked one's is untouched
}
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Clear the marker inside `revoke_device`'s existing transaction**

```rust
    // **A rotation re-arms the baseline for everybody who stays.** Spec §12.4: the new epoch
    // makes every op written before it unreadable, and `client::pull` steps over a lower-epoch
    // envelope rather than stalling on it — so a peer's last words can be lost at the boundary.
    // Re-baselining under the new key carries them across as ordinary rows. Claims resolve by
    // `max` and a horizon only filters, so this cannot double-count.
    tx.execute(
        "UPDATE sync_devices SET baselined_at = NULL WHERE revoked_at IS NULL",
        [],
    )?;
```

- [ ] **Step 4: Pull before rotating, in the command**

`sync_device_revoke` completes `client::run_once` (or `client::pull`) **before** calling
`revoke_device`, and returns the pull's error without rotating if it fails. Comment: removing a
device is never urgent, and doing it offline is the one way to lose what that device last said.

- [ ] **Step 5: Run** — `cargo test --lib sync_pair`. Report the selected count.

- [ ] **Step 6: Mutate, for real**

1. Make `revoke_device` also `DELETE FROM collection_entries WHERE ...` for the departed
   device's rows — `removing_a_device_changes_no_row_it_contributed` must go red. **This is the
   mutation that matters most on this plan.**
2. Drop the `WHERE revoked_at IS NULL` from step 3 — the re-arm test must go red.

- [ ] **Step 7: Report.** Do not commit.

---

## Task 7: What the reader is told

**Files:**
- Modify: `src/lib/ipc.ts` — `RelayOutcome`
- Modify: `src/features/settings/SyncPanel.tsx` — `outcomeText`
- Modify: `src/features/settings/SyncPanel.test.tsx`, `SyncPanel.stories.tsx`

**Interfaces:**
- Consumes: `RelayOutcome.baselineOps`, `RelayOutcome.baselineHistory` from Task 5

- [ ] **Step 1: Write the failing tests** in `SyncPanel.test.tsx`

```ts
it("says a first exchange is a first exchange, and names the history separately", () => {
  const text = outcomeText({ ...OUTCOME, baselineOps: 1069, baselineHistory: 240 });
  expect(text).toMatch(/first exchange/i);
  expect(text).toMatch(/1,069/);
  expect(text).toMatch(/240 .*(history|deck)/i);
});

it("says nothing about a baseline on an ordinary sync", () => {
  expect(outcomeText(OUTCOME)).not.toMatch(/first exchange/i);
});
```

- [ ] **Step 2: Run and watch them fail** — `npx vitest run src/features/settings/SyncPanel.test.tsx`

- [ ] **Step 3: Add the two fields to `RelayOutcome`** with doc comments naming spec §13.

- [ ] **Step 4: Add the clause to `outcomeText`**, before the `deferred` clause, following the
  file's existing "a sentence per non-zero clause" shape and its `plural` helper. It must say
  this is the first exchange with that device, how much moved, and name the history count on its
  own.

- [ ] **Step 5: Add a story** to `SyncPanel.stories.tsx` covering a baseline outcome, matching
  the file's existing story shape.

- [ ] **Step 6: Run** — `npx vitest run src/features/settings/SyncPanel.test.tsx`

- [ ] **Step 7: Mutate, for real** — drop the `baselineHistory` clause; the first test must go
  red.

- [ ] **Step 8: Report.** Do not commit.

---

## Fan-in (controller only)

- [ ] `cargo fmt --all` in `src-tauri/`, then `cargo clippy --all-targets -- -D warnings` and
  `cargo clippy --lib --target wasm32-unknown-unknown -- -D warnings`. Neither is in
  `npm run verify`; both are in CI, and they are the only reds a fully green verify can still
  produce.
- [ ] `cargo build --lib --target aarch64-linux-android` — **CI has no Android job**, so `main`
  can stop cross-compiling with nothing going red.

  **Two clangs are on this machine and only one of them works, for each leg.** Measured
  2026-08-29:

  | leg | needs | symptom of the wrong one |
  | --- | --- | --- |
  | wasm clippy | `C:\Program Files\LLVMin` | `failed to find tool "clang": program not found` |
  | Android | the **NDK's** toolchain bin, first on PATH | `ring`'s `check.h`: `fatal error: 'assert.h' file not found` |

  The Android failure names a missing C header and the real cause is that LLVM's clang was found
  before the NDK's and has no Android sysroot. Put
  `C:\Android\Sdk
dk.3.13750724	oolchains\llvm\prebuilt\windows-x86_64in` first and
  set `CC_aarch64_linux_android`, `AR_aarch64_linux_android` and
  `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER` to the `aarch64-linux-android21-clang.cmd` /
  `llvm-ar.exe` in it. Neither clang is on PATH by default, which is why both subagents reported
  the wasm leg as unverifiable.
- [ ] `npm run verify > verify.log 2>&1` **once, serially**, then grep the log. Never pipe it to
  `tail` — you get the pipe's exit code and a failing run reads as green.
- [ ] Verify each agent's mutation claims by re-running one of them yourself. This session has
  already caught a test file passing vacuously and a test that had silently lost its `#[test]`.
- [ ] Commit, then ship **PR A** (Tasks 1, 6) and **PR B** (Tasks 2–5, 7) through `auto-pr`.
  **Do not press Merge.**

## The live pass — the actual deliverable

Nothing above demonstrates the feature. Spec §19:

- [ ] Desktop: `.claude/skills/running-the-app/lock.ps1 acquire app -Wait`, then
  `npm run tauri dev` with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`.
  Adopt the **`mtg-grimoire`** pid, not npm's.
- [ ] Phone: `npx tauri android build --debug --target aarch64`, `adb install -r`,
  `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`, then
  `CDP_PORT=9333 node scripts/cdp.mjs …`. Wake the phone first — a dozing one reports
  `innerWidth: 0`.
- [ ] Press Sync on the desktop, then on the phone.
- [ ] **The phone's collection must read 275**, and its decks, folders and wishes must match the
  desktop's. That number is the deliverable.
- [ ] Then add one copy on each device while both are offline, sync both, and confirm the row
  reads **+2** — the founding constraint, after all of this.
- [ ] Record what the pass found in `docs/reference/sync.md`, with the date and the build.
