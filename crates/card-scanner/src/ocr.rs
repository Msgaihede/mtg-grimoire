//! Reading the card's name off the rectified image.
//!
//! ## Why this tier exists, and what it is for
//!
//! The whole-card hash answers "which card looks most like this", and that question has one
//! failure mode nothing else fixes: a **foil under a point light**. The sheen washes the
//! surface in a rainbow, the art becomes a haze, and every descriptor — grayscale, chroma,
//! half-chroma — finds the right card on at most two frames in eight. The same card, evenly
//! lit as a still, matches at 32 bits.
//!
//! In those exact frames the title is **perfectly legible**. Text is a shape, not a colour,
//! and a rainbow that destroys every appearance-based descriptor leaves the letterforms
//! intact. That is the whole argument for OCR: it is not a better version of the same signal,
//! it is a different signal, and it is strongest precisely where the other one is weakest.
//!
//! ## Only the title band
//!
//! Text detection over a whole card would find the type line, the rules text, the flavour
//! text, the collector line and the artist credit — dozens of words, most of a second, and a
//! haystack to search for the one line that names the card. A rectified card puts the title
//! in a known place, so this crops to it and reads that.
//!
//! The band is deliberately generous at the top and cut short on the right: the title starts
//! higher on a pre-8th-edition frame than on an M15 one, and the right end of every modern
//! title bar is the mana cost, which is not text and reads as garbage.

use image::RgbImage;

/// Where the card's name sits on a rectified card, as fractions of its size.
///
/// Generous vertically because the title's height varies by frame era; stopping at 78% across
/// leaves the mana cost out.
const TITLE_BAND: (f32, f32, f32, f32) = (0.045, 0.025, 0.780, 0.130);

/// What one attempt at reading the title produced.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TitleRead {
    /// The text as OCR returned it, whitespace-collapsed.
    pub raw: String,
    /// Lowercased and stripped to letters, digits and single spaces — the form a name lookup
    /// compares against.
    pub normalized: String,
    /// Whether the 180°-rotated rectification produced this, rather than the upright one.
    pub rotated: bool,
    pub elapsed_ms: f32,
}

impl TitleRead {
    /// Is there enough here to look a card up with?
    ///
    /// Two characters of noise is what an empty band returns; a real title is a word.
    pub fn is_usable(&self) -> bool {
        self.normalized.len() >= 4 && self.normalized.chars().any(|c| c.is_ascii_alphabetic())
    }
}

/// Collapse OCR output to a comparable form.
///
/// Card names carry apostrophes, commas, hyphens and accents that OCR renders inconsistently
/// — `Kroxa's` may come back as `Kroxas`, `Kroxa'S` or `Kroxa s`. Stripping all of it on both
/// sides means the comparison never turns on a character that was never reliable.
pub fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = true; // leading spaces are never wanted
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            space = false;
        } else if !space {
            out.push(' ');
            space = true;
        }
    }
    while out.ends_with(' ') {
        out.pop();
    }
    out
}

/// Crop the title band out of a rectified card, upscaled for the recogniser.
///
/// The band is ~350x50 on a 488x680 card, which is small for a model trained on document
/// scans. Doubling it costs a fraction of a millisecond and measurably steadies the read.
pub fn title_band(rectified: &RgbImage) -> RgbImage {
    let (w, h) = (rectified.width() as f32, rectified.height() as f32);
    let (x0, y0, x1, y1) = TITLE_BAND;
    let (cx, cy) = ((x0 * w) as u32, (y0 * h) as u32);
    // Clamped once, here, rather than at the crop alone — a degenerate input made the crop
    // safe and then asked `resize` for a zero-height image, which panics.
    let cw = (((x1 - x0) * w) as u32).max(1);
    let ch = (((y1 - y0) * h) as u32).max(1);
    let crop = image::imageops::crop_imm(rectified, cx, cy, cw, ch).to_image();
    image::imageops::resize(&crop, cw * 2, ch * 2, image::imageops::FilterType::Lanczos3)
}

#[cfg(feature = "ocr")]
mod engine {
    use super::*;
    use ocrs::{ImageSource, OcrEngine, OcrEngineParams};
    use std::path::Path;

    /// A loaded OCR engine. Construction reads ~12 MB of model, so build one and keep it.
    pub struct TitleReader {
        engine: OcrEngine,
    }

    impl TitleReader {
        /// Load the ocrs detection and recognition models.
        ///
        /// Fetch them with `scripts/fetch-ocr-models.mjs`; they are not vendored, for the same
        /// reason the hash bundle is not.
        pub fn load(detection: &Path, recognition: &Path) -> anyhow_lite::Result<TitleReader> {
            let detection_model = rten::Model::load_file(detection)
                .map_err(|e| format!("detection model {}: {e}", detection.display()))?;
            let recognition_model = rten::Model::load_file(recognition)
                .map_err(|e| format!("recognition model {}: {e}", recognition.display()))?;
            let engine = OcrEngine::new(OcrEngineParams {
                detection_model: Some(detection_model),
                recognition_model: Some(recognition_model),
                ..Default::default()
            })
            .map_err(|e| format!("ocr engine: {e}"))?;
            Ok(TitleReader { engine })
        }

        fn read_band(&self, band: &RgbImage) -> Option<String> {
            let src =
                ImageSource::from_bytes(band.as_raw(), (band.width(), band.height())).ok()?;
            let input = self.engine.prepare_input(src).ok()?;
            self.engine.get_text(&input).ok()
        }

        /// Read the title from both orientations and keep the more plausible one.
        ///
        /// **Both, for the reason everything else in this crate reads both**: a card is
        /// 180°-symmetric and the quad cannot say which end is the top. Upside-down, the title
        /// band contains the collector line and the artist credit, which OCR reads perfectly
        /// well — so "did it return text" cannot decide it. The longer alphabetic result wins,
        /// because a name is longer than a set code and a collector number.
        pub fn read_title(&self, upright: &RgbImage, flipped: &RgbImage) -> TitleRead {
            let started = std::time::Instant::now();
            let a = self.read_band(&title_band(upright)).unwrap_or_default();
            let b = self.read_band(&title_band(flipped)).unwrap_or_default();

            let letters = |s: &str| s.chars().filter(|c| c.is_ascii_alphabetic()).count();
            let rotated = letters(&b) > letters(&a);
            let raw = if rotated { b } else { a };

            TitleRead {
                normalized: normalize(&raw),
                raw: raw.split_whitespace().collect::<Vec<_>>().join(" "),
                rotated,
                elapsed_ms: started.elapsed().as_secs_f32() * 1000.0,
            }
        }
    }

    /// A local stand-in so this module does not pull `anyhow` into the crate for two calls.
    pub mod anyhow_lite {
        pub type Result<T> = std::result::Result<T, String>;
    }
}

#[cfg(feature = "ocr")]
pub use engine::{anyhow_lite, TitleReader};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_what_ocr_gets_wrong() {
        // Apostrophes, commas and hyphens are exactly the characters OCR renders
        // inconsistently, so both sides of the comparison lose them.
        assert_eq!(normalize("Strider, Ranger of the North"), "strider ranger of the north");
        assert_eq!(normalize("Kroxa's Return"), "kroxa s return");
        assert_eq!(normalize("  Fire // Ice  "), "fire ice");
        assert_eq!(normalize("Ætherize"), "therize"); // non-ASCII drops; both sides do
        assert_eq!(normalize("---"), "");
    }

    #[test]
    fn usability_rejects_noise_but_accepts_a_name() {
        let mk = |s: &str| TitleRead {
            raw: s.into(),
            normalized: normalize(s),
            rotated: false,
            elapsed_ms: 0.0,
        };
        assert!(!mk("").is_usable());
        assert!(!mk("l|").is_usable());
        assert!(!mk("12 34").is_usable(), "digits alone are a collector line, not a name");
        assert!(mk("Oliphaunt").is_usable());
    }

    #[test]
    fn the_title_band_is_where_a_title_is() {
        // A 488x680 card's name sits in the top eighth and stops before the mana cost.
        let card = RgbImage::new(crate::RECTIFIED_W, crate::RECTIFIED_H);
        let band = title_band(&card);
        // Upscaled 2x, so compare against twice the crop.
        assert_eq!(band.width(), ((0.780 - 0.045) * 488.0) as u32 * 2);
        assert_eq!(band.height(), ((0.130 - 0.025) * 680.0) as u32 * 2);
        assert!(band.height() < card.height(), "the band is a band, not the card");
    }

    #[test]
    fn a_tiny_image_does_not_panic() {
        let band = title_band(&RgbImage::new(4, 4));
        assert!(band.width() >= 1 && band.height() >= 1);
    }
}
