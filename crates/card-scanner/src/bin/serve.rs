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

use card_scanner::detect::{detect, DetectOptions, DetectTrace, Detection, EdgeMethod};
use card_scanner::hash::{hash, HashKind};
use card_scanner::index::{Bundle, Mask};
use card_scanner::lock::QuadLock;
use card_scanner::ocr::TitleReader;
use card_scanner::reference::Reference;
use card_scanner::track::Tracker;
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

    /// Write each frame's rectified card and its numbers into this directory.
    ///
    /// The camera is held by one page at a time, so the live rectification cannot be
    /// inspected from a second browser — and it is the one thing that actually explains why a
    /// card matching at 45 bits as a photograph matches at 70 from a webcam. Numbers describe
    /// the failure; the image is the failure.
    #[arg(long)]
    dump_dir: Option<PathBuf>,

    /// Directory holding the ocrs models. Enables the OCR tier.
    ///
    /// Fetch them with `scripts/fetch-ocr-models.mjs`.
    #[arg(long)]
    ocr_models: Option<PathBuf>,
}

/// The tracker is shared rather than per-request, because it is the one deliberately stateful
/// piece of this server: a stable answer is a property of the *stream*, not of any one frame.
/// One camera, one page, one tracker. The app will own one per scanning session instead.
type Shared = Arc<Mutex<Tracker>>;
/// The quad lock is per-stream for the same reason the tracker is: staying still is a
/// property of the sequence, not of a frame.
type SharedLock = Arc<Mutex<QuadLock>>;

/// **OCR runs only while the hash tier is still unsure, and never more than every few
/// frames.** Reading a title costs ~250 ms against a ~80 ms frame, so running it on every
/// frame would cut the rate by two thirds to answer a question that is usually already
/// answered. It is a tie-breaker: it earns its cost exactly when appearance has failed — a
/// foil under a lamp, where the hash's top five do not contain the card at all and the title
/// is still perfectly legible.
const OCR_EVERY: u64 = 4;

/// Everything the page can change between frames, parsed from the query string.
struct FrameOptions {
    work_long_edge: u32,
    method: Option<EdgeMethod>,
    canny_low: f32,
    canny_high: f32,
    aspect_tolerance: f32,
    min_cardness: f32,
    /// Return the binary and contour images as well as the quad. Roughly doubles the
    /// response time, so the page asks for it only while the panel is open.
    stages: bool,
}

impl FrameOptions {
    fn from_query(url: &str) -> FrameOptions {
        let q = url.split_once('?').map(|(_, q)| q).unwrap_or("");
        let get = |key: &str| -> Option<String> {
            q.split('&')
                .filter_map(|kv| kv.split_once('='))
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.to_string())
        };
        let num = |key: &str, default: f32| -> f32 {
            get(key).and_then(|v| v.parse().ok()).unwrap_or(default)
        };
        FrameOptions {
            work_long_edge: num("edge", 1024.0) as u32,
            method: match get("method").as_deref() {
                Some("canny") => Some(EdgeMethod::Canny),
                Some("otsu") => Some(EdgeMethod::Otsu),
                _ => None, // both
            },
            canny_low: num("lo", 40.0),
            canny_high: num("hi", 100.0),
            aspect_tolerance: num("aspect", 0.18),
            min_cardness: num("cardness", card_scanner::cardness::MIN_SCORE),
            stages: get("stages").as_deref() == Some("1"),
        }
    }

    fn detect_options(&self, method: EdgeMethod) -> DetectOptions {
        DetectOptions {
            method,
            work_long_edge: self.work_long_edge.clamp(240, 2048),
            canny_low: self.canny_low,
            canny_high: self.canny_high,
            aspect_tolerance: self.aspect_tolerance,
            min_cardness: self.min_cardness,
            ..Default::default()
        }
    }
}

fn json_header() -> Header {
    Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).expect("static header")
}

fn html_header() -> Header {
    Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
        .expect("static header")
}

/// A small JPEG data URI, for the stage images the panel shows.
fn preview_uri<P, C>(img: &image::ImageBuffer<P, C>, max_edge: u32, quality: u8) -> Option<String>
where
    P: image::Pixel<Subpixel = u8> + 'static,
    C: std::ops::Deref<Target = [u8]>,
{
    let dynamic = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(
        img.width(),
        img.height(),
        |x, y| {
            let p = img.get_pixel(x, y).to_rgb();
            image::Rgb([p[0], p[1], p[2]])
        },
    ));
    let small = dynamic.resize(max_edge, max_edge, image::imageops::FilterType::Triangle);
    let mut buf = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality)
        .encode_image(&small.to_rgb8())
        .ok()?;
    Some(format!("data:image/jpeg;base64,{}", base64(&buf)))
}

fn base64(data: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { A[n as usize & 63] as char } else { '=' });
    }
    out
}

fn handle_frame(
    body: &[u8],
    opts: &FrameOptions,
    reference: Option<&Reference>,
    top: usize,
    tracker: &Shared,
    quad_lock: &SharedLock,
    log: bool,
    dump: Option<&std::path::Path>,
    reader: Option<&TitleReader>,
) -> serde_json::Value {
    let decode_started = std::time::Instant::now();
    let source = match image::load_from_memory(body) {
        Ok(i) => i,
        Err(e) => return serde_json::json!({ "ok": false, "error": format!("decode: {e}") }),
    };
    let decode_ms = decode_started.elapsed().as_secs_f32() * 1000.0;
    let (w, h) = (source.width(), source.height());

    let methods: Vec<EdgeMethod> = match opts.method {
        Some(m) => vec![m],
        None => vec![EdgeMethod::Canny, EdgeMethod::Otsu],
    };

    let mut best: Option<(EdgeMethod, Detection, Option<DetectTrace>)> = None;
    let mut fallback_trace: Option<DetectTrace> = None;
    let mut error = None;
    for m in methods {
        let (result, trace) = detect(&source, &opts.detect_options(m));
        match result {
            Ok(d) => {
                // **Card-likeness picks the method, not the geometric score.** Measured, it
                // predicts a good match 83% of the time against geometry's 62% — and more to
                // the point here, geometry made the winner alternate between Canny and Otsu
                // from frame to frame, handing back a different quad each time. Nothing can
                // lock onto a target that changes every frame, and a card that appears for one
                // frame and vanishes is what that looks like from the outside.
                if best
                    .as_ref()
                    .is_none_or(|(_, b, _): &(_, Detection, _)| {
                        d.cardness.score > b.cardness.score
                    })
                {
                    best = Some((m, d, trace));
                }
            }
            Err(e) => {
                error = Some(e.to_string());
                if trace.is_some() {
                    fallback_trace = trace;
                }
            }
        }
    }

    let mut out = serde_json::json!({
        "ok": best.is_some(),
        "frame": { "w": w, "h": h },
        "decode_ms": decode_ms,
        // Reported on every response, and separately from `match`. "No bundle is loaded" and
        // "a bundle is loaded but this frame held no card" are different states, and the
        // page said the former for both until this existed.
        "matcher": reference.is_some(),
    });

    // The lock decides whether this frame is worth believing. Nothing is rejected on
    // appearance — a quad simply has to still be there next frame.
    let lock_state = quad_lock
        .lock()
        .map(|mut l| l.observe(best.as_ref().map(|(_, d, _)| d.quad)))
        .ok();
    if let Some(st) = &lock_state {
        out["lock"] = serde_json::to_value(st).unwrap_or_default();
        // The smoothed quad is what the overlay draws: raw detection jitters by a few pixels
        // on a perfectly still card, and a twitching box reads as a broken detector.
        if let Some(q) = st.quad {
            out["quad"] = serde_json::json!(q.corners);
        }
    }
    let trusted = lock_state.as_ref().is_some_and(|s| s.is_trusted());
    // Grabbed before the match consumes `best`, and only when dumping is on — a 488x680
    // clone is a megabyte and there is no reason to pay it otherwise.
    let dumped = dump.and(best.as_ref().map(|(_, d, _)| d.rectified.clone()));

    match best {
        Some((method, d, trace)) => {
            let descriptor = hash(
                &image::DynamicImage::ImageRgb8(d.rectified.clone()).to_luma8(),
                HashKind::DHash,
                256,
            );
            out["method"] = method.as_str().into();
            // **Deliberately not `d.quad`.** The lock's smoothed quad was written above and
            // overwriting it here is what made the box wobble: raw detection moves several
            // pixels a frame on a perfectly still card, the smoothing existed to damp exactly
            // that, and this line threw it away one branch later. The raw quad is still
            // reported, under its own key, so the debug view can show both.
            out["quad_raw"] = serde_json::json!(d.quad.corners);
            if out["quad"].is_null() {
                out["quad"] = serde_json::json!(d.quad.corners);
            }
            out["cardness"] = serde_json::to_value(d.cardness).unwrap_or_default();
            out["score"] = serde_json::to_value(d.score).unwrap_or_default();
            out["hash"] = descriptor.to_hex().into();
            if let Some(t) = &trace {
                out["timings"] = serde_json::to_value(t.timings).unwrap_or_default();
            }
            // The rectified card is the payload a reader actually wants to see, so it is
            // always returned — it is one small JPEG and it is the proof the homography is
            // right.
            if let Some(uri) = preview_uri(&d.rectified, 320, 78) {
                out["rectified"] = uri.into();
            }
            if opts.stages {
                if let Some(t) = &trace {
                    out["stages"] = serde_json::json!({
                        "binary": preview_uri(&t.binary, 300, 62),
                        "contours": preview_uri(&t.contours, 300, 62),
                        "quad": preview_uri(&t.quads, 300, 62),
                    });
                }
            }

            // The match itself. Both orientations are hashed inside `match_card`, because a
            // card is 180°-symmetric and the quad cannot say which end is the top.
            if let Some(r) = reference.filter(|_| trusted) {
                let upright = &d.rectified;
                let flipped = &d.rectified_180;
                let report = r.match_card(upright, flipped, top, &Mask::all());

                // Accumulate across frames. A per-frame top-1 flickers between near-ties
                // several times a second; the stable answer is the one that keeps recurring.
                // Grouped by oracle id: a card's reprints pool their evidence instead of
                // splitting it, and the printing reported is the best-scoring member.
                let observations: Vec<_> = report
                    .candidates
                    .iter()
                    .filter_map(|c| {
                        card_scanner::index::parse_uuid(&c.id).map(|id| {
                            card_scanner::track::Observation::appearance(
                                r.oracle_for(&id),
                                id,
                                c.normalized,
                            )
                        })
                    })
                    .collect();
                // The OCR tier, when the hash tier has not settled it. A resolved name is
                // much stronger evidence than a nearest neighbour — it is a reading of what
                // the card says rather than a guess at what it looks like — so it enters the
                // accumulator at a distance the hash tier can rarely reach.
                let mut observations = observations;
                let uncommitted = tracker
                    .lock()
                    .map(|t| !t.last_committed())
                    .unwrap_or(true);
                if let Some(reader) = reader.filter(|_| uncommitted) {
                    static SEQ: std::sync::atomic::AtomicU64 =
                        std::sync::atomic::AtomicU64::new(0);
                    if SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % OCR_EVERY == 0 {
                        let read = reader.read_title(&d.rectified, &d.rectified_180);
                        let hit = read
                            .is_usable()
                            .then(|| r.lookup_by_name(&read.normalized))
                            .flatten();
                        out["ocr"] = serde_json::json!({
                            "raw": read.raw,
                            "rotated": read.rotated,
                            "elapsed_ms": read.elapsed_ms,
                            "matched": hit.and_then(|(id, _)| r.label_for(&id)).map(|l| l.name),
                            "edits": hit.map(|(_, d)| d),
                        });
                        if let Some((id, edits)) = hit {
                            observations.insert(
                                0,
                                card_scanner::track::Observation::from_ocr(
                                    r.oracle_for(&id),
                                    id,
                                    edits,
                                ),
                            );
                        }
                    }
                }

                if let Ok(mut t) = tracker.lock() {
                    out["tracked"] = tracked_json(&t.observe(&observations), Some(r));
                }
                out["match"] = serde_json::to_value(&report).unwrap_or_default();
            } else if reference.is_some() {
                // Detected but not yet trusted: tell the tracker nothing was seen, so a box
                // that never locks can never accumulate a name.
                if let Ok(mut t) = tracker.lock() {
                    out["tracked"] = tracked_json(&t.observe(&[]), reference);
                }
            }
        }
        None => {
            // A frame with no card is still an observation: it is how the tracker learns the
            // card has been taken away. Dropping it would leave stale evidence standing.
            if reference.is_some() {
                if let Ok(mut t) = tracker.lock() {
                    out["tracked"] = tracked_json(&t.observe(&[]), reference);
                }
            }
            out["error"] = error.unwrap_or_else(|| "no card".into()).into();
            if let Some(t) = &fallback_trace {
                if let Some(best) = t.candidates.first() {
                    out["rejected_cardness"] =
                        serde_json::to_value(best.cardness).unwrap_or_default();
                }
            }
            if let Some(t) = &fallback_trace {
                out["timings"] = serde_json::to_value(t.timings).unwrap_or_default();
                out["candidates_examined"] = t.candidates.len().into();
                if opts.stages {
                    out["stages"] = serde_json::json!({
                        "binary": preview_uri(&t.binary, 300, 62),
                        "contours": preview_uri(&t.contours, 300, 62),
                        "quad": preview_uri(&t.quads, 300, 62),
                    });
                }
            }
        }
    }

    if let Some(dir) = dump {
        // A rolling window, so a long session does not fill the disk and the newest frames
        // are always the ones on top.
        static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % 40;
        let _ = std::fs::create_dir_all(dir);
        if let Some(img) = &dumped {
            let _ = img.save(dir.join(format!("{n:02}-rectified.png")));
        }
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
        eprintln!(
            "frame lock={:<9} cardness={:.2} aspect={:.3} conf={:5.1}% {} | {}",
            out["lock"]["phase"].as_str().unwrap_or("-"),
            out["cardness"]["score"].as_f64().unwrap_or(0.0),
            out["score"]["aspect"].as_f64().unwrap_or(0.0),
            out["tracked"]["confidence"].as_f64().unwrap_or(0.0) * 100.0,
            if out["tracked"]["committed"].as_bool().unwrap_or(false) { "OK " } else { "..." },
            if cands.is_empty() {
                out["error"].as_str().unwrap_or("(not matched)").to_string()
            } else {
                cands.join("  |  ")
            }
        );
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

/// The tracker deals in ids; the page needs names. Resolved here rather than inside
/// `track`, which is deliberately independent of the corpus.
fn tracked_json(
    tracked: &card_scanner::track::Tracked,
    reference: Option<&Reference>,
) -> serde_json::Value {
    let standings: Vec<_> = tracked
        .standings
        .iter()
        .map(|s| {
            serde_json::json!({
                "id": card_scanner::index::format_uuid(&s.id),
                "evidence": s.evidence,
                "share": s.share,
                "seen": s.seen,
                "label": reference.and_then(|r| r.label_for(&s.best_member)),
                "best_distance": s.best_normalized,
            })
        })
        .collect();
    serde_json::json!({
        "committed": tracked.committed,
        "confidence": tracked.confidence,
        "streak": tracked.streak,
        "frames": tracked.frames,
        "misses": tracked.misses,
        "standings": standings,
    })
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

    let reference = Arc::new(load_reference(&args));
    let tracker: Shared = Arc::new(Mutex::new(Tracker::default()));
    let quad_lock: SharedLock = Arc::new(Mutex::new(QuadLock::default()));
    let reader = Arc::new(args.ocr_models.as_ref().and_then(|dir| {
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
    }));
    let top = args.top.clamp(1, 25);

    println!("card-scanner live view: http://{addr}");
    println!();
    println!("  On this machine, open that URL.");
    println!("  From an Android handset: adb reverse tcp:{p} tcp:{p}, then open", p = args.port);
    println!("  http://localhost:{} on the phone. A LAN address will NOT work —", args.port);
    println!("  getUserMedia refuses a non-secure origin and fails silently.");

    let mut handles = Vec::new();
    for _ in 0..args.workers.max(1) {
        let server = Arc::clone(&server);
        let reference = Arc::clone(&reference);
        let tracker = Arc::clone(&tracker);
        let quad_lock = Arc::clone(&quad_lock);
        let log_frames = args.log_frames;
        let dump_dir = args.dump_dir.clone();
        let reader = Arc::clone(&reader);
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
                    // **Every frame is handled inside `catch_unwind`, and that is not
                    // defensive padding.** The options come from a query string driven by
                    // live sliders, and the image-processing crates below assert on
                    // arguments they consider impossible — `edges::canny` panics outright
                    // when the low threshold exceeds the high one. Without this, a single
                    // bad frame took down the worker thread that handled it, and dragging
                    // one slider killed all of them and exited the server. A dev tool that
                    // dies while you are adjusting it is worse than one that reports the
                    // failure and carries on.
                    Ok(_) => {
                        let opts = FrameOptions::from_query(&url);
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            handle_frame(
                                &body,
                                &opts,
                                reference.as_ref().as_ref(),
                                top,
                                &tracker,
                                &quad_lock,
                                log_frames,
                                dump_dir.as_deref(),
                                reader.as_ref().as_ref(),
                            )
                        }))
                        .unwrap_or_else(|_| {
                            serde_json::json!({
                                "ok": false,
                                "error": "the detector panicked on this frame — see the \
                                          server log for the assertion",
                            })
                        })
                    }
                    Err(e) => serde_json::json!({ "ok": false, "error": format!("read: {e}") }),
                };
                Response::from_string(value.to_string()).with_header(json_header())
            } else if path == "/reset" {
                // So a reader can start on a new card immediately instead of waiting for the
                // previous one's evidence to decay.
                if let Ok(mut t) = tracker.lock() {
                    t.reset();
                }
                if let Ok(mut l) = quad_lock.lock() {
                    l.reset();
                }
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
