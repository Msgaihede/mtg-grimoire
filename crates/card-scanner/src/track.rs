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
//! So every candidate in a frame's top-K contributes weight according to *its own* distance,
//! and the weights accumulate with exponential decay. A card that is consistently second at a
//! good distance beats one that is occasionally first at a bad one — which is exactly the
//! flicker case, and exactly what rank-counting gets wrong.
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
    /// 0.85 gives an effective memory of ~1/(1-0.85) ≈ 7 frames, which at the measured ~12
    /// detections a second is a little over half a second — long enough to average out a
    /// glare, short enough that swapping cards feels immediate.
    pub decay: f32,
    /// Candidates worse than this contribute nothing.
    ///
    /// Matches the measured trough between the two distance clusters. Beyond it a candidate
    /// is not weak evidence, it is noise, and letting noise accumulate is how a tracker
    /// commits confidently to nothing.
    pub max_normalized: f32,
    /// How much of the total accumulated evidence the leader must hold.
    pub commit_share: f32,
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
}

impl Default for TrackerOptions {
    fn default() -> Self {
        TrackerOptions {
            decay: 0.85,
            max_normalized: 0.30,
            commit_share: 0.45,
            commit_seen: 5,
            commit_streak: 3,
            reset_after_misses: 10,
            top_k: 5,
        }
    }
}

/// One observation from a frame: what to accumulate on, what it names, and how good it was.
pub type Observation = ([u8; ID_LEN], [u8; ID_LEN], f32);

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
    /// Per key, the best member seen and its distance.
    best: HashMap<[u8; ID_LEN], ([u8; ID_LEN], f32)>,
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
            best: HashMap::new(),
            leader: None,
            streak: 0,
            frames: 0,
            misses: 0,
        }
    }

    pub fn options(&self) -> &TrackerOptions {
        &self.opts
    }

    /// Forget everything. The card was put down, or the reader asked for a fresh start.
    pub fn reset(&mut self) {
        self.scores.clear();
        self.seen.clear();
        self.best.clear();
        self.leader = None;
        self.streak = 0;
        self.frames = 0;
        self.misses = 0;
    }

    /// Feed one frame's candidates where each id is its own group — no card grouping.
    ///
    /// Convenience for callers with no corpus to resolve an oracle id from.
    pub fn observe_ids(&mut self, candidates: &[([u8; ID_LEN], f32)]) -> Tracked {
        let obs: Vec<Observation> = candidates.iter().map(|(id, n)| (*id, *id, *n)).collect();
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
            .filter(|(_, _, n)| *n < self.opts.max_normalized)
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
        }

        if usable.is_empty() {
            self.misses += 1;
            if self.misses >= self.opts.reset_after_misses {
                self.reset();
                return self.snapshot();
            }
        } else {
            self.misses = 0;
            for (key, member, normalized) in usable {
                // Weight by the candidate's own distance, scaled to 0..1 across the usable
                // range. A candidate that is consistently second at a good distance therefore
                // outscores one that is occasionally first at a poor one.
                let w = ((self.opts.max_normalized - normalized) / self.opts.max_normalized)
                    .clamp(0.0, 1.0);
                *self.scores.entry(*key).or_insert(0.0) += w;
                *self.seen.entry(*key).or_insert(0) += 1;
                // The printing to report for this card is its single best frame, not its most
                // recent — a card held still gets many looks and one of them is the sharpest.
                let slot = self.best.entry(*key).or_insert((*member, *normalized));
                if *normalized < slot.1 {
                    *slot = (*member, *normalized);
                }
            }
        }

        // Leader streak, computed before the snapshot so the snapshot can report it.
        let top = self
            .scores
            .iter()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(id, _)| *id);
        if top.is_some() && top == self.leader {
            self.streak += 1;
        } else {
            self.leader = top;
            self.streak = u32::from(top.is_some());
        }

        self.snapshot()
    }

    fn snapshot(&self) -> Tracked {
        let total: f32 = self.scores.values().sum();
        let mut standings: Vec<Standing> = self
            .scores
            .iter()
            .map(|(id, evidence)| {
                let (member, best_n) = self.best.get(id).copied().unwrap_or((*id, 1.0));
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
        standings.truncate(6);

        let committed = standings.first().is_some_and(|s| {
            s.share >= self.opts.commit_share
                && s.seen >= self.opts.commit_seen
                && self.streak >= self.opts.commit_streak
        });

        Tracked {
            standings,
            committed,
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
    fn a_consistent_runner_up_beats_an_occasional_winner() {
        // The reason weight comes from distance rather than from rank. Card 1 is *never*
        // first, but it is always a close second; card 2..6 each win once at a worse
        // distance. Rank-counting would make card 1 lose 0-5.
        let mut t = Tracker::default();
        let mut r = None;
        for k in 2..=6u8 {
            for _ in 0..3 {
                r = Some(t.observe_ids(&[(id(k), 0.27), (id(1), 0.10)]));
            }
        }
        let r = r.expect("frames were observed");
        assert_eq!(
            r.leader().expect("leader").id,
            id(1),
            "a consistent close second must beat five one-off winners"
        );
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
            r = Some(t.observe_ids(&good(1)));
            r = Some(t.observe_ids(&[]));
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
            r = Some(t.observe(&[(id(1), member, 0.16)]));
        }
        let r = r.expect("frames were observed");
        assert!(r.committed, "reprints of one card must pool their evidence");
        let lead = r.leader().expect("leader");
        assert_eq!(lead.id, id(1));
        assert!(lead.share > 0.9, "share was {} across one card's reprints", lead.share);

        // And the printing reported is the best-scoring one, not the most recent.
        let mut t = Tracker::default();
        t.observe(&[(id(1), id(20), 0.25)]);
        t.observe(&[(id(1), id(21), 0.08)]);
        let r = t.observe(&[(id(1), id(22), 0.22)]);
        assert_eq!(r.leader().expect("leader").best_member, id(21));
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
