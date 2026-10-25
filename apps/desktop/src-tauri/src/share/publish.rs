//! The viewer: opening somebody else's shared collection from its link — the desktop's half of
//! `share::publish`, beside a glob re-export of the core's.
//!
//! **The publishing half is `grimoire-core`'s since PR 2 of issue #1396** (`publish`, `refresh`,
//! `revoke`, `list`, `changed`, `refresh_live`, the requests behind them and their refusals), so
//! the phone and the web host refresh a share too, and every path through this module still
//! reaches it. What is defined here is [`open`] and what only it uses — an item a module defines
//! shadows a glob import of the same name.
//!
//! # The viewer keeps none of the publisher's conventions, and that is the fix (issue #545)
//!
//! **The core's four requests talk to the reader's own share Worker; [`open`] talks to whatever
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
//!
//! **It stays the desktop's** because it is `reqwest` with a redirect policy and `https_only`,
//! neither of which the core's host-agnostic client has, and because the light hosts have no
//! viewer of their own to call it.

pub use grimoire_core::share::publish::*;

use crate::errors::{self, Kind, Source};
use reqwest::Url;
use rusqlite::Connection;
use std::time::Duration;

// ---------------------------------------------------------------------------------------
// The viewer's refusals
// ---------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------
// What one open may spend
// ---------------------------------------------------------------------------------------

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
/// `infrastructure/share-worker/src/page.ts`'s own contract: a row with no `object_key` gets the *not ready*
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
        // **`Source::Relay`, the publisher's own source**: the Errors panel groups by source, and
        // a failure to open a share is a failure to reach a Cloudflare Worker like the rest.
        errors::record(
            conn,
            Source::Relay,
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

/// Classify a transport failure. **The viewer's own**, because its client is `reqwest`'s and the
/// core's `kind_of` is over `platform::http`'s error.
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
    use super::super::gzip;
    use super::*;

    fn open_db() -> Connection {
        crate::schema::memory_pair()
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
