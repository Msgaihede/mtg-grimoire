//! **The desktop's half of `deck`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::deck::*;

use crate::collection::EntryChange;
use crate::sync::{with_write, AppState};
use std::sync::Arc;

/// What a deck write says when its worker thread died under it. Never a user's problem —
/// the write itself answers [`crate::db::BUSY`] when the database is busy.
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
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| update_deck(c, id, &patch))
    })
    .await
    .map_err(unfinished)?
}

/// Delete a deck.
///
/// **No `AppHandle`, where every other wrapper in this pair has one**: this took one solely to
/// resolve the covers directory so the deck's `<id>.webp` could go with it, and custom covers
/// went on 2026-08-31.
#[tauri::command]
pub async fn deck_delete(state: tauri::State<'_, Arc<AppState>>, id: i64) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // **Plain `with_write` even though this files the deck's whole group into
        // `Recently removed`** — [`deck_clear`]'s note, and [`release_live_copies`] carries the
        // argument: every row keeps its `card_id` and only its folder changes, and the facet
        // index's `owned` dimension names no folder.
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| delete_deck(c, id))
    })
    .await
    .map_err(unfinished)?
}

/// Copy a deck, its categories, its labels and its cards. See [`duplicate_deck`].
///
/// **No `AppHandle`, for [`deck_delete`]'s reason**: it carried one only to resolve the covers
/// directory the copy's own `<id>.webp` was written into.
#[tauri::command]
pub async fn deck_duplicate(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<DeckRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| duplicate_deck(c, id))
    })
    .await
    .map_err(unfinished)?
}

/// File a deck under a folder, or with `folderId: null` back at the root of the tree — the one
/// thing [`DeckPatch`] cannot express. See [`set_folder`].
#[tauri::command]
pub async fn deck_set_folder(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    folder_id: Option<i64>,
) -> Result<DeckRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_folder(c, deck_id, folder_id))
    })
    .await
    .map_err(unfinished)?
}

/// Remember where the reader was looking at this deck. See [`set_view_state`] — it moves no
/// `updated_at`, records no history and reallocates nothing.
///
/// Answers `()` rather than a [`DeckRow`]: every other write here hands back the row the gallery
/// would read, because every other write changes something a gallery draws. This changes one
/// thing the *editor* will read on its next open, and a caller that re-rendered a deck tile over
/// it would be redrawing for a scroll position.
#[tauri::command]
pub async fn deck_set_view_state(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    view_state: DeckViewState,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_view_state(c, deck_id, &view_state))
    })
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

/// Every deck's printed mana costs, for the gallery's colour bars. **Read-only** connection,
/// blocking pool, and no arguments — see [`pip_costs`] for why the whole wall is one read.
#[tauri::command]
pub async fn deck_pip_costs(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<DeckPipCosts>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || pip_costs(&crate::sync::lock_db_read(&state)))
        .await
        .map_err(|e| format!("the deck colours could not be read: {e}"))?
}

/// Everything the Commander bracket estimate is made of, for the decks named. **Read-only**
/// connection, blocking pool.
///
/// `deck_ids` reaches the wire as `deckIds`, which `packages/ui/lib/ipc.ts` spells that way —
/// `invoke` matches a command's parameters by name, so the two have to agree.
#[tauri::command]
pub async fn deck_bracket_reads(
    state: tauri::State<'_, Arc<AppState>>,
    deck_ids: Vec<i64>,
) -> Result<Vec<DeckBracketRead>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        bracket_reads(&crate::sync::lock_db_read(&state), &deck_ids)
    })
    .await
    .map_err(|e| format!("the deck brackets could not be read: {e}"))?
}

/// One deck, one variant's cards, every category and label, every fact the validator needs.
/// **Read-only** connection.
#[tauri::command]
pub async fn deck_get(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    variant: String,
    marketplace: Option<String>,
) -> Result<Option<DeckDetail>, String> {
    let state = state.inner().clone();
    let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        get_deck(
            &crate::sync::lock_db_read(&state),
            id,
            &variant,
            marketplace,
        )
    })
    .await
    .map_err(|e| format!("the deck could not be read: {e}"))?
}

/// Every card a deck's **live** list plays, as the keys the folder rule is answered from.
/// **Read-only.**
///
/// The keys are `coalesce(cards.oracle_id, deck_cards.card_id)` and are the deck's *facts*: what
/// a page makes of them — greying a destination, refusing a drop, explaining why — is
/// TypeScript's, this crate's boundary as usual. A deck with an empty live list and a deck id
/// with no deck both answer `[]`; [`deck_get`] is where "is there a deck" is asked.
#[tauri::command]
pub async fn deck_played_keys(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
) -> Result<Vec<String>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        played_keys(&crate::sync::lock_db_read(&state), deck_id)
    })
    .await
    .map_err(|e| format!("the deck's cards could not be read: {e}"))?
}

/// Which decks play **all** of these cards. **Read-only.**
///
/// [`deck_played_keys`] read from the collection's end, and the one the copies page wants: it
/// holds a row and asks which decks that row may be filed into. `AND` and not `OR` — see
/// [`decks_playing`] — and an empty `keys` answers `[]`, because nobody plays nothing.
#[tauri::command]
pub async fn deck_ids_playing(
    state: tauri::State<'_, Arc<AppState>>,
    keys: Vec<String>,
) -> Result<Vec<i64>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        decks_playing(&crate::sync::lock_db_read(&state), &keys)
    })
    .await
    .map_err(|e| format!("the decks playing those cards could not be read: {e}"))?
}

/// The format rules as data, for the picker and the validation engine. **Read-only.**
#[tauri::command]
pub async fn format_specs_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<FormatSpecRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_format_specs(&crate::sync::lock_db_read(&state))
    })
    .await
    .map_err(|e| format!("the format list could not be read: {e}"))?
}

/// The format the last created deck was in, for the New deck dialog to open on. **Read-only.**
///
/// `null` means no deck has ever been created here — a fresh install, or a database whose
/// `app_meta` row predates this key. The caller decides what to show for that, and for a key
/// the picker no longer offers; see [`last_deck_format`]. The `Result` is `spawn_blocking`'s
/// join and nothing else, because the read itself has no failure mode: `get_app_meta` reads an
/// unreadable row as `None`.
#[tauri::command]
pub async fn deck_last_format(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<String>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        last_deck_format(&crate::sync::lock_db_read(&state))
    })
    .await
    .map_err(|e| format!("the last deck format could not be read: {e}"))
}

/// The one click: everything this deck is short of, onto the wishlist.
///
/// **`folderId` is where they are filed, and absent is the wishlist's root** — the destination
/// every press had before the button could offer one, and the destination a caller that sends
/// nothing still gets. A folder that is not there is refused by name before a single wish is
/// written, including for a deck that turns out to be short of nothing.
#[tauri::command]
pub async fn deck_missing_to_wishlist(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    folder_id: Option<i64>,
) -> Result<usize, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| missing_to_wishlist(c, deck_id, folder_id))
    })
    .await
    .map_err(unfinished)?
}

/// Put copies into a category. **`categoryId` or `categoryName`, and at least one** — see
/// [`add_card`] for which wins when both arrive.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn deck_add_card(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    category_id: Option<i64>,
    category_name: Option<String>,
    variant: String,
    finish: Option<String>,
    quantity: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| {
            add_card(
                c,
                deck_id,
                &card_id,
                category_id,
                category_name.as_deref(),
                &variant,
                finish.as_deref(),
                quantity,
            )
        })
    })
    .await
    .map_err(unfinished)?
}

/// The card menu's `Add to actual` and `Add to theory` (issue #592). **`variant` is the list the
/// card goes into** and `fromCategoryId` the pile it sits in now — see [`add_card_to_other_list`].
#[tauri::command]
pub async fn deck_add_card_to_other_list(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    from_category_id: i64,
    variant: String,
    finish: Option<String>,
    quantity: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`, [`deck_add_card`]'s reason: a deck write moves nothing the reader
        // owns.
        with_write(&state, |c| {
            add_card_to_other_list(
                c,
                deck_id,
                &card_id,
                from_category_id,
                &variant,
                finish.as_deref(),
                quantity,
            )
        })
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_set_card_quantity(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    category_id: i64,
    variant: String,
    finish: Option<String>,
    quantity: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| {
            set_card_quantity(
                c,
                deck_id,
                &card_id,
                category_id,
                &variant,
                finish.as_deref(),
                quantity,
            )
        })
    })
    .await
    .map_err(unfinished)?
}

/// Answers the copies it removed, so the caller can say what happened without re-reading the
/// deck to work it out.
#[tauri::command]
pub async fn deck_category_clear(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    category_id: i64,
    variant: String,
) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // **Plain `with_write` even though a `live` clear writes `collection_entries`.** The
        // release moves rows *between folders* and folds some of them away, and
        // `with_write_owned`'s whole extra step is the facet index's folder-blind `owned`
        // dimension — so no card enters or leaves the reader's ownership here. The argument in
        // full is on [`release_live_copies`].
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| {
            clear_category(c, deck_id, category_id, &variant)
        })
    })
    .await
    .map_err(unfinished)?
}

/// Answers the copies it removed, so the caller can say what happened without re-reading the
/// deck to work it out.
#[tauri::command]
pub async fn deck_clear(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    variant: String,
) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // **Plain `with_write` even though a `live` clear writes `collection_entries`** —
        // [`deck_category_clear`]'s note at this scope, and [`release_live_copies`] carries the
        // argument: the release re-files rows between folders, and the facet index's `owned`
        // dimension names no folder.
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| clear_variant(c, deck_id, &variant))
    })
    .await
    .map_err(unfinished)?
}

/// A drag onto a column, and the quick zones' `Auto` — one command, two ways of naming the
/// target, which is [`add_card`]'s arrangement and is documented on [`move_card`]. Answers the
/// category the copies are now in, because the name arm's caller has no other way to learn what
/// was found or made.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn deck_move_card(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    from_category_id: i64,
    to_category_id: Option<i64>,
    to_category_name: Option<String>,
    variant: String,
    finish: Option<String>,
) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| {
            move_card(
                c,
                deck_id,
                &card_id,
                from_category_id,
                to_category_id,
                to_category_name.as_deref(),
                &variant,
                finish.as_deref(),
            )
        })
    })
    .await
    .map_err(unfinished)?
}

/// The card pane's "Use this printing". `deckId` like every other card write's, because
/// `decks.id` is an integer everywhere it is written.
#[tauri::command]
pub async fn deck_swap_printing(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    from_card_id: String,
    to_card_id: String,
    category_id: i64,
    variant: String,
    finish: Option<String>,
) -> Result<SwapResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| {
            swap_printing(
                c,
                deck_id,
                &from_card_id,
                &to_card_id,
                category_id,
                &variant,
                finish.as_deref(),
            )
        })
    })
    .await
    .map_err(unfinished)?
}

/// The deck card menu's `Set as foil` and the card pane's own button. `fromFinish` is the row
/// being addressed and `toFinish` what it should become — both `null` for the regular copy,
/// which is the only spelling of it that reaches the column.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn deck_set_card_finish(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    category_id: i64,
    variant: String,
    from_finish: Option<String>,
    to_finish: Option<String>,
) -> Result<SwapResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| {
            set_card_finish(
                c,
                deck_id,
                &card_id,
                category_id,
                &variant,
                from_finish.as_deref(),
                to_finish.as_deref(),
            )
        })
    })
    .await
    .map_err(unfinished)?
}

/// Every deck's value, for the home page's tiles. **Read-only** connection, blocking pool — as
/// every read in this app is, so a home page never queues behind a sync.
///
/// **No arguments but the shop**, [`deck_pip_costs`]'s reasoning: the page draws whichever decks
/// its widgets pin and there is nothing to narrow by, since an archived deck is a tile too. And
/// anything the app does not recognise is TCGplayer — [`crate::sorting::Marketplace::from_opt`]'s
/// rule for every list query, so a marketplace this build has never heard of costs a fallback
/// rather than a failed page.
#[tauri::command]
pub async fn deck_values(
    state: tauri::State<'_, Arc<AppState>>,
    marketplace: Option<String>,
) -> Result<Vec<DeckValue>, String> {
    let state = state.inner().clone();
    let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        deck_values_for(&crate::sync::lock_db_read(&state), marketplace)
    })
    .await
    .map_err(|e| format!("the deck values could not be read: {e}"))?
}
