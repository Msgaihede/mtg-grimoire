//! The card finder: one small CNN that names every card's four corners in a downscaled frame.
//!
//! **What the network answers** (read from the ONNX graph and `neural-scanner.js`): a
//! `[1, 10, gh, gw]` map at stride 8 of its input. Channel 0 is a "a card is centred in this
//! cell" logit; channels 1–8 are the four corners as offsets from the cell centre, `(x, y)` per
//! corner in units of `corner_norm` input pixels; channel 9 is the orientation: a logit for
//! "these four corners start half a turn round from the card's own top-left". (Ours breaks the
//! raw order at −45° and 135°, so a card turned sideways is never ambiguous; only the decode
//! below has to agree with a model's.) A card is a 3×3 local maximum of channel 0 —
//! CenterNet-style, no anchors and no
//! non-maximum suppression over boxes. Overlapping cards, sleeves and fingers are the training
//! data's problem, not a contour pass's.
//!
//! **Two passes**: the whole frame, then each card again on a box 1.45× its size, which roughly
//! halves the corner error (the network sees the card at about its training scale).

use crate::frame::{
    area, bounds, centre, convex, resize_to_tensor, rotate_half, Frame, Point, Quad, Rect,
};
use crate::meta::DetectorMeta;
use crate::Error;
use rten::{Model, NodeId};
use rten_tensor::{AsView, Layout, NdTensorView, Tensor};

/// One card found.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Detection {
    /// Sigmoid of the centre logit.
    pub score: f32,
    /// Corners in frame pixels, in the card's own order (turned half a turn when `flip` says).
    pub quad: Quad,
    /// Probability the network's raw corners had to be turned half a turn. Near 0.5 the
    /// orientation is unsure, and the card is searched both ways up.
    pub flip: f32,
}

/// Quads smaller than this many square pixels are noise.
const MIN_AREA: f32 = 600.0;
/// The refine pass's box, as a multiple of the first pass's card.
const REFINE_GROW: f32 = 1.45;

/// Decode one map. `maps` is `[10, gh, gw]` (batch dropped); `rect` is the frame region the
/// input covered and `(iw, ih)` the input size, so corners come back in frame pixels.
pub fn decode(
    maps: &[f32],
    (gh, gw): (usize, usize),
    rect: Rect,
    (iw, ih): (usize, usize),
    meta: &DetectorMeta,
    det_logit: f32,
) -> Vec<Detection> {
    let plane = gh * gw;
    assert!(maps.len() >= 10 * plane, "a detector map has ten channels");
    let (sx, sy) = (rect.w / iw as f32, rect.h / ih as f32);
    let sig = |v: f32| 1.0 / (1.0 + (-v).exp());
    let mut out = Vec::new();
    for y in 0..gh {
        for x in 0..gw {
            let v = maps[y * gw + x];
            if v < det_logit {
                continue;
            }
            let peak = (-1i64..=1).all(|dy| {
                (-1i64..=1).all(|dx| {
                    let (yy, xx) = (y as i64 + dy, x as i64 + dx);
                    (dx == 0 && dy == 0)
                        || yy < 0
                        || xx < 0
                        || yy >= gh as i64
                        || xx >= gw as i64
                        || maps[yy as usize * gw + xx as usize] <= v
                })
            });
            if !peak {
                continue;
            }
            let cell = y * gw + x;
            let mut quad = [Point::default(); 4];
            for (k, corner) in quad.iter_mut().enumerate() {
                let ox = maps[(1 + 2 * k) * plane + cell] * meta.corner_norm
                    + (x as f32 + 0.5) * meta.stride;
                let oy = maps[(2 + 2 * k) * plane + cell] * meta.corner_norm
                    + (y as f32 + 0.5) * meta.stride;
                *corner = Point {
                    x: rect.x + ox * sx,
                    y: rect.y + oy * sy,
                };
            }
            let flip = sig(maps[9 * plane + cell]);
            out.push(Detection {
                score: sig(v),
                quad: if flip > 0.5 { rotate_half(&quad) } else { quad },
                flip,
            });
        }
    }
    out.sort_by(|a, b| b.score.total_cmp(&a.score));
    out
}

/// The detection nearest `(cx, cy)` among `near`, if it is within `limit` pixels.
fn nearest(near: Vec<Detection>, cx: f32, cy: f32, limit: f32) -> Option<Detection> {
    near.into_iter()
        .map(|d| {
            let c = centre(&d.quad);
            ((c.x - cx).hypot(c.y - cy), d)
        })
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .filter(|(dist, _)| *dist < limit)
        .map(|(_, d)| d)
}

/// The box around a card, grown by `grow` and shaped to the input's aspect.
fn box_around(q: &Quad, grow: f32, iw: usize, ih: usize) -> Rect {
    let (x0, y0, x1, y1) = bounds(q);
    let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
    let (mut w, mut h) = ((x1 - x0) * grow, (y1 - y0) * grow);
    let aspect = iw as f32 / ih as f32;
    if w / h > aspect {
        h = w / aspect;
    } else {
        w = h * aspect;
    }
    Rect {
        x: cx - w / 2.0,
        y: cy - h / 2.0,
        w,
        h,
    }
}

pub struct Detector {
    model: Model,
    input: NodeId,
    output: NodeId,
    pub meta: DetectorMeta,
    det_logit: f32,
    buf: Vec<f32>,
    /// Model runs since the last `take_runs`.
    runs: usize,
}

impl Detector {
    pub fn load(bytes: Vec<u8>, meta: DetectorMeta, det_logit: f32) -> Result<Self, Error> {
        let model = Model::load(bytes).map_err(|e| Error::Model(format!("detector: {e}")))?;
        let input = model
            .node_id("image")
            .map_err(|e| Error::Model(format!("detector input: {e}")))?;
        let output = model
            .node_id("maps")
            .map_err(|e| Error::Model(format!("detector output: {e}")))?;
        Ok(Self {
            model,
            input,
            output,
            meta,
            det_logit,
            buf: Vec::new(),
            runs: 0,
        })
    }

    /// Move the candidate floor: the meta's `detLogit`, copied in at load, when a caller
    /// overrides the thresholds ([`crate::scanner::Recognizer::set_thresholds`]).
    pub fn set_det_logit(&mut self, det_logit: f32) {
        self.det_logit = det_logit;
    }

    pub fn take_runs(&mut self) -> usize {
        std::mem::take(&mut self.runs)
    }

    /// The input size for a frame: the meta's portrait size, swapped for a landscape frame.
    pub fn input_size(&self, frame: &Frame) -> (usize, usize) {
        if frame.height >= frame.width {
            (self.meta.width, self.meta.height)
        } else {
            (self.meta.height, self.meta.width)
        }
    }

    /// One pass over `rect` of the frame at input size `iw × ih`.
    pub fn run(
        &mut self,
        frame: &Frame,
        rect: Rect,
        iw: usize,
        ih: usize,
    ) -> Result<Vec<Detection>, Error> {
        self.buf.resize(3 * iw * ih, 0.0);
        resize_to_tensor(frame, rect, iw, ih, &mut self.buf);
        let input = NdTensorView::from_data([1, 3, ih, iw], self.buf.as_slice());
        let [maps] = self
            .model
            .run_n(vec![(self.input, input.into())], [self.output], None)
            .map_err(|e| Error::Model(format!("detector run: {e}")))?;
        self.runs += 1;
        let maps: Tensor<f32> = maps
            .try_into()
            .map_err(|e| Error::Model(format!("detector output: {e:?}")))?;
        let shape = maps.shape().to_vec();
        if shape.len() != 4 || shape[1] != 10 {
            return Err(Error::Model(format!("detector map has shape {shape:?}")));
        }
        let data = maps.to_vec();
        Ok(decode(
            &data,
            (shape[2], shape[3]),
            rect,
            (iw, ih),
            &self.meta,
            self.det_logit,
        ))
    }

    /// Every card in the frame, best first, at most `max_cards`; with `refine`, each looked at
    /// again on a zoomed box.
    pub fn detect(
        &mut self,
        frame: &Frame,
        refine: bool,
        max_cards: usize,
    ) -> Result<Vec<Detection>, Error> {
        let (iw, ih) = self.input_size(frame);
        let whole = Rect {
            x: 0.0,
            y: 0.0,
            w: frame.width as f32,
            h: frame.height as f32,
        };
        let dets: Vec<Detection> = self
            .run(frame, whole, iw, ih)?
            .into_iter()
            .filter(|d| convex(&d.quad) && area(&d.quad) > MIN_AREA)
            .take(max_cards)
            .collect();
        if !refine {
            return Ok(dets);
        }
        let mut refined = Vec::with_capacity(dets.len());
        for det in dets {
            let rect = box_around(&det.quad, REFINE_GROW, iw, ih);
            if rect.w >= frame.width as f32 * 0.8 && rect.h >= frame.height as f32 * 0.8 {
                refined.push(det);
                continue;
            }
            let near: Vec<Detection> = self
                .run(frame, rect, iw, ih)?
                .into_iter()
                .filter(|d| convex(&d.quad))
                .collect();
            let (cx, cy) = (rect.x + rect.w / 2.0, rect.y + rect.h / 2.0);
            refined.push(match nearest(near, cx, cy, rect.w.min(rect.h) * 0.25) {
                Some(best) => Detection {
                    score: best.score.max(det.score),
                    ..best
                },
                None => det,
            });
        }
        Ok(refined)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> DetectorMeta {
        DetectorMeta {
            width: 192,
            height: 320,
            stride: 8.0,
            corner_norm: 64.0,
        }
    }

    /// A 10-channel map with one peak at `(px, py)` whose corners sit ±`half` input pixels
    /// around the cell centre, and the given flip logit.
    fn map_with_peak(
        gh: usize,
        gw: usize,
        px: usize,
        py: usize,
        half: f32,
        flip_logit: f32,
    ) -> Vec<f32> {
        let plane = gh * gw;
        let mut m = vec![-5.0f32; 10 * plane];
        for v in &mut m[plane..9 * plane] {
            *v = 0.0;
        }
        let cell = py * gw + px;
        m[cell] = 3.0;
        m[py * gw + px + 1] = 1.0; // a shoulder, not a peak
        let off = [(-half, -half), (half, -half), (half, half), (-half, half)];
        for (k, (ox, oy)) in off.iter().enumerate() {
            m[(1 + 2 * k) * plane + cell] = ox / 64.0;
            m[(2 + 2 * k) * plane + cell] = oy / 64.0;
        }
        m[9 * plane + cell] = flip_logit;
        m
    }

    #[test]
    fn a_peak_decodes_to_its_corners_in_frame_pixels() {
        // Input 192×320 covering a 384×640 frame: every input pixel is two frame pixels.
        let m = map_with_peak(40, 24, 10, 20, 32.0, -4.0);
        let rect = Rect {
            x: 0.0,
            y: 0.0,
            w: 384.0,
            h: 640.0,
        };
        let d = decode(&m, (40, 24), rect, (192, 320), &meta(), -1.0);
        assert_eq!(
            d.len(),
            1,
            "the shoulder beside the peak is not a second card"
        );
        let c = (10.5 * 8.0 * 2.0, 20.5 * 8.0 * 2.0);
        assert!((d[0].quad[0].x - (c.0 - 64.0)).abs() < 1e-3);
        assert!((d[0].quad[0].y - (c.1 - 64.0)).abs() < 1e-3);
        assert!((d[0].quad[2].x - (c.0 + 64.0)).abs() < 1e-3);
        assert!(d[0].score > 0.95 && d[0].flip < 0.05);
    }

    #[test]
    fn an_upside_down_card_comes_back_upright() {
        let m = map_with_peak(40, 24, 10, 20, 32.0, 4.0);
        let rect = Rect {
            x: 0.0,
            y: 0.0,
            w: 192.0,
            h: 320.0,
        };
        let d = decode(&m, (40, 24), rect, (192, 320), &meta(), -1.0);
        // The card's top-left is the frame's bottom-right corner.
        let c = (10.5 * 8.0, 20.5 * 8.0);
        assert!((d[0].quad[0].x - (c.0 + 32.0)).abs() < 1e-3);
        assert!((d[0].quad[0].y - (c.1 + 32.0)).abs() < 1e-3);
    }

    #[test]
    fn cells_under_the_logit_floor_are_not_cards() {
        let m = map_with_peak(40, 24, 10, 20, 32.0, -4.0);
        let rect = Rect {
            x: 0.0,
            y: 0.0,
            w: 192.0,
            h: 320.0,
        };
        assert!(decode(&m, (40, 24), rect, (192, 320), &meta(), 3.5).is_empty());
    }

    #[test]
    fn the_refine_box_keeps_the_input_aspect() {
        let p = |x: f32, y: f32| Point { x, y };
        let r = box_around(
            &[
                p(100.0, 100.0),
                p(200.0, 100.0),
                p(200.0, 140.0),
                p(100.0, 140.0),
            ],
            1.45,
            192,
            320,
        );
        assert!((r.w / r.h - 192.0 / 320.0).abs() < 1e-4);
        assert!((r.x + r.w / 2.0 - 150.0).abs() < 1e-3);
    }
}
