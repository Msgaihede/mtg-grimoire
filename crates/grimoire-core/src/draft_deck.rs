//! **A drafted pool as a virtual Limited deck** — the Draft & Packs page's deck
//! (`docs/superpowers/specs/2026-10-29-draft-and-packs-design.md` §5, §4a).
//!
//! **A deck like any other, made by the deck writes that already exist**: [`create_deck`] makes
//! it virtual (no cardboard, no group, nothing in the collection — the owner's rule) in format
//! `limited`, and [`commit_import`] files the pool, so the history drawer opens on one `add` row
//! as it does after any import. **Pool** is the deck's own Sideboard renamed — a list holds one
//! `side` pile (`idx_deck_categories_kind`), and in Limited the sideboard is the pool the deck was
//! not built from — and holds the cards the reader sent to their sideboard while picking.
//!
//! **The cards sent to the deck while picking** (issue #1471) arrive with the pile the page filed
//! each into ([`DraftDeckCard::pile`] — `autoCategoryFor`, the add path's own rule, which is
//! TypeScript's), and land in those piles, found or made `'auto'` as any auto-filed add's are; the
//! deck's adds are then filed by the same rule (`default_category_id` is
//! [`crate::deck::AUTO_CATEGORY`]), so a basic from the draft bar joins the other lands. A deck with
//! no such card has an empty **Deck** pile instead (`main`, the deck's default, drawn while empty)
//! — the pile a reader drags their first cards out of Pool into.
//!
//! **A Commander draft's deck** (`create`'s `commander`) is made in format `casual` — no 40-card
//! Limited floor; the draft bar checks its 60 cards and its one commander itself — and has a
//! third pile, **Commander** (kind `commander`, empty, a reader's pile so it is drawn while
//! empty), beside Deck and Pool.
//!
//! **Until the reader saves it, it is a draft deck**: it is on the `app_meta` row
//! [`K_DRAFT_DECKS`] (a JSON array; `app_meta` is never synced), which is what the editor asks to
//! draw its draft bar instead of the card search. [`keep`] takes it off; [`discard`] deletes it.
//!
//! **An entry names a deck by its id *and* its `sync_uid`, and both must still match** (issue
//! #1467). `decks.id` is `INTEGER PRIMARY KEY` without `AUTOINCREMENT`, so SQLite hands the next
//! deck `max(id) + 1` — a draft deck deleted from the gallery (the newest deck, so the highest
//! id) gave its id to the next deck the reader made, and a list of bare ids then called that
//! ordinary deck a draft deck: the editor drew the draft bar on it, and its **Discard** deleted
//! it. The uid is the row's own name and is never reused, so [`ids`] answers only an entry whose
//! deck still carries it, and [`discard`] refuses any other. A legacy entry — a bare id, from
//! before the uid was stored — cannot be told from a reused id and is dropped: the safe
//! direction, since a draft deck left unsaved then is still a deck, only without its draft bar.
//!
//! Every write here takes `&Connection`; the host wraps each in `state::with_write`. Each step
//! is one of the deck module's own transactions, so [`create`] is not one transaction: a step
//! that fails after the deck exists deletes the deck again, and the reader is told one sentence.
use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::app_meta::{get_app_meta, set_app_meta};
use crate::deck::{
    create_deck, delete_deck, DeckInput, DeckRow, AUTO_CATEGORY, K_LAST_DECK_FORMAT,
};
use crate::import::{commit_import, ImportItem};

/// The list a draft deck's cards are in — the deck's `live` one.
const LIVE: &str = crate::schema::DECK_VARIANTS[0];

/// The `app_meta` key holding the unsaved draft decks, as [`DraftDeckRef`]s.
pub const K_DRAFT_DECKS: &str = "draft_decks";

/// One unsaved draft deck: its id, and the `decks.sync_uid` it had when the draft made it.
///
/// **The pair is the identity, never the id alone** — see the module's note on issue #1467. Both
/// the stored row and `draft_deck_ids`' answer have this shape, mirrored in
/// `packages/ui/lib/ipc/draft.ts`, so the editor can check the deck it has open against the uid
/// too, and a stale cached list can never name a deck that took a deleted draft deck's id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftDeckRef {
    pub id: i64,
    pub sync_uid: String,
}

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

/// What a deck card filed into one of the deck's zones says — the page files a deck card into a
/// `main` pile, and a zone's name would put it in that zone instead.
pub const NOT_A_DECK_PILE: &str =
    "A card for the deck was filed into the sideboard or another zone, so no deck was made.";

/// One card the reader sent to the deck while picking, and the pile the page filed it into.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftDeckCard {
    pub card_id: String,
    /// A `main` pile's name — `autoCategoryFor`'s answer for the card. Never a zone's.
    pub pile: String,
}

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

/// Make the draft deck `name` holding `card_ids` (a repeated id is that many copies) in Pool and
/// each of `deck` in its own pile, and put it on [`K_DRAFT_DECKS`]. An id this corpus lacks, and a
/// token printing, is skipped; a pool with nothing left is [`NO_CARDS`]. A `deck` card filed into
/// a zone's name ([`crate::schema::PREDEFINED_CATEGORIES`], [`POOL_PILE`], [`COMMANDER_PILE`]) is
/// [`NOT_A_DECK_PILE`], refused before anything is made. With `commander` — a Commander draft's
/// pool — the deck is [`CASUAL`] rather than [`LIMITED`] and has an empty [`COMMANDER_PILE`] too.
///
/// [`create_deck`] remembers the format a deck was made in for the New deck dialog; a draft deck
/// is not the reader choosing Limited, so the remembered format is put back as it was.
pub fn create(
    conn: &Connection,
    name: &str,
    card_ids: &[String],
    deck: &[DraftDeckCard],
    commander: bool,
) -> Result<DeckRow, String> {
    if deck.iter().any(|c| is_a_zone(&c.pile)) {
        return Err(NOT_A_DECK_PILE.to_owned());
    }
    let mut counted: BTreeMap<(&str, &str), i64> = BTreeMap::new();
    for id in card_ids {
        *counted.entry((POOL_PILE, id.as_str())).or_default() += 1;
    }
    for card in deck {
        *counted
            .entry((card.pile.trim(), card.card_id.as_str()))
            .or_default() += 1;
    }
    let mut items = Vec::with_capacity(counted.len());
    for ((pile, id), quantity) in counted {
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
            category_name: pile.to_owned(),
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

    let filed = items.iter().any(|item| item.category_name != POOL_PILE);
    let filled = piles(conn, deck.id, commander, filed)
        .and_then(|()| commit_import(conn, deck.id, LIVE, "merge", &items).map(|_| ()))
        .and_then(|()| {
            if filed {
                pool_last(conn, deck.id)
            } else {
                Ok(())
            }
        })
        .and_then(|()| uid_of(conn, deck.id))
        .and_then(|sync_uid| {
            // Only the entries still naming their deck are carried: a stale one — a draft deck
            // deleted from the gallery — is dropped here rather than left to match a later deck.
            let mut list: Vec<DraftDeckRef> = live(conn)
                .into_iter()
                .filter(|entry| entry.id != deck.id)
                .collect();
            list.push(DraftDeckRef {
                id: deck.id,
                sync_uid,
            });
            write_list(conn, &list)
        });
    if let Err(e) = filled {
        let _ = delete_deck(conn, deck.id);
        return Err(e);
    }
    crate::deck::read_deck(conn, deck.id)?.ok_or_else(|| crate::deck::GONE.to_owned())
}

/// Whether `name` is a zone's — a pile a deck card must never be filed into by name, since the
/// find-or-create the import runs matches a name whatever its kind.
fn is_a_zone(name: &str) -> bool {
    let name = name.trim();
    name == POOL_PILE
        || name == COMMANDER_PILE
        || crate::schema::PREDEFINED_CATEGORIES
            .iter()
            .any(|(_, zone, _)| *zone == name)
}

/// The Sideboard renamed Pool, and — with no card `filed` into the deck — an empty Deck pile in
/// front as the deck's default; with one, adds are filed by the rule ([`AUTO_CATEGORY`]) instead.
/// Straight to the columns, in one transaction: `rename_category` refuses a predefined zone's
/// name, and a fresh deck has no history these need to be undone from. With `commander`, the
/// deck's Commander zone (seeded with every deck) is made sure of: named [`COMMANDER_PILE`],
/// active, and the reader's (`origin = 'user'`, drawn while empty) — or made, should it be missing.
fn piles(conn: &Connection, deck_id: i64, commander: bool, filed: bool) -> Result<(), String> {
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
    if filed {
        tx.execute(
            "UPDATE decks SET default_category_id = ?2 WHERE id = ?1",
            params![deck_id, AUTO_CATEGORY],
        )
        .map_err(|e| e.to_string())?;
        return tx.commit().map_err(|e| e.to_string());
    }
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

/// Pool after every pile the import made, so the deck's piles read before its sideboard.
fn pool_last(conn: &Connection, deck_id: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE deck_categories
            SET sort_order = (SELECT max(sort_order) + 1 FROM deck_categories
                               WHERE deck_id = ?1 AND variant = ?2)
          WHERE deck_id = ?1 AND variant = ?2 AND kind = 'side'",
        params![deck_id, LIVE],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// The deck's `sync_uid`, minted first should it have none.
///
/// The capture trigger mints one on every insert (`sync_engine::capture`), so on a real database
/// this only reads; the mint is `schema::mint_missing_uids`' statement for one row, the belt for a
/// file the trigger was not on (a test's bare schema, a write made while a sync apply is under
/// way). The update trigger's `OF` list does not name the column, so the mint records no op.
fn uid_of(conn: &Connection, deck_id: i64) -> Result<String, String> {
    conn.execute(
        "UPDATE decks SET sync_uid = lower(hex(randomblob(16)))
          WHERE id = ?1 AND sync_uid IS NULL",
        params![deck_id],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT sync_uid FROM decks WHERE id = ?1",
        params![deck_id],
        |r| r.get::<_, String>(0),
    )
    .map_err(|e| e.to_string())
}

/// The entries on [`K_DRAFT_DECKS`], as stored. **Reading can never fail**: a missing row or one
/// that is not a JSON array is an empty list, and an element that is not a `{ id, syncUid }`
/// object — a legacy bare id among them (see the module's note) — is dropped on its own.
fn listed(conn: &Connection) -> Vec<DraftDeckRef> {
    let Some(serde_json::Value::Array(items)) = get_app_meta(conn, K_DRAFT_DECKS)
        .and_then(|v| serde_json::from_str::<serde_json::Value>(&v).ok())
    else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter_map(|item| serde_json::from_value::<DraftDeckRef>(item).ok())
        .filter(|entry| entry.id > 0 && !entry.sync_uid.is_empty())
        .collect()
}

fn write_list(conn: &Connection, list: &[DraftDeckRef]) -> Result<(), String> {
    let json = serde_json::to_string(list).map_err(|e| e.to_string())?;
    set_app_meta(conn, K_DRAFT_DECKS, &json).map_err(|e| e.to_string())
}

/// Whether the deck `entry.id` exists **and still carries `entry.sync_uid`** — the one test an
/// entry has to pass to count. A deck that took a deleted draft deck's id has a uid of its own.
fn names_its_deck(conn: &Connection, entry: &DraftDeckRef) -> bool {
    conn.query_row(
        "SELECT 1 FROM decks WHERE id = ?1 AND sync_uid = ?2",
        params![entry.id, entry.sync_uid],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// The stored entries that still name their deck, oldest first.
fn live(conn: &Connection) -> Vec<DraftDeckRef> {
    listed(conn)
        .into_iter()
        .filter(|entry| names_its_deck(conn, entry))
        .collect()
}

/// The unsaved draft decks that still exist with the uid they were made with, oldest first. A
/// read: an entry whose deck was deleted elsewhere — or whose id a later deck took — is left out
/// here and dropped from the row at the next write.
pub fn ids(conn: &Connection) -> Vec<DraftDeckRef> {
    live(conn)
}

/// Whether `deck_id` is an unsaved draft deck now — on the list, with its uid matching.
pub fn is_draft_deck(conn: &Connection, deck_id: i64) -> bool {
    live(conn).iter().any(|entry| entry.id == deck_id)
}

/// Save the draft deck: off the list, a deck like any other from now on. A deck not on the
/// list is already that, and is no error.
pub fn keep(conn: &Connection, deck_id: i64) -> Result<(), String> {
    let list: Vec<DraftDeckRef> = live(conn)
        .into_iter()
        .filter(|entry| entry.id != deck_id)
        .collect();
    write_list(conn, &list)
}

/// Delete the draft deck and take it off the list. Refused with [`NOT_A_DRAFT_DECK`] for a deck
/// the list does not hold **with its uid** ([`is_draft_deck`]), so neither a stale page nor a
/// stale entry whose id a later deck took can ever delete a saved deck (issue #1467).
pub fn discard(conn: &Connection, deck_id: i64) -> Result<(), String> {
    if !is_draft_deck(conn, deck_id) {
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

    fn exists(conn: &Connection, deck_id: i64) -> bool {
        conn.query_row("SELECT 1 FROM decks WHERE id = ?1", [deck_id], |_| Ok(()))
            .optional()
            .unwrap()
            .is_some()
    }

    /// [`ids`]' deck ids alone, for the tests that ask only which decks are listed.
    fn listed_ids(conn: &Connection) -> Vec<i64> {
        ids(conn).into_iter().map(|entry| entry.id).collect()
    }

    fn pool() -> Vec<String> {
        ["bolt", "angel", "bolt", "ghost", "treasure"]
            .map(String::from)
            .to_vec()
    }

    #[test]
    fn create_makes_a_virtual_limited_deck_with_the_pool_in_its_side_pile() {
        let conn = conn();
        let deck = create(&conn, "HOB draft", &pool(), &[], false).unwrap();
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
        assert_eq!(listed_ids(&conn), vec![deck.id]);
        assert_eq!(get_app_meta(&conn, K_LAST_DECK_FORMAT), None);
    }

    #[test]
    fn a_commander_drafts_deck_is_casual_with_an_empty_commander_pile() {
        let conn = conn();
        let deck = create(&conn, "CMR draft", &pool(), &[], true).unwrap();
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
                (
                    "Commander".into(),
                    "commander".into(),
                    true,
                    "user".into(),
                    0
                ),
                ("Pool".into(), "side".into(), true, "user".into(), 2),
            ],
            "Deck first, the Commander pile empty and drawn while empty, the pool in Pool"
        );
        assert_eq!(listed_ids(&conn), vec![deck.id]);

        // Without it, the deck is Limited.
        let limited = create(&conn, "HOB draft", &pool(), &[], false).unwrap();
        assert_eq!(limited.format_key, LIMITED);
    }

    fn to_deck(card_id: &str, pile: &str) -> DraftDeckCard {
        DraftDeckCard {
            card_id: card_id.to_owned(),
            pile: pile.to_owned(),
        }
    }

    #[test]
    fn cards_sent_to_the_deck_land_in_their_piles_and_the_sideboard_in_pool() {
        let conn = conn();
        let deck = create(
            &conn,
            "HOB draft",
            &["bolt".to_string()],
            &[
                to_deck("angel", "Creature"),
                to_deck("bolt", "Removal"),
                to_deck("bolt", "Removal"),
                to_deck("ghost", "Creature"),
            ],
            false,
        )
        .unwrap();

        let rows: Vec<(String, String, String, String, i64)> = conn
            .prepare(
                "SELECT dc.card_id, cat.name, cat.kind, cat.origin, dc.quantity FROM deck_cards dc
                   JOIN deck_categories cat ON cat.id = dc.category_id
                  WHERE dc.deck_id = ?1 AND dc.variant = 'live' ORDER BY cat.sort_order",
            )
            .unwrap()
            .query_map([deck.id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            rows,
            vec![
                (
                    "angel".into(),
                    "Creature".into(),
                    "main".into(),
                    "auto".into(),
                    1
                ),
                (
                    "bolt".into(),
                    "Removal".into(),
                    "main".into(),
                    "auto".into(),
                    2
                ),
                (
                    "bolt".into(),
                    "Pool".into(),
                    "side".into(),
                    "user".into(),
                    1
                ),
            ],
            "each deck card in its pile, the sideboard's in Pool after them, the unknown skipped"
        );

        let default: i64 = conn
            .query_row(
                "SELECT default_category_id FROM decks WHERE id = ?1",
                [deck.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(default, AUTO_CATEGORY, "adds are filed by the rule");
        let deck_piles: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_categories WHERE deck_id = ?1 AND name = ?2",
                params![deck.id, DECK_PILE],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(deck_piles, 0, "no empty Deck pile beside the filed ones");
    }

    #[test]
    fn a_deck_card_filed_into_a_zone_makes_no_deck() {
        let conn = conn();
        for zone in ["Sideboard", "Pool", " Commander ", "Maybeboard"] {
            let err = create(&conn, "x", &pool(), &[to_deck("angel", zone)], false).unwrap_err();
            assert_eq!(err, NOT_A_DECK_PILE, "{zone}");
        }
        let decks: i64 = conn
            .query_row("SELECT count(*) FROM decks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(decks, 0);
    }

    #[test]
    fn a_pool_the_corpus_does_not_know_makes_no_deck() {
        let conn = conn();
        let err = create(&conn, "x", &["ghost".to_string()], &[], false).unwrap_err();
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
        create(&conn, "x", &pool(), &[], false).unwrap();
        assert_eq!(
            get_app_meta(&conn, K_LAST_DECK_FORMAT).as_deref(),
            Some("modern")
        );
    }

    #[test]
    fn keep_and_discard_take_a_deck_off_the_list() {
        let conn = conn();
        let a = create(&conn, "a", &pool(), &[], false).unwrap().id;
        let b = create(&conn, "b", &pool(), &[], false).unwrap().id;
        let c = create(&conn, "c", &pool(), &[], false).unwrap().id;
        assert_eq!(listed_ids(&conn), vec![a, b, c]);

        keep(&conn, a).unwrap();
        assert_eq!(listed_ids(&conn), vec![b, c]);
        assert!(exists(&conn, a), "a kept deck stays");
        assert_eq!(discard(&conn, a).unwrap_err(), NOT_A_DRAFT_DECK);
        assert!(exists(&conn, a));

        discard(&conn, b).unwrap();
        assert!(!exists(&conn, b));
        assert_eq!(listed_ids(&conn), vec![c]);

        delete_deck(&conn, c).unwrap();
        assert!(
            ids(&conn).is_empty(),
            "a deck deleted elsewhere is not listed"
        );
    }

    /// A deck the reader makes after a draft deck was deleted from the gallery.
    fn ordinary_deck(conn: &Connection, name: &str) -> i64 {
        let id = create_deck(
            conn,
            &DeckInput {
                name: name.to_owned(),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        // The capture trigger's mint, which this bare schema does not carry.
        uid_of(conn, id).unwrap();
        id
    }

    #[test]
    fn every_entry_carries_its_decks_uid() {
        let conn = conn();
        let deck = create(&conn, "a", &pool(), &[], false).unwrap();
        let uid: String = conn
            .query_row("SELECT sync_uid FROM decks WHERE id = ?1", [deck.id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(uid.len(), 32, "minted when the deck had none");
        assert_eq!(
            ids(&conn),
            vec![DraftDeckRef {
                id: deck.id,
                sync_uid: uid.clone()
            }]
        );
        assert_eq!(
            get_app_meta(&conn, K_DRAFT_DECKS).unwrap(),
            format!(r#"[{{"id":{},"syncUid":"{uid}"}}]"#, deck.id),
            "the row's shape is the wire's"
        );
    }

    /// Issue #1467: a draft deck deleted from the gallery gave its id to the next deck the reader
    /// made, and that ordinary deck opened with the draft bar — and its Discard deleted it.
    #[test]
    fn a_deck_that_takes_a_deleted_draft_decks_id_is_never_a_draft_deck() {
        let conn = conn();
        let draft = create(&conn, "draft", &pool(), &[], false).unwrap().id;
        delete_deck(&conn, draft).unwrap();

        let mine = ordinary_deck(&conn, "My deck");
        assert_eq!(
            mine, draft,
            "SQLite reuses the highest deleted id — the premise"
        );
        assert!(!is_draft_deck(&conn, mine));
        assert!(ids(&conn).is_empty());

        assert_eq!(discard(&conn, mine).unwrap_err(), NOT_A_DRAFT_DECK);
        assert!(
            exists(&conn, mine),
            "Discard never deletes an ordinary deck"
        );

        // The next write drops the stale entry rather than carrying it.
        let next = create(&conn, "next", &pool(), &[], false).unwrap().id;
        assert_eq!(listed_ids(&conn), vec![next]);
        assert_eq!(listed(&conn).len(), 1);
    }

    #[test]
    fn a_legacy_list_of_bare_ids_names_no_draft_deck() {
        let conn = conn();
        let mine = ordinary_deck(&conn, "My deck");
        set_app_meta(&conn, K_DRAFT_DECKS, &format!("[{mine}]")).unwrap();
        assert!(ids(&conn).is_empty());
        assert!(!is_draft_deck(&conn, mine));
        assert_eq!(discard(&conn, mine).unwrap_err(), NOT_A_DRAFT_DECK);
        assert!(exists(&conn, mine));

        // A bare id beside a real entry costs only itself.
        let draft = create(&conn, "draft", &pool(), &[], false).unwrap().id;
        assert_eq!(listed_ids(&conn), vec![draft]);
        for junk in ["not json", "{}", r#"[{"id":"x"},null,7]"#] {
            set_app_meta(&conn, K_DRAFT_DECKS, junk).unwrap();
            assert!(ids(&conn).is_empty(), "{junk}");
        }
    }

    #[test]
    fn an_entry_whose_uid_no_longer_matches_is_not_listed() {
        let conn = conn();
        let draft = create(&conn, "draft", &pool(), &[], false).unwrap().id;
        conn.execute(
            "UPDATE decks SET sync_uid = 'someone-else' WHERE id = ?1",
            [draft],
        )
        .unwrap();
        assert!(!is_draft_deck(&conn, draft));
        assert_eq!(discard(&conn, draft).unwrap_err(), NOT_A_DRAFT_DECK);
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
