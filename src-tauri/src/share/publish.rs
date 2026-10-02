//! The upload: the two-step that makes a failed publish harmless, and the four requests behind
//! the five commands — plus the viewer's two `GET`s, which are a different kind of request and
//! keep different rules (see [`open`]).
//!
//! # The order, and why it is the whole of the transactional safety
//!
//! ```text
//! read the snapshot → POST the metadata → PUT the gzip → only now write `collection_shares`
//! ```
//!
//! The relay's row does not point at the new blob until the blob has landed, and this side does
//! not point at the *share* until the relay has said it did. A publish that dies halfway leaves
//! the **previous** snapshot serving — which is the same commit-last shape
//! [`crate::sync_engine::client::post_rotation`] uses and the same reason: a half-published
//! share is a broken link in somebody's Discord, and the old one is never worse than that.
//! [`commit_publish`] is that rule as a function, so a test can drive it with a failure and
//! watch the cached row stay where it was.
//!
//! ⚠️ **What the two-step buys is the blob, the link and the cached row — and not the header
//! above them.** `handleCreate` UPDATEs `title`, `owner_name`, `card_count`, `total_value` and
//! `fields` on the existing row *before* the `PUT`, and `page.ts` draws its heading and its card
//! count from that row. So a **republish** that dies between the two steps goes on serving the
//! previous snapshot under a header describing the new one — 412 cards promised, 400 delivered,
//! until the next successful publish. That is a strictly smaller failure than a dead link and is
//! the trade the shape was chosen for; it is written down here because the paragraph above it
//! reads like a stronger promise than it is.
//!
//! ⚠️ **The snapshot is read first even though the id comes second**, which reverses the order
//! the plan wrote. Two things force it: the metadata the `POST` carries includes `cardCount`,
//! which is a fact about the read; and the three refusals a locked or non-user folder earns
//! ([`super::FOLDER_IS_LOCKED`] and its neighbours) belong *before* any request, or a folder the
//! app is about to refuse would have left a row on the relay. [`super::snapshot`] takes the id
//! as an argument precisely because it is the relay's to mint, so the document is built with an
//! empty one and stamped when the answer comes back.
//!
//! # The five conventions, taken from `sync_engine::client`
//!
//! [`http`] and never a fresh client; the URL from a `format!` over [`base`]; **the body written
//! by hand** (`serde_json::to_string` plus an explicit `content-type`) because this crate does
//! not enable reqwest's `json` feature; the bearer as
//! `.header("authorization", format!("Bearer {token}"))`; and every failure becoming an
//! `Err(String)` *and* an `error_log` row first.
//!
//! # The viewer keeps none of the first and not the last, and both are the fix (issue #545)
//!
//! **The four requests above talk to the reader's own share Worker; [`open`] talks to whatever
//! host a stranger's link names**, and conventions that are right for the first are each a hole
//! in the second. It ran on the write connection so a failure could be logged, which let a host
//! trickling one byte a minute hold the app's only writer for as long as it liked — every other
//! press answered `BUSY`. It read its bodies whole, so a small gzip that inflates to gigabytes
//! aborted the process on allocation. And it followed any `http(s)` URL the fetched page named,
//! which made the app a `GET` proxy past the webview's CSP `connect-src`. So since 2026-09-28 the
//! viewer takes **no connection** (its signature has none to take), answers a [`Refused`] whose
//! `error_log` row the command writes *afterwards*, builds **its own client per open** with a
//! same-origin redirect policy, reads every body under a cap that is counted as it arrives, and
//! runs inside one wall clock. [`Limits`] is every one of those numbers in one place.

use super::cache;
use super::commands::ShareRow;
use super::{gzip, snapshot, ShareFields};
use crate::errors::{self, Kind, Source};
use crate::sync_engine::{client, entitlement};
use crate::sync_pair::identity::{self, Group};
use grimoire_core::state::Store;
use reqwest::Url;
use rusqlite::Connection;
use serde::Deserialize;
use std::time::Duration;

/// The share Worker's address.
///
/// **Real since the Worker's first deploy on 2026-10-01** — `mtg-grimoire-share` is its name in
/// `share-worker/wrangler.jsonc` and `denmark-east` is the account's subdomain, read back from
/// the deploy and probed rather than guessed. Until that day it was the placeholder
/// `<set on first deploy>`, deliberately a string that could not be mistaken for an address: a
/// guessed host gets copied into documentation and deployed against, which is what the
/// `database_id` comment in the relay's config records happening.
///
/// ⚠️ **It must equal `share-worker/wrangler.jsonc`'s `SHARE_BASE` var byte for byte** — the
/// trap `relay/wrangler.jsonc` documents for `RELAY_BASE` and the OAuth redirect URI. The two
/// are one value in two languages: the Worker builds every link from its copy and this side
/// sends every request to its own, so a mismatch is a link that resolves to nothing rather than
/// an error anybody sees. `the_share_base_is_the_workers_own` reads that file and compares.
///
/// [`entitlement::RELAY_BASE`] is the sibling of this constant. Both are public on the same
/// terms — an API base is on the wire of every request that uses it and ships inside the binary
/// whatever this tree says. Spec §14 open item 5.
pub const SHARE_BASE: &str = "https://mtg-grimoire-share.denmark-east.workers.dev";

/// The `sync_state` key holding an override for [`SHARE_BASE`] — a test/dev knob with no UI,
/// exactly as [`client::RELAY_URL`] is for the relay.
///
/// **It was the only way to exercise this file before the first deploy**, when [`SHARE_BASE`]
/// was a string that is not a URL, and it is what points a dev build at `wrangler dev --local`
/// or a fork's own Worker now.
pub const SHARE_URL: &str = "share_url";

/// The share Worker's base URL: the override if there is one, [`SHARE_BASE`] otherwise.
///
/// **A blank is not an override**, [`entitlement::base`]'s rule and for its reason: a blank is
/// the shape an emptied row takes, and reading it as a base would build the relative URL `/g/…`
/// and fail with a message about nothing the reader did. Trailing slashes go because every
/// caller appends its own path.
///
/// It answers whatever it was given and judges nothing; [`endpoint`] is the judgement.
pub fn base(conn: &Connection) -> String {
    let stored = client::get_state(conn, SHARE_URL).unwrap_or_default();
    let trimmed = stored.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        SHARE_BASE.to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// The base to send to, or the sentence that says there is nowhere to send.
///
/// ⚠️ **A base with no scheme is not a URL.** [`base`]'s own doc already refuses this shape for
/// a *blank* override — "reading it as a base would build the relative URL `/g/…` and fail with
/// a message about nothing the reader did" — and until 2026-10-01 [`SHARE_BASE`] itself was
/// such a string, `<set on first deploy>`, while being the **default**. Without this guard a
/// connected reader pressing *Share* met `builder error: relative URL without a base`, which is
/// reqwest's sentence about a mistake nobody made, and every list press folded an `error_log`
/// row under `Source::Relay` for it. What reaches the refusal today is a mistyped override.
///
/// **The test is the scheme rather than an equality against the constant**, and the difference
/// was the day of the deploy: `base == SHARE_BASE` would have refused every request the moment
/// that constant became a real host, because no override is the ordinary case.
fn endpoint(conn: &Connection) -> Result<String, String> {
    let base = base(conn);
    if base.starts_with("https://") || base.starts_with("http://") {
        return Ok(base);
    }
    Err(NOT_DEPLOYED.to_owned())
}

// ---------------------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------------------

/// The machine-readable half of the share Worker's cap refusal — `403 { error, code }`.
///
/// **Matched on the code and never on `error`**, which is copy and is free to be improved:
/// `entitlement`'s `device_limit` carries the same warning, and 403 already means other things.
const SHARE_LIMIT: &str = "share_limit";

/// The same for the blob cap — `413 { error, code }`.
const BLOB_LIMIT: &str = "blob_limit";

/// The effective base names no host, so there is nowhere to publish to — every build's answer
/// while [`SHARE_BASE`] was a placeholder, and since 2026-10-01 the answer to an override that
/// carries no scheme. **Refused before any request and before any `error_log` row**, because a
/// build with no address for the service is a state rather than a failure — nothing went wrong,
/// and a row in the Errors panel would send the reader to look at a network that is fine.
pub const NOT_DEPLOYED: &str = "Sharing a collection is not available in this build yet - \
                                the service it publishes to has no address here.";

/// No membership is connected anywhere in this group, so there is no token to mint and no
/// request to make. **A sentence and not a 401 dressed up**: nothing has been refused, because
/// nothing was asked.
pub const NOT_CONNECTED: &str = "Sharing a collection needs a supporter membership. Connect \
                                 Patreon in Settings - any device in your group will do.";

/// The gate refused a token this app had just minted, which is what a membership ending between
/// the mint and the request looks like.
///
/// ⚠️ **Nothing is revoked here, and copying [`client`]'s `lapsed` would be the mistake.** That
/// function exists because a 401 on push, pull or ack leaves nothing to try; here the token came
/// back from `/token` moments ago, so the authority on whether the membership has ended is the
/// next sync, not a share upload. Taking the grant away over this would tell a reader their
/// membership ended because a binder failed to publish.
pub const MEMBERSHIP_REFUSED: &str = "The share service would not accept this device's \
                                      membership. Check the Patreon connection in Settings.";

/// The publish dialog's own field, refused here rather than as a 400 from the relay: it is the
/// name that goes above the binder on a public page, and "a share needs an owner's name" arriving
/// from a Worker is a sentence about a request rather than about the box the reader left empty.
pub const OWNER_NAME_REQUIRED: &str = "That share needs a name to publish it under.";

/// A share id this device has never cached. Refresh and Revoke both address one.
pub const UNKNOWN_SHARE: &str = "That shared collection is not one this device knows about. \
                                 Open the share list to load it, then try again.";

/// What a pasted link that is not a link earns, before any request is made.
pub const NOT_A_LINK: &str = "That is not a shared collection link.";

/// The link resolves and the share is gone — withdrawn by its owner, or darkened when their
/// membership ended.
///
/// **One sentence for what the page tells a viewer as two**, and the reason is that this side
/// cannot tell them apart: `GET /s/{id}` answers 410 with the difference in the *rendered HTML*,
/// not in a code, so an app that claimed to know which had happened would be reading prose.
pub const SHARE_IS_GONE: &str = "That shared collection is no longer available.";

/// A link nobody minted — the shape of a mistyped or truncated paste.
pub const NO_SUCH_SHARE: &str = "That link does not point at a shared collection.";

/// Metadata posted, blob never uploaded: what a publish that died between its two steps leaves
/// behind. It resolves within seconds of the owner trying again, which is why this says *yet*.
pub const SHARE_NOT_READY: &str = "That shared collection has not finished publishing yet.";

/// A page, a snapshot or a snapshot's inflated text passed its cap in [`Limits`].
///
/// **One sentence for all three, because to a reader they are one fact**: nothing the share
/// Worker writes is that large — it refuses a snapshot over [`MAX_BLOB_BYTES`] at upload — so a
/// link that serves more is not a share, whichever of the three noticed. The `error_log` row
/// says which cap, and the byte figure; the reader is owed neither.
pub const SHARE_TOO_LARGE: &str =
    "That shared collection is larger than a share can be, so it was not opened.";

/// The whole open outlasted [`OPEN_TIMEOUT`].
///
/// **The one refusal here worth trying again**, and it says so: every other sentence in this
/// file is terminal, while a slow network on one afternoon is not.
pub const OPEN_TIMED_OUT: &str =
    "That shared collection took too long to arrive. Check the connection and try again.";

/// The page named its snapshot on another origin, or a redirect tried to leave the page's.
///
/// **Its own sentence rather than [`NOT_A_LINK`]**, because the link passed every shape check
/// there is — the paste box's and [`open`]'s — and telling the reader it is not a link would be
/// a sentence about the wrong half. What was refused is where the page tried to send the app.
pub const SNAPSHOT_ELSEWHERE: &str =
    "That link sends the app to another site for its collection, so it was not opened.";

/// What the share Worker answers a refusal with. `Default` so an unparseable body still lands on
/// a sentence rather than on a `?`.
#[derive(Debug, Default, Deserialize)]
struct Refusal {
    #[serde(default)]
    error: String,
    #[serde(default)]
    code: Option<String>,
}

/// Turn one refusal into the sentence the reader sees.
///
/// **Pure, and that is what makes it the tested half of this file.** Everything else here is a
/// socket; this is the decision.
///
/// The two caps keep the relay's own `error`, because the number is *in* it — *"that snapshot is
/// 9 431 204 bytes and a share may be at most 8 388 608"* is the difference between a refusal a
/// reader can act on and "too big". The code is what selects that branch, so a 403 that is
/// **not** the cap never inherits the cap's sentence: `entitlement`'s `device_limit` carries the
/// same argument, and it is the one that was learned the hard way.
pub fn refusal(status: u16, body: &str, what: &str) -> String {
    let parsed: Refusal = serde_json::from_str(body).unwrap_or_default();
    let relay = parsed.error.trim();
    let spoken = (!relay.is_empty()).then(|| relay.to_owned());
    match (status, parsed.code.as_deref()) {
        (403, Some(SHARE_LIMIT)) => spoken.unwrap_or_else(|| {
            "That group has already shared as many collections as the service allows. \
             Withdraw one before sharing another."
                .to_owned()
        }),
        (413, Some(BLOB_LIMIT)) => spoken.unwrap_or_else(|| {
            "That snapshot is larger than a share may be. Share a folder rather than the whole \
             collection, or leave out the optional fields."
                .to_owned()
        }),
        (401, _) => MEMBERSHIP_REFUSED.to_owned(),
        _ => spoken.unwrap_or_else(|| format!("the share service answered {status} to {what}")),
    }
}

// ---------------------------------------------------------------------------------------
// The socket
// ---------------------------------------------------------------------------------------

/// The HTTP client.
///
/// **Its own, and neither Scryfall's nor the relay's.** The share Worker is a third host: it
/// must not spend Scryfall's pacing budget and must not join its 429 lockout, which is the rule
/// `marketplace_feed`, `combos` and [`client`] already follow. Memoised for the life of the
/// process, [`client::post_ops`]' shape — that file's `cfg(test)` arm exists for an `httpmock`
/// suite, and the one this file grew on 2026-09-28 drives only the viewer, whose client is
/// [`viewer_client`] and built per open, so there is still nothing here for a per-test client to
/// fix. **The viewer must never borrow this one**: it follows reqwest's default redirects to any
/// host, which is exactly the proxy [`open`] exists to refuse.
fn http() -> reqwest::Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .user_agent(crate::scryfall::USER_AGENT)
                .connect_timeout(std::time::Duration::from_secs(10))
                // Longer than the relay's 30 s, because this is the one request in the app that
                // can carry eight megabytes: the read timeout is per chunk, but a snapshot
                // uploaded over a slow uplink spends the whole of it waiting for the far side's
                // first byte after the body has gone.
                .read_timeout(std::time::Duration::from_secs(60))
                .build()
                .unwrap_or_default()
        })
        .clone()
}

/// Classify a transport failure, so every call site here agrees about what it was.
/// [`client`]'s `kind_of`, which is private to that module.
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

/// One `error_log` row.
///
/// **`Source::Relay` rather than a source of its own**, and the reason is the reader's rather
/// than the code's: the Errors panel groups by source, and a failure to publish a binder is a
/// failure to reach a Cloudflare Worker over the same network and the same membership as sync.
/// The `operation` is what separates them, which is the split [`client`] already makes between
/// `push`, `pull`, `ack`, `keys` and `rotate`.
fn note(conn: &Connection, operation: &str, kind: Kind, message: &str, url: Option<&str>) {
    errors::record(conn, Source::Relay, operation, kind, message, url);
}

/// The clock, read from SQLite so every row this file writes agrees with `unixepoch()` in the
/// rest of the crate rather than with this process's own idea of the time.
fn now(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT unixepoch()", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// The bearer token and the group whose path it is good for, or the sentence that says why there
/// is neither.
///
/// **`None` from [`entitlement::access_token`] is "not connected" and is not an error there** —
/// it is where every installation that has connected nothing stands. It becomes one here,
/// because a publish that was asked for cannot silently not happen.
///
/// **`tokens` is the store the token is asked through, and it is not `conn`'s type by accident.**
/// A token is the sync client's to mint and it mints under the lane; this module still holds the
/// connection for a whole publish, so its caller takes the lane first and hands the connection it
/// holds back in as a store (`Lane::in_hand`).
async fn credentials(conn: &Connection, tokens: &impl Store) -> Result<(String, Group), String> {
    let Some(token) = entitlement::access_token(tokens).await? else {
        return Err(NOT_CONNECTED.to_owned());
    };
    // The gate compares the token's `grp` claim against the path, so a token with no group to
    // put in the path is a request that could only ever be refused.
    let Some(group) = identity::group(conn).map_err(|e| e.to_string())? else {
        return Err(NOT_CONNECTED.to_owned());
    };
    Ok((token, group))
}

/// The status and body of one gated request, or an `Err` that has already been recorded.
async fn send(
    conn: &Connection,
    operation: &str,
    url: &str,
    request: reqwest::RequestBuilder,
) -> Result<(u16, String), String> {
    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            note(conn, operation, kind_of(&e), &e.to_string(), Some(url));
            return Err(e.to_string());
        }
    };
    let status = response.status().as_u16();
    match response.text().await {
        Ok(body) => Ok((status, body)),
        Err(e) => {
            note(conn, operation, kind_of(&e), &e.to_string(), Some(url));
            Err(e.to_string())
        }
    }
}

// ---------------------------------------------------------------------------------------
// What the Worker answers
// ---------------------------------------------------------------------------------------

/// `POST /g/{group}/share` — **`url` as well as `id`**, and the link is taken from here rather
/// than rebuilt from [`SHARE_BASE`]: the Worker builds it from its own binding, and one string
/// built twice is one string that can disagree with itself.
#[derive(Debug, Deserialize)]
struct Created {
    id: String,
    url: String,
}

/// `PUT /g/{group}/share/{id}`. The hash names the immutable object and the shell inlines it, so
/// nothing here has to hold on to it — it is read to prove the answer was the answer.
#[derive(Debug, Deserialize)]
struct Uploaded {
    #[allow(dead_code)]
    hash: String,
}

/// One row of `GET /g/{group}/shares`.
///
/// **Only the nine fields [`ShareRow`] carries.** The Worker also answers `cardCount`,
/// `totalValue`, `currency`, `marketplace`, `bytes` and `createdAt`; caching those would be a
/// second record of numbers the relay recomputes on every publish, and the cache's whole job is
/// a badge and a link that survive being offline.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Listed {
    id: String,
    url: String,
    folder_uid: Option<String>,
    title: String,
    owner_name: String,
    fields: Vec<String>,
    state: String,
    updated_at: i64,
}

/// The list itself. **An object with a `shares` key and not a bare array**, which is what the
/// Worker answers.
#[derive(Debug, Deserialize)]
struct Listing {
    shares: Vec<Listed>,
}

impl From<Listed> for ShareRow {
    fn from(row: Listed) -> ShareRow {
        ShareRow {
            id: row.id,
            folder_uid: row.folder_uid,
            title: row.title,
            owner_name: row.owner_name,
            url: row.url,
            fields: row.fields,
            state: row.state,
            // The relay knows nothing about when *this* device last uploaded, and
            // `cache::reconcile` is where the local answer is kept.
            published: None,
            updated_at: row.updated_at,
        }
    }
}

// ---------------------------------------------------------------------------------------
// The four requests
// ---------------------------------------------------------------------------------------

/// Step 1: the metadata, and the id and link that come back.
async fn post_meta(
    conn: &Connection,
    token: &str,
    group: &Group,
    body: String,
) -> Result<Created, String> {
    let url = format!("{}/g/{}/share", endpoint(conn)?, group.group_id);
    let (status, text) = send(
        conn,
        "share_create",
        &url,
        http()
            .post(&url)
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {token}"))
            .body(body),
    )
    .await?;
    if !(200..300).contains(&status) {
        let message = refusal(status, &text, "a publish");
        note(conn, "share_create", Kind::Http, &message, Some(&url));
        return Err(message);
    }
    serde_json::from_str(&text).map_err(|e| {
        note(
            conn,
            "share_create",
            Kind::Parse,
            &e.to_string(),
            Some(&url),
        );
        e.to_string()
    })
}

/// Step 3: the gzip.
async fn put_blob(
    conn: &Connection,
    token: &str,
    group: &Group,
    id: &str,
    bytes: Vec<u8>,
) -> Result<Uploaded, String> {
    let url = format!("{}/g/{}/share/{id}", endpoint(conn)?, group.group_id);
    let (status, text) = send(
        conn,
        "share_upload",
        &url,
        http()
            .put(&url)
            // **`application/gzip` and not `content-encoding: gzip`.** The bytes *are* the
            // document as far as this request is concerned; declaring an encoding would invite
            // an intermediary to helpfully decode it, and the Worker checks the two magic bytes.
            .header("content-type", "application/gzip")
            .header("authorization", format!("Bearer {token}"))
            .body(bytes),
    )
    .await?;
    if !(200..300).contains(&status) {
        let message = refusal(status, &text, "an upload");
        note(conn, "share_upload", Kind::Http, &message, Some(&url));
        return Err(message);
    }
    serde_json::from_str(&text).map_err(|e| {
        note(
            conn,
            "share_upload",
            Kind::Parse,
            &e.to_string(),
            Some(&url),
        );
        e.to_string()
    })
}

/// `GET /g/{group}/shares` — the roster, as [`ShareRow`]s ready for [`cache::reconcile`].
async fn get_shares(
    conn: &Connection,
    token: &str,
    group: &Group,
) -> Result<Vec<ShareRow>, String> {
    let url = format!("{}/g/{}/shares", endpoint(conn)?, group.group_id);
    let (status, text) = send(
        conn,
        "share_list",
        &url,
        http()
            .get(&url)
            .header("authorization", format!("Bearer {token}")),
    )
    .await?;
    if !(200..300).contains(&status) {
        let message = refusal(status, &text, "a share list");
        note(conn, "share_list", Kind::Http, &message, Some(&url));
        return Err(message);
    }
    let listing: Listing = serde_json::from_str(&text).map_err(|e| {
        note(conn, "share_list", Kind::Parse, &e.to_string(), Some(&url));
        e.to_string()
    })?;
    Ok(listing.shares.into_iter().map(ShareRow::from).collect())
}

/// `DELETE /g/{group}/share/{id}`.
///
/// **A 404 is success**, and that is not laxity: the Worker answers it for a share this group
/// does not have, which is the state the press asked for. Refusing would leave a row in this
/// cache that no relay will ever confirm and no press can ever remove.
async fn delete_share(
    conn: &Connection,
    token: &str,
    group: &Group,
    id: &str,
) -> Result<(), String> {
    let url = format!("{}/g/{}/share/{id}", endpoint(conn)?, group.group_id);
    let (status, text) = send(
        conn,
        "share_revoke",
        &url,
        http()
            .delete(&url)
            .header("authorization", format!("Bearer {token}")),
    )
    .await?;
    if status == 404 || (200..300).contains(&status) {
        return Ok(());
    }
    let message = refusal(status, &text, "a withdrawal");
    note(conn, "share_revoke", Kind::Http, &message, Some(&url));
    Err(message)
}

// ---------------------------------------------------------------------------------------
// The publish
// ---------------------------------------------------------------------------------------

/// The metadata body, built from the document that is about to be uploaded.
///
/// `cardCount` is the copies rather than the rows, which is what the page prints; `totalValue`
/// is `None` unless `value` crossed **and** at least one card carried a price, because a `0.0`
/// on a binder no feed quotes is the page claiming it is worth nothing.
fn meta_body(
    folder_uid: Option<&str>,
    owner_name: &str,
    snap: &super::ShareSnapshot,
) -> Result<String, String> {
    let card_count: i64 = snap.cards.iter().map(|c| c.q).sum();
    let priced: Vec<f64> = snap
        .cards
        .iter()
        .filter_map(|c| c.p.map(|p| p * c.q as f64))
        .collect();
    let total_value = (!priced.is_empty()).then(|| priced.iter().sum::<f64>());
    serde_json::to_string(&serde_json::json!({
        "folderUid": folder_uid,
        "title": snap.title,
        "ownerName": owner_name,
        "cardCount": card_count,
        "totalValue": total_value,
        "currency": snap.currency,
        "marketplace": snap.marketplace,
        "fields": snap.fields,
    }))
    .map_err(|e| e.to_string())
}

/// Step 4, and **only** step 4: write the cache row, if and only if the upload landed.
///
/// **The `?` on the first line is the transactional safety, spelled as one character.** A
/// publish that dies in the `PUT` leaves the previous snapshot serving on the relay and the
/// previous row — its `published` stamp and its `state` — untouched here, which is what spec
/// §10 promises for an upload that dies mid-flight.
///
/// Taking the network's answer as an argument rather than making the request is what lets a test
/// drive the failure without an HTTP mock, which is the shape the whole of this module's testing
/// rests on.
pub fn commit_publish(
    conn: &Connection,
    row: &ShareRow,
    uploaded: Result<(), String>,
) -> Result<ShareRow, String> {
    uploaded?;
    cache::store(conn, row)?;
    Ok(row.clone())
}

/// Publish a folder — or the whole collection, for `None` — and answer the row the page draws.
///
/// The order is this module's header, and the one thing worth restating here is that the
/// snapshot is read **before** the first request: the three refusals a locked, missing or
/// app-owned folder earns are [`super::snapshot`]'s, and a folder about to be refused must never
/// have left a row on the relay.
pub async fn publish(
    conn: &Connection,
    tokens: &impl Store,
    folder_uid: Option<&str>,
    owner_name: &str,
    fields: ShareFields,
) -> Result<ShareRow, String> {
    let owner_name = owner_name.trim();
    if owner_name.is_empty() {
        return Err(OWNER_NAME_REQUIRED.to_owned());
    }
    let at = now(conn)?;
    let marketplace = crate::sorting::Marketplace::from_id(&crate::marketplace::stored(conn));
    // The id is stamped in once the relay has minted it — see the module header for why the
    // read cannot wait for it.
    let mut snap = snapshot(conn, "", owner_name, folder_uid, fields, marketplace, at)?;

    // **Below the read and above the token, and both halves of that placement are decisions.**
    // Below, because a refusal about *this folder* — locked, missing, not the reader's — is
    // the
    // more actionable of the two, and the read that produces it is local and free. Above,
    // because
    // `credentials` posts to the relay's `/token`, and minting a grant for a press that has
    // nowhere to send it is a round trip spent on nothing.
    endpoint(conn)?;
    let (token, group) = credentials(conn, tokens).await?;
    let created = post_meta(
        conn,
        &token,
        &group,
        meta_body(folder_uid, owner_name, &snap)?,
    )
    .await?;

    snap.id = created.id.clone();
    let json = serde_json::to_vec(&snap).map_err(|e| e.to_string())?;
    let uploaded = put_blob(conn, &token, &group, &created.id, gzip(&json)?)
        .await
        .map(|_| ());

    commit_publish(
        conn,
        &ShareRow {
            id: created.id,
            folder_uid: folder_uid.map(str::to_owned),
            title: snap.title,
            owner_name: owner_name.to_owned(),
            url: created.url,
            fields: snap.fields.iter().map(|f| (*f).to_owned()).collect(),
            // **`live` and never anything else from here.** A membership that has lapsed is the
            // daily pass's judgement (spec §6) and arrives on the next list; a publish that the
            // gate let through has no business writing that state itself.
            state: "live".to_owned(),
            published: Some(at),
            updated_at: at,
        },
        uploaded,
    )
}

/// The inverse of `ShareFields::names()`, which is private to [`super::snapshot`] and writes the
/// array `collection_shares.fields` stores.
///
/// ⚠️ **Two spellings of one vocabulary, in two modules, with nothing but a test between them.**
/// Drift is silent and costs a republish exactly the switch that moved: a `value` this stopped
/// recognising republishes a binder with its prices stripped, and no build goes red.
/// `a_field_set_survives_the_round_trip_through_the_wire_names` runs every one of the eight
/// combinations through the real writer and back through here.
fn fields_from_names(names: &[String]) -> ShareFields {
    ShareFields {
        condition: names.iter().any(|f| f == "condition"),
        lang: names.iter().any(|f| f == "lang"),
        value: names.iter().any(|f| f == "value"),
    }
}

/// Republish one share this device already knows about, under the name and fields it carries.
pub async fn refresh(conn: &Connection, tokens: &impl Store, id: &str) -> Result<ShareRow, String> {
    let Some(known) = cache::get(conn, id)? else {
        return Err(UNKNOWN_SHARE.to_owned());
    };
    let fields = fields_from_names(&known.fields);
    publish(
        conn,
        tokens,
        known.folder_uid.as_deref(),
        &known.owner_name,
        fields,
    )
    .await
}

/// Withdraw one share. Terminal, and the reader's own press.
///
/// **The local row moves only after the relay has taken it**, which is [`commit_publish`]'s rule
/// applied to the other direction: a withdrawal this device believes in and the relay does not
/// is a link the reader thinks is dead.
pub async fn revoke(conn: &Connection, tokens: &impl Store, id: &str) -> Result<(), String> {
    endpoint(conn)?;
    let (token, group) = credentials(conn, tokens).await?;
    delete_share(conn, &token, &group, id).await?;
    // The row survives its own revocation until the next reconcile drops it, so the page can
    // say *withdrawn* rather than having the folder's badge vanish with no explanation.
    cache::mark_state(conn, id, "revoked", now(conn)?)
}

/// Every share the group has published, with the cache brought into line first.
///
/// ⚠️ **This is the one `share_*` read that reaches the network, and it has to.** Spec §4.3 has
/// the *second* device in a group inherit the owner's name from `GET /g/{group}/shares` rather
/// than asking the reader to type it again — and a device that has never published has nothing
/// in its cache to inherit from. Every other command needs an id or a name it does not have, so
/// there is no other press that could ever fill it.
///
/// **Best effort, and the cache is the answer either way.** A device with no membership makes no
/// request at all; a device whose request fails answers what it last heard, which is the whole
/// point of the table being a cache. Only the *reconcile* is optional — the list never is.
pub async fn list(conn: &Connection, tokens: &impl Store) -> Result<Vec<ShareRow>, String> {
    // **Asked before the token and never as a refusal.** `endpoint` is the only thing here that
    // can say "there is nowhere to ask", and on a build with no host that has to stop the
    // `/token` round trip `access_token` would otherwise make on every press of this list.
    if endpoint(conn).is_ok() {
        // Not [`credentials`], because an unconnected device must not read this as a refusal: it
        // has a perfectly good empty list, and `NOT_CONNECTED` belongs on a press to publish.
        let token = entitlement::access_token(tokens).await.ok().flatten();
        let group = identity::group(conn).ok().flatten();
        if let (Some(token), Some(group)) = (token, group) {
            if let Ok(remote) = get_shares(conn, &token, &group).await {
                // ⚠️ **A reconcile that will not commit falls through to the cache like a
                // request that did not answer.** Returning its `Err` here would make one busy
                // database a *failed share list* on a device that is holding a perfectly good
                // one, which is the opposite of what the paragraph above promises.
                if let Ok(rows) = cache::reconcile(conn, &remote) {
                    return Ok(rows);
                }
            }
        }
    }
    cache::list(conn)
}

// ---------------------------------------------------------------------------------------
// What one open may spend
// ---------------------------------------------------------------------------------------

/// The share Worker's cap on one snapshot's gzip — `share-worker/src/env.ts`'s `MAX_BLOB_BYTES`,
/// the same number in a second language.
///
/// **The viewer holds a snapshot to the number the Worker refused it at**, because nothing larger
/// can have come from a share: `blob.ts` answers 413 above it, on the declared length and on the
/// bytes it counted. A larger body is a host that is not the Worker, and reading it whole would
/// be reading on that host's terms. `the_blob_cap_is_the_workers_own` reads `env.ts` and
/// multiplies its expression out, so a change to either side goes red until both move.
pub const MAX_BLOB_BYTES: usize = 8 * 1024 * 1024;

/// The page a link names — the Worker's shell, or anything else answering at that address.
///
/// **A quarter of a megabyte against a shell of a few kilobytes.** `page.ts` renders one
/// template, and the only text a publisher supplies to it is a title and a name the Worker caps
/// at `MAX_TEXT_CHARS` (200) each, escaped and repeated three times. So this is well over an order
/// of magnitude above the largest shell the Worker can render, leaves a fork room for an inlined
/// stylesheet, and is still nothing to hold in memory.
pub const MAX_PAGE_BYTES: usize = 256 * 1024;

/// The snapshot's JSON text, once inflated — and the wire cap for a snapshot that arrives as
/// plain JSON, which is the same text by another route.
///
/// **Eight times [`MAX_BLOB_BYTES`], from the measured ratio rather than a round number.**
/// `share::tests::a_thousand_card_snapshot_is_measured` put the format at 273 B a card raw against
/// 41.3 B gzipped — **6.6×**, debug build, Windows, 2026-09-08 — and `collection-sharing.md` calls
/// that compressed figure a floor, which makes the ratio a ceiling for a real binder. So a snapshot
/// at the Worker's own cap inflates to about 53 MiB, and 64 MiB is that with a fifth to spare; at
/// 273 B a card it is some 245 000 cards, five times the 50 000-card collection the sizing record
/// treats as large.
///
/// **What it refuses is the other shape entirely.** DEFLATE writes a long run of one byte in about
/// a thousandth of its length, so eight megabytes of gzipped whitespace is gigabytes of text —
/// and reading that whole was an allocation failure that took the app down with it.
pub const MAX_SNAPSHOT_BYTES: usize = 8 * MAX_BLOB_BYTES;

/// The whole open — page, snapshot and parse — on one wall clock.
///
/// ⚠️ **The per-chunk read timeout never ended anything by itself.** It restarts on every byte, so
/// a host sending one byte every 59 seconds against a 60-second timeout could hold a request open
/// for as long as it chose, and while the open ran on the write connection it held that too.
/// **Two minutes carries a snapshot at the Worker's cap at about 70 KB/s** — slower than any
/// connection that could usefully browse — and an ordinary share in a small part of that.
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(120);

/// Hops a redirect chain may take before the open stops following it. reqwest's default is ten,
/// and the Worker issues none.
const MAX_REDIRECTS: usize = 5;

/// Every bound one open is held to.
///
/// **A struct rather than constants read in place, so a test can shrink them**: a gzip bomb at a
/// one-megabyte cap costs a test milliseconds where 64 MiB would cost seconds, and a timeout test
/// waits a fraction of a second rather than two minutes. [`Limits::SHIPPED`] is the only value
/// [`open`] ever passes, and nothing outside this module can build another.
#[derive(Debug, Clone, Copy)]
struct Limits {
    page_bytes: usize,
    blob_bytes: usize,
    text_bytes: usize,
    total: Duration,
    /// `http://` to a loopback host. **`false` in every build the app ships, debug included**:
    /// nothing in this repository documents opening a share from a local `wrangler dev` in the
    /// app, so there was no flow for a debug-only exception to keep. It exists for the
    /// `httpmock` suite below, whose server speaks plain HTTP on `127.0.0.1` and has no
    /// certificate to offer.
    loopback_http: bool,
}

impl Limits {
    const SHIPPED: Limits = Limits {
        page_bytes: MAX_PAGE_BYTES,
        blob_bytes: MAX_BLOB_BYTES,
        text_bytes: MAX_SNAPSHOT_BYTES,
        total: OPEN_TIMEOUT,
        loopback_http: false,
    };
}

// ---------------------------------------------------------------------------------------
// Opening somebody else's link
// ---------------------------------------------------------------------------------------

/// Where the shell says its snapshot is, or `None` for a share that has not finished publishing.
///
/// **The `<link id="snapshot">` is the signal and its absence is the other signal**, which is
/// `share-worker/src/page.ts`'s own contract: a row with no `object_key` gets the *not ready*
/// sentence and no `<link>` at all, so this must not guess a URL to make up for one.
///
/// Parsed by hand rather than with an HTML crate: the document is one this repo writes, the tag
/// is one line of it, and a dependency to read one attribute is a dependency to audit for ever.
pub fn snapshot_href(html: &str) -> Option<&str> {
    let at = html.find("id=\"snapshot\"")?;
    let open = html[..at].rfind('<')?;
    let close = at + html[at..].find('>')?;
    let tag = &html[open..close];
    let rest = &tag[tag.find("href=\"")? + 6..];
    Some(&rest[..rest.find('"')?])
}

/// What a page's `<link id="snapshot">` names, judged against the page that named it.
#[derive(Debug, PartialEq)]
pub enum Snapshot {
    /// On the page's own origin — the one answer [`open`] fetches.
    At(Url),
    /// Neither rooted nor absolute: not a shape the Worker writes, refused rather than guessed at.
    Unwritten,
    /// On another origin. Carried so the `error_log` row can say where the page tried to send
    /// the app.
    Elsewhere(Url),
}

/// Where a snapshot is, given the page it was named on — **and only if that is the page's own
/// origin** (scheme, host and port, `Url::origin`'s sense).
///
/// The shell writes `/s/{id}/{hash}.json.gz`, a root-relative path, so the Worker's own answer
/// always lands on the page's origin and this rule costs it nothing. ⚠️ **Until 2026-09-28 an
/// absolute `href` was taken as it stood**, which let any page the reader was handed point the
/// app at any `http(s)` URL — an address on their own network included — and hand the body to
/// the render. The webview's CSP `connect-src` forbids exactly that fetch, and this was the way
/// round it: a `GET` proxy with the app's own network position (issue #545).
///
/// **Joined with a URL parser and then judged, rather than matched on prefixes**, so every
/// spelling that reaches another host lands on the same refusal: an absolute URL, a
/// protocol-relative `//cdn.example/…`, a scheme change on the same host, a different port. An
/// absolute URL on the page's own origin is accepted — a fork that writes one is still serving
/// from where the reader was sent. A bare relative `abc.json.gz` is still refused: the Worker
/// never writes one, and resolving it against `/s/{id}` would be a guess.
pub fn resolve(page: &Url, href: &str) -> Snapshot {
    // `Url::parse` succeeds only on an absolute URL; a rooted path (`/`, `//`) is the only
    // relative shape the Worker has ever written.
    if Url::parse(href).is_err() && !href.starts_with('/') {
        return Snapshot::Unwritten;
    }
    let Ok(blob) = page.join(href) else {
        return Snapshot::Unwritten;
    };
    if blob.origin() == page.origin() {
        Snapshot::At(blob)
    } else {
        Snapshot::Elsewhere(blob)
    }
}

/// Why an open failed: the sentence the reader is told, and the `error_log` row it owes, if any.
///
/// **Two halves because they now happen at different times.** The sentence goes back at once; the
/// row is written by `share_open` *after* the network trip, on a connection [`open`] never held.
/// `note` is `None` exactly where the old path wrote no row — a 404, a 410, a share not ready, a
/// paste that is not a link, a snapshot that will not parse — because those are states a reader
/// can produce by pasting, not failures.
#[derive(Debug)]
pub struct Refused {
    pub sentence: String,
    pub note: Option<OpenNote>,
}

/// One `share_open` row for `error_log`, carried out of [`open`] so it can be written later.
#[derive(Debug, Clone)]
pub struct OpenNote {
    kind: Kind,
    message: String,
    url: String,
}

impl OpenNote {
    /// Write it. [`errors::record`] answers `()`, so this can never fail the open it describes —
    /// and by the time it runs, the reader already has their answer.
    pub fn record(&self, conn: &Connection) {
        note(
            conn,
            "share_open",
            self.kind,
            &self.message,
            Some(&self.url),
        );
    }
}

impl Refused {
    /// A sentence and no row.
    fn quiet(sentence: &str) -> Refused {
        Refused {
            sentence: sentence.to_owned(),
            note: None,
        }
    }

    /// A sentence, and the row that says what happened in the words the reader was spared.
    fn noted(sentence: &str, kind: Kind, message: String, url: &Url) -> Refused {
        Refused {
            sentence: sentence.to_owned(),
            note: Some(OpenNote {
                kind,
                message,
                url: url.to_string(),
            }),
        }
    }
}

/// A transport failure — including the one [`same_origin_redirects`] raises when a hop leaves
/// the origin, which reqwest reports as a redirect error and this reports as
/// [`SNAPSHOT_ELSEWHERE`]. Every other one keeps reqwest's own sentence, which is what the old
/// path answered.
fn transport(e: &reqwest::Error, url: &Url) -> Refused {
    if e.is_redirect() {
        return Refused::noted(SNAPSHOT_ELSEWHERE, Kind::Other, e.to_string(), url);
    }
    let said = e.to_string();
    Refused::noted(&said, kind_of(e), said.clone(), url)
}

/// The size refusal, with the cap it passed kept for the log.
fn too_large(url: &Url, what: &str, cap: usize) -> Refused {
    Refused::noted(
        SHARE_TOO_LARGE,
        Kind::Parse,
        format!("the {what} passed {cap} bytes, the most this app reads for one"),
        url,
    )
}

/// The link a reader pasted, if it is one this viewer will fetch.
///
/// **`https` only, since 2026-09-28.** The paste box's shape check lets `http:` through
/// (`shareLinkFrom` in `OpenShareDialog.tsx`) and this used to as well; but the Worker builds
/// every link from its own `https` base (`shareUrl`), so a plain-HTTP link is not one it wrote,
/// and fetching one hands the page and the snapshot to anyone on the path. Refused as
/// [`NOT_A_LINK`] — the paste box's sentence word for word, so a reader hears one thing whichever
/// half noticed — and before any request, so it owes no row: a paste is a state, not a failure.
fn viewer_link(text: &str, loopback_http: bool) -> Option<Url> {
    let url = Url::parse(text.trim()).ok()?;
    let allowed = match url.scheme() {
        "https" => true,
        "http" => loopback_http && is_loopback(&url),
        _ => false,
    };
    (allowed && url.host_str().is_some()).then_some(url)
}

/// `localhost`, `127.0.0.0/8` or `::1`, read off the host's text so the `url` crate need not be
/// a direct dependency for one match.
fn is_loopback(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    bare.eq_ignore_ascii_case("localhost")
        || bare
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// Follow a redirect only while it stays on the origin its chain started from.
///
/// **Neither reqwest's default nor `Policy::none()`.** The default follows ten hops to anywhere,
/// so a page on the right origin could answer `302` to any address and the origin rule in
/// [`resolve`] would be decoration — the same proxy, one step further on. `none()` closes that
/// and refuses the harmless kind too: a fork behind a custom domain that normalises a trailing
/// slash or has moved a path. So a hop inside the origin is followed, a hop out of it is an
/// error [`transport`] turns into [`SNAPSHOT_ELSEWHERE`], and past [`MAX_REDIRECTS`] the last
/// `3xx` is handed back and reads as a status like any other. The Worker itself redirects
/// nothing.
///
/// `previous()` starts with the URL the request was made for, so the page's hops are judged
/// against the page's origin and the snapshot's against the snapshot's — which [`resolve`] has
/// already held to the page's.
fn same_origin_redirects() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        let stays = attempt
            .previous()
            .first()
            .is_some_and(|first| first.origin() == attempt.url().origin());
        let hops = attempt.previous().len();
        if !stays {
            attempt.error("the redirect left the origin the request was made to")
        } else if hops > MAX_REDIRECTS {
            attempt.stop()
        } else {
            attempt.follow()
        }
    })
}

/// The viewer's client — **built per open, and never [`http`]**.
///
/// Per open because there is nothing to pool: an open is one press and two requests to one
/// origin, and one client already carries the page's connection over to the snapshot. What a
/// process-wide client would add is the cross-runtime pool `client.rs`'s `http` records a flake
/// over. Its own because of [`same_origin_redirects`], and because of `https_only`, which is a
/// second fence under [`viewer_link`]'s: reqwest itself then refuses a plain-HTTP request or hop,
/// whatever a later edit does to the checks above it.
///
/// **A client that will not build is a refusal, never `unwrap_or_default()`** — [`http`]'s
/// fallback, which here would be a client with reqwest's default redirects: the proxy again.
fn viewer_client(loopback_http: bool) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(crate::scryfall::USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        // Per chunk, so a dead connection fails fast. It restarts on every byte, which is why it
        // is not what ends a live one — [`OPEN_TIMEOUT`] is.
        .read_timeout(Duration::from_secs(30))
        .redirect(same_origin_redirects())
        .https_only(!loopback_http)
        .build()
        .map_err(|e| format!("the app could not prepare to open that link: {e}"))
}

/// A body, read as it arrives and refused the moment it passes its cap.
///
/// **Counted, and a declared length believed only when it refuses** — `combos`' rule for its
/// feed. A chunked response declares nothing and a hostile one declares anything, so the running
/// total is the fence and `Content-Length` is only the early exit that saves downloading what
/// would be refused anyway. `update.rs`'s `stream_to_file` counts the same way.
///
/// `cap` is asked of the bytes so far because a snapshot's cap depends on what it is: a body
/// opening with the gzip magic is held to [`Limits::blob_bytes`], and anything else — the JSON an
/// edge may have decoded on the way past, which [`parse_snapshot`] reads as it stands — is the
/// inflated text by another route and is held to [`Limits::text_bytes`]. Before any byte has
/// arrived it answers the looser of the two.
async fn read_capped(
    mut response: reqwest::Response,
    url: &Url,
    what: &str,
    cap: impl Fn(&[u8]) -> usize,
) -> Result<Vec<u8>, Refused> {
    let loosest = cap(&[]);
    if response
        .content_length()
        .is_some_and(|declared| declared > loosest as u64)
    {
        return Err(too_large(url, what, loosest));
    }
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                body.extend_from_slice(&chunk);
                let limit = cap(&body);
                if body.len() > limit {
                    return Err(too_large(url, what, limit));
                }
            }
            Ok(None) => return Ok(body),
            Err(e) => return Err(transport(&e, url)),
        }
    }
}

/// Fetch one shared collection by its public link, and answer the snapshot document.
///
/// **`serde_json::Value` and not [`super::ShareSnapshot`]**, deliberately. Two reasons, and the
/// second is the one that matters:
///
/// * that struct cannot implement `Deserialize` — `fields: Vec<&'static str>` has no owned form
///   to borrow from — so reading it back would mean a second set of types for one format;
/// * and spec §10 says a snapshot whose `v` is newer than the viewer must be *told about*, not
///   refused. A strict Rust struct in this path would turn a future format into a parse error
///   here, where the only thing that can draw the sentence is the page. Rust supplies the facts;
///   TypeScript's `parseSnapshot` — the same one the web viewer uses — draws the conclusion.
///
/// **No token and no membership.** Viewing is open to everyone (spec §9), so this is the one
/// request in the file with no `authorization` header: the link *is* the capability.
///
/// ⚠️ **No `Connection` either, and that is the fix for issue #545 spelled as a signature.** Until
/// 2026-09-28 this took `&Connection` and ran on the write one — `on_the_write_connection` in
/// `commands.rs` — for no reason but to write its failures to `error_log`. So a stranger's host
/// decided how long the app's only writer was held: one byte every 59 seconds kept the per-chunk
/// timeout from ever firing, and every other press in the app answered `BUSY` for as long as the
/// host liked. Now nothing is held, a failure comes back as a [`Refused`] carrying the row it
/// owes, and `share_open` writes that row afterwards.
///
/// Held to [`Limits::SHIPPED`]: `https` only ([`viewer_link`]), the snapshot on the page's own
/// origin ([`resolve`]) and redirects that stay there ([`same_origin_redirects`]), every body
/// capped as it arrives ([`read_capped`]) and the inflated text too ([`parse_snapshot`]), and
/// [`OPEN_TIMEOUT`] over the lot.
pub async fn open(url: &str) -> Result<serde_json::Value, Refused> {
    open_within(url, Limits::SHIPPED).await
}

/// [`open`], with its bounds as an argument so a test can shrink them.
async fn open_within(url: &str, limits: Limits) -> Result<serde_json::Value, Refused> {
    let Some(page) = viewer_link(url, limits.loopback_http) else {
        return Err(Refused::quiet(NOT_A_LINK));
    };
    let client = viewer_client(limits.loopback_http)
        .map_err(|e| Refused::noted(&e, Kind::Other, e.clone(), &page))?;
    // **One clock over the page, the snapshot and the parse**, because the per-chunk read
    // timeout restarts on every byte and so never ends a trickle on its own. Dropping the
    // future on expiry drops both requests with it.
    match tokio::time::timeout(limits.total, fetch(&client, &page, limits)).await {
        Ok(answer) => answer,
        Err(_) => Err(Refused::noted(
            OPEN_TIMED_OUT,
            Kind::Timeout,
            format!("the open did not finish within {:?}", limits.total),
            &page,
        )),
    }
}

/// The page, then the snapshot it names, then the parse — the part [`OPEN_TIMEOUT`] bounds.
async fn fetch(
    client: &reqwest::Client,
    page: &Url,
    limits: Limits,
) -> Result<serde_json::Value, Refused> {
    let response = client
        .get(page.clone())
        .send()
        .await
        .map_err(|e| transport(&e, page))?;
    let status = response.status().as_u16();
    // Both answered before the body is read: the sentence is ours, and the Worker's HTML for
    // either says nothing this side could use (see [`SHARE_IS_GONE`]).
    match status {
        404 => return Err(Refused::quiet(NO_SUCH_SHARE)),
        410 => return Err(Refused::quiet(SHARE_IS_GONE)),
        _ => {}
    }
    let html = read_capped(response, page, "page", |_| limits.page_bytes).await?;
    let html = String::from_utf8_lossy(&html);
    if !(200..300).contains(&status) {
        let message = refusal(status, &html, "a shared collection");
        return Err(Refused::noted(&message, Kind::Http, message.clone(), page));
    }
    let Some(href) = snapshot_href(&html) else {
        return Err(Refused::quiet(SHARE_NOT_READY));
    };
    let blob = match resolve(page, href) {
        Snapshot::At(blob) => blob,
        Snapshot::Unwritten => return Err(Refused::quiet(NOT_A_LINK)),
        Snapshot::Elsewhere(other) => {
            return Err(Refused::noted(
                SNAPSHOT_ELSEWHERE,
                Kind::Other,
                format!("the page named its snapshot at {other}, which is not on its own origin"),
                page,
            ));
        }
    };

    // **Not [`send`], because the body is bytes rather than text.** A gzip read through
    // `response.text()` would be lossily decoded as UTF-8 before it ever reached the decoder.
    //
    // ⚠️ **`accept-encoding` is sent by hand, because reqwest is built with no `gzip` feature
    // and therefore sends none.** The Worker sets `content-encoding: gzip` on a body R2 already
    // holds compressed, but an edge is entitled to answer an `accept-encoding`-less client with
    // identity — and this client is one. Asking explicitly costs a header and removes the whole
    // question; nothing auto-decodes it here either way, which is what [`parse_snapshot`] wants.
    let response = client
        .get(blob.clone())
        .header("accept-encoding", "gzip")
        .send()
        .await
        .map_err(|e| transport(&e, &blob))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let message = refusal(status, "", "a snapshot");
        return Err(Refused::noted(&message, Kind::Http, message.clone(), &blob));
    }
    // ⚠️ **Decompressed here rather than by `reqwest`.** This crate builds reqwest with
    // `default-features = false` and no `gzip` feature, so the `content-encoding: gzip` the
    // Worker sets is passed through untouched and the body arrives as the bytes R2 holds.
    let bytes = read_capped(response, &blob, "snapshot", |head| {
        if head.starts_with(&GZIP_MAGIC) {
            limits.blob_bytes
        } else {
            limits.text_bytes
        }
    })
    .await?;
    // **On the blocking pool, because inflating and parsing is CPU rather than I/O** — tens of
    // megabytes at the cap, and this future runs on the runtime every other command shares.
    let text_bytes = limits.text_bytes;
    let parsed = tokio::task::spawn_blocking(move || parse_snapshot(&bytes, text_bytes))
        .await
        .map_err(|e| {
            let said = format!("that shared collection could not be read: {e}");
            Refused::noted(&said, Kind::Other, said.clone(), &blob)
        })?;
    match parsed {
        Ok(value) => Ok(value),
        Err(Unreadable::TooLarge) => Err(too_large(&blob, "inflated snapshot", text_bytes)),
        Err(Unreadable::Corrupt(sentence)) => Err(Refused::quiet(&sentence)),
    }
}

/// The two bytes a gzip member opens with. Sniffed rather than assumed — see [`parse_snapshot`].
const GZIP_MAGIC: [u8; 2] = [0x1f, 0x8b];

/// What a body that arrived whole still could not become.
#[derive(Debug, PartialEq)]
enum Unreadable {
    /// It inflated past the text cap — a gzip bomb, or at any rate nothing a share can be.
    TooLarge,
    /// Not gzip, not JSON, or not an object. The sentence is the reader's, and it owes no row:
    /// the old path wrote none for it.
    Corrupt(String),
}

/// Gunzip **if it is gzip** and parse, with the one check this side is entitled to make — and
/// never past `text_cap` bytes of text.
///
/// **An object, and nothing further.** Whether `v` is a version this app can draw is
/// TypeScript's question (see [`open`]); whether the bytes are a JSON document at all is not,
/// because the alternative is handing the page a number or a string where it expects a binder.
///
/// ⚠️ **The encoding is sniffed and never assumed, and this is insurance rather than tidiness.**
/// The Worker stores a gzipped body and sets `content-encoding: gzip` by hand; reqwest is built
/// here with no `gzip` feature, so nothing on this side decodes anything. Both halves of that are
/// true *today* and neither is this app's to guarantee: an edge that answered identity — to a
/// client that sends no `accept-encoding`, or that decodes on the way past — would make every
/// in-app open fail with a corruption sentence on a perfectly healthy share, and no document can
/// settle which it does. So a body opening `1f 8b` is gunzipped and anything else is read as the
/// JSON it may well be. A body that is neither still lands on the same sentence it always did.
///
/// ⚠️ **`take(text_cap + 1)` and never an uncapped `read_to_string`, and the `+ 1` is the whole of
/// the check** (issue #545). The uncapped read allocated whatever the stream inflated to — an
/// eight-megabyte gzip of whitespace is gigabytes — and the app aborted on the allocation. A read
/// capped at exactly `text_cap` would stop there and hand the parser a truncated document: a
/// refusal for the wrong reason, and a bomb that is a real document followed by padding would
/// *parse*. One byte past the cap is what tells "that is all there is" from "there is more". Read
/// as bytes and parsed with `from_slice`, so a cut through a UTF-8 sequence cannot raise an error
/// of its own ahead of the size.
fn parse_snapshot(bytes: &[u8], text_cap: usize) -> Result<serde_json::Value, Unreadable> {
    use std::io::Read;
    let corrupt = |e: &dyn std::fmt::Display| {
        Unreadable::Corrupt(format!("that shared collection could not be read: {e}"))
    };
    let text: std::borrow::Cow<'_, [u8]> = if bytes.starts_with(&GZIP_MAGIC) {
        let mut inflated = Vec::new();
        flate2::read::GzDecoder::new(bytes)
            .take((text_cap as u64).saturating_add(1))
            .read_to_end(&mut inflated)
            .map_err(|e| corrupt(&e))?;
        std::borrow::Cow::Owned(inflated)
    } else {
        std::borrow::Cow::Borrowed(bytes)
    };
    if text.len() > text_cap {
        return Err(Unreadable::TooLarge);
    }
    let value: serde_json::Value = serde_json::from_slice(&text).map_err(|e| corrupt(&e))?;
    if !value.is_object() {
        return Err(Unreadable::Corrupt(
            "that shared collection could not be read: it is not a snapshot".to_owned(),
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_db() -> Connection {
        crate::schema::memory_pair()
    }

    /// A user folder — `share/tests.rs`' own fixture in two lines rather than a call into it,
    /// because that module is `#[cfg(test)]` and private to its own file.
    fn folder(conn: &Connection, name: &str, locked: bool) -> String {
        let uid = format!("uid-{name}");
        conn.execute(
            "INSERT INTO collection_folders
               (parent_id, name, kind, sort_order, created_at, updated_at, sync_uid, locked)
             VALUES (NULL, ?1, 'user', 0, 0, 0, ?2, ?3)",
            rusqlite::params![name, uid, i64::from(locked)],
        )
        .unwrap();
        uid
    }

    /// One card on the wire, with only the two fields [`meta_body`] reads made interesting.
    fn wire_card(q: i64, p: Option<f64>) -> super::super::ShareCard {
        super::super::ShareCard {
            id: format!("card-{q}"),
            n: "Lightning Bolt".to_owned(),
            s: "lea".to_owned(),
            cn: "161".to_owned(),
            f: "nonfoil".to_owned(),
            q,
            fo: None,
            img: None,
            c: None,
            l: None,
            p,
        }
    }

    fn wire_snapshot(cards: Vec<super::super::ShareCard>) -> super::super::ShareSnapshot {
        super::super::ShareSnapshot {
            v: 1,
            id: String::new(),
            title: "Trade binder".to_owned(),
            owner: "Giradeli".to_owned(),
            updated_at: 0,
            marketplace: "tcgplayer".to_owned(),
            currency: "USD".to_owned(),
            fields: vec!["value"],
            folders: Vec::new(),
            cards,
        }
    }

    fn meta(cards: Vec<super::super::ShareCard>) -> serde_json::Value {
        let body = meta_body(Some("uid-a"), "Giradeli", &wire_snapshot(cards)).unwrap();
        serde_json::from_str(&body).unwrap()
    }

    fn row(id: &str) -> ShareRow {
        ShareRow {
            id: id.to_owned(),
            folder_uid: Some("uid-a".to_owned()),
            title: "Trade binder".to_owned(),
            owner_name: "Giradeli".to_owned(),
            url: format!("https://share.example/s/{id}"),
            fields: vec!["value".to_owned()],
            state: "live".to_owned(),
            published: Some(2_000),
            updated_at: 2_000,
        }
    }

    /// A publish that fails leaves the previous snapshot and the previous link alone.
    #[test]
    fn a_failed_upload_does_not_move_the_cached_row() {
        let conn = open_db();
        let before = row("kQ2p7fMx9Lb0RtVw");
        cache::store(&conn, &before).unwrap();

        let mut attempt = before.clone();
        attempt.title = "Trade binder (new)".to_owned();
        attempt.published = Some(9_999);
        attempt.state = "lapsed".to_owned();

        let err = commit_publish(&conn, &attempt, Err("the upload died".to_owned())).unwrap_err();
        assert_eq!(err, "the upload died");

        let after = cache::get(&conn, "kQ2p7fMx9Lb0RtVw").unwrap().unwrap();
        assert_eq!(
            after.published,
            Some(2_000),
            "the stamp must not have moved"
        );
        assert_eq!(after.state, "live", "nor the state");
        assert_eq!(after.title, "Trade binder", "nor anything else");
    }

    /// ...and the same call with the upload's success writes every one of them.
    #[test]
    fn a_landed_upload_moves_the_cached_row() {
        let conn = open_db();
        cache::store(&conn, &row("kQ2p7fMx9Lb0RtVw")).unwrap();

        let mut attempt = row("kQ2p7fMx9Lb0RtVw");
        attempt.title = "Trade binder (new)".to_owned();
        attempt.published = Some(9_999);

        let answered = commit_publish(&conn, &attempt, Ok(())).unwrap();
        assert_eq!(answered.title, "Trade binder (new)");
        let after = cache::get(&conn, "kQ2p7fMx9Lb0RtVw").unwrap().unwrap();
        assert_eq!(after.published, Some(9_999));
        assert_eq!(after.title, "Trade binder (new)");
    }

    /// The cap refusals keep the relay's sentence, because the number is in it — and the test
    /// reads that number from the message rather than from a binding, which is spec §12's one
    /// rule about a cap test.
    #[test]
    fn the_two_caps_keep_the_sentence_that_carries_the_number() {
        let shares = refusal(
            403,
            r#"{"error":"that group has already shared 20 collections. Revoke one before sharing another.","code":"share_limit"}"#,
            "a publish",
        );
        assert!(shares.contains("20"), "{shares}");

        let blob = refusal(
            413,
            r#"{"error":"that snapshot is 9431204 bytes and a share may be at most 8388608.","code":"blob_limit"}"#,
            "an upload",
        );
        assert!(blob.contains("9431204"), "{blob}");
    }

    /// **A 403 that is not the cap must not inherit the cap's sentence.** `entitlement`'s
    /// `device_limit` is where this was learned: a bare status told a lapsed reader they had
    /// too many devices, which is the wrong sentence about the wrong problem.
    #[test]
    fn a_403_without_the_code_keeps_its_own_sentence() {
        let other = refusal(
            403,
            r#"{"error":"that membership is not active"}"#,
            "a publish",
        );
        assert_eq!(other, "that membership is not active");

        // **The half that makes the code match observable at all.** A 403 whose body says
        // nothing has no sentence of the relay's to fall back on, so an arm matching the
        // *status* would hand this reader the cap's advice — *withdraw one before sharing
        // another* — over a membership that is simply not active. Dropping `Some(SHARE_LIMIT)`
        // from the match leaves the assertion above green and this one red.
        let silent = refusal(403, "{}", "a publish");
        assert!(!silent.contains("Withdraw"), "{silent}");
        assert!(silent.contains("403"), "{silent}");
    }

    /// A 401 is the gate, and the app's own sentence — never the relay's, which has none.
    #[test]
    fn a_401_is_the_membership_sentence() {
        assert_eq!(refusal(401, "", "a publish"), MEMBERSHIP_REFUSED);
    }

    /// A body that is not JSON at all still lands on a sentence naming the status.
    #[test]
    fn an_unreadable_refusal_still_names_the_status() {
        let said = refusal(500, "<html>oh dear</html>", "a publish");
        assert!(said.contains("500"), "{said}");
        assert!(said.contains("a publish"), "{said}");
    }

    #[test]
    fn the_shell_names_where_its_snapshot_is() {
        let html = "<head>\n<link id=\"snapshot\" rel=\"preload\" as=\"fetch\" crossorigin \
                    href=\"/s/kQ2p7fMx9Lb0RtVw/0123456789abcdef.json.gz\">\n</head>";
        assert_eq!(
            snapshot_href(html),
            Some("/s/kQ2p7fMx9Lb0RtVw/0123456789abcdef.json.gz")
        );
    }

    /// A share whose blob never landed has no `<link>` at all, and that absence *is* the signal.
    #[test]
    fn a_shell_with_no_snapshot_names_none() {
        let html = "<body><div id=\"root\"></div><main id=\"pending\"><p>not ready</p></main>";
        assert_eq!(snapshot_href(html), None);
    }

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn a_root_relative_snapshot_resolves_against_the_pages_origin() {
        assert_eq!(
            resolve(
                &url("https://share.example/s/kQ2p7fMx9Lb0RtVw"),
                "/s/kQ2p/abc.json.gz"
            ),
            Snapshot::At(url("https://share.example/s/kQ2p/abc.json.gz"))
        );
    }

    /// ⚠️ **This test was `an_absolute_snapshot_url_is_taken_as_it_stands` until 2026-09-28, and
    /// its premise was the bug** (issue #545): a page anyone can host named any URL and the app
    /// fetched it, which is a `GET` proxy past the webview's CSP. Every spelling below reaches
    /// another origin, and each is one a prefix test would have let through or mangled — the
    /// protocol-relative one was joined onto the page's host as a *path* by the old code.
    #[test]
    fn a_snapshot_on_another_origin_is_refused_whichever_way_it_is_spelled() {
        let page = url("https://share.example/s/x");
        for elsewhere in [
            "https://cdn.example/a.json.gz",
            "//cdn.example/a.json.gz",
            // The same host is not the same origin: scheme and port are the other two thirds.
            "http://share.example/s/x/a.json.gz",
            "https://share.example:8443/s/x/a.json.gz",
            // The address a proxy is for: something only the reader's own network can reach.
            "http://192.168.1.1/admin",
            "javascript:alert(1)",
        ] {
            assert!(
                matches!(resolve(&page, elsewhere), Snapshot::Elsewhere(_)),
                "{elsewhere}"
            );
        }
    }

    /// An absolute `href` on the page's own origin is where the reader was sent anyway, so it is
    /// taken — and the default port spelled out, or the host in capitals, is still that origin,
    /// which is the equality a string comparison would have got wrong.
    #[test]
    fn an_absolute_snapshot_on_the_pages_own_origin_is_taken() {
        let page = url("https://share.example/s/x");
        let want = Snapshot::At(url("https://share.example/s/x/h.json.gz"));
        assert_eq!(resolve(&page, "https://share.example/s/x/h.json.gz"), want);
        assert_eq!(
            resolve(&page, "https://SHARE.example:443/s/x/h.json.gz"),
            want
        );
    }

    /// Anything that is neither is not a link this Worker writes.
    #[test]
    fn a_bare_relative_snapshot_is_refused_rather_than_guessed_at() {
        let page = url("https://share.example/s/x");
        assert_eq!(resolve(&page, "abc.json.gz"), Snapshot::Unwritten);
        assert_eq!(resolve(&page, "../abc.json.gz"), Snapshot::Unwritten);
    }

    /// **`https` or nothing** — and a loopback `http` only where a test asks for it, which is
    /// narrower than it reads: a plain-HTTP host that is not loopback is refused either way.
    #[test]
    fn only_an_https_link_is_fetched() {
        assert!(viewer_link("https://share.example/s/abc", false).is_some());
        assert!(viewer_link("  https://share.example/s/abc \n", false).is_some());
        for refused in [
            "http://share.example/s/abc",
            "http://127.0.0.1:8787/s/abc",
            "ftp://share.example/s/abc",
            "javascript:alert(1)",
            "file:///C:/Users/reader/secrets.json",
            "share.example/s/abc",
            "",
        ] {
            assert!(viewer_link(refused, false).is_none(), "{refused:?}");
        }
        for loopback in [
            "http://127.0.0.1:8787/s/abc",
            "http://localhost:8787/s/abc",
            "http://[::1]:8787/s/abc",
        ] {
            assert!(viewer_link(loopback, true).is_some(), "{loopback}");
        }
        assert!(viewer_link("http://share.example/s/abc", true).is_none());
        assert!(viewer_link("http://192.168.1.1/s/abc", true).is_none());
    }

    #[test]
    fn a_gzipped_snapshot_round_trips_back_to_its_document() {
        let bytes = gzip(br#"{"v":1,"cards":[]}"#).unwrap();
        let value = parse_snapshot(&bytes, MAX_SNAPSHOT_BYTES).unwrap();
        assert_eq!(value["v"], 1);
    }

    /// A snapshot that is JSON but not a document is refused here, because the alternative is
    /// handing the page a number where it expects a binder.
    #[test]
    fn a_snapshot_that_is_not_an_object_is_refused() {
        let bytes = gzip(b"[1,2,3]").unwrap();
        assert!(parse_snapshot(&bytes, MAX_SNAPSHOT_BYTES).is_err());
    }

    /// **The bomb the issue describes, built rather than described**: four megabytes of spaces
    /// gzip to a few kilobytes, and an uncapped read would have allocated every byte of the
    /// inflation before the parser saw any of it. Refused as too large — not as corrupt JSON,
    /// which a whitespace document also is, and which would have been the right refusal for the
    /// wrong reason.
    #[test]
    fn a_gzip_bomb_is_refused_at_the_inflated_cap_rather_than_read_whole() {
        let cap = 1 << 20;
        let bomb = gzip(&vec![b' '; 4 << 20]).unwrap();
        assert!(
            bomb.len() < MAX_PAGE_BYTES / 4,
            "the fixture is not a bomb: {} bytes compressed",
            bomb.len()
        );
        assert_eq!(parse_snapshot(&bomb, cap), Err(Unreadable::TooLarge));
    }

    /// **The `+ 1` in `take(text_cap + 1)`, pinned from both sides.** A document of exactly the
    /// cap opens and one byte more does not, compressed or plain — and the one byte more is a
    /// real document followed by padding, which a read capped at the cap itself would have
    /// truncated back to something that *parses*.
    #[test]
    fn a_snapshot_exactly_at_the_inflated_cap_opens_and_one_byte_more_does_not() {
        let cap = 64 * 1024;
        let mut doc = br#"{"v":1,"cards":[]}"#.to_vec();
        doc.resize(cap, b' ');
        assert!(parse_snapshot(&gzip(&doc).unwrap(), cap).is_ok());
        assert!(
            parse_snapshot(&doc, cap).is_ok(),
            "and served as plain JSON"
        );

        doc.push(b' ');
        assert_eq!(
            parse_snapshot(&gzip(&doc).unwrap(), cap),
            Err(Unreadable::TooLarge)
        );
        assert_eq!(parse_snapshot(&doc, cap), Err(Unreadable::TooLarge));
    }

    /// ⚠️ **A share served without its `content-encoding` still opens, and this is the one thing
    /// about the blob fetch that cannot be settled from a document.**
    ///
    /// The Worker stores gzip and nails `content-encoding: gzip` on by hand; reqwest is built
    /// with no `gzip` feature and so sends no `accept-encoding` of its own until [`open`] adds
    /// one. An edge answering that client with identity is entirely allowed to, and the failure
    /// it produced was the worst kind — a corruption sentence about a perfectly healthy share.
    /// So the magic is sniffed, and plain JSON is read as plain JSON.
    #[test]
    fn a_snapshot_served_as_plain_json_is_read_rather_than_called_corrupt() {
        let value = parse_snapshot(br#"{"v":1,"cards":[]}"#, MAX_SNAPSHOT_BYTES).unwrap();
        assert_eq!(value["v"], 1);
    }

    /// The sniff is on the **magic bytes** and not on a heuristic about the first character, so a
    /// body that is neither gzip nor JSON still lands on the sentence it always did.
    #[test]
    fn a_body_that_is_neither_gzip_nor_json_is_a_sentence_rather_than_a_panic() {
        assert!(parse_snapshot(b"not gzip at all", MAX_SNAPSHOT_BYTES).is_err());
        // Gzip magic over bytes that are not a gzip member: the decoder's own refusal, not the
        // JSON parser's, which is what says the sniff selected the right arm.
        assert!(parse_snapshot(&[0x1f, 0x8b, 0x00, 0x01], MAX_SNAPSHOT_BYTES).is_err());
    }

    /// The base is the compiled-in host until a `sync_state` row overrides it, and a blank row
    /// is not an override — `entitlement::base`'s rule, and for its reason.
    #[test]
    fn the_share_base_takes_an_override_but_not_a_blank_one() {
        let conn = open_db();
        assert_eq!(base(&conn), SHARE_BASE);
        client::set_state(&conn, SHARE_URL, "   ").unwrap();
        assert_eq!(base(&conn), SHARE_BASE);
        client::set_state(&conn, SHARE_URL, "http://127.0.0.1:8787/").unwrap();
        assert_eq!(base(&conn), "http://127.0.0.1:8787");
    }

    // -----------------------------------------------------------------------------------
    // The metadata body
    // -----------------------------------------------------------------------------------

    /// **Copies, not rows.** The page prints "412 cards", and a binder of four playsets is
    /// sixteen cards rather than four.
    #[test]
    fn the_card_count_is_the_copies_and_not_the_rows() {
        let body = meta(vec![wire_card(2, None), wire_card(3, None)]);
        assert_eq!(body["cardCount"], 5);
    }

    /// **A binder no feed quotes is worth `null` and never `0`.** A zero is the page claiming
    /// the collection is worth nothing, which is a statement about the *cards* rather than
    /// about the marketplace that declined to price them.
    #[test]
    fn a_snapshot_with_no_priced_card_carries_no_total_at_all() {
        let body = meta(vec![wire_card(2, None), wire_card(3, None)]);
        assert!(body["totalValue"].is_null(), "{body}");
    }

    /// And a partly-priced one totals what it has, per **copy**.
    #[test]
    fn the_total_value_sums_the_priced_copies_and_steps_over_the_rest() {
        let body = meta(vec![wire_card(2, Some(1.5)), wire_card(3, None)]);
        assert_eq!(body["totalValue"], 3.0);
    }

    /// The whole collection crosses as an explicit `null`, which is what `metaProblem` reads as
    /// "no folder" — an omitted key would mean the same thing to that Worker and to no other
    /// reader of this body.
    #[test]
    fn a_whole_collection_share_names_its_folder_as_null() {
        let body = meta_body(None, "Giradeli", &wire_snapshot(Vec::new())).unwrap();
        let body: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(body["folderUid"].is_null(), "{body}");
        assert_eq!(body["ownerName"], "Giradeli");
        assert_eq!(body["title"], "Trade binder");
    }

    // -----------------------------------------------------------------------------------
    // The order, and the three refusals that stand ahead of the network
    // -----------------------------------------------------------------------------------

    /// **The whole of the step-order decision, pinned.** The plan had the `POST` go first;
    /// [`publish`] reads the snapshot first, because the metadata carries a `cardCount` that is
    /// a fact about the read *and* because a folder the app is about to refuse must never have
    /// left a row on the relay. Reverse the two and this database — a locked folder, no
    /// membership, no host — answers something about connecting instead of something about the
    /// folder, which is the reader being sent to fix the wrong thing.
    ///
    /// **It makes no request**: `entitlement::access_token` short-circuits with neither a
    /// refresh secret nor a group, and nothing above it opens a socket either.
    #[tokio::test]
    async fn a_locked_folder_is_refused_before_anything_reaches_the_network() {
        let conn = open_db();
        let uid = folder(&conn, "Vault", true);
        let err = publish(&conn, &conn, Some(&uid), "Giradeli", ShareFields::default())
            .await
            .unwrap_err();
        assert_eq!(err, super::super::FOLDER_IS_LOCKED);
    }

    /// One rung down: the folder is fine, so the next thing that can be wrong is that there is
    /// nowhere to publish to. **Ahead of the token**, because minting a grant for a press with
    /// no destination is a round trip spent on nothing.
    ///
    /// **An override with no scheme is how a build reaches this since 2026-10-01.** Until then
    /// the compiled-in [`SHARE_BASE`] was itself such a string and this test needed no setup.
    #[tokio::test]
    async fn a_base_that_names_no_host_refuses_in_words_rather_than_in_reqwests() {
        let conn = open_db();
        client::set_state(&conn, SHARE_URL, "share.example").unwrap();
        let uid = folder(&conn, "Binder", false);
        let err = publish(&conn, &conn, Some(&uid), "Giradeli", ShareFields::default())
            .await
            .unwrap_err();
        assert_eq!(err, NOT_DEPLOYED);
        assert!(
            !err.contains("relative URL"),
            "the reader must never meet reqwest's sentence about a mistake nobody made"
        );
    }

    /// And the rung below that: with a host, the missing thing is the membership. Still no
    /// socket — `access_token` answers `Ok(None)` on a device holding neither secret nor group.
    #[tokio::test]
    async fn a_host_with_no_membership_refuses_with_the_connect_story() {
        let conn = open_db();
        client::set_state(&conn, SHARE_URL, "http://127.0.0.1:1").unwrap();
        let uid = folder(&conn, "Binder", false);
        let err = publish(&conn, &conn, Some(&uid), "Giradeli", ShareFields::default())
            .await
            .unwrap_err();
        assert_eq!(err, NOT_CONNECTED);
    }

    /// An empty name is the app's own refusal and stands ahead of all three, because it is about
    /// the box the reader left blank rather than about anything they could not have known.
    #[tokio::test]
    async fn a_blank_owner_name_is_refused_before_the_folder_is_even_read() {
        let conn = open_db();
        let uid = folder(&conn, "Vault", true);
        let err = publish(&conn, &conn, Some(&uid), "   ", ShareFields::default())
            .await
            .unwrap_err();
        assert_eq!(err, OWNER_NAME_REQUIRED);
    }

    /// A list with nowhere to ask is the cache, silently — no request, no `error_log` row, and
    /// no refusal for a reader who has simply never shared anything. **Both ways of having
    /// nowhere to ask**: a base that names no host, and the compiled-in host on a device with no
    /// membership, which is every unconnected reader's list since [`SHARE_BASE`] became real.
    #[tokio::test]
    async fn a_list_with_nowhere_to_ask_is_the_cache_and_says_nothing() {
        for override_base in [Some("share.example"), None] {
            let conn = open_db();
            if let Some(base) = override_base {
                client::set_state(&conn, SHARE_URL, base).unwrap();
            }
            cache::store(&conn, &row("kQ2p7fMx9Lb0RtVw")).unwrap();
            let rows = list(&conn, &conn).await.unwrap();
            assert_eq!(rows.len(), 1, "{override_base:?}");
            let logged: i64 = conn
                .query_row("SELECT count(*) FROM error_log", [], |r| r.get(0))
                .unwrap();
            assert_eq!(logged, 0, "nothing went wrong, so nothing is a failure");
        }
    }

    // -----------------------------------------------------------------------------------
    // The field vocabulary, both ways
    // -----------------------------------------------------------------------------------

    /// **Two spellings of one vocabulary with nothing but this between them.**
    /// `ShareFields::names()` writes the array `collection_shares.fields` stores and
    /// [`fields_from_names`] reads it back on every *Refresh*; they agree today and drift is
    /// silent. All eight combinations, through the real writer.
    #[test]
    fn a_field_set_survives_the_round_trip_through_the_wire_names() {
        let conn = open_db();
        for bits in 0..8u8 {
            let want = ShareFields {
                condition: bits & 1 != 0,
                lang: bits & 2 != 0,
                value: bits & 4 != 0,
            };
            let snap = snapshot(
                &conn,
                "",
                "Giradeli",
                None,
                want,
                crate::sorting::Marketplace::Tcgplayer,
                0,
            )
            .unwrap();
            let names: Vec<String> = snap.fields.iter().map(|f| (*f).to_owned()).collect();
            let back = fields_from_names(&names);
            assert_eq!(
                (back.condition, back.lang, back.value),
                (want.condition, want.lang, want.value),
                "{names:?}"
            );
        }
    }

    /// ⚠️ The one thing about [`SHARE_BASE`] a build can check: `share-worker/wrangler.jsonc`
    /// carries the same string. They moved from the placeholder to the host together on
    /// 2026-10-01, and this test is what asks the person changing one whether they changed both.
    #[test]
    fn the_share_base_is_the_workers_own() {
        let wrangler = include_str!("../../../share-worker/wrangler.jsonc");
        assert!(
            wrangler.contains(&format!("\"SHARE_BASE\": \"{SHARE_BASE}\"")),
            "share::SHARE_BASE and share-worker/wrangler.jsonc's SHARE_BASE must be the same \
             string, byte for byte"
        );
    }

    /// **And it is a host a request can be sent to**: `endpoint` accepts it with no override,
    /// which is what ended `NOT_DEPLOYED` as every build's answer — and it carries no trailing
    /// slash, because every caller here and `shareUrl` in the Worker appends its own path.
    #[test]
    fn the_compiled_in_base_is_a_host_and_carries_no_trailing_slash() {
        let conn = open_db();
        assert_eq!(endpoint(&conn).as_deref(), Ok(SHARE_BASE));
        assert!(SHARE_BASE.starts_with("https://"), "{SHARE_BASE}");
        assert!(!SHARE_BASE.ends_with('/'), "{SHARE_BASE}");
    }

    /// ⚠️ **[`MAX_BLOB_BYTES`] is `env.ts`'s number in a second language**, and the viewer's
    /// refusal is only honest while they agree: a Worker raised to 16 MiB would publish shares
    /// this app then refuses as larger than a share can be. So the TypeScript expression is read
    /// and multiplied out rather than matched as a string, which keeps the test green across a
    /// respelling (`8_388_608`) and red across a change.
    #[test]
    fn the_blob_cap_is_the_workers_own() {
        let env = include_str!("../../../share-worker/src/env.ts");
        let marker = "export const MAX_BLOB_BYTES =";
        let at = env
            .find(marker)
            .expect("share-worker/src/env.ts no longer exports MAX_BLOB_BYTES");
        let rest = &env[at + marker.len()..];
        let expression = &rest[..rest.find(';').expect("MAX_BLOB_BYTES has no `;`")];
        let workers: usize = expression
            .split('*')
            .map(|factor| {
                factor
                    .trim()
                    .replace('_', "")
                    .parse::<usize>()
                    .unwrap_or_else(|_| panic!("`{expression}` is not a product of integers"))
            })
            .product();
        assert_eq!(MAX_BLOB_BYTES, workers, "env.ts says `{expression}`");
    }

    // -----------------------------------------------------------------------------------
    // The viewer, end to end over HTTP (issue #545)
    // -----------------------------------------------------------------------------------

    /// The shipped bounds with the one test allowance: `httpmock` speaks plain HTTP on loopback.
    fn over_loopback() -> Limits {
        Limits {
            loopback_http: true,
            ..Limits::SHIPPED
        }
    }

    /// The shell as `page.ts` writes it, naming `href`.
    fn shell(href: &str) -> String {
        format!(
            "<!doctype html><html><head>\n<link id=\"snapshot\" rel=\"preload\" as=\"fetch\" \
             crossorigin href=\"{href}\">\n</head><body><div id=\"root\"></div></body></html>"
        )
    }

    const DOC: &[u8] = br#"{"v":1,"folders":[],"cards":[]}"#;

    /// A page at `/s/abc` naming `/s/abc/h.json.gz`, and that snapshot answering `blob`.
    async fn share_at(server: &httpmock::MockServer, blob: Vec<u8>) -> httpmock::Mock<'_> {
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/s/abc");
                then.status(200).body(shell("/s/abc/h.json.gz"));
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/s/abc/h.json.gz");
                then.status(200).body(blob);
            })
            .await
    }

    /// The whole happy path, and the `accept-encoding` the Worker's edge is entitled to need.
    #[tokio::test]
    async fn a_share_opens_from_its_pages_own_origin() {
        let server = httpmock::MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/s/abc");
                then.status(200).body(shell("/s/abc/h.json.gz"));
            })
            .await;
        let blob = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET)
                    .path("/s/abc/h.json.gz")
                    .header("accept-encoding", "gzip");
                then.status(200)
                    .header("content-encoding", "gzip")
                    .body(gzip(DOC).unwrap());
            })
            .await;

        let value = open_within(&server.url("/s/abc"), over_loopback())
            .await
            .unwrap();
        assert_eq!(value["v"], 1);
        assert_eq!(blob.calls_async().await, 1);
    }

    /// **The proxy, closed.** Two mock servers are two origins on one loopback address, so a page
    /// on the first naming a snapshot on the second is exactly the shape of a page naming an
    /// address on the reader's own network — and the second must never hear a request.
    #[tokio::test]
    async fn a_snapshot_on_another_origin_is_refused_and_never_requested() {
        let page_host = httpmock::MockServer::start_async().await;
        let other = httpmock::MockServer::start_async().await;
        let elsewhere = other
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET);
                then.status(200).body(gzip(DOC).unwrap());
            })
            .await;
        let href = other.url("/s/abc/h.json.gz");
        page_host
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/s/abc");
                then.status(200).body(shell(&href));
            })
            .await;

        let refused = open_within(&page_host.url("/s/abc"), over_loopback())
            .await
            .unwrap_err();
        assert_eq!(refused.sentence, SNAPSHOT_ELSEWHERE);
        let note = refused
            .note
            .expect("a page pointing elsewhere is worth a row");
        assert!(note.message.contains(&href), "{}", note.message);
        assert_eq!(elsewhere.calls_async().await, 0);
    }

    /// **The same proxy, one step further on**: a page on the right origin answering `302` to
    /// another one. The origin rule in [`resolve`] would be decoration if reqwest's default
    /// policy followed it — for the page and for the snapshot alike.
    #[tokio::test]
    async fn a_redirect_off_the_origin_is_refused_and_never_followed() {
        let page_host = httpmock::MockServer::start_async().await;
        let other = httpmock::MockServer::start_async().await;
        let followed = other
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET);
                then.status(200).body(shell("/s/abc/h.json.gz"));
            })
            .await;
        let away = other.url("/s/abc");
        page_host
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/s/abc");
                then.status(302).header("location", away.as_str());
            })
            .await;
        // And the snapshot's own hop, on a page that is otherwise the Worker's.
        page_host
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/s/def");
                then.status(200).body(shell("/s/def/h.json.gz"));
            })
            .await;
        page_host
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/s/def/h.json.gz");
                then.status(302).header("location", away.as_str());
            })
            .await;

        for link in ["/s/abc", "/s/def"] {
            let refused = open_within(&page_host.url(link), over_loopback())
                .await
                .unwrap_err();
            assert_eq!(refused.sentence, SNAPSHOT_ELSEWHERE, "{link}");
            assert!(refused.note.is_some(), "{link}");
        }
        assert_eq!(followed.calls_async().await, 0);
    }

    /// **Why the policy is not `Policy::none()`**: a hop that stays home — a trailing slash a
    /// fork's domain normalises — is followed like reqwest always followed it.
    #[tokio::test]
    async fn a_redirect_within_the_origin_is_followed() {
        let server = httpmock::MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/s/abc");
                then.status(301).header("location", "/s/abc/");
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/s/abc/");
                then.status(200).body(shell("/s/abc/h.json.gz"));
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/s/abc/h.json.gz");
                then.status(200).body(gzip(DOC).unwrap());
            })
            .await;

        let value = open_within(&server.url("/s/abc"), over_loopback())
            .await
            .unwrap();
        assert_eq!(value["v"], 1);
    }

    /// **The compressed cap, counted as the body arrives** — gzip magic over four kilobytes of
    /// nothing, against a one-kilobyte blob cap. The declared length is under the looser text cap
    /// on purpose, so it is the running count that refuses and not the early exit.
    #[tokio::test]
    async fn a_compressed_snapshot_over_the_blob_cap_is_refused() {
        let server = httpmock::MockServer::start_async().await;
        let mut body = GZIP_MAGIC.to_vec();
        body.resize(4096, 0);
        share_at(&server, body).await;
        let limits = Limits {
            blob_bytes: 1024,
            ..over_loopback()
        };

        let refused = open_within(&server.url("/s/abc"), limits)
            .await
            .unwrap_err();
        assert_eq!(refused.sentence, SHARE_TOO_LARGE);
        let note = refused.note.expect("an oversized body is worth a row");
        assert!(note.message.contains("1024"), "{}", note.message);
    }

    /// ...and **the same size served as plain JSON opens**, because it is the inflated text by
    /// another route and is held to that cap. Holding it to the blob cap would refuse a large,
    /// healthy share on exactly the edge the magic sniff exists to survive.
    #[tokio::test]
    async fn a_plain_json_snapshot_is_held_to_the_text_cap_rather_than_the_blob_cap() {
        let server = httpmock::MockServer::start_async().await;
        let mut doc = DOC.to_vec();
        doc.resize(4096, b' ');
        share_at(&server, doc).await;
        let limits = Limits {
            blob_bytes: 1024,
            ..over_loopback()
        };

        let value = open_within(&server.url("/s/abc"), limits).await.unwrap();
        assert_eq!(value["v"], 1);
    }

    /// The bomb over the wire: small enough for the blob cap, far too large once inflated, and
    /// refused with a row naming the inflation rather than read whole.
    #[tokio::test]
    async fn a_gzip_bomb_served_as_a_snapshot_is_refused_with_a_row() {
        let server = httpmock::MockServer::start_async().await;
        share_at(&server, gzip(&vec![b' '; 4 << 20]).unwrap()).await;
        let limits = Limits {
            text_bytes: 1 << 20,
            ..over_loopback()
        };

        let refused = open_within(&server.url("/s/abc"), limits)
            .await
            .unwrap_err();
        assert_eq!(refused.sentence, SHARE_TOO_LARGE);
        let note = refused.note.expect("a bomb is worth a row");
        assert!(note.message.contains("inflated"), "{}", note.message);
    }

    /// The page has a cap of its own, and a page over it never gets as far as naming a snapshot.
    #[tokio::test]
    async fn a_page_over_the_page_cap_is_refused_before_its_snapshot_is_asked_for() {
        let server = httpmock::MockServer::start_async().await;
        let padded = format!("{}{}", shell("/s/abc/h.json.gz"), " ".repeat(4096));
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/s/abc");
                then.status(200).body(padded.as_str());
            })
            .await;
        let blob = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/s/abc/h.json.gz");
                then.status(200).body(gzip(DOC).unwrap());
            })
            .await;
        let limits = Limits {
            page_bytes: 1024,
            ..over_loopback()
        };

        let refused = open_within(&server.url("/s/abc"), limits)
            .await
            .unwrap_err();
        assert_eq!(refused.sentence, SHARE_TOO_LARGE);
        assert_eq!(blob.calls_async().await, 0);
    }

    /// **The wall clock, and that it is the wall clock that fired.** The page is held back ten
    /// seconds — well inside the thirty-second per-chunk read timeout, which is exactly the gap a
    /// trickling host lives in — and the open answers in a fraction of that.
    #[tokio::test]
    async fn an_open_that_outlasts_its_wall_clock_is_refused_in_words() {
        let server = httpmock::MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/s/abc");
                then.status(200)
                    .delay(Duration::from_secs(10))
                    .body(shell("/s/abc/h.json.gz"));
            })
            .await;
        let limits = Limits {
            total: Duration::from_millis(300),
            ..over_loopback()
        };

        let started = std::time::Instant::now();
        let refused = open_within(&server.url("/s/abc"), limits)
            .await
            .unwrap_err();
        assert_eq!(refused.sentence, OPEN_TIMED_OUT);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the open took {:?}, so something other than its own clock ended it",
            started.elapsed()
        );
        assert_eq!(refused.note.map(|n| n.kind), Some(Kind::Timeout));
    }

    /// **The shipped bounds refuse plain HTTP, and before any request** — asked through [`open`]
    /// itself rather than of the constant, so the test is about what the command does.
    #[tokio::test]
    async fn the_shipped_viewer_refuses_plain_http_before_any_request() {
        let server = httpmock::MockServer::start_async().await;
        let page = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET);
                then.status(200).body(shell("/s/abc/h.json.gz"));
            })
            .await;

        let refused = open(&server.url("/s/abc")).await.unwrap_err();
        assert_eq!(refused.sentence, NOT_A_LINK);
        assert!(refused.note.is_none(), "a paste is a state, not a failure");
        assert_eq!(page.calls_async().await, 0);
    }

    /// **Which refusals owe a row, and that the row is the one the old path wrote.** A 404 and a
    /// 410 are states a reader produces by pasting and write nothing; a 500 is a failure, and its
    /// note lands in `error_log` as `share_open` under `relay` — written here by hand, where the
    /// command writes it after the open has answered.
    #[tokio::test]
    async fn a_state_the_reader_can_paste_owes_no_row_and_a_failure_owes_one() {
        let server = httpmock::MockServer::start_async().await;
        for (path, status) in [("/s/nope", 404), ("/s/gone", 410)] {
            server
                .mock_async(|when, then| {
                    when.method(httpmock::Method::GET).path(path);
                    then.status(status).body("<html>not here</html>");
                })
                .await;
        }
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/s/broken");
                then.status(500)
                    .body(r#"{"error":"the share service fell over"}"#);
            })
            .await;

        let missing = open_within(&server.url("/s/nope"), over_loopback())
            .await
            .unwrap_err();
        assert_eq!(missing.sentence, NO_SUCH_SHARE);
        assert!(missing.note.is_none());
        let gone = open_within(&server.url("/s/gone"), over_loopback())
            .await
            .unwrap_err();
        assert_eq!(gone.sentence, SHARE_IS_GONE);
        assert!(gone.note.is_none());

        let broken = open_within(&server.url("/s/broken"), over_loopback())
            .await
            .unwrap_err();
        assert_eq!(broken.sentence, "the share service fell over");
        let conn = open_db();
        broken.note.expect("a 500 is a failure").record(&conn);
        let (source, operation, detail): (String, String, String) = conn
            .query_row("SELECT source, operation, detail FROM error_log", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(
            (source.as_str(), operation.as_str()),
            ("relay", "share_open")
        );
        assert_eq!(detail, server.url("/s/broken"));
    }
}
