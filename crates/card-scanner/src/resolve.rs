//! Exact mode's resolve: a fixed pipeline of tiers over a short burst of frames, each tier
//! narrowing the survivors of the one before and recording what it did.
//!
//! **Why a pipeline rather than more votes.** Fast mode's tracker pools evidence and reports a
//! card; it never says what was left over when it decided, so a reader has nothing to choose
//! from when the printing is in doubt. A resolve keeps the set: a whole-card search proposes,
//! the title can widen to a card the hash never found (a foil under a lamp, §4 "The name
//! tier"), the collector line can pin a printing, and the re-rank splits what is left by
//! distance. What survives is either one printing or a short list worth showing.
//!
//! **The readers are injected** ([`Readers`]), so every tier here is tested with a hand-built
//! bundle and scripted reads, and needs neither the OCR models nor a photograph.
//!
//! The design is `docs/superpowers/specs/2026-09-15-scanner-modes-and-shipping-design.md` §6.4.

use crate::index::{format_uuid, parse_uuid, Mask, ID_LEN};
use crate::reference::{Label, Reference};
use image::RgbImage;
use std::collections::{HashMap, HashSet};

/// How many candidates the whole-card tier takes from each view of the burst.
pub const EXACT_TOP: usize = 32;
/// Bits the best survivor must lead the second by to be resolved alone. Initially 6; the
/// synthetic evaluation is what sets it.
pub const EXACT_MARGIN_BITS: u32 = 6;
/// The longest list an ambiguous outcome reports. A picker longer than this is not a choice
/// anybody makes.
pub const EXACT_MAX_CHOICES: usize = 12;

type Id = [u8; ID_LEN];

/// What a resolve came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// One printing survived.
    Resolved,
    /// Several did, best first; the reader picks.
    Ambiguous,
    /// Nothing survived: nothing inside the gate and no name read.
    NotFound,
}

/// One printing a resolve offers.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ChoiceView {
    pub id: String,
    /// `None` when the corpus has no oracle for the printing — never the printing id standing in
    /// for one.
    pub oracle_id: Option<String>,
    pub label: Option<Label>,
    /// The best normalized distance this printing reached across the burst. `None` for a
    /// printing no search ever matched — a collector read can name a printing the bundle lacks.
    pub distance: Option<f32>,
}

/// What one tier did.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TierView {
    /// `filters`, `whole_card`, `title`, `collector`, `re_rank` or `classifier`.
    pub tier: String,
    /// Printings left after this tier.
    pub survivors: usize,
    /// In words: the read name, the collector pairing, a conflict, the margin.
    pub detail: String,
}

/// A completed resolve.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ResolutionView {
    pub outcome: Outcome,
    /// Best first, at most [`EXACT_MAX_CHOICES`]. Empty for [`Outcome::NotFound`].
    pub choices: Vec<ChoiceView>,
    /// Every tier, in order, including the ones that changed nothing.
    pub tiers: Vec<TierView>,
    pub elapsed_ms: f32,
}

/// One locked frame of the burst: the rectified card both ways up, the extra framings, and how
/// card-like it looked.
pub struct BurstView<'a> {
    pub upright: &'a RgbImage,
    pub flipped: &'a RgbImage,
    pub alternates: &'a [(RgbImage, RgbImage)],
    pub cardness: f32,
}

impl BurstView<'_> {
    /// The primary framing first, then the alternates — the shape
    /// [`Reference::match_views`] takes.
    fn framings(&self) -> Vec<(&RgbImage, &RgbImage)> {
        let mut views = vec![(self.upright, self.flipped)];
        views.extend(self.alternates.iter().map(|(a, b)| (a, b)));
        views
    }
}

/// What the readers found — injected, so the tiers are testable without models.
pub trait Readers {
    /// The normalized title text when the read is usable.
    fn title(&self, view: &BurstView<'_>) -> Option<String>;
    /// The collector line's (set, number) parse candidates.
    fn collector(&self, view: &BurstView<'_>) -> Vec<(String, String)>;
}

/// No readers at all — no models loaded, or the `ocr` feature is off. Both reader tiers then
/// report `no read` and change nothing.
pub struct NoReaders;

impl Readers for NoReaders {
    fn title(&self, _: &BurstView<'_>) -> Option<String> {
        None
    }
    fn collector(&self, _: &BurstView<'_>) -> Vec<(String, String)> {
        Vec::new()
    }
}

/// Run every tier over `burst`, under `mask`, with `max_normalized` as the whole-card gate.
pub fn resolve(
    r: &Reference,
    mask: &Mask,
    burst: &[BurstView<'_>],
    readers: &dyn Readers,
    max_normalized: f32,
) -> ResolutionView {
    let started = std::time::Instant::now();
    let mut tiers = Vec::with_capacity(6);
    let bits = f32::from(r.bundle.bits);
    let named = |p: &Id| r.label_for(p);

    // ---- 0 filters -----------------------------------------------------------------------
    let (admitted, detail) = match mask.len() {
        Some(n) => (n, format!("{n} printings")),
        None => (r.bundle.cards.len(), "unrestricted".to_string()),
    };
    tiers.push(tier("filters", admitted, detail));

    // ---- 1 whole card ----------------------------------------------------------------------
    // The best normalized distance each printing reached anywhere in the burst. Kept for every
    // later tier: the re-rank orders on it and every choice reports it.
    let mut best: HashMap<Id, f32> = HashMap::new();
    for view in burst {
        for c in r.match_views(&view.framings(), EXACT_TOP, mask).candidates {
            if c.normalized <= max_normalized {
                if let Some(p) = parse_uuid(&c.id) {
                    keep_best(&mut best, p, c.normalized);
                }
            }
        }
    }
    let mut survivors: Vec<Id> = best.keys().copied().collect();
    by_distance(&mut survivors, &best);
    let cards: HashSet<Id> = survivors.iter().map(|p| r.oracle_for(p)).collect();
    let detail = format!("{} printings of {} cards", survivors.len(), cards.len());
    tiers.push(tier("whole_card", survivors.len(), detail));

    // The readers look at the most card-like view, and at the next one only when the first
    // yields nothing — a read costs a third of a second (§4), and one good read is the point.
    let mut order: Vec<&BurstView<'_>> = burst.iter().collect();
    order.sort_by(|a, b| b.cardness.total_cmp(&a.cardness));

    // ---- 2 title ---------------------------------------------------------------------------
    // **An exact read replaces the survivors rather than narrowing them.** It is the foil
    // rescue: the hash's candidates may not contain the card at all, so intersecting with them
    // would throw away exactly the answer this tier exists to find.
    //
    // **A corrected read only narrows.** Measured on the synthetic evaluation, "datn" read as
    // Damn for a Plains and "torm" as Worm: a fuzzy match on a short or garbled read names a
    // real card the hash never suggested, and replacing the survivors with it made Exact wrong
    // about the card five times in 160 where Fast was never wrong. So a corrected read keeps
    // the survivors that are that card, and is ignored when none are — unless the whole-card
    // tier found nothing at all, where the read is the only evidence there is.
    // The card the title settled on, which the collector tier then has to agree with.
    let mut title_card: Option<Id> = None;
    let detail = match order.iter().take(2).find_map(|v| readers.title(v)) {
        None => "no read".to_string(),
        Some(text) => match r.lookup_by_name_masked(&text, mask) {
            Some((card, edits)) => {
                let permitted: Vec<Id> = r
                    .printings_of(&card)
                    .iter()
                    .copied()
                    .filter(|p| mask.permits(p))
                    .collect();
                let name = permitted
                    .first()
                    .and_then(named)
                    .map_or_else(|| format_uuid(&card), |l| l.name);
                let read = format!("read \"{text}\" → {name} (edits {edits})");
                let narrowed: Vec<Id> = survivors
                    .iter()
                    .copied()
                    .filter(|p| r.oracle_for(p) == card)
                    .collect();
                if edits > 0 && !survivors.is_empty() && narrowed.is_empty() {
                    format!("{read}, not among survivors — ignored")
                } else {
                    survivors = if edits == 0 || survivors.is_empty() {
                        permitted
                    } else {
                        narrowed
                    };
                    by_distance(&mut survivors, &best);
                    title_card = Some(card);
                    read
                }
            }
            None => format!("read \"{text}\", no card"),
        },
    };
    tiers.push(tier("title", survivors.len(), detail));

    // ---- 3 collector -----------------------------------------------------------------------
    // **Only a printing of a card already standing can be pinned.** A misread digit does not
    // produce nonsense, it produces a different real printing (§4), so a read naming another
    // card is recorded as a conflict and left out rather than trusted over everything else.
    //
    // **Standing is not enough either.** The basic lands of one set all survive the whole-card
    // tier together, so a Swamp ZNR 272 misread as 280 named a Forest that was among the
    // survivors and pinned it. The pinned card must also be the one the title settled on, or —
    // with no title — the nearest card among the survivors or within the margin of it.
    let pairs = order
        .iter()
        .take(2)
        .map(|v| readers.collector(v))
        .find(|c| !c.is_empty())
        .unwrap_or_default();
    let detail = match r.lookup_collector_masked(&pairs, mask) {
        None => "no read".to_string(),
        Some(printing) => {
            let at = pairs
                .iter()
                .find(|(s, n)| r.lookup_pair(s, n) == Some(printing))
                .map_or_else(String::new, |(s, n)| format!("{} {n}", s.to_uppercase()));
            let card = r.oracle_for(&printing);
            let name = named(&printing).map_or_else(|| format_uuid(&printing), |l| l.name);
            // A card's distance is its nearest printing among the survivors, in bits.
            let card_bits = |c: Option<Id>| {
                survivors
                    .iter()
                    .filter(|p| c.is_none_or(|c| r.oracle_for(p) == c))
                    .filter_map(|p| best.get(p))
                    .map(|n| (n * bits).round())
                    .reduce(f32::min)
            };
            let behind = match (card_bits(Some(card)), card_bits(None)) {
                (Some(d), Some(lead)) => Some(d - lead),
                _ => None,
            };
            let agrees = match title_card {
                Some(t) => t == card,
                None => behind.is_some_and(|b| b < EXACT_MARGIN_BITS as f32),
            };
            if !survivors.iter().any(|p| r.oracle_for(p) == card) {
                format!("conflict: {at} is {name}, not among survivors")
            } else if !agrees {
                match (title_card, behind) {
                    (Some(_), _) => {
                        format!("conflict: {at} is {name}, not the card the title read")
                    }
                    (None, Some(b)) => {
                        format!("conflict: {at} is {name}, {b} bits behind the nearest card")
                    }
                    (None, None) => format!("conflict: {at} is {name}, which has no distance"),
                }
            } else {
                survivors = vec![printing];
                let shown =
                    named(&printing).map_or_else(|| format_uuid(&printing), |l| l.display());
                format!("{at} → {shown}")
            }
        }
    };
    tiers.push(tier("collector", survivors.len(), detail));

    // ---- 4 re-rank -------------------------------------------------------------------------
    let detail = if survivors.len() < 2 {
        "nothing to rank".to_string()
    } else {
        // A survivor the name read brought in may never have cleared the whole-card gate, so
        // it has no distance yet. It gets one from a search restricted to the survivors.
        let unscored: HashSet<Id> = survivors
            .iter()
            .filter(|p| !best.contains_key(*p))
            .copied()
            .collect();
        if !unscored.is_empty() {
            let only = Mask::allow_only(survivors.iter().copied());
            for view in burst {
                for c in r
                    .match_views(&view.framings(), survivors.len(), &only)
                    .candidates
                {
                    if let Some(p) = parse_uuid(&c.id).filter(|p| unscored.contains(p)) {
                        keep_best(&mut best, p, c.normalized);
                    }
                }
            }
        }
        by_distance(&mut survivors, &best);
        let bits_of = |p: &Id| best.get(p).map(|n| (n * bits).round());
        match (bits_of(&survivors[0]), bits_of(&survivors[1])) {
            // Nothing the bundle holds: there is no distance to rank on.
            (None, _) => "no distances".to_string(),
            (Some(_), None) => {
                survivors.truncate(1);
                "unopposed".to_string()
            }
            (Some(first), Some(second)) => {
                let margin = second - first;
                let within = EXACT_MARGIN_BITS as f32;
                if margin >= within {
                    survivors.truncate(1);
                } else {
                    survivors.retain(|p| bits_of(p).is_some_and(|d| d - first < within));
                }
                format!("margin {margin} bits")
            }
        }
    };
    tiers.push(tier("re_rank", survivors.len(), detail));

    // ---- 5 classifier ----------------------------------------------------------------------
    tiers.push(tier("classifier", survivors.len(), "not implemented"));

    let outcome = match survivors.len() {
        0 => Outcome::NotFound,
        1 => Outcome::Resolved,
        _ => Outcome::Ambiguous,
    };
    let choices = survivors
        .iter()
        .take(EXACT_MAX_CHOICES)
        .map(|p| ChoiceView {
            id: format_uuid(p),
            oracle_id: r.oracle_id_of(p).map(|o| format_uuid(&o)),
            label: named(p),
            distance: best.get(p).copied(),
        })
        .collect();
    ResolutionView {
        outcome,
        choices,
        tiers,
        elapsed_ms: started.elapsed().as_secs_f32() * 1000.0,
    }
}

fn tier(name: &str, survivors: usize, detail: impl Into<String>) -> TierView {
    TierView {
        tier: name.to_string(),
        survivors,
        detail: detail.into(),
    }
}

fn keep_best(best: &mut HashMap<Id, f32>, p: Id, normalized: f32) {
    let slot = best.entry(p).or_insert(normalized);
    *slot = slot.min(normalized);
}

/// Nearest first; a printing with no distance last; ties by id, so the order never depends on
/// a hash map's iteration.
fn by_distance(printings: &mut [Id], best: &HashMap<Id, f32>) {
    printings.sort_by(|a, b| match (best.get(a), best.get(b)) {
        (Some(x), Some(y)) => x.total_cmp(y).then_with(|| a.cmp(b)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.cmp(b),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::{hash_rgb, HashKind};
    use crate::index::{BundleBuilder, Section};
    use image::{ImageBuffer, Rgb};
    use std::cell::RefCell;

    fn img(seed: u32) -> RgbImage {
        ImageBuffer::from_fn(200, 280, |x, y| {
            let v = (((x * seed + y * (seed + 3)) / 2) % 256) as u8;
            Rgb([v, v, v])
        })
    }

    fn id(n: u8) -> Id {
        let mut b = [0u8; ID_LEN];
        b[0] = n;
        b
    }

    /// Rows are `(printing, oracle, image seed, name, set, number)`. Each printing's bundle
    /// entry is the hash of `img(seed)`, and its label is attached through `add_label`.
    fn reference(rows: &[(u8, u8, u32, &str, &str, &str)]) -> Reference {
        let mut b = BundleBuilder::new(HashKind::DHash, 256);
        for (p, _, seed, ..) in rows {
            b.push(
                Section::Card,
                id(*p),
                &hash_rgb(&img(*seed), HashKind::DHash, 256),
            );
        }
        let mut r = Reference::new(b.finish(0));
        for (p, o, _, name, set, number) in rows {
            r.add_label(
                id(*p),
                Some(id(*o)),
                None,
                Label {
                    name: (*name).into(),
                    set: (*set).into(),
                    number: (*number).into(),
                    lang: "en".into(),
                    released: "2025-01-01".into(),
                },
            );
        }
        r
    }

    /// Eight different cards, one printing each, printing `n` hashed from `img(n)`.
    fn eight_cards() -> Reference {
        const NAMES: [&str; 8] = [
            "Forest",
            "Shock",
            "Took Reaper",
            "Oliphaunt",
            "Plains",
            "Prey Upon",
            "Suplex",
            "Island",
        ];
        let rows: Vec<(u8, u8, u32, &str, &str, &str)> = (1..=8u8)
            .map(|n| {
                (
                    n,
                    100 + n,
                    n as u32,
                    NAMES[n as usize - 1],
                    "hob",
                    NUMBERS[n as usize - 1],
                )
            })
            .collect();
        reference(&rows)
    }
    const NUMBERS: [&str; 8] = ["1", "2", "3", "4", "5", "6", "7", "8"];

    /// The same frame three times, at descending card-likeness.
    fn burst<'a>(upright: &'a RgbImage, flipped: &'a RgbImage) -> Vec<BurstView<'a>> {
        [0.9, 0.7, 0.5]
            .into_iter()
            .map(|cardness| BurstView {
                upright,
                flipped,
                alternates: &[],
                cardness,
            })
            .collect()
    }

    struct FakeReaders {
        title: Option<String>,
        collector: Vec<(String, String)>,
    }

    impl Readers for FakeReaders {
        fn title(&self, _: &BurstView<'_>) -> Option<String> {
            self.title.clone()
        }
        fn collector(&self, _: &BurstView<'_>) -> Vec<(String, String)> {
            self.collector.clone()
        }
    }

    fn reads(title: Option<&str>, collector: &[(&str, &str)]) -> FakeReaders {
        FakeReaders {
            title: title.map(String::from),
            collector: collector
                .iter()
                .map(|(s, n)| (s.to_string(), n.to_string()))
                .collect(),
        }
    }

    /// Tight enough that only an exact image clears it: about five bits at 256.
    const TIGHT: f32 = 0.02;
    const GATE: f32 = 0.30;

    fn ids(v: &ResolutionView) -> Vec<String> {
        v.choices.iter().map(|c| c.id.clone()).collect()
    }

    #[test]
    fn a_clean_hash_with_no_reads_resolves_to_the_nearest_printing() {
        let r = eight_cards();
        let (up, down) = (img(5), img(99));
        let v = resolve(&r, &Mask::all(), &burst(&up, &down), &NoReaders, GATE);
        assert_eq!(v.outcome, Outcome::Resolved, "{:?}", v.tiers);
        assert_eq!(ids(&v), [format_uuid(&id(5))]);
        assert_eq!(v.choices[0].distance, Some(0.0));
        assert_eq!(v.choices[0].oracle_id, Some(format_uuid(&id(105))));
        assert_eq!(
            v.choices[0].label.as_ref().map(|l| l.name.as_str()),
            Some("Plains")
        );
    }

    #[test]
    fn a_name_read_reaches_a_printing_the_hash_never_found() {
        // The foil under a lamp: nothing clears the gate, and the title is legible.
        let r = eight_cards();
        let (up, down) = (img(200), img(201));
        let v = resolve(
            &r,
            &Mask::all(),
            &burst(&up, &down),
            &reads(Some("took reaper"), &[]),
            TIGHT,
        );
        assert_eq!(
            v.tiers[1].survivors, 0,
            "the premise: the hash found nothing: {:?}",
            v.tiers
        );
        assert!(
            v.tiers[2].detail.contains("Took Reaper"),
            "{:?}",
            v.tiers[2]
        );
        assert_eq!(v.tiers[2].survivors, 1);
        assert!(ids(&v).contains(&format_uuid(&id(3))), "{:?}", v.choices);
    }

    #[test]
    fn a_collector_read_of_another_card_is_a_conflict_and_ignored() {
        // A misread digit names a different real card; the survivors are not handed to it.
        let r = eight_cards();
        let (up, down) = (img(5), img(99));
        let v = resolve(
            &r,
            &Mask::all(),
            &burst(&up, &down),
            &reads(None, &[("hob", "7")]),
            TIGHT,
        );
        assert_eq!(
            v.tiers[1].survivors, 1,
            "the premise: only the exact image clears TIGHT"
        );
        assert!(
            v.tiers[3].detail.starts_with("conflict"),
            "{:?}",
            v.tiers[3]
        );
        assert!(v.tiers[3].detail.contains("Suplex"), "{:?}", v.tiers[3]);
        assert_eq!(
            v.tiers[3].survivors, 1,
            "the survivors changed on a conflict"
        );
        assert_eq!(ids(&v), [format_uuid(&id(5))]);
    }

    #[test]
    fn a_collector_read_of_a_survivor_pins_that_printing() {
        // Two printings of one card that hash identically — only the number can tell them apart.
        let r = reference(&[
            (1, 10, 5, "Forest", "hob", "193"),
            (2, 10, 5, "Forest", "ltr", "270"),
            (3, 30, 3, "Shock", "hob", "100"),
        ]);
        let (up, down) = (img(5), img(99));
        let v = resolve(
            &r,
            &Mask::all(),
            &burst(&up, &down),
            &reads(None, &[("ltr", "270")]),
            GATE,
        );
        assert_eq!(v.outcome, Outcome::Resolved, "{:?}", v.tiers);
        assert_eq!(ids(&v), [format_uuid(&id(2))]);
        assert_eq!(v.tiers[3].detail, "LTR 270 → Forest — LTR 270");
    }

    /// A reference whose entries are `img(5)`'s own descriptor with the given number of bits
    /// flipped — distances chosen exactly rather than hoped for from generated images. Each
    /// entry is a different card.
    fn bits_away(flips: &[u32]) -> Reference {
        let exact = hash_rgb(&img(5), HashKind::DHash, 256);
        let mut b = BundleBuilder::new(HashKind::DHash, 256);
        for (i, n) in flips.iter().enumerate() {
            let mut d = exact;
            for bit in 0..*n as usize {
                d.words[bit / 64] ^= 1 << (bit % 64);
            }
            b.push(Section::Card, id(i as u8 + 1), &d);
        }
        let mut r = Reference::new(b.finish(0));
        for i in 0..flips.len() as u8 {
            let label = Label {
                name: format!("Card {i}"),
                set: "hob".into(),
                number: (i + 1).to_string(),
                lang: "en".into(),
                released: "2025-01-01".into(),
            };
            r.add_label(id(i + 1), Some(id(100 + i)), None, label);
        }
        r
    }

    #[test]
    fn a_lead_of_the_margin_resolves_alone_and_anything_less_is_ambiguous() {
        let (up, down) = (img(5), img(99));

        let r = bits_away(&[0, EXACT_MARGIN_BITS]);
        let v = resolve(&r, &Mask::all(), &burst(&up, &down), &NoReaders, GATE);
        assert_eq!(
            v.tiers[3].survivors, 2,
            "the premise: both cleared the gate: {:?}",
            v.tiers
        );
        assert_eq!(v.outcome, Outcome::Resolved, "{:?}", v.tiers);
        assert_eq!(ids(&v), [format_uuid(&id(1))]);
        assert_eq!(
            v.tiers[4].detail,
            format!("margin {EXACT_MARGIN_BITS} bits")
        );

        // One bit short of the margin keeps the runner-up, and a third card well behind it is
        // still dropped — "within the margin of the best", not "everything that survived".
        let r = bits_away(&[0, EXACT_MARGIN_BITS - 1, 20]);
        let v = resolve(&r, &Mask::all(), &burst(&up, &down), &NoReaders, GATE);
        assert_eq!(
            v.tiers[3].survivors, 3,
            "the premise: all three cleared the gate"
        );
        assert_eq!(v.outcome, Outcome::Ambiguous, "{:?}", v.tiers);
        assert_eq!(
            ids(&v),
            [format_uuid(&id(1)), format_uuid(&id(2))],
            "best first"
        );
    }

    #[test]
    fn a_corrected_read_of_a_card_the_hash_never_suggested_is_ignored() {
        // "shocc" is Shock at one edit. The hash found only the Plains, so the read is a misread
        // that happens to be a real card — the synthetic evaluation's "datn" → Damn.
        let r = eight_cards();
        let (up, down) = (img(5), img(99));
        let v = resolve(
            &r,
            &Mask::all(),
            &burst(&up, &down),
            &reads(Some("shocc"), &[]),
            TIGHT,
        );
        assert_eq!(
            v.tiers[1].survivors, 1,
            "the premise: the hash found the Plains"
        );
        assert_eq!(
            v.tiers[2].detail,
            "read \"shocc\" → Shock (edits 1), not among survivors — ignored"
        );
        assert_eq!(v.tiers[2].survivors, 1);
        assert_eq!(ids(&v), [format_uuid(&id(5))]);

        // A corrected read of a card that *is* among the survivors narrows to it, even when it
        // is not the nearest one.
        let r = bits_away(&[0, 3, 20]);
        let v = resolve(
            &r,
            &Mask::all(),
            &burst(&up, &down),
            &reads(Some("card 2x"), &[]),
            GATE,
        );
        assert_eq!(
            v.tiers[1].survivors, 3,
            "the premise: all three cleared the gate"
        );
        assert_eq!(v.tiers[2].detail, "read \"card 2x\" → Card 2 (edits 1)");
        assert_eq!(ids(&v), [format_uuid(&id(3))]);
    }

    #[test]
    fn a_corrected_read_replaces_when_the_hash_found_nothing() {
        // The foil rescue survives the rule: with nothing inside the gate the read is the only
        // evidence, corrected or not.
        let r = eight_cards();
        let (up, down) = (img(200), img(201));
        let v = resolve(
            &r,
            &Mask::all(),
            &burst(&up, &down),
            &reads(Some("shocc"), &[]),
            TIGHT,
        );
        assert_eq!(
            v.tiers[1].survivors, 0,
            "the premise: the hash found nothing"
        );
        assert_eq!(v.tiers[2].detail, "read \"shocc\" → Shock (edits 1)");
        assert_eq!(v.outcome, Outcome::Resolved, "{:?}", v.tiers);
        assert_eq!(ids(&v), [format_uuid(&id(2))]);
    }

    #[test]
    fn an_exact_read_of_a_card_the_hash_never_suggested_replaces_the_survivors() {
        // The foil rescue when the hash did find something: a lamp's glare can put a wrong card
        // inside the gate as easily as it can leave nothing there. An exact read outranks it —
        // the corrected-read rule narrows, this one replaces.
        let r = eight_cards();
        let (up, down) = (img(5), img(99));
        let v = resolve(
            &r,
            &Mask::all(),
            &burst(&up, &down),
            &reads(Some("shock"), &[]),
            TIGHT,
        );
        assert_eq!(
            v.tiers[1].survivors, 1,
            "the premise: the hash found the Plains: {:?}",
            v.tiers
        );
        assert_eq!(v.tiers[2].detail, "read \"shock\" → Shock (edits 0)");
        assert_eq!(v.tiers[2].survivors, 1);
        assert_eq!(v.outcome, Outcome::Resolved, "{:?}", v.tiers);
        assert_eq!(ids(&v), [format_uuid(&id(2))]);
    }

    #[test]
    fn a_collector_read_of_a_standing_card_far_behind_the_nearest_is_a_conflict() {
        // Swamp ZNR 272 read as 280: the Forest is among the survivors, twenty bits behind the
        // Swamp, and no title named it. The number must not pin it.
        let (up, down) = (img(5), img(99));
        let r = bits_away(&[0, 20]);
        let v = resolve(
            &r,
            &Mask::all(),
            &burst(&up, &down),
            &reads(None, &[("hob", "2")]),
            GATE,
        );
        assert_eq!(
            v.tiers[1].survivors, 2,
            "the premise: both cleared the gate"
        );
        assert_eq!(
            v.tiers[3].detail,
            "conflict: HOB 2 is Card 1, 20 bits behind the nearest card"
        );
        assert_eq!(v.tiers[3].survivors, 2, "a conflict changed the survivors");
        assert_eq!(ids(&v), [format_uuid(&id(1))]);

        // Within the margin of the nearest, the number is what tells them apart.
        let r = bits_away(&[0, EXACT_MARGIN_BITS - 1]);
        let v = resolve(
            &r,
            &Mask::all(),
            &burst(&up, &down),
            &reads(None, &[("hob", "2")]),
            GATE,
        );
        assert_eq!(v.tiers[3].detail, "HOB 2 → Card 1 — HOB 2");
        assert_eq!(ids(&v), [format_uuid(&id(2))]);
    }

    #[test]
    fn a_collector_read_of_the_card_the_title_read_pins_that_printing() {
        // The title settles the card, and the number picks the printing of it — here the
        // printing twenty bits behind its reprint, which the distance alone would never choose.
        let exact = hash_rgb(&img(5), HashKind::DHash, 256);
        let mut far = exact;
        for bit in 0..20 {
            far.words[0] ^= 1 << bit;
        }
        let mut b = BundleBuilder::new(HashKind::DHash, 256);
        b.push(Section::Card, id(1), &exact);
        b.push(Section::Card, id(2), &far);
        let mut r = Reference::new(b.finish(0));
        for (n, set, number) in [(1u8, "hob", "193"), (2, "ltr", "270")] {
            let label = Label {
                name: "Forest".into(),
                set: set.into(),
                number: number.into(),
                lang: "en".into(),
                released: "2025-01-01".into(),
            };
            r.add_label(id(n), Some(id(10)), None, label);
        }
        let (up, down) = (img(5), img(99));
        let v = resolve(
            &r,
            &Mask::all(),
            &burst(&up, &down),
            &reads(Some("forest"), &[("ltr", "270")]),
            GATE,
        );
        assert_eq!(
            v.tiers[2].survivors, 2,
            "the premise: the title read both printings in"
        );
        assert_eq!(v.tiers[3].detail, "LTR 270 → Forest — LTR 270");
        assert_eq!(v.outcome, Outcome::Resolved, "{:?}", v.tiers);
        assert_eq!(ids(&v), [format_uuid(&id(2))]);
    }

    #[test]
    fn reprints_inside_the_margin_are_ambiguous_best_first() {
        let r = reference(&[
            (1, 10, 5, "Forest", "hob", "193"),
            (2, 10, 5, "Forest", "ltr", "270"),
            (3, 30, 3, "Shock", "hob", "100"),
            (4, 40, 11, "Plains", "hob", "194"),
        ]);
        let (up, down) = (img(5), img(99));
        let v = resolve(&r, &Mask::all(), &burst(&up, &down), &NoReaders, GATE);
        assert_eq!(v.outcome, Outcome::Ambiguous, "{:?}", v.tiers);
        assert_eq!(v.choices.len(), 2);
        let mut got = ids(&v);
        got.sort();
        assert_eq!(got, [format_uuid(&id(1)), format_uuid(&id(2))]);
        assert!(v.choices[0].distance <= v.choices[1].distance);
        assert!(
            v.tiers[4].detail.starts_with("margin 0 bits"),
            "{:?}",
            v.tiers[4]
        );
    }

    #[test]
    fn more_than_twelve_survivors_report_twelve() {
        let rows: Vec<(u8, u8, u32, &str, &str, &str)> = (1..=14u8)
            .map(|n| (n, 10, 5, "Forest", "hob", NUMBERS[0]))
            .collect();
        let r = reference(&rows);
        let (up, down) = (img(5), img(99));
        let v = resolve(
            &r,
            &Mask::all(),
            &burst(&up, &down),
            &reads(Some("forest"), &[]),
            GATE,
        );
        assert_eq!(v.tiers[2].survivors, 14, "{:?}", v.tiers);
        assert_eq!(v.tiers[4].survivors, 14);
        assert_eq!(v.outcome, Outcome::Ambiguous);
        assert_eq!(v.choices.len(), EXACT_MAX_CHOICES);
    }

    #[test]
    fn nothing_inside_the_gate_and_no_read_is_not_found() {
        let r = eight_cards();
        let (up, down) = (img(200), img(201));
        let v = resolve(&r, &Mask::all(), &burst(&up, &down), &NoReaders, TIGHT);
        assert_eq!(v.outcome, Outcome::NotFound, "{:?}", v.tiers);
        assert!(v.choices.is_empty());
        assert_eq!(v.tiers[2].detail, "no read");
        assert_eq!(v.tiers[3].detail, "no read");
    }

    #[test]
    fn a_read_name_that_matches_no_card_changes_nothing() {
        let r = eight_cards();
        let (up, down) = (img(5), img(99));
        let v = resolve(
            &r,
            &Mask::all(),
            &burst(&up, &down),
            &reads(Some("zzzzzzzz"), &[]),
            TIGHT,
        );
        assert_eq!(v.tiers[2].detail, "read \"zzzzzzzz\", no card");
        assert_eq!(v.tiers[2].survivors, v.tiers[1].survivors);
    }

    #[test]
    fn every_tier_is_reported_in_order() {
        let r = eight_cards();
        let (up, down) = (img(5), img(99));
        let v = resolve(&r, &Mask::all(), &burst(&up, &down), &NoReaders, GATE);
        let names: Vec<&str> = v.tiers.iter().map(|t| t.tier.as_str()).collect();
        assert_eq!(
            names,
            [
                "filters",
                "whole_card",
                "title",
                "collector",
                "re_rank",
                "classifier"
            ]
        );
        assert_eq!(v.tiers[0].detail, "unrestricted");
        assert_eq!(v.tiers[0].survivors, 8);
        assert_eq!(v.tiers[5].detail, "not implemented");
        assert!(v.elapsed_ms >= 0.0);
    }

    #[test]
    fn the_mask_excludes_a_printing_from_every_tier() {
        // Printing 5 is the exact image, its name is read cleanly, and its collector line is
        // read cleanly. The filters exclude it, so none of the three may bring it back.
        let r = eight_cards();
        let mask = Mask::allow_only((1..=8u8).filter(|n| *n != 5).map(id));
        let (up, down) = (img(5), img(99));
        let v = resolve(
            &r,
            &mask,
            &burst(&up, &down),
            &reads(Some("plains"), &[("hob", "5")]),
            GATE,
        );
        let excluded = format_uuid(&id(5));
        assert!(!ids(&v).contains(&excluded), "{:?}", v.choices);
        assert_eq!(v.tiers[0].detail, "7 printings");
        assert_eq!(v.tiers[2].detail, "read \"plains\", no card");
        assert_eq!(v.tiers[3].detail, "no read");
    }

    #[test]
    fn the_title_is_read_from_the_most_card_like_view_and_once_more_only_on_no_read() {
        struct Recording {
            answer: Option<String>,
            asked: RefCell<Vec<f32>>,
        }
        impl Readers for Recording {
            fn title(&self, view: &BurstView<'_>) -> Option<String> {
                self.asked.borrow_mut().push(view.cardness);
                self.answer.clone()
            }
            fn collector(&self, _: &BurstView<'_>) -> Vec<(String, String)> {
                Vec::new()
            }
        }
        let r = eight_cards();
        let (up, down) = (img(5), img(99));
        let mut views = burst(&up, &down);
        views.reverse(); // least card-like first, so the order has to be chosen

        let silent = Recording {
            answer: None,
            asked: RefCell::new(Vec::new()),
        };
        resolve(&r, &Mask::all(), &views, &silent, GATE);
        assert_eq!(*silent.asked.borrow(), [0.9, 0.7]);

        let reading = Recording {
            answer: Some("plains".into()),
            asked: RefCell::new(Vec::new()),
        };
        resolve(&r, &Mask::all(), &views, &reading, GATE);
        assert_eq!(*reading.asked.borrow(), [0.9]);
    }
}
