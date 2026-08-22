//! Which decks a deck-driven collection row's copies are sitting in.
//!
//! The one question a derived row creates and nothing else answers: the Collection page's
//! Actions column loses its delete button while [`crate::deck_driven`] is on, and this is
//! what fills it — a count drawn from the row itself, and these names behind a tooltip.
//!
//! **Asked lazily, per row, on hover.** A 100-row page would otherwise carry several hundred
//! deck names nobody looks at, and the count the reader actually reads is already free in the
//! aggregate [`crate::collection_source::rows`] groups by.

use crate::sync::AppState;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::sync::Arc;

/// One deck holding copies of a collection row's printing.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowDeck {
    pub deck_id: i64,
    pub deck_name: String,
    /// Copies in **this** deck, summed across its categories — the inactive ones included,
    /// because these lines have to add up to the count the row shows.
    pub quantity: i64,
}

/// The decks holding a printing, in the finish and language the collection row names.
///
/// **`finish` arrives in the collection's spelling and is translated back.** A regular copy
/// is `'nonfoil'` on a collection row and NULL on a deck card, so the predicate is the same
/// `coalesce(dc.finish, 'nonfoil')` the derived source groups by — the same expression, for
/// the same reason, and a mismatch here would silently empty the tooltip on every regular
/// row while the count above it read three.
///
/// `live` only, matching the rule the row itself came from. Ordered by name so the tooltip
/// reads the way the Decks page does, with the id as the tiebreak two decks of one name need.
pub fn row_decks(
    conn: &Connection,
    card_id: &str,
    finish: &str,
    lang: &str,
) -> Result<Vec<RowDeck>, String> {
    let sql = format!(
        "SELECT d.id, d.name, sum(dc.quantity)
           FROM deck_cards dc
           JOIN decks d ON d.id = dc.deck_id
          WHERE {LIVE}
            AND dc.card_id = ?1
            AND coalesce(dc.finish, 'nonfoil') = ?2
            AND dc.lang = ?3
          GROUP BY d.id, d.name
          ORDER BY d.name COLLATE NOCASE ASC, d.id ASC",
        LIVE = crate::collection_source::LIVE
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![card_id, finish, lang], |r| {
            Ok(RowDeck {
                deck_id: r.get(0)?,
                deck_name: r.get(1)?,
                quantity: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Read-only connection, blocking pool — as every read in this app is, so a hovered tooltip
/// never queues behind a sync.
#[tauri::command]
pub async fn collection_row_decks(
    state: tauri::State<'_, Arc<AppState>>,
    card_id: String,
    finish: String,
    lang: String,
) -> Result<Vec<RowDeck>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        row_decks(&crate::sync::lock_db_read(&state), &card_id, &finish, &lang)
    })
    .await
    .map_err(|e| format!("the decks holding this card could not be read: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO decks (id, name, created_at, updated_at)
                  VALUES (1,'Krenko',0,0), (2,'Atraxa',0,0), (3,'Plan',0,0);
             INSERT INTO deck_categories (id, deck_id, name, kind, is_active, sort_order,
                                          created_at, updated_at)
                  VALUES (10,1,'Ramp','main',1,0,0,0),
                         (11,1,'Maybeboard','maybe',0,1,0,0),
                         (12,2,'Ramp','main',1,0,0,0),
                         (13,3,'Ramp','main',1,0,0,0);
             INSERT INTO deck_cards (deck_id, category_id, variant, card_id, set_code,
                                     collector_number, lang, name, quantity, finish,
                                     created_at, updated_at)
                  VALUES (1,10,'live','p1','cmr','472','en','Sol Ring',1,NULL,0,0),
                         (1,11,'live','p1','cmr','472','en','Sol Ring',2,NULL,0,0),
                         (1,10,'live','p1','cmr','472','en','Sol Ring',1,'foil',0,0),
                         (2,12,'live','p1','cmr','472','en','Sol Ring',1,NULL,0,0),
                         (3,13,'theory','p1','cmr','472','en','Sol Ring',9,NULL,0,0);",
        )
        .unwrap();
        conn
    }

    /// One line per deck, summed across that deck's categories — including the switched-off
    /// one, because the tooltip has to add up to the number above it.
    #[test]
    fn it_sums_a_decks_categories_into_one_line() {
        let got = row_decks(&db(), "p1", "nonfoil", "en").unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].deck_name, "Atraxa", "ordered by name, not by id");
        assert_eq!(got[0].quantity, 1);
        assert_eq!(got[1].deck_name, "Krenko");
        assert_eq!(
            got[1].quantity, 3,
            "1 in Ramp and 2 in the inactive Maybeboard"
        );
    }

    /// The collection spells the regular copy `nonfoil` and the deck stores NULL. Asking
    /// with the row's own word must find the row.
    #[test]
    fn the_regular_finish_is_translated_back() {
        let foil = row_decks(&db(), "p1", "foil", "en").unwrap();
        assert_eq!(foil.len(), 1);
        assert_eq!(foil[0].quantity, 1);
    }

    /// The tooltip explains a row of the collection, and a theory row is not one.
    #[test]
    fn a_theory_row_is_not_listed() {
        let got = row_decks(&db(), "p1", "nonfoil", "en").unwrap();
        assert!(got.iter().all(|d| d.deck_name != "Plan"));
    }

    #[test]
    fn a_card_in_no_deck_answers_an_empty_list() {
        assert!(row_decks(&db(), "nope", "nonfoil", "en")
            .unwrap()
            .is_empty());
    }
}
