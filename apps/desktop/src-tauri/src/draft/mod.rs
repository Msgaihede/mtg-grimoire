//! **The Draft & Packs page's draft**: one draft at a time over phase.rs's draft module
//! (`grimoire_play::Draft`) — boosters the page made, passed round a table of bots, six straight
//! into a sealed pool, or a pod of people met in a lobby ([`lobby`]) — and the deck its pool
//! becomes ([`deck`]). This host's alone: `command_table`'s `DESKTOP_ONLY` says why, and
//! `docs/superpowers/specs/2026-10-29-draft-and-packs-design.md` §4–§6 has the design.
//!
//! **One draft at a time, held here** ([`DraftSlot`]), modelled on the playtest board's slot:
//! the page names each draft (`draft`, a fresh number per deal) and every call names the draft
//! it is for, so a page that has gone never touches the draft that replaced its own. A call
//! takes the draft out of the slot for its engine work and puts it back after; a second call
//! meanwhile is told the table is busy, a start or an end does not wait, and a call that comes
//! back to a slot an end or a newer start took drops what it took.
//!
//! **Every call that can let a bot pick runs on the engine's stack**
//! (`grimoire_play::on_engine_stack`, 16 MiB), on the blocking pool — never on the tokio worker a
//! command arrives on (`crates/grimoire-play/CLAUDE.md`).
//!
//! **A solo draft is kept** after every change in `app_meta` [`K_DRAFT_SESSION`] — its snapshot,
//! when it was taken and the summary *Draft in progress* draws — so it can be resumed after a
//! restart (`draft_saved`, `draft_resume`); `draft_end` drops it. **A pod is not kept**: its
//! guests' apps are not this app's to bring back.

pub mod deck;
pub mod lobby;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use grimoire_core::app_meta::{get_app_meta, set_app_meta};
use grimoire_play::{
    on_engine_stack, CardFacts, Draft, DraftCardFacts, DraftMode, DraftSaved, DraftSetup,
    DraftView,
};
use serde::{Deserialize, Serialize};

use crate::sync::AppState;

/// The `app_meta` row a solo draft is kept in: a [`SavedRow`] as JSON.
pub const K_DRAFT_SESSION: &str = "draft_session";

const NO_DRAFT: &str = "There is no draft at the table. Start one from the Draft & Packs page.";
const BUSY: &str = "The table is still picking.";
const REPLACED: &str = "This draft was put away: another one has been started since.";
const NOTHING_SAVED: &str = "There is no draft to resume.";
const POD_FROM_LOBBY: &str = "A pod draft is started from its lobby.";

/// The one draft, or none — shared with the lobby's task, which applies a guest's pick.
#[derive(Default, Clone)]
pub struct DraftSlot(pub(crate) Arc<Shared>);

#[derive(Default)]
pub(crate) struct Shared {
    held: Mutex<Inner>,
    /// Held across a save's check and write, and across an end and its clearing, so a save that
    /// finishes after its draft was ended never writes the row back.
    saving: Mutex<()>,
}

#[derive(Default)]
struct Inner {
    slot: Slot<Draft>,
    /// The name of the draft in the slot when it is a pod's, which is never kept.
    pod: Option<u64>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        crate::sync::lock_plain(&self.held)
    }
}

/// What the slot holds, each state but `Empty` with the page's name for its draft. Generic over
/// the draft so its moves are tested without dealing one.
#[derive(Default)]
enum Slot<G> {
    #[default]
    Empty,
    /// A start or a resume is reading the cards and dealing this draft.
    Dealing(u64),
    /// A call has this draft on the engine's stack.
    Busy(u64),
    Held(u64, Box<G>),
}

impl<G> Slot<G> {
    fn name(&self) -> Option<u64> {
        match self {
            Self::Empty => None,
            Self::Dealing(d) | Self::Busy(d) | Self::Held(d, _) => Some(*d),
        }
    }

    /// A start claims the slot at once: whatever was here is dropped.
    fn claim(&mut self, draft: u64) {
        *self = Self::Dealing(draft);
    }

    /// `draft` is dealt: it is the draft at the table, unless an end or a newer start took the
    /// slot meanwhile.
    fn dealt(&mut self, draft: u64, dealt: G) -> Result<(), String> {
        if !matches!(self, Self::Dealing(d) if *d == draft) {
            return Err(REPLACED.into());
        }
        *self = Self::Held(draft, Box::new(dealt));
        Ok(())
    }

    /// Take `draft` onto the engine's stack, leaving the slot `Busy` with its name.
    fn take(&mut self, draft: u64) -> Result<Box<G>, String> {
        match std::mem::take(self) {
            Self::Held(d, held) if d == draft => {
                *self = Self::Busy(draft);
                Ok(held)
            }
            other => {
                let refusal = match other.name() {
                    None => NO_DRAFT,
                    Some(d) if d != draft => REPLACED,
                    Some(_) => BUSY,
                };
                *self = other;
                Err(refusal.into())
            }
        }
    }

    /// The engine is done with `draft`: back in the slot, unless it was ended or replaced while
    /// it was out. `None` is a panic that took it with it. Answers whether it went back.
    fn put_back(&mut self, draft: u64, held: Option<Box<G>>) -> bool {
        if matches!(self, Self::Busy(d) if *d == draft) {
            let back = held.is_some();
            *self = held.map_or(Self::Empty, |held| Self::Held(draft, held));
            return back;
        }
        false
    }

    /// Put `draft` away, whatever it is doing; a newer draft is not this call's to end.
    fn end(&mut self, draft: u64) {
        if self.name() == Some(draft) {
            *self = Self::Empty;
        }
    }
}

/// What a solo draft's row holds.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRow {
    /// `Draft::snapshot`, as the text it answered.
    pub snapshot: String,
    /// Milliseconds.
    pub updated_at: i64,
    /// What *Draft in progress* draws, kept beside the snapshot so it is read without a restore.
    pub saved: DraftSaved,
}

/// What a change to a draft leaves for its caller to pass on: seat 0's view before and after,
/// every lobby peer's own view, and a solo draft's row to keep.
pub(crate) struct Outcome {
    pub before: Option<DraftView>,
    pub view: DraftView,
    /// `(peer, that seat's view)` for every seat a lobby peer sits in.
    pub guests: Vec<(String, DraftView)>,
    pub row: Option<SavedRow>,
}

impl Outcome {
    /// Read off `draft` after a change. `before` is seat 0's view from before it.
    fn of(draft: &Draft, before: Option<DraftView>) -> Outcome {
        let view = draft.view(0);
        let guests = draft
            .seats()
            .iter()
            .enumerate()
            .filter_map(|(seat, setup)| {
                let peer = setup.peer.clone()?;
                let seat = u8::try_from(seat).ok()?;
                (seat != 0 && !setup.bot).then(|| (peer, draft.view(seat)))
            })
            .collect();
        let row = (draft.mode() != DraftMode::Pod).then(|| {
            let updated_at = grimoire_core::platform::clock::now_ms();
            SavedRow {
                snapshot: draft.snapshot(),
                updated_at,
                saved: draft.saved(updated_at),
            }
        });
        Outcome {
            before,
            view,
            guests,
            row,
        }
    }

    /// Whether seat 0's view moved.
    pub fn moved(&self) -> bool {
        self.before.as_ref() != Some(&self.view)
    }
}

/// Run `work` on `draft` on the engine's stack, and put the draft back. Refused at once with
/// [`BUSY`] while another call has it.
pub(crate) async fn on_draft<T: Send + 'static>(
    shared: &Arc<Shared>,
    draft: u64,
    work: impl FnOnce(&mut Draft) -> T + Send + 'static,
) -> Result<T, String> {
    let mut held = shared.lock().slot.take(draft)?;
    let answer = tauri::async_runtime::spawn_blocking(move || {
        on_engine_stack(move || {
            let out = work(&mut held);
            (held, out)
        })
    })
    .await
    .map_err(|e| e.to_string());
    let mut inner = shared.lock();
    match answer {
        Ok(Ok((held, out))) => {
            if inner.slot.put_back(draft, Some(held)) {
                Ok(out)
            } else {
                Err(REPLACED.into())
            }
        }
        // The engine panicked, and took the draft with it.
        Ok(Err(e)) | Err(e) => {
            inner.slot.put_back(draft, None);
            if inner.slot.name().is_none() {
                inner.pod = None;
            }
            Err(e)
        }
    }
}

/// [`on_draft`] for a call no reader is waiting on — a guest's pick off the lobby's socket —
/// which waits its turn while another call has the draft, rather than be refused.
pub(crate) async fn on_draft_waiting<T: Send + 'static>(
    shared: &Arc<Shared>,
    draft: u64,
    work: impl FnOnce(&mut Draft) -> T + Send + 'static,
) -> Result<T, String> {
    const WAIT: Duration = Duration::from_millis(25);
    const TRIES: u32 = 30_000 / 25;
    for _ in 0..TRIES {
        let busy = matches!(&shared.lock().slot, Slot::Busy(d) if *d == draft);
        if !busy {
            break;
        }
        tokio::time::sleep(WAIT).await;
    }
    on_draft(shared, draft, work).await
}

/// One change to `draft` — `change` given the draft — read as an [`Outcome`], and a solo draft
/// kept. A refused change is the refusal, the draft as it was.
pub(crate) async fn change(
    app: &Arc<AppState>,
    shared: &Arc<Shared>,
    draft: u64,
    waiting: bool,
    change: impl FnOnce(&mut Draft) -> Result<(), String> + Send + 'static,
) -> Result<Outcome, String> {
    let work = move |d: &mut Draft| {
        let before = d.view(0);
        change(d).map(|()| Outcome::of(d, Some(before)))
    };
    let outcome = if waiting {
        on_draft_waiting(shared, draft, work).await??
    } else {
        on_draft(shared, draft, work).await??
    };
    keep(app, shared, draft, outcome.row.clone()).await;
    Ok(outcome)
}

/// Write a solo draft's row, if `draft` is still the one at the table. A row that cannot be
/// written is not a failed pick: the next change writes it again.
async fn keep(app: &Arc<AppState>, shared: &Arc<Shared>, draft: u64, row: Option<SavedRow>) {
    let Some(row) = row else {
        return;
    };
    let (app, shared) = (app.clone(), shared.clone());
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let _saving = crate::sync::lock_plain(&shared.saving);
        if shared.lock().slot.name() != Some(draft) {
            return;
        }
        let Ok(json) = serde_json::to_string(&row) else {
            return;
        };
        if let Err(e) = crate::sync::with_write(&app, |conn| {
            set_app_meta(conn, K_DRAFT_SESSION, &json).map_err(|e| e.to_string())
        }) {
            eprintln!("the draft could not be kept: {e}");
        }
    })
    .await;
}

/// Read the facts of every printing in `ids` a draft needs: the deck row's facts, and the
/// printing's set, number and rarity, which the view shows and the `Easy` bots pick by.
fn draft_facts(conn: &rusqlite::Connection, ids: &[String]) -> Result<Vec<DraftCardFacts>, String> {
    let cards = grimoire_core::play::cards_by_ids(conn, ids)?;
    let mut printing = conn
        .prepare_cached("SELECT set_code, collector_number, rarity FROM cards WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    let mut of: HashMap<String, (String, String, String)> = HashMap::new();
    for card in &cards {
        let row = printing
            .query_row([&card.card_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ))
            })
            .map_err(|e| e.to_string())?;
        of.insert(card.card_id.clone(), row);
    }
    Ok(cards
        .into_iter()
        .map(|card| {
            let (set_code, collector_number, rarity) =
                of.remove(&card.card_id).unwrap_or_default();
            DraftCardFacts {
                card: crate::playtest::facts(card),
                set_code,
                collector_number,
                rarity,
            }
        })
        .collect())
}

/// Deal `setup` as the draft named `draft`, replacing whatever was at the table: the cards read,
/// the draft dealt on the engine's stack, a solo draft kept. `lobby_start`'s too, for a pod.
pub(crate) async fn deal(
    app: &Arc<AppState>,
    shared: &Arc<Shared>,
    setup: DraftSetup,
    draft: u64,
) -> Result<Outcome, String> {
    {
        let mut inner = shared.lock();
        inner.slot.claim(draft);
        inner.pod = (setup.mode == DraftMode::Pod).then_some(draft);
    }
    let dealt = deal_off_the_slot(app, setup).await;
    let outcome = {
        let mut inner = shared.lock();
        match dealt {
            Ok((dealt, outcome)) => inner.slot.dealt(draft, dealt).map(|()| outcome),
            Err(e) => {
                inner.slot.end(draft);
                Err(e)
            }
        }
    };
    if outcome.is_err() && shared.lock().slot.name().is_none() {
        shared.lock().pod = None;
    }
    let outcome = outcome?;
    keep(app, shared, draft, outcome.row.clone()).await;
    Ok(outcome)
}

async fn deal_off_the_slot(
    app: &Arc<AppState>,
    setup: DraftSetup,
) -> Result<(Draft, Outcome), String> {
    let ids = setup.card_ids();
    let reader = app.clone();
    let facts = tauri::async_runtime::spawn_blocking(move || {
        draft_facts(&crate::sync::lock_db_read(&reader), &ids)
    })
    .await
    .map_err(|e| format!("The boosters' cards could not be read: {e}"))??;
    tauri::async_runtime::spawn_blocking(move || {
        on_engine_stack(move || {
            Draft::new(setup, facts).map(|draft| {
                let outcome = Outcome::of(&draft, None);
                (draft, outcome)
            })
        })
    })
    .await
    .map_err(|e| e.to_string())??
}

/// Deal a new draft — quick, sealed or cube; a pod is dealt by `lobby_start` — and answer seat
/// 0's view. `draft` is the page's name for it, which every later call carries; the draft it
/// replaces is gone at once.
#[tauri::command]
pub async fn draft_start(
    state: tauri::State<'_, Arc<AppState>>,
    slot: tauri::State<'_, DraftSlot>,
    setup: DraftSetup,
    draft: u64,
) -> Result<DraftView, String> {
    if setup.mode == DraftMode::Pod {
        return Err(POD_FROM_LOBBY.into());
    }
    deal(state.inner(), &slot.0, setup, draft)
        .await
        .map(|o| o.view)
}

/// Seat 0's view of `draft`, or `None` when it is not the draft at the table.
#[tauri::command(async)]
pub fn draft_view(slot: tauri::State<'_, DraftSlot>, draft: u64) -> Result<Option<DraftView>, String> {
    match &slot.0.lock().slot {
        Slot::Held(d, held) if *d == draft => Ok(Some(held.view(0))),
        Slot::Busy(d) | Slot::Dealing(d) if *d == draft => Err(BUSY.into()),
        _ => Ok(None),
    }
}

/// This reader picks `card_instance_ids` (one card) from their pack; then the bots pick. In a
/// pod, every guest is sent their own view. A refused pick changes nothing.
#[tauri::command]
pub async fn draft_pick(
    state: tauri::State<'_, Arc<AppState>>,
    slot: tauri::State<'_, DraftSlot>,
    lobby: tauri::State<'_, lobby::LobbySlot>,
    draft: u64,
    card_instance_ids: Vec<String>,
) -> Result<DraftView, String> {
    let outcome = change(state.inner(), &slot.0, draft, false, move |d| {
        d.pick(0, card_instance_ids)
    })
    .await?;
    lobby::send_views(&lobby, &outcome.guests);
    Ok(outcome.view)
}

/// "Pick for me": the bots' choice for this reader, at the draft's difficulty.
#[tauri::command]
pub async fn draft_auto_pick(
    state: tauri::State<'_, Arc<AppState>>,
    slot: tauri::State<'_, DraftSlot>,
    lobby: tauri::State<'_, lobby::LobbySlot>,
    draft: u64,
) -> Result<DraftView, String> {
    let outcome = change(state.inner(), &slot.0, draft, false, |d| d.auto_pick(0)).await?;
    lobby::send_views(&lobby, &outcome.guests);
    Ok(outcome.view)
}

/// Put `draft` away, and its kept copy — at once, even while a call has it on the engine. A
/// newer draft at the table is not this call's to end, and neither is its kept copy; with no
/// draft at the table the kept copy goes (*Draft in progress*'s discard after a restart).
#[tauri::command]
pub async fn draft_end(
    state: tauri::State<'_, Arc<AppState>>,
    slot: tauri::State<'_, DraftSlot>,
    draft: u64,
) -> Result<(), String> {
    let (app, shared) = (state.inner().clone(), slot.0.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let _saving = crate::sync::lock_plain(&shared.saving);
        let clear = {
            let mut inner = shared.lock();
            let clear = match inner.slot.name() {
                None => true,
                Some(d) if d == draft => inner.pod != Some(draft),
                Some(_) => false,
            };
            inner.slot.end(draft);
            if inner.slot.name().is_none() {
                inner.pod = None;
            }
            clear
        };
        if clear {
            crate::sync::with_write(&app, |conn| {
                conn.execute("DELETE FROM app_meta WHERE key = ?1", [K_DRAFT_SESSION])
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The kept row, read; `None` for none or one that does not parse.
fn saved_row(conn: &rusqlite::Connection) -> Option<SavedRow> {
    get_app_meta(conn, K_DRAFT_SESSION).and_then(|json| serde_json::from_str(&json).ok())
}

/// The solo draft left off, for *Draft in progress*.
#[tauri::command(async)]
pub fn draft_saved(state: tauri::State<'_, Arc<AppState>>) -> Option<DraftSaved> {
    saved_row(&crate::sync::lock_db_read(state.inner())).map(|row| row.saved)
}

/// Take the kept draft back up under the name `draft`, replacing whatever was at the table.
#[tauri::command]
pub async fn draft_resume(
    state: tauri::State<'_, Arc<AppState>>,
    slot: tauri::State<'_, DraftSlot>,
    draft: u64,
) -> Result<DraftView, String> {
    let shared = slot.0.clone();
    {
        let mut inner = shared.lock();
        inner.slot.claim(draft);
        inner.pod = None;
    }
    let app = state.inner().clone();
    let restored = async move {
        let (snapshot, facts) = tauri::async_runtime::spawn_blocking(move || {
            let conn = crate::sync::lock_db_read(&app);
            let row = saved_row(&conn).ok_or(NOTHING_SAVED)?;
            let ids = Draft::card_ids(&row.snapshot)?;
            let facts: Vec<CardFacts> = grimoire_core::play::cards_by_ids(&conn, &ids)?
                .into_iter()
                .map(crate::playtest::facts)
                .collect();
            Ok::<_, String>((row.snapshot, facts))
        })
        .await
        .map_err(|e| e.to_string())??;
        tauri::async_runtime::spawn_blocking(move || {
            on_engine_stack(move || {
                Draft::restore(&snapshot, facts).map(|d| {
                    let view = d.view(0);
                    (d, view)
                })
            })
        })
        .await
        .map_err(|e| e.to_string())??
    }
    .await;
    let mut inner = shared.lock();
    match restored {
        Ok((restored, view)) => inner.slot.dealt(draft, restored).map(|()| view),
        Err(e) => {
            inner.slot.end(draft);
            Err(e)
        }
    }
}

/// End the pod draft `draft`, when it is the one at the table — a host leaving its lobby.
pub(crate) fn end_pod(shared: &Shared, draft: u64) {
    let mut inner = shared.lock();
    if inner.pod == Some(draft) {
        inner.slot.end(draft);
        inner.pod = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn holding(draft: u64) -> Slot<&'static str> {
        let mut slot = Slot::default();
        slot.claim(draft);
        slot.dealt(draft, "dealt").unwrap();
        slot
    }

    fn held(slot: &Slot<&'static str>) -> Option<(u64, &'static str)> {
        match slot {
            Slot::Held(d, held) => Some((*d, **held)),
            _ => None,
        }
    }

    #[test]
    fn a_call_puts_its_draft_back_and_names_a_second_call_busy() {
        let mut slot = holding(1);
        let taken = slot.take(1).unwrap();
        assert_eq!(slot.take(1).unwrap_err(), BUSY);
        assert!(slot.put_back(1, Some(taken)));
        assert_eq!(held(&slot), Some((1, "dealt")));
    }

    #[test]
    fn a_call_that_returns_after_a_newer_start_does_not_put_its_draft_back() {
        let mut slot = holding(1);
        let taken = slot.take(1).unwrap();
        slot.claim(2);
        slot.dealt(2, "newer").unwrap();
        assert!(!slot.put_back(1, Some(taken)));
        assert_eq!(held(&slot), Some((2, "newer")));
    }

    #[test]
    fn ending_a_draft_while_a_call_has_it_drops_it_when_the_call_returns() {
        let mut slot = holding(1);
        let taken = slot.take(1).unwrap();
        slot.end(1);
        assert!(!slot.put_back(1, Some(taken)));
        assert!(matches!(slot, Slot::Empty));
    }

    #[test]
    fn an_old_page_neither_ends_nor_picks_in_the_draft_that_replaced_its_own() {
        let mut slot = holding(1);
        slot.claim(2);
        slot.dealt(2, "newer").unwrap();
        slot.end(1);
        assert_eq!(slot.take(1).unwrap_err(), REPLACED);
        assert_eq!(held(&slot), Some((2, "newer")));
        let mut empty: Slot<&str> = Slot::default();
        assert_eq!(empty.take(1).unwrap_err(), NO_DRAFT);
    }

    #[test]
    fn a_deal_overtaken_by_an_end_or_a_newer_start_is_dropped() {
        let mut slot = Slot::default();
        slot.claim(1);
        slot.end(1);
        assert_eq!(slot.dealt(1, "late").unwrap_err(), REPLACED);
        slot.claim(1);
        slot.claim(2);
        slot.dealt(2, "newer").unwrap();
        assert_eq!(slot.dealt(1, "late").unwrap_err(), REPLACED);
        assert_eq!(held(&slot), Some((2, "newer")));
    }

    #[test]
    fn a_panic_empties_the_slot_only_if_its_draft_is_still_there() {
        let mut slot = holding(1);
        slot.take(1).unwrap();
        assert!(!slot.put_back(1, None));
        assert!(matches!(slot, Slot::Empty));
    }

    #[test]
    fn a_kept_row_is_its_snapshot_its_stamp_and_its_summary() {
        let row = SavedRow {
            snapshot: "{\"version\":1}".into(),
            updated_at: 1_700_000_000_000,
            saved: DraftSaved {
                label: "Bloomburrow".into(),
                mode: DraftMode::Quick,
                status: grimoire_play::DraftStatus::Drafting,
                pack_number: 1,
                pack_count: 3,
                pick_number: 4,
                updated_at: 1_700_000_000_000,
            },
        };
        let json = serde_json::to_value(&row).unwrap();
        assert_eq!(json["snapshot"], "{\"version\":1}");
        assert_eq!(json["updatedAt"], 1_700_000_000_000_i64);
        assert_eq!(json["saved"]["packNumber"], 1);
        let back: SavedRow = serde_json::from_value(json).unwrap();
        assert_eq!(back.saved, row.saved);
    }
}
