//! The five requests to the Discord front, `mtg-grimoire-discord` (the spec's §13.3).
//!
//! **`share::publish`'s conventions**: a client of its own, memoised; the URL a `format!` over
//! [`base`]; the body written by hand with an explicit `content-type`; the bearer as an
//! `authorization` header; every failure an `error_log` row (`Source::Relay`, an operation of its
//! own) before it is an `Err`. **And one stricter**: the Worker's own error text is never passed
//! on — a refusal is read by its status (and the route it answered), and the reader is told one
//! of this file's sentences. The row carries the status, never the body.

use crate::errors::{self, Kind, Source};
use grimoire_core::state::Store;
use grimoire_core::sync_pair::roster;
use serde::Deserialize;
use std::time::Duration;

/// The front's address — a Custom Domain of the Worker `mtg-grimoire-discord` (§13.1).
pub const DISCORD_BASE: &str = "https://discord.mtg-grimoire.app";

/// The base to send to: the [`super::local::DISCORD_URL`] override when there is one, trimmed of
/// trailing slashes, and [`DISCORD_BASE`] otherwise. **A blank is not an override** —
/// `share::publish::base`'s rule, for its reason.
pub fn base(conn: &rusqlite::Connection) -> String {
    let stored =
        crate::sync_engine::client::get_state(conn, super::local::DISCORD_URL).unwrap_or_default();
    let trimmed = stored.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        DISCORD_BASE.to_owned()
    } else {
        trimmed.to_owned()
    }
}

// ---------------------------------------------------------------------------------------
// The sentences
// ---------------------------------------------------------------------------------------

/// The front could not be reached, or answered a status no route here expects.
pub const UNREACHABLE: &str =
    "Discord's service could not be reached. Check the connection and try again.";

/// `503` — the Worker's answer while its Discord application is not configured yet (§13.1), and
/// what an override with no scheme earns before any request.
pub const UNAVAILABLE: &str = "Discord is not available yet. Try again later.";

/// An answer this device could not read — a body of another shape.
pub const UNREADABLE: &str = "Discord's service answered something this device could not read.";

/// `authorizeUrl` was not an `https://discord.com/` address, so the page is never handed it.
pub const NOT_DISCORD: &str =
    "Discord's service answered an address that is not Discord's, so it was not opened.";

/// `403 link_mismatch` on a claim — the verifier is not the one the link began with.
pub const LINK_MISMATCH: &str =
    "That Discord link did not match this device, so it was not used. Start again.";

/// `409 link_denied` — the reader said no on Discord's page.
pub const LINK_DENIED: &str = "Linking was cancelled on Discord's page.";

/// `410 link_expired`, or a link this device saw run out.
pub const LINK_EXPIRED: &str = "That Discord link expired before it was finished. Start again.";

/// `401 not_linked` — the front no longer knows this device's secret.
pub const NOT_LINKED: &str = "This device's Discord link has ended. Link Discord again.";

/// `409 already_enrolled` — this account's bot already holds an identity.
pub const ALREADY_ENROLLED: &str = "Discord is already connected to a sync group for this \
     account. Switch Discord off, then on again.";

/// `422 bad_invite`, `502 pairing_failed` (the bot's Durable Object unreachable included), or
/// another enroll refusal.
pub const ENROLL_FAILED: &str =
    "The Discord bot could not join your sync group. Try again in a moment.";

// ---------------------------------------------------------------------------------------
// The socket
// ---------------------------------------------------------------------------------------

/// The client: **its own**, neither Scryfall's nor the relay's nor the share Worker's — the
/// fourth host, with its own timeouts. Memoised for the life of the process.
fn http() -> reqwest::Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .user_agent(crate::scryfall::USER_AGENT)
                .connect_timeout(Duration::from_secs(10))
                // `POST /link/enroll` waits for the bot's Durable Object to post its join.
                .read_timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_default()
        })
        .clone()
}

fn kind_of(err: &reqwest::Error) -> Kind {
    if err.is_timeout() {
        Kind::Timeout
    } else if err.is_decode() {
        Kind::Parse
    } else {
        Kind::Other
    }
}

fn note(db: &impl Store, operation: &str, kind: Kind, message: &str, url: &str) {
    let _ = db.with(|conn| {
        errors::record(conn, Source::Relay, operation, kind, message, Some(url));
        Ok(())
    });
}

/// The base, or [`UNAVAILABLE`] for one that names no scheme — refused before any request.
fn endpoint(db: &impl Store, path: &str) -> Result<String, String> {
    let base = db.with(|conn| Ok(base(conn)))?;
    if base.starts_with("https://") || base.starts_with("http://") {
        Ok(format!("{base}{path}"))
    } else {
        Err(UNAVAILABLE.to_owned())
    }
}

/// Send, and answer the status and body — or record the transport failure and answer
/// [`UNREACHABLE`].
async fn send(
    db: &impl Store,
    operation: &str,
    url: &str,
    request: reqwest::RequestBuilder,
) -> Result<(u16, String), String> {
    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            note(db, operation, kind_of(&e), &e.to_string(), url);
            return Err(UNREACHABLE.to_owned());
        }
    };
    let status = response.status().as_u16();
    match response.text().await {
        Ok(body) => Ok((status, body)),
        Err(e) => {
            note(db, operation, kind_of(&e), &e.to_string(), url);
            Err(UNREACHABLE.to_owned())
        }
    }
}

/// A refusal: recorded by its status, and answered as `sentence`.
fn refused(db: &impl Store, operation: &str, url: &str, status: u16, sentence: &str) -> String {
    note(
        db,
        operation,
        Kind::Http,
        &format!("the Discord service answered {status}"),
        url,
    );
    sentence.to_owned()
}

fn parse<T: serde::de::DeserializeOwned>(
    db: &impl Store,
    operation: &str,
    url: &str,
    body: &str,
) -> Result<T, String> {
    serde_json::from_str(body).map_err(|e| {
        note(db, operation, Kind::Parse, &e.to_string(), url);
        UNREADABLE.to_owned()
    })
}

// ---------------------------------------------------------------------------------------
// The five requests
// ---------------------------------------------------------------------------------------

/// `POST /link/begin`'s answer.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Begun {
    pub code: String,
    pub authorize_url: String,
    /// Unix milliseconds.
    pub expires_at: i64,
}

/// Whether `url` is Discord's own authorization page — `https://discord.com/…`, nothing else.
/// The page opens it in the reader's browser, so a front that answered any other address would
/// be choosing where a reader signs in.
pub fn is_discord_authorize(url: &str) -> bool {
    reqwest::Url::parse(url)
        .is_ok_and(|u| u.scheme() == "https" && u.host_str() == Some("discord.com"))
}

/// Begin a PKCE link: `{ challenge }` → `{ code, authorizeUrl, expiresAt }`.
pub async fn begin(db: &impl Store, challenge: &str) -> Result<Begun, String> {
    const OP: &str = "discord_link";
    let url = endpoint(db, "/link/begin")?;
    let body = serde_json::json!({ "challenge": challenge }).to_string();
    let (status, text) = send(
        db,
        OP,
        &url,
        http()
            .post(&url)
            .header("content-type", "application/json")
            .body(body),
    )
    .await?;
    match status {
        200..=299 => {}
        503 => return Err(refused(db, OP, &url, status, UNAVAILABLE)),
        _ => return Err(refused(db, OP, &url, status, UNREACHABLE)),
    }
    let begun: Begun = parse(db, OP, &url, &text)?;
    if !is_discord_authorize(&begun.authorize_url) {
        note(db, OP, Kind::Parse, NOT_DISCORD, &url);
        return Err(NOT_DISCORD.to_owned());
    }
    Ok(begun)
}

/// What a claim came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Claim {
    /// `202` — the reader has not finished on Discord's page yet.
    Pending,
    /// `200` — linked.
    Linked {
        secret: String,
        discord_user_id: String,
        username: String,
    },
    /// A refusal that ends the link (`403`, `409`, `410`): its sentence.
    Ended(&'static str),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Claimed {
    secret: String,
    discord_user_id: String,
    username: String,
}

/// `POST /link/claim` with `{ code, verifier }`. A transport failure or an unexpected status is
/// an `Err` and leaves the link in flight; a refusal that ends it is [`Claim::Ended`].
pub async fn claim(db: &impl Store, code: &str, verifier: &str) -> Result<Claim, String> {
    const OP: &str = "discord_link";
    let url = endpoint(db, "/link/claim")?;
    let body = serde_json::json!({ "code": code, "verifier": verifier }).to_string();
    let (status, text) = send(
        db,
        OP,
        &url,
        http()
            .post(&url)
            .header("content-type", "application/json")
            .body(body),
    )
    .await?;
    let ended = |sentence: &'static str| {
        refused(db, OP, &url, status, sentence);
        Ok(Claim::Ended(sentence))
    };
    match status {
        202 => Ok(Claim::Pending),
        200 => {
            let c: Claimed = parse(db, OP, &url, &text)?;
            Ok(Claim::Linked {
                secret: c.secret,
                discord_user_id: c.discord_user_id,
                username: c.username,
            })
        }
        403 => ended(LINK_MISMATCH),
        409 => ended(LINK_DENIED),
        410 => ended(LINK_EXPIRED),
        503 => Err(refused(db, OP, &url, status, UNAVAILABLE)),
        _ => Err(refused(db, OP, &url, status, UNREACHABLE)),
    }
}

/// `POST /link/enroll`'s answer: the bot's three public values, base64url without padding.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enrolled {
    pub device_id: String,
    pub x25519: String,
    pub ed25519: String,
}

/// `POST /link/enroll` with the invite (`pairing::Offer.code`) and `capability: "add"` — the one
/// capability a switch-on pairs the bot as (spec §14.1), the same word the pin carries.
pub async fn enroll(db: &impl Store, secret: &str, invite: &str) -> Result<Enrolled, String> {
    const OP: &str = "discord_enroll";
    let url = endpoint(db, "/link/enroll")?;
    let body = serde_json::json!({ "invite": invite, "capability": roster::ADD }).to_string();
    let (status, text) = send(
        db,
        OP,
        &url,
        http()
            .post(&url)
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {secret}"))
            .body(body),
    )
    .await?;
    match status {
        200..=299 => parse(db, OP, &url, &text),
        401 => Err(refused(db, OP, &url, status, NOT_LINKED)),
        409 => Err(refused(db, OP, &url, status, ALREADY_ENROLLED)),
        503 => Err(refused(db, OP, &url, status, UNAVAILABLE)),
        _ => Err(refused(db, OP, &url, status, ENROLL_FAILED)),
    }
}

/// `GET /link`'s answer.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub discord_user_id: String,
    pub username: String,
    #[serde(default)]
    pub enrolled: bool,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub paired: bool,
    /// Unix milliseconds.
    #[serde(default)]
    pub last_pull_at: Option<i64>,
}

/// `GET /link`.
pub async fn info(db: &impl Store, secret: &str) -> Result<Info, String> {
    const OP: &str = "discord_link";
    let url = endpoint(db, "/link")?;
    let (status, text) = send(
        db,
        OP,
        &url,
        http()
            .get(&url)
            .header("authorization", format!("Bearer {secret}")),
    )
    .await?;
    match status {
        200..=299 => parse(db, OP, &url, &text),
        401 => Err(refused(db, OP, &url, status, NOT_LINKED)),
        _ => Err(refused(db, OP, &url, status, UNREACHABLE)),
    }
}

/// `DELETE /link` — the front calls the bot's `unlink()` (its storage, identity and keys
/// deleted for good), then deletes the link row. **A `401` is success**: there is no link left to
/// delete. A `502 bot_unavailable` — the bot could not be reached, and the front kept the link
/// row — is a failure like any other status, and [`super::flow::disable`] keeps the secret for it.
pub async fn unlink(db: &impl Store, secret: &str) -> Result<(), String> {
    const OP: &str = "discord_unlink";
    let url = endpoint(db, "/link")?;
    let (status, _) = send(
        db,
        OP,
        &url,
        http()
            .delete(&url)
            .header("authorization", format!("Bearer {secret}")),
    )
    .await?;
    match status {
        200..=299 | 401 => Ok(()),
        _ => Err(refused(db, OP, &url, status, UNREACHABLE)),
    }
}
