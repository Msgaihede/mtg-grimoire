//! Push, pull, and how often.
//!
//! # What this does not build: the WebSocket
//!
//! Spec §7.7 says the Durable Object "fans out to connected devices over **hibernatable
//! WebSockets**". **This ships HTTP pull-and-push instead**, and the Durable Object keeps a
//! `/ws` route in its shape for the PR that adds it. Three reasons, in order of weight:
//!
//! 1. **`reqwest` has no WebSocket client**, and the obvious addition — `tokio-tungstenite` —
//!    does not compile to `wasm32-unknown-unknown`. Adding it would make the web target's core
//!    un-buildable, which is the one thing this whole phase is arranged not to do.
//! 2. **A WebSocket from the page would need the CSP widened.** `tauri.conf.json` grants
//!    `connect-src 'self' ipc: http://ipc.localhost` and nothing else. Widening it is a decision
//!    to take once, for all three targets, in the PR where the browser's own `WebSocket` is
//!    available in the DB Worker.
//! 3. **Polling is comfortably inside the free tier and this is arithmetic, not optimism.**
//!    Pull on open, pull every 60 s while the window has focus, push 2 s after the write mask
//!    goes quiet — `mirror::watch`'s own debounce, which this repo has already proven. Eight
//!    hours of use is `28 800 / 60` = 480 pulls per device per day; three devices sharing one
//!    group is **1 440**, which is **1.4%** of 100 000.
//!
//! What is lost is latency: a change made on a phone shows on the desktop within a minute
//! rather than instantly. What is kept is a core that still compiles to wasm and a CSP that
//! still grants nothing.

use crate::errors::{self, Kind, Source};
use crate::sync_engine::apply::{self, ApplyReport};
use crate::sync_engine::baseline;
use crate::sync_engine::capture;
use crate::sync_engine::merge::Op;
use crate::sync_engine::wire::{self, Envelope, WireError};
use crate::sync_pair::identity::{self, Group};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// The `sync_state` key holding the relay's base URL. **Empty by default**, and empty means
/// sync is off — which is the state every existing installation is in and the state an agent
/// leaves it in. The URL is the reader's own; it is never in this repository.
pub const RELAY_URL: &str = "relay_url";

/// How far this device has consumed the relay's log. The relay's `seq`, not a clock.
pub const PULL_CURSOR: &str = "pull_cursor";

/// When the last complete round trip finished, in unix seconds.
pub const LAST_SYNC_AT: &str = "last_sync_at";

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
    /// Envelopes taken from it.
    pub pulled: usize,
    /// Envelopes that could not be opened — a device that has not caught up with a key
    /// rotation, or a blob from before one.
    pub unreadable: usize,
    pub applied: usize,
    pub resurrected: usize,
    pub cycles_broken: usize,
    pub skipped: usize,
    pub deferred: usize,
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

/// The relay's base URL, with trailing slashes trimmed, or `None` when sync is off.
///
/// A blank value is `None` rather than an empty base, because "" would build the URL `/g/…`
/// and a relative request is a failure with a confusing message rather than a feature nobody
/// switched on.
pub fn relay_url(conn: &Connection) -> Option<String> {
    let url = get_state(conn, RELAY_URL)?;
    let trimmed = url.trim().trim_end_matches('/');
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
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
#[cfg(not(target_family = "wasm"))]
fn http() -> reqwest::Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .user_agent(crate::scryfall::USER_AGENT)
                .connect_timeout(std::time::Duration::from_secs(10))
                .read_timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_default()
        })
        .clone()
}

/// **No `OnceLock` and no timeouts, and neither is an oversight.** reqwest's wasm client wraps
/// JS values and is not `Sync`, so it cannot be a `static`; and its builder has neither timeout
/// method there, because `fetch` owns the deadline. `Client::new()` on wasm allocates nothing
/// but a handle.
#[cfg(target_family = "wasm")]
fn http() -> reqwest::Client {
    reqwest::Client::new()
}

/// Classify a transport failure, so the four call sites agree about what it was.
fn kind_of(err: &reqwest::Error) -> Kind {
    if err.is_timeout() {
        Kind::Timeout
    } else if err.is_decode() {
        Kind::Parse
    } else if err.is_status() {
        Kind::Http
    } else {
        Kind::Other
    }
}

fn note(conn: &Connection, operation: &str, kind: Kind, message: &str, detail: Option<&str>) {
    errors::record(conn, Source::Relay, operation, kind, message, detail);
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

/// Seal one batch of ops and hand it to the relay, **touching `sync_ops` not at all**.
///
/// Factored out of [`push`], which keeps its own `pushed_at` bookkeeping and calls this for the
/// bytes. The second caller is [`emit_baselines`], which has nothing to file: a baseline is
/// built in memory, sealed, pushed and forgotten (spec §5.1), so a function that both sent the
/// bytes *and* stamped a row could not have served it.
///
/// Every failure is recorded under the operation `push`, because that is what it is from the
/// relay's side and from the reader's — one endpoint, one `error_log` row to fold onto.
async fn post_ops(
    conn: &Connection,
    base: &str,
    group: &Group,
    device: &str,
    ops: &[Op],
) -> Result<(), String> {
    let url = format!("{base}/g/{}/push", group.group_id);
    let envelope = match wire::seal_batch(group, device, ops) {
        Ok(e) => e,
        Err(e) => {
            note(conn, "push", Kind::Other, &e.to_string(), None);
            return Err(e.to_string());
        }
    };
    let body = serde_json::to_string(&envelope).map_err(|e| e.to_string())?;
    let response = http()
        .post(&url)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await;
    let response = match response {
        Ok(r) => r,
        Err(e) => {
            note(conn, "push", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let message = format!("the relay answered {status} to a push");
        note(conn, "push", Kind::Http, &message, Some(&url));
        return Err(message);
    }
    match response.text().await {
        Ok(text) => {
            if let Err(e) = serde_json::from_str::<PushReceipt>(&text) {
                note(conn, "push", Kind::Parse, &e.to_string(), Some(&url));
                return Err(e.to_string());
            }
        }
        Err(e) => {
            note(conn, "push", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    }
    Ok(())
}

/// Hand every unpushed op to the relay.
///
/// **`pushed_at` is stamped only on a 200**, so the next attempt sends the same ops and a
/// network blip costs a retry rather than the reader's changes. The far side's second receipt
/// is free: [`apply`]'s `sync_peers` watermark drops an op it has already applied.
pub async fn push(conn: &Connection, base: &str) -> Result<usize, String> {
    let Some((device, group)) = me(conn)? else {
        return Ok(0);
    };
    let pending = unpushed(conn)?;
    if pending.is_empty() {
        return Ok(0);
    }
    let mut sent = 0usize;
    let seqs: Vec<i64> = pending.iter().map(|(seq, _)| *seq).collect();
    let ops: Vec<Op> = pending.into_iter().map(|(_, op)| op).collect();

    for (i, chunk) in wire::batches(&ops).enumerate() {
        post_ops(conn, base, &group, &device, chunk).await?;

        // Only now, and one chunk at a time: a run that dies between two chunks has handed the
        // first over and is honest about it.
        let first = i * wire::BATCH;
        let taken = &seqs[first..first + chunk.len()];
        let holes: Vec<String> = (1..=taken.len()).map(|n| format!("?{n}")).collect();
        conn.execute(
            &format!(
                "UPDATE sync_ops SET pushed_at = unixepoch() WHERE seq IN ({})",
                holes.join(", ")
            ),
            rusqlite::params_from_iter(taken.iter()),
        )
        .map_err(|e| e.to_string())?;
        sent += chunk.len();
    }
    Ok(sent)
}

// ---------------------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------------------

/// Take everything the group has said since this device's cursor, and apply it.
///
/// # An unreadable envelope is two different things and only one of them is permanent
///
/// The plan this was built from says a batch that will not open must not advance the cursor
/// past it. That is right for exactly one of the two ways it happens, and a permanent stall
/// for the other:
///
/// * `envelope.epoch > group.epoch` — **this device is behind a key rotation** and has not been
///   handed the new key yet. Those ops become readable, so the cursor stays put and the page is
///   re-delivered until it does.
/// * `envelope.epoch < group.epoch`, or a blob that fails the AEAD — **written before a
///   rotation, or altered**. No key this device will ever hold opens it, so refusing to advance
///   would stall the stream for the thirty days the relay keeps a tail, for nothing. It is
///   counted, written to `error_log`, and stepped over.
pub async fn pull(conn: &Connection, base: &str) -> Result<(usize, ApplyReport), String> {
    let Some((device, group)) = me(conn)? else {
        return Ok((0, ApplyReport::default()));
    };
    let cursor: i64 = get_state(conn, PULL_CURSOR)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let url = format!(
        "{base}/g/{}/pull?since={cursor}&device={device}",
        group.group_id
    );
    let response = match http().get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            note(conn, "pull", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let message = format!("the relay answered {status} to a pull");
        note(conn, "pull", Kind::Http, &message, Some(&url));
        return Err(message);
    }
    let text = match response.text().await {
        Ok(t) => t,
        Err(e) => {
            note(conn, "pull", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    let page: PullPage = match serde_json::from_str(&text) {
        Ok(p) => p,
        Err(e) => {
            note(conn, "pull", Kind::Parse, &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };

    let mut ops: Vec<Op> = Vec::new();
    let mut unreadable = 0usize;
    let mut behind = false;
    for envelope in &page.envelopes {
        match wire::open_batch(&group, envelope) {
            Ok(mut batch) => ops.append(&mut batch),
            Err(e) => {
                unreadable += 1;
                if matches!(e, WireError::WrongEpoch) && envelope.epoch > group.epoch {
                    behind = true;
                }
                note(
                    conn,
                    "pull",
                    Kind::Parse,
                    &e.to_string(),
                    Some(&envelope.device),
                );
            }
        }
    }

    let report = apply::apply(conn, &ops)?;
    if !behind {
        set_state(conn, PULL_CURSOR, &page.cursor.to_string()).map_err(|e| e.to_string())?;
    }
    Ok((unreadable, report))
}

/// Tell the relay how far this device has consumed, which is what compaction reads.
pub async fn ack(conn: &Connection, base: &str) -> Result<(), String> {
    let Some((device, group)) = me(conn)? else {
        return Ok(());
    };
    let cursor: i64 = get_state(conn, PULL_CURSOR)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let url = format!("{base}/g/{}/ack", group.group_id);
    // Written by hand rather than through reqwest's `json` feature, which this crate does not
    // enable: `serde_json` is already here, and a feature that changes what every other request
    // in the tree is built from is a wide edit for two call sites.
    let body = serde_json::json!({ "device": device, "cursor": cursor }).to_string();
    let response = match http()
        .post(&url)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            note(conn, "ack", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let message = format!("the relay answered {status} to an ack");
        note(conn, "ack", Kind::Http, &message, Some(&url));
        return Err(message);
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------------------

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
async fn emit_baselines(conn: &Connection, base: &str) -> Result<(usize, usize), String> {
    let Some((device, group)) = me(conn)? else {
        return Ok((0, 0));
    };
    let mut emitted = 0usize;
    let mut history = 0usize;
    for peer in baseline::peers_needing(conn)? {
        let mut ops = baseline::build(conn, &device)?;
        // A device holding nothing has still answered the question, so the marker is stamped
        // and the peer is not asked again next minute. There is no envelope to send: an empty
        // batch is `WireError::Empty`, deliberately, because a relay row holding no ops is a
        // row nobody can act on.
        if ops.is_empty() {
            baseline::mark_sent(conn, &peer)?;
            continue;
        }
        let horizon = baseline::horizon(conn, &device)?;
        // **The horizon rides `chunk[0]` of EVERY chunk, not merely of the first.** Spec §9:
        // each chunk becomes its own stored relay row and they are pulled independently, so a
        // receiver handed only the second would union no horizon at all and count deltas that
        // are already inside the claims — §8.1's `+1`, silently. `chunks_mut` rather than
        // [`wire::batches`], which hands out shared slices; both cut on the one `wire::BATCH`,
        // so the two cannot drift.
        for chunk in ops.chunks_mut(wire::BATCH) {
            chunk[0].horizon = Some(horizon.clone());
            post_ops(conn, base, &group, &device, chunk).await?;
        }
        // **Only after every chunk has landed.** Spec §13: a half-sent baseline must leave the
        // marker NULL so the next sync starts it over. Stamping above the loop instead turns
        // one failed push into a peer that is never offered a baseline again — a device empty
        // for ever, which is the whole failure this feature exists to remove.
        baseline::mark_sent(conn, &peer)?;
        emitted += ops.len();
        history += baseline::history_count(&ops);
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
/// Answers `Ok(None)` when there is nothing to do: no relay URL, or no group. That is the
/// state every existing installation is in, and it is not an error.
pub async fn run_once(conn: &Connection) -> Result<Option<RelayOutcome>, String> {
    round_trip(conn, true).await
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
pub async fn run_once_without_baselines(conn: &Connection) -> Result<Option<RelayOutcome>, String> {
    round_trip(conn, false).await
}

/// The body both of the above share. `baselines` is the only difference between them.
async fn round_trip(conn: &Connection, baselines: bool) -> Result<Option<RelayOutcome>, String> {
    let Some(base) = relay_url(conn) else {
        return Ok(None);
    };
    if me(conn)?.is_none() {
        return Ok(None);
    }
    let mut outcome = RelayOutcome {
        pushed: push(conn, &base).await?,
        ..RelayOutcome::default()
    };
    let (unreadable, report) = pull(conn, &base).await?;
    outcome.unreadable = unreadable;
    outcome.pulled = report.applied + report.skipped + report.deferred;
    outcome.absorb(report);
    if baselines {
        let (ops, history) = emit_baselines(conn, &base).await?;
        outcome.baseline_ops = ops;
        outcome.baseline_history = history;
    }
    ack(conn, &base).await?;
    set_state(
        conn,
        LAST_SYNC_AT,
        &conn
            .query_row("SELECT unixepoch()", [], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            .to_string(),
    )
    .map_err(|e| e.to_string())?;
    Ok(Some(outcome))
}

#[cfg(all(test, not(target_family = "wasm")))]
mod tests;
