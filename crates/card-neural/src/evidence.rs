//! The printing evidence: two small crop networks, a gallery for each, and a printing's score
//! against what a card's frames showed.
//!
//! The whole-card embedder cannot tell reprints apart (the art is shared, [`crate::gallery`]),
//! so two more networks read the two small places that can: the **set symbol** and the
//! **collector band** (number, rarity, set code, language). Each answers a unit vector like the
//! embedder, and each has a [`Gallery`] of its own, keyed by **printing** rather than by look:
//!
//! - **bands** — one entry per printing face: `printing` is that printing and `covers` holds
//!   only it. A printing has one band a face, so a printing in two band rows of one face is a
//!   build error this index refuses.
//! - **symbols** — one entry per symbol class: `covers` is every printing showing that symbol
//!   (a set's common and uncommon symbols are classes of their own), `face` front. A printing
//!   shows one symbol, so a printing in several symbol rows is also refused.
//!
//! `card` is 0 and `name` a debugging label in both: the galleries are searched by printing, not
//! by card. [`EvidenceIndex`] holds the galleries and the printing index and nothing else, so
//! the scoring is testable with galleries built by hand; [`EvidenceNets`] holds the networks;
//! [`Evidence`] is both, loaded from the four files.

use crate::embed::Embedder;
use crate::frame::{sample_card, Frame, Quad};
use crate::gallery::{Face, Gallery, Id};
use crate::meta::{CropMeta, EvidenceThresholds, Meta};
use crate::Error;
use std::borrow::Cow;
use std::collections::HashMap;

pub const SYMBOL_NET_FILE: &str = "symbol.onnx";
pub const BAND_NET_FILE: &str = "band.onnx";
pub const SYMBOLS_FILE: &str = "symbols.bin";
pub const BANDS_FILE: &str = "bands.bin";

/// The four files [`Evidence`] is made of; borrowed or owned as [`crate::Files`] are.
#[derive(Clone, Debug)]
pub struct EvidenceFiles<'a> {
    pub symbol_net: Cow<'a, [u8]>,
    pub band_net: Cow<'a, [u8]>,
    pub symbols: Cow<'a, [u8]>,
    pub bands: Cow<'a, [u8]>,
}

/// The files in a directory laid out as `models/` is — what the command-line tools read.
#[cfg(feature = "cli")]
pub fn read_dir_evidence(dir: &std::path::Path) -> std::io::Result<EvidenceFiles<'static>> {
    let read = |name: &str| std::fs::read(dir.join(name)).map(Cow::Owned);
    Ok(EvidenceFiles {
        symbol_net: read(SYMBOL_NET_FILE)?,
        band_net: read(BAND_NET_FILE)?,
        symbols: read(SYMBOLS_FILE)?,
        bands: read(BANDS_FILE)?,
    })
}

/// Both crops of one card on one frame, embedded.
#[derive(Clone, Debug)]
pub struct Glance {
    pub symbol: Vec<f32>,
    pub band: Vec<f32>,
}

/// The galleries and their printing index — no networks, so the scoring is testable alone.
pub struct EvidenceIndex {
    symbols: Gallery,
    bands: Gallery,
    /// A printing's one symbol row.
    symbol_row: HashMap<Id, u32>,
    /// A printing's band row on a face (`true` for the back).
    band_row: HashMap<(Id, bool), u32>,
}

impl EvidenceIndex {
    /// Index the galleries by printing. An error (`Error::Gallery`) when a printing is in two
    /// band rows of one face, or in two symbol rows: either gallery was built wrong, and a
    /// score from whichever row came first would be a guess.
    pub fn new(symbols: Gallery, bands: Gallery) -> Result<EvidenceIndex, Error> {
        let mut symbol_row = HashMap::new();
        for e in 0..symbols.len() as u32 {
            for printing in symbols.covers(e) {
                if let Some(first) = symbol_row.insert(*printing, e) {
                    return Err(Error::Gallery(format!(
                        "a printing is in two symbol rows, {:?} and {:?}",
                        symbols.name(first),
                        symbols.name(e)
                    )));
                }
            }
        }
        let mut band_row = HashMap::new();
        for e in 0..bands.len() as u32 {
            let back = bands.face(e) == Face::Back;
            for printing in bands.covers(e) {
                if let Some(first) = band_row.insert((*printing, back), e) {
                    return Err(Error::Gallery(format!(
                        "a printing is in two band rows of one face, {:?} and {:?}",
                        bands.name(first),
                        bands.name(e)
                    )));
                }
            }
        }
        Ok(EvidenceIndex {
            symbols,
            bands,
            symbol_row,
            band_row,
        })
    }

    /// Mean cosine over the glances, against the printing's symbol row; `None` when it has none.
    pub fn symbol(&self, glances: &[Glance], printing: &Id) -> Option<f32> {
        let row = *self.symbol_row.get(printing)?;
        mean_cosine(
            &self.symbols,
            row,
            glances.iter().map(|g| g.symbol.as_slice()),
        )
    }

    /// The same against the printing's band row **of this face**; `None` when it has none.
    pub fn band(&self, glances: &[Glance], printing: &Id, face: Face) -> Option<f32> {
        let row = *self.band_row.get(&(*printing, face == Face::Back))?;
        mean_cosine(&self.bands, row, glances.iter().map(|g| g.band.as_slice()))
    }
}

/// The mean of one row's cosine against each query; `None` for no queries, or for one of
/// another width than the gallery's (a glance from other networks than these galleries).
fn mean_cosine<'a>(
    gallery: &Gallery,
    row: u32,
    queries: impl ExactSizeIterator<Item = &'a [f32]>,
) -> Option<f32> {
    let n = queries.len();
    let mut sum = 0.0;
    for q in queries {
        if q.len() != gallery.dim() {
            return None;
        }
        sum += gallery.score(row, q);
    }
    (n > 0).then(|| sum / n as f32)
}

/// The two crop networks.
pub struct EvidenceNets {
    symbol: Embedder,
    band: Embedder,
    symbol_crop: CropMeta,
    band_crop: CropMeta,
    symbol_buf: Vec<f32>,
    band_buf: Vec<f32>,
}

impl EvidenceNets {
    /// Cut both crops through `quad` (the winning view's, already turned) and embed them.
    pub fn glance(&mut self, frame: &Frame, quad: &Quad) -> Result<Glance, Error> {
        let embed = |net: &Embedder, crop: &CropMeta, buf: &mut [f32]| {
            if !sample_card(frame, quad, crop.crop, crop.width, crop.height, buf, None) {
                return Err(Error::Frame("the card's corners are degenerate".into()));
            }
            net.run(buf, 1)
        };
        Ok(Glance {
            symbol: embed(&self.symbol, &self.symbol_crop, &mut self.symbol_buf)?,
            band: embed(&self.band, &self.band_crop, &mut self.band_buf)?,
        })
    }
}

/// Everything the files make, in parts: the scanner keeps the index and thresholds apart from
/// the networks, so its decision logic is testable with galleries built by hand.
pub struct Evidence {
    pub nets: EvidenceNets,
    pub index: EvidenceIndex,
    pub thresholds: EvidenceThresholds,
}

impl Evidence {
    /// Refused (`Error::Meta`) when `meta.evidence` is `None`, before either network is parsed;
    /// the galleries' widths must match the crops' (`Error::Gallery`).
    pub fn load(files: EvidenceFiles<'static>, meta: &Meta) -> Result<Evidence, Error> {
        let Some(evidence) = &meta.evidence else {
            return Err(Error::Meta(
                "neural.json has no evidence section, so there are no printings to tell apart"
                    .into(),
            ));
        };
        let symbols = Gallery::from_bytes(files.symbols)?;
        let bands = Gallery::from_bytes(files.bands)?;
        for (name, gallery, crop) in [
            ("symbol", &symbols, &evidence.symbol),
            ("band", &bands, &evidence.band),
        ] {
            if gallery.dim() != crop.dim {
                return Err(Error::Gallery(format!(
                    "a {}-d {name} gallery for a {}-d {name} network",
                    gallery.dim(),
                    crop.dim
                )));
            }
        }
        let symbol = Embedder::load(files.symbol_net.into_owned(), evidence.symbol.embedder())?;
        let band = Embedder::load(files.band_net.into_owned(), evidence.band.embedder())?;
        let slot = |c: &CropMeta| vec![0.0; 3 * c.width * c.height];
        Ok(Evidence {
            nets: EvidenceNets {
                symbol,
                band,
                symbol_crop: evidence.symbol.clone(),
                band_crop: evidence.band.clone(),
                symbol_buf: slot(&evidence.symbol),
                band_buf: slot(&evidence.band),
            },
            index: EvidenceIndex::new(symbols, bands)?,
            thresholds: evidence.thresholds.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{rotate_half, Point};
    use crate::gallery::Look;

    fn id(b: u8) -> Id {
        [b; 16]
    }

    fn look(printing: u8, covers: &[u8], face: Face, name: &str) -> Look {
        Look {
            printing: id(printing),
            card: 0,
            face,
            covers: covers.iter().map(|c| id(*c)).collect(),
            name: name.into(),
        }
    }

    fn gallery(rows: &[f32], looks: &[Look]) -> Gallery {
        Gallery::build(rows, 2, looks).unwrap()
    }

    fn empty() -> Gallery {
        gallery(&[], &[])
    }

    fn glance(symbol: [f32; 2], band: [f32; 2]) -> Glance {
        Glance {
            symbol: symbol.to_vec(),
            band: band.to_vec(),
        }
    }

    fn unit(x: f32, y: f32) -> [f32; 2] {
        let n = (x * x + y * y).sqrt();
        [x / n, y / n]
    }

    #[test]
    fn a_printings_band_score_is_its_rows_cosine_averaged_over_the_glances() {
        let bands = gallery(
            &[1.0, 0.0, 0.0, 1.0],
            &[
                look(1, &[1], Face::Front, "A 1"),
                look(2, &[2], Face::Front, "A 2"),
            ],
        );
        let idx = EvidenceIndex::new(empty(), bands).unwrap();
        let none = [0.0, 0.0];
        // Against printing 1's row (1, 0) the glances score 0.6 and 1.0; against printing 2's
        // row (0, 1), 0.8 and 0.0.
        let glances = [glance(none, unit(3.0, 4.0)), glance(none, unit(1.0, 0.0))];
        let one = idx.band(&glances, &id(1), Face::Front).unwrap();
        assert!((one - 0.8).abs() < 1e-2, "{one}");
        let two = idx.band(&glances, &id(2), Face::Front).unwrap();
        assert!((two - 0.4).abs() < 1e-2, "{two}");
    }

    #[test]
    fn a_printing_with_no_row_scores_none() {
        let symbols = gallery(&[1.0, 0.0], &[look(1, &[1], Face::Front, "s/one")]);
        let bands = gallery(&[1.0, 0.0], &[look(1, &[1], Face::Front, "A 1")]);
        let idx = EvidenceIndex::new(symbols, bands).unwrap();
        let g = [glance([1.0, 0.0], [1.0, 0.0])];
        assert!(idx.symbol(&g, &id(9)).is_none());
        assert!(idx.band(&g, &id(9), Face::Front).is_none());
        assert!(idx.symbol(&g, &id(1)).is_some());
        assert!(idx.band(&g, &id(1), Face::Front).is_some());
        // Nothing seen is no score, not a perfect or a zero one.
        assert!(idx.symbol(&[], &id(1)).is_none());
        assert!(idx.band(&[], &id(1), Face::Front).is_none());
    }

    #[test]
    fn a_back_face_is_compared_with_back_face_rows_only() {
        let bands = gallery(
            &[1.0, 0.0, 0.0, 1.0],
            &[
                look(1, &[1], Face::Front, "P front"),
                look(1, &[1], Face::Back, "P back"),
            ],
        );
        let idx = EvidenceIndex::new(empty(), bands).unwrap();
        let g = [glance([0.0, 0.0], [0.0, 1.0])];
        let back = idx.band(&g, &id(1), Face::Back).unwrap();
        let front = idx.band(&g, &id(1), Face::Front).unwrap();
        assert!((back - 1.0).abs() < 1e-2, "{back}");
        assert!(front.abs() < 1e-2, "{front}");
    }

    #[test]
    fn printings_sharing_a_symbol_class_get_the_same_symbol_score() {
        let symbols = gallery(
            &[1.0, 0.0, 0.0, 1.0],
            &[
                look(1, &[1, 2], Face::Front, "bbd/common"),
                look(3, &[3], Face::Front, "m21/common"),
            ],
        );
        let idx = EvidenceIndex::new(symbols, empty()).unwrap();
        let g = [glance([1.0, 0.0], [0.0, 0.0])];
        let (p, q) = (
            idx.symbol(&g, &id(1)).unwrap(),
            idx.symbol(&g, &id(2)).unwrap(),
        );
        assert_eq!(p, q);
        assert!((p - 1.0).abs() < 1e-2, "{p}");
        assert!(idx.symbol(&g, &id(3)).unwrap().abs() < 1e-2);
    }

    #[test]
    fn a_printing_in_two_rows_of_a_kind_is_a_gallery_error() {
        let twice = |face| {
            gallery(
                &[1.0, 0.0, 0.0, 1.0],
                &[look(1, &[1], face, "A"), look(2, &[1], face, "B")],
            )
        };
        // Printing 1 in two band rows of one face, then in two symbol rows.
        assert!(matches!(
            EvidenceIndex::new(empty(), twice(Face::Front)),
            Err(Error::Gallery(_))
        ));
        assert!(matches!(
            EvidenceIndex::new(twice(Face::Front), empty()),
            Err(Error::Gallery(_))
        ));
        // One band row on each face is a double-faced printing, not a mistake.
        let both = gallery(
            &[1.0, 0.0, 0.0, 1.0],
            &[
                look(1, &[1], Face::Front, "A"),
                look(1, &[1], Face::Back, "A back"),
            ],
        );
        assert!(EvidenceIndex::new(empty(), both).is_ok());
    }

    #[test]
    fn evidence_is_refused_without_an_evidence_section() {
        let meta = Meta::from_json(include_bytes!("../models/neural.json")).unwrap();
        // Empty buffers: the section is checked before either network is parsed.
        let files = EvidenceFiles {
            symbol_net: Cow::Owned(Vec::new()),
            band_net: Cow::Owned(Vec::new()),
            symbols: Cow::Owned(Vec::new()),
            bands: Cow::Owned(Vec::new()),
        };
        assert!(matches!(Evidence::load(files, &meta), Err(Error::Meta(_))));
    }

    #[test]
    fn a_crop_through_a_turned_quad_is_the_turned_cards_crop() {
        let (w, h) = (40usize, 56usize);
        // Black but for a white block at the bottom left.
        let mut rgb = vec![0u8; w * h * 3];
        for y in 40..h {
            for x in 0..16 {
                rgb[(y * w + x) * 3..][..3].copy_from_slice(&[255; 3]);
            }
        }
        let frame = Frame::new(w, h, rgb.clone()).unwrap();
        // The same picture turned half a turn: pixel (x, y) lands on (w-1-x, h-1-y).
        let mut turned_rgb = vec![0u8; rgb.len()];
        for y in 0..h {
            for x in 0..w {
                let to = ((h - 1 - y) * w + (w - 1 - x)) * 3;
                turned_rgb[to..to + 3].copy_from_slice(&rgb[(y * w + x) * 3..][..3]);
            }
        }
        let turned = Frame::new(w, h, turned_rgb).unwrap();
        let p = |x: usize, y: usize| Point {
            x: x as f32,
            y: y as f32,
        };
        let quad = [p(0, 0), p(w, 0), p(w, h), p(0, h)];
        let band = [0.0, 0.7, 0.5, 1.0];
        let (ow, oh) = (8, 6);
        let (mut upright, mut again) = (vec![0f32; 3 * ow * oh], vec![0f32; 3 * ow * oh]);
        assert!(sample_card(&frame, &quad, band, ow, oh, &mut upright, None));
        // The detector's quad on the turned frame is the same four corners in the same order;
        // the winning view is the half turn of it, which reads the card the right way up.
        assert!(sample_card(
            &turned,
            &rotate_half(&quad),
            band,
            ow,
            oh,
            &mut again,
            None
        ));
        for (a, b) in upright.iter().zip(&again) {
            assert!((a - b).abs() < 1e-3, "{a} vs {b}");
        }
        assert!(
            upright.iter().any(|v| *v > 1.0),
            "the marked block is in the crop"
        );
    }
}
