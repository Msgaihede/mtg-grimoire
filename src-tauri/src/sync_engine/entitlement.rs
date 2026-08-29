//! The entitlement grant: what lets this device talk to the relay at all.
//!
//! The relay is one service rather than one deployment per reader, so an address is no longer a
//! setting — [`RELAY_BASE`] is compiled in and public, the way any API base is. What the reader
//! supplies instead is a **membership**: they connect Patreon once, paste a claim code, and this
//! module trades it for a pair of tokens that live in `sync_state` beside the group key.
//!
//! Two tokens, because they expire on different scales, which is the whole of §7's lapse story:
//!
//! * **`access`** is the bearer token every relay request carries. It lasts a day, so the relay
//!   can verify it with an HMAC and no storage read at all.
//! * **`refresh`** is the long-lived secret this device trades for the next `access`, and it is
//!   what the relay deletes when a membership ends. Deleting it is instantaneous; the `access`
//!   already issued dies of old age within a day.
//!
//! **"Sync is off" has moved from "no URL" to "no entitlement".** [`access_token`] answers
//! `Ok(None)` when there is no refresh secret — exactly as `client::run_once` already answers
//! `Ok(None)` for a device in no group, and just as much not an error. That is the state every
//! existing installation is in.
//!
//! **A 401 is a sentence, not an `error_log` row** (spec §10). When the relay refuses the refresh
//! secret the membership has ended: the grant is cleared and the panel offers the connect button
//! again. Routing it through `errors::record` like a network failure would tell the reader their
//! sync is broken when in fact their pledge lapsed, which is the wrong sentence and points at the
//! wrong fix. **Nothing in this module writes to `error_log` at all**, and that is the same
//! argument widened rather than a second one: every path in here is a press — Settings' connect
//! button, its paste field, and the `syncNow` button that is `client::run_once`'s only caller —
//! so the failure is already on the screen of the reader who caused it. `error_log` is for the
//! failures nobody was watching.
//!
//! **That last paragraph is a condition, not a principle, and it is true today and only today.**
//! `client`'s own module doc plans a 60-second poll while the window has focus, and spec §8's
//! cost table is headed *Manual (what ships today)*. **When a poll lands, this argument inverts**
//! — a refresh that fails in the background is exactly a failure nobody was watching, and the
//! non-401 paths in [`post_for_grant`] should start calling `errors::record`. The 401 rule does
//! not invert: a lapse is never an `error_log` row whatever triggered the request.
//!
//! Everything here compiles for `wasm32-unknown-unknown`, which is why "now" is
//! `SELECT unixepoch()` off the connection rather than `SystemTime::now()`: that one panics
//! there.

use crate::sync_engine::client;
use crate::sync_pair::identity;
use rusqlite::Connection;
use serde::Deserialize;

/// The relay's address. **Real, and committed to a public repository on purpose.**
///
/// A `workers.dev` route is `<worker>.<subdomain>.workers.dev`: `mtg-grimoire-relay` is the worker
/// name in `relay/wrangler.jsonc`, `denmark-east` is the account's subdomain. Markus approved
/// committing it, and that approval rests on the design rather than softening it — **an API base
/// is public the way every application's is.** It is on the wire of every request that uses it and
/// it ships inside the binary whatever this tree says, so withholding it would have hidden it from
/// nobody while leaving this module lying about where it points. What does not belong here are the
/// four secrets the relay holds (spec §9).
///
/// **What is not on that host yet is this design's Worker, and the distinction matters.** The host
/// is live — it is the relay the 2026-08-29 end-to-end pass ran against — but what is deployed
/// there is the pre-entitlement code: no auth gate, no `/claim`, no `/token`, no OAuth callback,
/// no webhook, no D1 binding. **A device pointed at it today reaches a real relay that answers
/// none of the endpoints this module calls.** That is Wave 2 and a deploy, not a placeholder, and
/// it fails differently: a 404 from a server that is there, rather than a name that will not
/// resolve.
pub const RELAY_BASE: &str = "https://mtg-grimoire-relay.denmark-east.workers.dev";

/// **PLACEHOLDER. Awaiting the real OAuth client id.**
///
/// **Not the same state as [`RELAY_BASE`] above, which is now the real address** — this one is
/// unsettled and Markus has not supplied a value, so the two are no longer a matched pair. The
/// practical difference: with the address real and the client id invented, pressing Connect
/// reaches Patreon and is refused at the consent screen, rather than failing at DNS.
///
/// It is public once it is real, for `RELAY_BASE`'s reason — an OAuth client id is on the wire of
/// every authorize request — so it belongs in this repository too. `client_secret` never does.
pub const PATREON_CLIENT_ID: &str = "mtg-grimoire-placeholder-client-id";

/// Where Patreon sends the reader after they consent. **The relay, never this app** — the
/// `client_secret` can only live server-side, so the exchange happens there whatever the app
/// does, and a loopback listener would buy a listener and nothing else. Spec §6.1.
const PATREON_REDIRECT_PATH: &str = "/oauth/patreon/callback";

/// Patreon's consent screen.
const PATREON_AUTHORIZE: &str = "https://www.patreon.com/oauth2/authorize";

/// **Both scopes, and `identity` alone is the mistake worth naming.** It answers who the reader
/// is and nothing about what they pledge, so the flow would complete and then refuse them.
const PATREON_SCOPES: &str = "identity identity.memberships";

/// The bearer token on every relay request. A day's life.
pub const ACCESS_TOKEN: &str = "access_token";

/// The long-lived secret traded for the next [`ACCESS_TOKEN`]. **Holding one is what "connected"
/// means**, which is why [`refresh_secret`] is the question every caller asks.
pub const REFRESH_SECRET: &str = "refresh_secret";

/// When [`ACCESS_TOKEN`] stops being accepted, in unix seconds.
pub const ACCESS_EXPIRES: &str = "access_expires";

/// What the relay last said about the membership: `active`, `grace` or `dead`.
pub const SUPPORTER_STATUS: &str = "supporter_status";

/// When the membership started, in unix seconds — the relay's `created_at`, carried across.
pub const SUPPORTER_SINCE: &str = "supporter_since";

/// Refresh once fewer than this many seconds of the access token remain.
///
/// Six hours against a 24-hour token, so a reader who syncs even once a day never meets an
/// expired one, and a machine that was asleep over the margin costs one extra round trip rather
/// than a refused sync.
///
/// **This margin is the only thing absorbing the difference between this device's clock and the
/// relay's**, and that is worth saying plainly because the failure it prevents is silent. The
/// expiry is minted against the relay's clock and compared against `unixepoch()` here, so a
/// device running slow believes it has more time than it does. Six hours out and the comparison
/// still refreshes early; **a device a full day slow never refreshes at all** — it holds a token
/// the relay stopped honouring, and every sync request 401s on the *sync* route where nothing
/// re-mints. That is the same permanent silent death a millisecond expiry causes, reached with no
/// unit bug anywhere. [`SECONDS_CEILING`] catches the unit; nothing here catches the clock.
pub const REFRESH_MARGIN_SECS: i64 = 6 * 60 * 60;

/// The largest value an `expires` or `since` may hold and still be a unix **second**.
///
/// `1e11` seconds is the year 5138 and no grant reaches it; the same instant in *milliseconds* is
/// about `1.8e12`, well above. So one comparison separates the two units cleanly.
///
/// **This guard exists because the other half of this feature counts in milliseconds.**
/// `relay/src/token.ts` types its `exp` as wall-clock ms (`TOKEN_TTL_MS`) and
/// `relay/src/entitlement.ts` works in `nowMs`/`GRACE_MS`. **The wire between them and this
/// module is seconds**, and a millisecond value crossing it does not fail loudly: it makes
/// `expires - now` about `1.8e12`, forever larger than [`REFRESH_MARGIN_SECS`], so
/// [`access_token`] hands back the same stored token for ever, never refreshes, and twenty-four
/// hours later every sync request 401s on the *sync* route — which [`access_token`] never sees
/// and never re-mints from. Sync dies silently and permanently. Refusing the write is loud, and
/// loud at claim time is the whole point.
pub const SECONDS_CEILING: i64 = 100_000_000_000;

/// What [`claim`] answers when this device is in no group yet.
///
/// Named so the command layer can recognise it rather than matching a sentence. **Spec §6.3 says
/// a device with no group creates a group of one and then claims against it — that creation
/// belongs to the command layer, not here**: `identity::create_group` needs an `Identity`, which
/// only `identity::ensure` mints, and minting a keypair is not a side effect a network call
/// should have. This module reads the group and never makes one.
pub const NO_GROUP: &str = "this device is in no sync group yet";

/// Every key this module owns. [`clear`] deletes the lot.
const GRANT_KEYS: [&str; 5] = [
    ACCESS_TOKEN,
    REFRESH_SECRET,
    ACCESS_EXPIRES,
    SUPPORTER_STATUS,
    SUPPORTER_SINCE,
];

/// What `/claim` and `/token` both answer.
///
/// **Five fields where the spec's §6.2 sketch had two**, and the three additions are not
/// decoration: `expires` is what [`access_token`] compares its margin against, and `status` and
/// `since` have **no local source at all** — the entitlement row and its `created_at` live on the
/// relay, so a device knows only what the relay last told it. Without them the panel could say
/// "connected" and never "supporting since March".
#[derive(Debug, Clone, Deserialize)]
struct Grant {
    access: String,
    refresh: String,
    /// **Unix seconds, absolute — not a TTL and not milliseconds.** See [`SECONDS_CEILING`]: the
    /// relay half of this feature counts in milliseconds throughout, and a millisecond value here
    /// kills sync silently and permanently. The wire is seconds; the relay converts.
    expires: i64,
    status: String,
    /// Absent for a membership the relay cannot date. `Option` rather than a sentinel, because
    /// "no date" and "1970" must not draw the same. Unix seconds, like `expires`.
    #[serde(default)]
    since: Option<i64>,
}

// ---------------------------------------------------------------------------------------
// `sync_state`
// ---------------------------------------------------------------------------------------

/// The relay's base URL: the override if there is one, [`RELAY_BASE`] otherwise.
///
/// **This never answers `None`**, which is the difference from `client::relay_url` as it was.
/// The override is `client::RELAY_URL` and has no UI. It exists for the tests that stand a server
/// on localhost — `client/tests.rs`, and this module's own three endpoint tests. A **blank** value
/// is not an override — every installation that predates
/// this holds `""` there, and reading that as a base would build the relative URL `/g/…` and fail
/// with a message about nothing the reader did. Trailing slashes go because every caller appends
/// its own path.
pub fn base(conn: &Connection) -> String {
    let override_url = client::get_state(conn, client::RELAY_URL).unwrap_or_default();
    let trimmed = override_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        RELAY_BASE.to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// The refresh secret, or `None` when this device is not connected.
///
/// A blank is `None` for [`base`]'s reason: it is the shape an emptied row takes, and a request
/// carrying an empty secret is a 401 with a confusing story behind it.
pub fn refresh_secret(conn: &Connection) -> Option<String> {
    let secret = client::get_state(conn, REFRESH_SECRET)?;
    (!secret.trim().is_empty()).then_some(secret)
}

/// A unix second, or an error naming the unit it actually looks like.
///
/// See [`SECONDS_CEILING`] for why a millisecond value has to die at the write rather than in the
/// comparison that reads it back.
fn checked_seconds(field: &str, value: i64) -> Result<i64, String> {
    if value > SECONDS_CEILING {
        return Err(format!(
            "the relay answered {field}={value}, which is milliseconds; this wire is unix seconds"
        ));
    }
    Ok(value)
}

/// Store a fresh pair of tokens and when the access one dies.
///
/// **Three arguments and deliberately not five**: the supporter status and its date go through
/// [`store_status`], because pairing carries the refresh secret to a second device (spec §6.2)
/// and that device has a grant to store with no status to store beside it.
///
/// **`expires` is a unix second and a millisecond value is refused here** ([`SECONDS_CEILING`]),
/// and **a blank token is refused too**: every read in this module treats a blank as absent, so
/// storing one would leave the device silently not connected while `SUPPORTER_STATUS` still said
/// `active` — a panel claiming a live membership over a sync that makes no requests.
///
/// The three writes go in **one transaction**, because two of the three are not a grant: an
/// access token with no refresh secret reads as disconnected and throws the token away, and a
/// refresh secret with no expiry refreshes on every single call.
pub fn store_grant(
    conn: &Connection,
    access: &str,
    refresh: &str,
    expires: i64,
) -> Result<(), String> {
    if access.trim().is_empty() || refresh.trim().is_empty() {
        return Err("the relay answered a blank token".to_owned());
    }
    let expires = checked_seconds("expires", expires)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    client::set_state(&tx, ACCESS_TOKEN, access).map_err(|e| e.to_string())?;
    client::set_state(&tx, REFRESH_SECRET, refresh).map_err(|e| e.to_string())?;
    client::set_state(&tx, ACCESS_EXPIRES, &expires.to_string()).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Store what the relay last said about the membership.
///
/// **An absent `since` deletes the row rather than leaving it**, or a grant that has lost its
/// date would go on showing the previous one — a "supporting since" line that is nobody's fact.
///
/// `since` is a unix second and a millisecond value is refused, for [`store_grant`]'s reason and
/// against the same relay that counts in milliseconds. It fails less spectacularly than `expires`
/// does — a date in the year 58000 on the panel rather than a sync that dies — but it comes
/// across the same wire from the same code, so it meets the same guard.
pub fn store_status(conn: &Connection, status: &str, since: Option<i64>) -> Result<(), String> {
    let since = since.map(|at| checked_seconds("since", at)).transpose()?;
    client::set_state(conn, SUPPORTER_STATUS, status).map_err(|e| e.to_string())?;
    match since {
        Some(at) => {
            client::set_state(conn, SUPPORTER_SINCE, &at.to_string()).map_err(|e| e.to_string())
        }
        None => conn
            .execute("DELETE FROM sync_state WHERE key = ?1", [SUPPORTER_SINCE])
            .map(|_| ())
            .map_err(|e| e.to_string()),
    }
}

/// What the panel says: the stored status and the date the membership started.
///
/// **`dead` is what a device that has never connected reads as**, which means this pair alone
/// cannot separate *never connected* from *membership ended* — a lapse also ends at `dead`, with
/// the `since` gone because there is no membership to date any more. An earlier draft of this
/// comment claimed [`refresh_secret`] told them apart. **It does not**: the lapse path clears it
/// too, so both states read `None` there as well, and spec §10 needs three sentences rather than
/// two. [`membership_ended`] is the one that separates them, and it is what the panel must ask
/// before it says *Not connected*.
pub fn supporter_state(conn: &Connection) -> (String, Option<i64>) {
    let status = client::get_state(conn, SUPPORTER_STATUS)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "dead".to_owned());
    let since = client::get_state(conn, SUPPORTER_SINCE).and_then(|v| v.parse().ok());
    (status, since)
}

/// Forget the whole grant.
///
/// **All five keys, and the access token is the one that matters.** Clearing only the refresh
/// secret would leave a device holding a token the relay still honours, syncing for up to a day
/// after the reader disconnected it — which is the reader pressing a button and watching it do
/// nothing.
pub fn clear(conn: &Connection) -> Result<(), String> {
    let holes: Vec<String> = (1..=GRANT_KEYS.len()).map(|n| format!("?{n}")).collect();
    conn.execute(
        &format!("DELETE FROM sync_state WHERE key IN ({})", holes.join(", ")),
        rusqlite::params_from_iter(GRANT_KEYS.iter()),
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// **A membership that ended, as against one that never began.**
///
/// Spec §10 asks the panel for three sentences — *Supporting since …*, *Not connected*, and
/// *Membership ended* — and §7.1 puts the reassurance that no local data was touched on the third
/// one. So the third has to be reachable, and after [`revoke`] the only thing separating it from a
/// device fresh out of the box is that a `SUPPORTER_STATUS` row exists at all. That is what this
/// reads.
///
/// True only once the tokens are gone: an `active` or `grace` device has a status row too, and it
/// has not ended anything. **[`clear`] deliberately does not leave the mark** — a reader who
/// pressed Disconnect chose that, and telling them their membership ended would be a lie about
/// their own action.
pub fn membership_ended(conn: &Connection) -> bool {
    refresh_secret(conn).is_none() && client::get_state(conn, SUPPORTER_STATUS).is_some()
}

/// The relay refused the refresh secret: forget the tokens, **remember that there was a
/// membership**.
///
/// [`clear`] plus one row, and the row is the whole point — see [`membership_ended`]. This is the
/// call for a 401, and [`clear`] is the call for the reader pressing Disconnect.
///
/// **`client.rs`'s 401 handling on the sync routes should call this rather than [`clear`]**, for
/// the same reason and to the same effect; it is in another agent's file this wave, so it is
/// written down here and reported rather than changed.
pub fn revoke(conn: &Connection) -> Result<(), String> {
    clear(conn)?;
    store_status(conn, "dead", None)
}

/// Now, in unix seconds, asked of SQLite.
///
/// `SystemTime::now()` panics on `wasm32-unknown-unknown` and this module is every-target —
/// `apply`'s clock advance reaches the same conclusion and spells it in SQL for the same reason.
fn now(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT unixepoch()", [], |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------
// The network
// ---------------------------------------------------------------------------------------

/// The HTTP client for the two entitlement calls.
///
/// **Its own, and the duplication of `client::http` is deliberate.** An entitlement call is a
/// short control-plane request — one small JSON body each way — and must not sit behind the relay
/// client's 30-second read timeout, which is sized for a page of envelopes. Widening that one
/// would slacken the sync's own deadline to suit two requests that should answer in a second.
#[cfg(not(target_family = "wasm"))]
fn http() -> reqwest::Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .user_agent(crate::scryfall::USER_AGENT)
                .connect_timeout(std::time::Duration::from_secs(10))
                .read_timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap_or_default()
        })
        .clone()
}

/// **No `OnceLock` and no timeouts, and neither is an oversight** — `client::http`'s reasoning
/// exactly: reqwest's wasm client wraps JS values and is not `Sync`, so it cannot be a `static`,
/// and its builder has neither timeout method there because `fetch` owns the deadline.
#[cfg(target_family = "wasm")]
fn http() -> reqwest::Client {
    reqwest::Client::new()
}

/// `POST {base}{path}` with a JSON body, answering the grant the relay minted.
///
/// `Ok(None)` is a **401 and nothing else**: the relay refused the credential. What that costs is
/// the caller's decision, and neither caller records it anywhere.
async fn post_for_grant(
    conn: &Connection,
    path: &str,
    body: String,
) -> Result<Option<Grant>, String> {
    let url = format!("{}{path}", base(conn));
    let response = http()
        .post(&url)
        // By hand rather than through reqwest's `json` feature, which this crate does not
        // enable — `client::ack`'s reasoning, and the same `serde_json` already in the tree.
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    if status == 401 {
        return Ok(None);
    }
    if !(200..300).contains(&status) {
        return Err(format!("the relay answered {status} to {path}"));
    }
    let text = response.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// The token to put in `Authorization: Bearer …`, refreshing it first if it is close to dying.
///
/// Three answers, and only one of them is an error:
///
/// * **`Ok(None)`, no refresh secret** — sync is off. Not an error; it is where every existing
///   installation stands.
/// * **`Ok(None)`, a 401 from `/token`** — the membership has ended. The grant is [`revoke`]d, so
///   the panel offers the connect button *and* can still say which of the two silences this is,
///   and no `error_log` row is written (spec §10).
/// * **`Err`** — the relay could not be reached, or answered something else. A network failure is
///   a network failure and the caller reports it.
pub async fn access_token(conn: &Connection) -> Result<Option<String>, String> {
    let Some(refresh) = refresh_secret(conn) else {
        return Ok(None);
    };
    let stored = client::get_state(conn, ACCESS_TOKEN).filter(|t| !t.trim().is_empty());
    let expires: Option<i64> = client::get_state(conn, ACCESS_EXPIRES).and_then(|v| v.parse().ok());
    if let (Some(token), Some(expires)) = (stored, expires) {
        // A missing or unreadable expiry is treated as expired rather than as "forever": the one
        // thing worse than a needless refresh is a request the relay refuses.
        if expires - now(conn)? > REFRESH_MARGIN_SECS {
            return Ok(Some(token));
        }
    }
    let body = serde_json::json!({ "refresh": refresh }).to_string();
    let Some(grant) = post_for_grant(conn, "/token", body).await? else {
        revoke(conn)?;
        return Ok(None);
    };
    store_grant(conn, &grant.access, &grant.refresh, grant.expires)?;
    store_status(conn, &grant.status, grant.since)?;
    Ok(Some(grant.access))
}

/// Trade the code the reader pasted for a grant.
///
/// **The group id goes with the code, and it is not optional.** Spec §6.2 makes the access token's
/// payload `{sub, grp, exp}` and the Worker's gate compares `payload.grp` against the
/// `/g/{group}/…` path segment before the Durable Object hop — so the relay has to be told which
/// group to bind the entitlement to and stamp into `grp`. **There is no second channel to tell
/// it**: `/claim` carries no `Authorization` header, because the whole point of the call is that
/// there is no token yet, and the claim code is minted by the browser hop long before this device
/// is in the conversation. Sending only the code mints a token whose `grp` matches nothing, and
/// the reader connects Patreon successfully and then finds every push, pull and ack 401ing for
/// ever — a working flow with a permanently broken result, which is the worst shape a bug takes.
///
/// A device in no group answers [`NO_GROUP`] rather than creating one; see that constant.
///
/// A 401 here is not a lapse — the code is one-time and expires in ten minutes (spec §6.1) — so
/// it is a **refusal of this press** and says so, where the same status from `/token` means the
/// membership is over. Nothing is cleared: a reader mistyping a code must not lose an entitlement
/// they already hold.
pub async fn claim(conn: &Connection, code: &str) -> Result<(), String> {
    let Some(group) = identity::group(conn).map_err(|e| e.to_string())? else {
        return Err(NO_GROUP.to_owned());
    };
    let body = serde_json::json!({ "code": code, "group": group.group_id }).to_string();
    let Some(grant) = post_for_grant(conn, "/claim", body).await? else {
        return Err("the relay refused that claim code".to_owned());
    };
    store_grant(conn, &grant.access, &grant.refresh, grant.expires)?;
    store_status(conn, &grant.status, grant.since)
}

// ---------------------------------------------------------------------------------------
// The consent screen
// ---------------------------------------------------------------------------------------

/// Percent-encode one query value.
///
/// Hand-written because the tree carries no URL crate as a direct dependency and one query string
/// is not the reason to add one. Unreserved characters (RFC 3986 §2.3) go through; every other
/// byte becomes `%XX`, which is what turns the scope separator into `%20`.
fn encoded(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                out.push('%');
                out.push(HEX[(byte >> 4) as usize] as char);
                out.push(HEX[(byte & 0x0f) as usize] as char);
            }
        }
    }
    out
}

/// Where the connect button sends the reader.
///
/// **Built against [`RELAY_BASE`] rather than against [`base`], and it takes no connection for
/// exactly that reason.** The redirect URI is registered with Patreon and must match what was
/// registered byte for byte; a localhost override is for driving the relay's own endpoints in a
/// test and can never be what Patreon redirects to.
///
/// `state` is minted by the caller and checked when the code comes back — it is what stops a code
/// the reader never asked for being pasted into their app.
pub fn authorize_url(state: &str) -> String {
    let redirect = format!("{RELAY_BASE}{PATREON_REDIRECT_PATH}");
    format!(
        "{PATREON_AUTHORIZE}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}",
        encoded(PATREON_CLIENT_ID),
        encoded(&redirect),
        encoded(PATREON_SCOPES),
        encoded(state),
    )
}

#[cfg(all(test, not(target_family = "wasm")))]
mod tests {
    use super::*;
    use crate::sync_engine::client;

    /// A connection with just the one table these functions touch. `sync_state` is a plain
    /// key/value table, so the fixture does not need the schema ladder.
    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory database");
        conn.execute_batch("CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .expect("sync_state");
        conn
    }

    #[test]
    fn base_is_the_compiled_in_relay_when_nothing_overrides_it() {
        let conn = db();

        assert_eq!(base(&conn), RELAY_BASE);
    }

    #[test]
    fn an_override_wins_and_is_trimmed() {
        // The override has no UI and exists for the tests that stand a server on localhost -
        // `client/tests.rs`, and the three at the foot of this file. Trailing slashes are trimmed
        // because every caller appends its own path.
        let conn = db();
        client::set_state(&conn, client::RELAY_URL, "http://127.0.0.1:8787/").expect("set");

        assert_eq!(base(&conn), "http://127.0.0.1:8787");
    }

    #[test]
    fn a_blank_override_is_not_an_override() {
        // Every existing installation holds "" here. Reading that as a base would build the
        // relative URL "/g/..." and fail with a confusing message.
        let conn = db();
        client::set_state(&conn, client::RELAY_URL, "   ").expect("set");

        assert_eq!(base(&conn), RELAY_BASE);
    }

    #[test]
    fn no_refresh_secret_means_not_connected() {
        let conn = db();

        assert_eq!(refresh_secret(&conn), None);
    }

    #[test]
    fn store_grant_then_clear_round_trips() {
        let conn = db();
        store_grant(&conn, "access-1", "refresh-1", 1_756_000_000).expect("store");

        assert_eq!(refresh_secret(&conn).as_deref(), Some("refresh-1"));
        assert_eq!(
            client::get_state(&conn, ACCESS_TOKEN).as_deref(),
            Some("access-1")
        );

        clear(&conn).expect("clear");

        assert_eq!(refresh_secret(&conn), None);
        // **The access token must go too.** Clearing only the refresh secret would leave a
        // device syncing for up to a day after the reader disconnected it.
        assert_eq!(client::get_state(&conn, ACCESS_TOKEN), None);
    }

    #[test]
    fn the_authorize_url_carries_both_scopes_and_the_state() {
        let url = authorize_url("state-abc");

        assert!(url.starts_with("https://www.patreon.com/oauth2/authorize?"));
        assert!(url.contains("response_type=code"));
        // `identity` alone returns nothing about memberships, so the app would connect and then
        // be told the reader is not a patron.
        assert!(url.contains("identity%20identity.memberships"));
        assert!(url.contains("state=state-abc"));
        // Without a client id Patreon answers an error page rather than a consent screen, and
        // the first four assertions all still hold.
        assert!(url.contains(&format!("client_id={}", encoded(PATREON_CLIENT_ID))));
    }

    #[test]
    fn the_redirect_uri_is_present_and_encoded_byte_for_byte() {
        // Three mutations survive the test above: deleting `redirect_uri` outright, sending it
        // unencoded, and changing the path. Every one of them is a URL Patreon rejects, because
        // the redirect has to match what was registered exactly - which makes this the highest
        // consequence part of the string and the part nothing was checking.
        let url = authorize_url("state-abc");
        // Spelled out rather than run through `encoded`, so this is an independent statement of
        // what the bytes must be. The host is the only part taken from the constant, because it
        // is the one part that changes when the relay is really deployed.
        let host = RELAY_BASE.trim_start_matches("https://");
        let expected = format!("redirect_uri=https%3A%2F%2F{host}%2Foauth%2Fpatreon%2Fcallback");

        assert!(url.contains(&expected), "{url}");
        // A raw `://` inside a query value ends the value at the next `?` or `&` on some
        // parsers and is simply wrong on all of them.
        assert!(!url.contains("redirect_uri=https://"));
    }

    #[test]
    fn encoding_covers_the_bytes_a_url_is_made_of() {
        // The scope's space is the only byte the tests above exercise, and it is the least
        // dangerous of the three: `:` and `/` are what a redirect URI is mostly made of, and `&`
        // is how a value that is not encoded becomes a second parameter.
        assert_eq!(encoded("a b"), "a%20b");
        assert_eq!(encoded("https://x"), "https%3A%2F%2Fx");
        assert_eq!(encoded("a&b=c"), "a%26b%3Dc");
        // Unreserved (RFC 3986 2.3) must pass through, or every value would be unreadable.
        assert_eq!(encoded("Az09-._~"), "Az09-._~");
    }

    // -----------------------------------------------------------------------------------
    // The wire, and its unit
    // -----------------------------------------------------------------------------------

    #[test]
    fn the_wire_is_five_named_fields_and_expires_is_a_unix_second() {
        // Pinning the shape without a server. The field *names* are what serde matches, and the
        // unit is what nothing else in this repository states: the relay counts in milliseconds
        // throughout, so `expires` crossing as ms would be accepted here in silence.
        let body = r#"{"access":"a1","refresh":"r1","expires":1756000000,"status":"active","since":1740000000}"#;

        let grant: Grant = serde_json::from_str(body).expect("the five-field grant");

        assert_eq!(grant.access, "a1");
        assert_eq!(grant.refresh, "r1");
        assert_eq!(grant.expires, 1_756_000_000);
        assert_eq!(grant.status, "active");
        assert_eq!(grant.since, Some(1_740_000_000));
        // Seconds, and the check that says so out loud: the same instant in milliseconds is
        // three orders of magnitude past the ceiling.
        assert!(grant.expires < SECONDS_CEILING);
    }

    #[test]
    fn a_grant_without_a_since_is_still_a_grant() {
        // A membership the relay cannot date. Absent rather than null, which is the shape a
        // `JSON.stringify` of an undefined field takes.
        let body = r#"{"access":"a1","refresh":"r1","expires":1756000000,"status":"active"}"#;

        let grant: Grant = serde_json::from_str(body).expect("a grant with no since");

        assert_eq!(grant.since, None);
    }

    #[test]
    fn a_millisecond_expiry_is_refused_rather_than_stored() {
        // The whole failure this guard exists for: 1.756e12 is 1756000000 in ms, `expires - now`
        // is then ~1.8e12, forever past the six-hour margin, so the token is never refreshed and
        // sync 401s for ever on a route that cannot re-mint. Refusing is loud; storing is
        // permanent and silent.
        let conn = db();

        let error = store_grant(&conn, "a1", "r1", 1_756_000_000_000).expect_err("refused");

        assert!(error.contains("milliseconds"), "{error}");
        assert_eq!(client::get_state(&conn, ACCESS_EXPIRES), None);
        assert_eq!(client::get_state(&conn, ACCESS_TOKEN), None);
        assert_eq!(refresh_secret(&conn), None);
    }

    #[test]
    fn a_millisecond_since_is_refused_too() {
        let conn = db();

        let error = store_status(&conn, "active", Some(1_740_000_000_000)).expect_err("refused");

        assert!(error.contains("milliseconds"), "{error}");
        assert_eq!(client::get_state(&conn, SUPPORTER_SINCE), None);
        // And nothing half-written: the status must not land when the date is rejected.
        assert_eq!(client::get_state(&conn, SUPPORTER_STATUS), None);
    }

    // -----------------------------------------------------------------------------------
    // Writing a grant
    // -----------------------------------------------------------------------------------

    #[test]
    fn a_blank_token_is_refused_because_every_read_calls_it_absent() {
        // A relay answering `"refresh": ""` would leave the device not connected while
        // SUPPORTER_STATUS still said active - a panel claiming a live membership over a sync
        // that makes no requests at all.
        let conn = db();

        assert!(store_grant(&conn, "a1", "", 1_756_000_000).is_err());
        assert!(store_grant(&conn, "   ", "r1", 1_756_000_000).is_err());
        assert_eq!(client::get_state(&conn, ACCESS_TOKEN), None);
        assert_eq!(client::get_state(&conn, REFRESH_SECRET), None);
    }

    #[test]
    fn a_grant_that_fails_halfway_writes_nothing() {
        // Two of the three keys is not a grant: an access token with no refresh secret reads as
        // disconnected, and a refresh secret with no expiry refreshes on every call. The CHECK
        // makes the third write fail the way a disk error would.
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory database");
        conn.execute_batch(
            "CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL,
             CHECK (key <> 'access_expires'));",
        )
        .expect("sync_state");

        assert!(store_grant(&conn, "a1", "r1", 1_756_000_000).is_err());

        assert_eq!(client::get_state(&conn, ACCESS_TOKEN), None);
        assert_eq!(client::get_state(&conn, REFRESH_SECRET), None);
    }

    #[test]
    fn clear_takes_all_five_keys_and_only_those_five() {
        // Three of the five could go missing from `clear` and the round-trip test above would
        // stay green, leaving a disconnected device still claiming a membership on the panel.
        //
        // The five are named one by one and NOT looped out of `GRANT_KEYS`. Looping is what this
        // test did first, and it is vacuous against the only mutation it exists to catch:
        // shortening that list shortens the assertion with it, so the test agreed with the bug
        // and stayed green. An assertion may not read the constant it is checking.
        let conn = db();
        store_grant(&conn, "a1", "r1", 1_756_000_000).expect("store");
        store_status(&conn, "active", Some(1_740_000_000)).expect("status");
        // And `clear` must not be a table wipe: `sync_state` is shared, and the relay override
        // and the pull cursor are nobody's business here.
        client::set_state(&conn, client::RELAY_URL, "http://127.0.0.1:8787").expect("set");

        clear(&conn).expect("clear");

        assert_eq!(client::get_state(&conn, ACCESS_TOKEN), None);
        assert_eq!(client::get_state(&conn, REFRESH_SECRET), None);
        assert_eq!(client::get_state(&conn, ACCESS_EXPIRES), None);
        assert_eq!(client::get_state(&conn, SUPPORTER_STATUS), None);
        assert_eq!(client::get_state(&conn, SUPPORTER_SINCE), None);
        assert_eq!(
            client::get_state(&conn, client::RELAY_URL).as_deref(),
            Some("http://127.0.0.1:8787")
        );
    }

    // -----------------------------------------------------------------------------------
    // What the panel reads
    // -----------------------------------------------------------------------------------

    #[test]
    fn nothing_stored_reads_as_dead_with_no_date() {
        let conn = db();

        assert_eq!(supporter_state(&conn), ("dead".to_owned(), None));
    }

    #[test]
    fn a_blank_status_is_not_a_status() {
        let conn = db();
        client::set_state(&conn, SUPPORTER_STATUS, "  ").expect("set");

        assert_eq!(supporter_state(&conn).0, "dead");
    }

    #[test]
    fn a_status_and_its_date_round_trip() {
        // Through `to_string` and back through `parse` - the one place a date becomes text and
        // has to survive it.
        let conn = db();
        store_status(&conn, "active", Some(1_740_000_000)).expect("status");

        assert_eq!(
            supporter_state(&conn),
            ("active".to_owned(), Some(1_740_000_000))
        );
    }

    #[test]
    fn losing_the_date_deletes_it_rather_than_leaving_the_old_one() {
        let conn = db();
        store_status(&conn, "active", Some(1_740_000_000)).expect("first");

        store_status(&conn, "grace", None).expect("second");

        assert_eq!(supporter_state(&conn), ("grace".to_owned(), None));
    }

    #[test]
    fn a_membership_that_ended_is_not_a_device_that_never_connected() {
        // Spec 10 wants three sentences and 7.1 puts the "your data is untouched" reassurance on
        // the third. Both of these read ("dead", None) and hold no refresh secret, so the pair
        // above cannot tell them apart and a lapsed reader would be shown "Not connected".
        let fresh = db();
        assert!(!membership_ended(&fresh));

        let lapsed = db();
        store_grant(&lapsed, "a1", "r1", 1_756_000_000).expect("store");
        store_status(&lapsed, "active", Some(1_740_000_000)).expect("status");
        revoke(&lapsed).expect("revoke");

        assert_eq!(supporter_state(&lapsed), ("dead".to_owned(), None));
        assert_eq!(refresh_secret(&lapsed), None);
        assert!(membership_ended(&lapsed));
    }

    #[test]
    fn disconnecting_on_purpose_leaves_no_mark() {
        // `clear` is the reader pressing Disconnect. Telling them afterwards that their
        // membership ended would be a lie about their own action - and it would also mean a
        // reader who reconnects sees the lapse copy first.
        let conn = db();
        store_grant(&conn, "a1", "r1", 1_756_000_000).expect("store");
        store_status(&conn, "active", Some(1_740_000_000)).expect("status");

        clear(&conn).expect("clear");

        assert!(!membership_ended(&conn));
    }

    #[test]
    fn a_live_membership_has_not_ended() {
        let conn = db();
        store_grant(&conn, "a1", "r1", 1_756_000_000).expect("store");
        store_status(&conn, "active", Some(1_740_000_000)).expect("status");

        assert!(!membership_ended(&conn));
    }

    // -----------------------------------------------------------------------------------
    // The two endpoints
    //
    // Against `httpmock`, never a deployed Worker - `client/tests.rs`' rule, and it still holds
    // even though the relay's address is now in this file. `RELAY_BASE` is compiled in and public
    // exactly the way any application's API base URL is public: it is on the wire of every request
    // that uses it. What is never in this repository are spec 9's four secrets -
    // `PATREON_CLIENT_SECRET`, `PATREON_WEBHOOK_SECRET`, `PATREON_CREATOR_TOKEN` and
    // `RELAY_HMAC_KEY` - and a test that reached a deployed Worker would need none of them and
    // still be a test whose result depends on somebody else's uptime.
    //
    // These three exist because a mutation pass found the decisions below unasserted by anything:
    // dropping the group from `/claim`, and turning the 401's `revoke` back into a `clear`, both
    // left the whole file green.
    // -----------------------------------------------------------------------------------

    use httpmock::prelude::*;

    /// The fixture plus the one row `identity::group` reads. Written out rather than climbing the
    /// schema ladder, for `db`'s reason - and it is a *read* this module makes, never a write.
    fn db_with_no_group() -> rusqlite::Connection {
        // The table but no row, which is what a device that has never paired really looks like -
        // `prepare_database` creates it on every launch. A fixture missing the table entirely
        // makes `claim` answer "no such table: sync_group", which is a different sentence and
        // would have let the NO_GROUP arm pass without ever being reached.
        let conn = db();
        conn.execute_batch(
            "CREATE TABLE sync_group (
                 id INTEGER PRIMARY KEY CHECK (id = 1),
                 group_id TEXT NOT NULL,
                 epoch INTEGER NOT NULL DEFAULT 0,
                 group_key BLOB NOT NULL,
                 joined_at INTEGER NOT NULL
             );",
        )
        .expect("sync_group");
        conn
    }

    fn db_in_a_group(server: &MockServer) -> rusqlite::Connection {
        let conn = db_with_no_group();
        conn.execute_batch(
            "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
             VALUES (1, 'grp-1', 0, zeroblob(32), 0);",
        )
        .expect("the group row");
        client::set_state(&conn, client::RELAY_URL, &server.base_url()).expect("override");
        conn
    }

    #[tokio::test]
    async fn claim_sends_the_group_the_relay_has_to_bind() {
        // Spec 6.2 makes the token payload {sub, grp, exp} and the Worker compares `grp` against
        // the /g/{group}/... path segment. `/claim` carries no Authorization header - there is no
        // token yet, that is the point of the call - so the body is the only channel there is. A
        // claim without it mints a token matching no group, and the reader connects Patreon
        // successfully and then finds every sync request 401ing for ever.
        let server = MockServer::start_async().await;
        let mock = server.mock(|when, then| {
            when.method(POST)
                .path("/claim")
                .json_body(serde_json::json!({ "code": "ABCD-1234", "group": "grp-1" }));
            then.status(200).body(
                r#"{"access":"a1","refresh":"r1","expires":1756000000,
                    "status":"active","since":1740000000}"#,
            );
        });
        let conn = db_in_a_group(&server);

        claim(&conn, "ABCD-1234").await.expect("claim");

        mock.assert();
        assert_eq!(refresh_secret(&conn).as_deref(), Some("r1"));
        assert_eq!(
            supporter_state(&conn),
            ("active".to_owned(), Some(1_740_000_000))
        );
    }

    #[tokio::test]
    async fn claiming_with_no_group_says_so_instead_of_asking() {
        // A device has no group until it pairs. Spec 6.3 makes that the command layer's problem
        // to solve - it creates a group of one first - and this module's job is to name it rather
        // than mint a keypair inside a network call.
        let conn = db_with_no_group();

        let error = claim(&conn, "ABCD-1234").await.expect_err("no group");

        assert_eq!(error, NO_GROUP);
    }

    #[tokio::test]
    async fn a_401_from_token_leaves_the_mark_that_says_the_membership_ended() {
        // Spec 10: a lapse is a sentence and not an `error_log` row. It is also not the same
        // silence as a device that never connected - `clear` here rather than `revoke` reads to
        // the panel as "Not connected", and the reader never sees 7.1's reassurance that their
        // local data is untouched.
        let server = MockServer::start_async().await;
        let mock = server.mock(|when, then| {
            when.method(POST).path("/token");
            then.status(401).body("");
        });
        let conn = db_in_a_group(&server);
        store_grant(&conn, "stale", "r1", 0).expect("store");
        store_status(&conn, "active", Some(1_740_000_000)).expect("status");

        let token = access_token(&conn).await.expect("not an error");

        mock.assert();
        assert_eq!(token, None, "a lapse is a state, not an Err");
        assert_eq!(refresh_secret(&conn), None);
        assert_eq!(client::get_state(&conn, ACCESS_TOKEN), None);
        assert!(membership_ended(&conn));
    }

    #[tokio::test]
    async fn a_token_with_time_left_is_used_without_asking_the_relay() {
        // The margin's other half, and the half that fails silently: refreshing on every call
        // would merely be wasteful, while never refreshing is a token the relay stops honouring
        // on a route that cannot re-mint. No mock is registered, so any request at all fails the
        // test rather than being quietly served.
        let server = MockServer::start_async().await;
        let never = server.mock(|when, then| {
            when.method(POST);
            then.status(500).body("this must never be asked for");
        });
        let conn = db_in_a_group(&server);
        // Twelve hours, written absolutely and NOT as `REFRESH_MARGIN_SECS + something`: derived
        // that way, shrinking the margin shrinks the fixture with it and the test goes on
        // passing against a constant that no longer does anything.
        let far_off = now(&conn).expect("now") + 12 * 60 * 60;
        store_grant(&conn, "a1", "r1", far_off).expect("store");

        let token = access_token(&conn).await.expect("no round trip");

        assert_eq!(token.as_deref(), Some("a1"));
        never.assert_calls(0);
    }

    #[tokio::test]
    async fn a_token_inside_the_margin_is_traded_in_before_it_is_handed_back() {
        // **The behaviour the constant exists to produce, and nothing was exercising it.** One
        // hour of life left is inside six hours of margin, so the token is refreshed rather than
        // handed to a caller who may still be holding it when it dies.
        //
        // The expiry is an absolute hour, never `REFRESH_MARGIN_SECS - something`. Derived that
        // way, `REFRESH_MARGIN_SECS = 0` would move the fixture along with the code and this test
        // would agree with the bug - which is exactly how the margin came to be unpinned in the
        // first place.
        let server = MockServer::start_async().await;
        let mock = server.mock(|when, then| {
            when.method(POST)
                .path("/token")
                .json_body(serde_json::json!({ "refresh": "r1" }));
            then.status(200).body(
                r#"{"access":"a2","refresh":"r2","expires":1900000000,
                    "status":"active","since":1740000000}"#,
            );
        });
        let conn = db_in_a_group(&server);
        let nearly_out = now(&conn).expect("now") + 3600;
        store_grant(&conn, "a1", "r1", nearly_out).expect("store");

        let token = access_token(&conn).await.expect("refreshed");

        mock.assert();
        assert_eq!(
            token.as_deref(),
            Some("a2"),
            "the fresh token, not the stale one"
        );
        assert_eq!(refresh_secret(&conn).as_deref(), Some("r2"));
        assert_eq!(
            client::get_state(&conn, ACCESS_EXPIRES).as_deref(),
            Some("1900000000")
        );
    }

    #[test]
    fn the_refresh_margin_is_six_hours() {
        // Pinned to the number of seconds, NOT to `6 * 60 * 60`, which is how the constant is
        // spelled - an assertion may not read the constant it is checking, and the arithmetic is
        // half of that constant. Nothing else in this file fails if the margin becomes zero, and
        // a zero margin is the failure `REFRESH_MARGIN_SECS`' own doc describes: no absorption of
        // device-versus-relay clock skew at all, so a slow device holds a token the relay has
        // already stopped honouring.
        assert_eq!(REFRESH_MARGIN_SECS, 21_600);
    }
}
