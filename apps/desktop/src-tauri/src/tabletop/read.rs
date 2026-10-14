//! One list of one deck, as the stacks a Tabletop Simulator save puts on the table — the one place
//! the integration asks the database a question.
//!
//! **Composition, as the mirror's `read` is.** The cards are [`crate::deck::get_deck`]'s and the
//! tokens [`crate::deck_tokens::deck_token_rows`]' — the same reads the deck editor draws from — so
//! the table cannot disagree with the screen about what is in a deck. The only SQL of its own is
//! the two questions those reads do not answer: where a printing's picture is, and which printing
//! of a token is the newest.
//!
//! # Which pile goes where
//!
//! | Pile | Stack |
//! | --- | --- |
//! | an active `main` pile | **Library**, face down |
//! | an active `commander` or `companion` pile | **Commander**, face up |
//! | an active `side` pile | **Sideboard**, face down |
//! | every token and extra the list has | **Tokens & extras**, face up |
//! | a `maybe` pile, and any switched-off pile | nothing |
//!
//! An inactive pile counts toward nothing in the app — not size, not legality — so it is not put on
//! the table either. The maybeboard is cards the reader is *considering*, not playing.
//!
//! # Tokens: the reader's printings, else the newest
//!
//! A token the reader has configured — one holding entries of its own in this list — goes on the
//! table as those printings, one card per copy they keep (at least one). A token with only its
//! implicit entry goes on as **the newest printing of it** ([`newest_printing`]), one copy: a
//! token on the table is something to clone, not a count.
//!
//! # Pictures
//!
//! Scryfall's `large` JPEG, read out of `cards.raw`. **Not the stored `display` URL**: that column
//! holds Scryfall's WEBP family, which the app draws and Tabletop Simulator does not load. The JPG
//! family is still in every raw line (measured on the dev corpus 2026-10-14: `small`, `normal`,
//! `large`, `png`, `art_crop`, `border_crop` beside the four WEBP keys), and `large` is the size
//! TTS deck builders use. A card whose faces carry pictures of their own (`transform`,
//! `modal_dfc`, a double-faced token) answers both faces; every other layout answers one.
//!
//! A printing this build cannot find a picture for — one that has left the corpus — falls back to
//! Scryfall's own image redirect for its set and number, which is the one URL that still names it.

use crate::sorting::Marketplace;
use crate::tabletop::save::{Card, Face, Stack, DEFAULT_BACK};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::collections::HashMap;

/// The host every picture this integration hands Tabletop Simulator is on — the same fence the
/// image cache keeps ([`grimoire_core::image_uri::IMAGE_HOST`]): a raw line that named another host
/// is not a picture this app vouches for.
const IMAGE_HOST: &str = grimoire_core::image_uri::IMAGE_HOST;
const BACK_HOST: &str = "https://backs.scryfall.io/";

/// The picture sizes to try, best for TTS first.
const SIZES: [&str; 3] = ["large", "normal", "png"];

/// The stack names, as TTS shows them on hover.
pub const LIBRARY: &str = "Library";
pub const COMMANDER: &str = "Commander";
pub const SIDEBOARD: &str = "Sideboard";
pub const TOKENS: &str = "Tokens & extras";

/// What a printing looks like on the table, read once per pass per printing.
#[derive(Debug, Clone, PartialEq)]
pub struct Art {
    front: Face,
    back_face: Option<Face>,
    card_back: String,
}

/// Every printing's [`Art`] this pass has already read. One pass reads every deck, and a basic
/// land is in most of them.
pub type ArtMemo = HashMap<String, Option<Art>>;

/// The first picture `uris` names, of the sizes TTS takes, on the image host.
fn picture(uris: Option<&Value>) -> Option<String> {
    let uris = uris?;
    SIZES
        .iter()
        .filter_map(|k| uris.get(*k).and_then(Value::as_str))
        .find(|u| u.starts_with(IMAGE_HOST))
        .map(str::to_owned)
}

/// The printing's card back on Scryfall's back host, from the raw line's `card_back_id` — or the
/// ordinary Magic back for a line that names none, or one that is not a plain id.
fn card_back(v: &Value) -> String {
    match v.get("card_back_id").and_then(Value::as_str) {
        Some(id) if id.len() > 2 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') => {
            format!("{BACK_HOST}large/{}/{}/{id}.jpg", &id[0..1], &id[1..2])
        }
        _ => DEFAULT_BACK.to_owned(),
    }
}

/// A printing's [`Art`], from its raw Scryfall line. Pure, so the face rule is testable with a
/// literal.
pub fn art_of(v: &Value) -> Option<Art> {
    let name = v.get("name").and_then(Value::as_str).unwrap_or_default();
    let back = card_back(v);
    // Faces with pictures of their own are a card with two sides. A split card or an adventure
    // has `card_faces` too, but one picture, at the top level.
    let faces: Vec<(String, String)> = v
        .get("card_faces")
        .and_then(Value::as_array)
        .map(|faces| {
            faces
                .iter()
                .filter_map(|f| {
                    let image = picture(f.get("image_uris"))?;
                    let name = f.get("name").and_then(Value::as_str).unwrap_or(name);
                    Some((name.to_owned(), image))
                })
                .collect()
        })
        .unwrap_or_default();
    if let [front, back_face, ..] = faces.as_slice() {
        return Some(Art {
            front: Face {
                name: front.0.clone(),
                image: front.1.clone(),
            },
            back_face: Some(Face {
                name: back_face.0.clone(),
                image: back_face.1.clone(),
            }),
            card_back: back,
        });
    }
    let image = picture(v.get("image_uris")).or_else(|| faces.first().map(|f| f.1.clone()))?;
    Some(Art {
        front: Face {
            name: name.to_owned(),
            image,
        },
        back_face: None,
        card_back: back,
    })
}

/// One printing's [`Art`], read through the memo.
fn art(conn: &Connection, card_id: &str, memo: &mut ArtMemo) -> Result<Option<Art>, String> {
    if let Some(known) = memo.get(card_id) {
        return Ok(known.clone());
    }
    let raw: Option<Vec<u8>> = conn
        .query_row(
            "SELECT CAST(raw AS BLOB) FROM cards WHERE id = ?1",
            params![card_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let found = raw
        .as_deref()
        .and_then(grimoire_core::card_row::raw_json)
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| art_of(&v));
    memo.insert(card_id.to_owned(), found.clone());
    Ok(found)
}

/// A card for one printing — its art, or Scryfall's image redirect for one this build cannot
/// find a picture for.
fn card_for(
    conn: &Connection,
    card_id: &str,
    name: &str,
    set_code: &str,
    collector_number: &str,
    memo: &mut ArtMemo,
) -> Result<Card, String> {
    Ok(match art(conn, card_id, memo)? {
        Some(a) => Card {
            front: a.front,
            back_face: a.back_face,
            card_back: a.card_back,
        },
        None => Card {
            front: Face {
                name: name.to_owned(),
                image: format!(
                    "https://api.scryfall.com/cards/{}/{}?format=image&version=large",
                    urlish(set_code),
                    urlish(collector_number)
                ),
            },
            back_face: None,
            card_back: DEFAULT_BACK.to_owned(),
        },
    })
}

/// A set code or collector number made safe for a URL path: anything but `[A-Za-z0-9-]` is
/// percent-encoded. Collector numbers carry `★` and `†` in real data.
fn urlish(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.to_lowercase().bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The newest printing of one oracle card — `released_at DESC`, then the same tail the token
/// resolver breaks ties with, so two passes over one corpus answer one printing.
fn newest_printing(conn: &Connection, oracle_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT id FROM cards WHERE oracle_id = ?1
          ORDER BY released_at DESC, set_code ASC, collector_number ASC, id ASC LIMIT 1",
        params![oracle_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Copies as a count of cards — a quantity is never negative, and a huge one is still one stack.
fn copies(n: i64) -> usize {
    n.clamp(0, 250) as usize
}

/// One list of one deck as stacks — Library, Commander, Sideboard, then Tokens & extras — or
/// `None` for a deck deleted since the plan was made.
pub fn stacks_for(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
    memo: &mut ArtMemo,
) -> Result<Option<Vec<Stack>>, String> {
    let market = Marketplace::from_id(&crate::marketplace::stored(conn));
    let Some(detail) = crate::deck::get_deck(conn, deck_id, variant, market)? else {
        return Ok(None);
    };
    let mut library = Vec::new();
    let mut commander = Vec::new();
    let mut sideboard = Vec::new();
    for row in detail.cards.iter().filter(|r| r.category_active) {
        let pile = match row.category_kind.as_str() {
            "main" => &mut library,
            "commander" | "companion" => &mut commander,
            "side" => &mut sideboard,
            _ => continue,
        };
        let card = card_for(
            conn,
            &row.card_id,
            &row.name,
            &row.set_code,
            &row.collector_number,
            memo,
        )?;
        pile.extend(std::iter::repeat_n(card, copies(row.quantity)));
    }

    let mut tokens = Vec::new();
    let rows = crate::deck_tokens::deck_token_rows(conn, deck_id, variant, market)?;
    // Rows arrive grouped by token (`oracle_id`), entries together.
    let mut order: Vec<&str> = Vec::new();
    let mut by_token: HashMap<&str, Vec<&crate::deck_tokens::DeckTokenRow>> = HashMap::new();
    for row in &rows {
        if !by_token.contains_key(row.oracle_id.as_str()) {
            order.push(&row.oracle_id);
        }
        by_token.entry(&row.oracle_id).or_default().push(row);
    }
    for oracle in order {
        let entries = &by_token[oracle];
        let configured: Vec<_> = entries.iter().filter(|r| !r.implicit).collect();
        let mut picks: Vec<(String, usize)> = configured
            .iter()
            .filter(|r| r.quantity > 0)
            .map(|r| (r.card_id.clone(), copies(r.quantity)))
            .collect();
        if picks.is_empty() {
            // The reader configured printings and stepped every one to nothing: the first of
            // them still says which printing they chose. Nothing configured at all: the newest.
            let id = match configured.first() {
                Some(r) => r.card_id.clone(),
                None => newest_printing(conn, oracle)?
                    .unwrap_or_else(|| entries[0].default_card_id.clone()),
            };
            picks.push((id, 1));
        }
        for (card_id, n) in picks {
            let first = entries[0];
            let card = card_for(
                conn,
                &card_id,
                &first.name,
                first.set_code.as_deref().unwrap_or_default(),
                first.collector_number.as_deref().unwrap_or_default(),
                memo,
            )?;
            tokens.extend(std::iter::repeat_n(card, n));
        }
    }

    Ok(Some(vec![
        Stack {
            nickname: LIBRARY.to_owned(),
            face_up: false,
            cards: library,
        },
        Stack {
            nickname: COMMANDER.to_owned(),
            face_up: true,
            cards: commander,
        },
        Stack {
            nickname: SIDEBOARD.to_owned(),
            face_up: false,
            cards: sideboard,
        },
        Stack {
            nickname: TOKENS.to_owned(),
            face_up: true,
            cards: tokens,
        },
    ]))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    fn uris(id: &str, side: &str) -> Value {
        json!({
            "normal": format!("https://cards.scryfall.io/normal/{side}/{id}.jpg?1"),
            "large": format!("https://cards.scryfall.io/large/{side}/{id}.jpg?1"),
            "display": format!("https://cards.scryfall.io/display/{side}/{id}.webp?1"),
        })
    }

    /// Seed one printing whose raw line carries pictures. Seeding `cards` is allowed here only
    /// because the connection is in memory and dies with the test.
    pub(crate) fn seed_card(
        conn: &Connection,
        id: &str,
        oracle: &str,
        name: &str,
        layout: &str,
        released: &str,
    ) {
        let raw = if layout == "transform" {
            json!({
                "name": name,
                "card_back_id": "0aeebaf5-8c7d-4636-9e82-8c27447861f7",
                "card_faces": [
                    { "name": "Front of ".to_owned() + name, "image_uris": uris(id, "front") },
                    { "name": "Back of ".to_owned() + name, "image_uris": uris(id, "back") },
                ],
            })
        } else {
            json!({ "name": name, "image_uris": uris(id, "front") })
        };
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                rarity,type_line,finishes,released_at,raw)
             VALUES (?1,?2,?3,'tst',?1,'en',?4,'common','Creature','[\"nonfoil\"]',?5,?6)",
            params![id, oracle, name, layout, released, raw.to_string()],
        )
        .unwrap();
    }

    #[test]
    fn a_normal_card_is_one_large_jpeg_on_the_ordinary_back() {
        let a = art_of(&json!({ "name": "Bolt", "image_uris": uris("b", "front") })).unwrap();
        assert_eq!(
            a.front.image,
            "https://cards.scryfall.io/large/front/b.jpg?1"
        );
        assert_eq!(a.front.name, "Bolt");
        assert_eq!(a.back_face, None);
        assert_eq!(a.card_back, DEFAULT_BACK);
    }

    #[test]
    fn a_card_whose_faces_have_pictures_answers_both_faces() {
        let a = art_of(&json!({
            "name": "Delver // Aberration",
            "card_back_id": "0aeebaf5-8c7d-4636-9e82-8c27447861f7",
            "card_faces": [
                { "name": "Delver", "image_uris": uris("d", "front") },
                { "name": "Aberration", "image_uris": uris("d", "back") },
            ],
        }))
        .unwrap();
        assert_eq!(a.front.name, "Delver");
        let back = a.back_face.unwrap();
        assert_eq!(back.name, "Aberration");
        assert_eq!(back.image, "https://cards.scryfall.io/large/back/d.jpg?1");
        assert_eq!(a.card_back, DEFAULT_BACK);
    }

    /// A split card has faces but one picture: it is one card on the table.
    #[test]
    fn a_split_card_is_one_picture() {
        let a = art_of(&json!({
            "name": "Fire // Ice",
            "image_uris": uris("f", "front"),
            "card_faces": [{ "name": "Fire" }, { "name": "Ice" }],
        }))
        .unwrap();
        assert_eq!(a.front.name, "Fire // Ice");
        assert_eq!(a.back_face, None);
    }

    /// The fence the image cache keeps: a picture on another host is not one this app hands on.
    #[test]
    fn a_picture_on_another_host_is_no_picture() {
        let v = json!({ "name": "X", "image_uris": { "large": "https://errors.scryfall.com/soon.jpg" } });
        assert_eq!(art_of(&v), None);
    }

    #[test]
    fn a_collector_number_with_a_star_is_encoded() {
        assert_eq!(urlish("123★"), "123%E2%98%85");
        assert_eq!(urlish("LEA"), "lea");
    }

    fn deck_with(conn: &Connection) -> i64 {
        let deck = crate::deck::create_deck(
            conn,
            &crate::deck::DeckInput {
                name: "Azula".to_owned(),
                ..Default::default()
            },
        )
        .unwrap();
        deck.id
    }

    /// The deck's live pile of `kind` — the one `create_deck` made, or a new one. A deck holds at
    /// most one pile of each kind but `main`, so the kind is the address.
    fn pile(conn: &Connection, deck: i64, kind: &str) -> i64 {
        let found: Option<i64> = conn
            .query_row(
                "SELECT id FROM deck_categories WHERE deck_id = ?1 AND variant = 'live' AND kind = ?2",
                params![deck, kind],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        found.unwrap_or_else(|| {
            let id = crate::deck_meta::category_for_name(conn, deck, "live", kind).unwrap();
            conn.execute(
                "UPDATE deck_categories SET kind = ?1 WHERE id = ?2",
                params![kind, id],
            )
            .unwrap();
            id
        })
    }

    #[test]
    fn piles_land_in_their_stacks_and_the_maybeboard_stays_off_the_table() {
        let conn = crate::schema::memory_pair();
        seed_card(&conn, "bolt", "o-bolt", "Bolt", "normal", "1993-08-05");
        seed_card(&conn, "azula", "o-azula", "Azula", "normal", "2025-01-01");
        seed_card(
            &conn,
            "delver",
            "o-delver",
            "Delver",
            "transform",
            "2011-09-30",
        );
        seed_card(&conn, "maybe", "o-maybe", "Maybe", "normal", "2020-01-01");
        let deck = deck_with(&conn);
        for (card, kind, n) in [
            ("bolt", "main", 4),
            ("delver", "main", 2),
            ("azula", "commander", 1),
            ("bolt", "side", 1),
            ("maybe", "maybe", 1),
        ] {
            let at = pile(&conn, deck, kind);
            crate::deck::add_card(&conn, deck, card, Some(at), None, "live", None, n).unwrap();
        }

        let stacks = stacks_for(&conn, deck, "live", &mut ArtMemo::new())
            .unwrap()
            .unwrap();
        let named = |n: &str| stacks.iter().find(|s| s.nickname == n).unwrap();
        assert_eq!(named(LIBRARY).cards.len(), 6);
        assert!(!named(LIBRARY).face_up);
        assert_eq!(named(COMMANDER).cards.len(), 1);
        assert!(named(COMMANDER).face_up);
        assert_eq!(named(COMMANDER).cards[0].front.name, "Azula");
        assert_eq!(named(SIDEBOARD).cards.len(), 1);
        let delver = named(LIBRARY)
            .cards
            .iter()
            .find(|c| c.front.name == "Front of Delver")
            .expect("a transform card is drawn by its front face");
        assert_eq!(delver.back_face.as_ref().unwrap().name, "Back of Delver");
        assert!(stacks
            .iter()
            .all(|s| s.cards.iter().all(|c| c.front.name != "Maybe")));
    }

    #[test]
    fn a_switched_off_pile_is_not_put_on_the_table() {
        let conn = crate::schema::memory_pair();
        seed_card(&conn, "bolt", "o-bolt", "Bolt", "normal", "1993-08-05");
        let deck = deck_with(&conn);
        crate::deck::add_card(&conn, deck, "bolt", None, Some("Off"), "live", None, 3).unwrap();
        conn.execute(
            "UPDATE deck_categories SET is_active = 0 WHERE deck_id = ?1 AND name = 'Off'",
            params![deck],
        )
        .unwrap();
        let stacks = stacks_for(&conn, deck, "live", &mut ArtMemo::new())
            .unwrap()
            .unwrap();
        assert!(stacks.iter().all(|s| s.cards.is_empty()));
    }

    #[test]
    fn a_deck_that_is_gone_is_none() {
        let conn = crate::schema::memory_pair();
        assert_eq!(
            stacks_for(&conn, 999, "live", &mut ArtMemo::new()).unwrap(),
            None
        );
    }

    #[test]
    fn the_newest_printing_of_a_token_is_the_latest_release() {
        let conn = crate::schema::memory_pair();
        seed_card(
            &conn,
            "t-old",
            "o-treasure",
            "Treasure",
            "token",
            "2018-01-01",
        );
        seed_card(
            &conn,
            "t-new",
            "o-treasure",
            "Treasure",
            "token",
            "2024-06-01",
        );
        assert_eq!(
            newest_printing(&conn, "o-treasure").unwrap().as_deref(),
            Some("t-new")
        );
    }

    /// A printing that has left the corpus still goes on the table, by Scryfall's redirect.
    #[test]
    fn a_printing_with_no_picture_falls_back_to_scryfalls_redirect() {
        let conn = crate::schema::memory_pair();
        let card = card_for(&conn, "gone", "Gone", "LEA", "161", &mut ArtMemo::new()).unwrap();
        assert_eq!(
            card.front.image,
            "https://api.scryfall.com/cards/lea/161?format=image&version=large"
        );
    }
}
