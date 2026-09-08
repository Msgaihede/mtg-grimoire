//! Turning a stream of per-frame guesses into one stable answer.
//!
//! ## Why a single frame is not enough
//!
//! Matching is stateless: every frame is decided from scratch, and at ~12 frames a second a
//! near-tie flips constantly. Driving the live view, the readout visibly flickers between
//! several cards — and the *right* one is usually the one shown most often. That is the whole
//! signal this module exists to collect.
//!
//! The correct card is **consistent**: it scores well on nearly every frame, because it is
//! genuinely the card in front of the lens. A wrong answer is **incidental**: it wins one
//! frame because a glare, a hand shadow or a slightly different quad happened to nudge a few
//! bits. Consistency is invisible to a single frame and obvious across ten.
//!
//! ## Evidence, not votes
//!
//! Counting how often each card is *rank 1* throws away most of what each frame knows. When
//! the top two are one bit apart, calling that a win for the first is nearly a coin toss, and
//! recording it as a whole vote records the coin toss rather than the evidence.
//!
//! So every candidate in a frame's top-K contributes weight, and the weights accumulate with
//! exponential decay. A card that is consistently second at a good distance beats one that is
//! occasionally first at a bad one — which is exactly the flicker case, and exactly what
//! rank-counting gets wrong.
//!
//! ## Weight is relative to the frame's best, not absolute
//!
//! Weighting purely by a candidate's own distance was wrong, and wrong in a way that only
//! shows up on a card held still. The premise was that wrong answers are *random* frame to
//! frame and wash out. They are not: with a stable card in front of the lens the top-K is
//! nearly the same list every frame, so the runners-up accumulate exactly as consistently as
//! the winner does.
//!
//! Measured live on a Took Reaper held in frame: it was top on every frame at 21.5%, the lock
//! was solid, and after 53 frames it held **30% of the evidence** against a 45% bar. Its four
//! runners-up sat at 25-26% and together outweighed it, so the tracker could never commit —
//! the right answer was being outvoted by the same losers over and over.
//!
//! The candidates in a frame are competing hypotheses about one card, so what a candidate
//! deserves depends on how much better it is *than the alternatives in that frame*. An
//! exponential falloff in the gap to the frame's best does that, and it has the property the
//! flicker case needs: sharp when there is a clear winner, soft when the top two are genuinely
//! a bit apart. On the same measured frame the winner's share goes from 30% to about 78%.
//!
//! Decay rather than a fixed window because it needs no ring buffer, it degrades smoothly
//! when frames are dropped (which the live view does constantly, by design), and a card
//! removed from the lens fades instead of lingering until a window slides past it.
//!
//! ## Evidence groups by card, not by printing
//!
//! Each observation carries a **key** to accumulate on and a **member** it actually names.
//! The caller passes the oracle id as the key and the printing id as the member, so all of a
//! card's reprints pool their evidence and the best-scoring printing is remembered alongside.
//!
//! Without that split, a card with several printings splits its own vote. Measured while
//! replaying four photographs of Esquire of the King: the right card led every single frame
//! and still never committed, because its evidence was spread across its reprints and no one
//! printing reached the threshold. The reader was being denied an answer by the card being
//! *too well known*.
//!
//! It also matches what fast mode promises — a card now, its exact printing marked
//! provisional — so the number that gates the commit is the number about the card.
//!
//! ## Two verdicts on one accumulator
//!
//! Everything above is how evidence is *gathered*. What turns it into an answer is a
//! [`CommitRule`], and there are two, chosen per session and switchable on a held card:
//!
//! **Confidence** is the original: evidence decays, the leader must hold a share of its
//! two-way contest with its best rival, have been seen enough and led for a streak, and the
//! commit is re-evaluated on every frame and can lapse. It is a *belief*, and it never stops
//! being revised.
//!
//! **Votes** is a *decision*. Each observation is worth its tier weight scaled only by how far
//! behind the frame's best it is — a clean appearance frame is one vote, a read name six, a
//! collector line two — and the votes accumulate with no decay toward a bar. The card is
//! decided the moment its votes reach the bar while it leads its best rival by a margin, and
//! from then on the tally is **frozen**: later frames count only misses, so the verdict
//! cannot flicker back. The freeze lifts when the decided card is gone for
//! `reset_after_misses` frames — out of the lens, or replaced by another card held steady —
//! when the reader resets, or when the bar is raised above the tally.
//!
//! Two things left the score on purpose. **Decay**, because a threshold and decay cannot
//! coexist: evidence saturates at `w / (1 - decay)` and the bar becomes a ceiling a
//! weaker-but-correct match can never reach — the exact failure `commit_seen` records.
//! **Quality**, the candidate's own distance across the usable range, because it made a vote
//! worth 0.47 at 41 bits and 0.13 at 66, so the bar read in no unit anyone could picture;
//! a vote is worth the same anywhere inside the gate, and the gate is what rejects noise.

use crate::index::ID_LEN;
use std::collections::HashMap;

/// How accumulated evidence becomes an answer. See the module doc for the two.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CommitRule {
    /// Undecayed votes toward a bar; a decision freezes the tally.
    Votes,
    /// Decayed evidence, the leader's share of its contest with its rival, re-evaluated every
    /// frame.
    Confidence,
}

#[derive(Debug, Clone)]
pub struct TrackerOptions {
    /// Which verdict to draw from the accumulator.
    pub rule: CommitRule,
    /// Votes the leader needs before it can be decided. Vote rule only.
    ///
    /// In frames of clean appearance: 8 is eight of them, or a read name plus two, or a
    /// collector line plus six. Under a second at the measured ~12 detections a second, and
    /// short enough that a single read cannot decide on its own.
    pub decide_at: f32,
    /// How far ahead of its best rival the leader must be to decide. Vote rule only.
    ///
    /// The same 1.3 as `switch_margin`, and for the same reason: two candidates a bit apart
    /// gather votes at nearly the same rate, and letting the first to touch the bar win is
    /// letting a coin toss decide. At 1.0 it is first past the post, which the page can ask
    /// for.
    pub lead_margin: f32,
    /// Per-frame multiplier applied to all accumulated evidence. Confidence rule only.
    ///
    /// 0.93 gives an effective memory of ~1/(1-0.93) ≈ 14 frames, a little over a second at
    /// the measured ~12 detections a second.
    ///
    /// It was 0.85 (~7 frames) and that was too short. The hash tier on a difficult card
    /// offers a *different* near-random neighbour every frame, so a short memory lets whatever
    /// happened to win the last few frames dominate. What is wanted is the card seen most
    /// consistently over a while, and "a while" is tens of frames, not a handful.
    pub decay: f32,
    /// Candidates worse than this contribute nothing.
    ///
    /// Matches the measured trough between the two distance clusters. Beyond it a candidate
    /// is not weak evidence, it is noise, and letting noise accumulate is how a tracker
    /// commits confidently to nothing.
    pub max_normalized: f32,
    /// How much of the *two-way contest with its best rival* the leader must hold.
    /// Confidence rule only.
    ///
    /// **Not its share of all accumulated evidence, and the difference is the whole point.**
    /// A share is a fraction of a denominator that grows every time a new candidate appears
    /// once and is never seen again — so a card that was correctly first on every frame for a
    /// minute still read as 40-60% certain, because dozens of one-off runners-up had each
    /// added a little to the total. The churn was being counted as competition.
    ///
    /// A candidate that appears once and never returns is not a competing hypothesis, and the
    /// alternatives *changing* is itself evidence the leader is right. So confidence is
    /// `leader / (leader + best rival)`: 0.5 is a dead heat, 1.0 is unopposed, and it is
    /// unaffected by however much noise drifts through behind them.
    pub commit_confidence: f32,
    /// Informative frames the leader must have appeared in, so one lucky frame cannot commit
    /// alone. Confidence rule only.
    ///
    /// **This counts frames, not accumulated weight, and the difference is not cosmetic.** It
    /// was an absolute evidence threshold at first, and that silently made commitment
    /// *impossible* for weaker-but-correct matches: weight comes from match quality, evidence
    /// saturates at `w / (1 - decay)`, so with the shipped decay anything matching worse than
    /// 23.3% could never reach the bar however long the card was held there. Oliphaunt matches
    /// correctly at 24.6% and was barred outright — it led every frame with a 100% share and
    /// the tracker refused to say so.
    ///
    /// Match quality is already gated by `max_normalized`. This gate is for *consistency*, and
    /// consistency is a count.
    pub commit_seen: u32,
    /// Consecutive frames the leader must have led for. Confidence rule only.
    pub commit_streak: u32,
    /// Frames with nothing usable before the accumulator is cleared — the card has left.
    ///
    /// Under a vote-rule freeze the same count ends the decision, and a miss there is any
    /// frame the decided card was not in — empty, or showing the same other card. See
    /// [`Tracker::observe`].
    pub reset_after_misses: u32,
    /// How many of each frame's candidates contribute.
    pub top_k: usize,
    /// How far ahead a challenger must be before it takes the lead from the incumbent.
    ///
    /// **Without this the reported card changes on a tie, and a tie happens constantly.** On a
    /// difficult card the top two are often within a bit or two of each other, so the leader
    /// swapped on a single frame of noise and the readout flickered even though the
    /// accumulated evidence had barely moved. 1.3 means a challenger needs 30% more evidence
    /// than the incumbent — enough that one or two odd frames cannot do it, little enough that
    /// genuinely putting down a different card still switches within a second.
    ///
    /// This is hysteresis on the *reported* leader only. The accumulator underneath is
    /// untouched, so nothing is being hidden: a challenger that is really winning keeps
    /// gaining and takes the lead shortly after it deserves it.
    pub switch_margin: f32,
    /// How fast a candidate's weight falls off with its distance behind the frame's best, in
    /// normalized units.
    ///
    /// 0.015 is about four bits at 256. A four-bit gap roughly thirds a candidate's weight and
    /// the ten-bit gaps seen in practice cut it to a fortieth, so the frame's best candidate
    /// carries most of that frame's evidence. Larger values dilute a clear winner among its
    /// runners-up; much smaller ones make a genuine near-tie look decided and reintroduce the
    /// flicker one tier up.
    pub relative_falloff: f32,
}

impl Default for TrackerOptions {
    fn default() -> Self {
        TrackerOptions {
            rule: CommitRule::Votes,
            decide_at: 8.0,
            lead_margin: 1.3,
            decay: 0.93,
            max_normalized: 0.30,
            commit_confidence: 0.70,
            commit_seen: 5,
            commit_streak: 3,
            reset_after_misses: 10,
            top_k: 5,
            relative_falloff: 0.015,
            switch_margin: 1.3,
        }
    }
}

/// Where an observation came from.
///
/// **Candidates are only ever ranked against others of their own kind.** The relative falloff
/// below asks "how far behind this frame's best is this candidate", and that question only
/// means anything among answers to the same question. A read name enters at distance zero, so
/// comparing a hash neighbour at 0.15 against it put every appearance candidate ten falloff
/// widths behind and multiplied it by e^-10 — measured, thirty frames of a consistent hash
/// match accumulated 0.0000 against a read's 101.33. The hash was not outvoted, it was
/// annihilated, and on a card the reader had misread there was nothing left to correct it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Evidence {
    /// A nearest neighbour in the bundle — what the card looks like.
    Appearance,
    /// A name read off the title band.
    Name,
    /// A set code and collector number read off the bottom-left corner.
    Collector,
}

/// One observation from a frame.
#[derive(Debug, Clone, Copy)]
pub struct Observation {
    /// What evidence pools on — an oracle id, when the caller groups by card.
    pub key: [u8; ID_LEN],
    /// What it actually names: the printing to report.
    pub member: [u8; ID_LEN],
    /// Normalized distance, 0 = perfect.
    pub normalized: f32,
    /// How much this *kind* of observation is worth against the others in the frame.
    ///
    /// **Not every signal is equal evidence, and treating them as equal was a real bug.** A
    /// nearest-neighbour hash is a guess about appearance; a name read off the card is close
    /// to proof. Measured live on a foil, the hash offered a different near-random neighbour
    /// every frame at 55-66 bits while OCR read the title correctly every single time — but
    /// OCR ran on one frame in five and counted the same as a guess, so the guesses
    /// out-accumulated it and the tracker committed to `Suplex`.
    ///
    /// 1.0 is an appearance match. See [`Observation::from_ocr`] for what a read is worth.
    pub weight: f32,
    /// How much this observation is worth for choosing the *printing*, separately from the
    /// card.
    ///
    /// **These are different questions and one number cannot answer both.** A collector number
    /// pins a printing exactly and is the only thing that can — but a single misread digit
    /// names a real, valid, entirely different card, so it is weak evidence about *which card*
    /// and decisive evidence about *which printing of it*. A read name is the mirror image: it
    /// identifies the card well and says nothing whatever about the printing, since every
    /// reprint shares the name and the one it resolves to is simply whichever the index
    /// happened to store.
    ///
    /// So the art decides the card and the number narrows it down within that card, which is
    /// what each is actually good for.
    pub member_weight: f32,
    /// Which tier produced this. Candidates are ranked only against others of the same kind —
    /// see [`Evidence`].
    pub kind: Evidence,
}

impl Observation {
    /// An appearance match: a hash neighbour, worth one vote.
    pub fn appearance(key: [u8; ID_LEN], member: [u8; ID_LEN], normalized: f32) -> Observation {
        Observation {
            key,
            member,
            normalized,
            weight: 1.0,
            // A hash match names a specific printing and is genuinely evidence for it — a
            // borderless and a retro frame of one card do not look alike.
            member_weight: 1.0,
            kind: Evidence::Appearance,
        }
    }

    /// A set code and collector number read off the card's bottom-left corner.
    ///
    /// **The only tier that identifies a printing rather than a card.** The descriptor says
    /// what this looks like and reads a reprint as readily as the right one; the title says
    /// what it is called and every reprint shares that name. `LTR 232` is an identity, and
    /// nothing else the scanner sees is — which is why the member it names can be trusted
    /// where a hash's cannot.
    ///
    /// Weighted above a clean title read but not beyond argument. Measured over the corpus it
    /// resolves 12 of 39 rectifications and 11 of those are right, so roughly one resolve in
    /// twelve is a confident wrong answer — a misread digit, which no amount of parsing fixes.
    /// A single frame must not be able to carry that on its own; several agreeing frames
    /// should walk away with it, and at 8.0 against appearance's 1.0 they do.
    pub fn from_collector(key: [u8; ID_LEN], member: [u8; ID_LEN]) -> Observation {
        Observation {
            key,
            member,
            normalized: 0.0,
            // **Deliberately modest as evidence about which card.** A misread digit does not
            // produce nonsense, it produces a different real printing of a different real
            // card — `0047` read as `0017` resolved confidently to the wrong one over the
            // corpus, and roughly one resolve in twelve is wrong that way. Appearance is the
            // better judge of *what card this is* and has to be able to outweigh a bad read.
            weight: 2.0,
            // And decisive about which printing of it. This is the only signal that can tell
            // one printing from another at all, so within a card it should simply win.
            member_weight: 20.0,
            kind: Evidence::Collector,
        }
    }

    /// A name read off the card.
    ///
    /// Worth several frames of appearance evidence, because it nearly is proof — and because
    /// it is expensive, so it runs rarely and has to carry its share when it does. A read that
    /// needed correcting is worth less than a clean one, so a misread cannot outrank a
    /// confident hash on its own.
    pub fn from_ocr(key: [u8; ID_LEN], member: [u8; ID_LEN], edits: u32) -> Observation {
        Observation {
            key,
            member,
            normalized: if edits == 0 { 0.0 } else { 0.06 },
            weight: if edits == 0 { 6.0 } else { 3.0 },
            // **Zero, and that is a fix rather than an omission.** Every printing of a card
            // shares its name, so the printing a name resolves to is whichever one the index
            // stored for it — an arbitrary choice being cast as a vote, and one strong enough
            // to fight the collector line, which actually knows.
            member_weight: 0.0,
            kind: Evidence::Name,
        }
    }
}

/// One accumulated candidate.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Standing {
    /// What evidence pooled on — the oracle id, when the caller groups by card.
    #[serde(serialize_with = "ser_id")]
    pub id: [u8; ID_LEN],
    /// The best-scoring member seen for this key: the printing to actually report.
    #[serde(serialize_with = "ser_id")]
    pub best_member: [u8; ID_LEN],
    /// Normalized distance of that best member, its single best frame.
    pub best_normalized: f32,
    pub evidence: f32,
    /// Share of all accumulated evidence, 0..1.
    pub share: f32,
    /// Frames in which this card appeared in the top-K at all.
    pub seen: u32,
}

fn ser_id<S: serde::Serializer>(id: &[u8; ID_LEN], s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&crate::index::format_uuid(id))
}

/// What the tracker believes after the frame it was just given.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Tracked {
    /// Standings by accumulated evidence, best first.
    pub standings: Vec<Standing>,
    /// True once the leader is stable enough to act on.
    ///
    /// **This is the field a caller should show, not the per-frame top-1.** It is what stops
    /// the readout flickering.
    pub committed: bool,
    /// Consecutive frames the current leader has led for.
    pub streak: u32,
    /// The leader's share of the two-way contest with its best rival, 0.5..1.0.
    ///
    /// This is the number to show and the number the commit turns on. [`Standing::share`] is
    /// still there for the standings list, where a fraction-of-total reads naturally.
    pub confidence: f32,
    /// Frames observed since the last reset.
    pub frames: u32,
    /// Consecutive frames with nothing usable in them — or, once decided, consecutive frames
    /// the decided card was not in.
    pub misses: u32,
    /// Which verdict `committed` was drawn by.
    pub rule: CommitRule,
    /// The bar the vote rule is counting toward, so the page can draw it.
    pub decide_at: f32,
    /// The leader's evidence over its best rival's. `None` when it is unopposed, which is
    /// not a lead of infinity but the absence of a contest.
    pub lead: Option<f32>,
    /// Decided under the vote rule and the tally no longer moves. Always false under the
    /// confidence rule.
    pub frozen: bool,
}

impl Tracked {
    pub fn leader(&self) -> Option<&Standing> {
        self.standings.first()
    }
}

/// Accumulates per-frame candidates into a stable answer.
///
/// One tracker per scanning session. It holds no images and no locks; feeding it is a few
/// hash-map updates per frame.
#[derive(Debug)]
pub struct Tracker {
    opts: TrackerOptions,
    scores: HashMap<[u8; ID_LEN], f32>,
    seen: HashMap<[u8; ID_LEN], u32>,
    /// Per key, accumulated evidence per member — which *printing* of the card to report.
    ///
    /// **This used to be the single best frame each member ever had, and that was a ratchet.**
    /// It never decayed and never reverted, so one lucky frame for the wrong printing captured
    /// the slot permanently: `Gandalf, Spark Starter` came up correctly as HOB 203, one frame
    /// happened to favour HOB 97 by a bit or two, and it stayed on HOB 97 however many frames
    /// afterwards preferred the right one.
    ///
    /// The card's identity had already been given decay and hysteresis for exactly this
    /// reason; the printing had neither, and reprints of one card differ by far less than two
    /// different cards do, so it needed them more rather than less.
    members: HashMap<[u8; ID_LEN], HashMap<[u8; ID_LEN], f32>>,
    /// Per key, the closest this card has ever come in a single frame.
    ///
    /// Reported, never decided on: it is what the panel shows as `best_distance`, and it
    /// answers "how good did this ever look", which is a question about the whole session
    /// rather than about the last second of it. Nothing in the commit rule reads it.
    best_n: HashMap<[u8; ID_LEN], f32>,
    leader: Option<[u8; ID_LEN]>,
    streak: u32,
    frames: u32,
    misses: u32,
    /// Decided under the vote rule: the tally no longer moves. See the module doc.
    frozen: bool,
    /// Under a freeze, the other card the last frames have been naming instead of the decided
    /// one — a swap in progress, if it keeps naming the same one.
    other: Option<[u8; ID_LEN]>,
}

impl Default for Tracker {
    fn default() -> Self {
        Tracker::new(TrackerOptions::default())
    }
}

impl Tracker {
    pub fn new(opts: TrackerOptions) -> Self {
        Tracker {
            opts,
            scores: HashMap::new(),
            seen: HashMap::new(),
            members: HashMap::new(),
            best_n: HashMap::new(),
            leader: None,
            streak: 0,
            frames: 0,
            misses: 0,
            frozen: false,
            other: None,
        }
    }

    pub fn options(&self) -> &TrackerOptions {
        &self.opts
    }

    /// Replace the options and keep the tally.
    ///
    /// The page drives this on every frame, so the bar, the margin and the rule itself can
    /// be changed on a card being held still and the verdict answers at once. A freeze
    /// outlives only the verdict that produced it: raising the bar above a frozen tally, or
    /// switching to the confidence rule, puts the tracker back to gathering with everything
    /// it had. Lowering the bar under a frozen tally changes nothing — it was decided, and
    /// it still is.
    pub fn set_options(&mut self, opts: TrackerOptions) {
        self.opts = opts;
        if self.frozen {
            self.frozen = self.opts.rule == CommitRule::Votes && self.snapshot().committed;
        }
    }

    /// Was the last frame's verdict a commit?
    ///
    /// Lets an expensive tier stand down once the cheap one has settled the answer, without
    /// that tier having to keep its own copy of the commit rule.
    pub fn last_committed(&self) -> bool {
        self.snapshot().committed
    }

    /// Forget everything. The card was put down, or the reader asked for a fresh start.
    pub fn reset(&mut self) {
        self.scores.clear();
        self.seen.clear();
        self.members.clear();
        self.best_n.clear();
        self.leader = None;
        self.streak = 0;
        self.frames = 0;
        self.misses = 0;
        self.frozen = false;
        self.other = None;
    }

    /// Feed one frame's candidates where each id is its own group — no card grouping.
    ///
    /// Convenience for callers with no corpus to resolve an oracle id from.
    pub fn observe_ids(&mut self, candidates: &[([u8; ID_LEN], f32)]) -> Tracked {
        let obs: Vec<Observation> = candidates
            .iter()
            .map(|(id, n)| Observation::appearance(*id, *id, *n))
            .collect();
        self.observe(&obs)
    }

    /// Feed one frame's candidates as `(key, member, normalized distance)`, best first.
    ///
    /// An empty slice means the frame had no card, or nothing close enough to be evidence.
    pub fn observe(&mut self, candidates: &[Observation]) -> Tracked {
        self.frames += 1;

        let usable: Vec<_> = candidates
            .iter()
            .take(self.opts.top_k)
            .filter(|o| o.normalized < self.opts.max_normalized)
            .collect();
        let voting = self.opts.rule == CommitRule::Votes;

        // **Decided: nothing moves until the decided card is gone.** A frozen tally is what
        // makes a decision a decision — the frame is counted so the panel sees time pass, but
        // no vote lands and the leader cannot change. What ends it is the miss count reaching
        // `reset_after_misses`, and under a freeze a miss is a frame the decided card was not
        // in: an empty one, or one whose best usable candidate is some *other* card — the
        // same other card each time, because a foil's hash offers a different near-random
        // neighbour every frame and a churn of strangers is not a card being swapped in.
        //
        // A frame with candidates but nothing inside the gate is *not* a miss here, and that
        // is a measured fix rather than a nicety. Once a card is decided the server drops the
        // extra framings it no longer needs; a Plains that cleared the gate at 74 bits with
        // them matched at 84 without, so every frame after the decision counted as a miss and
        // at ten the decision reset itself with the card still locked in frame. A frozen
        // tally takes no evidence, so the gate has nothing to judge — the only question is
        // whether something is still in front of the lens.
        if self.frozen {
            let present = !candidates.is_empty();
            match usable.first().map(|o| o.key) {
                Some(k) if Some(k) == self.leader => {
                    self.misses = 0;
                    self.other = None;
                }
                Some(k) => {
                    if self.other == Some(k) {
                        self.misses += 1;
                    } else {
                        self.other = Some(k);
                        self.misses = 1;
                    }
                }
                None if present => {
                    self.misses = 0;
                    self.other = None;
                }
                None => self.misses += 1,
            }
            if self.misses < self.opts.reset_after_misses {
                return self.snapshot();
            }
            self.reset();
            if usable.is_empty() {
                return self.snapshot();
            }
            // The frame that ended the decision is the first of the next card's tally.
        }

        // **Only an informative frame decays the accumulator.** Decay models "older evidence
        // matters less than newer evidence" — but a frame that saw nothing is not newer
        // evidence, it is no evidence, and letting it decay makes committing depend on how
        // many frames get dropped rather than on what was seen. Measured: at one usable frame
        // in three, evidence saturates at 1.21 against a 1.5 threshold and the tracker can
        // never commit, however long you hold the card there. A card that has genuinely gone
        // is handled by `reset_after_misses`, which is the mechanism that should own it.
        //
        // Votes do not decay at all — see the module doc for why a bar and decay cannot share
        // an accumulator.
        if !usable.is_empty() && !voting {
            for v in self.scores.values_mut() {
                *v *= self.opts.decay;
            }
            // In lockstep with the card scores above: decaying one and not the other would
            // leave the printing weighted by history the card is no longer weighted by.
            for members in self.members.values_mut() {
                for v in members.values_mut() {
                    *v *= self.opts.decay;
                }
            }
        }

        if usable.is_empty() {
            self.misses += 1;
            if self.misses >= self.opts.reset_after_misses {
                self.reset();
                return self.snapshot();
            }
        } else {
            self.misses = 0;
            // The reference each candidate is weighed against: the best of *its own kind*
            // in this frame. See `Evidence` for what comparing across kinds did.
            let best_of_kind = |k: Evidence| {
                usable
                    .iter()
                    .filter(|o| o.kind == k)
                    .map(|o| o.normalized)
                    .fold(f32::INFINITY, f32::min)
            };
            let (best_app, best_name, best_col) = (
                best_of_kind(Evidence::Appearance),
                best_of_kind(Evidence::Name),
                best_of_kind(Evidence::Collector),
            );
            for o in usable {
                let best_n = match o.kind {
                    Evidence::Appearance => best_app,
                    Evidence::Name => best_name,
                    Evidence::Collector => best_col,
                };
                let (key, member, normalized) = (&o.key, &o.member, o.normalized);
                // Two factors. **Quality** is the candidate's own distance across the usable
                // range, so a frame where everything is mediocre contributes less than a frame
                // with a good match in it. **Relative** is how far behind the frame's best it
                // is, which is what stops a stable list of runners-up out-accumulating the
                // winner they consistently lose to.
                //
                // A vote keeps only the second. Quality made a vote worth a different amount
                // on every frame, so the bar was in no unit a reader could picture, and a far
                // but consistent card climbed to it several times slower than a close one —
                // the gate has already said its distance is usable, and consistency is what
                // the bar is counting.
                let quality = ((self.opts.max_normalized - normalized)
                    / self.opts.max_normalized)
                    .clamp(0.0, 1.0);
                let behind = (normalized - best_n).max(0.0);
                let relative = (-behind / self.opts.relative_falloff.max(1e-4)).exp();
                let base = if voting { relative } else { quality * relative };
                *self.scores.entry(*key).or_insert(0.0) += base * o.weight.max(0.0);
                *self.seen.entry(*key).or_insert(0) += 1;
                // The printing accumulates separately, on its own weight — see
                // `Observation::member_weight` for why one number cannot serve both.
                let mw = base * o.member_weight.max(0.0);
                if mw > 0.0 {
                    *self.members.entry(*key).or_default().entry(*member).or_insert(0.0) += mw;
                }
                let seen_best = self.best_n.entry(*key).or_insert(normalized);
                *seen_best = seen_best.min(normalized);
            }
            // Whatever is now negligible goes — decayed away under one rule, or a runner-up
            // ten falloff widths behind that entered at a millionth of a vote under the
            // other. Without this a long session without a reset grows the map by the churn.
            self.scores.retain(|_, v| *v > 0.001);
            for members in self.members.values_mut() {
                members.retain(|_, v| *v > 0.001);
            }
            self.members.retain(|_, m| !m.is_empty());
        }

        // The raw best, and then the *sticky* leader: an incumbent keeps the lead until a
        // challenger is clearly ahead, so one or two odd frames cannot swap the answer.
        let top = self
            .scores
            .iter()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(id, _)| *id);
        let held = self.leader.filter(|cur| self.scores.contains_key(cur));
        let next = match (held, top) {
            (Some(cur), Some(t)) if t != cur => {
                let (cur_ev, t_ev) = (self.scores[&cur], self.scores[&t]);
                if t_ev > cur_ev * self.opts.switch_margin.max(1.0) {
                    Some(t)
                } else {
                    Some(cur)
                }
            }
            (Some(cur), _) => Some(cur),
            (None, t) => t,
        };
        if next.is_some() && next == self.leader {
            self.streak += 1;
        } else {
            self.leader = next;
            self.streak = u32::from(next.is_some());
        }

        let mut verdict = self.snapshot();
        // The decision is the moment the vote rule is first satisfied; from here the tally is
        // frozen and `snapshot` keeps returning the same verdict because nothing it reads can
        // change. The deciding frame reports the freeze too, rather than one frame late. The
        // confidence rule never freezes — it is a belief, and it keeps revising.
        if voting && verdict.committed {
            self.frozen = true;
            verdict.frozen = true;
        }
        verdict
    }

    fn snapshot(&self) -> Tracked {
        let total: f32 = self.scores.values().sum();
        let mut standings: Vec<Standing> = self
            .scores
            .iter()
            .map(|(id, evidence)| {
                let member = self
                    .members
                    .get(id)
                    .and_then(|m| {
                        m.iter()
                            .max_by(|a, b| {
                                a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal)
                            })
                            .map(|(k, _)| *k)
                    })
                    .unwrap_or(*id);
                let best_n = self.best_n.get(id).copied().unwrap_or(1.0);
                Standing {
                    id: *id,
                    best_member: member,
                    best_normalized: best_n,
                    evidence: *evidence,
                    share: if total > 0.0 { evidence / total } else { 0.0 },
                    seen: self.seen.get(id).copied().unwrap_or(0),
                }
            })
            .collect();
        standings.sort_by(|a, b| {
            b.evidence.partial_cmp(&a.evidence).unwrap_or(std::cmp::Ordering::Equal)
        });
        // The held leader goes first even when it is fractionally behind on raw evidence —
        // otherwise the reported card and the top of the list would disagree, which is the
        // flicker showing through in a different place.
        if let Some(lead) = self.leader {
            if let Some(i) = standings.iter().position(|s| s.id == lead) {
                standings.swap(0, i);
            }
        }
        standings.truncate(6);

        // Leader against its single best rival. With no rival at all the leader is
        // unopposed, which is a confidence of 1 rather than an undefined ratio.
        let confidence = match (standings.first(), standings.get(1)) {
            (Some(first), Some(second)) => {
                let denom = first.evidence + second.evidence;
                if denom > 0.0 {
                    first.evidence / denom
                } else {
                    0.0
                }
            }
            (Some(_), None) => 1.0,
            _ => 0.0,
        };
        // The same contest as a ratio, which is what the vote rule's margin is stated in.
        let lead = match (standings.first(), standings.get(1)) {
            (Some(first), Some(second)) if second.evidence > 0.0 => {
                Some(first.evidence / second.evidence)
            }
            _ => None,
        };

        let committed = match self.opts.rule {
            CommitRule::Confidence => standings.first().is_some_and(|s| {
                confidence >= self.opts.commit_confidence
                    && s.seen >= self.opts.commit_seen
                    && self.streak >= self.opts.commit_streak
            }),
            // At the bar, and ahead of the rival by the margin. The leader here is the
            // *held* one, so a challenger that has just crossed the bar while the incumbent
            // still holds the lead decides nothing until it is clearly ahead — which is the
            // same hysteresis the reported leader already has.
            CommitRule::Votes => standings.first().is_some_and(|s| {
                s.evidence >= self.opts.decide_at
                    && lead.is_none_or(|l| l >= self.opts.lead_margin)
            }),
        };

        Tracked {
            standings,
            committed,
            confidence,
            streak: self.streak,
            frames: self.frames,
            misses: self.misses,
            rule: self.opts.rule,
            decide_at: self.opts.decide_at,
            lead,
            frozen: self.frozen,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u8) -> [u8; ID_LEN] {
        let mut b = [0u8; ID_LEN];
        b[0] = n;
        b
    }

    /// The original rule, which every test up to the vote section was written against.
    fn confidence() -> Tracker {
        Tracker::new(TrackerOptions { rule: CommitRule::Confidence, ..Default::default() })
    }

    /// The card in front of the lens, matched well every frame.
    fn good(n: u8) -> Vec<([u8; ID_LEN], f32)> {
        vec![(id(n), 0.16)]
    }

    #[test]
    fn a_consistent_card_commits_and_stays() {
        let mut t = confidence();
        let mut committed_at = None;
        for f in 1..=12 {
            let r = t.observe_ids(&good(1));
            if r.committed && committed_at.is_none() {
                committed_at = Some(f);
            }
        }
        let at = committed_at.expect("a consistently matched card must commit");
        assert!((3..=6).contains(&at), "committed at frame {at}, expected 3-6");

        let r = t.observe_ids(&good(1));
        assert!(r.committed);
        assert_eq!(r.leader().expect("leader").id, id(1));
        assert!(r.leader().expect("leader").share > 0.9);
    }

    #[test]
    fn one_good_frame_alone_never_commits() {
        // The guard against a single lucky frame: the count and the streak both have to build,
        // and a perfect distance cannot buy its way past either.
        let mut t = confidence();
        let r = t.observe_ids(&[(id(1), 0.02)]);
        assert!(!r.committed, "a single frame committed on its own");
    }

    #[test]
    fn a_weaker_but_consistent_match_can_still_commit() {
        // **The regression test for a gate that made success impossible.** With an absolute
        // evidence threshold, weight came from match quality and saturated at
        // `w / (1 - decay)`, so a correct match at 24.6% could never reach the bar however
        // long the card was held there — it led every frame with a 100% share and was refused.
        // 0.26 is comfortably inside `max_normalized` and comfortably below what the old gate
        // needed.
        let mut t = confidence();
        let mut r = None;
        for _ in 0..12 {
            r = Some(t.observe_ids(&[(id(1), 0.26)]));
        }
        let r = r.expect("frames");
        assert!(r.committed, "a consistent match at 26% never committed");
        assert_eq!(r.leader().expect("leader").id, id(1));
    }

    #[test]
    fn the_card_shown_most_wins_the_flicker() {
        // **The reported problem.** Rank 1 alternates between three cards; the real card is
        // top on three frames in five, the impostors on one each. Every frame is a plausible
        // match, so no single frame settles it.
        let mut t = confidence();
        let mut r = None;
        for cycle in 0..5 {
            for step in 0..5 {
                let frame = match step {
                    0 => vec![(id(9), 0.19), (id(1), 0.20)], // an impostor edges it
                    1 => vec![(id(8), 0.19), (id(1), 0.20)], // a different impostor
                    _ => vec![(id(1), 0.18), (id(9), 0.21)], // the real card
                };
                r = Some(t.observe_ids(&frame));
            }
            let _ = cycle;
        }
        let r = r.expect("frames were observed");
        assert_eq!(r.leader().expect("leader").id, id(1), "the most-seen card must win");
        assert!(r.committed, "a 3-in-5 majority over 25 frames should commit");
    }

    #[test]
    fn a_consistent_runner_up_beats_a_parade_of_one_off_winners() {
        // The reason weight comes from distance rather than from rank.
        //
        // **The previous fixture here did not test its own name.** It gave card 1 a distance
        // of 0.10 against the impostor's 0.27, which made card 1 the frame's *best* candidate
        // every time — so it proved only that the best candidate wins. Card 1 is now a genuine
        // close second, losing every single frame to a different impostor, and still has to
        // win on consistency.
        let mut t = confidence();
        let mut r = None;
        for k in 0..20u8 {
            r = Some(t.observe_ids(&[(id(20 + k), 0.10), (id(1), 0.12)]));
        }
        let r = r.expect("frames were observed");
        assert_eq!(
            r.leader().expect("leader").id,
            id(1),
            "a card that is second on every frame must beat twenty one-off winners"
        );
    }

    #[test]
    fn a_stable_list_of_runners_up_does_not_outvote_the_winner() {
        // **The measured failure.** A Took Reaper held in frame was top on every frame at
        // 21.5%, with four runners-up at 25-26% that were the *same* four every frame. Under
        // purely absolute weighting they accumulated as consistently as the winner did and
        // together outweighed it: 30% share after 53 frames, against a 45% bar, so it could
        // never commit. The premise that wrong answers are random and wash out is false for a
        // card held still.
        let mut t = confidence();
        let frame = [
            Observation::appearance(id(1), id(1), 0.215),
            Observation::appearance(id(2), id(2), 0.250),
            Observation::appearance(id(3), id(3), 0.254),
            Observation::appearance(id(4), id(4), 0.258),
            Observation::appearance(id(5), id(5), 0.262),
        ];
        let mut r = None;
        for _ in 0..20 {
            r = Some(t.observe(&frame));
        }
        let r = r.expect("frames were observed");
        let lead = r.leader().expect("leader");
        assert_eq!(lead.id, id(1));
        assert!(
            lead.share > 0.6,
            "the winner held only {:.0}% against its four stable runners-up",
            lead.share * 100.0
        );
        assert!(r.committed, "a card that is top on every frame must commit");
    }

    #[test]
    fn noise_beyond_the_threshold_is_not_evidence() {
        // Everything is past the usable distance, so nothing should accumulate and the
        // tracker must never claim a result.
        let mut t = confidence();
        let mut r = None;
        for _ in 0..15 {
            r = Some(t.observe_ids(&[(id(1), 0.34), (id(2), 0.36)]));
        }
        let r = r.expect("frames were observed");
        assert!(!r.committed);
        assert!(r.standings.is_empty(), "noise accumulated into standings");
    }

    #[test]
    fn an_empty_run_resets_the_accumulator() {
        // The card was taken away. After `reset_after_misses` blank frames the tracker must
        // forget it, or the next card is judged against the last one's evidence.
        let mut t = confidence();
        for _ in 0..10 {
            t.observe_ids(&good(1));
        }
        assert!(t.observe_ids(&good(1)).committed);

        let mut r = None;
        for _ in 0..10 {
            r = Some(t.observe_ids(&[]));
        }
        let r = r.expect("frames were observed");
        assert!(!r.committed);
        assert_eq!(r.frames, 0, "a reset restarts the frame count");
        assert!(r.standings.is_empty());
    }

    #[test]
    fn a_new_card_takes_over_within_the_decay_window() {
        // Swapping cards must not require a manual reset, and must not take long. The old
        // card's evidence decays while the new one's builds.
        let mut t = confidence();
        for _ in 0..15 {
            t.observe_ids(&good(1));
        }
        assert_eq!(t.observe_ids(&good(1)).leader().expect("leader").id, id(1));

        let mut took = None;
        for f in 1..=20 {
            let r = t.observe_ids(&good(2));
            if r.leader().is_some_and(|s| s.id == id(2)) && r.committed {
                took = Some(f);
                break;
            }
        }
        let f = took.expect("the new card never took over");
        assert!(f <= 15, "took {f} frames to switch cards, expected under 15");
    }

    #[test]
    fn dropped_frames_do_not_break_it() {
        // The live view drops frames by design, so evidence has to survive an irregular feed.
        // Interleaving blank frames below the reset threshold must still reach a commit.
        let mut t = confidence();
        let mut r = None;
        for _ in 0..12 {
            t.observe_ids(&good(1));
            t.observe_ids(&[]);
            r = Some(t.observe_ids(&[]));
        }
        assert!(r.expect("frames").committed, "an intermittent feed never committed");
    }

    #[test]
    fn reprints_pool_their_evidence_under_one_card() {
        // **The measured failure this grouping exists for.** Replaying four photographs of
        // Esquire of the King, the right card led every frame and never committed: its
        // evidence was split across its own reprints, so no single printing crossed the bar.
        //
        // Same card (key 1), three different printings (members 20/21/22), rotating.
        let mut t = confidence();
        let mut r = None;
        for i in 0..12u8 {
            let member = id(20 + (i % 3));
            r = Some(t.observe(&[Observation::appearance(id(1), member, 0.16)]));
        }
        let r = r.expect("frames were observed");
        assert!(r.committed, "reprints of one card must pool their evidence");
        let lead = r.leader().expect("leader");
        assert_eq!(lead.id, id(1));
        assert!(lead.share > 0.9, "share was {} across one card's reprints", lead.share);

        // And the printing reported is the one the frames keep choosing, not the most recent.
        let mut t = confidence();
        t.observe(&[Observation::appearance(id(1), id(20), 0.10)]);
        t.observe(&[Observation::appearance(id(1), id(21), 0.10)]);
        t.observe(&[Observation::appearance(id(1), id(20), 0.10)]);
        let r = t.observe(&[Observation::appearance(id(1), id(20), 0.10)]);
        assert_eq!(r.leader().expect("leader").best_member, id(20));
    }

    #[test]
    fn appearance_still_counts_on_a_frame_that_also_read_the_card() {
        // The reported worry, made checkable: does a hash match still add to the vote when an
        // OCR tier fires on the same frame, or is it annihilated?
        //
        // Card 1 is what the collector line says. Card 2 is what the hash says, at a perfectly
        // ordinary 0.15. Nothing here is asking the hash to *win* — the read is much stronger
        // evidence and should lead — only that thirty frames of a consistent appearance match
        // leave a mark at all.
        let mut t = confidence();
        let mut r = None;
        for _ in 0..30 {
            r = Some(t.observe(&[
                Observation::from_collector(id(1), id(1)),
                Observation::appearance(id(2), id(2), 0.15),
            ]));
        }
        let r = r.expect("frames were observed");
        let ev = |n: u8| {
            r.standings.iter().find(|s| s.id == id(n)).map(|s| s.evidence).unwrap_or(0.0)
        };
        assert!(ev(1) > ev(2), "the read should still lead: {} vs {}", ev(1), ev(2));
        assert!(
            ev(2) > ev(1) * 0.01,
            "thirty frames of appearance came to {:.4} against the read's {:.2} — the hash is \
             not contributing to the vote at all",
            ev(2),
            ev(1)
        );
    }

    #[test]
    fn a_misread_number_does_not_overrule_what_the_card_looks_like() {
        // **A digit read wrong does not produce nonsense — it produces a different real
        // card.** `0047` came back as `0017` over the corpus and resolved, confidently, to a
        // card that exists and was not the one in frame. Roughly one collector resolve in
        // twelve is wrong that way, so the art has to be able to outweigh it.
        //
        // Here the hash says card 1 on every frame and the collector line says card 2 on every
        // fourth. The art should still win.
        let mut t = confidence();
        let mut r = None;
        for i in 0..24u32 {
            let mut obs = vec![Observation::appearance(id(1), id(1), 0.12)];
            if i % 4 == 0 {
                obs.insert(0, Observation::from_collector(id(2), id(2)));
            }
            r = Some(t.observe(&obs));
        }
        let r = r.expect("frames were observed");
        assert_eq!(
            r.leader().expect("leader").id,
            id(1),
            "a number misread on one frame in four overruled a consistent appearance match"
        );
    }

    #[test]
    fn the_number_settles_the_printing_the_art_settles_the_card() {
        // The division of labour the two tiers are actually good for. Appearance sees card 1
        // and guesses printing 10 for it; the collector line agrees on the card and names
        // printing 11. The card is never in doubt, and the printing should be the one the
        // number gave, not the one the hash guessed — nothing else can tell two printings of
        // one card apart.
        let mut t = confidence();
        let mut r = None;
        for i in 0..24u32 {
            let mut obs = vec![Observation::appearance(id(1), id(10), 0.12)];
            if i % 4 == 0 {
                obs.insert(0, Observation::from_collector(id(1), id(11)));
            }
            r = Some(t.observe(&obs));
        }
        let r = r.expect("frames were observed");
        let lead = r.leader().expect("leader");
        assert_eq!(lead.id, id(1), "the card was never in question");
        assert_eq!(
            lead.best_member,
            id(11),
            "the printing came from the hash's guess rather than from the number that knows"
        );
    }

    #[test]
    fn a_read_name_does_not_vote_for_an_arbitrary_printing() {
        // Every printing of a card shares its name, so the one a name resolves to is whichever
        // the index happened to store. Letting that cast a vote put an arbitrary choice up
        // against the collector line, which actually knows — so a name carries the card and
        // abstains on the printing.
        let mut t = confidence();
        let mut r = None;
        for _ in 0..12 {
            r = Some(t.observe(&[
                Observation::from_ocr(id(1), id(10), 0),
                Observation::appearance(id(1), id(11), 0.12),
            ]));
        }
        let lead = r.expect("frames were observed");
        let lead = lead.leader().expect("leader");
        assert_eq!(lead.id, id(1));
        assert_eq!(
            lead.best_member,
            id(11),
            "the name's representative printing outvoted the one the hash actually matched"
        );
    }

    #[test]
    fn one_lucky_frame_does_not_capture_the_printing() {
        // **Reported live: `Gandalf, Spark Starter` came up as HOB 203, correctly, and then
        // switched to HOB 97 and stayed there.** The printing was whichever member had ever
        // had the single lowest-distance frame, which never decayed and never reverted — so a
        // single frame favouring the wrong reprint by a bit or two captured it for good.
        //
        // Here member 21 gets one excellent frame and member 20 gets fifteen ordinary ones.
        // The card is the same either way; the printing reported must be the one the evidence
        // actually supports.
        let mut t = confidence();
        t.observe(&[Observation::appearance(id(1), id(21), 0.02)]);
        let mut r = None;
        for _ in 0..15 {
            r = Some(t.observe(&[Observation::appearance(id(1), id(20), 0.12)]));
        }
        let r = r.expect("frames were observed");
        let lead = r.leader().expect("leader");
        assert_eq!(lead.id, id(1), "the card itself was never in doubt");
        assert_eq!(
            lead.best_member,
            id(20),
            "one lucky frame held the printing against fifteen that disagreed"
        );
        // And the distance shown is still the best ever seen, which is what it claims to be.
        assert!(
            (lead.best_normalized - 0.02).abs() < 1e-6,
            "best_normalized was {}, not the best frame's 0.02",
            lead.best_normalized
        );
    }

    #[test]
    fn ungrouped_ids_still_split_as_they_should() {
        // The convenience API must not silently group: two genuinely different cards are two
        // contenders, and neither should inherit the other's evidence.
        let mut t = confidence();
        let mut r = None;
        for _ in 0..10 {
            r = Some(t.observe_ids(&[(id(1), 0.16), (id(2), 0.16)]));
        }
        let r = r.expect("frames");
        assert_eq!(r.standings.len(), 2);
        assert!((r.standings[0].share - 0.5).abs() < 0.05, "evidence should be even");
    }

    #[test]
    fn churning_runners_up_do_not_dilute_a_consistent_leader() {
        // **The reported problem.** A Mountain was correctly first on every frame and still
        // read as 40-60% certain: each frame brought a *different* set of weak runners-up, and
        // every one of them added to the denominator of a fraction-of-total share. The
        // alternatives changing is evidence the leader is right, and it was being counted as
        // though it were evidence against.
        let mut t = confidence();
        let mut r = None;
        for f in 0..24u8 {
            // The same leader every frame; three rivals that are never seen twice.
            r = Some(t.observe_ids(&[
                (id(1), 0.17),
                (id(50 + f * 3), 0.25),
                (id(51 + f * 3), 0.26),
                (id(52 + f * 3), 0.27),
            ]));
        }
        let r = r.expect("frames were observed");
        assert_eq!(r.leader().expect("leader").id, id(1));
        assert!(
            r.confidence > 0.85,
            "a leader with only transient rivals read as {:.0}% confident",
            r.confidence * 100.0
        );
        assert!(r.committed, "a consistently first card with churning rivals must commit");
    }

    #[test]
    fn a_genuine_two_way_contest_still_refuses_to_commit() {
        // The other side of the same coin: two cards that are both consistently strong are a
        // real ambiguity, and no amount of holding still should resolve it into a claim.
        let mut t = confidence();
        let mut r = None;
        for _ in 0..24 {
            r = Some(t.observe_ids(&[(id(1), 0.180), (id(2), 0.181)]));
        }
        let r = r.expect("frames were observed");
        assert!(
            r.confidence < 0.70,
            "two near-identical candidates read as {:.0}% confident",
            r.confidence * 100.0
        );
        assert!(!r.committed, "a real tie must not commit");
    }

    #[test]
    fn an_unopposed_leader_is_fully_confident() {
        let mut t = confidence();
        let mut r = None;
        for _ in 0..8 {
            r = Some(t.observe_ids(&[(id(1), 0.15)]));
        }
        let r = r.expect("frames");
        assert_eq!(r.confidence, 1.0);
        assert!(r.committed);
    }

    #[test]
    fn a_stray_frame_or_two_does_not_take_the_lead() {
        // **"Do not flip between cards if there is just one or two frames of a different
        // card."** The top two on a difficult card are routinely a bit or two apart, so
        // without hysteresis the reported answer changed on a single noisy frame while the
        // accumulated evidence had barely moved.
        let mut t = confidence();
        for _ in 0..14 {
            t.observe_ids(&[(id(1), 0.17)]);
        }
        assert_eq!(t.observe_ids(&[(id(1), 0.17)]).leader().expect("leader").id, id(1));

        // Two frames where an impostor is the only candidate, and better than the incumbent
        // ever was. It must not take the lead on that alone.
        t.observe_ids(&[(id(2), 0.05)]);
        let r = t.observe_ids(&[(id(2), 0.05)]);
        assert_eq!(
            r.leader().expect("leader").id,
            id(1),
            "two frames of another card took the lead"
        );

        // Sustained, it should — hysteresis delays a switch, it does not prevent one.
        let mut took = None;
        for f in 1..=30 {
            if t.observe_ids(&[(id(2), 0.05)]).leader().expect("leader").id == id(2) {
                took = Some(f);
                break;
            }
        }
        assert!(took.is_some_and(|f| f <= 20), "a real change never took over: {took:?}");
    }

    #[test]
    fn a_read_name_outweighs_a_parade_of_appearance_guesses() {
        // **The measured live failure.** On a foil the hash offered a different near-random
        // neighbour every frame at 55-66 bits, while OCR read the title correctly every time
        // it ran — but it ran on one frame in five and counted the same as a guess, so the
        // guesses out-accumulated it and the tracker committed to the wrong card.
        let mut t = confidence();
        let mut r = None;
        for f in 0..30u8 {
            let mut obs = vec![
                // A persistent wrong neighbour, plus churn, on every frame.
                Observation::appearance(id(2), id(2), 0.23),
                Observation::appearance(id(60 + f), id(60 + f), 0.24),
            ];
            // The read lands on one frame in five and is the only thing that is ever right.
            if f % 5 == 0 {
                obs.insert(0, Observation::from_ocr(id(1), id(1), 0));
            }
            r = Some(t.observe(&obs));
        }
        let r = r.expect("frames");
        assert_eq!(
            r.leader().expect("leader").id,
            id(1),
            "a name read off the card lost to appearance guesses"
        );
        assert!(r.committed, "the read should carry it to a commit");
    }

    #[test]
    fn a_misread_does_not_outrank_a_confident_hash() {
        // The other side: a read that needed correcting is worth less, so OCR guessing wrong
        // cannot bulldoze a hash that is sure.
        let clean = Observation::from_ocr(id(1), id(1), 0);
        let corrected = Observation::from_ocr(id(1), id(1), 2);
        assert!(corrected.weight < clean.weight);
        assert!(corrected.normalized > clean.normalized);
        assert!(corrected.weight > Observation::appearance(id(2), id(2), 0.2).weight);
    }

    #[test]
    fn reset_clears_everything() {
        let mut t = confidence();
        for _ in 0..10 {
            t.observe_ids(&good(1));
        }
        t.reset();
        let r = t.observe_ids(&[]);
        assert!(r.standings.is_empty());
        assert_eq!(r.frames, 1);
        assert_eq!(r.streak, 0);
    }

    // ---- The vote rule -------------------------------------------------------------------

    /// The default: votes toward a bar of 8, a lead of 1.3 over the best rival.
    fn voting() -> Tracker {
        Tracker::new(TrackerOptions { rule: CommitRule::Votes, ..Default::default() })
    }

    fn votes_of(r: &Tracked, n: u8) -> f32 {
        r.standings.iter().find(|s| s.id == id(n)).map(|s| s.evidence).unwrap_or(0.0)
    }

    #[test]
    fn the_default_rule_is_votes() {
        assert_eq!(TrackerOptions::default().rule, CommitRule::Votes);
        assert_eq!(Tracker::default().options().rule, CommitRule::Votes);
    }

    #[test]
    fn a_consistent_card_decides_exactly_at_the_bar() {
        // One clean appearance frame is one vote, so a bar of 8 is eight frames: not decided
        // on the seventh, decided on the eighth, and frozen from then on.
        let mut t = voting();
        for f in 1..=7 {
            let r = t.observe_ids(&good(1));
            assert!(!r.committed, "decided early, at frame {f}");
            assert!(!r.frozen);
        }
        let r = t.observe_ids(&good(1));
        assert!(r.committed, "eight clean frames did not reach a bar of 8");
        assert!(r.frozen);
        assert_eq!(r.rule, CommitRule::Votes);
        assert!((r.decide_at - 8.0).abs() < 1e-6);
        assert!((votes_of(&r, 1) - 8.0).abs() < 1e-4, "votes were {}", votes_of(&r, 1));
        assert_eq!(r.lead, None, "an unopposed leader has no rival to lead");
    }

    #[test]
    fn a_far_but_consistent_card_reaches_the_bar_as_fast_as_a_close_one() {
        // **The regression the old absolute threshold had, made impossible by construction.**
        // Under decay, evidence saturated at `w / (1 - decay)` scaled by match quality, so a
        // correct card matching at 26% could never reach the bar however long it was held
        // there. A vote is worth the same whatever its distance inside the gate, and nothing
        // decays, so eight frames at 26% decide exactly when eight frames at 16% do.
        let mut close = voting();
        let mut far = voting();
        let mut at = (None, None);
        for f in 1..=12 {
            if close.observe_ids(&[(id(1), 0.16)]).committed && at.0.is_none() {
                at.0 = Some(f);
            }
            if far.observe_ids(&[(id(1), 0.26)]).committed && at.1.is_none() {
                at.1 = Some(f);
            }
        }
        assert_eq!(at, (Some(8), Some(8)), "(close, far) decided at");
    }

    #[test]
    fn a_read_name_is_worth_six_frames_and_a_corrected_one_three() {
        // The tier weights are unchanged: a clean read is six votes, a corrected one three, a
        // collector line two. So a clean read plus two frames crosses a bar of 8.
        let mut t = voting();
        let r = t.observe(&[Observation::from_ocr(id(1), id(1), 0)]);
        assert!((votes_of(&r, 1) - 6.0).abs() < 1e-4);
        assert!(!r.committed, "a single read decided on its own against a bar of 8");
        t.observe_ids(&good(1));
        let r = t.observe_ids(&good(1));
        assert!(r.committed, "a read plus two frames did not reach 8");

        let mut t = voting();
        let r = t.observe(&[Observation::from_ocr(id(1), id(1), 2)]);
        assert!((votes_of(&r, 1) - 3.0).abs() < 1e-4);
        let mut t = voting();
        let r = t.observe(&[Observation::from_collector(id(1), id(1))]);
        assert!((votes_of(&r, 1) - 2.0).abs() < 1e-4);
    }

    #[test]
    fn a_dead_heat_refuses_at_the_default_margin_and_decides_at_one() {
        // Two candidates a bit apart on every frame. The runner-up is scaled by the relative
        // falloff, so it gathers a little less than the leader and the lead settles near 1.07
        // — under the default 1.3 that is a refusal however long the card is held. Dragged to
        // 1.0, first past the post decides it at the bar.
        let frame = [(id(1), 0.180), (id(2), 0.181)];
        let mut t = voting();
        let mut r = None;
        for _ in 0..30 {
            r = Some(t.observe_ids(&frame));
        }
        let r = r.expect("frames");
        assert!(!r.committed, "a dead heat decided under a 1.3 margin");
        let lead = r.lead.expect("two candidates have a lead");
        assert!((1.0..1.3).contains(&lead), "lead was {lead}");
        assert!(votes_of(&r, 1) >= 8.0, "the bar was reached, so the margin is what refused");

        let mut t = Tracker::new(TrackerOptions { lead_margin: 1.0, ..Default::default() });
        let mut at = None;
        for f in 1..=30 {
            if t.observe_ids(&frame).committed {
                at = Some(f);
                break;
            }
        }
        assert_eq!(at, Some(8), "first past the post should decide at the bar");
    }

    #[test]
    fn a_decision_freezes_the_tally() {
        // Once decided, later frames move nothing: a different card, better than the decided
        // one ever was, appears in nine frames and neither enters the standings nor unseats
        // the answer. The frame count still advances, so the panel can see time passing, and
        // the miss count says how long the decided card has been out of sight.
        let mut t = voting();
        for _ in 0..8 {
            t.observe_ids(&good(1));
        }
        let mut r = None;
        for _ in 0..9 {
            r = Some(t.observe_ids(&[(id(2), 0.05)]));
        }
        let r = r.expect("frames");
        assert!(r.committed && r.frozen);
        assert_eq!(r.leader().expect("leader").id, id(1));
        assert!((votes_of(&r, 1) - 8.0).abs() < 1e-4, "the frozen tally moved");
        assert_eq!(votes_of(&r, 2), 0.0, "a frame after the decision was counted");
        assert_eq!(r.frames, 17);
        assert_eq!(r.misses, 9, "nine frames of another card are nine without this one");

        // The decided card coming back clears the count.
        let r = t.observe_ids(&good(1));
        assert!(r.frozen);
        assert_eq!(r.misses, 0);
    }

    #[test]
    fn a_decided_card_matched_past_the_gate_has_not_left() {
        // **Measured on the debug server.** Once a card is decided the server drops the extra
        // framings it no longer needs, and a Plains that cleared the gate at 74 bits with them
        // matched at 84 without — past the gate, so every frame after the decision counted as
        // a miss, at ten the decision reset itself with the card still locked in frame, and
        // it then re-voted, re-decided and did it again. A frozen tally takes no evidence, so
        // the gate has nothing to judge; the only question is whether something is still in
        // front of the lens, and a frame that produced candidates at all answers yes.
        let mut t = voting();
        for _ in 0..8 {
            t.observe_ids(&good(1));
        }
        let mut r = None;
        for _ in 0..30 {
            r = Some(t.observe_ids(&[(id(1), 0.33), (id(7), 0.35)]));
        }
        let r = r.expect("frames");
        assert!(r.committed && r.frozen, "a decided card matched past the gate was counted as gone");
        assert_eq!(r.misses, 0);
        // An empty frame is still a miss.
        assert_eq!(t.observe_ids(&[]).misses, 1);
    }

    #[test]
    fn a_different_card_held_steady_ends_the_decision() {
        // **The swap.** A reader decides one card and slides the next in under the lens, and
        // the lock drops for a few frames while it re-acquires — never the ten empty frames
        // that mean "gone". If only emptiness could end a freeze, the old decision would sit
        // there until the reset button. The same ten frames of a *consistent* other card end
        // it instead, and the frame that ends it is the first of the new card's tally.
        let mut t = voting();
        for _ in 0..8 {
            t.observe_ids(&good(1));
        }
        for _ in 0..3 {
            assert!(t.observe_ids(&[]).frozen);
        }
        let mut ended = None;
        for f in 1..=20 {
            let r = t.observe_ids(&good(2));
            if !r.frozen {
                ended = Some((f, r));
                break;
            }
        }
        let (f, r) = ended.expect("the old decision never gave way to the new card");
        assert!(f <= 10, "the swap took {f} frames of the new card");
        assert!(r.standings.iter().all(|s| s.id != id(1)), "the old card's tally survived");
        assert!((votes_of(&r, 2) - 1.0).abs() < 1e-4, "the ending frame was not counted");
        let mut decided = None;
        for f in 1..=12 {
            if t.observe_ids(&good(2)).committed {
                decided = Some(f);
                break;
            }
        }
        assert_eq!(decided, Some(7), "the new card should decide on its own eight frames");
    }

    #[test]
    fn a_parade_of_different_neighbours_does_not_end_a_decision() {
        // The other side of the swap rule, and the reason it asks for a *consistent* other
        // card. On a foil the hash offers a different near-random neighbour every frame; the
        // decision came from a read name, and after it the read stands down. If any other
        // card counted, ten such frames would end every foil's decision a second after it was
        // made.
        let mut t = voting();
        t.observe(&[Observation::from_ocr(id(1), id(1), 0)]);
        t.observe_ids(&good(1));
        assert!(t.observe_ids(&good(1)).frozen);
        let mut r = None;
        for f in 0..40u8 {
            r = Some(t.observe_ids(&[(id(60 + f), 0.23)]));
        }
        let r = r.expect("frames");
        assert!(r.committed && r.frozen, "churning neighbours ended a decision");
        assert!(r.misses < 10);
    }

    #[test]
    fn the_card_leaving_lifts_the_freeze() {
        // The decided card goes away; after `reset_after_misses` empty frames the tracker
        // forgets it and the next card is judged on its own.
        let mut t = voting();
        for _ in 0..8 {
            t.observe_ids(&good(1));
        }
        assert!(t.observe_ids(&good(1)).frozen);
        let mut r = None;
        for _ in 0..10 {
            r = Some(t.observe_ids(&[]));
        }
        let r = r.expect("frames");
        assert!(!r.committed && !r.frozen);
        assert!(r.standings.is_empty());

        let mut at = None;
        for f in 1..=12 {
            if t.observe_ids(&good(2)).committed {
                at = Some(f);
                break;
            }
        }
        assert_eq!(at, Some(8));
    }

    #[test]
    fn the_reset_button_clears_a_decision() {
        let mut t = voting();
        for _ in 0..8 {
            t.observe_ids(&good(1));
        }
        t.reset();
        let r = t.observe_ids(&[]);
        assert!(!r.committed && !r.frozen);
        assert!(r.standings.is_empty());
    }

    #[test]
    fn raising_the_bar_lifts_the_freeze_and_keeps_the_tally() {
        // A slider drag has to show immediately. Decided at 8 and raised to 12, the verdict
        // goes back to voting with its eight votes intact, and four more frames decide it
        // again. Lowering the bar under a frozen tally leaves it decided.
        let mut t = voting();
        for _ in 0..8 {
            t.observe_ids(&good(1));
        }
        t.set_options(TrackerOptions { decide_at: 12.0, ..Default::default() });
        let r = t.observe_ids(&good(1));
        assert!(!r.committed && !r.frozen, "raising the bar left it decided");
        assert!((votes_of(&r, 1) - 9.0).abs() < 1e-4, "the tally did not survive set_options");
        t.observe_ids(&good(1));
        t.observe_ids(&good(1));
        let r = t.observe_ids(&good(1));
        assert!(r.committed && r.frozen, "twelve votes did not reach a bar of 12");

        t.set_options(TrackerOptions { decide_at: 4.0, ..Default::default() });
        let r = t.observe_ids(&good(1));
        assert!(r.committed && r.frozen, "lowering the bar undid a decision");
        assert!((votes_of(&r, 1) - 12.0).abs() < 1e-4);
    }

    #[test]
    fn switching_rules_keeps_the_tally_and_lifts_the_freeze() {
        // The two rules are the same accumulator with a different verdict, so the page can
        // flip between them on one held card. Only the vote rule freezes.
        let mut t = voting();
        for _ in 0..8 {
            t.observe_ids(&good(1));
        }
        t.set_options(TrackerOptions { rule: CommitRule::Confidence, ..Default::default() });
        let r = t.observe_ids(&good(1));
        assert_eq!(r.rule, CommitRule::Confidence);
        assert!(!r.frozen, "the confidence rule never freezes");
        // Decayed by one frame now that decay applies again, so a little under the eight it
        // had — a cleared tally would hold only this frame's half-vote.
        assert!(votes_of(&r, 1) > 5.0, "the tally was cleared by a rule change");
    }

    #[test]
    fn a_stable_list_of_runners_up_still_loses_under_votes() {
        // The Took Reaper fixture again: four stable runners-up three or four bits behind.
        // The relative falloff scales each to about a tenth of a vote, so the leader's lead is
        // near ten and it decides at the bar.
        let mut t = voting();
        let frame = [
            Observation::appearance(id(1), id(1), 0.215),
            Observation::appearance(id(2), id(2), 0.250),
            Observation::appearance(id(3), id(3), 0.254),
            Observation::appearance(id(4), id(4), 0.258),
            Observation::appearance(id(5), id(5), 0.262),
        ];
        let mut at = None;
        for f in 1..=20 {
            let r = t.observe(&frame);
            if r.committed {
                at = Some((f, r.lead));
                break;
            }
        }
        let (f, lead) = at.expect("the winner never decided");
        assert_eq!(f, 8);
        assert!(lead.is_some_and(|l| l > 5.0), "lead was {lead:?}");
    }

    #[test]
    fn dropped_frames_still_reach_the_bar_under_votes() {
        // Nothing decays, so two blank frames between every good one cost only time.
        let mut t = voting();
        let mut at = None;
        for f in 1..=12 {
            let r = t.observe_ids(&good(1));
            t.observe_ids(&[]);
            t.observe_ids(&[]);
            if r.committed {
                at = Some(f);
                break;
            }
        }
        assert_eq!(at, Some(8));
    }

    #[test]
    fn the_number_settles_the_printing_under_votes_too() {
        // The printing accumulates on the member weight, scaled the same way the card is.
        // Appearance names printing 10 on every frame; the collector line names 11 on every
        // fourth, at twenty times the member weight, so 11 is the printing reported when the
        // card decides.
        let mut t = voting();
        let mut r = None;
        for i in 0..8u32 {
            let mut obs = vec![Observation::appearance(id(1), id(10), 0.12)];
            if i % 4 == 0 {
                obs.insert(0, Observation::from_collector(id(1), id(11)));
            }
            r = Some(t.observe(&obs));
        }
        let r = r.expect("frames");
        assert!(r.committed);
        let lead = r.leader().expect("leader");
        assert_eq!(lead.id, id(1));
        assert_eq!(lead.best_member, id(11));
    }
}
