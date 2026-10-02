# Step 6's spike — a sync trip that holds nothing across a request

**2026-10-02, debug build, Windows.** [The light-app spec](../specs/2026-10-01-light-app-android-and-web-design.md)
§2.8 says of the sync client, entitlement and pairing: *"That phase opens with a spike, not a
plan."* This is the spike. It answers one question — **how is a trip restated so that no lock is
held across an `await`** — with a prototype, and lists what else the step owes. The decisions it
leaves to Markus are in §8; [issue #761](https://github.com/Msgaihede/mtg-grimoire/issues/761)
tracks the step.

## 1. What is there today

Every sync operation is one shape, in `commands.rs`, `live.rs` and `pairing.rs` alike:

```rust
sync::with_write(&state, |conn| runtime.block_on(client::run_once(conn)))
```

The write connection's mutex is taken, a runtime is built on a blocking thread, and an `async fn`
that takes `conn: &Connection` runs to its end — its HTTP requests included — with the lock held.
A browser has one thread, no `block_on`, and a lock held across an `await` there is a deadlock.

**The census** (`node scripts/core-step-6-census.mjs .`, over `src-tauri/src`): of 197 functions in the eight
files this step moves, 56 are `async`, and **31 take a connection and hold it across at least one
`.await` — 56 awaits between them.** (Counted before the prototype below; with its three functions
restated the same script reads 28 and 51, and the step is done when it reads none.)

| File | Shipped lines | Inline tests | Functions holding a connection across an await |
| --- | --- | --- | --- |
| `sync_engine/client.rs` | 2 599 | 87 (in `client/tests.rs`, 5 274 lines) | 17 — `fetch_key_page`, `fetch_key_page_at`, `relay_manifest`, `check_keys`, `catch_up`, `post_rotation`, `post_rendezvous`, `get_rendezvous`, `publish_join`, `post_ops`, `push`, `pull`, `ack`, `emit_baselines`, `run_once`, `run_once_without_baselines`, `round_trip` |
| `sync_engine/entitlement.rs` | 976 | 49 | 7 — `post_for_grant`, `access_token`, `refresh_door`, `refused_secret`, `group_door`, `request_group_grant`, `claim` |
| `sync_pair/pairing.rs` | 1 094 | 40 | 7 — `accept`, `confirm`, `poll`, `poll_initiator`, `poll_joiner`, `remove_device`, `leave_group_now` |
| `sync_pair/identity.rs` | 1 384 | 56 | none — synchronous |
| `sync_engine/wire.rs` | 317 | 21 | none |
| `sync_engine/schedule.rs` | 231 | 16 | none — pure over `now_ms` and a jitter |
| `sync_engine/commands.rs` | 486 | 18 | none — the wrappers build the runtime |
| `sync_engine/live.rs` | 714 | 9 | none — but `credentials`, `trip` and `push_now` are the `with_write` + `block_on` callers |

**No transaction or savepoint is open across an await anywhere in them** (read in full, by hand for
`client.rs` and by two read-only subagents for the rest). Every transaction — `apply_held`,
`rebase`, `commit_rotation`, `adopt`, `leave_group`, `store_grant`, `store_access` — opens and
commits synchronously. That is what makes a restatement possible without redesigning the engine.

**A fourth caller is outside the step's list**: `share/commands.rs` runs `with_write(block_on(…))`
over `share::publish::{credentials, list}`, both of which call `entitlement::access_token`.

## 2. The restatement: a stretch at a time, on a lane

Two pieces, and each answers a different interleaving.

**A `Store`.** A function stops taking `conn: &Connection` and takes `db: &impl Store`:

```rust
pub trait Store {
    fn with<R>(&self, f: impl FnOnce(&Connection) -> Result<R, String>) -> Result<R, String>;
}
```

What it reads or writes is a **stretch** — one closure, run to its end with the connection — and
a request is made between two stretches with nothing held. `impl Store for Connection` is
`f(self)`, so a test that hands over a bare connection is a store whose stretches run back to
back, and compiles unchanged. The app's implementation takes the write connection for the
stretch's own length and gives it back.

**A lane.** One async lock on the core's `State` (`platform::sync::Lock`, which is
`tokio::sync::Mutex` on every host and may be held across an `await`), taken for the whole of each
sync operation. Today the write lock does this job by accident: two trips, a trip and a pairing
confirm, a claim and a leave cannot interleave because all of them hold the one connection. With
stretches they could, and the analysis below found five ways that corrupts a group. The lane keeps
"one sync operation at a time" and gives up only "no user write during it".

**The two fit together as a type**, which is the fence: the app's `Store` is implemented for a
guard that can only be built by taking the lane — `state.lane().await` — and not for `State`
itself. A stretch on the app's database outside the lane does not compile.

**What can newly happen is exactly one thing**: an ordinary user write — a deck edit, a collection
add, each of which appends to `sync_ops` and moves `sync_clock` — lands *between two stretches* of
an operation. Everything in §4 is about that.

## 3. What was measured

The prototype is on `claude/light-app-core-step-6-spike`: the trait, both implementations, and
`ack`, `post_ops` and `emit_baselines` restated over it, in place in `src-tauri`.

1. **The 87 tests in `client/tests.rs` pass with no edit**, over the three restated functions and
   the fourteen that still take a connection and call them (`cargo test -p mtg-grimoire --lib
   sync_engine::client`: 88 passed, the 88th being the new one). `cargo clippy --workspace
   --all-targets --locked -- -D warnings` is clean.
2. **A lock held across a request is a compile error, and the compiler names the line.**
   `fn sendable<T: Send>(_: T) {}` over the trip's future, never called: a `MutexGuard` is not
   `Send`, so a future that keeps one across an `.await` is not either. A deliberately wrong
   function was compiled to see it:

   ```
   error: future cannot be sent between threads safely
     = help: within `impl Future<Output = ()>`, the trait `Send` is not implemented for
             `std::sync::MutexGuard<'_, Connection>`
   note: future is not `Send` as this value is used across an await
   2670 |     let conn = state.lock_db();
   2671 |     let _ = http().get("http://x").send().await;
        |                                           ^^^^^ await occurs here, with `conn` maybe used later
   ```

   So the spec's rule needs no text sweep: one never-called function per entry point is the fence,
   on the native hosts, over the same code the browser compiles.
3. **A user write between two stretches loses a change if two reads that belong together are
   split — and does not if they are one stretch.** `a_write_anywhere_in_a_baselines_emission_reaches_the_peer`
   drives `emit_baselines` through a test double that lets the reader add a copy behind stretch
   *n*, for every *n* the emission has, and then has the peer read the baseline and the later op in
   one page.

   | `baseline::build` and `baseline::horizon` | Stretches | Result |
   | --- | --- | --- |
   | one stretch each — the original statements, one closure apiece | 6 | **red**: `behind stretch 4: 3 here, 2 there`, and green behind the other five |
   | one stretch for both, with the clock | 4 | green behind every one |

   The horizon says how far each device's ops are already inside the rows. A write between the two
   reads is inside the horizon and outside the rows, so the peer is handed neither the value nor —
   the horizon filtering it — the delta, with its cursor past both.

**What the test does not show, and why it is shaped as it is.** Two things about `apply` decide
what a baseline test can assert, and neither is this step's:

- A peer that has **never held the row** meets a claim and a later delta as `max(Σ deltas, claim)`
  — an under-count the baseline spec accepts on purpose (§8.2, *"the window between emission and
  delivery"*). So the test's peer already holds the row, as every peer does when it is baselined
  again behind a join.
- ⚠️ **A baseline op stamped at or below the watermark the peer already holds for its sender is
  skipped as seen, while the horizon it carries still filters the delta** — so an edit made in the
  same second the peer last heard from this device is lost on that peer. **Reproduced on code this
  branch did not touch**: the add and the edit in one second, *dev-a holds 3, dev-b holds 2,
  `skipped: 3`*; the add ten seconds earlier, *3 and 3*. It is a bug in `apply`, not in the trip,
  and it is filed as its own task rather than fixed here. The test backdates its first add by ten
  seconds to stand clear of it.

## 4. Every operation, by what may interleave

**User writes.** Of the 31 functions, the ones that read user tables or the op log are four, and
the rule for each is which reads must share a stretch:

| Function | What must be one stretch | Why |
| --- | --- | --- |
| `emit_baselines` | `baseline::build` + `wall_ms` + `baseline::horizon`, per peer | §3's measurement |
| `push` | each of: read the outbox; `stamp_pushed` for one chunk; `rebase` (already one transaction) | A write behind the outbox read is a row with a higher `seq`: not in this trip's snapshot, pushed by the next. `stamp_pushed` names `seq`s, and nothing a reader presses rewrites a `sync_ops` row. |
| `pull` | everything behind the response — the watermarks, `apply_held`, the hold, the release, the cursor, both conversions, `last_op` before and after | It is one run of statements with no await in it already. The envelope loop has one await, `fetch_key_page`, at most once: asked before the loop instead, the loop is one stretch too. |
| `ack` | the cursor and `last_acked`, read together; the mark written with the cursor that was *sent* | |

A write that lands during a request is, to `apply`, a local write made just before the trip: it is
in `sync_ops` with its own stamp when the page is folded. Nothing else in the trip reads a user
table.

**Entitlement and pairing read no user table at all.** They touch `sync_state`'s grant keys,
`sync_group`, `sync_devices`, `sync_identity` and `device_names`, and no deck, collection or
wishlist write reaches any of those. One cosmetic exception: `confirm` writes the device's name
back from a value read before its request, which reverts a `sync_device_rename` pressed in
between in one column the roster does not prefer.

**Other sync operations — what the lane is for.** Without it:

| Pair | What breaks |
| --- | --- |
| `confirm` × a trip's `adopt_epoch`, a removal or a leave | `join_group` writes the group it read before its request: the epoch rolls back with the old key, the superseded keys and the last manifest are forgotten, or a group that was just left is re-created |
| plan → `/rotate` → `commit_rotation` × `confirm` or `poll`'s `complete` | the manifest published omits the device that joined in between, which evicts it |
| plan → `/rotate` → commit × a trip | the trip adopts this device's own rotation first, `supersede` sees "not one ahead" and forgets the key — a join that costs its backlog |
| a commit × `leave_group_now` | `commit_rotation` re-creates `sync_group` with no roster |
| `access_token` or a sync route's 401 × `claim` | `revoke` wipes the grant just claimed and the panel says *Membership ended* over a new pledge; or the superseded refresh secret is written back over the new one |
| `access_token` or `claim` × a leave or a removal notice | the store after the request resurrects a grant on a device that left |

**On the lane**: a trip (with the `check_keys`, `publish_join`, `access_token` and `removed` inside
it); `access_token` asked from outside a trip (`live::credentials`, and `share`'s two callers);
`claim`; `confirm`; the `complete` half of `poll`; `remove_device`; `leave_group_now`.
**Not on it**, because each is one stretch with no request: `sync_device_rename`, the status and
review reads, `sync_patreon_begin`, `sync_pairing_begin`, `sync_pairing_cancel`.

**The pending offer** (`AppState.pairing`, a std mutex held across the request today) becomes an
async lock on `State`, taken before the lane. That keeps the two things the held mutex gives now:
a cancel waits behind an in-flight `accept` and wins, and two polls — two windows with Settings
open — cannot both pass `spent` and both run `complete`.

## 5. Where holding the lock was load-bearing, and what replaces it

1. **The write that records an answer the relay will not repeat cannot be refused today.** Taken
   for the whole operation, the lock is already in hand when the answer arrives. Through the
   bounded `with_write` (5 s, then `db::BUSY`) a stretch behind a request could be turned away:
   after `/claim`'s 200 the code is spent and the refresh secret is never stored; after
   `/p/{rv}/offer`'s 204 on a founding device the new group's id and key exist only on the stack,
   and the joiner ends up alone in a group nobody local wrote; after `/rotate`'s 2xx the commit is
   lost (that one heals, a trip late). **So a stretch waits for the connection, as a departure
   does today**, and a press keeps today's five-second answer by asking for the connection once,
   bounded, *before* it starts. Nothing can hold the connection across a request once this lands,
   so what a stretch waits behind is bounded local work.
2. **"A trip always ends" becomes the lane's liveness, and it is false in a browser today.** The
   desktop's requests have a ten-second connect bound and a per-read bound; `platform::http`'s
   browser arm has neither, so one hung `fetch` would hold the lane for good and a leave behind it
   would never run. `reqwest`'s wasm backend does take a per-request `timeout` (`AbortController`;
   read in `reqwest-0.12.28/src/wasm/request.rs`), so `platform::http` can give every relay request
   a deadline on the host that has no socket to bound. This also closes the open item step 5 left:
   *nothing gives a feed request a deadline in a browser*.
3. **`with_write`'s tail — arm the managed wishlists, reconcile tokens, settle — runs once per
   operation today and once per stretch after.** The same work in more, smaller pieces, and the
   reconcile's captured deletes land before a baseline is built rather than after the ack. The
   test store is a bare `f(self)` and runs none of it, as the fixtures hold no such tables.
4. **A trip's future can be dropped between two stretches** — the exit push's `tokio::time::timeout`
   cannot cancel today's blocking thread and could cancel an async one; a browser tab can close.
   That is what a kill is today, and every stretch boundary is already a place a network failure
   can end a trip: a chunk is stamped only after it landed, a baseline's marker only after all of
   it, the cursor in the same stretch as the apply.

**What the reader gets on the desktop**, beyond the browser being possible at all: a deck edit no
longer waits behind a slow sync, or answers *"The card database is busy finishing a sync"* after
five seconds of one; and the exit checkpoint no longer has to step around a push that is stuck in
a request with the connection in hand.

## 6. What stays the desktop's

- **`live.rs`'s connection manager** — `tokio::select!`, `tokio-tungstenite`, the `AppHandle`. A
  browser cannot set a header on a `WebSocket` and starts without the doorbell (spec §7), so the
  loop has no second host yet. What is pure goes with the core: `schedule.rs` whole, the `head`
  frame rule, the socket URL, the 4001 classification, the outbox question.
- **Every `#[tauri::command]`**, as for each moved module: the wrapper, `spawn_blocking`, the
  `changes.mark_table` calls. The desktop goes on driving a trip with `block_on` on a blocking
  thread — a stretch is SQLite work and belongs off the async workers — and only the lock moves
  inside.
- **`share::publish`** stays where it is and is not restated; its two calls to `access_token` take
  the lane.

## 7. What the move owes `platform`

| Need | For |
| --- | --- |
| `http`: `post`, `Request::body`, `Response::text`, a per-request deadline | every relay request; today it is `GET` and `bytes` |
| a device's own name | `identity::mint_name` reads `COMPUTERNAME` / `HOSTNAME` behind `cfg!(windows)` — a platform gate and `std::env`, both refused by the fence |
| `clock::now_ms` | `pairing::now_ms`'s `SystemTime` |
| the test client | `client.rs` and `entitlement.rs` each memoise one `reqwest::Client` under `#[cfg(not(test))]` and build one per call under `#[cfg(test)]` — a gate that goes dark when another crate's tests link the core, so it becomes the core's `testing` feature |

**Not this step's, and each a relay deploy that is Markus's to run** (spec §7): CORS — every sync
request is a JSON `POST` or carries a bearer, so each needs a preflight the relay does not answer
today — and a socket ticket. `pull` is unpaged; what a page of tens of megabytes costs a Worker is
the browser phase's measurement.

## 8. Decided here, and left to Markus

**Decided by the measurements above**: rows and horizon in one stretch; a stretch waits where a
press's first ask is bounded; the lane is a type; `live.rs` and the wrappers stay; the pending
offer is an async lock.

**His to decide**:

1. **The shape** — stretches on a lane (prototyped, 87 tests unchanged), against a rewrite into
   explicit plan / request / commit functions, against keeping the desktop's trip and writing the
   browser's separately.
2. **What "leaving is always possible" means once the lock is a lane** — wait for the lane as the
   press waits for the connection today, with every request given a deadline on every host; or
   give up on the lane after a bound and clear anyway, which needs every commit stretch of every
   other operation to re-check that the group is still the one it started with.
3. **How many pull requests** — restate in place and then move, or one.
