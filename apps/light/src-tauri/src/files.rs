//! **A file in and a file out, on a host whose files are documents** — the light app's phase 4,
//! step 4.3.
//!
//! The light host answers the desktop's own two file commands, by the desktop's names and with
//! its arguments, so the page asks the same question on both: `export_save_file(fileName,
//! contents) -> bool` and `import_pick_file() -> ImportFile | null`. The desktop opens a native
//! dialog and reads or writes a path; here the dialog plugin opens the system's — on Android the
//! Storage Access Framework, which answers a `content://` URI — and the fs plugin opens that URI.
//! **No path and no URI crosses to the page in either direction**, which is the desktop's rule
//! (issue #545): the page sends text and a suggested name, and hears back whether a file was
//! written, or the text of the one it picked.
//!
//! The phone face reaches `export_save_file` through `packages/ui/lib/core/files.ts` and picks a file with
//! an `<input type="file">`, which wry's WebView chrome client already answers with the system
//! picker — so `import_pick_file` is the desktop face's, drawn on a tablet past 1024px.

use grimoire_core::import::{read_bounded, suggested_name, ImportFile, DECKLIST_EXTENSIONS};
use serde::Deserialize;
use serde_json::Value;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

/// The command names this module answers, the desktop's.
pub const SAVE: &str = "export_save_file";
pub const PICK: &str = "import_pick_file";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveArgs {
    file_name: String,
    contents: String,
}

/// Whether `name` is one of the two commands this module answers.
pub fn answers(name: &str) -> bool {
    name == SAVE || name == PICK
}

/// Answer one of the two file commands — [`answers`] said it is one.
pub async fn answer(
    app: &tauri::AppHandle,
    name: &str,
    args: Option<Value>,
) -> Result<Value, String> {
    if name == SAVE {
        save(app, args).await
    } else {
        pick(app).await
    }
}

async fn save(app: &tauri::AppHandle, args: Option<Value>) -> Result<Value, String> {
    let SaveArgs {
        file_name,
        contents,
    } = serde_json::from_value(args.unwrap_or(Value::Null))
        .map_err(|e| format!("{SAVE}: its arguments did not parse: {e}"))?;
    let mut dialog = app.dialog().file();
    if let Some(name) = suggested_name(&file_name) {
        dialog = dialog.set_file_name(name);
    }
    let (tx, rx) = tauri::async_runtime::channel(1);
    dialog.save_file(move |path| {
        let _ = tx.try_send(path);
    });
    let Some(path) = receive(rx).await? else {
        return Ok(Value::Bool(false));
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || write(&app, path, contents.as_bytes()))
        .await
        .map_err(|e| format!("the export could not be written: {e}"))??;
    Ok(Value::Bool(true))
}

async fn pick(app: &tauri::AppHandle) -> Result<Value, String> {
    let (tx, rx) = tauri::async_runtime::channel(1);
    let mut dialog = app.dialog().file().set_title("Choose a decklist");
    // **No filter on a phone.** Android's picker filters by MIME type, and the dialog plugin maps
    // each extension through `MimeTypeMap`, dropping the ones it does not know — `.dec` and
    // `.dek` among them — so a filter there greys out half of what a decklist is saved as. The
    // decode and the parser are the fence; the filter was only ever a hint.
    if !cfg!(mobile) {
        dialog = dialog.add_filter("Decklist", &DECKLIST_EXTENSIONS);
    }
    dialog.pick_file(move |path| {
        let _ = tx.try_send(path);
    });
    let Some(path) = receive(rx).await? else {
        return Ok(Value::Null);
    };
    let app = app.clone();
    let file: ImportFile = tauri::async_runtime::spawn_blocking(move || read(&app, path))
        .await
        .map_err(|e| format!("the decklist file could not be read: {e}"))??;
    serde_json::to_value(file).map_err(|e| e.to_string())
}

/// The dialog's one answer — `None` is Cancel. A dialog that closed without answering at all is
/// the plugin's failure, said so.
async fn receive(
    mut rx: tauri::async_runtime::Receiver<Option<FilePath>>,
) -> Result<Option<FilePath>, String> {
    rx.recv()
        .await
        .ok_or_else(|| "the file dialog closed without an answer".to_owned())
}

fn write(app: &tauri::AppHandle, path: FilePath, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write as _;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    let mut file = app
        .fs()
        .open(path, options)
        .map_err(|e| format!("could not open the file to write: {e}"))?;
    file.write_all(bytes)
        .map_err(|e| format!("could not write the file: {e}"))
}

fn read(app: &tauri::AppHandle, path: FilePath) -> Result<ImportFile, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    let file = app
        .fs()
        .open(path, options)
        .map_err(|e| format!("That file could not be opened — {e}"))?;
    read_bounded(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The desktop's names exactly: the page calls `export_save_file` on both hosts.
    #[test]
    fn it_answers_the_desktop_s_two_file_commands_and_nothing_else() {
        assert!(answers("export_save_file"));
        assert!(answers("import_pick_file"));
        assert!(!answers("export_write_file"));
        assert!(!answers("deck_list"));
    }

    /// The save's arguments are the desktop wrapper's, camelCase on the wire.
    #[test]
    fn the_save_reads_the_desktop_s_arguments() {
        let args: SaveArgs = serde_json::from_value(serde_json::json!({
            "fileName": "Ramp.txt",
            "contents": "1 Llanowar Elves\n",
        }))
        .unwrap();
        assert_eq!(args.file_name, "Ramp.txt");
        assert_eq!(args.contents, "1 Llanowar Elves\n");
    }
}
