//! Pixels in, model tensors out: the frame, the box-filter downscale the detector reads, and the
//! perspective sampler the embedder reads.
//!
//! Both are byte-for-byte the arithmetic of quickdraw.cards' `neural-scanner.js`
//! (`resizeToTensor`, `sampleCard`), which is what these models were replayed through to the
//! numbers in `docs/reference/card-scanner.md` §10 — so a "better" resampler here would be a
//! distribution shift, not an improvement.

use crate::Error;

/// ImageNet normalisation, the models' input convention.
pub const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
pub const STD: [f32; 3] = [0.229, 0.224, 0.225];

/// An RGB frame, 8 bits a channel, rows top to bottom.
#[derive(Clone)]
pub struct Frame {
    pub width: usize,
    pub height: usize,
    pub rgb: Vec<u8>,
}

impl Frame {
    pub fn new(width: usize, height: usize, rgb: Vec<u8>) -> Result<Self, Error> {
        if width < 32 || height < 32 || rgb.len() != width * height * 3 {
            return Err(Error::Frame(format!(
                "expected at least 32×32 RGB pixels, got {width}×{height} with {} bytes",
                rgb.len()
            )));
        }
        Ok(Self { width, height, rgb })
    }

    /// A JPEG, PNG or WebP, decoded — the command-line tools' way in.
    #[cfg(feature = "cli")]
    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        let image = image::load_from_memory(bytes).map_err(|e| Error::Frame(e.to_string()))?;
        let rgb = image.to_rgb8();
        let (w, h) = rgb.dimensions();
        Self::new(w as usize, h as usize, rgb.into_raw())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Default, serde::Serialize)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

/// A card's corners in the frame, in the card's own order: top-left, top-right, bottom-right,
/// bottom-left of the card as it reads (not as it lies).
pub type Quad = [Point; 4];

/// The same card turned half a turn.
pub fn rotate_half(q: &Quad) -> Quad {
    [q[2], q[3], q[0], q[1]]
}

pub fn centre(q: &Quad) -> Point {
    let mut c = Point::default();
    for p in q {
        c.x += p.x / 4.0;
        c.y += p.y / 4.0;
    }
    c
}

/// Signed shoelace area: positive for a quad wound clockwise on screen (y down).
pub fn area(q: &Quad) -> f32 {
    let mut a = 0.0;
    for i in 0..4 {
        let (p, n) = (q[i], q[(i + 1) % 4]);
        a += p.x * n.y - n.x * p.y;
    }
    a / 2.0
}

/// The point is inside the quad or on its edge, the quad wound either way. A quad with no area
/// contains nothing.
pub fn contains(q: &Quad, p: Point) -> bool {
    if area(q) == 0.0 {
        return false;
    }
    let (mut left, mut right) = (false, false);
    for i in 0..4 {
        let (a, b) = (q[i], q[(i + 1) % 4]);
        let side = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
        left |= side < 0.0;
        right |= side > 0.0;
    }
    !(left && right)
}

/// Strictly convex and wound clockwise.
pub fn convex(q: &Quad) -> bool {
    (0..4).all(|i| {
        let (a, b, c) = (q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
        (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) > 0.0
    })
}

/// Axis-aligned bounds `(x0, y0, x1, y1)`.
pub fn bounds(q: &Quad) -> (f32, f32, f32, f32) {
    let xs = q.iter().map(|p| p.x);
    let ys = q.iter().map(|p| p.y);
    (
        xs.clone().fold(f32::INFINITY, f32::min),
        ys.clone().fold(f32::INFINITY, f32::min),
        xs.fold(f32::NEG_INFINITY, f32::max),
        ys.fold(f32::NEG_INFINITY, f32::max),
    )
}

/// The sub-quad of a card spanning `[u0, v0, u1, v1]` of it, bilinear in the corners.
pub fn sub_quad(q: &Quad, [u0, v0, u1, v1]: [f32; 4]) -> Quad {
    let p = |u: f32, v: f32| Point {
        x: (1.0 - v) * ((1.0 - u) * q[0].x + u * q[1].x) + v * ((1.0 - u) * q[3].x + u * q[2].x),
        y: (1.0 - v) * ((1.0 - u) * q[0].y + u * q[1].y) + v * ((1.0 - u) * q[3].y + u * q[2].y),
    };
    [p(u0, v0), p(u1, v0), p(u1, v1), p(u0, v1)]
}

/// Intersection over union of two quads' bounds.
pub fn bounds_iou(a: &Quad, b: &Quad) -> f32 {
    let (ax0, ay0, ax1, ay1) = bounds(a);
    let (bx0, by0, bx1, by1) = bounds(b);
    let iw = (ax1.min(bx1) - ax0.max(bx0)).max(0.0);
    let ih = (ay1.min(by1) - ay0.max(by0)).max(0.0);
    let inter = iw * ih;
    let union = (ax1 - ax0) * (ay1 - ay0) + (bx1 - bx0) * (by1 - by0) - inter;
    if union > 0.0 {
        inter / union
    } else {
        0.0
    }
}

/// A region of the frame, in frame pixels. May reach outside the frame: the edge repeats.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// Box-filter downscale of `rect` into a normalised CHW tensor of `ow × oh` (`out` holds
/// `3 * ow * oh`). Each output pixel is the plain mean of the source pixels under it.
pub fn resize_to_tensor(frame: &Frame, rect: Rect, ow: usize, oh: usize, out: &mut [f32]) {
    assert_eq!(out.len(), 3 * ow * oh, "tensor slot is the wrong size");
    let (w, h) = (frame.width as i64, frame.height as i64);
    let (sx, sy) = (rect.w / ow as f32, rect.h / oh as f32);
    let plane = ow * oh;
    let mut x0 = vec![0usize; ow];
    let mut x1 = vec![0usize; ow];
    for x in 0..ow {
        let a = ((rect.x + x as f32 * sx).floor() as i64).clamp(0, w - 1);
        let b = ((rect.x + (x + 1) as f32 * sx).floor() as i64)
            .min(w)
            .max(a + 1);
        x0[x] = a as usize;
        x1[x] = b as usize;
    }
    let mut row = vec![0u32; frame.width * 3];
    for y in 0..oh {
        let ya = ((rect.y + y as f32 * sy).floor() as i64).clamp(0, h - 1);
        let yb = ((rect.y + (y + 1) as f32 * sy).floor() as i64)
            .min(h)
            .max(ya + 1);
        row.iter_mut().for_each(|v| *v = 0);
        for yy in ya..yb {
            let src =
                &frame.rgb[yy as usize * frame.width * 3..(yy as usize + 1) * frame.width * 3];
            for (acc, &v) in row.iter_mut().zip(src) {
                *acc += v as u32;
            }
        }
        for x in 0..ow {
            let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
            for xx in x0[x]..x1[x] {
                r += row[xx * 3];
                g += row[xx * 3 + 1];
                b += row[xx * 3 + 2];
            }
            let n = 255.0 * (yb - ya) as f32 * (x1[x] - x0[x]) as f32;
            let o = y * ow + x;
            out[o] = (r as f32 / n - MEAN[0]) / STD[0];
            out[plane + o] = (g as f32 / n - MEAN[1]) / STD[1];
            out[2 * plane + o] = (b as f32 / n - MEAN[2]) / STD[2];
        }
    }
}

/// The homography taking `src[i]` to `dst[i]`, row-major with `h[8] = 1`. `None` when the
/// points are degenerate.
pub fn solve_homography(src: [[f64; 2]; 4], dst: [[f64; 2]; 4]) -> Option<[f64; 9]> {
    let mut a = [[0f64; 8]; 8];
    let mut b = [0f64; 8];
    for i in 0..4 {
        let ([x, y], [u, v]) = (src[i], dst[i]);
        a[2 * i] = [x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y];
        b[2 * i] = u;
        a[2 * i + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y];
        b[2 * i + 1] = v;
    }
    // Gauss–Jordan with partial pivoting.
    for c in 0..8 {
        let p = (c..8).max_by(|&i, &j| a[i][c].abs().total_cmp(&a[j][c].abs()))?;
        a.swap(c, p);
        b.swap(c, p);
        let d = a[c][c];
        if d.abs() < 1e-12 {
            return None;
        }
        for r in 0..8 {
            if r == c {
                continue;
            }
            let f = a[r][c] / d;
            if f == 0.0 {
                continue;
            }
            for k in c..8 {
                a[r][k] -= f * a[c][k];
            }
            b[r] -= f * b[c];
        }
    }
    let mut h = [0f64; 9];
    for i in 0..8 {
        h[i] = b[i] / a[i][i];
    }
    h[8] = 1.0;
    Some(h)
}

/// Perspective-sample the part `crop = [u0, v0, u1, v1]` of a card (in the card's unit square)
/// into slot `out` (`3 * ow * oh`, normalised CHW), 2×2 supersampled and bilinear. `view`, when
/// given, receives the same pixels as RGB bytes. False when the quad is degenerate.
pub fn sample_card(
    frame: &Frame,
    quad: &Quad,
    crop: [f32; 4],
    ow: usize,
    oh: usize,
    out: &mut [f32],
    mut view: Option<&mut Vec<u8>>,
) -> bool {
    assert_eq!(out.len(), 3 * ow * oh, "tensor slot is the wrong size");
    let unit = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
    let dst = quad.map(|p| [p.x as f64, p.y as f64]);
    let Some(h) = solve_homography(unit, dst) else {
        return false;
    };
    let [bx0, by0, bx1, by1] = crop.map(|v| v as f64);
    let (du, dv) = ((bx1 - bx0) / ow as f64, (by1 - by0) / oh as f64);
    let (wm, hm) = (frame.width as i64 - 1, frame.height as i64 - 1);
    let plane = ow * oh;
    if let Some(v) = view.as_deref_mut() {
        v.clear();
        v.resize(ow * oh * 3, 0);
    }
    let px = |x: i64, y: i64| {
        let i = (y.clamp(0, hm) as usize * frame.width + x.clamp(0, wm) as usize) * 3;
        [
            frame.rgb[i] as f64,
            frame.rgb[i + 1] as f64,
            frame.rgb[i + 2] as f64,
        ]
    };
    for y in 0..oh {
        for x in 0..ow {
            let mut acc = [0f64; 3];
            for sy in 0..2 {
                let v = by0 + dv * (y as f64 + 0.25 + 0.5 * sy as f64);
                for sx in 0..2 {
                    let u = bx0 + du * (x as f64 + 0.25 + 0.5 * sx as f64);
                    let w = h[6] * u + h[7] * v + h[8];
                    let fx = (h[0] * u + h[1] * v + h[2]) / w - 0.5;
                    let fy = (h[3] * u + h[4] * v + h[5]) / w - 0.5;
                    let (ix, iy) = (fx.floor() as i64, fy.floor() as i64);
                    let (tx, ty) = (fx - ix as f64, fy - iy as f64);
                    let (p00, p10, p01, p11) = (
                        px(ix, iy),
                        px(ix + 1, iy),
                        px(ix, iy + 1),
                        px(ix + 1, iy + 1),
                    );
                    for c in 0..3 {
                        acc[c] += p00[c] * (1.0 - tx) * (1.0 - ty)
                            + p10[c] * tx * (1.0 - ty)
                            + p01[c] * (1.0 - tx) * ty
                            + p11[c] * tx * ty;
                    }
                }
            }
            let o = y * ow + x;
            for c in 0..3 {
                let mean = acc[c] / 4.0;
                out[c * plane + o] = ((mean / 255.0) as f32 - MEAN[c]) / STD[c];
                if let Some(v) = view.as_deref_mut() {
                    v[o * 3 + c] = mean.round().clamp(0.0, 255.0) as u8;
                }
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(w: usize, h: usize, rgb: [u8; 3]) -> Frame {
        Frame::new(w, h, rgb.repeat(w * h)).unwrap()
    }

    #[test]
    fn a_quad_contains_a_point_either_way_wound_and_nothing_without_area() {
        let p = |x: f32, y: f32| Point { x, y };
        // A tilted card, clockwise on screen, and the same corners anticlockwise.
        let q = [p(20.0, 10.0), p(60.0, 20.0), p(50.0, 70.0), p(10.0, 60.0)];
        let back = [q[3], q[2], q[1], q[0]];
        for quad in [q, back] {
            assert!(contains(&quad, p(35.0, 40.0)));
            assert!(contains(&quad, p(20.0, 10.0)), "a corner is on the edge");
            assert!(
                !contains(&quad, p(15.0, 12.0)),
                "outside the tilted top edge"
            );
            assert!(!contains(&quad, p(70.0, 40.0)));
        }
        assert!(!contains(&[p(5.0, 5.0); 4], p(5.0, 5.0)));
    }

    #[test]
    fn a_flat_frame_downscales_to_its_own_normalised_colour() {
        let f = flat(97, 61, [255, 128, 0]);
        let mut out = vec![0.0; 3 * 10 * 7];
        resize_to_tensor(
            &f,
            Rect {
                x: 0.0,
                y: 0.0,
                w: 97.0,
                h: 61.0,
            },
            10,
            7,
            &mut out,
        );
        let want = [
            (1.0 - MEAN[0]) / STD[0],
            (128.0 / 255.0 - MEAN[1]) / STD[1],
            (0.0 - MEAN[2]) / STD[2],
        ];
        for c in 0..3 {
            for v in &out[c * 70..(c + 1) * 70] {
                assert!((v - want[c]).abs() < 1e-5, "{v} against {}", want[c]);
            }
        }
    }

    #[test]
    fn a_rect_past_the_frame_repeats_the_edge() {
        // Left half black, right half white; a rect reaching past the right edge reads white there.
        let mut rgb = vec![0u8; 40 * 40 * 3];
        for y in 0..40 {
            for x in 20..40 {
                rgb[(y * 40 + x) * 3..(y * 40 + x) * 3 + 3].copy_from_slice(&[255, 255, 255]);
            }
        }
        let f = Frame::new(40, 40, rgb).unwrap();
        let mut out = vec![0.0; 3 * 4 * 4];
        resize_to_tensor(
            &f,
            Rect {
                x: 30.0,
                y: 0.0,
                w: 40.0,
                h: 40.0,
            },
            4,
            4,
            &mut out,
        );
        let white = (1.0 - MEAN[0]) / STD[0];
        assert!(out[..16].iter().all(|v| (v - white).abs() < 1e-5));
    }

    #[test]
    fn the_homography_maps_the_unit_square_onto_its_quad() {
        let quad = [[10.0, 20.0], [110.0, 25.0], [105.0, 160.0], [5.0, 150.0]];
        let unit = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        let h = solve_homography(unit, quad).unwrap();
        for (u, q) in unit.iter().zip(quad) {
            let w = h[6] * u[0] + h[7] * u[1] + h[8];
            let x = (h[0] * u[0] + h[1] * u[1] + h[2]) / w;
            let y = (h[3] * u[0] + h[4] * u[1] + h[5]) / w;
            assert!((x - q[0]).abs() < 1e-9 && (y - q[1]).abs() < 1e-9);
        }
        assert!(solve_homography(unit, [[0.0, 0.0]; 4]).is_none());
    }

    #[test]
    fn sampling_an_upright_card_reads_its_pixels_and_a_half_turn_reads_them_backwards() {
        // A 64×64 frame whose top half is red and bottom half blue; the "card" is the whole frame.
        let mut rgb = vec![0u8; 64 * 64 * 3];
        for y in 0..64 {
            for x in 0..64 {
                let c = if y < 32 { [255, 0, 0] } else { [0, 0, 255] };
                rgb[(y * 64 + x) * 3..(y * 64 + x) * 3 + 3].copy_from_slice(&c);
            }
        }
        let f = Frame::new(64, 64, rgb).unwrap();
        let p = |x: f32, y: f32| Point { x, y };
        let quad = [p(0.0, 0.0), p(64.0, 0.0), p(64.0, 64.0), p(0.0, 64.0)];
        let mut out = vec![0.0; 3 * 8 * 8];
        let mut view = Vec::new();
        assert!(sample_card(
            &f,
            &quad,
            [0.0, 0.0, 1.0, 1.0],
            8,
            8,
            &mut out,
            Some(&mut view)
        ));
        assert_eq!(&view[..3], &[255, 0, 0]);
        assert_eq!(&view[view.len() - 3..], &[0, 0, 255]);
        assert!(sample_card(
            &f,
            &rotate_half(&quad),
            [0.0, 0.0, 1.0, 1.0],
            8,
            8,
            &mut out,
            Some(&mut view)
        ));
        assert_eq!(&view[..3], &[0, 0, 255]);
    }

    #[test]
    fn quad_geometry() {
        let p = |x: f32, y: f32| Point { x, y };
        let cw = [p(0.0, 0.0), p(10.0, 0.0), p(10.0, 20.0), p(0.0, 20.0)];
        assert!(convex(&cw));
        assert_eq!(area(&cw), 200.0);
        let ccw = [cw[0], cw[3], cw[2], cw[1]];
        assert!(!convex(&ccw));
        assert!(area(&ccw) < 0.0);
        assert_eq!(centre(&cw), p(5.0, 10.0));
        assert_eq!(sub_quad(&cw, [0.5, 0.5, 1.0, 1.0])[0], p(5.0, 10.0));
        assert!((bounds_iou(&cw, &cw) - 1.0).abs() < 1e-6);
    }
}
