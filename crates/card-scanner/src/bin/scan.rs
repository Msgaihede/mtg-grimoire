//! `scan` — run the pipeline over image files and write the debug artifacts.
//!
//! This is the tool that turns "it seems to work" into a percentage. It runs without a
//! bundle (detection only), which is deliberate: tier 0 has to be right before matching
//! means anything, and a detector is worth tuning on its own.
//!
//! ```text
//! scan docs/scanner/scans/*.jpg --debug-dir out --method both
//! ```

use card_scanner::debug::{
    write_contact_sheet, write_detection, write_embedded_sheet, DebugWriter, SheetEntry,
};
use card_scanner::detect::{detect, DetectOptions, DetectTrace, Detection, EdgeMethod};
use card_scanner::hash::{hash, HashKind};
use card_scanner::index::{Bundle, Mask};
use card_scanner::reference::Reference;
use clap::Parser;
use std::path::PathBuf;
use std::time::Instant;

#[derive(Parser, Debug)]
#[command(name = "scan", about = "Detect and identify Magic cards in image files")]
struct Args {
    /// Image files to scan.
    #[arg(required = true)]
    paths: Vec<PathBuf>,

    /// Where to write the debug artifacts. Nothing is written without this.
    #[arg(long)]
    debug_dir: Option<PathBuf>,

    /// Which detector. `both` runs each and keeps whichever scores higher — which is also
    /// how the corpus decides which one to default to.
    #[arg(long, default_value = "both")]
    method: MethodArg,

    /// Long edge, in pixels, of the image detection runs on.
    #[arg(long, default_value_t = 1024)]
    work_long_edge: u32,

    #[arg(long, default_value_t = 40.0)]
    canny_low: f32,
    #[arg(long, default_value_t = 100.0)]
    canny_high: f32,
    #[arg(long, default_value_t = 0.02)]
    min_area_frac: f32,
    #[arg(long, default_value_t = 0.18)]
    aspect_tolerance: f32,
    #[arg(long, default_value_t = 22.0)]
    max_angle_error_deg: f32,

    /// Descriptor to compute for the rectified card. Reported even with no bundle to search,
    /// so two scans of the same card can be compared by hand.
    #[arg(long, default_value = "dhash")]
    hash: HashArg,
    #[arg(long, default_value_t = 256)]
    bits: u16,

    /// The reference bundle from `build-hashes`. Without it this detects and rectifies but
    /// names nothing.
    #[arg(long)]
    bundle: Option<PathBuf>,
    /// The app's `corpus.db`, to turn a matched id into a card name.
    #[arg(long)]
    corpus: Option<PathBuf>,
    /// Candidates to report per scan.
    #[arg(long, default_value_t = 3)]
    top: usize,

    /// Print one JSON object per scan instead of the table.
    #[arg(long)]
    json: bool,

    /// Also write `sheet-embedded.html`, a single self-contained page with every artifact
    /// inlined as a data URI. The plain sheet references the PNGs on disk and so only opens
    /// on this machine; this one can be sent to someone.
    #[arg(long)]
    embed: bool,
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
enum MethodArg {
    Canny,
    Otsu,
    Both,
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
enum HashArg {
    Dhash,
    Phash,
}

impl From<HashArg> for HashKind {
    fn from(h: HashArg) -> Self {
        match h {
            HashArg::Dhash => HashKind::DHash,
            HashArg::Phash => HashKind::PHash,
        }
    }
}

fn main() -> std::process::ExitCode {
    let args = Args::parse();

    if !matches!(args.bits, 128 | 256) {
        eprintln!("--bits must be 128 or 256, got {}", args.bits);
        return std::process::ExitCode::from(2);
    }

    let methods: Vec<EdgeMethod> = match args.method {
        MethodArg::Canny => vec![EdgeMethod::Canny],
        MethodArg::Otsu => vec![EdgeMethod::Otsu],
        MethodArg::Both => vec![EdgeMethod::Canny, EdgeMethod::Otsu],
    };

    let root = args.debug_dir.clone();
    if let Some(r) = &root {
        if let Err(e) = std::fs::create_dir_all(r) {
            eprintln!("cannot create {}: {e}", r.display());
            return std::process::ExitCode::from(1);
        }
    }

    // Loading the bundle is best effort: a missing or half-built one costs the naming and
    // nothing else, which matters because the bundle takes half an hour to build and the
    // detector is worth running against the corpus meanwhile.
    let reference = args.bundle.as_ref().and_then(|path| {
        let bytes = std::fs::read(path)
            .map_err(|e| eprintln!("bundle {}: {e}", path.display()))
            .ok()?;
        let bundle = Bundle::from_bytes(&bytes)
            .map_err(|e| eprintln!("bundle {}: {e}", path.display()))
            .ok()?;
        eprintln!(
            "bundle: {} printings, {} artworks, {} at {} bits",
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
                    Ok(n) => eprintln!("corpus: {n} labels"),
                    Err(e) => eprintln!("corpus {}: {e}", corpus.display()),
                },
                Err(e) => eprintln!("corpus {}: {e}", corpus.display()),
            }
        }
        Some(reference)
    });

    let mut entries: Vec<SheetEntry> = Vec::new();
    let mut found = 0usize;
    let mut failed_to_open = 0usize;
    let mut total_ms = 0f64;

    if !args.json {
        println!(
            "{:<28} {:>7} {:>6} {:>7} {:>6} {:>6}  {}",
            "file", "ms", "method", "aspect", "area", "angle",
            if reference.is_some() { "match" } else { "hash" }
        );
    }

    for path in &args.paths {
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| path.display().to_string());

        let source = match image::open(path) {
            Ok(i) => i,
            Err(e) => {
                failed_to_open += 1;
                if args.json {
                    println!(
                        "{}",
                        serde_json::json!({ "file": name, "error": e.to_string() })
                    );
                } else {
                    println!("{name:<28} {:>7}  open failed: {e}", "-");
                }
                continue;
            }
        };

        // Run each requested detector and keep the better-scoring result. With `--method
        // both` this is also the measurement: the per-scan `method` column is the answer to
        // "which detector should the default be".
        let started = Instant::now();
        let mut best: Option<(EdgeMethod, Detection, Option<DetectTrace>)> = None;
        let mut last_fail: Option<(String, Option<DetectTrace>)> = None;

        for m in &methods {
            let opts = DetectOptions {
                method: *m,
                work_long_edge: args.work_long_edge,
                canny_low: args.canny_low,
                canny_high: args.canny_high,
                min_area_frac: args.min_area_frac,
                aspect_tolerance: args.aspect_tolerance,
                max_angle_error_deg: args.max_angle_error_deg,
                ..Default::default()
            };
            let (result, trace) = detect(&source, &opts);
            match result {
                Ok(d) => {
                    let better =
                        best.as_ref().is_none_or(|(_, b, _)| d.score.total > b.score.total);
                    if better {
                        best = Some((*m, d, trace));
                    }
                }
                Err(e) => last_fail = Some((e.to_string(), trace)),
            }
        }
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        total_ms += elapsed;

        let scan_dir_name = sanitize(&name);
        let writer = root.as_ref().map(|r| DebugWriter::new(r.join(&scan_dir_name)));

        match best {
            Some((method, d, trace)) => {
                found += 1;
                let descriptor = hash(
                    &image::DynamicImage::ImageRgb8(d.rectified.clone()).to_luma8(),
                    args.hash.into(),
                    args.bits,
                );
                // Both orientations, because a card is 180°-symmetric and the quad cannot
                // say which end is the top.
                let matched = reference.as_ref().map(|r| {
                    let upright =
                        image::DynamicImage::ImageRgb8(d.rectified.clone()).to_luma8();
                    let flipped =
                        image::DynamicImage::ImageRgb8(d.rectified_180.clone()).to_luma8();
                    r.match_card(&upright, &flipped, args.top.clamp(1, 25), &Mask::all())
                });

                let detail = format!(
                    "{} aspect={:.3} area={:.3} angle={:.1}deg score={:.3}",
                    method.as_str(),
                    d.score.aspect,
                    d.score.area_frac,
                    d.score.max_angle_error,
                    d.score.total
                );

                if let Some(Ok(w)) = &writer {
                    let _ = write_detection(w, &source, trace.as_ref(), Some(&d));
                    let _ = w.json(
                        "result",
                        &serde_json::json!({
                            "file": name,
                            "found": true,
                            "method": method.as_str(),
                            "elapsed_ms": elapsed,
                            "quad": d.quad.corners,
                            "score": d.score,
                            "timings": trace.as_ref().map(|t| t.timings),
                            "candidates": trace.as_ref().map(|t| t.candidates.iter().map(|c| serde_json::json!({
                                "corners": c.quad.corners, "score": c.score,
                            })).collect::<Vec<_>>()),
                            "hash": { "kind": args.hash_kind_str(), "bits": args.bits, "hex": descriptor.to_hex() },
                            "match": matched,
                        }),
                    );
                }

                if args.json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "file": name, "found": true, "method": method.as_str(),
                            "elapsed_ms": elapsed, "score": d.score,
                            "timings": trace.as_ref().map(|t| t.timings),
                            "hash": descriptor.to_hex(),
                            "match": matched,
                        })
                    );
                } else {
                    let tail = match &matched {
                        Some(m) => match m.candidates.first() {
                            Some(c) => format!(
                                "{:<38} d={} {}",
                                c.label.as_ref().map(|l| l.display()).unwrap_or_else(|| c.id[..8].to_string()),
                                c.distance,
                                if m.rotated { "(180)" } else { "" }
                            ),
                            None => "no candidate".to_string(),
                        },
                        None => descriptor.to_hex()[..16].to_string(),
                    };
                    println!(
                        "{name:<28} {elapsed:>7.0} {:>6} {:>7.3} {:>6.3} {:>6.1}  {tail}",
                        method.as_str(),
                        d.score.aspect,
                        d.score.area_frac,
                        d.score.max_angle_error,
                    );
                }

                entries.push(SheetEntry {
                    name,
                    dir: scan_dir_name,
                    found: true,
                    detail,
                    elapsed_ms: elapsed,
                    method: Some(method.as_str().to_string()),
                    via: Some(d.score.via.as_str().to_string()),
                    aspect: Some(d.score.aspect),
                    area: Some(d.score.area_frac),
                    angle: Some(d.score.max_angle_error),
                    score: Some(d.score.total),
                });
            }
            None => {
                let (msg, fail_trace) = last_fail
                    .unwrap_or_else(|| ("no card".to_string(), None));
                if let Some(Ok(w)) = &writer {
                    let _ = write_detection(w, &source, fail_trace.as_ref(), None);
                    let _ = w.json(
                        "result",
                        &serde_json::json!({
                            "file": name, "found": false, "error": msg,
                            "candidates": fail_trace.as_ref().map(|t| t.candidates.iter().map(|c| serde_json::json!({
                                "corners": c.quad.corners, "score": c.score,
                            })).collect::<Vec<_>>()),
                        }),
                    );
                }
                if args.json {
                    println!(
                        "{}",
                        serde_json::json!({ "file": name, "found": false, "error": msg })
                    );
                } else {
                    println!("{name:<28} {elapsed:>7.0}  -- {msg}");
                }
                entries.push(SheetEntry {
                    name,
                    dir: scan_dir_name,
                    found: false,
                    detail: msg,
                    elapsed_ms: elapsed,
                    method: None,
                    via: None,
                    aspect: None,
                    area: None,
                    angle: None,
                    score: None,
                });
            }
        }
    }

    if let Some(r) = &root {
        match write_contact_sheet(r, &entries) {
            Ok(p) => eprintln!("\ncontact sheet: {}", p.display()),
            Err(e) => eprintln!("\ncould not write the contact sheet: {e}"),
        }
        if args.embed {
            match write_embedded_sheet(r, &entries, "Card scanner — tier 0 debug") {
                Ok(p) => eprintln!("embedded sheet: {}", p.display()),
                Err(e) => eprintln!("could not write the embedded sheet: {e}"),
            }
        }
    }

    let n = args.paths.len();
    eprintln!(
        "{found}/{n} detected ({:.0}% ){}, mean {:.0} ms",
        100.0 * found as f64 / n.max(1) as f64,
        if failed_to_open > 0 {
            format!(", {failed_to_open} could not be opened")
        } else {
            String::new()
        },
        total_ms / n.max(1) as f64
    );

    if found == 0 && n > 0 {
        std::process::ExitCode::from(1)
    } else {
        std::process::ExitCode::SUCCESS
    }
}

impl Args {
    fn hash_kind_str(&self) -> &'static str {
        HashKind::from(self.hash).as_str()
    }
}

/// A filename turned into a directory name safe on Windows and POSIX alike.
fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}
