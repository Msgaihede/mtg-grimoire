//! Writing an export to a file the reader named.
//!
//! **Why Rust writes it rather than the page.** `dialog:allow-save` answers a *path* and
//! nothing more; writing bytes at that path from the webview would need an `fs:` permission,
//! and this app grants none anywhere on purpose — `tauri-plugin-fs` is in `Cargo.lock`
//! transitively and is unreachable because the ACL would deny it. `deck_set_cover_image`
//! established the pattern in the other direction — the page asks for a name and Rust opens
//! the file, so no filesystem permission of any kind is needed — and it is named here as
//! history rather than as a sibling: it went with custom deck covers on 2026-08-31, leaving
//! this and [`crate::import::import_read_file`] as the two commands still standing on it.
//!
//! There is no path fence here and none is owed. The path is one the reader picked in the
//! OS's own save dialog a moment earlier — the same trust the import places in the open
//! dialog's answer — and a fence would only ever refuse a directory they chose.

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
pub async fn export_write_file(
    app: tauri::AppHandle,
    path: String,
    contents: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_export(&app, &path, &contents))
        .await
        .map_err(|e| format!("the export could not be written: {e}"))?
}

/// The write itself, which on Android is not a write to a path at all.
///
/// `crate::picked::write_all` is the one place that knows the difference: what the save dialog
/// answered there is a `content://` URI naming a row `ACTION_CREATE_DOCUMENT` has already
/// created, and `std::fs::write` of one fails with `No such file or directory`. The three tests
/// below exercise `crate::picked::write_bytes`, which is that function's desktop half — a
/// `tauri::AppHandle` cannot be built without the `tauri::test` feature, which this crate does
/// not enable, and the assertions are about what a write does rather than about the handle.
fn write_export(app: &tauri::AppHandle, path: &str, contents: &str) -> Result<(), String> {
    crate::picked::write_all(app, path, contents.as_bytes())
}

#[cfg(test)]
mod tests {
    // `super::*` is deliberately not imported: `write_export` needs an `AppHandle` and
    // these three assert what the write does, which is `crate::picked::write_bytes` —
    // that function's desktop half and the one `write_all` falls through to everywhere
    // but Android.

    #[test]
    fn it_writes_the_text_it_was_given() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deck.txt");
        crate::picked::write_bytes(path.to_str().unwrap(), b"1 Lightning Bolt\n2 Shock\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "1 Lightning Bolt\n2 Shock\n"
        );
    }

    #[test]
    fn it_overwrites_rather_than_appending() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deck.txt");
        crate::picked::write_bytes(path.to_str().unwrap(), b"old").unwrap();
        crate::picked::write_bytes(path.to_str().unwrap(), b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    }

    #[test]
    fn a_path_in_a_directory_that_does_not_exist_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nope").join("deck.txt");
        assert!(crate::picked::write_bytes(path.to_str().unwrap(), b"x").is_err());
    }
}
