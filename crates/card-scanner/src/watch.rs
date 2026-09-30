//! Whether the card a decision stands on is still the card in front of the lens.
//!
//! ## Why nothing else can say
//!
//! A pile is scanned by laying each card on the last, in the same place. The quad lock judges
//! geometry alone — centre drift within 35% of the short edge, area within 1.6× — so a card
//! stacked where the decided one lay *is* the same quad to it, and the lock never lets go.
//! Everything that ended a decision before this module keyed off the lock letting go or the
//! hash naming someone else, and a stacked card does neither reliably:
//!
//! - **Fast** froze the tally, and only ten frames naming the *same* other card lifted it —
//!   measured headless (card-scanner.md §7), the old decision held nine frames of the new card
//!   and the new card decided seven frames after that.
//! - **A card the hash cannot place never lifted it at all.** Under a freeze a frame with
//!   candidates but none inside the gate is not a miss (the Plains that reset itself, §5), so
//!   a foil laid on a decided card left the old card as the answer for as long as it lay there.
//! - **Exact never re-armed.** Only a lock that stops being trusted arms a second resolve.
//! - **A second printing of the decided card** — a Forest on a Forest from another set — is
//!   the same oracle card to the hash, so under the freeze it was not even a miss.
//!
//! ## What it watches instead
//!
//! What the card looks like. The frame that decided is the **anchor**, and every trusted frame
//! while the decision stands is compared with it and with the last few frames that were the
//! same card — the nearest of them decides. A frame at least [`CHANGED_BITS`] from all of them
//! is not the decided card; a second such frame within [`AGREE_BITS`] of the first is a card
//! **at rest**, and that is a new card, where one far frame alone is a hand passing over. Two
//! frames, because a hand moving across the card differs from itself frame to frame and a card
//! set down does not.
//!
//! **The nearest of several, because one card's frames scatter more than one would guess.** On
//! the synthetic evaluation's frames (card-scanner.md §10, *A card laid on the last*), a held
//! card's frame was within 28 bits of the nearest of its last four in 99% of frames, against 36
//! of the single frame before it. The recent frames are admitted only while they
//! are within [`CHANGED_BITS`] of the anchor itself, so the set cannot walk away from the
//! decided card a frame at a time — a card slid slowly over it cannot become "the same card".
//!
//! **128 bits of grayscale dHash**, measured against the 256-bit one the bundle is searched
//! with, the colour one, and normalized cross-correlation of three thumbnail sizes: the
//! coarser hash has the widest gap between a held card's worst frames and a different card's
//! typical one, and it is the one that tells basic lands apart. The correlations are the
//! tightest on one card and the worst at telling two apart — every card shares its frame, so
//! two different cards correlate well — and they are weakest exactly on basics.
//!
//! The comparison is camera to camera — the same lens, lamp and background on both sides —
//! where the bundle search compares a photograph with a render. `bin/stacking.rs` is the
//! measurement.
//!
//! ## Either way up
//!
//! `detect::order_corners` breaks the 180° tie towards the corner nearest the frame's origin,
//! so a card that has not moved can come out of the rectification the other way up, and a
//! stacked card may be laid the other way round. The anchor and a far frame keep both halves,
//! and every distance to them is the nearer of the two relative turns.
//!
//! ## What it cannot see
//!
//! **A second copy of the same printing.** It looks exactly like the first, so there is nothing
//! to see; lifting the first away and laying the second down breaks the lock, and the stretch
//! break is what counts it. The tray's quantity stepper is the other answer.
//!
//! **A hand that stops on the card.** Two frames of a hand held still over the decided card are
//! a card at rest, and a large enough hand is far from it. One frame of a moving hand is not.

use crate::hash::{hash, Descriptor, HashKind};
use image::RgbImage;
use std::collections::VecDeque;

/// A trusted frame at least this far, in bits of 128, from the anchor and from every recent
/// frame of the decided card is not the decided card. Over a held card's p99 (28); under a
/// different card's median (41), a basic land on another basic's p5 (30), and every frame of
/// the same basic from another set (36 at the least).
pub const CHANGED_BITS: u32 = 32;

/// Two consecutive far frames within this many bits of each other are one card at rest — a
/// card laid on top was, in 95% of its consecutive frames.
pub const AGREE_BITS: u32 = 28;

/// How many looks of the decided card are kept: the anchor and the last three frames that were
/// the same card.
pub const RING: usize = 4;

/// One frame's card, both ways up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Look {
    pub upright: Descriptor,
    pub turned: Descriptor,
}

/// The descriptor this module compares: 128-bit grayscale dHash of the rectified card.
pub fn descriptor(rectified: &RgbImage) -> Descriptor {
    hash(&image::DynamicImage::ImageRgb8(rectified.clone()).to_luma8(), HashKind::DHash, 128)
}

/// A rectified card and its 180° turn, as the watch compares them.
pub fn look(upright: &RgbImage, turned: &RgbImage) -> Look {
    Look { upright: descriptor(upright), turned: descriptor(turned) }
}

/// Bits between two descriptors, every bit when they cannot be compared — two widths.
fn bits_between(a: &Descriptor, b: &Descriptor) -> u32 {
    a.distance(b).unwrap_or(u32::from(a.bits.max(b.bits)))
}

impl Look {
    /// Bits from this look to a frame's upright descriptor, whichever way up either came out:
    /// the nearer of the two relative turns. Only one side needs both halves — a turned pair is
    /// the same comparison as the upright pair turned — so a frame that turns out to be the
    /// same card costs one descriptor, not two.
    pub fn distance_to(&self, upright: &Descriptor) -> u32 {
        bits_between(&self.upright, upright).min(bits_between(&self.turned, upright))
    }

    /// [`Look::distance_to`] another look.
    pub fn distance(&self, other: &Look) -> u32 {
        self.distance_to(&other.upright)
    }
}

/// What one trusted frame was, against the decided card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Seen {
    /// No decision is being watched.
    Unwatched,
    /// Near enough the decided card to be it.
    Same,
    /// Far from the decided card, and not yet a card at rest — the first such frame, or one
    /// that disagrees with the frame before it.
    Moved,
    /// A second far frame that agrees with the one before it: a different card has come to
    /// rest. The watch has stopped; the caller forgets the card and watches the next one when
    /// it is decided.
    Changed,
}

/// The decided card's looks, and the far frame waiting for a second to agree with it.
#[derive(Debug, Default)]
pub struct CardWatch {
    anchor: Option<Look>,
    /// The last frames that were the decided card, upright only: a card that has not moved
    /// comes out the same way up frame to frame, and the anchor covers it when it does not.
    recent: VecDeque<Descriptor>,
    pending: Option<Look>,
}

impl CardWatch {
    /// Watch `anchor` — the look of the frame that decided.
    pub fn watch(&mut self, anchor: Look) {
        self.clear();
        self.anchor = Some(anchor);
    }

    /// Stop watching: the decision is gone, or the reader moved on.
    pub fn clear(&mut self) {
        self.anchor = None;
        self.recent.clear();
        self.pending = None;
    }

    pub fn is_watching(&self) -> bool {
        self.anchor.is_some()
    }

    /// Bits between a frame's upright descriptor and the nearest look of the decided card,
    /// while one is watched.
    pub fn distance_to(&self, upright: &Descriptor) -> Option<u32> {
        let anchor = self.anchor?.distance_to(upright);
        Some(self.recent.iter().map(|r| bits_between(r, upright)).fold(anchor, u32::min))
    }

    /// Judge one trusted frame by its upright descriptor. `turned` is asked for only when the
    /// frame is far from the decided card, because only then is it kept. See [`Seen`].
    pub fn see(&mut self, upright: Descriptor, turned: impl FnOnce() -> Descriptor) -> Seen {
        let (Some(anchor), Some(near)) = (self.anchor, self.distance_to(&upright)) else {
            return Seen::Unwatched;
        };
        if near < CHANGED_BITS {
            self.pending = None;
            if anchor.distance_to(&upright) < CHANGED_BITS {
                if self.recent.len() == RING - 1 {
                    self.recent.pop_front();
                }
                self.recent.push_back(upright);
            }
            return Seen::Same;
        }
        let frame = Look { upright, turned: turned() };
        match self.pending.replace(frame) {
            Some(before) if before.distance(&frame) <= AGREE_BITS => {
                self.clear();
                Seen::Changed
            }
            _ => Seen::Moved,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 128-bit descriptor with the first `n` bits set — `n` bits from the empty one.
    fn bits(n: u32) -> Descriptor {
        let mut words = [0u64; 4];
        for i in 0..n as usize {
            words[i / 64] |= 1 << (i % 64);
        }
        Descriptor { words, bits: 128 }
    }

    /// A look whose turned half is `bits(n)` inverted — `128 − m` bits from `bits(m)`, so for
    /// every prefix under 64 here only the upright half counts.
    fn up(n: u32) -> Look {
        let turned = bits(n);
        Look { upright: bits(n), turned: Descriptor { words: turned.words.map(|w| !w), ..turned } }
    }

    /// Show the watch one frame.
    fn see(w: &mut CardWatch, frame: Look) -> Seen {
        w.see(frame.upright, || frame.turned)
    }

    fn watching(anchor: Look) -> CardWatch {
        let mut w = CardWatch::default();
        w.watch(anchor);
        w
    }

    #[test]
    fn nothing_is_judged_until_a_decision_is_watched() {
        let mut w = CardWatch::default();
        assert_eq!(see(&mut w, up(50)), Seen::Unwatched);
        assert_eq!(see(&mut w, up(50)), Seen::Unwatched);
        assert!(!w.is_watching());
    }

    #[test]
    fn two_far_frames_that_agree_are_a_new_card() {
        let mut w = watching(up(0));
        assert_eq!(see(&mut w, up(CHANGED_BITS + 10)), Seen::Moved);
        assert_eq!(see(&mut w, up(CHANGED_BITS + 10)), Seen::Changed);
        assert!(!w.is_watching(), "a change stops the watch until the next decision");
    }

    #[test]
    fn one_far_frame_is_a_hand_passing() {
        let mut w = watching(up(0));
        assert_eq!(see(&mut w, up(CHANGED_BITS + 10)), Seen::Moved);
        assert_eq!(see(&mut w, up(3)), Seen::Same);
        // The far frame before the card came back is forgotten: another far frame starts over.
        assert_eq!(see(&mut w, up(CHANGED_BITS + 10)), Seen::Moved);
    }

    #[test]
    fn far_frames_that_disagree_are_a_hand_moving() {
        // Every frame is far from the card and none is at rest: `bits` sets a prefix, so these
        // are `AGREE_BITS + 1` apart one to the next.
        let mut w = watching(up(0));
        for frame in [CHANGED_BITS, CHANGED_BITS + AGREE_BITS + 1, CHANGED_BITS] {
            assert_eq!(
                see(&mut w, up(frame)),
                Seen::Moved,
                "a moving hand at {frame} read as a card"
            );
        }
        assert!(w.is_watching());
    }

    #[test]
    fn the_thresholds_are_inclusive_where_they_say() {
        let mut w = watching(up(0));
        assert_eq!(see(&mut w, up(CHANGED_BITS - 1)), Seen::Same, "under the bar is the same card");
        let mut w = watching(up(0));
        assert_eq!(see(&mut w, up(CHANGED_BITS)), Seen::Moved, "the bar itself is far");
        let at_rest = up(CHANGED_BITS + AGREE_BITS);
        assert_eq!(see(&mut w, at_rest), Seen::Changed, "exactly `AGREE_BITS` apart agrees");
    }

    #[test]
    fn a_card_turned_round_is_the_same_card() {
        // The rectification can come out either way up on a card that never moved.
        let anchor = Look { upright: bits(0), turned: bits(100) };
        let mut w = watching(anchor);
        let turned = Look { upright: bits(100), turned: bits(0) };
        assert_eq!(see(&mut w, turned), Seen::Same);
        assert_eq!(see(&mut w, turned), Seen::Same);
        assert_eq!(anchor.distance(&turned), 0);
    }

    #[test]
    fn the_decided_card_costs_one_descriptor() {
        // A frame near the decided card is compared by its upright half alone; the turned half
        // is a second descriptor per frame, paid only by a frame that might be a new card.
        let mut w = watching(up(0));
        let seen = w.see(bits(3), || panic!("asked to turn a frame that is the decided card"));
        assert_eq!(seen, Seen::Same);
    }

    #[test]
    fn a_frame_near_a_recent_one_is_the_same_card() {
        // The jitter the ring absorbs: this frame is past the bar from the anchor, but a frame
        // of the same card a moment ago was halfway there and it is near that one.
        let mut w = watching(up(0));
        let halfway = CHANGED_BITS / 2 + 4;
        assert_eq!(see(&mut w, up(halfway)), Seen::Same);
        assert_eq!(see(&mut w, up(CHANGED_BITS + 4)), Seen::Same, "the ring did not count");
        assert_eq!(w.distance_to(&bits(CHANGED_BITS + 4)), Some(CHANGED_BITS + 4 - halfway));
    }

    #[test]
    fn the_ring_cannot_walk_away_from_the_anchor() {
        // A frame admitted through a recent one but past the bar from the anchor is the same
        // card and is not kept — so the next step out is measured from inside the anchor's
        // reach, and a card slid over the decided one a little at a time is still far from it.
        let mut w = watching(up(0));
        let step = CHANGED_BITS - 4;
        assert_eq!(see(&mut w, up(step)), Seen::Same);
        assert_eq!(see(&mut w, up(2 * step - 4)), Seen::Same, "near the first step");
        assert_eq!(see(&mut w, up(3 * step - 8)), Seen::Moved, "the ring walked with the frames");
    }

    #[test]
    fn the_ring_holds_the_last_three_frames() {
        let mut w = watching(up(0));
        for n in [20, 1, 2, 3] {
            assert_eq!(see(&mut w, up(n)), Seen::Same);
        }
        // `up(20)` has been pushed out, so a frame near only it is judged by the rest.
        assert_eq!(w.distance_to(&bits(20 + CHANGED_BITS - 1)), Some(20 + CHANGED_BITS - 1 - 3));
    }

    #[test]
    fn clear_forgets_the_pending_frame_and_the_ring() {
        // 62 is past the bar from both the anchor and the recent 20.
        let mut w = watching(up(0));
        assert_eq!(see(&mut w, up(20)), Seen::Same);
        assert_eq!(see(&mut w, up(62)), Seen::Moved);
        w.clear();
        w.watch(up(0));
        assert_eq!(see(&mut w, up(62)), Seen::Moved, "a pending frame survived");
        assert_eq!(w.distance_to(&bits(40)), Some(40), "a recent frame survived");
    }
}
