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
//!      [--seed 7] [--jobs N] [--summary eval.md]
//! ```
//!
//! For every printing in the list: fetch its render once (cached), make a burst of frames, and
//! feed the burst to three passes — **Fast**, **Exact**, and **Exact with a filter to the
//! printing's own set** — stopping at the first frame whose `decision_seq` moved. The table it
//! prints is the whole output.
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

use card_scanner::filters::ScanFilters;
use card_scanner::index::{format_uuid, parse_uuid, Bundle, ID_LEN};
use card_scanner::ocr::TitleReader;
use card_scanner::reference::{Label, Reference};
use card_scanner::session::{FrameOptions, Outcome, ScanMode, Session};
use card_scanner::synth::{burst, SynthOptions};
use clap::{ArgGroup, Parser};
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

#[derive(Parser, Debug)]
#[command(name = "eval", about = "The card scanner's synthetic evaluation")]
#[command(group(ArgGroup::new("source").required(true).args(["corpus", "bulk"])))]
struct Args {
    /// The reference bundle to evaluate.
    #[arg(long)]
    bundle: PathBuf,
    /// The app's `corpus.db`, for labels and render URLs. Opened read-only.
    #[arg(long)]
    corpus: Option<PathBuf>,
    /// Scryfall's `default_cards`, uncompressed — JSON Lines or a JSON array. Streamed.
    #[arg(long)]
    bulk: Option<PathBuf>,
    /// Directory holding `text-detection.rten` and `text-recognition.rten`.
    #[arg(long)]
    models: PathBuf,
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
}

impl Ingredients {
    /// A fresh session: the bundle, every label, and the readers.
    fn session(&self) -> Result<Session, String> {
        let bundle = Bundle::from_bytes(&self.bundle).map_err(|e| format!("bundle: {e}"))?;
        let mut reference = Reference::new(bundle);
        attach(&mut reference, &self.labels);
        let reader = TitleReader::from_bytes(&self.detection, &self.recognition)?;
        Ok(Session::new(Some(reference), Some(reader), TOP))
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
    frames: &[Vec<u8>],
    id: &[u8; ID_LEN],
    truth: &Truth,
) -> CardResult {
    let opts = FrameOptions { mode, ..Default::default() };
    let truth_id = format_uuid(id);
    let mut out = CardResult::default();
    // A fresh session has made no decision, so the first one is the frame this leaves.
    let before = 0;
    for (i, frame) in frames.iter().enumerate() {
        let started = Instant::now();
        let v = session.frame(frame, &opts);
        out.ms += started.elapsed().as_secs_f64() * 1000.0;
        out.frames_fed += 1;
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
            out.true_in_choices = out.ambiguous && d.choices.iter().any(|c| c.id == truth_id);        }
        break;
    }
    out
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

/// One card through every pass. `Err` only when the render cannot be read at all; a pass that
/// could not run is an `Err` inside.
fn run_card(
    ingredients: &Ingredients,
    synth: &SynthOptions,
    wanted: &Wanted,
    truth: &Truth,
    render: &Path,
) -> Result<Vec<Result<CardResult, String>>, String> {
    let bytes = std::fs::read(render).map_err(|e| format!("cannot read {}: {e}", render.display()))?;
    let image = image::load_from_memory(&bytes)
        .map_err(|e| format!("cannot decode {}: {e}", render.display()))?
        .to_rgb8();
    let frames = burst(&image, synth, card_index(&wanted.id));
    Ok(PASSES
        .iter()
        .map(|&(_, mode, own_set)| -> Result<CardResult, String> {
            let mut session = ingredients.session()?;
            if own_set {
                session.set_filters(ScanFilters { sets: vec![truth.set.clone()], ..Default::default() })?;
            }
            Ok(run_pass(&mut session, mode, &frames, &wanted.id, truth))
        })
        .collect())
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
    format!(
        "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |",
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
    let started = Instant::now();
    let text = std::fs::read_to_string(&args.printings)
        .map_err(|e| format!("cannot read {}: {e}", args.printings.display()))?;
    let wanted = parse_printings(&text)?;
    if wanted.is_empty() {
        return Err(format!("{} names no printings", args.printings.display()));
    }
    let bundle = std::fs::read(&args.bundle)
        .map_err(|e| format!("cannot read bundle {}: {e}", args.bundle.display()))?;
    let bundle_printings = Bundle::from_bytes(&bundle)
        .map_err(|e| format!("bundle {}: {e}", args.bundle.display()))?
        .cards
        .len();
    eprintln!("bundle: {bundle_printings} printings");
    let model = |name: &str| {
        let path = args.models.join(name);
        std::fs::read(&path).map_err(|e| format!("model {}: {e}", path.display()))
    };
    let (detection, recognition) = (model("text-detection.rten")?, model("text-recognition.rten")?);

    // ---- labels and truths, from one source ------------------------------------------------
    let (labels, truths) = if let Some(path) = &args.corpus {
        let conn = open_corpus(path)?;
        let rows = rows_from_corpus(&conn)?;
        labels_agree(&bundle, &rows, &conn)?;
        (rows, truths_from_corpus(&conn, &wanted)?)
    } else {
        let path = args.bulk.as_ref().expect("clap requires --corpus or --bulk");
        eprintln!("streaming {}…", path.display());
        from_bulk(path, &wanted)?
    };
    eprintln!("labels: {} printings", labels.len());
    let ingredients = Ingredients { bundle, labels, detection, recognition };
    // One session up front, so a bad model fails here and not once per card.
    let built = Instant::now();
    drop(ingredients.session()?);
    eprintln!("a session builds in {:.0} ms", built.elapsed().as_secs_f64() * 1000.0);

    // ---- renders -------------------------------------------------------------------------
    std::fs::create_dir_all(&args.cache)
        .map_err(|e| format!("cannot create cache {}: {e}", args.cache.display()))?;
    let mut skipped: Vec<String> = Vec::new();
    let mut cards: Vec<(&Wanted, &Truth, PathBuf)> = Vec::new();
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
        cards.push((w, truth, path));
    }
    eprintln!("renders: {} ready ({fetched} fetched), {} skipped", cards.len(), skipped.len());
    if cards.is_empty() {
        return Err("no printing could be evaluated".to_string());
    }

    // ---- the evaluation --------------------------------------------------------------------
    let synth = SynthOptions { seed: args.seed, ..Default::default() };
    let jobs = args
        .jobs
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get() / 2))
        .clamp(1, cards.len());
    type Slot = Option<Result<Vec<Result<CardResult, String>>, String>>;
    let slots: Mutex<Vec<Slot>> = Mutex::new(vec![None; cards.len()]);
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let evaluating = Instant::now();
    std::thread::scope(|scope| {
        for _ in 0..jobs {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some((w, truth, path)) = cards.get(index) else { break };
                    let outcome = run_card(&ingredients, &synth, w, truth, path);
                    let mut line = format!(
                        "[{:>3}/{}] {}",
                        done.fetch_add(1, Ordering::Relaxed) + 1,
                        cards.len(),
                        truth.shown
                    );
                    match &outcome {
                        Ok(passes) => {
                            for ((name, ..), r) in PASSES.iter().zip(passes) {
                                match r {
                                    Ok(r) => line.push_str(&format!("  {name}: {}", r.describe())),
                                    Err(e) => line.push_str(&format!("  {name}: skipped ({e})")),
                                }
                            }
                        }
                        Err(e) => line.push_str(&format!("  skipped: {e}")),
                    }
                    eprintln!("{line}");
                    slots.lock().expect("slots")[index] = Some(outcome);
                }
            });
        }
    });
    let slots = slots.into_inner().expect("slots");
    // results[pass][card]: `None` where that pass could not run that card.
    let mut results: Vec<Vec<Option<CardResult>>> = vec![Vec::new(); PASSES.len()];
    for ((_, truth, _), slot) in cards.iter().zip(slots) {
        match slot {
            Some(Ok(passes)) => {
                for (p, r) in passes.into_iter().enumerate() {
                    if let Err(e) = &r {
                        skipped.push(format!("{} — {}: {e}", truth.shown, PASSES[p].0));
                    }
                    results[p].push(r.ok());
                }
            }
            Some(Err(e)) => {
                skipped.push(format!("{} — {e}", truth.shown));
                results.iter_mut().for_each(|r| r.push(None));
            }
            None => unreachable!("every card index is taken by exactly one worker"),
        }
    }

    // ---- the table -------------------------------------------------------------------------
    let mut strata: Vec<&str> = Vec::new();
    for (w, ..) in &cards {
        if !strata.contains(&w.stratum.as_str()) {
            strata.push(&w.stratum);
        }
    }
    let list = args
        .printings
        .file_name()
        .map_or_else(|| args.printings.display().to_string(), |f| f.to_string_lossy().into_owned());
    let mut md = format!(
        "{HEADLINE}\n\n{} printings from `{list}`, {} frames each at {} px, seed {}, against a \
         bundle of {bundle_printings} printings, {jobs} at a time. Percentages are of n, and an \
         ambiguous decision is judged on its first choice; the bracket is the share of the \
         ambiguous whose choices held the true printing. Mean ms is \
         wall time per frame fed with that many cards running at once — a figure under load, \
         not a latency.\n\n",
        cards.len(),
        synth.frames,
        synth.long_edge,
        synth.seed,
    );
    md.push_str(
        "| pass | stratum | n | decided % | card ✓ % | printing ✓ % | \
         ambiguous % (true in choices %) | not found % | median frames | mean ms |\n",
    );
    md.push_str("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n");
    for (p, &(name, mode, _)) in PASSES.iter().enumerate() {
        let all: Vec<&CardResult> = results[p].iter().flatten().collect();
        md.push_str(&row(name, mode, "all", &all));
        md.push('\n');
        for stratum in &strata {
            let some: Vec<&CardResult> = results[p]
                .iter()
                .zip(&cards)
                .filter(|(_, (w, ..))| w.stratum == *stratum)
                .filter_map(|(r, _)| r.as_ref())
                .collect();
            md.push_str(&row(name, mode, stratum, &some));
            md.push('\n');
        }
    }
    if !skipped.is_empty() {
        md.push_str(&format!("\nSkipped {}:\n\n", skipped.len()));
        for s in &skipped {
            md.push_str(&format!("- {s}\n"));
        }
    }

    println!("{md}");
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
}
