use std::fs;
use std::path::{Path, PathBuf};

/// Which directory this build stores its database in, given what the process knows about
/// itself.
///
/// `desktop` is `cfg!(desktop)` at the one call site. It is a parameter rather than a `cfg`
/// inside the body so that **both** branches are compiled and tested on every platform — a
/// `#[cfg(mobile)]` body would be a rule nothing on this machine ever runs, and the Android
/// build is the one place a mistake in it would surface.
///
/// The portable-beside-the-exe question is a **desktop** question. On Android
/// `std::env::current_exe()` answers something inside the app's own native-library directory
/// or under `/system/bin`, neither of which is a place to put 500 MB of card corpus: the first
/// is replaced wholesale on the next install and the second is a read-only mount. Probing it
/// is not merely useless, it leaves an empty `data/` behind on the paths where the probe half
/// succeeds — which is exactly the failure [`dir_writable`]'s cleanup exists to prevent on
/// desktop.
pub fn data_dir_for(exe_dir: Option<&Path>, appdata_dir: &Path, desktop: bool) -> PathBuf {
    match exe_dir {
        Some(dir) if desktop => resolve_data_dir(dir, appdata_dir),
        // No executable path (an unusual host, a deleted binary), or a mobile build: the
        // portable location cannot be named or must not be used, so go straight to the
        // per-user folder.
        _ => {
            let fallback = appdata_dir.join("data");
            let _ = fs::create_dir_all(&fallback);
            fallback
        }
    }
}

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

    /// Android has no portable location. `current_exe()` there points into the app's own
    /// native-library directory or `/system/bin`, and `resolve_data_dir` would probe
    /// `<that>/data` — creating a directory under a read-only mount, or beside the extracted
    /// `.so` files where the OS is free to wipe it on the next install. The per-user directory
    /// Tauri resolves is the only correct answer, and `data_dir_for` is what refuses to ask
    /// the question on that platform.
    #[test]
    fn a_mobile_build_never_probes_beside_the_executable() {
        let tmp = std::env::temp_dir().join("mtgtest-paths-mobile");
        let _ = std::fs::remove_dir_all(&tmp);
        let exe = tmp.join("exe");
        let app = tmp.join("app");
        std::fs::create_dir_all(&exe).unwrap();

        // `exe` is writable, so `resolve_data_dir` WOULD take it. `data_dir_for` must not,
        // when told it is a mobile build.
        let mobile = data_dir_for(Some(exe.as_path()), &app, false);
        // **Read between the two calls, not after them.** The desktop call below is *supposed*
        // to create `<exe>/data` — it is the portable location — so a check taken at the end
        // of the test can never fail and would be asserting nothing.
        let probe_left_behind = exe.join("data").exists();

        let desktop = data_dir_for(Some(exe.as_path()), &app, true);

        let _ = std::fs::remove_dir_all(&tmp);
        assert_eq!(mobile, app.join("data"));
        assert_eq!(desktop, exe.join("data"));
        assert!(
            !probe_left_behind,
            "the mobile branch must not create <exe dir>/data at all"
        );
    }

    /// No executable path at all is still the per-user directory, on either platform. This is
    /// the arm `init_state` already had and it must survive the split.
    #[test]
    fn no_executable_path_is_the_per_user_directory_on_both() {
        let tmp = std::env::temp_dir().join("mtgtest-paths-noexe");
        let _ = std::fs::remove_dir_all(&tmp);
        let app = tmp.join("app");

        let mobile = data_dir_for(None, &app, false);
        let desktop = data_dir_for(None, &app, true);

        let created = app.join("data").is_dir();
        let _ = std::fs::remove_dir_all(&tmp);
        assert_eq!(mobile, app.join("data"));
        assert_eq!(desktop, app.join("data"));
        assert!(created, "the fallback directory is created, not just named");
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
