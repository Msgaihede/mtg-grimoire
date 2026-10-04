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
//! | [`connect`] | `tokio-tungstenite` over rustls, the bearer in the upgrade's `Authorization` header | **refused in a sentence** — the browser's socket is not written yet |
//! | [`Socket::keepalive`] | a **protocol** ping, which fails when the one before it was never answered by a peer that has answered one | — |
//! | [`Socket::next`] | the next text frame, or how the socket ended | — |
//!
//! **The two hosts cannot say who they are the same way, which is why the bearer is an
//! argument and not a header the caller builds.** A native client sends an arbitrary upgrade
//! request, so the bearer rides `Authorization` and the relay's gate reads it as it reads every
//! other request's. A browser's `WebSocket` constructor cannot set a header at all; the only
//! thing it lets a page choose is the list of sub-protocols, so there the bearer will ride
//! `Sec-WebSocket-Protocol`, and the keepalive will be a text frame, because a page cannot send
//! a protocol ping either. Both differences are this module's, and the loop that calls it is
//! written once.
//!
//! **Native TLS is rustls with the roots compiled in** (`rustls-tls-webpki-roots`) — the
//! desktop's choice since the socket was built, and what lets Android use the same line: no
//! system store is asked for. The manifest has the argument for the version.
//!
//! **The browser arm compiles and has never run.** It answers every [`connect`] with a refusal,
//! and no host starts the loop there yet.

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
    /// The browser's arm owes the same property, from the text `pong` its text `ping` is
    /// answered with.
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

#[cfg(target_family = "wasm")]
mod imp {
    use super::Event;

    /// What [`connect`] answers until the browser's socket is written.
    const NOT_YET: &str = "The live sync socket is not available in a browser yet.";

    /// **No browser socket exists yet, so no value of this type does either** — which is what
    /// lets the two methods below be written with nothing in them. The arm that fills this in
    /// holds the browser's own `WebSocket` here, opened with the sub-protocols `grimoire.live.v1` and
    /// `bearer.<token>` (a page cannot set `Authorization` on an upgrade), a queue its
    /// `onmessage`, `onclose` and `onerror` feed for [`Socket::next`] to drain, and a
    /// `keepalive` that sends the text frame `ping` (a page cannot send a protocol ping) and
    /// fails when the last one's text `pong` never came, as the native arm's does.
    /// Nothing about it need be `Send`: the loop that holds it is spawned on the Worker's own
    /// thread.
    pub struct Socket(std::convert::Infallible);

    pub async fn connect(_url: &str, _bearer: &str) -> Result<Socket, String> {
        Err(NOT_YET.to_owned())
    }

    impl Socket {
        pub async fn next(&mut self) -> Event {
            match self.0 {}
        }

        pub async fn keepalive(&mut self) -> Result<(), String> {
            match self.0 {}
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
}
