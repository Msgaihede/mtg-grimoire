//! `probe` — pictures through the recogniser, every card it finds printed.
//!
//! ```text
//! probe [--models <dir>] frame.jpg [more.jpg …]
//! ```
//!
//! `--models` defaults to this crate's `models/`. The pictures are fed in order to one
//! [`Agreement`], 100 ms apart, so a run of frames decides as the Scanner would.

use card_neural::{Agreement, Frame, Recognizer};
use clap::Parser;
use std::path::PathBuf;

#[derive(Parser)]
struct Args {
    #[arg(long, default_value = concat!(env!("CARGO_MANIFEST_DIR"), "/models"))]
    models: PathBuf,
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

fn main() -> Result<(), String> {
    let args = Args::parse();
    let files = card_neural::read_dir(&args.models)
        .map_err(|e| format!("{}: {e}", args.models.display()))?;
    let mut recognizer = Recognizer::load(files).map_err(|e| e.to_string())?;
    let mut agreement = Agreement::default();
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
