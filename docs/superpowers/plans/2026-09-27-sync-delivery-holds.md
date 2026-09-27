# Sync delivery holds — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paired device holds its pull cursor on a change a newer build wrote (until it upgrades) or a parent that may still arrive (briefly), and skips — logged, without taking the sender's later changes with it — a change that can never apply.

**Architecture:** Every op carries its sender's `USER_SCHEMA_VERSION` (an optional wire field, stamped at sealing). `apply` reports *why* each group deferred and classifies it: held · newer, held · waiting, moot, or dropped; only held groups block their device. `client::pull` advances `PULL_CURSOR` only when nothing is held, releases a waiting hold after 3 pulls spanning 10 minutes, and records its state in `sync_state.pull_hold`, which the Sync panel reads through `RelayStatus`.

**Tech Stack:** Rust (rusqlite, serde, `httpmock` in tests), `sync_engine` compiles for `wasm32-unknown-unknown`; React 19 + TypeScript 6 (Vitest).

**Spec:** `docs/superpowers/specs/2026-09-27-sync-delivery-holds-design.md` — read §1's table and §3 before starting any task.

## Global Constraints

- **No schema rung.** State is `sync_state` keys only: `pull_hold`. No relay (`relay/`) change and no deploy.
- **Wire:** `merge::Op` gains `pub schema: Option<i64>` with `#[serde(default, skip_serializing_if = "Option::is_none")]`. Stamped by `wire::seal_batch` on every op it seals, to `crate::schema::USER_SCHEMA_VERSION`. Never at capture. "Newer" is `op.schema > Some(USER_SCHEMA_VERSION)`; absent is not newer.
- **`sync_engine` must compile for wasm32**: no `SystemTime::now()` / `Instant::now()`; time comes from SQL (`SELECT unixepoch()`).
- **Bounds (verbatim):** a waiting hold is released once seen on **3 pulls** spanning **≥ 600 seconds**. A newer hold has no bound.
- **`pull_hold` JSON (verbatim shape):** `{"kind":"newer"|"waiting","since":<unix seconds>,"pulls":<n>}`. Absent key = not held.
- **Skip record:** `errors::record(conn, errors::Source::Relay, "apply", errors::Kind::Other, <message>, Some(<detail>))`, written only for groups dropped in the **committed** pass, after the round loop settles.
- **Reader-facing sentences (verbatim):**
  - persistent, `pullHeld === "newer"`: `A device in your group runs a newer version of MTG Grimoire. Update this device to receive its changes.`
  - outcome, held newer: `{n} {change|changes} from a newer version {waits|wait} until you update.`
  - outcome, waiting: `{n} {change|changes} {is|are} waiting for a change {it builds|they build} on.`
  - outcome, dropped: `{n} {change|changes} could not be applied and {was|were} skipped. The error log has the details.`
- **Never run two `cargo test`s at once** (concurrent runs fake schema failures). The task that owns `cargo test` during a wave is named in the task.
- **Implementers never commit, stash or dispatch subagents.** The controller commits at fan-in. Keep files LF; no Prettier.

## Review Focus

1. **A page mixing a newer device's held op with an ordinary peer's ops** — the ordinary ops apply once, are skipped on every re-delivery, and are not counted in `pulled` again. *(Task B, test `a_held_page_applies_the_other_devices_once_and_counts_them_once`.)*
2. **A newer device's child of a parent deleted here** — moot and consumed, never a permanent newer hold. *(Task A, test `a_newer_devices_child_of_a_deleted_parent_is_moot_not_held`.)*
3. **An envelope that opens but does not parse** — held as newer, not stepped past. *(Task B, test `an_authentic_batch_this_build_cannot_parse_holds_as_newer`.)*
4. **A waiting hold whose parent arrives on the next pull** — applies, clears `pull_hold`, advances, records nothing. *(Task B, test `a_waiting_hold_clears_when_the_parent_arrives`.)*
5. **A newer hold across restarts and past the waiting bound** — never released by pull count or time. *(Task B, test `a_newer_hold_is_never_released_by_the_waiting_bound`.)*

---

## File map

| File | Owner | Responsibility |
| --- | --- | --- |
| `src-tauri/src/sync_engine/merge.rs` | A | `Op.schema` |
| `src-tauri/src/sync_engine/wire.rs` | A | stamp at `seal_batch`; round-trip test |
| `src-tauri/src/sync_engine/apply.rs` (+ `apply/tests.rs`) | A | reasons, classification, `apply_with`, report fields, skip records, `find_row` rename, round cap, module doc |
| `src-tauri/src/sync_engine/client.rs` (+ `client/tests.rs`) | B | hold logic, `pull_hold`, Malformed hold, `pulled`, conversion gate, comments |
| `src-tauri/src/sync_engine/commands.rs` | B | `RelayStatus.pull_held`; `RelayOutcome` fields |
| `src-tauri/src/sync_engine/live.rs` | B | only if it reads `pulled`/`deferred` |
| `src/lib/ipc.ts`, `src/lib/ipc.test.ts` | C | mirror + fence |
| `src/features/settings/SyncPanel.tsx` (+ test) | C | notice + outcome sentences |
| `.storybook/fake/db.ts` | C | fake's relay status / sync-now shapes |
| `docs/reference/sync.md`, `src-tauri/CLAUDE.md`, spec/plan cross-refs | D | the record |

**Waves:** A and C in parallel (C writes against the Interfaces below); **B after A** (it compiles against `apply_with`); D at fan-in.

## Interfaces (verbatim — every task uses these names)

```rust
// merge.rs
pub struct Op { /* …existing… */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<i64>,
}

// apply.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Waiting { Hold, Release }

pub fn apply(conn: &Connection, ops: &[Op]) -> Result<ApplyReport, String>; // = apply_with(conn, ops, Waiting::Hold)
pub fn apply_with(conn: &Connection, ops: &[Op], waiting: Waiting) -> Result<ApplyReport, String>;

pub struct ApplyReport {
    pub applied: usize,      // ops written by THIS call (unchanged meaning)
    pub skipped: usize,      // own / seen / horizon-covered (unchanged meaning)
    pub deferred: usize,     // ops held for re-delivery: held·newer + held·waiting groups and their collateral
    pub held_newer: usize,   // ops in groups held because a newer schema wrote them (NEW)
    pub held_waiting: usize, // ops in groups held for a parent that may still arrive (NEW)
    pub moot: usize,         // ops consumed as the child of a parent deleted here or in this batch (NEW)
    pub dropped: usize,      // ops consumed because they can never apply; each group recorded (NEW)
    /* …existing: resurrected, cycles_broken, … */
}

// client.rs
pub const PULL_HOLD: &str = "pull_hold";
// RelayOutcome gains: pub held_newer: usize, pub dropped: usize   (serde camelCase → heldNewer, dropped)
// commands.rs RelayStatus gains: pub pull_held: Option<String>     (serde camelCase → pullHeld; "newer" | "waiting")
```

```ts
// ipc.ts
export interface RelayStatus { /* …existing… */ pullHeld: "newer" | "waiting" | null; }
export interface RelayOutcome { /* …existing… */ heldNewer: number; dropped: number; }
```

---

### Task A: `apply` says why, and only what can still apply blocks

**Files:**
- Modify: `src-tauri/src/sync_engine/merge.rs` (the `Op` struct, ~line 62)
- Modify: `src-tauri/src/sync_engine/wire.rs` (`seal_batch`, ~86-114; tests)
- Modify: `src-tauri/src/sync_engine/apply.rs` (`Outcome` ~546-550, `apply` ~560-575, the round loop ~626-653, `run_groups` ~675-711, `blocks_of` ~715-754, `resolve_parent` ~821-844, `find_row` ~859-940, `write_group` ~987-1144, `advance_watermarks` ~1513-1560, module doc ~40-75)
- Test: `src-tauri/src/sync_engine/apply/tests.rs`, `src-tauri/src/sync_engine/wire.rs` tests

**Interfaces:** Produces `Waiting`, `apply_with`, the `ApplyReport` fields, `Op.schema` (above). Consumes nothing new.

**You own `cargo test` for this wave** (Task C runs no cargo).

- [ ] **Step 1: Failing tests** in `apply/tests.rs`, using the file's own `paired(device)` / `outbox` / `since` helpers. Each builds ops on device a and applies on b:
  1. `a_newer_devices_op_that_defers_is_held_and_blocks_its_later_ops` — a's ops for a table b's `META` lacks (`op.table = "future_table"`) with `op.schema = Some(USER_SCHEMA_VERSION + 1)`, followed by a known op from a: `report.held_newer > 0`, the known op not applied, `report.deferred` counts both, and a second `apply` of the same ops after the unknown table is "learned" is out of reach — so instead assert the watermark for a stays below the held op (`peers(&b)`).
  2. `a_same_version_unknown_table_is_dropped_recorded_and_does_not_block` — same, with `schema: None`: `report.dropped == 1`, the known op **applied**, one `error_log` row with `source = 'relay'` and `operation = 'apply'`, and the watermark for a past both.
  3. `a_child_of_a_parent_this_device_deleted_is_moot` — b deletes a deck (its own `sync_ops` has the `del`), a's op adds a card to it: `report.moot == 1`, nothing recorded, a's later ops apply.
  4. `a_child_whose_parent_is_deleted_in_the_same_batch_is_moot`.
  5. `a_newer_devices_child_of_a_deleted_parent_is_moot_not_held` (Review Focus 2) — as 3 with `schema = Some(USER_SCHEMA_VERSION + 1)`: moot, not held.
  6. `an_unknown_parent_waits_then_release_drops_it_and_applies_its_collateral_once` — unknown parent (never sent): `apply` → `held_waiting > 0`, collateral not applied; `apply_with(.., Waiting::Release)` on the same ops → `dropped` for the child, collateral applied exactly once (a counter collateral sums to its single delta), one record.
  7. `a_uid_rename_onto_a_taken_uid_drops_the_group_instead_of_failing_the_apply` — construct the `find_row` collision (op carries every grain term of a local row whose uid is higher, while another local row already wears the op's lower uid): `apply` returns `Ok`, `report.dropped == 1`, the other groups in the batch applied.
  8. `the_round_cap_advances_watermarks_by_the_committed_passes_blocks` — a batch whose blocks keep cascading past `min(groups, 8)` rounds; re-applying the same ops must not re-add any counter delta.
  In `wire.rs` tests: `a_sealed_op_carries_this_builds_schema_and_an_old_op_reads_as_none` — seal, open, assert `schema == Some(USER_SCHEMA_VERSION)`; deserialize an op JSON without the key → `None`.

- [ ] **Step 2: Run them and see them fail.** `cargo test --manifest-path src-tauri/Cargo.toml sync_engine::apply:: sync_engine::wire::` — expect compile errors (unknown field `schema`, unknown fn `apply_with`), then assertion failures.

- [ ] **Step 3: Implement.**
  - `merge.rs`: add the field (Interfaces). Every `Op { … }` literal in the crate gains `schema: None` — `cargo check --tests` lists them.
  - `wire.rs::seal_batch`: serialize a copy of each op with `schema = Some(crate::schema::USER_SCHEMA_VERSION)`:
    ```rust
    let stamped: Vec<Op> = ops.iter().cloned()
        .map(|mut op| { op.schema = Some(crate::schema::USER_SCHEMA_VERSION); op })
        .collect();
    let plaintext = serde_json::to_vec(&stamped).map_err(|e| WireError::Malformed(e.to_string()))?;
    ```
  - `apply.rs`:
    ```rust
    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Why { UnknownTable, UnknownParent { table: &'static str, uid: String }, Unbuildable(String) }
    enum Outcome { Written, Deferred(Why) }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Class { Newer, Waiting, Moot, Dropped }
    ```
    - `write_group` returns `Deferred(Why::UnknownTable)` at the unknown-table site, `Deferred(Why::UnknownParent{..})` at `Resolution::Unknown`, and `Deferred(Why::Unbuildable(e.to_string()))` where it currently discards `Err(_)` (~1134). Keep the error text.
    - **Moot check at the unknown-parent site**, before deferring: the parent uid has a `del` in this device's `sync_ops` (`SELECT 1 FROM sync_ops WHERE tbl = ?1 AND uid = ?2 AND kind = 'del' LIMIT 1`, served by `idx_sync_ops_row`) **or** is in the batch's deleted set (build `deleted: BTreeSet<(String, String)>` of `(table, uid)` for groups whose ops include a `Kind::Del`, in `run_groups`, and pass it down) → classify `Moot`.
    - **Classify** each deferred group in `run_groups`: `Moot` (above) → else any op with `schema > Some(USER_SCHEMA_VERSION)` → `Newer` → else `UnknownParent` → `Waiting` when `waiting == Waiting::Hold`, `Dropped` when `Release` → else (`UnknownTable`, `Unbuildable`) → `Dropped`.
    - **Only `Newer` and `Waiting` go to `blocks_of`.** `Moot` and `Dropped` groups are *consumed*: count their ops in `report.moot` / `report.dropped`, and include their ops when `advance_watermarks` computes the device's max (they are below no block of their own).
    - **Held collateral** (`held` closure) stays as today, counted into `deferred` and into the held class of its block.
    - **The round loop**: keep the blocks the committed pass ran under (`committed_blocks`) and pass *those* to `advance_watermarks`; also return the committed pass's `Dropped` groups and record each **after** `RELEASE sync_pass`:
      ```rust
      crate::errors::record(conn, crate::errors::Source::Relay, "apply", crate::errors::Kind::Other,
          &format!("a change to {} from another device could not be applied and was skipped", g.table),
          Some(&format!("uid {} · {}", g.ops[0].uid, why_text)));
      ```
    - **`find_row`**: stop renaming inside `find_row`. Return the intended rename (`Found { rename: Option<(String /*from*/, String /*to*/)> , … }`); `write_group` performs it **inside** the group savepoint after checking `SELECT 1 FROM {table} WHERE sync_uid = ?to` is empty — taken → `Deferred(Why::Unbuildable("uid taken"))`.
    - `pub fn apply(conn, ops)` becomes `apply_with(conn, ops, Waiting::Hold)`; `apply_with` threads `waiting` to `run_groups`.
    - **Module doc** (~40-75): replace the "dropped, not held" paragraph with the classification table from the spec §3.2 and one line on the client's hold (Task B).
  - `ApplyReport`: add the four fields (Interfaces); `deferred` = ops of `Newer` + `Waiting` groups + collateral.

- [ ] **Step 4: Run and pass.** `cargo test --manifest-path src-tauri/Cargo.toml sync_engine::` then the whole crate once: `cargo test --manifest-path src-tauri/Cargo.toml`. Then `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`. If clang is on PATH, also `cargo clippy --manifest-path src-tauri/Cargo.toml --lib --target wasm32-unknown-unknown -- -D warnings` (memory note `wasm-clippy-leg-needs-clang-and-lib.md`).

- [ ] **Step 5: Mutations.** Revert, one at a time, (a) the moot check, (b) the `Newer` arm, (c) consuming dropped ops in the watermark, (d) the savepoint move of the rename — each must turn at least one Step 1 test red. Record which in the report.

- [ ] **Step 6: Report** to `.superpowers/sdd/2026-09-27-sync-delivery-holds/task-A-report.md`: what changed (file:line), tests red→green, mutations, fmt/clippy/wasm. Do not commit.

---

### Task B: the client holds for a reason, and the status says so

**Files:**
- Modify: `src-tauri/src/sync_engine/client.rs` (`RelayOutcome` ~110-131, `pull` ~942-1049, `round_trip` ~1242-1255)
- Modify: `src-tauri/src/sync_engine/commands.rs` (`RelayStatus` ~64-104; `sync_now` ~417-440)
- Modify: `src-tauri/src/sync_engine/live.rs` only where it reads `pulled` (~599-605)
- Test: `src-tauri/src/sync_engine/client/tests.rs`

**Interfaces:** Consumes `apply_with`, `Waiting`, the `ApplyReport` fields, `Op.schema` (Task A — already in the tree). Produces `PULL_HOLD`, `RelayOutcome.held_newer` / `.dropped`, `RelayStatus.pull_held`.

**You own `cargo test`** (Task A has finished).

- [ ] **Step 1: Failing tests** in `client/tests.rs`, over `httpmock` with the file's helpers (`paired`, `grant`, `keys_mock`, `outbox`, `sealed_since`); a page is `{ "envelopes": [...], "cursor": N }`. Build newer ops by setting `op.schema = Some(USER_SCHEMA_VERSION + 1)` on an outbox op **before** calling a helper that seals without re-stamping — add a test-only `wire::seal_batch_as_is` only if the stamping in `seal_batch` makes this impossible; otherwise seal the JSON by hand as `a_push_and_a_pull_carry_a_row_between_two_databases` does.
  1. `a_newer_hold_keeps_the_cursor_and_the_ack_on_every_pull` — page with a newer op on an unknown table: after two `pull`s, `PULL_CURSOR` unchanged, no ack sent (or `LAST_ACKED` unchanged), `pull_hold` = `{"kind":"newer",…}`.
  2. `a_held_page_applies_the_other_devices_once_and_counts_them_once` (Review Focus 1) — the same page also carries device c's ordinary op: c's row lands once; the second pull's `RelayOutcome.pulled == 0`.
  3. `an_authentic_batch_this_build_cannot_parse_holds_as_newer` (Review Focus 3) — seal bytes that are valid JSON but not `Vec<Op>` (e.g. an op with `"kind":"merge"`): cursor held, `pull_hold.kind == "newer"`; contrast: an envelope with a broken seal at the same epoch is stepped past as today.
  4. `a_waiting_hold_releases_on_the_third_pull_after_ten_minutes` — a child whose parent never comes: pulls 1-2 hold; set `pull_hold.since` 601 s back through `sync_state`; pull 3 releases: cursor advances, one `error_log` row, the child's collateral applied once, `pull_hold` gone.
  5. `a_waiting_hold_clears_when_the_parent_arrives` (Review Focus 4) — pull 1 holds; the mock's second page (`since` unchanged) adds the parent's envelope: applied, cursor advances, no record, `pull_hold` gone.
  6. `a_newer_hold_is_never_released_by_the_waiting_bound` (Review Focus 5) — newer hold, `since` 10 000 s back, `pulls` 50: still held.
  7. `an_ordinary_page_advances_and_clears_a_stale_hold`.
  8. `no_legacy_pick_conversion_runs_behind_a_held_pull` — seed a v51-style `deck_tokens.card_id` pick on a paired device with `token_picks_ready` set; a held pull leaves the pick unconverted; an advancing one converts it.
  9. `relay_status_reports_the_hold` — `commands::relay_status` (or its pure builder) reads `pull_held = Some("newer")`.

- [ ] **Step 2: Run and fail.** `cargo test --manifest-path src-tauri/Cargo.toml sync_engine::client::`.

- [ ] **Step 3: Implement.**
  ```rust
  pub const PULL_HOLD: &str = "pull_hold";

  #[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
  struct Hold { kind: String, since: i64, pulls: i64 }

  fn now_secs(conn: &Connection) -> Result<i64, String> {
      conn.query_row("SELECT unixepoch()", [], |r| r.get(0)).map_err(|e| e.to_string())
  }
  fn read_hold(conn: &Connection) -> Option<Hold> {
      get_state(conn, PULL_HOLD).and_then(|s| serde_json::from_str(&s).ok())
  }
  /// Same kind keeps `since` and counts the pull; a new kind starts over.
  fn note_hold(conn: &Connection, kind: &str) -> Result<Hold, String> {
      let now = now_secs(conn)?;
      let hold = match read_hold(conn) {
          Some(h) if h.kind == kind => Hold { pulls: h.pulls + 1, ..h },
          _ => Hold { kind: kind.into(), since: now, pulls: 1 },
      };
      set_state(conn, PULL_HOLD, &serde_json::to_string(&hold).map_err(|e| e.to_string())?)
          .map_err(|e| e.to_string())?;
      Ok(hold)
  }
  fn clear_hold(conn: &Connection) -> Result<(), String> { /* DELETE the key via the module's own state writer */ }
  const WAITING_PULLS: i64 = 3;
  const WAITING_SECS: i64 = 600;
  ```
  In `pull`, the open loop records `malformed = true` for `WireError::Malformed` (keep counting it `unreadable` and noting it). Then:
  ```rust
  let mut report = apply::apply_with(conn, &ops, apply::Waiting::Hold)?;
  let advance = if behind {
      false
  } else if report.held_newer > 0 || malformed {
      note_hold(conn, "newer")?; false
  } else if report.held_waiting > 0 {
      let hold = note_hold(conn, "waiting")?;
      if hold.pulls >= WAITING_PULLS && now_secs(conn)? - hold.since >= WAITING_SECS {
          let released = apply::apply_with(conn, &ops, apply::Waiting::Release)?;
          report.applied += released.applied;
          report.dropped += released.dropped;
          report.moot += released.moot;
          report.held_waiting = 0;
          report.deferred = released.deferred;
          clear_hold(conn)?; true
      } else { false }
  } else {
      clear_hold(conn)?; true
  };
  if advance {
      set_state(conn, PULL_CURSOR, &page.cursor.to_string()).map_err(|e| e.to_string())?;
      // the legacy token-pick conversion stays here, behind an advance only
  }
  ```
  - `RelayOutcome` gains `held_newer` and `dropped` (absorbed from the report); `round_trip` sets `outcome.pulled = report.applied` (new ops only). Update the comment at the old `set_state` site (~1022-1028) to describe the hold.
  - `commands.rs`: `RelayStatus.pull_held: Option<String>` from `read_hold(conn).map(|h| h.kind)` (make `read_hold` `pub(crate)`); `sync_now` passes the new outcome fields through.
  - `live.rs`: if it computes `pulled` or fires on `deferred`, follow `round_trip`.

- [ ] **Step 4: Run and pass**, then the whole crate once, fmt, clippy, and the wasm clippy leg if clang is available.

- [ ] **Step 5: Mutations.** (a) always advance → tests 1, 3 red; (b) drop the `malformed` arm → 3 red; (c) release without the 600 s check → 4 or 6 red; (d) count `skipped` into `pulled` → 2 red.

- [ ] **Step 6: Report** to `.superpowers/sdd/2026-09-27-sync-delivery-holds/task-B-report.md`. Do not commit.

---

### Task C: the mirror and the Sync panel

**Files:**
- Modify: `src/lib/ipc.ts` (`RelayStatus` ~6423; `RelayOutcome` ~6484-6521 and its doc ~6488-6490)
- Modify: `src/lib/ipc.test.ts` (the struct fence rows for `RelayStatus` / `RelayOutcome`; ~3586)
- Modify: `src/features/settings/SyncPanel.tsx` (`outcomeText` ~483-529 and its doc ~467-469; the panel body)
- Modify: `.storybook/fake/db.ts` (the fake's `sync_relay_status` / `sync_now` answers, if modelled)
- Test: `src/features/settings/SyncPanel.test.tsx`

**Interfaces:** Consumes the Rust fields by their camelCase names (Interfaces). **Run no cargo.** `ipc.test.ts`'s fence reads the Rust source; it goes green at fan-in once Task B lands, so run it but expect the two new fields to fail until then — say so in the report.

- [ ] **Step 1: Failing tests** in `SyncPanel.test.tsx` (`toHaveAccessibleName`/`getByText` on whole phrases):
  1. `pullHeld: "newer"` draws exactly `A device in your group runs a newer version of MTG Grimoire. Update this device to receive its changes.`; `"waiting"` and `null` draw nothing.
  2. An outcome with `heldNewer: 2` says `2 changes from a newer version wait until you update.`; `heldNewer: 1` → `1 change from a newer version waits until you update.`
  3. An outcome with `deferred: 3, heldNewer: 0` says `3 changes are waiting for a change they build on.`; `deferred: 1` → `1 change is waiting for a change it builds on.`
  4. `dropped: 2` → `2 changes could not be applied and were skipped. The error log has the details.`; `dropped: 1` → `… and was skipped. …`
  5. The old sentence `They land on a later sync.` appears nowhere (`queryByText(/land on a later sync/)` is null).
- [ ] **Step 2: Run and fail.** `npx vitest run src/features/settings/SyncPanel.test.tsx`.
- [ ] **Step 3: Implement.** Mirror the fields in `ipc.ts` (Interfaces) with doc comments that are true (`deferred` = held for re-delivery; `heldNewer` = held until this device updates; `dropped` = could never apply, logged). Replace the deferred clause in `outcomeText` with the three sentences above, in the order held-newer, waiting (`deferred - heldNewer`), dropped, spelled through the repo's `plural`/`verb` helpers (`src/lib/counts.ts`). Draw the persistent notice from `status.pullHeld === "newer"` near the panel's status line, as a plain paragraph (not an alert). Update the fake's answers to carry `pullHeld: null`, `heldNewer: 0`, `dropped: 0`.
- [ ] **Step 4: Run and pass**: `npx vitest run src/features/settings/SyncPanel.test.tsx src/lib/ipc.test.ts .storybook/fake/db.test.ts` (expect only the Rust-fence rows for the two new fields to wait on Task B), `npx tsc --noEmit -p tsconfig.json`, `npx tsc --noEmit -p .storybook`, `npx eslint` on each touched file.
- [ ] **Step 5: Report** to `.superpowers/sdd/2026-09-27-sync-delivery-holds/task-C-report.md`. Do not commit.

---

### Task D: the record (at fan-in)

**Files:** `docs/reference/sync.md` (the "⚠️ Deferred ops are dropped, not held (open)" section ~1579-1639, the repeat at ~2593-2598, and every PR 2 "dropped" statement about v52 laggards — grep `dropped`, `stall`, `re-deliver`), `src-tauri/CLAUDE.md` (the `sync_peers` watermark bullet and the "Do not 'fix' it by holding the cursor on every deferral" sentence), `docs/reference/decks-storage.md` / `data-and-sync.md` where they say the legacy-pick pull gate "rests on a re-delivery that does not happen", `docs/superpowers/specs/2026-09-26-token-stacks-design.md` and its PR 2 plan (their amendments about the drop).

- [ ] **Step 1:** Rewrite the sync.md section as the record of this design: the classification table, the two bounds and why each exists, the relay cost of a hold (the floor pinned for the length of a newer hold; three pulls for a waiting one), the Malformed arm, what `pull_hold` holds, and the planned-`LIMIT` caveat (a future page limit must page to the end before a hold is evaluated). Keep what is still true about v51 peers (a v51 client still drops; nothing here saves it).
- [ ] **Step 2:** Make every other statement agree: a v52+ receiver now holds a newer sender's changes until it upgrades; the legacy-pick gate now holds for every v52+ laggard; the removed-device ack pin on the relay is a recorded follow-up.
- [ ] **Step 3:** Grep for survivors: `dropped, not held`, `land on a later sync`, `self-heals`, `rests on a re-delivery`. Report to `.superpowers/sdd/2026-09-27-sync-delivery-holds/task-D-report.md`. Do not commit.
