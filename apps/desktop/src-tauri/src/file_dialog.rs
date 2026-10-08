//! **Every file dialog this app shows is opened by Rust, and no path crosses IPC in either
//! direction** (issue #545).
//!
//! **Why, in one sentence: a command that takes a path from the page is a command the page can
//! aim anywhere.** Until 2026-09-28 the page asked `@tauri-apps/plugin-dialog` for a path and
//! handed it to a command that read or wrote there — `import_read_file(path)`,
//! `export_write_file(path, contents)`, `mirror_set_root(root)` — on the argument that the narrow
//! `dialog:allow-open` and `dialog:allow-save` grants were the fence. They were not. A capability
//! decides which *plugin commands* the webview may call; it has no say over the arguments an
//! app's own `#[tauri::command]` accepts, and those are always callable. So any script running
//! in the page could skip the dialog entirely and name `~/.ssh/id_ed25519` to the reader (any
//! text file up to 1 MB, handed straight back) or any path at all to the writer. The "picked in
//! the OS's own dialog a moment earlier" that every one of those commands trusted was a promise
//! the page made, not one anything checked.
//!
//! **So each command opens its own dialog, here, and the path the OS answered goes to the read or
//! the write without ever reaching the page.** The page asks for a *gesture* — let the reader
//! choose a decklist, save this text, move the mirror — and hears back what the gesture came to:
//! the text, whether a file was written, whether the folder moved. Nothing it sends names a place
//! on disk. The one thing it still sends is `export_save_file`'s *suggested* file name, which
//! [`crate::export::suggested_name`] cuts to its last component before the dialog sees it, and
//! which the reader confirms or changes in a window the page cannot drive.
//!
//! **The webview is granted no `dialog:` permission at all**, which is the other half of the same
//! decision: nothing in `src/` calls the plugin, so a grant would only be a way for a script to
//! summon a native window over the app. `tauri_plugin_dialog::init()` stays registered in
//! `desktop.rs` because it is what [`DialogExt`] reaches — the plugin's Rust half is the whole of
//! what is used.
//!
//! ⚠️ **The rule for the next file command: it takes the calling `WebviewWindow` and opens its own
//! dialog through [`modal_to`] and [`show`]. It never takes a path argument from the page.** A
//! command that needs to reach a place the reader chose once and the app remembers — the mirror's
//! root is the one there is — reads it back from where Rust stored it, never from the page.
//!
//! **The dialog itself cannot be unit-tested**: it is a native window, and a test has no reader
//! to press Save. What is tested is everything either side of it — [`show`] over a stand-in for
//! the dialog (a chosen path, Cancel, a URL that names no file, a dialog that panicked), and each
//! command's own read or write over a real temp file.

use std::path::PathBuf;
use tauri::{Runtime, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, FilePath};

/// The open dialog, as its failure names it. See [`did_not_open`].
pub const FILE_PICKER: &str = "file picker";
/// The folder picker, as its failure names it.
pub const FOLDER_PICKER: &str = "folder picker";
/// The save dialog, as its failure names it.
pub const SAVE_DIALOG: &str = "save dialog";

/// A file dialog **modal to the window that asked for it** — the app opens as many windows as
/// the reader asks for, and a dialog parented to `main` would come up over the wrong one.
///
/// Parented on Windows and macOS only, which is the plugin's own `open` command's rule
/// (`tauri-plugin-dialog-2.7.2/src/commands.rs`); its `save` also parents on Linux, and this
/// takes the narrower of the two for all three dialogs rather than keeping two rules for a
/// platform nobody has run a build on. `cfg!` rather than `#[cfg]` so both arms compile on the
/// Linux CI leg.
pub fn modal_to<R: Runtime>(window: &WebviewWindow<R>) -> FileDialogBuilder<R> {
    let dialog = window.dialog().file();
    if cfg!(any(windows, target_os = "macos")) {
        dialog.set_parent(window)
    } else {
        dialog
    }
}

/// What a dialog that could not be shown says, **naming the dialog** — so that it can never be
/// read as the file behind it having failed. "That file could not be opened" is
/// `import.rs`'s sentence about the *file*; this is the other one, and keeping them two
/// sentences is the whole reason `packages/ui/features/transfer/files.ts` used to keep picking and
/// reading two calls.
pub fn did_not_open(what: &str, e: impl std::fmt::Display) -> String {
    format!("The {what} could not be opened — {e}")
}

/// Run `dialog` on the blocking pool and answer the path the reader chose, or `None` for Cancel.
///
/// **On the blocking pool because the plugin's `blocking_*` calls must not run on the main thread**
/// — each posts the dialog to the event loop and then waits on a channel for the answer, and the
/// main thread waiting on itself is a deadlock. A tokio worker would not deadlock, but it would be
/// parked for as long as the reader looks at the dialog, which is not what the async runtime is
/// for. `dialog` is a closure rather than a builder so that a caller can do a little blocking work
/// of its own first — the mirror reads its current root to open the picker there.
///
/// **Two ways to fail, and both are the dialog's rather than the file's.** A dialog the event loop
/// never ran — the window closing under it, the app shutting down — drops the plugin's channel,
/// and its `blocking_fn!` answers that with a panic (`rx.recv().unwrap()`), which arrives here as
/// a join error. And a [`FilePath::Url`] that names no local file cannot be read or written by
/// `std::fs`; a desktop dialog only ever answers [`FilePath::Path`], so that arm is the plugin's
/// type being honest about mobile rather than a case this app meets.
pub async fn show(
    what: &'static str,
    dialog: impl FnOnce() -> Option<FilePath> + Send + 'static,
) -> Result<Option<PathBuf>, String> {
    tauri::async_runtime::spawn_blocking(dialog)
        .await
        .map_err(|e| did_not_open(what, e))?
        .map(|chosen| chosen.into_path().map_err(|e| did_not_open(what, e)))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(
        dialog: impl FnOnce() -> Option<FilePath> + Send + 'static,
    ) -> Result<Option<PathBuf>, String> {
        tauri::async_runtime::block_on(show(FILE_PICKER, dialog))
    }

    /// The ordinary answer, passed through as the path the reader chose and nothing else.
    #[test]
    fn a_chosen_path_is_answered_as_itself() {
        let chosen = crate::scratch::path("dialog-chosen.txt");
        let answer = chosen.clone();
        assert_eq!(
            run(move || Some(FilePath::Path(answer))).unwrap(),
            Some(chosen)
        );
    }

    /// **Cancel is not a failure** — it is the most ordinary way to use a file dialog after
    /// changing your mind, and every caller turns it into "nothing happened" rather than a
    /// sentence.
    #[test]
    fn cancel_is_none_and_not_an_error() {
        assert_eq!(run(|| None).unwrap(), None);
    }

    /// A `file://` URL is a path by another name, and is answered as one.
    #[test]
    fn a_file_url_is_answered_as_its_path() {
        let chosen = crate::scratch::path("dialog-url.txt");
        let url = tauri::Url::from_file_path(&chosen).unwrap();
        assert_eq!(run(move || Some(FilePath::Url(url))).unwrap(), Some(chosen));
    }

    /// A URL that names no local file is refused **as the picker's failure**, not as a read that
    /// went wrong — nothing was ever read.
    #[test]
    fn a_url_that_is_no_file_is_the_picker_s_failure() {
        let url = tauri::Url::parse("https://example.com/list.txt").unwrap();
        let refused = run(move || Some(FilePath::Url(url))).unwrap_err();
        assert!(
            refused.starts_with("The file picker could not be opened — "),
            "{refused}"
        );
    }

    /// **The case the plugin answers with a panic.** `blocking_fn!` unwraps a channel whose
    /// sender the event loop dropped, so a dialog that was never shown arrives as a join error —
    /// and it has to read as the dialog's failure, in words, rather than take the command down.
    #[test]
    fn a_dialog_that_panicked_is_the_picker_s_failure_in_words() {
        let refused = run(|| panic!("the event loop is gone")).unwrap_err();
        assert!(
            refused.starts_with("The file picker could not be opened — "),
            "{refused}"
        );
    }
}
