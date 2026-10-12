# Scanner Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replay every scan readers sent to the scan inbox through the card scanner, score it against the reader's label, and show the result as a table and a local page.

**Architecture:** A sync script moves scans from the inbox bucket to a durable corpus bucket and mirrors them to an ignored local folder. A new `replay` binary in `crates/card-scanner` feeds each run to fresh sessions and writes `results.json` plus the scanner's slices. A wrapper script runs it and computes the summary, the baseline comparison and `report.html` from that one file.

**Tech Stack:** Rust (`card-scanner`, feature `builder`), Node ≥ 22.18 TypeScript scripts run directly with `node`, Vitest, R2's S3 API signed with `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-10-12-scanner-replay-design.md`

## Global Constraints

- **One commit for the whole feature**, at the end, after `pnpm verify` (repo rule). No per-task commits; no test runs between tasks beyond the single test command each task names.
- No new npm or cargo dependency. `card-scanner` stays outside the cargo workspace; run its cargo commands from the repo root with `--manifest-path crates/card-scanner/Cargo.toml --target-dir crates/card-scanner/target`.
- `card-scanner` is hand-formatted: never run `cargo fmt` on it. New files there follow rustfmt defaults by hand.
- Scripts are erasable-syntax TypeScript (`erasableSyntaxOnly`): no enums, no parameter properties; relative imports carry `.ts`.
- Credentials come from `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` in the environment only. Nothing writes them anywhere.
- Buckets: inbox `mtg-grimoire-scans`, corpus `mtg-grimoire-scan-corpus`. Prefixes `runs/`, `labels/`, `baselines/`.
- No agent runs `scanner:corpus pull` against the real buckets, creates a bucket, or deletes a remote object. Those are the owner's.
- Readers' frames, run ids and `results.json` never enter git. `.scanner-corpus/` is ignored.
- Tests use no network and no real scan.

## Review Focus

1. **A label whose frame lengths do not add up to the run's bytes** (truncated download): the run is skipped with a sentence; no panic, no partial replay. Pinned in Task 1.
2. **A run whose label names a printing the local card data does not have** (bundle older than the scan): scored on printing equality alone, reported as such, never a crash. Pinned in Task 1 (`score` with no oracle).
3. **`--drain` after a copy that did not verify**: that pair stays in the inbox. Pinned in Task 4.
4. **A listing longer than one page** (more than 1,000 objects): every page is read. Pinned in Task 3.
5. **A card name or read text containing `<`, `&` or a quote** in the report: escaped, never markup. Pinned in Task 6.

---

### Task 1: Label, cut and score, in the library

**Files:**
- Create: `crates/card-scanner/src/replay.rs`
- Modify: `crates/card-scanner/src/lib.rs` (add `pub mod replay;` after `pub mod reference;`)

**Interfaces:**
- Produces (all `pub`, in `card_scanner::replay`):
  - `struct ScanLabel { v: u32, id: String, received_at: String, bytes: u64, card: LabelCard, finish: String, scanner: LabelScanner, app: LabelApp, run: Vec<LabelFrame> }`
  - `struct LabelCard { id, set, number, lang, name: String }`
  - `struct LabelScanner { reported: Option<String>, mode: ScanMode, confidence: Option<f32>, distance: Option<f32>, bundle: Option<u64>, filters: LabelFilters }`
  - `struct LabelFilters { sets: Vec<String>, from: Option<String>, to: Option<String> }` with `fn scan_filters(&self) -> ScanFilters`
  - `struct LabelApp { version: String, platform: String }`
  - `struct LabelFrame { ms: i64, bytes: usize, width: u32, height: u32, ok: bool, lock: Option<String>, confidence: Option<f32>, distance: Option<f32>, decided: Option<String>, detail: bool }`
  - `fn parse_label(text: &str) -> Result<ScanLabel, String>`
  - `fn cut<'a>(label: &ScanLabel, run: &'a [u8]) -> Result<Vec<&'a [u8]>, String>`
  - `enum Score { Printing, Card, Wrong, Undecided, Error }` (serialises lower case)
  - `fn score(truth: &str, truth_oracle: Option<&str>, got: Option<&str>, got_oracle: Option<&str>) -> Score`

All structs derive `Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize`.

- [ ] **Step 1: Write the module with its tests first**

Create `crates/card-scanner/src/replay.rs`:

```rust
//! A reader's scan, as the scan inbox stores it, and how a replay of one is scored.
//!
//! The inbox (`infrastructure/scan-worker/`) keeps a run of five to twenty JPEGs end to end
//! and a label beside it. This module reads the label, cuts the run by it, and says how a
//! decision compares with the printing the reader named. It builds no session and reads no
//! file: `bin/replay` does both, and everything here is tested under any feature set.

use crate::filters::ScanFilters;
use crate::session::ScanMode;
use serde::{Deserialize, Serialize};

/// The label shape this reads. The inbox writes `"v": 1`.
pub const LABEL_VERSION: u32 = 1;
/// A JPEG's first three bytes — what the inbox holds each frame's start to.
const JPEG_MAGIC: [u8; 3] = [0xFF, 0xD8, 0xFF];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScanLabel {
    pub v: u32,
    pub id: String,
    pub received_at: String,
    pub bytes: u64,
    pub card: LabelCard,
    pub finish: String,
    pub scanner: LabelScanner,
    pub app: LabelApp,
    pub run: Vec<LabelFrame>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabelCard {
    pub id: String,
    pub set: String,
    pub number: String,
    pub lang: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabelScanner {
    pub reported: Option<String>,
    pub mode: ScanMode,
    pub confidence: Option<f32>,
    pub distance: Option<f32>,
    pub bundle: Option<u64>,
    pub filters: LabelFilters,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabelFilters {
    pub sets: Vec<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

impl LabelFilters {
    /// The filters a session takes. A replay without them is another scan.
    pub fn scan_filters(&self) -> ScanFilters {
        ScanFilters {
            sets: self.sets.clone(),
            released_from: self.from.clone(),
            released_to: self.to.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabelApp {
    pub version: String,
    pub platform: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabelFrame {
    pub ms: i64,
    pub bytes: usize,
    pub width: u32,
    pub height: u32,
    pub ok: bool,
    pub lock: Option<String>,
    pub confidence: Option<f32>,
    pub distance: Option<f32>,
    pub decided: Option<String>,
    pub detail: bool,
}

/// A label as the inbox stored it. A version this does not read is refused by number.
pub fn parse_label(text: &str) -> Result<ScanLabel, String> {
    let label: ScanLabel = serde_json::from_str(text).map_err(|e| format!("label: {e}"))?;
    if label.v != LABEL_VERSION {
        return Err(format!("label version {} is not {LABEL_VERSION}", label.v));
    }
    if label.run.is_empty() {
        return Err("label lists no frames".to_string());
    }
    Ok(label)
}

/// The run cut back into its frames, oldest first. The label is the run's only index, so a
/// run that is not as long as its frames together, or does not start as a JPEG does at one
/// of them, is refused whole — a replay around a hole is not the scan.
pub fn cut<'a>(label: &ScanLabel, run: &'a [u8]) -> Result<Vec<&'a [u8]>, String> {
    let total: usize = label.run.iter().map(|f| f.bytes).sum();
    if total != run.len() {
        return Err(format!(
            "the label's frames add up to {total} bytes and the run is {}",
            run.len()
        ));
    }
    let mut at = 0;
    let mut frames = Vec::with_capacity(label.run.len());
    for (n, frame) in label.run.iter().enumerate() {
        let bytes = &run[at..at + frame.bytes];
        if !bytes.starts_with(&JPEG_MAGIC) {
            return Err(format!("frame {n} does not start as a JPEG does"));
        }
        frames.push(bytes);
        at += frame.bytes;
    }
    Ok(frames)
}

/// How a decision compares with the printing the reader named.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Score {
    /// The printing the reader named.
    Printing,
    /// Another printing of the same card.
    Card,
    /// Another card.
    Wrong,
    /// No decision by the last frame.
    Undecided,
    /// The run could not be replayed; left out of every percentage.
    Error,
}

/// `got` is the printing decided on, `None` for none. The oracle ids say whether two
/// printings are one card; with either missing, only the same printing is the same card.
pub fn score(
    truth: &str,
    truth_oracle: Option<&str>,
    got: Option<&str>,
    got_oracle: Option<&str>,
) -> Score {
    let Some(got) = got else { return Score::Undecided };
    if got.eq_ignore_ascii_case(truth) {
        return Score::Printing;
    }
    match (truth_oracle, got_oracle) {
        (Some(a), Some(b)) if a.eq_ignore_ascii_case(b) => Score::Card,
        _ => Score::Wrong,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The inbox README's own example, cut to two frames.
    fn label_text(first: usize, second: usize) -> String {
        format!(
            r#"{{"v":1,"card":{{"id":"aaaaaaaa-0000-0000-0000-000000000001","set":"2x2",
            "number":"117","lang":"en","name":"Lightning Bolt"}},"finish":"foil",
            "scanner":{{"reported":null,"mode":"fast","confidence":0.82,"distance":31,
            "bundle":98000,"filters":{{"sets":["2x2","lea"],"from":null,"to":"2022-07-08"}}}},
            "app":{{"version":"0.43.0","platform":"desktop"}},
            "run":[{{"ms":-110,"bytes":{first},"width":960,"height":540,"ok":true,
            "lock":"acquiring","confidence":null,"distance":44,"decided":null,"detail":false}},
            {{"ms":0,"bytes":{second},"width":960,"height":540,"ok":true,"lock":"locked",
            "confidence":0.82,"distance":31,"decided":null,"detail":true}}],
            "id":"20261011T101500Z-9f8a0c1d2e3f4a5b","received_at":"2026-10-11T10:15:00.123Z",
            "bytes":{}}}"#,
            first + second
        )
    }

    fn jpeg(len: usize, fill: u8) -> Vec<u8> {
        let mut bytes = vec![fill; len];
        bytes[..3].copy_from_slice(&JPEG_MAGIC);
        bytes
    }

    #[test]
    fn reads_the_inboxes_label_nulls_and_whole_numbers_included() {
        let label = parse_label(&label_text(5, 7)).expect("parses");
        assert_eq!(label.card.name, "Lightning Bolt");
        assert_eq!(label.scanner.mode, ScanMode::Fast);
        assert_eq!(label.scanner.reported, None);
        assert_eq!(label.scanner.distance, Some(31.0));
        assert_eq!(label.run[0].confidence, None);
        assert!(label.run[1].detail);
        let filters = label.scanner.filters.scan_filters();
        assert_eq!(filters.sets, vec!["2x2", "lea"]);
        assert_eq!(filters.released_to.as_deref(), Some("2022-07-08"));
    }

    #[test]
    fn refuses_another_version_and_an_empty_run() {
        let other = label_text(5, 7).replace(r#""v":1"#, r#""v":2"#);
        assert!(parse_label(&other).unwrap_err().contains("version 2"));
        assert!(parse_label("{").unwrap_err().starts_with("label:"));
    }

    #[test]
    fn cuts_a_run_where_the_label_says() {
        let label = parse_label(&label_text(5, 7)).unwrap();
        let run = [jpeg(5, 1), jpeg(7, 2)].concat();
        let frames = cut(&label, &run).expect("cuts");
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0], &jpeg(5, 1)[..]);
        assert_eq!(frames[1], &jpeg(7, 2)[..]);
    }

    #[test]
    fn refuses_a_run_cut_short_and_a_frame_that_is_not_a_jpeg() {
        let label = parse_label(&label_text(5, 7)).unwrap();
        let short = [jpeg(5, 1), jpeg(6, 2)].concat();
        assert!(cut(&label, &short).unwrap_err().contains("12 bytes and the run is 11"));
        let mut holed = [jpeg(5, 1), jpeg(7, 2)].concat();
        holed[5] = 0;
        assert_eq!(cut(&label, &holed).unwrap_err(), "frame 1 does not start as a JPEG does");
    }

    #[test]
    fn scores_a_decision_against_the_readers_printing() {
        assert_eq!(score("p1", Some("o1"), None, None), Score::Undecided);
        assert_eq!(score("p1", Some("o1"), Some("P1"), Some("o1")), Score::Printing);
        assert_eq!(score("p1", Some("o1"), Some("p2"), Some("o1")), Score::Card);
        assert_eq!(score("p1", Some("o1"), Some("p3"), Some("o9")), Score::Wrong);
    }

    /// A scan of a printing newer than the local card data: no oracle on one side. Only the
    /// same printing can be right, and nothing panics.
    #[test]
    fn scores_without_an_oracle_on_printing_alone() {
        assert_eq!(score("p1", None, Some("p1"), Some("o1")), Score::Printing);
        assert_eq!(score("p1", None, Some("p2"), Some("o1")), Score::Wrong);
        assert_eq!(score("p1", Some("o1"), Some("p2"), None), Score::Wrong);
    }
}
```

Add to `crates/card-scanner/src/lib.rs`, after `pub mod reference;`:

```rust
pub mod replay;
```

- [ ] **Step 2: Run the tests**

Run: `cargo test --manifest-path crates/card-scanner/Cargo.toml --target-dir crates/card-scanner/target --features cli --lib replay`
Expected: 6 passed. If `ScanFilters` has fields beyond the three named, add `..Default::default()` to `scan_filters`.

---

### Task 2: The `replay` binary

**Files:**
- Create: `crates/card-scanner/src/bin/support/labels.rs` (moved out of `eval.rs`)
- Modify: `crates/card-scanner/src/bin/eval.rs` (remove the moved items, include the module)
- Create: `crates/card-scanner/src/bin/replay.rs`
- Modify: `crates/card-scanner/Cargo.toml` (a `[[bin]]`)

**Interfaces:**
- Consumes: Task 1's `card_scanner::replay::{parse_label, cut, score, ScanLabel, Score}`.
- Produces: the `results.json` schema below, which Tasks 5 to 7 read; and slice files at `<out>/slices/<id>/NN-<kind>.jpg`.

```jsonc
{
  "v": 1,
  "commit": "8a4db8cc",            // --commit, or null
  "bundle_printings": 113494,
  "runs": [{
    "id": "20261011T101500Z-9f8a0c1d2e3f4a5b",
    "received_at": "2026-10-11T10:15:00.123Z",
    "card": { "id": "...", "set": "2x2", "number": "117", "lang": "en", "name": "Lightning Bolt" },
    "finish": "foil", "platform": "desktop", "version": "0.43.0",
    "mode": "fast", "filtered": true, "detail": true, "frames": 12,
    "known": true,                 // the label's printing is in the local card data
    "then": { "score": "undecided", "got": null },   // the label's scanner.reported, scored
    "decided_differs": 2,          // frames whose As scanned `decided` differs from the label's
    "then_frames": [{ "ms": -110, "ok": true, "lock": "locked", "decided": null, "detail": false }],
    "passes": [{
      "name": "As scanned", "mode": "fast",
      "score": "wrong", "ambiguous": false, "true_in_choices": false,
      "got": { "id": "...", "name": "Shock", "set": "m19", "number": "156" },   // or null
      "first_decision_frame": 9,   // 1-based, or null
      "confidence": 0.81, "distance": 33.0,          // the last frame's, each nullable
      "frames": [{ "ok": true, "lock": "locked", "confidence": 0.4, "distance": 33.0, "decided": null }],
      "tiers": [{ "tier": "title", "survivors": 3, "detail": "..." }],
      "slices": [{ "frame": 9, "kind": "title", "file": "slices/<id>/09-title.jpg",
                   "raw": "Shock", "normalized": "shock", "matched": "..." }],
      "error": null
    }]
  }],
  "skipped": [{ "id": "...", "why": "the label's frames add up to…" }]
}
```

- [ ] **Step 1: Move the label loading out of `eval.rs`**

Create `crates/card-scanner/src/bin/support/labels.rs` holding, moved verbatim from `eval.rs` with `pub` added to each item and to `LabelRow`'s fields: `LabelRow`, `rows_from_corpus`, `labels_agree`, `attach`, `open_corpus`. Head the file with:

```rust
//! Every label a session needs, read once — shared by `eval` and `replay`, which each build a
//! fresh session per card and cannot afford `Reference::load_labels` every time.

use card_scanner::index::{parse_uuid, Bundle, ID_LEN};
use card_scanner::reference::{Label, Reference};
use std::path::Path;
```

In `eval.rs`, delete those five items and add below the `use` block:

```rust
#[path = "support/labels.rs"]
mod labels;
use labels::{attach, labels_agree, open_corpus, rows_from_corpus, LabelRow};
```

Remove from `eval.rs`'s `use` lines any name that is now unused (the compiler names them).

Run: `cargo test --manifest-path crates/card-scanner/Cargo.toml --target-dir crates/card-scanner/target --features builder --bin eval`
Expected: the same tests pass as before the move, no warnings.

- [ ] **Step 2: Add the bin to the manifest**

In `crates/card-scanner/Cargo.toml`, after the `bench-prep` bin:

```toml
# Readers' scans, replayed and scored (`docs/reference/card-scanner.md`, *The replay*). Beside
# `eval`, which asks the same of synthetic frames.
[[bin]]
name = "replay"
path = "src/bin/replay.rs"
required-features = ["builder"]
```

- [ ] **Step 3: Write `replay.rs` with its test first**

Create `crates/card-scanner/src/bin/replay.rs`:

```rust
//! `replay` — readers' scans, put back through the scanner and scored.
//!
//! **Real frames, where `eval`'s are synthetic.** A supporter's Send stores the last two
//! seconds of frames the scanner judged beside the printing the reader says they show
//! (`infrastructure/scan-worker/README.md`). This feeds each run to fresh sessions and writes
//! what they came to, as facts: `results.json`, and the pictures the scanner cut along the way.
//! The table, the comparison with a baseline and the page are `scripts/scanner-replay.ts`'s.
//!
//! ```text
//! replay --corpus-dir .scanner-corpus --bundle card-hashes.bin
//!        (--corpus corpus.db | --bulk default-cards.jsonl) --models models --out <dir>
//!        [--commit <sha>] [--only <text>]... [--jobs N]
//! ```
//!
//! **Three passes a run, a fresh [`Session`] each**: as it was scanned (the label's mode and
//! filters), Fast unfiltered, Exact unfiltered. Every frame is fed, in order, and a pass is
//! judged on the decision the session holds on the last one — the label names the card in the
//! last frame, and `scanner.reported` is that frame's own decision too.
//!
//! **A replay is not the scan**, three ways the inbox documents: nothing from before the first
//! frame, no detail pictures, and the developer sliders at their defaults. `then` and
//! `decided_differs` are how far that moved an answer, apart from any change to the scanner.
//!
//! **No clock decides anything**: the resolve runs inside its frame ([`ResolveOn::Inline`]),
//! so a run answers the same on a loaded machine and frames are fed as fast as they decode.

use card_scanner::index::{format_uuid, parse_uuid, Bundle, ID_LEN};
use card_scanner::ocr::TitleReader;
use card_scanner::reference::Reference;
use card_scanner::replay::{cut, parse_label, score, ScanLabel, Score};
use card_scanner::resolve::TierView;
use card_scanner::session::{FrameOptions, Outcome, ResolveOn, ScanMode, Session, Verdict};
use clap::{ArgGroup, Parser};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

#[path = "support/labels.rs"]
mod labels;
use labels::{attach, labels_agree, open_corpus, rows_from_corpus, LabelRow};

/// Candidates per frame — the app's default.
const TOP: usize = 5;
const SCHEMA: u32 = 1;

#[derive(Parser, Debug)]
#[command(name = "replay", about = "Readers' scans, replayed through the card scanner")]
#[command(group(ArgGroup::new("source").required(true).args(["corpus", "bulk"])))]
struct Args {
    /// The local mirror: `labels/<id>.json` beside `runs/<id>.bin`.
    #[arg(long)]
    corpus_dir: PathBuf,
    #[arg(long)]
    bundle: PathBuf,
    /// The app's `corpus.db`, for labels. Opened read-only.
    #[arg(long)]
    corpus: Option<PathBuf>,
    /// Scryfall's `default_cards`, uncompressed. Not yet read here — see `run`.
    #[arg(long)]
    bulk: Option<PathBuf>,
    /// Directory holding `text-detection.rten` and `text-recognition.rten`.
    #[arg(long)]
    models: PathBuf,
    /// Where `results.json` and `slices/` go.
    #[arg(long)]
    out: PathBuf,
    /// The scanner's commit, recorded in the results. The caller's to know.
    #[arg(long)]
    commit: Option<String>,
    /// Replay only runs whose id or card name contains this text, ignoring case. Repeatable.
    #[arg(long)]
    only: Vec<String>,
    #[arg(long)]
    jobs: Option<usize>,
}

/// What a session is built from, loaded once and shared by every worker.
struct Ingredients {
    bundle: Vec<u8>,
    labels: Vec<LabelRow>,
    detection: Vec<u8>,
    recognition: Vec<u8>,
    oracles: HashMap<[u8; ID_LEN], [u8; ID_LEN]>,
}

impl Ingredients {
    fn session(&self) -> Result<Session, String> {
        let bundle = Bundle::from_bytes(&self.bundle).map_err(|e| format!("bundle: {e}"))?;
        let mut reference = Reference::new(bundle);
        attach(&mut reference, &self.labels);
        let reader = TitleReader::from_bytes(&self.detection, &self.recognition)?;
        let mut session = Session::new(Some(reference), Some(reader), TOP);
        session.set_resolve_on(ResolveOn::Inline);
        Ok(session)
    }

    fn oracle_of(&self, printing: &str) -> Option<String> {
        parse_uuid(printing).and_then(|id| self.oracles.get(&id)).map(format_uuid)
    }

    fn knows(&self, printing: &str) -> bool {
        parse_uuid(printing).is_some_and(|id| self.labels.iter().any(|l| l.id == id))
    }
}

/// One of the three passes.
struct Pass {
    name: &'static str,
    mode: ScanMode,
    /// The label's filters, or none.
    filtered: bool,
    /// Keep the pictures the scanner cut. The As scanned pass alone.
    slices: bool,
}

const AS_SCANNED: &str = "As scanned";

fn passes(label: &ScanLabel) -> [Pass; 3] {
    [
        Pass { name: AS_SCANNED, mode: label.scanner.mode, filtered: true, slices: true },
        Pass { name: "Fast", mode: ScanMode::Fast, filtered: false, slices: false },
        Pass { name: "Exact", mode: ScanMode::Exact, filtered: false, slices: false },
    ]
}

#[derive(Debug, Clone, Serialize)]
struct Got {
    id: String,
    name: Option<String>,
    set: Option<String>,
    number: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct FrameOut {
    ok: bool,
    lock: Option<String>,
    confidence: Option<f32>,
    distance: Option<f32>,
    decided: Option<String>,
}

/// One picture the scanner cut, and the words it read from it.
#[derive(Debug, Clone, Serialize)]
struct Slice {
    /// 1-based, as `first_decision_frame` is.
    frame: usize,
    kind: &'static str,
    file: String,
    raw: Option<String>,
    normalized: Option<String>,
    matched: Option<String>,
    #[serde(skip)]
    data_uri: String,
}

#[derive(Debug, Clone, Serialize)]
struct PassOut {
    name: &'static str,
    mode: ScanMode,
    score: Score,
    ambiguous: bool,
    true_in_choices: bool,
    got: Option<Got>,
    first_decision_frame: Option<usize>,
    confidence: Option<f32>,
    distance: Option<f32>,
    frames: Vec<FrameOut>,
    tiers: Vec<TierView>,
    slices: Vec<Slice>,
    error: Option<String>,
}

/// What the page records of a verdict for a label (`packages/ui/features/scanner/submit/
/// run.ts`), read off the same four places — so `then` and now are one measure.
fn frame_out(v: &Verdict) -> FrameOut {
    let json = |value: serde_json::Result<serde_json::Value>| value.unwrap_or_default();
    let lock = json(serde_json::to_value(&v.lock));
    let best = json(serde_json::to_value(v.r#match.as_ref().and_then(|m| m.candidates.first())));
    FrameOut {
        ok: v.ok,
        lock: lock.get("phase").and_then(|p| p.as_str()).map(str::to_string),
        confidence: v.tracked.as_ref().map(|t| t.confidence),
        distance: best.get("distance").and_then(|d| d.as_f64()).map(|d| d as f32),
        decided: v.decision.as_ref().map(|d| d.printing.clone()),
    }
}

/// Feed every frame of a run to a fresh session and say what it held at the end.
fn run_pass(
    session: &mut Session,
    pass: &Pass,
    label: &ScanLabel,
    frames: &[&[u8]],
    truth_oracle: Option<&str>,
    oracle_of: impl Fn(&str) -> Option<String>,
) -> PassOut {
    let mut out = PassOut {
        name: pass.name,
        mode: pass.mode,
        score: Score::Undecided,
        ambiguous: false,
        true_in_choices: false,
        got: None,
        first_decision_frame: None,
        confidence: None,
        distance: None,
        frames: Vec::with_capacity(frames.len()),
        tiers: Vec::new(),
        slices: Vec::new(),
        error: None,
    };
    if pass.filtered {
        if let Err(e) = session.set_filters(label.scanner.filters.scan_filters()) {
            out.score = Score::Error;
            out.error = Some(format!("filters: {e}"));
            return out;
        }
    }
    let opts = FrameOptions {
        mode: pass.mode,
        stages: pass.slices,
        previews: pass.slices,
        ..Default::default()
    };
    // The frame whose rectified card and black and white image are kept: the deciding one,
    // else the last with a card.
    let mut pictured: Option<(usize, Verdict)> = None;
    let mut last: Option<Verdict> = None;
    for (i, jpeg) in frames.iter().enumerate() {
        let v = session.frame(jpeg, &opts);
        let n = i + 1;
        if out.first_decision_frame.is_none() && v.decision_seq > 0 {
            out.first_decision_frame = Some(n);
            pictured = Some((n, v.clone()));
        }
        if out.first_decision_frame.is_none() && v.rectified.is_some() {
            pictured = Some((n, v.clone()));
        }
        if let Some(r) = &v.resolution {
            out.tiers = r.tiers.clone();
        }
        if pass.slices {
            if let Some(band) = v.ocr.as_ref().and_then(|o| o.band.clone().map(|b| (o, b))) {
                out.slices.push(slice(label, n, "title", band.1, Some(&band.0.raw),
                    Some(&band.0.normalized), band.0.matched.as_deref()));
            }
            if let Some(band) = v.collector.as_ref().and_then(|c| c.band.clone().map(|b| (c, b))) {
                out.slices.push(slice(label, n, "collector", band.1, Some(&band.0.raw), None,
                    band.0.matched.as_deref()));
            }
        }
        out.frames.push(frame_out(&v));
        last = Some(v);
    }
    if pass.slices {
        if let Some((n, v)) = pictured {
            let binary = v.stages.as_ref().and_then(|s| s.binary.clone());
            let mut front = Vec::new();
            if let Some(uri) = v.rectified {
                front.push(slice(label, n, "rectified", uri, None, None, None));
            }
            if let Some(uri) = binary {
                front.push(slice(label, n, "binary", uri, None, None, None));
            }
            front.append(&mut out.slices);
            out.slices = front;
        }
    }
    let Some(last) = last else { return out };
    out.confidence = last.tracked.as_ref().map(|t| t.confidence);
    out.distance = out.frames.last().and_then(|f| f.distance);
    if let Some(d) = &last.decision {
        let got_oracle = d.oracle_id.clone().or_else(|| oracle_of(&d.printing));
        out.score = score(&label.card.id, truth_oracle, Some(&d.printing), got_oracle.as_deref());
        out.ambiguous = d.outcome == Outcome::Ambiguous;
        out.true_in_choices =
            out.ambiguous && d.choices.iter().any(|c| c.id.eq_ignore_ascii_case(&label.card.id));
        out.got = Some(Got {
            id: d.printing.clone(),
            name: d.label.as_ref().map(|l| l.name.clone()),
            set: d.label.as_ref().map(|l| l.set.clone()),
            number: d.label.as_ref().map(|l| l.number.clone()),
        });
    }
    out
}

fn slice(
    label: &ScanLabel,
    frame: usize,
    kind: &'static str,
    data_uri: String,
    raw: Option<&str>,
    normalized: Option<&str>,
    matched: Option<&str>,
) -> Slice {
    Slice {
        frame,
        kind,
        file: format!("slices/{}/{frame:02}-{kind}.jpg", label.id),
        raw: raw.map(str::to_string),
        normalized: normalized.map(str::to_string),
        matched: matched.map(str::to_string),
        data_uri,
    }
}

/// The bytes of a `data:image/jpeg;base64,` picture, as the session hands its previews out.
fn decode_data_uri(uri: &str) -> Option<Vec<u8>> {
    let text = uri.strip_prefix("data:image/jpeg;base64,")?;
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.bytes().filter(|&c| c != b'=') {
        acc = (acc << 6) | u32::from(value(c)?);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

#[derive(Debug, Serialize)]
struct Then {
    score: Score,
    got: Option<String>,
}

#[derive(Debug, Serialize)]
struct ThenFrame {
    ms: i64,
    ok: bool,
    lock: Option<String>,
    decided: Option<String>,
    detail: bool,
}

#[derive(Debug, Serialize)]
struct RunOut {
    id: String,
    received_at: String,
    card: card_scanner::replay::LabelCard,
    finish: String,
    platform: String,
    version: String,
    mode: ScanMode,
    filtered: bool,
    detail: bool,
    frames: usize,
    known: bool,
    then: Then,
    decided_differs: usize,
    then_frames: Vec<ThenFrame>,
    passes: Vec<PassOut>,
}

#[derive(Debug, Serialize)]
struct Skipped {
    id: String,
    why: String,
}

#[derive(Debug, Serialize)]
struct Results {
    v: u32,
    commit: Option<String>,
    bundle_printings: usize,
    runs: Vec<RunOut>,
    skipped: Vec<Skipped>,
}

fn replay_run(label: &ScanLabel, frames: &[&[u8]], ingredients: &Ingredients) -> RunOut {
    let truth_oracle = ingredients.oracle_of(&label.card.id);
    let passes: Vec<PassOut> = passes(label)
        .iter()
        .map(|pass| match ingredients.session() {
            Ok(mut session) => run_pass(&mut session, pass, label, frames,
                truth_oracle.as_deref(), |p| ingredients.oracle_of(p)),
            Err(e) => PassOut {
                name: pass.name, mode: pass.mode, score: Score::Error, ambiguous: false,
                true_in_choices: false, got: None, first_decision_frame: None,
                confidence: None, distance: None, frames: Vec::new(), tiers: Vec::new(),
                slices: Vec::new(), error: Some(e),
            },
        })
        .collect();
    let reported = label.scanner.reported.as_deref();
    let then = Then {
        score: score(&label.card.id, truth_oracle.as_deref(), reported,
            reported.and_then(|p| ingredients.oracle_of(p)).as_deref()),
        got: label.scanner.reported.clone(),
    };
    let decided_differs = label.run.iter().zip(&passes[0].frames)
        .filter(|(then, now)| then.decided != now.decided)
        .count();
    let f = &label.scanner.filters;
    RunOut {
        id: label.id.clone(),
        received_at: label.received_at.clone(),
        card: label.card.clone(),
        finish: label.finish.clone(),
        platform: label.app.platform.clone(),
        version: label.app.version.clone(),
        mode: label.scanner.mode,
        filtered: !f.sets.is_empty() || f.from.is_some() || f.to.is_some(),
        detail: label.run.iter().any(|fr| fr.detail),
        frames: frames.len(),
        known: ingredients.knows(&label.card.id),
        then,
        decided_differs,
        then_frames: label.run.iter().map(|fr| ThenFrame {
            ms: fr.ms, ok: fr.ok, lock: fr.lock.clone(), decided: fr.decided.clone(),
            detail: fr.detail,
        }).collect(),
        passes,
    }
}

/// Every label in the mirror with its run, or why not. Sorted by id, which is by arrival.
fn read_corpus(dir: &Path) -> Result<Vec<Result<(ScanLabel, Vec<u8>), Skipped>>, String> {
    let labels = dir.join("labels");
    let mut ids: Vec<String> = std::fs::read_dir(&labels)
        .map_err(|e| format!("cannot read {}: {e}", labels.display()))?
        .flatten()
        .filter_map(|entry| entry.file_name().to_str()?.strip_suffix(".json").map(str::to_string))
        .collect();
    ids.sort();
    Ok(ids
        .into_iter()
        .map(|id| {
            let skip = |why: String| Skipped { id: id.clone(), why };
            let text = std::fs::read_to_string(labels.join(format!("{id}.json")))
                .map_err(|e| skip(format!("label: {e}")))?;
            let label = parse_label(&text).map_err(skip)?;
            let run = std::fs::read(dir.join("runs").join(format!("{id}.bin")))
                .map_err(|e| skip(format!("run: {e}")))?;
            cut(&label, &run).map_err(skip)?;
            Ok((label, run))
        })
        .collect())
}

/// `work(i)` for every `i` below `count`, on `jobs` scoped workers, in index order.
fn parallel<T: Send>(count: usize, jobs: usize, work: impl Fn(usize) -> T + Sync) -> Vec<T> {
    let slots: Mutex<Vec<Option<T>>> = Mutex::new((0..count).map(|_| None).collect());
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..jobs.clamp(1, count.max(1)) {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                if index >= count {
                    break;
                }
                let out = work(index);
                slots.lock().expect("slots")[index] = Some(out);
            });
        }
    });
    slots.into_inner().expect("slots").into_iter()
        .map(|s| s.expect("every index is taken by exactly one worker"))
        .collect()
}

fn write_slices(out: &Path, run: &RunOut) -> Result<(), String> {
    for slice in run.passes.iter().flat_map(|p| &p.slices) {
        let Some(bytes) = decode_data_uri(&slice.data_uri) else { continue };
        let path = out.join(&slice.file);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    Ok(())
}

fn run(args: Args) -> Result<(), String> {
    let Some(corpus) = &args.corpus else {
        return Err("--bulk is not read by replay yet; pass --corpus corpus.db".to_string());
    };
    let bundle = std::fs::read(&args.bundle)
        .map_err(|e| format!("cannot read bundle {}: {e}", args.bundle.display()))?;
    let bundle_printings = Bundle::from_bytes(&bundle)
        .map_err(|e| format!("bundle {}: {e}", args.bundle.display()))?
        .cards
        .len();
    let model = |name: &str| {
        let path = args.models.join(name);
        std::fs::read(&path).map_err(|e| format!("model {}: {e}", path.display()))
    };
    let (detection, recognition) = (model("text-detection.rten")?, model("text-recognition.rten")?);
    let conn = open_corpus(corpus)?;
    let labels = rows_from_corpus(&conn)?;
    labels_agree(&bundle, &labels, &conn)?;
    let oracles = labels.iter().filter_map(|l| l.oracle.map(|o| (l.id, o))).collect();
    let ingredients = Ingredients { bundle, labels, detection, recognition, oracles };
    drop(ingredients.session()?);

    let needles: Vec<String> = args.only.iter().map(|s| s.to_lowercase()).collect();
    let mut skipped = Vec::new();
    let mut ready = Vec::new();
    for read in read_corpus(&args.corpus_dir)? {
        match read {
            Ok((label, run)) => {
                let shown = format!("{} {}", label.id, label.card.name).to_lowercase();
                if needles.is_empty() || needles.iter().any(|n| shown.contains(n.as_str())) {
                    ready.push((label, run));
                }
            }
            Err(skip) => skipped.push(skip),
        }
    }
    if ready.is_empty() {
        return Err(format!(
            "no scan in {} could be replayed ({} skipped)",
            args.corpus_dir.display(),
            skipped.len()
        ));
    }
    let jobs = args
        .jobs
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get() / 2));
    let done = AtomicUsize::new(0);
    let runs = parallel(ready.len(), jobs, |i| {
        let (label, run) = &ready[i];
        let frames = cut(label, run).expect("read_corpus cut this run once already");
        let out = replay_run(label, &frames, &ingredients);
        eprintln!("[{}/{}] {} — {}", done.fetch_add(1, Ordering::Relaxed) + 1, ready.len(),
            label.card.name, serde_json::to_string(&out.passes[0].score).unwrap_or_default());
        out
    });
    std::fs::create_dir_all(&args.out)
        .map_err(|e| format!("cannot create {}: {e}", args.out.display()))?;
    for run in &runs {
        write_slices(&args.out, run)?;
    }
    let results = Results { v: SCHEMA, commit: args.commit, bundle_printings, runs, skipped };
    let path = args.out.join("results.json");
    let text = serde_json::to_string(&results).map_err(|e| format!("results: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))?;
    eprintln!("{} runs, {} skipped → {}", results.runs.len(), results.skipped.len(), path.display());
    Ok(())
}

fn main() -> std::process::ExitCode {
    match run(Args::parse()) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("replay: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use card_scanner::hash::{hash_rgb, HashKind};
    use card_scanner::index::{BundleBuilder, Section};
    use card_scanner::reference::Label;
    use card_scanner::replay::{LabelApp, LabelCard, LabelFilters, LabelFrame, LabelScanner};
    use card_scanner::synth::{burst, SynthOptions};
    use image::RgbImage;

    fn id(n: u8) -> [u8; ID_LEN] {
        let mut raw = [0u8; ID_LEN];
        raw[0] = n;
        raw
    }

    /// A card with a border and three bands, as `host.rs`'s tests draw one.
    fn banded(w: u32, h: u32) -> RgbImage {
        let border = 11 * w / 250;
        RgbImage::from_fn(w, h, |x, y| {
            if x < border || y < border || x >= w - border || y >= h - border {
                return image::Rgb([16, 16, 18]);
            }
            let v = match y as f32 / h as f32 {
                t if t < 0.10 => 238,
                t if t < 0.55 => 150,
                _ => 70,
            };
            image::Rgb([v, (v as u32 * 3 / 4) as u8, 255 - v])
        })
    }

    /// A session that knows the banded card (printing 1, card 10), a second printing of it
    /// (printing 2) hashed from its negative, and another card.
    fn session() -> Session {
        let kind = HashKind::DHashChroma32;
        let face = banded(card_scanner::RECTIFIED_W, card_scanner::RECTIFIED_H);
        let negative = RgbImage::from_fn(face.width(), face.height(), |x, y| {
            let p = face.get_pixel(x, y).0;
            image::Rgb([255 - p[0], 255 - p[1], 255 - p[2]])
        });
        let mut b = BundleBuilder::new(kind, 256);
        b.push(Section::Card, id(1), &hash_rgb(&face, kind, 256));
        b.push(Section::Card, id(2), &hash_rgb(&negative, kind, 256));
        let mut r = Reference::new(b.finish(0));
        for (n, oracle) in [(1u8, 10u8), (2, 10)] {
            let label = Label {
                name: format!("Card {oracle}"),
                set: "hob".into(),
                number: n.to_string(),
                lang: "en".into(),
                released: "2025-01-01".into(),
            };
            r.add_label(id(n), Some(id(oracle)), None, label);
        }
        let mut s = Session::new(Some(r), None, TOP);
        s.set_resolve_on(ResolveOn::Inline);
        s
    }

    fn label_for(printing: [u8; ID_LEN], frames: &[Vec<u8>]) -> ScanLabel {
        ScanLabel {
            v: 1,
            id: "20261011T101500Z-0000000000000000".into(),
            received_at: "2026-10-11T10:15:00.000Z".into(),
            bytes: frames.iter().map(|f| f.len() as u64).sum(),
            card: LabelCard {
                id: format_uuid(&printing),
                set: "hob".into(),
                number: "1".into(),
                lang: "en".into(),
                name: "Card 10".into(),
            },
            finish: "nonfoil".into(),
            scanner: LabelScanner {
                reported: None,
                mode: ScanMode::Fast,
                confidence: None,
                distance: None,
                bundle: None,
                filters: LabelFilters { sets: Vec::new(), from: None, to: None },
            },
            app: LabelApp { version: "0.48.0".into(), platform: "desktop".into() },
            run: frames
                .iter()
                .map(|f| LabelFrame {
                    ms: 0, bytes: f.len(), width: 1280, height: 720, ok: true, lock: None,
                    confidence: None, distance: None, decided: None, detail: false,
                })
                .collect(),
        }
    }

    fn frames() -> Vec<Vec<u8>> {
        let face = banded(card_scanner::RECTIFIED_W, card_scanner::RECTIFIED_H);
        burst(&face, &SynthOptions::default(), 1)
    }

    fn fast(slices: bool) -> Pass {
        Pass { name: AS_SCANNED, mode: ScanMode::Fast, filtered: true, slices }
    }

    fn replayed(printing: [u8; ID_LEN], slices: bool) -> PassOut {
        let jpegs = frames();
        let label = label_for(printing, &jpegs);
        let cut: Vec<&[u8]> = jpegs.iter().map(Vec::as_slice).collect();
        let oracle = format_uuid(&id(10));
        run_pass(&mut session(), &fast(slices), &label, &cut, Some(&oracle), |_| {
            Some(format_uuid(&id(10)))
        })
    }

    #[test]
    fn a_run_of_the_card_the_label_names_scores_its_printing() {
        let out = replayed(id(1), false);
        assert_eq!(out.score, Score::Printing, "{:?}", out.error);
        assert_eq!(out.got.as_ref().map(|g| g.id.clone()), Some(format_uuid(&id(1))));
        assert_eq!(out.frames.len(), 12);
        assert!(out.first_decision_frame.is_some_and(|n| n <= 12));
        assert!(out.slices.is_empty(), "a pass that keeps no pictures keeps none");
    }

    #[test]
    fn the_same_run_labelled_as_the_other_printing_scores_the_card() {
        assert_eq!(replayed(id(2), false).score, Score::Card);
    }

    /// The pictures are a by-product. A pass that keeps them must decide what one that does
    /// not decides, on the same frame — or the report would be of a second scanner.
    #[test]
    fn keeping_the_pictures_changes_no_decision() {
        let (plain, pictured) = (replayed(id(1), false), replayed(id(1), true));
        assert_eq!(plain.score, pictured.score);
        assert_eq!(plain.first_decision_frame, pictured.first_decision_frame);
        let decided = |p: &PassOut| p.frames.iter().map(|f| f.decided.clone()).collect::<Vec<_>>();
        assert_eq!(decided(&plain), decided(&pictured));
        let kinds: Vec<&str> = pictured.slices.iter().map(|s| s.kind).collect();
        assert_eq!(kinds, ["rectified", "binary"], "no reader, so no band");
        assert_eq!(pictured.slices[0].frame, pictured.first_decision_frame.unwrap());
        let jpeg = decode_data_uri(&pictured.slices[0].data_uri).expect("a data uri");
        assert!(jpeg.starts_with(&[0xFF, 0xD8, 0xFF]));
    }

    #[test]
    fn a_data_uri_that_is_not_one_is_nothing() {
        assert_eq!(decode_data_uri("https://example.com/a.jpg"), None);
        assert_eq!(decode_data_uri("data:image/jpeg;base64,TWFu"), Some(b"Man".to_vec()));
        assert_eq!(decode_data_uri("data:image/jpeg;base64,TWE="), Some(b"Ma".to_vec()));
    }

    #[test]
    fn a_mirror_with_a_run_cut_short_skips_it_by_name() {
        let dir = std::env::temp_dir().join(format!("replay-test-{}", std::process::id()));
        for sub in ["labels", "runs"] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
        }
        let jpegs = frames();
        let label = label_for(id(1), &jpegs);
        std::fs::write(dir.join("labels").join(format!("{}.json", label.id)),
            serde_json::to_string(&label).unwrap()).unwrap();
        std::fs::write(dir.join("runs").join(format!("{}.bin", label.id)), &jpegs.concat()[1..])
            .unwrap();
        let read = read_corpus(&dir).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        let skip = read.into_iter().next().unwrap().unwrap_err();
        assert_eq!(skip.id, label.id);
        assert!(skip.why.contains("add up to"), "{}", skip.why);
    }
}
```

- [ ] **Step 2: Run the binary's tests**

Run: `cargo test --manifest-path crates/card-scanner/Cargo.toml --target-dir crates/card-scanner/target --features builder --bin replay`
Expected: 5 passed.

Likely adjustments, each named by the compiler: `Verdict` must be `Clone` (it derives it); `card_scanner::RECTIFIED_W`/`RECTIFIED_H` are crate-root constants `host.rs`'s tests use as `crate::RECTIFIED_W`; `Candidate`, `LockState` serialise (both are in `Verdict`, which does). If the synthetic burst does not reach a Fast decision in 12 frames against this two-card reference, raise `SynthOptions { frames: 20, ..Default::default() }` in `frames()` and the `12`s with it — do not loosen an assertion.

---

### Task 3: SigV4 and the S3 calls

**Files:**
- Create: `scripts/scanner-corpus/sigv4.ts`, `scripts/scanner-corpus/s3.ts`
- Test: `scripts/scanner-corpus/sigv4.test.ts`, `scripts/scanner-corpus/s3.test.ts`

**Interfaces:**
- Produces:
  - `sign(request: { method: string; url: URL; headers: Record<string, string>; payloadHash: string }, creds: { accessKeyId: string; secretAccessKey: string }, scope: { region: string; service: string }, now: Date): string` — the `Authorization` header's value. `headers` must already hold `x-amz-date`.
  - `amzDate(now: Date): string` — `20150830T123600Z`.
  - `type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }) => Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }>`
  - `type Entry = { key: string; size: number }`
  - `createS3(config: { accountId: string; accessKeyId: string; secretAccessKey: string }, fetch: Fetch, now?: () => Date): { list(bucket: string, prefix: string): Promise<Entry[]>; get(bucket: string, key: string): Promise<Uint8Array>; put(bucket: string, key: string, body: Uint8Array): Promise<void>; remove(bucket: string, key: string): Promise<void> }`

- [ ] **Step 1: Write the failing tests**

`scripts/scanner-corpus/sigv4.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { amzDate, sign } from "./sigv4.ts";

const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("sigv4", () => {
  // AWS's own published vector, `get-vanilla` of the Signature Version 4 test suite.
  it("signs AWS's get-vanilla vector", () => {
    const now = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));
    expect(amzDate(now)).toBe("20150830T123600Z");
    const header = sign(
      {
        method: "GET",
        url: new URL("https://example.amazonaws.com/"),
        headers: { "x-amz-date": amzDate(now) },
        payloadHash: EMPTY,
      },
      { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      { region: "us-east-1", service: "service" },
      now,
    );
    expect(header).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("sorts the query and the headers it signs", () => {
    const now = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));
    const base = { method: "GET", payloadHash: EMPTY };
    const creds = { accessKeyId: "A", secretAccessKey: "S" };
    const scope = { region: "auto", service: "s3" };
    const one = sign(
      { ...base, url: new URL("https://h/b?prefix=runs%2F&list-type=2"), headers: { "x-amz-date": "d", "x-amz-content-sha256": EMPTY } },
      creds, scope, now,
    );
    const two = sign(
      { ...base, url: new URL("https://h/b?list-type=2&prefix=runs%2F"), headers: { "x-amz-content-sha256": EMPTY, "x-amz-date": "d" } },
      creds, scope, now,
    );
    expect(one).toBe(two);
    expect(one).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
  });
});
```

`scripts/scanner-corpus/s3.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createS3, type Fetch } from "./s3.ts";

const config = { accountId: "acct", accessKeyId: "A", secretAccessKey: "S" };
const page = (keys: [string, number][], next?: string) =>
  `<?xml version="1.0"?><ListBucketResult>` +
  keys.map(([k, s]) => `<Contents><Key>${k}</Key><Size>${s}</Size></Contents>`).join("") +
  (next ? `<IsTruncated>true</IsTruncated><NextContinuationToken>${next}</NextContinuationToken>` : `<IsTruncated>false</IsTruncated>`) +
  `</ListBucketResult>`;

function recorded(answers: (url: string) => { status: number; body: string | Uint8Array }) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: Uint8Array }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, ...init });
    const { status, body } = answers(url);
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    return {
      status,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      text: async () => new TextDecoder().decode(bytes),
    };
  };
  return { calls, fetch };
}

describe("s3", () => {
  it("reads every page of a listing", async () => {
    const { calls, fetch } = recorded((url) =>
      url.includes("continuation-token=t2")
        ? { status: 200, body: page([["runs/c.bin", 3]]) }
        : { status: 200, body: page([["runs/a.bin", 1], ["runs/b&amp;.bin", 2]], "t2") },
    );
    const entries = await createS3(config, fetch).list("bucket", "runs/");
    expect(entries).toEqual([
      { key: "runs/a.bin", size: 1 },
      { key: "runs/b&.bin", size: 2 },
      { key: "runs/c.bin", size: 3 },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://acct.r2.cloudflarestorage.com/bucket?list-type=2&prefix=runs%2F");
    expect(calls[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=A\/\d{8}\/auto\/s3\/aws4_request/);
  });

  it("gets, puts and removes an object by its key", async () => {
    const { calls, fetch } = recorded(() => ({ status: 200, body: new Uint8Array([1, 2, 3]) }));
    const s3 = createS3(config, fetch);
    expect(await s3.get("b", "runs/a.bin")).toEqual(new Uint8Array([1, 2, 3]));
    await s3.put("b", "labels/a.json", new Uint8Array([9]));
    await s3.remove("b", "runs/a.bin");
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /b/runs/a.bin",
      "PUT /b/labels/a.json",
      "DELETE /b/runs/a.bin",
    ]);
    expect(calls[1].body).toEqual(new Uint8Array([9]));
  });

  it("names the bucket, the key and the status of a refusal", async () => {
    const { fetch } = recorded(() => ({ status: 403, body: "<Error><Code>AccessDenied</Code></Error>" }));
    await expect(createS3(config, fetch).get("b", "runs/a.bin")).rejects.toThrow("GET b/runs/a.bin: 403 AccessDenied");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run --project root scripts/scanner-corpus`
Expected: FAIL, the modules do not exist.

- [ ] **Step 3: Implement**

`scripts/scanner-corpus/sigv4.ts`:

```ts
// AWS Signature Version 4, the header form — what R2's S3 API takes. Small enough to hold
// here rather than bring a dependency for four kinds of request; `sigv4.test.ts` holds it to
// AWS's own published vector.

import { createHash, createHmac } from "node:crypto";

export type SignedRequest = {
  method: string;
  url: URL;
  /** Every header to sign bar `host`, which is read from the URL. Must hold `x-amz-date`. */
  headers: Record<string, string>;
  /** SHA-256 of the body, in hex. */
  payloadHash: string;
};

const hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Uint8Array, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986, as SigV4 wants it: everything but unreserved characters, `/` kept in a path. */
function encode(text: string, keepSlash: boolean): string {
  const out = encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? out.replaceAll("%2F", "/") : out;
}

/** `20150830T123600Z`. */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function sha256Hex(body: Uint8Array): string {
  return hex(body);
}

/** The `Authorization` header's value. */
export function sign(
  request: SignedRequest,
  creds: { accessKeyId: string; secretAccessKey: string },
  scope: { region: string; service: string },
  now: Date,
): string {
  const stamp = amzDate(now);
  const day = stamp.slice(0, 8);
  const headers: [string, string][] = Object.entries({ ...request.headers, host: request.url.host })
    .map(([name, value]): [string, string] => [name.toLowerCase(), value.trim()])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signed = headers.map(([name]) => name).join(";");
  const query = [...request.url.searchParams]
    .map(([k, v]) => `${encode(k, false)}=${encode(v, false)}`)
    .sort()
    .join("&");
  const canonical = [
    request.method,
    encode(decodeURIComponent(request.url.pathname), true),
    query,
    ...headers.map(([name, value]) => `${name}:${value}`),
    "",
    signed,
    request.payloadHash,
  ].join("\n");
  const credential = `${day}/${scope.region}/${scope.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", request.headers["x-amz-date"] ?? stamp, credential, hex(canonical)].join("\n");
  const key = [scope.region, scope.service, "aws4_request"].reduce<Uint8Array>(
    (k, part) => hmac(k, part),
    hmac(`AWS4${creds.secretAccessKey}`, day),
  );
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credential}, SignedHeaders=${signed}, Signature=${signature}`;
}
```

`scripts/scanner-corpus/s3.ts`:

```ts
// The four S3 calls the corpus sync makes of R2: list a prefix, and get, put and delete an
// object. `fetch` is handed in, so the suite never opens a socket.

import { amzDate, sha256Hex, sign } from "./sigv4.ts";

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array },
) => Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }>;

export type Entry = { key: string; size: number };
export type S3Config = { accountId: string; accessKeyId: string; secretAccessKey: string };
export type S3 = ReturnType<typeof createS3>;

const NONE = new Uint8Array(0);
const unescape = (text: string) =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
const path = (bucket: string, key: string) => `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

export function createS3(config: S3Config, fetch: Fetch, now: () => Date = () => new Date()) {
  const origin = `https://${config.accountId}.r2.cloudflarestorage.com`;

  async function call(method: string, url: URL, what: string, body: Uint8Array = NONE) {
    const at = now();
    const payloadHash = sha256Hex(body);
    const headers: Record<string, string> = { "x-amz-date": amzDate(at), "x-amz-content-sha256": payloadHash };
    headers.authorization = sign({ method, url, headers, payloadHash }, config, { region: "auto", service: "s3" }, at);
    const answer = await fetch(url.href, { method, headers, ...(body.length ? { body } : {}) });
    if (answer.status >= 300) {
      const code = /<Code>([^<]*)<\/Code>/.exec(await answer.text())?.[1] ?? "";
      throw new Error(`${method} ${what}: ${answer.status} ${code}`.trim());
    }
    return answer;
  }

  return {
    /** Every object under a prefix, every page. */
    async list(bucket: string, prefix: string): Promise<Entry[]> {
      const entries: Entry[] = [];
      let token: string | null = null;
      do {
        const url = new URL(`${origin}/${bucket}`);
        url.searchParams.set("list-type", "2");
        url.searchParams.set("prefix", prefix);
        if (token) url.searchParams.set("continuation-token", token);
        const xml = await (await call("GET", url, `${bucket}/${prefix}*`)).text();
        for (const [, key, size] of xml.matchAll(/<Contents>.*?<Key>([^<]*)<\/Key>.*?<Size>(\d+)<\/Size>.*?<\/Contents>/gs)) {
          entries.push({ key: unescape(key), size: Number(size) });
        }
        token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null;
        if (token) token = unescape(token);
      } while (token);
      return entries;
    },
    async get(bucket: string, key: string): Promise<Uint8Array> {
      const answer = await call("GET", new URL(origin + path(bucket, key)), `${bucket}/${key}`);
      return new Uint8Array(await answer.arrayBuffer());
    },
    async put(bucket: string, key: string, body: Uint8Array): Promise<void> {
      await call("PUT", new URL(origin + path(bucket, key)), `${bucket}/${key}`, body);
    },
    async remove(bucket: string, key: string): Promise<void> {
      await call("DELETE", new URL(origin + path(bucket, key)), `${bucket}/${key}`);
    },
  };
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm exec vitest run --project root scripts/scanner-corpus`
Expected: 5 passed. If the get-vanilla signature differs, the signer is wrong, not the vector: check the canonical request's blank line after the headers and the key derivation order (date, region, service, `aws4_request`).

---

### Task 4: The sync plan, the mirror and `pnpm scanner:corpus`

**Files:**
- Create: `scripts/scanner-corpus/plan.ts`, `scripts/scanner-corpus/mirror.ts`, `scripts/scanner-corpus.ts`
- Test: `scripts/scanner-corpus/plan.test.ts`, `scripts/scanner-corpus/mirror.test.ts`
- Modify: `package.json` (script `"scanner:corpus": "node scripts/scanner-corpus.ts"`, beside `scanner:bench`), `.gitignore` (add `.scanner-corpus/` under `.scanner-bundle/` with a comment line)

**Interfaces:**
- Consumes: Task 3's `Entry`, `S3`.
- Produces:
  - `plan(listing: { inbox: Entry[]; corpus: Entry[]; local: string[] }): Plan` where `type Plan = { adopt: string[]; fetch: string[]; prune: string[]; litter: string[]; baselinesDown: string[] }` — ids to copy inbox→corpus, ids to download, local ids to remove, inbox run ids with no label, and baseline keys the corpus has.
  - `pairs(entries: Entry[]): Map<string, { run: number; label: number }>` — complete pairs by id with their sizes.
  - `drainable(adopted: string[], inbox: Entry[], corpusAfter: Entry[]): string[]` — the adopted ids whose corpus copy matches the inbox's sizes.
  - `corpusDir(env: Record<string, string | undefined>, gitCommonDir: string): string`
  - `cutFrames(labelText: string, run: Uint8Array): Uint8Array[]` (throws with the same sentences as Rust's `cut`)
  - `mirror.ts` `writePair(dir, id, label: Uint8Array, run: Uint8Array): void`, `removePair(dir, id): void`, `localIds(dir): string[]`

- [ ] **Step 1: Write the failing tests**

`scripts/scanner-corpus/plan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { drainable, pairs, plan } from "./plan.ts";

const pair = (id: string, run = 100, label = 10) => [
  { key: `runs/${id}.bin`, size: run },
  { key: `labels/${id}.json`, size: label },
];

describe("the sync plan", () => {
  it("pairs a run with its label and leaves a lone object out", () => {
    const found = pairs([...pair("a"), { key: "runs/b.bin", size: 5 }, { key: "labels/c.json", size: 5 }]);
    expect([...found.keys()]).toEqual(["a"]);
    expect(found.get("a")).toEqual({ run: 100, label: 10 });
  });

  it("adopts what the corpus lacks, fetches what the mirror lacks, prunes what the corpus dropped", () => {
    const got = plan({
      inbox: [...pair("new"), ...pair("both"), { key: "runs/orphan.bin", size: 7 }],
      corpus: [...pair("both"), ...pair("old"), { key: "baselines/first.json", size: 3 }],
      local: ["old", "gone"],
    });
    expect(got).toEqual({
      adopt: ["new"],
      fetch: ["both", "new"],
      prune: ["gone"],
      litter: ["orphan"],
      baselinesDown: ["baselines/first.json"],
    });
  });

  it("calls a run with no label litter and never adopts it", () => {
    const got = plan({ inbox: [{ key: "runs/x.bin", size: 1 }], corpus: [], local: [] });
    expect(got.adopt).toEqual([]);
    expect(got.litter).toEqual(["x"]);
  });

  it("drains only a pair whose copy has the inbox's sizes", () => {
    const inbox = [...pair("ok"), ...pair("short"), ...pair("missing")];
    const corpusAfter = [...pair("ok"), ...pair("short", 99), { key: "runs/missing.bin", size: 100 }];
    expect(drainable(["ok", "short", "missing"], inbox, corpusAfter)).toEqual(["ok"]);
  });
});
```

`scripts/scanner-corpus/mirror.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { corpusDir, cutFrames, localIds, removePair, writePair } from "./mirror.ts";

const jpeg = (len: number, fill: number) => {
  const bytes = new Uint8Array(len).fill(fill);
  bytes.set([0xff, 0xd8, 0xff]);
  return bytes;
};
const label = (lengths: number[]) => JSON.stringify({ run: lengths.map((bytes) => ({ bytes })) });
const concat = (parts: Uint8Array[]) => Buffer.concat(parts);

let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("the local mirror", () => {
  it("sits in the main checkout, not a worktree, unless told otherwise", () => {
    expect(corpusDir({}, "D:/Code/repo/.git")).toBe(join("D:/Code/repo", ".scanner-corpus"));
    expect(corpusDir({ SCANNER_CORPUS_DIR: "E:/scans" }, "D:/Code/repo/.git")).toBe("E:/scans");
  });

  it("cuts a run where its label says, and refuses one that does not add up", () => {
    const frames = cutFrames(label([5, 7]), concat([jpeg(5, 1), jpeg(7, 2)]));
    expect(frames.map((f) => f.length)).toEqual([5, 7]);
    expect(() => cutFrames(label([5, 7]), concat([jpeg(5, 1), jpeg(6, 2)]))).toThrow(
      "the label's frames add up to 12 bytes and the run is 11",
    );
    expect(() => cutFrames(label([5, 7]), new Uint8Array(12))).toThrow("frame 0 does not start as a JPEG does");
  });

  it("writes a pair with its frames, lists it, and removes all of it", () => {
    dir = mkdtempSync(join(tmpdir(), "scanner-corpus-"));
    const run = concat([jpeg(5, 1), jpeg(7, 2)]);
    writePair(dir, "id1", new TextEncoder().encode(label([5, 7])), run);
    expect(localIds(dir)).toEqual(["id1"]);
    expect(readdirSync(join(dir, "frames", "id1"))).toEqual(["00.jpg", "01.jpg"]);
    expect(readFileSync(join(dir, "frames", "id1", "01.jpg"))).toEqual(Buffer.from(jpeg(7, 2)));
    removePair(dir, "id1");
    expect(localIds(dir)).toEqual([]);
    expect(existsSync(join(dir, "frames", "id1"))).toBe(false);
    expect(existsSync(join(dir, "runs", "id1.bin"))).toBe(false);
  });

  it("does not list a label whose run never landed", () => {
    dir = mkdtempSync(join(tmpdir(), "scanner-corpus-"));
    writePair(dir, "id1", new TextEncoder().encode(label([5])), jpeg(5, 1));
    rmSync(join(dir, "runs", "id1.bin"));
    expect(localIds(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run --project root scripts/scanner-corpus`
Expected: the two new files FAIL on a missing module.

- [ ] **Step 3: Implement the planner and the mirror**

`scripts/scanner-corpus/plan.ts`:

```ts
// What a sync has to do, from three listings and nothing else — so it is decided without a
// network, and tested without one. The executor is `scripts/scanner-corpus.ts`.

import type { Entry } from "./s3.ts";

export type Plan = {
  /** Ids to copy from the inbox to the corpus. */
  adopt: string[];
  /** Ids the mirror lacks. */
  fetch: string[];
  /** Local ids the corpus no longer holds — a deleted scan. */
  prune: string[];
  /** Inbox runs with no label: failed uploads. Reported, never touched. */
  litter: string[];
  /** Baseline keys the corpus holds. */
  baselinesDown: string[];
};

const RUN = /^runs\/(.+)\.bin$/;
const LABEL = /^labels\/(.+)\.json$/;

/** Complete pairs by id, with each object's size. */
export function pairs(entries: Entry[]): Map<string, { run: number; label: number }> {
  const runs = new Map<string, number>();
  const labels = new Map<string, number>();
  for (const { key, size } of entries) {
    const run = RUN.exec(key)?.[1];
    const label = LABEL.exec(key)?.[1];
    if (run) runs.set(run, size);
    if (label) labels.set(label, size);
  }
  const out = new Map<string, { run: number; label: number }>();
  for (const [id, run] of [...runs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const label = labels.get(id);
    if (label !== undefined) out.set(id, { run, label });
  }
  return out;
}

export function plan(listing: { inbox: Entry[]; corpus: Entry[]; local: string[] }): Plan {
  const inbox = pairs(listing.inbox);
  const corpus = pairs(listing.corpus);
  const local = new Set(listing.local);
  const adopt = [...inbox.keys()].filter((id) => !corpus.has(id));
  const held = new Set([...corpus.keys(), ...adopt]);
  return {
    adopt,
    fetch: [...held].filter((id) => !local.has(id)).sort(),
    prune: listing.local.filter((id) => !held.has(id)).sort(),
    litter: listing.inbox.flatMap(({ key }) => {
      const id = RUN.exec(key)?.[1];
      return id && !inbox.has(id) ? [id] : [];
    }),
    baselinesDown: listing.corpus.map((e) => e.key).filter((key) => key.startsWith("baselines/")),
  };
}

/** The adopted ids whose copy in the corpus is as long as the inbox's, object for object. */
export function drainable(adopted: string[], inbox: Entry[], corpusAfter: Entry[]): string[] {
  const from = pairs(inbox);
  const to = pairs(corpusAfter);
  return adopted.filter((id) => {
    const a = from.get(id);
    const b = to.get(id);
    return a !== undefined && b !== undefined && a.run === b.run && a.label === b.label;
  });
}
```

`scripts/scanner-corpus/mirror.ts`:

```ts
// The local copy of the scan corpus: `labels/<id>.json`, `runs/<id>.bin`, and each run cut
// into `frames/<id>/NN.jpg` for the report to draw. Readers' photographs — ignored by git,
// and kept in the main checkout so a worktree's removal cannot take them with it.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** `SCANNER_CORPUS_DIR`, else `.scanner-corpus/` beside the main checkout's `.git`. */
export function corpusDir(env: Record<string, string | undefined>, gitCommonDir: string): string {
  return env.SCANNER_CORPUS_DIR || join(dirname(gitCommonDir), ".scanner-corpus");
}

/** A run cut by its label, oldest frame first. The sentences are `card_scanner::replay::cut`'s. */
export function cutFrames(labelText: string, run: Uint8Array): Uint8Array[] {
  const lengths: number[] = (JSON.parse(labelText) as { run: { bytes: number }[] }).run.map((f) => f.bytes);
  const total = lengths.reduce((sum, n) => sum + n, 0);
  if (total !== run.length) {
    throw new Error(`the label's frames add up to ${total} bytes and the run is ${run.length}`);
  }
  let at = 0;
  return lengths.map((length, n) => {
    const frame = run.subarray(at, at + length);
    if (frame[0] !== 0xff || frame[1] !== 0xd8 || frame[2] !== 0xff) {
      throw new Error(`frame ${n} does not start as a JPEG does`);
    }
    at += length;
    return frame;
  });
}

export function writePair(dir: string, id: string, label: Uint8Array, run: Uint8Array): void {
  const frames = cutFrames(new TextDecoder().decode(label), run);
  for (const sub of ["labels", "runs", join("frames", id)]) mkdirSync(join(dir, sub), { recursive: true });
  frames.forEach((frame, n) => writeFileSync(join(dir, "frames", id, `${String(n).padStart(2, "0")}.jpg`), frame));
  writeFileSync(join(dir, "runs", `${id}.bin`), run);
  // The label last: `localIds` reads it as "this pair is whole".
  writeFileSync(join(dir, "labels", `${id}.json`), label);
}

export function removePair(dir: string, id: string): void {
  rmSync(join(dir, "labels", `${id}.json`), { force: true });
  rmSync(join(dir, "runs", `${id}.bin`), { force: true });
  rmSync(join(dir, "frames", id), { recursive: true, force: true });
}

/** Ids with both a label and a run on disk. */
export function localIds(dir: string): string[] {
  const labels = join(dir, "labels");
  if (!existsSync(labels)) return [];
  return readdirSync(labels)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => existsSync(join(dir, "runs", `${id}.bin`)))
    .sort();
}
```

- [ ] **Step 4: Write the CLI**

`scripts/scanner-corpus.ts`:

```ts
#!/usr/bin/env node
// Readers' scans, from the inbox to a corpus that lasts, and down to this machine.
//
//   pnpm scanner:corpus status         count what is where; changes nothing
//   pnpm scanner:corpus pull           copy new scans inbox → corpus, mirror the corpus here
//   pnpm scanner:corpus pull --drain   the same, then delete from the inbox what verified
//
// **The inbox holds 500 runs and expects to be emptied** (`infrastructure/scan-worker/
// README.md`); the corpus bucket is where a read scan lives after. `--drain` is the only
// thing here that deletes anything remote, it deletes only pairs whose copy this run has
// just read back at the same sizes, and it is the owner's to run — never an agent's unasked.
//
// **A scan deleted from the corpus bucket is deleted here on the next pull**, frames and all:
// that is how a deletion request is honoured. Baselines (`baselines/*.json`) go both ways.
//
// Credentials are `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, from the
// environment and nowhere else: an R2 API token with object read and write on the two buckets.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { corpusDir, localIds, removePair, writePair } from "./scanner-corpus/mirror.ts";
import { drainable, pairs, plan } from "./scanner-corpus/plan.ts";
import { createS3, type Fetch } from "./scanner-corpus/s3.ts";

const INBOX = "mtg-grimoire-scans";
const CORPUS = "mtg-grimoire-scan-corpus";

function fail(message: string): never {
  console.error(`scanner:corpus: ${message}`);
  process.exit(1);
}

const [command, ...flags] = process.argv.slice(2);
if (command !== "status" && command !== "pull") fail("say `status` or `pull` (`pull --drain` empties the inbox)");
const drain = flags.includes("--drain");

const missing = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"].filter((name) => !process.env[name]);
if (missing.length) fail(`set ${missing.join(", ")} — an R2 API token for ${INBOX} and ${CORPUS}`);

const s3 = createS3(
  {
    accountId: process.env.R2_ACCOUNT_ID!,
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  fetch as unknown as Fetch,
);
const gitCommonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
  encoding: "utf8",
}).trim();
const dir = corpusDir(process.env, gitCommonDir);

const listBoth = async (bucket: string) => [
  ...(await s3.list(bucket, "runs/")),
  ...(await s3.list(bucket, "labels/")),
];

const inbox = await listBoth(INBOX);
const corpus = [...(await listBoth(CORPUS)), ...(await s3.list(CORPUS, "baselines/"))];
const todo = plan({ inbox, corpus, local: localIds(dir) });

console.log(`inbox   ${pairs(inbox).size} scans, ${todo.litter.length} runs with no label`);
console.log(`corpus  ${pairs(corpus).size} scans, ${todo.baselinesDown.length} baselines`);
console.log(`here    ${localIds(dir).length} scans in ${dir}`);
if (command === "status") {
  console.log(`a pull would adopt ${todo.adopt.length}, fetch ${todo.fetch.length}, prune ${todo.prune.length}`);
  process.exit(0);
}

const failed: string[] = [];
for (const id of todo.adopt) {
  try {
    for (const key of [`runs/${id}.bin`, `labels/${id}.json`]) {
      await s3.put(CORPUS, key, await s3.get(INBOX, key));
    }
  } catch (error) {
    failed.push(`${id}: ${(error as Error).message}`);
  }
}
for (const id of todo.fetch) {
  try {
    writePair(dir, id, await s3.get(CORPUS, `labels/${id}.json`), await s3.get(CORPUS, `runs/${id}.bin`));
  } catch (error) {
    failed.push(`${id}: ${(error as Error).message}`);
  }
}
for (const id of todo.prune) removePair(dir, id);

// Baselines: down what the corpus has and this machine lacks, up what only this machine has.
const baselines = join(dir, "baselines");
mkdirSync(baselines, { recursive: true });
for (const key of todo.baselinesDown) {
  const path = join(baselines, basename(key));
  if (!existsSync(path)) writeFileSync(path, await s3.get(CORPUS, key));
}
const remote = new Set(todo.baselinesDown.map((key) => basename(key)));
for (const name of readdirSync(baselines).filter((n) => n.endsWith(".json") && !remote.has(n))) {
  await s3.put(CORPUS, `baselines/${name}`, readFileSync(join(baselines, name)));
}

console.log(`adopted ${todo.adopt.length}, fetched ${todo.fetch.length}, pruned ${todo.prune.length}`);
if (drain) {
  const verified = drainable(todo.adopt, inbox, await listBoth(CORPUS));
  for (const id of verified) {
    await s3.remove(INBOX, `labels/${id}.json`);
    await s3.remove(INBOX, `runs/${id}.bin`);
  }
  console.log(`drained ${verified.length} of ${todo.adopt.length} from the inbox`);
}
if (failed.length) fail(`${failed.length} did not copy:\n  ${failed.join("\n  ")}`);
```

Note the drain order: the label goes first, so a scan interrupted mid-delete is litter the inbox already knows how to name, never a label with no run.

- [ ] **Step 5: Wire it and run the tests**

`package.json`, beside `scanner:bench`: `"scanner:corpus": "node scripts/scanner-corpus.ts",`

`.gitignore`, after the `.scanner-bundle/` line:

```
# Readers' scans, mirrored from the corpus bucket by `pnpm scanner:corpus` — photographs,
# never committed. It sits in the main checkout; this line is for a `SCANNER_CORPUS_DIR`
# pointed inside one.
.scanner-corpus/
```

Run: `pnpm exec vitest run --project root scripts/scanner-corpus`
Expected: all pass.
Run: `node scripts/scanner-corpus.ts status` with the three variables unset.
Expected: exit 1, `scanner:corpus: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY — …`. Do not run it with real credentials.

---

### Task 5: The summary and the comparison

**Files:**
- Create: `scripts/scanner-replay/results.ts` (types), `scripts/scanner-replay/summary.ts`, `scripts/scanner-replay/fixture.ts`
- Test: `scripts/scanner-replay/summary.test.ts`

**Interfaces:**
- Consumes: Task 2's `results.json` schema.
- Produces:
  - `results.ts`: `type Score = "printing" | "card" | "wrong" | "undecided" | "error"`, and `Results`, `Run`, `Pass`, `Slice`, `FrameNow`, `FrameThen` matching the schema field for field; `parseResults(text: string): Results` (throws on `v !== 1`).
  - `summary.ts`:
    - `type Tally = { n: number; printing: number; card: number; wrong: number; undecided: number; error: number; ambiguous: number; medianFrames: number | null }`
    - `tally(runs: Run[], pass: string): Tally` — `card` counts printing and card together (right card), as `eval`'s table does; percentages are of `n - error`.
    - `breakdowns(runs: Run[]): { by: string; value: string; runs: Run[] }[]` — finish, platform, mode, detail.
    - `type Flip = { id: string; name: string; pass: string; from: Score; to: Score }`
    - `compare(now: Results, base: Results): { fixed: Flip[]; broken: Flip[]; moved: Flip[]; added: string[]; removed: string[] }` — fixed is to `printing` from anything else; broken is from `printing`; moved is any other change.
    - `summaryMarkdown(now: Results, base: Results | null): string`
    - `PASSES = ["As scanned", "Fast", "Exact"] as const`
  - `fixture.ts`: `results(runs: Partial<Run>[]): Results` and `run(over: Partial<Run> & { scores?: [Score, Score, Score] }): Run` for tests here and in Task 6.

- [ ] **Step 1: Write the types and the fixture**

`scripts/scanner-replay/results.ts`:

```ts
// `results.json`, as `crates/card-scanner/src/bin/replay.rs` writes it. The binary supplies
// these facts; every count and comparison drawn from them is `summary.ts`'s.

export type Score = "printing" | "card" | "wrong" | "undecided" | "error";
export type Mode = "fast" | "exact";
export type Card = { id: string; set: string; number: string; lang: string; name: string };
export type Got = { id: string; name: string | null; set: string | null; number: string | null };
export type FrameNow = {
  ok: boolean;
  lock: string | null;
  confidence: number | null;
  distance: number | null;
  decided: string | null;
};
export type FrameThen = { ms: number; ok: boolean; lock: string | null; decided: string | null; detail: boolean };
export type Slice = {
  frame: number;
  kind: "rectified" | "binary" | "title" | "collector";
  file: string;
  raw: string | null;
  normalized: string | null;
  matched: string | null;
};
export type Pass = {
  name: string;
  mode: Mode;
  score: Score;
  ambiguous: boolean;
  true_in_choices: boolean;
  got: Got | null;
  first_decision_frame: number | null;
  confidence: number | null;
  distance: number | null;
  frames: FrameNow[];
  tiers: { tier: string; survivors: number; detail: string }[];
  slices: Slice[];
  error: string | null;
};
export type Run = {
  id: string;
  received_at: string;
  card: Card;
  finish: string;
  platform: string;
  version: string;
  mode: Mode;
  filtered: boolean;
  detail: boolean;
  frames: number;
  known: boolean;
  then: { score: Score; got: string | null };
  decided_differs: number;
  then_frames: FrameThen[];
  passes: Pass[];
};
export type Results = {
  v: 1;
  commit: string | null;
  bundle_printings: number;
  runs: Run[];
  skipped: { id: string; why: string }[];
};

export function parseResults(text: string): Results {
  const results = JSON.parse(text) as Results;
  if (results.v !== 1) throw new Error(`results version ${String(results.v)} is not 1`);
  return results;
}
```

`scripts/scanner-replay/fixture.ts`:

```ts
// Invented results for the summary's and the report's suites. No real scan is in the tree.

import type { Pass, Results, Run, Score } from "./results.ts";

const NAMES = ["As scanned", "Fast", "Exact"];

export function pass(name: string, score: Score, over: Partial<Pass> = {}): Pass {
  return {
    name,
    mode: name === "Exact" ? "exact" : "fast",
    score,
    ambiguous: false,
    true_in_choices: false,
    got: score === "undecided" || score === "error" ? null : { id: `got-${score}`, name: "Shock", set: "m19", number: "156" },
    first_decision_frame: score === "undecided" || score === "error" ? null : 9,
    confidence: 0.8,
    distance: 33,
    frames: [{ ok: true, lock: "locked", confidence: 0.8, distance: 33, decided: null }],
    tiers: [],
    slices: [],
    error: score === "error" ? "the run broke" : null,
    ...over,
  };
}

export function run(over: Partial<Run> & { scores?: [Score, Score, Score] } = {}): Run {
  const { scores = ["printing", "printing", "printing"], ...rest } = over;
  return {
    id: "20261011T101500Z-0000000000000001",
    received_at: "2026-10-11T10:15:00.000Z",
    card: { id: "card-1", set: "2x2", number: "117", lang: "en", name: "Lightning Bolt" },
    finish: "nonfoil",
    platform: "desktop",
    version: "0.48.0",
    mode: "fast",
    filtered: false,
    detail: false,
    frames: 12,
    known: true,
    then: { score: "printing", got: "card-1" },
    decided_differs: 0,
    then_frames: [{ ms: 0, ok: true, lock: "locked", decided: null, detail: false }],
    passes: NAMES.map((name, i) => pass(name, scores[i])),
    ...rest,
  };
}

export function results(runs: Run[], over: Partial<Results> = {}): Results {
  return { v: 1, commit: "abc1234", bundle_printings: 113494, runs, skipped: [], ...over };
}
```

- [ ] **Step 2: Write the failing test**

`scripts/scanner-replay/summary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pass, results, run } from "./fixture.ts";
import { parseResults } from "./results.ts";
import { breakdowns, compare, summaryMarkdown, tally } from "./summary.ts";

const four = [
  run({ id: "a", scores: ["printing", "printing", "printing"] }),
  run({ id: "b", scores: ["card", "wrong", "printing"], finish: "foil" }),
  run({ id: "c", scores: ["wrong", "undecided", "undecided"], finish: "foil", platform: "android" }),
  run({ id: "d", scores: ["error", "error", "error"] }),
];

describe("the replay's summary", () => {
  it("counts a pass, with the right card holding the right printing", () => {
    expect(tally(four, "As scanned")).toMatchObject({ n: 4, printing: 1, card: 2, wrong: 1, undecided: 0, error: 1 });
    expect(tally(four, "Fast")).toMatchObject({ printing: 1, card: 1, wrong: 1, undecided: 1 });
  });

  it("takes the median of the frames a decision took, over the runs that decided", () => {
    const runs = [5, 9, 12].map((n, i) =>
      run({ id: String(i), passes: [pass("As scanned", "printing", { first_decision_frame: n })] }),
    );
    expect(tally(runs, "As scanned").medianFrames).toBe(9);
    expect(tally([run({ scores: ["undecided", "undecided", "undecided"] })], "Fast").medianFrames).toBeNull();
  });

  it("breaks the runs down by finish, platform, mode and detail", () => {
    const parts = breakdowns(four);
    const sizes = Object.fromEntries(parts.map((p) => [`${p.by}=${p.value}`, p.runs.length]));
    expect(sizes).toMatchObject({ "finish=foil": 2, "finish=nonfoil": 2, "platform=android": 1, "detail=no": 4 });
  });

  it("names every run that flipped against a baseline, by pass", () => {
    const base = results(four);
    const now = results([
      run({ id: "a", scores: ["wrong", "printing", "printing"] }),
      run({ id: "b", scores: ["printing", "wrong", "printing"], finish: "foil" }),
      run({ id: "c", scores: ["wrong", "card", "undecided"], finish: "foil" }),
      run({ id: "e" }),
    ]);
    const delta = compare(now, base);
    expect(delta.broken).toEqual([{ id: "a", name: "Lightning Bolt", pass: "As scanned", from: "printing", to: "wrong" }]);
    expect(delta.fixed).toEqual([{ id: "b", name: "Lightning Bolt", pass: "As scanned", from: "card", to: "printing" }]);
    expect(delta.moved).toEqual([{ id: "c", name: "Lightning Bolt", pass: "Fast", from: "undecided", to: "card" }]);
    expect(delta.added).toEqual(["e"]);
    expect(delta.removed).toEqual(["d"]);
  });

  it("writes a table whose percentages leave the errors out", () => {
    const text = summaryMarkdown(results(four, { skipped: [{ id: "z", why: "run: not found" }] }), null);
    expect(text).toContain("4 scans, 1 skipped");
    expect(text).toContain("| As scanned | 4 | 33.3 | 66.7 | 1 | 0.0 | 1 |");
    expect(text).toContain("commit `abc1234`");
    expect(text).not.toContain("Against");
  });

  it("says when a baseline ran against another bundle or another commit", () => {
    const base = results(four, { commit: "old0000", bundle_printings: 100 });
    const text = summaryMarkdown(results(four), base);
    expect(text).toContain("Against `old0000`");
    expect(text).toContain("another bundle (100 printings then, 113494 now)");
    expect(text).toContain("No scan changed.");
  });

  it("refuses results of another version", () => {
    expect(() => parseResults('{"v":2}')).toThrow("results version 2 is not 1");
  });
});
```

Run: `pnpm exec vitest run --project root scripts/scanner-replay`
Expected: FAIL, `./summary.ts` does not exist.

- [ ] **Step 3: Implement**

`scripts/scanner-replay/summary.ts`:

```ts
// Every count drawn from a replay's `results.json`, in one place: the table, the breakdowns
// and the comparison with a baseline. `summary.md` and the report both read these, so the
// two cannot count a scan differently.

import type { Results, Run, Score } from "./results.ts";

export const PASSES = ["As scanned", "Fast", "Exact"] as const;

export type Tally = {
  n: number;
  /** The reader's printing. */
  printing: number;
  /** The reader's card: its printing, or another printing of it. */
  card: number;
  wrong: number;
  undecided: number;
  /** Could not be replayed; left out of every percentage. */
  error: number;
  ambiguous: number;
  /** Frames to the first decision, over the runs that made one. */
  medianFrames: number | null;
};

export function tally(runs: Run[], pass: string): Tally {
  const out: Tally = { n: runs.length, printing: 0, card: 0, wrong: 0, undecided: 0, error: 0, ambiguous: 0, medianFrames: null };
  const frames: number[] = [];
  for (const run of runs) {
    const p = run.passes.find((candidate) => candidate.name === pass);
    if (!p) continue;
    if (p.score === "printing") out.printing += 1;
    if (p.score === "printing" || p.score === "card") out.card += 1;
    if (p.score === "wrong") out.wrong += 1;
    if (p.score === "undecided") out.undecided += 1;
    if (p.score === "error") out.error += 1;
    if (p.ambiguous) out.ambiguous += 1;
    if (p.first_decision_frame !== null) frames.push(p.first_decision_frame);
  }
  frames.sort((a, b) => a - b);
  if (frames.length) {
    const mid = frames.length >> 1;
    out.medianFrames = frames.length % 2 ? frames[mid] : (frames[mid - 1] + frames[mid]) / 2;
  }
  return out;
}

/** A share of the runs that replayed, to one decimal. */
export function percent(count: number, t: Tally): string {
  const of = t.n - t.error;
  return of ? ((100 * count) / of).toFixed(1) : "—";
}

export function breakdowns(runs: Run[]): { by: string; value: string; runs: Run[] }[] {
  const keys: [string, (run: Run) => string][] = [
    ["finish", (r) => r.finish],
    ["platform", (r) => r.platform],
    ["mode", (r) => r.mode],
    ["detail", (r) => (r.detail ? "yes" : "no")],
  ];
  return keys.flatMap(([by, of]) => {
    const groups = new Map<string, Run[]>();
    for (const run of runs) groups.set(of(run), [...(groups.get(of(run)) ?? []), run]);
    return [...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([value, group]) => ({ by, value, runs: group }));
  });
}

export type Flip = { id: string; name: string; pass: string; from: Score; to: Score };
export type Delta = { fixed: Flip[]; broken: Flip[]; moved: Flip[]; added: string[]; removed: string[] };

export function compare(now: Results, base: Results): Delta {
  const before = new Map(base.runs.map((run) => [run.id, run]));
  const delta: Delta = { fixed: [], broken: [], moved: [], added: [], removed: [] };
  for (const run of now.runs) {
    const old = before.get(run.id);
    if (!old) {
      delta.added.push(run.id);
      continue;
    }
    for (const p of run.passes) {
      const from = old.passes.find((candidate) => candidate.name === p.name)?.score;
      if (from === undefined || from === p.score) continue;
      const flip = { id: run.id, name: run.card.name, pass: p.name, from, to: p.score };
      (p.score === "printing" ? delta.fixed : from === "printing" ? delta.broken : delta.moved).push(flip);
    }
  }
  const held = new Set(now.runs.map((run) => run.id));
  delta.removed = base.runs.map((run) => run.id).filter((id) => !held.has(id));
  return delta;
}

const HEAD =
  "| pass | n | printing ✓ % | card ✓ % | wrong card | undecided % | errors | ambiguous | median frames |\n" +
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";

function row(name: string, runs: Run[], pass: string): string {
  const t = tally(runs, pass);
  return `| ${name} | ${t.n} | ${percent(t.printing, t)} | ${percent(t.card, t)} | ${t.wrong} | ${percent(t.undecided, t)} | ${t.error} | ${t.ambiguous} | ${t.medianFrames ?? "—"} |`;
}

const flips = (title: string, list: Flip[]) =>
  list.length ? [`**${title}** (${list.length})`, "", ...list.map((f) => `- ${f.name} — ${f.pass}: ${f.from} → ${f.to} (\`${f.id}\`)`), ""] : [];

export function summaryMarkdown(now: Results, base: Results | null): string {
  const lines = [
    "# Scanner replay",
    "",
    "Readers' scans, replayed: real frames, labelled by the reader who sent them. A replay starts",
    "with no earlier evidence and no detail pictures, so *then* is what the scanner said live.",
    "",
    `${now.runs.length} scans, ${now.skipped.length} skipped; commit \`${now.commit ?? "unknown"}\`, bundle of ${now.bundle_printings} printings.`,
    "",
    HEAD,
    ...PASSES.map((pass) => row(pass, now.runs, pass)),
    "",
  ];
  const then = now.runs.filter((run) => run.then.score === "printing").length;
  const differs = now.runs.filter((run) => run.decided_differs > 0).length;
  lines.push(`Then: the shipped scanner had the reader's printing on ${then} of ${now.runs.length}. ` +
    `${differs} replayed with a different decision on at least one frame.`, "");
  lines.push("## As scanned, by kind", "", HEAD.replace("| pass |", "| kind |"));
  for (const part of breakdowns(now.runs)) lines.push(row(`${part.by}: ${part.value}`, part.runs, "As scanned"));
  lines.push("");
  if (now.skipped.length) {
    lines.push("## Skipped", "", ...now.skipped.map((s) => `- \`${s.id}\` — ${s.why}`), "");
  }
  if (base) {
    const delta = compare(now, base);
    lines.push(`## Against \`${base.commit ?? "unknown"}\``, "");
    if (base.bundle_printings !== now.bundle_printings) {
      lines.push(`The baseline ran against another bundle (${base.bundle_printings} printings then, ${now.bundle_printings} now), so a change here may be the bundle's.`, "");
    }
    lines.push(...flips("Fixed", delta.fixed), ...flips("Broken", delta.broken), ...flips("Moved", delta.moved));
    if (!delta.fixed.length && !delta.broken.length && !delta.moved.length) lines.push("No scan changed.", "");
    if (delta.added.length) lines.push(`${delta.added.length} scans are new since the baseline.`, "");
    if (delta.removed.length) lines.push(`${delta.removed.length} scans of the baseline are gone.`, "");
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run to see them pass**

Run: `pnpm exec vitest run --project root scripts/scanner-replay`
Expected: 7 passed. In the table test, As scanned over `four` is 3 replayed: printing 1 (33.3), card 2 (66.7), wrong 1, undecided 0 (0.0), errors 1.

---

### Task 6: The report

**Files:**
- Create: `scripts/scanner-replay/report.ts`
- Test: `scripts/scanner-replay/report.test.ts`

**Interfaces:**
- Consumes: Task 5's `Results`, `Run`, `tally`, `percent`, `compare`, `PASSES`, and `fixture.ts`.
- Produces: `reportHtml(now: Results, base: Results | null, paths: { frames: string; slices: string }): string` — one self-contained document. `paths.frames` is the relative URL of the mirror's `frames/` from the report, `paths.slices` the prefix slice `file`s resolve against (both end without a slash; `""` for "beside the report").
- Also: `cardImage(id: string): string` — `https://cards.scryfall.io/normal/front/<a>/<b>/<id>.jpg`, from the id's first two characters.

- [ ] **Step 1: Write the failing test**

`scripts/scanner-replay/report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pass, results, run } from "./fixture.ts";
import { cardImage, reportHtml } from "./report.ts";

const paths = { frames: "../frames", slices: "." };

describe("the replay's report", () => {
  it("finds a card's picture from its id alone", () => {
    expect(cardImage("9f8a0c1d-2e3f-4a5b-8c7d-000000000001")).toBe(
      "https://cards.scryfall.io/normal/front/9/f/9f8a0c1d-2e3f-4a5b-8c7d-000000000001.jpg",
    );
  });

  it("draws a row a scan: its frames, what was expected, and what each pass matched instead", () => {
    const html = reportHtml(
      results([
        run({
          id: "scan-1",
          frames: 2,
          then_frames: [
            { ms: -110, ok: true, lock: "acquiring", decided: null, detail: false },
            { ms: 0, ok: true, lock: "locked", decided: null, detail: true },
          ],
          passes: [
            pass("As scanned", "wrong", { first_decision_frame: 2, got: { id: "bbbbbbbb-1", name: "Shock", set: "m19", number: "156" } }),
            pass("Fast", "printing"),
            pass("Exact", "undecided"),
          ],
        }),
      ]),
      null,
      paths,
    );
    expect(html).toContain('src="../frames/scan-1/00.jpg"');
    expect(html).toContain('src="../frames/scan-1/01.jpg"');
    expect(html).toContain('data-score="wrong"');
    expect(html).toContain("Shock");
    expect(html).toContain(cardImage("bbbbbbbb-1"));
    expect(html).toContain(cardImage("card-1"));
    expect(html.match(/class="frame[^"]*decided/g)).toHaveLength(1);
    expect(html).toContain("Nothing decided");
  });

  it("shows the slices the scanner cut, each band with what was read from it", () => {
    const html = reportHtml(
      results([
        run({
          id: "scan-1",
          passes: [
            pass("As scanned", "printing", {
              slices: [
                { frame: 9, kind: "rectified", file: "slices/scan-1/09-rectified.jpg", raw: null, normalized: null, matched: null },
                { frame: 9, kind: "binary", file: "slices/scan-1/09-binary.jpg", raw: null, normalized: null, matched: null },
                { frame: 10, kind: "title", file: "slices/scan-1/10-title.jpg", raw: "Lightnlng Bolt", normalized: "lightnlng bolt", matched: "card-1" },
              ],
            }),
            pass("Fast", "printing"),
            pass("Exact", "printing"),
          ],
        }),
      ]),
      null,
      paths,
    );
    expect(html).toContain('src="./slices/scan-1/10-title.jpg"');
    expect(html).toContain("Lightnlng Bolt");
    expect(html).toContain("Title band");
    expect(html).toContain("Black and white");
  });

  it("says so when a scan read no band", () => {
    expect(reportHtml(results([run()]), null, paths)).toContain("No title or collector band was read");
  });

  it("escapes a name, a read and an error, which are never markup", () => {
    const html = reportHtml(
      results([
        run({
          card: { id: "c", set: "s", number: "1", lang: "en", name: `<img src=x onerror=alert(1)> & "Co"` },
          passes: [
            // The slices drawn are the As scanned pass's, the first.
            pass("As scanned", "error", {
              error: "<script>bad()</script>",
              slices: [{ frame: 1, kind: "title", file: "a.jpg", raw: "</span><b>", normalized: null, matched: null }],
            }),
            pass("Fast", "printing"),
            pass("Exact", "printing"),
          ],
        }),
      ]),
      null,
      paths,
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>bad()");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;");
    expect(html).toContain("&lt;/span&gt;&lt;b&gt;");
  });

  it("marks what changed since a baseline and counts it in the tiles", () => {
    const base = results([run({ id: "a", scores: ["wrong", "printing", "printing"] }), run({ id: "b" })]);
    const now = results([run({ id: "a" }), run({ id: "b" })]);
    const html = reportHtml(now, base, paths);
    expect(html.match(/<article[^>]*data-changed="yes"/g)).toHaveLength(1);
    expect(html).toContain("wrong → printing");
    expect(html).toContain("+50.0");
  });

  it("is one document that asks nothing of a server", () => {
    const html = reportHtml(results([run()]), null, paths);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
  });
});
```

Run: `pnpm exec vitest run --project root scripts/scanner-replay/report`
Expected: FAIL, `./report.ts` does not exist.

- [ ] **Step 2: Implement**

`scripts/scanner-replay/report.ts`:

```ts
// The replay as a page: what every scan was expected to be, what each pass matched instead,
// the frames, and the pictures the scanner cut. One document, written beside the corpus and
// opened from disk — it draws readers' photographs from the local mirror and is not for
// publishing. Every word that came from a scan or a read is escaped on its way in.

import type { Pass, Results, Run, Score, Slice } from "./results.ts";
import { compare, PASSES, percent, tally, type Flip } from "./summary.ts";

const esc = (text: string | number | null | undefined) =>
  String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Scryfall's picture of a printing, from its id alone. */
export function cardImage(id: string): string {
  return `https://cards.scryfall.io/normal/front/${id[0]}/${id[1]}/${id}.jpg`;
}

const WORDS: Record<Score, string> = {
  printing: "Right printing",
  card: "Right card, other printing",
  wrong: "Wrong card",
  undecided: "Nothing decided",
  error: "Could not replay",
};
const SLICES: Record<Slice["kind"], string> = {
  rectified: "Rectified card",
  binary: "Black and white",
  title: "Title band",
  collector: "Collector band",
};

function tiles(now: Results, base: Results | null): string {
  return PASSES.map((name) => {
    const t = tally(now.runs, name);
    const was = base ? tally(base.runs, name) : null;
    const delta = (count: number, before: number | undefined) => {
      if (!was || before === undefined) return "";
      const of = (n: number, x: typeof t) => (x.n - x.error ? (100 * n) / (x.n - x.error) : 0);
      const d = of(count, t) - of(before, was);
      if (Math.abs(d) < 0.05) return "";
      return ` <span class="delta ${d > 0 ? "up" : "down"}">${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}</span>`;
    };
    return `<section class="tile"><h2>${esc(name)}</h2>
<p class="big">${percent(t.printing, t)}%${delta(t.printing, was?.printing)}</p><p class="what">right printing</p>
<dl><dt>Right card</dt><dd>${percent(t.card, t)}%${delta(t.card, was?.card)}</dd>
<dt>Wrong card</dt><dd>${t.wrong}</dd><dt>Undecided</dt><dd>${t.undecided}</dd>
<dt>Errors</dt><dd>${t.error}</dd><dt>Median frames</dt><dd>${t.medianFrames ?? "—"}</dd></dl></section>`;
  }).join("\n");
}

function filmstrip(run: Run, paths: { frames: string }): string {
  const decided = run.passes[0]?.first_decision_frame ?? null;
  return Array.from({ length: run.frames }, (_, n) => {
    const then = run.then_frames[n];
    const lock = run.passes[0]?.frames[n]?.lock ?? "none";
    const classes = ["frame", `lock-${esc(lock)}`, decided === n + 1 ? "decided" : "", then?.detail ? "detail" : ""];
    const title = `Frame ${n + 1}${then ? `, ${then.ms} ms` : ""}, lock ${lock}${then?.detail ? ", had a detail picture" : ""}`;
    const src = `${paths.frames}/${encodeURIComponent(run.id)}/${String(n).padStart(2, "0")}.jpg`;
    return `<img class="${classes.filter(Boolean).join(" ")}" loading="lazy" src="${esc(src)}" alt="" title="${esc(title)}">`;
  }).join("");
}

function matched(pass: Pass, run: Run): string {
  const chip = `<span class="chip" data-score="${pass.score}">${WORDS[pass.score]}${pass.ambiguous ? " (ambiguous)" : ""}</span>`;
  const figures = [
    pass.first_decision_frame === null ? null : `frame ${pass.first_decision_frame}`,
    pass.confidence === null ? null : `confidence ${pass.confidence.toFixed(2)}`,
    pass.distance === null ? null : `distance ${pass.distance}`,
  ].filter(Boolean).join(" · ");
  const picture = pass.got
    ? `<img class="card" loading="lazy" src="${esc(cardImage(pass.got.id))}" alt="">
<p class="name">${esc(pass.got.name ?? pass.got.id)}</p><p class="print">${esc(pass.got.set?.toUpperCase())} ${esc(pass.got.number)}</p>`
    : `<div class="card none">${pass.error ? esc(pass.error) : "—"}</div>`;
  const same = pass.got?.id.toLowerCase() === run.card.id.toLowerCase();
  return `<div class="pass${same ? " same" : ""}"><h4>${esc(pass.name)} <small>${esc(pass.mode)}</small></h4>${picture}${chip}<p class="figures">${esc(figures)}</p></div>`;
}

function slices(run: Run, paths: { slices: string }): string {
  const cut = run.passes[0]?.slices ?? [];
  const cells = cut.map((slice) => {
    const read = slice.raw === null ? "" : `<p class="read">read <q>${esc(slice.raw)}</q>${slice.matched ? ` → matched <code>${esc(slice.matched)}</code>` : " → matched nothing"}</p>`;
    return `<figure class="slice ${slice.kind}"><img loading="lazy" src="${esc(`${paths.slices}/${slice.file}`)}" alt="">
<figcaption>${SLICES[slice.kind]}, frame ${slice.frame}${read}</figcaption></figure>`;
  });
  if (!cut.some((slice) => slice.kind === "title" || slice.kind === "collector")) {
    cells.push(`<p class="none">No title or collector band was read on this scan.</p>`);
  }
  const tiers = run.passes.flatMap((pass) => pass.tiers.map((tier) => `<li><b>${esc(pass.name)}: ${esc(tier.tier)}</b> — ${tier.survivors} left. ${esc(tier.detail)}</li>`));
  return `<div class="slices">${cells.join("")}</div>${tiers.length ? `<ul class="tiers">${tiers.join("")}</ul>` : ""}`;
}

function row(run: Run, changes: Flip[], paths: { frames: string; slices: string }): string {
  const scores = run.passes.map((pass) => pass.score);
  const flags = [
    scores.includes("wrong") ? "wrong" : "",
    scores.includes("card") ? "card" : "",
    scores.includes("undecided") ? "undecided" : "",
    scores.includes("error") ? "error" : "",
  ].filter(Boolean).join(" ");
  const changed = changes.map((f) => `<li>${esc(f.pass)}: ${esc(f.from)} → ${esc(f.to)}</li>`).join("");
  return `<article class="run" data-flags="${flags}" data-changed="${changes.length ? "yes" : "no"}" data-search="${esc(`${run.card.name} ${run.id} ${run.card.set}`.toLowerCase())}">
<header><h3>${esc(run.card.name)} <small>${esc(run.card.set.toUpperCase())} ${esc(run.card.number)} · ${esc(run.finish)} · ${esc(run.platform)} ${esc(run.version)} · scanned in ${esc(run.mode)}${run.filtered ? ", filtered" : ""}${run.known ? "" : " · not in this card data"}</small></h3>
<p class="id"><code>${esc(run.id)}</code> · then: ${WORDS[run.then.score]}${run.decided_differs ? ` · ${run.decided_differs} frames replayed differently` : ""}</p>
${changed ? `<ul class="changed">${changed}</ul>` : ""}</header>
<div class="strip">${filmstrip(run, paths)}</div>
<div class="cards"><div class="pass expected"><h4>Expected</h4><img class="card" loading="lazy" src="${esc(cardImage(run.card.id))}" alt=""><p class="name">${esc(run.card.name)}</p><p class="print">${esc(run.card.set.toUpperCase())} ${esc(run.card.number)}</p></div>
${run.passes.map((pass) => matched(pass, run)).join("\n")}</div>
${slices(run, paths)}
</article>`;
}

const STYLE = `
:root{--bg:#f6f5f2;--panel:#fff;--ink:#1c1b19;--dim:#6b6860;--line:#dcd9d2;--good:#1f7a4d;--warn:#a86a00;--bad:#b3261e;--idle:#8a8780}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--panel:#211f1c;--ink:#ece9e2;--dim:#a29e94;--line:#38352f;--good:#58c08a;--warn:#e0a94a;--bad:#f0766c;--idle:#77736b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,sans-serif}
main{max-width:1280px;margin:0 auto;padding:24px 16px 80px}h1{font-size:22px;margin:0 0 4px}.meta{color:var(--dim);margin:0 0 20px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:20px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}.tile h2{font-size:13px;margin:0;color:var(--dim);font-weight:600}
.big{font-size:32px;font-weight:650;margin:4px 0 0;font-variant-numeric:tabular-nums}.what{margin:0 0 8px;color:var(--dim)}
dl{display:grid;grid-template-columns:1fr auto;gap:2px 12px;margin:0}dt{color:var(--dim)}dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}
.delta{font-size:13px;font-weight:600}.delta.up{color:var(--good)}.delta.down{color:var(--bad)}
.bar{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 0;background:var(--bg)}
.bar button{font:inherit;padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}
.bar button[aria-pressed=true]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.bar input{font:inherit;flex:1;min-width:180px;padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--ink)}
.run{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-top:12px}.run[hidden]{display:none}
.run h3{margin:0;font-size:16px}.run small{font-weight:400;color:var(--dim);font-size:12px}.id{margin:2px 0 0;color:var(--dim);font-size:12px}
.changed{margin:6px 0 0;padding:0 0 0 18px;color:var(--warn);font-weight:600}
.strip{display:flex;gap:4px;overflow-x:auto;padding:10px 0}.frame{height:84px;border-radius:4px;border-bottom:4px solid var(--idle);flex:none}
.frame.lock-acquiring{border-color:var(--warn)}.frame.lock-locked{border-color:var(--good)}.frame.decided{outline:3px solid var(--ink);outline-offset:1px}.frame.detail{border-top:3px dotted var(--dim)}
.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}@media (max-width:640px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
.pass h4{margin:0 0 6px;font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.04em}.pass h4 small{text-transform:none;letter-spacing:0}
.card{width:100%;aspect-ratio:488/680;border-radius:4.5%;background:var(--line);display:block;object-fit:cover}.card.none{display:grid;place-items:center;color:var(--dim);padding:8px;text-align:center;font-size:12px}
.name{margin:6px 0 0;font-weight:600}.print,.figures{margin:0;color:var(--dim);font-size:12px}
.chip{display:inline-block;margin-top:6px;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;color:#fff;background:var(--idle)}
.chip[data-score=printing]{background:var(--good)}.chip[data-score=card]{background:var(--warn)}.chip[data-score=wrong],.chip[data-score=error]{background:var(--bad)}
.slices{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
.slice{margin:0;max-width:100%}.slice img{display:block;max-width:100%;border:1px solid var(--line);border-radius:4px}.slice.rectified img,.slice.binary img{height:200px}.slice.title img,.slice.collector img{max-height:64px}
figcaption{font-size:12px;color:var(--dim);margin-top:4px}.read{margin:2px 0 0;color:var(--ink)}.none{color:var(--dim)}
.tiers{margin:10px 0 0;padding-left:18px;font-size:12px;color:var(--dim)}code{font-size:12px}`;

const SCRIPT = `
const runs=[...document.querySelectorAll('.run')],buttons=[...document.querySelectorAll('.bar button')],box=document.querySelector('.bar input'),count=document.querySelector('.count');
let filter='all';
function apply(){const q=box.value.trim().toLowerCase();let shown=0;for(const r of runs){const f=filter==='all'||(filter==='changed'?r.dataset.changed==='yes':r.dataset.flags.split(' ').includes(filter));const on=f&&(!q||r.dataset.search.includes(q));r.hidden=!on;if(on)shown++}count.textContent=shown+' of '+runs.length+' scans'}
for(const b of buttons)b.addEventListener('click',()=>{filter=b.dataset.filter;for(const o of buttons)o.setAttribute('aria-pressed',String(o===b));apply()});
box.addEventListener('input',apply);apply();`;

export function reportHtml(now: Results, base: Results | null, paths: { frames: string; slices: string }): string {
  const delta = base ? compare(now, base) : null;
  const changes = new Map<string, Flip[]>();
  for (const flip of delta ? [...delta.fixed, ...delta.broken, ...delta.moved] : []) {
    changes.set(flip.id, [...(changes.get(flip.id) ?? []), flip]);
  }
  const filters: [string, string][] = [
    ["all", "All"],
    ["wrong", "Wrong card"],
    ["card", "Wrong printing"],
    ["undecided", "Undecided"],
    ...(base ? ([["changed", "Changed since baseline"]] as [string, string][]) : []),
  ];
  const against = base ? ` · against <code>${esc(base.commit ?? "unknown")}</code>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scanner replay</title><style>${STYLE}</style></head><body><main>
<h1>Scanner replay</h1>
<p class="meta">${now.runs.length} scans, ${now.skipped.length} skipped · commit <code>${esc(now.commit ?? "unknown")}</code> · bundle of ${now.bundle_printings} printings${against}</p>
<div class="tiles">${tiles(now, base)}</div>
<div class="bar">${filters.map(([key, word], i) => `<button type="button" data-filter="${key}" aria-pressed="${i === 0}">${word}</button>`).join("")}
<input type="search" placeholder="Card name, set or scan id" aria-label="Search scans"><span class="count"></span></div>
${now.runs.map((run) => row(run, changes.get(run.id) ?? [], paths)).join("\n")}
</main><script>${SCRIPT}</script></body></html>`;
}
```

- [ ] **Step 3: Run to see them pass**

Run: `pnpm exec vitest run --project root scripts/scanner-replay`
Expected: all pass. In the baseline test As scanned goes from 1 of 2 to 2 of 2: `+50.0`.

---

### Task 7: `pnpm scanner:replay`, the docs, verify and the commit

**Files:**
- Create: `scripts/scanner-replay.ts`
- Modify: `package.json` (script), `docs/reference/card-scanner.md`, `infrastructure/scan-worker/README.md`, `docs/agent/RUNNING_AND_VERIFYING.md`

**Interfaces:**
- Consumes: `corpusDir` (Task 4), `parseResults` (Task 5), `summaryMarkdown` (Task 5), `reportHtml` (Task 6), the `replay` binary (Task 2).

- [ ] **Step 1: Write the wrapper**

`scripts/scanner-replay.ts`:

```ts
#!/usr/bin/env node
// Readers' scans, replayed through the card scanner — the table, and the page.
//
//   pnpm scanner:replay                          replay the whole mirror
//   pnpm scanner:replay --baseline first         and say what changed since `baselines/first.json`
//   pnpm scanner:replay --save-baseline first    keep this run's results as that baseline
//   pnpm scanner:replay --only "lightning bolt"  runs whose card name or id contains the text
//
// Also `--bundle <file>`, `--models <dir>`, `--corpus <corpus.db>` and `--jobs <n>`, each
// found in the main checkout when left out, and `--no-build`, which trusts the binary as it is.
//
// **Run `pnpm scanner:corpus pull` first**: this reads the local mirror and asks no network.
// It writes `out/results.json`, `out/summary.md` and `out/report.html` beside the corpus,
// with the pictures the scanner cut under `out/slices/`. None of it is for git: the report
// draws readers' photographs. Only the summary's table belongs in the reference document.
//
// The binary supplies facts (`crates/card-scanner/src/bin/replay.rs`); every count here is
// `scripts/scanner-replay/summary.ts`'s, which the summary and the page both read.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { corpusDir } from "./scanner-corpus/mirror.ts";
import { reportHtml } from "./scanner-replay/report.ts";
import { parseResults } from "./scanner-replay/results.ts";
import { summaryMarkdown } from "./scanner-replay/summary.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNER = join(ROOT, "crates/card-scanner");
const TARGET_DIR = join(SCANNER, "target");
const EXE = process.platform === "win32" ? ".exe" : "";

function fail(message: string): never {
  console.error(`scanner:replay: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const value = (flag: string) => {
  const at = argv.indexOf(flag);
  return at < 0 ? null : (argv[at + 1] ?? fail(`${flag} needs a value`));
};
const every = (flag: string) => argv.flatMap((arg, i) => (arg === flag && argv[i + 1] ? [argv[i + 1]] : []));

const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const main = dirname(git("rev-parse", "--path-format=absolute", "--git-common-dir"));
const dir = corpusDir(process.env, join(main, ".git"));
if (!existsSync(join(dir, "labels"))) fail(`no scans in ${dir} — run \`pnpm scanner:corpus pull\` first`);

/** The first of these that exists, in this checkout and then the main one. */
function find(what: string, flag: string, candidates: string[]): string {
  const given = value(flag);
  if (given) return existsSync(given) ? given : fail(`${flag} ${given} does not exist`);
  for (const base of [ROOT, main]) {
    for (const candidate of candidates) {
      if (existsSync(join(base, candidate))) return join(base, candidate);
    }
  }
  return fail(`no ${what} found — pass ${flag}`);
}

/** The newest `card-hashes-v<n>.bin` in a `.scanner-bundle/`. */
function bundles(): string[] {
  return [ROOT, main].flatMap((base) => {
    const folder = join(base, ".scanner-bundle");
    if (!existsSync(folder)) return [];
    return readdirSync(folder)
      .filter((name) => /^card-hashes-v\d+\.bin$/.test(name))
      .sort((a, b) => Number(/\d+/.exec(b)![0]) - Number(/\d+/.exec(a)![0]))
      .map((name) => join(".scanner-bundle", name));
  });
}

const bundle = find("scanner bundle", "--bundle", bundles());
const models = find("OCR models", "--models", [".scanner-bundle/models"]);
const corpus = find("corpus.db", "--corpus", ["target/debug/data/corpus.db", "src-tauri/target/debug/data/corpus.db"]);
const out = join(dir, "out");

const cargo = ["--manifest-path", join(SCANNER, "Cargo.toml"), "--target-dir", TARGET_DIR, "--release", "--features", "builder", "--bin", "replay"];
if (!argv.includes("--no-build")) {
  const built = spawnSync("cargo", ["build", "--locked", ...cargo], { cwd: ROOT, stdio: "inherit" });
  if (built.status !== 0) fail("the replay binary did not build");
}

// Last run's slices would outlive a scan that no longer cuts them.
rmSync(join(out, "slices"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const jobs = value("--jobs");
const ran = spawnSync(
  join(TARGET_DIR, "release", `replay${EXE}`),
  [
    "--corpus-dir", dir, "--bundle", bundle, "--corpus", corpus, "--models", models, "--out", out,
    "--commit", git("rev-parse", "--short", "HEAD") + (git("status", "--porcelain", "--", "crates/card-scanner") ? "+dirty" : ""),
    ...every("--only").flatMap((text) => ["--only", text]),
    ...(jobs ? ["--jobs", jobs] : []),
  ],
  { cwd: ROOT, stdio: "inherit" },
);
if (ran.status !== 0) fail("the replay did not finish");

const now = parseResults(readFileSync(join(out, "results.json"), "utf8"));
const baselines = join(dir, "baselines");
const named = value("--baseline");
const base = named
  ? parseResults(readFileSync(existsSync(join(baselines, `${named}.json`)) ? join(baselines, `${named}.json`) : fail(`no baseline ${named} in ${baselines}`), "utf8"))
  : null;

const summary = summaryMarkdown(now, base);
writeFileSync(join(out, "summary.md"), summary);
writeFileSync(join(out, "report.html"), reportHtml(now, base, { frames: "../frames", slices: "." }));
const save = value("--save-baseline");
if (save) {
  mkdirSync(baselines, { recursive: true });
  copyFileSync(join(out, "results.json"), join(baselines, `${save}.json`));
}

console.log(summary);
console.log(`summary  ${join(out, "summary.md")}`);
console.log(`report   ${pathToFileURL(join(out, "report.html")).href}`);
if (save) console.log(`baseline ${join(baselines, `${save}.json`)} — \`pnpm scanner:corpus pull\` puts it in the corpus bucket`);
```

`package.json`, beside `scanner:corpus`: `"scanner:replay": "node scripts/scanner-replay.ts",`

- [ ] **Step 2: Prove the whole path on an invented scan**

No real scan exists on this machine, so make one from the main checkout's own files and replay it. In the scratchpad, write a throwaway Node script that:

1. takes a `SCANNER_CORPUS_DIR` under the scratchpad;
2. builds 12 JPEG frames of one real card — run `cargo run --release --features builder --bin bench-prep` (see its `--help`) for frames, or encode Scryfall's `display` image of a known printing onto a plain background at 960 px;
3. writes `labels/<id>.json` (the schema of `infrastructure/scan-worker/README.md`, `card.id` the printing's real Scryfall id) and `runs/<id>.bin`, then cuts frames with `writePair`.

Then run: `SCANNER_CORPUS_DIR=<that dir> pnpm scanner:replay --save-baseline trial` and again with `--baseline trial`.
Expected: a table of 1 scan; the second run says `No scan changed.`; `out/report.html` exists. Open it in the browser pane (`file://` URL), check the row draws the frames, the expected card, three passes and the slice strip, in both colour schemes and at phone width. Delete the scratch directory after.

If a session cannot be built because the main checkout has no `corpus.db`, say so in the final report rather than inventing one: the Rust and Vitest suites still hold each half.

- [ ] **Step 3: Write the docs**

- `docs/reference/card-scanner.md`:
  - the tools table in §1: a `replay` row, feature `builder`, "Readers' scans replayed and scored (§10, *The replay*). Added 2026-10-13."
  - a new `### The replay` section directly after *The synthetic evaluation*'s end (before `### Measured in the app`), covering: what it is and that it is the real-footage sibling of `eval`; the three passes; how a pass is judged (the last frame's decision) and the five scores; *then* and `decided_differs` and the three ways a replay is not the scan; the slices kept and that keeping them changes no decision (name the test); where the corpus lives and that nothing of it enters git; the two commands; and a `**Baseline**` paragraph reading "None yet: no scan had been pulled when this was written. The first `pnpm scanner:replay --save-baseline` table goes here, with its date, commit and bundle."
  - in *Where the working files sit*: a `.scanner-corpus/` row (main checkout, ignored).
- `infrastructure/scan-worker/README.md`, *Reading the inbox*: lead with `pnpm scanner:corpus pull` / `--drain` and the corpus bucket `mtg-grimoire-scan-corpus` as where a read scan goes; keep the hand recipe below as the fallback; add the bucket's creation and the token to *What only the owner does* as a separate short list ("for the corpus").
- `docs/agent/RUNNING_AND_VERIFYING.md`: the two commands in the command catalog, with "never run `scanner:corpus pull` unasked".

Read each file's neighbouring sections first and match their voice and line width (100 columns).

- [ ] **Step 4: Verify and commit**

Run: `pnpm verify` (once; see the `worktree-setup` skill if a suite fails on `node_modules`).
Run: `cargo test --manifest-path crates/card-scanner/Cargo.toml --target-dir crates/card-scanner/target --features builder --bins` (CI's line; `verify` runs `cli` only).
Expected: both green.

```bash
git add -A
git commit -m "feat(scanner): replay readers' scans and report what matched"
```

with a body naming the three commands, the corpus bucket the owner creates, and that no baseline is recorded yet. End with the `Co-Authored-By` line.

---

## Self-review notes

- Spec coverage: sync (Tasks 3–4), replay and slices (Tasks 1–2), then-vs-now and breakdowns (Tasks 2, 5), summary and baseline (Task 5), report (Task 6), wrapper, docs and privacy (Task 7). `--bulk` is accepted by `replay` and refused with a sentence: the spec lists it and only `eval`'s CI use needs it, so reading labels from a bulk file is left out until something runs replay where there is no `corpus.db`.
- The spec's "shared with `eval`" is `bin/support/labels.rs`, included by path in both.
- `results.json` field names in Task 2's Rust, Task 5's types and Task 6's reads were checked against each other: `first_decision_frame`, `true_in_choices`, `decided_differs`, `then_frames`, `bundle_printings`.
