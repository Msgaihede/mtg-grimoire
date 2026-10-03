//! **The desktop's half of `import`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.
//!
//! [`read_import_file`] is here for a different reason, and for good: it reads a path the
//! desktop's own file dialog answered, and a host reads its own file.

pub use grimoire_core::import::*;

use crate::sync::{lock_db_read, AppState};
use std::sync::Arc;

/// Every name in a pasted decklist, resolved to a printing this app has. **Read-only.**
///
/// On the blocking pool against `db_read`, like every other read: a list of a few hundred names
/// is six prepared statements and a few hundred index lookups — 11.6 ms for a 105-line
/// commander list, measured over the live corpus — which is small but not free, and it must
/// never queue behind an ingest.
#[tauri::command]
pub async fn import_resolve(
    state: tauri::State<'_, Arc<AppState>>,
    lines: Vec<ResolveLine>,
) -> Result<Vec<ImportResolveRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || resolve_lines(&lock_db_read(&state), &lines))
        .await
        .map_err(|e| format!("the decklist could not be resolved: {e}"))?
}

/// A decklist into a deck: one transaction, one allocation, one or two history rows.
///
/// The **write** connection through [`crate::sync::with_write`], answering [`crate::db::BUSY`]
/// if it cannot be had.
#[tauri::command]
pub async fn deck_import_commit(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    variant: String,
    mode: String,
    items: Vec<ImportItem>,
) -> Result<ImportOutcome, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // **Plain `with_write`, and still plain now that a `live` replace writes
        // `collection_entries`.** The release moves rows *between folders* and folds some of
        // them away; `with_write_owned`'s whole extra step is the facet index's `owned`
        // dimension, which is folder-blind, so no card enters or leaves the reader's ownership
        // here and rebuilding it would read the collection to arrive at the answer it holds.
        // The argument in full is on `deck::release_live_copies`.
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        crate::sync::with_write(&state, |conn| {
            commit_import(conn, deck_id, &variant, &mode, &items)
        })
    })
    .await
    .map_err(|e| format!("the decklist could not be imported: {e}"))?
}

/// A decklist file the reader picked, as text.
///
/// **The path is the one [`import_pick_file`]'s dialog answered, and it never came from the
/// page.** Rust opening the file is why **no `fs:` permission is granted anywhere** — a webview
/// that read a file itself would need one — and since 2026-09-28 Rust opening the *dialog* is
/// why the page cannot name one either (issue #545): this used to be reachable as
/// `import_read_file(path)` with any path a script cared to send, which made it a read of any
/// text file up to 1 MB on the machine, handed straight back to the page.
///
/// Two decisions, and each is a thing that would be wrong the other way:
///
/// * **The size is bounded by how much is read, not by `metadata()`.** [`MAX_IMPORT_BYTES`] is a
///   fence rather than a truncation — a 200 MB file the reader pointed at by mistake costs one
///   megabyte to refuse rather than two hundred. It is the same constant the paste path uses, so
///   the two cannot disagree about how long a decklist may be.
/// * **The bytes are never refused and never decoded lossily** — see [`decode`], and
///   [`FileEncoding`] for which reading the page is told about. This used to be
///   `from_utf8_lossy`, on the argument that a Windows-1252 apostrophe should cost one line
///   rather than the whole file. The first half of that stands; the lossy half was wrong
///   (issue #555), because the file that carries one cp1252 byte is Excel's "CSV" on a Western
///   European Windows, and it carries **every** accented name in that code page — `Jötun Grunt`,
///   `Séance`, `Lim-Dûl's Vault` each turned into `U+FFFD` and each quoted back as unmatched,
///   while the byte that said which character it was sat one table lookup away.
fn read_import_file(path: &std::path::Path) -> Result<ImportFile, String> {
    std::fs::File::open(path)
        .map_err(|e| open_failed(format!("could not open {}: {e}", path.display())))
        .and_then(read_bounded)
}

/// What a source this app cannot open says, keeping the OS's own reason — `not found` and
/// `access denied` are different things for the reader to do something about, and dropping the
/// tail would make them the same message.
fn open_failed(e: String) -> String {
    format!("That file could not be opened — {e}")
}

/// Ask the reader for a decklist file — the OS open dialog, modal to the window that asked — and
/// hand its text to the parser. `None` is Cancel, which is not a failure.
///
/// **It takes no path, and that is the command's whole contract** (issue #545): the dialog is
/// opened here ([`crate::file_dialog`]) and what it answered goes to [`read_import_file`] without
/// crossing IPC, so the page can ask for *a* decklist and never for a particular file.
///
/// **Two failures, two sentences.** A dialog that could not be shown is
/// [`crate::file_dialog::did_not_open`]'s — "The file picker could not be opened — …" — and a
/// file that would not read is [`read_import_file`]'s: missing, refused, over the cap. The page
/// draws either under one frame that is true of both, and the sentence says which it was, so
/// "that file is over 1 MB" is never worded as a broken picker or the other way round.
///
/// **The one command in this module that takes no state**: it touches no database, so it needs
/// neither connection and cannot be refused as [`crate::db::BUSY`]. What comes back is
/// text, and everything after it — the lines, the quantities, the sections — is TypeScript's,
/// exactly as it is for a paste. That is the whole reason this is a *read* and not an import:
/// a file and a paste become the same string here and travel the same path afterwards.
///
/// The read is on the blocking pool like its two siblings, because a file on a network share or a
/// slow stick is a disk wait, and the async runtime is not where a disk wait belongs.
///
/// It answers the reading beside the text ([`ImportFile::encoding`]) so the dialog can say when
/// a file was not UTF-8 — which a bare string could never tell it. It answers **no file name**,
/// because nothing on the page draws one.
#[tauri::command]
pub async fn import_pick_file(window: tauri::WebviewWindow) -> Result<Option<ImportFile>, String> {
    let dialog = move || {
        crate::file_dialog::modal_to(&window)
            .set_title("Choose a decklist")
            .add_filter("Decklist", &DECKLIST_EXTENSIONS)
            .blocking_pick_file()
    };
    let Some(path) = crate::file_dialog::show(crate::file_dialog::FILE_PICKER, dialog).await?
    else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || read_import_file(&path))
        .await
        .map_err(|e| format!("the decklist file could not be read: {e}"))?
        .map(Some)
}

/// The tests of `import` that name something this crate still holds. Each goes home when what it
/// names does.
#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------------------------
    // read_import_file
    // ------------------------------------------------------------------------------------

    /// A file of this test's own, written and handed back with its path — under
    /// [`crate::scratch::path`], which keeps it apart from every other test and every other
    /// `cargo test` process on the machine.
    ///
    /// The caller cleans up with [`gone`]. A leaked file is a stale fixture the *next* run
    /// would read, which is the one failure mode worth spending two lines on.
    fn scratch(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = crate::scratch::path(&format!("import-{name}.txt"));
        let _ = std::fs::remove_file(&path);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    /// Undo [`scratch`]. Ignores a failure — the file is the test's, not the app's.
    fn gone(path: &std::path::Path) {
        let _ = std::fs::remove_file(path);
    }

    /// [`read_import_file`], which is everything [`import_pick_file`] does after the dialog —
    /// the dialog itself is a native window no test can press (see [`crate::file_dialog`]).
    fn read_file(path: &std::path::Path) -> Result<ImportFile, String> {
        read_import_file(path)
    }

    /// The cap is a **fence**, and the half worth pinning is that it costs a megabyte rather
    /// than the whole file.
    ///
    /// The bound is `take(MAX + 1)` and a length test: a 200 MB file the reader pointed at by
    /// mistake never reaches memory, because the reader stops one byte past the cap. The
    /// refusal does not quote the file's real size, because a bounded read never learns it.
    ///
    /// What this test can see is the message and the fact that no text came back; the bound
    /// itself is structural. Note the fixture is one byte over [`MAX_IMPORT_BYTES`] — the cap is
    /// `>`, so a file of exactly the cap is allowed and this file is the smallest one that is
    /// not.
    #[test]
    fn a_file_over_the_cap_is_refused_by_size_and_not_read() {
        let oversized = vec![b'x'; usize::try_from(MAX_IMPORT_BYTES).unwrap() + 1];
        let path = scratch("oversized", &oversized);

        let refused = read_file(&path).unwrap_err();

        assert!(refused.contains("at most 1 MB"), "{refused}");
        assert!(
            refused.contains("That file is over"),
            "it says the cap was passed, which is all a bounded read can know: {refused}"
        );
        gone(&path);
    }

    /// A file that is exactly the cap is read, because the fence is `>` and a boundary nobody
    /// asserts is a boundary that moves.
    #[test]
    fn a_file_at_exactly_the_cap_is_read() {
        let full = vec![b'x'; usize::try_from(MAX_IMPORT_BYTES).unwrap()];
        let path = scratch("at-the-cap", &full);

        let file = read_file(&path).expect("exactly the cap is under it");

        assert_eq!(u64::try_from(file.text.len()).unwrap(), MAX_IMPORT_BYTES);
        assert_eq!(file.encoding, FileEncoding::Utf8);
        gone(&path);
    }

    /// A path that names nothing is a sentence, not a panic and not an empty import.
    ///
    /// It is reachable in the shipped app despite the picker: the reader can delete or unmount
    /// the file between choosing it and the read, and a portable copy moved between machines
    /// carries no such file at all.
    #[test]
    fn a_missing_file_is_refused_in_words() {
        let path = crate::scratch::path("import-no-such-decklist.txt");
        let _ = std::fs::remove_file(&path);

        let refused = read_file(&path).unwrap_err();

        assert!(
            refused.starts_with("That file could not be opened"),
            "{refused}"
        );
        assert!(
            refused.len() > "That file could not be opened — ".len(),
            "the OS's own reason is kept, because `not found` and `access denied` are \
             different things for the reader to do something about: {refused}"
        );
    }

    /// **The file the lossy read used to damage.** A decklist exported by a Windows tool that
    /// never left code page 1252 carries `0x92` where a curly apostrophe belongs and `0xF6` where
    /// `ö` does, and neither is valid UTF-8. The lossy read turned both into `U+FFFD` and every
    /// such line into an unmatched name (issue #555); this reads them as the characters they are.
    ///
    /// 105 lines through the real file path, so the cap, the read and [`decode`] are one test:
    /// nothing is lost, the 103 plain lines are untouched, and the two that carried a cp1252 byte
    /// come back as the names a reader would have typed.
    #[test]
    fn a_file_that_is_not_utf8_is_read_as_windows_1252() {
        let mut bytes = Vec::new();
        for _ in 0..103 {
            bytes.extend_from_slice(b"1 Sol Ring\n");
        }
        bytes.extend_from_slice(b"1 Yawgmoth\x92s Will\n");
        bytes.extend_from_slice(b"1 J\xF6tun Grunt\n");
        let path = scratch("cp1252", &bytes);

        let file = read_file(&path).expect("a legacy code page is not a failed import");

        assert_eq!(file.encoding, FileEncoding::Windows1252);
        assert_eq!(file.text.lines().count(), 105, "no line was lost");
        assert_eq!(file.text.matches("1 Sol Ring").count(), 103);
        let tail: Vec<&str> = file.text.lines().skip(103).collect();
        assert_eq!(tail, ["1 Yawgmoth\u{2019}s Will", "1 Jötun Grunt"]);
        assert!(!file.text.contains('\u{FFFD}'), "nothing was replaced");
        gone(&path);
    }

    /// A UTF-16 file through the same path — what Windows' "Unicode" save writes — so the mark
    /// is read off the real bytes on disk and not only off a slice in a unit test.
    #[test]
    fn a_utf16_file_is_read_through_the_command_path() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "4 Æther Vial\r\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let path = scratch("utf16", &bytes);

        let file = read_file(&path).expect("a byte-order mark is an answer, not a failure");

        assert_eq!(file.encoding, FileEncoding::Utf16Le);
        assert_eq!(file.text, "4 Æther Vial\r\n");
        gone(&path);
    }
}
