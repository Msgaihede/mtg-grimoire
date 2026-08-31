//! Opening the file the reader picked, which is not the same kind of thing on every platform.
//!
//! On desktop a picked file is a **path**, and `std::fs` opens it. On Android it is a
//! **`content://` URI**: `tauri-plugin-dialog`'s `DialogPlugin.kt` fires
//! `ACTION_GET_CONTENT`/`ACTION_CREATE_DOCUMENT` and returns `uri.toString()`, which names a
//! row in a ContentProvider rather than anything on a filesystem. `std::fs::read` of one
//! answers `No such file or directory`, which reads exactly like the reader picked a file that
//! vanished.
//!
//! **The two commands behind the two pickers both funnel here** —
//! [`crate::import::import_read_file`] and [`crate::export::export_write_file`] — so there is
//! one place that knows the difference and two that do not. There was a third,
//! `deck_set_cover_image`, until custom deck covers were removed on 2026-08-31; a cover is now
//! a card id, so nothing about it reaches a file picker at all.
//!
//! **No `fs:` permission is granted anywhere and none is needed.** Tauri's ACL gates commands
//! the *webview* invokes; [`tauri_plugin_fs::Fs::open`] is a Rust-side method on a managed
//! handle, and no `invoke` crosses the boundary. The page still cannot touch a byte of the
//! filesystem, and Rust opens exactly the one URI the reader chose in the OS's own picker a
//! moment earlier. That is this app's standing habit, written down in `src-tauri/CLAUDE.md`: a
//! dialog verb answers a name, and a name is not permission.
//!
//! **Both branches answer a [`std::fs::File`]**, which is why nothing downstream changes.
//! `tauri_plugin_fs::Fs::open` asks the Kotlin side for a file descriptor through the
//! ContentResolver and builds a `File` from the raw fd (`tauri-plugin-fs-2.5.1/src/android.rs`),
//! so the reader that comes back is `Read` **and `Seek`**. Nothing left here needs the second
//! half — both survivors read a decklist straight through — but the cover encoder did, on a
//! header pass of its own before decoding, and it is a property of the descriptor rather than
//! of who happens to be reading it.

/// The scheme every Android document-provider URI carries.
const CONTENT: &str = "content://";

/// Whether this string is an Android document-provider URI rather than a path.
///
/// A `file://` URI is deliberately **not** one: the desktop picker can answer one, and the
/// plain-path branch already carries the error messages this app writes for a file it cannot
/// read. Matching only `content:` keeps the resolver path to the one platform that needs it.
///
/// Case-insensitive, because a URI scheme is, and nothing promises a provider lower-cases it.
///
/// The length test is `>` rather than `>=`: `content://` with nothing after it names no
/// document, and handing a bare scheme to the ContentResolver would answer something about a
/// provider the reader never chose.
pub fn is_content_uri(s: &str) -> bool {
    s.len() > CONTENT.len() && s[..CONTENT.len()].eq_ignore_ascii_case(CONTENT)
}

/// Open the picked file for reading.
///
/// Answers a concrete [`std::fs::File`] rather than a boxed reader, on both platforms, because
/// two of the three callers need more than `Read`: `images` seeks back to the start for its
/// second header pass, and a `Box<dyn Read>` cannot. On Android the underlying file descriptor
/// came from the ContentResolver, so `Read` and `Seek` behave identically to a local file.
pub fn open_read(
    #[allow(unused_variables)] app: &tauri::AppHandle,
    picked: &str,
) -> Result<std::fs::File, String> {
    #[cfg(target_os = "android")]
    if is_content_uri(picked) {
        return open_content_uri(app, picked, tauri_plugin_fs::OpenOptions::new().read(true));
    }

    open_path(picked)
}

/// The plain open, with no handle and no platform question.
///
/// Split out for [`write_bytes`]'s reason: the import tests assert what a read does and what a
/// missing file says, and a `tauri::AppHandle` cannot be built without the `tauri::test`
/// feature this crate does not enable.
pub fn open_path(path: &str) -> Result<std::fs::File, String> {
    std::fs::File::open(path).map_err(|e| format!("could not open {path}: {e}"))
}

/// Write `bytes` at the picked destination, replacing whatever was there.
///
/// Truncating rather than appending, exactly as [`crate::export::export_write_file`] was: the
/// reader picked this name in a save dialog that had already asked them about overwriting. On
/// Android `ACTION_CREATE_DOCUMENT` has already created the row, so this writes into a
/// descriptor the provider opened in truncate mode — `OpenOptions::android_mode` turns
/// `write` + `truncate` into the `"wt"` the Kotlin side is given.
pub fn write_all(
    #[allow(unused_variables)] app: &tauri::AppHandle,
    picked: &str,
    bytes: &[u8],
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    if is_content_uri(picked) {
        use std::io::Write as _;
        let mut file = open_content_uri(
            app,
            picked,
            tauri_plugin_fs::OpenOptions::new()
                .write(true)
                .truncate(true),
        )?;
        return file
            .write_all(bytes)
            .map_err(|e| format!("could not write {picked}: {e}"));
    }

    write_bytes(picked, bytes)
}

/// The plain write, with no handle and no platform question.
///
/// Split out so the export tests can assert what a write does without building a mock app —
/// this crate enables no `tauri::test` feature and nothing in it has ever used `mock_app`.
pub fn write_bytes(path: &str, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|e| format!("could not write {path}: {e}"))
}

/// Resolve a `content://` URI through the ContentResolver and hand back the descriptor.
///
/// One function for both directions because the only difference is the [`OpenOptions`], and
/// the two error paths — the plugin not being registered, and the provider refusing — read the
/// same either way.
///
/// [`OpenOptions`]: tauri_plugin_fs::OpenOptions
#[cfg(target_os = "android")]
fn open_content_uri(
    app: &tauri::AppHandle,
    picked: &str,
    opts: &mut tauri_plugin_fs::OpenOptions,
) -> Result<std::fs::File, String> {
    use std::str::FromStr as _;
    use tauri::Manager as _;

    let fs = app
        .try_state::<tauri_plugin_fs::Fs<tauri::Wry>>()
        .ok_or_else(|| "the file plugin is not ready".to_owned())?;
    // `FilePath: FromStr` has `Err = Infallible` and already makes exactly the decision this
    // module does — a scheme longer than one character is a URL, and a one-character scheme is
    // a Windows drive letter. So no `url` dependency is needed here.
    let path =
        tauri_plugin_fs::FilePath::from_str(picked).expect("FilePath::from_str is infallible");
    fs.open(path, opts.clone())
        .map_err(|e| format!("could not open {picked}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The desktop shape. A path is a path and nothing is resolved.
    #[test]
    fn a_plain_path_is_not_a_content_uri() {
        assert!(!is_content_uri("C:\\Users\\m\\deck.txt"));
        assert!(!is_content_uri("/home/m/deck.txt"));
        assert!(!is_content_uri("/storage/emulated/0/Download/deck.txt"));
    }

    /// What Android's document picker actually answers, verbatim from a real intent result.
    #[test]
    fn the_document_pickers_answer_is_a_content_uri() {
        assert!(is_content_uri(
            "content://com.android.providers.downloads.documents/document/msf%3A1000000042"
        ));
        assert!(is_content_uri("content://media/external/images/media/1234"));
    }

    /// Case, because a scheme is case-insensitive and nothing guarantees the provider
    /// lower-cases it. A miss here is a file the app refuses to open with "No such file".
    #[test]
    fn the_scheme_is_matched_case_insensitively() {
        assert!(is_content_uri("CONTENT://media/external/images/media/1"));
        assert!(is_content_uri("Content://x/y"));
    }

    /// A `file://` URI is NOT a content URI and must not be routed through the resolver — the
    /// desktop picker can answer one, and `Fs::open` would take it too, but the plain path
    /// branch is the one with the error messages this app already writes.
    #[test]
    fn a_file_uri_is_not_a_content_uri() {
        assert!(!is_content_uri("file:///home/m/deck.txt"));
    }

    /// The empty string and a bare word are paths, not URIs. A permissive prefix test that
    /// answered `true` for `"content"` would send a filename to the ContentResolver.
    #[test]
    fn a_bare_word_is_a_path() {
        assert!(!is_content_uri(""));
        assert!(!is_content_uri("content"));
        assert!(!is_content_uri("contents.txt"));
    }

    /// `content://` with nothing after it names no document. It is not a path either, but the
    /// plain branch is where a nonsense string belongs: `std::fs` refuses it with an error
    /// mentioning the string, where the ContentResolver would answer something about a
    /// provider the reader never heard of.
    #[test]
    fn a_bare_scheme_with_no_document_is_not_a_content_uri() {
        assert!(!is_content_uri("content://"));
    }

    /// The desktop write, which is what the three export tests exercise and what
    /// [`write_all`] falls through to everywhere but Android.
    #[test]
    fn write_bytes_truncates_rather_than_appending() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deck.txt");
        let name = path.to_str().unwrap();
        write_bytes(name, b"the first export").unwrap();
        write_bytes(name, b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    }
}
