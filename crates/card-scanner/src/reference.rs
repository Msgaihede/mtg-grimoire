//! What an id *is*: the corpus labels, joined back to the printings the scanner names.
//!
//! The recogniser answers with a 16-byte Scryfall id, which is the right thing to store and the
//! wrong thing to show anyone. This module joins that id back to the corpus so a match can be
//! read as "Forest — HOB 0193", and keeps the facts a filter is built from: set, release date,
//! promo and token.
//!
//! **The labels are loaded into memory once rather than queried per match.** 118,000 rows of
//! name, set and collector number is a few megabytes, and the alternative is a SQL round trip
//! inside a loop that runs several times a second on every frame — with a lock around the
//! connection, since SQLite has one writer. Reading it once removes the lock, the query and the
//! failure mode together.
//!
//! Labels are optional throughout. A session with none still recognises cards; it answers with
//! ids, and refuses a filter, which has nothing to be built from.

use crate::filters::ScanFilters;
use crate::ids::{Id, Mask};
use std::collections::{HashMap, HashSet};

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

/// One ranked answer, with the label resolved.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Candidate {
    pub id: String,
    /// `normalized` × 256, so a reader that reads distances as 0–256 bits still holds.
    pub distance: u32,
    /// (1 − cosine) / 2: 0 for the picture itself, 1 for its opposite.
    pub normalized: f32,
    /// `None` when no labels were loaded, or when they do not name this id.
    pub label: Option<Label>,
    /// How many printings photograph alike under this look — the reason a look cannot always
    /// identify a printing on its own.
    pub printings: Option<usize>,
}

/// What the card a frame voted for matched.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MatchReport {
    /// Whether the card was read upside down. A scan that reports `rotated` every frame is a
    /// card being held upside down, which is worth knowing and is invisible otherwise.
    pub rotated: bool,
    /// The card's best looks, best first.
    pub candidates: Vec<Candidate>,
    /// The lead of the best look over the best look of another card, as a 128th of a cosine.
    pub margin: Option<u32>,
}

/// The corpus labels, ready to answer.
#[derive(Debug, Default)]
pub struct Reference {
    labels: HashMap<Id, Label>,
    /// Printing id → oracle id.
    oracle: HashMap<Id, Id>,
    /// Which finishes each printing exists in, as the corpus's `finishes` column lists them —
    /// `nonfoil`, `foil`, `etched` — as a place in [`Reference::finish_lists`]. See
    /// [`Reference::finishes_of`].
    finishes: HashMap<Id, u32>,
    /// Every distinct list of finishes a printing has been given, once each. The corpus has
    /// eight (counted 2026-10-07), where each printing used to own a `Vec` of `String`s.
    finish_lists: Vec<Vec<String>>,
    /// The printings the corpus marks a promo (its `promo` column), and only those — a set of
    /// the few rather than a flag on every label. What
    /// [`ScanFilters::exclude_promos`] reads, through [`Reference::mask_for`].
    promos: HashSet<Id>,
    /// The printings that are tokens or emblems ([`crate::labels::is_token`]), kept as the promos
    /// are. What a session leaves out unless it is told to admit them
    /// ([`Reference::mask_without_tokens`]).
    tokens: HashSet<Id>,
}

/// [`Reference::snapshot`]'s answer. Ordered maps, so two of them compare and print alike
/// whatever order the reference's own maps iterate in.
#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Snapshot {
    labels: std::collections::BTreeMap<Id, Label>,
    oracle: std::collections::BTreeMap<Id, Id>,
    finishes: std::collections::BTreeMap<Id, Vec<String>>,
    promos: std::collections::BTreeSet<Id>,
    tokens: std::collections::BTreeSet<Id>,
}

impl Reference {
    /// A reference with no labels.
    pub fn new() -> Self {
        Reference::default()
    }

    pub fn label_count(&self) -> usize {
        self.labels.len()
    }

    /// Everything the labels put into this reference that a caller can see, in an order of its
    /// own — so two references built two ways can be held to each other
    /// (`labels::tests`, where one is `load_labels`' and the other came through bytes).
    #[cfg(test)]
    pub(crate) fn snapshot(&self) -> Snapshot {
        Snapshot {
            labels: self.labels.iter().map(|(id, l)| (*id, l.clone())).collect(),
            oracle: self.oracle.iter().map(|(id, o)| (*id, *o)).collect(),
            finishes: self
                .finishes
                .keys()
                .map(|id| (*id, self.finishes_of(id).to_vec()))
                .collect(),
            promos: self.promos.iter().copied().collect(),
            tokens: self.tokens.iter().copied().collect(),
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
    /// only, 892 etched only, of 118,610), and for those the tray's finish needs no asking.
    ///
    /// **Kept as a place in a list of the distinct lists**, for the browser, where a module's
    /// memory is never given back (the light app's step 7.5).
    pub fn finishes_of(&self, printing: &Id) -> &[String] {
        self.finishes
            .get(printing)
            .and_then(|at| self.finish_lists.get(*at as usize))
            .map_or(&[], Vec::as_slice)
    }

    /// Record a printing's finishes — [`Reference::load_labels`]' own, public for a caller with
    /// no SQLite.
    pub fn set_finishes(&mut self, printing: Id, finishes: Vec<String>) {
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

    /// Is this printing a promo, as the corpus marks it? `false` for a printing the labels never
    /// named, as for one they named a non-promo.
    pub fn is_promo(&self, printing: &Id) -> bool {
        self.promos.contains(printing)
    }

    /// Record whether a printing is a promo — [`Reference::load_labels`]' own, public for a
    /// caller with no SQLite.
    pub fn set_promo(&mut self, printing: Id, promo: bool) {
        if promo {
            self.promos.insert(printing);
        } else {
            self.promos.remove(&printing);
        }
    }

    /// Is this printing a token or an emblem, as [`crate::labels::is_token`] reads the corpus?
    /// `false` for a printing the labels never named.
    pub fn is_token(&self, printing: &Id) -> bool {
        self.tokens.contains(printing)
    }

    /// Record whether a printing is a token — [`Reference::load_labels`]' own, public for a
    /// caller with no SQLite.
    pub fn set_token(&mut self, printing: Id, token: bool) {
        if token {
            self.tokens.insert(printing);
        } else {
            self.tokens.remove(&printing);
        }
    }

    /// Attach one printing's label — the body of [`Reference::load_labels`], public so a
    /// caller with no SQLite (a test, the replay) can build a labelled reference. Adding the
    /// same printing twice replaces its label.
    pub fn add_label(&mut self, id: Id, oracle: Option<Id>, label: Label) {
        match oracle {
            Some(o) => self.oracle.insert(id, o),
            None => self.oracle.remove(&id),
        };
        self.labels.insert(id, label);
    }

    /// The mask a set of filters admits: every labelled printing that passes them.
    ///
    /// Empty filters are [`Mask::all`], which keeps the unfiltered search on its fast path
    /// rather than checking 118,000 ids against a set that holds all of them.
    pub fn mask_for(&self, f: &ScanFilters) -> Mask {
        if f.is_empty() {
            return Mask::all();
        }
        Mask::allow_only(
            self.labels.iter().filter(|(id, l)| f.permits(l, self.is_promo(id))).map(|(id, _)| *id),
        )
    }

    /// The same, leaving out every token and emblem as well — the mask a session searches under
    /// unless it admits tokens ([`crate::session::Session::set_tokens`]; issue #1323).
    ///
    /// **Empty filters are every printing but the tokens** ([`Mask::all_but`]), not a list of
    /// the hundred thousand that are not tokens; with no token recorded that is [`Mask::all`],
    /// and the unfiltered search keeps its fast path.
    pub fn mask_without_tokens(&self, f: &ScanFilters) -> Mask {
        if f.is_empty() {
            return Mask::all_but(self.tokens.iter().copied());
        }
        Mask::allow_only(
            self.labels
                .iter()
                .filter(|(id, l)| !self.is_token(id) && f.permits(l, self.is_promo(id)))
                .map(|(id, _)| *id),
        )
    }

    /// The corpus oracle id for a printing, and nothing when the corpus has none — a reader
    /// being told "this is the card's oracle id" must not be handed a printing id standing in
    /// for one.
    pub fn oracle_id_of(&self, printing: &Id) -> Option<Id> {
        self.oracle.get(printing).copied()
    }

    /// The label for a raw id.
    pub fn label_for(&self, id: &Id) -> Option<Label> {
        self.labels.get(id).cloned()
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::ID_LEN;

    fn id(n: u8) -> Id {
        let mut b = [0u8; ID_LEN];
        b[0] = n;
        b
    }

    /// A reference whose printings carry labels, attached through `add_label` rather than a
    /// corpus. Rows are `(printing, oracle, name, set, number, released)`.
    fn labelled(rows: &[(u8, u8, &str, &str, &str, &str)]) -> Reference {
        let mut r = Reference::new();
        for (p, o, name, set, number, released) in rows {
            r.add_label(
                id(*p),
                Some(id(*o)),
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
    fn excluding_promos_leaves_out_the_promos() {
        let mut r = three();
        r.set_promo(id(2), true);
        assert!(r.is_promo(&id(2)) && !r.is_promo(&id(1)));
        let no_promos = ScanFilters { exclude_promos: true, ..Default::default() };
        let m = r.mask_for(&no_promos);
        assert!(!m.is_unrestricted());
        assert!(m.permits(&id(1)) && m.permits(&id(3)) && !m.permits(&id(2)));
        // And a printing marked and then unmarked is no promo.
        r.set_promo(id(2), false);
        assert!(r.mask_for(&no_promos).permits(&id(2)));
    }

    #[test]
    fn empty_filters_are_unrestricted() {
        let r = three();
        assert!(r.mask_for(&ScanFilters::default()).is_unrestricted());
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
    fn finishes_are_kept_once_per_distinct_list() {
        let mut r = three();
        r.set_finishes(id(1), vec!["nonfoil".into(), "foil".into()]);
        r.set_finishes(id(2), vec!["nonfoil".into(), "foil".into()]);
        r.set_finishes(id(3), Vec::new());
        assert_eq!(r.finishes_of(&id(2)), ["nonfoil", "foil"]);
        assert!(r.finishes_of(&id(3)).is_empty(), "no finishes is not said");
        assert_eq!(r.finish_lists.len(), 1);
    }

    #[test]
    fn leaving_out_the_tokens_leaves_out_the_tokens() {
        // Issue #1323. The DMU Ornithopter is the token, and the corpus lists it first.
        let mut r = labelled(&[
            (1, 10, "Ornithopter", "tdmu", "22", "2022-09-09"),
            (2, 20, "Ornithopter", "9ed", "305", "2005-07-29"),
            (3, 30, "Shock", "m21", "159", "2020-07-03"),
        ]);
        // No token recorded is no restriction: the unfiltered search keeps its fast path.
        assert!(r.mask_without_tokens(&ScanFilters::default()).is_unrestricted());
        r.set_token(id(1), true);
        assert!(r.is_token(&id(1)) && !r.is_token(&id(2)));

        let all = r.mask_without_tokens(&ScanFilters::default());
        assert!(!all.is_unrestricted() && all.len().is_none(), "every printing but one");
        assert!(!all.permits(&id(1)) && all.permits(&id(2)) && all.permits(&id(3)));

        // Under filters it is a list, the tokens off it.
        let older = ScanFilters { released_to: Some("2023-01-01".into()), ..Default::default() };
        let m = r.mask_without_tokens(&older);
        assert_eq!(m.len(), Some(2));
        assert!(!m.permits(&id(1)) && m.permits(&id(2)));
        // Narrowed to the token's own set, nothing is left; `mask_for` still admits it.
        assert_eq!(r.mask_without_tokens(&sets(&["tdmu"])).len(), Some(0));
        assert!(r.mask_for(&sets(&["tdmu"])).permits(&id(1)));
        assert!(r.mask_for(&ScanFilters::default()).permits(&id(1)));
        // And a printing marked and then unmarked is no token.
        r.set_token(id(1), false);
        assert!(r.mask_without_tokens(&ScanFilters::default()).is_unrestricted());
    }

    #[test]
    fn oracle_id_of_has_no_fallback() {
        let mut r = three();
        r.add_label(
            id(4),
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
        assert_eq!(r.label_for(&id(4)).map(|l| l.name), Some("Token".into()));
    }

    #[cfg(feature = "corpus")]
    #[test]
    fn corpus_miscellaneous_cards_resolve_without_oracle_or_illustration_ids() {
        use crate::ids::format_uuid;
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
                finishes TEXT, layout TEXT, set_type TEXT, promo INTEGER NOT NULL DEFAULT 0,
                type_line TEXT
            )",
            )
            .unwrap();
        for (p, layout, name, set, number) in rows {
            corpus
                .execute(
                    "INSERT INTO cards VALUES (?1, NULL, ?2, ?3, ?4, 'en', '2025-01-01',
                    NULL, '[\"nonfoil\"]', ?5, ?6, 0, NULL)",
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
        }
        let mut reference = Reference::new();
        assert_eq!(reference.load_labels(&corpus).unwrap(), rows.len());
        for (p, _, name, set, _) in rows {
            let filters = ScanFilters {
                sets: vec![set.into()],
                released_from: Some("2025-01-01".into()),
                released_to: Some("2025-01-01".into()),
                exclude_promos: false,
            };
            let mask = reference.mask_for(&filters);
            assert!(mask.permits(&id(p)));
            assert_eq!(reference.oracle_id_of(&id(p)), None);
            assert_eq!(reference.label_for(&id(p)).unwrap().name, name);
            assert_eq!(reference.finishes_of(&id(p)), ["nonfoil"]);

            let excluded = reference.mask_for(&ScanFilters {
                released_from: Some("2025-01-02".into()),
                ..filters
            });
            assert!(!excluded.permits(&id(p)));
        }
        // The token and the emblem are tokens by their layout; the art card and the trophy not.
        let tokens: Vec<bool> = rows.iter().map(|(p, ..)| reference.is_token(&id(*p))).collect();
        assert_eq!(tokens, [true, true, false, false]);
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
