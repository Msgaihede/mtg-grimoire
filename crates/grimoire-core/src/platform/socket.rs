//! The relay's doorbell socket: one long-lived WebSocket, and the one place in this crate a
//! WebSocket is named.
//!
//! `sync_engine::live` holds one for as long as this device is in a sync group. It carries no
//! card data — the relay pushes a `head` frame when its log moves and this side sends nothing
//! but a keepalive — so the whole interface is three calls: [`connect`], [`Socket::next`] and
//! [`Socket::keepalive`].
//!
//! | | Native (the desktop, Android) | Browser |
//! | --- | --- | --- |
//! | [`connect`] | `tokio-tungstenite` over rustls, the bearer in the upgrade's `Authorization` header | the Worker's own `WebSocket`, the bearer in a sub-protocol: `grimoire.live.v1` and `bearer.<token>` |
//! | [`Socket::keepalive`] | a **protocol** ping, which fails when the one before it was never answered by a peer that has answered one | the **text frame** `ping`, held to the same rule by the text `pong` it is answered with |
//! | [`Socket::next`] | the next text frame, or how the socket ended | the next text frame that is not that `pong`, or how the socket ended — from a queue the socket's events feed |
//!
//! **The two hosts cannot say who they are the same way, which is why the bearer is an
//! argument and not a header the caller builds.** A native client sends an arbitrary upgrade
//! request, so the bearer rides `Authorization` and the relay's gate reads it as it reads every
//! other request's. A browser's `WebSocket` constructor cannot set a header at all; the only
//! thing it lets a page choose is the list of sub-protocols, so there the bearer rides
//! `Sec-WebSocket-Protocol`, and the keepalive is a text frame, because a page cannot send
//! a protocol ping either. Both differences are this module's, and the loop that calls it is
//! written once.
//!
//! **Native TLS is rustls with the roots compiled in** (`rustls-tls-webpki-roots`) — the
//! desktop's choice since the socket was built, and what lets Android use the same line: no
//! system store is asked for. The manifest has the argument for the version.
//!
//! **The browser arm first ran on 2026-10-04**, in headless Chrome against the relay's own code
//! under workerd (`scripts/web-sync-smoke.mjs`; `docs/reference/light-app.md` §10.3). What it
//! decides — which frame is the keepalive's answer, what a caller is handed, when a keepalive
//! fails — is the `heard` module below, which compiles for a test too, so a desktop's
//! `cargo test` reaches every rule of it; the arm itself is a constructor, four event handlers
//! and a `send`.

/// What a socket said, or how it ended.
///
/// **Three, and no control frame among them.** A pong, a ping the peer sent (answered by the
/// runtime under [`Socket::next`]) and a binary frame are swallowed inside `next`: there are no
/// other application messages, and a caller that had to skip them would have to know a
/// protocol this module exists to keep to itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A text frame.
    Text(String),
    /// The peer closed the socket, with the close code if it sent one — or the stream simply
    /// ended, which is `None` too.
    Closed(Option<u16>),
    /// The connection or a read failed, and this is the sentence.
    Failed(String),
}

/// One open socket to the relay.
pub struct Socket(imp::Socket);

/// Open a socket to `url` — `ws://` or `wss://`, see [`ws_origin`] — as the holder of `bearer`.
///
/// `Err` is a sentence: a URL that is not one, a host that did not answer, an upgrade the relay
/// refused. The caller records it and backs off; nothing here retries.
pub async fn connect(url: &str, bearer: &str) -> Result<Socket, String> {
    imp::connect(url, bearer).await.map(Socket)
}

impl Socket {
    /// Wait for the next thing the socket says — see [`Event`].
    ///
    /// Safe to drop while it waits: nothing is read that is not handed back or noted, so it
    /// can be one arm of a select that another arm wins.
    pub async fn next(&mut self) -> Event {
        self.0.next().await
    }

    /// Tell the relay this end is still here.
    ///
    /// **A protocol ping, not a text "ping", wherever the host can send one.** Cloudflare
    /// answers protocol pings itself, without waking the Durable Object and without billing
    /// them — the only keepalive that keeps hibernation. A text frame would be an incoming
    /// *message*: billed, and it wakes the object.
    ///
    /// **And it is how a dead socket is found: a keepalive whose predecessor was never
    /// answered fails — on a socket whose peer has answered one before.** A connection that
    /// has gone without a word — a phone back from the background on another network, a laptop
    /// out of range — is not closed by anything this end can see until TCP gives up on it,
    /// which is about twenty seconds on Windows and on the order of a quarter of an hour on
    /// Android's Linux defaults; until then the socket reads as live and hears no doorbell. So
    /// each ping is owed a pong before the next one is due: [`Socket::next`] notes it as it
    /// swallows it, and a keepalive that finds the last one still unanswered looks once at
    /// what has already arrived (a caller busy with a round trip has not been reading) and
    /// then answers `Err`, in a sentence. A dead socket is noticed within two keepalive
    /// periods.
    ///
    /// ⚠️ **The deadline is enforced only once this socket has seen a pong, and that is what
    /// makes it safe to ship.** It rests on the relay's edge answering a protocol ping with a
    /// pong. Measured locally on 2026-10-04 — the relay under `wrangler dev --local` (workerd,
    /// wrangler 4.146.0) answered a raw masked ping, opcode 9 and empty, with opcode 10 and
    /// empty, on a hibernatable socket — and **not yet watched against the deployed edge**.
    /// Were production to answer no pings at all, a deadline held from the first ping would
    /// end every socket on every device at its second keepalive, for ever. So a peer that
    /// never pongs is pinged and nothing is concluded from its silence, which is exactly what
    /// this was before the deadline; a peer that has ponged once and then goes silent is
    /// ended. What that gives up is a socket that goes half-open before its first pong — the
    /// first ping period or two of a connection — which is left to TCP, as every socket was.
    ///
    /// The browser's arm keeps the same property, from the text `pong` its text `ping` is
    /// answered with — measured against the same local relay on the same day: the Durable
    /// Object's auto-response answered every `ping` a headless Chrome sent.
    ///
    /// `Err` is that, or a socket that could not be written to; the caller treats either as
    /// the socket's end.
    pub async fn keepalive(&mut self) -> Result<(), String> {
        self.0.keepalive().await
    }
}

/// The relay's base URL as a WebSocket origin.
///
/// **Both schemes, and the `http` half is not hypothetical.**
/// [`RELAY_URL`](crate::sync_engine::client::RELAY_URL) is a `sync_state` override with no UI
/// whose entire purpose is to point a dev build or a test at a Worker of its own, and
/// `wrangler dev` serves `http://127.0.0.1:8787`. A lone `replacen("https://", "wss://", 1)`
/// left that untouched and `connect_async` refuses an `http` URL outright, so the one
/// configuration the override exists for was the one that could never open a socket.
///
/// Anything else — a base already spelled `wss://`, or a scheme this does not know — is handed
/// back unchanged and left to fail on its own terms, which is a better error than a rewrite
/// guessing at what was meant.
pub fn ws_origin(base: &str) -> String {
    if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_owned()
    }
}

#[cfg(not(target_family = "wasm"))]
mod imp {
    use super::Event;
    use futures_util::{FutureExt, SinkExt, StreamExt};
    use std::collections::VecDeque;
    use tokio_tungstenite::tungstenite::{Error, Message};

    /// The stream `connect_async` answers: TLS for `wss://`, plain for `ws://`.
    type Stream = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    /// What a keepalive that went unanswered says.
    const UNANSWERED: &str = "the relay did not answer the last keepalive";

    pub struct Socket {
        stream: Stream,
        /// Whether a ping has gone out that no pong has come back for.
        unanswered: bool,
        /// Whether this peer has **ever** answered a ping of this socket's with a pong. Until it
        /// has, an unanswered ping proves nothing — [`Socket::keepalive`] has why.
        answers: bool,
        /// What a keepalive read while it looked for its pong, kept for [`Socket::next`].
        held: VecDeque<Event>,
    }

    /// The upgrade request for one socket, carrying the bearer.
    ///
    /// `tokio-tungstenite` sends an arbitrary upgrade request, so the bearer gate the relay
    /// already has at `index.ts:169-181` works unchanged. **The webview could not do this** —
    /// its `WebSocket` constructor cannot set a header — which is one of the reasons the socket
    /// lives in Rust rather than in the page.
    ///
    /// **Built from the URL and then given the bearer, never assembled by hand.** tungstenite
    /// passes a ready-made `http::Request` through as it stands, and its handshake refuses one
    /// without `Host`, `Connection`, `Upgrade`, `Sec-WebSocket-Version` and `Sec-WebSocket-Key`
    /// before a byte leaves; only the URL's own conversion writes those five. A request built
    /// with the bearer alone is what this was until 2026-10-01, and no socket ever came up.
    pub(super) fn upgrade_request(
        url: &str,
        token: &str,
    ) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION};

        let mut request = url.into_client_request().map_err(|e| e.to_string())?;
        let bearer =
            HeaderValue::from_str(&format!("Bearer {token}")).map_err(|e| e.to_string())?;
        request.headers_mut().insert(AUTHORIZATION, bearer);
        Ok(request)
    }

    pub async fn connect(url: &str, bearer: &str) -> Result<Socket, String> {
        let request = upgrade_request(url, bearer)?;
        match tokio_tungstenite::connect_async(request).await {
            Ok((stream, _)) => Ok(Socket {
                stream,
                unanswered: false,
                answers: false,
                held: VecDeque::new(),
            }),
            Err(e) => Err(e.to_string()),
        }
    }

    impl Socket {
        pub async fn next(&mut self) -> Event {
            if let Some(event) = self.held.pop_front() {
                return event;
            }
            loop {
                let read = self.stream.next().await;
                if let Some(event) = self.take(read) {
                    return event;
                }
            }
        }

        /// One thing the stream answered, as the event it is — or `None` for what a caller is
        /// never handed. A pong is the answer to the keepalive, and is noted here.
        fn take(&mut self, read: Option<Result<Message, Error>>) -> Option<Event> {
            match read {
                Some(Ok(Message::Text(text))) => Some(Event::Text(text.as_str().to_owned())),
                Some(Ok(Message::Close(frame))) => {
                    Some(Event::Closed(frame.map(|f| u16::from(f.code))))
                }
                None => Some(Event::Closed(None)),
                Some(Err(e)) => Some(Event::Failed(e.to_string())),
                Some(Ok(Message::Pong(_))) => {
                    // An answer only when there was a question: a pong nobody asked for says
                    // nothing about whether this peer answers pings.
                    if self.unanswered {
                        self.answers = true;
                    }
                    self.unanswered = false;
                    None
                }
                // Everything else: the runtime answers a ping the peer sent, and there are no
                // other application messages.
                Some(Ok(_)) => None,
            }
        }

        /// Read whatever has **already arrived**, without waiting, until the keepalive's pong
        /// is among it or there is no more — keeping what a caller is owed for
        /// [`Socket::next`]. Answers whether the socket was found to have ended.
        ///
        /// For a caller that has not been reading: a round trip can outlast a ping period, and
        /// the pong that came in during it is in the buffer, not missing.
        fn catch_up(&mut self) -> bool {
            while self.unanswered {
                let Some(read) = self.stream.next().now_or_never() else {
                    break;
                };
                if let Some(event) = self.take(read) {
                    let ended = !matches!(event, Event::Text(_));
                    self.held.push_back(event);
                    if ended {
                        return true;
                    }
                }
            }
            false
        }

        pub async fn keepalive(&mut self) -> Result<(), String> {
            if self.unanswered {
                // A socket that has ended says so through `next`, in its own words.
                if self.catch_up() {
                    return Ok(());
                }
                // **Only a peer that has answered before is held to answering.** One that has
                // never sent a pong is pinged again and nothing is concluded from its silence.
                if self.unanswered && self.answers {
                    return Err(UNANSWERED.to_owned());
                }
            }
            self.stream
                .send(Message::Ping(Vec::<u8>::new().into()))
                .await
                .map_err(|e| e.to_string())?;
            self.unanswered = true;
            Ok(())
        }

        /// Whether a keepalive is still waiting for its pong.
        #[cfg(test)]
        pub(super) fn unanswered(&self) -> bool {
            self.unanswered
        }
    }
}

/// **What a browser's socket has been told, and what it owes its two callers** — the browser
/// arm with the browser left out, so a desktop's `cargo test` runs every rule of it.
///
/// A page's `WebSocket` is not read: it *tells*, through four events, whenever the event loop
/// gets to them — while [`Socket::next`] is waiting, and just as well while the loop that holds
/// the socket is inside a round trip and nobody is. So what the events say is kept here, in
/// the order they came, and the two calls read it:
///
/// * **a text frame is queued for [`Socket::next`] — unless it is the keepalive's `pong`**,
///   which is noted and handed to nobody, as the native arm's protocol pong is. The relay's
///   only other frame is JSON, so the word cannot be one;
/// * **the first ending is the ending.** A browser says a socket died with an `error` event
///   and then a `close`, and a caller is owed one of them; what follows the first is dropped;
/// * **asked again after it has ended, it says closed** rather than waiting for ever, as the
///   native arm does of a stream that has run out.
///
/// The keepalive's rule is the native arm's, word for word — [`Socket::keepalive`] has the
/// argument: a ping that finds its predecessor unanswered fails, **once this peer has answered
/// one**; a peer that never has is pinged again and nothing is concluded from its silence.
#[cfg(any(test, target_family = "wasm"))]
mod heard {
    use super::Event;
    use std::collections::VecDeque;
    use std::task::{Context, Poll, Waker};

    /// The keepalive a page can send, and the relay's answer to it (`relay/src/ticket.ts`'s
    /// `KEEPALIVE`): exact strings, which the Durable Object's auto-response compares byte for
    /// byte and answers without waking.
    pub const PING: &str = "ping";
    pub const PONG: &str = "pong";

    /// The sub-protocol the relay selects in its 101 (`relay/src/ticket.ts`'s `LIVE_PROTOCOL`).
    /// A browser fails a socket whose server selected none of what was offered, so this is
    /// offered for the relay to select — and the bearer's entry beside it never is.
    pub const LIVE_PROTOCOL: &str = "grimoire.live.v1";

    /// What a page offers on the upgrade: **exactly two sub-protocols, in this order** — the
    /// name the relay selects, and `bearer.<token>`, which is where a page's credential goes
    /// because its `WebSocket` can set no header. Every character of an access token is legal
    /// in a sub-protocol (`ticket.ts` has the grammar), so nothing is escaped.
    pub fn protocols(bearer: &str) -> [String; 2] {
        [LIVE_PROTOCOL.to_owned(), format!("bearer.{bearer}")]
    }

    /// What a keepalive that went unanswered says — the native arm's sentence.
    pub const UNANSWERED: &str = "the relay did not answer the last keepalive";

    /// What a socket that would not open says. **Generic because a browser is**: a refused
    /// upgrade — a 401, a 403, a host that is not there, a policy that forbids the connection —
    /// reaches a page as an `error` event with nothing in it and a close with code 1006,
    /// deliberately, so a script cannot probe what it may not read.
    pub const NOT_OPENED: &str = "the live socket could not be opened (a browser does not say why)";

    /// What a socket that was up and then failed says. As generic, for the same reason.
    pub const FAILED: &str = "the live socket failed (a browser does not say why)";

    #[derive(Debug, Default)]
    pub struct Heard {
        /// What [`Socket::next`](super::Socket::next) is owed, oldest first.
        queue: VecDeque<Event>,
        /// The `open` event came.
        open: bool,
        /// An ending has been queued; nothing after it is kept.
        ended: bool,
        /// Whether a ping has gone out that no pong has come back for.
        unanswered: bool,
        /// Whether this peer has **ever** answered a ping of this socket's with a pong.
        answers: bool,
        /// Whoever is waiting — for the open, or for the next event. One, because the socket
        /// has one holder and it waits on one thing at a time.
        waiting: Option<Waker>,
    }

    impl Heard {
        fn wake(&mut self) {
            if let Some(waiting) = self.waiting.take() {
                waiting.wake();
            }
        }

        /// The `open` event.
        pub fn opened(&mut self) {
            self.open = true;
            self.wake();
        }

        /// A `message` event that carried text.
        pub fn text(&mut self, text: String) {
            if text == PONG {
                // An answer only when there was a question: a pong nobody asked for says
                // nothing about whether this peer answers pings.
                if self.unanswered {
                    self.answers = true;
                }
                self.unanswered = false;
                return;
            }
            if !self.ended {
                self.queue.push_back(Event::Text(text));
                self.wake();
            }
        }

        /// The `close` event, with the code the browser reports — which for a socket that
        /// ended with no close frame is 1006, the browser's own number and nothing the relay
        /// sent.
        pub fn closed(&mut self, code: Option<u16>) {
            self.end(Event::Closed(code));
        }

        /// The `error` event. A browser's carries nothing, so the sentence is this module's.
        pub fn failed(&mut self) {
            let sentence = if self.open { FAILED } else { NOT_OPENED };
            self.end(Event::Failed(sentence.to_owned()));
        }

        fn end(&mut self, event: Event) {
            if !self.ended {
                self.ended = true;
                self.queue.push_back(event);
            }
            self.wake();
        }

        /// [`connect`](super::connect)'s wait: ready when the socket opened, or with the
        /// sentence for one that ended first.
        pub fn poll_opened(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), String>> {
            if self.open {
                return Poll::Ready(Ok(()));
            }
            match self.queue.pop_front() {
                Some(Event::Failed(sentence)) => Poll::Ready(Err(sentence)),
                Some(Event::Closed(Some(code))) => {
                    Poll::Ready(Err(format!("{NOT_OPENED}; it closed with code {code}")))
                }
                Some(_) => Poll::Ready(Err(NOT_OPENED.to_owned())),
                None => {
                    self.waiting = Some(cx.waker().clone());
                    Poll::Pending
                }
            }
        }

        /// [`Socket::next`](super::Socket::next)'s wait. Nothing is taken that is not handed
        /// back, so the future over this can be dropped while it waits.
        pub fn poll_next(&mut self, cx: &mut Context<'_>) -> Poll<Event> {
            if let Some(event) = self.queue.pop_front() {
                return Poll::Ready(event);
            }
            if self.ended {
                return Poll::Ready(Event::Closed(None));
            }
            self.waiting = Some(cx.waker().clone());
            Poll::Pending
        }

        /// Whether a ping is still owed its pong — when a keepalive gives the event loop one
        /// turn before it concludes anything.
        pub fn unanswered(&self) -> bool {
            self.unanswered
        }

        /// Whether to send a ping now. `Ok(false)` for a socket that has ended, which says so
        /// through `next`, in its own words; `Err` for a ping left unanswered by a peer that
        /// has answered one.
        pub fn ping_due(&self) -> Result<bool, String> {
            if self.ended {
                return Ok(false);
            }
            // **Only a peer that has answered before is held to answering.** One that has
            // never sent a pong is pinged again and nothing is concluded from its silence.
            if self.unanswered && self.answers {
                return Err(UNANSWERED.to_owned());
            }
            Ok(true)
        }

        /// A ping went out.
        pub fn pinged(&mut self) {
            self.unanswered = true;
        }
    }
}

#[cfg(target_family = "wasm")]
mod imp {
    use super::heard::{protocols, Heard, NOT_OPENED, PING};
    use super::Event;
    use std::cell::RefCell;
    use std::rc::Rc;
    use wasm_bindgen::closure::Closure;
    use wasm_bindgen::{JsCast as _, JsValue};

    /// The four events a `WebSocket` tells its holder by, as the properties they are set on.
    const EVENTS: [&str; 4] = ["onopen", "onmessage", "onclose", "onerror"];

    type Handler = Closure<dyn FnMut(JsValue)>;

    /// **The Worker's own `WebSocket`, and what its events have said.**
    ///
    /// Reached through `js_sys::Reflect` off the global object, as [`crate::platform::timer`]
    /// reaches `setTimeout`: the engine runs in a dedicated Worker, whose global is a
    /// `DedicatedWorkerGlobalScope` and not a `window`, and `js_sys::global()` is whichever
    /// this is. No `web-sys`: the whole surface is a constructor, four properties, `send` and
    /// `close`, and a feature list for them in the manifest would be a second place to keep
    /// in step with these names.
    ///
    /// **The handlers are properties, not listeners, so that letting go is four assignments.**
    /// A closure handed to JavaScript must outlive every call the browser makes of it — one
    /// called after it was dropped throws inside the event loop — so [`Drop`] clears the four
    /// properties *first*, then closes the socket, and only then do the closures go, with the
    /// struct. Nothing here is `Send`, and nothing asks it to be: the loop that holds a socket
    /// is spawned on the Worker's one thread.
    pub struct Socket {
        socket: JsValue,
        heard: Rc<RefCell<Heard>>,
        /// Held for the socket's life: the browser calls them, in [`EVENTS`]' order.
        handlers: [Handler; 4],
    }

    /// A method of a JavaScript object, when it is there and is a function.
    fn method(of: &JsValue, name: &str) -> Option<js_sys::Function> {
        js_sys::Reflect::get(of, &name.into())
            .ok()
            .and_then(|f| f.dyn_into::<js_sys::Function>().ok())
    }

    /// What a thrown value says: an exception's own message, or however the value prints.
    fn said(thrown: &JsValue) -> String {
        match thrown.dyn_ref::<js_sys::Error>() {
            Some(error) => String::from(error.message()),
            None => format!("{thrown:?}"),
        }
    }

    /// One event handler: `tell` is what the event says to [`Heard`]. Never called while
    /// `heard` is borrowed — the browser calls it from its event loop, and no borrow here is
    /// held across an `.await`.
    fn handler(heard: &Rc<RefCell<Heard>>, tell: fn(&mut Heard, JsValue)) -> Handler {
        let heard = Rc::clone(heard);
        Closure::new(move |event: JsValue| tell(&mut heard.borrow_mut(), event))
    }

    pub async fn connect(url: &str, bearer: &str) -> Result<Socket, String> {
        let global: JsValue = js_sys::global().into();
        let constructor = method(&global, "WebSocket")
            .ok_or_else(|| format!("{NOT_OPENED}: this browser has no WebSocket"))?;
        let [live, ticket] = protocols(bearer);
        let offered = js_sys::Array::of2(&JsValue::from_str(&live), &JsValue::from_str(&ticket));
        // The constructor throws for what it can refuse without asking anybody: a URL that is
        // not one, a scheme that is not a socket's, a sub-protocol that is not a token.
        let socket = js_sys::Reflect::construct(
            &constructor,
            &js_sys::Array::of2(&JsValue::from_str(url), &offered),
        )
        .map_err(|thrown| format!("{NOT_OPENED}: {}", said(&thrown)))?;

        let heard = Rc::new(RefCell::new(Heard::default()));
        let handlers = [
            handler(&heard, |heard, _event| heard.opened()),
            handler(&heard, |heard, event| {
                // A text frame's `data` is a string. A binary frame's is a `Blob` or an
                // `ArrayBuffer`: there are no binary messages, and one is handed to nobody.
                let data = js_sys::Reflect::get(&event, &"data".into()).ok();
                if let Some(text) = data.and_then(|data| data.as_string()) {
                    heard.text(text);
                }
            }),
            handler(&heard, |heard, event| {
                let code = js_sys::Reflect::get(&event, &"code".into())
                    .ok()
                    .and_then(|code| code.as_f64())
                    .map(|code| code as u16);
                heard.closed(code);
            }),
            handler(&heard, |heard, _event| heard.failed()),
        ];
        // Made before anything can fail or wait, so a socket that never opens is closed and
        // let go of by the same `Drop` as one that did.
        let socket = Socket {
            socket,
            heard,
            handlers,
        };
        for (event, handler) in EVENTS.iter().zip(&socket.handlers) {
            let set = js_sys::Reflect::set(&socket.socket, &(*event).into(), handler.as_ref());
            if !set.unwrap_or(false) {
                return Err(format!("{NOT_OPENED}: it takes no {event}"));
            }
        }
        let opened = {
            let heard = &socket.heard;
            std::future::poll_fn(|cx| heard.borrow_mut().poll_opened(cx)).await
        };
        opened.map(|()| socket)
    }

    impl Socket {
        pub async fn next(&mut self) -> Event {
            let heard = &self.heard;
            std::future::poll_fn(|cx| heard.borrow_mut().poll_next(cx)).await
        }

        pub async fn keepalive(&mut self) -> Result<(), String> {
            // **One look at what has already arrived**, as the native arm takes: a `pong`
            // whose event is queued behind the timer that brought this call — the Worker was
            // inside a long stretch, or the browser had it frozen — is delivered in a turn of
            // the event loop, and is not missing. No borrow is held across the turn.
            if self.heard.borrow().unanswered() {
                crate::platform::timer::yield_to_host().await;
            }
            let due = self.heard.borrow().ping_due()?;
            if !due {
                return Ok(());
            }
            let send = method(&self.socket, "send")
                .ok_or_else(|| "the live socket cannot be written to".to_owned())?;
            send.call1(&self.socket, &JsValue::from_str(PING))
                .map_err(|thrown| said(&thrown))?;
            self.heard.borrow_mut().pinged();
            Ok(())
        }
    }

    impl Drop for Socket {
        fn drop(&mut self) {
            // The order is the point — see the struct.
            for event in EVENTS {
                let _ = js_sys::Reflect::set(&self.socket, &event.into(), &JsValue::NULL);
            }
            // Closing a socket that is closed, or was never open, does nothing.
            if let Some(close) = method(&self.socket, "close") {
                let _ = close.call0(&self.socket);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use std::time::Duration;
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
    use tokio_tungstenite::tungstenite::protocol::CloseFrame;
    use tokio_tungstenite::tungstenite::Message;

    /// A dev override is the only thing `relay_url` is for, and `wrangler dev` serves plain
    /// `http`. `connect_async` refuses that scheme outright, so leaving it unconverted made the
    /// override useless for the one job it has.
    #[test]
    fn a_dev_http_base_becomes_a_ws_socket() {
        assert_eq!(ws_origin("http://127.0.0.1:8787"), "ws://127.0.0.1:8787");
        assert_eq!(ws_origin("https://relay.example"), "wss://relay.example");
        // Only the scheme, and only once: a host that happens to contain the string must not
        // be rewritten.
        assert_eq!(
            ws_origin("https://relay.example/http://x"),
            "wss://relay.example/http://x"
        );
        // Already a socket URL, or a scheme this does not know: handed back to fail on its own
        // terms rather than guessed at.
        assert_eq!(ws_origin("wss://relay.example"), "wss://relay.example");
        assert_eq!(ws_origin("relay.example"), "relay.example");
    }

    /// **The upgrade request is one tungstenite will actually send.**
    ///
    /// A hand-built `http::Request` is passed through as it stands, and the handshake refuses one
    /// without `Sec-WebSocket-Key` before a byte leaves — `WebSocket protocol error: Missing,
    /// duplicated or incorrect header sec-websocket-key`. The request this module built carried
    /// the bearer and nothing else, so no socket ever came up. `generate_request` is that same
    /// check, which is what lets this run with no relay.
    #[test]
    fn the_upgrade_request_passes_the_handshakes_own_check() {
        let request =
            imp::upgrade_request("wss://relay.example/g/abc/ws?device=d1", "tok").unwrap();
        let (bytes, _key) =
            tokio_tungstenite::tungstenite::handshake::client::generate_request(request).unwrap();
        let sent = String::from_utf8(bytes).unwrap().to_ascii_lowercase();
        assert!(sent.starts_with("get /g/abc/ws?device=d1 http/1.1\r\n"));
        assert!(sent.contains("\r\nhost: relay.example\r\n"));
        assert!(sent.contains("\r\nauthorization: bearer tok\r\n"));
    }

    // -----------------------------------------------------------------------------------
    // Against a socket that really answers: a listener on loopback, standing in for the relay
    // -----------------------------------------------------------------------------------

    type Peer = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

    /// Long past anything loopback takes, and only ever spent by a wait that is not coming
    /// back — so a hang is a failure with a line number.
    const SOON: Duration = Duration::from_secs(10);

    /// What the relay's side of an upgrade saw.
    #[derive(Debug, Default)]
    struct Asked {
        path: String,
        authorization: Option<String>,
    }

    /// A listener on a port of its own, and the URL a socket would be opened at.
    async fn listening() -> (tokio::net::TcpListener, String) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let base = ws_origin(&format!("http://127.0.0.1:{port}"));
        (listener, format!("{base}/g/abc/ws?device=d1"))
    }

    /// Accept one connection and upgrade it, keeping what the request said.
    async fn upgraded(listener: &tokio::net::TcpListener) -> (Peer, Asked) {
        let (stream, _) = listener.accept().await.unwrap();
        let mut asked = Asked::default();
        // The refusal this callback could answer is a whole HTTP response — tungstenite's
        // contract for it, not a choice made here — and this one never refuses.
        #[allow(clippy::result_large_err)]
        let keep = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
            asked.path = request.uri().to_string();
            asked.authorization = request
                .headers()
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            Ok(response)
        };
        let peer = tokio_tungstenite::accept_hdr_async(stream, keep)
            .await
            .unwrap();
        (peer, asked)
    }

    /// Both ends of one socket, and what the upgrade carried.
    async fn pair() -> (Socket, Peer, Asked) {
        let (listener, url) = listening().await;
        let (socket, (peer, asked)) = tokio::join!(connect(&url, "tok"), upgraded(&listener));
        (socket.expect("the socket comes up"), peer, asked)
    }

    async fn next(socket: &mut Socket) -> Event {
        tokio::time::timeout(SOON, socket.next())
            .await
            .expect("the socket said nothing at all")
    }

    /// **The bearer arrives in `Authorization`, on the path the caller asked for** — the gate
    /// the relay reads on every other request, unchanged.
    #[tokio::test]
    async fn the_bearer_rides_the_upgrade_in_authorization() {
        let (_socket, _peer, asked) = pair().await;
        assert_eq!(asked.authorization.as_deref(), Some("Bearer tok"));
        assert_eq!(asked.path, "/g/abc/ws?device=d1");
    }

    /// A text frame is handed over as its text; a ping, a pong and a binary frame ahead of it
    /// are not handed over at all.
    #[tokio::test]
    async fn a_text_frame_arrives_as_text_and_everything_else_is_swallowed() {
        let (mut socket, mut peer, _asked) = pair().await;
        let head = r#"{"t":"head","cursor":7,"from":"d2"}"#;
        peer.send(Message::Ping(vec![1u8].into())).await.unwrap();
        peer.send(Message::Pong(Vec::<u8>::new().into()))
            .await
            .unwrap();
        peer.send(Message::Binary(vec![0u8, 1, 2].into()))
            .await
            .unwrap();
        peer.send(Message::Text(head.into())).await.unwrap();

        assert_eq!(next(&mut socket).await, Event::Text(head.to_owned()));
    }

    /// **The keepalive is a protocol ping, with nothing in it** — a text frame would be a
    /// message the Durable Object is woken and billed for.
    #[tokio::test]
    async fn a_keepalive_is_a_protocol_ping_and_never_a_message() {
        let (mut socket, mut peer, _asked) = pair().await;
        socket.keepalive().await.unwrap();
        let heard = tokio::time::timeout(SOON, peer.next())
            .await
            .expect("the keepalive never arrived")
            .expect("the socket is still up")
            .unwrap();
        assert!(
            matches!(&heard, Message::Ping(payload) if payload.is_empty()),
            "{heard:?}"
        );
    }

    /// Read — and swallow — until the keepalive's pong is in, bounded: a pong is only *known*
    /// to have arrived once this end has read it, so "the server answered" is waited for
    /// rather than guessed at from a clock.
    async fn until_answered(socket: &mut Socket) {
        let waiting = crate::platform::clock::Tick::now();
        while socket.0.unanswered() {
            assert!(waiting.elapsed() < SOON, "the pong never came");
            let _ = tokio::time::timeout(Duration::from_millis(10), socket.next()).await;
        }
    }

    /// **A relay that answers its pings stays up**, keepalive after keepalive: each pong is
    /// noted as `next` swallows it, so the following ping finds nothing outstanding. The peer
    /// here only reads, which is all tungstenite's accepting side needs to answer a ping.
    #[tokio::test]
    async fn a_socket_whose_pings_are_answered_stays_up_across_keepalives() {
        let (mut socket, mut peer, _asked) = pair().await;
        let answering = tokio::spawn(async move { while peer.next().await.is_some() {} });

        for _ in 0..3 {
            socket
                .keepalive()
                .await
                .expect("the last ping was answered");
            assert!(socket.0.unanswered(), "a ping is owed a pong from here");
            until_answered(&mut socket).await;
        }
        answering.abort();
    }

    /// **A peer that answered a ping and then went silent fails the keepalive after the next
    /// unanswered one, in a sentence** — the half-open socket: connected as far as this end's
    /// TCP knows, and nobody there. The peer answers the first ping and never reads again, so
    /// no second pong is ever sent, and the socket is still open — which is the point: nothing
    /// else would end it.
    #[tokio::test]
    async fn a_peer_that_answered_and_then_went_silent_fails_the_keepalive() {
        let (mut socket, mut peer, _asked) = pair().await;
        socket.keepalive().await.expect("the first ping goes out");
        // Read the ping, which queues its pong, and send it. Then nothing, ever again.
        let heard = tokio::time::timeout(SOON, peer.next())
            .await
            .expect("the first ping never arrived");
        assert!(matches!(heard, Some(Ok(Message::Ping(_)))), "{heard:?}");
        peer.flush().await.unwrap();
        until_answered(&mut socket).await;

        socket
            .keepalive()
            .await
            .expect("the first ping was answered, so a second goes out");
        let dead = socket
            .keepalive()
            .await
            .expect_err("the second ping was never answered, by a peer that answers");
        assert!(dead.contains("did not answer the last keepalive"), "{dead}");
        // And it stays dead: asking again says the same, and sends nothing.
        assert_eq!(socket.keepalive().await, Err(dead));
    }

    /// **A peer that never answers any ping is never failed by the keepalive** — the control
    /// for the deadline above, and the reason it waits for a first pong: if the relay's edge
    /// turned out to answer no protocol pings at all, a deadline held from the first ping
    /// would end every socket at its second keepalive, on every device, for ever. Here the
    /// peer never reads after the handshake, so no pong is ever sent; every keepalive goes
    /// out, and what ends such a socket is what always did.
    #[tokio::test]
    async fn a_peer_that_never_answers_a_ping_is_never_failed_by_the_keepalive() {
        let (mut socket, _peer, _asked) = pair().await;
        for nth in 1..=4 {
            assert_eq!(
                socket.keepalive().await,
                Ok(()),
                "keepalive {nth} was refused over a peer that has never ponged"
            );
            assert!(socket.0.unanswered(), "and its ping is still unanswered");
        }
    }

    /// **A pong that arrived while nobody was reading is found by the keepalive itself, and a
    /// frame it read on the way is kept** — the loop inside a round trip longer than a ping
    /// period: the answer is in the buffer, not missing, and the `head` behind it must not be
    /// lost to the looking.
    #[tokio::test]
    async fn a_keepalive_finds_a_pong_that_was_waiting_and_keeps_the_frame_ahead_of_it() {
        let (mut socket, mut peer, _asked) = pair().await;
        let head = r#"{"t":"head","cursor":9,"from":"d2"}"#;
        // The peer answers the first ping, so it is one the deadline holds. Then, when told:
        // the frame first, then the reads that answer the second ping — on the wire, text and
        // then pong.
        let go = std::sync::Arc::new(tokio::sync::Notify::new());
        let answering = {
            let go = go.clone();
            tokio::spawn(async move {
                let _ = peer.next().await;
                peer.flush().await.unwrap();
                go.notified().await;
                peer.send(Message::Text(head.into())).await.unwrap();
                while peer.next().await.is_some() {}
            })
        };
        socket.keepalive().await.unwrap();
        until_answered(&mut socket).await;
        go.notify_one();
        socket.keepalive().await.expect("the second ping goes out");

        // Never `next`: only the keepalive, and the look it takes for itself. Asked again until
        // the pong has crossed loopback — a refusal sends nothing and changes nothing, so the
        // asking is only a wait; without the look it would be refused for ever.
        let waiting = crate::platform::clock::Tick::now();
        while let Err(not_yet) = socket.keepalive().await {
            assert!(
                waiting.elapsed() < SOON,
                "the keepalive never found the pong: {not_yet}"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(next(&mut socket).await, Event::Text(head.to_owned()));
        answering.abort();
    }

    /// The relay's "this group is gone" is a close with 4001, and the code is what the caller
    /// is given — it is the one close the connection manager reads differently.
    #[tokio::test]
    async fn a_4001_close_arrives_with_its_code() {
        let (mut socket, mut peer, _asked) = pair().await;
        peer.close(Some(CloseFrame {
            code: CloseCode::from(4001),
            reason: "gone".into(),
        }))
        .await
        .unwrap();
        assert_eq!(next(&mut socket).await, Event::Closed(Some(4001)));
    }

    /// A close that names no code is a close with none — and so is a stream that has simply
    /// ended: asked again once the peer has gone, the socket says closed rather than waiting.
    #[tokio::test]
    async fn a_close_with_no_code_and_a_stream_that_has_ended_are_both_closed() {
        let (mut socket, mut peer, _asked) = pair().await;
        peer.close(None).await.unwrap();
        assert_eq!(next(&mut socket).await, Event::Closed(None));

        // The peer reads the handshake to its end and goes; this side's second ask is what
        // sends its half of that handshake, so the two run together.
        let gone = async {
            while peer.next().await.is_some() {}
            drop(peer);
        };
        let ((), again) = tokio::join!(gone, next(&mut socket));
        assert_eq!(again, Event::Closed(None));
    }

    /// **A connection that just goes away ends the wait** — as a failure with a sentence, or as
    /// a stream that ended, whichever the transport makes of it; never as a socket that waits
    /// for ever on a peer that is gone.
    #[tokio::test]
    async fn a_dropped_connection_ends_the_wait() {
        let (mut socket, peer, _asked) = pair().await;
        drop(peer);
        let ended = next(&mut socket).await;
        match &ended {
            Event::Failed(sentence) => assert!(!sentence.is_empty()),
            Event::Closed(None) => {}
            other => panic!("a dropped connection read as {other:?}"),
        }
    }

    /// A URL that is not one, and a port nobody is listening on, are each a refusal in words.
    #[tokio::test]
    async fn a_socket_that_cannot_come_up_is_a_sentence() {
        let not_a_url = connect("not a url", "tok")
            .await
            .err()
            .expect("no such URL");
        assert!(!not_a_url.is_empty());

        let (listener, url) = listening().await;
        drop(listener);
        let nobody = tokio::time::timeout(SOON, connect(&url, "tok"))
            .await
            .expect("a refused connection is refused promptly")
            .err()
            .expect("nobody is listening");
        assert!(!nobody.is_empty());
    }

    // -----------------------------------------------------------------------------------
    // The browser's arm, with the browser left out: what its four events say, and what its
    // two callers are owed
    // -----------------------------------------------------------------------------------

    use heard::Heard;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::task::{Context, Poll, Wake, Waker};

    /// A waker that counts how often it was woken.
    #[derive(Default)]
    struct Woken(AtomicUsize);

    impl Wake for Woken {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// What a caller of `next` is handed right now, or `None` while it would wait.
    fn taken(heard: &mut Heard) -> Option<Event> {
        match heard.poll_next(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(event) => Some(event),
            Poll::Pending => None,
        }
    }

    /// What `connect` answers right now, or `None` while it would wait.
    fn opened(heard: &mut Heard) -> Option<Result<(), String>> {
        match heard.poll_opened(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(answer) => Some(answer),
            Poll::Pending => None,
        }
    }

    /// One keepalive as the arm makes it: decide, and note the ping that went out.
    fn keepalive(heard: &mut Heard) -> Result<bool, String> {
        let due = heard.ping_due()?;
        if due {
            heard.pinged();
        }
        Ok(due)
    }

    /// **What a page offers and sends is what the relay reads**, held to the relay's own
    /// source: two sub-protocols — the name `ticket.ts` selects and the entry its
    /// `bearerTicket` takes the token from — and the keepalive pair the Durable Object's
    /// auto-response is registered with. A word changed on either side alone is a socket that
    /// opens and dies, or a ping that wakes the object, with nothing else red.
    #[test]
    fn a_page_offers_the_two_sub_protocols_and_the_keepalive_the_relay_reads() {
        let ticket = include_str!("../../../../relay/src/ticket.ts");
        assert_eq!(
            heard::protocols("abc.def"),
            ["grimoire.live.v1".to_owned(), "bearer.abc.def".to_owned()]
        );
        assert!(
            ticket.contains(&format!(
                "export const LIVE_PROTOCOL = \"{}\";",
                heard::LIVE_PROTOCOL
            )),
            "the relay selects another name than {}",
            heard::LIVE_PROTOCOL
        );
        assert!(ticket.contains("const BEARER_PREFIX = \"bearer.\";"));
        assert!(
            ticket.contains(&format!(
                "export const KEEPALIVE = {{ request: \"{}\", response: \"{}\" }} as const;",
                heard::PING,
                heard::PONG
            )),
            "the relay's auto-response is registered with another pair"
        );
    }

    /// A text frame is handed over as its text and in order; the keepalive's `pong` is handed
    /// to nobody, whether or not anybody asked for one.
    #[test]
    fn a_pages_text_frame_is_handed_over_and_its_pong_is_swallowed() {
        let mut heard = Heard::default();
        heard.opened();
        assert_eq!(taken(&mut heard), None, "nothing has been said yet");

        let head = r#"{"t":"head","cursor":7,"from":"d2"}"#;
        heard.text(heard::PONG.to_owned());
        heard.text(head.to_owned());
        heard.text(heard::PONG.to_owned());
        heard.text("later".to_owned());
        assert_eq!(taken(&mut heard), Some(Event::Text(head.to_owned())));
        assert_eq!(taken(&mut heard), Some(Event::Text("later".to_owned())));
        assert_eq!(taken(&mut heard), None, "a pong is not a message");
        // Only the exact word: anything else is a frame a caller is owed.
        heard.text("pong ".to_owned());
        assert_eq!(taken(&mut heard), Some(Event::Text("pong ".to_owned())));
    }

    /// **A relay that answers its pings stays up**, keepalive after keepalive — each `pong`
    /// is noted as its event arrives, with nobody reading.
    #[test]
    fn a_pages_socket_whose_pings_are_answered_stays_up_across_keepalives() {
        let mut heard = Heard::default();
        heard.opened();
        for _ in 0..3 {
            assert_eq!(keepalive(&mut heard), Ok(true));
            assert!(heard.unanswered(), "a ping is owed a pong from here");
            heard.text(heard::PONG.to_owned());
            assert!(!heard.unanswered());
        }
    }

    /// **A peer that answered a ping and then went silent fails the keepalive after the next
    /// unanswered one, in the native arm's sentence** — and stays failed, sending nothing.
    #[test]
    fn a_pages_peer_that_answered_and_then_went_silent_fails_the_keepalive() {
        let mut heard = Heard::default();
        heard.opened();
        assert_eq!(keepalive(&mut heard), Ok(true));
        heard.text(heard::PONG.to_owned());

        assert_eq!(keepalive(&mut heard), Ok(true), "the first was answered");
        let dead = keepalive(&mut heard).expect_err("the second never was");
        assert_eq!(dead, "the relay did not answer the last keepalive");
        assert_eq!(keepalive(&mut heard), Err(dead));
        // Late is not never: the pong arriving after all is an answer, and the socket lives.
        heard.text(heard::PONG.to_owned());
        assert_eq!(keepalive(&mut heard), Ok(true));
    }

    /// **A peer that never answers any ping is never failed by the keepalive** — the control
    /// for the deadline, as on the native arm. And a `pong` nobody asked for does not arm it.
    #[test]
    fn a_pages_peer_that_never_answers_a_ping_is_never_failed_by_the_keepalive() {
        let mut heard = Heard::default();
        heard.opened();
        // Unasked: it says nothing about whether this peer answers pings.
        heard.text(heard::PONG.to_owned());
        for nth in 1..=4 {
            assert_eq!(
                keepalive(&mut heard),
                Ok(true),
                "keepalive {nth} was refused over a peer that has never ponged"
            );
            assert!(heard.unanswered());
        }
    }

    /// The relay's "this group is gone" arrives with its code; a browser's `error` and then
    /// `close` are one ending, the first; and a socket asked again after it ended says closed
    /// rather than waiting. A keepalive on an ended socket sends nothing and is not an error:
    /// the ending is `next`'s to tell.
    #[test]
    fn a_pages_socket_ends_once_with_its_code_and_says_closed_when_asked_again() {
        let mut gone = Heard::default();
        gone.opened();
        gone.closed(Some(4001));
        assert_eq!(taken(&mut gone), Some(Event::Closed(Some(4001))));
        assert_eq!(taken(&mut gone), Some(Event::Closed(None)));

        let mut died = Heard::default();
        died.opened();
        assert_eq!(keepalive(&mut died), Ok(true));
        died.failed();
        died.closed(Some(1006));
        died.text("after the end".to_owned());
        assert_eq!(keepalive(&mut died), Ok(false), "nothing is sent");
        assert_eq!(
            taken(&mut died),
            Some(Event::Failed(heard::FAILED.to_owned()))
        );
        assert_eq!(
            taken(&mut died),
            Some(Event::Closed(None)),
            "the close behind the error, and the frame behind that, are dropped"
        );
    }

    /// **A socket that never opens is a sentence, and a generic one** — a browser tells a page
    /// nothing about a refused upgrade but that it failed. One that opens is `Ok`, and stays
    /// so however often it is asked.
    #[test]
    fn a_pages_socket_that_cannot_come_up_is_a_generic_sentence() {
        let mut refused = Heard::default();
        assert_eq!(opened(&mut refused), None, "still dialling");
        refused.failed();
        refused.closed(Some(1006));
        assert_eq!(opened(&mut refused), Some(Err(heard::NOT_OPENED.to_owned())));

        let mut closed = Heard::default();
        closed.closed(Some(1006));
        let said = opened(&mut closed).unwrap().unwrap_err();
        assert!(said.starts_with(heard::NOT_OPENED), "{said}");
        assert!(said.ends_with("code 1006"), "{said}");

        let mut up = Heard::default();
        up.opened();
        assert_eq!(opened(&mut up), Some(Ok(())));
        assert_eq!(opened(&mut up), Some(Ok(())));
    }

    /// **Whoever is waiting is woken by what they wait for, once** — the open, a frame, the
    /// end — and not by a `pong`, which a caller of `next` is never handed.
    #[test]
    fn a_pages_waiter_is_woken_by_an_event_it_is_owed_and_not_by_a_pong() {
        let woken = Arc::new(Woken::default());
        let waker = Waker::from(woken.clone());
        let mut cx = Context::from_waker(&waker);
        let count = || woken.0.load(Ordering::SeqCst);

        let mut heard = Heard::default();
        assert!(heard.poll_opened(&mut cx).is_pending());
        heard.opened();
        assert_eq!(count(), 1, "the open wakes the dial");

        assert!(heard.poll_next(&mut cx).is_pending());
        heard.text(heard::PONG.to_owned());
        assert_eq!(count(), 1, "a pong is nobody's to read");
        heard.text("head".to_owned());
        assert_eq!(count(), 2);
        heard.text("another".to_owned());
        assert_eq!(count(), 2, "nobody has asked again since");

        assert_eq!(taken(&mut heard), Some(Event::Text("head".to_owned())));
        assert_eq!(taken(&mut heard), Some(Event::Text("another".to_owned())));
        assert!(heard.poll_next(&mut cx).is_pending());
        heard.closed(Some(1000));
        assert_eq!(count(), 3, "the end wakes the wait");
    }
}
