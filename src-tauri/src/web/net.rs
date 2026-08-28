//! Fetching, in a browser.
//!
//! **Not [`crate::scryfall::Client`], and not a port of it.** That client sets a `user_agent`,
//! a `connect_timeout` and a `read_timeout` on `reqwest::ClientBuilder` — none of which the
//! wasm backend has — paces itself against a `tokio::time::Instant`, and resumes a partial
//! download with `tokio::fs`. A browser can do none of it: `User-Agent` is a **forbidden
//! header** for `fetch`, there are no timeouts to set on it, and OPFS has no partial-file
//! resume story. So this is two functions rather than a mangled `Client`.
//!
//! **What that costs, said out loud.** The browser sends its own `User-Agent` rather than
//! the app-identifying string the desktop sends. That is a real UA rather than an absent
//! one — which is what Scryfall's rule is actually about — but it is not ours, and the
//! desktop's rate-limit pacing and 429 penalty do not exist here. Both are owed work; both
//! belong with the sync port rather than with the first build that reaches the network.
//!
//! Both Scryfall hosts answer `Access-Control-Allow-Origin: *` (verified 2026-08-27), which
//! is the only reason "every platform builds its own corpus" is possible at all.

/// GET, refusing anything that is not a success status.
///
/// A non-2xx is an error here rather than a body the caller has to check, because every
/// caller in this module wants bytes and an error page is not bytes.
pub async fn get(url: &str) -> Result<reqwest::Response, String> {
    let resp = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{url} answered {}", resp.status()));
    }
    Ok(resp)
}

/// GET and parse a JSON document.
///
/// `.text()` then serde rather than `.json()`: the latter needs reqwest's `json` feature,
/// and this crate's reqwest line is `default-features = false, features = ["rustls-tls",
/// "stream"]` on every target — which is the line the spike proved compiles for wasm.
pub async fn get_json(url: &str) -> Result<serde_json::Value, String> {
    let text = get(url)
        .await?
        .text()
        .await
        .map_err(|e| format!("could not read {url}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("{url} did not answer JSON: {e}"))
}
