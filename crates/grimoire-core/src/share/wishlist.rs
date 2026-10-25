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
//!
//! **The folders and the wishes are read by [`crate::integration::projection`]** (spec §7.5), with
//! the SQL the projection reads the whole wishlist with; what stays here is the key and the folder
//! it names.

use rusqlite::{params, Connection, OptionalExtension};

use super::snapshot::{currency, marketplace_id};
use super::{ShareCard, ShareFields, ShareFolder, ShareSnapshot, SNAPSHOT_VERSION};
use crate::integration::projection::{self, EntryScope, WishFolderScope};
use crate::integration::readable::Unknown;

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
) -> Result<(ShareSnapshot, Unknown), String> {
    let key = key.map_err(|()| WISHLIST_FOLDER_NOT_FOUND.to_owned())?;
    let named = resolve(conn, key)?;
    let root = named.as_ref().map(|(row, _)| *row);
    let title = named.map_or_else(|| WHOLE_WISHLIST_TITLE.to_owned(), |(_, name)| name);

    // The folders, each parent already narrowed to the published set — a managed folder given a
    // uid for this snapshot alone, never its row id.
    let rows = projection::wishlist_folders(conn, WishFolderScope::Shared(root))?;
    let uids: std::collections::HashMap<i64, &str> =
        rows.iter().map(|f| (f.id, f.uid.as_str())).collect();
    let folders = rows
        .iter()
        .map(|f| ShareFolder {
            uid: f.uid.clone(),
            name: f.name.clone(),
            parent: f.parent_uid.clone(),
        })
        .collect();

    let ids: Vec<i64> = rows.iter().map(|f| f.id).collect();
    // A wish carries no condition; see the module doc.
    let fields = ShareFields {
        condition: false,
        ..fields
    };
    // The root's wishes for a whole-wishlist share alone.
    let scope = EntryScope::Folders {
        ids: &ids,
        root: root.is_none(),
    };
    let mut unknown = Unknown::default();
    let cards = projection::wishlist_entries(conn, scope, fields.carried(), marketplace)?
        .into_iter()
        .inspect(|w| unknown.add(w.printing))
        .map(|w| ShareCard {
            // An any-printing wish travels as the printing it is drawn as.
            id: w.drawn_id,
            n: w.name,
            s: w.set,
            cn: w.cn,
            f: w.finish,
            q: w.quantity,
            fo: w
                .folder_id
                .and_then(|f| uids.get(&f))
                .map(|u| (*u).to_owned()),
            img: w.image,
            c: None,
            l: w.lang,
            // `Option<f64>`: an unquoted printing is an absent `p`, never a zero.
            p: w.value,
            t: None,
            mc: None,
            mv: None,
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
