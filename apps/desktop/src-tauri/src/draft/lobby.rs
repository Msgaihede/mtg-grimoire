//! **A pod's lobby, this app's end of it**: the socket to the relay's `Lobby` object
//! (`infrastructure/relay/src/lobby.ts`), as the host of a lobby or a guest in one (spec §6).
//!
//! **A lobby is a draft's or a game's** ([`LobbyKind`], issue #1419): the same code, socket,
//! roster and reconnection either way. A game's lobby seats a Playtesting game instead of a pod
//! draft — each guest sends the deck it brings (`deck`), the host's app runs the game
//! (`crate::playtest::lobby`), each guest is sent its own seat's step (`game`, gzipped and in
//! base64, so a Commander board fits the relay's 64 KiB frame) and sends its actions (`act`), and
//! a refused one is told back to that guest alone (`refused`).
//!
//! **Or a trade's** ([`LobbyKind::Trade`]): two readers build one trade between them, each on
//! their own copy of it (`crate::trade::lobby`). The host's app holds the deal — both offers, a
//! revision and each reader's acceptance — and answers every change with it (`deal`); a guest
//! sends its offer (`offer`) and its acceptance of a revision (`accept`). Each app writes the
//! other reader's offer as the `theirs` side of its own copy, read in its own card data.
//!
//! **The host's app runs the draft** — the `Draft` in [`super::DraftSlot`], phase.rs's reducer
//! the authority — and every guest's app is sent its own seat's view and sends its picks. The
//! relay carries JSON frames and knows nothing of a draft; what rides inside them is the app's
//! own body (`v: 1`): `room`, `view` and `end` from the host, `pick`, `winston` (a Winston turn:
//! `{"v":1,"kind":"winston","pile":n,"take":bool}`) and `sync` from a guest — and, in a game's
//! lobby, `game` and `refused` from the host, `deck` and `act` from a guest; in a trade's,
//! `deal` from the host, `offer` and `accept` from a guest.
//!
//! **Creating a lobby is a supporter's**: `lobby_create` asks `sync_engine::commands::entitled`
//! first and then sends the relay's access token (`entitlement::access_token` over the lane, as
//! `scanner_submit` does), which the relay mints only for an entitled membership. **Joining
//! needs nothing but the code.** None of the sentences here names a membership.
//!
//! **One lobby at a time, one task per lobby** on Tauri's async runtime: it reads frames, keeps
//! [`LobbyState`] and emits `lobby:state` on every change; for a host it applies a guest's pick
//! (or Winston turn)
//! to the draft (on the engine's stack, waiting its turn) and sends every guest its view, and
//! emits `draft:view` with the host's own when it moved; for a guest it emits `draft:view` with
//! each view the host sends. A protocol ping goes out every [`PING_EVERY`], and a peer that has
//! answered one and then stops is a dropped socket; a dropped socket is opened again a few
//! times with backoff (a guest with its `rejoin` secret). The frames, the reactions and the
//! close codes are pure functions below, tested without a network.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use grimoire_play::{DraftMode, DraftSetup, DraftView, PlaytestAction, PlaytestStep};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::{self, Message};

use super::{Outcome, Shared};
use crate::playtest::lobby::{GameSeats, GuestDeck};
use crate::sync::AppState;
use crate::trade::lobby::{tidy, LobbyTrade, TradeDeal};
use grimoire_core::trade::TradeOfferLine;

// ---------------------------------------------------------------------------------------
// The wire (mirrored in `packages/ui/lib/ipc/draft.ts`)
// ---------------------------------------------------------------------------------------

/// Hosting a lobby, or a guest in one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LobbyRole {
    Host,
    Guest,
}

/// What a lobby seats: a pod draft (Draft & Packs), a Playtesting game (issue #1419), or a
/// trade between two readers (`crate::trade::lobby`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LobbyKind {
    #[default]
    Draft,
    Game,
    Trade,
}

/// Where a lobby is. `Connecting` while a dropped socket is opened again; `Drafting` once a
/// draft's lobby has started, `Playing` once a game's has, `Agreed` once both readers of a
/// trade's have accepted the same deal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LobbyPhase {
    Connecting,
    Open,
    Drafting,
    Playing,
    Agreed,
    Closed,
}

/// A guest in a lobby.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LobbyPeer {
    pub peer: String,
    pub name: String,
    pub online: bool,
    /// The name of the deck this guest brings to a game, once it has sent one. The relay's
    /// roster has none; the host fills it in from the guests' `deck` bodies.
    #[serde(default)]
    pub deck: Option<String>,
}

/// This app's lobby.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LobbyState {
    pub role: LobbyRole,
    /// What the lobby seats — a guest's is `None` until the host's room says.
    pub kind: Option<LobbyKind>,
    pub code: String,
    pub phase: LobbyPhase,
    /// This reader's name in the lobby.
    pub name: String,
    pub host_name: String,
    pub host_online: bool,
    pub peers: Vec<LobbyPeer>,
    /// The host's draft, as the room describes it.
    pub label: String,
    pub closed_reason: Option<String>,
    /// A trade's lobby: this reader's copy of the trade and the deal on the table. `None` in a
    /// draft's or a game's, and for a guest that joined from a page with no trade to hold.
    #[serde(default)]
    pub trade: Option<LobbyTrade>,
}

/// What a host tells its guests about the room.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LobbyRoom {
    #[serde(default)]
    pub kind: LobbyKind,
    pub host_name: String,
    pub label: String,
    pub peers: Vec<LobbyPeer>,
    pub started: bool,
}

// ---------------------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------------------

pub const NOT_ON: &str = "Creating a lobby is not turned on for this device.";
const UNCONFIRMED: &str =
    "The lobby could not be made: the server could not confirm this device. Try again in a moment.";
const NOT_ACCEPTED: &str = "The lobby could not be made: the server did not accept this device.";
const SLOW_DOWN: &str = "Too many tries at once. Wait a minute and try again.";
const UNREACHABLE: &str = "The lobby server could not be reached.";
const NOT_A_CODE: &str = "That is not a lobby code.";
const NOT_A_NAME: &str = "A name is 1 to 24 characters.";
const NOT_OPEN: &str = "That lobby code is not open.";
const WRONG_KEY: &str = "That lobby would not take this app as its host.";
const CLOSED_BY_HOST: &str = "The host closed the lobby.";
const LOBBY_ENDED: &str = "The lobby has closed.";
const KICKED: &str = "You were removed from the lobby.";
const STARTED: &str = "That lobby's draft, game or trade has already started.";
const FULL: &str = "That lobby is full.";
const REPLACED: &str = "This lobby was opened again in another window or on another computer.";
const TOO_BIG: &str = "The lobby closed the connection: a message was too large.";
const LOST: &str = "The connection to the lobby was lost.";
const NO_LOBBY: &str = "There is no lobby open.";
const HOST_ONLY: &str = "Only the lobby's host can do that.";
const GUEST_ONLY: &str = "Only a guest picks through the lobby.";
const GUEST_ONLY_WINSTON: &str = "Only a guest takes its Winston turn through the lobby.";
const NOT_OPEN_NOW: &str = "The lobby is not open for a new draft.";
const NOT_A_POD: &str = "A lobby's draft is a pod draft.";
const NOT_IN_LOBBY: &str = "A seat names someone who is not in the lobby.";
const NOT_SEATED: &str = "That guest has no seat at the table.";
const NOT_A_DRAFT_LOBBY: &str = "This lobby is for a game, not a draft.";
const NOT_A_GAME_LOBBY: &str = "This lobby is for a draft, not a game.";
const GUEST_ONLY_DECK: &str = "Only a guest sends its deck through the lobby.";
const GUEST_ONLY_ACT: &str = "Only a guest plays its seat through the lobby.";
const NOT_A_TRADE_LOBBY: &str = "This lobby is not for a trade.";
const NO_TRADE_HELD: &str = "A trade's lobby needs a trade of yours to hold.";
const AGREED: &str = "You have both agreed to this trade: a change now stays on your copy of it.";
const DEAL_MOVED: &str = "The trade changed before you accepted it. Look it over and accept again.";

// ---------------------------------------------------------------------------------------
// Pure pieces: codes, names, addresses, frames, reactions
// ---------------------------------------------------------------------------------------

/// The relay's code alphabet (`lobby.ts`' `LOBBY_ALPHABET`) and length.
pub const LOBBY_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
pub const CODE_LENGTH: usize = 6;
/// A name, trimmed, in characters (`lobby.ts`' `MAX_NAME_CHARS`).
pub const MAX_NAME_CHARS: usize = 24;

/// How often a protocol ping goes out.
pub const PING_EVERY: Duration = Duration::from_secs(30);
/// How many times a dropped socket is opened again before the lobby is given up on.
const MAX_RECONNECTS: u32 = 6;
/// How long the first frame may take after a socket opens.
const FIRST_FRAME_WAIT: Duration = Duration::from_secs(15);
/// How many times the other reader's offer is written while a sync holds the write connection.
const WRITE_TRIES: u32 = 6;

/// A code as the relay names a lobby: trimmed and upper-cased, six of [`LOBBY_ALPHABET`].
pub fn lobby_code(raw: &str) -> Result<String, String> {
    let code = raw.trim().to_ascii_uppercase();
    if code.chars().count() == CODE_LENGTH && code.chars().all(|c| LOBBY_ALPHABET.contains(c)) {
        Ok(code)
    } else {
        Err(NOT_A_CODE.to_owned())
    }
}

/// A name as the relay takes one: trimmed, 1 to [`MAX_NAME_CHARS`] characters, no control
/// character.
pub fn lobby_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    let chars = name.chars().count();
    if (1..=MAX_NAME_CHARS).contains(&chars) && !name.chars().any(char::is_control) {
        Ok(name.to_owned())
    } else {
        Err(NOT_A_NAME.to_owned())
    }
}

/// Who a socket is opened as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Join {
    Host {
        key: String,
    },
    Guest {
        name: String,
        rejoin: Option<(String, String)>,
    },
}

/// `text` for a query string: RFC 3986's unreserved characters as they are, every other byte
/// `%XX`.
fn query_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The socket's address under the relay's `base`.
pub fn socket_url(base: &str, code: &str, join: &Join) -> String {
    let origin = grimoire_core::platform::socket::ws_origin(base);
    let query = match join {
        Join::Host { key } => format!("role=host&key={}", query_escape(key)),
        Join::Guest { name, rejoin } => {
            let mut q = format!("role=guest&name={}", query_escape(name));
            if let Some((peer, secret)) = rejoin {
                q.push_str(&format!(
                    "&rejoin={}.{}",
                    query_escape(peer),
                    query_escape(secret)
                ));
            }
            q
        }
    };
    format!("{origin}/lobby/{code}/ws?{query}")
}

/// The relay's frames, as this app writes them.
pub fn send_frame(to: &str, body: &Value) -> String {
    json!({ "t": "send", "to": to, "body": body }).to_string()
}
pub fn lock_frame() -> String {
    json!({ "t": "lock" }).to_string()
}
pub fn kick_frame(peer: &str) -> String {
    json!({ "t": "kick", "peer": peer }).to_string()
}
pub fn close_frame() -> String {
    json!({ "t": "close" }).to_string()
}
pub fn guest_frame(body: &Value) -> String {
    json!({ "t": "msg", "body": body }).to_string()
}

/// The app's bodies (`v: 1`).
pub fn room_body(room: &LobbyRoom) -> Value {
    json!({ "v": 1, "kind": "room", "room": room })
}
pub fn view_body(view: &DraftView) -> Value {
    json!({ "v": 1, "kind": "view", "view": view })
}
pub fn end_body(reason: &str) -> Value {
    json!({ "v": 1, "kind": "end", "reason": reason })
}
pub fn pick_body(ids: &[String]) -> Value {
    json!({ "v": 1, "kind": "pick", "ids": ids })
}
pub fn winston_body(pile: u8, take: bool) -> Value {
    json!({ "v": 1, "kind": "winston", "pile": pile, "take": take })
}
pub fn sync_body() -> Value {
    json!({ "v": 1, "kind": "sync" })
}
/// A game's: the deck a guest brings, its action, the step it is sent (packed, `z`), and a
/// refusal of its action.
pub fn deck_body(deck: &GuestDeck) -> Value {
    json!({ "v": 1, "kind": "deck", "deck": deck })
}
pub fn act_body(action: &PlaytestAction) -> Value {
    json!({ "v": 1, "kind": "act", "action": action })
}
pub fn game_body(packed: &str) -> Value {
    json!({ "v": 1, "kind": "game", "z": packed })
}
pub fn refused_body(reason: &str) -> Value {
    json!({ "v": 1, "kind": "refused", "reason": reason })
}
/// A trade's: a guest's offer, its acceptance of revision `rev` (or taking one back), and the
/// deal as the host holds it.
pub fn offer_body(lines: &[TradeOfferLine]) -> Value {
    json!({ "v": 1, "kind": "offer", "lines": lines })
}
pub fn accept_body(rev: u64, yes: bool) -> Value {
    json!({ "v": 1, "kind": "accept", "rev": rev, "yes": yes })
}
pub fn deal_body(deal: &TradeDeal) -> Value {
    json!({ "v": 1, "kind": "deal", "deal": deal })
}

/// A frame the relay sent, read.
#[derive(Debug, Clone, PartialEq)]
pub enum Heard {
    /// To the host: who is in the room.
    Peers(Vec<LobbyPeer>),
    /// The app's body — to the host `from` a guest, to a guest from the host.
    Msg { from: Option<String>, body: Body },
    /// To a guest, once a socket: its seat and its rejoin secret.
    Welcome {
        peer: String,
        secret: String,
        host_online: bool,
    },
    /// To a guest: the host came or went.
    Host(bool),
    /// Anything else, ignored.
    Other,
}

/// The app's body, read.
#[derive(Debug, Clone, PartialEq)]
pub enum Body {
    Room(LobbyRoom),
    View(Box<DraftView>),
    End(String),
    Pick(Vec<String>),
    /// A Winston turn: take the pile in play, or decline it.
    Winston {
        pile: u8,
        take: bool,
    },
    Sync,
    /// A game's lobby: the deck a guest brings.
    Deck(Box<GuestDeck>),
    /// A game's lobby: a guest's action.
    Act(Box<PlaytestAction>),
    /// A game's lobby: this guest's step, packed (`crate::playtest::lobby::unpack`).
    Game(String),
    /// A game's lobby: the host refused this guest's action, saying why.
    Refused(String),
    /// A trade's lobby: what a guest offers.
    Offer(Vec<TradeOfferLine>),
    /// A trade's lobby: a guest accepts revision `rev` of the deal, or takes that back.
    Accept {
        rev: u64,
        yes: bool,
    },
    /// A trade's lobby: the deal, as the host holds it.
    Deal(Box<TradeDeal>),
    Other,
}

fn body_of(value: &Value) -> Body {
    if value.get("v").and_then(Value::as_u64) != Some(1) {
        return Body::Other;
    }
    let read = || -> Option<Body> {
        Some(match value.get("kind")?.as_str()? {
            "room" => Body::Room(serde_json::from_value(value.get("room")?.clone()).ok()?),
            "view" => Body::View(Box::new(
                serde_json::from_value(value.get("view")?.clone()).ok()?,
            )),
            "end" => Body::End(value.get("reason")?.as_str()?.to_owned()),
            "pick" => Body::Pick(serde_json::from_value(value.get("ids")?.clone()).ok()?),
            "winston" => Body::Winston {
                pile: u8::try_from(value.get("pile")?.as_u64()?).ok()?,
                take: value.get("take")?.as_bool()?,
            },
            "sync" => Body::Sync,
            "deck" => Body::Deck(Box::new(
                serde_json::from_value(value.get("deck")?.clone()).ok()?,
            )),
            "act" => Body::Act(Box::new(
                serde_json::from_value(value.get("action")?.clone()).ok()?,
            )),
            "game" => Body::Game(value.get("z")?.as_str()?.to_owned()),
            "refused" => Body::Refused(value.get("reason")?.as_str()?.to_owned()),
            "offer" => Body::Offer(serde_json::from_value(value.get("lines")?.clone()).ok()?),
            "accept" => Body::Accept {
                rev: value.get("rev")?.as_u64()?,
                yes: value.get("yes")?.as_bool()?,
            },
            "deal" => Body::Deal(Box::new(
                serde_json::from_value(value.get("deal")?.clone()).ok()?,
            )),
            _ => Body::Other,
        })
    };
    read().unwrap_or(Body::Other)
}

/// A text frame, read. What is not JSON, or not a frame this app knows, is [`Heard::Other`].
pub fn decode(text: &str) -> Heard {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Heard::Other;
    };
    let read = || -> Option<Heard> {
        Some(match value.get("t")?.as_str()? {
            "peers" => Heard::Peers(serde_json::from_value(value.get("peers")?.clone()).ok()?),
            "msg" => Heard::Msg {
                from: value.get("from").and_then(Value::as_str).map(str::to_owned),
                body: body_of(value.get("body")?),
            },
            "welcome" => Heard::Welcome {
                peer: value.get("peer")?.as_str()?.to_owned(),
                secret: value.get("secret")?.as_str()?.to_owned(),
                host_online: value.get("hostOnline")?.as_bool()?,
            },
            "host" => Heard::Host(value.get("online")?.as_bool()?),
            _ => Heard::Other,
        })
    };
    read().unwrap_or(Heard::Other)
}

/// What a frame asks the lobby's task to do, beyond the state it changed.
#[derive(Debug, Clone, PartialEq)]
pub enum Act {
    /// Host: tell every guest about the room.
    BroadcastRoom,
    /// Host: who is on the line, for the draft's seats.
    SeatsOnline(Vec<LobbyPeer>),
    /// Host: a guest's pick, for the draft.
    Pick { from: String, ids: Vec<String> },
    /// Host: a guest's Winston turn, for the draft.
    Winston { from: String, pile: u8, take: bool },
    /// Host: a guest asked for the room and its view again.
    Resend(String),
    /// Guest: show the host's view of this seat.
    ShowView(Box<DraftView>),
    /// Guest: ask the host for the room and this seat's view.
    AskSync,
    /// Guest: the seat and its rejoin secret, for a socket opened again.
    Remember { peer: String, secret: String },
    /// Guest: the host ended the lobby, saying why.
    End(String),
    /// Host: the deck a guest brings to the game.
    Deck { from: String, deck: Box<GuestDeck> },
    /// Host: a guest's action, for the game.
    Play {
        from: String,
        action: Box<PlaytestAction>,
    },
    /// Guest: show the host's step of this seat (packed).
    ShowGame(String),
    /// Guest: the host refused this seat's action.
    Refused(String),
    /// Host of a trade's lobby: send the deal to the other reader.
    BroadcastDeal,
    /// Host of a trade's lobby: the other reader is here, so nobody else may join.
    Lock,
    /// Host of a trade's lobby: a second guest raced the lock in, and goes.
    Kick(String),
    /// A trade's lobby: write the other reader's offer as `theirs` on this reader's copy.
    WriteTheirs(Vec<TradeOfferLine>),
}

/// The room as a host describes it to its guests.
pub fn room_of(state: &LobbyState) -> LobbyRoom {
    LobbyRoom {
        kind: state.kind.unwrap_or_default(),
        host_name: state.host_name.clone(),
        label: state.label.clone(),
        peers: state.peers.clone(),
        started: matches!(
            state.phase,
            LobbyPhase::Drafting | LobbyPhase::Playing | LobbyPhase::Agreed
        ),
    }
}

/// The longest name a guest's deck goes by in the room, in characters.
const MAX_DECK_NAME_CHARS: usize = 80;

/// One frame heard: `state` changed as it says, and what is left to do.
pub fn react(state: &mut LobbyState, heard: Heard) -> Vec<Act> {
    match (state.role, heard) {
        (LobbyRole::Host, Heard::Peers(mut peers)) => {
            // The roster knows nobody's deck: each guest keeps the one it sent.
            for peer in &mut peers {
                peer.deck = state
                    .peers
                    .iter()
                    .find(|p| p.peer == peer.peer)
                    .and_then(|p| p.deck.clone());
            }
            state.peers = peers.clone();
            let mut acts = vec![Act::BroadcastRoom];
            if state.kind == Some(LobbyKind::Trade) && !peers.is_empty() {
                // A trade is two people: the first guest is the other reader, and the room is
                // shut behind them.
                acts.push(Act::Lock);
                acts.extend(peers.iter().skip(1).map(|p| Act::Kick(p.peer.clone())));
            }
            if state.phase == LobbyPhase::Drafting {
                acts.push(Act::SeatsOnline(peers));
            }
            acts
        }
        (
            LobbyRole::Host,
            Heard::Msg {
                from: Some(from),
                body: Body::Pick(ids),
            },
        ) if state.phase == LobbyPhase::Drafting => vec![Act::Pick { from, ids }],
        (
            LobbyRole::Host,
            Heard::Msg {
                from: Some(from),
                body: Body::Winston { pile, take },
            },
        ) if state.phase == LobbyPhase::Drafting => vec![Act::Winston { from, pile, take }],
        (
            LobbyRole::Host,
            Heard::Msg {
                from: Some(from),
                body: Body::Sync,
            },
        ) => vec![Act::Resend(from)],
        (
            LobbyRole::Host,
            Heard::Msg {
                from: Some(from),
                body: Body::Deck(deck),
            },
        ) if state.kind == Some(LobbyKind::Game) && state.phase == LobbyPhase::Open => {
            let Some(peer) = state.peers.iter_mut().find(|p| p.peer == from) else {
                return Vec::new();
            };
            peer.deck = Some(deck.name.chars().take(MAX_DECK_NAME_CHARS).collect());
            vec![Act::Deck { from, deck }, Act::BroadcastRoom]
        }
        (
            LobbyRole::Host,
            Heard::Msg {
                from: Some(from),
                body: Body::Act(action),
            },
        ) if state.phase == LobbyPhase::Playing => vec![Act::Play { from, action }],
        (
            LobbyRole::Host,
            Heard::Msg {
                from: Some(from),
                body: Body::Offer(lines),
            },
        ) if state.phase == LobbyPhase::Open && partner(state, &from) => {
            let lines = tidy(lines);
            let Some(trade) = state.trade.as_mut() else {
                return Vec::new();
            };
            if !trade.deal.offer(false, lines.clone()) {
                return Vec::new();
            }
            vec![Act::WriteTheirs(lines), Act::BroadcastDeal]
        }
        (
            LobbyRole::Host,
            Heard::Msg {
                from: Some(from),
                body: Body::Accept { rev, yes },
            },
        ) if state.phase == LobbyPhase::Open && partner(state, &from) => {
            let Some(trade) = state.trade.as_mut() else {
                return Vec::new();
            };
            if !trade.deal.accept(false, rev, yes) {
                // An acceptance of a deal that has since moved: the guest is shown the one
                // on the table.
                return vec![Act::BroadcastDeal];
            }
            if trade.deal.agreed() {
                state.phase = LobbyPhase::Agreed;
                return vec![Act::BroadcastDeal, Act::BroadcastRoom];
            }
            vec![Act::BroadcastDeal]
        }
        (
            LobbyRole::Guest,
            Heard::Welcome {
                peer,
                secret,
                host_online,
            },
        ) => {
            state.host_online = host_online;
            vec![Act::Remember { peer, secret }, Act::AskSync]
        }
        (LobbyRole::Guest, Heard::Host(online)) => {
            state.host_online = online;
            Vec::new()
        }
        (LobbyRole::Guest, Heard::Msg { body, .. }) => match body {
            Body::Room(room) => {
                state.kind = Some(room.kind);
                state.host_name = room.host_name;
                state.label = room.label;
                state.peers = room.peers;
                if room.started && state.phase == LobbyPhase::Open {
                    state.phase = started(room.kind);
                }
                Vec::new()
            }
            Body::View(view) => {
                if state.phase == LobbyPhase::Open {
                    state.phase = LobbyPhase::Drafting;
                }
                vec![Act::ShowView(view)]
            }
            Body::Game(packed) => {
                if state.phase == LobbyPhase::Open {
                    state.phase = LobbyPhase::Playing;
                }
                vec![Act::ShowGame(packed)]
            }
            Body::Refused(reason) => vec![Act::Refused(reason)],
            Body::End(reason) => vec![Act::End(reason)],
            Body::Deal(deal) => {
                let Some(trade) = state.trade.as_mut() else {
                    return Vec::new();
                };
                let deal = *deal;
                let deal = TradeDeal {
                    host: tidy(deal.host),
                    guest: tidy(deal.guest),
                    ..deal
                };
                let moved = trade.deal.host != deal.host;
                let agreed = deal.agreed();
                trade.deal = deal;
                if agreed && state.phase == LobbyPhase::Open {
                    state.phase = LobbyPhase::Agreed;
                }
                if moved {
                    vec![Act::WriteTheirs(trade.deal.host.clone())]
                } else {
                    Vec::new()
                }
            }
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// Whether `from` is the other reader of a trade's lobby: the first guest in, the one the room
/// was locked behind.
fn partner(state: &LobbyState, from: &str) -> bool {
    state.kind == Some(LobbyKind::Trade) && state.peers.first().is_some_and(|p| p.peer == from)
}

/// The phase a lobby of `kind` is in once it has started.
pub fn started(kind: LobbyKind) -> LobbyPhase {
    match kind {
        LobbyKind::Draft => LobbyPhase::Drafting,
        LobbyKind::Game => LobbyPhase::Playing,
        LobbyKind::Trade => LobbyPhase::Agreed,
    }
}

/// What a close code says to `role`, or `None` for a socket that only dropped — opened again.
pub fn closed_reason(role: LobbyRole, code: Option<u16>) -> Option<&'static str> {
    Some(match code? {
        4000 if role == LobbyRole::Host => LOBBY_ENDED,
        4000 => CLOSED_BY_HOST,
        4001 => KICKED,
        4003 => STARTED,
        4004 => FULL,
        4005 => REPLACED,
        1009 => TOO_BIG,
        _ => return None,
    })
}

/// What an upgrade the relay answered with `status` says, or `None` for one worth trying again.
pub fn refused(role: LobbyRole, status: u16) -> Option<&'static str> {
    Some(match status {
        404 => NOT_OPEN,
        403 if role == LobbyRole::Host => WRONG_KEY,
        403 => NOT_OPEN,
        400 => NOT_A_NAME,
        429 => SLOW_DOWN,
        _ => return None,
    })
}

/// The wait before the `attempt`th (0-based) reopening: 1, 2, 4, 8, 16, 16 seconds.
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_secs(1 << attempt.min(4))
}

// ---------------------------------------------------------------------------------------
// The lobby held, and its task
// ---------------------------------------------------------------------------------------

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The one lobby, or none. Shared with its task.
#[derive(Default)]
pub struct LobbySlot(pub(crate) Arc<Mutex<Option<Live>>>);

/// What the task's writer sends.
enum Out {
    Text(String),
    Close,
}

pub(crate) struct Live {
    /// Which lobby this is: a task whose lobby has been left or replaced stops.
    generation: u64,
    state: LobbyState,
    out: UnboundedSender<Out>,
    base: String,
    /// The host's key.
    key: Option<String>,
    /// A guest's seat and secret, once welcomed.
    rejoin: Option<(String, String)>,
    /// The host's pod draft, once started.
    draft: Option<u64>,
    /// The host's game, once started: whose seat is whose.
    game: Option<GameSeats>,
    /// The deck each guest of a game's lobby sent, by peer: what it is dealt.
    decks: HashMap<String, GuestDeck>,
    /// The phase a dropped socket was in, put back when it is open again.
    resume: Option<LobbyPhase>,
}

impl Live {
    fn url(&self) -> String {
        let join = match (&self.state.role, &self.key) {
            (LobbyRole::Host, Some(key)) => Join::Host { key: key.clone() },
            _ => Join::Guest {
                name: self.state.name.clone(),
                rejoin: self.rejoin.clone(),
            },
        };
        socket_url(&self.base, &self.state.code, &join)
    }

    fn send(&self, text: String) {
        let _ = self.out.send(Out::Text(text));
    }
}

fn lock(lobby: &Mutex<Option<Live>>) -> MutexGuard<'_, Option<Live>> {
    crate::sync::lock_plain(lobby)
}

static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Send each `(peer, view)` to its guest, if this app hosts a lobby — after a pick of the host's.
pub(crate) fn send_views(lobby: &LobbySlot, views: &[(String, DraftView)]) {
    if views.is_empty() {
        return;
    }
    if let Some(live) = lock(&lobby.0).as_ref() {
        if live.state.role == LobbyRole::Host {
            for (peer, view) in views {
                live.send(send_frame(peer, &view_body(view)));
            }
        }
    }
}

/// Each guest's step of the host's `game`, sent to it — after an action of the host's own on the
/// board (`playtest_act`). Nothing is sent for a game that is not this lobby's.
pub(crate) fn send_game_steps(lobby: &LobbySlot, game: u64, steps: &[(u8, PlaytestStep)]) {
    if steps.is_empty() {
        return;
    }
    if let Some(live) = lock(&lobby.0).as_ref() {
        if live.state.role != LobbyRole::Host {
            return;
        }
        if let Some(seats) = live.game.as_ref().filter(|g| g.game == game) {
            for (peer, body) in game_frames(seats, steps, false) {
                live.send(send_frame(&peer, &body));
            }
        }
    }
}

/// The `game` body each guest of `seats` is sent for its step.
fn game_frames(
    seats: &GameSeats,
    steps: &[(u8, PlaytestStep)],
    dealt: bool,
) -> Vec<(String, Value)> {
    steps
        .iter()
        .filter_map(|(seat, step)| {
            let peer = seats.peer_of(*seat)?.to_owned();
            let packed =
                crate::playtest::lobby::pack(&seats.guest_game(*seat, step.clone(), dealt));
            Some((peer, game_body(&packed)))
        })
        .collect()
}

/// Everything the task and the commands that act on a lobby need.
#[derive(Clone)]
struct Ctx {
    app: tauri::AppHandle,
    lobby: Arc<Mutex<Option<Live>>>,
    draft: Arc<Shared>,
    state: Arc<AppState>,
    generation: u64,
    role: LobbyRole,
}

/// How a connection ended.
enum Ended {
    /// This app left, or the lobby was replaced.
    Left,
    /// The socket dropped: open it again.
    Dropped,
    /// The lobby is over for this app, and this is why.
    Final(String),
}

impl Ctx {
    /// `work` on this lobby, while it is still the one held.
    fn with<T>(&self, work: impl FnOnce(&mut Live) -> T) -> Option<T> {
        let mut held = lock(&self.lobby);
        held.as_mut()
            .filter(|live| live.generation == self.generation)
            .map(work)
    }

    fn emit_state(&self) {
        if let Some(state) = self.with(|live| live.state.clone()) {
            let _ = self.app.emit("lobby:state", state);
        }
    }

    fn emit_view(&self, view: &DraftView) {
        let _ = self.app.emit("draft:view", view);
    }

    fn close(&self, reason: String) {
        self.with(|live| {
            live.state.phase = LobbyPhase::Closed;
            live.state.closed_reason = Some(reason);
            if live.state.role == LobbyRole::Guest {
                live.state.host_online = false;
            }
        });
        self.emit_state();
    }

    fn dropped(&self) {
        self.with(|live| {
            if live.state.phase != LobbyPhase::Connecting {
                live.resume = Some(live.state.phase);
            }
            live.state.phase = LobbyPhase::Connecting;
        });
        self.emit_state();
    }

    fn reconnected(&self) {
        self.with(|live| {
            if let Some(phase) = live.resume.take() {
                live.state.phase = phase;
            }
        });
        self.emit_state();
    }

    fn pod(&self) -> Option<u64> {
        self.with(|live| live.draft).flatten()
    }

    fn game(&self) -> Option<GameSeats> {
        self.with(|live| live.game.clone()).flatten()
    }

    fn send_body(&self, to: &str, body: &Value) {
        self.with(|live| live.send(send_frame(to, body)));
    }

    /// A move of the host's game passed on: the host's board shown the host's step, each guest
    /// sent its own.
    fn pass_on_game(&self, seats: &GameSeats, host: PlaytestStep, guests: &[(u8, PlaytestStep)]) {
        crate::playtest::lobby::emit_host(&self.app, seats.game, host);
        self.with(|live| {
            for (peer, body) in game_frames(seats, guests, false) {
                live.send(send_frame(&peer, &body));
            }
        });
    }

    /// `peer`'s seat of the host's game handed to the AI, and the game played on.
    async fn hand_over(&self, peer: &str) -> Result<(), String> {
        let Some(seats) = self.game() else {
            return Ok(());
        };
        let Some(seat) = seats.seat_of(peer) else {
            return Ok(());
        };
        let (host, guests) = crate::playtest::lobby::hand_over(&self.app, seats.game, seat).await?;
        let seats = self
            .with(|live| {
                let game = live.game.as_mut()?;
                game.peers.retain(|(p, _)| p != peer);
                Some(game.clone())
            })
            .flatten()
            .unwrap_or(seats);
        self.pass_on_game(&seats, host, &guests);
        Ok(())
    }

    /// A change to the pod draft passed on: each guest its view, the host's own when it moved.
    fn pass_on(&self, outcome: &Outcome) {
        self.with(|live| {
            for (peer, view) in &outcome.guests {
                live.send(send_frame(peer, &view_body(view)));
            }
        });
        if outcome.moved() {
            self.emit_view(&outcome.view);
        }
    }

    /// Change the pod draft by `change`, waiting its turn, and pass it on.
    async fn change_pod(
        &self,
        change: impl FnOnce(&mut grimoire_play::Draft) -> Result<(), String> + Send + 'static,
    ) -> Result<(), String> {
        let draft = self.pod().ok_or(NOT_SEATED)?;
        let outcome = super::change(&self.state, &self.draft, draft, true, change).await?;
        self.pass_on(&outcome);
        Ok(())
    }

    /// Send `peer` the room and, in a draft, its seat's view — in a game, its seat's step.
    async fn resend(&self, peer: String) {
        self.with(|live| {
            live.send(send_frame(&peer, &room_body(&room_of(&live.state))));
            if let Some(trade) = &live.state.trade {
                live.send(send_frame(&peer, &deal_body(&trade.deal)));
            }
        });
        if let Some(seats) = self.game() {
            let Some(seat) = seats.seat_of(&peer) else {
                return;
            };
            if let Ok(step) = crate::playtest::lobby::step_of(&self.app, seats.game, seat).await {
                for (to, body) in game_frames(&seats, &[(seat, step)], false) {
                    self.send_body(&to, &body);
                }
            }
            return;
        }
        let Some(draft) = self.pod() else {
            return;
        };
        let to = peer.clone();
        let view = super::on_draft_waiting(&self.draft, draft, move |d| {
            seat_of(d, &to).map(|seat| d.view(seat))
        })
        .await;
        if let Ok(Some(view)) = view {
            self.with(|live| live.send(send_frame(&peer, &view_body(&view))));
        }
    }

    /// Do what a frame asked; `Some` ends the connection.
    async fn act(&self, act: Act) -> Option<Ended> {
        match act {
            Act::BroadcastRoom => {
                self.with(|live| live.send(send_frame("*", &room_body(&room_of(&live.state)))));
            }
            Act::SeatsOnline(peers) => {
                let _ = self
                    .change_pod(move |d| {
                        let seats: Vec<(u8, bool)> = d
                            .seats()
                            .iter()
                            .enumerate()
                            .filter_map(|(seat, setup)| {
                                let peer = setup.peer.as_deref()?;
                                let online = peers.iter().any(|p| p.peer == peer && p.online);
                                Some((u8::try_from(seat).ok()?, online))
                            })
                            .collect();
                        for (seat, online) in seats {
                            d.set_connected(seat, online);
                        }
                        Ok(())
                    })
                    .await;
            }
            Act::Pick { from, ids } => {
                let peer = from.clone();
                let picked = self
                    .change_pod(move |d| {
                        let seat = seat_of(d, &peer).ok_or(NOT_SEATED)?;
                        d.pick(seat, ids)
                    })
                    .await;
                // A refused pick: the guest is shown its seat as it still stands.
                if picked.is_err() {
                    self.resend(from).await;
                }
            }
            Act::Winston { from, pile, take } => {
                let peer = from.clone();
                let decided = self
                    .change_pod(move |d| {
                        let seat = seat_of(d, &peer).ok_or(NOT_SEATED)?;
                        d.winston(seat, pile, take)
                    })
                    .await;
                // A refused turn: the guest is shown its seat as it still stands.
                if decided.is_err() {
                    self.resend(from).await;
                }
            }
            Act::Resend(peer) => self.resend(peer).await,
            Act::ShowView(view) => self.emit_view(&view),
            Act::AskSync => {
                self.with(|live| live.send(guest_frame(&sync_body())));
            }
            Act::Remember { peer, secret } => {
                self.with(|live| live.rejoin = Some((peer, secret)));
            }
            Act::End(reason) => return Some(Ended::Final(reason)),
            Act::Deck { from, deck } => {
                self.with(|live| live.decks.insert(from, *deck));
            }
            Act::Play { from, action } => {
                // No game: nothing to play, and the connection goes on.
                let seats = self.game()?;
                let Some(seat) = seats.seat_of(&from) else {
                    self.send_body(&from, &refused_body(NOT_SEATED));
                    return None;
                };
                match crate::playtest::lobby::play(&self.app, seats.game, seat, *action).await {
                    Ok((host, guests)) => self.pass_on_game(&seats, host, &guests),
                    // A refused action changed nothing: the guest is told why, and its board
                    // keeps the step it had.
                    Err(reason) => self.send_body(&from, &refused_body(&reason)),
                }
            }
            Act::ShowGame(packed) => {
                if let Some(game) = crate::playtest::lobby::unpack(&packed) {
                    let _ = self.app.emit("lobby:game", game);
                }
            }
            Act::Refused(reason) => {
                let _ = self.app.emit("lobby:refused", reason);
            }
            Act::BroadcastDeal => self.broadcast_deal(),
            Act::Lock => {
                self.with(|live| live.send(lock_frame()));
            }
            Act::Kick(peer) => {
                self.with(|live| live.send(kick_frame(&peer)));
            }
            Act::WriteTheirs(lines) => self.write_theirs(lines).await,
        }
        None
    }

    /// Host of a trade's lobby: the deal, to the other reader.
    fn broadcast_deal(&self) {
        self.with(|live| {
            if let Some(trade) = &live.state.trade {
                live.send(send_frame("*", &deal_body(&trade.deal)));
            }
        });
    }

    /// The other reader's offer written as `theirs` on this reader's copy of the trade, and the
    /// state told again — always, so the page reads the trade afresh whatever the write did.
    /// A refused write (the reader has finished or deleted their copy) leaves the copy as the
    /// reader left it. **A sync holding the write connection is waited out**, a few times over:
    /// the offer is not sent twice, so a write given up here would leave this copy behind the
    /// deal its reader is asked to accept.
    async fn write_theirs(&self, lines: Vec<TradeOfferLine>) {
        let Some(id) = self
            .with(|live| live.state.trade.as_ref().and_then(|t| t.trade_id))
            .flatten()
        else {
            return;
        };
        let mut written = Err(String::new());
        for _ in 0..WRITE_TRIES {
            let state = self.state.clone();
            let lines = lines.clone();
            written = tauri::async_runtime::spawn_blocking(move || {
                crate::sync::with_write(&state, |c| {
                    grimoire_core::trade::replace_side(c, id, grimoire_core::trade::THEIRS, &lines)
                })
            })
            .await
            .unwrap_or_else(|e| Err(e.to_string()));
            if !matches!(&written, Err(e) if e == grimoire_core::db::BUSY) {
                break;
            }
        }
        if let Ok(unknown) = written {
            self.with(|live| {
                if let Some(trade) = live.state.trade.as_mut() {
                    trade.unknown = unknown;
                }
            });
        }
        self.emit_state();
    }

    /// One text frame: the state changed, `lobby:state` emitted if it moved, the acts done.
    async fn hear(&self, text: &str) -> Option<Ended> {
        let heard = decode(text);
        let Some((acts, moved)) = self.with(|live| {
            let before = live.state.clone();
            let acts = react(&mut live.state, heard);
            (acts, before != live.state)
        }) else {
            return Some(Ended::Left);
        };
        if moved {
            self.emit_state();
        }
        for act in acts {
            if let Some(ended) = self.act(act).await {
                return Some(ended);
            }
        }
        None
    }
}

/// The seat a lobby peer sits in.
fn seat_of(draft: &grimoire_play::Draft, peer: &str) -> Option<u8> {
    draft
        .seats()
        .iter()
        .position(|s| !s.bot && s.peer.as_deref() == Some(peer))
        .and_then(|seat| u8::try_from(seat).ok())
}

/// Why a socket did not open.
enum Unopened {
    /// The relay said no, and this is why.
    Refused(&'static str),
    /// It may open on another try.
    Failed,
}

async fn open(url: &str, role: LobbyRole) -> Result<Ws, Unopened> {
    match tokio_tungstenite::connect_async(url).await {
        Ok((ws, _)) => Ok(ws),
        Err(tungstenite::Error::Http(response)) => {
            match refused(role, response.status().as_u16()) {
                Some(reason) => Err(Unopened::Refused(reason)),
                None => Err(Unopened::Failed),
            }
        }
        Err(_) => Err(Unopened::Failed),
    }
}

/// Open a socket and read its first frame — `peers` for a host, `welcome` for a guest — so a
/// lobby that refuses this app says so to the command, in its sentence.
async fn open_first(url: &str, role: LobbyRole) -> Result<(Ws, Heard), String> {
    let mut ws = open(url, role).await.map_err(|e| match e {
        Unopened::Refused(reason) => reason.to_owned(),
        Unopened::Failed => UNREACHABLE.to_owned(),
    })?;
    let first = tokio::time::timeout(FIRST_FRAME_WAIT, async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Text(text))) => return Ok(decode(text.as_str())),
                Some(Ok(Message::Close(frame))) => {
                    let code = frame.map(|f| u16::from(f.code));
                    return Err(closed_reason(role, code).unwrap_or(LOST).to_owned());
                }
                Some(Ok(_)) => continue,
                None | Some(Err(_)) => return Err(LOST.to_owned()),
            }
        }
    })
    .await
    .map_err(|_| UNREACHABLE.to_owned())??;
    Ok((ws, first))
}

/// The lobby's task: one connection after another until the lobby is over for this app.
async fn run(ctx: Ctx, first: Ws, mut rx: UnboundedReceiver<Out>) {
    let mut socket = Some(first);
    loop {
        let ws = match socket.take() {
            Some(ws) => ws,
            None => match reopen(&ctx).await {
                Ok(ws) => ws,
                Err(Ended::Final(reason)) => return ctx.close(reason),
                Err(_) => return,
            },
        };
        match connection(&ctx, ws, &mut rx).await {
            Ended::Left => return,
            Ended::Final(reason) => return ctx.close(reason),
            Ended::Dropped => ctx.dropped(),
        }
    }
}

/// Open a dropped socket again, a few times with backoff.
async fn reopen(ctx: &Ctx) -> Result<Ws, Ended> {
    for attempt in 0..MAX_RECONNECTS {
        tokio::time::sleep(backoff(attempt)).await;
        let Some(url) = ctx.with(|live| live.url()) else {
            return Err(Ended::Left);
        };
        match open(&url, ctx.role).await {
            Ok(ws) => {
                ctx.reconnected();
                return Ok(ws);
            }
            Err(Unopened::Refused(reason)) => return Err(Ended::Final(reason.to_owned())),
            Err(Unopened::Failed) => continue,
        }
    }
    Err(Ended::Final(LOST.to_owned()))
}

/// One open socket: frames read and acted on, the writer's queue sent, a ping every
/// [`PING_EVERY`] — and a peer that has answered a ping and then misses one is a dropped socket.
async fn connection(ctx: &Ctx, ws: Ws, rx: &mut UnboundedReceiver<Out>) -> Ended {
    let (mut sink, mut stream) = ws.split();
    let unanswered = AtomicBool::new(false);
    let answers = AtomicBool::new(false);
    let reader = async {
        loop {
            match stream.next().await {
                Some(Ok(Message::Text(text))) => {
                    if let Some(ended) = ctx.hear(text.as_str()).await {
                        return ended;
                    }
                }
                Some(Ok(Message::Pong(_))) => {
                    if unanswered.swap(false, Ordering::Relaxed) {
                        answers.store(true, Ordering::Relaxed);
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    let code = frame.map(|f| u16::from(f.code));
                    return match closed_reason(ctx.role, code) {
                        Some(reason) => Ended::Final(reason.to_owned()),
                        None => Ended::Dropped,
                    };
                }
                Some(Ok(_)) => {}
                None | Some(Err(_)) => return Ended::Dropped,
            }
        }
    };
    let writer = async {
        let mut next_ping = tokio::time::Instant::now() + PING_EVERY;
        loop {
            match tokio::time::timeout_at(next_ping, rx.recv()).await {
                Ok(Some(Out::Text(text))) => {
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        return Ended::Dropped;
                    }
                }
                Ok(Some(Out::Close)) | Ok(None) => {
                    let _ = sink.send(Message::Close(None)).await;
                    return Ended::Left;
                }
                Err(_) => {
                    if unanswered.load(Ordering::Relaxed) && answers.load(Ordering::Relaxed) {
                        return Ended::Dropped;
                    }
                    if sink
                        .send(Message::Ping(Vec::<u8>::new().into()))
                        .await
                        .is_err()
                    {
                        return Ended::Dropped;
                    }
                    unanswered.store(true, Ordering::Relaxed);
                    next_ping = tokio::time::Instant::now() + PING_EVERY;
                }
            }
        }
    };
    let reader = std::pin::pin!(reader);
    let writer = std::pin::pin!(writer);
    match futures_util::future::select(reader, writer).await {
        futures_util::future::Either::Left((ended, _))
        | futures_util::future::Either::Right((ended, _)) => ended,
    }
}

/// Put `live` in the slot — closing whatever lobby was there — do what its first frame asked,
/// and start its task. Answers the state.
#[allow(clippy::too_many_arguments)]
async fn install(
    app: tauri::AppHandle,
    state: Arc<AppState>,
    draft: Arc<Shared>,
    lobby: Arc<Mutex<Option<Live>>>,
    mut live: Live,
    rx: UnboundedReceiver<Out>,
    ws: Ws,
    first: Heard,
) -> LobbyState {
    let acts = react(&mut live.state, first);
    let ctx = Ctx {
        app,
        lobby: lobby.clone(),
        draft: draft.clone(),
        state,
        generation: live.generation,
        role: live.state.role,
    };
    let old = lock(&lobby).replace(live);
    if let Some(old) = old {
        leave_live(&draft, old);
    }
    for act in acts {
        if let Some(Ended::Final(reason)) = ctx.act(act).await {
            ctx.close(reason);
        }
    }
    let answer = ctx.with(|live| live.state.clone());
    ctx.emit_state();
    tauri::async_runtime::spawn(run(ctx, ws, rx));
    answer.unwrap_or_else(unreachable_state)
}

/// A state for a lobby replaced before its command could answer: closed, with no reason.
fn unreachable_state() -> LobbyState {
    LobbyState {
        role: LobbyRole::Guest,
        kind: None,
        code: String::new(),
        phase: LobbyPhase::Closed,
        name: String::new(),
        host_name: String::new(),
        host_online: false,
        peers: Vec::new(),
        label: String::new(),
        closed_reason: None,
        trade: None,
    }
}

/// Leave a lobby taken out of the slot: a host closes it for everyone and ends its pod draft;
/// a guest closes its socket.
fn leave_live(draft: &Shared, live: Live) {
    if live.state.role == LobbyRole::Host {
        live.send(close_frame());
        if let Some(pod) = live.draft {
            super::end_pod(draft, pod);
        }
    }
    let _ = live.out.send(Out::Close);
}

fn new_live(
    state: LobbyState,
    base: String,
    key: Option<String>,
) -> (Live, UnboundedReceiver<Out>) {
    let (out, rx) = unbounded_channel();
    let live = Live {
        generation: GENERATION.fetch_add(1, Ordering::Relaxed) + 1,
        state,
        out,
        base,
        key,
        rejoin: None,
        draft: None,
        game: None,
        decks: HashMap::new(),
        resume: None,
    };
    (live, rx)
}

/// The relay's answer to `POST /lobby`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Made {
    code: String,
    host_key: String,
}

fn client() -> &'static grimoire_core::platform::http::Client {
    static CLIENT: OnceLock<grimoire_core::platform::http::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        grimoire_core::platform::http::Client::new(&grimoire_core::platform::http::Config {
            user_agent: grimoire_core::scryfall::USER_AGENT,
            connect_timeout: Some(Duration::from_secs(10)),
            read_timeout: Some(Duration::from_secs(20)),
        })
    })
}

/// `POST /lobby` with the relay's token: a code and the host's key.
async fn make(base: &str, token: &str) -> Result<Made, String> {
    let response = client()
        .post(&format!("{base}/lobby"))
        .header("authorization", &format!("Bearer {token}"))
        .send()
        .await
        .map_err(|_| UNREACHABLE.to_owned())?;
    match response.status() {
        201 | 200 => {}
        401 | 403 => return Err(NOT_ACCEPTED.to_owned()),
        429 => return Err(SLOW_DOWN.to_owned()),
        _ => return Err(UNREACHABLE.to_owned()),
    }
    let text = response.text().await.map_err(|_| UNREACHABLE.to_owned())?;
    let made: Made = serde_json::from_str(&text).map_err(|_| UNREACHABLE.to_owned())?;
    let key_ok = made.host_key.len() == 32 && made.host_key.bytes().all(|b| b.is_ascii_hexdigit());
    if lobby_code(&made.code).is_err() || !key_ok {
        return Err(UNREACHABLE.to_owned());
    }
    Ok(made)
}

/// The relay's address and whether this device may host, off the read connection.
async fn relay(state: &Arc<AppState>) -> Result<(String, bool), String> {
    let app = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&app);
        (
            grimoire_core::sync_engine::entitlement::base(&conn),
            grimoire_core::sync_engine::commands::entitled(&conn),
        )
    })
    .await
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// Open a lobby for `kind` — a pod draft, a Playtesting game, or a trade — and host it, as
/// `name`: a supporter's. A trade's names the reader's own copy of the trade (`trade`), whose
/// `mine` side is what they offer. Answers once the relay has the host's socket.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn lobby_create(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    slot: tauri::State<'_, super::DraftSlot>,
    lobby: tauri::State<'_, LobbySlot>,
    name: String,
    kind: LobbyKind,
    trade: Option<i64>,
) -> Result<LobbyState, String> {
    let name = lobby_name(&name)?;
    let trade = match (kind, trade) {
        (LobbyKind::Trade, None) => return Err(NO_TRADE_HELD.to_owned()),
        (LobbyKind::Trade, Some(id)) => Some(LobbyTrade {
            trade_id: Some(id),
            ..LobbyTrade::default()
        }),
        _ => None,
    };
    let (base, allowed) = relay(state.inner()).await?;
    if !allowed {
        return Err(NOT_ON.to_owned());
    }
    let token = {
        let lane = state.lane_for_press().await?;
        match grimoire_core::sync_engine::entitlement::access_token(&lane).await {
            Ok(Some(token)) => token,
            Ok(None) => return Err(NOT_ON.to_owned()),
            Err(_) => return Err(UNCONFIRMED.to_owned()),
        }
    };
    let made = make(&base, &token).await?;
    let code = lobby_code(&made.code)?;
    let url = socket_url(
        &base,
        &code,
        &Join::Host {
            key: made.host_key.clone(),
        },
    );
    let (ws, first) = open_first(&url, LobbyRole::Host).await?;
    let (live, rx) = new_live(
        LobbyState {
            role: LobbyRole::Host,
            kind: Some(kind),
            code,
            phase: LobbyPhase::Open,
            name: name.clone(),
            host_name: name,
            host_online: true,
            peers: Vec::new(),
            label: String::new(),
            closed_reason: None,
            trade,
        },
        base,
        Some(made.host_key),
    );
    Ok(install(
        app,
        state.inner().clone(),
        slot.0.clone(),
        lobby.0.clone(),
        live,
        rx,
        ws,
        first,
    )
    .await)
}

/// Join the lobby `code` as `name`. A page that joins for a trade names the reader's own copy of
/// it (`trade`), which the host's lobby, once it says it is a trade's, fills. Answers once the
/// relay has welcomed this app.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn lobby_join(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    slot: tauri::State<'_, super::DraftSlot>,
    lobby: tauri::State<'_, LobbySlot>,
    code: String,
    name: String,
    trade: Option<i64>,
) -> Result<LobbyState, String> {
    let code = lobby_code(&code)?;
    let name = lobby_name(&name)?;
    let (base, _) = relay(state.inner()).await?;
    let url = socket_url(
        &base,
        &code,
        &Join::Guest {
            name: name.clone(),
            rejoin: None,
        },
    );
    let (ws, first) = open_first(&url, LobbyRole::Guest).await?;
    let (live, rx) = new_live(
        LobbyState {
            role: LobbyRole::Guest,
            kind: None,
            code,
            phase: LobbyPhase::Open,
            name,
            host_name: String::new(),
            host_online: false,
            peers: Vec::new(),
            label: String::new(),
            closed_reason: None,
            trade: trade.map(|id| LobbyTrade {
                trade_id: Some(id),
                ..LobbyTrade::default()
            }),
        },
        base,
        None,
    );
    Ok(install(
        app,
        state.inner().clone(),
        slot.0.clone(),
        lobby.0.clone(),
        live,
        rx,
        ws,
        first,
    )
    .await)
}

/// This app's lobby, if any — a closed one with its reason until it is left.
#[tauri::command]
pub fn lobby_state(lobby: tauri::State<'_, LobbySlot>) -> Option<LobbyState> {
    lock(&lobby.0).as_ref().map(|live| live.state.clone())
}

/// Leave the lobby: a host closes it for everyone and ends its pod draft.
#[tauri::command]
pub fn lobby_leave(
    app: tauri::AppHandle,
    slot: tauri::State<'_, super::DraftSlot>,
    lobby: tauri::State<'_, LobbySlot>,
) -> Result<(), String> {
    let Some(live) = lock(&lobby.0).take() else {
        return Ok(());
    };
    let mut gone = live.state.clone();
    leave_live(&slot.0, live);
    gone.phase = LobbyPhase::Closed;
    gone.closed_reason = None;
    let _ = app.emit("lobby:state", gone);
    Ok(())
}

/// The host deals the pod's draft as `draft`: `setup.seats[*].peer` names each guest's seat, and
/// every empty seat is a bot. The lobby is locked, every guest sent its view, and seat 0's
/// answered.
#[tauri::command]
pub async fn lobby_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    slot: tauri::State<'_, super::DraftSlot>,
    lobby: tauri::State<'_, LobbySlot>,
    setup: DraftSetup,
    draft: u64,
) -> Result<DraftView, String> {
    let (generation, peers) = {
        let held = lock(&lobby.0);
        let live = held.as_ref().ok_or(NO_LOBBY)?;
        if live.state.role != LobbyRole::Host {
            return Err(HOST_ONLY.to_owned());
        }
        if live.state.phase != LobbyPhase::Open {
            return Err(NOT_OPEN_NOW.to_owned());
        }
        if live.state.kind != Some(LobbyKind::Draft) {
            return Err(NOT_A_DRAFT_LOBBY.to_owned());
        }
        (live.generation, live.state.peers.clone())
    };
    if setup.mode != DraftMode::Pod {
        return Err(NOT_A_POD.to_owned());
    }
    let unknown = setup
        .seats
        .iter()
        .filter(|seat| !seat.bot)
        .filter_map(|seat| seat.peer.as_deref())
        .any(|peer| !peers.iter().any(|p| p.peer == peer));
    if unknown {
        return Err(NOT_IN_LOBBY.to_owned());
    }
    let label = setup.label.clone();
    let outcome = super::deal(state.inner(), &slot.0, setup, draft).await?;
    let ctx = Ctx {
        app,
        lobby: lobby.0.clone(),
        draft: slot.0.clone(),
        state: state.inner().clone(),
        generation,
        role: LobbyRole::Host,
    };
    let started = ctx.with(|live| {
        live.draft = Some(draft);
        live.state.phase = LobbyPhase::Drafting;
        live.state.label = label;
        live.send(lock_frame());
        live.send(send_frame("*", &room_body(&room_of(&live.state))));
    });
    if started.is_none() {
        super::end_pod(&slot.0, draft);
        return Err(NO_LOBBY.to_owned());
    }
    // Seat 0's view is the answer, not an event: only the guests are sent theirs.
    ctx.pass_on(&Outcome {
        before: Some(outcome.view.clone()),
        ..outcome.clone()
    });
    ctx.emit_state();
    Ok(outcome.view)
}

/// A guest's pick of `card_instance_ids`, sent to the host; the view arrives as `draft:view`.
#[tauri::command]
pub fn lobby_pick(
    lobby: tauri::State<'_, LobbySlot>,
    card_instance_ids: Vec<String>,
) -> Result<(), String> {
    let held = lock(&lobby.0);
    let live = held.as_ref().ok_or(NO_LOBBY)?;
    if live.state.role != LobbyRole::Guest {
        return Err(GUEST_ONLY.to_owned());
    }
    if live.state.phase == LobbyPhase::Closed {
        return Err(NO_LOBBY.to_owned());
    }
    live.send(guest_frame(&pick_body(&card_instance_ids)));
    Ok(())
}

/// A guest's Winston turn — take (`take`) the pile `pile` or decline it — sent to the host; the
/// view arrives as `draft:view`.
#[tauri::command]
pub fn lobby_winston(
    lobby: tauri::State<'_, LobbySlot>,
    pile: u8,
    take: bool,
) -> Result<(), String> {
    let held = lock(&lobby.0);
    let live = held.as_ref().ok_or(NO_LOBBY)?;
    if live.state.role != LobbyRole::Guest {
        return Err(GUEST_ONLY_WINSTON.to_owned());
    }
    if live.state.phase == LobbyPhase::Closed {
        return Err(NO_LOBBY.to_owned());
    }
    live.send(guest_frame(&winston_body(pile, take)));
    Ok(())
}

/// The host removes `peer` from the lobby. Once the draft has started, a bot takes the seat; once
/// a game has, the AI does, and the game plays on.
#[tauri::command]
pub async fn lobby_kick(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    slot: tauri::State<'_, super::DraftSlot>,
    lobby: tauri::State<'_, LobbySlot>,
    peer: String,
) -> Result<(), String> {
    let generation = {
        let held = lock(&lobby.0);
        let live = held.as_ref().ok_or(NO_LOBBY)?;
        if live.state.role != LobbyRole::Host {
            return Err(HOST_ONLY.to_owned());
        }
        live.send(kick_frame(&peer));
        live.generation
    };
    let ctx = Ctx {
        app,
        lobby: lobby.0.clone(),
        draft: slot.0.clone(),
        state: state.inner().clone(),
        generation,
        role: LobbyRole::Host,
    };
    if ctx.pod().is_some() {
        let peer = peer.clone();
        ctx.change_pod(move |d| match seat_of(d, &peer) {
            Some(seat) => d.replace_with_bot(seat),
            None => Ok(()),
        })
        .await?;
    }
    ctx.with(|live| live.decks.remove(&peer));
    ctx.hand_over(&peer).await
}

// ---------------------------------------------------------------------------------------
// A game's lobby (issue #1419)
// ---------------------------------------------------------------------------------------

/// A guest of a game's lobby sends the host the deck it brings: `deck_id` as it stands in
/// `variant`, read here and sent as printings and counts, which the host's app reads in its own
/// card data. Answers the deck's name; the room comes back with it beside this guest's.
#[tauri::command]
pub async fn lobby_deck(
    state: tauri::State<'_, Arc<AppState>>,
    lobby: tauri::State<'_, LobbySlot>,
    deck_id: i64,
    variant: String,
) -> Result<String, String> {
    {
        let held = lock(&lobby.0);
        let live = held.as_ref().ok_or(NO_LOBBY)?;
        if live.state.role != LobbyRole::Guest {
            return Err(GUEST_ONLY_DECK.to_owned());
        }
        if live.state.kind == Some(LobbyKind::Draft) {
            return Err(NOT_A_GAME_LOBBY.to_owned());
        }
        if live.state.phase != LobbyPhase::Open {
            return Err(NOT_OPEN_NOW.to_owned());
        }
    }
    let deck = crate::playtest::lobby::guest_deck(state.inner().clone(), deck_id, variant).await?;
    let held = lock(&lobby.0);
    let live = held.as_ref().ok_or(NO_LOBBY)?;
    live.send(guest_frame(&deck_body(&deck)));
    Ok(deck.name)
}

/// A guest's action in the host's game, sent to the host; the step arrives as `lobby:game`, a
/// refusal as `lobby:refused`.
#[tauri::command]
pub fn lobby_act(lobby: tauri::State<'_, LobbySlot>, action: PlaytestAction) -> Result<(), String> {
    let held = lock(&lobby.0);
    let live = held.as_ref().ok_or(NO_LOBBY)?;
    if live.state.role != LobbyRole::Guest {
        return Err(GUEST_ONLY_ACT.to_owned());
    }
    if live.state.phase == LobbyPhase::Closed {
        return Err(NO_LOBBY.to_owned());
    }
    live.send(guest_frame(&act_body(&action)));
    Ok(())
}

/// The host deals the lobby's game as `game`: its own `deck_id` in `variant` against `seats`, the
/// opponents in turn order — one for a duel, three for a four-player game — each a guest who has
/// sent its deck (`peer`) or an AI deck of the host's. The lobby is locked, every guest sent its
/// seat's first step, and the host's answered, as `playtest_start` answers it; the host plays on
/// with `playtest_act` and ends with `playtest_end`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn lobby_game_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    slot: tauri::State<'_, super::DraftSlot>,
    lobby: tauri::State<'_, LobbySlot>,
    game: u64,
    deck_id: i64,
    variant: String,
    seats: Vec<crate::playtest::lobby::LobbyGameSeat>,
    difficulty: grimoire_play::Difficulty,
    seed: u64,
) -> Result<PlaytestStep, String> {
    let (generation, host_name, peers, decks) = {
        let held = lock(&lobby.0);
        let live = held.as_ref().ok_or(NO_LOBBY)?;
        if live.state.role != LobbyRole::Host {
            return Err(HOST_ONLY.to_owned());
        }
        if live.state.kind != Some(LobbyKind::Game) {
            return Err(NOT_A_GAME_LOBBY.to_owned());
        }
        if live.state.phase != LobbyPhase::Open {
            return Err(NOT_OPEN_NOW.to_owned());
        }
        (
            live.generation,
            live.state.host_name.clone(),
            live.state.peers.clone(),
            live.decks.clone(),
        )
    };
    let table = crate::playtest::lobby::table(&host_name, &seats, &peers, &decks)?;
    let label = table.label();
    let (host, guests, seated) = crate::playtest::lobby::deal(
        &app,
        state.inner().clone(),
        game,
        deck_id,
        variant,
        table,
        difficulty,
        seed,
    )
    .await?;
    let ctx = Ctx {
        app,
        lobby: lobby.0.clone(),
        draft: slot.0.clone(),
        state: state.inner().clone(),
        generation,
        role: LobbyRole::Host,
    };
    let started = ctx.with(|live| {
        live.game = Some(seated.clone());
        live.state.phase = LobbyPhase::Playing;
        live.state.label = label;
        live.send(lock_frame());
        live.send(send_frame("*", &room_body(&room_of(&live.state))));
        for (peer, body) in game_frames(&seated, &guests, true) {
            live.send(send_frame(&peer, &body));
        }
    });
    if started.is_none() {
        crate::playtest::lobby::end(&ctx.app, game);
        return Err(NO_LOBBY.to_owned());
    }
    ctx.emit_state();
    Ok(host)
}

// ---------------------------------------------------------------------------------------
// A trade's lobby
// ---------------------------------------------------------------------------------------

/// The trade this app holds in its lobby, checked for a change to the deal: the generation, the
/// role, and the reader's copy of the trade. A deal that is agreed is final ([`AGREED`]).
fn trade_lobby(lobby: &LobbySlot) -> Result<(u64, LobbyRole, i64), String> {
    let held = lock(&lobby.0);
    let live = held.as_ref().ok_or(NO_LOBBY)?;
    if live.state.kind.is_some_and(|k| k != LobbyKind::Trade) {
        return Err(NOT_A_TRADE_LOBBY.to_owned());
    }
    let id = live
        .state
        .trade
        .as_ref()
        .and_then(|t| t.trade_id)
        .ok_or(NOT_A_TRADE_LOBBY)?;
    match live.state.phase {
        LobbyPhase::Closed => Err(NO_LOBBY.to_owned()),
        LobbyPhase::Agreed => Err(AGREED.to_owned()),
        _ => Ok((live.generation, live.state.role, id)),
    }
}

/// Send what this reader offers: the `mine` side of their copy of the trade, as it stands, read
/// here. A host's moves the deal at once and tells the other reader; a guest's goes to the host,
/// and the deal comes back as `lobby:state`. **Sent again unchanged, it changes nothing** — the
/// page sends it whenever its side may have moved.
#[tauri::command]
pub async fn lobby_trade_offer(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    slot: tauri::State<'_, super::DraftSlot>,
    lobby: tauri::State<'_, LobbySlot>,
) -> Result<(), String> {
    let (generation, role, id) = trade_lobby(&lobby)?;
    let read = state.inner().clone();
    let lines = tauri::async_runtime::spawn_blocking(move || {
        grimoire_core::trade::side_offer(
            &crate::sync::lock_db_read(&read),
            id,
            grimoire_core::trade::MINE,
        )
    })
    .await
    .map_err(|e| format!("the trade could not be read: {e}"))??;
    let lines = tidy(lines);
    if role == LobbyRole::Guest {
        let held = lock(&lobby.0);
        let live = held
            .as_ref()
            .filter(|l| l.generation == generation)
            .ok_or(NO_LOBBY)?;
        live.send(guest_frame(&offer_body(&lines)));
        return Ok(());
    }
    let ctx = Ctx {
        app,
        lobby: lobby.0.clone(),
        draft: slot.0.clone(),
        state: state.inner().clone(),
        generation,
        role,
    };
    let moved = ctx
        .with(|live| {
            live.state
                .trade
                .as_mut()
                .is_some_and(|t| t.deal.offer(true, lines))
        })
        .ok_or(NO_LOBBY)?;
    if moved {
        ctx.broadcast_deal();
        ctx.emit_state();
    }
    Ok(())
}

/// This reader accepts revision `rev` of the deal — the one the page is showing — or, with
/// `accept` false, takes that back. A host's counts at once; a guest's goes to the host, and the
/// deal comes back as `lobby:state`. **A revision that is no longer the deal's accepts nothing**
/// ([`DEAL_MOVED`]): the other reader changed their offer before the press. Once both readers
/// have accepted the same revision the lobby is `agreed`, and each finishes their own copy.
#[tauri::command]
pub async fn lobby_trade_accept(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    slot: tauri::State<'_, super::DraftSlot>,
    lobby: tauri::State<'_, LobbySlot>,
    rev: u64,
    accept: bool,
) -> Result<(), String> {
    let (generation, role, _) = trade_lobby(&lobby)?;
    let ctx = Ctx {
        app,
        lobby: lobby.0.clone(),
        draft: slot.0.clone(),
        state: state.inner().clone(),
        generation,
        role,
    };
    if role == LobbyRole::Guest {
        let current = ctx
            .with(|live| {
                let rev_now = live.state.trade.as_ref().map(|t| t.deal.rev);
                if rev_now == Some(rev) {
                    live.send(guest_frame(&accept_body(rev, accept)));
                }
                rev_now
            })
            .ok_or(NO_LOBBY)?;
        return if current == Some(rev) {
            Ok(())
        } else {
            Err(DEAL_MOVED.to_owned())
        };
    }
    let answer = ctx
        .with(|live| {
            let trade = live.state.trade.as_mut().ok_or(NOT_A_TRADE_LOBBY)?;
            if trade.deal.rev != rev {
                return Err(DEAL_MOVED);
            }
            let counted = trade.deal.accept(true, rev, accept);
            if trade.deal.agreed() {
                live.state.phase = LobbyPhase::Agreed;
            }
            Ok(counted)
        })
        .ok_or(NO_LOBBY)?
        .map_err(str::to_owned)?;
    if answer {
        ctx.broadcast_deal();
        ctx.with(|live| live.send(send_frame("*", &room_body(&room_of(&live.state)))));
        ctx.emit_state();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use grimoire_play::DraftStatus;

    fn state(role: LobbyRole, phase: LobbyPhase) -> LobbyState {
        LobbyState {
            role,
            kind: Some(LobbyKind::Draft),
            code: "K7QX2M".into(),
            phase,
            name: "Ada".into(),
            host_name: if role == LobbyRole::Host {
                "Ada".into()
            } else {
                String::new()
            },
            host_online: role == LobbyRole::Host,
            peers: Vec::new(),
            label: String::new(),
            closed_reason: None,
            trade: None,
        }
    }

    fn peer(id: &str, name: &str, online: bool) -> LobbyPeer {
        LobbyPeer {
            peer: id.into(),
            name: name.into(),
            online,
            deck: None,
        }
    }

    fn view() -> DraftView {
        DraftView {
            mode: DraftMode::Pod,
            status: DraftStatus::Drafting,
            label: "Bloomburrow".into(),
            seat: 1,
            pack_number: 0,
            pack_count: 3,
            pick_number: 0,
            pack_size: 14,
            pass_left: true,
            pack: Vec::new(),
            waiting: false,
            pool: Vec::new(),
            seats: Vec::new(),
            pack_sets: vec!["blb".into()],
            min_deck_size: 40,
            pod_format: grimoire_play::PodFormat::Booster,
            picks_per_step: 1,
            commanders: 0,
            stack: None,
        }
    }

    #[test]
    fn a_code_is_six_of_the_relays_alphabet_upper_cased() {
        assert_eq!(lobby_code(" k7qx2m ").unwrap(), "K7QX2M");
        for bad in [
            "", "K7QX2", "K7QX2MM", "K7QX0M", "K7QXIM", "K7QX1M", "K7-X2M", "K7QX2Ö",
        ] {
            assert_eq!(lobby_code(bad).unwrap_err(), NOT_A_CODE, "{bad:?}");
        }
    }

    #[test]
    fn a_name_is_one_to_twenty_four_characters_with_no_control_character() {
        assert_eq!(lobby_name("  Ada ").unwrap(), "Ada");
        assert_eq!(lobby_name(&"é".repeat(24)).unwrap(), "é".repeat(24));
        for bad in ["", "   ", "a\u{7}b", &"x".repeat(25)] {
            assert_eq!(lobby_name(bad).unwrap_err(), NOT_A_NAME, "{bad:?}");
        }
    }

    #[test]
    fn a_socket_is_addressed_by_role_with_its_query_escaped() {
        let host = socket_url(
            "https://relay.example",
            "K7QX2M",
            &Join::Host {
                key: "0123456789abcdef0123456789abcdef".into(),
            },
        );
        assert_eq!(
            host,
            "wss://relay.example/lobby/K7QX2M/ws?role=host&key=0123456789abcdef0123456789abcdef"
        );
        let guest = socket_url(
            "http://127.0.0.1:8787",
            "K7QX2M",
            &Join::Guest {
                name: "Ada & Bø".into(),
                rejoin: None,
            },
        );
        assert_eq!(
            guest,
            "ws://127.0.0.1:8787/lobby/K7QX2M/ws?role=guest&name=Ada%20%26%20B%C3%B8"
        );
        let rejoin = socket_url(
            "https://relay.example",
            "K7QX2M",
            &Join::Guest {
                name: "Ada".into(),
                rejoin: Some(("p2".into(), "ff".repeat(16))),
            },
        );
        assert!(rejoin.ends_with(&format!("name=Ada&rejoin=p2.{}", "ff".repeat(16))));
    }

    #[test]
    fn frames_are_written_as_the_relay_reads_them() {
        let v = |s: String| serde_json::from_str::<Value>(&s).unwrap();
        assert_eq!(v(lock_frame()), json!({"t": "lock"}));
        assert_eq!(v(close_frame()), json!({"t": "close"}));
        assert_eq!(v(kick_frame("p3")), json!({"t": "kick", "peer": "p3"}));
        assert_eq!(
            v(send_frame("*", &end_body("over"))),
            json!({"t": "send", "to": "*", "body": {"v": 1, "kind": "end", "reason": "over"}})
        );
        assert_eq!(
            v(guest_frame(&pick_body(&["a#1.0.0".into()]))),
            json!({"t": "msg", "body": {"v": 1, "kind": "pick", "ids": ["a#1.0.0"]}})
        );
        assert_eq!(
            v(guest_frame(&winston_body(2, false))),
            json!({"t": "msg", "body": {"v": 1, "kind": "winston", "pile": 2, "take": false}})
        );
        assert_eq!(
            v(guest_frame(&sync_body())),
            json!({"t": "msg", "body": {"v": 1, "kind": "sync"}})
        );
        let room = LobbyRoom {
            kind: LobbyKind::Draft,
            host_name: "Ada".into(),
            label: "".into(),
            peers: vec![peer("p1", "Bo", true)],
            started: false,
        };
        assert_eq!(
            room_body(&room),
            json!({"v": 1, "kind": "room", "room": {
                "kind": "draft", "hostName": "Ada", "label": "", "started": false,
                "peers": [{"peer": "p1", "name": "Bo", "online": true, "deck": null}]}})
        );
        assert_eq!(
            v(guest_frame(&act_body(&PlaytestAction::Pass))),
            json!({"t": "msg", "body": {"v": 1, "kind": "act", "action": {"type": "pass"}}})
        );
        assert_eq!(
            v(send_frame("p1", &refused_body("no"))),
            json!({"t": "send", "to": "p1", "body": {"v": 1, "kind": "refused", "reason": "no"}})
        );
        assert_eq!(
            v(send_frame("p1", &game_body("H4sI"))),
            json!({"t": "send", "to": "p1", "body": {"v": 1, "kind": "game", "z": "H4sI"}})
        );
    }

    #[test]
    fn the_relays_frames_are_read_and_anything_else_is_ignored() {
        assert_eq!(
            decode(r#"{"t":"peers","peers":[{"peer":"p1","name":"Bo","online":false}]}"#),
            Heard::Peers(vec![peer("p1", "Bo", false)])
        );
        assert_eq!(
            decode(r#"{"t":"welcome","peer":"p2","secret":"ab","hostOnline":true}"#),
            Heard::Welcome {
                peer: "p2".into(),
                secret: "ab".into(),
                host_online: true
            }
        );
        assert_eq!(decode(r#"{"t":"host","online":false}"#), Heard::Host(false));
        assert_eq!(
            decode(r#"{"t":"msg","from":"p1","body":{"v":1,"kind":"pick","ids":["x"]}}"#),
            Heard::Msg {
                from: Some("p1".into()),
                body: Body::Pick(vec!["x".into()])
            }
        );
        assert_eq!(
            decode(
                r#"{"t":"msg","from":"p1","body":{"v":1,"kind":"winston","pile":1,"take":true}}"#
            ),
            Heard::Msg {
                from: Some("p1".into()),
                body: Body::Winston {
                    pile: 1,
                    take: true
                }
            }
        );
        for bad in [
            r#"{"t":"msg","body":{"v":1,"kind":"winston","pile":300,"take":true}}"#,
            r#"{"t":"msg","body":{"v":1,"kind":"winston","pile":-1,"take":true}}"#,
            r#"{"t":"msg","body":{"v":1,"kind":"winston","pile":0}}"#,
        ] {
            assert_eq!(
                decode(bad),
                Heard::Msg {
                    from: None,
                    body: Body::Other
                },
                "{bad}"
            );
        }
        let sent = send_frame("p1", &view_body(&view()));
        let body: Value = serde_json::from_str::<Value>(&sent).unwrap()["body"].clone();
        let heard = decode(&json!({"t": "msg", "body": body}).to_string());
        assert_eq!(
            heard,
            Heard::Msg {
                from: None,
                body: Body::View(Box::new(view()))
            }
        );
        for other in [
            "not json",
            "[]",
            r#"{"t":"nope"}"#,
            r#"{"t":"host"}"#,
            r#"{"t":"peers","peers":7}"#,
        ] {
            assert_eq!(decode(other), Heard::Other, "{other}");
        }
        assert_eq!(
            decode(r#"{"t":"msg","body":{"v":2,"kind":"sync"}}"#),
            Heard::Msg {
                from: None,
                body: Body::Other
            }
        );
    }

    #[test]
    fn a_host_tells_the_room_of_every_roster_change_and_seats_it_once_drafting() {
        let mut open = state(LobbyRole::Host, LobbyPhase::Open);
        let peers = vec![peer("p1", "Bo", true)];
        assert_eq!(
            react(&mut open, Heard::Peers(peers.clone())),
            vec![Act::BroadcastRoom]
        );
        assert_eq!(open.peers, peers);

        let mut drafting = state(LobbyRole::Host, LobbyPhase::Drafting);
        assert_eq!(
            react(&mut drafting, Heard::Peers(peers.clone())),
            vec![Act::BroadcastRoom, Act::SeatsOnline(peers)]
        );
        assert!(room_of(&drafting).started);
    }

    #[test]
    fn a_host_applies_a_guests_pick_only_while_drafting_and_answers_a_sync() {
        let pick = || Heard::Msg {
            from: Some("p1".into()),
            body: Body::Pick(vec!["x".into()]),
        };
        let mut open = state(LobbyRole::Host, LobbyPhase::Open);
        assert!(react(&mut open, pick()).is_empty());
        let mut drafting = state(LobbyRole::Host, LobbyPhase::Drafting);
        assert_eq!(
            react(&mut drafting, pick()),
            vec![Act::Pick {
                from: "p1".into(),
                ids: vec!["x".into()]
            }]
        );
        let winston = || Heard::Msg {
            from: Some("p1".into()),
            body: Body::Winston {
                pile: 0,
                take: false,
            },
        };
        assert!(react(&mut open, winston()).is_empty());
        assert_eq!(
            react(&mut drafting, winston()),
            vec![Act::Winston {
                from: "p1".into(),
                pile: 0,
                take: false
            }]
        );
        let mut guest = state(LobbyRole::Guest, LobbyPhase::Drafting);
        assert!(
            react(&mut guest, winston()).is_empty(),
            "a guest never decides another's turn"
        );
        let sync = Heard::Msg {
            from: Some("p1".into()),
            body: Body::Sync,
        };
        assert_eq!(react(&mut open, sync), vec![Act::Resend("p1".into())]);
        // A host never acts on what only a guest is sent.
        assert!(react(&mut open, Heard::Host(false)).is_empty());
        assert!(open.host_online);
    }

    #[test]
    fn a_guest_is_welcomed_shown_the_room_then_its_views_and_told_when_it_ends() {
        let mut guest = state(LobbyRole::Guest, LobbyPhase::Open);
        assert_eq!(
            react(
                &mut guest,
                Heard::Welcome {
                    peer: "p2".into(),
                    secret: "s".into(),
                    host_online: true
                }
            ),
            vec![
                Act::Remember {
                    peer: "p2".into(),
                    secret: "s".into()
                },
                Act::AskSync
            ]
        );
        assert!(guest.host_online);

        let room = LobbyRoom {
            kind: LobbyKind::Draft,
            host_name: "Cy".into(),
            label: "Bloomburrow".into(),
            peers: vec![peer("p2", "Ada", true)],
            started: false,
        };
        let msg = |body| Heard::Msg { from: None, body };
        assert!(react(&mut guest, msg(Body::Room(room.clone()))).is_empty());
        assert_eq!(
            (guest.host_name.as_str(), guest.label.as_str()),
            ("Cy", "Bloomburrow")
        );
        assert_eq!(guest.phase, LobbyPhase::Open);
        react(
            &mut guest,
            msg(Body::Room(LobbyRoom {
                started: true,
                ..room
            })),
        );
        assert_eq!(guest.phase, LobbyPhase::Drafting);

        assert_eq!(
            react(&mut guest, msg(Body::View(Box::new(view())))),
            vec![Act::ShowView(Box::new(view()))]
        );
        assert!(react(&mut guest, Heard::Host(false)).is_empty());
        assert!(!guest.host_online);
        assert_eq!(
            react(&mut guest, msg(Body::End("done".into()))),
            vec![Act::End("done".into())]
        );
        // A guest never answers what only a host is sent.
        assert!(react(&mut guest, Heard::Peers(Vec::new())).is_empty());
    }

    fn game_deck(name: &str) -> GuestDeck {
        GuestDeck {
            name: name.into(),
            cards: Vec::new(),
            tokens: Vec::new(),
        }
    }

    /// Issue #1419: a game's lobby keeps each guest's deck beside its seat in the room, and plays
    /// its guests' actions once the game is on.
    #[test]
    fn a_game_lobby_hears_each_guests_deck_and_then_its_actions() {
        let mut open = state(LobbyRole::Host, LobbyPhase::Open);
        open.kind = Some(LobbyKind::Game);
        react(&mut open, Heard::Peers(vec![peer("p1", "Bo", true)]));
        let deck = Heard::Msg {
            from: Some("p1".into()),
            body: Body::Deck(Box::new(game_deck("Elves"))),
        };
        assert_eq!(
            react(&mut open, deck.clone()),
            vec![
                Act::Deck {
                    from: "p1".into(),
                    deck: Box::new(game_deck("Elves"))
                },
                Act::BroadcastRoom
            ]
        );
        assert_eq!(open.peers[0].deck.as_deref(), Some("Elves"));
        // The relay's roster knows no deck, and a guest keeps the one it sent.
        react(
            &mut open,
            Heard::Peers(vec![peer("p1", "Bo", false), peer("p2", "Cy", true)]),
        );
        assert_eq!(open.peers[0].deck.as_deref(), Some("Elves"));
        assert_eq!(open.peers[1].deck, None);
        // A draft's lobby takes no deck.
        let mut draft = state(LobbyRole::Host, LobbyPhase::Open);
        react(&mut draft, Heard::Peers(vec![peer("p1", "Bo", true)]));
        assert!(react(&mut draft, deck).is_empty());

        let act = || Heard::Msg {
            from: Some("p1".into()),
            body: Body::Act(Box::new(PlaytestAction::Pass)),
        };
        assert!(react(&mut open, act()).is_empty(), "no game yet");
        let mut playing = state(LobbyRole::Host, LobbyPhase::Playing);
        playing.kind = Some(LobbyKind::Game);
        assert_eq!(
            react(&mut playing, act()),
            vec![Act::Play {
                from: "p1".into(),
                action: Box::new(PlaytestAction::Pass)
            }]
        );
        assert!(room_of(&playing).started);
        assert_eq!(room_of(&playing).kind, LobbyKind::Game);
    }

    #[test]
    fn a_game_lobbys_guest_learns_the_kind_from_the_room_and_is_shown_its_steps() {
        let mut guest = state(LobbyRole::Guest, LobbyPhase::Open);
        guest.kind = None;
        let msg = |body| Heard::Msg { from: None, body };
        react(
            &mut guest,
            msg(Body::Room(LobbyRoom {
                kind: LobbyKind::Game,
                host_name: "Cy".into(),
                label: String::new(),
                peers: Vec::new(),
                started: false,
            })),
        );
        assert_eq!(guest.kind, Some(LobbyKind::Game));
        assert_eq!(guest.phase, LobbyPhase::Open);
        assert_eq!(
            react(&mut guest, msg(Body::Game("H4sI".into()))),
            vec![Act::ShowGame("H4sI".into())]
        );
        assert_eq!(guest.phase, LobbyPhase::Playing);
        assert_eq!(
            react(&mut guest, msg(Body::Refused("no".into()))),
            vec![Act::Refused("no".into())]
        );
        // A room that has started puts a late guest straight into the game.
        let mut late = state(LobbyRole::Guest, LobbyPhase::Open);
        react(
            &mut late,
            msg(Body::Room(LobbyRoom {
                kind: LobbyKind::Game,
                host_name: "Cy".into(),
                label: "Duel".into(),
                peers: Vec::new(),
                started: true,
            })),
        );
        assert_eq!(late.phase, LobbyPhase::Playing);
    }

    fn offered(card_id: &str, quantity: i64) -> TradeOfferLine {
        TradeOfferLine {
            card_id: card_id.into(),
            finish: "nonfoil".into(),
            quantity,
        }
    }

    fn trading(role: LobbyRole) -> LobbyState {
        let mut s = state(role, LobbyPhase::Open);
        s.kind = Some(LobbyKind::Trade);
        s.trade = Some(LobbyTrade {
            trade_id: Some(5),
            ..LobbyTrade::default()
        });
        s
    }

    #[test]
    fn a_trades_host_shuts_the_room_behind_the_other_reader_and_removes_a_third() {
        let mut host = trading(LobbyRole::Host);
        assert_eq!(
            react(&mut host, Heard::Peers(Vec::new())),
            vec![Act::BroadcastRoom],
            "nobody yet: the room stays open"
        );
        assert_eq!(
            react(
                &mut host,
                Heard::Peers(vec![peer("p1", "Bo", true), peer("p2", "Cy", true)])
            ),
            vec![Act::BroadcastRoom, Act::Lock, Act::Kick("p2".into())]
        );
    }

    #[test]
    fn a_trades_host_takes_the_other_readers_offer_and_agrees_when_both_accept_one_deal() {
        let mut host = trading(LobbyRole::Host);
        host.peers = vec![peer("p1", "Bo", true), peer("p2", "Cy", true)];
        let from = |who: &str, body| Heard::Msg {
            from: Some(who.into()),
            body,
        };

        // Only the other reader offers.
        assert_eq!(
            react(&mut host, from("p2", Body::Offer(vec![offered("goyf", 1)]))),
            vec![]
        );
        assert_eq!(
            react(
                &mut host,
                from("p1", Body::Offer(vec![offered("bolt", 2), offered("", 1)]))
            ),
            vec![
                Act::WriteTheirs(vec![offered("bolt", 2)]),
                Act::BroadcastDeal
            ]
        );
        let deal = |s: &LobbyState| s.trade.as_ref().unwrap().deal.clone();
        assert_eq!(deal(&host).rev, 1);
        assert_eq!(deal(&host).guest, [offered("bolt", 2)]);
        // The same offer again moves nothing.
        assert_eq!(
            react(&mut host, from("p1", Body::Offer(vec![offered("bolt", 2)]))),
            vec![]
        );

        // An acceptance of an older deal is answered with the one on the table.
        assert_eq!(
            react(&mut host, from("p1", Body::Accept { rev: 0, yes: true })),
            vec![Act::BroadcastDeal]
        );
        assert!(!deal(&host).guest_accepted);
        assert_eq!(
            react(&mut host, from("p1", Body::Accept { rev: 1, yes: true })),
            vec![Act::BroadcastDeal]
        );
        assert_eq!(host.phase, LobbyPhase::Open, "the host has not accepted");

        host.trade.as_mut().unwrap().deal.host_accepted = true;
        host.trade.as_mut().unwrap().deal.guest_accepted = false;
        assert_eq!(
            react(&mut host, from("p1", Body::Accept { rev: 1, yes: true })),
            vec![Act::BroadcastDeal, Act::BroadcastRoom]
        );
        assert_eq!(host.phase, LobbyPhase::Agreed);
        assert!(room_of(&host).started);
        // Agreed is final: nothing more is taken.
        assert_eq!(
            react(&mut host, from("p1", Body::Offer(vec![offered("goyf", 1)]))),
            vec![]
        );
    }

    #[test]
    fn a_trades_guest_writes_the_hosts_offer_and_follows_the_deal_to_agreement() {
        let mut guest = trading(LobbyRole::Guest);
        guest.kind = None;
        let msg = |body| Heard::Msg { from: None, body };
        react(
            &mut guest,
            msg(Body::Room(LobbyRoom {
                kind: LobbyKind::Trade,
                host_name: "Ada".into(),
                label: String::new(),
                peers: Vec::new(),
                started: false,
            })),
        );
        assert_eq!(guest.kind, Some(LobbyKind::Trade));

        let mut deal = TradeDeal {
            rev: 1,
            host: vec![offered("bolt", 2)],
            ..TradeDeal::default()
        };
        assert_eq!(
            react(&mut guest, msg(Body::Deal(Box::new(deal.clone())))),
            vec![Act::WriteTheirs(vec![offered("bolt", 2)])]
        );
        // The guest's own offer echoed back moves nothing to write.
        deal.rev = 2;
        deal.guest = vec![offered("goyf", 1)];
        assert_eq!(
            react(&mut guest, msg(Body::Deal(Box::new(deal.clone())))),
            vec![]
        );
        assert_eq!(guest.trade.as_ref().unwrap().deal.rev, 2);

        deal.host_accepted = true;
        deal.guest_accepted = true;
        react(&mut guest, msg(Body::Deal(Box::new(deal))));
        assert_eq!(guest.phase, LobbyPhase::Agreed);

        // A guest that joined with no trade to hold takes no deal.
        let mut bare = state(LobbyRole::Guest, LobbyPhase::Open);
        assert_eq!(react(&mut bare, msg(Body::Deal(Box::default()))), vec![]);
    }

    #[test]
    fn a_trades_bodies_cross_as_written() {
        let read = |body: Value| match decode(&json!({"t": "msg", "body": body}).to_string()) {
            Heard::Msg { body, .. } => body,
            other => panic!("{other:?}"),
        };
        assert_eq!(
            read(offer_body(&[offered("bolt", 2)])),
            Body::Offer(vec![offered("bolt", 2)])
        );
        assert_eq!(
            read(accept_body(4, false)),
            Body::Accept { rev: 4, yes: false }
        );
        let deal = TradeDeal {
            rev: 3,
            host: vec![offered("bolt", 1)],
            guest: Vec::new(),
            host_accepted: true,
            guest_accepted: false,
        };
        assert_eq!(read(deal_body(&deal)), Body::Deal(Box::new(deal)));
        assert_eq!(
            read(json!({"v": 1, "kind": "accept", "rev": "x"})),
            Body::Other
        );
    }

    #[test]
    fn a_close_code_is_a_sentence_and_anything_else_is_a_drop() {
        use LobbyRole::{Guest, Host};
        assert_eq!(closed_reason(Guest, Some(4000)), Some(CLOSED_BY_HOST));
        assert_eq!(closed_reason(Host, Some(4000)), Some(LOBBY_ENDED));
        assert_eq!(closed_reason(Guest, Some(4001)), Some(KICKED));
        assert_eq!(closed_reason(Guest, Some(4003)), Some(STARTED));
        assert_eq!(closed_reason(Guest, Some(4004)), Some(FULL));
        assert_eq!(closed_reason(Host, Some(4005)), Some(REPLACED));
        assert_eq!(closed_reason(Host, Some(1009)), Some(TOO_BIG));
        assert_eq!(closed_reason(Guest, Some(1006)), None);
        assert_eq!(closed_reason(Guest, Some(1000)), None);
        assert_eq!(closed_reason(Guest, None), None);
    }

    #[test]
    fn an_upgrade_refused_for_good_is_a_sentence_and_the_rest_are_tried_again() {
        use LobbyRole::{Guest, Host};
        assert_eq!(refused(Guest, 404), Some(NOT_OPEN));
        assert_eq!(refused(Host, 403), Some(WRONG_KEY));
        assert_eq!(refused(Guest, 400), Some(NOT_A_NAME));
        assert_eq!(refused(Guest, 429), Some(SLOW_DOWN));
        assert_eq!(refused(Guest, 502), None);
        assert_eq!(refused(Host, 500), None);
    }

    #[test]
    fn a_dropped_socket_is_opened_again_with_a_growing_wait() {
        let waits: Vec<u64> = (0..MAX_RECONNECTS).map(|a| backoff(a).as_secs()).collect();
        assert_eq!(waits, [1, 2, 4, 8, 16, 16]);
    }

    #[test]
    fn the_state_crosses_as_the_page_reads_it() {
        let mut s = state(LobbyRole::Guest, LobbyPhase::Drafting);
        s.closed_reason = Some("x".into());
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"role": "guest", "kind": "draft", "code": "K7QX2M", "phase": "drafting", "name": "Ada",
                   "hostName": "", "hostOnline": false, "peers": [], "label": "",
                   "closedReason": "x", "trade": null})
        );
    }

    /// No sentence a reader is shown here names a membership, a supporter or a way to be one.
    #[test]
    fn no_sentence_names_a_membership() {
        for sentence in [
            NOT_ON,
            UNCONFIRMED,
            NOT_ACCEPTED,
            SLOW_DOWN,
            UNREACHABLE,
            NOT_A_CODE,
            NOT_A_NAME,
            NOT_OPEN,
            WRONG_KEY,
            CLOSED_BY_HOST,
            LOBBY_ENDED,
            KICKED,
            STARTED,
            FULL,
            REPLACED,
            TOO_BIG,
            LOST,
            NO_LOBBY,
            HOST_ONLY,
            GUEST_ONLY,
            NOT_OPEN_NOW,
            NOT_A_POD,
            NOT_IN_LOBBY,
            NOT_SEATED,
            NOT_A_DRAFT_LOBBY,
            NOT_A_GAME_LOBBY,
            GUEST_ONLY_DECK,
            GUEST_ONLY_ACT,
            NOT_A_TRADE_LOBBY,
            NO_TRADE_HELD,
            AGREED,
            DEAL_MOVED,
        ] {
            let lower = sentence.to_lowercase();
            for word in ["member", "supporter", "patreon", "patron", "subscri"] {
                assert!(!lower.contains(word), "{sentence}");
            }
        }
    }
}
