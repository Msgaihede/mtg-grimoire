//! The upload: the two-step that makes a failed publish harmless, the four requests behind the
//! share commands, and [`refresh_live`], the publish round's half that keeps every live share of
//! the group current.
//!
//! **Here and not in the desktop host since PR 2 of issue #1396**, so the phone and the web host
//! refresh a share too: a change made on the phone used to reach a share only once the desktop
//! was on. The viewer — opening a stranger's link — stayed the desktop's (`share_open`), because
//! it talks to whatever host the link names and keeps rules of its own that this file has no use
//! for.
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
//! by hand** (`serde_json::to_string` plus an explicit `content-type`), which is all
//! [`crate::platform::http::Request`] takes; the bearer as
//! `.header("authorization", &format!("Bearer {token}"))`; and every failure becoming an
//! `Err(String)` *and* an `error_log` row first.
//!
//! **The viewer keeps none of the first and not the last** (issue #545): it builds its own client
//! per open with a same-origin redirect policy, holds no connection, and hands its `error_log`
//! row back for the command to write afterwards. That is the desktop's `share::publish::open`,
//! and nothing here is shared with it but [`refusal`] and [`MAX_BLOB_BYTES`].

use super::cache::{self, ShareRow};
use super::{gzip, snapshot, ShareFields};
use crate::errors::{self, Kind, Source};
use crate::integration::readable::{self, Unknown};
use crate::platform::{http, timer};
use crate::sorting::Marketplace;
use crate::state::Store;
use crate::sync_engine::{client, entitlement};
use crate::sync_pair::identity::{self, Group};
use rusqlite::Connection;
use serde::Deserialize;
use std::time::Duration;

/// The share Worker's address.
///
/// **`share.mtg-grimoire.app` since 2026-10-11**: a Custom Domain of the Worker
/// `mtg-grimoire-share`, on the zone whose apex is the web app's origin
/// (`infrastructure/share-worker/wrangler.jsonc`, `routes`). Every release through 0.44.0 was
/// compiled with the Worker's `workers.dev` address,
/// `https://mtg-grimoire-share.denmark-east.workers.dev`, **which still answers and is meant to,
/// indefinitely**: such a build publishes there and is handed a link at this address, and a link
/// minted before the move still opens where it points. Nothing on this side checks a link's host.
///
/// **Real since the Worker's first deploy on 2026-10-01**, at that `workers.dev` address — read
/// back from the deploy and probed rather than guessed. Until that day it was the placeholder
/// `<set on first deploy>`, deliberately a string that could not be mistaken for an address: a
/// guessed host gets copied into documentation and deployed against, which is what the
/// `database_id` comment in the relay's config records happening.
///
/// ⚠️ **It must equal `infrastructure/share-worker/wrangler.jsonc`'s `SHARE_BASE` var byte for byte** — the
/// trap `infrastructure/relay/wrangler.jsonc` documents for `RELAY_BASE` and the OAuth redirect URI. The two
/// are one value in two languages: the Worker builds every link from its copy and this side
/// sends every request to its own, so a mismatch is a link that resolves to nothing rather than
/// an error anybody sees. `the_share_base_is_the_workers_own` reads that file and compares.
///
/// [`entitlement::RELAY_BASE`] is the sibling of this constant. Both are public on the same
/// terms — an API base is on the wire of every request that uses it and ships inside the binary
/// whatever this tree says. Spec §14 open item 5.
pub const SHARE_BASE: &str = "https://share.mtg-grimoire.app";

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
/// `marketplace_feed`, `combos` and [`client`] already follow. **The viewer must never borrow
/// this one**: it follows the default redirects to any host, which is exactly the proxy the
/// desktop's `open` exists to refuse.
///
/// **Split into an app arm and a test arm for [`client`]'s reason**: one static client,
/// `httpmock`'s pooled ports, and a runtime per `#[tokio::test]`.
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

/// The one place this client's shape is written down.
///
/// **A read bound longer than the relay's 30 s**, because this is the one request in the app that
/// can carry eight megabytes: the bound is per chunk, but a snapshot uploaded over a slow uplink
/// spends the whole of it waiting for the far side's first byte after the body has gone.
///
/// **And a deadline, where the host has no socket to bound** — a browser, whose `fetch` has no
/// connect phase and no read timeout ([`crate::platform::http::Client::deadline`]). The publish
/// round holds the sync lane across these requests, as the sync client's trips do, so a request
/// that never ended would be every later trip queued behind it. [`SHARE_DEADLINE`] has the
/// number.
fn build_http() -> http::Client {
    http::Client::new(&http::Config {
        user_agent: crate::scryfall::USER_AGENT,
        connect_timeout: Some(Duration::from_secs(10)),
        read_timeout: Some(Duration::from_secs(60)),
    })
    .deadline(SHARE_DEADLINE)
}

/// **The whole of one request, in a browser: five minutes.** Natively it is not applied — the
/// connect and read bounds already end a request that stops answering.
///
/// Sized for the largest body this file sends, a gzip at the Worker's own cap
/// ([`MAX_BLOB_BYTES`]): eight megabytes in three hundred seconds is about 28 KB/s, the floor of
/// a weak phone uplink, and every other request here is a small JSON body each way that answers
/// in a second. `scanner_submit`'s client carries a run of frames of the same order of size and
/// gives it five and a half minutes, for the same reason.
const SHARE_DEADLINE: Duration = Duration::from_secs(300);

/// Classify a transport failure, so every call site here agrees about what it was.
/// [`client`]'s `kind_of`, which is private to that module — and like it, no `Http` arm: a
/// status is read off the response and recorded as `Kind::Http` where it is.
fn kind_of(err: &http::Error) -> Kind {
    if err.is_timeout() {
        Kind::Timeout
    } else if err.is_decode() {
        Kind::Parse
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

/// [`note`] in a stretch of its own, for a failure met between two — a request that did not
/// answer, or answered something that is not an answer. Like the row itself it can never fail the
/// thing it describes.
fn note_in(db: &impl Store, operation: &str, kind: Kind, message: &str, url: Option<&str>) {
    let _ = db.with(|conn| {
        note(conn, operation, kind, message, url);
        Ok(())
    });
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
/// **`db` is the lane, and the token is minted through it** — a token is the sync client's to
/// mint, and it writes the grant a trip or a claim in flight is writing too.
async fn credentials(db: &impl Store) -> Result<(String, Group), String> {
    let Some(token) = entitlement::access_token(db).await? else {
        return Err(NOT_CONNECTED.to_owned());
    };
    // The gate compares the token's `grp` claim against the path, so a token with no group to
    // put in the path is a request that could only ever be refused.
    let Some(group) = db.with(|conn| identity::group(conn).map_err(|e| e.to_string()))? else {
        return Err(NOT_CONNECTED.to_owned());
    };
    Ok((token, group))
}

/// The status and body of one gated request, or an `Err` that has already been recorded.
///
/// **Made with nothing held** — the connection is taken only to write the row a failure owes.
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
/// **The nine fields [`ShareRow`] carries, and the marketplace the share was published under.**
/// The Worker also answers `cardCount`, `totalValue`, `currency`, `bytes` and `createdAt`;
/// caching those would be a second record of numbers the relay recomputes on every publish, and
/// the cache's whole job is a badge and a link that survive being offline.
///
/// **`marketplace` is read and never cached**: the publish round republishes a share in it
/// ([`refresh_live`]), because the marketplace is a device's setting, and a share republished by
/// a device set to another would have its prices and its digest flip with whichever device synced
/// last. Absent from an older Worker's answer, which is read as TCGplayer on every device —
/// never as each device's own, which would be the flip again.
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
    #[serde(default)]
    marketplace: Option<String>,
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
    db: &impl Store,
    base: &str,
    token: &str,
    group: &Group,
    body: String,
) -> Result<Created, String> {
    let url = format!("{base}/g/{}/share", group.group_id);
    let (status, text) = send(
        db,
        "share_create",
        &url,
        http()
            .post(&url)
            .header("content-type", "application/json")
            .header("authorization", &format!("Bearer {token}"))
            .body(body),
    )
    .await?;
    if !(200..300).contains(&status) {
        let message = refusal(status, &text, "a publish");
        note_in(db, "share_create", Kind::Http, &message, Some(&url));
        return Err(message);
    }
    serde_json::from_str(&text).map_err(|e| {
        note_in(db, "share_create", Kind::Parse, &e.to_string(), Some(&url));
        e.to_string()
    })
}

/// Step 3: the gzip.
async fn put_blob(
    db: &impl Store,
    base: &str,
    token: &str,
    group: &Group,
    id: &str,
    bytes: Vec<u8>,
) -> Result<Uploaded, String> {
    let url = format!("{base}/g/{}/share/{id}", group.group_id);
    let (status, text) = send(
        db,
        "share_upload",
        &url,
        http()
            .put(&url)
            // **`application/gzip` and not `content-encoding: gzip`.** The bytes *are* the
            // document as far as this request is concerned; declaring an encoding would invite
            // an intermediary to helpfully decode it, and the Worker checks the two magic bytes.
            .header("content-type", "application/gzip")
            .header("authorization", &format!("Bearer {token}"))
            .bytes(bytes),
    )
    .await?;
    if !(200..300).contains(&status) {
        let message = refusal(status, &text, "an upload");
        note_in(db, "share_upload", Kind::Http, &message, Some(&url));
        return Err(message);
    }
    serde_json::from_str(&text).map_err(|e| {
        note_in(db, "share_upload", Kind::Parse, &e.to_string(), Some(&url));
        e.to_string()
    })
}

/// `GET /g/{group}/shares` — the roster, as [`ShareRow`]s ready for [`cache::reconcile`], each
/// beside the marketplace the Worker says it was published under (see [`Listed`]).
async fn get_shares(
    db: &impl Store,
    base: &str,
    token: &str,
    group: &Group,
) -> Result<Vec<(ShareRow, Option<Marketplace>)>, String> {
    let url = format!("{base}/g/{}/shares", group.group_id);
    let (status, text) = send(
        db,
        "share_list",
        &url,
        http()
            .get(&url)
            .header("authorization", &format!("Bearer {token}")),
    )
    .await?;
    if !(200..300).contains(&status) {
        let message = refusal(status, &text, "a share list");
        note_in(db, "share_list", Kind::Http, &message, Some(&url));
        return Err(message);
    }
    let listing: Listing = serde_json::from_str(&text).map_err(|e| {
        note_in(db, "share_list", Kind::Parse, &e.to_string(), Some(&url));
        e.to_string()
    })?;
    Ok(listing
        .shares
        .into_iter()
        .map(|mut row| {
            let market = row.marketplace.take().as_deref().map(Marketplace::from_id);
            (ShareRow::from(row), market)
        })
        .collect())
}

/// `DELETE /g/{group}/share/{id}`.
///
/// **A 404 is success**, and that is not laxity: the Worker answers it for a share this group
/// does not have, which is the state the press asked for. Refusing would leave a row in this
/// cache that no relay will ever confirm and no press can ever remove.
async fn delete_share(
    db: &impl Store,
    base: &str,
    token: &str,
    group: &Group,
    id: &str,
) -> Result<(), String> {
    let url = format!("{base}/g/{}/share/{id}", group.group_id);
    let (status, text) = send(
        db,
        "share_revoke",
        &url,
        http()
            .delete(&url)
            .header("authorization", &format!("Bearer {token}")),
    )
    .await?;
    if status == 404 || (200..300).contains(&status) {
        return Ok(());
    }
    let message = refusal(status, &text, "a withdrawal");
    note_in(db, "share_revoke", Kind::Http, &message, Some(&url));
    Err(message)
}

// ---------------------------------------------------------------------------------------
// The publish
// ---------------------------------------------------------------------------------------

/// The metadata body, built from the document that is about to be uploaded.
///
/// A deck share also sends its `format`, a preview `image` and, for a cover crop, its
/// `imageArtist` (issue #1032) — what the Worker's OpenGraph card shows for a deck; all three are
/// `null` for a binder and a wishlist.
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
        // A deck share's link preview (issue #1032): its format for the card's description and a
        // picture of the deck for `og:image`. `null` on every other kind — a binder's preview
        // stays text, as it always was.
        "format": snap.deck.as_ref().map(|deck| deck.format.as_str()).filter(|f| !f.is_empty()),
        "image": super::deck::preview(snap).map(|(img, _)| img),
        // The illustrator, when the picture is the deck's cover crop — the Worker puts the credit
        // in the card's text, because a crop with no frame is shown only beside it.
        "imageArtist": super::deck::preview(snap).and_then(|(_, artist)| artist),
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
/// snapshot is read **before** the first request: the refusals a locked or missing folder earns
/// are [`super::snapshot`]'s, and a folder about to be refused must never have left a row on the
/// relay. Any kind of folder may be named since issue #941, and a wishlist key too.
///
/// ⚠️ **`db` is the sync lane, and the connection is held for two stretches and never across a
/// request** (issue #1145): the read, and the commit. A publish is three round trips — the token,
/// the metadata and up to [`MAX_BLOB_BYTES`] of gzip — and until 2026-10-20 it ran with the write
/// connection in hand for all three, so a slow uplink was every edit in the app waiting out
/// [`crate::db::WRITE_LOCK_WAIT`] and answering [`crate::db::BUSY`] — on a timer, through
/// the desktop's five-minute share pass (retired by issue #1396), exactly while the reader was
/// editing the folder.
///
/// **What can land between the two stretches is a reader's own write**, and it is harmless: the
/// upload is the read's document, and so is the digest the commit stores, so a folder edited
/// mid-upload reads as stale on the next [`refresh_live`] and goes up again. The read is a
/// [`Store::reading`] stretch — the read connection where the host has one — and only the commit
/// takes the writer.
///
/// **Priced at this device's marketplace**, which then becomes the share's: a press is the reader
/// choosing, here, what the page shows. The publish round republishes in the share's own
/// ([`refresh_live`]).
pub async fn publish(
    db: &impl Store,
    folder_uid: Option<&str>,
    owner_name: &str,
    fields: ShareFields,
) -> Result<ShareRow, String> {
    publish_at(db, folder_uid, owner_name, fields, None).await
}

/// [`publish`], priced at `market` — or at this device's marketplace for `None`.
async fn publish_at(
    db: &impl Store,
    folder_uid: Option<&str>,
    owner_name: &str,
    fields: ShareFields,
    market: Option<Marketplace>,
) -> Result<ShareRow, String> {
    let owner_name = owner_name.trim();
    if owner_name.is_empty() {
        return Err(OWNER_NAME_REQUIRED.to_owned());
    }
    let (at, mut snap, base) = db.reading(|conn| {
        let at = now(conn)?;
        let marketplace =
            market.unwrap_or_else(|| Marketplace::from_id(&crate::marketplace::stored(conn)));
        // The id is stamped in once the relay has minted it — see the module header for why the
        // read cannot wait for it.
        let snap = snapshot(conn, "", owner_name, folder_uid, fields, marketplace, at)?;
        // **Below the read and above the token, and both halves of that placement are
        // decisions.** Below, because a refusal about *this folder* — locked or missing — is the
        // more actionable of the two, and the read that produces it is local and free. Above,
        // because `credentials` posts to the relay's `/token`, and minting a grant for a press
        // that has nowhere to send it is a round trip spent on nothing.
        let base = endpoint(conn)?;
        Ok((at, snap, base))
    })?;

    let (token, group) = credentials(db).await?;
    let created = post_meta(
        db,
        &base,
        &token,
        &group,
        meta_body(folder_uid, owner_name, &snap)?,
    )
    .await?;

    let digest = digest(&snap)?;
    snap.id = created.id.clone();
    let json = serde_json::to_vec(&snap).map_err(|e| e.to_string())?;
    let uploaded = put_blob(db, &base, &token, &group, &created.id, gzip(&json)?)
        .await
        .map(|_| ());

    let row = ShareRow {
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
    };
    db.with(|conn| {
        let row = commit_publish(conn, &row, uploaded)?;
        // **Best effort, and after the commit.** A digest that did not stick costs the next
        // [`refresh_live`] one republish of a document that had not moved, which is the cheap
        // direction to be wrong in; failing a publish that landed over it would be the dear one.
        let _ = crate::app_meta::set_app_meta(conn, &digest_key(&row.id), &digest);
        Ok(row)
    })
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
pub async fn refresh(db: &impl Store, id: &str) -> Result<ShareRow, String> {
    let Some(known) = db.with(|conn| cache::get(conn, id))? else {
        return Err(UNKNOWN_SHARE.to_owned());
    };
    let fields = fields_from_names(&known.fields);
    publish(db, known.folder_uid.as_deref(), &known.owner_name, fields).await
}

// ---------------------------------------------------------------------------------------
// Keeping a share current (issue #1025; on the publish round since issue #1396)
// ---------------------------------------------------------------------------------------

/// The `app_meta` key holding the digest of the last snapshot this device uploaded for `id`.
///
/// **`app_meta` rather than a column of `collection_shares`**, because the digest is this
/// device's private bookkeeping about its own uploads — never synced, never drawn, and
/// worthless to any other device — and losing it costs exactly one republish. A schema rung for
/// a cache of a cache is not worth what a rung costs.
fn digest_key(id: &str) -> String {
    format!("share_digest:{id}")
}

/// What a snapshot *says*, as a hex SHA-256 — **without** its `id` and `updatedAt`.
///
/// Those two are the only fields that differ between two publishes of an unchanged folder: the
/// id is stamped after the read and the clock moves on every call. Everything else is a fact
/// about the reader's cards, folders, prices or the switches they ticked, and a change to any of
/// it is a change a viewer should see.
pub fn digest(snap: &super::ShareSnapshot) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let body = serde_json::to_vec(&(
        snap.v,
        &snap.title,
        &snap.owner,
        &snap.marketplace,
        &snap.currency,
        &snap.fields,
        &snap.folders,
        &snap.cards,
    ))
    .map_err(|e| e.to_string())?;
    // A deck's half — its piles' switches and its cover — is a change a viewer sees too (issue
    // #1032). **Appended only when present**, so a binder's digest is the one it always was and
    // no share published before decks republishes itself on the first pass after an upgrade.
    let mut body = body;
    if let Some(deck) = &snap.deck {
        body.extend(serde_json::to_vec(deck).map_err(|e| e.to_string())?);
    }
    Ok(Sha256::digest(&body)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Whether `known` no longer reads as the snapshot this device last uploaded for it, or `None`
/// when the read refuses it — a locked folder, one since deleted, a deck this device has not
/// synced yet. The question [`refresh_live`] asks of every live share.
///
/// **Local and free, and that is the whole design**: a read of the reader's own database and a
/// hash, with no token and no request, so a round that finds nothing moved spends not one request
/// of the account's shared Worker budget on a folder. Only a share that *has* changed costs the
/// two requests a publish always costs. (It was the desktop's five-minute pass, `changed`, until
/// issue #1396 moved the question onto the publish round on every host.)
///
/// **No stored digest is stale**: a share this device never uploaded, or one published before
/// digests were kept, goes up once and is then quiet until something changes.
///
/// **And whether this device can read it whole** (`crate::integration::readable`): its cards that
/// name a printing this device's `cards` lacks, orphaned or unseen, and whether it reads prices —
/// so whether it is this device's to publish at a feed-priced marketplace only with a current
/// feed. A collection or deck share reads prices when `value` is carried; **a wishlist share always
/// does**, because an any-printing wish is drawn as its cheapest printing at the marketplace.
fn stale(
    conn: &Connection,
    known: &ShareRow,
    marketplace: Marketplace,
) -> Result<Option<Staleness>, String> {
    let fields = fields_from_names(&known.fields);
    let Ok((snap, unknown)) = super::snapshot::counted(
        conn,
        "",
        &known.owner_name,
        known.folder_uid.as_deref(),
        fields,
        marketplace,
        0,
    ) else {
        return Ok(None);
    };
    let wishes = known
        .folder_uid
        .as_deref()
        .is_some_and(|key| super::wishlist::WishlistKey::parse(key).is_some());
    let stored = crate::app_meta::get_app_meta(conn, &digest_key(&known.id));
    Ok(Some(Staleness {
        stale: stored.as_deref() != Some(digest(&snap)?.as_str()),
        unknown,
        priced: wishes || fields.value,
        prices_readable: readable::feed_current(conn, marketplace),
    }))
}

/// What [`stale`] found of one share.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Staleness {
    /// It no longer reads as this device's last upload of it.
    stale: bool,
    /// Its cards whose printing this device's `cards` lacks.
    unknown: Unknown,
    /// It reads prices: `value` carried, or a wishlist's.
    priced: bool,
    /// This device can read its marketplace's prices as the group's other devices do —
    /// `readable::feed_current`.
    prices_readable: bool,
}

impl Staleness {
    /// Whether the round republishes it: stale, and **readable here** — no card newer than this
    /// device's card data, a card it lacks only from a corpus current enough that the card has left
    /// Scryfall (`corpus_current`, the round's to say), and its prices, if it reads any, from a
    /// current feed.
    fn due(self, corpus_current: bool) -> bool {
        self.stale
            && self.unknown.publishable(corpus_current)
            && (!self.priced || self.prices_readable)
    }
}

// ---------------------------------------------------------------------------------------
// The publish round's share half (issue #1396)
// ---------------------------------------------------------------------------------------

/// Republish every `live` share of the group whose snapshot no longer reads as this device's last
/// upload of it, and answer the rows that went up — `[]` for the ordinary round where nothing
/// moved.
///
/// **Any device refreshes any live share** (spec §7.5), which is the one rule the desktop's retired
/// five-minute pass did not keep: it passed over a share this device never published, so a change
/// made on the phone reached a share only once the desktop that published it was on. Here the
/// phone republishes it,
/// under the owner name and the fields the share already carries — the row's, never this
/// device's. Each device compares against **its own** last upload (`share_digest:{id}`), so two
/// devices holding the same cards do not take turns republishing one link; a device that has never
/// uploaded a share goes up with it once.
///
/// **The roster first, from the Worker, and the cache never in its place.** A share withdrawn on
/// another device can still be `live` in this device's cache, and republishing its folder would
/// mint it a new link the reader withdrew — so a list that does not answer ends the round, where
/// [`list`] would fall back to the cache.
///
/// **Nothing to do is not a failure**: a build with no address for the service, a device with no
/// membership in its group and a device in no group each answer `[]` with no request and no row.
/// A share the read refuses (a locked folder, a deleted one) is passed over: a press would earn
/// the same sentence, the menu already says *Stale* for the first, and nothing should retry it on
/// every round.
///
/// **One share's failure does not stop the others**, and it is not this function's error: the
/// publish has written its `error_log` row, the previous snapshot is still serving, and the digest
/// is still the old one, so the next round tries it again. **Every `Err` this does answer has
/// already written its row** — the list's own, the token's, or a stretch's here
/// (`share_refresh`) — so a caller records nothing more.
///
/// **In the marketplace the share was published under** (the roster's `marketplace`, [`Listed`]),
/// never this device's: the marketplace is a device's setting, and a share republished by whichever
/// device synced last would flip its prices, and every device's digest of it, back and forth. A
/// roster row that names none is TCGplayer, the same on every device. A press ([`publish`],
/// [`refresh`]) prices at this device's, which then becomes the share's.
///
/// **And only what this device can read whole** (issue #1396's review,
/// `crate::integration::readable`): a share holding a card newer than this device's card data is
/// passed over; one holding a card that has left Scryfall goes up only when `corpus_current` — the
/// round's answer to whether this device's card data is recent enough to tell the two apart; and
/// one that reads prices at Card Kingdom or Mana Pool goes up only while this device's feed for
/// that marketplace is current. A phone that paired before its card download, one with yesterday's
/// corpus and today's preview card, or one set to TCGplayer republishing a Mana Pool binder, would
/// otherwise publish ids for names, no pictures or no prices over a good snapshot — and the device
/// that published it whole would never put it right, because its own digest still matches.
///
/// **The writer only for the reconcile**: each share's snapshot is read on the read connection
/// where the host has one, one share a stretch, with a turn for the host between two — so a host
/// with one thread answers its page between shares rather than after all of them.
///
/// `db` is the sync lane, held for stretches and never across a request, as for [`publish`].
pub async fn refresh_live(db: &impl Store, corpus_current: bool) -> Result<Vec<ShareRow>, String> {
    let Ok(base) = db.with(endpoint) else {
        return Ok(Vec::new());
    };
    let token = match entitlement::access_token(db).await {
        Ok(Some(token)) => token,
        Ok(None) => return Ok(Vec::new()),
        Err(e) => {
            note_in(db, "share_refresh", Kind::Other, &e, None);
            return Err(e);
        }
    };
    let group = logged(
        db,
        db.with(|conn| identity::group(conn).map_err(|e| e.to_string())),
    )?;
    let Some(group) = group else {
        return Ok(Vec::new());
    };
    let remote = get_shares(db, &base, &token, &group).await?;
    let markets: std::collections::HashMap<String, Marketplace> = remote
        .iter()
        .filter_map(|(row, market)| market.map(|m| (row.id.clone(), m)))
        .collect();
    let rows: Vec<ShareRow> = remote.into_iter().map(|(row, _)| row).collect();
    let roster = logged(db, db.with(|conn| cache::reconcile(conn, &rows)))?;
    let mut due = Vec::new();
    for known in roster {
        if known.state != "live" {
            continue;
        }
        let market = markets
            .get(&known.id)
            .copied()
            .unwrap_or(Marketplace::Tcgplayer);
        let check = logged(db, db.reading(|conn| stale(conn, &known, market)))?;
        timer::yield_to_host().await;
        if check.is_some_and(|check| check.due(corpus_current)) {
            due.push((known, market));
        }
    }
    let mut refreshed = Vec::new();
    for (known, market) in due {
        let fields = fields_from_names(&known.fields);
        let published = publish_at(
            db,
            known.folder_uid.as_deref(),
            &known.owner_name,
            fields,
            Some(market),
        )
        .await;
        if let Ok(row) = published {
            refreshed.push(row);
        }
    }
    Ok(refreshed)
}

/// A stretch's failure inside [`refresh_live`], recorded as its row before it is answered — so
/// the doc's promise, that every `Err` it answers is already a row, holds for a database that
/// would not answer as for a Worker that would not.
fn logged<T>(db: &impl Store, stretch: Result<T, String>) -> Result<T, String> {
    stretch.inspect_err(|e| note_in(db, "share_refresh", Kind::Io, e, None))
}

/// Withdraw one share. Terminal, and the reader's own press.
///
/// **The local row moves only after the relay has taken it**, which is [`commit_publish`]'s rule
/// applied to the other direction: a withdrawal this device believes in and the relay does not
/// is a link the reader thinks is dead.
pub async fn revoke(db: &impl Store, id: &str) -> Result<(), String> {
    let base = db.with(endpoint)?;
    let (token, group) = credentials(db).await?;
    delete_share(db, &base, &token, &group, id).await?;
    db.with(|conn| {
        // Nothing will ever compare against it again: a withdrawn share is never republished,
        // and a folder shared afresh is minted a new id. A failed delete is one orphaned row of
        // text.
        let _ = conn.execute(
            "DELETE FROM app_meta WHERE key = ?1",
            rusqlite::params![digest_key(id)],
        );
        // The row survives its own revocation until the next reconcile drops it, so the page
        // can say *withdrawn* rather than having the folder's badge vanish with no explanation.
        cache::mark_state(conn, id, "revoked", now(conn)?)
    })
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
pub async fn list(db: &impl Store) -> Result<Vec<ShareRow>, String> {
    // **Asked before the token and never as a refusal.** `endpoint` is the only thing here that
    // can say "there is nowhere to ask", and on a build with no host that has to stop the
    // `/token` round trip `access_token` would otherwise make on every press of this list.
    if let Ok(base) = db.with(endpoint) {
        // Not [`credentials`], because an unconnected device must not read this as a refusal: it
        // has a perfectly good empty list, and `NOT_CONNECTED` belongs on a press to publish.
        let token = entitlement::access_token(db).await.ok().flatten();
        let group = db
            .with(|conn| identity::group(conn).map_err(|e| e.to_string()))
            .ok()
            .flatten();
        if let (Some(token), Some(group)) = (token, group) {
            if let Ok(remote) = get_shares(db, &base, &token, &group).await {
                let remote: Vec<ShareRow> = remote.into_iter().map(|(row, _)| row).collect();
                // ⚠️ **A reconcile that will not commit falls through to the cache like a
                // request that did not answer.** Returning its `Err` here would make one failed
                // write a *failed share list* on a device that is holding a perfectly good one,
                // which is the opposite of what the paragraph above promises.
                if let Ok(rows) = db.with(|conn| cache::reconcile(conn, &remote)) {
                    return Ok(rows);
                }
            }
        }
    }
    db.with(cache::list)
}

// ---------------------------------------------------------------------------------------
// The Worker's cap
// ---------------------------------------------------------------------------------------

/// The share Worker's cap on one snapshot's gzip — `infrastructure/share-worker/src/env.ts`'s `MAX_BLOB_BYTES`,
/// the same number in a second language. [`SHARE_DEADLINE`] is sized against it.
///
/// **The desktop's viewer holds a snapshot to the number the Worker refused it at**, because nothing larger
/// can have come from a share: `blob.ts` answers 413 above it, on the declared length and on the
/// bytes it counted. A larger body is a host that is not the Worker, and reading it whole would
/// be reading on that host's terms. `the_blob_cap_is_the_workers_own` reads `env.ts` and
/// multiplies its expression out, so a change to either side goes red until both move.
pub const MAX_BLOB_BYTES: usize = 8 * 1024 * 1024;

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
            t: None,
            mc: None,
            mv: None,
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
            deck: None,
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

    /// One copy of one card in the folder `uid` names — the corpus row as well, because the
    /// snapshot's read joins it.
    fn file_card(conn: &Connection, uid: &str, card: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO cards (id, name, set_code, collector_number, lang, layout, raw)
             VALUES (?1, ?1, 'lea', '161', 'en', 'normal', '{}')",
            rusqlite::params![card],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO collection_entries
               (card_id, set_code, collector_number, lang, finish, condition, quantity,
                folder_id, created_at, updated_at)
             VALUES (?1, 'lea', '161', 'en', 'nonfoil', 'NM', 1,
                     (SELECT id FROM collection_folders WHERE sync_uid = ?2), 0, 0)",
            rusqlite::params![card, uid],
        )
        .unwrap();
    }

    /// [`stale`] at the marketplace the reader chose — what [`refresh_live`] asks of each share.
    fn is_stale(conn: &Connection, known: &ShareRow) -> Option<bool> {
        let marketplace = Marketplace::from_id(&crate::marketplace::stored(conn));
        stale(conn, known, marketplace).unwrap().map(|s| s.stale)
    }

    /// What [`stale`] reads the folder as now, for a test to store as "last uploaded".
    fn current_digest(conn: &Connection, known: &ShareRow) -> String {
        let snap = snapshot(
            conn,
            "",
            &known.owner_name,
            known.folder_uid.as_deref(),
            fields_from_names(&known.fields),
            crate::sorting::Marketplace::from_id(&crate::marketplace::stored(conn)),
            0,
        )
        .unwrap();
        digest(&snap).unwrap()
    }

    /// **Two publishes of an unchanged folder must digest alike** — the id is stamped after
    /// the read and the clock moves on every call, so a digest that covered either would make
    /// every publish round a republish and a drain on the Worker budget.
    #[test]
    fn the_digest_ignores_the_id_and_the_clock_but_not_the_cards() {
        let mut a = wire_snapshot(vec![wire_card(1, Some(2.0))]);
        let first = digest(&a).unwrap();
        a.id = "kQ2p7fMx9Lb0RtVw".to_owned();
        a.updated_at = 9_999_999;
        assert_eq!(
            digest(&a).unwrap(),
            first,
            "the id and the stamp are not content"
        );
        a.cards[0].q = 2;
        assert_ne!(
            digest(&a).unwrap(),
            first,
            "a copy more is a change a viewer should see"
        );
    }

    /// Issue #1025's question, without a network: stale when the folder moved, quiet when it
    /// did not.
    #[test]
    fn a_share_is_due_exactly_when_its_folder_no_longer_reads_as_its_last_upload() {
        let conn = open_db();
        let uid = folder(&conn, "a", false);
        file_card(&conn, &uid, "bolt");
        let known = row("kQ2p7fMx9Lb0RtVw");
        cache::store(&conn, &known).unwrap();

        // A share published before digests were kept has none, so its first round is one
        // republish — and then never again until something changes.
        assert_eq!(is_stale(&conn, &known), Some(true));

        crate::app_meta::set_app_meta(
            &conn,
            &digest_key(&known.id),
            &current_digest(&conn, &known),
        )
        .unwrap();
        assert_eq!(
            is_stale(&conn, &known),
            Some(false),
            "nothing moved, nothing is due"
        );

        file_card(&conn, &uid, "counterspell");
        assert_eq!(is_stale(&conn, &known), Some(true), "a card was filed");
    }

    /// **A locked folder's share is never stale — the read refuses it**, so no round retries a
    /// publish that a press would be refused. (A withdrawn share, and one another device
    /// published, are the round's to tell apart: `a_round_republishes_every_live_share_…`.)
    #[test]
    fn a_locked_folders_share_is_never_due() {
        let conn = open_db();
        folder(&conn, "c", true);
        let mut locked = row("lockedlocked0000");
        locked.folder_uid = Some("uid-c".to_owned());
        cache::store(&conn, &locked).unwrap();
        assert_eq!(is_stale(&conn, &locked), None);
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

    /// A binder's preview is text, as it always was: neither preview key carries anything — the
    /// deck half is what supplies them (issue #1032, `share::tests` has the deck's side).
    #[test]
    fn a_binder_sends_no_preview() {
        let body = meta_body(
            Some("uid-a"),
            "Giradeli",
            &wire_snapshot(vec![wire_card(1, None)]),
        )
        .unwrap();
        let body: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(body["format"].is_null(), "{body}");
        assert!(body["image"].is_null(), "{body}");
    }

    /// A deck sends its format and its preview picture beside the rest of the metadata.
    #[test]
    fn a_deck_sends_its_format_and_preview_picture() {
        let mut card = wire_card(1, None);
        card.fo = Some("pile-0".to_owned());
        card.img = Some("https://cards.scryfall.io/display/front/k/1/k1.webp".to_owned());
        let mut snap = wire_snapshot(vec![card]);
        snap.deck = Some(super::super::ShareDeck {
            cover: None,
            format: "Commander".to_owned(),
            piles: vec![super::super::SharePile {
                uid: "pile-0".to_owned(),
                kind: "commander".to_owned(),
                active: true,
            }],
        });
        let body = meta_body(Some("deck:uid"), "Giradeli", &snap).unwrap();
        let body: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["format"], "Commander");
        assert_eq!(
            body["image"],
            "https://cards.scryfall.io/display/front/k/1/k1.webp"
        );
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
            let rows = list(&conn).await.unwrap();
            assert_eq!(rows.len(), 1, "{override_base:?}");
            let logged: i64 = conn
                .query_row("SELECT count(*) FROM error_log", [], |r| r.get(0))
                .unwrap();
            assert_eq!(logged, 0, "nothing went wrong, so nothing is a failure");
        }
    }

    // -----------------------------------------------------------------------------------
    // The writer, while a request is in flight (issue #1145)
    // -----------------------------------------------------------------------------------

    /// One request off a socket the test holds, read to the end of its body, and its head.
    fn take_request(stream: &mut std::net::TcpStream) -> String {
        use std::io::Read;
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let n = stream.read(&mut chunk).unwrap();
            assert!(n > 0, "the publisher hung up mid-request");
            bytes.extend_from_slice(&chunk[..n]);
            let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") else {
                continue;
            };
            let head = String::from_utf8_lossy(&bytes[..end]).into_owned();
            let length = head
                .lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if bytes.len() >= end + 4 + length {
                return head;
            }
        }
    }

    /// **The bug, as the reader met it**: a publish's requests are unanswered, and an ordinary
    /// write — the edit to the folder that is going up — is made in the meantime. Until
    /// 2026-10-20 the publisher held the write connection across both requests, and that write
    /// waited out [`crate::db::WRITE_LOCK_WAIT`] and answered [`crate::db::BUSY`].
    ///
    /// **No timing in it**: the test is the share Worker, on a socket it accepts by hand, so
    /// each write is made while the request it stands beside is provably still in flight.
    #[test]
    fn a_publish_leaves_the_writer_free_while_its_requests_are_in_flight() {
        let (state, _dir) =
            crate::state::fixtures::on_files("share-writer-free", "http://127.0.0.1:1");
        let worker = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let uid = {
            let conn = state.lock_db();
            let base = format!("http://{}", worker.local_addr().unwrap());
            client::set_state(&conn, SHARE_URL, &base).unwrap();
            // A token with life left in it, so the press asks the relay for nothing.
            client::set_state(&conn, entitlement::ACCESS_TOKEN, "bearer").unwrap();
            client::set_state(&conn, entitlement::ACCESS_EXPIRES, &i64::MAX.to_string()).unwrap();
            conn.execute(
                "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
                 VALUES (1, 'g1', 0, zeroblob(32), 0)",
                [],
            )
            .unwrap();
            folder(&conn, "Binder", false)
        };

        let publisher = {
            let state = state.clone();
            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                runtime.block_on(async {
                    let lane = state.lane_for_press().await?;
                    publish(&lane, Some(&uid), "Giradeli", ShareFields::default()).await
                })
            })
        };

        let id = "kQ2p7fMx9Lb0RtVw";
        let created = format!(r#"{{"id":"{id}","url":"https://share.example/s/{id}"}}"#);
        for (asked, answer) in [
            ("POST /g/g1/share ".to_owned(), created),
            (
                format!("PUT /g/g1/share/{id} "),
                r#"{"hash":"h"}"#.to_owned(),
            ),
        ] {
            let (mut stream, _) = worker.accept().unwrap();
            let head = take_request(&mut stream);
            assert!(head.starts_with(&asked), "{head}");
            let edit = crate::state::with_write(&state, |conn| {
                conn.execute(
                    "UPDATE collection_folders SET name = 'Binder, edited'
                      WHERE sync_uid = 'uid-Binder'",
                    [],
                )
                .map_err(|e| e.to_string())
            });
            assert_eq!(
                edit,
                Ok(1),
                "an edit during {asked}must not be told the app is busy"
            );
            use std::io::Write;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\
                 connection: close\r\n\r\n{answer}",
                answer.len()
            )
            .unwrap();
        }

        let row = publisher.join().unwrap().unwrap();
        assert_eq!(row.id, id);
        // The upload is the read's document, so the title is the folder's name before the edit
        // — and the commit landed, so the next round's `stale` sees the edit and publishes it.
        assert_eq!(row.title, "Binder");
        let conn = state.lock_db_read();
        let cached = cache::get(&conn, id).unwrap().expect("the commit landed");
        assert_eq!(cached, row);
        assert_eq!(is_stale(&conn, &cached), Some(true));
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

    /// ⚠️ The one thing about [`SHARE_BASE`] a build can check: `infrastructure/share-worker/wrangler.jsonc`
    /// carries the same string. They moved from the placeholder to the host together on
    /// 2026-10-01, and this test is what asks the person changing one whether they changed both.
    #[test]
    fn the_share_base_is_the_workers_own() {
        let wrangler = include_str!("../../../../infrastructure/share-worker/wrangler.jsonc");
        assert!(
            wrangler.contains(&format!("\"SHARE_BASE\": \"{SHARE_BASE}\"")),
            "share::SHARE_BASE and infrastructure/share-worker/wrangler.jsonc's SHARE_BASE must be the same \
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
        let env = include_str!("../../../../infrastructure/share-worker/src/env.ts");
        let marker = "export const MAX_BLOB_BYTES =";
        let at = env
            .find(marker)
            .expect("infrastructure/share-worker/src/env.ts no longer exports MAX_BLOB_BYTES");
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
    // The publish round's share half (issue #1396)
    // -----------------------------------------------------------------------------------

    /// A device in group `g1` with a token fresh enough that nothing asks the relay, whose share
    /// Worker is `base`.
    fn connected(conn: &Connection, base: &str) {
        client::set_state(conn, SHARE_URL, base).unwrap();
        client::set_state(conn, entitlement::ACCESS_TOKEN, "bearer").unwrap();
        client::set_state(conn, entitlement::ACCESS_EXPIRES, &i64::MAX.to_string()).unwrap();
        conn.execute(
            "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
             VALUES (1, 'g1', 0, zeroblob(32), 0)",
            [],
        )
        .unwrap();
    }

    /// One row of the Worker's roster, as `GET /g/{group}/shares` answers it.
    fn listed(id: &str, folder_uid: &str, state: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "url": format!("https://share.example/s/{id}"),
            "folderUid": folder_uid,
            "title": "Binder",
            "ownerName": "Giradeli",
            "fields": ["value"],
            "state": state,
            "updatedAt": 10,
        })
    }

    /// The roster, answered to this device's bearer only.
    async fn roster(server: &httpmock::MockServer, shares: Vec<serde_json::Value>) {
        let body = serde_json::json!({ "shares": shares }).to_string();
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET)
                    .path("/g/g1/shares")
                    .header("authorization", "Bearer bearer");
                then.status(200).body(body);
            })
            .await;
    }

    /// A publish of the folder `folder_uid` names, answered as the share `id` — or refused with
    /// `status` when it is not a 2xx.
    async fn accepts<'a>(
        server: &'a httpmock::MockServer,
        folder_uid: &str,
        id: &str,
        status: u16,
    ) -> httpmock::Mock<'a> {
        let created = format!(r#"{{"id":"{id}","url":"https://share.example/s/{id}"}}"#);
        let posted = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::POST)
                    .path("/g/g1/share")
                    .body_includes(format!(r#""folderUid":"{folder_uid}""#));
                then.status(status).body(created);
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::PUT)
                    .path(format!("/g/g1/share/{id}"))
                    .header("content-type", "application/gzip");
                then.status(200).body(r#"{"hash":"h"}"#);
            })
            .await;
        posted
    }

    /// **Any device refreshes any live share** (spec §7.5): `aaaa` was published by another
    /// device — this one has no cache row and no digest for it, which the retired desktop pass
    /// would have passed over —
    /// and goes up under the roster's owner name and fields. `bbbb` reads as this device's last
    /// upload and is left alone; `cccc`'s folder is locked, and `dddd` is withdrawn. A second round
    /// finds nothing to do, because the first stored the digest it uploaded.
    #[tokio::test]
    async fn a_round_republishes_every_live_share_that_moved_whoever_published_it() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        connected(&conn, &server.base_url());
        let a = folder(&conn, "a", false);
        let b = folder(&conn, "b", false);
        let c = folder(&conn, "c", true);
        file_card(&conn, &a, "bolt");
        file_card(&conn, &b, "counterspell");
        let mut quiet = row("bbbb");
        quiet.folder_uid = Some(b.clone());
        let digest = current_digest(&conn, &quiet);
        crate::app_meta::set_app_meta(&conn, &digest_key("bbbb"), &digest).unwrap();

        roster(
            &server,
            vec![
                listed("aaaa", &a, "live"),
                listed("bbbb", &b, "live"),
                listed("cccc", &c, "live"),
                listed("dddd", "uid-gone", "revoked"),
            ],
        )
        .await;
        let moved = accepts(&server, &a, "aaaa", 200).await;
        let unmoved = accepts(&server, &b, "bbbb", 200).await;
        let locked = accepts(&server, &c, "cccc", 200).await;

        let refreshed = refresh_live(&conn, true).await.unwrap();
        assert_eq!(
            refreshed.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["aaaa"]
        );
        assert_eq!(refreshed[0].owner_name, "Giradeli", "the share's own owner");
        assert_eq!(refreshed[0].fields, ["value"], "and its own fields");
        assert!(refreshed[0].published.is_some());
        assert_eq!(moved.calls_async().await, 1);
        assert_eq!(unmoved.calls_async().await, 0);
        assert_eq!(locked.calls_async().await, 0);

        assert!(refresh_live(&conn, true).await.unwrap().is_empty());
        assert_eq!(moved.calls_async().await, 1, "nothing moved since");
    }

    /// **The roster or nothing.** A list that does not answer ends the round, even with a live
    /// share in the cache that reads as stale — republishing a folder whose share was
    /// withdrawn on another device would mint the reader a link they took down. The failure is
    /// already a row, so the caller owes none.
    #[tokio::test]
    async fn a_round_whose_roster_does_not_answer_publishes_nothing() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        connected(&conn, &server.base_url());
        let a = folder(&conn, "a", false);
        file_card(&conn, &a, "bolt");
        let mut cached = row("aaaa");
        cached.folder_uid = Some(a.clone());
        cache::store(&conn, &cached).unwrap();
        assert_eq!(
            is_stale(&conn, &cached),
            Some(true),
            "the cache says it is due"
        );

        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::GET).path("/g/g1/shares");
                then.status(500)
                    .body(r#"{"error":"the share service fell over"}"#);
            })
            .await;
        let posted = accepts(&server, &a, "aaaa", 200).await;

        let err = refresh_live(&conn, true).await.unwrap_err();
        assert_eq!(err, "the share service fell over");
        assert_eq!(posted.calls_async().await, 0);
        let logged: String = conn
            .query_row("SELECT operation FROM error_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(logged, "share_list");
    }

    /// **One share's failure does not stop the others**, and it is not the round's error: the
    /// refused publish wrote its own row, and the share that went up is the answer.
    #[tokio::test]
    async fn one_shares_failed_publish_does_not_stop_the_rest() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        connected(&conn, &server.base_url());
        let a = folder(&conn, "a", false);
        let b = folder(&conn, "b", false);
        file_card(&conn, &a, "bolt");
        file_card(&conn, &b, "counterspell");
        roster(
            &server,
            vec![listed("aaaa", &a, "live"), listed("bbbb", &b, "live")],
        )
        .await;
        let refused = accepts(&server, &a, "aaaa", 500).await;
        let landed = accepts(&server, &b, "bbbb", 200).await;

        let refreshed = refresh_live(&conn, true).await.unwrap();
        assert_eq!(
            refreshed.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["bbbb"]
        );
        assert_eq!(refused.calls_async().await, 1);
        assert_eq!(landed.calls_async().await, 1);
        let logged: i64 = conn
            .query_row(
                "SELECT count(*) FROM error_log WHERE operation = 'share_create'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(logged, 1);
    }

    /// **Nothing to do is not a failure**: a base that names no host, and the compiled-in host on
    /// a device with no membership, each answer `[]` with no request and no row — the round runs
    /// after every trip on every host, and most of them have never shared anything.
    #[tokio::test]
    async fn a_round_with_nowhere_to_ask_does_nothing_and_says_nothing() {
        for override_base in [Some("share.example"), None] {
            let conn = open_db();
            if let Some(base) = override_base {
                client::set_state(&conn, SHARE_URL, base).unwrap();
            }
            let a = folder(&conn, "a", false);
            file_card(&conn, &a, "bolt");
            let mut cached = row("aaaa");
            cached.folder_uid = Some(a);
            cache::store(&conn, &cached).unwrap();
            assert!(
                refresh_live(&conn, true).await.unwrap().is_empty(),
                "{override_base:?}"
            );
            let logged: i64 = conn
                .query_row("SELECT count(*) FROM error_log", [], |r| r.get(0))
                .unwrap();
            assert_eq!(logged, 0, "{override_base:?}");
        }
    }

    // -----------------------------------------------------------------------------------
    // Only what this device can read whole, in the share's own marketplace (issue #1396's review)
    // -----------------------------------------------------------------------------------

    /// One copy, in the folder `uid` names, of a printing this device's `cards` does not hold —
    /// written long before this device's bulk file, as a printing that has left Scryfall is.
    fn file_unknown(conn: &Connection, uid: &str, card: &str) {
        file_unknown_at(conn, uid, card, 0);
    }

    /// [`file_unknown`], its row written at `updated_at` (unix seconds).
    fn file_unknown_at(conn: &Connection, uid: &str, card: &str, updated_at: i64) {
        conn.execute(
            "INSERT INTO collection_entries
               (card_id, set_code, collector_number, lang, finish, condition, quantity,
                folder_id, created_at, updated_at)
             VALUES (?1, 'new', '1', 'en', 'nonfoil', 'NM', 1,
                     (SELECT id FROM collection_folders WHERE sync_uid = ?2), ?3, ?3)",
            rusqlite::params![card, uid, updated_at],
        )
        .unwrap();
    }

    /// This device's bulk file, as Scryfall dated it an hour ago.
    fn bulk_file_an_hour_old(conn: &Connection) {
        conn.execute(
            "INSERT OR REPLACE INTO sync_meta (key, value)
             VALUES (?1, strftime('%Y-%m-%dT%H:%M:%S.000+00:00', 'now', '-1 hours'))",
            [crate::sync::K_BULK_UPDATED_AT],
        )
        .unwrap();
    }

    /// This device's download of Mana Pool's price feed, `age` seconds ago.
    fn mana_pool_fetched(conn: &Connection, age: i64) {
        conn.execute(
            "INSERT OR REPLACE INTO marketplace_feed_meta
               (marketplace, fetched_at, feed_built_at, row_count)
             VALUES ('manapool', unixepoch() - ?1, NULL, 1)",
            [age],
        )
        .unwrap();
    }

    /// **A share this device cannot read whole waits for a current corpus**: the phone that holds
    /// last month's cards and this month's set would publish an id for a name, no picture and no
    /// price over the desktop's good snapshot — and the desktop, whose own digest still matches,
    /// would never put it right. A share it can read whole goes up either way; the unreadable one
    /// goes up once the round says the corpus is current (a printing that left Scryfall).
    #[tokio::test]
    async fn a_share_this_device_cannot_read_whole_waits_for_a_current_corpus() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        connected(&conn, &server.base_url());
        bulk_file_an_hour_old(&conn);
        let a = folder(&conn, "a", false);
        let b = folder(&conn, "b", false);
        file_card(&conn, &a, "bolt");
        file_unknown(&conn, &a, "c-from-a-newer-set");
        file_card(&conn, &b, "counterspell");
        roster(
            &server,
            vec![listed("aaaa", &a, "live"), listed("bbbb", &b, "live")],
        )
        .await;
        let unreadable = accepts(&server, &a, "aaaa", 200).await;
        let readable = accepts(&server, &b, "bbbb", 200).await;

        let refreshed = refresh_live(&conn, false).await.unwrap();
        assert_eq!(
            refreshed.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["bbbb"]
        );
        assert_eq!(unreadable.calls_async().await, 0, "held, silently");
        assert_eq!(readable.calls_async().await, 1);
        let logged: i64 = conn
            .query_row("SELECT count(*) FROM error_log", [], |r| r.get(0))
            .unwrap();
        assert_eq!(logged, 0, "held is not a failure");

        let refreshed = refresh_live(&conn, true).await.unwrap();
        assert_eq!(
            refreshed.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["aaaa"]
        );
        assert_eq!(unreadable.calls_async().await, 1);
    }

    /// **A card newer than this device's card data is held however current that data is** — the
    /// preview card the desktop filed this morning, synced to a phone whose bulk file is from
    /// yesterday: still "current", and still no name for it. Only a card whose row is older than
    /// the bulk file is one that left Scryfall.
    #[tokio::test]
    async fn a_card_newer_than_this_devices_card_data_is_held_even_from_a_current_one() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        connected(&conn, &server.base_url());
        bulk_file_an_hour_old(&conn);
        let a = folder(&conn, "a", false);
        file_card(&conn, &a, "bolt");
        let just_now: i64 = conn
            .query_row("SELECT unixepoch()", [], |r| r.get(0))
            .unwrap();
        file_unknown_at(&conn, &a, "c-a-preview-card", just_now);
        roster(&server, vec![listed("aaaa", &a, "live")]).await;
        let posted = accepts(&server, &a, "aaaa", 200).await;

        assert!(refresh_live(&conn, true).await.unwrap().is_empty());
        assert_eq!(posted.calls_async().await, 0);
    }

    /// **A share priced at a feed this device does not hold current is held** — a phone set to
    /// TCGplayer would republish a Mana Pool binder the desktop shared with every price absent, and
    /// the desktop, its own digest unmoved, would never put it right. **Only what reads prices**: a
    /// binder with `value` off goes up, and a wishlist share is held even with `value` off, because
    /// its any-printing wishes are drawn as their cheapest printing at the marketplace. With the
    /// feed current, all three go up.
    #[tokio::test]
    async fn a_share_priced_at_a_feed_this_device_cannot_read_is_held() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        connected(&conn, &server.base_url());
        let a = folder(&conn, "a", false);
        let b = folder(&conn, "b", false);
        file_card(&conn, &a, "bolt");
        file_card(&conn, &b, "counterspell");
        let at_mana_pool = |id: &str, folder_uid: &str, fields: serde_json::Value| {
            let mut row = listed(id, folder_uid, "live");
            row["marketplace"] = serde_json::json!("manapool");
            row["fields"] = fields;
            row
        };
        roster(
            &server,
            vec![
                at_mana_pool("aaaa", &a, serde_json::json!(["value"])),
                at_mana_pool("bbbb", &b, serde_json::json!([])),
                at_mana_pool("cccc", "wishlist:", serde_json::json!([])),
            ],
        )
        .await;
        let priced = accepts(&server, &a, "aaaa", 200).await;
        let unpriced = accepts(&server, &b, "bbbb", 200).await;
        let wishes = accepts(&server, "wishlist:", "cccc", 200).await;

        mana_pool_fetched(&conn, readable::FEED_CURRENT_SECS + 1);
        let refreshed = refresh_live(&conn, true).await.unwrap();
        assert_eq!(
            refreshed.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["bbbb"]
        );
        assert_eq!(
            priced.calls_async().await,
            0,
            "prices this device cannot read"
        );
        assert_eq!(
            wishes.calls_async().await,
            0,
            "a wish drawn by a price it cannot read"
        );
        assert_eq!(unpriced.calls_async().await, 1);

        mana_pool_fetched(&conn, 60);
        let mut refreshed: Vec<String> = refresh_live(&conn, true)
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        refreshed.sort();
        assert_eq!(refreshed, ["aaaa", "cccc"]);
    }

    /// **A roster row that names no marketplace is TCGplayer on every device** — never each
    /// device's own, which would flip the share between two devices set to two marketplaces.
    #[tokio::test]
    async fn a_share_with_no_marketplace_on_record_is_tcgplayers() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        connected(&conn, &server.base_url());
        crate::app_meta::set_app_meta(&conn, crate::marketplace::K_MARKETPLACE, "cardmarket")
            .unwrap();
        let a = folder(&conn, "a", false);
        file_card(&conn, &a, "bolt");
        roster(&server, vec![listed("aaaa", &a, "live")]).await;
        let dollars = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::POST)
                    .path("/g/g1/share")
                    .body_includes(r#""marketplace":"tcgplayer""#);
                then.status(200)
                    .body(r#"{"id":"aaaa","url":"https://share.example/s/aaaa"}"#);
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::PUT).path("/g/g1/share/aaaa");
                then.status(200).body(r#"{"hash":"h"}"#);
            })
            .await;

        assert_eq!(refresh_live(&conn, true).await.unwrap().len(), 1);
        assert_eq!(dollars.calls_async().await, 1);
    }

    /// **A share goes up in the marketplace it was published under**, never this device's: the
    /// roster says Cardmarket, this device is set to TCGplayer, and the republish is priced in
    /// euros — and a second round finds nothing to do, so two devices set to two marketplaces do
    /// not flip the share between them.
    #[tokio::test]
    async fn a_share_is_republished_in_its_own_marketplace() {
        let server = httpmock::MockServer::start_async().await;
        let conn = open_db();
        connected(&conn, &server.base_url());
        let a = folder(&conn, "a", false);
        file_card(&conn, &a, "bolt");
        let mut shared = listed("aaaa", &a, "live");
        shared["marketplace"] = serde_json::json!("cardmarket");
        roster(&server, vec![shared]).await;
        let created = r#"{"id":"aaaa","url":"https://share.example/s/aaaa"}"#;
        let euros = server
            .mock_async(|when, then| {
                when.method(httpmock::Method::POST)
                    .path("/g/g1/share")
                    .body_includes(r#""marketplace":"cardmarket""#)
                    .body_includes(r#""currency":"EUR""#);
                then.status(200).body(created);
            })
            .await;
        server
            .mock_async(|when, then| {
                when.method(httpmock::Method::PUT).path("/g/g1/share/aaaa");
                then.status(200).body(r#"{"hash":"h"}"#);
            })
            .await;

        let refreshed = refresh_live(&conn, true).await.unwrap();
        assert_eq!(refreshed.len(), 1);
        assert_eq!(euros.calls_async().await, 1);
        assert!(refresh_live(&conn, true).await.unwrap().is_empty());
        assert_eq!(
            euros.calls_async().await,
            1,
            "its own digest, its own marketplace"
        );
    }

    /// **A deck's managed wishlist reads alike twice**: the managed folders carry no `sync_uid`,
    /// and until issue #1396's review the reader minted each a random one per read — so such a
    /// share was stale on every round and went up every time. Their uids come from the deck's now.
    #[test]
    fn a_managed_wishlist_share_reads_alike_twice() {
        let conn = open_db();
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at, sync_uid)
             VALUES ('Atraxa', 'casual', 0, 0, 'deckuid')",
            [],
        )
        .unwrap();
        let deck: i64 = conn
            .query_row("SELECT id FROM decks WHERE sync_uid = 'deckuid'", [], |r| {
                r.get(0)
            })
            .unwrap();
        conn.execute(
            "INSERT INTO wishlist_folders
               (name, sort_order, created_at, updated_at, managed_deck_id, managed_tokens)
             VALUES ('Atraxa', 0, 0, 0, ?1, 0)",
            rusqlite::params![deck],
        )
        .unwrap();
        let managed = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO wishlist_folders
               (parent_id, name, sort_order, created_at, updated_at, managed_deck_id,
                managed_tokens)
             VALUES (?1, 'Tokens', 0, 0, 0, ?2, 1)",
            rusqlite::params![managed, deck],
        )
        .unwrap();
        let read = || {
            let snap = snapshot(
                &conn,
                "",
                "Giradeli",
                Some("wishlist:deck:deckuid"),
                ShareFields::default(),
                crate::sorting::Marketplace::Tcgplayer,
                0,
            )
            .unwrap();
            (digest(&snap).unwrap(), snap)
        };
        let (first, snap) = read();
        assert_eq!(read().0, first, "the same folders, the same uids");
        let uids: Vec<&str> = snap.folders.iter().map(|f| f.uid.as_str()).collect();
        assert_eq!(uids, ["managed:deckuid", "managed-tokens:deckuid"]);
        assert_eq!(snap.folders[1].parent.as_deref(), Some("managed:deckuid"));
    }
}
