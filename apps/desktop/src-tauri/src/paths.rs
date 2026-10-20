use std::fs;
use std::path::{Path, PathBuf};

use crate::db::{LEGACY_DB, USER_DB};

/// Which directory this build stores its database in, given what the process knows about
/// itself: beside the executable when that is writable, the per-user folder otherwise — or a
/// refusal, when the folder beside the executable already holds a collection it cannot write
/// to (see [`resolve_data_dir`]). The `Err` is the whole message the startup page draws.
pub fn data_dir_for(exe_dir: Option<&Path>, appdata_dir: &Path) -> Result<PathBuf, String> {
    match exe_dir {
        Some(dir) => resolve_data_dir(dir, appdata_dir),
        // No executable path (an unusual host, a deleted binary): the portable location
        // cannot be named, so go straight to the per-user folder.
        None => {
            let fallback = appdata_dir.join("data");
            let _ = fs::create_dir_all(&fallback);
            Ok(fallback)
        }
    }
}

/// Prefer `<exe dir>/data` if creatable+writable, else `<appdata>/data` — **unless
/// `<exe dir>/data` already holds a collection** (`user.db`, or a pre-27 `mtg.db`), which is
/// an error instead (issue #1147).
///
/// The fallback is for a copy that never had a portable folder: an installed build under
/// `Program Files`, where the per-user folder is the only place it could ever have written.
/// A portable folder with a database in it is a different case — a stick with its
/// write-protect switch on, Controlled Folder Access, an antivirus refusing the probe — and
/// falling back there opened an empty collection and a first-run download with no word why.
/// Whatever was edited that session went to AppData and vanished from view once the stick was
/// writable again, leaving two databases that had diverged. Refusing to start, naming the
/// folder, is the only answer that loses nothing.
pub fn resolve_data_dir(exe_dir: &Path, appdata_dir: &Path) -> Result<PathBuf, String> {
    resolve_with(exe_dir, appdata_dir, dir_writable)
}

/// [`resolve_data_dir`] with the probe handed in, because a test cannot make a folder
/// unwritable on every host — a test run as root writes through `0o555`, and Windows' read-only
/// attribute does not stop a file being created in a directory.
fn resolve_with(
    exe_dir: &Path,
    appdata_dir: &Path,
    writable: impl Fn(&Path) -> bool,
) -> Result<PathBuf, String> {
    let portable = exe_dir.join("data");
    if writable(&portable) {
        return Ok(portable);
    }
    if let Some(db) = existing_collection(&portable) {
        return Err(read_only_portable(&portable, &db));
    }
    let fallback = appdata_dir.join("data");
    let _ = fs::create_dir_all(&fallback);
    Ok(fallback)
}

/// The collection file already in `dir`, if there is one — `user.db`, or the single-file
/// `mtg.db` a pre-27 build left, which the next launch converts. `corpus.db` alone does not
/// count: it is rebuilt from Scryfall, and a folder holding only that has nothing to lose.
fn existing_collection(dir: &Path) -> Option<PathBuf> {
    [USER_DB, LEGACY_DB]
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
}

/// The refusal [`resolve_data_dir`] returns: which folder, which file, the likely causes, and
/// that nothing was opened anywhere else.
fn read_only_portable(dir: &Path, db: &Path) -> String {
    format!(
        "MTG Grimoire cannot write to its data folder:\n  {dir}\n\
         Your collection is in {db}, so the app has not started from an empty one somewhere \
         else.\n\
         Check that the drive is not write-protected (a lock switch on a USB stick or SD card), \
         and that Windows Controlled Folder Access or an antivirus program is not blocking \
         MTG Grimoire from this folder. Then start the app again.",
        dir = dir.display(),
        db = db.display(),
    )
}

/// Can this app actually put files in `dir`? Creates it if it is not there yet.
///
/// Creating a directory says nothing about being able to write *into* it — an
/// administrator-owned `Program Files` install allows the first and refuses the second —
/// so the answer comes from a probe file rather than from `create_dir_all`.
///
/// A failed probe on a directory this call created takes that directory back down again.
/// Otherwise the rejected candidate is left behind as an empty `data/` beside the exe:
/// the app runs perfectly out of the AppData fallback, and the user has a plausible,
/// permanently empty folder sitting next to their portable app suggesting otherwise.
/// Best-effort, and only ever `remove_dir` — a directory that already held something is
/// not this function's to delete, and one it just created cannot.
fn dir_writable(dir: &Path) -> bool {
    let existed = dir.is_dir();
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-probe");
    let ok = fs::write(&probe, b"x").is_ok();
    let _ = fs::remove_file(&probe);
    if !ok && !existed {
        let _ = fs::remove_dir(dir);
    }
    ok
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_exe_dir_when_writable() {
        let tmp = crate::scratch::path("paths");
        let _ = std::fs::remove_dir_all(&tmp);
        let exe = tmp.join("exe");
        let app = tmp.join("app");
        std::fs::create_dir_all(&exe).unwrap();

        let resolved = resolve_data_dir(&exe, &app).unwrap();

        let expected = exe.join("data");
        let _ = std::fs::remove_dir_all(&tmp);
        assert_eq!(resolved, expected);
    }

    /// The cleanup on the failure path must not fire on the success path: a working
    /// `data/` — the one holding the user's 880 MB database — is the directory this is
    /// one careless condition away from removing.
    #[test]
    fn a_writable_directory_survives_the_probe_with_its_contents() {
        let tmp = crate::scratch::path("paths-probe");
        let _ = std::fs::remove_dir_all(&tmp);
        let data = tmp.join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("mtg.db"), b"pretend database").unwrap();

        let ok = dir_writable(&data);

        let kept = data.join("mtg.db").is_file();
        let probe_gone = !data.join(".write-probe").exists();
        let _ = std::fs::remove_dir_all(&tmp);
        assert!(ok);
        assert!(
            kept,
            "an existing database must not be touched by the probe"
        );
        assert!(probe_gone, "the probe file must not be left behind");
    }

    /// No executable path at all is the per-user directory — the arm `init_state` has always
    /// had.
    #[test]
    fn no_executable_path_is_the_per_user_directory() {
        let tmp = crate::scratch::path("paths-noexe");
        let _ = std::fs::remove_dir_all(&tmp);
        let app = tmp.join("app");

        let resolved = data_dir_for(None, &app).unwrap();

        let created = app.join("data").is_dir();
        let _ = std::fs::remove_dir_all(&tmp);
        assert_eq!(resolved, app.join("data"));
        assert!(created, "the fallback directory is created, not just named");
    }

    #[test]
    fn falls_back_to_appdata_when_exe_dir_unusable() {
        let tmp = crate::scratch::path("paths-fallback");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // A regular file cannot host a child directory, so `<exe>/data` is uncreatable.
        let exe = tmp.join("exe-is-a-file");
        std::fs::write(&exe, b"not a directory").unwrap();
        let app = tmp.join("app");

        let resolved = resolve_data_dir(&exe, &app).unwrap();

        let expected = app.join("data");
        let existed = resolved.is_dir();
        let _ = std::fs::remove_dir_all(&tmp);
        assert_eq!(resolved, expected);
        assert!(existed, "fallback data dir should have been created");
    }

    /// Issue #1147: a portable folder that already holds the collection and cannot be written
    /// to is a refusal naming the folder — never a quiet switch to an empty per-user database.
    #[test]
    fn an_unwritable_portable_collection_refuses_instead_of_falling_back() {
        for name in [USER_DB, LEGACY_DB] {
            let tmp = crate::scratch::path("paths-readonly");
            let _ = std::fs::remove_dir_all(&tmp);
            let exe = tmp.join("exe");
            let data = exe.join("data");
            let app = tmp.join("app");
            std::fs::create_dir_all(&data).unwrap();
            std::fs::write(data.join(name), b"pretend database").unwrap();

            let resolved = resolve_with(&exe, &app, |_| false);

            let fallback_made = app.join("data").exists();
            let _ = std::fs::remove_dir_all(&tmp);
            let message = resolved.expect_err(name);
            assert!(message.contains(&data.display().to_string()), "{message}");
            assert!(message.contains(name), "{message}");
            assert!(message.contains("write-protected"), "{message}");
            assert!(!fallback_made, "no per-user folder is made for a refusal");
        }
    }

    /// The fallback still stands for a portable folder with nothing to lose: absent, empty, or
    /// holding only the rebuildable `corpus.db`.
    #[test]
    fn an_unwritable_portable_folder_without_a_collection_still_falls_back() {
        let tmp = crate::scratch::path("paths-readonly-empty");
        let _ = std::fs::remove_dir_all(&tmp);
        let exe = tmp.join("exe");
        let data = exe.join("data");
        let app = tmp.join("app");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join(crate::db::CORPUS_DB), b"pretend corpus").unwrap();

        let resolved = resolve_with(&exe, &app, |_| false);

        let _ = std::fs::remove_dir_all(&tmp);
        assert_eq!(resolved, Ok(app.join("data")));
    }
}
