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
//! **The browser arm has never run, and CORS is the part nobody has measured.** CI's `core`
//! job compiles it for `wasm32-unknown-unknown`; the first thing to call it is phase 5's
//! Worker. A request there is cross-origin, so a request header outside the safelist
//! (`If-None-Match`, `Range`) costs a pre-flight, and a response header outside it (`ETag`,
//! `Retry-After`, `Content-Range`) reads as absent from [`Response::header`] unless the host
//! exposes it — in which case a bulk check stores no ETag, a 429 falls back to its default
//! thirty seconds and a resume is refused. Which of those Scryfall and the feeds expose is a
//! measurement for that phase, against the real hosts.

use std::time::Duration;

/// What a client is built from. The two timeouts are honoured where the host has sockets.
#[derive(Debug, Clone, Copy)]
pub struct Config<'a> {
    /// Sent on every request. **What a browser does with it has not been measured**: an
    /// engine may drop a script-set `User-Agent` and send its own, or send this one and
    /// pre-flight the request for it.
    pub user_agent: &'a str,
    /// Bounds a dead host, not a slow one.
    pub connect_timeout: Option<Duration>,
    /// Bounds the gap between two reads, not the length of a download.
    pub read_timeout: Option<Duration>,
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
        self.0.send().await.map(Response).map_err(Error)
    }
}

/// A response whose body has not been read yet.
#[derive(Debug)]
pub struct Response(reqwest::Response);

impl Response {
    pub fn status(&self) -> u16 {
        self.0.status().as_u16()
    }

    /// One header, when it is there and is text.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.0.headers().get(name).and_then(|v| v.to_str().ok())
    }

    /// What the response *claims* its body's length is. A chunked response claims nothing.
    pub fn content_length(&self) -> Option<u64> {
        self.0.content_length()
    }

    /// The whole body, in memory. For a body whose size is not the caller's to trust, read
    /// [`Response::into_body`] against a running total instead.
    pub async fn bytes(self) -> Result<Vec<u8>, Error> {
        self.0.bytes().await.map(Vec::from).map_err(Error)
    }

    /// The whole body as text, decoded as the response says it is — the relay's small JSON
    /// answers. A body that is not text is [`Error::is_decode`].
    pub async fn text(self) -> Result<String, Error> {
        self.0.text().await.map_err(Error)
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
        self.0.next().await.map(|r| r.map_err(Error))
    }
}

/// A request that did not get an answer, or a body that stopped arriving.
///
/// It prints as `reqwest`'s own error does, so a sentence in `error_log` reads as it always has.
#[derive(Debug, thiserror::Error)]
#[error(transparent)]
pub struct Error(reqwest::Error);

impl Error {
    /// A deadline passed — the connect bound, the read bound or the whole-request one.
    pub fn is_timeout(&self) -> bool {
        self.0.is_timeout()
    }

    /// The connection never came up. Always `false` in a browser, which does not say.
    pub fn is_connect(&self) -> bool {
        imp::is_connect(&self.0)
    }

    /// The request could not be sent at all.
    pub fn is_request(&self) -> bool {
        self.0.is_request()
    }

    /// A body arrived and could not be read as what it was asked for.
    pub fn is_decode(&self) -> bool {
        self.0.is_decode()
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
        builder.build().expect("client")
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
    /// that must not wait for ever gives its client a [`super::Client::deadline`], or races
    /// the request with `platform::timer::timeout`.
    pub fn build(config: &Config<'_>) -> reqwest::Client {
        reqwest::Client::builder()
            .user_agent(config.user_agent)
            .build()
            .expect("client")
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
