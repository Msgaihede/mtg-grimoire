//! What the integration owes the disk, and the thread that pays it.
//!
//! [`Tabletop`] is an observer on the write connection's hook — the fourth, after the mirror's —
//! and is the text mirror's `Mask` cut down to the one surface this integration has: decks. It
//! hears a row of any table a save is made of ([`touches`]) and a corpus swap (a re-scanned
//! picture moves a URL), and marks itself dirty with one atomic store. The thread waits for two
//! quiet seconds, the mirror's `DEBOUNCE`, and runs a pass.

use crate::mirror::run::PassReport;
use crate::mirror::watch::{LastPass, DEBOUNCE, TICK};
use crate::sync::AppState;
use grimoire_core::hooks::WriteObserver;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The tables a Tabletop Simulator save is made of. Everything else — `cards` and the price
/// tables above all, which a sync rewrites by the hundred thousand rows — marks nothing, and a
/// swap arrives once through [`WriteObserver::corpus_replaced`] instead.
pub fn touches(table: &str) -> bool {
    matches!(
        table,
        "decks"
            | "deck_cards"
            | "deck_categories"
            | "deck_folders"
            | "deck_tokens"
            | "deck_token_printings"
    )
}

/// The integration's half of [`AppState`]: whether a pass is owed, what the last one did, and
/// where the reader's Documents folder is.
#[derive(Debug, Default)]
pub struct Tabletop {
    dirty: AtomicBool,
    marks: AtomicU64,
    /// What the last pass did, for the Settings panel — in memory, the mirror's reason.
    pub last: Mutex<LastPass>,
    /// The OS's Documents folder, resolved once at launch where an `AppHandle` is in reach. `None`
    /// where it could not be, which leaves the reader to choose the saves folder by hand.
    pub documents: Option<PathBuf>,
}

impl Tabletop {
    pub fn new(documents: Option<PathBuf>) -> Self {
        Self {
            documents,
            ..Self::default()
        }
    }

    /// A pass is owed.
    pub fn mark(&self) {
        self.dirty.store(true, Ordering::Relaxed);
        self.marks.fetch_add(1, Ordering::Relaxed);
    }

    /// Take whether a pass is owed, clearing it in the same atomic swap — the mirror's `take`.
    pub fn take(&self) -> bool {
        self.dirty.swap(false, Ordering::Relaxed)
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty.load(Ordering::Relaxed)
    }

    pub fn marks(&self) -> u64 {
        self.marks.load(Ordering::Relaxed)
    }
}

impl WriteObserver for Tabletop {
    fn row(&self, _db: &str, table: &str) {
        if touches(table) {
            self.mark();
        }
    }

    fn corpus_replaced(&self) {
        self.mark();
    }
}

/// Record a finished pass for `tabletop_status`.
pub fn record(state: &AppState, outcome: &Result<PassReport, String>) {
    let mut last = crate::sync::lock_plain(&state.tabletop.last);
    last.last_run_at = Some(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs())
            .to_string(),
    );
    match outcome {
        Ok(report) => {
            last.last_report = Some(report.clone());
            last.last_error = None;
        }
        Err(e) => last.last_error = Some(e.clone()),
    }
}

/// Start the thread. Detached and never fatal, `mirror::watch::spawn`'s rule.
pub fn spawn(state: Arc<AppState>) {
    if let Err(e) = std::thread::Builder::new()
        .name("tabletop".to_owned())
        .spawn(move || watch(&state))
    {
        eprintln!("the Tabletop Simulator integration did not start: {e}");
    }
}

/// The longest wait between retries after failed passes — a missing saves folder is retried about
/// once a minute, not four times a second.
const MAX_BACKOFF: Duration = Duration::from_secs(60);

fn backoff_for(failures: u32) -> Duration {
    if failures == 0 {
        return Duration::ZERO;
    }
    let steps = 1u32 << failures.saturating_sub(1).min(16);
    DEBOUNCE.saturating_mul(steps).min(MAX_BACKOFF)
}

/// One pass, recorded. Answers the new consecutive-failure count. A panic is caught and becomes
/// an ordinary failure, the mirror's reason: uncaught it would end the thread silently.
fn pass(state: &AppState, conn: &rusqlite::Connection, failures: u32) -> u32 {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        super::settings::pass_now(state, conn)
    }))
    .unwrap_or_else(|_| Err("the Tabletop Simulator pass stopped unexpectedly".to_owned()));
    record(state, &outcome);
    match outcome {
        Ok(_) => 0,
        Err(_) => {
            // The flag was taken before this ran; put it back so the retry happens.
            state.tabletop.mark();
            failures.saturating_add(1)
        }
    }
}

/// The loop: its own read-only connection, a startup pass when the integration is on, then a
/// pass two quiet seconds after the last write — `mirror::watch::watch`, for one surface.
fn watch(state: &AppState) {
    let conn = match crate::db::open_read(&state.data_dir) {
        Ok(conn) => conn,
        Err(e) => {
            let message = format!(
                "the Tabletop Simulator integration could not open a database connection: {e}"
            );
            eprintln!("{message}");
            record(state, &Err(message));
            return;
        }
    };

    let mut on = super::settings::enabled(&conn);
    let mut failures = 0u32;
    if on {
        state.tabletop.take();
        failures = pass(state, &conn, failures);
    }

    let mut settings_checked = Instant::now();
    let mut seen_marks = state.tabletop.marks();
    let mut quiet_since = Instant::now();
    let mut last_failure = Instant::now();

    loop {
        std::thread::sleep(TICK);
        if settings_checked.elapsed() >= DEBOUNCE {
            settings_checked = Instant::now();
            let now_on = super::settings::enabled(&conn);
            // Off to on: everything edited while it was off is owed.
            if now_on && !on {
                state.tabletop.mark();
            }
            on = now_on;
        }
        if !on {
            continue;
        }
        let marks = state.tabletop.marks();
        if marks != seen_marks {
            seen_marks = marks;
            quiet_since = Instant::now();
            continue;
        }
        if !state.tabletop.is_dirty() || quiet_since.elapsed() < DEBOUNCE {
            continue;
        }
        if last_failure.elapsed() < backoff_for(failures) {
            continue;
        }
        if !state.tabletop.take() {
            continue;
        }
        failures = pass(state, &conn, failures);
        // The retry's own mark must not read as a fresh edit and restart the debounce.
        seen_marks = state.tabletop.marks();
        if failures > 0 {
            last_failure = Instant::now();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_deck_write_marks_and_a_card_sync_does_not() {
        let t = Tabletop::default();
        t.row("corpus", "cards");
        t.row("main", "collection_entries");
        assert!(!t.is_dirty());
        t.row("main", "deck_token_printings");
        assert!(t.take());
        assert!(!t.take(), "taking clears");
        t.corpus_replaced();
        assert!(t.is_dirty(), "a swap can move every picture's URL");
    }

    #[test]
    fn the_retry_backs_off_to_a_minute() {
        assert_eq!(backoff_for(0), Duration::ZERO);
        assert_eq!(backoff_for(1), DEBOUNCE);
        assert_eq!(backoff_for(30), MAX_BACKOFF);
    }
}
