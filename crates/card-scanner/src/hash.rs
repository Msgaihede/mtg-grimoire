//! Perceptual descriptors, and the Hamming distance over them.
//!
//! **These are hand-written rather than taken from a crate, and that is a format decision
//! rather than a preference.** The bit layout produced here is published: it goes into
//! `card-hashes-v1.bin`, which lives on a GitHub release and is downloaded by every
//! installation. A dependency that changed its internal bit order in a patch release would
//! turn every bundle already in the wild into noise, silently — every lookup would still
//! *work*, and every answer would be wrong. Owning ~120 lines removes that failure mode
//! entirely. (`img_hash`, the crate this would otherwise have used, was last published
//! 2021-05-04; `image_hasher` is its maintained fork.)
//!
//! Two families, both implemented, because which one survives a photograph better is an
//! empirical question the sample corpus answers — the same reasoning that puts both Canny
//! and Otsu in [`crate::detect`]:
//!
//! * **dHash** compares adjacent pixels and keeps the sign. It is a *gradient*, so a global
//!   brightness or contrast shift moves every term equally and changes no bit. That makes it
//!   the more robust of the two against the thing a photograph always has — uneven exposure.
//! * **pHash** keeps the low-frequency DCT coefficients. Blur and sensor noise live in the
//!   high frequencies it discards, so it degrades more gracefully on a soft or noisy frame.
//!
//! Both of those are computed on **grayscale**, and that turned out to be the descriptor's
//! one real weakness — see [`HashKind::DHashChroma`], which fixes it.

use image::imageops::FilterType;
use image::GrayImage;

/// Which descriptor. The bundle records this so a reader can never compare hashes computed
/// two different ways — a comparison that would produce a confident, meaningless answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HashKind {
    /// Horizontal *and* vertical adjacent-pixel gradients, half the bits each.
    ///
    /// The vertical half is not padding. A horizontal-only dHash is blind to any structure
    /// that varies only down the card — which on a Magic card is the title bar, the type
    /// line, and the text box, i.e. most of the layout that distinguishes one frame era
    /// from another.
    DHash,
    /// Low-frequency DCT-II coefficients against their median.
    PHash,
    /// **192 bits of luminance gradient plus 64 bits of chroma.**
    ///
    /// Grayscale descriptors cannot tell basic lands apart, and that is not a tuning problem.
    /// Measured over the shipped bundle: arbitrary printings sit **101 bits** apart, the
    /// confidence threshold is 67, and basics within one set land at **44 to 73** — a HOB
    /// Plains and a HOB Forest are 44 bits apart, which is a *confident* match for the wrong
    /// card. Reported from the camera as a Mountain flipping to an Island.
    ///
    /// The reason is that nothing else about two basics differs. Same frame, same title bar,
    /// same type line, same text box, both landscape art with a horizon — and a red rock and a
    /// blue sea at similar brightness are identical to a luminance gradient. Colour is the
    /// only thing that separates them, and it separates them completely.
    ///
    /// The chroma half is encoded the same way the luminance half is: **each cell against the
    /// median of all cells**, never against an absolute colour. A warm lamp, a phone's white
    /// balance or a foil's sheen shifts every cell together and flips no bits, which is what
    /// makes colour usable here at all — it is the least reliable thing about a photograph
    /// until you stop asking what colour something is and start asking which parts are redder
    /// than the rest of the same card.
    DHashChroma,
    /// The same idea with **half the chroma**: 224 bits of luminance, 32 of colour.
    ///
    /// [`HashKind::DHashChroma`] fixed basic lands and broke foils. Measured on eight live
    /// frames of a foil showcase card under a lamp, grayscale found it on 3 and 64-bit chroma
    /// on 1 — the rainbow sheen corrupts the colour signal, and the 64 bits were paid for by
    /// cutting luminance from a 16x8 grid to 12x8, so it lost structure *and* gained a
    /// misleading signal on exactly the cards that need structure most.
    ///
    /// The tension is real rather than a tuning accident: a basic land is separated by
    /// *global* colour, and foil sheen is also global, so no encoding tells them apart. This
    /// variant is the compromise — enough colour to keep a Mountain away from an Island,
    /// little enough that a sheen cannot outvote the card's structure.
    DHashChroma32,
}

impl HashKind {
    pub fn as_str(self) -> &'static str {
        match self {
            HashKind::DHash => "dhash",
            HashKind::PHash => "phash",
            HashKind::DHashChroma => "dhash-chroma",
            HashKind::DHashChroma32 => "dhash-chroma32",
        }
    }
}

/// A descriptor. 128 or 256 bits, stored little-endian in `words`; unused words are zero.
///
/// `bits` is carried alongside because a 128-bit hash and a 256-bit hash whose high words
/// happen to be zero are not the same value, and comparing them would silently succeed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Descriptor {
    pub words: [u64; 4],
    pub bits: u16,
}

impl Descriptor {
    pub fn words_used(&self) -> usize {
        self.bits as usize / 64
    }

    /// Hamming distance, or `None` if the two are not comparable.
    ///
    /// Returning an `Option` rather than a number is the point: two descriptors of different
    /// widths have a perfectly computable distance that means nothing at all, and a silent
    /// wrong answer here would surface as "the scanner is inaccurate" rather than as a bug.
    pub fn distance(&self, other: &Descriptor) -> Option<u32> {
        if self.bits != other.bits {
            return None;
        }
        let mut d = 0;
        for i in 0..self.words_used() {
            d += (self.words[i] ^ other.words[i]).count_ones();
        }
        Some(d)
    }

    /// Distance as a fraction of the width, so a 128-bit and a 256-bit run are comparable
    /// when a *threshold* is being reasoned about (never when two hashes are).
    pub fn normalized_distance(&self, other: &Descriptor) -> Option<f32> {
        self.distance(other).map(|d| d as f32 / self.bits as f32)
    }

    pub fn to_bytes(self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.bits as usize / 8);
        for w in &self.words[..self.words_used()] {
            out.extend_from_slice(&w.to_le_bytes());
        }
        out
    }

    pub fn from_bytes(bytes: &[u8], bits: u16) -> Option<Descriptor> {
        if bytes.len() != bits as usize / 8 || !matches!(bits, 128 | 256) {
            return None;
        }
        let mut words = [0u64; 4];
        for (i, chunk) in bytes.chunks_exact(8).enumerate() {
            words[i] = u64::from_le_bytes(chunk.try_into().ok()?);
        }
        Some(Descriptor { words, bits })
    }

    pub fn to_hex(self) -> String {
        self.to_bytes().iter().map(|b| format!("{b:02x}")).collect()
    }
}

/// Bit `i` of the descriptor, set from a boolean run. Order is the published format.
struct BitWriter {
    words: [u64; 4],
    n: usize,
}

impl BitWriter {
    fn new() -> Self {
        BitWriter { words: [0; 4], n: 0 }
    }
    fn push(&mut self, bit: bool) {
        if bit {
            self.words[self.n / 64] |= 1u64 << (self.n % 64);
        }
        self.n += 1;
    }
    fn finish(self, bits: u16) -> Descriptor {
        debug_assert_eq!(self.n, bits as usize, "wrote {} bits, declared {bits}", self.n);
        Descriptor { words: self.words, bits }
    }
}

/// The grid a dHash of `bits` wide is built on: half the bits horizontal, half vertical.
///
/// 256 → two 16×8 gradient fields (a 17×8 and an 8×17 resample).
/// 128 → two 8×8 fields (a 9×8 and an 8×9 resample).
fn dhash_grid(bits: u16) -> (u32, u32) {
    match bits {
        256 => (16, 8),
        128 => (8, 8),
        _ => unreachable!("width validated by `hash`"),
    }
}

/// Compute a descriptor over a grayscale image.
///
/// `bits` must be 128 or 256; anything else is a programming error rather than a runtime
/// condition, and the bundle format only defines those two.
pub fn hash(img: &GrayImage, kind: HashKind, bits: u16) -> Descriptor {
    assert!(matches!(bits, 128 | 256), "unsupported hash width {bits}");
    match kind {
        HashKind::DHash => dhash(img, bits),
        HashKind::PHash => phash(img, bits),
        HashKind::DHashChroma | HashKind::DHashChroma32 => {
            unreachable!("the chroma kinds need colour; call `hash_rgb`")
        }
    }
}

/// Compute a descriptor that may use colour.
///
/// Separate from [`hash`] because the grayscale kinds cannot use an [`image::RgbImage`]'s
/// extra channels and the colour kind cannot work without them — making the caller pass the
/// right thing is better than silently dropping the colour on the floor.
pub fn hash_rgb(img: &image::RgbImage, kind: HashKind, bits: u16) -> Descriptor {
    assert!(matches!(bits, 128 | 256), "unsupported hash width {bits}");
    match kind {
        HashKind::DHashChroma => dhash_chroma(img, bits, 64),
        HashKind::DHashChroma32 => dhash_chroma(img, bits, 32),
        other => hash(&image::DynamicImage::ImageRgb8(img.clone()).to_luma8(), other, bits),
    }
}

/// How the bits of a [`HashKind::DHashChroma`] descriptor are divided.
///
/// Three quarters luminance, one quarter chroma. Luminance still carries the card's structure
/// and most of its art; chroma only has to answer "which parts of this card are redder or
/// bluer than the rest of it", and 64 bits is a generous budget for that.
fn chroma_split(bits: u16, chroma: u16) -> (u16, u16) {
    let chroma = if bits == 128 { chroma / 2 } else { chroma };
    (bits - chroma, chroma)
}

/// The grid a chroma field of `bits` is built on: two channels per cell.
fn chroma_grid(bits: u16) -> (u32, u32) {
    match bits {
        64 => (4, 8),
        32 => (4, 4),
        16 => (2, 4),
        _ => unreachable!("width from `chroma_split`"),
    }
}

/// The grid the luminance half of a chroma descriptor uses.
fn luma_grid(bits: u16) -> (u32, u32) {
    match bits {
        224 => (14, 8), // 112 horizontal + 112 vertical
        192 => (12, 8), // 96 + 96
        112 => (7, 8),  // 56 + 56
        96 => (6, 8),   // 48 + 48
        _ => unreachable!("width from `chroma_split`"),
    }
}

fn dhash_chroma(img: &image::RgbImage, bits: u16, chroma: u16) -> Descriptor {
    let (luma_bits, chroma_bits) = chroma_split(bits, chroma);
    let mut bw = BitWriter::new();

    // One box pre-scale feeds both halves: the luma conversion below is itself a pass over
    // every pixel, and doing it on a quarter-scale image is a quarter of the work.
    let img = &prescale_rgb(img);

    // ── Luminance, exactly as `dhash` does it, at a coarser grid ──────────────────
    let gray = image::DynamicImage::ImageRgb8(img.clone()).to_luma8();
    let (w, h) = luma_grid(luma_bits);
    let horiz = image::imageops::resize(&gray, w + 1, h, FilterType::Lanczos3);
    for y in 0..h {
        for x in 0..w {
            bw.push(horiz.get_pixel(x, y)[0] < horiz.get_pixel(x + 1, y)[0]);
        }
    }
    let vert = image::imageops::resize(&gray, h, w + 1, FilterType::Lanczos3);
    for y in 0..w {
        for x in 0..h {
            bw.push(vert.get_pixel(x, y)[0] < vert.get_pixel(x, y + 1)[0]);
        }
    }

    // ── Chroma ───────────────────────────────────────────────────────────────────
    let (cw, ch) = chroma_grid(chroma_bits);
    let small = image::imageops::resize(img, cw, ch, FilterType::Lanczos3);

    // Two opponent channels, each divided by the cell's own total intensity. Dividing is what
    // makes this a *chromaticity* rather than a colour: a cell in shadow and the same cell in
    // light give the same pair, so uneven lighting across a card does not register as a
    // different card.
    let mut rg = Vec::with_capacity((cw * ch) as usize);
    let mut by = Vec::with_capacity((cw * ch) as usize);
    for p in small.pixels() {
        let (r, g, b) = (p[0] as f32, p[1] as f32, p[2] as f32);
        let sum = (r + g + b).max(1.0);
        rg.push((r - g) / sum);
        by.push((b - (r + g) / 2.0) / sum);
    }

    // Each cell against the median of all cells — never against an absolute colour. A warm
    // lamp or a camera's white balance shifts every cell together and flips no bits.
    for channel in [&rg, &by] {
        let mut sorted = channel.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median = sorted[sorted.len() / 2];
        for v in channel.iter() {
            bw.push(*v > median);
        }
    }

    bw.finish(bits)
}

/// Working size every descriptor is built from, after a cheap box pre-scale.
///
/// **Lanczos3 straight from a 488x680 rectification to a 15x8 grid is the single most
/// expensive thing in the frame.** Its kernel support scales with the ratio, so a 30-to-80x
/// downscale reads the whole source several times over — measured at 5.4 ms per descriptor,
/// and the multi-framing search pays it six times a frame rather than twice: 32 ms of hashing
/// against 3.5 ms of actually searching 113,375 cards.
///
/// A box average to this size first cuts the pixels the expensive filter touches, and a box
/// average is the *right* first stage rather than merely a cheap one: it is an exact area
/// mean, so it cannot alias, which is the one thing a naive pre-scale would get wrong.
///
/// **Half the rectification, not a quarter, and the difference was measured.** 122x170 hashes
/// in 9.2 ms against 22 ms here and 32 ms with no pre-scale — but it is not free: over the
/// labelled corpus it took the mean distance from 42.1 to 46.0, because a box filter is a poor
/// lowpass and at a quarter scale it is doing enough of the reduction for that to show. At
/// 244x340 the box only removes detail far above anything a 15x8 grid can represent, and the
/// result is a wash against no pre-scale at all — better on 12 of 39 and worse on 12, with
/// accuracy unchanged — while still taking a third off the descriptor cost.
///
/// The saving matters because the multi-framing search pays it six times a frame rather than
/// twice: hashing, not searching 113,375 cards, is the expensive half of a match.
const WORK_W: u32 = 244;
const WORK_H: u32 = 340;

/// Box-average to the working size.
///
/// `thumbnail` rather than `resize(.., Triangle)`: it is an exact area mean and it is the
/// fast path in `image` for precisely this shape of reduction.
fn prescale_luma(img: &GrayImage) -> GrayImage {
    if img.width() <= WORK_W || img.height() <= WORK_H {
        return img.clone();
    }
    image::imageops::thumbnail(img, WORK_W, WORK_H)
}

fn prescale_rgb(img: &image::RgbImage) -> image::RgbImage {
    if img.width() <= WORK_W || img.height() <= WORK_H {
        return img.clone();
    }
    image::imageops::thumbnail(img, WORK_W, WORK_H)
}

fn dhash(img: &GrayImage, bits: u16) -> Descriptor {
    let (w, h) = dhash_grid(bits);
    let mut bw = BitWriter::new();
    let img = &prescale_luma(img);

    // Horizontal: (w+1) x h, compare each pixel with its right neighbour.
    let horiz = image::imageops::resize(img, w + 1, h, FilterType::Lanczos3);
    for y in 0..h {
        for x in 0..w {
            bw.push(horiz.get_pixel(x, y)[0] < horiz.get_pixel(x + 1, y)[0]);
        }
    }

    // Vertical: h x (w+1) transposed — compare each pixel with the one below it.
    let vert = image::imageops::resize(img, h, w + 1, FilterType::Lanczos3);
    for y in 0..w {
        for x in 0..h {
            bw.push(vert.get_pixel(x, y)[0] < vert.get_pixel(x, y + 1)[0]);
        }
    }

    bw.finish(bits)
}

/// Separable DCT-II over a square block, rows then columns.
///
/// Separable rather than the naive 2-D form: 2·N³ multiplies instead of N⁴, which at N=32 is
/// 65 k against 1 M. The builder runs this 168,582 times, so the difference is minutes.
fn dct2d(input: &[f32], n: usize) -> Vec<f32> {
    // cos((2i+1)·k·π / 2N), precomputed once per call.
    let mut cos = vec![0f32; n * n];
    for k in 0..n {
        for i in 0..n {
            cos[k * n + i] =
                (((2 * i + 1) as f32) * (k as f32) * std::f32::consts::PI / (2.0 * n as f32)).cos();
        }
    }

    let mut rows = vec![0f32; n * n];
    for y in 0..n {
        for k in 0..n {
            let mut s = 0.0;
            for x in 0..n {
                s += input[y * n + x] * cos[k * n + x];
            }
            rows[y * n + k] = s;
        }
    }

    let mut out = vec![0f32; n * n];
    for x in 0..n {
        for k in 0..n {
            let mut s = 0.0;
            for y in 0..n {
                s += rows[y * n + x] * cos[k * n + y];
            }
            out[k * n + x] = s;
        }
    }
    out
}

fn phash(img: &GrayImage, bits: u16) -> Descriptor {
    // 32×32 is the conventional working size: large enough that the low-frequency block
    // below is a meaningful fraction of the spectrum, small enough that the DCT is free.
    const N: usize = 32;
    let small = image::imageops::resize(&prescale_luma(img), N as u32, N as u32, FilterType::Lanczos3);
    let input: Vec<f32> = small.pixels().map(|p| p[0] as f32).collect();
    let coeffs = dct2d(&input, N);

    // The low-frequency square, minus the DC term. DC is the image's mean brightness — it
    // carries no structure and would dominate the median it is compared against.
    let side = match bits {
        256 => 16, // 256 coefficients, drop DC, 255 usable — see the pad below
        128 => 12, // 144 coefficients, drop DC, 143 usable
        _ => unreachable!("width validated by `hash`"),
    };
    let mut block: Vec<f32> = Vec::with_capacity(side * side);
    for y in 0..side {
        for x in 0..side {
            if x == 0 && y == 0 {
                continue;
            }
            block.push(coeffs[y * N + x]);
        }
    }

    let mut sorted = block.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = sorted[sorted.len() / 2];

    let mut bw = BitWriter::new();
    for (i, c) in block.iter().enumerate() {
        if i == bits as usize {
            break;
        }
        bw.push(*c > median);
    }
    // A 16×16 block minus DC is 255 terms against a 256-bit width, and a 12×12 minus DC is
    // 143 against 128 — the first is one short, the second is over. Pad the shortfall with a
    // constant so the width is exact and the padding bit never carries information.
    while bw.n < bits as usize {
        bw.push(false);
    }
    bw.finish(bits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Luma};

    fn gradient(w: u32, h: u32) -> GrayImage {
        ImageBuffer::from_fn(w, h, |x, y| Luma([((x * 7 + y * 13) % 256) as u8]))
    }

    fn solid(w: u32, h: u32, v: u8) -> GrayImage {
        ImageBuffer::from_fn(w, h, |_, _| Luma([v]))
    }

    /// A synthetic "basic land": identical structure, one dominant hue. This is the case
    /// grayscale cannot solve — the luminance is deliberately the same for every colour.
    fn basic_land(hue: [f32; 3]) -> image::RgbImage {
        image::RgbImage::from_fn(200, 280, |x, y| {
            // Structure shared by every basic: a bright title band, a landscape with a
            // horizon, a type line, a text box.
            let ty = y as f32 / 280.0;
            let lum = if ty < 0.10 || (0.55..0.62).contains(&ty) {
                220.0
            } else if ty < 0.55 {
                90.0 + (x as f32 / 200.0) * 40.0 + if ty < 0.32 { 55.0 } else { 0.0 }
            } else {
                190.0
            };
            // Scale the shared luminance by a hue whose channels sum to 3, so every colour
            // has the *same* grey value and only the chroma differs.
            image::Rgb([
                (lum * hue[0]).clamp(0.0, 255.0) as u8,
                (lum * hue[1]).clamp(0.0, 255.0) as u8,
                (lum * hue[2]).clamp(0.0, 255.0) as u8,
            ])
        })
    }

    #[test]
    fn chroma_separates_what_grayscale_cannot() {
        // **The measured failure this kind exists for.** In the shipped grayscale bundle,
        // basics within one set sit 44-73 bits apart against a 67-bit confidence threshold and
        // a 101-bit mean for unrelated cards — so a Mountain matches an Island.
        let mountain = basic_land([1.45, 0.85, 0.70]); // red
        let island = basic_land([0.70, 0.95, 1.35]); // blue

        let g_m = hash_rgb(&mountain, HashKind::DHash, 256);
        let g_i = hash_rgb(&island, HashKind::DHash, 256);
        let grey_gap = g_m.distance(&g_i).expect("same width");

        let c_m = hash_rgb(&mountain, HashKind::DHashChroma, 256);
        let c_i = hash_rgb(&island, HashKind::DHashChroma, 256);
        let colour_gap = c_m.distance(&c_i).expect("same width");

        assert!(
            grey_gap < 20,
            "the fixture is not exercising the problem: grayscale already separates them by              {grey_gap} bits"
        );
        assert!(
            colour_gap > 40,
            "chroma only separated a red and a blue land by {colour_gap} bits (grayscale:              {grey_gap})"
        );
    }

    #[test]
    fn chroma_ignores_a_global_colour_cast() {
        // The property that makes colour usable on a photograph at all: a warm lamp shifts
        // every cell together, and cells are only ever compared to each other.
        let land = basic_land([1.45, 0.85, 0.70]);
        let warm = image::RgbImage::from_fn(200, 280, |x, y| {
            let p = land.get_pixel(x, y);
            image::Rgb([
                (p[0] as f32 * 1.18).min(255.0) as u8,
                p[1],
                (p[2] as f32 * 0.82) as u8,
            ])
        });
        let d = hash_rgb(&land, HashKind::DHashChroma, 256)
            .distance(&hash_rgb(&warm, HashKind::DHashChroma, 256))
            .expect("same width");
        assert!(d < 24, "a warm cast moved {d} bits; chroma should be near-immune");
    }

    #[test]
    fn the_same_land_still_matches_itself() {
        let land = basic_land([0.80, 1.40, 0.80]);
        let a = hash_rgb(&land, HashKind::DHashChroma, 256);
        let b = hash_rgb(&land, HashKind::DHashChroma, 256);
        assert_eq!(a.distance(&b), Some(0));
    }

    #[test]
    fn widths_are_exact() {
        let img = gradient(200, 280);
        for kind in [HashKind::DHash, HashKind::PHash] {
            for bits in [128u16, 256] {
                let d = hash(&img, kind, bits);
                assert_eq!(d.bits, bits);
                assert_eq!(d.to_bytes().len(), bits as usize / 8);
                // Words above the declared width must be untouched, or `distance` would
                // read bits that were never written.
                for w in &d.words[d.words_used()..] {
                    assert_eq!(*w, 0, "{kind:?}/{bits} wrote past its declared width");
                }
            }
        }
    }

    #[test]
    fn identical_images_have_distance_zero() {
        let img = gradient(200, 280);
        for kind in [HashKind::DHash, HashKind::PHash] {
            let a = hash(&img, kind, 256);
            let b = hash(&img, kind, 256);
            assert_eq!(a.distance(&b), Some(0), "{kind:?} is not deterministic");
        }
    }

    #[test]
    fn different_images_are_far_apart() {
        // Two structurally unrelated images should land near the 50% mark a random pair
        // would. Anything close to 0 means the descriptor is collapsing.
        let a = hash(&gradient(200, 280), HashKind::DHash, 256);
        let b = hash(
            &ImageBuffer::from_fn(200, 280, |x, y| Luma([(((x * x + y * y) / 37) % 256) as u8])),
            HashKind::DHash,
            256,
        );
        let d = a.distance(&b).expect("same width");
        assert!(d > 40, "unrelated images only {d} bits apart — descriptor is collapsing");
    }

    #[test]
    fn dhash_survives_a_brightness_shift() {
        // The property dHash exists for: a global exposure change is a constant added to
        // every term, so no gradient sign flips.
        //
        // **The fixture spans 20..=180 rather than the full range, and that is the point of
        // the test rather than a detail.** A gradient reaching 255 has ~16% of its pixels
        // saturate under a +40 shift, and a saturated region is *flat* — its gradients are
        // genuinely destroyed, and dHash is right to report a large distance. Written
        // against a full-range fixture this test fails at 56 bits and reads as "dHash is
        // not brightness-invariant", which is the wrong conclusion: clipping is information
        // loss, not a brightness change.
        let base: GrayImage =
            ImageBuffer::from_fn(200, 280, |x, y| Luma([(20 + (x * 7 + y * 13) % 161) as u8]));
        let brighter: GrayImage =
            ImageBuffer::from_fn(200, 280, |x, y| Luma([base.get_pixel(x, y)[0].saturating_add(40)]));
        let d = hash(&base, HashKind::DHash, 256)
            .distance(&hash(&brighter, HashKind::DHash, 256))
            .expect("same width");
        assert!(d < 20, "a +40 exposure shift moved {d} bits; dHash should be near-immune");
    }

    #[test]
    fn mismatched_widths_refuse_to_compare() {
        let img = gradient(200, 280);
        let a = hash(&img, HashKind::DHash, 128);
        let b = hash(&img, HashKind::DHash, 256);
        assert_eq!(a.distance(&b), None, "a 128-bit and a 256-bit hash must not compare");
    }

    #[test]
    fn chroma_widths_are_exact() {
        let land = basic_land([1.2, 1.0, 0.8]);
        for bits in [128u16, 256] {
            let d = hash_rgb(&land, HashKind::DHashChroma, bits);
            assert_eq!(d.bits, bits);
            assert_eq!(d.to_bytes().len(), bits as usize / 8);
            for w in &d.words[d.words_used()..] {
                assert_eq!(*w, 0, "DHashChroma/{bits} wrote past its declared width");
            }
        }
    }

    #[test]
    fn bytes_round_trip() {
        let d = hash(&gradient(200, 280), HashKind::PHash, 256);
        let back = Descriptor::from_bytes(&d.to_bytes(), 256).expect("round trip");
        assert_eq!(d, back);
        assert_eq!(d.to_hex().len(), 64);
    }

    #[test]
    fn from_bytes_rejects_a_wrong_length() {
        assert!(Descriptor::from_bytes(&[0u8; 31], 256).is_none());
        assert!(Descriptor::from_bytes(&[0u8; 32], 255).is_none());
    }

    #[test]
    fn a_flat_image_does_not_panic() {
        // Every gradient is zero and every DCT coefficient bar DC is zero, so the median is
        // zero and every comparison is false. Degenerate, but it must not panic — a camera
        // pointed at a wall reaches here.
        for kind in [HashKind::DHash, HashKind::PHash] {
            let d = hash(&solid(200, 280, 128), kind, 256);
            assert_eq!(d.bits, 256);
        }
    }
}
