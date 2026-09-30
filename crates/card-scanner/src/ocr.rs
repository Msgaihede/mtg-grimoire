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
/// all: a read costs roughly **340 ms against a ~350 ms frame** (release, measured 2026-09-08),
/// so the common case has to stay at one. Only a card the
/// first band cannot see pays for the second.
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

/// The whole collector corner, from just below the text box to the card's foot, at the
/// collector band's width.
///
/// **Read for where the line is, never read whole.** [`text_rows`] finds the block of text in
/// it and the read is cropped to that block, so where [`COLLECTOR_FALLBACKS`] guesses at the
/// line's height in a fixed order, this measures it. Kept to [`COLLECTOR_BAND`]'s 28.5% across
/// for that band's reason: the artist credit past it is what read as `INVEN` and resolved to
/// Invasion.
const COLLECTOR_REGION: (f32, f32, f32, f32) = (0.018, 0.860, 0.285, 1.000);

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
        let q = crate::detect::Quad {
            corners: [at_card(x0, y0), at_card(x1, y0), at_card(x1, y1), at_card(x0, y1)],
        };
        let (bw, bh) = band_extent(at, crate::RECTIFIED_W, crate::RECTIFIED_H);
        crate::detect::rectify_to(&self.image, &q, bw * scale, bh * scale)
    }
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
}

/// The rows of `band` that hold its text — a line, or with `block` a block of lines.
///
/// **A row projection of the horizontal gradient.** Letterforms are mostly vertical strokes,
/// so a row through text crosses dark-light-dark many times and its sum of `|∂I/∂x|` is high;
/// the frame's own edges — the title bar's rule, the border, the top of the art window — are
/// *horizontal*, so they change `∂I/∂y` and barely move this at all. That asymmetry is what
/// lets a generous band be cut down to the line without being fooled by the frame edge a crop
/// of it always contains.
///
/// The strongest run of rows above a threshold set between the quiet floor and the peak wins;
/// runs a small gap apart are one line (a line's ascender rows are weaker than its x-height
/// rows), and with `block` a gap up to most of a line's height is bridged too, because the
/// collector corner is two lines — `U 0232` over `LTR • EN` — and both belong to the read.
///
/// `None` when nothing stands out from the floor, or when the text already fills the band:
/// the caller then reads the whole band, exactly as it did before this existed.
pub fn text_rows(band: &RgbImage, block: bool) -> Option<(u32, u32)> {
    let (w, h) = (band.width() as usize, band.height() as usize);
    if w < 8 || h < 12 {
        return None;
    }
    let gray = image::imageops::grayscale(band);
    let raw = gray.as_raw();
    let energy: Vec<f32> = (0..h)
        .map(|y| {
            let row = &raw[y * w..(y + 1) * w];
            let sum: u32 = row.windows(2).map(|p| u32::from(p[0].abs_diff(p[1]))).sum();
            sum as f32 / w as f32
        })
        .collect();
    // A little smoothing, so one noisy row cannot split a line or make one.
    let r = (h / 40).max(1);
    let smooth: Vec<f32> = (0..h)
        .map(|y| {
            let (a, b) = (y.saturating_sub(r), (y + r + 1).min(h));
            energy[a..b].iter().sum::<f32>() / (b - a) as f32
        })
        .collect();

    let mut sorted = smooth.clone();
    sorted.sort_by(f32::total_cmp);
    let floor = sorted[h / 5];
    let peak = sorted[h - 1];
    // Nothing stands out — a blank band, or one that is texture from edge to edge.
    if peak < floor * 1.6 + 2.0 {
        return None;
    }
    let cut = floor + 0.35 * (peak - floor);

    // Runs of rows above the cut, as (start, end-exclusive).
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut start = None;
    for (y, v) in smooth.iter().enumerate() {
        match (start, *v > cut) {
            (None, true) => start = Some(y),
            (Some(s), false) => {
                runs.push((s, y));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        runs.push((s, h));
    }

    // Bridge the gaps that are part of one line — or, for a block, of one block.
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for run in runs {
        if let Some(last) = merged.last_mut() {
            let gap = run.0 - last.1;
            let tall = (last.1 - last.0).max(run.1 - run.0);
            let bridge = if block { tall * 4 / 5 } else { (tall / 4).max(2) };
            if gap <= bridge {
                last.1 = run.1;
                continue;
            }
        }
        merged.push(run);
    }
    let mass = |(a, b): (usize, usize)| smooth[a..b].iter().map(|v| v - floor).sum::<f32>();
    let (a, b) = merged.into_iter().max_by(|x, y| mass(*x).total_cmp(&mass(*y)))?;

    // Too thin to be text at the size a band is drawn at.
    if b - a < 6 {
        return None;
    }
    // Room for what the projection underweights: the tops of capitals and the tails below the
    // line carry few vertical strokes, and a recogniser handed a line cut through them misreads.
    // Half the run each side: at 0.3 the dumped title crops cut the capitals' serifs off.
    let pad = ((b - a) as f32 * 0.5).round().max(3.0) as usize;
    let (a, b) = (a.saturating_sub(pad), (b + pad).min(h));
    if (b - a) as f32 >= h as f32 * 0.92 {
        return None;
    }
    Some((a as u32, b as u32))
}

/// `band` cut to the rows `text_rows` found, full width.
fn crop_rows(band: &RgbImage, (a, b): (u32, u32)) -> RgbImage {
    image::imageops::crop_imm(band, 0, a, band.width(), b - a).to_image()
}

/// Which of the band refinements a reader applies.
///
/// **Switches rather than constants because each one is kept or dropped on a measurement**,
/// and `read_eval` has to be able to run the old path and the new one on the same crops in one
/// process. The defaults are what that measurement chose — see the table in
/// `docs/reference/card-scanner.md` §4.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadOptions {
    /// Cut the title band down to its text line before reading. See [`text_rows`].
    pub title_line: bool,
    /// Find the collector block inside [`COLLECTOR_REGION`] and read that first, before the
    /// fixed crops.
    ///
    /// **Off by default, on a measurement.** It finds the block — the dumped crops show both
    /// lines — and still resolved fewer printings than the fixed band on `read_eval` (17.9%
    /// against 20.7% of 2015-on reads, 2026-09-30). Kept for a real-camera set to decide.
    pub collector_layout: bool,
}

impl Default for ReadOptions {
    fn default() -> Self {
        ReadOptions { title_line: true, collector_layout: false }
    }
}

/// The title band as a reader with `opts` reads it.
pub fn title_crop(src: &BandSource<'_>, rotated: bool, opts: ReadOptions) -> RgbImage {
    let band = src.band(TITLE_BAND, 2, rotated);
    match opts.title_line.then(|| text_rows(&band, false)).flatten() {
        Some(rows) => crop_rows(&band, rows),
        None => band,
    }
}

/// The first collector crop a reader with `opts` reads: the block found in the collector corner,
/// or the fixed band when there is none to find.
pub fn collector_crop(src: &BandSource<'_>, rotated: bool, opts: ReadOptions) -> RgbImage {
    if opts.collector_layout {
        let region = src.band(COLLECTOR_REGION, 4, rotated);
        if let Some(rows) = text_rows(&region, true) {
            return crop_rows(&region, rows);
        }
    }
    src.band(COLLECTOR_BAND, 4, rotated)
}


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
    for w in raw.split(|c: char| !c.is_ascii_alphanumeric()) {
        // **Split where the character class changes.** The separators on the card — a space,
        // a bullet, a brush glyph — are exactly what OCR drops, so `C 0035` comes back as
        // `C0035` and `HOB * EN` as `HOBEN`. Measured over the corpus this was the dominant
        // failure by a distance: most reads had the digits present and legible and produced
        // *zero* pairings, because no token began with one.
        let mut cur = String::new();
        for ch in w.chars() {
            if !cur.is_empty()
                && cur.chars().last().is_some_and(|p| p.is_ascii_digit()) != ch.is_ascii_digit()
            {
                words.push(std::mem::take(&mut cur));
            }
            cur.push(ch);
        }
        if !cur.is_empty() {
            words.push(cur);
        }
    }

    // **A collector number is printed zero-padded, and that is a usable filter.** Every
    // number this read correctly over the corpus came back four digits — `0001`, `0232`,
    // `0193`. A one- or two-digit token is a fragment of something else: measured, a garbage
    // read of `... D 6 T K A ...` produced a confident `LTR 6` against a true `LTR 590`.
    let digits = |t: &str| !t.is_empty() && t.chars().all(|c| c.is_ascii_digit());
    // **A number straight after another number is the set's total** — the 2015–2022 frames
    // print `226/259`, and the slash is a separator OCR drops. It is never a collector number:
    // GRN 259 is a real card, so offering it would be a confident wrong printing.
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
        //
        // **One exception, and it is a layout rather than a loosening.** The 2015–2022 frames
        // print `226/259 U` over `GRN • EN`, so the set sits past the total and a one-letter
        // rarity — measured on `read_eval`'s detail crops (2026-09-30), those lines came back
        // legible and paired with nothing. The reach extends to that one slot and only when a
        // total follows the number, so it can land on the set, the language or nothing, and
        // never on the artist after them.
        let past_total = words.get(ni + 1).filter(|t| digits(t)).map(|_| {
            let rarity = words
                .get(ni + 2)
                .is_some_and(|t| t.len() == 1 && t.chars().all(|c| c.is_ascii_alphabetic()));
            if rarity {
                ni + 3
            } else {
                ni + 2
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

#[cfg(feature = "ocr")]
mod engine {
    use super::*;
    use ocrs::{ImageSource, OcrEngine, OcrEngineParams};
    use std::path::Path;

    /// A loaded OCR engine. Construction reads ~12 MB of model, so build one and keep it.
    pub struct TitleReader {
        engine: OcrEngine,
        options: ReadOptions,
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
            let (d, r) = (read("detection", detection)?, read("recognition", recognition)?);
            TitleReader::from_bytes(&d, &r).map_err(|e| {
                format!("{e} ({} and {})", detection.display(), recognition.display())
            })
        }

        /// The same, from the two model files' bytes — an embedded copy, say.
        ///
        /// `rten::Model::load` takes an owned buffer, so this copies each model once (~12 MB
        /// together, once per session). `load_static_slice` would avoid it and would tie the
        /// signature to `'static`, which a caller holding a file it just read cannot give.
        pub fn from_bytes(
            detection: &[u8],
            recognition: &[u8],
        ) -> anyhow_lite::Result<TitleReader> {
            let detection_model = rten::Model::load(detection.to_vec())
                .map_err(|e| format!("detection model: {e}"))?;
            let recognition_model = rten::Model::load(recognition.to_vec())
                .map_err(|e| format!("recognition model: {e}"))?;
            let engine = OcrEngine::new(OcrEngineParams {
                detection_model: Some(detection_model),
                recognition_model: Some(recognition_model),
                ..Default::default()
            })
            .map_err(|e| format!("ocr engine: {e}"))?;
            Ok(TitleReader { engine, options: ReadOptions::default() })
        }

        /// Which band refinements the reads apply. See [`ReadOptions`].
        pub fn set_options(&mut self, options: ReadOptions) {
            self.options = options;
        }

        pub fn options(&self) -> ReadOptions {
            self.options
        }

        fn read_band(&self, band: &RgbImage) -> Option<String> {
            let src =
                ImageSource::from_bytes(band.as_raw(), (band.width(), band.height())).ok()?;
            let input = self.engine.prepare_input(src).ok()?;
            self.engine.get_text(&input).ok()
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
            let (ba, bb) = (title_crop(src, false, self.options), title_crop(src, true, self.options));
            let a = self.read_band(&ba).unwrap_or_default();
            let b = self.read_band(&bb).unwrap_or_default();

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
            let band_a = title_crop(src, flipped_first, self.options);
            let a = self.read_band(&band_a).unwrap_or_default();
            let a_edits = edits(&normalize(&a));
            if a_edits == Some(0) {
                return title_read(band_a, a, flipped_first, started);
            }
            let band_b = title_crop(src, !flipped_first, self.options);
            let b = self.read_band(&band_b).unwrap_or_default();
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
        pub fn read_collector_first(&self, src: &BandSource<'_>, flipped_first: bool) -> CollectorRead {
            let started = std::time::Instant::now();
            // **The first crop settles which way up, and the fallbacks only ever try that
            // one.** Both orientations of every crop is six reads at ~130 ms each, and the
            // cost lands exactly the wrong way round: a card that reads resolves on the first
            // attempt, while a card that cannot be read pays for all six. Deciding the
            // orientation once takes the worst case from 785 ms to roughly half that.
            let mut shown = collector_crop(src, flipped_first, self.options);
            let up = self.read_band(&shown).unwrap_or_default();
            let mut candidates = collector_candidates(&up);
            let mut raw = up;
            let mut from_second = false;

            if candidates.is_empty() {
                let flip = collector_crop(src, !flipped_first, self.options);
                let down = self.read_band(&flip).unwrap_or_default();
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
                    let text = self.read_band(&crop).unwrap_or_default();
                    let found = collector_candidates(&text);
                    if !found.is_empty() {
                        candidates = found;
                        raw = text;
                        shown = crop;
                        break;
                    }
                }
            }

            CollectorRead {
                raw: raw.split_whitespace().collect::<Vec<_>>().join(" "),
                candidates,
                band: Some(shown),
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
        assert!(c.is_empty(), "a one-digit fragment was taken as a collector number: {c:?}");
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
        ] {
            let c = collector_candidates(raw);
            assert!(c.contains(&(set.into(), number.into())), "{raw}: got {c:?}");
        }
    }

    #[test]
    fn the_total_is_never_offered_as_a_collector_number() {
        // `226/259`: GRN 259 is a real card, so offering the set's total as a number is a
        // confident wrong printing — the failure the adjacency rule exists to prevent.
        let c = collector_candidates("226/259 U GRNEN OMITRY");
        assert!(!c.iter().any(|(_, n)| n == "259"), "the total was offered: {c:?}");
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
    fn a_whole_token_outranks_a_prefix_of_one() {
        // Prefixes exist to recover a glued field, so they are a guess; a token that stands
        // on its own is not. The caller takes the first pairing that resolves, so the order
        // here is the difference between a right answer and a plausible one.
        let c = collector_candidates("0232 LTR");
        let whole = c.iter().position(|(s, _)| s == "ltr");
        let prefix = c.iter().position(|(s, _)| s == "lt");
        assert!(whole < prefix, "a prefix was offered before the whole token: {c:?}");
    }

    #[test]
    fn normalize_strips_what_ocr_gets_wrong() {
        // Apostrophes, commas and hyphens are exactly the characters OCR renders
        // inconsistently, so both sides of the comparison lose them.
        assert_eq!(normalize("Strider, Ranger of the North"), "strider ranger of the north");
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
        assert!(!mk("12 34").is_usable(), "digits alone are a collector line, not a name");
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
        assert!(band.height() < card.height(), "the band is a band, not the card");
    }

    #[test]
    fn a_tiny_image_does_not_panic() {
        let band = title_band(&RgbImage::new(4, 4));
        assert!(band.width() >= 1 && band.height() >= 1);
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

    /// A band with a hard horizontal rule near the top — a frame edge — and a row of vertical
    /// strokes lower down, which is what a line of type is to a gradient.
    fn band_with_a_line(w: u32, h: u32, rule: u32, text: (u32, u32)) -> RgbImage {
        RgbImage::from_fn(w, h, |x, y| {
            let v = if y < rule {
                30 // the frame above the rule
            } else if (text.0..text.1).contains(&y) && (x / 3) % 2 == 0 {
                20 // a stroke
            } else {
                220
            };
            image::Rgb([v, v, v])
        })
    }

    #[test]
    fn the_text_line_is_found_and_the_frame_edge_is_not() {
        let band = band_with_a_line(400, 120, 18, (60, 84));
        let (a, b) = text_rows(&band, false).expect("a line");
        assert!(a <= 60 && b >= 84, "the line was cut: {a}..{b}");
        assert!(a > 18, "the frame's rule was taken for text: {a}..{b}");
        assert!(b - a < 60, "the crop kept most of the band: {a}..{b}");
    }

    #[test]
    fn a_block_keeps_both_collector_lines_where_a_line_keeps_one() {
        // `U 0232` over `LTR • EN`: two lines with a gap under a line's height between them.
        let band = RgbImage::from_fn(400, 160, |x, y| {
            let text = (40..60).contains(&y) || (70..90).contains(&y);
            let v = if text && (x / 3) % 2 == 0 { 230 } else { 15 };
            image::Rgb([v, v, v])
        });
        let (a, b) = text_rows(&band, true).expect("a block");
        assert!(a <= 40 && b >= 90, "the block lost a line: {a}..{b}");
        let (a, b) = text_rows(&band, false).expect("a line");
        assert!(b <= 75 || a >= 55, "a single line spanned both: {a}..{b}");
    }

    #[test]
    fn a_blank_band_or_a_band_of_texture_is_read_whole() {
        assert_eq!(text_rows(&RgbImage::from_pixel(300, 80, image::Rgb([200, 200, 200])), false), None);
        let noise = RgbImage::from_fn(300, 80, |x, y| {
            let v = ((x * 7919 + y * 104_729) % 251) as u8;
            image::Rgb([v, v, v])
        });
        assert_eq!(text_rows(&noise, false), None, "texture from edge to edge is not a line");
        assert_eq!(text_rows(&RgbImage::new(4, 4), false), None);
    }

    #[test]
    fn with_the_refinements_off_the_crops_are_the_old_bands() {
        // `ReadOptions` off must be exactly the path before it existed, or `read_eval`'s baseline
        // row measures something no build ever shipped.
        let card = patterned_card();
        let flipped = image::imageops::rotate180(&card);
        let src = BandSource::Rectified { upright: &card, flipped: &flipped };
        let off = ReadOptions { title_line: false, collector_layout: false };
        assert_eq!(title_crop(&src, false, off), title_band(&card));
        assert_eq!(collector_crop(&src, true, off), collector_band(&flipped));
    }
}
