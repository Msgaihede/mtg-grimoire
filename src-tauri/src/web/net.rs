//! Fetching, in a browser.
//!
//! **Not [`crate::scryfall::Client`], and not a port of it.** That client sets a `user_agent`,
//! a `connect_timeout` and a `read_timeout` on `reqwest::ClientBuilder` — none of which the
//! wasm backend has — paces itself against a `tokio::time::Instant`, and resumes a partial
//! download with `tokio::fs`. A browser can do none of it: `User-Agent` is a **forbidden
//! header** for `fetch`, there are no timeouts to set on it, and OPFS has no partial-file
//! resume story. So this is a handful of free functions rather than a mangled `Client`.
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

/// GET, answering the status code and the body **whatever the status is**.
///
/// The deliberate opposite of [`get`], and it exists for one caller: an update check has to
/// tell a 404, a 403 and a 500 apart, because `update::classify_status` says three different
/// things about them and only one of the three is an error the reader is shown. [`get`]'s
/// "a non-2xx is not bytes" rule is right for a bulk download and wrong here.
///
/// `headers` is a slice of pairs rather than a builder, because the one caller sends two
/// constants. **`X-GitHub-Api-Version` is not a CORS-safelisted request header**, so sending
/// it turns this into a preflighted request — probed against the live endpoint 2026-08-31:
/// the `OPTIONS` answers `204` with `access-control-allow-headers` naming it and
/// `access-control-max-age: 86400`, and the preflight carries no `X-RateLimit-*` of its own.
/// One extra round trip a day against a check that is throttled to one a day.
///
/// **`User-Agent` is not on this list and cannot be.** `fetch` forbids setting it, and GitHub
/// refuses a request that carries none — `403`, with a body naming the rule (measured
/// 2026-08-31). What saves this is that the browser sends its *own*, which is a real UA and
/// answers `200`; it simply is not the app-identifying one the desktop sends. That is the
/// same trade this module's header already records for Scryfall.
pub async fn get_with_status(url: &str, headers: &[(&str, &str)]) -> Result<(u16, String), String> {
    let mut request = reqwest::Client::new().get(url);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let resp = request
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;
    let code = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("could not read {url}: {e}"))?;
    Ok((code, body))
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
