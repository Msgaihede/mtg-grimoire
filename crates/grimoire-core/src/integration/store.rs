//! **The integrations Worker's client** (`infrastructure/integrations-worker/`, plan §3.2): the
//! four requests a device makes of its group's store, and the refusals they answer.
//!
//! | Request | Answers |
//! | --- | --- |
//! | [`digests`] — `GET /g/{group}/projection/digests` | the store's settings and each table's digest, or `None` for no store |
//! | [`put_settings`] — `PUT /g/{group}/settings` | the settings as stored, and whether that made the store; `None` for no store when asked not to make one |
//! | [`put_table`] — `PUT /g/{group}/projection/{table}` | a [`Put`]: stored, stale, other settings, no store, or refused |
//! | [`delete_group`] — `DELETE /g/{group}` | nothing; a 404 is as good as a 204 |
//!
//! **`share::publish`'s conventions, for its reasons**: [`http`] and never a fresh client, the URL
//! from a `format!` over [`base`], the body written by hand with an explicit `content-type`, the
//! bearer as `authorization: Bearer …`, and **every failure an `error_log` row first and a
//! sentence after** (`Source::Relay`, the operation naming the request). A request is made with
//! nothing held: `db` is taken only for the row a failure owes.
//!
//! **A refusal is read by its `code`, never by the Worker's `error`**, which is copy and free to
//! change: `no_store`, `stale_projection` and `settings_mismatch` are states this side acts on,
//! and are not failures — no row. Everything else the Worker refuses is one row and a sentence.
//!
//! **The group's settings are two things, and both are the store's**: the five opt-in fields, and
//! the marketplace its prices are read at ([`StoreSettings`]). The marketplace is a device's own
//! setting, so the store holds one for the group — the device that switched integrations on, or
//! changed its columns last, set it — and every device projects at it, or two devices set to two
//! marketplaces would flip every table's prices and digest between them on every round.
//!
//! **No sentence here names a membership**, and the relay's own text is never passed on: these are
//! the core's sentences, answered on every host — the light app's Play build included, whose host
//! rewords only what a `sync_` command says (`scanner_submit`'s rule, for its reason).

use super::projection::{IntegrationFields, TableDoc};
use crate::errors::{self, Kind, Source};
use crate::platform::http;
use crate::state::Store;
use crate::sync_engine::{client, commands, entitlement};
use crate::sync_pair::identity;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::Duration;

/// The integrations Worker's address — **a placeholder until the owner picks its Custom Domain**
/// (plan §2).
///
/// **Deliberately a string that cannot be mistaken for an address**, `share::publish::SHARE_BASE`'s
/// own history: that constant was `<set on first deploy>` until the share Worker's first deploy,
/// because a guessed host gets copied into documentation and deployed against — what the
/// `database_id` comment in the relay's config records happening. So every build until the
/// deploy refuses every store request before it is made, with [`NOT_DEPLOYED`] and no
/// `error_log` row ([`endpoint`]), and the panel says the service is not in this build.
///
/// ⚠️ **When it becomes an address it is a host in three more places**: the integrations Worker's
/// `routes` in its `wrangler.jsonc`, the web host's `connect-src`
/// (`infrastructure/app-worker/_headers`, whose `hosting.test.ts` census reads every `https://`
/// literal this crate ships) and the privacy policy's table of hosts
/// (`apps/light/public/privacy.html`, held to `connect-src` by `apps/light/host.test.ts`). The
/// census is silent on this placeholder only because it is not an `https://` literal.
///
/// Public on [`entitlement::RELAY_BASE`]'s terms: an API base is on the wire of every request
/// that uses it and ships inside the binary whatever this tree says.
pub const INTEGRATIONS_BASE: &str = "<set on first deploy>";

/// The `sync_state` key holding an override for [`INTEGRATIONS_BASE`] — a test and `wrangler dev`
/// knob with no UI, exactly as `share::publish::SHARE_URL` is for the share Worker. **The only way
/// to exercise this module against a Worker before the first deploy.**
pub const INTEGRATIONS_URL: &str = "integrations_url";

/// The build has no address for the store — every build's answer while [`INTEGRATIONS_BASE`] is a
/// placeholder, and an override with no scheme's after. **Refused before any request and before
/// any `error_log` row**: a build with nowhere to send is a state, not a failure.
pub const NOT_DEPLOYED: &str =
    "This build cannot reach the integrations service yet - it has no address for it.";

/// This device has nothing to ask the store with: it is in no sync group, or no membership covers
/// its group, so the relay mints it no token. **Names no membership and no way to one** — the
/// module header's rule.
pub const NOT_CONNECTED: &str = "Integrations are not available on this device.";

/// The relay could not be asked for this device's token, or answered something that is neither a
/// token nor "no". Its own sentence goes to the `error_log` row and never to the reader: some of
/// them name a membership.
pub const UNCONFIRMED: &str =
    "The integrations service could not confirm this device. Try again in a moment.";

/// The store would not take the token: a 401. A key that is not set on the Worker, a token that
/// died on the way, a device since removed from its group.
pub const NOT_ACCEPTED: &str = "The integrations service did not accept this device.";

/// The refusal codes this side acts on — the Worker's `store.ts` constants, the same words in a
/// second language. Matched as codes, never as sentences.
const NO_STORE: &str = "no_store";
const STALE_PROJECTION: &str = "stale_projection";
const SETTINGS_MISMATCH: &str = "settings_mismatch";

/// The Worker's two caps on one table, `body.ts`'s `MAX_GZIP_BYTES` and `MAX_INFLATED_BYTES` in a
/// second language (`the_caps_are_the_workers_own` multiplies them out of that file). **Asked here
/// before the upload** ([`put_table`]): a table over either is refused by the Worker whatever it
/// says, so it is one `error_log` row and the panel's sentence, not megabytes sent to be refused.
pub const MAX_GZIP_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_INFLATED_BYTES: usize = 24 * 1024 * 1024;

/// The three watermark and digest headers of a projection `PUT` — the Worker's `cors.ts`
/// constants, which its pre-flight allows a page to send.
pub const HLC_MS_HEADER: &str = "x-projection-hlc-ms";
pub const HLC_CTR_HEADER: &str = "x-projection-hlc-ctr";
pub const DIGEST_HEADER: &str = "x-projection-digest";

/// The store's base URL: the override if there is one, [`INTEGRATIONS_BASE`] otherwise. A blank is
/// not an override and a trailing slash goes — `share::publish::base`'s two rules, for its
/// reasons. It judges nothing; [`endpoint`] is the judgement.
pub fn base(conn: &Connection) -> String {
    let stored = client::get_state(conn, INTEGRATIONS_URL).unwrap_or_default();
    let trimmed = stored.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        INTEGRATIONS_BASE.to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// The base to send to, or [`NOT_DEPLOYED`]. **By the scheme and never by equality with the
/// constant**, `share::publish::endpoint`'s lesson: `base == INTEGRATIONS_BASE` would refuse every
/// request the day the constant becomes a host.
pub fn endpoint(conn: &Connection) -> Result<String, String> {
    let base = base(conn);
    if base.starts_with("https://") || base.starts_with("http://") {
        return Ok(base);
    }
    Err(NOT_DEPLOYED.to_owned())
}

/// Whether this device can ask the store at all, by what it holds: in a sync group, and covered
/// by a membership (`sync_engine::commands::entitled`). Local and free — the gate the publish
/// round and the panel ask before any token is minted.
pub fn entitled(conn: &Connection) -> bool {
    commands::entitled(conn) && identity::group(conn).ok().flatten().is_some()
}

/// Where one device's requests go and what they carry: the base, the bearer, and the group whose
/// path it is good for.
#[derive(Debug, Clone)]
pub struct Door {
    base: String,
    token: String,
    group: String,
}

impl Door {
    fn url(&self, path: &str) -> String {
        format!("{}/g/{}{path}", self.base, self.group)
    }

    fn bearer(&self) -> String {
        format!("Bearer {}", self.token)
    }

    /// A door to `base` with `token` for `group`, minted by nobody — for a suite in another module
    /// of this one, which cannot build the struct.
    #[cfg(test)]
    pub(crate) fn for_tests(base: &str, token: &str, group: &str) -> Door {
        Door {
            base: base.to_owned(),
            token: token.to_owned(),
            group: group.to_owned(),
        }
    }
}

/// The door, or the sentence that says why there is none — **in the order a reader can act on**:
/// the build ([`NOT_DEPLOYED`]) before the device ([`NOT_CONNECTED`]), and both before a token is
/// minted, because a token for a request with nowhere to go is a round trip spent on nothing.
///
/// **`db` is the lane, and the token is minted through it** — a token is the sync client's to
/// mint, and it writes the grant a trip or a claim in flight is writing too. A token that cannot
/// be had is [`UNCONFIRMED`], with the relay's own sentence in one `error_log` row under
/// `operation`.
pub async fn door(db: &impl Store, operation: &str) -> Result<Door, String> {
    let base = db.with(|conn| {
        let base = endpoint(conn)?;
        if !entitled(conn) {
            return Err(NOT_CONNECTED.to_owned());
        }
        Ok(base)
    })?;
    let token = match entitlement::access_token(db).await {
        Ok(Some(token)) => token,
        Ok(None) => return Err(NOT_CONNECTED.to_owned()),
        Err(e) => {
            note_in(db, operation, Kind::Other, &e, None);
            return Err(UNCONFIRMED.to_owned());
        }
    };
    let Some(group) = db.with(|conn| identity::group(conn).map_err(|e| e.to_string()))? else {
        return Err(NOT_CONNECTED.to_owned());
    };
    Ok(Door {
        base,
        token,
        group: group.group_id,
    })
}

// ---------------------------------------------------------------------------------------
// What the Worker answers
// ---------------------------------------------------------------------------------------

/// One table, as the digests answer has it. **`published_at` is Unix milliseconds** — the Worker's
/// `Date.now()`, where every clock this crate keeps is seconds.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDigest {
    pub digest: String,
    pub hlc_ms: i64,
    pub hlc_ctr: i64,
    pub rows: i64,
    pub published_at: i64,
}

/// The group's settings, as the store holds them: the opt-in fields, and the marketplace's id
/// (`share::snapshot::marketplace_id`'s spelling) its prices are read at. **`marketplace` is
/// `None` from a Worker that predates it**, which every device reads as TCGplayer — never each
/// device as its own, which would be the flip the store's marketplace exists to stop.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct StoreSettings {
    pub fields: IntegrationFields,
    #[serde(default)]
    pub marketplace: Option<String>,
}

/// `GET …/projection/digests`: the group's settings, and the tables the store holds by name. A
/// table the store has never been sent is absent.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Digests {
    #[serde(flatten)]
    pub settings: StoreSettings,
    #[serde(default)]
    pub tables: BTreeMap<String, TableDigest>,
}

/// `PUT …/settings`: the settings as the store now holds them, and whether this request made it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Settled {
    #[serde(flatten)]
    pub settings: StoreSettings,
    pub created: bool,
}

/// What a projection `PUT` came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Put {
    /// The table is the one this device sent.
    Stored,
    /// The store holds a newer watermark for that table — a device that has seen more published
    /// it. Not a failure, and nothing to do.
    Stale,
    /// The group's settings are not the ones this document was read under — its fields or its
    /// marketplace changed on another device since this one asked. The store's own, for the cache.
    SettingsMismatch(StoreSettings),
    /// The store is gone: switched off on another device. A projection `PUT` never makes one.
    NoStore,
    /// Refused for any other reason — too large (asked here first, [`MAX_GZIP_BYTES`] and
    /// [`MAX_INFLATED_BYTES`]), a document the Worker would not take, a 401, a 5xx. **Already an
    /// `error_log` row**; the sentence is for the panel.
    Refused(String),
}

/// The watermark a table is published under: this device's `sync_clock` reading, `(ms, ctr)` —
/// what orders two devices' publishes of one table.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Watermark {
    pub ms: i64,
    pub ctr: i64,
}

/// This device's hybrid logical clock, as the store orders publishes by. **Read and never
/// written** — the clock is the sync engine's. `(0, 0)` on a database with no row, which the
/// store reads as older than anything.
pub fn watermark(conn: &Connection) -> Result<Watermark, String> {
    use rusqlite::OptionalExtension;
    Ok(conn
        .query_row("SELECT ms, ctr FROM sync_clock WHERE id = 1", [], |r| {
            Ok(Watermark {
                ms: r.get(0)?,
                ctr: r.get(1)?,
            })
        })
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_default())
}

/// What the Worker answers a refusal with — `{ error, code }`, and the store's `fields` and
/// `marketplace` on a `settings_mismatch`. `Default` so an unparseable body still lands on a
/// sentence.
#[derive(Debug, Default, Deserialize)]
struct Refusal {
    #[serde(default)]
    error: String,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    fields: Option<IntegrationFields>,
    #[serde(default)]
    marketplace: Option<String>,
}

impl Refusal {
    fn of(body: &str) -> Refusal {
        serde_json::from_str(body).unwrap_or_default()
    }

    fn is(&self, code: &str) -> bool {
        self.code.as_deref() == Some(code)
    }
}

/// One refusal as the sentence a reader is shown. **A 401 is this side's own sentence**, never
/// the Worker's `unauthorized`; anything else keeps the Worker's `error` — the Worker is ours and
/// its sentences name no membership — or, with none, the status and what was asked.
pub fn refusal(status: u16, body: &str, what: &str) -> String {
    if status == 401 {
        return NOT_ACCEPTED.to_owned();
    }
    let said = Refusal::of(body);
    let said = said.error.trim();
    if said.is_empty() {
        format!("the integrations service answered {status} to {what}")
    } else {
        said.to_owned()
    }
}

// ---------------------------------------------------------------------------------------
// The socket
// ---------------------------------------------------------------------------------------

/// The HTTP client — **its own**, for `share::publish::http`'s reasons: the store is another host,
/// and must not spend Scryfall's pacing budget or join its lockout. An app arm that keeps one, and
/// a test arm that builds one per call, for `sync_engine::client::http`'s reason (one static
/// client, `httpmock`'s pooled ports and a runtime per `#[tokio::test]`).
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

/// The client's one shape: the share client's bounds, because the largest body here is the same
/// order of size — a table's gzip, up to the Worker's 8 MiB — and **a deadline where the host
/// has no socket to bound** (a browser's `fetch`). The publish round holds the sync lane across
/// these requests, so a request that never ended would be every later trip queued behind it.
fn build_http() -> http::Client {
    http::Client::new(&http::Config {
        user_agent: crate::scryfall::USER_AGENT,
        connect_timeout: Some(Duration::from_secs(10)),
        read_timeout: Some(Duration::from_secs(60)),
    })
    .deadline(STORE_DEADLINE)
}

/// **The whole of one request, in a browser: five minutes** — `share::publish`'s
/// `SHARE_DEADLINE`, sized the same way: 8 MiB at the floor of a weak phone uplink. Natively the
/// connect and read bounds already end a request that stops answering.
const STORE_DEADLINE: Duration = Duration::from_secs(300);

/// A transport failure's kind — `share::publish`'s `kind_of`.
fn kind_of(err: &http::Error) -> Kind {
    if err.is_timeout() {
        Kind::Timeout
    } else if err.is_decode() {
        Kind::Parse
    } else {
        Kind::Other
    }
}

/// One `error_log` row in a stretch of its own — `Source::Relay`, as a share's failure is: a
/// Cloudflare Worker over the same network and the same membership as sync, told apart by its
/// operation. It can never fail the thing it describes.
fn note_in(db: &impl Store, operation: &str, kind: Kind, message: &str, url: Option<&str>) {
    let _ = db.with(|conn| {
        errors::record(conn, Source::Relay, operation, kind, message, url);
        Ok(())
    });
}

/// The status and body of one request, or an `Err` that has already been recorded.
async fn send(
    db: &impl Store,
    operation: &str,
    url: &str,
    request: http::Request,
) -> Result<(u16, String), String> {
    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            note_in(db, operation, kind_of(&e), &e.to_string(), Some(url));
            return Err(e.to_string());
        }
    };
    let status = response.status();
    match response.text().await {
        Ok(body) => Ok((status, body)),
        Err(e) => {
            note_in(db, operation, kind_of(&e), &e.to_string(), Some(url));
            Err(e.to_string())
        }
    }
}

/// A 2xx body read as `T`, or a parse failure recorded and said.
fn parsed<T: serde::de::DeserializeOwned>(
    db: &impl Store,
    operation: &str,
    url: &str,
    body: &str,
) -> Result<T, String> {
    serde_json::from_str(body).map_err(|e| {
        note_in(db, operation, Kind::Parse, &e.to_string(), Some(url));
        e.to_string()
    })
}

/// A refusal nothing here acts on: one row, and its sentence.
fn refused(
    db: &impl Store,
    operation: &str,
    url: &str,
    status: u16,
    body: &str,
    what: &str,
) -> String {
    let message = refusal(status, body, what);
    note_in(db, operation, Kind::Http, &message, Some(url));
    message
}

// ---------------------------------------------------------------------------------------
// The four requests
// ---------------------------------------------------------------------------------------

/// `GET /g/{group}/projection/digests` — the store's policy and tables, or `None` when the group
/// has no store (404 `no_store`), which is "off" and not a failure.
pub async fn digests(db: &impl Store, door: &Door) -> Result<Option<Digests>, String> {
    const OPERATION: &str = "integrations_digests";
    let url = door.url("/projection/digests");
    let (status, body) = send(
        db,
        OPERATION,
        &url,
        http().get(&url).header("authorization", &door.bearer()),
    )
    .await?;
    if (200..300).contains(&status) {
        return parsed(db, OPERATION, &url, &body).map(Some);
    }
    if status == 404 && Refusal::of(&body).is(NO_STORE) {
        return Ok(None);
    }
    Err(refused(
        db,
        OPERATION,
        &url,
        status,
        &body,
        "a status check",
    ))
}

/// `PUT /g/{group}/settings` — the group's settings: `{ fields, marketplace, create }`, answered
/// `{ fields, marketplace, created }`. A change of either drops every table the store holds (plan
/// §2), so narrowing the fields takes a column off the server before any device republishes.
///
/// **`create` is the switch's alone** (`enable`): `false` from a change of columns, which a store
/// switched off on another device answers 404 `no_store` — `Ok(None)` here — rather than being
/// made again. So nothing but the switch can make a store, and nothing has to ask first whether
/// there still is one.
pub async fn put_settings(
    db: &impl Store,
    door: &Door,
    fields: IntegrationFields,
    marketplace: &str,
    create: bool,
) -> Result<Option<Settled>, String> {
    const OPERATION: &str = "integrations_settings";
    let url = door.url("/settings");
    let body = serde_json::to_string(&serde_json::json!({
        "fields": fields,
        "marketplace": marketplace,
        "create": create,
    }))
    .map_err(|e| e.to_string())?;
    let (status, text) = send(
        db,
        OPERATION,
        &url,
        http()
            .put(&url)
            .header("content-type", "application/json")
            .header("authorization", &door.bearer())
            .body(body),
    )
    .await?;
    if (200..300).contains(&status) {
        return parsed(db, OPERATION, &url, &text).map(Some);
    }
    if status == 404 && Refusal::of(&text).is(NO_STORE) {
        return Ok(None);
    }
    Err(refused(
        db,
        OPERATION,
        &url,
        status,
        &text,
        "a change of settings",
    ))
}

/// `PUT /g/{group}/projection/{table}` — one table's document, gzipped
/// ([`super::projection::gzip_doc`]), under this device's [`Watermark`] and the document's own
/// `digest`.
///
/// **`application/gzip` and not `content-encoding: gzip`**, the share upload's reason: the bytes
/// are the document as far as the request is concerned, and an intermediary must not decode them.
///
/// **The Worker's two caps are asked first** — the document's JSON against
/// [`MAX_INFLATED_BYTES`] and its gzip against [`MAX_GZIP_BYTES`] — and a table over either is
/// [`Put::Refused`] with one `error_log` row and nothing sent: the Worker would refuse it whatever
/// it said, after the uplink had carried it.
///
/// `Err` is a request that did not come back — a transport failure or an answer that is not one,
/// already recorded. A refusal that did come back is a [`Put`].
pub async fn put_table(
    db: &impl Store,
    door: &Door,
    doc: &TableDoc,
    digest: &str,
    watermark: Watermark,
) -> Result<Put, String> {
    const OPERATION: &str = "integrations_publish";
    let url = door.url(&format!("/projection/{}", doc.table));
    let json = serde_json::to_vec(doc)
        .map_err(|e| e.to_string())
        .inspect_err(|e| note_in(db, OPERATION, Kind::Other, e, Some(&url)))?;
    if let Some(over) = over_a_cap(doc.table, json.len(), MAX_INFLATED_BYTES, "inflated") {
        note_in(db, OPERATION, Kind::Other, &over, Some(&url));
        return Ok(Put::Refused(over));
    }
    let gzip = crate::share::gzip(&json)
        .inspect_err(|e| note_in(db, OPERATION, Kind::Other, e, Some(&url)))?;
    if let Some(over) = over_a_cap(doc.table, gzip.len(), MAX_GZIP_BYTES, "gzipped") {
        note_in(db, OPERATION, Kind::Other, &over, Some(&url));
        return Ok(Put::Refused(over));
    }
    let (status, body) = send(
        db,
        OPERATION,
        &url,
        http()
            .put(&url)
            .header("content-type", "application/gzip")
            .header("authorization", &door.bearer())
            .header(HLC_MS_HEADER, &watermark.ms.to_string())
            .header(HLC_CTR_HEADER, &watermark.ctr.to_string())
            .header(DIGEST_HEADER, digest)
            .bytes(gzip),
    )
    .await?;
    if (200..300).contains(&status) {
        return Ok(Put::Stored);
    }
    let said = Refusal::of(&body);
    Ok(match status {
        404 if said.is(NO_STORE) => Put::NoStore,
        409 if said.is(STALE_PROJECTION) => Put::Stale,
        409 if said.is(SETTINGS_MISMATCH) => match said.fields {
            Some(fields) => Put::SettingsMismatch(StoreSettings {
                fields,
                marketplace: said.marketplace,
            }),
            // A mismatch that does not say what the store holds is nothing this side can act on.
            None => Put::Refused(refused(db, OPERATION, &url, status, &body, "a publish")),
        },
        _ => Put::Refused(refused(db, OPERATION, &url, status, &body, "a publish")),
    })
}

/// The sentence for a table over one of the Worker's caps — the Worker's own words for it, with
/// the table named — or `None` under it.
fn over_a_cap(table: &str, size: usize, cap: usize, what: &str) -> Option<String> {
    (size > cap).then(|| {
        format!(
            "that projection of {table} is {size} bytes {what} and a table may be at most {cap}"
        )
    })
}

/// `DELETE /g/{group}` — the group's store emptied, for every device in it. **A 404 is success**,
/// `share::publish`'s withdrawal's rule: there is nothing on the server, which is what was asked.
pub async fn delete_group(db: &impl Store, door: &Door) -> Result<(), String> {
    const OPERATION: &str = "integrations_delete";
    let url = door.url("");
    let (status, body) = send(
        db,
        OPERATION,
        &url,
        http().delete(&url).header("authorization", &door.bearer()),
    )
    .await?;
    if status == 404 || (200..300).contains(&status) {
        return Ok(());
    }
    Err(refused(db, OPERATION, &url, status, &body, "a switch-off"))
}

// ---------------------------------------------------------------------------------------
// The inbox (PR 3, plan `2026-10-29-integrations-intents.md` §3.2)
// ---------------------------------------------------------------------------------------

/// The inbox's refusal codes this side acts on — the Worker's `intents.ts` constants, the same
/// words in a second language (`the_inbox_codes_and_caps_are_the_workers_own` reads them there).
/// An intent that is gone — acked and purged, or never this group's — is a state, not a failure.
const NO_INTENT: &str = "no_intent";
const CLAIMED: &str = "claimed";
const ALREADY_ACKED: &str = "already_acked";

/// **How long a claim holds an intent for its device** — the Worker's `LEASE_MS`, read here only
/// by the test that holds the two to one number. A device applies within milliseconds of the
/// claim; the lease is what keeps a second device from applying the same add while it does.
pub const LEASE_MS: i64 = 10 * 60 * 1000;

/// One page of the inbox, as the Worker writes it: its pending intents oldest first, and whether
/// more wait behind them. **Each intent is kept as JSON** and read by [`super::intents`] one at a
/// time, so one the device cannot read is that intent's refusal and never the whole page's.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Inbox {
    #[serde(default)]
    pub intents: Vec<serde_json::Value>,
    #[serde(default)]
    pub more: bool,
}

/// What a claim came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Claim {
    /// This device holds the intent until the lease runs out, and acks with `lease`.
    Held { lease: String },
    /// Another device holds a live lease on it: it is applying it now.
    Taken,
    /// Already acked — by another device, or by this one in a round whose ack came back late.
    Acked,
    /// Not in the inbox: purged, or the store itself is gone.
    Gone,
}

/// An ack, as sent — `POST …/intents/{id}/ack`'s body (plan §3.2). **Kept as written** in the
/// owed-ack row an apply writes in its own savepoint ([`super::intents`]), so an ack a crash
/// interrupted is sent the same on the next round.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ack {
    /// `applied` or `refused`.
    pub state: String,
    /// The refusal's sentence, shown by the integration. `None` on an apply.
    pub reason: Option<String>,
    /// The claim's lease: required on an apply, and sent on a refusal when this device held one.
    pub lease: Option<String>,
    /// This device's `sync_clock` after the apply's write — what the store keeps the add in its
    /// overlay until a published table reaches (plan §2). `None` on a refusal.
    pub hlc_ms: Option<i64>,
    pub hlc_ctr: Option<i64>,
}

/// What an ack came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Acked {
    /// The store holds the state this device sent — newly, or already.
    Done,
    /// Another device holds a live lease on the intent, and this device does not.
    Taken,
    /// The store already holds the other state: another device settled it first.
    Settled,
    /// Not in the inbox: purged, or the store itself is gone.
    Gone,
}

/// The status and code of a refusal, read once.
fn code_of(body: &str) -> Option<String> {
    Refusal::of(body).code
}

/// `GET /g/{group}/intents` — the pending intents, oldest first, or `None` when the group has no
/// store. **Pending only**: an acked intent is nothing a device has to do.
pub async fn pending_intents(db: &impl Store, door: &Door) -> Result<Option<Inbox>, String> {
    const OPERATION: &str = "integrations_intents";
    let url = door.url("/intents");
    let (status, body) = send(
        db,
        OPERATION,
        &url,
        http().get(&url).header("authorization", &door.bearer()),
    )
    .await?;
    if (200..300).contains(&status) {
        return parsed(db, OPERATION, &url, &body).map(Some);
    }
    if status == 404 && Refusal::of(&body).is(NO_STORE) {
        return Ok(None);
    }
    Err(refused(db, OPERATION, &url, status, &body, "a look at the inbox"))
}

/// `POST /g/{group}/intents/{id}/claim` — **hold an intent before applying it** (plan §2): two
/// devices that both read one pending add and both applied it would add the card twice. Only the
/// holder of a live lease may ack it applied.
pub async fn claim_intent(db: &impl Store, door: &Door, id: &str) -> Result<Claim, String> {
    const OPERATION: &str = "integrations_claim";
    let url = door.url(&format!("/intents/{id}/claim"));
    let (status, body) = send(
        db,
        OPERATION,
        &url,
        http().post(&url).header("authorization", &door.bearer()),
    )
    .await?;
    if (200..300).contains(&status) {
        #[derive(Deserialize)]
        struct Held {
            lease: String,
        }
        let held: Held = parsed(db, OPERATION, &url, &body)?;
        return Ok(Claim::Held { lease: held.lease });
    }
    Ok(match (status, code_of(&body).as_deref()) {
        (409, Some(CLAIMED)) => Claim::Taken,
        (409, Some(ALREADY_ACKED)) => Claim::Acked,
        (404, Some(NO_INTENT | NO_STORE)) => Claim::Gone,
        _ => return Err(refused(db, OPERATION, &url, status, &body, "a claim")),
    })
}

/// `POST /g/{group}/intents/{id}/ack` — the outcome, for the integration to show and every other
/// device to see. An ack repeating the state the store holds is [`Acked::Done`]: a round that
/// sends an owed ack the store already took is told it is done.
pub async fn ack_intent(db: &impl Store, door: &Door, id: &str, ack: &Ack) -> Result<Acked, String> {
    const OPERATION: &str = "integrations_ack";
    let url = door.url(&format!("/intents/{id}/ack"));
    let json = serde_json::to_string(ack).map_err(|e| e.to_string())?;
    let (status, body) = send(
        db,
        OPERATION,
        &url,
        http()
            .post(&url)
            .header("content-type", "application/json")
            .header("authorization", &door.bearer())
            .body(json),
    )
    .await?;
    if (200..300).contains(&status) {
        return Ok(Acked::Done);
    }
    Ok(match (status, code_of(&body).as_deref()) {
        (409, Some(CLAIMED)) => Acked::Taken,
        (409, Some(ALREADY_ACKED)) => Acked::Settled,
        (404, Some(NO_INTENT | NO_STORE)) => Acked::Gone,
        _ => return Err(refused(db, OPERATION, &url, status, &body, "an ack")),
    })
}

// ---------------------------------------------------------------------------------------
// Consumer tokens (plan §3.2) — no command or panel row calls these yet: PR 4 wires Discord's,
// PR 5 remote MCP's.
// ---------------------------------------------------------------------------------------

/// A token the store minted for one integration: the bearer its `/c/…` requests carry.
/// **`exp` is Unix seconds.** Shown once, to whatever hands it to the integration — the store
/// keeps only its id, and minting again for the same integration revokes this one.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Consumer {
    pub integration: String,
    pub token: String,
    pub scopes: Vec<String>,
    pub exp: i64,
}

/// One integration's live token, as `GET …/consumers` lists it — never the token itself.
/// `issued_at` is Unix milliseconds, `exp` Unix seconds, as the Worker writes them.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerInfo {
    pub integration: String,
    pub scopes: Vec<String>,
    pub issued_at: i64,
    pub exp: i64,
}

/// `POST /g/{group}/consumers/{integration}` — a token for `integration` (`discord` or `mcp`)
/// under `scopes`, good for `days` (1–365), replacing any it held. `None` when the group has no
/// store: a token is a key to the store, and there is nothing to open.
pub async fn mint_consumer(
    db: &impl Store,
    door: &Door,
    integration: &str,
    scopes: &[&str],
    days: i64,
) -> Result<Option<Consumer>, String> {
    const OPERATION: &str = "integrations_consumer";
    let url = door.url(&format!("/consumers/{integration}"));
    let body = serde_json::to_string(&serde_json::json!({ "scopes": scopes, "days": days }))
        .map_err(|e| e.to_string())?;
    let (status, text) = send(
        db,
        OPERATION,
        &url,
        http()
            .post(&url)
            .header("content-type", "application/json")
            .header("authorization", &door.bearer())
            .body(body),
    )
    .await?;
    if (200..300).contains(&status) {
        return parsed(db, OPERATION, &url, &text).map(Some);
    }
    if status == 404 && Refusal::of(&text).is(NO_STORE) {
        return Ok(None);
    }
    Err(refused(db, OPERATION, &url, status, &text, "a new integration token"))
}

/// `GET /g/{group}/consumers` — the integrations holding a live token, or `None` with no store.
pub async fn consumers(db: &impl Store, door: &Door) -> Result<Option<Vec<ConsumerInfo>>, String> {
    const OPERATION: &str = "integrations_consumers";
    #[derive(Deserialize)]
    struct Listed {
        #[serde(default)]
        consumers: Vec<ConsumerInfo>,
    }
    let url = door.url("/consumers");
    let (status, body) = send(
        db,
        OPERATION,
        &url,
        http().get(&url).header("authorization", &door.bearer()),
    )
    .await?;
    if (200..300).contains(&status) {
        return parsed::<Listed>(db, OPERATION, &url, &body).map(|l| Some(l.consumers));
    }
    if status == 404 && Refusal::of(&body).is(NO_STORE) {
        return Ok(None);
    }
    Err(refused(db, OPERATION, &url, status, &body, "a list of integration tokens"))
}

/// `DELETE /g/{group}/consumers/{integration}` — that integration's token revoked. **A 404 is
/// success**, [`delete_group`]'s rule: there is no token, which is what was asked.
pub async fn revoke_consumer(db: &impl Store, door: &Door, integration: &str) -> Result<(), String> {
    const OPERATION: &str = "integrations_revoke";
    let url = door.url(&format!("/consumers/{integration}"));
    let (status, body) = send(
        db,
        OPERATION,
        &url,
        http().delete(&url).header("authorization", &door.bearer()),
    )
    .await?;
    if status == 404 || (200..300).contains(&status) {
        return Ok(());
    }
    Err(refused(db, OPERATION, &url, status, &body, "a revoked integration token"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_db() -> Connection {
        crate::schema::memory_pair()
    }

    fn rows(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM error_log", [], |r| r.get(0))
            .unwrap()
    }

    /// **The placeholder is not an address**, and every build until the deploy refuses with the
    /// sentence and makes no request — the panel's "not in this build".
    #[test]
    fn the_compiled_in_base_is_a_placeholder_that_refuses_in_words() {
        let conn = open_db();
        assert!(
            !INTEGRATIONS_BASE.starts_with("http"),
            "{INTEGRATIONS_BASE}"
        );
        assert_eq!(base(&conn), INTEGRATIONS_BASE);
        assert_eq!(endpoint(&conn).unwrap_err(), NOT_DEPLOYED);
    }

    /// The override is a base, a blank one is not, and a trailing slash goes — and an override
    /// with no scheme is refused like the placeholder.
    #[test]
    fn the_base_takes_an_override_but_not_a_blank_one() {
        let conn = open_db();
        client::set_state(&conn, INTEGRATIONS_URL, "   ").unwrap();
        assert_eq!(base(&conn), INTEGRATIONS_BASE);
        client::set_state(&conn, INTEGRATIONS_URL, "http://127.0.0.1:8787/").unwrap();
        assert_eq!(endpoint(&conn).as_deref(), Ok("http://127.0.0.1:8787"));
        client::set_state(&conn, INTEGRATIONS_URL, "integrations.example").unwrap();
        assert_eq!(endpoint(&conn).unwrap_err(), NOT_DEPLOYED);
    }

    /// **The build before the device, and both before a token**: with nowhere to send, a device
    /// with nothing to send with still hears about the build; with somewhere, it hears about
    /// itself. Neither asks the relay, and neither writes a row — nothing went wrong.
    #[tokio::test]
    async fn the_door_refuses_the_build_first_and_the_device_second_and_records_neither() {
        let conn = open_db();
        assert_eq!(door(&conn, "x").await.unwrap_err(), NOT_DEPLOYED);
        client::set_state(&conn, INTEGRATIONS_URL, "http://127.0.0.1:1").unwrap();
        assert_eq!(door(&conn, "x").await.unwrap_err(), NOT_CONNECTED);
        assert_eq!(rows(&conn), 0);
    }

    /// A 401 is this side's sentence; anything else keeps the Worker's, or names the status.
    #[test]
    fn a_refusal_is_the_workers_sentence_but_a_401_is_ours() {
        assert_eq!(
            refusal(
                401,
                r#"{"error":"unauthorized","code":"unauthorized"}"#,
                "x"
            ),
            NOT_ACCEPTED
        );
        assert_eq!(
            refusal(
                413,
                r#"{"error":"that projection is 9 bytes gzipped","code":"projection_limit"}"#,
                "a publish"
            ),
            "that projection is 9 bytes gzipped"
        );
        let silent = refusal(500, "<html>", "a publish");
        assert!(
            silent.contains("500") && silent.contains("a publish"),
            "{silent}"
        );
    }

    /// **No sentence here names a membership** — the light app's Play build shows them as they
    /// stand, and only a `sync_` command's are reworded there.
    #[test]
    fn no_sentence_a_reader_is_shown_names_a_membership() {
        for sentence in [NOT_DEPLOYED, NOT_CONNECTED, UNCONFIRMED, NOT_ACCEPTED] {
            let said = sentence.to_lowercase();
            for word in ["patreon", "membership", "supporter", "pledge", "subscri"] {
                assert!(!said.contains(word), "{sentence}");
            }
        }
    }

    /// The digests answer as the Worker writes it — `publishedAt` in milliseconds, a table it was
    /// never sent absent.
    #[test]
    fn the_digests_answer_reads_as_the_worker_writes_it() {
        let read: Digests = serde_json::from_str(
            r#"{"fields":{"condition":true,"lang":false,"value":false,"tags":false,"notes":true},
                "marketplace":"cardmarket",
                "tables":{"decks":{"digest":"ab","hlcMs":5,"hlcCtr":1,"rows":2,"publishedAt":1790000000000}}}"#,
        )
        .unwrap();
        let fields = read.settings.fields;
        assert!(fields.condition && fields.notes && !fields.lang);
        assert_eq!(read.settings.marketplace.as_deref(), Some("cardmarket"));
        assert_eq!(read.tables["decks"].published_at, 1_790_000_000_000);
        assert!(!read.tables.contains_key("deck_cards"));
        // A Worker that predates the marketplace answers none, which a device reads as its own.
        let older: Settled = serde_json::from_str(
            r#"{"fields":{"condition":false,"lang":false,"value":false,"tags":false,"notes":false},
                "created":true}"#,
        )
        .unwrap();
        assert_eq!(older.settings.marketplace, None);
    }

    /// **A table over the Worker's inflated cap is refused here, with one row, and never sent** —
    /// the request it would have been is a request the mock counts.
    #[tokio::test]
    async fn a_table_over_the_workers_cap_is_refused_before_it_is_sent() {
        use super::super::projection::{CollectionFolderRow, Rows};
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        let put = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::PUT);
                then.status(200).body("{}");
            })
            .await;
        let folders = (0..110_000)
            .map(|n| CollectionFolderRow {
                id: n,
                uid: format!("{n:032x}"),
                name: format!("{n:0200}"),
                parent_uid: None,
                kind: "user".to_owned(),
                locked: false,
            })
            .collect();
        let doc = TableDoc {
            v: 1,
            table: "collection_folders",
            fields: Vec::new(),
            marketplace: "tcgplayer",
            currency: "USD",
            rows: Rows::CollectionFolders(folders),
        };
        let door = Door {
            base: server.base_url(),
            token: "bearer".to_owned(),
            group: "g1".to_owned(),
        };
        let answered = put_table(&conn, &door, &doc, &"0".repeat(64), Watermark::default())
            .await
            .unwrap();
        let Put::Refused(said) = answered else {
            panic!("{answered:?}");
        };
        assert!(said.contains("collection_folders"), "{said}");
        assert_eq!(put.calls_async().await, 0, "nothing was sent");
        assert_eq!(rows(&conn), 1);
        assert_eq!(
            over_a_cap("t", MAX_GZIP_BYTES, MAX_GZIP_BYTES, "gzipped"),
            None
        );
        assert!(over_a_cap("t", MAX_GZIP_BYTES + 1, MAX_GZIP_BYTES, "gzipped").is_some());
    }

    /// ⚠️ **The two caps are `body.ts`'s numbers in a second language**, multiplied out of that
    /// file — `share::publish`'s `the_blob_cap_is_the_workers_own`, for its reason: a Worker raised
    /// to more would see tables this side never sends, and one lowered would refuse what this side
    /// thinks fits.
    #[test]
    fn the_caps_are_the_workers_own() {
        let body = include_str!("../../../../infrastructure/integrations-worker/src/body.ts");
        let read = |name: &str| -> usize {
            let marker = format!("export const {name} =");
            let at = body
                .find(&marker)
                .unwrap_or_else(|| panic!("body.ts has no {name}"));
            let rest = &body[at + marker.len()..];
            let expression = &rest[..rest.find(';').expect("no `;`")];
            expression
                .split('*')
                .map(|f| {
                    f.trim()
                        .replace('_', "")
                        .parse::<usize>()
                        .expect(expression)
                })
                .product()
        };
        assert_eq!(MAX_GZIP_BYTES, read("MAX_GZIP_BYTES"));
        assert_eq!(MAX_INFLATED_BYTES, read("MAX_INFLATED_BYTES"));
    }

    /// The watermark is the clock's row, and a database without one is the floor.
    #[test]
    fn the_watermark_is_the_sync_clock() {
        let conn = open_db();
        conn.execute("UPDATE sync_clock SET ms = 42, ctr = 7 WHERE id = 1", [])
            .unwrap();
        assert_eq!(watermark(&conn).unwrap(), Watermark { ms: 42, ctr: 7 });
        conn.execute("DELETE FROM sync_clock", []).unwrap();
        assert_eq!(watermark(&conn).unwrap(), Watermark::default());
    }

    /// ⚠️ **The three headers and the refusal codes are the Worker's own**, read from its source:
    /// a header spelled differently here is a 400 `bad_projection` on every publish, and a code
    /// spelled differently is a state read as a failure.
    #[test]
    fn the_headers_and_codes_are_the_workers_own() {
        let cors = include_str!("../../../../infrastructure/integrations-worker/src/cors.ts");
        for (name, value) in [
            ("HLC_MS_HEADER", HLC_MS_HEADER),
            ("HLC_CTR_HEADER", HLC_CTR_HEADER),
            ("DIGEST_HEADER", DIGEST_HEADER),
        ] {
            assert!(
                cors.contains(&format!("export const {name} = \"{value}\";")),
                "{name}"
            );
        }
        let store = include_str!("../../../../infrastructure/integrations-worker/src/store.ts");
        for (name, value) in [
            ("NO_STORE", NO_STORE),
            ("STALE_PROJECTION", STALE_PROJECTION),
            ("SETTINGS_MISMATCH", SETTINGS_MISMATCH),
        ] {
            assert!(
                store.contains(&format!("export const {name} = \"{value}\";")),
                "{name}"
            );
        }
    }
}
