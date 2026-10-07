//! A request and a streamed body.
//!
//! **`reqwest` on both arms.** On the native hosts it is the client this app has always used —
//! rustls, a connect bound and a per-read bound. In a browser `reqwest` is `fetch`: its own
//! wasm backend, so what is here is one implementation and the two places a host differs
//! are the two a browser has no word for. **A browser has no socket**, so there is no connect
//! timeout and no per-read timeout to set, and a failure to connect is not distinguishable from
//! any other failed request. Both differences are in this file and nowhere else.
//!
//! **What is deliberately not here**: pacing, retry, the 429 lockout, the size checks. Those are
//! rules about *Scryfall* and about each feed, and they live with the client that owns them
//! (`scryfall::Client::api_send`). This is the wire and nothing above it.
//!
//! **No `gzip` feature, on purpose**: Scryfall's bulk data is a real `.gz` *file*, not a
//! `Content-Encoding`, and transparent decompression would corrupt the download. A browser's
//! `fetch` decodes a `Content-Encoding: gzip` body whether asked or not, which is why the feed
//! readers sniff the gzip magic off the first chunk (`feed::frame::Decoder`) and never trust a
//! header.
//!
//! **In a browser every request is a cross-origin `fetch`**, and what that costs was measured
//! against the real hosts on 2026-10-04 ([`super::host`] has the three rules, and
//! `docs/reference/light-app.md` §9.1 the table): a request header outside the safelist
//! (`If-None-Match`, `If-Modified-Since`) costs a pre-flight that the bulk hosts refuse, and a
//! response header nobody exposes (`ETag`, `Retry-After`, `Content-Range`) reads as absent
//! from [`Response::header`]. So a bulk check there stores no ETag, a 429 falls back to its
//! default thirty seconds and nothing is resumed. **No `User-Agent` is set there either**: a
//! page may not choose one — Chromium drops a script-set one in silence, and an engine that
//! sends it pre-flights the request for it, which `data.scryfall.io` answers 403 — so the
//! browser's own is what every host sees.
//!
//! **A wait with a bound, where the host has none**: [`Request::send_within`] and
//! [`Body::chunk_within`] give up on an answer, or on the next chunk, that has not come inside
//! a stall bound. Natively the client's read timeout already ends such a request; in a browser
//! nothing does, and these are the only bound a streamed body has there. One implementation
//! on every host, over [`super::timer`], so a native test can make one fire.
//!
//! **A browser first made requests through this module on 2026-10-04**: headless Chrome 154
//! ran a whole first run through it — the card file, both tagger files, the combos and Card
//! Kingdom's list, all answered 200 with no conditional header sent
//! (`docs/reference/light-app.md` §9.2). What that run did not make is a stall.

use std::time::Duration;

/// What a client is built from. The two timeouts are honoured where the host has sockets.
#[derive(Debug, Clone, Copy)]
pub struct Config<'a> {
    /// Sent on every request a native host makes. **Not sent from a browser**, where a page
    /// may not choose it: the engine's own goes out instead (the module doc has why).
    pub user_agent: &'a str,
    /// Bounds a dead host, not a slow one.
    pub connect_timeout: Option<Duration>,
    /// Bounds the gap between two reads, not the length of a download.
    pub read_timeout: Option<Duration>,
    /// **Refuse anything that is not HTTPS — the request itself, and every hop of a redirect.**
    /// For a client that follows a host's redirect to wherever that host names
    /// (`scanner_assets`, after GitHub's): the default policy follows up to ten hops to any
    /// address, and with this set a hop to `http://` ends the request as an error instead of
    /// being followed, so no byte of a file is ever read over a link that is not encrypted.
    /// `false` for every client whose address is one constant it is tested against over a
    /// local server.
    ///
    /// Natively it is `reqwest`'s `https_only`. **In a browser nothing is set**, because a page
    /// has nothing to set: one served over HTTPS may not `fetch` an `http://` address at all —
    /// the engine's own mixed-content rule blocks the request, and a redirect to one — and the
    /// web app is served over nothing else.
    pub https_only: bool,
}

/// A client: one connection pool, one `User-Agent`. Cloning it shares both.
#[derive(Debug, Clone)]
pub struct Client(reqwest::Client, Option<Duration>);

impl Client {
    pub fn new(config: &Config<'_>) -> Client {
        Client(imp::build(config), None)
    }

    /// **A deadline on every request this client makes, where the host has no socket to bound**
    /// — a browser, whose `fetch` has no connect phase and no per-read timeout, so a host that
    /// never answers is otherwise never given up on. Natively it is not applied: the connect and
    /// read bounds already end a request that stops answering, and a whole-request deadline
    /// there would also end one that is merely long.
    ///
    /// The sync client asks for one, because the sync *lane* is held across its requests and a
    /// departure waits for the lane: a request that never ended would be a Leave that never
    /// ran. The bulk downloads do not, because a deadline long enough for one is no deadline.
    pub fn deadline(self, deadline: Duration) -> Client {
        Client(self.0, Some(deadline))
    }

    pub fn get(&self, url: &str) -> Request {
        Request(imp::deadline(self.0.get(url), self.1))
    }

    /// The sync client's verb: a JSON body written by hand, `content-type` set by the caller.
    pub fn post(&self, url: &str) -> Request {
        Request(imp::deadline(self.0.post(url), self.1))
    }
}

/// A request being built.
#[derive(Debug)]
pub struct Request(reqwest::RequestBuilder);

impl Request {
    pub fn header(self, name: &str, value: &str) -> Request {
        Request(self.0.header(name, value))
    }

    /// The body, as text the caller has already serialised.
    pub fn body(self, body: String) -> Request {
        Request(self.0.body(body))
    }

    /// Send it. Any status is an `Ok`: reading 304, 404 and 429 is the caller's.
    pub async fn send(self) -> Result<Response, Error> {
        self.0.send().await.map(Response).map_err(Error::wire)
    }

    /// [`Request::send`], giving up when no answer has begun inside `stall` — the response's
    /// status and headers, not its body, which [`Body::chunk_within`] bounds a chunk at a
    /// time. The request is dropped, which in a browser aborts the `fetch`.
    ///
    /// For a host with no connect or read bound of its own. A native client has both, so a
    /// caller there has no need of it — and it is the same code there, which is what lets a
    /// test see it fire.
    pub async fn send_within(self, stall: Duration) -> Result<Response, Error> {
        within(stall, self.send())
            .await
            .unwrap_or(Err(Error::stalled(stall)))
    }
}

/// How much longer a wait is given once its stall bound has passed, before it is called a
/// stall — the **second look**.
///
/// **A timer on a host with one thread counts whatever that thread was doing**, not only how
/// long the network was quiet. While a download waits for its next chunk with sixty seconds
/// on the clock, anything else on the Worker can run a long synchronous stretch — a command
/// a page sent, another download's swap or index build — and the event loop does not turn
/// until it returns. If that stretch outlasts the bound, the timer is already due when the
/// loop resumes, and so is the chunk that arrived in the meantime; which of the two the
/// engine runs first is its own business. Timer first, and a healthy download would be
/// reported as stalled by a wait that never saw the network at all.
///
/// So a deadline that fires is not believed at once: the same wait is given this much longer,
/// which is at least one turn of the event loop — and a chunk that was already delivered is
/// seen in it. Only a wait that is still empty after that is a stall. A second, against a
/// bound of sixty: it changes nothing a reader can feel, and it is long enough that "the
/// chunk was queued behind the timer" cannot be what a stall means.
pub const SECOND_LOOK: Duration = Duration::from_secs(1);

/// `wait`, given up on after `stall` and then [`SECOND_LOOK`] — the one implementation of
/// both stall bounds. **The wait is not dropped between the two**, so a request is not
/// aborted and re-sent, and a body loses no chunk: it is polled again where it stood.
async fn within<F: std::future::Future>(stall: Duration, wait: F) -> Option<F::Output> {
    let mut wait = std::pin::pin!(wait);
    if let Some(answer) = super::timer::timeout(stall, wait.as_mut()).await {
        return Some(answer);
    }
    super::timer::timeout(SECOND_LOOK, wait).await
}

/// A response whose body has not been read yet.
#[derive(Debug)]
pub struct Response(reqwest::Response);

impl Response {
    pub fn status(&self) -> u16 {
        self.0.status().as_u16()
    }

    /// One header, when it is there, is text, **and may be read**: in a browser a response
    /// header the server did not expose is not there to read, and on a thread standing in for
    /// a page ([`super::host::emulate_page`]) it is hidden the same way — so a test that
    /// passes there has not leaned on an `ETag` a browser would never have seen.
    pub fn header(&self, name: &str) -> Option<&str> {
        if super::host::emulated() && !a_page_may_read(name) {
            return None;
        }
        self.0.headers().get(name).and_then(|v| v.to_str().ok())
    }

    /// What the response *claims* its body's length is. A chunked response claims nothing.
    pub fn content_length(&self) -> Option<u64> {
        self.0.content_length()
    }

    /// The whole body, in memory. For a body whose size is not the caller's to trust, read
    /// [`Response::into_body`] against a running total instead.
    pub async fn bytes(self) -> Result<Vec<u8>, Error> {
        self.0.bytes().await.map(Vec::from).map_err(Error::wire)
    }

    /// The whole body as text, decoded as the response says it is — the relay's small JSON
    /// answers. A body that is not text is [`Error::is_decode`].
    pub async fn text(self) -> Result<String, Error> {
        self.0.text().await.map_err(Error::wire)
    }

    /// The body as a stream of chunks.
    pub fn into_body(self) -> Body {
        Body(Box::pin(self.0.bytes_stream()))
    }
}

/// A response body, a chunk at a time.
pub struct Body(imp::Stream);

impl Body {
    /// The next chunk, or `None` at the end of the body.
    pub async fn chunk(&mut self) -> Option<Result<bytes::Bytes, Error>> {
        use futures_util::StreamExt as _;
        self.0.next().await.map(|r| r.map_err(Error::wire))
    }

    /// [`Body::chunk`], giving up when the next chunk has not come inside `stall` — **a bound
    /// on the gap between two chunks and never on the length of the body**, which is the only
    /// kind a 78 MB download can be given. The body is then finished as far as its caller is
    /// concerned: dropping it is what cancels the request.
    ///
    /// What a browser has in place of a read timeout ([`Request::send_within`] has the rest).
    ///
    /// **The bound is on how long nothing arrived, and it is not taken on a timer's word
    /// alone**: a deadline that fires is followed by a second look ([`SECOND_LOOK`]), so a
    /// chunk that was delivered while this thread was busy with something else is handed over
    /// rather than reported as a stall.
    pub async fn chunk_within(&mut self, stall: Duration) -> Option<Result<bytes::Bytes, Error>> {
        within(stall, self.chunk())
            .await
            .unwrap_or(Some(Err(Error::stalled(stall))))
    }
}

/// The response headers a cross-origin `fetch` may read with nobody exposing them — the CORS
/// safelist. [`Response::header`] hides the rest on a thread standing in for a page.
fn a_page_may_read(name: &str) -> bool {
    const SAFELISTED: [&str; 7] = [
        "cache-control",
        "content-language",
        "content-length",
        "content-type",
        "expires",
        "last-modified",
        "pragma",
    ];
    SAFELISTED.iter().any(|h| h.eq_ignore_ascii_case(name))
}

/// A request that did not get an answer, or a body that stopped arriving.
///
/// A failure of the wire prints as `reqwest`'s own error does, so a sentence in `error_log`
/// reads as it always has; a stall says how long nothing came for.
#[derive(Debug, thiserror::Error)]
#[error(transparent)]
pub struct Error(Failure);

#[derive(Debug, thiserror::Error)]
enum Failure {
    #[error(transparent)]
    Wire(reqwest::Error),
    /// [`Request::send_within`] or [`Body::chunk_within`] gave up.
    #[error("the download stalled: nothing arrived for {0:?}")]
    Stalled(Duration),
}

impl Error {
    fn wire(e: reqwest::Error) -> Error {
        Error(Failure::Wire(e))
    }

    fn stalled(after: Duration) -> Error {
        Error(Failure::Stalled(after))
    }

    /// A deadline passed — the connect bound, the read bound, the whole-request one, or a
    /// stall bound.
    pub fn is_timeout(&self) -> bool {
        match &self.0 {
            Failure::Wire(e) => e.is_timeout(),
            Failure::Stalled(_) => true,
        }
    }

    /// The connection never came up. Always `false` in a browser, which does not say.
    pub fn is_connect(&self) -> bool {
        matches!(&self.0, Failure::Wire(e) if imp::is_connect(e))
    }

    /// The request could not be sent at all.
    pub fn is_request(&self) -> bool {
        matches!(&self.0, Failure::Wire(e) if e.is_request())
    }

    /// A body arrived and could not be read as what it was asked for.
    pub fn is_decode(&self) -> bool {
        matches!(&self.0, Failure::Wire(e) if e.is_decode())
    }

    /// A wait this module bounded ran out — [`Request::send_within`], [`Body::chunk_within`].
    pub fn is_stall(&self) -> bool {
        matches!(&self.0, Failure::Stalled(_))
    }
}

#[cfg(not(target_family = "wasm"))]
mod imp {
    use super::Config;
    use std::pin::Pin;

    pub type Stream =
        Pin<Box<dyn futures_util::Stream<Item = reqwest::Result<bytes::Bytes>> + Send>>;

    pub fn build(config: &Config<'_>) -> reqwest::Client {
        let mut builder = reqwest::Client::builder().user_agent(config.user_agent);
        if let Some(d) = config.connect_timeout {
            builder = builder.connect_timeout(d);
        }
        if let Some(d) = config.read_timeout {
            builder = builder.read_timeout(d);
        }
        builder
            .https_only(config.https_only)
            .build()
            .expect("client")
    }

    pub fn is_connect(e: &reqwest::Error) -> bool {
        e.is_connect()
    }

    /// Not applied: see [`super::Client::deadline`].
    pub fn deadline(
        request: reqwest::RequestBuilder,
        _deadline: Option<std::time::Duration>,
    ) -> reqwest::RequestBuilder {
        request
    }
}

#[cfg(target_family = "wasm")]
mod imp {
    use super::Config;
    use std::pin::Pin;

    /// Not `Send`: a browser's futures hold JavaScript values, which belong to one thread.
    pub type Stream = Pin<Box<dyn futures_util::Stream<Item = reqwest::Result<bytes::Bytes>>>>;

    /// No timeout is set: `fetch` has no connect phase to bound and no per-read one. A caller
    /// that must not wait for ever gives its client a [`super::Client::deadline`], or bounds
    /// each wait with [`super::Request::send_within`] and [`super::Body::chunk_within`].
    ///
    /// **And no `User-Agent`**: a page may not choose one. Chromium drops a script-set one
    /// without a word; an engine that honours it has to pre-flight the request for it, and
    /// the bulk file hosts answer a pre-flight 403. The browser's own goes out instead.
    ///
    /// **Nor `https_only`**, which this backend has no switch for and no need of: the
    /// engine's mixed-content rule already refuses an `http://` request, and a redirect to
    /// one, from a page served over HTTPS ([`Config::https_only`]).
    pub fn build(_config: &Config<'_>) -> reqwest::Client {
        reqwest::Client::builder().build().expect("client")
    }

    pub fn is_connect(_e: &reqwest::Error) -> bool {
        false
    }

    /// `reqwest`'s own per-request timeout, which in a browser is an `AbortController`.
    pub fn deadline(
        request: reqwest::RequestBuilder,
        deadline: Option<std::time::Duration>,
    ) -> reqwest::RequestBuilder {
        match deadline {
            Some(d) => request.timeout(d),
            None => request,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::clock::Tick;
    use httpmock::prelude::*;

    fn client() -> Client {
        Client::new(&Config {
            user_agent: "test",
            connect_timeout: Some(Duration::from_secs(30)),
            read_timeout: Some(Duration::from_secs(60)),
            https_only: false,
        })
    }

    /// **A wait for an answer gives up after its stall bound, and so does a wait for the next
    /// chunk** — the two bounds a browser has in place of a connect and a read timeout. Each
    /// is a timeout, says it stalled, and returns in about the bound rather than at the
    /// host's leisure.
    #[tokio::test]
    async fn a_wait_gives_up_after_its_stall_bound() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/late");
            then.status(200).delay(Duration::from_secs(10)).body("late");
        });
        let stall = Duration::from_millis(200);

        let began = Tick::now();
        let never = client()
            .get(&server.url("/late"))
            .send_within(stall)
            .await
            .expect_err("no answer began inside the bound");
        assert!(never.is_timeout() && never.is_stall());
        assert_eq!(
            never.to_string(),
            "the download stalled: nothing arrived for 200ms"
        );
        assert!(began.elapsed() >= stall && began.elapsed() < Duration::from_secs(8));

        // A host that sends half a body and goes quiet with the connection open.
        let quiet = crate::feed::quiet_host::start(vec![1u8; 50], 100);
        let mut body = client()
            .get(&format!("{quiet}/half"))
            .send_within(Duration::from_secs(5))
            .await
            .expect("the answer begins at once")
            .into_body();
        let mut received = 0usize;
        let began = Tick::now();
        let stalled = loop {
            match body.chunk_within(stall).await {
                Some(Ok(chunk)) => received += chunk.len(),
                Some(Err(e)) => break e,
                None => panic!("the body never ends: the host is holding it open"),
            }
        };
        assert_eq!(received, 50, "what did arrive was handed over first");
        assert!(stalled.is_timeout() && stalled.is_stall());
        assert!(!stalled.is_connect() && !stalled.is_request() && !stalled.is_decode());
        assert!(began.elapsed() >= stall && began.elapsed() < Duration::from_secs(8));
    }

    /// **A deadline that fires is not a stall until a second look has found nothing.** The
    /// host sends half a body, is quiet for longer than the bound, and then sends the rest —
    /// which is what a chunk looks like when it was delivered while a one-thread host was
    /// busy elsewhere and its timer ran first: due after the bound, and there a moment
    /// later. The rest is handed over and the body ends where it said it would. Without the
    /// second look this is a stall after 300 ms.
    #[tokio::test]
    async fn a_chunk_that_is_there_a_moment_after_the_bound_is_not_a_stall() {
        let stall = Duration::from_millis(300);
        // Late by more than the bound and well inside the second look after it.
        let pause = Duration::from_millis(700);
        assert!(pause > stall && pause < stall + SECOND_LOOK);
        let late = crate::feed::quiet_host::start_pausing(vec![1u8; 50], pause, vec![2u8; 50]);
        let mut body = client()
            .get(&format!("{late}/late"))
            .send_within(Duration::from_secs(5))
            .await
            .expect("the answer begins at once")
            .into_body();

        let began = Tick::now();
        let mut received: Vec<u8> = Vec::new();
        while let Some(chunk) = body.chunk_within(stall).await {
            received.extend_from_slice(&chunk.expect("late, and not stalled"));
        }
        assert_eq!(received.len(), 100);
        assert!(
            received[..50].iter().all(|b| *b == 1) && received[50..].iter().all(|b| *b == 2),
            "nothing lost and nothing twice across the second look"
        );
        assert!(
            began.elapsed() >= stall,
            "the second half did come after the bound: {:?}",
            began.elapsed()
        );
    }

    /// **An HTTPS-only client asks nothing over plain HTTP, and follows no redirect to it.**
    /// The request to a plain-HTTP address is refused before it leaves — the server is never
    /// asked — and the same client without the switch is answered. The redirect's half is the
    /// same switch in `reqwest`'s redirect policy; it cannot be shown without a TLS server to
    /// be redirected *from*, so what is held here is the half that can.
    #[tokio::test]
    async fn an_https_only_client_refuses_a_plain_http_address_before_asking() {
        let server = MockServer::start();
        let asked = server.mock(|when, then| {
            when.method(GET).path("/file");
            then.status(200).body("body");
        });
        let secure = Client::new(&Config {
            user_agent: "test",
            connect_timeout: Some(Duration::from_secs(30)),
            read_timeout: Some(Duration::from_secs(60)),
            https_only: true,
        });
        let refused = secure
            .get(&server.url("/file"))
            .send()
            .await
            .expect_err("a plain-HTTP address");
        assert!(!refused.is_timeout() && !refused.is_connect());
        asked.assert_calls(0);

        assert_eq!(
            client()
                .get(&server.url("/file"))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        asked.assert_calls(1);
    }

    /// A body that keeps arriving is never ended by the bound, however long the whole of it
    /// takes: the bound is on a gap, not on a length.
    #[tokio::test]
    async fn a_body_that_keeps_arriving_is_read_to_its_end() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/whole");
            then.status(200).body(vec![9u8; 200_000]);
        });
        let mut body = client()
            .get(&server.url("/whole"))
            .send_within(Duration::from_secs(5))
            .await
            .unwrap()
            .into_body();
        let mut received = 0usize;
        while let Some(chunk) = body.chunk_within(Duration::from_secs(5)).await {
            received += chunk.unwrap().len();
        }
        assert_eq!(received, 200_000);
    }

    /// **On a thread standing in for a page, a response header nobody exposed is not there to
    /// read** — which is what a browser does to a cross-origin `fetch` by itself. The two a
    /// freshness check can still use are the safelisted ones.
    #[tokio::test]
    async fn a_page_reads_only_the_response_headers_cors_safelists() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/file");
            then.status(200)
                .header("etag", "\"abc\"")
                .header("retry-after", "7")
                .header("content-range", "bytes 0-3/4")
                .header("last-modified", "Sun, 04 Oct 2026 08:00:00 GMT")
                .body("body");
        });
        let ask = || async { client().get(&server.url("/file")).send().await.unwrap() };

        let native = ask().await;
        assert_eq!(native.header("etag"), Some("\"abc\""));
        assert_eq!(native.header("Retry-After"), Some("7"));
        assert_eq!(native.header("content-range"), Some("bytes 0-3/4"));

        let _page = crate::platform::host::emulate_page();
        let page = ask().await;
        assert_eq!(page.header("etag"), None);
        assert_eq!(page.header("ETag"), None);
        assert_eq!(page.header("retry-after"), None);
        assert_eq!(page.header("content-range"), None);
        assert_eq!(
            page.header("last-modified"),
            Some("Sun, 04 Oct 2026 08:00:00 GMT")
        );
        assert_eq!(page.header("Last-Modified"), page.header("last-modified"));
        assert_eq!(page.content_length(), Some(4));
        assert_eq!(page.status(), 200);
    }
}
