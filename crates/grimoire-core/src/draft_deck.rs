//! **A drafted pool as a virtual Limited deck** — the Draft & Packs page's deck
//! (`docs/superpowers/specs/2026-10-29-draft-and-packs-design.md` §5, §4a).
//!
//! **A deck like any other, made by the deck writes that already exist**: [`create_deck`] makes
//! it virtual (no cardboard, no group, nothing in the collection — the owner's rule) in format
//! `limited`, and [`commit_import`] files the pool, so the history drawer opens on one `add` row
//! as it does after any import. Two piles: **Deck**, an empty `main` pile that is the deck's
//! default, and **Pool**, the deck's own Sideboard renamed — a list holds one `side` pile
//! (`idx_deck_categories_kind`), and in Limited the pool *is* the sideboard.
//!
//! **A Commander draft's deck** (`create`'s `commander`) is made in format `casual` — no 40-card
//! Limited floor; the draft bar checks its 60 cards and its one commander itself — and has a
//! third pile, **Commander** (kind `commander`, empty, a reader's pile so it is drawn while
//! empty), beside Deck and Pool.
//!
//! **Until the reader saves it, it is a draft deck**: its id is on the `app_meta` row
//! [`K_DRAFT_DECKS`] (a JSON array; `app_meta` is never synced), which is what the editor asks to
//! draw its draft bar instead of the card search. [`keep`] takes it off; [`discard`] deletes it.
//!
//! Every write here takes `&Connection`; the host wraps each in `state::with_write`. Each step
//! is one of the deck module's own transactions, so [`create`] is not one transaction: a step
//! that fails after the deck exists deletes the deck again, and the reader is told one sentence.
use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::app_meta::{get_app_meta, set_app_meta};
use crate::deck::{create_deck, delete_deck, DeckInput, DeckRow, K_LAST_DECK_FORMAT};
use crate::import::{commit_import, ImportItem};

/// The list a draft deck's cards are in — the deck's `live` one.
const LIVE: &str = crate::schema::DECK_VARIANTS[0];

/// The `app_meta` key holding the unsaved draft decks' ids.
pub const K_DRAFT_DECKS: &str = "draft_decks";

/// The format a draft deck is made in.
pub const LIMITED: &str = "limited";

/// The format a Commander draft's deck is made in: the deck module's own default, `casual`.
pub const CASUAL: &str = crate::deck::DEFAULT_FORMAT;

/// The piles' names.
pub const DECK_PILE: &str = "Deck";
pub const POOL_PILE: &str = "Pool";
pub const COMMANDER_PILE: &str = "Commander";

/// What a pool none of whose cards this corpus knows says.
pub const NO_CARDS: &str =
    "None of the drafted cards are in this app's card data, so no deck was made.";

/// What [`discard`] says of a deck that is not an unsaved draft deck.
pub const NOT_A_DRAFT_DECK: &str = "That deck is not an unsaved draft deck, so it was not deleted.";

/// One basic land for the draft bar's strip, in the printing it adds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BasicLand {
    /// `W`, `U`, `B`, `R` or `G`.
    pub color: String,
    pub name: String,
    pub card_id: String,
}

/// The five basics, in WUBRG order.
const BASICS: [(&str, &str); 5] = [
    ("W", "Plains"),
    ("U", "Island"),
    ("B", "Swamp"),
    ("R", "Mountain"),
    ("G", "Forest"),
];

/// Make the draft deck `name` holding `card_ids` (a repeated id is that many copies) in Pool,
/// and put it on [`K_DRAFT_DECKS`]. An id this corpus lacks, and a token printing, is skipped;
/// a pool with nothing left is [`NO_CARDS`]. With `commander` — a Commander draft's pool — the
/// deck is [`CASUAL`] rather than [`LIMITED`] and has an empty [`COMMANDER_PILE`] too.
///
/// [`create_deck`] remembers the format a deck was made in for the New deck dialog; a draft deck
/// is not the reader choosing Limited, so the remembered format is put back as it was.
pub fn create(
    conn: &Connection,
    name: &str,
    card_ids: &[String],
    commander: bool,
) -> Result<DeckRow, String> {
    let mut counted: BTreeMap<&str, i64> = BTreeMap::new();
    for id in card_ids {
        *counted.entry(id.as_str()).or_default() += 1;
    }
    let mut items = Vec::with_capacity(counted.len());
    for (id, quantity) in counted {
        let known: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM cards WHERE id = ?1)",
                params![id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !known || crate::deck_tokens::printing_is_token(conn, id)? {
            continue;
        }
        items.push(ImportItem {
            card_id: id.to_owned(),
            quantity,
            category_name: POOL_PILE.to_owned(),
            inactive: false,
            finish: None,
            label_name: None,
            label_color: None,
        });
    }
    if items.is_empty() {
        return Err(NO_CARDS.to_owned());
    }

    let remembered = get_app_meta(conn, K_LAST_DECK_FORMAT);
    let deck = create_deck(
        conn,
        &DeckInput {
            name: name.to_owned(),
            format_key: if commander { CASUAL } else { LIMITED }.to_owned(),
            virtual_only: Some(true),
            ..Default::default()
        },
    )?;
    let restored = match &remembered {
        Some(format) => set_app_meta(conn, K_LAST_DECK_FORMAT, format),
        None => conn
            .execute(
                "DELETE FROM app_meta WHERE key = ?1",
                params![K_LAST_DECK_FORMAT],
            )
            .map(|_| ()),
    };
    // A preference lost is not worth the deck — `create_deck`'s own rule for this row.
    let _ = restored;

    let filled = piles(conn, deck.id, commander)
        .and_then(|()| commit_import(conn, deck.id, LIVE, "merge", &items).map(|_| ()))
        .and_then(|()| {
            let mut list = listed(conn);
            list.push(deck.id);
            write_list(conn, &list)
        });
    if let Err(e) = filled {
        let _ = delete_deck(conn, deck.id);
        return Err(e);
    }
    crate::deck::read_deck(conn, deck.id)?.ok_or_else(|| crate::deck::GONE.to_owned())
}

/// The Sideboard renamed Pool, and an empty Deck pile in front as the deck's default — straight
/// to the columns, in one transaction: `rename_category` refuses a predefined zone's name, and a
/// fresh deck has no history these two need to be undone from. With `commander`, the deck's
/// Commander zone (seeded with every deck) is made sure of: named [`COMMANDER_PILE`], active,
/// and the reader's (`origin = 'user'`, drawn while empty) — or made, should it be missing.
fn piles(conn: &Connection, deck_id: i64, commander: bool) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if commander {
        let found = tx
            .execute(
                "UPDATE deck_categories SET name = ?2, is_active = 1, origin = 'user',
                        updated_at = unixepoch()
                  WHERE deck_id = ?1 AND variant = ?3 AND kind = 'commander'",
                params![deck_id, COMMANDER_PILE, LIVE],
            )
            .map_err(|e| e.to_string())?;
        if found == 0 {
            tx.execute(
                "INSERT INTO deck_categories
                    (deck_id, variant, name, kind, is_active, sort_order, origin,
                     created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'commander', 1,
                         (SELECT coalesce(max(sort_order), -1) + 1 FROM deck_categories
                           WHERE deck_id = ?1 AND variant = ?2),
                         'user', unixepoch(), unixepoch())",
                params![deck_id, LIVE, COMMANDER_PILE],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.execute(
        "UPDATE deck_categories SET name = ?2, updated_at = unixepoch()
          WHERE deck_id = ?1 AND variant = ?3 AND kind = 'side'",
        params![deck_id, POOL_PILE, LIVE],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE deck_categories SET sort_order = sort_order + 1
          WHERE deck_id = ?1 AND variant = ?2",
        params![deck_id, LIVE],
    )
    .map_err(|e| e.to_string())?;
    let pile: i64 = tx
        .query_row(
            "INSERT INTO deck_categories
                (deck_id, variant, name, kind, is_active, sort_order, origin,
                 created_at, updated_at)
             VALUES (?1, ?2, ?3, 'main', 1, 0, 'user', unixepoch(), unixepoch())
             RETURNING id",
            params![deck_id, LIVE, DECK_PILE],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE decks SET default_category_id = ?2 WHERE id = ?1",
        params![deck_id, pile],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// The ids on [`K_DRAFT_DECKS`], as stored. A missing or unreadable row is an empty list.
fn listed(conn: &Connection) -> Vec<i64> {
    get_app_meta(conn, K_DRAFT_DECKS)
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default()
}

fn write_list(conn: &Connection, ids: &[i64]) -> Result<(), String> {
    let json = serde_json::to_string(ids).map_err(|e| e.to_string())?;
    set_app_meta(conn, K_DRAFT_DECKS, &json).map_err(|e| e.to_string())
}

fn exists(conn: &Connection, deck_id: i64) -> bool {
    conn.query_row(
        "SELECT 1 FROM decks WHERE id = ?1",
        params![deck_id],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// The unsaved draft decks that still exist, oldest first. A read: a deck deleted elsewhere is
/// left out here and dropped from the row at the next write.
pub fn ids(conn: &Connection) -> Vec<i64> {
    listed(conn)
        .into_iter()
        .filter(|id| exists(conn, *id))
        .collect()
}

/// Save the draft deck: off the list, a deck like any other from now on. A deck not on the
/// list is already that, and is no error.
pub fn keep(conn: &Connection, deck_id: i64) -> Result<(), String> {
    let list: Vec<i64> = ids(conn).into_iter().filter(|id| *id != deck_id).collect();
    write_list(conn, &list)
}

/// Delete the draft deck and take it off the list. Refused with [`NOT_A_DRAFT_DECK`] for a deck
/// the list does not hold, so a stale page can never delete a saved deck.
pub fn discard(conn: &Connection, deck_id: i64) -> Result<(), String> {
    if !listed(conn).contains(&deck_id) {
        return Err(NOT_A_DRAFT_DECK.to_owned());
    }
    delete_deck(conn, deck_id)?;
    keep(conn, deck_id)
}

/// For each of W U B R G, a paper English printing of its basic land in the first of
/// `set_codes` that has one, else the newest one in the corpus; a regular frame before a full-art
/// one and a non-promo before a promo, then the lowest collector number. A colour the corpus
/// has no printing of is left out.
pub fn basic_lands(conn: &Connection, set_codes: &[String]) -> Result<Vec<BasicLand>, String> {
    const PAPER_BASIC: &str = "name = ?1 AND lang = 'en' AND is_paper = 1 AND digital = 0
                               AND type_line LIKE 'Basic Land%'";
    const PLAINEST: &str = "full_art, promo, CAST(collector_number AS INTEGER), collector_number";
    let mut in_set = conn
        .prepare(&format!(
            "SELECT id FROM cards WHERE {PAPER_BASIC} AND set_code = ?2
              ORDER BY {PLAINEST} LIMIT 1"
        ))
        .map_err(|e| e.to_string())?;
    let mut newest = conn
        .prepare(&format!(
            "SELECT id FROM cards WHERE {PAPER_BASIC}
              ORDER BY released_at IS NULL, released_at DESC, {PLAINEST} LIMIT 1"
        ))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(BASICS.len());
    for (color, name) in BASICS {
        let mut found = None;
        for set in set_codes {
            found = in_set
                .query_row(params![name, set.to_lowercase()], |r| r.get::<_, String>(0))
                .optional()
                .map_err(|e| e.to_string())?;
            if found.is_some() {
                break;
            }
        }
        if found.is_none() {
            found = newest
                .query_row(params![name], |r| r.get::<_, String>(0))
                .optional()
                .map_err(|e| e.to_string())?;
        }
        if let Some(card_id) = found {
            out.push(BasicLand {
                color: color.to_owned(),
                name: name.to_owned(),
                card_id,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute_batch(
            "INSERT INTO cards (id,name,lang,set_code,collector_number,rarity,layout,type_line,
                                colors,raw)
             VALUES ('bolt','Lightning Bolt','en','tst','1','common','normal','Instant','R','{}'),
                    ('angel','Serra Angel','en','tst','2','uncommon','normal',
                     'Creature — Angel','W','{}'),
                    ('treasure','Treasure','en','ttst','3','common','token',
                     'Token Artifact — Treasure','','{}');",
        )
        .unwrap();
        conn
    }

    fn pool() -> Vec<String> {
        ["bolt", "angel", "bolt", "ghost", "treasure"]
            .map(String::from)
            .to_vec()
    }

    #[test]
    fn create_makes_a_virtual_limited_deck_with_the_pool_in_its_side_pile() {
        let conn = conn();
        let deck = create(&conn, "HOB draft", &pool(), false).unwrap();
        assert_eq!(deck.name, "HOB draft");
        assert_eq!(deck.format_key, LIMITED);
        assert!(deck.virtual_only);

        let rows: Vec<(String, String, String, i64)> = conn
            .prepare(
                "SELECT dc.card_id, cat.name, cat.kind, dc.quantity FROM deck_cards dc
                   JOIN deck_categories cat ON cat.id = dc.category_id
                  WHERE dc.deck_id = ?1 AND dc.variant = 'live' ORDER BY dc.card_id",
            )
            .unwrap()
            .query_map([deck.id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            rows,
            vec![
                ("angel".into(), "Pool".into(), "side".into(), 1),
                ("bolt".into(), "Pool".into(), "side".into(), 2),
            ],
            "duplicates count, the unknown id and the token are skipped"
        );

        let (main, name): (i64, String) = conn
            .query_row(
                "SELECT d.default_category_id, cat.name FROM decks d
                   JOIN deck_categories cat ON cat.id = d.default_category_id
                  WHERE d.id = ?1 AND cat.kind = 'main'",
                [deck.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(main > 0);
        assert_eq!(name, DECK_PILE);

        let owned: i64 = conn
            .query_row(
                "SELECT (SELECT count(*) FROM collection_entries)
                      + (SELECT count(*) FROM collection_folders WHERE deck_id = ?1)",
                [deck.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(owned, 0, "nothing in the collection, no group");
        assert_eq!(ids(&conn), vec![deck.id]);
        assert_eq!(get_app_meta(&conn, K_LAST_DECK_FORMAT), None);
    }

    #[test]
    fn a_commander_drafts_deck_is_casual_with_an_empty_commander_pile() {
        let conn = conn();
        let deck = create(&conn, "CMR draft", &pool(), true).unwrap();
        assert_eq!(deck.format_key, CASUAL);
        assert_eq!(CASUAL, "casual");
        assert!(deck.virtual_only);

        let piles: Vec<(String, String, bool, String, i64)> = conn
            .prepare(
                "SELECT cat.name, cat.kind, cat.is_active, cat.origin,
                        (SELECT count(*) FROM deck_cards dc WHERE dc.category_id = cat.id)
                   FROM deck_categories cat
                  WHERE cat.deck_id = ?1 AND cat.variant = 'live'
                    AND cat.kind IN ('main', 'side', 'commander')
                  ORDER BY cat.sort_order",
            )
            .unwrap()
            .query_map([deck.id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            piles,
            vec![
                ("Deck".into(), "main".into(), true, "user".into(), 0),
                ("Commander".into(), "commander".into(), true, "user".into(), 0),
                ("Pool".into(), "side".into(), true, "user".into(), 2),
            ],
            "Deck first, the Commander pile empty and drawn while empty, the pool in Pool"
        );
        assert_eq!(ids(&conn), vec![deck.id]);

        // Without it, the deck is Limited.
        let limited = create(&conn, "HOB draft", &pool(), false).unwrap();
        assert_eq!(limited.format_key, LIMITED);
    }

    #[test]
    fn a_pool_the_corpus_does_not_know_makes_no_deck() {
        let conn = conn();
        let err = create(&conn, "x", &["ghost".to_string()], false).unwrap_err();
        assert_eq!(err, NO_CARDS);
        let decks: i64 = conn
            .query_row("SELECT count(*) FROM decks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(decks, 0);
    }

    #[test]
    fn the_remembered_format_survives_a_draft_deck() {
        let conn = conn();
        set_app_meta(&conn, K_LAST_DECK_FORMAT, "modern").unwrap();
        create(&conn, "x", &pool(), false).unwrap();
        assert_eq!(
            get_app_meta(&conn, K_LAST_DECK_FORMAT).as_deref(),
            Some("modern")
        );
    }

    #[test]
    fn keep_and_discard_take_a_deck_off_the_list() {
        let conn = conn();
        let a = create(&conn, "a", &pool(), false).unwrap().id;
        let b = create(&conn, "b", &pool(), false).unwrap().id;
        let c = create(&conn, "c", &pool(), false).unwrap().id;
        assert_eq!(ids(&conn), vec![a, b, c]);

        keep(&conn, a).unwrap();
        assert_eq!(ids(&conn), vec![b, c]);
        assert!(exists(&conn, a), "a kept deck stays");
        assert_eq!(discard(&conn, a).unwrap_err(), NOT_A_DRAFT_DECK);
        assert!(exists(&conn, a));

        discard(&conn, b).unwrap();
        assert!(!exists(&conn, b));
        assert_eq!(ids(&conn), vec![c]);

        delete_deck(&conn, c).unwrap();
        assert!(
            ids(&conn).is_empty(),
            "a deck deleted elsewhere is not listed"
        );
    }

    #[test]
    fn basics_come_from_the_drafts_set_first_then_the_newest_printing() {
        let conn = conn();
        conn.execute_batch(
            "INSERT INTO cards (id,name,lang,set_code,collector_number,layout,type_line,
                                released_at,full_art,is_paper,raw)
             VALUES ('plains-old','Plains','en','old','250','normal','Basic Land — Plains',
                     '2000-01-01',0,1,'{}'),
                    ('plains-new','Plains','en','new','260','normal','Basic Land — Plains',
                     '2025-01-01',0,1,'{}'),
                    ('plains-new-de','Plains','de','new','260','normal','Basic Land — Plains',
                     '2026-01-01',0,1,'{}'),
                    ('plains-tst-fa','Plains','en','tst','270','normal','Basic Land — Plains',
                     '2024-01-01',1,1,'{}'),
                    ('plains-tst','Plains','en','tst','280','normal','Basic Land — Plains',
                     '2024-01-01',0,1,'{}'),
                    ('island-new','Island','en','new','261','normal','Basic Land — Island',
                     '2025-01-01',0,1,'{}'),
                    ('island-mtgo','Island','en','tst','262','normal','Basic Land — Island',
                     '2026-01-01',0,0,'{}');",
        )
        .unwrap();
        let lands = basic_lands(&conn, &["xyz".into(), "TST".into()]).unwrap();
        assert_eq!(
            lands,
            vec![
                BasicLand {
                    color: "W".into(),
                    name: "Plains".into(),
                    card_id: "plains-tst".into()
                },
                BasicLand {
                    color: "U".into(),
                    name: "Island".into(),
                    card_id: "island-new".into()
                },
            ],
            "the set's regular frame over its full art; a set with none falls back to the \
             newest English paper printing; a colour with none is left out"
        );
        assert_eq!(basic_lands(&conn, &[]).unwrap()[0].card_id, "plains-new");
    }
}
