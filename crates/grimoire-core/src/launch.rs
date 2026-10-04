//! **Opening the databases, for a host that is not the desktop** — the light app's phase 4, and
//! since phase 5 the browser's way in beside it.
//!
//! [`crate::state`] says it plainly: a host opens the connections and [`State::new`] takes them
//! at head. The desktop does that in `src-tauri`'s `desktop::init_state`, around two things only
//! it has — the pre-27 single-file conversion (`split`) and the mirror's installation name, minted
//! before the hook goes on. A host with neither does the rest, and the rest is this: the same
//! steps in the same order, with the desktop's own sentences, so a second host does not write a
//! second copy of them.
//!
//! **Two entries, because there are two kinds of storage.**
//!
//! [`open`] is for a host with **a folder** — Android. In order, each for the desktop's reason:
//!
//! 1. Replaces a corpus that will not open, or that an earlier session found damaged —
//!    [`crate::schema::replace_unreadable_corpus`], before any connection holds the file.
//! 2. Opens the write connection and brings both files to head
//!    ([`crate::schema::prepare_database`]).
//! 3. Opens the read connection, only after: a read-only handle on a file with no tables yet is
//!    a handle that can never be made useful.
//! 4. Builds the image cache over `<data>/images` and the Scryfall client, re-entering any 429
//!    lockout an earlier run earned before a single request can go out.
//!
//! [`open_single`] is for a host with **no folder and one connection** — a browser, whose two
//! databases are names in SQLite's own OPFS VFS and whose storage permits exactly one
//! connection (the light-app spec §6). It is steps 2 and 4, on [`crate::db::open_single`]:
//! no folder is made, no file is asked after, and there is no step 3 — [`Opened::read`] is
//! `None`, and the [`State`] built over it reads through the connection it writes with. What
//! stands in for step 1 there is not built: see [`unreadable_corpus_seam`].
//!
//! **What neither does** is build the [`State`]: the event sink and the write observers are
//! the host's, and so is the moment the hook goes on. Nor does either start anything — the facet
//! index, the image upkeep, the card sync and the feeds are each a host's to spawn, on whatever
//! runtime it has. `src-tauri` does not call this: its sequence has the conversion first and the
//! installation name in the middle, and its error sentence names two candidate folders.
//!
//! [`State`]: crate::state::State
//! [`State::new`]: crate::state::State::new

use std::path::Path;

use rusqlite::Connection;

use crate::db::Journal;
use crate::{app_meta, db, images, schema, scryfall, sync};

/// Where the Scryfall API lives. The desktop names the same string in `desktop.rs`.
pub const SCRYFALL_API: &str = "https://api.scryfall.com";

/// The pieces [`open`] and [`open_single`] answer, ready for [`crate::state::State::new`].
pub struct Opened {
    /// The write connection, at head, with no hook on it yet.
    pub write: Connection,
    /// The read-only connection, opened after the write side migrated — **`None` from
    /// [`open_single`]**, whose host can have only one connection. Handed to
    /// [`crate::state::State::new`] as it is.
    pub read: Option<Connection>,
    /// The journal `user.db` actually got — `wal` on a host with a folder, `delete` on a
    /// browser's pool. Asked for and reported, never assumed ([`Journal`]).
    pub journal: Journal,
    /// The journal `corpus.db` got. Apart from the first because a journal is a file's.
    pub corpus_journal: Journal,
    pub client: scryfall::Client,
    pub images: images::Cache,
}

/// Open `data_dir` as a host with no pre-27 data and no mirror opens it — see the module doc.
///
/// Every refusal is a sentence that names the folder and, where it can, which file and why;
/// none of them tells the reader to move `user.db` aside, which would be the one file in the
/// folder nothing can rebuild.
pub fn open(data_dir: &Path) -> Result<Opened, String> {
    crate::platform::files::create_dir_all(data_dir).map_err(|e| {
        format!(
            "MTG Grimoire could not create its data folder at {}: {e}",
            data_dir.display()
        )
    })?;
    schema::replace_unreadable_corpus(data_dir);

    let pair = db::open_write_pair(data_dir).map_err(|e| folder_error(data_dir, e))?;
    schema::prepare_database(&pair.conn).map_err(|e| {
        format!(
            "MTG Grimoire could not prepare its databases in {}: {e}\n\
             If this says the collection is from a newer version, run that version of the app. \
             Otherwise the storage may be full. Do not delete {}: it holds your collection, \
             decks and wishlist and cannot be rebuilt. Copies taken before each upgrade are in \
             the {} folder beside it.",
            data_dir.display(),
            db::USER_DB,
            schema::USER_BACKUPS_DIR,
        )
    })?;
    let read = db::open_read(data_dir).map_err(|e| folder_error(data_dir, e))?;

    Ok(finish(pair, Some(read), data_dir))
}

/// Open the pair **on one connection, with no folder** — a browser's way in. See the module
/// doc for what it leaves out of [`open`] and why.
///
/// Two places, because a host like that has two different things to say:
///
/// * `databases` is what the two file names are joined to — **empty** where the VFS is the
///   filesystem and its names are bare, which is a browser's pool
///   ([`crate::db::open_single`]). The host has installed that VFS, and made it SQLite's
///   default, before it calls this; nothing here knows there is one.
/// * `data_dir` is what the host will hand [`crate::state::State::new`] as its data directory:
///   what Settings shows a reader, and what the image cache is told its pictures live under.
///   It need not be a path anything can open — the first web host showed `OPFS:/<directory>` —
///   because on such a host nothing opens it: [`crate::platform::files`] refuses, and the image
///   cache there stores nothing.
///
/// A native test passes one scratch directory as both, and gets what a browser gets: an
/// [`Opened`] with no read connection, whose [`crate::state::State`] answers every read from
/// the connection that writes.
///
/// **Nothing is created but the two databases** — SQLite makes those as it opens them. A
/// `databases` that is a folder which does not exist is a refusal, not a folder made.
///
/// Every refusal is a sentence, and none tells the reader to clear the app's storage, which
/// holds the one file nothing can rebuild. They name no backup: a climb's copy of `user.db` is
/// a file beside it ([`crate::schema::back_up_user_file`]), which a host with no folder is
/// refused — logged and skipped, as on any host whose backup cannot be written.
pub fn open_single(databases: &Path, data_dir: &Path) -> Result<Opened, String> {
    unreadable_corpus_seam();

    let pair = db::open_single(databases).map_err(|e| folder_error(data_dir, e))?;
    schema::prepare_database(&pair.conn).map_err(|e| {
        format!(
            "MTG Grimoire could not prepare its databases in {}: {e}\n\
             If this says the collection is from a newer version, run that version of the app. \
             Otherwise the storage may be full. Do not clear the app's stored data: it holds \
             your collection, decks and wishlist and cannot be rebuilt.",
            data_dir.display(),
        )
    })?;

    Ok(finish(pair, None, data_dir))
}

/// **Step 5.2's seam, and deliberately nothing else**: where [`open`] replaces a corpus that
/// will not open, [`open_single`] does nothing — and this is the line it does it on.
///
/// [`crate::schema::replace_unreadable_corpus`] is a dance with files: is the mark there, does
/// the corpus open on a connection of its own, delete it and its journals. A host with no
/// folder can do none of the three ([`crate::platform::files`] refuses, and a second connection
/// is what its storage does not permit). What that leaves a browser with today, case by case:
///
/// * **A corpus that is not there** — never built, or evicted by the browser while the shell
///   and `user.db` survived — is not noticed as such. `ATTACH` creates an empty file,
///   `migrate_corpus` builds the shape, and the app is on a first run: `sync::has_cards` is
///   false. The reader's rows are untouched, and nothing says a corpus *used* to be there.
/// * **A corpus that is there and will not migrate** reaches
///   `schema::replace_attached_corpus`, which detaches it and cannot delete it; it is attached
///   again and the launch is refused with the corpus's own sentence. Every later launch
///   repeats it — the desktop's "throw it away and resync" has no arm here.
/// * **A corpus damaged inside a sound first page** is never looked for: `schema::check_corpus`
///   opens a connection of its own, and the mark it leaves is a file.
///
/// What closes it is the host's to hand over, because the delete is the pool's
/// (`OpfsSAHPoolUtil::delete_db`), not SQLite's: a way to remove one named database before this
/// opens it, and a way for a launch to say *the corpus was expected and is gone* so a page can
/// offer the rebuild (the light-app spec §6, "the corpus can vanish while the shell
/// survives"). Neither is decided here.
fn unreadable_corpus_seam() {}

/// What both entries end on: the image cache, and the Scryfall client with any stored 429
/// lockout re-entered before a single request can go out.
fn finish(pair: db::Pair, read: Option<Connection>, data_dir: &Path) -> Opened {
    let images = images::Cache::new(data_dir.join("images"));
    let client = scryfall::Client::new(SCRYFALL_API.to_owned());
    if let Some(until) = app_meta::get_app_meta(&pair.conn, sync::K_SCRYFALL_PENALTY_UNTIL)
        .and_then(|v| v.parse::<u64>().ok())
    {
        client.restore_penalty(until, scryfall::unix_now());
    }

    Opened {
        write: pair.conn,
        read,
        journal: pair.journal,
        corpus_journal: pair.corpus_journal,
        client,
        images,
    }
}

fn folder_error(data_dir: &Path, e: rusqlite::Error) -> String {
    format!(
        "MTG Grimoire could not open its databases in {}: {e}",
        data_dir.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder that does not exist yet is the first launch on every new install: it is made,
    /// both files are created at head, and the read connection sees the write side's tables.
    #[test]
    fn a_first_launch_makes_the_folder_and_opens_both_files_at_head() {
        let root = crate::scratch::path("launch-first");
        let dir = root.join("data");
        let opened = open(&dir).expect("a fresh folder opens");
        assert!(dir.join(db::USER_DB).is_file());
        assert!(dir.join(db::CORPUS_DB).is_file());
        let read = opened
            .read
            .as_ref()
            .expect("a host with a folder reads on a second connection");
        assert_eq!(
            (opened.journal, opened.corpus_journal),
            (Journal::Wal, Journal::Wal)
        );

        app_meta::set_app_meta(&opened.write, "launch_probe", "written").unwrap();
        assert_eq!(
            app_meta::get_app_meta(read, "launch_probe").as_deref(),
            Some("written"),
            "the read connection must see what the write connection committed"
        );
        assert!(!sync::has_cards(read), "a first launch has no corpus yet");
    }

    /// **A missing corpus is not an unreadable one.** The first phone run (2026-10-04) logged
    /// "the card database could not be opened and has been replaced" on a clean install, because
    /// the probe answered `false` for a file that was not there and the replace path ran. Asked
    /// first of the step alone — over a folder with nothing in it, and over one holding only the
    /// reader's file, which is a corpus deleted to force a resync — and then of a whole launch.
    #[test]
    fn a_first_launch_replaces_nothing() {
        let root = crate::scratch::path("launch-nothing-to-replace");
        let dir = root.join("data");
        crate::platform::files::create_dir_all(&dir).unwrap();
        assert!(
            !schema::replace_unreadable_corpus(&dir),
            "an empty folder has no corpus to replace"
        );

        drop(open(&dir).expect("a fresh folder opens"));
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(dir.join(format!("{}{suffix}", db::CORPUS_DB)));
        }
        assert!(!dir.join(db::CORPUS_DB).exists());
        assert!(
            !schema::replace_unreadable_corpus(&dir),
            "a corpus the reader deleted is rebuilt by the open, not replaced"
        );
        let opened = open(&dir).expect("the open builds it back");
        assert!(dir.join(db::CORPUS_DB).is_file());
        assert!(!sync::has_cards(opened.read.as_ref().unwrap()));
    }

    /// The other half: a corpus that is there and will not open is still replaced, and the
    /// launch goes on over an empty one with the reader's file untouched.
    #[test]
    fn an_unreadable_corpus_is_still_replaced() {
        let root = crate::scratch::path("launch-unreadable-corpus");
        let dir = root.join("data");
        {
            let opened = open(&dir).unwrap();
            app_meta::set_app_meta(&opened.write, "reader_wrote", "this").unwrap();
            db::checkpoint_truncate(&opened.write).unwrap();
        }
        for suffix in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(dir.join(format!("{}{suffix}", db::CORPUS_DB)));
        }
        std::fs::write(dir.join(db::CORPUS_DB), b"not a database at all").unwrap();

        assert!(
            schema::replace_unreadable_corpus(&dir),
            "garbage in the corpus's place is replaced"
        );
        assert!(
            !dir.join(db::CORPUS_DB).exists(),
            "and deleted for the open"
        );

        std::fs::write(dir.join(db::CORPUS_DB), b"not a database at all").unwrap();
        let opened = open(&dir).expect("a launch over a damaged corpus goes on");
        assert!(!sync::has_cards(opened.read.as_ref().unwrap()));
        assert_eq!(
            app_meta::get_app_meta(opened.read.as_ref().unwrap(), "reader_wrote").as_deref(),
            Some("this"),
            "the reader's file is not touched"
        );
    }

    /// A second launch over the same folder migrates nothing and keeps what the reader wrote.
    #[test]
    fn a_second_launch_keeps_what_the_first_wrote() {
        let root = crate::scratch::path("launch-second");
        let dir = root.join("data");
        {
            let opened = open(&dir).unwrap();
            app_meta::set_app_meta(&opened.write, "reader_wrote", "this").unwrap();
        }
        let opened = open(&dir).unwrap();
        assert_eq!(
            app_meta::get_app_meta(opened.read.as_ref().unwrap(), "reader_wrote").as_deref(),
            Some("this")
        );
    }

    /// A lockout an earlier run earned is honoured before the first request: the client comes
    /// back already penalised, not merely told about it later.
    #[test]
    fn a_stored_lockout_is_re_entered_before_any_request() {
        let root = crate::scratch::path("launch-penalty");
        let dir = root.join("data");
        let until = scryfall::unix_now() + 20;
        {
            let opened = open(&dir).unwrap();
            app_meta::set_app_meta(
                &opened.write,
                sync::K_SCRYFALL_PENALTY_UNTIL,
                &until.to_string(),
            )
            .unwrap();
        }
        let opened = open(&dir).unwrap();
        assert!(
            opened.client.penalty_until_unix() > 0,
            "the stored lockout must be live on the new client"
        );
    }

    /// A scratch directory that exists — [`open_single`] makes none.
    fn pool(name: &str) -> std::path::PathBuf {
        let dir = crate::scratch::path(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn state_over(opened: Opened, data_dir: &Path) -> crate::state::State {
        crate::state::State::new(
            opened.write,
            opened.read,
            data_dir.to_path_buf(),
            crate::events::silent(),
            Vec::new(),
            opened.client,
            opened.images,
        )
    }

    /// **The browser's way in, natively**: both files at head on one connection, the launch's
    /// passes run, no read connection — and the state built over it reads through the
    /// connection it writes with.
    #[test]
    fn a_one_connection_launch_opens_the_pair_at_head_with_nothing_to_read_beside() {
        let dir = pool("launch-single");
        let opened = open_single(&dir, &dir).expect("a one-connection launch");
        assert!(
            opened.read.is_none(),
            "there is no second connection to hand over"
        );
        // A file on this machine can have WAL; what matters is that the answer came back.
        assert_eq!(
            (opened.journal, opened.corpus_journal),
            (Journal::Wal, Journal::Wal)
        );
        let version: i64 = opened
            .write
            .query_row("PRAGMA main.user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, schema::USER_SCHEMA_VERSION);
        let capture: i64 = opened
            .write
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'trigger'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            capture > 0,
            "prepare_database installs the capture triggers"
        );
        assert!(dir.join(db::USER_DB).is_file() && dir.join(db::CORPUS_DB).is_file());

        let state = state_over(opened, &dir);
        assert!(state.one_connection());
        assert!(std::ptr::eq(state.reader(), &state.db));
        app_meta::set_app_meta(&state.lock_db(), "launch_probe", "written").unwrap();
        assert_eq!(
            app_meta::get_app_meta(&state.lock_db_read(), "launch_probe").as_deref(),
            Some("written")
        );
        assert!(!sync::has_cards(&state.lock_db_read()));
    }

    /// A second launch finds what the first wrote, and re-enters a stored lockout — the tail
    /// both entries share.
    #[test]
    fn a_second_one_connection_launch_keeps_the_readers_rows_and_the_lockout() {
        let dir = pool("launch-single-second");
        let until = scryfall::unix_now() + 20;
        {
            let opened = open_single(&dir, &dir).unwrap();
            app_meta::set_app_meta(&opened.write, "reader_wrote", "this").unwrap();
            app_meta::set_app_meta(
                &opened.write,
                sync::K_SCRYFALL_PENALTY_UNTIL,
                &until.to_string(),
            )
            .unwrap();
        }
        let opened = open_single(&dir, &dir).unwrap();
        assert_eq!(
            app_meta::get_app_meta(&opened.write, "reader_wrote").as_deref(),
            Some("this")
        );
        assert!(opened.client.penalty_until_unix() > 0);
    }

    /// **It makes no folder**: a browser has none to make, and `platform::files` refuses there.
    /// A place that is not there is a refusal that names what the host calls its storage, and
    /// nothing is left behind.
    #[test]
    fn a_one_connection_launch_makes_no_folder() {
        let root = pool("launch-single-nowhere");
        let missing = root.join("not-made");
        let shown = Path::new("OPFS:/mtg-grimoire");
        let refused = open_single(&missing, shown)
            .err()
            .expect("a folder that is not there is not made");
        assert!(
            refused.contains("could not open its databases in OPFS:/mtg-grimoire"),
            "{refused}"
        );
        assert!(!missing.exists());
    }

    /// What the host calls its storage is what the image cache is told, and nothing is opened
    /// there: the databases are wherever `databases` says.
    #[test]
    fn the_two_places_of_a_one_connection_launch_are_two_places() {
        let dir = pool("launch-single-places");
        let shown = Path::new("OPFS:/mtg-grimoire");
        let opened = open_single(&dir, shown).unwrap();
        assert_eq!(opened.images.dir(), shown.join("images"));
        assert!(dir.join(db::USER_DB).is_file());
    }
}
