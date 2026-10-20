//! A detected quad read as more than one thing: the card itself, or a box inside the card — the
//! art window, the type-line-and-text block, the title-and-art block — extrapolated outward to
//! the card that box implies, with the match deciding which reading to believe.
//!
//! **On in every session by default since 2026-10-14** ([`crate::session::Session::set_reframe`]
//! turns it off). On the replay of 86 readers' scans, 28 of the 56 failures rectified an inner
//! box — the art window, the type line and text box, usually turned 90°: inside a binder pocket
//! or against a black stack the card's own outer edge often never becomes a contour, a landscape
//! box read sideways passes the 63:88 prior, and with no container in the frame the containment
//! filter has nothing to drop it for. Those boxes are not noise — on one frame style each sits at
//! known fractions of the card — so the card can be computed from them rather than searched for.
//!
//! **Its ceiling is low, and that was measured.** Surveyed over every detected frame of the 86
//! (1,452 frames, nine readings each), some reading named the right card where the quad as found
//! did not on only 84 frames; extrapolating outward from an inner box roughly doubles whatever
//! error its corners had. On the replay with [`Options::default`] it decided one more printing
//! and two more cards in Exact and made nothing worse — `docs/reference/card-scanner.md` §10,
//! *The replay*, has the A/B and the two designs that were built first and failed.
//!
//! The fractions are the M15 frame's, measured off the mean of 200 cached `display` renders of
//! black-bordered normal M15 printings (strongest row and column gradients). Older frames and
//! borderless printings put the boxes elsewhere; a hypothesis that does not fit simply loses
//! the match to one that does.

use crate::detect::{rectify, Quad, Warped};
use crate::index::Mask;
use crate::reference::{MatchReport, Reference};
use image::RgbImage;
use imageproc::geometric_transformations::Projection;

/// A card's size in millimetres. The hypotheses are laid out in these units so the homography
/// is built from well-scaled points.
const CARD_MM: (f32, f32) = (63.0, 88.0);

/// One way to read a detected quad: as this region of the card, in fractions of the card.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Region {
    pub name: &'static str,
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

/// The M15 art window, inside its thin frame line.
pub const ART: Region = Region { name: "art", x0: 0.073, y0: 0.108, x1: 0.924, y1: 0.557 };
/// The type line down to the card's bottom edge, border to border.
pub const LOWER: Region = Region { name: "lower", x0: 0.0, y0: 0.557, x1: 1.0, y1: 1.0 };
/// The type line and the text box, inside the frame lines.
pub const TEXT_BLOCK: Region =
    Region { name: "text_block", x0: 0.073, y0: 0.560, x1: 0.924, y1: 0.920 };
/// The card's top edge down to the bottom of the art, border to border.
pub const UPPER: Region = Region { name: "upper", x0: 0.0, y0: 0.0, x1: 1.0, y1: 0.557 };

pub const REGIONS: [Region; 4] = [ART, LOWER, TEXT_BLOCK, UPPER];

/// How a frame's reframing is judged.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Options {
    /// A reading other than "the quad is the card" must beat it by this much normalized
    /// distance. More readings are more chances for an impostor to come in under the card, so
    /// a tie keeps the quad as it was found.
    pub margin: f32,
    /// Only reframe when the quad read as the card matches no better than this. A card that
    /// already matches plainly is left alone, and pays nothing.
    pub only_above: f32,
    /// A reading must stand this far clear of the nearest *other card* in its own match — the
    /// gap ([`Match::gap`]) — and clearer than the quad read as the card does.
    ///
    /// **The gap, not the distance, is what tells a real reading from an impostor.** Surveyed
    /// over every frame of the 86 replay scans (1,452 detected frames, nine readings each): a
    /// right reading's distance has a median of 0.250 against a wrong one's 0.301, overlapping
    /// across most of the range, while its gap has a median of 0.023 against 0.008, with the
    /// wrong ones' 90th percentile at 0.020. Switching at a gap ≥ 0.04 and a margin ≥ 0.03 made
    /// 23 frames right in 10 scans and one wrong; at no gap rule, 54 right and 23 wrong.
    pub min_gap: f32,
    /// Print each reframe to stderr — for the replay, which has no other way to say which
    /// reading won.
    pub log: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { margin: 0.03, only_above: 0.20, min_gap: 0.04, log: false }
    }
}

/// Which region a quad was read as, and from which of its long sides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reading {
    pub region: &'static str,
    /// Which long side of the detected quad was taken as the region's top.
    pub flipped: bool,
}

/// One hypothesis: the card quad it implies, and the reading it came from.
#[derive(Debug, Clone, Copy)]
pub struct Hypothesis {
    pub region: &'static str,
    pub flipped: bool,
    pub card: Quad,
}

impl Hypothesis {
    pub fn reading(&self) -> Reading {
        Reading { region: self.region, flipped: self.flipped }
    }
}

/// The card each region implies, if `quad` is that region — two per region, since a region
/// that is not centred on the card extrapolates differently depending on which of the quad's
/// long sides is its top.
///
/// `quad` is ordered as every detection is: TL, TR, BR, BL with a short edge first. Every region
/// here is landscape on the card, so the quad's short edges are the region's vertical sides.
pub fn hypotheses(quad: &Quad) -> Vec<Hypothesis> {
    let q = quad.corners;
    let mut out = Vec::new();
    for region in REGIONS {
        // The region's own TL, TR, BR, BL in the frame, under each reading of the quad.
        for (flipped, corners) in [(false, [q[1], q[2], q[3], q[0]]), (true, [q[3], q[0], q[1], q[2]])] {
            if let Some(card) = extrapolate(&region, corners) {
                out.push(Hypothesis { region: region.name, flipped, card });
            }
        }
    }
    out
}

/// The card quad, given where `region`'s four corners (TL, TR, BR, BL) lie in the frame.
fn extrapolate(region: &Region, corners: [(f32, f32); 4]) -> Option<Quad> {
    let (w, h) = CARD_MM;
    let (x0, y0, x1, y1) = (region.x0 * w, region.y0 * h, region.x1 * w, region.y1 * h);
    let to_frame = Projection::from_control_points([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], corners)?;
    let card = [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)].map(|p| to_frame * p);
    card.iter().all(|(x, y)| x.is_finite() && y.is_finite()).then_some(Quad { corners: card })
}

/// Is enough of `card` in a `w`×`h` frame to be worth matching? Its centre must be in the frame
/// and no corner further outside than a fifth of the frame: a card computed mostly off the edge
/// rectifies to black, and black matches a dark card as well as anything.
pub fn mostly_in_frame(card: &Quad, w: u32, h: u32) -> bool {
    let (w, h) = (w as f32, h as f32);
    let cx = card.corners.iter().map(|c| c.0).sum::<f32>() / 4.0;
    let cy = card.corners.iter().map(|c| c.1).sum::<f32>() / 4.0;
    let inside = (0.0..w).contains(&cx) && (0.0..h).contains(&cy);
    let (sx, sy) = (w * 0.2, h * 0.2);
    inside
        && card
            .corners
            .iter()
            .all(|&(x, y)| x >= -sx && x <= w + sx && y >= -sy && y <= h + sy)
}

/// How one reading matched: its best normalized distance, both ways up at one framing, and how
/// far that stands clear of the nearest candidate that is another card.
#[derive(Debug, Clone, Copy)]
pub struct Match {
    pub distance: f32,
    /// The nearest other card's distance less this one's; 0 when none of the top ten is
    /// another card. A reprint of the winner is not a rival — same-art printings tie by design.
    pub gap: f32,
}

fn best_match(rgb: &RgbImage, quad: &Quad, r: &Reference, mask: &Mask) -> Option<Match> {
    let (a, b) = (rectify(rgb, quad)?, rectify(rgb, &quad.flipped())?);
    match_of(&r.match_views(&[(&a, &b)], 10, mask), r)
}

fn match_of(report: &MatchReport, r: &Reference) -> Option<Match> {
    let oracle = |id: &str| crate::index::parse_uuid(id).map(|id| r.oracle_for(&id));
    let top = report.candidates.first()?;
    let rival = report
        .candidates
        .iter()
        .skip(1)
        .find(|c| oracle(&c.id) != oracle(&top.id))
        .map_or(0.0, |c| c.normalized - top.normalized);
    Some(Match { distance: top.normalized, gap: rival })
}

/// What a frame's reframing decided, for a caller to log.
#[derive(Debug, Clone, Copy)]
pub struct Reframed {
    pub quad: Quad,
    pub reading: Reading,
    pub as_card: f32,
    pub distance: f32,
    /// Kept from an earlier frame rather than chosen on this one.
    pub held: bool,
}

/// The quad to rectify this frame: `quad` itself, unless reading it as an inner box and
/// extrapolating to the card matches better by `opts.margin`.
///
/// **A reading is held from frame to frame**, as the matcher holds a card's orientation. The
/// readings of one inner box imply cards a third of a card apart, and several of them match at
/// near-impostor distances, so a reading chosen afresh each frame jumps between them — and the
/// lock, which trusts a quad only once it has stayed put, never settled (measured on the first
/// A/B: never-resolved 25 → 44 of 86). `held` is kept while it still matches better than the
/// quad read as the card; otherwise every reading is tried again.
pub fn choose(
    rgb: &RgbImage,
    quad: &Quad,
    r: &Reference,
    mask: &Mask,
    opts: &Options,
    held: Option<Reading>,
) -> Option<Reframed> {
    choose_keeping(rgb, quad, r, mask, opts, held).0
}

/// [`choose`], and the quad as found warped both ways up with the descriptors its match computed.
///
/// **What a frame that keeps the quad would otherwise make again** (#1135): reading the quad as
/// the card warps and hashes exactly what [`crate::detect::rectify_views_from`] would then warp,
/// and the frame's match hash. Handed on, the frame reuses both — the warps whenever the
/// rectification starts from this quad, the descriptors whenever no trim then changed them.
/// `None` when the quad admits no homography.
pub fn choose_keeping(
    rgb: &RgbImage,
    quad: &Quad,
    r: &Reference,
    mask: &Mask,
    opts: &Options,
    held: Option<Reading>,
) -> (Option<Reframed>, Option<Warped>) {
    let Some((a, b)) = rectify(rgb, quad).zip(rectify(rgb, &quad.flipped())) else {
        return (None, None);
    };
    let report = r.match_views(&[(&a, &b)], 10, mask);
    let card = match_of(&report, r);
    let found = Warped { quad: *quad, upright: a, flipped: b, descriptors: report.descriptors };
    let Some(card) = card else { return (None, Some(found)) };
    (reframe(rgb, quad, r, mask, opts, held, card), Some(found))
}

/// The rest of [`choose`], once the quad read as the card has matched as `card`.
fn reframe(
    rgb: &RgbImage,
    quad: &Quad,
    r: &Reference,
    mask: &Mask,
    opts: &Options,
    held: Option<Reading>,
    card: Match,
) -> Option<Reframed> {
    let as_card = card.distance;
    let all = hypotheses(quad);
    let fits = |h: &Hypothesis| mostly_in_frame(&h.card, rgb.width(), rgb.height());
    if let Some(h) = held.and_then(|held| all.iter().find(|h| h.reading() == held)).filter(|h| fits(h)) {
        if let Some(m) = best_match(rgb, &h.card, r, mask).filter(|m| m.distance < as_card) {
            return Some(Reframed {
                quad: h.card,
                reading: h.reading(),
                as_card,
                distance: m.distance,
                held: true,
            });
        }
    }
    if as_card <= opts.only_above {
        return None;
    }
    let (best, m) = all
        .into_iter()
        .filter(fits)
        .filter_map(|h| best_match(rgb, &h.card, r, mask).map(|m| (h, m)))
        .filter(|(_, m)| {
            as_card - m.distance >= opts.margin && m.gap >= opts.min_gap && m.gap > card.gap
        })
        .min_by(|a, b| a.1.distance.total_cmp(&b.1.distance))?;
    Some(Reframed { quad: best.card, reading: best.reading(), as_card, distance: m.distance, held: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A card in the frame, upright and level, and where `region` of it lies, as a detection
    /// would report that box: TL, TR, BR, BL rotated so a short edge comes first.
    fn card_and_box(region: &Region, short_edge_first_from: usize) -> (Quad, Quad) {
        let (left, top, w, h) = (200.0, 120.0, 315.0, 440.0);
        let card = Quad { corners: [(left, top), (left + w, top), (left + w, top + h), (left, top + h)] };
        let at = |u: f32, v: f32| (left + u * w, top + v * h);
        let tl = at(region.x0, region.y0);
        let tr = at(region.x1, region.y0);
        let br = at(region.x1, region.y1);
        let bl = at(region.x0, region.y1);
        // A landscape box: the short edges are its left and right sides, so a detection names
        // it starting from BL (BL→TL is short) or from TR (TR→BR is short).
        let ring = [tl, tr, br, bl];
        let s = short_edge_first_from;
        let found = Quad { corners: [ring[s % 4], ring[(s + 1) % 4], ring[(s + 2) % 4], ring[(s + 3) % 4]] };
        (card, found)
    }

    fn worst_corner(a: &Quad, b: &Quad) -> f32 {
        [*a, a.flipped()]
            .iter()
            .map(|a| {
                a.corners
                    .iter()
                    .zip(&b.corners)
                    .map(|(p, q)| (p.0 - q.0).hypot(p.1 - q.1))
                    .fold(0.0, f32::max)
            })
            .fold(f32::MAX, f32::min)
    }

    #[test]
    fn every_region_read_from_either_end_recovers_the_card() {
        for region in REGIONS {
            // BL first, and TR first — the two orderings a detection can give a landscape box.
            for from in [3, 1] {
                let (card, found) = card_and_box(&region, from);
                let best = hypotheses(&found)
                    .into_iter()
                    .filter(|h| h.region == region.name)
                    .map(|h| worst_corner(&h.card, &card))
                    .fold(f32::MAX, f32::min);
                assert!(best < 0.5, "{} from corner {from}: best hypothesis is {best} px off", region.name);
            }
        }
    }

    #[test]
    fn a_card_far_off_the_frame_is_not_matched() {
        let off = Quad { corners: [(-900.0, 10.0), (-600.0, 10.0), (-600.0, 400.0), (-900.0, 400.0)] };
        assert!(!mostly_in_frame(&off, 960, 540));
        let on = Quad { corners: [(300.0, 40.0), (650.0, 40.0), (650.0, 520.0), (300.0, 520.0)] };
        assert!(mostly_in_frame(&on, 960, 540));
    }
}
