//! **The desktop's half of `card`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::card::*;

use crate::sorting::Marketplace;
use crate::sync::{lock_db_read, AppState};
use std::sync::Arc;

/// One printing in full, priced at `marketplace`. Read-only connection, blocking pool — see
/// [`crate::search::search_cards`].
///
/// The marketplace is resolved by [`Marketplace::from_opt`], which is the crate's one rule and
/// never fails: absent, null, a typo, a future id and `cardtrader` all mean TCGplayer, because a
/// card the reader asked to see must not refuse to open over a setting.
#[tauri::command]
pub async fn card_detail(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    marketplace: Option<String>,
) -> Result<Option<CardDetail>, String> {
    let state = state.inner().clone();
    let market = Marketplace::from_opt(marketplace.as_deref());
    tauri::async_runtime::spawn_blocking(move || get_card(&lock_db_read(&state), &id, market))
        .await
        .map_err(|e| format!("card could not be read: {e}"))?
}

/// [`read_printing_prices`] as a command. Read-only connection, blocking pool, and the marketplace
/// resolved by [`Marketplace::from_opt`] like [`card_detail`]'s — a price read never refuses
/// over a setting.
#[tauri::command]
pub async fn printing_prices(
    state: tauri::State<'_, Arc<AppState>>,
    card_ids: Vec<String>,
    marketplace: Option<String>,
) -> Result<Vec<PrintingPrices>, String> {
    let state = state.inner().clone();
    let market = Marketplace::from_opt(marketplace.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        read_printing_prices(&lock_db_read(&state), &card_ids, market)
    })
    .await
    .map_err(|e| format!("prices could not be read: {e}"))?
}

/// Every paper printing of one oracle card, priced at `marketplace`. Read-only connection,
/// blocking pool.
///
/// **`limit` is the page size, and absent is the card pane's [`MAX_PRINTINGS`].** The pane
/// reads a list it cannot narrow and captions what it dropped, so 400 has always been enough
/// for it; the printings modal asks for [`MAX_PRINTINGS_HARD`] because it filters client-side,
/// and a filter over a truncated list draws an empty wall that reads as an answer. Whatever a
/// caller sends is clamped by [`page_size`], so the number is a request rather than a promise.
#[tauri::command]
pub async fn card_printings(
    state: tauri::State<'_, Arc<AppState>>,
    oracle_id: String,
    marketplace: Option<String>,
    limit: Option<i64>,
) -> Result<PrintingsResponse, String> {
    let state = state.inner().clone();
    let market = Marketplace::from_opt(marketplace.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        list_printings(&lock_db_read(&state), &oracle_id, market, limit)
    })
    .await
    .map_err(|e| format!("printings could not be read: {e}"))?
}

/// The Scryfall CDN URL for one printing at one size, or `None`.
///
/// **A command rather than a field on five list DTOs.** These URLs are ~100 bytes each and
/// are wanted on a deliberate user act — one menu press — so putting them on `CardSummary`,
/// `DeckCard`, `CollectionRow`, `WishRow` and `Printing` would pay for them on every row of
/// every list to serve a press that mostly never happens.
///
/// **Face 0's image, with the top-level blob as the fallback — spec §5's rule, exactly as
/// [`crate::images::resolve`] applies it.** A menu points at a *printing*, and a printing's
/// picture is its front face. This is not a refinement: **3.7% of printings carry no
/// top-level `image_uris` at all** — `transform`, `modal_dfc`, `double_faced_token`,
/// `art_series` and `reversible_card` put them on the faces instead (`images.rs`'s header) —
/// so a lookup that reads only the column answers `None` for ~4 300 live printings.
///
/// Three ways to `None`, and all three are answers rather than faults: the card is unknown,
/// it carries no images anywhere (neither column holds the variant), or the variant is JSON
/// `null` — which `card_row::webp_uris` writes for a variant the source lacked, so a present
/// key is not a present URL.
///
/// **A face-only printing was a fourth way, and it *was* a fault** — the version of this list
/// that ended at "all three are answers" is what kept it invisible for a release, because it
/// argued the absence was always benign and there was nothing left to check. Right-clicking
/// any Innistrad transform card copied nothing, silently, since `copyCardImage` treats a
/// missing URI as "nothing to do". If a fifth `None` ever appears here, say which kind it is.
///
/// The variant is checked against [`crate::schema::IMAGE_VARIANTS`] and **never
/// interpolated**: it reaches SQL as a `json_extract` path, so an unchecked one is an
/// injection point. There are four; `png` is not among them, because the ingest keeps four
/// of Scryfall's eleven image keys and drops the legacy JPG/PNG family its own docs mark as
/// replaced.
///
/// Read-only connection, blocking pool — as [`card_detail`] is, and for the same reason.
#[tauri::command]
pub async fn card_image_uri(
    state: tauri::State<'_, Arc<AppState>>,
    card_id: String,
    variant: String,
) -> Result<Option<String>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        card_image_uri_inner(&lock_db_read(&state), &card_id, &variant)
    })
    .await
    .map_err(|e| format!("the image URL could not be read: {e}"))?
}

/// The meld relationships of one printing. Read-only connection, blocking pool — as
/// [`card_detail`] is, and for the same reason.
///
/// Takes no `marketplace`: this answers who a card melds with, not what anything costs.
#[tauri::command]
pub async fn card_meld_parts(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<Vec<MeldRelation>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || meld_parts(&lock_db_read(&state), &id))
        .await
        .map_err(|e| format!("meld parts could not be read: {e}"))?
}

/// The TCGplayer product ids of one printing. Read-only connection, blocking pool — as
/// [`card_meld_parts`] is, and for the same reason.
///
/// Takes no `marketplace`: this answers what TCGplayer's catalogue calls this printing, not
/// what anything costs. The ids are the same whichever marketplace the reader has chosen, which
/// is also why nothing about them belongs in [`FinishPrices`].
#[tauri::command]
pub async fn card_tcgplayer_ids(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<TcgplayerIds, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || tcgplayer_ids(&lock_db_read(&state), &id))
        .await
        .map_err(|e| format!("the TCGplayer product ids could not be read: {e}"))?
}

/// What the reader holds of one oracle card. Read-only connection, blocking pool — as
/// [`card_detail`] is, and for the same reason.
///
/// **One command for three figures the pane draws in one block.** It replaces
/// `collection_list`, `wishlist_list` and `deck_ids_playing` fired together on every card open
/// — three reads that each answered a page of rows to have their `quantity` column summed in
/// the webview. Takes no `marketplace`: these are counts, and nothing about them moves when the
/// setting does.
#[tauri::command]
pub async fn card_holdings(
    state: tauri::State<'_, Arc<AppState>>,
    oracle_id: String,
) -> Result<CardHoldings, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || holdings(&lock_db_read(&state), &oracle_id))
        .await
        .map_err(|e| format!("what you hold of this card could not be read: {e}"))?
}

/// How the card pane groups its printings, as a raw stored mode.
///
/// A `String` and not a narrowed value, for [`stored_group_by`]'s reason: the row may have been
/// written by a build that offered a mode this one has never heard of, and narrowing it is the
/// frontend's job (`isPrintingGroupBy`, `packages/ui/features/card/printings.ts`) on the other side of
/// a wire that carries strings anyway.
///
/// Read-only connection on the blocking pool, exactly as [`card_printings`] runs — the two are
/// read together when the pane opens, and a preference that queued behind an ~80 s ingest on
/// the write connection would hold the whole pane behind it. The `Result` is `spawn_blocking`'s
/// join and nothing else; the read itself has no failure mode left, because every way it could
/// go wrong is already a reason to answer the default.
#[tauri::command]
pub async fn printing_group_by(state: tauri::State<'_, Arc<AppState>>) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || stored_group_by(&lock_db_read(&state)))
        .await
        .map_err(|e| format!("the printing grouping could not be read: {e}"))
}

/// Choose how the pane groups printings. Rejects a mode this build does not know, and answers
/// [`crate::db::BUSY`] if a sync holds the write connection — the bound every write
/// command in this crate takes.
///
/// **The lock comes first and the mode is checked inside it**, which is
/// [`crate::marketplace::set_marketplace`]'s order and not an accident: a bad mode sent while a
/// sync holds the connection answers BUSY, because nothing has looked at the mode yet. Getting
/// that backwards would mean the same call answered two different sentences depending on
/// whether an ingest happened to be running.
#[tauri::command]
pub async fn set_printing_group_by(
    state: tauri::State<'_, Arc<AppState>>,
    mode: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store_group_by(conn, &mode))
    })
    .await
    .map_err(|e| format!("the printing grouping could not be saved: {e}"))?
}
