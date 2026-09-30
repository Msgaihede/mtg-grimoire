//! `eval` — the synthetic evaluation of both scan modes.
//!
//! **Synthetic: Scryfall renders degraded in software — a regression fence, not an accuracy
//! claim about a camera.** The sample photographs this crate was tuned on are lost, so this is
//! what stands between a change to the pipeline and a silent regression in either mode. The
//! degradations are [`card_scanner::synth`]'s; the design is spec §5 of
//! `docs/superpowers/specs/2026-09-15-scanner-modes-and-shipping-design.md`.
//!
//! ```text
//! eval --bundle card-hashes.bin (--corpus corpus.db | --bulk default-cards.jsonl) --models models \
//!      --printings crates/card-scanner/eval/printings.txt --cache eval-cache \
//!      [--seed 7] [--jobs N] [--summary eval.md] \
//!      [--scene plain|sleeved|stacked] [--only <text>]... [--dump <dir>]
//! eval --detect-only (--corpus corpus.db | --bulk default-cards.jsonl) \
//!      --printings crates/card-scanner/eval/printings.txt --cache eval-cache \
//!      [--seed 7] [--jobs N] [--summary eval.md] \
//!      [--scene plain|sleeved|stacked] [--only <text>]... [--dump <dir>]
//! ```
//!
//! For every printing in the list: fetch its render once (cached), make a burst of frames, and
//! feed the burst to three passes — **Fast**, **Exact**, and **Exact with a filter to the
//! printing's own set** — stopping at the first frame whose `decision_seq` moved. The tables it
//! prints are the whole output: the decisions, then how close the detector's corners came.
//!
//! **Corners are measured against the truth the burst was drawn from.** Every synthetic frame
//! knows where the (top) card's outer corners went ([`SynthFrame::quad`]); a frame's corner
//! error is the mean distance from the detector's raw quad — `Verdict::quad_raw`, before the
//! rectification's inset — to those corners, under the best of the four cyclic pairings, since
//! the detector orders a quad portrait-first with a 180° ambiguity. It is reported in pixels and
//! as a percentage of the card's height, and a frame more than [`OFF_CARD`] of the height out is
//! counted **off-card**: the detector found some other quadrilateral — the art box, a sleeve, a
//! stack's outline — rather than a rough version of the card.
//!
//! **`--detect-only` is the fast loop for working on the detector.** It builds no session and
//! reads no bundle and no models: every frame of every burst goes through
//! [`card_scanner::detect::detect`] with Canny and with Otsu and keeps the one with the higher
//! `Detection::rank` — card-likeness and edge evidence — which is exactly what `Session::frame` does, and only the corner columns are
//! reported. **`--scene`** puts every card in a sleeve or on a stack ([`Scene`]), each with the
//! same pose it has bare. **`--only`** narrows the run to printings whose shown name contains
//! the text, and **`--dump`** writes every frame with its truth quad in green and the detected
//! quad in red, plus a JSON file of the per-frame figures.
//!
//! **Every card gets a fresh [`Session`] per pass, not a reset one.** `Session::reset` keeps the
//! reader cadence counter by design, so a reused session reads a title on a different frame
//! depending on which cards came before — and a card's result would depend on its neighbours,
//! on the order of the list and on how many workers shared it out. A fresh session costs one
//! labelled [`Reference`] per pass per card, which is why the labels and the model bytes are
//! loaded once and only attached per session.
//!
//! **Cards run on `--jobs` workers**, because one card is about nine seconds of frames across
//! the three passes on one core and the list is 160 long. The accuracy columns do not depend on
//! the worker count — a fresh session per pass is what makes that true; the *mean ms* column
//! does, since the workers share cores and the OCR engine's thread pool, so the count is
//! printed with the table.
//!
//! **The render is `image_uris.display`, not `large`**, in both modes. The app's `corpus.db`
//! stores four of Scryfall's image keys — `thumb`, `grid`, `display` and `art` — and `large` is
//! not one of them; `display` is Scryfall's documented replacement for it at the same 672×936.
//! Reading the same key from a bulk file keeps a local `--corpus` run and CI's `--bulk` run
//! measuring the same pixels.
//!
//! **Every request carries a User-Agent** — `cards.scryfall.io` answers HTTP 400 without one
//! (see `build_hashes.rs`) — and uncached fetches are spaced 100 ms apart.

use card_scanner::detect::{detect, DetectOptions, Detection, EdgeMethod};
use card_scanner::filters::ScanFilters;
use card_scanner::index::{format_uuid, parse_uuid, Bundle, ID_LEN};
use card_scanner::ocr::TitleReader;
use card_scanner::reference::{Label, Reference};
use card_scanner::session::{FrameOptions, Outcome, ResolveOn, ScanMode, Session};
use card_scanner::synth::{burst_scene, Scene, SynthFrame, SynthOptions};
use clap::{ArgGroup, Parser};
use image::{Rgb, RgbImage};
use imageproc::drawing::{draw_filled_circle_mut, draw_line_segment_mut};
use serde::de::{SeqAccess, Visitor};
use serde::Deserializer as _;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const USER_AGENT: &str = "MTGGrimoire-card-scanner/0.1 (+https://github.com/Msgaihede/mtg-grimoire)";
const HEADLINE: &str = "Synthetic: Scryfall renders degraded in software — a regression fence, \
                        not an accuracy claim about a camera.";
/// The image key both sources read. See the module doc.
const RENDER: &str = "display";
const FETCH_SPACING: Duration = Duration::from_millis(100);
/// Candidates per frame — the debug server's and the app's default.
const TOP: usize = 5;

/// The three passes: a name, a mode, and whether the session is filtered to the card's own set.
const PASSES: [(&str, ScanMode, bool); 3] = [
    ("Fast", ScanMode::Fast, false),
    ("Exact", ScanMode::Exact, false),
    ("Exact + own set", ScanMode::Exact, true),
];

/// The edge methods a frame is detected with, in the order `Session::frame` tries them under its
/// default `Method::Both` — the order matters only for a tie in card-likeness, which the first
/// one wins there and here.
const METHODS: [EdgeMethod; 2] = [EdgeMethod::Canny, EdgeMethod::Otsu];

/// A detection further than this share of the card's height from the truth, on average per
/// corner, found something other than the card. A tenth of 88 mm is 8.8 mm: well past the
/// ~3 mm border whose inner edge the detector is known to prefer (`DetectOptions::inset`), and
/// short of anything a card's own art box or a stack's outline could be mistaken for.
const OFF_CARD: f32 = 0.10;

#[derive(Parser, Debug)]
#[command(name = "eval", about = "The card scanner's synthetic evaluation")]
#[command(group(ArgGroup::new("source").required(true).args(["corpus", "bulk"])))]
struct Args {
    /// The reference bundle to evaluate. Required unless `--detect-only`, which never reads it.
    #[arg(long)]
    bundle: Option<PathBuf>,
    /// The app's `corpus.db`, for labels and render URLs. Opened read-only.
    #[arg(long)]
    corpus: Option<PathBuf>,
    /// Scryfall's `default_cards`, uncompressed — JSON Lines or a JSON array. Streamed.
    #[arg(long)]
    bulk: Option<PathBuf>,
    /// Directory holding `text-detection.rten` and `text-recognition.rten`. Required unless
    /// `--detect-only`.
    #[arg(long)]
    models: Option<PathBuf>,
    /// The printings to evaluate, one id per line, strata marked `# stratum: <name>`.
    #[arg(long)]
    printings: PathBuf,
    /// Where fetched renders are kept, one file per printing.
    #[arg(long)]
    cache: PathBuf,
    #[arg(long, default_value_t = 7)]
    seed: u64,
    /// Cards evaluated at once. Defaults to half the logical cores — roughly the physical ones.
    /// The accuracy columns do not depend on it; mean ms does, and the table says how many ran.
    #[arg(long)]
    jobs: Option<usize>,
    /// Also write the table here, as markdown.
    #[arg(long)]
    summary: Option<PathBuf>,
    /// Also write one JSON line per Fast frame here: the lock, the card-likeness, the frame's
    /// best card and its distance, and how far behind it the nearest *other* card sat. What
    /// Fast's early decision and its two-frame lock were tuned from. Tracing feeds the Fast pass
    /// the whole burst rather than stopping at its decision; the frames after it are left out of
    /// the table and its mean ms, though they still take a core from the other workers.
    #[arg(long)]
    trace: Option<PathBuf>,
    /// Run the Fast pass alone — a third of the time, for tuning Fast.
    #[arg(long)]
    fast_only: bool,
    /// What surrounds each card: bare, in a sleeve, or on a small stack.
    #[arg(long, default_value_t = Scene::Plain)]
    scene: Scene,
    /// Measure the detector's corners alone: no sessions, no bundle, no models, every frame.
    #[arg(long)]
    detect_only: bool,
    /// Evaluate only the printings whose shown name ("Swamp — HOB 196") contains this text,
    /// ignoring case. Repeatable; a printing matching any is kept.
    #[arg(long)]
    only: Vec<String>,
    /// Write every frame with its truth (green) and detected (red) quad, and a JSON file of the
    /// per-frame figures for each card, into this directory.
    #[arg(long)]
    dump: Option<PathBuf>,
}

/// One line of the printings file.
#[derive(Debug, Clone, PartialEq)]
struct Wanted {
    id: [u8; ID_LEN],
    stratum: String,
}

/// Ids in file order, each under the most recent `# stratum:` line. Any other comment, and
/// anything after an id's `#`, is ignored.
fn parse_printings(text: &str) -> Result<Vec<Wanted>, String> {
    let mut stratum = "unstratified".to_string();
    let mut out: Vec<Wanted> = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let line = line.trim();
        if let Some(comment) = line.strip_prefix('#') {
            if let Some(name) = comment.trim().strip_prefix("stratum:") {
                stratum = name.trim().to_string();
            }
            continue;
        }
        let token = line.split('#').next().unwrap_or("").trim();
        if token.is_empty() {
            continue;
        }
        let id = parse_uuid(token)
            .ok_or_else(|| format!("line {}: {token:?} is not a Scryfall id", n + 1))?;
        if out.iter().any(|w| w.id == id) {
            return Err(format!("line {}: {token} is listed twice", n + 1));
        }
        out.push(Wanted { id, stratum: stratum.clone() });
    }
    Ok(out)
}

/// What the evaluation knows about one wanted printing, from whichever source.
#[derive(Debug, Clone)]
struct Truth {
    oracle: Option<[u8; ID_LEN]>,
    set: String,
    shown: String,
    render: Option<String>,
}

/// Every wanted printing the source knew, by id.
type Truths = HashMap<[u8; ID_LEN], Truth>;

/// One printing's label, as `Reference::add_label` takes it.
struct LabelRow {
    id: [u8; ID_LEN],
    oracle: Option<[u8; ID_LEN]>,
    illustration: Option<[u8; ID_LEN]>,
    label: Label,
}

/// The fields of a Scryfall card object the evaluation reads. Everything else is skipped by
/// the parser without being built.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct BulkCard {
    id: String,
    oracle_id: Option<String>,
    illustration_id: Option<String>,
    name: String,
    lang: String,
    set: String,
    collector_number: String,
    released_at: Option<String>,
    image_uris: Option<BulkImages>,
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct BulkImages {
    display: Option<String>,
}

/// Stream a bulk file, JSON array or JSON Lines by its first byte, handing each card to `each`.
///
/// The same sniff and the same element-at-a-time parse as `build_hashes.rs`'s reader, without
/// its thread and channel: that one had to be an iterator, and this one only has to visit.
fn read_bulk<R: BufRead>(
    mut reader: R,
    each: &mut dyn FnMut(BulkCard),
) -> Result<(), serde_json::Error> {
    let is_array = loop {
        let buf = reader.fill_buf().map_err(serde_json::Error::io)?;
        if buf.is_empty() {
            return Ok(());
        }
        match buf.iter().position(|b| !b.is_ascii_whitespace()) {
            Some(i) => {
                let first = buf[i];
                reader.consume(i);
                break first == b'[';
            }
            None => {
                let n = buf.len();
                reader.consume(n);
            }
        }
    };
    if is_array {
        let mut de = serde_json::Deserializer::from_reader(reader);
        (&mut de).deserialize_seq(Cards(each))?;
        return de.end();
    }
    for card in serde_json::Deserializer::from_reader(reader).into_iter::<BulkCard>() {
        each(card?);
    }
    Ok(())
}

struct Cards<'a>(&'a mut dyn FnMut(BulkCard));

impl<'de> Visitor<'de> for Cards<'_> {
    type Value = ();

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("an array of Scryfall card objects")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while let Some(card) = seq.next_element::<BulkCard>()? {
            (self.0)(card);
        }
        Ok(())
    }
}

/// Every label in the corpus, read once — the query `Reference::load_labels` runs.
///
/// **Not `load_labels` per session, because that is the evaluation's largest fixed cost**:
/// measured 2026-09-15 on the dev corpus (release, 117,738 rows), `load_labels` took 883 ms, of
/// which 526 ms was the query and 345 ms the `add_label` calls — and a fresh session per pass per
/// card runs it 480 times. [`labels_agree`] is what keeps this copy of the query honest.
fn rows_from_corpus(conn: &rusqlite::Connection) -> Result<Vec<LabelRow>, String> {
    let fail = |e: rusqlite::Error| format!("corpus labels: {e}");
    let mut stmt = conn
        .prepare(
            "SELECT id, illustration_id, name, set_code, collector_number, lang, released_at,
                    oracle_id
             FROM cards",
        )
        .map_err(fail)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                Label {
                    name: r.get(2)?,
                    set: r.get(3)?,
                    number: r.get(4)?,
                    lang: r.get(5)?,
                    released: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                },
                r.get::<_, Option<String>>(7)?,
            ))
        })
        .map_err(fail)?;
    Ok(rows
        .flatten()
        .filter_map(|(id, illustration, label, oracle)| {
            Some(LabelRow {
                id: parse_uuid(&id)?,
                oracle: oracle.as_deref().and_then(parse_uuid),
                illustration: illustration.as_deref().and_then(parse_uuid),
                label,
            })
        })
        .collect())
}

/// Does a reference built from `rows` answer as one built by `Reference::load_labels` does?
/// Checked once per run, so a change to that query fails the evaluation instead of quietly
/// evaluating against different labels.
fn labels_agree(bundle: &[u8], rows: &[LabelRow], conn: &rusqlite::Connection) -> Result<(), String> {
    let fresh = || Bundle::from_bytes(bundle).map(Reference::new).map_err(|e| format!("bundle: {e}"));
    let mut loaded = fresh()?;
    loaded.load_labels(conn).map_err(|e| format!("corpus labels: {e}"))?;
    let mut ours = fresh()?;
    attach(&mut ours, rows);
    let shape = |r: &Reference| (r.label_count(), r.name_count(), r.printing_count());
    if shape(&loaded) != shape(&ours) {
        return Err(format!(
            "the evaluation's label query no longer matches Reference::load_labels: \
             (labels, names, printings) {:?} against {:?}",
            shape(&ours),
            shape(&loaded)
        ));
    }
    Ok(())
}

fn attach(r: &mut Reference, rows: &[LabelRow]) {
    for row in rows {
        r.add_label(row.id, row.oracle, row.illustration, row.label.clone());
    }
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

fn render_of(image_uris: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(image_uris)
        .ok()?
        .get(RENDER)?
        .as_str()
        .map(str::to_string)
}

fn truths_from_corpus(
    conn: &rusqlite::Connection,
    wanted: &[Wanted],
) -> Result<Truths, String> {
    let mut stmt = conn
        .prepare(
            "SELECT oracle_id, set_code, name, collector_number, image_uris FROM cards WHERE id = ?1",
        )
        .map_err(|e| format!("corpus query: {e}"))?;
    let mut out = HashMap::new();
    for w in wanted {
        let row = stmt.query_row([format_uuid(&w.id)], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        });
        match row {
            Ok((oracle, set, name, number, uris)) => {
                out.insert(
                    w.id,
                    Truth {
                        oracle: oracle.as_deref().and_then(parse_uuid),
                        shown: format!("{name} — {} {number}", set.to_uppercase()),
                        set,
                        render: uris.as_deref().and_then(render_of),
                    },
                );
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {}
            Err(e) => return Err(format!("corpus query: {e}")),
        }
    }
    Ok(out)
}

/// Stream the bulk file once: every card becomes a label row, and the wanted ones a truth.
fn from_bulk(
    path: &Path,
    wanted: &[Wanted],
) -> Result<(Vec<LabelRow>, Truths), String> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("cannot open bulk file {}: {e}", path.display()))?;
    let want: std::collections::HashSet<[u8; ID_LEN]> = wanted.iter().map(|w| w.id).collect();
    let mut rows = Vec::new();
    let mut truths = HashMap::new();
    read_bulk(BufReader::new(file), &mut |card: BulkCard| {
        let Some(id) = parse_uuid(&card.id) else { return };
        let oracle = card.oracle_id.as_deref().and_then(parse_uuid);
        if want.contains(&id) {
            truths.insert(
                id,
                Truth {
                    oracle,
                    shown: format!(
                        "{} — {} {}",
                        card.name,
                        card.set.to_uppercase(),
                        card.collector_number
                    ),
                    set: card.set.clone(),
                    render: card.image_uris.as_ref().and_then(|u| u.display.clone()),
                },
            );
        }
        rows.push(LabelRow {
            id,
            oracle,
            illustration: card.illustration_id.as_deref().and_then(parse_uuid),
            label: Label {
                name: card.name,
                set: card.set,
                number: card.collector_number,
                lang: if card.lang.is_empty() { "en".to_string() } else { card.lang },
                released: card.released_at.unwrap_or_default(),
            },
        });
    })
    .map_err(|e| format!("cannot read bulk file {}: {e}", path.display()))?;
    Ok((rows, truths))
}

/// The cached render's path: the printing's id, with the extension the URL names.
fn cache_path(dir: &Path, id: &[u8; ID_LEN], url: &str) -> PathBuf {
    let ext = url
        .split('?')
        .next()
        .and_then(|p| p.rsplit('/').next())
        .and_then(|f| f.rsplit_once('.').map(|(_, e)| e))
        .filter(|e| !e.is_empty() && e.len() <= 4)
        .unwrap_or("img");
    dir.join(format!("{}.{ext}", format_uuid(id)))
}

fn fetch(url: &str) -> Result<Vec<u8>, String> {
    let mut last = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(250 * (1 << attempt)));
        }
        match ureq::get(url).header("User-Agent", USER_AGENT).call() {
            Ok(mut resp) => match resp.body_mut().read_to_vec() {
                Ok(bytes) => return Ok(bytes),
                Err(e) => last = format!("read: {e}"),
            },
            Err(ureq::Error::StatusCode(code)) if code == 404 || code == 410 => {
                return Err(format!("HTTP {code}"));
            }
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

/// What a session is built from, loaded once and shared by every worker.
struct Ingredients {
    bundle: Vec<u8>,
    labels: Vec<LabelRow>,
    detection: Vec<u8>,
    recognition: Vec<u8>,
    /// Printing to card, for the trace's "nearest other card". Empty unless tracing.
    oracles: HashMap<[u8; ID_LEN], [u8; ID_LEN]>,
}

impl Ingredients {
    /// A fresh session: the bundle, every label, and the readers.
    fn session(&self) -> Result<Session, String> {
        let bundle = Bundle::from_bytes(&self.bundle).map_err(|e| format!("bundle: {e}"))?;
        let mut reference = Reference::new(bundle);
        attach(&mut reference, &self.labels);
        let reader = TitleReader::from_bytes(&self.detection, &self.recognition)?;
        let mut session = Session::new(Some(reference), Some(reader), TOP);
        // **Inline, not the app's background thread**, so "median frames" counts frames rather
        // than how busy the machine was while a resolve ran — and so the mean ms column still
        // holds each resolve's whole wall time.
        session.set_resolve_on(ResolveOn::Inline);
        Ok(session)
    }
}

/// What one card came to in one pass.
#[derive(Debug, Clone, Default)]
struct CardResult {
    decided: bool,
    card_ok: bool,
    printing_ok: bool,
    ambiguous: bool,
    true_in_choices: bool,
    not_found: bool,
    frames_to_decision: Option<usize>,
    frames_fed: usize,
    ms: f64,
    /// Frames that reached the whole-card match — trusted, with a card detected.
    matched_frames: usize,
    /// Descriptors those frames computed, summed. See `MatchReport::hashes`.
    hashes: usize,
    /// Hashing plus searching over those frames, summed.
    match_ms: f64,
    /// One per frame fed: how far the raw quad was from the truth, `None` where nothing was
    /// detected.
    corners: Vec<Option<Corner>>,
}

impl CardResult {
    fn describe(&self) -> String {
        let at = self.frames_to_decision.unwrap_or(0);
        match (self.decided, self.printing_ok, self.card_ok) {
            (false, ..) if self.not_found => "not found".to_string(),
            (false, ..) => "undecided".to_string(),
            (true, true, _) if self.ambiguous => format!("printing ✓ (ambiguous) @{at}"),
            (true, true, _) => format!("printing ✓ @{at}"),
            (true, false, true) => format!("card ✓ @{at}"),
            (true, false, false) => format!("wrong @{at}"),
        }
    }
}

/// Feed one burst to a fresh session until its decision count moves.
fn run_pass(
    session: &mut Session,
    mode: ScanMode,
    frames: &[SynthFrame],
    id: &[u8; ID_LEN],
    truth: &Truth,
    mut trace: Option<&mut Trace<'_>>,
) -> CardResult {
    let opts = FrameOptions { mode, ..Default::default() };
    let truth_id = format_uuid(id);
    let mut out = CardResult::default();
    // A fresh session has made no decision, so the first one is the frame this leaves.
    let before = 0;
    for (i, frame) in frames.iter().enumerate() {
        let started = Instant::now();
        let v = session.frame(&frame.jpeg, &opts);
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        if let Some(t) = trace.as_deref_mut() {
            t.record(i + 1, &v, truth, out.decided);
            if out.decided {
                continue;
            }
        }
        out.ms += ms;
        out.frames_fed += 1;
        if let Some(m) = &v.r#match {
            out.matched_frames += 1;
            out.hashes += m.hashes;
            out.match_ms += f64::from(m.hash_ms + m.search_ms);
        }
        out.corners.push(v.quad_raw.map(|q| Corner::measure(&q, &frame.quad)));
        if v.resolution.as_ref().is_some_and(|r| r.outcome == Outcome::NotFound) {
            out.not_found = true;
        }
        if v.decision_seq == before {
            continue;
        }
        out.decided = true;
        out.not_found = false;
        out.frames_to_decision = Some(i + 1);
        if let Some(d) = &v.decision {
            out.printing_ok = d.printing == truth_id;
            out.card_ok = match (&truth.oracle, &d.oracle_id) {
                (Some(o), Some(got)) => format_uuid(o) == *got,
                _ => out.printing_ok,
            };
            out.ambiguous = d.outcome == Outcome::Ambiguous;
            out.true_in_choices = out.ambiguous && d.choices.iter().any(|c| c.id == truth_id);
        }
        if trace.is_none() {
            break;
        }
    }
    out
}

/// The `--trace` lines of one card's Fast pass.
struct Trace<'a> {
    oracles: &'a HashMap<[u8; ID_LEN], [u8; ID_LEN]>,
    card: String,
    stratum: &'a str,
    seed: u64,
    lines: Vec<String>,
}

impl Trace<'_> {
    /// One frame. Distances are in bits of the 256-bit descriptor; `rival` is the nearest
    /// candidate naming a different card, and when every candidate names this one it is the
    /// last candidate's distance — a floor under the true gap rather than the gap itself, and
    /// `rival_floor` says which.
    fn record(
        &mut self,
        frame: usize,
        v: &card_scanner::session::Verdict,
        truth: &Truth,
        after: bool,
    ) {
        let card_of = |id: &str| parse_uuid(id).map(|p| self.oracles.get(&p).copied().unwrap_or(p));
        let lock = v.lock.as_ref();
        let mut line = serde_json::json!({
            "card": self.card,
            "stratum": self.stratum,
            "seed": self.seed,
            "frame": frame,
            "after_decision": after,
            "detected": v.ok,
            "agree": lock.map(|l| l.agree),
            "trusted": lock.is_some_and(|l| l.is_trusted()),
            "cardness": v.cardness.as_ref().map(|c| c.score),
            "angle": v.score.as_ref().map(|s| s.max_angle_error),
            "skew": v.score.as_ref().map(|s| s.skew),
            "committed": v.tracked.as_ref().is_some_and(|t| t.committed),
            "evidence": v.tracked.as_ref().and_then(|t| t.standings.first()).map(|s| s.evidence),
        });
        if let Some(best) = v.r#match.as_ref().and_then(|m| m.candidates.first()) {
            let best_card = card_of(&best.id);
            let rival = v
                .r#match
                .iter()
                .flat_map(|m| &m.candidates)
                .find(|c| card_of(&c.id) != best_card);
            let last =
                v.r#match.iter().flat_map(|m| &m.candidates).last().map_or(0, |c| c.distance);
            line["best"] = best.distance.into();
            line["best_true"] = (best_card.is_some() && best_card == truth.oracle).into();
            line["rival"] = rival.map_or(last, |c| c.distance).into();
            line["rival_floor"] = rival.is_none().into();
        }
        self.lines.push(line.to_string());
    }
}

/// The burst's card index: the printing's id, not its line in the list.
///
/// **So editing the list moves only the rows it edits.** Keyed on position, one id inserted near
/// the top would hand every card below it a different pose, background and glare, and the whole
/// table would shift for a reason that has nothing to do with the pipeline.
fn card_index(id: &[u8; ID_LEN]) -> u64 {
    let mut head = [0u8; 8];
    head.copy_from_slice(&id[..8]);
    u64::from_le_bytes(head)
}

fn load_render(path: &Path) -> Result<RgbImage, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    Ok(image::load_from_memory(&bytes)
        .map_err(|e| format!("cannot decode {}: {e}", path.display()))?
        .to_rgb8())
}

/// Which printings of the ready list a stacked burst puts beneath printing `own`: the next two
/// others in list order, starting from `index % count`.
///
/// **This couples a card's scene to the list.** Add or drop a printing and a stacked card may
/// get different cards beneath it, so a stacked row can move for a reason that has nothing to
/// do with the detector — the price of cards beneath that are real renders rather than a
/// stand-in. `--only` does not narrow the list this reads, so a card run alone gets the stack
/// it got in the full run.
fn beneath(count: usize, own: usize, index: u64) -> Vec<usize> {
    if count == 0 {
        return Vec::new();
    }
    let start = (index % count as u64) as usize;
    (0..count).map(|k| (start + k) % count).filter(|&i| i != own).take(2).collect()
}

/// A card's burst: its render in the run's scene, with the renders beneath it when stacked.
fn card_burst(
    synth: &SynthOptions,
    scene: Scene,
    wanted: &Wanted,
    render: &Path,
    under: &[&Path],
) -> Result<Vec<SynthFrame>, String> {
    let image = load_render(render)?;
    let under = if scene == Scene::Stacked {
        under.iter().map(|p| load_render(p)).collect::<Result<Vec<_>, _>>()?
    } else {
        Vec::new()
    };
    let under: Vec<&RgbImage> = under.iter().collect();
    Ok(burst_scene(&image, synth, card_index(&wanted.id), scene, &under))
}

/// One card through every pass. `Err` only when the render cannot be read at all; a pass that
/// could not run is an `Err` inside.
fn run_card(
    ingredients: &Ingredients,
    synth: &SynthOptions,
    frames: &[SynthFrame],
    wanted: &Wanted,
    truth: &Truth,
    passes: &[(&str, ScanMode, bool)],
    trace: Option<&Mutex<Vec<String>>>,
) -> Vec<Result<CardResult, String>> {
    passes
        .iter()
        .map(|&(_, mode, own_set)| -> Result<CardResult, String> {
            let mut session = ingredients.session()?;
            if own_set {
                session.set_filters(ScanFilters { sets: vec![truth.set.clone()], ..Default::default() })?;
            }
            // Only Fast is traced: the early decision and the quick lock are Fast's alone.
            let mut t = trace.filter(|_| mode == ScanMode::Fast && !own_set).map(|_| Trace {
                oracles: &ingredients.oracles,
                card: format_uuid(&wanted.id),
                stratum: &wanted.stratum,
                seed: synth.seed,
                lines: Vec::new(),
            });
            let result = run_pass(&mut session, mode, frames, &wanted.id, truth, t.as_mut());
            if let (Some(sink), Some(t)) = (trace, t) {
                sink.lock().expect("trace").extend(t.lines);
            }
            Ok(result)
        })
        .collect()
}

/// How far a detected quad's corners were from the truth.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Corner {
    /// Mean corner distance in frame pixels, under the best cyclic pairing.
    px: f32,
    /// The same, as a fraction of the truth's height — so a small card and a large one compare.
    frac: f32,
}

impl Corner {
    fn measure(found: &[(f32, f32); 4], truth: &[(f32, f32); 4]) -> Corner {
        let px = corner_error(found, truth);
        Corner { px, frac: px / card_height(truth).max(1.0) }
    }

    fn off_card(&self) -> bool {
        self.frac > OFF_CARD
    }
}

fn distance(a: (f32, f32), b: (f32, f32)) -> f32 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

/// The mean Euclidean distance between `found`'s corners and `truth`'s, under the best of the
/// four cyclic pairings.
///
/// **Cyclic, because the detector orders a quad portrait-first with a 180° ambiguity** — its
/// TL may be the card's BR — and the synthetic card can lie at any rotation, so which corner
/// the detector calls first is not something to be graded on. Both quads run clockwise in
/// image coordinates, so a reflection is never the right pairing and is not tried.
fn corner_error(found: &[(f32, f32); 4], truth: &[(f32, f32); 4]) -> f32 {
    (0..4)
        .map(|k| (0..4).map(|i| distance(found[(i + k) % 4], truth[i])).sum::<f32>() / 4.0)
        .fold(f32::INFINITY, f32::min)
}

/// The truth quad's mean long side — the card's height in frame pixels. The truth runs TL, TR,
/// BR, BL of the card's own upright orientation, so its long sides are TR→BR and BL→TL.
fn card_height(truth: &[(f32, f32); 4]) -> f32 {
    (distance(truth[1], truth[2]) + distance(truth[3], truth[0])) / 2.0
}

/// Nearest-rank percentile of an ascending slice.
fn percentile(sorted: &[f32], p: f32) -> Option<f32> {
    if sorted.is_empty() {
        return None;
    }
    let rank = ((p * sorted.len() as f32).ceil() as usize).clamp(1, sorted.len());
    Some(sorted[rank - 1])
}

/// The corner columns over some frames: detected %, mean and p90 corner error in pixels and as a
/// share of the card's height, and off-card %. The means and percentiles are over the detected
/// frames, off-card ones included — a frame that found the art box is as much the detector's
/// answer as one that found the border.
fn corner_cells<'a>(samples: impl Iterator<Item = &'a Option<Corner>>) -> String {
    let mut fed = 0usize;
    let mut found: Vec<Corner> = Vec::new();
    for s in samples {
        fed += 1;
        found.extend(s);
    }
    let n = found.len();
    if n == 0 {
        let detected = if fed == 0 { "—".to_string() } else { "0.0".to_string() };
        return format!("{fed} | {detected} | — | — | — | — | —");
    }
    let mut px: Vec<f32> = found.iter().map(|c| c.px).collect();
    let mut frac: Vec<f32> = found.iter().map(|c| c.frac).collect();
    px.sort_by(f32::total_cmp);
    frac.sort_by(f32::total_cmp);
    let mean = |v: &[f32]| v.iter().sum::<f32>() / v.len() as f32;
    let off = found.iter().filter(|c| c.off_card()).count();
    format!(
        "{fed} | {:.1} | {:.1} | {:.2} | {:.1} | {:.2} | {:.1}",
        100.0 * n as f64 / fed as f64,
        mean(&px),
        100.0 * mean(&frac),
        percentile(&px, 0.9).unwrap_or(0.0),
        100.0 * percentile(&frac, 0.9).unwrap_or(0.0),
        100.0 * off as f64 / n as f64,
    )
}

const CORNER_HEADER: &str = "frames | detected % | mean err px | mean err % h | p90 err px | \
                             p90 err % h | off-card %";
const CORNER_RULE: &str = "---: | ---: | ---: | ---: | ---: | ---: | ---:";

/// One frame through both edge methods, keeping the more card-like — `Session::frame`'s choice.
#[derive(Debug, Clone)]
struct Probe {
    method: Option<EdgeMethod>,
    quad: Option<[(f32, f32); 4]>,
    cardness: Option<f32>,
    truth: [(f32, f32); 4],
    corner: Option<Corner>,
    /// Both detections, not the decode.
    ms: f64,
}

/// Detect one frame as `Session::frame` does, with `DetectOptions::default()` but for the
/// method — the session's `FrameOptions` defaults resolve to the same work size, thresholds,
/// aspect tolerance and card-likeness floor, and its framing list affects only the
/// rectification, never the quad. The trace is built and dropped, as the session builds it.
fn probe(frame: &SynthFrame) -> Result<Probe, String> {
    let image = image::load_from_memory(&frame.jpeg).map_err(|e| format!("decode: {e}"))?;
    let started = Instant::now();
    let mut best: Option<(EdgeMethod, Detection)> = None;
    for method in METHODS {
        let (result, _trace) = detect(&image, &DetectOptions { method, ..Default::default() });
        if let Ok(d) = result {
            if best.as_ref().is_none_or(|(_, b)| d.rank() > b.rank()) {
                best = Some((method, d));
            }
        }
    }
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    let quad = best.as_ref().map(|(_, d)| d.quad.corners);
    Ok(Probe {
        method: best.as_ref().map(|(m, _)| *m),
        quad,
        cardness: best.as_ref().map(|(_, d)| d.cardness.score),
        truth: frame.quad,
        corner: quad.map(|q| Corner::measure(&q, &frame.quad)),
        ms,
    })
}

/// A file-name-safe stem for a card: its shown name and the head of its id.
fn dump_stem(truth: &Truth, id: &[u8; ID_LEN]) -> String {
    let name: String = truth
        .shown
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect::<String>()
        .split('_')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    format!("{name}-{}", &format_uuid(id)[..8])
}

/// A closed quad drawn three pixels wide, with a dot on its first corner so the order shows.
fn draw_quad(image: &mut RgbImage, quad: &[(f32, f32); 4], colour: Rgb<u8>) {
    for i in 0..4 {
        let (a, b) = (quad[i], quad[(i + 1) % 4]);
        for dx in -1..=1 {
            for dy in -1..=1 {
                let (dx, dy) = (dx as f32, dy as f32);
                draw_line_segment_mut(image, (a.0 + dx, a.1 + dy), (b.0 + dx, b.1 + dy), colour);
            }
        }
    }
    let (x, y) = quad[0];
    draw_filled_circle_mut(image, (x.round() as i32, y.round() as i32), 5, colour);
}

/// Every frame of one card, drawn, and its figures as JSON.
fn dump_card(
    dir: &Path,
    stem: &str,
    shown: &str,
    scene: Scene,
    frames: &[SynthFrame],
    probes: &[Probe],
) -> Result<(), String> {
    let fail = |e: String| format!("dump {stem}: {e}");
    let mut rows = Vec::new();
    for (i, (frame, p)) in frames.iter().zip(probes).enumerate() {
        let mut image =
            image::load_from_memory(&frame.jpeg).map_err(|e| fail(e.to_string()))?.to_rgb8();
        draw_quad(&mut image, &p.truth, Rgb([0, 230, 0]));
        if let Some(q) = &p.quad {
            draw_quad(&mut image, q, Rgb([240, 0, 0]));
        }
        let method = p.method.map_or("none", EdgeMethod::as_str);
        let err = p.corner.map_or_else(|| "undetected".to_string(), |c| format!("{:.1}px", c.px));
        let path = dir.join(format!("{stem}-f{i:02}-{method}-{err}.jpg"));
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 90)
            .encode_image(&image)
            .map_err(|e| fail(e.to_string()))?;
        std::fs::write(&path, jpeg).map_err(|e| fail(format!("{}: {e}", path.display())))?;
        let pairs = |q: &[(f32, f32); 4]| q.iter().map(|&(x, y)| [x, y]).collect::<Vec<_>>();
        rows.push(serde_json::json!({
            "frame": i,
            "method": p.method.map(EdgeMethod::as_str),
            "corner_err_px": p.corner.map(|c| c.px),
            "corner_err_pct_height": p.corner.map(|c| 100.0 * c.frac),
            "cardness": p.cardness,
            "quad": p.quad.as_ref().map(pairs),
            "truth": pairs(&p.truth),
        }));
    }
    let json = serde_json::json!({ "card": shown, "scene": scene.as_str(), "frames": rows });
    let path = dir.join(format!("{stem}.json"));
    let text = serde_json::to_string_pretty(&json).map_err(|e| fail(e.to_string()))?;
    std::fs::write(&path, text).map_err(|e| fail(format!("{}: {e}", path.display())))
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
    slots
        .into_inner()
        .expect("slots")
        .into_iter()
        .map(|s| s.expect("every index is taken by exactly one worker"))
        .collect()
}

/// One row of the table.
fn row(pass: &str, mode: ScanMode, stratum: &str, results: &[&CardResult]) -> String {
    let n = results.len();
    let pct = |k: usize, of: usize| {
        if of == 0 {
            "—".to_string()
        } else {
            format!("{:.1}", 100.0 * k as f64 / of as f64)
        }
    };
    let count = |f: fn(&CardResult) -> bool| results.iter().filter(|&&r| f(r)).count();
    let decided = count(|r| r.decided);
    let ambiguous = count(|r| r.ambiguous);
    let exact = mode == ScanMode::Exact;
    let mut frames: Vec<usize> = results.iter().filter_map(|r| r.frames_to_decision).collect();
    frames.sort_unstable();
    let median = match frames.len() {
        0 => "—".to_string(),
        k if k % 2 == 1 => frames[k / 2].to_string(),
        k => format!("{}", (frames[k / 2 - 1] + frames[k / 2]) as f64 / 2.0),
    };
    let fed: usize = results.iter().map(|r| r.frames_fed).sum();
    let ms: f64 = results.iter().map(|r| r.ms).sum();
    let matched: usize = results.iter().map(|r| r.matched_frames).sum();
    let hashes: usize = results.iter().map(|r| r.hashes).sum();
    let match_ms: f64 = results.iter().map(|r| r.match_ms).sum();
    let per_match = |x: f64, decimals: usize| {
        if matched == 0 {
            "—".to_string()
        } else {
            format!("{:.*}", decimals, x / matched as f64)
        }
    };
    format!(
        "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |",
        pass,
        stratum,
        n,
        pct(decided, n),
        pct(count(|r| r.card_ok), n),
        pct(count(|r| r.printing_ok), n),
        if exact {
            format!("{} ({})", pct(ambiguous, n), pct(count(|r| r.true_in_choices), ambiguous))
        } else {
            "—".to_string()
        },
        if exact { pct(count(|r| r.not_found), n) } else { "—".to_string() },
        median,
        if fed == 0 { "—".to_string() } else { format!("{:.0}", ms / fed as f64) },
        per_match(hashes as f64, 2),
        per_match(match_ms, 1),
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

/// The progress line's corner figure: the mean over the detected frames, and how many there were.
fn corner_summary(samples: &[Option<Corner>]) -> String {
    let found: Vec<&Corner> = samples.iter().flatten().collect();
    if found.is_empty() {
        return format!("corners: none detected of {}", samples.len());
    }
    let n = found.len() as f32;
    let px = found.iter().map(|c| c.px).sum::<f32>() / n;
    let frac = found.iter().map(|c| c.frac).sum::<f32>() / n;
    format!("corners: {px:.1} px ({:.1}% h) on {}/{}", 100.0 * frac, found.len(), samples.len())
}

fn run(args: Args) -> Result<(), String> {
    let started = Instant::now();
    let text = std::fs::read_to_string(&args.printings)
        .map_err(|e| format!("cannot read {}: {e}", args.printings.display()))?;
    let wanted = parse_printings(&text)?;
    if wanted.is_empty() {
        return Err(format!("{} names no printings", args.printings.display()));
    }

    // ---- what a session is built from — nothing, under --detect-only ------------------------
    let session_inputs = if args.detect_only {
        None
    } else {
        let missing = |flag: &str| format!("{flag} is required unless --detect-only");
        let bundle_path = args.bundle.as_ref().ok_or_else(|| missing("--bundle"))?;
        let models = args.models.as_ref().ok_or_else(|| missing("--models"))?;
        let bundle = std::fs::read(bundle_path)
            .map_err(|e| format!("cannot read bundle {}: {e}", bundle_path.display()))?;
        let bundle_printings = Bundle::from_bytes(&bundle)
            .map_err(|e| format!("bundle {}: {e}", bundle_path.display()))?
            .cards
            .len();
        eprintln!("bundle: {bundle_printings} printings");
        let model = |name: &str| {
            let path = models.join(name);
            std::fs::read(&path).map_err(|e| format!("model {}: {e}", path.display()))
        };
        let (detection, recognition) =
            (model("text-detection.rten")?, model("text-recognition.rten")?);
        Some((bundle, bundle_printings, detection, recognition))
    };

    // ---- labels and truths, from one source ------------------------------------------------
    let (labels, truths) = if let Some(path) = &args.corpus {
        let conn = open_corpus(path)?;
        let truths = truths_from_corpus(&conn, &wanted)?;
        match &session_inputs {
            Some((bundle, ..)) => {
                let rows = rows_from_corpus(&conn)?;
                labels_agree(bundle, &rows, &conn)?;
                (rows, truths)
            }
            None => (Vec::new(), truths),
        }
    } else {
        let path = args.bulk.as_ref().expect("clap requires --corpus or --bulk");
        eprintln!("streaming {}…", path.display());
        from_bulk(path, &wanted)?
    };
    let ingredients = match session_inputs {
        Some((bundle, bundle_printings, detection, recognition)) => {
            eprintln!("labels: {} printings", labels.len());
            let oracles = if args.trace.is_some() {
                labels.iter().filter_map(|l| l.oracle.map(|o| (l.id, o))).collect()
            } else {
                HashMap::new()
            };
            let ingredients = Ingredients { bundle, labels, detection, recognition, oracles };
            // One session up front, so a bad model fails here and not once per card.
            let built = Instant::now();
            drop(ingredients.session()?);
            eprintln!("a session builds in {:.0} ms", built.elapsed().as_secs_f64() * 1000.0);
            Some((ingredients, bundle_printings))
        }
        None => None,
    };

    // ---- renders -------------------------------------------------------------------------
    std::fs::create_dir_all(&args.cache)
        .map_err(|e| format!("cannot create cache {}: {e}", args.cache.display()))?;
    let mut skipped: Vec<String> = Vec::new();
    let mut ready: Vec<(&Wanted, &Truth, PathBuf)> = Vec::new();
    let mut last_fetch: Option<Instant> = None;
    let mut fetched = 0usize;
    for w in &wanted {
        let Some(truth) = truths.get(&w.id) else {
            skipped.push(format!("{} — not in the label source", format_uuid(&w.id)));
            continue;
        };
        let Some(url) = &truth.render else {
            skipped.push(format!("{} — no {RENDER} image", truth.shown));
            continue;
        };
        let path = cache_path(&args.cache, &w.id, url);
        if !path.exists() {
            if let Some(wait) = last_fetch.and_then(|t| FETCH_SPACING.checked_sub(t.elapsed())) {
                std::thread::sleep(wait);
            }
            let result = fetch(url);
            last_fetch = Some(Instant::now());
            match result {
                Ok(bytes) => {
                    std::fs::write(&path, &bytes)
                        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
                    fetched += 1;
                }
                Err(e) => {
                    skipped.push(format!("{} — fetch {url}: {e}", truth.shown));
                    continue;
                }
            }
        }
        ready.push((w, truth, path));
    }
    eprintln!("renders: {} ready ({fetched} fetched), {} skipped", ready.len(), skipped.len());

    // `--only` narrows what is evaluated, never `ready`: a stacked card's cards beneath come
    // from the whole list, so a card run alone is the card the full run saw.
    let needles: Vec<String> = args.only.iter().map(|s| s.to_lowercase()).collect();
    let chosen: Vec<usize> = (0..ready.len())
        .filter(|&i| {
            let shown = ready[i].1.shown.to_lowercase();
            needles.is_empty() || needles.iter().any(|n| shown.contains(n.as_str()))
        })
        .collect();
    if chosen.is_empty() {
        return Err(if needles.is_empty() {
            "no printing could be evaluated".to_string()
        } else {
            format!("no ready printing's name contains any of {:?}", args.only)
        });
    }
    if let Some(dir) = &args.dump {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("cannot create dump directory {}: {e}", dir.display()))?;
    }

    // ---- the evaluation --------------------------------------------------------------------
    let synth = SynthOptions { seed: args.seed, ..Default::default() };
    let jobs = args
        .jobs
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get() / 2))
        .clamp(1, chosen.len());
    let burst_of = |r: usize| -> Result<Vec<SynthFrame>, String> {
        let (w, _, path) = &ready[r];
        let under: Vec<&Path> = beneath(ready.len(), r, card_index(&w.id))
            .into_iter()
            .map(|i| ready[i].2.as_path())
            .collect();
        card_burst(&synth, args.scene, w, path, &under)
    };
    let dump = |r: usize, frames: &[SynthFrame], probes: &[Probe]| -> Result<(), String> {
        match &args.dump {
            Some(dir) => {
                let (w, truth, _) = &ready[r];
                dump_card(dir, &dump_stem(truth, &w.id), &truth.shown, args.scene, frames, probes)
            }
            None => Ok(()),
        }
    };
    let done = AtomicUsize::new(0);
    let progress = |shown: &str| {
        format!("[{:>3}/{}] {shown}", done.fetch_add(1, Ordering::Relaxed) + 1, chosen.len())
    };
    let mut strata: Vec<&str> = Vec::new();
    for &r in &chosen {
        if !strata.contains(&ready[r].0.stratum.as_str()) {
            strata.push(&ready[r].0.stratum);
        }
    }
    let list = args
        .printings
        .file_name()
        .map_or_else(|| args.printings.display().to_string(), |f| f.to_string_lossy().into_owned());
    let evaluating = Instant::now();
    let trace: Option<Mutex<Vec<String>>> = args.trace.as_ref().map(|_| Mutex::new(Vec::new()));

    let mut md = match &ingredients {
        None => {
            let outcomes: Vec<Result<Vec<Probe>, String>> = parallel(chosen.len(), jobs, |k| {
                let r = chosen[k];
                let outcome = burst_of(r).and_then(|frames| {
                    let probes = frames.iter().map(probe).collect::<Result<Vec<_>, _>>()?;
                    dump(r, &frames, &probes)?;
                    Ok(probes)
                });
                let mut line = progress(&ready[r].1.shown);
                match &outcome {
                    Ok(probes) => {
                        let corners: Vec<Option<Corner>> =
                            probes.iter().map(|p| p.corner).collect();
                        let ms = probes.iter().map(|p| p.ms).sum::<f64>()
                            / probes.len().max(1) as f64;
                        line.push_str(&format!("  {}  {ms:.0} ms", corner_summary(&corners)));
                    }
                    Err(e) => line.push_str(&format!("  skipped: {e}")),
                }
                eprintln!("{line}");
                outcome
            });
            let mut probes: Vec<Option<Vec<Probe>>> = Vec::new();
            for (&r, outcome) in chosen.iter().zip(outcomes) {
                match outcome {
                    Ok(p) => probes.push(Some(p)),
                    Err(e) => {
                        skipped.push(format!("{} — {e}", ready[r].1.shown));
                        probes.push(None);
                    }
                }
            }
            let mut md = format!(
                "{HEADLINE}\n\nDetection only: {} printings from `{list}`, {} frames each at {} \
                 px, seed {}, scene {}, {jobs} at a time. Every frame is detected with Canny and with \
                 Otsu and the more card-like kept, as a session does. Corner error is the mean \
                 distance from the raw quad's corners to the true ones, in pixels and as a share \
                 of the card's height (h); off-card is the share of detected frames more than {}% \
                 of h out. Mean ms is both detections, under that many cards at once.\n\n",
                chosen.len(),
                synth.frames,
                synth.long_edge,
                synth.seed,
                args.scene,
                100.0 * OFF_CARD,
            );
            md.push_str(&format!("| stratum | n | {CORNER_HEADER} | mean detect ms |\n"));
            md.push_str(&format!("| --- | ---: | {CORNER_RULE} | ---: |\n"));
            for stratum in std::iter::once("all").chain(strata.iter().copied()) {
                let cards: Vec<&Vec<Probe>> = chosen
                    .iter()
                    .zip(&probes)
                    .filter(|(&r, _)| stratum == "all" || ready[r].0.stratum == stratum)
                    .filter_map(|(_, p)| p.as_ref())
                    .collect();
                let frames: Vec<&Probe> = cards.iter().flat_map(|c| c.iter()).collect();
                let corners: Vec<Option<Corner>> = frames.iter().map(|p| p.corner).collect();
                let ms = if frames.is_empty() {
                    "—".to_string()
                } else {
                    format!("{:.0}", frames.iter().map(|p| p.ms).sum::<f64>() / frames.len() as f64)
                };
                md.push_str(&format!(
                    "| {stratum} | {} | {} | {ms} |\n",
                    cards.len(),
                    corner_cells(corners.iter())
                ));
            }
            md
        }
        Some((ingredients, bundle_printings)) => {
            let passes: &[(&str, ScanMode, bool)] =
                if args.fast_only { &PASSES[..1] } else { &PASSES };
            type Outcome = Result<Vec<Result<CardResult, String>>, String>;
            let outcomes: Vec<Outcome> = parallel(chosen.len(), jobs, |k| {
                let r = chosen[k];
                let (w, truth, _) = &ready[r];
                let outcome = burst_of(r).and_then(|frames| {
                    if args.dump.is_some() {
                        let probes = frames.iter().map(probe).collect::<Result<Vec<_>, _>>()?;
                        dump(r, &frames, &probes)?;
                    }
                    Ok(run_card(ingredients, &synth, &frames, w, truth, passes, trace.as_ref()))
                });
                let mut line = progress(&truth.shown);
                match &outcome {
                    Ok(results) => {
                        for ((name, ..), r) in passes.iter().zip(results) {
                            match r {
                                Ok(r) => line.push_str(&format!("  {name}: {}", r.describe())),
                                Err(e) => line.push_str(&format!("  {name}: skipped ({e})")),
                            }
                        }
                        // Detection does not depend on the pass, so the frames a pass fed are a
                        // prefix of one list of answers, and the longest pass holds all of them.
                        let longest = results
                            .iter()
                            .flatten()
                            .max_by_key(|r| r.corners.len())
                            .map_or(&[][..], |r| r.corners.as_slice());
                        line.push_str(&format!("  {}", corner_summary(longest)));
                    }
                    Err(e) => line.push_str(&format!("  skipped: {e}")),
                }
                eprintln!("{line}");
                outcome
            });
            // results[pass][card]: `None` where that pass could not run that card.
            let mut results: Vec<Vec<Option<CardResult>>> = vec![Vec::new(); passes.len()];
            for (&r, outcome) in chosen.iter().zip(outcomes) {
                let shown = &ready[r].1.shown;
                match outcome {
                    Ok(card) => {
                        for (p, result) in card.into_iter().enumerate() {
                            if let Err(e) = &result {
                                skipped.push(format!("{shown} — {}: {e}", passes[p].0));
                            }
                            results[p].push(result.ok());
                        }
                    }
                    Err(e) => {
                        skipped.push(format!("{shown} — {e}"));
                        results.iter_mut().for_each(|r| r.push(None));
                    }
                }
            }

            // ---- the tables ----------------------------------------------------------------
            let in_stratum = |p: usize, stratum: &str| -> Vec<&CardResult> {
                results[p]
                    .iter()
                    .zip(&chosen)
                    .filter(|(_, &r)| stratum == "all" || ready[r].0.stratum == stratum)
                    .filter_map(|(res, _)| res.as_ref())
                    .collect()
            };
            let mut md = format!(
                "{HEADLINE}\n\n{} printings from `{list}`, {} frames each at {} px, seed {}, scene \
                 {}, against a bundle of {bundle_printings} printings, {jobs} at a time. \
                 Percentages are of n, and an ambiguous decision is judged on its first choice; \
                 the bracket is the share of the ambiguous whose choices held the true printing. \
                 Mean ms is wall time per frame fed with that many cards running at once — a \
                 figure under load, not a latency. Hashes and match ms are per frame that reached \
                 the whole-card match; match ms is hashing plus searching, under the same load.\n\n",
                chosen.len(),
                synth.frames,
                synth.long_edge,
                synth.seed,
                args.scene,
            );
            md.push_str(
                "| pass | stratum | n | decided % | card ✓ % | printing ✓ % | \
                 ambiguous % (true in choices %) | not found % | median frames | mean ms | \
                 hashes / match | match ms |\n",
            );
            md.push_str(
                "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n",
            );
            for (p, &(name, mode, _)) in passes.iter().enumerate() {
                for stratum in std::iter::once("all").chain(strata.iter().copied()) {
                    md.push_str(&row(name, mode, stratum, &in_stratum(p, stratum)));
                    md.push('\n');
                }
            }

            md.push_str(&format!(
                "\nCorners, over the frames each pass fed — a pass stops at its decision, so the \
                 passes cover different prefixes of the same bursts, and a frame's detection is \
                 the same in every pass that fed it. Corner error is the mean distance from the \
                 raw quad (before the rectification's inset) to the true corners, in pixels and \
                 as a share of the card's height (h); off-card is the share of detected frames \
                 more than {}% of h out.\n\n",
                100.0 * OFF_CARD
            ));
            md.push_str(&format!("| pass | stratum | {CORNER_HEADER} |\n"));
            md.push_str(&format!("| --- | --- | {CORNER_RULE} |\n"));
            for (p, &(name, ..)) in passes.iter().enumerate() {
                for stratum in std::iter::once("all").chain(strata.iter().copied()) {
                    let cards = in_stratum(p, stratum);
                    let cells = corner_cells(cards.iter().flat_map(|c| c.corners.iter()));
                    md.push_str(&format!("| {name} | {stratum} | {cells} |\n"));
                }
            }

            // The cards no pass could decide — §10's "eight always-undecided", tracked by name.
            let undecided: Vec<&str> = chosen
                .iter()
                .enumerate()
                .filter(|&(k, _)| {
                    results.iter().all(|pass| pass[k].as_ref().is_some_and(|r| !r.decided))
                })
                .map(|(_, &r)| ready[r].1.shown.as_str())
                .collect();
            md.push_str(&format!("\nUndecided in every pass: {}", undecided.len()));
            if undecided.is_empty() {
                md.push_str(".\n");
            } else {
                md.push_str("\n\n");
                for shown in &undecided {
                    md.push_str(&format!("- {shown}\n"));
                }
            }
            md
        }
    };

    if !skipped.is_empty() {
        md.push_str(&format!("\nSkipped {}:\n\n", skipped.len()));
        for s in &skipped {
            md.push_str(&format!("- {s}\n"));
        }
    }

    println!("{md}");
    if let (Some(path), Some(lines)) = (&args.trace, trace) {
        let mut text = lines.into_inner().expect("trace").join("\n");
        text.push('\n');
        std::fs::write(path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    }
    if let Some(path) = &args.summary {
        std::fs::write(path, &md).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    }
    eprintln!(
        "evaluated in {:.0}s; done in {:.0}s",
        evaluating.elapsed().as_secs_f64(),
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn printings_are_read_under_their_strata() {
        let text = "# The list.\n\
                    00000000-0000-0000-0000-000000000001\n\
                    # stratum: lands\n\
                    # a note, not a stratum\n\
                    00000000-0000-0000-0000-000000000002  # Forest — HOB 193\n\
                    \n\
                    #stratum:  eras \n\
                    00000000000000000000000000000003\n";
        let got = parse_printings(text).expect("parse");
        let strata: Vec<&str> = got.iter().map(|w| w.stratum.as_str()).collect();
        assert_eq!(strata, ["unstratified", "lands", "eras"]);
        assert_eq!(got[1].id[15], 2);

        assert!(parse_printings("not-an-id\n").unwrap_err().contains("line 1"));
        let twice = "00000000-0000-0000-0000-000000000001\n00000000-0000-0000-0000-000000000001\n";
        assert!(parse_printings(twice).unwrap_err().contains("twice"));
    }

    #[test]
    fn a_bulk_file_reads_as_lines_or_as_an_array() {
        let one = r#"{"id":"00000000-0000-0000-0000-000000000001","oracle_id":"00000000-0000-0000-0000-00000000000a","name":"Forest","lang":"en","set":"hob","collector_number":"193","released_at":"2025-01-01","image_uris":{"display":"https://cards.scryfall.io/display/front/1.webp?1"}}"#;
        let two = r#"{"id":"00000000-0000-0000-0000-000000000002","name":"Delver","set":"isd","collector_number":"51","card_faces":[{}]}"#;
        for text in [format!("{one}\n{two}\n"), format!("[\n{one},\n{two}\n]")] {
            let mut seen = Vec::new();
            read_bulk(text.as_bytes(), &mut |c| seen.push(c)).expect("read");
            assert_eq!(seen.len(), 2);
            assert_eq!(seen[0].set, "hob");
            assert!(seen[0].image_uris.as_ref().and_then(|u| u.display.as_deref()).is_some());
            assert!(seen[1].image_uris.is_none(), "a double-faced card has no top-level images");
        }
        let cut = format!("{one}\n{{\"id\":");
        assert!(read_bulk(cut.as_bytes(), &mut |_| {}).is_err(), "a truncated file must fail");
    }

    #[test]
    fn a_cached_render_keeps_its_extension() {
        let id = parse_uuid("00000000-0000-0000-0000-000000000001").unwrap();
        let p = cache_path(Path::new("c"), &id, "https://cards.scryfall.io/display/front/0/0/x.webp?17");
        assert_eq!(p, Path::new("c").join("00000000-0000-0000-0000-000000000001.webp"));
    }

    /// A 63×88 card, upright at the origin: TL, TR, BR, BL.
    const CARD: [(f32, f32); 4] = [(0.0, 0.0), (63.0, 0.0), (63.0, 88.0), (0.0, 88.0)];

    #[test]
    fn corner_error_ignores_which_corner_comes_first() {
        assert_eq!(corner_error(&CARD, &CARD), 0.0);
        for k in 1..4 {
            let turned: [(f32, f32); 4] = std::array::from_fn(|i| CARD[(i + k) % 4]);
            assert_eq!(corner_error(&turned, &CARD), 0.0, "rotation {k} was graded");
        }
    }

    #[test]
    fn corner_error_is_the_mean_corner_distance() {
        // Every corner 3 right and 4 down: 5 px each.
        let moved = CARD.map(|(x, y)| (x + 3.0, y + 4.0));
        assert!((corner_error(&moved, &CARD) - 5.0).abs() < 1e-5);
        // One corner 8 px out, the others exact: a mean of 2, not a max of 8.
        let mut one = CARD;
        one[2].0 += 8.0;
        assert!((corner_error(&one, &CARD) - 2.0).abs() < 1e-5);
        // As a share of the card's height, which is the truth's long side.
        let c = Corner::measure(&moved, &CARD);
        assert!((c.frac - 5.0 / 88.0).abs() < 1e-6);
        assert!(!c.off_card());
        assert!(Corner::measure(&CARD.map(|(x, y)| (x + 9.0, y)), &CARD).off_card());
    }

    #[test]
    fn a_card_is_never_stacked_on_itself() {
        assert_eq!(beneath(10, 3, 3), [4, 5]);
        assert_eq!(beneath(10, 9, 29), [0, 1]);
        assert_eq!(beneath(10, 2, 11), [1, 3]);
        assert_eq!(beneath(2, 0, 7), [1]);
        assert!(beneath(1, 0, 7).is_empty());
        assert!(beneath(0, 0, 7).is_empty());
    }

    #[test]
    fn the_scene_and_the_detect_only_flags_parse() {
        let base = ["eval", "--corpus", "c.db", "--printings", "p.txt", "--cache", "cache"];
        let args = Args::try_parse_from(base).expect("parse");
        assert_eq!(args.scene, Scene::Plain);
        assert!(!args.detect_only && args.bundle.is_none() && args.only.is_empty());
        let more = ["--scene", "stacked", "--detect-only", "--only", "Swamp", "--only", "hob"];
        let args = Args::try_parse_from(base.iter().chain(&more)).expect("parse");
        assert_eq!(args.scene, Scene::Stacked);
        assert!(args.detect_only);
        assert_eq!(args.only, ["Swamp", "hob"]);
        let bad = Args::try_parse_from(base.iter().chain(&["--scene", "binder"]));
        assert!(bad.is_err(), "an unknown scene parsed");
    }

    #[test]
    fn percentiles_are_nearest_rank() {
        let v: Vec<f32> = (1..=10).map(|i| i as f32).collect();
        assert_eq!(percentile(&v, 0.9), Some(9.0));
        assert_eq!(percentile(&v, 1.0), Some(10.0));
        assert_eq!(percentile(&[4.0], 0.9), Some(4.0));
        assert_eq!(percentile(&[], 0.9), None);
    }
}
