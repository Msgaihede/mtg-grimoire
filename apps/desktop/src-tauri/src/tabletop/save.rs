//! One Tabletop Simulator save, as text — a pure function of the stacks it holds.
//!
//! No `Connection`, no filesystem: [`render`] takes [`Stack`]s of [`Card`]s and answers the JSON a
//! TTS `Saves` folder holds. That is what lets the format be decided and tested without a database,
//! and it is why [`super::read`] resolves cards and pictures before anything here runs.
//!
//! # The shape TTS reads
//!
//! A save is one JSON object whose `ObjectStates` are the things on the table. Each stack here is
//! one of them:
//!
//! - **Two or more cards are a `Deck`**: its `ContainedObjects` are `Card`s, its `DeckIDs` their
//!   `CardID`s in order, and its `CustomDeck` the pictures those ids name.
//! - **One card is a `Card`**, never a deck of one — TTS will not load a deck holding a single card.
//! - **No cards is no object at all.**
//!
//! **Every card picture is a sheet of one** (`NumWidth`/`NumHeight` 1), so a `CardID` is its
//! sheet's key times 100. A sheet is keyed once per distinct picture across the whole save, not
//! per stack: TTS folds every `CustomDeck` it loads into one table, and two stacks numbering their
//! sheets from 1 would hand each other's cards the wrong face.
//!
//! **A double-faced card carries its back as a second state** (`States["2"]`), which is what TTS
//! flips between on PageUp/PageDown. The back face is deliberately *not* the sheet's `BackURL`:
//! a card in a face-down library has to show the ordinary Magic back, or the library would tell
//! the table which transform card is on top.
//!
//! **Face down is a rotation**, `rotZ: 180` on the stack; the cards inside keep the stack's own.
//!
//! **Deterministic, byte for byte.** No date, no GUID, no random seed: TTS mints what it needs on
//! load, and a save that changed every pass would rewrite every deck on every edit and be a diff
//! nobody can read twice — [`super::run`] writes only files whose bytes moved.

use serde_json::{json, Map, Value};

/// The ordinary Magic card back on Scryfall's image host — `card_back_id`
/// `0aeebaf5-8c7d-4636-9e82-8c27447861f7`, the one nearly every printing names. A printing that
/// names another back carries its own; this is the answer for one that names none.
pub const DEFAULT_BACK: &str =
    "https://backs.scryfall.io/large/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg";

/// The table and the sky a save opens on — the pair Tabletop Simulator's own save-format page uses
/// as its example. Any built-in pair would do; a save with neither opens over nothing.
const TABLE: &str = "Table_Octagon";
const SKY: &str = "Sky_Forest";

/// How far apart, along the table's width, two stacks are put down. A Magic card is about 2.2
/// units wide at scale 1, so 3 leaves a gap a hand can reach into.
const SPACING: f64 = 3.0;

/// One face of a card: what TTS calls it and where its picture is.
#[derive(Debug, Clone, PartialEq)]
pub struct Face {
    pub name: String,
    pub image: String,
}

/// One card, as the table sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct Card {
    pub front: Face,
    /// The other face of a double-faced card, flipped to as a second state. `None` for a card
    /// with one face — a split card and an adventure are one picture, and so is a `meld` half,
    /// whose "back" is half of another card.
    pub back_face: Option<Face>,
    /// The printing's card back, shown face down.
    pub card_back: String,
}

/// One pile on the table.
#[derive(Debug, Clone, PartialEq)]
pub struct Stack {
    /// What TTS shows on hover — `Library`, `Commander`, `Tokens & extras`, `Sideboard`.
    pub nickname: String,
    pub face_up: bool,
    /// One entry per **copy**, in the order they are stacked.
    pub cards: Vec<Card>,
}

/// The sheets of the save — one per distinct (picture, back) pair, numbered from 1 in the order
/// they are first met.
#[derive(Default)]
struct Sheets {
    keys: Vec<(String, String)>,
}

impl Sheets {
    /// The key of this picture's sheet, minting one the first time it is seen.
    fn key(&mut self, image: &str, back: &str) -> usize {
        if let Some(i) = self.keys.iter().position(|(f, b)| f == image && b == back) {
            return i + 1;
        }
        self.keys.push((image.to_owned(), back.to_owned()));
        self.keys.len()
    }

    /// The `CustomDeck` entry for one key.
    fn entry(&self, key: usize) -> Value {
        let (face, back) = &self.keys[key - 1];
        json!({
            "FaceURL": face,
            "BackURL": back,
            "NumWidth": 1,
            "NumHeight": 1,
            "BackIsHidden": true,
            "UniqueBack": false,
            "Type": 0,
        })
    }
}

fn transform(x: f64, face_up: bool) -> Value {
    json!({
        "posX": x,
        "posY": 1.0,
        "posZ": 0.0,
        "rotX": 0.0,
        "rotY": 180.0,
        "rotZ": if face_up { 0.0 } else { 180.0 },
        "scaleX": 1.0,
        "scaleY": 1.0,
        "scaleZ": 1.0,
    })
}

/// One `Card` object, with its back face as a second state when it has one. Answers the object
/// and the sheet keys it uses, so a deck can gather its `CustomDeck` from its cards.
fn card_object(card: &Card, sheets: &mut Sheets, at: Value) -> (Value, Vec<usize>) {
    let key = sheets.key(&card.front.image, &card.card_back);
    let mut obj = Map::new();
    obj.insert("Name".into(), json!("Card"));
    obj.insert("Transform".into(), at.clone());
    obj.insert("Nickname".into(), json!(card.front.name));
    obj.insert("Description".into(), json!(""));
    obj.insert("CardID".into(), json!(key * 100));
    obj.insert(
        "CustomDeck".into(),
        json!({ key.to_string(): sheets.entry(key) }),
    );
    let mut keys = vec![key];
    if let Some(back) = &card.back_face {
        let back_key = sheets.key(&back.image, &card.card_back);
        obj.insert(
            "States".into(),
            json!({
                "2": {
                    "Name": "Card",
                    "Transform": at,
                    "Nickname": back.name,
                    "Description": "",
                    "CardID": back_key * 100,
                    "CustomDeck": { back_key.to_string(): sheets.entry(back_key) },
                }
            }),
        );
        keys.push(back_key);
    }
    (Value::Object(obj), keys)
}

/// One stack as one object: a `Card` for one card, a `Deck` for more, `None` for an empty stack.
fn stack_object(stack: &Stack, sheets: &mut Sheets, x: f64) -> Option<Value> {
    let at = transform(x, stack.face_up);
    match stack.cards.as_slice() {
        [] => None,
        [one] => {
            let (mut obj, _) = card_object(one, sheets, at);
            obj["Nickname"] = json!(format!("{} — {}", stack.nickname, one.front.name));
            Some(obj)
        }
        many => {
            let mut contained = Vec::with_capacity(many.len());
            let mut ids = Vec::with_capacity(many.len());
            let mut used: Vec<usize> = Vec::new();
            for card in many {
                let (obj, keys) = card_object(card, sheets, at.clone());
                ids.push(obj["CardID"].clone());
                contained.push(obj);
                // Only the front's sheet belongs to the deck: a back face is its card's own state.
                if !used.contains(&keys[0]) {
                    used.push(keys[0]);
                }
            }
            let custom: Map<String, Value> = used
                .iter()
                .map(|&k| (k.to_string(), sheets.entry(k)))
                .collect();
            Some(json!({
                "Name": "Deck",
                "Transform": at,
                "Nickname": stack.nickname,
                "Description": "",
                "DeckIDs": ids,
                "CustomDeck": custom,
                "ContainedObjects": contained,
            }))
        }
    }
}

/// The whole save, as the text written to disk — pretty-printed, so a reader who opens it in
/// Notepad can find their deck in it, and LF-terminated.
pub fn render(save_name: &str, stacks: &[Stack]) -> String {
    let mut sheets = Sheets::default();
    // Centred on the table: the stacks that exist are spread evenly about x = 0.
    let present: Vec<&Stack> = stacks.iter().filter(|s| !s.cards.is_empty()).collect();
    let first = -(present.len().saturating_sub(1) as f64) * SPACING / 2.0;
    let objects: Vec<Value> = present
        .iter()
        .enumerate()
        .filter_map(|(i, s)| stack_object(s, &mut sheets, first + i as f64 * SPACING))
        .collect();
    let save = json!({
        "SaveName": save_name,
        "GameMode": "Magic: The Gathering",
        "Date": "",
        "VersionNumber": "",
        "GameType": "",
        "GameComplexity": "",
        "Tags": [],
        "Gravity": 0.5,
        "PlayArea": 0.5,
        "Table": TABLE,
        "Sky": SKY,
        "Note": "Saved by MTG Grimoire. This file is rewritten whenever the deck changes in the app; save a copy under another name to keep your own changes.",
        "Rules": "",
        "XmlUI": "",
        "LuaScript": "",
        "LuaScriptState": "",
        "TabStates": {},
        "ObjectStates": objects,
    });
    let mut text = serde_json::to_string_pretty(&save).unwrap_or_default();
    text.push('\n');
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(name: &str) -> Card {
        Card {
            front: Face {
                name: name.to_owned(),
                image: format!("https://cards.scryfall.io/large/front/{name}.jpg"),
            },
            back_face: None,
            card_back: DEFAULT_BACK.to_owned(),
        }
    }

    fn parse(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn a_library_of_several_cards_is_one_face_down_deck() {
        let save = parse(&render(
            "Azula",
            &[Stack {
                nickname: "Library".into(),
                face_up: false,
                cards: vec![card("Bolt"), card("Bolt"), card("Sol Ring")],
            }],
        ));
        assert_eq!(save["SaveName"], "Azula");
        let objects = save["ObjectStates"].as_array().unwrap();
        assert_eq!(objects.len(), 1);
        let deck = &objects[0];
        assert_eq!(deck["Name"], "Deck");
        assert_eq!(deck["Transform"]["rotZ"], 180.0, "a library is face down");
        assert_eq!(
            deck["DeckIDs"],
            json!([100, 100, 200]),
            "two copies share a sheet"
        );
        assert_eq!(deck["ContainedObjects"].as_array().unwrap().len(), 3);
        assert_eq!(
            deck["CustomDeck"]["2"]["FaceURL"],
            "https://cards.scryfall.io/large/front/Sol Ring.jpg"
        );
        assert_eq!(deck["CustomDeck"]["1"]["BackURL"], DEFAULT_BACK);
    }

    /// TTS refuses a deck of one, so a lone commander is a card, and an empty stack is nothing.
    #[test]
    fn one_card_is_a_card_and_no_cards_is_nothing() {
        let save = parse(&render(
            "Azula",
            &[
                Stack {
                    nickname: "Library".into(),
                    face_up: false,
                    cards: vec![],
                },
                Stack {
                    nickname: "Commander".into(),
                    face_up: true,
                    cards: vec![card("Azula")],
                },
            ],
        ));
        let objects = save["ObjectStates"].as_array().unwrap();
        assert_eq!(objects.len(), 1);
        assert_eq!(objects[0]["Name"], "Card");
        assert_eq!(
            objects[0]["Transform"]["rotZ"], 0.0,
            "a commander is face up"
        );
        assert_eq!(objects[0]["CardID"], 100);
    }

    /// The back face is a second state, and never the sheet's back — a face-down library must
    /// not show which transform card is on top.
    #[test]
    fn a_double_faced_card_flips_to_its_back_as_a_second_state() {
        let mut delver = card("Delver of Secrets");
        delver.back_face = Some(Face {
            name: "Insectile Aberration".into(),
            image: "https://cards.scryfall.io/large/back/delver.jpg".into(),
        });
        let save = parse(&render(
            "Tempo",
            &[Stack {
                nickname: "Library".into(),
                face_up: false,
                cards: vec![delver.clone(), delver],
            }],
        ));
        let deck = &save["ObjectStates"][0];
        let first = &deck["ContainedObjects"][0];
        assert_eq!(first["Nickname"], "Delver of Secrets");
        assert_eq!(first["CustomDeck"]["1"]["BackURL"], DEFAULT_BACK);
        let state = &first["States"]["2"];
        assert_eq!(state["Nickname"], "Insectile Aberration");
        assert_eq!(state["CardID"], 200);
        assert_eq!(
            state["CustomDeck"]["2"]["FaceURL"],
            "https://cards.scryfall.io/large/back/delver.jpg"
        );
        assert!(
            deck["CustomDeck"].get("2").is_none(),
            "the back face's sheet is the state's, not the deck's"
        );
    }

    /// Sheets are numbered across the save, so a token in one stack and a card in another never
    /// share a key.
    #[test]
    fn sheet_keys_are_unique_across_stacks() {
        let save = parse(&render(
            "Azula",
            &[
                Stack {
                    nickname: "Library".into(),
                    face_up: false,
                    cards: vec![card("Bolt"), card("Shock")],
                },
                Stack {
                    nickname: "Tokens & extras".into(),
                    face_up: true,
                    cards: vec![card("Treasure"), card("Bolt")],
                },
            ],
        ));
        let tokens = &save["ObjectStates"][1];
        assert_eq!(tokens["DeckIDs"], json!([300, 100]));
        assert_eq!(tokens["Transform"]["rotZ"], 0.0);
    }

    #[test]
    fn the_same_stacks_render_the_same_bytes() {
        let stacks = [Stack {
            nickname: "Library".into(),
            face_up: false,
            cards: vec![card("Bolt"), card("Sol Ring")],
        }];
        assert_eq!(render("A", &stacks), render("A", &stacks));
        assert!(render("A", &stacks).ends_with("}\n"));
    }
}
