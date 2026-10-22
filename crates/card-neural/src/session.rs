//! Frames into a decision: quickdraw.cards' agreement rule, and when a decision is forgotten.
//!
//! From their `scanner-state.js` (`FrameConsensus`) as their `app.js` configures it for the
//! picture (`required: 2, supportRequired: 3`, `maxAge` 1 800 ms, `maxGap` 850 ms):
//!
//! - **Two accepted frames naming one card** decide it, or **three agreeing frames** when some
//!   are only *supported* (just under the accept bar on a confident detection).
//! - **An instant frame decides alone**: accepted with a high score, a wide margin and a sure
//!   detection.
//! - **Any other frame resets the count** — except a *weak* frame of the same card in the same
//!   place within the gap, which keeps the count without adding to it.
//! - A different card, or a gap longer than `max_gap`, starts the count again.
//!
//! The decision is the card — the look within it is the deciding frame's best. It stands until
//! another card is decided, **or until the card has been gone [`Rules::forget_after`] frames
//! running** — ours, not Quickdraw's: a reader who lifts a card and lays down another copy of it
//! is adding a second copy, and a decision that stood through the gap would add nothing.
//!
//! **Or until another look of it comes to rest** (#1359), also ours. A pile is scanned by laying
//! each card on the last, and a second printing of the decided card — another art, a Forest on
//! a Forest from another set — is the same card to the count, so it never decided and the reader
//! had to Reset or scan something else first. While a card is decided its votes are counted by
//! look: [`Rules::another_look`] accepted frames running that each tell their look apart from
//! the deciding frame's (neither is among the other's twins, [`crate::scanner::TWIN_GAP`])
//! decide that look, [`Decision::another_look`]. More frames than a card takes, because a held
//! card's best look can waver where its twins do not reach, and a change made in error adds a
//! row. Two copies of one look are still one decision — nothing about the second looks
//! different.

use crate::frame::{bounds_iou, Quad};
use crate::scanner::{Read, Scored};

#[derive(Clone, Debug)]
pub struct Rules {
    pub required: usize,
    pub support_required: usize,
    pub max_age_ms: f64,
    pub max_gap_ms: f64,
    /// Bounds IoU for "the same place" when a weak frame defers.
    pub same_place: f32,
    /// Frames running with no card in front of the lens ([`Read::present`]) that forget the
    /// standing decision.
    pub forget_after: u32,
    /// Accepted frames running, each naming another look of the decided card than the deciding
    /// frame's, that decide it: a second printing laid on the first.
    pub another_look: usize,
}

impl Default for Rules {
    fn default() -> Self {
        Self {
            required: 2,
            support_required: 3,
            max_age_ms: 1800.0,
            max_gap_ms: 850.0,
            same_place: 0.35,
            forget_after: 5,
            another_look: 3,
        }
    }
}

#[derive(Clone, Debug)]
struct Vote {
    card: u32,
    entry: u32,
    twins: Vec<u32>,
    at: f64,
    strong: bool,
}

/// What an agreement holds after a frame.
#[derive(Clone, Debug, PartialEq)]
pub struct Decision {
    pub entry: u32,
    pub card: u32,
    pub score: f32,
    /// Looks of this card the picture could not tell apart on the deciding frame.
    pub twins: Vec<u32>,
    /// Why: `"agreed"` or `"instant"`.
    pub how: &'static str,
    /// Another look of the card decided before it, come to rest with no break between: a second
    /// printing laid on the first, where the card alone says nothing changed.
    pub another_look: bool,
}

/// Two looks the picture cannot tell apart: the same look, or either among the other's twins.
fn alike(a: (u32, &[u32]), b: (u32, &[u32])) -> bool {
    a.0 == b.0 || a.1.contains(&b.0) || b.1.contains(&a.0)
}

#[derive(Default)]
pub struct Agreement {
    pub rules: Rules,
    votes: Vec<Vote>,
    last_quad: Option<Quad>,
    decision: Option<Decision>,
    /// The deciding frame's look and its twins, while a decision stands — what another look is
    /// told apart from. Not the decision's own, which later frames of its look refresh.
    look: Option<(u32, Vec<u32>)>,
    /// Decisions made: a different card, the same card after it was forgotten, or another look
    /// of it come to rest, counts again.
    decisions: usize,
    /// Frames running with no card in front of the lens.
    absent: u32,
}

impl Agreement {
    pub fn new(rules: Rules) -> Self {
        Self {
            rules,
            ..Default::default()
        }
    }

    pub fn reset(&mut self) {
        self.votes.clear();
        self.last_quad = None;
        self.decision = None;
        self.look = None;
        self.absent = 0;
    }

    pub fn decision(&self) -> Option<&Decision> {
        self.decision.as_ref()
    }

    /// How many decisions this agreement has made — the number to watch for a new one.
    pub fn decisions(&self) -> usize {
        self.decisions
    }

    /// The count toward the next decision: votes held, and how many of them were accepted
    /// frames rather than supported ones.
    pub fn votes(&self) -> (usize, usize) {
        (
            self.votes.len(),
            self.votes.iter().filter(|v| v.strong).count(),
        )
    }

    /// Frames running with no card in front of the lens.
    pub fn absent(&self) -> u32 {
        self.absent
    }

    /// Whether `scored` is the decided card as it was decided: its card, and a look the picture
    /// cannot tell from the deciding frame's. A frame of another look of it is not.
    pub fn is_decided(&self, scored: &Scored) -> bool {
        self.look.as_ref().is_some_and(|(entry, twins)| {
            self.decision
                .as_ref()
                .is_some_and(|d| d.card == scored.card)
                && alike((*entry, twins), (scored.entry, &scored.twins))
        })
    }

    /// Whether a vote names another look of the decided card than the deciding frame's.
    fn another_look(&self, card: u32, entry: u32, twins: &[u32]) -> bool {
        match (&self.decision, &self.look) {
            (Some(d), Some((e, t))) => d.card == card && !alike((*e, t), (entry, twins)),
            _ => false,
        }
    }

    /// Feed one frame's read, taken at `now_ms`. True when this frame made a decision (a new
    /// one, or the same card decided again).
    pub fn observe(&mut self, r: &Read, now_ms: f64) -> bool {
        if r.present {
            self.absent = 0;
        } else {
            self.absent = self.absent.saturating_add(1);
            if self.absent >= self.rules.forget_after {
                self.decision = None;
                self.look = None;
            }
        }
        let best = r.best();
        let vote = r.accepted || r.supported;
        let last = self.votes.last().cloned();
        if !vote {
            // A weak frame of the counted card, in the same place, inside the gap: hold.
            if let (Some(b), Some(last), Some(q)) = (best, &last, &self.last_quad) {
                if r.weak
                    && b.scored.card == last.card
                    && now_ms >= last.at
                    && now_ms - last.at <= self.rules.max_gap_ms
                    && bounds_iou(&b.quad, q) >= self.rules.same_place
                {
                    self.votes
                        .retain(|v| now_ms - v.at <= self.rules.max_age_ms);
                    return false;
                }
            }
            self.votes.clear();
            return false;
        }
        let b = best.expect("a voting frame has a card");
        let (card, entry, twins) = (b.scored.card, b.scored.entry, &b.scored.twins);
        // While the card is decided, its votes are counted by look: a look the picture tells
        // apart from the last vote's starts the count again, as another card would.
        let relooked = |last: &Vote| {
            self.decision.as_ref().is_some_and(|d| d.card == card)
                && !alike((last.entry, &last.twins), (entry, twins))
        };
        if let Some(last) = &last {
            if last.card != card
                || relooked(last)
                || now_ms - last.at > self.rules.max_gap_ms
                || now_ms < last.at
            {
                self.votes.clear();
            }
        }
        self.votes
            .retain(|v| now_ms - v.at <= self.rules.max_age_ms);
        self.votes.push(Vote {
            card,
            entry,
            twins: twins.clone(),
            at: now_ms,
            strong: r.accepted,
        });
        let window = self
            .rules
            .required
            .max(self.rules.support_required)
            .max(self.rules.another_look);
        if self.votes.len() > window {
            self.votes.remove(0);
        }
        self.last_quad = Some(b.quad);
        if self.another_look(card, entry, twins) {
            // Accepted frames of another look than the deciding frame's, and nothing less: a
            // supported or an instant frame does not lay a second printing on the first.
            let running = self
                .votes
                .iter()
                .filter(|v| v.strong && self.another_look(v.card, v.entry, &v.twins))
                .count();
            if running < self.rules.another_look.max(1) {
                return false;
            }
            self.decisions += 1;
            self.look = Some((entry, twins.clone()));
            self.decision = Some(Decision {
                entry,
                card,
                score: b.scored.score,
                twins: twins.clone(),
                how: "agreed",
                another_look: true,
            });
            return true;
        }
        let strong = self.votes.iter().filter(|v| v.strong).count();
        let agreed =
            strong >= self.rules.required || self.votes.len() >= self.rules.support_required;
        let instant = r.accepted && r.instant;
        if !(agreed || instant) {
            return false;
        }
        let decision = Decision {
            entry: b.scored.entry,
            card: b.scored.card,
            score: b.scored.score,
            twins: b.scored.twins.clone(),
            how: if agreed { "agreed" } else { "instant" },
            // Later frames of a decision repeat what its first said.
            another_look: self
                .decision
                .as_ref()
                .is_some_and(|d| d.card == card && d.another_look),
        };
        if self.decision.as_ref().map(|d| d.card) != Some(decision.card) {
            self.decisions += 1;
            self.look = Some((entry, twins.clone()));
        }
        self.decision = Some(decision);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detect::Detection;
    use crate::frame::Point;
    use crate::scanner::{Found, Scored};

    fn quad(x: f32) -> Quad {
        let p = |x: f32, y: f32| Point { x, y };
        [p(x, 0.0), p(x + 60.0, 0.0), p(x + 60.0, 84.0), p(x, 84.0)]
    }

    /// A frame naming `card` at `x`, with the given verdict flags.
    fn frame(
        card: u32,
        x: f32,
        accepted: bool,
        supported: bool,
        instant: bool,
        weak: bool,
    ) -> Read {
        let found = Found {
            detection: Detection {
                score: 0.9,
                quad: quad(x),
                flip: 0.0,
            },
            quad: quad(x),
            flipped: false,
            scored: Scored {
                entry: card * 10,
                card,
                score: 0.65,
                margin: 0.2,
                twins: vec![card * 10],
            },
            top: vec![(card * 10, 0.65)],
            embedding: vec![],
            accepted,
            prominence: 1.0,
            aimed: true,
        };
        Read {
            cards: vec![found],
            accepted,
            supported,
            instant,
            weak,
            present: true,
            ..Default::default()
        }
    }

    fn accepted(card: u32) -> Read {
        frame(card, 0.0, true, false, false, false)
    }

    fn nothing() -> Read {
        Read::default()
    }

    /// An accepted frame of `card` whose best look is `entry`, with `twins` beside it.
    fn look(card: u32, entry: u32, twins: &[u32]) -> Read {
        let mut r = accepted(card);
        r.cards[0].scored.entry = entry;
        r.cards[0].scored.twins = std::iter::once(entry)
            .chain(twins.iter().copied())
            .collect();
        r
    }

    #[test]
    fn two_accepted_frames_of_one_card_decide_it() {
        let mut s = Agreement::default();
        assert!(!s.observe(&accepted(1), 0.0));
        assert_eq!(s.votes(), (1, 1));
        assert!(s.observe(&accepted(1), 100.0));
        assert_eq!(s.decision().map(|d| (d.card, d.how)), Some((1, "agreed")));
        assert_eq!(s.decisions(), 1);
    }

    #[test]
    fn three_frames_decide_when_some_are_only_supported() {
        let mut s = Agreement::default();
        let supported = frame(1, 0.0, false, true, false, true);
        assert!(!s.observe(&supported, 0.0));
        assert!(!s.observe(&accepted(1), 100.0));
        assert!(s.observe(&supported, 200.0));
    }

    #[test]
    fn an_instant_frame_decides_alone() {
        let mut s = Agreement::default();
        assert!(s.observe(&frame(4, 0.0, true, false, true, false), 0.0));
        assert_eq!(s.decision().map(|d| d.how), Some("instant"));
    }

    #[test]
    fn another_card_or_a_long_gap_starts_again() {
        let mut s = Agreement::default();
        s.observe(&accepted(1), 0.0);
        assert!(
            !s.observe(&accepted(2), 100.0),
            "a different card resets the count"
        );
        assert!(!s.observe(&accepted(2), 1100.0), "past the gap");
        assert!(s.observe(&accepted(2), 1200.0));
    }

    #[test]
    fn a_frame_with_nothing_resets_but_a_weak_frame_in_place_holds() {
        let mut s = Agreement::default();
        s.observe(&accepted(1), 0.0);
        s.observe(&nothing(), 50.0);
        assert!(
            !s.observe(&accepted(1), 100.0),
            "the empty frame reset the count"
        );

        let mut s = Agreement::default();
        s.observe(&accepted(1), 0.0);
        s.observe(&frame(1, 5.0, false, false, false, true), 50.0);
        assert!(
            s.observe(&accepted(1), 100.0),
            "the weak frame in the same place held the count"
        );

        let mut s = Agreement::default();
        s.observe(&accepted(1), 0.0);
        s.observe(&frame(1, 400.0, false, false, false, true), 50.0);
        assert!(
            !s.observe(&accepted(1), 100.0),
            "a weak frame elsewhere does not hold"
        );
    }

    #[test]
    fn a_decision_stands_until_another_card_is_decided() {
        let mut s = Agreement::default();
        s.observe(&accepted(1), 0.0);
        s.observe(&accepted(1), 100.0);
        s.observe(&accepted(2), 200.0);
        assert_eq!(s.decision().map(|d| d.card), Some(1));
        s.observe(&accepted(2), 300.0);
        assert_eq!(s.decision().map(|d| d.card), Some(2));
        assert_eq!(s.decisions(), 2);
    }

    #[test]
    fn another_look_of_the_decided_card_at_rest_is_a_new_decision() {
        // Card 1 decided on look 10; a second printing of it, look 11, laid on top (#1359).
        let mut s = Agreement::default();
        s.observe(&look(1, 10, &[]), 0.0);
        assert!(s.observe(&look(1, 10, &[]), 100.0));
        assert!(!s.decision().expect("decided").another_look);
        assert!(s.is_decided(&look(1, 10, &[]).cards[0].scored));
        assert!(!s.is_decided(&look(1, 11, &[]).cards[0].scored));
        assert!(!s.observe(&look(1, 11, &[]), 200.0));
        assert!(
            !s.observe(&look(1, 11, &[]), 300.0),
            "two frames of a look are not at rest"
        );
        assert_eq!(
            s.decision().map(|d| d.entry),
            Some(10),
            "the first look still stands"
        );
        assert!(s.observe(&look(1, 11, &[]), 400.0));
        let d = s.decision().expect("decided");
        assert_eq!((d.card, d.entry, d.another_look), (1, 11, true));
        assert_eq!(s.decisions(), 2);
        // Now the second look is the one decided: more of it changes nothing, and the first
        // look laid back on it is another decision in turn.
        assert!(s.observe(&look(1, 11, &[]), 500.0));
        assert_eq!(s.decisions(), 2);
        assert!(s.is_decided(&look(1, 11, &[]).cards[0].scored));
        for at in [600.0, 700.0] {
            assert!(!s.observe(&look(1, 10, &[]), at));
        }
        assert!(s.observe(&look(1, 10, &[]), 800.0));
        assert_eq!(
            (s.decisions(), s.decision().map(|d| d.entry)),
            (3, Some(10))
        );
    }

    #[test]
    fn a_wavering_look_or_a_twin_of_it_is_the_decided_card() {
        let mut s = Agreement::default();
        s.observe(&look(1, 10, &[]), 0.0);
        s.observe(&look(1, 10, &[]), 100.0);
        // Another look on two frames, then the decided one: a held card's best look wavering.
        s.observe(&look(1, 11, &[]), 200.0);
        s.observe(&look(1, 11, &[]), 300.0);
        s.observe(&look(1, 10, &[]), 400.0);
        assert!(
            !s.observe(&look(1, 11, &[]), 500.0),
            "the waver counted across the look"
        );
        assert_eq!(s.decisions(), 1);
        // A look the picture could not tell from the deciding one, either way round, is it.
        let mut s = Agreement::default();
        s.observe(&look(1, 10, &[12]), 0.0);
        s.observe(&look(1, 10, &[12]), 100.0);
        for (i, frame) in [look(1, 12, &[]), look(1, 13, &[10])]
            .iter()
            .cycle()
            .take(6)
            .enumerate()
        {
            s.observe(frame, 200.0 + 100.0 * i as f64);
            assert!(!s.decision().expect("decided").another_look, "frame {i}");
        }
        assert_eq!(s.decisions(), 1);
        // And only accepted frames lay a second printing: supported ones never do.
        let mut s = Agreement::default();
        s.observe(&look(1, 10, &[]), 0.0);
        s.observe(&look(1, 10, &[]), 100.0);
        let mut supported = look(1, 11, &[]);
        (supported.accepted, supported.supported, supported.weak) = (false, true, true);
        for i in 0..4 {
            assert!(!s.observe(&supported, 200.0 + 100.0 * i as f64));
        }
        assert_eq!(s.decisions(), 1);
    }

    #[test]
    fn a_card_gone_long_enough_is_forgotten_and_counts_again() {
        let mut s = Agreement::default();
        s.observe(&accepted(1), 0.0);
        s.observe(&accepted(1), 100.0);
        // Four empty frames: a card fumbled in the hand, not taken away.
        for i in 0..4 {
            s.observe(&nothing(), 200.0 + 50.0 * i as f64);
        }
        assert_eq!(s.decision().map(|d| d.card), Some(1));
        assert_eq!(s.absent(), 4);
        // The fifth forgets it, and the same card shown again is a second decision.
        s.observe(&nothing(), 400.0);
        assert!(s.decision().is_none());
        s.observe(&accepted(1), 500.0);
        assert!(s.observe(&accepted(1), 600.0));
        assert_eq!(s.decisions(), 2);
        assert_eq!(s.absent(), 0);
    }
}
