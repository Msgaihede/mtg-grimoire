//! `replay` — readers' scans, put back through the scanner and scored.
//!
//! **Real frames.** A supporter's Send stores the last two seconds of frames the scanner judged
//! beside the printing the reader says they show (`infrastructure/scan-worker/README.md`). This
//! feeds each run to fresh sessions and writes what they came to, as facts: `results.json`. The
//! table, the comparison with a baseline and the page are `scripts/scanner-replay.ts`'s.
//!
//! ```text
//! replay --corpus-dir .scanner-corpus --corpus corpus.db --out <dir>
//!        [--commit <sha>] [--only <text>]... [--jobs N]
//!        [--neural-models <dir>] [--neural-evidence <dir>] [--neural-evidence-meta <json>]
//! ```
//!
//! **Two passes a run, a fresh [`Session`] each**: as it was scanned (the label's filters), and
//! unfiltered. Every frame is fed, in order, and a pass is judged on the decision the session
//! holds on the last one — the label names the card in the last frame, and `scanner.reported`
//! is that frame's own decision too. A scan sent while the scanner had other modes (`fast`,
//! `exact`) is replayed all the same: the frames are what the camera saw, whatever judged them.
//!
//! **A pass ages its votes by the label's own frame times** (`run[].ms`), not by how fast this
//! machine decodes: the agreement reads the session's clock, and the replay installs one
//! ([`host::set_clock`]) that answers the label's time while a pass feeds the thread. The models
//! are `crates/card-neural/models/`, or `--neural-models`, and the set symbol and collector band
//! files are loaded beside them — `--neural-evidence`, or the models' own folder when it holds
//! them and its `neural.json` says how to weigh them — and a pass records, as `evidence`, the
//! candidates and scores of its last decision.
//!
//! **What a pass reports beyond its score**: `first_decision_frame` and `decision_frame` (the
//! frame the last decision was made on, 1-based; the score is the decision held on the last
//! frame, so a card lost before it leaves `undecided` beside the earlier decision these name)
//! with `decisions` (how many were made). A frame the scanner failed on (a panic, an undecodable
//! JPEG) carries `error`, and its pass scores `error` rather than `undecided`.
//!
//! **A replay is not the scan**, two ways the inbox documents: nothing from before the first
//! frame, and — for a run kept at full resolution — each frame brought down to the pump's size
//! again here ([`card_scanner::replay::as_sent`]), which is a resample of the scanner's picture
//! and not its bytes. `then` and `decided_differs` are how far that moved an answer, apart from
//! any change to the scanner. **A scan the reader sent with no card in it is skipped**, by name
//! ([`card_scanner::replay::NO_CARD`]): nothing here scores a false positive yet.
//!
//! **No wall clock decides anything**: the agreement reads the label's times, so a run answers
//! the same on a loaded machine and frames are fed as fast as they decode.

use card_scanner::host;
use card_scanner::ids::{format_uuid, parse_uuid, Id};
use card_scanner::labels::{self, Encoder};
use card_scanner::reference::Reference;
use card_scanner::replay::{as_sent, cut, parse_label, score, settled, ScanLabel, Score, Settled};
use card_scanner::session::{Outcome, Session, Verdict};
use clap::Parser;
use serde::Serialize;
use std::borrow::Cow;
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

/// Candidates per frame — the app's default.
const TOP: usize = 5;
/// The results' shape. 2 since the Neural scanner became the only one (2026-10-24): the Fast and
/// Exact passes, their pictures, tiers and lock left it.
const SCHEMA: u32 = 2;

#[derive(Parser, Debug)]
#[command(name = "replay", about = "Readers' scans, replayed through the card scanner")]
struct Args {
    /// The local mirror: `labels/<id>.json` beside `runs/<id>.bin`.
    #[arg(long)]
    corpus_dir: PathBuf,
    /// The app's `corpus.db`, for labels. Opened read-only.
    #[arg(long)]
    corpus: PathBuf,
    /// Where `results.json` goes.
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
    /// The recogniser's four files. `crates/card-neural/models/` of this checkout when not
    /// given — they are in git.
    #[arg(long)]
    neural_models: Option<PathBuf>,
    /// The set symbol and collector band files (`symbol.onnx`, `band.onnx`, `symbols.bin`,
    /// `bands.bin`): a pass narrows the printing on them and each decision records its
    /// candidates and their scores. Left out, the models' folder when it holds all four and the
    /// `neural.json` in use has an `evidence` section (the folder in git does), and otherwise
    /// no evidence: a pass deciding a look, with no scores.
    #[arg(long)]
    neural_evidence: Option<PathBuf>,
    /// A `neural.json` to read in place of the one in `--neural-models`: how the lab tunes the
    /// evidence thresholds without copying the models.
    #[arg(long)]
    neural_evidence_meta: Option<PathBuf>,
}

/// `crates/card-neural/models/` beside this crate — where the recogniser's files are in git.
fn neural_models_in_tree() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../card-neural/models"))
}

thread_local! {
    /// Where the pass feeding this thread is in its run: the label's milliseconds since its
    /// first frame. `None` outside a pass.
    static LABEL_MS: Cell<Option<f64>> = const { Cell::new(None) };
}

/// The replay's clock ([`host::set_clock`]): the label's frame time while a pass feeds this
/// thread, the wall clock otherwise.
fn replay_clock() -> f64 {
    LABEL_MS.with(Cell::get).unwrap_or_else(|| {
        static ORIGIN: OnceLock<std::time::Instant> = OnceLock::new();
        ORIGIN.get_or_init(std::time::Instant::now).elapsed().as_secs_f64() * 1000.0
    })
}

/// The label's frame times on this thread, for as long as it lives: 0 when it starts — before the
/// session is built, because the agreement's clock starts when its models load — and then
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
            Err("the replay's clock is not the one installed, so a pass cannot read the label's \
                 frame times"
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

/// Bytes that live as long as the process: `load_neural` wants `'static` files, and each pass
/// builds a session of its own, so the files are read once and leaked rather than copied 27 MB
/// a scan.
fn pin(bytes: Cow<'static, [u8]>) -> Cow<'static, [u8]> {
    match bytes {
        Cow::Owned(owned) => Cow::Borrowed(&*Box::leak(owned.into_boxed_slice())),
        borrowed => borrowed,
    }
}

fn pinned(files: card_scanner::neural::Files<'static>) -> card_scanner::neural::Files<'static> {
    card_scanner::neural::Files {
        detector: pin(files.detector),
        embedder: pin(files.embedder),
        gallery: pin(files.gallery),
        meta: pin(files.meta),
    }
}

fn pinned_evidence(
    files: card_scanner::neural::evidence::EvidenceFiles<'static>,
) -> card_scanner::neural::evidence::EvidenceFiles<'static> {
    card_scanner::neural::evidence::EvidenceFiles {
        symbol_net: pin(files.symbol_net),
        band_net: pin(files.band_net),
        symbols: pin(files.symbols),
        bands: pin(files.bands),
    }
}

/// What a session is built from, loaded once and shared by every worker.
struct Ingredients {
    /// The corpus's labels as the web host hands them to its scanner ([`card_scanner::labels`]):
    /// read once, attached to each session's reference by the code `load_labels` runs.
    labels: Vec<u8>,
    oracles: HashMap<Id, Id>,
    known: HashSet<Id>,
    neural: card_scanner::neural::Files<'static>,
    /// The set symbol and collector band files. `None` replays a pass that records no evidence.
    neural_evidence: Option<card_scanner::neural::evidence::EvidenceFiles<'static>>,
}

impl Ingredients {
    fn session(&self) -> Result<Session, String> {
        let mut reference = Reference::new();
        labels::attach(&mut reference, &self.labels).map_err(|e| format!("labels: {e}"))?;
        let mut session = Session::new(Some(reference), TOP);
        // Borrowed for the life of the process (see `pin`), so a clone copies no bytes.
        session.load_neural(self.neural.clone()).map_err(|e| format!("neural: {e}"))?;
        if let Some(e) = &self.neural_evidence {
            session.load_neural_evidence(e.clone()).map_err(|e| format!("neural evidence: {e}"))?;
        }
        Ok(session)
    }

    fn oracle_of(&self, printing: &str) -> Option<String> {
        parse_uuid(printing).and_then(|id| self.oracles.get(&id)).map(format_uuid)
    }

    fn knows(&self, printing: &str) -> bool {
        parse_uuid(printing).is_some_and(|id| self.known.contains(&id))
    }
}

/// The labels of every printing in the corpus, encoded, with each printing's oracle and the set
/// of printings it names.
fn labels_from_corpus(
    conn: &rusqlite::Connection,
) -> Result<(Vec<u8>, HashMap<Id, Id>, HashSet<Id>), String> {
    let mut encoder = Encoder::new();
    let mut after = 0;
    const PAGE: usize = 5_000;
    loop {
        let page = labels::read_page(conn, after, PAGE, &mut encoder)
            .map_err(|e| format!("corpus labels: {e}"))?;
        match page.last {
            Some(last) if page.met == PAGE => after = last,
            _ => break,
        }
    }
    let bytes = encoder.finish();
    let decoded = labels::decode(&bytes).map_err(|e| format!("labels: {e}"))?;
    let mut oracles = HashMap::new();
    let mut known = HashSet::new();
    for row in decoded.rows() {
        if let Some(o) = row.oracle {
            oracles.insert(row.id, o);
        }
        known.insert(row.id);
    }
    Ok((bytes, oracles, known))
}

fn open_corpus(path: &Path) -> Result<rusqlite::Connection, String> {
    if !path.exists() {
        return Err(format!("no corpus at {}", path.display()));
    }
    rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("cannot open corpus {}: {e}", path.display()))
}

/// One of the passes.
struct Pass {
    name: &'static str,
    /// The label's filters, or none.
    filtered: bool,
}

const AS_SCANNED: Pass = Pass { name: "As scanned", filtered: true };
const UNFILTERED: Pass = Pass { name: "Neural", filtered: false };
const PASSES: [Pass; 2] = [AS_SCANNED, UNFILTERED];

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
    confidence: Option<f32>,
    distance: Option<f32>,
    decided: Option<String>,
    /// Only a failure of the scanner on this frame — never "no card in this frame".
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct PassOut {
    name: &'static str,
    score: Score,
    ambiguous: bool,
    /// What the decision settled: the floor and the bar are counted on this, not on `score`,
    /// because an ambiguous decision's first choice scores as a printing it only guessed.
    settled: Settled,
    /// How many printings the decision offered; 0 when it offered none.
    choices: usize,
    true_in_choices: bool,
    got: Option<Got>,
    /// 1-based. The frame the first decision was made on.
    first_decision_frame: Option<usize>,
    /// 1-based. The frame the last decision was made on. The score is the decision held on
    /// the *last* frame, so when the card is lost and the decision dropped it is `undecided`
    /// while this, `decisions` still describe the decision that was lost.
    decision_frame: Option<usize>,
    /// The final `decision_seq`.
    decisions: u64,
    confidence: Option<f32>,
    distance: Option<f32>,
    frames: Vec<FrameOut>,
    error: Option<String>,
    /// With evidence loaded: the candidate printings of its last decision and what each
    /// scored, so the thresholds can be tuned offline. `null` otherwise.
    evidence: Option<card_scanner::session::EvidenceReport>,
}

impl PassOut {
    fn new(pass: &Pass, frames: usize) -> PassOut {
        PassOut {
            name: pass.name,
            score: Score::Undecided,
            ambiguous: false,
            settled: Settled::Other,
            choices: 0,
            true_in_choices: false,
            got: None,
            first_decision_frame: None,
            decision_frame: None,
            decisions: 0,
            confidence: None,
            distance: None,
            frames: Vec::with_capacity(frames),
            error: None,
            evidence: None,
        }
    }
}

/// What the page records of a verdict for a label (`packages/ui/features/scanner/submit/
/// run.ts`), read off the same places — so `then` and now are one measure.
fn frame_out(v: &Verdict) -> FrameOut {
    FrameOut {
        ok: v.ok,
        confidence: v.tracked.as_ref().map(|t| t.confidence),
        distance: v.r#match.as_ref().and_then(|m| m.candidates.first()).map(|c| c.distance as f32),
        decided: v.decision.as_ref().map(|d| d.printing.clone()),
        error: v.failure().map(str::to_string),
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
    let mut out = PassOut::new(pass, frames.len());
    if pass.filtered {
        if let Err(e) = session.set_filters(label.scanner.filters.scan_filters()) {
            out.score = Score::Error;
            out.error = Some(format!("filters: {e}"));
            return out;
        }
    }
    let mut failure: Option<String> = None;
    let mut seq = 0u64;
    let mut last: Option<Verdict> = None;
    let first_ms = label.run.first().map_or(0, |f| f.ms);
    for (i, jpeg) in frames.iter().enumerate() {
        // The frame's own time, for the agreement (see `LabelClock`).
        label_time(label.run.get(i).map_or(0, |f| f.ms).saturating_sub(first_ms) as f64);
        let v = session.frame(jpeg);
        let n = i + 1;
        if let Some(msg) = v.failure() {
            failure.get_or_insert_with(|| format!("frame {n}: {msg}"));
        }
        if v.decision_seq > seq {
            seq = v.decision_seq;
            out.decision_frame = Some(n);
            out.first_decision_frame.get_or_insert(n);
        }
        out.frames.push(frame_out(&v));
        last = Some(v);
    }
    out.decisions = seq;
    out.evidence = session.neural_evidence_report();
    let Some(last) = last else { return out };
    out.confidence = last.tracked.as_ref().map(|t| t.confidence);
    out.distance = out.frames.last().and_then(|f| f.distance);
    if let Some(d) = &last.decision {
        let got_oracle = d.oracle_id.clone().or_else(|| oracle_of(&d.printing));
        out.score = score(&label.card.id, truth_oracle, Some(&d.printing), got_oracle.as_deref());
        out.ambiguous = d.outcome == Outcome::Ambiguous;
        out.settled = settled(out.score, out.ambiguous);
        out.choices = d.choices.len();
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

#[derive(Debug, Serialize)]
struct Then {
    score: Score,
    got: Option<String>,
}

#[derive(Debug, Serialize)]
struct ThenFrame {
    ms: i64,
    ok: bool,
    decided: Option<String>,
}

#[derive(Debug, Serialize)]
struct RunOut {
    id: String,
    received_at: String,
    card: card_scanner::replay::LabelCard,
    finish: String,
    platform: String,
    version: String,
    /// The mode the scan was sent in, as the label says it.
    mode: String,
    filtered: bool,
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

/// One pass from a fresh session, on the label's clock, started before its models load (see
/// [`LabelClock`]).
fn replay_pass(
    pass: &Pass,
    label: &ScanLabel,
    frames: &[&[u8]],
    ingredients: &Ingredients,
    truth_oracle: Option<&str>,
) -> PassOut {
    let built = LabelClock::start()
        .and_then(|clock| ingredients.session().map(|session| (clock, session)));
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
    let passes: Vec<PassOut> = PASSES
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
        mode: label.scanner.mode.clone(),
        filtered: !f.sets.is_empty() || f.from.is_some() || f.to.is_some(),
        frames: frames.len(),
        known: ingredients.knows(&label.card.id),
        then,
        decided_differs,
        then_frames: label.run.iter().map(|fr| ThenFrame {
            ms: fr.ms, ok: fr.ok, decided: fr.decided.clone(),
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

/// One run, start to finish, on a worker: read it and replay it.
fn replay_file((label, path): &Ready, ingredients: &Ingredients) -> Result<RunOut, Skipped> {
    let skip = |why: String| Skipped { id: label.id.clone(), why };
    let run = std::fs::read(path).map_err(|e| skip(format!("run: {e}")))?;
    let frames = cut(label, &run).map_err(skip)?;
    // At the size the scanner was given each frame, not the size the inbox keeps it at.
    let sent: Vec<Cow<[u8]>> = frames.iter().map(|frame| as_sent(frame)).collect();
    let frames: Vec<&[u8]> = sent.iter().map(AsRef::as_ref).collect();
    Ok(replay_run(label, &frames, ingredients))
}

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
    let neural_dir = args.neural_models.clone().unwrap_or_else(neural_models_in_tree);
    let mut neural = card_scanner::neural::read_dir(&neural_dir)
        .map_err(|e| format!("neural models {}: {e}", neural_dir.display()))?;
    if let Some(path) = &args.neural_evidence_meta {
        let meta = std::fs::read(path)
            .map_err(|e| format!("neural evidence meta {}: {e}", path.display()))?;
        neural.meta = Cow::Owned(meta);
    }
    // The evidence travels with the models it was tuned beside, so a folder of models brings its
    // own; a `neural.json` without the section (`--neural-evidence-meta`) replays the pass
    // without, as it was before the evidence existed.
    let weighs_evidence = card_scanner::neural::Meta::from_json(&neural.meta)
        .is_ok_and(|m| m.evidence.is_some());
    let evidence_dir = args.neural_evidence.clone().or_else(|| {
        (weighs_evidence && card_scanner::neural::evidence::has_evidence_files(&neural_dir))
            .then(|| neural_dir.clone())
    });
    let neural_evidence = evidence_dir
        .as_ref()
        .map(|dir| {
            card_scanner::neural::evidence::read_dir_evidence(dir)
                .map(pinned_evidence)
                .map_err(|e| format!("neural evidence {}: {e}", dir.display()))
        })
        .transpose()?;
    match &evidence_dir {
        Some(dir) => eprintln!("neural evidence: {}", dir.display()),
        None => eprintln!("neural evidence: none"),
    }
    // Before any session: a pass's frames are timed by it (see `LabelClock`).
    host::set_clock(replay_clock);
    let conn = open_corpus(&args.corpus)?;
    let (labels, oracles, known) = labels_from_corpus(&conn)?;
    let ingredients =
        Ingredients { labels, oracles, known, neural: pinned(neural), neural_evidence };
    drop(ingredients.session()?);

    let mut skipped = Vec::new();
    let mut considered = Vec::new();
    for read in read_corpus(&args.corpus_dir)? {
        match read {
            Ok(entry) => considered.push(entry),
            Err(skip) => skipped.push(skip),
        }
    }
    let considered_count = considered.len();
    let ready = select(considered, &args.only);
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
    let replayed = parallel(ready.len(), jobs, |i| {
        let result = replay_file(&ready[i], &ingredients);
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
    let results = Results { v: SCHEMA, commit: args.commit, runs, skipped };
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
    use card_scanner::ids::ID_LEN;
    use card_scanner::labels::Row;
    use card_scanner::reference::Label;
    use card_scanner::replay::{LabelApp, LabelCard, LabelFilters, LabelFrame, LabelScanner};
    use image::RgbImage;
    use std::collections::BTreeSet;

    /// The app's real frame size, on the long edge.
    const LONG_EDGE: u32 = 960;

    fn id(n: u8) -> Id {
        let mut raw = [0u8; ID_LEN];
        raw[0] = n;
        raw
    }

    /// Labels for three printings — two of card 10, one of card 20 — and the models in git.
    fn ingredients() -> Ingredients {
        let mut encoder = Encoder::new();
        let mut oracles = HashMap::new();
        let mut known = HashSet::new();
        for (n, oracle, set) in [(1u8, 10u8, "hob"), (2, 10, "ltr"), (3, 20, "hob")] {
            encoder.push(&Row {
                id: id(n),
                oracle: Some(id(oracle)),
                label: Label {
                    name: format!("Card {oracle}"),
                    set: set.into(),
                    number: n.to_string(),
                    lang: "en".into(),
                    released: "2025-01-01".into(),
                },
                finishes: vec!["nonfoil".into()],
                promo: false,
                token: false,
            });
            oracles.insert(id(n), id(oracle));
            known.insert(id(n));
        }
        static MODELS: OnceLock<card_scanner::neural::Files<'static>> = OnceLock::new();
        let neural = MODELS
            .get_or_init(|| {
                pinned(card_scanner::neural::read_dir(&neural_models_in_tree()).expect("in git"))
            })
            .clone();
        Ingredients { labels: encoder.finish(), oracles, known, neural, neural_evidence: None }
    }

    fn label_for(printing: Id, frames: &[Vec<u8>]) -> ScanLabel {
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
                mode: "fast".into(),
                confidence: None,
                distance: None,
                bundle: None,
                filters: LabelFilters { sets: Vec::new(), from: None, to: None },
            },
            app: LabelApp { version: "0.48.0".into(), platform: "desktop".into() },
            run: frames
                .iter()
                .enumerate()
                .map(|(i, f)| LabelFrame {
                    ms: 100 * i as i64, bytes: f.len(), width: LONG_EDGE,
                    height: LONG_EDGE * 9 / 16, ok: false, lock: None, confidence: None,
                    distance: None, decided: None, detail: false,
                })
                .collect(),
        }
    }

    /// A frame of bare background, at the app's size: nothing the detector takes for a card.
    fn background() -> Vec<u8> {
        let img = RgbImage::from_pixel(LONG_EDGE, LONG_EDGE * 9 / 16, image::Rgb([90, 90, 90]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Jpeg)
            .unwrap();
        out
    }

    fn frames() -> &'static [Vec<u8>] {
        static FRAMES: OnceLock<Vec<Vec<u8>>> = OnceLock::new();
        FRAMES.get_or_init(|| (0..4).map(|_| background()).collect())
    }

    fn cut_of(jpegs: &[Vec<u8>]) -> Vec<&[u8]> {
        jpegs.iter().map(Vec::as_slice).collect()
    }

    #[test]
    fn a_run_with_no_card_in_it_replays_two_undecided_passes() {
        let ing = ingredients();
        let jpegs = frames();
        let mut label = label_for(id(1), jpegs);
        label.scanner.reported = Some(format_uuid(&id(1)));
        let run = replay_run(&label, &cut_of(jpegs), &ing);
        let names: Vec<&str> = run.passes.iter().map(|p| p.name).collect();
        assert_eq!(names, ["As scanned", "Neural"]);
        for pass in &run.passes {
            assert_eq!(pass.score, Score::Undecided, "{:?}", pass.error);
            assert_eq!((pass.decisions, pass.decision_frame), (0, None));
            assert_eq!(pass.frames.len(), 4);
            assert!(pass.frames.iter().all(|f| !f.ok && f.error.is_none()), "a miss is no failure");
            assert!(pass.evidence.is_none(), "no evidence loaded, none recorded");
        }
        assert_eq!(run.then.score, Score::Printing);
        assert_eq!((run.mode.as_str(), run.known, run.filtered), ("fast", true, false));
        assert_eq!(run.decided_differs, Some(0), "undecided then, undecided now");
        assert!(!ing.knows(&format_uuid(&id(9))));
        assert_eq!(LABEL_MS.with(Cell::get), None, "the pass left its clock behind");
    }

    #[test]
    fn the_label_filters_are_the_as_scanned_passes_alone() {
        let ing = ingredients();
        let jpegs = frames();
        let mut label = label_for(id(1), jpegs);
        label.scanner.filters.sets = vec!["zzz".into()];
        let run = replay_run(&label, &cut_of(jpegs), &ing);
        assert!(run.filtered);
        let scanned = &run.passes[0];
        assert_eq!(scanned.score, Score::Error);
        assert_eq!(scanned.error.as_deref(), Some("filters: No printing matches these filters."));
        assert_eq!(run.decided_differs, None, "no As scanned pass to compare");
        assert_eq!(run.passes[1].score, Score::Undecided, "the unfiltered pass ran regardless");
    }

    /// A frame the scanner failed on is an error, not an undecided: the middle frame here is
    /// JPEG magic and then garbage.
    #[test]
    fn a_frame_that_cannot_be_decoded_makes_the_pass_an_error() {
        let ing = ingredients();
        let mut jpegs = frames().to_vec();
        jpegs[2] = [&[0xFF, 0xD8, 0xFF][..], &[0x13; 40][..]].concat();
        let label = label_for(id(1), &jpegs);
        let out = replay_pass(&UNFILTERED, &label, &cut_of(&jpegs), &ing, None);
        assert_eq!(out.score, Score::Error);
        let error = out.error.as_deref().expect("an error");
        assert!(error.starts_with("frame 3: decode: "), "{error}");
        let failed: Vec<usize> = out.frames.iter().enumerate()
            .filter(|(_, f)| f.error.is_some()).map(|(i, _)| i).collect();
        assert_eq!(failed, [2], "only the garbage frame failed");
    }

    /// The replay's clock answers the label's time on a thread a pass is feeding, and the wall
    /// clock everywhere else — a stopwatch started at the pass's first frame reads the label's
    /// milliseconds since it.
    #[test]
    fn a_pass_reads_the_labels_frame_times_and_nothing_else_does() {
        let clock = LabelClock::start().expect("nothing else installs a clock here");
        let at_load = host::Stopwatch::start();
        label_time(750.0);
        assert_eq!(at_load.ms(), 750.0);
        label_time(1_900.0);
        assert_eq!(at_load.ms(), 1_900.0);
        // Another thread has the wall clock.
        assert!(std::thread::spawn(|| LABEL_MS.with(Cell::get)).join().unwrap().is_none());
        drop(clock);
        assert_eq!(LABEL_MS.with(Cell::get), None);
        // And off a pass, moving the label clock moves nothing.
        label_time(5.0);
        assert_eq!(LABEL_MS.with(Cell::get), None);
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
        let ing = ingredients();
        let jpegs = frames();
        let mut run = replay_run(&label_for(id(1), jpegs), &cut_of(jpegs), &ing);
        run.passes[0].got =
            Some(Got { id: "x".into(), name: None, set: None, number: None });
        let results = Results {
            v: SCHEMA,
            commit: Some("abc".into()),
            runs: vec![run],
            skipped: vec![Skipped { id: "a".into(), why: "b".into() }],
        };
        let value = serde_json::to_value(&results).unwrap();
        assert_eq!(value["v"], 2);
        assert_eq!(keys(&value), set(&["v", "commit", "runs", "skipped"]));
        assert_eq!(keys(&value["skipped"][0]), set(&["id", "why"]));
        let run = &value["runs"][0];
        assert_eq!(
            keys(run),
            set(&["id", "received_at", "card", "finish", "platform", "version", "mode",
                "filtered", "frames", "known", "then", "decided_differs", "then_frames",
                "passes"])
        );
        assert_eq!(keys(&run["card"]), set(&["id", "set", "number", "lang", "name"]));
        assert_eq!(keys(&run["then"]), set(&["score", "got"]));
        assert_eq!(keys(&run["then_frames"][0]), set(&["ms", "ok", "decided"]));
        let pass = &run["passes"][0];
        assert_eq!(
            keys(pass),
            set(&["name", "score", "ambiguous", "settled", "choices", "true_in_choices", "got",
                "first_decision_frame", "decision_frame", "decisions", "confidence", "distance",
                "frames", "error", "evidence"])
        );
        assert_eq!(keys(&pass["got"]), set(&["id", "name", "set", "number"]));
        assert_eq!(keys(&pass["frames"][0]), set(&["ok", "confidence", "distance", "decided", "error"]));
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

    #[test]
    fn the_labels_read_from_a_corpus_name_every_printing_and_its_oracle() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE cards (id TEXT, name TEXT, set_code TEXT, collector_number TEXT,
                                 lang TEXT, released_at TEXT, oracle_id TEXT, finishes TEXT,
                                 promo INTEGER NOT NULL DEFAULT 0, layout TEXT, type_line TEXT)",
        )
        .unwrap();
        for (n, oracle) in [(1u8, Some(10u8)), (2, None)] {
            conn.execute(
                "INSERT INTO cards VALUES (?1, 'Card', 'hob', '1', 'en', NULL, ?2, NULL, 0,
                                           'normal', NULL)",
                rusqlite::params![format_uuid(&id(n)), oracle.map(|o| format_uuid(&id(o)))],
            )
            .unwrap();
        }
        let (bytes, oracles, known) = labels_from_corpus(&conn).unwrap();
        assert_eq!(known, HashSet::from([id(1), id(2)]));
        assert_eq!(oracles, HashMap::from([(id(1), id(10))]));
        assert_eq!(labels::decode(&bytes).unwrap().len(), 2);
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
