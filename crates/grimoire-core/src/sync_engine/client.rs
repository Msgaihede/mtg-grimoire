//! Push, pull, and how often.
//!
//! # What ships: the socket, not a poll
//!
//! **There is no poll and there never was.** This doc used to plan one — pull on open, pull
//! every 60 s while the window has focus, push 2 s after the write mask goes quiet — and named
//! a reason the alternative, a WebSocket, was not built: a socket opened **from the page** would
//! need the CSP widened. That was true and was not the obstacle it looked like, because the
//! socket that shipped is opened from **this process**, not from the page: `src-tauri`'s `sync_engine::live`'s
//! connection manager holds a `tokio-tungstenite` client alongside the `reqwest` connection to
//! the relay this file already made.
//! ⚠️ **Neither of those is "under" the CSP, and the phrasing this doc carried for a day said
//! they were.** A Content-Security-Policy governs what the *webview* may fetch; a native HTTP or
//! WebSocket client in the Rust process is outside its reach entirely — exempt, not permitted.
//! The claim that matters is unchanged and is the stronger one: `tauri.conf.json` was not edited,
//! and nothing was granted to the page. The blocker did not survive contact with where the socket
//! actually lives; see the design spec §3 for the fuller argument, including a reason the record
//! never had: the webview's own `WebSocket` cannot set an `Authorization` header, and this one
//! does.
//!
//! **What runs**: a hibernatable WebSocket at `GET /g/{group}/ws`, held open for as long as the
//! app is entitled-or-paired and in a group. It carries no card data — on every push the Durable
//! Object sends the group's other sockets a `{"t":"head","cursor":N,"from":"<device>"}` doorbell,
//! and a device that hears one runs exactly the HTTP round trip already in this file
//! ([`run_once`]), the same one the **Sync now** button has always called. A frame is a hint and
//! never a fact: it only ever brings a trip *forward*, never substitutes for one.
//!
//! **All the timing lives in [`super::schedule`], as a pure function of an explicit clock with no
//! I/O**, and it comes down to two debounces. [`super::schedule::FRAME_DEBOUNCE_MS`] (1 s)
//! coalesces a burst of `head` frames — a 50 000-row import is 250 sequential pushes and
//! therefore 250 frames, and the receiving peer must react once, not 250 times.
//! [`super::schedule::WRITE_DEBOUNCE_MS`] (3 s) waits out a local write and slides on every
//! commit, so a transaction that keeps writing for a minute pushes once, at the end — armed off
//! the write connection's `commit_hook` (`live::WriteWake`, an observer of the core's
//! installer), for the reason `db.rs`'s `CrossFileFence` doc gives: the
//! update hook the mirror uses does not fire for `WITHOUT ROWID` tables, and two of the thirteen
//! synced ones are exactly that.
//!
//! **That hook fires for every transaction, so the debounce is armed only after the outbox has
//! been asked** — `sync_ops WHERE pushed_at IS NULL`, in `live`'s `outbox_has_work`.
//! Spec §6.3 states it as two halves and both are load-bearing: without the second, [`run_once`]
//! stamping [`LAST_SYNC_AT`] at the end of every trip would arm the debounce that runs the next
//! trip, for ever, and the Scryfall ingest's commit per 2 000 rows would ring the relay's
//! doorbell as loudly as a deck edit. Every wake — a frame, a local write, launch, reconnect,
//! exit — feeds one single-flight queue, so at most one round trip is ever in flight and the rest
//! coalesce into it rather than queuing a second.
//!
//! What is lost against instant delivery is nothing measurable in practice: "within a few
//! seconds, always" is the design's own bar (spec §2), and the two debounces above are what holds
//! the request count down without missing it. See `src-tauri`'s `sync_engine::live` for the connection manager
//! itself — when it opens a socket, the jittered reconnect backoff, and the protocol ping that
//! keeps a hibernating socket alive for free.
//!
//! # A trip holds nothing across a request
//!
//! **Every `async fn` here takes `db: &impl Store` and reaches the database a *stretch* at a
//! time** — `db.with(|conn| …)`, one closure run to its end — with each request made between two
//! stretches. A trip used to be handed the write connection for its whole length by a caller that
//! blocked a thread on it, which kept every other writer out for the length of a round trip and
//! cannot be done at all where there is one thread. The app's store is the guard of the sync
//! *lane* (`crate::state::Lane`): one sync operation at a time, which is what the
//! held connection used to give by accident.
//!
//! **What can land between two stretches is a reader's own write**, and three places are shaped
//! by it: [`emit_baselines`] reads a baseline's rows and its horizon, and names its emission, in
//! one stretch, and begins none while such a write — or anything else — is pending; [`push`]
//! sends the outbox as it stood when it read it, and what was written since goes with the next
//! trip; [`pull`] opens, applies and moves its cursor in one. The record, with the test that
//! lands a write behind every stretch of a trip, is
//! `docs/superpowers/research/2026-10-02-light-app-step-6-sync-trip-spike.md`.

use crate::errors::{self, Kind, Source};
use crate::platform::http;
use crate::state::{Lane, Store};
use crate::sync_engine::apply::{self, ApplyReport};
use crate::sync_engine::baseline;
use crate::sync_engine::capture;
use crate::sync_engine::emission;
use crate::sync_engine::entitlement;
use crate::sync_engine::hlc;
use crate::sync_engine::merge::{Emission, Op};
use crate::sync_engine::wire::{self, Envelope, WireError};
use crate::sync_pair::crypto;
use crate::sync_pair::identity::{self, Group};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// The `sync_state` key holding the relay's base URL — now a **test/dev override with no UI**,
/// read by [`entitlement::base`], which falls back to the compiled-in [`entitlement::RELAY_BASE`].
///
/// It is empty on every installation that predates the hosted relay, and a blank is not an
/// override. **"Sync is off" has moved off this key**: it is now "no entitlement", which
/// [`entitlement::access_token`] answers `Ok(None)` to.
pub const RELAY_URL: &str = "relay_url";

/// How far this device has consumed the relay's log. The relay's `seq`, not a clock.
///
/// **One group's `seq`**: it is an `AUTOINCREMENT` per Durable Object, which is one per group, so
/// `identity::forget_log_position` deletes this, [`LAST_ACKED`] and [`PULL_HOLD`] whenever the
/// group changes. Carried across, it asks the next group's log from a row it never reached.
pub const PULL_CURSOR: &str = "pull_cursor";

/// The cursor this device last successfully handed to `/ack`.
///
/// **Separate from [`PULL_CURSOR`], and the separation is the whole point.** The relay answers
/// a pull with the head of the *whole* log — including rows this device wrote, which `since`
/// filters out of `envelopes` — so a device that pushes and then pulls gets an empty page and
/// a higher cursor. Skipping the ack on "no envelopes" would mean the writing device never
/// acks, its stored ack stays at its founding value, and `compact`'s floor pins there: nothing
/// is ever compacted, for the life of the group, silently.
///
/// Written only after the relay took it, so a refused ack is retried on the next trip.
pub const LAST_ACKED: &str = "last_acked";

/// When the last complete round trip finished, in unix seconds.
pub const LAST_SYNC_AT: &str = "last_sync_at";

/// Why [`PULL_CURSOR`] is being held, as `{"kind":"newer"|"clock"|"waiting","since":<unix
/// seconds>,"pulls":<n>,"blocks":{"<device>":[<ms>,<ctr>]},"noted":[["<device>",<ms>,<ctr>]]}`;
/// absent when it is not. [`pull`] writes it, the Sync panel reads its kind
/// (`RelayStatus::pull_held`), and `identity::forget_log_position` deletes it with the group,
/// beside [`PULL_CURSOR`]. Spec 2026-09-27 §3.3.
///
/// **A hold costs the relay**, which is why each kind is bounded by what can still resolve it:
/// the relay compacts nothing above this device's ack, the ack follows the cursor, and every pull
/// re-downloads everything above it. `"newer"` — a device on a newer schema wrote something this
/// build cannot apply — has no bound, because updating this device resolves it and the panel
/// asks for exactly that. `"clock"` — a device's ops stamped more than [`hlc::MAX_AHEAD_MS`]
/// ahead of this device's wall clock — **is bounded by time itself**: it resolves when this
/// device's clock comes within `MAX_AHEAD_MS` of the stamp, with nobody pressing anything, and
/// until then it costs the relay what every hold costs. Held rather than applied, because
/// applying an op obliges this device's clock to pass it, and a clock clamped short of it would
/// stamp the reader's next edit *before* it — `hlc::MAX_AHEAD_MS` has the divergence in full.
/// `"waiting"` — a parent a later page may still bring — is released at [`WAITING_PULLS`] pulls
/// spanning [`WAITING_SECS`], **counted from the pull that first met the blocks it holds**
/// ([`Hold::blocks`]).
///
/// ⚠️ **A clock hold's bound is the stamp, and a member of the group chooses the stamp.** A batch
/// sealed under the group key with ops stamped a year ahead, behind a cleartext `hlcMs` the relay's
/// `clock_ahead` check passes, holds its sender — and this cursor — for a year less a day. That is
/// within what a member holding the key can already do to its own group (it can push anything), and
/// an honest device a year fast is refused at the push by an updated relay, so what reaches here is
/// a log stored before that refusal or a receiver whose own clock is behind.
pub const PULL_HOLD: &str = "pull_hold";

/// Whether the relay has said it accepts a removal that steps the epoch by two — `"2"` once any
/// `/keys` answer has carried `removalStep: 2`, and absent before. [`removal_step`] reads it.
///
/// **Latched and never deleted, a leave included**: it is a fact about the relay, not about the
/// group, and `identity::leave_group` clears only what belongs to a group. It is also
/// **trust-on-first-use by design**. The epoch is bound into every rewrapped blob, so a two-step
/// removal is a removal the relay cannot relabel as a join — the one thing that stops the
/// manifest's `devices`, which is the relay's word, deciding whether a superseded key is kept. A
/// relay that could stop advertising the step and have this device plan one-step removals again
/// would hand that decision back to the manifest; latched, it cannot, and a relay that stops
/// accepting `+2` after advertising it gets a refused removal rather than a quiet downgrade.
pub const RELAY_REMOVAL_STEP: &str = "relay_removal_step";

/// A waiting hold is released once it has been seen on this many pulls...
const WAITING_PULLS: i64 = 3;
/// ...spanning at least this many seconds. A parent its sender owed — a first contact pushes a
/// child ahead of the baseline that carries its parent — arrives on that sender's next trip,
/// seconds later; one deleted on a third device never arrives.
const WAITING_SECS: i64 = 600;

/// A [`PULL_HOLD`] row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct Hold {
    /// `"newer"`, `"clock"` or `"waiting"`.
    pub(crate) kind: String,
    /// When a hold of this kind on these blocks began, in unix seconds. A pull that keeps it
    /// keeps this.
    since: i64,
    /// Pulls that have found it, this one included.
    pulls: i64,
    /// **What the hold is a hold on** ([`apply::Held`]): each held device, at the stamp of its
    /// first held op, of its first batch only a newer build can read, or — when any of its
    /// batches is stamped too far ahead, which holds all of them — of its earliest batch in the
    /// page, whichever is earliest; **and each held claim, as a block of its own**, keyed
    /// `"<device>#<ms>.<ctr>#<i>"` — its emitter, its emission's `id` and its index — at its own
    /// stamp (design 2026-10-03 §5). A claim says nothing about its emitter's stream, so it is
    /// never folded into the emitter's key, and a `#` never appears in a device id, so the two
    /// kinds of key never meet. **So a new held claim is a new block, and restarts the waiting
    /// bound**, as a newly held device does.
    ///
    /// **The waiting bound belongs to these, and a block not among them starts it over** (the
    /// final review of the delivery holds, I1). Counted by kind alone, a second wait that began
    /// while an older one was open inherited the older one's pulls and span, and the release that
    /// ended the first dropped the second with it: a device that had just paired lost the child
    /// it pushed ahead of the baseline carrying its parent, which then landed seconds too late. A
    /// block that resolved and left is not new, so it is simply dropped from the set.
    ///
    /// `None` on a row a build before the field wrote — `{"kind","since","pulls"}` — which is an
    /// unknown set, and the next pull starts over.
    #[serde(default)]
    blocks: Option<apply::Held>,
    /// The envelopes this hold's pulls have already recorded in `error_log`, by `(device, hlc_ms,
    /// hlc_ctr)`: every unreadable one, and the first batch of each device held for its clock.
    /// **A held page comes back on every pull** — for a newer hold, until the reader updates;
    /// for a clock hold, until the clock catches up — and noting its batches again on each would
    /// turn one batch into a row counting trips; so a batch named here is not noted again.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    noted: Vec<(String, i64, i64)>,
}

/// The hold [`PULL_HOLD`] records, or `None` when nothing is held — or when the row does not read
/// as one, which only a hand-edited database can hold, and which the next pull rewrites.
pub(crate) fn read_hold(conn: &Connection) -> Option<Hold> {
    get_state(conn, PULL_HOLD).and_then(|s| serde_json::from_str(&s).ok())
}

/// Now, in unix seconds, **from SQLite**.
fn now_secs(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT unixepoch()", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// This device's wall clock in unix milliseconds, **from SQLite and spelled as capture and
/// `apply` spell it** — the clock a captured op is stamped with and the one `apply` observes a
/// peer's stamp against, so the bound a clock hold measures is measured on the clock that would
/// otherwise have been dragged forward.
fn wall_ms(conn: &Connection) -> Result<i64, String> {
    #[cfg(test)]
    if let Some(ms) = WALL_MS.with(std::cell::Cell::get) {
        return Ok(ms);
    }
    conn.query_row(
        "SELECT cast(unixepoch('subsec') * 1000 AS INTEGER)",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
thread_local! {
    /// **Tests only**: the wall clock [`wall_ms`] answers in place of SQLite's, so a test can let
    /// two days pass between two pulls. The waiting bound's time is injected through `sync_state`
    /// ([`Hold::since`]), and there is no such row to rewind here: the stamp a clock hold compares
    /// is sealed inside an envelope, so it is the clock that has to move.
    pub(crate) static WALL_MS: std::cell::Cell<Option<i64>> = const { std::cell::Cell::new(None) };
}

/// Record that this pull held for `kind`, on `blocks`, having recorded the envelopes in `noted`
/// ([`Hold::noted`]). **The same kind on no block it has not seen keeps `since` and counts the pull;
/// anything else starts over** — a new kind, so a waiting hold that turns into a newer one does not
/// inherit a span that was never the newer one's, and a new block, so a wait that has run its
/// course cannot release one that has only just begun ([`Hold::blocks`]).
fn note_hold(
    conn: &Connection,
    kind: &str,
    blocks: apply::Held,
    noted: Vec<(String, i64, i64)>,
) -> Result<Hold, String> {
    let stored = read_hold(conn);
    let same = stored.as_ref().is_some_and(|h| {
        h.kind == kind
            && h.blocks
                .as_ref()
                .is_some_and(|seen| blocks.iter().all(|(d, at)| seen.get(d) == Some(at)))
    });
    let hold = match stored {
        Some(h) if same => Hold {
            pulls: h.pulls + 1,
            blocks: Some(blocks),
            noted,
            ..h
        },
        _ => Hold {
            kind: kind.to_owned(),
            since: now_secs(conn)?,
            pulls: 1,
            blocks: Some(blocks),
            noted,
        },
    };
    let json = serde_json::to_string(&hold).map_err(|e| e.to_string())?;
    set_state(conn, PULL_HOLD, &json).map_err(|e| e.to_string())?;
    Ok(hold)
}

/// Nothing is held any more.
fn clear_hold(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM sync_state WHERE key = ?1", [PULL_HOLD])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// What one call to [`run_once`] did.
///
/// **`Relay`-prefixed because `SyncOutcome` is taken**, by `crate::sync`'s card sync and by
/// `ipc.ts`'s mirror of it. Two structs of that name would have been a type error in
/// TypeScript before anybody noticed the collision in Rust.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayOutcome {
    /// Ops handed to the relay.
    pub pushed: usize,
    /// Ops this trip's pull **newly applied** — the same number as `applied`. Never the ops a
    /// held cursor was handed again: those are `skipped` or held, and counting them would fire
    /// `sync:applied` on every trip a hold lasts. (It read "envelopes taken", and counted every op
    /// the page carried, until the cursor could be held.) **Not the gate for a screen refresh any
    /// more** — `changed` is, and this is one of the things it counts.
    pub pulled: usize,
    /// Envelopes that could not be opened — a device that has not caught up with a key
    /// rotation, a blob from before one whose key this device does not hold, or one claiming an
    /// epoch the relay has never reached.
    pub unreadable: usize,
    pub applied: usize,
    pub resurrected: usize,
    pub cycles_broken: usize,
    pub skipped: usize,
    /// Ops held for re-delivery — `held_newer`, the ops held for a sender's clock, and the ops
    /// waiting on a parent. Any at all, and the cursor did not move.
    pub deferred: usize,
    /// Of `deferred`, the ops a newer schema wrote and the ops held behind them. Only updating
    /// this device resolves them.
    pub held_newer: usize,
    /// Ops that can never apply, skipped: each group is an `error_log` row, so the panel can point
    /// there rather than promise them later.
    pub dropped: usize,
    /// Ops consumed because they name a parent a delete has already taken
    /// ([`ApplyReport::moot`]) — and **a row this device held under such an op's uid is deleted
    /// with it**, so a trip can change what a screen shows while `applied` stays at nought.
    pub moot: usize,
    /// **Whether this trip wrote to the synced tables on this device** — the one field a screen
    /// refresh may gate on. True when the pull applied ops (`pulled > 0`), mooted any (a cascade
    /// can delete rows here), resurrected a row or broke a folder cycle, or when the conversions
    /// that run behind a pull that read everything (`deck_tokens::convert_legacy_picks_after_pull`,
    /// `deck_meta::refile_stray_theory_cards_after_pull`) wrote a row.
    ///
    /// **`pulled > 0` alone missed two of those** (issue #546's review, finding 4): the moot arm
    /// deletes and counts in `moot`, never in `applied`, and the conversions write after `apply`
    /// has returned and count nowhere in its report — so a trip that deleted a card here, or filed
    /// a peer's token entries, refreshed nothing on screen. A trip that only pushed is `false`:
    /// the window that wrote has already settled its own queries.
    pub changed: bool,
    /// Ops sent as a first-contact baseline. Spec §13 — the panel names this separately,
    /// because a first exchange is larger than an ordinary sync and must not read as a hang.
    pub baseline_ops: usize,
    /// The `deck_audit` rows among them, named separately because they can surprise: history is
    /// the one synced table with no ceiling, growing with what the reader has *done* rather than
    /// with what they own. Spec §7 and §13.
    pub baseline_history: usize,
}

impl RelayOutcome {
    fn absorb(&mut self, report: ApplyReport) {
        self.applied += report.applied;
        self.resurrected += report.resurrected;
        self.cycles_broken += report.cycles_broken;
        self.skipped += report.skipped;
        self.deferred += report.deferred;
        self.held_newer += report.held_newer;
        self.dropped += report.dropped;
        self.moot += report.moot;
        self.changed |= report.applied > 0
            || report.moot > 0
            || report.resurrected > 0
            || report.cycles_broken > 0;
    }
}

/// What the relay answers a pull with.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullPage {
    envelopes: Vec<Envelope>,
    cursor: i64,
}

/// What the relay answers a push with.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushReceipt {
    #[allow(dead_code)]
    cursor: i64,
}

/// What every refusal from an updated relay carries: `{"error": "<sentence>", "code": "<code>"}`.
///
/// **Only `code` is read, and never `error`** — the precedent `entitlement.rs` set with
/// `device_limit`. The sentence is the relay's to reword; the code is the contract.
#[derive(Debug, Clone, Deserialize)]
struct RefusalBody {
    #[serde(default)]
    code: Option<String>,
}

/// The `code` a refusal body carries, or `None` for a body that is not one — an older relay's
/// plain `401`, a proxy's HTML page, nothing at all.
fn refusal_code(body: &str) -> Option<String> {
    serde_json::from_str::<RefusalBody>(body)
        .ok()
        .and_then(|b| b.code)
}

/// `/keys?epoch=n` for an epoch the group has no manifest at — a removal stepped over it, or the
/// relay has pruned it. **404**.
const NO_SUCH_EPOCH: &str = "no_such_epoch";
/// A push sealed below the group's epoch — this device is behind a rotation. **409**.
const STALE_EPOCH: &str = "stale_epoch";
/// A push sealed above the group's epoch. **422**.
const EPOCH_AHEAD: &str = "epoch_ahead";
/// A push whose stamp is more than a day ahead of the relay's clock. **422**.
const CLOCK_AHEAD: &str = "clock_ahead";
/// A push over the relay's size cap. **413**.
const TOO_LARGE: &str = "too_large";
/// A push that would take the group's stored log over its quota. **507**.
const QUOTA: &str = "quota";

/// A push the relay refused for a reason nothing else in this trip can clear, which **defers what
/// is left of the push rather than failing the trip** ([`Pushed::deferred`]). Matched on the
/// refusal's `code`, never its sentence.
///
/// ⚠️ **Failing the trip on one of these stopped the device pulling and acking for as long as the
/// refusal lasted** (issue #546's review, finding 2), and every one of them lasts: the same ops
/// meet the same answer on every attempt. For `quota` that is a deadlock — this device's ack is
/// the relay's compaction floor, so the log it will not compact is the log that is full, until the
/// relay's `ACK_TTL_MS` lets go of it ninety days on. So the ops stay pending, nothing after them
/// is pushed this trip, and the trip goes on to pull and ack. A transient failure — the network, a 5xx, an answer that does
/// not parse — still fails the trip, because the next attempt may simply work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Deferral {
    /// 413 `too_large`. Unreachable while [`wire::batches`] cuts under the cap and [`push`] sets
    /// aside the one op no cut can save — the two sides disagreeing about a size.
    ///
    /// ⚠️ **If it is reached, it now costs every later baseline as well** (the baseline claim
    /// design of 2026-10-03, §5): the refused batch is one this device measured as fitting, so
    /// it is offered again and refused again on every trip, its ops stay pending for good, and
    /// [`emit_baselines`] begins nothing while anything is pending — where before it emitted
    /// behind the refusal.
    TooLarge,
    /// 507 `quota`: the group's stored log is full.
    Quota,
    /// 422 `clock_ahead`, once [`rebase`] could not mend it or its retry was refused too.
    ClockAhead,
    /// 422 `epoch_ahead`: sealed at an epoch the relay has not reached.
    EpochAhead,
}

impl Deferral {
    /// The deferral a refusal's `code` names, or `None` for every other code and for none.
    /// `clock_ahead` is not read here: [`post_ops`] answers it as [`Refusal::ClockAhead`], because
    /// [`push`] may still mend it.
    fn of(code: Option<&str>) -> Option<Deferral> {
        match code? {
            TOO_LARGE => Some(Deferral::TooLarge),
            QUOTA => Some(Deferral::Quota),
            EPOCH_AHEAD => Some(Deferral::EpochAhead),
            _ => None,
        }
    }

    /// Whether a trip whose push was deferred for this should **emit no baseline** either.
    ///
    /// **The clock and the quota**, because a baseline can meet the same refusal part of the way
    /// through, and there it costs more than a request: a baseline is cut into chunks and its
    /// marker is stamped only once every chunk has landed, so one refused at chunk *k* pushes
    /// chunks *0..k-1* again on every trip — into storage the quota is already out of, or past a
    /// clock the relay goes on refusing. A baseline is sealed at the push's epoch, so `epoch_ahead`
    /// refuses it too, but at its first chunk, where it costs one request; and `too_large` says
    /// nothing about any other batch.
    ///
    /// **Every deferral now holds a baseline back in any case**, through [`emit_baselines`]' own
    /// rule: a deferred push leaves its refused ops pending, and no baseline is begun while
    /// anything is pending (the baseline claim design of 2026-10-03, §5). This is the cheaper
    /// question for the two it names — asked here, the trip spends no stretch on it. For a
    /// `too_large` that cost lasts for good ([`Deferral::TooLarge`]).
    fn stops_baselines(self) -> bool {
        matches!(self, Deferral::ClockAhead | Deferral::Quota)
    }
}

/// What [`push`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Pushed {
    /// Ops the relay took, stamped `pushed_at`. The ops too large ever to send are stamped as well
    /// and are not counted here.
    pub sent: usize,
    /// Why the push stopped short of the end of the outbox, or `None` when it reached it. What was
    /// left is still pending and is offered again on the next trip, which this trip's pull and ack
    /// do not wait for.
    pub deferred: Option<Deferral>,
}

// ---------------------------------------------------------------------------------------
// The database, a stretch at a time
// ---------------------------------------------------------------------------------------
//
// Every `async fn` below takes `db: &impl Store` (`crate::state`) and reaches the
// database inside `db.with(|conn| …)` — a *stretch* — with each request made between two of
// them and nothing held. The app's store is the lane's guard, so one sync operation runs at a
// time; what can land between two stretches is a reader's own write, and a function that
// reads two things which must agree reads them in one stretch.

/// [`note`] as a stretch of its own. A row that could not be written is a row the log goes
/// without, as it always was: `errors::record` answers nothing.
fn say(db: &impl Store, operation: &str, kind: Kind, message: &str, detail: Option<&str>) {
    let _ = db.with(|conn| {
        note(conn, operation, kind, message, detail);
        Ok(())
    });
}

/// [`lapsed`] as a stretch of its own.
fn lapsed_in(db: &impl Store, what: &str) -> String {
    db.with(|conn| Ok(lapsed(conn, what))).unwrap_or_else(|e| e)
}

/// Who this device is, which group it is in and where its relay lives — what a function reads
/// before its first request — or `None` when it is in no group.
fn whereabouts(conn: &Connection) -> Result<Option<(String, Group, String)>, String> {
    Ok(me(conn)?.map(|(device, group)| (device, group, entitlement::base(conn))))
}

/// **The fence, and it is the compiler's**: an operation over the lane is a future that can be
/// sent to another thread, which it cannot be while it holds a `MutexGuard` — or a
/// `&Connection` — across an `.await`. One line per entry point. Never called. A native build's
/// question only: in a browser no request is `Send` ([`crate::platform::Sendable`]).
#[allow(dead_code)]
fn nothing_is_held_across_a_request(lane: &Lane<'_>, rotation: &identity::Rotation) {
    fn sendable<T: crate::platform::Sendable>(_: T) {}
    sendable(run_once(lane));
    sendable(run_once_without_baselines(lane));
    sendable(check_keys(lane));
    sendable(publish_join(lane));
    sendable(post_rotation(lane, rotation));
    sendable(post_rendezvous(lane, "", "", ""));
    sendable(get_rendezvous(lane, "", ""));
}

// ---------------------------------------------------------------------------------------
// `sync_state`
// ---------------------------------------------------------------------------------------

pub fn get_state(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM sync_state WHERE key = ?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .optional()
    .ok()
    .flatten()
}

pub fn set_state(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?1, ?2)",
        [key, value],
    )
    .map(|_| ())
}

/// Who this device is and which group it is in, or `None` when it is in none.
fn me(conn: &Connection) -> Result<Option<(String, Group)>, String> {
    let device: Option<String> = conn
        .query_row(
            "SELECT device_id FROM sync_identity WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let group = identity::group(conn).map_err(|e| e.to_string())?;
    Ok(match (device, group) {
        (Some(d), Some(g)) => Some((d, g)),
        _ => None,
    })
}

// ---------------------------------------------------------------------------------------
// The network
// ---------------------------------------------------------------------------------------

/// The HTTP client.
///
/// **Its own, and never Scryfall's.** A relay is not Scryfall, must not spend its pacing budget
/// and must not join its 429 lockout — the rule `marketplace_feed` and `combos` already follow.
///
/// **Memoised in the app and built per call under `cfg(test)`**, and that asymmetry is the fix
/// for a flake this file carried for as long as it has existed. Measured 2026-08-30 on this
/// machine: **3 failures in 30 runs** of `cargo test --lib sync_engine::client`, at
/// `tests.rs:518`, `:560` and `:802` — never the same line twice in a row, and each one a
/// *transport* error (`error sending request`) where the assertion wanted a *status*. CI saw
/// the same thing on `windows-latest` three times in twenty runs while `ubuntu-22.04` passed
/// every time.
///
/// The cause is this static outliving what it is connected to. One client for the
/// whole test binary keeps idle keep-alive connections, `httpmock` pools its servers and hands
/// a port that one test finished with to another test, and the next request down a socket the
/// far end has already reset fails before it can carry a status. **`#[tokio::test]` compounds
/// it** — each test builds and drops its own runtime, so a pooled connection can also outlive
/// the reactor that registered it.
///
/// **Production keeps the `OnceLock`, deliberately.** The obvious repairs — `pool_max_idle_per_host(0)`,
/// a shorter idle timeout — are a change to how the shipped app talks to the relay in order to
/// settle a test problem, which is the trade this repo's own note on the flake warned against
/// taking. The app has one runtime for the life of the process and one relay to talk to, so
/// pooling there is right and is not what is broken. A test build makes a fresh client instead:
/// it costs one connection per call in a suite that already starts a mock server per test, and
/// it removes the only thing being shared across runtimes.
///
/// Re-measured after this change: **0 failures in 60 runs** (p ≈ 0.002 against a 10% rate).
#[cfg(not(any(test, feature = "testing")))]
fn http() -> http::Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<http::Client> = OnceLock::new();
    CLIENT.get_or_init(build_http).clone()
}

/// See [`http`]: a test build takes a fresh client so nothing is shared across runtimes.
#[cfg(any(test, feature = "testing"))]
fn http() -> http::Client {
    build_http()
}

/// **The only way this module reaches its client**: [`http`], behind
/// [`entitlement::not_from_a_page_yet`], which has the reason. Every request below is built
/// from this, so none can be sent from a host the relay cannot answer; the refusal is the
/// bare sentence, returned before the `say` that logs a failed request — a refusal is not one.
fn relay() -> Result<http::Client, String> {
    entitlement::not_from_a_page_yet()?;
    Ok(http())
}

/// The one place the client's shape is written down, so the two arms above cannot drift on a
/// timeout the way two copies of a builder would.
fn build_http() -> http::Client {
    http::Client::new(&http::Config {
        user_agent: crate::scryfall::USER_AGENT,
        connect_timeout: Some(Duration::from_secs(10)),
        read_timeout: Some(Duration::from_secs(30)),
    })
    .deadline(REQUEST_DEADLINE)
}

/// **The whole of a request, where the host has no socket to bound one** — a browser, whose
/// `fetch` has neither a connect phase nor a per-read timeout. The sync lane is held across
/// every request this module makes and a departure waits for the lane, so a request that never
/// ended would be a Leave that never ran. Natively it is not applied: the connect and read
/// bounds above already end a request that stops answering
/// ([`crate::platform::http::Client::deadline`]).
///
/// **Two minutes, and nobody has measured a browser against it.** A pull is unpaged and can
/// answer tens of megabytes after a large import; the web host's phase measures what a page
/// costs a Worker, and this is the number it starts from.
const REQUEST_DEADLINE: Duration = Duration::from_secs(120);

/// Classify a transport failure, so the four call sites agree about what it was.
///
/// **There is no `Http` arm for a transport failure.** `reqwest`'s `is_status` is true only for
/// an error made by `error_for_status`, which nothing here calls — a status is read off the
/// response and recorded as `Kind::Http` where it is — so the arm never fired and did not come
/// with the move to `platform::http`.
fn kind_of(err: &http::Error) -> Kind {
    if err.is_timeout() {
        Kind::Timeout
    } else if err.is_decode() {
        Kind::Parse
    } else {
        Kind::Other
    }
}

fn note(conn: &Connection, operation: &str, kind: Kind, message: &str, detail: Option<&str>) {
    errors::record(conn, Source::Relay, operation, kind, message, detail);
}

/// What a **401 on a sync route** costs: the grant, and deliberately nothing else.
///
/// The relay stopped honouring this device's token, and on push, pull and ack — unlike on
/// `/token`, where [`entitlement::access_token`] can re-mint — there is nothing left to try. So
/// the membership has ended, and two rules follow, each the opposite of what the surrounding
/// code does with every other status:
///
/// * **[`entitlement::revoke`] and never [`entitlement::clear`].** The two are different by
///   design: `clear` is the reader pressing *Disconnect* and deliberately leaves no mark, while
///   `revoke` leaves the row [`entitlement::membership_ended`] reads. Calling `clear` here shows
///   a lapsed reader *Not connected* instead of *Membership ended*, which loses the one sentence
///   (spec §7.1) that tells them their local data is untouched.
/// * **No [`note`] call.** An `error_log` row is how this window says "your sync is broken", and
///   a reader whose pledge lapsed sent to look at their network is being pointed at the wrong
///   fix. Spec §10, and `entitlement.rs`'s module doc makes the same argument at length.
///
/// The 401 is still an `Err`, because the round trip did not happen.
fn lapsed(conn: &Connection, what: &str) -> String {
    let message = format!("the relay answered 401 to {what}; the membership has ended");
    match entitlement::revoke(conn) {
        Ok(()) => message,
        // A database that will not take the revoke is a second, different failure — but the 401
        // is what happened first and is what the reader has to hear.
        Err(e) => format!("{message} (the grant could not be cleared: {e})"),
    }
}

// ---------------------------------------------------------------------------------------
// The group key
// ---------------------------------------------------------------------------------------

/// What a `/keys` check found, and what [`round_trip`] does about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyOutcome {
    /// The relay stands on the epoch this device already holds, so there is nothing to do. One
    /// cheap read, and the answer on every sync of every healthy group.
    Current,
    /// A higher epoch with a blob sealed to this device: the new key is written and the roster
    /// swept to the manifest — each epoch in between first, where the relay serves them
    /// ([`check_keys`]), for its key and never its roster. This device is still in the group and
    /// the trip carries on.
    Adopted,
    /// A higher epoch and **no blob for this device**, which is the removal notice — see
    /// [`check_keys`]. The group is left and the grant cleared.
    Removed,
}

/// What [`check_keys`] found, and the epoch the relay answered it at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyCheck {
    pub outcome: KeyOutcome,
    /// The newest epoch `/keys` answered, which is what [`pull`] measures an envelope from ahead
    /// of this device against — the relay stores an envelope's `epoch` exactly as it was sent, so
    /// the relay's own epoch is the only one that says whether a rotation really happened. `None`
    /// when no request was made: a device in no group.
    pub relay_epoch: Option<i64>,
}

/// What `GET /g/{group}/keys` answers.
#[derive(Debug, Clone, Deserialize)]
struct KeyPage {
    epoch: i64,
    /// The group key at that epoch sealed for **this** device, base64url with no padding —
    /// `wire::Envelope::sealed`'s encoding, for its reasons. `null` when the manifest does not
    /// name this device.
    #[serde(deserialize_with = "null_but_present")]
    blob: Option<String>,
    /// The manifest's key set: the roster at that epoch (spec §2.3).
    devices: Vec<String>,
    /// `2` from a relay that accepts a removal stepping the epoch by two, and absent from one that
    /// does not — **optional on purpose**, unlike `blob`: its absence means an older relay, never
    /// anything about this group, so the default is the honest reading. [`RELAY_REMOVAL_STEP`].
    #[serde(default, rename = "removalStep")]
    removal_step: Option<i64>,
}

/// The step [`identity`]'s removal and departure plans advance the epoch by:
/// [`identity::REMOVAL_STEP`] once this device has seen the relay advertise it
/// ([`RELAY_REMOVAL_STEP`]), and [`identity::JOIN_STEP`] until then — a relay that has not said it
/// accepts `+2` answers one with a 422, which would leave every removal refused. A join is always
/// `+1` and does not ask.
pub fn removal_step(conn: &Connection) -> i64 {
    match get_state(conn, RELAY_REMOVAL_STEP).and_then(|v| v.parse::<i64>().ok()) {
        Some(identity::REMOVAL_STEP) => identity::REMOVAL_STEP,
        _ => identity::JOIN_STEP,
    }
}

/// Latch [`RELAY_REMOVAL_STEP`] off an answer that advertises it. **Written only the first time**,
/// so a sync — which asks `/keys` on every trip — does not rewrite a row that has not changed. A
/// failure to write is not the key check's failure: the next answer latches it.
fn latch_removal_step(conn: &Connection, page: &KeyPage) {
    if page.removal_step != Some(identity::REMOVAL_STEP)
        || removal_step(conn) == identity::REMOVAL_STEP
    {
        return;
    }
    if let Err(e) = set_state(
        conn,
        RELAY_REMOVAL_STEP,
        &identity::REMOVAL_STEP.to_string(),
    ) {
        eprintln!(
            "the relay's two-step removal could not be recorded: {e}\nIt is tried again on the \
             next key check."
        );
    }
}

/// `Option<String>`, except that the field has to be **there**.
///
/// **serde reads a missing `Option` field as `None` without being asked to**, and here that
/// default is the one answer this type must never invent: at a higher epoch an absent `blob` is
/// the removal notice, so a relay that answered a body with no `blob` at all would dissolve a
/// group nobody was removed from. A `deserialize_with` is exempt from the missing-field default,
/// so a truncated answer is a parse failure — which stalls this device exactly where it is,
/// recoverable, instead of taking its group away.
fn null_but_present<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

/// The `/keys` URL, written once so the request and the failures [`check_keys`] records *after*
/// the request has come back cannot drift into naming two different addresses. `at` asks for the
/// manifest stored at that one epoch (`&epoch=`) rather than the newest.
fn keys_url(base: &str, device: &str, group: &Group, at: Option<i64>) -> String {
    let url = format!("{base}/g/{}/keys?device={device}", group.group_id);
    match at {
        Some(epoch) => format!("{url}&epoch={epoch}"),
        None => url,
    }
}

/// `GET /g/{group}/keys?device=…`, decoded — the request itself, with no opinion about what the
/// answer means.
///
/// **Three callers with three different questions, and one request shape between them.**
/// [`check_keys`] asks *what epoch is the group on and am I still in it*; [`relay_manifest`] asks
/// only *who does the relay currently think is in this group*, which [`publish_join`] needs
/// before it may speak for the group at all; [`pull`] asks only *has the relay reached this
/// epoch*, for an envelope ahead of this device. Factoring the request out is what stops the
/// others growing a second, subtly different spelling of the 401 sentence below.
///
/// **The credential is the group auth of this device's own epoch**, which is what makes this the
/// one route a device behind a rotation can still reach — see [`check_keys`] for the whole of
/// that argument.
///
/// `base` is the caller's rather than read here, because [`pull`] already holds the one its trip
/// was handed; the other callers pass [`entitlement::base`].
async fn fetch_key_page(
    db: &impl Store,
    base: &str,
    device: &str,
    group: &Group,
) -> Result<KeyPage, String> {
    // `None` never comes back without `at`: the 404 it stands for is read only for an epoch asked
    // after, and any other 404 is a failure recorded below.
    fetch_key_page_at(db, base, device, group, None)
        .await?
        .ok_or_else(|| "the relay answered 404 to a key check".to_owned())
}

/// [`fetch_key_page`], or with `at` the manifest stored at that epoch — **`Ok(None)` for a 404
/// carrying `code: "no_such_epoch"`**, which is an answer rather than a failure: no rotation
/// landed on that epoch (a removal steps over one) or the relay has pruned it. It is not written
/// to `error_log`, because [`catch_up`] asks after exactly such epochs in the ordinary course.
///
/// **Every answer that parses latches [`RELAY_REMOVAL_STEP`]**, whichever caller asked: it is a
/// fact about the relay, and this is the one place every `/keys` answer passes through.
async fn fetch_key_page_at(
    db: &impl Store,
    base: &str,
    device: &str,
    group: &Group,
    at: Option<i64>,
) -> Result<Option<KeyPage>, String> {
    let auth = crypto::relay_auth(&group.group_key, &group.group_id, group.epoch);
    let url = keys_url(base, device, group, at);
    let response = match relay()?
        .get(&url)
        .header("authorization", &format!("Bearer {auth}"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            say(db, "keys", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    let status = response.status();
    if !(200..300).contains(&status) {
        if status == 404 && at.is_some() {
            let body = response.text().await.unwrap_or_default();
            if refusal_code(&body).as_deref() == Some(NO_SUCH_EPOCH) {
                return Ok(None);
            }
        }
        let message = if status == 401 {
            // **The commonest cause is named first, and it is a migration rather than a
            // fault.** A group claimed before the relay stored group keys has an entitlement
            // with no manifest row and a NULL `group_auth`: `seedGroup` runs only from
            // `/claim`, so nothing else has ever registered one. **The relay cannot fill it
            // in on its own** — `relay_auth` is derived from the group key, which it never
            // sees and must never see — so the repair has to be a press on a device.
            // Reconnecting Patreon re-claims the same group (`row.group_id == group`
            // passes) and seeds the manifest. Measured on the real pair 2026-08-30: a
            // paid-up, paired device at epoch 2 failed here on its first press, and no test
            // could have found it — every relay suite starts from a group claimed under the
            // new code, so a group claimed *before* it is a state the fixtures cannot spell.
            "the relay did not recognise this device's group key. If your devices synced \
             together before today, reconnect Patreon once on the device you connected it on \
             - that registers the group with the relay again. Otherwise this group has no \
             membership connected to it yet, or this device has been offline across more key \
             changes than the relay keeps."
                .to_owned()
        } else {
            format!("the relay answered {status} to a key check")
        };
        say(db, "keys", Kind::Http, &message, Some(&url));
        return Err(message);
    }
    let text = match response.text().await {
        Ok(t) => t,
        Err(e) => {
            say(db, "keys", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    match serde_json::from_str::<KeyPage>(&text) {
        Ok(page) => {
            // A fact about the relay, kept in a stretch of its own.
            let _ = db.with(|conn| {
                latch_removal_step(conn, &page);
                Ok(())
            });
            Ok(Some(page))
        }
        Err(e) => {
            say(db, "keys", Kind::Parse, &e.to_string(), Some(&url));
            Err(e.to_string())
        }
    }
}

/// Who the relay currently believes is in this group — the manifest's key set at the epoch it
/// holds, and nothing else off the page.
///
/// **It is not an epoch check and must never grow into one.** [`check_keys`] is the only thing
/// entitled to conclude anything from an epoch, and it already runs on every sync; this answers
/// the one narrower question [`publish_join`] has to ask before it publishes a roster.
async fn relay_manifest(db: &impl Store) -> Result<Vec<String>, String> {
    let Some((device, group, base)) = db.with(whereabouts)? else {
        return Err("this device is in no group".to_owned());
    };
    Ok(fetch_key_page(db, &base, &device, &group).await?.devices)
}

/// Ask the relay what epoch the group is on, and act on the answer.
///
/// **The one request that has to work when a token cannot be minted.** A device that has been
/// rotated away from holds a stale group auth, so `entitlement::access_token` answers
/// [`entitlement::STALE_GROUP_AUTH`] and every other route is closed to it. `/keys` accepts an
/// auth up to eight epochs old for exactly that reason: "behind a rotation" and "removed"
/// otherwise produce an identical refusal, and a device that guessed wrong would either leave a
/// group it is still in or sit for ever in one it is not.
///
/// ⚠️ **The manifest is consulted only when the answered epoch is strictly higher than this
/// device's, and that guard is the whole of what keeps a healthy group alive.** A group that has
/// claimed and never rotated holds one `group_keys` row with an *empty* manifest, so every device
/// in it reads `blob: null, devices: []`. Comparing the epochs first is what stops all of them
/// concluding they were removed and dissolving the group on their next sync. Equal epochs mean
/// *nothing to do*, and `devices` is not read at all. `identity::adopt_epoch` refuses a
/// non-advancing epoch too, but the `Removed` branch is decided here and has no such backstop.
///
/// **More than one epoch behind, it catches up one epoch at a time** ([`catch_up`]) and only then
/// takes the newest. Adopting the newest directly never gave this device the keys in between, and
/// `identity::supersede` forgets on any skip — so a device offline across two joins stepped over
/// everything the group sealed at the first, for good. A removal still costs its backlog, as it
/// must: the walk meets the gap a removal leaves (it steps the epoch by two) and adopting across
/// it forgets, exactly as `supersede` intends.
///
/// **A 401 is never [`lapsed`], and copying push/pull/ack's handling here would be the worst
/// mistake in this file.** The credential is the group auth, not the access token, so a refusal
/// says the group key is unrecognised — a group with no membership yet, or a device dark across
/// more rotations than the relay keeps (spec §4). Revoking the grant over either would tell a
/// reader their Patreon membership ended because of something else entirely.
///
/// Answers the relay's epoch beside the outcome ([`KeyCheck::relay_epoch`]), which [`round_trip`]
/// hands to [`pull`].
pub async fn check_keys(db: &impl Store) -> Result<KeyCheck, String> {
    // A device in no group has no key to check and no auth to check it with. It must make no
    // request at all: `/g//keys` is a URL, and one built from an empty group id would be sent.
    let Some((device, group, base)) = db.with(whereabouts)? else {
        return Ok(KeyCheck {
            outcome: KeyOutcome::Current,
            relay_epoch: None,
        });
    };
    let page = fetch_key_page(db, &base, &device, &group).await?;
    let answered = |outcome| KeyCheck {
        outcome,
        relay_epoch: Some(page.epoch),
    };

    // **Against the group as it stood before the request**, which is the group as it stands:
    // only a sync operation moves it, and this one holds the lane.
    if page.epoch <= group.epoch {
        return Ok(answered(KeyOutcome::Current));
    }
    let Some(blob) = &page.blob else {
        db.with(removed)?;
        return Ok(answered(KeyOutcome::Removed));
    };
    // **No walk once the newest answer has no blob**: the group as it stands has taken this device
    // off, and leaving deletes every key the walk could have collected.
    if page.epoch > group.epoch + 1
        && catch_up(db, &base, &device, page.epoch).await? == CatchUp::Removed
    {
        db.with(removed)?;
        return Ok(answered(KeyOutcome::Removed));
    }
    db.with(|conn| {
        adopt_page(conn, &device, &page, blob, identity::adopt_epoch).inspect_err(|message| {
            let url = keys_url(&base, &device, &group, None);
            note(conn, "keys", Kind::Parse, message, Some(&url));
        })
    })?;
    Ok(answered(KeyOutcome::Adopted))
}

/// This device has been taken off the group: leave it, and clear the grant.
///
/// **Both halves, and the second one is the caller's to make rather than `identity`'s.** That
/// module owns pairing state and knows nothing about Patreon; here the two facts sit side by side.
/// The grant has to go because a removed device that kept its refresh secret would keep a *working
/// credential for the group it was removed from* — the refresh door mints a token whose `grp` is
/// that group and `/g/{group}/push` honours it, so the rotation would stop it reading anything new
/// while it went on spending the group's requests.
///
/// **`clear` and never `revoke`.** The two differ by the mark `membership_ended` reads, and
/// nothing ended: the reader's pledge is untouched and this device simply left a group. `revoke`
/// would draw *Membership ended* and §7.1's reassurance at somebody whose membership is fine;
/// `clear` draws *Not connected*, and reconnecting is one press.
fn removed(conn: &Connection) -> Result<(), String> {
    identity::leave_group(conn)?;
    entitlement::clear(conn)
}

/// Where [`catch_up`] left this device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CatchUp {
    /// A manifest on the way does not name this device: the removal notice.
    Removed,
    /// Carry on and adopt the newest answer — whether the walk reached the epoch before it, found
    /// nothing to walk, or stopped early (below).
    Newest,
}

/// Adopt every epoch between this device's and `newest` that a rotation landed on, one at a time,
/// with `GET /keys?epoch=n` — **so a device two or more rotations behind is handed each key in
/// turn**, and `identity::supersede` keeps whichever of them a join replaced.
///
/// `n` runs from the epoch after this device's up to the one before `newest`, which [`check_keys`]
/// already holds the answer for. Each request presents **the auth of the epoch this device holds
/// at that moment**, which moves as it adopts — fresher each time, and so always inside the
/// relay's window if the first request was. For each `n`:
///
/// * **404 `no_such_epoch`** — no rotation landed on `n`: a removal steps the epoch by two, so
///   the epoch it skips was never stored. Try `n + 1`. The next adoption is then two ahead, and
///   `supersede` forgets across it, which is the removal costing its backlog as it must.
/// * **A manifest with no blob for this device** — the removal notice, exactly as the newest
///   answer's would be ([`removed`]). Compared only after the epoch has been seen to be `n`,
///   which is above this device's own — the guard [`check_keys`] keeps.
/// * **A blob** — adopted for its key, as [`check_keys`] adopts one ([`adopt_page`]) **except that
///   no roster row is swept** (`identity::adopt_passing_epoch`), and the walk goes on from `n + 1`.
///   `identity::supersede` still decides against `n`'s own manifest, which is what reads the
///   join/removal marker step by step; the roster is swept against the newest manifest alone,
///   when [`check_keys`] adopts it. **Swept at every step, it lost a device for good**: removed at
///   one epoch and paired back by a later one, it is on the newest manifest, but `adopt_epoch`
///   never inserts, so the row the walk deleted — and the only public key this device held for
///   it — was gone. Every rotation it sealed after that failed to open here, and this device's own
///   next removal or departure published a manifest without it (issue #546's review, finding 3).
///
/// ⚠️ **An older relay ignores `?epoch=`** and answers the newest manifest, so an answer whose
/// epoch is not `n` stops the walk: what it would have adopted is the newest, which the caller
/// adopts next anyway. **Any other failure stops it too** — refused, unreachable, a blob that will
/// not open — and the caller adopts the newest as it did before the walk existed: the device
/// forgets the keys in between rather than stalling at an epoch it cannot get past. A failure the
/// request itself met is still recorded by [`fetch_key_page_at`]; one of the blob's is not,
/// because the newest may yet open and a row would then report a sync that worked.
async fn catch_up(
    db: &impl Store,
    base: &str,
    device: &str,
    newest: i64,
) -> Result<CatchUp, String> {
    let group_now = |conn: &Connection| identity::group(conn).map_err(|e| e.to_string());
    let Some(start) = db.with(group_now)? else {
        return Ok(CatchUp::Newest);
    };
    for n in (start.epoch + 1)..newest {
        let Some(group) = db.with(group_now)? else {
            return Ok(CatchUp::Newest);
        };
        let page = match fetch_key_page_at(db, base, device, &group, Some(n)).await {
            Ok(Some(page)) => page,
            Ok(None) => continue,
            Err(_) => return Ok(CatchUp::Newest),
        };
        if page.epoch != n || page.epoch <= group.epoch {
            return Ok(CatchUp::Newest);
        }
        let Some(blob) = &page.blob else {
            return Ok(CatchUp::Removed);
        };
        let adopted =
            db.with(|conn| adopt_page(conn, device, &page, blob, identity::adopt_passing_epoch));
        if adopted.is_err() {
            return Ok(CatchUp::Newest);
        }
    }
    Ok(CatchUp::Newest)
}

/// `identity::adopt_epoch`'s shape, which `identity::adopt_passing_epoch` shares.
type Adopt = fn(&Connection, &str, i64, &[u8], &[String]) -> Result<(), String>;

/// Open `page`'s blob with every sealer this device can name, and adopt the first that fits —
/// with `adopt`, which is `identity::adopt_epoch` for the newest epoch and
/// `identity::adopt_passing_epoch` for one [`catch_up`] passes through. Answers the refusal to
/// record when none does; records nothing itself, because [`catch_up`] falls back rather than
/// failing.
///
/// **The answer does not say who rotated, so every sealer this device can name is tried.**
/// `/keys` carries the epoch, the blob and the manifest and nothing about the sealer —
/// deliberately, because the relay is not a party to the rewrap. The blob's key is
/// `X25519(sealer_secret, my_public)` and its AAD binds the group, this device and the epoch, so
/// exactly one public key opens it and the rest fail the AEAD. `adopt_epoch` unwraps *before* it
/// opens its transaction, so a candidate that does not fit writes nothing.
///
/// ⚠️ **The manifest alone is not enough, and narrowing back to it stalls a device for good.** A
/// departure is sealed by the leaver, which is on no manifest it publishes — so every device that
/// stayed failed here on every trip after a *Leave group*. And `plan_excluding` seals a blob for
/// the planner too, so a rotation this device published and never committed (a lost 2xx, a failed
/// `commit_rotation`) is sealed by *this* device: excluding itself, it failed here for ever and
/// never pushed again. Hence the manifest, then the whole local roster, then this device.
///
/// **Trying more candidates trusts nothing new.** A candidate is only a public key to try, and
/// every one is read from this device's own roster — taken at pairing, behind the six digits — or
/// is its own; the relay supplies ids and never a key. The blob still opens only for whoever holds
/// the matching secret, bound to this group, this device and this epoch. A device removed earlier
/// is off the roster already — deleted, or on an older build's database stamped `revoked_at`,
/// which is skipped here and refused by `adopt_epoch` — and anybody able to publish to `/rotate`
/// at all could always have named itself on its own manifest.
fn adopt_page(
    conn: &Connection,
    device: &str,
    page: &KeyPage,
    blob: &str,
    adopt: Adopt,
) -> Result<(), String> {
    let sealed = URL_SAFE_NO_PAD
        .decode(blob.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut candidates: Vec<String> = page.devices.clone();
    for known in identity::roster(conn).map_err(|e| e.to_string())? {
        if known.revoked_at.is_none() && !candidates.contains(&known.device_id) {
            candidates.push(known.device_id);
        }
    }
    if !candidates.iter().any(|c| c == device) {
        candidates.push(device.to_owned());
    }
    let mut refusal = String::new();
    for sealer in &candidates {
        match adopt(conn, sealer, page.epoch, &sealed, &page.devices) {
            Ok(()) => return Ok(()),
            Err(e) => refusal = e,
        }
    }
    Err(format!(
        "that new group key could not be opened by this device: {refusal}"
    ))
}

/// Publish a rotation: the new epoch's auth, and the new group key rewrapped per device.
///
/// **Nothing local has moved when this is called and nothing may move if it fails.**
/// `identity::plan_rotation` writes no row, so a refused or unreachable `/rotate` leaves the
/// group exactly as it was and the reader can press Remove again — where the version this
/// replaced committed first and unconditionally, which is how a device came to hold a rotation
/// nobody else could ever learn.
///
/// **The credential is the group auth of the epoch being replaced**, in an `authorization`
/// header. The relay accepts that or the Patreon refresh secret; the auth is what every device
/// in the group holds, so it is what this reaches for. It is the *current* one and not the
/// planned one — the relay compares against what it has stored, which is the epoch this call is
/// about to advance past.
///
/// A 401 here is not [`lapsed`] either, for [`check_keys`]' reason: it says the group auth was
/// not current, which after the round trip above it can only be if another device rotated in
/// between.
///
/// **A removal or a departure steps the epoch by [`removal_step`], and a 422 from a relay that
/// does not accept `+2` cannot follow once that is two.** The step is two only after the relay
/// itself advertised it (`removalStep: 2` on `/keys`, [`RELAY_REMOVAL_STEP`]), so a relay that
/// refuses one has stopped accepting what it said it accepts — a rollback, or a relay pretending.
/// **There is deliberately no retry at `+1`.** A one-step removal is the one the relay could pass
/// off as a join, which is exactly what the latch exists to stop it doing, so a quiet fallback
/// would be the downgrade under another name; the refusal is recorded like any other, nothing
/// local moves, and the reader's press answers that the relay refused it.
pub async fn post_rotation(db: &impl Store, rotation: &identity::Rotation) -> Result<(), String> {
    // Its own sentence rather than `identity`'s `NOT_IN_A_GROUP`, which is private to that
    // module: this is not the ordinary "you are in no group" refusal — `plan_rotation` has
    // already answered that one — but a group that went away between planning and publishing.
    let (current, base) = db.with(|conn| {
        let Some(current) = identity::group(conn).map_err(|e| e.to_string())? else {
            return Err(
                "this device left its group before that key change could be published".to_owned(),
            );
        };
        Ok((current, entitlement::base(conn)))
    })?;
    let auth = crypto::relay_auth(&current.group_key, &current.group_id, current.epoch);
    let url = format!("{base}/g/{}/rotate", current.group_id);
    let keys: serde_json::Map<String, serde_json::Value> = rotation
        .keys
        .iter()
        .map(|(device, blob)| {
            (
                device.clone(),
                serde_json::Value::String(URL_SAFE_NO_PAD.encode(blob)),
            )
        })
        .collect();
    let body = serde_json::json!({
        "epoch": rotation.group.epoch,
        "auth": rotation.auth,
        "keys": keys,
    })
    .to_string();
    let response = match relay()?
        .post(&url)
        .header("content-type", "application/json")
        .header("authorization", &format!("Bearer {auth}"))
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            say(db, "rotate", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    let status = response.status();
    if !(200..300).contains(&status) {
        let message =
            format!("the relay answered {status} to a key change, so nothing was removed");
        say(db, "rotate", Kind::Http, &message, Some(&url));
        return Err(message);
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// The rendezvous, and the join retry
// ---------------------------------------------------------------------------------------

/// What a 409 from the rendezvous says.
///
/// **Its own sentence, and not "the pairing failed".** First-write-wins means a filled slot is
/// somebody else having answered this code — a different situation with a different fix, which is
/// to start a fresh offer on the first device rather than to try again here.
pub const RENDEZVOUS_TAKEN: &str =
    "That pairing code has already been answered on another device. Start a new one on the \
     device showing the code.";

/// What `GET /p/{rv}/{slot}` answers when the slot is filled.
#[derive(Debug, Clone, Deserialize)]
struct RendezvousPage {
    blob: String,
}

/// Post one side's blob to the rendezvous, keyed on the token both devices derived
/// [`crypto::rendezvous_id`] from.
///
/// `slot` is `offer` or `join`, and first-write-wins on each: a 409 means the other device
/// already answered this exact code, which is [`RENDEZVOUS_TAKEN`] rather than an ordinary
/// failure. The body is written by hand — this crate does not enable reqwest's `json` feature,
/// the rule every other request in this file already follows.
pub async fn post_rendezvous(
    db: &impl Store,
    rv: &str,
    slot: &str,
    blob: &str,
) -> Result<(), String> {
    let base = db.with(|conn| Ok(entitlement::base(conn)))?;
    let url = format!("{base}/p/{rv}/{slot}");
    let body = serde_json::json!({ "blob": blob }).to_string();
    let response = match relay()?
        .post(&url)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            say(db, "rendezvous", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    let status = response.status();
    if status == 204 {
        return Ok(());
    }
    if status == 409 {
        return Err(RENDEZVOUS_TAKEN.to_owned());
    }
    let message = format!("the relay answered {status} to a rendezvous post");
    say(db, "rendezvous", Kind::Http, &message, Some(&url));
    Err(message)
}

/// Poll the rendezvous for the other side's blob.
///
/// **A 404 is `Ok(None)`, and never an error** — the panel polls this every 1.5 seconds while
/// the other device is still being read to, and a poll that treated "not yet" as a failure would
/// put an error in front of the reader on every tick before the pairing has had any chance to
/// finish.
pub async fn get_rendezvous(
    db: &impl Store,
    rv: &str,
    slot: &str,
) -> Result<Option<String>, String> {
    let base = db.with(|conn| Ok(entitlement::base(conn)))?;
    let url = format!("{base}/p/{rv}/{slot}");
    let response = match relay()?.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            say(db, "rendezvous", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    let status = response.status();
    if status == 404 {
        return Ok(None);
    }
    if !(200..300).contains(&status) {
        let message = format!("the relay answered {status} to a rendezvous poll");
        say(db, "rendezvous", Kind::Http, &message, Some(&url));
        return Err(message);
    }
    let text = match response.text().await {
        Ok(t) => t,
        Err(e) => {
            say(db, "rendezvous", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    let page: RendezvousPage = match serde_json::from_str(&text) {
        Ok(p) => p,
        Err(e) => {
            say(db, "rendezvous", Kind::Parse, &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    Ok(Some(page.blob))
}

/// Carry a join to the rest of the group. **Best effort, and its failure is recorded rather than
/// raised.**
///
/// A first pairing is the common case that *cannot* publish: `/rotate`'s door is the group auth or
/// the refresh secret, and a group that has never claimed has no entitlement row, so it answers
/// 401. That is not an error the reader can act on — nothing is syncing yet, so there is no
/// divergence to carry — so the debt is marked and paid on the first sync that has a membership.
///
/// ⚠️ **This device may only publish a roster it can see the whole of, and the superset check
/// below is what enforces that.** A manifest's key set *is* the roster on every device that
/// adopts it, so a manifest built from a partial view does not merely fail to add anybody — it
/// **evicts** whoever it leaves out. That is not hypothetical: `identity::adopt_epoch` prunes and
/// **never inserts** (there is no public key anywhere in a manifest to insert *with* —
/// `relay/src/rotate.ts` answers `devices: Object.keys(manifest.keys)`, ids only), so a device
/// that adopted somebody else's rotation learns *who left* and never *who joined*. Pair a third
/// device from such a device and its `plan_join` would omit the peer it was never told about,
/// whose next `check_keys` would read a higher epoch with no blob for itself and leave a group
/// nobody removed it from.
///
/// So: **publish only when what this device would publish already names everybody the relay
/// knows about.** When it does, the manifest is that set plus the joiner and nobody can be
/// dropped. When it does not, this is the device with the partial view and it must not speak for
/// the group: the debt is marked, nothing is published, and the join still succeeds locally —
/// which is exactly what pairing did before roster publishing existed, so the floor is the
/// behaviour that shipped rather than a regression.
///
/// **The real fix is a wire change and is deliberately not attempted here.** Carrying each
/// device's public key in the manifest would let `adopt_epoch` *add* a row, and then every
/// device's roster would converge on the relay's. That is a protocol change on both sides; until
/// it exists, a device that has been told about a join only by adopting an epoch still cannot
/// pair a fourth device into the whole group — it can only decline to break it.
///
/// ⚠️ **`commit_rotation` after the relay accepts, and never before or not at all.** `plan`'s
/// manifest names **every device on the roster, this one included** — `create_group` and
/// `join_group` both `add_device(me)`, so `roster()` returns this device too, which is what
/// `check_keys` itself says one screen up and what
/// `identity::tests::a_departure_names_everyone_but_this_device` exists to pin. So the relay
/// *would* hold a blob for this device at *N+1* and a missing commit is **not** read as a
/// removal. It is recovered instead: this device sits at *N*, its next `check_keys` reads a
/// higher epoch **with** a blob, and tries this device itself as the sealer — so it adopts its own
/// rotation. That is the fallback for a lost 2xx or a failed commit and not a licence to skip the
/// commit: until it runs the device stands a trip behind. (Until `check_keys` tried itself, the
/// adopt loop skipped this device, every candidate failed the AEAD and the device stalled at *N*
/// for good.) This is `remove_device`'s order exactly.
pub async fn publish_join(db: &impl Store) -> Result<(), String> {
    let owing = |conn: &Connection| identity::set_roster_dirty(conn, true);
    // The plan, or the debt marked in the stretch that found there was none to make.
    let plan = db.with(|conn| match identity::plan_join(conn) {
        Ok(plan) => Ok(Some(plan)),
        Err(_) => owing(conn).map(|()| None),
    })?;
    let Some(plan) = plan else {
        return Ok(());
    };
    // **One `/keys` read of its own rather than a value threaded down from `check_keys`.** That
    // call does fetch the same manifest on every sync — but it is not on *this* function's other
    // path at all: `pairing::confirm` calls straight in with no sync in front of it, and that is
    // the very path an ordinary pairing takes. Threading the value would leave the confirm path
    // needing its own read anyway, so there would be two shapes and two behaviours to keep in
    // step. The cost is one GET per pairing, plus one per sync only while the debt is
    // outstanding — `round_trip` does not call this otherwise.
    let Ok(known) = relay_manifest(db).await else {
        // Unreachable, refused, or a group with no membership at all — the common first
        // pairing. Nothing can be concluded about the group's roster, so nothing is published.
        return db.with(owing);
    };
    let mine: std::collections::HashSet<&str> =
        plan.keys.iter().map(|(id, _)| id.as_str()).collect();
    // The comparison is against `plan.keys` and not against `roster()` itself, because
    // `plan_excluding` drops any row an older build stamped `revoked_at` — so the plan is what
    // would actually be published, and it is the only set whose superset-ness proves nobody is
    // evicted. An empty `known` (a group that has claimed and never rotated answers
    // `devices: []`) is a subset of everything, which is what keeps the common case publishing.
    if !known.iter().all(|id| mine.contains(id.as_str())) {
        return db.with(owing);
    }
    if post_rotation(db, &plan).await.is_err() {
        // Nothing committed, so the group is exactly as it was and the debt is recorded.
        return db.with(owing);
    }
    // **The plan was made before two requests and is committed behind them**, against the same
    // group and the same roster: both move only under the lane this operation holds.
    //
    // `""` removes nobody: `commit_rotation`'s `DELETE … WHERE device_id = ?1` matches no row,
    // which is what a join wants. Its `baselined_at = NULL` sweep is wanted in full — a joining
    // device needs every peer's last words carried across the epoch boundary. The commit and the
    // cleared mark are one stretch, so no reader of the mark sees a committed join still owing.
    db.with(|conn| {
        identity::commit_rotation(conn, "", &plan)?;
        identity::set_roster_dirty(conn, false)
    })
}

// ---------------------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------------------

/// Everything this device has not handed over yet, oldest first.
fn unpushed(conn: &Connection) -> Result<Vec<(i64, Op)>, String> {
    let sql = format!(
        "{} WHERE pushed_at IS NULL ORDER BY seq",
        capture::OPS_SELECT
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], capture::op_from_row)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Why [`post_ops`] did not land a batch.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Refusal {
    /// **409 `stale_epoch`**: sealed below the group's epoch, so this device is behind a rotation
    /// that landed after its `/keys` check. **Not recorded here**, because [`push`] can still
    /// mend it — catch up and re-seal — and a row for a refusal the same trip then cleared would
    /// report a sync that worked.
    Stale,
    /// **422 `clock_ahead`**: stamped more than a day past the relay's clock. **Not recorded
    /// here either**, for `Stale`'s reason — [`push`] may mend it by [`rebase`] — and because a
    /// baseline's refusal needs a sentence of its own ([`emit_baselines`]).
    ClockAhead,
    /// A refusal retrying will not clear inside this trip ([`Deferral`]), already recorded in
    /// [`refused_push`]'s sentence.
    Deferred(Deferral),
    /// Anything else, already recorded (or a lapse, which records nothing): the sentence to
    /// answer with.
    Failed(String),
}

/// Seal one batch of ops and hand it to the relay, **touching `sync_ops` not at all**.
///
/// Factored out of [`push`], which keeps its own `pushed_at` bookkeeping and calls this for the
/// bytes. The second caller is [`emit_baselines`], which has nothing to file: a baseline is
/// built in memory, sealed, pushed and forgotten (spec §5.1), so a function that both sent the
/// bytes *and* stamped a row could not have served it.
///
/// Every failure is recorded under the operation `push`, because that is what it is from the
/// relay's side and from the reader's — one endpoint, one `error_log` row to fold onto. The
/// exceptions are a 401, which [`lapsed`] handles and does not record at all, and
/// [`Refusal::Stale`] and [`Refusal::ClockAhead`], which are the caller's to mend or record. **A
/// refusal an updated relay explains is recorded in its own sentence** ([`refused_push`]),
/// matched on its `code`.
async fn post_ops(
    db: &impl Store,
    base: &str,
    token: &str,
    group: &Group,
    device: &str,
    ops: &[Op],
) -> Result<(), Refusal> {
    let url = format!("{base}/g/{}/push", group.group_id);
    let envelope = match wire::seal_batch(group, device, ops) {
        Ok(e) => e,
        Err(e) => {
            say(db, "push", Kind::Other, &e.to_string(), None);
            return Err(Refusal::Failed(e.to_string()));
        }
    };
    let body = serde_json::to_string(&envelope).map_err(|e| Refusal::Failed(e.to_string()))?;
    let response = relay()
        .map_err(Refusal::Failed)?
        .post(&url)
        .header("content-type", "application/json")
        .header("authorization", &format!("Bearer {token}"))
        .body(body)
        .send()
        .await;
    let response = match response {
        Ok(r) => r,
        Err(e) => {
            say(db, "push", kind_of(&e), &e.to_string(), Some(&url));
            return Err(Refusal::Failed(e.to_string()));
        }
    };
    let status = response.status();
    if status == 401 {
        return Err(Refusal::Failed(lapsed_in(db, "a push")));
    }
    if !(200..300).contains(&status) {
        let code = refusal_code(&response.text().await.unwrap_or_default());
        match code.as_deref() {
            Some(STALE_EPOCH) => return Err(Refusal::Stale),
            Some(CLOCK_AHEAD) => return Err(Refusal::ClockAhead),
            _ => {}
        }
        let message = refused_push(status, code.as_deref());
        say(db, "push", Kind::Http, &message, Some(&url));
        return Err(match Deferral::of(code.as_deref()) {
            Some(deferral) => Refusal::Deferred(deferral),
            None => Refusal::Failed(message),
        });
    }
    match response.text().await {
        Ok(text) => {
            if let Err(e) = serde_json::from_str::<PushReceipt>(&text) {
                say(db, "push", Kind::Parse, &e.to_string(), Some(&url));
                return Err(Refusal::Failed(e.to_string()));
            }
        }
        Err(e) => {
            say(db, "push", kind_of(&e), &e.to_string(), Some(&url));
            return Err(Refusal::Failed(e.to_string()));
        }
    }
    Ok(())
}

/// The sentence for a push the relay refused, **by the refusal's `code` and never its `error`**.
///
/// Each says what happens to what this device wrote, because the answer to every one of them is
/// the same and is the thing a reader looking at this row needs: **nothing was lost**. A refused
/// batch leaves `pushed_at` NULL, so it is kept here and offered again on the next trip.
/// `clock_ahead` is not here: whether it can be mended decides what is true to say about it, so
/// [`push`] and [`emit_baselines`] each say it ([`CLOCK_STILL_AHEAD`], [`CLOCK_PINNED`],
/// [`BASELINE_CLOCK_AHEAD`]).
fn refused_push(status: u16, code: Option<&str>) -> String {
    match code {
        // Unreachable while `wire::batches` cuts under the cap and [`push`] sets aside the one op
        // no cut can save — so this is the two sides disagreeing about a size, which is a bug.
        Some(TOO_LARGE) => "the relay refused a batch of this device's changes as too large to \
                            store. They are kept on this device."
            .to_owned(),
        Some(QUOTA) => "this sync group's relay storage is full, so what this device wrote waits \
                        here until there is room again."
            .to_owned(),
        Some(EPOCH_AHEAD) => "the relay has not reached the group key change this device's \
                              changes were sealed under, so they wait here and are offered again \
                              on the next sync."
            .to_owned(),
        _ => format!("the relay answered {status} to a push"),
    }
}

/// What a push refused as `clock_ahead` records when this device's own clock is the one still
/// ahead — [`rebase`]'s [`Rebase::StillAhead`], or a push refused again after one. Nothing here
/// can restamp a change earlier than a wall clock that is itself wrong, so the fix is the reader's,
/// and once they have made it the next sync's [`rebase`] sends what waited.
const CLOCK_STILL_AHEAD: &str = "this device's clock is set more than a day ahead of the relay's, \
                                 so the changes it stamps cannot sync. Set the date and time \
                                 right; this device's changes then go out on its next sync.";

/// What a push refused as `clock_ahead` records when [`rebase`] may not move the stamps
/// ([`Rebase::Pinned`]): something this device has already sent or received is stamped that far
/// ahead, and what it wrote since has to stay after it. **Time is the only fix**, so the sentence
/// sends the reader to no setting.
const CLOCK_PINNED: &str = "this device's clock was once set more than a day ahead, and changes \
                            stamped with that time have already been sent or received here. What \
                            it has written since has to come after them, so it waits here until \
                            the real date and time reach them.";

/// What a push refused as `stale_epoch` answers when catching up did not mend it — a second
/// refusal after [`check_keys`] adopted, which means the relay's epoch and the manifest's
/// disagree, or another rotation landed in the same breath. Recorded, and the next trip tries
/// again from its own `/keys` check.
fn stale_twice(db: &impl Store, url: &str) -> String {
    let message = "the relay refused this device's changes as sealed under a group key it has \
                   moved past, even after this device caught up with the key change. They are \
                   kept here and offered again on the next sync."
        .to_owned();
    say(db, "push", Kind::Http, &message, Some(url));
    message
}

/// Mark `seqs` handed over.
fn stamp_pushed(conn: &Connection, seqs: &[i64]) -> Result<(), String> {
    let holes: Vec<String> = (1..=seqs.len()).map(|n| format!("?{n}")).collect();
    conn.execute(
        &format!(
            "UPDATE sync_ops SET pushed_at = unixepoch() WHERE seq IN ({})",
            holes.join(", ")
        ),
        rusqlite::params_from_iter(seqs.iter()),
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// What a change that can never be sent says: the table, the row, how large it is — and that it
/// stays. `whom` is who goes without it.
///
/// **An op that will not serialize has no size to give**, and `wire::op_bytes` measures one as
/// `usize::MAX` so that [`wire::oversized`] sets it aside rather than sealing it. Measured here it
/// printed "0.0 MB, more than the relay takes", which is two false statements in one clause, so
/// that case says only what is true of it.
fn unsendable(op: &Op, whom: &str) -> String {
    match serde_json::to_vec(op) {
        Ok(json) => format!(
            "A change to {} (row {}) is {:.1} MB, more than the relay takes in one piece, so \
             {whom} cannot be sent it. It is kept on this device.",
            op.table,
            op.uid,
            json.len() as f64 / 1_000_000.0
        ),
        Err(_) => format!(
            "A change to {} (row {}) could not be written out to send, so {whom} cannot be sent \
             it. It is kept on this device.",
            op.table, op.uid
        ),
    }
}

/// What [`rebase`] found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rebase {
    /// The pending ops stamped after the base are stamped again from it and the clock is set back
    /// with them: push again.
    Done,
    /// `sync_clock` is not more than a day past the wall clock, so the wall clock is what is
    /// ahead — no stamp this device can make is any earlier than it. [`CLOCK_STILL_AHEAD`].
    StillAhead,
    /// The clock was set right, but something this device has already sent or received is stamped
    /// too far ahead for what it wrote since to go under it. [`CLOCK_PINNED`].
    Pinned,
}

/// **Stamp again what this device wrote while its clock was ahead, once the clock is right** — run
/// when a push is refused `clock_ahead`, before the push is deferred (issue #546's review, finding
/// 2b).
///
/// # Why setting the clock right was not enough
///
/// Capture stamps `max(sync_clock, wall)` and `sync_clock` only moves forward — a clock that
/// retreated would stamp an edit before the ops it followed ([`hlc::Hlc::tick`]) — so one write
/// made while the date was a year ahead stamped every write after it a year ahead too, long after
/// the reader had set the date right. The relay refuses all of them, and the sentence that told the
/// reader to fix the clock promised a recovery that never came.
///
/// # When it may
///
/// * **This device's clock has been set right**: `sync_clock` is more than [`hlc::MAX_AHEAD_MS`]
///   past the wall clock. When it is not, the wall clock itself is what is ahead
///   ([`Rebase::StillAhead`]), and there is nothing earlier to stamp with.
/// * **Nothing this device has sent or received is that far ahead.** The base is the latest of the
///   wall clock, the highest stamp it has observed from any device (its `sync_peers` watermarks)
///   and the highest of its own ops with `pushed_at` set. When the base is itself too far ahead —
///   a future-stamped op reached a relay that did not refuse it yet, or a peer's did and applied
///   here, or an op too large to send was stamped over — it refuses ([`Rebase::Pinned`]): what it
///   wrote has to stay after the base, so no stamp it could take would pass the relay's bound, and
///   restamping it *below* an op the group already holds would put this device's own history in
///   one order here and another on every other device. That is divergence, and waiting is not.
///
/// # What it does, in one transaction
///
/// Every pending op (`pushed_at IS NULL`) **stamped after the base** is stamped again, in `seq`
/// order, with successive [`hlc::Hlc::tick`]s from the base under this device's id, and
/// `sync_clock` is set to the last of them — to the base itself when none was after it. By hand,
/// because the `sync_ops_clock` trigger follows an `INSERT` and this is an `UPDATE`.
///
/// # Why it converges
///
/// * **Nobody has seen the old stamps.** Only pending ops move, and a pending op has never left
///   this device, so there is no copy anywhere for its new stamp to disagree with.
/// * **This device's own order is kept.** Its stamps rise with `seq` — the clock follows every op
///   it stamps — so the ops after the base are the outbox's tail. The ticks keep their order among
///   themselves and put them after every other op this device wrote: the pending ones left where
///   they are, at or below the base, and every pushed one, which the base is at or above.
/// * **Every last-writer-wins decision this device has already made is the one the others will
///   make.** A restamped op was stamped after everything this device had observed, so here it
///   beat every remote op it met; it still sorts after all of them, because the base is at or
///   above every watermark. An op from a device not yet heard from meets the new stamp here and
///   everywhere else alike.
/// * **Not every pending op, and that is what the previous point depends on.** A pending op at or
///   below the base may sit below a remote op this device has already applied — a push deferred
///   for the quota does not stop the pull — and on the same row that remote op won here. Lifted
///   over it, the pending op would win on every other device: the same row, two answers. At or
///   below the base it is inside the relay's bound already, so it has no reason to move.
fn rebase(conn: &Connection, device: &str) -> Result<Rebase, String> {
    let latest = |sql: &str| -> Result<Option<(i64, i64)>, String> {
        conn.query_row(sql, [], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(|e| e.to_string())
    };
    let wall = wall_ms(conn)?;
    let clock = latest("SELECT ms, ctr FROM sync_clock WHERE id = 1")?;
    if !clock.is_some_and(|(ms, _)| hlc::too_far_ahead(ms, wall)) {
        return Ok(Rebase::StillAhead);
    }
    let observed = latest(
        "SELECT last_ms, last_ctr FROM sync_peers ORDER BY last_ms DESC, last_ctr DESC LIMIT 1",
    )?;
    let sent = latest(
        "SELECT hlc_ms, hlc_ctr FROM sync_ops WHERE pushed_at IS NOT NULL
          ORDER BY hlc_ms DESC, hlc_ctr DESC LIMIT 1",
    )?;
    let base = [Some((wall, 0)), observed, sent]
        .into_iter()
        .flatten()
        .max()
        .unwrap_or((wall, 0));
    if hlc::too_far_ahead(base.0, wall) {
        return Ok(Rebase::Pinned);
    }

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let after: Vec<i64> = {
        let mut stmt = tx
            .prepare(
                "SELECT seq FROM sync_ops
                  WHERE pushed_at IS NULL AND (hlc_ms, hlc_ctr) > (?1, ?2)
                  ORDER BY seq",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![base.0, base.1], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())?
    };
    let mut at = hlc::Hlc {
        ms: base.0,
        ctr: base.1,
        device: device.to_owned(),
    };
    for seq in after {
        at = hlc::Hlc::tick(&at, wall);
        tx.execute(
            "UPDATE sync_ops SET hlc_ms = ?1, hlc_ctr = ?2 WHERE seq = ?3",
            rusqlite::params![at.ms, at.ctr, seq],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "UPDATE sync_clock SET ms = ?1, ctr = ?2 WHERE id = 1",
        rusqlite::params![at.ms, at.ctr],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Rebase::Done)
}

/// Hand every unpushed op to the relay.
///
/// **`pushed_at` is stamped only once the relay has taken the op**, so the next attempt sends the
/// same ops and a network blip costs a retry rather than the reader's changes. The far side's
/// second receipt is free: [`apply`]'s `sync_peers` watermark drops an op it has already applied.
///
/// **Cut by bytes as well as by count** ([`wire::batches`]), so a chunk's rows are found by a
/// running offset into the outbox: slice `i` no longer starts at `i * wire::BATCH`, and computing
/// it that way would stamp rows that were never sent.
///
/// ⚠️ **One exception to "stamped only once taken": an op too large ever to send.** A one-op
/// slice [`wire::oversized`] answers `true` for is refused by the relay (413 `too_large`) on every
/// attempt, and a push stops at its first failure — so left pending, it would stop every op
/// queued behind it, on every trip, for good. It is recorded once ([`unsendable`]), stamped, and
/// stepped over. **Stamped rather than left pending and skipped**, because both honest readings
/// of `pushed_at IS NULL` are false of it: it is not waiting for anything, and the panel's
/// *pending* count would promise a delivery that never comes. Stamping loses nothing on this
/// device — a pushed op is kept, never pruned, and add-wins and the cycle-break read it as this
/// device's history exactly as they read every other — and what it costs the other devices is
/// the change itself, which the recorded sentence names. (A reader's note pasted in the megabytes
/// is how one gets here.)
///
/// **A 409 `stale_epoch` is mended once**: this device is behind a rotation that landed after the
/// trip's `/keys` check, so [`check_keys`] is asked again — a removal stops the push there, `Ok`,
/// with nothing left to push to — and the chunk is re-sealed at the epoch it adopted. The ops are
/// unpushed, so re-sealing them is all a retry needs. A second refusal is recorded and fails the
/// push, and the next trip starts from its own `/keys` check.
///
/// **A 422 `clock_ahead` is mended once too, by [`rebase`]**, and the outbox is read again and
/// pushed from where it stopped — the stamps it was read with have changed. When the rebase may not
/// run, or its retry is refused as well, the refusal is recorded in the sentence that is true of
/// it and the push is deferred.
///
/// ⚠️ **A refusal the relay will repeat defers the push and does not fail it** ([`Deferral`]):
/// `too_large`, `quota`, `epoch_ahead`, and a `clock_ahead` nothing here could mend. It is
/// recorded, **nothing after the refused chunk is sent this trip** — a later chunk landing ahead
/// of an earlier one would carry its sender's watermark on every other device past the ops still
/// waiting here, which would then be skipped as seen — and `Ok` answers with the deferral, so the
/// trip goes on to pull and ack. Failing it held both back for as long as the refusal lasted.
pub async fn push(db: &impl Store, base: &str, token: &str) -> Result<Pushed, String> {
    let Some((device, mut group)) = db.with(me)? else {
        return Ok(Pushed::default());
    };
    let url = format!("{base}/g/{}/push", group.group_id);
    let mut sent = 0usize;
    let mut caught_up = false;
    let mut rebased = false;

    // Round again only after a rebase, which is the one thing that changes what the outbox reads.
    'outbox: loop {
        // **The outbox as it stands at this moment.** What the reader writes while these chunks
        // are on their way is a row with a higher `seq`: not in this list, and so neither sent nor
        // stamped by this trip. The next one carries it.
        let pending = db.with(unpushed)?;
        let seqs: Vec<i64> = pending.iter().map(|(seq, _)| *seq).collect();
        let ops: Vec<Op> = pending.into_iter().map(|(_, op)| op).collect();
        let mut offset = 0usize;

        for chunk in wire::batches(&ops) {
            let taken = &seqs[offset..offset + chunk.len()];
            offset += chunk.len();
            if chunk.len() == 1 && wire::oversized(chunk) {
                let op = &chunk[0];
                db.with(|conn| {
                    note(
                        conn,
                        "push",
                        Kind::Other,
                        &unsendable(op, "your other devices"),
                        Some(&op.uid),
                    );
                    stamp_pushed(conn, taken)
                })?;
                continue;
            }
            let mut landed = post_ops(db, base, token, &group, &device, chunk).await;
            if matches!(landed, Err(Refusal::Stale)) {
                if caught_up {
                    return Err(stale_twice(db, &url));
                }
                caught_up = true;
                let gone = Pushed {
                    sent,
                    deferred: None,
                };
                if check_keys(db).await?.outcome == KeyOutcome::Removed {
                    return Ok(gone);
                }
                let Some((_, adopted)) = db.with(me)? else {
                    return Ok(gone);
                };
                group = adopted;
                landed = post_ops(db, base, token, &group, &device, chunk).await;
            }
            match landed {
                Ok(()) => {}
                Err(Refusal::Stale) => return Err(stale_twice(db, &url)),
                Err(Refusal::Failed(message)) => return Err(message),
                Err(Refusal::Deferred(deferral)) => {
                    return Ok(Pushed {
                        sent,
                        deferred: Some(deferral),
                    })
                }
                Err(Refusal::ClockAhead) => {
                    // A second refusal after a rebase is the wall clock and the relay's disagreeing
                    // by more than a day, whatever the rebase found.
                    let found = if rebased {
                        Rebase::StillAhead
                    } else {
                        db.with(|conn| rebase(conn, &device))?
                    };
                    if found == Rebase::Done {
                        rebased = true;
                        continue 'outbox;
                    }
                    let message = if found == Rebase::Pinned {
                        CLOCK_PINNED
                    } else {
                        CLOCK_STILL_AHEAD
                    };
                    say(db, "push", Kind::Http, message, Some(&url));
                    return Ok(Pushed {
                        sent,
                        deferred: Some(Deferral::ClockAhead),
                    });
                }
            }

            // Only now, and one chunk at a time: a run that dies between two chunks has handed the
            // first over and is honest about it.
            db.with(|conn| stamp_pushed(conn, taken))?;
            sent += chunk.len();
        }
        return Ok(Pushed {
            sent,
            deferred: None,
        });
    }
}

// ---------------------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------------------

/// What an envelope from an epoch the relay has reached, and this device has not, records — the
/// one unreadable envelope that holds the cursor rather than being stepped over.
const BEHIND_A_ROTATION: &str = "that batch was sealed under a group key change this device has \
                                 not caught up with yet; it is read on the next sync, once it has";

/// What an envelope claiming an epoch **the relay has never reached** records: no rotation made
/// it, so no key this group ever held sealed it, and it is stepped over.
const NO_SUCH_ROTATION: &str = "that batch claims a group key change the relay has never made, \
                                so no device in this group sealed it; it was skipped";

/// An envelope's stamp — the last op's, and the relay's ordering key.
fn at_of(envelope: &Envelope) -> (i64, i64) {
    (envelope.hlc_ms, envelope.hlc_ctr)
}

/// What [`pull`] took in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Pulled {
    /// Envelopes that could not be opened ([`RelayOutcome::unreadable`]).
    pub unreadable: usize,
    /// What `apply` made of the ones that could.
    pub report: ApplyReport,
    /// Whether the conversions that run behind a pull that read everything wrote a row — which no
    /// count in `report` says. [`RelayOutcome::changed`].
    pub converted: bool,
}

/// The sentence a clock hold records: which device, and roughly how far ahead of this one it is.
///
/// **Neither clock is named as the wrong one**, because this device cannot tell a peer that is
/// fast from itself being slow — and the fix is the same press on whichever it is.
fn clock_sentence(conn: &Connection, device: &str, ahead_ms: i64) -> String {
    let name: String = conn
        .query_row(
            "SELECT coalesce(
                 (SELECT name FROM device_names WHERE device_id = ?1),
                 (SELECT name FROM sync_devices WHERE device_id = ?1),
                 ?1)",
            [device],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| device.to_owned());
    // Rounded rather than cut, because the stamp was compared a moment after it was written: a
    // peer two days fast is two days, not 47 hours.
    let hours = (ahead_ms + 30 * 60 * 1000) / (60 * 60 * 1000);
    let roughly = if hours >= 48 {
        format!("{} days", (hours + 12) / 24)
    } else {
        format!("{hours} hours")
    };
    format!(
        "{name}'s changes are stamped about {roughly} ahead of this device's clock, so they wait \
         here until this device's clock is within a day of them. One of the two clocks is wrong: \
         check the date and time on both devices."
    )
}

/// Take everything the group has said since this device's cursor, and apply it.
///
/// # An unreadable envelope is three different things and only one of them holds
///
/// The plan this was built from says a batch that will not open must not advance the cursor
/// past it. That is right for exactly one of the ways it happens, and a permanent stall for the
/// others:
///
/// * `envelope.epoch > group.epoch`, **at or below the relay's own epoch** — this device is
///   behind a key rotation and has not been handed the new key yet. Those ops become readable, so
///   the cursor stays put and the page is re-delivered until the next trip's [`check_keys`]
///   adopts.
/// * `envelope.epoch > group.epoch`, **above the relay's epoch** — **forged or broken**, and never
///   held. The relay stores an envelope's `epoch` exactly as it was sent, so anyone holding a token
///   could push `{epoch: 1e12}`, and holding on every such envelope held every peer's cursor, and
///   its ack, for ever — which stopped the relay compacting the group's log at all. The relay's
///   epoch is the one that says whether a rotation happened, so an envelope above it is counted,
///   recorded once, and stepped over. (An updated relay refuses that push, 422 `epoch_ahead`; an
///   old relay, and a log stored before the refusal, still hold them.) ⚠️ **But a rotation can
///   land between this trip's `/keys` and its pull**, and the rotator's first push at the new
///   epoch would then be stepped over and lost — so the first envelope above the epoch in hand
///   asks `/keys` again, once per pull, and only one above *that* answer is stepped over. A
///   `relay_epoch` of `None` — which [`round_trip`] never passes for a device in a group, and a
///   test calling this directly may — is simply no epoch in hand, so that ask is the first.
///   **When the ask fails**, the envelope holds as behind: a forgery and a rotation look the same
///   without the relay's word, holding costs one trip, stepping over a real rotation's first push
///   loses it, and a relay whose `/keys` stays unreachable fails the next trip's [`check_keys`]
///   before any pull is made.
/// * `envelope.epoch < group.epoch` — **written before a rotation**. It is opened with the key
///   of its own epoch when [`identity::group_at`] still holds one, which it does across a join:
///   `check_keys` adopts before this runs, so without that key a device offline across any
///   pairing would step over everything the group wrote before it, deletes included, for good.
///   A key it never held, or forgot at a removal (`identity::supersede` says why), opens nothing,
///   and neither does a blob that fails the AEAD — **altered**. Refusing to advance past either
///   would stall the stream for the thirty days the relay keeps a tail, for nothing, so it is
///   counted, written to `error_log`, and stepped over.
///
/// **A fourth way holds, where the batch says a newer build sealed it** (spec 2026-09-27 §3.3):
/// an envelope that opens and does not parse. The AEAD passed, so a member of this group sealed
/// it, and when an op in it carries a schema above this build's (`WireError::Newer`) it is a batch
/// an update will read — an op kind this build has never heard of. It is still counted and noted,
/// and it holds the cursor as `"newer"` ([`PULL_HOLD`]) exactly as a newer schema's held group
/// does, rather than being stepped over and lost — **and so do its sender's batches stamped after
/// it in the page**, which would otherwise apply and carry that sender's watermark past the ops
/// nobody here could read. **One that says nothing of a newer build (`WireError::Malformed`) is
/// stepped over like an altered one**: no update will ever read it, and holding on it would pin
/// the relay's log for good and ask the reader to update a build they already run.
///
/// # A batch that opens and is stamped too far ahead holds too
///
/// A batch carrying an op stamped more than [`hlc::MAX_AHEAD_MS`] past this device's wall clock
/// ([`hlc::too_far_ahead`]) is not applied yet, **and nor is any other batch its sender has in the
/// page**. It holds the cursor as `"clock"`, which time alone resolves ([`PULL_HOLD`] says why hold
/// and not clamp), and is recorded once per hold with a sentence naming the device. Every other
/// device's batches apply.
///
/// * **Only an op `apply` would apply counts** — one above its sender's `sync_peers` watermark,
///   and not this device's own. A far-future batch already applied (by a build before the hold,
///   whose cursor an upgrade then found held) comes back with the page and would only be skipped;
///   counted, it held the cursor until the clock reached it, for nothing.
/// * **The whole sender, by device and not by stamp**, unlike the newer build's rule above. A
///   baseline is stamped from each row's `updated_at` in table order, so one chunk of it can carry
///   stamps above those in a sibling chunk whatever the two envelopes' own stamps say: a batch held
///   by stamp let the other apply, its sender's watermark rose past ops still waiting, and the
///   release skipped them as seen. A clock hold is an anomaly and holding the sender whole is the
///   one shape the watermark cannot outrun. What it costs is the sender's ordinary batches waiting
///   beside the fast one.
///
/// **What either rule holds back still goes to `apply`, as held and never applied** (the baseline
/// claim design of 2026-10-03, §5): there it joins the group of a row that carries a claim, and
/// holds that group, so another sender's claim for a row one of its puts is inside waits with it
/// rather than landing ahead of it. On a row with no claim it joins nothing and holds nothing.
///
/// **An envelope stepped over opens the gap** (§7) — every unreadable one but those held behind a
/// rotation and those only a newer build can read. It is an op this device will never apply, so
/// no emitter's generation can be called wholly taken across it.
///
/// **Every envelope recorded is recorded once per hold**, not once per pull: a held page comes back
/// on every trip, and [`Hold::noted`] is what a later pull behind the same hold asks first.
pub async fn pull(
    db: &impl Store,
    base: &str,
    token: &str,
    relay_epoch: Option<i64>,
) -> Result<Pulled, String> {
    // One stretch: who this is, where its cursor stands, and what an earlier pull behind the
    // same hold already recorded.
    let stood = db.with(|conn| {
        let Some((device, group)) = me(conn)? else {
            return Ok(None);
        };
        let cursor: i64 = get_state(conn, PULL_CURSOR)
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let recorded = read_hold(conn).map(|h| h.noted).unwrap_or_default();
        Ok(Some((device, group, cursor, recorded)))
    })?;
    let Some((device, group, cursor, recorded)) = stood else {
        return Ok(Pulled::default());
    };
    let url = format!(
        "{base}/g/{}/pull?since={cursor}&device={device}",
        group.group_id
    );
    let response = match relay()?
        .get(&url)
        .header("authorization", &format!("Bearer {token}"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            say(db, "pull", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    let status = response.status();
    if status == 401 {
        return Err(lapsed_in(db, "a pull"));
    }
    if !(200..300).contains(&status) {
        let message = format!("the relay answered {status} to a pull");
        say(db, "pull", Kind::Http, &message, Some(&url));
        return Err(message);
    }
    let text = match response.text().await {
        Ok(t) => t,
        Err(e) => {
            say(db, "pull", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    let page: PullPage = match serde_json::from_str(&text) {
        Ok(p) => p,
        Err(e) => {
            say(db, "pull", Kind::Parse, &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };

    // The relay's epoch as this pull knows it, and whether this pull has asked `/keys` itself —
    // `Some(true)` for an answer, `Some(false)` for an ask that failed. **Once per pull, and
    // ahead of the page rather than at the envelope that calls for it**: it is the one request
    // the page's reading makes, and asked here everything below is a single stretch. Which
    // envelopes hold and which are stepped over comes out the same — the answer only ever raises
    // the epoch in hand, and an envelope at or below the old one was held either way.
    let mut relay = relay_epoch;
    let mut asked: Option<bool> = None;
    let ahead = |envelope: &Envelope| {
        envelope.epoch > group.epoch && relay.is_none_or(|r| envelope.epoch > r)
    };
    if page.envelopes.iter().any(ahead) {
        let fresh = fetch_key_page(db, base, &device, &group).await;
        asked = Some(fresh.is_ok());
        if let Ok(fresh) = fresh {
            relay = Some(relay.map_or(fresh.epoch, |r| r.max(fresh.epoch)));
        }
    }

    // **From here to the end is one stretch**: the page is opened, measured against this
    // device's clock and watermarks, applied, and the cursor moved or held — against one state
    // of the database, with the conversions that follow an advancing pull behind it.
    db.with(|conn| {
        let mut opened: Vec<(&Envelope, Vec<Op>)> = Vec::new();
        let mut unreadable = 0usize;
        // The unreadable envelopes this pull steps over — every one that neither holds behind a
        // rotation nor is a batch only a newer build can read. Each is an op this device will
        // never apply, which is a gap (design 2026-10-03 §7).
        let mut stepped_over = 0usize;
        let mut behind = false;
        // Sender → the stamp of its earliest batch in this page that only a newer build can read.
        let mut unparsed: std::collections::BTreeMap<&str, (i64, i64)> = Default::default();
        // What this pull met, beside what an earlier one behind the same hold already recorded.
        let mut met: Vec<(String, i64, i64)> = Vec::new();
        for envelope in &page.envelopes {
            // Whether this envelope, if it does not open, is kept for a later pull rather than
            // stepped over.
            let mut kept = false;
            let failure = if envelope.epoch > group.epoch {
                if relay.is_some_and(|r| envelope.epoch <= r) || asked != Some(true) {
                    behind = true;
                    kept = true;
                    BEHIND_A_ROTATION.to_owned()
                } else {
                    NO_SUCH_ROTATION.to_owned()
                }
            } else {
                let held = if envelope.epoch < group.epoch {
                    identity::group_at(conn, &group, envelope.epoch).map_err(|e| e.to_string())?
                } else {
                    None
                };
                match wire::open_batch(held.as_ref().unwrap_or(&group), envelope) {
                    Ok(batch) => {
                        opened.push((envelope, batch));
                        continue;
                    }
                    Err(e) => {
                        // Opened, so a member of the group sealed it, and an op in it says a newer
                        // build did. See the doc above; `Malformed` falls through and is stepped over.
                        if let WireError::Newer(_) = e {
                            kept = true;
                            unparsed
                                .entry(envelope.device.as_str())
                                .and_modify(|first| *first = (*first).min(at_of(envelope)))
                                .or_insert(at_of(envelope));
                        }
                        e.to_string()
                    }
                }
            };
            unreadable += 1;
            if !kept {
                stepped_over += 1;
            }
            let (ms, ctr) = at_of(envelope);
            let this = (envelope.device.clone(), ms, ctr);
            if !recorded.contains(&this) {
                let detail = if envelope.epoch > group.epoch {
                    format!(
                        "{} at epoch {}; this device is at {}, the relay at {}",
                        envelope.device,
                        envelope.epoch,
                        group.epoch,
                        relay.map_or("an epoch it did not say".to_owned(), |r| r.to_string())
                    )
                } else {
                    envelope.device.clone()
                };
                note(conn, "pull", Kind::Parse, &failure, Some(&detail));
            }
            met.push(this);
        }
        let unread_newer = !unparsed.is_empty();

        // Sender → the stamp of its earliest batch carrying an op stamped too far ahead of this
        // device's clock that `apply` would not skip, and the furthest such stamp, which is what the
        // sentence says.
        let wall = wall_ms(conn)?;
        let applied = watermarks(conn)?;
        let mut ahead: std::collections::BTreeMap<&str, ((i64, i64), i64)> = Default::default();
        for (envelope, batch) in opened.iter().map(|(e, b)| (*e, b)) {
            let Some(furthest) = batch
                .iter()
                .filter(|op| {
                    op.at.device != device
                        && applied
                            .get(&op.at.device)
                            .is_none_or(|seen| (op.at.ms, op.at.ctr) > *seen)
                })
                .map(|op| op.at.ms)
                .filter(|&ms| hlc::too_far_ahead(ms, wall))
                .max()
            else {
                continue;
            };
            let at = at_of(envelope);
            ahead
                .entry(envelope.device.as_str())
                .and_modify(|(first, most)| {
                    *first = (*first).min(at);
                    *most = (*most).max(furthest);
                })
                .or_insert((at, furthest));
        }
        for (sender, (first, furthest)) in &ahead {
            let this = ((*sender).to_owned(), first.0, first.1);
            if !recorded.contains(&this) {
                note(
                    conn,
                    "pull",
                    Kind::Other,
                    &clock_sentence(conn, sender, furthest - wall),
                    Some(sender),
                );
            }
            met.push(this);
        }

        // Sender → the stamp of its earliest batch in the page: where a clock hold's block sits, since
        // it holds every batch of its sender.
        let mut earliest: std::collections::BTreeMap<&str, (i64, i64)> = Default::default();
        for (envelope, _) in &opened {
            earliest
                .entry(envelope.device.as_str())
                .and_modify(|first| *first = (*first).min(at_of(envelope)))
                .or_insert(at_of(envelope));
        }

        // **A sender's batches stamped at or after one only a newer build can read wait with the
        // cursor**, or they would carry its watermark past the held ops, which the re-delivery would
        // then skip as seen — by stamp, not page position, so earlier ones are safe. **A sender held
        // for its clock waits whole** (the doc above says why by device). A `Malformed` batch holds
        // nothing and keeps nothing back: it is stepped over.
        //
        // **What is held back is no longer taken out of the page** (design 2026-10-03 §5): it goes
        // to `apply` as held, never applied, and holds the group of each of its rows that carries a
        // claim — and no other — so a claim that contains one of its puts cannot land ahead of it.
        // **Each opened batch goes to exactly one of the two lists**, and that is load-bearing: an
        // op passed both as `ops` and as `held_back` is grouped twice.
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
        // Held behind a newer build's batch, which is what `held_newer` counts — and a block of the
        // hold's, at the first such batch, unless `apply` holds its sender earlier still. A sender held
        // for its clock is deferred and a block the same way, at its earliest batch, and counted in no
        // class of `apply`'s.
        report.held_newer += held_behind;
        // The held-back ops only — `apply` counts none of them, whatever its group became. A fresh
        // op `apply` holds with them — another op in a held-back op's group, such as an earlier one
        // of the same sender on that row, or collateral behind its block — is counted in no class
        // only where its group's class is `HeldBack`; where another op's block makes the group
        // `Newer` or `Waiting`, `apply` counts its fresh ops in `held_newer` or `held_waiting`, and
        // they reach `deferred` there. **The cursor decision below is
        // unaffected**: `held_back` is non-empty only when `held_clock > 0` or `unread_newer` (a
        // `held_behind` op sits behind a batch `unparsed` names), and either one holds the page
        // as `"clock"` or `"newer"` before `held_waiting` is ever asked.
        report.deferred += held_behind + held_clock;
        if stepped_over > 0 {
            // An envelope stepped over is an op this device will never apply (design §7).
            emission::open_gap(conn).map_err(|e| e.to_string())?;
        }
        let firsts = unparsed.iter().map(|(device, at)| (*device, *at)).chain(
            ahead
                .keys()
                .filter_map(|device| earliest.get(device).map(|at| (*device, *at))),
        );
        for (device, at) in firsts {
            blocks
                .entry(device.to_owned())
                .and_modify(|first| *first = (*first).min(at))
                .or_insert(at);
        }
        // **The cursor moves to the page head only when nothing here can still apply** — the relay
        // answers only rows above it, and `apply` keeps no copy of what it held, so stepping past a
        // held op loses it and every later op of its device in this page for good. Holding is what
        // makes the relay hand the page back, and `sync_peers` is what makes that re-delivery safe:
        // what applied is skipped and what was held applies once, when it can. The ack follows the
        // cursor, so the relay keeps the held rows. Spec 2026-09-27 §3.3, in order — **the kind a
        // hold records is the one that will outlast the others**, since that is the one the panel has
        // to explain:
        //
        // 1. `behind` a key rotation the relay has reached — held, as it always was; the next trip's
        //    `check_keys` brings the key, so it records no kind at all.
        // 2. A newer schema's held group, or a batch that opened, did not parse and says a newer
        //    build sealed it — held, with no bound, until this device updates. Nothing but the reader
        //    resolves it, so it names the hold over a clock or a wait beside it.
        // 3. A batch stamped more than `hlc::MAX_AHEAD_MS` ahead of this device's clock — held until
        //    the clock comes within the bound, which time does on its own. Over a wait, because a wait
        //    is bounded shorter still: its count simply starts once the clock hold has cleared.
        // 4. A group waiting on a parent — held until [`WAITING_PULLS`] pulls spanning
        //    [`WAITING_SECS`] have found the same blocks ([`Hold::blocks`]), then released: the page
        //    is applied once more with [`apply::Waiting::Release`], which drops and records the group
        //    and applies what sat behind it, and the cursor moves.
        // 5. Otherwise — every group applied, skipped, moot or dropped — the cursor moves and any
        //    hold is cleared.
        let advance = if behind {
            false
        } else if report.held_newer > 0 || unread_newer {
            note_hold(conn, "newer", blocks, met)?;
            false
        } else if held_clock > 0 {
            note_hold(conn, "clock", blocks, met)?;
            false
        } else if report.held_waiting > 0 {
            let hold = note_hold(conn, "waiting", blocks, met.clone())?;
            if hold.pulls >= WAITING_PULLS && now_secs(conn)? - hold.since >= WAITING_SECS {
                let (released, still) =
                    apply::apply_page(conn, &ops, &held_back, apply::Waiting::Release)?;
                // What the first pass applied or consumed is below its watermark now and skipped
                // here, so these add without counting anything twice.
                report.applied += released.applied;
                report.resurrected += released.resurrected;
                report.cycles_broken += released.cycles_broken;
                report.moot += released.moot;
                report.dropped += released.dropped;
                report.held_waiting = released.held_waiting;
                report.held_newer = released.held_newer;
                report.deferred = released.deferred;
                // **A release can uncover a newer group.** Collateral takes its block's class, so
                // a device that pushed a waiting child from an older build and then a newer
                // build's op behind it reports the newer op as waiting until the release attempts
                // it — and a release that then advanced would lose it.
                if released.held_newer > 0 {
                    note_hold(conn, "newer", still, met)?;
                    false
                } else {
                    clear_hold(conn)?;
                    true
                }
            } else {
                false
            }
        } else {
            clear_hold(conn)?;
            true
        };
        let mut converted = false;
        if advance {
            set_state(conn, PULL_CURSOR, &page.cursor.to_string()).map_err(|e| e.to_string())?;
            // **Both conversions below are captured, so whatever they write is a new `sync_ops`
            // row** — which is how [`RelayOutcome::changed`] hears about it: neither counts in `apply`'s
            // report, and only one answers a count at all.
            let before = last_op(conn)?;
            // **User schema v52's art picks convert here on a paired device, and only behind a pull
            // that read everything.** A conversion before this device has heard its group can insert
            // an entry a peer already derived and has edited since, under a later stamp, and revert
            // the edit on every device — `deck_tokens::convert_legacy_picks_at_launch` has the
            // scenario. So the launch pass leaves a paired device's picks alone until this has run
            // once, and this runs behind every pull after, which converts a v51 peer's pick on the
            // pull that brings it. **Not behind a held pull**, whatever held it: an envelope held at
            // an epoch, or a group held for a newer schema or a parent, may be exactly the peer's
            // entries and clears the gate waits for. **Captured**, because `apply` has returned and
            // `capture::suppressed` with it; and logged rather than returned, because the pull
            // itself has landed and a pick left owing is retried behind the next one.
            if let Err(e) = crate::deck_tokens::convert_legacy_picks_after_pull(conn) {
                eprintln!(
                    "the decks' pre-v52 token art picks could not be converted after a pull: \
                 {e}\nThey are tried again behind the next pull."
                );
            }
            // **User schema v53's net, behind the same pulls and for the same reasons**: a v52
            // peer's theory card arrives filed in a live pile, and this refiles it into the plan's
            // pile of that name, captured, on the pull that brings it
            // (`deck_meta::refile_stray_theory_cards`).
            if let Err(e) = crate::deck_meta::refile_stray_theory_cards_after_pull(conn) {
                eprintln!(
                    "the plans' cards filed in the actual list's categories could not be refiled \
                 after a pull: {e}\nThey are tried again behind the next pull."
                );
            }
            converted = last_op(conn)? != before;
        }
        Ok(Pulled {
            unreadable,
            report,
            converted,
        })
    })
}

/// The newest `sync_ops` row's `seq`, or 0 for none.
fn last_op(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT coalesce(max(seq), 0) FROM sync_ops", [], |r| {
        r.get(0)
    })
    .map_err(|e| e.to_string())
}

/// Every device's `sync_peers` watermark as `(ms, ctr)`: how far `apply` has applied from it, at
/// or below which it would only skip.
fn watermarks(conn: &Connection) -> Result<std::collections::BTreeMap<String, (i64, i64)>, String> {
    let mut stmt = conn
        .prepare("SELECT device_id, last_ms, last_ctr FROM sync_peers")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?))))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())
}

/// Tell the relay how far this device has consumed, which is what compaction reads.
pub async fn ack(db: &impl Store, base: &str, token: &str) -> Result<(), String> {
    // One stretch: who this is, how far it has consumed, and whether the relay already knows.
    let owed = db.with(|conn| {
        let Some((device, group)) = me(conn)? else {
            return Ok(None);
        };
        let cursor: i64 = get_state(conn, PULL_CURSOR)
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let acked: Option<i64> = get_state(conn, LAST_ACKED).and_then(|v| v.parse().ok());
        Ok((acked != Some(cursor)).then_some((device, group, cursor)))
    })?;
    let Some((device, group, cursor)) = owed else {
        return Ok(());
    };
    let url = format!("{base}/g/{}/ack", group.group_id);
    // Written by hand rather than through reqwest's `json` feature, which this crate does not
    // enable: `serde_json` is already here, and a feature that changes what every other request
    // in the tree is built from is a wide edit for two call sites.
    let body = serde_json::json!({ "device": device, "cursor": cursor }).to_string();
    let response = match relay()?
        .post(&url)
        .header("content-type", "application/json")
        .header("authorization", &format!("Bearer {token}"))
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            say(db, "ack", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    let status = response.status();
    if status == 401 {
        return Err(lapsed_in(db, "an ack"));
    }
    if !(200..300).contains(&status) {
        let message = format!("the relay answered {status} to an ack");
        say(db, "ack", Kind::Http, &message, Some(&url));
        return Err(message);
    }
    // **The cursor the relay was told, not the cursor as it stands now**: both are the same
    // while one trip runs at a time, and the one that was sent is the one this records.
    db.with(|conn| set_state(conn, LAST_ACKED, &cursor.to_string()).map_err(|e| e.to_string()))
}

// ---------------------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------------------

/// What a baseline carrying a row stamped more than a day past this device's clock records, in
/// place of beginning it. The row was last changed while the clock was ahead, and its
/// `updated_at` — which the baseline is stamped from — says so until real time reaches it.
const BASELINE_WAITS_FOR_THE_CLOCK: &str = "rows on this device were last changed while its clock \
                                            was set more than a day ahead, so a device's first \
                                            sync, which carries them, waits here until the real \
                                            date and time reach them.";

/// What a baseline the relay refused as `clock_ahead` records — its rows are stamped within a day
/// of this device's clock (the check above) and still more than a day past the relay's, so it is
/// this device's clock that is ahead.
const BASELINE_CLOCK_AHEAD: &str = "the relay refused a device's first sync as stamped more than \
                                    a day ahead of its clock. Set this device's date and time \
                                    right; the first sync is offered again on the next sync.";

/// Hand a full baseline to every peer that needs one. Spec §10.
///
/// **Built, sealed and pushed without ever touching `sync_ops`** (§5.1). The outbox's contract
/// is "deltas, never values" and a baseline holds values; it is also a table scan away at any
/// moment, so there is nothing worth filing.
///
/// Answers `(ops, history)` — the second is the `deck_audit` share of the first, which the
/// panel names on its own (§13).
///
/// **One emission per peer, which on a group with two new peers is the same rows broadcast
/// twice.** The relay's log is group-wide, so a single push would in fact reach both — but the
/// marker is per peer and records *that peer's* push having landed, and a shared push that
/// failed half way would then have to say which peers it had covered. The ordinary case is one
/// peer; the case that pays for this is two devices having joined between two syncs, and it
/// pays in bandwidth rather than in correctness — claims resolve by `max`, the grain finds the
/// same row and the horizon filters, so a second copy changes nothing anywhere (§10).
///
/// **A refusal the relay will repeat ends the emission and not the trip** ([`Deferral`], and a
/// `clock_ahead`): it is recorded, that peer's marker stays NULL so the next trip starts its
/// baseline over, no other peer's is begun, and `Ok` answers with what landed, so the ack still
/// runs. Failed, it held the ack back for as long as the refusal lasted, exactly as [`push`] did.
/// A transient failure still fails the trip.
///
/// **And a baseline carrying a row stamped too far ahead is not begun at all.** A baseline op is
/// stamped from its row's `updated_at` (`baseline::build`), so a row last edited while this
/// device's clock was a day or more ahead keeps that stamp after the clock is set right — [`rebase`]
/// moves ops, not rows — and the relay would refuse the chunk carrying it after taking the ones
/// before it, which the next trip then pushes again. Recorded once a trip
/// ([`BASELINE_WAITS_FOR_THE_CLOCK`]), and it goes once real time reaches the row.
///
/// ⚠️ **And none is begun while anything at all is pending** (the baseline claim design of
/// 2026-10-03, §5) — whatever left it there: a reader's write since this trip read its outbox,
/// a conversion behind this trip's own pull, or an op an *earlier* refusal deferred. A baseline's
/// rows hold such an op and its horizon covers it, but the op itself is not on the relay's log
/// yet: it goes out with a *later* trip, behind the baseline. A peer reads the claims in one page
/// and the op in a later one, where no horizon stands beside it — the horizon is a filter on one
/// page and writes nothing — and a row a claim has just built counts it a second time. A card out
/// of nothing, which is the one direction a baseline may never fail in (the baseline spec's
/// §8.2). This used to ask only about what was written since the trip read its outbox, and let an
/// op an earlier refusal left pending go out behind the claims; that is the same op arriving a
/// page late, and it is refused for the same reason. Nothing is recorded: the marker stays NULL,
/// and the next trip that pushes the op emits behind it, where the horizon covers only what the
/// log holds. Every deferral leaves its refused ops pending, so none is begun behind any of them
/// now — [`Deferral::stops_baselines`] still answers first for the clock and the quota.
async fn emit_baselines(
    db: &impl Store,
    base: &str,
    token: &str,
) -> Result<(usize, usize), String> {
    let Some((device, group)) = db.with(me)? else {
        return Ok((0, 0));
    };
    let url = format!("{base}/g/{}/push", group.group_id);
    let mut emitted = 0usize;
    let mut history = 0usize;
    for peer in db.with(baseline::peers_needing)? {
        // **The rows, the clock and the horizon are read in ONE stretch, and that is the rule
        // this function has that no other in the trip does.** The horizon says how far each
        // device's ops are already inside the rows; a write landing between the two reads is
        // inside the horizon and outside the rows, so the peer would be handed neither its
        // value nor — the horizon filtering it — its delta. Lost, with nothing to say so.
        //
        // **And the question whether anything is pending is asked in that same stretch**, so the
        // answer is about exactly the rows that were read — and the emission is named there too
        // (design 2026-10-03 §3), so its `id` is a tick of the clock those rows were read under.
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
        // **Every peer's baseline is these same rows**, so what holds one back holds them all.
        let Some((ops, wall, horizon, begun)) = read else {
            break;
        };
        // A device holding nothing has still answered the question, so the marker is stamped
        // and the peer is not asked again next minute. There is no envelope to send: an empty
        // batch is `WireError::Empty`, deliberately, because a relay row holding no ops is a
        // row nobody can act on.
        if ops.is_empty() {
            db.with(|conn| baseline::mark_sent(conn, &peer))?;
            continue;
        }
        // **Every peer's baseline is these same rows**, so one too far ahead for this peer is too
        // far ahead for all of them: recorded once, and none is begun.
        if ops.iter().any(|op| hlc::too_far_ahead(op.at.ms, wall)) {
            say(db, "push", Kind::Other, BASELINE_WAITS_FOR_THE_CLOCK, None);
            break;
        }
        // **A row too large ever to send is left out before the ops are numbered** (design §3),
        // asked of it as a chunk of one with the horizon and the head it would carry, so `n`
        // counts what is sent and an index that never arrives cannot keep the emission untaken.
        // It is recorded, as `push` records one, and the marker is still stamped once the rest
        // has landed: the baseline is rebuilt from the tables on every trip, so a marker held NULL
        // for its sake would offer this peer the same unsendable row, and the whole baseline
        // around it, on every sync for good. The row stays on this device; the sentence says the
        // peer goes without it.
        //
        // Probed in place rather than on a clone: `baseline::build` leaves both fields `None` on
        // every op, so putting them back to `None` leaves the op exactly as it was read.
        let mut sendable: Vec<Op> = Vec::with_capacity(ops.len());
        for mut op in ops {
            op.horizon = Some(horizon.clone());
            op.emission = Some(Emission {
                id: begun.id,
                i: u32::MAX,
                n: Some(u32::MAX),
                since: Some(begun.since),
                resumed: begun.resumed,
            });
            let oversized = wire::oversized(std::slice::from_ref(&op));
            op.horizon = None;
            op.emission = None;
            if oversized {
                say(
                    db,
                    "push",
                    Kind::Other,
                    &unsendable(&op, "a device's first sync"),
                    Some(&op.uid),
                );
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
        // **Cut where `wire::batches` would cut** — by count and by bytes — and walked as mutable
        // slices of those lengths, because `batches` hands out shared ones and the horizon and the
        // head have to be written in. The lengths are measured with every op's emission reference
        // on and before the horizon and the head ride on, which is the few hundred bytes
        // `wire::BATCH_BYTES` leaves room for under the relay's cap.
        let lengths: Vec<usize> = wire::batches(&ops)
            .iter()
            .map(|chunk| chunk.len())
            .collect();
        let mut rest: &mut [Op] = &mut ops;
        let (mut sent, mut sent_history) = (0usize, 0usize);
        for length in lengths {
            let (chunk, tail) = std::mem::take(&mut rest).split_at_mut(length);
            rest = tail;
            // **The horizon rides `chunk[0]` of EVERY chunk, not merely of the first.** Spec §9:
            // each chunk becomes its own stored relay row and they are pulled independently, so a
            // receiver handed only the second would union no horizon at all and count deltas that
            // are already inside the claims — §8.1's `+1`, silently.
            chunk[0].horizon = Some(horizon.clone());
            // **And so does the head** — how many ops the emission sends and the generation it
            // goes out under (design §3) — for the horizon's reason.
            baseline::head(&mut chunk[0], n, &begun);
            // A `stale_epoch` is not mended here as `push` mends it: the marker stays NULL, the
            // next trip's `check_keys` adopts before it gets here, and the baseline is built and
            // sealed again under the new key — a baseline is never filed, so there is nothing
            // to re-seal in place.
            match post_ops(db, base, token, &group, &device, chunk).await {
                Ok(()) => {}
                Err(Refusal::Stale) => {
                    let message = "the relay refused a device's first sync as sealed under a \
                                   group key it has moved past; it is sent again on the next \
                                   sync, under the new key"
                        .to_owned();
                    say(db, "push", Kind::Http, &message, Some(&url));
                    return Err(message);
                }
                Err(Refusal::Failed(message)) => return Err(message),
                // What landed of this peer's baseline is counted — the relay stored it — and the
                // marker is left NULL, so the next trip sends the whole of it again.
                Err(Refusal::ClockAhead) => {
                    say(db, "push", Kind::Http, BASELINE_CLOCK_AHEAD, Some(&url));
                    return Ok((emitted + sent, history + sent_history));
                }
                Err(Refusal::Deferred(_)) => return Ok((emitted + sent, history + sent_history)),
            }
            sent += chunk.len();
            sent_history += baseline::history_count(chunk);
        }
        // **Only after every chunk has landed.** Spec §13: a half-sent baseline must leave the
        // marker NULL so the next sync starts it over. Stamping above the loop instead turns
        // one failed push into a peer that is never offered a baseline again — a device empty
        // for ever, which is the whole failure this feature exists to remove. (A row left out
        // above has not *failed*: it can never land, so the rest landing is the whole of what
        // can — and it took no index, so the emission the rest makes up is whole.)
        db.with(|conn| baseline::mark_sent(conn, &peer))?;
        emitted += sent;
        history += sent_history;
    }
    Ok((emitted, history))
}

// ---------------------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------------------

/// One complete round trip: push, pull, emit baselines, ack.
///
/// **Push first**, so a device that is about to be told about somebody else's change has
/// already said what it did — which keeps a two-device group converging in one round rather
/// than two.
///
/// **The baseline goes out behind the pull** (spec §10.2). The pull is what makes this device
/// current, and a device that is behind must not speak for the group: a host emitting first
/// would hand a joiner the state it held before it heard what everybody else had done, in a
/// voice the joiner has no way to know is out of date.
///
/// Answers `Ok(None)` when there is nothing to do: **no entitlement**, or no group. That is the
/// state every existing installation is in, and it is not an error. (It used to read "no relay
/// URL"; the address is compiled in now and "sync is off" has moved onto the grant.)
pub async fn run_once(db: &impl Store) -> Result<Option<RelayOutcome>, String> {
    round_trip(db, true).await
}

/// The same round trip **with no baseline emission**: push, pull, ack.
///
/// # Why this exists
///
/// `sync_pair::pairing::sync_device_revoke` completes a round trip before it rotates the group
/// key, so the departing device's last push is absorbed before the epoch moves and nothing it
/// said is thrown away at the boundary (spec §12.4). Behind [`run_once`] that trip would also
/// **emit a full baseline to the device that is about to be revoked** — on the live pair, 1 069
/// ops — pushed one statement before that peer is marked gone, and unreadable to it the moment
/// the key rotates.
///
/// The push and the pull are why the trip is there and both are kept: this device's own pending
/// ops must reach the relay before the epoch moves, or the devices that *stay* cannot read them.
/// Only the emission is dropped, and the peers that need one are baselined by the very next
/// ordinary sync — which the revocation has just re-armed for every device that remains.
pub async fn run_once_without_baselines(db: &impl Store) -> Result<Option<RelayOutcome>, String> {
    round_trip(db, false).await
}

/// The body both of the above share. `baselines` is the only difference between them.
///
/// **[`check_keys`] runs first, above the token fetch, and that ordering is the whole reason it
/// exists.** A device that has been rotated away from cannot mint a token: its group auth is
/// stale, so [`entitlement::access_token`] answers [`entitlement::STALE_GROUP_AUTH`] and every
/// route below is closed to it. `/keys` is the one door that accepts a recent auth, and it is
/// what tells the difference between a device that is merely behind — which adopts the new key
/// and carries on down this function — and one that has been removed, which is not on the
/// manifest and leaves. `Ok(None)` for the second: there is nothing left to sync to, and that is
/// not an error. **Its answer also carries the relay's epoch down to [`pull`]**, and that is the
/// second reason it runs first: an envelope ahead of this device holds the cursor only when the
/// relay has reached its epoch, and the relay's word is the only one that says so.
///
/// **The token is then fetched once, above everything else, and the four requests below share
/// it.** Asking [`entitlement::access_token`] per request would be three refresh checks where one
/// will do, and a trip whose push carried one token and whose ack carried the next is a seam
/// nothing needs. It is fetched **above** the `me` check as well: `Ok(None)` there means no
/// grant, which is the same silence a device in no group answers with, and a membership that
/// ended while this device happened to be unpaired must still clear itself rather than wait for a
/// pairing.
async fn round_trip(db: &impl Store, baselines: bool) -> Result<Option<RelayOutcome>, String> {
    let keys = check_keys(db).await?;
    if keys.outcome == KeyOutcome::Removed {
        return Ok(None);
    }
    // A join this device pressed *Codes match* on may owe the rest of the group a publish — the
    // relay was unreachable at the time, or (the common case) this was the first pairing and
    // there was no membership yet for `/rotate` to accept. `roster_is_dirty` is the debt
    // `publish_join` records for both, and paying it here, above the token fetch and once per
    // trip, means it is retried on every ordinary sync from the moment a membership exists, with
    // no poll of its own. ⚠️ **It publishes from the LOCAL roster and never reads the relay's
    // manifest to decide whether one is owed**: a group that has claimed and never rotated
    // answers `devices: []` at the claim epoch, and treating that as evidence would be exactly
    // the "every device concludes it was removed" bug `check_keys` above already guards against,
    // reached a second way. A race between two devices publishing at once is settled by
    // `/rotate`'s 409 on a non-advancing epoch; the loser's `plan_join` is stale and its next
    // `check_keys` adopts what won.
    if db.with(|conn| Ok(identity::roster_is_dirty(conn)? && me(conn)?.is_some()))? {
        let _ = publish_join(db).await;
    }
    let Some(token) = entitlement::access_token(db).await? else {
        return Ok(None);
    };
    let Some((_, _, base)) = db.with(whereabouts)? else {
        return Ok(None);
    };
    // **A push the relay keeps refusing is deferred and the trip goes on** ([`Deferral`]): the
    // pull and the ack below do not depend on this device having been heard, and holding them
    // back with it stopped the device reading its group — and, for a full log, stopped the relay
    // compacting the very log that was full.
    let pushed = push(db, &base, &token).await?;
    let mut outcome = RelayOutcome {
        pushed: pushed.sent,
        ..RelayOutcome::default()
    };
    // A push refused as `stale_epoch` asks `/keys` again, and the answer can be the removal
    // notice: then there is nothing left to sync to, exactly as when `check_keys` above says so.
    if db.with(me)?.is_none() {
        return Ok(None);
    }
    // **The relay's epoch from the check above goes down to the pull**, which is what tells an
    // envelope from a rotation this device has not caught up with from one claiming a rotation
    // that never happened. A rotation published since — `publish_join` above, or one adopted by
    // the push — moved this device's own epoch with it, and an envelope at or below that is not
    // ahead at all; one above it makes the pull ask again.
    let pulled = pull(db, &base, &token, keys.relay_epoch).await?;
    outcome.unreadable = pulled.unreadable;
    // **What this trip applied, and nothing it was handed again.** A held cursor re-delivers the
    // same page on every trip, and what this trip applied is part of `changed`, which fires
    // `sync:applied` — counting the ops skipped or held again would refresh every screen on every
    // trip for as long as a hold lasts.
    outcome.pulled = pulled.report.applied;
    outcome.absorb(pulled.report);
    outcome.changed |= pulled.converted;
    // **No baseline behind a push deferred for the clock or the quota** — it would meet the same
    // refusal part of the way through and push its first chunks again on every trip
    // ([`Deferral::stops_baselines`]).
    if baselines && !pushed.deferred.is_some_and(Deferral::stops_baselines) {
        let (ops, history) = emit_baselines(db, &base, &token).await?;
        outcome.baseline_ops = ops;
        outcome.baseline_history = history;
    }
    ack(db, &base, &token).await?;
    db.with(|conn| {
        set_state(conn, LAST_SYNC_AT, &now_secs(conn)?.to_string()).map_err(|e| e.to_string())
    })?;
    Ok(Some(outcome))
}

#[cfg(test)]
mod tests;
