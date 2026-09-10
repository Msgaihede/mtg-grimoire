//! Which view the app opens on — the setting, and nothing else.
//!
//! **[`crate::nav`]'s module with a word instead of a bit.** How many views there are, what each
//! of them draws, and which of them a reader may land on are all questions about pages this crate
//! never draws. All Rust owns is one `app_meta` row holding a word, plus the rule that a row it
//! cannot make a word out of means [`DEFAULT_VIEW`].
//!
//! Two rules shape it, and they are [`crate::nav`]'s two — the second one narrowed rather than
//! hollowed out:
//!
//! * **Reading can never fail.** A missing row (a fresh install, and the common case), a row that
//!   cannot be read at all (`get_app_meta` swallows the error), a row somebody hand-edited down to
//!   nothing or to spaces — every one of them reads as [`DEFAULT_VIEW`]. The landing view's job is
//!   to be *somewhere*: a preference that cannot be read is not worth refusing to draw the window
//!   over, and Home is the one page that is always there. [`stored`] is therefore infallible by
//!   signature — a bare `String`, not a `Result`, which is [`crate::nav::nav_collapsed`]'s
//!   contract rather than a shortcut.
//! * **Writing validates only what Rust can validate.** A blank word — or one that is nothing but
//!   whitespace — is refused, because it is not a view in any vocabulary; it is a bug in the
//!   caller, and storing it would hand the shell back a remembered choice of nothing. The word is
//!   trimmed on the way in, so what a later read compares is what the caller meant. **Nothing else
//!   is checked**, and that is the next paragraph.
//!
//! **The difference from [`crate::nav`] is that last sentence, and it is the whole point of this
//! module: the vocabulary of views is TypeScript's.** A bit has two values and both are storable,
//! so `nav`'s write arm has nothing to refuse; a view has as many values as the frontend has
//! pages, and *this crate does not know them*. That is [`crate::listview`]'s split — that module
//! owns the two words a wall may be drawn in and knows nothing about which walls exist, and this
//! one owns "a non-empty word" and knows nothing about which views exist. So a word this build has
//! never heard of is handed **straight back** — the test below is named for exactly that — and
//! `ViewId` is checked on the other side of the wire, where a word that is not a page falls back
//! to Home.
//!
//! An allow-list here was the obvious alternative and is wrong twice over. Every new view would
//! become a Rust change as well as a TypeScript one — a fence that has to be edited to let the
//! ordinary case through is a fence somebody will eventually route around. And, worse, a
//! **downgrade** would strand a reader: their build writes a view an older build does not have,
//! they run the older build, and an allow-list refuses the row on read with nowhere to say so.
//! Without one the word survives the round trip untouched, the older frontend falls back to Home
//! for exactly as long as it is the one running, and the newer build finds the reader's choice
//! still there.
//!
//! One row holding a word rather than a flag per view, for the reason the read rule makes cheap:
//! exactly one view can be the starting one, so a key per view would be a set of rows that can
//! disagree with each other and a read that has to pick a winner.
//!
//! No migration. `app_meta` is the *application's* key/value table (schema v6), deliberately not
//! `sync_meta` — a row in that one the sync did not write makes every later timing claim a fiction
//! — and this is a key in a table that has existed since v6. A preference that needed a schema
//! step would be a preference that could fail a launch.

#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::Connection;
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// The `app_meta` key.
///
/// `app_meta` is the *application's* key/value table (schema v6), deliberately not `sync_meta` —
/// a row in that one the sync did not write makes every later timing claim a fiction. **No
/// migration**: this is a key in a table that has existed since v6.
pub const K_START_VIEW: &str = "start_view";

/// Where the app opens when the row says nothing this crate can use.
///
/// Named rather than inlined for [`crate::nav`]'s `COLLAPSED` reason turned around: nothing here
/// compares against it, so a second spelling would not fail anywhere either — it would simply be
/// two different answers to "where does a fresh install land", one of them reached only on the
/// paths nobody exercises. It is `"home"` because Home is the one view that cannot be absent: it
/// needs no collection, no decks and no sync, so it is the only word that is safe to fall back to
/// before anything at all is known about the database.
pub const DEFAULT_VIEW: &str = "home";

/// What [`store`] says when it is handed a blank where a view should be.
///
/// The whole of what this crate checks about the word, and [`crate::deck`]'s `NO_MODE` sentence
/// two settings over: the vocabulary is TypeScript's and this module deliberately does not know
/// it, but an empty string is not a view in any vocabulary — it is a bug in the caller, and
/// storing it would mean a stored preference that reads back as no preference on every launch.
const NO_VIEW: &str = "A starting view cannot be blank.";

/// Which view does the app open on?
///
/// **Handed back verbatim, whatever it says.** A word this build has never heard of is not an
/// error and not a reason to fall back — it is next month's build's answer, or last month's, and
/// `ViewId` is what decides whether this frontend can draw it. See the module doc.
///
/// The fallback is therefore narrower than [`crate::nav::stored`]'s: only a row that holds no
/// word at all reads as [`DEFAULT_VIEW`] — no row, a row `get_app_meta` could not read, and a
/// hand-edited row holding nothing or spaces. [`store`] refuses the last of those, so it can only
/// ever arrive from outside this crate.
pub fn stored(conn: &Connection) -> String {
    crate::app_meta::get_app_meta(conn, K_START_VIEW)
        .filter(|view| !view.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_VIEW.to_owned())
}

/// Remember which view the app opens on.
///
/// **One refusal, and it is the only one Rust is in a position to make.** The word is trimmed
/// first, so `"  decks  "` is stored as `decks` and a caller's stray whitespace cannot become a
/// preference no later read matches; a word that is nothing *but* whitespace is then a blank and
/// is refused rather than stored. Everything else is written as given — see the module doc for why
/// an allow-list here would be a fence in the wrong crate.
///
/// The `Result`'s other arm is SQLite's — a full or read-only disk — and it is a failure of the
/// write rather than a judgement about the argument.
pub fn store(conn: &Connection, view: &str) -> Result<(), String> {
    let view = view.trim();
    if view.is_empty() {
        return Err(NO_VIEW.to_owned());
    }
    crate::app_meta::set_app_meta(conn, K_START_VIEW, view)
        .map_err(|e| format!("could not save the starting view: {e}"))
}

/// Which view the app opens on.
///
/// **Infallible by signature**, which is [`crate::nav::nav_collapsed`]'s contract and for its
/// reason: the frontend reads this to seed a store that already has a default of its own, and
/// there is nothing the app shell could do with an error here that is not just "open on Home" —
/// so this answers that instead of making the caller spell it out.
///
/// `#[tauri::command(async)]` rather than a bare sync command: a sync body runs inline on the IPC
/// thread, and this one takes `db_read`'s mutex, which a search may hold for tens of milliseconds
/// — and this is called while the window is drawing its first frame. It is not an `async fn`
/// because Tauri requires a `Result` from one that borrows `State`, and a `Result` here would be a
/// failure mode this call does not have.
#[cfg(not(target_family = "wasm"))]
#[tauri::command(async)]
pub fn start_view(state: tauri::State<'_, Arc<AppState>>) -> String {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember which view the app opens on. Answers [`crate::db::BUSY`] if a sync holds the write
/// connection — the bound every write command in this crate takes.
///
/// **A refusal here is deliberately not surfaced**, which is a fact about the caller rather than
/// about this function: the setting decides what happens at the *next* launch, so a BUSY during a
/// first-run sync costs the reader nothing they can see now, and the row they are looking at
/// already shows the choice they made.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn set_start_view(
    state: tauri::State<'_, Arc<AppState>>,
    view: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &view))
    })
    .await
    .map_err(|e| format!("the starting view could not be saved: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_meta::set_app_meta;

    fn conn() -> Connection {
        crate::schema::memory_pair()
    }

    /// A database nobody has chosen for opens on Home. This is the state every fresh install is
    /// in, so it is the one the fallback has to be right about — and the literal is spelled out
    /// rather than compared against [`DEFAULT_VIEW`], so that changing where a fresh install lands
    /// is a deliberate act rather than a rename that reads as a no-op.
    #[test]
    fn a_missing_row_reads_as_home() {
        assert_eq!(stored(&conn()), "home");
    }

    /// **The rule this module exists for.** Written past [`store`] deliberately, because this
    /// build has no way to produce a view it does not know — which is exactly why the case has to
    /// be built by hand. A newer build's view, or a view an older build was downgraded away from,
    /// comes back untouched and is `ViewId`'s problem on the other side of the wire; an allow-list
    /// here would refuse the row and strand the reader on a page they never chose.
    #[test]
    fn a_word_this_build_has_never_heard_of_is_handed_back_unchanged() {
        let c = conn();
        set_app_meta(&c, K_START_VIEW, "someViewFromTheFuture").unwrap();
        assert_eq!(
            stored(&c),
            "someViewFromTheFuture",
            "the vocabulary is TypeScript's"
        );
    }

    /// The setting outlives the process, so the only thing that matters about it is that what went
    /// in comes back out.
    #[test]
    fn a_stored_view_round_trips() {
        let c = conn();
        store(&c, "search").unwrap();
        assert_eq!(stored(&c), "search");
    }

    /// The complement of the read rule: the one word Rust refuses is refused at the door, and a
    /// refused write leaves the reader's previous choice exactly where it was. A `store` that
    /// wrote first and validated afterwards would pass a round-trip test and cost the reader their
    /// setting on the one press that was a mistake.
    #[test]
    fn a_blank_view_is_refused_and_leaves_the_row_alone() {
        let c = conn();
        store(&c, "search").unwrap();
        assert!(store(&c, "   ").is_err());
        assert_eq!(stored(&c), "search");
    }

    /// Whitespace is the caller's, never the reader's choice. Stored untrimmed it would be a word
    /// no `ViewId` matches, so the shell would open on Home while the setting panel showed Decks
    /// — a preference that looks saved and is not.
    #[test]
    fn a_view_is_trimmed_on_the_way_in() {
        let c = conn();
        store(&c, "  decks  ").unwrap();
        assert_eq!(stored(&c), "decks");
    }
}
