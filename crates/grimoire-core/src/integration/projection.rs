//! `Projection v1` — the collection, the wishlist and the decks as six table documents a
//! server-side reader can be handed (issue #1396, spec §6.1), and the readers the share snapshot
//! is a filtered output of (spec §7.5).
//!
//! ## One projector, two outputs
//!
//! **Every read of a projected table lives here once, parameterised by a scope**: the whole table,
//! which is the projection's, or a share's slice of it — a folder subtree and the root's copies,
//! one deck's live list. [`crate::share`] maps what comes back into its own `ShareSnapshot v1` and
//! applies its own rules on the way: locked drawers stay home, a whole-collection share is the
//! reader's own folders, a wish and a deck card carry no condition. So a column a share reads is a
//! column the projection reads, by the same SQL, and a fix to one is a fix to both. The share's
//! goldens (`apps/desktop/src-tauri/src/share/__golden__/`) are what say the share did not move
//! when its reads came here.
//!
//! **What stayed in the share** is what only a share has: the key a share names its folder by
//! (`wishlist:deck:<uid>`, `deck:<uid>`), the refusals a locked or missing folder earns, and a
//! deck's piles as folders of the snapshot.
//!
//! ## The device filters
//!
//! **A field that is off is never read**: each opt-in column is selected as `NULL` unless its
//! switch is on ([`IntegrationFields`]), and a row carries an opt-in key only when it holds a
//! value — absent, never `null`. The columns that are absent from the format rather than switched
//! off in it (purchase price and currency, acquired-at, acquisition source, `needs_review`, serial
//! number, grading, deck descriptions, deck tags, labels) are named by no select list here, and
//! `tests::every_projected_column_is_classified` fails when a projected table grows a column nobody
//! has put on one side or the other. The integrations Worker refuses a row key outside its table's
//! list too, so a slip here is refused there rather than stored.
//!
//! ## Same rows, same bytes
//!
//! **A table's rows are ordered by `uid` and carry no local id and no clock**, because the store
//! compares digests: two devices holding the same synced rows must write the same document, or
//! each one's digest differs from the store's and they republish over each other on every round.
//! What can still differ between two devices is what their corpora say — a printing's picture, a
//! price — and that converges when the corpora do.
//!
//! **A row with no `sync_uid` is not projected, and nor is the managed wishlist**: its folders and
//! wishes are derived from the decks on every device and never captured, so their uid is NULL or
//! one a device minted for itself alone — and the decks they are a function of are projected.

use super::readable::{printing_of, Printing, Unknown};
use crate::share::ShareCover;
use crate::sorting::Marketplace;
use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};

/// The format version, on the wire as `v`.
pub const PROJECTION_VERSION: i64 = 1;

/// The six tables, in the order [`project_all`] answers them.
pub const TABLES: [&str; 6] = [
    "collection_folders",
    "collection_entries",
    "wishlist_folders",
    "wishlist_entries",
    "decks",
    "deck_cards",
];

/// The five opt-in fields, as the group switched them on — every one off by default.
///
/// **The group's and not a device's**: two devices projecting under two policies would flap the
/// store between them, so the store records one set and refuses a document carrying another.
/// A table that cannot carry a field ignores it (a deck card has no condition, a wish no condition),
/// but every document names the whole set in `fields`, which is what the store compares.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationFields {
    pub condition: bool,
    pub lang: bool,
    pub value: bool,
    pub tags: bool,
    pub notes: bool,
}

impl IntegrationFields {
    /// The wire form — the names of the fields that are on, in the format's order — so a reader
    /// can tell "no row had a note" from "notes were not sent".
    pub fn names(self) -> Vec<&'static str> {
        [
            (self.condition, "condition"),
            (self.lang, "lang"),
            (self.value, "value"),
            (self.tags, "tags"),
            (self.notes, "notes"),
        ]
        .into_iter()
        .filter_map(|(on, name)| on.then_some(name))
        .collect()
    }
}

/// One table, as it crosses: the version, which table, the policy it was read under, where its
/// prices came from, and its rows.
#[derive(Debug, Clone, Serialize)]
pub struct TableDoc {
    pub v: i64,
    pub table: &'static str,
    pub fields: Vec<&'static str>,
    /// The marketplace's id — [`crate::share::snapshot`]'s spelling, so a `cardtrader` setting
    /// says `tcgplayer`, which is where its numbers come from.
    pub marketplace: &'static str,
    pub currency: &'static str,
    pub rows: Rows,
}

/// A table's rows. Untagged, so each is the bare array on the wire.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum Rows {
    CollectionFolders(Vec<CollectionFolderRow>),
    CollectionEntries(Vec<CollectionEntryRow>),
    WishlistFolders(Vec<WishlistFolderRow>),
    WishlistEntries(Vec<WishlistEntryRow>),
    Decks(Vec<DeckRow>),
    DeckCards(Vec<DeckCardRow>),
}

impl Rows {
    pub fn len(&self) -> usize {
        match self {
            Rows::CollectionFolders(r) => r.len(),
            Rows::CollectionEntries(r) => r.len(),
            Rows::WishlistFolders(r) => r.len(),
            Rows::WishlistEntries(r) => r.len(),
            Rows::Decks(r) => r.len(),
            Rows::DeckCards(r) => r.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The rows that name a printing this device's `cards` lacks — the reader's fallback rows,
    /// drawn with an id for a name and no picture or price — by [`Printing`]. **A device with an
    /// old corpus, or none yet, reads a newer set's cards this way**, and published, its document
    /// would overwrite a good one; the publish round asks this before it sends a table
    /// ([`super::readable`]). Folders name no printing and are never unknown.
    pub fn unknown(&self) -> Unknown {
        let mut unknown = Unknown::default();
        match self {
            Rows::CollectionFolders(_) | Rows::WishlistFolders(_) => {}
            Rows::CollectionEntries(r) => r.iter().for_each(|e| unknown.add(e.printing)),
            Rows::WishlistEntries(r) => r.iter().for_each(|w| unknown.add(w.printing)),
            Rows::Decks(r) => r.iter().for_each(|d| unknown.add(d.printing)),
            Rows::DeckCards(r) => r.iter().for_each(|c| unknown.add(c.printing)),
        }
        unknown
    }
}

impl TableDoc {
    /// Whether this document **reads prices** — and so is this device's to publish at a
    /// feed-priced marketplace only while this device's feed for it is current
    /// ([`super::readable::feed_current`]). A wish's table always does: an any-printing wish is
    /// drawn as its cheapest printing at the marketplace whether or not `value` is carried. The
    /// collection's and the decks' cards do when `value` is carried; a folder or a deck never.
    pub fn priced(&self) -> bool {
        match self.table {
            "wishlist_entries" => true,
            "collection_entries" | "deck_cards" => self.fields.contains(&"value"),
            _ => false,
        }
    }
}

/// A collection folder. **`locked` is the effective lock** — its own flag or any ancestor's,
/// `collection_folders::LOCKED_FOLDER_IDS` — so a reader never has to walk the tree to know which
/// drawers the reader set aside. Locked folders are in the store, which is private; a share never
/// carries one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionFolderRow {
    /// `collection_folders.id`, local to this device: what a share scopes its entry read by.
    #[serde(skip)]
    pub(crate) id: i64,
    pub uid: String,
    pub name: String,
    /// The parent's uid **as stored**. A share narrows it to the folders it publishes.
    pub parent_uid: Option<String>,
    pub kind: String,
    pub locked: bool,
}

/// One row of the collection — a copy, or a pile of identical copies.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionEntryRow {
    pub uid: String,
    pub scryfall_id: String,
    /// Whether the printing is in this device's `cards` — not, for the reader's fallback row, whose
    /// name is its id and which carries no picture or price — and if not, whether this row was
    /// written before or after this device's bulk file. **Never on the wire**: it is what the
    /// publish round asks before it lets a device publish a row it cannot name
    /// ([`Rows::unknown`]).
    #[serde(skip)]
    pub(crate) printing: Printing,
    /// The printing's name — or its id, for a printing that has left the corpus: still a card the
    /// reader owns, so the row falls back rather than being dropped.
    pub name: String,
    pub set: String,
    pub cn: String,
    pub finish: String,
    pub quantity: i64,
    pub folder_uid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// Absent for an ungraded copy as for a switched-off field — see [`UNGRADED`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    /// **`Option<f64>` and never `f64`**: a marketplace that does not quote the printing's finish
    /// answers NULL, and a `0.0` would be a shop offering the card for nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    /// The entry tags — the collection's own free-text `tags` column, never a Scryfall tag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// The entry note.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// A wishlist folder the reader made. A managed one is never read for the projection.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WishlistFolderRow {
    #[serde(skip)]
    pub(crate) id: i64,
    pub uid: String,
    pub name: String,
    /// The parent's uid **within the read** — a parent the read did not take is no parent, which
    /// is a share's rule for the root of what it publishes and changes nothing for a whole table.
    pub parent_uid: Option<String>,
}

/// One wish.
///
/// **An any-printing wish is drawn as the printing the wishlist draws it as** — cheapest at the
/// reader's marketplace, then newest (`wishlist::priced_wishes`' join) — so its `set`, `cn`,
/// `image` and `value` are that printing's, while `scryfallId` stays `null`: the reader asked for
/// the card, not for that printing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WishlistEntryRow {
    pub uid: String,
    pub scryfall_id: Option<String>,
    pub oracle_id: Option<String>,
    /// Whether the printing it is drawn as is in this device's `cards` — see
    /// [`CollectionEntryRow`]'s `printing`.
    #[serde(skip)]
    pub(crate) printing: Printing,
    /// The printing the wish is drawn as, which a share sends as its `id`.
    #[serde(skip)]
    pub(crate) drawn_id: String,
    pub name: String,
    pub set: String,
    pub cn: String,
    /// `preferred_finish`, and `nonfoil` where the wish has no preference.
    pub finish: String,
    pub quantity: i64,
    /// `wishlist_folders.id`, local — a share maps it onto the uids it publishes.
    #[serde(skip)]
    pub(crate) folder_id: Option<i64>,
    pub folder_uid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    /// The wish's entry tags — `wishlist_entries.tags` (user schema v67, issue #1398), the twin of
    /// [`CollectionEntryRow`]'s, under the same `tags` switch and never a Scryfall tag. **Absent
    /// from a share**, whose format has no entry tags.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// A deck. Its description, tags, notes, to-dos and every view-state column stay home.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckRow {
    #[serde(skip)]
    pub(crate) id: i64,
    /// Not [`Printing::Known`] when the deck names a cover printing this device's `cards` lacks,
    /// so its `cover` is absent for want of the card rather than by the reader's choice — see
    /// [`CollectionEntryRow`]'s `printing`.
    #[serde(skip)]
    pub(crate) printing: Printing,
    pub uid: String,
    pub name: String,
    /// The format's display name (`Commander`), or its key when the seed no longer carries it —
    /// the share's spelling.
    pub format: String,
    pub folder_uid: Option<String>,
    /// The deck's cover and its illustrator, under the share's rule: absent for a deck with no
    /// cover and for one whose painter is not on record, because an art crop is shown only beside
    /// its credit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<ShareCover>,
}

/// One row of a deck's live list. **The live list only**: a theory row is a plan the reader has
/// not built.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckCardRow {
    pub uid: String,
    pub deck_uid: String,
    /// Whether the printing is in this device's `cards` — see [`CollectionEntryRow`]'s
    /// `printing`.
    #[serde(skip)]
    pub(crate) printing: Printing,
    /// `deck_categories.id`, local — a share's pile is its position.
    #[serde(skip)]
    pub(crate) category_id: i64,
    /// The pile's name, as the reader named it.
    pub pile: String,
    /// The pile's rules role — `main`, `side`, `commander`, `companion`, `maybe`.
    pub kind: String,
    /// The pile's switch: a switched-off pile counts toward nothing.
    pub active: bool,
    pub scryfall_id: String,
    /// `deck_cards.name` — denormalised at write time, and the one name an orphaned row still has.
    pub name: String,
    pub set: String,
    pub cn: String,
    /// The finish the row plays: the reader's own word, then the printing's when it is made in one
    /// finish alone, then the regular copy.
    pub finish: String,
    pub quantity: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_line: Option<String>,
    /// The printed cost, verbatim; absent for a land, whose cost is empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mana_cost: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mana_value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
}

// ---------------------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------------------

/// One table's document under `fields`, priced at `marketplace`.
pub fn project(
    conn: &Connection,
    table: &str,
    fields: IntegrationFields,
    marketplace: Marketplace,
) -> Result<TableDoc, String> {
    let (table, rows) = match table {
        "collection_folders" => (
            "collection_folders",
            Rows::CollectionFolders(collection_folders(conn, FolderScope::Whole)?),
        ),
        "collection_entries" => (
            "collection_entries",
            Rows::CollectionEntries(collection_entries(
                conn,
                EntryScope::Whole,
                fields,
                marketplace,
            )?),
        ),
        "wishlist_folders" => (
            "wishlist_folders",
            Rows::WishlistFolders(wishlist_folders(conn, WishFolderScope::Whole)?),
        ),
        "wishlist_entries" => (
            "wishlist_entries",
            Rows::WishlistEntries(wishlist_entries(
                conn,
                EntryScope::Whole,
                fields,
                marketplace,
            )?),
        ),
        "decks" => ("decks", Rows::Decks(decks(conn, DeckScope::Whole)?)),
        "deck_cards" => (
            "deck_cards",
            Rows::DeckCards(deck_cards(conn, DeckCardScope::Whole, fields, marketplace)?),
        ),
        other => return Err(format!("{other} is not a projected table")),
    };
    Ok(TableDoc {
        v: PROJECTION_VERSION,
        table,
        fields: fields.names(),
        marketplace: crate::share::snapshot::marketplace_id(marketplace),
        currency: crate::share::snapshot::currency(marketplace),
        rows,
    })
}

/// All six, in [`TABLES`]' order.
pub fn project_all(
    conn: &Connection,
    fields: IntegrationFields,
    marketplace: Marketplace,
) -> Result<Vec<TableDoc>, String> {
    TABLES
        .iter()
        .map(|table| project(conn, table, fields, marketplace))
        .collect()
}

/// What a document *says*, as lowercase hex SHA-256 over the JSON of its `fields`,
/// `marketplace`, `currency` and `rows`, in that order.
///
/// **There is no clock in the document at all**, so two reads of an unchanged table digest alike
/// and a round that finds nothing moved sends nothing. Opaque to the store, which keeps it and
/// hands it back; a device compares its own against it.
pub fn digest(doc: &TableDoc) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    #[derive(Serialize)]
    struct Said<'a> {
        fields: &'a [&'static str],
        marketplace: &'a str,
        currency: &'a str,
        rows: &'a Rows,
    }
    let body = serde_json::to_vec(&Said {
        fields: &doc.fields,
        marketplace: doc.marketplace,
        currency: doc.currency,
        rows: &doc.rows,
    })
    .map_err(|e| e.to_string())?;
    Ok(Sha256::digest(&body)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// The document as it is sent: its JSON, gzipped with the share's own encoder.
pub fn gzip_doc(doc: &TableDoc) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(doc).map_err(|e| e.to_string())?;
    crate::share::gzip(&json)
}

// ---------------------------------------------------------------------------------------
// The readers, and the scopes a share narrows them by
// ---------------------------------------------------------------------------------------

/// `collection_entries.condition`'s sixth value (schema v35) — *not set*, an app sentinel and not
/// a grade. It never reaches a document: a copy with no grade is an **absent** `condition`, which
/// is what an unanswered question looks like everywhere else in both formats.
const UNGRADED: &str = "NONE";

/// Which collection folders a read takes.
#[derive(Debug, Clone, Copy)]
pub(crate) enum FolderScope<'a> {
    /// Every folder with a uid, locked ones and the app's own included — the projection's.
    Whole,
    /// A share's: the subtree under the folder that uid names, or every root folder for `None`,
    /// less its two exclusions — see [`SHARED_FOLDERS`].
    Shared(Option<&'a str>),
}

/// A share's folders.
///
/// Two exclusions, and they are the feature: a folder that is locked or has a locked ancestor,
/// and — **for a whole-collection share only** — a folder the app owns. `LOCKED_FOLDER_IDS` is
/// `crate::collection_folders`' single copy of the inheritance rule and binds nothing, so it drops
/// straight into `NOT IN (…)`.
///
/// **A deck's group and `Recently removed` travel when they are named, and only then** (issue
/// #941). Shared by name, either is the reader's own choice of what to publish. Swept up by a
/// whole-collection share, they would be the app publishing more than the reader asked for, and a
/// refresh of a share made before #941 would quietly grow by every deck the reader owns.
///
/// **`UNION` and never `UNION ALL`**, `delete_folder`'s reason for the same word: the duplicate-row
/// check is what makes a `parent_id` cycle — a hand-edited database, a restored backup — converge
/// instead of running forever.
///
/// ⚠️ **`?1` is bound twice and rusqlite binds by index, so the uid is passed once.**
const SHARED_FOLDERS: (&str, &str) = (
    "WITH RECURSIVE subtree(id) AS (
        SELECT id FROM collection_folders WHERE (?1 IS NULL AND parent_id IS NULL)
                                             OR sync_uid = ?1
        UNION
        SELECT f.id FROM collection_folders f JOIN subtree s ON f.parent_id = s.id
    )",
    "f.id IN (SELECT id FROM subtree)
       AND (?1 IS NOT NULL OR f.kind = 'user')
       AND f.id NOT IN (<LOCKED>)",
);

pub(crate) fn collection_folders(
    conn: &Connection,
    scope: FolderScope<'_>,
) -> Result<Vec<CollectionFolderRow>, String> {
    let locked = crate::collection_folders::LOCKED_FOLDER_IDS;
    let (with, filter, order, uid) = match scope {
        FolderScope::Whole => ("", "coalesce(f.sync_uid, '') <> ''", "f.sync_uid", None),
        FolderScope::Shared(uid) => (
            SHARED_FOLDERS.0,
            SHARED_FOLDERS.1,
            "f.sort_order, f.id",
            Some(uid),
        ),
    };
    let sql = format!(
        "{with}
         SELECT f.id, f.sync_uid, f.name,
                (SELECT p.sync_uid FROM collection_folders p WHERE p.id = f.parent_id),
                f.kind, f.id IN ({locked})
           FROM collection_folders f
          WHERE {filter}
          ORDER BY {order}"
    )
    .replace("<LOCKED>", locked);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let read = |r: &rusqlite::Row<'_>| {
        Ok(CollectionFolderRow {
            id: r.get(0)?,
            uid: r.get(1)?,
            name: r.get(2)?,
            parent_uid: r.get(3)?,
            kind: r.get(4)?,
            locked: r.get(5)?,
        })
    };
    let rows = match uid {
        None => stmt.query_map([], read),
        Some(uid) => stmt.query_map(params![uid], read),
    }
    .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Which entries a read takes — the collection's or the wishlist's.
#[derive(Debug, Clone, Copy)]
pub(crate) enum EntryScope<'a> {
    /// Every eligible row with a uid — the projection's.
    Whole,
    /// A share's: the rows filed in these folders (local ids), plus the root's when `root` — a
    /// whole-collection or whole-wishlist share, and never a named folder's.
    Folders { ids: &'a [i64], root: bool },
}

impl EntryScope<'_> {
    /// The `WHERE` term and the order. A whole table is ordered by uid (the module doc has why);
    /// a share is ordered as its viewer draws it.
    ///
    /// One bind per surviving folder. The bound is SQLite's `SQLITE_MAX_VARIABLE_NUMBER`, 32 766
    /// in the version `rusqlite` bundles — a cabinet of that many drawers is not a shape this app
    /// can reach, and inlining the ids instead (they are `i64`s this crate read out of the same
    /// table, so there is nothing to escape) is the answer on the day it is. SQLite permits the
    /// empty `IN ()` this leaves behind when nothing survived.
    fn folder_term(&self, alias: &str) -> String {
        match self {
            EntryScope::Whole => String::new(),
            EntryScope::Folders { ids, root } => {
                let root_arm = if *root {
                    format!("{alias}.folder_id IS NULL OR ")
                } else {
                    String::new()
                };
                let holes = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                format!("({root_arm}{alias}.folder_id IN ({holes}))")
            }
        }
    }

    fn ids(&self) -> &[i64] {
        match self {
            EntryScope::Whole => &[],
            EntryScope::Folders { ids, .. } => ids,
        }
    }
}

/// `column` when the field is on, `NULL` when it is off — so a field nobody asked for is never
/// read off the disk.
fn carried(on: bool, column: &str) -> String {
    if on {
        column.to_owned()
    } else {
        "NULL".to_owned()
    }
}

/// A free-text column's value, or `None` when it holds nothing a reader could see.
fn said(text: Option<String>) -> Option<String> {
    text.filter(|t| !t.trim().is_empty())
}

/// The entry tags as a list of strings, from the JSON array the column holds — a copy's (issue
/// #555) or a wish's (issue #1398). Absent for an empty list and for anything that is not a list
/// of strings.
fn tag_list(json: Option<String>) -> Option<Vec<String>> {
    let values: Vec<serde_json::Value> = serde_json::from_str(&json?).ok()?;
    let tags: Vec<String> = values
        .into_iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .filter(|t| !t.trim().is_empty())
        .collect();
    (!tags.is_empty()).then_some(tags)
}

pub(crate) fn collection_entries(
    conn: &Connection,
    scope: EntryScope<'_>,
    fields: IntegrationFields,
    marketplace: Marketplace,
) -> Result<Vec<CollectionEntryRow>, String> {
    // `cards` **must** be aliased `c`: `price_expr` writes `c.prices` and `c.id` into its own
    // expression, so a different alias here is a silent SQL error rather than a wrong price.
    let image = crate::image_uri::front_face_selects("c").join(", ");
    let price = carried(
        fields.value,
        &crate::sorting::price_expr(marketplace, crate::collection::ENTRY_FINISH),
    );
    let lang = carried(fields.lang, "e.lang");
    let condition = carried(fields.condition, "e.condition");
    let tags = carried(fields.tags, "e.tags");
    let notes = carried(fields.notes, "e.notes");
    let (filter, order) = match scope {
        EntryScope::Whole => ("coalesce(e.sync_uid, '') <> ''".to_owned(), "e.sync_uid"),
        EntryScope::Folders { .. } => (
            scope.folder_term("e"),
            "coalesce(c.name, e.card_id) ASC, e.set_code ASC,
             CAST(e.collector_number AS INTEGER) ASC, e.id ASC",
        ),
    };
    // Where the image pair begins — the count of every column before it. Written down rather than
    // spelled inside the closure, because a number left behind when a column is added above it
    // reads a note as a URL, and nothing errors.
    const IMAGE_COL: usize = 14;
    let printing = printing_of("c", "e", "0");
    let sql = format!(
        "SELECT coalesce(e.sync_uid, ''), e.card_id, coalesce(c.name, e.card_id),
                e.set_code, e.collector_number, {lang}, e.finish, e.quantity, {condition},
                (SELECT f.sync_uid FROM collection_folders f WHERE f.id = e.folder_id),
                {price}, {tags}, {notes}, {printing},
                {image}
           FROM collection_entries e LEFT JOIN cards c ON c.id = e.card_id
          WHERE {filter}
            AND e.quantity > 0
          ORDER BY {order}"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(scope.ids().iter()), |r| {
            Ok(CollectionEntryRow {
                uid: r.get(0)?,
                scryfall_id: r.get(1)?,
                name: r.get(2)?,
                set: r.get(3)?,
                cn: r.get(4)?,
                lang: r.get(5)?,
                finish: r.get(6)?,
                quantity: r.get(7)?,
                condition: r
                    .get::<_, Option<String>>(8)?
                    .filter(|grade| grade != UNGRADED),
                folder_uid: r.get(9)?,
                value: r.get(10)?,
                tags: tag_list(r.get(11)?),
                notes: said(r.get(12)?),
                printing: Printing::from_code(r.get(13)?),
                image: crate::image_uri::front_face_uri(|i| r.get(IMAGE_COL + i))?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Which wishlist folders a read takes.
#[derive(Debug, Clone, Copy)]
pub(crate) enum WishFolderScope {
    /// Every folder the reader made, with a uid — the projection's. A managed folder is derived
    /// from its deck and never captured, and is not read.
    Whole,
    /// A share's: the subtree under that folder (a local id), or the whole wishlist for `None` —
    /// the root arm keeping only folders the reader made.
    Shared(Option<i64>),
}

/// A share's wishlist folders. **`UNION`, never `UNION ALL`**, [`SHARED_FOLDERS`]' reason: a
/// `parent_id` cycle converges instead of running forever.
///
/// The root arm keeps only folders the reader made (`managed_deck_id IS NULL`); a managed folder's
/// Tokens child hangs under its deck's folder, so leaving that out leaves the child out with it.
const SHARED_WISH_FOLDERS: &str = "WITH RECURSIVE subtree(id) AS (
        SELECT id FROM wishlist_folders
         WHERE (?1 IS NULL AND parent_id IS NULL AND managed_deck_id IS NULL) OR id = ?1
        UNION
        SELECT f.id FROM wishlist_folders f JOIN subtree s ON f.parent_id = s.id
    )";

/// A managed wishlist folder's uid, derived from its deck's — `managed:<deck uid>` for the deck's
/// wishlist and `managed-tokens:<deck uid>` for its Tokens child. **A real uid is 32 hex digits
/// and never holds a `:`**, so the two cannot meet. `NULL` for a folder that is not managed, or
/// whose deck has no uid. See [`wishlist_folders`].
const MANAGED_UID: &str = "(SELECT CASE WHEN f.managed_tokens = 1 THEN 'managed-tokens:'
                                    ELSE 'managed:' END || d.sync_uid
                       FROM decks d
                      WHERE d.id = f.managed_deck_id AND coalesce(d.sync_uid, '') <> '')";

pub(crate) fn wishlist_folders(
    conn: &Connection,
    scope: WishFolderScope,
) -> Result<Vec<WishlistFolderRow>, String> {
    let (with, filter, order, root) = match scope {
        WishFolderScope::Whole => (
            "",
            "f.managed_deck_id IS NULL AND coalesce(f.sync_uid, '') <> ''",
            "f.sync_uid",
            None,
        ),
        WishFolderScope::Shared(root) => (
            SHARED_WISH_FOLDERS,
            "f.id IN (SELECT id FROM subtree)",
            "f.sort_order, f.id",
            Some(root),
        ),
    };
    // A folder with no `sync_uid` — a managed one a share named, derived and never captured — is
    // given one **derived from its deck's** ([`MANAGED_UID`]): the same on every read and on every
    // device that holds the deck, so a share of it digests alike from one round to the next and is
    // not republished on every one. **Never its row id**: that names a row in a database no other
    // device has seen. Only a managed folder whose deck has no uid either — nothing a capture
    // leaves — falls through to a random one for this read alone. The whole table never reaches
    // either arm: its filter takes only folders that have a uid.
    let sql = format!(
        "{with}
         SELECT f.id, coalesce(nullif(f.sync_uid, ''), {MANAGED_UID}, lower(hex(randomblob(16)))),
                f.name, f.parent_id
           FROM wishlist_folders f
          WHERE {filter}
          ORDER BY {order}"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let read = |r: &rusqlite::Row<'_>| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<i64>>(3)?,
        ))
    };
    let read = match root {
        None => stmt.query_map([], read),
        Some(root) => stmt.query_map(params![root], read),
    }
    .map_err(|e| e.to_string())?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(|e| e.to_string())?;
    // The parent stays a local id until it is mapped here, against the read, so a parent outside
    // it is no parent.
    let uids: std::collections::HashMap<i64, &str> = read
        .iter()
        .map(|(row, uid, _, _)| (*row, uid.as_str()))
        .collect();
    Ok(read
        .iter()
        .map(|(row, uid, name, parent)| WishlistFolderRow {
            id: *row,
            uid: uid.clone(),
            name: name.clone(),
            parent_uid: parent.and_then(|p| uids.get(&p)).map(|p| (*p).to_owned()),
        })
        .collect())
}

pub(crate) fn wishlist_entries(
    conn: &Connection,
    scope: EntryScope<'_>,
    fields: IntegrationFields,
    marketplace: Marketplace,
) -> Result<Vec<WishlistEntryRow>, String> {
    // `w` and `c` are not free choices: `row_price_expr` writes `c.prices` for the printing and
    // the caller's finish column, and `crate::wishlist::WISH_PREFERRED_FINISH` is `w.`-qualified.
    let finish = crate::wishlist::WISH_PREFERRED_FINISH;
    let price = crate::sorting::row_price_expr(marketplace, finish);
    let value = carried(fields.value, &price);
    let lang = carried(fields.lang, "coalesce(w.lang, c.lang)");
    let tags = carried(fields.tags, "w.tags");
    let notes = carried(fields.notes, "w.notes");
    let image = crate::image_uri::front_face_selects("c").join(", ");
    let (filter, order) = match scope {
        // A managed folder's wishes are derived and carry no uid; the folder term says so in
        // words rather than leaning on that.
        EntryScope::Whole => (
            "coalesce(w.sync_uid, '') <> ''
             AND (w.folder_id IS NULL
                  OR w.folder_id IN (SELECT id FROM wishlist_folders WHERE managed_deck_id IS NULL))"
                .to_owned(),
            "w.sync_uid",
        ),
        EntryScope::Folders { .. } => (
            scope.folder_term("w"),
            "coalesce(c.name, w.name) ASC, coalesce(w.set_code, c.set_code, '') ASC,
             CAST(coalesce(w.collector_number, c.collector_number) AS INTEGER) ASC, w.id ASC",
        ),
    };
    // Where the image pair begins. Written down for [`collection_entries`]' reason.
    const IMAGE_COL: usize = 16;
    let printing = printing_of("c", "w", "0");
    // The printing an any-printing wish is drawn as is `crate::wishlist`'s own choice — cheapest
    // at this marketplace, then newest — so a share and the reader's list show one card. **The
    // price orders that choice whether or not `value` is carried.**
    let sql = format!(
        "SELECT coalesce(w.sync_uid, ''), w.card_id, w.oracle_id,
                coalesce(w.card_id, c.id, w.oracle_id), coalesce(c.name, w.name),
                coalesce(w.set_code, c.set_code, ''), coalesce(w.collector_number, c.collector_number, ''),
                {lang}, coalesce({finish}, 'nonfoil'), w.quantity, w.folder_id,
                (SELECT f.sync_uid FROM wishlist_folders f WHERE f.id = w.folder_id),
                {value}, {notes}, {printing}, {tags},
                {image}
           FROM wishlist_entries w
           LEFT JOIN cards c
             ON c.id = coalesce(w.card_id,
                    (SELECT c.id FROM cards c
                      WHERE c.oracle_id = w.oracle_id
                      ORDER BY ({price}) ASC NULLS LAST, c.released_at DESC, c.id ASC
                      LIMIT 1))
          WHERE {filter}
          ORDER BY {order}"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(scope.ids().iter()), |r| {
            Ok(WishlistEntryRow {
                uid: r.get(0)?,
                scryfall_id: r.get(1)?,
                oracle_id: r.get(2)?,
                drawn_id: r.get(3)?,
                name: r.get(4)?,
                set: r.get(5)?,
                cn: r.get(6)?,
                lang: r.get(7)?,
                finish: r.get(8)?,
                quantity: r.get(9)?,
                folder_id: r.get(10)?,
                folder_uid: r.get(11)?,
                value: r.get(12)?,
                notes: said(r.get(13)?),
                printing: Printing::from_code(r.get(14)?),
                tags: tag_list(r.get(15)?),
                image: crate::image_uri::front_face_uri(|i| r.get(IMAGE_COL + i))?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Which decks a read takes.
#[derive(Debug, Clone, Copy)]
pub(crate) enum DeckScope<'a> {
    /// Every deck with a uid — the projection's.
    Whole,
    /// The one deck that uid names — a deck share's. An empty uid names none.
    Uid(&'a str),
}

pub(crate) fn decks(conn: &Connection, scope: DeckScope<'_>) -> Result<Vec<DeckRow>, String> {
    use crate::image_uri::{for_face, is_fetchable, FACE_COLUMN, TOP_LEVEL_COLUMN};
    let (filter, order, uid) = match scope {
        DeckScope::Whole => ("coalesce(d.sync_uid, '') <> ''", "d.sync_uid", None),
        DeckScope::Uid(uid) => ("d.sync_uid = ?1 AND ?1 <> ''", "d.id", Some(uid)),
    };
    // The cover is the cover printing's front-face `art` crop, held to the rules every published
    // picture is ([`for_face`], [`is_fetchable`]), with its illustrator beside it. A deck with no
    // cover names no printing, and is known.
    let printing = printing_of("c", "d", "coalesce(d.cover_card_id, '') = ''");
    let sql = format!(
        "SELECT d.id, d.sync_uid, d.name, coalesce(fs.display_name, d.format_key),
                (SELECT df.sync_uid FROM deck_folders df WHERE df.id = d.folder_id),
                json_extract(c.{TOP_LEVEL_COLUMN}, '$.art'),
                json_extract(c.{FACE_COLUMN}, '$[0].art'),
                c.artist,
                {printing}
           FROM decks d
           LEFT JOIN format_specs fs ON fs.key = d.format_key
           LEFT JOIN cards c ON c.id = d.cover_card_id
          WHERE {filter}
          ORDER BY {order}"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let read = |r: &rusqlite::Row<'_>| {
        let top: Option<String> = r.get(5)?;
        let face: Option<String> = r.get(6)?;
        let artist: Option<String> = r.get(7)?;
        let cover = for_face(top, face, 0)
            .filter(|u| is_fetchable(u))
            .and_then(|img| {
                let artist = artist.filter(|a| !a.trim().is_empty())?;
                Some(ShareCover { img, artist })
            });
        Ok(DeckRow {
            id: r.get(0)?,
            printing: Printing::from_code(r.get(8)?),
            uid: r.get(1)?,
            name: r.get(2)?,
            format: r.get(3)?,
            folder_uid: r.get(4)?,
            cover,
        })
    };
    let rows = match uid {
        None => stmt.query_map([], read),
        Some(uid) => stmt.query_map(params![uid], read),
    }
    .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Which deck cards a read takes. The live list either way.
#[derive(Debug, Clone, Copy)]
pub(crate) enum DeckCardScope {
    /// Every live row with a uid, of every deck with one — the projection's.
    Whole,
    /// One deck's live list (a local id), in the editor's Categories order — a deck share's.
    Deck(i64),
}

pub(crate) fn deck_cards(
    conn: &Connection,
    scope: DeckCardScope,
    fields: IntegrationFields,
    marketplace: Marketplace,
) -> Result<Vec<DeckCardRow>, String> {
    // `dc` and `c` are not free choices: `deck_card_price_expr` writes `dc.finish`, `c.prices`
    // and `c.finishes` into its own expression.
    let price = carried(
        fields.value,
        &crate::sorting::deck_card_price_expr(marketplace),
    );
    let lang = carried(fields.lang, "dc.lang");
    let image = crate::image_uri::front_face_selects("c").join(", ");
    let (filter, order, deck) = match scope {
        DeckCardScope::Whole => (
            "coalesce(dc.sync_uid, '') <> '' AND coalesce(d.sync_uid, '') <> ''",
            "dc.sync_uid",
            None,
        ),
        DeckCardScope::Deck(deck) => (
            "dc.deck_id = ?1",
            "cat.sort_order, cat.id, dc.name, dc.id",
            Some(deck),
        ),
    };
    // Where the image pair begins. Written down for [`collection_entries`]' reason: a number left
    // behind when a column is added above it reads a mana cost as a URL, and nothing errors.
    const IMAGE_COL: usize = 18;
    let printing = printing_of("c", "dc", "0");
    let sql = format!(
        "SELECT coalesce(dc.sync_uid, ''), coalesce(d.sync_uid, ''), dc.category_id,
                cat.name, cat.kind, cat.is_active,
                dc.card_id, dc.name, dc.set_code, dc.collector_number, {lang},
                -- The finish the row plays: the reader's own word, then the printing's when it is
                -- made in one finish alone (`soleFinish`'s rule), then the regular copy.
                coalesce(dc.finish,
                         CASE WHEN json_valid(c.finishes) AND json_array_length(c.finishes) = 1
                              THEN json_extract(c.finishes, '$[0]') END,
                         'nonfoil'),
                dc.quantity, {price},
                c.type_line, c.mana_cost, c.cmc, {printing},
                {image}
           FROM deck_cards dc
           JOIN deck_categories cat ON cat.id = dc.category_id
           JOIN decks d ON d.id = dc.deck_id
           LEFT JOIN cards c ON c.id = dc.card_id
          WHERE dc.variant = 'live' AND {filter}
          ORDER BY {order}"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let read = |r: &rusqlite::Row<'_>| {
        Ok(DeckCardRow {
            uid: r.get(0)?,
            deck_uid: r.get(1)?,
            category_id: r.get(2)?,
            pile: r.get(3)?,
            kind: r.get(4)?,
            active: r.get(5)?,
            scryfall_id: r.get(6)?,
            name: r.get(7)?,
            set: r.get(8)?,
            cn: r.get(9)?,
            lang: r.get(10)?,
            finish: r.get(11)?,
            quantity: r.get(12)?,
            value: r.get(13)?,
            type_line: r.get(14)?,
            mana_cost: r.get::<_, Option<String>>(15)?.filter(|m| !m.is_empty()),
            mana_value: r.get(16)?,
            printing: Printing::from_code(r.get(17)?),
            image: crate::image_uri::front_face_uri(|i| r.get(IMAGE_COL + i))?,
        })
    };
    let rows = match deck {
        None => stmt.query_map([], read),
        Some(deck) => stmt.query_map(params![deck], read),
    }
    .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every field on — the golden's policy.
    const EVERY: IntegrationFields = IntegrationFields {
        condition: true,
        lang: true,
        value: true,
        tags: true,
        notes: true,
    };

    /// The `display` URL the corpus stores for `id`, in Scryfall's own shape — the key
    /// `image_uri::front_face_selects` reads, so a fixture keyed on anything else draws no picture.
    fn display_uri(id: &str) -> String {
        format!(
            "https://cards.scryfall.io/display/front/{}/{}/{id}.webp?1757308800",
            &id[..1],
            &id[1..2]
        )
    }

    /// One printing, priced in each finish.
    fn card(conn: &Connection, id: &str, name: &str, set: &str, cn: &str) {
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw,
                                image_uris, prices)
             VALUES (?1, ?2, ?3, ?4, 'en', 'normal', '{}', json_object('display', ?5),
                     json_object('usd', '0.34', 'usd_foil', '1.25', 'usd_etched', '2.50'))",
            params![id, name, set, cn, display_uri(id)],
        )
        .unwrap();
    }

    fn folder(conn: &Connection, parent: Option<i64>, name: &str, uid: &str, locked: bool) -> i64 {
        conn.execute(
            "INSERT INTO collection_folders
               (parent_id, name, kind, sort_order, created_at, updated_at, sync_uid, locked)
             VALUES (?1, ?2, 'user', 0, 0, 0, ?3, ?4)",
            params![parent, name, uid, i64::from(locked)],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    /// One row of the collection, its set and number taken from the corpus where it has a row.
    ///
    /// **Every column a projection must never carry is set to a marker**, so the golden would show
    /// it if one leaked — and a `private-` sweep finds it.
    #[allow(clippy::too_many_arguments)]
    fn entry(
        conn: &Connection,
        uid: Option<&str>,
        card_id: &str,
        folder: Option<i64>,
        finish: &str,
        condition: &str,
        lang: &str,
        quantity: i64,
        tags: &str,
        notes: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO collection_entries
               (card_id, set_code, collector_number, lang, finish, condition, condition_original,
                quantity, tradelist_quantity, purchase_price, purchase_currency, acquired_at,
                acquisition_source, notes, tags, serial_number, grading, altered, signed, proxy,
                misprint, needs_review, folder_id, created_at, updated_at, sync_uid)
             SELECT ?1, coalesce(c.set_code, 'xxx'), coalesce(c.collector_number, '0'), ?2, ?3,
                    ?4, 'private-graded-GD', ?5, 7, 9.99, 'private-currency-DKK',
                    'private-acquired-2019-08-02', 'private-source GP Copenhagen', ?6, ?7,
                    'private-serial-042/500', '{\"company\":\"private-grader\",\"grade\":10}',
                    1, 1, 1, 1, 'private-review', ?8, 0, 0, ?9
               FROM (SELECT 1) LEFT JOIN cards c ON c.id = ?1",
            params![card_id, lang, finish, condition, quantity, notes, tags, folder, uid],
        )
        .unwrap();
    }

    const FURY: &str = "0000579f-7b35-4ed3-b44c-db2a538066fe";
    const TUNDRA: &str = "56ebc372-aabd-4174-a943-c7bf59e5028d";
    const KRENKO: &str = "5d8a1ab2-4c53-4b2b-a9e4-1e3c0e7d2f01";
    const BOLT: &str = "e3285e6b-3e79-4d7c-bf96-d920f973b80d";
    /// A printing that has left the corpus — still a card the reader owns.
    const GONE: &str = "0000dead-0000-4000-8000-000000000000";

    /// **The golden's database.** Every row a projection must carry and every row it must not:
    ///
    /// * collection — nested folders, a locked folder and a folder under it (locked by
    ///   inheritance), `Recently removed`, a copy at the root, each finish, a copy with condition,
    ///   lang, price, entry tags and an entry note, a copy with none of them (an orphan, ungraded,
    ///   no entry tags, a blank entry note), an empty pile (`quantity = 0`) and a row with no uid;
    /// * wishlist — a folder and its child, a wish by printing with entry tags and an entry note
    ///   and an any-printing wish with neither, and a deck's managed folder with a wish in it
    ///   (derived — **never projected**);
    /// * decks — a deck in a deck folder with a cover, two piles of the live list and a pile that
    ///   is switched off, and a theory row (**never projected**).
    fn fixture() -> Connection {
        let conn = crate::schema::memory_pair();
        card(&conn, FURY, "Fury Sliver", "tsp", "157");
        card(&conn, TUNDRA, "Tundra", "lea", "283");
        card(&conn, KRENKO, "Krenko, Mob Boss", "m13", "139");
        card(&conn, BOLT, "Lightning Bolt", "lea", "161");
        conn.execute_batch(&format!(
            "UPDATE cards SET oracle_id = 'oracle-bolt', type_line = 'Instant', mana_cost = '{{R}}',
                              cmc = 1.0, artist = 'Christopher Rush',
                              image_uris = json_set(image_uris, '$.art',
                                  'https://cards.scryfall.io/art_crop/front/e/3/{BOLT}.jpg?1757308800')
              WHERE id = '{BOLT}';
             UPDATE cards SET type_line = 'Legendary Creature — Goblin Warrior',
                              mana_cost = '{{2}}{{R}}{{R}}', cmc = 4.0
              WHERE id = '{KRENKO}';
             UPDATE cards SET type_line = 'Creature — Sliver', mana_cost = '{{3}}{{R}}', cmc = 4.0
              WHERE id = '{FURY}';
             UPDATE collection_folders SET sync_uid = 'fold-removed' WHERE kind = 'removed';"
        ))
        .unwrap();

        let binder = folder(&conn, None, "Trade binder", "fold-binder", false);
        let duals = folder(&conn, Some(binder), "Duals", "fold-duals", false);
        let vault = folder(&conn, None, "Vault", "fold-vault", true);
        let shelf = folder(&conn, Some(vault), "Top shelf", "fold-shelf", false);
        let tags = r#"["cube","trade"]"#;
        let note = Some("from a booster");
        entry(
            &conn,
            Some("entry-1"),
            FURY,
            Some(binder),
            "nonfoil",
            "NM",
            "en",
            2,
            tags,
            note,
        );
        entry(
            &conn,
            Some("entry-2"),
            TUNDRA,
            Some(duals),
            "foil",
            "LP",
            "de",
            1,
            "[]",
            None,
        );
        entry(
            &conn,
            Some("entry-3"),
            BOLT,
            Some(shelf),
            "etched",
            "MP",
            "en",
            1,
            "[]",
            None,
        );
        entry(
            &conn,
            Some("entry-4"),
            GONE,
            None,
            "nonfoil",
            "NONE",
            "en",
            3,
            "[]",
            Some("  "),
        );
        entry(
            &conn,
            Some("entry-5"),
            KRENKO,
            Some(binder),
            "nonfoil",
            "NM",
            "en",
            0,
            "[]",
            None,
        );
        entry(
            &conn,
            None,
            KRENKO,
            Some(binder),
            "nonfoil",
            "LP",
            "en",
            1,
            "[]",
            None,
        );

        conn.execute_batch(
            "INSERT INTO wishlist_folders
               (parent_id, name, sort_order, created_at, updated_at, sync_uid)
             VALUES (NULL, 'Buy list', 0, 0, 0, 'wfold-buy');
             INSERT INTO wishlist_folders
               (parent_id, name, sort_order, created_at, updated_at, sync_uid)
             VALUES ((SELECT id FROM wishlist_folders WHERE sync_uid = 'wfold-buy'), 'Soon', 0, 0,
                     0, 'wfold-soon');",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO wishlist_entries
               (oracle_id, card_id, set_code, collector_number, name, quantity, preferred_finish,
                notes, tags, needs_review, created_at, updated_at, folder_id, sync_uid)
             VALUES (NULL, ?1, 'lea', '283', 'Tundra', 1, 'foil', 'for the cube',
                     '[\"cube\",\"next payday\"]', 'private-review',
                     0, 0, (SELECT id FROM wishlist_folders WHERE sync_uid = 'wfold-soon'),
                     'wish-1')",
            params![TUNDRA],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO wishlist_entries
               (oracle_id, card_id, name, quantity, created_at, updated_at, folder_id, sync_uid)
             VALUES ('oracle-bolt', NULL, 'Lightning Bolt', 4, 0, 0, NULL, 'wish-2')",
            [],
        )
        .unwrap();

        let deck = crate::deck::create_deck(
            &conn,
            &crate::deck::DeckInput {
                name: "Krenko's Goblins".to_owned(),
                format_key: "commander".to_owned(),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        conn.execute(
            "INSERT INTO deck_folders (parent_id, name, sort_order, created_at, updated_at, sync_uid)
             VALUES (NULL, 'Tribal', 0, 0, 0, 'dfold-tribal')",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE decks SET sync_uid = 'deck-krenko', cover_card_id = ?2,
                              folder_id = (SELECT id FROM deck_folders WHERE sync_uid = 'dfold-tribal'),
                              description = 'private-description', tags = '[\"private-tag\"]'
              WHERE id = ?1",
            params![deck, BOLT],
        )
        .unwrap();
        let pile = |kind: &str| -> i64 {
            conn.query_row(
                "SELECT id FROM deck_categories
                  WHERE deck_id = ?1 AND kind = ?2 AND variant = 'live'",
                params![deck, kind],
                |r| r.get(0),
            )
            .unwrap()
        };
        let burn = crate::deck_meta::create_category(&conn, deck, "live", "Burn")
            .unwrap()
            .id;
        let put = |card: &str, pile: i64, qty: i64| {
            crate::deck::add_card(&conn, deck, card, Some(pile), None, "live", None, qty).unwrap();
        };
        put(KRENKO, pile("commander"), 1);
        put(BOLT, burn, 4);
        put(FURY, pile("maybe"), 1);
        put(TUNDRA, burn, 1);
        conn.execute(
            "UPDATE deck_cards SET variant = 'theory' WHERE card_id = ?1",
            params![TUNDRA],
        )
        .unwrap();
        conn.execute(
            "UPDATE deck_cards SET sync_uid = 'dc-' || substr(card_id, 1, 8),
                                   needs_review = 'private-review'
              WHERE deck_id = ?1",
            params![deck],
        )
        .unwrap();

        // The deck's managed wishlist folder and a wish in it — derived on every device and never
        // projected. **Each carries a uid**, the kind one device minted for itself alone
        // (`share::wishlist`'s doc: NULL or random per device), so it is the managed-folder clause
        // that leaves them out and not the missing uid.
        conn.execute(
            "INSERT INTO wishlist_folders
               (parent_id, name, sort_order, created_at, updated_at, managed_deck_id, managed_tokens,
                sync_uid)
             VALUES (NULL, 'Krenko''s Goblins', 0, 0, 0, ?1, 0, 'mfold-this-device-only')",
            params![deck],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO wishlist_entries
               (oracle_id, name, quantity, created_at, updated_at, folder_id, sync_uid)
             VALUES ('oracle-recruiter', 'Goblin Recruiter', 1, 0, 0, last_insert_rowid(),
                     'mwish-this-device-only')",
            [],
        )
        .unwrap();
        conn
    }

    /// The six documents of `conn` under `fields`, at TCGplayer.
    fn docs(conn: &Connection, fields: IntegrationFields) -> Vec<TableDoc> {
        project_all(conn, fields, Marketplace::Tcgplayer).unwrap()
    }

    /// One table of `conn`, every field on, at TCGplayer, as JSON.
    fn table(conn: &Connection, table: &str) -> serde_json::Value {
        serde_json::to_value(project(conn, table, EVERY, Marketplace::Tcgplayer).unwrap()).unwrap()
    }

    fn rows(doc: &serde_json::Value) -> &Vec<serde_json::Value> {
        doc["rows"].as_array().unwrap()
    }

    /// The golden: an object keyed by table, in [`TABLES`]' order, every field on.
    #[derive(Serialize)]
    struct Golden {
        collection_folders: TableDoc,
        collection_entries: TableDoc,
        wishlist_folders: TableDoc,
        wishlist_entries: TableDoc,
        decks: TableDoc,
        deck_cards: TableDoc,
    }

    /// **The fence on the wire format**, `share::tests::the_golden_snapshot_is_what_the_writer_produces`'
    /// twin: the integrations Worker's suite ingests this very file and refuses a row key outside
    /// its table's list, so the two sides agree on `Projection v1` through it. Byte equality,
    /// because a rename, a reordered field and a key that silently stopped being emitted are all
    /// invisible to a field-by-field check.
    ///
    /// **A change here is a change to a wire another deploy reads**: regenerate the file from the
    /// `got` this prints, read the diff, and change the Worker's row-key lists in the same commit.
    #[test]
    fn the_golden_projection_is_what_the_projector_produces() {
        let conn = fixture();
        let mut all = docs(&conn, EVERY).into_iter();
        let mut next = || all.next().unwrap();
        let golden = Golden {
            collection_folders: next(),
            collection_entries: next(),
            wishlist_folders: next(),
            wishlist_entries: next(),
            decks: next(),
            deck_cards: next(),
        };
        let got = serde_json::to_string_pretty(&golden).unwrap();
        let want = include_str!("../__golden__/projection.json");
        // `\r\n` is what a Windows checkout can hand back; the committed file is LF.
        assert_eq!(got.trim_end(), want.replace("\r\n", "\n").trim_end());
    }

    /// The rows a projection must never carry, named — the golden pins them by their absence, and
    /// this says which absence each one is.
    #[test]
    fn derived_planned_empty_and_uidless_rows_are_not_projected() {
        let conn = fixture();
        let text = serde_json::to_string(&docs(&conn, EVERY)).unwrap();
        // The managed wishlist folder and its wish: derived from the deck, which is projected.
        assert!(!text.contains("Goblin Recruiter"), "{text}");
        assert!(!text.contains("oracle-recruiter"), "{text}");
        let wish_folders = table(&conn, "wishlist_folders");
        assert_eq!(rows(&wish_folders).len(), 2, "{wish_folders}");
        // The theory row: a plan the reader has not built.
        let deck_cards = table(&conn, "deck_cards");
        let names: Vec<&str> = rows(&deck_cards)
            .iter()
            .map(|r| r["name"].as_str().unwrap())
            .collect();
        assert!(!names.contains(&"Tundra"), "{names:?}");
        assert_eq!(names.len(), 3, "{names:?}");
        // The empty pile, and the copy with no uid.
        let entries = table(&conn, "collection_entries");
        let uids: Vec<&str> = rows(&entries)
            .iter()
            .map(|r| r["uid"].as_str().unwrap())
            .collect();
        assert_eq!(uids, ["entry-1", "entry-2", "entry-3", "entry-4"]);
        // And nothing the fixture marked private, from any table.
        assert!(!text.contains("private-"), "{text}");
        assert!(!text.contains("9.99"), "{text}");
    }

    /// **The store is private, so a locked drawer is in it** — and says so, by inheritance too, so
    /// a reader never has to walk the tree to know which drawers were set aside.
    #[test]
    fn locked_folders_are_projected_with_their_effective_lock() {
        let conn = fixture();
        let doc = table(&conn, "collection_folders");
        let locked: Vec<(&str, bool)> = rows(&doc)
            .iter()
            .map(|r| (r["uid"].as_str().unwrap(), r["locked"].as_bool().unwrap()))
            .collect();
        assert_eq!(
            locked,
            [
                ("fold-binder", false),
                ("fold-duals", false),
                ("fold-removed", false),
                ("fold-shelf", true),
                ("fold-vault", true),
            ]
        );
    }

    /// **A switch that is off is a key that is absent** — from every row, not `null` — and the
    /// document's `fields` says which were asked. On, each key appears where there is a value and
    /// nowhere else: the orphan carries no value, the ungraded copy no condition, the blank entry
    /// note and the empty entry tags nothing at all.
    #[test]
    fn an_opt_in_key_is_absent_when_its_field_is_off_or_its_value_is() {
        let conn = fixture();
        for doc in docs(&conn, IntegrationFields::default()) {
            let text = serde_json::to_string(&doc).unwrap();
            assert!(text.contains("\"fields\":[]"), "{text}");
            for key in ["condition", "lang", "value", "tags", "notes"] {
                assert!(
                    !text.contains(&format!("\"{key}\":")),
                    "{key} in {}: {text}",
                    doc.table
                );
            }
        }
        let entries = table(&conn, "collection_entries");
        let rows = rows(&entries);
        assert_eq!(
            entries["fields"],
            serde_json::json!(["condition", "lang", "value", "tags", "notes"])
        );
        assert_eq!(rows[0]["tags"], serde_json::json!(["cube", "trade"]));
        assert_eq!(rows[0]["notes"], "from a booster");
        assert_eq!(rows[0]["value"], 0.34);
        assert_eq!(rows[1]["value"], 1.25, "the foil price for a foil copy");
        assert_eq!(rows[2]["value"], 2.5, "the etched price for an etched copy");
        let orphan = rows[3].as_object().unwrap();
        assert_eq!(orphan["name"], GONE, "the id stands in for the name");
        for absent in ["condition", "value", "tags", "notes", "image"] {
            assert!(!orphan.contains_key(absent), "{absent}: {orphan:?}");
        }
        assert_eq!(orphan["lang"], "en");

        // The wish's entry tags, under the same switch, and none on the wish that has none.
        let wishes = table(&conn, "wishlist_entries");
        let wishes = wishes["rows"].as_array().unwrap();
        let tundra = wishes.iter().find(|w| w["uid"] == "wish-1").unwrap();
        assert_eq!(tundra["tags"], serde_json::json!(["cube", "next payday"]));
        let bolt = wishes.iter().find(|w| w["uid"] == "wish-2").unwrap();
        assert!(!bolt.as_object().unwrap().contains_key("tags"), "{bolt}");
    }

    /// **Same rows, same bytes, whatever order a device inserted them in** — the property the
    /// store's digest comparison rests on. Two databases holding the same synced rows under
    /// different local ids (the second inserted back to front) project to one document; an
    /// `ORDER BY id` here would have each device republish over the other on every round.
    #[test]
    fn two_devices_holding_the_same_rows_write_the_same_document() {
        let build = |reversed: bool| {
            let conn = crate::schema::memory_pair();
            card(&conn, FURY, "Fury Sliver", "tsp", "157");
            card(&conn, TUNDRA, "Tundra", "lea", "283");
            let mut seeded = vec![
                ("entry-a", TUNDRA, "nonfoil"),
                ("entry-b", FURY, "nonfoil"),
                ("entry-c", TUNDRA, "foil"),
            ];
            if reversed {
                seeded.reverse();
            }
            for (uid, card, finish) in seeded {
                entry(
                    &conn,
                    Some(uid),
                    card,
                    None,
                    finish,
                    "NM",
                    "en",
                    1,
                    "[]",
                    None,
                );
            }
            project(&conn, "collection_entries", EVERY, Marketplace::Tcgplayer).unwrap()
        };
        let (one, other) = (build(false), build(true));
        assert_eq!(
            serde_json::to_string(&one).unwrap(),
            serde_json::to_string(&other).unwrap()
        );
        assert_eq!(digest(&one).unwrap(), digest(&other).unwrap());
    }

    /// The digest moves with what a reader would see — a copy more, a field switched off — and
    /// with nothing else: an unchanged table digests alike on every read, and a row's own clock is
    /// not content.
    #[test]
    fn the_digest_moves_with_the_rows_and_the_policy_and_nothing_else() {
        let conn = fixture();
        let read =
            |fields| project(&conn, "collection_entries", fields, Marketplace::Tcgplayer).unwrap();
        let first = digest(&read(EVERY)).unwrap();
        assert_eq!(digest(&read(EVERY)).unwrap(), first, "nothing moved");
        assert_eq!(first.len(), 64);
        assert!(first
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        let narrower = IntegrationFields {
            notes: false,
            ..EVERY
        };
        assert_ne!(digest(&read(narrower)).unwrap(), first, "a field off");
        conn.execute(
            "UPDATE collection_entries SET quantity = 9 WHERE sync_uid = 'entry-2'",
            [],
        )
        .unwrap();
        let moved = digest(&read(EVERY)).unwrap();
        assert_ne!(moved, first, "a copy more");
        conn.execute("UPDATE collection_entries SET updated_at = 99", [])
            .unwrap();
        assert_eq!(
            digest(&read(EVERY)).unwrap(),
            moved,
            "a clock is not content"
        );
    }

    /// The gzip is the document's JSON, whole.
    #[test]
    fn the_gzip_is_the_documents_json() {
        use std::io::Read;
        let conn = fixture();
        let doc = project(&conn, "decks", EVERY, Marketplace::Tcgplayer).unwrap();
        let mut text = String::new();
        flate2::read::GzDecoder::new(&gzip_doc(&doc).unwrap()[..])
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, serde_json::to_string(&doc).unwrap());
    }

    #[test]
    fn a_table_that_is_not_projected_is_refused_by_name() {
        let conn = fixture();
        let err = project(&conn, "deck_notes", EVERY, Marketplace::Tcgplayer).unwrap_err();
        assert!(err.contains("deck_notes"), "{err}");
    }

    /// The order is the format's, spelled here rather than read back from `names()`.
    #[test]
    fn the_field_names_are_the_formats_five_in_order() {
        assert_eq!(
            EVERY.names(),
            ["condition", "lang", "value", "tags", "notes"]
        );
        assert!(IntegrationFields::default().names().is_empty());
        let lang = IntegrationFields {
            lang: true,
            ..Default::default()
        };
        assert_eq!(lang.names(), ["lang"]);
        assert_eq!(
            serde_json::to_value(lang).unwrap(),
            serde_json::json!({
                "condition": false, "lang": true, "value": false, "tags": false, "notes": false
            })
        );
    }

    // -----------------------------------------------------------------------------------
    // The column fence
    // -----------------------------------------------------------------------------------

    /// What becomes of one column of a projected table.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Class {
        /// It reaches the document, under its own name or another (`sync_uid` as `uid`).
        Carried,
        /// It never does, and why.
        Absent(&'static str),
    }
    use Class::{Absent, Carried};

    const LOCAL_ID: Class = Absent("a local row id, which names a row on no other device");
    const CLOCK: Class =
        Absent("a clock: the document carries none, so an unchanged table digests alike");
    const REVIEW: Class = Absent("`needs_review`: absent from the format, never a switch");
    const ORDER: Class = Absent("the reader's own arrangement; a table's rows are ordered by uid");
    const VIEW: Class = Absent("the deck editor's view state");
    const NOT_A_KEY: Class = Absent("not one of Projection v1's row keys");

    /// **Every column of every projected table, classified.** A column is `Carried` — it reaches a
    /// document — or `Absent` with the reason it never does. `deck_categories` is here because the
    /// deck cards read it: a pile's name, role and switch ride on each card.
    const CLASSIFIED: [(&str, &[(&str, Class)]); 7] = [
        (
            "collection_folders",
            &[
                ("id", LOCAL_ID),
                ("parent_id", Carried),
                ("name", Carried),
                ("kind", Carried),
                (
                    "deck_id",
                    Absent("the deck a group folder stands for: `kind` says it is one"),
                ),
                ("sort_order", ORDER),
                ("created_at", CLOCK),
                ("updated_at", CLOCK),
                ("sync_uid", Carried),
                ("needs_review", REVIEW),
                ("locked", Carried),
                (
                    "rules",
                    Absent("folder rules: the reader's advice to themselves"),
                ),
            ],
        ),
        (
            "collection_entries",
            &[
                ("id", LOCAL_ID),
                ("card_id", Carried),
                ("set_code", Carried),
                ("collector_number", Carried),
                ("lang", Carried),
                ("finish", Carried),
                ("condition", Carried),
                (
                    "condition_original",
                    Absent("the import file's own words, before the grade was normalised"),
                ),
                ("quantity", Carried),
                ("tradelist_quantity", NOT_A_KEY),
                (
                    "purchase_price",
                    Absent("purchase price: absent from the format, never a switch"),
                ),
                (
                    "purchase_currency",
                    Absent("purchase currency: absent from the format, never a switch"),
                ),
                (
                    "acquired_at",
                    Absent("acquired-at: absent from the format, never a switch"),
                ),
                (
                    "acquisition_source",
                    Absent("acquisition source: absent from the format, never a switch"),
                ),
                (
                    "serial_number",
                    Absent("serial number: absent from the format, never a switch"),
                ),
                ("altered", NOT_A_KEY),
                ("signed", NOT_A_KEY),
                ("proxy", NOT_A_KEY),
                ("misprint", NOT_A_KEY),
                (
                    "grading",
                    Absent("grading: absent from the format, never a switch"),
                ),
                ("tags", Carried),
                ("notes", Carried),
                ("needs_review", REVIEW),
                ("created_at", CLOCK),
                ("updated_at", CLOCK),
                ("folder_id", Carried),
                ("sync_uid", Carried),
            ],
        ),
        (
            "wishlist_folders",
            &[
                ("id", LOCAL_ID),
                ("parent_id", Carried),
                ("name", Carried),
                ("sort_order", ORDER),
                ("created_at", CLOCK),
                ("updated_at", CLOCK),
                ("sync_uid", Carried),
                ("needs_review", REVIEW),
                (
                    "managed_deck_id",
                    Absent("what leaves a managed folder out: derived from its deck"),
                ),
                (
                    "managed_tokens",
                    Absent("a managed folder's Tokens child: derived, not projected"),
                ),
                (
                    "rules",
                    Absent("folder rules: the reader's advice to themselves"),
                ),
            ],
        ),
        (
            "wishlist_entries",
            &[
                ("id", LOCAL_ID),
                ("oracle_id", Carried),
                ("card_id", Carried),
                ("set_code", Carried),
                ("collector_number", Carried),
                ("lang", Carried),
                ("name", Carried),
                ("quantity", Carried),
                ("preferred_finish", Carried),
                ("notes", Carried),
                ("tags", Carried),
                ("needs_review", REVIEW),
                ("created_at", CLOCK),
                ("updated_at", CLOCK),
                ("folder_id", Carried),
                ("sync_uid", Carried),
            ],
        ),
        (
            "decks",
            &[
                ("id", LOCAL_ID),
                ("name", Carried),
                ("format_key", Carried),
                (
                    "description",
                    Absent("the deck description: absent from the format, never a switch"),
                ),
                (
                    "cover_kind",
                    Absent("a custom cover is a file on this device; the card art is carried"),
                ),
                ("cover_card_id", Carried),
                ("cover_image_path", Absent("a path on this device's disk")),
                ("archived", NOT_A_KEY),
                ("created_at", CLOCK),
                ("updated_at", CLOCK),
                ("folder_id", Carried),
                (
                    "theory_enabled",
                    Absent("the deck's plan, which is not projected"),
                ),
                ("last_variant", VIEW),
                ("last_group_by", VIEW),
                ("last_sort_by", VIEW),
                ("separate_x_group", VIEW),
                (
                    "default_category_id",
                    Absent("the pile a new card lands in: the editor's default, a local id"),
                ),
                ("game_key", NOT_A_KEY),
                ("bracket", NOT_A_KEY),
                ("sync_uid", Carried),
                ("tokens_open", VIEW),
                ("theory_mark_exact", VIEW),
                ("theory_mark_name", VIEW),
                ("theory_mark_unplanned", VIEW),
                ("virtual_only", NOT_A_KEY),
                ("stats_open", VIEW),
                ("notes_open", VIEW),
                (
                    "managed_wishlist_mode",
                    Absent("drives the managed wishlist, which is derived and not projected"),
                ),
                ("token_rail_index", VIEW),
                ("token_mode", VIEW),
                ("curve_creatures", VIEW),
                (
                    "managed_wishlist_tokens",
                    Absent("drives the managed wishlist, which is derived and not projected"),
                ),
                ("todos_open", VIEW),
                (
                    "tags",
                    Absent("deck tags: absent from the format, never a switch"),
                ),
            ],
        ),
        (
            "deck_cards",
            &[
                ("id", LOCAL_ID),
                ("deck_id", Carried),
                ("category_id", Carried),
                (
                    "variant",
                    Absent("the filter: only the live list is projected"),
                ),
                ("card_id", Carried),
                ("set_code", Carried),
                ("collector_number", Carried),
                ("lang", Carried),
                ("name", Carried),
                (
                    "label_id",
                    Absent("deck labels: absent from the format, never a switch"),
                ),
                ("quantity", Carried),
                ("needs_review", REVIEW),
                ("created_at", CLOCK),
                ("updated_at", CLOCK),
                ("finish", Carried),
                ("sync_uid", Carried),
            ],
        ),
        (
            "deck_categories",
            &[
                ("id", LOCAL_ID),
                (
                    "deck_id",
                    Absent("implied: a pile is read through a card filed in it"),
                ),
                ("name", Carried),
                ("kind", Carried),
                ("is_active", Carried),
                ("sort_order", ORDER),
                ("created_at", CLOCK),
                ("updated_at", CLOCK),
                ("origin", NOT_A_KEY),
                (
                    "sync_uid",
                    Absent("a pile rides on each card by name, not as a row of its own"),
                ),
                (
                    "variant",
                    Absent("the filter: only the live list's piles hold a projected card"),
                ),
            ],
        ),
    ];

    /// **The fence that keeps the format a decision.** Every column of every projected table, at
    /// head, must be on [`CLASSIFIED`] as carried or absent — so a column added to one of these
    /// tables fails here until somebody decides whether a server-side reader may see it, rather
    /// than reaching the store, or silently missing it, by default.
    #[test]
    fn every_projected_column_is_classified() {
        let conn = crate::schema::memory_pair();
        let mut problems = Vec::new();
        for (table, classified) in CLASSIFIED {
            let mut stmt = conn
                .prepare(&format!("PRAGMA main.table_info(\"{table}\")"))
                .unwrap();
            let columns: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            assert!(!columns.is_empty(), "{table} has no columns at head");
            for column in &columns {
                if !classified.iter().any(|(name, _)| name == column) {
                    problems.push(format!(
                        "{table}.{column} is not classified: put it on `CLASSIFIED` as \
                         `Absent(\"<why>\")`, or as `Carried` and project it — and then update the \
                         golden `__golden__/projection.json` and the integrations Worker's row keys"
                    ));
                }
            }
            for (name, _) in classified.iter() {
                if !columns.iter().any(|c| c == name) {
                    problems.push(format!(
                        "{table}.{name} is classified but the table has no such column: take it \
                         off `CLASSIFIED` (and out of the projection and its golden if it was \
                         carried)"
                    ));
                }
            }
        }
        assert!(problems.is_empty(), "\n{}", problems.join("\n"));
        // Every table the projection documents is fenced, and the one it reads beside them.
        for table in TABLES {
            assert!(
                CLASSIFIED.iter().any(|(t, _)| *t == table),
                "{table} is not fenced"
            );
        }
        assert_eq!(CLASSIFIED.len(), TABLES.len() + 1);
    }

    // -----------------------------------------------------------------------------------
    // The measurement
    // -----------------------------------------------------------------------------------

    /// What a whole-table republish of `collection_entries` costs, at three sizes — spec §6.1's
    /// "move to row deltas only if a measured collection makes the whole-table republish hurt".
    /// **It prints rather than asserts**, so it reports rather than rots; `#[ignore]`d, because
    /// fifty thousand rows is not a unit test. Run it in release:
    ///
    /// ```text
    /// cargo test -p grimoire-core --release -- --ignored a_whole_collection_projection_is_measured --nocapture
    /// ```
    ///
    /// **The fixture is `share::tests::a_thousand_card_snapshot_is_measured`'s**, and for its
    /// reason: uuid-shaped ids, distinct names, climbing collector numbers, four sets, three
    /// finishes and the five grades, because DEFLATE erases a thousand identical rows to nothing
    /// and a figure taken over them would understate a real collection. Each row has a uid shaped
    /// as the app mints them (32 hex digits).
    #[test]
    #[ignore = "a measurement: run it in release with --nocapture"]
    fn a_whole_collection_projection_is_measured() {
        const SETS: [&str; 4] = ["tsp", "mh3", "otj", "lci"];
        const FINISHES: [&str; 3] = ["nonfoil", "foil", "etched"];
        const GRADES: [&str; 5] = ["NM", "LP", "MP", "HP", "DMG"];
        for n in [1_000usize, 10_000, 50_000] {
            let conn = crate::schema::memory_pair();
            let binder = folder(
                &conn,
                None,
                "Binder",
                "9e3779b97f4a7c15f39cc0605cedc834",
                false,
            );
            let tx = conn.unchecked_transaction().unwrap();
            {
                let mut cards = tx
                    .prepare(
                        "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw,
                                            image_uris, prices)
                         VALUES (?1, ?2, ?3, ?4, 'en', 'normal', '{}',
                                 json_object('display', ?5),
                                 json_object('usd', ?6, 'usd_foil', ?6, 'usd_etched', ?6))",
                    )
                    .unwrap();
                let mut entries = tx
                    .prepare(
                        "INSERT INTO collection_entries
                           (card_id, set_code, collector_number, lang, finish, condition, quantity,
                            tradelist_quantity, folder_id, created_at, updated_at, sync_uid)
                         VALUES (?1, ?2, ?3, 'en', ?4, ?5, ?6, 0, ?7, 0, 0, ?8)",
                    )
                    .unwrap();
                for i in 0..n {
                    let k = i as u32 + 1;
                    let (a, b, c, d) = (
                        0x9e37_79b9u32.wrapping_mul(k),
                        0x85eb_ca6bu32.wrapping_mul(k),
                        0xc2b2_ae35u32.wrapping_mul(k),
                        0x27d4_eb2fu32.wrapping_mul(k),
                    );
                    let id = format!(
                        "{a:08x}-{:04x}-{:04x}-{:04x}-{:04x}{d:08x}",
                        b >> 16,
                        b & 0xffff,
                        c >> 16,
                        c & 0xffff
                    );
                    let uid = format!(
                        "{:08x}{:08x}{:08x}{:08x}",
                        0x1656_67b1u32.wrapping_mul(k),
                        0xd3a2_646cu32.wrapping_mul(k),
                        0xfd70_46c5u32.wrapping_mul(k),
                        0xb55a_4f09u32.wrapping_mul(k)
                    );
                    let set = SETS[i % SETS.len()];
                    let cn = (i + 1).to_string();
                    cards
                        .execute(params![
                            id,
                            format!("Test Card {i} of the Measured Binder"),
                            set,
                            cn,
                            display_uri(&id),
                            format!("{}.{:02}", i % 40, i % 100),
                        ])
                        .unwrap();
                    entries
                        .execute(params![
                            id,
                            set,
                            cn,
                            FINISHES[i % FINISHES.len()],
                            GRADES[i % GRADES.len()],
                            (i % 4 + 1) as i64,
                            binder,
                            uid
                        ])
                        .unwrap();
                }
            }
            tx.commit().unwrap();

            for (label, fields) in [
                ("fields off", IntegrationFields::default()),
                ("every field", EVERY),
            ] {
                let began = crate::platform::clock::Tick::now();
                let doc =
                    project(&conn, "collection_entries", fields, Marketplace::Tcgplayer).unwrap();
                let _digest = digest(&doc).unwrap();
                let gz = gzip_doc(&doc).unwrap();
                let took = began.elapsed();
                let raw = serde_json::to_vec(&doc).unwrap().len();
                assert_eq!(doc.rows.len(), n, "every seeded row is projected");
                println!(
                    "{n:>6} rows, {label:<11}: {raw:>10} B raw, {:>9} B gzipped, \
                     {:>6.1} B/card raw, {:>5.1} B/card gzipped, project+digest+gzip {:>7.1} ms",
                    gz.len(),
                    raw as f64 / n as f64,
                    gz.len() as f64 / n as f64,
                    took.as_secs_f64() * 1000.0
                );
            }
        }
    }
}
