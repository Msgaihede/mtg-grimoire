//! `probe` — pictures through the recogniser, every card it finds printed.
//!
//! ```text
//! probe [--models <dir>] [--evidence-meta <json> --crops <dir>] frame.jpg [more.jpg …]
//! ```
//!
//! `--models` defaults to this crate's `models/`. The pictures are fed in order to one
//! [`Agreement`], 100 ms apart, so a run of frames decides as the Scanner would.
//!
//! `--evidence-meta` is a file holding only an [`EvidenceMeta`] (the evidence networks do not
//! exist yet, so their boxes can be tried before any is trained); with `--crops` it saves the
//! two crops the runtime would cut from each frame's best card, as `<stem>.symbol.png` and
//! `<stem>.band.png`, so a box can be judged by eye.

use card_neural::frame::sample_card;
use card_neural::meta::{CropMeta, EvidenceMeta};
use card_neural::{Agreement, Frame, Recognizer};
use clap::Parser;
use std::path::{Path, PathBuf};

#[derive(Parser)]
struct Args {
    #[arg(long, default_value = concat!(env!("CARGO_MANIFEST_DIR"), "/models"))]
    models: PathBuf,
    /// A JSON file holding an `EvidenceMeta`: the boxes (and sizes) to cut from each best card.
    #[arg(long, requires = "crops")]
    evidence_meta: Option<PathBuf>,
    /// Where `--evidence-meta`'s crops are saved.
    #[arg(long, requires = "evidence_meta")]
    crops: Option<PathBuf>,
    frames: Vec<PathBuf>,
}

fn uuid(id: &[u8; 16]) -> String {
    let h: String = id.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

/// Cut `meta`'s part of the card through `quad` exactly as the runtime would, and save it.
fn save_crop(
    frame: &Frame,
    quad: &card_neural::frame::Quad,
    meta: &CropMeta,
    path: &Path,
) -> Result<(), String> {
    let mut tensor = vec![0f32; 3 * meta.width * meta.height];
    let mut view = Vec::new();
    if !sample_card(
        frame,
        quad,
        meta.crop,
        meta.width,
        meta.height,
        &mut tensor,
        Some(&mut view),
    ) {
        return Err(format!("{}: the card's quad is degenerate", path.display()));
    }
    image::RgbImage::from_raw(meta.width as u32, meta.height as u32, view)
        .ok_or("the crop's bytes do not fill its size")?
        .save(path)
        .map_err(|e| format!("{}: {e}", path.display()))
}

fn main() -> Result<(), String> {
    let args = Args::parse();
    let files = card_neural::read_dir(&args.models)
        .map_err(|e| format!("{}: {e}", args.models.display()))?;
    let mut recognizer = Recognizer::load(files).map_err(|e| e.to_string())?;
    let mut agreement = Agreement::default();
    let evidence: Option<EvidenceMeta> = match &args.evidence_meta {
        Some(path) => {
            let text =
                std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
            Some(serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?)
        }
        None => None,
    };
    if let Some(dir) = &args.crops {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    for (n, path) in args.frames.iter().enumerate() {
        let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let frame = Frame::decode(&bytes).map_err(|e| e.to_string())?;
        let read = recognizer.read(&frame, None).map_err(|e| e.to_string())?;
        let decided = agreement.observe(&read, n as f64 * 100.0);
        println!(
            "{} ({}×{}): {} card(s), {} detector run(s), {} view(s){}{}{}",
            path.display(),
            frame.width,
            frame.height,
            read.cards.len(),
            read.detector_runs,
            read.crops,
            if read.accepted { ", accepted" } else { "" },
            if read.instant { ", instant" } else { "" },
            if decided { ", DECIDED" } else { "" }
        );
        if let (Some(meta), Some(dir), Some(best)) = (&evidence, &args.crops, read.best()) {
            let stem = path.file_stem().unwrap_or_default().to_string_lossy();
            for (name, crop) in [("symbol", &meta.symbol), ("band", &meta.band)] {
                let out = dir.join(format!("{stem}.{name}.png"));
                save_crop(&frame, &best.quad, crop, &out)?;
                println!("  saved {}", out.display());
            }
        }
        let g = recognizer.gallery();
        for c in &read.cards {
            let e = c.scored.entry;
            println!(
                "  {:<40} {} score {:.3} margin {:.3} det {:.2}{}{}",
                g.name(e),
                uuid(g.printing(e)),
                c.scored.score,
                c.scored.margin,
                c.detection.score,
                if c.aimed { " aimed" } else { "" },
                if c.accepted { " accepted" } else { "" }
            );
            for &(o, s) in c.top.iter().skip(1).take(3) {
                println!("      then {:<35} {s:.3}", g.name(o));
            }
        }
    }
    if let Some(d) = agreement.decision() {
        let g = recognizer.gallery();
        println!(
            "decision: {} ({}, {:.3}, {})",
            g.name(d.entry),
            uuid(g.printing(d.entry)),
            d.score,
            d.how
        );
    }
    Ok(())
}
