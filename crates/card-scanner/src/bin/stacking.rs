//! The two measurements behind the appearance watch (#710): how far apart one card's frames
//! are against a different card laid in the same place (`gap`), and what a whole session makes
//! of a card stacked on a decided one (`sequence`).
//!
//! ```text
//! cargo run --release --features builder --bin stacking -- gap \
//!     crates/card-scanner/eval/printings.txt .scanner-bundle/eval-cache
//! cargo run --release --features builder --bin stacking -- sequence \
//!     crates/card-scanner/eval/printings.txt .scanner-bundle/eval-cache \
//!     .scanner-bundle/card-hashes-v5.bin src-tauri/target/debug/data/corpus.db \
//!     .scanner-bundle/models
//! ```
//!
//! The renders are the evaluation's cache (`eval --cache`), one `<id>.webp` per printing. Each
//! card is posed by `synth::burst` exactly as the evaluation poses it; the card laid on top is
//! the next printing in the same stratum, posed with the first card's seed — the same pose,
//! glare and background, which is what laying it on top looks like.
//!
//! **`gap`** runs the session's own detector sweep and quad lock and compares the rectified
//! cards directly, in several descriptors: a held card's frames against one another, the card
//! on top against the held card, a basic land against the same basic from the next set in the
//! list (a second copy the tray must add), and the held card under a hand. Every comparison is
//! made against the one frame before (`K = 1`) and as the nearest of the four before (`K = 4`).
//!
//! **`sequence`** runs whole sessions, both modes, against the real bundle, labels and readers:
//! the first card held for [`HOLD`] frames, a hand passing over it, then the next card on top
//! for [`ON_TOP`]. It counts how often the held card is decided — more than once is a second
//! tray row for one card — and the frames from the card on top's first frame to its decision.
//! A second session per pile lifts the hand again with nothing laid on top, for [`AGAIN`]
//! frames, and counts the same: a hand at rest over the card is the watch's one blind spot.
//! It uses nothing but [`Session`], so it builds against a tree from before the watch too.
//!
//! **Synthetic**, like the evaluation: a fence and a threshold, not a claim about a camera.

use card_scanner::detect::{detect, rectify_views, DetectOptions, EdgeMethod, Quad};
use card_scanner::hash::{hash, Descriptor, HashKind};
use card_scanner::index::{format_uuid, parse_uuid, Bundle, ID_LEN};
use card_scanner::lock::QuadLock;
use card_scanner::ocr::TitleReader;
use card_scanner::reference::{Label, Reference};
use card_scanner::session::{FrameOptions, ScanMode, Session};
use card_scanner::synth::{burst, SynthOptions};
use image::{GrayImage, Rgb, RgbImage};
use std::collections::HashMap;
use std::path::Path;

/// The descriptors compared, each on a 0–256 scale: bits for a hash, and `(1 − r) × 128` for a
/// normalized cross-correlation `r` of a thumbnail — 0 identical, 128 unrelated.
const KINDS: [&str; 5] = [
    "dhash luma 256 bits",
    "dhash luma 128 bits",
    "ncc gray 16×22",
    "ncc gray 8×11",
    "ncc rgb 12×17",
];
/// How many earlier frames the `K = 4` rows take the nearest of.
const RING: usize = 4;

/// One view of a card in every kind.
#[derive(Clone)]
struct View {
    d256: Descriptor,
    d128: Descriptor,
    g16: Vec<f32>,
    g8: Vec<f32>,
    c12: Vec<f32>,
}

/// A trusted frame, upright and turned.
#[derive(Clone)]
struct Look {
    up: View,
    turned: View,
}

/// Zero mean and unit length, so a dot product is the correlation.
fn normalized(mut v: Vec<f32>) -> Vec<f32> {
    let mean = v.iter().sum::<f32>() / v.len() as f32;
    v.iter_mut().for_each(|x| *x -= mean);
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
    v.iter_mut().for_each(|x| *x /= norm);
    v
}

fn gray_thumb(g: &GrayImage, w: u32, h: u32) -> Vec<f32> {
    normalized(image::imageops::thumbnail(g, w, h).pixels().map(|p| p[0] as f32).collect())
}

fn view(img: &RgbImage) -> View {
    let gray = image::DynamicImage::ImageRgb8(img.clone()).to_luma8();
    let rgb = image::imageops::thumbnail(img, 12, 17);
    View {
        d256: hash(&gray, HashKind::DHash, 256),
        d128: hash(&gray, HashKind::DHash, 128),
        g16: gray_thumb(&gray, 16, 22),
        g8: gray_thumb(&gray, 8, 11),
        c12: normalized(rgb.pixels().flat_map(|p| p.0.map(f32::from)).collect()),
    }
}

fn ncc(a: &[f32], b: &[f32]) -> u32 {
    let r: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    ((1.0 - r.clamp(-1.0, 1.0)) * 128.0).round() as u32
}

fn bits(a: &Descriptor, b: &Descriptor, scale: u32) -> u32 {
    a.distance(b).unwrap_or(256) * scale
}

fn kind_distance(k: usize, a: &View, b: &View) -> u32 {
    match k {
        0 => bits(&a.d256, &b.d256, 1),
        1 => bits(&a.d128, &b.d128, 2),
        2 => ncc(&a.g16, &b.g16),
        3 => ncc(&a.g8, &b.g8),
        _ => ncc(&a.c12, &b.c12),
    }
}

impl Look {
    /// Orientation-free: the nearer of the two relative turns.
    fn distance(&self, other: &Look, k: usize) -> u32 {
        kind_distance(k, &self.up, &other.up).min(kind_distance(k, &self.up, &other.turned))
    }

    /// The nearest of `ring`.
    fn nearest(&self, ring: &[Look], k: usize) -> u32 {
        ring.iter().map(|r| self.distance(r, k)).min().unwrap_or(256)
    }
}

fn look(up: &RgbImage, turned: &RgbImage) -> Look {
    Look { up: view(up), turned: view(turned) }
}

/// Covered fractions of the card for the hand, from its bottom-right corner.
const HANDS: [f32; 4] = [0.05, 0.10, 0.20, 0.35];

struct Card {
    id: [u8; 16],
    name: String,
    stratum: String,
    render: RgbImage,
}

fn card_index(id: &[u8; 16]) -> u64 {
    let mut head = [0u8; 8];
    head.copy_from_slice(&id[..8]);
    u64::from_le_bytes(head)
}

/// The printings file, in order, with each id's stratum, the name its comment gives, and its
/// cached render. A missing render is skipped and counted.
fn load(printings: &Path, cache: &Path) -> (Vec<Card>, usize) {
    let text = std::fs::read_to_string(printings).expect("read the printings file");
    let mut stratum = String::from("unstratified");
    let (mut cards, mut missing) = (Vec::new(), 0);
    for line in text.lines().map(str::trim) {
        if let Some(c) = line.strip_prefix('#') {
            if let Some(name) = c.trim().strip_prefix("stratum:") {
                stratum = name.trim().to_string();
            }
            continue;
        }
        let mut parts = line.splitn(2, '#');
        let token = parts.next().unwrap_or("").trim();
        let name = parts.next().unwrap_or("").trim().to_string();
        let Some(id) = parse_uuid(token) else { continue };
        match image::open(cache.join(format!("{token}.webp"))) {
            Ok(img) => {
                cards.push(Card { id, name, stratum: stratum.clone(), render: img.to_rgb8() })
            }
            Err(_) => missing += 1,
        }
    }
    (cards, missing)
}

/// A skin-toned blob over the card's bottom-right corner, covering `frac` of its area — a
/// thumb resting on the card, inside its outline so the quad is untouched.
fn with_hand(card: &RgbImage, frac: f32) -> RgbImage {
    let (w, h) = (card.width() as f32, card.height() as f32);
    // A quarter ellipse at the corner with radii r·w and r·h covers π r² / 4 of the card.
    let r = (4.0 * frac / std::f32::consts::PI).sqrt();
    let mut out = card.clone();
    for (x, y, p) in out.enumerate_pixels_mut() {
        let dx = (w - x as f32) / (r * w);
        let dy = (h - y as f32) / (r * h);
        let d = dx * dx + dy * dy;
        if d <= 1.0 {
            // Shaded towards the edge, as a rounded thing under a lamp is.
            let shade = 1.0 - 0.35 * d;
            *p = Rgb([(226.0 * shade) as u8, (176.0 * shade) as u8, (148.0 * shade) as u8]);
        }
    }
    out
}

/// The session's own sweep and lock, over one burst: both detectors, the more card-like wins,
/// and a trusted frame is rectified from the lock's quad. Each frame's detected quad comes back
/// too, so a second lock can be walked through the same burst without detecting it again.
fn looks(frames: &[Vec<u8>], lock: &mut QuadLock) -> Vec<(Option<Quad>, Option<Look>)> {
    frames
        .iter()
        .map(|jpeg| {
            let source = image::load_from_memory(jpeg).expect("a synthetic frame decodes");
            let mut best: Option<(DetectOptions, card_scanner::detect::Detection)> = None;
            for method in [EdgeMethod::Canny, EdgeMethod::Otsu] {
                // Settled: a decided card is what is being watched, and the session drops the
                // extra framings once it is.
                let opts = DetectOptions { method, query_insets: Vec::new(), ..Default::default() };
                if let (Ok(d), _) = detect(&source, &opts) {
                    if best.as_ref().is_none_or(|(_, b)| d.cardness.score > b.cardness.score) {
                        best = Some((opts, d));
                    }
                }
            }
            let quad = best.as_ref().map(|(_, d)| d.quad);
            let state = lock.observe(quad);
            let seen = best.and_then(|(opts, d)| {
                let held: Quad = state.quad.filter(|_| state.is_trusted())?;
                if held.corners == d.quad.corners {
                    return Some(look(&d.rectified, &d.rectified_180));
                }
                let v = rectify_views(&source.to_rgb8(), &held, &opts)?;
                Some(look(&v.rectified, &v.rectified_180))
            });
            (quad, seen)
        })
        .collect()
}

/// A lock that has watched `quads` — the first card's burst, replayed without detecting it.
fn primed(quads: &[Option<Quad>]) -> QuadLock {
    let mut lock = QuadLock::default();
    for q in quads {
        lock.observe(*q);
    }
    lock
}

/// The trusted looks of `render`, posed with `seed`, under a lock that has already watched
/// `quads`.
fn stacked(
    render: &RgbImage,
    synth: &SynthOptions,
    seed: u64,
    quads: &[Option<Quad>],
) -> Vec<Look> {
    looks(&burst(render, synth, seed), &mut primed(quads))
        .into_iter()
        .filter_map(|(_, l)| l)
        .collect()
}

/// Distributions, by name, for one kind.
#[derive(Default)]
struct Tally {
    rows: Vec<(String, Vec<u32>)>,
}

impl Tally {
    fn push(&mut self, row: &str, v: u32) {
        match self.rows.iter_mut().find(|(n, _)| n == row) {
            Some((_, vs)) => vs.push(v),
            None => self.rows.push((row.to_string(), vec![v])),
        }
    }
}

#[derive(Default)]
struct Run {
    kinds: Vec<Tally>,
    /// `(median K = 4 distance in kind 0, first card, card on top)` for every stacked pair.
    pairs: Vec<(u32, String, String)>,
    cards: usize,
    untrusted: usize,
}

fn median(mut v: Vec<u32>) -> u32 {
    v.sort_unstable();
    v.get(v.len() / 2).copied().unwrap_or(0)
}

fn run(cards: &[Card], i: usize, synth: &SynthOptions, r: &mut Run) {
    if r.kinds.is_empty() {
        r.kinds = (0..KINDS.len()).map(|_| Tally::default()).collect();
    }
    let a = &cards[i];
    let seed = card_index(&a.id);
    let first = looks(&burst(&a.render, synth, seed), &mut QuadLock::default());
    r.untrusted += first.iter().filter(|(_, l)| l.is_none()).count();
    let quads: Vec<Option<Quad>> = first.iter().map(|(q, _)| *q).collect();
    let held: Vec<Look> = first.into_iter().filter_map(|(_, l)| l).collect();
    if held.len() < 2 {
        return;
    }
    r.cards += 1;
    // The decided card's last frames: what a watch keeping `RING` of them would hold.
    let ring = &held[held.len().saturating_sub(RING)..];
    let last = std::slice::from_ref(&held[held.len() - 1]);

    // The next card in the stratum, laid on top; the lock carries on from the first card's.
    let next = (i + 1..cards.len()).chain(0..i).find(|&j| cards[j].stratum == a.stratum);
    let on_top = match next.filter(|&j| j != i) {
        Some(j) => stacked(&cards[j].render, synth, seed, &quads),
        None => Vec::new(),
    };
    if let Some(j) = next.filter(|&j| j != i) {
        let d: Vec<u32> = on_top.iter().map(|l| l.nearest(ring, 0)).collect();
        if !d.is_empty() {
            r.pairs.push((median(d), a.name.clone(), cards[j].name.clone()));
        }
    }
    // Basics are listed five to a set in the same order, so five on is the same basic again.
    let basics = a.stratum == "basic-lands";
    let reprint = match cards.get(i + 5).filter(|b| basics && b.stratum == a.stratum) {
        Some(b) => stacked(&b.render, synth, seed, &quads),
        None => Vec::new(),
    };
    let covered: Vec<Vec<Look>> =
        HANDS.iter().map(|&f| stacked(&with_hand(&a.render, f), synth, seed, &quads)).collect();

    for (k, t) in r.kinds.iter_mut().enumerate() {
        for f in 1..held.len() {
            t.push("same card, K = 1", held[f].distance(&held[f - 1], k));
            t.push("same card, K = 4", held[f].nearest(&held[f.saturating_sub(RING)..f], k));
        }
        for l in &on_top {
            t.push("different card, K = 1", l.nearest(last, k));
            t.push("different card, K = 4", l.nearest(ring, k));
            if basics {
                t.push("… basic on basic, K = 4", l.nearest(ring, k));
            }
        }
        for pair in on_top.windows(2) {
            t.push("card on top at rest, consecutive", pair[1].distance(&pair[0], k));
        }
        for l in &reprint {
            t.push("same basic, another set, K = 4", l.nearest(ring, k));
        }
        for (h, looks) in covered.iter().enumerate() {
            for l in looks {
                t.push(&format!("hand over {:.0}%, K = 4", HANDS[h] * 100.0), l.nearest(ring, k));
            }
        }
    }
}

fn summary(name: &str, v: &mut [u32]) -> String {
    v.sort_unstable();
    let q = |p: f32| v[((v.len() - 1) as f32 * p).round() as usize];
    format!(
        "| {name} | {} | {} | {} | {} | {} | {} | {} | {} | {} |",
        v.len(),
        v[0],
        q(0.001),
        q(0.01),
        q(0.05),
        q(0.5),
        q(0.95),
        q(0.99),
        v[v.len() - 1]
    )
}

/// Half the logical cores, as the evaluation's `--jobs` defaults to.
fn workers() -> usize {
    std::thread::available_parallelism().map_or(4, |n| n.get() / 2).max(1)
}

/// `f(i)` for every card index, shared out over [`workers`] threads; results in card order.
fn over_cards<T: Send>(n: usize, f: impl Fn(usize) -> T + Sync) -> Vec<T> {
    let workers = workers();
    let mut out: Vec<(usize, T)> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..workers)
            .map(|w| {
                let f = &f;
                s.spawn(move || (w..n).step_by(workers).map(|i| (i, f(i))).collect::<Vec<_>>())
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().expect("a worker panicked")).collect()
    });
    out.sort_by_key(|(i, _)| *i);
    out.into_iter().map(|(_, t)| t).collect()
}

fn gap(cards: &[Card], missing: usize) {
    let synth = SynthOptions::default();
    let workers = workers();
    let started = std::time::Instant::now();
    let runs: Vec<Run> = over_cards(cards.len(), |i| {
        let mut r = Run::default();
        run(cards, i, &synth, &mut r);
        r
    });
    let mut all =
        Run { kinds: (0..KINDS.len()).map(|_| Tally::default()).collect(), ..Default::default() };
    for r in runs {
        all.cards += r.cards;
        all.untrusted += r.untrusted;
        all.pairs.extend(r.pairs);
        for (t, x) in all.kinds.iter_mut().zip(r.kinds) {
            for (name, vs) in x.rows {
                for v in vs {
                    t.push(&name, v);
                }
            }
        }
    }
    println!(
        "{} of {} cards reached two trusted frames ({} renders missing), {} untrusted frames of \
         the first burst, {} workers, {:.0} s",
        all.cards,
        cards.len(),
        missing,
        all.untrusted,
        workers,
        started.elapsed().as_secs_f32()
    );
    for (k, t) in all.kinds.iter_mut().enumerate() {
        println!("\n### {} — on a 0–256 scale, orientation-free\n", KINDS[k]);
        println!("| distribution | n | min | p0.1 | p1 | p5 | p50 | p95 | p99 | max |");
        println!("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
        // Same-card rows first, then the rest in a stable order.
        t.rows.sort_by_key(|(n, _)| (!n.starts_with("same card"), n.clone()));
        for (name, vs) in t.rows.iter_mut() {
            println!("{}", summary(name, vs));
        }
    }
    all.pairs.sort();
    println!("\n### The closest stacked pairs — median K = 4 distance, {}\n", KINDS[0]);
    for (d, a, b) in all.pairs.iter().take(12) {
        println!("- {d}: {b} on {a}");
    }
}

// ---- sequence: whole sessions over a stacked pile -----------------------------------------

/// Frames the first card is held for. It decides in about ten; the other twenty are where a
/// watch that mistook the card's own jitter for a new card would decide it a second time.
const HOLD: usize = 30;
/// A hand passing over the held card, one frame per covered fraction — each unlike the last,
/// which is what a moving hand is.
const HAND: [f32; 3] = [0.10, 0.35, 0.20];
/// Frames of the card laid on top. Long enough for the rule before the watch — ten frames to
/// lift the freeze, eight to decide — to finish too, so the two can be compared.
const ON_TOP: usize = 30;
/// Frames of the first card alone again after the hand, where no card was laid on top.
const AGAIN: usize = 10;

/// One printing's label, read once and attached to every session.
struct Row {
    id: [u8; ID_LEN],
    oracle: Option<[u8; ID_LEN]>,
    illustration: Option<[u8; ID_LEN]>,
    label: Label,
}

/// What every session is built from, loaded once.
struct Ingredients {
    bundle: Vec<u8>,
    rows: Vec<Row>,
    detection: Vec<u8>,
    recognition: Vec<u8>,
}

impl Ingredients {
    fn load(bundle: &Path, corpus: &Path, models: &Path) -> Ingredients {
        let read = |p: &Path| std::fs::read(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
        let conn = rusqlite::Connection::open_with_flags(
            corpus,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("open the corpus");
        let mut stmt = conn
            .prepare(
                "SELECT id, illustration_id, name, set_code, collector_number, lang, released_at,
                        oracle_id
                 FROM cards",
            )
            .expect("the corpus has a cards table");
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
            .expect("read the labels")
            .flatten()
            .filter_map(|(id, illustration, label, oracle)| {
                Some(Row {
                    id: parse_uuid(&id)?,
                    oracle: oracle.as_deref().and_then(parse_uuid),
                    illustration: illustration.as_deref().and_then(parse_uuid),
                    label,
                })
            })
            .collect();
        Ingredients {
            bundle: read(bundle),
            rows,
            detection: read(&models.join("text-detection.rten")),
            recognition: read(&models.join("text-recognition.rten")),
        }
    }

    /// A fresh session, as the evaluation makes one per card per pass.
    fn session(&self) -> Session {
        let mut reference = Reference::new(Bundle::from_bytes(&self.bundle).expect("the bundle"));
        for r in &self.rows {
            reference.add_label(r.id, r.oracle, r.illustration, r.label.clone());
        }
        let reader = TitleReader::from_bytes(&self.detection, &self.recognition).expect("models");
        Session::new(Some(reference), Some(reader), 5)
    }
}

/// What one pile came to in one mode. Every count is of decisions that **add** a tray row: one
/// that `replaces_previous` is a second opinion on the row before it, not a second copy.
#[derive(Default, Clone)]
struct Pile {
    /// Rows added while the first card was held or covered. One is right; two is a second row.
    held: usize,
    held_right: bool,
    /// Frames from the card on top's first frame to its first decision.
    on_top_at: Option<usize>,
    on_top_right: bool,
    /// Rows added after the card on top's first. More is a second row for it.
    on_top_again: usize,
    /// The two share an oracle card — the same card reprinted — so "right" cannot tell them
    /// apart.
    same_card: bool,
    /// Rows added in a second session with no card on top: the first card held, the hand over
    /// it, and the hand lifted again. More than one is a hand that read as a new card.
    hand_lifted: usize,
    /// Decisions that replaced the row before them, across both sessions — what a change the
    /// watch made in error costs when the card it forgot is decided again.
    replaced: usize,
}

/// Feed `frames` to `session`; for each frame whose decision is new, `(frame index, the oracle
/// card it names, whether it adds a row)`.
fn decisions(
    session: &mut Session,
    frames: &[Vec<u8>],
    opts: &FrameOptions,
) -> Vec<(usize, String, bool)> {
    let mut seq = 0;
    let mut out = Vec::new();
    for (i, jpeg) in frames.iter().enumerate() {
        let v = session.frame(jpeg, opts);
        if v.decision_seq == seq {
            continue;
        }
        seq = v.decision_seq;
        let d = v.decision.as_ref();
        let adds = !d.is_some_and(|d| d.replaces_previous);
        out.push((i, d.and_then(|d| d.oracle_id.clone()).unwrap_or_default(), adds));
    }
    out
}

fn pile(
    ing: &Ingredients,
    oracle: &HashMap<[u8; ID_LEN], String>,
    a: &Card,
    b: &Card,
    mode: ScanMode,
) -> Pile {
    let seed = card_index(&a.id);
    let opts = |frames| SynthOptions { frames, ..SynthOptions::default() };
    let mut frames = burst(&a.render, &opts(HOLD), seed);
    for (n, &f) in HAND.iter().enumerate() {
        let covered = burst(&with_hand(&a.render, f), &opts(n + 1), seed);
        frames.push(covered[n].clone());
    }
    let first_on_top = frames.len();
    frames.extend(burst(&b.render, &opts(ON_TOP), seed));

    let truth = |c: &Card| oracle.get(&c.id).cloned().unwrap_or_else(|| format_uuid(&c.id));
    let (a_card, b_card) = (truth(a), truth(b));
    let mut out = Pile { same_card: a_card == b_card, ..Pile::default() };
    let frame_opts = FrameOptions { mode, ..FrameOptions::default() };

    // The hand lifting off the card it covered: the first card again, where the jitter left it.
    let mut lifted = frames[..first_on_top].to_vec();
    lifted.extend(burst(&a.render, &opts(HOLD + AGAIN), seed).into_iter().skip(HOLD));
    for (_, _, adds) in decisions(&mut ing.session(), &lifted, &frame_opts) {
        if adds {
            out.hand_lifted += 1;
        } else {
            out.replaced += 1;
        }
    }

    for (i, named, adds) in decisions(&mut ing.session(), &frames, &frame_opts) {
        if !adds {
            out.replaced += 1;
        } else if i < first_on_top {
            out.held += 1;
            out.held_right |= named == a_card;
        } else if out.on_top_at.is_none() {
            out.on_top_at = Some(i - first_on_top + 1);
            out.on_top_right = named == b_card;
        } else {
            out.on_top_again += 1;
        }
    }
    out
}

fn percentile(v: &[usize], p: f32) -> String {
    if v.is_empty() {
        return "—".into();
    }
    v[((v.len() - 1) as f32 * p).round() as usize].to_string()
}

fn sequence(cards: &[Card], missing: usize, bundle: &Path, corpus: &Path, models: &Path) {
    let started = std::time::Instant::now();
    let ing = Ingredients::load(bundle, corpus, models);
    let oracle: HashMap<[u8; ID_LEN], String> =
        ing.rows.iter().filter_map(|r| Some((r.id, format_uuid(&r.oracle?)))).collect();
    let next = |i: usize| {
        (i + 1..cards.len()).chain(0..i).find(|&j| j != i && cards[j].stratum == cards[i].stratum)
    };
    let modes = [("Fast", ScanMode::Fast), ("Exact", ScanMode::Exact)];
    let piles: Vec<Vec<Pile>> = over_cards(cards.len(), |i| match next(i) {
        Some(j) => {
            modes.iter().map(|&(_, m)| pile(&ing, &oracle, &cards[i], &cards[j], m)).collect()
        }
        None => Vec::new(),
    });
    println!(
        "{} piles of two ({} renders missing), the first card held {HOLD} frames, a hand over it \
         for {}, the next laid on top for {ON_TOP}; {} workers, {:.0} s",
        piles.iter().filter(|p| !p.is_empty()).count(),
        missing,
        HAND.len(),
        workers(),
        started.elapsed().as_secs_f32()
    );
    println!(
        "\n| mode | piles | held card decided | added twice | on top decided | on top card ✓ \
         | frames to it p50 / p90 / max | on top added again | added twice, hand lifted \
         | replaced |"
    );
    println!("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (m, (name, _)) in modes.iter().enumerate() {
        let ps: Vec<&Pile> = piles.iter().filter_map(|p| p.get(m)).collect();
        let n = ps.len();
        let pct = |k: usize| format!("{:.1}%", 100.0 * k as f64 / n.max(1) as f64);
        let mut at: Vec<usize> = ps.iter().filter_map(|p| p.on_top_at).collect();
        at.sort_unstable();
        println!(
            "| {name} | {n} | {} | {} | {} | {} | {} / {} / {} | {} | {} | {} |",
            pct(ps.iter().filter(|p| p.held >= 1 && p.held_right).count()),
            ps.iter().filter(|p| p.held >= 2).count(),
            pct(at.len()),
            pct(ps.iter().filter(|p| p.on_top_right && !p.same_card).count()),
            percentile(&at, 0.5),
            percentile(&at, 0.9),
            at.last().map_or("—".into(), |m| m.to_string()),
            ps.iter().map(|p| p.on_top_again).sum::<usize>(),
            ps.iter().filter(|p| p.hand_lifted >= 2).count(),
            ps.iter().map(|p| p.replaced).sum::<usize>(),
        );
    }
    let same = piles.iter().filter(|p| p.first().is_some_and(|p| p.same_card)).count();
    println!("\n{same} piles lay a reprint of the same card on top; \"card ✓\" leaves them out.");
}

fn main() {
    let args: Vec<String> =
        std::env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["gap", printings, cache] => {
            let (cards, missing) = load(Path::new(printings), Path::new(cache));
            gap(&cards, missing);
        }
        ["sequence", printings, cache, bundle, corpus, models] => {
            let (cards, missing) = load(Path::new(printings), Path::new(cache));
            sequence(&cards, missing, Path::new(bundle), Path::new(corpus), Path::new(models));
        }
        _ => {
            eprintln!(
                "usage: stacking gap <printings.txt> <render cache>\n       stacking sequence \
                 <printings.txt> <render cache> <bundle> <corpus.db> <models dir>"
            );
            std::process::exit(2);
        }
    }
}
