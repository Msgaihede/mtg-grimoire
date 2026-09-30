//! Reading the card's name off the rectified image.
//!
//! ## Why this tier exists, and what it is for
//!
//! The whole-card hash answers "which card looks most like this", and that question has one
//! failure mode nothing else fixes: a **foil under a point light**. The sheen washes the
//! surface in a rainbow, the art becomes a haze, and every descriptor — grayscale, chroma,
//! half-chroma — finds the right card on at most two frames in eight. The same card, evenly
//! lit as a still, matches at 32 bits.
//!
//! In those exact frames the title is **perfectly legible**. Text is a shape, not a colour,
//! and a rainbow that destroys every appearance-based descriptor leaves the letterforms
//! intact. That is the whole argument for OCR: it is not a better version of the same signal,
//! it is a different signal, and it is strongest precisely where the other one is weakest.
//!
//! ## Only the title band
//!
//! Text detection over a whole card would find the type line, the rules text, the flavour
//! text, the collector line and the artist credit — dozens of words, most of a second, and a
//! haystack to search for the one line that names the card. A rectified card puts the title
//! in a known place, so this crops to it and reads that.
//!
//! The band is deliberately generous at the top and cut short on the right: the title starts
//! higher on a pre-8th-edition frame than on an M15 one, and the right end of every modern
//! title bar is the mana cost, which is not text and reads as garbage.
//!
//! ## No text detection
//!
//! Since #707 a read runs no `ocrs` detection model. A band is cropped *because* we know where
//! its text is, so [`text_lines`] finds the lines with a projection and each goes straight to
//! the recogniser. Detection was most of a read's cost — its model takes a fixed-size input and
//! every band was padded out to it. Measured on the same synthetic bands, a title read is
//! **5.9×** faster and a collector read **6.8×**; 24 more titles resolve, and 2 more resolve
//! to the wrong card, both short truncated reads (`docs/reference/card-scanner.md` §4).

use image::RgbImage;

/// Where the card's name sits on a rectified card, as fractions of its size.
///
/// Generous vertically because the title's height varies by frame era; stopping at 78% across
/// leaves the mana cost out.
const TITLE_BAND: (f32, f32, f32, f32) = (0.045, 0.025, 0.780, 0.130);

/// The collector line, bottom left: `U 0232` over `LTR * EN <brush> Jarel Threat`.
///
/// **A set code and a collector number are the printing itself**, which is the one thing
/// neither the descriptor nor the card's name can give. The hash answers "which card does this
/// look like" and reads a reprint as easily as the right printing; the title answers "what is
/// it called" and every reprint shares that. `LTR 232` is an identity.
///
/// Measured on a 488x680 rectification, the crop is about 175x47 — roughly a quarter the area
/// of the title band and with text half the height, which is why it upscales harder. It stops
/// at 38% of the width: the artist credit runs on past that and is nothing but noise for this
/// measured, an artist called Irvin Rodriguez read as INVEN, whose prefix INV is Invasion, and
/// the line then resolved confidently to the wrong printing. Every token kept past the set code
/// is another chance for a spurious pairing to resolve.
const COLLECTOR_BAND: (f32, f32, f32, f32) = (0.018, 0.918, 0.285, 0.990);

/// Where else to look when the first crop yields nothing.
///
/// **A single fixed rectangle assumes every card puts the line in the same place, and they do
/// not.** A borderless printing, a full-art land and a showcase frame each shift it, and the
/// rectification's own framing moves it again by a percent or two. Trying a wider crop and
/// then a lower one recovers reads that the first band clips.
///
/// Ordered, and taken in order, with an early exit as soon as a crop yields any candidate at
/// all, so the common case stays at one read and only a card the first band cannot see pays
/// for the second. The order was set when a read cost **~340 ms against a ~350 ms frame**
/// (release, 2026-09-08); since #707 dropped text detection it costs about a sixth of that, which
/// makes the fallbacks cheap enough to revisit but has not changed them.
const COLLECTOR_FALLBACKS: [(f32, f32, f32, f32); 2] = [
    // Wider and taller — for a frame that sits the line lower or runs it longer.
    (0.010, 0.900, 0.340, 1.000),
    // Higher up, for a full-art or borderless card whose line is inset from the edge.
    (0.020, 0.880, 0.300, 0.960),
];

/// What one attempt at reading the title produced.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TitleRead {
    /// The crop the recogniser actually saw — the orientation that won.
    ///
    /// Skipped by serde: the JSON carries a rendered preview of this, not the pixels.
    #[serde(skip)]
    pub band: Option<RgbImage>,
    /// The text as OCR returned it, whitespace-collapsed.
    pub raw: String,
    /// Lowercased and stripped to letters, digits and single spaces — the form a name lookup
    /// compares against.
    pub normalized: String,
    /// Whether the 180°-rotated rectification produced this, rather than the upright one.
    pub rotated: bool,
    pub elapsed_ms: f32,
}

impl TitleRead {
    /// Is there enough here to look a card up with?
    ///
    /// Two characters of noise is what an empty band returns; a real title is a word.
    pub fn is_usable(&self) -> bool {
        self.normalized.len() >= 4 && self.normalized.chars().any(|c| c.is_ascii_alphabetic())
    }
}

/// Collapse OCR output to a comparable form.
///
/// Card names carry apostrophes, commas, hyphens and accents that OCR renders inconsistently
/// — `Kroxa's` may come back as `Kroxas`, `Kroxa'S` or `Kroxa s`. Stripping all of it on both
/// sides means the comparison never turns on a character that was never reliable.
pub fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = true; // leading spaces are never wanted
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            space = false;
        } else if !space {
            out.push(' ');
            space = true;
        }
    }
    while out.ends_with(' ') {
        out.pop();
    }
    out
}

/// Crop the title band out of a rectified card, upscaled for the recogniser.
///
/// The band is ~350x50 on a 488x680 card, which is small for a model trained on document
/// scans. Doubling it costs a fraction of a millisecond and measurably steadies the read.
pub fn title_band(rectified: &RgbImage) -> RgbImage {
    band(rectified, TITLE_BAND, 2)
}

/// Crop the collector line, upscaled harder than the title because the type is smaller.
pub fn collector_band(rectified: &RgbImage) -> RgbImage {
    band(rectified, COLLECTOR_BAND, 4)
}

fn band(rectified: &RgbImage, at: (f32, f32, f32, f32), scale: u32) -> RgbImage {
    let (w, h) = (rectified.width() as f32, rectified.height() as f32);
    let (x0, y0, _, _) = at;
    let (cx, cy) = ((x0 * w) as u32, (y0 * h) as u32);
    let (cw, ch) = band_extent(at, rectified.width(), rectified.height());
    let crop = image::imageops::crop_imm(rectified, cx, cy, cw, ch).to_image();
    image::imageops::resize(
        &crop,
        cw * scale,
        ch * scale,
        image::imageops::FilterType::Lanczos3,
    )
}

/// A band's size on a `w`×`h` card, before any scale.
///
/// Clamped once, here, rather than at the crop alone — a degenerate input made the crop safe
/// and then asked `resize` for a zero-height image, which panics. Shared by both ways of
/// producing a band, so a band warped from the frame is exactly the size of the one cropped
/// from the rectified card and the recogniser cannot tell them apart by shape.
fn band_extent(at: (f32, f32, f32, f32), w: u32, h: u32) -> (u32, u32) {
    let (x0, y0, x1, y1) = at;
    let cw = (((x1 - x0) * w as f32) as u32).max(1);
    let ch = (((y1 - y0) * h as f32) as u32).max(1);
    (cw, ch)
}

/// A card as the frame holds it: the pixels, and where the canonical card sits in them.
///
/// **Why the bands are warped from here and not cropped from the rectified card.** The
/// rectification is 488×680, warped with a bilinear filter, then trimmed and resized back to
/// 488×680, and a band cropped out of that is upscaled again with Lanczos3 — three resamples
/// before the recogniser sees a pixel, the last two adding nothing but blur. Worse, the
/// rectification is only as sharp as the frame it came from, and the frame the page sends is
/// downscaled to `send px` first. A band warped straight out of the frame is one resample of
/// real pixels — and out of a *detail* frame at the camera's own resolution, it is the
/// collector line's actual strokes rather than an interpolation of a few pixels of them.
#[derive(Debug, Clone)]
pub struct CardPixels {
    image: RgbImage,
    /// The quad the rectification warped — the inset already applied — in `image` coordinates,
    /// upright.
    warped: crate::detect::Quad,
    /// The trim the rectification applied to the upright card, in rectified pixels; already
    /// [`crate::trim::effective`], so a margin the trim declined moves nothing here either.
    margin: crate::trim::Margin,
}

impl CardPixels {
    /// `warped` is the quad the upright rectification used, inset included, in `image`'s
    /// coordinates; `margin` the trim measured on that rectification.
    pub fn new(image: RgbImage, warped: crate::detect::Quad, margin: crate::trim::Margin) -> Self {
        let margin = crate::trim::effective(margin, crate::RECTIFIED_W, crate::RECTIFIED_H);
        CardPixels { image, warped, margin }
    }

    /// The frame the bands are warped from.
    pub fn image(&self) -> &RgbImage {
        &self.image
    }

    /// The band `at` — fractions of the trimmed canonical card, the same rectangles
    /// [`title_band`] and [`collector_band`] crop — warped out of the frame at `scale` times
    /// its size on a 488×680 card. `rotated` reads it from the 180° view.
    ///
    /// `None` only for a quad that admits no homography.
    pub fn band(&self, at: (f32, f32, f32, f32), scale: u32, rotated: bool) -> Option<RgbImage> {
        let q = self.band_quad(at, rotated)?;
        let (bw, bh) = band_extent(at, crate::RECTIFIED_W, crate::RECTIFIED_H);
        crate::detect::rectify_to(&self.image, &q, bw * scale, bh * scale)
    }

    /// How many of the frame's own pixels the band `at` covers, width by height — the
    /// resolution a read of it actually had, whatever size the band is then warped to.
    pub fn band_span(&self, at: (f32, f32, f32, f32), rotated: bool) -> Option<(u32, u32)> {
        let [a, b, _, d] = self.band_quad(at, rotated)?.corners;
        let len = |p: (f32, f32), q: (f32, f32)| (p.0 - q.0).hypot(p.1 - q.1).round() as u32;
        Some((len(a, b), len(a, d)))
    }

    /// The band `at` as a quad in the frame's coordinates.
    fn band_quad(&self, at: (f32, f32, f32, f32), rotated: bool) -> Option<crate::detect::Quad> {
        use imageproc::geometric_transformations::Projection;
        let (quad, m) = if rotated {
            (self.warped.flipped(), self.margin.rotated_180())
        } else {
            (self.warped, self.margin)
        };
        let (w, h) = (crate::RECTIFIED_W as f32, crate::RECTIFIED_H as f32);
        // The rectification maps the quad onto the 488×680 rectangle; its inverse, built the
        // other way round, maps a rectified pixel back into the frame.
        let to_frame =
            Projection::from_control_points([(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)], quad.corners)?;
        // A fraction of the trimmed card is a point inside the margin on the untrimmed one:
        // `trim::apply` crops the margin away and stretches what is left back to 488×680.
        let (left, top) = (m.left as f32, m.top as f32);
        let (cw, ch) = (w - left - m.right as f32, h - top - m.bottom as f32);
        let at_card = |u: f32, v: f32| to_frame * (left + u * cw, top + v * ch);
        let (x0, y0, x1, y1) = at;
        Some(crate::detect::Quad {
            corners: [at_card(x0, y0), at_card(x1, y0), at_card(x1, y1), at_card(x0, y1)],
        })
    }
}

/// What a band was read from: the image, and how much of it the band covered.
///
/// **The answer to "was that read at full resolution?"**, which the crop alone cannot give —
/// every band is warped to the same size, so a line spanning 60 source pixels and one spanning
/// 250 come out looking alike apart from their blur.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct BandOrigin {
    /// `true` for a frame from the camera — the detail frame when one came, else the detection
    /// frame — and `false` for the 488×680 rectification.
    pub frame: bool,
    /// The size of the image the band was warped or cropped from.
    pub width: u32,
    pub height: u32,
    /// The band's own extent in that image's pixels.
    pub span_width: u32,
    pub span_height: u32,
}

/// Where a reader gets its bands.
pub enum BandSource<'a> {
    /// The rectified card, both ways up — what a still image, a test, or a frame with no
    /// [`CardPixels`] to hand gives.
    Rectified { upright: &'a RgbImage, flipped: &'a RgbImage },
    /// The frame itself. See [`CardPixels`] for why this is the better one.
    Frame(&'a CardPixels),
}

impl BandSource<'_> {
    /// The band `at` at `scale`, from the upright view or the 180° one.
    pub fn band(&self, at: (f32, f32, f32, f32), scale: u32, rotated: bool) -> RgbImage {
        match self {
            BandSource::Rectified { upright, flipped } => {
                band(if rotated { flipped } else { upright }, at, scale)
            }
            // A degenerate quad reads as an empty band rather than failing the frame: the
            // reader then finds nothing, which is what a card it cannot see should produce.
            BandSource::Frame(p) => p.band(at, scale, rotated).unwrap_or_else(|| RgbImage::new(1, 1)),
        }
    }

    /// Where the band `at` comes from, for [`BandOrigin`]'s reason. `None` for a frame quad
    /// that admits no homography, which [`BandSource::band`] reads as an empty band.
    pub fn origin(&self, at: (f32, f32, f32, f32), rotated: bool) -> Option<BandOrigin> {
        match self {
            BandSource::Rectified { upright, .. } => {
                let (span_width, span_height) = band_extent(at, upright.width(), upright.height());
                Some(BandOrigin {
                    frame: false,
                    width: upright.width(),
                    height: upright.height(),
                    span_width,
                    span_height,
                })
            }
            BandSource::Frame(p) => {
                let (span_width, span_height) = p.band_span(at, rotated)?;
                Some(BandOrigin {
                    frame: true,
                    width: p.image.width(),
                    height: p.image.height(),
                    span_width,
                    span_height,
                })
            }
        }
    }
}

/// One line of text inside a band, in the band's own pixels, bottom and right exclusive.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextLine {
    pub top: u32,
    pub left: u32,
    pub bottom: u32,
    pub right: u32,
    /// How far this line's rows stand above the band's quiet floor, summed. The title keeps
    /// the strongest lines, not the first ones.
    pub strength: f32,
}

/// Where the text in a band is, top to bottom — found by a projection, not a model.
///
/// **This is what replaced `ocrs`'s text detection** (#707). `get_text` ran a detection model
/// over every band to find the words, and the band was only ever cropped because we already
/// knew where the words were. The model takes a fixed-size input, so every band was padded
/// out to it and the model paid for the padding. It was most of the cost of a read.
///
/// **A row projection of the horizontal gradient.** Letterforms are mostly vertical strokes,
/// so a row through text crosses dark-light-dark many times and its sum of `|∂I/∂x|` is high.
/// The frame's own edges — the title bar's rule, the border, the top of the art window — are
/// *horizontal*, so they barely move it. That asymmetry is what lets a generous band be cut to
/// its lines without being fooled by the frame edge a crop of it always contains. Rows above a
/// cut set between the band's quiet floor and its peak are text; runs a small gap apart are one
/// line, because a line's ascender rows are weaker than its x-height rows.
///
/// **Every line, not the one line**, because the collector corner is two — `U 0232` over
/// `LTR • EN` — and a recogniser handed both as one line reads neither. Each line is then cut
/// to the columns that hold its text, with room either side.
///
/// Empty when nothing stands out from the floor: a blank band has no text to read, and saying
/// so costs nothing, where reading it cost a detection pass.
pub fn text_lines(band: &RgbImage) -> Vec<TextLine> {
    let (w, h) = (band.width() as usize, band.height() as usize);
    if w < 16 || h < 8 {
        return Vec::new();
    }
    let gray = image::imageops::grayscale(band);
    let px = gray.as_raw();
    // A difference across a few pixels rather than one: a band is an upscale of a warp, so
    // its edges are soft, and a one-pixel difference across a soft edge is small everywhere.
    let step = (h / 40).max(1);
    if w <= step * 4 {
        return Vec::new();
    }
    let grad = |y: usize, x: usize| u32::from(px[y * w + x].abs_diff(px[y * w + x + step]));

    let rows: Vec<f32> = (0..h)
        .map(|y| (0..w - step).map(|x| grad(y, x)).sum::<u32>() as f32 / w as f32)
        .collect();
    // A little smoothing, so one noisy row can neither split a line nor make one.
    let rows = smoothed(&rows, (h / 60).max(1));
    let (floor, peak) = (quantile(&rows, 0.2), quantile(&rows, 1.0));
    // Nothing stands out — a blank band, or one that is texture from edge to edge. Relative,
    // because a short name is a fifth of a title band's width and its rows' average is a fifth
    // of what the same letters would give across the whole band: a soft `Plains` peaked at 2.7
    // over a floor of 0.9.
    if peak < floor * 1.6 + 0.5 {
        return Vec::new();
    }
    // One line's own gaps — the rows between an ascender and the x-height — are bridged; the
    // gap between two lines is wider than a quarter of either, and is not.
    let lines = runs(&rows, floor + LINE_CUT * (peak - floor), |tall| {
        (tall / 4).max(1)
    });

    let min_height = (h / 12).max(3);
    lines
        .into_iter()
        .filter(|(a, b)| b - a >= min_height)
        .filter_map(|(a, b)| {
            let tall = b - a;
            let strength = rows[a..b].iter().map(|v| v - floor).sum::<f32>();
            // Room for what the projection underweights: the tops of capitals and the tails
            // below the line carry few vertical strokes, and a line cut through them misreads.
            let above = ((tall as f32 * LINE_PAD_ABOVE).round() as usize).max(2);
            let below = ((tall as f32 * LINE_PAD_BELOW).round() as usize).max(2);
            let (top, bottom) = (a.saturating_sub(above), (b + below).min(h));
            let (left, right) = text_columns(&grad, w - step, top..bottom, tall)?;
            // Room either side: a recogniser handed a line that starts on its first letter drops
            // it — `R 0318` read as `0318`.
            let side = ((tall as f32 * LINE_PAD_SIDE).round() as usize).max(2);
            Some(TextLine {
                top: top as u32,
                bottom: bottom as u32,
                left: left.saturating_sub(side) as u32,
                right: (right + step + side).min(w) as u32,
                strength,
            })
        })
        .collect()
}

/// The columns of one line that hold its text, as `(left, right)`.
///
/// **Clusters of busy columns, grown outward from the strongest.** A band always holds a
/// piece of the frame, and the frame's *vertical* edges — the border beside the title bar, the
/// side of the collector corner — are exactly what a horizontal gradient finds. Measured on a
/// 4ED Sorceress Queen, a line box that reached the band's left edge read `|Ser`; the same box
/// from 30 px in read `Sorceres Qucen`. So a cluster at either side of the band, narrower than
/// a letter pair and a word space clear of everything else, is an edge, not text, and is
/// dropped.
///
/// Then the line is the strongest cluster and every neighbour within four line-heights of it,
/// transitively. That keeps a name's words and a collector line's fields together, and leaves
/// out what sits well apart on the same rows — the mana cost at the right end of a title bar,
/// which read as a trailing `0`.
fn text_columns(
    grad: &impl Fn(usize, usize) -> u32,
    w: usize,
    rows: std::ops::Range<usize>,
    tall: usize,
) -> Option<(usize, usize)> {
    let cols: Vec<f32> = (0..w)
        .map(|x| rows.clone().map(|y| grad(y, x)).sum::<u32>() as f32)
        .collect();
    let cols = smoothed(&cols, (tall / 8).max(1));
    let (floor, peak) = (quantile(&cols, 0.2), quantile(&cols, 0.95));
    let word_gap = (tall * 3 / 5).max(2);
    let clusters = runs(&cols, floor + COLUMN_CUT * (peak - floor), |_| 0);
    let thin = (tall * 3 / 5).max(2);
    // Only at the band's own sides, which is where the frame is: a thin cluster in the middle of
    // the line is a letter — the collector line's rarity `R` stands a word space from its number.
    let edge = |i: usize| {
        let (a, b) = clusters[i];
        let (first, last) = (i == 0, i + 1 == clusters.len());
        let before = if first {
            usize::MAX
        } else {
            a - clusters[i - 1].1
        };
        let after = if last {
            usize::MAX
        } else {
            clusters[i + 1].0 - b
        };
        let at_side = (first && a <= tall) || (last && b + tall >= w);
        at_side && b - a < thin && before > word_gap && after > word_gap
    };
    let kept: Vec<(usize, usize)> = (0..clusters.len())
        .filter(|&i| clusters.len() == 1 || !edge(i))
        .map(|i| clusters[i])
        .collect();
    let mass = |(a, b): (usize, usize)| cols[a..b].iter().map(|v| v - floor).sum::<f32>();
    let strongest = (0..kept.len()).max_by(|&i, &j| mass(kept[i]).total_cmp(&mass(kept[j])))?;
    let apart = tall * 4;
    let (mut first, mut last) = (strongest, strongest);
    while first > 0 && kept[first].0 - kept[first - 1].1 <= apart {
        first -= 1;
    }
    while last + 1 < kept.len() && kept[last + 1].0 - kept[last].1 <= apart {
        last += 1;
    }
    Some((kept[first].0, kept[last].1))
}

/// Runs of `values` above `cut`, as `(start, end)` with the end exclusive, where two runs
/// closer than `bridge(taller of the two)` are one.
fn runs(values: &[f32], cut: f32, bridge: impl Fn(usize) -> usize) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut start = None;
    for (i, v) in values
        .iter()
        .chain(std::iter::once(&f32::NEG_INFINITY))
        .enumerate()
    {
        match (start, *v > cut) {
            (None, true) => start = Some(i),
            (Some(s), false) => {
                start = None;
                if let Some(last) = out.last_mut() {
                    if s - last.1 <= bridge((last.1 - last.0).max(i - s)) {
                        last.1 = i;
                        continue;
                    }
                }
                out.push((s, i));
            }
            _ => {}
        }
    }
    out
}

/// A box filter of radius `r`.
fn smoothed(values: &[f32], r: usize) -> Vec<f32> {
    (0..values.len())
        .map(|i| {
            let (a, b) = (i.saturating_sub(r), (i + r + 1).min(values.len()));
            values[a..b].iter().sum::<f32>() / (b - a) as f32
        })
        .collect()
}

/// The value at fraction `q` of the way up `values` sorted. `values` is never empty here.
fn quantile(values: &[f32], q: f32) -> f32 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f32::total_cmp);
    sorted[((sorted.len() - 1) as f32 * q).round() as usize]
}

/// Where between a line's quiet floor and its peak a column counts as text. Low, because the
/// peak is often the frame edge rather than a letter: at a quarter, the lighter second half of
/// `Oread of Mountain's Blaze` fell under it and the line stopped at `Mour`.
const COLUMN_CUT: f32 = 0.12;
/// Where between the band's quiet floor and its peak a row counts as text.
const LINE_CUT: f32 = 0.35;
/// Rows added above a line, as a fraction of its height. More than below, because the rows the
/// projection finds are the x-height's, and capitals rise further above them than descenders
/// fall below: at a quarter, `Honor Guard` lost the tops of both capitals and read `onor uar`.
const LINE_PAD_ABOVE: f32 = 0.5;
/// Rows added below a line.
const LINE_PAD_BELOW: f32 = 0.3;
/// Columns added either side of a line.
const LINE_PAD_SIDE: f32 = 0.6;

/// What a collector line read produced.
#[derive(Debug, Clone, Default)]
pub struct CollectorRead {
    /// The line as OCR returned it, whitespace collapsed.
    pub raw: String,
    /// Every (set, number) pair worth trying, best first. See [`collector_candidates`].
    pub candidates: Vec<(String, String)>,
    pub rotated: bool,
    pub elapsed_ms: f32,
    /// The crop the recogniser actually saw, for the debug view.
    ///
    /// **Carried rather than re-derived.** The read walks several crops in two orientations
    /// and stops at the first that parses, so a viewer re-cropping "the" collector band would
    /// often be shown a different image than the one the text came from — which is worse than
    /// showing nothing, because it looks like an answer.
    pub band: Option<RgbImage>,
    /// Where `band` came from and how many real pixels it covered. See [`BandOrigin`].
    pub origin: Option<BandOrigin>,
}

/// Every plausible (set code, collector number) pairing in a collector-line read.
///
/// **Deliberately every pairing rather than a parse.** The line holds a rarity letter, a
/// number, a set code, a language and an artist, in an order that varies by frame and with
/// separators OCR renders as anything at all — so a rule like "the letters before EN are the
/// set" fits one card and breaks on the next. What makes this tractable is that the answer is
/// checkable: a caller looks each pairing up, and only a pair that names a real printing
/// survives. Guessing widely against a strict test beats parsing narrowly against none.
///
/// Ordered longest-set-code first, because `LTR` resolving is far more likely to be right than
/// a two-letter fragment that happens to collide with a real set.
pub fn collector_candidates(raw: &str) -> Vec<(String, String)> {
    let mut words: Vec<String> = Vec::new();
    // The numbers whose set size [`end_word`] dropped, by their index in `words`.
    let mut totals: Vec<usize> = Vec::new();
    let mut cur = String::new();
    // Whether a `/` has been seen since the last token ended.
    let mut slash = false;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            // **Split where the character class changes.** The separators on the card — a
            // space, a bullet, a brush glyph — are exactly what OCR drops, so `C 0035` comes
            // back as `C0035` and `HOB * EN` as `HOBEN`. Measured over the corpus this was the
            // dominant failure by a distance: most reads had the digits present and legible and
            // produced *zero* pairings, because no token began with one.
            if cur.chars().last().is_some_and(|p| p.is_ascii_digit() != ch.is_ascii_digit()) {
                end_word(&mut words, &mut totals, &mut cur, &mut slash);
            }
            cur.push(ch);
        } else {
            end_word(&mut words, &mut totals, &mut cur, &mut slash);
            slash |= ch == '/';
        }
    }
    end_word(&mut words, &mut totals, &mut cur, &mut slash);

    // **A collector number is printed zero-padded, and that is a usable filter.** Every
    // number this read correctly over the corpus came back four digits — `0001`, `0232`,
    // `0193`. A one- or two-digit token is a fragment of something else: measured, a garbage
    // read of `... D 6 T K A ...` produced a confident `LTR 6` against a true `LTR 590`.
    let digits = |t: &str| !t.is_empty() && t.chars().all(|c| c.is_ascii_digit());
    // **A number straight after another number is the set's total** when OCR lost the slash
    // between them — `end_word` drops it when the slash survived. It is never a collector
    // number: GRN 259 is a real card, so offering it would be a confident wrong printing.
    let is_total = |i: usize| i > 0 && digits(&words[i - 1]);
    let numbers: Vec<(usize, String)> = words
        .iter()
        .enumerate()
        .filter(|(i, t)| t.len() >= 3 && digits(t) && !is_total(*i))
        .map(|(i, t)| (i, t.to_ascii_lowercase()))
        .collect();

    // Set codes, best first: a whole token before any prefix of one, and longer before
    // shorter. A prefix is a guess about where OCR glued two fields together, so it should
    // never outrank a token that stands on its own.
    let usable = |t: &str| (2..=6).contains(&t.len()) && !t.eq_ignore_ascii_case("en");
    let alpha: Vec<(usize, &String)> = words
        .iter()
        .enumerate()
        .filter(|(_, t)| t.chars().all(|c| c.is_ascii_alphabetic()) && usable(t))
        .collect();

    let mut out = Vec::new();
    for (ni, number) in &numbers {
        // **Only a set code touching the number counts.** The two fields are printed
        // adjacent, and letting the search wander further down the line is what produced the
        // worst failure mode this has: on `C0004 HOHEN INVEK`, the real set read as HOHEN and
        // resolved to nothing, so the search reached the *next* word — an artist's surname
        // whose first three letters are a real set — and answered INV 4 with full confidence.
        // Wrong and certain is worse than absent, so it now answers nothing there.
        // **One exception, and it is a layout rather than a loosening.** The 2015–2022 frames
        // print `226/259 U` over `GRN • EN`, so the set sits past the total and a one-letter
        // rarity — measured on `read_eval`'s detail crops (2026-09-30), those lines came back
        // legible and paired with nothing. The reach extends to that one slot and only when a
        // total follows the number — dropped by `end_word`, or kept because OCR lost the slash —
        // so it can land on the set, the language or nothing, and never on the artist after them.
        let kept_total = words.get(ni + 1).is_some_and(|t| digits(t));
        let past_total = (kept_total || totals.contains(ni)).then(|| {
            let after = if kept_total { ni + 2 } else { ni + 1 };
            let rarity = words
                .get(after)
                .is_some_and(|t| t.len() == 1 && t.chars().all(|c| c.is_ascii_alphabetic()));
            if rarity {
                after + 1
            } else {
                after
            }
        });
        let mut near: Vec<&String> = alpha
            .iter()
            .filter(|(i, _)| i.abs_diff(*ni) <= 1 || Some(*i) == past_total)
            .map(|(_, t)| *t)
            .collect();
        near.sort_by_key(|t| std::cmp::Reverse(t.len()));

        let mut sets: Vec<String> = near.iter().map(|t| t.to_ascii_lowercase()).collect();
        // Then prefixes, which is what recovers `HOB` from `HOBEN`.
        for t in &near {
            for n in (2..t.len()).rev() {
                let pre = t[..n].to_ascii_lowercase();
                if usable(&pre) {
                    sets.push(pre);
                }
            }
        }

        for set in sets {
            // The card prints `0232`; Scryfall stores `232`. Both are offered, since a few
            // sets genuinely use a leading zero and the caller checks against the corpus.
            let trimmed = number.trim_start_matches('0');
            let n = if trimmed.is_empty() { "0" } else { trimmed };
            out.push((set.clone(), n.to_string()));
            if n != number {
                out.push((set, number.clone()));
            }
        }
    }
    out.dedup();
    out
}

/// Close the token being built in [`collector_candidates`], unless it is a set's size.
///
/// **A number after a slash that follows a number is the set size, not a collector number.**
/// A modern frame prints `051/302`: the card, then how many cards the set has. Kept
/// as a token, the denominator is a three-digit number like any other and is offered as a
/// collector number beside the real one — live on 2026-09-15, Disruption Protocol NEO 51
/// resolved to `NEO 302`, which is a Forest. Dropped from the stream rather than only from the
/// numbers, so it does not sit between the collector number and the set code either and push
/// the set out of the one-word reach the pairing allows.
fn end_word(words: &mut Vec<String>, totals: &mut Vec<usize>, cur: &mut String, slash: &mut bool) {
    if cur.is_empty() {
        return;
    }
    let digits = |t: &str| t.chars().all(|c| c.is_ascii_digit());
    let set_size = *slash && digits(cur) && words.last().is_some_and(|w| digits(w));
    let word = std::mem::take(cur);
    if set_size {
        // Remembered against the number it followed, so the pairing still knows the frame
        // printed `number/total` and can reach past the rarity to the set.
        totals.push(words.len() - 1);
    } else {
        words.push(word);
    }
    *slash = false;
}

/// How well a collector-line read fits one printing, best highest. See [`collector_fit`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct CollectorFit(u8);

/// Does a collector-line read fit the printing `set` / `number`, and how well?
///
/// **A test against a known answer, not a parse**, for a line too blurry to parse:
/// [`crate::reference::Reference::collector_among`] asks it of each printing of a card already
/// named, so a fit only ever chooses *among* those. Three grades, best first:
///
/// - **number and set** — a token reads as the number, and a token is within one edit of the
///   set code;
/// - **number alone** — a token of at least three characters, with at least one real digit in
///   it, reads as the number. Modern lines print the number zero-padded to four digits, so a
///   one- or two-character token is too easily noise;
/// - **set alone, exactly** — a token contains the set code letter for letter, and no token
///   reads cleanly as some *other* number.
///
/// A token reads as a number once the letters OCR confuses with digits are mapped back
/// (`O Q D` → 0, `I L` → 1, `Z` → 2, `S` → 5, `G` → 6, `B` → 8) and leading zeros are stripped,
/// with the rarity letter a line prints before the number (`U0014`) allowed to stick to it.
/// Measured live on 2026-09-30, `U 0014 / LTR • EN` read as `OO14 TRCN S`: `OO14` is 14 and
/// `TR` is one edit from `LTR`, which the blind parse could never have paired.
pub fn collector_fit(raw: &str, set: &str, number: &str) -> Option<CollectorFit> {
    let set = set.to_ascii_uppercase();
    let number = number.trim_start_matches('0').to_ascii_lowercase();
    let tokens: Vec<String> = raw
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_ascii_uppercase)
        .collect();
    let number_read = !number.is_empty()
        && tokens.iter().any(|t| {
            let stuck = t.chars().next().is_some_and(|c| c.is_ascii_alphabetic());
            let tails = [Some(t.as_str()), stuck.then(|| &t[1..])];
            tails.into_iter().flatten().any(|n| read_number(n).is_some_and(|d| d == number))
        });
    let long_number_read = !number.is_empty()
        && tokens.iter().any(|t| {
            t.len() >= 3
                && t.chars().any(|c| c.is_ascii_digit())
                && read_number(t).is_some_and(|d| d == number)
        });
    // A number read cleanly that is not this printing's says the line is some other printing's,
    // so the set alone is then no evidence for this one.
    let other_number = tokens.iter().any(|t| t.len() >= 3 && read_number(t).is_some());
    let set_edits = tokens.iter().filter_map(|t| set_distance(t, &set)).min();
    match (number_read, set_edits) {
        (true, Some(e)) if e <= 1 => Some(CollectorFit(3)),
        _ if long_number_read => Some(CollectorFit(2)),
        (false, Some(0)) if !other_number => Some(CollectorFit(1)),
        _ => None,
    }
}

/// A token as a collector number, confusable letters mapped to digits and leading zeros
/// stripped — `None` unless every character is then a digit and at least one was one to start.
fn read_number(token: &str) -> Option<String> {
    if !token.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    let mapped: String = token
        .chars()
        .map(|c| match c {
            'O' | 'Q' | 'D' => '0',
            'I' | 'L' => '1',
            'Z' => '2',
            'S' => '5',
            'G' => '6',
            'B' => '8',
            c => c,
        })
        .collect();
    let digits = mapped.trim_start_matches('0');
    (mapped.chars().all(|c| c.is_ascii_digit()) && !digits.is_empty()).then(|| digits.to_string())
}

/// The fewest edits between `set` and any stretch of `token` within one character of its
/// length. `None` for a token or set too short to say anything.
fn set_distance(token: &str, set: &str) -> Option<u32> {
    let (t, s) = (token.as_bytes(), set.as_bytes());
    if t.len() < 2 || s.len() < 2 {
        return None;
    }
    let mut best: Option<u32> = None;
    for len in s.len().saturating_sub(1).max(2)..=(s.len() + 1).min(t.len()) {
        for window in t.windows(len) {
            let d = levenshtein(window, s);
            best = Some(best.map_or(d, |b| b.min(d)));
        }
    }
    best
}

fn levenshtein(a: &[u8], b: &[u8]) -> u32 {
    let mut row: Vec<u32> = (0..=b.len() as u32).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut prev = row[0];
        row[0] = i as u32 + 1;
        for (j, cb) in b.iter().enumerate() {
            let cur = row[j + 1];
            row[j + 1] = if ca == cb { prev } else { 1 + prev.min(row[j]).min(cur) };
            prev = cur;
        }
    }
    row[b.len()]
}

#[cfg(feature = "ocr")]
mod engine {
    use super::*;
    use ocrs::{ImageSource, OcrEngine, OcrEngineParams};
    use rten_imageproc::{RectF, RotatedRect};
    use std::path::Path;

    /// What the collector line prints, as far as the recogniser's alphabet can say it.
    ///
    /// **Narrowed because the line holds nothing else**: a rarity letter, a number, a set code,
    /// a language, and the separators between them. Letting the recogniser answer lowercase and
    /// punctuation only gave it more ways to be wrong — a lowercase `o` where the card prints
    /// `0` becomes, here, whichever of `O` and `0` the model finds likelier. `O/0` and `I/1`
    /// stay the parse's problem. The bullet and the star the card prints are not in the model's
    /// alphabet at all, so they cannot be allowed; `*` is what the star has always read as.
    const COLLECTOR_CHARS: &str = " 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/*";

    /// How many of a title band's lines are read. The name is the strongest line almost
    /// always; the second is for the band that also caught the top of the art or a subtitle,
    /// and the line with more letters in it wins.
    const TITLE_LINES: usize = 2;
    /// How many of a collector band's lines are read — both printed lines, and one more for a
    /// crop that caught the bottom of the text box.
    const COLLECTOR_LINES: usize = 3;

    /// A loaded OCR engine. Construction reads ~22 MB of model, so build one and keep it.
    pub struct TitleReader {
        /// The title's recogniser, and the detection model the old path ran.
        title: OcrEngine,
        /// The same recognition model, restricted to [`COLLECTOR_CHARS`]. A second copy
        /// because `ocrs` takes the restriction per engine, not per call.
        collector: OcrEngine,
        /// Find the text with `ocrs`'s detection model, as every read did before #707.
        detect: bool,
    }

    /// Which band a read is of — they are read by different engines and kept differently.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Band {
        Title,
        Collector,
    }

    impl TitleReader {
        /// Load the ocrs detection and recognition models.
        ///
        /// Fetch them with `scripts/fetch-ocr-models.mjs`; they are not vendored, for the same
        /// reason the hash bundle is not.
        pub fn load(detection: &Path, recognition: &Path) -> anyhow_lite::Result<TitleReader> {
            let read = |what: &str, path: &Path| {
                std::fs::read(path).map_err(|e| format!("{what} model {}: {e}", path.display()))
            };
            let (d, r) = (
                read("detection", detection)?,
                read("recognition", recognition)?,
            );
            TitleReader::from_bytes(&d, &r).map_err(|e| {
                format!(
                    "{e} ({} and {})",
                    detection.display(),
                    recognition.display()
                )
            })
        }

        /// The same, from the two model files' bytes — an embedded copy, say.
        ///
        /// `rten::Model::load` takes an owned buffer, so this copies each model once — the
        /// recognition model twice, for the collector's narrowed engine: ~22 MB together, once
        /// per session. `load_static_slice` would avoid it and would tie the signature to
        /// `'static`, which a caller holding a file it just read cannot give.
        pub fn from_bytes(
            detection: &[u8],
            recognition: &[u8],
        ) -> anyhow_lite::Result<TitleReader> {
            let detection_model = rten::Model::load(detection.to_vec())
                .map_err(|e| format!("detection model: {e}"))?;
            let recognition_model = || {
                rten::Model::load(recognition.to_vec())
                    .map_err(|e| format!("recognition model: {e}"))
            };
            let title = OcrEngine::new(OcrEngineParams {
                detection_model: Some(detection_model),
                recognition_model: Some(recognition_model()?),
                ..Default::default()
            })
            .map_err(|e| format!("ocr engine: {e}"))?;
            let collector = OcrEngine::new(OcrEngineParams {
                recognition_model: Some(recognition_model()?),
                allowed_chars: Some(COLLECTOR_CHARS.to_string()),
                ..Default::default()
            })
            .map_err(|e| format!("ocr engine: {e}"))?;
            Ok(TitleReader {
                title,
                collector,
                detect: false,
            })
        }

        /// Find the text with `ocrs`'s detection model instead of [`text_lines`], with the
        /// full alphabet on both bands — the read exactly as it was before #707.
        ///
        /// **Kept so the two can be measured on the same bands in one process**, which is the
        /// only fair comparison while other work shares the machine; `ocr-bench` is what turns
        /// it on. Nothing else should.
        pub fn set_text_detection(&mut self, on: bool) {
            self.detect = on;
        }

        fn read_band(&self, band: &RgbImage, what: Band) -> Option<String> {
            let src = ImageSource::from_bytes(band.as_raw(), (band.width(), band.height())).ok()?;
            if self.detect {
                let input = self.title.prepare_input(src).ok()?;
                return self.title.get_text(&input).ok();
            }

            let (engine, keep) = match what {
                Band::Title => (&self.title, TITLE_LINES),
                Band::Collector => (&self.collector, COLLECTOR_LINES),
            };
            let mut lines = text_lines(band);
            if lines.is_empty() {
                return Some(String::new());
            }
            // The strongest lines, then back into reading order: the collector parse pairs
            // tokens by adjacency, so `U 0232` has to come before `LTR EN`.
            lines.sort_by(|a, b| b.strength.total_cmp(&a.strength));
            lines.truncate(keep);
            lines.sort_by_key(|l| l.top);

            // One box per line, straight to the recogniser — the band was cropped because we
            // know where the text is, so nothing has to go looking for it.
            let boxes: Vec<Vec<RotatedRect>> = lines
                .iter()
                .map(|l| {
                    let (t, le, b, r) =
                        (l.top as f32, l.left as f32, l.bottom as f32, l.right as f32);
                    vec![RotatedRect::from_rect(RectF::from_tlbr(t, le, b, r))]
                })
                .collect();
            let input = engine.prepare_input(src).ok()?;
            let read = engine.recognize_text(&input, &boxes).ok()?;
            let texts = read
                .into_iter()
                .map(|l| l.map(|l| l.to_string()).unwrap_or_default());
            match what {
                // The line most like a name. Upside-down, the band's strongest line is the
                // collector line, and the orientation choice compares letters for that reason.
                Band::Title => texts.max_by_key(|t| letters(t)),
                Band::Collector => Some(texts.collect::<Vec<_>>().join("\n")),
            }
        }

        /// Read the title from both orientations and keep the more plausible one.
        ///
        /// **Both, for the reason everything else in this crate reads both**: a card is
        /// 180°-symmetric and the quad cannot say which end is the top. Upside-down, the title
        /// band contains the collector line and the artist credit, which OCR reads perfectly
        /// well — so "did it return text" cannot decide it. The longer alphabetic result wins,
        /// because a name is longer than a set code and a collector number.
        pub fn read_title(&self, src: &BandSource<'_>) -> TitleRead {
            let started = std::time::Instant::now();
            let (ba, bb) = (src.band(TITLE_BAND, 2, false), src.band(TITLE_BAND, 2, true));
            let a = self.read_band(&ba, Band::Title).unwrap_or_default();
            let b = self.read_band(&bb, Band::Title).unwrap_or_default();

            let rotated = letters(&b) > letters(&a);
            if rotated {
                title_read(bb, b, true, started)
            } else {
                title_read(ba, a, false, started)
            }
        }

        /// Read the title the way up the hash chose first, and the other way only when that
        /// read is not an exact name.
        ///
        /// **The second read is kept, and that is deliberate.** The title reader earns its
        /// cost on a foil under a lamp, where the hash's candidates are noise, so the
        /// orientation it chose is close to a coin flip. What the clean case saves is the
        /// second read when the first already names a card with no edits. `edits` answers how
        /// far a normalized read is from a card name, or `None` for no card.
        ///
        /// When both are read, an exact name beats a corrected one beats none. Between two
        /// equal reads, the one with more letters wins, which is [`TitleReader::read_title`]'s
        /// rule.
        pub fn read_title_first(
            &self,
            src: &BandSource<'_>,
            flipped_first: bool,
            edits: &dyn Fn(&str) -> Option<u32>,
        ) -> TitleRead {
            let started = std::time::Instant::now();
            let band_a = src.band(TITLE_BAND, 2, flipped_first);
            let a = self.read_band(&band_a, Band::Title).unwrap_or_default();
            let a_edits = edits(&normalize(&a));
            if a_edits == Some(0) {
                return title_read(band_a, a, flipped_first, started);
            }
            let band_b = src.band(TITLE_BAND, 2, !flipped_first);
            let b = self.read_band(&band_b, Band::Title).unwrap_or_default();
            let b_edits = edits(&normalize(&b));
            let rank = |e: Option<u32>| match e {
                Some(0) => 2,
                Some(_) => 1,
                None => 0,
            };
            let take_b = match rank(b_edits).cmp(&rank(a_edits)) {
                std::cmp::Ordering::Greater => true,
                std::cmp::Ordering::Less => false,
                std::cmp::Ordering::Equal => letters(&b) > letters(&a),
            };
            if take_b {
                title_read(band_b, b, !flipped_first, started)
            } else {
                title_read(band_a, a, flipped_first, started)
            }
        }
    }

    fn letters(s: &str) -> usize {
        s.chars().filter(|c| c.is_ascii_alphabetic()).count()
    }

    fn title_read(
        band: RgbImage,
        raw: String,
        rotated: bool,
        started: std::time::Instant,
    ) -> TitleRead {
        TitleRead {
            band: Some(band),
            normalized: normalize(&raw),
            raw: raw.split_whitespace().collect::<Vec<_>>().join(" "),
            rotated,
            elapsed_ms: started.elapsed().as_secs_f32() * 1000.0,
        }
    }

    impl TitleReader {
        /// Read the collector line from both orientations.
        ///
        /// Which way up is settled by which read yields *resolvable* pairings, so unlike the
        /// title there is no heuristic here — the caller checks each candidate against the
        /// corpus and an upside-down read simply produces none that resolve.
        pub fn read_collector(&self, src: &BandSource<'_>) -> CollectorRead {
            self.read_collector_first(src, false)
        }

        /// The same, starting from the way up the hash chose rather than always from upright.
        ///
        /// A card held upside-down read the flipped band only after the upright one found
        /// nothing, so it always paid for two reads. The hash already knows which way up won.
        pub fn read_collector_first(
            &self,
            src: &BandSource<'_>,
            flipped_first: bool,
        ) -> CollectorRead {
            let started = std::time::Instant::now();
            // **The first crop settles which way up, and the fallbacks only ever try that
            // one.** Both orientations of every crop is six reads at ~130 ms each, and the
            // cost lands exactly the wrong way round: a card that reads resolves on the first
            // attempt, while a card that cannot be read pays for all six. Deciding the
            // orientation once takes the worst case from 785 ms to roughly half that.
            let mut shown = src.band(COLLECTOR_BAND, 4, flipped_first);
            let mut shown_at = COLLECTOR_BAND;
            let up = self.read_band(&shown, Band::Collector).unwrap_or_default();
            let mut candidates = collector_candidates(&up);
            let mut raw = up;
            let mut from_second = false;

            if candidates.is_empty() {
                let flip = src.band(COLLECTOR_BAND, 4, !flipped_first);
                let down = self.read_band(&flip, Band::Collector).unwrap_or_default();
                let found = collector_candidates(&down);
                // Digits decide it, not length: upside-down, this band holds the *title*,
                // which reads long and cleanly and would win any "more text" comparison while
                // containing nothing that could ever resolve.
                let digits = |t: &str| t.chars().filter(|c| c.is_ascii_digit()).count();
                if !found.is_empty() || digits(&down) > digits(&raw) {
                    from_second = true;
                    candidates = found;
                    raw = down;
                    shown = flip;
                }
            }
            let rotated = flipped_first != from_second;

            // Wider, then higher — only in the orientation already chosen.
            if candidates.is_empty() {
                for at in COLLECTOR_FALLBACKS {
                    let crop = src.band(at, 4, rotated);
                    let text = self.read_band(&crop, Band::Collector).unwrap_or_default();
                    let found = collector_candidates(&text);
                    if !found.is_empty() {
                        candidates = found;
                        raw = text;
                        shown = crop;
                        shown_at = at;
                        break;
                    }
                }
            }

            CollectorRead {
                raw: raw.split_whitespace().collect::<Vec<_>>().join(" "),
                candidates,
                band: Some(shown),
                origin: src.origin(shown_at, rotated),
                rotated,
                elapsed_ms: started.elapsed().as_secs_f32() * 1000.0,
            }
        }
    }

    /// A local stand-in so this module does not pull `anyhow` into the crate for two calls.
    pub mod anyhow_lite {
        pub type Result<T> = std::result::Result<T, String>;
    }
}

#[cfg(feature = "ocr")]
pub use engine::{anyhow_lite, TitleReader};

#[cfg(test)]
mod tests {
    use super::*;

    /// Every string here is a real read from the corpus, kept verbatim including the
    /// mistakes — the whole difficulty of this parse is what OCR does to the separators, and
    /// an invented fixture would quietly test the easy version.
    #[test]
    fn a_clean_collector_line_resolves_to_its_set_and_number() {
        let c = collector_candidates("U 0232 LTR EN");
        assert!(c.contains(&("ltr".into(), "232".into())), "got {c:?}");
    }

    /// The reads are verbatim from the 2026-09-30 live pass on a 1080p webcam, where the whole
    /// line spanned about 136×69 source pixels.
    #[test]
    fn a_blurry_collector_read_fits_the_printing_it_shows() {
        let both = collector_fit("OO14 TRCN S", "ltr", "14");
        let number = collector_fit("U OO14", "ltr", "14");
        let set = collector_fit("LTRCN SOG", "ltr", "14");
        assert!(both > number && number > set && set.is_some(), "{both:?} {number:?} {set:?}");
        assert_eq!(collector_fit("U0014 LTR", "ltr", "14"), both, "a rarity letter stuck on");
        // Nothing that reads as its number or its set.
        assert_eq!(collector_fit("1XRE SOM", "ltr", "14"), None);
        assert_eq!(collector_fit("1", "ltr", "1"), None, "one character is noise");
        assert_eq!(collector_fit("IL LTR", "ltr", "11"), set, "letters alone are not a number");
        // A clean number of another printing takes the set's word away.
        assert_eq!(collector_fit("U 0426 LTR EN", "ltr", "14"), None);
    }

    #[test]
    fn a_glued_set_and_language_still_yields_the_set() {
        // `HOB * EN` comes back as `HOBEN`: the separator is a bullet OCR does not see. This
        // was the dominant failure over the corpus — the digits were legible and present, and
        // the read produced no pairings at all.
        let c = collector_candidates("C0035 HOBEN COLIN BOYER");
        assert!(c.contains(&("hob".into(), "35".into())), "got {c:?}");
    }

    #[test]
    fn a_rarity_glued_to_the_number_is_split_off() {
        // `C 0035` reads as `C0035`, and a token beginning with a letter was never offered as
        // a number, so nothing resolved however good the rest of the line was.
        let c = collector_candidates("C0004 HOB EN");
        assert!(c.contains(&("hob".into(), "4".into())), "got {c:?}");
    }

    #[test]
    fn a_word_beyond_the_set_code_is_not_reachable() {
        // The measured worst case: the true set read as HOHEN and resolves to nothing, so a
        // wider search reached the next word — an artist's surname whose first three letters
        // are Invasion — and answered INV 4 with full confidence. Wrong and certain is worse
        // than absent.
        let c = collector_candidates("C0004 HOHEN INVEK");
        assert!(
            !c.iter().any(|(s, _)| s == "inv"),
            "a word two places from the number was offered as the set: {c:?}"
        );
    }

    #[test]
    fn a_short_number_is_noise_rather_than_a_collector_number() {
        // Printed numbers are zero-padded; every correct read over the corpus was four
        // digits. A bare `6` inside a garbage line produced a confident `LTR 6` against a
        // true `LTR 590`.
        let c = collector_candidates("I LTR OEN TruERLC D 6 T K A SRA");
        assert!(
            c.is_empty(),
            "a one-digit fragment was taken as a collector number: {c:?}"
        );
    }

    #[test]
    fn a_numbered_frame_reaches_its_set_past_the_total_and_the_rarity() {
        // The 2015–2022 frames print `226/259 U` over `GRN • EN`, so the set code is three
        // tokens from the number. Real reads from `read_eval`'s detail crops (2026-09-30), every
        // one legible and every one producing no pairing at all before this.
        for (raw, set, number) in [
            ("226/259 U GRNEN OMITRY", "grn", "226"),
            ("084/249 C IMASEN SHS", "ima", "84"),
            ("221/ 259 RNA EN S RAN", "rna", "221"),
            ("272/280 L ZNREN SAM BU", "znr", "272"),
            ("004/012 P FNM FNM*EN IASON", "fnm", "4"),
            // The same line with the slash lost: the total is then a token of its own.
            ("226 259 U GRNEN OMITRY", "grn", "226"),
        ] {
            let c = collector_candidates(raw);
            assert!(c.contains(&(set.into(), number.into())), "{raw}: got {c:?}");
        }
    }

    #[test]
    fn the_total_is_never_offered_as_a_collector_number() {
        // `226/259`: GRN 259 is a real card, so offering the set's total as a number is a
        // confident wrong printing — the failure the adjacency rule exists to prevent.
        for raw in ["226/259 U GRNEN OMITRY", "226 259 U GRNEN OMITRY"] {
            let c = collector_candidates(raw);
            assert!(!c.iter().any(|(_, n)| n == "259"), "{raw}: the total was offered: {c:?}");
        }
    }

    #[test]
    fn past_the_total_the_search_still_stops_at_the_set() {
        // With no set code where it belongs, the next words are the language and the artist,
        // and an artist is exactly what `a_word_beyond_the_set_code_is_not_reachable` fences.
        let c = collector_candidates("226/259 U EN INVEK");
        assert!(!c.iter().any(|(s, _)| s.starts_with("inv")), "reached the artist: {c:?}");
    }

    #[test]
    fn the_language_is_never_offered_as_a_set() {
        // `EN` is on every English card and would otherwise be the most common set code in
        // the corpus by a wide margin.
        let c = collector_candidates("U 0232 EN");
        assert!(!c.iter().any(|(s, _)| s == "en"), "got {c:?}");
    }

    #[test]
    fn a_set_size_is_not_offered_as_a_collector_number() {
        // Disruption Protocol, NEO 51, live on 2026-09-15: the read resolved to `NEO 302`,
        // which is a Forest, and the tier that names a printing contributed nothing. The raw
        // string was not kept — §8 item 16 records the printed `051/302` and the NEO pairing
        // it produced, and `NEO 302` resolving means the set code sat beside the denominator.
        let c = collector_candidates("051/302 NEO EN");
        assert!(c.contains(&("neo".into(), "51".into())), "got {c:?}");
        assert!(!c.iter().any(|(_, n)| n == "302"), "the set size was offered: {c:?}");

        // Spaces round the slash do not hide it.
        let c = collector_candidates("051 / 302 NEO");
        assert_eq!(c.first(), Some(&("neo".into(), "51".into())), "got {c:?}");
    }

    #[test]
    fn a_slash_with_no_number_before_it_drops_nothing() {
        // Only a number that follows a number and a slash is a set size. A slash OCR invented
        // in front of the only number on the line must not cost the read its collector number.
        let c = collector_candidates("U /0232 LTR EN");
        assert!(c.contains(&("ltr".into(), "232".into())), "got {c:?}");
    }

    #[test]
    fn a_whole_token_outranks_a_prefix_of_one() {
        // Prefixes exist to recover a glued field, so they are a guess; a token that stands
        // on its own is not. The caller takes the first pairing that resolves, so the order
        // here is the difference between a right answer and a plausible one.
        let c = collector_candidates("0232 LTR");
        let whole = c.iter().position(|(s, _)| s == "ltr");
        let prefix = c.iter().position(|(s, _)| s == "lt");
        assert!(
            whole < prefix,
            "a prefix was offered before the whole token: {c:?}"
        );
    }

    #[test]
    fn normalize_strips_what_ocr_gets_wrong() {
        // Apostrophes, commas and hyphens are exactly the characters OCR renders
        // inconsistently, so both sides of the comparison lose them.
        assert_eq!(
            normalize("Strider, Ranger of the North"),
            "strider ranger of the north"
        );
        assert_eq!(normalize("Kroxa's Return"), "kroxa s return");
        assert_eq!(normalize("  Fire // Ice  "), "fire ice");
        assert_eq!(normalize("Ætherize"), "therize"); // non-ASCII drops; both sides do
        assert_eq!(normalize("---"), "");
    }

    #[test]
    fn usability_rejects_noise_but_accepts_a_name() {
        let mk = |s: &str| TitleRead {
            band: None,
            raw: s.into(),
            normalized: normalize(s),
            rotated: false,
            elapsed_ms: 0.0,
        };
        assert!(!mk("").is_usable());
        assert!(!mk("l|").is_usable());
        assert!(
            !mk("12 34").is_usable(),
            "digits alone are a collector line, not a name"
        );
        assert!(mk("Oliphaunt").is_usable());
    }

    #[test]
    fn the_title_band_is_where_a_title_is() {
        // A 488x680 card's name sits in the top eighth and stops before the mana cost.
        let card = RgbImage::new(crate::RECTIFIED_W, crate::RECTIFIED_H);
        let band = title_band(&card);
        // Upscaled 2x, so compare against twice the crop.
        assert_eq!(band.width(), ((0.780 - 0.045) * 488.0) as u32 * 2);
        assert_eq!(band.height(), ((0.130 - 0.025) * 680.0) as u32 * 2);
        assert!(
            band.height() < card.height(),
            "the band is a band, not the card"
        );
    }

    #[test]
    fn a_tiny_image_does_not_panic() {
        let band = title_band(&RgbImage::new(4, 4));
        assert!(band.width() >= 1 && band.height() >= 1);
        assert!(text_lines(&RgbImage::new(4, 4)).is_empty());
        // Taller than it is wide: the gradient's step is a fortieth of the height.
        assert!(text_lines(&RgbImage::new(16, 2000)).is_empty());
    }

    /// A light band, 716×142 — a title band's size at its 2× scale.
    fn light_band(w: u32, h: u32) -> RgbImage {
        RgbImage::from_pixel(w, h, image::Rgb([220, 215, 200]))
    }

    /// Dark vertical strokes 3 px wide every 8 px across `x0..x1`, rows `y0..y1` — the part of a
    /// line of type the projection responds to.
    fn strokes(band: &mut RgbImage, (x0, x1): (u32, u32), (y0, y1): (u32, u32)) {
        for x in (x0..x1).filter(|x| (x - x0) % 8 < 3) {
            for y in y0..y1 {
                band.put_pixel(x, y, image::Rgb([30, 30, 30]));
            }
        }
    }

    #[test]
    fn a_blank_band_has_no_lines() {
        // Reading it cost a detection pass; saying so costs nothing.
        assert!(text_lines(&light_band(716, 142)).is_empty());
    }

    #[test]
    fn a_line_is_found_and_boxed_around_its_strokes() {
        let mut band = light_band(716, 142);
        strokes(&mut band, (60, 300), (40, 80));
        let lines = text_lines(&band);
        assert_eq!(lines.len(), 1, "got {lines:?}");
        let l = lines[0];
        assert!(
            l.top <= 40 && l.bottom >= 80,
            "the box must hold the strokes: {l:?}"
        );
        assert!(
            l.left <= 60 && l.right >= 300,
            "the box must hold the strokes: {l:?}"
        );
        assert!(
            l.top > 10 && l.bottom < 110,
            "the box should be the line, not the band: {l:?}"
        );
        assert!(l.right < 400, "the box should stop near the text: {l:?}");
    }

    #[test]
    fn both_collector_lines_are_found_in_reading_order() {
        // `U 0232` over `LTR • EN`: handed to the recogniser as one line, it reads neither.
        let mut band = light_band(560, 196);
        strokes(&mut band, (20, 200), (30, 70));
        strokes(&mut band, (20, 320), (110, 150));
        let lines = text_lines(&band);
        assert_eq!(lines.len(), 2, "got {lines:?}");
        assert!(
            lines[0].bottom <= lines[1].top,
            "two separate lines, top first: {lines:?}"
        );
    }

    #[test]
    fn a_vertical_frame_edge_is_not_part_of_the_line() {
        // Measured: a box that reached the band's left edge read `|Ser` for Sorceress Queen,
        // and the same box from 30 px in read the name.
        let mut band = light_band(716, 142);
        for x in 0..6 {
            for y in 0..142 {
                band.put_pixel(x, y, image::Rgb([20, 30, 25]));
            }
        }
        strokes(&mut band, (60, 300), (40, 80));
        let lines = text_lines(&band);
        assert_eq!(lines.len(), 1, "got {lines:?}");
        assert!(
            lines[0].left > 20,
            "the frame edge was kept in the line: {:?}",
            lines[0]
        );
    }

    #[test]
    fn a_horizontal_rule_is_not_a_line() {
        // The title bar's rule and the top of the art window are horizontal edges; the
        // projection is of the horizontal gradient precisely so they do not count.
        let mut band = light_band(716, 142);
        for x in 0..716 {
            for y in 100..104 {
                band.put_pixel(x, y, image::Rgb([20, 20, 20]));
            }
        }
        assert!(text_lines(&band).is_empty());
    }

    #[test]
    fn a_mark_well_apart_on_the_same_rows_is_left_out() {
        // The mana cost at the right end of a title bar read as a trailing `0`.
        let mut band = light_band(716, 142);
        strokes(&mut band, (40, 260), (40, 80));
        strokes(&mut band, (660, 700), (40, 80));
        let lines = text_lines(&band);
        assert_eq!(lines.len(), 1, "got {lines:?}");
        assert!(
            lines[0].right < 600,
            "the far mark was taken into the line: {:?}",
            lines[0]
        );
    }

    /// A 488×680 card with structure everywhere — smooth enough that two resamplers agree, varied
    /// enough that a band landing a few pixels off does not.
    fn patterned_card() -> RgbImage {
        RgbImage::from_fn(crate::RECTIFIED_W, crate::RECTIFIED_H, |x, y| {
            let (fx, fy) = (x as f32, y as f32);
            image::Rgb([
                (128.0 + 100.0 * (fx / 23.0).sin()) as u8,
                (128.0 + 100.0 * (fy / 17.0).cos()) as u8,
                ((x + y) % 256) as u8,
            ])
        })
    }

    fn mean_diff(a: &RgbImage, b: &RgbImage) -> f64 {
        assert_eq!(a.dimensions(), b.dimensions(), "the bands are different sizes");
        let sum: f64 = a
            .pixels()
            .zip(b.pixels())
            .map(|(p, q)| p.0.iter().zip(q.0).map(|(x, y)| (f64::from(*x) - f64::from(y)).abs()).sum::<f64>())
            .sum();
        sum / f64::from(a.width() * a.height() * 3)
    }

    /// `card` placed in a larger frame at `k` times its size, and the quad it sits at.
    fn in_a_frame(card: &RgbImage, k: u32) -> (RgbImage, crate::detect::Quad) {
        let (w, h) = (card.width() * k, card.height() * k);
        let big = image::imageops::resize(card, w, h, image::imageops::FilterType::Triangle);
        let mut frame = RgbImage::from_pixel(w + 200, h + 120, image::Rgb([20, 20, 20]));
        image::imageops::replace(&mut frame, &big, 100, 60);
        let (x0, y0, x1, y1) = (100.0, 60.0, 100.0 + w as f32, 60.0 + h as f32);
        (frame, crate::detect::Quad { corners: [(x0, y0), (x1, y0), (x1, y1), (x0, y1)] })
    }

    #[test]
    fn a_band_warped_from_the_frame_is_the_band_cropped_from_the_card() {
        // The whole of the geometry in one comparison: the band's corners, carried through the
        // quad's homography into the frame, land on the pixels the rectified crop reads — both
        // ways up. A band a few pixels off would not agree with it on this pattern.
        let card = patterned_card();
        let flipped = image::imageops::rotate180(&card);
        let (frame, quad) = in_a_frame(&card, 2);
        let pixels = CardPixels::new(frame, quad, crate::trim::Margin::default());
        let rectified = BandSource::Rectified { upright: &card, flipped: &flipped };
        let from_frame = BandSource::Frame(&pixels);
        for rotated in [false, true] {
            for (at, scale) in [(TITLE_BAND, 2), (COLLECTOR_BAND, 4)] {
                let d = mean_diff(&from_frame.band(at, scale, rotated), &rectified.band(at, scale, rotated));
                assert!(d < 6.0, "band {at:?} rotated {rotated}: mean diff {d:.2}");
            }
        }
    }

    #[test]
    fn a_band_warped_from_the_frame_honours_the_trim() {
        // The rectified card a band is cropped from was trimmed and stretched back to 488×680, so
        // a fraction of it is a point inside the margin on the untrimmed card. Reading the frame
        // without that mapping lands every band on background.
        let card = patterned_card();
        let m = crate::trim::Margin { left: 12, top: 20, right: 30, bottom: 8 };
        let trimmed = crate::trim::apply(&card, m).expect("a margin the trim accepts");
        let trimmed_180 = crate::trim::apply(&image::imageops::rotate180(&card), m.rotated_180())
            .expect("a margin the trim accepts");
        let (frame, quad) = in_a_frame(&card, 1);
        let pixels = CardPixels::new(frame, quad, m);
        let rectified = BandSource::Rectified { upright: &trimmed, flipped: &trimmed_180 };
        for rotated in [false, true] {
            let d = mean_diff(
                &BandSource::Frame(&pixels).band(TITLE_BAND, 2, rotated),
                &rectified.band(TITLE_BAND, 2, rotated),
            );
            assert!(d < 8.0, "rotated {rotated}: mean diff {d:.2}");
        }
    }
}
