//! `scanner-bench-native` — the bench's frames through a session on this machine, as raw records.
//!
//! ```text
//! scanner-bench-native <dir> [--runs 3] [--frames 30] [--one-thread] [--no-ocr]
//! ```
//!
//! `<dir>` is what `bench-prep` writes and what the browser page is served:
//!
//! ```text
//! card-hashes.bin                 the reference bundle
//! labels.json                     optional — names for the ids (`scanner_bench::LabelRow`)
//! models/text-detection.rten      optional, both or neither — the two readers
//! models/text-recognition.rten
//! frames/*.jpg                    the frames, fed in name order
//! ```
//!
//! For each of *no readers* and — when the models are there — *readers*, it loads a session
//! once and feeds the first `--frames` frames `--runs` times in Fast and in Exact, resetting
//! between runs. **What it prints is one JSON object of per-frame records and no summary**:
//! `node scripts/scanner-bench.mjs --summarise <file>` reduces it with the same script the
//! browser page uses, so the two are summarised by one piece of code.
//!
//! **Files by path, plain stdout, no network, no argument parser** — so the same source is what
//! an `aarch64-linux-android` build runs from `adb shell`, where there is nothing else.
//!
//! **Exact resolves inside the frame that starts it** (`ResolveOn::Inline`), which is not what
//! the app does natively — there it is a thread, and the frame returns at once. It is what a
//! browser does, having no thread to give, and a burst of thirty frames is over before a
//! background resolve lands: so the frame a resolve lands on carries its whole cost on both
//! hosts, and `resolution.elapsed_ms` is the resolve alone.
//!
//! **`--one-thread`** runs the whole bench under `card_scanner::host::inline()` — every fan-out
//! on the calling thread, as in a Worker — which separates what one thread costs from what
//! WebAssembly costs. **It also sets `RTEN_NUM_THREADS=1`**, because the crate's seam is not the
//! only thing with threads: the readers' inference keeps a `rayon` pool of its own, one thread
//! a physical core, which `host::inline` has no say over and a Worker does not have.

use card_scanner::session::ResolveOn;
use scanner_bench::{frame, load, record};
use std::path::{Path, PathBuf};
use std::time::Instant;

struct Args {
    dir: PathBuf,
    runs: usize,
    frames: usize,
    one_thread: bool,
    ocr: bool,
}

fn usage() -> ! {
    eprintln!(
        "usage: scanner-bench-native <dir> [--runs 3] [--frames 30] [--one-thread] [--no-ocr]"
    );
    std::process::exit(2);
}

fn args() -> Args {
    let mut parsed = Args {
        dir: PathBuf::new(),
        runs: 3,
        frames: 30,
        one_thread: false,
        ocr: true,
    };
    let mut given = std::env::args().skip(1);
    let mut dir = None;
    while let Some(arg) = given.next() {
        let mut number = || {
            given
                .next()
                .and_then(|n| n.parse().ok())
                .unwrap_or_else(|| usage())
        };
        match arg.as_str() {
            "--runs" => parsed.runs = number(),
            "--frames" => parsed.frames = number(),
            "--one-thread" => parsed.one_thread = true,
            "--no-ocr" => parsed.ocr = false,
            other if other.starts_with("--") => usage(),
            other => dir = Some(PathBuf::from(other)),
        }
    }
    parsed.dir = dir.unwrap_or_else(|| usage());
    parsed
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// A file that may not be there. One that is there and cannot be read is an error.
fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    if path.is_file() {
        read(path).map(Some)
    } else {
        Ok(None)
    }
}

/// The frames, in name order — the order a card was held in.
fn frames(dir: &Path, limit: usize) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut names: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        // Any case, as the page's listing takes them: a camera's `IMG_0001.JPG` is a frame.
        .filter(|path| {
            let extension = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or_default();
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png"
            )
        })
        .collect();
    names.sort();
    names
        .into_iter()
        .take(limit)
        .map(|path| {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            read(&path).map(|bytes| (name, bytes))
        })
        .collect()
}

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

fn run() -> Result<serde_json::Value, String> {
    let args = args();
    if args.one_thread {
        // Read once, when `rten` first builds its pool — which is after this.
        std::env::set_var("RTEN_NUM_THREADS", "1");
    }
    let _one_thread = args.one_thread.then(card_scanner::host::inline);

    let bundle = read(&args.dir.join("card-hashes.bin"))?;
    let labels = read_optional(&args.dir.join("labels.json"))?
        .map(|bytes| String::from_utf8(bytes).map_err(|e| format!("labels.json: {e}")))
        .transpose()?;
    let detection = read_optional(&args.dir.join("models/text-detection.rten"))?;
    let recognition = read_optional(&args.dir.join("models/text-recognition.rten"))?;
    let models = match (&detection, &recognition) {
        (Some(d), Some(r)) if args.ocr => Some((d.as_slice(), r.as_slice())),
        (Some(_), None) | (None, Some(_)) => {
            return Err("one model without the other: the readers need both".into())
        }
        _ => None,
    };
    let frames = frames(&args.dir.join("frames"), args.frames)?;
    if frames.is_empty() {
        return Err(format!("{}: no frames", args.dir.join("frames").display()));
    }

    // Without the readers always; with them when their models are there.
    let mut setups = vec![None];
    setups.extend(models.map(Some));
    let mut configs = Vec::new();
    for with_readers in setups {
        let started = Instant::now();
        let mut loaded = load(&bundle, labels.as_deref(), with_readers)?;
        let load_ms = ms(started);
        // See the module doc: the frame a resolve lands on is then the same frame on every host.
        loaded.session.set_resolve_on(ResolveOn::Inline);

        let mut runs = Vec::new();
        for mode in ["fast", "exact"] {
            let options = format!(r#"{{"mode":"{mode}"}}"#);
            for run in 0..args.runs {
                loaded.session.reset();
                let mut records = Vec::with_capacity(frames.len());
                for (_, jpeg) in &frames {
                    let started = Instant::now();
                    let verdict = frame(&mut loaded.session, jpeg, &options, None);
                    let call_ms = ms(started);
                    let verdict: serde_json::Value =
                        serde_json::from_str(&verdict).map_err(|e| format!("verdict: {e}"))?;
                    let mut kept = record(&verdict);
                    kept["call_ms"] = call_ms.into();
                    records.push(kept);
                }
                runs.push(serde_json::json!({ "mode": mode, "run": run, "frames": records }));
            }
        }
        configs.push(serde_json::json!({
            "ocr": loaded.readers,
            "load_ms": load_ms,
            "printings": loaded.printings,
            "labels": loaded.labels,
            "runs": runs,
        }));
    }

    Ok(serde_json::json!({
        "host": if args.one_thread { "native, one thread" } else { "native" },
        "threads": card_scanner::host::threads(),
        "target": format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS),
        "inputs": {
            "dir": args.dir.display().to_string(),
            "bundle_bytes": bundle.len(),
            "labels_bytes": labels.as_ref().map(String::len),
            "models_bytes": models.map(|(d, r)| d.len() + r.len()),
            "frames": frames.len(),
            "frame_bytes": frames.iter().map(|(_, bytes)| bytes.len()).sum::<usize>(),
        },
        "configs": configs,
    }))
}

fn main() {
    match run() {
        Ok(result) => println!("{result}"),
        Err(reason) => {
            eprintln!("scanner-bench-native: {reason}");
            std::process::exit(1);
        }
    }
}
