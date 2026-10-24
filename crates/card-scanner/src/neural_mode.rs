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
//!   for: no text is read, so no collector line and no finish mark. The collector band is looked
//!   at all the same, as a picture, by the printing evidence below.
//! - `match`: that card's best looks, each as its pictured printing, with **`normalized` =
//!   (1 − cosine) / 2 and `distance` that times 256**, so a panel or the scan inbox reading 0–256
//!   bits still holds; `margin` is the lead over the best other card × 128.
//! - `tracked`: the vote rule's shape — `committed` while a decision stands, `confidence` the
//!   votes held over what deciding takes, `decide_at` 2.
//! - `decision`: see [`neural_decision`], or [`evidence_decision`] once the set symbol and
//!   collector band evidence is loaded — it chooses the printing, never the card, nor when the
//!   decision is made. **`decision_seq` moves once, when
//!   [`card_neural::Agreement::decisions`] does**, and every committed frame of one decision
//!   carries the view its first frame was given — the page keys on the number.
//!
//! **A stretch break is the agreement forgetting**: five frames running with no card in front of
//! the lens ([`card_neural::Read::present`]) drop the decision, so the same card shown again adds
//! again — and, as a lock that lets go does in the other modes, clear the previous decision
//! [`DecisionView::replaces_previous`] is asked against. A switch from Fast or Exact on the card
//! still in hand keeps it, so the Neural decision on that card replaces the row.
//!
//! **Another look of the decided card come to rest is a card laid on it** (#1359): the
//! agreement decides it ([`card_neural::Decision::another_look`]), and, as a change the watch
//! sees in the other modes, it is a second copy and adds — unless its printing is the one the
//! last decision named, which is that card's own look wavering, a second opinion.
//!
//! **Another copy of the decided card laid on it is a second copy too** (#1375): the agreement
//! decides it again when the card was hidden for a couple of frames and comes to rest somewhere
//! else ([`card_neural::Decision::relaid`]). Its decision is the standing one again — the same
//! look, so the same printing, and no frame of it is kept for the evidence to choose on — with
//! `replaces_previous` false, so the tray bumps the row it filed.

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
#[cfg(feature = "neural")]
use card_neural::{
    gallery::Face,
    meta::EvidenceThresholds,
    narrow::{narrow, Candidate as NarrowCandidate},
    EvidenceIndex, Glance,
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
    /// The set symbol and collector band networks, once [`Session::load_neural_evidence`] has
    /// given them; `None` in a test, which hands its frames' glances in made by hand.
    nets: Option<card_neural::EvidenceNets>,
    /// Their galleries and thresholds. **Evidence is loaded when this is `Some`**; until then a
    /// decision is made as it always was, the look's admitted covers its choices.
    index: Option<(EvidenceIndex, EvidenceThresholds)>,
    /// The voting frames of the card being counted, kept while evidence is loaded: what the
    /// printing is chosen on when the card is decided. Never more than the agreement's votes.
    frames_seen: Vec<Seen>,
    /// The last decision the evidence chose the printing of.
    report: Option<EvidenceReport>,
}

/// One voting frame of the card being counted, as the printing evidence weighs it.
#[cfg(feature = "neural")]
#[derive(Clone, Debug)]
struct Seen {
    /// The card group the frame voted for.
    card: u32,
    /// The face its best look shows: only that face's glances can speak for a band row of it.
    face: Face,
    /// The whole-card fingerprint, for the scores of the card's other looks.
    embedding: Vec<f32>,
    /// Its set symbol and collector band, embedded — `None` when the crops would not read.
    glance: Option<Glance>,
}

/// What the evidence weighed for the last Neural decision — for the replay, not the page.
#[cfg(feature = "neural")]
#[derive(Clone, Debug, serde::Serialize)]
pub struct EvidenceReport {
    /// Every candidate printing, in the order the rule breaks ties by.
    pub candidates: Vec<CandidateReport>,
    /// The printing the evidence was sure of; `None` left the decision ambiguous.
    pub decided: Option<String>,
}

/// One candidate printing and its scores.
#[cfg(feature = "neural")]
#[derive(Clone, Debug, serde::Serialize)]
pub struct CandidateReport {
    pub printing: String,
    /// The look of the card it came in by.
    pub look: u32,
    /// That look's whole-card score, the mean cosine over the frames kept.
    pub whole: f32,
    /// `None` when the evidence galleries hold no row for the printing, or no crop was read.
    pub symbol: Option<f32>,
    pub band: Option<f32>,
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
            l.frames_seen.clear();
            l.report = None;
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
            nets: None,
            index: None,
            frames_seen: Vec::new(),
            report: None,
        });
        Ok(())
    }

    /// Give the Neural mode its printing evidence — the set symbol and collector band networks
    /// and their galleries — after [`Session::load_neural`], whose `neural.json` must carry an
    /// `evidence` section to say how they are read and weighed.
    ///
    /// Refused (a sentence) before the recogniser, or without that section. **A refusal leaves
    /// today's behaviour**: whatever evidence an earlier call loaded is dropped first, as
    /// `load_neural` drops the old recogniser before building the new one.
    #[cfg(feature = "neural")]
    pub fn load_neural_evidence(
        &mut self,
        files: card_neural::EvidenceFiles<'static>,
    ) -> Result<(), String> {
        let Some(l) = self.neural.loaded.as_mut() else {
            return Err("the Neural scanner's evidence needs its models loaded first".to_string());
        };
        l.nets = None;
        l.index = None;
        l.frames_seen.clear();
        l.report = None;
        let card_neural::Evidence { nets, index, thresholds } =
            card_neural::Evidence::load(files, l.recognizer.meta()).map_err(|e| e.to_string())?;
        l.nets = Some(nets);
        l.index = Some((index, thresholds));
        Ok(())
    }

    /// The last Neural decision's candidate printings and their scores, when evidence chose
    /// its printing — for the replay, not the page. `None` since a reset, or when the decision
    /// was made without evidence.
    #[cfg(feature = "neural")]
    pub fn neural_evidence_report(&self) -> Option<EvidenceReport> {
        self.neural.loaded.as_ref().and_then(|l| l.report.clone())
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

    /// Whether a Neural decision narrows the printing: the files loaded and
    /// [`Session::load_neural_evidence`] took the evidence. A host loads it after the files
    /// and logs a refusal, so this is how its tests see that it did.
    #[cfg(feature = "neural")]
    pub fn has_neural_evidence(&self) -> bool {
        self.neural.loaded.as_ref().is_some_and(|l| l.index.is_some())
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
        let source = match super::decode_frame(jpeg) {
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
        let Some(Loaded { recognizer, admit, clock, agreement, nets, index, .. }) =
            self.neural.loaded.as_mut()
        else {
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
        // After the read is timed and the frame's age taken, so the crops change neither.
        let seen = match &read {
            Ok(read) if index.is_some() => {
                keep(read, recognizer.gallery(), agreement, nets.as_mut(), &pixels)
            }
            _ => None,
        };
        match read {
            Ok(read) => self.neural_verdict(&read, seen, now_ms, frame, decode_ms, read_ms),
            Err(e) => self.neural_failed(format!("{NEURAL_ERROR_PREFIX}{e}"), frame, decode_ms),
        }
    }

    #[cfg(feature = "neural")]
    fn neural_failed(&self, error: String, frame: FrameSize, decode_ms: f32) -> Verdict {
        Verdict::failed(error, frame, decode_ms, true, ScanMode::Neural, self.decision_seq)
    }

    /// One read, counted by the agreement at `now_ms` and answered as a verdict — the decision
    /// bookkeeping of the mode, apart from the models so it can be driven with reads made by hand.
    ///
    /// `seen` is what the read keeps for the printing evidence ([`keep`]), `None` without it.
    #[cfg(feature = "neural")]
    fn neural_verdict(
        &mut self,
        read: &card_neural::Read,
        seen: Option<Seen>,
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
        // **The frames kept are the count's.** A vote for another card ends them — kept or not:
        // a frame of the decided card keeps nothing ([`keep`]) yet restarts the count. Then
        // they are trimmed to the votes held, so a frame the agreement dropped (aged out, past
        // its window, or before a gap that restarted it) never chooses the printing.
        let voted = (read.accepted || read.supported).then(|| read.best()).flatten();
        if let Some(card) = voted.map(|b| b.scored.card) {
            if l.frames_seen.first().is_some_and(|f| f.card != card) {
                l.frames_seen.clear();
            }
        }
        if let Some(seen) = seen {
            if l.frames_seen.first().is_some_and(|f| f.card != seen.card) {
                l.frames_seen.clear();
            }
            l.frames_seen.push(seen);
        }
        let dropped = l.frames_seen.len().saturating_sub(votes);
        l.frames_seen.drain(..dropped);
        let rules = &l.agreement.rules;
        let decide_at = rules.required as f32;
        // How far the votes held are toward a decision: two accepted frames, or three in all.
        let progress = (strong as f32 / rules.required.max(1) as f32)
            .max(votes as f32 / rules.support_required.max(1) as f32)
            .min(1.0);
        let gone = l.agreement.absent() >= rules.forget_after;
        let decisions = l.agreement.decisions();
        let new = decisions != l.decisions;
        let laid_on = new && l.agreement.decision().is_some_and(|d| d.another_look);
        let relaid = new && l.agreement.decision().is_some_and(|d| d.relaid);
        l.decisions = decisions;
        let standing = l.agreement.decision().map(|d| (d.entry, d.score));
        let gallery = l.recognizer.gallery();
        let fresh = match standing {
            None => {
                l.decided = None;
                None
            }
            // The same look laid again: what was decided of it holds, as the first copy's frames
            // are the only ones the printing evidence kept.
            Some(_) if relaid && l.decided.is_some() => l.decided.clone(),
            Some((entry, score)) if new => {
                let chosen = l.index.as_ref().and_then(|evidence| {
                    evidence_decision(gallery, r, mask, entry, &l.frames_seen, evidence)
                });
                Some(match chosen {
                    Some((d, report)) => {
                        l.report = Some(report);
                        d
                    }
                    None => {
                        l.report = None;
                        neural_decision(gallery, r, mask, entry, score)
                    }
                })
            }
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
            if relaid
                || (laid_on && self.previous_printing.as_deref() != Some(d.printing.as_str()))
            {
                // Another printing of the card laid on it, or another copy of the same one: what
                // the last decision named is under it now, so the same card is a second copy.
                self.previous_card = None;
            }
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
    let distance = Some(normalized(score));
    let choices = if admitted.len() > 1 {
        admitted.iter().map(|p| (*p, distance)).collect()
    } else {
        Vec::new()
    };
    decision_view(r, printing, choices)
}

/// A decision on `printing`: `ambiguous` with `choices` (each with its distance) when there are
/// any, `resolved` when there are none.
#[cfg(feature = "neural")]
fn decision_view(
    r: Option<&Reference>,
    printing: Id,
    choices: Vec<(Id, Option<f32>)>,
) -> DecisionView {
    let oracle_id = |p: &Id| r.and_then(|r| r.oracle_id_of(p)).map(|o| format_uuid(&o));
    let finishes = |p: &Id| r.map(|r| r.finishes_of(p).to_vec()).unwrap_or_default();
    DecisionView {
        printing: format_uuid(&printing),
        oracle_id: oracle_id(&printing),
        label: r.and_then(|r| r.label_for(&printing)),
        outcome: if choices.is_empty() { Outcome::Resolved } else { Outcome::Ambiguous },
        choices: choices
            .iter()
            .map(|(p, distance)| ChoiceView {
                id: format_uuid(p),
                oracle_id: oracle_id(p),
                label: r.and_then(|r| r.label_for(p)),
                distance: *distance,
                finishes: finishes(p),
            })
            .collect(),
        replaces_previous: false,
        finishes: finishes(&printing),
        finish_mark: None,
    }
}

/// What a read keeps for the printing evidence: its voted-for card's face, fingerprint and
/// crops. `None` for a frame that votes for nothing.
///
/// **Nor for a frame of the card already decided**: the agreement counts a decision again only
/// for another card, another look of the decided one, or after forgetting it — each of which
/// ends the count, and the frames kept with it — so that frame could never choose a printing,
/// and its two crop networks are not run. The kept frames stop growing while a card sits decided
/// on the mat. A frame of another look of it is kept: it may be a second printing laid on top.
///
/// A crop that will not read drops the frame's glance, not the frame: its fingerprint still
/// scores the card's looks.
#[cfg(feature = "neural")]
fn keep(
    read: &card_neural::Read,
    gallery: &card_neural::Gallery,
    agreement: &card_neural::Agreement,
    nets: Option<&mut card_neural::EvidenceNets>,
    pixels: &card_neural::Frame,
) -> Option<Seen> {
    if !(read.accepted || read.supported) {
        return None;
    }
    let best = read.best()?;
    if agreement.is_decided(&best.scored) {
        return None;
    }
    Some(Seen {
        card: best.scored.card,
        face: gallery.face(best.scored.entry),
        embedding: best.embedding.clone(),
        glance: nets.and_then(|n| n.glance(pixels, &best.quad).ok()),
    })
}

/// The decision look `entry` makes when the printing evidence is loaded — design §5, _The
/// decision_. `None` when no frame kept can score the card, or the filters admit none of its
/// candidates: the caller decides as [`neural_decision`] does.
///
/// - **Widened**: each look of the card is scored by its mean cosine over the frames kept, and
///   the looks within `candidate_gap` of the decided look's score are candidates — the decided
///   look always — so a printing that lost by a little comes back.
/// - **Their printings**: each candidate look's covers the filters admit, once each, the
///   decided look's first (its pictured printing leading), then the others' by their look's
///   score — the order [`narrow`] breaks a tie by.
/// - **Narrowed** on the symbol and band crops of the decided look's face, scored against each
///   printing's rows. A sure printing is `resolved`; otherwise the printings not ruled out are
///   the choices, best first, each as far as its own look.
///
/// The card is never changed: every candidate is a printing of the card the agreement decided.
#[cfg(feature = "neural")]
fn evidence_decision(
    gallery: &card_neural::Gallery,
    r: Option<&Reference>,
    mask: &Mask,
    entry: u32,
    seen: &[Seen],
    (index, th): &(EvidenceIndex, EvidenceThresholds),
) -> Option<(DecisionView, EvidenceReport)> {
    let card = gallery.card(entry);
    let face = gallery.face(entry);
    let seen: Vec<&Seen> = seen
        .iter()
        .filter(|s| s.card == card && s.embedding.len() == gallery.dim())
        .collect();
    if seen.is_empty() {
        return None;
    }
    let whole = |e: u32| {
        seen.iter().map(|s| gallery.score(e, &s.embedding)).sum::<f32>() / seen.len() as f32
    };
    let decided = whole(entry);
    let mut others: Vec<(u32, f32)> = gallery
        .looks_of(card)
        .iter()
        .filter(|&&e| e != entry)
        .map(|&e| (e, whole(e)))
        .filter(|&(_, w)| w >= decided - th.candidate_gap)
        .collect();
    others.sort_by(|a, b| b.1.total_cmp(&a.1));
    let pictured = *gallery.printing(entry);

    // (printing, the look it came in by, that look's score), the decided look's first.
    let mut printings: Vec<(Id, u32, f32)> = Vec::new();
    for (e, w) in std::iter::once((entry, decided)).chain(others) {
        let mut covers: Vec<Id> = gallery.covers(e).filter(|p| mask.permits(p)).copied().collect();
        if e == entry {
            covers.sort_by_key(|p| *p != pictured);
        }
        for p in covers {
            if !printings.iter().any(|(q, ..)| *q == p) {
                printings.push((p, e, w));
            }
        }
    }
    if printings.is_empty() {
        return None;
    }

    let glances: Vec<Glance> = seen
        .iter()
        .filter(|s| s.face == face)
        .filter_map(|s| s.glance.clone())
        .collect();
    let candidates: Vec<NarrowCandidate> = printings
        .iter()
        .map(|&(p, _, w)| NarrowCandidate {
            printing: p,
            whole: w,
            symbol: index.symbol(&glances, &p),
            band: index.band(&glances, &p, face),
        })
        .collect();
    let narrowed = narrow(&candidates, th);
    let (printing, choices) = match narrowed.decided {
        Some(p) => (p, Vec::new()),
        None => {
            let distance =
                |p: &Id| printings.iter().find(|(q, ..)| q == p).map(|&(.., w)| normalized(w));
            let choices: Vec<(Id, Option<f32>)> =
                narrowed.choices.iter().map(|p| (*p, distance(p))).collect();
            (choices.first()?.0, choices)
        }
    };
    let report = EvidenceReport {
        candidates: candidates
            .iter()
            .zip(&printings)
            .map(|(c, &(_, look, _))| CandidateReport {
                printing: format_uuid(&c.printing),
                look,
                whole: c.whole,
                symbol: c.symbol,
                band: c.band,
            })
            .collect(),
        decided: narrowed.decided.map(|p| format_uuid(&p)),
    };
    Some((decision_view(r, printing, choices), report))
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
        use card_neural::gallery::Look;
        use card_neural::scanner::Scored;
        use card_neural::{EvidenceFiles, EvidenceIndex, Found, Gallery, Glance, Read};
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
                    embedding: vec![],
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
            feed_seen(s, read, None, at_ms)
        }

        /// A read, with what `neural_read` would have kept of it for the printing evidence.
        fn feed_seen(s: &mut Session, read: &Read, seen: Option<Seen>, at_ms: f64) -> Verdict {
            s.neural_verdict(read, seen, at_ms, FrameSize { w: 640, h: 480 }, 0.0, 0.0)
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

        // **The printing evidence**, over galleries built by hand: the shipped networks with a
        // whole-card gallery of three looks, and symbol and band galleries of five printings.
        // Look A of card 1 stands for P, Q and R (P pictured), look B of card 1 for S, look C
        // of card 2 for T. No crop network runs: the frames' glances are made by hand too.

        const P: Id = [1; 16];
        const Q: Id = [2; 16];
        const R: Id = [3; 16];
        const S: Id = [4; 16];
        const T: Id = [5; 16];
        const A: u32 = 0;
        const B: u32 = 1;
        const C: u32 = 2;
        const DIM: usize = 128;
        const BAND_DIM: usize = 8;

        /// A vector of `dim` zeros but for `parts`.
        fn vector(dim: usize, parts: &[(usize, f32)]) -> Vec<f32> {
            let mut v = vec![0.0; dim];
            for &(i, x) in parts {
                v[i] = x;
            }
            v
        }

        fn look(printing: Id, card: u32, covers: Vec<Id>) -> Look {
            Look { printing, card, face: Face::Front, covers, name: "look".into() }
        }

        /// A session over the three looks, in Neural, no evidence loaded. Against [`along`]'s
        /// fingerprint look A scores 0.80 and look B scores `b`.
        fn with_looks(b: f32) -> Session {
            with_looks_read_by(b, shipped().meta)
        }

        /// [`with_looks`], its `neural.json` this one.
        fn with_looks_read_by(b: f32, meta: Cow<'static, [u8]>) -> Session {
            let rows = [
                vector(DIM, &[(0, 0.8), (1, 0.6)]),
                vector(DIM, &[(0, b), (2, (1.0 - b * b).sqrt())]),
                vector(DIM, &[(3, 1.0)]),
            ]
            .concat();
            let looks = [look(P, 1, vec![P, Q, R]), look(S, 1, vec![S]), look(T, 2, vec![T])];
            let g = Gallery::build(&rows, DIM, &looks).expect("a gallery");
            let files = Files { gallery: Cow::Owned(g.as_bytes().to_vec()), meta, ..shipped() };
            let mut s = Session::new(None, None, 5);
            s.load_neural(files).expect("the shipped networks over a gallery made by hand");
            s.set_mode(ScanMode::Neural);
            s
        }

        /// One symbol shared by every printing, and a band row of its own for each: P on the
        /// band's axis 0, Q on 1, R on 2, S on 3, T on 4.
        fn index() -> EvidenceIndex {
            let printings = [P, Q, R, S, T];
            let symbols =
                Gallery::build(&vector(4, &[(0, 1.0)]), 4, &[look(P, 0, printings.to_vec())])
                    .expect("a symbol gallery");
            let rows: Vec<f32> =
                (0..printings.len()).flat_map(|i| vector(BAND_DIM, &[(i, 1.0)])).collect();
            let bands = Gallery::build(&rows, BAND_DIM, &printings.map(|p| look(p, 0, vec![p])))
                .expect("a band gallery");
            EvidenceIndex::new(symbols, bands).expect("an index")
        }

        fn thresholds() -> EvidenceThresholds {
            EvidenceThresholds {
                candidate_gap: 0.08,
                symbol_weight: 1.0,
                band_weight: 1.0,
                decide_margin: 0.1,
                keep_gap: 0.15,
            }
        }

        /// [`with_looks`], its evidence loaded as `load_neural_evidence` leaves it bar the
        /// networks.
        fn with_evidence(b: f32) -> Session {
            let mut s = with_looks(b);
            s.neural.loaded.as_mut().expect("loaded").index = Some((index(), thresholds()));
            s
        }

        /// The symbol crop, and a band crop scoring each printing's row by `band`.
        fn glance(band: &[(usize, f32)]) -> Glance {
            Glance { symbol: vector(4, &[(0, 1.0)]), band: vector(BAND_DIM, band) }
        }

        /// A frame of card 1's front, its whole-card fingerprint on the gallery's axis 0.
        fn along(glance: Option<Glance>) -> Seen {
            Seen { card: 1, face: Face::Front, embedding: vector(DIM, &[(0, 1.0)]), glance }
        }

        /// Two accepted frames of look A, each kept as `seen`: a decision.
        fn decide_seen(s: &mut Session, seen: &Seen) -> Verdict {
            let read = naming(s, A, true);
            feed_seen(s, &read, Some(seen.clone()), 0.0);
            feed_seen(s, &read, Some(seen.clone()), 100.0)
        }

        fn ids(ps: &[Id]) -> Vec<String> {
            ps.iter().map(format_uuid).collect()
        }

        fn choices(d: &DecisionView) -> Vec<String> {
            d.choices.iter().map(|c| c.id.clone()).collect()
        }

        fn json<T: serde::Serialize>(t: &T) -> serde_json::Value {
            serde_json::to_value(t).expect("json")
        }

        #[test]
        fn without_evidence_the_decision_is_todays() {
            let mut today = with_looks(0.75);
            let mut evidence = with_evidence(0.75);
            let seen = along(Some(glance(&[(1, 1.0)])));
            let read = naming(&today, A, true);
            let rival = naming(&today, C, true);
            for (i, read) in [&read, &read, &read, &rival, &rival].into_iter().enumerate() {
                let at = 100.0 * i as f64;
                let card = if i < 3 { seen.clone() } else { Seen { card: 2, ..seen.clone() } };
                let a = feed_seen(&mut today, read, Some(card.clone()), at);
                let b = feed_seen(&mut evidence, read, Some(card), at);
                // Evidence chooses the printing, and nothing else a frame reports.
                assert_eq!(a.decision_seq, b.decision_seq, "frame {i}");
                assert_eq!(json(&a.tracked), json(&b.tracked), "frame {i}");
                assert_eq!(json(&a.r#match), json(&b.r#match), "frame {i}");
                assert_eq!(a.quad, b.quad, "frame {i}");
                if i == 1 {
                    // Kept frames and all, a session with no evidence decides as it always has.
                    let g = gallery(&today);
                    let d = a.decision.expect("decided");
                    assert_eq!(json(&d), json(&neural_decision(g, None, &Mask::all(), A, 0.7)));
                    assert_eq!(d.outcome, Outcome::Ambiguous);
                    assert_eq!(choices(&d), ids(&[P, Q, R]));
                    assert!(today.neural_evidence_report().is_none());
                }
            }
            assert_eq!(today.decision_seq, 2);
        }

        #[test]
        fn a_lower_scored_look_of_the_card_within_the_gap_adds_its_printings() {
            let mut s = with_evidence(0.75);
            let d = decide_seen(&mut s, &along(None)).decision.expect("decided");
            // No crop read: nothing rules any of them out, so all four, in the order given.
            assert_eq!(d.outcome, Outcome::Ambiguous);
            assert_eq!(choices(&d), ids(&[P, Q, R, S]));
            assert_eq!(d.printing, format_uuid(&P));
            // Each choice is as far as its own look.
            let distances: Vec<f32> = d.choices.iter().map(|c| c.distance.expect("one")).collect();
            for (got, look) in distances.iter().zip([0.8, 0.8, 0.8, 0.75]) {
                assert!((got - normalized(look)).abs() < 1e-3, "{distances:?}");
            }
        }

        #[test]
        fn a_look_outside_the_gap_adds_nothing() {
            let mut s = with_evidence(0.70);
            let d = decide_seen(&mut s, &along(None)).decision.expect("decided");
            assert_eq!(d.outcome, Outcome::Ambiguous);
            assert_eq!(choices(&d), ids(&[P, Q, R]));
        }

        #[test]
        fn sure_crop_evidence_resolves_a_look_of_many_printings() {
            let mut s = with_evidence(0.70);
            let v = decide_seen(&mut s, &along(Some(glance(&[(1, 1.0)]))));
            assert_eq!(v.decision_seq, 1);
            let d = v.decision.expect("decided");
            assert_eq!((d.outcome, d.choices.len()), (Outcome::Resolved, 0));
            assert_eq!(d.printing, format_uuid(&Q));
            // Every later frame of the card repeats it.
            let read = naming(&s, A, true);
            let later = feed_seen(&mut s, &read, Some(along(None)), 200.0);
            assert_eq!(later.decision.expect("held").printing, format_uuid(&Q));
        }

        #[test]
        fn unsure_crop_evidence_leaves_fewer_choices_best_first() {
            let mut s = with_evidence(0.70);
            // Q leads R by 0.04, under the margin; P is 0.6 behind, past the keep gap.
            let d = decide_seen(&mut s, &along(Some(glance(&[(1, 0.6), (2, 0.56)]))))
                .decision
                .expect("decided");
            assert_eq!(d.outcome, Outcome::Ambiguous);
            assert_eq!(choices(&d), ids(&[Q, R]));
            assert_eq!(d.printing, format_uuid(&Q));
        }

        #[test]
        fn the_filters_limit_the_widened_candidates() {
            let filtered = |allowed: &[Id]| {
                let mut s = with_evidence(0.75);
                s.mask = Mask::allow_only(allowed.iter().copied());
                s.neural.filters_changed();
                s.forget_card();
                decide_seen(&mut s, &along(None)).decision.expect("decided")
            };
            let two = filtered(&[R, S]);
            assert_eq!(two.outcome, Outcome::Ambiguous);
            assert_eq!(choices(&two), ids(&[R, S]));
            assert_eq!(two.printing, format_uuid(&R));

            let one = filtered(&[R]);
            assert_eq!((one.outcome, one.choices.len()), (Outcome::Resolved, 0));
            assert_eq!(one.printing, format_uuid(&R));
        }

        #[test]
        fn a_vote_for_another_card_clears_the_evidence_frames() {
            let kept = |s: &Session| -> Vec<u32> {
                let l = s.neural.loaded.as_ref().expect("loaded");
                l.frames_seen.iter().map(|f| f.card).collect()
            };
            let mut s = with_evidence(0.75);
            let (a, c) = (naming(&s, A, true), naming(&s, C, true));
            feed_seen(&mut s, &a, Some(along(None)), 0.0);
            assert_eq!(kept(&s), [1]);
            feed_seen(&mut s, &c, Some(Seen { card: 2, ..along(None) }), 100.0);
            assert_eq!(kept(&s), [2]);
            // A frame that votes for nothing ends the count, and the frames kept for it.
            feed(&mut s, &empty(), 200.0);
            assert!(kept(&s).is_empty());
            feed_seen(&mut s, &a, Some(along(None)), 300.0);
            s.forget_card();
            assert!(kept(&s).is_empty(), "a reset kept the frames");
        }

        /// The cards of the frames kept for the evidence, oldest first.
        fn kept_cards(s: &Session) -> Vec<u32> {
            let l = s.neural.loaded.as_ref().expect("loaded");
            l.frames_seen.iter().map(|f| f.card).collect()
        }

        #[test]
        fn a_vote_for_the_decided_card_clears_the_frames_kept_for_another() {
            let mut s = with_evidence(0.75);
            let (c, a) = (naming(&s, C, true), naming(&s, A, true));
            // Card 2 decided, then a frame of card 1 kept.
            feed(&mut s, &c, 0.0);
            assert_eq!(feed(&mut s, &c, 100.0).decision_seq, 1);
            feed_seen(&mut s, &a, Some(along(None)), 200.0);
            assert_eq!(kept_cards(&s), [1]);
            // A frame of the decided card keeps nothing, yet restarts the count: card 1's frame
            // is out of it.
            feed(&mut s, &c, 300.0);
            assert!(kept_cards(&s).is_empty());
            // Shown in turn, neither card is ever counted twice, and nothing piles up.
            for i in 0..10 {
                let at = 400.0 + 200.0 * i as f64;
                feed_seen(&mut s, &a, Some(along(None)), at);
                feed(&mut s, &c, at + 100.0);
            }
            assert!(kept_cards(&s).is_empty());
        }

        #[test]
        fn the_frames_kept_are_the_votes_the_agreement_holds() {
            let mut s = with_evidence(0.75);
            let supported = naming(&s, A, false);
            feed_seen(&mut s, &supported, Some(along(None)), 0.0);
            feed_seen(&mut s, &supported, Some(along(None)), 100.0);
            assert_eq!(kept_cards(&s), [1, 1]);
            // Past the gap the agreement counts again from this frame alone, and so do they.
            let v = feed_seen(&mut s, &supported, Some(along(None)), 1000.0);
            assert_eq!(v.tracked.expect("tracked").streak, 1);
            assert_eq!(kept_cards(&s), [1]);
        }

        /// [`with_looks`], over a reference where card 1's printings P, Q, R and S are one oracle
        /// card and T another — so a decision on one of card 1's looks after another is the same
        /// card to [`Session::replaces_previous`].
        fn one_oracle(b: f32) -> Session {
            let mut s = with_looks(b);
            let (mut r, _, _) = fast::two_far_cards();
            for (printing, oracle, number) in
                [(P, 30, "1"), (Q, 30, "2"), (R, 30, "3"), (S, 30, "4"), (T, 31, "5")]
            {
                let label = Label {
                    name: format!("Card {oracle}"),
                    set: "hob".into(),
                    number: number.into(),
                    lang: "en".into(),
                    released: "2025-01-01".into(),
                };
                r.add_label(printing, Some(fast::id(oracle)), None, label);
            }
            s.reference = Some(std::sync::Arc::new(r));
            s
        }

        /// #1359: look B of card 1 laid on look A of it is a second copy, as another card is.
        #[test]
        fn a_second_printing_laid_on_the_decided_card_is_another_copy() {
            let mut s = one_oracle(0.75);
            let first = decide(&mut s, A, 0.0).decision.expect("decided");
            assert_eq!(first.printing, format_uuid(&P));
            // Two frames of it are not at rest: the first printing stands.
            for at in [200.0, 300.0] {
                let v = vote(&mut s, B, at);
                assert_eq!(v.decision_seq, 1);
                assert_eq!(v.decision.expect("held").printing, format_uuid(&P));
            }
            let v = vote(&mut s, B, 400.0);
            assert_eq!(v.decision_seq, 2, "a second printing of the decided card never decided");
            let d = v.decision.expect("decided");
            assert_eq!((d.printing, d.oracle_id.clone()), (format_uuid(&S), first.oracle_id));
            assert!(!d.replaces_previous, "a second printing replaced the first one's row");
            assert!(vote(&mut s, B, 500.0).decision.expect("held").printing == format_uuid(&S));

            // The first printing laid back on it adds in turn.
            for at in [600.0, 700.0] {
                assert_eq!(vote(&mut s, A, at).decision_seq, 2);
            }
            let v = vote(&mut s, A, 800.0);
            assert_eq!(v.decision_seq, 3);
            assert!(!v.decision.expect("decided").replaces_previous);
        }

        /// A frame with a card in front of the lens that votes for none: a hand over the pile.
        fn covered() -> Read {
            Read { present: true, ..Default::default() }
        }

        /// An accepted frame of `entry`, lying `dx` pixels right of [`naming`]'s.
        fn laid(s: &Session, entry: u32, dx: f32) -> Read {
            let mut read = naming(s, entry, true);
            let found = &mut read.cards[0];
            for p in found.quad.iter_mut().chain(found.detection.quad.iter_mut()) {
                p.x += dx;
            }
            read
        }

        /// #1375: another copy of the decided printing laid on it is a second copy of it.
        #[test]
        fn another_copy_of_the_decided_printing_laid_on_it_adds() {
            let mut s = one_oracle(0.75);
            let first = decide(&mut s, A, 0.0).decision.expect("decided");
            for at in [200.0, 300.0] {
                assert_eq!(feed(&mut s, &covered(), at).decision_seq, 1);
            }
            let copy = laid(&s, A, 60.0);
            assert_eq!(feed(&mut s, &copy, 400.0).decision_seq, 1);
            let v = feed(&mut s, &copy, 500.0);
            assert_eq!(v.decision_seq, 2, "another copy laid on the decided card never decided");
            let d = v.decision.expect("decided");
            assert_eq!((&d.printing, d.outcome), (&first.printing, first.outcome));
            assert!(!d.replaces_previous, "a second copy replaced the first one's row");
            let held = feed(&mut s, &copy, 600.0);
            assert_eq!(held.decision_seq, 2);
            assert!(!held.decision.expect("held").replaces_previous);

            // A hand passing over it leaves it where it lay: nothing more.
            for at in [700.0, 800.0] {
                feed(&mut s, &covered(), at);
            }
            feed(&mut s, &copy, 900.0);
            assert_eq!(feed(&mut s, &copy, 1000.0).decision_seq, 2);
        }

        #[test]
        fn another_copy_keeps_the_printing_the_evidence_chose() {
            // The copy's frames are the decided card's, so none is kept: the printing the first
            // copy's frames chose is the second's.
            let mut s = one_oracle(0.75);
            s.neural.loaded.as_mut().expect("loaded").index = Some((index(), thresholds()));
            let first = decide_seen(&mut s, &along(Some(glance(&[(1, 1.0)])))).decision;
            let first = first.expect("decided");
            assert_eq!((first.outcome, &first.printing), (Outcome::Resolved, &format_uuid(&Q)));
            for at in [200.0, 300.0] {
                feed(&mut s, &covered(), at);
            }
            let copy = laid(&s, A, -60.0);
            feed(&mut s, &copy, 400.0);
            let v = feed(&mut s, &copy, 500.0);
            assert_eq!(v.decision_seq, 2);
            let d = v.decision.expect("decided");
            assert_eq!((d.outcome, d.printing), (Outcome::Resolved, format_uuid(&Q)));
            assert!(!d.replaces_previous);
        }

        #[test]
        fn a_held_cards_look_wavering_adds_nothing() {
            let mut s = one_oracle(0.75);
            decide(&mut s, A, 0.0);
            for (i, entry) in [B, B, A, B, B, A, A].into_iter().enumerate() {
                let v = vote(&mut s, entry, 200.0 + 100.0 * i as f64);
                assert_eq!(v.decision_seq, 1, "frame {i}");
            }
        }

        #[test]
        fn another_look_that_comes_to_the_same_printing_is_a_second_opinion() {
            // The evidence says Q on look A and again on look B: the card's own look wavered
            // long enough to decide, and its row is replaced rather than added to.
            let mut s = one_oracle(0.75);
            s.neural.loaded.as_mut().expect("loaded").index = Some((index(), thresholds()));
            let q = along(Some(glance(&[(1, 1.0)])));
            let first = decide_seen(&mut s, &q).decision.expect("decided");
            assert_eq!(first.printing, format_uuid(&Q));
            let read = naming(&s, B, true);
            let v = (0..3)
                .map(|i| feed_seen(&mut s, &read, Some(q.clone()), 200.0 + 100.0 * i as f64))
                .last()
                .expect("three frames");
            assert_eq!(v.decision_seq, 2);
            let d = v.decision.expect("decided");
            assert_eq!(d.printing, format_uuid(&Q));
            assert!(d.replaces_previous, "the same printing on another look was added twice");

            // Laid on with S's band, it is S, and adds.
            let mut s = one_oracle(0.75);
            s.neural.loaded.as_mut().expect("loaded").index = Some((index(), thresholds()));
            decide_seen(&mut s, &q);
            let on_s = along(Some(glance(&[(3, 1.0)])));
            let v = (0..3)
                .map(|i| feed_seen(&mut s, &read, Some(on_s.clone()), 200.0 + 100.0 * i as f64))
                .last()
                .expect("three frames");
            let d = v.decision.expect("decided");
            assert_eq!((v.decision_seq, d.printing.clone()), (2, format_uuid(&S)));
            assert!(!d.replaces_previous);
        }

        #[test]
        fn the_deciding_frames_glance_chooses_the_printing() {
            let mut s = with_evidence(0.75);
            let read = naming(&s, A, true);
            feed_seen(&mut s, &read, Some(along(None)), 0.0);
            let v = feed_seen(&mut s, &read, Some(along(Some(glance(&[(1, 1.0)])))), 100.0);
            let d = v.decision.expect("decided");
            assert_eq!((d.outcome, d.printing), (Outcome::Resolved, format_uuid(&Q)));
            let report = s.neural_evidence_report().expect("a report");
            assert_eq!(report.decided, Some(format_uuid(&Q)));
        }

        #[test]
        fn a_frame_keeps_its_voted_for_card_until_that_card_is_decided() {
            let s = with_looks(0.75);
            let g = gallery(&s);
            let pixels = card_neural::Frame::new(32, 32, vec![0; 32 * 32 * 3]).expect("a frame");
            let mut agreement = card_neural::Agreement::default();
            let mut read = naming(&s, A, true);
            read.cards[0].embedding = vector(DIM, &[(0, 1.0)]);
            let kept = keep(&read, g, &agreement, None, &pixels).expect("a voting frame is kept");
            assert_eq!((kept.card, kept.face, kept.embedding.len()), (1, Face::Front, DIM));
            assert!(kept.glance.is_none(), "no networks, no crops");
            assert!(keep(&empty(), g, &agreement, None, &pixels).is_none());
            // Once the card is decided its frames can never choose a printing, so none is kept.
            agreement.observe(&read, 0.0);
            agreement.observe(&read, 100.0);
            assert!(agreement.decision().is_some());
            assert!(keep(&read, g, &agreement, None, &pixels).is_none());
            assert!(keep(&naming(&s, C, true), g, &agreement, None, &pixels).is_some());
            // Another look of it may be a second printing laid on top, which is chosen on them.
            assert!(keep(&naming(&s, B, true), g, &agreement, None, &pixels).is_some());
        }

        #[test]
        fn the_report_names_every_candidate_with_its_scores() {
            let mut s = with_evidence(0.75);
            assert!(s.neural_evidence_report().is_none());
            decide_seen(&mut s, &along(Some(glance(&[(1, 0.6), (2, 0.56)]))));
            let report = s.neural_evidence_report().expect("a report");
            assert_eq!(report.decided, None);
            let printings: Vec<String> =
                report.candidates.iter().map(|c| c.printing.clone()).collect();
            assert_eq!(printings, ids(&[P, Q, R, S]));
            let looks: Vec<u32> = report.candidates.iter().map(|c| c.look).collect();
            assert_eq!(looks, [A, A, A, B]);
            let close = |a: f32, b: f32| (a - b).abs() < 1e-3;
            for (c, (whole, band)) in
                report.candidates.iter().zip([(0.8, 0.0), (0.8, 0.6), (0.8, 0.56), (0.75, 0.0)])
            {
                assert!(close(c.whole, whole), "{c:?}");
                assert!(c.symbol.is_some_and(|v| close(v, 1.0)), "{c:?}");
                assert!(c.band.is_some_and(|v| close(v, band)), "{c:?}");
            }

            // A reset forgets it; a sure decision names its printing.
            s.forget_card();
            assert!(s.neural_evidence_report().is_none());
            decide_seen(&mut s, &along(Some(glance(&[(1, 1.0)]))));
            let report = s.neural_evidence_report().expect("a report");
            assert_eq!(report.decided, Some(format_uuid(&Q)));
        }

        #[test]
        fn evidence_is_refused_before_the_recogniser_or_without_a_section() {
            let files = || EvidenceFiles {
                symbol_net: Cow::Borrowed(b"not a network"),
                band_net: Cow::Borrowed(b"not a network"),
                symbols: Cow::Borrowed(b"not a gallery"),
                bands: Cow::Borrowed(b"not a gallery"),
            };
            let mut bare = Session::new(None, None, 5);
            assert!(bare.load_neural_evidence(files()).is_err());
            // A neural.json from before the evidence models — the shipped one without its
            // section: no section, so no evidence.
            let mut meta: serde_json::Value =
                serde_json::from_slice(&shipped().meta).expect("the shipped neural.json");
            meta.as_object_mut().expect("an object").remove("evidence");
            let mut s = with_looks_read_by(0.75, Cow::Owned(meta.to_string().into_bytes()));
            s.neural.loaded.as_mut().expect("loaded").index = Some((index(), thresholds()));
            assert!(s.has_neural_evidence());
            let refused = s.load_neural_evidence(files()).expect_err("no evidence section");
            assert!(refused.contains("evidence"), "{refused}");
            // A refusal leaves today's behaviour, not the evidence loaded before it.
            assert!(!s.has_neural_evidence());
            let d = decide_seen(&mut s, &along(Some(glance(&[(1, 1.0)])))).decision;
            assert_eq!(d.map(|d| choices(&d)), Some(ids(&[P, Q, R])));
            assert!(s.neural_evidence_report().is_none());

            // With the section, files that are not networks or galleries are refused too, and
            // leave the same.
            let mut s = with_evidence(0.75);
            assert!(s.load_neural_evidence(files()).is_err());
            assert!(!s.has_neural_evidence());
        }

        /// The networks and galleries in git load beside the recogniser in git.
        #[test]
        fn the_shipped_evidence_loads_into_a_session() {
            let mut s = session(None);
            assert!(!s.has_neural_evidence());
            let files = EvidenceFiles {
                symbol_net: Cow::Borrowed(include_bytes!("../../card-neural/models/symbol.onnx")),
                band_net: Cow::Borrowed(include_bytes!("../../card-neural/models/band.onnx")),
                symbols: Cow::Borrowed(include_bytes!("../../card-neural/models/symbols.bin")),
                bands: Cow::Borrowed(include_bytes!("../../card-neural/models/bands.bin")),
            };
            s.load_neural_evidence(files).expect("the evidence in git loads");
            assert!(s.has_neural_evidence());
        }
    }
}
