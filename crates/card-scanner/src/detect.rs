//! Tier 0 — find the card in the frame and flatten it.
//!
//! Everything downstream assumes a rectified card, so this module is the one the whole
//! pipeline rests on. A wrong quad here is not a degraded match, it is a meaningless one.
//!
//! **Deskew, rotation and scale are not separate stages.** A single homography handles all
//! three at once, which is why there is no `rotate` step below: once four corner
//! correspondences are known, [`imageproc`]'s `Projection::from_control_points` and one
//! `warp_into` produce the flattened card directly.
//!
//! ## Two detectors, on purpose
//!
//! [`EdgeMethod::Canny`] finds gradient edges; [`EdgeMethod::Otsu`] splits the frame into
//! light and dark by a global threshold and treats the card as a filled region. Which one
//! wins is a property of the *photograph* rather than of the algorithm — Canny handles a busy
//! or textured background that Otsu smears into one blob, and Otsu handles a low-contrast
//! card edge on a plain background where Canny finds no continuous boundary. Both are
//! implemented and selected by flag, and the sample corpus decides. Guessing here would have
//! meant tuning one detector against scans that suit the other.
//!
//! Otsu is run in **both polarities**, because whether a card is lighter or darker than what
//! it sits on is not knowable in advance — a card on a dark playmat and the same card on a
//! white desk invert each other. Trying one polarity is a detector that works on half of all
//! tables for no visible reason.
//!
//! ## Two traps this module exists to avoid
//!
//! **`warp` returns an image the size of its input**, not the size you want, and its
//! projection maps *input to output* — the opposite of the "where did this output pixel come
//! from" convention. Both are easy to get backwards and neither fails loudly. [`rectify`]
//! uses `warp_into` against a preallocated [`crate::RECTIFIED_W`]×[`crate::RECTIFIED_H`]
//! buffer for the first reason and orders its control points source-then-destination for the
//! second.
//!
//! **A card is 180°-symmetric.** 63×88 mm has no orientation, so a quad tells you the
//! rectangle but never which end is the top. A card photographed upside-down rectifies
//! perfectly and then matches nothing at all. [`Detection`] therefore carries *both*
//! orientations and the caller hashes both — one extra scan, which against a brute-force
//! Hamming search costs nothing measurable.

use image::{DynamicImage, GenericImageView, GrayImage, Rgb, RgbImage};
use imageproc::contours::find_contours;
use imageproc::contrast::{otsu_level, threshold, ThresholdType};
use imageproc::distance_transform::Norm;
use imageproc::geometric_transformations::{warp_into, Border, Interpolation, Projection};
use imageproc::geometry::{convex_hull, min_area_rect};
use imageproc::point::Point;

use crate::{CARD_ASPECT, RECTIFIED_H, RECTIFIED_W};

/// How the card's boundary is separated from its background.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeMethod {
    /// Gradient edges, then a morphological close to bridge the gaps Canny leaves at a
    /// corner. Better on a textured or busy background.
    Canny,
    /// A global light/dark split, run in both polarities. Better on a plain background,
    /// including the low-contrast case where a card edge produces no strong gradient.
    Otsu,
}

impl EdgeMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            EdgeMethod::Canny => "canny",
            EdgeMethod::Otsu => "otsu",
        }
    }
}

#[derive(Debug, Clone)]
pub struct DetectOptions {
    pub method: EdgeMethod,
    /// The long edge of the image detection actually runs on.
    ///
    /// Detection does not need the sensor's resolution — it needs a boundary — and the cost
    /// of every stage here is linear in pixel count. The full-resolution frame is still what
    /// gets warped, so nothing is lost for OCR downstream: only the *search* is cheap.
    ///
    /// **1024, measured, and both neighbours are worse.** Across the 43 sample scans: 640
    /// found 35 cards, 1024 found 39, 1600 found 37. The floor is that a card occupying a
    /// tenth of the frame is only ~150 px wide at 640, which puts its edge within two or
    /// three pixels of whatever it sits on — close enough for the morphological close below
    /// to weld the two into one contour. The ceiling is that above ~1024 a card's own art
    /// texture starts resolving into competing contours of its own.
    pub work_long_edge: u32,
    pub canny_low: f32,
    pub canny_high: f32,
    /// Smallest quad worth considering, as a fraction of the frame's area. A card that
    /// occupies less than this is too small to read anyway.
    pub min_area_frac: f32,
    /// Largest quad worth considering.
    ///
    /// **This exists because of a measured failure, not a hypothetical one.** A 3000×4000
    /// phone photo has an aspect of 0.75; a card's is 0.7159. That is a 4.8% error — well
    /// inside any useful [`DetectOptions::aspect_tolerance`] — so *the photograph's own
    /// border is a near-perfect card*. On the first run against real scans, 17 of 18 frames
    /// "detected" the image boundary instead of the card and reported a 94% success rate
    /// while getting every single one wrong. [`touches_border`] is the primary defence; this
    /// is the backstop.
    pub max_area_frac: f32,
    /// How far from 63:88 a quad's aspect may stray and still be called a card, as a
    /// fraction of [`CARD_ASPECT`].
    ///
    /// Perspective genuinely distorts this, so it cannot be tight — but it was 0.30 on the
    /// first run against real scans and that admits anything from 0.50 to 0.93, which is to
    /// say most convex quadrilaterals. A card's inner text box measured 0.886 and won.
    pub aspect_tolerance: f32,
    /// Worst permitted deviation from 90° at any corner, in degrees.
    ///
    /// Also loosened too far at first: at 35° the same text-box quad passed with 27.1°.
    pub max_angle_error_deg: f32,
    /// How many scored candidates to keep in the trace for debugging.
    pub max_candidates: usize,
    /// How many of the best-scoring candidates get rectified and scored for card-likeness.
    ///
    /// Each costs one warp to 96x134 — about 1/25th of a full rectification — so this is
    /// cheap enough to run on several and expensive enough not to run on all of them.
    pub cardness_candidates: usize,
    /// Reject a detection whose best candidate does not look like a card.
    ///
    /// See [`crate::cardness`]: an art window turned 90° is *geometrically* a card, so no
    /// amount of shape checking can reject it and the pixels have to be consulted.
    pub min_cardness: f32,
    /// Scale the winning quad about its centre before warping.
    ///
    /// **1.07, and it is worth more than any other single number here.** The detected quad is
    /// systematically *too small*: Canny's strongest gradient on a card is the inner edge of
    /// the black border, not the border's outer edge against the table, so the quad tracks
    /// the frame rather than the card. A border of ~3 mm on a 63 mm card is 4-5% per side,
    /// which is the size of the correction the measurement asks for.
    ///
    /// Swept against ground truth read off the rectified images, over the 43 sample scans:
    ///
    /// | inset | top-1 correct | mean distance | mean margin |
    /// | --- | --- | --- | --- |
    /// | 0.94 | 3/8 | 83.0 | 2.3 |
    /// | 1.00 | 6/8 | 78.2 | 6.3 |
    /// | **1.07** | **7/8** | 62.5 | **12.4** |
    /// | 1.13 | 3/8 | **56.9** | 12.5 |
    ///
    /// **Read the last row before changing this.** 1.13 has the *lowest* mean distance in the
    /// sweep and less than half the accuracy: past the optimum the rectification fills with
    /// background, the descriptor goes degenerate, and it moves closer to everything at once.
    /// Tuning this on distance alone makes the scanner worse while making the numbers look
    /// better — correctness and margin are the metrics, and mean distance is a decoy.
    pub inset: f32,
}

impl Default for DetectOptions {
    fn default() -> Self {
        DetectOptions {
            method: EdgeMethod::Canny,
            work_long_edge: 1024,
            canny_low: 40.0,
            canny_high: 100.0,
            min_area_frac: 0.02,
            max_area_frac: 0.90,
            aspect_tolerance: 0.18,
            max_angle_error_deg: 22.0,
            max_candidates: 8,
            cardness_candidates: 4,
            min_cardness: crate::cardness::MIN_SCORE,
            inset: 1.07,
        }
    }
}

/// Four corners in **source-image** coordinates, ordered TL, TR, BR, BL.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Quad {
    pub corners: [(f32, f32); 4],
}

impl Quad {
    fn edge_len(&self, a: usize, b: usize) -> f32 {
        let (ax, ay) = self.corners[a];
        let (bx, by) = self.corners[b];
        ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt()
    }

    /// Mean short edge over mean long edge — the quantity compared against [`CARD_ASPECT`].
    pub fn aspect(&self) -> f32 {
        let top_bottom = (self.edge_len(0, 1) + self.edge_len(2, 3)) / 2.0;
        let sides = (self.edge_len(1, 2) + self.edge_len(3, 0)) / 2.0;
        if sides <= f32::EPSILON {
            return 0.0;
        }
        top_bottom / sides
    }

    /// Shoelace area, always positive.
    pub fn area(&self) -> f32 {
        let c = &self.corners;
        let mut s = 0.0;
        for i in 0..4 {
            let j = (i + 1) % 4;
            s += c[i].0 * c[j].1 - c[j].0 * c[i].1;
        }
        s.abs() / 2.0
    }

    /// Is `p` inside this quad? Convex-only, which every quad here is by construction — they
    /// all come from a convex hull.
    fn holds_point(&self, p: (f32, f32)) -> bool {
        // The cross product against each edge in turn keeps one sign for an interior point.
        let (mut pos, mut neg) = (false, false);
        for i in 0..4 {
            let a = self.corners[i];
            let b = self.corners[(i + 1) % 4];
            let cross = (b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0);
            if cross > 1e-3 {
                pos = true;
            }
            if cross < -1e-3 {
                neg = true;
            }
        }
        !(pos && neg)
    }

    /// Does this quad wholly contain `inner`?
    pub fn contains(&self, inner: &Quad) -> bool {
        inner.corners.iter().all(|c| self.holds_point(*c))
    }

    /// The same quad, scaled about its centre. `f < 1` crops inward.
    pub fn scaled(&self, f: f32) -> Quad {
        let cx = self.corners.iter().map(|c| c.0).sum::<f32>() / 4.0;
        let cy = self.corners.iter().map(|c| c.1).sum::<f32>() / 4.0;
        Quad { corners: self.corners.map(|(x, y)| (cx + (x - cx) * f, cy + (y - cy) * f)) }
    }

    /// The same quad read from the other end — corners rotated by two.
    ///
    /// Not a new detection: the *rectangle* is identical and only the choice of which short
    /// edge is "the top" differs. This is the 180° ambiguity made explicit rather than
    /// guessed at.
    pub fn flipped(&self) -> Quad {
        let c = self.corners;
        Quad { corners: [c[2], c[3], c[0], c[1]] }
    }
}

/// Which geometry step produced a quad. Recorded because the two have different failure
/// modes and a debug artifact that does not say which one ran cannot be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuadSource {
    /// Douglas-Peucker landed on four points. Handles perspective.
    Dp,
    /// The minimum-area rectangle fallback. Ignores perspective.
    MinAreaRect,
}

impl QuadSource {
    pub fn as_str(self) -> &'static str {
        match self {
            QuadSource::Dp => "dp",
            QuadSource::MinAreaRect => "minrect",
        }
    }
}

#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct QuadScore {
    pub via: QuadSource,
    pub aspect: f32,
    pub area_frac: f32,
    /// Worst deviation from 90° at any corner, in degrees.
    pub max_angle_error: f32,
    pub total: f32,
}

#[derive(Debug, Clone)]
pub struct ScoredQuad {
    pub quad: Quad,
    pub score: QuadScore,
    /// Card-likeness of this candidate's own rectification, when it was one of the few
    /// evaluated. `None` means it was never rectified, not that it scored zero.
    pub cardness: Option<crate::cardness::Cardness>,
}

/// A successful detection: the card, flattened, in both possible orientations.
pub struct Detection {
    pub quad: Quad,
    pub score: QuadScore,
    /// How card-like the chosen rectification is. See [`crate::cardness`].
    pub cardness: crate::cardness::Cardness,
    /// [`crate::RECTIFIED_W`]×[`crate::RECTIFIED_H`], warped from the **full-resolution**
    /// source rather than from the downscaled working image.
    pub rectified: RgbImage,
    /// The same card rotated 180°. See the module note: the caller matches both.
    pub rectified_180: RgbImage,
}

/// Hand-written rather than derived, and the reason is a failing test's output: a derived
/// `Debug` prints every subpixel, so one `assert!` that happened to mention a `Detection`
/// would bury the assertion message under a megabyte of integers.
impl std::fmt::Debug for Detection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Detection")
            .field("quad", &self.quad)
            .field("score", &self.score)
            .field("cardness", &self.cardness)
            .field("rectified", &format_args!("{}x{}", RECTIFIED_W, RECTIFIED_H))
            .finish()
    }
}

/// Where the time went, per stage.
///
/// Carried on the trace rather than measured by the caller because the caller can only ever
/// time the whole call, and "detection is too slow" is not actionable without knowing which
/// of the four stages owns it. The live view renders these directly.
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct DetectTimings {
    /// Downscaling the source to `work_long_edge`. Proportional to the *source* pixels, so
    /// this is the stage a 12 MP still pays and a camera frame does not.
    pub resize_ms: f32,
    /// Canny or Otsu, plus the morphology, across every mask in the pool.
    pub mask_ms: f32,
    /// Contours, hulls, polygon approximation and scoring.
    pub contour_ms: f32,
    /// The two homographies, warped from the full-resolution source.
    pub rectify_ms: f32,
    pub total_ms: f32,
}

/// Every intermediate, kept for the debug artifacts. Cheap to produce and the reason the
/// CLI is worth having.
pub struct DetectTrace {
    pub timings: DetectTimings,
    pub gray: GrayImage,
    /// Canny edges or the Otsu mask, whichever ran.
    pub binary: GrayImage,
    pub contours: RgbImage,
    pub quads: RgbImage,
    pub candidates: Vec<ScoredQuad>,
    pub method: EdgeMethod,
    /// Scale from the working image back to the source.
    pub scale: f32,
}

#[derive(Debug, thiserror::Error)]
pub enum DetectError {
    #[error("the frame is empty")]
    EmptyFrame,
    #[error("no quadrilateral in this frame looks like a card (examined {examined} contours)")]
    NoCard { examined: usize },
    #[error("the four corners are degenerate and admit no homography")]
    Degenerate,
    #[error("the best quad does not look like a card (card-likeness {cardness:.2})")]
    NotACard { cardness: f32 },
}

/// Find the card and flatten it, returning the debug trace either way.
///
/// The trace is returned on failure too — a scan that found nothing is exactly when a reader
/// wants to see the edge image.
pub fn detect(
    source: &DynamicImage,
    opts: &DetectOptions,
) -> (Result<Detection, DetectError>, Option<DetectTrace>) {
    let t_start = std::time::Instant::now();
    let mut timings = DetectTimings::default();
    let ms = |t: std::time::Instant| t.elapsed().as_secs_f32() * 1000.0;

    let (sw, sh) = source.dimensions();
    if sw == 0 || sh == 0 {
        return (Err(DetectError::EmptyFrame), None);
    }

    // ── Stage 0-1: downscale and grayscale ────────────────────────────────────────
    let long = sw.max(sh) as f32;
    let scale = (long / opts.work_long_edge as f32).max(1.0);
    let (ww, wh) = (
        ((sw as f32 / scale).round() as u32).max(1),
        ((sh as f32 / scale).round() as u32).max(1),
    );
    let t_resize = std::time::Instant::now();
    let work = source.resize_exact(ww, wh, image::imageops::FilterType::Triangle);
    let gray = work.to_luma8();
    timings.resize_ms = ms(t_resize);

    let t_mask = std::time::Instant::now();

    // ── Stage 2: separate the card from its background ────────────────────────────
    let masks: Vec<GrayImage> = match opts.method {
        EdgeMethod::Canny => {
            // **A ladder of two threshold pairs, not one**, and it is worth the second pass.
            // Measured on the sample scans: at 40/100 five frames found no card at all, and
            // three of those five were recovered at 15/45 — including one whose only
            // accepted quad had been the card's own text box. A card edge that runs along a
            // dark feature of the background produces a weak gradient, and one fixed pair
            // cannot be both selective enough to ignore a patterned surface and sensitive
            // enough to see that edge.
            //
            // Pooling rather than choosing: both masks contribute candidates and
            // [`score_quad`] ranks them together, so the low rung can only add answers.
            // **Ordered and non-negative before they reach `canny`, which asserts rather
            // than errors.** `imageproc::edges::canny` panics outright on
            // `high_threshold < low_threshold`, and these two numbers arrive from a caller —
            // in the live view, from two independent sliders that can trivially cross. A
            // panic there took down every worker thread in the debug server the first time
            // the low slider was dragged past the high one. Swapping them is the sane
            // reading of a crossed pair, and it means no caller can panic this module by
            // passing a merely silly value.
            let rungs = [
                canny_pair(opts.canny_low, opts.canny_high),
                canny_pair(opts.canny_low * 0.375, opts.canny_high * 0.45),
            ];
            rungs
                .iter()
                .map(|(lo, hi)| {
                    let edges = imageproc::edges::canny(&gray, *lo, *hi);
                    // Canny leaves gaps, most reliably at the corners — which is precisely
                    // where a quadrilateral needs continuity. A close (dilate then erode)
                    // bridges them without fattening the boundary permanently.
                    imageproc::morphology::close(&edges, Norm::LInf, 2)
                })
                .collect()
        }
        EdgeMethod::Otsu => {
            let level = otsu_level(&gray);
            // Both polarities. See the module note: a card is lighter than a dark playmat
            // and darker than a white desk, and nothing in the frame says which you have.
            //
            // **Open before close, and the order is the whole point.** A global threshold on
            // an unevenly lit surface throws off a field of single-pixel speckle wherever the
            // background grazes the threshold. Closing alone — which is what this did at
            // first — *dilates* that speckle and welds it onto the card, so the card's
            // contour reaches the frame edge through a chain of noise and
            // [`touches_border`] correctly rejects it. Measured on the sample scans: a
            // borderless card on a black surface produced a textbook-clean mask and was
            // thrown away for exactly this reason, four times.
            //
            // Opening (erode then dilate) removes anything thinner than the kernel before
            // the close can grow it, which separates the card from the noise while leaving
            // a blob that size untouched.
            [ThresholdType::Binary, ThresholdType::BinaryInverted]
                .into_iter()
                .map(|kind| {
                    let mask = threshold(&gray, level, kind);
                    let despeckled = imageproc::morphology::open(&mask, Norm::LInf, 2);
                    imageproc::morphology::close(&despeckled, Norm::LInf, 2)
                })
                .collect()
        }
    };

    timings.mask_ms = ms(t_mask);

    // ── Stages 3-5: contours, polygon approximation, scoring ──────────────────────
    let t_contour = std::time::Instant::now();
    let frame_area = (ww * wh) as f32;
    let mut candidates: Vec<ScoredQuad> = Vec::new();
    let mut examined = 0usize;
    let mut all_contours: Vec<Vec<Point<i32>>> = Vec::new();

    for mask in &masks {
        let contours = find_contours::<i32>(mask);
        for contour in &contours {
            examined += 1;
            if contour.points.len() < 4 {
                continue;
            }
            // **A contour touching the frame edge is not an object in the frame.** It is
            // the image boundary itself, or a region running off the side of it — and in
            // either case there is no fourth corner to find. This one rule is what stopped
            // the detector reporting the photograph as the card; see
            // [`DetectOptions::max_area_frac`] for the measurement that prompted it. It also
            // correctly rejects a card shot half out of frame, which could not be rectified
            // anyway.
            if touches_border(&contour.points, ww, wh) {
                continue;
            }
            all_contours.push(contour.points.clone());
            // The hull first, then the approximation. A raw contour of a real card has
            // concave excursions — a thumb, a sleeve lip, a shadow notch — and
            // Douglas-Peucker on that converges to five or six vertices however the epsilon
            // is chosen. On the hull it converges to four.
            let hull = convex_hull(contour.points.clone());
            if hull.len() < 4 {
                continue;
            }
            let Some((quad, via)) = quad_from_hull(&hull) else { continue };
            let Some(score) = score_quad(&quad, frame_area, opts, via) else { continue };
            candidates.push(ScoredQuad { quad, score, cardness: None });
        }
    }

    // **A card contains its art window; an art window never contains a card.** That
    // asymmetry is worth more than any score, so it is applied as a filter before ranking
    // rather than as a term within it.
    //
    // Measured: a legible, fully visible Forest returned exactly one candidate — the art box
    // — which passed every gate (aspect 0.748, corner error 1.5°) and rectified into a
    // stretched, sideways crop of the artwork. A modern card's art window is itself a
    // clean, high-contrast quadrilateral, so it will always compete; nothing about *its own*
    // shape says it is the wrong one. Only its relationship to a larger quad does.
    //
    // Largest first, then drop anything wholly inside something already kept. The 1.2 factor
    // keeps two detections of the same boundary — one from each mask in the pool — from
    // eliminating each other.
    candidates.sort_by(|a, b| {
        b.quad.area().partial_cmp(&a.quad.area()).unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut outermost: Vec<ScoredQuad> = Vec::with_capacity(candidates.len());
    for c in candidates {
        let nested = outermost
            .iter()
            .any(|k| k.quad.area() > c.quad.area() * 1.2 && k.quad.contains(&c.quad));
        if !nested {
            outermost.push(c);
        }
    }
    let mut candidates = outermost;

    candidates.sort_by(|a, b| {
        b.score.total.partial_cmp(&a.score.total).unwrap_or(std::cmp::Ordering::Equal)
    });
    candidates.dedup_by(|a, b| (a.score.total - b.score.total).abs() < 1e-4);
    candidates.truncate(opts.max_candidates);

    timings.contour_ms = ms(t_contour);
    timings.total_ms = ms(t_start);

    // ── Card-likeness decides, not geometry ───────────────────────────────────────
    //
    // **The geometric winner is often not the card.** A card's art window turned 90° has an
    // aspect of 0.727 against a card's 0.716, so it passes every shape test — measured, a junk
    // quad scored 0.729 while a real card scored 0.718. Geometry cannot separate them.
    //
    // So the top few candidates are rectified small and scored for the horizontal structure
    // every card has, and *that* picks the winner. Over the sample corpus, gating on it kept
    // all 24 good matches while rejecting 10 of the 15 bad ones — geometry alone was right 62%
    // of the time, card-likeness 83%.
    let rgb = source.to_rgb8();
    let considered = opts.cardness_candidates.min(candidates.len());
    for c in candidates.iter_mut().take(considered) {
        // **Candidate quads are in work-image coordinates; the source is full resolution.**
        // Warping one against the other rectifies a small corner of the photograph, which
        // scores as featureless and rejects every real card — measured, it took the sample
        // corpus from 39 detections to 2 while looking like a threshold problem.
        let warped = Quad { corners: c.quad.corners.map(|(x, y)| (x * scale, y * scale)) }
            .scaled(opts.inset);
        let small = rectify_to(&rgb, &warped, crate::cardness::W, crate::cardness::H);
        let flipped =
            rectify_to(&rgb, &warped.flipped(), crate::cardness::W, crate::cardness::H);
        if let (Some(a), Some(b)) = (small, flipped) {
            c.cardness = Some(crate::cardness::cardness_oriented(&a, &b).0);
        }
    }
    candidates.sort_by(|a, b| {
        let key = |c: &ScoredQuad| c.cardness.map(|k| k.score).unwrap_or(-1.0);
        key(b).partial_cmp(&key(a)).unwrap_or(std::cmp::Ordering::Equal)
    });

    let trace = DetectTrace {
        timings,
        gray: gray.clone(),
        binary: masks[0].clone(),
        contours: draw_contours(&work.to_rgb8(), &all_contours),
        quads: draw_quads(&work.to_rgb8(), &candidates),
        candidates: candidates.clone(),
        method: opts.method,
        scale,
    };

    let Some(best) = candidates.first().cloned() else {
        return (Err(DetectError::NoCard { examined }), Some(trace));
    };
    if best.cardness.is_none_or(|k| k.score < opts.min_cardness) {
        return (
            Err(DetectError::NotACard {
                cardness: best.cardness.map(|k| k.score).unwrap_or(0.0),
            }),
            Some(trace),
        );
    }

    // ── Stages 6-7: back to source coordinates, then the homography ───────────────
    let source_quad = Quad {
        corners: best.quad.corners.map(|(x, y)| (x * scale, y * scale)),
    };
    let t_rectify = std::time::Instant::now();
    let rgb = source.to_rgb8();
    let warped = source_quad.scaled(opts.inset);
    let (Some(rectified), Some(rectified_180)) = (
        rectify(&rgb, &warped),
        rectify(&rgb, &warped.flipped()),
    ) else {
        return (Err(DetectError::Degenerate), Some(trace));
    };

    let mut trace = trace;
    trace.timings.rectify_ms = ms(t_rectify);
    trace.timings.total_ms = ms(t_start);

    (
        Ok(Detection {
            quad: source_quad,
            score: best.score,
            cardness: best.cardness.unwrap_or(crate::cardness::Cardness {
                title: 0.0,
                type_line: 0.0,
                full_width_rows: 0,
                score: 0.0,
            }),
            rectified,
            rectified_180,
        }),
        Some(trace),
    )
}

/// Reduce a convex hull to four corners.
///
/// Douglas-Peucker first, sweeping the tolerance — the right epsilon scales with the object,
/// so one fixed value cannot serve both a card filling the frame and a card in the corner of
/// a 12 MP photograph. The sweep is in units of the hull's own perimeter, which makes it
/// scale-free.
///
/// **The minimum-area rectangle is the fallback, and it is not a nicety.** Demanding
/// *exactly* four points from the sweep was the whole of the first real failure mode: a
/// Magic card has rounded corners, so its hull is a rounded rectangle, and as the tolerance
/// rises Douglas-Peucker routinely steps 6 → 5 → 3 without ever landing on 4. Measured on
/// the sample scans, 5 of 18 produced **zero** candidates for this reason — not a
/// mis-ranking that scoring could fix, but no quadrilateral offered at all.
///
/// `min_area_rect` assumes a rotated rectangle and therefore ignores perspective, so it is
/// strictly the worse answer when Douglas-Peucker succeeds. It is tried second for exactly
/// that reason, and what it returns still has to pass every gate in [`score_quad`].
fn quad_from_hull(hull: &[Point<i32>]) -> Option<(Quad, QuadSource)> {
    let perimeter = imageproc::geometry::arc_length(hull, true) as f32;
    if perimeter <= f32::EPSILON {
        return None;
    }
    for step in 1..=24 {
        let epsilon = perimeter * (step as f32) * 0.004;
        let approx = imageproc::geometry::approximate_polygon_dp(hull, epsilon as f64, true);
        if approx.len() == 4 {
            let pts: Vec<(f32, f32)> =
                approx.iter().map(|p| (p.x as f32, p.y as f32)).collect();
            return order_corners(&pts).map(|q| (q, QuadSource::Dp));
        }
        if approx.len() < 4 {
            // Overshot: the tolerance has collapsed the shape past a quadrilateral and
            // every larger epsilon collapses it further. Nothing later in the sweep can
            // succeed, so stop rather than burn the remaining steps.
            break;
        }
    }
    let rect = min_area_rect(hull);
    let pts: Vec<(f32, f32)> = rect.iter().map(|p| (p.x as f32, p.y as f32)).collect();
    order_corners(&pts).map(|q| (q, QuadSource::MinAreaRect))
}

/// Put four corners into TL, TR, BR, BL order, portrait-wise.
///
/// **Not the sum/difference trick.** `min(x+y)` is the top-left only while the card is
/// roughly axis-aligned; at 30-40° of rotation it silently names the wrong corner, and a
/// hand-held scan is rotated far more often than it is square. This sorts by angle about the
/// centroid — which is rotation-invariant — and then chooses the starting corner so that the
/// first edge is one of the two *short* ones, making the result portrait regardless of how
/// the card lay in the frame.
///
/// Two rotations satisfy that, differing by exactly 180°. That is the ambiguity described in
/// the module note; it is not resolved here, and [`Quad::flipped`] is how the caller gets the
/// other one.
fn order_corners(pts: &[(f32, f32)]) -> Option<Quad> {
    if pts.len() != 4 {
        return None;
    }
    let cx = pts.iter().map(|p| p.0).sum::<f32>() / 4.0;
    let cy = pts.iter().map(|p| p.1).sum::<f32>() / 4.0;

    let mut ordered = pts.to_vec();
    ordered.sort_by(|a, b| {
        let aa = (a.1 - cy).atan2(a.0 - cx);
        let bb = (b.1 - cy).atan2(b.0 - cx);
        aa.partial_cmp(&bb).unwrap_or(std::cmp::Ordering::Equal)
    });

    // Image coordinates put y downwards, so a positive shoelace sum is clockwise on screen.
    // Normalising the winding means `corners[1]` is always the next corner clockwise, which
    // is what makes TL/TR/BR/BL mean the same thing for every detection.
    let signed: f32 = (0..4)
        .map(|i| {
            let (x1, y1) = ordered[i];
            let (x2, y2) = ordered[(i + 1) % 4];
            x1 * y2 - x2 * y1
        })
        .sum();
    if signed < 0.0 {
        ordered.reverse();
    }

    let dist = |a: (f32, f32), b: (f32, f32)| ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();

    // Of the four rotations, two put a short edge first. Score each and keep the better,
    // breaking the remaining tie towards the corner nearest the frame's origin so the choice
    // is at least deterministic.
    let mut best: Option<(f32, Quad)> = None;
    for r in 0..4 {
        let c = [
            ordered[r],
            ordered[(r + 1) % 4],
            ordered[(r + 2) % 4],
            ordered[(r + 3) % 4],
        ];
        let top = dist(c[0], c[1]);
        let side = dist(c[1], c[2]);
        if side <= f32::EPSILON || top > side {
            continue; // this rotation is landscape
        }
        let origin_bias = c[0].0 + c[0].1;
        let key = origin_bias;
        if best.as_ref().is_none_or(|(k, _)| key < *k) {
            best = Some((key, Quad { corners: c }));
        }
    }
    best.map(|(_, q)| q)
}

/// Force a Canny threshold pair into the range `imageproc` can actually survive.
///
/// **Two separate defects upstream, both reachable from a slider.**
///
/// `edges::canny` *asserts* `high_threshold >= low_threshold` and panics outright otherwise.
/// The live view drives these from two independent sliders, so crossing them is one drag
/// away — and it killed every worker thread in the debug server the first time it happened.
/// Swapping is the sane reading of a crossed pair.
///
/// The low threshold is then floored at 1. `imageproc-0.27.0/src/edges.rs:135` walks the
/// hysteresis neighbours with `nx - 1` on a `u32`, and the seed loop starts at 1 but the walk
/// itself can push a neighbour at `x == 0`; popping that underflows. A low threshold of 0
/// makes *every* pixel an edge, so the flood reaches the border every time and the underflow
/// is certain rather than unlucky. Flooring at 1 costs nothing real — a Canny low threshold
/// of zero means "every pixel is an edge", which is not a setting anyone wants — and it
/// removes the only way to hit that path reliably.
///
/// It does not make the upstream bug unreachable on a pathological image, which is why the
/// debug server also wraps each frame in `catch_unwind`.
fn canny_pair(low: f32, high: f32) -> (f32, f32) {
    let lo = low.min(high).max(1.0);
    let hi = low.max(high).max(lo + 1.0);
    (lo, hi)
}

/// Does this contour run into the edge of the frame?
///
/// Checked on the contour rather than on the finished quad, because it is cheaper and
/// because it removes the offending shape before the convex hull can smear it into
/// something plausible.
fn touches_border(points: &[Point<i32>], w: u32, h: u32) -> bool {
    let (right, bottom) = (w as i32 - 1, h as i32 - 1);
    points
        .iter()
        .any(|p| p.x <= 0 || p.y <= 0 || p.x >= right || p.y >= bottom)
}

fn score_quad(
    quad: &Quad,
    frame_area: f32,
    opts: &DetectOptions,
    via: QuadSource,
) -> Option<QuadScore> {
    let area = quad.area();
    let area_frac = area / frame_area;
    if area_frac < opts.min_area_frac {
        return None;
    }

    if area_frac > opts.max_area_frac {
        return None;
    }

    let aspect = quad.aspect();
    let aspect_err = (aspect - CARD_ASPECT).abs() / CARD_ASPECT;
    if aspect_err > opts.aspect_tolerance {
        return None;
    }

    // Interior angles. Perspective genuinely bends these, so the gate is loose — its job is
    // to throw out slivers and bowties, not to demand a rectangle.
    let mut max_angle_error: f32 = 0.0;
    for i in 0..4 {
        let p = quad.corners[(i + 3) % 4];
        let c = quad.corners[i];
        let n = quad.corners[(i + 1) % 4];
        let v1 = (p.0 - c.0, p.1 - c.1);
        let v2 = (n.0 - c.0, n.1 - c.1);
        let m1 = (v1.0 * v1.0 + v1.1 * v1.1).sqrt();
        let m2 = (v2.0 * v2.0 + v2.1 * v2.1).sqrt();
        if m1 <= f32::EPSILON || m2 <= f32::EPSILON {
            return None;
        }
        let cos = ((v1.0 * v2.0 + v1.1 * v2.1) / (m1 * m2)).clamp(-1.0, 1.0);
        let deg = cos.acos().to_degrees();
        max_angle_error = max_angle_error.max((deg - 90.0).abs());
    }
    if max_angle_error > opts.max_angle_error_deg {
        return None;
    }

    // Aspect carries most of the weight: it is the one term that encodes what a Magic card
    // actually is, where area only says "big" and the angle term only says "not a sliver".
    let aspect_score = 1.0 - (aspect_err / opts.aspect_tolerance);
    let angle_score = 1.0 - (max_angle_error / opts.max_angle_error_deg);
    // **Deliberately a weak, saturating preference rather than "bigger is better".** The
    // first version scored area linearly, which is precisely what ranked a frame-sized quad
    // above the actual card. Area's real job is only to break ties between a card and some
    // small artefact inside it, so it saturates at a quarter of the frame and carries the
    // least weight of the three.
    let area_score = (area_frac / 0.25).min(1.0);
    let total = aspect_score * 0.60 + angle_score * 0.25 + area_score * 0.15;

    Some(QuadScore { aspect, area_frac, max_angle_error, total, via })
}

/// Flatten `quad` out of `source` at an arbitrary output size.
///
/// The size is a parameter because card-likeness is judged on a 96x134 profile, and warping
/// to that directly costs about a twenty-fifth of a full rectification — which is what makes
/// it affordable to score several candidates rather than only the geometric winner.
pub fn rectify_to(source: &RgbImage, quad: &Quad, w: u32, h: u32) -> Option<RgbImage> {
    let dst = [(0.0, 0.0), (w as f32, 0.0), (w as f32, h as f32), (0.0, h as f32)];
    let projection = Projection::from_control_points(quad.corners, dst)?;
    let mut out = RgbImage::new(w, h);
    warp_into(
        source,
        projection,
        Interpolation::Bilinear,
        Border::Constant(Rgb([0, 0, 0])),
        &mut out,
    );
    Some(out)
}

/// Flatten `quad` out of `source` into a canonical [`RECTIFIED_W`]×[`RECTIFIED_H`] card.
///
/// The control points run source-then-destination because `imageproc`'s projection maps the
/// input plane onto the output plane, and `warp_into` inverts it internally. Handing them
/// over the other way round produces a plausible-looking, entirely wrong image.
pub fn rectify(source: &RgbImage, quad: &Quad) -> Option<RgbImage> {
    let dst = [
        (0.0, 0.0),
        (RECTIFIED_W as f32, 0.0),
        (RECTIFIED_W as f32, RECTIFIED_H as f32),
        (0.0, RECTIFIED_H as f32),
    ];
    let projection = Projection::from_control_points(quad.corners, dst)?;
    // `warp` would return an image the size of `source`. The output size has to be imposed
    // by the buffer, which is what `warp_into` is for.
    let mut out = RgbImage::new(RECTIFIED_W, RECTIFIED_H);
    warp_into(
        source,
        projection,
        Interpolation::Bilinear,
        Border::Constant(Rgb([0, 0, 0])),
        &mut out,
    );
    Some(out)
}

fn draw_contours(base: &RgbImage, contours: &[Vec<Point<i32>>]) -> RgbImage {
    let mut out = base.clone();
    for (i, points) in contours.iter().enumerate() {
        // Cycle the hue so adjacent contours are told apart by eye.
        let colour = match i % 4 {
            0 => Rgb([255, 64, 64]),
            1 => Rgb([64, 255, 64]),
            2 => Rgb([64, 160, 255]),
            _ => Rgb([255, 220, 64]),
        };
        for p in points {
            if p.x >= 0 && p.y >= 0 && (p.x as u32) < out.width() && (p.y as u32) < out.height() {
                out.put_pixel(p.x as u32, p.y as u32, colour);
            }
        }
    }
    out
}

fn draw_quads(base: &RgbImage, candidates: &[ScoredQuad]) -> RgbImage {
    let mut out = base.clone();
    for (rank, c) in candidates.iter().enumerate().rev() {
        // The winner in green, the also-rans in dimming grey: a bad detection is then
        // legible at a glance rather than needing the JSON read alongside.
        let colour = if rank == 0 { Rgb([0, 255, 0]) } else { Rgb([120, 120, 120]) };
        for i in 0..4 {
            let a = c.quad.corners[i];
            let b = c.quad.corners[(i + 1) % 4];
            imageproc::drawing::draw_line_segment_mut(&mut out, a, b, colour);
        }
        if rank == 0 {
            // Mark the top-left corner, so the 180° choice is visible in the artifact.
            imageproc::drawing::draw_filled_circle_mut(
                &mut out,
                (c.quad.corners[0].0 as i32, c.quad.corners[0].1 as i32),
                4,
                Rgb([255, 0, 255]),
            );
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    /// The horizontal structure a Magic card has, as a function of height through the card.
    ///
    /// Not decoration: [`crate::cardness`] now rejects a quad whose rectification has no
    /// title band and no type line, so a fixture without them is not a card and the detector
    /// is right to refuse it. Bands at 10%, 55%, 62% and 92% put a full-width transition
    /// everywhere a real card has one.
    fn card_band(ry: f32, card_h: f32) -> u8 {
        let ty = (ry + card_h / 2.0) / card_h;
        match ty {
            // Every band stays well clear of the dark grounds the fixtures use, so Otsu's
            // global threshold puts the *whole card* on one side of the split. With a darker
            // art band the threshold lands inside the card instead and it fragments into three
            // separate bars — which is a fixture problem, not a detector one.
            t if t < 0.10 => 240, // title bar
            t if t < 0.55 => 150, // art
            t if t < 0.62 => 240, // type line
            t if t < 0.92 => 200, // text box
            _ => 140,             // bottom info line
        }
    }

    /// A synthetic frame: a card-shaped quad with card-like bands on a dark ground,
    /// optionally rotated about the centre. Enough to exercise geometry without a photograph.
    fn synth(w: u32, h: u32, card_w: f32, rotate_deg: f32) -> DynamicImage {
        let mut img = RgbImage::from_pixel(w, h, Rgb([20, 20, 24]));
        let card_h = card_w / CARD_ASPECT;
        let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
        let t = rotate_deg.to_radians();
        let (s, c) = (t.sin(), t.cos());
        // Inverse-map every pixel back into card space and fill if it lands inside.
        for y in 0..h {
            for x in 0..w {
                let (dx, dy) = (x as f32 - cx, y as f32 - cy);
                let rx = dx * c + dy * s;
                let ry = -dx * s + dy * c;
                if rx.abs() <= card_w / 2.0 && ry.abs() <= card_h / 2.0 {
                    img.put_pixel(x, y, Rgb([card_band(ry, card_h); 3]));
                }
            }
        }
        DynamicImage::ImageRgb8(img)
    }

    #[test]
    fn finds_an_axis_aligned_card() {
        let frame = synth(800, 600, 300.0, 0.0);
        for method in [EdgeMethod::Canny, EdgeMethod::Otsu] {
            let opts = DetectOptions { method, ..Default::default() };
            let (result, trace) = detect(&frame, &opts);
            assert!(trace.is_some(), "{method:?} produced no trace");
            let d = result.unwrap_or_else(|e| panic!("{method:?} found no card: {e}"));
            assert_eq!(d.rectified.dimensions(), (RECTIFIED_W, RECTIFIED_H));
            assert!(
                (d.score.aspect - CARD_ASPECT).abs() < 0.1,
                "{method:?} aspect {} is not a card",
                d.score.aspect
            );
        }
    }

    #[test]
    fn finds_a_rotated_card() {
        // The case the sum/difference corner-ordering trick gets wrong. 35° is past the
        // point where "smallest x+y" stops naming the top-left.
        for angle in [12.0, 35.0, -28.0] {
            let frame = synth(900, 900, 320.0, angle);
            let opts = DetectOptions { method: EdgeMethod::Otsu, ..Default::default() };
            let (result, _) = detect(&frame, &opts);
            let d = result.unwrap_or_else(|e| panic!("no card at {angle}°: {e}"));
            assert!(
                (d.score.aspect - CARD_ASPECT).abs() < 0.12,
                "at {angle}° the aspect came out {}",
                d.score.aspect
            );
        }
    }

    #[test]
    fn corners_are_ordered_portrait_and_clockwise() {
        let frame = synth(800, 600, 300.0, 0.0);
        let opts = DetectOptions { method: EdgeMethod::Otsu, ..Default::default() };
        let d = detect(&frame, &opts).0.expect("a card");
        let c = d.quad.corners;
        let top = ((c[1].0 - c[0].0).powi(2) + (c[1].1 - c[0].1).powi(2)).sqrt();
        let side = ((c[2].0 - c[1].0).powi(2) + (c[2].1 - c[1].1).powi(2)).sqrt();
        assert!(top < side, "corner 0->1 should be a short edge; got {top} vs {side}");
    }

    #[test]
    fn flipped_is_the_same_rectangle() {
        let q = Quad { corners: [(0.0, 0.0), (10.0, 0.0), (10.0, 20.0), (0.0, 20.0)] };
        let f = q.flipped();
        assert!((q.area() - f.area()).abs() < 1e-3);
        assert!((q.aspect() - f.aspect()).abs() < 1e-3);
        assert_eq!(f.flipped().corners, q.corners, "flipping twice is identity");
    }

    #[test]
    fn crossed_canny_thresholds_do_not_panic() {
        // Found by driving the live view: two independent sliders can put the low threshold
        // above the high one, and `imageproc::edges::canny` asserts rather than erroring —
        // which killed every worker thread in the debug server at once.
        // Both rungs are checked, since the low rung scales the pair by 0.375 and could
        // reach zero from a legitimate-looking input.
        for (lo, hi) in [(1.0, 3.0), (120.0, 20.0), (0.0, 0.0), (-5.0, 10.0), (300.0, 1.0)] {
            let (a, b) = canny_pair(lo, hi);
            assert!(a >= 1.0 && b > a, "canny_pair({lo}, {hi}) gave ({a}, {b})");
            let (a, b) = canny_pair(lo * 0.375, hi * 0.45);
            assert!(a >= 1.0 && b > a, "the low rung of ({lo}, {hi}) gave ({a}, {b})");
        }

        let frame = synth(600, 800, 260.0, 0.0);
        for (lo, hi) in [(120.0, 20.0), (0.0, 0.0), (-5.0, 10.0), (300.0, 1.0)] {
            let opts = DetectOptions {
                method: EdgeMethod::Canny,
                canny_low: lo,
                canny_high: hi,
                ..Default::default()
            };
            // The assertion is that this returns at all.
            let (_result, trace) = detect(&frame, &opts);
            assert!(trace.is_some(), "canny({lo}, {hi}) produced no trace");
        }
    }

    #[test]
    fn an_empty_frame_is_an_error_not_a_panic() {
        let empty = DynamicImage::ImageRgb8(RgbImage::new(0, 0));
        let (r, trace) = detect(&empty, &DetectOptions::default());
        assert!(matches!(r, Err(DetectError::EmptyFrame)));
        assert!(trace.is_none());
    }

    #[test]
    fn a_blank_frame_finds_no_card_but_still_traces() {
        // A camera pointed at a wall. This must be an ordinary negative, and the trace has
        // to survive so a reader can see *why* nothing was found.
        let blank = DynamicImage::ImageRgb8(RgbImage::from_pixel(400, 400, Rgb([128, 128, 128])));
        let (r, trace) = detect(&blank, &DetectOptions::default());
        assert!(matches!(r, Err(DetectError::NoCard { .. })), "got {r:?}");
        assert!(trace.is_some(), "a failed detection must still produce its trace");
    }

    #[test]
    fn a_square_is_rejected() {
        // The aspect prior doing its job: a square is a perfectly good quadrilateral and is
        // not a card.
        let mut img = RgbImage::from_pixel(600, 600, Rgb([20, 20, 20]));
        for y in 150..450 {
            for x in 150..450 {
                img.put_pixel(x, y, Rgb([220, 220, 220]));
            }
        }
        let (r, _) = detect(&DynamicImage::ImageRgb8(img), &DetectOptions::default());
        assert!(matches!(r, Err(DetectError::NoCard { .. })), "a square passed as a card: {r:?}");
    }

    #[test]
    fn the_photograph_itself_is_not_a_card() {
        // **The regression test for the bug that made the first real run meaningless.**
        // A 3000x4000 frame has an aspect of 0.75 against a card's 0.7159 — a 4.8% error,
        // inside any usable tolerance — so the image border is a near-perfect card and
        // scored better than the real one for being bigger. 17 of 18 scans "succeeded" and
        // every one of them returned the photograph.
        //
        // The fixture is a frame-filling bright region with a real, correctly proportioned
        // card inside it. The detector must return the *inner* one.
        let (w, h) = (600u32, 800u32);
        // A dark ground: the card's own title and type bands are near-white, so a light ground
        // would leave the card barely separable from it and the fixture would be testing the
        // contrast rather than the rule.
        let mut img = image::RgbImage::from_pixel(w, h, image::Rgb([22, 20, 26]));
        // A card at 1/4 the frame's area, clearly interior.
        let (cx0, cy0, cw) = (200u32, 260u32, 200u32);
        let ch = (cw as f32 / CARD_ASPECT) as u32;
        for y in cy0..cy0 + ch {
            for x in cx0..cx0 + cw {
                let ry = y as f32 - (cy0 as f32 + ch as f32 / 2.0);
                img.put_pixel(x, y, image::Rgb([card_band(ry, ch as f32); 3]));
            }
        }
        let src = DynamicImage::ImageRgb8(img);

        for method in [EdgeMethod::Canny, EdgeMethod::Otsu] {
            let opts = DetectOptions { method, ..Default::default() };
            let d = detect(&src, &opts)
                .0
                .unwrap_or_else(|e| panic!("{method:?} found nothing: {e}"));
            assert!(
                d.score.area_frac < 0.5,
                "{method:?} returned a quad covering {:.0}% of the frame — that is the \
                 photograph, not the card",
                d.score.area_frac * 100.0
            );
            // And it is actually the card: within a few pixels of where it was drawn.
            let (tlx, tly) = d.quad.corners[0];
            assert!(
                (tlx - cx0 as f32).abs() < 12.0 && (tly - cy0 as f32).abs() < 12.0,
                "{method:?} put the top-left at ({tlx:.0},{tly:.0}), expected ~({cx0},{cy0})"
            );
        }
    }

    #[test]
    fn an_art_window_never_beats_the_card_around_it() {
        // **The regression test for "there is a perfectly legible card and we only got some
        // of it".** A modern card's art window is itself a clean, high-contrast rectangle,
        // and on one sample scan it was the *only* candidate — passing every gate at aspect
        // 0.748 and 1.5° of corner error, then rectifying into a stretched sideways crop of
        // the artwork. Nothing about the art box's own shape is wrong; only its being inside
        // something larger is.
        let (w, h) = (700u32, 900u32);
        // A dark ground. With a light one the card's near-white title and type bands barely
        // separate from it, Canny finds only the art window's edges, and the fixture ends up
        // testing contrast rather than the containment rule.
        let mut img = image::RgbImage::from_pixel(w, h, image::Rgb([26, 24, 30]));
        // The card, with the bands that make it read as one.
        let (cx, cy, cw) = (180u32, 210u32, 320u32);
        let ch = (cw as f32 / CARD_ASPECT) as u32;
        for y in cy..cy + ch {
            for x in cx..cx + cw {
                let ry = y as f32 - (cy as f32 + ch as f32 / 2.0);
                img.put_pixel(x, y, image::Rgb([card_band(ry, ch as f32); 3]));
            }
        }
        // A flat art window inset near the top, itself a plausible quadrilateral — and
        // deliberately featureless, which is what an art crop is.
        for y in cy + 40..cy + 40 + 190 {
            for x in cx + 22..cx + cw - 22 {
                img.put_pixel(x, y, image::Rgb([196, 188, 170]));
            }
        }
        let src = DynamicImage::ImageRgb8(img);

        for method in [EdgeMethod::Canny, EdgeMethod::Otsu] {
            let opts = DetectOptions { method, ..Default::default() };
            // **Not `else { continue }`.** That is how this test passed vacuously for months:
            // while a card-likeness gate was rejecting the art window outright, detection
            // errored, the loop skipped, and the containment rule was never exercised at all.
            // A test that silently declines to run is worse than one that fails.
            let d = detect(&src, &opts)
                .0
                .unwrap_or_else(|e| panic!("{method:?} found nothing in the fixture: {e}"));
            // Whatever was chosen, it must not be the inset: the card's area is the whole
            // rectangle, the art window is well under half of it.
            let card_area = (cw * ch) as f32;
            assert!(
                d.quad.area() > card_area * 0.6,
                "{method:?} returned a quad of {:.0} px against a card of {card_area:.0} — \
                 that is a region inside the card, not the card",
                d.quad.area()
            );
        }
    }

    #[test]
    fn containment_is_strict_and_directional() {
        let outer = Quad { corners: [(0.0, 0.0), (100.0, 0.0), (100.0, 140.0), (0.0, 140.0)] };
        let inner = Quad { corners: [(20.0, 30.0), (80.0, 30.0), (80.0, 90.0), (20.0, 90.0)] };
        let straddling =
            Quad { corners: [(50.0, 50.0), (150.0, 50.0), (150.0, 120.0), (50.0, 120.0)] };
        assert!(outer.contains(&inner));
        assert!(!inner.contains(&outer), "containment must not be symmetric");
        assert!(!outer.contains(&straddling), "a quad crossing the edge is not contained");
        assert!(outer.contains(&outer), "a quad contains itself");
    }

    #[test]
    fn a_contour_on_the_frame_edge_is_rejected() {
        let pts = vec![Point::new(0, 5), Point::new(10, 5)];
        assert!(touches_border(&pts, 100, 100), "x=0 is the frame edge");
        assert!(touches_border(&[Point::new(99, 5)], 100, 100), "x=w-1 is the frame edge");
        assert!(!touches_border(&[Point::new(50, 50)], 100, 100), "an interior point is not");
    }

    #[test]
    fn rectify_rejects_degenerate_corners() {
        let src = RgbImage::from_pixel(100, 100, Rgb([255, 255, 255]));
        let collapsed = Quad { corners: [(0.0, 0.0); 4] };
        assert!(rectify(&src, &collapsed).is_none());
    }
}
