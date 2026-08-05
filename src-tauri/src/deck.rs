//! Decks: the gallery, the deck itself, and what sits in each of its five zones.
//!
//! Shaped like [`crate::collection`]: pure functions over a `Connection`, testable without a
//! Tauri app, wrapped in `async` commands that run on the blocking pool. Writes take
//! `AppState.db` through [`crate::db::lock_for`] and answer [`crate::collection::BUSY`]
//! rather than waiting; the one read goes through `db_read` like every other read.
//!
//! Two rules run through the whole module and are worth stating once:
//!
//! * **A zone write denormalizes the printing *and the name*.** `deck_cards.card_id` is a
//!   soft reference — `cards` is dropped and rebuilt on every sync — so the row records
//!   what it was made from at the only moment that is knowable. The name is here for the
//!   wishlist's reason: a deck list that cannot say what an orphaned row *is* is not a list.
//! * **Zero is a removal.** `deck_cards.quantity` carries `CHECK (quantity > 0)`, unlike the
//!   collection's, because a zone slot at zero holds nothing worth keeping — no condition,
//!   no purchase price, no acquisition story, just an intention the user withdrew.

use crate::collection::{valid_quantity, EntryChange};
use crate::sync::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// The five zones, re-exported from the schema so the CHECK and its Rust twin cannot drift.
pub const ZONES: [&str; 5] = crate::schema::DECK_ZONES;

/// What a deck is in when nobody says otherwise — `decks.format_key`'s own DDL default, so
/// an omitted `formatKey` means here exactly what it means in SQL.
pub const DEFAULT_FORMAT: &str = "casual";

/// What an adjustment says when the deck it names is not there.
pub const GONE: &str = "That deck is not there any more.";

/// One new deck, as the "New deck" dialog sends it.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeckInput {
    pub name: String,
    pub format_key: String,
    pub description: Option<String>,
}

/// An edit to one deck. Every field is optional: absent means "leave it".
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeckPatch {
    pub name: Option<String>,
    pub format_key: Option<String>,
    pub description: Option<String>,
    pub cover_card_id: Option<String>,
    pub is_built: Option<bool>,
    pub archived: Option<bool>,
}

/// One deck as the gallery shows it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckRow {
    pub id: i64,
    pub name: String,
    pub format_key: String,
    /// From `format_specs`, so the gallery never re-derives a display name.
    pub format_name: Option<String>,
    pub description: Option<String>,
    pub cover_card_id: Option<String>,
    /// Scryfall image policy: an `art` crop lacks the printed frame, so wherever the
    /// gallery shows one it must credit the artist — read here so the tile can.
    pub cover_artist: Option<String>,
    pub is_built: bool,
    pub archived: bool,
    /// main + commander + companion copies — what "a 60-card deck" means in a caption.
    pub card_count: i64,
    pub updated_at: i64,
}

/// A zone the schema knows, refused in words rather than as a CHECK failure — the same
/// discipline `collection::valid_finish` applies to the finish enum.
fn valid_zone(zone: &str) -> Result<&str, String> {
    ZONES.contains(&zone).then_some(zone).ok_or_else(|| {
        format!(
            "`{zone}` is not a deck zone. Use one of: {}.",
            ZONES.join(", ")
        )
    })
}

/// A name a gallery can show. A deck with no name is a nameless tile, and `decks.name` has
/// no CHECK to catch one — this is the whole of that constraint.
fn valid_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    (!name.is_empty())
        .then_some(name)
        .ok_or_else(|| "A deck needs a name.".to_owned())
}

/// A format key `format_specs` actually holds.
///
/// Validated **here rather than by a foreign key**, on purpose: `format_specs` is seeded
/// with `INSERT OR REPLACE` and every future migration that corrects a cell re-runs that
/// seed, which a REFERENCES clause on a live `decks` row would turn into a migration that
/// can fail in the field. Blank is the DDL's own `DEFAULT 'casual'` — an omitted format is
/// not a wrong one.
fn valid_format<'a>(conn: &Connection, key: &'a str) -> Result<&'a str, String> {
    let key = key.trim();
    if key.is_empty() {
        return Ok(DEFAULT_FORMAT);
    }
    conn.query_row(
        "SELECT 1 FROM format_specs WHERE key = ?1",
        params![key],
        |_| Ok(()),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(|()| key)
    .ok_or_else(|| {
        format!("`{key}` is not a format this app knows. Pick one from the format list.")
    })
}

/// The printing and the name, as the deck row will remember them.
///
/// The name is what `collection::printing_of` does not read and the wishlist does: a
/// collection row is a thing the user can hold, but a deck list is *read*, and a line that
/// can only say `e7f8…` once the id stops resolving is not a deck list.
fn printing_of(
    conn: &Connection,
    card_id: &str,
) -> Result<(String, String, String, String), String> {
    conn.query_row(
        "SELECT set_code, collector_number, lang, name FROM cards WHERE id = ?1",
        params![card_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("no card with the id `{card_id}` is in the card database"))
}

/// Move the deck's `updated_at` — and, in the same statement, learn whether the deck is
/// there at all.
///
/// Every zone write opens with this, which buys two things for one UPDATE. The gallery
/// sorts by this column, so a write that left it alone would be an edit that does not
/// surface; and a stale deck id — a gallery that has not refreshed since another view
/// deleted the deck — is answered with [`GONE`] rather than with a foreign-key error, one
/// statement before there is an orphan row to worry about.
fn touch_deck(conn: &Connection, deck_id: i64) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE decks SET updated_at = unixepoch() WHERE id = ?1",
            params![deck_id],
        )
        .map_err(|e| e.to_string())?;
    (changed > 0).then_some(()).ok_or_else(|| GONE.to_owned())
}

/// What a zone write says when the row it was asked to adjust is not in that zone.
fn card_gone(zone: &str) -> String {
    format!("That card is not in this deck's {zone} zone any more.")
}

/// Every column of a [`DeckRow`], from the one query shape the list and the single read
/// share. Both LEFT JOINs are load-bearing: a vanished cover printing or a format key the
/// specs no longer carry must never hide a deck from its owner.
const DECK_SELECT: &str = "SELECT d.id, d.name, d.format_key, fs.display_name, d.description,
            d.cover_card_id, c.artist, d.is_built, d.archived,
            coalesce((SELECT sum(quantity) FROM deck_cards
                       WHERE deck_id = d.id
                         AND zone IN ('main','commander','companion')), 0),
            d.updated_at
       FROM decks d
       LEFT JOIN format_specs fs ON fs.key = d.format_key
       LEFT JOIN cards c ON c.id = d.cover_card_id";

fn deck_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DeckRow> {
    Ok(DeckRow {
        id: r.get(0)?,
        name: r.get(1)?,
        format_key: r.get(2)?,
        format_name: r.get(3)?,
        description: r.get(4)?,
        cover_card_id: r.get(5)?,
        cover_artist: r.get(6)?,
        is_built: r.get(7)?,
        archived: r.get(8)?,
        card_count: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

/// One deck, or nothing. Every write that returns a `DeckRow` ends here, so the row the
/// caller gets back is the row the gallery would have read.
pub(crate) fn read_deck(conn: &Connection, id: i64) -> Result<Option<DeckRow>, String> {
    conn.query_row(
        &format!("{DECK_SELECT} WHERE d.id = ?1"),
        params![id],
        deck_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn create_deck(conn: &Connection, input: &DeckInput) -> Result<DeckRow, String> {
    let name = valid_name(&input.name)?;
    let format_key = valid_format(conn, &input.format_key)?;
    let id: i64 = conn
        .query_row(
            "INSERT INTO decks (name, format_key, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, unixepoch(), unixepoch())
             RETURNING id",
            params![name, format_key, input.description],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    read_deck(conn, id)?.ok_or_else(|| GONE.to_owned())
}

/// Apply an edit. Absent fields are left alone (`coalesce(?n, column)`), which is what
/// makes this usable from a form that only sends what it changed — `collection::update_entry`
/// verbatim. Rename, re-format, cover, build and archive all arrive here.
pub fn update_deck(conn: &Connection, id: i64, patch: &DeckPatch) -> Result<DeckRow, String> {
    let name = match patch.name.as_deref() {
        Some(n) => Some(valid_name(n)?.to_owned()),
        None => None,
    };
    let format_key = match patch.format_key.as_deref() {
        Some(k) => Some(valid_format(conn, k)?.to_owned()),
        None => None,
    };
    let changed = conn
        .execute(
            "UPDATE decks SET
                name = coalesce(?2, name),
                format_key = coalesce(?3, format_key),
                description = coalesce(?4, description),
                cover_card_id = coalesce(?5, cover_card_id),
                is_built = coalesce(?6, is_built),
                archived = coalesce(?7, archived),
                updated_at = unixepoch()
              WHERE id = ?1",
            params![
                id,
                name,
                format_key,
                patch.description,
                patch.cover_card_id,
                patch.is_built,
                patch.archived,
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(GONE.to_owned());
    }
    read_deck(conn, id)?.ok_or_else(|| GONE.to_owned())
}

/// Delete the deck outright.
///
/// **This one really deletes**, unlike anything in [`crate::reconcile`]: a deck is the
/// user's to destroy, and `deck_cards` and `deck_allocations` both cascade from it by a
/// choice made per delete-site in the v5 DDL. Archiving is the soft path
/// ([`DeckPatch::archived`]), and it is what a gallery's "remove" should reach for.
///
/// Like [`crate::collection::remove_entry`], an id that resolves to nothing is a success:
/// the caller wanted that deck gone, and it is gone.
pub fn delete_deck(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM decks WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Copy the deck and its cards — never its claims, never `is_built`, never `archived`.
///
/// A copy is a **draft**: it has reserved no copies of anything (claims belong to the deck
/// that made them, and Task 5's allocator will give the copy its own), it is not sleeved up
/// on a table, and it is not something the user filed away. Everything that describes the
/// deck rather than its state — format, description, cover — comes across, so the copy
/// looks like what was copied.
pub fn duplicate_deck(conn: &Connection, id: i64) -> Result<DeckRow, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let copy: Option<i64> = tx
        .query_row(
            "INSERT INTO decks (name, format_key, description, cover_kind, cover_card_id,
                                cover_image_path, is_built, archived, created_at, updated_at)
             SELECT name || ' (copy)', format_key, description, cover_kind, cover_card_id,
                    cover_image_path, 0, 0, unixepoch(), unixepoch()
               FROM decks WHERE id = ?1
             RETURNING id",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(copy) = copy else {
        return Err(GONE.to_owned());
    };
    // `needs_review` travels with the row: the sentence says this printing left the card
    // database, which is just as true of the copy.
    tx.execute(
        "INSERT INTO deck_cards
            (deck_id, card_id, set_code, collector_number, lang, name, zone, quantity,
             needs_review, created_at, updated_at)
         SELECT ?2, card_id, set_code, collector_number, lang, name, zone, quantity,
                needs_review, unixepoch(), unixepoch()
           FROM deck_cards WHERE deck_id = ?1",
        params![id, copy],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    read_deck(conn, copy)?.ok_or_else(|| GONE.to_owned())
}

/// The gallery, archived decks last and most recently touched first.
pub fn list_decks(conn: &Connection) -> Result<Vec<DeckRow>, String> {
    let sql = format!("{DECK_SELECT} ORDER BY d.archived ASC, d.updated_at DESC, d.id DESC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], deck_row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Add copies to a zone, folding on the grain — the drag-in and the click-to-add write.
pub fn add_card(
    conn: &Connection,
    deck_id: i64,
    card_id: &str,
    zone: &str,
    quantity: i64,
) -> Result<EntryChange, String> {
    let zone = valid_zone(zone)?;
    // Not `valid_quantity`: *adding* zero copies is a no-op dressed as a write, and would
    // conjure a row out of nothing. `collection::add_entry` refuses it in the same words.
    if quantity <= 0 {
        return Err("Adding a card needs a quantity of at least one.".into());
    }
    let (set_code, collector_number, lang, name) = printing_of(conn, card_id)?;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    touch_deck(&tx, deck_id)?;
    // The conflict target is `DECK_CARD_GRAIN` verbatim — the same text the unique index
    // was created from. Anything else is a runtime "ON CONFLICT clause does not match any
    // PRIMARY KEY or UNIQUE constraint" at the first quick-add, which is why it is a
    // constant. The quantities add; the row holds nothing else a second add could disagree
    // with.
    let sql = format!(
        "INSERT INTO deck_cards
            (deck_id, card_id, set_code, collector_number, lang, name, zone, quantity,
             created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8, unixepoch(), unixepoch())
         ON CONFLICT({grain}) DO UPDATE SET
            quantity = deck_cards.quantity + excluded.quantity,
            updated_at = unixepoch()
         RETURNING id, quantity",
        grain = crate::schema::DECK_CARD_GRAIN
    );
    let (id, quantity): (i64, i64) = tx
        .query_row(
            &sql,
            params![
                deck_id,
                card_id,
                set_code,
                collector_number,
                lang,
                name,
                zone,
                quantity
            ],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// Set an absolute quantity — the stepper write. **Zero removes the row.**
///
/// The wishlist's asymmetry, for the wishlist's reason: `deck_cards.quantity` carries
/// `CHECK (quantity > 0)`, and a zone slot at zero holds nothing worth keeping. The
/// collection keeps its zeros because it has a condition, a price and an acquisition story
/// to keep; a deck slot has an intention and nothing else, and an intention the user
/// stepped down to none of is a withdrawn intention.
///
/// A negative number is refused through the one [`valid_quantity`], and the refusal matters
/// more here rather than less: in a module where zero legitimately deletes, treating `-1` as
/// close enough to zero would let arithmetic that went wrong upstream destroy a row.
pub fn set_card_quantity(
    conn: &Connection,
    deck_id: i64,
    card_id: &str,
    zone: &str,
    quantity: i64,
) -> Result<EntryChange, String> {
    let zone = valid_zone(zone)?;
    valid_quantity(quantity, "deck quantity")?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    touch_deck(&tx, deck_id)?;

    if quantity == 0 {
        let id: Option<i64> = tx
            .query_row(
                "DELETE FROM deck_cards
                  WHERE deck_id = ?1 AND card_id = ?2 AND zone = ?3
                 RETURNING id",
                params![deck_id, card_id, zone],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        // A slot the caller wanted empty and that is empty: like `remove_entry`, a delete
        // that finds nothing already has what it wanted. There is no row left to name, so
        // the id is 0 — the only thing this path reports is that the slot is gone.
        return Ok(EntryChange {
            id: id.unwrap_or(0),
            quantity: 0,
            removed: true,
        });
    }

    let id: Option<i64> = tx
        .query_row(
            "UPDATE deck_cards SET quantity = ?4, updated_at = unixepoch()
              WHERE deck_id = ?1 AND card_id = ?2 AND zone = ?3
             RETURNING id",
            params![deck_id, card_id, zone, quantity],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    // The [`crate::collection::GONE`] asymmetry: an *adjustment* to a row that is not there
    // could not do what it was asked. Putting a card into a zone is [`add_card`].
    let id = id.ok_or_else(|| card_gone(zone))?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// Move every copy from one zone to another, in one transaction, folding into the row the
/// target zone already holds.
///
/// The identity travels **from the moved row**, never from a fresh `cards` lookup: a deck
/// whose printing left the card database is exactly the deck whose maybe pile someone is
/// tidying, and a move that needed the id to resolve would refuse the one row that most
/// needs moving.
pub fn move_card(
    conn: &Connection,
    deck_id: i64,
    card_id: &str,
    from: &str,
    to: &str,
) -> Result<(), String> {
    let from = valid_zone(from)?;
    let to = valid_zone(to)?;
    if from == to {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    touch_deck(&tx, deck_id)?;
    // `INSERT … SELECT … ON CONFLICT` over the same table: the `WHERE` is what makes it
    // unambiguous to parse, and it is here anyway. `needs_review` comes across with a row
    // that lands in an empty zone and is left alone where the target row already exists —
    // the fold's rule in `reconcile::fold_deck_card_into_existing`, for its reason.
    let sql = format!(
        "INSERT INTO deck_cards
            (deck_id, card_id, set_code, collector_number, lang, name, zone, quantity,
             needs_review, created_at, updated_at)
         SELECT deck_id, card_id, set_code, collector_number, lang, name, ?3, quantity,
                needs_review, unixepoch(), unixepoch()
           FROM deck_cards
          WHERE deck_id = ?1 AND card_id = ?2 AND zone = ?4
         ON CONFLICT({grain}) DO UPDATE SET
            quantity = deck_cards.quantity + excluded.quantity,
            updated_at = unixepoch()",
        grain = crate::schema::DECK_CARD_GRAIN
    );
    let moved = tx
        .execute(&sql, params![deck_id, card_id, to, from])
        .map_err(|e| e.to_string())?;
    if moved == 0 {
        return Err(card_gone(from));
    }
    tx.execute(
        "DELETE FROM deck_cards WHERE deck_id = ?1 AND card_id = ?2 AND zone = ?3",
        params![deck_id, card_id, from],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Run `f` with the write connection, or answer [`crate::collection::BUSY`].
fn with_write<T>(
    state: &Arc<AppState>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    match crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
        Some(conn) => f(&conn),
        None => Err(crate::collection::BUSY.to_owned()),
    }
}

/// What a deck write says when its worker thread died under it. Never a user's problem —
/// the write itself answers [`crate::collection::BUSY`] when the database is busy.
fn unfinished(e: tauri::Error) -> String {
    format!("the deck could not be written: {e}")
}

#[tauri::command]
pub async fn deck_create(
    state: tauri::State<'_, Arc<AppState>>,
    deck: DeckInput,
) -> Result<DeckRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| create_deck(c, &deck)))
        .await
        .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_update(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    patch: DeckPatch,
) -> Result<DeckRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| update_deck(c, id, &patch)))
        .await
        .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_delete(state: tauri::State<'_, Arc<AppState>>, id: i64) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| delete_deck(c, id)))
        .await
        .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_duplicate(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<DeckRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| duplicate_deck(c, id)))
        .await
        .map_err(unfinished)?
}

/// The deck gallery. **Read-only** connection, blocking pool — as every read in this app
/// is, so a gallery never queues behind a sync.
#[tauri::command]
pub async fn deck_list(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<DeckRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || list_decks(&crate::sync::lock_db_read(&state)))
        .await
        .map_err(|e| format!("the deck list could not be read: {e}"))?
}

#[tauri::command]
pub async fn deck_add_card(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    zone: String,
    quantity: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| add_card(c, deck_id, &card_id, &zone, quantity))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_set_card_quantity(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    zone: String,
    quantity: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            set_card_quantity(c, deck_id, &card_id, &zone, quantity)
        })
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_move_card(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| move_card(c, deck_id, &card_id, &from, &to))
    })
    .await
    .map_err(unfinished)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                rarity,artist,raw)
             VALUES ('bolt-lea','o1','Lightning Bolt','lea','161','en','normal','common',
                'Christopher Rush','{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                rarity,artist,raw)
             VALUES ('bolt-jp','o1','Lightning Bolt','4ed','209','ja','normal','common',
                'Christopher Rush','{}')",
            [],
        )
        .unwrap();
        conn
    }

    fn input(name: &str, format_key: &str) -> DeckInput {
        DeckInput {
            name: name.to_owned(),
            format_key: format_key.to_owned(),
            description: None,
        }
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    /// One collection row plus one deck's claim on it — the two things a duplicate and a
    /// delete both have to have an opinion about.
    fn own_and_claim(conn: &Connection, deck_id: i64) -> i64 {
        let entry: i64 = conn
            .query_row(
                "INSERT INTO collection_entries
                    (card_id,set_code,collector_number,lang,finish,condition,quantity,
                     created_at,updated_at)
                 VALUES ('bolt-lea','lea','161','en','nonfoil','NM',4,unixepoch(),unixepoch())
                 RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO deck_allocations
                (deck_id, collection_entry_id, quantity, created_at, updated_at)
             VALUES (?1,?2,4,unixepoch(),unixepoch())",
            params![deck_id, entry],
        )
        .unwrap();
        entry
    }

    /// The zone write is the collection quick-add's contract on the deck grain: the same
    /// printing in the same zone twice is one row with a bigger number, and the printing
    /// AND name are denormalized from `cards` at write time — the only moment they are
    /// knowable, and the reason the row outlives the id (spec §6, CLAUDE.md).
    #[test]
    fn adding_the_same_card_to_the_same_zone_twice_folds() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();

        let first = add_card(&conn, deck.id, "bolt-jp", "main", 2).unwrap();
        let second = add_card(&conn, deck.id, "bolt-jp", "main", 2).unwrap();

        assert_eq!(first.id, second.id, "the same grain is the same row");
        assert_eq!(second.quantity, 4);
        assert_eq!(count(&conn, "deck_cards"), 1);

        let (set, cn, lang, name): (String, String, String, String) = conn
            .query_row(
                "SELECT set_code, collector_number, lang, name FROM deck_cards WHERE id = ?1",
                params![second.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (set.as_str(), cn.as_str(), lang.as_str(), name.as_str()),
            ("4ed", "209", "ja", "Lightning Bolt"),
            "the printing and the name are copied from `cards` at write time"
        );

        // `zone` is in the grain: the same printing in the maybe pile is a second
        // intention, not the same row somewhere else.
        let maybe = add_card(&conn, deck.id, "bolt-jp", "maybe", 1).unwrap();
        assert_ne!(maybe.id, second.id);
        assert_eq!(count(&conn, "deck_cards"), 2);
    }

    #[test]
    fn a_zone_the_schema_does_not_know_is_refused_in_words() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();

        let err = add_card(&conn, deck.id, "bolt-lea", "sideboard", 1).unwrap_err();
        assert!(err.contains("sideboard"), "{err}");
        for zone in ZONES {
            assert!(err.contains(zone), "the refusal names `{zone}`: {err}");
        }
        assert_eq!(count(&conn, "deck_cards"), 0, "and nothing was written");

        // Every zone write validates in Rust, so the CHECK never reaches a user.
        assert!(set_card_quantity(&conn, deck.id, "bolt-lea", "sideboard", 1).is_err());
        assert!(move_card(&conn, deck.id, "bolt-lea", "main", "sideboard").is_err());
    }

    #[test]
    fn zero_removes_the_deck_card_and_negative_is_refused() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let added = add_card(&conn, deck.id, "bolt-lea", "main", 4).unwrap();

        let lowered = set_card_quantity(&conn, deck.id, "bolt-lea", "main", 1).unwrap();
        assert_eq!(
            (lowered.id, lowered.quantity, lowered.removed),
            (added.id, 1, false),
            "an absolute quantity, not an addition"
        );

        let err = set_card_quantity(&conn, deck.id, "bolt-lea", "main", -1).unwrap_err();
        assert!(err.contains("is not a quantity"), "{err}");
        assert_eq!(count(&conn, "deck_cards"), 1, "and it never deletes");

        let removed = set_card_quantity(&conn, deck.id, "bolt-lea", "main", 0).unwrap();
        assert_eq!(
            (removed.id, removed.quantity, removed.removed),
            (added.id, 0, true)
        );
        assert_eq!(count(&conn, "deck_cards"), 0);
    }

    #[test]
    fn moving_a_card_between_zones_folds_into_the_target_row() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "main", 4).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "side", 1).unwrap();

        move_card(&conn, deck.id, "bolt-lea", "main", "side").unwrap();

        assert_eq!(count(&conn, "deck_cards"), 1, "one row, not two");
        let (zone, quantity): (String, i64) = conn
            .query_row("SELECT zone, quantity FROM deck_cards", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((zone.as_str(), quantity), ("side", 5), "four into one");

        // An empty target zone is a create, and it carries the identity the moved row
        // recorded — never a fresh lookup, so a move works on an orphaned row too.
        move_card(&conn, deck.id, "bolt-lea", "side", "maybe").unwrap();
        assert_eq!(count(&conn, "deck_cards"), 1);
        let (zone, quantity, name): (String, i64, String) = conn
            .query_row("SELECT zone, quantity, name FROM deck_cards", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(
            (zone.as_str(), quantity, name.as_str()),
            ("maybe", 5, "Lightning Bolt")
        );
    }

    #[test]
    fn duplicate_copies_cards_but_not_allocations_or_built() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "main", 4).unwrap();
        add_card(&conn, deck.id, "bolt-jp", "maybe", 1).unwrap();
        update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                is_built: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        own_and_claim(&conn, deck.id);

        let copy = duplicate_deck(&conn, deck.id).unwrap();

        assert_ne!(copy.id, deck.id);
        assert_eq!(copy.name, "Burn (copy)");
        assert_eq!(copy.format_key, "modern");
        assert!(!copy.is_built, "a copy is a draft, never a built deck");
        assert_eq!(
            copy.card_count, 4,
            "main only — the maybe pile is not the deck"
        );

        let cards: Vec<(String, String, i64)> = conn
            .prepare(
                "SELECT card_id, zone, quantity FROM deck_cards WHERE deck_id = ?1
                  ORDER BY zone",
            )
            .unwrap()
            .query_map(params![copy.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            cards,
            vec![
                ("bolt-lea".to_owned(), "main".to_owned(), 4),
                ("bolt-jp".to_owned(), "maybe".to_owned(), 1),
            ]
        );

        let claims: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_allocations WHERE deck_id = ?1",
                params![copy.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            claims, 0,
            "a copy reserves nothing — the original's claims are the original's"
        );
        assert_eq!(count(&conn, "deck_allocations"), 1);
    }

    #[test]
    fn list_decks_counts_main_commander_companion_and_reads_the_cover_artist() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Bolt Tribal", "commander")).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "main", 2).unwrap();
        add_card(&conn, deck.id, "bolt-jp", "commander", 1).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "companion", 1).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "side", 3).unwrap();
        add_card(&conn, deck.id, "bolt-jp", "maybe", 7).unwrap();
        update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                cover_card_id: Some("bolt-lea".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();

        let old = create_deck(&conn, &input("Old Standard", "standard")).unwrap();
        update_deck(
            &conn,
            old.id,
            &DeckPatch {
                archived: Some(true),
                ..Default::default()
            },
        )
        .unwrap();

        let decks = list_decks(&conn).unwrap();

        assert_eq!(
            decks.len(),
            2,
            "an archived deck is listed — the UI separates them"
        );
        assert_eq!(decks[0].id, deck.id, "archived decks sort last");
        assert!(decks[1].archived);
        assert_eq!(
            decks[0].card_count, 4,
            "2 main + 1 commander + 1 companion; the side and maybe piles are not the deck"
        );
        assert_eq!(decks[0].format_name.as_deref(), Some("Commander"));
        assert_eq!(decks[0].cover_artist.as_deref(), Some("Christopher Rush"));
        assert_eq!(decks[1].card_count, 0);
    }

    #[test]
    fn a_card_id_that_does_not_resolve_is_refused() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();

        let err = add_card(&conn, deck.id, "no-such-card", "main", 1).unwrap_err();

        assert!(err.contains("no-such-card"), "{err}");
        assert!(err.contains("card database"), "{err}");
        assert_eq!(count(&conn, "deck_cards"), 0);
    }

    /// `format_key` carries no foreign key on purpose — `format_specs` is re-seeded with
    /// `INSERT OR REPLACE` by every migration that corrects a cell — so the check lives
    /// here, in words, at the two moments a key can be chosen.
    #[test]
    fn a_deck_needs_a_name_and_a_format_the_specs_know() {
        let conn = seeded();

        let err = create_deck(&conn, &input("Burn", "kitchen-table")).unwrap_err();
        assert!(err.contains("kitchen-table"), "{err}");
        assert_eq!(count(&conn, "decks"), 0);

        let err = create_deck(&conn, &input("   ", "modern")).unwrap_err();
        assert!(err.contains("name"), "{err}");
        assert_eq!(count(&conn, "decks"), 0);

        // An omitted format is the table's own default, not a refusal.
        let deck = create_deck(
            &conn,
            &DeckInput {
                name: "Burn".to_owned(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(deck.format_key, DEFAULT_FORMAT);

        let err = update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                format_key: Some("kitchen-table".to_owned()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("kitchen-table"), "{err}");

        let renamed = update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                name: Some("Burn v2".to_owned()),
                format_key: Some("modern".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(renamed.name, "Burn v2");
        assert_eq!(
            (renamed.format_key.as_str(), renamed.format_name.as_deref()),
            ("modern", Some("Modern"))
        );
    }

    /// A deck delete is a real user deletion — the decks are the user's to destroy — and
    /// the CASCADEs take the cards and the claims with it. What it never touches is the
    /// collection: a deck names copies, it does not own them.
    #[test]
    fn deleting_a_deck_takes_its_cards_and_claims_and_deleting_it_twice_still_succeeds() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "main", 4).unwrap();
        own_and_claim(&conn, deck.id);

        delete_deck(&conn, deck.id).unwrap();

        assert_eq!(count(&conn, "decks"), 0);
        assert_eq!(count(&conn, "deck_cards"), 0);
        assert_eq!(count(&conn, "deck_allocations"), 0);
        assert_eq!(
            count(&conn, "collection_entries"),
            1,
            "the copies are still owned"
        );

        delete_deck(&conn, deck.id).expect("a deck that is already gone is gone");
    }

    /// The gallery sorts by `decks.updated_at`, so a deck that was edited has to rise —
    /// and the same statement is what tells a zone write that the deck it names exists.
    #[test]
    fn every_zone_write_touches_the_deck_the_gallery_sorts_by() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        // `unixepoch()` has one-second resolution, so the clock is moved back rather than
        // waited on.
        let backdate = |conn: &Connection| {
            conn.execute(
                "UPDATE decks SET updated_at = 0 WHERE id = ?1",
                params![deck.id],
            )
            .unwrap();
        };
        let updated_at = |conn: &Connection| -> i64 {
            conn.query_row(
                "SELECT updated_at FROM decks WHERE id = ?1",
                params![deck.id],
                |r| r.get(0),
            )
            .unwrap()
        };

        backdate(&conn);
        add_card(&conn, deck.id, "bolt-lea", "main", 4).unwrap();
        assert!(updated_at(&conn) > 0, "the add moved the deck");

        backdate(&conn);
        set_card_quantity(&conn, deck.id, "bolt-lea", "main", 2).unwrap();
        assert!(updated_at(&conn) > 0, "so does the stepper");

        backdate(&conn);
        move_card(&conn, deck.id, "bolt-lea", "main", "side").unwrap();
        assert!(updated_at(&conn) > 0, "and so does the move");

        // The same statement is the existence check: a stale deck id from a gallery that
        // has not refreshed is a sentence, never a foreign-key error.
        let err = add_card(&conn, deck.id + 999, "bolt-lea", "main", 1).unwrap_err();
        assert_eq!(err, GONE);
        assert_eq!(count(&conn, "deck_cards"), 1, "and nothing was written");
    }

    #[test]
    fn deck_row_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(DeckRow {
            id: 3,
            name: "Burn".to_owned(),
            format_key: "modern".to_owned(),
            format_name: Some("Modern".to_owned()),
            description: None,
            cover_card_id: Some("bolt-lea".to_owned()),
            cover_artist: Some("Christopher Rush".to_owned()),
            is_built: true,
            archived: false,
            card_count: 60,
            updated_at: 1_800_000_000,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "id": 3, "name": "Burn", "formatKey": "modern", "formatName": "Modern",
                "description": null, "coverCardId": "bolt-lea",
                "coverArtist": "Christopher Rush", "isBuilt": true, "archived": false,
                "cardCount": 60, "updatedAt": 1800000000
            })
        );

        // And the two payloads the frontend sends: `#[serde(default)]` throughout, so a
        // dialog sends the fields it has and a patch sends only what it changed.
        let input: DeckInput = serde_json::from_str(r#"{"name":"Burn","formatKey":"modern"}"#)
            .expect("the create payload");
        assert_eq!(
            (input.name.as_str(), input.format_key.as_str()),
            ("Burn", "modern")
        );
        assert!(input.description.is_none());

        let patch: DeckPatch = serde_json::from_str(r#"{"coverCardId":"bolt-lea","isBuilt":true}"#)
            .expect("the patch payload");
        assert_eq!(patch.cover_card_id.as_deref(), Some("bolt-lea"));
        assert_eq!(patch.is_built, Some(true));
        assert!(patch.name.is_none(), "an omitted field means leave it");
    }
}
