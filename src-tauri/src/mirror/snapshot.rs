//! The backup as one archive, taken when the reader asks — the web and Android answer to a
//! folder neither platform can offer.
//!
//! **What is here is the mirror's renderer with the filesystem taken away**, and that is the
//! whole design rather than a summary of it. [`super::layout::plan_files`] decides the tree,
//! [`render`] turns one planned file into its bytes, and `run` is the only thing that
//! ever writes either to disk. A browser has no folder another program can read — OPFS is
//! invisible to every program but this one — and an Android app's private directory is the
//! same in practice, which `tauri-plugin-dialog`'s manifest settles from the other end by
//! recording Android as having no folder picker. A continuously-written folder on those two
//! targets would be the feature's name without the feature, so they get the files as one zip
//! instead: a snapshot rather than a mirror, which is a trade rather than a shortfall.
//!
//! **Three things follow from "a snapshot", and each one is a deliberate absence below.**
//!
//! - **No `watch::Mask`.** The mirror learns what to render from three atomic bits an
//!   `update_hook` sets; a button knows already, because the reader pressed it. [`render_all`]
//!   takes a `&Connection` and nothing else, and `AppState` on wasm has no `mirror` field to
//!   offer it anyway.
//! - **No `.mirror-manifest`.** That file exists to authorise *deleting*, and it is the only
//!   authority `run::prune` has. A zip deletes nothing, so a manifest in one would be
//!   a record with nothing to record — and a reader who unpacked it into the mirror's folder
//!   would be handing the pruner a list from a different moment.
//! - **No digest cache.** Every byte in the archive is new to whoever receives it.
//!
//! **It is the same renderer, and the golden fence is why that matters.**
//! `src/features/transfer/__golden__/` fences `crate::transfer` against
//! `src/features/transfer/export/` byte for byte; routing the zip through a second renderer
//! would put a third writer outside that fence. `run::run_pass` and [`render_all`]
//! call the same [`render`], so a file in the archive and the same file in the folder are the
//! same bytes by construction rather than by two tests agreeing.

use rusqlite::Connection;

use super::layout::{plan_files, PlannedFile, Shape, Source};
use super::readme::{README_NAME, SNAPSHOT_README};
use crate::sorting::Marketplace;
use crate::transfer::fields::available_fields;
use crate::transfer::write::format_export;
use crate::transfer::Card;

/// The stem every archive is named after, before the date is appended.
const ARCHIVE_STEM: &str = "mtg-grimoire-backup";

/// One rendered file, in memory: where it belongs in the archive and what is in it.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderedFile {
    /// Archive-relative, `/` separators — [`PlannedFile::path`] unchanged, because a zip entry
    /// name is spelled the same way a mirrored path is and every reader-supplied segment has
    /// already been through [`super::paths::sanitise`].
    pub path: String,
    pub text: String,
}

/// What one archive is, before it is handed anywhere.
#[derive(Debug, Clone, PartialEq)]
pub struct Archive {
    pub file_name: String,
    /// Entries actually in the archive, [`README_NAME`] included.
    pub files: usize,
    /// Lists that could not be read, and so are **missing from the archive**.
    ///
    /// **Counted rather than fatal, and counted rather than silent.** The mirror's rule is that
    /// one file that fails is one file — an unwritable path is no reason to abandon the other
    /// 349 — and the same holds here. What does *not* hold is leaving it at that: a folder the
    /// reader can look at shows them a missing deck, and a zip they have already mailed to
    /// themselves does not. So the number travels all the way to the panel, which says it in
    /// the tone it uses for a refusal.
    pub failed: usize,
    pub bytes: Vec<u8>,
}

/// What the page is told about an archive, and how it got the bytes.
///
/// One type for both doors rather than two that differ by a field: `base64` is `None` when
/// Rust has already written the archive at a destination the reader picked, which is the
/// Android and desktop path, and `Some` when the page has to make a download out of it, which
/// is the browser's. A reader of the answer can tell which happened from the field itself.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupZip {
    pub file_name: String,
    pub files: usize,
    pub failed: usize,
    pub byte_length: usize,
    /// The archive itself, **standard** base64 — the alphabet `atob` takes. Deliberately not
    /// the URL-safe one `sync_engine::wire` uses: that blob is a path segment on its way to a
    /// relay, and this one is a `Blob` on its way to a download the browser starts.
    pub base64: Option<String>,
}

impl Archive {
    /// The answer for the door that hands the page the bytes.
    pub fn with_bytes(&self) -> BackupZip {
        use base64::Engine as _;
        BackupZip {
            base64: Some(base64::engine::general_purpose::STANDARD.encode(&self.bytes)),
            ..self.without_bytes()
        }
    }

    /// The answer for the door where Rust has already written the file.
    pub fn without_bytes(&self) -> BackupZip {
        BackupZip {
            file_name: self.file_name.clone(),
            files: self.files,
            failed: self.failed,
            byte_length: self.bytes.len(),
            base64: None,
        }
    }
}

/// One planned file's bytes, reading its list only when it is not the one already in hand.
///
/// Every optional field is on, which is exactly what [`available_fields`] already answers — a
/// backup is the one place in this app where "what *can* this file say" and "what should it
/// say" have the same answer.
///
/// **`pub(super)` and moved here from `run` on 2026-08-31**, which is the one edit
/// that makes the zip the same feature as the folder rather than a second one: the pass and the
/// archive now render through this function, so what is in a downloaded `Azula.csv` and what is
/// in a mirrored one cannot come apart. `run.rs` is desktop-only and this is not, which is why
/// it moved down rather than the caller moving up.
///
/// The memo keeps the **previous** source on failure, so the next file of a list that would not
/// read finds it stale and tries again rather than being handed the wrong deck's cards.
pub(super) fn render(
    conn: &Connection,
    file: &PlannedFile,
    marketplace: Marketplace,
    memo: &mut Option<(Source, Vec<Card>)>,
) -> Result<String, String> {
    let stale = match memo {
        Some((source, _)) => source != &file.source,
        None => true,
    };
    if stale {
        let cards = super::read::cards_for(conn, &file.source, marketplace)?;
        *memo = Some((file.source.clone(), cards));
    }
    let cards = memo.as_ref().map_or(&[][..], |(_, c)| c.as_slice());
    Ok(format_export(
        cards,
        file.format,
        &available_fields(file.format, file.surface),
    ))
}

/// Render the whole tree into memory: every file [`plan_files`] names, plus the README.
///
/// **No filesystem is touched and none is needed**, which is what lets this run in a Worker.
/// The four reads are the same four `run::run_pass` makes, through the same functions
/// the app's own screens read through — a statement of this module's own would be a second
/// answer to "what is in this deck" that nothing keeps in step with the first.
///
/// The `usize` is the number of lists that could not be read. See [`Archive::failed`] for why
/// that is carried rather than raised.
pub fn render_all(conn: &Connection) -> Result<(Vec<RenderedFile>, usize), String> {
    let decks = crate::deck::list_decks(conn)?;
    let deck_folders = crate::deck_meta::list_folders(conn)?;
    let collection_folders = crate::collection_folders::list_folders(conn)?;
    let wishlist_folders = crate::wishlist_folders::list_folders(conn)?;
    let plan = plan_files(&Shape {
        decks: &decks,
        deck_folders: &deck_folders,
        collection_folders: &collection_folders,
        wishlist_folders: &wishlist_folders,
    });
    // The reader's own choice, so the `Price` column in an archived CSV says what the app says.
    let marketplace = Marketplace::from_id(&crate::marketplace::stored(conn));

    let mut out = Vec::with_capacity(plan.files.len() + 1);
    out.push(RenderedFile {
        path: README_NAME.to_owned(),
        text: SNAPSHOT_README.to_owned(),
    });
    let mut failed = 0;
    let mut memo: Option<(Source, Vec<Card>)> = None;
    for file in &plan.files {
        match render(conn, file, marketplace, &mut memo) {
            Ok(text) => out.push(RenderedFile {
                path: file.path.clone(),
                text,
            }),
            Err(_) => failed += 1,
        }
    }
    Ok((out, failed))
}

/// A moment, as the *database* tells it.
///
/// **`SELECT strftime(…)` and never [`std::time::SystemTime::now`]**, which is not a style
/// choice: `SystemTime::now()` **panics** on `wasm32-unknown-unknown` rather than answering an
/// error, so the obvious clock would take the whole Worker down on the one target this feature
/// exists for. SQLite has a clock and does the calendar arithmetic too, which is the second
/// reason — turning a unix second into a year, a month and a day by hand would be a date
/// library this crate does not have.
///
/// **It only ever falls back.** A clock that will not answer costs the archive its date, in the
/// name and in the entry stamps, and costs it nothing else. 1980-01-01 is the zip format's own
/// epoch and what [`zip`] writes when it has no better answer.
struct Stamp {
    /// `2026-08-31`, or empty when the clock would not answer.
    date: String,
    when: zip::DateTime,
}

fn stamp(conn: &Connection) -> Stamp {
    let fallback = Stamp {
        date: String::new(),
        when: zip::DateTime::default(),
    };
    let Ok(text) = conn.query_row(
        "SELECT strftime('%Y %m %d %H %M %S', 'now')",
        [],
        |row| row.get::<_, String>(0),
    ) else {
        return fallback;
    };
    let parts: Vec<&str> = text.split(' ').collect();
    let [year, month, day, hour, minute, second] = parts.as_slice() else {
        return fallback;
    };
    let (Ok(year), Ok(month), Ok(day), Ok(hour), Ok(minute), Ok(second)) = (
        year.parse::<u16>(),
        month.parse::<u8>(),
        day.parse::<u8>(),
        hour.parse::<u8>(),
        minute.parse::<u8>(),
        second.parse::<u8>(),
    ) else {
        return fallback;
    };
    // `from_date_and_time` refuses a year outside 1980..=2107 and an odd second, which is the
    // zip format's own range rather than anything this app decides. A refusal is the fallback
    // stamp with the *date* kept: the name is this app's and stays truthful either way.
    let when = zip::DateTime::from_date_and_time(year, month, day, hour, minute, second)
        .unwrap_or_default();
    Stamp {
        date: format!("{year:04}-{month:02}-{day:02}"),
        when,
    }
}

/// Render everything and pack it into one deflated archive.
///
/// **The whole archive is built in memory**, which is the shape every destination wants: a
/// browser needs a `Blob`, and Android needs bytes to push down a descriptor the ContentResolver
/// opened. ~350 text files compress to something on the order of a megabyte, so this is a
/// bounded allocation and not a stream worth engineering.
///
/// The only `Err` is the zip writer refusing, which is a bug in this crate rather than anything
/// the reader did — a per-list failure is counted in [`Archive::failed`] and survived.
pub fn build(conn: &Connection) -> Result<Archive, String> {
    use std::io::Write as _;

    let (files, failed) = render_all(conn)?;
    let stamp = stamp(conn);

    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .last_modified_time(stamp.when);
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::<u8>::new()));
    for file in &files {
        writer
            .start_file(file.path.as_str(), options)
            .map_err(|e| format!("the backup archive could not be written: {e}"))?;
        writer
            .write_all(file.text.as_bytes())
            .map_err(|e| format!("the backup archive could not be written: {e}"))?;
    }
    let bytes = writer
        .finish()
        .map_err(|e| format!("the backup archive could not be finished: {e}"))?
        .into_inner();

    Ok(Archive {
        file_name: archive_name(&stamp.date),
        files: files.len(),
        failed,
        bytes,
    })
}

/// `mtg-grimoire-backup-2026-08-31.zip`, or the stem alone when the clock would not answer.
///
/// Undated rather than dated `1980-01-01`: a reader with two archives in their Downloads folder
/// is served by a name that sorts, and one that lies about the day is worse than one that says
/// nothing. Nothing downstream parses this — it is a suggestion the save dialog and the
/// browser's download both start from and the reader may overwrite.
fn archive_name(date: &str) -> String {
    if date.is_empty() {
        format!("{ARCHIVE_STEM}.zip")
    } else {
        format!("{ARCHIVE_STEM}-{date}.zip")
    }
}

/// Build the archive on a **read-only connection of its own**, never `AppState.db_read`.
///
/// `index::lifecycle::build_now`'s rule, which `settings::rebuild_now` already
/// follows one function over and for the same reason: this renders four listings and up to ~350
/// files, and held on the shared read connection it would queue every search and every poll
/// behind it. Nothing in a backup may make a button answer `crate::db::BUSY`.
///
/// If the connection cannot be opened it falls back to the shared one rather than refusing — a
/// slow archive is better than a button that does nothing, and the reader asked for this
/// explicitly.
#[cfg(not(target_family = "wasm"))]
pub fn build_now(state: &crate::sync::AppState) -> Result<Archive, String> {
    let own = crate::db::open_read(&state.data_dir).ok();
    let shared = own.is_none().then(|| crate::sync::lock_db_read(state));
    let conn = own
        .as_ref()
        .or(shared.as_deref())
        .expect("one or the other");
    build(conn)
}

// ---------------------------------------------------------------------------------------
// The two commands
// ---------------------------------------------------------------------------------------

/// Build the archive and hand the page its bytes.
///
/// **The browser's door.** There is no filesystem a browser can write the way the mirror needs,
/// so the page turns this into a `Blob` and starts a download. Registered on the Tauri targets
/// as well, because the archive is the same archive and a command that exists on one target
/// only is a command no `cargo test` on this machine can reach.
///
/// `#[tauri::command(async)]` through `spawn_blocking`, like `settings::mirror_rebuild`:
/// this is four listings, ~350 renders and a deflate, and none of that belongs on the async
/// runtime's thread.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn mirror_backup_zip(
    state: tauri::State<'_, std::sync::Arc<crate::sync::AppState>>,
) -> Result<BackupZip, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || build_now(&state).map(|a| a.with_bytes()))
        .await
        .map_err(|e| format!("the backup archive could not be built: {e}"))?
}

/// Build the archive and write it where the reader said.
///
/// **Android's door, and the reason the bytes never cross the IPC boundary.** What
/// `tauri-plugin-dialog`'s save verb answers on Android is a `content://` URI naming a row
/// `ACTION_CREATE_DOCUMENT` has already created, not a path — `crate::picked::write_all` is
/// the one place in this crate that knows the difference, and `crate::export::export_write_file`
/// is the precedent this follows exactly. A megabyte of base64 handed to the page and handed
/// straight back would be two copies of the archive through a phone's IPC for nothing.
///
/// **No new permission and no new plugin.** `dialog:allow-save` has been in
/// `capabilities/mobile.json` since the export dialog shipped, and `tauri_plugin_fs::Fs::open`
/// is a Rust-side method on managed state that no `invoke` ever crosses. The page's filesystem
/// access is unchanged: none.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn mirror_backup_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Arc<crate::sync::AppState>>,
    path: String,
) -> Result<BackupZip, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let archive = build_now(&state)?;
        crate::picked::write_all(&app, &path, &archive.bytes)?;
        Ok(archive.without_bytes())
    })
    .await
    .map_err(|e| format!("the backup archive could not be written: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read as _;

    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    /// Read an archive back into (name, bytes) pairs, in the order it stores them.
    fn entries(bytes: &[u8]) -> Vec<(String, String)> {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec())).unwrap();
        (0..archive.len())
            .map(|i| {
                let mut file = archive.by_index(i).unwrap();
                let name = file.name().to_owned();
                let mut text = String::new();
                file.read_to_string(&mut text).unwrap();
                (name, text)
            })
            .collect()
    }

    /// **The claim the whole feature rests on**: what the archive holds is what the mirror
    /// would have written, path for path. A renderer of its own would be a third writer outside
    /// the golden fence, and this is what says the archive is not one.
    #[test]
    fn the_archive_holds_exactly_the_files_the_mirror_plans_plus_a_readme() {
        let conn = db();
        let decks = crate::deck::list_decks(&conn).unwrap();
        let deck_folders = crate::deck_meta::list_folders(&conn).unwrap();
        let collection_folders = crate::collection_folders::list_folders(&conn).unwrap();
        let wishlist_folders = crate::wishlist_folders::list_folders(&conn).unwrap();
        let plan = plan_files(&Shape {
            decks: &decks,
            deck_folders: &deck_folders,
            collection_folders: &collection_folders,
            wishlist_folders: &wishlist_folders,
        });

        let archive = build(&conn).unwrap();
        let mut got: Vec<String> = entries(&archive.bytes)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        let mut want: Vec<String> = plan
            .files
            .iter()
            .map(|f| f.path.clone())
            .chain(std::iter::once(README_NAME.to_owned()))
            .collect();
        got.sort();
        want.sort();
        assert_eq!(got, want);
        assert_eq!(archive.files, want.len());
        assert_eq!(archive.failed, 0);
    }

    /// The pruner's authority is a file about a *folder*, and a zip prunes nothing. One
    /// unpacked into the mirror's root would otherwise hand it a list from another moment.
    #[test]
    fn the_archive_carries_no_manifest() {
        let archive = build(&db()).unwrap();
        assert!(
            !entries(&archive.bytes)
                .iter()
                .any(|(name, _)| name == super::super::run::MANIFEST_NAME),
            "a snapshot has nothing to prune, so it records nothing to prune with"
        );
    }

    /// A database with nothing in it is a supported state — an empty list writes a zero-byte
    /// file in all seven formats, which is what the export dialog answers for one and therefore
    /// what the backup has to.
    #[test]
    fn an_empty_database_still_produces_a_readable_archive() {
        let archive = build(&db()).unwrap();
        let got = entries(&archive.bytes);
        assert!(got.len() > 1, "the collection and the wishlist are planned");
        let (_, readme) = got
            .iter()
            .find(|(name, _)| name == README_NAME)
            .expect("the README is always in it");
        assert_eq!(readme, SNAPSHOT_README);
    }

    /// The name is a suggestion the reader sees in a save dialog and in their downloads, so it
    /// has to sort — and it must not carry a day the clock never gave us.
    #[test]
    fn the_name_takes_the_databases_date_and_drops_it_rather_than_inventing_one() {
        assert_eq!(
            archive_name("2026-08-31"),
            "mtg-grimoire-backup-2026-08-31.zip"
        );
        assert_eq!(archive_name(""), "mtg-grimoire-backup.zip");
    }

    /// `strftime` is the clock because `SystemTime::now()` panics on wasm. This is what says
    /// the reading is a real date rather than the 1980 fallback — a query that silently stopped
    /// answering would leave every archive stamped at the zip epoch and named after nothing.
    #[test]
    fn the_stamp_comes_from_the_database_clock() {
        let got = stamp(&db());
        assert_eq!(got.date.len(), 10, "YYYY-MM-DD: {:?}", got.date);
        assert!(
            got.date.starts_with("20"),
            "a real year, not the zip epoch: {:?}",
            got.date
        );
        assert_ne!(
            got.when,
            zip::DateTime::default(),
            "the entry stamp is the database's moment, not 1980"
        );
    }

    /// Both doors describe the same archive; only the bytes differ. A `None` here is how the
    /// page knows Rust has already written the file.
    #[test]
    fn only_the_browsers_answer_carries_the_bytes() {
        let archive = build(&db()).unwrap();
        let web = archive.with_bytes();
        let native = archive.without_bytes();
        assert_eq!(web.byte_length, archive.bytes.len());
        assert_eq!(native.byte_length, archive.bytes.len());
        assert_eq!(web.file_name, native.file_name);
        assert_eq!(web.files, native.files);
        assert!(native.base64.is_none());
        // Standard base64, which is the alphabet `atob` takes — the URL-safe one
        // `sync_engine::wire` uses would decode to nothing in a browser.
        use base64::Engine as _;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(web.base64.expect("the browser gets the bytes"))
            .expect("it round-trips");
        assert_eq!(decoded, archive.bytes);
    }
}
