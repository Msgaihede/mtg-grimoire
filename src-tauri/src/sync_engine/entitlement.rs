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
//! `Ok(None)` when there is neither a refresh secret nor a group — exactly as `client::run_once`
//! already answers `Ok(None)` for a device in no group, and just as much not an error. That is
//! the state every existing installation is in.
//!
//! **A group is half of that test because an entitlement belongs to a *group*, not to a device**
//! (spec §2.2). [`access_token`] has two doors: the refresh secret opens one, and
//! [`crypto::relay_auth`] — one-way from the group key, so every device in the group derives it
//! and nothing is distributed — opens the other. A device that has only ever paired mints its own
//! token through the second, which is what makes *Supporting since …* appear on every device in
//! the group rather than on whichever one happened to open a browser. **The refresh secret stops
//! travelling in the pairing blob** in the same change, and that is not a tidy-up: a device
//! holding it could re-register the group's auth and evict the devices that removed it.
//!
//! **The two doors fail differently on the same status code**, which is the sharpest thing in
//! this module: see [`STALE_GROUP_AUTH`].
//!
//! **Every request here also names this device, and a third status code answers that** (spec
//! §4.2). One membership covers five devices, the relay is the fence, and it counts the ids on
//! `/token`'s *both* doors and on `/claim` — because the device that pressed Connect reaches it
//! through the refresh door and never the group one, so a roll fed by the group door alone would
//! miss the one device that is certainly signed in. The refusal is a **403**, and it is
//! [`GROUP_IS_FULL`] rather than anything the 401 machinery touches: read that constant before
//! moving this line.
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
use crate::sync_pair::{crypto, identity};
use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde::Deserialize;

/// The relay's address. **Real, and committed to a public repository on purpose.**
///
/// A `workers.dev` route is `<worker>.<subdomain>.workers.dev`: `mtg-grimoire-relay` is the worker
/// name in `relay/wrangler.jsonc`, `denmark-east` is the account's subdomain. Markus approved
/// committing it, and that approval rests on the design rather than softening it — **an API base
/// is public the way every application's is.** It is on the wire of every request that uses it and
/// it ships inside the binary whatever this tree says, so withholding it would have hidden it from
/// nobody while leaving this module lying about where it points. What does not belong here are the
/// three secrets the relay holds. §9's table **listed** a fourth, `PATREON_CREATOR_TOKEN`, until
/// 2026-08-29; nothing in the Worker consumes one, and that table says three now.
///
/// **What is not on that host yet is this design's Worker, and the distinction matters.** The host
/// is live — it is the relay the 2026-08-29 end-to-end pass ran against — but what is deployed
/// there is the pre-entitlement code: no auth gate, no `/claim`, no `/token`, no `/g/…/rotate`,
/// no `/g/…/keys`, no OAuth callback, no webhook, no D1 binding. **A device pointed at it today
/// reaches a real relay that answers none of the endpoints this module calls.** That is Wave 2 and
/// a deploy, not a placeholder, and it fails differently: a 404 from a server that is there,
/// rather than a name that will not resolve. `docs/reference/hosted-relay-deploy.md`'s step 0 is
/// how to check that claim against the host rather than against this comment.
pub const RELAY_BASE: &str = "https://mtg-grimoire-relay.denmark-east.workers.dev";

/// The OAuth client id, real since `a0eb0c6` (committed 2026-08-30, against the verification
/// recorded below, which was taken the day before) and public by the same argument as [`RELAY_BASE`]:
/// it is on the wire of every authorize request, so withholding it from this repository would
/// hide it from nobody. **`client_secret` never belongs here** — it lives only as a Worker
/// secret, which is what makes the code exchange server-side rather than a choice.
///
/// **It must equal `PATREON_CLIENT_ID` in `relay/wrangler.jsonc`'s `vars`.** This side builds the
/// authorize URL and the relay side builds the exchange; Patreon compares them, and a mismatch
/// fails at the exchange rather than at the consent screen, where the error names no client.
///
/// Verified live on 2026-08-29: `GET /oauth2/authorize` with this id and
/// [`PATREON_REDIRECT_PATH`] answered 302 to Patreon's login, preserving both parameters — which
/// an unregistered id or a mismatched redirect does not do.
pub const PATREON_CLIENT_ID: &str =
    "UFkUESN45GFyy36WQBaOpedWwFvtcOfujPZz_s8Yhu54z4I7-eA8Zg9lv-FEXqV4";

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

/// The long-lived secret traded for the next [`ACCESS_TOKEN`].
///
/// ⚠️ **Holding one is what "connected" meant, and "connected" is gone** (spec §2.5,
/// 2026-08-30). It now means only *this device is the one that pressed Connect* — which decides
/// which of [`access_token`]'s two doors it takes and nothing else. **Whether a device is
/// entitled is a fact about its group**, answered by `commands::entitled`; a device that has only
/// ever paired never holds this key and is entitled all the same.
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

/// What the **group door** answers when the relay refuses this device's group auth.
///
/// **A 401 here is not a lapse, and that is the whole reason this constant exists.** The group
/// auth is derived from the group key ([`crypto::relay_auth`]), so a rotation this device has not
/// caught up with produces *exactly* the refusal a cancelled membership does — same status, same
/// body, same everything. [`revoke`]ing on it would tell a reader their membership ended because
/// a **sibling device removed somebody an hour ago**, which is the wrong sentence about the wrong
/// event, and it would clear a grant that is still good.
///
/// So the two are told apart out of band rather than guessed at: the caller asks `/keys`, which
/// accepts an auth up to eight epochs old, and learns which of the two it is — a device merely
/// behind gets a blob and adopts it, a device that was removed is not on the manifest at all.
/// Only a second refusal, with the epoch confirmed current, is a lapse.
///
/// **Named so `client` can act on it without matching a sentence.** The wording is a reader's
/// sentence and may be reworded; the comparison is against this constant.
pub const STALE_GROUP_AUTH: &str = "the relay did not recognise this device's group key";

/// What a **403** from `/token` or `/claim` becomes: the account already holds its five devices.
///
/// ⚠️ **A 403 is the cap and must never be routed through the 401 path.** That path calls
/// [`revoke`], which leaves the mark [`membership_ended`] reads — so a reader plugging in their
/// sixth device would be told their **membership had ended**, and shown spec §7.1's reassurance
/// that no local data was touched, over a pledge that is perfectly fine. The relay uses two
/// statuses because these are two events: 401 is *there is nothing left to trade*, 403 is *there
/// is, and this device may not have it*.
///
/// **Nothing is cleared on it**, for [`STALE_GROUP_AUTH`]'s reason arriving from a second
/// direction: the grant is still good and the five devices that are in are unaffected — it is
/// only *this* device that is one too many, and a refusal that threw the grant away would make a
/// sixth machine plugged in for a minute cost the reader the five that were working.
///
/// It names the number, because a refusal a reader cannot count against is one they will press
/// again, and it names both ways out. Each of them publishes a manifest, and a manifest is what
/// frees a slot on the relay (spec §4.4).
///
/// **`identity::GROUP_IS_FULL` is the same limit in a different sentence, and the pair is
/// deliberate rather than a duplication to fold.** That one is the *client's* refusal at the
/// pairing ceremony — spec §4.3's "the client is the message" — and reaches a reader who has not
/// paired yet. This one is the *relay's*, and reaches a device that is already paired and is
/// asking for a token it cannot have, which is the case a modified build produces and the reason
/// the fence is on the far side at all.
pub const GROUP_IS_FULL: &str = "This membership already covers five devices, which is the \
     limit. Remove one from the list of devices, or leave the group on a device you no longer \
     use, and this one can join.";

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

/// What the **group door** answers: [`Grant`] without the refresh secret.
///
/// **A separate struct rather than an `Option<String>` on [`Grant`], and the omission is the
/// point rather than an economy.** A device that reached `/token` by proving it is in the group
/// has proved nothing about the Patreon account behind it; handing it the credential that can
/// re-register the group auth would make every paired device able to evict every other one,
/// which is the failure `pairing.rs` dropping the secret from its blob exists to prevent. So the
/// field is not merely unread here — the relay never sends it.
///
/// The second reason is local: [`store_grant`] refuses an empty refresh secret today and should
/// keep refusing one, because an access token with no refresh secret beside it reads as
/// disconnected everywhere in this module. A guard that catches a real mistake must not be
/// weakened to accommodate a case that is not one, so this path writes through [`store_access`]
/// instead and the guard stands.
#[derive(Debug, Clone, Deserialize)]
struct GroupGrant {
    access: String,
    /// **Unix seconds**, [`Grant::expires`]' rule and [`SECONDS_CEILING`]'s reason — the same
    /// relay, counting in milliseconds throughout, converting at the same boundary.
    expires: i64,
    status: String,
    #[serde(default)]
    since: Option<i64>,
}

// ---------------------------------------------------------------------------------------
// `sync_state`
// ---------------------------------------------------------------------------------------

/// The relay's base URL: the override if there is one, [`RELAY_BASE`] otherwise.
///
/// **This never answers `None`**, which is the difference from the `client::relay_url` it
/// replaced — that one meant "sync is off" by answering `None`, briefly became
/// `Some(base(conn))`, and is now deleted; this is the only place the address is decided.
/// The override is `client::RELAY_URL` and has no UI. It exists for the tests that stand a server
/// on localhost — `client/tests.rs`, and this module's own endpoint tests. A **blank** value
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
/// [`store_status`], which [`store_access`] needs as well — the group door writes a token with no
/// secret beside it and the same status. Folding the status in here would mean writing it twice.
/// ⚠️ This said the split was for pairing, which "carries the refresh secret to a second device
/// (spec §6.2)"; **that stopped being true on 2026-08-30** and the split outlived the reason.
///
/// **The two calls are not one transaction, and the window is reachable.** Every path writes the
/// grant and then the status, and [`store_status`] refuses a millisecond `since` — so a relay
/// answering one leaves this device holding a grant with no status at all. That state must read
/// as *entitled*, which is what `commands::entitled`'s refresh-secret arm gives it.
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

/// Store a token the **group door** minted, and the moment it dies.
///
/// **Two keys, and never [`REFRESH_SECRET`] — the absence is the whole function.** A device
/// entitled through its group has no Patreon-side secret and must not appear to have one: every
/// read in this module treats holding that key as "this device connected", so writing anything
/// there would send the next [`access_token`] through the refresh door with a value the relay has
/// never minted — a 401 that *is* read as a lapse, ending a membership that never ended. Writing
/// the *access* token there would be worse still, because it expires in a day and the sentence
/// the reader gets is *Membership ended*.
///
/// [`store_grant`]'s two guards, for [`store_grant`]'s reasons: a blank token is refused because
/// every read here calls a blank absent, and a millisecond `expires` is refused because
/// [`SECONDS_CEILING`] describes a failure that is silent and permanent.
///
/// The two writes go in one transaction. Neither half alone is a catastrophe — a token with no
/// expiry refreshes on every call, an expiry with no token refreshes once — but they are one
/// fact, and a half-written one leaves the margin comparison describing a token that is not
/// there.
pub fn store_access(conn: &Connection, access: &str, expires: i64) -> Result<(), String> {
    if access.trim().is_empty() {
        return Err("the relay answered a blank token".to_owned());
    }
    let expires = checked_seconds("expires", expires)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    client::set_state(&tx, ACCESS_TOKEN, access).map_err(|e| e.to_string())?;
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

/// **A membership that ended, as against one that never began — asked only of a device that is
/// not entitled.**
///
/// Spec §10 asks the panel for three sentences — *Supporting since …*, *Not connected*, and
/// *Membership ended* — and §7.1 puts the reassurance that no local data was touched on the third
/// one. So the third has to be reachable, and after [`revoke`] the only thing separating it from a
/// device fresh out of the box is that a `SUPPORTER_STATUS` row exists at all. That is what this
/// reads.
///
/// ⚠️ **It over-claims on its own and must never be the first question.** This is
/// `refresh_secret.is_none() && SUPPORTER_STATUS.is_some()`, and **a device entitled through its
/// group holds a status and no secret** (spec §2.2) — so it answers `true` for a membership that
/// is live and has ended nothing. The heading above was written when holding a refresh secret was
/// what "connected" meant; it is not, since 2026-08-30. What keeps the panel right is the order:
/// `commands::supporter_status` asks `commands::entitled` first and only reaches this when the
/// answer is `false`, which is exactly the case this function is about. **Order matters here now,
/// where before it did not** — a call site that asked this alone would draw *Membership ended*
/// over an `active` status on every paired device in a supporting group.
///
/// True only once the tokens are gone: an `active` or `grace` device has a status row too, and it
/// has not ended anything. **[`clear`] deliberately does not leave the mark** — a reader who
/// pressed Disconnect, or a device that was removed from its group, chose or suffered something
/// that is not a lapse, and telling them their membership ended would be a lie about it.
pub fn membership_ended(conn: &Connection) -> bool {
    refresh_secret(conn).is_none() && client::get_state(conn, SUPPORTER_STATUS).is_some()
}

/// The relay refused the refresh secret: forget the tokens, **remember that there was a
/// membership**.
///
/// [`clear`] plus one row, and the row is the whole point — see [`membership_ended`]. This is the
/// call for a 401 on the **refresh** door, and [`clear`] is the call for everything that is not a
/// lapse.
///
/// **`client::lapsed` calls this and always has**, on a 401 from push, pull or ack — the same
/// event through a different route. ⚠️ This paragraph used to say that it *should* and did not,
/// "in another agent's file this wave"; **corrected 2026-08-30**, and it implied a defect that
/// never existed.
///
/// ⚠️ **`client::check_keys` deliberately calls [`clear`] instead**, and the two must not be
/// collapsed. A device that finds itself off the manifest has been removed from a group; its
/// reader's pledge is untouched, so `revoke`'s mark would draw *Membership ended* and §7.1's
/// reassurance at somebody whose membership is fine. **A 401 from the *group* door is neither
/// call** — see [`STALE_GROUP_AUTH`], which is a stale auth rather than a lapse and clears
/// nothing at all.
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
///
/// **Split into an app arm and a test arm for [`super::client::http`]'s reason**, and taken
/// here as well because the shape is identical rather than because this module was measured
/// flaking: one static client, `httpmock`'s pooled ports, and a runtime per `#[tokio::test]`.
/// Fixing one of a matched pair and leaving the other is how the survivor gets diagnosed from
/// scratch in six months.
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

/// The one place this client's shape is written down. **Its read timeout is 10 seconds, not
/// the relay client's 30**, which is the whole reason the two exist separately.
#[cfg(not(target_family = "wasm"))]
fn build_http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(crate::scryfall::USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_default()
}

/// **No `OnceLock` and no timeouts, and neither is an oversight** — `client::http`'s reasoning
/// exactly: reqwest's wasm client wraps JS values and is not `Sync`, so it cannot be a `static`,
/// and its builder has neither timeout method there because `fetch` owns the deadline.
#[cfg(target_family = "wasm")]
fn http() -> reqwest::Client {
    reqwest::Client::new()
}

/// This device's id, the `device` field every request here now carries (spec §4.2).
///
/// **[`identity::ensure`] rather than a bare read, and it is the call every pairing entrance
/// already makes.** Nothing reaches this function without a group or a refresh secret, so an
/// identity is there in practice — but `ensure` is what makes that a fact instead of an
/// assumption, and the one thing it will not do is re-mint: a restored `user.db` is the device it
/// was. That matters more here than anywhere, because the relay's roll is a count of device ids
/// and a fork would spend one of the reader's five slots per restore.
///
/// **It is not on a hot path, which is the objection `ensure`'s own doc raises.** It runs only
/// where a request is about to be made — the two doors and [`claim`] — and [`access_token`]
/// answers a token with life left long before reaching either, so a device syncing every minute
/// asks this about once a day.
fn this_device(conn: &Connection) -> Result<String, String> {
    identity::ensure(conn)
        .map(|me| me.device_id)
        .map_err(|e| e.to_string())
}

/// The relay's marker for the one 403 that is the device cap.
///
/// **It must equal `DEVICE_LIMIT` in `relay/src/claim.ts`.** Nothing checks that across the two
/// languages — `ipc.ts` has the same problem one boundary over, and both were nearly shipped
/// broken today — so the pair is named on both sides and asserted in this module's tests.
pub const DEVICE_LIMIT: &str = "device_limit";

/// A refusal body, as every route on the relay writes one.
///
/// `Default` so an unparseable or empty body is a refusal with no code and no sentence rather
/// than an error of its own: a 403 whose body did not arrive is still a 403, and the caller
/// needs a sentence more than it needs the parse failure.
#[derive(Debug, Clone, Default, Deserialize)]
struct Refusal {
    #[serde(default)]
    error: String,
    #[serde(default)]
    code: Option<String>,
}

/// `POST {base}{path}` with a JSON body, answering the grant the relay minted.
///
/// `Ok(None)` is a **401 and nothing else**: the relay refused the credential. What that costs is
/// the caller's decision, and no caller records it anywhere — and the three callers now disagree
/// about that cost completely: `/claim`'s 401 is a refused press, `/token`'s refresh door is a
/// lapse, and `/token`'s group door is [`STALE_GROUP_AUTH`], which is neither.
///
/// **A 403 is [`GROUP_IS_FULL`] and is answered here rather than by any caller**, which is the
/// one place in this module where all three agree: the relay admits a device on every token it
/// would issue, so the cap can refuse any of these routes and means the same thing on each. It is
/// an `Err`, which is what keeps it out of the 401 machinery altogether — every caller's 401 arm
/// clears something and no caller's `Err` arm clears anything.
///
/// **Generic over the answer because `/token` has two doors that answer two shapes** — [`Grant`]
/// and [`GroupGrant`] — and the difference is one absent field. A single struct with an
/// `Option<String>` would have made the two indistinguishable at the type level, which is exactly
/// the distinction [`store_grant`]'s blank-secret guard rests on.
async fn post_for_grant<T: DeserializeOwned>(
    conn: &Connection,
    path: &str,
    body: String,
) -> Result<Option<T>, String> {
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
    // ⚠️ **Above the generic arm and never folded into the one above it.** `Ok(None)` is what
    // every caller's lapse handling hangs off; a 403 arriving there would `revoke` a grant that
    // is still good and tell a reader at their sixth device that their membership had ended.
    if status == 403 {
        // ⚠️ **Not every 403 is the cap, and reading the status alone gets this wrong.**
        // `/claim` answered 403 to *that membership no longer exists* and *that membership is
        // not active* long before a device limit existed, so a bare `status == 403` tells a
        // reader whose pledge has lapsed that they already have five devices — the wrong
        // sentence about the wrong problem, and one that sends them to remove a device instead
        // of to renew. The relay stamps `code: "device_limit"` on the three refusals that
        // really are the cap; anything else 403 keeps the relay's own sentence, which is
        // already written for a reader.
        //
        // **Matched on the code and never on `error`**, which is copy and is free to be
        // improved: a string comparison here would break the app on a wording change.
        let text = response.text().await.unwrap_or_default();
        let refusal: Refusal = serde_json::from_str(&text).unwrap_or_default();
        return Err(if refusal.code.as_deref() == Some(DEVICE_LIMIT) {
            GROUP_IS_FULL.to_owned()
        } else if refusal.error.trim().is_empty() {
            format!("the relay answered {status} to {path}")
        } else {
            refusal.error
        });
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
/// **Two doors, and which one this device uses is decided by what it holds** (spec §2.2). The
/// refresh door is for the device that pressed Connect; the group door is for **every other
/// device in its group**, which is how "if any device in a group is supporting, all of them are"
/// stopped being something pairing happened to carry and became a property of the protocol. A
/// device holding both a secret and a group takes the refresh door, because that is the door
/// that can also re-mint the secret.
///
/// Five answers, and only three of them are errors:
///
/// * **`Ok(None)`, no refresh secret *and* no group** — sync is off. Not an error; it is where
///   every existing installation stands.
/// * **`Ok(None)`, a 401 from the refresh door** — the membership has ended. The grant is
///   [`revoke`]d, so the panel offers the connect button *and* can still say which of the two
///   silences this is, and no `error_log` row is written (spec §10).
/// * **`Err(STALE_GROUP_AUTH)`, a 401 from the group door** — which is *not* the same event, and
///   nothing is cleared. See that constant.
/// * **`Err(GROUP_IS_FULL)`, a 403 from either door** — the account already holds five devices
///   and this one is the sixth. Nothing is cleared, and the status is deliberately not the 401:
///   see that constant.
/// * **`Err`** — the relay could not be reached, or answered something else. A network failure is
///   a network failure and the caller reports it.
pub async fn access_token(conn: &Connection) -> Result<Option<String>, String> {
    let refresh = refresh_secret(conn);
    let group = identity::group(conn).map_err(|e| e.to_string())?;
    // **Neither is sync off, and it is the one silence this module answers rather than reports.**
    // A device in a group is now worth a request even with no secret of its own, so the guard
    // that used to be "no refresh secret" had to widen — but not to nothing, or a device that has
    // neither paired nor connected would post to the relay on every press.
    if refresh.is_none() && group.is_none() {
        return Ok(None);
    }
    let stored = client::get_state(conn, ACCESS_TOKEN).filter(|t| !t.trim().is_empty());
    let expires: Option<i64> = client::get_state(conn, ACCESS_EXPIRES).and_then(|v| v.parse().ok());
    if let (Some(token), Some(expires)) = (stored, expires) {
        // A missing or unreadable expiry is treated as expired rather than as "forever": the one
        // thing worse than a needless refresh is a request the relay refuses.
        if expires - now(conn)? > REFRESH_MARGIN_SECS {
            return Ok(Some(token));
        }
    }
    match (refresh, group) {
        (Some(refresh), _) => refresh_door(conn, &refresh).await,
        (None, Some(group)) => group_door(conn, &group).await,
        // Unreachable past the guard above, and **answered rather than panicked**: this arm and
        // that guard mean the same thing, so the only cost of stating it twice is two lines,
        // where an `unreachable!()` would put a panic in a network path to save one of them.
        (None, None) => Ok(None),
    }
}

/// Trade the long-lived secret for the next access token. Today's path, unchanged.
///
/// A 401 is a **lapse**: the relay deletes the refresh secret when a membership ends, so a
/// refusal here is the relay saying there is nothing left to trade.
///
/// **`device` rides this door as well as the group one, and this is the door that makes the cap
/// mean anything** (spec §4.2). The device that pressed Connect holds a refresh secret, so it
/// takes this door and never the group one — a roll fed only by `group_door` would never count
/// the one device that is certainly signed in, and the reader's own words are that the limit
/// covers accounts inheriting the sign-in from another grouped device *too*.
async fn refresh_door(conn: &Connection, refresh: &str) -> Result<Option<String>, String> {
    let body = serde_json::json!({ "refresh": refresh, "device": this_device(conn)? }).to_string();
    let Some(grant) = post_for_grant::<Grant>(conn, "/token", body).await? else {
        revoke(conn)?;
        return Ok(None);
    };
    store_grant(conn, &grant.access, &grant.refresh, grant.expires)?;
    store_status(conn, &grant.status, grant.since)?;
    Ok(Some(grant.access))
}

/// Mint a token by proving membership of the group, with no Patreon-side secret at all.
///
/// The proof is [`crypto::relay_auth`], one-way from the group key — so every device in the group
/// derives the same value, nothing is distributed, and the relay learns nothing it could use to
/// open a single envelope. The answer carries `status` and `since` as well as the token, which is
/// what lets a freshly paired device draw *Supporting since …* dated rather than the dateless
/// line pairing used to leave it with.
///
/// **A 401 is [`STALE_GROUP_AUTH`] and clears nothing** — read that constant before changing this
/// line to a [`revoke`], because the two failures it conflates are a cancelled membership and a
/// sibling device having removed somebody an hour ago.
///
/// The grant is written through [`store_access`] and never [`store_grant`]: there is no refresh
/// secret in this answer and this device must not appear to hold one.
async fn group_door(conn: &Connection, group: &identity::Group) -> Result<Option<String>, String> {
    let auth = crypto::relay_auth(&group.group_key, &group.group_id, group.epoch);
    // **`device` is the only field here that names a machine.** The auth is derived from the
    // group key, so every device in the group sends the identical string and the relay could not
    // tell a fifth caller from a sixth without this (spec §4.2).
    let body = serde_json::json!({
        "group": group.group_id,
        "auth": auth,
        "device": this_device(conn)?,
    })
    .to_string();
    let Some(grant) = post_for_grant::<GroupGrant>(conn, "/token", body).await? else {
        return Err(STALE_GROUP_AUTH.to_owned());
    };
    store_access(conn, &grant.access, grant.expires)?;
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
    // **The `group`, `epoch` and `auth` fields are what register the group's relay key** (spec
    // §2.1). A claim is the only moment the relay is ever told about a group, so it is the only
    // place the first `relay_auth` can be seeded — and `recordRotation` will accept nothing but a
    // *strictly higher* epoch afterwards, which means a claim that registered nothing leaves a
    // group whose auth no device can ever match and whose rotations are all refused.
    //
    // **The relay refuses a body missing one of them with a 400**, so this is not belt and
    // braces: sending the old two-field body makes every Connect press fail with `malformed
    // claim`, on a route whose whole job is the reader's first contact with the service.
    //
    // **`device` is the fifth and is here for `/token`'s reason** (spec §4.2): the relay admits a
    // device on any token it would issue, and a claim issues one. It is also the *only* request
    // the connecting device is guaranteed to make, since a claim that succeeds leaves a token
    // with a day's life and no door is taken again until it nears the margin.
    let body = serde_json::json!({
        "code": code,
        "group": group.group_id,
        "epoch": group.epoch,
        "auth": crypto::relay_auth(&group.group_key, &group.group_id, group.epoch),
        "device": this_device(conn)?,
    })
    .to_string();
    // `/claim` answers the **full** [`Grant`]: a claim is the one moment the refresh secret is
    // minted, so this is the door that must receive one.
    let Some(grant) = post_for_grant::<Grant>(conn, "/claim", body).await? else {
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
/// **`state` is minted by the caller and nothing checks it, and this doc used to claim otherwise.**
/// It said the value "is checked when the code comes back", which no code on either side does:
/// the redirect lands on the *relay* (that is §6.1's whole point), so `state` never returns to
/// this device, and the relay cannot check it either — it holds no record of a flow it did not
/// start. `claim.ts`'s `handleCallback` and `commands.rs`'s `PATREON_STATE` are both explicit
/// about that, and this line was the outlier a reviewer would have trusted.
///
/// What it buys today is what the OAuth parameter is for at minimum: it is echoed by Patreon, so
/// it is the hook a later check hangs on — the relay stamping it into the claim page, or carrying
/// it on `/claim`. Minting it now makes that a one-line change rather than a protocol one. What
/// actually binds a claim code to the reader who consented is the code itself: shown only to the
/// browser session that finished the consent, single-use, and dead in ten minutes.
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
        // `client/tests.rs`, and this file's own `httpmock` block below. A count went here twice
        // and drifted twice; naming the block is a fact a reader can check. Trailing slashes are
        // trimmed because every caller appends its own path.
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
    // Over the wire: the two endpoints, and the margin that decides when `/token` is asked
    //
    // Against `httpmock`, never a deployed Worker - `client/tests.rs`' rule, and it still holds
    // even though the relay's address is now in this file. `RELAY_BASE` is compiled in and public
    // exactly the way any application's API base URL is public: it is on the wire of every request
    // that uses it. What is never in this repository are the three secrets the Worker holds -
    // `PATREON_CLIENT_SECRET`, `PATREON_WEBHOOK_SECRET` and `RELAY_HMAC_KEY` - and a test that
    // reached a deployed Worker would need none of them and still be a test whose result depends
    // on somebody else's uptime. (Spec 9's table *listed* a fourth, `PATREON_CREATOR_TOKEN`, for
    // the reconciliation cron until 2026-08-29. The Worker that was written has no consumer for
    // one - the cron refreshes each subject against their own stored token - and 9 says three now,
    // so this is history rather than a disagreement to go and settle.)
    //
    // Most of what is below was written because a mutation pass found the decision it covers
    // unasserted by anything: dropping the group from `/claim`, turning the 401's `revoke` back
    // into a `clear`, clearing the grant on a *refused claim code*, and moving
    // `REFRESH_MARGIN_SECS` in either direction each left the whole file green. The exception is
    // `claiming_with_no_group_says_so_instead_of_asking`, which pins a refusal that never reaches
    // the network at all - the only test here that registers no mock.
    // -----------------------------------------------------------------------------------

    use httpmock::prelude::*;

    /// The device id every wire test below expects on the `device` field.
    ///
    /// **Seeded rather than minted, so the expectation can be a literal.** `identity::ensure`
    /// mints sixteen random bytes on absence, and a test that read the id back out of the
    /// database it had just handed to the code under test would agree with a body carrying the
    /// wrong device just as happily as with the right one.
    const DEVICE: &str = "dev-1";

    /// The fixture plus the rows `identity::group` and `identity::ensure` read. Written out
    /// rather than climbing the schema ladder, for `db`'s reason.
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
        // **An identity, because every request this module makes now names one** (spec 4.2).
        // `device_names` comes with it: `identity::ensure`'s existing-identity arm files this
        // device's name there if it never has, so a fixture without that table answers
        // "no such table: device_names" from inside a network call.
        //
        // The name is deliberately NOT `identity::PLACEHOLDER` - that value sends `ensure` down
        // its upgrade branch, which writes to `sync_devices` as well and would need a third
        // table here for a reason that has nothing to do with this module.
        conn.execute_batch(
            "CREATE TABLE sync_identity (
                 id INTEGER PRIMARY KEY CHECK (id = 1),
                 device_id TEXT NOT NULL,
                 secret_key BLOB NOT NULL,
                 public_key BLOB NOT NULL,
                 name TEXT NOT NULL,
                 created_at INTEGER NOT NULL
             );
             CREATE TABLE device_names (
                 device_id TEXT PRIMARY KEY,
                 name TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 sync_uid TEXT
             ) WITHOUT ROWID;",
        )
        .expect("sync_identity");
        conn.execute(
            "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
             VALUES (1, ?1, zeroblob(32), zeroblob(32), 'Desk', 0)",
            [DEVICE],
        )
        .expect("the identity row");
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
        //
        // **The epoch and the auth are the same argument one turn further on** (spec 2.1). They
        // register the group's relay key, and a claim is the only moment the relay is ever told
        // about a group - so a body without them leaves a group whose auth no device can match,
        // and `recordRotation` refuses anything but a strictly higher epoch afterwards. The relay
        // answers 400 to a body missing either, so the failure is every Connect press.
        //
        // **The expected auth is DERIVED here rather than written down**, from the fixture's own
        // key, id and epoch. A hex literal would pass against a `claim` that derived its auth from
        // the wrong epoch just as happily, because the literal would have been copied from
        // whatever the code produced on the day it was written.
        let server = MockServer::start_async().await;
        let expected_auth = crypto::relay_auth(&[0u8; 32], "grp-1", 0);
        let mock = server.mock(|when, then| {
            when.method(POST)
                .path("/claim")
                .json_body(serde_json::json!({
                    "code": "ABCD-1234",
                    "group": "grp-1",
                    "epoch": 0,
                    "auth": expected_auth,
                    // **The fifth field, and `/claim` needs it for `/token`'s reason** (spec
                    // 4.2): the relay upserts `(group, device)` on any token it would issue,
                    // and a claim issues one. Without it the device that connected Patreon -
                    // the one device that is certainly signed in - is the one the roll never
                    // hears about.
                    "device": DEVICE,
                }));
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
    async fn a_401_from_claim_is_a_refused_press_and_clears_nothing() {
        // **The same status code, the opposite meaning, and nothing was holding the difference.**
        // A 401 from `/token` is a lapse and `revoke`s the grant; a 401 from `/claim` is the relay
        // refusing *this code* - it is one-time and expires in ten minutes (spec 6.1) - so a
        // reader who mistypes one, or pastes one they already spent, must still hold the
        // entitlement they had a moment ago. Inserting `revoke(conn)?` beside the `Err` below left
        // all 1786 tests green: this is the mutation that found this test missing, and the
        // assertions are the whole of what fails under it.
        let server = MockServer::start_async().await;
        let mock = server.mock(|when, then| {
            when.method(POST).path("/claim");
            then.status(401).body("");
        });
        let conn = db_in_a_group(&server);
        // A device that is already connected, because that is what the mutation would take away.
        // On a fixture with no grant the *deletion* assertions below would pass under the bug -
        // `revoke`'s `clear` half deletes nothing from an empty row set - and only
        // `membership_ended` would still have caught it, because `revoke`'s second half writes a
        // `SUPPORTER_STATUS` row on any database at all. One surviving assertion is not the
        // margin to leave: the grant is stored so that every line below fails when it is cleared.
        store_grant(&conn, "a1", "r1", 1_900_000_000).expect("store");
        store_status(&conn, "active", Some(1_740_000_000)).expect("status");

        let error = claim(&conn, "WRONG-CODE").await.expect_err("a refusal");

        mock.assert();
        assert_eq!(error, "the relay refused that claim code");
        assert_eq!(
            refresh_secret(&conn).as_deref(),
            Some("r1"),
            "a mistyped code must not cost the reader the membership they already hold"
        );
        assert_eq!(
            client::get_state(&conn, ACCESS_TOKEN).as_deref(),
            Some("a1")
        );
        assert_eq!(
            supporter_state(&conn),
            ("active".to_owned(), Some(1_740_000_000))
        );
        assert!(
            !membership_ended(&conn),
            "a refused press is not a lapse, and the panel must not say one ended"
        );
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

    // -----------------------------------------------------------------------------------
    // The device cap: a 403, which is NOT a 401
    //
    // The three tests below are one assertion made on three routes, because the relay admits a
    // device on every token it would issue and all three of these issue one. What each is
    // guarding against is the same single line: routing 403 into the 401 branch. That branch
    // calls `revoke`, whose mark is what `membership_ended` reads, so the mutation's whole
    // visible effect is a reader at their sixth device being told their *pledge* ended - and
    // being shown 7.1's "your data is untouched" paragraph, which answers a question they did
    // not ask about an event that did not happen.
    // -----------------------------------------------------------------------------------

    #[tokio::test]
    async fn a_403_on_the_refresh_door_is_the_device_cap_and_never_a_lapse() {
        // **The one this task turns on.** A 401 here really is a lapse - the relay deletes the
        // refresh secret when a membership ends - so this door is where the two statuses are
        // most easily conflated and where conflating them costs the most.
        //
        // What makes it red: routing 403 through the 401 branch (which answers `Ok(None)`, so
        // `expect_err` panics, and then fails all four assertions below); letting 403 fall
        // through to `post_for_grant`'s generic arm (the sentence is then "the relay answered
        // 403 to /token", which names nothing a reader can act on).
        let server = MockServer::start_async().await;
        let mock = server.mock(|when, then| {
            when.method(POST).path("/token");
            then.status(403)
                .body(r#"{"error":"five devices already","code":"device_limit"}"#);
        });
        let conn = db_in_a_group(&server);
        // A device that is really connected and whose token is past its margin, so the door is
        // genuinely taken. Without the stored grant the deletion assertions would pass under the
        // mutation anyway - `revoke`'s `clear` half deletes nothing from an empty row set.
        store_grant(&conn, "a1", "r1", 0).expect("store");
        store_status(&conn, "active", Some(1_740_000_000)).expect("status");

        let error = access_token(&conn).await.expect_err("the cap, not a lapse");

        mock.assert();
        assert_eq!(error, GROUP_IS_FULL);
        assert_eq!(
            refresh_secret(&conn).as_deref(),
            Some("r1"),
            "a sixth device must not cost the reader the five that work"
        );
        assert_eq!(
            client::get_state(&conn, ACCESS_TOKEN).as_deref(),
            Some("a1")
        );
        assert_eq!(
            supporter_state(&conn),
            ("active".to_owned(), Some(1_740_000_000))
        );
        assert!(
            !membership_ended(&conn),
            "the panel would draw *Membership ended* at somebody whose pledge is fine"
        );
    }

    #[tokio::test]
    async fn a_403_on_the_group_door_is_the_cap_rather_than_a_stale_auth() {
        // The group door has its own 401 sentence, so a 403 landing in that branch here does not
        // revoke - it answers STALE_GROUP_AUTH, which sends `client::check_keys` off to /keys to
        // tell a rotation from a lapse. It would come back saying this device is on the manifest
        // and healthy, and the sync would fail again next time with the same wrong sentence for
        // ever, never once naming the limit the reader has actually hit.
        //
        // What makes it red: `assert_eq!(error, GROUP_IS_FULL)` fails under the 401 routing
        // (STALE_GROUP_AUTH) and under the generic arm ("the relay answered 403 to /token").
        let server = MockServer::start_async().await;
        let mock = server.mock(|when, then| {
            when.method(POST).path("/token");
            then.status(403)
                .body(r#"{"error":"five devices already","code":"device_limit"}"#);
        });
        let conn = db_in_a_group(&server);
        store_access(&conn, "a1", 0).expect("a stale token");
        store_status(&conn, "active", Some(1_740_000_000)).expect("status");

        let error = access_token(&conn).await.expect_err("the cap");

        mock.assert();
        assert_eq!(error, GROUP_IS_FULL);
        assert_ne!(error, STALE_GROUP_AUTH);
        assert_eq!(
            client::get_state(&conn, ACCESS_TOKEN).as_deref(),
            Some("a1"),
            "nothing was concluded about the membership, so nothing may be thrown away"
        );
        assert_eq!(
            supporter_state(&conn),
            ("active".to_owned(), Some(1_740_000_000))
        );
    }

    /// **A 403 that is not the cap keeps the relay's own sentence**, and this is the near-miss
    /// the `code` field exists for.
    ///
    /// `/claim` answered 403 to *that membership no longer exists* and *that membership is not
    /// active* long before a device limit existed. Branching on the status alone — which is what
    /// this module did for about an hour today — tells a reader whose pledge has lapsed that they
    /// already have five devices: the wrong sentence about the wrong problem, and one that sends
    /// them to remove a device instead of to renew.
    ///
    /// **Neither suite could see it.** The relay's tests assert the relay's half and the Rust
    /// tests assert this half, and both were green; it was found by reading the other side's
    /// file. That is the third contract in this repo that spans a boundary nothing checks.
    #[tokio::test]
    async fn a_403_that_is_not_the_cap_says_what_the_relay_said() {
        let server = MockServer::start_async().await;
        let mock = server.mock(|when, then| {
            when.method(POST).path("/claim");
            // Verbatim from `relay/src/claim.ts`'s pre-existing refusal - no `code` on it.
            then.status(403)
                .body(r#"{"error":"that membership is not active"}"#);
        });
        let conn = db_in_a_group(&server);

        let error = claim(&conn, "ABCD-1234").await.expect_err("a refusal");

        mock.assert();
        assert_eq!(
            error, "that membership is not active",
            "a lapsed membership was reported as the device cap"
        );
        assert_ne!(
            error, GROUP_IS_FULL,
            "the cap sentence reached the wrong 403"
        );
    }

    /// The two spellings of the marker are one contract across two languages, and **nothing
    /// checks it** - the same shape that nearly shipped `connected`/`entitled` broken.
    #[test]
    fn the_device_limit_marker_is_the_one_the_relay_stamps() {
        assert_eq!(DEVICE_LIMIT, "device_limit");
    }

    #[tokio::test]
    async fn a_403_from_claim_names_the_limit_rather_than_the_code() {
        // `/claim` issues a token, so it admits a device too - and its 401 already means
        // something else again (the code was refused). A reader connecting Patreon on a sixth
        // machine would otherwise be told to check the code they pasted, which is correct
        // advice about the wrong problem: the code was fine, and re-pasting it will fail
        // identically for ever.
        //
        // What makes it red: the 401 routing answers "the relay refused that claim code"; the
        // generic arm answers "the relay answered 403 to /claim"; and clearing anything on the
        // way out fails the three below - a `revoke` in `post_for_grant`'s 403 arm survived the
        // first draft of this test, which stored no grant for it to take away.
        let server = MockServer::start_async().await;
        let mock = server.mock(|when, then| {
            when.method(POST).path("/claim");
            then.status(403)
                .body(r#"{"error":"five devices already","code":"device_limit"}"#);
        });
        let conn = db_in_a_group(&server);
        // A reader who already holds a membership and is connecting a sixth machine. The press
        // is refused; what they hold is not.
        store_grant(&conn, "a1", "r1", 1_900_000_000).expect("store");
        store_status(&conn, "active", Some(1_740_000_000)).expect("status");

        let error = claim(&conn, "ABCD-1234").await.expect_err("the cap");

        mock.assert();
        assert_eq!(error, GROUP_IS_FULL);
        assert_eq!(refresh_secret(&conn).as_deref(), Some("r1"));
        assert_eq!(
            supporter_state(&conn),
            ("active".to_owned(), Some(1_740_000_000))
        );
        assert!(!membership_ended(&conn));
    }

    #[test]
    fn the_cap_sentence_counts_the_devices_and_names_a_way_out() {
        // The three tests above compare against the constant, which pins *which* sentence is
        // answered and nothing about what it says. This pins the part a reader depends on:
        // a refusal they cannot count against is one they will press again, and a limit with no
        // way out is a dead end rather than an instruction.
        //
        // What makes it red: a bare "Forbidden", a sentence that names the limit without a
        // remedy, or one that reaches for the membership vocabulary - which is precisely the
        // wrong story and the one the 401 path would have told.
        assert!(GROUP_IS_FULL.contains("five"), "{GROUP_IS_FULL}");
        assert!(GROUP_IS_FULL.contains("limit"), "{GROUP_IS_FULL}");
        assert!(GROUP_IS_FULL.contains("Remove"), "{GROUP_IS_FULL}");
        assert!(GROUP_IS_FULL.contains("leave the group"), "{GROUP_IS_FULL}");
        assert!(
            !GROUP_IS_FULL.to_lowercase().contains("membership ended"),
            "the cap is not a lapse and must not read like one: {GROUP_IS_FULL}"
        );
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
                // **`device` on the refresh door as well as the group one, and this is the
                // door that made the cap possible at all** (spec 4.2). The device that
                // pressed Connect reaches the relay here and never through the group door,
                // so a roll fed only by the group door would never count the one device
                // that is certainly signed in - and five would mean six.
                .json_body(serde_json::json!({ "refresh": "r1", "device": DEVICE }));
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

    // -----------------------------------------------------------------------------------
    // The group door
    // -----------------------------------------------------------------------------------

    /// The group `db_in_a_group` seeds, spelled out so the expectations below do not read
    /// themselves off the database the code under test read.
    ///
    /// A `zeroblob(32)` key, group `grp-1`, epoch `0`. Every one of the three is written
    /// literally here, so an implementation that derived the auth from the wrong epoch — the
    /// mistake `relay_auth`'s own doc calls the one the relay's monotonic check depends on — is
    /// a body the mock does not match.
    fn seeded_group_auth() -> String {
        crate::sync_pair::crypto::relay_auth(&[0u8; 32], "grp-1", 0)
    }

    #[tokio::test]
    async fn a_device_with_no_secret_mints_through_the_group_door() {
        // **The whole of spec item 3.** Before this, reaching the relay needed a token, a token
        // needed the refresh secret, and the refresh secret travelled only in a pairing blob - so
        // a reader who paired first and connected second had a second device that could never
        // become entitled. This device holds no secret at all and mints one anyway, on nothing
        // but the group key every paired device already has.
        let server = MockServer::start_async().await;
        let mock = server.mock(|when, then| {
            when.method(POST)
                .path("/token")
                .json_body(serde_json::json!({
                    "group": "grp-1",
                    "auth": seeded_group_auth(),
                    // The group auth is a fact about the *group* - every device in it derives
                    // the same string - so it names nobody. `device` is the only thing on this
                    // body that says which machine is asking, and the roll is a count of
                    // machines.
                    "device": DEVICE,
                }));
            then.status(200).body(
                r#"{"access":"a1","expires":1900000000,
                    "status":"active","since":1740000000}"#,
            );
        });
        let conn = db_in_a_group(&server);

        let token = access_token(&conn).await.expect("minted");

        mock.assert();
        assert_eq!(token.as_deref(), Some("a1"));
        assert_eq!(
            client::get_state(&conn, ACCESS_TOKEN).as_deref(),
            Some("a1")
        );
        assert_eq!(
            client::get_state(&conn, ACCESS_EXPIRES).as_deref(),
            Some("1900000000")
        );
        // `status` and `since` have no local source at all, so without them the panel could say
        // "connected" and never "supporting since March" - which is the dateless line pairing
        // used to leave a joined device holding, and the reason the group door answers them.
        assert_eq!(
            supporter_state(&conn),
            ("active".to_owned(), Some(1_740_000_000))
        );
        // **And no refresh secret was invented.** One written here would send the next call
        // through the refresh door with a value the relay never minted - a 401 that *is* read as
        // a lapse, ending a membership that never ended.
        assert_eq!(refresh_secret(&conn), None);
    }

    #[tokio::test]
    async fn a_401_on_the_group_door_is_not_a_lapse_and_clears_nothing() {
        // **The assertion this whole task turns on.** The group auth is derived from the group
        // key, so a rotation this device has not caught up with produces exactly the refusal a
        // cancelled membership does. `revoke`ing on it tells a reader their membership ended
        // because a *sibling device removed somebody an hour ago* - the wrong sentence about the
        // wrong event, over a grant that is still perfectly good.
        let server = MockServer::start_async().await;
        let mock = server.mock(|when, then| {
            when.method(POST).path("/token");
            then.status(401).body("");
        });
        let conn = db_in_a_group(&server);
        // A device that is already entitled through its group: a token past its margin, so the
        // door is really asked, and the status a previous successful mint left behind. Without
        // these the deletion assertions below would pass under the mutation - `revoke`'s `clear`
        // half deletes nothing from an empty row set.
        store_access(&conn, "a1", 0).expect("a stale token");
        store_status(&conn, "active", Some(1_740_000_000)).expect("status");

        let error = access_token(&conn)
            .await
            .expect_err("a refusal, not a lapse");

        mock.assert();
        assert_eq!(error, STALE_GROUP_AUTH);
        // `revoke` writes ("dead", None). Each of these three is red under it, and the third is
        // the one a reader would see: the date under *Supporting since* disappearing.
        assert_eq!(
            supporter_state(&conn),
            ("active".to_owned(), Some(1_740_000_000))
        );
        assert_eq!(
            client::get_state(&conn, ACCESS_TOKEN).as_deref(),
            Some("a1"),
            "nothing was concluded, so nothing may be thrown away"
        );
        assert_eq!(
            client::get_state(&conn, SUPPORTER_SINCE).as_deref(),
            Some("1740000000")
        );
    }

    #[tokio::test]
    async fn no_group_and_no_secret_is_still_sync_off() {
        // Where every existing installation stands, and it is not an error. The group half of
        // the guard is new; the device half is not, and a widening that forgot the second half
        // would have every device that has neither paired nor connected posting to the relay on
        // every press. No mock is registered beyond the catch-all, so a request of any shape at
        // all fails this.
        let server = MockServer::start_async().await;
        let never = server.mock(|when, then| {
            when.any_request();
            then.status(500).body("this must never be asked for");
        });
        let conn = db_with_no_group();
        client::set_state(&conn, client::RELAY_URL, &server.base_url()).expect("override");

        assert_eq!(access_token(&conn).await.expect("not an error"), None);

        never.assert_calls(0);
    }

    #[test]
    fn the_group_door_answers_four_fields_and_never_a_refresh_secret() {
        // Pinning the shape without a server, `Grant`'s test one struct over. **The absent field
        // is the point rather than an economy**: a device that reached `/token` by proving it is
        // in the group has proved nothing about the Patreon account, and handing it the
        // credential that can re-register the group auth would let every paired device evict
        // every other one.
        let body = r#"{"access":"a1","expires":1900000000,"status":"active","since":1740000000}"#;

        let grant: GroupGrant = serde_json::from_str(body).expect("the four-field grant");

        assert_eq!(grant.access, "a1");
        assert_eq!(grant.expires, 1_900_000_000);
        assert_eq!(grant.status, "active");
        assert_eq!(grant.since, Some(1_740_000_000));
        // Seconds, said out loud: the same instant in milliseconds is three orders of magnitude
        // past the ceiling, and this wire comes from a relay that counts in them.
        assert!(grant.expires < SECONDS_CEILING);

        // A membership the relay cannot date, and the field is absent rather than null - the
        // shape a `JSON.stringify` of an undefined field takes.
        let dateless = r#"{"access":"a1","expires":1900000000,"status":"grace"}"#;
        let grant: GroupGrant = serde_json::from_str(dateless).expect("a grant with no since");
        assert_eq!(grant.since, None);
    }

    #[test]
    fn store_access_writes_two_keys_and_never_the_refresh_secret() {
        // **The absence is the function.** `store_grant` refuses a blank refresh secret and must
        // go on refusing one, so the group door cannot go through it - and this is what it goes
        // through instead. Writing REFRESH_SECRET here would make a device the relay minted a
        // group token for look like a device that connected Patreon, and it would take the
        // refresh door from then on with a value that door has never seen.
        let held = db();
        store_grant(&held, "a1", "r1", 1_756_000_000).expect("store");

        store_access(&held, "a2", 1_900_000_000).expect("store_access");

        assert_eq!(
            client::get_state(&held, ACCESS_TOKEN).as_deref(),
            Some("a2")
        );
        assert_eq!(
            client::get_state(&held, ACCESS_EXPIRES).as_deref(),
            Some("1900000000")
        );
        assert_eq!(
            refresh_secret(&held).as_deref(),
            Some("r1"),
            "the secret this device connected with must survive a group-door mint"
        );

        // And on the device this path is actually for, which holds no secret at all: none may
        // appear. This half is red under a mutation that writes REFRESH_SECRET *anything*,
        // where the half above only catches one that overwrites.
        let none_held = db();
        store_access(&none_held, "a3", 1_900_000_000).expect("store_access");

        assert_eq!(refresh_secret(&none_held), None);
        assert_eq!(client::get_state(&none_held, REFRESH_SECRET), None);
    }

    #[test]
    fn store_access_refuses_a_millisecond_expiry_and_a_blank_token() {
        // `SECONDS_CEILING`'s failure, reached through the new path: `expires - now` becomes
        // ~1.8e12, forever past the six-hour margin, so the token is never refreshed and every
        // sync 401s a day later on a route that cannot re-mint. The relay half of this feature
        // counts in milliseconds throughout, and it is the same relay answering both doors.
        let conn = db();

        let error = store_access(&conn, "a1", 1_900_000_000_000).expect_err("refused");

        assert!(error.contains("milliseconds"), "{error}");
        assert_eq!(client::get_state(&conn, ACCESS_TOKEN), None);
        assert_eq!(client::get_state(&conn, ACCESS_EXPIRES), None);

        // A blank is absent to every read in this module, so storing one would leave the device
        // silently not connected while SUPPORTER_STATUS still said `active`.
        assert!(store_access(&conn, "   ", 1_900_000_000).is_err());
        assert_eq!(client::get_state(&conn, ACCESS_EXPIRES), None);
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
