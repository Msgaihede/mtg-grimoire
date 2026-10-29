//! The release notes `releaseNotes` answers, bundled into the build — as the page bundles them
//! (`packages/ui/lib/bundledReleases.ts`, over the same files).
//!
//! Writes `$OUT_DIR/releases.rs`: every `changelog/<version>.md` as an `include_str!`, and the day
//! each release was cut, read off `CHANGELOG.md`'s release-please headings
//! (`packages/ui/lib/releaseDates.ts`'s rule: `## [0.44.0](…) (2026-10-11)`, the first heading
//! of a version winning). Only the dates are written out, so the 350 KB log is not in the binary.

use std::fmt::Write as _;
use std::path::Path;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let root = Path::new(&manifest).join("../..");
    let notes_dir = root.join("changelog");
    let log = root.join("CHANGELOG.md");
    println!("cargo:rerun-if-changed={}", notes_dir.display());
    println!("cargo:rerun-if-changed={}", log.display());

    let mut notes: Vec<(String, String)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&notes_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(version) = name.strip_suffix(".md") else {
                continue;
            };
            if is_version(version) {
                let path = entry.path();
                notes.push((version.to_owned(), path.to_string_lossy().into_owned()));
            }
        }
    }
    notes.sort();

    let dates = std::fs::read_to_string(&log)
        .map(|text| dates_of(&text))
        .unwrap_or_default();

    let mut out = String::from("pub(crate) static NOTES: &[(&str, &str)] = &[\n");
    for (version, path) in &notes {
        writeln!(out, "    ({version:?}, include_str!({path:?})),").unwrap();
    }
    out.push_str("];\n\npub(crate) static DATES: &[(&str, &str)] = &[\n");
    for (version, date) in &dates {
        writeln!(out, "    ({version:?}, {date:?}),").unwrap();
    }
    out.push_str("];\n");
    let target = Path::new(&std::env::var("OUT_DIR").unwrap()).join("releases.rs");
    std::fs::write(target, out).unwrap();
}

/// `0.44.0`: three runs of digits joined by dots.
fn is_version(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Every release heading's version and day, first heading of a version winning.
fn dates_of(log: &str) -> Vec<(String, String)> {
    let mut dates: Vec<(String, String)> = Vec::new();
    for line in log.lines() {
        let Some(rest) = line
            .strip_prefix("### [")
            .or_else(|| line.strip_prefix("## ["))
        else {
            continue;
        };
        let Some((version, rest)) = rest.split_once("](") else {
            continue;
        };
        let Some((_, rest)) = rest.split_once(") (") else {
            continue;
        };
        let date = rest.get(..10).unwrap_or("");
        let well_formed = date.len() == 10
            && rest.as_bytes().get(10) == Some(&b')')
            && date.bytes().enumerate().all(|(i, b)| {
                if i == 4 || i == 7 {
                    b == b'-'
                } else {
                    b.is_ascii_digit()
                }
            });
        if is_version(version) && well_formed && !dates.iter().any(|(v, _)| v == version) {
            dates.push((version.to_owned(), date.to_owned()));
        }
    }
    dates
}
