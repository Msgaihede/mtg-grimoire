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
//! stands in for step 1 there is [`open_single_replacing`]: the same open, for a host that can
//! delete its corpus by name and try again.
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
    /// Whether this open threw the corpus away and built an empty one in its place — only
    /// ever `true` from [`open_single_replacing`]. The reader's rows are untouched; the cards
    /// come back with the next sync, and a host that can say so should.
    pub corpus_replaced: bool,
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
    attempt_single(databases, data_dir).map_err(|refused| refused.sentence)
}

/// [`open_single`] for a host that **can delete its corpus by name** — a browser, whose
/// storage is a pool with a delete of its own (`OpfsSAHPoolUtil::delete_db`): a corpus that
/// will not open, or will not migrate, is thrown away and the pair is opened again over an
/// empty one. `user.db` is never touched, and the next card sync builds the corpus back.
///
/// It is what [`open`] does with files, for a host that has none. There the dance is
/// [`crate::schema::replace_unreadable_corpus`] before the open and
/// `schema::replace_attached_corpus` inside it, and both are refused on a host with no folder
/// ([`crate::platform::files`]) — so until this existed a corpus that would not migrate was
/// attached again and stopped every launch for good.
///
/// **What decides it is here; only the delete is the host's.** `delete_corpus` is called at
/// most once, with every connection closed — the first attempt's is dropped before it — and
/// only for a failure that is *about the corpus file*:
///
/// * the corpus would not attach or take its pragmas ([`db::Unopened::Corpus`]), or would
///   not climb to head ([`schema::Stopped::Corpus`]);
/// * and the failure says something about the file. A full or read-only store, a busy or
///   locked database and an I/O error (`schema::says_nothing_about_the_file`) stop the launch
///   as they always did: deleting a corpus over one costs a whole resync and cures nothing.
///
/// A failure in `user.db`, in the capture triggers, or anywhere else is refused in its own
/// sentence with nothing deleted. A delete that fails is refused in the first failure's
/// sentence with the delete's reason after it. And a second failure after a delete that
/// worked is the launch's answer: nothing is deleted twice.
///
/// **[`Opened::corpus_replaced`] says it happened**, so a host can say so: the page then
/// finds no cards, which reads as a first run, and the launch's card sync is what rebuilds.
///
/// ⚠️ **What it does not cover**: a corpus damaged *inside* a file whose first page is sound.
/// [`open`]'s host looks for that after launch on a connection of its own
/// ([`crate::schema::check_corpus`]) and leaves a mark file for the next one; a host with one
/// connection and no files has neither, and nothing looks. And a corpus that is simply gone —
/// evicted by the browser while `user.db` survived — is not noticed as such: `ATTACH` makes
/// an empty one, and the app is on a first run.
pub fn open_single_replacing(
    databases: &Path,
    data_dir: &Path,
    delete_corpus: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Opened, String> {
    let refused = match attempt_single(databases, data_dir) {
        Ok(opened) => return Ok(opened),
        Err(refused) => refused,
    };
    if !refused.corpus {
        return Err(refused.sentence);
    }
    // No connection is open here: `attempt_single` dropped its own on the way out.
    if let Err(why) = delete_corpus() {
        return Err(format!(
            "{}\nThe card database could not be removed to be rebuilt: {why}",
            refused.sentence
        ));
    }
    let mut opened = attempt_single(databases, data_dir).map_err(|again| again.sentence)?;
    opened.corpus_replaced = true;
    Ok(opened)
}

/// Why a one-connection launch stopped, and whether throwing the corpus away could cure it.
struct Refused {
    sentence: String,
    /// The failure was about `corpus.db` itself — see [`open_single_replacing`].
    corpus: bool,
}

/// One try at the one-connection launch. The connection it opened is closed by the time it
/// answers a refusal, which is what lets a host delete a file behind it.
fn attempt_single(databases: &Path, data_dir: &Path) -> Result<Opened, Refused> {
    let pair = db::open_single_or_say(databases).map_err(|unopened| {
        let corpus = matches!(
            &unopened,
            db::Unopened::Corpus(e) if !schema::says_nothing_about_the_file(e)
        );
        Refused {
            sentence: folder_error(data_dir, unopened.into_error()),
            corpus,
        }
    })?;
    if let Err(stopped) = schema::prepare_database_or_say(&pair.conn) {
        let corpus = matches!(stopped, schema::Stopped::Corpus(_));
        let e = stopped.into_error();
        return Err(Refused {
            sentence: format!(
                "MTG Grimoire could not prepare its databases in {}: {e}\n\
                 If this says the collection is from a newer version, run that version of the \
                 app. Otherwise the storage may be full. Do not clear the app's stored data: \
                 it holds your collection, decks and wishlist and cannot be rebuilt.",
                data_dir.display(),
            ),
            corpus,
        });
    }

    Ok(finish(pair, None, data_dir))
}

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
        corpus_replaced: false,
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

    // ---- a corpus that will not open, on a host whose storage can delete one --------------
    //
    // On a thread standing in for a page (`platform::host::emulate_page`) the file interface
    // refuses, exactly as a browser's does — so `schema::replace_attached_corpus` cannot
    // delete the corpus itself, which is the state a pool leaves a launch in. The closure
    // stands in for the pool's delete.

    /// A pair with a row of the reader's in it, and a corpus that will not migrate: version 0,
    /// holding a table the climb builds.
    fn pool_with_a_corpus_that_will_not_migrate(name: &str) -> std::path::PathBuf {
        let dir = pool(name);
        {
            let opened = open_single(&dir, &dir).unwrap();
            app_meta::set_app_meta(&opened.write, "reader_wrote", "this").unwrap();
            db::checkpoint_truncate(&opened.write).unwrap();
        }
        delete_corpus_files(&dir);
        let conn = rusqlite::Connection::open(dir.join(db::CORPUS_DB)).unwrap();
        conn.execute_batch("CREATE TABLE cards (id TEXT)").unwrap();
        dir
    }

    /// What a pool's delete does: the corpus and whatever SQLite kept beside it.
    fn delete_corpus_files(dir: &Path) {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let _ = std::fs::remove_file(dir.join(format!("{}{suffix}", db::CORPUS_DB)));
        }
    }

    fn readers_row(opened: &Opened) -> Option<String> {
        app_meta::get_app_meta(&opened.write, "reader_wrote")
    }

    /// **A corpus that will not migrate is thrown away by the host's delete and the launch
    /// goes on** — once, with the reader's file untouched, and saying that it happened.
    /// Without a delete the same folder refuses every launch, which is what a browser had
    /// until this existed.
    #[test]
    fn a_corpus_that_will_not_migrate_is_replaced_through_the_hosts_delete() {
        let dir = pool_with_a_corpus_that_will_not_migrate("launch-single-replace");
        let _page = crate::platform::host::emulate_page();

        let stopped = open_single(&dir, &dir)
            .err()
            .expect("with nothing to delete it with, the launch stops");
        assert!(
            stopped.contains("could not prepare its databases")
                && stopped.contains("table cards already exists"),
            "{stopped}"
        );
        assert!(
            dir.join(db::CORPUS_DB).is_file(),
            "and the corpus is still there"
        );

        let mut deletes = 0;
        let opened = open_single_replacing(&dir, &dir, &mut || {
            deletes += 1;
            delete_corpus_files(&dir);
            Ok(())
        })
        .expect("a host that can delete its corpus opens over an empty one");
        assert_eq!(deletes, 1);
        assert!(opened.corpus_replaced);
        assert_eq!(
            readers_row(&opened).as_deref(),
            Some("this"),
            "user.db is not touched"
        );
        assert!(
            !sync::has_cards(&opened.write),
            "the corpus is empty, at head"
        );
        let sets: i64 = opened
            .write
            .query_row("SELECT count(*) FROM corpus.sets", [], |r| r.get(0))
            .expect("the corpus has its shape back");
        assert_eq!(sets, 0);
    }

    /// The other way a corpus will not open: bytes that are not a database at all.
    #[test]
    fn a_corpus_that_is_not_a_database_is_replaced_through_the_hosts_delete() {
        let dir = pool("launch-single-garbage");
        {
            let opened = open_single(&dir, &dir).unwrap();
            app_meta::set_app_meta(&opened.write, "reader_wrote", "this").unwrap();
            db::checkpoint_truncate(&opened.write).unwrap();
        }
        delete_corpus_files(&dir);
        std::fs::write(
            dir.join(db::CORPUS_DB),
            b"not a database at all, at some length",
        )
        .unwrap();
        let _page = crate::platform::host::emulate_page();

        assert!(open_single(&dir, &dir).is_err());
        let mut deletes = 0;
        let opened = open_single_replacing(&dir, &dir, &mut || {
            deletes += 1;
            delete_corpus_files(&dir);
            Ok(())
        })
        .expect("garbage in the corpus's place is replaced");
        assert_eq!(deletes, 1);
        assert!(opened.corpus_replaced);
        assert_eq!(readers_row(&opened).as_deref(), Some("this"));
    }

    /// **Nothing is deleted for a failure that is not the corpus's**, and nothing for a launch
    /// that needs no help: a reader's file from a newer version stops the launch in its own
    /// sentence with the corpus where it was.
    #[test]
    fn the_hosts_delete_is_never_called_for_a_failure_that_is_not_the_corpus() {
        let dir = pool("launch-single-not-the-corpus");
        let mut deletes = 0;
        {
            let opened = open_single_replacing(&dir, &dir, &mut || {
                deletes += 1;
                Ok(())
            })
            .expect("a first launch opens");
            assert!(!opened.corpus_replaced);
            opened
                .write
                .execute_batch("PRAGMA main.user_version = 9999")
                .unwrap();
        }
        assert_eq!(deletes, 0, "a launch that opens deletes nothing");

        let _page = crate::platform::host::emulate_page();
        let refused = open_single_replacing(&dir, &dir, &mut || {
            deletes += 1;
            Ok(())
        })
        .err()
        .expect("a collection from a newer version is not opened");
        assert!(refused.contains("user.db"), "{refused}");
        assert_eq!(deletes, 0, "and its corpus is not thrown away over it");
        assert!(dir.join(db::CORPUS_DB).is_file());
    }

    /// **A delete that fails, and a delete that changes nothing**: the first is said after the
    /// failure that asked for it, and the second leaves the launch's own answer — the delete
    /// is tried once and never again.
    #[test]
    fn a_delete_that_does_not_help_is_said_and_is_not_tried_twice() {
        let dir = pool_with_a_corpus_that_will_not_migrate("launch-single-delete-fails");
        let _page = crate::platform::host::emulate_page();

        let refused = open_single_replacing(&dir, &dir, &mut || {
            Err("the pool would not let go of it".to_owned())
        })
        .err()
        .unwrap();
        assert!(
            refused.contains("already exists")
                && refused.contains(
                    "The card database could not be removed to be rebuilt: the pool would not \
                     let go of it"
                ),
            "{refused}"
        );

        let mut deletes = 0;
        let refused = open_single_replacing(&dir, &dir, &mut || {
            deletes += 1;
            Ok(())
        })
        .err()
        .expect("a corpus that is still there still will not migrate");
        assert!(refused.contains("already exists"), "{refused}");
        assert_eq!(deletes, 1);
    }

    /// **A corpus that cannot be opened for a reason that says nothing about the file is not
    /// deleted.** "Unable to open" is what a full store, a held handle or a refused permission
    /// look like, and none of them is cured by throwing a card database away — it costs the
    /// reader a whole resync and the next launch fails the same way. A folder standing where
    /// the corpus should be is a can't-open that needs no fault injected: the attach is
    /// refused, the launch stops in its own sentence, and the host's delete is never called.
    #[test]
    fn a_corpus_that_cannot_be_opened_for_a_reason_that_is_not_about_it_is_never_deleted() {
        let dir = pool("launch-single-cannot-open");
        {
            let opened = open_single(&dir, &dir).unwrap();
            app_meta::set_app_meta(&opened.write, "reader_wrote", "this").unwrap();
            db::checkpoint_truncate(&opened.write).unwrap();
        }
        delete_corpus_files(&dir);
        std::fs::create_dir(dir.join(db::CORPUS_DB)).unwrap();

        // The premise, asked of the opener itself: this is the corpus's failure, and it is
        // one of the kind that says nothing about the file.
        match db::open_single_or_say(&dir) {
            Err(db::Unopened::Corpus(e)) => assert!(
                schema::says_nothing_about_the_file(&e),
                "a folder in the corpus's place should be a can't-open, and was: {e}"
            ),
            Err(db::Unopened::User(e)) => panic!("the reader's file opened before: {e}"),
            Ok(_) => panic!("a folder is not a database"),
        }

        let _page = crate::platform::host::emulate_page();
        let mut deletes = 0;
        let refused = open_single_replacing(&dir, &dir, &mut || {
            deletes += 1;
            Ok(())
        })
        .err()
        .expect("a corpus that cannot be opened stops the launch");
        assert_eq!(
            deletes, 0,
            "a failure that says nothing about the corpus must not cost the reader a resync"
        );
        assert!(
            refused.contains("could not open its databases"),
            "{refused}"
        );
        assert!(dir.join(db::CORPUS_DB).is_dir(), "and nothing was removed");
    }
}
