//! **The desktop's half of `deck_tokens`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::deck_tokens::*;

use crate::sorting::Marketplace;

// ---------------------------------------------------------------------------------------
// The six commands — the deck's read, the four writes, and every token in the game
// ---------------------------------------------------------------------------------------

/// [`deck_token_rows`]' command. Read-only connection on the blocking pool, as
/// [`crate::card::card_meld_parts`] is and for the same reason.
///
/// **`marketplace` is `card_printings`' argument exactly** — an `Option<String>` resolved by
/// [`Marketplace::from_opt`], so absent, null, a typo and a future id all price at TCGplayer
/// rather than refusing to draw a deck's tokens over a setting. It prices each entry's
/// [`DeckTokenRow::unit_price`], which a pile heading sums. The art picker the reader opens next
/// is `card_printings`, which already answers on a token — its predicate is
/// `oracle_id = ?1 AND is_paper = 1` and every token row satisfies both. Only its **All tokens**
/// toggle, which is not about one token, reads [`token_printings`] instead.
#[tauri::command]
pub async fn deck_tokens(
    state: tauri::State<'_, std::sync::Arc<crate::sync::AppState>>,
    deck_id: i64,
    variant: String,
    marketplace: Option<String>,
) -> Result<Vec<DeckTokenRow>, String> {
    let app = state.inner().clone();
    let market = Marketplace::from_opt(marketplace.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        deck_token_rows(&crate::sync::lock_db_read(&app), deck_id, &variant, market)
    })
    .await
    .map_err(|e| format!("this deck's tokens could not be read: {e}"))?
}

/// [`set_quantity`]'s command. `entry` is `{ cardId, finish }`, or `null` for the implicit entry.
///
/// Plain [`crate::sync::with_write`] and **not** `with_write_owned`, for all four writes: that one
/// is for the commands that move copies across the collection/deck boundary, and no token write
/// touches the collection.
#[tauri::command]
pub async fn deck_token_set_quantity(
    state: tauri::State<'_, std::sync::Arc<crate::sync::AppState>>,
    deck_id: i64,
    variant: String,
    oracle_id: String,
    entry: Option<TokenEntryKey>,
    quantity: i64,
) -> Result<(), String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&app, |c| {
            set_quantity(c, deck_id, &variant, &oracle_id, entry.as_ref(), quantity)
        })
    })
    .await
    .map_err(|e| format!("that token could not be saved: {e}"))?
}

/// [`swap`]'s command. `from` is `{ cardId, finish }` or `null` for the implicit entry; `to` is
/// always a printing and a finish, the picker's grain.
#[tauri::command]
pub async fn deck_token_swap(
    state: tauri::State<'_, std::sync::Arc<crate::sync::AppState>>,
    deck_id: i64,
    variant: String,
    oracle_id: String,
    from: Option<TokenEntryKey>,
    to: TokenEntryKey,
) -> Result<(), String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&app, |c| {
            swap(c, deck_id, &variant, &oracle_id, from.as_ref(), &to)
        })
    })
    .await
    .map_err(|e| format!("that token's printing could not be changed: {e}"))?
}

/// [`add_printing`]'s command — one copy of a printing in a finish, rule 5. A `null` finish is
/// the printing's default.
#[tauri::command]
pub async fn deck_token_add_printing(
    state: tauri::State<'_, std::sync::Arc<crate::sync::AppState>>,
    deck_id: i64,
    variant: String,
    card_id: String,
    finish: Option<String>,
) -> Result<(), String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&app, |c| {
            add_printing(c, deck_id, &variant, &card_id, finish.as_deref()).map(|_| ())
        })
    })
    .await
    .map_err(|e| format!("that token could not be added: {e}"))?
}

/// [`remove_entry`]'s command — **Remove printing**. `entry` is always `{ cardId, finish }`: an
/// implicit entry is not in the table, so there is nothing to remove, and the page draws the
/// button on a stored entry only.
///
/// It replaced two commands at v55: `deck_token_state`, whose dismiss went with the eye button
/// (and whose restore had nothing left to restore once [`retire_hidden`] runs), and
/// `deck_token_reset`, which one Remove per printing covers.
#[tauri::command]
pub async fn deck_token_remove(
    state: tauri::State<'_, std::sync::Arc<crate::sync::AppState>>,
    deck_id: i64,
    variant: String,
    oracle_id: String,
    entry: TokenEntryKey,
) -> Result<(), String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&app, |c| {
            remove_entry(c, deck_id, &variant, &oracle_id, &entry)
        })
    })
    .await
    .map_err(|e| format!("that token's printing could not be removed: {e}"))?
}

/// [`list_token_printings`]' command — every paper token and emblem printing, for Add printing's
/// **All tokens**. Read-only connection on the blocking pool, [`deck_tokens`]' shape, and
/// `marketplace` is `card_printings`' argument exactly, so the two pickers price alike.
///
/// **The read wears the `list_` name and the command the short one**, `card::list_printings` and
/// `card_printings`' arrangement: `generate_handler!` registers a command under its last path
/// segment, so the name here is the wire name `src/lib/ipc.ts` invokes.
#[tauri::command]
pub async fn token_printings(
    state: tauri::State<'_, std::sync::Arc<crate::sync::AppState>>,
    marketplace: Option<String>,
) -> Result<Vec<TokenPrinting>, String> {
    let app = state.inner().clone();
    let market = Marketplace::from_opt(marketplace.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        list_token_printings(&crate::sync::lock_db_read(&app), market)
    })
    .await
    .map_err(|e| format!("the tokens could not be read: {e}"))?
}

/// The tests of `deck_tokens` that name something this crate still holds. Each goes home when what it
/// names does.
#[cfg(test)]
mod tests {
    use super::*;
    use grimoire_core::deck_tokens::fixtures::*;

    /// **The backstop**: a cut through `collection_alloc::deck_to_collection` files no undo step,
    /// so its transaction has nowhere to put a reconcile — and after `sync::with_write` returns
    /// the Treasure is settled anyway by the reconcile that rides every write: its entry at zero
    /// gone, and the one with copies kept as `manual`.
    #[test]
    fn the_backstop_reconciles_a_cut_that_files_no_step() {
        let state = crate::index::fixtures::state_with_seeded_cards("deck-tokens-backstop");
        let (deck, landed) = {
            let conn = crate::db::lock_blocking(&state.db);
            tithe().insert(&conn);
            tithe_other_printing().insert(&conn);
            treasure().insert(&conn);
            treasure_older().insert(&conn);
            let deck = crate::deck::create_deck(
                &conn,
                &crate::deck::DeckInput {
                    name: "Tithe".to_owned(),
                    format_key: "commander".to_owned(),
                    ..Default::default()
                },
            )
            .unwrap()
            .id;
            let landed = crate::deck::add_card(
                &conn,
                deck,
                tithe().id,
                None,
                Some("Main deck"),
                "live",
                None,
                1,
            )
            .unwrap()
            .id;
            seed_used_and_zero_treasure(&conn, deck);
            (deck, landed)
        };

        crate::sync::with_write(&state, |c| {
            crate::collection_alloc::deck_to_collection(c, landed, 1).map(|_| ())
        })
        .unwrap();

        let conn = crate::db::lock_blocking(&state.db);
        assert_kept_as_manual(&conn, deck, "the backstop");
    }

    /// **A paired device converts nothing at launch until a pull at v52 has landed, and from
    /// then on converts at launch too.** The launch pass is where a paired device would convert
    /// before hearing its group; the pull half sets [`PICKS_READY`] and converts, and a pick that
    /// reaches the table afterwards by some other route is converted by the next launch.
    #[test]
    fn a_paired_device_converts_nothing_at_launch_before_its_first_pull() {
        let conn = paired();
        let (deck, _, _) = deck_with_piles(&conn);
        seed_pick(&conn, deck, &treasure(), Some(2), "u-pick");

        convert_legacy_picks_at_launch(&conn).unwrap();
        assert_eq!(entries(&conn, deck), [], "the launch waits for a pull");
        assert_eq!(
            stored(&conn, deck)[0].1.as_deref(),
            Some(treasure().id),
            "and the pick is still set"
        );

        pulled(&conn, &[]);
        assert_eq!(
            entries(&conn, deck),
            vec![
                e("live", treasure().oracle_id, treasure().id, "nonfoil", 2),
                e("theory", treasure().oracle_id, treasure().id, "nonfoil", 2),
            ],
            "the first pull converts"
        );
        assert_eq!(
            crate::sync_engine::client::get_state(&conn, PICKS_READY).as_deref(),
            Some("1")
        );

        seed_pick(&conn, deck, &goblin(), Some(1), "u-goblin");
        convert_legacy_picks_at_launch(&conn).unwrap();
        assert_eq!(
            entries(&conn, deck).len(),
            4,
            "a launch after that pull converts again"
        );
    }
}
