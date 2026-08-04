use std::fs;
use std::path::{Path, PathBuf};

/// Prefer `<exe dir>/data` if creatable+writable, else `<appdata>/data`.
pub fn resolve_data_dir(exe_dir: &Path, appdata_dir: &Path) -> PathBuf {
    let portable = exe_dir.join("data");
    if dir_writable(&portable) {
        portable
    } else {
        let fallback = appdata_dir.join("data");
        let _ = fs::create_dir_all(&fallback);
        fallback
    }
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
        let tmp = std::env::temp_dir().join("mtgtest-paths");
        let _ = std::fs::remove_dir_all(&tmp);
        let exe = tmp.join("exe");
        let app = tmp.join("app");
        std::fs::create_dir_all(&exe).unwrap();

        let resolved = resolve_data_dir(&exe, &app);

        let expected = exe.join("data");
        let _ = std::fs::remove_dir_all(&tmp);
        assert_eq!(resolved, expected);
    }

    /// The cleanup on the failure path must not fire on the success path: a working
    /// `data/` — the one holding the user's 880 MB database — is the directory this is
    /// one careless condition away from removing.
    #[test]
    fn a_writable_directory_survives_the_probe_with_its_contents() {
        let tmp = std::env::temp_dir().join("mtgtest-paths-probe");
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

    #[test]
    fn falls_back_to_appdata_when_exe_dir_unusable() {
        let tmp = std::env::temp_dir().join("mtgtest-paths-fallback");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // A regular file cannot host a child directory, so `<exe>/data` is uncreatable.
        let exe = tmp.join("exe-is-a-file");
        std::fs::write(&exe, b"not a directory").unwrap();
        let app = tmp.join("app");

        let resolved = resolve_data_dir(&exe, &app);

        let expected = app.join("data");
        let existed = resolved.is_dir();
        let _ = std::fs::remove_dir_all(&tmp);
        assert_eq!(resolved, expected);
        assert!(existed, "fallback data dir should have been created");
    }
}
