//! The wishlist: what the user is hunting for, at the grain spec §6 gives it — an oracle
//! card, optionally pinned to one printing and one finish.
//!
//! The interesting column is `card_id`, and it is interesting because it is **nullable**:
//! NULL means "any printing", which is what a wishlist usually means, and a value means
//! "that one", which is what it means once someone has decided they want the Alpha.
//!
//! Shaped like [`crate::collection`] — pure functions over a `Connection`, wrapped in
//! `async` commands that take the *write* connection with a bound — with one deliberate
//! difference: `quantity > 0` is a table CHECK here, so there is no zero-keeps-the-row
//! state to preserve. A wish for none of something is not a wish, and [`set_wish_quantity`]
//! takes a zero as the removal it can only be.

use crate::collection::{EntryChange, BUSY, FINISHES};
use crate::schema::WISHLIST_GRAIN;
use crate::sync::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// One wish, as the UI sends it.
///
/// Either identifier will do. A caller that sends only `cardId` gets the oracle id and the
/// name looked up from that printing (which is how the "any printing" button on a card can
/// work from a card); a caller that sends only `oracleId` gets the name looked up from any
/// printing of that oracle card, and must send one itself when the card database has none
/// — an oracle id whose printings have all left `cards` still makes a wish, and a shopping
/// list that cannot say what it is shopping for is not a list.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WishInput {
    pub card_id: Option<String>,
    pub oracle_id: Option<String>,
    pub name: Option<String>,
    pub quantity: i64,
    pub preferred_finish: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WishlistQuery {
    #[serde(flatten)]
    pub cards: crate::filters::CardFilters,
    /// `Some(true)` shows only wishes the collection already covers, `Some(false)` only
    /// those it does not — "what is still missing" being the list's usual question.
    pub fulfilled: Option<bool>,
    pub sort: Option<String>,
    pub limit: u32,
    pub offset: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WishRow {
    pub id: i64,
    pub oracle_id: Option<String>,
    /// `None` = any printing.
    pub card_id: Option<String>,
    pub name: String,
    pub set_code: Option<String>,
    pub collector_number: Option<String>,
    pub lang: Option<String>,
    pub rarity: Option<String>,
    pub mana_cost: Option<String>,
    pub quantity: i64,
    pub preferred_finish: Option<String>,
    /// The cheapest way to satisfy this wish, per copy: the preferred finish's price if one
    /// is named, else the nonfoil price of the printing (or of any printing of the oracle
    /// card, for an unpinned wish).
    pub unit_price_usd: Option<f64>,
    /// How many copies the collection already has against this wish.
    pub owned_quantity: i64,
    pub notes: Option<String>,
    pub needs_review: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WishlistPage {
    pub items: Vec<WishRow>,
    pub total: i64,
}

const DEFAULT_LIMIT: u32 = 100;
const MAX_LIMIT: u32 = 500;

/// How many copies the collection holds against a wish, as a scalar subquery.
///
/// A pinned wish counts that printing; an unpinned one counts every printing of the oracle
/// card, which is what "any printing" means on the way back as well as on the way out.
///
/// `sum(quantity)`, so a collection row emptied to zero (which the collection keeps — see
/// [`crate::collection::set_quantity`]) contributes nothing: this figure is copies held,
/// not entries recorded, and a wish is satisfied by copies.
const OWNED_SQL: &str = "coalesce((
        SELECT sum(ce.quantity) FROM collection_entries ce
         WHERE (w.card_id IS NOT NULL AND ce.card_id = w.card_id)
            OR (w.card_id IS NULL AND ce.card_id IN
                    (SELECT id FROM cards WHERE oracle_id = w.oracle_id))), 0)";

pub fn add_wish(conn: &Connection, input: &WishInput) -> Result<EntryChange, String> {
    if let Some(f) = input.preferred_finish.as_deref() {
        if !FINISHES.contains(&f) {
            return Err(format!(
                "`{f}` is not a finish. Use one of: {}.",
                FINISHES.join(", ")
            ));
        }
    }
    let quantity = if input.quantity <= 0 {
        1
    } else {
        input.quantity
    };
    // Asked before anything is looked up, because it is the question that decides whether
    // there is anything to look up: a wish naming neither an oracle card nor a printing is
    // a wish for nothing, and would collide with every other such row on the grain (the
    // table's own CHECK says the same thing, in the database's voice rather than the app's).
    if input.card_id.is_none() && input.oracle_id.is_none() {
        return Err("a wish needs either a card or an oracle id".into());
    }

    // Whatever the caller did not send, taken from the printing it named.
    let printing: Option<(Option<String>, String, String, String, String)> = match &input.card_id {
        Some(id) => conn
            .query_row(
                "SELECT oracle_id, name, set_code, collector_number, lang FROM cards WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?,
        None => None,
    };
    if input.card_id.is_some() && printing.is_none() {
        return Err("no card with that id is in the card database".into());
    }
    let oracle_id = input
        .oracle_id
        .clone()
        .or_else(|| printing.as_ref().and_then(|p| p.0.clone()));
    let name = match input
        .name
        .clone()
        .or_else(|| printing.as_ref().map(|p| p.1.clone()))
    {
        Some(name) => name,
        // An any-printing wish made from a card the reader is looking at sends the oracle
        // id and nothing else, so the name is read from *a* printing of that oracle card —
        // any of them, because `cards.name` is the oracle name on every printing, including
        // the translated ones (Scryfall keeps the localised one in `printed_name`). Only
        // the set, the collector number and the language stay NULL, because those are
        // properties of a printing and this wish is deliberately not for one:
        // `an_any_printing_wish_pins_nothing_but_its_name` is the fence.
        None => oracle_name(conn, oracle_id.as_deref())?,
    };

    let sql = format!(
        "INSERT INTO wishlist_entries
            (oracle_id, card_id, set_code, collector_number, lang, name, quantity,
             preferred_finish, notes, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9, unixepoch(), unixepoch())
         ON CONFLICT({WISHLIST_GRAIN}) DO UPDATE SET
            quantity = wishlist_entries.quantity + excluded.quantity,
            notes = coalesce(wishlist_entries.notes, excluded.notes),
            updated_at = unixepoch()
         RETURNING id, quantity"
    );
    let (id, quantity): (i64, i64) = conn
        .query_row(
            &sql,
            params![
                oracle_id,
                input.card_id,
                printing.as_ref().map(|p| p.2.clone()),
                printing.as_ref().map(|p| p.3.clone()),
                printing.as_ref().map(|p| p.4.clone()),
                name,
                quantity,
                input.preferred_finish,
                input.notes,
            ],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// The oracle card's name, read from whichever printing the list would join to.
///
/// Same ordering as [`list_wishes`]' `LEFT JOIN` on purpose: the name stored on the row and
/// the printing the list reads a rarity and a price from are then the same card.
fn oracle_name(conn: &Connection, oracle_id: Option<&str>) -> Result<String, String> {
    let Some(oracle_id) = oracle_id else {
        return Err("a wish needs a card name".into());
    };
    conn.query_row(
        "SELECT name FROM cards WHERE oracle_id = ?1
          ORDER BY released_at DESC, id ASC LIMIT 1",
        params![oracle_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "a wish needs a card name".to_owned())
}

/// Set an absolute quantity. **Zero removes the row**, unlike the collection's.
///
/// The asymmetry is the table's: `wishlist_entries.quantity` carries a `CHECK (quantity >
/// 0)`, because a wish holds nothing worth keeping once it is emptied — no condition, no
/// purchase price, no acquisition story, just the fact that somebody once wanted a card and
/// now wants none of it. The collection keeps its zeros for exactly the reasons this does
/// not have.
pub fn set_wish_quantity(conn: &Connection, id: i64, quantity: i64) -> Result<EntryChange, String> {
    if quantity <= 0 {
        return remove_wish(conn, id);
    }
    let changed = conn
        .execute(
            "UPDATE wishlist_entries SET quantity = ?2, updated_at = unixepoch() WHERE id = ?1",
            params![id, quantity],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("That wishlist entry is not there any more.".into());
    }
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// Delete the row. Like [`crate::collection::remove_entry`], an id that resolves to nothing
/// is a success: the caller wanted that row gone, and it is gone.
pub fn remove_wish(conn: &Connection, id: i64) -> Result<EntryChange, String> {
    conn.execute("DELETE FROM wishlist_entries WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity: 0,
        removed: true,
    })
}

pub fn list_wishes(conn: &Connection, q: &WishlistQuery) -> Result<WishlistPage, String> {
    let limit = if q.limit == 0 {
        DEFAULT_LIMIT
    } else {
        q.limit.min(MAX_LIMIT)
    };
    let mut p = crate::filters::Predicates::default();
    // The card a wish is *about*: its pinned printing, or any printing of its oracle card.
    // A LEFT JOIN, because a wish outlives the printing it was made from.
    let from = "wishlist_entries w LEFT JOIN cards c
                    ON c.id = coalesce(w.card_id,
                        (SELECT id FROM cards WHERE oracle_id = w.oracle_id
                          ORDER BY released_at DESC, id ASC LIMIT 1))";
    let cards = crate::filters::CardFilters {
        text: None,
        paper_only: Some(false),
        ..q.cards.clone()
    };
    // `Some("w")`, for the reason the collection passes `Some("e")`: a pinned wish copies
    // its printing onto the row at write time and the list *shows* that set code, so a wish
    // displayed as `lea` must not vanish when the reader filters to `lea` merely because
    // `cards` no longer knows the printing. (An unpinned wish has no set of its own and is
    // matched through the printing the join picked for it, which is a printing rather than
    // *the* printing — a set filter over an any-printing wish is a loose question and gets
    // a loose answer.)
    crate::filters::push_card_filters(&mut p, &cards, "c", Some("w"));
    if let Some(text) = crate::filters::nonblank(&q.cards.text) {
        // Matched against the stored name rather than through FTS: a wish carries its own
        // name (it may have no card row at all), and a list of a few hundred rows does not
        // need an index to filter by one.
        p.push(
            "w.name LIKE '%' || ? || '%'".to_owned(),
            Box::new(text.to_owned()),
        );
    }
    match q.fulfilled {
        Some(true) => p.wheres.push(format!("{OWNED_SQL} >= w.quantity")),
        Some(false) => p.wheres.push(format!("{OWNED_SQL} < w.quantity")),
        None => {}
    }
    let where_sql = p.where_sql();
    let mut params = p.params;

    let total: i64 = conn
        .query_row(
            &format!("SELECT count(*) FROM {from} WHERE {where_sql}"),
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let order = match q.sort.as_deref() {
        Some("added") => "w.created_at DESC, w.id DESC",
        Some("price") => "unit_price_usd DESC NULLS LAST, w.name ASC, w.id ASC",
        Some("quantity") => "w.quantity DESC, w.name ASC, w.id ASC",
        _ => "w.name ASC, w.id ASC",
    };
    let sql = format!(
        "SELECT w.id, w.oracle_id, w.card_id, w.name, w.set_code, w.collector_number, w.lang,
                c.rarity, c.mana_cost, w.quantity, w.preferred_finish,
                CAST(json_extract(c.prices,
                    CASE coalesce(w.preferred_finish, 'nonfoil')
                        WHEN 'foil' THEN '$.usd_foil'
                        WHEN 'etched' THEN '$.usd_etched'
                        ELSE '$.usd' END) AS REAL) AS unit_price_usd,
                {OWNED_SQL} AS owned_quantity,
                w.notes, w.needs_review, w.updated_at
         FROM {from} WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?"
    );
    params.push(Box::new(limit));
    params.push(Box::new(q.offset));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |r| {
                Ok(WishRow {
                    id: r.get(0)?,
                    oracle_id: r.get(1)?,
                    card_id: r.get(2)?,
                    name: r.get(3)?,
                    set_code: r.get(4)?,
                    collector_number: r.get(5)?,
                    lang: r.get(6)?,
                    rarity: r.get(7)?,
                    mana_cost: r.get(8)?,
                    quantity: r.get(9)?,
                    preferred_finish: r.get(10)?,
                    unit_price_usd: r.get(11)?,
                    owned_quantity: r.get(12)?,
                    notes: r.get(13)?,
                    needs_review: r.get(14)?,
                    updated_at: r.get(15)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    let items = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(WishlistPage { items, total })
}

/// Run `f` with the write connection, or answer [`BUSY`] — the wishlist's copy of the bound
/// [`crate::collection`] documents: a button press on a worker thread, and the only thing
/// that can hold `AppState.db` is a sync taking it one batch at a time.
fn with_write<T>(
    state: &Arc<AppState>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    match crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
        Some(conn) => f(&conn),
        None => Err(BUSY.to_owned()),
    }
}

#[tauri::command]
pub async fn wishlist_add(
    state: tauri::State<'_, Arc<AppState>>,
    wish: WishInput,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| add_wish(c, &wish)))
        .await
        .map_err(|e| format!("the wishlist could not be written: {e}"))?
}

#[tauri::command]
pub async fn wishlist_set_quantity(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    quantity: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_wish_quantity(c, id, quantity))
    })
    .await
    .map_err(|e| format!("the wishlist could not be written: {e}"))?
}

#[tauri::command]
pub async fn wishlist_remove(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| remove_wish(c, id)))
        .await
        .map_err(|e| format!("the wishlist could not be written: {e}"))?
}

/// The wishlist. **Read-only** connection, blocking pool — as every read in this app is.
#[tauri::command]
pub async fn wishlist_list(
    state: tauri::State<'_, Arc<AppState>>,
    query: WishlistQuery,
) -> Result<WishlistPage, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_wishes(&crate::sync::lock_db_read(&state), &query)
    })
    .await
    .map_err(|e| format!("the wishlist could not be read: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        for (id, set, cn) in [("bolt-lea", "lea", "161"), ("bolt-2ed", "2ed", "162")] {
            conn.execute(
                "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    prices,raw)
                 VALUES (?1,'o1','Lightning Bolt',?2,?3,'en','normal',
                    '{\"usd\":\"5.00\",\"usd_foil\":\"40.00\"}','{}')",
                rusqlite::params![id, set, cn],
            )
            .unwrap();
        }
        conn
    }

    /// The distinction spec §6 draws in one word: `card_id` NULL is "any printing", set is
    /// "that one". Both are real wishes and neither replaces the other.
    #[test]
    fn a_wish_can_be_for_any_printing_or_for_one_printing() {
        let conn = seeded();
        let any = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 4,
                ..Default::default()
            },
        )
        .unwrap();
        let specific = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert_ne!(any.id, specific.id);

        let rows = list_wishes(&conn, &WishlistQuery::default()).unwrap();
        assert_eq!(rows.total, 2);
        let any_row = rows.items.iter().find(|r| r.id == any.id).unwrap();
        assert_eq!(any_row.card_id, None);
        assert_eq!(
            any_row.name, "Lightning Bolt",
            "named from the printing it was made from"
        );
        let one = rows.items.iter().find(|r| r.id == specific.id).unwrap();
        assert_eq!(one.set_code.as_deref(), Some("lea"));
    }

    /// An any-printing wish is not for a printing, so it must not quietly claim one: the
    /// set, the collector number and the language stay NULL even though a name was read
    /// from a printing to make the row sayable.
    #[test]
    fn an_any_printing_wish_pins_nothing_but_its_name() {
        let conn = seeded();
        add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();

        let row = &list_wishes(&conn, &WishlistQuery::default()).unwrap().items[0];
        assert_eq!(row.name, "Lightning Bolt");
        assert_eq!(
            (
                row.card_id.as_deref(),
                row.set_code.as_deref(),
                row.collector_number.as_deref(),
                row.lang.as_deref()
            ),
            (None, None, None, None)
        );

        // And an oracle id with no printing left in `cards` still makes a wish — but only
        // with a name the caller supplies, because there is nowhere to read one from.
        let nameless = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o-vanished".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(nameless.contains("needs a card name"), "{nameless}");
        add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o-vanished".into()),
                name: Some("Ancestral Recall".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
    }

    /// Wishing for the same thing twice raises the number rather than making a second
    /// line on the shopping list.
    #[test]
    fn wishing_twice_for_the_same_thing_raises_the_quantity() {
        let conn = seeded();
        let first = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        let second = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 3,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!((first.id, second.quantity), (second.id, 4));
    }

    /// The grain, in the language a user would use for it: the same card wished for in a
    /// different finish, or pinned to a printing, is a different line on the list. Task 4
    /// proved the index; this is the statement that reaches it.
    #[test]
    fn a_different_finish_or_printing_is_a_different_wish() {
        let conn = seeded();
        let wish = |finish: Option<&str>, card: Option<&str>| {
            add_wish(
                &conn,
                &WishInput {
                    oracle_id: Some("o1".into()),
                    card_id: card.map(str::to_owned),
                    preferred_finish: finish.map(str::to_owned),
                    quantity: 1,
                    ..Default::default()
                },
            )
            .unwrap()
            .id
        };

        let mut ids = vec![
            wish(None, None),
            wish(Some("foil"), None),
            wish(Some("etched"), None),
            wish(None, Some("bolt-lea")),
            wish(Some("foil"), Some("bolt-lea")),
            wish(None, Some("bolt-2ed")),
        ];
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 6, "six wishes, six rows");
    }

    /// The enum, refused in words rather than as the table's CHECK — which names
    /// `preferred_finish IN (…)` and no way forward.
    #[test]
    fn an_unknown_preferred_finish_is_refused_with_a_sentence() {
        let conn = seeded();
        let err = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                preferred_finish: Some("Foil".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("nonfoil"), "{err}");
        assert!(!err.contains("CHECK"), "{err}");
    }

    /// "Owned badges appear in search once a wish is fulfilled" (spec §7) needs the count
    /// of what is owned *against the wish*: any printing counts copies of the oracle card,
    /// a pinned wish counts copies of that printing only.
    #[test]
    fn a_wish_reports_how_much_of_it_is_already_owned() {
        let conn = seeded();
        crate::collection::add_entry(
            &conn,
            &crate::collection::EntryInput {
                card_id: "bolt-2ed".into(),
                finish: "nonfoil".into(),
                quantity: 2,
                ..Default::default()
            },
        )
        .unwrap();
        let any = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 4,
                ..Default::default()
            },
        )
        .unwrap();
        let pinned = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();

        let rows = list_wishes(&conn, &WishlistQuery::default()).unwrap();
        let owned_of = |id: i64| {
            rows.items
                .iter()
                .find(|r| r.id == id)
                .unwrap()
                .owned_quantity
        };
        assert_eq!(owned_of(any.id), 2, "any Lightning Bolt counts");
        assert_eq!(owned_of(pinned.id), 0, "the Alpha one is not owned");
    }

    /// "What is still missing" is the question a shopping list is usually asked, and the
    /// answer has to move as the collection does — including through a row emptied to
    /// zero, which the collection keeps and which owns no copies.
    #[test]
    fn the_fulfilled_filter_splits_the_list_by_what_is_already_held() {
        let conn = seeded();
        let held = crate::collection::add_entry(
            &conn,
            &crate::collection::EntryInput {
                card_id: "bolt-2ed".into(),
                finish: "nonfoil".into(),
                quantity: 2,
                ..Default::default()
            },
        )
        .unwrap();
        let covered = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 2,
                ..Default::default()
            },
        )
        .unwrap();
        let missing = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();

        let only = |fulfilled: bool| {
            let page = list_wishes(
                &conn,
                &WishlistQuery {
                    fulfilled: Some(fulfilled),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(
                page.total,
                page.items.len() as i64,
                "count agrees with page"
            );
            page.items.iter().map(|r| r.id).collect::<Vec<_>>()
        };
        assert_eq!(only(true), vec![covered.id]);
        assert_eq!(only(false), vec![missing.id]);

        // Trading the copies away un-fulfils the wish: the collection keeps the row at
        // zero, and zero copies satisfy nothing.
        crate::collection::set_quantity(&conn, held.id, 0).unwrap();
        assert_eq!(only(true), Vec::<i64>::new());
        assert_eq!(only(false).len(), 2);
    }

    /// A wish is removed, never emptied: `quantity > 0` is the table's own CHECK, which is
    /// the asymmetry with the collection's zero-keeps-the-row rule.
    #[test]
    fn taking_a_wish_to_zero_removes_it() {
        let conn = seeded();
        let wish = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 3,
                ..Default::default()
            },
        )
        .unwrap();

        let lowered = set_wish_quantity(&conn, wish.id, 1).unwrap();
        assert_eq!((lowered.quantity, lowered.removed), (1, false));

        let emptied = set_wish_quantity(&conn, wish.id, 0).unwrap();
        assert!(emptied.removed, "zero is a removal, not a state");
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM wishlist_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);

        // A stale id from a list that has not refreshed: an *adjustment* could not do what
        // it was asked, but a delete that finds nothing already has what it wanted.
        let err = set_wish_quantity(&conn, wish.id, 2).unwrap_err();
        assert!(err.contains("not there any more"), "{err}");
        assert!(remove_wish(&conn, wish.id).unwrap().removed);
    }

    #[test]
    fn wish_row_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(WishRow {
            id: 3,
            oracle_id: Some("o1".into()),
            card_id: None,
            name: "Lightning Bolt".into(),
            set_code: None,
            collector_number: None,
            lang: None,
            rarity: Some("common".into()),
            mana_cost: Some("{R}".into()),
            quantity: 4,
            preferred_finish: Some("foil".into()),
            unit_price_usd: Some(40.0),
            owned_quantity: 2,
            notes: None,
            needs_review: None,
            updated_at: 1_800_000_000,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "id": 3, "oracleId": "o1", "cardId": null, "name": "Lightning Bolt",
                "setCode": null, "collectorNumber": null, "lang": null, "rarity": "common",
                "manaCost": "{R}", "quantity": 4, "preferredFinish": "foil",
                "unitPriceUsd": 40.0, "ownedQuantity": 2, "notes": null, "needsReview": null,
                "updatedAt": 1800000000
            })
        );
    }

    /// The page is what the frontend receives, so its wrapper is pinned too — and the
    /// invoke payload is what it sends: `#[serde(default)]` plus the flattened card
    /// filters, which a caller omits entirely until it filters by one.
    #[test]
    fn the_page_and_the_query_carry_the_names_the_frontend_uses() {
        let value = serde_json::to_value(WishlistPage {
            items: vec![],
            total: 0,
        })
        .unwrap();
        assert_eq!(value, serde_json::json!({ "items": [], "total": 0 }));

        let q: WishlistQuery =
            serde_json::from_str(r#"{"text":"bolt","sets":["lea"],"fulfilled":false}"#).unwrap();
        assert_eq!(q.cards.text.as_deref(), Some("bolt"));
        assert_eq!(q.cards.sets.unwrap(), vec!["lea".to_owned()]);
        assert_eq!(q.fulfilled, Some(false));
        assert_eq!(q.limit, 0, "omitted limit means unset, not a parse error");
    }

    /// A wish outlives the printing it was made from — that is what the denormalised
    /// columns are for — and the list has to keep showing it under the set code it
    /// records, including when the reader filters to that code.
    #[test]
    fn a_wish_survives_its_printing_leaving_the_card_database() {
        let conn = seeded();
        let wish = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        conn.execute("DELETE FROM cards WHERE id = 'bolt-lea'", [])
            .unwrap();

        let filtered = list_wishes(
            &conn,
            &WishlistQuery {
                cards: crate::filters::CardFilters {
                    set_code: Some("lea".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(filtered.total, 1);
        let row = &filtered.items[0];
        assert_eq!(row.id, wish.id);
        assert_eq!(row.name, "Lightning Bolt", "the name is the wish's own");
        assert_eq!(row.rarity, None, "nothing is invented for a gone printing");
        assert_eq!(row.unit_price_usd, None);
    }

    /// Free text filters the wish's *own* name, which is the only name an any-printing
    /// wish has.
    #[test]
    fn the_text_filter_matches_the_name_the_wish_carries() {
        let conn = seeded();
        add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o-recall".into()),
                name: Some("Ancestral Recall".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();

        let hit = list_wishes(
            &conn,
            &WishlistQuery {
                cards: crate::filters::CardFilters {
                    text: Some("ancestral".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(hit.total, 1);
        assert_eq!(hit.items[0].name, "Ancestral Recall");
    }

    /// The price is the one the wish would be filled at: the preferred finish's, or the
    /// nonfoil one when the wish names no finish.
    #[test]
    fn the_unit_price_follows_the_preferred_finish() {
        let conn = seeded();
        add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                preferred_finish: Some("foil".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                preferred_finish: Some("etched".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();

        let rows = list_wishes(&conn, &WishlistQuery::default()).unwrap();
        let price_of = |finish: Option<&str>| {
            rows.items
                .iter()
                .find(|r| r.preferred_finish.as_deref() == finish)
                .unwrap()
                .unit_price_usd
        };
        assert_eq!(price_of(None), Some(5.0));
        assert_eq!(price_of(Some("foil")), Some(40.0));
        assert_eq!(
            price_of(Some("etched")),
            None,
            "no etched price is not the nonfoil price"
        );
    }
}
