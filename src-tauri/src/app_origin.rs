//! **Which pages are this app's own** — the one question the camera grant and the navigation
//! guard both ask, answered once so the two can never disagree about it.
//!
//! Until 2026-09-28 neither asked. [`crate::camera`] granted the camera on the permission *kind*
//! alone and never read the URI of the page asking, and nothing stopped the window leaving the
//! app: there was no navigation handler, and `dragDropEnabled: false` — load-bearing for every
//! in-app drag, see `src-tauri/CLAUDE.md` — is also what keeps wry from ever calling WebView2's
//! `SetAllowExternalDrop(false)`. So a link dropped on the window should have loaded a remote
//! page in it, and that page would have had a silent, prompt-free camera stream (issue #545;
//! the drop was reasoned from wry's source and not driven live). Each half is a fence on its
//! own now: [`guard`] refuses the navigation, and the camera handler refuses any page this set
//! does not hold even if something else gets one into the window.
//!
//! **What "own" means is Tauri's own answer, narrowed.** `tauri::webview::Webview::is_local_url`
//! is private, and it counts every registered URI scheme as local too — `mtgimg` included, which
//! is a card image and never a page. What an app window actually loads is one of two things:
//!
//! - **the embedded frontend**, served on Windows as `http://tauri.localhost` (or `https://` when
//!   a window sets `useHttpsScheme`, which none here does) and elsewhere as `tauri://localhost` —
//!   `tauri-2.11.5/src/manager/mod.rs`, `tauri_protocol_url`. All three are listed whatever the
//!   platform: no network ever answers for any of them, because the webview intercepts those
//!   hosts before a request leaves it, so the cost of the extra two is nothing.
//! - **`build.devUrl`** in a dev build (`tauri::is_dev()`), which is Vite on
//!   `http://localhost:1420`. **Only** in a dev build: a release binary never loads it, so a
//!   release binary never trusts whatever happens to be listening on that port.
//!
//! An origin is compared as **scheme, host and port** rather than with `Url::origin()`, because
//! `tauri://localhost` is not a special scheme and the URL standard gives it an *opaque* origin —
//! one that equals nothing, itself included.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, Url};

/// The origins this app's own pages load from. See the module doc for why these and no others.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppOrigins(Vec<(String, String, Option<u16>)>);

/// The embedded frontend, in every spelling Tauri serves it under.
const EMBEDDED: [&str; 3] = [
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
];

impl AppOrigins {
    /// The set for one app. `dev` is `tauri::is_dev()` at the call site and a parameter here, so
    /// a test can build the release set from a debug test binary.
    pub fn new(config: &tauri::Config, dev: bool) -> AppOrigins {
        let mut origins: Vec<_> = EMBEDDED
            .iter()
            .filter_map(|u| Url::parse(u).ok())
            .filter_map(|u| key(&u))
            .collect();
        if dev {
            origins.extend(config.build.dev_url.as_ref().and_then(key));
        }
        AppOrigins(origins)
    }

    /// The set for the running app — what both callers use.
    pub fn of<R: Runtime, M: Manager<R>>(manager: &M) -> AppOrigins {
        AppOrigins::new(manager.config(), tauri::is_dev())
    }

    /// Whether `url` is one of this app's own pages.
    pub fn holds(&self, url: &Url) -> bool {
        key(url).is_some_and(|k| self.0.contains(&k))
    }

    /// [`Self::holds`] for a URI that arrives as text — WebView2 hands the camera handler a
    /// string. **One that will not parse is not ours**: a permission is never granted to a page
    /// this cannot even name.
    pub fn holds_str(&self, uri: &str) -> bool {
        Url::parse(uri).is_ok_and(|u| self.holds(&u))
    }
}

/// Scheme, host and port — `None` for a URL with no host, which no page of this app is.
fn key(url: &Url) -> Option<(String, String, Option<u16>)> {
    let host = url.host_str()?;
    Some((
        url.scheme().to_owned(),
        host.to_ascii_lowercase(),
        url.port_or_known_default(),
    ))
}

/// Whether a window may navigate to `url` at all.
///
/// **`about:blank` is let through**, and not because anything here was seen to need it: it loads
/// nothing, so a page cannot arrive by it, and this guard was never driven on WebView2 — refusing
/// it risks a blank window for no security gained. It is still not an app origin, so the camera
/// handler refuses it.
pub fn may_navigate(origins: &AppOrigins, url: &Url) -> bool {
    origins.holds(url) || url.as_str() == "about:blank"
}

/// **The navigation guard**: a plugin with one hook and no commands, so it needs no capability
/// and every webview the app ever opens — `main`, and each `window-N` — is under it without
/// either builder having to remember.
///
/// A refused navigation is simply cancelled: the window stays on the page it was showing. A link
/// the reader meant to follow goes out through `openUrl` and the system browser, which is the
/// only way this app has ever opened one, so nothing that works today is refused. The line on
/// stderr names the **origin** and not the whole URL, because the path of a link somebody dropped
/// is theirs.
///
/// Tauri runs plugin hooks only once the webview is registered, so the window's first load never
/// reaches this — which is right, since that load is the app itself
/// (`tauri-2.11.5/src/manager/webview.rs`, the `navigation_handler` closure).
pub fn guard<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let allowed = may_navigate(&AppOrigins::of(webview), url);
            if !allowed {
                eprintln!(
                    "navigation to {} refused: not one of this app's pages",
                    url.origin().ascii_serialization()
                );
            }
            allowed
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shipped config, so the dev origin is the one `devUrl` really names.
    fn config() -> tauri::Config {
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap()
    }

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn the_embedded_frontend_is_ours_in_every_spelling() {
        let release = AppOrigins::new(&config(), false);
        for page in [
            "http://tauri.localhost/",
            "http://tauri.localhost/index.html#/decks",
            "https://tauri.localhost/",
            "tauri://localhost/",
            "HTTP://TAURI.LOCALHOST/",
        ] {
            assert!(release.holds(&url(page)), "{page}");
        }
    }

    /// The whole reason the set exists: a remote page, however it got into the window.
    #[test]
    fn a_remote_page_is_not_ours() {
        let dev = AppOrigins::new(&config(), true);
        for page in [
            "https://evil.example/",
            "http://evil.example/",
            // A lookalike: the host is `tauri.localhost.evil.example`.
            "http://tauri.localhost.evil.example/",
            // Userinfo: the host is `evil.example`, whatever precedes the `@`.
            "http://tauri.localhost@evil.example/",
            // Right host, wrong port — a second server on the loopback is not the app.
            "http://tauri.localhost:8080/",
        ] {
            assert!(!dev.holds(&url(page)), "{page}");
            assert!(!dev.holds_str(page), "{page}");
        }
    }

    /// The card-image protocol is registered with Tauri, and Tauri's own `is_local_url` would
    /// count it. It serves pictures, never a page, so it is not on the list.
    #[test]
    fn the_card_image_protocol_is_not_a_page() {
        let dev = AppOrigins::new(&config(), true);
        assert!(!dev.holds(&url("http://mtgimg.localhost/grid/abc/0")));
        assert!(!dev.holds(&url("mtgimg://localhost/grid/abc/0")));
    }

    #[test]
    fn the_dev_server_is_ours_only_in_a_dev_build() {
        let vite = url("http://localhost:1420/");
        assert!(AppOrigins::new(&config(), true).holds(&vite));
        assert!(
            !AppOrigins::new(&config(), false).holds(&vite),
            "a release binary must not trust whatever listens on the dev port"
        );
        // The port is part of the origin: something on the next port along is somebody else.
        let dev = AppOrigins::new(&config(), true);
        assert!(!dev.holds(&url("http://localhost:1421/")));
        assert!(!dev.holds(&url("http://127.0.0.1:1420/")));
    }

    #[test]
    fn a_uri_that_will_not_parse_is_not_ours() {
        let dev = AppOrigins::new(&config(), true);
        assert!(!dev.holds_str(""));
        assert!(!dev.holds_str("not a url"));
    }

    /// `about:blank` may be navigated to, and is still nobody's origin — so the camera handler,
    /// which asks [`AppOrigins::holds_str`] rather than [`may_navigate`], refuses it.
    #[test]
    fn about_blank_is_navigable_and_still_not_ours() {
        let release = AppOrigins::new(&config(), false);
        let blank = url("about:blank");
        assert!(may_navigate(&release, &blank));
        assert!(!release.holds(&blank));
        assert!(!release.holds_str("about:blank"));
        assert!(!may_navigate(&release, &url("https://evil.example/")));
        assert!(!may_navigate(&release, &url("data:text/html,hi")));
        assert!(may_navigate(
            &release,
            &url("http://tauri.localhost/index.html")
        ));
    }
}
