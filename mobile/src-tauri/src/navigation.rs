//! **Which pages the light host's window may show, and where every other link goes** — the
//! light app's phase 4, step 4.3.
//!
//! A WebView that follows a link off the app's own origin has left the app: on Android there is
//! no address bar, and a deck note's link or an `Open on …` row would replace the page with a
//! shop. So the window stays on the app's pages — the desktop's `app_origin` rule, restated over
//! this host's two origins — and an `http`/`https` link anywhere else is handed to the system
//! browser through the opener plugin, which on Android is an intent. A link with any other scheme
//! is refused and goes nowhere.
//!
//! **Restated rather than shared** with `src-tauri/src/app_origin.rs`: both are Tauri-typed, and
//! the core may name no `tauri` type. The two lists are short and each host's test pins its own.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, Url};
use tauri_plugin_opener::OpenerExt;

/// The origins the light bundle is served from: Android's `http://tauri.localhost`, the
/// `https` form a host that set `useHttpsScheme` would use, and a desktop's `tauri://localhost`.
const EMBEDDED: [&str; 3] = [
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
];

/// Whether `url` is one of this app's own pages, compared by scheme, host and port — never by
/// `Url::origin`, which is opaque (`"null"`) for a scheme the URL standard does not know, such as
/// `tauri:`. The desktop's `app_origin` compares the same three.
///
/// `dev` is the dev server's address in a dev build — the config's `devUrl`, read at run time
/// because `tauri android dev` may rewrite its host (to the machine's address, or `localhost`
/// through `adb reverse`) — and `None` in a build that ships.
pub fn is_own(url: &Url, dev: Option<&Url>) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    let Some(key) = key_of(url) else {
        return false;
    };
    let same = |s: &str| Url::parse(s).ok().and_then(|u| key_of(&u)) == Some(key.clone());
    EMBEDDED.iter().any(|s| same(s)) || dev.and_then(key_of) == Some(key)
}

fn key_of(url: &Url) -> Option<(String, String, Option<u16>)> {
    Some((
        url.scheme().to_owned(),
        url.host_str()?.to_ascii_lowercase(),
        url.port_or_known_default(),
    ))
}

/// Whether a refused link is one worth handing to the browser.
pub fn is_web(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// The guard: a plugin whose only hook is `on_navigation`.
pub fn guard<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("light-navigation")
        .on_navigation(|webview, url| {
            let dev = tauri::is_dev()
                .then(|| webview.config().build.dev_url.clone())
                .flatten();
            if is_own(url, dev.as_ref()) {
                return true;
            }
            if is_web(url) {
                // **Off this thread, never inside the hook.** On Android the hook runs on the UI
                // thread (wry's `shouldOverrideUrlLoading`), and the opener's mobile arm blocks
                // until the UI thread's looper runs its Kotlin command — a deadlock, the first
                // web link freezing the app (found in review, 2026-10-03).
                let app = webview.app_handle().clone();
                let target = url.to_string();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(e) = app.opener().open_url(target, None::<&str>) {
                        eprintln!("could not hand a link to the browser: {e}");
                    }
                });
            } else {
                eprintln!("navigation to a {} link refused", url.scheme());
            }
            false
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn the_app_s_own_pages_stay_in_the_window() {
        assert!(is_own(&url("http://tauri.localhost/decks/12?card=x"), None));
        assert!(is_own(&url("https://tauri.localhost/"), None));
        assert!(is_own(&url("tauri://localhost/search"), None));
        assert!(is_own(&url("about:blank"), None));
    }

    #[test]
    fn the_dev_server_is_own_only_in_a_dev_build_and_wherever_the_cli_put_it() {
        let dev = url("http://localhost:5175");
        assert!(is_own(&url("http://localhost:5175/search"), Some(&dev)));
        assert!(!is_own(&url("http://localhost:5175/search"), None));
        // `tauri android dev` may serve from the machine's address instead.
        let lan = url("http://192.168.1.20:5175");
        assert!(is_own(&url("http://192.168.1.20:5175/decks"), Some(&lan)));
        assert!(!is_own(&url("http://192.168.1.20:5175/decks"), Some(&dev)));
    }

    #[test]
    fn a_shop_or_a_lookalike_leaves_for_the_browser() {
        for u in [
            "https://scryfall.com/card/mh2/267",
            "https://www.cardkingdom.com/",
            "http://tauri.localhost.evil.example/",
            "http://localhost:1420/",
        ] {
            let u = url(u);
            assert!(!is_own(&u, Some(&url("http://localhost:5175"))), "{u}");
            assert!(is_web(&u), "{u}");
        }
    }

    #[test]
    fn a_link_that_is_not_the_web_goes_nowhere() {
        for u in [
            "file:///sdcard/x",
            "intent://scan#Intent;end",
            "javascript:alert(1)",
        ] {
            let u = url(u);
            assert!(!is_own(&u, None));
            assert!(!is_web(&u), "{u}");
        }
    }
}
