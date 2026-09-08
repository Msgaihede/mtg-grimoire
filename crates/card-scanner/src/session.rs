//! One frame in, one verdict out — the per-frame pipeline both callers share.
//!
//! The debug server (`bin/serve.rs`) and the app (`src-tauri/src/scanner.rs`) each hand a
//! JPEG and a [`FrameOptions`] to a [`Session`] and get a [`Verdict`] back. Everything that
//! decides a frame lives here once: the detector sweep, the quad lock, the rectification from
//! the lock's quad, the descriptor and the search, the two readers and their cadence, the
//! tracker, and the panic guard. What stays with each caller is transport: a query string or
//! an IPC header in, JSON out, plus the server's log line and dump directory.
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
use crate::hash::{hash, HashKind};
use crate::index::{format_uuid, parse_uuid, Mask};
use crate::lock::{LockState, QuadLock};
use crate::reference::{Label, MatchReport, Reference};
use crate::track::{CommitRule, Observation, Tracker, TrackerOptions};
use crate::trim::Margin;

/// **The readers run only while the hash tier is still unsure, and never more than every few
/// frames.** Reading a title costs ~250 ms against a ~80 ms frame (release), so running them
/// on every frame would cut the rate by two thirds to answer a question that is usually
/// already answered. They are a tie-breaker: they earn their cost exactly when appearance has
/// failed — a foil under a lamp, where the hash's top five do not contain the card at all and
/// the title is still perfectly legible.
pub const OCR_EVERY: u64 = 4;

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
}

impl Verdict {
    fn failed(error: String, frame: FrameSize, decode_ms: f32, matcher: bool) -> Verdict {
        Verdict {
            ok: false,
            error: Some(error),
            frame,
            decode_ms,
            matcher,
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
        }
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
    pub fn reset(&mut self) {
        self.tracker.reset();
        self.lock.reset();
    }

    /// Should the readers run on this frame? Every `OCR_EVERY`-th *eligible* frame, and never
    /// once committed — an expensive tier stands down when the cheap one has settled it, and
    /// the frames it stood down for do not count against its turn. See [`due`].
    pub fn reader_due(&mut self, committed: bool) -> bool {
        due(&mut self.seq, committed)
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
            ),
        }
    }

    fn frame_inner(&mut self, jpeg: &[u8], opts: &FrameOptions) -> Verdict {
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
                )
            }
        };
        let decode_ms = decode_started.elapsed().as_secs_f32() * 1000.0;
        let frame = FrameSize { w: source.width(), h: source.height() };

        // The caller's rule and bar, applied before anything reads the verdict: the tally is
        // kept, only the judgement of it changes.
        self.tracker.set_options(opts.tracker_options());
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

        let mut v = Verdict::failed(String::new(), frame, decode_ms, matcher);
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
                // Both orientations are hashed inside the match, because a card is
                // 180°-symmetric and the quad cannot say which end is the top.
                if let Some(r) = self.reference.as_ref().filter(|_| trusted) {
                    // The primary framing first, then the alternates — see
                    // `DetectOptions::query_insets`. Order matters only for the reported view.
                    let mut views: Vec<(&image::RgbImage, &image::RgbImage)> =
                        vec![(rectified, rectified_180)];
                    views.extend(alternates.iter().map(|(a, b)| (a, b)));
                    let report = r.match_views(&views, self.top, &Mask::all());

                    // Accumulate across frames. A per-frame top-1 flickers between near-ties
                    // several times a second; the stable answer is the one that keeps
                    // recurring. Grouped by oracle id: a card's reprints pool their evidence
                    // instead of splitting it, and the printing reported is the best-scoring
                    // member.
                    //
                    // The `mut` is for the reader tiers below, which insert ahead of the
                    // appearance candidates — so without `ocr` compiled in nothing writes to
                    // it and the compiler is right to say so.
                    #[cfg_attr(not(feature = "ocr"), allow(unused_mut))]
                    let mut observations: Vec<Observation> = report
                        .candidates
                        .iter()
                        .filter_map(|c| {
                            parse_uuid(&c.id).map(|id| {
                                Observation::appearance(r.oracle_for(&id), id, c.normalized)
                            })
                        })
                        .collect();

                    // The reader tiers, when the hash tier has not settled it. A resolved name
                    // is much stronger evidence than a nearest neighbour — it is a reading of
                    // what the card says rather than a guess at what it looks like — so it
                    // enters the accumulator at a distance the hash tier can rarely reach.
                    #[cfg(feature = "ocr")]
                    if let Some(reader) = self.reader.as_ref() {
                        if due(&mut self.seq, settled) {
                            // The collector line first: when it resolves, it has named the
                            // printing outright and the title can only agree less specifically.
                            let (col, obs) = read_collector(reader, r, rectified, rectified_180);
                            if let Some(o) = obs {
                                observations.insert(0, o);
                            }
                            v.collector = Some(col);
                            let (ocr, obs) = read_title(reader, r, rectified, rectified_180);
                            if let Some(o) = obs {
                                observations.insert(0, o);
                            }
                            v.ocr = Some(ocr);
                        }
                    }
                    #[cfg(not(feature = "ocr"))]
                    {
                        let _ = due(&mut self.seq, settled);
                    }

                    let tracked = self.tracker.observe(&observations);
                    v.tracked = Some(tracked_view(&tracked, Some(r)));
                    v.r#match = Some(report);
                } else if matcher {
                    // Detected but not yet trusted: tell the tracker nothing was seen, so a
                    // box that never locks can never accumulate a name.
                    let tracked = self.tracker.observe(&[]);
                    v.tracked = Some(tracked_view(&tracked, self.reference.as_ref()));
                }
            }
            None => {
                // A frame with no card is still an observation: it is how the tracker learns
                // the card has been taken away. Dropping it would leave stale evidence
                // standing.
                if matcher {
                    let tracked = self.tracker.observe(&[]);
                    v.tracked = Some(tracked_view(&tracked, self.reference.as_ref()));
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
        v
    }
}

/// The collector line, and the printing it resolved to.
#[cfg(feature = "ocr")]
fn read_collector(
    reader: &Reader,
    r: &Reference,
    rectified: &image::RgbImage,
    rectified_180: &image::RgbImage,
) -> (CollectorView, Option<Observation>) {
    // **Every pairing the parse produced, and what each resolved to.** "It failed" and "it
    // read HOBEN where the card says HOB" look identical from a verdict and are completely
    // different problems — one is a bad crop, the other a misread character, and only the list
    // of attempts tells them apart. Capped, because a noisy read can produce dozens and the
    // panel is for reading.
    const SHOWN: usize = 14;
    let col = reader.read_collector(rectified, rectified_180);
    let printing = r.lookup_collector(&col.candidates);
    let tried = col
        .candidates
        .iter()
        .take(SHOWN)
        .map(|(set, number)| CollectorTry {
            set: set.clone(),
            number: number.clone(),
            matched: r
                .lookup_pair(set, number)
                .and_then(|id| r.label_for(&id))
                .map(|l| l.display()),
        })
        .collect();
    let view = CollectorView {
        raw: col.raw.clone(),
        rotated: col.rotated,
        elapsed_ms: col.elapsed_ms,
        pairings: col.candidates.len(),
        tried,
        more: col.candidates.len().saturating_sub(SHOWN),
        band: col.band.as_ref().and_then(|b| preview_uri(b, 360, 70)),
        matched: printing.and_then(|id| r.label_for(&id)).map(|l| l.display()),
    };
    let obs = printing.map(|id| Observation::from_collector(r.oracle_for(&id), id));
    (view, obs)
}

/// The title band, and the name it resolved to.
#[cfg(feature = "ocr")]
fn read_title(
    reader: &Reader,
    r: &Reference,
    rectified: &image::RgbImage,
    rectified_180: &image::RgbImage,
) -> (OcrView, Option<Observation>) {
    let read = reader.read_title(rectified, rectified_180);
    let hit = read.is_usable().then(|| r.lookup_by_name(&read.normalized)).flatten();
    let view = OcrView {
        raw: read.raw.clone(),
        normalized: read.normalized.clone(),
        rotated: read.rotated,
        elapsed_ms: read.elapsed_ms,
        band: read.band.as_ref().and_then(|b| preview_uri(b, 360, 70)),
        matched: hit.and_then(|(id, _)| r.label_for(&id)).map(|l| l.name),
        edits: hit.map(|(_, d)| d),
    };
    let obs = hit.map(|(id, edits)| Observation::from_ocr(r.oracle_for(&id), id, edits));
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
        let mut s = Session::new(None, None, 5);
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

    #[test]
    fn reset_forgets_the_tracker_and_the_lock() {
        let mut s = Session::new(None, None, 5);
        s.frame(&blank_jpeg(), &FrameOptions::default());
        s.reset();
        let v = s.frame(&blank_jpeg(), &FrameOptions::default());
        assert_eq!(v.lock.as_ref().map(|l| l.misses), Some(1));
    }
}
