//! Foil or not, from the collector line's separator: `LTR ★ EN` on a foil, `LTR • EN` on a
//! non-foil — measured on a picture of the card's collector band, never read.
//!
//! **Ported from the OCR reader the Fast and Exact modes had** (`ocr::finish_mark`, removed with
//! them on 2026-10-24), without the recogniser and without `imageproc`: the line finder is a
//! projection, and the three pieces of image arithmetic the mark needs — an Otsu level, connected
//! components and a convex hull — are a few lines each here.
//!
//! **Only from a full-resolution frame.** In the ~960 px frame the recogniser reads, a card is
//! about 300 px tall and the separator three or four pixels: measured on the 124 readers' scans
//! (2026-10-22), the mark warped from those frames read 1 of 15 foils and called 6 non-foils foil.
//! So the session cuts the band from the full frame a page sends when asked
//! ([`crate::session::Session::frame_with_full`]), through the corners found in the small one.

use image::RgbImage;

/// The collector corner as a fraction of the card, left, top, right, bottom: the rarity and number
/// over the set code, separator and language. The box the Fast and Exact readers cut.
pub const COLLECTOR_BAND: [f32; 4] = [0.018, 0.918, 0.285, 0.990];

/// The band's size: four times its size on a 488×680 card, as the readers upscaled it, so the
/// marks below were calibrated on bands this size.
pub const BAND_WIDTH: usize = 520;
pub const BAND_HEIGHT: usize = 192;

/// What the collector line's separator says about the finish. See [`finish_mark`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MarkReading {
    Foil,
    Nonfoil,
    /// No separator was found, or it measured between a dot and a star. The page files the row
    /// as Unknown for the reader to decide rather than guess.
    Unknown,
}

/// The separator between the set code and the language, measured. See [`finish_mark`].
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct FinishMark {
    pub reading: MarkReading,
    /// The mark's height over the line's letter height. `None` when no mark was found.
    pub height: Option<f32>,
    /// The mark's area over the letter height squared.
    pub area: Option<f32>,
    /// The mark's area over its convex hull's — near 1 for a dot, lower for a star's points.
    pub solidity: Option<f32>,
}

/// The collector band of the card at `quad` in `frame` (the card's own corners, top left first),
/// [`BAND_WIDTH`]×[`BAND_HEIGHT`]. `None` for a quad that admits no homography.
pub fn collector_band(frame: &card_neural::Frame, quad: &card_neural::frame::Quad) -> Option<RgbImage> {
    let mut tensor = vec![0f32; 3 * BAND_WIDTH * BAND_HEIGHT];
    let mut view = Vec::new();
    card_neural::frame::sample_card(
        frame,
        quad,
        COLLECTOR_BAND,
        BAND_WIDTH,
        BAND_HEIGHT,
        &mut tensor,
        Some(&mut view),
    )
    .then_some(())?;
    RgbImage::from_raw(BAND_WIDTH as u32, BAND_HEIGHT as u32, view)
}

/// A separator this tall, over the letter height, and at least this large, is a star.
///
/// **A first calibration, from twelve crops, and not a measurement of the population.** A live
/// pass on 2026-10-01 (OnePlus 12 as a 1280×720 virtual camera, LTR and HOB cards) measured seven
/// non-foil dots at height 0.41–0.62 and area 0.12–0.17 of the letter height, and five foil stars
/// at 0.80–0.84 and 0.33–0.44 — no overlap on either axis. The cuts sit in the gaps, and a mark
/// between them is [`MarkReading::Unknown`].
const STAR_HEIGHT: f32 = 0.72;
const STAR_AREA: f32 = 0.26;
/// And no star is this large: a mark over it is a smear, not a separator. Measured on a Lenovo 500
/// crop whose band was cut off at the bottom (2026-09-30), the "separator" was 1.34 letter heights
/// squared and would otherwise have read as a star; the stars above top out at 0.44.
const STAR_AREA_MAX: f32 = 0.6;
/// A separator no taller and no larger than these is a dot.
const DOT_HEIGHT: f32 = 0.68;
const DOT_AREA: f32 = 0.22;
/// And at least this large: a smaller speck is a mark that mostly did not survive the binarization,
/// which a star under glare can leave as well as a dot. The dots above measured 0.10 and up; a
/// Lenovo 500 crop of a non-foil left 0.01.
const DOT_AREA_MIN: f32 = 0.06;
/// A star's area over its hull is at most this. **Shape is the weaker vote at webcam
/// resolution**: the star is six or seven camera pixels across and its points smear, so on the
/// same twelve crops it measured 0.91–0.99 against the dot's 1.04–1.12 — separated, but partly by
/// how a small blob's pixel count compares to its hull. It confirms a star; it never makes one.
const STAR_SOLIDITY: f32 = 1.02;

/// Does the separator on a collector band's second line read as a foil's ★ or a non-foil's •?
///
/// `set_len` is the decided printing's set code length: the line is `LTR • EN …`, so the
/// separator is the first mark after that many letters. The second line is the lower of the
/// band's two strongest ([`text_lines`]); the marks are the connected components of the line
/// binarized at its Otsu level, light on dark or dark on light, whichever is the minority; and only
/// marks centred on the line's own rows count, since the padded line box catches slivers of the
/// line above.
pub fn finish_mark(band: &RgbImage, set_len: usize) -> FinishMark {
    let unknown = FinishMark { reading: MarkReading::Unknown, height: None, area: None, solidity: None };
    let mut lines = text_lines(band);
    if lines.len() < 2 || set_len == 0 {
        return unknown;
    }
    lines.sort_by(|a, b| b.strength.total_cmp(&a.strength));
    lines.truncate(2);
    let line = *lines.iter().max_by_key(|l| l.top).expect("two lines");
    let (w, h) = (line.right - line.left, line.bottom - line.top);
    if w < 8 || h < 8 {
        return unknown;
    }
    let gray = image::imageops::grayscale(band);
    let crop = image::imageops::crop_imm(&gray, line.left, line.top, w, h).to_image();
    let level = otsu_level(crop.as_raw());
    let lit = crop.as_raw().iter().filter(|&&p| p > level).count();
    let light_text = lit * 2 < (w * h) as usize;
    let on: Vec<bool> = crop.as_raw().iter().map(|&p| (p > level) == light_text).collect();

    // The line box is padded half a line above and three tenths below (`LINE_PAD_*`), so the
    // line's own rows are its middle 1/1.8.
    let tall = h as f32 / (1.0 + LINE_PAD_ABOVE + LINE_PAD_BELOW);
    let (core_top, core_bottom) = (LINE_PAD_ABOVE * tall, (1.0 + LINE_PAD_ABOVE) * tall);
    let mut marks: Vec<Mark> = components(&on, w as usize, h as usize)
        .into_iter()
        .filter(|m| m.pixels.len() >= 6)
        .filter(|m| {
            let cy = (m.top + m.bottom) as f32 / 2.0;
            (core_top..=core_bottom).contains(&cy)
        })
        .collect();
    marks.sort_by_key(|m| m.left);

    // The letter height: the upper quartile of the substantial marks, which letters dominate.
    let mut heights: Vec<u32> = marks.iter().filter(|m| m.pixels.len() >= 40).map(Mark::height).collect();
    heights.sort_unstable();
    let Some(&cap) = heights.get(heights.len() * 3 / 4) else { return unknown };
    let cap = cap as f32;

    // Past the set code's letters; the next mark is the separator — unless it is letter-height,
    // which is the `E` of a line whose separator did not survive the binarization.
    let mut letters = 0;
    let mut after = None;
    for (i, m) in marks.iter().enumerate() {
        if m.height() as f32 >= 0.7 * cap {
            letters += 1;
            if letters == set_len {
                after = Some(i + 1);
                break;
            }
        }
    }
    let Some(sep) = after.and_then(|i| marks.get(i)) else { return unknown };
    let height = sep.height() as f32 / cap;
    if height >= 0.9 {
        return unknown;
    }
    let area = sep.pixels.len() as f32 / (cap * cap);
    let solidity = sep.solidity();
    let reading = if height >= STAR_HEIGHT
        && (STAR_AREA..=STAR_AREA_MAX).contains(&area)
        && solidity <= STAR_SOLIDITY
    {
        MarkReading::Foil
    } else if height <= DOT_HEIGHT && (DOT_AREA_MIN..=DOT_AREA).contains(&area) {
        MarkReading::Nonfoil
    } else {
        MarkReading::Unknown
    };
    FinishMark { reading, height: Some(height), area: Some(area), solidity: Some(solidity) }
}

/// What `marks` agree on: the reading more of them gave, foil or non-foil, and Unknown on a tie,
/// with the figures of the first mark that read it. `None` for no marks.
pub fn agreed(marks: &[FinishMark]) -> Option<FinishMark> {
    let first = *marks.first()?;
    let count = |r: MarkReading| marks.iter().filter(|m| m.reading == r).count();
    let reading = match count(MarkReading::Foil).cmp(&count(MarkReading::Nonfoil)) {
        std::cmp::Ordering::Greater => MarkReading::Foil,
        std::cmp::Ordering::Less => MarkReading::Nonfoil,
        std::cmp::Ordering::Equal => MarkReading::Unknown,
    };
    let found = marks.iter().find(|m| m.reading == reading).copied();
    Some(found.unwrap_or(FinishMark { reading, ..first }))
}

/// One line of text inside a band, in the band's own pixels, bottom and right exclusive.
#[derive(Debug, Clone, Copy, PartialEq)]
struct TextLine {
    top: u32,
    left: u32,
    bottom: u32,
    right: u32,
    /// How far this line's rows stand above the band's quiet floor, summed.
    strength: f32,
}

/// Where the text in a collector band is, top to bottom — found by a projection, not a model.
///
/// **A row projection of the horizontal gradient.** Letterforms are mostly vertical strokes, so a
/// row through text crosses dark-light-dark many times and its sum of `|∂I/∂x|` is high; the
/// frame's own edges are horizontal and barely move it. Rows above a cut between the band's quiet
/// floor and its peak are text; runs a small gap apart are one line. **Measured over the band's
/// left [`COLLECTOR_MEASURED`]**, where both lines are (`U 0232` over `LTR • EN`), and each line
/// is then cut to the columns that hold its text, with room either side.
fn text_lines(band: &RgbImage) -> Vec<TextLine> {
    let (w, h) = (band.width() as usize, band.height() as usize);
    if w < 16 || h < 8 {
        return Vec::new();
    }
    let gray = image::imageops::grayscale(band);
    let px = gray.as_raw();
    // A difference across a few pixels rather than one: a band is an upscale of a warp, so its
    // edges are soft, and a one-pixel difference across a soft edge is small everywhere.
    let step = (h / 40).max(1);
    if w <= step * 4 {
        return Vec::new();
    }
    let grad = |y: usize, x: usize| u32::from(px[y * w + x].abs_diff(px[y * w + x + step]));

    let span = ((w as f32 * COLLECTOR_MEASURED) as usize).clamp(1, w - step);
    let rows: Vec<f32> = (0..h)
        .map(|y| (0..span).map(|x| grad(y, x)).sum::<u32>() as f32 / span as f32)
        .collect();
    // A little smoothing, so one noisy row can neither split a line nor make one.
    let rows = smoothed(&rows, (h / 60).max(1));
    let (floor, peak) = (quantile(&rows, 0.2), quantile(&rows, 1.0));
    // Nothing stands out — a blank band, or one that is texture from edge to edge.
    if peak < floor * 1.6 + 0.5 {
        return Vec::new();
    }
    // One line's own gaps — the rows between an ascender and the x-height — are bridged; the
    // gap between two lines is wider than a quarter of either, and is not.
    let lines = runs(&rows, floor + LINE_CUT * (peak - floor), |tall| (tall / 4).max(1));

    let min_height = (h / 12).max(3);
    lines
        .into_iter()
        .filter(|(a, b)| b - a >= min_height)
        .filter_map(|(a, b)| {
            let tall = b - a;
            let strength = rows[a..b].iter().map(|v| v - floor).sum::<f32>();
            // Room for what the projection underweights: the tops of capitals and the tails below.
            let above = ((tall as f32 * LINE_PAD_ABOVE).round() as usize).max(2);
            let below = ((tall as f32 * LINE_PAD_BELOW).round() as usize).max(2);
            let (top, bottom) = (a.saturating_sub(above), (b + below).min(h));
            let (left, right) = text_columns(&grad, w - step, top..bottom, tall)?;
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

/// The columns of one line that hold its text, as `(left, right)`: clusters of busy columns,
/// grown outward from the strongest, with a thin cluster at either side of the band — the frame's
/// vertical edge, not a letter — dropped.
fn text_columns(
    grad: &impl Fn(usize, usize) -> u32,
    w: usize,
    rows: std::ops::Range<usize>,
    tall: usize,
) -> Option<(usize, usize)> {
    let cols: Vec<f32> = (0..w).map(|x| rows.clone().map(|y| grad(y, x)).sum::<u32>() as f32).collect();
    let cols = smoothed(&cols, (tall / 8).max(1));
    let (floor, peak) = (quantile(&cols, 0.2), quantile(&cols, 0.95));
    let word_gap = (tall * 3 / 5).max(2);
    let clusters = runs(&cols, floor + COLUMN_CUT * (peak - floor), |_| 0);
    let thin = (tall * 3 / 5).max(2);
    let edge = |i: usize| {
        let (a, b) = clusters[i];
        let (first, last) = (i == 0, i + 1 == clusters.len());
        let before = if first { usize::MAX } else { a - clusters[i - 1].1 };
        let after = if last { usize::MAX } else { clusters[i + 1].0 - b };
        let at_side = (first && a <= tall) || (last && b + tall >= w);
        at_side && b - a < thin && before > word_gap && after > word_gap
    };
    let kept: Vec<(usize, usize)> =
        (0..clusters.len()).filter(|&i| clusters.len() == 1 || !edge(i)).map(|i| clusters[i]).collect();
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

/// Runs of `values` above `cut`, as `(start, end)` with the end exclusive, where two runs closer
/// than `bridge(taller of the two)` are one.
fn runs(values: &[f32], cut: f32, bridge: impl Fn(usize) -> usize) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut start = None;
    for (i, v) in values.iter().chain(std::iter::once(&f32::NEG_INFINITY)).enumerate() {
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

/// Where between a line's quiet floor and its peak a column counts as text — low, because the
/// peak is often the frame edge rather than a letter.
const COLUMN_CUT: f32 = 0.12;
/// Where between the band's quiet floor and its peak a row counts as text.
const LINE_CUT: f32 = 0.35;
/// The share of the band's width, from the left, whose strokes decide where its lines are: the
/// whole width drowned the line that carries the number (`U 0026` fills the left third, while
/// `LTR • EN` runs on into the artist credit).
const COLLECTOR_MEASURED: f32 = 0.6;
/// Rows added above a line, as a fraction of its height: capitals rise further above the
/// x-height the projection finds than descenders fall below it.
const LINE_PAD_ABOVE: f32 = 0.5;
/// Rows added below a line.
const LINE_PAD_BELOW: f32 = 0.3;
/// Columns added either side of a line.
const LINE_PAD_SIDE: f32 = 0.6;

/// The level that best splits `pixels` into two classes (Otsu's): the one that maximises the
/// variance between them.
fn otsu_level(pixels: &[u8]) -> u8 {
    let mut hist = [0u64; 256];
    for &p in pixels {
        hist[usize::from(p)] += 1;
    }
    let total = pixels.len() as f64;
    let sum: f64 = hist.iter().enumerate().map(|(i, &c)| i as f64 * c as f64).sum();
    let (mut below, mut below_sum, mut best, mut level) = (0.0, 0.0, -1.0, 0u8);
    for (t, &c) in hist.iter().enumerate() {
        below += c as f64;
        below_sum += t as f64 * c as f64;
        let above = total - below;
        if below == 0.0 || above == 0.0 {
            continue;
        }
        let (m0, m1) = (below_sum / below, (sum - below_sum) / above);
        let between = below * above * (m0 - m1) * (m0 - m1);
        if between > best {
            best = between;
            level = t as u8;
        }
    }
    level
}

/// The 8-connected components of the `on` pixels of a `w`×`h` mask.
fn components(on: &[bool], w: usize, h: usize) -> Vec<Mark> {
    let mut seen = vec![false; on.len()];
    let mut out = Vec::new();
    let mut stack = Vec::new();
    for start in 0..on.len() {
        if !on[start] || seen[start] {
            continue;
        }
        seen[start] = true;
        stack.push(start);
        let mut mark = Mark::at((start % w) as u32, (start / w) as u32);
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            mark.add(x as u32, y as u32);
            for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                    if (dx, dy) == (0, 0) || nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                        continue;
                    }
                    let j = ny as usize * w + nx as usize;
                    if on[j] && !seen[j] {
                        seen[j] = true;
                        stack.push(j);
                    }
                }
            }
        }
        out.push(mark);
    }
    out
}

/// One connected mark on a line: its box and its pixels.
struct Mark {
    left: u32,
    top: u32,
    right: u32,
    bottom: u32,
    pixels: Vec<(i64, i64)>,
}

impl Mark {
    fn at(x: u32, y: u32) -> Mark {
        Mark { left: x, top: y, right: x, bottom: y, pixels: Vec::new() }
    }

    fn add(&mut self, x: u32, y: u32) {
        self.left = self.left.min(x);
        self.top = self.top.min(y);
        self.right = self.right.max(x);
        self.bottom = self.bottom.max(y);
        self.pixels.push((i64::from(x), i64::from(y)));
    }

    fn height(&self) -> u32 {
        self.bottom - self.top + 1
    }

    /// Pixel count over the convex hull's area. A small blob's count can exceed its hull, whose
    /// corners run through pixel centres, so a dot reads a little over 1.
    fn solidity(&self) -> f32 {
        let hull = convex_hull(&self.pixels);
        let twice: i64 = (0..hull.len())
            .map(|i| {
                let (p, q) = (hull[i], hull[(i + 1) % hull.len()]);
                p.0 * q.1 - q.0 * p.1
            })
            .sum();
        self.pixels.len() as f32 / (twice.abs() as f32 / 2.0).max(1.0)
    }
}

/// The convex hull of `points`, counter-clockwise (Andrew's monotone chain).
fn convex_hull(points: &[(i64, i64)]) -> Vec<(i64, i64)> {
    let mut p = points.to_vec();
    p.sort_unstable();
    p.dedup();
    if p.len() < 3 {
        return p;
    }
    let cross = |o: (i64, i64), a: (i64, i64), b: (i64, i64)| (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0);
    let mut hull: Vec<(i64, i64)> = Vec::with_capacity(2 * p.len());
    for pass in [p.clone(), p.into_iter().rev().collect()] {
        let start = hull.len();
        for q in pass {
            while hull.len() >= start + 2 && cross(hull[hull.len() - 2], hull[hull.len() - 1], q) <= 0 {
                hull.pop();
            }
            hull.push(q);
        }
        hull.pop();
    }
    hull
}

/// Synthetic collector bands for the finish mark's tests — here rather than in `tests` so the
/// session's tests can build one too.
#[cfg(test)]
pub(crate) mod test_bands {
    use image::{Rgb, RgbImage};

    /// What sits between the set code and `EN`.
    #[derive(Clone, Copy)]
    pub(crate) enum Separator {
        Star,
        Dot,
        /// A mark far larger than any star: a smear.
        Blob,
        None,
    }

    const PAPER: Rgb<u8> = Rgb([24, 22, 20]);
    const INK: Rgb<u8> = Rgb([225, 222, 214]);

    fn rect(band: &mut RgbImage, x: u32, y: u32, w: u32, h: u32, c: Rgb<u8>) {
        for yy in y..y + h {
            for xx in x..x + w {
                band.put_pixel(xx, yy, c);
            }
        }
    }

    /// Every pixel whose centre `inside` says is in the shape, around (`x`, `y`) out to `r`.
    fn shape(band: &mut RgbImage, (x, y): (i32, i32), r: i32, inside: impl Fn(f32, f32) -> bool) {
        for yy in y - r..=y + r {
            for xx in x - r..=x + r {
                if inside((xx - x) as f32, (yy - y) as f32) {
                    band.put_pixel(xx as u32, yy as u32, INK);
                }
            }
        }
    }

    /// Is (`px`, `py`) inside the five-pointed star of outer radius `r` centred on the origin?
    fn in_star(px: f32, py: f32, r: f32) -> bool {
        let pts: Vec<(f32, f32)> = (0..10)
            .map(|i| {
                let rr = if i % 2 == 0 { r } else { r * 8.0 / 15.0 };
                let a = std::f32::consts::PI * (i as f32 / 5.0 - 0.5);
                (rr * a.cos(), rr * a.sin())
            })
            .collect();
        // Even-odd ray casting.
        let mut inside = false;
        for i in 0..pts.len() {
            let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
            if (a.1 > py) != (b.1 > py) && px < (b.0 - a.0) * (py - a.1) / (b.1 - a.1) + a.0 {
                inside = !inside;
            }
        }
        inside
    }

    /// A collector band as a 4× upscale sees one: light marks on the black frame, `U 0014` over
    /// `LTR <separator> EN` and an artist, the letters 24×34 — the size the live crops measured.
    pub(crate) fn collector_band(separator: Separator) -> RgbImage {
        let mut band = RgbImage::from_pixel(520, 192, PAPER);
        // A letter with a counter, so it has vertical strokes for the line finder.
        let letter = |band: &mut RgbImage, x: u32, y: u32| {
            rect(band, x, y, 24, 34, INK);
            rect(band, x + 7, y + 7, 10, 20, PAPER);
        };
        for x in [30, 70, 100, 130, 160] {
            letter(&mut band, x, 36); // U 0014
        }
        for x in [30, 57, 86] {
            letter(&mut band, x, 100); // LTR
        }
        let at = (150, 117);
        match separator {
            Separator::Star => shape(&mut band, at, 15, |dx, dy| in_star(dx, dy, 15.0)),
            Separator::Dot => shape(&mut band, at, 6, |dx, dy| dx * dx + dy * dy <= 36.0),
            Separator::Blob => shape(&mut band, at, 22, |dx, dy| dx * dx + dy * dy <= 484.0),
            Separator::None => {}
        }
        for x in [181, 213, 272, 304, 336, 368, 400, 432, 464] {
            letter(&mut band, x, 100); // EN, the artist
        }
        band
    }
}

#[cfg(test)]
mod tests {
    use super::test_bands::{self, Separator};
    use super::*;

    #[test]
    fn the_separator_is_measured_as_a_star_a_dot_or_nothing_known() {
        let read = |sep| finish_mark(&test_bands::collector_band(sep), 3);
        let m = read(Separator::Star);
        assert_eq!(m.reading, MarkReading::Foil, "a star: {m:?}");
        let m = read(Separator::Dot);
        assert_eq!(m.reading, MarkReading::Nonfoil, "a dot: {m:?}");
        // No separator at all: the next mark is the `E`, letter-height, so nothing is known.
        assert_eq!(read(Separator::None).reading, MarkReading::Unknown);
        // A blob larger than any star is a smear, not a separator.
        assert_eq!(read(Separator::Blob).reading, MarkReading::Unknown);
        // And a band with no two lines says nothing either.
        let blank = RgbImage::from_pixel(520, 192, image::Rgb([24, 22, 20]));
        assert_eq!(finish_mark(&blank, 3).reading, MarkReading::Unknown);
    }

    #[test]
    fn marks_agree_by_majority_and_a_tie_is_unknown() {
        let m = |reading| FinishMark { reading, height: Some(0.5), area: Some(0.1), solidity: Some(1.0) };
        let (foil, dot, unknown) = (m(MarkReading::Foil), m(MarkReading::Nonfoil), m(MarkReading::Unknown));
        assert_eq!(agreed(&[]), None);
        assert_eq!(agreed(&[foil, unknown, foil, dot]).map(|m| m.reading), Some(MarkReading::Foil));
        assert_eq!(agreed(&[dot, foil]).map(|m| m.reading), Some(MarkReading::Unknown));
        assert_eq!(agreed(&[unknown]).map(|m| m.reading), Some(MarkReading::Unknown));
    }

    #[test]
    fn the_image_arithmetic_matches_what_imageproc_gave() {
        // Otsu splits a two-level picture between its levels.
        let level = otsu_level(&[10, 10, 10, 200, 200]);
        assert!((10..200).contains(&level), "{level}");
        // Two blobs touching only at a corner are one 8-connected component.
        let on = [true, false, false, true, false, false, false, false, true];
        let found = components(&on, 3, 3);
        assert_eq!(found.iter().map(|m| m.pixels.len()).collect::<Vec<_>>(), [2, 1]);
        // A square's hull is its four corners, area 4 for a 3×3 block of pixels.
        let square: Vec<(i64, i64)> = (0..3).flat_map(|y| (0..3).map(move |x| (x, y))).collect();
        assert_eq!(convex_hull(&square).len(), 4);
    }

    #[test]
    fn the_band_is_cut_from_a_frame_through_the_cards_corners() {
        let frame = card_neural::Frame::new(640, 480, vec![90; 640 * 480 * 3]).unwrap();
        let p = |x, y| card_neural::frame::Point { x, y };
        let quad = [p(200.0, 100.0), p(440.0, 100.0), p(440.0, 436.0), p(200.0, 436.0)];
        let band = collector_band(&frame, &quad).expect("a band");
        assert_eq!(band.dimensions(), (BAND_WIDTH as u32, BAND_HEIGHT as u32));
        let flat = [p(0.0, 0.0); 4];
        assert!(collector_band(&frame, &flat).is_none(), "no homography, no band");
    }
}
