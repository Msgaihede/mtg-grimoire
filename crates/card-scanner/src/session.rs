//! One frame in, one verdict out — the per-frame pipeline both callers share.
//!
//! The debug server (`bin/serve.rs`) and the app (`src-tauri/src/scanner.rs`) each hand a
//! JPEG and a [`FrameOptions`] to a [`Session`] and get a [`Verdict`] back. Everything that
//! decides a frame lives here once: the detector sweep, the quad lock, the rectification from
//! the lock's quad, the descriptor and the search, the two readers and their cadence, the
//! tracker, and the panic guard. What stays with each caller is transport: a query string or
//! an IPC header in, JSON out, plus the server's log line and dump directory.
//!
//! **Two modes share that loop** ([`ScanMode`]). Fast is the vote rule over the hash, with a
//! title read only after [`FAST_RESCUE_AFTER`] leaderless locked frames. Exact keeps the last
//! [`EXACT_BURST`] locked frames and, once the lock has held, runs [`crate::resolve`] over them
//! once per card and commits the tracker on its answer. Both count decisions in
//! [`Verdict::decision_seq`], and both search under the session's filters
//! ([`Session::set_filters`]).
//!
//! **The JSON keys are the debug page's.** `live.html` reads them by name and is not
//! changing, so [`Verdict`] is snake case and
//! `session::tests::every_key_the_debug_page_reads_is_in_the_verdict` scrapes the page for
//! the keys it reads and fails when one leaves.

use crate::cardness::Cardness;
use crate::detect::{
    detect, rectify_views, DetectOptions, DetectTimings, DetectTrace, Detection, EdgeMethod,
    QuadScore,
};
use crate::filters::ScanFilters;
use crate::hash::{hash, HashKind};
use crate::index::{format_uuid, parse_uuid, Mask};
use crate::lock::{LockState, QuadLock};
use crate::reference::{Label, MatchReport, Reference};
use crate::resolve::{BurstView, NoReaders};
pub use crate::resolve::{ChoiceView, Outcome, ResolutionView, TierView};
use crate::track::{CommitRule, Observation, Tracked, Tracker, TrackerOptions};
use crate::trim::Margin;
use image::RgbImage;
use std::collections::VecDeque;

/// **The readers run only while the hash tier is still unsure, and never more than every few
/// frames.** Reading a title costs **~340 ms against a ~350 ms frame** (release, measured
/// 2026-09-08 — `docs/reference/card-scanner.md` §4 and §7), so running them on every frame
/// would roughly halve the rate to answer a question that is usually
/// already answered. They are a tie-breaker: they earn their cost exactly when appearance has
/// failed — a foil under a lamp, where the hash's top five do not contain the card at all and
/// the title is still perfectly legible.
pub const OCR_EVERY: u64 = 4;

/// Fast mode's readers wait for this many consecutive locked frames with no decision.
///
/// A common card decides on the hash in about eight frames, so a reader that ran from the
/// first locked frame spent a third of a second per read on cards that never needed one. Past
/// this, the hash has had its chance and the title read is the rescue it exists to be.
pub const FAST_RESCUE_AFTER: u32 = 8;
/// Exact mode resolves once the lock has held, with a card detected, for this many frames.
pub const EXACT_STEADY_FRAMES: u32 = 3;
/// How many locked frames an Exact resolve reads over — the ring buffer's length.
pub const EXACT_BURST: usize = 3;

/// The two ways a session decides.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScanMode {
    /// The vote rule over the hash, with a title read as a rescue after a leaderless stretch.
    #[default]
    Fast,
    /// The lock, then a tier pipeline over a burst of frames — see [`crate::resolve`].
    Exact,
}

/// The OCR reader — [`crate::ocr::TitleReader`] when the `ocr` feature is on.
///
/// **The name exists under every feature set, and that is the point.** [`Session::new`]'s
/// signature must not change shape with a feature: when the parameter itself was
/// `#[cfg(feature = "ocr")]`, a plain `cargo test` with no features compiled these tests
/// against a two-argument constructor and went red — and so did rust-analyzer, which reads
/// the crate with default features.
#[cfg(feature = "ocr")]
pub type Reader = crate::ocr::TitleReader;

/// Without the `ocr` feature there is no reader, so this is uninhabited and `None` is the only
/// `Option<Reader>` that can be built. Every branch that would use one is `#[cfg]`ed out.
#[cfg(not(feature = "ocr"))]
pub enum Reader {}

/// Which edge detector runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    Canny,
    Otsu,
    /// Both detectors, and card-likeness picks the winner.
    #[default]
    Both,
}

impl Method {
    /// The query-string spelling, which is also the JSON one. Anything unknown is `Both`.
    pub fn parse(s: &str) -> Method {
        match s {
            "canny" => Method::Canny,
            "otsu" => Method::Otsu,
            _ => Method::Both,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Method::Canny => "canny",
            Method::Otsu => "otsu",
            Method::Both => "both",
        }
    }

    fn edge_methods(self) -> Vec<EdgeMethod> {
        match self {
            Method::Canny => vec![EdgeMethod::Canny],
            Method::Otsu => vec![EdgeMethod::Otsu],
            Method::Both => vec![EdgeMethod::Canny, EdgeMethod::Otsu],
        }
    }
}

/// Everything a caller can change between frames. Every field has a default, so a JSON object
/// with any subset of them parses, and `{}` is the page's sliders as they start.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct FrameOptions {
    pub work_long_edge: u32,
    pub method: Method,
    pub canny_low: f32,
    pub canny_high: f32,
    pub aspect_tolerance: f32,
    pub min_cardness: f32,
    /// Return the binary and contour images as well as the quad. Roughly doubles the response
    /// time, so a page asks for it only while its pipeline panel is open.
    pub stages: bool,
    /// How the tracker decides — votes toward a bar, or the two-way confidence contest.
    ///
    /// **Chosen per frame by the caller, so the two rules can be A/B'd on one held card
    /// without a rebuild.** [`Tracker::set_options`] keeps the tally, so flipping the segment
    /// or dragging a slider re-judges the evidence already gathered rather than starting over.
    pub rule: CommitRule,
    /// Votes the leader needs under the vote rule.
    pub decide_at: f32,
    /// How far ahead of its best rival the leader must be to decide.
    pub lead_margin: f32,
    /// Fast or Exact. Changing it between frames resets the tracker and any resolution.
    pub mode: ScanMode,
}

impl Default for FrameOptions {
    fn default() -> Self {
        FrameOptions {
            work_long_edge: 1024,
            method: Method::Both,
            canny_low: 40.0,
            canny_high: 100.0,
            aspect_tolerance: 0.18,
            min_cardness: crate::cardness::MIN_SCORE,
            stages: false,
            rule: CommitRule::Votes,
            decide_at: 8.0,
            lead_margin: 1.3,
            mode: ScanMode::Fast,
        }
    }
}

impl FrameOptions {
    /// The clamps live here rather than at the parse, so a caller that builds a `FrameOptions`
    /// by hand — over IPC, say — cannot hand the tracker a bar it could never reach.
    pub fn tracker_options(&self) -> TrackerOptions {
        TrackerOptions {
            rule: self.rule,
            decide_at: self.decide_at.clamp(0.5, 100.0),
            lead_margin: self.lead_margin.clamp(1.0, 5.0),
            ..Default::default()
        }
    }

    fn detect_options(&self, method: EdgeMethod, settled: bool) -> DetectOptions {
        DetectOptions {
            method,
            work_long_edge: self.work_long_edge.clamp(240, 2048),
            canny_low: self.canny_low,
            canny_high: self.canny_high,
            aspect_tolerance: self.aspect_tolerance,
            min_cardness: self.min_cardness,
            // **The extra framings are dropped once the card has been named.** Measured on a
            // 720 px frame they cost 63 ms against 112 — more than half the frame again, and
            // almost all of it in building the descriptors rather than searching them. That is
            // worth paying while the answer is in doubt and worth nothing after: the tracker
            // has committed, and three framings of a card it has already identified buy a few
            // bits of distance on a question nobody is asking any more.
            //
            // The same shape as the OCR tier, and for the same reason — an expensive tier
            // stands down when the cheap one has settled it.
            query_insets: if settled { Vec::new() } else { DetectOptions::default().query_insets },
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FrameSize {
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Stages {
    pub binary: Option<String>,
    pub contours: Option<String>,
    pub quad: Option<String>,
}

/// One accumulated candidate with its label resolved — the tracker deals in ids and a page
/// needs names, and `track` is deliberately independent of the corpus.
#[derive(Debug, Clone, serde::Serialize)]
pub struct StandingView {
    pub id: String,
    pub evidence: f32,
    pub share: f32,
    pub seen: u32,
    pub label: Option<Label>,
    pub best_distance: f32,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TrackedView {
    pub committed: bool,
    pub confidence: f32,
    pub rule: CommitRule,
    pub decide_at: f32,
    pub lead: Option<f32>,
    pub frozen: bool,
    pub streak: u32,
    pub frames: u32,
    pub misses: u32,
    pub standings: Vec<StandingView>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CollectorTry {
    pub set: String,
    pub number: String,
    pub matched: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CollectorView {
    pub raw: String,
    pub rotated: bool,
    pub elapsed_ms: f32,
    pub pairings: usize,
    pub tried: Vec<CollectorTry>,
    pub more: usize,
    pub band: Option<String>,
    pub matched: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OcrView {
    pub raw: String,
    /// The form the name lookup actually compares, which is not what the recogniser returned
    /// — punctuation and case are stripped from both sides. A read that looks right and
    /// matches nothing is usually a character this dropped.
    pub normalized: String,
    pub rotated: bool,
    pub elapsed_ms: f32,
    pub band: Option<String>,
    pub matched: Option<String>,
    pub edits: Option<u32>,
}

/// The card a session has decided on — present on every committed frame.
///
/// **What a tray row is made from.** The page adds one when [`Verdict::decision_seq`] changes
/// and never otherwise; this says what to add.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DecisionView {
    /// The printing: Fast's tracked best member, Exact's first choice.
    pub printing: String,
    /// `None` when the corpus has no oracle for the printing.
    pub oracle_id: Option<String>,
    pub label: Option<Label>,
    /// Always `resolved` in Fast; the resolve's own outcome in Exact.
    pub outcome: Outcome,
    /// Empty in Fast; the resolve's choices, best first, in Exact.
    pub choices: Vec<ChoiceView>,
    /// **This decision is a second opinion on the card the last one named, not a second copy of
    /// it** — so the page replaces that row rather than adding one.
    ///
    /// True when the previous decision named the same oracle card and the quad lock has stayed
    /// trusted ever since: the reader switched Fast to Exact to pin the printing, or changed a
    /// filter, with one physical card on the mat throughout. A stretch break — the card taken
    /// away, or the lock lost — forgets the previous decision, so the same card presented again
    /// is `false` and adds. The same on every frame of one decision.
    pub replaces_previous: bool,
}

/// What one frame came to. The keys are the debug page's — see the module doc.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Verdict {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub frame: FrameSize,
    pub decode_ms: f32,
    /// Whether a bundle is loaded at all — "no bundle" and "a bundle is loaded but this frame
    /// held no card" are different states, and the page said the former for both until this
    /// existed.
    pub matcher: bool,
    pub lock: Option<LockState>,
    /// The lock's smoothed quad, which is what an overlay draws: raw detection jitters by a
    /// few pixels on a perfectly still card, and a twitching box reads as a broken detector.
    pub quad: Option<[(f32, f32); 4]>,
    /// This frame's own quad, for showing the jitter the smoothing removes.
    pub quad_raw: Option<[(f32, f32); 4]>,
    pub method: Option<String>,
    pub cardness: Option<Cardness>,
    pub rejected_cardness: Option<Cardness>,
    /// Background cut off the rectification, per side. Worth showing rather than silently
    /// applying: a trim that fires every frame means the quad is running wide, which is a
    /// detector problem this only papers over.
    pub trim: Option<Margin>,
    /// Whether this frame's card came from the lock's quad or its own. A stream that says
    /// `true` constantly is a detector failing behind a lock that is covering for it, which is
    /// worth seeing rather than being rescued from silently.
    pub from_lock: bool,
    pub score: Option<QuadScore>,
    pub hash: Option<String>,
    /// The rectified card, always returned when there was one: it is the payload a reader
    /// actually wants to see, one small JPEG, and the proof the homography is right.
    pub rectified: Option<String>,
    pub timings: Option<DetectTimings>,
    pub candidates_examined: Option<usize>,
    pub stages: Option<Stages>,
    pub r#match: Option<MatchReport>,
    pub tracked: Option<TrackedView>,
    pub collector: Option<CollectorView>,
    pub ocr: Option<OcrView>,
    /// Which mode judged this frame.
    pub mode: ScanMode,
    /// Moves once per new decision — a Fast commit, or an Exact resolve that found something —
    /// and on no other frame.
    ///
    /// **This is what makes "one add per card" a property of the session rather than of the
    /// page's timing.** A dropped frame, a re-render or a second listener cannot add a card
    /// twice, because the number did not change.
    pub decision_seq: u64,
    /// The decided card, on every committed frame. See [`DecisionView`].
    pub decision: Option<DecisionView>,
    /// On the frame an Exact resolve ran, what it came to and what each tier did.
    pub resolution: Option<ResolutionView>,
}

impl Verdict {
    fn failed(
        error: String,
        frame: FrameSize,
        decode_ms: f32,
        matcher: bool,
        mode: ScanMode,
        decision_seq: u64,
    ) -> Verdict {
        Verdict {
            ok: false,
            error: Some(error),
            frame,
            decode_ms,
            matcher,
            mode,
            decision_seq,
            decision: None,
            resolution: None,
            lock: None,
            quad: None,
            quad_raw: None,
            method: None,
            cardness: None,
            rejected_cardness: None,
            trim: None,
            from_lock: false,
            score: None,
            hash: None,
            rectified: None,
            timings: None,
            candidates_examined: None,
            stages: None,
            r#match: None,
            tracked: None,
            collector: None,
            ocr: None,
        }
    }
}

/// The reader cadence, as a free function so both [`Session::reader_due`] and the frame itself
/// can advance the same counter. Inside `frame_inner` the reference is already borrowed out of
/// `self`, and a `&mut self` method call there would not compile where a disjoint field borrow
/// does.
///
/// **The counter counts *eligible* frames, not all of them.** A committed card returns early
/// without advancing, so a freeze — which can last as long as the card is held there — consumes
/// no cadence slots, and when a swap ends the decision the reader fires on the first frame it is
/// eligible for rather than up to three frames later.
fn due(seq: &mut u64, committed: bool) -> bool {
    if committed {
        return false;
    }
    let n = *seq;
    *seq += 1;
    n.is_multiple_of(OCR_EVERY)
}

/// The per-frame reader, as a free function for the reason [`due`] is one.
///
/// **Fast mode only, and only after [`FAST_RESCUE_AFTER`] leaderless locked frames.** Before
/// that a frame is hash only and does not advance the cadence, so the first eligible frame
/// reads. Exact reads once per card inside its resolve and never per frame.
fn fast_reader_due(mode: ScanMode, leaderless_locked: u32, seq: &mut u64, committed: bool) -> bool {
    if mode != ScanMode::Fast || leaderless_locked < FAST_RESCUE_AFTER {
        return false;
    }
    due(seq, committed)
}

/// One locked frame's views, owned, so an Exact resolve can read over the last few of them.
struct StoredView {
    rectified: RgbImage,
    rectified_180: RgbImage,
    alternates: Vec<(RgbImage, RgbImage)>,
    cardness: f32,
}

impl StoredView {
    fn view(&self) -> BurstView<'_> {
        BurstView {
            upright: &self.rectified,
            flipped: &self.rectified_180,
            alternates: &self.alternates,
            cardness: self.cardness,
        }
    }
}

/// The sentence a filter gets when there are no labels to build a mask from.
const FILTERS_NEED_LABELS: &str =
    "Filters need card names, and the scanner has none loaded — it needs corpus.db beside the bundle.";

/// One scanning session: the reference, the reader, and the two things that remember across
/// frames — the tracker and the quad lock. One per camera.
///
/// Both of those are per-session rather than per-frame because they are the deliberately
/// stateful part of the pipeline: a stable answer is a property of the *stream*, not of any
/// one frame, and staying still is a property of the sequence.
pub struct Session {
    reference: Option<Reference>,
    reader: Option<Reader>,
    tracker: Tracker,
    lock: QuadLock,
    /// Frames since the session started, for the reader's cadence.
    seq: u64,
    top: usize,
    /// What the filters admit, applied to every tier. [`Mask::all`] until filters are set.
    mask: Mask,
    filters: ScanFilters,
    mode: ScanMode,
    /// Decisions so far. Survives a reset and a mode switch — a page keys tray rows on it, and
    /// a number that went back to a value it had already shown would add nothing next time.
    decision_seq: u64,
    /// Whether the previous observed frame was committed, so a new decision is seen once.
    was_committed: bool,
    /// Locked frames with a detection and no decision — Fast's rescue counter. Reset by a commit,
    /// and by the stretch breaking on the same definition Exact uses: the lock stops being
    /// trusted. A trusted frame whose detector missed neither counts nor resets it.
    leaderless_locked: u32,
    /// Trusted frames with a detection in this stretch. See [`Session::count_stretch`].
    steady: u32,
    /// An Exact resolve already ran for the card in frame. Cleared only by a re-arm being taken
    /// (see `rearm_pending`) or a reset.
    attempted: bool,
    /// The last [`EXACT_BURST`] locked frames, in Exact.
    burst: VecDeque<StoredView>,
    /// The resolve the current Exact decision was made on. Only ever `Some` while `attempted`
    /// is true: the two are set at the resolve and cleared together.
    last_resolution: Option<ResolutionView>,
    /// The stretch has broken since the last resolve, so `attempted` and `last_resolution`
    /// clear as soon as no resolve's freeze is holding. See [`Session::record_decision`].
    rearm_pending: bool,
    /// The oracle card the last emitted decision named, held only while the quad lock has stayed
    /// trusted since — what [`DecisionView::replaces_previous`] is asked against. Cleared by a
    /// stretch break and by [`Session::reset`]; **kept** through a mode switch and a filter
    /// change, which is the whole point of it.
    previous_card: Option<String>,
    /// `(decision_seq, replaces_previous)` for the decision now standing, so every frame of one
    /// decision reports the answer its first frame was given.
    standing: (u64, bool),
}

impl Session {
    pub fn new(reference: Option<Reference>, reader: Option<Reader>, top: usize) -> Session {
        Session {
            reference,
            reader,
            tracker: Tracker::default(),
            lock: QuadLock::default(),
            seq: 0,
            top: top.clamp(1, 25),
            mask: Mask::all(),
            filters: ScanFilters::default(),
            mode: ScanMode::default(),
            decision_seq: 0,
            was_committed: false,
            leaderless_locked: 0,
            steady: 0,
            attempted: false,
            burst: VecDeque::with_capacity(EXACT_BURST + 1),
            last_resolution: None,
            rearm_pending: false,
            previous_card: None,
            standing: (0, false),
        }
    }

    /// Narrow every tier to the printings these filters admit.
    ///
    /// Empty filters always succeed and lift the mask. Anything else needs labels to build a
    /// mask from — a bundle alone knows ids, not sets or dates — and has to admit at least one
    /// printing; a refusal is a sentence and keeps the filters already in force. A change resets
    /// the tracker (not the lock — see [`Session::forget_card`]), because evidence gathered
    /// against a different candidate set is evidence about a different question.
    ///
    /// **The filters already in force are not a change** ([`ScanFilters::same_as`]): nothing is
    /// reset and the mask is not rebuilt. The page sends the stored filters every time the
    /// Scanner mounts, and a reset there wiped a decided card still on the mat, which then
    /// decided again and was added to the tray a second time.
    pub fn set_filters(&mut self, f: ScanFilters) -> Result<(), String> {
        if f.same_as(&self.filters) {
            self.filters = f;
            return Ok(());
        }
        let mask = if f.is_empty() {
            Mask::all()
        } else {
            let r = self
                .reference
                .as_ref()
                .filter(|r| r.label_count() > 0)
                .ok_or_else(|| FILTERS_NEED_LABELS.to_string())?;
            let mask = r.mask_for(&f);
            if mask.len() == Some(0) {
                return Err("No printing matches these filters.".to_string());
            }
            mask
        };
        self.mask = mask;
        self.filters = f;
        self.forget_card();
        Ok(())
    }

    /// Change mode. A switch forgets the card ([`Session::forget_card`]); the same mode again is
    /// not a switch.
    fn set_mode(&mut self, mode: ScanMode) {
        if mode != self.mode {
            self.mode = mode;
            self.forget_card();
        }
    }

    /// The filters in force.
    pub fn filters(&self) -> &ScanFilters {
        &self.filters
    }

    pub fn has_reference(&self) -> bool {
        self.reference.is_some()
    }

    /// Always `false` without the `ocr` feature, because [`Reader`] is uninhabited there.
    pub fn has_reader(&self) -> bool {
        self.reader.is_some()
    }

    /// Forget the card: the reader pressed reset, or moved on. So a new card can be started
    /// immediately instead of waiting for the previous one's evidence to decay.
    ///
    /// Clears the burst, the stretch counters and any resolution too, and the previous decision
    /// a later one could replace — a reader who pressed reset asked for the next decision to be
    /// news. Not `decision_seq`: see the field.
    pub fn reset(&mut self) {
        self.forget_card();
        self.lock.reset();
        self.previous_card = None;
    }

    /// What a settings change forgets: the tracker's evidence, the burst, the stretch counters
    /// and any resolution — everything [`Session::reset`] does **except the quad lock and the
    /// previous decision**.
    ///
    /// **The lock is geometry, and a mode or a filter says nothing about where the card is.**
    /// Resetting it too put the lock back to acquiring on a card that never moved, and the
    /// untrusted frames of re-acquisition are a stretch break — which forgot the previous
    /// decision, so "Fast said Forest, switch to Exact to pin the printing" could never be told
    /// apart from a second Forest and added the card twice.
    fn forget_card(&mut self) {
        self.tracker.reset();
        self.burst.clear();
        self.steady = 0;
        self.leaderless_locked = 0;
        self.attempted = false;
        self.was_committed = false;
        self.last_resolution = None;
        self.rearm_pending = false;
    }

    /// Should the readers run on this frame? In Fast mode, once [`FAST_RESCUE_AFTER`] locked
    /// frames have gone without a decision: then every `OCR_EVERY`-th *eligible* frame, and
    /// never once committed — an expensive tier stands down when the cheap one has settled it,
    /// and the frames it stood down for do not count against its turn. See [`due`]. Never in
    /// Exact, which reads inside its resolve.
    pub fn reader_due(&mut self, committed: bool) -> bool {
        fast_reader_due(self.mode, self.leaderless_locked, &mut self.seq, committed)
    }

    /// Count one frame into the stretch. `trusted` is the lock's verdict, `detected` whether
    /// this frame found a card, `settled` whether the tracker was committed going into it.
    ///
    /// **A stretch is the run of frames the lock stays trusted.** Only a lock that stops being
    /// trusted breaks it, and a broken stretch forgets its burst and its counts. It does not
    /// forget the resolve: it *arms* a re-arm (`rearm_pending`), which
    /// [`Session::record_decision`] takes unless a resolve's own freeze is still holding. So one
    /// card can span two stretches: a one-frame degenerate quad drops the lock for two frames on
    /// a card that never moved, the freeze outlasts that blip, and the decided card is neither
    /// resolved nor added again — while a card actually taken away releases the freeze and lets
    /// the next one resolve.
    ///
    /// A trusted frame whose detector missed changes nothing: it neither counts toward the
    /// stretch nor ends it.
    fn count_stretch(&mut self, trusted: bool, detected: bool, settled: bool) {
        if !trusted {
            self.steady = 0;
            self.leaderless_locked = 0;
            self.rearm_pending = true;
            self.burst.clear();
            // The card may have changed hands: a decision after this is a new card, never a
            // second opinion on the last one.
            self.previous_card = None;
        } else if detected {
            self.steady += 1;
            if !settled {
                self.leaderless_locked += 1;
            }
        }
    }

    /// The bookkeeping after the tracker has observed a frame.
    ///
    /// In Fast, a commit the previous frame did not have is a new decision. Exact counts its
    /// decisions where they are made, at the resolve, so a freeze lifting and re-forming inside
    /// one stretch — a hash that prefers another card than the one the reads resolved — can
    /// never decide the held card twice. Either way a commit ends the leaderless run.
    ///
    /// A re-arm armed by a broken stretch is taken here, on every observed frame, unless a
    /// freeze **a resolve made** is still holding — that is the decided card, blipped. A freeze
    /// the votes made after a `NotFound` holds nothing back: that card was never decided, and
    /// "the next steady stretch tries again" (spec §6.4). This is the only place a re-arm is
    /// taken; a verdict changed between frames by `set_options` is seen here one frame later.
    fn record_decision(&mut self, committed: bool) {
        if self.mode == ScanMode::Fast && committed && !self.was_committed {
            self.decision_seq += 1;
        }
        if committed {
            self.leaderless_locked = 0;
        }
        if self.rearm_pending && (!committed || self.last_resolution.is_none()) {
            self.attempted = false;
            self.last_resolution = None;
            self.rearm_pending = false;
        }
        self.was_committed = committed;
    }

    /// The decided card, on a committed frame.
    fn decision_view(&self, t: &Tracked) -> Option<DecisionView> {
        if !t.committed {
            return None;
        }
        let r = self.reference.as_ref();
        match self.mode {
            ScanMode::Fast => {
                let mut printing = t.leader()?.best_member;
                // A card decided on read names alone has no printing in its tally — a name
                // abstains on the printing (`Observation::from_ocr`) — so the tracker reports the
                // card's key. A decision names a printing, so it takes the card's first permitted
                // one rather than passing the oracle id off as one.
                if let Some(r) = r.filter(|r| r.label_for(&printing).is_none()) {
                    if let Some(p) = r.printings_of(&printing).iter().find(|p| self.mask.permits(p)) {
                        printing = *p;
                    }
                }
                Some(DecisionView {
                    printing: format_uuid(&printing),
                    oracle_id: r.and_then(|r| r.oracle_id_of(&printing)).map(|o| format_uuid(&o)),
                    label: r.and_then(|r| r.label_for(&printing)),
                    outcome: Outcome::Resolved,
                    choices: Vec::new(),
                    replaces_previous: false,
                })
            }
            ScanMode::Exact => {
                let res = self.last_resolution.as_ref()?;
                let first = res.choices.first()?;
                Some(DecisionView {
                    printing: first.id.clone(),
                    oracle_id: first.oracle_id.clone(),
                    label: first.label.clone(),
                    outcome: res.outcome,
                    choices: res.choices.clone(),
                    replaces_previous: false,
                })
            }
        }
    }

    /// Whether the standing decision replaces the one before it — decided on its first frame
    /// and repeated on every later one. See [`DecisionView::replaces_previous`].
    ///
    /// The first frame of a decision is the first frame carrying one whose `decision_seq` is not
    /// the standing one. It compares against the previous card and then becomes it.
    fn replaces_previous(&mut self, d: &DecisionView) -> bool {
        if self.standing.0 != self.decision_seq {
            let replaces =
                d.oracle_id.is_some() && self.previous_card.as_deref() == d.oracle_id.as_deref();
            self.previous_card = d.oracle_id.clone();
            self.standing = (self.decision_seq, replaces);
        }
        self.standing.1
    }

    /// One frame. **Never panics**: the options come from sliders and the image crates assert
    /// on arguments they consider impossible — `edges::canny` panics outright when the low
    /// threshold exceeds the high one. Measured on the debug server before the guard existed:
    /// one slider drag killed every worker thread and exited the server. A tool that dies
    /// while you are adjusting it is worse than one that reports the failure and carries on.
    pub fn frame(&mut self, jpeg: &[u8], opts: &FrameOptions) -> Verdict {
        self.guarded(|s| s.frame_inner(jpeg, opts))
    }

    /// The guard itself, taking the body rather than being written inline in [`Session::frame`].
    ///
    /// **Because there is no longer an input that provokes it, and a guard nothing can reach
    /// is a guard nothing can test.** `detect::canny_pair` now orders and floors the pair
    /// before `imageproc::edges::canny` sees it, so the crossed thresholds that used to kill
    /// a worker thread come back as an ordinary "no card". The guard stays — the next
    /// assertion in those crates will not announce itself either — and this seam is how the
    /// test drives a body that really does panic.
    fn guarded(&mut self, body: impl FnOnce(&mut Session) -> Verdict) -> Verdict {
        let matcher = self.reference.is_some();
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| body(self))) {
            Ok(v) => v,
            Err(_) => Verdict::failed(
                "the detector panicked on this frame — see the log for the assertion".into(),
                FrameSize { w: 0, h: 0 },
                0.0,
                matcher,
                self.mode,
                self.decision_seq,
            ),
        }
    }

    fn frame_inner(&mut self, jpeg: &[u8], opts: &FrameOptions) -> Verdict {
        // A mode switch forgets the card before anything reads the session, so even a frame
        // that fails to decode reports the mode it was judged in.
        self.set_mode(opts.mode);
        let matcher = self.reference.is_some();
        let decode_started = std::time::Instant::now();
        let source = match image::load_from_memory(jpeg) {
            Ok(i) => i,
            Err(e) => {
                return Verdict::failed(
                    format!("decode: {e}"),
                    FrameSize { w: 0, h: 0 },
                    0.0,
                    matcher,
                    self.mode,
                    self.decision_seq,
                )
            }
        };
        let decode_ms = decode_started.elapsed().as_secs_f32() * 1000.0;
        let frame = FrameSize { w: source.width(), h: source.height() };

        // The caller's rule and bar, applied before anything reads the verdict: the tally is
        // kept, only the judgement of it changes.
        //
        // **Exact holds the rule at votes.** A resolve commits through the vote rule's freeze
        // (`Tracker::commit_to`); under the confidence rule that freeze lifts on the next frame,
        // the next resolve runs at once, and every second frame would be a new decision.
        let mut tracker_options = opts.tracker_options();
        if self.mode == ScanMode::Exact {
            tracker_options.rule = CommitRule::Votes;
        }
        self.tracker.set_options(tracker_options);
        // Asked once, before the loop, so both detectors and the re-rectify below all see the
        // same decision.
        let settled = self.tracker.last_committed();

        // ---- detect: the sweep over the methods, card-likeness picks the winner ------------
        let mut best: Option<(EdgeMethod, Detection, Option<DetectTrace>)> = None;
        let mut fallback_trace: Option<DetectTrace> = None;
        let mut error = None;
        for m in opts.method.edge_methods() {
            let (result, trace) = detect(&source, &opts.detect_options(m, settled));
            match result {
                Ok(d) => {
                    // **Card-likeness picks the method, not the geometric score.** Measured, it
                    // predicts a good match 83% of the time against geometry's 62% — and more
                    // to the point here, geometry made the winner alternate between Canny and
                    // Otsu from frame to frame, handing back a different quad each time.
                    // Nothing can lock onto a target that changes every frame, and a card that
                    // appears for one frame and vanishes is what that looks like from outside.
                    if best.as_ref().is_none_or(|(_, b, _): &(_, Detection, _)| {
                        d.cardness.score > b.cardness.score
                    }) {
                        best = Some((m, d, trace));
                    }
                }
                Err(e) => {
                    error = Some(e.to_string());
                    if trace.is_some() {
                        fallback_trace = trace;
                    }
                }
            }
        }

        let mut v =
            Verdict::failed(String::new(), frame, decode_ms, matcher, self.mode, self.decision_seq);
        v.ok = best.is_some();
        v.error = None;

        // ---- lock -------------------------------------------------------------------------
        // The lock decides whether this frame is worth believing. Nothing is rejected on
        // appearance — a quad simply has to still be there next frame.
        let lock_state = self.lock.observe(best.as_ref().map(|(_, d, _)| d.quad));
        v.quad = lock_state.quad.map(|q| q.corners);
        let trusted = lock_state.is_trusted();
        let held_quad = lock_state.quad;
        v.lock = Some(lock_state);
        self.count_stretch(trusted, best.is_some(), settled);
        // Whatever the tracker made of this frame, for the decision bookkeeping at the end.
        let mut tracked: Option<Tracked> = None;

        // ---- rectify from the quad the lock holds, not the one this frame found ------------
        //
        // The two are usually within a few pixels, and the few pixels were already worth
        // removing: the descriptor is sensitive enough to framing that a jittering quad hands
        // the matcher a slightly different card every frame. But the case that matters is the
        // other one. The detector sometimes returns something degenerate on an otherwise fine
        // frame — a sliver down one edge of the card — and the lock rejects it, keeps its own
        // quad, and draws a perfectly good box, while the rectification came from the sliver.
        // The card being matched was then a strip of the left border, and that noise went into
        // the tracker with the full weight of a real observation.
        //
        // Only once locked: while acquiring, the quad has not proved it is anything yet, and
        // rectifying from it would be believing it early.
        let relocked = match (&held_quad, &best) {
            (Some(q), Some((method, d, _))) if trusted && q.corners != d.quad.corners => {
                rectify_views(&source.to_rgb8(), q, &opts.detect_options(*method, settled))
            }
            _ => None,
        };

        match best {
            Some((method, d, trace)) => {
                // The locked rectification when there is one, otherwise this frame's own.
                let view = relocked.as_ref();
                let rectified = view.map_or(&d.rectified, |x| &x.rectified);
                let rectified_180 = view.map_or(&d.rectified_180, |x| &x.rectified_180);
                let alternates = view.map_or(&d.alternates, |x| &x.alternates);
                let margin = view.map_or(d.margin, |x| x.margin);

                let descriptor = hash(
                    &image::DynamicImage::ImageRgb8(rectified.clone()).to_luma8(),
                    HashKind::DHash,
                    256,
                );
                v.method = Some(method.as_str().to_string());
                // **Deliberately not overwriting `quad`.** The lock's smoothed quad was
                // written above, and overwriting it here is what made the box wobble: raw
                // detection moves several pixels a frame on a perfectly still card, the
                // smoothing existed to damp exactly that, and this threw it away one branch
                // later. The raw quad is still reported, under its own key, so a debug view
                // can show both.
                v.quad_raw = Some(d.quad.corners);
                if v.quad.is_none() {
                    v.quad = Some(d.quad.corners);
                }
                v.cardness = Some(d.cardness);
                v.trim = Some(margin);
                v.from_lock = relocked.is_some();
                v.score = Some(d.score);
                v.hash = Some(descriptor.to_hex());
                if let Some(t) = &trace {
                    v.timings = Some(t.timings);
                    v.candidates_examined = Some(t.candidates.len());
                    if opts.stages {
                        v.stages = Some(Stages {
                            binary: preview_uri(&t.binary, 300, 62),
                            contours: preview_uri(&t.contours, 300, 62),
                            quad: preview_uri(&t.quads, 300, 62),
                        });
                    }
                }
                v.rectified = preview_uri(rectified, 320, 78);

                // ---- match, readers, track -------------------------------------------------
                if trusted && matcher {
                    tracked = self.match_locked(
                        &mut v,
                        rectified,
                        rectified_180,
                        alternates,
                        d.cardness.score,
                        settled,
                    );
                } else if matcher {
                    // Detected but not yet trusted: tell the tracker nothing was seen, so a
                    // box that never locks can never accumulate a name.
                    let t = self.tracker.observe(&[]);
                    v.tracked = Some(tracked_view(&t, self.reference.as_ref()));
                    tracked = Some(t);
                }
            }
            None => {
                // A frame with no card is still an observation: it is how the tracker learns
                // the card has been taken away. Dropping it would leave stale evidence
                // standing.
                if matcher {
                    let t = self.tracker.observe(&[]);
                    v.tracked = Some(tracked_view(&t, self.reference.as_ref()));
                    tracked = Some(t);
                }
                v.error = Some(error.unwrap_or_else(|| "no card".into()));
                if let Some(t) = &fallback_trace {
                    // `ScoredQuad::cardness` is itself optional — a quad rejected before the
                    // rectification never got scored — so this flattens rather than nests.
                    v.rejected_cardness = t.candidates.first().and_then(|c| c.cardness);
                    v.timings = Some(t.timings);
                    v.candidates_examined = Some(t.candidates.len());
                    if opts.stages {
                        v.stages = Some(Stages {
                            binary: preview_uri(&t.binary, 300, 62),
                            contours: preview_uri(&t.contours, 300, 62),
                            quad: preview_uri(&t.quads, 300, 62),
                        });
                    }
                }
            }
        }

        self.conclude(&mut v, tracked.as_ref());
        v
    }

    /// A trusted frame with a card in it, against the reference: the match, the mode's readers
    /// or resolve, and the tracker. `None` only without a reference.
    ///
    /// Separate from `frame_inner` so the per-mode logic can be driven with rectified images
    /// directly — nothing a test can build gets through the detector and the lock.
    fn match_locked(
        &mut self,
        v: &mut Verdict,
        rectified: &RgbImage,
        rectified_180: &RgbImage,
        alternates: &[(RgbImage, RgbImage)],
        cardness: f32,
        settled: bool,
    ) -> Option<Tracked> {
        let r = self.reference.as_ref()?;
        // Both orientations are hashed inside the match, because a card is 180°-symmetric and
        // the quad cannot say which end is the top. The primary framing first, then the
        // alternates — see `DetectOptions::query_insets`. Order matters only for the reported
        // view.
        let mut views: Vec<(&RgbImage, &RgbImage)> = vec![(rectified, rectified_180)];
        views.extend(alternates.iter().map(|(a, b)| (a, b)));
        let report = r.match_views(&views, self.top, &self.mask);

        // Accumulate across frames. A per-frame top-1 flickers between near-ties several times a
        // second; the stable answer is the one that keeps recurring. Grouped by oracle id: a
        // card's reprints pool their evidence instead of splitting it, and the printing reported
        // is the best-scoring member.
        //
        // The `mut` is for the title read below, which inserts ahead of the appearance
        // candidates — so without `ocr` compiled in nothing writes to it and the compiler is
        // right to say so.
        #[cfg_attr(not(feature = "ocr"), allow(unused_mut))]
        let mut observations: Vec<Observation> = report
            .candidates
            .iter()
            .filter_map(|c| {
                parse_uuid(&c.id)
                    .map(|id| Observation::appearance(r.oracle_for(&id), id, c.normalized))
            })
            .collect();

        match self.mode {
            // The title read, when the hash tier has gone a stretch without settling it. A
            // resolved name is much stronger evidence than a nearest neighbour — it is a reading
            // of what the card says rather than a guess at what it looks like — so it enters the
            // accumulator at a distance the hash tier can rarely reach. Only the title: pinning
            // the printing with the collector line is what Exact is for.
            ScanMode::Fast => {
                let eligible =
                    fast_reader_due(self.mode, self.leaderless_locked, &mut self.seq, settled);
                #[cfg(feature = "ocr")]
                if let Some(reader) = self.reader.as_ref().filter(|_| eligible) {
                    let (ocr, obs) = read_title(reader, r, &self.mask, rectified, rectified_180);
                    if let Some(o) = obs {
                        observations.insert(0, o);
                    }
                    v.ocr = Some(ocr);
                }
                #[cfg(not(feature = "ocr"))]
                let _ = eligible;
            }
            // No per-frame reader. The last few locked frames are kept, and once the lock has
            // held long enough a resolve reads over all of them — once, until a re-arm is taken
            // (see `Session::record_decision`). A vote commit that got there first does not
            // block it (`commit_to` replaces that tally). A freeze lifting inside an unbroken
            // stretch does not re-arm it; after a break, a resolved card's freeze releasing is
            // what does.
            ScanMode::Exact => {
                self.burst.push_back(StoredView {
                    rectified: rectified.clone(),
                    rectified_180: rectified_180.clone(),
                    alternates: alternates.to_vec(),
                    cardness,
                });
                while self.burst.len() > EXACT_BURST {
                    self.burst.pop_front();
                }
                // No term for the tracker. `last_resolution` is only ever `Some` while `attempted`
                // is set, so `!attempted` already says this card has no resolve: a vote commit
                // that got there first cannot block it, and a card decided by a resolve is held
                // off by `attempted` alone until a re-arm is taken.
                if self.steady >= EXACT_STEADY_FRAMES
                    && !self.attempted
                    && self.burst.len() == EXACT_BURST
                {
                    let views: Vec<BurstView<'_>> =
                        self.burst.iter().map(StoredView::view).collect();
                    let gate = self.tracker.options().max_normalized;
                    let (resolution, ocr, collector) =
                        run_resolve(r, &self.mask, &views, self.reader.as_ref(), gate);
                    self.attempted = true;
                    v.ocr = ocr;
                    v.collector = collector;
                    // Committed before this frame's observation, so the frame that resolved is
                    // already the decided one. An ambiguous outcome commits on its best
                    // printing's card: the freeze only has to know that *a* card is being held.
                    if resolution.outcome != Outcome::NotFound {
                        if let Some(best) =
                            resolution.choices.first().and_then(|c| parse_uuid(&c.id))
                        {
                            self.tracker.commit_to(r.oracle_for(&best), best);
                        }
                        self.decision_seq += 1;
                        self.last_resolution = Some(resolution.clone());
                    }
                    v.resolution = Some(resolution);
                }
            }
        }

        let t = self.tracker.observe(&observations);
        v.tracked = Some(tracked_view(&t, Some(r)));
        v.r#match = Some(report);
        Some(t)
    }

    /// What every frame ends with: the decision bookkeeping on whatever the tracker made of it,
    /// and the decision count as it now stands.
    fn conclude(&mut self, v: &mut Verdict, tracked: Option<&Tracked>) {
        if let Some(t) = tracked {
            self.record_decision(t.committed);
            v.decision = self.decision_view(t).map(|mut d| {
                d.replaces_previous = self.replaces_previous(&d);
                d
            });
        }
        v.decision_seq = self.decision_seq;
    }
}

/// An Exact resolve, with the production readers when models are loaded — and the views they
/// produced, so the resolving frame's verdict can show what was read.
fn run_resolve(
    r: &Reference,
    mask: &Mask,
    burst: &[BurstView<'_>],
    reader: Option<&Reader>,
    gate: f32,
) -> (ResolutionView, Option<OcrView>, Option<CollectorView>) {
    #[cfg(feature = "ocr")]
    if let Some(reader) = reader {
        let readers = SessionReaders {
            reader,
            r,
            mask,
            ocr: std::cell::RefCell::new(None),
            collector: std::cell::RefCell::new(None),
        };
        let resolution = crate::resolve::resolve(r, mask, burst, &readers, gate);
        return (resolution, readers.ocr.into_inner(), readers.collector.into_inner());
    }
    #[cfg(not(feature = "ocr"))]
    let _ = reader;
    (crate::resolve::resolve(r, mask, burst, &NoReaders, gate), None, None)
}

/// The production [`crate::resolve::Readers`]: the OCR models, under the session's mask.
///
/// Keeps the last title and collector views it produced, so the frame a resolve ran on fills
/// the verdict's `ocr` and `collector` keys exactly as a Fast read does.
#[cfg(feature = "ocr")]
struct SessionReaders<'a> {
    reader: &'a Reader,
    r: &'a Reference,
    mask: &'a Mask,
    ocr: std::cell::RefCell<Option<OcrView>>,
    collector: std::cell::RefCell<Option<CollectorView>>,
}

#[cfg(feature = "ocr")]
impl crate::resolve::Readers for SessionReaders<'_> {
    fn title(&self, view: &BurstView<'_>) -> Option<String> {
        let read = self.reader.read_title(view.upright, view.flipped);
        self.ocr.replace(Some(title_view(&read, self.r, self.mask).0));
        read.is_usable().then_some(read.normalized)
    }

    fn collector(&self, view: &BurstView<'_>) -> Vec<(String, String)> {
        let col = self.reader.read_collector(view.upright, view.flipped);
        self.collector.replace(Some(collector_view(&col, self.r, self.mask)));
        col.candidates
    }
}

/// The collector line, and the printing it resolved to under the mask.
#[cfg(feature = "ocr")]
fn collector_view(col: &crate::ocr::CollectorRead, r: &Reference, mask: &Mask) -> CollectorView {
    // **Every pairing the parse produced, and what each resolved to.** "It failed" and "it
    // read HOBEN where the card says HOB" look identical from a verdict and are completely
    // different problems — one is a bad crop, the other a misread character, and only the list
    // of attempts tells them apart. Capped, because a noisy read can produce dozens and the
    // panel is for reading.
    const SHOWN: usize = 14;
    let printing = r.lookup_collector_masked(&col.candidates, mask);
    let tried = col
        .candidates
        .iter()
        .take(SHOWN)
        .map(|(set, number)| CollectorTry {
            set: set.clone(),
            number: number.clone(),
            matched: r
                .lookup_pair(set, number)
                .filter(|id| mask.permits(id))
                .and_then(|id| r.label_for(&id))
                .map(|l| l.display()),
        })
        .collect();
    CollectorView {
        raw: col.raw.clone(),
        rotated: col.rotated,
        elapsed_ms: col.elapsed_ms,
        pairings: col.candidates.len(),
        tried,
        more: col.candidates.len().saturating_sub(SHOWN),
        band: col.band.as_ref().and_then(|b| preview_uri(b, 360, 70)),
        matched: printing.and_then(|id| r.label_for(&id)).map(|l| l.display()),
    }
}

/// The title band, and the name it resolved to.
#[cfg(feature = "ocr")]
fn read_title(
    reader: &Reader,
    r: &Reference,
    mask: &Mask,
    rectified: &image::RgbImage,
    rectified_180: &image::RgbImage,
) -> (OcrView, Option<Observation>) {
    title_view(&reader.read_title(rectified, rectified_180), r, mask)
}

/// A title read as the page shows it, and the observation it makes — resolved under the mask,
/// so a read cannot name a card the filters exclude.
#[cfg(feature = "ocr")]
fn title_view(
    read: &crate::ocr::TitleRead,
    r: &Reference,
    mask: &Mask,
) -> (OcrView, Option<Observation>) {
    let hit = read.is_usable().then(|| r.lookup_by_name_masked(&read.normalized, mask)).flatten();
    // The printing that stands for a read name is the card's first one the filters permit. A
    // name says nothing about which printing, and `Observation::from_ocr` gives it no vote there.
    let named = hit.and_then(|(card, edits)| {
        r.printings_of(&card).iter().find(|p| mask.permits(p)).map(|p| (card, *p, edits))
    });
    let view = OcrView {
        raw: read.raw.clone(),
        normalized: read.normalized.clone(),
        rotated: read.rotated,
        elapsed_ms: read.elapsed_ms,
        band: read.band.as_ref().and_then(|b| preview_uri(b, 360, 70)),
        matched: named.and_then(|(_, p, _)| r.label_for(&p)).map(|l| l.name),
        edits: named.map(|(_, _, edits)| edits),
    };
    let obs = named.map(|(card, p, edits)| Observation::from_ocr(card, p, edits));
    (view, obs)
}

/// The tracker deals in ids; a page needs names. Resolved here rather than inside `track`,
/// which is deliberately independent of the corpus.
fn tracked_view(t: &crate::track::Tracked, reference: Option<&Reference>) -> TrackedView {
    TrackedView {
        committed: t.committed,
        confidence: t.confidence,
        rule: t.rule,
        decide_at: t.decide_at,
        lead: t.lead,
        frozen: t.frozen,
        streak: t.streak,
        frames: t.frames,
        misses: t.misses,
        standings: t
            .standings
            .iter()
            .map(|s| StandingView {
                id: format_uuid(&s.id),
                evidence: s.evidence,
                share: s.share,
                seen: s.seen,
                label: reference.and_then(|r| r.label_for(&s.best_member)),
                best_distance: s.best_normalized,
            })
            .collect(),
    }
}

/// A small JPEG data URI a page can put straight into an `<img>`.
///
/// Generic over the pixel type because the stage images are not all colour: the binary mask is
/// a `GrayImage` where the contour and quad overlays are `RgbImage`s.
pub fn preview_uri<P, C>(
    img: &image::ImageBuffer<P, C>,
    max_edge: u32,
    quality: u8,
) -> Option<String>
where
    P: image::Pixel<Subpixel = u8> + 'static,
    C: std::ops::Deref<Target = [u8]>,
{
    let dynamic = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(
        img.width(),
        img.height(),
        |x, y| {
            let p = img.get_pixel(x, y).to_rgb();
            image::Rgb([p[0], p[1], p[2]])
        },
    ));
    let small = dynamic.resize(max_edge, max_edge, image::imageops::FilterType::Triangle);
    let mut buf = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality)
        .encode_image(&small.to_rgb8())
        .ok()?;
    Some(format!("data:image/jpeg;base64,{}", base64(&buf)))
}

fn base64(data: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { A[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 320x240 JPEG with nothing card-shaped in it — a grey field with one dark bar, so the
    /// detector runs every stage and finds no quad. No corpus photograph: the census is about
    /// the verdict's keys, and a blank frame has all of them.
    fn blank_jpeg() -> Vec<u8> {
        let mut img = image::RgbImage::from_pixel(320, 240, image::Rgb([128, 128, 128]));
        for x in 40..280 {
            for y in 100..110 {
                img.put_pixel(x, y, image::Rgb([20, 20, 20]));
            }
        }
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80)
            .encode_image(&img)
            .expect("encode");
        out
    }

    /// Every top-level key `live.html` reads off a frame, under every name it holds one by —
    /// `j`, `latest` and `lastOcr` — except the one the page itself adds (`round_trip_ms`) and
    /// the names that are not verdict keys (`ok` is; `tracked` is; `error` is).
    ///
    /// **The optional-chaining spellings are not optional, and leaving them out made this test
    /// vacuous.** `ocr` is read *only* as `j?.ocr` and `lastOcr?.ocr` (`live.html:621`–`624`);
    /// with a plain `j.` needle alone the scrape yielded 20 keys without it, so deleting
    /// `Verdict::ocr` would have left this green while blanking the page's OCR panel.
    fn keys_the_page_reads() -> Vec<String> {
        let html = include_str!("bin/live.html");
        let ident = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '$';
        let mut keys = std::collections::BTreeSet::new();
        for needle in ["j.", "j?.", "latest.", "latest?.", "lastOcr.", "lastOcr?."] {
            for (i, _) in html.match_indices(needle) {
                // Anchored to a name boundary: `j.` at the tail of `obj.foo` is somebody
                // else's property, and reading a key off it would invent one the verdict
                // then has to carry for ever.
                if html[..i].chars().next_back().is_some_and(ident) {
                    continue;
                }
                let rest = &html[i + needle.len()..];
                let key: String = rest
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .collect();
                // `round_trip_ms` the page measures itself. `saved` is the reply to
                // `/capture`, which is the dataset button's business and not a frame at all.
                if !key.is_empty() && key != "round_trip_ms" && key != "saved" {
                    keys.insert(key);
                }
            }
        }
        keys.into_iter().collect()
    }

    #[test]
    fn every_key_the_debug_page_reads_is_in_the_verdict() {
        let mut s = Session::new(None, None, 5);
        let v = s.frame(&blank_jpeg(), &FrameOptions::default());
        let json = serde_json::to_value(&v).expect("serialise");
        let obj = json.as_object().expect("an object");
        let keys = keys_the_page_reads();
        // **The scrape itself can fail silently, and did.** A needle that stops matching makes
        // the census vacuously green, so the key that is reachable only through the optional
        // spellings is asserted for by name — it is the canary for the whole scrape.
        assert!(
            keys.contains(&"ocr".to_string()),
            "the scrape lost the optional-chaining reads: {keys:?}"
        );
        let missing: Vec<_> = keys
            .into_iter()
            // `error` is skipped when there is none; a blank frame has one, so it is present.
            .filter(|k| !obj.contains_key(k))
            .collect();
        assert!(missing.is_empty(), "live.html reads keys the verdict lacks: {missing:?}");
        assert!(!v.ok, "a blank frame is not a card");
        assert_eq!(v.frame.w, 320);
        assert!(!v.matcher, "no reference was given");
    }

    #[test]
    fn a_frame_the_detector_panics_on_answers_a_sentence() {
        // **The guard is not theoretical.** `imageproc`'s canny asserts low <= high, and
        // measured on the debug server one slider drag killed every worker thread and exited
        // the server. That particular input no longer reaches the assertion — `canny_pair`
        // orders the two before `imageproc` sees them — so the crossed pair is asserted here
        // to be an ordinary verdict rather than a rescue, and the guard is driven through the
        // seam `frame` uses with a body that really does panic.
        let mut s = Session::new(None, None, 5);
        let opts = FrameOptions {
            method: Method::Canny,
            canny_low: 200.0,
            canny_high: 50.0,
            ..Default::default()
        };
        let v = s.frame(&blank_jpeg(), &opts);
        assert!(!v.ok);
        assert!(
            v.error.as_deref().is_some_and(|e| !e.contains("panicked")),
            "crossed thresholds are `detect`'s to survive, not the guard's: {:?}",
            v.error
        );

        let v = s.guarded(|_| panic!("an assertion deep in the image crates"));
        assert!(!v.ok);
        assert!(v.error.as_deref().is_some_and(|e| e.contains("panicked")), "{:?}", v.error);
        assert_eq!(v.frame.w, 0);
        // And the session is still usable afterwards.
        let v = s.frame(&blank_jpeg(), &FrameOptions::default());
        assert!(v.error.as_deref().is_some_and(|e| !e.contains("panicked")));
    }

    #[test]
    fn undecodable_bytes_are_a_decode_error() {
        let mut s = Session::new(None, None, 5);
        let v = s.frame(b"not a jpeg", &FrameOptions::default());
        assert!(!v.ok);
        assert!(v.error.as_deref().is_some_and(|e| e.starts_with("decode:")));
        assert_eq!(v.frame.w, 0);
    }

    #[test]
    fn the_reader_runs_every_fourth_frame_and_stands_down_once_decided() {
        // In Fast mode, past the rescue threshold — before it the reader never runs at all.
        let mut s = Session::new(None, None, 5);
        assert_eq!(s.mode, ScanMode::Fast);
        for _ in 0..FAST_RESCUE_AFTER {
            s.count_stretch(true, true, false);
        }
        let due: Vec<bool> = (0..8).map(|_| s.reader_due(false)).collect();
        assert_eq!(due, [true, false, false, false, true, false, false, false]);
        assert!(!s.reader_due(true), "a decided card asks the reader for nothing");
        // And the frames it stood down for cost it nothing: the run continues where it left
        // off. A decision can be held for a minute, and a counter that ran through it would
        // put the first read after a swap up to `OCR_EVERY - 1` frames late.
        let after: Vec<bool> = (0..4).map(|_| s.reader_due(false)).collect();
        assert_eq!(after, [true, false, false, false], "the freeze consumed a cadence slot");
    }

    #[test]
    fn options_default_to_what_the_page_sliders_start_at() {
        let o = FrameOptions::default();
        assert_eq!(o.work_long_edge, 1024);
        assert_eq!(o.method, Method::Both);
        assert_eq!(o.canny_low, 40.0);
        assert_eq!(o.canny_high, 100.0);
        assert_eq!(o.aspect_tolerance, 0.18);
        assert_eq!(o.min_cardness, crate::cardness::MIN_SCORE);
        assert!(!o.stages);
        assert_eq!(o.rule, CommitRule::Votes);
        assert_eq!(o.decide_at, 8.0);
        assert_eq!(o.lead_margin, 1.3);
    }

    #[test]
    fn options_deserialise_with_every_field_optional() {
        let o: FrameOptions =
            serde_json::from_str(r#"{"method":"otsu","decide_at":12}"#).expect("parse");
        assert_eq!(o.method, Method::Otsu);
        assert_eq!(o.decide_at, 12.0);
        assert_eq!(o.canny_low, 40.0);
        let o: FrameOptions = serde_json::from_str("{}").expect("empty object");
        assert_eq!(o, FrameOptions::default());
        let rule: CommitRule = serde_json::from_str(r#""confidence""#).expect("rule");
        assert_eq!(rule, CommitRule::Confidence);
    }

    // ---- Modes, filters and the decision ----------------------------------------------------

    fn id(n: u8) -> [u8; crate::index::ID_LEN] {
        let mut b = [0u8; crate::index::ID_LEN];
        b[0] = n;
        b
    }

    /// Feed the session's tracker one frame, and do the bookkeeping `frame_inner` does after it.
    fn observe(s: &mut Session, frame: &[([u8; crate::index::ID_LEN], f32)]) -> bool {
        let t = s.tracker.observe_ids(frame);
        s.record_decision(t.committed);
        t.committed
    }

    /// The generated picture printing `n`'s bundle entry is hashed from.
    fn card_image(n: u8) -> RgbImage {
        RgbImage::from_fn(60, 84, |x, y| image::Rgb([((x * n as u32 + y) % 256) as u8; 3]))
    }

    /// A reference with three labelled printings: two of one card, one of another.
    fn labelled() -> Reference {
        use crate::hash::{hash_rgb, HashKind};
        use crate::index::{BundleBuilder, Section};
        let mut b = BundleBuilder::new(HashKind::DHash, 256);
        for n in 1..=3u8 {
            b.push(Section::Card, id(n), &hash_rgb(&card_image(n), HashKind::DHash, 256));
        }
        let mut r = Reference::new(b.finish(0));
        for (n, oracle, set) in [(1u8, 10u8, "hob"), (2, 10, "ltr"), (3, 20, "hob")] {
            let label = Label {
                name: format!("Card {oracle}"),
                set: set.into(),
                number: n.to_string(),
                lang: "en".into(),
                released: "2025-01-01".into(),
            };
            r.add_label(id(n), Some(id(oracle)), None, label);
        }
        r
    }

    fn sets(codes: &[&str]) -> ScanFilters {
        ScanFilters { sets: codes.iter().map(|s| s.to_string()).collect(), ..Default::default() }
    }

    #[test]
    fn decision_seq_moves_once_per_commit_and_not_on_frozen_frames() {
        let mut s = Session::new(None, None, 5);
        let card = [(id(1), 0.16)];
        for _ in 0..7 {
            assert!(!observe(&mut s, &card));
        }
        assert_eq!(s.decision_seq, 0);
        assert!(observe(&mut s, &card), "eight clean frames decide under the vote rule");
        assert_eq!(s.decision_seq, 1);
        // Frozen: committed on every frame, and not one of them is a new decision.
        for _ in 0..20 {
            assert!(observe(&mut s, &card));
        }
        assert_eq!(s.decision_seq, 1, "a frozen frame counted as a decision");
        // The card leaves; the next one is a second decision.
        for _ in 0..10 {
            observe(&mut s, &[]);
        }
        assert_eq!(s.decision_seq, 1);
        for _ in 0..8 {
            observe(&mut s, &[(id(2), 0.16)]);
        }
        assert_eq!(s.decision_seq, 2);
    }

    #[test]
    fn an_exact_commit_without_a_resolution_is_not_a_decision() {
        // Exact's decisions are resolves (spec §6.5). The tracker can still reach its own bar on
        // appearance after a `NotFound`, and that has no printings to offer a tray.
        let mut s = Session::new(None, None, 5);
        s.mode = ScanMode::Exact;
        for _ in 0..8 {
            observe(&mut s, &[(id(1), 0.16)]);
        }
        assert!(s.tracker.last_committed());
        assert_eq!(s.decision_seq, 0);
    }

    #[test]
    fn fast_mode_runs_no_reader_before_the_eighth_leaderless_locked_frame() {
        let mut s = Session::new(None, None, 5);
        for f in 1..FAST_RESCUE_AFTER {
            s.count_stretch(true, true, false);
            assert!(!s.reader_due(false), "the reader ran on leaderless locked frame {f}");
        }
        s.count_stretch(true, true, false);
        assert!(s.reader_due(false), "the rescue never became eligible");

        // The count itself is asserted, not the cadence: with the cadence mid-cycle `reader_due`
        // answers false whatever the count says, and a check through it passed over a missing
        // reset.
        //
        // A broken stretch — the lock no longer trusted — starts the count again.
        s.count_stretch(false, false, false);
        assert_eq!(s.leaderless_locked, 0, "a lost lock kept its leaderless count");

        // So does a commit, and a committed frame does not count.
        for _ in 0..FAST_RESCUE_AFTER {
            s.count_stretch(true, true, false);
        }
        assert_eq!(s.leaderless_locked, FAST_RESCUE_AFTER);
        s.record_decision(true);
        assert_eq!(s.leaderless_locked, 0, "a commit kept its leaderless count");
        s.count_stretch(true, true, true);
        assert_eq!(s.leaderless_locked, 0, "a committed frame counted as leaderless");

        // And Exact runs no per-frame reader however long it has gone without a leader.
        let mut s = Session::new(None, None, 5);
        s.mode = ScanMode::Exact;
        for _ in 0..(FAST_RESCUE_AFTER * 3) {
            s.count_stretch(true, true, false);
            assert!(!s.reader_due(false));
        }
    }

    #[test]
    fn a_broken_stretch_arms_a_rearm_that_waits_for_the_tracker() {
        let mut s = Session::new(None, None, 5);
        let blank = image::RgbImage::new(4, 4);
        s.count_stretch(true, true, false);
        s.burst.push_back(StoredView {
            rectified: blank.clone(),
            rectified_180: blank,
            alternates: Vec::new(),
            cardness: 0.5,
        });
        s.attempted = true;
        s.last_resolution = Some(ResolutionView {
            outcome: Outcome::Resolved,
            choices: Vec::new(),
            tiers: Vec::new(),
            elapsed_ms: 0.0,
        });
        assert_eq!(s.steady, 1);
        s.count_stretch(false, false, false);
        assert_eq!(s.steady, 0);
        assert!(s.burst.is_empty());
        assert!(s.rearm_pending);
        assert!(s.attempted && s.last_resolution.is_some(), "the break re-armed by itself");

        // Taken only once nothing is committed.
        s.record_decision(true);
        assert!(s.attempted && s.rearm_pending, "a committed frame took the re-arm");
        s.record_decision(false);
        assert!(!s.attempted && s.last_resolution.is_none() && !s.rearm_pending);
    }

    #[test]
    fn a_trusted_frame_without_a_detection_does_not_break_the_stretch() {
        // A detector that misses one frame under a lock that still holds is the same card in
        // the same place. Breaking the stretch on it would re-arm Exact's resolve mid-card.
        let mut s = Session::new(None, None, 5);
        for _ in 0..3 {
            s.count_stretch(true, true, false);
        }
        s.attempted = true;
        s.burst.push_back(StoredView {
            rectified: image::RgbImage::new(4, 4),
            rectified_180: image::RgbImage::new(4, 4),
            alternates: Vec::new(),
            cardness: 0.5,
        });
        s.count_stretch(true, false, false);
        assert_eq!((s.steady, s.leaderless_locked), (3, 3), "a missed detection counted or reset");
        assert!(s.attempted && s.burst.len() == 1, "a missed detection broke the stretch");

        // And through the frame path: two locked frames, a trusted miss, one more — the resolve
        // runs on that fourth frame, the third to hold a card.
        let mut s = Session::new(Some(labelled()), None, 5);
        s.mode = ScanMode::Exact;
        let card = card_image(3);
        locked_frame(&mut s, &card);
        locked_frame(&mut s, &card);
        assert!(held_frame(&mut s).resolution.is_none());
        assert!(locked_frame(&mut s, &card).resolution.is_some(), "the miss broke the stretch");
    }

    #[test]
    fn switching_mode_resets_the_tracker_but_keeps_decision_seq() {
        let mut s = Session::new(None, None, 5);
        for _ in 0..8 {
            observe(&mut s, &[(id(1), 0.16)]);
        }
        assert!(s.tracker.last_committed());
        assert_eq!(s.decision_seq, 1);

        let exact = FrameOptions { mode: ScanMode::Exact, ..Default::default() };
        let v = s.frame(&blank_jpeg(), &exact);
        assert_eq!(v.mode, ScanMode::Exact);
        assert!(!s.tracker.last_committed(), "the mode switch kept the old decision");
        assert!(!s.was_committed);
        assert_eq!(v.decision_seq, 1, "the mode switch reset the decision count");

        // The same mode again is not a switch.
        for _ in 0..3 {
            observe(&mut s, &[(id(1), 0.16)]);
        }
        s.frame(&blank_jpeg(), &exact);
        assert_eq!(
            s.tracker.observe_ids(&[]).standings.len(),
            1,
            "a frame in the same mode reset the tally"
        );
    }

    #[test]
    fn exact_mode_judges_by_votes_whatever_the_rule_asked_for() {
        // A resolve commits through the vote rule's freeze. Under the confidence rule that
        // freeze lifts on the next frame, the resolve runs again, and every two frames would be
        // a new decision — so Exact holds the rule at votes.
        let mut s = Session::new(None, None, 5);
        let opts = FrameOptions {
            mode: ScanMode::Exact,
            rule: CommitRule::Confidence,
            ..Default::default()
        };
        s.frame(&blank_jpeg(), &opts);
        assert_eq!(s.tracker.options().rule, CommitRule::Votes);
        let fast = FrameOptions { rule: CommitRule::Confidence, ..Default::default() };
        s.frame(&blank_jpeg(), &fast);
        assert_eq!(s.tracker.options().rule, CommitRule::Confidence, "Fast keeps the page's rule");
    }

    #[test]
    fn filters_without_labels_are_a_sentence() {
        let sentence =
            "Filters need card names, and the scanner has none loaded — it needs corpus.db beside the bundle.";
        let mut s = Session::new(None, None, 5);
        assert_eq!(s.set_filters(sets(&["hob"])), Err(sentence.to_string()));

        let bare = Reference::new(crate::index::BundleBuilder::new(crate::hash::HashKind::DHash, 256).finish(0));
        let mut s = Session::new(Some(bare), None, 5);
        assert_eq!(s.set_filters(sets(&["hob"])), Err(sentence.to_string()));
        assert!(s.filters().is_empty());

        // Clearing the filters needs no names.
        assert_eq!(s.set_filters(ScanFilters::default()), Ok(()));
    }

    #[test]
    fn filters_that_match_nothing_are_a_sentence_and_keep_the_old_mask() {
        let mut s = Session::new(Some(labelled()), None, 5);
        assert_eq!(s.set_filters(sets(&["hob"])), Ok(()));
        assert_eq!(s.mask.len(), Some(2));
        assert_eq!(s.filters(), &sets(&["hob"]));

        assert_eq!(
            s.set_filters(sets(&["zzz"])),
            Err("No printing matches these filters.".to_string())
        );
        assert_eq!(s.mask.len(), Some(2), "a refused filter replaced the mask");
        assert_eq!(s.filters(), &sets(&["hob"]));

        assert_eq!(s.set_filters(ScanFilters::default()), Ok(()));
        assert!(s.mask.is_unrestricted());
    }

    #[test]
    fn setting_filters_resets_the_tracker() {
        let mut s = Session::new(Some(labelled()), None, 5);
        for _ in 0..8 {
            observe(&mut s, &[(id(1), 0.16)]);
        }
        assert!(s.tracker.last_committed());
        s.set_filters(sets(&["ltr"])).expect("ltr has a printing");
        assert!(!s.tracker.last_committed());
    }

    #[test]
    fn a_failed_verdict_still_carries_mode_and_decision_seq() {
        let mut s = Session::new(None, None, 5);
        s.decision_seq = 3;
        let exact = FrameOptions { mode: ScanMode::Exact, ..Default::default() };
        let v = s.frame(b"not a jpeg", &exact);
        assert!(v.error.as_deref().is_some_and(|e| e.starts_with("decode:")));
        assert_eq!((v.mode, v.decision_seq), (ScanMode::Exact, 3));

        let v = s.guarded(|_| panic!("an assertion deep in the image crates"));
        assert_eq!((v.mode, v.decision_seq), (ScanMode::Exact, 3));

        let json = serde_json::to_value(&v).expect("serialise");
        assert_eq!(json["mode"], "exact");
        assert_eq!(json["decision_seq"], 3);
        assert!(json["decision"].is_null() && json["resolution"].is_null());
    }

    #[test]
    fn a_fast_decision_names_the_leaders_printing() {
        let mut s = Session::new(Some(labelled()), None, 5);
        let mut t = None;
        for _ in 0..8 {
            t = Some(s.tracker.observe(&[Observation::appearance(id(10), id(2), 0.16)]));
        }
        let t = t.expect("frames");
        assert!(t.committed);
        let d = s.decision_view(&t).expect("a committed frame has a decision");
        assert_eq!(d.printing, format_uuid(&id(2)));
        assert_eq!(d.oracle_id, Some(format_uuid(&id(10))));
        assert_eq!(d.outcome, Outcome::Resolved);
        assert!(d.choices.is_empty());
        assert_eq!(d.label.map(|l| l.set), Some("ltr".to_string()));

        // A card decided on a read name alone has no printing in its tally, only the card; the
        // decision still names a printing, never the oracle id standing in for one.
        let mut s = Session::new(Some(labelled()), None, 5);
        s.tracker.observe(&[Observation::from_ocr(id(10), id(1), 0)]);
        s.tracker.observe(&[Observation::from_ocr(id(10), id(1), 0)]);
        let t = s.tracker.observe(&[]);
        assert!(t.committed);
        let d = s.decision_view(&t).expect("decision");
        assert_eq!(d.printing, format_uuid(&id(1)));
    }

    #[test]
    fn an_exact_decision_is_the_resolution_it_committed_on() {
        let mut s = Session::new(Some(labelled()), None, 5);
        s.mode = ScanMode::Exact;
        let choice = |n: u8| ChoiceView {
            id: format_uuid(&id(n)),
            oracle_id: Some(format_uuid(&id(10))),
            label: None,
            distance: Some(0.0),
        };
        s.last_resolution = Some(ResolutionView {
            outcome: Outcome::Ambiguous,
            choices: vec![choice(2), choice(1)],
            tiers: Vec::new(),
            elapsed_ms: 1.0,
        });
        s.tracker.commit_to(id(10), id(2));
        let t = s.tracker.observe(&[]);
        let d = s.decision_view(&t).expect("decision");
        assert_eq!(d.printing, format_uuid(&id(2)));
        assert_eq!(d.outcome, Outcome::Ambiguous);
        assert_eq!(d.choices.len(), 2);

        s.last_resolution = None;
        assert!(s.decision_view(&t).is_none(), "Exact invented a decision with no resolve");
    }

    /// A locked frame showing `card`, down the path `frame_inner` takes for one — from the
    /// stretch count to the decision. Only the detector and the lock are skipped, which is what
    /// no generated image can get through.
    fn locked_frame(s: &mut Session, card: &RgbImage) -> Verdict {
        let settled = s.tracker.last_committed();
        s.count_stretch(true, true, settled);
        let mut v =
            Verdict::failed(String::new(), FrameSize { w: 0, h: 0 }, 0.0, true, s.mode, s.decision_seq);
        let t = s.match_locked(&mut v, card, card, &[], 0.5, settled);
        s.conclude(&mut v, t.as_ref());
        v
    }

    /// A frame with no card detected, the same way: under a lock that no longer trusts its quad
    /// when `trusted` is false — the card has left — or under one still holding when it is true.
    fn cardless_frame(s: &mut Session, trusted: bool) -> Verdict {
        let settled = s.tracker.last_committed();
        s.count_stretch(trusted, false, settled);
        let mut v =
            Verdict::failed(String::new(), FrameSize { w: 0, h: 0 }, 0.0, true, s.mode, s.decision_seq);
        let t = s.tracker.observe(&[]);
        s.conclude(&mut v, Some(&t));
        v
    }

    fn lost_frame(s: &mut Session) -> Verdict {
        cardless_frame(s, false)
    }

    fn held_frame(s: &mut Session) -> Verdict {
        cardless_frame(s, true)
    }

    /// An Exact session that has just resolved `card_image(3)` — decision 1.
    fn resolved_on_card_three() -> Session {
        let mut s = Session::new(Some(labelled()), None, 5);
        s.mode = ScanMode::Exact;
        for _ in 0..EXACT_STEADY_FRAMES {
            locked_frame(&mut s, &card_image(3));
        }
        assert_eq!(s.decision_seq, 1, "the premise: card three resolved");
        s
    }

    #[test]
    fn an_exact_stretch_resolves_once_and_decides_once() {
        let mut s = Session::new(Some(labelled()), None, 5);
        s.mode = ScanMode::Exact;
        let card = card_image(3);
        for f in 1..EXACT_STEADY_FRAMES {
            let v = locked_frame(&mut s, &card);
            assert!(v.resolution.is_none(), "resolved on steady frame {f}");
            assert_eq!(v.decision_seq, 0);
        }

        let v = locked_frame(&mut s, &card);
        let res = v.resolution.as_ref().expect("the third steady frame resolves");
        assert_ne!(res.outcome, Outcome::NotFound, "{:?}", res.tiers);
        assert_eq!(res.choices[0].id, format_uuid(&id(3)));
        assert!(
            v.tracked.as_ref().is_some_and(|t| t.committed && t.frozen),
            "the frame that resolved was not already the decided one"
        );
        assert_eq!(v.decision_seq, 1);
        let d = v.decision.as_ref().expect("a decision on the resolving frame");
        assert_eq!(d.printing, format_uuid(&id(3)));
        assert_eq!(d.oracle_id, Some(format_uuid(&id(20))));

        for _ in 0..20 {
            let v = locked_frame(&mut s, &card);
            assert!(v.resolution.is_none(), "a held card resolved again");
            assert_eq!(v.decision_seq, 1);
            assert!(v.decision.is_some(), "a committed frame lost its decision");
        }
    }

    #[test]
    fn a_freeze_lifting_inside_one_stretch_does_not_decide_the_card_again() {
        // **The case Exact exists for.** The reads resolved card three, and the hash prefers
        // another card on every frame — so under the freeze each frame is a miss, and ten of
        // them lift it while the lock never lets go. One stretch is one card: no second resolve
        // and no second decision, however often the tracker lifts and re-forms.
        let mut s = resolved_on_card_three();
        let other = card_image(1);
        let mut lifted = false;
        for f in 0..40 {
            let v = locked_frame(&mut s, &other);
            lifted |= !v.tracked.as_ref().is_some_and(|t| t.committed);
            assert!(v.resolution.is_none(), "re-resolved inside the stretch on frame {f}");
            assert_eq!(v.decision_seq, 1, "decided again inside the stretch on frame {f}");
        }
        assert!(lifted, "the premise: the freeze lifted at some point");
    }

    #[test]
    fn a_lock_blip_on_a_decided_card_does_not_decide_it_again() {
        // **One degenerate quad drops the lock for two frames on a card that never moved**
        // (`lock.rs`: a detection that fails to agree puts the lock back to acquiring). The
        // tracker's freeze outlasts that, so the card is still the decided one: no second
        // resolve, no second tray row, and no frame where the decision goes blank.
        let mut s = resolved_on_card_three();
        for _ in 0..2 {
            let v = lost_frame(&mut s);
            assert!(v.decision.is_some(), "a frozen frame inside the blip lost its decision");
            assert_eq!(v.decision_seq, 1);
        }
        for f in 0..12 {
            let v = locked_frame(&mut s, &card_image(3));
            assert!(v.resolution.is_none(), "the blip re-resolved the held card on frame {f}");
            assert_eq!(v.decision_seq, 1);
            assert!(v.decision.is_some(), "a frozen frame after the blip lost its decision");
        }
    }

    #[test]
    fn a_vote_freeze_after_a_not_found_does_not_hold_back_the_next_stretch() {
        // Spec §6.4: "NotFound commits nothing; the next steady stretch tries again." The card
        // was badly framed for the burst, then steadied, and the tracker's own votes committed
        // and froze on it. That freeze was not made by a resolve, so it must not keep the card
        // undecided for as long as it is held: one lock break, and the next stretch resolves.
        use crate::hash::{hash_rgb, HashKind};
        use crate::index::{BundleBuilder, Section};
        let card = card_image(3);
        let mut b = BundleBuilder::new(HashKind::DHash, 256);
        b.push(Section::Card, id(3), &hash_rgb(&card, HashKind::DHash, 256));
        let mut r = Reference::new(b.finish(0));
        let label = Label {
            name: "Card 20".into(),
            set: "hob".into(),
            number: "3".into(),
            lang: "en".into(),
            released: "2025-01-01".into(),
        };
        r.add_label(id(3), Some(id(20)), None, label);
        let mut s = Session::new(Some(r), None, 5);
        s.mode = ScanMode::Exact;

        // The burst sees the card's negative: every gradient comparison flipped, nothing inside
        // the gate.
        let negative = RgbImage::from_fn(card.width(), card.height(), |x, y| {
            let p = card.get_pixel(x, y).0;
            image::Rgb([255 - p[0], 255 - p[1], 255 - p[2]])
        });
        let mut v = locked_frame(&mut s, &negative);
        for _ in 1..EXACT_STEADY_FRAMES {
            v = locked_frame(&mut s, &negative);
        }
        let res = v.resolution.as_ref().expect("the burst resolved");
        assert_eq!(res.outcome, Outcome::NotFound, "the premise: {:?}", res.tiers);

        for _ in 0..8 {
            assert!(locked_frame(&mut s, &card).resolution.is_none());
        }
        assert!(s.tracker.last_committed(), "the premise: the votes committed and froze");
        assert_eq!(s.decision_seq, 0);

        lost_frame(&mut s);
        let mut v = locked_frame(&mut s, &card);
        for _ in 1..EXACT_STEADY_FRAMES {
            assert!(v.resolution.is_none());
            v = locked_frame(&mut s, &card);
        }
        let res = v.resolution.as_ref().expect("the vote freeze held back the next stretch");
        assert_eq!(res.outcome, Outcome::Resolved, "{:?}", res.tiers);
        assert_eq!(v.decision_seq, 1);
        assert!(v.decision.is_some());
        for _ in 0..10 {
            assert_eq!(locked_frame(&mut s, &card).decision_seq, 1);
        }
    }

    #[test]
    fn a_card_taken_away_lets_the_next_one_resolve() {
        // The lock breaks, ten empty frames release the freeze — the card has left by the
        // tracker's own rule — and a card is held steady again: resolved and decided once.
        let mut s = resolved_on_card_three();
        for _ in 0..10 {
            lost_frame(&mut s);
        }
        assert!(!s.tracker.last_committed(), "the premise: the freeze released");
        let mut v = locked_frame(&mut s, &card_image(3));
        for _ in 1..EXACT_STEADY_FRAMES {
            assert!(v.resolution.is_none());
            v = locked_frame(&mut s, &card_image(3));
        }
        assert!(v.resolution.is_some(), "the next card did not resolve");
        assert_eq!(v.decision_seq, 2);
        for _ in 0..10 {
            assert_eq!(locked_frame(&mut s, &card_image(3)).decision_seq, 2);
        }
    }

    #[test]
    fn a_vote_commit_before_any_resolve_still_resolves_and_decides_once() {
        // A flaky lock: two trusted frames, one lost, over and over. The stretch never reaches
        // three, but the tracker's votes survive the breaks and commit on their own — which must
        // not leave the card undecided until it leaves.
        //
        // One card alone in the bundle: in `labelled()` the generated gradients sit a couple of
        // bits apart, so the other card's two printings pool a lead of only 1.19 and the votes
        // never commit — the premise would fail rather than the behaviour.
        use crate::hash::{hash_rgb, HashKind};
        use crate::index::{BundleBuilder, Section};
        let card = card_image(3);
        let mut b = BundleBuilder::new(HashKind::DHash, 256);
        b.push(Section::Card, id(3), &hash_rgb(&card, HashKind::DHash, 256));
        let mut r = Reference::new(b.finish(0));
        let label = Label {
            name: "Card 20".into(),
            set: "hob".into(),
            number: "3".into(),
            lang: "en".into(),
            released: "2025-01-01".into(),
        };
        r.add_label(id(3), Some(id(20)), None, label);
        let mut s = Session::new(Some(r), None, 5);
        s.mode = ScanMode::Exact;
        for _ in 0..4 {
            locked_frame(&mut s, &card);
            locked_frame(&mut s, &card);
            assert!(lost_frame(&mut s).resolution.is_none());
        }
        assert!(s.tracker.last_committed(), "the premise: eight votes committed on their own");
        assert_eq!(s.decision_seq, 0, "a vote commit counted as an Exact decision");

        let mut v = locked_frame(&mut s, &card);
        for _ in 1..EXACT_STEADY_FRAMES {
            v = locked_frame(&mut s, &card);
        }
        assert!(v.resolution.is_some(), "the vote commit blocked the resolve");
        assert_eq!(v.decision_seq, 1);
        assert!(v.decision.is_some());
        for _ in 0..10 {
            assert_eq!(locked_frame(&mut s, &card).decision_seq, 1);
        }
    }

    #[test]
    fn a_not_found_resolve_decides_nothing_and_waits_for_the_next_stretch() {
        use crate::hash::{hash_rgb, Descriptor, HashKind};
        use crate::index::{BundleBuilder, Section};
        // The bundle's only entry is the card's own descriptor with every bit inverted: as far
        // as a descriptor can be, so nothing clears the gate.
        let card = card_image(1);
        let q = hash_rgb(&card, HashKind::DHash, 256);
        let mut b = BundleBuilder::new(HashKind::DHash, 256);
        b.push(Section::Card, id(9), &Descriptor { words: q.words.map(|w| !w), bits: 256 });
        let mut s = Session::new(Some(Reference::new(b.finish(0))), None, 5);
        s.mode = ScanMode::Exact;

        let mut v = locked_frame(&mut s, &card);
        for _ in 1..EXACT_STEADY_FRAMES {
            v = locked_frame(&mut s, &card);
        }
        let res = v.resolution.as_ref().expect("resolved");
        assert_eq!(res.outcome, Outcome::NotFound, "{:?}", res.tiers);
        assert_eq!(v.decision_seq, 0);
        assert!(v.decision.is_none());

        for _ in 0..12 {
            assert!(locked_frame(&mut s, &card).resolution.is_none(), "retried inside the stretch");
        }
        lost_frame(&mut s);
        let mut v = locked_frame(&mut s, &card);
        for _ in 1..EXACT_STEADY_FRAMES {
            v = locked_frame(&mut s, &card);
        }
        assert!(v.resolution.is_some(), "a new stretch did not try again");
    }

    // ---- Returning to the scanner, and a second opinion on the card in frame ----------------

    #[test]
    fn the_filters_already_in_force_leave_a_decided_card_alone() {
        // The page pushes the stored filters every time the Scanner mounts. With the card still
        // on the mat, a reset there re-decided it and the tray added it a second time.
        let mut s = resolved_on_card_three();
        let card = card_image(3);
        assert!(s.tracker.last_committed());
        assert_eq!(s.set_filters(ScanFilters::default()), Ok(()));
        // A cleared date input sends `""`, not nothing — still the filters in force.
        let blank = ScanFilters { released_to: Some(String::new()), ..Default::default() };
        assert_eq!(s.set_filters(blank), Ok(()));
        assert!(s.tracker.last_committed(), "an unchanged filter wiped the decided card");
        assert!(s.mask.is_unrestricted());
        for f in 0..10 {
            let v = locked_frame(&mut s, &card);
            assert!(v.resolution.is_none(), "an unchanged filter re-resolved on frame {f}");
            assert_eq!(v.decision_seq, 1, "an unchanged filter decided again on frame {f}");
            assert!(v.decision.is_some());
        }

        // A different filter is a change, and still resets.
        s.set_filters(sets(&["hob"])).expect("hob has a printing");
        assert!(!s.tracker.last_committed(), "a real filter change kept the old evidence");
        let mut v = locked_frame(&mut s, &card);
        for _ in 1..EXACT_STEADY_FRAMES {
            v = locked_frame(&mut s, &card);
        }
        assert!(v.resolution.is_some(), "the changed filter did not resolve again");
        assert_eq!(v.decision_seq, 2);

        // And the new filters, spelled differently, are the ones in force now.
        assert_eq!(s.set_filters(sets(&[" HOB "])), Ok(()));
        assert!(s.tracker.last_committed(), "the same set in capitals counted as a change");
        assert_eq!(s.mask.len(), Some(2), "an unchanged filter rebuilt the mask");
        assert!(locked_frame(&mut s, &card).resolution.is_none());
        assert_eq!(s.decision_seq, 2);
    }

    /// Two cards as far apart as a descriptor can be — `card_image(3)` and its negative — each
    /// the only printing of its own oracle card, both in `hob`. Unlike `labelled()`, whose
    /// gradients sit a couple of bits apart, each decides on the votes alone in Fast.
    fn two_far_cards() -> (Reference, RgbImage, RgbImage) {
        use crate::hash::{hash_rgb, HashKind};
        use crate::index::{BundleBuilder, Section};
        let card = card_image(3);
        let negative = RgbImage::from_fn(card.width(), card.height(), |x, y| {
            let p = card.get_pixel(x, y).0;
            image::Rgb([255 - p[0], 255 - p[1], 255 - p[2]])
        });
        let mut b = BundleBuilder::new(HashKind::DHash, 256);
        b.push(Section::Card, id(3), &hash_rgb(&card, HashKind::DHash, 256));
        b.push(Section::Card, id(4), &hash_rgb(&negative, HashKind::DHash, 256));
        let mut r = Reference::new(b.finish(0));
        for (n, oracle) in [(3u8, 20u8), (4, 30)] {
            let label = Label {
                name: format!("Card {oracle}"),
                set: "hob".into(),
                number: n.to_string(),
                lang: "en".into(),
                released: "2025-01-01".into(),
            };
            r.add_label(id(n), Some(id(oracle)), None, label);
        }
        (r, card, negative)
    }

    /// Locked frames of `card` until `decision_seq` moves, and the frame it moved on.
    fn until_decided(s: &mut Session, card: &RgbImage) -> Verdict {
        let before = s.decision_seq;
        for _ in 0..40 {
            let v = locked_frame(s, card);
            if v.decision_seq != before {
                return v;
            }
        }
        panic!("the premise: forty locked frames never decided the card");
    }

    #[test]
    fn switching_to_exact_on_the_card_fast_decided_replaces_that_decision() {
        // "Fast said Forest, switch to Exact to pin the printing." One physical card, so the
        // tray must end with one row — the second decision says it is a second opinion.
        let (r, card, _) = two_far_cards();
        let mut s = Session::new(Some(r), None, 5);
        let fast = until_decided(&mut s, &card);
        let d = fast.decision.expect("a decision on the deciding frame");
        assert_eq!(d.oracle_id, Some(format_uuid(&id(20))));
        assert!(!d.replaces_previous, "the first decision had nothing to replace");
        // Its later frames repeat its answer rather than comparing the card with itself.
        for f in 0..3 {
            let d = locked_frame(&mut s, &card).decision.expect("a frozen frame keeps its decision");
            assert!(!d.replaces_previous, "frame {f} of the first decision replaced itself");
        }

        s.set_mode(ScanMode::Exact);
        let exact = until_decided(&mut s, &card);
        assert!(exact.resolution.is_some(), "the premise: Exact decided by resolving");
        assert_eq!(exact.decision_seq, 2);
        let d = exact.decision.expect("decision");
        assert_eq!(d.oracle_id, Some(format_uuid(&id(20))));
        assert!(d.replaces_previous, "a second opinion on the same card read as a second copy");
        for f in 0..5 {
            let v = locked_frame(&mut s, &card);
            assert_eq!(v.decision_seq, 2);
            let d = v.decision.expect("a frozen frame keeps its decision");
            assert!(d.replaces_previous, "frame {f} of the same decision changed its answer");
        }

        // A real filter change is the same kind of settings reset.
        s.set_filters(sets(&["hob"])).expect("hob admits both cards");
        let refiltered = until_decided(&mut s, &card);
        assert!(refiltered.decision.expect("decision").replaces_previous);

        // The JSON key is the page's.
        let v = locked_frame(&mut s, &card);
        let json = serde_json::to_value(&v).expect("serialise");
        assert_eq!(json["decision"]["replaces_previous"], true);
    }

    #[test]
    fn the_same_card_after_a_stretch_break_is_a_new_copy() {
        let (r, card, _) = two_far_cards();
        let mut s = Session::new(Some(r), None, 5);
        until_decided(&mut s, &card);
        s.set_mode(ScanMode::Exact);
        assert!(until_decided(&mut s, &card).decision.expect("decision").replaces_previous);

        // The card is taken away: the lock breaks and the freeze releases.
        for _ in 0..10 {
            lost_frame(&mut s);
        }
        let again = until_decided(&mut s, &card);
        let d = again.decision.expect("decision");
        assert_eq!(d.oracle_id, Some(format_uuid(&id(20))));
        assert!(!d.replaces_previous, "a second copy after a break replaced the first");

        // One lost frame is enough, even under a freeze that outlasts it: the lock stopped
        // trusting the quad, so nothing says the card in frame afterwards is the same one.
        let mut s = Session::new(Some(two_far_cards().0), None, 5);
        until_decided(&mut s, &card);
        lost_frame(&mut s);
        s.set_mode(ScanMode::Exact);
        assert!(!until_decided(&mut s, &card).decision.expect("decision").replaces_previous);
    }

    #[test]
    fn a_different_card_after_a_mode_switch_replaces_nothing() {
        let (r, card, negative) = two_far_cards();
        let mut s = Session::new(Some(r), None, 5);
        until_decided(&mut s, &card);
        s.set_mode(ScanMode::Exact);
        let v = until_decided(&mut s, &negative);
        let d = v.decision.expect("decision");
        assert_eq!(d.oracle_id, Some(format_uuid(&id(30))), "the premise: the other card");
        assert!(!d.replaces_previous, "a different card replaced the one before it");

        // And a decision replaces only the one directly before it: back to the first card, in
        // the same unbroken stretch, is a change of card again.
        s.set_mode(ScanMode::Fast);
        let d = until_decided(&mut s, &card).decision.expect("decision");
        assert_eq!(d.oracle_id, Some(format_uuid(&id(20))));
        assert!(!d.replaces_previous);
    }

    #[test]
    fn a_mode_switch_keeps_the_quad_lock_and_reset_does_not() {
        // Through `frame`, where the switch happens. A lock reset here put a card that never
        // moved back to acquiring, and those untrusted frames are a stretch break — which would
        // forget the decision a switch to Exact exists to replace.
        let q = crate::detect::Quad {
            corners: [(100.0, 100.0), (300.0, 100.0), (300.0, 380.0), (100.0, 380.0)],
        };
        let mut s = Session::new(None, None, 5);
        for _ in 0..3 {
            s.lock.observe(Some(q));
        }
        s.previous_card = Some(format_uuid(&id(20)));
        let exact = FrameOptions { mode: ScanMode::Exact, ..Default::default() };
        let v = s.frame(&blank_jpeg(), &exact);
        assert_eq!(v.mode, ScanMode::Exact);
        assert!(v.lock.as_ref().is_some_and(LockState::is_trusted), "the switch reset the lock");
        assert_eq!(s.previous_card, Some(format_uuid(&id(20))), "the switch forgot the card");

        s.reset();
        assert!(s.previous_card.is_none(), "a Reset press kept the card a decision could replace");
        let v = s.frame(&blank_jpeg(), &exact);
        assert!(!v.lock.as_ref().is_some_and(LockState::is_trusted), "reset kept the lock");
    }

    #[test]
    fn options_carry_the_mode_in_lowercase() {
        let o: FrameOptions = serde_json::from_str(r#"{"mode":"exact"}"#).expect("parse");
        assert_eq!(o.mode, ScanMode::Exact);
        assert_eq!(serde_json::to_value(ScanMode::Fast).expect("json"), "fast");
    }

    #[test]
    fn reset_forgets_the_tracker_and_the_lock() {
        let mut s = Session::new(None, None, 5);
        s.frame(&blank_jpeg(), &FrameOptions::default());
        s.reset();
        let v = s.frame(&blank_jpeg(), &FrameOptions::default());
        assert_eq!(v.lock.as_ref().map(|l| l.misses), Some(1));
    }
}
