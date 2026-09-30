//! Where the card's four sides actually are — fitted lines, sub-pixel corners, and the outer edge.
//!
//! [`crate::detect`] finds a *region* that is card-shaped; this module decides where its sides
//! lie. Two steps, and they answer two different questions.
//!
//! ## Fit the sides, don't pick vertices
//!
//! A card's corners are rounded, so its outline is a rounded rectangle and no four of its
//! points are the corners. Douglas–Peucker on the hull picks four *vertices*, which sit on the
//! arcs, and when it cannot land on exactly four the old fallback was `min_area_rect` — a
//! rotated rectangle that ignores perspective outright. [`fit_sides`] instead gives every
//! contour point to the side it lies along, leaves out the stretch near each corner where the
//! arc bends away, leaves out anything well off the line (a thumb, a sleeve lip, a notch of
//! shadow), and fits a straight line to what is left. The corners are where adjacent lines
//! cross: sub-pixel, on the card's *sharp* corners rather than on its arcs, and true under
//! perspective because a straight edge stays straight under a homography.
//!
//! ## Then find the outer edge, at full resolution
//!
//! The contour the detector hands over is often not the card's outline at all. **Canny's
//! strongest gradient on a black-bordered card is the inner edge of the border**, where black
//! meets the frame, so the contour tracks the frame line and sits ~4.5% of the card's width
//! inside every side. That is what `DetectOptions::inset`'s 7% expand used to paper over on
//! average, overshooting whenever the detector *had* found the outer edge.
//!
//! [`refine`] looks instead. For each side it samples short profiles across the side at full
//! resolution, finds the gradient peaks on each, and keeps the peak *lines* — offsets that
//! agree across most of the side's length, so a straight edge rather than texture. The card's
//! outer edge is the outermost such line.
//!
//! ## And refuses to let one side run away
//!
//! "Outermost" alone is wrong in exactly the cases a reader brings to a scanner. Beyond a
//! card's edge there can be another straight line: a **sleeve's** lip, a **shadow**, a seam or
//! a stripe in the **table**, or — the case #710 needs — the edge of **the card underneath** in
//! a stack. Each of those sits beyond *one or two* sides of the card, never symmetrically
//! beyond all four at once, while the card's own border is the same width on opposite sides.
//! So opposite sides are held to the same outward move: a side that reaches further out than
//! its opposite by more than perspective can explain falls back to a line at its opposite's
//! move, or — where the edge is invisible, a black border lying on a black border — to a
//! virtual line at that move. A sleeve, whose lip does sit beyond all four sides, is let
//! through deliberately: its margin is ~2% of the card a side, which the matcher's framings
//! already absorb, and a scan through a sleeve is better framed a little wide than cut into.

use image::RgbImage;
use imageproc::point::Point;

use crate::detect::Quad;

type P = (f32, f32);

/// An infinite line: a point on it and a unit direction.
#[derive(Debug, Clone, Copy)]
struct Line {
    p: P,
    d: P,
}

fn sub(a: P, b: P) -> P {
    (a.0 - b.0, a.1 - b.1)
}

fn add(a: P, b: P) -> P {
    (a.0 + b.0, a.1 + b.1)
}

fn mul(a: P, k: f32) -> P {
    (a.0 * k, a.1 * k)
}

fn dot(a: P, b: P) -> f32 {
    a.0 * b.0 + a.1 * b.1
}

fn cross(a: P, b: P) -> f32 {
    a.0 * b.1 - a.1 * b.0
}

fn norm(a: P) -> f32 {
    dot(a, a).sqrt()
}

fn unit(a: P) -> Option<P> {
    let n = norm(a);
    (n > f32::EPSILON).then(|| mul(a, 1.0 / n))
}

/// Where two lines cross, or `None` for (near-)parallel ones.
fn intersect(a: &Line, b: &Line) -> Option<P> {
    let c = cross(a.d, b.d);
    if c.abs() < 1e-6 {
        return None;
    }
    let t = cross(sub(b.p, a.p), b.d) / c;
    Some(add(a.p, mul(a.d, t)))
}

/// Total least squares: the line minimising perpendicular distance, which — unlike regressing
/// y on x — does not care whether the side is vertical.
fn tls(points: &[P]) -> Option<Line> {
    if points.len() < 2 {
        return None;
    }
    let n = points.len() as f32;
    let (mx, my) = points
        .iter()
        .fold((0.0, 0.0), |s, p| (s.0 + p.0, s.1 + p.1));
    let (mx, my) = (mx / n, my / n);
    let (mut sxx, mut sxy, mut syy) = (0.0f32, 0.0f32, 0.0f32);
    for p in points {
        let (dx, dy) = (p.0 - mx, p.1 - my);
        sxx += dx * dx;
        sxy += dx * dy;
        syy += dy * dy;
    }
    if sxx + syy <= f32::EPSILON {
        return None;
    }
    let theta = 0.5 * (2.0 * sxy).atan2(sxx - syy);
    Some(Line {
        p: (mx, my),
        d: (theta.cos(), theta.sin()),
    })
}

/// One side of a quad, from corner `i` to corner `i + 1`, with its outward normal.
#[derive(Debug, Clone, Copy)]
struct Side {
    a: P,
    b: P,
    /// Unit tangent, `a` towards `b`.
    t: P,
    /// Unit normal pointing *away* from the quad's centre.
    n: P,
    len: f32,
}

impl Side {
    fn at(&self, u: f32, offset: f32) -> P {
        add(
            add(self.a, mul(sub(self.b, self.a), u)),
            mul(self.n, offset),
        )
    }
}

fn centroid(q: &Quad) -> P {
    let c = &q.corners;
    (
        (c[0].0 + c[1].0 + c[2].0 + c[3].0) / 4.0,
        (c[0].1 + c[1].1 + c[2].1 + c[3].1) / 4.0,
    )
}

fn sides(q: &Quad) -> Option<[Side; 4]> {
    let centre = centroid(q);
    let mut out = [Side {
        a: (0.0, 0.0),
        b: (0.0, 0.0),
        t: (0.0, 0.0),
        n: (0.0, 0.0),
        len: 0.0,
    }; 4];
    for (i, s) in out.iter_mut().enumerate() {
        let (a, b) = (q.corners[i], q.corners[(i + 1) % 4]);
        let t = unit(sub(b, a))?;
        let mut n = (t.1, -t.0);
        if dot(n, sub(mul(add(a, b), 0.5), centre)) < 0.0 {
            n = mul(n, -1.0);
        }
        *s = Side {
            a,
            b,
            t,
            n,
            len: norm(sub(b, a)),
        };
    }
    Some(out)
}

/// The card's width in pixels, near enough: the shorter of the two mean opposite-side lengths.
/// Every reach and tolerance below is a fraction of it, so the module is scale-free.
pub(crate) fn scale(q: &Quad) -> f32 {
    let len = |i: usize| norm(sub(q.corners[(i + 1) % 4], q.corners[i]));
    ((len(0) + len(2)) / 2.0).min((len(1) + len(3)) / 2.0)
}

/// Is the quad convex and wound one way? A crossed pair of fitted lines makes a bowtie, which
/// no gate downstream is guaranteed to catch before a homography is built from it.
fn convex(q: &Quad) -> bool {
    let c = &q.corners;
    let signs: Vec<f32> = (0..4)
        .map(|i| {
            cross(
                sub(c[(i + 1) % 4], c[i]),
                sub(c[(i + 2) % 4], c[(i + 1) % 4]),
            )
        })
        .collect();
    signs.iter().all(|&s| s > 0.0) || signs.iter().all(|&s| s < 0.0)
}

/// Corners from four side lines: corner `i` is where side `i - 1` meets side `i`.
fn corners_of(lines: &[Line; 4]) -> Option<Quad> {
    let mut corners = [(0.0, 0.0); 4];
    for (i, c) in corners.iter_mut().enumerate() {
        *c = intersect(&lines[(i + 3) % 4], &lines[i])?;
    }
    let q = Quad { corners };
    convex(&q).then_some(q)
}

/// No corner may move further than this fraction of the card's width from where it started.
/// A fitted corner that does is two nearly parallel lines meeting far away, not a card.
const MAX_CORNER_MOVE: f32 = 0.20;

fn close_to(q: &Quad, seed: &Quad, s: f32) -> bool {
    q.corners
        .iter()
        .zip(&seed.corners)
        .all(|(a, b)| norm(sub(*a, *b)) <= MAX_CORNER_MOVE * s)
}

// ── Step 1: the sides of a contour ──────────────────────────────────────────────────────

/// How much of each side, at each end, is left out of the fit. A card's corner radius is 1/8"
/// on 2.5" — 5% of its width, so ~3.6% of its length — and the arc pulls points off the line
/// for about that far. 10% clears it on both sides with room for the seed's own corners being
/// a little off.
const FIT_END: f32 = 0.10;

/// How far from the seed side a contour point may lie and still belong to it, as a fraction of
/// the card's width. Far enough to cover a seed that is a few pixels off, near enough to leave
/// out a thumb, which is ~15% of a card wide.
const FIT_REACH: f32 = 0.03;

/// Fit a straight line to each side of `seed` from the contour's own points, and put the
/// corners where the lines cross.
///
/// `seed` only says which points belong to which side; it can come from Douglas–Peucker or
/// from a minimum-area rectangle, and two rounds of assign-and-fit move it onto the contour
/// either way. `None` when the contour does not support four sides — the caller keeps the seed.
pub(crate) fn fit_sides(points: &[Point<i32>], seed: &Quad) -> Option<Quad> {
    let mut quad = *seed;
    for _ in 0..2 {
        let s = scale(&quad);
        let sd = sides(&quad)?;
        let reach = (FIT_REACH * s).max(2.0);
        let mut buckets: [Vec<P>; 4] = Default::default();
        for p in points {
            let pf = (p.x as f32, p.y as f32);
            // The side this point is nearest, measured along each side's normal.
            let (best, dist) = sd
                .iter()
                .enumerate()
                .map(|(i, side)| (i, dot(sub(pf, side.a), side.n)))
                .min_by(|x, y| {
                    x.1.abs()
                        .partial_cmp(&y.1.abs())
                        .unwrap_or(std::cmp::Ordering::Equal)
                })?;
            let side = &sd[best];
            let u = dot(sub(pf, side.a), side.t) / side.len;
            if (FIT_END..=1.0 - FIT_END).contains(&u) && dist.abs() <= reach {
                buckets[best].push(pf);
            }
        }
        let mut lines = [Line {
            p: (0.0, 0.0),
            d: (1.0, 0.0),
        }; 4];
        for (i, bucket) in buckets.iter().enumerate() {
            // A side with almost no points of its own is fitted from the seed, not guessed at.
            let min_points = ((sd[i].len * 0.25) as usize).max(6);
            lines[i] = if bucket.len() >= min_points {
                trimmed_fit(bucket)?
            } else {
                Line {
                    p: sd[i].a,
                    d: sd[i].t,
                }
            };
        }
        let next = corners_of(&lines)?;
        if !close_to(&next, &quad, s) {
            return None;
        }
        quad = next;
    }
    Some(quad)
}

/// A line fit that drops its own outliers once: fit, discard anything well off the line, refit.
///
/// One round is enough here because the reach in [`fit_sides`] already bounds how bad an
/// outlier can be; what is left is a shadow notch or a sleeve lip a few pixels proud.
fn trimmed_fit(points: &[P]) -> Option<Line> {
    let first = tls(points)?;
    let normal = (-first.d.1, first.d.0);
    let mut residuals: Vec<f32> = points
        .iter()
        .map(|p| dot(sub(*p, first.p), normal).abs())
        .collect();
    let mut sorted = residuals.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = sorted[sorted.len() / 2];
    let cut = (2.5 * median).max(1.0);
    let kept: Vec<P> = points
        .iter()
        .zip(residuals.drain(..))
        .filter(|(_, r)| *r <= cut)
        .map(|(p, _)| *p)
        .collect();
    if kept.len() < points.len() / 2 {
        return Some(first);
    }
    tls(&kept)
}

// ── Step 2: the outer edge ──────────────────────────────────────────────────────────────

/// Profiles per side. Enough that a thumb or a glare covering a third of a side still leaves a
/// majority, few enough that four sides of eight candidates cost well under a millisecond.
const SAMPLES: usize = 32;
/// Where along a side the profiles sit — clear of the rounded corners at both ends.
const SPAN: (f32, f32) = (0.12, 0.88);
/// How far inside the seed side to look, as a fraction of the card's width. Far enough to find
/// the card's inner border line when the seed was already on the outer edge, which is what lets
/// a lopsided seed be told from a side that ran away.
const REACH_IN: f32 = 0.06;
/// How far outside. A black border is 4–6% of a card's width depending on the frame, and the
/// seed is often on its inner edge. **13%, not the 9% a border alone needs**: a full-art basic's
/// bottom is a black band nearer 6% wide below its frame line, and a contour on that line put the
/// outer edge 34 px out on a 300 px card — measured on Plains HOB 320, 9 px off on every frame.
const REACH_OUT: f32 = 0.13;
/// A line is an edge only if most of the side agrees on it. Texture — a painted table, value
/// noise, a card's own art — produces peaks everywhere and lines nowhere.
const MIN_SUPPORT: f32 = 0.5;
/// The weakest gradient worth calling a peak, in RGB units per pixel. JPEG noise on a flat
/// surface stays under ~6.
const PEAK_MIN: f32 = 8.0;
/// A line this much weaker than the side's strongest is not an edge of the card: a wood grain
/// or the faint lip of a clear sleeve.
const REL_STRENGTH: f32 = 0.2;
/// The steepest tilt, relative to the seed side, a line may take. The seed comes from a fitted
/// contour, so the true edge is nearly parallel to it — but not always *that* nearly: a contour
/// run along a full-art basic's bottom band leaned 3–5% off the card's edge (Plains HOB 320),
/// and at 4% the edge was never offered. Half the side still has to agree with a line.
const MAX_TILT: f32 = 0.07;
/// Opposite sides may disagree about how far out the edge is by this fraction of the card's
/// width plus 1.5 px before one is judged to have run away. Perspective makes a border up to
/// ~15% wider on the near side than the far one — well under 1% of the card — and a card
/// offset in a stack by a millimetre and a half is 2.4%.
const PAIR_TOL: f32 = 0.018;

/// A straight edge found across one side: its offset from the seed side at either end.
#[derive(Debug, Clone, Copy, PartialEq)]
struct EdgeLine {
    /// Offset along the outward normal at `u = 0` and `u = 1`, in pixels.
    o0: f32,
    o1: f32,
    /// Share of the side's profiles that agree with it.
    support: f32,
    /// Mean gradient of the agreeing peaks.
    strength: f32,
}

impl EdgeLine {
    fn mean(&self) -> f32 {
        (self.o0 + self.o1) / 2.0
    }

    fn at(&self, u: f32) -> f32 {
        self.o0 + (self.o1 - self.o0) * u
    }

    fn flat(offset: f32) -> EdgeLine {
        EdgeLine {
            o0: offset,
            o1: offset,
            support: 0.0,
            strength: 0.0,
        }
    }
}

/// What the outer-edge search decided for one side. Kept for the debug trace: a quad that
/// landed wrong is legible only if it says which sides found an edge and which were guessed.
#[derive(Debug, Clone, Copy, Default, PartialEq, serde::Serialize)]
pub struct SideEdge {
    /// Straight edges found across this side.
    pub lines: u8,
    /// How far the side moved outward from the contour, in source pixels. Negative is inward.
    pub moved: f32,
    /// Share of profiles that agreed with the chosen edge; 0 for a virtual one.
    pub support: f32,
    /// The outermost edge on this side reached further than its opposite side's and was
    /// refused — a sleeve lip, a shadow, a table line, or the card beneath in a stack.
    pub guarded: bool,
    /// No edge was visible where the side had to be, so it was placed at its opposite's move.
    #[serde(rename = "virtual")]
    pub is_virtual: bool,
}

/// A quad moved onto the card's outer edge, and what each side found.
#[derive(Debug, Clone, Copy)]
pub struct Refined {
    pub quad: Quad,
    pub sides: [SideEdge; 4],
}

/// Bilinear RGB at a sub-pixel position; `None` off the image.
fn sample(img: &RgbImage, p: P) -> Option<[f32; 3]> {
    let (w, h) = img.dimensions();
    if !(p.0 >= 0.0 && p.1 >= 0.0) {
        return None;
    }
    let (x0, y0) = (p.0.floor() as u32, p.1.floor() as u32);
    if x0 + 1 >= w || y0 + 1 >= h {
        return None;
    }
    let (fx, fy) = (p.0 - x0 as f32, p.1 - y0 as f32);
    let px = |x: u32, y: u32| img.get_pixel(x, y).0;
    let (a, b, c, d) = (
        px(x0, y0),
        px(x0 + 1, y0),
        px(x0, y0 + 1),
        px(x0 + 1, y0 + 1),
    );
    let mut out = [0.0f32; 3];
    for (ch, o) in out.iter_mut().enumerate() {
        let top = f32::from(a[ch]) * (1.0 - fx) + f32::from(b[ch]) * fx;
        let bottom = f32::from(c[ch]) * (1.0 - fx) + f32::from(d[ch]) * fx;
        *o = top * (1.0 - fy) + bottom * fy;
    }
    Some(out)
}

/// Mean colour of a band running along `line` on `side`, between two offsets from it (positive
/// is outward), over the middle of the side. `None` when most of it is off the image.
fn strip(img: &RgbImage, side: &Side, line: &EdgeLine, from: f32, to: f32) -> Option<[f32; 3]> {
    let (mut sum, mut n, mut tried) = ([0.0f32; 3], 0.0f32, 0.0f32);
    let steps = ((to - from).abs().ceil() as usize).clamp(1, 8);
    for j in 0..16 {
        let u = 0.15 + 0.7 * (j as f32 + 0.5) / 16.0;
        for k in 0..steps {
            let off = from + (to - from) * (k as f32 + 0.5) / steps as f32;
            tried += 1.0;
            if let Some(v) = sample(img, side.at(u, line.at(u) + off)) {
                for ch in 0..3 {
                    sum[ch] += v[ch];
                }
                n += 1.0;
            }
        }
    }
    (n >= tried / 2.0).then(|| sum.map(|v| v / n))
}

fn rgb_dist(a: [f32; 3], b: [f32; 3]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

/// One peak on one profile: where it is along the normal, and how strong.
#[derive(Debug, Clone, Copy)]
struct Peak {
    offset: f32,
    strength: f32,
}

/// The gradient peaks along one profile across the side at `u`.
///
/// Colour distance rather than luma, because the edges that matter are not all luma edges: a
/// blue sleeve on a brown table can be nearly isoluminant. Each profile is the mean of three
/// parallel lines a pixel and a half apart, which is what keeps JPEG blocking from making
/// peaks of its own.
fn peaks(
    img: &RgbImage,
    side: &Side,
    u: f32,
    reach_in: f32,
    reach_out: f32,
    step: f32,
) -> Vec<Peak> {
    let k_in = (reach_in / step).ceil() as i32 + 1;
    let k_out = (reach_out / step).ceil() as i32 + 1;
    let values: Vec<Option<[f32; 3]>> = (-k_in..=k_out)
        .map(|k| {
            let mut sum = [0.0f32; 3];
            for tau in [-1.5f32, 0.0, 1.5] {
                let p = add(side.at(u, k as f32 * step), mul(side.t, tau));
                let v = sample(img, p)?;
                for ch in 0..3 {
                    sum[ch] += v[ch] / 3.0;
                }
            }
            Some(sum)
        })
        .collect();
    let grad: Vec<Option<f32>> = (0..values.len())
        .map(|i| {
            if i == 0 || i + 1 >= values.len() {
                return None;
            }
            Some(rgb_dist(values[i + 1]?, values[i - 1]?) / (2.0 * step))
        })
        .collect();
    let mut out: Vec<Peak> = Vec::new();
    for i in 1..grad.len().saturating_sub(1) {
        let (Some(l), Some(g), Some(r)) = (grad[i - 1], grad[i], grad[i + 1]) else {
            continue;
        };
        if g < PEAK_MIN || g < l || g < r {
            continue;
        }
        // A parabola through the three samples puts the peak between them.
        let denom = l - 2.0 * g + r;
        let delta = if denom.abs() > f32::EPSILON {
            (0.5 * (l - r) / denom).clamp(-0.5, 0.5)
        } else {
            0.0
        };
        let k = (i as i32 - k_in) as f32 + delta;
        out.push(Peak {
            offset: k * step,
            strength: g,
        });
    }
    out.sort_by(|a, b| {
        b.strength
            .partial_cmp(&a.strength)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out.truncate(5);
    out
}

/// Every straight edge across one side, outermost first.
fn edge_lines(img: &RgbImage, side: &Side, s: f32) -> Vec<EdgeLine> {
    let step = (s / 350.0).max(1.0);
    let (reach_in, reach_out) = (REACH_IN * s + 2.0, REACH_OUT * s + 2.0);
    let us: Vec<f32> = (0..SAMPLES)
        .map(|j| SPAN.0 + (SPAN.1 - SPAN.0) * (j as f32 + 0.5) / SAMPLES as f32)
        .collect();
    let profiles: Vec<Vec<Peak>> = us
        .iter()
        .map(|&u| peaks(img, side, u, reach_in, reach_out, step))
        .collect();
    let tol = 1.0 + 0.004 * s;
    let max_slope = MAX_TILT * side.len;

    // The nearest peak on profile `j` to the line, if it is close enough.
    let inlier = |line: &EdgeLine, j: usize| -> Option<Peak> {
        let want = line.at(us[j]);
        profiles[j]
            .iter()
            .filter(|p| (p.offset - want).abs() <= tol)
            .min_by(|a, b| {
                (a.offset - want)
                    .abs()
                    .partial_cmp(&(b.offset - want).abs())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .copied()
    };
    let judge = |line: EdgeLine| -> EdgeLine {
        let hits: Vec<Peak> = (0..SAMPLES).filter_map(|j| inlier(&line, j)).collect();
        let strength = if hits.is_empty() {
            0.0
        } else {
            hits.iter().map(|p| p.strength).sum::<f32>() / hits.len() as f32
        };
        EdgeLine {
            support: hits.len() as f32 / SAMPLES as f32,
            strength,
            ..line
        }
    };

    // Hypotheses from pairs of profiles half a side apart — deterministic, and far enough apart
    // that two peaks on them pin the line's tilt well.
    let half = SAMPLES / 2;
    let mut hypotheses: Vec<EdgeLine> = Vec::new();
    for j in 0..half {
        let k = j + half;
        for p in &profiles[j] {
            for q in &profiles[k] {
                let slope = (q.offset - p.offset) / (us[k] - us[j]);
                if slope.abs() > max_slope {
                    continue;
                }
                let o0 = p.offset - slope * us[j];
                let h = judge(EdgeLine {
                    o0,
                    o1: o0 + slope,
                    support: 0.0,
                    strength: 0.0,
                });
                if h.support >= MIN_SUPPORT {
                    hypotheses.push(h);
                }
            }
        }
    }
    hypotheses.sort_by(|a, b| {
        b.support
            .partial_cmp(&a.support)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                b.strength
                    .partial_cmp(&a.strength)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });

    // Suppress near-duplicates, then refit each survivor to its own inliers by least squares.
    let mut lines: Vec<EdgeLine> = Vec::new();
    for h in hypotheses {
        if lines
            .iter()
            .any(|l| (l.mean() - h.mean()).abs() <= 2.0 * tol)
        {
            continue;
        }
        let pts: Vec<(f32, f32)> = (0..SAMPLES)
            .filter_map(|j| inlier(&h, j).map(|p| (us[j], p.offset)))
            .collect();
        let refit = fit_offset(&pts).map_or(h, |(o0, o1)| judge(EdgeLine { o0, o1, ..h }));
        let best = if refit.support >= h.support { refit } else { h };
        if !lines
            .iter()
            .any(|l| (l.mean() - best.mean()).abs() <= 2.0 * tol)
        {
            lines.push(best);
        }
        if lines.len() >= 6 {
            break;
        }
    }
    let strongest = lines.iter().map(|l| l.strength).fold(0.0, f32::max);
    lines.retain(|l| l.strength >= REL_STRENGTH * strongest);
    lines.sort_by(|a, b| {
        b.mean()
            .partial_cmp(&a.mean())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    lines
}

/// Least squares of offset on `u`: the line's offset at `u = 0` and `u = 1`.
fn fit_offset(pts: &[(f32, f32)]) -> Option<(f32, f32)> {
    if pts.len() < 2 {
        return None;
    }
    let n = pts.len() as f32;
    let (mu, mo) = pts.iter().fold((0.0, 0.0), |s, p| (s.0 + p.0, s.1 + p.1));
    let (mu, mo) = (mu / n, mo / n);
    let (mut suu, mut suo) = (0.0f32, 0.0f32);
    for (u, o) in pts {
        suu += (u - mu) * (u - mu);
        suo += (u - mu) * (o - mo);
    }
    if suu <= f32::EPSILON {
        return None;
    }
    let slope = suo / suu;
    let o0 = mo - slope * mu;
    Some((o0, o0 + slope))
}

/// Move `seed` — in **source** coordinates — onto the card's outer edge.
///
/// `None` when the seed is degenerate or the result is not a convex quad near it; the caller
/// then keeps the seed. A side with no visible edge at all keeps the seed's own line unless its
/// opposite moved, in which case it moves with it — see the module note.
pub fn refine(img: &RgbImage, seed: &Quad) -> Option<Refined> {
    let s = scale(seed);
    if s < 12.0 {
        return None;
    }
    let sd = sides(seed)?;
    let found: Vec<Vec<EdgeLine>> = sd.iter().map(|side| edge_lines(img, side, s)).collect();

    let mut chosen: [Option<EdgeLine>; 4] = [0, 1, 2, 3].map(|i| found[i].first().copied());
    let mut report: [SideEdge; 4] = [0, 1, 2, 3].map(|i| SideEdge {
        lines: found[i].len() as u8,
        ..Default::default()
    });

    // Opposite sides are held to the same outward move. See the module note for why.
    let tol = 1.5 + PAIR_TOL * s;
    let band = 0.025 * s;
    for (a, b) in [(0usize, 2usize), (1, 3)] {
        match (chosen[a], chosen[b]) {
            (Some(la), Some(lb)) if (la.mean() - lb.mean()).abs() > tol => {
                let (far, near) = if la.mean() > lb.mean() {
                    (a, b)
                } else {
                    (b, a)
                };
                let (l_far, l_near) = (chosen[far].unwrap(), chosen[near].unwrap());
                // **A lopsided seed is not a runaway side.** A contour can follow the outer edge
                // down one side and the border's inner edge down the other — measured on Plains
                // HOB 320, whose black bottom band Otsu split along its frame line — so the two
                // sides move by different amounts to reach the same card, and holding the moves
                // equal pulls the good side back in. Comparing moves is only sound when the seed
                // was the same kind of line on both sides, which the colour just outside it says:
                // the border's inner edge has border beyond it, the outer edge the table. A seed
                // that differs there, whose two chosen edges look alike inside and out, has found
                // two outer edges of one card, and neither is moved. A stack's top card, whose
                // contour ran round its inner border, has border beyond every side of its seed,
                // so the guard below still applies to it.
                let beyond_seed =
                    |i: usize| strip(img, &sd[i], &EdgeLine::flat(0.0), 2.0, 2.0 + band);
                let lopsided = matches!((beyond_seed(far), beyond_seed(near)), (Some(x), Some(y)) if !same(x, y));
                if lopsided {
                    let look = |i: usize, l: &EdgeLine| {
                        (
                            strip(img, &sd[i], l, -2.0 - band, -2.0),
                            strip(img, &sd[i], l, 2.0, 2.0 + band),
                        )
                    };
                    let alike = match (look(far, &l_far), look(near, &l_near)) {
                        ((Some(fi), Some(fo)), (Some(ni), Some(no))) => {
                            same(fi, ni) && same(fo, no)
                        }
                        _ => false,
                    };
                    if alike {
                        continue;
                    }
                }
                // **Which of the two is wrong is a question about colour, not distance.** The
                // far side may have run out onto a sleeve lip, a shadow or the card beneath —
                // or the near side may have stopped on the *inner* edge of the border because
                // its outer edge is invisible: a black border lying on the black border of the
                // card underneath. In the second case the border carries on past the near
                // side's line, so what lies just beyond it is the colour of the far side's
                // border band. In the first it is the table, the sleeve or the lower card's
                // face, which is not.
                let beyond_near = strip(img, &sd[near], &l_near, 2.0, 2.0 + band);
                let border_far = strip(img, &sd[far], &l_far, -2.0 - band, -2.0);
                let near_is_inner =
                    matches!((beyond_near, border_far), (Some(x), Some(y)) if same(x, y));
                let (mover, target) = if near_is_inner {
                    (near, l_far.mean())
                } else {
                    (far, l_near.mean())
                };
                report[mover].guarded = true;
                // A real edge at the target move, if this side has one; the best-supported.
                let real = found[mover]
                    .iter()
                    .filter(|l| (l.mean() - target).abs() <= tol)
                    .max_by(|x, y| {
                        x.support
                            .partial_cmp(&y.support)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
                    .copied();
                chosen[mover] = Some(real.unwrap_or_else(|| {
                    report[mover].is_virtual = true;
                    EdgeLine::flat(target)
                }));
            }
            (Some(_), Some(_)) => {}
            (Some(l), None) => {
                report[b].is_virtual = true;
                chosen[b] = Some(EdgeLine::flat(l.mean()));
            }
            (None, Some(l)) => {
                report[a].is_virtual = true;
                chosen[a] = Some(EdgeLine::flat(l.mean()));
            }
            (None, None) => {}
        }
    }

    let mut lines = [Line {
        p: (0.0, 0.0),
        d: (1.0, 0.0),
    }; 4];
    for i in 0..4 {
        let e = chosen[i].unwrap_or(EdgeLine::flat(0.0));
        report[i].moved = e.mean();
        report[i].support = e.support;
        let (p0, p1) = (sd[i].at(0.0, e.o0), sd[i].at(1.0, e.o1));
        lines[i] = Line {
            p: p0,
            d: unit(sub(p1, p0))?,
        };
    }
    let quad = corners_of(&lines)?;
    close_to(&quad, seed, s).then_some(Refined {
        quad,
        sides: report,
    })
}

// ── Which of two nested quads is the card ───────────────────────────────────────────────

/// Mean colour over a small square patch, `None` if any of it is off the image.
fn patch(img: &RgbImage, at: P, spacing: f32) -> Option<[f32; 3]> {
    let mut sum = [0.0f32; 3];
    let mut n = 0.0;
    for dy in -2..=2 {
        for dx in -2..=2 {
            let v = sample(
                img,
                (at.0 + dx as f32 * spacing, at.1 + dy as f32 * spacing),
            )?;
            for ch in 0..3 {
                sum[ch] += v[ch];
            }
            n += 1.0;
        }
    }
    Some(sum.map(|v| v / n))
}

/// Colour distance under which two patches are the same surface, as mean absolute difference.
const SAME: f32 = 20.0;

fn same(a: [f32; 3], b: [f32; 3]) -> bool {
    ((a[0] - b[0]).abs() + (a[1] - b[1]).abs() + (a[2] - b[2]).abs()) / 3.0 < SAME
}

/// How many of the quad's corners hold no card — the surface outside the corner continues into
/// it, and it looks like neither of the card's two sides beside it.
///
/// **This is what tells a stack's outline from its top card.** A stack whose lower card peeks
/// out diagonally has an outline that is card-shaped to within a percent of aspect, so no shape
/// test can reject it — but two of its four corners are *empty*: the outline's corner lies
/// beyond the top card on one axis and beyond the lower card on the other, over the table. A
/// real card's corner is card right into its rounded tip.
///
/// The probe sits 2.5% of the card's width in along each axis — past a rounded corner's arc
/// (which reaches 1.5% in) and inside even a thin border. Anything ambiguous reads as not
/// empty: a thumb over a corner looks like the surface outside it only when it also covers the
/// border beside it, and a black card on a black table is the same colour everywhere.
pub(crate) fn empty_corners(img: &RgbImage, q: &Quad) -> usize {
    let s = scale(q);
    let spacing = (s / 200.0).max(1.0);
    (0..4)
        .filter(|&i| {
            let c = q.corners[i];
            let (Some(next), Some(prev)) = (
                unit(sub(q.corners[(i + 1) % 4], c)),
                unit(sub(q.corners[(i + 3) % 4], c)),
            ) else {
                return false;
            };
            let Some(bisector) = unit(add(next, prev)) else {
                return false;
            };
            // Along the bisector, so the probe is equally far in from both sides.
            let depth = 0.025 * s * std::f32::consts::SQRT_2;
            let probe = |p: P| patch(img, p, spacing);
            let (Some(inside), Some(outside)) = (
                probe(add(c, mul(bisector, depth))),
                probe(sub(c, mul(bisector, depth))),
            ) else {
                return false;
            };
            let len_next = norm(sub(q.corners[(i + 1) % 4], c));
            let len_prev = norm(sub(q.corners[(i + 3) % 4], c));
            let along =
                |dir: P, len: f32, other: P| add(add(c, mul(dir, 0.2 * len)), mul(other, 0.02 * s));
            let (Some(side_a), Some(side_b)) = (
                probe(along(next, len_next, prev)),
                probe(along(prev, len_prev, next)),
            ) else {
                return false;
            };
            same(inside, outside) && !same(inside, side_a) && !same(inside, side_b)
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    const TABLE: [u8; 3] = [150, 120, 90];

    /// A black-bordered card, axis-aligned or not, drawn by inverse mapping every pixel into
    /// card space so its edges are exact.
    fn card_on(img: &mut RgbImage, centre: P, width: f32, angle: f32, border: f32) -> Quad {
        let h = width / crate::CARD_ASPECT;
        let (s, c) = angle.sin_cos();
        let (w_img, h_img) = img.dimensions();
        for y in 0..h_img {
            for x in 0..w_img {
                // Supersample 3×3 so the edge is anti-aliased like a camera's.
                let mut cover = [0.0f32; 3];
                let mut hits = 0.0;
                for sy in 0..3 {
                    for sx in 0..3 {
                        let (px, py) = (
                            x as f32 + (sx as f32 + 0.5) / 3.0,
                            y as f32 + (sy as f32 + 0.5) / 3.0,
                        );
                        let (dx, dy) = (px - centre.0, py - centre.1);
                        let (rx, ry) = (dx * c + dy * s, -dx * s + dy * c);
                        if rx.abs() <= width / 2.0 && ry.abs() <= h / 2.0 {
                            let inner =
                                rx.abs() <= width / 2.0 - border && ry.abs() <= h / 2.0 - border;
                            let v = if inner {
                                [200.0, 190.0, 170.0]
                            } else {
                                [18.0, 18.0, 20.0]
                            };
                            for ch in 0..3 {
                                cover[ch] += v[ch];
                            }
                            hits += 1.0;
                        }
                    }
                }
                if hits > 0.0 {
                    let bg = img.get_pixel(x, y).0;
                    let px = [0, 1, 2].map(|ch| {
                        ((cover[ch] + (9.0 - hits) * f32::from(bg[ch])) / 9.0).round() as u8
                    });
                    img.put_pixel(x, y, Rgb(px));
                }
            }
        }
        let corner = |x: f32, y: f32| (centre.0 + x * c - y * s, centre.1 + x * s + y * c);
        let (hw, hh) = (width / 2.0, h / 2.0);
        Quad {
            corners: [
                corner(-hw, -hh),
                corner(hw, -hh),
                corner(hw, hh),
                corner(-hw, hh),
            ],
        }
    }

    /// The same quad with every side moved `by` pixels inward — a border's inner edge.
    fn inset_by(q: &Quad, by: f32) -> Quad {
        let sd = sides(q).unwrap();
        let lines = [0, 1, 2, 3].map(|i| Line {
            p: sd[i].at(0.0, -by),
            d: sd[i].t,
        });
        corners_of(&lines).unwrap()
    }

    fn max_corner_error(a: &Quad, b: &Quad) -> f32 {
        a.corners
            .iter()
            .zip(&b.corners)
            .map(|(p, q)| norm(sub(*p, *q)))
            .fold(0.0, f32::max)
    }

    fn contour_of(q: &Quad, radius: f32) -> Vec<Point<i32>> {
        // The rounded outline of a card, one point per pixel of perimeter.
        let mut pts = Vec::new();
        for i in 0..4 {
            let (a, b) = (q.corners[i], q.corners[(i + 1) % 4]);
            let len = norm(sub(b, a));
            let t = unit(sub(b, a)).unwrap();
            for k in 0..len as i32 {
                let f = k as f32;
                // Pull points near either corner inward along the arc, as a rounded corner does.
                let from_end = f.min(len - f);
                let sag = if from_end < radius {
                    radius
                        - (radius * radius - (radius - from_end).powi(2))
                            .max(0.0)
                            .sqrt()
                } else {
                    0.0
                };
                let centre = centroid(q);
                let inward = unit(sub(centre, add(a, mul(t, f)))).unwrap();
                let p = add(add(a, mul(t, f)), mul(inward, sag));
                pts.push(Point::new(p.0.round() as i32, p.1.round() as i32));
            }
        }
        pts
    }

    #[test]
    fn fitted_sides_land_on_the_sharp_corners_of_a_rounded_card() {
        let truth = Quad {
            corners: [(100.0, 80.0), (300.0, 90.0), (290.0, 370.0), (95.0, 360.0)],
        };
        let pts = contour_of(&truth, 12.0);
        // A seed off by several pixels, as Douglas–Peucker on the arcs gives.
        let seed = Quad {
            corners: [(106.0, 86.0), (294.0, 95.0), (285.0, 364.0), (100.0, 355.0)],
        };
        let fitted = fit_sides(&pts, &seed).expect("four sides fit");
        let err = max_corner_error(&fitted, &truth);
        assert!(
            err < 1.5,
            "fitted corners are {err:.2} px from the sharp corners"
        );
    }

    #[test]
    fn a_thumb_on_one_side_does_not_bend_it() {
        let truth = Quad {
            corners: [(100.0, 80.0), (300.0, 80.0), (300.0, 360.0), (100.0, 360.0)],
        };
        let mut pts = contour_of(&truth, 10.0);
        // A thumb: a bump 25 px proud of the right side over a sixth of its length.
        pts.retain(|p| !(p.x >= 299 && (180..=230).contains(&p.y)));
        for y in 180..=230 {
            pts.push(Point::new(325, y));
        }
        let fitted = fit_sides(&pts, &truth).expect("four sides fit");
        assert!(max_corner_error(&fitted, &truth) < 1.5, "{fitted:?}");
    }

    #[test]
    fn the_outer_edge_is_found_from_the_inner_border() {
        let mut img = RgbImage::from_pixel(640, 640, Rgb(TABLE));
        let truth = card_on(&mut img, (320.0, 320.0), 280.0, 0.3, 14.0);
        let s = scale(&truth);
        // The seed Canny hands over: the inner edge of the border, 14 px in on every side.
        let inner = inset_by(&truth, 14.0);
        let r = refine(&img, &inner).expect("refines");
        let err = max_corner_error(&r.quad, &truth);
        assert!(
            err < 1.5,
            "refined corners are {err:.2} px from the card's ({s:.0} px wide)"
        );
        assert!(
            r.sides.iter().all(|e| !e.guarded && !e.is_virtual),
            "{:?}",
            r.sides
        );
    }

    #[test]
    fn a_seed_already_on_the_outer_edge_stays_there() {
        let mut img = RgbImage::from_pixel(640, 640, Rgb(TABLE));
        let truth = card_on(&mut img, (320.0, 320.0), 260.0, -0.5, 13.0);
        let r = refine(&img, &truth).expect("refines");
        assert!(max_corner_error(&r.quad, &truth) < 1.5, "{:?}", r.quad);
    }

    #[test]
    fn the_card_beneath_in_a_stack_does_not_pull_a_side_out() {
        let mut img = RgbImage::from_pixel(700, 700, Rgb(TABLE));
        // The lower card first, offset diagonally by 10 px (2.5 mm on a 63 mm card at this
        // size), then the top card over it.
        card_on(&mut img, (360.0, 360.0), 250.0, 0.0, 12.0);
        let truth = card_on(&mut img, (350.0, 350.0), 250.0, 0.0, 12.0);
        let inner = inset_by(&truth, 12.0);
        let r = refine(&img, &inner).expect("refines");
        let err = max_corner_error(&r.quad, &truth);
        assert!(
            err < 2.5,
            "the refined quad is {err:.2} px off the top card: {:?}",
            r.sides
        );
        assert!(
            r.sides.iter().any(|e| e.guarded),
            "no side was guarded: {:?}",
            r.sides
        );
    }

    #[test]
    fn a_border_on_a_border_extends_the_side_rather_than_pulling_the_other_in() {
        // **The measured failure this exists for** (the stacked scene, Dark Privilege MGB 3,
        // every frame): the lower card sits far enough out that its own edge is beyond the
        // search, so on the two sides over it the top card's outer edge is black on black and
        // invisible. Those sides stop on the inner edge of the border — and holding the other
        // two to them pulled the whole quad onto the border's inner edge, 26 px off.
        let mut img = RgbImage::from_pixel(760, 760, Rgb(TABLE));
        card_on(&mut img, (400.0, 400.0), 250.0, 0.0, 12.0);
        let truth = card_on(&mut img, (370.0, 370.0), 250.0, 0.0, 12.0);
        let r = refine(&img, &inset_by(&truth, 12.0)).expect("refines");
        let err = max_corner_error(&r.quad, &truth);
        assert!(
            err < 2.5,
            "the refined quad is {err:.2} px off the top card: {:?}",
            r.sides
        );
    }

    #[test]
    fn a_lopsided_seed_lands_on_both_outer_edges() {
        // **Measured on Plains HOB 320**: Otsu's region followed the outer edge down the left
        // side and the border's inner edge down the right, so the right side had to move a
        // border's width and the left none. Holding the moves equal pulled the right side back
        // onto the border's inner edge, 9 px off on every frame.
        let mut img = RgbImage::from_pixel(640, 640, Rgb(TABLE));
        let truth = card_on(&mut img, (320.0, 320.0), 260.0, 0.1, 13.0);
        let sd = sides(&truth).unwrap();
        let lines = [0, 1, 2, 3].map(|i| {
            let by = if i == 1 { -13.0 } else { 0.0 };
            Line {
                p: sd[i].at(0.0, by),
                d: sd[i].t,
            }
        });
        let seed = corners_of(&lines).unwrap();
        let r = refine(&img, &seed).expect("refines");
        let err = max_corner_error(&r.quad, &truth);
        assert!(
            err < 2.0,
            "the refined quad is {err:.2} px off the card: {:?}",
            r.sides
        );
    }

    #[test]
    fn a_stack_outline_has_empty_corners_and_its_top_card_has_none() {
        let mut img = RgbImage::from_pixel(700, 700, Rgb(TABLE));
        let lower = card_on(&mut img, (366.0, 366.0), 250.0, 0.0, 12.0);
        let top = card_on(&mut img, (350.0, 350.0), 250.0, 0.0, 12.0);
        let outline = Quad {
            corners: [
                top.corners[0],
                (lower.corners[1].0, top.corners[1].1),
                lower.corners[2],
                (top.corners[3].0, lower.corners[3].1),
            ],
        };
        assert_eq!(
            empty_corners(&img, &top),
            0,
            "the top card read as having an empty corner"
        );
        assert_eq!(
            empty_corners(&img, &outline),
            2,
            "the stack's outline should have two empty corners"
        );
    }
}
