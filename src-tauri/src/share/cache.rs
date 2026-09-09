//! `collection_shares` — this device's record of what the group has published.
//!
//! **It is a cache and the relay's `GET /g/{group}/shares` is the roster** (spec §4.2), exactly
//! as the rewrapped key set is the roster for group membership. Nothing here is synced: a
//! synced copy would be a second record of a fact the relay already holds, and the two would
//! disagree the first time a device was offline during a revoke. What the table buys is a
//! "shared" badge on a folder that survives being offline, and the links to go with it.
//!
//! **So [`reconcile`] deletes**, and that is the roster rule spelled as SQL: a share the relay
//! does not name has left, whether it was withdrawn from another device or never existed here.
//!
//! Everything in this file is a pure function of the database plus its arguments — no clock, no
//! network — which is what lets `share::publish`'s two-step be tested without an HTTP mock. (That
//! module is spelled without a link here: it does not exist on the browser build and this one
//! does, which is the same reason the two are separate files.)

use super::commands::ShareRow;
use rusqlite::{params, Connection, OptionalExtension};

/// Every column, in the order [`hydrate`] reads them. One spelling, so a `SELECT` and the
/// closure that walks it cannot drift into disagreeing about which string is the title.
const COLUMNS: &str =
    "id, folder_uid, title, owner_name, url, fields, state, published, updated_at";

/// One row as it comes off SQLite, with `fields` still the JSON text the column stores.
///
/// **Separate from [`ShareRow`] because the parse can fail and a `query_map` closure cannot say
/// so**: its error type is `rusqlite::Error`, so a `serde_json` failure inside it would have to
/// be swallowed or transmuted. Read flat, converted after.
struct Raw {
    id: String,
    folder_uid: Option<String>,
    title: String,
    owner_name: String,
    url: String,
    fields: String,
    state: String,
    published: Option<i64>,
    updated_at: i64,
}

/// The JSON array in `fields`, or a sentence naming the row it could not read.
///
/// **An unreadable list is an error and never `[]`**, for the reason the share Worker's own
/// `wireRow` gives about the same column: `[]` is a *valid* answer meaning "this snapshot
/// carries no optional fields", so defaulting to it would tell the reader they had published
/// less than they did.
fn hydrate(raw: Raw) -> Result<ShareRow, String> {
    let fields: Vec<String> = serde_json::from_str(&raw.fields)
        .map_err(|e| format!("the share {} has an unreadable field list: {e}", raw.id))?;
    Ok(ShareRow {
        id: raw.id,
        folder_uid: raw.folder_uid,
        title: raw.title,
        owner_name: raw.owner_name,
        url: raw.url,
        fields,
        state: raw.state,
        published: raw.published,
        updated_at: raw.updated_at,
    })
}

fn raw_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Raw> {
    Ok(Raw {
        id: r.get(0)?,
        folder_uid: r.get(1)?,
        title: r.get(2)?,
        owner_name: r.get(3)?,
        url: r.get(4)?,
        fields: r.get(5)?,
        state: r.get(6)?,
        published: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

/// Every share this device knows about.
///
/// **Ordered by title rather than by when the relay first saw it**, because `created_at` is one
/// of the columns this cache deliberately does not hold: it is the relay's clock and nothing
/// here would ever be able to check it. `id` breaks the tie, so the order is total and a list
/// redrawn after a republish does not shuffle.
pub fn list(conn: &Connection) -> Result<Vec<ShareRow>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM collection_shares ORDER BY title, id"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], raw_from_row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    rows.into_iter().map(hydrate).collect()
}

/// One share by its id, or `None` for one this device has never heard of.
pub fn get(conn: &Connection, id: &str) -> Result<Option<ShareRow>, String> {
    let raw = conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM collection_shares WHERE id = ?1"),
            params![id],
            raw_from_row,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(hydrate).transpose()
}

/// Write one row whole — **including `published`**, which is why this is the write a successful
/// upload makes and [`reconcile`] does not.
///
/// ⚠️ **The other row on this folder goes first, and that is not tidying.**
/// `idx_collection_shares_folder` says a folder may be shared once, and the relay mints a *new*
/// id when a withdrawn folder is shared again (spec §5.2) — so the insert below would collide
/// with the tombstone of the share this one replaces. The folder key is
/// `coalesce(folder_uid, '')` for the relay's own reason: SQLite treats NULLs as distinct, so
/// `folder_uid = ?` matches nothing at all for a whole-collection share.
pub fn store(conn: &Connection, row: &ShareRow) -> Result<(), String> {
    let fields = serde_json::to_string(&row.fields).map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM collection_shares
          WHERE id <> ?1 AND coalesce(folder_uid, '') = coalesce(?2, '')",
        params![row.id, row.folder_uid],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO collection_shares
             (id, folder_uid, title, owner_name, url, fields, state, published, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
             folder_uid = excluded.folder_uid,
             title      = excluded.title,
             owner_name = excluded.owner_name,
             url        = excluded.url,
             fields     = excluded.fields,
             state      = excluded.state,
             published  = excluded.published,
             updated_at = excluded.updated_at",
        params![
            row.id,
            row.folder_uid,
            row.title,
            row.owner_name,
            row.url,
            fields,
            row.state,
            row.published,
            row.updated_at
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Move one share's `state`, leaving everything else — the link included — where it is.
///
/// What a withdrawal writes locally, after the relay has taken it. The row survives its own
/// revocation until the next [`reconcile`] drops it, which is what lets the page say *withdrawn*
/// for the moment between the press and the next list.
pub fn mark_state(conn: &Connection, id: &str, state: &str, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE collection_shares SET state = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, state, now],
    )
    .map_err(|e| e.to_string())
    .map(|_| ())
}

/// Bring the cache into line with the relay's list, and answer what it now holds.
///
/// **The relay's list is the roster, so a row it does not name has left** — withdrawn from
/// another device, or minted by a device that has since been removed from the group. Deleting
/// is therefore the first thing this does rather than an afterthought: it is also what clears
/// the tombstone of a share whose folder is about to be given a new id, so no metadata write
/// below can collide with `idx_collection_shares_folder`.
///
/// ⚠️ **`published` is not written here and must not be.** It records when *this* device last
/// uploaded, and the relay knows nothing about that — a reconcile that copied the incoming
/// `None` over it would tell every device in the group that none of them had ever published.
pub fn reconcile(conn: &Connection, remote: &[ShareRow]) -> Result<Vec<ShareRow>, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    // `IN ()` over an empty set is a legal SQLite expression that matches nothing, so a group
    // with no shares left deletes every local row — which is the roster rule, not an edge case.
    let holes = remote
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(", ");
    tx.execute(
        &format!("DELETE FROM collection_shares WHERE id NOT IN ({holes})"),
        rusqlite::params_from_iter(remote.iter().map(|r| &r.id)),
    )
    .map_err(|e| e.to_string())?;

    for row in remote {
        let fields = serde_json::to_string(&row.fields).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO collection_shares
                 (id, folder_uid, title, owner_name, url, fields, state, published, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8)
             ON CONFLICT(id) DO UPDATE SET
                 folder_uid = excluded.folder_uid,
                 title      = excluded.title,
                 owner_name = excluded.owner_name,
                 url        = excluded.url,
                 fields     = excluded.fields,
                 state      = excluded.state,
                 updated_at = excluded.updated_at",
            params![
                row.id,
                row.folder_uid,
                row.title,
                row.owner_name,
                row.url,
                fields,
                row.state,
                row.updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    list(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open() -> Connection {
        crate::schema::memory_pair()
    }

    fn row(id: &str, folder: Option<&str>, state: &str) -> ShareRow {
        ShareRow {
            id: id.to_owned(),
            folder_uid: folder.map(str::to_owned),
            title: format!("Binder {id}"),
            owner_name: "Giradeli".to_owned(),
            url: format!("https://share.example/s/{id}"),
            fields: vec!["value".to_owned()],
            state: state.to_owned(),
            published: None,
            updated_at: 10,
        }
    }

    /// Three states the app draws differently, and `lapsed` is the one a reader must be told
    /// about before their friends tell them.
    #[test]
    fn the_cache_round_trips_all_three_states() {
        let conn = open();
        store(&conn, &row("live-1", Some("uid-a"), "live")).unwrap();
        store(&conn, &row("laps-1", Some("uid-b"), "lapsed")).unwrap();
        store(&conn, &row("revo-1", Some("uid-c"), "revoked")).unwrap();

        let back = list(&conn).unwrap();
        assert_eq!(back.len(), 3);
        let mut states: Vec<&str> = back.iter().map(|r| r.state.as_str()).collect();
        states.sort_unstable();
        assert_eq!(states, ["lapsed", "live", "revoked"]);
        // The two columns that exist so a list drawn with no network is still a list of links.
        assert!(back.iter().all(|r| r.owner_name == "Giradeli"));
        assert!(back
            .iter()
            .all(|r| r.url == format!("https://share.example/s/{}", r.id)));
        assert_eq!(back[0].fields, ["value"]);
    }

    /// The relay's list is the roster. A share the relay no longer names has left.
    #[test]
    fn reconciling_against_the_relays_list_drops_a_row_the_relay_does_not_name() {
        let conn = open();
        store(&conn, &row("keep", Some("uid-a"), "live")).unwrap();
        store(&conn, &row("gone", Some("uid-b"), "live")).unwrap();

        let mut named = row("keep", Some("uid-a"), "lapsed");
        named.title = "Renamed".to_owned();
        let after = reconcile(&conn, &[named]).unwrap();

        assert_eq!(after.len(), 1, "the relay named one share, so one survives");
        assert_eq!(after[0].id, "keep");
        assert_eq!(
            after[0].state, "lapsed",
            "the relay's state is the one kept"
        );
        assert_eq!(after[0].title, "Renamed");
    }

    /// A relay that names nothing empties the cache, which is the same rule and not a special
    /// case — `IN ()` matches no row, so every local row is one the relay did not name.
    #[test]
    fn reconciling_against_an_empty_list_empties_the_cache() {
        let conn = open();
        store(&conn, &row("gone", Some("uid-a"), "live")).unwrap();
        assert!(reconcile(&conn, &[]).unwrap().is_empty());
    }

    /// `published` is this device's own fact and the relay holds none of it.
    #[test]
    fn reconciling_does_not_forget_that_this_device_has_published() {
        let conn = open();
        let mut mine = row("keep", Some("uid-a"), "live");
        mine.published = Some(1_757_308_800);
        store(&conn, &mine).unwrap();

        let after = reconcile(&conn, &[row("keep", Some("uid-a"), "live")]).unwrap();
        assert_eq!(after[0].published, Some(1_757_308_800));
    }

    /// A folder shared again after a withdrawal gets a **new** id from the relay, and the
    /// tombstone is still sitting on `idx_collection_shares_folder`.
    #[test]
    fn storing_a_new_id_for_a_folder_replaces_the_withdrawn_one() {
        let conn = open();
        store(&conn, &row("old", Some("uid-a"), "revoked")).unwrap();
        store(&conn, &row("new", Some("uid-a"), "live")).unwrap();

        let after = list(&conn).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].id, "new");
    }

    /// The whole-collection share's key is NULL, which `folder_uid = ?` never matches — the
    /// `coalesce` in [`store`] is what makes republishing it replace rather than collide.
    #[test]
    fn storing_a_new_id_for_the_whole_collection_replaces_the_withdrawn_one() {
        let conn = open();
        store(&conn, &row("old", None, "revoked")).unwrap();
        store(&conn, &row("new", None, "live")).unwrap();

        let after = list(&conn).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].id, "new");
    }

    /// An unreadable field list is a sentence naming the row, never a silent `[]` — which is a
    /// valid answer meaning "no optional fields crossed".
    #[test]
    fn an_unreadable_field_list_is_refused_rather_than_read_as_empty() {
        let conn = open();
        store(&conn, &row("bad", Some("uid-a"), "live")).unwrap();
        conn.execute(
            "UPDATE collection_shares SET fields = 'not json' WHERE id = 'bad'",
            [],
        )
        .unwrap();
        let err = list(&conn).unwrap_err();
        assert!(err.contains("bad"), "{err}");
    }

    #[test]
    fn get_answers_none_for_a_share_this_device_has_never_seen() {
        let conn = open();
        assert!(get(&conn, "nope").unwrap().is_none());
    }

    #[test]
    fn marking_a_state_leaves_the_link_alone() {
        let conn = open();
        store(&conn, &row("one", Some("uid-a"), "live")).unwrap();
        mark_state(&conn, "one", "revoked", 99).unwrap();
        let after = get(&conn, "one").unwrap().unwrap();
        assert_eq!(after.state, "revoked");
        assert_eq!(after.updated_at, 99);
        assert_eq!(after.url, "https://share.example/s/one");
    }
}
