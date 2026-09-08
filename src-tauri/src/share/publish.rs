//! The upload: the two-step that makes a failed publish harmless, and the four requests behind
//! the five commands.
//!
//! **`cfg(not(target_family = "wasm"))` on the whole module**, unlike [`super::snapshot`] and
//! [`super::cache`], because this is the half that reaches the network. Publishing from the
//! browser build is out of scope for v1 — see [`crate::web::route`]'s `share_list` entry.
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

use super::cache;
use super::commands::ShareRow;
use super::{gzip, snapshot, ShareFields};
use crate::errors::{self, Kind, Source};
use crate::sync_engine::{client, entitlement};
use crate::sync_pair::identity::{self, Group};
use rusqlite::Connection;
use serde::Deserialize;

/// The share Worker's address.
///
/// ⚠️ **A placeholder, and deliberately one that cannot be mistaken for an address.** Only a
/// deploy can produce the real host, and it must then be written **here** and into
/// `share-worker/wrangler.jsonc`'s `SHARE_BASE` var **byte for byte** — the trap
/// `relay/wrangler.jsonc` documents for `RELAY_BASE` and the OAuth redirect URI. That file
/// carries the same placeholder and the same warning; the two are one value in two languages.
///
/// **Inventing a plausible URL is the mistake this constant exists to refuse.** A guessed host
/// gets copied into documentation and deployed against, which is what the `database_id` comment
/// in the relay's config records happening. An obvious hole does not.
///
/// [`entitlement::RELAY_BASE`] is the sibling of this constant and is real, because that Worker
/// is deployed: `https://mtg-grimoire-relay.denmark-east.workers.dev`. Both are public on the
/// same terms — an API base is on the wire of every request that uses it and ships inside the
/// binary whatever this tree says. Spec §14 open item 5.
pub const SHARE_BASE: &str = "<set on first deploy>";

/// The `sync_state` key holding an override for [`SHARE_BASE`] — a test/dev knob with no UI,
/// exactly as [`client::RELAY_URL`] is for the relay.
///
/// **It is the only way to exercise this file before the first deploy**, which is what makes it
/// worth its ten lines rather than dead weight: until [`SHARE_BASE`] is real, every request here
/// goes to a string that is not a URL.
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
/// ⚠️ **[`SHARE_BASE`] is a placeholder, and a placeholder is not a URL.** [`base`]'s own doc
/// already refuses this shape for a *blank* override — "reading it as a base would build the
/// relative URL `/g/…` and fail with a message about nothing the reader did" — and
/// `<set on first deploy>` does exactly that while being the **default**. Without this guard a
/// connected reader pressing *Share* meets `builder error: relative URL without a base`, which
/// is reqwest's sentence about a mistake nobody made, and every list press folds an `error_log`
/// row under `Source::Relay` for it.
///
/// **The test is the scheme rather than an equality against the constant**, and the difference
/// matters on the day of the deploy: `base == SHARE_BASE` would refuse every request the moment
/// that constant became a real host, because no override is the ordinary case. A mistyped
/// override lands here too, which is the same improvement one step further.
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

/// [`SHARE_BASE`] is still its placeholder and no override names a host, so there is nowhere to
/// publish to. **Refused before any request and before any `error_log` row**, because a build
/// with no address for the service is a state rather than a failure — nothing went wrong, and a
/// row in the Errors panel would send the reader to look at a network that is fine.
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
/// suite this one does not have, so there is nothing here for a per-test client to fix.
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
async fn credentials(conn: &Connection) -> Result<(String, Group), String> {
    let Some(token) = entitlement::access_token(conn).await? else {
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
    let (token, group) = credentials(conn).await?;
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
pub async fn refresh(conn: &Connection, id: &str) -> Result<ShareRow, String> {
    let Some(known) = cache::get(conn, id)? else {
        return Err(UNKNOWN_SHARE.to_owned());
    };
    let fields = fields_from_names(&known.fields);
    publish(conn, known.folder_uid.as_deref(), &known.owner_name, fields).await
}

/// Withdraw one share. Terminal, and the reader's own press.
///
/// **The local row moves only after the relay has taken it**, which is [`commit_publish`]'s rule
/// applied to the other direction: a withdrawal this device believes in and the relay does not
/// is a link the reader thinks is dead.
pub async fn revoke(conn: &Connection, id: &str) -> Result<(), String> {
    endpoint(conn)?;
    let (token, group) = credentials(conn).await?;
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
pub async fn list(conn: &Connection) -> Result<Vec<ShareRow>, String> {
    // **Asked before the token and never as a refusal.** `endpoint` is the only thing here that
    // can say "there is nowhere to ask", and on a build with no host that has to stop the
    // `/token` round trip `access_token` would otherwise make on every press of this list.
    if endpoint(conn).is_ok() {
        // Not [`credentials`], because an unconnected device must not read this as a refusal: it
        // has a perfectly good empty list, and `NOT_CONNECTED` belongs on a press to publish.
        let token = entitlement::access_token(conn).await.ok().flatten();
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

/// The absolute URL of a snapshot, given the page it was named on.
///
/// The shell writes `/s/{id}/{hash}.json.gz`, so this is an origin join and not a URL library:
/// anything that is not already absolute and does not start at the root is not a link this
/// Worker writes, and is refused rather than guessed at.
pub fn resolve(page: &str, href: &str) -> Option<String> {
    if href.starts_with("https://") || href.starts_with("http://") {
        return Some(href.to_owned());
    }
    if !href.starts_with('/') {
        return None;
    }
    let after_scheme = page.find("://")? + 3;
    let end = page[after_scheme..]
        .find('/')
        .map_or(page.len(), |i| after_scheme + i);
    Some(format!("{}{href}", &page[..end]))
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
pub async fn open(conn: &Connection, url: &str) -> Result<serde_json::Value, String> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(NOT_A_LINK.to_owned());
    }
    let (status, page) = send(conn, "share_open", url, http().get(url)).await?;
    match status {
        404 => return Err(NO_SUCH_SHARE.to_owned()),
        410 => return Err(SHARE_IS_GONE.to_owned()),
        s if !(200..300).contains(&s) => {
            let message = refusal(s, &page, "a shared collection");
            note(conn, "share_open", Kind::Http, &message, Some(url));
            return Err(message);
        }
        _ => {}
    }
    let Some(href) = snapshot_href(&page) else {
        return Err(SHARE_NOT_READY.to_owned());
    };
    let Some(blob) = resolve(url, href) else {
        return Err(NOT_A_LINK.to_owned());
    };

    // **Not [`send`], because the body is bytes rather than text.** A gzip read through
    // `response.text()` would be lossily decoded as UTF-8 before it ever reached the decoder.
    let response = match http().get(&blob).send().await {
        Ok(r) => r,
        Err(e) => {
            note(conn, "share_open", kind_of(&e), &e.to_string(), Some(&blob));
            return Err(e.to_string());
        }
    };
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let message = refusal(status, "", "a snapshot");
        note(conn, "share_open", Kind::Http, &message, Some(&blob));
        return Err(message);
    }
    // ⚠️ **Decompressed here rather than by `reqwest`.** This crate builds reqwest with
    // `default-features = false` and no `gzip` feature, so the `content-encoding: gzip` the
    // Worker sets is passed through untouched and the body arrives as the bytes R2 holds.
    let bytes = match response.bytes().await {
        Ok(b) => b,
        Err(e) => {
            note(conn, "share_open", kind_of(&e), &e.to_string(), Some(&blob));
            return Err(e.to_string());
        }
    };
    parse_snapshot(&bytes)
}

/// Gunzip and parse, with the one check this side is entitled to make.
///
/// **An object, and nothing further.** Whether `v` is a version this app can draw is
/// TypeScript's question (see [`open`]); whether the bytes are a JSON document at all is not,
/// because the alternative is handing the page a number or a string where it expects a binder.
fn parse_snapshot(bytes: &[u8]) -> Result<serde_json::Value, String> {
    use std::io::Read;
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_string(&mut text)
        .map_err(|e| format!("that shared collection could not be read: {e}"))?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("that shared collection could not be read: {e}"))?;
    if !value.is_object() {
        return Err("that shared collection could not be read: it is not a snapshot".to_owned());
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

    #[test]
    fn a_root_relative_snapshot_resolves_against_the_pages_origin() {
        assert_eq!(
            resolve(
                "https://share.example/s/kQ2p7fMx9Lb0RtVw",
                "/s/kQ2p/abc.json.gz"
            ),
            Some("https://share.example/s/kQ2p/abc.json.gz".to_owned())
        );
    }

    #[test]
    fn an_absolute_snapshot_url_is_taken_as_it_stands() {
        assert_eq!(
            resolve("https://share.example/s/x", "https://cdn.example/a.json.gz"),
            Some("https://cdn.example/a.json.gz".to_owned())
        );
    }

    /// Anything that is neither is not a link this Worker writes.
    #[test]
    fn a_bare_relative_snapshot_is_refused_rather_than_guessed_at() {
        assert_eq!(resolve("https://share.example/s/x", "abc.json.gz"), None);
    }

    #[test]
    fn a_gzipped_snapshot_round_trips_back_to_its_document() {
        let bytes = gzip(br#"{"v":1,"cards":[]}"#).unwrap();
        let value = parse_snapshot(&bytes).unwrap();
        assert_eq!(value["v"], 1);
    }

    /// A snapshot that is JSON but not a document is refused here, because the alternative is
    /// handing the page a number where it expects a binder.
    #[test]
    fn a_snapshot_that_is_not_an_object_is_refused() {
        let bytes = gzip(b"[1,2,3]").unwrap();
        assert!(parse_snapshot(&bytes).is_err());
    }

    #[test]
    fn a_body_that_is_not_gzip_is_a_sentence_rather_than_a_panic() {
        assert!(parse_snapshot(b"not gzip at all").is_err());
    }

    /// The base is the compiled-in placeholder until a `sync_state` row overrides it, and a
    /// blank row is not an override — `entitlement::base`'s rule, and for its reason.
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
        let err = publish(&conn, Some(&uid), "Giradeli", ShareFields::default())
            .await
            .unwrap_err();
        assert_eq!(err, super::super::FOLDER_IS_LOCKED);
    }

    /// One rung down: the folder is fine, so the next thing that can be wrong is that this build
    /// has nowhere to publish to. **Ahead of the token**, because minting a grant for a press
    /// with no destination is a round trip spent on nothing.
    #[tokio::test]
    async fn a_build_with_no_host_refuses_in_words_rather_than_in_reqwests() {
        let conn = open_db();
        let uid = folder(&conn, "Binder", false);
        let err = publish(&conn, Some(&uid), "Giradeli", ShareFields::default())
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
        let err = publish(&conn, Some(&uid), "Giradeli", ShareFields::default())
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
        let err = publish(&conn, Some(&uid), "   ", ShareFields::default())
            .await
            .unwrap_err();
        assert_eq!(err, OWNER_NAME_REQUIRED);
    }

    /// A list on a build with no host is the cache, silently — no request, no `error_log` row,
    /// and no refusal for a reader who has simply never shared anything.
    #[tokio::test]
    async fn a_list_on_a_build_with_no_host_is_the_cache_and_says_nothing() {
        let conn = open_db();
        cache::store(&conn, &row("kQ2p7fMx9Lb0RtVw")).unwrap();
        let rows = list(&conn).await.unwrap();
        assert_eq!(rows.len(), 1);
        let logged: i64 = conn
            .query_row("SELECT count(*) FROM error_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(logged, 0, "nothing went wrong, so nothing is a failure");
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

    /// ⚠️ The one thing about [`SHARE_BASE`] a build can check: it is still the placeholder, and
    /// `share-worker/wrangler.jsonc` still carries the same one. The day either becomes a host,
    /// both do — and this test is what asks the person changing one whether they changed both.
    #[test]
    fn the_share_base_matches_the_workers_own_placeholder() {
        let wrangler = include_str!("../../../share-worker/wrangler.jsonc");
        assert!(
            wrangler.contains(&format!("\"SHARE_BASE\": \"{SHARE_BASE}\"")),
            "share::SHARE_BASE and share-worker/wrangler.jsonc's SHARE_BASE must be the same \
             string, byte for byte"
        );
    }
}
