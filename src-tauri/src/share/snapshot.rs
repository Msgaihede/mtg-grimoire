//! The snapshot itself — the wire structs, the subtree read that fills them, and the gzip.

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
/// `kind <> 'user'` — a deck's group or `Recently removed`. Those two say something the app is
/// responsible for, and neither is a binder.
pub const FOLDER_NOT_SHAREABLE: &str = "Only your own folders can be shared.";
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
    fn names(self) -> Vec<&'static str> {
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
}

/// Every folder in the share, as `(id, uid, name, parent_uid)`.
///
/// Two exclusions, and they are the feature: a folder that is locked or has a locked ancestor,
/// and a folder the app owns. `LOCKED_FOLDER_IDS` is `crate::collection_folders`' single copy of
/// the inheritance rule and binds nothing, so it drops straight into `NOT IN (…)`.
///
/// **`UNION` and never `UNION ALL`**, `delete_folder`'s reason for the same word: the
/// duplicate-row check is what makes a `parent_id` cycle — a hand-edited database, a restored
/// backup — converge instead of running forever.
///
/// ⚠️ **`?1` is bound twice and rusqlite binds by index, so the uid is passed once.**
const SUBTREE: &str = "WITH RECURSIVE subtree(id) AS (
        SELECT id FROM collection_folders WHERE (?1 IS NULL AND parent_id IS NULL)
                                             OR sync_uid = ?1
        UNION
        SELECT f.id FROM collection_folders f JOIN subtree s ON f.parent_id = s.id
    )
    SELECT f.id, f.sync_uid, f.name,
           (SELECT p.sync_uid FROM collection_folders p WHERE p.id = f.parent_id)
      FROM collection_folders f
     WHERE f.id IN (SELECT id FROM subtree)
       AND f.kind = 'user'
       AND f.id NOT IN (<LOCKED>)
     ORDER BY f.sort_order, f.id";

/// `collection_entries.condition`'s sixth value (schema v35) — *not set*, and an app sentinel
/// rather than a grade. It never reaches the wire: a snapshot that carries `condition` and a
/// card that has none is an **absent** `c`, which is what an unanswered question already looks
/// like everywhere else in this format.
const UNGRADED: &str = "NONE";

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
    // The three refusals, in this order, before a single row is read. `FOLDER_NOT_FOUND` first
    // so a folder that is not there never reports as locked.
    let title = match folder_uid {
        None => WHOLE_COLLECTION_TITLE.to_owned(),
        Some(uid) => {
            let named: Option<(i64, String, String)> = conn
                .query_row(
                    "SELECT id, kind, name FROM collection_folders WHERE sync_uid = ?1",
                    params![uid],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let (row_id, kind, name) = named.ok_or_else(|| FOLDER_NOT_FOUND.to_owned())?;
            if kind != "user" {
                return Err(FOLDER_NOT_SHAREABLE.to_owned());
            }
            // The **effective** lock, `collection_folders`' own answer, so a share and the
            // page's own badge can never disagree about which drawers are set aside.
            if crate::collection_folders::effectively_locked(conn, row_id)? {
                return Err(FOLDER_IS_LOCKED.to_owned());
            }
            name
        }
    };

    let rows = read_folders(conn, folder_uid)?;
    let ids: Vec<i64> = rows.iter().map(|f| f.id).collect();
    let cards = read_cards(conn, folder_uid, &ids, fields, marketplace)?;

    // A parent outside the snapshot is no parent here. Collected first so the rule is applied
    // against the *published* set rather than against the table.
    let published: std::collections::HashSet<&str> = rows.iter().map(|f| f.uid.as_str()).collect();
    let folders = rows
        .iter()
        .map(|f| ShareFolder {
            uid: f.uid.clone(),
            name: f.name.clone(),
            parent: f
                .parent
                .as_deref()
                .filter(|p| published.contains(p))
                .map(str::to_owned),
        })
        .collect();

    Ok(ShareSnapshot {
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
    })
}

/// One [`SUBTREE`] row. Named rather than a tuple because three of its four fields are strings
/// and the local id is the one thing that must never reach the wire — a `(_, uid, name, _)`
/// destructuring one position out publishes a folder's name as its identity, and nothing errors.
struct SubtreeFolder {
    /// `collection_folders.id`, local to this device and used only to scope the entry read.
    id: i64,
    uid: String,
    name: String,
    /// The parent's uid **as stored**. [`snapshot`] is where it is narrowed to the published set.
    parent: Option<String>,
}

/// [`SUBTREE`], run — one [`SubtreeFolder`] per surviving folder.
fn read_folders(conn: &Connection, folder_uid: Option<&str>) -> Result<Vec<SubtreeFolder>, String> {
    let sql = SUBTREE.replace("<LOCKED>", crate::collection_folders::LOCKED_FOLDER_IDS);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![folder_uid], |r| {
            Ok(SubtreeFolder {
                id: r.get(0)?,
                uid: r.get(1)?,
                name: r.get(2)?,
                parent: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// The copies filed in `ids` — plus the root's, and **only** for a whole-collection share.
fn read_cards(
    conn: &Connection,
    folder_uid: Option<&str>,
    ids: &[i64],
    fields: ShareFields,
    marketplace: crate::sorting::Marketplace,
) -> Result<Vec<ShareCard>, String> {
    // `cards` **must** be aliased `c`: `price_expr` writes `c.prices` and `c.id` into its own
    // expression, so a different alias here is a silent SQL error rather than a wrong price.
    let image = crate::image_uri::front_face_selects("c").join(", ");
    let price = crate::sorting::price_expr(marketplace, crate::collection::ENTRY_FINISH);
    // The root is a share member only for a whole-collection share; a named folder never
    // includes it. SQLite permits the empty `IN ()` this leaves behind when nothing survived.
    let root_arm = if folder_uid.is_none() {
        "e.folder_id IS NULL OR "
    } else {
        ""
    };
    // One bind per surviving folder. The bound is SQLite's `SQLITE_MAX_VARIABLE_NUMBER`, 32 766
    // in the version `rusqlite` bundles — a cabinet of that many drawers is not a shape this app
    // can reach, and inlining the ids instead (they are `i64`s this crate read out of the same
    // table, so there is nothing to escape) is the answer on the day it is.
    let holes = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    // Where the image pair begins — the count of every column before it. Written down rather
    // than spelled inside the closure, for `deck.rs`'s reason: a number left behind reads a
    // folder uid as a URL, and nothing errors.
    const IMAGE_COL: usize = 10;
    let sql = format!(
        "SELECT e.card_id, c.name, e.set_code, e.collector_number, e.lang, e.finish, e.quantity,
                e.condition,
                (SELECT f.sync_uid FROM collection_folders f WHERE f.id = e.folder_id),
                {price},
                {image}
           FROM collection_entries e LEFT JOIN cards c ON c.id = e.card_id
          WHERE ({root_arm}e.folder_id IN ({holes}))
            AND e.quantity > 0
          ORDER BY coalesce(c.name, e.card_id) ASC, e.set_code ASC,
                   CAST(e.collector_number AS INTEGER) ASC, e.id ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), |r| {
            let card_id: String = r.get(0)?;
            // `c.name` is an `Option` because the join is a LEFT one: a printing that has left
            // the corpus is still a card the reader owns, so the row falls back to the id
            // rather than being dropped — `COLLECTION_DEFAULT_ORDER`'s own `coalesce`.
            let name: Option<String> = r.get(1)?;
            let condition: String = r.get(7)?;
            let img = crate::image_uri::front_face_map(|i| r.get(IMAGE_COL + i))?
                .and_then(|m| m.get(crate::image_uri::LIST_VARIANT).cloned());
            Ok(ShareCard {
                n: name.unwrap_or_else(|| card_id.clone()),
                id: card_id,
                s: r.get(2)?,
                cn: r.get(3)?,
                f: r.get(5)?,
                q: r.get(6)?,
                fo: r.get(8)?,
                img,
                c: (fields.condition && condition != UNGRADED).then_some(condition),
                l: fields.lang.then(|| r.get(4)).transpose()?,
                // **`Option<f64>` and never `f64`.** `price_expr` answers NULL for a printing
                // the marketplace does not quote — an etched copy in euros, a card no feed
                // lists — and `rusqlite` refuses a NULL into `f64` with `InvalidColumnType`,
                // so reading it flat fails the whole publish over one unpriced card. The
                // absent `p` is what every price surface in this app already renders as an em
                // dash; a `0.0` would be the app claiming a shop offered the card for nothing.
                p: if fields.value {
                    r.get::<_, Option<f64>>(9)?
                } else {
                    None
                },
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// The marketplace's id, as `crate::marketplace` stores it.
///
/// The inverse of [`crate::sorting::Marketplace::from_id`], and lossy in exactly the way that
/// one is: `cardtrader` has no feed and prices through TCGplayer, so a snapshot published under
/// that setting says `tcgplayer` — which is the truth about where the numbers came from.
fn marketplace_id(market: crate::sorting::Marketplace) -> &'static str {
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
fn currency(market: crate::sorting::Marketplace) -> &'static str {
    match market {
        crate::sorting::Marketplace::Cardmarket => "EUR",
        _ => "USD",
    }
}

/// `flate2` is already a dependency and already compiles for wasm through `rust_backend`.
pub fn gzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(bytes).map_err(|e| e.to_string())?;
    e.finish().map_err(|e| e.to_string())
}
