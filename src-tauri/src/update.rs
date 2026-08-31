//! In-app updates, read from this repository's GitHub Releases.
//!
//! Hand-written rather than `tauri-plugin-updater`, for one reason that is not a matter of
//! taste: the official plugin updates a Windows app by downloading and running its
//! **installer**, and it has no path at all for replacing a bare portable exe. The portable
//! zip is the distribution this app is built around — it runs from any folder and keeps
//! `data/` beside itself — so pointing the plugin at one would install a *second* copy into
//! Program Files and leave the portable one, and the user's collection, behind.
//!
//! What that gives up is the plugin's minisign signature. What buys it back was measured
//! against the live API on 2026-08-09: **every release asset carries a `digest`**
//! (`sha256:…`, populated on all five), so an update is verified against a hash published
//! by GitHub rather than against nothing. A release whose asset has no digest is refused
//! outright — see [`verify_digest`].
//!
//! Three rules shape the module:
//!
//! * **The webview never touches the network.** Every request here is Rust, so
//!   `app.security.csp` needs no `connect-src` for github.com and the CSP test keeps its
//!   teeth.
//! * **Nothing is applied without the user asking twice** — once to download, once to
//!   restart. A window that vanishes mid-sync because of one click is worse than no
//!   updater.
//! * **An install kind that cannot be updated honestly is told so**, and offered the
//!   release page. Guessing is how a user ends up with two copies of the app.

use crate::sync::AppState;
// **Ungated since the check became portable.** `clear_app_meta` and [`record_check`] are what
// one `/releases` answer *does* to the database, and a browser makes that same answer — so the
// connection type and `params!` are needed on every target now.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
// With the download gated away, [`verify_digest`] is the only thing left that hashes, and
// it goes with it — so this import would be unused on wasm, which CI treats as a red build.
#[cfg(not(target_family = "wasm"))]
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;
#[cfg(not(target_family = "wasm"))]
use std::path::PathBuf;
// **Gated rather than deleted**, because CI runs
// `cargo clippy --lib --target wasm32-unknown-unknown -- -D warnings` and an unused import
// is a red build there. Every name below is reachable only from [`Updater`], from the check
// that fills it, or from the download-and-swap half of this file — all of which carry the
// same gate. **`SystemTime` is the one worth naming twice**: it does not merely go unused on
// wasm, `SystemTime::now()` *panics* there, and [`unix_now`] is the only thing that calls it.
#[cfg(not(target_family = "wasm"))]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(not(target_family = "wasm"))]
use std::sync::{Arc, Mutex};
#[cfg(not(target_family = "wasm"))]
use std::time::{Duration, SystemTime, UNIX_EPOCH};
#[cfg(not(target_family = "wasm"))]
use tauri::Emitter;

/// The repository the app updates itself from. Not derived from `CARGO_PKG_REPOSITORY`:
/// that is a URL, and this is an API path segment — the two agree today and a parser
/// between them would be one more thing to be wrong.
pub const REPO: &str = "Msgaihede/mtg-grimoire";

/// Production API host. A parameter on [`Updater::new`] so tests can point at a mock, the
/// same arrangement `scryfall::Client` uses.
pub const GITHUB_API: &str = "https://api.github.com";

/// How long a check stays fresh.
///
/// Unauthenticated `api.github.com` allows **60 requests/hour per IP**, shared with
/// everything else on the machine. Daily is comfortably inside that; a poll would not be.
const CHECK_INTERVAL_SECS: u64 = 86_400;

/// `app_meta` keys. The table is the application's, deliberately not `sync_meta` — see the
/// schema v6 step.
const K_LAST_CHECK_AT: &str = "update_last_check_at";
const K_LATEST_SEEN: &str = "update_latest_seen";
const K_HISTORY: &str = "update_release_history";

/// How many releases one check asks for.
///
/// **One page, and the number is GitHub's own default** — `/releases` pages at 30 unless told
/// otherwise, so this is the figure the request would carry anyway, written down because a
/// reader of the version history is entitled to know where the list stops. The repository has
/// eleven releases today; the cap matters the year it does not.
///
/// **Ungated**, because [`releases_url`] is what both targets build their one request from.
const HISTORY_PER_PAGE: u32 = 30;

/// What the two Windows artifacts are called, as **suffixes**.
///
/// Never a literal file name. v0.2.0's assets still read
/// `mtg-collection-tracker-0.2.0-windows-x64-portable.zip` and
/// `MTG.Collection.Tracker_0.2.0_x64-setup.exe` because that release predates the rename;
/// the next will be `mtg-grimoire-…` and `MTG.Grimoire_…`. The version is in the middle of
/// both, so the tail is the only stable part.
///
/// `content_type` is not a discriminator either: it is `application/zip` on **all five**
/// assets, the `.exe`, `.msi` and `.deb` included (measured 2026-08-09).
const PORTABLE_SUFFIX: &str = "-windows-x64-portable.zip";
const NSIS_SUFFIX: &str = "_x64-setup.exe";

/// The one entry read out of the portable archive.
#[cfg(not(target_family = "wasm"))]
const PORTABLE_EXE: &str = "mtg-grimoire.exe";

/// Refuse an asset larger than this before a byte is read. The Windows artifacts are
/// 4.8–6.5 MB; this is a bound on what a bad answer can make this process spend, not a
/// statement about the release.
#[cfg(not(target_family = "wasm"))]
const MAX_ASSET_BYTES: u64 = 256 * 1024 * 1024;

/// Bytes between `update:progress` events. A chunk-by-chunk callback fires far more often
/// than a progress bar can use.
#[cfg(not(target_family = "wasm"))]
const PROGRESS_EMIT_BYTES: u64 = 256 * 1024;

/// How long a freshly launched successor waits for the process it replaced to exit.
///
/// `cfg(windows)` because the only thing that reads it is, and so is the self-replacement it
/// bounds: every other platform lands on [`InstallKind::Other`] and never relaunches
/// anything. Without the gate this is dead code on the Linux leg of CI — which is how it was
/// found, the aggregator doing its job.
#[cfg(windows)]
const AWAIT_PREDECESSOR: Duration = Duration::from_secs(15);

/// The argument a swapped-in build is launched with. See [`await_predecessor`].
pub const AWAIT_FLAG: &str = "--await-predecessor";

/// How this copy of the app was installed, which decides what an update can do to it.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallKind {
    /// The portable exe. Updates by replacing itself in place and relaunching.
    Portable,
    /// An NSIS install. Updates by handing off to the downloaded setup.
    Nsis,
    /// Something else installs this app and this app does not update itself: the Play Store on
    /// Android. **Not [`InstallKind::Other`]**, which means "we could not tell, here is the
    /// release page" — and a release page offering a Windows exe and an NSIS installer to
    /// someone holding a phone is worse than saying nothing. This one has an answer and it is
    /// "the store has it".
    Managed,
    /// A page in a browser, which the **service worker** replaces. Sibling of
    /// [`InstallKind::Managed`] and deliberately not the same value: both mean "something
    /// else installs this and this app does not update itself", and a reader is owed the
    /// name of the thing that does. Saying "Google Play" to somebody holding a laptop is the
    /// same wrong answer that variant's own doc refuses to give a phone.
    ///
    /// **It is answered by [`crate::web::route`] and by nothing else**, because that is the
    /// only place in the crate that knows it is running in a browser. [`install_kind_for`]
    /// never returns it: that function probes a filesystem beside an executable, and on this
    /// target there is neither.
    Web,
    /// An MSI install, a Linux build, or anything unrecognised. Gets the release page and
    /// nothing else — see the module docs.
    Other,
}

/// One downloadable file on a release.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub name: String,
    pub url: String,
    pub size: u64,
    /// GitHub's `digest`, verbatim — `sha256:<hex>`. `None` if the field was absent, which
    /// makes the asset un-installable rather than installable-unverified.
    pub digest: Option<String>,
}

/// A release newer than the running build.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    /// `tag_name` with any leading `v` stripped — `0.3.0`.
    pub version: String,
    pub tag: String,
    /// The release body, **verbatim**, markdown and all.
    ///
    /// Rust stores what GitHub sent and interprets none of it. Which of release-please's
    /// shapes are drawn, whether a commit SHA is worth a line, whether two identical bullets
    /// are one — those are display decisions, and they live in `src/lib/releaseNotes.ts`
    /// with the renderer that acts on them.
    pub notes: String,
    pub published_at: Option<String>,
    pub html_url: String,
    /// Every asset on the release. Stored whole rather than pre-filtered, so the pick can
    /// be re-made against the install kind without another request.
    pub assets: Vec<Asset>,
}

/// One entry in the version history — a release, without the machinery for installing it.
///
/// [`ReleaseInfo`] minus its `assets`, and the subtraction is the point: the history is
/// **thirty** releases and each carries five assets with a URL and a 64-character digest
/// apiece, none of which a changelog can use. Only the release the app might actually
/// install needs an asset list, and that one is cached separately as a `ReleaseInfo`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNote {
    pub version: String,
    pub tag: String,
    /// Verbatim, for [`ReleaseInfo::notes`]'s reason.
    pub notes: String,
    pub published_at: Option<String>,
    pub html_url: String,
}

impl From<&ReleaseInfo> for ReleaseNote {
    fn from(r: &ReleaseInfo) -> ReleaseNote {
        ReleaseNote {
            version: r.version.clone(),
            tag: r.tag.clone(),
            notes: r.notes.clone(),
            published_at: r.published_at.clone(),
            html_url: r.html_url.clone(),
        }
    }
}

/// What the UI polls and what a check answers.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// The running build, from `CARGO_PKG_VERSION`.
    pub current_version: String,
    pub install_kind: InstallKind,
    /// The newer release, or `None` for "up to date" *and* for "never checked" — the
    /// `last_check_at` beside it is what tells those apart.
    pub available: Option<ReleaseInfo>,
    /// The asset this install would download, already picked. `None` when there is no
    /// update, or when the release carries nothing this install kind can use.
    pub asset: Option<Asset>,
    /// Unix seconds, as a string, matching `SyncStatus.lastCheckAt`'s shape.
    pub last_check_at: Option<String>,
    /// A check or a download is in flight.
    pub busy: bool,
    /// A verified build is on disk and one restart away.
    pub staged: bool,
}

/// Payload of `update:progress`. Deliberately the shape of `sync:progress`'s numbers and
/// nothing more — there is one phase here, and it is "downloading".
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub done: u64,
    pub total: u64,
}

#[cfg(not(target_family = "wasm"))]
/// What a completed download left behind, and what [`apply`] will do with it.
#[derive(Clone, Debug)]
struct Staged {
    kind: InstallKind,
    /// For `Portable`, `<exe dir>/mtg-grimoire.exe.new`. For `Nsis`, the setup in
    /// `<data dir>/updates/`.
    path: PathBuf,
    version: String,
}

#[cfg(not(target_family = "wasm"))]
/// Runtime state for the updater. Managed by Tauri beside `AppState`, rather than inside
/// it: nothing here needs the database except the two `app_meta` reads, which take a
/// connection as an argument like every other read in this app.
pub struct Updater {
    http: reqwest::Client,
    api_base: String,
    /// This process's own executable, resolved once. Every path the updater writes is
    /// derived from it, and `std::env::current_exe()` is not something to re-ask on a poll.
    exe: PathBuf,
    /// Decided once, at startup, and then never again: it cannot change while the process
    /// runs, and [`dir_is_writable`] *probes* by creating a file — a status poll must not
    /// touch the disk every second to re-learn something that is fixed.
    kind: InstallKind,
    /// One check or download at a time. Claimed with a swap and released by a guard, so an
    /// early return, an error or a dropped future all clear it — `sync::SyncingGuard`'s
    /// rule, for its reason.
    busy: AtomicBool,
    staged: Mutex<Option<Staged>>,
}

#[cfg(not(target_family = "wasm"))]
/// Clears `busy` however the operation ends.
struct BusyGuard<'a>(&'a AtomicBool);

#[cfg(not(target_family = "wasm"))]
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[cfg(not(target_family = "wasm"))]
impl Updater {
    pub fn new(api_base: String, exe: PathBuf) -> Updater {
        let kind = install_kind_for(cfg!(mobile), exe.parent());
        let http = reqwest::Client::builder()
            // The same UA the Scryfall client carries, and for the same reason: GitHub
            // requires one, and this one already names the app, its version and its repo
            // without anything here having to keep a second copy in sync.
            .user_agent(crate::scryfall::USER_AGENT)
            .connect_timeout(Duration::from_secs(15))
            // Not an overall timeout: an asset download is legitimately tens of seconds on
            // a slow line. A stalled connection is bounded by `read_timeout` instead.
            .read_timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_default();
        Updater {
            http,
            api_base,
            exe,
            kind,
            busy: AtomicBool::new(false),
            staged: Mutex::new(None),
        }
    }

    /// What kind of install this is. Fixed for the life of the process.
    pub fn install_kind(&self) -> InstallKind {
        self.kind
    }

    fn claim(&self) -> Option<BusyGuard<'_>> {
        if self.busy.swap(true, Ordering::SeqCst) {
            return None;
        }
        Some(BusyGuard(&self.busy))
    }
}

// ---------------------------------------------------------------------------------------
// `app_meta`
// ---------------------------------------------------------------------------------------

/// **The store itself lives in [`crate::app_meta`], which compiles for every target.**
///
/// It was moved there on 2026-08-29 because eleven modules read and write `app_meta` and
/// only this one updates the app: `deck` keeps the search column's state in it, `zoom`,
/// `nav`, `listview` and `flatten` keep their view state, and all of them are wanted on the
/// web target where an `.exe` swap is meaningless. Re-exported rather than renamed so the
/// sixty existing `crate::app_meta::get_app_meta` call sites keep reading the way they read.
pub use crate::app_meta::{get_app_meta, set_app_meta};

/// The one delete this module makes. Not in [`crate::app_meta`] because nothing else in the
/// crate removes a key — a view-state setting is overwritten, never cleared — and a
/// vocabulary of one caller belongs beside its caller.
fn clear_app_meta(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM app_meta WHERE key = ?1", params![key])?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------------------

/// Seconds since the Unix epoch. A clock before 1970 reads as 0, which makes every check
/// due — `sync::unix_now`'s rule.
///
/// **Gated, and this is the fourth module to need it.** `SystemTime::now()` does not fail on
/// `wasm32-unknown-unknown`, it **panics** — which arrives in the Worker's `onerror` with
/// nothing the page can show. `sync`, `tags` and `combos` were each caught by it before this
/// one; where a wasm caller needs a clock it reads `SELECT unixepoch()` off the connection.
/// Nothing here does, because the only caller is [`check_inner`], which is desktop's.
#[cfg(not(target_family = "wasm"))]
fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Should this run ask GitHub at all? `force` always wins; a `last` in the future counts as
/// due rather than underflowing or throttling until the wall clock catches up.
pub fn should_check(last: Option<u64>, now: u64, force: bool) -> bool {
    force || last.is_none_or(|l| l > now || now - l >= CHECK_INTERVAL_SECS)
}

/// `v0.3.0` → `(0, 3, 0)`.
///
/// Three components and nothing else: release-please emits plain `X.Y.Z`, and a tag with a
/// prerelease or build suffix fails to parse rather than being ordered by guesswork. That
/// is the safe direction — an unparseable tag is "no update", never "update to something we
/// do not understand".
fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let s = s.trim().strip_prefix('v').unwrap_or(s.trim());
    let mut parts = s.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// Is `candidate` a version this build should offer to move to?
pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// The install-kind decision, as facts rather than as filesystem calls, so it can be tested
/// on a platform that is not the one it describes.
///
/// An MSI install has no `uninstall.exe` and lands somewhere unwritable, so it falls to
/// `Other` — which is the right answer: running the NSIS setup over an MSI install would
/// produce a second copy, and `msiexec` on a guess is worse.
fn classify(windows: bool, has_uninstaller: bool, dir_writable: bool) -> InstallKind {
    if !windows {
        return InstallKind::Other;
    }
    if has_uninstaller {
        return InstallKind::Nsis;
    }
    if dir_writable {
        InstallKind::Portable
    } else {
        InstallKind::Other
    }
}

/// Can this process actually write beside its own exe? Probed rather than inferred —
/// "is it under Program Files" is a guess, and a portable copy on a read-only USB stick is
/// a real thing that must not be offered a self-replacement it cannot perform.
fn dir_is_writable(dir: &Path) -> bool {
    let probe = dir.join(".mtg-grimoire-write-probe");
    let ok = std::fs::File::create(&probe)
        .and_then(|mut f| f.write_all(b"x"))
        .is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

/// How this build is installed, with the **platform question asked first**.
///
/// `mobile` is `cfg!(mobile)` at the one call site. It is a parameter rather than a `cfg`
/// inside the body so both branches compile and are tested on every platform — the same
/// reasoning as [`crate::paths::data_dir_for`], and for the same reason: the Android arm is the
/// one nothing on this machine ever runs.
///
/// Asking first is the whole point. [`detect_install_kind`] probes by *writing a file* beside
/// the executable, and on Android that directory is the app's own native-library folder or a
/// read-only `/system/bin`. The answer would mean nothing either way — nothing on a phone can
/// replace the running binary except the store that installed it — so the probe is not merely
/// useless there, it is a write into a directory the OS replaces wholesale on the next install.
pub fn install_kind_for(mobile: bool, exe_dir: Option<&Path>) -> InstallKind {
    if mobile {
        return InstallKind::Managed;
    }
    exe_dir.map_or(InstallKind::Other, detect_install_kind)
}

pub fn detect_install_kind(exe_dir: &Path) -> InstallKind {
    classify(
        cfg!(windows),
        exe_dir.join("uninstall.exe").exists(),
        dir_is_writable(exe_dir),
    )
}

/// The asset this install kind would download, matched on the tail of the name.
pub fn pick_asset(assets: &[Asset], kind: InstallKind) -> Option<&Asset> {
    let suffix = match kind {
        InstallKind::Portable => PORTABLE_SUFFIX,
        InstallKind::Nsis => NSIS_SUFFIX,
        // None of the three can download anything. `Other` because nothing here knows what
        // would install it; `Managed` and `Web` because something else already does — the
        // store on a phone, the service worker in a browser. **Listed rather than swept up by
        // a `_`**, so the day a fourth kind is added the compiler asks what it downloads
        // instead of quietly answering `None` for it.
        InstallKind::Managed | InstallKind::Web | InstallKind::Other => return None,
    };
    assets
        .iter()
        .find(|a| a.name.to_ascii_lowercase().ends_with(suffix))
}

/// Check a downloaded file against GitHub's `digest`.
///
/// An absent digest is a **failure**, not a pass. This is the only integrity check the
/// design has — there is no minisign signature behind it — so "the field was missing" must
/// never be the path of least resistance into running a downloaded executable.
#[cfg(not(target_family = "wasm"))]
fn verify_digest(expected: Option<&str>, actual: &[u8]) -> Result<(), String> {
    let Some(expected) = expected else {
        return Err(
            "that release publishes no checksum for this download, so it cannot be verified. \
             Download it from the release page instead."
                .into(),
        );
    };
    let want = expected
        .strip_prefix("sha256:")
        .ok_or_else(|| format!("unsupported checksum format `{expected}`"))?
        .trim()
        .to_ascii_lowercase();
    let got = actual.iter().fold(String::with_capacity(64), |mut s, b| {
        use std::fmt::Write as _;
        let _ = write!(s, "{b:02x}");
        s
    });
    if got == want {
        Ok(())
    } else {
        Err(format!(
            "the download did not match its published checksum (expected {want}, got {got}). \
             It has been deleted."
        ))
    }
}

/// `mtg-grimoire.exe` → `mtg-grimoire.exe.old`.
///
/// Built by appending to the whole file name rather than with `Path::with_extension`, which
/// would replace `.exe` and give `mtg-grimoire.old` — a name that is not the running image
/// and would leave the real one behind.
#[cfg(not(target_family = "wasm"))]
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

// ---------------------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------------------

/// Parse `/releases` — one page, newest first — dropping what a reader must never be offered.
///
/// **A draft and a prerelease are both filtered here rather than downstream**, because this
/// list is two answers at once: the version history the panel draws, and the release the app
/// compares itself against. `/releases/latest`, which this replaced, applied exactly this
/// filter server-side; doing it here is what keeps the two answers from disagreeing about
/// which releases exist.
///
/// An entry that will not parse is skipped rather than failing the page: one malformed
/// release five versions back must not cost the reader their update check.
fn parse_release_page(v: &serde_json::Value) -> Vec<ReleaseInfo> {
    v.as_array()
        .map(|list| {
            list.iter()
                .filter(|r| {
                    !r["draft"].as_bool().unwrap_or(false)
                        && !r["prerelease"].as_bool().unwrap_or(false)
                })
                .filter_map(|r| parse_release(r).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// The release `/releases/latest` would have answered.
///
/// **The first entry, not the highest version**, and that is deliberate parity: GitHub
/// defines its latest release as the most recent non-draft, non-prerelease one *by
/// `created_at`*, and `/releases` is ordered by the same key. Picking the maximum version
/// instead would quietly change what this app offers the day a patch for an older line is
/// published after a newer minor — and [`is_newer`] is the guard that decides whether the
/// answer is an update at all, so nothing is lost by leaving the ordering to GitHub.
fn latest_of(page: &[ReleaseInfo]) -> Option<&ReleaseInfo> {
    page.first()
}

/// Parse one release object into the shape the rest of the module uses.
fn parse_release(v: &serde_json::Value) -> Result<ReleaseInfo, String> {
    let tag = v["tag_name"]
        .as_str()
        .ok_or_else(|| "the latest release has no tag".to_owned())?
        .to_owned();
    let version = tag.strip_prefix('v').unwrap_or(&tag).to_owned();
    let assets = v["assets"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|a| {
                    Some(Asset {
                        name: a["name"].as_str()?.to_owned(),
                        url: a["browser_download_url"].as_str()?.to_owned(),
                        size: a["size"].as_u64().unwrap_or(0),
                        digest: a["digest"].as_str().map(str::to_owned),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(ReleaseInfo {
        version,
        tag,
        notes: v["body"].as_str().unwrap_or_default().trim().to_owned(),
        published_at: v["published_at"].as_str().map(str::to_owned),
        html_url: v["html_url"].as_str().unwrap_or_default().to_owned(),
        assets,
    })
}

/// The one URL a check asks for.
///
/// **One request answering two questions** — the newest release the app might move to, and
/// the version history the panel draws — which is why it is `/releases` and not
/// `/releases/latest`. A second endpoint for the history would spend a second request out of
/// GitHub's 60/hour per IP to fetch a superset of what this one already returns.
///
/// `api_base` is a parameter for [`Updater::new`]'s reason: tests point it at a mock. The
/// browser has no `Updater` and passes [`GITHUB_API`] itself.
pub fn releases_url(api_base: &str) -> String {
    format!("{api_base}/repos/{REPO}/releases?per_page={HISTORY_PER_PAGE}")
}

/// What a `/releases` status code means, before any body has been read.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PageStatus {
    /// A page came back. Read it.
    Read,
    /// The repository is not there at all (404). **Not an error the reader can act on** —
    /// record the check and answer "nothing new". `/releases` answers `200 []` rather than
    /// 404 for a repository with no releases, so this arm is narrower than it looks and the
    /// empty page is [`record_check`]'s business instead.
    Missing,
}

/// Classify one response.
///
/// **Portable, and shared, because a browser gets exactly these codes.** `fetch` and
/// `reqwest` differ in how they *make* the request — a browser cannot set `User-Agent` and
/// has no connect timeout — but the answer is GitHub's either way, and two copies of "403
/// means rate limited" is two places for one rule to drift.
pub fn classify_status(code: u16) -> Result<PageStatus, String> {
    if code == 404 {
        return Ok(PageStatus::Missing);
    }
    if code == 403 || code == 429 {
        return Err("GitHub is rate limiting update checks right now. Try again later.".into());
    }
    if !(200..300).contains(&code) {
        return Err(format!("GitHub answered {code} for the latest release."));
    }
    Ok(PageStatus::Read)
}

/// Write what one check learned: the timestamp, the newest release, and the history.
///
/// **The whole of a check's effect on the database, on every target.** The fetch differs
/// between a desktop and a browser and nothing else does, so this is the half both call —
/// which is what keeps `update_history` answering the same shape of list wherever it is read.
///
/// An empty `page` is a *legitimate* answer, not a failure: a repository with no releases, or
/// one publishing nothing but prereleases (both are filtered in [`parse_release_page`]), and
/// [`PageStatus::Missing`] as well. All three clear both cached keys rather than leaving
/// yesterday's answer standing under today's timestamp.
///
/// The newest release is cached **whether or not it is newer than the running build**:
/// [`status_for`] re-compares against `CARGO_PKG_VERSION` on every read, so storing it
/// unconditionally keeps one rule instead of two and makes the cache correct across an update
/// with no clearing step.
///
/// `now` is a parameter rather than a clock read here, and that is the fourth module's worth
/// of the same trap: `SystemTime::now()` **panics** on `wasm32-unknown-unknown`. The desktop
/// passes [`unix_now`]; the browser passes `SELECT unixepoch()`.
pub fn record_check(conn: &Connection, now: u64, page: &[ReleaseInfo]) -> Result<(), String> {
    set_app_meta(conn, K_LAST_CHECK_AT, &now.to_string()).map_err(|e| e.to_string())?;
    match latest_of(page).map(serde_json::to_string) {
        Some(Ok(json)) => set_app_meta(conn, K_LATEST_SEEN, &json).map_err(|e| e.to_string())?,
        _ => clear_app_meta(conn, K_LATEST_SEEN).map_err(|e| e.to_string())?,
    }
    let notes: Vec<ReleaseNote> = page.iter().map(ReleaseNote::from).collect();
    match serde_json::to_string(&notes) {
        Ok(json) if !notes.is_empty() => {
            set_app_meta(conn, K_HISTORY, &json).map_err(|e| e.to_string())?
        }
        _ => clear_app_meta(conn, K_HISTORY).map_err(|e| e.to_string())?,
    }
    Ok(())
}

/// When the last check ran, in unix seconds. `None` for "never", and for a row that will not
/// parse as a number — both mean the throttle has nothing to measure against, which
/// [`should_check`] reads as due.
///
/// **A function rather than a `pub` key**, so `K_LAST_CHECK_AT` keeps its one reader per
/// target and a caller cannot spell it slightly differently. The browser needs it because its
/// check honours the same 24 h throttle the desktop's does.
pub fn last_check_at(conn: &Connection) -> Option<u64> {
    get_app_meta(conn, K_LAST_CHECK_AT).and_then(|s| s.parse::<u64>().ok())
}

/// One `/releases` body into the page it describes.
///
/// Split from [`record_check`] so the parse failure and the write failure are two different
/// sentences: "GitHub's answer was not readable JSON" is about the network, and a failed
/// `app_meta` write is about the disk.
pub fn page_from_body(body: &str) -> Result<Vec<ReleaseInfo>, String> {
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("GitHub's answer was not readable JSON: {e}"))?;
    Ok(parse_release_page(&value))
}

/// Build the status from what is already known, touching nothing but the database.
///
/// This is what the ribbon reads at launch: the last seen release is cached in `app_meta`,
/// so a notice appears immediately rather than a network round trip later. The cache is
/// re-compared against the running version every time, which is what makes it
/// self-clearing — after an update lands, yesterday's cached release is no longer newer and
/// the notice goes away with no bookkeeping.
#[cfg(not(target_family = "wasm"))]
pub fn status(state: &AppState, updater: &Updater) -> UpdateStatus {
    status_for(
        state,
        updater.kind,
        updater.busy.load(Ordering::SeqCst),
        crate::sync::lock_plain(&updater.staged).is_some(),
    )
}

/// The same answer, for a target that has no [`Updater`] to read it off.
///
/// **The split is what makes the Updates panel decidable in a browser**, and the bug it
/// repairs is the one PR #315 found on the phone: `UpdatePanel` tests `installKind`, that
/// answer comes from this DTO, and where the command did not answer at all the panel read the
/// *absence* as "not managed" and drew a Download button over a page that cannot download
/// anything. **A feature gated on a backend answer is ungated wherever the backend cannot
/// answer** — so the fix is for the backend to answer, which is what this function is for.
///
/// The three parameters are the whole of what an `Updater` was being consulted about. A web
/// caller passes [`InstallKind::Web`], `false` and `false`: `busy` is a claim over a download
/// this target cannot make, and nothing can be staged where there is no file to stage.
///
/// Everything else is read from `app_meta`, on every target. **Both keys are empty until
/// something checks, and since 2026-08-31 a browser can** —
/// [`crate::web::glue::update_check`] writes them through the same [`record_check`] the
/// desktop uses. Before that press they read "not checked yet", which is exactly what it is:
/// `app_meta` is not one of the synced tables, so no other device's check fills them in.
pub fn status_for(state: &AppState, kind: InstallKind, busy: bool, staged: bool) -> UpdateStatus {
    let conn = crate::sync::lock_db_read(state);
    let last_check_at = get_app_meta(&conn, K_LAST_CHECK_AT);
    let cached: Option<ReleaseInfo> = get_app_meta(&conn, K_LATEST_SEEN)
        .and_then(|s| serde_json::from_str(&s).ok())
        .filter(|r: &ReleaseInfo| is_newer(&r.version, current_version()));
    drop(conn);

    let asset = cached
        .as_ref()
        .and_then(|r| pick_asset(&r.assets, kind))
        .cloned();
    UpdateStatus {
        current_version: current_version().to_owned(),
        install_kind: kind,
        available: cached,
        asset,
        last_check_at,
        busy,
        staged,
    }
}

pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Every release the last check saw, newest first — the version history, read from cache.
///
/// **No network of its own, ever.** The page this answers from is written by a check, which
/// already fetches it to decide whether an update exists; asking GitHub again when a reader
/// expands the history would spend a second request out of 60/hour to re-learn something
/// already on disk. An install that has never checked answers an empty list, and the panel
/// says so rather than pretending the app has no past.
///
/// **A browser fills this in now.** It answered `[]` for ever until 2026-08-31, because the
/// only writer was [`check`] and that was desktop's — which is what made routing this command
/// a promise the target could not keep. [`crate::web::glue::update_check`] is the writer that
/// was missing.
pub fn history(state: &AppState) -> Vec<ReleaseNote> {
    let conn = crate::sync::lock_db_read(state);
    get_app_meta(&conn, K_HISTORY)
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Ask GitHub for the latest release, honouring the 24 h throttle unless `force`.
///
/// **This wrapper is desktop's and Android's; the browser's is
/// [`crate::web::glue::update_check`].** Not because a browser cannot fetch — it can, and
/// `api.github.com` answers `Access-Control-Allow-Origin: *` — but because `web::route::call`
/// is *synchronous*, since the Worker's `#[wasm_bindgen] call` is, so no `async` command can
/// be a `match` arm there at all. That is the same seam the four `*_refresh` commands sit on:
/// a bespoke `#[wasm_bindgen]` entry point with its own `postMessage` kind, and the command
/// *name* diverted onto it in `src/lib/core/browser.ts`. **`COMMANDS` does not move**, and
/// `route.rs`'s own arm comment says why.
///
/// What the two share is everything after the bytes arrive — [`classify_status`],
/// [`page_from_body`] and [`record_check`] — so an update check means the same thing to
/// `app_meta` wherever it ran.
///
/// **Two things here are the desktop's alone and are deliberately not ported.** The
/// [`Updater`]'s `busy` flag, which is a `Mutex`-guarded process-wide claim over a download
/// this target cannot make; and [`note_github`], because a browser's check is always a button
/// press whose failure rejects the promise the panel is already watching — `entitlement.rs`'s
/// standing argument, and PR 11's for the three feeds. The desktop needs the error log
/// because *its* check also runs unattended at startup with no window listening.
#[cfg(not(target_family = "wasm"))]
pub async fn check(
    state: &Arc<AppState>,
    updater: &Arc<Updater>,
    force: bool,
) -> Result<UpdateStatus, String> {
    let result = check_inner(state, updater, force).await;
    if let Err(e) = &result {
        note_github(state, "check", e);
    }
    result
}

#[cfg(not(target_family = "wasm"))]
/// Note a failed dealing with GitHub in the error log.
///
/// **Classified from this module's own message strings**, which is only acceptable because
/// they are this module's own: every one of them is written a few lines above, so this is a
/// switch over an internal vocabulary rather than an attempt to parse someone else's prose.
/// A failure to classify is `Other`, which is a true statement rather than a guess.
///
/// The startup check is the reason this matters. It runs in a spawned task whose only
/// current report is an `eprintln!` — no window is listening, nothing is written down — so
/// an update check that has been failing for a month is invisible in a shipped build.
fn note_github(state: &Arc<AppState>, operation: &str, message: &str) {
    let kind = if message.contains("rate limiting") {
        crate::errors::Kind::RateLimited
    } else if message.contains("not readable JSON") {
        crate::errors::Kind::Parse
    } else if message.contains("could not reach GitHub") {
        crate::errors::Kind::Http
    } else if message.contains("could not write") || message.contains("could not read") {
        crate::errors::Kind::Io
    } else {
        crate::errors::Kind::Other
    };
    if let Some(conn) = crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
        crate::errors::record(
            &conn,
            crate::errors::Source::GithubUpdate,
            operation,
            kind,
            message,
            None,
        );
    }
}

#[cfg(not(target_family = "wasm"))]
async fn check_inner(
    state: &Arc<AppState>,
    updater: &Arc<Updater>,
    force: bool,
) -> Result<UpdateStatus, String> {
    let now = unix_now();
    let last = last_check_at(&crate::sync::lock_db_read(state));
    if !should_check(last, now, force) {
        return Ok(status(state, updater));
    }
    // Named, not `_guard`, because **where it is dropped is load-bearing**: every `Ok` path
    // below drops it explicitly before building the answer. `status` reports `busy` by
    // reading this very flag, so a status built while the guard is alive tells the caller
    // that the operation it is the answer to is still running — and a UI that believes it
    // disables its own button until the next poll. Measured in the shipped window
    // 2026-08-09: "Restart to finish" arrived already disabled and stayed that way.
    let Some(guard) = updater.claim() else {
        return Err("an update check is already running".into());
    };

    let url = releases_url(&updater.api_base);
    let resp = updater
        .http
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("could not reach GitHub: {e}"))?;

    // **The three arms after the request are [`classify_status`], [`page_from_body`] and
    // [`record_check`], and a browser calls the same three.** What differs between the two
    // targets is how the bytes are asked for; what a `/releases` answer *means* is GitHub's
    // and is written once. See [`crate::web::glue::update_check`].
    let answer = classify_status(resp.status().as_u16())?;
    let page = match answer {
        // A repository that is not there at all: record the check, cache nothing, answer
        // "nothing new". Nothing is read off the response — there is no page to read.
        PageStatus::Missing => Vec::new(),
        // `text()` and then `serde_json`, rather than `resp.json()`: the latter needs
        // reqwest's `json` feature, and this crate builds reqwest with
        // `default-features = false` on purpose. One less feature for one extra line.
        PageStatus::Read => page_from_body(
            &resp
                .text()
                .await
                .map_err(|e| format!("could not read GitHub's answer: {e}"))?,
        )?,
    };

    {
        let conn = crate::sync::lock_db(state);
        let written = record_check(&conn, now, &page);
        // **Propagated for a real page and swallowed for a missing repository**, which is
        // the asymmetry this arm has carried since it was written: the 404 case has already
        // decided to report success, and a failed `app_meta` write on the way out of it
        // would turn "nothing new" into a banner about a repository the reader does not own.
        if answer == PageStatus::Read {
            written?;
        }
    }
    // Before the answer, never after. See the guard's binding above.
    drop(guard);
    Ok(status(state, updater))
}

// ---------------------------------------------------------------------------------------
// Downloading and staging
// ---------------------------------------------------------------------------------------

/// Download the asset this install kind needs, verify it, and stage it for [`apply`].
///
/// Nothing is swapped here and nothing is launched. A download that succeeds leaves the app
/// running exactly as it was, with one more file on disk.
#[cfg(not(target_family = "wasm"))]
pub async fn download(
    state: &Arc<AppState>,
    updater: &Arc<Updater>,
    app: &tauri::AppHandle,
) -> Result<UpdateStatus, String> {
    let result = download_inner(state, updater, app).await;
    if let Err(e) = &result {
        note_github(state, "download", e);
    }
    result
}

#[cfg(not(target_family = "wasm"))]
async fn download_inner(
    state: &Arc<AppState>,
    updater: &Arc<Updater>,
    app: &tauri::AppHandle,
) -> Result<UpdateStatus, String> {
    let current = status(state, updater);
    let release = current
        .available
        .ok_or_else(|| "there is no update to download.".to_owned())?;
    let asset = current.asset.ok_or_else(|| {
        format!(
            "release {} has no download for this kind of install. Open the release page instead.",
            release.version
        )
    })?;
    if asset.size == 0 || asset.size > MAX_ASSET_BYTES {
        return Err(format!(
            "the download for {} is an implausible size ({} bytes); refusing it.",
            release.version, asset.size
        ));
    }

    // Named for the reason `check`'s is: it must be dropped before the answer is built, or
    // the status this resolves with reports its own download as still running and the panel
    // disables the button it was about to offer.
    let Some(guard) = updater.claim() else {
        return Err("an update is already downloading".into());
    };

    let dir = state.data_dir.join("updates");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let part = dir.join(format!("{}.part", asset.name));
    let hash = stream_to_file(updater, app, &asset, &part)
        .await
        .inspect_err(|_| {
            // A partial download is never a resume point here: unlike the 77 MB bulk file this
            // is single-digit megabytes, and a half-file that survives is a half-file some
            // later run has to reason about.
            let _ = std::fs::remove_file(&part);
        })?;
    if let Err(e) = verify_digest(asset.digest.as_deref(), &hash) {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }

    let staged = match current.install_kind {
        // The archive is unpacked straight beside the running exe, so `apply` is two
        // renames and nothing that can fail halfway across a volume boundary.
        InstallKind::Portable => {
            let dest = sibling(&updater.exe, ".new");
            extract_portable_exe(&part, &dest)?;
            let _ = std::fs::remove_file(&part);
            Staged {
                kind: InstallKind::Portable,
                path: dest,
                version: release.version.clone(),
            }
        }
        InstallKind::Nsis => {
            let dest = dir.join(&asset.name);
            std::fs::rename(&part, &dest)
                .map_err(|e| format!("could not store the downloaded installer: {e}"))?;
            Staged {
                kind: InstallKind::Nsis,
                path: dest,
                version: release.version.clone(),
            }
        }
        InstallKind::Managed | InstallKind::Web | InstallKind::Other => {
            let _ = std::fs::remove_file(&part);
            return Err("this kind of install cannot be updated from inside the app.".into());
        }
    };
    *crate::sync::lock_plain(&updater.staged) = Some(staged);
    drop(guard);
    Ok(status(state, updater))
}

/// Stream one asset to `dest`, hashing as it goes, and answer the digest.
///
/// The size bound is enforced against the running total rather than against
/// `Content-Length`: a header is a claim, and a chunked response makes no claim at all —
/// `scryfall::Client::download`'s rule, for its reason.
#[cfg(not(target_family = "wasm"))]
async fn stream_to_file(
    updater: &Arc<Updater>,
    app: &tauri::AppHandle,
    asset: &Asset,
    dest: &Path,
) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;

    let resp = updater
        .http
        .get(&asset.url)
        .send()
        .await
        .map_err(|e| format!("could not start the download: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "the download answered {} for {}",
            resp.status().as_u16(),
            asset.name
        ));
    }

    let mut file = std::fs::File::create(dest)
        .map_err(|e| format!("could not open {}: {e}", dest.display()))?;
    let mut hasher = Sha256::new();
    let mut done = 0u64;
    let mut last_emit = 0u64;
    let mut stream = resp.bytes_stream();

    let _ = app.emit(
        "update:progress",
        UpdateProgress {
            done: 0,
            total: asset.size,
        },
    );
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("the download failed: {e}"))?;
        done += chunk.len() as u64;
        if done > asset.size {
            return Err(format!(
                "the download for {} is longer than the release says it is; refusing it.",
                asset.name
            ));
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .map_err(|e| format!("could not write {}: {e}", dest.display()))?;
        if done - last_emit >= PROGRESS_EMIT_BYTES || done == asset.size {
            last_emit = done;
            let _ = app.emit(
                "update:progress",
                UpdateProgress {
                    done,
                    total: asset.size,
                },
            );
        }
    }
    file.flush()
        .map_err(|e| format!("could not finish writing {}: {e}", dest.display()))?;
    if done != asset.size {
        return Err(format!(
            "the download stopped early ({done} of {} bytes).",
            asset.size
        ));
    }
    Ok(hasher.finalize().to_vec())
}

/// Pull `mtg-grimoire.exe` out of the portable archive.
///
/// Matched on the file name rather than on a full path, because the archive's layout is the
/// release workflow's business and `Compress-Archive` has changed how it stores single
/// files before.
#[cfg(not(target_family = "wasm"))]
fn extract_portable_exe(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive)
        .map_err(|e| format!("could not open the downloaded archive: {e}"))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| format!("the download is not a readable archive: {e}"))?;
    let index = (0..zip.len())
        .find(|&i| {
            zip.by_index(i)
                .ok()
                .and_then(|f| {
                    Path::new(f.name())
                        .file_name()
                        .map(|n| n.eq_ignore_ascii_case(PORTABLE_EXE))
                })
                .unwrap_or(false)
        })
        .ok_or_else(|| format!("the download contains no {PORTABLE_EXE}."))?;

    let mut entry = zip
        .by_index(index)
        .map_err(|e| format!("could not read {PORTABLE_EXE} from the archive: {e}"))?;
    let mut out = std::fs::File::create(dest)
        .map_err(|e| format!("could not write {}: {e}", dest.display()))?;
    std::io::copy(&mut entry, &mut out)
        .map_err(|e| format!("could not unpack {PORTABLE_EXE}: {e}"))?;
    out.flush()
        .map_err(|e| format!("could not finish writing {}: {e}", dest.display()))?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------------------

/// Swap in the staged build (portable) or hand off to its installer (NSIS), then ask the
/// app to exit.
///
/// The exit is scheduled rather than immediate: a command that tears its own webview down
/// inline never delivers its answer, and the caller needs to know this did not fail.
#[cfg(not(target_family = "wasm"))]
pub fn apply(updater: &Arc<Updater>, app: &tauri::AppHandle) -> Result<(), String> {
    let staged = crate::sync::lock_plain(&updater.staged)
        .clone()
        .ok_or_else(|| "there is no downloaded update to install.".to_owned())?;

    match staged.kind {
        InstallKind::Portable => swap_and_relaunch(&updater.exe, &staged.path)?,
        InstallKind::Nsis => {
            // `/P` passive, `/R` relaunch afterwards, `/UPDATE` to skip the WebView2
            // bootstrap and the shortcut refresh.
            //
            // Spawned *before* the exit and not after, which is the order that matters: the
            // installer's `CheckIfAppIsRunning` macro kills the running process without
            // prompting in passive mode, so leaving on our own terms is what lets
            // `RunEvent::Exit` fold the write-ahead log back in. If it kills us mid-way
            // anyway the WAL is still a complete journal and the next launch replays it.
            std::process::Command::new(&staged.path)
                .args(["/P", "/R", "/UPDATE"])
                .spawn()
                .map_err(|e| format!("could not start the installer: {e}"))?;
        }
        // Unreachable in practice — nothing can be staged for any of them, because
        // `pick_asset` refuses them and `download` refuses them again. `Web` is doubly so:
        // this whole function is gated off that target. Kept as a refusal rather than an
        // `unreachable!()` for the reason this module refuses everything else in words: a
        // panic in the updater takes the window with it.
        InstallKind::Managed | InstallKind::Web | InstallKind::Other => {
            return Err("this kind of install cannot be updated from inside the app.".into())
        }
    }

    eprintln!("updating to {} and restarting", staged.version);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Long enough for the IPC answer to land, short enough that the window does not
        // look stuck. Nothing depends on the exact figure.
        tokio::time::sleep(Duration::from_millis(200)).await;
        app.exit(0);
    });
    Ok(())
}

/// Put the new exe where the old one is and start it.
///
/// Windows permits **renaming** a running image and refuses to **replace** one, which is
/// the whole shape of this: the running exe steps aside rather than being overwritten.
///
/// If the second rename fails the first is undone, so a failure here leaves a working app
/// exactly where it was. That is the case worth the code — the window is still up, and an
/// app that has renamed itself out of existence cannot be relaunched by the user.
#[cfg(not(target_family = "wasm"))]
fn swap_and_relaunch(exe: &Path, staged: &Path) -> Result<(), String> {
    let old = sibling(exe, ".old");
    // A leftover from an earlier update whose successor never got to clean up. It is not
    // running now, so this succeeds; if it does not, the rename below will say so.
    let _ = std::fs::remove_file(&old);

    std::fs::rename(exe, &old).map_err(|e| {
        format!("could not move the current version aside: {e}. The app was not changed.")
    })?;
    if let Err(e) = std::fs::rename(staged, exe) {
        let _ = std::fs::rename(&old, exe);
        return Err(format!(
            "could not put the new version in place: {e}. The app was left as it was."
        ));
    }

    // The successor is handed **this process's id**, because that is the only thing it can
    // wait on that means what it needs. See `await_predecessor`.
    std::process::Command::new(exe)
        .arg(AWAIT_FLAG)
        .arg(std::process::id().to_string())
        .spawn()
        .map_err(|e| format!("the update is installed, but it could not be started: {e}"))?;
    Ok(())
}

/// Block until process `pid` has terminated, or `AWAIT_PREDECESSOR` has passed.
///
/// `OpenProcess` failing means it is already gone — the usual case for a process that never
/// existed, and the correct answer for one that has just exited.
#[cfg(not(target_family = "wasm"))]
#[cfg(windows)]
fn wait_for_process(pid: u32) {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};

    /// The standard access right that permits waiting on a kernel object.
    ///
    /// Written out rather than imported: `windows-sys` re-exports `SYNCHRONIZE` only under
    /// `Storage::FileSystem`, typed as a *file* access right, which it is not — it is one
    /// of the standard rights every object type shares, processes included.
    const SYNCHRONIZE: u32 = 0x0010_0000;

    // SAFETY: `OpenProcess` takes no pointers and returns either null or a handle this
    // function owns; every path below closes it exactly once.
    unsafe {
        let handle = OpenProcess(SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return;
        }
        let waited = WaitForSingleObject(handle, AWAIT_PREDECESSOR.as_millis() as u32);
        CloseHandle(handle);
        if waited != WAIT_OBJECT_0 {
            eprintln!("update: gave up waiting for process {pid} to exit; starting anyway.");
        }
    }
}

#[cfg(not(target_family = "wasm"))]
#[cfg(not(windows))]
fn wait_for_process(_pid: u32) {}

/// Wait for the process this build replaced to exit, before anything else initialises.
///
/// The wait is what stops the relaunch dying silently. `tauri-plugin-single-instance` gives
/// a second instance **exit code 0, no window and no stderr** — so a successor that starts
/// while its predecessor still holds the lock simply vanishes, and the user is left looking
/// at the old version with no sign that anything went wrong.
///
/// **It waits on the predecessor's process handle, and the first version of this did not.**
/// That one tried to delete the renamed image on the premise that Windows refuses to delete
/// a running executable, taking the failure as proof the process was alive. It is not true
/// any more: Rust's `fs::remove_file` uses **POSIX-semantics deletion** on current Windows,
/// which unlinks the name immediately and lets the file object live until the last handle
/// closes — so the delete succeeds against a running image. Measured in the shipped window
/// on 2026-08-09: *"the previous version let go after 0 ms"*, printed while the predecessor
/// had 200 ms still to live, followed by a successor that vanished exactly as described
/// above. `WaitForSingleObject` on the process is the only primitive here that means what
/// this needs, which is why the pid is passed on the command line.
///
/// Called before `tauri::Builder::default()`, because by the time a plugin has initialised
/// the decision has already been made.
#[cfg(not(target_family = "wasm"))]
pub fn await_predecessor(exe: &Path, pid: Option<u32>) {
    if let Some(pid) = pid {
        let started = std::time::Instant::now();
        wait_for_process(pid);
        eprintln!(
            "update: the previous version exited after {} ms",
            started.elapsed().as_millis()
        );
    }
    // Cleanup, and only cleanup — never evidence. It runs after the wait because that is
    // when it can actually succeed at removing the *name*; the bytes go when the last
    // handle closes either way.
    let _ = std::fs::remove_file(sibling(exe, ".old"));
}

/// The pid in `--await-predecessor <pid>`, if the argument carries one.
///
/// `None` for a launch with the flag and no id — a hand-run of the successor path — which
/// waits for nothing and simply cleans up.
#[cfg(not(target_family = "wasm"))]
pub fn predecessor_pid<I: IntoIterator<Item = String>>(args: I) -> Option<u32> {
    let mut args = args.into_iter().skip_while(|a| a != AWAIT_FLAG);
    args.next()?;
    args.next()?.parse().ok()
}

/// Clear what an update left beside the exe: the replaced build, and any staged one that
/// was downloaded and never applied.
///
/// Runs on every launch, and is a no-op on nearly all of them. The staged file goes too —
/// staging lives for one session by design, and a `.new` of unknown provenance is not
/// something a later launch should quietly install.
#[cfg(not(target_family = "wasm"))]
pub fn clean_up(exe: &Path) {
    let _ = std::fs::remove_file(sibling(exe, ".old"));
    let _ = std::fs::remove_file(sibling(exe, ".new"));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real payload, measured against the live API on 2026-08-09 — including the part
    /// that makes literal-name matching a bug: these assets still carry the app's **former**
    /// name, because v0.2.0 shipped before the rename.
    fn live_payload() -> serde_json::Value {
        serde_json::json!({
            "tag_name": "v0.2.0",
            "draft": false,
            "prerelease": false,
            "published_at": "2026-08-09T04:02:20Z",
            "html_url": "https://github.com/Msgaihede/mtg-grimoire/releases/tag/v0.2.0",
            "body": "### Features\n* portable build\n",
            "assets": [
                {"name": "mtg-collection-tracker-0.2.0-windows-x64-portable.zip",
                 "size": 6453913, "content_type": "application/zip",
                 "digest": "sha256:63da6924bcac208ead34a9969ea1f51389ed44d1009421bcaba8c60c2647f728",
                 "browser_download_url": "https://example.invalid/portable.zip"},
                {"name": "MTG.Collection.Tracker_0.2.0_amd64.AppImage",
                 "size": 85137912, "content_type": "application/zip",
                 "digest": "sha256:84a9234815cc47ca134ab46316a86173a6a087adf4cb4039cfe97d4ad262c41f",
                 "browser_download_url": "https://example.invalid/app.AppImage"},
                {"name": "MTG.Collection.Tracker_0.2.0_amd64.deb",
                 "size": 8024348, "content_type": "application/zip",
                 "digest": "sha256:fef8da5c84d8535c578ddf7e88377c6e37b95c185eb2792721163a13099290c7",
                 "browser_download_url": "https://example.invalid/app.deb"},
                {"name": "MTG.Collection.Tracker_0.2.0_x64-setup.exe",
                 "size": 4809910, "content_type": "application/zip",
                 "digest": "sha256:ef35c1863faa2193789350f68a27bed270db0ade678274e3c253e2d65a7f8040",
                 "browser_download_url": "https://example.invalid/setup.exe"},
                {"name": "MTG.Collection.Tracker_0.2.0_x64_en-US.msi",
                 "size": 6582272, "content_type": "application/zip",
                 "digest": "sha256:27dfb95a3e78046ee68acaceb3a749b0ae1af91dd43b9b33d4849a809242adef",
                 "browser_download_url": "https://example.invalid/app.msi"}
            ]
        })
    }

    /// One page of `/releases`, in the order GitHub answers it: newest first, with a draft
    /// and a prerelease among the real ones. Both of those are things `/releases/latest`
    /// filtered server-side and this module now has to filter itself.
    fn live_page() -> serde_json::Value {
        serde_json::json!([
            {"tag_name": "v0.4.0", "draft": true, "prerelease": false,
             "published_at": null, "html_url": "https://example.invalid/draft",
             "body": "not published yet", "assets": []},
            {"tag_name": "v0.3.0", "draft": false, "prerelease": false,
             "published_at": "2026-08-10T00:00:00Z",
             "html_url": "https://example.invalid/0.3.0",
             "body": "### Features\n* the newest real release\n", "assets": []},
            {"tag_name": "v0.3.0-rc.1", "draft": false, "prerelease": true,
             "published_at": "2026-08-09T12:00:00Z",
             "html_url": "https://example.invalid/rc", "body": "a candidate", "assets": []},
            live_payload(),
        ])
    }

    #[test]
    fn versions_compare_by_component_and_a_v_prefix_is_optional() {
        assert!(is_newer("0.3.0", "0.2.0"));
        assert!(is_newer("v0.3.0", "0.2.0"));
        assert!(is_newer("0.2.1", "0.2.0"));
        assert!(is_newer("1.0.0", "0.99.99"));
        assert!(!is_newer("0.2.0", "0.2.0"));
        assert!(!is_newer("0.1.9", "0.2.0"));
        // 10 > 9 as a number and not as a string, which is the whole reason this is parsed.
        assert!(is_newer("0.10.0", "0.9.0"));
    }

    /// An unparseable tag must read as "no update". The safe direction is refusing to move,
    /// never moving to something the comparison did not understand.
    #[test]
    fn a_tag_that_is_not_three_numbers_is_never_newer() {
        for tag in ["0.3", "0.3.0.1", "0.3.0-rc.1", "nightly", "", "v"] {
            assert!(!is_newer(tag, "0.2.0"), "{tag} must not read as an update");
        }
        assert_eq!(parse_version("0.3.0-rc.1"), None);
    }

    /// The measured shape, parsed. `digest` is the field the whole integrity story rests
    /// on, so its presence is asserted rather than assumed.
    #[test]
    fn a_release_parses_into_assets_that_keep_their_digests() {
        let release = parse_release(&live_payload()).unwrap();
        assert_eq!(release.version, "0.2.0");
        assert_eq!(release.tag, "v0.2.0");
        assert_eq!(release.assets.len(), 5);
        assert!(release.notes.starts_with("### Features"));
        assert!(release.assets.iter().all(|a| a
            .digest
            .as_deref()
            .is_some_and(|d| d.starts_with("sha256:"))));
    }

    /// The bug this guards: matching a literal file name. Every asset here carries the
    /// app's former product name, and a suffix match finds them anyway — which is what will
    /// still be true when the next release carries the new one.
    #[test]
    fn assets_are_picked_by_suffix_so_a_renamed_product_still_matches() {
        let release = parse_release(&live_payload()).unwrap();

        let portable = pick_asset(&release.assets, InstallKind::Portable).unwrap();
        assert_eq!(
            portable.name,
            "mtg-collection-tracker-0.2.0-windows-x64-portable.zip"
        );
        let nsis = pick_asset(&release.assets, InstallKind::Nsis).unwrap();
        assert_eq!(nsis.name, "MTG.Collection.Tracker_0.2.0_x64-setup.exe");

        // ...and the same list under the *new* product name.
        let renamed: Vec<Asset> = [
            "mtg-grimoire-0.3.0-windows-x64-portable.zip",
            "MTG.Grimoire_0.3.0_x64-setup.exe",
            "MTG.Grimoire_0.3.0_x64_en-US.msi",
        ]
        .iter()
        .map(|n| Asset {
            name: (*n).to_owned(),
            url: String::new(),
            size: 1,
            digest: None,
        })
        .collect();
        assert_eq!(
            pick_asset(&renamed, InstallKind::Portable).unwrap().name,
            "mtg-grimoire-0.3.0-windows-x64-portable.zip"
        );
        assert_eq!(
            pick_asset(&renamed, InstallKind::Nsis).unwrap().name,
            "MTG.Grimoire_0.3.0_x64-setup.exe"
        );

        // An MSI install is `Other`, and `Other` has nothing to download — the `.msi` on the
        // release is deliberately not offered.
        assert!(pick_asset(&release.assets, InstallKind::Other).is_none());
    }

    /// The filter `/releases/latest` used to apply server-side, now applied here.
    ///
    /// A draft is not published and a prerelease is not what a reader running a stable build
    /// asked for; offering either as "the latest version" would be this module inventing a
    /// release policy the repository does not have. The history is the same list, so both
    /// answers are filtered by construction rather than by two agreeing rules.
    #[test]
    fn a_draft_and_a_prerelease_are_on_neither_the_history_nor_the_offer() {
        let page = parse_release_page(&live_page());

        assert_eq!(
            page.iter().map(|r| r.version.as_str()).collect::<Vec<_>>(),
            ["0.3.0", "0.2.0"],
            "the draft and the release candidate are dropped"
        );
        assert_eq!(latest_of(&page).map(|r| r.version.as_str()), Some("0.3.0"));
    }

    /// The order is GitHub's, and taking the first entry is what keeps this in step with the
    /// endpoint it replaced. A patch to an older line published *after* a newer minor sorts
    /// first by `created_at`, and `/releases/latest` would have answered exactly the same.
    #[test]
    fn the_latest_release_is_the_first_entry_rather_than_the_highest_version() {
        let page = parse_release_page(&serde_json::json!([
            {"tag_name": "v0.2.1", "draft": false, "prerelease": false,
             "html_url": "", "body": "a backport", "assets": []},
            {"tag_name": "v0.3.0", "draft": false, "prerelease": false,
             "html_url": "", "body": "the newer minor", "assets": []},
        ]));
        assert_eq!(latest_of(&page).map(|r| r.version.as_str()), Some("0.2.1"));
    }

    /// One malformed release five versions back must not cost the reader their update check.
    #[test]
    fn an_unparseable_entry_is_skipped_rather_than_failing_the_page() {
        let page = parse_release_page(&serde_json::json!([
            {"draft": false, "prerelease": false, "body": "no tag at all"},
            {"tag_name": "v0.3.0", "draft": false, "prerelease": false,
             "html_url": "", "body": "fine", "assets": []},
        ]));
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].version, "0.3.0");
    }

    /// A history entry keeps the body and drops the machinery. Thirty releases' worth of
    /// asset URLs and 64-character digests is what this subtraction is worth, and none of it
    /// can be used by a changelog.
    #[test]
    fn a_history_entry_keeps_the_notes_and_drops_the_assets() {
        let release = parse_release(&live_payload()).unwrap();
        assert_eq!(release.assets.len(), 5);

        let note = ReleaseNote::from(&release);
        assert_eq!(note.version, "0.2.0");
        assert_eq!(note.tag, "v0.2.0");
        assert_eq!(note.notes, release.notes);
        assert_eq!(note.published_at.as_deref(), Some("2026-08-09T04:02:20Z"));

        let json = serde_json::to_value(&note).unwrap();
        assert_eq!(json["publishedAt"], "2026-08-09T04:02:20Z");
        assert_eq!(json["htmlUrl"], release.html_url);
        assert!(
            json.get("assets").is_none(),
            "a history entry carries no assets: {json}"
        );
    }

    /// Android's install kind is decided by the platform, not by probing the disk.
    ///
    /// The probe `detect_install_kind` runs — creating `.mtg-grimoire-write-probe` beside the
    /// executable — would be attempted in the app's own native-library directory or under
    /// `/system/bin`, and its answer would mean nothing either way: nothing on a phone can
    /// replace the running binary except the store that installed it. So the platform question
    /// is asked **first**, before the disk is touched at all, and this asserts both halves —
    /// the answer, and the absence of the probe.
    #[test]
    fn a_managed_install_is_decided_by_the_platform_and_not_by_a_probe() {
        let dir = std::env::temp_dir().join("mtgtest-update-managed");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let managed = install_kind_for(true, Some(dir.as_path()));
        // Read between the two calls: the desktop one below is *supposed* to probe, so a check
        // taken at the end of the test could never fail.
        let probed = dir.join(".mtg-grimoire-write-probe").exists();

        // The desktop arm is unchanged — it is still `detect_install_kind`, on a writable
        // directory with no uninstaller beside it.
        let desktop = install_kind_for(false, Some(dir.as_path()));
        let expected = detect_install_kind(dir.as_path());
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(managed, InstallKind::Managed);
        assert_eq!(desktop, expected);
        assert!(
            !probed,
            "the managed branch must not write a probe file beside the executable"
        );
    }

    /// No executable directory at all is still `Other` on desktop, which is the arm
    /// `Updater::new` already had and which must survive the platform question being asked
    /// first.
    #[test]
    fn no_executable_directory_is_still_other_on_desktop() {
        assert_eq!(install_kind_for(false, None), InstallKind::Other);
        assert_eq!(install_kind_for(true, None), InstallKind::Managed);
    }

    /// `Managed` can download nothing. `pick_asset` must refuse before it ever matches a
    /// filename — a release's `-setup.exe` is not an answer to a phone, and neither is the
    /// portable zip.
    #[test]
    fn a_managed_install_picks_no_asset() {
        let release = parse_release(&live_payload()).unwrap();

        assert!(pick_asset(&release.assets, InstallKind::Managed).is_none());
        // And the two that DO pick still do — this is the assertion that makes the addition a
        // widening rather than a change.
        assert!(pick_asset(&release.assets, InstallKind::Portable).is_some());
        assert!(pick_asset(&release.assets, InstallKind::Nsis).is_some());
    }

    #[test]
    fn the_install_kind_is_decided_by_an_uninstaller_and_a_writable_folder() {
        assert_eq!(classify(true, true, true), InstallKind::Nsis);
        assert_eq!(classify(true, true, false), InstallKind::Nsis);
        assert_eq!(classify(true, false, true), InstallKind::Portable);
        // Program Files without an NSIS uninstaller: an MSI install, and not something to
        // guess at.
        assert_eq!(classify(true, false, false), InstallKind::Other);
        // Nobody has ever run a Linux build of this app; it is not getting self-replacement.
        assert_eq!(classify(false, false, true), InstallKind::Other);
    }

    /// An absent digest must not be a pass. This is the only integrity check in the design,
    /// so "the field was missing" is the one path that must not lead into running a
    /// downloaded executable.
    #[test]
    fn a_download_with_no_published_checksum_is_refused() {
        let err = verify_digest(None, b"anything").unwrap_err();
        assert!(err.contains("no checksum"), "{err}");
    }

    #[test]
    fn a_digest_is_compared_case_insensitively_and_a_mismatch_says_so() {
        // sha256("") — a fixed, checkable vector.
        let empty = Sha256::digest(b"");
        let hex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert!(verify_digest(Some(&format!("sha256:{hex}")), &empty).is_ok());
        assert!(verify_digest(Some(&format!("sha256:{}", hex.to_uppercase())), &empty).is_ok());

        let err = verify_digest(Some("sha256:0000"), &empty).unwrap_err();
        assert!(err.contains("did not match"), "{err}");
        let err = verify_digest(Some("md5:abc"), &empty).unwrap_err();
        assert!(err.contains("unsupported"), "{err}");
    }

    /// `Path::with_extension` would turn `mtg-grimoire.exe` into `mtg-grimoire.old` — a
    /// name that is not the running image, so the swap would leave the real exe in place
    /// and "succeed".
    #[test]
    fn the_sidecar_names_append_rather_than_replace_the_extension() {
        let exe = Path::new("D:\\Apps\\mtg\\mtg-grimoire.exe");
        assert_eq!(
            sibling(exe, ".old"),
            Path::new("D:\\Apps\\mtg\\mtg-grimoire.exe.old")
        );
        assert_eq!(
            sibling(exe, ".new"),
            Path::new("D:\\Apps\\mtg\\mtg-grimoire.exe.new")
        );
    }

    #[test]
    fn the_check_throttle_is_daily_and_force_gets_past_it() {
        let now = 1_800_000_000u64;
        assert!(should_check(None, now, false));
        assert!(!should_check(Some(now - 3600), now, false));
        assert!(should_check(Some(now - 3600), now, true));
        assert!(should_check(Some(now - 90_000), now, false));
        // A clock that moved backwards must not wedge the throttle until it catches up.
        assert!(should_check(Some(now + 90_000), now, false));
    }

    /// The swap, end to end, on real files — including the part that only matters when it
    /// goes wrong.
    #[test]
    fn the_swap_moves_the_old_build_aside_and_puts_the_new_one_in_place() {
        let dir = std::env::temp_dir().join("mtgtest-update-swap");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("mtg-grimoire.exe");
        let new = sibling(&exe, ".new");
        std::fs::write(&exe, b"old build").unwrap();
        std::fs::write(&new, b"new build").unwrap();

        // Not `swap_and_relaunch`: that ends by starting a process, and a test must not.
        // The two renames are the part with a failure mode.
        let old = sibling(&exe, ".old");
        std::fs::rename(&exe, &old).unwrap();
        std::fs::rename(&new, &exe).unwrap();

        assert_eq!(std::fs::read(&exe).unwrap(), b"new build");
        assert_eq!(std::fs::read(&old).unwrap(), b"old build");

        // ...and the successor clears the replaced build once it is done waiting.
        await_predecessor(&exe, None);
        assert!(
            !old.exists(),
            "the replaced build is deleted by the successor"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The successor is told which process to wait for on its command line, and the parse
    /// has to survive every shape it can arrive in.
    #[test]
    fn the_predecessor_pid_is_read_off_the_command_line() {
        let args = |s: &str| s.split(' ').map(str::to_owned).collect::<Vec<_>>();
        assert_eq!(
            predecessor_pid(args("mtg-grimoire.exe --await-predecessor 48940")),
            Some(48940)
        );
        // A hand-run of the successor path: the flag with nothing after it waits for
        // nothing and just cleans up.
        assert_eq!(
            predecessor_pid(args("mtg-grimoire.exe --await-predecessor")),
            None
        );
        assert_eq!(predecessor_pid(args("mtg-grimoire.exe")), None);
        assert_eq!(
            predecessor_pid(args("mtg-grimoire.exe --await-predecessor notapid")),
            None
        );
    }

    /// **The premise the first version of this wait was built on, pinned as false.**
    ///
    /// It assumed Windows refuses to delete a running executable, and read a failed delete
    /// as "the predecessor is still alive". Rust's `remove_file` uses POSIX-semantics
    /// deletion on current Windows: the name goes immediately and the file object outlives
    /// it. So a delete against a running image *succeeds*, and a wait built on it returns
    /// at once — measured in the shipped window on 2026-08-09 as "let go after 0 ms",
    /// printed while the predecessor had 200 ms still to live, followed by a successor
    /// `tauri-plugin-single-instance` killed silently.
    ///
    /// A test cannot delete its own running exe, so it pins the shape that misled: a file
    /// with an open handle still unlinks, and `exists()` agrees immediately.
    #[cfg(windows)]
    #[test]
    fn deleting_a_file_that_is_still_open_succeeds_on_windows() {
        let dir = std::env::temp_dir().join("mtgtest-update-posix-delete");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("held.bin");
        std::fs::write(&path, b"in use").unwrap();

        let held = std::fs::File::open(&path).unwrap();
        assert!(
            std::fs::remove_file(&path).is_ok(),
            "an open file still unlinks — a failed delete is not a liveness signal"
        );
        assert!(!path.exists());
        drop(held);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `clean_up` runs on every launch and must be silent when there is nothing to do —
    /// which is nearly every launch.
    #[test]
    fn cleanup_removes_a_stale_staged_build_and_does_nothing_when_there_is_none() {
        let dir = std::env::temp_dir().join("mtgtest-update-clean");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("mtg-grimoire.exe");
        std::fs::write(&exe, b"build").unwrap();
        std::fs::write(sibling(&exe, ".new"), b"staged").unwrap();
        std::fs::write(sibling(&exe, ".old"), b"replaced").unwrap();

        clean_up(&exe);
        assert!(!sibling(&exe, ".new").exists());
        assert!(!sibling(&exe, ".old").exists());
        assert!(exe.exists(), "the running build is never touched");

        clean_up(&exe); // idempotent
        assert!(exe.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The frontend mirrors these names by hand, exactly as it does `SyncStatus`'s, and a
    /// rename that is not mirrored becomes an `undefined` the compiler is happy with.
    #[test]
    fn dto_json_uses_the_camel_case_names_the_frontend_expects() {
        let status = UpdateStatus {
            current_version: "0.2.0".into(),
            install_kind: InstallKind::Portable,
            available: Some(ReleaseInfo {
                version: "0.3.0".into(),
                tag: "v0.3.0".into(),
                notes: "notes".into(),
                published_at: Some("2026-08-09T04:02:20Z".into()),
                html_url: "https://example.invalid".into(),
                assets: vec![],
            }),
            asset: Some(Asset {
                name: "mtg-grimoire-0.3.0-windows-x64-portable.zip".into(),
                url: "https://example.invalid/p.zip".into(),
                size: 6453913,
                digest: Some("sha256:abc".into()),
            }),
            last_check_at: Some("1800000000".into()),
            busy: false,
            staged: true,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["currentVersion"], "0.2.0");
        assert_eq!(json["installKind"], "portable");
        assert_eq!(json["available"]["version"], "0.3.0");
        assert_eq!(json["available"]["publishedAt"], "2026-08-09T04:02:20Z");
        assert_eq!(json["available"]["htmlUrl"], "https://example.invalid");
        assert_eq!(json["asset"]["size"], 6453913);
        assert_eq!(json["asset"]["digest"], "sha256:abc");
        assert_eq!(json["lastCheckAt"], "1800000000");
        assert_eq!(json["staged"], true);

        let progress = serde_json::to_value(UpdateProgress { done: 5, total: 10 }).unwrap();
        assert_eq!(progress, serde_json::json!({"done": 5, "total": 10}));

        // The five install kinds are a closed union on the other side too. `src/lib/ipc.ts`
        // mirrors this by hand, and a rename here with no rename there is a status the panel
        // renders as no branch at all — which is exactly what a browser got while `web` did
        // not exist and `installKind` arrived `undefined`.
        for (kind, name) in [
            (InstallKind::Portable, "portable"),
            (InstallKind::Nsis, "nsis"),
            (InstallKind::Managed, "managed"),
            (InstallKind::Web, "web"),
            (InstallKind::Other, "other"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), name);
        }
    }

    /// **[`status_for`] answers without an [`Updater`], which is what makes the Updates
    /// panel decidable in a browser.**
    ///
    /// Driven with a cached release in `app_meta` on purpose: the interesting half is that
    /// everything except the three parameters still comes off the database, so a web caller
    /// gets the same self-clearing comparison against the running version that the desktop
    /// does. What differs is only the kind — and therefore the asset, which `pick_asset`
    /// refuses for `Web` exactly as it refuses it for `Managed`.
    #[test]
    fn status_for_answers_off_the_database_without_an_updater() {
        let (state, _dir) = file_state("status-for");
        let mut release = parse_release(&live_payload()).unwrap();
        // **The payload's own `v0.2.0` is not newer than this build and would be filtered
        // out**, which would make every assertion below pass for the wrong reason. Derived
        // from the running version rather than written down, so this does not rot at the
        // next release — `status_for` re-compares the cache through `is_newer` on every
        // read, which is the behaviour being relied on here.
        let major: u32 = current_version()
            .split('.')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        release.version = format!("{}.0.0", major + 1);
        {
            let conn = crate::sync::lock_db(&state);
            set_app_meta(&conn, K_LAST_CHECK_AT, "1800000000").unwrap();
            set_app_meta(
                &conn,
                K_LATEST_SEEN,
                &serde_json::to_string(&release).unwrap(),
            )
            .unwrap();
        }

        // A portable install is offered the release and the asset it could install.
        let portable = status_for(&state, InstallKind::Portable, false, false);
        assert_eq!(portable.install_kind, InstallKind::Portable);
        assert_eq!(portable.last_check_at.as_deref(), Some("1800000000"));
        assert!(portable.available.is_some());
        assert!(portable.asset.is_some());

        // The same database read as a browser: the news survives, the download does not.
        let web = status_for(&state, InstallKind::Web, false, false);
        assert_eq!(web.install_kind, InstallKind::Web);
        assert_eq!(web.last_check_at.as_deref(), Some("1800000000"));
        assert!(
            web.available.is_some(),
            "the cached release is a fact about the database, not about the install kind"
        );
        assert!(
            web.asset.is_none(),
            "nothing on this target can install an asset, so none may be offered"
        );
        // The two flags are the caller's, and a browser has nothing to report for either.
        assert!(!web.busy);
        assert!(!web.staged);
        assert_eq!(web.current_version, current_version());
    }

    /// The cache is re-compared against the running version on every read, which is what
    /// makes it self-clearing: after an update lands, yesterday's cached release is no
    /// longer newer and the notice disappears with no bookkeeping step to forget.
    #[test]
    fn a_cached_release_stops_being_an_update_once_the_app_reaches_it() {
        let release = parse_release(&live_payload()).unwrap();
        assert!(is_newer(&release.version, "0.1.0"));
        assert!(!is_newer(&release.version, "0.2.0"));
        assert!(!is_newer(&release.version, "0.3.0"));
    }

    // ── The half both targets share ─────────────────────────────────────────────────
    //
    // `releases_url`, `classify_status`, `page_from_body`, `record_check` and
    // `last_check_at` are what `check_inner` and `crate::web::glue::update_check` have in
    // common: everything after the bytes arrive. **`glue.rs` is compiled only for wasm and is
    // covered by nothing**, which is `web-target.md`'s own standing note about the four feed
    // ingests — so this block is where the browser's check is actually tested, and the wasm
    // entry point is the thin call sequence over it.

    /// One page, one request, and the size asked for rather than left to GitHub's default.
    ///
    /// The base is a parameter for the same reason `Updater::new` takes one — a mock — and
    /// the browser passes [`GITHUB_API`] itself, having no `Updater` to hold it.
    #[test]
    fn the_check_asks_one_url_for_both_the_offer_and_the_history() {
        assert_eq!(
            releases_url("https://api.github.com"),
            "https://api.github.com/repos/Msgaihede/mtg-grimoire/releases?per_page=30"
        );
        assert_eq!(
            releases_url("http://127.0.0.1:9"),
            format!("http://127.0.0.1:9/repos/{REPO}/releases?per_page={HISTORY_PER_PAGE}")
        );
    }

    /// **Three meanings, and only one of them is shown to the reader.**
    ///
    /// A browser gets exactly these codes from `api.github.com`, so classifying them twice
    /// would be one rule in two places. The rate-limit sentence is matched on the words the
    /// panel prints, and `note_github` classifies its own `error_log` row off the same
    /// phrase — a rewording here is a `Kind::Other` there.
    #[test]
    fn a_status_code_means_the_same_thing_on_both_targets() {
        assert_eq!(classify_status(200), Ok(PageStatus::Read));
        assert_eq!(classify_status(299), Ok(PageStatus::Read));
        // Not 200, and still a page rather than a refusal — the 2xx band is the test, and a
        // narrower one would turn a 204 into a banner.
        assert_eq!(classify_status(204), Ok(PageStatus::Read));
        assert_eq!(classify_status(404), Ok(PageStatus::Missing));
        for code in [403u16, 429] {
            let message = classify_status(code).unwrap_err();
            assert!(
                message.contains("rate limiting"),
                "{code} must say why, and `note_github` matches on that word: {message}"
            );
        }
        assert!(classify_status(500).unwrap_err().contains("500"));
        assert!(classify_status(301).unwrap_err().contains("301"));
        assert!(classify_status(199).unwrap_err().contains("199"));
    }

    /// A body that will not parse is a sentence about *GitHub's answer*, not about the disk.
    /// That distinction is the whole reason this is a function apart from [`record_check`].
    #[test]
    fn a_body_that_is_not_json_says_so_and_a_page_is_filtered_on_the_way_through() {
        let message = page_from_body("<html>502 Bad Gateway</html>").unwrap_err();
        assert!(message.contains("not readable JSON"), "{message}");

        // The draft and the prerelease are gone; the two real releases survive, newest first.
        let page = page_from_body(&live_page().to_string()).unwrap();
        assert_eq!(
            page.iter().map(|r| r.tag.as_str()).collect::<Vec<_>>(),
            ["v0.3.0", "v0.2.0"]
        );
        // A document that is not an array at all is an empty page rather than a failure —
        // `parse_release_page`'s rule, and the arm a hand-written proxy would land on.
        assert!(page_from_body("{}").unwrap().is_empty());
    }

    /// **What routing the check buys: `update_history` stops answering `[]`.**
    ///
    /// This is the browser's whole path below the `#[wasm_bindgen]` layer — a page in, three
    /// `app_meta` rows out, and the two already-routed read commands answering off them. Run
    /// with [`InstallKind::Web`] on purpose: the notice and the notes appear, and `asset`
    /// stays `None` because `pick_asset` refuses that kind, which is "check and notes, no
    /// download" expressed as a DTO rather than as a branch in the panel.
    #[test]
    fn recording_a_page_is_what_makes_the_history_and_the_notice_answer() {
        let (state, _dir) = file_state("record-check");
        assert!(
            history(&state).is_empty(),
            "nothing checked, nothing to show"
        );

        // Newer than whatever this build is, derived rather than written down —
        // `status_for` re-compares on every read, so a literal would rot at the next release.
        let major: u32 = current_version()
            .split('.')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let ahead = format!("{}.0.0", major + 1);
        let page = page_from_body(
            &serde_json::json!([
                {"tag_name": format!("v{ahead}"), "draft": false, "prerelease": false,
                 "published_at": "2026-08-31T00:00:00Z",
                 "html_url": "https://example.invalid/next",
                 "body": "### Features\n* what a browser is now allowed to read\n",
                 "assets": [{"name": format!("mtg-grimoire-{ahead}-windows-x64-portable.zip"),
                             "size": 6453913, "digest": "sha256:abc",
                             "browser_download_url": "https://example.invalid/p.zip"}]},
                {"tag_name": "v0.1.0", "draft": false, "prerelease": false,
                 "published_at": "2026-08-01T00:00:00Z",
                 "html_url": "https://example.invalid/first",
                 "body": "the first one", "assets": []}
            ])
            .to_string(),
        )
        .unwrap();

        {
            let conn = crate::sync::lock_db(&state);
            record_check(&conn, 1_800_000_000, &page).unwrap();
            assert_eq!(last_check_at(&conn), Some(1_800_000_000));
        }

        let notes = history(&state);
        assert_eq!(
            notes.iter().map(|n| n.version.as_str()).collect::<Vec<_>>(),
            [ahead.as_str(), "0.1.0"],
            "the history is the whole page, newest first"
        );
        assert!(notes[0]
            .notes
            .contains("what a browser is now allowed to read"));

        let web = status_for(&state, InstallKind::Web, false, false);
        assert_eq!(web.last_check_at.as_deref(), Some("1800000000"));
        assert_eq!(
            web.available.as_ref().map(|r| r.version.as_str()),
            Some(ahead.as_str())
        );
        assert!(
            web.asset.is_none(),
            "check and notes, no download: a browser is offered nothing to fetch"
        );
        // The same rows read as a portable install would read them, which is what says the
        // cache is the release rather than the target's opinion of it.
        let portable = status_for(&state, InstallKind::Portable, false, false);
        assert_eq!(portable.asset.map(|a| a.size), Some(6453913));
    }

    /// A check that finds nothing clears rather than leaving yesterday's answer standing
    /// under today's stamp — and it still stamps, because the check *ran*.
    ///
    /// Three ways to reach an empty page and they are deliberately one arm: a repository
    /// with no releases (`200 []`), one publishing nothing but drafts and prereleases, and
    /// [`PageStatus::Missing`], which passes `&[]` from the caller.
    #[test]
    fn recording_an_empty_page_clears_the_cache_and_still_stamps_the_check() {
        let (state, _dir) = file_state("record-empty");
        let page = page_from_body(&live_page().to_string()).unwrap();
        {
            let conn = crate::sync::lock_db(&state);
            record_check(&conn, 1_800_000_000, &page).unwrap();
            assert!(get_app_meta(&conn, K_LATEST_SEEN).is_some());
            assert!(get_app_meta(&conn, K_HISTORY).is_some());

            record_check(&conn, 1_800_009_999, &[]).unwrap();
            assert_eq!(
                get_app_meta(&conn, K_LATEST_SEEN),
                None,
                "an empty page must not leave the old release cached"
            );
            assert_eq!(get_app_meta(&conn, K_HISTORY), None);
            assert_eq!(last_check_at(&conn), Some(1_800_009_999));
        }
        assert!(history(&state).is_empty());
        assert!(status_for(&state, InstallKind::Web, false, false)
            .available
            .is_none());
    }

    /// A stamp that is missing, blank or not a number all read as "never", which
    /// [`should_check`] treats as due. Failing *open* is the only safe direction: the cost
    /// of a spurious check is one request out of sixty an hour.
    #[test]
    fn a_missing_or_unreadable_check_stamp_reads_as_never() {
        let (state, _dir) = file_state("stamp");
        let conn = crate::sync::lock_db(&state);
        assert_eq!(last_check_at(&conn), None);
        for junk in ["", "  ", "yesterday", "-1", "1800000000.5"] {
            set_app_meta(&conn, K_LAST_CHECK_AT, junk).unwrap();
            assert_eq!(last_check_at(&conn), None, "`{junk}` is not a stamp");
            assert!(should_check(last_check_at(&conn), 1_800_000_000, false));
        }
        set_app_meta(&conn, K_LAST_CHECK_AT, "1800000000").unwrap();
        assert_eq!(last_check_at(&conn), Some(1_800_000_000));
        assert!(!should_check(last_check_at(&conn), 1_800_000_001, false));
    }

    /// A real `AppState` on a real file: `check` reads the throttle through `db_read` and
    /// writes the cache through `db`, and an in-memory pair cannot stand in for that (two
    /// in-memory connections are two different databases). `sync::tests::file_state`'s
    /// arrangement, for its reason.
    fn file_state(name: &str) -> (Arc<AppState>, std::path::PathBuf) {
        use std::sync::atomic::AtomicBool;
        let dir = std::env::temp_dir().join(format!("mtgtest-update-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::split::convert(&dir).unwrap();
        let conn = crate::db::open_write(&dir).unwrap();
        let read = crate::db::open_read(&dir).unwrap();
        // **Hooked up, so what these fixtures drive runs with the cross-file fence
        // armed.** `crate::sync::with_write`'s `debug_assert` reads it, so a command
        // that committed to both files fails its own test rather than printing a line
        // nobody reads. The mask rides along because SQLite allows one update hook per
        // connection, and nothing here looks at it.
        let mirror = std::sync::Arc::new(crate::mirror::watch::Mask::default());
        let fence = std::sync::Arc::new(crate::db::CrossFileFence::new());
        crate::mirror::watch::install_hook(&conn, mirror.clone(), fence.clone());
        (
            Arc::new(AppState {
                db: Mutex::new(conn),
                db_read: Mutex::new(read),
                data_dir: dir.clone(),
                syncing: AtomicBool::new(false),
                client: crate::scryfall::Client::new("http://127.0.0.1:1".into()),
                images: crate::images::Cache::new(dir.join("images")),
                index: std::sync::RwLock::default(),
                // The mirror is never started in these tests; a clean mask and an empty record are
                // what an `AppState` looks like before the first pass.
                mirror,
                mirror_status: std::sync::Mutex::new(crate::mirror::watch::LastPass::default()),
                pairing: std::sync::Mutex::new(None),
                fence,
            }),
            dir,
        )
    }

    /// An `Updater` with its install kind forced, so a test does not depend on where the
    /// test binary happens to live.
    fn updater_at(base: String, kind: InstallKind) -> Arc<Updater> {
        let mut u = Updater::new(base, PathBuf::from("D:\\Apps\\mtg\\mtg-grimoire.exe"));
        u.kind = kind;
        Arc::new(u)
    }

    /// The whole check path over HTTP: the request GitHub actually receives, the answer
    /// parsed and cached, and the status the UI then reads without a second request.
    #[tokio::test]
    async fn a_check_stores_what_github_answered_and_the_status_reads_it_back() {
        let server = httpmock::MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method("GET")
                    .path(format!("/repos/{REPO}/releases"))
                    // One page, and the size is asked for explicitly rather than left to
                    // GitHub's default — the history the panel draws stops where this says.
                    .query_param("per_page", HISTORY_PER_PAGE.to_string())
                    // GitHub answers 403 without a User-Agent, so the header is not
                    // decoration — it is pinned here because it is easy to drop and the
                    // failure would only show in the field.
                    .header_exists("user-agent")
                    .header("Accept", "application/vnd.github+json");
                then.status(200)
                    .header("content-type", "application/json")
                    .json_body(serde_json::json!([{
                        "tag_name": "v9.9.9",
                        "draft": false,
                        "prerelease": false,
                        "published_at": "2026-08-09T04:02:20Z",
                        "html_url": "https://github.com/Msgaihede/mtg-grimoire/releases/tag/v9.9.9",
                        "body": "the notes",
                        "assets": [{
                            "name": "mtg-grimoire-9.9.9-windows-x64-portable.zip",
                            "size": 6453913,
                            "digest": "sha256:abc",
                            "browser_download_url": "https://example.invalid/p.zip"
                        }]
                    }, {
                        "tag_name": "v0.1.0",
                        "draft": false,
                        "prerelease": false,
                        "published_at": "2026-08-01T00:00:00Z",
                        "html_url": "https://github.com/Msgaihede/mtg-grimoire/releases/tag/v0.1.0",
                        "body": "the first one",
                        "assets": []
                    }]));
            })
            .await;

        let (state, dir) = file_state("check");
        let updater = updater_at(server.base_url(), InstallKind::Portable);

        let answered = check(&state, &updater, false).await.unwrap();
        mock.assert_async().await;

        let release = answered.available.expect("9.9.9 is newer than any build");
        assert_eq!(release.version, "9.9.9");
        assert_eq!(release.notes, "the notes");
        assert_eq!(
            answered.asset.map(|a| a.name).as_deref(),
            Some("mtg-grimoire-9.9.9-windows-x64-portable.zip")
        );
        assert!(answered.last_check_at.is_some());
        assert!(!answered.staged);
        // **The answer must not report itself as still running.** `status` reads the same
        // `busy` flag the guard holds, so a status built while the guard is alive says the
        // check that produced it is in flight — and the panel disables every control until
        // its next poll. Measured in the shipped window on 2026-08-09: the download
        // succeeded and "Restart to finish" arrived already disabled, which no unit test
        // saw because they all pass `busy` in by hand.
        assert!(
            !answered.busy,
            "a finished check must not answer that it is still running"
        );

        // ...and it survives without the server: this is what the ribbon reads at launch.
        let cached = status(&state, &updater);
        assert_eq!(
            cached.available.map(|r| r.version).as_deref(),
            Some("9.9.9")
        );

        // The same one request also left the version history behind, which is the whole
        // reason `/releases` replaced `/releases/latest`. `history` asks GitHub nothing.
        let past = history(&state);
        assert_eq!(
            past.iter().map(|r| r.version.as_str()).collect::<Vec<_>>(),
            ["9.9.9", "0.1.0"],
            "newest first, and the older release is there too"
        );
        assert_eq!(past[1].notes, "the first one");

        // A second, unforced check inside the window makes no request at all — the mock
        // would count a second hit.
        check(&state, &updater, false).await.unwrap();
        mock.assert_calls_async(1).await;

        drop(state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An MSI install, a Linux build: the release is still reported — the user should know
    /// a new version exists — but there is nothing for it to download.
    #[tokio::test]
    async fn an_install_kind_that_cannot_update_still_hears_about_the_release() {
        let server = httpmock::MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method("GET").path(format!("/repos/{REPO}/releases"));
                then.status(200).json_body(serde_json::json!([{
                    "tag_name": "v9.9.9",
                    "html_url": "https://github.com/Msgaihede/mtg-grimoire/releases/tag/v9.9.9",
                    "body": "",
                    "assets": [{
                        "name": "mtg-grimoire-9.9.9-windows-x64-portable.zip",
                        "size": 1, "digest": "sha256:abc",
                        "browser_download_url": "https://example.invalid/p.zip"
                    }]
                }]));
            })
            .await;

        let (state, dir) = file_state("other-kind");
        let updater = updater_at(server.base_url(), InstallKind::Other);

        let answered = check(&state, &updater, false).await.unwrap();
        assert!(answered.available.is_some(), "the notice is still shown");
        assert!(
            answered.asset.is_none(),
            "but nothing is offered for download"
        );

        drop(state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A repository with no published release is not an error the user can act on. It must
    /// still stamp the check, or every launch would ask again.
    ///
    /// **The shape of that answer changed with the endpoint**: `/releases/latest` answered
    /// 404, `/releases` answers `200 []`. Both arms are still here — the 404 one for a
    /// repository that is not there at all — and both must reach the same place.
    #[tokio::test]
    async fn a_repository_with_no_release_is_not_an_error() {
        for (name, status_code, body) in [
            ("empty-page", 200, serde_json::json!([])),
            (
                "not-found",
                404,
                serde_json::json!({"message": "Not Found"}),
            ),
        ] {
            let server = httpmock::MockServer::start_async().await;
            server
                .mock_async(|when, then| {
                    when.method("GET").path(format!("/repos/{REPO}/releases"));
                    then.status(status_code).json_body(body.clone());
                })
                .await;

            let (state, dir) = file_state(name);
            let updater = updater_at(server.base_url(), InstallKind::Portable);

            let answered = check(&state, &updater, false).await.unwrap();
            assert!(answered.available.is_none(), "{name}");
            assert!(
                answered.last_check_at.is_some(),
                "{name}: the check is stamped, or every launch asks again"
            );
            assert!(history(&state).is_empty(), "{name}");

            drop(state);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// **A check that could not write down what it learned says so, and the 404 arm does
    /// not.** That asymmetry is a real branch in `check_inner` and it was untested until
    /// 2026-08-31 — mutating it to swallow *every* failure left all 36 tests in this module
    /// green.
    ///
    /// A page that arrived and could not be recorded is worse than a failed request: the
    /// caller is handed a `status` built from `app_meta` rows that are not the ones the page
    /// described, and every later launch re-asks because the stamp never landed. The 404 arm
    /// has already decided to report success, so a failed write on the way out of it must not
    /// become a banner about a repository the reader does not own.
    ///
    /// Dropping `app_meta` is the cheapest way to make a write genuinely fail —
    /// `app_meta::tests`' own trick, one file over.
    #[tokio::test]
    async fn a_page_that_cannot_be_recorded_is_an_error_and_a_missing_repository_is_not() {
        for (name, status_code, body, must_fail) in [
            (
                "unwritable-page",
                200,
                serde_json::json!([{
                    "tag_name": "v9.9.9", "draft": false, "prerelease": false,
                    "html_url": "", "body": "the notes", "assets": []
                }]),
                true,
            ),
            (
                "unwritable-404",
                404,
                serde_json::json!({"message": "Not Found"}),
                false,
            ),
        ] {
            let server = httpmock::MockServer::start_async().await;
            server
                .mock_async(|when, then| {
                    when.method("GET").path(format!("/repos/{REPO}/releases"));
                    then.status(status_code).json_body(body.clone());
                })
                .await;

            let (state, dir) = file_state(name);
            {
                let conn = crate::sync::lock_db(&state);
                conn.execute("DROP TABLE app_meta", []).unwrap();
            }
            let updater = updater_at(server.base_url(), InstallKind::Portable);

            let answered = check(&state, &updater, true).await;
            assert_eq!(
                answered.is_err(),
                must_fail,
                "{name}: {:?}",
                answered.as_ref().err()
            );

            drop(state);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// A page of nothing but prereleases reads as "no releases", and — the part worth a test
    /// — **clears** what an earlier check left behind rather than leaving a stale history
    /// standing beside a `lastCheckAt` that says it was just refreshed.
    #[tokio::test]
    async fn a_later_check_that_finds_nothing_clears_what_an_earlier_one_cached() {
        let server = httpmock::MockServer::start_async().await;
        let first = server
            .mock_async(|when, then| {
                when.method("GET").path(format!("/repos/{REPO}/releases"));
                then.status(200).json_body(serde_json::json!([{
                    "tag_name": "v9.9.9", "draft": false, "prerelease": false,
                    "html_url": "", "body": "the notes", "assets": []
                }]));
            })
            .await;

        let (state, dir) = file_state("cleared");
        let updater = updater_at(server.base_url(), InstallKind::Portable);
        check(&state, &updater, true).await.unwrap();
        assert_eq!(history(&state).len(), 1);

        first.delete_async().await;
        server
            .mock_async(|when, then| {
                when.method("GET").path(format!("/repos/{REPO}/releases"));
                then.status(200).json_body(serde_json::json!([{
                    "tag_name": "v9.9.9-rc.2", "draft": false, "prerelease": true,
                    "html_url": "", "body": "a candidate", "assets": []
                }]));
            })
            .await;

        let answered = check(&state, &updater, true).await.unwrap();
        assert!(answered.available.is_none(), "a prerelease is not an offer");
        assert!(
            history(&state).is_empty(),
            "yesterday's history does not survive a check that found nothing"
        );

        drop(state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Rate limiting is the one HTTP failure a daily check can realistically hit — 60/hour
    /// per IP, shared with everything else on the machine — so it says so in words rather
    /// than surfacing a bare status code.
    #[tokio::test]
    async fn being_rate_limited_says_so_and_does_not_stamp_the_check() {
        let server = httpmock::MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method("GET").path(format!("/repos/{REPO}/releases"));
                then.status(403).body("rate limit exceeded");
            })
            .await;

        let (state, dir) = file_state("rate-limited");
        let updater = updater_at(server.base_url(), InstallKind::Portable);

        let err = check(&state, &updater, false).await.unwrap_err();
        assert!(err.contains("rate limiting"), "{err}");
        assert!(
            status(&state, &updater).last_check_at.is_none(),
            "a run that learned nothing has not checked"
        );

        drop(state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn app_meta_round_trips_and_a_missing_key_reads_as_none() {
        let conn = crate::schema::memory_pair();

        assert!(get_app_meta(&conn, K_LAST_CHECK_AT).is_none());
        set_app_meta(&conn, K_LAST_CHECK_AT, "1800000000").unwrap();
        assert_eq!(
            get_app_meta(&conn, K_LAST_CHECK_AT).as_deref(),
            Some("1800000000")
        );
        set_app_meta(&conn, K_LAST_CHECK_AT, "1800000001").unwrap();
        assert_eq!(
            get_app_meta(&conn, K_LAST_CHECK_AT).as_deref(),
            Some("1800000001"),
            "a second write updates rather than conflicting"
        );
        clear_app_meta(&conn, K_LAST_CHECK_AT).unwrap();
        assert!(get_app_meta(&conn, K_LAST_CHECK_AT).is_none());
    }

    /// A round trip through the cache, because that is how the ribbon knows about an update
    /// before any network call has been made in this session.
    #[test]
    fn the_cached_release_survives_a_round_trip_through_app_meta() {
        let conn = crate::schema::memory_pair();
        let release = parse_release(&live_payload()).unwrap();

        set_app_meta(
            &conn,
            K_LATEST_SEEN,
            &serde_json::to_string(&release).unwrap(),
        )
        .unwrap();
        let back: ReleaseInfo =
            serde_json::from_str(&get_app_meta(&conn, K_LATEST_SEEN).unwrap()).unwrap();

        assert_eq!(back.version, "0.2.0");
        assert_eq!(back.assets.len(), 5);
        assert_eq!(
            pick_asset(&back.assets, InstallKind::Nsis).unwrap().digest,
            Some("sha256:ef35c1863faa2193789350f68a27bed270db0ade678274e3c253e2d65a7f8040".into())
        );
    }
}
