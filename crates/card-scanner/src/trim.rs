//! Cutting the background margin off a rectification.
//!
//! ## Why there is a margin at all
//!
//! [`crate::detect::DetectOptions::inset`] expands the winning quad by 7% before warping,
//! because Canny tracks the *inner* edge of a card's black border and the raw quad is
//! systematically too small. 1.07 is the value that wins on average — which means that on the
//! frames where the detector already found the true outer edge, it overshoots by the full 7%
//! and the rectification comes back with a ring of table around the card.
//!
//! That ring is not merely untidy. **Every reference hash in the bundle is a Scryfall `grid`
//! image, which is exactly the card and nothing else.** A rectification carrying 3% of
//! tablecloth is being compared against crops that carry none, so the mismatch is built into
//! the descriptor before the search even starts — and it is worst at the edges, where a card's
//! border and frame put the strongest structure.
//!
//! ## How the edge is found
//!
//! In a rectification the card is axis-aligned, so each boundary is a straight run across the
//! image. The rule is **how far the outermost strip's colour continues inward**, not where the
//! sharpest edge is: scan in from each side and stop at the first line whose mean colour has
//! drifted from the outermost line's.
//!
//! **An edge-finding rule was tried first and is wrong.** A card's own black border sits
//! immediately inside its outer boundary, so on a *tight* rectification the outermost gradient
//! is the border-to-face transition — every bit as sharp as a table-to-card one, and a few
//! pixels in. A gradient rule shaves the border off every card it sees, which is worse than
//! the margin it was removing, because the reference images have that border.
//!
//! What separates the two cases is not the edge but what lies outside it. A Magic card's
//! border is near-black by design (or, before 6th Edition, near-white); a surface a card is
//! lying on is usually neither. So the outermost strip's *luma* decides whether there is
//! anything to trim at all, and only then does the colour run decide how much.
//!
//! ## It fails safe
//!
//! A dark card on a dark table offers no evidence, and neither does a white-bordered card on
//! paper. In both the outermost strip reads as card, nothing is trimmed, and the caller keeps
//! exactly the image it had — which is the behaviour before this module existed. Trimming is
//! an improvement on a frame that offers the evidence, never a requirement.

use image::RgbImage;

/// How far in from each edge to look, as a fraction of that dimension.
///
/// 0.14 covers a large overshoot with room to spare. It reaches well past where a card's art
/// box begins, which is why the rule below is about *colour continuing* rather than about
/// finding an edge: the art box is a magnificent edge and it is not the card's boundary.
const SEARCH: f32 = 0.14;

/// Below this luma, the outermost strip is taken to be a card's own black border rather than
/// a surface the card is lying on, and nothing is trimmed.
///
/// **This is the rule that stops the trim eating the card.** A tight rectification's outermost
/// pixels *are* the black border, and its border-to-face transition is every bit as sharp as a
/// table-to-card one — a gradient rule cannot tell them apart and shaves the border off every
/// card it sees. What separates them is not the edge, it is what lies outside it: a Magic
/// card's border is near-black by design, and a surface it is lying on rarely is.
const BORDER_DARK: f32 = 62.0;

/// And above this, the outermost strip is taken to be a white-bordered card, for the same
/// reason in the other direction. Cards from Revised through 5th Edition are white-bordered,
/// and shaving that border is the same error as shaving a black one.
const BORDER_LIGHT: f32 = 205.0;

/// How far a strip's colour may drift from the outermost strip and still count as the same
/// surface, as a mean absolute difference across the three channels.
const TOL: f32 = 26.0;

/// A run shorter than this fraction of the side is ignored.
///
/// **Measured: without this the trim is a net loss.** Over the 43-scan corpus at the default
/// inset, most frames reported a one-to-six pixel run on a single side — a shadow line, a
/// compression artefact, the outermost row of a slightly soft edge. Cutting those and
/// resampling the image back to size shifted every descriptor bit for no gain, and the median
/// match distance went from 42 to 49. Below this the margin costs less than removing it does.
const MIN_TRIM: f32 = 0.015;

/// A run longer than this fraction of the side is refused outright rather than clamped.
///
/// Clamping would be worse than doing nothing: a run this long means the scan never found the
/// card's edge, so cutting back to the limit cuts into a card whose position is exactly what
/// has just failed to be established.
///
/// 0.08 rather than 0.12, also measured: one corpus frame reported a 78 px run off the top,
/// which is a bright surface above the card being followed down into it. A 7% over-expansion
/// leaves 3.5% of margin a side, so 8% is already generous for what the inset can produce.
const MAX_TRIM: f32 = 0.08;

/// Rows and columns are sampled over the middle of their run, not the whole of it.
///
/// A card's corners are rounded — roughly 4% of the width in radius — so in a *tight*
/// rectification the extreme corners show the surface behind the card. Sampling the full
/// length of an edge mixes that in and makes a tight card look as though it has a margin.
const CORE: f32 = 0.70;

/// The margin found on each side, in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
pub struct Margin {
    pub left: u32,
    pub top: u32,
    pub right: u32,
    pub bottom: u32,
}

impl Margin {
    /// Is there anything to cut?
    pub fn is_empty(&self) -> bool {
        self.left == 0 && self.top == 0 && self.right == 0 && self.bottom == 0
    }

    /// The same margin as seen by a 180°-rotated copy of the image.
    ///
    /// The detector carries both orientations of every card, because a quad cannot say which
    /// end is the top. They must be cut *identically* — measuring each separately would let
    /// the two disagree, and the matcher would then be choosing between two different crops as
    /// well as two rotations.
    pub fn rotated_180(self) -> Margin {
        Margin { left: self.right, right: self.left, top: self.bottom, bottom: self.top }
    }
}

/// Mean colour of a set of pixels, as three floats.
fn mean_rgb<I: Iterator<Item = [u8; 3]>>(px: I) -> [f32; 3] {
    let (mut sum, mut n) = ([0.0f32; 3], 0.0f32);
    for p in px {
        for c in 0..3 {
            sum[c] += f32::from(p[c]);
        }
        n += 1.0;
    }
    if n == 0.0 {
        return [0.0; 3];
    }
    [sum[0] / n, sum[1] / n, sum[2] / n]
}

fn luma_of(c: [f32; 3]) -> f32 {
    0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
}

fn differs(a: [f32; 3], b: [f32; 3]) -> bool {
    ((a[0] - b[0]).abs() + (a[1] - b[1]).abs() + (a[2] - b[2]).abs()) / 3.0 > TOL
}

/// How far the surface behind the card continues inward, along one side.
///
/// `strip(i)` gives the mean colour of the `i`-th line in from that edge. Returns 0 whenever
/// the outermost line already reads as card — see [`BORDER_DARK`] and [`BORDER_LIGHT`] — and
/// whenever the run is too long to believe.
fn run_length(strip: impl Fn(usize) -> [f32; 3], limit: usize, floor: u32, cap: u32) -> u32 {
    if limit < 2 {
        return 0;
    }
    let reference = strip(0);
    if !(BORDER_DARK..=BORDER_LIGHT).contains(&luma_of(reference)) {
        return 0;
    }
    let end = (1..limit).find(|&i| differs(strip(i), reference)).unwrap_or(0) as u32;
    if end < floor || end > cap {
        0
    } else {
        end
    }
}

/// The middle [`CORE`] of a run, as a half-open range.
fn inner_range(n: u32) -> (u32, u32) {
    let pad = ((n as f32) * (1.0 - CORE) / 2.0) as u32;
    (pad, n - pad)
}

/// Where the card's edges are inside a rectification that may carry background.
pub fn margin(img: &RgbImage) -> Margin {
    let (w, h) = (img.width(), img.height());
    if w < 8 || h < 8 {
        return Margin::default();
    }
    let px = |x: u32, y: u32| img.get_pixel(x, y).0;

    // The middle of each edge, so a card's rounded corners are not sampled as background.
    let (x0, x1) = inner_range(w);
    let (y0, y1) = inner_range(h);
    let band_x = ((w as f32) * SEARCH) as usize;
    let band_y = ((h as f32) * SEARCH) as usize;
    let (lo_x, hi_x) = (((w as f32) * MIN_TRIM) as u32, ((w as f32) * MAX_TRIM) as u32);
    let (lo_y, hi_y) = (((h as f32) * MIN_TRIM) as u32, ((h as f32) * MAX_TRIM) as u32);

    let left = run_length(|i| mean_rgb((y0..y1).map(|y| px(i as u32, y))), band_x, lo_x, hi_x);
    let right =
        run_length(|i| mean_rgb((y0..y1).map(|y| px(w - 1 - i as u32, y))), band_x, lo_x, hi_x);
    let top = run_length(|i| mean_rgb((x0..x1).map(|x| px(x, i as u32))), band_y, lo_y, hi_y);
    let bottom =
        run_length(|i| mean_rgb((x0..x1).map(|x| px(x, h - 1 - i as u32))), band_y, lo_y, hi_y);

    // **Opposite sides are cut by the smaller of the two, and this is the difference between
    // the trim helping and hurting.** An over-expanded quad is expanded about its centre, so
    // the margin it leaves is symmetric; a run found on one side only means something else
    // happened — the quad was offset, or a shadow ran along one edge. Cutting that one side
    // does not recentre the card, it shifts it, and every feature then lands somewhere the
    // reference does not have it. Measured over the corpus, one-sided trims turned
    // `Knights of Dol Amroth` at 68 bits into `Land Tax` at 83, and `Tidings of War` into
    // `Avacyn, Angel of Hope`. Taking the minimum can only ever cut background.
    let (lr, tb) = (left.min(right), top.min(bottom));
    Margin { left: lr, right: lr, top: tb, bottom: tb }
}

/// Cut the background off a rectification and resample back to its original size.
///
/// Returns `None` when there is nothing to cut, so a caller can keep the image it already has
/// rather than paying for a copy that changes nothing.
///
/// The resample is a small upscale of a crop, done with a triangle filter. That is a real loss
/// of sharpness and it does not matter here: the descriptor built from this is a 16-row dHash,
/// so the image is about to be reduced by a factor of thirty in each direction anyway.
pub fn trim(img: &RgbImage) -> Option<RgbImage> {
    apply(img, margin(img))
}

/// Cut a margin that has already been measured — see [`Margin::rotated_180`] for why the
/// measuring and the cutting are separate.
pub fn apply(img: &RgbImage, m: Margin) -> Option<RgbImage> {
    if m.is_empty() {
        return None;
    }
    let (w, h) = (img.width(), img.height());
    let cw = w.checked_sub(m.left + m.right)?;
    let ch = h.checked_sub(m.top + m.bottom)?;
    if cw < w / 2 || ch < h / 2 {
        return None;
    }
    let cropped = image::imageops::crop_imm(img, m.left, m.top, cw, ch).to_image();
    Some(image::imageops::resize(&cropped, w, h, image::imageops::FilterType::Triangle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    const TABLE: [u8; 3] = [130, 120, 110];

    /// A "card" on a surface: a black border, a light face, and an art box far enough in to sit
    /// inside the search band. `pad` pixels of surface show all round.
    fn framed(pad: u32, surface: [u8; 3]) -> RgbImage {
        let (w, h) = (488u32, 680u32);
        let mut img = RgbImage::from_pixel(w, h, Rgb(surface));
        for y in pad..h - pad {
            for x in pad..w - pad {
                let inner = x >= pad + 18 && x < w - pad - 18 && y >= pad + 18 && y < h - pad - 18;
                img.put_pixel(x, y, Rgb(if inner { [190; 3] } else { [16; 3] }));
            }
        }
        // The art box — a strong edge well inside the band, which a gradient rule mistook for
        // the card's boundary and this rule must ignore entirely.
        for y in pad + 40..h - pad - 40 {
            for x in pad + 40..pad + 46 {
                img.put_pixel(x, y, Rgb([8; 3]));
            }
        }
        img
    }

    #[test]
    fn a_margin_is_found_on_every_side() {
        let m = margin(&framed(20, TABLE));
        for (side, got) in
            [("left", m.left), ("right", m.right), ("top", m.top), ("bottom", m.bottom)]
        {
            assert!(
                (19..=21).contains(&got),
                "{side} margin was {got}, expected the 20 px of surface that were padded on"
            );
        }
    }

    #[test]
    fn a_tight_card_keeps_its_black_border() {
        // The failure that sank the gradient rule: with no margin at all the outermost strip
        // *is* the border, and anything trimmed here is card being thrown away.
        let img = framed(0, TABLE);
        assert_eq!(margin(&img), Margin::default(), "a tight card was cropped into");
        assert!(trim(&img).is_none(), "a tight card was needlessly resampled");
    }

    #[test]
    fn a_white_bordered_card_keeps_its_border() {
        // Revised through 5th Edition. The same error as the black case, mirrored.
        let (w, h) = (488u32, 680u32);
        let mut img = RgbImage::from_pixel(w, h, Rgb([238; 3]));
        for y in 18..h - 18 {
            for x in 18..w - 18 {
                img.put_pixel(x, y, Rgb([150, 140, 120]));
            }
        }
        assert_eq!(margin(&img), Margin::default(), "a white border was trimmed away");
    }

    #[test]
    fn the_art_box_is_never_reached() {
        assert!(margin(&framed(20, TABLE)).left < 25, "the trim ran past the card's border");
    }

    #[test]
    fn a_card_the_same_shade_as_the_table_is_left_alone() {
        let mut img = RgbImage::from_pixel(488, 680, Rgb([20; 3]));
        for y in 20..660 {
            for x in 20..468 {
                img.put_pixel(x, y, Rgb([22; 3]));
            }
        }
        assert!(margin(&img).is_empty(), "an invisible edge was reported as found");
        assert!(trim(&img).is_none());
    }

    #[test]
    fn rounded_corners_do_not_read_as_a_margin() {
        // The corners of a tight card genuinely show the surface behind it. Sampling the full
        // length of each edge mixes that in; sampling the middle does not.
        let mut img = framed(0, TABLE);
        let (w, h, r) = (488i32, 680i32, 26i32);
        for y in 0..h {
            for x in 0..w {
                let cx = if x < r {
                    r
                } else if x >= w - r {
                    w - r
                } else {
                    continue;
                };
                let cy = if y < r {
                    r
                } else if y >= h - r {
                    h - r
                } else {
                    continue;
                };
                let (dx, dy) = (x - cx, y - cy);
                if dx * dx + dy * dy > r * r {
                    img.put_pixel(x as u32, y as u32, Rgb(TABLE));
                }
            }
        }
        assert_eq!(margin(&img), Margin::default(), "rounded corners read as a margin");
    }

    #[test]
    fn trimming_restores_the_canonical_size() {
        let out = trim(&framed(20, TABLE)).expect("a 20 px margin should have been trimmed");
        assert_eq!((out.width(), out.height()), (488, 680));
    }

    #[test]
    fn a_one_sided_run_is_not_cut() {
        // Background down the left only: the quad was offset, not over-expanded. Cutting just
        // that side shifts the card rather than recentring it, and over the corpus that was
        // the difference between naming the right card and the wrong one.
        let mut img = framed(0, TABLE);
        for y in 0..680u32 {
            for x in 0..24u32 {
                img.put_pixel(x, y, Rgb(TABLE));
            }
        }
        assert_eq!(margin(&img), Margin::default(), "a one-sided run was cut");
    }

    #[test]
    fn opposite_sides_are_cut_by_the_smaller_run() {
        // 24 px of surface on the left, 34 on the right — both inside the cap, so both are
        // genuinely measured. Only 24 is certainly background on both, so that is what comes
        // off each side.
        let mut img = framed(24, TABLE);
        for y in 0..680u32 {
            for x in 488 - 34..488u32 {
                img.put_pixel(x, y, Rgb(TABLE));
            }
        }
        let m = margin(&img);
        assert_eq!((m.left, m.right), (24, 24), "the larger run was followed: {m:?}");
    }

    #[test]
    fn a_few_pixels_of_surface_are_not_worth_removing() {
        // The measured default case: a thin run on one side, which is a shadow line or a soft
        // edge rather than a margin. Cutting it means resampling the whole image, which moves
        // every descriptor bit — over the corpus that cost more than the pixels were worth.
        assert_eq!(margin(&framed(4, TABLE)), Margin::default(), "a 4 px run was trimmed");
    }

    #[test]
    fn a_run_past_the_cap_is_refused_rather_than_clamped() {
        // 62 px is 12.7% of the width: found well inside the search band, and past the cap.
        // Cutting back to the cap would slice into a card the scan has just failed to locate.
        // Asserted on the width only — the same 62 px is 9.1% of the height and legitimately
        // under the cap there, which is the whole reason the caps are per-axis.
        let m = margin(&framed(62, TABLE));
        assert_eq!(m.left, 0, "a run past the cap was clamped instead of refused");
        assert_eq!(m.right, 0, "a run past the cap was clamped instead of refused");
    }

    #[test]
    fn a_run_past_the_search_band_is_refused() {
        // Nothing was found at all, on any side. The margin is simply not believed.
        assert_eq!(margin(&framed(100, TABLE)), Margin::default(), "an unseen edge was trimmed");
    }
}
