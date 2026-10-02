# The shared core, step 6: the sync client, entitlement and pairing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** no sync operation holds the write connection across a network request, on any host, and the modules that sync — the client, the entitlement, pairing and the identity under it — are the core's, with the desktop app behaving as it does today.

**Architecture:** every `async fn` that took `conn: &Connection` takes `db: &impl Store` and reaches the database inside `db.with(|conn| …)` — a *stretch* — with each request made between two stretches. One async lock on the core's `State`, the *lane*, is held for the whole of each sync operation, and the app's `Store` is the guard that lock hands out, so a stretch on the app's database outside the lane does not compile. The step lands as **two pull requests**: 6a restates the code where it is, in `src-tauri`, under the tests it already has; 6b moves it by script.

**Tech Stack:** Rust (the workspace's pinned toolchain); `tokio::sync` through `platform::sync`; `reqwest` (directly in 6a, through `platform::http` from 6b); `httpmock` for every relay test.

**Spec:** [`docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md`](../specs/2026-10-01-light-app-android-and-web-design.md) §2.8 (*"That phase opens with a spike, not a plan"*) and §7. **The spike:** [`docs/superpowers/research/2026-10-02-light-app-step-6-sync-trip-spike.md`](../research/2026-10-02-light-app-step-6-sync-trip-spike.md) — every measurement this plan leans on is there. **Tracking issue:** Msgaihede/mtg-grimoire#761, phase 2, step 6. **The rules for a moved module:** [`crates/grimoire-core/CLAUDE.md`](../../../crates/grimoire-core/CLAUDE.md), *Moving a module here*.

## Decisions taken before any code — Markus, 2026-10-02

| Question | Answer |
| --- | --- |
| The shape | **Stretches on a lane** — over a rewrite into plan / request / commit functions, and over a separate browser trip |
| *Leave group is always possible* | **It waits for the lane**, as it waits for the connection today, and every relay request ends on every host |
| Pull requests | **Two: restate, then move.** Auto-merge and auto-fix on each |

## Global Constraints

- **No agent provisions or deploys anything.** The relay is untouched by this step; CORS and a socket ticket are Markus's deploys, in the web phase.
- **Every relay test is against `httpmock`, never a deployed Worker**, and no test or fixture carries `PATREON_CLIENT_SECRET`, `PATREON_WEBHOOK_SECRET` or `RELAY_HMAC_KEY`.
- **Nothing a request sends changes**: the same routes, headers, bodies and order of requests within a trip.
- **The existing tests are the proof and are not rewritten**: the 296 inline tests of the eight files keep their bare connections (`impl Store for Connection`, test builds only). A test changes only where its *call* does — a command wrapper's shape, a signature that gained a parameter.
- **Never `cargo fmt --all`** (`-p grimoire-core -p mtg-grimoire`); never two cargo runs at once in one tree; merge `main`, never rebase.
- **Nothing is hoisted**: 6a moves no file. `Store`, the lane and their tests are new code in the core, because `State` is.

## Review Focus

1. **A user write between two stretches of a trip.** The reader edits a deck while a sync is in flight; the edit must reach the group on the next trip and nothing the trip was doing may be lost. Pinned by a test that lands a write behind *every* stretch of a whole round trip (Task 3).
2. **A baseline's rows and its horizon read apart.** Measured red in the spike; pinned by `a_write_anywhere_in_a_baselines_emission_reaches_the_peer` (already on the branch).
3. **Two sync operations at once.** A confirm, a rotation's commit, a claim and a leave corrupt each other five ways without the lane (spike §4). Pinned by the type — `Store` is not implemented for `State` — and by a test that a second operation waits for the first (Task 1).
4. **A write that records an answer the relay will not repeat.** `/claim`'s grant, a founding `confirm`'s group, `/rotate`'s commit: a stretch waits for the connection and never answers `db::BUSY` (Task 1's `Lane::with`).
5. **Leave group behind a trip in flight.** It must wait and then clear, whatever the trip answered. Pinned by a test that holds the lane, presses leave, and lets go (Task 5).

---

# Part 6a — restate in place

Branch `claude/light-app-core-step-6a`. Done when `node scripts/core-step-6-census.mjs .` counts no function holding a connection across an `.await`, and no `with_write` + `block_on` pair is left in `sync_engine/` or `sync_pair/`.

### Task 1: `Store` and the lane, in the core

**Files:**
- Modify: `crates/grimoire-core/src/state.rs` — `Store`, `Lane`, `InHand`, `State::{lane, lane_for_press}`, the private `lane` field
- Modify: `crates/grimoire-core/src/platform/sync.rs` — nothing if `Lock` serves as it is
- Test: `crates/grimoire-core/src/state.rs` (inline)

**Interfaces — produces:**

```rust
/// How a sync operation reaches the database: inside `with`, never across an `.await`.
pub trait Store {
    fn with<R>(&self, f: impl FnOnce(&Connection) -> Result<R, String>) -> Result<R, String>;
}
#[cfg(any(test, feature = "testing"))]
impl Store for Connection { /* f(self) */ }

/// The lane, held: one sync operation at a time. The app's `Store`.
pub struct Lane<'a> { /* &'a State, platform::sync::Held<'a> */ }
impl Store for Lane<'_> { /* state::with_write_waiting(self.state, f) */ }
impl<'a> Lane<'a> {
    pub fn state(&self) -> &'a State;
    /// A connection its caller already holds, as a store — for the one caller that still does
    /// (`share::publish`). Built from the lane, so the lane is held.
    pub fn in_hand<'c>(&self, conn: &'c Connection) -> InHand<'c>;
}
pub struct InHand<'c>(&'c Connection);
impl Store for InHand<'_> { /* f(self.0) */ }

impl State {
    /// For an operation that waits its turn: a background trip, a departure.
    pub async fn lane(&self) -> Lane<'_>;
    /// For a press: its turn within `db::WRITE_LOCK_WAIT`, and the connection answering within
    /// the same bound, or `db::BUSY` — what a press during a sync has always been told.
    pub async fn lane_for_press(&self) -> Result<Lane<'_>, String>;
}
```

- [x] Write the tests first: `a_second_operation_waits_for_the_first` (take the lane, spawn a second `lane()`, assert it has not resolved, drop, assert it has); `a_press_behind_a_sync_or_a_busy_connection_is_told_busy` (`lane_within` with a 40 ms bound — the bound is an argument, so no paused clock is needed — behind a held lane, and behind a connection another thread holds); `a_stretch_is_a_user_facing_write` (a `Lane::with` arms the managed wishlists on the connection — it goes through `with_write_waiting`); `an_operation_over_the_lane_holds_nothing_across_an_await` (`fn sendable<T: Send>` over a future that makes two stretches around an `.await`); `a_connection_in_hand_is_used_where_it_stands`; `a_bare_connection_is_a_store_whose_stretches_run_back_to_back`. **Two of them first held the connection's guard across an `.await` and clippy's `await_holding_lock` refused them** — a second fence nobody had planned on.
- [x] Implement; `State::new` builds the lock and takes no new argument.
- [x] `cargo test -p grimoire-core state::` and both clippies (workspace, wasm32).
- [x] Commit: `feat(core): a store a sync operation reaches a stretch at a time, on a lane`.

### Task 2: the client over `Store`

**Files:**
- Modify: `src-tauri/src/sync_engine/client.rs` — the fourteen functions the spike left: `fetch_key_page`, `fetch_key_page_at`, `relay_manifest`, `check_keys`, `catch_up`, `post_rotation`, `post_rendezvous`, `get_rendezvous`, `publish_join`, `push`, `pull`, `run_once`, `run_once_without_baselines`, `round_trip`; the spike's local `Store` trait and its `impl … for State` are deleted for the core's
- Test: `src-tauri/src/sync_engine/client/tests.rs` — unchanged but for the import

**The stretches, per function** (spike §4 has the reasons):

| Function | Stretches |
| --- | --- |
| `fetch_key_page_at(db, base, device, group, at)` | the request; then one stretch for whichever of `note` / `latch_removal_step` its answer owes |
| `check_keys` | `me` + `base`; `fetch_key_page`; then **one** stretch for the whole decision when no walk is owed (`removed`, or `adopt_page`, with its failure's `note`); with a walk, `catch_up` and then that stretch |
| `catch_up` | per epoch: read the group; request; adopt |
| `post_rotation(db, rotation)` | read the group and `base`; request; `note` on failure |
| `post_rendezvous`, `get_rendezvous` | read `base`; request; `note` on failure |
| `publish_join` | `plan_join` (and the dirty mark when it refuses); `relay_manifest`; `post_rotation`; **one** stretch for `commit_rotation` + clearing the mark |
| `push` | `me`; per round: read the outbox; per chunk: `post_ops`, then `stamp_pushed`; `rebase` is one stretch |
| `pull` | `me` + cursor + the hold's `noted`; the request; **the `/keys` ask moves ahead of the envelope loop** (asked when any envelope is above the epoch in hand — the same condition, once per pull); then **one** stretch from `group_at` per envelope to `last_op` |
| `round_trip` | each `me`, `roster_is_dirty` and the closing `LAST_SYNC_AT` is a stretch; `through` — the newest op there is — is read ahead of the push; everything else is the callee's |
| `emit_baselines(db, base, token, through)` | per peer, **one**: whether an op above `through` is pending, the rows, the clock, the horizon. Pending, and no baseline is begun this trip (Task 3 found it) |

- [x] Restate, function by function, compiling as it goes (`cargo check -p mtg-grimoire --tests`).
- [x] `sendable` over `run_once`, `run_once_without_baselines`, `check_keys`, `publish_join`, `post_rotation`, `post_rendezvous`, `get_rendezvous` taking a `&Lane`.
- [x] `cargo test -p mtg-grimoire --lib sync_engine::client` — the 88 pass.

### Task 3: a write behind every stretch of a whole trip

**Files:** Test: `src-tauri/src/sync_engine/client/tests.rs`

- [x] `a_write_anywhere_in_a_round_trip_is_carried_by_the_next` — `dev-a` holds a card, pending, and owes `dev-b` a baseline; behind stretch *n* of `run_once`, for every *n*, the reader adds a copy; a second `run_once` follows. `dev-b` pulls after each trip and applies what the mock relay was pushed, in order. Assert `dev-b` holds what `dev-a` holds, `dev-a`'s outbox is empty and the baseline's marker is set.
- [x] `a_write_anywhere_beside_a_pull_is_counted_once_on_both_devices` — the same with a page to pull (`dev-b`'s own copy of the same row), asserting both devices end at four.
- [x] Run; a red here is a stretch boundary in the wrong place — fix the boundary, not the test. **It was red**: `3 here, 4 there` behind every stretch between the push's outbox read and the baseline's rows. The fix is `emit_baselines`' `through` (above), and the mutation — the rule switched off — is red at exactly those boundaries.
- [x] Both tests add their first copies "ten seconds ago": a baseline op stamped at or below the watermark the peer already holds is skipped by `apply`, which is a bug of its own and not this step's (the spike's §3).

### Task 4: the entitlement over `Store`

**Files:** Modify: `src-tauri/src/sync_engine/entitlement.rs`

| Function | Stretches |
| --- | --- |
| `post_for_grant(base, path, body)` | none — it takes the base its caller read |
| `access_token(db)` | **one**: the secret, the group, the stored token and its expiry, `now`, and — only when a request is owed — `base` and `this_device`; then the door |
| `refresh_door` | the request; on a grant, `store_grant` + `store_status` in one stretch; on a 401, `refused_secret` |
| `refused_secret` | one stretch: read the group, and `revoke` when there is none; the request; one stretch: `revoke`, or `keep_group_grant` + deleting the secret |
| `group_door` | the request; one stretch: `keep_group_grant`, or `revoke` |
| `claim(db, code)` | one: the group, `base`, `this_device`; the request; one: `store_grant` + `store_status` |

- [x] Restate; `sendable` over `access_token` and `claim`.
- [x] `cargo test -p mtg-grimoire --lib sync_engine::entitlement` — its 49 pass unedited.
- [x] Commit: `refactor(sync): the entitlement reaches the database a stretch at a time`.

### Task 5: pairing over `Store`, and the pending offer on an async lock

**Files:**
- Modify: `src-tauri/src/sync_pair/pairing.rs` — `accept`, `confirm`, `poll`, `poll_initiator`, `poll_joiner`, `remove_device`, `leave_group_now`, and the nine wrappers
- Modify: `src-tauri/src/sync/mod.rs` — `AppState.pairing: tokio::sync::Mutex<Option<Pending>>`
- Modify: `src-tauri/src/desktop.rs`, `mirror/watch.rs`, `update.rs` — the three places that build an `AppState`

| Function | Stretches |
| --- | --- |
| `accept` | `ensure` + `base`; the request; the pending offer is memory |
| `confirm` | `ensure`, `room_for` and the group, each where its statement stood, so every refusal comes in the order it did; the request; **one**: `ensure` again, `found_group` / `join_group` + `add_device` — the name written is the one this device holds *now*; then `publish_join` |
| `poll` | `ensure`; the request; `respond` or `complete` as one stretch |
| `remove_device` | `entitled`; the trip; one: the dirty mark, `removal_step`, the plan; `post_rotation`; `commit_rotation` |
| `leave_group_now` | one: the in-a-group check, `removal_step`, the plan; `post_rotation`; **one**: `leave_group` + `entitlement::clear` |

**The wrappers**: `sync::on_a_worker(|| async { pending → lane → the function })` — a blocking worker with a runtime of its own, written once in `src-tauri/src/sync/mod.rs`. A press takes `lane_for_press`; `sync_group_leave` takes `lane`. `sync_pairing_cancel` takes the pending lock alone, and is an `async fn` for it: an async lock is awaited, and `blocking_lock` panics on the runtime's own thread.

- [x] Write `leaving_waits_for_an_operation_in_flight_and_then_clears` first: hold the lane, start `leave_group_now` behind `state.lane()`, assert the group is still there, release, assert it is gone and the grant with it.
- [x] Restate; `sendable` over the five entry points.
- [x] `cargo test -p mtg-grimoire --lib sync_pair` — its tests pass with their calls unedited.
- [x] Commit: `refactor(sync): pairing reaches the database a stretch at a time`.

### Task 6: the callers

**Files:** Modify: `src-tauri/src/sync_engine/commands.rs` (`sync_now`, `sync_patreon_claim`), `src-tauri/src/sync_engine/live.rs` (`credentials`, `trip`, `push_now`), `src-tauri/src/share/commands.rs` and `share/publish.rs` (the lane first, then `with_write`; `credentials` and `list` take the store their token is asked through), `src-tauri/src/desktop.rs` (the exit push's comment), `crates/grimoire-core/src/state.rs` (`with_write_waiting`'s doc)

- [x] `live::trip` and `push_now` take `lane()`; `sync_now` and the claim take `lane_for_press()`; each records its failure in a stretch of its own after the trip.
- [x] `share`: `on_the_write_connection` takes the lane, then the connection, and hands `lane.in_hand(conn)` down as `tokens`, which `publish`, `refresh`, `revoke` and `list` take beside `conn`.
- [x] `node scripts/core-step-6-census.mjs .` reads `held: 0, blocking: 0`, and `scripts/core-step-6-census.test.mjs` holds the eight files there.
- [x] Commit: `refactor(sync): every sync operation takes the lane`.

### Task 7: verify, record, ship

- [x] Every Rust gate and the frontend's build, lint and suite. **No A/B upgrade check against `main`'s binary**: nothing here touches a schema rung, a launch pass or a file, so there is no upgrade to compare.
- [x] A live pass in `tauri dev` **against a mock relay on the loopback only** — never Markus's group: the dev copy was checked to be in no group and to hold no grant, its `relay_url` pointed at `127.0.0.1`, and its files copied aside and put back. A claim, a trip, a write and a second press during a slow trip, a departure during a slow trip, and the pairing commands. `docs/reference/sync.md` has the table.
- [ ] A fresh reviewer subagent (Opus, read-only) on the branch's diff.
- [ ] Docs: `docs/reference/sync.md`, `docs/reference/light-app.md` §6.8, `src-tauri/CLAUDE.md` (*Hard rules — pairing*, *— sync*: the leave bullet, the `with_write` + `block_on` sentences), `crates/grimoire-core/CLAUDE.md`, the spec's §2.8 note, the spike's §8.
- [ ] PR linked to #761, auto-merge and auto-fix; #761's 6a line.

---

# Part 6b — the move

Branch `claude/light-app-core-step-6b`, from `main` once 6a has merged. Its tasks are written out when 6a lands, because what 6a's review changes decides them; what is known now:

- **`platform::http`** gains `Client::post`, `Request::body`, `Response::text`, and a per-request deadline honoured where the host has no socket to bound (`reqwest`'s wasm `timeout`). Two relay clients, as today: the sync client's (30 s per read) and the entitlement's (10 s).
- **`platform`** gains a device's own name (`COMPUTERNAME` / `HOSTNAME` natively; a word in a browser) for `identity::mint_name`, and `pairing::now_ms` becomes `platform::clock::now_ms`.
- **The test client** — one `reqwest::Client` memoised in the app and built per call in a test — is gated on the core's `testing` feature rather than on `cfg(test)`, which goes dark when another crate's tests link the core.
- **Moved by `scripts/core-step-6b.mjs`**: `sync_engine/{client, entitlement, wire, schedule}`, `sync_pair/{identity, pairing}`, and the plain functions of `sync_engine/commands` (`read_status`, `review_count`, `read_review`, `supporter_status`, `entitled`, `begin_authorize`, `ensure_group`, the DTOs). `State` gains the pending offer.
- **Stays**: `live.rs`'s connection manager and every `#[tauri::command]` wrapper; `share::publish`.
- **Fences that read these files by path** move with them: `ipc.test.ts`'s `?raw` imports, the Rust tests that read `relay/src/*.ts` and `src/lib/*.json`.
