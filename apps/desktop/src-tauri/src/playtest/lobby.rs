//! **A lobby's game** (issue #1419): the Playtesting game with people in opponents' seats, over
//! the same lobby a pod draft uses (`crate::draft::lobby`, a lobby of [`LobbyKind::Game`]).
//!
//! **The host's app runs the game**, in the one playtest slot (`super::PlaytestSlot`), exactly as
//! it runs a game against the AI: `Playtest` seats each guest as an opponent a person plays
//! (`OpponentDeck::person`), stops for their decisions as it stops for the reader's, and answers
//! each guest's step from that guest's own seat (`Playtest::guest_steps`). The host's board plays
//! with `playtest_act` as ever; a guest's action arrives over the lobby, is applied here on the
//! engine's stack (waiting its turn behind an action of the host's), and its answer goes to the
//! host's board as `playtest:step` and to every guest as its own step.
//!
//! **A guest brings its own deck** (`lobby_deck`), sent as printings and counts and read by the
//! host in its own card data (`play::cards_by_ids`), the way a pod's boosters are: the host never
//! takes a guest's card text. A printing the host's card data lacks is a refusal to deal.
//!
//! **A guest's step is packed** (`pack`): gzipped, then base64, inside the relay's JSON frame —
//! a Commander board with the guest's library in it is well past the relay's 64 KiB cap as JSON,
//! and a tenth of it packed. A guest's step never carries replay frames.
//!
//! [`LobbyKind::Game`]: crate::draft::lobby::LobbyKind

use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use grimoire_core::play::{PlayCard, PlayToken};
use grimoire_play::playtest::session::MAX_OPPONENTS;
use grimoire_play::{
    on_engine_stack, Difficulty, OpponentDeck, Playtest, PlaytestAction, PlaytestStep,
};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use super::{facts, token_facts, PlaytestSlot, BUSY, NO_GAME};
use crate::draft::lobby::LobbyPeer;
use crate::sync::AppState;

// ---------------------------------------------------------------------------------------
// The wire (mirrored in `packages/ui/lib/ipc/playtest.ts`)
// ---------------------------------------------------------------------------------------

/// One opponent's seat of a lobby's game, as the host's page names it: a guest (`peer`), or an
/// AI deck of the host's (`deck_id` in `variant`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LobbyGameSeat {
    pub peer: Option<String>,
    pub deck_id: Option<i64>,
    pub variant: Option<String>,
}

/// What a guest is sent of the host's game: its step, from its own seat; the names of the
/// players across the table from it, in its view's `opponents` order (a person's lobby name, an
/// AI seat's deck); its own deck's name; and whether this is a deal's first step, which starts
/// its board's log afresh.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestGame {
    pub step: PlaytestStep,
    pub names: Vec<String>,
    pub deck: String,
    pub dealt: bool,
}

/// What the host's board is pushed when a guest's action, or a guest's seat handed to the AI,
/// moved its `game` (`playtest:step`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStep {
    pub game: u64,
    pub step: PlaytestStep,
}

/// One row of a guest's deck as it crosses: a printing, how many, and whether it is a commander.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestCard {
    pub card_id: String,
    pub quantity: u32,
    pub commander: bool,
}

/// The deck a guest brings to a game's lobby: its name, its rows and its tokens in the printings
/// the guest set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestDeck {
    pub name: String,
    pub cards: Vec<GuestCard>,
    pub tokens: Vec<PlayToken>,
}

// ---------------------------------------------------------------------------------------
// Who sits where
// ---------------------------------------------------------------------------------------

const NO_GUEST: &str = "A game in a lobby seats at least one guest.";
const TABLE_SIZE: &str = "A lobby's game is a duel or a four-player game: one opponent or three.";
const SEAT_IS_ONE: &str = "Each seat is a guest or a deck of yours, not both.";
const SEATED_TWICE: &str = "A guest sits at one seat only.";
const NOT_IN_LOBBY: &str = "A seat names someone who is not in the lobby.";
const TOO_BIG: &str = "That deck is too big to send.";
const EMPTY: &str = "That deck has no cards to play with yet.";
/// How long a guest's action waits behind one of the host's on the engine: an AI's turn, at
/// most, is a few seconds; this is the bound that stops a stuck engine holding a guest for ever.
const WAIT: Duration = Duration::from_secs(300);
const WAIT_STEP: Duration = Duration::from_millis(50);
/// The most rows and tokens a guest's deck may send, and copies of one row.
const MAX_ROWS: usize = 400;
const MAX_TOKENS: usize = 200;
const MAX_COPIES: u32 = 250;
/// What a packed step may come to before the guest's library is left out of it: under the
/// relay's 64 KiB frame, with room for the frame around it.
const PACKED_LIMIT: usize = 60 * 1024;

/// The host's game in a lobby: whose seat is whose, and what each is called.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameSeats {
    pub game: u64,
    /// Each guest still seated, by lobby peer, and its seat.
    pub peers: Vec<(String, u8)>,
    /// Each seat's name at the table, seat 0 the host's: a person's lobby name, an AI's deck.
    pub names: Vec<String>,
    /// Each seat's deck's name.
    pub decks: Vec<String>,
}

impl GameSeats {
    pub fn seat_of(&self, peer: &str) -> Option<u8> {
        self.peers.iter().find(|(p, _)| p == peer).map(|(_, s)| *s)
    }

    pub fn peer_of(&self, seat: u8) -> Option<&str> {
        self.peers
            .iter()
            .find(|(_, s)| *s == seat)
            .map(|(p, _)| p.as_str())
    }

    /// What `seat`'s guest is sent of `step`: the others' names from its own seat, in turn order
    /// after it.
    pub fn guest_game(&self, seat: u8, step: PlaytestStep, dealt: bool) -> GuestGame {
        let players = self.names.len().max(1);
        let names = (1..players)
            .map(|n| self.names[(seat as usize + n) % players].clone())
            .collect();
        GuestGame {
            step,
            names,
            deck: self.decks.get(seat as usize).cloned().unwrap_or_default(),
            dealt,
        }
    }
}

/// One opponent's seat, checked: a guest and the deck it sent, or an AI deck of the host's.
#[derive(Debug, Clone, PartialEq)]
pub enum Sitter {
    Guest {
        peer: String,
        name: String,
        deck: GuestDeck,
    },
    Ai {
        deck_id: i64,
        variant: String,
    },
}

/// The table a lobby's game is dealt to: the host's name, and the opponents in turn order.
#[derive(Debug, Clone, PartialEq)]
pub struct Table {
    pub host: String,
    pub seats: Vec<Sitter>,
}

impl Table {
    /// What the room calls the game.
    pub fn label(&self) -> String {
        if self.seats.len() == 1 {
            "Duel"
        } else {
            "Four-player"
        }
        .to_owned()
    }
}

/// The page's `seats` checked against the lobby: one opponent or three, each a guest in the room
/// who has sent a deck or an AI deck, no guest twice, at least one guest.
pub fn table(
    host: &str,
    seats: &[LobbyGameSeat],
    peers: &[LobbyPeer],
    decks: &std::collections::HashMap<String, GuestDeck>,
) -> Result<Table, String> {
    if seats.len() != 1 && seats.len() != MAX_OPPONENTS {
        return Err(TABLE_SIZE.into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(seats.len());
    for seat in seats {
        out.push(match (&seat.peer, seat.deck_id) {
            (Some(peer), None) => {
                if !seen.insert(peer.as_str()) {
                    return Err(SEATED_TWICE.into());
                }
                let guest = peers.iter().find(|p| &p.peer == peer).ok_or(NOT_IN_LOBBY)?;
                let deck = decks
                    .get(peer)
                    .cloned()
                    .ok_or_else(|| format!("{} has not picked a deck yet.", guest.name))?;
                Sitter::Guest {
                    peer: peer.clone(),
                    name: guest.name.clone(),
                    deck,
                }
            }
            (None, Some(deck_id)) => Sitter::Ai {
                deck_id,
                variant: seat.variant.clone().unwrap_or_else(|| "live".into()),
            },
            _ => return Err(SEAT_IS_ONE.into()),
        });
    }
    if !out.iter().any(|s| matches!(s, Sitter::Guest { .. })) {
        return Err(NO_GUEST.into());
    }
    Ok(Table {
        host: host.to_owned(),
        seats: out,
    })
}

/// A guest's deck, as it sent it, read in this app's card data: each row's printing with its
/// count and its commander flag. A printing this app does not know is a refusal naming the guest.
pub fn guest_cards(
    known: &[PlayCard],
    deck: &GuestDeck,
    guest: &str,
) -> Result<Vec<PlayCard>, String> {
    deck.cards
        .iter()
        .map(|row| {
            let card = known
                .iter()
                .find(|c| c.card_id == row.card_id)
                .ok_or_else(|| {
                    format!(
                        "{guest}'s deck has a card this app's card data does not have yet. \
                         Update the card data in Settings, then start again."
                    )
                })?;
            Ok(PlayCard {
                quantity: row.quantity,
                commander: row.commander,
                ..card.clone()
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------------------
// The steps a guest is sent, packed
// ---------------------------------------------------------------------------------------

fn gzip_base64(text: &str) -> String {
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let _ = gz.write_all(text.as_bytes());
    let bytes = gz.finish().unwrap_or_default();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// A guest's step as it crosses the relay: its JSON, gzipped, in base64. A step that would still
/// not fit the relay's frame is sent without the guest's own library, which the board draws only
/// for the sandbox — off in a lobby's game.
pub fn pack(game: &GuestGame) -> String {
    let text = serde_json::to_string(game).unwrap_or_default();
    let packed = gzip_base64(&text);
    if packed.len() <= PACKED_LIMIT {
        return packed;
    }
    let mut lighter = game.clone();
    lighter.step.view.you.library_cards.clear();
    gzip_base64(&serde_json::to_string(&lighter).unwrap_or_default())
}

/// A packed step read back, or `None` for one that is not.
pub fn unpack(packed: &str) -> Option<GuestGame> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(packed)
        .ok()?;
    let mut text = String::new();
    // Bounded: a step is a few hundred kilobytes of JSON at the most.
    flate2::read::GzDecoder::new(bytes.as_slice())
        .take(16 * 1024 * 1024)
        .read_to_string(&mut text)
        .ok()?;
    serde_json::from_str(&text).ok()
}

// ---------------------------------------------------------------------------------------
// The game, on the engine's stack
// ---------------------------------------------------------------------------------------

/// `work` on the host's `game`, taken out of the slot onto the engine's stack and put back after
/// — waiting its turn while an action of the host's board has it, as a pod's pick waits behind
/// the host's (`on_draft_waiting`). A panic loses the game, as it does for `playtest_act`.
async fn with_game<T: Send + 'static>(
    app: &tauri::AppHandle,
    game: u64,
    work: impl FnOnce(&mut Playtest) -> T + Send + 'static,
) -> Result<T, String> {
    let slot = app.state::<PlaytestSlot>();
    let deadline = tokio::time::Instant::now() + WAIT;
    let mut held = loop {
        let taken = slot.0.lock().map_err(|_| NO_GAME)?.take(game);
        match taken {
            Ok(held) => break held,
            Err(e) if e == BUSY && tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(WAIT_STEP).await;
            }
            Err(e) => return Err(e),
        }
    };
    let answer = tauri::async_runtime::spawn_blocking(move || {
        on_engine_stack(move || {
            let out = work(&mut held);
            (held, out)
        })
    })
    .await
    .map_err(|e| e.to_string());
    let mut slot = slot.0.lock().map_err(|_| NO_GAME)?;
    match answer {
        Ok(Ok((held, out))) => {
            slot.put_back(game, Some(held));
            Ok(out)
        }
        Ok(Err(e)) | Err(e) => {
            slot.put_back(game, None);
            Err(e)
        }
    }
}

/// A guest's action at `seat`: the host's step and every guest's, or the refusal.
pub async fn play(
    app: &tauri::AppHandle,
    game: u64,
    seat: u8,
    action: PlaytestAction,
) -> Result<(PlaytestStep, Vec<(u8, PlaytestStep)>), String> {
    with_game(app, game, move |g| {
        let host = g.act_by(seat, action)?;
        Ok((host, g.guest_steps()))
    })
    .await?
}

/// `seat` handed to the AI, and the game played on: the host's step and every guest's left.
pub async fn hand_over(
    app: &tauri::AppHandle,
    game: u64,
    seat: u8,
) -> Result<(PlaytestStep, Vec<(u8, PlaytestStep)>), String> {
    with_game(app, game, move |g| {
        let host = g.hand_to_ai(seat)?;
        Ok((host, g.guest_steps()))
    })
    .await?
}

/// `seat`'s step as it stands, for a guest that asked again: its view, nothing new told.
pub async fn step_of(app: &tauri::AppHandle, game: u64, seat: u8) -> Result<PlaytestStep, String> {
    with_game(app, game, move |g| {
        Ok(PlaytestStep {
            view: g.view_of(seat)?,
            happened: Vec::new(),
            frames: Vec::new(),
        })
    })
    .await?
}

/// The host's board told what a guest's action did.
pub fn emit_host(app: &tauri::AppHandle, game: u64, step: PlaytestStep) {
    let _ = app.emit("playtest:step", HostStep { game, step });
}

/// Put `game` away — a lobby that went before its game was seated.
pub fn end(app: &tauri::AppHandle, game: u64) {
    if let Ok(mut held) = app.state::<PlaytestSlot>().0.lock() {
        held.end(game);
    }
}

/// A guest's deck read for sending: `deck_id` as it stands in `variant`, its rows and tokens.
pub async fn guest_deck(
    app: Arc<AppState>,
    deck_id: i64,
    variant: String,
) -> Result<GuestDeck, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&app);
        let cards = grimoire_core::play::deck_cards(&conn, deck_id, &variant)?;
        let tokens = grimoire_core::play::deck_tokens(&conn, deck_id, &variant)?;
        let name = deck_name(&conn, deck_id, &variant)?;
        if cards.iter().all(|c| c.commander) {
            return Err(EMPTY.to_owned());
        }
        if cards.len() > MAX_ROWS || tokens.len() > MAX_TOKENS {
            return Err(TOO_BIG.to_owned());
        }
        Ok(GuestDeck {
            name,
            cards: cards
                .into_iter()
                .map(|c| GuestCard {
                    card_id: c.card_id,
                    quantity: c.quantity.min(MAX_COPIES),
                    commander: c.commander,
                })
                .collect(),
            tokens,
        })
    })
    .await
    .map_err(|e| format!("the deck could not be read: {e}"))?
}

fn deck_name(conn: &rusqlite::Connection, deck_id: i64, variant: &str) -> Result<String, String> {
    let detail = grimoire_core::deck::get_deck(
        conn,
        deck_id,
        variant,
        grimoire_core::sorting::Marketplace::from_opt(None),
    )?
    .ok_or_else(|| grimoire_core::play::NO_DECK.to_string())?;
    Ok(detail.deck.name)
}

/// Deal the lobby's `game`: the host's `deck_id` in `variant` against `table`, read in this
/// app's card data, onto the playtest board (the slot is this game's from the moment it is
/// dealt, as a `playtest_start` is). Answers the host's step, every guest's first, and whose seat
/// is whose.
#[allow(clippy::too_many_arguments)]
pub async fn deal(
    app: &tauri::AppHandle,
    state: Arc<AppState>,
    game: u64,
    deck_id: i64,
    variant: String,
    table: Table,
    difficulty: Difficulty,
    seed: u64,
) -> Result<(PlaytestStep, Vec<(u8, PlaytestStep)>, GameSeats), String> {
    let slot = app.state::<PlaytestSlot>();
    slot.0.lock().map_err(|_| NO_GAME)?.claim(game);
    let dealt = read_and_deal(state, game, deck_id, variant, table, difficulty, seed).await;
    let mut held = slot.0.lock().map_err(|_| NO_GAME)?;
    match dealt {
        Ok((playtest, host, guests, seats)) => {
            held.dealt(game, playtest)?;
            Ok((host, guests, seats))
        }
        Err(e) => {
            held.end(game);
            Err(e)
        }
    }
}

type Dealt = (Playtest, PlaytestStep, Vec<(u8, PlaytestStep)>, GameSeats);

async fn read_and_deal(
    app: Arc<AppState>,
    game: u64,
    deck_id: i64,
    variant: String,
    table: Table,
    difficulty: Difficulty,
    seed: u64,
) -> Result<Dealt, String> {
    let read = tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&app);
        let yours = grimoire_core::play::deck_cards(&conn, deck_id, &variant)?;
        let your_tokens = grimoire_core::play::deck_tokens(&conn, deck_id, &variant)?;
        let your_name = deck_name(&conn, deck_id, &variant)?;
        let mut theirs = Vec::with_capacity(table.seats.len());
        let mut names = vec![table.host.clone()];
        let mut decks = vec![your_name];
        let mut peers = Vec::new();
        for (n, sitter) in table.seats.iter().enumerate() {
            let seat = (n + 1) as u8;
            match sitter {
                Sitter::Guest { peer, name, deck } => {
                    let ids: Vec<String> = deck.cards.iter().map(|c| c.card_id.clone()).collect();
                    let known = grimoire_core::play::cards_by_ids(&conn, &ids)?;
                    let cards = guest_cards(&known, deck, name)?;
                    theirs.push((cards, deck.tokens.clone(), true));
                    names.push(name.clone());
                    decks.push(deck.name.clone());
                    peers.push((peer.clone(), seat));
                }
                Sitter::Ai { deck_id, variant } => {
                    let cards = grimoire_core::play::deck_cards(&conn, *deck_id, variant)?;
                    let tokens = grimoire_core::play::deck_tokens(&conn, *deck_id, variant)?;
                    let name = deck_name(&conn, *deck_id, variant)?;
                    theirs.push((cards, tokens, false));
                    names.push(name.clone());
                    decks.push(name);
                }
            }
        }
        Ok::<_, String>((
            yours,
            your_tokens,
            theirs,
            GameSeats {
                game,
                peers,
                names,
                decks,
            },
        ))
    })
    .await
    .map_err(|e| format!("the decks could not be read: {e}"))??;
    let (yours, your_tokens, theirs, seats) = read;
    if yours.iter().all(|c| c.commander) {
        return Err("Your deck has no cards to play with yet.".into());
    }
    if let Some(n) = theirs
        .iter()
        .position(|(cards, _, _)| cards.iter().all(|c| c.commander))
    {
        return Err(format!(
            "{}'s deck has no cards to play with yet.",
            seats.names[n + 1]
        ));
    }
    let yours: Vec<_> = yours.into_iter().map(facts).collect();
    let your_tokens: Vec<_> = your_tokens.into_iter().map(token_facts).collect();
    let theirs: Vec<OpponentDeck> = theirs
        .into_iter()
        .map(|(cards, tokens, person)| OpponentDeck {
            cards: cards.into_iter().map(facts).collect(),
            tokens: tokens.into_iter().map(token_facts).collect(),
            person,
        })
        .collect();
    let (playtest, host, guests) = tauri::async_runtime::spawn_blocking(move || {
        on_engine_stack(move || {
            let (mut playtest, host) =
                Playtest::new(&yours, &your_tokens, &theirs, seed, difficulty)?;
            let guests = playtest.guest_steps();
            Ok::<_, String>((playtest, host, guests))
        })
    })
    .await
    .map_err(|e| e.to_string())???;
    Ok((playtest, host, guests, seats))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn peer(id: &str, name: &str) -> LobbyPeer {
        LobbyPeer {
            peer: id.into(),
            name: name.into(),
            online: true,
            deck: None,
        }
    }

    fn deck(name: &str) -> GuestDeck {
        GuestDeck {
            name: name.into(),
            cards: vec![GuestCard {
                card_id: "c-forest".into(),
                quantity: 40,
                commander: false,
            }],
            tokens: Vec::new(),
        }
    }

    fn guest(id: &str) -> LobbyGameSeat {
        LobbyGameSeat {
            peer: Some(id.into()),
            deck_id: None,
            variant: None,
        }
    }

    fn ai(deck_id: i64) -> LobbyGameSeat {
        LobbyGameSeat {
            peer: None,
            deck_id: Some(deck_id),
            variant: Some("live".into()),
        }
    }

    #[test]
    fn a_table_is_a_duel_or_four_seats_with_a_guest_who_has_sent_a_deck() {
        let peers = [peer("p1", "Bo"), peer("p2", "Cy")];
        let decks: HashMap<String, GuestDeck> = [("p1".to_string(), deck("Elves"))].into();
        let duel = table("Ada", &[guest("p1")], &peers, &decks).unwrap();
        assert_eq!(duel.label(), "Duel");
        assert_eq!(
            duel.seats,
            [Sitter::Guest {
                peer: "p1".into(),
                name: "Bo".into(),
                deck: deck("Elves")
            }]
        );
        let four = table("Ada", &[ai(3), guest("p1"), ai(4)], &peers, &decks).unwrap();
        assert_eq!(four.label(), "Four-player");
        assert_eq!(four.seats.len(), 3);

        let refused = |seats: &[LobbyGameSeat]| table("Ada", seats, &peers, &decks).unwrap_err();
        assert_eq!(refused(&[guest("p1"), ai(3)]), TABLE_SIZE);
        assert_eq!(refused(&[]), TABLE_SIZE);
        assert_eq!(refused(&[ai(3)]), NO_GUEST);
        assert_eq!(refused(&[guest("p9")]), NOT_IN_LOBBY);
        assert_eq!(refused(&[guest("p2")]), "Cy has not picked a deck yet.");
        assert_eq!(refused(&[guest("p1"), guest("p1"), ai(3)]), SEATED_TWICE);
        let both = LobbyGameSeat {
            deck_id: Some(3),
            ..guest("p1")
        };
        assert_eq!(refused(&[both]), SEAT_IS_ONE);
    }

    #[test]
    fn a_guests_deck_is_read_in_the_hosts_card_data_and_a_printing_it_lacks_is_refused() {
        let known = PlayCard {
            card_id: "c-forest".into(),
            name: "Forest".into(),
            quantity: 1,
            commander: false,
            oracle_id: None,
            mana_cost: None,
            type_line: Some("Basic Land — Forest".into()),
            oracle_text: None,
            power: None,
            toughness: None,
            loyalty: None,
            defense: None,
            cmc: Some(0.0),
            layout: None,
            colors: Vec::new(),
            color_identity: Vec::new(),
            keywords: Vec::new(),
            faces: None,
        };
        let cards = guest_cards(std::slice::from_ref(&known), &deck("Elves"), "Bo").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!((cards[0].quantity, cards[0].name.as_str()), (40, "Forest"));
        let refused = guest_cards(&[], &deck("Elves"), "Bo").unwrap_err();
        assert!(refused.starts_with("Bo's deck has a card"), "{refused}");
    }

    #[test]
    fn a_guest_is_told_the_others_names_from_its_own_seat() {
        let seats = GameSeats {
            game: 7,
            peers: vec![("p1".into(), 1), ("p2".into(), 3)],
            names: vec!["Ada".into(), "Bo".into(), "Goblins".into(), "Cy".into()],
            decks: vec![
                "Elves".into(),
                "Red".into(),
                "Goblins".into(),
                "Blue".into(),
            ],
        };
        assert_eq!(seats.seat_of("p2"), Some(3));
        assert_eq!(seats.peer_of(1), Some("p1"));
        assert_eq!(seats.peer_of(2), None, "an AI seat is nobody's");
        // Any view will do: what is tested is the names around it.
        let step = PlaytestStep {
            view: return_view(),
            happened: Vec::new(),
            frames: Vec::new(),
        };
        let game = seats.guest_game(3, step, true);
        assert_eq!(game.names, ["Ada", "Bo", "Goblins"]);
        assert_eq!(game.deck, "Blue");
        assert!(game.dealt);
    }

    /// A view off a real deal: the reader's forests against a guest's.
    fn return_view() -> grimoire_play::PlaytestView {
        on_engine_stack(|| {
            let forest = grimoire_play::CardFacts {
                card_id: "c-forest".into(),
                name: "Forest".into(),
                quantity: 40,
                type_line: Some("Basic Land — Forest".into()),
                oracle_text: Some("({T}: Add {G}.)".into()),
                cmc: Some(0.0),
                layout: Some("normal".into()),
                color_identity: vec!["G".into()],
                ..Default::default()
            };
            let theirs = [OpponentDeck {
                cards: vec![forest.clone()],
                tokens: Vec::new(),
                person: true,
            }];
            Playtest::new(&[forest], &[], &theirs, 2, Difficulty::VeryEasy)
                .unwrap()
                .1
                .view
        })
        .unwrap()
    }

    #[test]
    fn a_step_crosses_packed_and_comes_back_whole() {
        let game = GuestGame {
            step: PlaytestStep {
                view: return_view(),
                happened: Vec::new(),
                frames: Vec::new(),
            },
            names: vec!["Ada".into()],
            deck: "Elves".into(),
            dealt: true,
        };
        let packed = pack(&game);
        let json = serde_json::to_string(&game).unwrap();
        assert!(packed.len() < json.len(), "packed is smaller");
        assert!(packed.len() <= PACKED_LIMIT);
        assert_eq!(unpack(&packed), Some(game));
        assert_eq!(unpack("not base64!"), None);
        assert_eq!(
            unpack(&base64::engine::general_purpose::STANDARD.encode("x")),
            None
        );
    }

    #[test]
    fn the_wire_reads_as_the_page_writes_it() {
        let seat: LobbyGameSeat = serde_json::from_value(
            serde_json::json!({"peer": null, "deckId": 4, "variant": "theory"}),
        )
        .unwrap();
        assert_eq!(
            seat,
            LobbyGameSeat {
                peer: None,
                deck_id: Some(4),
                variant: Some("theory".into())
            }
        );
        assert_eq!(
            serde_json::to_value(deck("Elves")).unwrap(),
            serde_json::json!({"name": "Elves", "tokens": [],
                "cards": [{"cardId": "c-forest", "quantity": 40, "commander": false}]})
        );
    }
}
