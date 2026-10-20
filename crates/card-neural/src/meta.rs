//! `models/neural.json`: what the two networks take in, how the detector's map decodes, and the
//! thresholds and ranking a frame is judged by.
//!
//! **Data, not code, because it belongs to the weights**: a retrained pair comes with its own
//! thresholds, and the file travels with the models it was tuned for. The shape is the spike's
//! `neural.meta.json` (quickdraw.cards' `DLNEURAL1`) without the file names, which here are
//! fixed ([`crate::DETECTOR_FILE`] and the rest).

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub detector: DetectorMeta,
    pub embedder: EmbedderMeta,
    /// Cards fingerprinted per frame, best detections first.
    #[serde(default = "three")]
    pub max_cards: usize,
    pub thresholds: Thresholds,
    /// Run the zoomed second detector pass.
    #[serde(default = "yes")]
    pub refine: bool,
    /// Which of a frame's cards it votes for.
    pub ranking: Ranking,
}

fn three() -> usize {
    3
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorMeta {
    /// Portrait input size; a landscape frame swaps the two.
    pub width: usize,
    pub height: usize,
    /// Pixels of input per output cell.
    pub stride: f32,
    /// Corner offsets are in units of this many input pixels.
    pub corner_norm: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedderMeta {
    pub width: usize,
    pub height: usize,
    /// The part of the card the embedder reads, `[u0, v0, u1, v1]` of its unit square.
    #[serde(rename = "box")]
    pub crop: [f32; 4],
    pub max_batch: usize,
    pub dim: usize,
    /// Gallery entries kept per search.
    pub topk: usize,
}

/// Cosine scores and detector probabilities; none is a calibrated probability.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thresholds {
    /// Detector cells below this logit are not candidates.
    pub det_logit: f32,
    pub det_accept: f32,
    pub det_instant: f32,
    /// Best cosine score, and its lead over the best other card, for an accepted frame.
    pub accept: f32,
    pub margin: f32,
    /// An accepted frame this sure decides alone.
    pub instant: f32,
    pub instant_margin: f32,
    /// Below accept: lets a frame keep earlier evidence rather than reset it.
    pub weak: f32,
    pub weak_margin: f32,
    /// Just under accept on a confident detection: counts toward a three-frame agreement.
    pub support: f32,
    pub support_margin: f32,
    pub det_support: f32,
    /// A predicted orientation this far from 0.5 is trusted; nearer, both are searched.
    pub flip_sure: f32,
}

/// How a frame's cards are ordered, the first being the one the frame votes for. Prominence is
/// a card's size over its distance from the target point (both as fractions of the frame, the
/// distance plus 0.25).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Ranking {
    /// Quickdraw's: prominence, doubled for a card that clears the accept bar. A recognised
    /// neighbour can outrank an unrecognised card in the middle of the frame — on a binder page,
    /// the two wrong calls of the spike's replay.
    Quickdraw,
    /// The card under the target point first, recognised or not; Quickdraw's order among the
    /// cards that cover it, and when none does. What `models/neural.json` ships.
    #[default]
    Aimed,
}

impl Meta {
    pub fn from_json(bytes: &[u8]) -> Result<Self, crate::Error> {
        serde_json::from_slice(bytes).map_err(|e| crate::Error::Meta(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_file_reads_and_names_the_aimed_ranking() {
        let m = Meta::from_json(include_bytes!("../models/neural.json")).unwrap();
        assert_eq!(m.ranking, Ranking::Aimed);
        assert_eq!((m.detector.width, m.detector.height), (192, 320));
        assert_eq!((m.embedder.width, m.embedder.dim), (128, 128));
        assert_eq!(m.embedder.crop, [0.03, 0.02, 0.97, 0.72]);
        assert!(m.refine && m.max_cards == 3);
        // The cross-validated choice (reference doc §4.3): Quickdraw's score bars 0.025 lower,
        // its margins at 0.375 of theirs.
        assert_eq!(m.thresholds.accept, 0.575);
        assert_eq!(m.thresholds.margin, 0.045);
    }

    #[test]
    fn a_file_without_a_ranking_is_refused() {
        let text = String::from_utf8(include_bytes!("../models/neural.json").to_vec()).unwrap();
        let mut v: serde_json::Value = serde_json::from_str(&text).unwrap();
        v.as_object_mut().unwrap().remove("ranking");
        assert!(Meta::from_json(v.to_string().as_bytes()).is_err());
        assert!(Meta::from_json(b"{}").is_err());
    }
}
