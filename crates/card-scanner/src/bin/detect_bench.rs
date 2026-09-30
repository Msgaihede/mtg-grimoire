//! `detect-bench` — what a frame costs before and after the card locks, on one core's worth of
//! work at a time.
//!
//! ```text
//! detect-bench --cache eval-cache [--frames 24] [--seed 7] [--limit N] [--method both]
//! ```
//!
//! For every render in `--cache` — the evaluation's own cache, one file per printing named by its
//! id — it makes the same burst `eval` makes (same seed, same card index, same poses) but longer,
//! and feeds it to a [`Session`] with **no reference and no reader**. What is left of a frame is
//! decode, detection, the lock and the rectification: exactly the part a locked card repeats on
//! every frame whatever it has already been named.
//!
//! **Cards run one after another, on purpose.** `eval`'s mean-ms column is taken under `--jobs`
//! load and is "a figure under load, never a latency" (card-scanner.md §10). This is the latency:
//! one card at a time, so a figure moves when the pipeline does and not when the machine is busy.
//! A detector that uses several cores is still free to — that is part of what is being measured.
//!
//! Each frame is filed by the lock's phase **going into it**, because that is what decides which
//! search the frame gets: a frame that arrives to a trusted lock is a *locked* frame, whatever it
//! turns out to hold. Frames to lock are counted from the burst's first frame, which is the
//! first frame the card is at rest and in view.
//!
//! The verdict is read back through its JSON rather than its fields, so this file builds against
//! a tree that predates any field it reports — which is how a *before* figure is taken at all.

use card_scanner::index::{parse_uuid, ID_LEN};
use card_scanner::session::{FrameOptions, Method, Session};
use card_scanner::synth::{burst, SynthOptions};
use clap::Parser;
use std::path::PathBuf;
use std::time::Instant;

#[derive(Parser, Debug)]
#[command(
    name = "detect-bench",
    about = "Per-frame cost of detection, before and after a lock"
)]
struct Args {
    /// The evaluation's render cache: one image per printing, named by its id.
    #[arg(long)]
    cache: PathBuf,
    /// Frames per burst. Longer than `eval`'s twelve, so most of a burst is locked.
    #[arg(long, default_value_t = 24)]
    frames: usize,
    #[arg(long, default_value_t = 7)]
    seed: u64,
    /// Stop after this many renders.
    #[arg(long)]
    limit: Option<usize>,
    /// `canny`, `otsu` or `both` — the session's `method`.
    #[arg(long, default_value = "both")]
    method: String,
}

/// The same derivation as `eval`'s, so a card here is posed exactly as it is there.
fn card_index(id: &[u8; ID_LEN]) -> u64 {
    let mut head = [0u8; 8];
    head.copy_from_slice(&id[..8]);
    u64::from_le_bytes(head)
}

/// Nearest-rank percentile of an unsorted sample. `None` when empty.
fn pct(xs: &[f64], p: f64) -> Option<f64> {
    if xs.is_empty() {
        return None;
    }
    let mut v = xs.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let rank = ((p / 100.0) * v.len() as f64).ceil().max(1.0) as usize;
    Some(v[rank.min(v.len()) - 1])
}

fn show(xs: &[f64]) -> String {
    let f = |o: Option<f64>| o.map_or("—".to_string(), |x| format!("{x:.1}"));
    let mean = if xs.is_empty() {
        None
    } else {
        Some(xs.iter().sum::<f64>() / xs.len() as f64)
    };
    format!(
        "n {:>5}  p50 {:>7}  p90 {:>7}  mean {:>7}  max {:>7}",
        xs.len(),
        f(pct(xs, 50.0)),
        f(pct(xs, 90.0)),
        f(mean),
        f(pct(xs, 100.0))
    )
}

fn main() -> std::process::ExitCode {
    match run(Args::parse()) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            std::process::ExitCode::from(1)
        }
    }
}

fn run(args: Args) -> Result<(), String> {
    let mut renders: Vec<(PathBuf, [u8; ID_LEN])> = std::fs::read_dir(&args.cache)
        .map_err(|e| format!("cannot read {}: {e}", args.cache.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter_map(|p| {
            let id = parse_uuid(p.file_stem()?.to_str()?)?;
            Some((p, id))
        })
        .collect();
    renders.sort();
    if let Some(n) = args.limit {
        renders.truncate(n);
    }
    if renders.is_empty() {
        return Err(format!(
            "{} holds no renders named by a printing id",
            args.cache.display()
        ));
    }

    let synth = SynthOptions {
        seed: args.seed,
        frames: args.frames,
        ..Default::default()
    };
    let opts = FrameOptions {
        method: Method::parse(&args.method),
        ..Default::default()
    };

    // Per frame, less its JPEG decode — the decode is the same work either way and is not
    // detection's to own.
    let (mut locked, mut acquiring) = (Vec::<f64>::new(), Vec::<f64>::new());
    let (mut to_lock_frames, mut to_lock_ms) = (Vec::<f64>::new(), Vec::<f64>::new());
    let mut never_locked = 0usize;
    let mut lost = 0usize;
    let mut searches: std::collections::BTreeMap<String, usize> = Default::default();
    let started = Instant::now();

    for (path, id) in &renders {
        let bytes =
            std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        let image = image::load_from_memory(&bytes)
            .map_err(|e| format!("cannot decode {}: {e}", path.display()))?
            .to_rgb8();
        let frames = burst(&image, &synth, card_index(id));
        let mut session = Session::new(None, None, 5);
        let mut was_locked = false;
        let mut elapsed = 0.0f64;
        let mut first_lock: Option<(usize, f64)> = None;
        for (i, jpeg) in frames.iter().enumerate() {
            let t = Instant::now();
            let v = session.frame(jpeg, &opts);
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            elapsed += ms;
            let json = serde_json::to_value(&v).map_err(|e| e.to_string())?;
            let work = ms - f64::from(v.decode_ms);
            if was_locked {
                locked.push(work);
                if let Some(s) = json.get("search").and_then(|s| s.as_str()) {
                    *searches.entry(s.to_string()).or_default() += 1;
                }
            } else {
                acquiring.push(work);
            }
            let now_locked = json.pointer("/lock/phase").and_then(|p| p.as_str()) == Some("locked");
            if now_locked && first_lock.is_none() {
                first_lock = Some((i + 1, elapsed));
            }
            if was_locked && !now_locked {
                lost += 1;
            }
            was_locked = now_locked;
        }
        match first_lock {
            Some((n, ms)) => {
                to_lock_frames.push(n as f64);
                to_lock_ms.push(ms);
            }
            None => never_locked += 1,
        }
    }

    println!(
        "detect-bench: {} renders × {} frames, seed {}, method {}, {:.0} s wall",
        renders.len(),
        args.frames,
        args.seed,
        opts.method.as_str(),
        started.elapsed().as_secs_f64()
    );
    println!("frame ms less decode, arriving locked    {}", show(&locked));
    println!(
        "frame ms less decode, arriving unlocked  {}",
        show(&acquiring)
    );
    println!(
        "frames to lock                           {}",
        show(&to_lock_frames)
    );
    println!(
        "ms to lock, decode included              {}",
        show(&to_lock_ms)
    );
    println!("never locked: {never_locked}   locks lost mid-burst: {lost}");
    if !searches.is_empty() {
        let parts: Vec<String> = searches.iter().map(|(k, n)| format!("{k} {n}")).collect();
        println!("locked frames by search: {}", parts.join(", "));
    }
    Ok(())
}
