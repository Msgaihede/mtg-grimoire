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

/// The collector line, bottom left: `U 0232` over `LTR * EN <brush> Jarel Threat`.
///
/// **A set code and a collector number are the printing itself**, which is the one thing
/// neither the descriptor nor the card's name can give. The hash answers "which card does this
/// look like" and reads a reprint as easily as the right printing; the title answers "what is
/// it called" and every reprint shares that. `LTR 232` is an identity.
///
/// Measured on a 488x680 rectification, the crop is about 175x47 — roughly a quarter the area
/// of the title band and with text half the height, which is why it upscales harder. It stops
/// at 38% of the width: the artist credit runs on past that and is nothing but noise for this
/// measured, an artist called Irvin Rodriguez read as INVEN, whose prefix INV is Invasion, and
/// the line then resolved confidently to the wrong printing. Every token kept past the set code
/// is another chance for a spurious pairing to resolve.
const COLLECTOR_BAND: (f32, f32, f32, f32) = (0.018, 0.918, 0.285, 0.990);

/// Where else to look when the first crop yields nothing.
///
/// **A single fixed rectangle assumes every card puts the line in the same place, and they do
/// not.** A borderless printing, a full-art land and a showcase frame each shift it, and the
/// rectification's own framing moves it again by a percent or two. Trying a wider crop and
/// then a lower one recovers reads that the first band clips.
///
/// Ordered, and taken in order, with an early exit as soon as a crop yields any candidate at
/// all: a read costs roughly **340 ms against a ~350 ms frame** (release, measured 2026-09-08),
/// so the common case has to stay at one. Only a card the
/// first band cannot see pays for the second.
const COLLECTOR_FALLBACKS: [(f32, f32, f32, f32); 2] = [
    // Wider and taller — for a frame that sits the line lower or runs it longer.
    (0.010, 0.900, 0.340, 1.000),
    // Higher up, for a full-art or borderless card whose line is inset from the edge.
    (0.020, 0.880, 0.300, 0.960),
];

/// What one attempt at reading the title produced.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TitleRead {
    /// The crop the recogniser actually saw — the orientation that won.
    ///
    /// Skipped by serde: the JSON carries a rendered preview of this, not the pixels.
    #[serde(skip)]
    pub band: Option<RgbImage>,
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
    band(rectified, TITLE_BAND, 2)
}

/// Crop the collector line, upscaled harder than the title because the type is smaller.
pub fn collector_band(rectified: &RgbImage) -> RgbImage {
    band(rectified, COLLECTOR_BAND, 4)
}

fn band(rectified: &RgbImage, at: (f32, f32, f32, f32), scale: u32) -> RgbImage {
    let (w, h) = (rectified.width() as f32, rectified.height() as f32);
    let (x0, y0, x1, y1) = at;
    let (cx, cy) = ((x0 * w) as u32, (y0 * h) as u32);
    // Clamped once, here, rather than at the crop alone — a degenerate input made the crop
    // safe and then asked `resize` for a zero-height image, which panics.
    let cw = (((x1 - x0) * w) as u32).max(1);
    let ch = (((y1 - y0) * h) as u32).max(1);
    let crop = image::imageops::crop_imm(rectified, cx, cy, cw, ch).to_image();
    image::imageops::resize(
        &crop,
        cw * scale,
        ch * scale,
        image::imageops::FilterType::Lanczos3,
    )
}


/// What a collector line read produced.
#[derive(Debug, Clone, Default)]
pub struct CollectorRead {
    /// The line as OCR returned it, whitespace collapsed.
    pub raw: String,
    /// Every (set, number) pair worth trying, best first. See [`collector_candidates`].
    pub candidates: Vec<(String, String)>,
    pub rotated: bool,
    pub elapsed_ms: f32,
    /// The crop the recogniser actually saw, for the debug view.
    ///
    /// **Carried rather than re-derived.** The read walks several crops in two orientations
    /// and stops at the first that parses, so a viewer re-cropping "the" collector band would
    /// often be shown a different image than the one the text came from — which is worse than
    /// showing nothing, because it looks like an answer.
    pub band: Option<RgbImage>,
}

/// Every plausible (set code, collector number) pairing in a collector-line read.
///
/// **Deliberately every pairing rather than a parse.** The line holds a rarity letter, a
/// number, a set code, a language and an artist, in an order that varies by frame and with
/// separators OCR renders as anything at all — so a rule like "the letters before EN are the
/// set" fits one card and breaks on the next. What makes this tractable is that the answer is
/// checkable: a caller looks each pairing up, and only a pair that names a real printing
/// survives. Guessing widely against a strict test beats parsing narrowly against none.
///
/// Ordered longest-set-code first, because `LTR` resolving is far more likely to be right than
/// a two-letter fragment that happens to collide with a real set.
pub fn collector_candidates(raw: &str) -> Vec<(String, String)> {
    let mut words: Vec<String> = Vec::new();
    for w in raw.split(|c: char| !c.is_ascii_alphanumeric()) {
        // **Split where the character class changes.** The separators on the card — a space,
        // a bullet, a brush glyph — are exactly what OCR drops, so `C 0035` comes back as
        // `C0035` and `HOB * EN` as `HOBEN`. Measured over the corpus this was the dominant
        // failure by a distance: most reads had the digits present and legible and produced
        // *zero* pairings, because no token began with one.
        let mut cur = String::new();
        for ch in w.chars() {
            if !cur.is_empty()
                && cur.chars().last().is_some_and(|p| p.is_ascii_digit()) != ch.is_ascii_digit()
            {
                words.push(std::mem::take(&mut cur));
            }
            cur.push(ch);
        }
        if !cur.is_empty() {
            words.push(cur);
        }
    }

    // **A collector number is printed zero-padded, and that is a usable filter.** Every
    // number this read correctly over the corpus came back four digits — `0001`, `0232`,
    // `0193`. A one- or two-digit token is a fragment of something else: measured, a garbage
    // read of `... D 6 T K A ...` produced a confident `LTR 6` against a true `LTR 590`.
    let numbers: Vec<(usize, String)> = words
        .iter()
        .enumerate()
        .filter(|(_, t)| t.len() >= 3 && t.chars().all(|c| c.is_ascii_digit()))
        .map(|(i, t)| (i, t.to_ascii_lowercase()))
        .collect();

    // Set codes, best first: a whole token before any prefix of one, and longer before
    // shorter. A prefix is a guess about where OCR glued two fields together, so it should
    // never outrank a token that stands on its own.
    let usable = |t: &str| (2..=6).contains(&t.len()) && !t.eq_ignore_ascii_case("en");
    let alpha: Vec<(usize, &String)> = words
        .iter()
        .enumerate()
        .filter(|(_, t)| t.chars().all(|c| c.is_ascii_alphabetic()) && usable(t))
        .collect();

    let mut out = Vec::new();
    for (ni, number) in &numbers {
        // **Only a set code touching the number counts.** The two fields are printed
        // adjacent, and letting the search wander further down the line is what produced the
        // worst failure mode this has: on `C0004 HOHEN INVEK`, the real set read as HOHEN and
        // resolved to nothing, so the search reached the *next* word — an artist's surname
        // whose first three letters are a real set — and answered INV 4 with full confidence.
        // Wrong and certain is worse than absent, so it now answers nothing there.
        let mut near: Vec<&String> = alpha
            .iter()
            .filter(|(i, _)| i.abs_diff(*ni) <= 1)
            .map(|(_, t)| *t)
            .collect();
        near.sort_by_key(|t| std::cmp::Reverse(t.len()));

        let mut sets: Vec<String> = near.iter().map(|t| t.to_ascii_lowercase()).collect();
        // Then prefixes, which is what recovers `HOB` from `HOBEN`.
        for t in &near {
            for n in (2..t.len()).rev() {
                let pre = t[..n].to_ascii_lowercase();
                if usable(&pre) {
                    sets.push(pre);
                }
            }
        }

        for set in sets {
            // The card prints `0232`; Scryfall stores `232`. Both are offered, since a few
            // sets genuinely use a leading zero and the caller checks against the corpus.
            let trimmed = number.trim_start_matches('0');
            let n = if trimmed.is_empty() { "0" } else { trimmed };
            out.push((set.clone(), n.to_string()));
            if n != number {
                out.push((set, number.clone()));
            }
        }
    }
    out.dedup();
    out
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
            let (ba, bb) = (title_band(upright), title_band(flipped));
            let a = self.read_band(&ba).unwrap_or_default();
            let b = self.read_band(&bb).unwrap_or_default();

            let letters = |s: &str| s.chars().filter(|c| c.is_ascii_alphabetic()).count();
            let rotated = letters(&b) > letters(&a);
            let raw = if rotated { b } else { a };

            TitleRead {
                band: Some(if rotated { bb } else { ba }),
                normalized: normalize(&raw),
                raw: raw.split_whitespace().collect::<Vec<_>>().join(" "),
                rotated,
                elapsed_ms: started.elapsed().as_secs_f32() * 1000.0,
            }
        }
    }

    impl TitleReader {
        /// Read the collector line from both orientations.
        ///
        /// Which way up is settled by which read yields *resolvable* pairings, so unlike the
        /// title there is no heuristic here — the caller checks each candidate against the
        /// corpus and an upside-down read simply produces none that resolve.
        pub fn read_collector(&self, upright: &RgbImage, flipped: &RgbImage) -> CollectorRead {
            let started = std::time::Instant::now();
            // **The first crop settles which way up, and the fallbacks only ever try that
            // one.** Both orientations of every crop is six reads at ~130 ms each, and the
            // cost lands exactly the wrong way round: a card that reads resolves on the first
            // attempt, while a card that cannot be read pays for all six. Deciding the
            // orientation once takes the worst case from 785 ms to roughly half that.
            let mut shown = band(upright, COLLECTOR_BAND, 4);
            let up = self.read_band(&shown).unwrap_or_default();
            let mut candidates = collector_candidates(&up);
            let mut raw = up;
            let mut rotated = false;

            if candidates.is_empty() {
                let flip = band(flipped, COLLECTOR_BAND, 4);
                let down = self.read_band(&flip).unwrap_or_default();
                let found = collector_candidates(&down);
                // Digits decide it, not length: upside-down, this band holds the *title*,
                // which reads long and cleanly and would win any "more text" comparison while
                // containing nothing that could ever resolve.
                let digits = |t: &str| t.chars().filter(|c| c.is_ascii_digit()).count();
                if !found.is_empty() || digits(&down) > digits(&raw) {
                    rotated = true;
                    candidates = found;
                    raw = down;
                    shown = flip;
                }
            }

            // Wider, then higher — only in the orientation already chosen.
            if candidates.is_empty() {
                let source = if rotated { flipped } else { upright };
                for at in COLLECTOR_FALLBACKS {
                    let crop = band(source, at, 4);
                    let text = self.read_band(&crop).unwrap_or_default();
                    let found = collector_candidates(&text);
                    if !found.is_empty() {
                        candidates = found;
                        raw = text;
                        shown = crop;
                        break;
                    }
                }
            }

            CollectorRead {
                raw: raw.split_whitespace().collect::<Vec<_>>().join(" "),
                candidates,
                band: Some(shown),
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

    /// Every string here is a real read from the corpus, kept verbatim including the
    /// mistakes — the whole difficulty of this parse is what OCR does to the separators, and
    /// an invented fixture would quietly test the easy version.
    #[test]
    fn a_clean_collector_line_resolves_to_its_set_and_number() {
        let c = collector_candidates("U 0232 LTR EN");
        assert!(c.contains(&("ltr".into(), "232".into())), "got {c:?}");
    }

    #[test]
    fn a_glued_set_and_language_still_yields_the_set() {
        // `HOB * EN` comes back as `HOBEN`: the separator is a bullet OCR does not see. This
        // was the dominant failure over the corpus — the digits were legible and present, and
        // the read produced no pairings at all.
        let c = collector_candidates("C0035 HOBEN COLIN BOYER");
        assert!(c.contains(&("hob".into(), "35".into())), "got {c:?}");
    }

    #[test]
    fn a_rarity_glued_to_the_number_is_split_off() {
        // `C 0035` reads as `C0035`, and a token beginning with a letter was never offered as
        // a number, so nothing resolved however good the rest of the line was.
        let c = collector_candidates("C0004 HOB EN");
        assert!(c.contains(&("hob".into(), "4".into())), "got {c:?}");
    }

    #[test]
    fn a_word_beyond_the_set_code_is_not_reachable() {
        // The measured worst case: the true set read as HOHEN and resolves to nothing, so a
        // wider search reached the next word — an artist's surname whose first three letters
        // are Invasion — and answered INV 4 with full confidence. Wrong and certain is worse
        // than absent.
        let c = collector_candidates("C0004 HOHEN INVEK");
        assert!(
            !c.iter().any(|(s, _)| s == "inv"),
            "a word two places from the number was offered as the set: {c:?}"
        );
    }

    #[test]
    fn a_short_number_is_noise_rather_than_a_collector_number() {
        // Printed numbers are zero-padded; every correct read over the corpus was four
        // digits. A bare `6` inside a garbage line produced a confident `LTR 6` against a
        // true `LTR 590`.
        let c = collector_candidates("I LTR OEN TruERLC D 6 T K A SRA");
        assert!(c.is_empty(), "a one-digit fragment was taken as a collector number: {c:?}");
    }

    #[test]
    fn the_language_is_never_offered_as_a_set() {
        // `EN` is on every English card and would otherwise be the most common set code in
        // the corpus by a wide margin.
        let c = collector_candidates("U 0232 EN");
        assert!(!c.iter().any(|(s, _)| s == "en"), "got {c:?}");
    }

    #[test]
    fn a_whole_token_outranks_a_prefix_of_one() {
        // Prefixes exist to recover a glued field, so they are a guess; a token that stands
        // on its own is not. The caller takes the first pairing that resolves, so the order
        // here is the difference between a right answer and a plausible one.
        let c = collector_candidates("0232 LTR");
        let whole = c.iter().position(|(s, _)| s == "ltr");
        let prefix = c.iter().position(|(s, _)| s == "lt");
        assert!(whole < prefix, "a prefix was offered before the whole token: {c:?}");
    }

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
            band: None,
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
