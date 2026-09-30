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
//! **An Exact resolve runs on its own thread** ([`ResolveOn`]). It took **1,316 ms** in the app
//! (debug, 2026-09-15), and while it ran inside a frame no frame was processed: the overlay
//! froze and the lock saw nothing. Now the frame that starts it hands the burst over and returns,
//! later frames go on detecting and tracking, and the first frame after it lands carries the
//! resolution. A result that lands after the card has gone is dropped, never decided — see
//! [`Session::drop_pending_resolve`].
//!
//! **The JSON keys are the debug page's.** `live.html` reads them by name and is not
//! changing, so [`Verdict`] is snake case and
//! `session::tests::every_key_the_debug_page_reads_is_in_the_verdict` scrapes the page for
//! the keys it reads and fails when one leaves.

use crate::cardness::Cardness;
use crate::detect::{
    locate, locate_near, rectify_views, rgb_of, DetectError, DetectOptions, DetectTimings,
    DetectTrace, EdgeMethod, Located, QuadScore,
};
use crate::filters::ScanFilters;
use crate::hash::{hash, HashKind};
use crate::index::{format_uuid, parse_uuid, Mask};
use crate::lock::{LockState, QuadLock};
use crate::reference::{Label, MatchReport, Reference};
use crate::resolve::{BurstView, NoReaders};
pub use crate::resolve::{ChoiceView, Outcome, ResolutionView, TierView};
use crate::track::{CommitRule, Evidence, Observation, Standing, Tracked, Tracker, TrackerOptions};
use crate::ocr::{BandSource, CardPixels};
use crate::trim::Margin;
use crate::watch::{self, CardWatch, Seen};
use image::RgbImage;
use std::collections::VecDeque;
use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::Arc;

type Id = [u8; crate::index::ID_LEN];

/// **The readers run only while the hash tier is still unsure, and never more than every few
/// frames.** The cadence was set when reading a title cost **~340 ms against a ~350 ms frame**
/// (release, measured 2026-09-08 — `docs/reference/card-scanner.md` §4 and §7), when running
/// them on every frame would roughly halve the rate to answer a question that is usually
/// already answered. Since #707 a title read costs about a sixth of that (§4), so the argument is
/// weaker than it was and the cadence has not been re-derived — #705 kept it as it was. They are a tie-breaker: they earn their cost exactly when appearance has
/// failed — a foil under a lamp, where the hash's top five do not contain the card at all and
/// the title is still perfectly legible.
pub const OCR_EVERY: u64 = 4;

/// Fast mode's readers wait for this many consecutive locked frames with no decision.
///
/// A common card decides on the hash in about eight frames, so a reader that ran from the
/// first locked frame spent a third of a second per read on cards that never needed one. Past
/// this, the hash has had its chance and the title read is the rescue it exists to be.
pub const FAST_RESCUE_AFTER: u32 = 8;
/// Fast decides before the vote bar after this many trusted frames in a row that are each
/// clear about the same card — inside [`FAST_EARLY_DISTANCE`] and ahead of the nearest other
/// card by [`FAST_EARLY_MARGIN`]. See [`TrackerOptions::early_frames`].
///
/// **All three came from `eval --trace`** (Windows, release, 2026-09-30, seeds 7, 1 and 2, 160
/// printings each; `docs/reference/card-scanner.md` §5). Across 231 frames with a wrong card on
/// top, none led the next card by more than **10 bits** — a basic land and a split card reached
/// it — while the true card's median frame led by 25 and sat 32 bits away. The margin is
/// the threshold that keeps wrong frames out; the distance keeps the rule to matches well inside
/// the gate, and on its own it would not have been enough (one seed had a wrong card at 41 bits).
///
/// Two frames rather than three: with these thresholds no wrong frame is clear at all, so a
/// third frame guards against nothing the eval has seen and costs a frame on every card.
pub const FAST_EARLY_FRAMES: u32 = 2;
/// How close a clear frame's best card must be, normalized: 0.20 is 51 bits of 256, well inside
/// the 26% where §3's margin median is 21 bits.
pub const FAST_EARLY_DISTANCE: f32 = 0.20;
/// How far behind a clear frame's best card the nearest *other card* must sit: 15 bits.
///
/// **The basic lands were the worry.** A HOB Plains and a HOB Forest are 44 bits apart in the
/// bundle, and a gap only colour explains is the one this must not fire on; the widest gap a
/// wrong basic led by in the trace was 10 bits, against a median of 30 for a right one.
pub const FAST_EARLY_MARGIN: f32 = 15.0 / 256.0;
/// Card-likeness a Fast frame's quad needs to count as clean for the lock's quick path
/// ([`crate::lock::LockOptions::quick_agree`]): the level measured on the real corpus to lose no
/// good match (`cardness::GOOD_SCORE`). The synthetic evaluation has no spurious quads to
/// measure a rejection against, so this is the one threshold here it could not set.
pub const FAST_CLEAN_CARDNESS: f32 = crate::cardness::GOOD_SCORE;
/// The worst corner a clean quad may have, in degrees off square. The upper quartile of real
/// cards' first three frames in the trace was 4.8°, and the detector's own ceiling is 22°.
pub const FAST_CLEAN_ANGLE: f32 = 5.0;
/// Exact mode resolves once the lock has held, with a card detected, for this many frames.
pub const EXACT_STEADY_FRAMES: u32 = 3;
/// How many locked frames an Exact resolve reads over — the ring buffer's length.
pub const EXACT_BURST: usize = 3;
/// A locked card gets the whole frame again after this many frames searched in its window.
///
/// The window can only ever find the card it is centred on, so this is what lets anything
/// else in the frame — a second card, a hand, a better quad the window cannot see — reach the
/// lock at all. Eight is a little over a second and a half at the app's measured 5 frames a
/// second, and costs one full sweep in nine.
pub const FULL_SWEEP_EVERY: u32 = 8;

/// Consecutive frames, far from the decided card and agreeing with each other, that make a new
/// card at rest in Fast (#710). See [`crate::watch`].
pub const FAST_AT_REST: usize = 2;
/// The same in Exact, one more: a false change there costs a whole re-resolve, and a burst
/// cannot resolve before its third frame anyway, so the third costs a stacked card nothing.
pub const EXACT_AT_REST: usize = 3;

/// Where an Exact resolve runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ResolveOn {
    /// On a thread of its own. The frame that starts it returns at once, and the first frame
    /// after it finishes carries the resolution. What the app and the debug server run.
    #[default]
    Background,
    /// Inside the frame that starts it, which then carries the resolution itself.
    ///
    /// **For the evaluation and the tests, where frames to a decision must not depend on a
    /// clock.** In the background a resolve lands on whichever frame follows it, so the same
    /// burst could decide on frame 5 on one run and frame 7 on a loaded machine. Both run the
    /// same resolve on the same views; only which frame waits for it differs.
    Inline,
}

/// What a resolve thread hands back: the resolution, and the title and collector views its
/// reads produced. `Err` is a panic inside it, caught on that thread.
type ResolveResult = std::thread::Result<(ResolutionView, Option<OcrView>, Option<CollectorView>)>;

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
    /// Return the rectified card's preview (`Verdict::rectified`) and its display hash
    /// (`Verdict::hash`). **Off by default because only a developer panel draws either**: the
    /// app's page sets it while the Developer switch is on, and `live.html` always does.
    pub previews: bool,
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
            previews: false,
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
    ///
    /// **The early decision is Fast's alone.** Exact decides on its resolve, and a vote commit
    /// that got there first drops the extra framings from the very frames the resolve's burst is
    /// still collecting — so an early commit there would change what Exact reads, not just when.
    pub fn tracker_options(&self) -> TrackerOptions {
        let fast = self.mode == ScanMode::Fast;
        TrackerOptions {
            rule: self.rule,
            decide_at: self.decide_at.clamp(0.5, 100.0),
            lead_margin: self.lead_margin.clamp(1.0, 5.0),
            early_frames: if fast { FAST_EARLY_FRAMES } else { 0 },
            early_max_normalized: FAST_EARLY_DISTANCE,
            early_margin: FAST_EARLY_MARGIN,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
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
    /// Decided on a run of clear frames before the tally reached `decide_at`. Fast only.
    pub early: bool,
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
    /// The crop the recogniser read, at the size it read it — never a thumbnail of it.
    pub band: Option<String>,
    /// What `band` was warped from, and how many of that image's pixels it spanned.
    pub origin: Option<crate::ocr::BandOrigin>,
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
    /// The printing: Fast's tracked best member — or the printing its collector read named, or
    /// the card its title read named (see [`Session::settle_fast_decision`]) — Exact's first choice.
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

/// Where a frame's detector looked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Search {
    /// Every method and every mask, over the whole frame.
    #[default]
    Full,
    /// One mask, in the window around a trusted lock's quad — see `detect::detect_near`.
    Window,
}

/// One detector's answer for one frame, with its trace either way.
type Attempt = (Result<Located, DetectError>, Option<DetectTrace>);

/// `attempt` for every method, each on a thread of its own when there is more than one, in
/// `methods` order — the whole frame's sweep and a locked card's window alike.
///
/// A panic on a method's thread is carried back to this one, where [`Session::frame`]'s guard
/// catches it as it always has.
fn each_method(
    methods: &[EdgeMethod],
    attempt: impl Fn(EdgeMethod) -> Attempt + Sync,
) -> Vec<(EdgeMethod, Attempt)> {
    if let [only] = methods {
        return vec![(*only, attempt(*only))];
    }
    let attempt = &attempt;
    std::thread::scope(|s| {
        let handles: Vec<_> =
            methods.iter().map(|&m| (m, s.spawn(move || attempt(m)))).collect();
        handles
            .into_iter()
            .map(|(m, h)| (m, h.join().unwrap_or_else(|e| std::panic::resume_unwind(e))))
            .collect()
    })
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
    /// Which search found this frame's card: the window around a trusted lock, or the whole
    /// frame. A locked card that reads `full` on most frames is a window missing the card —
    /// the cost the window exists to save, spent twice.
    pub search: Search,
    pub score: Option<QuadScore>,
    /// The primary view's 256-bit luma dHash, for display. Only when [`FrameOptions::previews`]
    /// asked: the match hashes its own views and never reads this.
    pub hash: Option<String>,
    /// The rectified card as one small JPEG — the proof the homography is right. Only when
    /// [`FrameOptions::previews`] asked (issue #701): it was built on every frame, and with the
    /// Developer switch off nothing drew it.
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
    /// **Send the next frame with a detail image** — the same frame at the camera's own
    /// resolution — because the session expects to read its bands on it. See
    /// [`Session::frame_with_detail`].
    ///
    /// Asked of the session rather than decided by the page because only the session knows
    /// when a read is next: a Fast rescue reads one eligible frame in [`OCR_EVERY`], a Fast
    /// commit reads the frame after it (see [`Session::settle_fast_decision`]), and Exact
    /// may read any frame its burst keeps until the card is resolved.
    pub wants_detail: bool,
    /// The detail frame this frame's readers warped their bands from, when one was sent and
    /// used. `None` on a frame that read nothing, and on one that read from the detection frame
    /// because no detail came or it was not the same frame.
    pub detail: Option<FrameSize>,
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
            search: Search::Full,
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
            wants_detail: false,
            detail: None,
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

/// [`Session::wants_detail`]'s rule, as a free function for [`due`]'s reason — and so it can be
/// driven with no models loaded, which is the only way a test can reach it.
///
/// `can_read` is "readers are loaded, and there is a card in view to read". Fast predicts
/// [`fast_reader_due`] one frame ahead without advancing the cadence; Exact wants one until
/// the card's resolve has run.
fn detail_due(
    mode: ScanMode,
    can_read: bool,
    committed: bool,
    leaderless_locked: u32,
    seq: u64,
    attempted: bool,
) -> bool {
    if !can_read {
        return false;
    }
    match mode {
        ScanMode::Fast => {
            !committed
                && leaderless_locked + 1 >= FAST_RESCUE_AFTER
                && seq.is_multiple_of(OCR_EVERY)
        }
        ScanMode::Exact => !attempted,
    }
}

/// The printing a Fast leader stands for: its tally's best member.
///
/// A card decided on read names alone has no printing in its tally — a name abstains on the
/// printing (`Observation::from_ocr`) — so the tracker reports the card's key. A decision names a
/// printing, so it takes the card's first permitted one rather than passing the oracle id off as
/// one.
fn leader_printing(r: Option<&Reference>, mask: &Mask, best_member: Id) -> Id {
    r.filter(|r| r.label_for(&best_member).is_none())
        .and_then(|r| r.printings_of(&best_member).iter().find(|p| mask.permits(p)).copied())
        .unwrap_or(best_member)
}

/// The printing a Fast decision names, from the tracker's leader and what this stretch read.
///
/// **The card is the title's when a binding title read named one** — whatever the hash
/// prefers, a decision never names a card with another title than the one read off it. **The
/// printing is the collector line's when it names a printing of that card**; a collector read
/// of any other card is a misread digit naming a different real printing, and is ignored as
/// Exact's collector tier ignores it. Otherwise the leader's own printing when the card is the
/// leader, else the title card's nearest printing in this frame's hash candidates, else its
/// first permitted one.
fn fast_printing(
    r: &Reference,
    mask: &Mask,
    leader: &Standing,
    title: Option<Id>,
    pin: Option<Id>,
    observations: &[Observation],
) -> Id {
    let card = title.unwrap_or(leader.id);
    if let Some(p) = pin.filter(|p| r.oracle_for(p) == card) {
        return p;
    }
    if card == leader.id {
        return leader_printing(Some(r), mask, leader.best_member);
    }
    observations
        .iter()
        .filter(|o| o.kind == Evidence::Appearance && o.key == card)
        .min_by(|a, b| a.normalized.total_cmp(&b.normalized))
        .map(|o| o.member)
        .or_else(|| r.printings_of(&card).iter().find(|p| mask.permits(p)).copied())
        .unwrap_or_else(|| leader_printing(Some(r), mask, leader.best_member))
}

/// One locked frame's views, owned, so an Exact resolve can read over the last few of them.
struct StoredView {
    rectified: RgbImage,
    rectified_180: RgbImage,
    alternates: Vec<(RgbImage, RgbImage)>,
    cardness: f32,
    /// Which way up this frame's hash match won — the orientation the readers try first.
    rotated: bool,
    /// The frame the readers warp this view's bands from — kept only while a resolve may still
    /// read it. See [`CardPixels`].
    pixels: Option<CardPixels>,
}

impl StoredView {
    fn view(&self) -> BurstView<'_> {
        BurstView {
            upright: &self.rectified,
            flipped: &self.rectified_180,
            alternates: &self.alternates,
            cardness: self.cardness,
            rotated: self.rotated,
            pixels: self.pixels.as_ref(),
        }
    }
}

/// Where one frame's readers get their pixels: the detail image when one came and is the same
/// frame, otherwise the detection frame itself — and built only if something asks.
///
/// **Lazy because a detail image costs a decode**, a 1080p JPEG being four times the pixels of
/// the frame detection ran on, and a frame whose readers do not run should not pay it. The
/// quad is the one the rectification used — the lock's when the frame was re-rectified from
/// it — so the bands come from the card that was matched and not from a sliver the detector
/// found on this frame alone.
struct FramePixels<'a> {
    /// The detection frame, as the one RGB view of it the whole frame shares.
    frame: &'a RgbImage,
    detail: Option<&'a [u8]>,
    /// The rectification's quad before the inset, in the detection frame's coordinates.
    quad: crate::detect::Quad,
    inset: f32,
    margin: Margin,
    built: std::cell::OnceCell<Option<CardPixels>>,
    /// The detail frame's size, once one has been decoded and used.
    used: std::cell::Cell<Option<FrameSize>>,
}

impl FramePixels<'_> {
    /// Built once, on first use, and kept for the rest of the frame.
    fn get(&self) -> Option<&CardPixels> {
        self.built.get_or_init(|| self.build()).as_ref()
    }

    fn build(&self) -> Option<CardPixels> {
        let warped = self.quad.scaled(self.inset);
        if let Some(p) = self.detail.and_then(|bytes| self.from_detail(bytes, warped)) {
            return Some(p);
        }
        Some(CardPixels::new(self.frame.clone(), warped, self.margin))
    }

    /// The detail image, with the quad carried into its coordinates — or `None` when it does
    /// not decode or cannot be the same frame.
    ///
    /// **Refused on shape, not trusted on arrival.** The quad is scaled by the ratio of the two
    /// widths, which is only right for the same picture at another size; a detail smaller than
    /// the frame, or of another aspect, is some other image, and warping the bands out of it
    /// would read a card that is not there. Falling back to the detection frame costs
    /// resolution, never correctness.
    fn from_detail(&self, bytes: &[u8], warped: crate::detect::Quad) -> Option<CardPixels> {
        let img = image::load_from_memory(bytes).ok()?.into_rgb8();
        let (fw, fh) = (self.frame.width().max(1) as f32, self.frame.height().max(1) as f32);
        let (kx, ky) = (img.width() as f32 / fw, img.height() as f32 / fh);
        if kx < 1.0 || (kx - ky).abs() > 0.02 * kx {
            return None;
        }
        let q = crate::detect::Quad { corners: warped.corners.map(|(x, y)| (x * kx, y * ky)) };
        self.used.set(Some(FrameSize { w: img.width(), h: img.height() }));
        Some(CardPixels::new(img, q, self.margin))
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
    /// Behind an `Arc` so a resolve thread can hold it while frames go on using it.
    reference: Option<Arc<Reference>>,
    reader: Option<Arc<Reader>>,
    tracker: Tracker,
    lock: QuadLock,
    /// Locked frames searched in the window since the last full sweep.
    windowed: u32,
    /// Whether a trusted lock's frame searches its window at all. See [`Session::set_tracking`].
    tracking: bool,
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
    /// An Exact resolve already ran for the card in frame, or is running. Cleared only by a
    /// re-arm being taken (see `rearm_pending`), a reset, or a resolve that panicked.
    attempted: bool,
    /// Where the next resolve runs. See [`ResolveOn`].
    resolve_on: ResolveOn,
    /// The resolve still running, if one is. Dropping it is how a result is thrown away: the
    /// thread's send then fails, and nothing it found reaches the session.
    pending: Option<Receiver<ResolveResult>>,
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
    /// What the card a decision stands on looks like — how a card stacked on it is seen, when
    /// the lock never lets go (#710). See [`crate::watch`] and [`Session::card_changed`].
    watch: CardWatch,
    /// The observations of the far frames the watch is holding, one list per frame of the run,
    /// so the frames a new card first lay at rest still vote for it once the run is long enough.
    stacked: Vec<Vec<Observation>>,
    /// The card the last change forgot, until the next decision says whether it was that card
    /// back. See [`Session::card_changed`] and [`Session::replaces_previous`].
    laid_over: Option<LaidOver>,
    /// The printing the last emitted decision named, beside `previous_card` and cleared with
    /// it — what a change hands to `laid_over`.
    previous_printing: Option<String>,
    /// Which way up this stretch's card matched, once a frame made it plain — `true` for the
    /// 180° rectification — so later frames hash three views rather than six. See
    /// [`Reference::match_views_held`]. Cleared with the stretch and by [`Session::forget_card`].
    held_rotated: Option<bool>,
    /// The card this stretch's last binding title read named ([`crate::resolve::title_binds`]),
    /// in Fast — the card a decision must name. Cleared with the stretch and by
    /// [`Session::forget_card`].
    title_card: Option<Id>,
    /// The printing this stretch's last collector read resolved to under the mask, in Fast.
    /// Cleared with `title_card`.
    collector_pin: Option<Id>,
    /// `(leader, printing)`: the printing the standing Fast decision names, and the tracker's
    /// leader when it was settled. See [`Session::settle_fast_decision`].
    fast_decided: Option<(Id, Id)>,
    /// Fast has just committed and the read that confirms the decision — title and collector,
    /// from the detail frame this asks for — runs on the next locked frame. Until it has, the
    /// decision is not announced.
    decision_read_due: bool,
}

/// The card a change forgot: what the watch held of it, and what its decision named. See
/// [`Session::replaces_previous`].
struct LaidOver {
    card: watch::Remembered,
    oracle: Option<String>,
    printing: Option<String>,
}

impl Session {
    pub fn new(reference: Option<Reference>, reader: Option<Reader>, top: usize) -> Session {
        Session {
            reference: reference.map(Arc::new),
            reader: reader.map(Arc::new),
            tracker: Tracker::default(),
            lock: QuadLock::default(),
            windowed: 0,
            tracking: true,
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
            resolve_on: ResolveOn::default(),
            pending: None,
            burst: VecDeque::with_capacity(EXACT_BURST + 1),
            last_resolution: None,
            rearm_pending: false,
            previous_card: None,
            standing: (0, false),
            watch: CardWatch::default(),
            stacked: Vec::new(),
            laid_over: None,
            previous_printing: None,
            held_rotated: None,
            title_card: None,
            collector_pin: None,
            fast_decided: None,
            decision_read_due: false,
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

    /// Where Exact resolves run from now on. [`ResolveOn::Background`] until this is called.
    pub fn set_resolve_on(&mut self, on: ResolveOn) {
        self.resolve_on = on;
    }

    /// Whether an Exact resolve is running and has not landed yet.
    pub fn resolving(&self) -> bool {
        self.pending.is_some()
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
    /// Search a trusted lock's window (the default), or sweep the whole frame every time.
    ///
    /// The switch the evaluation and `detect-bench` measure the window against, within one
    /// binary — a before and after that differ in that one thing and nothing else.
    pub fn set_tracking(&mut self, on: bool) {
        self.tracking = on;
    }

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
        self.windowed = 0;
        self.previous_card = None;
        self.previous_printing = None;
    }

    /// What a settings change forgets: the tracker's evidence, the burst, the stretch counters,
    /// the held orientation and any resolution — everything [`Session::reset`] does **except the quad lock and the
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
        self.watch.clear();
        self.stacked.clear();
        self.laid_over = None;
        self.held_rotated = None;
        self.title_card = None;
        self.collector_pin = None;
        self.fast_decided = None;
        self.decision_read_due = false;
        self.drop_pending_resolve();
    }

    /// A different card has come to rest where the decided one lay, and the lock never let go
    /// (#710). Nothing else would forget the decided card: this is [`Session::forget_card`] —
    /// the lock kept, since the geometry is still right — plus the previous decision, so the
    /// card on top is added rather than replacing the one under it.
    ///
    /// **The frames the new card lay at rest before the one that confirmed it are kept as its
    /// first**, rather than lost to the at-rest rule: their burst views stay in Exact's burst
    /// and their observations are counted again under the fresh tally, so a stacked card needs
    /// no more frames than a fresh one once the lock holds. The frame that confirmed it is
    /// counted by the caller, as usual.
    ///
    /// **The card it forgot is remembered until the next decision** (`laid_over`: what the
    /// watch held of it, and what its decision named). Two frames of a hand held still over the
    /// decided card, or that card's own worst frames, are a card at rest too, and once the hand
    /// lifts the same card is decided again — [`Session::replaces_previous`] tells it back.
    ///
    /// **Until the next decision, and a resolve that found nothing is not one.** A hand still
    /// long enough for Exact makes a burst of nothing but hand, which resolves `not_found` and is
    /// watched in turn; the card coming back is then a second change, and remembering the hand
    /// over the card it covered added that card twice. So a memory nothing has answered yet is
    /// kept over the newer one.
    fn card_changed(&mut self) {
        let card = self.watch.forgotten();
        let first_votes = std::mem::take(&mut self.stacked);
        let first: Vec<StoredView> =
            self.burst.drain(self.burst.len().saturating_sub(first_votes.len())..).collect();
        let (oracle, printing) = (self.previous_card.take(), self.previous_printing.take());
        let unanswered = self.laid_over.take();
        self.forget_card();
        self.laid_over =
            unanswered.or_else(|| card.map(|card| LaidOver { card, oracle, printing }));
        // This frame, and the ones before it that anything was kept of — their views in Exact,
        // their votes in either mode. A burst guard still waits for a full burst in Exact.
        let kept = first.len().max(first_votes.len()) as u32;
        self.steady = 1 + kept;
        self.leaderless_locked = self.steady;
        self.burst.extend(first);
        for votes in &first_votes {
            self.tracker.observe(votes);
        }
    }

    /// Throw away the resolve still running, so it decides nothing when it lands.
    ///
    /// **Called on everything that says the card in frame may no longer be the one the burst
    /// saw**: a stretch break (the lock stopped trusting its quad), and a mode switch, a filter
    /// change or a Reset through [`Session::forget_card`]. A result that lands after any of them
    /// answers a question nobody is asking any more, and deciding it would add the card that
    /// left — and a different card come to rest over the decided one ([`Session::card_changed`],
    /// #710), which goes through `forget_card`.
    ///
    /// It does not clear `attempted` itself. Nothing was applied, so `last_resolution` is still
    /// `None`, and the re-arm a break arms is taken on the same frame
    /// ([`Session::record_decision`]) — so the next steady stretch resolves again. The thread
    /// runs to its end regardless: an OCR read cannot be interrupted part-way.
    pub fn drop_pending_resolve(&mut self) {
        self.pending = None;
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
            // second opinion on the last one — and a resolve still reading the old burst is
            // about a card that may not be here.
            self.previous_card = None;
            self.previous_printing = None;
            self.laid_over = None;
            // And may come back the other way up — and what was read off it is about a card
            // that may not be here.
            self.held_rotated = None;
            self.title_card = None;
            self.collector_pin = None;
            self.drop_pending_resolve();
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
        // A Fast commit is announced once the read confirming it has run — the frame after the
        // commit, when readers are loaded. See [`Session::settle_fast_decision`].
        let announced = committed && !(self.mode == ScanMode::Fast && self.decision_read_due);
        if self.mode == ScanMode::Fast && announced && !self.was_committed {
            self.decision_seq += 1;
        }
        if committed {
            self.leaderless_locked = 0;
        } else {
            // An untrusted frame never reaches `settle_fast_decision`, and the decided card can
            // leave on one: what was settled for it goes with the commit.
            self.fast_decided = None;
            self.decision_read_due = false;
        }
        if self.rearm_pending && (!committed || self.last_resolution.is_none()) {
            self.attempted = false;
            self.last_resolution = None;
            self.rearm_pending = false;
        }
        // Nothing holds a card any more — it left, or its freeze was lifted — so there is no
        // decision for a card laid on top to end.
        if !committed && !self.attempted {
            self.watch.clear();
        }
        self.was_committed = announced;
    }

    /// The decided card, on a committed frame.
    fn decision_view(&self, t: &Tracked) -> Option<DecisionView> {
        if !t.committed {
            return None;
        }
        let r = self.reference.as_deref();
        match self.mode {
            ScanMode::Fast => {
                // Held back while the read that confirms it is still to come.
                if self.decision_read_due {
                    return None;
                }
                let leader = t.leader()?;
                let printing = match self.fast_decided {
                    Some((key, p)) if key == leader.id => p,
                    _ => leader_printing(r, &self.mask, leader.best_member),
                };
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

    /// Settle what a Fast decision names, once the tracker has committed.
    ///
    /// **Every Fast decision reads both bands first.** The hash decides most cards in about
    /// eight frames, before the rescue reader's turn comes, so a decision used to be made with
    /// the title and the collector line never looked at: the printing was whichever reprint
    /// the hash liked best, and nothing stopped it naming a card whose title the card in hand
    /// plainly did not carry. So a commit with readers loaded is held for one frame
    /// (`decision_read_due`) — the frame that asks the page for the full-resolution detail
    /// frame — and that frame reads both bands. A rescue read on the committing frame itself
    /// already has, and settles at once.
    ///
    /// Then [`fast_printing`]: a binding title read names the card, and a collector read of
    /// that card names the printing.
    fn settle_fast_decision(
        &mut self,
        t: &Tracked,
        r: &Reference,
        observations: &[Observation],
        read: bool,
    ) {
        let Some(leader) = t.leader().filter(|_| t.committed) else {
            self.fast_decided = None;
            self.decision_read_due = false;
            return;
        };
        if self.fast_decided.is_some() {
            return;
        }
        if cfg!(feature = "ocr") && self.reader.is_some() && !read {
            self.decision_read_due = true;
            return;
        }
        self.decision_read_due = false;
        let printing =
            fast_printing(r, &self.mask, leader, self.title_card, self.collector_pin, observations);
        self.fast_decided = Some((leader.id, printing));
    }

    /// Whether the standing decision replaces the one before it — decided on its first frame
    /// and repeated on every later one. See [`DecisionView::replaces_previous`].
    ///
    /// The first frame of a decision is the first frame carrying one whose `decision_seq` is not
    /// the standing one. It compares against the previous card and then becomes it.
    ///
    /// **A card a change forgot, decided again, is that card back** (#710): a second opinion
    /// that replaces the row, not a second copy. Either of two things says so. Its look — the
    /// frame the watch now keeps for it is near what the watch held of the forgotten card, the
    /// anchor and the recent frames alike. Or its printing — the same one the forgotten decision
    /// named, which settles it whatever the look: two copies of one printing look alike and
    /// never make a change at all. A second printing of the same card differs on both, so a
    /// Forest laid on a Forest from another set still adds. Measured on the synthetic stacking
    /// sequence, the look alone left Exact adding a held card twice in 9 piles of 160 that
    /// `main` did not (card-scanner.md §10).
    fn replaces_previous(&mut self, d: &DecisionView) -> bool {
        if self.standing.0 != self.decision_seq {
            if let Some(laid) = self.laid_over.take() {
                let looks_back = self
                    .watch
                    .anchor()
                    .is_some_and(|now| laid.card.distance_to(&now.upright) < watch::CHANGED_BITS);
                if looks_back || laid.printing.as_deref() == Some(d.printing.as_str()) {
                    self.previous_card = laid.oracle;
                }
            }
            let replaces =
                d.oracle_id.is_some() && self.previous_card.as_deref() == d.oracle_id.as_deref();
            self.previous_card = d.oracle_id.clone();
            self.previous_printing = Some(d.printing.clone());
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
        self.frame_with_detail(jpeg, None, opts)
    }

    /// One frame, with the same frame at a higher resolution for the readers.
    ///
    /// **Detection, the lock and the hash never see `detail`**; they run on `jpeg` exactly as
    /// [`Session::frame`] does, so the lock's coordinates do not change scale between a frame
    /// that carried one and a frame that did not. Only the OCR bands are warped out of it, and
    /// only on a frame whose readers run — any other frame ignores it undecoded. The page sends
    /// one when the previous verdict's [`Verdict::wants_detail`] asked for it.
    pub fn frame_with_detail(
        &mut self,
        jpeg: &[u8],
        detail: Option<&[u8]>,
        opts: &FrameOptions,
    ) -> Verdict {
        self.guarded(|s| s.frame_inner(jpeg, detail, opts))
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

    fn frame_inner(&mut self, jpeg: &[u8], detail: Option<&[u8]>, opts: &FrameOptions) -> Verdict {
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

        // ---- locate: where the card is, else the sweep over the methods ------------------
        //
        // **A trusted lock already knows where the card is**, so its frame searches only the
        // window around the held quad — every method, every mask, built to land where the whole
        // frame's sweep would (see `locate_near`). A miss there, a card that is not locked yet,
        // and every `FULL_SWEEP_EVERY`th locked frame get the whole frame, exactly as before, so
        // nothing about *finding* a card changed and a card that moved or was swapped is found
        // again.
        //
        // **Locate only; nothing is flattened until the winner is known** (issue #701). Each
        // method used to rectify its own winner — six full-size warps apiece — and a locked
        // frame then rectified a third time from the held quad, so `Method::Both` made 18
        // warps and three full-frame RGB copies to hash six. One RGB view of the frame now
        // serves every method and the one rectification below.
        let rgb = rgb_of(&source);
        let mut best: Option<(EdgeMethod, Located, Option<DetectTrace>)> = None;
        let mut fallback_trace: Option<DetectTrace> = None;
        let mut error = None;
        let methods = opts.method.edge_methods();
        let mut search = Search::Full;
        let mut attempts = Vec::new();
        if let (true, Some(held)) = (self.tracking, self.lock.trusted_quad()) {
            if self.windowed < FULL_SWEEP_EVERY {
                let lock = self.lock.options();
                let near = each_method(&methods, |m| {
                    locate_near(&source, &held, lock, &opts.detect_options(m, settled))
                });
                if near.iter().any(|(_, (result, _))| result.is_ok()) {
                    attempts = near;
                    search = Search::Window;
                }
            }
        }
        if search == Search::Window {
            self.windowed += 1;
        } else {
            self.windowed = 0;
            attempts =
                each_method(&methods, |m| locate(&source, &rgb, &opts.detect_options(m, settled)));
        }
        for (m, (result, trace)) in attempts {
            match result {
                Ok(d) => {
                    // **Card-likeness picks the method, not the geometric score.** Measured, it
                    // predicts a good match 83% of the time against geometry's 62% — and more
                    // to the point here, geometry made the winner alternate between Canny and
                    // Otsu from frame to frame, handing back a different quad each time.
                    // Nothing can lock onto a target that changes every frame, and a card that
                    // appears for one frame and vanishes is what that looks like from outside.
                    // `rank` adds the edge evidence each detector already weighed its own
                    // candidates by (#703), so the two are compared on the same terms.
                    if best.as_ref().is_none_or(|(_, b, _): &(_, Located, _)| d.rank() > b.rank()) {
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
        v.error = None;
        v.search = search;

        // ---- lock -------------------------------------------------------------------------
        // The lock decides whether this frame is worth believing. Nothing is rejected on
        // appearance — a quad simply has to still be there next frame.
        //
        // In Fast, a clean quad — card-like, every corner square — locks a frame sooner. Exact
        // keeps the three: its resolve counts steady frames from the lock, and #706 owns its
        // timing.
        let clean = best
            .as_ref()
            .is_some_and(|(_, d, _)| clean_quad(self.mode, d.cardness.score, &d.score));
        let lock_state = self.lock.observe_clean(best.as_ref().map(|(_, d, _)| d.quad), clean);
        v.quad = lock_state.quad.map(|q| q.corners);
        let trusted = lock_state.is_trusted();
        let held_quad = lock_state.quad;
        v.lock = Some(lock_state);
        self.count_stretch(trusted, best.is_some(), settled);
        // After the stretch, which drops a resolve whose card has gone, and before the tracker
        // sees this frame — so the frame a resolution lands on is already the decided one.
        self.poll_resolve(&mut v);
        // Whatever the tracker made of this frame, for the decision bookkeeping at the end.
        let mut tracked: Option<Tracked> = None;

        // ---- rectify once: from the quad the lock holds, or else from this frame's own ------
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
        // rectifying from it would be believing it early. A held quad that admits no
        // homography falls back to the frame's own, as it did when both were always built.
        let rectify_started = std::time::Instant::now();
        let views = best.as_ref().and_then(|(method, d, _)| {
            let o = opts.detect_options(*method, settled);
            let relocked = match &held_quad {
                Some(q) if trusted && q.corners != d.quad.corners => rectify_views(&rgb, q, &o),
                _ => None,
            };
            match relocked {
                Some(views) => Some((views, true)),
                None => rectify_views(&rgb, &d.quad, &o).map(|views| (views, false)),
            }
        });
        let rectify_ms = rectify_started.elapsed().as_secs_f32() * 1000.0;

        // A winner whose own quad admits no homography is `DetectError::Degenerate`, as it was
        // when each method rectified inside `detect`. Its card-likeness was scored by warping
        // that same quad, so this is a guard rather than a path any frame is known to take.
        let best = match (best, views) {
            (Some((method, d, trace)), Some(views)) => Some((method, d, trace, views)),
            (Some((_, _, trace)), None) => {
                error = Some(crate::detect::DetectError::Degenerate.to_string());
                fallback_trace = trace;
                None
            }
            (None, _) => None,
        };
        v.ok = best.is_some();

        match best {
            Some((method, d, trace, (views, from_lock))) => {
                let rectified = &views.rectified;
                let rectified_180 = &views.rectified_180;
                let alternates = &views.alternates;
                let margin = views.margin;

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
                v.from_lock = from_lock;
                v.score = Some(d.score);
                if let Some(t) = &trace {
                    // `locate` leaves the rectification to its caller, so the one it did not
                    // make is written in here.
                    let mut timings = t.timings;
                    timings.rectify_ms = rectify_ms;
                    timings.total_ms += rectify_ms;
                    v.timings = Some(timings);
                    v.candidates_examined = Some(t.candidates.len());
                    if opts.stages {
                        v.stages = Some(Stages {
                            binary: preview_uri(&t.binary, 300, 62),
                            contours: preview_uri(&t.contours, 300, 62),
                            quad: preview_uri(&t.quads, 300, 62),
                        });
                    }
                }
                // **Both only on request** (issue #701). The preview is a JPEG encode and a
                // base64 a frame, and the hash a 256-bit dHash that the match below computes
                // again for itself; only a developer panel draws either, so a reader's frame
                // pays for neither.
                if opts.previews {
                    let descriptor = hash(
                        &image::DynamicImage::ImageRgb8(rectified.clone()).to_luma8(),
                        HashKind::DHash,
                        256,
                    );
                    v.hash = Some(descriptor.to_hex());
                    v.rectified = preview_uri(rectified, 320, 78);
                }

                // ---- match, readers, track -------------------------------------------------
                if trusted && matcher {
                    // The quad the rectification above came from: the lock's when it
                    // re-rectified, this frame's own otherwise.
                    let quad = match (from_lock, held_quad) {
                        (true, Some(q)) => q,
                        _ => d.quad,
                    };
                    let pixels = FramePixels {
                        frame: &rgb,
                        detail,
                        quad,
                        inset: opts.detect_options(method, settled).inset,
                        margin,
                        built: std::cell::OnceCell::new(),
                        used: std::cell::Cell::new(None),
                    };
                    tracked = self.match_locked(
                        &mut v,
                        rectified,
                        rectified_180,
                        alternates,
                        d.cardness.score,
                        settled,
                        Some(&pixels),
                    );
                    v.detail = pixels.used.get();
                } else if matcher {
                    // Detected but not yet trusted: tell the tracker nothing was seen, so a
                    // box that never locks can never accumulate a name.
                    let t = self.tracker.observe(&[]);
                    v.tracked = Some(tracked_view(&t, self.reference.as_deref()));
                    tracked = Some(t);
                }
            }
            None => {
                // A frame with no card is still an observation: it is how the tracker learns
                // the card has been taken away. Dropping it would leave stale evidence
                // standing.
                if matcher {
                    let t = self.tracker.observe(&[]);
                    v.tracked = Some(tracked_view(&t, self.reference.as_deref()));
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
        v.wants_detail = self.wants_detail(v.quad.is_some());
        v
    }

    /// Will the next frame's readers run, if it looks like this one? See
    /// [`Verdict::wants_detail`].
    ///
    /// **A prediction, and a wrong one costs little either way.** Asking for a detail the next
    /// frame does not read costs the page one larger encode and the session nothing — an unread
    /// detail is never decoded. Not asking when a read then runs costs only that read's
    /// resolution: it warps from the detection frame, as every read did before details existed.
    ///
    /// Fast mirrors [`fast_reader_due`] one frame ahead: the next locked frame counts one more
    /// leaderless frame, and the cadence reads when the counter is at a multiple of
    /// [`OCR_EVERY`]. Exact asks for as long as the card is unresolved, because the resolve
    /// reads whichever two of its [`EXACT_BURST`] views are the most card-like, and which those
    /// are is not known until it runs. **And Fast asks on every frame a decision is waiting on
    /// its confirming read** ([`Session::settle_fast_decision`]), which is a certainty rather
    /// than a prediction: that read is the whole reason the decision was held back a frame.
    fn wants_detail(&self, card_in_view: bool) -> bool {
        let readers = self.reader.is_some() && self.reference.is_some();
        if self.decision_read_due && readers && card_in_view {
            return true;
        }
        detail_due(
            self.mode,
            readers && card_in_view,
            self.tracker.last_committed(),
            self.leaderless_locked,
            self.seq,
            self.attempted,
        )
    }

    /// A trusted frame with a card in it, against the reference: the match, the mode's readers
    /// or resolve, and the tracker. `None` only without a reference.
    ///
    /// Separate from `frame_inner` so the per-mode logic can be driven with rectified images
    /// directly — nothing a test can build gets through the detector and the lock.
    #[allow(clippy::too_many_arguments)]
    fn match_locked(
        &mut self,
        v: &mut Verdict,
        rectified: &RgbImage,
        rectified_180: &RgbImage,
        alternates: &[(RgbImage, RgbImage)],
        cardness: f32,
        mut settled: bool,
        pixels: Option<&FramePixels<'_>>,
    ) -> Option<Tracked> {
        // A clone of the handle rather than a borrow of the field, so starting a resolve below —
        // or forgetting a card that changed, just below — can take `&mut self` while this frame
        // is still matched against it.
        let r = Arc::clone(self.reference.as_ref()?);
        let r = &*r;
        // ---- is the decided card still the one in frame? (#710) ---------------------------
        // Asked before anything counts this frame, so the frame that confirms a stacked card
        // is already the new card's.
        let rest = if self.mode == ScanMode::Exact { EXACT_AT_REST } else { FAST_AT_REST };
        let seen =
            self.watch.see(watch::descriptor(rectified), || watch::descriptor(rectified_180), rest);
        if seen == Seen::Changed {
            self.card_changed();
            settled = false;
        }
        // Every framing both ways up is offered, because a card is 180°-symmetric, the quad
        // cannot say which end is the top, and the right framing depends on the frame — see
        // `DetectOptions::query_insets`. **Only a stretch's first frames hash both ways up.**
        // Once one has matched plainly, its orientation is held and later frames hash that half
        // alone, widening back to all six on any frame it stops matching. The primary framing
        // first, then the alternates; order matters only for the reported view.
        let mut views: Vec<(&RgbImage, &RgbImage)> = vec![(rectified, rectified_180)];
        views.extend(alternates.iter().map(|(a, b)| (a, b)));
        let gate = self.tracker.options().max_normalized;
        let (report, hold) =
            r.match_views_held(&views, self.top, &self.mask, self.held_rotated, gate);
        self.held_rotated = hold;

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

        // Whether this frame's readers ran — what lets a commit on it settle at once.
        #[cfg_attr(not(feature = "ocr"), allow(unused_mut))]
        let mut read = false;
        match self.mode {
            // The readers, on two kinds of frame. **The rescue**: the hash tier has gone a
            // stretch without settling it. A resolved name is much stronger evidence than a
            // nearest neighbour — it is a reading of what the card says rather than a guess at
            // what it looks like — so it enters the accumulator at a distance the hash tier can
            // rarely reach. **The confirmation**: the frame after a commit, when the decision
            // waits on a read of both bands (see `settle_fast_decision`). Both read the
            // collector line beside the title, so every Fast card has it read at least once.
            ScanMode::Fast => {
                let eligible =
                    fast_reader_due(self.mode, self.leaderless_locked, &mut self.seq, settled);
                let confirming = self.decision_read_due;
                #[cfg(feature = "ocr")]
                if let Some(reader) = self.reader.as_deref().filter(|_| eligible || confirming) {
                    let src = match pixels.and_then(FramePixels::get) {
                        Some(p) => BandSource::Frame(p),
                        None => BandSource::Rectified { upright: rectified, flipped: rectified_180 },
                    };
                    let reads = fast_reads(reader, r, &self.mask, &src, report.rotated, eligible);
                    if let Some(o) = reads.observation {
                        observations.insert(0, o);
                    }
                    if reads.title_card.is_some() {
                        self.title_card = reads.title_card;
                    }
                    if reads.pin.is_some() {
                        self.collector_pin = reads.pin;
                    }
                    v.ocr = Some(reads.ocr);
                    v.collector = Some(reads.collector);
                    read = true;
                }
                #[cfg(not(feature = "ocr"))]
                let _ = (eligible, confirming);
                #[cfg(not(feature = "ocr"))]
                let _ = BandSource::Rectified { upright: rectified, flipped: rectified_180 };
            }
            // No per-frame reader. The last few locked frames are kept, and once the lock has
            // held long enough a resolve reads over all of them — once, until a re-arm is taken
            // (see `Session::record_decision`). A vote commit that got there first does not
            // block it (`commit_to` replaces that tally). A freeze lifting inside an unbroken
            // stretch does not re-arm it; after a break, a resolved card's freeze releasing is
            // what does.
            ScanMode::Exact => {
                // The frame's pixels only while a resolve may still read this view: after the
                // resolve a view is kept for nothing but its place in the ring.
                let readable = self.reader.is_some() && !self.attempted;
                self.burst.push_back(StoredView {
                    rectified: rectified.clone(),
                    rectified_180: rectified_180.clone(),
                    alternates: alternates.to_vec(),
                    cardness,
                    rotated: report.rotated,
                    pixels: pixels.filter(|_| readable).and_then(|p| p.get().cloned()),
                });
                while self.burst.len() > EXACT_BURST {
                    self.burst.pop_front();
                }
                // No term for the tracker. `last_resolution` is only ever `Some` while `attempted`
                // is set, so `!attempted` already says this card has no resolve: a vote commit
                // that got there first cannot block it, and a card decided by a resolve is held
                // off by `attempted` alone until a re-arm is taken. A resolve still running has
                // set `attempted` too, so a second one never starts beside it.
                if self.steady >= EXACT_STEADY_FRAMES
                    && !self.attempted
                    && self.burst.len() == EXACT_BURST
                {
                    self.start_resolve();
                    // Inline, the answer is already there. In the background it lands on a
                    // later frame — or on this one, if it was quick enough.
                    self.poll_resolve(v);
                }
            }
        }

        // A far frame may be one of a new card at rest; its votes wait with the run.
        if seen == Seen::Moved {
            if self.watch.at_rest() == 1 {
                self.stacked.clear();
            }
            self.stacked.push(observations.clone());
        }
        let t = self.tracker.observe(&observations);
        if self.mode == ScanMode::Fast {
            self.settle_fast_decision(&t, r, &observations, read);
        }
        // The frame that decided is the anchor: what the decided card looks like. A resolve
        // that found nothing leaves `attempted` set and nothing to re-arm it while the lock
        // holds, so a card laid over that one is watched for too.
        if !self.watch.is_watching() && (t.committed || self.attempted) {
            self.watch.watch(watch::look(rectified, rectified_180));
        }
        v.tracked = Some(tracked_view(&t, Some(r)));
        v.r#match = Some(report);
        Some(t)
    }

    /// Hand the burst to a resolve, on its own thread or on this one ([`ResolveOn`]).
    ///
    /// **The burst is taken, not copied.** Nothing reads it again until the next resolve, and
    /// that one needs [`EXACT_BURST`] fresh frames either way: it is armed only by a stretch
    /// break, which clears the burst, or by forgetting the card, which does too.
    fn start_resolve(&mut self) {
        let Some(r) = self.reference.clone() else { return };
        let reader = self.reader.clone();
        let mask = self.mask.clone();
        let gate = self.tracker.options().max_normalized;
        let burst: Vec<StoredView> = self.burst.drain(..).collect();
        let (tx, rx) = std::sync::mpsc::channel();
        // Caught here, on the thread that panics, because nothing else would see it: a panic on
        // a spawned thread unwinds only that thread, and `Session::guarded` is not on it.
        let job = move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let views: Vec<BurstView<'_>> = burst.iter().map(StoredView::view).collect();
                run_resolve(&r, &mask, &views, reader.as_deref(), gate)
            }));
            // Refused when the result was dropped while this ran, which is the point of
            // dropping it.
            let _ = tx.send(result);
        };
        self.attempted = true;
        self.pending = Some(rx);
        match self.resolve_on {
            ResolveOn::Inline => job(),
            // A thread the OS will not give us drops `job`, and `tx` with it, so the next poll
            // finds the channel closed and reports a failed resolve rather than waiting for ever.
            ResolveOn::Background => {
                let _ = std::thread::Builder::new().name("exact-resolve".into()).spawn(job);
            }
        }
    }

    /// Apply a resolve that has landed, if one has. A no-op while it is still running.
    fn poll_resolve(&mut self, v: &mut Verdict) {
        let Some(rx) = &self.pending else { return };
        // `None` is a resolve that panicked, or a thread that never started.
        let result = match rx.try_recv() {
            Ok(result) => result.ok(),
            Err(TryRecvError::Empty) => return,
            Err(TryRecvError::Disconnected) => None,
        };
        self.pending = None;
        let Some((resolution, ocr, collector)) = result else {
            // The old inline resolve failed the whole frame here, through the guard, and the
            // next frame tried again. This keeps the frame and lets the burst refill and retry.
            self.attempted = false;
            v.error = Some("the Exact resolve failed on this card — see the log".into());
            return;
        };
        v.ocr = ocr;
        v.collector = collector;
        // Committed before this frame's observation, so the frame that resolved is already the
        // decided one. An ambiguous outcome commits on its best printing's card: the freeze only
        // has to know that *a* card is being held.
        if resolution.outcome != Outcome::NotFound {
            if let Some(r) = self.reference.clone() {
                if let Some(best) = resolution.choices.first().and_then(|c| parse_uuid(&c.id)) {
                    self.tracker.commit_to(r.oracle_for(&best), best);
                }
            }
            self.decision_seq += 1;
            self.last_resolution = Some(resolution.clone());
        }
        v.resolution = Some(resolution);
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

/// Is this frame's quad clean enough for the lock's quick path? Fast only — see
/// [`FAST_CLEAN_CARDNESS`].
fn clean_quad(mode: ScanMode, cardness: f32, score: &QuadScore) -> bool {
    mode == ScanMode::Fast
        && cardness >= FAST_CLEAN_CARDNESS
        && score.max_angle_error <= FAST_CLEAN_ANGLE
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
            ocr: std::sync::Mutex::new(None),
            collector: std::sync::Mutex::new(None),
        };
        let resolution = crate::resolve::resolve(r, mask, burst, &readers, gate);
        let (ocr, collector) = (readers.ocr.into_inner(), readers.collector.into_inner());
        return (
            resolution,
            ocr.unwrap_or_else(std::sync::PoisonError::into_inner),
            collector.unwrap_or_else(std::sync::PoisonError::into_inner),
        );
    }
    #[cfg(not(feature = "ocr"))]
    let _ = reader;
    (crate::resolve::resolve(r, mask, burst, &NoReaders, gate), None, None)
}

/// The production [`crate::resolve::Readers`]: the OCR models, under the session's mask.
///
/// Keeps the last title and collector views it produced, so the frame a resolve ran on fills
/// the verdict's `ocr` and `collector` keys exactly as a Fast read does. Behind mutexes, because
/// the two are read on two threads at once.
///
/// **Both readers start from the way up the frame's hash match won** ([`BurstView::rotated`]).
/// The title reads the other way too unless the first read is an exact name; see
/// [`crate::ocr::TitleReader::read_title_first`].
#[cfg(feature = "ocr")]
struct SessionReaders<'a> {
    reader: &'a Reader,
    r: &'a Reference,
    mask: &'a Mask,
    ocr: std::sync::Mutex<Option<OcrView>>,
    collector: std::sync::Mutex<Option<CollectorView>>,
}

#[cfg(feature = "ocr")]
impl crate::resolve::Readers for SessionReaders<'_> {
    fn title(&self, view: &BurstView<'_>) -> Option<String> {
        let edits = |text: &str| self.r.lookup_by_name_masked(text, self.mask).map(|(_, e)| e);
        let read = self.reader.read_title_first(&bands_of(view), view.rotated, &edits);
        *self.ocr.lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some(title_view(&read, self.r, self.mask).0);
        read.is_usable().then_some(read.normalized)
    }

    fn collector(&self, view: &BurstView<'_>) -> Vec<(String, String)> {
        let col = self.reader.read_collector_first(&bands_of(view), view.rotated);
        *self.collector.lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some(collector_view(&col, self.r, self.mask));
        col.candidates
    }
}

/// Where a burst view's bands come from: its kept frame, else its rectification.
#[cfg(feature = "ocr")]
fn bands_of<'a>(view: &BurstView<'a>) -> BandSource<'a> {
    match view.pixels {
        Some(p) => BandSource::Frame(p),
        None => BandSource::Rectified { upright: view.upright, flipped: view.flipped },
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
        // At its own size and a high quality: the line's strokes are a few pixels wide, and a
        // 360 px, q70 thumbnail of them looked unreadable where the recogniser's input was not.
        band: col.band.as_ref().and_then(|b| preview_uri(b, b.width().max(b.height()), 90)),
        origin: col.origin,
        matched: printing.and_then(|id| r.label_for(&id)).map(|l| l.display()),
    }
}

/// What one Fast frame's readers found.
#[cfg(feature = "ocr")]
struct FastReads {
    ocr: OcrView,
    /// The title read as evidence for the tracker, when it named a card.
    observation: Option<Observation>,
    /// The card the title read named, when it binds ([`crate::resolve::title_binds`]).
    title_card: Option<Id>,
    collector: CollectorView,
    /// The printing the collector line resolved to under the mask.
    pin: Option<Id>,
}

/// The title band and the collector line on one Fast frame, read at the same time — they are
/// different bands of the same pixels and neither needs the other's answer, as in Exact's
/// resolve.
///
/// `rescue` reads the title both ways up and keeps the more plausible, which is what the rescue
/// has always done: it runs exactly when the hash — whose orientation `rotated` is — is not to be
/// trusted. A confirming read starts from the hash's way up and turns only when that read is not
/// an exact name ([`crate::ocr::TitleReader::read_title_first`]).
#[cfg(feature = "ocr")]
fn fast_reads(
    reader: &Reader,
    r: &Reference,
    mask: &Mask,
    src: &BandSource<'_>,
    rotated: bool,
    rescue: bool,
) -> FastReads {
    let (title, col) = std::thread::scope(|s| {
        let col = s.spawn(|| reader.read_collector_first(src, rotated));
        let title = if rescue {
            reader.read_title(src)
        } else {
            let edits = |text: &str| r.lookup_by_name_masked(text, mask).map(|(_, e)| e);
            reader.read_title_first(src, rotated, &edits)
        };
        (title, col.join().unwrap_or_else(|e| std::panic::resume_unwind(e)))
    });
    let (ocr, observation) = title_view(&title, r, mask);
    let title_card = observation
        .filter(|_| ocr.edits.is_some_and(|e| crate::resolve::title_binds(&title.normalized, e)))
        .map(|o| o.key);
    FastReads {
        ocr,
        observation,
        title_card,
        pin: r.lookup_collector_masked(&col.candidates, mask),
        collector: collector_view(&col, r, mask),
    }
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
        early: t.early,
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

    /// A 960×540 JPEG with one card in it — a dark border round light title, art, type and text
    /// bands, which is the horizontal structure card-likeness scores — on a flat grey table,
    /// `dx` pixels right of centre. Moving it a pixel or two a frame is what keeps the lock's
    /// smoothed quad apart from the raw one, which is the case that used to rectify twice.
    fn card_frame_jpeg(dx: u32) -> Vec<u8> {
        let (cw, ch) = (250u32, 349u32);
        let (x0, y0) = (355 + dx, 95u32);
        let img = image::RgbImage::from_fn(960, 540, |x, y| {
            if x < x0 || y < y0 || x >= x0 + cw || y >= y0 + ch {
                return image::Rgb([96, 100, 104]);
            }
            let (cx, cy) = (x - x0, y - y0);
            let border = 11;
            if cx < border || cy < border || cx >= cw - border || cy >= ch - border {
                return image::Rgb([16, 16, 18]);
            }
            let v = match cy as f32 / ch as f32 {
                t if t < 0.10 => 238,
                t if t < 0.55 => 150,
                t if t < 0.62 => 238,
                t if t < 0.92 => 205,
                _ => 140,
            };
            image::Rgb([v, v, v])
        });
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90)
            .encode_image(&img)
            .expect("encode");
        out
    }

    /// **One rectification a frame, whatever the method and whatever the lock** (issue #701).
    /// `Method::Both` used to flatten each method's winner inside `detect` and then, once
    /// locked, flatten the held quad a third time: 18 full-size warps to hash six views. Three
    /// framings, both ways up, is six — and it has to be six on the frames that rectify from
    /// the lock as well as on the ones that do not.
    #[test]
    fn a_locked_frame_makes_six_warps_not_eighteen() {
        let mut s = Session::new(None, None, 5);
        let opts = FrameOptions::default();
        assert_eq!(opts.method, Method::Both, "the case the issue measured");
        // Both methods find this card, so the old path paid for two rectifications before the
        // lock's third — without that, six here would prove nothing.
        let img = image::load_from_memory(&card_frame_jpeg(0)).expect("decode");
        for m in opts.method.edge_methods() {
            let found = locate(&img, &rgb_of(&img), &opts.detect_options(m, false)).0;
            assert!(found.is_ok(), "{m:?} misses the test card: {:?}", found.err());
        }
        let (mut locked, mut relocked) = (0, 0);
        for i in 0..16 {
            crate::detect::WARPS.with(|w| w.set(0));
            let v = s.frame(&card_frame_jpeg(i % 3), &opts);
            let warps = crate::detect::WARPS.with(|w| w.get());
            assert!(v.ok, "frame {i}: {:?}", v.error);
            assert_eq!(warps, 6, "frame {i} made {warps} warps (from_lock {})", v.from_lock);
            if v.lock.as_ref().is_some_and(LockState::is_trusted) {
                locked += 1;
                relocked += usize::from(v.from_lock);
            }
        }
        assert!(locked > 0, "the card never locked, so nothing was measured");
        assert!(relocked > 0, "no frame rectified from the held quad, so that went unmeasured");
    }

    /// The preview and the display hash are built only when asked for.
    #[test]
    fn previews_are_built_only_on_request() {
        let mut s = Session::new(None, None, 5);
        let v = s.frame(&card_frame_jpeg(0), &FrameOptions::default());
        assert!(v.ok, "{:?}", v.error);
        assert!(v.rectified.is_none() && v.hash.is_none());
        let asked = FrameOptions { previews: true, ..Default::default() };
        let v = s.frame(&card_frame_jpeg(0), &asked);
        assert!(v.rectified.as_deref().is_some_and(|r| r.starts_with("data:image/jpeg;base64,")));
        assert_eq!(v.hash.as_deref().map(str::len), Some(64), "256 bits of hex");
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
    fn only_fast_locks_on_a_clean_quad() {
        let square = QuadScore {
            via: crate::detect::QuadSource::Dp,
            skew: 0.0,
            aspect: crate::CARD_ASPECT,
            area_frac: 0.3,
            max_angle_error: 1.0,
            total: 1.0,
        };
        assert!(clean_quad(ScanMode::Fast, 0.9, &square));
        assert!(!clean_quad(ScanMode::Exact, 0.9, &square), "Exact keeps its three frames");
        assert!(!clean_quad(ScanMode::Fast, FAST_CLEAN_CARDNESS - 0.01, &square));
        let skewed = QuadScore { max_angle_error: FAST_CLEAN_ANGLE + 0.5, ..square };
        assert!(!clean_quad(ScanMode::Fast, 0.9, &skewed));
    }

    #[test]
    fn only_fast_decides_early() {
        // Exact decides on its resolve, and an early vote commit would drop the extra framings
        // from the frames its burst is still collecting.
        let fast = FrameOptions::default().tracker_options();
        assert_eq!(fast.early_frames, FAST_EARLY_FRAMES);
        assert!(fast.early_frames > 0);
        let exact = FrameOptions { mode: ScanMode::Exact, ..Default::default() }.tracker_options();
        assert_eq!(exact.early_frames, 0);
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

    /// A session over `r` whose resolves run inside the frame that starts them, so a test can
    /// say which frame decides. See [`ResolveOn::Inline`].
    fn inline(r: Reference) -> Session {
        let mut s = Session::new(Some(r), None, 5);
        s.set_resolve_on(ResolveOn::Inline);
        s
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
            rotated: false,
            pixels: None,
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
            rotated: false,
            pixels: None,
        });
        s.count_stretch(true, false, false);
        assert_eq!((s.steady, s.leaderless_locked), (3, 3), "a missed detection counted or reset");
        assert!(s.attempted && s.burst.len() == 1, "a missed detection broke the stretch");

        // And through the frame path: two locked frames, a trusted miss, one more — the resolve
        // runs on that fourth frame, the third to hold a card.
        let mut s = inline(labelled());
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
        let mut s = inline(bare);
        assert_eq!(s.set_filters(sets(&["hob"])), Err(sentence.to_string()));
        assert!(s.filters().is_empty());

        // Clearing the filters needs no names.
        assert_eq!(s.set_filters(ScanFilters::default()), Ok(()));
    }

    #[test]
    fn filters_that_match_nothing_are_a_sentence_and_keep_the_old_mask() {
        let mut s = inline(labelled());
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
        let mut s = inline(labelled());
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
        let mut s = inline(labelled());
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
        let mut s = inline(labelled());
        s.tracker.observe(&[Observation::from_ocr(id(10), id(1), 0)]);
        s.tracker.observe(&[Observation::from_ocr(id(10), id(1), 0)]);
        let t = s.tracker.observe(&[]);
        assert!(t.committed);
        let d = s.decision_view(&t).expect("decision");
        assert_eq!(d.printing, format_uuid(&id(1)));
    }

    /// Commit Fast on printing 2 (card 10) and settle what the decision names, with `title` and
    /// `pin` as this stretch's reads.
    fn fast_settled(title: Option<u8>, pin: Option<u8>) -> DecisionView {
        let mut s = inline(labelled());
        s.title_card = title.map(id);
        s.collector_pin = pin.map(id);
        let obs = [Observation::appearance(id(10), id(2), 0.16)];
        let mut t = None;
        for _ in 0..8 {
            t = Some(s.tracker.observe(&obs));
        }
        let t = t.expect("frames");
        assert!(t.committed, "the premise: eight clean frames decide");
        let r = Arc::clone(s.reference.as_ref().expect("reference"));
        s.settle_fast_decision(&t, &r, &obs, false);
        s.decision_view(&t).expect("a settled commit has a decision")
    }

    #[test]
    fn a_fast_decision_takes_the_printing_its_collector_line_names() {
        // Printing 1 is the same card as the leader's printing 2: the line pins it.
        assert_eq!(fast_settled(None, Some(1)).printing, format_uuid(&id(1)));
        // Printing 3 is another card — a misread digit — and changes nothing.
        assert_eq!(fast_settled(None, Some(3)).printing, format_uuid(&id(2)));
        assert_eq!(fast_settled(None, None).printing, format_uuid(&id(2)));
    }

    #[test]
    fn a_fast_decision_never_names_a_card_with_another_title_than_the_one_read() {
        // The hash leads with card 10; the title read card 20, whose one printing is 3.
        let d = fast_settled(Some(20), None);
        assert_eq!(d.printing, format_uuid(&id(3)));
        assert_eq!(d.oracle_id, Some(format_uuid(&id(20))));
        assert_eq!(d.label.map(|l| l.name), Some("Card 20".to_string()));
        // A title of the leader's own card keeps the leader's printing, and the collector line
        // still pins within it.
        assert_eq!(fast_settled(Some(10), None).printing, format_uuid(&id(2)));
        assert_eq!(fast_settled(Some(10), Some(1)).printing, format_uuid(&id(1)));
        // And a collector read of a card other than the title's is ignored.
        assert_eq!(fast_settled(Some(20), Some(1)).printing, format_uuid(&id(3)));
    }

    #[test]
    fn a_fast_decision_waiting_on_its_read_is_announced_once_the_read_has_run() {
        let mut s = inline(labelled());
        let r = Arc::clone(s.reference.as_ref().expect("reference"));
        let obs = [Observation::appearance(id(10), id(2), 0.16)];
        let mut t = None;
        for _ in 0..8 {
            t = Some(s.tracker.observe(&obs));
        }
        let t = t.expect("frames");
        // What a commit with readers loaded leaves: the confirming read still to come.
        s.decision_read_due = true;
        s.record_decision(t.committed);
        assert_eq!(s.decision_seq, 0, "announced before its read");
        assert!(s.decision_view(&t).is_none(), "a decision before its read");

        // The next frame read both bands — the title named card 20.
        s.title_card = Some(id(20));
        s.settle_fast_decision(&t, &r, &obs, true);
        assert!(!s.decision_read_due);
        s.record_decision(t.committed);
        assert_eq!(s.decision_seq, 1);
        let d = s.decision_view(&t).expect("decision");
        assert_eq!(d.printing, format_uuid(&id(3)));
        // Frozen frames after it are the same decision, not new ones.
        s.record_decision(true);
        assert_eq!(s.decision_seq, 1);

        // The card leaving takes the settled printing with it.
        s.record_decision(false);
        assert!(s.fast_decided.is_none());
    }

    #[test]
    fn an_exact_decision_is_the_resolution_it_committed_on() {
        let mut s = inline(labelled());
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
        s.poll_resolve(&mut v);
        let t = s.match_locked(&mut v, card, card, &[], 0.5, settled, None);
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
        s.poll_resolve(&mut v);
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
        let mut s = inline(labelled());
        s.mode = ScanMode::Exact;
        for _ in 0..EXACT_STEADY_FRAMES {
            locked_frame(&mut s, &card_image(3));
        }
        assert_eq!(s.decision_seq, 1, "the premise: card three resolved");
        s
    }

    #[test]
    fn an_exact_stretch_resolves_once_and_decides_once() {
        let mut s = inline(labelled());
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

    /// Two views of one card the appearance watch cannot tell apart — `card_image(1)` and
    /// `card_image(3)`, a few bits apart — and a one-entry bundle only the second matches
    /// inside the gate: the first is a burst of a badly framed card that finds nothing, the
    /// second the card steadied. The entry is the second view's descriptor with 76 bits turned
    /// where the two views agree, so the second is 76 bits from it — inside the gate, which
    /// admits under 30% of 256 — and the first is 76 plus the gap between them.
    fn a_view_the_gate_refuses_and_one_it_admits() -> (Reference, RgbImage, RgbImage) {
        use crate::hash::{hash_rgb, HashKind};
        use crate::index::{BundleBuilder, Section};
        let (badly, steadied) = (card_image(1), card_image(3));
        let (x, y) =
            (hash_rgb(&badly, HashKind::DHash, 256), hash_rgb(&steadied, HashKind::DHash, 256));
        assert_ne!(x, y, "the premise: the two views hash apart, so the entry can split them");
        let apart = watch::look(&badly, &badly).distance(&watch::look(&steadied, &steadied));
        assert!(
            apart < watch::CHANGED_BITS,
            "the premise: the watch calls the two views {apart} bits apart — two cards"
        );
        let mut entry = y;
        let agree =
            (0..256usize).filter(|&b| (x.words[b / 64] ^ y.words[b / 64]) >> (b % 64) & 1 == 0);
        for b in agree.take(76) {
            entry.words[b / 64] ^= 1 << (b % 64);
        }
        let mut builder = BundleBuilder::new(HashKind::DHash, 256);
        builder.push(Section::Card, id(3), &entry);
        let mut r = Reference::new(builder.finish(0));
        let label = Label {
            name: "Card 20".into(),
            set: "hob".into(),
            number: "3".into(),
            lang: "en".into(),
            released: "2025-01-01".into(),
        };
        r.add_label(id(3), Some(id(20)), None, label);
        (r, badly, steadied)
    }

    #[test]
    fn a_vote_freeze_after_a_not_found_does_not_hold_back_the_next_stretch() {
        // Spec §6.4: "NotFound commits nothing; the next steady stretch tries again." The card
        // was badly framed for the burst, then steadied, and the tracker's own votes committed
        // and froze on it. That freeze was not made by a resolve, so it must not keep the card
        // undecided for as long as it is held: one lock break, and the next stretch resolves.
        //
        // The two views look alike to the appearance watch, so nothing in the stretch re-arms
        // the resolve and the lock break is what does. (It was the card and its negative until
        // the watch existed — a pair the watch now rightly calls a different card at rest, which
        // is the next test.)
        let (r, badly, card) = a_view_the_gate_refuses_and_one_it_admits();
        let mut s = inline(r);
        s.mode = ScanMode::Exact;

        let mut v = locked_frame(&mut s, &badly);
        for _ in 1..EXACT_STEADY_FRAMES {
            v = locked_frame(&mut s, &badly);
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
    fn a_card_laid_over_one_nothing_matched_resolves_while_the_lock_holds() {
        // A resolve that found nothing leaves the card attempted, and only a stretch break used
        // to re-arm it — so a card laid over an unrecognised one waited for the detector to lose
        // the pile. The watch guards an attempted card as it guards a decided one.
        let (r, card, negative) = one_card_only();
        let mut s = inline(r);
        s.mode = ScanMode::Exact;
        let mut v = locked_frame(&mut s, &negative);
        for _ in 1..EXACT_STEADY_FRAMES {
            v = locked_frame(&mut s, &negative);
        }
        let res = v.resolution.as_ref().expect("the burst resolved");
        assert_eq!(res.outcome, Outcome::NotFound, "the premise: {:?}", res.tiers);

        let (f, v) = frames_to_decide(&mut s, &card, 40)
            .expect("the card laid on top was never resolved while the lock held");
        assert_eq!(f, EXACT_STEADY_FRAMES, "resolved on frame {f}");
        assert_eq!(v.resolution.expect("a resolve").outcome, Outcome::Resolved);
        assert_eq!(v.decision_seq, 1);
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
        let mut s = inline(r);
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
        let mut s = inline(Reference::new(b.finish(0)));
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

    // ---- The resolve off the frame path ------------------------------------------------------

    /// Stand in for a resolve thread that has not answered yet: the session is waiting on the
    /// returned sender, exactly as it waits on a real one.
    fn pending_on(s: &mut Session) -> std::sync::mpsc::Sender<ResolveResult> {
        let (tx, rx) = std::sync::mpsc::channel();
        s.pending = Some(rx);
        s.attempted = true;
        tx
    }

    /// A resolve that found printing `n` of oracle card `oracle`.
    fn resolved_as(n: u8, oracle: u8) -> ResolveResult {
        Ok((
            ResolutionView {
                outcome: Outcome::Resolved,
                choices: vec![ChoiceView {
                    id: format_uuid(&id(n)),
                    oracle_id: Some(format_uuid(&id(oracle))),
                    label: None,
                    distance: Some(0.0),
                }],
                tiers: Vec::new(),
                elapsed_ms: 0.0,
            },
            None,
            None,
        ))
    }

    #[test]
    fn a_background_resolve_decides_on_a_later_frame_and_only_once() {
        // The real thread. Which frame it lands on is the clock's business, so this asserts only
        // what holds whenever it lands: frames go on answering meanwhile, the frame it lands on
        // is already the decided one, and it decides once.
        let mut s = Session::new(Some(labelled()), None, 5);
        assert_eq!(s.resolve_on, ResolveOn::Background, "the app's default");
        s.mode = ScanMode::Exact;
        let card = card_image(3);
        let mut landed = None;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut frames = 0;
        while landed.is_none() && std::time::Instant::now() < deadline {
            let v = locked_frame(&mut s, &card);
            frames += 1;
            if v.resolution.is_some() {
                landed = Some(v);
            } else {
                assert_eq!(v.decision_seq, 0, "decided without a resolution on frame {frames}");
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        }
        let v = landed.expect("the background resolve never landed");
        assert!(frames >= EXACT_STEADY_FRAMES as usize);
        assert!(!s.resolving());
        assert_eq!(v.decision_seq, 1);
        assert!(v.tracked.as_ref().is_some_and(|t| t.committed && t.frozen));
        assert_eq!(v.decision.as_ref().map(|d| d.printing.clone()), Some(format_uuid(&id(3))));
        for _ in 0..20 {
            let v = locked_frame(&mut s, &card);
            assert!(v.resolution.is_none(), "a held card resolved again");
            assert_eq!(v.decision_seq, 1);
        }
    }

    #[test]
    fn frames_go_on_while_a_resolve_runs_and_the_one_it_lands_on_decides() {
        let mut s = inline(labelled());
        s.mode = ScanMode::Exact;
        let card = card_image(3);
        let tx = pending_on(&mut s);
        for f in 0..6 {
            let v = locked_frame(&mut s, &card);
            assert!(v.resolution.is_none() && v.decision.is_none(), "frame {f} decided early");
            assert_eq!(v.decision_seq, 0);
            assert!(s.resolving(), "a second resolve started beside the first on frame {f}");
        }
        // A trusted frame with no detection is still the card under the lock.
        held_frame(&mut s);
        tx.send(resolved_as(3, 20)).expect("the session is still waiting");
        let v = locked_frame(&mut s, &card);
        assert!(v.resolution.is_some(), "the landed resolve was not applied");
        assert_eq!(v.decision_seq, 1);
        assert!(v.tracked.as_ref().is_some_and(|t| t.committed && t.frozen));
        assert_eq!(v.decision.map(|d| d.printing), Some(format_uuid(&id(3))));
    }

    #[test]
    fn a_resolve_whose_card_left_is_dropped_and_the_next_stretch_resolves_again() {
        let mut s = inline(labelled());
        s.mode = ScanMode::Exact;
        let tx = pending_on(&mut s);
        let v = lost_frame(&mut s);
        assert!(!s.resolving(), "a lost lock kept waiting on the old burst");
        assert!(v.resolution.is_none());
        assert!(tx.send(resolved_as(3, 20)).is_err(), "the result still had somewhere to land");
        assert!(!s.attempted, "the break did not re-arm");

        // Nothing it found was decided, and the card now in frame is resolved on its own burst.
        let other = card_image(1);
        let mut v = locked_frame(&mut s, &other);
        for _ in 1..EXACT_STEADY_FRAMES {
            assert_eq!(v.decision_seq, 0);
            v = locked_frame(&mut s, &other);
        }
        let res = v.resolution.as_ref().expect("the next stretch resolved");
        assert_eq!(v.decision_seq, 1);
        assert_ne!(res.choices.first().map(|c| c.id.clone()), Some(format_uuid(&id(3))));
    }

    #[test]
    fn a_card_come_to_rest_over_one_still_resolving_drops_that_resolve() {
        // #710 with #706: the old card's resolve answers for a card that is now under another
        // one. Deciding it would freeze the session on the card underneath, so it lands nowhere,
        // and the card on top is resolved on its own burst.
        let (r, card, negative) = two_far_cards();
        let mut s = inline(r);
        s.mode = ScanMode::Exact;
        locked_frame(&mut s, &card);
        locked_frame(&mut s, &card);
        let tx = pending_on(&mut s);
        // The frame the resolve is running over is the one the watch keeps.
        assert!(locked_frame(&mut s, &card).decision.is_none(), "the premise: still resolving");
        assert!(s.watch.is_watching(), "the premise: a running resolve is watched");

        for _ in 0..EXACT_AT_REST {
            locked_frame(&mut s, &negative);
        }
        assert!(!s.resolving(), "a card laid over it kept waiting on the old burst");
        assert!(
            tx.send(resolved_as(3, 20)).is_err(),
            "the old card's result still had somewhere to land"
        );
        let v = locked_frame(&mut s, &negative);
        assert_eq!(v.decision_seq, 1, "the card on top was not resolved on its own burst");
        assert_eq!(v.decision.and_then(|d| d.oracle_id), Some(format_uuid(&id(30))));
    }

    #[test]
    fn a_mode_switch_a_filter_change_and_a_reset_each_drop_a_running_resolve() {
        let mut s = inline(labelled());
        s.mode = ScanMode::Exact;
        let tx = pending_on(&mut s);
        s.set_mode(ScanMode::Fast);
        assert!(!s.resolving() && tx.send(resolved_as(3, 20)).is_err(), "a mode switch");

        s.set_mode(ScanMode::Exact);
        let tx = pending_on(&mut s);
        s.set_filters(sets(&["hob"])).expect("hob has printings");
        assert!(!s.resolving() && tx.send(resolved_as(3, 20)).is_err(), "a filter change");

        let tx = pending_on(&mut s);
        s.reset();
        assert!(!s.resolving() && tx.send(resolved_as(3, 20)).is_err(), "a reset");
        assert_eq!(s.decision_seq, 0);
    }

    #[test]
    fn a_resolve_that_panicked_says_so_and_tries_again() {
        let mut s = inline(labelled());
        s.mode = ScanMode::Exact;
        let card = card_image(3);
        let tx = pending_on(&mut s);
        tx.send(Err(Box::new("an assertion deep in the OCR crates"))).expect("waiting");
        let v = locked_frame(&mut s, &card);
        assert!(v.error.as_deref().is_some_and(|e| e.contains("resolve failed")), "{:?}", v.error);
        assert_eq!(v.decision_seq, 0);
        assert!(!s.resolving());
        // The burst refills and the card is resolved after all.
        let v = until_decided(&mut s, &card);
        assert!(v.resolution.is_some());
    }

    #[test]
    fn a_resolve_thread_that_never_answered_is_a_failure_and_not_a_wait() {
        let mut s = inline(labelled());
        s.mode = ScanMode::Exact;
        drop(pending_on(&mut s));
        let v = locked_frame(&mut s, &card_image(3));
        assert!(v.error.is_some());
        assert!(!s.resolving() && !s.attempted);
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
        let mut s = inline(r);
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
        let mut s = inline(r);
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
        let mut s = inline(two_far_cards().0);
        until_decided(&mut s, &card);
        lost_frame(&mut s);
        s.set_mode(ScanMode::Exact);
        assert!(!until_decided(&mut s, &card).decision.expect("decision").replaces_previous);
    }

    #[test]
    fn a_different_card_after_a_mode_switch_replaces_nothing() {
        let (r, card, negative) = two_far_cards();
        let mut s = inline(r);
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

    // ---- A card stacked on the decided one (#710) --------------------------------------------
    //
    // A pile is scanned by laying each card on the last, in the same place. The quad lock
    // judges geometry alone, so it never lets go: every frame below is trusted, and the stretch
    // never breaks. What changes is what the card looks like.

    /// Locked frames of `card` until `decision_seq` moves: how many it took, and that frame.
    /// `None` if `limit` frames never moved it.
    fn frames_to_decide(s: &mut Session, card: &RgbImage, limit: u32) -> Option<(u32, Verdict)> {
        let before = s.decision_seq;
        (1..=limit).find_map(|f| {
            let v = locked_frame(s, card);
            (v.decision_seq != before).then_some((f, v))
        })
    }

    #[test]
    fn fast_decides_a_card_stacked_on_a_decided_one_without_ten_frames_of_misses() {
        // **Measured headless before this existed (§7):** the old decision held nine frames of
        // the new card and ended on the tenth, and the new card decided seven frames after that.
        // Two frames at rest are what say the card changed, and the first of them still votes,
        // so the stacked card decides on its eighth frame — what a fresh card takes once the
        // lock holds.
        let (r, card, negative) = two_far_cards();
        let mut s = Session::new(Some(r), None, 5);
        until_decided(&mut s, &card);
        // Its two frames at rest are both leaderless locked frames of a new card, so the title
        // rescue comes when a fresh card's would.
        locked_frame(&mut s, &negative);
        locked_frame(&mut s, &negative);
        assert_eq!(s.leaderless_locked, 2, "the rescue count missed the first frame at rest");
        let (f, v) = frames_to_decide(&mut s, &negative, 40)
            .map(|(f, v)| (f + 2, v))
            .expect("the stacked card was never decided while the lock held");
        assert_eq!(f, 8, "the stacked card decided on frame {f}, not the eighth");
        let d = v.decision.expect("a decision on the deciding frame");
        assert_eq!(d.oracle_id, Some(format_uuid(&id(30))), "the premise: the other card");
        assert!(!d.replaces_previous, "a different card stacked on the last replaced it");
        // Held there, it is one decision, and the card under it is not decided again.
        for f in 0..20 {
            assert_eq!(
                locked_frame(&mut s, &negative).decision_seq,
                2,
                "decided again on frame {f}"
            );
        }
    }

    #[test]
    fn with_the_early_decision_a_clear_stacked_card_decides_on_its_second_frame_at_rest() {
        // #705's early decision needs two clear frames in a row, and the first frame at rest is
        // kept under the fresh tally — so the frame that confirms the change is the second, and
        // a card the hash is sure of decides there, as a fresh card does on its second frame.
        let (r, card, negative) = two_far_cards();
        let mut s = Session::new(Some(r), None, 5);
        s.tracker.set_options(FrameOptions::default().tracker_options());
        assert_eq!(s.tracker.options().early_frames, FAST_EARLY_FRAMES, "the premise: Fast's own");
        let (f, _) = frames_to_decide(&mut s, &card, 40).expect("the premise: the first decides");
        assert_eq!(f, FAST_EARLY_FRAMES, "the premise: a clear fresh card decides early");
        let (f, v) =
            frames_to_decide(&mut s, &negative, 40).expect("the stacked card never decided");
        assert_eq!(f, FAST_EARLY_FRAMES, "the stacked card decided on frame {f}");
        assert_eq!(v.decision.and_then(|d| d.oracle_id), Some(format_uuid(&id(30))));
    }

    /// `card_image(3)` alone in the bundle, as oracle 20 — so its negative, which matches
    /// nothing inside the gate, is a card the hash cannot place at all: a foil under a lamp.
    fn one_card_only() -> (Reference, RgbImage, RgbImage) {
        use crate::hash::{hash_rgb, HashKind};
        use crate::index::{BundleBuilder, Section};
        let (_, card, negative) = two_far_cards();
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
        (r, card, negative)
    }

    #[test]
    fn a_stacked_card_the_hash_cannot_place_still_ends_the_decision() {
        // Under a freeze a frame with candidates but none inside the gate is not a miss — the
        // fix for the Plains that reset itself (§5). So a card nothing matches, stacked on a
        // decided one, used to hold the old decision for as long as it lay there: the old card
        // stayed on screen as the answer for a card that is not it.
        let (r, card, negative) = one_card_only();
        let mut s = Session::new(Some(r), None, 5);
        until_decided(&mut s, &card);
        let ended = (1..=40).find(|_| locked_frame(&mut s, &negative).decision.is_none());
        assert_eq!(ended, Some(2), "the old decision outlived the card stacked over it");
        // And nothing is decided for it, however long it is held — least of all the old card.
        for f in 0..40 {
            let v = locked_frame(&mut s, &negative);
            assert_eq!(v.decision_seq, 1, "decided something on frame {f}");
            assert!(v.decision.is_none(), "frame {f} named a card for one nothing matches");
        }
    }

    #[test]
    fn exact_resolves_a_card_stacked_on_a_decided_one_while_the_lock_holds() {
        // A resolve re-arms only after a stretch break, and a stacked card never breaks the
        // stretch — so the card on top was never resolved until the detector lost it.
        let (r, card, negative) = two_far_cards();
        let mut s = inline(r);
        s.mode = ScanMode::Exact;
        assert!(until_decided(&mut s, &card).resolution.is_some(), "the premise: resolved");
        let (f, v) = frames_to_decide(&mut s, &negative, 40)
            .expect("the stacked card was never resolved while the lock held");
        let res = v.resolution.as_ref().expect("an Exact decision is a resolve");
        assert_eq!(res.choices[0].id, format_uuid(&id(4)), "{:?}", res.tiers);
        // Its first frame at rest is the first of its burst, so it resolves when a fresh
        // card's stretch would.
        assert_eq!(f, EXACT_STEADY_FRAMES, "resolved on frame {f}");
        assert!(!v.decision.expect("decision").replaces_previous);
        for f in 0..20 {
            let v = locked_frame(&mut s, &negative);
            assert!(v.resolution.is_none(), "the held card resolved again on frame {f}");
            assert_eq!(v.decision_seq, 2);
        }
    }

    /// A checkerboard: nothing like either card in `two_far_cards` to the watch, and nothing the
    /// bundle matches inside the gate — a hand carrying a card, on the frames the hand is all
    /// the detector framed.
    fn checker() -> RgbImage {
        RgbImage::from_fn(60, 84, |x, y| {
            image::Rgb([if (x / 6 + y / 6) % 2 == 0 { 40 } else { 210 }; 3])
        })
    }

    #[test]
    fn a_card_decided_on_the_move_is_not_decided_again_when_it_comes_to_rest() {
        // **The watch ends with the decision it guards.** One card decided and taken away — ten
        // lost frames end its freeze — and the next carried in, the hash naming it on every
        // other frame while its look never holds still, so the votes decide it before the
        // watch has seen it at rest. Still watching the first card's look, the second at rest
        // would read as a card laid over the first, and be decided a second time.
        let (r, card, negative) = two_far_cards();
        let hand = checker();
        let (b, h) = (watch::look(&negative, &negative), watch::descriptor(&hand));
        assert!(b.distance_to(&h) > watch::AGREE_BITS, "the premise: the hand and the card agree");
        // Against the bundle's own 256-bit hash, which is what the gate is applied to.
        let bundled = |i: &RgbImage| crate::hash::hash_rgb(i, crate::hash::HashKind::DHash, 256);
        let outside = |d: Option<u32>| {
            d.unwrap_or(0) as f32 / 256.0 >= TrackerOptions::default().max_normalized
        };
        let hand_hash = bundled(&hand);
        assert!(
            outside(hand_hash.distance(&bundled(&card)))
                && outside(hand_hash.distance(&bundled(&negative))),
            "the premise: the hand matched a card"
        );

        let mut s = Session::new(Some(r), None, 5);
        until_decided(&mut s, &card);
        for _ in 0..10 {
            lost_frame(&mut s);
        }
        assert!(!s.tracker.last_committed(), "the premise: the first card's freeze ended");
        let on_the_move = (0..40).find(|f| {
            locked_frame(&mut s, if f % 2 == 0 { &negative } else { &hand }).decision_seq == 2
        });
        assert!(on_the_move.is_some(), "the premise: the second card was decided on the move");
        for f in 0..20 {
            assert_eq!(
                locked_frame(&mut s, &negative).decision_seq,
                2,
                "decided again at rest, frame {f}"
            );
        }
    }

    #[test]
    fn exact_wants_three_frames_at_rest_and_still_resolves_on_the_third() {
        // **Measured on the stacking sequence against `main`:** with two frames, Exact still
        // added a card twice in 4 more piles of 160 — a false change there costs a whole
        // re-resolve. Exact cannot resolve before its burst holds three frames anyway, so a third
        // frame at rest costs it nothing: the two before are kept as the burst's first two.
        let (r, card, negative) = two_far_cards();
        let hand = checker();
        let mut s = inline(r);
        s.mode = ScanMode::Exact;
        until_decided(&mut s, &card);
        for _ in 0..EXACT_AT_REST - 1 {
            locked_frame(&mut s, &hand);
        }
        assert!(s.tracker.last_committed(), "Exact changed on fewer than {EXACT_AT_REST} frames");
        locked_frame(&mut s, &card);
        assert!(s.tracker.last_committed(), "the hand lifted and the card is still decided");
        let (f, v) = frames_to_decide(&mut s, &negative, 40).expect("the stacked card resolved");
        assert_eq!(f, EXACT_STEADY_FRAMES, "resolved on frame {f}");
        assert_eq!(v.decision.and_then(|d| d.oracle_id), Some(format_uuid(&id(30))));
    }

    #[test]
    fn a_hand_that_stops_on_the_decided_card_and_lifts_is_not_a_second_copy() {
        // **Measured on the synthetic stacking sequence:** two frames of a hand held still over
        // the decided card are a card at rest to the watch, so the card is forgotten — and once
        // the hand lifts it is decided again. That decision's own look is the card the change
        // forgot, so it is a second opinion on it, not a second copy: it replaces the row.
        for mode in [ScanMode::Fast, ScanMode::Exact] {
            let (r, card, _) = two_far_cards();
            let hand = checker();
            let mut s = inline(r);
            s.mode = mode;
            let first = until_decided(&mut s, &card).decision.expect("decision");
            let rest = if mode == ScanMode::Exact { EXACT_AT_REST } else { FAST_AT_REST };
            for _ in 0..rest {
                locked_frame(&mut s, &hand);
            }
            assert!(!s.tracker.last_committed(), "the premise ({mode:?}): the hand was a change");
            let again = until_decided(&mut s, &card).decision.expect("decision");
            assert_eq!(again.oracle_id, first.oracle_id, "the premise ({mode:?}): the same card");
            assert!(again.replaces_previous, "a hand that lifted added the card twice ({mode:?})");
        }
    }

    #[test]
    fn a_resolve_naming_the_printing_a_change_forgot_is_not_a_second_copy() {
        // **Measured on the synthetic stacking sequence:** after a change the watch made in
        // error, the frame a re-resolve starts on can still be the far one — under the hand, or
        // the card's own worst frame — so its look is not the forgotten card's. The printing
        // settles what the look cannot: two copies of one printing look alike and never make a
        // change at all, so a change followed by that same printing is the card back.
        let (r, card, _) = two_far_cards();
        let hand = checker();
        let mut s = inline(r);
        s.mode = ScanMode::Exact;
        let first = until_decided(&mut s, &card).decision.expect("decision");
        assert_eq!(first.printing, format_uuid(&id(3)), "the premise: printing 3");
        for _ in 0..EXACT_AT_REST {
            locked_frame(&mut s, &hand);
        }
        assert!(!s.tracker.last_committed(), "the premise: the hand was a change");
        // A resolve is running, and the frame the watch keeps for it is the hand.
        let tx = pending_on(&mut s);
        locked_frame(&mut s, &hand);
        tx.send(resolved_as(3, 20)).expect("the session is still waiting");
        let again = locked_frame(&mut s, &hand).decision.expect("the resolve landed");
        assert_eq!(again.printing, first.printing, "the premise: the same printing");
        assert!(again.replaces_previous, "the same printing after a change was added twice");
    }

    #[test]
    fn the_card_back_under_another_printing_is_told_by_its_look() {
        // Fast's printing is the tally's best member, and a card decided again after a change
        // made in error can come back as a reprint the hash likes a bit better this time. The
        // printing no longer says it is the same card; the look still does.
        use crate::hash::{hash_rgb, HashKind};
        use crate::index::{BundleBuilder, Section};
        let a = card_image(3);
        let mut a2 = a.clone();
        for x in 0..12 {
            for y in 60..72 {
                a2.put_pixel(x, y, image::Rgb([250, 250, 250]));
            }
        }
        let apart = watch::look(&a, &a).distance(&watch::look(&a2, &a2));
        assert!(apart < watch::CHANGED_BITS, "the premise: {apart} bits is not one look");
        let mut b = BundleBuilder::new(HashKind::DHash, 256);
        b.push(Section::Card, id(5), &hash_rgb(&a, HashKind::DHash, 256));
        b.push(Section::Card, id(6), &hash_rgb(&a2, HashKind::DHash, 256));
        let mut r = Reference::new(b.finish(0));
        for (n, set) in [(5u8, "hob"), (6, "ltr")] {
            let label = Label {
                name: "Card 50".into(),
                set: set.into(),
                number: n.to_string(),
                lang: "en".into(),
                released: "2025-01-01".into(),
            };
            r.add_label(id(n), Some(id(50)), None, label);
        }
        let mut s = Session::new(Some(r), None, 5);
        let first = until_decided(&mut s, &a).decision.expect("decision");
        assert_eq!(first.printing, format_uuid(&id(5)), "the premise: the first printing");
        locked_frame(&mut s, &checker());
        locked_frame(&mut s, &checker());
        assert!(!s.tracker.last_committed(), "the premise: the hand was a change");
        let again = until_decided(&mut s, &a2).decision.expect("decision");
        assert_eq!(again.printing, format_uuid(&id(6)), "the premise: the other printing");
        assert!(again.replaces_previous, "the card back as another printing was added twice");
    }

    #[test]
    fn a_second_printing_of_the_decided_card_stacked_on_it_is_a_second_copy() {
        // **Sorting basics.** A Forest from one set laid on a Forest from another is a second
        // card, and the tray must add it. Under the freeze it never even counted as a miss —
        // the hash names the same oracle card, which is the decided one.
        use crate::hash::{hash_rgb, HashKind};
        use crate::index::{BundleBuilder, Section};
        let (_, card, negative) = two_far_cards();
        let mut b = BundleBuilder::new(HashKind::DHash, 256);
        b.push(Section::Card, id(3), &hash_rgb(&card, HashKind::DHash, 256));
        b.push(Section::Card, id(4), &hash_rgb(&negative, HashKind::DHash, 256));
        let mut r = Reference::new(b.finish(0));
        for (n, set) in [(3u8, "hob"), (4, "ltr")] {
            let label = Label {
                name: "Forest".into(),
                set: set.into(),
                number: n.to_string(),
                lang: "en".into(),
                released: "2025-01-01".into(),
            };
            r.add_label(id(n), Some(id(20)), None, label);
        }
        let mut s = Session::new(Some(r), None, 5);
        until_decided(&mut s, &card);
        let (_, v) = frames_to_decide(&mut s, &negative, 40)
            .expect("the second printing was never decided while the lock held");
        let d = v.decision.expect("decision");
        assert_eq!(d.printing, format_uuid(&id(4)));
        assert!(!d.replaces_previous, "a second Forest replaced the first instead of adding");
    }

    #[test]
    fn a_stretch_hashes_both_ways_up_once_and_then_holds_one() {
        let mut s = Session::new(Some(labelled()), None, 5);
        let card = card_image(3);
        let flipped = image::imageops::rotate180(&card);
        // One locked frame of the card, given as `(upright, rotated)`; the descriptors it cost.
        let hashes = |s: &mut Session, upright: &RgbImage, rotated: &RgbImage| {
            let settled = s.tracker.last_committed();
            s.count_stretch(true, true, settled);
            let mut v = Verdict::failed(
                String::new(),
                FrameSize { w: 0, h: 0 },
                0.0,
                true,
                s.mode,
                s.decision_seq,
            );
            let t = s.match_locked(&mut v, upright, rotated, &[], 0.5, settled, None);
            s.conclude(&mut v, t.as_ref());
            v.r#match.expect("a locked frame with a reference matches").hashes
        };

        assert_eq!(hashes(&mut s, &card, &flipped), 2, "the first frame searched both ways up");
        assert_eq!(s.held_rotated, Some(false));
        for _ in 0..3 {
            assert_eq!(hashes(&mut s, &card, &flipped), 1, "a held card was hashed both ways up");
        }

        // Turned over mid-stretch: the held way up stops matching, the frame widens, and the
        // hold follows the card.
        assert_eq!(hashes(&mut s, &flipped, &card), 2);
        assert_eq!(s.held_rotated, Some(true));
        assert_eq!(hashes(&mut s, &flipped, &card), 1);

        // A broken stretch forgets the hold — the next card may come the other way up.
        s.count_stretch(false, false, false);
        assert_eq!(s.held_rotated, None, "a lost lock kept its held orientation");
        hashes(&mut s, &card, &flipped);
        assert!(s.held_rotated.is_some());
        // And so does a settings change, with everything else the card had gathered.
        s.set_mode(ScanMode::Exact);
        assert_eq!(s.held_rotated, None, "a mode switch kept its held orientation");
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

    /// A banded card on a dark ground, centred at `cx` in a 960×540 frame — the page's size.
    fn card_jpeg(cx: f32) -> Vec<u8> {
        let (card_w, cy) = (260.0f32, 270.0f32);
        let card_h = card_w / crate::CARD_ASPECT;
        let img = image::RgbImage::from_fn(960, 540, |x, y| {
            let (dx, dy) = (x as f32 - cx, y as f32 - cy);
            if dx.abs() > card_w / 2.0 || dy.abs() > card_h / 2.0 {
                return image::Rgb([20, 20, 24]);
            }
            // The title band, art, type line, text box and info line `cardness` looks for.
            let v = match (dy + card_h / 2.0) / card_h {
                t if t < 0.10 => 240,
                t if t < 0.55 => 150,
                t if t < 0.62 => 240,
                t if t < 0.92 => 200,
                _ => 140,
            };
            image::Rgb([v; 3])
        });
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90)
            .encode_image(&img)
            .expect("encode");
        out
    }

    #[test]
    fn a_locked_card_is_searched_in_its_window_and_swept_every_so_often() {
        let mut s = Session::new(None, None, 5);
        let jpeg = card_jpeg(480.0);
        let seen: Vec<Search> = (0..14)
            .map(|i| {
                let v = s.frame(&jpeg, &FrameOptions::default());
                assert!(v.ok, "frame {i} lost the card: {:?}", v.error);
                v.search
            })
            .collect();
        // Three frames to lock, all swept; then the window, with a full sweep after every
        // `FULL_SWEEP_EVERY` of them.
        let mut want = vec![Search::Full; 3];
        want.extend(std::iter::repeat_n(Search::Window, FULL_SWEEP_EVERY as usize));
        want.extend([Search::Full, Search::Window, Search::Window]);
        assert_eq!(seen, want);
    }

    #[test]
    fn a_card_that_left_its_window_is_found_by_the_sweep() {
        let mut s = Session::new(None, None, 5);
        for _ in 0..4 {
            s.frame(&card_jpeg(480.0), &FrameOptions::default());
        }
        // Moved further than the lock's drift allows: the window around the old place sees
        // only a card's edge running out of it, and has to hand the frame to the sweep.
        let v = s.frame(&card_jpeg(200.0), &FrameOptions::default());
        assert!(v.ok, "the sweep did not find the moved card: {:?}", v.error);
        assert_eq!(v.search, Search::Full);
        let x = v.quad_raw.expect("a quad").iter().map(|c| c.0).sum::<f32>() / 4.0;
        assert!((x - 200.0).abs() < 10.0, "the quad is centred at {x}, not where the card went");
    }

    #[test]
    fn a_detail_is_asked_for_exactly_the_frame_a_fast_rescue_will_read() {
        // Walk the Fast cadence the way the frames do, and check that the frame after every
        // `wants_detail` is one `fast_reader_due` reads — and that no read goes unasked.
        let (mut seq, mut leaderless) = (0u64, 0u32);
        let mut asked = false;
        for _ in 0..40 {
            leaderless += 1;
            let reads = fast_reader_due(ScanMode::Fast, leaderless, &mut seq, false);
            assert_eq!(asked, reads, "asked {asked} for a frame that read {reads} (frame {leaderless})");
            asked = detail_due(ScanMode::Fast, true, false, leaderless, seq, false);
        }
    }

    #[test]
    fn no_detail_is_asked_for_without_readers_a_card_or_a_question() {
        // No readers, or nothing in view: nothing will read.
        assert!(!detail_due(ScanMode::Fast, false, false, 50, 0, false));
        assert!(!detail_due(ScanMode::Exact, false, false, 0, 0, false));
        // A decided card is not read again, and a resolved one has had its resolve.
        assert!(!detail_due(ScanMode::Fast, true, true, 50, 0, false));
        assert!(!detail_due(ScanMode::Exact, true, false, 0, 0, true));
        // Before the rescue stretch, Fast is the hash alone.
        assert!(!detail_due(ScanMode::Fast, true, false, 0, 0, false));
        // An unresolved Exact card may be read on any frame the burst keeps.
        assert!(detail_due(ScanMode::Exact, true, false, 0, 3, false));
    }

    #[test]
    fn a_session_with_no_readers_never_asks_for_a_detail() {
        // The shipped build without models loaded: the page must never pay a full-size encode
        // for a read that cannot happen.
        let mut s = Session::new(Some(labelled()), None, 5);
        for mode in [ScanMode::Fast, ScanMode::Exact] {
            let v = s.frame(&blank_jpeg(), &FrameOptions { mode, ..Default::default() });
            assert!(!v.wants_detail, "{mode:?} asked for a detail with no reader");
            assert!(v.detail.is_none());
        }
    }

    /// A frame and a detail image of it for [`FramePixels`], `k` times the size, as PNG bytes.
    fn frame_and_detail(k: u32) -> (RgbImage, Vec<u8>) {
        let frame = RgbImage::from_fn(120, 90, |x, y| image::Rgb([(x * 2) as u8, (y * 2) as u8, 90]));
        let big = image::imageops::resize(&frame, 120 * k, 90 * k, image::imageops::FilterType::Triangle);
        let mut png = Vec::new();
        image::DynamicImage::ImageRgb8(big)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("png");
        (frame, png)
    }

    fn pixels_for<'a>(frame: &'a RgbImage, detail: Option<&'a [u8]>) -> FramePixels<'a> {
        FramePixels {
            frame,
            detail,
            quad: crate::detect::Quad { corners: [(20.0, 10.0), (80.0, 10.0), (80.0, 80.0), (20.0, 80.0)] },
            inset: 1.0,
            margin: Margin::default(),
            built: std::cell::OnceCell::new(),
            used: std::cell::Cell::new(None),
        }
    }

    #[test]
    fn a_detail_of_the_same_frame_is_read_with_the_quad_scaled_onto_it() {
        let (frame, detail) = frame_and_detail(3);
        let p = pixels_for(&frame, Some(&detail));
        let got = p.get().expect("pixels");
        assert_eq!(p.used.get().map(|s| (s.w, s.h)), Some((360, 270)));
        assert_eq!(got.image().dimensions(), (360, 270));
        // The same band out of the frame and out of the detail: the quad landed on the same
        // pixels, so the two agree to within resampling.
        let from_frame = pixels_for(&frame, None);
        let a = got.band((0.1, 0.1, 0.9, 0.3), 2, false).expect("band");
        let b = from_frame.get().expect("pixels").band((0.1, 0.1, 0.9, 0.3), 2, false).expect("band");
        assert_eq!(a.dimensions(), b.dimensions());
        let diff: f64 = a.pixels().zip(b.pixels())
            .map(|(p, q)| p.0.iter().zip(q.0).map(|(x, y)| (*x as f64 - y as f64).abs()).sum::<f64>())
            .sum::<f64>() / (a.width() * a.height() * 3) as f64;
        assert!(diff < 4.0, "the detail's band is not the frame's band: mean diff {diff:.2}");
    }

    #[test]
    fn a_detail_that_cannot_be_the_same_frame_is_refused_for_the_frame_itself() {
        let (frame, _) = frame_and_detail(1);
        // Another aspect: some other picture, so the quad would land on a card that is not there.
        let other = {
            let mut png = Vec::new();
            image::DynamicImage::ImageRgb8(RgbImage::new(240, 240))
                .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                .expect("png");
            png
        };
        for bytes in [other.as_slice(), b"not a jpeg".as_slice()] {
            let p = pixels_for(&frame, Some(bytes));
            let got = p.get().expect("the frame is still there to read from");
            assert_eq!(got.image().dimensions(), (120, 90), "read from a refused detail");
            assert!(p.used.get().is_none(), "a refused detail was reported as used");
        }
    }
}
