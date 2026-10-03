//! The desktop's scanner commands, over a glob re-export of the core's `scanner` — the session
//! glue, the one-window lease, the reader's prefs and the review tray are
//! `crates/grimoire-core/src/scanner.rs`, and the state is the core's `State.scanner`.
//!
//! **What is still here names this host.** The assets `build.rs` embeds, under
//! `cfg(scanner_assets)`, which [`compiled`] hands the core's `ScannerState::carry` as the app
//! starts. The raw request body a frame and a capture arrive in: the JPEG is the body and its JSON
//! rides in a header — [`OPTIONS_HEADER`] for a frame, [`CAPTURE_HEADER`] for a capture — and
//! [`frame_payload`] and `capture_payload` read the two and refuse a JSON body in words. A frame
//! may carry a second JPEG behind the first, the same video frame at the camera's own resolution
//! for the title and collector reads, and [`DETAIL_HEADER`] says where the first one ends. And the
//! `#[tauri::command]`s — every one that uses the scanner admits the calling webview's label on
//! the core's lease, and the status, `scanner_elsewhere` and the two reads take nothing; the
//! core's module doc, with `LEASE` and `OPEN_ELSEWHERE`, says which and why.

pub use grimoire_core::scanner::*;

use std::sync::Arc;

use card_scanner::filters::ScanFilters;
use card_scanner::session::{FrameOptions, Verdict};
use tauri::http::HeaderMap;
use tauri::ipc::InvokeBody;

use crate::sync::AppState;
/// The header a frame carries its `FrameOptions` in, as JSON.
pub const OPTIONS_HEADER: &str = "x-scanner-options";
/// The header a capture carries its `Sidecar` in, as JSON.
pub const CAPTURE_HEADER: &str = "x-scanner-capture";
/// The header that says a frame's body is **two** JPEGs back to back, and where the first ends:
/// the decimal byte length of the frame, with the detail image as everything after it. Absent,
/// the body is the frame alone. See [`frame_payload`].
pub const DETAIL_HEADER: &str = "x-scanner-detail";

#[cfg(scanner_assets)]
const EMBEDDED_BUNDLE: &[u8] = include_bytes!("../../scanner-assets/card-hashes.bin");
#[cfg(scanner_assets)]
const EMBEDDED_DETECTION: &[u8] = include_bytes!("../../scanner-assets/text-detection.rten");
#[cfg(scanner_assets)]
const EMBEDDED_RECOGNITION: &[u8] = include_bytes!("../../scanner-assets/text-recognition.rten");

/// What this build carries, for the core's [`ScannerState::carry`]. `build.rs` sets
/// `cfg(scanner_assets)` only when all three files are present, so a bundle is never embedded
/// without its models or the reverse.
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

/// What [`frame_payload`] reads out of one request: the frame, the detail image if one came, and
/// the options.
pub type FramePayload = (Vec<u8>, Option<Vec<u8>>, FrameOptions);

/// The frame from the request body, the detail image behind it if [`DETAIL_HEADER`] says there
/// is one, and the options from [`OPTIONS_HEADER`]. See the module doc.
///
/// **Why one body carrying two JPEGs rather than a second command or a second header.** The
/// detail image has to be the *same video frame* as the one the crate detects on — the quad it
/// found in the small image is scaled onto the large one, so a large image one frame later is a
/// card that has moved by however far the reader's hand did. One request is what makes the pair
/// arrive together or not at all; a raw body is the only way bytes cross this boundary without a
/// base64 step; and a header is the only place left to say where one ends.
///
/// **A detail header that is present and wrong is a refusal, where an unreadable options header
/// is a shrug** — [`capture_payload`]'s asymmetry, for a sharper reason. A defaulted slider costs
/// one frame; a mis-split body hands the decoder the first half of a JPEG as the frame and a
/// tail of it as the detail, and the verdict that comes back describes neither. So a length that
/// is not a number, is zero, runs past the body, or leaves nothing behind it for the detail says
/// so in words, and the page's loop shows the sentence and sends the next frame.
pub fn frame_payload(body: &InvokeBody, headers: &HeaderMap) -> Result<FramePayload, String> {
    match body {
        InvokeBody::Raw(bytes) => {
            let opts = headers
                .get(OPTIONS_HEADER)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();
            let (jpeg, detail) = split_detail(bytes, headers.get(DETAIL_HEADER))?;
            Ok((jpeg, detail, opts))
        }
        InvokeBody::Json(_) => Err("the frame has to arrive as a raw request body".to_string()),
    }
}

/// The body split at [`DETAIL_HEADER`]'s length — `(frame, None)` when there is no header, and
/// the whole body is the frame exactly as it was before the detail image existed.
fn split_detail(
    bytes: &[u8],
    header: Option<&tauri::http::HeaderValue>,
) -> Result<(Vec<u8>, Option<Vec<u8>>), String> {
    let Some(value) = header else {
        return Ok((bytes.to_vec(), None));
    };
    let text = value
        .to_str()
        .map_err(|e| format!("the frame's detail length did not parse: {e}"))?;
    let n: usize = text
        .parse()
        .map_err(|_| format!("the frame's detail length is not a number: {text:?}"))?;
    if n == 0 {
        return Err("the frame's detail length is zero, so there is no frame before it".into());
    }
    if n >= bytes.len() {
        return Err(format!(
            "the frame's detail length is {n} bytes but the body is {} — there is no detail image \
             behind the frame",
            bytes.len()
        ));
    }
    let (jpeg, detail) = bytes.split_at(n);
    Ok((jpeg.to_vec(), Some(detail.to_vec())))
}

/// The capture from the request body and its sidecar from [`CAPTURE_HEADER`].
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
        InvokeBody::Json(_) => Err("the capture has to arrive as a raw request body".to_string()),
    }
}

#[tauri::command]
pub async fn scanner_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<ScannerStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = state.scanner.ensure()?;
        Ok(guard.as_ref().expect("ensured").status.clone())
    })
    .await
    .map_err(|e| format!("the scanner thread failed: {e}"))?
}

#[tauri::command]
pub async fn scanner_frame(
    state: tauri::State<'_, Arc<AppState>>,
    request: tauri::ipc::Request<'_>,
    webview: tauri::Webview,
) -> Result<Verdict, String> {
    // Admitted before the body is read, so a refused frame costs no decode — a second window
    // with its camera already open would otherwise pay one per frame to be told no. The guard is
    // held through the decode, so a slow frame cannot let the lease lapse under itself.
    let _lease = state.scanner.admit(webview.label())?;
    let (jpeg, detail, opts) = frame_payload(request.body(), request.headers())?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = state.scanner.ensure()?;
        // The detail image is decoded only on a frame whose reads run, so carrying one the
        // session did not ask for costs the copy and nothing else.
        Ok(guard.as_mut().expect("ensured").session.frame_with_detail(
            &jpeg,
            detail.as_deref(),
            &opts,
        ))
    })
    .await
    .map_err(|e| format!("the scanner thread failed: {e}"))?
}

#[tauri::command]
pub async fn scanner_reset(
    state: tauri::State<'_, Arc<AppState>>,
    webview: tauri::Webview,
) -> Result<(), String> {
    let _lease = state.scanner.admit(webview.label())?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = state.scanner.ensure()?;
        guard.as_mut().expect("ensured").session.reset();
        Ok(())
    })
    .await
    .map_err(|e| format!("the scanner thread failed: {e}"))?
}

#[tauri::command]
pub async fn scanner_capture(
    state: tauri::State<'_, Arc<AppState>>,
    request: tauri::ipc::Request<'_>,
    webview: tauri::Webview,
) -> Result<Captured, String> {
    let _lease = state.scanner.admit(webview.label())?;
    let (jpeg, sidecar) = capture_payload(request.body(), request.headers())?;
    let scans = state.scanner.dir().join("scans");
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
    state: tauri::State<'_, Arc<AppState>>,
    filters: ScanFilters,
    webview: tauri::Webview,
) -> Result<(), String> {
    let _lease = state.scanner.admit(webview.label())?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = state.scanner.ensure()?;
        guard
            .as_mut()
            .expect("ensured")
            .session
            .set_filters(filters)
    })
    .await
    .map_err(|e| format!("the scanner thread failed: {e}"))?
}

/// Whether another window holds the scanner. Asked by a second window's Scanner view, once a
/// second while the answer is yes. Takes nothing — the core's module doc names the commands that
/// do.
#[tauri::command]
pub fn scanner_elsewhere(state: tauri::State<'_, Arc<AppState>>, webview: tauri::Webview) -> bool {
    state.scanner.elsewhere(webview.label())
}

/// Take or renew the calling window's lease, and nothing else — the mounted Scanner view's
/// heartbeat, sent on mount and once a second after. Refuses with [`OPEN_ELSEWHERE`], which the
/// page answers by asking the gate again. See [`LEASE`] for why the frames were not enough.
///
/// Sync, like [`scanner_elsewhere`]: it takes the `owner` mutex for a comparison and a store and
/// touches no database and no session, so there is nothing here to move off the IPC thread. Its
/// guard settles as it returns, which re-stamps the lease — a heartbeat is a command with no body.
#[tauri::command]
pub fn scanner_hold(
    state: tauri::State<'_, Arc<AppState>>,
    webview: tauri::Webview,
) -> Result<(), String> {
    let _settled = state.scanner.admit(webview.label())?;
    Ok(())
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
/// write connection, and [`OPEN_ELSEWHERE`] if another window holds the scanner.
///
/// **Admitted before the database is touched, and held until the write settles — the admission is
/// the point.** The row is written whole, so only the window holding the scanner may write it. The
/// guard lives through the whole of `with_write`, which can wait five seconds for the write
/// connection before it answers `BUSY` — longer than [`LEASE`] — so the scanner stays this
/// window's for as long as its write is waiting, and for two seconds after it settles, which is
/// long enough for the page's next try. The page treats this refusal as it treats `BUSY`: it keeps
/// what it has, tries again until the write lands, and never reverts.
#[tauri::command]
pub async fn set_scanner_prefs(
    state: tauri::State<'_, Arc<AppState>>,
    prefs: ScannerPrefs,
    webview: tauri::Webview,
) -> Result<(), String> {
    let _lease = state.scanner.admit(webview.label())?;
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
/// answers [`crate::db::BUSY`], and another window holding the scanner [`OPEN_ELSEWHERE`] —
/// admitted first and held until the write settles, for [`set_scanner_prefs`]' reason.
#[tauri::command]
pub async fn set_scanner_tray(
    state: tauri::State<'_, Arc<AppState>>,
    rows: Vec<ScannerTrayRow>,
    webview: tauri::Webview,
) -> Result<(), String> {
    let _lease = state.scanner.admit(webview.label())?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store_tray(conn, &rows))
    })
    .await
    .map_err(|e| format!("the scanner tray could not be saved: {e}"))?
}

/// Add the tray's rows to the collection and store what is left of the tray, as one write — see
/// [`tray_commit`]. Through `with_write_owned`, `collection_import_commit`'s own door, so the facet
/// index's `owned` dimension moves with the copies and a busy write connection answers
/// [`crate::db::BUSY`] with nothing written.
///
/// **Admitted first and held until it settles, like the tray's own write**: `remaining` is the tray
/// written whole, and a window that has lost the scanner is a window whose tray may be older than
/// the stored one — its commit would file rows another window has already filed, and store a tray
/// over theirs.
#[tauri::command]
pub async fn scanner_tray_commit(
    state: tauri::State<'_, Arc<AppState>>,
    items: Vec<crate::collection::CollectionImportItem>,
    folder_id: Option<i64>,
    remaining: Vec<ScannerTrayRow>,
    webview: tauri::Webview,
) -> Result<crate::collection::ImportCommitOutcome, String> {
    let _lease = state.scanner.admit(webview.label())?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::collection_source::with_write_owned(&state, |conn| {
            tray_commit(conn, &items, folder_id, &remaining)
        })
    })
    .await
    .map_err(|e| format!("the collection could not be written: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::HeaderMap;
    use tauri::ipc::InvokeBody;

    #[test]
    fn a_raw_body_with_no_header_uses_the_default_options() {
        let body = InvokeBody::Raw(vec![1, 2, 3]);
        let (jpeg, detail, opts) = frame_payload(&body, &HeaderMap::new()).expect("payload");
        assert_eq!(jpeg, vec![1, 2, 3]);
        // No detail header is the body exactly as it was before the detail image existed.
        assert_eq!(detail, None);
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
        let (_, _, opts) = frame_payload(&body, &headers).expect("payload");
        assert_eq!(opts.decide_at, 12.0);
        assert_eq!(opts.method, card_scanner::session::Method::Otsu);
    }

    /// The page's own shape: the frame, then the detail image, one body, with the frame's length
    /// in the header. The options header still reads beside it.
    #[test]
    fn a_detail_header_splits_the_body_into_the_frame_and_the_detail() {
        let body = InvokeBody::Raw(vec![1, 2, 3, 7, 8, 9, 10]);
        let mut headers = HeaderMap::new();
        headers.insert(DETAIL_HEADER, "3".parse().expect("value"));
        headers.insert(
            OPTIONS_HEADER,
            r#"{"decide_at":12}"#.parse().expect("value"),
        );
        let (jpeg, detail, opts) = frame_payload(&body, &headers).expect("payload");
        assert_eq!(jpeg, vec![1, 2, 3]);
        assert_eq!(detail, Some(vec![7, 8, 9, 10]));
        assert_eq!(opts.decide_at, 12.0);
    }

    /// Every wrong length is a sentence rather than a split somewhere else: a mis-split body is a
    /// frame decoded from half a JPEG, and the verdict for it would describe neither image.
    #[test]
    fn a_detail_length_that_cannot_split_the_body_is_a_sentence() {
        let body = InvokeBody::Raw(vec![1, 2, 3, 4]);
        let refused = |value: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(DETAIL_HEADER, value.parse().expect("value"));
            frame_payload(&body, &headers).expect_err(value)
        };
        let err = refused("three");
        assert!(err.contains("not a number"), "{err}");
        let err = refused("-1");
        assert!(err.contains("not a number"), "{err}");
        let err = refused("0");
        assert!(err.contains("zero"), "{err}");
        // Past the end, and exactly at it — the second leaves an empty detail image.
        let err = refused("9");
        assert!(err.contains("no detail image"), "{err}");
        let err = refused("4");
        assert!(err.contains("no detail image"), "{err}");
        // One byte short of the end is still a split, however small the detail.
        let mut headers = HeaderMap::new();
        headers.insert(DETAIL_HEADER, "3".parse().expect("value"));
        let (jpeg, detail, _) = frame_payload(&body, &headers).expect("payload");
        assert_eq!((jpeg, detail), (vec![1, 2, 3], Some(vec![4])));
    }

    #[test]
    fn a_json_body_is_a_sentence_not_a_panic() {
        let body = InvokeBody::Json(serde_json::json!({ "jpeg": "AQID", "options": {} }));
        let err = frame_payload(&body, &HeaderMap::new()).expect_err("a json frame");
        assert!(err.contains("raw request body"), "{err}");
        let err = capture_payload(&body, &HeaderMap::new()).expect_err("a json capture");
        assert!(err.contains("raw request body"), "{err}");
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
}
