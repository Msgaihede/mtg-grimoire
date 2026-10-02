//! **Commander Spellbook's combos are `grimoire-core`'s, re-exported here beside their
//! commands.**
//!
//! The feed, the ingest, both match queries and the refresh are in
//! `crates/grimoire-core/src/combos.rs` since the extraction's I/O step; a path through this
//! module reaches that crate's item unless this file defines it. What it defines is the five
//! `#[tauri::command]` wrappers, each of which names this app's state and a thread to run on.
//!
//! A refresh takes no window: it says what it is doing through the state's event sink, which
//! this app forwards to every window.

pub use grimoire_core::combos::*;

use crate::sync::AppState;
use std::sync::Arc;

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// What this app knows about combos: how many, over how many cards, from which build of the
/// file, and how old.
///
/// **Safe before the first refresh has ever run** — a database with no `combo_meta` row answers
/// two zeros, three nulls and `stale: true` rather than rejecting, so no caller needs a guard.
///
/// `async`, and answered on the blocking pool, because a sync command body runs inline on the
/// IPC thread and this takes `db_read`'s mutex.
#[tauri::command]
pub async fn combos_status(state: tauri::State<'_, Arc<AppState>>) -> Result<ComboStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || status_of(&state))
        .await
        .map_err(|e| format!("could not read the combo status: {e}"))
}

/// Download Commander Spellbook's combo file if it has changed and rebuild the combo tables
/// from it.
///
/// `force` skips the weekly throttle, not the ETag check. Long-running by nature (27.5 MB), so
/// it reports itself through [`PROGRESS_EVENT`]. A failure leaves the previous combos in place,
/// and the reason is in the error log.
#[tauri::command]
pub async fn combos_refresh(
    state: tauri::State<'_, Arc<AppState>>,
    force: bool,
) -> Result<ComboStatus, String> {
    let state = state.inner().clone();
    refresh(&state.core, force, &mut |phase, done, total| {
        emit(&state, phase, done, total)
    })
    .await
}

/// Throw away every stored combo and the watermark with it.
///
/// **A debugging affordance rather than something the ordinary reader needs.** Nothing about a
/// bracket estimate is improved by an empty combo table; what this is for is proving the ingest
/// still works end to end from a cold database, which is otherwise reachable only by deleting
/// `corpus.db` and paying for a whole resync to test one feed. **The caller is expected to
/// follow it with a forced [`combos_refresh`]** — and that refresh really downloads, because
/// [`clear_combos`] takes the rows out from under the stored ETag and the core's
/// `conditional_etag` therefore replays nothing.
///
/// It answers the post-clear [`ComboStatus`], which is [`status_of`]'s never-ingested answer:
/// two zeros, three nulls and `stale: true`. Answering the status rather than nothing means the
/// page that pressed this has no second round trip to make to find out what it did.
///
/// `async`, and answered on the blocking pool, for [`combos_status`]'s reason: a sync command
/// body runs inline on the IPC thread, and this one takes the write lock. The body itself is
/// [`clear`].
///
/// **A lock it could not have is reported rather than swallowed**, which is the difference
/// between this and the core's `mark_checked`. That one is a best-effort watermark nobody is waiting on;
/// this is a press somebody is watching, and a clear that quietly did nothing would read as a
/// database that refuses to empty.
#[tauri::command]
pub async fn combos_clear(state: tauri::State<'_, Arc<AppState>>) -> Result<ComboStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(conn) = crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) else {
            return Err(crate::db::BUSY.to_owned());
        };
        clear(&conn)
    })
    .await
    .map_err(|e| format!("could not clear the combos: {e}"))?
}

/// Every combo the given printings can make between them.
///
/// One round trip for a whole deck, and the ids are `cards.id` — a printing id, which is what
/// every deck row, drag source and resolved import line already holds. At most
/// [`MAX_CARD_IDS`] of them; see [`match_combos`] for why the list length is a real bound.
///
/// `async`, and answered on the blocking pool, for [`combos_status`]'s reason.
#[tauri::command]
pub async fn combos_for_cards(
    state: tauri::State<'_, Arc<AppState>>,
    card_ids: Vec<String>,
) -> Result<Vec<DeckCombo>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&state);
        match_combos(&conn, &card_ids)
    })
    .await
    .map_err(|e| format!("could not look for combos: {e}"))?
}

/// Every combo that names one card, a page at a time.
///
/// **The card is named by `oracle_id` and not by a printing id**, which is the one place this
/// command's wire shape differs from [`combos_for_cards`]' and is not an oversight: a combo is
/// a fact about a *card*, `combo_cards` is keyed on the oracle id, and asking about a printing
/// would mean resolving it to its oracle card first only to answer identically for all of them.
/// Every surface that opens this panel is looking at a card rather than at a deck row.
///
/// `search` is a case-insensitive substring over **any** piece's name, the asked-about card's
/// own included; `card_count` is an exact size — `Some(2)` is *two-card combos*, `None` is every
/// size — and `owned_only` narrows to the combos the reader owns every piece of. `limit` is
/// clamped to [`MAX_PAGE`] and `offset` to zero; neither is refused, because both are a page's
/// own numbers rather than a reader's.
///
/// **`search` is `Option<String>` for `card_count`'s reason and answers to the same three
/// spellings of nothing.** An absent key, a `null` and a box the reader cleared are one state
/// and [`card_combos`] flattens them into it; what the three of them mean — *no search*, an
/// answer identical to the one this command gave before the box existed — is that function's
/// contract and not this wrapper's.
///
/// `async`, and answered on the blocking pool, for [`combos_status`]'s reason: a sync command
/// body runs inline on the IPC thread and this one takes `db_read`'s mutex. The body is
/// [`card_combos`].
#[tauri::command]
pub async fn combos_for_card(
    state: tauri::State<'_, Arc<AppState>>,
    oracle_id: String,
    search: Option<String>,
    card_count: Option<i64>,
    owned_only: bool,
    limit: i64,
    offset: i64,
) -> Result<CardCombosPage, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&state);
        card_combos(
            &conn,
            &oracle_id,
            search.as_deref(),
            card_count,
            owned_only,
            limit,
            offset,
        )
    })
    .await
    .map_err(|e| format!("could not look for this card's combos: {e}"))?
}
