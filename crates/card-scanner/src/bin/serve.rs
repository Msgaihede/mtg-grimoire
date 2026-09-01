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
use clap::Parser;
use std::sync::Arc;
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
}

/// Everything the page can change between frames, parsed from the query string.
struct FrameOptions {
    work_long_edge: u32,
    method: Option<EdgeMethod>,
    canny_low: f32,
    canny_high: f32,
    aspect_tolerance: f32,
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

fn handle_frame(body: &[u8], opts: &FrameOptions) -> serde_json::Value {
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
                if best.as_ref().is_none_or(|(_, b, _)| d.score.total > b.score.total) {
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
    });

    match best {
        Some((method, d, trace)) => {
            let descriptor = hash(
                &image::DynamicImage::ImageRgb8(d.rectified.clone()).to_luma8(),
                HashKind::DHash,
                256,
            );
            out["method"] = method.as_str().into();
            out["quad"] = serde_json::json!(d.quad.corners);
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
        }
        None => {
            out["error"] = error.unwrap_or_else(|| "no card".into()).into();
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
    out
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

    println!("card-scanner live view: http://{addr}");
    println!();
    println!("  On this machine, open that URL.");
    println!("  From an Android handset: adb reverse tcp:{p} tcp:{p}, then open", p = args.port);
    println!("  http://localhost:{} on the phone. A LAN address will NOT work —", args.port);
    println!("  getUserMedia refuses a non-secure origin and fails silently.");

    let mut handles = Vec::new();
    for _ in 0..args.workers.max(1) {
        let server = Arc::clone(&server);
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
                    Ok(_) => handle_frame(&body, &FrameOptions::from_query(&url)),
                    Err(e) => serde_json::json!({ "ok": false, "error": format!("read: {e}") }),
                };
                Response::from_string(value.to_string()).with_header(json_header())
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
