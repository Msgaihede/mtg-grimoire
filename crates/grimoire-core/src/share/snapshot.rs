//! The snapshot itself — the wire structs, the collection's share as a filtered output of the
//! projector, and the gzip.
//!
//! **The rows are [`crate::integration::projection`]'s** (spec §7.5): the folder subtree and the
//! copies filed in it are read there, by the SQL the projection reads the whole table with, and
//! mapped here into the short keys a stranger's viewer reads. What is this file's is what a share
//! adds to that read — which folder the key names, the two refusals, the root's copies only for a
//! whole-collection share, and a parent outside the share being no parent.

use crate::integration::projection::{self, EntryScope, FolderScope, IntegrationFields};
use crate::integration::readable::Unknown;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::io::Write;

/// The format version, on the wire as `v`. One writer here and two TypeScript readers, which
/// is one implementation more than the text mirror has — so the number is the only thing a
/// viewer built against a later format has to look at before it decides it cannot draw this.
pub const SNAPSHOT_VERSION: i64 = 1;

/// A locked drawer is one the reader has set aside, and publishing it is the one thing a lock
/// is for. Refused **before** the read rather than published empty, which would read to a
/// stranger as "this person owns nothing".
pub const FOLDER_IS_LOCKED: &str = "That folder is locked. Unlock it before sharing it.";
/// No folder answers to that uid. Asked **first**, so a folder that is not there can never
/// report as locked — "unlock it" is advice nobody can act on for a drawer that does not exist.
pub const FOLDER_NOT_FOUND: &str = "That folder is not in this collection.";

/// What a whole-collection share is called. The folder share takes the folder's own name.
pub const WHOLE_COLLECTION_TITLE: &str = "Collection";

/// The three optional fields, as the publish dialog asks them.
///
/// **There is no fourth and there is no `..Default::default()` shortcut into one.** Spec §3
/// lists six columns that are absent from the format rather than switched off in it —
/// `purchase_price`, `purchase_currency`, `acquired_at`, `acquisition_source`, `notes` and the
/// free-text `tags` — because an optional field is a field a future switch can turn on by
/// accident, and those are the six a reader would most mind having published.
#[derive(Debug, Clone, Copy, Default)]
pub struct ShareFields {
    pub condition: bool,
    pub lang: bool,
    pub value: bool,
}

impl ShareFields {
    /// The wire form — an array, so the viewer can tell "every card was NM" from "this snapshot
    /// carries no condition".
    pub(super) fn names(self) -> Vec<&'static str> {
        let mut v = Vec::new();
        if self.condition {
            v.push("condition");
        }
        if self.lang {
            v.push("lang");
        }
        if self.value {
            v.push("value");
        }
        v
    }

    /// The projector's policy for this share: the three switches as they stand, and the entry
    /// tags and the entry note **off by construction**. They are absent from this format rather
    /// than switched off in it, so this is the one place the share's policy meets the
    /// projector's, and neither can be turned on from here.
    pub(crate) fn carried(self) -> IntegrationFields {
        IntegrationFields {
            condition: self.condition,
            lang: self.lang,
            value: self.value,
            tags: false,
            notes: false,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ShareFolder {
    pub uid: String,
    pub name: String,
    /// The parent's uid **within this snapshot**, and `None` for anything else.
    ///
    /// A folder shared out of the middle of the reader's cabinet is the root of the tree it
    /// publishes: carrying its real parent would name a folder the snapshot does not contain,
    /// which is a dangling edge for the viewer's tree walk and the existence of a drawer
    /// nobody shared.
    pub parent: Option<String>,
}

/// One card. **Short keys**, because this struct is repeated once per copy and the snapshot is
/// what crosses a stranger's network.
#[derive(Debug, Serialize)]
pub struct ShareCard {
    pub id: String,
    pub n: String,
    pub s: String,
    pub cn: String,
    pub f: String,
    pub q: i64,
    pub fo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub img: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub c: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub l: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p: Option<f64>,
    /// The type line. **A deck share's alone** (issue #1032) — a deck is read by type and by
    /// cost, and a viewer with no corpus has no other way to know either. A binder and a wishlist
    /// carry none, so their snapshots, and the golden, are unchanged byte for byte.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub t: Option<String>,
    /// The printed mana cost, verbatim (`{1}{R}`). A deck share's alone; absent for a land.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mc: Option<String>,
    /// The mana value. A deck share's alone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mv: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareSnapshot {
    pub v: i64,
    pub id: String,
    pub title: String,
    pub owner: String,
    pub updated_at: i64,
    pub marketplace: String,
    pub currency: String,
    pub fields: Vec<&'static str>,
    pub folders: Vec<ShareFolder>,
    pub cards: Vec<ShareCard>,
    /// The deck half of a deck share, and absent from every other kind (issue #1032). **Absent
    /// rather than `null`**, so a binder's snapshot is the document it always was — and `v` stays
    /// 1, because a viewer that predates it reads a deck as a binder with a drawer per pile.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deck: Option<super::deck::ShareDeck>,
}

/// Render the folder subtree rooted at `folder_uid` — or the whole collection, for `None` — as
/// a snapshot ready to gzip and upload.
///
/// `now` and `id` are the caller's rather than read here: the id is the relay's to mint and the
/// clock belongs to the command, so this function is a pure function of the database plus its
/// arguments and a test can pin the whole document.
pub fn snapshot(
    conn: &Connection,
    id: &str,
    owner: &str,
    folder_uid: Option<&str>,
    fields: ShareFields,
    marketplace: crate::sorting::Marketplace,
    now: i64,
) -> Result<ShareSnapshot, String> {
    counted(conn, id, owner, folder_uid, fields, marketplace, now).map(|(snap, _)| snap)
}

/// [`snapshot`], and **its cards that name a printing this device's `cards` lacks**, orphaned or
/// unseen — the reader's fallback rows ([`projection::Rows::unknown`]'s question, asked of a
/// share): an id for a name, no picture, no price. The publish round republishes a share holding
/// one only as `crate::integration::readable` allows (`share::publish::refresh_live`), because the
/// device that published it whole would never put it right — its own digest still matches.
pub(crate) fn counted(
    conn: &Connection,
    id: &str,
    owner: &str,
    folder_uid: Option<&str>,
    fields: ShareFields,
    marketplace: crate::sorting::Marketplace,
    now: i64,
) -> Result<(ShareSnapshot, Unknown), String> {
    // A wishlist key is a different cabinet with a reader of its own — `super::wishlist`.
    if let Some(key) = folder_uid.and_then(super::wishlist::WishlistKey::parse) {
        return super::wishlist::snapshot(conn, id, owner, key, fields, marketplace, now);
    }
    // And a deck key is a deck — `super::deck` (issue #1032).
    if let Some(uid) = folder_uid.and_then(super::deck::parse) {
        return super::deck::snapshot(conn, id, owner, uid, fields, marketplace, now);
    }
    // The two refusals, in this order, before a single row is read. `FOLDER_NOT_FOUND` first
    // so a folder that is not there never reports as locked. **Any `kind` may be named** — a
    // deck's group and `Recently removed` included, issue #941 — the projector's share scope has
    // the rules.
    let title = match folder_uid {
        None => WHOLE_COLLECTION_TITLE.to_owned(),
        Some(uid) => {
            let named: Option<(i64, String)> = conn
                .query_row(
                    "SELECT id, name FROM collection_folders WHERE sync_uid = ?1",
                    params![uid],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let (row_id, name) = named.ok_or_else(|| FOLDER_NOT_FOUND.to_owned())?;
            // The **effective** lock, `collection_folders`' own answer, so a share and the
            // page's own badge can never disagree about which drawers are set aside.
            if crate::collection_folders::effectively_locked(conn, row_id)? {
                return Err(FOLDER_IS_LOCKED.to_owned());
            }
            name
        }
    };

    let rows = projection::collection_folders(conn, FolderScope::Shared(folder_uid))?;
    let ids: Vec<i64> = rows.iter().map(|f| f.id).collect();
    // The root is a share member only for a whole-collection share; a named folder never
    // includes it.
    let scope = EntryScope::Folders {
        ids: &ids,
        root: folder_uid.is_none(),
    };
    let mut unknown = Unknown::default();
    let cards = projection::collection_entries(conn, scope, fields.carried(), marketplace)?
        .into_iter()
        .inspect(|e| unknown.add(e.printing))
        .map(|e| ShareCard {
            id: e.scryfall_id,
            n: e.name,
            s: e.set,
            cn: e.cn,
            f: e.finish,
            q: e.quantity,
            fo: e.folder_uid,
            img: e.image,
            c: e.condition,
            l: e.lang,
            p: e.value,
            t: None,
            mc: None,
            mv: None,
        })
        .collect();

    // A parent outside the snapshot is no parent here. Collected first so the rule is applied
    // against the *published* set rather than against the table.
    let published: std::collections::HashSet<&str> = rows.iter().map(|f| f.uid.as_str()).collect();
    let folders = rows
        .iter()
        .map(|f| ShareFolder {
            uid: f.uid.clone(),
            name: f.name.clone(),
            parent: f
                .parent_uid
                .as_deref()
                .filter(|p| published.contains(p))
                .map(str::to_owned),
        })
        .collect();

    let snap = ShareSnapshot {
        v: SNAPSHOT_VERSION,
        id: id.to_owned(),
        title,
        owner: owner.to_owned(),
        updated_at: now,
        marketplace: marketplace_id(marketplace).to_owned(),
        currency: currency(marketplace).to_owned(),
        fields: fields.names(),
        folders,
        cards,
        deck: None,
    };
    Ok((snap, unknown))
}

/// The marketplace's id, as `crate::marketplace` stores it.
///
/// The inverse of [`crate::sorting::Marketplace::from_id`], and lossy in exactly the way that
/// one is: `cardtrader` has no feed and prices through TCGplayer, so a snapshot published under
/// that setting says `tcgplayer` — which is the truth about where the numbers came from.
pub(crate) fn marketplace_id(market: crate::sorting::Marketplace) -> &'static str {
    use crate::sorting::Marketplace::*;
    match market {
        Tcgplayer => "tcgplayer",
        Cardmarket => "cardmarket",
        Cardkingdom => "cardkingdom",
        Manapool => "manapool",
    }
}

/// Which of the two axes `price_expr` read, and nothing more.
///
/// `crate::marketplace`'s header says a currency is TypeScript's conclusion about a label, and
/// that stands for the *app*. On the wire it is a fact about the number beside it: the euro arm
/// of [`crate::sorting::price_expr`] reads `cards.prices`' `eur*` keys and every other arm
/// reads dollars, so this is that `match` and not a second opinion about a marketplace.
pub(crate) fn currency(market: crate::sorting::Marketplace) -> &'static str {
    match market {
        crate::sorting::Marketplace::Cardmarket => "EUR",
        _ => "USD",
    }
}

/// `flate2` is already a dependency.
pub fn gzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(bytes).map_err(|e| e.to_string())?;
    e.finish().map_err(|e| e.to_string())
}
