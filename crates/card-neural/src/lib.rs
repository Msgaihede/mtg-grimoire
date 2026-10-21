//! The Neural scanner's recogniser: two small CNNs and a gallery, in pure Rust on `rten`.
//!
//! 1. [`detect`] — a MobileNetV3-small network with an FPN head that answers, at stride 8, a
//!    "card centred here" logit, the four corners and an orientation logit: every card in the
//!    frame at once, sleeves and binder pockets included, then each again zoomed in.
//! 2. [`embed`] — a MobileNetV4-conv-small network that turns a 128×128 rectified view of the
//!    card's top 72 % (name, art, type line) into a 128-d unit vector.
//! 3. [`gallery`] — that vector's cosine search over every **look** (printings that photograph
//!    alike), int8 rows with a scale each.
//!
//! [`scanner::Recognizer`] reads one frame; [`session::Agreement`] agrees across frames. The
//! design is quickdraw.cards', the weights and the gallery are ours, trained from Apache-2.0
//! ImageNet checkpoints on Scryfall scans. `docs/reference/card-scanner.md` §10 *Neural* has the
//! mode and the replay this crate's files scored on, the scanner lab's write-up (outside this
//! repository, `E:\mtg-scanner\docs\neural-scanner.md`) the evidence and the training, and
//! `models/README.md` where each
//! file came from.
//!
//! **What this crate may not do, because `card-scanner` runs it in a browser Worker**: read a
//! clock, start a thread, or touch a file outside the `cli` feature. The caller times it, and
//! hands it bytes.

use std::borrow::Cow;

pub mod detect;
pub mod embed;
pub mod evidence;
pub mod frame;
pub mod gallery;
pub mod meta;
pub mod narrow;
pub mod scanner;
pub mod session;

pub use evidence::{Evidence, EvidenceFiles, EvidenceIndex, EvidenceNets, Glance};
pub use frame::Frame;
pub use gallery::{Admit, Gallery};
pub use meta::Meta;
pub use scanner::{Found, Read, Recognizer};
pub use session::{Agreement, Decision};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("frame: {0}")]
    Frame(String),
    #[error("model: {0}")]
    Model(String),
    #[error("meta: {0}")]
    Meta(String),
    #[error("gallery: {0}")]
    Gallery(String),
}

/// The four files a [`Recognizer`] is made of. Borrowed where they are compiled in, owned where
/// a host received them (a Worker's message), so neither copies more than it must.
#[derive(Clone, Debug)]
pub struct Files<'a> {
    pub detector: Cow<'a, [u8]>,
    pub embedder: Cow<'a, [u8]>,
    pub gallery: Cow<'a, [u8]>,
    /// `neural.json`: input sizes, decode constants, thresholds and the ranking.
    pub meta: Cow<'a, [u8]>,
}

/// The file names, as they sit in `models/` and as the web serves them.
pub const DETECTOR_FILE: &str = "detector.onnx";
pub const EMBEDDER_FILE: &str = "embedder.onnx";
pub const GALLERY_FILE: &str = "gallery.bin";
pub const META_FILE: &str = "neural.json";

/// The files in this crate's `models/`, compiled in.
#[cfg(feature = "bundled")]
pub fn bundled() -> Files<'static> {
    Files {
        detector: Cow::Borrowed(include_bytes!("../models/detector.onnx")),
        embedder: Cow::Borrowed(include_bytes!("../models/embedder.onnx")),
        gallery: Cow::Borrowed(include_bytes!("../models/gallery.bin")),
        meta: Cow::Borrowed(include_bytes!("../models/neural.json")),
    }
}

/// The files in a directory laid out as `models/` is — what the command-line tools read.
#[cfg(feature = "cli")]
pub fn read_dir(dir: &std::path::Path) -> std::io::Result<Files<'static>> {
    let read = |name: &str| std::fs::read(dir.join(name)).map(Cow::Owned);
    Ok(Files {
        detector: read(DETECTOR_FILE)?,
        embedder: read(EMBEDDER_FILE)?,
        gallery: read(GALLERY_FILE)?,
        meta: read(META_FILE)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `models/`, as `bundled` compiles it in — read here without the feature, so a plain
    /// `cargo test` proves the files in git load.
    fn shipped() -> Files<'static> {
        Files {
            detector: Cow::Borrowed(include_bytes!("../models/detector.onnx")),
            embedder: Cow::Borrowed(include_bytes!("../models/embedder.onnx")),
            gallery: Cow::Borrowed(include_bytes!("../models/gallery.bin")),
            meta: Cow::Borrowed(include_bytes!("../models/neural.json")),
        }
    }

    #[test]
    fn the_shipped_files_load_and_an_empty_frame_holds_no_card() {
        let mut r = Recognizer::load(shipped()).unwrap();
        // Not one count: `neural-deliver.yml` delivers a new gallery every month, and Scryfall
        // only grows, give or take a withdrawn printing. The first pair had 70 402 looks; a
        // gallery well short of that is an export cut short, whichever run made it.
        assert!(
            r.gallery().len() >= 70_000,
            "{} looks: a gallery cut short",
            r.gallery().len()
        );
        assert_eq!(r.gallery().dim(), r.meta().embedder.dim);
        let grey = Frame::new(320, 192, vec![128; 320 * 192 * 3]).unwrap();
        let read = r.read(&grey, None).unwrap();
        assert!(
            read.cards.iter().all(|c| !c.accepted),
            "a grey frame names no card"
        );
        assert!(!read.accepted && !read.instant);
        assert!(read.detector_runs >= 1);
    }

    #[test]
    fn the_shipped_gallery_searches_each_look_back_to_itself() {
        let r = Recognizer::load(shipped()).unwrap();
        let g = r.gallery();
        // A handful of looks across the file, the last whatever the count: a look's own int8
        // row, used as the query, comes back first — the rows and their scales line up with the
        // index.
        let last = u32::try_from(g.len() - 1).unwrap();
        for e in [0u32, 1, 12_345, 35_000, last] {
            let q: Vec<f32> = (0..g.dim())
                .map(|j| {
                    let mut one = vec![0.0; g.dim()];
                    one[j] = 1.0;
                    g.score(e, &one)
                })
                .collect();
            let norm = q.iter().map(|v| v * v).sum::<f32>().sqrt();
            let q: Vec<f32> = q.iter().map(|v| v / norm).collect();
            let top = g.top(&q, 1, None).unwrap();
            assert_eq!(top[0].0, e);
            assert!(!g.name(e).is_empty() && g.covers(e).len() >= 1);
            assert_eq!(
                g.covers(e).next(),
                Some(g.printing(e)),
                "the pictured printing first"
            );
        }
    }

    #[test]
    fn a_found_card_carries_the_fingerprint_its_score_came_from() {
        let mut r = Recognizer::load(shipped()).unwrap();
        let grey = Frame::new(320, 192, vec![128; 320 * 192 * 3]).unwrap();
        // One hand-made detection on the frame's inset rectangle, sure of its orientation
        // (flip 0.0), so one view is embedded. The search always answers, so one card is found.
        let p = |x, y| frame::Point { x, y };
        let quad = [
            p(40.0, 24.0),
            p(280.0, 24.0),
            p(280.0, 168.0),
            p(40.0, 168.0),
        ];
        let det = detect::Detection {
            score: 0.9,
            quad,
            flip: 0.0,
        };
        let (cards, crops) = r.fingerprint(&grey, &[det], None).unwrap();
        assert_eq!((cards.len(), crops), (1, 1));
        let found = &cards[0];
        assert_eq!(found.embedding.len(), r.meta().embedder.dim);
        let norm = found.embedding.iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-3, "a unit vector, not {norm}");
        let again = r.gallery().score(found.scored.entry, &found.embedding);
        assert!((again - found.scored.score).abs() < 1e-5, "{again}");
    }

    #[test]
    fn a_gallery_of_another_width_is_refused() {
        let mut files = shipped();
        let looks = [gallery::Look {
            printing: [1; 16],
            card: 0,
            face: gallery::Face::Front,
            covers: vec![[1; 16]],
            name: "x".into(),
        }];
        let small = Gallery::build(&[1.0, 0.0], 2, &looks).unwrap();
        files.gallery = Cow::Owned(small.as_bytes().to_vec());
        assert!(matches!(Recognizer::load(files), Err(Error::Gallery(_))));
    }
}
