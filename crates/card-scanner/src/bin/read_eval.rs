//! `read_eval` — the OCR readers, scored one read at a time against labels.
//!
//! **Synthetic, like `eval`: Scryfall renders degraded in software — a regression fence, not an
//! accuracy claim about a camera.** Where `eval` asks what a whole *decision* came to, this asks
//! the narrower question issue #708 needed a number for: given a frame the detector found a card
//! in, how often does the title band read as the card's name, and how often does the collector
//! line resolve to the printing? Before this existed the answer was an anecdote — one clean
//! render gave a junk title and the next a clean one.
//!
//! ```text
//! read_eval --bundle card-hashes.bin --corpus corpus.db --models models \
//!           --printings crates/card-scanner/eval/printings.txt --cache eval-cache \
//!           [--seed 7] [--frames 4] [--camera 1920] [--send 960] [--jobs N] \
//!           [--dump bands/] [--summary reads.md]
//! ```
//!
//! **The frames are the app's, not `eval`'s.** Each render is posed into a burst at `--camera`
//! pixels on the long edge — a 1080p webcam at the default — and then handled the way the page
//! handles a camera frame: downscaled to `--send` (the page's `send px`) and JPEG'd at 0.72 for
//! detection, and, for a detail read, JPEG'd whole at 0.85. So a read "from the frame" here is
//! from the pixels the app actually has, and a read "from the detail" is from the pixels a
//! detail frame carries.
//!
//! **Every configuration reads the same detections.** Detection runs once per frame on the
//! downscaled image, and each configuration then reads its own bands from that one quad — so a
//! difference between two rows is the reader's and never the detector's. A frame the detector
//! found nothing in is counted once, in its own column, and read by nobody.
//!
//! **The renders come from `eval`'s cache and are never fetched here.** Run `eval` once with the
//! same `--cache` to fill it; a printing whose render is missing is skipped and counted.
//!
//! `--dump` writes every band the last configuration read, one PNG each, with a `labels.jsonl`
//! naming the printing, the text it should read and the text it did — the labelled set the issue
//! asks for, kept as files rather than rebuilt in memory each time.

use card_scanner::detect::{detect, DetectOptions, Detection};
use card_scanner::index::{format_uuid, parse_uuid, Bundle, Mask, ID_LEN};
use card_scanner::ocr::{
    collector_crop, normalize, title_crop, BandSource, CardPixels, ReadOptions, TitleReader,
};
use card_scanner::reference::Reference;
use card_scanner::synth::{burst, SynthOptions};
use clap::Parser;
use image::{DynamicImage, RgbImage};
use rayon::prelude::*;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

const HEADLINE: &str = "Synthetic: Scryfall renders degraded in software — a regression fence, \
                        not an accuracy claim about a camera.";
/// The page's pump quality (`useScanLoop.ts`'s `PUMP_QUALITY`).
const SEND_QUALITY: u8 = 72;
/// The page's detail quality.
const DETAIL_QUALITY: u8 = 85;
/// The collector line is printed from 2015 on; older printings have none to read.
const COLLECTOR_SINCE: &str = "2015-01-01";

#[derive(Parser, Debug)]
#[command(name = "read_eval", about = "The OCR readers, scored per read against labels")]
struct Args {
    #[arg(long)]
    bundle: PathBuf,
    /// The app's `corpus.db`, for labels. Opened read-only.
    #[arg(long)]
    corpus: PathBuf,
    /// Directory holding `text-detection.rten` and `text-recognition.rten`.
    #[arg(long)]
    models: PathBuf,
    /// `eval`'s printings list — one id per line, strata marked `# stratum: <name>`.
    #[arg(long)]
    printings: PathBuf,
    /// `eval`'s render cache. Read only; a missing render is skipped.
    #[arg(long)]
    cache: PathBuf,
    #[arg(long, default_value_t = 7)]
    seed: u64,
    /// Frames per printing. Each is a separate read in every configuration.
    #[arg(long, default_value_t = 4)]
    frames: usize,
    /// The camera frame's long edge.
    #[arg(long, default_value_t = 1920)]
    camera: u32,
    /// The long edge the page downscales a frame to before sending it.
    #[arg(long, default_value_t = 960)]
    send: u32,
    /// Printings read at once. Defaults to half the logical cores.
    #[arg(long)]
    jobs: Option<usize>,
    /// Write the last configuration's bands here, with a `labels.jsonl`.
    #[arg(long)]
    dump: Option<PathBuf>,
    /// Also write the tables here, as markdown.
    #[arg(long)]
    summary: Option<PathBuf>,
}

/// Where a configuration's bands come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    /// Cropped from the 488×680 rectification of the sent frame — the path before #708.
    Rectified,
    /// Warped straight out of the sent frame.
    Frame,
    /// Warped out of the detail frame.
    Detail,
}

/// Every configuration, in the order the table prints them. The first is the baseline.
///
/// **Four rows measure all five effects**, because the two refinements touch disjoint reads:
/// `title_line` changes only the title crop and `collector_layout` only the collector's. So the
/// last row's title columns against the row above are the line crop's effect alone, and its
/// collector columns the layout's alone — a row per refinement would read every band twice to
/// print the same numbers.
const CONFIGS: [(&str, Source, ReadOptions); 4] = [
    ("rectified (before)", Source::Rectified, ReadOptions { title_line: false, collector_layout: false }),
    ("frame", Source::Frame, ReadOptions { title_line: false, collector_layout: false }),
    ("detail", Source::Detail, ReadOptions { title_line: false, collector_layout: false }),
    ("detail + line + layout", Source::Detail, ReadOptions { title_line: true, collector_layout: true }),
];

/// What the corpus says one wanted printing is.
#[derive(Debug, Clone)]
struct Truth {
    id: [u8; ID_LEN],
    oracle: [u8; ID_LEN],
    stratum: String,
    /// Every name the title band could legitimately show, normalized: the whole name and each
    /// face of a `A // B` card.
    names: Vec<String>,
    shown: String,
    released: String,
}

/// One read in one configuration.
#[derive(Debug, Clone, Default)]
struct Read {
    title_exact: bool,
    title_card: bool,
    title_wrong: bool,
    title_ms: f32,
    /// `None` for a printing that predates the collector line.
    collector_right: Option<bool>,
    collector_wrong: bool,
    collector_ms: f32,
}

/// One printing's results: per frame, whether it was detected and, if so, each config's read.
struct CardResult {
    truth: Truth,
    frames: usize,
    detected: usize,
    reads: Vec<Vec<Read>>,
}

fn parse_printings(text: &str) -> Vec<([u8; ID_LEN], String)> {
    let mut stratum = "unstratified".to_string();
    let mut out = Vec::new();
    for line in text.lines().map(str::trim) {
        if let Some(rest) = line.strip_prefix("# stratum:") {
            stratum = rest.trim().to_string();
            continue;
        }
        let id = line.split('#').next().unwrap_or("").trim();
        if let Some(id) = parse_uuid(id) {
            out.push((id, stratum.clone()));
        }
    }
    out
}

fn truths(conn: &rusqlite::Connection, wanted: &[([u8; ID_LEN], String)]) -> Result<Vec<Truth>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT oracle_id, name, set_code, collector_number, released_at FROM cards WHERE id = ?1",
        )
        .map_err(|e| format!("corpus query: {e}"))?;
    let mut out = Vec::new();
    for (id, stratum) in wanted {
        let row = stmt.query_row([format_uuid(id)], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        });
        let Ok((oracle, name, set, number, released)) = row else { continue };
        let mut names = vec![normalize(&name)];
        names.extend(name.split("//").map(normalize).filter(|n| !n.is_empty()));
        out.push(Truth {
            id: *id,
            oracle: oracle.as_deref().and_then(parse_uuid).unwrap_or(*id),
            stratum: stratum.clone(),
            names,
            shown: format!("{name} — {} {number}", set.to_uppercase()),
            released: released.unwrap_or_default(),
        });
    }
    Ok(out)
}

/// The render `eval` cached for this printing, whatever extension it was saved with.
fn cached_render(dir: &Path, id: &[u8; ID_LEN]) -> Option<PathBuf> {
    let stem = format_uuid(id);
    std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| {
        p.file_stem().and_then(|s| s.to_str()) == Some(stem.as_str())
    })
}

fn jpeg(img: &RgbImage, quality: u8) -> Vec<u8> {
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
        .encode_image(img)
        .expect("encoding a JPEG into memory");
    out
}

/// A camera frame as the page sends it: downscaled to `send` on the long edge, through JPEG.
fn as_sent(camera: &RgbImage, send: u32) -> DynamicImage {
    let (w, h) = camera.dimensions();
    let k = (send as f32 / w.max(h) as f32).min(1.0);
    let (sw, sh) = (((w as f32) * k).round() as u32, ((h as f32) * k).round() as u32);
    let small = image::imageops::resize(camera, sw.max(1), sh.max(1), image::imageops::FilterType::Triangle);
    image::load_from_memory(&jpeg(&small, SEND_QUALITY)).expect("decoding our own JPEG")
}

/// Everything read from one detection, in one configuration: the two reads, scored, and the
/// crops, for the dump.
fn read_one(
    reader: &TitleReader,
    r: &Reference,
    truth: &Truth,
    d: &Detection,
    sent: &DynamicImage,
    detail: &RgbImage,
    from: Source,
) -> (Read, RgbImage, RgbImage, String, String) {
    let inset = DetectOptions::default().inset;
    let warped = d.quad.scaled(inset);
    let pixels = match from {
        Source::Rectified => None,
        Source::Frame => Some(CardPixels::new(sent.to_rgb8(), warped, d.margin)),
        Source::Detail => {
            let k = detail.width() as f32 / sent.width() as f32;
            let q = card_scanner::detect::Quad { corners: warped.corners.map(|(x, y)| (x * k, y * k)) };
            Some(CardPixels::new(detail.clone(), q, d.margin))
        }
    };
    let src = match &pixels {
        Some(p) => BandSource::Frame(p),
        None => BandSource::Rectified { upright: &d.rectified, flipped: &d.rectified_180 },
    };

    let title = reader.read_title(&src);
    let hit = title.is_usable().then(|| r.lookup_by_name_masked(&title.normalized, &Mask::all())).flatten();
    let col = reader.read_collector(&src);
    let resolved = r.lookup_collector_masked(&col.candidates, &Mask::all());
    let has_line = truth.released.as_str() >= COLLECTOR_SINCE;

    let read = Read {
        title_exact: truth.names.contains(&title.normalized),
        title_card: hit.is_some_and(|(card, _)| card == truth.oracle),
        title_wrong: hit.is_some_and(|(card, _)| card != truth.oracle),
        title_ms: title.elapsed_ms,
        collector_right: has_line.then_some(resolved == Some(truth.id)),
        collector_wrong: resolved.is_some_and(|p| p != truth.id),
        collector_ms: col.elapsed_ms,
    };
    // The crops the reads came from, for the dump: the winning orientation's.
    let opts = reader.options();
    let t = title.band.unwrap_or_else(|| title_crop(&src, title.rotated, opts));
    let c = col.band.unwrap_or_else(|| collector_crop(&src, col.rotated, opts));
    (read, t, c, title.raw, col.raw)
}

fn pct(n: usize, of: usize) -> String {
    if of == 0 {
        "—".into()
    } else {
        format!("{:.1}", 100.0 * n as f32 / of as f32)
    }
}

fn mean(xs: impl Iterator<Item = f32>) -> String {
    let v: Vec<f32> = xs.collect();
    if v.is_empty() {
        "—".into()
    } else {
        format!("{:.0}", v.iter().sum::<f32>() / v.len() as f32)
    }
}

/// One table row over `reads`: every read of one configuration.
fn row(name: &str, reads: &[&Read]) -> String {
    let n = reads.len();
    let with_line: Vec<&&Read> = reads.iter().filter(|r| r.collector_right.is_some()).collect();
    format!(
        "| {name} | {n} | {} | {} | {} | {} ({}) | {} | {} | {} |",
        pct(reads.iter().filter(|r| r.title_exact).count(), n),
        pct(reads.iter().filter(|r| r.title_card).count(), n),
        reads.iter().filter(|r| r.title_wrong).count(),
        pct(with_line.iter().filter(|r| r.collector_right == Some(true)).count(), with_line.len()),
        with_line.len(),
        reads.iter().filter(|r| r.collector_wrong).count(),
        mean(reads.iter().map(|r| r.title_ms)),
        mean(reads.iter().map(|r| r.collector_ms)),
    )
}

const HEADER: &str = "| config | reads | title exact % | title → card % | title wrong card | \
                      collector → printing % (2015+ reads) | collector wrong | ms / title read | \
                      ms / collector read |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";

fn main() -> std::process::ExitCode {
    match run(Args::parse()) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("read_eval: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}

fn run(args: Args) -> Result<(), String> {
    let started = Instant::now();
    let text = std::fs::read_to_string(&args.printings)
        .map_err(|e| format!("cannot read {}: {e}", args.printings.display()))?;
    let wanted = parse_printings(&text);
    let bundle_bytes =
        std::fs::read(&args.bundle).map_err(|e| format!("bundle {}: {e}", args.bundle.display()))?;
    let conn = rusqlite::Connection::open_with_flags(
        &args.corpus,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("corpus {}: {e}", args.corpus.display()))?;
    let mut reference =
        Reference::new(Bundle::from_bytes(&bundle_bytes).map_err(|e| format!("bundle: {e}"))?);
    reference.load_labels(&conn).map_err(|e| format!("corpus labels: {e}"))?;
    let truths = truths(&conn, &wanted)?;
    let model = |name: &str| {
        let path = args.models.join(name);
        std::fs::read(&path).map_err(|e| format!("model {}: {e}", path.display()))
    };
    let (det, rec) = (model("text-detection.rten")?, model("text-recognition.rten")?);

    let mut cards: Vec<(Truth, PathBuf)> = Vec::new();
    let mut missing = 0usize;
    for t in truths {
        match cached_render(&args.cache, &t.id) {
            Some(p) => cards.push((t, p)),
            None => missing += 1,
        }
    }
    eprintln!("{} printings with a cached render, {missing} without", cards.len());
    if cards.is_empty() {
        return Err(format!("no cached renders in {} — run `eval` with this --cache first", args.cache.display()));
    }

    if let Some(dir) = &args.dump {
        std::fs::create_dir_all(dir).map_err(|e| format!("dump {}: {e}", dir.display()))?;
    }
    let labels = Mutex::new(Vec::<String>::new());
    let jobs = args.jobs.unwrap_or_else(|| {
        std::thread::available_parallelism().map_or(2, |n| (n.get() / 2).max(1))
    });
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(jobs)
        .build()
        .map_err(|e| format!("thread pool: {e}"))?;
    let done = std::sync::atomic::AtomicUsize::new(0);
    let total = cards.len();

    let results: Vec<CardResult> = pool.install(|| {
        cards
            .par_iter()
            .map_init(
                || TitleReader::from_bytes(&det, &rec).expect("the models loaded once already"),
                |reader, (truth, path)| {
                    let render = image::open(path).map(|i| i.to_rgb8());
                    let mut res = CardResult { truth: truth.clone(), frames: 0, detected: 0, reads: Vec::new() };
                    let Ok(render) = render else { return res };
                    let index = u64::from_le_bytes(truth.id[..8].try_into().expect("8 bytes"));
                    let opts = SynthOptions { seed: args.seed, frames: args.frames, long_edge: args.camera };
                    for (f, frame) in burst(&render, &opts, index).iter().enumerate() {
                        res.frames += 1;
                        let Ok(camera) = image::load_from_memory(frame).map(|i| i.to_rgb8()) else { continue };
                        let sent = as_sent(&camera, args.send);
                        let detail = image::load_from_memory(&jpeg(&camera, DETAIL_QUALITY))
                            .expect("decoding our own JPEG")
                            .to_rgb8();
                        let det_opts = DetectOptions { query_insets: Vec::new(), ..Default::default() };
                        let Ok(d) = detect(&sent, &det_opts).0 else { continue };
                        res.detected += 1;
                        let mut per = Vec::new();
                        for (ci, (name, from, ropts)) in CONFIGS.iter().enumerate() {
                            reader.set_options(*ropts);
                            let (read, t, c, traw, craw) =
                                read_one(reader, &reference, truth, &d, &sent, &detail, *from);
                            if let (Some(dir), true) = (&args.dump, ci + 1 == CONFIGS.len()) {
                                let stem = format!("{}-{f}", format_uuid(&truth.id));
                                let _ = t.save(dir.join(format!("{stem}-title.png")));
                                let _ = c.save(dir.join(format!("{stem}-collector.png")));
                                let line = serde_json::json!({
                                    "id": format_uuid(&truth.id),
                                    "frame": f,
                                    "config": name,
                                    "truth": truth.shown,
                                    "title": format!("{stem}-title.png"),
                                    "title_read": traw,
                                    "title_exact": read.title_exact,
                                    "collector": format!("{stem}-collector.png"),
                                    "collector_read": craw,
                                    "collector_right": read.collector_right,
                                });
                                labels.lock().expect("labels").push(line.to_string());
                            }
                            per.push(read);
                        }
                        res.reads.push(per);
                    }
                    let n = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                    if n % 10 == 0 || n == total {
                        eprintln!("{n}/{total} printings read");
                    }
                    res
                },
            )
            .collect()
    });

    if let Some(dir) = &args.dump {
        let mut f = std::fs::File::create(dir.join("labels.jsonl"))
            .map_err(|e| format!("labels.jsonl: {e}"))?;
        for line in labels.into_inner().expect("labels") {
            writeln!(f, "{line}").map_err(|e| format!("labels.jsonl: {e}"))?;
        }
    }

    let frames: usize = results.iter().map(|r| r.frames).sum();
    let detected: usize = results.iter().map(|r| r.detected).sum();
    let mut out = String::new();
    out.push_str(&format!("> {HEADLINE}\n\n"));
    out.push_str(&format!(
        "{} printings, {} frames at {} px sent at {} px, seed {}, {jobs} workers — the detector \
         found a card on {detected} of {frames} frames ({}%), and only those are read. {:.0} s wall.\n\n",
        results.len(),
        frames,
        args.camera,
        args.send,
        args.seed,
        pct(detected, frames),
        started.elapsed().as_secs_f32(),
    ));
    out.push_str(HEADER);
    out.push('\n');
    for (ci, (name, _, _)) in CONFIGS.iter().enumerate() {
        let reads: Vec<&Read> = results.iter().flat_map(|r| r.reads.iter().map(move |p| &p[ci])).collect();
        out.push_str(&row(name, &reads));
        out.push('\n');
    }

    // By stratum, the baseline against the last configuration.
    let mut strata: Vec<&str> = Vec::new();
    for r in &results {
        if !strata.contains(&r.truth.stratum.as_str()) {
            strata.push(&r.truth.stratum);
        }
    }
    out.push_str("\nBy stratum, the baseline and the last configuration:\n\n");
    out.push_str(&HEADER.replacen("| config |", "| config · stratum |", 1));
    out.push('\n');
    for s in strata {
        for ci in [0, CONFIGS.len() - 1] {
            let reads: Vec<&Read> = results
                .iter()
                .filter(|r| r.truth.stratum == s)
                .flat_map(|r| r.reads.iter().map(move |p| &p[ci]))
                .collect();
            out.push_str(&row(&format!("{} · {s}", CONFIGS[ci].0), &reads));
            out.push('\n');
        }
    }

    print!("{out}");
    if let Some(path) = &args.summary {
        std::fs::write(path, &out).map_err(|e| format!("summary {}: {e}", path.display()))?;
    }
    Ok(())
}
