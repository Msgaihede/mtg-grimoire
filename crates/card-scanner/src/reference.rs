//! The reference side of a match: the bundle, plus what an id actually *is*.
//!
//! A search over [`crate::index::Bundle`] answers with a 16-byte Scryfall id, which is the
//! right thing to store and the wrong thing to show anyone. This module joins that id back to
//! the corpus so a match can be read as "Forest — HOB 0193".
//!
//! **The labels are loaded into memory once rather than queried per match.** 113,375 rows of
//! name, set and collector number is a few megabytes, and the alternative is a SQL round trip
//! inside a loop that runs several times a second on every frame — with a lock around the
//! connection, since SQLite has one writer and this is shared across worker threads. Reading
//! it once removes the lock, the query and the failure mode together.
//!
//! Opening a corpus is optional throughout. A bundle with no corpus beside it still matches;
//! it simply answers with ids, which is enough to prove the pipeline works.

use crate::index::{format_uuid, Bundle, Mask, Match, Section, ID_LEN};
use std::collections::HashMap;

/// What a printing is called.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Label {
    pub name: String,
    pub set: String,
    pub number: String,
    pub lang: String,
    pub released: String,
}

impl Label {
    /// "Forest — HOB 0193", the form a person reads.
    pub fn display(&self) -> String {
        format!("{} — {} {}", self.name, self.set.to_uppercase(), self.number)
    }
}

/// One ranked answer, with the reference resolved.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Candidate {
    pub id: String,
    pub distance: u32,
    /// Distance over the descriptor's width, so a threshold means the same thing at 128 and
    /// 256 bits.
    pub normalized: f32,
    /// `None` when no corpus was loaded, or when the bundle names an id this corpus does not.
    pub label: Option<Label>,
    /// How many printings share this artwork. Only meaningful for an art-section hit, and the
    /// reason an art match cannot identify a printing on its own.
    pub printings: Option<usize>,
}

/// A completed match against one section.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MatchReport {
    pub section: Section,
    /// Whether the upright or the 180°-rotated rectification won.
    ///
    /// A card is 180°-symmetric, so both are hashed and the better kept. This field is how a
    /// reader can see that happening — a scan that consistently reports `rotated` is a scan
    /// being held upside-down, which is worth knowing and is invisible otherwise.
    pub rotated: bool,
    pub candidates: Vec<Candidate>,
    /// Computing the two descriptors, which is a Lanczos3 downsample of a 488x680 card to a
    /// 17x8 grid and back — separated from the search because they scale with completely
    /// different things. Hashing is fixed per frame; searching grows with the bundle.
    pub hash_ms: f32,
    /// Bits between the best and second-best answer.
    ///
    /// The number that decides whether a fast-mode match is confident or provisional: a small
    /// margin means the runner-up is nearly as good an explanation of the pixels.
    pub margin: Option<u32>,
    pub search_ms: f32,
}

/// The bundle and the corpus labels, ready to answer.
pub struct Reference {
    pub bundle: Bundle,
    labels: HashMap<[u8; ID_LEN], Label>,
    /// `illustration_id` → every printing that shares it. Populated only when a corpus is
    /// loaded; its size is the measured fact that half of all artworks are shared.
    art_printings: HashMap<[u8; ID_LEN], Vec<Label>>,
}

impl Reference {
    pub fn new(bundle: Bundle) -> Self {
        Reference { bundle, labels: HashMap::new(), art_printings: HashMap::new() }
    }

    pub fn label_count(&self) -> usize {
        self.labels.len()
    }

    /// Attach corpus labels. Anything unreadable is skipped rather than fatal — a match with
    /// no name is still a match.
    #[cfg(feature = "corpus")]
    pub fn load_labels(&mut self, corpus: &rusqlite::Connection) -> rusqlite::Result<usize> {
        let mut stmt = corpus.prepare(
            "SELECT id, illustration_id, name, set_code, collector_number, lang, released_at
             FROM cards",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                Label {
                    name: r.get(2)?,
                    set: r.get(3)?,
                    number: r.get(4)?,
                    lang: r.get(5)?,
                    released: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                },
            ))
        })?;

        let mut n = 0;
        for row in rows.flatten() {
            let (id, illustration_id, label) = row;
            if let Some(raw) = crate::index::parse_uuid(&id) {
                if let Some(ill) = illustration_id.as_deref().and_then(crate::index::parse_uuid) {
                    self.art_printings.entry(ill).or_default().push(label.clone());
                }
                self.labels.insert(raw, label);
                n += 1;
            }
        }
        Ok(n)
    }

    fn candidate(&self, section: Section, m: &Match) -> Candidate {
        Candidate {
            id: format_uuid(&m.id),
            distance: m.distance,
            normalized: m.normalized,
            label: match section {
                Section::Card => self.labels.get(&m.id).cloned(),
                // An art id is an illustration, not a printing, so the label shown is the
                // first printing that carries it — with `printings` alongside saying how many
                // others it could equally be.
                Section::Art => self.art_printings.get(&m.id).and_then(|v| v.first().cloned()),
            },
            printings: match section {
                Section::Card => None,
                Section::Art => self.art_printings.get(&m.id).map(|v| v.len()),
            },
        }
    }

    /// Match a rectified card against the whole-card section, trying both orientations.
    ///
    /// **Both, always.** 63×88 mm is 180°-symmetric, so a quad tells you the rectangle but
    /// never which end is the top; a card photographed upside-down rectifies perfectly and
    /// then matches nothing. Hashing twice costs one extra scan of a structure that is
    /// already a few hundred thousand popcounts, which is far cheaper than being wrong half
    /// the time.
    pub fn match_card(
        &self,
        upright: &image::GrayImage,
        rotated: &image::GrayImage,
        k: usize,
        mask: &Mask,
    ) -> MatchReport {
        let kind = self.bundle.kind;
        let bits = self.bundle.bits;

        let t_hash = std::time::Instant::now();
        let hash_a = crate::hash::hash(upright, kind, bits);
        let hash_b = crate::hash::hash(rotated, kind, bits);
        let hash_ms = t_hash.elapsed().as_secs_f32() * 1000.0;

        let started = std::time::Instant::now();
        let a = self.bundle.search(&hash_a, Section::Card, k, mask);
        let b = self.bundle.search(&hash_b, Section::Card, k, mask);

        let best_of = |v: &[Match]| v.first().map(|m| m.distance).unwrap_or(u32::MAX);
        let use_rotated = best_of(&b) < best_of(&a);
        let winner = if use_rotated { b } else { a };

        let margin = match winner.len() {
            0 | 1 => None,
            _ => Some(winner[1].distance.saturating_sub(winner[0].distance)),
        };

        MatchReport {
            section: Section::Card,
            rotated: use_rotated,
            candidates: winner.iter().map(|m| self.candidate(Section::Card, m)).collect(),
            margin,
            hash_ms,
            search_ms: started.elapsed().as_secs_f32() * 1000.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::{hash, HashKind};
    use crate::index::BundleBuilder;
    use image::{ImageBuffer, Luma};

    fn img(seed: u32) -> image::GrayImage {
        ImageBuffer::from_fn(200, 280, |x, y| {
            Luma([(((x * seed + y * (seed + 3)) / 2) % 256) as u8])
        })
    }

    fn id(n: u8) -> [u8; ID_LEN] {
        let mut b = [0u8; ID_LEN];
        b[0] = n;
        b
    }

    /// A bundle whose entry `n` is the hash of `img(n)`.
    fn reference() -> Reference {
        let mut b = BundleBuilder::new(HashKind::DHash, 256);
        for n in 1..=12u8 {
            b.push(Section::Card, id(n), &hash(&img(n as u32), HashKind::DHash, 256));
        }
        Reference::new(b.finish(0))
    }

    #[test]
    fn finds_the_exact_card() {
        let r = reference();
        let target = img(5);
        let report = r.match_card(&target, &img(99), 3, &Mask::all());
        assert_eq!(report.candidates[0].id, format_uuid(&id(5)));
        assert_eq!(report.candidates[0].distance, 0);
        assert!(!report.rotated, "the upright image was the match");
    }

    #[test]
    fn prefers_whichever_orientation_matches() {
        // The 180° case: the upright rectification is noise and the rotated one is the card.
        let r = reference();
        let report = r.match_card(&img(99), &img(7), 3, &Mask::all());
        assert!(report.rotated, "the rotated orientation should have won");
        assert_eq!(report.candidates[0].id, format_uuid(&id(7)));
        assert_eq!(report.candidates[0].distance, 0);
    }

    #[test]
    fn margin_separates_a_confident_match_from_a_contested_one() {
        let r = reference();
        let report = r.match_card(&img(5), &img(99), 3, &Mask::all());
        // An exact hit against unrelated entries must have a wide margin; this is the
        // quantity fast mode uses to decide whether to mark a pick provisional.
        assert!(
            report.margin.expect("two candidates") > 20,
            "an exact match had a margin of only {:?}",
            report.margin
        );
    }

    #[test]
    fn no_labels_still_yields_candidates() {
        // A bundle with no corpus beside it must still answer, with ids rather than names.
        let r = reference();
        let report = r.match_card(&img(3), &img(99), 2, &Mask::all());
        assert!(!report.candidates.is_empty());
        assert!(report.candidates[0].label.is_none());
        assert_eq!(r.label_count(), 0);
    }

    #[test]
    fn a_mask_restricts_what_can_be_matched() {
        // The filters requirement: an excluded printing must not be a possible answer, and
        // the result set must still fill up.
        let r = reference();
        let mask = Mask::allow_only((1..=12u8).filter(|n| *n != 5).map(id));
        let report = r.match_card(&img(5), &img(99), 3, &mask);
        assert_eq!(report.candidates.len(), 3);
        assert!(report.candidates.iter().all(|c| c.id != format_uuid(&id(5))));
        assert!(report.candidates[0].distance > 0, "the excluded exact match leaked in");
    }

    #[test]
    fn label_display_is_readable() {
        let l = Label {
            name: "Forest".into(),
            set: "hob".into(),
            number: "0193".into(),
            lang: "en".into(),
            released: "2026-01-01".into(),
        };
        assert_eq!(l.display(), "Forest — HOB 0193");
    }
}
