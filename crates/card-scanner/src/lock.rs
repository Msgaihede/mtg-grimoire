//! Holding on to a quad across frames, so a box that is not a card never gets drawn.
//!
//! ## Why one frame cannot decide
//!
//! A card and a card-shaped thing are indistinguishable in a single frame — that is not a
//! tuning problem, it is the measured geometry: a card's art window turned 90° has an aspect
//! of 0.727 against a card's 0.716. Every static test passes both, and the attempt to settle
//! it on appearance alone (a hard card-likeness gate) rejected almost every real frame on
//! video, because a card in a hand under a lamp does not look like a card flat on a table.
//!
//! What a card does that a spurious box does not is **stay put**. A hand holding a card moves
//! it slowly and continuously; a quad conjured out of a glare, a shadow edge or a table seam
//! appears for a frame or two somewhere else and is gone. That difference is invisible to any
//! one frame and unmistakable across five.
//!
//! So this is a *filter*, not a gate: nothing is rejected on appearance, and a quad simply has
//! to prove it is still there. A card held up locks in a handful of frames; a flicker never
//! does, however card-shaped it was.
//!
//! ## It also smooths
//!
//! Once locked, corners are blended with the previous frame's. Detection jitters by a few
//! pixels frame to frame even on a perfectly still card, and an overlay that twitches reads as
//! a broken detector. Smoothing costs a little lag on a fast move and buys a box that looks
//! like it is tracking something real.

use crate::detect::Quad;

#[derive(Debug, Clone)]
pub struct LockOptions {
    /// Consecutive agreeing frames before a quad is trusted.
    ///
    /// At the measured ~12 detections a second this is a quarter of a second — short enough
    /// that holding a card up feels immediate, long enough that nothing transient survives.
    pub min_agree: u32,
    /// How far a quad's centre may move between frames and still be "the same quad", as a
    /// fraction of its own short edge. Generous: a hand is never still.
    pub max_drift: f32,
    /// How much a quad's area may change between frames, as a ratio either way.
    pub max_area_ratio: f32,
    /// Frames with no quad before the lock is dropped.
    pub reset_after_misses: u32,
    /// Corner blending, 0 = no smoothing, 1 = frozen. Applied only once locked.
    pub smoothing: f32,
}

impl Default for LockOptions {
    fn default() -> Self {
        LockOptions {
            min_agree: 3,
            max_drift: 0.35,
            max_area_ratio: 1.6,
            reset_after_misses: 5,
            smoothing: 0.45,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// Nothing seen recently.
    Idle,
    /// A quad is being watched but has not proved itself yet.
    Acquiring,
    /// The quad has held still and can be trusted.
    Locked,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LockState {
    pub phase: Phase,
    /// Consecutive agreeing frames.
    pub agree: u32,
    pub misses: u32,
    /// The smoothed quad, present while acquiring or locked.
    #[serde(skip)]
    pub quad: Option<Quad>,
}

impl LockState {
    /// Should this frame be matched against the bundle?
    ///
    /// Only a locked quad is worth the hash and the search — and, more importantly, worth
    /// showing. Matching an unlocked quad is how a box that is not a card acquires a name.
    pub fn is_trusted(&self) -> bool {
        self.phase == Phase::Locked
    }
}

#[derive(Debug)]
pub struct QuadLock {
    opts: LockOptions,
    quad: Option<Quad>,
    agree: u32,
    misses: u32,
}

impl Default for QuadLock {
    fn default() -> Self {
        QuadLock::new(LockOptions::default())
    }
}

/// Centre of a quad.
fn centre(q: &Quad) -> (f32, f32) {
    let n = q.corners.len() as f32;
    (
        q.corners.iter().map(|c| c.0).sum::<f32>() / n,
        q.corners.iter().map(|c| c.1).sum::<f32>() / n,
    )
}

/// The shorter of the two mean edge lengths — the card's width, in whatever units the quad is
/// in. Used to make the drift tolerance scale-free, so a card near the lens and one far away
/// are held to the same standard.
fn short_edge(q: &Quad) -> f32 {
    let d = |a: usize, b: usize| {
        let (ax, ay) = q.corners[a];
        let (bx, by) = q.corners[b];
        ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt()
    };
    let top_bottom = (d(0, 1) + d(2, 3)) / 2.0;
    let sides = (d(1, 2) + d(3, 0)) / 2.0;
    top_bottom.min(sides).max(1.0)
}

impl QuadLock {
    pub fn new(opts: LockOptions) -> Self {
        QuadLock { opts, quad: None, agree: 0, misses: 0 }
    }

    pub fn reset(&mut self) {
        self.quad = None;
        self.agree = 0;
        self.misses = 0;
    }

    /// Is `candidate` plausibly the same physical card as `previous`?
    fn agrees(&self, previous: &Quad, candidate: &Quad) -> bool {
        let (px, py) = centre(previous);
        let (cx, cy) = centre(candidate);
        let drift = ((cx - px).powi(2) + (cy - py).powi(2)).sqrt() / short_edge(previous);
        if drift > self.opts.max_drift {
            return false;
        }
        let (a, b) = (previous.area().max(1.0), candidate.area().max(1.0));
        let ratio = if a > b { a / b } else { b / a };
        ratio <= self.opts.max_area_ratio
    }

    /// Feed the frame's best quad, or `None` if nothing was detected.
    pub fn observe(&mut self, candidate: Option<Quad>) -> LockState {
        match candidate {
            None => {
                self.misses += 1;
                if self.misses >= self.opts.reset_after_misses {
                    self.reset();
                }
                // A locked quad survives a brief dropout rather than flickering off: a hand
                // crossing the card, or one blurred frame, should not restart the count.
                LockState {
                    phase: if self.quad.is_some() && self.agree >= self.opts.min_agree {
                        Phase::Locked
                    } else if self.quad.is_some() {
                        Phase::Acquiring
                    } else {
                        Phase::Idle
                    },
                    agree: self.agree,
                    misses: self.misses,
                    quad: self.quad,
                }
            }
            Some(c) => {
                self.misses = 0;
                match self.quad {
                    Some(prev) if self.agrees(&prev, &c) => {
                        self.agree += 1;
                        // Smooth only once locked. While acquiring, the raw quad is what has
                        // to prove itself — blending it towards a quad that may be spurious
                        // would help the spurious one agree with itself.
                        self.quad = Some(if self.agree >= self.opts.min_agree {
                            blend(&prev, &c, self.opts.smoothing)
                        } else {
                            c
                        });
                    }
                    _ => {
                        self.agree = 1;
                        self.quad = Some(c);
                    }
                }
                LockState {
                    phase: if self.agree >= self.opts.min_agree {
                        Phase::Locked
                    } else {
                        Phase::Acquiring
                    },
                    agree: self.agree,
                    misses: 0,
                    quad: self.quad,
                }
            }
        }
    }
}

/// Blend `b` towards `a` by `t`. `t = 0` returns `b` unchanged.
fn blend(a: &Quad, b: &Quad, t: f32) -> Quad {
    let mut corners = b.corners;
    for i in 0..4 {
        corners[i].0 = b.corners[i].0 * (1.0 - t) + a.corners[i].0 * t;
        corners[i].1 = b.corners[i].1 * (1.0 - t) + a.corners[i].1 * t;
    }
    Quad { corners }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A card-shaped quad of width `w` centred at `(x, y)`.
    fn quad(x: f32, y: f32, w: f32) -> Quad {
        let h = w / crate::CARD_ASPECT;
        Quad {
            corners: [
                (x - w / 2.0, y - h / 2.0),
                (x + w / 2.0, y - h / 2.0),
                (x + w / 2.0, y + h / 2.0),
                (x - w / 2.0, y + h / 2.0),
            ],
        }
    }

    #[test]
    fn a_still_card_locks_quickly() {
        let mut l = QuadLock::default();
        assert_eq!(l.observe(Some(quad(500.0, 400.0, 200.0))).phase, Phase::Acquiring);
        assert_eq!(l.observe(Some(quad(500.0, 400.0, 200.0))).phase, Phase::Acquiring);
        let s = l.observe(Some(quad(500.0, 400.0, 200.0)));
        assert_eq!(s.phase, Phase::Locked);
        assert!(s.is_trusted());
    }

    #[test]
    fn a_hand_held_card_still_locks() {
        // The tolerance has to admit real movement, or nothing ever locks in practice. Twelve
        // pixels a frame on a 200 px card is a hand that is not especially steady.
        let mut l = QuadLock::default();
        let mut s = None;
        for i in 0..6 {
            s = Some(l.observe(Some(quad(500.0 + i as f32 * 12.0, 400.0 + i as f32 * 6.0, 200.0))));
        }
        assert_eq!(s.expect("frames").phase, Phase::Locked);
    }

    #[test]
    fn a_box_that_jumps_around_never_locks() {
        // **The reported problem.** Each of these is a perfectly card-shaped quad; none is in
        // the same place twice. Nothing about any single frame rejects them, and the sequence
        // rejects all of them.
        let mut l = QuadLock::default();
        let spots = [(200.0, 150.0), (900.0, 620.0), (410.0, 880.0), (1200.0, 200.0), (150.0, 700.0)];
        let mut s = None;
        for (i, (x, y)) in spots.iter().cycle().take(20).enumerate() {
            let _ = i;
            s = Some(l.observe(Some(quad(*x, *y, 190.0))));
        }
        let s = s.expect("frames");
        assert_eq!(s.phase, Phase::Acquiring, "a jumping box reached {:?}", s.phase);
        assert!(!s.is_trusted());
    }

    #[test]
    fn a_quad_that_resizes_wildly_is_not_the_same_quad() {
        let mut l = QuadLock::default();
        let mut s = None;
        for w in [200.0, 205.0, 480.0, 210.0, 500.0, 200.0] {
            s = Some(l.observe(Some(quad(500.0, 400.0, w))));
        }
        assert_eq!(s.expect("frames").phase, Phase::Acquiring);
    }

    #[test]
    fn a_lock_survives_a_brief_dropout() {
        // One blurred frame, or a hand crossing the card, must not restart the count — that
        // would make the lock unreachable on any real feed.
        let mut l = QuadLock::default();
        for _ in 0..4 {
            l.observe(Some(quad(500.0, 400.0, 200.0)));
        }
        assert!(l.observe(None).is_trusted(), "one dropped frame broke the lock");
        assert!(l.observe(None).is_trusted());
        assert!(l.observe(Some(quad(502.0, 401.0, 201.0))).is_trusted());
    }

    #[test]
    fn losing_the_card_drops_the_lock() {
        let mut l = QuadLock::default();
        for _ in 0..5 {
            l.observe(Some(quad(500.0, 400.0, 200.0)));
        }
        let mut s = None;
        for _ in 0..6 {
            s = Some(l.observe(None));
        }
        let s = s.expect("frames");
        assert_eq!(s.phase, Phase::Idle);
        assert!(s.quad.is_none());
    }

    #[test]
    fn moving_to_a_new_card_re_acquires() {
        let mut l = QuadLock::default();
        for _ in 0..5 {
            l.observe(Some(quad(500.0, 400.0, 200.0)));
        }
        // A different card somewhere else: the lock has to break, then rebuild.
        assert_eq!(l.observe(Some(quad(1400.0, 900.0, 200.0))).phase, Phase::Acquiring);
        l.observe(Some(quad(1400.0, 900.0, 200.0)));
        assert_eq!(l.observe(Some(quad(1400.0, 900.0, 200.0))).phase, Phase::Locked);
    }

    #[test]
    fn smoothing_damps_jitter_once_locked() {
        let mut l = QuadLock::default();
        for _ in 0..4 {
            l.observe(Some(quad(500.0, 400.0, 200.0)));
        }
        // A single jittered frame should move the reported quad by less than the jitter.
        let jittered = l.observe(Some(quad(514.0, 400.0, 200.0))).quad.expect("a quad");
        let (cx, _) = centre(&jittered);
        assert!(
            cx > 500.0 && cx < 514.0,
            "smoothing did not damp the jitter: centre moved to {cx}"
        );
    }

    #[test]
    fn smoothing_is_not_applied_while_acquiring() {
        // Blending an unproven quad towards itself would help a spurious one agree with its
        // own past, which is precisely the thing the lock exists to prevent.
        let mut l = QuadLock::default();
        l.observe(Some(quad(500.0, 400.0, 200.0)));
        let raw = l.observe(Some(quad(510.0, 400.0, 200.0))).quad.expect("a quad");
        let (cx, _) = centre(&raw);
        assert!((cx - 510.0).abs() < 0.01, "acquiring quad was smoothed: {cx}");
    }
}
