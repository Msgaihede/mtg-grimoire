//! `bench-prep` — make the directory the frame bench reads (`crates/card-scanner/bench`), on a
//! desktop, from whatever is to hand.
//!
//! ```text
//! bench-prep --out <dir>                                    all of it invented: no file is read
//! bench-prep --out <dir> --bundle card-hashes.bin --corpus corpus.db \
//!            --models <dir> --card <picture>...             the published bundle, real cards
//! ```
//!
//! What it writes is what both of the bench's faces read — `scanner-bench-native <dir>` natively, and
//! the page `pnpm scanner:bench --dir <dir>` serves:
//!
//! ```text
//! card-hashes.bin     the bundle: `--bundle` copied, or one built here
//! labels.json         `--corpus`' `cards` table, or invented names for an invented bundle
//! models/*.rten       `--models`' two files, copied — absent without it
//! frames/*.jpg        a burst per card, in the order the cards were given
//! ```
//!
//! **No network, ever.** A card's picture is a file somebody already has — a render saved from
//! Scryfall, a picture out of the app's image cache — and the bundle and the models are the
//! three files `pnpm scanner:assets` downloads. This tool only reads and writes paths.
//!
//! **Without `--bundle` the bundle is built here**: the cards' own descriptors, then `--pad`
//! entries of noise with ids of their own. The padding is what makes an invented bundle worth
//! timing: the search is brute force over every entry, so a bundle of two cards would measure
//! nothing, and 120,000 is about what the published one holds. A padded entry sits ~128 bits
//! from everything and never wins a search.
//!
//! **Without `--card` the cards are invented too** — a border, the five bands card-likeness
//! reads, an art box of noise and rows of strokes where text goes. They exercise every stage
//! but tell nothing about accuracy, and a title made of strokes is not a word: with the models
//! loaded the readers run and read gibberish. **Figures from them are synthetic, and say so.**
//!
//! **A frame is the card on a table, as the evaluation makes one** ([`card_scanner::synth`]):
//! posed, lit, blurred and JPEG-compressed, with a little jitter per frame. One burst per card,
//! so a run over all of them is a card held, then the next laid in its place.

use card_scanner::hash::{hash_rgb, Descriptor, HashKind};
use card_scanner::index::{format_uuid, BundleBuilder, Section, ID_LEN};
use card_scanner::synth::{burst, SynthOptions};
use clap::Parser;
use image::{Rgb, RgbImage};
use std::path::{Path, PathBuf};

/// The published bundle's descriptor: `dhash-chroma32` at 256 bits.
const KIND: HashKind = HashKind::DHashChroma32;
const BITS: u16 = 256;

#[derive(Parser)]
#[command(about = "Make the directory the frame bench reads")]
struct Args {
    /// The directory to write. Made if it is not there; files in it are overwritten.
    #[arg(long)]
    out: PathBuf,
    /// A bundle to copy in. Without it one is built from the cards and `--pad` entries of noise.
    #[arg(long)]
    bundle: Option<PathBuf>,
    /// A card's picture, upright — repeat for more. Without any, `--invent` cards are drawn.
    #[arg(long = "card")]
    cards: Vec<PathBuf>,
    /// The app's `corpus.db`, read-only, for `labels.json`.
    #[arg(long)]
    corpus: Option<PathBuf>,
    /// The folder holding `text-detection.rten` and `text-recognition.rten`.
    #[arg(long)]
    models: Option<PathBuf>,
    /// How many cards to invent when no `--card` is given.
    #[arg(long, default_value_t = 2)]
    invent: usize,
    /// Entries of noise in a bundle built here.
    #[arg(long, default_value_t = 120_000)]
    pad: usize,
    /// Frames per card.
    #[arg(long, default_value_t = 15)]
    frames: usize,
    /// A frame's long side, in pixels. 960 is what the app's page sends.
    #[arg(long, default_value_t = 960)]
    long_edge: u32,
    /// Mixed into every pose and every invented card.
    #[arg(long, default_value_t = 7)]
    seed: u64,
}

/// SplitMix64 — the mixer `synth` draws its poses from, here for invented cards and padding.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn unit(&mut self) -> f32 {
        (self.next() >> 40) as f32 / (1u64 << 24) as f32
    }

    fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.unit()
    }

    fn id(&mut self) -> [u8; ID_LEN] {
        let mut id = [0u8; ID_LEN];
        id[..8].copy_from_slice(&self.next().to_le_bytes());
        id[8..].copy_from_slice(&self.next().to_le_bytes());
        id
    }
}

/// A card nobody printed, at Scryfall's `display` size: a black border, a title bar, an art box,
/// a type line, a text box and an info line, in the proportions `cardness` scores. The art is a
/// few overlapping waves in the card's own colours, so two invented cards hash far apart; the
/// text is rows of dark strokes, so the line finder has lines to find.
fn invented(rng: &mut Rng) -> RgbImage {
    let (w, h) = (672u32, 936u32);
    let border = (w as f32 * 0.045).round() as u32;
    let tint = [rng.range(0.6, 1.0), rng.range(0.6, 1.0), rng.range(0.6, 1.0)];
    let waves: Vec<[f32; 5]> = (0..6)
        .map(|_| {
            [
                rng.range(0.004, 0.03),
                rng.range(0.004, 0.03),
                rng.range(0.0, std::f32::consts::TAU),
                rng.range(0.0, 3.0),
                rng.range(30.0, 70.0),
            ]
        })
        .collect();
    // Where a stroke starts and how wide it is, per text row — drawn once, so a row is the
    // same row on every scanline.
    let strokes: Vec<Vec<(u32, u32)>> = (0..24)
        .map(|_| {
            let mut at = border * 2;
            let mut row = Vec::new();
            while at < w - border * 3 {
                let width = rng.range(3.0, 11.0) as u32;
                row.push((at, width));
                at += width + rng.range(3.0, 9.0) as u32;
            }
            row
        })
        .collect();
    let stroke = |x: u32, row: usize| {
        strokes[row % strokes.len()].iter().any(|(at, width)| x >= *at && x < at + width)
    };

    RgbImage::from_fn(w, h, |x, y| {
        if x < border || y < border || x + border >= w || y + border >= h {
            return Rgb([16, 16, 18]);
        }
        let t = y as f32 / h as f32;
        let paper = |v: f32| Rgb(tint.map(|c| (v * c).round().clamp(0.0, 255.0) as u8));
        // A text row is 22 px: 12 of strokes, 10 of paper.
        let lettered = |top: f32, v: f32, ink: f32| {
            let row = ((t - top) * h as f32) as u32;
            let inside = x > border * 2 && row % 22 >= 6 && row % 22 < 18;
            if inside && stroke(x, (row / 22) as usize + (top * 100.0) as usize) {
                paper(ink)
            } else {
                paper(v)
            }
        };
        match t {
            t if t < 0.10 => lettered(0.045, 238.0, 30.0),
            t if t < 0.55 => {
                let mut rgb = [120.0f32; 3];
                for wave in &waves {
                    let [fx, fy, phase, channel, depth] = *wave;
                    let v = (x as f32 * fx + y as f32 * fy + phase).sin() * depth;
                    rgb[channel as usize % 3] += v;
                    rgb[(channel as usize + 1) % 3] += v * 0.4;
                }
                Rgb(rgb.map(|c| c.round().clamp(0.0, 255.0) as u8))
            }
            t if t < 0.62 => lettered(0.565, 238.0, 30.0),
            t if t < 0.92 => lettered(0.64, 205.0, 40.0),
            _ => lettered(0.93, 60.0, 220.0),
        }
    })
}

/// One label row, as `scanner_bench::LabelRow` reads it.
type LabelRow = (
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    String,
    String,
    Vec<String>,
);

/// Every row of the corpus's `cards` table — the columns `Reference::load_labels` reads, in the
/// order `labels.json` holds them.
fn corpus_labels(path: &Path) -> Result<Vec<LabelRow>, String> {
    let said = |e: rusqlite::Error| format!("{}: {e}", path.display());
    let corpus = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(said)?;
    let mut statement = corpus
        .prepare(
            "SELECT id, oracle_id, illustration_id, name, set_code, collector_number, lang,
                    released_at, finishes
             FROM cards",
        )
        .map_err(said)?;
    let rows = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, Option<String>>(7)?.unwrap_or_default(),
                finishes(&r.get::<_, Option<String>>(8)?.unwrap_or_default()),
            ))
        })
        .map_err(said)?;
    // A row that will not read is skipped, as `load_labels` skips one.
    Ok(rows.flatten().collect())
}

/// The corpus's `finishes` column — a JSON array such as `["nonfoil","foil"]` — as the finish
/// names it holds, the way `reference::parse_finishes` reads it.
fn finishes(column: &str) -> Vec<String> {
    column
        .split(|c: char| !c.is_ascii_alphabetic())
        .filter(|w| matches!(*w, "nonfoil" | "foil" | "etched"))
        .map(String::from)
        .collect()
}

fn copy(from: &Path, to: &Path) -> Result<u64, String> {
    std::fs::copy(from, to).map_err(|e| format!("{} → {}: {e}", from.display(), to.display()))
}

fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|e| format!("{}: {e}", path.display()))
}

fn run(args: &Args) -> Result<(), String> {
    let frames_dir = args.out.join("frames");
    std::fs::create_dir_all(&frames_dir).map_err(|e| format!("{}: {e}", frames_dir.display()))?;
    let mut rng = Rng(args.seed);

    // ---- the cards ---------------------------------------------------------------------------
    let mut cards: Vec<(String, RgbImage)> = Vec::new();
    for path in &args.cards {
        let picture = image::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("card").to_string();
        cards.push((name, picture.to_rgb8()));
    }
    let invented_cards = cards.is_empty();
    if invented_cards {
        cards.extend((1..=args.invent).map(|n| (format!("invented {n}"), invented(&mut rng))));
    }

    // ---- the bundle and its labels -----------------------------------------------------------
    let mut labels: Vec<LabelRow> = match &args.corpus {
        Some(path) => corpus_labels(path)?,
        None => Vec::new(),
    };
    let bundle_path = args.out.join("card-hashes.bin");
    let bundle_said = match &args.bundle {
        Some(path) => format!("{} copied, {} bytes", path.display(), copy(path, &bundle_path)?),
        None => {
            let mut builder = BundleBuilder::new(KIND, BITS);
            let invent_labels = args.corpus.is_none();
            let mut label = |id: &[u8; ID_LEN], name: String, n: usize| {
                if invent_labels {
                    labels.push((
                        format_uuid(id),
                        Some(format_uuid(id)),
                        None,
                        name,
                        format!("b{:02}", n % 97),
                        (n + 1).to_string(),
                        "en".into(),
                        "2026-01-01".into(),
                        vec!["nonfoil".into()],
                    ));
                }
            };
            for (n, (name, picture)) in cards.iter().enumerate() {
                let id = rng.id();
                builder.push(Section::Card, id, &hash_rgb(picture, KIND, BITS));
                label(&id, format!("Bench {name}"), n);
            }
            for n in 0..args.pad {
                let mut noise = [0u8; BITS as usize / 8];
                for chunk in noise.chunks_exact_mut(8) {
                    chunk.copy_from_slice(&rng.next().to_le_bytes());
                }
                let descriptor = Descriptor::from_bytes(&noise, BITS).expect("256 bits of noise");
                let id = rng.id();
                builder.push(Section::Card, id, &descriptor);
                label(&id, format!("Padding {n:06}"), cards.len() + n);
            }
            let bytes = builder.finish(0).to_bytes();
            write(&bundle_path, &bytes)?;
            format!(
                "built here: {} cards + {} entries of noise, {} bytes",
                cards.len(),
                args.pad,
                bytes.len()
            )
        }
    };
    let labels_path = args.out.join("labels.json");
    if labels.is_empty() {
        // A stale file from an earlier run would name another bundle's ids.
        let _ = std::fs::remove_file(&labels_path);
    } else {
        let json = serde_json::to_vec(&labels).map_err(|e| format!("labels: {e}"))?;
        write(&labels_path, &json)?;
    }

    // ---- the models --------------------------------------------------------------------------
    let models_dir = args.out.join("models");
    let models_said = match &args.models {
        Some(from) => {
            std::fs::create_dir_all(&models_dir)
                .map_err(|e| format!("{}: {e}", models_dir.display()))?;
            let mut bytes = 0;
            for name in ["text-detection.rten", "text-recognition.rten"] {
                bytes += copy(&from.join(name), &models_dir.join(name))?;
            }
            format!("copied, {bytes} bytes")
        }
        None => "none — the readers will not run".to_string(),
    };

    // ---- the frames --------------------------------------------------------------------------
    let options = SynthOptions { seed: args.seed, frames: args.frames, long_edge: args.long_edge };
    let mut written = 0;
    for (index, (_, picture)) in cards.iter().enumerate() {
        for (f, jpeg) in burst(picture, &options, index as u64).into_iter().enumerate() {
            write(&frames_dir.join(format!("c{:02}-f{:02}.jpg", index + 1, f + 1)), &jpeg)?;
            written += 1;
        }
    }

    println!("{}", args.out.display());
    println!("  card-hashes.bin  {bundle_said}");
    println!("  labels.json      {} rows", labels.len());
    println!("  models/          {models_said}");
    println!(
        "  frames/          {written} frames of {} card(s), {} px on the long side{}",
        cards.len(),
        args.long_edge,
        if invented_cards { " — invented cards: synthetic figures only" } else { "" }
    );
    Ok(())
}

fn main() {
    if let Err(reason) = run(&Args::parse()) {
        eprintln!("bench-prep: {reason}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use card_scanner::index::Bundle;

    /// What the tool writes is what the bench reads: a bundle that parses, a label for every
    /// entry of it, frames a decoder opens — and the detector finds a card in an invented one.
    #[test]
    fn an_invented_directory_is_one_the_bench_can_read() {
        let out = std::env::temp_dir().join(format!("bench-prep-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&out);
        let args = Args {
            out: out.clone(),
            bundle: None,
            cards: Vec::new(),
            corpus: None,
            models: None,
            invent: 2,
            pad: 50,
            frames: 2,
            long_edge: 640,
            seed: 7,
        };
        run(&args).expect("prep");

        let bundle = std::fs::read(out.join("card-hashes.bin")).expect("bundle");
        let bundle = Bundle::from_bytes(&bundle).expect("a bundle");
        assert_eq!(bundle.section(Section::Card).len(), 52);
        let labels = std::fs::read(out.join("labels.json")).expect("labels");
        let labels: Vec<LabelRow> = serde_json::from_slice(&labels).expect("rows");
        assert_eq!(labels.len(), 52);
        assert_eq!(labels[0].3, "Bench invented 1");
        assert!(!out.join("models").exists());

        let mut frames: Vec<_> = std::fs::read_dir(out.join("frames"))
            .expect("frames")
            .flatten()
            .map(|e| e.path())
            .collect();
        frames.sort();
        assert_eq!(frames.len(), 4);
        let frame = image::open(&frames[0]).expect("a jpeg");
        assert_eq!((frame.width(), frame.height()), (640, 360));
        let options = card_scanner::detect::DetectOptions::default();
        let found = card_scanner::detect::detect(&frame, &options).0;
        assert!(found.is_ok(), "no card seen in an invented frame: {:?}", found.err());
        let _ = std::fs::remove_dir_all(&out);
    }

    #[test]
    fn the_finishes_column_reads_as_the_crate_reads_it() {
        assert_eq!(finishes(r#"["nonfoil","foil"]"#), ["nonfoil", "foil"]);
        assert_eq!(finishes(r#"["etched","glossy"]"#), ["etched"]);
        assert!(finishes("").is_empty());
    }
}
