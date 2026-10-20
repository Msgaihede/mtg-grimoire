//! `build-gallery` — the spike's export of a gallery (an `NSGALLR1` f32 matrix and its
//! `gallery.json`) into `models/gallery.bin` (`CNGALLR1`, int8 rows).
//!
//! ```text
//! build-gallery --matrix gallery.head.matrix --gallery gallery.json --out models/gallery.bin
//! ```
//!
//! The matrix is the export's class-weight gallery (`train/qd_export.py` in the scanner lab); a
//! look's printings and name come from `gallery.json`, row for row.

use card_neural::gallery::{Face, Gallery, Id, Look};
use clap::Parser;
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Parser)]
struct Args {
    #[arg(long)]
    matrix: PathBuf,
    #[arg(long)]
    gallery: PathBuf,
    #[arg(long)]
    out: PathBuf,
}

#[derive(Deserialize)]
struct Export {
    source: String,
    entries: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    card: u32,
    name: String,
    id: String,
    face: String,
    covers: Vec<String>,
}

fn uuid(s: &str) -> Result<Id, String> {
    let hex: String = s.chars().filter(|c| *c != '-').collect();
    if hex.len() != 32 {
        return Err(format!("{s:?} is not a Scryfall id"));
    }
    let mut id = [0u8; 16];
    for (i, b) in id.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).map_err(|e| format!("{s:?}: {e}"))?;
    }
    Ok(id)
}

fn main() -> Result<(), String> {
    let args = Args::parse();
    let raw = std::fs::read(&args.matrix).map_err(|e| format!("{}: {e}", args.matrix.display()))?;
    if raw.len() < 16 || &raw[..8] != b"NSGALLR1" {
        return Err(format!(
            "{} is not an NSGALLR1 matrix",
            args.matrix.display()
        ));
    }
    let n = u32::from_le_bytes(raw[8..12].try_into().unwrap()) as usize;
    let dim = u32::from_le_bytes(raw[12..16].try_into().unwrap()) as usize;
    if raw.len() != 16 + n * dim * 4 {
        return Err("the matrix is cut short or too long".into());
    }
    let rows: Vec<f32> = raw[16..]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .collect();
    let export: Export = serde_json::from_slice(
        &std::fs::read(&args.gallery).map_err(|e| format!("{}: {e}", args.gallery.display()))?,
    )
    .map_err(|e| format!("{}: {e}", args.gallery.display()))?;
    if export.entries.len() != n {
        return Err(format!(
            "{} entries in {} for {n} rows",
            export.entries.len(),
            args.gallery.display()
        ));
    }
    let looks = export
        .entries
        .iter()
        .map(|e| {
            Ok(Look {
                printing: uuid(&e.id)?,
                card: e.card,
                face: if e.face == "back" {
                    Face::Back
                } else {
                    Face::Front
                },
                covers: e
                    .covers
                    .iter()
                    .map(|c| uuid(c))
                    .collect::<Result<_, String>>()?,
                name: e.name.replace('\n', " "),
            })
        })
        .collect::<Result<Vec<Look>, String>>()?;
    let gallery = Gallery::build(&rows, dim, &looks).map_err(|e| e.to_string())?;
    // The int8 rows against the f32 they came from: the largest cosine error any row makes
    // against itself.
    let mut worst = 0f32;
    for (i, r) in rows.chunks_exact(dim).enumerate() {
        let own: f32 = r.iter().map(|v| v * v).sum();
        worst = worst.max((own - gallery.score(i as u32, r)).abs());
    }
    std::fs::write(&args.out, gallery.as_bytes())
        .map_err(|e| format!("{}: {e}", args.out.display()))?;
    println!(
        "{} looks × {dim}, {} printings covered, {} bytes → {} (from {}); worst self-score error {worst:.2e}",
        n,
        looks.iter().map(|l| l.covers.len()).sum::<usize>(),
        gallery.as_bytes().len(),
        args.out.display(),
        export.source
    );
    Ok(())
}
