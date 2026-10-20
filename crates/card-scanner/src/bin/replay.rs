//! `replay` — readers' scans, put back through the scanner and scored.
//!
//! **Real frames, where `eval`'s are synthetic.** A supporter's Send stores the last two
//! seconds of frames the scanner judged beside the printing the reader says they show
//! (`infrastructure/scan-worker/README.md`). This feeds each run to fresh sessions and writes
//! what they came to, as facts: `results.json`, and the pictures the scanner cut along the way.
//! The table, the comparison with a baseline and the page are `scripts/scanner-replay.ts`'s.
//!
//! ```text
//! replay --corpus-dir .scanner-corpus --bundle card-hashes.bin --corpus corpus.db
//!        --models models --out <dir> [--commit <sha>] [--only <text>]... [--jobs N]
//! ```
//!
//! **Four passes a run, a fresh [`Session`] each**: as it was scanned (the label's mode and
//! filters), Fast unfiltered, Exact unfiltered, Neural unfiltered. Every frame is fed, in order,
//! and a pass is judged on the decision the session holds on the last one — the label names the
//! card in the last frame, and `scanner.reported` is that frame's own decision too.
//!
//! **The Neural pass ages its votes by the label's own frame times** (`run[].ms`), not by how
//! fast this machine decodes: its agreement reads the session's clock, and the replay installs
//! one ([`host::set_clock`]) that answers the label's time while a Neural pass feeds the thread
//! and the wall clock otherwise. Its models are `crates/card-neural/models/`, or
//! `--neural-models`; a replay with none loaded ([`Ingredients::neural`], the tests) has three
//! passes.
//!
//! **What a pass reports beyond its score**: `first_decision_frame` and `decision_frame` (the
//! frame the last decision was made on, 1-based; the score is the decision held on the last
//! frame, so a card lost before it leaves `undecided` beside the earlier decision these name)
//! with `decisions` (how many were made);
//! `locked_frames`; and `resolve_ran`, because Exact resolves only after steady locked frames
//! and detail frames, which a short replay may never reach — a pass that never resolved is
//! not a pass that disagreed. A frame the scanner failed on (a panic, an undecodable JPEG, a
//! failed resolve) carries `error`, and its pass scores `error` rather than `undecided`.
//!
//! **A replay is not the scan**, three ways the inbox documents: nothing from before the first
//! frame, no detail pictures, and the developer sliders at their defaults. `then` and
//! `decided_differs` are how far that moved an answer, apart from any change to the scanner.
//!
//! **No wall clock decides anything**: the resolve runs inside its frame ([`ResolveOn::Inline`]),
//! the Neural agreement reads the label's times, so a run answers the same on a loaded machine
//! and frames are fed as fast as they decode.

use card_scanner::host;
use card_scanner::index::{format_uuid, parse_uuid, Bundle, ID_LEN};
use card_scanner::ocr::TitleReader;
use card_scanner::reference::Reference;
use card_scanner::replay::{cut, parse_label, score, ScanLabel, Score};
use card_scanner::resolve::TierView;
use card_scanner::session::{
    CollectorTry, FrameOptions, Outcome, ResolveOn, ScanMode, Session, Verdict,
};
use clap::Parser;
use serde::Serialize;
use std::borrow::Cow;
use std::cell::Cell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

#[path = "support/ab.rs"]
mod ab;
#[path = "support/labels.rs"]
mod labels;
use labels::{attach, labels_agree, open_corpus, rows_from_corpus, LabelRow};

/// Candidates per frame — the app's default.
const TOP: usize = 5;
const SCHEMA: u32 = 1;

#[derive(Parser, Debug)]
#[command(name = "replay", about = "Readers' scans, replayed through the card scanner")]
struct Args {
    /// The local mirror: `labels/<id>.json` beside `runs/<id>.bin`.
    #[arg(long)]
    corpus_dir: PathBuf,
    #[arg(long)]
    bundle: PathBuf,
    /// The app's `corpus.db`, for labels. Opened read-only.
    #[arg(long)]
    corpus: PathBuf,
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
    /// The Neural mode's four files. `crates/card-neural/models/` of this checkout when not
    /// given — they are in git.
    #[arg(long)]
    neural_models: Option<PathBuf>,
}

/// `crates/card-neural/models/` beside this crate — where the Neural mode's files are in git.
fn neural_models_in_tree() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../card-neural/models"))
}

thread_local! {
    /// Where the Neural pass feeding this thread is in its run: the label's milliseconds since
    /// its first frame. `None` outside a pass — and on every thread a pass did not start, which
    /// is every thread a frame of Fast or Exact fans its work out to.
    static LABEL_MS: Cell<Option<f64>> = const { Cell::new(None) };
}

/// The replay's clock ([`host::set_clock`]): the label's frame time while a Neural pass feeds this
/// thread, the wall clock otherwise — so Fast's and Exact's timings stay what they measure.
fn replay_clock() -> f64 {
    LABEL_MS.with(Cell::get).unwrap_or_else(|| {
        static ORIGIN: OnceLock<std::time::Instant> = OnceLock::new();
        ORIGIN.get_or_init(std::time::Instant::now).elapsed().as_secs_f64() * 1000.0
    })
}

/// The label's frame times on this thread, for as long as it lives: 0 when it starts — before the
/// session is built, because the Neural agreement's clock starts when its models load — and then
/// whatever [`label_time`] says, until it is dropped.
struct LabelClock;

impl LabelClock {
    /// Refused when another clock was installed first: the pass would then age its votes by
    /// this machine's speed, and say nothing about it.
    fn start() -> Result<LabelClock, String> {
        host::set_clock(replay_clock);
        let clock = LabelClock;
        LABEL_MS.with(|ms| ms.set(Some(0.0)));
        let probe = host::Stopwatch::start();
        LABEL_MS.with(|ms| ms.set(Some(1.0)));
        let read = probe.ms();
        LABEL_MS.with(|ms| ms.set(Some(0.0)));
        if read == 1.0 {
            Ok(clock)
        } else {
            Err("the replay's clock is not the one installed, so a Neural pass cannot read the \
                 label's frame times"
                .to_string())
        }
    }
}

impl Drop for LabelClock {
    fn drop(&mut self) {
        LABEL_MS.with(|ms| ms.set(None));
    }
}

/// Move this thread's label clock to `ms` — only while a [`LabelClock`] lives on it.
fn label_time(ms: f64) {
    LABEL_MS.with(|at| {
        if at.get().is_some() {
            at.set(Some(ms));
        }
    });
}

/// What a session is built from, loaded once and shared by every worker.
struct Ingredients {
    bundle: Vec<u8>,
    labels: Vec<LabelRow>,
    /// Both `None` builds a session that reads no text — what the tests use.
    detection: Option<Vec<u8>>,
    recognition: Option<Vec<u8>>,
    oracles: HashMap<[u8; ID_LEN], [u8; ID_LEN]>,
    /// The Neural mode's files. `None` replays no Neural pass — what most tests use.
    neural: Option<card_scanner::neural::Files<'static>>,
}

impl Ingredients {
    /// A session for one pass: a Neural one with its models loaded, which costs a load each and
    /// is why the other modes go without.
    fn session_for(&self, mode: ScanMode) -> Result<Session, String> {
        let mut session = self.session()?;
        if let (ScanMode::Neural, Some(f)) = (mode, &self.neural) {
            let files = card_scanner::neural::Files {
                detector: Cow::Borrowed(&f.detector),
                embedder: Cow::Borrowed(&f.embedder),
                gallery: Cow::Borrowed(&f.gallery),
                meta: Cow::Borrowed(&f.meta),
            };
            session.load_neural(files).map_err(|e| format!("neural: {e}"))?;
        }
        Ok(session)
    }

    fn session(&self) -> Result<Session, String> {
        let bundle = Bundle::from_bytes(&self.bundle).map_err(|e| format!("bundle: {e}"))?;
        let mut reference = Reference::new(bundle);
        attach(&mut reference, &self.labels);
        let reader = match (&self.detection, &self.recognition) {
            (Some(d), Some(r)) => Some(TitleReader::from_bytes(d, r)?),
            _ => None,
        };
        let mut session = Session::new(Some(reference), reader, TOP);
        session.set_resolve_on(ResolveOn::Inline);
        // The measured switches, from the environment — see support/ab.rs.
        ab::apply(&mut session);
        Ok(session)
    }

    fn reference(&self) -> Result<Reference, String> {
        let bundle = Bundle::from_bytes(&self.bundle).map_err(|e| format!("bundle: {e}"))?;
        let mut reference = Reference::new(bundle);
        attach(&mut reference, &self.labels);
        Ok(reference)
    }

    fn oracle_of(&self, printing: &str) -> Option<String> {
        parse_uuid(printing).and_then(|id| self.oracles.get(&id)).map(format_uuid)
    }

    fn knows(&self, printing: &str) -> bool {
        parse_uuid(printing).is_some_and(|id| self.labels.iter().any(|l| l.id == id))
    }
}

/// One of the passes.
struct Pass {
    name: &'static str,
    mode: ScanMode,
    /// The label's filters, or none.
    filtered: bool,
    /// Keep the pictures the scanner cut. The As scanned pass alone.
    slices: bool,
}

const AS_SCANNED: &str = "As scanned";

/// The passes a run gets: Neural's only when its models are loaded.
fn passes(label: &ScanLabel, neural: bool) -> Vec<Pass> {
    let mut passes = vec![
        Pass { name: AS_SCANNED, mode: label.scanner.mode, filtered: true, slices: true },
        Pass { name: "Fast", mode: ScanMode::Fast, filtered: false, slices: false },
        Pass { name: "Exact", mode: ScanMode::Exact, filtered: false, slices: false },
    ];
    if neural {
        passes.push(NEURAL_PASS);
    }
    passes
}

const NEURAL_PASS: Pass =
    Pass { name: "Neural", mode: ScanMode::Neural, filtered: false, slices: false };

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
    /// Only a failure of the scanner on this frame — never "no card in this frame".
    error: Option<String>,
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
    /// The (set, number) pairings the collector line was tried against. Collector slices only.
    tried: Vec<CollectorTry>,
    more: usize,
    /// The finish mark, as the crate serialises it. Collector slices only.
    mark: Option<serde_json::Value>,
    /// Title slices only.
    edits: Option<u32>,
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
    /// 1-based. The frame the first decision was made on.
    first_decision_frame: Option<usize>,
    /// 1-based. The frame the last decision was made on. The score is the decision held on
    /// the *last* frame, so when the card is lost and the decision dropped it is `undecided`
    /// while this, `decisions` and the pictures still describe the decision that was lost.
    decision_frame: Option<usize>,
    /// The final `decision_seq`.
    decisions: u64,
    /// Fast and Neural always — neither waits for anything before it can decide; Exact once any
    /// frame carried a resolution.
    resolve_ran: bool,
    locked_frames: usize,
    confidence: Option<f32>,
    distance: Option<f32>,
    frames: Vec<FrameOut>,
    tiers: Vec<TierView>,
    slices: Vec<Slice>,
    error: Option<String>,
}

impl PassOut {
    fn new(pass: &Pass, frames: usize) -> PassOut {
        PassOut {
            name: pass.name,
            mode: pass.mode,
            score: Score::Undecided,
            ambiguous: false,
            true_in_choices: false,
            got: None,
            first_decision_frame: None,
            decision_frame: None,
            decisions: 0,
            resolve_ran: pass.mode != ScanMode::Exact,
            locked_frames: 0,
            confidence: None,
            distance: None,
            frames: Vec::with_capacity(frames),
            tiers: Vec::new(),
            slices: Vec::new(),
            error: None,
        }
    }
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
        error: v.failure().map(str::to_string),
    }
}

/// A kept picture and the 1-based frame it came from.
type Picture = Option<(usize, String)>;

/// Feed every frame of a run to a fresh session and say what it held at the end.
fn run_pass(
    session: &mut Session,
    pass: &Pass,
    label: &ScanLabel,
    frames: &[&[u8]],
    truth_oracle: Option<&str>,
    oracle_of: impl Fn(&str) -> Option<String>,
) -> PassOut {
    let mut out = PassOut::new(pass, frames.len());
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
    // The pictures kept are the rectified card and the black and white image: those of the
    // frame the last decision was made on (else the latest before it that has one), and with
    // no decision at all, the latest with a card. Only the two data URIs are held.
    let (mut rect, mut binary): (Picture, Picture) = (None, None);
    let mut at_decision: Option<(Picture, Picture)> = None;
    let mut failure: Option<String> = None;
    let mut seq = 0u64;
    let mut last: Option<Verdict> = None;
    let first_ms = label.run.first().map_or(0, |f| f.ms);
    for (i, jpeg) in frames.iter().enumerate() {
        // The frame's own time, for a Neural pass's agreement (see `LabelClock`).
        if pass.mode == ScanMode::Neural {
            label_time(label.run.get(i).map_or(0, |f| f.ms).saturating_sub(first_ms) as f64);
        }
        let v = session.frame(jpeg, &opts);
        let n = i + 1;
        if let Some(msg) = v.failure() {
            failure.get_or_insert_with(|| format!("frame {n}: {msg}"));
        }
        if pass.slices {
            if let Some(uri) = &v.rectified {
                rect = Some((n, uri.clone()));
            }
            if let Some(uri) = v.stages.as_ref().and_then(|s| s.binary.as_ref()) {
                binary = Some((n, uri.clone()));
            }
        }
        if v.decision_seq > seq {
            seq = v.decision_seq;
            out.decision_frame = Some(n);
            out.first_decision_frame.get_or_insert(n);
            if pass.slices {
                at_decision = Some((rect.clone(), binary.clone()));
            }
        }
        if v.resolution.is_some() {
            out.resolve_ran = true;
        }
        if let Some(r) = &v.resolution {
            out.tiers = r.tiers.clone();
        }
        if pass.slices {
            if let Some(o) = &v.ocr {
                if let Some(band) = o.band.clone() {
                    let mut s = slice(label, n, "title", band);
                    s.raw = Some(o.raw.clone());
                    s.normalized = Some(o.normalized.clone());
                    s.matched = o.matched.clone();
                    s.edits = o.edits;
                    out.slices.push(s);
                }
            }
            if let Some(c) = &v.collector {
                if let Some(band) = c.band.clone() {
                    let mut s = slice(label, n, "collector", band);
                    s.raw = Some(c.raw.clone());
                    s.matched = c.matched.clone();
                    s.tried = c.tried.clone();
                    s.more = c.more;
                    let mark = c.mark.as_ref().or(v.decision.as_ref().and_then(|d| d.finish_mark.as_ref()));
                    s.mark = mark.and_then(|m| serde_json::to_value(m).ok());
                    out.slices.push(s);
                }
            }
        }
        let frame = frame_out(&v);
        if frame.lock.as_deref() == Some("locked") {
            out.locked_frames += 1;
        }
        out.frames.push(frame);
        last = Some(v);
    }
    if pass.slices {
        let (rect, binary) = at_decision.unwrap_or((rect, binary));
        let mut front = Vec::new();
        if let Some((n, uri)) = rect {
            front.push(slice(label, n, "rectified", uri));
        }
        if let Some((n, uri)) = binary {
            front.push(slice(label, n, "binary", uri));
        }
        front.append(&mut out.slices);
        out.slices = front;
    }
    out.decisions = seq;
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
    if failure.is_some() {
        out.score = Score::Error;
        out.error = failure;
    }
    out
}

fn slice(label: &ScanLabel, frame: usize, kind: &'static str, data_uri: String) -> Slice {
    Slice {
        frame,
        kind,
        file: format!("slices/{}/{frame:02}-{kind}.jpg", label.id),
        raw: None,
        normalized: None,
        matched: None,
        tried: Vec::new(),
        more: 0,
        mark: None,
        edits: None,
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
    /// `None` when the As scanned pass failed or fed a different number of frames.
    decided_differs: Option<usize>,
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

/// Do two decisions name one printing? Ids compare ignoring ASCII case.
fn same_decision(a: &Option<String>, b: &Option<String>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
        _ => false,
    }
}

/// One pass from a fresh session — a Neural one on the label's clock, started before its models
/// load (see [`LabelClock`]).
fn replay_pass(
    pass: &Pass,
    label: &ScanLabel,
    frames: &[&[u8]],
    ingredients: &Ingredients,
    truth_oracle: Option<&str>,
) -> PassOut {
    let built = (pass.mode == ScanMode::Neural)
        .then(LabelClock::start)
        .transpose()
        .and_then(|clock| ingredients.session_for(pass.mode).map(|session| (clock, session)));
    match built {
        Ok((_clock, mut session)) => run_pass(&mut session, pass, label, frames, truth_oracle,
            |p| ingredients.oracle_of(p)),
        Err(e) => {
            let mut out = PassOut::new(pass, 0);
            out.score = Score::Error;
            out.error = Some(e);
            out
        }
    }
}

fn replay_run(label: &ScanLabel, frames: &[&[u8]], ingredients: &Ingredients) -> RunOut {
    let truth_oracle = ingredients.oracle_of(&label.card.id);
    let passes: Vec<PassOut> = passes(label, ingredients.neural.is_some())
        .iter()
        .map(|pass| replay_pass(pass, label, frames, ingredients, truth_oracle.as_deref()))
        .collect();
    let reported = label.scanner.reported.as_deref();
    let then = Then {
        score: score(&label.card.id, truth_oracle.as_deref(), reported,
            reported.and_then(|p| ingredients.oracle_of(p)).as_deref()),
        got: label.scanner.reported.clone(),
    };
    let scanned = &passes[0];
    let decided_differs = (scanned.score != Score::Error
        && scanned.frames.len() == label.run.len())
    .then(|| {
        label.run.iter().zip(&scanned.frames)
            .filter(|(then, now)| !same_decision(&then.decided, &now.decided))
            .count()
    });
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

/// A label that read and whose run cut cleanly, with where its run is. The bytes are read
/// again by the worker that replays it, so the mirror is never held whole.
type Ready = (ScanLabel, PathBuf);

/// Every label in the mirror with where its run is, or why not. Sorted by file name, which is
/// by arrival.
fn read_corpus(dir: &Path) -> Result<Vec<Result<Ready, Skipped>>, String> {
    let labels = dir.join("labels");
    let mut files: Vec<(String, bool)> = std::fs::read_dir(&labels)
        .map_err(|e| format!("cannot read {}: {e}", labels.display()))?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let lossy = name.to_string_lossy().into_owned();
            lossy.ends_with(".json").then(|| (lossy, name.to_str().is_some()))
        })
        .collect();
    files.sort();
    Ok(files
        .into_iter()
        .map(|(file, utf8)| {
            let id = file.strip_suffix(".json").unwrap_or(&file).to_string();
            let skip = |why: String| Skipped { id: id.clone(), why };
            if !utf8 {
                return Err(skip("the label's file name is not UTF-8".to_string()));
            }
            let text = std::fs::read_to_string(labels.join(&file))
                .map_err(|e| skip(format!("label: {e}")))?;
            let label = parse_label(&text).map_err(skip)?;
            if label.id != id {
                return Err(skip("the label's id is not its file's name".to_string()));
            }
            let path = dir.join("runs").join(format!("{id}.bin"));
            let run = std::fs::read(&path).map_err(|e| skip(format!("run: {e}")))?;
            cut(&label, &run).map_err(skip)?;
            Ok((label, path))
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

/// Write each slice's picture under `out`, drop a slice whose picture will not decode — so
/// the results never name a file that was not written — and let go of the pictures' bytes.
fn keep_written(out: &Path, slices: &mut Vec<Slice>) -> Result<(), String> {
    slices.retain(|s| decode_data_uri(&s.data_uri).is_some());
    for slice in slices.iter_mut() {
        let bytes = decode_data_uri(&slice.data_uri).expect("retained above");
        let path = out.join(&slice.file);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
        slice.data_uri = String::new();
    }
    Ok(())
}

/// One run, start to finish, on a worker: read it, replay it, write its pictures.
fn replay_file(
    (label, path): &Ready,
    out: &Path,
    ingredients: &Ingredients,
) -> Result<RunOut, Skipped> {
    let skip = |why: String| Skipped { id: label.id.clone(), why };
    let run = std::fs::read(path).map_err(|e| skip(format!("run: {e}")))?;
    let frames = cut(label, &run).map_err(skip)?;
    let mut done = replay_run(label, &frames, ingredients);
    for pass in &mut done.passes {
        keep_written(out, &mut pass.slices).map_err(skip)?;
    }
    Ok(done)
}

/// The reframing survey (prototype, `SCANNER_REFRAME_SURVEY=<file>`): every frame's detected
/// quad, read as the card and as each region `card_scanner::reframe` knows, matched, and scored
/// against the reader's card — one JSON line per frame and reading. No session, no tracker: the
/// question is what each reading's match looks like when it is right and when it is not.
fn survey_file((label, path): &Ready, r: &Reference, ingredients: &Ingredients) -> Vec<String> {
    use card_scanner::detect::{locate, rectify, rgb_of, DetectOptions, EdgeMethod};
    let Ok(run) = std::fs::read(path) else { return Vec::new() };
    let Ok(frames) = cut(label, &run) else { return Vec::new() };
    let truth = ingredients.oracle_of(&label.card.id);
    let mask = card_scanner::index::Mask::all();
    let insets = std::env::var_os("SCANNER_SURVEY_INSETS").is_some();
    let mut lines = Vec::new();
    for (i, jpeg) in frames.iter().enumerate() {
        let Ok(source) = image::load_from_memory(jpeg) else { continue };
        let rgb = rgb_of(&source);
        let found = [EdgeMethod::Canny, EdgeMethod::Otsu]
            .into_iter()
            .filter_map(|m| locate(&source, &rgb, &DetectOptions { method: m, ..Default::default() }).0.ok())
            .max_by(|a, b| a.rank().total_cmp(&b.rank()));
        let Some(found) = found else { continue };
        let mut readings = vec![("card".to_string(), found.quad)];
        if insets {
            // The match the session makes of this quad — every framing, trimmed — as the line
            // the inset grid has to beat.
            let session = DetectOptions::default();
            if let Some(v) = card_scanner::detect::rectify_views(&rgb, &found.quad, &session) {
                let mut views = vec![(&v.rectified, &v.rectified_180)];
                views.extend(v.alternates.iter().map(|(a, b)| (a, b)));
                let report = r.match_views(&views, 10, &mask);
                lines.extend(survey_line(label, i, "views", true, &report, ingredients, &truth));
            }
            readings.extend(inset_grid(&found.quad));
        } else {
            readings.extend(card_scanner::reframe::hypotheses(&found.quad).into_iter().map(|h| {
                (format!("{}{}", h.region, if h.flipped { "^" } else { "" }), h.card)
            }));
        }
        for (name, quad) in readings {
            let in_frame = card_scanner::reframe::mostly_in_frame(&quad, rgb.width(), rgb.height());
            let (Some(a), Some(b)) = (rectify(&rgb, &quad), rectify(&rgb, &quad.flipped())) else {
                continue;
            };
            let report = r.match_views(&[(&a, &b)], 10, &mask);
            lines.extend(survey_line(label, i, &name, in_frame, &report, ingredients, &truth));
        }
    }
    lines
}

/// The whole-frame title survey (`SCANNER_TITLE_SURVEY=<file>`): every few frames, every line
/// of text found anywhere in the frame — each of four ways up — looked up as a card name. One
/// JSON line per line that names a card, and one per frame read, so the question "does the
/// name bind, and does it bind the reader's card or a neighbour's" can be counted.
fn title_survey_file(
    (label, path): &Ready,
    r: &Reference,
    ingredients: &Ingredients,
) -> Vec<String> {
    use card_scanner::detect::{locate, rgb_of, DetectOptions, EdgeMethod};
    let (Some(d), Some(m)) = (&ingredients.detection, &ingredients.recognition) else {
        return Vec::new();
    };
    let Ok(reader) = TitleReader::from_bytes(d, m) else { return Vec::new() };
    let Ok(run) = std::fs::read(path) else { return Vec::new() };
    let Ok(frames) = cut(label, &run) else { return Vec::new() };
    let truth = ingredients.oracle_of(&label.card.id);
    let mask = card_scanner::index::Mask::all();
    let every = env_number("SCANNER_TITLE_EVERY").unwrap_or(4.0) as usize;
    let mut lines = Vec::new();
    for (i, jpeg) in frames.iter().enumerate().filter(|(i, _)| i % every == 0) {
        let Ok(source) = image::load_from_memory(jpeg) else { continue };
        let rgb = rgb_of(&source);
        let (w, h) = (rgb.width() as f32, rgb.height() as f32);
        let quad = [EdgeMethod::Canny, EdgeMethod::Otsu]
            .into_iter()
            .filter_map(|method| {
                locate(&source, &rgb, &DetectOptions { method, ..Default::default() }).0.ok()
            })
            .max_by(|a, b| a.rank().total_cmp(&b.rank()))
            .map(|f| f.quad);
        if std::env::var_os("SCANNER_TITLE_BANDS").is_some() {
            lines.extend(title_bands(label, i, &rgb, quad.as_ref(), &reader, r, &truth));
            continue;
        }
        let started = std::time::Instant::now();
        let mut found = 0;
        for rot in [0u32, 90, 180, 270] {
            let img = match rot {
                90 => image::imageops::rotate90(&*rgb),
                180 => image::imageops::rotate180(&*rgb),
                270 => image::imageops::rotate270(&*rgb),
                _ => (*rgb).clone(),
            };
            for (text, [l, t, rr, b]) in reader.read_lines(&img) {
                let read = card_scanner::ocr::normalize(&text);
                let Some(hits) = r.lookup_cards_masked(&read, &mask) else { continue };
                found += 1;
                // The line's centre, back in the frame's own coordinates.
                let (u, v) = ((l + rr) / 2.0, (t + b) / 2.0);
                let (x, y) = match rot {
                    90 => (v, h - 1.0 - u),
                    180 => (w - 1.0 - u, h - 1.0 - v),
                    270 => (w - 1.0 - v, u),
                    _ => (u, v),
                };
                let in_quad = quad.as_ref().map(|q| inside(&q.corners, (x, y)));
                // The centre in the quad's own unit square, and the line's height in the quad's
                // short side — where on the card (or around the inner box) the text sits.
                let to_unit = quad.as_ref().and_then(|q| {
                    use imageproc::geometric_transformations::Projection;
                    let unit = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)];
                    Projection::from_control_points(q.corners, unit)
                });
                let (qx, qy) = to_unit.map_or((f32::NAN, f32::NAN), |p| p * (x, y));
                let short = quad.as_ref().map_or(f32::NAN, |q| {
                    let c = q.corners;
                    let side = |a: (f32, f32), b: (f32, f32)| (b.0 - a.0).hypot(b.1 - a.1);
                    (side(c[0], c[1]) + side(c[2], c[3])) / 2.0
                });
                let card_ok = names(&hits.cards, &truth);
                lines.push(serde_json::json!({
                    "run": label.id, "frame": i + 1, "rot": rot, "read": read, "edits": hits.edits,
                    "prefix": hits.prefix, "cards": hits.cards.len(),
                    "binds": binding(&read, &hits),
                    "card_ok": card_ok, "x": x / w, "y": y / h, "in_quad": in_quad,
                    "height": (b - t) / if rot % 180 == 0 { h } else { w },
                    "qx": qx, "qy": qy, "qh": (b - t) / short, "len": read.chars().count(),
                }).to_string());
            }
        }
        lines.push(serde_json::json!({
            "run": label.id, "frame": i + 1, "frame_row": true, "named": found,
            "quad": quad.is_some(), "ms": started.elapsed().as_millis() as u64,
        }).to_string());
    }
    lines
}

/// The title survey's band mode (`SCANNER_TITLE_BANDS=1`): the session's title read of the
/// rectified card, against every line text detection finds in its top
/// (`SCANNER_TITLE_TOP`, [`card_scanner::ocr::WIDE_TITLE_BAND`]'s by default) — full width —
/// each way up. One line per read that names a card, and one per frame with both reads' times.
fn title_bands(
    label: &ScanLabel,
    i: usize,
    rgb: &image::RgbImage,
    quad: Option<&card_scanner::detect::Quad>,
    reader: &TitleReader,
    r: &Reference,
    truth: &Option<String>,
) -> Vec<String> {
    use card_scanner::ocr::{normalize, BandSource};
    let top = env_number("SCANNER_TITLE_TOP").unwrap_or(card_scanner::ocr::WIDE_TITLE_BAND.3);
    let mask = card_scanner::index::Mask::all();
    let Some(q) = quad else { return Vec::new() };
    let opts = card_scanner::detect::DetectOptions::default();
    let Some(v) = card_scanner::detect::rectify_views(rgb, q, &opts) else { return Vec::new() };
    let src = BandSource::Rectified { upright: &v.rectified, flipped: &v.rectified_180 };
    let mut out = Vec::new();
    let mut line = |kind: &str, rot: bool, read: String, ms: f32| {
        let Some(hits) = r.lookup_cards_masked(&read, &mask) else { return };
        let card_ok = names(&hits.cards, truth);
        out.push(serde_json::json!({
            "run": label.id, "frame": i + 1, "kind": kind, "rot": rot, "read": read,
            "edits": hits.edits, "prefix": hits.prefix, "cards": hits.cards.len(),
            "binds": binding(&read, &hits),
            "card_ok": card_ok, "len": read.chars().count(), "ms": ms,
        }).to_string());
    };
    let started = std::time::Instant::now();
    let band = reader.read_title(&src);
    let band_ms = started.elapsed().as_secs_f32() * 1000.0;
    line("band", band.rotated, band.normalized.clone(), band_ms);
    let started = std::time::Instant::now();
    for rot in [false, true] {
        let img = src.band((0.0, 0.0, 1.0, top), 2, rot);
        for (text, _) in reader.read_lines(&img) {
            line("wide", rot, normalize(&text), f32::NAN);
        }
    }
    let wide_ms = started.elapsed().as_secs_f32() * 1000.0;
    out.push(serde_json::json!({
        "run": label.id, "frame": i + 1, "frame_row": true, "band_ms": band_ms, "wide_ms": wide_ms,
    }).to_string());
    out
}

/// Does a name lookup's set of cards hold the reader's?
fn names(cards: &[[u8; 16]], truth: &Option<String>) -> bool {
    truth.as_ref().is_some_and(|t| cards.iter().any(|c| &format_uuid(c) == t))
}

/// Would this read decide the card — one card, not a prefix, within the title rules?
fn binding(read: &str, hits: &card_scanner::reference::NameHits) -> bool {
    !hits.prefix && hits.cards.len() == 1 && card_scanner::resolve::title_binds(read, hits.edits)
}

fn env_number(var: &str) -> Option<f32> {
    std::env::var(var).ok().and_then(|v| v.parse().ok())
}

/// Is `p` inside the convex quad `c`?
fn inside(c: &[(f32, f32); 4], p: (f32, f32)) -> bool {
    let cross =
        |a: (f32, f32), b: (f32, f32)| (b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0);
    let s: Vec<f32> = (0..4).map(|k| cross(c[k], c[(k + 1) % 4])).collect();
    s.iter().all(|&v| v >= 0.0) || s.iter().all(|&v| v <= 0.0)
}

/// One survey line: how a reading matched, and whether that is the reader's card.
fn survey_line(
    label: &ScanLabel,
    i: usize,
    name: &str,
    in_frame: bool,
    report: &card_scanner::reference::MatchReport,
    ingredients: &Ingredients,
    truth: &Option<String>,
) -> Option<String> {
    let top = report.candidates.first()?;
    let top_oracle = ingredients.oracle_of(&top.id);
    let truth = truth.clone();
    // The nearest candidate that is another card — a reprint of the top one is not doubt.
    let rival = report.candidates.iter().skip(1)
        .find(|c| ingredients.oracle_of(&c.id) != top_oracle)
        .map(|c| c.normalized);
    let truth_at = report.candidates.iter()
        .position(|c| truth.is_some() && ingredients.oracle_of(&c.id) == truth);
    Some(serde_json::json!({
        "run": label.id, "frame": i + 1, "reading": name, "in_frame": in_frame,
        "d": top.normalized, "rival": rival, "card_ok": truth.is_some() && top_oracle == truth,
        "printing_ok": top.id == label.card.id, "truth_at": truth_at,
        "oracles": report.candidates.iter().map(|c| ingredients.oracle_of(&c.id))
            .collect::<Vec<_>>(),
    }).to_string())
}

/// The sleeve-pocket survey's readings (`SCANNER_SURVEY_INSETS=1`): the card taken to lie
/// inside the detected quad, smaller and off its centre, on a grid laid out in the quad's own
/// perspective — a pocket's margin is not even on all four sides.
fn inset_grid(quad: &card_scanner::detect::Quad) -> Vec<(String, card_scanner::detect::Quad)> {
    use imageproc::geometric_transformations::Projection;
    let unit = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)];
    let Some(to_frame) = Projection::from_control_points(unit, quad.corners) else {
        return Vec::new();
    };
    let scales = grid_values("SCANNER_SURVEY_SCALES", &[0.80, 0.85, 0.90]);
    let offsets = grid_values("SCANNER_SURVEY_OFFSETS", &[-0.04, 0.0, 0.04]);
    let mut out = Vec::new();
    for &s in &scales {
        for &dx in &offsets {
            for &dy in &offsets {
                let (x0, y0) = (0.5 + dx - s / 2.0, 0.5 + dy - s / 2.0);
                let (x1, y1) = (x0 + s, y0 + s);
                if x0 < 0.0 || y0 < 0.0 || x1 > 1.0 || y1 > 1.0 {
                    continue;
                }
                let corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)].map(|p| to_frame * p);
                let cell = card_scanner::detect::Quad { corners };
                out.push((format!("g{s:.2},{dx:+.3},{dy:+.3}"), cell));
            }
        }
    }
    out
}

fn grid_values(var: &str, default: &[f32]) -> Vec<f32> {
    std::env::var(var)
        .ok()
        .map(|v| v.split(',').filter_map(|x| x.trim().parse().ok()).collect::<Vec<f32>>())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| default.to_vec())
}

/// The runs whose id or card name contains any of `only`, ignoring case; all when it is empty.
fn select(runs: Vec<Ready>, only: &[String]) -> Vec<Ready> {
    let needles: Vec<String> = only.iter().map(|s| s.to_lowercase()).collect();
    runs.into_iter()
        .filter(|(label, _)| {
            let shown = format!("{} {}", label.id, label.card.name).to_lowercase();
            needles.is_empty() || needles.iter().any(|n| shown.contains(n.as_str()))
        })
        .collect()
}

fn no_match_sentence(only: &[String]) -> String {
    format!("no scan's id or card name contains any of [{}]", only.join(", "))
}

fn run(args: Args) -> Result<(), String> {
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
    let neural_dir = args.neural_models.clone().unwrap_or_else(neural_models_in_tree);
    let neural = card_scanner::neural::read_dir(&neural_dir)
        .map_err(|e| format!("neural models {}: {e}", neural_dir.display()))?;
    // Before any session: a Neural pass's frames are timed by it (see `LabelClock`).
    host::set_clock(replay_clock);
    let conn = open_corpus(&args.corpus)?;
    let labels = rows_from_corpus(&conn)?;
    labels_agree(&bundle, &labels, &conn)?;
    let oracles = labels.iter().filter_map(|l| l.oracle.map(|o| (l.id, o))).collect();
    let ingredients = Ingredients {
        bundle,
        labels,
        detection: Some(detection),
        recognition: Some(recognition),
        oracles,
        neural: Some(neural),
    };
    drop(ingredients.session_for(ScanMode::Neural)?);

    let mut skipped = Vec::new();
    let mut ready = Vec::new();
    let mut considered = Vec::new();
    for read in read_corpus(&args.corpus_dir)? {
        match read {
            Ok(entry) => considered.push(entry),
            Err(skip) => skipped.push(skip),
        }
    }
    let considered_count = considered.len();
    ready.extend(select(considered, &args.only));
    if ready.is_empty() {
        if !args.only.is_empty() && considered_count > 0 {
            return Err(no_match_sentence(&args.only));
        }
        return Err(format!(
            "no scan in {} could be replayed ({} skipped)",
            args.corpus_dir.display(),
            skipped.len()
        ));
    }
    std::fs::create_dir_all(&args.out)
        .map_err(|e| format!("cannot create {}: {e}", args.out.display()))?;
    let jobs = args
        .jobs
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get() / 2));
    let done = AtomicUsize::new(0);
    if let Some(file) = std::env::var_os("SCANNER_TITLE_SURVEY") {
        let r = ingredients.reference()?;
        let lines = parallel(ready.len(), jobs, |i| {
            let lines = title_survey_file(&ready[i], &r, &ingredients);
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            eprintln!("[{n}/{}] {} — titles surveyed", ready.len(), ready[i].0.card.name);
            lines
        });
        let text: String = lines.into_iter().flatten().map(|l| l + "\n").collect();
        return std::fs::write(&file, text).map_err(|e| format!("title survey: {e}"));
    }
    if let Some(file) = std::env::var_os("SCANNER_REFRAME_SURVEY") {
        let r = ingredients.reference()?;
        let lines = parallel(ready.len(), jobs, |i| {
            let lines = survey_file(&ready[i], &r, &ingredients);
            eprintln!("[{}/{}] {} — surveyed", done.fetch_add(1, Ordering::Relaxed) + 1, ready.len(),
                ready[i].0.card.name);
            lines
        });
        let text: String = lines.into_iter().flatten().map(|l| l + "\n").collect();
        return std::fs::write(&file, text).map_err(|e| format!("survey: {e}"));
    }
    let replayed = parallel(ready.len(), jobs, |i| {
        let result = replay_file(&ready[i], &args.out, &ingredients);
        if let Ok(out) = &result {
            eprintln!("[{}/{}] {} — {}", done.fetch_add(1, Ordering::Relaxed) + 1, ready.len(),
                out.card.name, serde_json::to_string(&out.passes[0].score).unwrap_or_default());
        }
        result
    });
    let mut runs = Vec::new();
    for result in replayed {
        match result {
            Ok(out) => runs.push(out),
            Err(skip) => skipped.push(skip),
        }
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
    use std::collections::BTreeSet;
    use std::sync::OnceLock;

    /// The app's real frame size, on the long edge.
    const LONG_EDGE: u32 = 960;

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

    /// Another card entirely: colour that runs across the card, not down it.
    fn gradient(w: u32, h: u32) -> RgbImage {
        RgbImage::from_fn(w, h, |x, y| {
            let t = (x * 255 / w) as u8;
            image::Rgb([t, 255 - t, ((y * 255 / h) as u8) / 2])
        })
    }

    fn face(card: u8) -> RgbImage {
        let (w, h) = (card_scanner::RECTIFIED_W, card_scanner::RECTIFIED_H);
        if card == 3 {
            return gradient(w, h);
        }
        let banded = banded(w, h);
        if card == 1 {
            return banded;
        }
        RgbImage::from_fn(w, h, |x, y| {
            let p = banded.get_pixel(x, y).0;
            image::Rgb([255 - p[0], 255 - p[1], 255 - p[2]])
        })
    }

    /// What knows the banded card (printing 1, card 10), a second printing of it (printing 2,
    /// hashed from its negative) and another card (printing 3, card 20, the gradient). No
    /// reader: the tests have no models.
    fn ingredients() -> Ingredients {
        let kind = HashKind::DHashChroma32;
        let mut b = BundleBuilder::new(kind, 256);
        let mut labels = Vec::new();
        let mut oracles = HashMap::new();
        for (n, oracle) in [(1u8, 10u8), (2, 10), (3, 20)] {
            b.push(Section::Card, id(n), &hash_rgb(&face(n), kind, 256));
            labels.push(LabelRow {
                id: id(n),
                oracle: Some(id(oracle)),
                illustration: None,
                label: Label {
                    name: format!("Card {oracle}"),
                    set: "hob".into(),
                    number: n.to_string(),
                    lang: "en".into(),
                    released: "2025-01-01".into(),
                },
            });
            oracles.insert(id(n), id(oracle));
        }
        Ingredients {
            bundle: b.finish(0).to_bytes(),
            labels,
            detection: None,
            recognition: None,
            oracles,
            neural: None,
        }
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
                    ms: 0, bytes: f.len(), width: LONG_EDGE, height: LONG_EDGE * 9 / 16, ok: true,
                    lock: None, confidence: None, distance: None, decided: None, detail: false,
                })
                .collect(),
        }
    }

    /// The synthetic burst of the banded card, made once.
    fn frames() -> &'static [Vec<u8>] {
        static FRAMES: OnceLock<Vec<Vec<u8>>> = OnceLock::new();
        FRAMES.get_or_init(|| {
            let opts = SynthOptions { long_edge: LONG_EDGE, ..Default::default() };
            burst(&face(1), &opts, 1)
        })
    }

    fn background() -> Vec<u8> {
        let img = RgbImage::from_pixel(LONG_EDGE, LONG_EDGE * 9 / 16, image::Rgb([90, 90, 90]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Jpeg)
            .unwrap();
        out
    }

    fn fast(slices: bool) -> Pass {
        Pass { name: AS_SCANNED, mode: ScanMode::Fast, filtered: true, slices }
    }

    /// One Fast pass over `jpegs`, labelled as `printing`.
    fn replayed_over(printing: [u8; ID_LEN], jpegs: &[Vec<u8>], slices: bool) -> PassOut {
        let ing = ingredients();
        let label = label_for(printing, jpegs);
        let cut: Vec<&[u8]> = jpegs.iter().map(Vec::as_slice).collect();
        let truth = ing.oracle_of(&label.card.id);
        run_pass(&mut ing.session().unwrap(), &fast(slices), &label, &cut, truth.as_deref(), |p| {
            ing.oracle_of(p)
        })
    }

    fn jpeg_uuid(n: u8) -> String {
        format_uuid(&id(n))
    }

    /// The replays most tests read, each made once: debug builds are slow and CI runs them so.
    struct Shared {
        plain: PassOut,
        other_printing: PassOut,
        wrong: PassOut,
        run: RunOut,
    }

    fn shared() -> &'static Shared {
        static SHARED: OnceLock<Shared> = OnceLock::new();
        SHARED.get_or_init(|| {
            let jpegs = frames();
            let mut label = label_for(id(1), jpegs);
            label.scanner.reported = Some(jpeg_uuid(1));
            for f in &mut label.run {
                f.decided = Some(jpeg_uuid(1).to_uppercase());
            }
            let cut: Vec<&[u8]> = jpegs.iter().map(Vec::as_slice).collect();
            Shared {
                plain: replayed_over(id(1), jpegs, false),
                other_printing: replayed_over(id(2), jpegs, false),
                wrong: replayed_over(id(3), jpegs, false),
                run: replay_run(&label, &cut, &ingredients()),
            }
        })
    }

    #[test]
    fn a_run_of_the_card_the_label_names_scores_its_printing() {
        let out = &shared().plain;
        assert_eq!(out.score, Score::Printing, "{:?}", out.error);
        assert_eq!(out.got.as_ref().map(|g| g.id.clone()), Some(jpeg_uuid(1)));
        assert_eq!(out.frames.len(), 12);
        assert!(out.first_decision_frame.is_some_and(|n| n <= 12));
        assert!(out.slices.is_empty(), "a pass that keeps no pictures keeps none");
        assert!(out.resolve_ran, "Fast always resolves");
        assert!(out.locked_frames > 0 && out.decisions >= 1);
        assert!(out.frames.iter().all(|f| f.error.is_none()), "a miss is not a failure");
    }

    #[test]
    fn the_same_run_labelled_as_the_other_printing_scores_the_card() {
        assert_eq!(shared().other_printing.score, Score::Card);
    }

    /// The scanner reads the banded card as Card 10 whatever the reader named; a reader who
    /// named the gradient's printing was scored against another card.
    #[test]
    fn a_run_labelled_as_another_card_scores_wrong_and_names_what_it_matched() {
        let out = &shared().wrong;
        assert_eq!(out.score, Score::Wrong, "{:?}", out.error);
        let got = out.got.as_ref().expect("a decision");
        assert_eq!(got.name.as_deref(), Some("Card 10"));
    }

    /// The pictures are a by-product. A pass that keeps them must decide what one that does
    /// not decides, on the same frame — or the report would be of a second scanner.
    #[test]
    fn keeping_the_pictures_changes_no_decision() {
        let (plain, pictured) = (&shared().plain, &shared().run.passes[0]);
        assert_eq!(plain.score, pictured.score);
        assert_eq!(plain.first_decision_frame, pictured.first_decision_frame);
        assert_eq!(plain.decision_frame, pictured.decision_frame);
        let decided = |p: &PassOut| p.frames.iter().map(|f| f.decided.clone()).collect::<Vec<_>>();
        assert_eq!(decided(plain), decided(pictured));
        let kinds: Vec<&str> = pictured.slices.iter().map(|s| s.kind).collect();
        assert_eq!(kinds, ["rectified", "binary"], "no reader, so no band");
        let decided_at = pictured.decision_frame.unwrap();
        assert!(pictured.slices.iter().all(|s| s.frame <= decided_at), "{:?}", pictured.slices);
        let jpeg = decode_data_uri(&pictured.slices[0].data_uri).expect("a data uri");
        assert!(jpeg.starts_with(&[0xFF, 0xD8, 0xFF]));
    }

    #[test]
    fn a_run_replays_end_to_end_into_three_named_passes() {
        let run = &shared().run;
        let names: Vec<&str> = run.passes.iter().map(|p| p.name).collect();
        assert_eq!(names, ["As scanned", "Fast", "Exact"]);
        assert_eq!(run.then.score, Score::Printing);
        assert_eq!(run.then.got.as_deref(), Some(jpeg_uuid(1).as_str()));
        assert!(run.known);
        assert!(!run.filtered);
        assert_eq!(run.frames, 12);
        // Every label frame says the printing decided, in capitals: it differs on exactly the
        // frames the session had not decided on yet, and case alone is no difference.
        let undecided = run.passes[0].frames.iter().filter(|f| f.decided.is_none()).count();
        assert_eq!(run.decided_differs, Some(undecided));
        assert!(undecided > 0 && undecided < 12);
        // Twelve steady frames are enough for Exact to resolve here, and it got the printing.
        let exact = &run.passes[2];
        assert_eq!(exact.mode, ScanMode::Exact);
        assert!(exact.resolve_ran && exact.score == Score::Printing, "{:?}", exact.error);
        assert!(run.passes[1].resolve_ran);
        assert!(!ingredients().knows(&jpeg_uuid(9)));
    }

    fn keys(value: &serde_json::Value) -> BTreeSet<String> {
        value.as_object().expect("an object").keys().cloned().collect()
    }

    fn set(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    /// The schema `scripts/scanner-replay.ts` types against. A rename fails here first.
    #[test]
    fn the_results_have_exactly_the_keys_the_schema_names() {
        let mut run = shared().run.passes[0].clone();
        let mut collector = slice(&label_for(id(1), frames()), 3, "collector", String::new());
        collector.tried = vec![CollectorTry { set: "hob".into(), number: "1".into(), matched: None }];
        run.slices.push(collector);
        let mut out = replay_run_stub();
        out.passes = vec![run];
        let results = Results {
            v: SCHEMA,
            commit: Some("abc".into()),
            bundle_printings: 3,
            runs: vec![out],
            skipped: vec![Skipped { id: "a".into(), why: "b".into() }],
        };
        let value = serde_json::to_value(&results).unwrap();
        assert_eq!(keys(&value), set(&["v", "commit", "bundle_printings", "runs", "skipped"]));
        assert_eq!(keys(&value["skipped"][0]), set(&["id", "why"]));
        let run = &value["runs"][0];
        assert_eq!(
            keys(run),
            set(&["id", "received_at", "card", "finish", "platform", "version", "mode",
                "filtered", "detail", "frames", "known", "then", "decided_differs",
                "then_frames", "passes"])
        );
        assert_eq!(keys(&run["card"]), set(&["id", "set", "number", "lang", "name"]));
        assert_eq!(keys(&run["then"]), set(&["score", "got"]));
        assert_eq!(keys(&run["then_frames"][0]), set(&["ms", "ok", "lock", "decided", "detail"]));
        let pass = &run["passes"][0];
        assert_eq!(
            keys(pass),
            set(&["name", "mode", "score", "ambiguous", "true_in_choices", "got",
                "first_decision_frame", "decision_frame", "decisions", "resolve_ran",
                "locked_frames", "confidence", "distance", "frames", "tiers", "slices", "error"])
        );
        assert_eq!(keys(&pass["got"]), set(&["id", "name", "set", "number"]));
        assert_eq!(
            keys(&pass["frames"][0]),
            set(&["ok", "lock", "confidence", "distance", "decided", "error"])
        );
        let slice_keys = set(&["frame", "kind", "file", "raw", "normalized", "matched", "tried",
            "more", "mark", "edits"]);
        for s in pass["slices"].as_array().unwrap() {
            assert_eq!(keys(s), slice_keys);
        }
        let tried = pass["slices"].as_array().unwrap().last().unwrap()["tried"][0].clone();
        assert_eq!(keys(&tried), set(&["set", "number", "matched"]));
    }

    /// A `RunOut` with nothing in it but the shape.
    fn replay_run_stub() -> RunOut {
        let mut run = replay_run_shape();
        run.passes.clear();
        run
    }

    fn replay_run_shape() -> RunOut {
        let r = &shared().run;
        RunOut {
            id: r.id.clone(),
            received_at: r.received_at.clone(),
            card: r.card.clone(),
            finish: r.finish.clone(),
            platform: r.platform.clone(),
            version: r.version.clone(),
            mode: r.mode,
            filtered: r.filtered,
            detail: r.detail,
            frames: r.frames,
            known: r.known,
            then: Then { score: r.then.score, got: r.then.got.clone() },
            decided_differs: r.decided_differs,
            then_frames: r.then_frames.iter().map(|f| ThenFrame {
                ms: f.ms, ok: f.ok, lock: f.lock.clone(), decided: f.decided.clone(),
                detail: f.detail,
            }).collect(),
            passes: Vec::new(),
        }
    }

    /// The frames of the synthetic run followed by `empty` of bare background.
    fn card_then_nothing(empty: usize) -> PassOut {
        let mut jpegs = frames().to_vec();
        jpegs.extend((0..empty).map(|_| background()));
        replayed_over(id(1), &jpegs, false)
    }

    /// The tracker releases a decision after ten card-less frames (see
    /// `a_card_taken_away_lets_the_next_one_resolve` in `session.rs`), and the lock goes idle
    /// well before that. So eight empty frames after the decision leave it held: the score
    /// is the held printing, and the frame it was made on is the frame it is reported on.
    ///
    /// The frame the burst decides on depends on the platform's synthetic poses, so it is
    /// compared, not named; the ten-frame rule is the session's, not the platform's.
    #[test]
    fn a_card_taken_away_for_eight_frames_is_still_decided() {
        let out = card_then_nothing(8);
        assert_eq!(out.frames.len(), 20);
        assert!(out.frames[19].error.is_none(), "an empty frame is a miss, not a failure");
        assert_eq!(out.frames[19].decided.as_deref(), Some(jpeg_uuid(1).as_str()));
        assert_eq!(out.score, Score::Printing, "{:?}", out.error);
        assert_eq!(out.got.as_ref().map(|g| g.id.clone()), Some(jpeg_uuid(1)));
        assert_eq!(out.decisions, 1);
        assert_eq!(out.decision_frame, out.first_decision_frame);
        assert!(out.decision_frame.is_some_and(|n| n <= 12), "{:?}", out.decision_frame);
    }

    /// Ten empty frames drop the decision: the last frame holds none, so the pass is
    /// undecided with no `got` — while `decision_frame` and `decisions` still say the
    /// decision that was made and lost, which is why they are not the score's.
    #[test]
    fn a_card_taken_away_for_ten_frames_is_undecided_but_remembers_its_decision() {
        let out = card_then_nothing(10);
        assert_eq!(out.frames.len(), 22);
        assert!(out.frames[11].decided.is_some(), "decided while the card was there");
        assert_eq!(out.frames[21].decided, None);
        assert_eq!(out.score, Score::Undecided);
        assert!(out.got.is_none());
        assert_eq!(out.decisions, 1);
        assert_eq!(out.decision_frame, out.first_decision_frame);
        assert!(out.decision_frame.is_some_and(|n| n <= 12), "{:?}", out.decision_frame);
        assert!(out.frames.iter().all(|f| f.error.is_none()));
    }

    /// The replay's clock answers the label's time on a thread a Neural pass is feeding, and
    /// the wall clock everywhere else — a stopwatch started at the pass's first frame reads the
    /// label's milliseconds since it.
    #[test]
    fn a_neural_pass_reads_the_labels_frame_times_and_nothing_else_does() {
        let clock = LabelClock::start().expect("nothing else installs a clock here");
        let at_load = host::Stopwatch::start();
        label_time(750.0);
        assert_eq!(at_load.ms(), 750.0);
        label_time(1_900.0);
        assert_eq!(at_load.ms(), 1_900.0);
        // Another thread — where a Fast frame fans its work out — has the wall clock.
        assert!(std::thread::spawn(|| LABEL_MS.with(Cell::get)).join().unwrap().is_none());
        drop(clock);
        assert_eq!(LABEL_MS.with(Cell::get), None);
        // And off a pass, moving the label clock moves nothing.
        label_time(5.0);
        assert_eq!(LABEL_MS.with(Cell::get), None);
    }

    /// With models, a run gets a fourth pass, Neural: every frame read, none a failure. The
    /// synthetic card is no printing the gallery knows, so what it decides is not asked.
    #[test]
    fn with_the_neural_models_a_run_replays_a_fourth_pass() {
        let mut ing = ingredients();
        let models = card_scanner::neural::read_dir(&neural_models_in_tree()).expect("in git");
        ing.neural = Some(models);
        let jpegs = frames();
        let label = label_for(id(1), jpegs);
        let cut: Vec<&[u8]> = jpegs.iter().map(Vec::as_slice).collect();
        let named = |neural: bool| passes(&label, neural).iter().map(|p| p.name).collect::<Vec<_>>();
        assert_eq!(named(ing.neural.is_some()), ["As scanned", "Fast", "Exact", "Neural"]);
        assert_eq!(named(false).len(), 3, "no models, no Neural pass");
        // The pass alone: the other three are `shared()`'s, and slow in a debug build.
        let neural = &replay_pass(&NEURAL_PASS, &label, &cut, &ing, None);
        assert_eq!(neural.mode, ScanMode::Neural);
        assert_ne!(neural.score, Score::Error, "{:?}", neural.error);
        assert_eq!(neural.frames.len(), 12);
        assert!(neural.frames.iter().all(|f| f.error.is_none() && f.lock.is_none()));
        assert!(neural.resolve_ran, "Neural waits for nothing before it can decide");
        assert_eq!(LABEL_MS.with(Cell::get), None, "the pass left its clock behind");

        // Without them, a Neural pass — a label scanned in Neural — is an error, not undecided.
        let plain = ingredients();
        let out = replay_pass(&NEURAL_PASS, &label, &cut, &plain, None);
        assert_eq!(out.score, Score::Error);
        assert!(out.error.as_deref().is_some_and(|e| e.contains("not loaded")), "{:?}", out.error);
    }

    /// `--only` text that no scan carries is said so, with the text.
    #[test]
    fn an_only_that_matches_nothing_says_what_it_looked_for() {
        let label = label_for(id(1), frames());
        let ready = vec![(label, PathBuf::from("x.bin"))];
        let none = select(ready.clone(), &["zzz".to_string(), "qqq".to_string()]);
        assert!(none.is_empty());
        assert_eq!(
            no_match_sentence(&["zzz".to_string(), "qqq".to_string()]),
            "no scan's id or card name contains any of [zzz, qqq]"
        );
        assert_eq!(select(ready.clone(), &["CARD 10".to_string()]).len(), 1);
        assert_eq!(select(ready, &[]).len(), 1);
    }

    /// A run the As scanned pass could not replay has no `decided_differs` to give.
    #[test]
    fn decided_differs_is_none_when_the_as_scanned_pass_errored() {
        let mut ing = ingredients();
        ing.bundle = b"not a bundle".to_vec();
        let label = label_for(id(1), frames());
        let cut: Vec<&[u8]> = frames().iter().map(Vec::as_slice).collect();
        let run = replay_run(&label, &cut, &ing);
        assert_eq!(run.passes[0].score, Score::Error);
        assert!(run.passes[0].error.as_deref().is_some_and(|e| e.starts_with("bundle:")));
        assert_eq!(run.decided_differs, None);
    }

    /// Exact waits for steady locked frames before it resolves; a run too short for that is
    /// undecided because it never resolved, which the pass says.
    #[test]
    fn an_exact_pass_over_too_few_frames_says_it_never_resolved() {
        let ing = ingredients();
        let jpegs = &frames()[..3];
        let label = label_for(id(1), jpegs);
        let cut: Vec<&[u8]> = jpegs.iter().map(Vec::as_slice).collect();
        let exact = Pass { name: "Exact", mode: ScanMode::Exact, filtered: false, slices: false };
        let out = run_pass(&mut ing.session().unwrap(), &exact, &label, &cut, None, |_| None);
        assert!(!out.resolve_ran);
        assert_eq!(out.score, Score::Undecided);
        assert_eq!(out.decisions, 0);
        assert_eq!(out.decision_frame, None);
    }

    /// A frame the scanner failed on is an error, not an undecided: the middle frame here is
    /// JPEG magic and then garbage.
    #[test]
    fn a_frame_that_cannot_be_decoded_makes_the_pass_an_error() {
        let mut jpegs = frames().to_vec();
        jpegs[5] = [&[0xFF, 0xD8, 0xFF][..], &[0x13; 40][..]].concat();
        let out = replayed_over(id(1), &jpegs, false);
        assert_eq!(out.score, Score::Error);
        let error = out.error.as_deref().expect("an error");
        assert!(error.starts_with("frame 6: decode: "), "{error}");
        let failed: Vec<usize> = out.frames.iter().enumerate()
            .filter(|(_, f)| f.error.is_some()).map(|(i, _)| i).collect();
        assert_eq!(failed, [5], "only the garbage frame failed, no miss before it did");
    }

    fn temp_mirror(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("replay-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for sub in ["labels", "runs"] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
        }
        dir
    }

    #[test]
    fn a_data_uri_that_is_not_one_is_nothing() {
        assert_eq!(decode_data_uri("https://example.com/a.jpg"), None);
        assert_eq!(decode_data_uri("data:image/jpeg;base64,TWFu"), Some(b"Man".to_vec()));
        assert_eq!(decode_data_uri("data:image/jpeg;base64,TWE="), Some(b"Ma".to_vec()));
    }

    #[test]
    fn a_slice_whose_picture_will_not_decode_is_dropped_not_named() {
        let dir = temp_mirror("slices");
        let label = label_for(id(1), frames());
        let mut slices = vec![
            slice(&label, 1, "rectified", "data:image/jpeg;base64,TWFu".into()),
            slice(&label, 2, "binary", "not a data uri".into()),
        ];
        keep_written(&dir, &mut slices).unwrap();
        let written = dir.join(&slices[0].file);
        let (count, bytes, cleared) = (slices.len(), std::fs::read(&written), slices[0].data_uri.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(count, 1);
        assert_eq!(bytes.unwrap(), b"Man");
        assert!(cleared, "the bytes are let go once written");
    }

    #[test]
    fn a_mirror_with_a_run_cut_short_skips_it_by_name() {
        let dir = temp_mirror("short");
        let jpegs = frames();
        let label = label_for(id(1), jpegs);
        std::fs::write(dir.join("labels").join(format!("{}.json", label.id)),
            serde_json::to_string(&label).unwrap()).unwrap();
        std::fs::write(dir.join("runs").join(format!("{}.bin", label.id)), &jpegs.concat()[1..])
            .unwrap();
        let read = read_corpus(&dir).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        let skip = read.into_iter().next().unwrap().err().unwrap();
        assert_eq!(skip.id, label.id);
        assert!(skip.why.contains("add up to"), "{}", skip.why);
    }

    #[test]
    fn a_label_whose_id_is_not_its_file_name_is_skipped() {
        let dir = temp_mirror("renamed");
        let label = label_for(id(1), frames());
        std::fs::write(dir.join("labels").join("someone-elses.json"),
            serde_json::to_string(&label).unwrap()).unwrap();
        std::fs::write(dir.join("runs").join("someone-elses.bin"), frames().concat()).unwrap();
        let read = read_corpus(&dir).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        let skip = read.into_iter().next().unwrap().err().unwrap();
        assert_eq!(skip.id, "someone-elses");
        assert_eq!(skip.why, "the label's id is not its file's name");
    }

    #[test]
    fn a_whole_mirror_reads_clean_and_keeps_no_bytes() {
        let dir = temp_mirror("clean");
        let jpegs = frames();
        let label = label_for(id(1), jpegs);
        std::fs::write(dir.join("labels").join(format!("{}.json", label.id)),
            serde_json::to_string(&label).unwrap()).unwrap();
        std::fs::write(dir.join("runs").join(format!("{}.bin", label.id)), jpegs.concat()).unwrap();
        let read = read_corpus(&dir).unwrap();
        let (got, path) = read.into_iter().next().unwrap().ok().unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(got.id, label.id);
        assert_eq!(path, dir.join("runs").join(format!("{}.bin", label.id)));
    }
}
