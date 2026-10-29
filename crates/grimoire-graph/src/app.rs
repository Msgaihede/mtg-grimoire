//! The app's own release notes, which the Change notes widget draws.
//!
//! Read from the notes bundled into this build — every `changelog/<version>.md`, which
//! `release.yml`'s `publish` makes each release's GitHub body, and each release's day off
//! `CHANGELOG.md`, both embedded by `build.rs` — rather than from `update_history`, which asks
//! GitHub: a widget on the home page should not need the network to say what changed. The page's
//! graph reads the same files (`packages/ui/lib/bundledReleases.ts`); this is its `releasesFrom`,
//! with this crate's version (the workspace's, which release-please bumps with the page's) as the
//! version running.

use std::cmp::Ordering;

use async_graphql::{Object, Result};

use crate::{invalidatedBy, roots};

mod bundled {
    include!(concat!(env!("OUT_DIR"), "/releases.rs"));
}

const RELEASES: &str = "https://github.com/Msgaihede/mtg-grimoire/releases";

/// One release of MTG Grimoire and what it changed.
#[derive(Clone, Debug, PartialEq)]
pub struct ReleaseNote {
    version: String,
    notes: &'static str,
    published_at: Option<&'static str>,
}

#[Object(rename_fields = "camelCase")]
impl ReleaseNote {
    async fn version(&self) -> &str {
        &self.version
    }
    async fn tag(&self) -> String {
        format!("v{}", self.version)
    }
    /// The release's notes, as Markdown.
    async fn notes(&self) -> &str {
        self.notes
    }
    /// When it was published, as an ISO 8601 date.
    async fn published_at(&self) -> Option<&str> {
        self.published_at
    }
    async fn html_url(&self) -> String {
        format!("{RELEASES}/tag/v{}", self.version)
    }
}

/// `0.10.0` → `[0, 10, 0]`; a part that is not a number counts as 0, as `Number` reads it.
fn parts(version: &str) -> [u64; 3] {
    let mut out = [0; 3];
    for (slot, part) in out.iter_mut().zip(version.split('.')) {
        *slot = part.parse().unwrap_or(0);
    }
    out
}

/// Newest first, by number rather than by text: `0.10.0` is after `0.9.0`.
fn newest_first(a: &str, b: &str) -> Ordering {
    parts(b).cmp(&parts(a))
}

/// The history, from the notes' files, the version running, and each release's day — newest
/// first, and **nothing after `current`**: a file for a release this build is older than is not
/// this build's past.
fn releases_from(
    files: &[(&str, &'static str)],
    current: &str,
    dates: &[(&str, &'static str)],
) -> Vec<ReleaseNote> {
    let mut out: Vec<ReleaseNote> = files
        .iter()
        .filter(|(version, _)| newest_first(version, current) != Ordering::Less)
        .map(|&(version, notes)| ReleaseNote {
            version: version.to_owned(),
            notes,
            published_at: dates.iter().find(|(v, _)| *v == version).map(|(_, d)| *d),
        })
        .collect();
    out.sort_by(|a, b| newest_first(&a.version, &b.version));
    out
}

/// This domain's batch loaders, for one execution — none.
pub(crate) fn data(
    request: async_graphql::Request,
    _state: &std::sync::Arc<grimoire_core::state::State>,
) -> async_graphql::Request {
    request
}

#[derive(Default)]
pub struct AppQuery;

#[Object(rename_fields = "camelCase")]
impl AppQuery {
    /// Every release of the app up to this build, newest first.
    // The bundled notes are fixed for the life of the build; this root is never invalidated.
    #[graphql(directive = invalidatedBy::apply(roots(&["bundledReleaseHistory"])))]
    async fn release_notes(
        &self,
        #[graphql(desc = "At most this many releases.")] limit: Option<i32>,
    ) -> Result<Option<Vec<ReleaseNote>>> {
        let mut releases = releases_from(bundled::NOTES, env!("CARGO_PKG_VERSION"), bundled::DATES);
        if let Some(limit) = limit {
            releases.truncate(usize::try_from(limit.max(0)).unwrap_or(0));
        }
        Ok(Some(releases))
    }
}

#[cfg(test)]
mod tests {
    use grimoire_core::state::fixtures::on_files;
    use serde_json::json;

    use super::*;
    use crate::Graph;

    #[test]
    fn newest_first_and_nothing_after_the_version_running() {
        let files = [
            ("0.9.0", "nine"),
            ("0.10.0", "ten"),
            ("0.11.0", "eleven"),
            ("0.2.0", "two"),
        ];
        let got = releases_from(&files, "0.10.0", &[("0.10.0", "2026-01-02")]);
        let versions: Vec<&str> = got.iter().map(|r| r.version.as_str()).collect();
        assert_eq!(versions, ["0.10.0", "0.9.0", "0.2.0"]);
        assert_eq!(got[0].published_at, Some("2026-01-02"));
        assert_eq!(got[1].published_at, None);
    }

    /// The build's notes are `changelog/`'s and its days `CHANGELOG.md`'s headings.
    #[test]
    fn the_bundled_notes_are_the_changelogs() {
        assert!(bundled::NOTES.iter().any(|(v, _)| *v == "0.44.0"));
        assert!(bundled::DATES.contains(&("0.44.0", "2026-10-11")));
    }

    #[test]
    fn release_notes_answer_through_the_graph() {
        let state = on_files("graph-app", "http://127.0.0.1:1").0;
        let response = Graph::new().run(
            &state,
            "{ releaseNotes(limit: 2) { version tag htmlUrl publishedAt notes }
               all: releaseNotes { version } }",
            None,
            None,
            None,
        );
        assert!(response.errors.is_empty(), "{:?}", response.errors);
        let data = response.data.into_json().unwrap();
        let two = data["releaseNotes"].as_array().unwrap();
        assert_eq!(two.len(), 2);
        let want = releases_from(bundled::NOTES, env!("CARGO_PKG_VERSION"), bundled::DATES);
        let newest = &want[0].version;
        assert_eq!(two[0]["version"], json!(newest));
        assert_eq!(two[0]["tag"], json!(format!("v{newest}")));
        assert_eq!(
            two[0]["htmlUrl"],
            json!(format!("{RELEASES}/tag/v{newest}"))
        );
        assert_eq!(two[0]["notes"], json!(want[0].notes));
        assert_eq!(two[0]["publishedAt"], json!(want[0].published_at));
        assert_eq!(data["all"].as_array().unwrap().len(), want.len());
    }
}
