//! Which marketplace the app quotes prices from — the setting, and nothing else.
//!
//! **A marketplace is a label; the currency is the axis everything downstream turns on.** No
//! price query in this crate branches on an id: `cards.prices` draws exactly one distinction,
//! USD against EUR, and every price surface already carries both. So all this module owns is
//! one string in `app_meta` — Rust stores the fact, `src/lib/marketplace.ts` draws the
//! conclusions (label, currency, whether this build can quote a price there at all).
//!
//! Two rules shape it:
//!
//! * **Reading can never fail.** A missing row, a row a *newer* build wrote, a row somebody
//!   hand-edited — all three read as [`DEFAULT_MARKETPLACE`]. An unparseable setting is a
//!   fact about storage, not a reason to fail a query, and a future build's id must not
//!   brick an older one that gets pointed at the same `mtg.db`.
//! * **Writing validates.** [`set_marketplace`] refuses anything outside [`MARKETPLACE_IDS`],
//!   so the table cannot accumulate junk that every later read would silently discard.
//!
//! No migration: `app_meta` is schema v6's key/value table, and this is a key in it.
//!
//! See `docs/superpowers/specs/2026-08-12-card-marketplace-pricing-design.md`.

use crate::sync::AppState;
use rusqlite::Connection;
use std::sync::Arc;

/// Every marketplace id this build recognises, in the order the picker lists them.
///
/// The mirror of `MARKETPLACE_IDS` in `src/lib/marketplace.ts`. Deliberately a flat list of
/// strings and not an enum with labels and currencies: those are TypeScript's, and the only
/// question Rust has to answer about an id is whether it is one of these.
///
/// Two of the five have a price feed today (TCGplayer through Scryfall's `usd*` keys,
/// Cardmarket through `eur*`); the other three are in the list because the *setting* knows
/// them and the picker shows them. Storing an id this build cannot price is a UI decision,
/// not a storage one — and keeping them here is what lets a build that gains a feed read a
/// setting an earlier one refused to write.
pub const MARKETPLACE_IDS: [&str; 5] = [
    "tcgplayer",
    "cardmarket",
    "cardkingdom",
    "manapool",
    "cardtrader",
];

/// What the app quotes when nobody has chosen — TCGplayer, because it is what every price in
/// the app was before this setting existed.
pub const DEFAULT_MARKETPLACE: &str = "tcgplayer";

/// The `app_meta` key. The table is the *application's*, deliberately not `sync_meta` — a row
/// in that one the sync did not write makes every later timing claim a fiction (schema v6).
pub const K_MARKETPLACE: &str = "marketplace";

/// Is this an id this build knows?
pub fn is_known(id: &str) -> bool {
    MARKETPLACE_IDS.contains(&id)
}

/// The stored marketplace, or [`DEFAULT_MARKETPLACE`].
///
/// Three cases collapse into the fallback and it matters that they do: no row, an unreadable
/// row (`get_app_meta` swallows the error), and a row holding an id this build does not
/// recognise. None of them is worth failing a price query over.
pub fn stored(conn: &Connection) -> String {
    crate::update::get_app_meta(conn, K_MARKETPLACE)
        .filter(|id| is_known(id))
        .unwrap_or_else(|| DEFAULT_MARKETPLACE.to_owned())
}

/// Write the setting, refusing an id this build does not know.
///
/// The refusal is the whole point of the function: [`stored`] discards an unrecognised value
/// silently, so without this a typo'd id would look like it saved and then read back as
/// TCGplayer forever.
pub fn store(conn: &Connection, id: &str) -> Result<(), String> {
    if !is_known(id) {
        return Err(format!(
            "\"{id}\" is not a marketplace this app knows. Expected one of: {}.",
            MARKETPLACE_IDS.join(", ")
        ));
    }
    crate::update::set_app_meta(conn, K_MARKETPLACE, id)
        .map_err(|e| format!("could not save the marketplace: {e}"))
}

/// The selected marketplace, as a raw id.
///
/// **Infallible by signature**, which is the contract and not an accident: the frontend reads
/// this before it can draw a single price, and there is no sensible thing for a price surface
/// to do with an error here that is not just "assume the default" — so this does that instead
/// of making every caller do it.
///
/// `#[tauri::command(async)]` rather than a bare sync command: a sync body runs inline on the
/// IPC thread, and this one takes `db_read`'s mutex, which a search may hold for tens of
/// milliseconds. It is not an `async fn` because Tauri requires a `Result` from one that
/// borrows `State`, and a `Result` here would be a failure mode this call does not have.
#[tauri::command(async)]
pub fn get_marketplace(state: tauri::State<'_, Arc<AppState>>) -> String {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Choose a marketplace. Rejects an unknown id, and answers [`crate::db::BUSY`] if a
/// sync holds the write connection — the bound every write command in this crate takes.
#[tauri::command]
pub async fn set_marketplace(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || set_marketplace_now(&state, &id))
        .await
        .map_err(|e| format!("the marketplace could not be saved: {e}"))?
}

/// [`set_marketplace`]'s body, with the `AppState` handed in.
///
/// Split out so the mark below can be tested: a `#[tauri::command]` taking `tauri::State`
/// cannot be entered from a test, and one line that only matters to another subsystem is
/// exactly the kind that gets dropped and never noticed.
///
/// **Every price the plain-text mirror has written just changed meaning**, so the mirror is told
/// explicitly. It cannot learn this any other way: the setting is an `app_meta` row, and that
/// table maps to no surface on purpose — a sync writes it, and the update hook has to stay quiet
/// through 116 700 rows. A live pass found every mirrored CSV still carrying the previous
/// marketplace's prices until `Rebuild now` was pressed, which moved one row from 8.25 to 5.99.
///
/// Only on success, and only where [`store`] accepted the id: a refusal changed nothing on disk
/// and must not cost a full render. This is the shape
/// [`crate::mirror::settings::set_root_now`] already has.
pub fn set_marketplace_now(state: &AppState, id: &str) -> Result<(), String> {
    let saved = crate::sync::with_write(state, |conn| store(conn, id));
    if saved.is_ok() {
        state.mirror.mark_all();
    }
    saved
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    /// The setting outlives the process, so the only thing that matters about it is that what
    /// went in comes back out — for every id, not just the two that are priced today.
    #[test]
    fn every_known_marketplace_round_trips() {
        let conn = db();
        for id in MARKETPLACE_IDS {
            store(&conn, id).unwrap();
            assert_eq!(stored(&conn), id);
        }
    }

    /// A database that has never been told is a database that quotes TCGplayer — which is
    /// what every price in the app was before this setting existed.
    #[test]
    fn a_missing_row_reads_as_the_default() {
        let conn = db();
        assert_eq!(crate::update::get_app_meta(&conn, K_MARKETPLACE), None);
        assert_eq!(stored(&conn), "tcgplayer");
    }

    /// A newer build's id must not brick an older one pointed at the same `mtg.db`. Written
    /// past `store` deliberately — this is the row a *different* build left behind, which no
    /// validation of ours was ever in a position to refuse.
    #[test]
    fn a_value_this_build_does_not_know_reads_as_the_default_rather_than_failing() {
        let conn = db();
        for junk in ["ebay", "", "TCGPLAYER", "tcgplayer ", "null"] {
            crate::update::set_app_meta(&conn, K_MARKETPLACE, junk).unwrap();
            assert_eq!(
                stored(&conn),
                "tcgplayer",
                "an unrecognised `{junk}` must read as the default, not fail"
            );
        }
    }

    /// The refusal, and the half of it that is easy to forget: a rejected write must leave the
    /// previous choice alone. `stored` discards junk silently, so a write that half-landed
    /// would look like a save and read back as TCGplayer forever.
    #[test]
    fn an_unknown_id_is_refused_and_leaves_the_stored_one_intact() {
        let conn = db();
        store(&conn, "cardmarket").unwrap();

        let err = store(&conn, "ebay").unwrap_err();
        assert!(err.contains("ebay"), "{err}");
        assert!(
            err.contains("cardmarket"),
            "the message lists what is valid: {err}"
        );

        assert_eq!(stored(&conn), "cardmarket");
        assert_eq!(
            crate::update::get_app_meta(&conn, K_MARKETPLACE).as_deref(),
            Some("cardmarket"),
            "nothing was written to `app_meta`"
        );
    }

    /// Case and whitespace are not forgiven on the way in either — the id is a key the
    /// frontend matches verbatim, so "close enough" would store something no lookup finds.
    #[test]
    fn a_near_miss_is_still_a_refusal() {
        let conn = db();
        for near in ["TCGplayer", " tcgplayer", "tcgplayer\n", "card_market"] {
            assert!(store(&conn, near).is_err(), "`{near}` must not be stored");
        }
        assert_eq!(stored(&conn), DEFAULT_MARKETPLACE);
    }

    /// The default has to be a member of the list it falls back into, or `stored` would
    /// return a value `set_marketplace` refuses to write.
    #[test]
    fn the_default_is_one_of_the_known_ids() {
        assert!(is_known(DEFAULT_MARKETPLACE));
        let conn = db();
        store(&conn, DEFAULT_MARKETPLACE).unwrap();
        assert_eq!(stored(&conn), DEFAULT_MARKETPLACE);
    }
}
