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
use crate::sync_engine::entitlement;
use crate::sync_engine::merge::Op;
use crate::sync_engine::wire::{self, Envelope, WireError};
use crate::sync_pair::crypto;
use crate::sync_pair::identity::{self, Group};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// The `sync_state` key holding the relay's base URL — now a **test/dev override with no UI**,
/// read by [`entitlement::base`], which falls back to the compiled-in [`entitlement::RELAY_BASE`].
///
/// It is empty on every installation that predates the hosted relay, and a blank is not an
/// override. **"Sync is off" has moved off this key**: it is now "no entitlement", which
/// [`entitlement::access_token`] answers `Ok(None)` to.
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
/// The cause is this static outliving what it is connected to. One `reqwest::Client` for the
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
#[cfg(all(not(target_family = "wasm"), not(test)))]
fn http() -> reqwest::Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(build_http).clone()
}

/// See [`http`]: a test build takes a fresh client so nothing is shared across runtimes.
#[cfg(all(not(target_family = "wasm"), test))]
fn http() -> reqwest::Client {
    build_http()
}

/// The one place the client's shape is written down, so the two arms above cannot drift on a
/// timeout the way two copies of a builder would.
#[cfg(not(target_family = "wasm"))]
fn build_http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(crate::scryfall::USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default()
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
    /// swept to the manifest. This device is still in the group and the trip carries on.
    Adopted,
    /// A higher epoch and **no blob for this device**, which is the removal notice — see
    /// [`check_keys`]. The group is left and the grant cleared.
    Removed,
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

/// The `/keys` URL, written once so the request and the two failures [`check_keys`] records
/// *after* the request has come back cannot drift into naming two different addresses.
fn keys_url(conn: &Connection, device: &str, group: &Group) -> String {
    format!(
        "{}/g/{}/keys?device={device}",
        entitlement::base(conn),
        group.group_id
    )
}

/// `GET /g/{group}/keys?device=…`, decoded — the request itself, with no opinion about what the
/// answer means.
///
/// **Two callers with two different questions, and one request shape between them.**
/// [`check_keys`] asks *what epoch is the group on and am I still in it*; [`relay_manifest`] asks
/// only *who does the relay currently think is in this group*, which [`publish_join`] needs
/// before it may speak for the group at all. Factoring the request out is what stops the second
/// question growing a second, subtly different spelling of the 401 sentence below.
///
/// **The credential is the group auth of this device's own epoch**, which is what makes this the
/// one route a device behind a rotation can still reach — see [`check_keys`] for the whole of
/// that argument.
async fn fetch_key_page(conn: &Connection, device: &str, group: &Group) -> Result<KeyPage, String> {
    let auth = crypto::relay_auth(&group.group_key, &group.group_id, group.epoch);
    let url = keys_url(conn, device, group);
    let response = match http()
        .get(&url)
        .header("authorization", format!("Bearer {auth}"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            note(conn, "keys", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let message = if status == 401 {
            // **The commonest cause is named first, and it is a migration rather than a
            // fault.** A group claimed before the relay stored group keys has an entitlement
            // with no manifest row and a NULL `group_auth`: `seedGroup` runs only from
            // `/claim`, so nothing else has ever registered one. **The relay cannot fill it
            // in on its own** — `relay_auth` is derived from the group key, which it never
            // sees and must never see — so the repair has to be a press on a device.
            // Reconnecting Patreon re-claims the same group (`row.group_id == group`
            // passes) and seeds the manifest. Measured on the real pair 2026-08-30: a
            // paid-up, paired phone at epoch 2 failed here on its first press, and no test
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
        note(conn, "keys", Kind::Http, &message, Some(&url));
        return Err(message);
    }
    let text = match response.text().await {
        Ok(t) => t,
        Err(e) => {
            note(conn, "keys", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    match serde_json::from_str(&text) {
        Ok(p) => Ok(p),
        Err(e) => {
            note(conn, "keys", Kind::Parse, &e.to_string(), Some(&url));
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
async fn relay_manifest(conn: &Connection) -> Result<Vec<String>, String> {
    let Some((device, group)) = me(conn)? else {
        return Err("this device is in no group".to_owned());
    };
    Ok(fetch_key_page(conn, &device, &group).await?.devices)
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
/// **A 401 is never [`lapsed`], and copying push/pull/ack's handling here would be the worst
/// mistake in this file.** The credential is the group auth, not the access token, so a refusal
/// says the group key is unrecognised — a group with no membership yet, or a device dark across
/// more rotations than the relay keeps (spec §4). Revoking the grant over either would tell a
/// reader their Patreon membership ended because of something else entirely.
pub async fn check_keys(conn: &Connection) -> Result<KeyOutcome, String> {
    // A device in no group has no key to check and no auth to check it with. It must make no
    // request at all: `/g//keys` is a URL, and one built from an empty group id would be sent.
    let Some((device, group)) = me(conn)? else {
        return Ok(KeyOutcome::Current);
    };
    let page = fetch_key_page(conn, &device, &group).await?;

    if page.epoch <= group.epoch {
        return Ok(KeyOutcome::Current);
    }
    let Some(blob) = page.blob else {
        // **Both halves, and the second one is the caller's to make rather than
        // `identity`'s.** That module owns pairing state and knows nothing about Patreon; here
        // the two facts sit side by side. The grant has to go because a removed device that kept
        // its refresh secret would keep a *working credential for the group it was removed
        // from* — the refresh door mints a token whose `grp` is that group and `/g/{group}/push`
        // honours it, so the rotation would stop it reading anything new while it went on
        // spending the group's requests.
        //
        // **`clear` and never `revoke`.** The two differ by the mark `membership_ended` reads,
        // and nothing ended: the reader's pledge is untouched and this device simply left a
        // group. `revoke` would draw *Membership ended* and §7.1's reassurance at somebody whose
        // membership is fine; `clear` draws *Not connected*, and reconnecting is one press.
        identity::leave_group(conn)?;
        entitlement::clear(conn)?;
        return Ok(KeyOutcome::Removed);
    };
    let url = keys_url(conn, &device, &group);
    let sealed = match URL_SAFE_NO_PAD.decode(blob.as_bytes()) {
        Ok(bytes) => bytes,
        Err(e) => {
            note(conn, "keys", Kind::Parse, &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };

    // **The answer does not say who rotated, so the candidates are tried in turn.** `/keys`
    // carries the epoch, the blob and the manifest and nothing about the sealer — deliberately,
    // because the relay is not a party to the rewrap. The blob's key is
    // `X25519(remover_secret, my_public)` and its AAD binds the group, this device and the
    // epoch, so exactly one peer's public key opens it and the rest fail the AEAD. The manifest
    // is at most 64 ids and the remover is always on it (it rewraps for itself as well), so this
    // is a short loop with a guaranteed hit. `adopt_epoch` unwraps *before* it opens its
    // transaction, so a candidate that does not fit writes nothing.
    let mut refusal = None;
    for peer in page.devices.iter().filter(|id| id.as_str() != device) {
        match identity::adopt_epoch(conn, peer, page.epoch, &sealed, &page.devices) {
            Ok(()) => return Ok(KeyOutcome::Adopted),
            Err(e) => refusal = Some(e),
        }
    }
    let message = match refusal {
        Some(e) => format!("that new group key could not be opened by this device: {e}"),
        None => "the relay sent a key for this device with nobody on the manifest to have \
                 sealed it"
            .to_owned(),
    };
    note(conn, "keys", Kind::Parse, &message, Some(&url));
    Err(message)
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
pub async fn post_rotation(conn: &Connection, rotation: &identity::Rotation) -> Result<(), String> {
    // Its own sentence rather than `identity`'s `NOT_IN_A_GROUP`, which is private to that
    // module: this is not the ordinary "you are in no group" refusal — `plan_rotation` has
    // already answered that one — but a group that went away between planning and publishing.
    let Some(current) = identity::group(conn).map_err(|e| e.to_string())? else {
        return Err(
            "this device left its group before that key change could be published".to_owned(),
        );
    };
    let base = entitlement::base(conn);
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
    let response = match http()
        .post(&url)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {auth}"))
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            note(conn, "rotate", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let message =
            format!("the relay answered {status} to a key change, so nothing was removed");
        note(conn, "rotate", Kind::Http, &message, Some(&url));
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
    conn: &Connection,
    rv: &str,
    slot: &str,
    blob: &str,
) -> Result<(), String> {
    let base = entitlement::base(conn);
    let url = format!("{base}/p/{rv}/{slot}");
    let body = serde_json::json!({ "blob": blob }).to_string();
    let response = match http()
        .post(&url)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            note(conn, "rendezvous", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    let status = response.status().as_u16();
    if status == 204 {
        return Ok(());
    }
    if status == 409 {
        return Err(RENDEZVOUS_TAKEN.to_owned());
    }
    let message = format!("the relay answered {status} to a rendezvous post");
    note(conn, "rendezvous", Kind::Http, &message, Some(&url));
    Err(message)
}

/// Poll the rendezvous for the other side's blob.
///
/// **A 404 is `Ok(None)`, and never an error** — the panel polls this every 1.5 seconds while
/// the other device is still being read to, and a poll that treated "not yet" as a failure would
/// put an error in front of the reader on every tick before the pairing has had any chance to
/// finish.
pub async fn get_rendezvous(
    conn: &Connection,
    rv: &str,
    slot: &str,
) -> Result<Option<String>, String> {
    let base = entitlement::base(conn);
    let url = format!("{base}/p/{rv}/{slot}");
    let response = match http().get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            note(conn, "rendezvous", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    let status = response.status().as_u16();
    if status == 404 {
        return Ok(None);
    }
    if !(200..300).contains(&status) {
        let message = format!("the relay answered {status} to a rendezvous poll");
        note(conn, "rendezvous", Kind::Http, &message, Some(&url));
        return Err(message);
    }
    let text = match response.text().await {
        Ok(t) => t,
        Err(e) => {
            note(conn, "rendezvous", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    let page: RendezvousPage = match serde_json::from_str(&text) {
        Ok(p) => p,
        Err(e) => {
            note(conn, "rendezvous", Kind::Parse, &e.to_string(), Some(&url));
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
/// removal. What it is instead is harder to diagnose: this device sits at *N*, its next
/// `check_keys` reads a higher epoch **with** a blob — and the adopt loop skips this device as a
/// candidate sealer (`filter(|id| id != device)`), so every remaining candidate fails the AEAD
/// and the device stalls at *N* with *"that new group key could not be opened by this device"*
/// on every sync while every peer moves on. Committing makes the epochs equal, so `check_keys`
/// answers `Current` and never reads the manifest at all. This is `remove_device`'s order
/// exactly.
pub async fn publish_join(conn: &Connection) -> Result<(), String> {
    let Ok(plan) = identity::plan_join(conn) else {
        identity::set_roster_dirty(conn, true)?;
        return Ok(());
    };
    // **One `/keys` read of its own rather than a value threaded down from `check_keys`.** That
    // call does fetch the same manifest on every sync — but it is not on *this* function's other
    // path at all: `pairing::confirm` calls straight in with no sync in front of it, and that is
    // the very path an ordinary pairing takes. Threading the value would leave the confirm path
    // needing its own read anyway, so there would be two shapes and two behaviours to keep in
    // step. The cost is one GET per pairing, plus one per sync only while the debt is
    // outstanding — `round_trip` does not call this otherwise.
    let Ok(known) = relay_manifest(conn).await else {
        // Unreachable, refused, or a group with no membership at all — the common first
        // pairing. Nothing can be concluded about the group's roster, so nothing is published.
        return identity::set_roster_dirty(conn, true);
    };
    let mine: std::collections::HashSet<&str> =
        plan.keys.iter().map(|(id, _)| id.as_str()).collect();
    // The comparison is against `plan.keys` and not against `roster()` itself, because
    // `plan_excluding` drops any row an older build stamped `revoked_at` — so the plan is what
    // would actually be published, and it is the only set whose superset-ness proves nobody is
    // evicted. An empty `known` (a group that has claimed and never rotated answers
    // `devices: []`) is a subset of everything, which is what keeps the common case publishing.
    if !known.iter().all(|id| mine.contains(id.as_str())) {
        return identity::set_roster_dirty(conn, true);
    }
    if post_rotation(conn, &plan).await.is_err() {
        // Nothing committed, so the group is exactly as it was and the debt is recorded.
        return identity::set_roster_dirty(conn, true);
    }
    // `""` removes nobody: `commit_rotation`'s `DELETE … WHERE device_id = ?1` matches no row,
    // which is what a join wants. Its `baselined_at = NULL` sweep is wanted in full — a joining
    // device needs every peer's last words carried across the epoch boundary.
    identity::commit_rotation(conn, "", &plan)?;
    identity::set_roster_dirty(conn, false)
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
/// relay's side and from the reader's — one endpoint, one `error_log` row to fold onto. The one
/// exception is a 401, which [`lapsed`] handles and does not record at all.
async fn post_ops(
    conn: &Connection,
    base: &str,
    token: &str,
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
        .header("authorization", format!("Bearer {token}"))
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
    if status == 401 {
        return Err(lapsed(conn, "a push"));
    }
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
pub async fn push(conn: &Connection, base: &str, token: &str) -> Result<usize, String> {
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
        post_ops(conn, base, token, &group, &device, chunk).await?;

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
pub async fn pull(
    conn: &Connection,
    base: &str,
    token: &str,
) -> Result<(usize, ApplyReport), String> {
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
    let response = match http()
        .get(&url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            note(conn, "pull", kind_of(&e), &e.to_string(), Some(&url));
            return Err(e.to_string());
        }
    };
    let status = response.status().as_u16();
    if status == 401 {
        return Err(lapsed(conn, "a pull"));
    }
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
pub async fn ack(conn: &Connection, base: &str, token: &str) -> Result<(), String> {
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
        .header("authorization", format!("Bearer {token}"))
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
    if status == 401 {
        return Err(lapsed(conn, "an ack"));
    }
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
async fn emit_baselines(
    conn: &Connection,
    base: &str,
    token: &str,
) -> Result<(usize, usize), String> {
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
            post_ops(conn, base, token, &group, &device, chunk).await?;
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
/// Answers `Ok(None)` when there is nothing to do: **no entitlement**, or no group. That is the
/// state every existing installation is in, and it is not an error. (It used to read "no relay
/// URL"; the address is compiled in now and "sync is off" has moved onto the grant.)
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
///
/// **[`check_keys`] runs first, above the token fetch, and that ordering is the whole reason it
/// exists.** A device that has been rotated away from cannot mint a token: its group auth is
/// stale, so [`entitlement::access_token`] answers [`entitlement::STALE_GROUP_AUTH`] and every
/// route below is closed to it. `/keys` is the one door that accepts a recent auth, and it is
/// what tells the difference between a device that is merely behind — which adopts the new key
/// and carries on down this function — and one that has been removed, which is not on the
/// manifest and leaves. `Ok(None)` for the second: there is nothing left to sync to, and that is
/// not an error.
///
/// **The token is then fetched once, above everything else, and the four requests below share
/// it.** Asking [`entitlement::access_token`] per request would be three refresh checks where one
/// will do, and a trip whose push carried one token and whose ack carried the next is a seam
/// nothing needs. It is fetched **above** the `me` check as well: `Ok(None)` there means no
/// grant, which is the same silence a device in no group answers with, and a membership that
/// ended while this device happened to be unpaired must still clear itself rather than wait for a
/// pairing.
async fn round_trip(conn: &Connection, baselines: bool) -> Result<Option<RelayOutcome>, String> {
    if check_keys(conn).await? == KeyOutcome::Removed {
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
    if identity::roster_is_dirty(conn)? && me(conn)?.is_some() {
        let _ = publish_join(conn).await;
    }
    let Some(token) = entitlement::access_token(conn).await? else {
        return Ok(None);
    };
    if me(conn)?.is_none() {
        return Ok(None);
    }
    let base = entitlement::base(conn);
    let mut outcome = RelayOutcome {
        pushed: push(conn, &base, &token).await?,
        ..RelayOutcome::default()
    };
    let (unreadable, report) = pull(conn, &base, &token).await?;
    outcome.unreadable = unreadable;
    outcome.pulled = report.applied + report.skipped + report.deferred;
    outcome.absorb(report);
    if baselines {
        let (ops, history) = emit_baselines(conn, &base, &token).await?;
        outcome.baseline_ops = ops;
        outcome.baseline_history = history;
    }
    ack(conn, &base, &token).await?;
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
