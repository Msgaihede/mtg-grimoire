//! **The image cache is `grimoire-core`'s, re-exported here beside what names this app.**
//!
//! The cache, the resolution rule, the pre-warm's keys and the eviction pass are in
//! `crates/grimoire-core/src/images.rs` since the extraction's I/O step; a path through this
//! module reaches that crate's item unless this file defines it. Three things are defined here:
//!
//! * **the `mtgimg://` answer** — [`serve`] and the pure [`respond`] behind it, which turn a
//!   cache result into the HTTP response this app's webview is handed;
//! * **the two commands** that warm the cache, which name this app's state and a task to run on;
//! * **the upkeep thread**, [`spawn_upkeep`]. The *pass* it runs is the core's
//!   `upkeep_tick`; what is a host's is when to wake up for one.

pub use grimoire_core::images::*;

use std::sync::Arc;

/// How long the webview may keep an image it has been given.
///
/// A day, not a year: the URL is stable across Scryfall re-scanning a card, so an
/// immutable cache would pin a superseded picture inside the webview until the app is
/// reinstalled. A day of staleness after a re-scan is invisible; being asked again for
/// every tile that scrolls past is not.
const IMAGE_MAX_AGE: &str = "max-age=86400";

/// The HTTP answer for one resolved request.
///
/// Separated from [`serve`] because this is the whole contract with the renderer and it is
/// pure — `serve` itself needs a running Tauri app, and a contract that can only be
/// exercised by launching one is a contract nothing checks.
///
/// The distinction that matters is permanent-versus-retryable. A printing Scryfall has no
/// art for is a **200** with a placeholder, because there is nothing to retry; a failed
/// fetch is a **502**, and a rate limit a **503** carrying the wait, so the `<img>` can
/// report an error and the grid can heal itself. Serving a placeholder for a network
/// failure would quietly turn a temporary outage into a permanently artless collection.
fn respond(result: Result<Served, ImageError>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};

    match result {
        Ok(served) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, served.content_type)
            // A placeholder is the one 200 whose content is *meant* to change. It stands in
            // for a picture the next sync may well supply — Scryfall scans a card and the
            // `soon.jpg` becomes real art — and there is no URI change to notice it by,
            // because the placeholder was never fetched from a URI at all. Real bytes keep
            // their day: their URI *is* their version, so their staleness is bounded by the
            // re-scan that ended it.
            .header(
                header::CACHE_CONTROL,
                if served.content_type == SVG {
                    "no-store"
                } else {
                    IMAGE_MAX_AGE
                },
            )
            .body(served.bytes)
            .expect("image response"),
        Err(ImageError::UnknownCard) => fail(StatusCode::NOT_FOUND, "no such card", None),
        Err(ImageError::RateLimited { retry_after_secs }) => fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "rate limited by Scryfall",
            Some(retry_after_secs),
        ),
        Err(e) => fail(StatusCode::BAD_GATEWAY, &e.to_string(), None),
    }
}

/// A failure, as the webview sees it.
///
/// `no-store` on every one of them. A 404 is *heuristically* cacheable, and the card
/// behind one can arrive in the next sync — a cached 404 would outlive the thing it was
/// true about, with no way to invalidate it short of restarting the app. The same applies
/// to a 503 the whole design expects to be retried.
fn fail(
    status: tauri::http::StatusCode,
    message: &str,
    retry_after: Option<u64>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response};

    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain;charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store");
    if let Some(secs) = retry_after {
        builder = builder.header(header::RETRY_AFTER, secs.to_string());
    }
    builder
        .body(message.as_bytes().to_vec())
        .expect("static response")
}

/// The answer for a request that arrives before `setup` has managed the state.
///
/// The webview and the app's own startup genuinely race at launch, so this is a real
/// state rather than a defensive impossibility — and a retryable one, in about the time
/// it takes to read the header.
fn not_ready() -> tauri::http::Response<Vec<u8>> {
    fail(
        tauri::http::StatusCode::SERVICE_UNAVAILABLE,
        "app is still starting",
        Some(1),
    )
}

/// Answer one `mtgimg://` request.
///
/// Only the *path* is ever read: on Windows the origin is `http://mtgimg.localhost/…` and
/// elsewhere `mtgimg://localhost/…`, so a handler that looked at the host would be a
/// handler that worked on exactly one platform.
///
/// **One route.** A card image is `/<variant>/<card id>/<face>` over the four [`Variant`]
/// words, and that is the whole protocol. There was a second — `/cover/<deck id>`, the file a
/// reader picked as a deck's cover — which went with the custom cover itself on 2026-08-31: a
/// cover is now `decks.cover_card_id`, the art crop of a card, which this route already serves
/// as an ordinary card image.
pub async fn serve(app: &tauri::AppHandle, path: &str) -> tauri::http::Response<Vec<u8>> {
    use tauri::Manager;

    let Some(key) = parse_request_path(path) else {
        return fail(
            tauri::http::StatusCode::NOT_FOUND,
            "not an image request",
            None,
        );
    };
    let Some(state) = app.try_state::<std::sync::Arc<crate::sync::AppState>>() else {
        return not_ready();
    };

    respond(
        state
            .images
            .get(&state.client, state.reader(), &state.db, &key)
            .await,
    )
}

/// Warm the cache for a page of results.
///
/// Returns as soon as the work is queued rather than when it is done: nothing is waiting
/// on the answer, and a command that took the length of 100 downloads to resolve would be
/// a command the UI has to manage. Failures are silent for the same reason — an image
/// that did not prefetch is an image that fetches when it is rendered.
#[tauri::command]
pub async fn prefetch_images(
    state: tauri::State<'_, std::sync::Arc<crate::sync::AppState>>,
    card_ids: Vec<String>,
    variant: String,
) -> Result<(), String> {
    let Some(variant) = Variant::parse(&variant) else {
        return Err(format!("unknown image variant: {variant}"));
    };
    let state = state.inner().clone();
    let keys = prefetch_keys(&card_ids, variant);
    tauri::async_runtime::spawn(async move {
        warm(
            &state.images,
            &state.client,
            state.reader(),
            &state.db,
            keys,
        )
        .await;
    });
    Ok(())
}

/// Warm the cache for what the user owns. Returns how many images were queued.
///
/// Fire-and-forget in the same sense as [`prefetch_images`]: it resolves when the work is
/// queued. The loop shares the cache's own semaphore with the live grid, so a pre-warm
/// running behind a browsing session competes for the same budget rather than doubling it,
/// and it abandons the batch on the first rate limit.
#[tauri::command]
pub async fn prewarm_collection(
    state: tauri::State<'_, std::sync::Arc<crate::sync::AppState>>,
) -> Result<usize, String> {
    let state = state.inner().clone();
    let keys = {
        let conn = crate::sync::lock_db_read(&state);
        prewarm_keys(&conn, MAX_PREWARM).map_err(|e| e.to_string())?
    };
    let queued = keys.len();
    tauri::async_runtime::spawn(async move {
        warm(
            &state.images,
            &state.client,
            state.reader(),
            &state.db,
            keys,
        )
        .await;
    });
    Ok(queued)
}

/// Start the `image-upkeep` thread, which wakes every [`UPKEEP_TICK`] and runs one
/// [`upkeep_tick`] — the core's, where the pass, what makes one owed and what it spares are
/// written down. The first wake is a minute after launch, so the window, the facet index and
/// the first page of tiles are not competing with a directory walk.
///
/// Detached, like [`crate::index::lifecycle::spawn_build`]: nothing waits on it, and a process
/// that exits mid-pass leaves the interruption the pass's order was chosen for.
pub fn spawn_upkeep(state: &Arc<crate::sync::AppState>) {
    let state = Arc::clone(&state.core);
    let spawned = std::thread::Builder::new()
        .name("image-upkeep".into())
        .spawn(move || {
            let mut stores_at_last_pass: Option<u64> = None;
            loop {
                std::thread::sleep(UPKEEP_TICK);
                upkeep_tick(&state, &mut stores_at_last_pass);
            }
        });
    if let Err(e) = spawned {
        eprintln!("image cache: could not start the upkeep thread, so nothing is evicted: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header<'a>(r: &'a tauri::http::Response<Vec<u8>>, name: &str) -> Option<&'a str> {
        r.headers().get(name).and_then(|v| v.to_str().ok())
    }

    /// Bytes, and permission to keep them for a day — not forever. The URL is stable
    /// across Scryfall re-scanning a card, so an immutable cache would pin a superseded
    /// picture inside the webview until the app is reinstalled.
    #[test]
    fn a_served_image_is_a_200_the_webview_may_cache_for_a_day() {
        let r = respond(Ok(Served {
            bytes: vec![0x52, 0x49, 0x46, 0x46],
            content_type: WEBP,
        }));

        assert_eq!(r.status(), tauri::http::StatusCode::OK);
        assert_eq!(header(&r, "content-type"), Some(WEBP));
        assert_eq!(header(&r, "cache-control"), Some("max-age=86400"));
        assert_eq!(r.body(), &vec![0x52u8, 0x49, 0x46, 0x46]);
    }

    /// A printing Scryfall has no art for is a **200**: there is nothing to retry, and a
    /// failure status would put a broken-image icon where the app has a considered answer.
    ///
    /// But it is the one 200 the webview may not keep. Every other image carries its own
    /// version in its URL, so a day of caching is bounded by the re-scan that ended it; a
    /// placeholder was never fetched from a URL at all, and the thing that replaces it —
    /// a sync that fills in the art, or a `soon.jpg` that finally becomes a picture —
    /// changes nothing the webview could notice. `no-store` is what makes the next look at
    /// that card ask again.
    #[test]
    fn a_placeholder_is_a_200_the_webview_may_not_keep() {
        let svg = placeholder_svg(Placeholder::NoImage, Variant::Grid);
        let r = respond(Ok(Served {
            bytes: svg.clone().into_bytes(),
            content_type: SVG,
        }));

        assert_eq!(r.status(), tauri::http::StatusCode::OK);
        assert_eq!(header(&r, "content-type"), Some(SVG));
        assert_eq!(header(&r, "cache-control"), Some("no-store"));
        assert_eq!(r.body(), &svg.into_bytes());
    }

    /// **`img-src` is pinned whole, and that is the point of having this beside
    /// `desktop.rs`'s guard.**
    ///
    /// `app.security.csp` is configuration, so nothing else in the build can fail when it is
    /// loosened — `desktop.rs`'s `the_shipped_csp_allows_ipc_and_images_and_nothing_wild`
    /// asserts the sources the app needs are *present* and that no wildcard is, which a new
    /// source passes. This asserts the one directive every picture in the app goes through is
    /// **exactly** these four and nothing else: a source added to it fails here by name.
    ///
    /// It was written for the deck-cover route, which was a path on `mtgimg:` precisely so it
    /// would need no new source; that route went on 2026-08-31 and the pin outlived it, because
    /// serving any image from `file:`, `asset:` or a `blob:` is the same change and would still
    /// be the one nothing else in this app notices.
    ///
    /// `data:` is on the list already — it is the inline SVG placeholder's.
    #[test]
    fn the_shipped_csp_is_untouched() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();

        let img_src = csp
            .split(';')
            .map(str::trim)
            .find(|d| d.starts_with("img-src"))
            .expect("the CSP must name img-src");
        assert_eq!(
            img_src, "img-src 'self' data: mtgimg: http://mtgimg.localhost",
            "every picture in this app is a path on `mtgimg:`, so img-src must not have grown"
        );
    }

    /// An id nothing resolves to is a caller error. A 404 rather than a placeholder,
    /// because a broken link must not be indistinguishable from a card with no art — and
    /// `no-store`, because the card can arrive in the very next sync and a heuristically
    /// cached 404 would outlive it.
    #[test]
    fn an_unknown_card_is_an_uncacheable_404() {
        let r = respond(Err(ImageError::UnknownCard));

        assert_eq!(r.status(), tauri::http::StatusCode::NOT_FOUND);
        assert_eq!(header(&r, "content-type"), Some("text/plain;charset=utf-8"));
        assert_eq!(header(&r, "cache-control"), Some("no-store"));
        assert!(header(&r, "retry-after").is_none());
    }

    /// The one case the grid can heal from on its own, so it is the one case that carries
    /// instructions: a **503** with the wait in seconds. The number is the *clamped* one
    /// the fetcher will actually honour — telling the UI to come back sooner than the gate
    /// opens is how a retry loop walks straight into a Scryfall ban.
    #[test]
    fn a_rate_limit_is_a_503_carrying_the_wait_the_fetcher_will_honour() {
        let r = respond(Err(ImageError::RateLimited {
            retry_after_secs: 30,
        }));

        assert_eq!(r.status(), tauri::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            header(&r, "retry-after"),
            Some("30"),
            "the header is what the grid schedules its retry from"
        );
        assert_eq!(header(&r, "cache-control"), Some("no-store"));
    }

    /// Everything else is a **502**: the app reached its own cache fine and the far end is
    /// what failed. Emphatically not a 200 with a placeholder — that would turn a
    /// five-second outage into a collection that is permanently artless, with no signal
    /// anywhere that a retry would fix it.
    #[test]
    fn every_other_failure_is_a_502_that_says_what_broke() {
        for e in [
            ImageError::Fetch("connection reset".into()),
            ImageError::Io("the disk is full".into()),
            ImageError::Db("database is locked".into()),
        ] {
            let expected = e.to_string();
            let r = respond(Err(e));
            assert_eq!(r.status(), tauri::http::StatusCode::BAD_GATEWAY);
            assert_eq!(header(&r, "cache-control"), Some("no-store"));
            assert_eq!(String::from_utf8(r.body().clone()).unwrap(), expected);
        }
    }

    /// A request that arrives before `setup` has managed the state — the webview and the
    /// first sync race at launch. Retryable, and the shortest honest wait, because the
    /// state appears within milliseconds.
    #[test]
    fn a_request_before_the_app_has_its_state_is_a_503_worth_retrying_at_once() {
        let r = not_ready();

        assert_eq!(r.status(), tauri::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(header(&r, "retry-after"), Some("1"));
    }
}
