//! Synthetic camera frames from a card render — what the evaluation feeds a
//! [`crate::session::Session`].
//!
//! **Why this exists at all: the sample photographs this crate was tuned on are lost.** Without
//! them nothing fences either scan mode, so `bin/eval.rs` takes Scryfall's own renders and
//! degrades them in software into bursts a camera might have produced — spec §5 of
//! `docs/superpowers/specs/2026-09-15-scanner-modes-and-shipping-design.md`. A regression fence,
//! not an accuracy claim about a camera: every degradation below is a guess at a phone under a
//! lamp, and none of them was fitted to one.
//!
//! **Deterministic, byte for byte.** Every random draw comes from one [`SplitMix64`] seeded with
//! `seed ^ card_index`, drawn in a fixed order, so the same card, seed and index make the same
//! JPEGs run after run, and a figure in the evaluation's table moves only when the pipeline
//! does. *Across platforms* that is not promised: `sin`, `cos` and `exp` come from the platform's
//! maths library, which may round a last bit differently, so a Linux runner and a Windows desk
//! can disagree about a card or two. No `rand` dependency: a 64-bit mixer is all a generator of
//! poses needs, and a new dependency would move `Cargo.lock` under every `--locked` build.
//!
//! One burst holds a card in one **base pose** and jitters it a little per frame, which is what
//! a hand does: the lock (`crate::lock`) has to see the quad stay put before anything is
//! matched, so a burst of unrelated poses would measure the lock rather than the matcher.

use image::{Rgb, RgbImage, Rgba, RgbaImage};
use imageproc::geometric_transformations::{warp_into, Border, Interpolation, Projection};

/// How a burst is made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SynthOptions {
    /// Mixed with the card index, so two cards of one run never share a pose.
    pub seed: u64,
    /// Frames per burst. Twelve: the lock takes three, Fast's vote bar eight more.
    pub frames: usize,
    /// The frame's long side, in pixels. The short side is 9/16 of it — a landscape webcam
    /// frame, 1280×720 at the default.
    pub long_edge: u32,
}

impl Default for SynthOptions {
    fn default() -> Self {
        SynthOptions { seed: 7, frames: 12, long_edge: 1280 }
    }
}

/// The card's height as a fraction of the frame's short edge.
const SCALE: (f32, f32) = (0.25, 0.70);
/// Perspective: each corner moves up to half of this fraction of the card's size along each of
/// the card's own axes, so an edge can shorten or lengthen by up to this much.
const PERSPECTIVE: f32 = 0.12;
/// Space kept between the posed card and the frame's edge, as a fraction of the short edge.
/// `detect` rejects a quad that touches the border, and a frame's jitter must not push the card
/// into it.
const MARGIN: f32 = 0.04;
const WHITE_BALANCE: (f32, f32) = (0.85, 1.15);
const EXPOSURE: (f32, f32) = (0.7, 1.2);
/// The glare blob's peak opacity never exceeds the upper bound.
const GLARE_ALPHA: (f32, f32) = (0.2, 0.6);
const BLUR_SIGMA: (f32, f32) = (0.0, 1.6);
const JPEG_QUALITY: (u8, u8) = (60, 90);
/// Per-frame jitter: how far the card may move, as a fraction of the short edge, and how far it
/// may turn, in degrees.
const JITTER_TRANSLATION: f32 = 0.015;
const JITTER_DEGREES: f32 = 1.0;
/// A physical card's corner radius, 1/8" on 2.5", as a fraction of its width.
const CORNER_RADIUS: f32 = 0.05;

/// A burst of JPEG frames of one card render, degraded deterministically.
///
/// Per card: a base pose (scale, rotation, perspective, position), a background, a white
/// balance and exposure, one specular glare blob, a blur and a JPEG quality. Per frame: a small
/// jitter of the pose. See the module doc for why the pose holds.
pub fn burst(card: &RgbImage, opts: &SynthOptions, card_index: u64) -> Vec<Vec<u8>> {
    let w = opts.long_edge.max(16);
    let h = ((w as f32) * 9.0 / 16.0).round() as u32;
    let short = h as f32;
    let mut rng = SplitMix64(opts.seed ^ card_index);

    // ---- the base pose -------------------------------------------------------------------
    let aspect = card.width().max(1) as f32 / card.height().max(1) as f32;
    let card_h = rng.range(SCALE.0, SCALE.1) * short;
    let card_w = card_h * aspect;
    let rotation = rng.range(0.0, std::f32::consts::TAU);
    let p = rng.range(0.0, PERSPECTIVE);
    let local = [(0.0, 0.0), (card_w, 0.0), (card_w, card_h), (0.0, card_h)].map(|(x, y)| {
        let dx = rng.range(-0.5, 0.5) * p * card_w;
        let dy = rng.range(-0.5, 0.5) * p * card_h;
        (x - card_w / 2.0 + dx, y - card_h / 2.0 + dy)
    });
    // Where the centre may go: anywhere that keeps the rotated corners inside the margin.
    let turned = local.map(|c| rotate(c, rotation));
    let half_x = turned.iter().map(|c| c.0.abs()).fold(0.0, f32::max);
    let half_y = turned.iter().map(|c| c.1.abs()).fold(0.0, f32::max);
    let margin = MARGIN * short;
    let place = |rng: &mut SplitMix64, extent: f32, half: f32| {
        let (lo, hi) = (margin + half, extent - margin - half);
        if lo < hi {
            rng.range(lo, hi)
        } else {
            extent / 2.0
        }
    };
    let centre = (place(&mut rng, w as f32, half_x), place(&mut rng, h as f32, half_y));

    // ---- the scene ------------------------------------------------------------------------
    let background = background(&mut rng, w, h);
    let gains = {
        let exposure = rng.range(EXPOSURE.0, EXPOSURE.1);
        let mut g = [0.0f32; 3];
        for c in &mut g {
            *c = rng.range(WHITE_BALANCE.0, WHITE_BALANCE.1) * exposure;
        }
        g
    };
    // On the card, in frame space: a lamp's reflection stays where the lamp is while the card
    // jitters under it.
    let glare = {
        let at = rotate(
            (rng.range(-0.35, 0.35) * card_w, rng.range(-0.35, 0.35) * card_h),
            rotation,
        );
        let rx = rng.range(0.08, 0.30) * card_h;
        Glare {
            x: centre.0 + at.0,
            y: centre.1 + at.1,
            rx,
            ry: rx * rng.range(0.35, 1.0),
            angle: rng.range(0.0, std::f32::consts::PI),
            alpha: rng.range(GLARE_ALPHA.0, GLARE_ALPHA.1),
        }
    };
    let sigma = rng.range(BLUR_SIGMA.0, BLUR_SIGMA.1);
    let quality = JPEG_QUALITY.0 + rng.below(u32::from(JPEG_QUALITY.1 - JPEG_QUALITY.0) + 1) as u8;

    // The render, resized once to the size it is drawn at so the warp samples it near 1:1, with
    // a physical card's rounded corners cut out of it.
    let face = rounded(&image::imageops::resize(
        card,
        card_w.round().max(1.0) as u32,
        card_h.round().max(1.0) as u32,
        image::imageops::FilterType::Triangle,
    ));
    let (fw, fh) = (face.width() as f32, face.height() as f32);
    let from = [(0.0, 0.0), (fw, 0.0), (fw, fh), (0.0, fh)];

    (0..opts.frames)
        .map(|_| {
            let (reach, heading) =
                (rng.range(0.0, JITTER_TRANSLATION * short), rng.range(0.0, std::f32::consts::TAU));
            let shift = (reach * heading.cos(), reach * heading.sin());
            let turn = rotation + rng.range(-1.0, 1.0) * JITTER_DEGREES.to_radians();
            let to = local.map(|c| {
                let (x, y) = rotate(c, turn);
                (centre.0 + shift.0 + x, centre.1 + shift.1 + y)
            });
            // `warp_into` against a frame-sized layer rather than `warp`, which returns an image
            // the size of its *input* — see the note in `crate::detect`.
            let mut layer = RgbaImage::new(w, h);
            if let Some(projection) = Projection::from_control_points(from, to) {
                warp_into(
                    &face,
                    projection,
                    Interpolation::Bilinear,
                    Border::Constant(Rgba([0, 0, 0, 0])),
                    &mut layer,
                );
            }
            let frame = compose(&background, &layer, &glare, gains);
            let frame = if sigma >= 0.05 {
                imageproc::filter::gaussian_blur_f32(&frame, sigma)
            } else {
                frame
            };
            let mut jpeg = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, quality)
                .encode_image(&frame)
                .expect("encoding an in-memory RGB image cannot fail");
            jpeg
        })
        .collect()
}

/// SplitMix64 — Steele, Lea and Flood's mixer, the seeding generator `java.util.SplittableRandom`
/// and the xoshiro family use. Zero is a fine seed, which matters: `seed ^ card_index` is zero
/// whenever the two are equal.
struct SplitMix64(u64);

impl SplitMix64 {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `[0, 1)`, from the top 24 bits — exactly representable in an `f32`.
    fn unit(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u32 << 24) as f32
    }

    fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.unit()
    }

    fn below(&mut self, n: u32) -> u32 {
        (self.next_u64() % u64::from(n.max(1))) as u32
    }
}

fn rotate((x, y): (f32, f32), angle: f32) -> (f32, f32) {
    let (s, c) = angle.sin_cos();
    (x * c - y * s, x * s + y * c)
}

/// One elliptical specular highlight, in frame space.
struct Glare {
    x: f32,
    y: f32,
    rx: f32,
    ry: f32,
    angle: f32,
    alpha: f32,
}

/// The card with its corners rounded off, **premultiplied**: the bilinear warp blends edge
/// pixels with the transparent border, which is exactly a premultiplied blend, so compositing
/// as premultiplied gives an antialiased edge with no dark fringe.
fn rounded(card: &RgbImage) -> RgbaImage {
    let (w, h) = (card.width() as f32, card.height() as f32);
    let r = (CORNER_RADIUS * w).max(1.0);
    RgbaImage::from_fn(card.width(), card.height(), |x, y| {
        let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
        // Distance past the rounded corner's arc, 0 anywhere away from a corner.
        let cx = px.clamp(r, w - r);
        let cy = py.clamp(r, h - r);
        let d = ((px - cx).powi(2) + (py - cy).powi(2)).sqrt();
        let coverage = (r - d + 0.5).clamp(0.0, 1.0);
        let Rgb([red, green, blue]) = *card.get_pixel(x, y);
        let pre = |v: u8| (f32::from(v) * coverage).round() as u8;
        Rgba([pre(red), pre(green), pre(blue), (coverage * 255.0).round() as u8])
    })
}

/// The card layer over the background, the glare over both, then the camera's gains.
fn compose(background: &RgbImage, layer: &RgbaImage, glare: &Glare, gains: [f32; 3]) -> RgbImage {
    let (gs, gc) = glare.angle.sin_cos();
    let mut out = RgbImage::new(background.width(), background.height());
    let w = background.width();
    for (i, ((o, b), l)) in out.pixels_mut().zip(background.pixels()).zip(layer.pixels()).enumerate()
    {
        let (x, y) = ((i as u32 % w) as f32, (i as u32 / w) as f32);
        let a = f32::from(l[3]) / 255.0;
        let (dx, dy) = (x - glare.x, y - glare.y);
        let u = (dx * gc + dy * gs) / glare.rx;
        let v = (-dx * gs + dy * gc) / glare.ry;
        let d2 = u * u + v * v;
        let shine = if d2 < 4.0 { glare.alpha * (-2.0 * d2).exp() } else { 0.0 };
        for ch in 0..3 {
            let scene = f32::from(l[ch]) + (1.0 - a) * f32::from(b[ch]);
            let lit = scene + shine * (255.0 - scene);
            o[ch] = (lit * gains[ch]).round().clamp(0.0, 255.0) as u8;
        }
    }
    out
}

/// A frame-sized background: flat grey-brown, value noise, or wood-like stripes.
fn background(rng: &mut SplitMix64, w: u32, h: u32) -> RgbImage {
    // A grey-brown: the green and blue channels trail the red.
    let tint = |rng: &mut SplitMix64| {
        let v = rng.range(80.0, 180.0);
        [v, v * rng.range(0.82, 0.95), v * rng.range(0.65, 0.85)]
    };
    match rng.below(3) {
        0 => {
            let [r, g, b] = tint(rng).map(|c| c.round() as u8);
            RgbImage::from_pixel(w, h, Rgb([r, g, b]))
        }
        1 => {
            let base = tint(rng);
            let amplitude = rng.range(20.0, 45.0);
            let cell = rng.range(40.0, 120.0);
            let coarse = Lattice::new(rng, w, h, cell);
            let cell = rng.range(8.0, 24.0);
            let fine = Lattice::new(rng, w, h, cell);
            RgbImage::from_fn(w, h, |x, y| {
                let (fx, fy) = (x as f32, y as f32);
                let n = coarse.at(fx, fy) - 0.5 + 0.5 * (fine.at(fx, fy) - 0.5);
                let k = n * amplitude;
                Rgb(base.map(|c| (c + k).round().clamp(0.0, 255.0) as u8))
            })
        }
        _ => {
            let dark = [80.0, 52.0, 30.0];
            let light = [165.0, 118.0, 72.0];
            let shade = rng.range(0.8, 1.15);
            let angle = rng.range(0.0, std::f32::consts::PI);
            let period = rng.range(18.0, 60.0);
            let warp = rng.range(2.0, 6.0);
            let cell = rng.range(30.0, 90.0);
            let grain = Lattice::new(rng, w, h, cell);
            let (s, c) = angle.sin_cos();
            RgbImage::from_fn(w, h, |x, y| {
                let (fx, fy) = (x as f32, y as f32);
                let across = -fx * s + fy * c;
                let t = 0.5
                    + 0.5
                        * (std::f32::consts::TAU * across / period + warp * grain.at(fx, fy))
                            .sin();
                let mut px = [0u8; 3];
                for ch in 0..3 {
                    let v = (dark[ch] + (light[ch] - dark[ch]) * t) * shade;
                    px[ch] = v.round().clamp(0.0, 255.0) as u8;
                }
                Rgb(px)
            })
        }
    }
}

/// Value noise: random values on a square lattice, smoothly interpolated between.
struct Lattice {
    cell: f32,
    cols: usize,
    values: Vec<f32>,
}

impl Lattice {
    fn new(rng: &mut SplitMix64, w: u32, h: u32, cell: f32) -> Lattice {
        let cols = (w as f32 / cell).ceil() as usize + 2;
        let rows = (h as f32 / cell).ceil() as usize + 2;
        let values = (0..cols * rows).map(|_| rng.unit()).collect();
        Lattice { cell, cols, values }
    }

    fn at(&self, x: f32, y: f32) -> f32 {
        let (gx, gy) = (x / self.cell, y / self.cell);
        let (ix, iy) = (gx.floor() as usize, gy.floor() as usize);
        let smooth = |t: f32| t * t * (3.0 - 2.0 * t);
        let (tx, ty) = (smooth(gx.fract()), smooth(gy.fract()));
        let v = |cx: usize, cy: usize| self.values[cy * self.cols + cx];
        let top = v(ix, iy) + (v(ix + 1, iy) - v(ix, iy)) * tx;
        let bottom = v(ix, iy + 1) + (v(ix + 1, iy + 1) - v(ix, iy + 1)) * tx;
        top + (bottom - top) * ty
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detect::{detect, DetectOptions};
    use crate::CARD_ASPECT;
    use image::{GenericImageView, Rgb};

    /// A card render with a black border ring and the horizontal bands a card has — title,
    /// art, type line, text box — at Scryfall's `grid` size. High contrast on purpose: this is
    /// the fixture that proves the generator's output is something the detector can see, so a
    /// failure has to be the generator's and not a subtle render's.
    fn high_contrast_card() -> RgbImage {
        let (w, h) = (488u32, 680u32);
        assert!(((w as f32 / h as f32) - CARD_ASPECT).abs() < 0.01);
        RgbImage::from_fn(w, h, |x, y| {
            let border = 22;
            if x < border || y < border || x >= w - border || y >= h - border {
                return Rgb([16, 16, 18]);
            }
            let t = y as f32 / h as f32;
            let v = match t {
                t if t < 0.10 => 238,
                t if t < 0.55 => 150,
                t if t < 0.62 => 238,
                t if t < 0.92 => 205,
                _ => 140,
            };
            Rgb([v, v, v])
        })
    }

    fn small() -> SynthOptions {
        SynthOptions { long_edge: 640, ..Default::default() }
    }

    #[test]
    fn the_same_inputs_make_byte_identical_frames() {
        let card = high_contrast_card();
        let a = burst(&card, &small(), 3);
        let b = burst(&card, &small(), 3);
        assert_eq!(a.len(), 12);
        assert!(a == b, "two bursts from the same seed and card index differ");
    }

    #[test]
    fn a_different_card_index_makes_different_frames() {
        let card = high_contrast_card();
        let a = burst(&card, &small(), 3);
        let b = burst(&card, &small(), 4);
        assert_eq!(a.len(), b.len());
        assert!(a.iter().zip(&b).all(|(x, y)| x != y), "card index 4 repeated a frame of 3");
        // And the frames inside one burst are not one frame twelve times: the pose jitters.
        assert!(a.windows(2).all(|p| p[0] != p[1]), "two consecutive frames are identical");
    }

    #[test]
    fn every_frame_decodes_with_the_long_edge_asked_for() {
        let card = high_contrast_card();
        for opts in [small(), SynthOptions { long_edge: 1000, frames: 3, seed: 11 }] {
            let frames = burst(&card, &opts, 0);
            assert_eq!(frames.len(), opts.frames);
            for f in &frames {
                let img = image::load_from_memory(f).expect("a frame is a decodable JPEG");
                assert_eq!(image::guess_format(f).ok(), Some(image::ImageFormat::Jpeg));
                let (w, h) = img.dimensions();
                assert_eq!(w.max(h), opts.long_edge);
                assert!(w.min(h) < w.max(h), "a camera frame is not square");
            }
        }
    }

    /// **The test that proves the generator makes something the detector can see.** Every
    /// other number the evaluation reports rests on this: a generator whose cards the detector
    /// misses would make both modes look broken while measuring nothing about either.
    #[test]
    fn the_detector_finds_the_card_in_a_burst() {
        let card = high_contrast_card();
        let opts = SynthOptions::default();
        let frames = burst(&card, &opts, 0);
        assert_eq!(frames.len(), 12);
        let found = frames
            .iter()
            .filter(|f| {
                let img = image::load_from_memory(f).expect("decode");
                detect(&img, &DetectOptions::default()).0.is_ok()
            })
            .count();
        assert!(found >= 10, "the detector found the card on only {found} of 12 frames");
    }
}
