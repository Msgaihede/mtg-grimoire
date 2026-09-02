//! Does this rectified image look like a Magic card at all?
//!
//! ## The gap this fills
//!
//! Every other check in this crate is about the *quad*: its aspect, its corner angles, its
//! area, whether it sits inside a bigger one. None of them ever looks at what was actually
//! warped out. That is a hole, and one specific thing falls through it.
//!
//! **A card's art window, turned 90°, is geometrically a card.** The art on a standard frame
//! is about 55×40 mm, so on its side that is an aspect of 0.727 against a card's 0.716 — 1.5%
//! apart. Measured on the sample scans: a junk quad that was really an art window came out at
//! 0.729, while a genuine card came out at 0.718. There is no aspect tolerance that admits the
//! second and rejects the first, because there is nothing to separate. The difference is not
//! in the shape, so it has to be looked for in the pixels.
//!
//! ## What every card has, including the ones a naive check would throw away
//!
//! The obvious test — "a card has a uniform border ring" — is wrong here, and wrong in the
//! most damaging way: it rejects **borderless and full-art cards**, which is a large and
//! growing share of what anyone actually scans. Three of the matches verified by hand on this
//! corpus are exactly those (Oliphaunt and Knights of Dol Amroth are borderless, Forest
//! HOB 193 is a full-art land), so a border check would have broken working cases to fix
//! broken ones.
//!
//! What survives every frame layout is **horizontal structure**. A card carries its name in a
//! band across the top and its type in a band around 58% down, and both are true of full-art
//! lands, borderless printings and showcase frames — the banner may float over the art, but it
//! is still a band and it still spans the card.
//!
//! The measurable form of that is a **full-width horizontal transition**: a row where most
//! columns change at once. A frame element spans the card, so it moves nearly every column
//! together. A painting does not — its edges are everywhere, but they are scattered, and no
//! single row moves in unison. That asymmetry is what separates a card from its own artwork.

use image::{GrayImage, RgbImage};

/// Where a card's two reliable bands sit, as a fraction of card height.
///
/// Generous, because these move between frame layouts: an M15 title sits higher than a
/// pre-8th-edition one, and a full-art land's type line sits lower than a creature's.
const TITLE_BAND: (f32, f32) = (0.015, 0.175);
const TYPE_BAND: (f32, f32) = (0.480, 0.700);

/// The working size for the profile. Small enough to be free, tall enough that a band a few
/// millimetres high is still several rows.
pub const W: u32 = 96;
pub const H: u32 = 134;

#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct Cardness {
    /// Strongest full-width transition in the title band, 0..1.
    pub title: f32,
    /// Strongest full-width transition in the type-line band, 0..1.
    pub type_line: f32,
    /// Rows anywhere that move in unison — a card has several, a painting almost none.
    pub full_width_rows: usize,
    /// Combined, 0..1. Higher is more card-like.
    pub score: f32,
}

impl Cardness {
    /// Is this plausibly a card?
    ///
    /// The threshold is set from the measured separation over the sample corpus; see
    /// [`MIN_SCORE`].
    pub fn is_card(&self) -> bool {
        self.score >= MIN_SCORE
    }
}

/// Rejection threshold, swept rather than guessed.
///
/// Over the 43 sample scans, gating on this score against whether the match landed in the
/// good cluster (<= 66 bits):
///
/// | threshold | kept | good kept | bad kept | **good lost** | precision |
/// | --- | --- | --- | --- | --- | --- |
/// | none | 39 | 24 | 15 | 0 | 62% |
/// | 0.40-0.50 | 29 | **24** | 5 | **0** | **83%** |
/// | 0.65 | 25 | 23 | 2 | 1 | 92% |
///
/// 0.45 sits in the middle of the plateau where nothing good is lost, so a corpus that sits
/// slightly differently still costs no recall. Pushing to 0.65 buys another nine points of
/// precision for one good frame, which is tempting and is deliberately not taken: with
/// [`crate::track`] downstream, a junk frame contributes an id that never recurs and decays
/// away, while a lost good frame is evidence that never existed.
pub const MIN_SCORE: f32 = 0.45;

/// Score both orientations and keep the better, reporting which won.
///
/// **A card is 180°-symmetric, and so this check has to be.** Upside-down, the type line sits
/// at ~42% from the top rather than ~58%, and the title band lands near the bottom edge — both
/// outside the windows below. Measured on the sample scans: a correctly matched card
/// (Master's Councillors, 44 bits) scored 0.415 with a type-line reading of 0.06, purely
/// because it had been rectified the other way up. Widening the bands to cover both positions
/// would blunt the discriminator; scoring twice does not, and costs one more pass over a
/// 96x134 image.
pub fn cardness_oriented(upright: &RgbImage, flipped: &RgbImage) -> (Cardness, bool) {
    let a = cardness(upright);
    let b = cardness(flipped);
    if b.score > a.score {
        (b, true)
    } else {
        (a, false)
    }
}

/// Score a rectified card for card-like horizontal structure.
pub fn cardness(rectified: &RgbImage) -> Cardness {
    let gray = image::imageops::resize(
        &image::DynamicImage::ImageRgb8(rectified.clone()).to_luma8(),
        W,
        H,
        image::imageops::FilterType::Triangle,
    );
    profile_cardness(&gray)
}

fn profile_cardness(gray: &GrayImage) -> Cardness {
    let (w, h) = (gray.width() as usize, gray.height() as usize);
    if w < 4 || h < 8 {
        return Cardness { title: 0.0, type_line: 0.0, full_width_rows: 0, score: 0.0 };
    }

    // A contrast-relative threshold, so a dim photograph and a bright one are judged the same
    // way. A fixed cutoff would call every under-exposed card featureless.
    let mut values: Vec<u8> = gray.pixels().map(|p| p[0]).collect();
    values.sort_unstable();
    let p5 = values[values.len() / 20] as f32;
    let p95 = values[values.len() * 19 / 20] as f32;
    let step = ((p95 - p5) * 0.22).max(10.0);

    // Per row, the fraction of columns that step at the same time.
    let mut frac = vec![0f32; h];
    for y in 1..h {
        let mut n = 0;
        for x in 0..w {
            let a = gray.get_pixel(x as u32, y as u32)[0] as f32;
            let b = gray.get_pixel(x as u32, y as u32 - 1)[0] as f32;
            if (a - b).abs() > step {
                n += 1;
            }
        }
        frac[y] = n as f32 / w as f32;
    }

    let band_max = |(lo, hi): (f32, f32)| -> f32 {
        let a = ((lo * h as f32) as usize).max(1);
        let b = ((hi * h as f32) as usize).min(h);
        frac[a..b].iter().copied().fold(0.0, f32::max)
    };

    let title = band_max(TITLE_BAND);
    let type_line = band_max(TYPE_BAND);
    let full_width_rows = frac.iter().filter(|f| **f > 0.55).count();

    // Both bands must be present; a card missing either is not a card, so the two multiply
    // rather than average. A mean would let a very strong title alone carry an art crop that
    // happens to have a hard edge across its top.
    let bands = (title * type_line).sqrt();
    // A small bonus for structure anywhere else — the art window's own top and bottom edges,
    // the text box rules, the bottom info line. Saturates quickly; it is corroboration, not
    // the main signal.
    let structure = (full_width_rows as f32 / 6.0).min(1.0);
    let score = bands * 0.75 + structure * 0.25;

    Cardness { title, type_line, full_width_rows, score }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    /// A crude card: a light ground with two full-width dark bands where the title and type
    /// line go, plus a border.
    fn synthetic_card() -> RgbImage {
        let mut img = RgbImage::from_pixel(488, 680, Rgb([120, 118, 110]));
        let band = |img: &mut RgbImage, y0: u32, y1: u32| {
            for y in y0..y1 {
                for x in 20..468 {
                    img.put_pixel(x, y, Rgb([235, 233, 228]));
                }
            }
        };
        band(&mut img, 30, 70); // title
        band(&mut img, 380, 415); // type line
        band(&mut img, 430, 620); // text box
        img
    }

    /// A painting: smooth, scattered structure, nothing spanning the width.
    fn synthetic_art() -> RgbImage {
        RgbImage::from_fn(488, 680, |x, y| {
            let v = (((x as f32 / 37.0).sin() * (y as f32 / 53.0).cos() + 1.0) * 110.0) as u8;
            Rgb([v, v.saturating_add(12), v.saturating_sub(9)])
        })
    }

    #[test]
    fn a_card_scores_above_a_painting() {
        let card = cardness(&synthetic_card());
        let art = cardness(&synthetic_art());
        assert!(
            card.score > art.score,
            "card {:.3} did not beat art {:.3}",
            card.score,
            art.score
        );
        assert!(card.is_card(), "the synthetic card scored {:.3}", card.score);
        assert!(!art.is_card(), "the synthetic painting scored {:.3}", art.score);
    }

    #[test]
    fn both_bands_are_required() {
        // A title band alone must not carry it — that is the case a mean would let through,
        // and it is exactly what an art crop with a hard top edge looks like.
        let mut img = RgbImage::from_pixel(488, 680, Rgb([120, 118, 110]));
        for y in 30..70 {
            for x in 20..468 {
                img.put_pixel(x, y, Rgb([235, 233, 228]));
            }
        }
        let c = cardness(&img);
        assert!(c.title > 0.5, "the title band should be found");
        assert!(c.type_line < 0.2, "there is no type line to find");
        assert!(!c.is_card(), "one band alone scored {:.3}", c.score);
    }

    #[test]
    fn contrast_is_relative_not_absolute() {
        // The same structure, dimmed. A fixed step threshold would call this featureless,
        // which would reject every card photographed in poor light.
        let bright = synthetic_card();
        let dim = RgbImage::from_fn(488, 680, |x, y| {
            let p = bright.get_pixel(x, y);
            Rgb([p[0] / 3 + 20, p[1] / 3 + 20, p[2] / 3 + 20])
        });
        let c = cardness(&dim);
        assert!(c.is_card(), "a dim card scored {:.3}", c.score);
    }

    #[test]
    fn an_upside_down_card_still_scores_as_one() {
        // The regression test for the measured outlier: a correctly matched card scored 0.415
        // with a type-line reading of 0.06 because it had been rectified the other way up.
        let card = synthetic_card();
        let flipped = image::imageops::rotate180(&card);

        let upside_down_only = cardness(&flipped);
        assert!(
            upside_down_only.type_line < 0.3,
            "the fixture is not actually exercising the flip: {upside_down_only:?}"
        );

        let (best, rotated) = cardness_oriented(&flipped, &card);
        assert!(rotated, "the flipped orientation should have won");
        assert!(best.is_card(), "an upside-down card scored {:.3}", best.score);
    }

    #[test]
    fn a_flat_image_is_not_a_card() {
        let flat = RgbImage::from_pixel(488, 680, Rgb([90, 90, 90]));
        let c = cardness(&flat);
        assert_eq!(c.full_width_rows, 0);
        assert!(!c.is_card());
    }

    #[test]
    fn a_degenerate_image_does_not_panic() {
        let tiny = RgbImage::from_pixel(2, 2, Rgb([10, 10, 10]));
        let c = cardness(&tiny);
        assert!(!c.is_card());
    }
}
