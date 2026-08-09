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
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
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
const PORTABLE_EXE: &str = "mtg-grimoire.exe";

/// Refuse an asset larger than this before a byte is read. The Windows artifacts are
/// 4.8–6.5 MB; this is a bound on what a bad answer can make this process spend, not a
/// statement about the release.
const MAX_ASSET_BYTES: u64 = 256 * 1024 * 1024;

/// Bytes between `update:progress` events. A chunk-by-chunk callback fires far more often
/// than a progress bar can use.
const PROGRESS_EMIT_BYTES: u64 = 256 * 1024;

/// How long a freshly launched successor waits for the process it replaced to let go.
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
    /// The release body, as written. Plain text to the UI: markdown is a renderer this app
    /// does not have, and half-rendered markdown reads worse than none.
    pub notes: String,
    pub published_at: Option<String>,
    pub html_url: String,
    /// Every asset on the release. Stored whole rather than pre-filtered, so the pick can
    /// be re-made against the install kind without another request.
    pub assets: Vec<Asset>,
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

/// What a completed download left behind, and what [`apply`] will do with it.
#[derive(Clone, Debug)]
struct Staged {
    kind: InstallKind,
    /// For `Portable`, `<exe dir>/mtg-grimoire.exe.new`. For `Nsis`, the setup in
    /// `<data dir>/updates/`.
    path: PathBuf,
    version: String,
}

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

/// Clears `busy` however the operation ends.
struct BusyGuard<'a>(&'a AtomicBool);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Updater {
    pub fn new(api_base: String, exe: PathBuf) -> Updater {
        let kind = exe.parent().map_or(InstallKind::Other, detect_install_kind);
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

/// Read `app_meta`. A missing row and an unreadable one both read as `None`: this is cache
/// metadata, and the right response to losing it is to ask again.
pub fn get_app_meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM app_meta WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn set_app_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn clear_app_meta(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM app_meta WHERE key = ?1", params![key])?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------------------

/// Seconds since the Unix epoch. A clock before 1970 reads as 0, which makes every check
/// due — `sync::unix_now`'s rule.
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
        InstallKind::Other => return None,
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
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

// ---------------------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------------------

/// Parse `/releases/latest` into the shape the rest of the module uses.
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

/// Build the status from what is already known, touching nothing but the database.
///
/// This is what the ribbon reads at launch: the last seen release is cached in `app_meta`,
/// so a notice appears immediately rather than a network round trip later. The cache is
/// re-compared against the running version every time, which is what makes it
/// self-clearing — after an update lands, yesterday's cached release is no longer newer and
/// the notice goes away with no bookkeeping.
pub fn status(state: &AppState, updater: &Updater) -> UpdateStatus {
    let conn = crate::sync::lock_db_read(state);
    let last_check_at = get_app_meta(&conn, K_LAST_CHECK_AT);
    let cached: Option<ReleaseInfo> = get_app_meta(&conn, K_LATEST_SEEN)
        .and_then(|s| serde_json::from_str(&s).ok())
        .filter(|r: &ReleaseInfo| is_newer(&r.version, current_version()));
    drop(conn);

    let asset = cached
        .as_ref()
        .and_then(|r| pick_asset(&r.assets, updater.kind))
        .cloned();
    UpdateStatus {
        current_version: current_version().to_owned(),
        install_kind: updater.kind,
        available: cached,
        asset,
        last_check_at,
        busy: updater.busy.load(Ordering::SeqCst),
        staged: crate::sync::lock_plain(&updater.staged).is_some(),
    }
}

pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Ask GitHub for the latest release, honouring the 24 h throttle unless `force`.
pub async fn check(
    state: &Arc<AppState>,
    updater: &Arc<Updater>,
    force: bool,
) -> Result<UpdateStatus, String> {
    let now = unix_now();
    let last = {
        let conn = crate::sync::lock_db_read(state);
        get_app_meta(&conn, K_LAST_CHECK_AT).and_then(|s| s.parse::<u64>().ok())
    };
    if !should_check(last, now, force) {
        return Ok(status(state, updater));
    }
    let Some(_guard) = updater.claim() else {
        return Err("an update check is already running".into());
    };

    let url = format!("{}/repos/{REPO}/releases/latest", updater.api_base);
    let resp = updater
        .http
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("could not reach GitHub: {e}"))?;

    let code = resp.status().as_u16();
    if code == 404 {
        // A repository with no published release at all. Not an error the user can act on,
        // and not worth a banner — record the check and answer "nothing new".
        let conn = crate::sync::lock_db(state);
        let _ = set_app_meta(&conn, K_LAST_CHECK_AT, &now.to_string());
        let _ = clear_app_meta(&conn, K_LATEST_SEEN);
        drop(conn);
        return Ok(status(state, updater));
    }
    if code == 403 || code == 429 {
        return Err("GitHub is rate limiting update checks right now. Try again later.".into());
    }
    if !(200..300).contains(&code) {
        return Err(format!("GitHub answered {code} for the latest release."));
    }

    // `text()` and then `serde_json`, rather than `resp.json()`: the latter needs reqwest's
    // `json` feature, and this crate builds reqwest with `default-features = false` on
    // purpose. One less feature for one extra line.
    let body = resp
        .text()
        .await
        .map_err(|e| format!("could not read GitHub's answer: {e}"))?;
    let body: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("GitHub's answer was not readable JSON: {e}"))?;
    let release = parse_release(&body)?;

    {
        let conn = crate::sync::lock_db(state);
        set_app_meta(&conn, K_LAST_CHECK_AT, &now.to_string()).map_err(|e| e.to_string())?;
        // Cached whether or not it is newer: `status` re-compares against the running
        // version on every read, so storing it unconditionally keeps one rule instead of
        // two and makes the cache correct across an update without a clearing step.
        match serde_json::to_string(&release) {
            Ok(json) => set_app_meta(&conn, K_LATEST_SEEN, &json).map_err(|e| e.to_string())?,
            Err(_) => clear_app_meta(&conn, K_LATEST_SEEN).map_err(|e| e.to_string())?,
        }
    }
    Ok(status(state, updater))
}

// ---------------------------------------------------------------------------------------
// Downloading and staging
// ---------------------------------------------------------------------------------------

/// Download the asset this install kind needs, verify it, and stage it for [`apply`].
///
/// Nothing is swapped here and nothing is launched. A download that succeeds leaves the app
/// running exactly as it was, with one more file on disk.
pub async fn download(
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

    let Some(_guard) = updater.claim() else {
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
        InstallKind::Other => {
            let _ = std::fs::remove_file(&part);
            return Err("this kind of install cannot be updated from inside the app.".into());
        }
    };
    *crate::sync::lock_plain(&updater.staged) = Some(staged);
    Ok(status(state, updater))
}

/// Stream one asset to `dest`, hashing as it goes, and answer the digest.
///
/// The size bound is enforced against the running total rather than against
/// `Content-Length`: a header is a claim, and a chunked response makes no claim at all —
/// `scryfall::Client::download`'s rule, for its reason.
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
        InstallKind::Other => {
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

    std::process::Command::new(exe)
        .arg(AWAIT_FLAG)
        .spawn()
        .map_err(|e| format!("the update is installed, but it could not be started: {e}"))?;
    Ok(())
}

/// Wait for the process this build replaced to let go, before anything else initialises.
///
/// The wait is what stops the relaunch dying silently. `tauri-plugin-single-instance` gives
/// a second instance **exit code 0, no window and no stderr** — so a successor that starts
/// while its predecessor still holds the lock simply vanishes, and the user is left looking
/// at the old version with no sign that anything went wrong.
///
/// What it waits *on* needs no process handle and no new dependency: **Windows will not
/// delete a running exe image**, so the delete failing means the predecessor is alive and
/// the delete succeeding is both the proof it has gone and the cleanup itself.
///
/// Called before `tauri::Builder::default()`, because by the time a plugin has initialised
/// the decision has already been made.
pub fn await_predecessor(exe: &Path) {
    let old = sibling(exe, ".old");
    let deadline = std::time::Instant::now() + AWAIT_PREDECESSOR;
    loop {
        if !old.exists() || std::fs::remove_file(&old).is_ok() {
            return;
        }
        if std::time::Instant::now() >= deadline {
            eprintln!(
                "the previous version is still running after {}s; starting anyway.",
                AWAIT_PREDECESSOR.as_secs()
            );
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Clear what an update left beside the exe: the replaced build, and any staged one that
/// was downloaded and never applied.
///
/// Runs on every launch, and is a no-op on nearly all of them. The staged file goes too —
/// staging lives for one session by design, and a `.new` of unknown provenance is not
/// something a later launch should quietly install.
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

        // ...and the successor's wait is also the cleanup.
        await_predecessor(&exe);
        assert!(
            !old.exists(),
            "the replaced build is deleted by the successor"
        );

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

        // The three install kinds are a closed union on the other side too.
        for (kind, name) in [
            (InstallKind::Portable, "portable"),
            (InstallKind::Nsis, "nsis"),
            (InstallKind::Other, "other"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), name);
        }
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

    /// A real `AppState` on a real file: `check` reads the throttle through `db_read` and
    /// writes the cache through `db`, and an in-memory pair cannot stand in for that (two
    /// in-memory connections are two different databases). `sync::tests::file_state`'s
    /// arrangement, for its reason.
    fn file_state(name: &str) -> (Arc<AppState>, std::path::PathBuf) {
        use std::sync::atomic::AtomicBool;
        let dir = std::env::temp_dir().join(format!("mtgtest-update-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mtg.db");
        let conn = crate::db::open(&path).unwrap();
        crate::schema::migrate(&conn).unwrap();
        let read = crate::db::open_read_only(&path).unwrap();
        (
            Arc::new(AppState {
                db: Mutex::new(conn),
                db_read: Mutex::new(read),
                data_dir: dir.clone(),
                syncing: AtomicBool::new(false),
                client: crate::scryfall::Client::new("http://127.0.0.1:1".into()),
                images: crate::images::Cache::new(dir.join("images")),
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
                    .path(format!("/repos/{REPO}/releases/latest"))
                    // GitHub answers 403 without a User-Agent, so the header is not
                    // decoration — it is pinned here because it is easy to drop and the
                    // failure would only show in the field.
                    .header_exists("user-agent")
                    .header("Accept", "application/vnd.github+json");
                then.status(200)
                    .header("content-type", "application/json")
                    .json_body(serde_json::json!({
                        "tag_name": "v9.9.9",
                        "published_at": "2026-08-09T04:02:20Z",
                        "html_url": "https://github.com/Msgaihede/mtg-grimoire/releases/tag/v9.9.9",
                        "body": "the notes",
                        "assets": [{
                            "name": "mtg-grimoire-9.9.9-windows-x64-portable.zip",
                            "size": 6453913,
                            "digest": "sha256:abc",
                            "browser_download_url": "https://example.invalid/p.zip"
                        }]
                    }));
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

        // ...and it survives without the server: this is what the ribbon reads at launch.
        let cached = status(&state, &updater);
        assert_eq!(
            cached.available.map(|r| r.version).as_deref(),
            Some("9.9.9")
        );

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
                when.method("GET")
                    .path(format!("/repos/{REPO}/releases/latest"));
                then.status(200).json_body(serde_json::json!({
                    "tag_name": "v9.9.9",
                    "html_url": "https://github.com/Msgaihede/mtg-grimoire/releases/tag/v9.9.9",
                    "body": "",
                    "assets": [{
                        "name": "mtg-grimoire-9.9.9-windows-x64-portable.zip",
                        "size": 1, "digest": "sha256:abc",
                        "browser_download_url": "https://example.invalid/p.zip"
                    }]
                }));
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
    #[tokio::test]
    async fn a_repository_with_no_release_is_not_an_error() {
        let server = httpmock::MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method("GET")
                    .path(format!("/repos/{REPO}/releases/latest"));
                then.status(404)
                    .json_body(serde_json::json!({"message": "Not Found"}));
            })
            .await;

        let (state, dir) = file_state("no-release");
        let updater = updater_at(server.base_url(), InstallKind::Portable);

        let answered = check(&state, &updater, false).await.unwrap();
        assert!(answered.available.is_none());
        assert!(
            answered.last_check_at.is_some(),
            "the check is stamped, or every launch asks again"
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
                when.method("GET")
                    .path(format!("/repos/{REPO}/releases/latest"));
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
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();

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
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
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
