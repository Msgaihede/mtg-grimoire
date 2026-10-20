//! The Neural mode's frame: `card-neural`'s two CNNs and gallery, and its agreement, answering
//! in the session's [`Verdict`] — so the page, the tray and every host take a Neural decision as
//! they take a Fast or an Exact one. The contract: `docs/superpowers/plans/2026-10-20-neural-scan-mode.md` §2.
//!
//! A child of `session` (`#[path]`), so it shares the session's private bookkeeping.
//!
//! **A frame is a read and a vote, and nothing of the other two modes.** No edge detector, hash,
//! quad lock or reader: the JPEG is decoded, [`card_neural::Recognizer::read`] finds, fingerprints
//! and ranks every card in it under the filters' looks, and [`card_neural::Agreement`] counts the
//! frame — two accepted frames of one card decide it, or three when some are only supported, or
//! one instant frame. Its ages are read off the session's clock ([`crate::host::Stopwatch`],
//! started at load), never off `Instant`.
//!
//! **What it answers, in the keys every reader of a verdict already reads:**
//!
//! - `quad` and `quad_raw`: the card the frame votes for, in the frame's pixels — one quad, as
//!   there is no lock to smooth it. `lock` is `None`, `search` is `full`, and no detail is asked
//!   for: no band is read.
//! - `match`: that card's best looks, each as its pictured printing, with **`normalized` =
//!   (1 − cosine) / 2 and `distance` that times 256**, so a panel or the scan inbox reading 0–256
//!   bits still holds; `margin` is the lead over the best other card × 128.
//! - `tracked`: the vote rule's shape — `committed` while a decision stands, `confidence` the
//!   votes held over what deciding takes, `decide_at` 2.
//! - `decision`: see [`neural_decision`]. **`decision_seq` moves once, when
//!   [`card_neural::Agreement::decisions`] does**, and every committed frame of one decision
//!   carries the view its first frame was given — the page keys on the number.
//!
//! **A stretch break is the agreement forgetting**: five frames running with no card in front of
//! the lens ([`card_neural::Read::present`]) drop the decision, so the same card shown again adds
//! again — and, as a lock that lets go does in the other modes, clear the previous decision
//! [`DecisionView::replaces_previous`] is asked against. A switch from Fast or Exact on the card
//! still in hand keeps it, so the Neural decision on that card replaces the row.

use super::{FrameOptions, FrameSize, ScanMode, Session, Verdict};

#[cfg(feature = "neural")]
use super::{ChoiceView, DecisionView, Id, Outcome, StandingView, TrackedView, DECODE_ERROR_PREFIX};
#[cfg(feature = "neural")]
use crate::{
    detect::DetectTimings,
    host::Stopwatch,
    index::{format_uuid, Mask, Section},
    reference::{Candidate, MatchReport, Reference},
    track::CommitRule,
};

/// A Neural frame's `error` when this build or this session has no Neural scanner: the crate was
/// built without the `neural` feature, or no host has called [`Session::load_neural`].
///
/// **A failure ([`Verdict::failure`]), not "no card"**: the mode cannot read any frame, and a
/// replay or a page that took it for an empty frame would score a scanner that never ran.
pub const NEURAL_UNAVAILABLE_ERROR: &str = "the Neural scanner's models are not loaded";

/// What a Neural frame's `error` starts with when the recogniser failed on it — a model that
/// would not run, or a frame too small to read. A failure, as an undecodable JPEG is.
pub const NEURAL_ERROR_PREFIX: &str = "neural: ";

/// What the Neural mode keeps on the session.
#[derive(Default)]
pub(crate) struct NeuralMode {
    #[cfg(feature = "neural")]
    loaded: Option<Loaded>,
}

/// The recogniser, its agreement across frames, the clock its frames are timed by, and what the
/// mode has reported of the agreement.
#[cfg(feature = "neural")]
struct Loaded {
    recognizer: card_neural::Recognizer,
    agreement: card_neural::Agreement,
    /// Started at load; the agreement's ages are read off it, never off `Instant`.
    clock: Stopwatch,
    /// The looks the filters admit — `Some(None)` for no filters. `None` until the first Neural
    /// frame after the filters changed, which builds it: one pass over every look's printings.
    admit: Option<Option<card_neural::Admit>>,
    /// [`card_neural::Agreement::decisions`] as the last frame saw it: a move is a new decision.
    decisions: usize,
    /// The standing decision, as its first frame reported it and every later one repeats.
    decided: Option<DecisionView>,
    /// The look the agreement's votes are counting, and its score on the last frame that voted —
    /// the tracked view's standing while nothing is decided.
    counted: Option<(u32, f32)>,
    /// Frames read since the card was last forgotten.
    frames: u32,
}

impl NeuralMode {
    /// Forget the card: the agreement's votes and decision, and the decision this mode reported.
    /// [`Session::forget_card`] calls it, so a mode switch, a filter change and a reset each start
    /// the next Neural decision from nothing — `decision_seq` is the session's and keeps counting.
    pub(super) fn forget(&mut self) {
        #[cfg(feature = "neural")]
        if let Some(l) = &mut self.loaded {
            l.agreement.reset();
            l.decided = None;
            l.counted = None;
            l.frames = 0;
        }
    }

    /// The filters changed: the looks they admit are worked out again on the next Neural frame.
    pub(super) fn filters_changed(&mut self) {
        #[cfg(feature = "neural")]
        if let Some(l) = &mut self.loaded {
            l.admit = None;
        }
    }
}

impl Session {
    /// Give the Neural mode its files — `card_neural::bundled()` on a native host, what the page
    /// fetched in the browser. A refusal is a sentence and leaves the mode unavailable.
    ///
    /// A second call replaces the first, agreement and all: the decision count is the session's.
    /// **The first is dropped before the second is built**, so a browser's module — whose memory
    /// is never given back — does not hold two recognisers at once (measured: 37.8 MiB for one,
    /// 66.1 MiB while the old one lived on). A refused second call leaves the mode unavailable.
    #[cfg(feature = "neural")]
    pub fn load_neural(&mut self, files: card_neural::Files<'static>) -> Result<(), String> {
        self.neural.loaded = None;
        let recognizer = card_neural::Recognizer::load(files).map_err(|e| e.to_string())?;
        self.neural.loaded = Some(Loaded {
            recognizer,
            agreement: card_neural::Agreement::default(),
            clock: Stopwatch::start(),
            admit: None,
            decisions: 0,
            decided: None,
            counted: None,
            frames: 0,
        });
        Ok(())
    }

    /// Whether a Neural frame can be read: the feature is on and the files loaded.
    pub fn has_neural(&self) -> bool {
        #[cfg(feature = "neural")]
        {
            self.neural.loaded.is_some()
        }
        #[cfg(not(feature = "neural"))]
        {
            false
        }
    }

    /// One Neural frame, after `frame_inner` has switched the mode — see the module doc.
    ///
    /// `_opts` asks nothing of it: the sliders are the edge detector's and the tracker's, the
    /// thresholds travel with the models (`neural.json`) and the agreement's rules are
    /// `card-neural`'s own.
    pub(super) fn neural_frame(&mut self, jpeg: &[u8], _opts: &FrameOptions) -> Verdict {
        #[cfg(feature = "neural")]
        if self.neural.loaded.is_some() {
            return self.neural_read(jpeg);
        }
        #[cfg(not(feature = "neural"))]
        let _ = jpeg;
        self.neural_unavailable()
    }

    /// [`NEURAL_UNAVAILABLE_ERROR`]'s verdict. `matcher` is the mode's own: whether its
    /// recogniser is there to match against.
    fn neural_unavailable(&self) -> Verdict {
        Verdict::failed(
            NEURAL_UNAVAILABLE_ERROR.to_string(),
            FrameSize { w: 0, h: 0 },
            0.0,
            false,
            ScanMode::Neural,
            self.decision_seq,
        )
    }

    /// Decode, read, and hand the read to [`Session::neural_verdict`]. A frame that fails here
    /// is not counted: the agreement never hears of it, as Fast's tracker never hears of a JPEG
    /// that would not decode.
    #[cfg(feature = "neural")]
    fn neural_read(&mut self, jpeg: &[u8]) -> Verdict {
        let decode_started = Stopwatch::start();
        let source = match image::load_from_memory(jpeg) {
            Ok(i) => i,
            Err(e) => {
                return self.neural_failed(
                    format!("{DECODE_ERROR_PREFIX}{e}"),
                    FrameSize { w: 0, h: 0 },
                    0.0,
                )
            }
        };
        let frame = FrameSize { w: source.width(), h: source.height() };
        // **Moved, not copied**: a JPEG decodes to RGB, and `into_rgb8` hands that buffer over.
        let pixels = card_neural::Frame::new(
            frame.w as usize,
            frame.h as usize,
            source.into_rgb8().into_raw(),
        );
        let decode_ms = decode_started.ms();
        let pixels = match pixels {
            Ok(p) => p,
            Err(e) => {
                return self.neural_failed(format!("{NEURAL_ERROR_PREFIX}{e}"), frame, decode_ms)
            }
        };
        let mask = &self.mask;
        let Some(Loaded { recognizer, admit, clock, .. }) = self.neural.loaded.as_mut() else {
            return self.neural_unavailable();
        };
        // A look is admitted when any printing it stands for is: the filters name printings, the
        // gallery searches looks.
        let admit = admit.get_or_insert_with(|| {
            (!mask.is_unrestricted()).then(|| recognizer.gallery().admit(|id| mask.permits(id)))
        });
        let read_started = Stopwatch::start();
        let read = recognizer.read(&pixels, admit.as_ref());
        let read_ms = read_started.ms();
        let now_ms = f64::from(clock.ms());
        match read {
            Ok(read) => self.neural_verdict(&read, now_ms, frame, decode_ms, read_ms),
            Err(e) => self.neural_failed(format!("{NEURAL_ERROR_PREFIX}{e}"), frame, decode_ms),
        }
    }

    #[cfg(feature = "neural")]
    fn neural_failed(&self, error: String, frame: FrameSize, decode_ms: f32) -> Verdict {
        Verdict::failed(error, frame, decode_ms, true, ScanMode::Neural, self.decision_seq)
    }

    /// One read, counted by the agreement at `now_ms` and answered as a verdict — the decision
    /// bookkeeping of the mode, apart from the models so it can be driven with reads made by hand.
    #[cfg(feature = "neural")]
    fn neural_verdict(
        &mut self,
        read: &card_neural::Read,
        now_ms: f64,
        frame: FrameSize,
        decode_ms: f32,
        read_ms: f32,
    ) -> Verdict {
        let reference = self.reference.clone();
        let r = reference.as_deref();
        let (mask, top) = (&self.mask, self.top);
        let Some(l) = self.neural.loaded.as_mut() else {
            return self.neural_unavailable();
        };
        l.frames = l.frames.saturating_add(1);
        l.agreement.observe(read, now_ms);
        let (votes, strong) = l.agreement.votes();
        if votes == 0 {
            l.counted = None;
        } else if read.accepted || read.supported {
            l.counted = read.best().map(|b| (b.scored.entry, b.scored.score));
        }
        let rules = &l.agreement.rules;
        let decide_at = rules.required as f32;
        // How far the votes held are toward a decision: two accepted frames, or three in all.
        let progress = (strong as f32 / rules.required.max(1) as f32)
            .max(votes as f32 / rules.support_required.max(1) as f32)
            .min(1.0);
        let gone = l.agreement.absent() >= rules.forget_after;
        let decisions = l.agreement.decisions();
        let new = decisions != l.decisions;
        l.decisions = decisions;
        let standing = l.agreement.decision().map(|d| (d.entry, d.score));
        let gallery = l.recognizer.gallery();
        let fresh = match standing {
            None => {
                l.decided = None;
                None
            }
            Some((entry, score)) if new => Some(neural_decision(gallery, r, mask, entry, score)),
            Some(_) => None,
        };

        // The decided look first, then the look the votes are counting when it is another card.
        let label = |entry: u32| r.and_then(|r| r.label_for(gallery.printing(entry)));
        let mut standings: Vec<StandingView> = Vec::new();
        if let Some((entry, score)) = standing {
            standings.push(StandingView {
                id: format_uuid(gallery.printing(entry)),
                evidence: decide_at,
                share: 1.0,
                seen: votes as u32,
                label: label(entry),
                best_distance: normalized(score),
            });
        }
        let other =
            |entry: u32| standing.is_none_or(|(d, _)| gallery.card(d) != gallery.card(entry));
        if let Some((entry, score)) = l.counted.filter(|(entry, _)| other(*entry)) {
            if let Some(decided) = standings.first_mut() {
                decided.seen = 0;
            }
            standings.push(StandingView {
                id: format_uuid(gallery.printing(entry)),
                evidence: progress * decide_at,
                share: 1.0,
                seen: votes as u32,
                label: label(entry),
                best_distance: normalized(score),
            });
        }
        let total: f32 = standings.iter().map(|s| s.evidence).sum();
        for s in &mut standings {
            s.share = if total > 0.0 { s.evidence / total } else { 0.0 };
        }
        let committed = standing.is_some();
        let tracked = TrackedView {
            committed,
            confidence: if committed { 1.0 } else { progress },
            rule: CommitRule::Votes,
            decide_at,
            lead: None,
            frozen: false,
            early: false,
            streak: votes as u32,
            frames: l.frames,
            misses: l.agreement.absent(),
            standings,
        };

        // The card the frame votes for, when one is in front of the lens.
        let best = read.best().filter(|_| read.present);
        let report = best.map(|b| MatchReport {
            section: Section::Card,
            rotated: b.flipped,
            view: 0,
            views: 1,
            hashes: read.crops,
            candidates: b
                .top
                .iter()
                .take(top)
                .map(|&(e, cos)| candidate(gallery, r, e, cos))
                .collect(),
            margin: Some(cosine_bits(b.scored.margin, 128.0)),
            // The read is the detector, the embedder and the search at once; it is timed whole.
            hash_ms: read_ms,
            search_ms: 0.0,
            descriptors: Default::default(),
        });
        let quad = best.map(|b| b.quad.map(|p| (p.x, p.y)));

        if gone {
            // A stretch break, as a lock that lets go is one in the other modes: the card has been
            // away long enough for the agreement to forget it, so whatever is decided next is
            // another copy, never a second opinion on this one.
            self.previous_card = None;
            self.previous_printing = None;
            self.laid_over = None;
        }
        if let Some(mut d) = fresh {
            self.decision_seq += 1;
            d.replaces_previous = self.replaces_previous(&d);
            if let Some(l) = self.neural.loaded.as_mut() {
                l.decided = Some(d);
            }
        }
        let decision = self.neural.loaded.as_ref().and_then(|l| l.decided.clone());

        let seq = self.decision_seq;
        let mut v = Verdict::failed(String::new(), frame, decode_ms, true, ScanMode::Neural, seq);
        v.ok = report.is_some();
        v.error = (!v.ok).then(|| "no card".to_string());
        v.method = v.ok.then(|| "neural".to_string());
        v.quad = quad;
        v.quad_raw = quad;
        v.timings = Some(DetectTimings { total_ms: read_ms, ..Default::default() });
        // The cards the detector found and the embedder read — the quads this mode weighed.
        v.candidates_examined = Some(read.cards.len());
        v.r#match = report;
        v.tracked = Some(tracked);
        v.decision = decision;
        v
    }
}

/// A cosine as the page's distances read it: **(1 − cos) / 2**, 0 for the picture itself and 1
/// for its opposite — so a panel or the scan inbox that reads `distance` as 0–256 bits still holds.
#[cfg(feature = "neural")]
fn normalized(cos: f32) -> f32 {
    if cos.is_nan() {
        return 1.0;
    }
    ((1.0 - cos) / 2.0).clamp(0.0, 1.0)
}

/// A cosine difference as bits of a `scale`-bit distance, never negative.
#[cfg(feature = "neural")]
fn cosine_bits(cos: f32, scale: f32) -> u32 {
    if cos.is_nan() {
        return 0;
    }
    (cos.max(0.0) * scale).round() as u32
}

/// One of a card's best looks, as a match candidate: its pictured printing, the distance its
/// cosine makes, and how many printings it stands for.
#[cfg(feature = "neural")]
fn candidate(
    gallery: &card_neural::Gallery,
    r: Option<&Reference>,
    entry: u32,
    cos: f32,
) -> Candidate {
    let printing = gallery.printing(entry);
    let normalized = normalized(cos);
    Candidate {
        id: format_uuid(printing),
        distance: (normalized * 256.0).round() as u32,
        normalized,
        label: r.and_then(|r| r.label_for(printing)),
        printings: Some(gallery.covers(entry).len()),
    }
}

/// The decision a look makes, under the filters.
///
/// **The printing is the look's pictured one when the filters admit it, else its first admitted
/// cover.** A look stands for every printing that photographs alike, so when the filters leave
/// more than one of them the picture cannot say which: the decision is `ambiguous`, with those
/// printings as its choices, the decided one first — as an Exact resolve offers a choice the
/// collector line could not settle. One admitted printing is `resolved`, with no choices. Every
/// choice is the same picture, so each carries the look's own distance.
///
/// Labels, oracle ids and finishes are the reference's when there is one; no collector line is
/// read, so `finish_mark` is `None`.
#[cfg(feature = "neural")]
fn neural_decision(
    gallery: &card_neural::Gallery,
    r: Option<&Reference>,
    mask: &Mask,
    entry: u32,
    score: f32,
) -> DecisionView {
    let pictured: Id = *gallery.printing(entry);
    let mut admitted: Vec<Id> =
        gallery.covers(entry).filter(|p| mask.permits(p)).copied().collect();
    let printing = if mask.permits(&pictured) {
        pictured
    } else {
        admitted.first().copied().unwrap_or(pictured)
    };
    if let Some(at) = admitted.iter().position(|p| *p == printing) {
        admitted[..=at].rotate_right(1);
    }
    let oracle_id = |p: &Id| r.and_then(|r| r.oracle_id_of(p)).map(|o| format_uuid(&o));
    let finishes = |p: &Id| r.map(|r| r.finishes_of(p).to_vec()).unwrap_or_default();
    let distance = Some(normalized(score));
    let ambiguous = admitted.len() > 1;
    DecisionView {
        printing: format_uuid(&printing),
        oracle_id: oracle_id(&printing),
        label: r.and_then(|r| r.label_for(&printing)),
        outcome: if ambiguous { Outcome::Ambiguous } else { Outcome::Resolved },
        choices: if ambiguous {
            admitted
                .iter()
                .map(|p| ChoiceView {
                    id: format_uuid(p),
                    oracle_id: oracle_id(p),
                    label: r.and_then(|r| r.label_for(p)),
                    distance,
                    finishes: finishes(p),
                })
                .collect()
        } else {
            Vec::new()
        },
        replaces_previous: false,
        finishes: finishes(&printing),
        finish_mark: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn neural() -> FrameOptions {
        FrameOptions { mode: ScanMode::Neural, ..Default::default() }
    }

    /// A grey 320×240 JPEG: nothing in it a detector could take for a card.
    fn grey_jpeg() -> Vec<u8> {
        let img = image::RgbImage::from_pixel(320, 240, image::Rgb([128, 128, 128]));
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80)
            .encode_image(&img)
            .expect("encode");
        out
    }

    #[test]
    fn without_its_models_every_neural_frame_says_so_as_a_failure() {
        let mut s = Session::new(None, None, 5);
        assert!(!s.has_neural());
        let v = s.frame(&grey_jpeg(), &neural());
        assert!(!v.ok && !v.matcher, "no recogniser is no matcher");
        assert_eq!(v.mode, ScanMode::Neural);
        assert_eq!(v.failure(), Some(NEURAL_UNAVAILABLE_ERROR));
        assert_eq!((v.decision_seq, v.decision.is_none(), v.tracked.is_none()), (0, true, true));
        // The word parses in every build: a reader's stored prefs and the inbox's labels keep it.
        let word: ScanMode = serde_json::from_str(r#""neural""#).expect("json");
        assert_eq!(word, ScanMode::Neural);
        assert_eq!(serde_json::to_value(ScanMode::Neural).expect("json"), "neural");
        let opts: FrameOptions = serde_json::from_str(r#"{"mode":"neural"}"#).expect("json");
        assert_eq!(opts.mode, ScanMode::Neural);
    }

    /// The models in git, with a session reading them: every test below runs the real
    /// recogniser's gallery, and the frame tests its networks.
    #[cfg(feature = "neural")]
    mod loaded {
        use super::super::super::tests as fast;
        use super::*;
        use crate::reference::Label;
        use card_neural::detect::Detection;
        use card_neural::frame::{Point, Quad};
        use card_neural::scanner::Scored;
        use card_neural::{Found, Gallery, Read};
        use std::borrow::Cow;

        fn shipped() -> card_neural::Files<'static> {
            Files {
                detector: Cow::Borrowed(include_bytes!("../../card-neural/models/detector.onnx")),
                embedder: Cow::Borrowed(include_bytes!("../../card-neural/models/embedder.onnx")),
                gallery: Cow::Borrowed(include_bytes!("../../card-neural/models/gallery.bin")),
                meta: Cow::Borrowed(include_bytes!("../../card-neural/models/neural.json")),
            }
        }
        use card_neural::Files;

        /// A session in Neural over `r`, its models loaded.
        fn session(r: Option<Reference>) -> Session {
            let mut s = Session::new(r, None, 5);
            s.load_neural(shipped()).expect("the models in git load");
            s.set_mode(ScanMode::Neural);
            s
        }

        fn gallery(s: &Session) -> &Gallery {
            s.neural.loaded.as_ref().expect("loaded").recognizer.gallery()
        }

        /// Looks of `n` different cards, each standing for one printing alone.
        fn single_looks(s: &Session, n: usize) -> Vec<u32> {
            let g = gallery(s);
            let mut cards = Vec::new();
            let mut looks = Vec::new();
            for e in 0..g.len() as u32 {
                if g.covers(e).len() == 1 && !cards.contains(&g.card(e)) {
                    cards.push(g.card(e));
                    looks.push(e);
                    if looks.len() == n {
                        break;
                    }
                }
            }
            looks
        }

        fn quad() -> Quad {
            let p = |x, y| Point { x, y };
            [p(200.0, 100.0), p(440.0, 100.0), p(440.0, 436.0), p(200.0, 436.0)]
        }

        /// A frame voting for look `entry`, at a cosine of 0.7 and 0.2 clear of another card:
        /// accepted, or only supported.
        fn naming(s: &Session, entry: u32, accepted: bool) -> Read {
            let g = gallery(s);
            let runner =
                (0..g.len() as u32).find(|&e| g.card(e) != g.card(entry)).expect("a rival");
            Read {
                cards: vec![Found {
                    detection: Detection { score: 0.9, quad: quad(), flip: 0.0 },
                    quad: quad(),
                    flipped: false,
                    scored: Scored {
                        entry,
                        card: g.card(entry),
                        score: 0.7,
                        margin: 0.2,
                        twins: vec![entry],
                    },
                    top: vec![(entry, 0.7), (runner, 0.5)],
                    accepted,
                    prominence: 1.0,
                    aimed: true,
                }],
                accepted,
                supported: !accepted,
                instant: false,
                weak: false,
                present: true,
                detector_runs: 1,
                crops: 1,
            }
        }

        /// A frame with no card in front of the lens.
        fn empty() -> Read {
            Read::default()
        }

        fn feed(s: &mut Session, read: &Read, at_ms: f64) -> Verdict {
            s.neural_verdict(read, at_ms, FrameSize { w: 640, h: 480 }, 0.0, 0.0)
        }

        /// One accepted frame of `entry`.
        fn vote(s: &mut Session, entry: u32, at_ms: f64) -> Verdict {
            let read = naming(s, entry, true);
            feed(s, &read, at_ms)
        }

        /// Two accepted frames of `entry`, 100 ms apart from `at_ms`: a decision.
        fn decide(s: &mut Session, entry: u32, at_ms: f64) -> Verdict {
            vote(s, entry, at_ms);
            vote(s, entry, at_ms + 100.0)
        }

        fn pictured(s: &Session, entry: u32) -> String {
            format_uuid(gallery(s).printing(entry))
        }

        #[test]
        fn an_empty_frame_through_the_models_is_no_card_and_no_decision() {
            fn is_send<T: Send>(_: &T) {}
            let mut s = session(None);
            is_send(&s);
            assert!(s.has_neural());
            let v = s.frame(&grey_jpeg(), &neural());
            assert!(!v.ok && v.matcher);
            assert_eq!(v.error.as_deref(), Some("no card"));
            assert_eq!(v.failure(), None, "an empty frame is not a failure");
            assert!(v.r#match.is_none() && v.quad.is_none() && v.method.is_none());
            assert!(v.decision.is_none() && v.lock.is_none() && !v.wants_detail);
            assert_eq!((v.decision_seq, v.frame), (0, FrameSize { w: 320, h: 240 }));
            let t = v.tracked.expect("a tracked view on every read frame");
            assert!(!t.committed && t.standings.is_empty());
            assert_eq!((t.frames, t.misses, t.decide_at), (1, 1, 2.0));

            // Bytes that are not a picture are the failure every mode reports, and not counted.
            let bad = s.frame(b"not a jpeg", &neural());
            assert!(bad.failure().is_some_and(|e| e.starts_with(DECODE_ERROR_PREFIX)), "{bad:?}");
            let v = s.frame(&grey_jpeg(), &neural());
            assert_eq!(v.tracked.expect("tracked").frames, 2);
        }

        #[test]
        fn decision_seq_moves_once_a_decision_and_every_frame_of_it_says_the_same() {
            let mut s = session(None);
            let a = single_looks(&s, 1)[0];
            let read = naming(&s, a, true);
            let first = feed(&mut s, &read, 0.0);
            assert!(first.ok && first.decision.is_none());
            assert_eq!(first.decision_seq, 0);
            let t = first.tracked.expect("tracked");
            assert!(!t.committed);
            assert_eq!(t.confidence, 0.5, "one accepted frame of the two deciding takes");
            assert_eq!(t.standings[0].id, pictured(&s, a));

            let decided = feed(&mut s, &read, 100.0);
            assert_eq!(decided.decision_seq, 1);
            let d = decided.decision.expect("decided");
            assert_eq!(d.printing, pictured(&s, a));
            assert_eq!((d.outcome, d.choices.len()), (Outcome::Resolved, 0));
            assert!(!d.replaces_previous && d.oracle_id.is_none() && d.label.is_none());
            let t = decided.tracked.expect("tracked");
            assert!(t.committed && t.confidence == 1.0 && t.rule == CommitRule::Votes);

            // The frames after it: the same number, the same decision.
            for at in [200.0, 300.0] {
                let v = feed(&mut s, &read, at);
                assert_eq!(v.decision_seq, 1);
                assert_eq!(v.decision.expect("held").printing, d.printing);
            }
            // Four frames with no card hold it — a card fumbled, not taken away ...
            for i in 0..4 {
                let v = feed(&mut s, &empty(), 400.0 + 100.0 * i as f64);
                assert!(!v.ok && v.r#match.is_none());
                assert_eq!(v.decision.map(|d| d.printing), Some(d.printing.clone()), "frame {i}");
            }
            // ... the fifth forgets it ...
            let gone = feed(&mut s, &empty(), 800.0);
            assert!(gone.decision.is_none() && !gone.tracked.expect("tracked").committed);
            assert_eq!(gone.decision_seq, 1);
            // ... and the same card shown again is another copy.
            let again = decide(&mut s, a, 900.0);
            assert_eq!(again.decision_seq, 2);
            assert!(!again.decision.expect("decided").replaces_previous);
        }

        #[test]
        fn another_card_is_a_new_decision_that_replaces_nothing() {
            let mut s = session(None);
            let looks = single_looks(&s, 2);
            let (a, b) = (looks[0], looks[1]);
            decide(&mut s, a, 0.0);
            // One frame of another card: the decision stands, and the count toward the next is
            // shown behind it.
            let voting = vote(&mut s, b, 200.0);
            assert_eq!(voting.decision.expect("still decided").printing, pictured(&s, a));
            let ids: Vec<String> =
                voting.tracked.expect("tracked").standings.into_iter().map(|s| s.id).collect();
            assert_eq!(ids, [pictured(&s, a), pictured(&s, b)]);
            let v = vote(&mut s, b, 300.0);
            assert_eq!(v.decision_seq, 2);
            let d = v.decision.expect("decided");
            assert_eq!(d.printing, pictured(&s, b));
            assert!(!d.replaces_previous, "another card is never a second opinion");
        }

        #[test]
        fn three_frames_decide_when_some_are_only_supported() {
            let mut s = session(None);
            let a = single_looks(&s, 1)[0];
            let supported = naming(&s, a, false);
            assert!(feed(&mut s, &supported, 0.0).decision.is_none());
            let v = feed(&mut s, &supported, 100.0);
            assert!(v.decision.is_none());
            assert!((v.tracked.expect("tracked").confidence - 2.0 / 3.0).abs() < 1e-6);
            assert_eq!(feed(&mut s, &supported, 200.0).decision_seq, 1);
        }

        /// "Fast said Forest, switch to Neural": one card in hand, one tray row.
        #[test]
        fn a_switch_from_fast_on_the_card_it_decided_replaces_that_decision() {
            let (r, card, _) = fast::two_far_cards();
            let mut s = fast::inline(r);
            s.load_neural(shipped()).expect("the models in git load");
            let a = single_looks(&s, 1)[0];
            // The look the Neural frames name, labelled as the card Fast decides: card 20.
            let printing = *gallery(&s).printing(a);
            let label = Label {
                name: "Card 20".into(),
                set: "hob".into(),
                number: "9".into(),
                lang: "en".into(),
                released: "2025-01-01".into(),
            };
            std::sync::Arc::get_mut(s.reference.as_mut().expect("a reference"))
                .expect("no resolve holds it")
                .add_label(printing, Some(fast::id(20)), None, label);
            let oracle = Some(format_uuid(&fast::id(20)));
            let by_fast = fast::until_decided(&mut s, &card).decision.expect("Fast decided");
            assert_eq!(by_fast.oracle_id, oracle);

            s.set_mode(ScanMode::Neural);
            let v = decide(&mut s, a, 0.0);
            assert_eq!(v.decision_seq, 2);
            let d = v.decision.expect("decided");
            assert_eq!(d.oracle_id, oracle);
            assert_eq!(d.label.map(|l| l.name).as_deref(), Some("Card 20"));
            assert!(d.replaces_previous, "a second opinion on the card in hand added it twice");
            let later = vote(&mut s, a, 200.0);
            assert!(later.decision.expect("held").replaces_previous, "a later frame changed it");

            // A stretch break: the card away for five frames, and the same card is a new copy.
            for i in 0..5 {
                feed(&mut s, &empty(), 300.0 + 100.0 * i as f64);
            }
            let again = decide(&mut s, a, 900.0);
            assert_eq!(again.decision_seq, 3);
            assert!(!again.decision.expect("decided").replaces_previous);
        }

        #[test]
        fn a_reset_and_a_mode_switch_each_forget_the_neural_decision() {
            let mut s = session(None);
            let a = single_looks(&s, 1)[0];
            assert_eq!(decide(&mut s, a, 0.0).decision_seq, 1);
            s.reset();
            let one = vote(&mut s, a, 200.0);
            assert!(one.decision.is_none(), "the agreement kept its votes through a reset");
            let v = vote(&mut s, a, 300.0);
            assert_eq!(v.decision_seq, 2);
            assert!(!v.decision.expect("decided").replaces_previous, "a reset asks for news");

            // Away and back: the agreement starts over, the previous decision is kept.
            s.set_mode(ScanMode::Fast);
            s.set_mode(ScanMode::Neural);
            assert!(vote(&mut s, a, 400.0).decision.is_none());
            let v = vote(&mut s, a, 500.0);
            assert_eq!(v.decision_seq, 3);
            assert!(v.decision.expect("decided").replaces_previous);
        }

        #[test]
        fn the_match_puts_cosines_on_the_pages_256_bits() {
            assert_eq!(normalized(1.0), 0.0);
            assert_eq!(normalized(0.0), 0.5);
            assert_eq!(normalized(-1.0), 1.0);
            assert_eq!(normalized(1.3), 0.0, "past the unit sphere is the picture itself");
            assert_eq!(normalized(f32::NAN), 1.0);
            assert_eq!((cosine_bits(0.2, 128.0), cosine_bits(-0.1, 128.0)), (26, 0));

            let mut s = session(None);
            let a = single_looks(&s, 1)[0];
            let v = vote(&mut s, a, 0.0);
            assert_eq!(v.method.as_deref(), Some("neural"));
            assert_eq!(v.quad, Some(quad().map(|p| (p.x, p.y))));
            assert_eq!(v.quad, v.quad_raw);
            assert!(v.lock.is_none() && !v.wants_detail);
            assert_eq!(v.search, crate::session::Search::Full);
            let m = v.r#match.expect("a match");
            assert_eq!((m.section, m.view, m.views, m.hashes), (Section::Card, 0, 1, 1));
            assert_eq!(m.margin, Some(26), "0.2 of cosine is 26 of 128 bits");
            let c = &m.candidates;
            assert_eq!(c[0].id, pictured(&s, a));
            // 0.7 is (1 − 0.7) / 2 = 0.15 of the way, 38 bits; 0.5 is 0.25, 64.
            assert_eq!((c[0].distance, c[1].distance), (38, 64));
            assert!((c[0].normalized - 0.15).abs() < 1e-6);
            assert_eq!(c[0].printings, Some(1));
        }

        #[test]
        fn the_filters_choose_among_a_looks_printings() {
            let s = session(None);
            let g = gallery(&s);
            let e = (0..g.len() as u32).find(|&e| g.covers(e).len() >= 3).expect("a look of three");
            let covers: Vec<Id> = g.covers(e).copied().collect();
            let ids = |ps: &[Id]| ps.iter().map(format_uuid).collect::<Vec<_>>();
            let choices =
                |d: &DecisionView| d.choices.iter().map(|c| c.id.clone()).collect::<Vec<_>>();

            // Unfiltered, the picture cannot say which printing: every one is offered, the
            // pictured one decided.
            let all = neural_decision(g, None, &Mask::all(), e, 0.7);
            assert_eq!(all.outcome, Outcome::Ambiguous);
            assert_eq!(all.printing, ids(&covers)[0]);
            assert_eq!(choices(&all), ids(&covers));
            assert!(all.choices.iter().all(|c| c.distance == Some(normalized(0.7))));

            // The pictured printing filtered out: the first admitted one is decided.
            let rest = Mask::allow_only([covers[1], covers[2]]);
            let without = neural_decision(g, None, &rest, e, 0.7);
            assert_eq!(without.printing, ids(&covers)[1]);
            assert_eq!(without.outcome, Outcome::Ambiguous);
            assert_eq!(choices(&without), ids(&covers[1..3]));

            // One left: resolved, nothing to choose.
            let one = neural_decision(g, None, &Mask::allow_only([covers[2]]), e, 0.7);
            assert_eq!(one.outcome, Outcome::Resolved);
            assert_eq!(one.printing, ids(&covers)[2]);
            assert!(one.choices.is_empty());
        }

        #[test]
        fn the_looks_the_filters_admit_are_worked_out_once_a_change() {
            let admit = |s: &Session| s.neural.loaded.as_ref().expect("loaded").admit.clone();
            let mut s = session(None);
            s.frame(&grey_jpeg(), &neural());
            assert_eq!(admit(&s), Some(None), "no filters, every look");
            let g = gallery(&s);
            let e = (0..g.len() as u32).find(|&e| g.covers(e).len() >= 2).expect("a look of two");
            let second = g.covers(e).nth(1).copied().expect("two covers");
            // What `set_filters` does with a mask its labels built.
            s.mask = Mask::allow_only([second]);
            s.neural.filters_changed();
            s.forget_card();
            assert_eq!(admit(&s), None);
            s.frame(&grey_jpeg(), &neural());
            let built = admit(&s).flatten().expect("an admit for the filters");
            assert!(built.admits(e), "a look is admitted by any printing it stands for");
            assert!(built.count() >= 1 && built.count() < gallery(&s).len());
        }
    }
}
