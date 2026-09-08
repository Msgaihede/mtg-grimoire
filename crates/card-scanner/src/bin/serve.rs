//! `serve` — the live camera view, with the full debug pipeline visible per frame.
//!
//! ## Why the preview and the detector are decoupled
//!
//! Measured on this machine, one Canny method at `work_long_edge = 1024`: the mask stage
//! alone is **92.8 ms**, and unlike resize and rectify it does *not* get cheaper on a camera
//! frame — its cost is set by the working resolution, not by the source. A 720p frame still
//! costs ~108 ms end to end, which is about **9 detections per second**.
//!
//! So the page never waits for a detection. The `<video>` element runs at whatever rate the
//! camera gives, an overlay canvas redraws every animation frame from the *most recent*
//! quad, and exactly one detection request is in flight at a time — later frames are dropped
//! rather than queued. The preview stays smooth, the box lags the card by one detection, and
//! nothing ever backs up. Queuing frames would make the box drift further behind the longer
//! you looked at it, which is the failure this avoids.
//!
//! That is also why the debug panel shows a per-stage millisecond breakdown and lets the
//! working resolution, the detector and the thresholds be changed live: the accuracy/rate
//! trade is real and the corpus cannot settle it, because the corpus is stills.
//!
//! ## Reaching it from a phone
//!
//! `getUserMedia` needs a secure context. `http://localhost` qualifies; **`http://192.168.x.x`
//! does not**, so browsing to this server from a phone over the LAN fails silently — the
//! camera simply never starts. Use `adb reverse tcp:7777 tcp:7777`, which makes this server
//! *be* localhost on the handset. No certificate, no tunnel.

use card_scanner::index::Bundle;
use card_scanner::ocr::TitleReader;
use card_scanner::reference::Reference;
use card_scanner::session::{FrameOptions, Method, Session, Verdict};
use clap::Parser;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tiny_http::{Header, Response, Server};

#[derive(Parser, Debug)]
#[command(name = "serve", about = "Live camera card detection with a debug view")]
struct Args {
    #[arg(long, default_value_t = 7777)]
    port: u16,
    /// Worker threads. Detection is CPU-bound and single-threaded per frame, so more than a
    /// couple only helps when the page also asks for the debug stage images.
    #[arg(long, default_value_t = 3)]
    workers: usize,

    /// The reference bundle from `build-hashes`. Without it the page detects and rectifies
    /// but names nothing — which is still the useful half while the bundle is building.
    #[arg(long)]
    bundle: Option<PathBuf>,
    /// The app's `corpus.db`, to turn a matched id into a card name. Optional: a match
    /// without a corpus is an id, which still proves the pipeline.
    #[arg(long)]
    corpus: Option<PathBuf>,
    /// How many candidates to return per frame.
    #[arg(long, default_value_t = 5)]
    top: usize,

    /// Print one line per frame: the lock, the top candidates and the tracker's verdict.
    ///
    /// The camera can only be held by one page at a time, so a second browser cannot be used
    /// to watch what the first one is seeing. This is how a live session gets diagnosed
    /// without taking the camera away from the person holding the card.
    #[arg(long, default_value_t = true)]
    log_frames: bool,

    /// Write each frame's verdict into this directory, as JSON.
    ///
    /// The camera is held by one page at a time, so the live rectification cannot be
    /// inspected from a second browser — and it is the one thing that actually explains why a
    /// card matching at 45 bits as a photograph matches at 70 from a webcam. Numbers describe
    /// the failure; the image is the failure. The rectified card is in the JSON as a data
    /// URI, which is what the page itself renders, so there is no separate PNG: the session
    /// hands out the preview rather than the image, and a second clone of it here would be a
    /// megabyte a frame to say the same thing.
    #[arg(long)]
    dump_dir: Option<PathBuf>,

    /// Where the Add-to-dataset button writes captured frames.
    ///
    /// **The corpus is the instrument every measurement in this crate is read off, and it is
    /// 43 photographs taken once.** Worse, only 14 of them yield a name the OCR tier can read
    /// cleanly, so every accuracy figure quoted here rests on n=11 — where one card is nine
    /// percentage points, and three separate times a change has looked good on distance and
    /// wrong on names. A frame captured at the moment a match is visibly bad is worth more
    /// than any amount of re-tuning against the frames that already work.
    #[arg(long, default_value = "docs/scanner/scans")]
    dataset_dir: PathBuf,

    /// Directory holding the ocrs models. Enables the OCR tier.
    ///
    /// Fetch them with `scripts/fetch-ocr-models.mjs`.
    #[arg(long)]
    ocr_models: Option<PathBuf>,
}

/// The session is shared rather than per-request, because it is the one deliberately stateful
/// piece of this server: a stable answer is a property of the *stream*, not of any one frame.
/// One camera, one page, one session. The app owns one per scanning session instead.
type Shared = Arc<Mutex<Session>>;

/// The page's sliders, from the query string.
///
/// The keys are the page's short names; the JSON spelling the app uses is `FrameOptions`' own
/// field names, and `the_query_string_and_the_json_spell_the_same_options` below is what keeps
/// the two saying the same thing. The clamps are the session's — see
/// `FrameOptions::tracker_options`.
fn options_from_query(url: &str) -> FrameOptions {
    let q = query_pairs(url);
    let num = |key: &str, default: f32| -> f32 {
        q.get(key).and_then(|v| v.parse().ok()).unwrap_or(default)
    };
    let d = FrameOptions::default();
    FrameOptions {
        work_long_edge: num("edge", d.work_long_edge as f32) as u32,
        method: q.get("method").map_or(Method::Both, |m| Method::parse(m)),
        canny_low: num("lo", d.canny_low),
        canny_high: num("hi", d.canny_high),
        aspect_tolerance: num("aspect", d.aspect_tolerance),
        min_cardness: num("cardness", d.min_cardness),
        stages: q.get("stages").map(String::as_str) == Some("1"),
        // **Chosen per frame from the page, so the two rules can be A/B'd on one held card
        // without a rebuild.** `Tracker::set_options`, which the session calls with these,
        // keeps the tally — so flipping the segment or dragging a slider re-judges the
        // evidence already gathered rather than starting over.
        rule: match q.get("rule").map(String::as_str) {
            Some("confidence") => card_scanner::track::CommitRule::Confidence,
            _ => card_scanner::track::CommitRule::Votes,
        },
        decide_at: num("decide", d.decide_at),
        lead_margin: num("margin", d.lead_margin),
    }
}

/// Write one captured frame, and what the scanner made of it, into the dataset.
///
/// **The sidecar matters as much as the image.** A frame saved with no record of what was on
/// screen is a photograph of a card; a frame saved with the name the reader typed is a
/// *labelled* one, and that difference is whether it can ever be scored automatically. The
/// scanner's own answer goes beside it, so a later reader can see what it said at the time
/// rather than only what it says now — which is the whole point of capturing a bad match.
fn save_capture(dir: &std::path::Path, url: &str, body: &[u8]) -> serde_json::Value {
    if body.is_empty() {
        return serde_json::json!({ "ok": false, "error": "empty frame" });
    }
    if let Err(e) = std::fs::create_dir_all(dir) {
        return serde_json::json!({ "ok": false, "error": format!("{}: {e}", dir.display()) });
    }
    let q = query_pairs(url);

    // Epoch seconds rather than a formatted date, to avoid a dependency for a filename: it
    // sorts chronologically as text and a reader cannot press the button twice in one second.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let stem = dir.join(format!("live-{stamp}"));
    let jpg = stem.with_extension("jpg");
    if let Err(e) = std::fs::write(&jpg, body) {
        return serde_json::json!({ "ok": false, "error": format!("{}: {e}", jpg.display()) });
    }

    let get = |k: &str| q.get(k).cloned().unwrap_or_default();
    let expected = get("expected");
    let sidecar = serde_json::json!({
        "captured_at_epoch": stamp,
        "image": jpg.file_name().and_then(|n| n.to_str()),
        // What the reader says it actually is. Empty when they did not say — still a useful
        // frame, just not a scoreable one.
        "expected": expected,
        // What the scanner believed at the moment of capture, verbatim from the panel.
        "reported": get("reported"),
        "confidence": get("confidence"),
        "votes": get("votes"),
        "distance": get("distance"),
    });
    let json = stem.with_extension("json");
    let written = serde_json::to_vec_pretty(&sidecar).unwrap_or_default();
    if let Err(e) = std::fs::write(&json, written) {
        return serde_json::json!({ "ok": false, "error": format!("{}: {e}", json.display()) });
    }
    eprintln!(
        "  captured {} ({} KB){}",
        jpg.display(),
        body.len() / 1024,
        if expected.is_empty() { String::new() } else { format!(" — expected {expected}") }
    );
    serde_json::json!({ "ok": true, "saved": jpg.file_name().and_then(|n| n.to_str()) })
}

/// The query string as a map, percent-decoded.
fn query_pairs(url: &str) -> std::collections::HashMap<String, String> {
    url.split_once('?')
        .map(|(_, q)| {
            q.split('&')
                .filter_map(|kv| kv.split_once('='))
                .map(|(k, v)| (k.to_string(), decode_component(v)))
                .collect()
        })
        .unwrap_or_default()
}

/// Percent-decoding, enough for one query value: `+` is a space and `%NN` is a byte.
fn decode_component(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < b.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(v) => {
                    out.push(v);
                    i += 3;
                }
                Err(_) => {
                    out.push(b[i]);
                    i += 1;
                }
            },
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn json_header() -> Header {
    Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).expect("static header")
}

fn html_header() -> Header {
    Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
        .expect("static header")
}

/// One frame. The session decides it; this turns the verdict into the page's JSON and writes
/// the two developer-facing side effects — the dump directory and the log line.
fn handle_frame(
    body: &[u8],
    opts: &FrameOptions,
    session: &Shared,
    log: bool,
    dump: Option<&std::path::Path>,
) -> serde_json::Value {
    let verdict: Verdict = match session.lock() {
        Ok(mut s) => s.frame(body, opts),
        Err(_) => {
            return serde_json::json!({ "ok": false, "error": "the session lock is poisoned" })
        }
    };
    let out = serde_json::to_value(&verdict).unwrap_or_default();

    if let Some(dir) = dump {
        // A rolling window, so a long session does not fill the disk and the newest frames
        // are always the ones on top. The rectified card is in the JSON as a data URI — see
        // `--dump-dir` — so there is no PNG beside it.
        static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % 40;
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(
            dir.join(format!("{n:02}-frame.json")),
            serde_json::to_vec_pretty(&out).unwrap_or_default(),
        );
    }

    if log {
        // One line per frame. The camera can only be held by one page at a time, so a second
        // browser cannot be opened to watch what the first one is seeing — this is how a live
        // session gets diagnosed without taking the card out of someone's hand.
        let cands: Vec<String> = out["match"]["candidates"]
            .as_array()
            .map(|a| {
                a.iter()
                    .take(4)
                    .map(|c| {
                        format!(
                            "{} d={}",
                            c["label"]["name"].as_str().unwrap_or("?"),
                            c["distance"].as_u64().unwrap_or(0)
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        // Under the vote rule the number that decides is the leader's tally against the
        // bar, so that is what the line shows; the confidence contest keeps its percentage.
        let verdict = if out["tracked"]["rule"].as_str() == Some("votes") {
            format!(
                "votes={:5.1}/{}",
                out["tracked"]["standings"][0]["evidence"].as_f64().unwrap_or(0.0),
                out["tracked"]["decide_at"].as_f64().unwrap_or(0.0)
            )
        } else {
            format!(
                "conf={:5.1}%",
                out["tracked"]["confidence"].as_f64().unwrap_or(0.0) * 100.0
            )
        };
        eprintln!(
            "frame lock={:<9} cardness={:.2} aspect={:.3} {verdict} {} | {}",
            out["lock"]["phase"].as_str().unwrap_or("-"),
            out["cardness"]["score"].as_f64().unwrap_or(0.0),
            out["score"]["aspect"].as_f64().unwrap_or(0.0),
            if out["tracked"]["committed"].as_bool().unwrap_or(false) { "OK " } else { "..." },
            if cands.is_empty() {
                out["error"].as_str().unwrap_or("(not matched)").to_string()
            } else {
                cands.join("  |  ")
            }
        );
        if let Some(name) = out["collector"]["matched"].as_str() {
            eprintln!(
                "      col [{}] -> {name}",
                out["collector"]["raw"].as_str().unwrap_or("")
            );
        }
        if let Some(name) = out["ocr"]["matched"].as_str() {
            eprintln!(
                "      ocr [{}] -> {name}",
                out["ocr"]["raw"].as_str().unwrap_or("")
            );
        }
    }

    out
}

/// Load the bundle and, if one is given, the corpus labels beside it.
///
/// Every failure here is reported and then ignored: the page is useful without a bundle, and
/// a debug tool that refuses to start because an optional file is mid-build is a debug tool
/// that cannot be used while the thing it debugs is being built.
fn load_reference(args: &Args) -> Option<Reference> {
    let path = args.bundle.as_ref()?;
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("bundle {}: {e} — running without a matcher", path.display());
            return None;
        }
    };
    let bundle = match Bundle::from_bytes(&bytes) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("bundle {}: {e} — running without a matcher", path.display());
            return None;
        }
    };
    eprintln!(
        "  bundle: {} printings, {} artworks, {} at {} bits",
        bundle.cards.len(),
        bundle.arts.len(),
        bundle.kind.as_str(),
        bundle.bits
    );
    let mut reference = Reference::new(bundle);

    if let Some(corpus) = &args.corpus {
        match rusqlite::Connection::open_with_flags(
            corpus,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        ) {
            Ok(conn) => match reference.load_labels(&conn) {
                Ok(n) => eprintln!("  corpus: {n} labels"),
                Err(e) => eprintln!("  corpus {}: {e} — matches will be ids", corpus.display()),
            },
            Err(e) => eprintln!("  corpus {}: {e} — matches will be ids", corpus.display()),
        }
    }
    Some(reference)
}

fn main() {
    let args = Args::parse();
    let addr = format!("127.0.0.1:{}", args.port);
    let server = match Server::http(&addr) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("cannot bind {addr}: {e}");
            std::process::exit(1);
        }
    };

    let reference = load_reference(&args);
    let reader = args.ocr_models.as_ref().and_then(|dir| {
        match TitleReader::load(
            &dir.join("text-detection.rten"),
            &dir.join("text-recognition.rten"),
        ) {
            Ok(r) => {
                eprintln!("  ocr: models loaded from {}", dir.display());
                Some(r)
            }
            Err(e) => {
                eprintln!("  ocr: {e} — continuing without it");
                None
            }
        }
    });
    let session: Shared = Arc::new(Mutex::new(Session::new(reference, reader, args.top)));

    println!("card-scanner live view: http://{addr}");
    println!();
    println!("  On this machine, open that URL.");
    println!("  From an Android handset: adb reverse tcp:{p} tcp:{p}, then open", p = args.port);
    println!("  http://localhost:{} on the phone. A LAN address will NOT work —", args.port);
    println!("  getUserMedia refuses a non-secure origin and fails silently.");

    let mut handles = Vec::new();
    for _ in 0..args.workers.max(1) {
        let server = Arc::clone(&server);
        let session = Arc::clone(&session);
        let log_frames = args.log_frames;
        let dump_dir = args.dump_dir.clone();
        let dataset_dir = args.dataset_dir.clone();
        handles.push(std::thread::spawn(move || loop {
            let Ok(mut request) = server.recv() else { return };
            let url = request.url().to_string();
            let path = url.split('?').next().unwrap_or("/");

            let response = if path == "/" {
                Response::from_string(include_str!("live.html")).with_header(html_header())
            } else if path == "/frame" {
                let mut body = Vec::new();
                let read = request.as_reader().read_to_end(&mut body);
                let value = match read {
                    // No `catch_unwind` here any more: `Session::frame` owns the guard, and
                    // it is not defensive padding — the options come from a query string
                    // driven by live sliders, the image crates assert on arguments they
                    // consider impossible, and before the guard existed one slider drag took
                    // down every worker thread and exited the server.
                    Ok(_) => handle_frame(
                        &body,
                        &options_from_query(&url),
                        &session,
                        log_frames,
                        dump_dir.as_deref(),
                    ),
                    Err(e) => serde_json::json!({ "ok": false, "error": format!("read: {e}") }),
                };
                Response::from_string(value.to_string()).with_header(json_header())
            } else if path == "/capture" {
                let mut body = Vec::new();
                let value = match request.as_reader().read_to_end(&mut body) {
                    Ok(_) => save_capture(&dataset_dir, &url, &body),
                    Err(e) => serde_json::json!({ "ok": false, "error": format!("read: {e}") }),
                };
                Response::from_string(value.to_string()).with_header(json_header())
            } else if path == "/reset" {
                // So a reader can start on a new card immediately instead of waiting for the
                // previous one's evidence to decay.
                let _ = session.lock().map(|mut s| s.reset());
                Response::from_string(r#"{"ok":true}"#).with_header(json_header())
            } else {
                Response::from_string("not found").with_status_code(404)
            };
            let _ = request.respond(response);
        }));
    }
    for h in handles {
        let _ = h.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_card_name_survives_the_query_string() {
        // Magic names are full of the characters a query string encodes: commas, apostrophes,
        // spaces, en dashes, and `//` on every split card. A capture whose label comes back
        // mangled is a mislabelled row in the corpus, which is worse than an unlabelled one —
        // it would be scored against, and it would be wrong.
        for name in [
            "Strider, Ranger of the North",
            "Bilbo Baggins, Burglar // Take a Glance",
            "Ashnod's Intervention",
            "Fear, Fire, Foes!",
            "Djeru, With Eyes Open",
        ] {
            let encoded: String = name
                .bytes()
                .map(|b| match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                        (b as char).to_string()
                    }
                    b' ' => "+".to_string(),
                    other => format!("%{other:02X}"),
                })
                .collect();
            assert_eq!(decode_component(&encoded), name, "round trip failed for {name}");
        }
    }

    #[test]
    fn a_truncated_escape_is_kept_rather_than_swallowed() {
        // A cut-off `%` at the end must not eat the rest of the value or panic on a slice
        // past the end. Keeping it verbatim is wrong-looking and safe; dropping it silently
        // shortens a name into a different one.
        assert_eq!(decode_component("abc%"), "abc%");
        assert_eq!(decode_component("abc%2"), "abc%2");
        assert_eq!(decode_component("%41bc"), "Abc");
    }

    #[test]
    fn query_pairs_reads_the_fields_the_capture_writes() {
        let q = query_pairs("/capture?expected=Prey+Upon&reported=&confidence=0.41");
        assert_eq!(q.get("expected").map(String::as_str), Some("Prey Upon"));
        // Present but empty is not the same as absent, and the sidecar records it as empty.
        assert_eq!(q.get("reported").map(String::as_str), Some(""));
        assert_eq!(q.get("confidence").map(String::as_str), Some("0.41"));
        assert!(q.get("nothing").is_none());
        // No query string at all must not panic.
        assert!(query_pairs("/capture").is_empty());
    }

    #[test]
    fn the_query_string_and_the_json_spell_the_same_options() {
        // Two spellings of one struct: this page sends short query keys, the app will send
        // `FrameOptions`' own field names as JSON. Nothing else would catch a key renamed on
        // one side only — the query string has no schema and a JSON field that never arrives
        // silently takes its default.
        let from_query =
            options_from_query("/frame?edge=800&method=otsu&decide=12&rule=confidence&stages=1");
        let from_json: FrameOptions = serde_json::from_str(
            r#"{"work_long_edge":800,"method":"otsu","decide_at":12,"rule":"confidence","stages":true}"#,
        )
        .expect("json");
        assert_eq!(from_query, from_json);
        assert_eq!(options_from_query("/frame"), FrameOptions::default());
    }
}
