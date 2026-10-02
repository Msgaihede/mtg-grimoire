//! **The desktop's half of `deck`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.
//!
//! [`bracket_reads`] and [`DeckBracketRead`] are here for a different reason: they name `combos`,
//! a feed, which moves with the extraction's I/O step. They go home with it.

pub use grimoire_core::deck::*;

use crate::collection::EntryChange;
use crate::sync::{with_write, AppState};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::sync::Arc;

/// Everything the Commander bracket estimate is made of, for one deck.
///
/// Serialised `camelCase`, as every DTO here is.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeckBracketRead {
    pub deck_id: i64,
    pub cards: Vec<BracketCardRow>,
    /// The fourth signal, and the one no amount of reading a card's own text can find: a
    /// two-card infinite is a fact about an *interaction*. **A database that has never fetched
    /// Commander Spellbook's file answers `[]`**, which the crate documents as a supported state
    /// rather than an error — the estimate is then made from three signals instead of four.
    pub combos: Vec<crate::combos::DeckCombo>,
}

/// The pile the bracket is read over: **live rows in an active category, every kind.**
///
/// Deliberately *not* [`PIP_COSTS_SQL`]'s three kinds. A sideboard is inside a Commander deck's
/// bracket — the format has no sideboard, so a reader who has filed cards there has filed them
/// somewhere the estimate still has to see — and this is what `DeckBracket.tsx` hands the
/// estimator today, which filters `categoryActive` and nothing else. Two reads of one deck
/// answering two different piles is the disagreement worth avoiding; the gallery and the editor
/// have to reach the same bracket for the same deck.
///
/// **`SELECT DISTINCT`, because the estimator dedupes by name anyway.** A card in two piles, or
/// as a foil row beside a regular one, is two `deck_cards` rows saying one thing about a bracket
/// — and this read ships oracle text for every deck on the page at once (measured on the dev
/// database: 397 distinct cards across 4 decks, 59 KB of text). The `ORDER BY` names all four
/// selected columns rather than the name alone, so two runs over one database cannot answer in
/// two different orders even where a name is carried by rows that differ.
///
/// `LEFT JOIN cards` is this file's discipline unchanged: an orphaned row keeps its
/// denormalized name and contributes no text, which is the honest reading — nothing is known
/// about a card that is not there.
const BRACKET_CARDS_SQL: &str = "
SELECT DISTINCT dc.name, c.game_changer, c.oracle_text, c.faces
  FROM deck_cards dc
  JOIN deck_categories cat ON cat.id = dc.category_id
  LEFT JOIN cards c ON c.id = dc.card_id
 WHERE dc.deck_id = ?1 AND dc.variant = 'live' AND cat.is_active = 1
 ORDER BY dc.name, c.game_changer, c.oracle_text, c.faces";

/// The printings the combo matcher is asked about — **the same pile [`BRACKET_CARDS_SQL`]
/// reads**, deduped, which is `DeckBracket.tsx:117-121` in SQL.
///
/// The two have to be one pile: `estimateBracket`'s own doc says the combos handed to it are not
/// re-checked, so a caller that matched over a switched-off pile's cards gets back a combo the
/// deck does not really play and nothing downstream can tell.
const BRACKET_IDS_SQL: &str = "
SELECT DISTINCT dc.card_id
  FROM deck_cards dc
  JOIN deck_categories cat ON cat.id = dc.category_id
 WHERE dc.deck_id = ?1 AND dc.variant = 'live' AND cat.is_active = 1
 ORDER BY dc.card_id";

/// Everything the bracket estimate needs, for the decks the caller names.
///
/// **The caller passes the ids, and that is the boundary rather than a convenience.** Which
/// formats have a command zone is a `format_specs.commander_rule` question TypeScript already
/// answers (`useFormatSpecs`), so a `WHERE fs.commander_rule …` here would be this crate drawing
/// a conclusion — and it would have to draw it again, differently, the day a second format grew
/// brackets. The gallery asks about the decks it means to draw a bracket under.
///
/// **One entry per requested id, in request order**, [`crate::tags`]'s contract for its two
/// per-card reads and for its reason: the caller holds a list and wants a lookup, and a deck
/// that has been deleted since the list was taken answers empty lists rather than going missing
/// from a positional answer. An empty request answers an empty list without touching the
/// database.
///
/// **A deck listing more than [`crate::combos::MAX_CARD_IDS`] distinct printings fails the whole
/// read**, with [`crate::combos::TOO_MANY_CARDS`] — [`crate::combos::match_combos`]'s own
/// refusal, propagated rather than caught. That is `combos_for_cards`' behaviour unchanged, and
/// the alternative — a silently truncated id list — would answer a *wrong* combo set that reads
/// exactly like a right one. The bound is 1 000 distinct printings against a Commander deck's
/// hundred.
pub fn bracket_reads(conn: &Connection, deck_ids: &[i64]) -> Result<Vec<DeckBracketRead>, String> {
    if deck_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut cards_stmt = conn.prepare(BRACKET_CARDS_SQL).map_err(|e| e.to_string())?;
    let mut ids_stmt = conn.prepare(BRACKET_IDS_SQL).map_err(|e| e.to_string())?;

    let mut out = Vec::with_capacity(deck_ids.len());
    for &deck_id in deck_ids {
        let cards: Vec<BracketCardRow> = cards_stmt
            .query_map(params![deck_id], |r| {
                Ok(BracketCardRow {
                    name: r.get(0)?,
                    // `Option<bool>` and then `false`, for the reason on the field itself: the
                    // column is nullable and the LEFT JOIN can leave it absent besides.
                    game_changer: r.get::<_, Option<bool>>(1)?.unwrap_or(false),
                    oracle_text: r.get(2)?,
                    faces: r.get(3)?,
                    // A literal rather than `cat.is_active`, which the `WHERE` has already
                    // pinned to 1. See the field's own doc for why it is carried at all.
                    category_active: true,
                })
            })
            .and_then(|rows| rows.collect())
            .map_err(|e| e.to_string())?;

        let card_ids: Vec<String> = ids_stmt
            .query_map(params![deck_id], |r| r.get::<_, String>(0))
            .and_then(|rows| rows.collect())
            .map_err(|e| e.to_string())?;

        out.push(DeckBracketRead {
            deck_id,
            cards,
            combos: crate::combos::match_combos(conn, &card_ids)?,
        });
    }
    Ok(out)
}

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
/// `deck_ids` reaches the wire as `deckIds`, which `src/lib/ipc.ts` spells that way —
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

/// The tests of `deck` that name something this crate still holds. Each goes home when what it
/// names does.
#[cfg(test)]
mod tests {
    use super::*;
    use grimoire_core::deck::fixtures::*;

    /// **The five fields, each read off the column the estimator's own reader wants** — and the
    /// orphan is the reason `name` is `deck_cards.name`: its printing has left `cards`, so
    /// `c.name` would be NULL and this read would fail rather than answer a row the editor
    /// still draws. `game_changer` is `false` for the same row for the same reason: nothing is
    /// known about a card that is not there, and a NULL must not be counted in either direction.
    #[test]
    fn the_bracket_read_carries_the_five_fields_the_estimator_reads() {
        let conn = seeded();
        conn.execute_batch(
            r#"INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    rarity,mana_cost,cmc,type_line,oracle_text,faces,game_changer,raw)
               VALUES
                 ('rhystic','o3','Rhystic Study','pcy','45','en','normal','common','{2}{U}',3.0,
                  'Enchantment',
                  'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.',
                  NULL,1,'{}'),
                 ('valki','o4','Valki, God of Lies','khm','113','en','modal_dfc','mythic',
                  '{1}{B}',2.0,'Legendary Creature — God',NULL,
                  '[{"oracle_text":"When Valki enters the battlefield, each opponent reveals their hand."}]',
                  0,'{}'),
                 ('ghost','o5','Ghost Printing','lea','999','en','normal','common','{G}',1.0,
                  'Creature — Spirit','Boo.',NULL,1,'{}');"#,
        )
        .unwrap();
        let deck = create_deck(&conn, &input("Stax", "commander")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "rhystic", main, 1);
        add(&conn, deck.id, "valki", main, 1);
        add(&conn, deck.id, "ghost", main, 1);
        // The printing leaves the corpus the way a sync takes one: the deck row stays, with its
        // denormalized name and nothing else.
        conn.execute("DELETE FROM cards WHERE id = 'ghost'", [])
            .unwrap();

        let read = &bracket_reads(&conn, &[deck.id]).unwrap()[0];
        assert_eq!(read.deck_id, deck.id);
        let of = |name: &str| {
            read.cards
                .iter()
                .find(|c| c.name == name)
                .unwrap_or_else(|| panic!("no `{name}` in the bracket read"))
                .clone()
        };

        let rhystic = of("Rhystic Study");
        assert!(
            rhystic.game_changer,
            "the column says 1, so the field says true"
        );
        assert!(rhystic
            .oracle_text
            .as_deref()
            .is_some_and(|t| t.contains("unless that player pays")));
        assert_eq!(rhystic.faces, None);
        assert!(
            rhystic.category_active,
            "the pile is `is_active = 1` by construction"
        );

        let valki = of("Valki, God of Lies");
        assert_eq!(
            valki.oracle_text, None,
            "a modal card's text is on its faces"
        );
        assert!(
            valki
                .faces
                .as_deref()
                .is_some_and(|f| f.contains("reveals their hand")),
            "`faces` is carried as its raw JSON for the estimator's own parser"
        );
        assert!(!valki.game_changer);

        let ghost = of("Ghost Printing");
        assert_eq!(
            ghost.oracle_text, None,
            "an orphaned row knows nothing about itself"
        );
        assert_eq!(ghost.faces, None);
        assert!(
            !ghost.game_changer,
            "a NULL `game_changer` is `false`, never `true` and never a failure"
        );
    }

    /// **Every kind, and only the active ones** — deliberately *not* the colour bar's three
    /// kinds. A Commander deck has no sideboard, so cards a reader has filed in one are still
    /// inside the bracket; the switch is the only thing that takes a pile out, which is exactly
    /// what `DeckBracket.tsx` hands the estimator today. Two reads of one deck answering two
    /// different piles is the gallery and the editor disagreeing about the same deck.
    #[test]
    fn the_bracket_read_keeps_every_kind_and_drops_a_switched_off_one() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Stax", "commander")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");
        let scratch = kind_of(&conn, deck.id, "maybe");
        add(&conn, deck.id, "bolt-lea", main, 1);
        add(&conn, deck.id, "serra-lea", side, 1);
        add(&conn, deck.id, "serra-8ed", scratch, 1);
        // A plan is not a deck here either.
        add_card(
            &conn,
            deck.id,
            "bolt-m10",
            Some(plan_pile(&conn, deck.id, main)),
            None,
            THEORY,
            None,
            4,
        )
        .unwrap();

        let names = |conn: &Connection| {
            let mut n: Vec<String> = bracket_reads(conn, &[deck.id]).unwrap()[0]
                .cards
                .iter()
                .map(|c| c.name.clone())
                .collect();
            n.sort();
            n
        };
        assert_eq!(
            names(&conn),
            vec!["Lightning Bolt".to_owned(), "Serra Angel".to_owned()],
            "the sideboard counts and the seeded-off Maybeboard does not — and the two Serra \
             rows are one card to an estimator that dedupes by name"
        );

        crate::deck_meta::set_category_active(&conn, side, false).unwrap();
        assert_eq!(
            names(&conn),
            vec!["Lightning Bolt".to_owned()],
            "switched off, the sideboard's cards are out of the estimate"
        );
    }

    /// **A database that has never fetched Commander Spellbook's file estimates from three
    /// signals instead of four**, which the crate documents as a supported state rather than an
    /// error — so the empty list here is the answer and not a gap.
    #[test]
    fn the_bracket_read_answers_no_combos_when_the_feed_has_never_been_fetched() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Stax", "commander")).unwrap();
        add(&conn, deck.id, "bolt-lea", main_of(&conn, deck.id), 1);

        let read = &bracket_reads(&conn, &[deck.id]).unwrap()[0];
        assert!(
            read.combos.is_empty(),
            "no rows to match against is not a failure"
        );
        assert_eq!(
            read.cards.len(),
            1,
            "and the other three signals still arrive"
        );
    }

    /// **The fourth signal, and that it is read over the same pile the cards are.**
    /// `estimateBracket`'s own doc says the combos handed to it are not re-checked, so a match
    /// made over a switched-off pile's printings would put a combo on a tile for a deck that
    /// does not play it — with nothing downstream able to tell.
    #[test]
    fn the_bracket_read_matches_combos_over_the_same_active_pile() {
        let conn = seeded();
        conn.execute_batch(
            "INSERT INTO combos (id,bracket_tag,card_count,template_count,identity,produces,
                                 popularity)
             VALUES ('c-1','R',2,0,'WR','Infinite damage',77);
             INSERT INTO combo_cards (combo_id,oracle_id,name,quantity,must_be_commander)
             VALUES ('c-1','o1','Lightning Bolt',1,0),('c-1','o2','Serra Angel',1,0);",
        )
        .unwrap();
        let deck = create_deck(&conn, &input("Stax", "commander")).unwrap();
        let main = main_of(&conn, deck.id);
        let scratch = kind_of(&conn, deck.id, "maybe");
        add(&conn, deck.id, "bolt-lea", main, 1);
        add(&conn, deck.id, "serra-lea", scratch, 1);

        // The Maybeboard is seeded off, so the deck holds one of the combo's two cards.
        assert!(
            bracket_reads(&conn, &[deck.id]).unwrap()[0]
                .combos
                .is_empty(),
            "a combo the deck holds half of is not a combo the deck has"
        );

        crate::deck_meta::set_category_active(&conn, scratch, true).unwrap();
        let combos = &bracket_reads(&conn, &[deck.id]).unwrap()[0].combos;
        assert_eq!(combos.len(), 1, "both halves are in an active pile now");
        assert_eq!(combos[0].id, "c-1");
        assert_eq!(combos[0].bracket_tag, "R");
        assert_eq!(combos[0].template_count, 0);
    }

    /// **One entry per requested id, in request order**, `tags`' contract for its two per-card
    /// reads and for its reason: the caller holds a list of decks and wants a lookup, so a deck
    /// deleted since that list was taken answers empty lists rather than shifting every entry
    /// after it by one. An empty request answers an empty list.
    #[test]
    fn the_bracket_read_answers_one_entry_per_requested_deck_in_order() {
        let conn = seeded();
        let burn = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let angels = create_deck(&conn, &input("Angels", "modern")).unwrap();
        add(&conn, burn.id, "bolt-lea", main_of(&conn, burn.id), 4);
        add(&conn, angels.id, "serra-lea", main_of(&conn, angels.id), 2);
        let gone = angels.id + 1000;

        let out = bracket_reads(&conn, &[angels.id, gone, burn.id]).unwrap();
        assert_eq!(
            out.iter().map(|d| d.deck_id).collect::<Vec<_>>(),
            vec![angels.id, gone, burn.id],
            "the caller's order, not the table's"
        );
        assert_eq!(out[0].cards.len(), 1);
        assert!(
            out[1].cards.is_empty() && out[1].combos.is_empty(),
            "a deck that is not there is empty lists, not a missing entry and not an error"
        );
        assert_eq!(out[2].cards.len(), 1);

        assert!(
            bracket_reads(&conn, &[]).unwrap().is_empty(),
            "and nothing asked for is nothing answered"
        );
    }
}
