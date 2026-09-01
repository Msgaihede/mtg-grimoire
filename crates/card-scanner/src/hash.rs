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
//! Both are computed on **grayscale**, which deliberately throws away the strongest global
//! signal an MTG card has: its colour identity. A frame's red/blue/green/white/black/gold is
//! enormously discriminative — and it is also the least reliable thing under a desk lamp, a
//! phone flash, or a foil's rainbow. A colour term is the first refinement to reach for if
//! the measured accuracy needs one; it is not in the first pass because nothing has been
//! measured yet, and this is precisely the place a guess would be expensive to unpick.

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
}

impl HashKind {
    pub fn as_str(self) -> &'static str {
        match self {
            HashKind::DHash => "dhash",
            HashKind::PHash => "phash",
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
    }
}

fn dhash(img: &GrayImage, bits: u16) -> Descriptor {
    let (w, h) = dhash_grid(bits);
    let mut bw = BitWriter::new();

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
    let small = image::imageops::resize(img, N as u32, N as u32, FilterType::Lanczos3);
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
