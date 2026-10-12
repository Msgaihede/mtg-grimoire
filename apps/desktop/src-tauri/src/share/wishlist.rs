//! A wishlist's share — the whole list, one folder, or a deck's managed wishlist (issue #941).
//!
//! ## One namespace, one more cabinet
//!
//! **A share names what it publishes by one opaque string**, `folderUid` on the wire and
//! `collection_shares.folder_uid` in the cache, and neither the relay nor the share Worker reads
//! it — they key one live share per group on it and nothing more. So a wishlist share needs no
//! new column, no schema rung and no Worker deploy: it is a **key** in that same namespace, and
//! the [`PREFIX`] is what tells this reader from the collection's. A collection folder's uid is
//! 32 hex characters and can never begin with `wishlist:`, so the two cannot collide.
//!
//! | Key | Publishes |
//! | --- | --- |
//! | `wishlist:` | The whole wishlist — the root and every folder the reader made |
//! | `wishlist:folder:<sync_uid>` | One folder the reader made, and everything under it |
//! | `wishlist:deck:<decks.sync_uid>` | A deck's managed wishlist, its Tokens child included |
//! | `wishlist:deck-tokens:<decks.sync_uid>` | A deck's managed Tokens folder alone |
//!
//! **A managed folder is named by its deck and never by its own uid**, and that is the one
//! decision here that is not obvious. `crate::managed_wishlist` derives the folder on every device
//! and syncs none of it, so its `sync_uid` is NULL or random per device and is thrown away with
//! the folder whenever the deck's mode goes `off` and back. The deck's uid is synced: a second
//! device in the group resolves the same key to its own copy of the folder, and *Update* keeps
//! working there. `packages/ui/features/wishlist/wishlistShare.ts` spells the same four keys.
//!
//! ## What is the same as a collection share, and what is not
//!
//! **The unasked question publishes less here too.** A whole-wishlist share leaves the managed
//! folders out — they are the app's derivation of a deck, and a refresh would otherwise grow by
//! every theory deck the reader switches on. Named, a managed folder is the reader's own choice.
//!
//! **There is no lock**: `wishlist_folders` has no `locked` column, so there is no refusal to make
//! beyond [`WISHLIST_FOLDER_NOT_FOUND`].
//!
//! **A wish is not a copy**, so three of the card's keys are a translation and one is dropped:
//!
//! * `id`, `s`, `cn` — an any-printing wish is drawn as the printing the wishlist itself draws and
//!   prices it as (`wishlist::priced_wishes`' join), so a viewer sees the art the reader sees.
//! * `f` — `preferred_finish`, and `nonfoil` where the wish has no preference.
//! * `c` — **never**. A wish has no condition, so `condition` is dropped from `fields` too: a
//!   snapshot claiming to carry it on cards that never have one would read as "all ungraded".
//!
//! `notes` and `needs_review` are free text on a wish exactly as they are on a copy, and are read
//! by nothing here.

use rusqlite::{params, Connection, OptionalExtension};

use super::snapshot::{currency, marketplace_id};
use super::{ShareCard, ShareFields, ShareFolder, ShareSnapshot, SNAPSHOT_VERSION};

/// What every wishlist key begins with.
pub const PREFIX: &str = "wishlist:";

/// What a whole-wishlist share is called. A folder share takes the folder's own name.
pub const WHOLE_WISHLIST_TITLE: &str = "Wishlist";

/// No folder answers to that key — a folder deleted since it was shared, or a deck whose managed
/// wishlist is switched off.
pub const WISHLIST_FOLDER_NOT_FOUND: &str = "That folder is not in this wishlist.";

/// One parsed key. See the module's table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WishlistKey<'a> {
    Whole,
    Folder(&'a str),
    Deck(&'a str),
    DeckTokens(&'a str),
}

impl<'a> WishlistKey<'a> {
    /// The key inside a share's `folderUid`, or `None` for anything that is not a wishlist key —
    /// a collection folder's uid, which the caller then resolves as one.
    ///
    /// **A key with the prefix and an unknown shape is still a wishlist key**, answered
    /// [`WISHLIST_FOLDER_NOT_FOUND`] rather than handed to the collection: a key a later build
    /// minted is a wishlist folder this build cannot find, never a binder.
    pub fn parse(raw: &'a str) -> Option<Result<WishlistKey<'a>, ()>> {
        let rest = raw.strip_prefix(PREFIX)?;
        let named = |tail: &'a str, make: fn(&'a str) -> WishlistKey<'a>| {
            (!tail.is_empty()).then(|| make(tail)).ok_or(())
        };
        Some(if rest.is_empty() {
            Ok(WishlistKey::Whole)
        } else if let Some(uid) = rest.strip_prefix("folder:") {
            named(uid, WishlistKey::Folder)
        } else if let Some(uid) = rest.strip_prefix("deck-tokens:") {
            named(uid, WishlistKey::DeckTokens)
        } else if let Some(uid) = rest.strip_prefix("deck:") {
            named(uid, WishlistKey::Deck)
        } else {
            Err(())
        })
    }
}

/// The folder a key names, as `(id, title)`, and `None` for the whole wishlist.
fn resolve(conn: &Connection, key: WishlistKey<'_>) -> Result<Option<(i64, String)>, String> {
    let named = |sql: &str, uid: &str| -> Result<Option<(i64, String)>, String> {
        conn.query_row(sql, params![uid], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(|e| e.to_string())?
            .map(Some)
            .ok_or_else(|| WISHLIST_FOLDER_NOT_FOUND.to_owned())
    };
    match key {
        WishlistKey::Whole => Ok(None),
        WishlistKey::Folder(uid) => named(
            "SELECT id, name FROM wishlist_folders WHERE sync_uid = ?1",
            uid,
        ),
        // `managed_tokens = 0` is what tells the deck's own folder from its child, which carries
        // the same `managed_deck_id` — `managed_wishlist::managed_folder`'s rule.
        WishlistKey::Deck(uid) => named(
            "SELECT f.id, f.name FROM wishlist_folders f JOIN decks d ON d.id = f.managed_deck_id
              WHERE d.sync_uid = ?1 AND f.managed_tokens = 0",
            uid,
        ),
        // The child is called `Tokens` at home, which is no name for a page a stranger opens —
        // so the share carries its deck's name with it.
        WishlistKey::DeckTokens(uid) => named(
            "SELECT f.id, d.name || ' tokens' FROM wishlist_folders f
               JOIN decks d ON d.id = f.managed_deck_id
              WHERE d.sync_uid = ?1 AND f.managed_tokens = 1",
            uid,
        ),
    }
}

/// The folders in the share. **`UNION`, never `UNION ALL`**, `snapshot::SUBTREE`'s reason: a
/// `parent_id` cycle converges instead of running forever.
///
/// The root arm keeps only folders the reader made (`managed_deck_id IS NULL`); a managed folder's
/// Tokens child hangs under its deck's folder, so leaving that out leaves the child out with it.
///
/// A folder with no `sync_uid` — a managed one, which is derived and never captured — is given a
/// random one for this snapshot alone. **Never its row id**: that names a row in a database no
/// other device has seen, and `snapshot::SubtreeFolder`'s rule is that it never reaches the wire.
const SUBTREE: &str = "WITH RECURSIVE subtree(id) AS (
        SELECT id FROM wishlist_folders
         WHERE (?1 IS NULL AND parent_id IS NULL AND managed_deck_id IS NULL) OR id = ?1
        UNION
        SELECT f.id FROM wishlist_folders f JOIN subtree s ON f.parent_id = s.id
    )
    SELECT f.id, coalesce(nullif(f.sync_uid, ''), lower(hex(randomblob(16)))), f.name, f.parent_id
      FROM wishlist_folders f
     WHERE f.id IN (SELECT id FROM subtree)
     ORDER BY f.sort_order, f.id";

/// Render the wishlist share `key` names as a snapshot — `super::snapshot`'s twin for the other
/// cabinet, with the same arguments and the same purity.
pub fn snapshot(
    conn: &Connection,
    id: &str,
    owner: &str,
    key: Result<WishlistKey<'_>, ()>,
    fields: ShareFields,
    marketplace: crate::sorting::Marketplace,
    now: i64,
) -> Result<ShareSnapshot, String> {
    let key = key.map_err(|()| WISHLIST_FOLDER_NOT_FOUND.to_owned())?;
    let named = resolve(conn, key)?;
    let root = named.as_ref().map(|(row, _)| *row);
    let title = named.map_or_else(|| WHOLE_WISHLIST_TITLE.to_owned(), |(_, name)| name);

    // `(id, uid, name, parent id)`. The parent stays a local id until it is mapped below, against
    // the published set, so a parent outside the share is no parent here.
    let mut stmt = conn.prepare(SUBTREE).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![root], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<i64>>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let uids: std::collections::HashMap<i64, &str> = rows
        .iter()
        .map(|(row, uid, _, _)| (*row, uid.as_str()))
        .collect();
    let folders = rows
        .iter()
        .map(|(_, uid, name, parent)| ShareFolder {
            uid: uid.clone(),
            name: name.clone(),
            parent: parent.and_then(|p| uids.get(&p)).map(|p| (*p).to_owned()),
        })
        .collect();

    let ids: Vec<i64> = rows.iter().map(|(row, ..)| *row).collect();
    // A wish carries no condition; see the module doc.
    let fields = ShareFields {
        condition: false,
        ..fields
    };
    let cards = read_wishes(conn, root.is_none(), &ids, &uids, fields, marketplace)?;

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

/// The wishes filed in `ids` — plus the root's, for a whole-wishlist share alone.
fn read_wishes(
    conn: &Connection,
    whole: bool,
    ids: &[i64],
    uids: &std::collections::HashMap<i64, &str>,
    fields: ShareFields,
    marketplace: crate::sorting::Marketplace,
) -> Result<Vec<ShareCard>, String> {
    // `w` and `c` are not free choices: `row_price_expr` writes `c.prices` for the printing and
    // the caller's finish column, and `crate::wishlist::WISH_PREFERRED_FINISH` is `w.`-qualified.
    let finish = crate::wishlist::WISH_PREFERRED_FINISH;
    let price = crate::sorting::row_price_expr(marketplace, finish);
    let image = crate::image_uri::front_face_selects("c").join(", ");
    let root_arm = if whole { "w.folder_id IS NULL OR " } else { "" };
    let holes = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    // Where the image pair begins. Written down for `snapshot::read_cards`' reason.
    const IMAGE_COL: usize = 9;
    // The printing an any-printing wish is drawn as is `crate::wishlist`'s own choice — cheapest
    // at this marketplace, then newest — so the share and the reader's list show one card.
    let sql = format!(
        "SELECT coalesce(w.card_id, c.id, w.oracle_id), coalesce(c.name, w.name),
                coalesce(w.set_code, c.set_code, ''), coalesce(w.collector_number, c.collector_number, ''),
                coalesce(w.lang, c.lang), coalesce({finish}, 'nonfoil'), w.quantity, w.folder_id,
                {price},
                {image}
           FROM wishlist_entries w
           LEFT JOIN cards c
             ON c.id = coalesce(w.card_id,
                    (SELECT c.id FROM cards c
                      WHERE c.oracle_id = w.oracle_id
                      ORDER BY ({price}) ASC NULLS LAST, c.released_at DESC, c.id ASC
                      LIMIT 1))
          WHERE ({root_arm}w.folder_id IN ({holes}))
          ORDER BY coalesce(c.name, w.name) ASC, coalesce(w.set_code, c.set_code, '') ASC,
                   CAST(coalesce(w.collector_number, c.collector_number) AS INTEGER) ASC, w.id ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), |r| {
            let folder: Option<i64> = r.get(7)?;
            Ok(ShareCard {
                id: r.get(0)?,
                n: r.get(1)?,
                s: r.get(2)?,
                cn: r.get(3)?,
                f: r.get(5)?,
                q: r.get(6)?,
                fo: folder.and_then(|f| uids.get(&f)).map(|u| (*u).to_owned()),
                img: crate::image_uri::front_face_uri(|i| r.get(IMAGE_COL + i))?,
                c: None,
                l: if fields.lang { r.get(4)? } else { None },
                // `Option<f64>` for `snapshot::read_cards`' reason: an unquoted printing is an
                // absent `p`, never a zero.
                p: if fields.value { r.get(8)? } else { None },
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}
