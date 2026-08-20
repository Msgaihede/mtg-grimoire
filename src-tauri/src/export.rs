//! Writing an export to a file the reader named.
//!
//! **Why Rust writes it rather than the page.** `dialog:allow-save` answers a *path* and
//! nothing more; writing bytes at that path from the webview would need an `fs:` permission,
//! and this app grants none anywhere on purpose — `tauri-plugin-fs` is in `Cargo.lock`
//! transitively and is unreachable because the ACL would deny it. `deck_set_cover_image`
//! established the pattern in the other direction: the page asks for a name and Rust opens
//! the file, so no filesystem permission of any kind is needed.
//!
//! There is no path fence here and none is owed. The path is one the reader picked in the
//! OS's own save dialog a moment earlier — the same trust `deck_set_cover_image` places in
//! the open dialog's answer — and a fence would only ever refuse a directory they chose.

/// Write `contents` at `path`, replacing whatever was there.
///
/// Truncating rather than appending: the reader picked this name in a save dialog that had
/// already asked them about overwriting.
///
/// On the blocking pool, like [`crate::import::import_read_file`] — a path on a
/// network share or a slow stick is a disk wait, and the async runtime is not where a disk
/// wait belongs. This command takes no `AppState` at all: it touches no database, so it
/// needs no connection and cannot be refused as [`crate::db::BUSY`].
#[tauri::command]
pub async fn export_write_file(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_export(&path, &contents))
        .await
        .map_err(|e| format!("the export could not be written: {e}"))?
}

fn write_export(path: &str, contents: &str) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| format!("could not write {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_writes_the_text_it_was_given() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deck.txt");
        write_export(path.to_str().unwrap(), "1 Lightning Bolt\n2 Shock\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "1 Lightning Bolt\n2 Shock\n"
        );
    }

    #[test]
    fn it_overwrites_rather_than_appending() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deck.txt");
        write_export(path.to_str().unwrap(), "old").unwrap();
        write_export(path.to_str().unwrap(), "new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    }

    #[test]
    fn a_path_in_a_directory_that_does_not_exist_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nope").join("deck.txt");
        assert!(write_export(path.to_str().unwrap(), "x").is_err());
    }
}
