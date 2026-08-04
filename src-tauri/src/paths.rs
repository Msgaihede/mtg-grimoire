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

fn dir_writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-probe");
    let ok = fs::write(&probe, b"x").is_ok();
    let _ = fs::remove_file(&probe);
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
