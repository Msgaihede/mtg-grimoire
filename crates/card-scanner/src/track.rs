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

use crate::index::ID_LEN;
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct TrackerOptions {
    /// Per-frame multiplier applied to all accumulated evidence.
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
    /// alone.
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
    /// Consecutive frames the leader must have led for.
    pub commit_streak: u32,
    /// Frames with nothing usable before the accumulator is cleared — the card has left.
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
}

impl Observation {
    /// An appearance match: a hash neighbour, worth one vote.
    pub fn appearance(key: [u8; ID_LEN], member: [u8; ID_LEN], normalized: f32) -> Observation {
        Observation { key, member, normalized, weight: 1.0 }
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
        Observation { key, member, normalized: 0.0, weight: 8.0 }
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
    /// Consecutive frames with nothing usable in them.
    pub misses: u32,
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
        }
    }

    pub fn options(&self) -> &TrackerOptions {
        &self.opts
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

        // **Only an informative frame decays the accumulator.** Decay models "older evidence
        // matters less than newer evidence" — but a frame that saw nothing is not newer
        // evidence, it is no evidence, and letting it decay makes committing depend on how
        // many frames get dropped rather than on what was seen. Measured: at one usable frame
        // in three, evidence saturates at 1.21 against a 1.5 threshold and the tracker can
        // never commit, however long you hold the card there. A card that has genuinely gone
        // is handled by `reset_after_misses`, which is the mechanism that should own it.
        if !usable.is_empty() {
            for v in self.scores.values_mut() {
                *v *= self.opts.decay;
            }
            self.scores.retain(|_, v| *v > 0.001);
            // In lockstep with the card scores above: decaying one and not the other would
            // leave the printing weighted by history the card is no longer weighted by.
            for members in self.members.values_mut() {
                for v in members.values_mut() {
                    *v *= self.opts.decay;
                }
                members.retain(|_, v| *v > 0.001);
            }
            self.members.retain(|_, m| !m.is_empty());
        }

        if usable.is_empty() {
            self.misses += 1;
            if self.misses >= self.opts.reset_after_misses {
                self.reset();
                return self.snapshot();
            }
        } else {
            self.misses = 0;
            // The frame's best distance is the reference every candidate is weighed against.
            let best_n = usable
                .iter()
                .map(|o| o.normalized)
                .fold(f32::INFINITY, f32::min);
            for o in usable {
                let (key, member, normalized) = (&o.key, &o.member, o.normalized);
                // Two factors. **Quality** is the candidate's own distance across the usable
                // range, so a frame where everything is mediocre contributes less than a frame
                // with a good match in it. **Relative** is how far behind the frame's best it
                // is, which is what stops a stable list of runners-up out-accumulating the
                // winner they consistently lose to.
                let quality = ((self.opts.max_normalized - normalized)
                    / self.opts.max_normalized)
                    .clamp(0.0, 1.0);
                let behind = (normalized - best_n).max(0.0);
                let relative = (-behind / self.opts.relative_falloff.max(1e-4)).exp();
                let w = quality * relative * o.weight.max(0.0);
                *self.scores.entry(*key).or_insert(0.0) += w;
                *self.seen.entry(*key).or_insert(0) += 1;
                // The printing accumulates on exactly the weight its card does, so the one
                // reported is the one the frames have actually kept choosing.
                *self.members.entry(*key).or_default().entry(*member).or_insert(0.0) += w;
                let seen_best = self.best_n.entry(*key).or_insert(normalized);
                *seen_best = seen_best.min(normalized);
            }
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

        self.snapshot()
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

        let committed = standings.first().is_some_and(|s| {
            confidence >= self.opts.commit_confidence
                && s.seen >= self.opts.commit_seen
                && self.streak >= self.opts.commit_streak
        });

        Tracked {
            standings,
            committed,
            confidence,
            streak: self.streak,
            frames: self.frames,
            misses: self.misses,
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

    /// The card in front of the lens, matched well every frame.
    fn good(n: u8) -> Vec<([u8; ID_LEN], f32)> {
        vec![(id(n), 0.16)]
    }

    #[test]
    fn a_consistent_card_commits_and_stays() {
        let mut t = Tracker::default();
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
        let mut t = Tracker::default();
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
        let mut t = Tracker::default();
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
        let mut t = Tracker::default();
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
        let mut t = Tracker::default();
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
        let mut t = Tracker::default();
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
        let mut t = Tracker::default();
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
        let mut t = Tracker::default();
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
        let mut t = Tracker::default();
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
        let mut t = Tracker::default();
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
        let mut t = Tracker::default();
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
        let mut t = Tracker::default();
        t.observe(&[Observation::appearance(id(1), id(20), 0.10)]);
        t.observe(&[Observation::appearance(id(1), id(21), 0.10)]);
        t.observe(&[Observation::appearance(id(1), id(20), 0.10)]);
        let r = t.observe(&[Observation::appearance(id(1), id(20), 0.10)]);
        assert_eq!(r.leader().expect("leader").best_member, id(20));
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
        let mut t = Tracker::default();
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
        let mut t = Tracker::default();
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
        let mut t = Tracker::default();
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
        let mut t = Tracker::default();
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
        let mut t = Tracker::default();
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
        let mut t = Tracker::default();
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
        let mut t = Tracker::default();
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
        let mut t = Tracker::default();
        for _ in 0..10 {
            t.observe_ids(&good(1));
        }
        t.reset();
        let r = t.observe_ids(&[]);
        assert!(r.standings.is_empty());
        assert_eq!(r.frames, 1);
        assert_eq!(r.streak, 0);
    }
}
