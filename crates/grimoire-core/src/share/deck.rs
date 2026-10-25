//! A deck's share — its list, read-only, drawn as a deck rather than a binder (issue #1032).
//!
//! ## One namespace, one more key
//!
//! **A share names what it publishes by one opaque string**, `folderUid` on the wire and
//! `collection_shares.folder_uid` in the cache, which neither the relay nor the share Worker reads
//! beyond its shape — [`super::wishlist`]'s argument, and the reason a deck share needs no new
//! column, no schema rung and no new Worker route. It is the key `deck:<decks.sync_uid>`. A
//! collection folder's uid is 32 hex characters and can never begin with `deck:`, and a wishlist
//! key begins with `wishlist:`, so the three cannot collide.
//!
//! **The deck's own uid, never its row id**: `decks.sync_uid` is synced, so a second device in the
//! group resolves the same key to its own copy of the deck and *Update* keeps working there.
//!
//! ## What travels, and what does not
//!
//! **The deck's live list** — its *Actual* — and nothing of the plan beside it. A theory list is a
//! draft the reader has not built, and publishing it unasked is publishing more than the press
//! asked for; the unasked question publishes less here too.
//!
//! **Each pile is a folder of the snapshot**, named as the reader named it and in the reader's
//! order, so a viewer built before decks could be shared draws a deck as a binder with one drawer
//! per pile — a correct reading of the same document rather than a refusal. The pile's role
//! (`main`, `side`, `commander`, `companion`, `maybe`) and its switch ride in [`ShareDeck`], which
//! is what a deck-aware viewer stacks the piles by. A pile with nothing in it does not travel:
//! an empty heading on somebody else's deck is a column nobody can drop a card into.
//!
//! **Three facts about each card travel that a binder's do not** — its type line, its mana cost
//! and its mana value — because a deck is read by them: the stacks group by type and sort by
//! cost, and a viewer with no corpus behind it has no other way to know either.
//!
//! **Absent, and not switches**: the deck's labels, notes, to-dos, tags, description and every
//! `needs_review` sentence. All are the reader's own words about their deck, and the format's rule
//! is that an optional field is a field a future switch can turn on by accident. A card carries no
//! `c` either — a deck row has no condition — so `condition` is dropped from `fields`, as a
//! wishlist share drops it.
//!
//! **The deck and its cards are read by [`crate::integration::projection`]** (spec §7.5), with the
//! SQL the projection reads every deck and every live row with; what stays here is the key, the
//! piles as folders, and the short keys of the wire.

use rusqlite::{params, Connection};
use serde::Serialize;

use super::snapshot::{currency, marketplace_id};
use super::{ShareCard, ShareFields, ShareFolder, ShareSnapshot, SNAPSHOT_VERSION};
use crate::integration::projection::{self, DeckCardScope, DeckScope};
use crate::integration::readable::Unknown;

/// What every deck key begins with — `deckShare.ts`' `DECK_SHARE_PREFIX` and the share Worker's
/// `DECK_PREFIX`, the third spelling of one string.
pub const PREFIX: &str = "deck:";

/// No deck answers to that key — one deleted since it was shared, or one this device has not
/// synced yet.
pub const DECK_NOT_FOUND: &str = "That deck is not in your decks.";

/// The deck half of a deck share — what a deck-aware viewer reads beside the folders.
#[derive(Debug, Serialize)]
pub struct ShareDeck {
    /// The format's display name (`Commander`), or its key when the seed no longer carries it.
    pub format: String,
    /// One per published pile, in the reader's order. `uid` is the pile's folder in
    /// [`ShareSnapshot::folders`].
    pub piles: Vec<SharePile>,
    /// The deck's own cover — the art the gallery draws for it — and the illustrator it is
    /// credited to. **Absent** for a deck with no cover, and for one whose cover printing has no
    /// artist on record: an art crop has no printed frame, so Scryfall's rule — the one
    /// `deckCover.ts`' `coverUrl` keeps — is that it is shown only beside its illustrator's name,
    /// and a cover nobody can credit is a cover nobody draws.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<ShareCover>,
}

/// A deck's cover, as it travels — in a deck share's `deck` and in the projection's `decks` rows.
#[derive(Debug, Clone, Serialize)]
pub struct ShareCover {
    /// The cover printing's `art` crop — the same picture the gallery tile draws.
    pub img: String,
    /// Who painted it. Never absent: see [`ShareDeck::cover`].
    pub artist: String,
}

/// One pile's role. Its name is its folder's.
#[derive(Debug, Serialize)]
pub struct SharePile {
    pub uid: String,
    /// `deck_categories.kind` — the five words the rules read.
    pub kind: String,
    /// `deck_categories.is_active`. A switched-off pile counts toward nothing, the Maybeboard
    /// above all, and a viewer draws it beside the deck rather than in it.
    pub active: bool,
}

/// The deck uid inside a share key, or `None` for a key that is not a deck's.
///
/// **A key with the prefix and nothing after it is still a deck key**, answered
/// [`DECK_NOT_FOUND`] rather than handed to the collection: it is a deck this build cannot find,
/// never a binder.
pub fn parse(raw: &str) -> Option<&str> {
    raw.strip_prefix(PREFIX)
}

/// The pile's folder uid. **Its position, never its row id** — the rule every share keeps: a
/// local id names a row in a database no other device has seen. Positions are stable within one
/// snapshot, which is the only scope a folder uid has.
fn pile_uid(position: usize) -> String {
    format!("pile-{position}")
}

/// Render the deck `uid` names as a snapshot — `super::snapshot`'s twin for decks, with the same
/// arguments and the same purity.
pub fn snapshot(
    conn: &Connection,
    id: &str,
    owner: &str,
    uid: &str,
    fields: ShareFields,
    marketplace: crate::sorting::Marketplace,
    now: i64,
) -> Result<(ShareSnapshot, Unknown), String> {
    let found = projection::decks(conn, DeckScope::Uid(uid))?
        .into_iter()
        .next();
    let found = found.ok_or_else(|| DECK_NOT_FOUND.to_owned())?;
    let deck_id = found.id;

    // A deck row carries no condition; see the module doc.
    let fields = ShareFields {
        condition: false,
        ..fields
    };

    // Every pile of the live list that holds a card, in the reader's order — `deck_card_select`'s
    // `ORDER BY`, so the snapshot reads as the editor's Categories view does. **This read is the
    // share's own and not the projector's**: a pile as a folder is this format's shape, and the
    // projection carries a pile's name, role and switch on each card instead.
    let mut stmt = conn
        .prepare(
            "SELECT cat.id, cat.name, cat.kind, cat.is_active
               FROM deck_categories cat
              WHERE cat.deck_id = ?1 AND cat.variant = 'live'
                AND EXISTS (SELECT 1 FROM deck_cards dc
                             WHERE dc.category_id = cat.id AND dc.variant = 'live')
              ORDER BY cat.sort_order, cat.id",
        )
        .map_err(|e| e.to_string())?;
    let piles = stmt
        .query_map(params![deck_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, bool>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let uids: std::collections::HashMap<i64, String> = piles
        .iter()
        .enumerate()
        .map(|(position, (row, ..))| (*row, pile_uid(position)))
        .collect();

    let folders = piles
        .iter()
        .map(|(row, name, ..)| ShareFolder {
            uid: uids[row].clone(),
            name: name.clone(),
            parent: None,
        })
        .collect();
    let deck = ShareDeck {
        format: found.format,
        piles: piles
            .iter()
            .map(|(row, _, kind, active)| SharePile {
                uid: uids[row].clone(),
                kind: kind.clone(),
                active: *active,
            })
            .collect(),
        cover: found.cover,
    };
    // A cover this device's `cards` lacks is a deck drawn without one: unknown like a card.
    let mut unknown = Unknown::default();
    unknown.add(found.printing);
    let cards = projection::deck_cards(
        conn,
        DeckCardScope::Deck(deck_id),
        fields.carried(),
        marketplace,
    )?
    .into_iter()
    .inspect(|card| unknown.add(card.printing))
    .map(|card| ShareCard {
        id: card.scryfall_id,
        n: card.name,
        s: card.set,
        cn: card.cn,
        f: card.finish,
        q: card.quantity,
        fo: uids.get(&card.category_id).cloned(),
        img: card.image,
        c: None,
        l: card.lang,
        // `Option<f64>`: an unquoted printing is an absent `p`, never a zero.
        p: card.value,
        t: card.type_line,
        mc: card.mana_cost,
        mv: card.mana_value,
    })
    .collect();

    let snap = ShareSnapshot {
        v: SNAPSHOT_VERSION,
        id: id.to_owned(),
        title: found.name,
        owner: owner.to_owned(),
        updated_at: now,
        marketplace: marketplace_id(marketplace).to_owned(),
        currency: currency(marketplace).to_owned(),
        fields: fields.names(),
        folders,
        cards,
        deck: Some(deck),
    };
    Ok((snap, unknown))
}

/// The picture a deck share's link preview shows (issue #1032), and the illustrator to credit
/// when it is an art crop.
///
/// **The deck's own cover first** — the picture the reader chose to stand for the deck — with its
/// artist, since a crop is only shown beside its credit. Without one, **its commander**, the card
/// a Commander deck is known by, and otherwise the first card of the first pile played in the
/// deck; those are whole card pictures, whose printed frame carries its own credit.
///
/// Read off the snapshot about to be uploaded rather than off the database, so the preview can
/// only ever show a picture the published document itself carries — never one from a pile the
/// share left home. `None` for a binder, and for a deck whose every printing lacks a picture.
pub fn preview(snap: &ShareSnapshot) -> Option<(&str, Option<&str>)> {
    let deck = snap.deck.as_ref()?;
    if let Some(cover) = &deck.cover {
        return Some((cover.img.as_str(), Some(cover.artist.as_str())));
    }
    preview_card(snap, deck).map(|img| (img, None))
}

/// [`preview`]'s fallback: the commander, else the first card played in the deck.
fn preview_card<'a>(snap: &'a ShareSnapshot, deck: &'a ShareDeck) -> Option<&'a str> {
    let first_in = |wanted: &dyn Fn(&SharePile) -> bool| {
        deck.piles.iter().filter(|p| wanted(p)).find_map(|pile| {
            snap.cards
                .iter()
                .filter(|c| c.fo.as_deref() == Some(pile.uid.as_str()))
                .find_map(|c| c.img.as_deref())
        })
    };
    first_in(&|p| p.active && p.kind == "commander")
        .or_else(|| first_in(&|p| p.active && p.kind != "side" && p.kind != "companion"))
        .or_else(|| first_in(&|_| true))
}
