//! The card scanner inside the app: the crate's [`Session`] behind its commands, and the
//! reader's scanner preferences and review tray beside them.
//!
//! **Its own managed state, not a field on `AppState`.** It is optional and desktop/Android
//! only, it loads lazily, and the only thing it shares with the rest of the app is the data
//! directory and one read of `corpus.db` for labels. `app.manage` holds it beside `AppState`.
//! The two exceptions are [`scanner_prefs`] and [`scanner_tray`] (and their setters), which are
//! `app_meta` rows and so take `AppState` like every other stored preference — they touch no
//! session and must answer before the session has loaded.
//!
//! **Assets load per asset, first hit wins: a file in `data/scanner/`, then the copy compiled
//! into the binary, then absent.** A release build embeds all three under `cfg(scanner_assets)`
//! (`build.rs` sets it when `src-tauri/scanner-assets/` holds them); a file placed in
//! `data/scanner/` overrides the embedded copy so a new bundle can be tried without a rebuild.
//! Nothing here downloads. A missing bundle is a session that detects and rectifies and names
//! nothing — the debug server's behaviour — and a missing model pair is a session with no reader.
//! [`scanner_status`] reports the exact path it looked at for each, and [`Asset::source`] says
//! which of the three answered, so "no bundle" is never the whole message.
//!
//! **[`scanner_frame`] is the one command that takes a raw body.** On desktop the JPEG is the
//! request body and the options are a header; on Android Tauri carries no raw bytes
//! (`tauri::ipc::Request`'s own doc: "on all platforms except Android"), so the same command
//! also accepts `{ "jpeg": "<base64>", "options": {…} }` as ordinary arguments. Both land in
//! [`frame_payload`], which is the whole difference.
//!
//! **The seventh connection.** Labels are loaded on a read-only connection opened for the
//! load and dropped after — never `AppState.db_read`, the rule the mirror thread and
//! `Rebuild now` already follow, because a 117k-row read on the shared read connection queues
//! every search behind it. It opens `corpus.db` *directly* rather than the pair
//! [`crate::db::open_read`] does, because `Reference::load_labels` reads an unqualified
//! `FROM cards` — the corpus is `main` here, and there is nothing on the user side to attach.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use base64::Engine as _;
use card_scanner::filters::ScanFilters;
use card_scanner::index::Bundle;
use card_scanner::ocr::TitleReader;
use card_scanner::reference::Reference;
use card_scanner::session::{FrameOptions, ScanMode, Session, Verdict};
use rusqlite::Connection;
use tauri::http::HeaderMap;
use tauri::ipc::InvokeBody;

use crate::sync::AppState;

pub const BUNDLE_FILE: &str = "card-hashes.bin";
pub const DETECTION_MODEL: &str = "models/text-detection.rten";
pub const RECOGNITION_MODEL: &str = "models/text-recognition.rten";
/// The header a desktop frame carries its `FrameOptions` in, as JSON.
pub const OPTIONS_HEADER: &str = "x-scanner-options";
/// The header a desktop capture carries its `Sidecar` in, as JSON.
pub const CAPTURE_HEADER: &str = "x-scanner-capture";
/// Candidates per frame — the debug server's `--top` default.
const TOP: usize = 5;

/// The `app_meta` key holding [`ScannerPrefs`], one JSON document written whole. Not synced: a
/// scanner's mode and defaults are about the device in the reader's hand.
pub const K_SCANNER_PREFS: &str = "scanner_prefs";
/// The `app_meta` key holding the review tray, one JSON array written whole. Not synced either:
/// the tray is a session's worth of cards not yet in the collection, and it reaches another
/// device only once it has been committed — as ordinary collection rows.
pub const K_SCANNER_TRAY: &str = "scanner_tray";
/// The most rows [`store_tray`] keeps. Far past a real scanning session; a fence against a loop
/// minting rows, not a limit anybody scanning reaches.
pub const MAX_TRAY_ROWS: usize = 5_000;
/// A tray row holding no copy is a row the commit would refuse — refused at the write instead,
/// where the page can still say so beside the row.
pub const TRAY_ROW_NEEDS_A_COPY: &str = "A tray row needs at least one copy.";
/// [`MAX_TRAY_ROWS`], in words.
pub const TRAY_IS_FULL: &str =
    "The tray holds at most 5,000 rows — add these to the collection first.";

/// Where an asset came from — [`load`]'s order, first hit wins.
///
/// `File` also covers a file that is there and did **not** parse: the reader placed it, so its
/// error is the answer, and quietly falling back to the embedded copy would hide exactly the file
/// they are trying to test. `Absent` is "nothing to load anywhere".
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetSource {
    File,
    Embedded,
    Absent,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Asset {
    /// The file this load looked at in `data/scanner/` — named even when the asset came out of
    /// the binary or from nowhere, so the "put it here" sentence always has a path to name.
    pub path: String,
    /// There was something to load: the file exists, or (for `Embedded`) the binary carries it.
    pub present: bool,
    pub loaded: bool,
    pub error: Option<String>,
    pub source: AssetSource,
}

/// The assets compiled into this binary, if any.
///
/// **A struct passed to [`load`] rather than a `cfg!` inside it**, the `bool`-parameter rule
/// `src-tauri/CLAUDE.md` states for every `cfg`: both arms of the load order compile and are
/// tested on every build, whether or not this one embedded anything.
#[derive(Debug, Clone, Copy, Default)]
pub struct Embedded {
    pub bundle: Option<&'static [u8]>,
    /// Detection, then recognition. A pair because the models load as one or not at all.
    pub models: Option<(&'static [u8], &'static [u8])>,
}

#[cfg(scanner_assets)]
const EMBEDDED_BUNDLE: &[u8] = include_bytes!("../scanner-assets/card-hashes.bin");
#[cfg(scanner_assets)]
const EMBEDDED_DETECTION: &[u8] = include_bytes!("../scanner-assets/text-detection.rten");
#[cfg(scanner_assets)]
const EMBEDDED_RECOGNITION: &[u8] = include_bytes!("../scanner-assets/text-recognition.rten");

impl Embedded {
    /// Nothing embedded — a build without `src-tauri/scanner-assets/`, and every test that is
    /// about files.
    pub fn none() -> Embedded {
        Embedded {
            bundle: None,
            models: None,
        }
    }

    /// What this build carries. `build.rs` sets `cfg(scanner_assets)` only when all three files
    /// are present, so a bundle is never embedded without its models or the reverse.
    #[cfg(scanner_assets)]
    pub fn compiled() -> Embedded {
        Embedded {
            bundle: Some(EMBEDDED_BUNDLE),
            models: Some((EMBEDDED_DETECTION, EMBEDDED_RECOGNITION)),
        }
    }

    /// What this build carries: nothing, because `src-tauri/scanner-assets/` was not filled.
    #[cfg(not(scanner_assets))]
    pub fn compiled() -> Embedded {
        Embedded::none()
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScannerStatus {
    pub bundle: Asset,
    pub detection_model: Asset,
    pub recognition_model: Asset,
    /// Labels loaded from `corpus.db`; 0 when there is no bundle to label.
    pub labels: usize,
    /// Where [`scanner_capture`] writes — the same names and sidecar as the debug server's.
    pub scans_dir: String,
}

/// What the panel said at the moment of capture, verbatim, beside what the reader typed.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Sidecar {
    pub expected: String,
    pub reported: String,
    pub confidence: String,
    pub votes: String,
    pub distance: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Captured {
    pub saved: String,
}

pub struct Loaded {
    pub session: Session,
    pub status: ScannerStatus,
}

pub struct ScannerState {
    data_dir: PathBuf,
    loaded: Mutex<Option<Loaded>>,
}

impl ScannerState {
    pub fn new(data_dir: PathBuf) -> ScannerState {
        ScannerState {
            data_dir,
            loaded: Mutex::new(None),
        }
    }

    fn dir(&self) -> PathBuf {
        self.data_dir.join("scanner")
    }

    /// The session, loading it on first use. Held for the length of one frame.
    fn ensure(&self) -> Result<MutexGuard<'_, Option<Loaded>>, String> {
        let mut guard = self
            .loaded
            .lock()
            .map_err(|_| "the scanner state is poisoned".to_string())?;
        if guard.is_none() {
            *guard = Some(load(
                &self.dir(),
                &self.data_dir.join(crate::db::CORPUS_DB),
                TOP,
                Embedded::compiled(),
            ));
        }
        Ok(guard)
    }
}

/// The file at `path`, before anything has been read: `File` when it exists, `Absent` when it
/// does not. [`load`] moves an absent one to `Embedded` when the binary carries it.
fn asset(path: &Path) -> Asset {
    let present = path.is_file();
    Asset {
        path: path.display().to_string(),
        present,
        loaded: false,
        error: None,
        source: if present {
            AssetSource::File
        } else {
            AssetSource::Absent
        },
    }
}

/// Read the assets and build the session. Every failure is a sentence on its asset, never an
/// error out of here: the page is useful without a bundle, and it says which file is missing.
///
/// **Per asset, first hit wins: the file in `dir`, then `embedded`, then absent.** The models
/// stay a pair — they are `File` only when **both** files exist; one file alone falls through to
/// the embedded pair (or to nothing), because a lone model reads nothing.
pub fn load(dir: &Path, corpus: &Path, top: usize, embedded: Embedded) -> Loaded {
    let bundle_path = dir.join(BUNDLE_FILE);
    let mut bundle = asset(&bundle_path);
    let bytes: Option<Result<Cow<'static, [u8]>, String>> = if bundle.present {
        Some(
            std::fs::read(&bundle_path)
                .map(Cow::Owned)
                .map_err(|e| e.to_string()),
        )
    } else if let Some(b) = embedded.bundle {
        bundle.present = true;
        bundle.source = AssetSource::Embedded;
        Some(Ok(Cow::Borrowed(b)))
    } else {
        None
    };
    let mut labels = 0;
    let reference = match bytes {
        None => None,
        Some(read) => match read.and_then(|b| Bundle::from_bytes(&b).map_err(|e| e.to_string())) {
            Ok(b) => {
                bundle.loaded = true;
                let mut reference = Reference::new(b);
                // **A bundle that loaded and labels that did not is its own state, and the
                // page draws a different sentence for it** — matching still works and answers
                // ids, so `Asset::error` beside `loaded: true` is what says so. An absent
                // `corpus.db` used to leave that field `None`, which made a nameless scanner
                // indistinguishable from a working one; the sentence names the path for the
                // reason every other sentence here does.
                if corpus.is_file() {
                    match rusqlite::Connection::open_with_flags(
                        corpus,
                        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                            | rusqlite::OpenFlags::SQLITE_OPEN_URI,
                    )
                    .and_then(|conn| reference.load_labels(&conn))
                    {
                        Ok(n) => labels = n,
                        Err(e) => bundle.error = Some(format!("labels: {e}")),
                    }
                } else {
                    bundle.error = Some(format!(
                        "labels: corpus.db not found at {}",
                        corpus.display()
                    ));
                }
                Some(reference)
            }
            Err(e) => {
                bundle.error = Some(e);
                None
            }
        },
    };

    let det_path = dir.join(DETECTION_MODEL);
    let rec_path = dir.join(RECOGNITION_MODEL);
    let mut detection_model = asset(&det_path);
    let mut recognition_model = asset(&rec_path);
    let attempt = if detection_model.present && recognition_model.present {
        Some(TitleReader::load(&det_path, &rec_path))
    } else if let Some((det, rec)) = embedded.models {
        // A lone file on disk does not survive this: the pair came out of the binary, so both
        // assets say so, and a reader who placed one file sees `embedded` rather than a path
        // that half-worked.
        for model in [&mut detection_model, &mut recognition_model] {
            model.present = true;
            model.source = AssetSource::Embedded;
        }
        Some(TitleReader::from_bytes(det, rec))
    } else {
        None
    };
    let reader = match attempt {
        None => None,
        Some(Ok(r)) => {
            detection_model.loaded = true;
            recognition_model.loaded = true;
            Some(r)
        }
        Some(Err(e)) => {
            let s = e.to_string();
            detection_model.error = Some(s.clone());
            recognition_model.error = Some(s);
            None
        }
    };

    Loaded {
        session: Session::new(reference, reader, top),
        status: ScannerStatus {
            bundle,
            detection_model,
            recognition_model,
            labels,
            scans_dir: dir.join("scans").display().to_string(),
        },
    }
}

/// How the reader last left the scanner: the mode, the filters, what a new tray row defaults to,
/// and whether the developer panels are showing. One `app_meta` row, written whole.
///
/// **`finish` and `condition` are strings here and `Finish`/`Condition` on the page**, and they
/// are not validated on write: they are the defaults a tray row is *born* with, and the commit
/// through `collection_import_commit` is where a grade or a finish the collection does not know is
/// refused, in its own words. Language is deliberately absent (spec §3 decision 7): a tray row
/// records none and the collection row takes the import's default.
///
/// `#[serde(default)]` on the struct, so a row written by an older build with fewer fields — or a
/// newer one's missing a field this build has — reads with the rest intact.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScannerPrefs {
    pub mode: ScanMode,
    /// Snake case inside, because [`ScanFilters`] is the crate's and the debug page reads it too.
    pub filters: ScanFilters,
    pub finish: String,
    pub condition: String,
    /// The folder a commit files into; `None` is the collection's root.
    pub folder_id: Option<i64>,
    pub developer: bool,
}

impl Default for ScannerPrefs {
    fn default() -> ScannerPrefs {
        ScannerPrefs {
            mode: ScanMode::default(),
            filters: ScanFilters::default(),
            // `schema::FINISHES` is read by index, never respelled.
            finish: crate::schema::FINISHES[0].to_owned(),
            // What a write that names no grade records — not the sentinel, though today they
            // hold one string; see `collection.rs`.
            condition: crate::collection::DEFAULT_CONDITION.to_owned(),
            folder_id: None,
            developer: false,
        }
    }
}

/// One printing a tray row could be — an `Ambiguous` resolve's candidates, kept on the row so the
/// reader can pick among them after the camera has moved on.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScannerTrayChoice {
    pub card_id: String,
    pub oracle_id: Option<String>,
    pub name: String,
    pub set_code: String,
    pub collector_number: String,
}

/// One card waiting in the review tray.
///
/// **The row the page built, stored as the page sent it.** `key` is the page's own stable id for
/// the row; `choices` is non-empty only while the row is still a choice to make; `added_at` is
/// the page's clock in milliseconds, used for nothing here but kept so a restored tray orders the
/// way it did.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScannerTrayRow {
    pub key: String,
    pub card_id: String,
    pub oracle_id: Option<String>,
    pub name: String,
    pub set_code: String,
    pub collector_number: String,
    pub finish: String,
    pub quantity: i64,
    pub choices: Vec<ScannerTrayChoice>,
    pub added_at: i64,
}

/// The reader's scanner preferences, or the defaults.
///
/// **Every failure is the default** — no row, a row that is not JSON, a row holding the wrong
/// shape — `home::stored`'s read rule: none of those is worth failing over, and all of them mean
/// nothing usable was stored.
pub fn stored_prefs(conn: &Connection) -> ScannerPrefs {
    crate::app_meta::get_app_meta(conn, K_SCANNER_PREFS)
        .and_then(|raw| serde_json::from_str::<ScannerPrefs>(&raw).ok())
        .unwrap_or_default()
}

/// Remember the reader's scanner preferences.
pub fn store_prefs(conn: &Connection, prefs: &ScannerPrefs) -> Result<(), String> {
    let json = serde_json::to_string(prefs)
        .map_err(|e| format!("could not save the scanner settings: {e}"))?;
    crate::app_meta::set_app_meta(conn, K_SCANNER_PREFS, &json)
        .map_err(|e| format!("could not save the scanner settings: {e}"))
}

/// The review tray as it was last written, or an empty one.
///
/// **An unreadable tray is an empty tray, never an error** — the page opens on it before the
/// camera starts, and a scanner that refused to open over a damaged row would cost the reader the
/// scanner as well as the tray.
pub fn stored_tray(conn: &Connection) -> Vec<ScannerTrayRow> {
    crate::app_meta::get_app_meta(conn, K_SCANNER_TRAY)
        .and_then(|raw| serde_json::from_str::<Vec<ScannerTrayRow>>(&raw).ok())
        .unwrap_or_default()
}

/// Remember the review tray, whole.
///
/// Two refusals, both before `app_meta` is touched so a refused write leaves the stored tray
/// exactly as it was: more than [`MAX_TRAY_ROWS`] rows ([`TRAY_IS_FULL`]), and any row holding
/// fewer than one copy ([`TRAY_ROW_NEEDS_A_COPY`]) — a row of nothing is a row the commit would
/// refuse, so it is refused where the page can still fix it.
pub fn store_tray(conn: &Connection, rows: &[ScannerTrayRow]) -> Result<(), String> {
    if rows.len() > MAX_TRAY_ROWS {
        return Err(TRAY_IS_FULL.to_owned());
    }
    if rows.iter().any(|row| row.quantity < 1) {
        return Err(TRAY_ROW_NEEDS_A_COPY.to_owned());
    }
    let json =
        serde_json::to_string(rows).map_err(|e| format!("could not save the scanner tray: {e}"))?;
    crate::app_meta::set_app_meta(conn, K_SCANNER_TRAY, &json)
        .map_err(|e| format!("could not save the scanner tray: {e}"))
}

/// The frame and its options, from either body shape. See the module doc.
pub fn frame_payload(
    body: &InvokeBody,
    headers: &HeaderMap,
) -> Result<(Vec<u8>, FrameOptions), String> {
    match body {
        InvokeBody::Raw(bytes) => {
            let opts = headers
                .get(OPTIONS_HEADER)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();
            Ok((bytes.clone(), opts))
        }
        InvokeBody::Json(value) => {
            let jpeg = value
                .get("jpeg")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "the frame has no `jpeg` field".to_string())?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(jpeg)
                .map_err(|e| format!("the frame's base64 did not decode: {e}"))?;
            let opts = value
                .get("options")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| format!("the frame's options did not parse: {e}"))?
                .unwrap_or_default();
            Ok((bytes, opts))
        }
    }
}

/// The capture and its sidecar, from either body shape.
///
/// **A sidecar header that is there and unreadable is a refusal, where an unreadable options
/// header in [`frame_payload`] is a shrug — and the asymmetry is the point.** A defaulted
/// slider costs one frame out of thirty and the next one corrects it; a defaulted sidecar
/// writes a JPEG to disk with five empty fields and reports success, which is an *unlabelled*
/// capture the reader believes they labelled — the one thing the dataset cannot recover from
/// later. An **absent** header still means [`Sidecar::default`], because capturing without
/// typing a name is a thing the reader chooses. `HeaderValue::to_str` is what fails here:
/// it refuses any byte outside visible ASCII, so the page escapes non-ASCII as `\uXXXX`
/// before it puts this JSON on the wire.
fn capture_payload(body: &InvokeBody, headers: &HeaderMap) -> Result<(Vec<u8>, Sidecar), String> {
    match body {
        InvokeBody::Raw(bytes) => {
            let sidecar = match headers.get(CAPTURE_HEADER) {
                Some(value) => {
                    let text = value
                        .to_str()
                        .map_err(|e| format!("the capture's sidecar did not parse: {e}"))?;
                    serde_json::from_str(text)
                        .map_err(|e| format!("the capture's sidecar did not parse: {e}"))?
                }
                None => Sidecar::default(),
            };
            Ok((bytes.clone(), sidecar))
        }
        InvokeBody::Json(value) => {
            let jpeg = value
                .get("jpeg")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "the capture has no `jpeg` field".to_string())?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(jpeg)
                .map_err(|e| format!("the capture's base64 did not decode: {e}"))?;
            let sidecar = value
                .get("sidecar")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| format!("the capture's sidecar did not parse: {e}"))?
                .unwrap_or_default();
            Ok((bytes, sidecar))
        }
    }
}

/// `live-<epoch>.jpg` and its `.json`, the debug server's names and fields, so a frame captured
/// here can be copied into `docs/scanner/scans/` unchanged.
pub fn write_capture(scans: &Path, jpeg: &[u8], sidecar: &Sidecar) -> Result<Captured, String> {
    if jpeg.is_empty() {
        return Err("empty frame".into());
    }
    std::fs::create_dir_all(scans).map_err(|e| format!("{}: {e}", scans.display()))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = format!("live-{stamp}.jpg");
    let jpg = scans.join(&name);
    std::fs::write(&jpg, jpeg).map_err(|e| format!("{}: {e}", jpg.display()))?;
    let json = serde_json::json!({
        "captured_at_epoch": stamp,
        "image": name,
        "expected": sidecar.expected,
        "reported": sidecar.reported,
        "confidence": sidecar.confidence,
        "votes": sidecar.votes,
        "distance": sidecar.distance,
    });
    let side = jpg.with_extension("json");
    std::fs::write(&side, serde_json::to_vec_pretty(&json).unwrap_or_default())
        .map_err(|e| format!("{}: {e}", side.display()))?;
    Ok(Captured { saved: name })
}

#[tauri::command]
pub async fn scanner_status(
    state: tauri::State<'_, Arc<ScannerState>>,
) -> Result<ScannerStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = state.ensure()?;
        Ok(guard.as_ref().expect("ensured").status.clone())
    })
    .await
    .map_err(|e| format!("the scanner thread failed: {e}"))?
}

#[tauri::command]
pub async fn scanner_frame(
    state: tauri::State<'_, Arc<ScannerState>>,
    request: tauri::ipc::Request<'_>,
) -> Result<Verdict, String> {
    let (jpeg, opts) = frame_payload(request.body(), request.headers())?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = state.ensure()?;
        Ok(guard.as_mut().expect("ensured").session.frame(&jpeg, &opts))
    })
    .await
    .map_err(|e| format!("the scanner thread failed: {e}"))?
}

#[tauri::command]
pub async fn scanner_reset(state: tauri::State<'_, Arc<ScannerState>>) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = state.ensure()?;
        guard.as_mut().expect("ensured").session.reset();
        Ok(())
    })
    .await
    .map_err(|e| format!("the scanner thread failed: {e}"))?
}

#[tauri::command]
pub async fn scanner_capture(
    state: tauri::State<'_, Arc<ScannerState>>,
    request: tauri::ipc::Request<'_>,
) -> Result<Captured, String> {
    let (jpeg, sidecar) = capture_payload(request.body(), request.headers())?;
    let scans = state.dir().join("scans");
    tauri::async_runtime::spawn_blocking(move || write_capture(&scans, &jpeg, &sidecar))
        .await
        .map_err(|e| format!("the scanner thread failed: {e}"))?
}

/// Narrow every later frame to these sets and release dates. Loads the session if this is the
/// first scanner command, because the mask is built from the loaded labels.
///
/// **The crate's sentence is the command's error, verbatim** — no labels to filter by, or filters
/// that match no printing — and a refusal keeps the previous filters in force.
#[tauri::command]
pub async fn scanner_set_filters(
    state: tauri::State<'_, Arc<ScannerState>>,
    filters: ScanFilters,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = state.ensure()?;
        guard
            .as_mut()
            .expect("ensured")
            .session
            .set_filters(filters)
    })
    .await
    .map_err(|e| format!("the scanner thread failed: {e}"))?
}

/// The reader's scanner preferences, or the defaults. **Infallible by signature**,
/// `home::home_layout`'s contract: the page seeds its controls from this and has nothing better
/// to do with an error than draw the defaults it already has. `(async)` for that command's reason
/// — a sync body would take `db_read`'s mutex on the IPC thread.
#[tauri::command(async)]
pub fn scanner_prefs(state: tauri::State<'_, Arc<AppState>>) -> ScannerPrefs {
    stored_prefs(&crate::sync::lock_db_read(state.inner()))
}

/// Remember the reader's scanner preferences. Answers [`crate::db::BUSY`] if a sync holds the
/// write connection.
#[tauri::command]
pub async fn set_scanner_prefs(
    state: tauri::State<'_, Arc<AppState>>,
    prefs: ScannerPrefs,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store_prefs(conn, &prefs))
    })
    .await
    .map_err(|e| format!("the scanner settings could not be saved: {e}"))?
}

/// The review tray as it was last written, or an empty one. Infallible, for [`scanner_prefs`]'
/// reason.
#[tauri::command(async)]
pub fn scanner_tray(state: tauri::State<'_, Arc<AppState>>) -> Vec<ScannerTrayRow> {
    stored_tray(&crate::sync::lock_db_read(state.inner()))
}

/// Remember the review tray, whole. The two refusals are [`store_tray`]'s; a busy write connection
/// answers [`crate::db::BUSY`].
#[tauri::command]
pub async fn set_scanner_tray(
    state: tauri::State<'_, Arc<AppState>>,
    rows: Vec<ScannerTrayRow>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store_tray(conn, &rows))
    })
    .await
    .map_err(|e| format!("the scanner tray could not be saved: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_meta::set_app_meta;
    use tauri::http::HeaderMap;
    use tauri::ipc::InvokeBody;

    /// A valid bundle with no entries, as bytes that live as long as the test binary — the shape
    /// [`Embedded::bundle`] takes.
    fn tiny_bundle() -> &'static [u8] {
        Box::leak(
            card_scanner::index::BundleBuilder::new(
                card_scanner::hash::HashKind::DHashChroma32,
                256,
            )
            .finish(0)
            .to_bytes()
            .into_boxed_slice(),
        )
    }

    /// The table [`K_SCANNER_PREFS`] and [`K_SCANNER_TRAY`] live in, as `schema.rs` builds it —
    /// `home.rs`' own test helper. Nothing here reads a second table.
    fn meta() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute(
            "CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        c
    }

    fn tray_row(key: &str, quantity: i64) -> ScannerTrayRow {
        ScannerTrayRow {
            key: key.into(),
            card_id: "f29ba16f-c8fb-42fe-aabf-87089cb214a7".into(),
            oracle_id: Some("4457ed35-7c10-48c8-9776-456485fdf070".into()),
            name: "Lightning Bolt".into(),
            set_code: "2x2".into(),
            collector_number: "117".into(),
            finish: "nonfoil".into(),
            quantity,
            choices: vec![ScannerTrayChoice {
                card_id: "b14fae63-2e82-49c1-8e62-d84a65f27479".into(),
                oracle_id: Some("4457ed35-7c10-48c8-9776-456485fdf070".into()),
                name: "Lightning Bolt".into(),
                set_code: "sta".into(),
                collector_number: "105".into(),
            }],
            added_at: 1_757_900_000_000,
        }
    }

    /// The load order's first rung. The embedded bytes are deliberately **not** a bundle, so a
    /// `loaded` asset proves the file's bytes were the ones parsed — `source` alone would only
    /// prove which branch set the word.
    #[test]
    fn a_file_beats_the_embedded_copy_and_says_so() {
        let dir = tempfile::tempdir().expect("tempdir");
        let scanner = dir.path().join("scanner");
        std::fs::create_dir_all(&scanner).expect("mkdir");
        std::fs::write(scanner.join(BUNDLE_FILE), tiny_bundle()).expect("write");
        let l = load(
            &scanner,
            &dir.path().join("corpus.db"),
            5,
            Embedded {
                bundle: Some(&b"not a bundle"[..]),
                models: None,
            },
        );
        assert_eq!(l.status.bundle.source, AssetSource::File);
        assert!(l.status.bundle.present && l.status.bundle.loaded);
        assert!(l.status.bundle.path.ends_with(BUNDLE_FILE));
    }

    #[test]
    fn with_no_file_the_embedded_bundle_loads() {
        let dir = tempfile::tempdir().expect("tempdir");
        let scanner = dir.path().join("scanner");
        let l = load(
            &scanner,
            &dir.path().join("corpus.db"),
            5,
            Embedded {
                bundle: Some(tiny_bundle()),
                models: None,
            },
        );
        let b = &l.status.bundle;
        assert_eq!(b.source, AssetSource::Embedded);
        assert!(b.present && b.loaded, "{b:?}");
        // Still the path a file would override it from, so the developer panel can say where.
        assert!(b.path.ends_with(BUNDLE_FILE), "{}", b.path);
        assert!(l.session.has_reference());
        // No models were embedded, so the pair is absent — per asset, not all or nothing.
        assert_eq!(l.status.detection_model.source, AssetSource::Absent);
    }

    #[test]
    fn nothing_anywhere_is_absent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let l = load(
            &dir.path().join("scanner"),
            &dir.path().join("corpus.db"),
            5,
            Embedded::none(),
        );
        for a in [
            &l.status.bundle,
            &l.status.detection_model,
            &l.status.recognition_model,
        ] {
            assert_eq!(a.source, AssetSource::Absent, "{a:?}");
            assert!(!a.present && !a.loaded, "{a:?}");
        }
    }

    /// The models are a pair: `File` only when both files are there, and one file alone falls
    /// through to the embedded pair. Garbage bytes throughout, because no model is in the repo —
    /// what is under test is which place was read, and a failed parse still says that.
    #[test]
    fn the_models_load_as_a_pair_from_one_place() {
        let garbage: (&'static [u8], &'static [u8]) = (&b"not a model"[..], &b"not a model"[..]);
        let dir = tempfile::tempdir().expect("tempdir");
        let scanner = dir.path().join("scanner");
        std::fs::create_dir_all(scanner.join("models")).expect("mkdir");
        let embedded = Embedded {
            bundle: None,
            models: Some(garbage),
        };

        // One file on disk: the embedded pair answers, for both.
        std::fs::write(scanner.join(DETECTION_MODEL), b"on disk").expect("write");
        let one = load(&scanner, &dir.path().join("corpus.db"), 5, embedded);
        for a in [&one.status.detection_model, &one.status.recognition_model] {
            assert_eq!(a.source, AssetSource::Embedded, "{a:?}");
            assert!(a.present && !a.loaded && a.error.is_some(), "{a:?}");
        }

        // One file on disk and nothing embedded: nothing loads, and the file that is there says so.
        let bare = load(&scanner, &dir.path().join("corpus.db"), 5, Embedded::none());
        assert_eq!(bare.status.detection_model.source, AssetSource::File);
        assert_eq!(bare.status.recognition_model.source, AssetSource::Absent);
        assert!(!bare.status.detection_model.loaded && !bare.session.has_reader());

        // Both files on disk: the files answer, for both.
        std::fs::write(scanner.join(RECOGNITION_MODEL), b"on disk").expect("write");
        let both = load(&scanner, &dir.path().join("corpus.db"), 5, embedded);
        for a in [&both.status.detection_model, &both.status.recognition_model] {
            assert_eq!(a.source, AssetSource::File, "{a:?}");
        }
    }

    #[test]
    fn prefs_round_trip_through_app_meta_and_default_when_unset() {
        let conn = meta();
        assert_eq!(stored_prefs(&conn), ScannerPrefs::default());
        let p = ScannerPrefs {
            mode: ScanMode::Exact,
            developer: true,
            folder_id: Some(4),
            ..Default::default()
        };
        store_prefs(&conn, &p).unwrap();
        assert_eq!(stored_prefs(&conn), p);
    }

    #[test]
    fn a_prefs_row_that_does_not_parse_reads_as_the_default() {
        let conn = meta();
        for junk in ["not json", "[]", r#"{"mode":"sideways"}"#] {
            set_app_meta(&conn, K_SCANNER_PREFS, junk).unwrap();
            assert_eq!(stored_prefs(&conn), ScannerPrefs::default(), "{junk}");
        }
    }

    #[test]
    fn the_default_row_is_nonfoil_and_ungraded() {
        let p = ScannerPrefs::default();
        assert_eq!(p.finish, "nonfoil");
        assert_eq!(p.condition, "NONE");
        assert_eq!(p.mode, ScanMode::Fast);
        assert_eq!(p.folder_id, None);
        assert!(!p.developer);
    }

    /// **The rename is the contract, and `ipc.test.ts` cannot see it** — its mirror table camel-cases
    /// the Rust field names unconditionally, so a dropped `rename_all` stays green there. Read off
    /// the real wire here instead.
    #[test]
    fn prefs_and_tray_rows_travel_under_the_names_the_page_reads() {
        let p = serde_json::to_value(ScannerPrefs {
            folder_id: Some(4),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(p["folderId"], 4);
        assert_eq!(p["mode"], "fast");
        // The filters keep the crate's snake case inside the camel-case document.
        assert!(p["filters"].get("released_from").is_some(), "{p}");

        let row = serde_json::to_value(tray_row("k", 1)).unwrap();
        for key in [
            "key",
            "cardId",
            "oracleId",
            "name",
            "setCode",
            "collectorNumber",
            "finish",
            "quantity",
            "choices",
            "addedAt",
        ] {
            assert!(row.get(key).is_some(), "{key} missing from {row}");
        }
        assert!(row["choices"][0].get("collectorNumber").is_some(), "{row}");

        let absent = serde_json::to_value(asset(Path::new("nowhere/card-hashes.bin"))).unwrap();
        assert_eq!(absent["source"], "absent");
    }

    #[test]
    fn a_tray_round_trips_whole() {
        let conn = meta();
        assert!(stored_tray(&conn).is_empty());
        let rows = vec![tray_row("a", 1), tray_row("b", 3)];
        store_tray(&conn, &rows).unwrap();
        assert_eq!(stored_tray(&conn), rows);
        store_tray(&conn, &[]).unwrap();
        assert!(
            stored_tray(&conn).is_empty(),
            "an empty tray is a tray, not a missing row"
        );
    }

    #[test]
    fn a_tray_row_with_zero_quantity_is_refused_with_a_sentence() {
        let conn = meta();
        let kept = vec![tray_row("a", 2)];
        store_tray(&conn, &kept).unwrap();

        let err = store_tray(&conn, &[tray_row("a", 2), tray_row("b", 0)]).unwrap_err();
        assert_eq!(err, TRAY_ROW_NEEDS_A_COPY);
        assert_eq!(err, "A tray row needs at least one copy.");
        assert_eq!(
            stored_tray(&conn),
            kept,
            "a refused write leaves the stored tray as it was"
        );
        assert!(store_tray(&conn, &[tray_row("c", -1)]).is_err());
    }

    #[test]
    fn a_tray_past_five_thousand_rows_is_refused_with_a_sentence() {
        let conn = meta();
        let full = vec![tray_row("r", 1); MAX_TRAY_ROWS];
        store_tray(&conn, &full).expect("exactly the limit is a tray");
        let over = vec![tray_row("r", 1); MAX_TRAY_ROWS + 1];
        assert_eq!(
            store_tray(&conn, &over).unwrap_err(),
            "The tray holds at most 5,000 rows — add these to the collection first."
        );
        assert_eq!(stored_tray(&conn).len(), MAX_TRAY_ROWS);
    }

    #[test]
    fn an_unreadable_stored_tray_reads_as_empty_rather_than_failing() {
        let conn = meta();
        for junk in ["not json", r#"{"key":"a"}"#, r#"[{"quantity":"many"}]"#] {
            set_app_meta(&conn, K_SCANNER_TRAY, junk).unwrap();
            assert!(stored_tray(&conn).is_empty(), "{junk}");
        }
    }

    #[test]
    fn an_empty_data_dir_names_three_absent_paths_and_still_answers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let loaded = load(
            &dir.path().join("scanner"),
            &dir.path().join("corpus.db"),
            5,
            Embedded::none(),
        );
        let s = &loaded.status;
        assert!(!s.bundle.present && !s.bundle.loaded);
        assert!(s.bundle.path.ends_with(BUNDLE_FILE), "{}", s.bundle.path);
        assert!(s.detection_model.path.ends_with("text-detection.rten"));
        assert!(s.recognition_model.path.ends_with("text-recognition.rten"));
        assert_eq!(s.labels, 0);
        assert!(s.scans_dir.ends_with("scans"));
        assert!(!loaded.session.has_reference());
        assert!(!loaded.session.has_reader());
    }

    #[test]
    fn a_bundle_that_is_not_a_bundle_is_present_and_not_loaded_with_a_sentence() {
        let dir = tempfile::tempdir().expect("tempdir");
        let scanner = dir.path().join("scanner");
        std::fs::create_dir_all(&scanner).expect("mkdir");
        std::fs::write(scanner.join(BUNDLE_FILE), b"nonsense").expect("write");
        // A good embedded copy is on offer and is **not** taken: the reader placed this file, so
        // its error is the answer, and falling back would hide the very file under test.
        let embedded = Embedded {
            bundle: Some(tiny_bundle()),
            models: None,
        };
        let loaded = load(&scanner, &dir.path().join("corpus.db"), 5, embedded);
        assert!(loaded.status.bundle.present);
        assert!(!loaded.status.bundle.loaded);
        assert!(loaded.status.bundle.error.is_some());
        assert_eq!(loaded.status.bundle.source, AssetSource::File);
        assert!(!loaded.session.has_reference());
    }

    /// A bundle that parsed with no `corpus.db` beside it: **loaded, and carrying a sentence
    /// about its names**. The two facts have to be separable — the scanner matches perfectly
    /// well here and answers ids — which is why this is `Asset::error` on a loaded asset
    /// rather than `loaded: false`, and why the page draws a different sentence for it.
    #[test]
    fn a_bundle_with_no_corpus_beside_it_says_where_it_looked() {
        let dir = tempfile::tempdir().expect("tempdir");
        let scanner = dir.path().join("scanner");
        std::fs::create_dir_all(&scanner).expect("mkdir");
        let empty = card_scanner::index::BundleBuilder::new(
            card_scanner::hash::HashKind::DHashChroma32,
            256,
        )
        .finish(0)
        .to_bytes();
        std::fs::write(scanner.join(BUNDLE_FILE), empty).expect("write");

        let corpus = dir.path().join("corpus.db");
        let loaded = load(&scanner, &corpus, 5, Embedded::none());
        assert!(loaded.status.bundle.present && loaded.status.bundle.loaded);
        assert_eq!(loaded.status.labels, 0);
        let err = loaded
            .status
            .bundle
            .error
            .expect("a bundle with no corpus owes a sentence about its names");
        assert!(err.contains("corpus.db not found"), "{err}");
        assert!(err.contains(&corpus.display().to_string()), "{err}");
        // The session is fully built either way: nameless is a state, not a failure.
        assert!(loaded.session.has_reference());
    }

    #[test]
    fn a_raw_body_with_no_header_uses_the_default_options() {
        let body = InvokeBody::Raw(vec![1, 2, 3]);
        let (jpeg, opts) = frame_payload(&body, &HeaderMap::new()).expect("payload");
        assert_eq!(jpeg, vec![1, 2, 3]);
        assert_eq!(opts, FrameOptions::default());
    }

    #[test]
    fn a_raw_body_reads_its_options_from_the_header() {
        let body = InvokeBody::Raw(vec![9]);
        let mut headers = HeaderMap::new();
        headers.insert(
            OPTIONS_HEADER,
            r#"{"decide_at":12,"method":"otsu"}"#.parse().expect("value"),
        );
        let (_, opts) = frame_payload(&body, &headers).expect("payload");
        assert_eq!(opts.decide_at, 12.0);
        assert_eq!(opts.method, card_scanner::session::Method::Otsu);
    }

    #[test]
    fn a_json_body_carries_the_frame_as_base64_for_android() {
        let body =
            InvokeBody::Json(serde_json::json!({ "jpeg": "AQID", "options": { "decide_at": 6 } }));
        let (jpeg, opts) = frame_payload(&body, &HeaderMap::new()).expect("payload");
        assert_eq!(jpeg, vec![1, 2, 3]);
        assert_eq!(opts.decide_at, 6.0);
    }

    #[test]
    fn a_json_body_with_no_frame_is_a_sentence_not_a_panic() {
        let body = InvokeBody::Json(serde_json::json!({ "options": {} }));
        let err = frame_payload(&body, &HeaderMap::new()).expect_err("no jpeg");
        assert!(err.contains("jpeg"), "{err}");
        let body = InvokeBody::Json(serde_json::json!({ "jpeg": "not base64!" }));
        assert!(frame_payload(&body, &HeaderMap::new()).is_err());
    }

    #[test]
    fn a_raw_capture_reads_its_sidecar_from_the_header() {
        let body = InvokeBody::Raw(vec![7]);
        let mut headers = HeaderMap::new();
        headers.insert(
            CAPTURE_HEADER,
            r#"{"expected":"Plains","votes":"8.0"}"#.parse().expect("value"),
        );
        let (jpeg, sidecar) = capture_payload(&body, &headers).expect("payload");
        assert_eq!(jpeg, vec![7]);
        assert_eq!(sidecar.expected, "Plains");
        assert_eq!(sidecar.votes, "8.0");
    }

    #[test]
    fn a_json_capture_carries_the_frame_and_its_sidecar_for_android() {
        let body = InvokeBody::Json(
            serde_json::json!({ "jpeg": "AQID", "sidecar": { "expected": "Plains" } }),
        );
        let (jpeg, sidecar) = capture_payload(&body, &HeaderMap::new()).expect("payload");
        assert_eq!(jpeg, vec![1, 2, 3]);
        assert_eq!(sidecar.expected, "Plains");
        // Every other field defaults rather than refusing: `Sidecar` is `#[serde(default)]`
        // and a capture with only a name typed is the common one.
        assert_eq!(sidecar.votes, "");
    }

    /// The page escapes non-ASCII as `\uXXXX` before the JSON goes on the wire, so the header
    /// is visible ASCII and the card's real name survives the round trip.
    #[test]
    fn an_escaped_card_name_comes_back_with_its_accent() {
        let body = InvokeBody::Raw(vec![7]);
        let mut headers = HeaderMap::new();
        // A raw string, so these are the six characters `\u00c6` on the wire rather than the
        // two UTF-8 bytes the letter itself is — which is exactly what the page sends.
        let escaped = r#"{"expected":"\u00c6ther Vial"}"#;
        assert!(escaped.is_ascii(), "the page must escape before the header");
        headers.insert(CAPTURE_HEADER, escaped.parse().expect("value"));
        let (_, sidecar) = capture_payload(&body, &headers).expect("payload");
        assert_eq!(sidecar.expected, "Æther Vial");
    }

    /// The failure that used to file an unlabelled capture as a success: a header the page put
    /// raw bytes in is refused, rather than falling back to five empty fields and a written JPEG.
    #[test]
    fn a_capture_header_that_is_not_visible_ascii_is_a_sentence() {
        let body = InvokeBody::Raw(vec![7]);
        let mut headers = HeaderMap::new();
        headers.insert(
            CAPTURE_HEADER,
            tauri::http::HeaderValue::from_bytes(b"{\"expected\":\"\xc6\"}").expect("value"),
        );
        let err = capture_payload(&body, &headers).expect_err("unreadable header");
        assert!(err.contains("sidecar"), "{err}");
        // And an absent header is still the reader's own choice, not a failure.
        assert!(capture_payload(&body, &HeaderMap::new()).is_ok());
    }

    #[test]
    fn a_capture_writes_the_two_files_the_debug_server_writes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let scans = dir.path().join("scans");
        let sidecar = Sidecar {
            expected: "Plains".into(),
            reported: "Plains".into(),
            votes: "8.0".into(),
            ..Default::default()
        };
        let saved = write_capture(&scans, &[0xFF, 0xD8, 0xFF], &sidecar).expect("write");
        assert!(
            saved.saved.starts_with("live-") && saved.saved.ends_with(".jpg"),
            "{}",
            saved.saved
        );
        let json = std::fs::read_to_string(scans.join(&saved.saved).with_extension("json"))
            .expect("sidecar");
        let v: serde_json::Value = serde_json::from_str(&json).expect("json");
        assert_eq!(v["expected"], "Plains");
        assert_eq!(v["votes"], "8.0");
        assert_eq!(v["image"], saved.saved);
        assert!(v["captured_at_epoch"].is_number());
    }
}
