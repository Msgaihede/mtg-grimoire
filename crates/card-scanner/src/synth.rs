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
//!
//! **A burst has a [`Scene`]**: the bare card ([`Scene::Plain`]), the card in a sleeve, or the
//! card on top of a small, offset stack — the two ways a real card most often stops being a
//! clean rectangle against a table (issue #703). **Every draw a scene adds comes from a second
//! generator** salted with [`SCENE_SALT`], never from the pose's, so the pose's draws keep their
//! order and **`Plain` is byte-identical to the `burst` that existed before scenes did** — the
//! evaluation's baseline figures rest on that. The same property makes the three scenes a paired
//! comparison: one card index gets the same pose, background, lighting, blur and JPEG quality in
//! every scene, and only what surrounds the card differs. The cost is that a sleeve or a stack
//! can run a few pixels past the frame's margin on the largest poses, which a hand does too.
//!
//! Every frame also carries its **truth quad** ([`SynthFrame::quad`]): where the top card's outer
//! corners went, which is what `bin/eval.rs` measures a detector's corners against.

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

/// A card's width in millimetres — the ruler every sleeve and stack measurement below is read
/// against, converted to pixels through the drawn card's own width.
const CARD_WIDTH_MM: f32 = 63.0;
/// Mixed into the scene generator's seed so its stream shares nothing with the pose's. Any
/// constant does; this one is the fractional part of √2, which nothing else in the crate uses.
const SCENE_SALT: u64 = 0x6A09_E667_F3BC_C908;

/// **A standard sleeve is ~66×91 mm around a 63×88 mm card**, so 3 mm of slack each way.
/// The card slides to one side or the other, so the left margin is drawn and the right one is
/// what remains.
const SLEEVE_SLACK_MM: f32 = 3.0;
const SLEEVE_LEFT_MM: (f32, f32) = (1.1, 1.9);
/// The closed end is the card's bottom and the card rests against it, so the bottom margin is
/// the smaller one and the open top keeps the rest of the slack.
const SLEEVE_BOTTOM_MM: (f32, f32) = (0.4, 1.2);
/// A sleeve's corner is a little rounder than the card's 3.15 mm.
const SLEEVE_RADIUS_MM: (f32, f32) = (3.4, 4.2);
/// The welded edge of a sleeve, a thin line brighter than the plastic around it.
const SLEEVE_LIP_MM: f32 = 0.3;
const SLEEVE_LIP_ALPHA: (f32, f32) = (0.30, 0.60);
/// One layer of plastic over the card face: a few percent of contrast, lost toward the
/// plastic's own light grey.
const SLEEVE_FACE_HAZE: (f32, f32) = (0.03, 0.07);
/// A clear sleeve's margin is seen through both layers of plastic, so it hazes more than the
/// face — and it is still mostly the table, which is the low-contrast case the detector has to
/// see past.
const SLEEVE_CLEAR_MARGIN_HAZE: (f32, f32) = (0.10, 0.22);
const SLEEVE_PLASTIC: [f32; 3] = [236.0, 239.0, 243.0];
/// Opaque sleeve backs. **Black three times of nine**, because a black back beside a black
/// border is the hard case — the card's outer edge disappears into the sleeve's margin.
const SLEEVE_BACKS: [[f32; 3]; 9] = [
    [14.0, 14.0, 16.0],
    [20.0, 19.0, 22.0],
    [10.0, 10.0, 12.0],
    [22.0, 34.0, 88.0],
    [150.0, 24.0, 30.0],
    [236.0, 236.0, 232.0],
    [24.0, 96.0, 48.0],
    [70.0, 36.0, 110.0],
    [110.0, 112.0, 116.0],
];
/// Plastic reflects a lamp harder than card stock does: a sleeve's glare is stronger, and its
/// edge is sharp — a plateau that ends — where a bare card's fades.
const SLEEVE_GLARE_ALPHA: (f32, f32) = (0.5, 0.85);
const SLEEVE_GLARE_EDGE: (f32, f32) = (1.5, 3.0);

/// How far each card beneath the top one sits from it, in its own plane, and how far it turns.
const STACK_OFFSET_MM: (f32, f32) = (1.5, 5.0);
const STACK_TURN_DEGREES: f32 = 4.0;

/// What surrounds the card in a burst.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scene {
    /// The bare card on the table — the scene every figure before scenes existed was measured
    /// on, and byte-identical to it.
    Plain,
    /// The card inside a sleeve: clear, or with an opaque back, chosen per card.
    Sleeved,
    /// The card on top of one or two others, each offset a few millimetres and turned a few
    /// degrees in the same plane. The truth is the top card's.
    Stacked,
}

impl Scene {
    pub const ALL: [Scene; 3] = [Scene::Plain, Scene::Sleeved, Scene::Stacked];

    pub fn as_str(self) -> &'static str {
        match self {
            Scene::Plain => "plain",
            Scene::Sleeved => "sleeved",
            Scene::Stacked => "stacked",
        }
    }
}

impl std::fmt::Display for Scene {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for Scene {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let wanted = s.trim().to_ascii_lowercase();
        Scene::ALL
            .into_iter()
            .find(|scene| scene.as_str() == wanted)
            .ok_or_else(|| format!("{s:?} is not a scene — one of plain, sleeved, stacked"))
    }
}

/// One frame of a burst, and where the card really is in it.
#[derive(Debug, Clone)]
pub struct SynthFrame {
    pub jpeg: Vec<u8>,
    /// The (top) card's true outer corners in frame pixels, TL, TR, BR, BL of the card's own
    /// upright orientation — the sharp corners the rounded ones are cut from, which is what a
    /// detector's four lines meet at. The card's, never the sleeve's or the stack's.
    pub quad: [(f32, f32); 4],
}

/// A burst of JPEG frames of one card render, degraded deterministically — the bare card,
/// [`Scene::Plain`].
pub fn burst(card: &RgbImage, opts: &SynthOptions, card_index: u64) -> Vec<Vec<u8>> {
    burst_scene(card, opts, card_index, Scene::Plain, &[]).into_iter().map(|f| f.jpeg).collect()
}

/// A burst of one card render in a scene, each frame with its truth quad.
///
/// Per card: a base pose (scale, rotation, perspective, position), a background, a white
/// balance and exposure, one specular glare blob, a blur and a JPEG quality. Per frame: a small
/// jitter of the pose, applied to the whole scene — a sleeve or a stack moves as one with its
/// card. See the module doc for why the pose holds, and why a scene never touches its draws.
///
/// `under` is what a [`Scene::Stacked`] burst puts beneath the card, cycled through; empty
/// means a synthetic stand-in. The other scenes ignore it.
pub fn burst_scene(
    card: &RgbImage,
    opts: &SynthOptions,
    card_index: u64,
    scene: Scene,
    under: &[&RgbImage],
) -> Vec<SynthFrame> {
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
            edge: GlareEdge::Soft,
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

    // ---- what surrounds the card: its own generator, never `rng` -----------------------------
    let mut scene_rng = SplitMix64(opts.seed ^ card_index ^ SCENE_SALT);
    let surround = Surround::new(scene, &face, under, &mut scene_rng);
    let glare = match &surround {
        Surround::Sleeve { glare_alpha, glare_edge, .. } => {
            Glare { alpha: *glare_alpha, edge: GlareEdge::Hard(*glare_edge), ..glare }
        }
        _ => glare,
    };
    // The card's own plane: its flat rectangle, in the face's pixels, onto the base pose's
    // perspective-displaced corners. **Everything beside the card goes through this before the
    // per-frame turn and shift**, which is what keeps a sleeve or a stack coplanar with the card
    // and moving as one with it. `None` only for a degenerate pose, where the card's own warp
    // below fails the same way.
    let plane = Projection::from_control_points(from, local);
    // Each extra layer's corners in the pose's local frame, computed once: only the jitter moves.
    let extras: Vec<(&RgbaImage, [(f32, f32); 4])> = match &plane {
        Some(plane) => surround
            .layers()
            .into_iter()
            .map(|(image, flat)| (image, flat.map(|p| *plane * p)))
            .collect(),
        None => Vec::new(),
    };
    // **The truth is half a face pixel outside `from`, not `from` itself.** `imageproc` puts a
    // pixel's centre at its integer coordinate — `warp_into` samples output pixel `x` at the
    // pre-image of `x` — so the face's first column is centred on 0 and its outer edge is at
    // -0.5, and likewise `fw - 0.5` on the far side. The frame's coordinates follow the same
    // rule, and so do `detect`'s quads and `rectify_to`, so this is the card's outer edge in the
    // coordinates a detector answers in. `from` itself would sit up to 0.7 px inside it, in a
    // direction that turns with the pose.
    let outer = from.map(|(x, y)| (x - 0.5, y - 0.5));
    let truth_local = plane.map(|plane| outer.map(|p| plane * p));

    (0..opts.frames)
        .map(|_| {
            let (reach, heading) =
                (rng.range(0.0, JITTER_TRANSLATION * short), rng.range(0.0, std::f32::consts::TAU));
            let shift = (reach * heading.cos(), reach * heading.sin());
            let turn = rotation + rng.range(-1.0, 1.0) * JITTER_DEGREES.to_radians();
            let place = |c: (f32, f32)| {
                let (x, y) = rotate(c, turn);
                (centre.0 + shift.0 + x, centre.1 + shift.1 + y)
            };
            let to = local.map(place);
            // Bottom to top: whatever is beneath the card, then the card — or, in a sleeve, the
            // sleeve with the card already inside it, which replaces the bare card.
            let mut layers: Vec<RgbaImage> = extras
                .iter()
                .map(|(image, corners)| {
                    let (iw, ih) = (image.width() as f32, image.height() as f32);
                    let own = [(0.0, 0.0), (iw, 0.0), (iw, ih), (0.0, ih)];
                    warped(image, own, corners.map(place), w, h)
                })
                .collect();
            if !surround.replaces_card() {
                layers.push(warped(&face, from, to, w, h));
            }
            let frame = compose(&background, &layers, &glare, gains);
            let frame = if sigma >= 0.05 {
                imageproc::filter::gaussian_blur_f32(&frame, sigma)
            } else {
                frame
            };
            let mut jpeg = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, quality)
                .encode_image(&frame)
                .expect("encoding an in-memory RGB image cannot fail");
            SynthFrame { jpeg, quad: truth_local.map_or(to, |t| t.map(place)) }
        })
        .collect()
}

/// `image` warped so its own rectangle lands on `to`, into a transparent frame-sized layer.
///
/// `warp_into` against a frame-sized layer rather than `warp`, which returns an image the size
/// of its *input* — see the note in `crate::detect`.
fn warped(
    image: &RgbaImage,
    from: [(f32, f32); 4],
    to: [(f32, f32); 4],
    w: u32,
    h: u32,
) -> RgbaImage {
    let mut layer = RgbaImage::new(w, h);
    if let Some(projection) = Projection::from_control_points(from, to) {
        warp_into(
            image,
            projection,
            Interpolation::Bilinear,
            Border::Constant(Rgba([0, 0, 0, 0])),
            &mut layer,
        );
    }
    layer
}

/// What a scene puts around the card, built once per burst in the card's flat plane — the
/// face's own pixels, with the face at the origin.
enum Surround {
    Bare,
    /// The whole sleeve with the card inside it, drawn **instead of** the bare card: the plastic
    /// lies over the face, so the two are one layer. `flat` is where the sleeve image's corners
    /// sit in the card's plane — outside the face by the margins.
    Sleeve {
        image: RgbaImage,
        flat: [(f32, f32); 4],
        glare_alpha: f32,
        glare_edge: f32,
    },
    /// The cards beneath, deepest first, each with its corners in the card's plane.
    Stack(Vec<(RgbaImage, [(f32, f32); 4])>),
}

impl Surround {
    fn new(scene: Scene, face: &RgbaImage, under: &[&RgbImage], rng: &mut SplitMix64) -> Surround {
        let (fw, fh) = (face.width() as f32, face.height() as f32);
        let px_per_mm = fw / CARD_WIDTH_MM;
        match scene {
            Scene::Plain => Surround::Bare,
            Scene::Sleeved => {
                let left = rng.range(SLEEVE_LEFT_MM.0, SLEEVE_LEFT_MM.1);
                let bottom = rng.range(SLEEVE_BOTTOM_MM.0, SLEEVE_BOTTOM_MM.1);
                // Whole pixels, so the face drops into the sleeve image without a resample and
                // the card inside the sleeve is exactly the face the bare scene draws.
                let px = |mm: f32| (mm * px_per_mm).round().max(1.0) as u32;
                let margins = Margins {
                    left: px(left),
                    top: px(SLEEVE_SLACK_MM - bottom),
                    right: px(SLEEVE_SLACK_MM - left),
                    bottom: px(bottom),
                };
                let back = if rng.below(2) == 0 {
                    None
                } else {
                    Some(SLEEVE_BACKS[rng.below(SLEEVE_BACKS.len() as u32) as usize])
                };
                let plastic = Plastic {
                    radius: rng.range(SLEEVE_RADIUS_MM.0, SLEEVE_RADIUS_MM.1) * px_per_mm,
                    lip: (SLEEVE_LIP_MM * px_per_mm).max(1.0),
                    lip_alpha: rng.range(SLEEVE_LIP_ALPHA.0, SLEEVE_LIP_ALPHA.1),
                    face_haze: rng.range(SLEEVE_FACE_HAZE.0, SLEEVE_FACE_HAZE.1),
                    clear_haze: rng.range(SLEEVE_CLEAR_MARGIN_HAZE.0, SLEEVE_CLEAR_MARGIN_HAZE.1),
                    back,
                };
                let glare_alpha = rng.range(SLEEVE_GLARE_ALPHA.0, SLEEVE_GLARE_ALPHA.1);
                let glare_edge = rng.range(SLEEVE_GLARE_EDGE.0, SLEEVE_GLARE_EDGE.1);
                let (l, t, r, b) = (
                    margins.left as f32,
                    margins.top as f32,
                    margins.right as f32,
                    margins.bottom as f32,
                );
                Surround::Sleeve {
                    image: sleeve(face, margins, &plastic),
                    flat: [(-l, -t), (fw + r, -t), (fw + r, fh + b), (-l, fh + b)],
                    glare_alpha,
                    glare_edge,
                }
            }
            Scene::Stacked => {
                let count = 1 + rng.below(2) as usize;
                let mut beneath: Vec<(RgbaImage, [(f32, f32); 4])> = (0..count)
                    .map(|k| {
                        let reach = rng.range(STACK_OFFSET_MM.0, STACK_OFFSET_MM.1) * px_per_mm;
                        let heading = rng.range(0.0, std::f32::consts::TAU);
                        let turn = rng.range(-1.0, 1.0) * STACK_TURN_DEGREES.to_radians();
                        let size = (face.width(), face.height());
                        let render = match under {
                            [] => stand_in(rng, size),
                            _ => image::imageops::resize(
                                under[k % under.len()],
                                size.0,
                                size.1,
                                image::imageops::FilterType::Triangle,
                            ),
                        };
                        let centre =
                            (fw / 2.0 + reach * heading.cos(), fh / 2.0 + reach * heading.sin());
                        let corners = [(-fw, -fh), (fw, -fh), (fw, fh), (-fw, fh)].map(|(x, y)| {
                            let (x, y) = rotate((x / 2.0, y / 2.0), turn);
                            (centre.0 + x, centre.1 + y)
                        });
                        (rounded(&render), corners)
                    })
                    .collect();
                // Drawn in the order they were made, the first one right beneath the top card:
                // reversed, so the deepest goes down first.
                beneath.reverse();
                Surround::Stack(beneath)
            }
        }
    }

    /// Each layer to draw before the card, bottom first, with its corners in the card's plane.
    fn layers(&self) -> Vec<(&RgbaImage, [(f32, f32); 4])> {
        match self {
            Surround::Bare => Vec::new(),
            Surround::Sleeve { image, flat, .. } => vec![(image, *flat)],
            Surround::Stack(cards) => cards.iter().map(|(image, flat)| (image, *flat)).collect(),
        }
    }

    fn replaces_card(&self) -> bool {
        matches!(self, Surround::Sleeve { .. })
    }
}

/// A sleeve's margin around the face, in whole pixels of the face's own scale.
#[derive(Debug, Clone, Copy)]
struct Margins {
    left: u32,
    top: u32,
    right: u32,
    bottom: u32,
}

/// One sleeve's plastic, in the face's pixels.
struct Plastic {
    radius: f32,
    lip: f32,
    lip_alpha: f32,
    face_haze: f32,
    clear_haze: f32,
    /// The back's colour; `None` is a clear sleeve, whose margin is the table.
    back: Option<[f32; 3]>,
}

/// The card inside its sleeve, premultiplied like [`rounded`]'s face: an opaque back (if any),
/// the card over it, and one layer of hazy plastic over both, brightening to a lip at the edge.
fn sleeve(face: &RgbaImage, m: Margins, plastic: &Plastic) -> RgbaImage {
    let (sw, sh) = (face.width() + m.left + m.right, face.height() + m.top + m.bottom);
    let (w, h) = (sw as f32, sh as f32);
    RgbaImage::from_fn(sw, sh, |x, y| {
        let inside = inside_rounded(x as f32 + 0.5, y as f32 + 0.5, w, h, plastic.radius);
        let cover = (inside + 0.5).clamp(0.0, 1.0);
        // The card, where it is: premultiplied, with its own rounded corners already cut.
        let card = x
            .checked_sub(m.left)
            .zip(y.checked_sub(m.top))
            .filter(|&(cx, cy)| cx < face.width() && cy < face.height())
            .map_or([0.0; 4], |(cx, cy)| face.get_pixel(cx, cy).0.map(f32::from));
        let card_alpha = card[3] / 255.0;
        // Beneath the plastic: the card over the back.
        let (back, back_alpha) = match plastic.back {
            Some(rgb) => (rgb.map(|c| c * cover), cover),
            None => ([0.0; 3], 0.0),
        };
        let beneath: [f32; 3] = std::array::from_fn(|c| card[c] + (1.0 - card_alpha) * back[c]);
        let beneath_alpha = card_alpha + (1.0 - card_alpha) * back_alpha;
        // The plastic: one layer over the face; over a clear sleeve's margin, both layers.
        let margin_haze =
            if plastic.back.is_some() { plastic.face_haze } else { plastic.clear_haze };
        let body = card_alpha * plastic.face_haze + (1.0 - card_alpha) * margin_haze;
        let lip = (plastic.lip - inside + 0.5).clamp(0.0, 1.0);
        let haze = (body + (plastic.lip_alpha - body) * lip) * cover;
        let shade = 1.0 + 0.06 * lip;
        let px: [f32; 3] = std::array::from_fn(|c| {
            (SLEEVE_PLASTIC[c] * shade).min(255.0) * haze + (1.0 - haze) * beneath[c]
        });
        let alpha = haze + (1.0 - haze) * beneath_alpha;
        let q = |v: f32| v.round().clamp(0.0, 255.0) as u8;
        Rgba([q(px[0]), q(px[1]), q(px[2]), q(alpha * 255.0)])
    })
}

/// How far `(px, py)` is inside a `w`×`h` rectangle with corners rounded to `r`: positive
/// inside, negative outside, in pixels.
fn inside_rounded(px: f32, py: f32, w: f32, h: f32, r: f32) -> f32 {
    let r = r.clamp(0.0, w.min(h) / 2.0);
    let cx = px.clamp(r, w - r);
    let cy = py.clamp(r, h - r);
    if cx != px && cy != py {
        r - ((px - cx).powi(2) + (py - cy).powi(2)).sqrt()
    } else {
        px.min(w - px).min(py).min(h - py)
    }
}

/// A card to put beneath when no render was given: a black border and a few bands, like the
/// tests' fixture, in colours of its own so it is never mistaken for the card above it.
fn stand_in(rng: &mut SplitMix64, (w, h): (u32, u32)) -> RgbImage {
    let border = (w as f32 * 0.045).round().max(1.0) as u32;
    let bands: Vec<(f32, [u8; 3])> = [0.10, 0.55, 0.62, 0.92, 1.01]
        .into_iter()
        .map(|until| {
            let v = rng.range(90.0, 235.0);
            let tint = [v, v * rng.range(0.7, 1.0), v * rng.range(0.6, 1.0)];
            (until, tint.map(|c| c.round() as u8))
        })
        .collect();
    RgbImage::from_fn(w, h, |x, y| {
        if x < border || y < border || x + border >= w || y + border >= h {
            return Rgb([16, 16, 18]);
        }
        let t = y as f32 / h as f32;
        let last = &bands[bands.len() - 1];
        Rgb(bands.iter().find(|(until, _)| t < *until).unwrap_or(last).1)
    })
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
    edge: GlareEdge,
}

/// How a glare falls off from its centre, in units of its own ellipse.
#[derive(Debug, Clone, Copy)]
enum GlareEdge {
    /// `exp(-2 d²)`: card stock's diffuse sheen — the only glare before scenes existed, and
    /// computed exactly as it was so the bare scene's bytes do not move.
    Soft,
    /// `exp(-k d⁴)`: a plateau with a sharp rim, which is what a lamp looks like in plastic.
    Hard(f32),
}

impl Glare {
    /// The glare's strength at squared elliptical distance `d2`, before its peak alpha.
    fn profile(&self, d2: f32) -> f32 {
        match self.edge {
            GlareEdge::Soft => (-2.0 * d2).exp(),
            GlareEdge::Hard(k) => (-k * d2 * d2).exp(),
        }
    }
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

/// The layers over the background, bottom first, the glare over all of them, then the camera's
/// gains.
///
/// **One layer computes exactly what the single-layer version did** — the background's value
/// seeds the running blend and one `l + (1 - a) · scene` step replaces it — which is what keeps
/// the bare scene's bytes where they were before a stack could put more cards down.
fn compose(
    background: &RgbImage,
    layers: &[RgbaImage],
    glare: &Glare,
    gains: [f32; 3],
) -> RgbImage {
    let (gs, gc) = glare.angle.sin_cos();
    let mut out = RgbImage::new(background.width(), background.height());
    let w = background.width();
    let raw: Vec<&[u8]> = layers.iter().map(|l| l.as_raw().as_slice()).collect();
    for (i, (o, b)) in out.pixels_mut().zip(background.pixels()).enumerate() {
        let (x, y) = ((i as u32 % w) as f32, (i as u32 / w) as f32);
        let (dx, dy) = (x - glare.x, y - glare.y);
        let u = (dx * gc + dy * gs) / glare.rx;
        let v = (-dx * gs + dy * gc) / glare.ry;
        let d2 = u * u + v * v;
        let shine = if d2 < 4.0 { glare.alpha * glare.profile(d2) } else { 0.0 };
        for ch in 0..3 {
            let mut scene = f32::from(b[ch]);
            for l in &raw {
                let l = &l[i * 4..i * 4 + 4];
                let a = f32::from(l[3]) / 255.0;
                scene = f32::from(l[ch]) + (1.0 - a) * scene;
            }
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
    use crate::detect::{detect, rectify_to, DetectOptions, Quad};
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

    /// A short burst at the small size. **The crate's own code is unoptimised in a debug
    /// `cargo test`** — only `image` and `imageproc` get `opt-level = 3` — so a 640 px frame
    /// costs about a second there (measured 2026-09-30, Windows), and a test that reads one frame
    /// should not draw twelve. Frame `k` of a short burst is frame `k` of the full one: the
    /// per-frame draws come last, in frame order.
    fn few(frames: usize) -> SynthOptions {
        SynthOptions { frames, ..small() }
    }

    /// The rectification of `quad` against the card render: the mean absolute difference, per
    /// channel value, after a per-channel least-squares gain and offset — which takes the burst's
    /// white balance, exposure and sleeve haze out, and leaves what a misplaced quad costs.
    ///
    /// `card` is compared at whatever size it is handed, and the test hands it a quarter of the
    /// render's: at 640 px a card is 90–250 px tall in the frame, so a full-size rectification
    /// only interpolates, and the per-pixel loop is what a debug build pays for.
    fn residual(frame: &RgbImage, quad: [(f32, f32); 4], card: &RgbImage) -> f32 {
        let (w, h) = card.dimensions();
        let flat = rectify_to(frame, &Quad { corners: quad }, w, h)
            .expect("a truth quad admits a homography");
        let n = (w * h) as f32;
        let mut total = 0.0;
        for ch in 0..3 {
            let pairs = || {
                flat.pixels().zip(card.pixels()).map(|(a, b)| (f32::from(b[ch]), f32::from(a[ch])))
            };
            let (mx, my) = pairs().fold((0.0, 0.0), |(sx, sy), (x, y)| (sx + x / n, sy + y / n));
            let (sxy, sxx) = pairs().fold((0.0, 0.0), |(a, b), (x, y)| {
                (a + (x - mx) * (y - my), b + (x - mx).powi(2))
            });
            let gain = if sxx > 0.0 { sxy / sxx } else { 0.0 };
            total += pairs().map(|(x, y)| (y - (my + gain * (x - mx))).abs()).sum::<f32>() / n;
        }
        total / 3.0
    }

    fn scaled(quad: [(f32, f32); 4], by: f32) -> [(f32, f32); 4] {
        let cx = quad.iter().map(|c| c.0).sum::<f32>() / 4.0;
        let cy = quad.iter().map(|c| c.1).sum::<f32>() / 4.0;
        quad.map(|(x, y)| (cx + (x - cx) * by, cy + (y - cy) * by))
    }

    /// Is `p` inside the convex quad `q`? Either winding.
    fn inside(q: &[(f32, f32); 4], p: (f32, f32)) -> bool {
        let side = |i: usize| {
            let (a, b) = (q[i], q[(i + 1) % 4]);
            (b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0)
        };
        let s: [f32; 4] = std::array::from_fn(side);
        s.iter().all(|&v| v >= 0.0) || s.iter().all(|&v| v <= 0.0)
    }

    fn decode(frame: &SynthFrame) -> RgbImage {
        image::load_from_memory(&frame.jpeg).expect("a frame decodes").to_rgb8()
    }

    /// The fixture with its bands inverted and a white border — a card beneath that no pixel of
    /// the top card could be mistaken for.
    fn other_card() -> RgbImage {
        let mut card = high_contrast_card();
        card.pixels_mut().for_each(|p| *p = Rgb(p.0.map(|v| 255 - v)));
        card
    }

    #[test]
    fn scene_names_round_trip() {
        for scene in Scene::ALL {
            assert_eq!(scene.as_str().parse::<Scene>(), Ok(scene));
        }
        assert_eq!(" Sleeved ".parse::<Scene>(), Ok(Scene::Sleeved));
        assert!("binder".parse::<Scene>().unwrap_err().contains("plain, sleeved, stacked"));
    }

    /// **The bare scene is `burst`, and every scene shares its pose** — which is what makes the
    /// three a paired comparison rather than three unrelated samples.
    #[test]
    fn every_scene_shares_the_bare_scenes_pose() {
        let card = high_contrast_card();
        let plain = burst_scene(&card, &few(3), 3, Scene::Plain, &[]);
        let jpegs: Vec<Vec<u8>> = plain.iter().map(|f| f.jpeg.clone()).collect();
        assert!(jpegs == burst(&card, &few(3), 3), "the bare scene is not what burst makes");
        for scene in [Scene::Sleeved, Scene::Stacked] {
            let other = burst_scene(&card, &few(3), 3, scene, &[]);
            assert_eq!(other.len(), plain.len());
            for (a, b) in plain.iter().zip(&other) {
                assert_eq!(a.quad, b.quad, "{scene} moved the card");
                assert!(a.jpeg != b.jpeg, "{scene} drew nothing around the card");
            }
        }
    }

    #[test]
    fn every_scene_is_deterministic() {
        let card = high_contrast_card();
        let under = other_card();
        for scene in Scene::ALL {
            for beneath in [&[][..], &[&under][..]] {
                let a = burst_scene(&card, &few(2), 5, scene, beneath);
                let b = burst_scene(&card, &few(2), 5, scene, beneath);
                assert!(
                    a.iter().zip(&b).all(|(x, y)| x.jpeg == y.jpeg && x.quad == y.quad),
                    "two {scene} bursts from the same inputs differ"
                );
            }
        }
    }

    /// **The truth quad is where the card is**: rectified from it, a frame gives back the card
    /// render, and more closely than from the same quad grown or shrunk by 2% or moved 3 px.
    ///
    /// The residual is never near zero — glare, blur up to σ 1.6, JPEG and a card as small as a
    /// quarter of a 360 px short edge all stay in it, which is also why the comparison against
    /// a perturbed quad is the half of this test that says *correct*. Measured on 2026-09-30,
    /// Windows, release, at the quarter size: the truth's residual ran 5.8–10.8 over these 36
    /// frames (three scenes, six indices, two frames each), and every perturbation was worse by
    /// 1.98 at the least (sleeved, index 0, shrunk 2%) — so a bound of 14 and a strict
    /// comparison both keep a margin. At the render's full size the same frames read 7.3–12.4,
    /// with a least gap of 2.26.
    #[test]
    fn the_truth_quad_is_where_the_card_is() {
        let card = high_contrast_card();
        let (w, h) = (card.width() / 4, card.height() / 4);
        let flat = image::imageops::resize(&card, w, h, image::imageops::FilterType::Triangle);
        for scene in Scene::ALL {
            for index in [0u64, 1, 2, 3, 5, 8] {
                let frames = burst_scene(&card, &few(2), index, scene, &[]);
                for frame in &frames {
                    let image = decode(frame);
                    let truth = residual(&image, frame.quad, &flat);
                    assert!(truth < 14.0, "{scene} #{index}: the truth's residual is {truth:.2}");
                    for (what, quad) in [
                        ("shrunk 2%", scaled(frame.quad, 0.98)),
                        ("grown 2%", scaled(frame.quad, 1.02)),
                        ("moved 3 px right", frame.quad.map(|(x, y)| (x + 3.0, y))),
                        ("moved 3 px down", frame.quad.map(|(x, y)| (x, y + 3.0))),
                    ] {
                        let off = residual(&image, quad, &flat);
                        assert!(
                            truth < off,
                            "{scene} #{index}: the quad {what} fits better ({off:.2}) than the \
                             truth ({truth:.2})"
                        );
                    }
                }
            }
        }
    }

    /// **The card beneath shows past the top card, and never through it.** Against the bare
    /// scene at the same index — the same pose and background, so the only difference is the
    /// stack — pixels just outside the truth quad change and pixels well inside it do not.
    /// Measured on 2026-09-30, Windows, release, over these twelve bursts: 25–43% of the ring
    /// changed by more than 40, and the core differed by at most 0.13 a channel on average.
    #[test]
    fn a_stack_shows_beneath_the_top_card() {
        let card = high_contrast_card();
        let under = other_card();
        for beneath in [&[][..], &[&under][..]] {
            for index in [0u64, 1, 2, 3, 5, 8] {
                let plain = burst_scene(&card, &few(1), index, Scene::Plain, &[]);
                let stacked = burst_scene(&card, &few(1), index, Scene::Stacked, beneath);
                let (a, b) = (decode(&plain[0]), decode(&stacked[0]));
                let quad = stacked[0].quad;
                let (ring, core) = (scaled(quad, 1.10), scaled(quad, 0.90));
                let (mut outside, mut changed) = (0usize, 0usize);
                let (mut core_n, mut core_diff) = (0usize, 0u64);
                for (x, y, pb) in b.enumerate_pixels() {
                    let p = (x as f32, y as f32);
                    let pa = a.get_pixel(x, y);
                    let diff = (0..3).map(|c| pa[c].abs_diff(pb[c])).max().unwrap_or(0);
                    if inside(&core, p) {
                        core_n += 1;
                        core_diff += u64::from(diff);
                    } else if inside(&ring, p) && !inside(&quad, p) {
                        outside += 1;
                        changed += usize::from(diff > 40);
                    }
                }
                let shown = changed as f32 / outside.max(1) as f32;
                let through = core_diff as f32 / core_n.max(1) as f32;
                assert!(shown > 0.05, "#{index}: only {shown:.3} of the ring beside the card changed");
                assert!(through < 2.0, "#{index}: the card beneath shows through ({through:.2})");
            }
        }
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
