//! Saving an export where the reader chooses — the save dialog and the write, both in Rust.
//!
//! **Why Rust writes it rather than the page.** Writing bytes from the webview would need an
//! `fs:` permission, and this app grants none anywhere on purpose — `tauri-plugin-fs` is in
//! `Cargo.lock` transitively and is unreachable because the ACL would deny it.
//!
//! **Why Rust opens the dialog too, which it did not until 2026-09-28** (issue #545). This used
//! to be `export_write_file(path, contents)`, taking the path the page's `save()` had answered,
//! and its doc said there was "no path fence here and none is owed" because the reader had
//! picked the path a moment earlier. That trusted the page to have asked: any script in the
//! webview could call the command with any path and any text, which is a write-anywhere with the
//! reader's own permissions. So [`export_save_file`] shows the save dialog itself
//! ([`crate::file_dialog`]), and the path the OS answered goes to [`write_export`] without the
//! page ever seeing it. The page sends the text and a *suggested* name, and hears back whether a
//! file was written.

use crate::file_dialog;
use std::path::Path;

/// The name the save dialog opens with: the last component of what the page suggested, or
/// `None` for nothing usable.
///
/// **The page may suggest a name and never a place.** `ExportDialog` sends `Ramp.txt`; a page
/// that sent `..\..\Startup\x.bat` would, through the dialog's file-name box, be choosing the
/// folder the dialog opens in — so everything up to the last separator goes, both separators on
/// every platform, because the name is a Windows name wherever this is compiled. The reader still
/// confirms or changes it in a window the page cannot drive, so this is not the fence; it keeps
/// the one string the page still sends from carrying a path into that window at all.
pub fn suggested_name(raw: &str) -> Option<&str> {
    let name = raw.rsplit(['/', '\\']).next().unwrap_or(raw).trim();
    (!name.is_empty() && name != "." && name != "..").then_some(name)
}

/// Ask the reader where to save `contents` — the OS save dialog, opened with `file_name` — and
/// write it there. Answers whether a file was written: `false` is Cancel, which is not a failure.
///
/// **Two failures, two sentences**: a dialog that could not be shown is
/// [`file_dialog::did_not_open`]'s, and a disk that refused the write is [`write_export`]'s. The
/// page frames either one as "Could not save that export", which is true of both.
///
/// The write is on the blocking pool — a path on a network share or a slow stick is a disk wait,
/// and the async runtime is not where a disk wait belongs. This command takes no `AppState` at
/// all: it touches no database, so it needs no connection and cannot be refused as
/// [`crate::db::BUSY`].
#[tauri::command]
pub async fn export_save_file(
    window: tauri::WebviewWindow,
    file_name: String,
    contents: String,
) -> Result<bool, String> {
    let dialog = move || {
        let dialog = file_dialog::modal_to(&window);
        match suggested_name(&file_name) {
            Some(name) => dialog.set_file_name(name),
            None => dialog,
        }
        .blocking_save_file()
    };
    let Some(path) = file_dialog::show(file_dialog::SAVE_DIALOG, dialog).await? else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || write_export(&path, &contents))
        .await
        .map_err(|e| format!("the export could not be written: {e}"))??;
    Ok(true)
}

/// Write `contents` at `path`, replacing whatever was there.
///
/// Truncating rather than appending: the reader picked this name in a save dialog that had
/// already asked them about overwriting. The refusal names the path because it is the half of
/// the failure the reader chose — a folder that has since gone needs to be recognisable.
fn write_export(path: &Path, contents: &str) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| format!("could not write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_writes_the_text_it_was_given() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deck.txt");
        write_export(&path, "1 Lightning Bolt\n2 Shock\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "1 Lightning Bolt\n2 Shock\n"
        );
    }

    #[test]
    fn it_overwrites_rather_than_appending() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deck.txt");
        write_export(&path, "old").unwrap();
        write_export(&path, "new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    }

    #[test]
    fn a_path_in_a_directory_that_does_not_exist_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nope").join("deck.txt");
        let refused = write_export(&path, "x").unwrap_err();
        assert!(refused.starts_with("could not write "), "{refused}");
        assert!(refused.contains("deck.txt"), "names the file: {refused}");
    }

    /// The ordinary suggestion goes through untouched — the name `ExportDialog` builds from the
    /// deck and the format's extension.
    #[test]
    fn a_plain_file_name_is_suggested_as_it_is() {
        assert_eq!(suggested_name("Ramp.txt"), Some("Ramp.txt"));
        assert_eq!(
            suggested_name("Krenko, Mob Boss.csv"),
            Some("Krenko, Mob Boss.csv")
        );
    }

    /// **The page names a file and never a folder.** Whatever it puts before a separator — either
    /// separator, on every platform — is dropped before the dialog sees it, so the dialog opens
    /// where the OS would have opened it anyway.
    #[test]
    fn a_suggestion_carrying_a_path_keeps_only_its_last_component() {
        assert_eq!(suggested_name("..\\..\\Startup\\x.bat"), Some("x.bat"));
        assert_eq!(suggested_name("C:\\Users\\x\\deck.txt"), Some("deck.txt"));
        assert_eq!(suggested_name("/etc/cron.d/deck.txt"), Some("deck.txt"));
        assert_eq!(suggested_name("a/b\\c.txt"), Some("c.txt"));
    }

    /// Nothing usable is no suggestion at all, rather than a dialog opening on `..`.
    #[test]
    fn an_empty_or_dotted_suggestion_is_none() {
        for junk in ["", "  ", ".", "..", "decks/", "..\\..", "C:\\"] {
            assert_eq!(suggested_name(junk), None, "{junk:?}");
        }
    }
}
