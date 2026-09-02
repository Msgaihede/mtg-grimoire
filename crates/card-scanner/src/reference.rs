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
    /// Printing id → oracle id. The key the tracker pools evidence on, so a card's reprints
    /// do not split their own vote.
    oracle: HashMap<[u8; ID_LEN], [u8; ID_LEN]>,
    /// Normalized card name → one representative printing per distinct name.
    ///
    /// Names, not printings: OCR reads the name, and every printing of a card shares it. One
    /// representative is enough because the tracker pools by oracle id anyway.
    by_name: HashMap<String, [u8; ID_LEN]>,
}

impl Reference {
    pub fn new(bundle: Bundle) -> Self {
        Reference {
            bundle,
            labels: HashMap::new(),
            art_printings: HashMap::new(),
            oracle: HashMap::new(),
            by_name: HashMap::new(),
        }
    }

    pub fn label_count(&self) -> usize {
        self.labels.len()
    }

    /// Attach corpus labels. Anything unreadable is skipped rather than fatal — a match with
    /// no name is still a match.
    #[cfg(feature = "corpus")]
    pub fn load_labels(&mut self, corpus: &rusqlite::Connection) -> rusqlite::Result<usize> {
        let mut stmt = corpus.prepare(
            "SELECT id, illustration_id, name, set_code, collector_number, lang, released_at,
                    oracle_id
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
                r.get::<_, Option<String>>(7)?,
            ))
        })?;

        let mut n = 0;
        for row in rows.flatten() {
            let (id, illustration_id, label, oracle_id) = row;
            if let Some(raw) = crate::index::parse_uuid(&id) {
                if let Some(o) = oracle_id.as_deref().and_then(crate::index::parse_uuid) {
                    self.oracle.insert(raw, o);
                }
                if let Some(ill) = illustration_id.as_deref().and_then(crate::index::parse_uuid) {
                    self.art_printings.entry(ill).or_default().push(label.clone());
                }
                self.by_name.entry(crate::ocr::normalize(&label.name)).or_insert(raw);
                self.labels.insert(raw, label);
                n += 1;
            }
        }
        Ok(n)
    }

    /// The oracle id for a printing — the identity a card keeps across every reprint.
    ///
    /// Falls back to the printing's own id when no corpus is loaded, which degrades to
    /// per-printing accumulation rather than to nothing.
    pub fn oracle_for(&self, printing: &[u8; ID_LEN]) -> [u8; ID_LEN] {
        self.oracle.get(printing).copied().unwrap_or(*printing)
    }

    /// The label for a raw id, for callers holding ids rather than matches — the tracker
    /// accumulates over ids and needs names only at the point of display.
    pub fn label_for(&self, id: &[u8; ID_LEN]) -> Option<Label> {
        self.labels.get(id).cloned()
    }

    pub fn name_count(&self) -> usize {
        self.by_name.len()
    }

    /// Find the card whose name best matches some OCR output.
    ///
    /// **This searches every name, not just the hash tier's candidates**, and that is the
    /// point of the tier. On a foil under a lamp the hash's top five do not contain the right
    /// card at all, so a step that could only re-rank them would be useless exactly where it
    /// is needed.
    ///
    /// An exact hit on the normalized name is the common case and costs one hash lookup. The
    /// fallback is a bounded edit distance, and it is bounded twice over: only names within
    /// three characters of the read's length are considered, and the distance itself gives up
    /// once it exceeds the budget. Searching 30,000 names unbounded, per frame, at twelve
    /// frames a second, is not a thing that can be done.
    pub fn lookup_by_name(&self, read: &str) -> Option<([u8; ID_LEN], u32)> {
        if read.len() < 4 {
            return None;
        }
        if let Some(id) = self.by_name.get(read) {
            return Some((*id, 0));
        }

        // One edit per four characters, so a long name tolerates more misreads than a short
        // one — a two-character slip in "Strider Ranger of the North" is a good read, and the
        // same slip in "Shock" is a different card.
        let budget = (read.len() / 4).clamp(1, 6) as u32;
        let mut best: Option<([u8; ID_LEN], u32)> = None;
        for (name, id) in &self.by_name {
            if name.len().abs_diff(read.len()) > 3 {
                continue;
            }
            let cap = best.map(|(_, d)| d).unwrap_or(budget + 1);
            if let Some(d) = bounded_edit_distance(name, read, cap.min(budget)) {
                if best.is_none_or(|(_, b)| d < b) {
                    best = Some((*id, d));
                    if d == 0 {
                        break;
                    }
                }
            }
        }
        best
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
        upright: &image::RgbImage,
        rotated: &image::RgbImage,
        k: usize,
        mask: &Mask,
    ) -> MatchReport {
        let kind = self.bundle.kind;
        let bits = self.bundle.bits;

        let t_hash = std::time::Instant::now();
        // `hash_rgb`, not `hash`: the bundle's kind decides whether colour is used, and a
        // grayscale call would silently drop it — matching a colour bundle with a colourless
        // query returns confident nonsense rather than an error.
        let hash_a = crate::hash::hash_rgb(upright, kind, bits);
        let hash_b = crate::hash::hash_rgb(rotated, kind, bits);
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

/// Levenshtein distance, abandoned as soon as it cannot come in under `max`.
///
/// The early exit is what makes this affordable: a full matrix over 30,000 names per frame is
/// not, and almost every name differs from the read in its first few characters.
fn bounded_edit_distance(a: &str, b: &str, max: u32) -> Option<u32> {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len().abs_diff(b.len()) as u32 > max {
        return None;
    }
    let mut prev: Vec<u32> = (0..=b.len() as u32).collect();
    let mut cur = vec![0u32; b.len() + 1];
    for (i, &ca) in a.iter().enumerate() {
        cur[0] = i as u32 + 1;
        let mut row_min = cur[0];
        for (j, &cb) in b.iter().enumerate() {
            let cost = u32::from(ca != cb);
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
            row_min = row_min.min(cur[j + 1]);
        }
        if row_min > max {
            return None; // no completion of this row can finish under budget
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    let d = prev[b.len()];
    (d <= max).then_some(d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::{hash_rgb, HashKind};
    use crate::index::BundleBuilder;
    use image::{ImageBuffer, Rgb};

    fn img(seed: u32) -> image::RgbImage {
        ImageBuffer::from_fn(200, 280, |x, y| {
            let v = (((x * seed + y * (seed + 3)) / 2) % 256) as u8;
            Rgb([v, v, v])
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
            b.push(Section::Card, id(n), &hash_rgb(&img(n as u32), HashKind::DHash, 256));
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
    fn edit_distance_is_bounded_and_correct() {
        assert_eq!(bounded_edit_distance("kitten", "sitting", 5), Some(3));
        assert_eq!(bounded_edit_distance("same", "same", 0), Some(0));
        // Gives up rather than computing a distance it would only discard.
        assert_eq!(bounded_edit_distance("kitten", "sitting", 2), None);
        assert_eq!(bounded_edit_distance("short", "a much longer string", 3), None);
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
