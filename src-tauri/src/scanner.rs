//! The card scanner inside the app: the crate's [`Session`] behind four commands.
//!
//! **Its own managed state, not a field on `AppState`.** It is optional and desktop/Android
//! only, it loads lazily, and the only thing it shares with the rest of the app is the data
//! directory and one read of `corpus.db` for labels. `app.manage` holds it beside `AppState`.
//!
//! **Assets are files in `data/scanner/`, and the page names the missing one.** Nothing here
//! downloads: the bundle has no release asset yet and the models are not ours. A missing bundle
//! is a session that detects and rectifies and names nothing — the debug server's behaviour —
//! and a missing model pair is a session with no reader. [`scanner_status`] reports the exact
//! path it looked at for each, so "no bundle" is never the whole message.
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

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use base64::Engine as _;
use card_scanner::index::Bundle;
use card_scanner::ocr::TitleReader;
use card_scanner::reference::Reference;
use card_scanner::session::{FrameOptions, Session, Verdict};
use tauri::http::HeaderMap;
use tauri::ipc::InvokeBody;

pub const BUNDLE_FILE: &str = "card-hashes.bin";
pub const DETECTION_MODEL: &str = "models/text-detection.rten";
pub const RECOGNITION_MODEL: &str = "models/text-recognition.rten";
/// The header a desktop frame carries its `FrameOptions` in, as JSON.
pub const OPTIONS_HEADER: &str = "x-scanner-options";
/// The header a desktop capture carries its `Sidecar` in, as JSON.
pub const CAPTURE_HEADER: &str = "x-scanner-capture";
/// Candidates per frame — the debug server's `--top` default.
const TOP: usize = 5;

#[derive(Debug, Clone, serde::Serialize)]
pub struct Asset {
    pub path: String,
    pub present: bool,
    pub loaded: bool,
    pub error: Option<String>,
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
            ));
        }
        Ok(guard)
    }
}

fn asset(path: &Path) -> Asset {
    Asset {
        path: path.display().to_string(),
        present: path.is_file(),
        loaded: false,
        error: None,
    }
}

/// Read the assets and build the session. Every failure is a sentence on its asset, never an
/// error out of here: the page is useful without a bundle, and it says which file is missing.
pub fn load(dir: &Path, corpus: &Path, top: usize) -> Loaded {
    let bundle_path = dir.join(BUNDLE_FILE);
    let mut bundle = asset(&bundle_path);
    let mut labels = 0;
    let reference = if bundle.present {
        match std::fs::read(&bundle_path)
            .map_err(|e| e.to_string())
            .and_then(|b| Bundle::from_bytes(&b).map_err(|e| e.to_string()))
        {
            Ok(b) => {
                bundle.loaded = true;
                let mut reference = Reference::new(b);
                if corpus.is_file() {
                    match rusqlite::Connection::open_with_flags(
                        corpus,
                        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                            | rusqlite::OpenFlags::SQLITE_OPEN_URI,
                    )
                    .and_then(|conn| reference.load_labels(&conn))
                    {
                        Ok(n) => labels = n,
                        Err(e) => bundle.error = Some(format!("labels: {e} — matches will be ids")),
                    }
                }
                Some(reference)
            }
            Err(e) => {
                bundle.error = Some(e);
                None
            }
        }
    } else {
        None
    };

    let det_path = dir.join(DETECTION_MODEL);
    let rec_path = dir.join(RECOGNITION_MODEL);
    let mut detection_model = asset(&det_path);
    let mut recognition_model = asset(&rec_path);
    let reader = if detection_model.present && recognition_model.present {
        match TitleReader::load(&det_path, &rec_path) {
            Ok(r) => {
                detection_model.loaded = true;
                recognition_model.loaded = true;
                Some(r)
            }
            Err(e) => {
                let s = e.to_string();
                detection_model.error = Some(s.clone());
                recognition_model.error = Some(s);
                None
            }
        }
    } else {
        None
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

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::HeaderMap;
    use tauri::ipc::InvokeBody;

    #[test]
    fn an_empty_data_dir_names_three_absent_paths_and_still_answers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let loaded = load(
            &dir.path().join("scanner"),
            &dir.path().join("corpus.db"),
            5,
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
        let loaded = load(&scanner, &dir.path().join("corpus.db"), 5);
        assert!(loaded.status.bundle.present);
        assert!(!loaded.status.bundle.loaded);
        assert!(loaded.status.bundle.error.is_some());
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
