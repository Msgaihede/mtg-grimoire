//! `ocr-bench` — both OCR readers, timed and scored on the synthetic evaluation's bands.
//!
//! **Synthetic, like `eval`: a regression fence and a stopwatch, never an accuracy claim about a
//! camera.** It exists because `eval` answers "did the scan decide the right card", and a
//! change to a reader moves that only indirectly, through the tracker, on the one frame in
//! four the readers run. This asks the reader's own question on every band it is handed.
//!
//! ```text
//! ocr-bench --bundle card-hashes.bin --corpus corpus.db --models models \
//!           --printings crates/card-scanner/eval/printings.txt --cache eval-cache \
//!           [--seed 7] [--frames 0,6] [--out bands.jsonl]
//! ```
//!
//! For each printing whose render `eval` has already cached, it makes the same burst `eval`
//! does, detects and rectifies the chosen frames, and reads the title and the collector line
//! off each rectification. **The bands are deterministic** — the burst is seeded per printing
//! and the detector has no state — so two builds run against the same cache read the same
//! pixels, and a before/after is a diff of two runs rather than two code paths kept alive in
//! one binary. Byte-identical per platform, as `synth` is.
//!
//! **One card at a time, on purpose.** The milliseconds are the point, and `eval`'s workers
//! share cores and the recogniser's thread pool, which makes its ms column a figure under load.
//! Here nothing else is running, so a read's time is the read's.
//!
//! Scored against the corpus, as #700 defines a reader's rates:
//!
//! - **title**: *exact* — the normalized read is a name and it is this card's; *corrected* —
//!   it resolves to this card at one edit or more; *wrong* — it resolves to another card;
//!   *junk* — it resolves to nothing.
//! - **collector**: *resolved* — a pairing names this printing; *conflicting* — a pairing names
//!   another printing; *none* — nothing it offered names a printing at all.

use card_scanner::detect::{detect, rectify_views, DetectOptions, Detection, EdgeMethod};
use card_scanner::index::{format_uuid, parse_uuid, Bundle, Mask, ID_LEN};
use card_scanner::ocr::{self, TitleReader};
use card_scanner::reference::Reference;
use card_scanner::synth::{burst, SynthOptions};
use clap::Parser;
use image::RgbImage;
use std::io::Write as _;
use std::path::{Path, PathBuf};

#[derive(Parser, Debug)]
#[command(
    name = "ocr-bench",
    about = "Time and score the scanner's two OCR readers"
)]
struct Args {
    /// The reference bundle — for the name and collector indexes the reads are scored against.
    #[arg(long)]
    bundle: PathBuf,
    /// The app's `corpus.db`. Opened read-only.
    #[arg(long)]
    corpus: PathBuf,
    /// Directory holding `text-detection.rten` and `text-recognition.rten`.
    #[arg(long)]
    models: PathBuf,
    /// The printings to read, one id per line; `eval`'s list.
    #[arg(long)]
    printings: PathBuf,
    /// `eval`'s render cache. Nothing is fetched: a printing with no cached render is skipped.
    #[arg(long)]
    cache: PathBuf,
    #[arg(long, default_value_t = 7)]
    seed: u64,
    /// Which frames of each burst to read, comma-separated, 0-based.
    #[arg(long, default_value = "0,6", value_delimiter = ',')]
    frames: Vec<usize>,
    /// Which ways of finding the text to run. Both, by default, on every band in turn.
    #[arg(long, value_enum, default_values_t = [Finder::Detection, Finder::Projection], value_delimiter = ',')]
    finders: Vec<Finder>,
    /// Also write one JSON line per band per finder — the reads themselves, for diffing.
    #[arg(long)]
    out: Option<PathBuf>,
    /// Also write each title and collector band, both ways up, with the lines
    /// `ocr::text_lines` found drawn on it — what to look at when a read goes wrong.
    #[arg(long)]
    dump: Option<PathBuf>,
}

/// What the corpus says a printing is.
struct Truth {
    id: [u8; ID_LEN],
    name: String,
    set: String,
    number: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum TitleVerdict {
    Exact,
    Corrected,
    Wrong,
    Junk,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum CollectorVerdict {
    Resolved,
    Conflicting,
    None,
}

/// How a read finds the text in its band.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum Finder {
    /// `ocrs`'s detection model and the full alphabet — the read before #707.
    Detection,
    /// `ocr::text_lines`, straight to the recogniser — the read since.
    Projection,
}

#[derive(serde::Serialize)]
struct Band {
    id: String,
    name: String,
    printing: String,
    frame: usize,
    finder: Finder,
    title: String,
    title_rotated: bool,
    title_verdict: TitleVerdict,
    title_ms: f32,
    collector: String,
    collector_rotated: bool,
    collector_verdict: CollectorVerdict,
    collector_ms: f32,
}

fn main() -> std::process::ExitCode {
    match run(Args::parse()) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("ocr-bench: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}

fn run(args: Args) -> Result<(), String> {
    let conn = rusqlite::Connection::open_with_flags(
        &args.corpus,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("cannot open corpus {}: {e}", args.corpus.display()))?;
    let bundle = std::fs::read(&args.bundle)
        .map_err(|e| format!("cannot read bundle {}: {e}", args.bundle.display()))?;
    let mut reference =
        Reference::new(Bundle::from_bytes(&bundle).map_err(|e| format!("bundle: {e}"))?);
    reference
        .load_labels(&conn)
        .map_err(|e| format!("corpus labels: {e}"))?;
    let mut reader = TitleReader::load(
        &args.models.join("text-detection.rten"),
        &args.models.join("text-recognition.rten"),
    )?;

    let wanted = std::fs::read_to_string(&args.printings)
        .map_err(|e| format!("cannot read {}: {e}", args.printings.display()))?;
    let truths = truths(&conn, &wanted)?;
    let synth = SynthOptions {
        seed: args.seed,
        ..Default::default()
    };
    let mut out = match &args.out {
        Some(p) => Some(std::io::BufWriter::new(
            std::fs::File::create(p).map_err(|e| format!("cannot write {}: {e}", p.display()))?,
        )),
        None => None,
    };

    // One read of each kind before the clock matters: the first call allocates the
    // recogniser's buffers.
    let warm = image::RgbImage::from_pixel(
        card_scanner::RECTIFIED_W,
        card_scanner::RECTIFIED_H,
        image::Rgb([200, 200, 200]),
    );
    for &finder in &args.finders {
        reader.set_text_detection(finder == Finder::Detection);
        let _ = reader.read_title(&warm, &warm);
        let _ = reader.read_collector(&warm, &warm);
    }

    let mut bands: Vec<Band> = Vec::new();
    let (mut skipped, mut undetected, mut seen) = (0usize, 0usize, 0usize);
    for (n, truth) in truths.iter().enumerate() {
        let Some(render) = cached_render(&args.cache, &truth.id) else {
            skipped += 1;
            continue;
        };
        let image = image::open(&render)
            .map_err(|e| format!("cannot decode {}: {e}", render.display()))?
            .to_rgb8();
        let frames = burst(&image, &synth, card_index(&truth.id));
        for &f in &args.frames {
            let Some(jpeg) = frames.get(f) else { continue };
            let Some((upright, flipped)) = rectified(jpeg) else {
                undetected += 1;
                continue;
            };
            if let Some(dir) = &args.dump {
                dump(
                    dir,
                    &format!("{}-f{f}", format_uuid(&truth.id)),
                    &upright,
                    &flipped,
                )?;
            }
            // **Each band through every finder, back to back, in alternating order**, so a
            // machine that gets busier or quieter over the run moves both columns alike.
            seen += 1;
            let mut order = args.finders.clone();
            if seen % 2 == 0 {
                order.reverse();
            }
            for finder in order {
                reader.set_text_detection(finder == Finder::Detection);
                let title = reader.read_title(&upright, &flipped);
                let collector = reader.read_collector(&upright, &flipped);
                let band = Band {
                    id: format_uuid(&truth.id),
                    name: truth.name.clone(),
                    printing: format!("{} {}", truth.set.to_uppercase(), truth.number),
                    frame: f,
                    finder,
                    title_verdict: score_title(&reference, truth, &title),
                    title: title.raw,
                    title_rotated: title.rotated,
                    title_ms: title.elapsed_ms,
                    collector_verdict: score_collector(&reference, truth, &collector.candidates),
                    collector: collector.raw,
                    collector_rotated: collector.rotated,
                    collector_ms: collector.elapsed_ms,
                };
                if let Some(w) = out.as_mut() {
                    let line = serde_json::to_string(&band).map_err(|e| e.to_string())?;
                    writeln!(w, "{line}").map_err(|e| e.to_string())?;
                }
                bands.push(band);
            }
        }
        eprint!("\r{}/{}", n + 1, truths.len());
    }
    eprintln!();

    println!(
        "{seen} bands from {} printings ({skipped} with no cached render, {undetected} frames \
         undetected), frames {:?}, seed {}",
        truths.len() - skipped,
        args.frames,
        args.seed
    );
    println!();
    println!("| finder | read | n | ms mean | ms median | ms p90 | ms max |");
    println!("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
    for &finder in &args.finders {
        let mine: Vec<&Band> = bands.iter().filter(|b| b.finder == finder).collect();
        for (what, ms) in [
            ("title", mine.iter().map(|b| b.title_ms).collect::<Vec<_>>()),
            (
                "collector",
                mine.iter().map(|b| b.collector_ms).collect::<Vec<_>>(),
            ),
        ] {
            let (n, mean, median, p90, max) = stats(ms);
            println!(
                "| {finder:?} | {what} | {n} | {mean:.0} | {median:.0} | {p90:.0} | {max:.0} |"
            );
        }
    }
    println!();
    println!("| finder | title exact | corrected | wrong | junk | collector resolved | conflicting | none |");
    println!("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for &finder in &args.finders {
        let mine: Vec<&Band> = bands.iter().filter(|b| b.finder == finder).collect();
        let n = mine.len().max(1) as f32;
        let pct = |k: usize| format!("{k} ({:.1}%)", 100.0 * k as f32 / n);
        let t = |v: TitleVerdict| pct(mine.iter().filter(|b| b.title_verdict == v).count());
        let c = |v: CollectorVerdict| pct(mine.iter().filter(|b| b.collector_verdict == v).count());
        println!(
            "| {finder:?} | {} | {} | {} | {} | {} | {} | {} |",
            t(TitleVerdict::Exact),
            t(TitleVerdict::Corrected),
            t(TitleVerdict::Wrong),
            t(TitleVerdict::Junk),
            c(CollectorVerdict::Resolved),
            c(CollectorVerdict::Conflicting),
            c(CollectorVerdict::None),
        );
    }
    Ok(())
}

/// The four bands of one rectification, with the lines found in each outlined in red.
fn dump(dir: &Path, stem: &str, upright: &RgbImage, flipped: &RgbImage) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    for (what, band) in [
        ("title-up", ocr::title_band(upright)),
        ("title-down", ocr::title_band(flipped)),
        ("collector-up", ocr::collector_band(upright)),
        ("collector-down", ocr::collector_band(flipped)),
    ] {
        let mut shown = band.clone();
        for l in ocr::text_lines(&band) {
            let rect = imageproc::rect::Rect::at(l.left as i32, l.top as i32)
                .of_size((l.right - l.left).max(1), (l.bottom - l.top).max(1));
            imageproc::drawing::draw_hollow_rect_mut(&mut shown, rect, image::Rgb([255, 0, 0]));
        }
        let path = dir.join(format!("{stem}-{what}.png"));
        shown
            .save(&path)
            .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Every id in the printings file the corpus knows, in file order. Comments and strata are
/// ignored: this reports one table, not `eval`'s per-stratum rows.
fn truths(conn: &rusqlite::Connection, wanted: &str) -> Result<Vec<Truth>, String> {
    let mut stmt = conn
        .prepare("SELECT name, set_code, collector_number FROM cards WHERE id = ?1")
        .map_err(|e| format!("corpus: {e}"))?;
    let mut out = Vec::new();
    for line in wanted.lines() {
        let token = line.split('#').next().unwrap_or("").trim();
        let Some(id) = parse_uuid(token) else {
            continue;
        };
        let row = stmt.query_row([format_uuid(&id)], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        });
        if let Ok((name, set, number)) = row {
            out.push(Truth {
                id,
                name,
                set,
                number,
            });
        }
    }
    Ok(out)
}

/// `eval` names a cached render `<id>.<ext>`, the extension taken from its URL.
fn cached_render(dir: &Path, id: &[u8; ID_LEN]) -> Option<PathBuf> {
    let stem = format_uuid(id);
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.file_stem().and_then(|s| s.to_str()) == Some(stem.as_str()))
}

/// `eval`'s burst index — the id's first eight bytes — so the poses are `eval`'s poses.
fn card_index(id: &[u8; ID_LEN]) -> u64 {
    let mut head = [0u8; 8];
    head.copy_from_slice(&id[..8]);
    u64::from_le_bytes(head)
}

/// Detect as the session does — both edge methods, card-likeness picks — and rectify both
/// ways up. `None` when neither method finds a card.
fn rectified(jpeg: &[u8]) -> Option<(image::RgbImage, image::RgbImage)> {
    let source = image::load_from_memory(jpeg).ok()?;
    // `Method::Both`'s two, which the session sweeps.
    let best: Option<Detection> = [EdgeMethod::Canny, EdgeMethod::Otsu]
        .iter()
        .filter_map(|&method| {
            detect(
                &source,
                &DetectOptions {
                    method,
                    ..Default::default()
                },
            )
            .0
            .ok()
        })
        .max_by(|a, b| a.cardness.score.total_cmp(&b.cardness.score));
    let d = best?;
    let views = rectify_views(
        &source.to_rgb8(),
        &d.quad,
        &DetectOptions {
            query_insets: Vec::new(),
            ..Default::default()
        },
    )?;
    Some((views.rectified, views.rectified_180))
}

fn score_title(r: &Reference, truth: &Truth, read: &card_scanner::ocr::TitleRead) -> TitleVerdict {
    if !read.is_usable() {
        return TitleVerdict::Junk;
    }
    match r.lookup_by_name_masked(&read.normalized, &Mask::all()) {
        None => TitleVerdict::Junk,
        Some((card, _)) if card != r.oracle_for(&truth.id) => TitleVerdict::Wrong,
        Some((_, 0)) => TitleVerdict::Exact,
        Some(_) => TitleVerdict::Corrected,
    }
}

fn score_collector(
    r: &Reference,
    truth: &Truth,
    candidates: &[(String, String)],
) -> CollectorVerdict {
    match r.lookup_collector(candidates) {
        None => CollectorVerdict::None,
        Some(id) if id == truth.id => CollectorVerdict::Resolved,
        Some(_) => CollectorVerdict::Conflicting,
    }
}

/// (n, mean, median, p90, max).
fn stats(mut ms: Vec<f32>) -> (usize, f32, f32, f32, f32) {
    if ms.is_empty() {
        return (0, 0.0, 0.0, 0.0, 0.0);
    }
    ms.sort_by(f32::total_cmp);
    let at = |q: f32| ms[((ms.len() - 1) as f32 * q).round() as usize];
    let mean = ms.iter().sum::<f32>() / ms.len() as f32;
    (ms.len(), mean, at(0.5), at(0.9), *ms.last().unwrap())
}
