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

use crate::filters::ScanFilters;
use crate::index::{format_uuid, Bundle, Mask, Match, Section, ID_LEN};
use std::collections::HashMap;

/// What a printing is called.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
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
    /// Which framing won, as an index into the views handed to [`Reference::match_views`].
    ///
    /// Reported rather than kept private because it says whether the extra framings are
    /// earning their cost: if view 0 always wins, the sweep is dead weight, and if the
    /// outermost always wins, the inset itself is set wrong.
    pub view: usize,
    /// How many framings were searched.
    pub views: usize,
    /// Descriptors computed for this report — one per framing and orientation searched.
    ///
    /// The cost the view lock exists to cut: hashing is ~22 ms a view in release against ~3.5 ms
    /// to search every printing, so this count, not `views`, is what the match costs.
    pub hashes: usize,
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

/// One card filed under a name in [`Reference`]'s name index.
///
/// **A whole name outranks a face name**, and a name's entries are kept in that order: the
/// first card the mask admits is the answer, so the order is the tie-break. 2,153 cards in
/// the corpus have a face named what some other card is named whole (counted 2026-09-30), and
/// 2,065 of them are art-series cards — `Memory Lapse // Memory Lapse` against the Memory Lapse
/// that is played, where a read of `memory lapse` means the second. Within each half, corpus
/// order.
#[derive(Debug, Clone, Copy)]
struct NameEntry {
    card: [u8; ID_LEN],
    /// Filed under one face of an `a // b` name rather than under the whole of it.
    face: bool,
}

/// The bundle and the corpus labels, ready to answer.
pub struct Reference {
    pub bundle: Bundle,
    /// Distinct printings in the bundle's card section — fewer than its entries, since a
    /// double-faced printing is filed once per face.
    bundle_printings: usize,
    labels: HashMap<[u8; ID_LEN], Label>,
    /// `illustration_id` → the first printing that carries it, and how many do. Populated only
    /// when a corpus is loaded; its size is the measured fact that half of all artworks are
    /// shared.
    ///
    /// **An id and a count, where it was every sharing printing's label over again** — a
    /// second copy of all 118 475 labels, five strings apiece, of which a candidate reads the
    /// first and counts the rest. What that cost a host whose memory is never given back is
    /// below ([`Reference::finishes_of`] has the figures).
    art_printings: HashMap<[u8; ID_LEN], ([u8; ID_LEN], usize)>,
    /// Printing id → oracle id. The key the tracker pools evidence on, so a card's reprints
    /// do not split their own vote.
    oracle: HashMap<[u8; ID_LEN], [u8; ID_LEN]>,
    /// Oracle id → every printing of that card, in the order they were added. A printing the
    /// corpus gives no oracle is its own card here, keyed by its own id.
    ///
    /// What lets a filtered name read ask the question that matters — does this card have
    /// *any* printing the filters permit — and what Exact's title tier widens a read name to.
    oracle_printings: HashMap<[u8; ID_LEN], Vec<[u8; ID_LEN]>>,
    /// Normalized card name → every card that bears it, as oracle ids (the printing's own id
    /// when it has none). See [`NameEntry`] for the order.
    ///
    /// Names, not printings: OCR reads the name, and every printing of a card shares it. An
    /// oracle rather than a representative printing, so a masked lookup can check the card's
    /// printings against the filters instead of one arbitrary printing of it.
    ///
    /// **Every card, not the first.** 244 normalized names in the corpus belong to more than
    /// one oracle (counted 2026-09-30) — Ornithopter is a 9ED card and a DMU token — and keeping
    /// one meant a masked read whose first oracle the filters excluded answered `None` for a card
    /// the filters permit.
    ///
    /// **Face names too.** A split, adventure or double-faced card's name is `a // b`, and
    /// what is printed in its title bar is `a` alone — so an exact read of it never matched
    /// exactly, fell through to the fuzzy search, and read `virtue of knowledge` as Price of
    /// Knowledge at four edits.
    by_name: HashMap<String, Vec<NameEntry>>,
    /// `(set, collector number)` to printing — the index the collector line resolves against.
    ///
    /// Lower-cased and with leading zeros stripped on both sides, because the card prints
    /// `0232` and Scryfall stores `232`. Keyed by the pair as one string ([`pair_key`]): one
    /// allocation a printing where a tuple of two `String`s was two, in a table a third the
    /// width.
    by_set_number: HashMap<Box<str>, [u8; ID_LEN]>,
    /// Which finishes each printing exists in, as the corpus's `finishes` column lists them —
    /// `nonfoil`, `foil`, `etched` — as a place in [`Reference::finish_lists`]. See
    /// [`Reference::finishes_of`].
    finishes: HashMap<[u8; ID_LEN], u32>,
    /// Every distinct list of finishes a printing has been given, once each. The corpus has
    /// eight (counted 2026-10-07), where each printing used to own a `Vec` of `String`s.
    finish_lists: Vec<Vec<String>>,
}

/// [`Reference::snapshot`]'s answer. Ordered maps, so two of them compare and print alike
/// whatever order the reference's own maps iterate in.
#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Snapshot {
    labels: std::collections::BTreeMap<[u8; ID_LEN], Label>,
    art: std::collections::BTreeMap<[u8; ID_LEN], (Option<Label>, usize)>,
    oracle: std::collections::BTreeMap<[u8; ID_LEN], [u8; ID_LEN]>,
    oracle_printings: std::collections::BTreeMap<[u8; ID_LEN], Vec<[u8; ID_LEN]>>,
    by_name: std::collections::BTreeMap<String, Vec<([u8; ID_LEN], bool)>>,
    by_set_number: std::collections::BTreeMap<(String, String), [u8; ID_LEN]>,
    finishes: std::collections::BTreeMap<[u8; ID_LEN], Vec<String>>,
}

/// The shortest read [`Reference::lookup_cards_masked`] will take as the start of a longer name.
///
/// Long enough that a prefix is a name rather than a word: "lightning b" (11) is still a
/// dozen cards, "faramir field comma" (19) is one.
pub const PREFIX_MIN_READ: usize = 12;

/// What a title read named. See [`Reference::lookup_cards_masked`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameHits {
    /// Oracle ids (a printing's own id where the corpus has none), sorted.
    pub cards: Vec<[u8; ID_LEN]>,
    /// The corrections the read needed — 0 for an exact read and for a prefix.
    pub edits: u32,
    /// The read is the start of each name rather than the whole of it.
    pub prefix: bool,
}

impl Reference {
    pub fn new(bundle: Bundle) -> Self {
        let bundle_printings =
            bundle.cards.ids.iter().collect::<std::collections::HashSet<_>>().len();
        Reference {
            bundle,
            bundle_printings,
            labels: HashMap::new(),
            art_printings: HashMap::new(),
            oracle: HashMap::new(),
            oracle_printings: HashMap::new(),
            by_name: HashMap::new(),
            by_set_number: HashMap::new(),
            finishes: HashMap::new(),
            finish_lists: Vec::new(),
        }
    }

    /// How many printings the bundle can recognise by appearance: its card section's distinct
    /// ids, not its entries.
    pub fn bundle_printings(&self) -> usize {
        self.bundle_printings
    }

    pub fn label_count(&self) -> usize {
        self.labels.len()
    }

    /// Everything the labels put into this reference that a caller can see, in an order of its
    /// own — so two references built two ways can be held to each other
    /// (`labels::tests`, where one is `load_labels`' and the other came through bytes).
    ///
    /// What an index *answers*, not how it is kept: an artwork is its first label and how many
    /// printings share it, which is all [`Reference::candidate`] reads of one.
    #[cfg(test)]
    pub(crate) fn snapshot(&self) -> Snapshot {
        Snapshot {
            labels: self.labels.iter().map(|(id, l)| (*id, l.clone())).collect(),
            art: self
                .art_printings
                .iter()
                .map(|(id, (first, n))| (*id, (self.labels.get(first).cloned(), *n)))
                .collect(),
            oracle: self.oracle.iter().map(|(id, o)| (*id, *o)).collect(),
            oracle_printings: self
                .oracle_printings
                .iter()
                .map(|(id, v)| (*id, v.clone()))
                .collect(),
            by_name: self
                .by_name
                .iter()
                .map(|(name, v)| (name.clone(), v.iter().map(|e| (e.card, e.face)).collect()))
                .collect(),
            by_set_number: self
                .by_set_number
                .iter()
                .map(|(k, id)| (pair_of(k).expect("a key `pair_key` made"), *id))
                .collect(),
            finishes: self
                .finishes
                .keys()
                .map(|id| (*id, self.finishes_of(id).to_vec()))
                .collect(),
        }
    }

    /// Attach corpus labels. Anything unreadable is skipped rather than fatal — a match with
    /// no name is still a match.
    ///
    /// What a row is read as and how it is attached are [`crate::labels::Row`]'s — the same
    /// two a host with no database uses, on rows that were read for it ([`crate::labels`]).
    #[cfg(feature = "corpus")]
    pub fn load_labels(&mut self, corpus: &rusqlite::Connection) -> rusqlite::Result<usize> {
        let mut stmt =
            corpus.prepare(&format!("SELECT {} FROM cards", crate::labels::COLUMNS))?;
        let rows = stmt.query_map([], |r| crate::labels::Row::from_sql(r, 0))?;

        let mut n = 0;
        // Twice: a row whose columns would not read, then one whose id is not a UUID.
        for row in rows.flatten().flatten() {
            row.attach(self);
            n += 1;
        }
        Ok(n)
    }

    /// The finishes a printing exists in — `nonfoil`, `foil`, `etched` — or none when the
    /// corpus did not say.
    ///
    /// **A fact the page draws a conclusion from, never one this crate acts on.** More than half
    /// the corpus exists in one finish (counted 2026-10-01: 48,239 non-foil only, 13,548 foil
    /// only, 892 etched only, of 118,610), and for those the tray's finish needs no reading at
    /// all; for the rest, [`crate::ocr::finish_mark`] is what can say which.
    ///
    /// **Three of this struct's indices were made smaller on 2026-10-07, for the browser** (the
    /// light app's step 7.5), where a module's memory is never given back: a printing's
    /// finishes are a place in a list of the distinct lists, an artwork is its first printing
    /// and a count, and a set and number are one string. With the dev corpus's 118 475 labels
    /// attached, the scanner's module stood at 130.3 MB before and at the figure
    /// `docs/reference/card-scanner.md` §2 gives after; nothing a caller can ask changed
    /// (`labels::tests`' whole-corpus run printed the same digest of every index before and
    /// after).
    pub fn finishes_of(&self, printing: &[u8; ID_LEN]) -> &[String] {
        self.finishes
            .get(printing)
            .and_then(|at| self.finish_lists.get(*at as usize))
            .map_or(&[], Vec::as_slice)
    }

    /// Record a printing's finishes — [`Reference::load_labels`]' own, public for a caller with
    /// no SQLite.
    pub fn set_finishes(&mut self, printing: [u8; ID_LEN], finishes: Vec<String>) {
        if finishes.is_empty() {
            return;
        }
        // A handful of distinct lists in any corpus, so finding one is a look along them.
        let at = match self.finish_lists.iter().position(|known| *known == finishes) {
            Some(at) => at,
            None => {
                self.finish_lists.push(finishes);
                self.finish_lists.len() - 1
            }
        };
        self.finishes.insert(printing, at as u32);
    }

    /// Attach one printing's label — the body of [`Reference::load_labels`], public so a
    /// caller with no SQLite (a test, the synthetic evaluation) can build a labelled reference.
    ///
    /// Adding the same printing twice replaces its label and does not list it twice. (An
    /// artwork's label is its first printing's as it stands now; until 2026-10-07 it was a
    /// copy taken when that printing was first added. The corpus never adds one twice.)
    pub fn add_label(
        &mut self,
        id: [u8; ID_LEN],
        oracle: Option<[u8; ID_LEN]>,
        illustration: Option<[u8; ID_LEN]>,
        label: Label,
    ) {
        let fresh = !self.labels.contains_key(&id);
        let card = oracle.unwrap_or(id);
        if let Some(o) = oracle {
            self.oracle.insert(id, o);
        }
        if fresh {
            if let Some(ill) = illustration {
                self.art_printings.entry(ill).or_insert((id, 0)).1 += 1;
            }
            self.oracle_printings.entry(card).or_default().push(id);
        }
        self.index_name(&label.name, card, false);
        if label.name.contains(" // ") {
            for face in label.name.split(" // ") {
                self.index_name(face, card, true);
            }
        }
        // English first: a non-English printing shares the set and number with its English
        // counterpart, and `or_insert` would otherwise hand back whichever language the corpus
        // happened to list first.
        let (set, number) = set_number_key(&label.set, &label.number);
        let key = pair_key(&set, &number);
        if label.lang == "en" {
            self.by_set_number.insert(key, id);
        } else {
            self.by_set_number.entry(key).or_insert(id);
        }
        self.labels.insert(id, label);
    }

    /// File `card` under one name, once, keeping whole names ahead of face names.
    fn index_name(&mut self, name: &str, card: [u8; ID_LEN], face: bool) {
        let entries = self.by_name.entry(crate::ocr::normalize(name)).or_default();
        match entries.iter().position(|e| e.card == card) {
            // A card already filed under this name as a face and now met under it whole —
            // `Forest // Forest` before a plain Forest of the same oracle — moves up.
            Some(i) if entries[i].face && !face => {
                entries.remove(i);
            }
            Some(_) => return,
            None => {}
        }
        let at = if face { entries.len() } else { entries.iter().take_while(|e| !e.face).count() };
        entries.insert(at, NameEntry { card, face });
    }

    /// The first card filed under `name` with a printing the mask admits.
    fn named_card(&self, entries: &[NameEntry], mask: &Mask) -> Option<[u8; ID_LEN]> {
        entries.iter().map(|e| e.card).find(|card| self.card_permitted(card, mask))
    }

    /// The mask a set of filters admits: every labelled printing that passes them.
    ///
    /// Empty filters are [`Mask::all`], which keeps the unfiltered search on its fast path
    /// rather than checking 113,375 ids against a set that holds all of them.
    pub fn mask_for(&self, f: &ScanFilters) -> Mask {
        if f.is_empty() {
            return Mask::all();
        }
        Mask::allow_only(self.labels.iter().filter(|(_, l)| f.permits(l)).map(|(id, _)| *id))
    }

    /// Every printing of a card, by its oracle id. Empty for an id the labels never named.
    pub fn printings_of(&self, oracle: &[u8; ID_LEN]) -> &[[u8; ID_LEN]] {
        self.oracle_printings.get(oracle).map_or(&[], Vec::as_slice)
    }

    /// The corpus oracle id for a printing, and nothing when the corpus has none.
    ///
    /// **No fallback, unlike [`Reference::oracle_for`].** The tracker needs *some* key to pool
    /// on and the printing's own id is a fine one; a reader being told "this is the card's
    /// oracle id" must not be handed a printing id standing in for one.
    pub fn oracle_id_of(&self, printing: &[u8; ID_LEN]) -> Option<[u8; ID_LEN]> {
        self.oracle.get(printing).copied()
    }

    /// Does this card have a printing the mask admits?
    fn card_permitted(&self, card: &[u8; ID_LEN], mask: &Mask) -> bool {
        mask.is_unrestricted() || self.printings_of(card).iter().any(|p| mask.permits(p))
    }

    /// Resolve a collector-line read to the exact printing it names.
    ///
    /// **This is the only tier that can answer which *printing* is in front of the camera.**
    /// The descriptor says which card it looks like and reads a reprint as readily as the
    /// right one; the title says what it is called and every reprint shares that. A set code
    /// and a collector number are an identity, and nothing else the scanner sees is.
    ///
    /// Takes the whole candidate list rather than a parsed pair, because the parse cannot be
    /// done reliably in isolation — see [`crate::ocr::collector_candidates`]. The first
    /// pairing that names a real printing wins, which is what turns a wide guess into a
    /// checked answer.
    pub fn lookup_collector(&self, candidates: &[(String, String)]) -> Option<[u8; ID_LEN]> {
        self.lookup_collector_masked(candidates, &Mask::all())
    }

    /// The same, admitting only a printing the mask permits.
    ///
    /// A pairing that names an excluded printing is skipped rather than ending the search, so
    /// a later pairing that names a permitted one still resolves — the mask narrows what can be
    /// an answer, it does not make a read worse.
    pub fn lookup_collector_masked(
        &self,
        candidates: &[(String, String)],
        mask: &Mask,
    ) -> Option<[u8; ID_LEN]> {
        candidates.iter().find_map(|(set, number)| {
            self.by_set_number
                .get(&*pair_key(set, number))
                .copied()
                .filter(|id| mask.permits(id))
        })
    }

    /// Resolve one (set, number) pairing. The debug view uses this to show what each
    /// candidate the parse produced actually matched, which is the difference between "it
    /// failed" and "it read HOBEN instead of HOB".
    pub fn lookup_pair(&self, set: &str, number: &str) -> Option<[u8; ID_LEN]> {
        self.by_set_number.get(&*pair_key(set, number)).copied()
    }

    /// How many (set, number) pairs are indexed.
    pub fn printing_count(&self) -> usize {
        self.by_set_number.len()
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
    ///
    /// Answers with a printing — the card's first — which is the contract `scan.rs` and the
    /// tracker's observations were written against. See [`Reference::lookup_by_name_masked`]
    /// for the oracle id.
    pub fn lookup_by_name(&self, read: &str) -> Option<([u8; ID_LEN], u32)> {
        let (card, edits) = self.lookup_by_name_masked(read, &Mask::all())?;
        self.printings_of(&card).first().map(|p| (*p, edits))
    }

    /// The same, admitting only a card with at least one printing the mask permits, and
    /// answering with that card's oracle id (its printing's own id when the corpus has none).
    ///
    /// **An exact read of an excluded card is `None`, not its nearest permitted neighbour.** A
    /// clean read of "Shock" says the card is Shock; handing back whichever permitted name is
    /// one edit away would be a confident wrong answer where the honest one is "not in these
    /// filters".
    pub fn lookup_by_name_masked(&self, read: &str, mask: &Mask) -> Option<([u8; ID_LEN], u32)> {
        if read.len() < 4 {
            return None;
        }
        if let Some(entries) = self.by_name.get(read) {
            return self.named_card(entries, mask).map(|card| (card, 0));
        }

        // One edit per four characters, so a long name tolerates more misreads than a short
        // one — a two-character slip in "Strider Ranger of the North" is a good read, and the
        // same slip in "Shock" is a different card.
        let budget = (read.len() / 4).clamp(1, 6) as u32;
        let mut best: Option<([u8; ID_LEN], u32)> = None;
        for (name, entries) in &self.by_name {
            if name.len().abs_diff(read.len()) > 3 {
                continue;
            }
            let cap = best.map(|(_, d)| d).unwrap_or(budget + 1);
            if let Some(d) = bounded_edit_distance(name, read, cap.min(budget)) {
                // The mask is checked only for a name that would win, so a filtered read pays
                // for it on a handful of names rather than on every one within reach.
                if best.is_some_and(|(_, b)| d >= b) {
                    continue;
                }
                if let Some(card) = self.named_card(entries, mask) {
                    best = Some((card, d));
                    if d == 0 {
                        break;
                    }
                }
            }
        }
        best
    }

    /// **Every** card a title read names, under the mask — the set a read limits the hash to.
    ///
    /// [`Reference::lookup_by_name_masked`] answers one card, which is the right shape for a
    /// vote and the wrong one for a limit: a read that ties two names, or a name several
    /// oracles share, has to keep all of them in play and let the dhash choose among their
    /// printings. Three rungs, the first that finds anything wins:
    ///
    /// 1. **Exact** — every permitted card bearing the name.
    /// 2. **Prefix** — a read of at least [`PREFIX_MIN_READ`] characters that the start of one or
    ///    more names spells exactly. A title read is cut short when the band ends before the
    ///    name does, and measured live on 2026-09-30 "faramir field comma" named nothing: every
    ///    name more than three characters longer than a read is skipped by the fuzzy rung, and
    ///    Faramir, Field Commander is four longer. **Before the fuzzy rung**, because within
    ///    reach it counts the missing letters as edits and names whichever one completion is
    ///    shortest — "lightning bolt st" became one of the two cards it starts, at three edits.
    /// 3. **Fuzzy** — every card at the *smallest* edit distance, within the lookup's budget.
    ///
    /// Cards are sorted, because the name index is a `HashMap` and a tie must not change with
    /// its iteration order.
    pub fn lookup_cards_masked(&self, read: &str, mask: &Mask) -> Option<NameHits> {
        if read.len() < 4 {
            return None;
        }
        if let Some(entries) = self.by_name.get(read) {
            let cards = self.named_cards(entries, mask);
            return (!cards.is_empty()).then_some(NameHits { cards, edits: 0, prefix: false });
        }

        let mut cards: Vec<[u8; ID_LEN]> = Vec::new();
        if read.chars().count() >= PREFIX_MIN_READ {
            for (name, entries) in &self.by_name {
                if name.len() > read.len() && name.starts_with(read) {
                    cards.extend(self.named_cards(entries, mask));
                }
            }
            cards.sort_unstable();
            cards.dedup();
            if !cards.is_empty() {
                return Some(NameHits { cards, edits: 0, prefix: true });
            }
        }

        let budget = (read.len() / 4).clamp(1, 6) as u32;
        let mut best = budget + 1;
        for (name, entries) in &self.by_name {
            if name.len().abs_diff(read.len()) > 3 {
                continue;
            }
            let Some(d) = bounded_edit_distance(name, read, best.min(budget)) else { continue };
            let named = self.named_cards(entries, mask);
            if named.is_empty() {
                continue;
            }
            if d < best {
                best = d;
                cards.clear();
            }
            cards.extend(named);
        }
        if !cards.is_empty() {
            cards.sort_unstable();
            cards.dedup();
            return Some(NameHits { cards, edits: best, prefix: false });
        }
        None
    }

    /// Every card in `entries` with a printing the mask permits.
    fn named_cards(&self, entries: &[NameEntry], mask: &Mask) -> Vec<[u8; ID_LEN]> {
        entries.iter().map(|e| e.card).filter(|card| self.card_permitted(card, mask)).collect()
    }

    /// The one printing among `printings` a collector-line read fits, when exactly one does.
    ///
    /// **Matching against a known set rather than parsing blind.** Measured live on
    /// 2026-09-30 (a 1080p webcam, the line about 136×69 source pixels): `U 0014 / LTR • EN`
    /// read as `OO14 TRCN S`, `LTRCN SOG` and `1XRE SOM` — near enough for a person, and not
    /// one of them a clean `(set, number)` pair for [`crate::ocr::collector_candidates`]. The
    /// card is already known by then (the title or the hash named it), so the question is
    /// only *which of its printings*, and that is a much easier one: see
    /// [`crate::ocr::collector_fit`] for what a fit is.
    ///
    /// A printing whose number and set both fit beats one whose number alone does; a number
    /// alone is accepted only when no other candidate shares it. `None` when nothing fits or
    /// two printings fit equally.
    pub fn collector_among(&self, raw: &str, printings: &[[u8; ID_LEN]]) -> Option<[u8; ID_LEN]> {
        let mut fits: Vec<([u8; ID_LEN], crate::ocr::CollectorFit)> = printings
            .iter()
            .filter_map(|p| {
                let l = self.labels.get(p)?;
                crate::ocr::collector_fit(raw, &l.set, &l.number).map(|f| (*p, f))
            })
            .collect();
        fits.sort_by_key(|(_, f)| std::cmp::Reverse(*f));
        match fits.as_slice() {
            [] => None,
            [(p, _)] => Some(*p),
            [(p, a), (_, b), ..] => (a > b).then_some(*p),
        }
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
                Section::Art => self
                    .art_printings
                    .get(&m.id)
                    .and_then(|(first, _)| self.labels.get(first).cloned()),
            },
            printings: match section {
                Section::Card => None,
                Section::Art => self.art_printings.get(&m.id).map(|(_, n)| *n),
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
        self.match_views(&[(upright, rotated)], k, mask)
    }

    /// The same, over several framings of the same card.
    ///
    /// **How tightly the card is framed matters more than anything else here** — swept over
    /// the corpus, the inset alone moves the count of good matches from 1 to 22 — and the
    /// right framing cannot be known before rectifying, because it depends on how sharp that
    /// frame's edge happened to be. So the search is given a few and keeps whichever wins.
    ///
    /// The winner is chosen on the top candidate's distance, exactly as the two orientations
    /// already were. That is the same "more chances to be wrong" risk that hashing both
    /// orientations carries, and it was measured the same way: over the corpus, three framings
    /// took the mean distance from 48.7 to 41.6 with accuracy unchanged at 11/11.
    pub fn match_views(
        &self,
        views: &[(&image::RgbImage, &image::RgbImage)],
        k: usize,
        mask: &Mask,
    ) -> MatchReport {
        self.match_views_field(views, k, mask, crate::index::Field::All)
    }

    /// The same, comparing only one [`crate::index::Field`] of the descriptor.
    pub fn match_views_field(
        &self,
        views: &[(&image::RgbImage, &image::RgbImage)],
        k: usize,
        mask: &Mask,
        field: crate::index::Field,
    ) -> MatchReport {
        self.match_views_weighted(views, k, mask, field, None)
    }

    /// The same, optionally blending the two fields at a chosen chroma weight rather than
    /// letting the bit counts decide it. See [`crate::index::Bundle::search_weighted`].
    pub fn match_views_weighted(
        &self,
        views: &[(&image::RgbImage, &image::RgbImage)],
        k: usize,
        mask: &Mask,
        field: crate::index::Field,
        chroma_weight: Option<f32>,
    ) -> MatchReport {
        let every = every_pick(views.len());
        let found = self.search_picks(views, &every, k, mask, field, chroma_weight);
        self.report(views.len(), found)
    }

    /// Match one frame of a held card, hashing only the way up the stretch has settled on.
    ///
    /// **Three descriptors rather than six, for as long as the held orientation keeps matching.**
    /// A card held in front of the lens does not turn over, so once a frame has said which end
    /// is the top, asking again every frame buys nothing. Hashing is the expensive half of a
    /// match (~22 ms a view in release against ~3.5 ms to search every printing), so this is
    /// where a frame's match time goes — and the three that remain are hashed in parallel.
    ///
    /// **Every framing is still searched.** Holding the framing too — one descriptor a frame —
    /// was built and measured, and the synthetic evaluation refused it: card-correct held in every
    /// stratum, but it changed which *printing* Fast named on nine cards and frames-to-decision on
    /// twenty-one more, because reprints sit a few bits apart and which framing a frame is matched
    /// in decides between them. This orientation-only hold gave per-frame matches identical to
    /// the unheld search on the card traced frame by frame (`docs/reference/card-scanner.md` §3).
    /// Which
    /// framing is right depends on how sharp that frame's edge was, and until the corners are
    /// exact (#703) that is still a per-frame question.
    ///
    /// `held` is the orientation to try — `true` for the 180° rectification, as in
    /// [`MatchReport::rotated`] — and `gate` is the tracker's `max_normalized`. The held
    /// orientation **stands** when its best framing's top candidate comes in under the gate.
    /// Otherwise the frame **widens** to the other orientation as well, exactly as
    /// [`Reference::match_views`] does — the held half's searches are reused rather than repeated
    /// — so a hold that went wrong costs one frame of six hashes and never a card.
    ///
    /// Returns the report and the orientation to hold next frame: `held` again when it stood, the
    /// widened winner's when that was **plain** — under the gate, with the other orientation's
    /// best at least [`ORIENTATION_GAP`] worse — and `None` otherwise, so the next frame searches
    /// both.
    pub fn match_views_held(
        &self,
        views: &[(&image::RgbImage, &image::RgbImage)],
        k: usize,
        mask: &Mask,
        held: Option<bool>,
        gate: f32,
    ) -> (MatchReport, Option<bool>) {
        let field = crate::index::Field::All;
        let mut found: Vec<(ViewPick, Searched)> = Vec::new();
        if let Some(held) = held.filter(|_| !views.is_empty()) {
            let half: Vec<ViewPick> =
                every_pick(views.len()).into_iter().filter(|p| p.rotated == held).collect();
            let searched = self.search_picks(views, &half, k, mask, field, None);
            if winner_of(&searched).1 <= gate {
                return (self.report(views.len(), searched), Some(held));
            }
            found = searched;
        }
        let rest: Vec<ViewPick> = every_pick(views.len())
            .into_iter()
            .filter(|p| !found.iter().any(|(q, _)| q == p))
            .collect();
        found.extend(self.search_picks(views, &rest, k, mask, field, None));
        // Back into canonical order, so the winner is chosen exactly as an unheld match would.
        found.sort_by_key(|(p, _)| (p.view, p.rotated));

        let (pick, best) = winner_of(&found);
        let other = found
            .iter()
            .filter(|(p, _)| p.rotated != pick.rotated)
            .map(|(_, s)| best_of(&s.matches))
            .fold(f32::INFINITY, f32::min);
        let plain = best <= gate && other - best >= ORIENTATION_GAP;
        (self.report(views.len(), found), plain.then_some(pick.rotated))
    }

    /// Hash and search each pick, in parallel when there is more than one — and one after
    /// another where the host has no second thread ([`crate::host::par_map`]).
    ///
    /// **Two phases, each timed as wall time**, so `hash_ms` and `search_ms` stay what a frame
    /// waits for rather than a sum of work done side by side.
    fn search_picks(
        &self,
        views: &[(&image::RgbImage, &image::RgbImage)],
        picks: &[ViewPick],
        k: usize,
        mask: &Mask,
        field: crate::index::Field,
        chroma_weight: Option<f32>,
    ) -> Vec<(ViewPick, Searched)> {
        let (kind, bits) = (self.bundle.kind, self.bundle.bits);
        let t_hash = crate::host::Stopwatch::start();
        // `hash_rgb`, not `hash`: the bundle's kind decides whether colour is used, and a
        // grayscale call would silently drop it — matching a colour bundle with a colourless
        // query returns confident nonsense rather than an error.
        let hashes = crate::host::par_map(picks, |p| {
            let (upright, rotated) = views[p.view];
            crate::hash::hash_rgb(if p.rotated { rotated } else { upright }, kind, bits)
        });
        let hash_ms = t_hash.ms();

        let t_search = crate::host::Stopwatch::start();
        let matches = crate::host::par_map(&hashes, |h| match chroma_weight {
            Some(w) => self.bundle.search_weighted(h, Section::Card, k, mask, w),
            None => self.bundle.search_field(h, Section::Card, k, mask, field),
        });
        let search_ms = t_search.ms();

        // The phase times go on the first entry only, so summing them over any set of entries
        // counts each phase once.
        picks
            .iter()
            .zip(matches)
            .enumerate()
            .map(|(i, (p, matches))| {
                let (hash_ms, search_ms) = if i == 0 { (hash_ms, search_ms) } else { (0.0, 0.0) };
                (*p, Searched { matches, hash_ms, search_ms })
            })
            .collect()
    }

    /// The report for a set of searched picks, in canonical order.
    fn report(&self, views: usize, found: Vec<(ViewPick, Searched)>) -> MatchReport {
        let (pick, _) = winner_of(&found);
        let hashes = found.len();
        let hash_ms = found.iter().map(|(_, s)| s.hash_ms).sum();
        let search_ms = found.iter().map(|(_, s)| s.search_ms).sum();
        let winner =
            found.into_iter().find(|(p, _)| *p == pick).map(|(_, s)| s.matches).unwrap_or_default();
        let margin = match winner.len() {
            0 | 1 => None,
            _ => Some(winner[1].distance.saturating_sub(winner[0].distance)),
        };

        MatchReport {
            section: Section::Card,
            rotated: pick.rotated,
            view: pick.view,
            views,
            hashes,
            candidates: winner.iter().map(|m| self.candidate(Section::Card, m)).collect(),
            margin,
            hash_ms,
            search_ms,
        }
    }
}

/// One framing, one way up — an index into the views handed to a match, and which of the pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ViewPick {
    view: usize,
    rotated: bool,
}

/// How much worse, in normalized distance, the losing orientation's best must be before a match
/// holds its orientation for the frames after it.
///
/// **An upside-down card matches nothing**, so the wrong way up scores what two unrelated
/// printings do — ~0.39, 101 bits of 256 — while the right way up of a card that matched at all
/// is inside the 0.30 gate. 0.05 is 13 bits: a card whose two orientations come that close is
/// one where the hold would be a guess, and those frames keep searching both.
pub const ORIENTATION_GAP: f32 = 0.05;

/// One pick's search, with the phase times it carries (see [`Reference::search_picks`]).
struct Searched {
    matches: Vec<Match>,
    hash_ms: f32,
    search_ms: f32,
}

/// **`normalized`, not `distance`.** This chooses between orientations and between framings,
/// and it has to use the same score the ranking used or it is answering a different question
/// than the one just asked. A field search reports `distance` over the whole descriptor while
/// ranking on one half of it, and a weighted search reports it over both halves while ranking on
/// a blend — so comparing raw bits here picked a different framing than the ranking would have,
/// and the two disagreed on a card.
fn best_of(v: &[Match]) -> f32 {
    v.first().map(|m| m.normalized).unwrap_or(f32::INFINITY)
}

/// Every framing both ways up, primary first and upright before rotated.
fn every_pick(views: usize) -> Vec<ViewPick> {
    (0..views).flat_map(|view| [false, true].map(|rotated| ViewPick { view, rotated })).collect()
}

/// The first pick with the lowest top score. **First, on a tie**: upright over rotated and the
/// primary framing over the alternates, as the matcher has always chosen.
fn winner_of(found: &[(ViewPick, Searched)]) -> (ViewPick, f32) {
    let mut winner = (ViewPick { view: 0, rotated: false }, f32::INFINITY);
    for (i, (p, s)) in found.iter().enumerate() {
        let score = best_of(&s.matches);
        if i == 0 || score < winner.1 {
            winner = (*p, score);
        }
    }
    winner
}

/// A set and a number as the one string [`Reference`] files a printing under: the set's length
/// in bytes, a colon, the set, the number. The length is what keeps two pairs from spelling the
/// same key — `("ab", "c")` and `("a", "bc")` are `2:abc` and `1:abc`.
fn pair_key(set: &str, number: &str) -> Box<str> {
    format!("{}:{set}{number}", set.len()).into_boxed_str()
}

/// The pair a [`pair_key`] was made from, for a test that reads the index back.
#[cfg(test)]
fn pair_of(key: &str) -> Option<(String, String)> {
    let (len, rest) = key.split_once(':')?;
    let len: usize = len.parse().ok()?;
    Some((rest.get(..len)?.to_string(), rest.get(len..)?.to_string()))
}

/// The key both sides of the collector lookup are normalized to.
fn set_number_key(set: &str, number: &str) -> (String, String) {
    let n = number.trim_start_matches('0');
    (
        set.to_ascii_lowercase(),
        if n.is_empty() { "0".to_string() } else { n.to_ascii_lowercase() },
    )
}

/// Levenshtein distance, abandoned as soon as it cannot come in under `max`.
///
/// The early exit is what makes this affordable: a full matrix over 30,000 names per frame is
/// not, and almost every name differs from the read in its first few characters.
/// The corpus's `finishes` column — a JSON array such as `["nonfoil","foil"]` — as the finish
/// names it holds. Unknown words are dropped rather than failing the row, and an absent or
/// unreadable column is no finishes, which [`Reference::finishes_of`] reports as "not said".
#[cfg_attr(not(feature = "corpus"), allow(dead_code))]
pub(crate) fn parse_finishes(column: &str) -> Vec<String> {
    column
        .split(|c: char| !c.is_ascii_alphabetic())
        .filter(|w| matches!(*w, "nonfoil" | "foil" | "etched"))
        .map(String::from)
        .collect()
}

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

    /// **Two pairs never spell one key.** Without the set's length in front, `("ab", "c")` and
    /// `("a", "bc")` are both `abc`, and the second printing filed takes the first one's place.
    #[test]
    fn a_pair_key_is_its_pairs_alone() {
        assert_ne!(pair_key("ab", "c"), pair_key("a", "bc"));
        assert_eq!(&*pair_key("ab", "c"), "2:abc");
        assert_eq!(&*pair_key("a", "bc"), "1:abc");
        // A set with a colon in it, and a number with one: still two keys, and read back whole.
        assert_ne!(pair_key("a:", "b"), pair_key("a", ":b"));
        for (set, number) in [("ab", "c"), ("a", "bc"), ("", "7"), ("p:x", "1★"), ("mh2", "")] {
            assert_eq!(pair_of(&pair_key(set, number)), Some((set.to_owned(), number.to_owned())));
        }
    }
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
    fn the_best_framing_wins_not_the_first() {
        // Three framings of a card, only the last of which is actually the card. A matcher
        // that stopped at the first view, or that let an earlier view's worse distance stand,
        // would report noise — and would do it with the confidence of a top-1.
        let r = reference();
        let views = [(&img(98), &img(97)), (&img(96), &img(95)), (&img(5), &img(94))];
        let report = r.match_views(&views, 3, &Mask::all());
        assert_eq!(report.view, 2, "the winning framing was not the one reported");
        assert_eq!(report.views, 3);
        assert_eq!(report.candidates[0].id, format_uuid(&id(5)));
        assert_eq!(report.candidates[0].distance, 0);
        assert!(!report.rotated, "the upright half of the winning framing matched");
    }

    #[test]
    fn a_framing_can_win_on_its_rotated_half() {
        // The two choices are independent: the winning view may be the second one *and* the
        // rotated half of it. Collapsing them would report the right card the wrong way up.
        let r = reference();
        let views = [(&img(98), &img(97)), (&img(96), &img(9))];
        let report = r.match_views(&views, 3, &Mask::all());
        assert_eq!(report.view, 1);
        assert!(report.rotated, "the rotated half of the second framing should have won");
        assert_eq!(report.candidates[0].id, format_uuid(&id(9)));
    }

    #[test]
    fn one_framing_is_the_old_behaviour_exactly() {
        // `match_card` delegates here, so this pins that the delegation changed nothing.
        let r = reference();
        let a = r.match_card(&img(5), &img(99), 3, &Mask::all());
        let b = r.match_views(&[(&img(5), &img(99))], 3, &Mask::all());
        assert_eq!(a.candidates[0].id, b.candidates[0].id);
        assert_eq!(a.candidates[0].distance, b.candidates[0].distance);
        assert_eq!(b.view, 0);
        assert_eq!(b.views, 1);
    }

    #[test]
    fn a_held_orientation_that_still_matches_hashes_only_its_half() {
        // The card is the rotated half of the second framing, and rotated is held: three framings
        // searched one way up, and the framing is still chosen among them.
        let r = reference();
        let views = [(&img(98), &img(97)), (&img(96), &img(9)), (&img(94), &img(93))];
        let (report, next) = r.match_views_held(&views, 3, &Mask::all(), Some(true), 0.0);
        assert_eq!(report.hashes, 3, "a held orientation that matched still paid for the other");
        assert_eq!((report.view, report.rotated, report.views), (1, true, 3));
        assert_eq!(report.candidates[0].id, format_uuid(&id(9)));
        assert_eq!(next, Some(true), "an orientation that matched let go of its hold");
    }

    #[test]
    fn a_held_orientation_that_stops_matching_widens_and_the_hold_follows_the_card() {
        // Held upright, and the card has turned over. The frame must find it anyway, and hold the
        // way up it now is.
        let r = reference();
        let views = [(&img(98), &img(97)), (&img(96), &img(9))];
        let (report, next) = r.match_views_held(&views, 3, &Mask::all(), Some(false), 0.0);
        assert_eq!(report.hashes, 4, "the held half is searched once, never twice");
        assert_eq!(report.candidates[0].id, format_uuid(&id(9)));
        assert_eq!((report.view, report.rotated), (1, true));
        assert_eq!(next, Some(true));
    }

    #[test]
    fn nothing_is_held_until_one_orientation_plainly_wins() {
        let r = reference();
        // Nothing under the gate: every view searched, nothing held.
        let (report, next) =
            r.match_views_held(&[(&img(98), &img(97))], 3, &Mask::all(), None, 0.0);
        assert_eq!((report.hashes, next), (2, None));
        // Under the gate both ways up: a match, but no orientation to hold.
        let (_, next) = r.match_views_held(&[(&img(5), &img(5))], 3, &Mask::all(), None, 0.3);
        assert_eq!(next, None, "two equal orientations were held as though one had won");
        // One way up matches and the other matches nothing: held.
        let (_, next) = r.match_views_held(&[(&img(5), &img(99))], 3, &Mask::all(), None, 0.3);
        assert_eq!(next, Some(false));
        let (_, next) = r.match_views_held(&[(&img(99), &img(5))], 3, &Mask::all(), None, 0.3);
        assert_eq!(next, Some(true));
    }

    #[test]
    fn a_widened_match_chooses_exactly_as_an_unheld_one() {
        // The held path's widening re-orders what it searched; the answer must not depend on it.
        let r = reference();
        let sets: [&[(&image::RgbImage, &image::RgbImage)]; 4] = [
            &[(&img(98), &img(97)), (&img(96), &img(95)), (&img(5), &img(94))],
            &[(&img(98), &img(97)), (&img(96), &img(9))],
            &[(&img(5), &img(5)), (&img(5), &img(5))],
            &[(&img(98), &img(97))],
        ];
        for views in sets {
            let plain = r.match_views(views, 3, &Mask::all());
            for held in [None, Some(true), Some(false)] {
                let (widened, _) = r.match_views_held(views, 3, &Mask::all(), held, -1.0);
                assert_eq!((widened.view, widened.rotated), (plain.view, plain.rotated));
                assert_eq!(widened.hashes, plain.hashes);
                let ids = |m: &MatchReport| {
                    m.candidates.iter().map(|c| (c.id.clone(), c.distance)).collect::<Vec<_>>()
                };
                assert_eq!(ids(&widened), ids(&plain));
            }
        }
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

    // ---- Filters and the label seam ------------------------------------------------------

    /// A reference whose printings carry labels, attached through `add_label` rather than a
    /// corpus. Rows are `(printing, oracle, name, set, number, released)`; each printing's
    /// bundle entry is the hash of `img(printing)`.
    fn labelled(rows: &[(u8, u8, &str, &str, &str, &str)]) -> Reference {
        let mut b = BundleBuilder::new(HashKind::DHash, 256);
        for (p, ..) in rows {
            b.push(Section::Card, id(*p), &hash_rgb(&img(*p as u32), HashKind::DHash, 256));
        }
        let mut r = Reference::new(b.finish(0));
        for (p, o, name, set, number, released) in rows {
            r.add_label(
                id(*p),
                Some(id(*o)),
                None,
                Label {
                    name: (*name).into(),
                    set: (*set).into(),
                    number: (*number).into(),
                    lang: "en".into(),
                    released: (*released).into(),
                },
            );
        }
        r
    }

    fn three() -> Reference {
        labelled(&[
            (1, 10, "Forest", "hob", "193", "2025-01-01"),
            (2, 10, "Forest", "ltr", "270", "2023-06-23"),
            (3, 20, "Shock", "hob", "100", "2025-01-01"),
        ])
    }

    fn sets(codes: &[&str]) -> ScanFilters {
        ScanFilters { sets: codes.iter().map(|s| s.to_string()).collect(), ..Default::default() }
    }

    #[test]
    fn a_set_filter_permits_exactly_that_sets_printings() {
        let r = three();
        let m = r.mask_for(&sets(&["HOB"]));
        assert!(m.permits(&id(1)) && m.permits(&id(3)) && !m.permits(&id(2)));
    }

    #[test]
    fn a_date_range_is_inclusive_at_both_ends() {
        let r = three();
        let both = ScanFilters {
            released_from: Some("2023-06-23".into()),
            released_to: Some("2025-01-01".into()),
            ..Default::default()
        };
        assert_eq!(r.mask_for(&both).len(), Some(3));
        let later = ScanFilters { released_from: Some("2023-06-24".into()), ..Default::default() };
        assert!(!r.mask_for(&later).permits(&id(2)));
        assert!(r.mask_for(&later).permits(&id(1)));
        let earlier = ScanFilters { released_to: Some("2024-12-31".into()), ..Default::default() };
        assert_eq!(r.mask_for(&earlier).len(), Some(1));
    }

    #[test]
    fn empty_filters_are_unrestricted() {
        let r = three();
        assert!(r.mask_for(&ScanFilters::default()).is_unrestricted());
    }

    #[test]
    fn a_name_read_cannot_resolve_to_a_card_with_no_permitted_printing() {
        let r = three();
        let ltr = r.mask_for(&sets(&["ltr"]));
        assert_eq!(r.lookup_by_name_masked("shock", &ltr), None);
        assert_eq!(r.lookup_by_name_masked("forest", &ltr), Some((id(10), 0)));
        // And a misread of the excluded card does not wander to a permitted neighbour.
        assert_eq!(r.lookup_by_name_masked("shocc", &ltr), None);
        assert_eq!(r.lookup_by_name_masked("shocc", &Mask::all()), Some((id(20), 1)));
    }

    #[test]
    fn a_collector_read_skips_a_pairing_that_names_an_excluded_printing() {
        let r = three();
        let ltr = r.mask_for(&sets(&["ltr"]));
        let c = vec![("hob".to_string(), "193".to_string()), ("ltr".to_string(), "270".to_string())];
        assert_eq!(r.lookup_collector_masked(&c, &ltr), Some(id(2)));
        assert_eq!(r.lookup_collector_masked(&c, &Mask::all()), Some(id(1)));
        assert_eq!(r.lookup_collector(&c), Some(id(1)), "the unmasked contract is unchanged");
    }

    #[test]
    fn printings_of_lists_every_reprint_of_a_card() {
        let r = three();
        assert_eq!(r.printings_of(&id(10)).len(), 2);
        assert_eq!(r.printings_of(&id(20)), &[id(3)]);
        assert!(r.printings_of(&id(99)).is_empty());
    }

    #[test]
    fn the_unmasked_name_lookup_still_answers_with_a_printing() {
        // `scan.rs` and the tracker's observations hold printings, so the old contract keeps
        // its shape: the card's first printing, not its oracle id.
        let r = three();
        assert_eq!(r.lookup_by_name("forest"), Some((id(1), 0)));
        assert_eq!(r.lookup_by_name("shock"), Some((id(3), 0)));
    }

    #[test]
    fn the_finishes_column_reads_as_the_finish_names_it_holds() {
        assert_eq!(parse_finishes(r#"["nonfoil","foil"]"#), ["nonfoil", "foil"]);
        assert_eq!(parse_finishes(r#"["etched"]"#), ["etched"]);
        assert!(parse_finishes("[]").is_empty());
        assert!(parse_finishes("").is_empty(), "an absent column is not said");
        assert!(parse_finishes(r#"["glossy"]"#).is_empty(), "a word this app does not know is dropped");
    }

    #[test]
    fn a_truncated_title_read_names_the_card_it_starts() {
        // Measured live 2026-09-30: the band ended before the name did, and "faramir field
        // comma" named nothing — four characters short is past the fuzzy rung's reach.
        let r = labelled(&[
            (1, 10, "Faramir, Field Commander", "ltr", "14", "2023-06-23"),
            (2, 20, "Faramir, Prince of Ithilien", "ltr", "199", "2023-06-23"),
            (3, 30, "Simulacrum Shaper", "fra", "113", "2025-01-01"),
        ]);
        assert_eq!(r.lookup_by_name_masked("faramir field comma", &Mask::all()), None);
        let hits = r.lookup_cards_masked("faramir field comma", &Mask::all()).expect("a prefix");
        assert_eq!(hits.cards, vec![id(10)]);
        assert!(hits.prefix);
        // A prefix two names share keeps both in play, for the dhash to choose between.
        let hits = r.lookup_cards_masked("faramir pri", &Mask::all());
        assert_eq!(hits, None, "eleven characters is too short to be a name");
        let both = labelled(&[
            (1, 10, "Lightning Bolt Strike", "aaa", "1", "2020-01-01"),
            (2, 20, "Lightning Bolt Storm", "bbb", "2", "2020-01-01"),
        ]);
        let hits = both.lookup_cards_masked("lightning bolt st", &Mask::all()).expect("prefix");
        assert_eq!(hits.cards, vec![id(10), id(20)]);
    }

    #[test]
    fn a_fuzzy_read_keeps_every_card_at_the_nearest_distance() {
        let r = labelled(&[
            (1, 10, "Shock", "m21", "159", "2020-07-03"),
            (2, 20, "Shack", "aaa", "1", "2020-01-01"),
            (3, 30, "Smoke", "bbb", "2", "2020-01-01"),
        ]);
        // "shick" is one edit from both Shock and Shack, and two from Smoke.
        let hits = r.lookup_cards_masked("shick", &Mask::all()).expect("a fuzzy hit");
        assert_eq!((hits.cards, hits.edits, hits.prefix), (vec![id(10), id(20)], 1, false));
    }

    #[test]
    fn a_blurry_collector_read_is_fitted_among_a_known_cards_printings() {
        // Faramir's own printings: the read below is verbatim from the 2026-09-30 live pass.
        let r = labelled(&[
            (1, 10, "Faramir, Field Commander", "ltr", "14", "2023-06-23"),
            (2, 10, "Faramir, Field Commander", "ltr", "426", "2023-06-23"),
            (3, 10, "Faramir, Field Commander", "pltr", "14p", "2023-06-23"),
        ]);
        let all = [id(1), id(2), id(3)];
        assert_eq!(r.collector_among("OO14 TRCN S", &all), Some(id(1)));
        assert_eq!(r.collector_among("U 0426 LTR EN", &all), Some(id(2)));
        // The set alone is two printings of LTR: no answer rather than a guess.
        assert_eq!(r.collector_among("LTRCN SOG", &all), None);
        assert_eq!(r.collector_among("1XRE SOM", &all), None);
        assert_eq!(r.collector_among("", &all), None);

        // Reported live (2026-10-01): an Oliphaunt's `C 0426 / LTR • EN` read as below, and the
        // blind parse's eight pairings (TRAEN 426, TRA 0426, TR 426, …) named nothing. Every
        // printing of the card, from the corpus: the number picks one and `TR` backs its set.
        let o = labelled(&[
            (1, 10, "Oliphaunt", "hoc", "199", "2023-06-23"),
            (2, 10, "Oliphaunt", "ltr", "139", "2023-06-23"),
            (3, 10, "Oliphaunt", "ltr", "426", "2023-06-23"),
            (4, 10, "Oliphaunt", "ltr", "590", "2023-06-23"),
        ]);
        assert_eq!(o.collector_among("C 0426 TRAEN TVIER", &[id(1), id(2), id(3), id(4)]), Some(id(3)));
    }

    #[test]
    fn an_exact_read_of_one_face_names_the_card() {
        // §8 item 12, from the corpus: the title bar of an adventure prints the front face
        // alone. Indexed only as `virtue of knowledge vantress visions`, the read below missed
        // the exact lookup and fell to the fuzzy one, which answered Price of Knowledge at
        // four edits.
        let r = labelled(&[
            (1, 10, "Price of Knowledge", "c13", "89", "2013-11-01"),
            (2, 20, "Virtue of Knowledge // Vantress Visions", "woe", "76", "2023-09-08"),
        ]);
        assert_eq!(r.lookup_by_name("virtue of knowledge"), Some((id(2), 0)));
        assert_eq!(r.lookup_by_name("vantress visions"), Some((id(2), 0)), "the back face");
        assert_eq!(
            r.lookup_by_name("virtue of knowledge vantress visions"),
            Some((id(2), 0)),
            "the whole name still resolves"
        );
        // And a misread of the face now lands on the face, not four edits away.
        assert_eq!(r.lookup_by_name("virtue of knowiedge"), Some((id(2), 1)));
    }

    #[test]
    fn a_whole_name_outranks_the_same_name_as_a_face() {
        // An art-series card is named `Memory Lapse // Memory Lapse`, and its face is the
        // played card's whole name. A read of `memory lapse` is the played card — whichever
        // of the two the corpus happened to list first.
        for rows in [
            [
                (1, 10, "Memory Lapse // Memory Lapse", "astx", "66", "2021-04-23"),
                (2, 20, "Memory Lapse", "sld", "2142", "2025-12-01"),
            ],
            [
                (2, 20, "Memory Lapse", "sld", "2142", "2025-12-01"),
                (1, 10, "Memory Lapse // Memory Lapse", "astx", "66", "2021-04-23"),
            ],
        ] {
            let r = labelled(&rows);
            assert_eq!(r.lookup_by_name("memory lapse"), Some((id(2), 0)));
            // Filtered to the art series, the face still answers.
            let art = r.mask_for(&sets(&["astx"]));
            assert_eq!(r.lookup_by_name_masked("memory lapse", &art), Some((id(10), 0)));
        }
    }

    #[test]
    fn a_name_two_cards_share_answers_for_whichever_the_filters_permit() {
        // §8 item 12's parenthesis, from the corpus: Ornithopter is a 9ED card and a DMU
        // token, two oracles under one name. Keeping one oracle per name made a read filtered
        // to the other one's set answer `None`, for a card the filters permit.
        let r = labelled(&[
            (1, 10, "Ornithopter", "tdmu", "22", "2022-09-09"),
            (2, 20, "Ornithopter", "9ed", "305", "2005-07-29"),
        ]);
        let ninth = r.mask_for(&sets(&["9ed"]));
        assert_eq!(r.lookup_by_name_masked("ornithopter", &ninth), Some((id(20), 0)));
        let token = r.mask_for(&sets(&["tdmu"]));
        assert_eq!(r.lookup_by_name_masked("ornithopter", &token), Some((id(10), 0)));
        // The fuzzy path reads the same list.
        assert_eq!(r.lookup_by_name_masked("ornlthopter", &ninth), Some((id(20), 1)));
        // Unfiltered, corpus order decides, as it always has.
        assert_eq!(r.lookup_by_name("ornithopter"), Some((id(1), 0)));
    }

    #[test]
    fn oracle_id_of_has_no_fallback_where_oracle_for_does() {
        let mut r = three();
        r.add_label(
            id(4),
            None,
            None,
            Label {
                name: "Token".into(),
                set: "thob".into(),
                number: "1".into(),
                lang: "en".into(),
                released: "2025-01-01".into(),
            },
        );
        assert_eq!(r.oracle_id_of(&id(1)), Some(id(10)));
        assert_eq!(r.oracle_id_of(&id(4)), None);
        assert_eq!(r.oracle_for(&id(4)), id(4));
        // A printing with no oracle is its own card for the name lookup.
        assert_eq!(r.lookup_by_name_masked("token", &Mask::all()), Some((id(4), 0)));
        assert_eq!(r.printings_of(&id(4)), &[id(4)]);
    }

    #[cfg(feature = "corpus")]
    #[test]
    fn corpus_miscellaneous_cards_resolve_without_oracle_or_illustration_ids() {
        let rows = [
            (1u8, "token", "Soldier", "tset", "1"),
            (2, "emblem", "Chandra Emblem", "tset", "2"),
            (3, "art_series", "Island // Island", "aset", "3"),
            (4, "normal", "Championship Trophy", "mset", "4"),
        ];
        let corpus = rusqlite::Connection::open_in_memory().unwrap();
        corpus
            .execute_batch(
                "CREATE TABLE cards (
                id TEXT, illustration_id TEXT, name TEXT, set_code TEXT,
                collector_number TEXT, lang TEXT, released_at TEXT, oracle_id TEXT,
                finishes TEXT, layout TEXT, set_type TEXT
            )",
            )
            .unwrap();
        let mut bundle = BundleBuilder::new(HashKind::DHash, 256);
        for (p, layout, name, set, number) in rows {
            corpus
                .execute(
                    "INSERT INTO cards VALUES (?1, NULL, ?2, ?3, ?4, 'en', '2025-01-01',
                    NULL, '[\"nonfoil\"]', ?5, ?6)",
                    rusqlite::params![
                        format_uuid(&id(p)),
                        name,
                        set,
                        number,
                        layout,
                        if p == 4 { "memorabilia" } else { "token" }
                    ],
                )
                .unwrap();
            bundle.push(Section::Card, id(p), &hash_rgb(&img(p as u32), HashKind::DHash, 256));
        }
        let mut reference = Reference::new(bundle.finish(0));
        assert_eq!(reference.load_labels(&corpus).unwrap(), rows.len());
        for (p, _, name, set, number) in rows {
            let filters = ScanFilters {
                sets: vec![set.into()],
                released_from: Some("2025-01-01".into()),
                released_to: Some("2025-01-01".into()),
            };
            let mask = reference.mask_for(&filters);
            assert!(mask.permits(&id(p)));
            assert_eq!(reference.oracle_id_of(&id(p)), None);
            assert_eq!(reference.printings_of(&id(p)), &[id(p)]);
            assert_eq!(reference.label_for(&id(p)).unwrap().name, name);
            let read = crate::ocr::normalize(name);
            assert_eq!(reference.lookup_by_name_masked(&read, &mask), Some((id(p), 0)));
            assert_eq!(
                reference.lookup_collector_masked(&[(set.into(), number.into())], &mask),
                Some(id(p))
            );
            let matched = reference.match_card(&img(p as u32), &img(99), 1, &mask);
            assert_eq!(matched.candidates[0].id, format_uuid(&id(p)));
            assert_eq!(matched.candidates[0].distance, 0);
            assert_eq!(matched.candidates[0].label.as_ref().unwrap().name, name);

            let excluded = reference.mask_for(&ScanFilters {
                released_from: Some("2025-01-02".into()),
                ..filters
            });
            assert!(!excluded.permits(&id(p)));
            assert_eq!(reference.lookup_by_name_masked(&read, &excluded), None);
            assert_eq!(
                reference.lookup_collector_masked(&[(set.into(), number.into())], &excluded),
                None
            );
            assert!(reference
                .match_card(&img(p as u32), &img(99), 1, &excluded)
                .candidates
                .is_empty());
        }
        let art = reference.mask_for(&sets(&["aset"]));
        assert_eq!(reference.lookup_by_name_masked("island", &art), Some((id(3), 0)));
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
