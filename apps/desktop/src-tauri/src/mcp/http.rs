//! The listener, and what a request must be before anything reads it.
//!
//! **MCP's streamable HTTP transport, the part of it a local tool server needs**: one endpoint,
//! `POST /mcp`, carrying a JSON-RPC message (or a batch) and answered with one `application/json`
//! body — or `202 Accepted` and no body for a message that wants no answer. The transport lets a
//! server answer with an SSE stream instead and open one on `GET`; this one never does, so `GET`
//! is `405`, which the specification names as the answer of a server that offers no stream. No
//! session id is issued: every tool call is self-contained, so there is no state for one to name.
//!
//! **The gates, in the order a request meets them** ([`gate`]) — each a refusal before the body is
//! read, and the first three before the token is looked at, because they are about *who could have
//! sent this* rather than whether they know the secret:
//!
//! 1. **`Host` is the loopback and this port.** A page on `evil.example` whose name its owner
//!    re-pointed at `127.0.0.1` (DNS rebinding) reaches this socket with `Host: evil.example` —
//!    the one header a browser will not let the page forge. MCP's transport section requires this.
//! 2. **`Origin`, when there is one, is the loopback.** A browser sends it on every cross-origin
//!    `POST`, and no MCP client outside a browser does. With no CORS header ever sent, a page could
//!    not read an answer anyway — and the token's `Authorization` header makes every such request
//!    preflighted, and the preflight is refused here too — but a write needs no answer read, so
//!    this one is refused rather than reasoned about.
//! 3. **The path and the method.**
//! 4. **`Authorization: Bearer <token>`**, compared in constant time ([`super::Gate::admits`]).
//! 5. **The body is at most [`MAX_BODY`]**, counted as it arrives rather than trusted from a
//!    `Content-Length`.

use super::{rpc, Gate};
use crate::sync::AppState;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{HeaderMap, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use std::convert::Infallible;
use std::sync::Arc;

/// The largest request body read. A tool call is a few hundred bytes; a megabyte is room for any
/// batch a client could reasonably send and small enough that a hostile one costs nothing.
pub const MAX_BODY: usize = 1024 * 1024;

/// The path a client is configured with — [`super::url_of`]'s.
pub const PATH: &str = "/mcp";

/// Accept connections until the task is aborted, serving each on a task of its own.
///
/// HTTP/1.1 only, keep-alive on: an agent sends a burst of calls over one connection. A connection
/// that outlives a stop is refused request by request ([`Gate::stopped`]), since aborting this loop
/// does not reach the tasks it spawned.
pub async fn serve(listener: tokio::net::TcpListener, state: Arc<AppState>, gate: Arc<Gate>) {
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(accepted) => accepted,
            // A transient failure (out of descriptors, a reset before accept) is that one
            // connection's: keep listening, after a beat so a persistent one is not a hot loop.
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
        };
        let state = state.clone();
        let gate = gate.clone();
        tauri::async_runtime::spawn(async move {
            let service = hyper::service::service_fn(move |req| {
                let state = state.clone();
                let gate = gate.clone();
                async move { Ok::<_, Infallible>(answer(req, state, gate).await) }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                .await;
        });
    }
}

/// One request, start to finish.
async fn answer(
    req: Request<Incoming>,
    state: Arc<AppState>,
    gate: Arc<Gate>,
) -> Response<Full<Bytes>> {
    if let Err(refusal) = gate_request(req.method(), req.uri().path(), req.headers(), &gate) {
        return refusal.into_response();
    }
    if let Some(version) = req.headers().get("mcp-protocol-version") {
        let known = version
            .to_str()
            .is_ok_and(|v| rpc::SUPPORTED_VERSIONS.contains(&v));
        if !known {
            return plain(StatusCode::BAD_REQUEST, "Unsupported MCP-Protocol-Version.");
        }
    }
    let body = match Limited::new(req.into_body(), MAX_BODY).collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(_) => {
            return plain(
                StatusCode::PAYLOAD_TOO_LARGE,
                "The request body is too large.",
            )
        }
    };
    match rpc::handle(&state, &body).await {
        rpc::Outcome::Answer(json) => {
            let mut response = Response::new(Full::new(Bytes::from(json)));
            response
                .headers_mut()
                .insert("content-type", HeaderValue::from_static("application/json"));
            response
        }
        rpc::Outcome::Accepted => empty(StatusCode::ACCEPTED),
        rpc::Outcome::Malformed(json) => {
            let mut response = Response::new(Full::new(Bytes::from(json)));
            *response.status_mut() = StatusCode::BAD_REQUEST;
            response
                .headers_mut()
                .insert("content-type", HeaderValue::from_static("application/json"));
            response
        }
    }
}

/// Why a request was turned away before its body was read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The listener has been stopped; a keep-alive connection from before is still open.
    Stopped,
    /// `Host` is not this loopback port — DNS rebinding, or a client pointed at the wrong place.
    Host,
    /// `Origin` is a web page's.
    Origin,
    NotFound,
    /// Anything but `POST` — `GET` included, since no stream is offered.
    Method,
    /// No token, or the wrong one.
    Token,
}

impl Refusal {
    pub fn status(self) -> StatusCode {
        match self {
            Refusal::Stopped => StatusCode::SERVICE_UNAVAILABLE,
            Refusal::Host | Refusal::Origin => StatusCode::FORBIDDEN,
            Refusal::NotFound => StatusCode::NOT_FOUND,
            Refusal::Method => StatusCode::METHOD_NOT_ALLOWED,
            Refusal::Token => StatusCode::UNAUTHORIZED,
        }
    }

    fn into_response(self) -> Response<Full<Bytes>> {
        let mut response = plain(
            self.status(),
            match self {
                Refusal::Stopped => "The MCP server was switched off in MTG Grimoire.",
                Refusal::Host => "This server answers only on 127.0.0.1.",
                Refusal::Origin => "This server does not answer web pages.",
                Refusal::NotFound => "The MCP endpoint is /mcp.",
                Refusal::Method => "This endpoint takes POST only.",
                Refusal::Token => {
                    "Missing or wrong token. Copy it from MTG Grimoire: Settings → Integrations."
                }
            },
        );
        match self {
            Refusal::Method => {
                response
                    .headers_mut()
                    .insert("allow", HeaderValue::from_static("POST"));
            }
            Refusal::Token => {
                response.headers_mut().insert(
                    "www-authenticate",
                    HeaderValue::from_static("Bearer realm=\"mtg-grimoire\""),
                );
            }
            _ => {}
        }
        response
    }
}

/// The gates, in order — the module doc says why that order. Pure, so the tests can walk every
/// refusal without a socket.
pub fn gate_request(
    method: &Method,
    path: &str,
    headers: &HeaderMap,
    gate: &Gate,
) -> Result<(), Refusal> {
    if gate.stopped() {
        return Err(Refusal::Stopped);
    }
    let host = headers.get("host").and_then(|h| h.to_str().ok());
    if !host.is_some_and(|h| loopback_authority(h, Some(gate.port))) {
        return Err(Refusal::Host);
    }
    if let Some(origin) = headers.get("origin") {
        let local = origin
            .to_str()
            .ok()
            .and_then(|o| o.strip_prefix("http://"))
            .is_some_and(|authority| loopback_authority(authority, None));
        if !local {
            return Err(Refusal::Origin);
        }
    }
    if path != PATH {
        return Err(Refusal::NotFound);
    }
    if method != Method::POST {
        return Err(Refusal::Method);
    }
    let presented = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| {
            let (scheme, token) = h.trim().split_once(' ')?;
            scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
        });
    if !presented.is_some_and(|token| gate.admits(token)) {
        return Err(Refusal::Token);
    }
    Ok(())
}

/// Whether `authority` (`host[:port]`) names the loopback — `127.0.0.1`, `localhost` or `[::1]` —
/// and, when `port` is given, that port exactly. A `Host` must carry the port, since the listener
/// is not on 80; an `Origin` may be any loopback page (a local inspector), so its port is not asked.
pub fn loopback_authority(authority: &str, port: Option<u16>) -> bool {
    let (host, named_port) = match authority.rsplit_once(':') {
        // `[::1]:39147` splits at the last colon; a bare `[::1]` has its colon inside brackets.
        Some((host, p)) if !p.ends_with(']') => (host, p.parse::<u16>().ok()),
        _ => (authority, None),
    };
    let host = host.to_ascii_lowercase();
    let loopback = matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]");
    loopback
        && match port {
            Some(port) => named_port == Some(port),
            None => true,
        }
}

fn plain(status: StatusCode, text: &'static str) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from_static(text.as_bytes())));
    *response.status_mut() = status;
    response.headers_mut().insert(
        "content-type",
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

fn empty(status: StatusCode) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = status;
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    const PORT: u16 = 39147;

    fn token() -> String {
        "ab".repeat(32)
    }

    fn gate() -> Gate {
        Gate::new(PORT, token())
    }

    fn headers(pairs: &[(&'static str, String)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    fn good() -> Vec<(&'static str, String)> {
        vec![
            ("host", format!("127.0.0.1:{PORT}")),
            ("authorization", format!("Bearer {}", token())),
        ]
    }

    fn check(method: Method, path: &str, pairs: &[(&'static str, String)]) -> Result<(), Refusal> {
        gate_request(&method, path, &headers(pairs), &gate())
    }

    #[test]
    fn a_client_with_the_token_on_the_loopback_is_let_in() {
        assert_eq!(check(Method::POST, PATH, &good()), Ok(()));
        let mut lower = good();
        lower[1].1 = format!("bearer {}", token());
        assert_eq!(check(Method::POST, PATH, &lower), Ok(()));
        let mut named = good();
        named[0].1 = format!("localhost:{PORT}");
        assert_eq!(check(Method::POST, PATH, &named), Ok(()));
    }

    #[test]
    fn a_rebound_name_is_refused_before_the_token_is_looked_at() {
        let mut pairs = good();
        pairs[0].1 = format!("evil.example:{PORT}");
        assert_eq!(check(Method::POST, PATH, &pairs), Err(Refusal::Host));
        pairs[0].1 = "127.0.0.1".into();
        assert_eq!(check(Method::POST, PATH, &pairs), Err(Refusal::Host));
        pairs[0].1 = "127.0.0.1:1".into();
        assert_eq!(check(Method::POST, PATH, &pairs), Err(Refusal::Host));
        assert_eq!(
            check(Method::POST, PATH, &good()[1..]),
            Err(Refusal::Host),
            "no Host at all"
        );
    }

    #[test]
    fn a_web_page_is_refused_and_a_local_inspector_is_not() {
        let mut pairs = good();
        pairs.push(("origin", "https://evil.example".into()));
        assert_eq!(check(Method::POST, PATH, &pairs), Err(Refusal::Origin));
        pairs.last_mut().unwrap().1 = "null".into();
        assert_eq!(check(Method::POST, PATH, &pairs), Err(Refusal::Origin));
        pairs.last_mut().unwrap().1 = "https://localhost:6274".into();
        assert_eq!(
            check(Method::POST, PATH, &pairs),
            Err(Refusal::Origin),
            "https is never this server's own scheme"
        );
        pairs.last_mut().unwrap().1 = "http://localhost:6274".into();
        assert_eq!(check(Method::POST, PATH, &pairs), Ok(()));
    }

    #[test]
    fn only_post_to_the_endpoint_is_answered() {
        assert_eq!(check(Method::GET, PATH, &good()), Err(Refusal::Method));
        assert_eq!(check(Method::DELETE, PATH, &good()), Err(Refusal::Method));
        assert_eq!(check(Method::OPTIONS, PATH, &good()), Err(Refusal::Method));
        assert_eq!(check(Method::POST, "/", &good()), Err(Refusal::NotFound));
        assert_eq!(
            check(Method::POST, "/mcp/", &good()),
            Err(Refusal::NotFound)
        );
    }

    #[test]
    fn a_missing_or_wrong_token_is_refused() {
        assert_eq!(check(Method::POST, PATH, &good()[..1]), Err(Refusal::Token));
        let mut pairs = good();
        pairs[1].1 = format!("Bearer {}", "cd".repeat(32));
        assert_eq!(check(Method::POST, PATH, &pairs), Err(Refusal::Token));
        pairs[1].1 = format!("Basic {}", token());
        assert_eq!(check(Method::POST, PATH, &pairs), Err(Refusal::Token));
        pairs[1].1 = "Bearer".into();
        assert_eq!(check(Method::POST, PATH, &pairs), Err(Refusal::Token));
    }

    #[test]
    fn a_stopped_listener_refuses_everything() {
        let gate = gate();
        gate.stop();
        assert_eq!(
            gate_request(&Method::POST, PATH, &headers(&good()), &gate),
            Err(Refusal::Stopped)
        );
    }

    #[test]
    fn the_loopback_is_named_three_ways() {
        assert!(loopback_authority("127.0.0.1:39147", Some(39147)));
        assert!(loopback_authority("LOCALHOST:39147", Some(39147)));
        assert!(loopback_authority("[::1]:39147", Some(39147)));
        assert!(loopback_authority("[::1]", None));
        assert!(!loopback_authority("[::1]", Some(39147)));
        assert!(!loopback_authority("127.0.0.2:39147", Some(39147)));
        assert!(!loopback_authority(
            "localhost.evil.example:39147",
            Some(39147)
        ));
    }

    /// A response's body as JSON — this crate's `reqwest` has no `json` feature.
    async fn read(response: reqwest::Response) -> serde_json::Value {
        serde_json::from_slice(&response.bytes().await.unwrap()).unwrap()
    }

    /// The whole path over a real socket — hyper, the gates, JSON-RPC and a tool against a real
    /// database: a client's handshake, its notification, its tool list and a call; then a client
    /// without the token, a `GET`, and a request after the switch went off.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_client_is_answered_over_a_real_socket() {
        let state = crate::mcp::testing::state("http-socket");
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        let gate = Arc::new(Gate::new(port, token()));
        let server = tokio::spawn(serve(listener, state, gate.clone()));

        // `no_proxy`: the sandbox this runs in may route outbound HTTP through a proxy, and the
        // loopback is never what a proxy is for.
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let url = crate::mcp::url_of(port);
        let bearer = format!("Bearer {}", token());
        let post = |body: serde_json::Value, auth: bool| {
            let mut request = client
                .post(&url)
                .header("content-type", "application/json")
                .body(body.to_string());
            if auth {
                request = request.header("authorization", &bearer);
            }
            request.send()
        };

        let hello = post(
            serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": "2025-06-18", "capabilities": {},
                    "clientInfo": { "name": "test", "version": "0" } } }),
            true,
        )
        .await
        .unwrap();
        assert_eq!(hello.status(), StatusCode::OK);
        assert_eq!(
            hello.headers()["content-type"],
            "application/json",
            "one JSON body, never a stream"
        );
        let hello = read(hello).await;
        assert_eq!(hello["id"], 1);
        assert_eq!(hello["result"]["protocolVersion"], "2025-06-18");

        let initialized = post(
            serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            true,
        )
        .await
        .unwrap();
        assert_eq!(initialized.status(), StatusCode::ACCEPTED);

        let listed = post(
            serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
            true,
        )
        .await
        .map(read)
        .unwrap()
        .await;
        assert_eq!(listed["result"]["tools"].as_array().unwrap().len(), 10);

        let called = post(
            serde_json::json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": { "name": "search_collection", "arguments": {} } }),
            true,
        )
        .await
        .map(read)
        .unwrap()
        .await;
        assert_eq!(called["result"]["isError"], false, "{called}");
        let text = called["result"]["content"][0]["text"].as_str().unwrap();
        let answer: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(answer["total"], 0);

        let stranger = post(
            serde_json::json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/list" }),
            false,
        )
        .await
        .unwrap();
        assert_eq!(stranger.status(), StatusCode::UNAUTHORIZED);
        assert!(stranger.headers().contains_key("www-authenticate"));

        let get = client
            .get(&url)
            .header("authorization", &bearer)
            .send()
            .await
            .unwrap();
        assert_eq!(get.status(), StatusCode::METHOD_NOT_ALLOWED);

        let garbage = client
            .post(&url)
            .header("authorization", &bearer)
            .body("{not json")
            .send()
            .await
            .unwrap();
        assert_eq!(garbage.status(), StatusCode::BAD_REQUEST);

        gate.stop();
        let after = post(
            serde_json::json!({ "jsonrpc": "2.0", "id": 5, "method": "ping" }),
            true,
        )
        .await
        .unwrap();
        assert_eq!(after.status(), StatusCode::SERVICE_UNAVAILABLE);
        server.abort();
    }
}
