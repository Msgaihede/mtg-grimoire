//! The card predicates, in one place, so every list that filters cards filters them the
//! same way.
//!
//! Lifted out of [`crate::search`] when the collection needed the same six filters over a
//! *joined* query. Everything here is alias-parameterised (`c` in the search, `c` in the
//! collection's LEFT JOIN) and pushes its parameters in the order it pushes its SQL, which
//! is the invariant the whole builder rests on: `?` binds by position, so a fragment and
//! its parameter must never be separated.
//!
//! Only three kinds of thing are ever interpolated into the SQL — a colour letter from
//! [`COLORS`], a `?`-placeholder list whose *length* is all it carries, and the literal `0`
//! an unrecognised format collapses to. No user text reaches the parser: even the format
//! key is looked up in [`crate::legalities`] and bound as the integer bit it names.

use serde::Deserialize;

/// The five colour-identity letters, in WUBRG order. Interpolated into SQL, so it must
/// stay a hard-coded list.
pub const COLORS: [&str; 5] = ["W", "U", "B", "R", "G"];

/// Sets one request will filter on. The picker is a multi-select over ~1 050 sets; past a
/// few dozen the filter has stopped narrowing anything.
pub const MAX_SET_FILTER: usize = 64;

/// The last mana-value chip is open-ended: "8" means 8 *or more*.
pub const MANA_VALUE_OPEN_ENDED: u8 = 8;

/// The `LIKE` pattern that finds a **variable** mana cost — a printed `{X}` anywhere in
/// `cards.mana_cost`.
///
/// A `const` bound as a parameter rather than a fragment built inline, for two reasons and
/// both of them are traps. The braces are the first: every predicate in this module is
/// assembled with `format!`, and `'%{X}%'` written there is a *format placeholder named `X`*
/// that fails the build — `'%{{X}}%'` compiles and is then two escapes nobody can read. The
/// second is that a pattern with one home cannot drift from the [`crate::index`] bitset that
/// has to agree with it.
///
/// **`{X}` only, never `{Y}` or `{Z}`.** Those two exist — a handful of un-cards print them —
/// and they are deliberately not here, because the chip and the deck group this feeds are both
/// *named* X: filing `Apocalypse Chime`'s siblings under a heading that names a symbol they do
/// not have is a wrong label, not a loose one. `validation/engine.ts`'s `symbolValue` scores
/// all three as 0, which is the answer to *what is this worth* and not to *what is this pile
/// called*.
pub const VARIABLE_COST_LIKE: &str = "%{X}%";

/// Every filter that is a statement about a *card*, as the UI sends it.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CardFilters {
    /// Free text, prefix-matched through FTS5. Handled by the caller, because the join it
    /// needs is the caller's to make — see [`fts_query`].
    pub text: Option<String>,
    pub format: Option<String>,
    pub colors: Option<String>,
    pub set_code: Option<String>,
    /// Narrow to every printing of one oracle card — the card, not the cardboard.
    ///
    /// The exact-card filter the search has never had: `text` is FTS **prefix** matching, so
    /// a name query answers other cards too. Indexed for free by `idx_cards_oracle`, which
    /// `CARDS_INDEXES` has carried since schema v1.
    ///
    /// `cards.oracle_id` is NULLABLE and no live row is null, so this needs no null branch.
    pub oracle_id: Option<String>,
    pub sets: Option<Vec<String>>,
    pub mana_values: Option<Vec<u8>>,
    /// `Some(true)` also matches cards whose printed cost carries an `{X}`; `None` and
    /// `Some(false)` add nothing.
    ///
    /// **An overlay on the mana-value chips, never a replacement for one.** Scryfall counts X
    /// as 0 when it computes `cmc`, so `{X}{B}{B}{B}` is mana value 3 and stays mana value 3 —
    /// this filter joins the *same* OR group the chips do, so a request naming "3" and "X"
    /// returns that card once, from one row and one alternative, rather than twice.
    ///
    /// See [`VARIABLE_COST_LIKE`] for why the test is a `LIKE` over `{X}` alone.
    pub mana_x: Option<bool>,
    pub rarity: Option<String>,
    /// Omitted means true in the search and false in the collection: a search offers cards
    /// to own, a collection lists cards that are owned.
    pub paper_only: Option<bool>,
    /// Narrow to printings that are playable **somewhere** — `legal_mask != 0`.
    ///
    /// **Omitted means false**, unlike [`Self::paper_only`], so no caller that has not heard
    /// of this filter changes behaviour. The search view sends `true` and is the only thing
    /// that does; the collection and the wishlist list what the user owns and wants, and an
    /// art card in a binder is still in the binder.
    ///
    /// The mask is Scryfall's whole `legalities` object folded to one integer, so zero means
    /// "legal or restricted in none of the 23 formats" — art series, tokens, emblems,
    /// memorabilia, and the acorn half of the un-sets. It is a fact about the card rather
    /// than a layout guess, which is why this filter reads the mask and not `layout`.
    pub playable_only: Option<bool>,
}

/// SQL fragments and the parameters they bound, in push order.
#[derive(Default)]
pub struct Predicates {
    pub wheres: Vec<String>,
    pub params: Vec<Box<dyn rusqlite::ToSql>>,
}

impl Predicates {
    /// The `WHERE` body. `1=1` rather than an empty string so callers can always write
    /// `WHERE {}` without a branch.
    pub fn where_sql(&self) -> String {
        if self.wheres.is_empty() {
            "1=1".to_owned()
        } else {
            self.wheres.join(" AND ")
        }
    }

    pub fn push(&mut self, sql: String, param: Box<dyn rusqlite::ToSql>) {
        self.wheres.push(sql);
        self.params.push(param);
    }
}

/// The FTS5 `MATCH` string for a user's text, or `None` when nothing indexable is left.
///
/// FTS5 has its own query language: `"`, `*`, `:`, `(`, `AND`/`OR`/`NOT` and `NEAR` are all
/// operators, and a stray one is a syntax *error*, not a zero-result search. Splitting on
/// everything non-alphanumeric leaves tokens that cannot contain an operator by
/// construction; quoting each makes it a literal phrase, and the trailing `*` is the one
/// operator kept, for prefix matching.
///
/// Splitting, not stripping: the index is built by `unicode61`, which breaks on the same
/// boundaries. Deleting punctuation inside a word would weld its halves into a token
/// nothing indexes — `Ajani's` → `ajanis`, `God-Pharaoh` → `godpharaoh`.
pub fn fts_query(text: &str) -> Option<String> {
    let toks: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\"*"))
        .collect();
    (!toks.is_empty()).then(|| toks.join(" "))
}

/// The `ESCAPE` character for a `LIKE` pattern built from a user's text.
///
/// A backslash, and interpolated into SQL as a literal — which is safe because it is this
/// constant and never anything a caller sends. Every character it protects is escaped by
/// [`escape_like`], itself included.
pub const LIKE_ESCAPE: char = '\\';

/// A user's text as a `LIKE` pattern that means exactly what it says.
///
/// `LIKE`'s wildcards are ordinary characters in a search box: somebody who types `%` means
/// the per-cent sign, and `_` is one keystroke from the `-` in half the card names in Magic
/// (`God-Pharaoh`). Unescaped, either turns a filter into a filter that does not filter —
/// the failure nobody reports, because a list showing too much still looks like a list.
///
/// Lives here rather than beside its one caller because it is the escaping half of a
/// contract whose other half is SQL, and the next `LIKE` this app grows must not invent a
/// second one. Pair it with `ESCAPE '{LIKE_ESCAPE}'` in the pattern's clause; the pattern
/// itself is always bound, never interpolated.
///
/// The escape character goes first: doing it last would escape the backslashes the other
/// two arms had just introduced, and `%` would come back out as a literal `\` followed by a
/// wildcard.
pub fn escape_like(text: &str) -> String {
    text.replace(LIKE_ESCAPE, &format!("{LIKE_ESCAPE}{LIKE_ESCAPE}"))
        .replace('%', &format!("{LIKE_ESCAPE}%"))
        .replace('_', &format!("{LIKE_ESCAPE}_"))
}

/// Push every non-text card predicate onto `p`, qualified with `alias`.
///
/// `rows` names the table that carries the *denormalised* printing beside its soft card
/// reference — `Some("e")` for the collection's `collection_entries`, `None` for the search,
/// which reads `cards` and nothing else. It changes exactly one filter, and the asymmetry is
/// the point:
///
/// * **Set code** is a statement the row itself can answer. The collection copies
///   `set_code` onto the entry at write time precisely so a row stays identifiable after
///   its printing leaves `cards` (spec §6), and the list *shows* that value. A row
///   displayed as `lea` that vanished when the reader filtered to `lea` would be the
///   filter contradicting the column beside it.
/// * **Format, colours, rarity and mana value** are claims only a card row can answer.
///   There is nowhere to read them from for an orphan, and inventing an answer would be a
///   claim about a printing that is gone — so those stay `{alias}.…`, and an orphan simply
///   fails them.
pub fn push_card_filters(p: &mut Predicates, f: &CardFilters, alias: &str, rows: Option<&str>) {
    // The one column with two places to read it from. See the doc comment above.
    let set_code = match rows {
        Some(rows) => format!("coalesce({alias}.set_code, {rows}.set_code)"),
        None => format!("{alias}.set_code"),
    };

    // **The mask, not `json_extract`.** A JSON path cannot be indexed, so the old form
    // knocked the collapsed browse's scan off `idx_cards_collapse` and into a row lookup per
    // card: 591 ms against 40.6 ms through the mask, measured 2026-08-11 with the widened
    // index in place — timed through `node:sqlite` against a page-for-page online backup of
    // the live database, so the build these name is SQLite's own C rather than a cargo
    // profile. [`crate::legalities`] exists for this.
    //
    // `restricted` still counts as playable — that lives in the mask now rather than in this
    // SQL, which is why the predicate no longer says so.
    //
    // A key this build has never heard of matches nothing, which is what the old form did
    // too: `json_extract` of an absent key is NULL and `NULL IN (…)` is NULL. Spelled `0`
    // rather than left out, because leaving it out would turn an unknown format into "no
    // filter at all" and quietly return the whole corpus.
    //
    // An orphan fails this exactly as it failed the old form: the collection's LEFT JOIN
    // gives it a NULL alias, and `NULL & ? != 0` is NULL. The column is `NOT NULL DEFAULT 0`
    // so that a *card* row can never be the NULL here — a mask nobody filled would drop its
    // printing out of every format search silently, reading as nothing rather than as "legal
    // nowhere".
    if let Some(v) = nonblank(&f.format) {
        match crate::legalities::bit(v) {
            Some(b) => p.push(format!("({alias}.legal_mask & ?) != 0"), Box::new(b as i64)),
            None => p.wheres.push("0".to_owned()),
        }
    }

    // Subset semantics, as in a deckbuilder: show what this identity can *cast*, so "RW"
    // returns mono-R, mono-W, RW — and colourless, which fits in any deck. Expressed as
    // exclusions so the number of clauses stays fixed and each one is a plain `instr`.
    if let Some(colors) = nonblank(&f.colors) {
        let colors = colors.to_ascii_uppercase();
        if colors == "C" {
            p.wheres.push(format!(
                "({alias}.color_identity = '' OR {alias}.color_identity IS NULL)"
            ));
        } else {
            for ch in COLORS {
                if !colors.contains(ch) {
                    p.wheres.push(format!(
                        "instr(coalesce({alias}.color_identity,''), '{ch}') = 0"
                    ));
                }
            }
        }
    }

    if let Some(s) = nonblank(&f.set_code) {
        p.push(format!("{set_code} = ?"), Box::new(s.to_owned()));
    }

    // `{alias}.oracle_id`, not a bare `c.`: this function is alias-parameterized for the
    // collection's joined query too, and the id is a claim only a card row can answer — the
    // same reasoning as the format, colour, rarity and mana-value arms, none of which fall
    // back to `rows` either.
    if let Some(oracle_id) = &f.oracle_id {
        p.push(
            format!("{alias}.oracle_id = ?"),
            Box::new(oracle_id.clone()),
        );
    }

    // OR within, AND without. Blank entries are dropped rather than matched: a picker's
    // cleared state sends `[]`, and some send `[""]`.
    if let Some(sets) = f.sets.as_deref() {
        let picked = picked_sets(sets);
        if !picked.is_empty() {
            let holes = vec!["?"; picked.len()].join(",");
            p.wheres.push(format!("{set_code} IN ({holes})"));
            for code in picked {
                p.params.push(Box::new(code));
            }
        }
    }

    // Discrete chips, not a range: 0–7 are exact and 8 is open-ended. `cmc` is REAL and
    // nullable, and the two halves treat a fraction differently — **below 8 it matches no
    // chip** (exact float equality against 0.0–7.0, so 0.5 is nobody's), while **at or above
    // 8 it does**, because the open-ended arm below is `cmc >= 8.0` and 8.5 satisfies it. A
    // card with no cost at all matches nothing either way: `NULL IN (…)` and `NULL >= 8` are
    // both NULL. `index/mod.rs`'s mana buckets mirror exactly this split and cite this
    // function for it.
    //
    // Deduplicated first: a payload that repeats a chip would otherwise generate a
    // placeholder per repeat, which is a longer statement for the same answer (carryover
    // fold: "manaValues dedupe").
    //
    // **The X chip is one more alternative in this same group, and that is the whole design.**
    // It is *additive, never exclusive*: an X card keeps whatever `cmc` chip it already
    // matched (Scryfall scores X as 0, so `{X}{B}{B}{B}` is and stays mana value 3), so a
    // payload naming both "3" and "X" describes one row through two alternatives of one OR —
    // one predicate, one match, no duplicate. Pushed as a separate `AND` term it would have
    // meant "3 *and* variable", which is the intersection nobody asked for.
    let mut alternatives: Vec<String> = Vec::new();
    if let Some(values) = f.mana_values.as_deref() {
        let mut exact: Vec<f64> = Vec::new();
        let mut open_ended = false;
        let mut seen: Vec<u8> = Vec::new();
        for v in values {
            if seen.contains(v) {
                continue;
            }
            seen.push(*v);
            if *v >= MANA_VALUE_OPEN_ENDED {
                open_ended = true;
            } else {
                exact.push(f64::from(*v));
            }
        }
        if !exact.is_empty() {
            let holes = vec!["?"; exact.len()].join(",");
            alternatives.push(format!("{alias}.cmc IN ({holes})"));
            for v in exact {
                p.params.push(Box::new(v));
            }
        }
        if open_ended {
            alternatives.push(format!("{alias}.cmc >= {MANA_VALUE_OPEN_ENDED}.0"));
        }
    }
    // `{alias}.mana_cost` with no `rows` fallback, unlike the set code above: a printed cost is
    // a statement only a card row can make, and an orphaned entry has none — so it fails this
    // exactly as it fails the format, colour and mana-value arms. `NULL LIKE ?` is NULL.
    //
    // Bound, not interpolated, and the pattern is [`VARIABLE_COST_LIKE`]; no `ESCAPE` clause,
    // because that constant is ours and contains neither `%` nor `_`.
    if f.mana_x.unwrap_or(false) {
        alternatives.push(format!("{alias}.mana_cost LIKE ?"));
        p.params.push(Box::new(VARIABLE_COST_LIKE));
    }
    if !alternatives.is_empty() {
        p.wheres.push(format!("({})", alternatives.join(" OR ")));
    }

    if let Some(r) = nonblank(&f.rarity) {
        p.push(format!("{alias}.rarity = ?"), Box::new(r.to_owned()));
    }
    if f.paper_only.unwrap_or(true) {
        p.wheres.push(format!("{alias}.is_paper = 1"));
    }

    // Playable **somewhere**, which is the one question the whole mask answers at once: a
    // format filter tests one bit, this tests whether any is set. No parameter, because there
    // is nothing to bind — the constant is `0`.
    //
    // `legal_mask` is in `idx_cards_collapse` for the format filter's sake, so this rides the
    // same covering scan rather than knocking the collapsed browse into row lookups. It is
    // also why the filter is not `layout NOT IN (…)`: `layout` is in no index, and a layout
    // list would have to be kept in step with Scryfall's by hand while the mask is computed
    // from the card's own legalities on every sync.
    //
    // An orphan fails it, exactly as it fails the format filter: the collection's LEFT JOIN
    // gives it a NULL alias and `NULL != 0` is NULL. The column is `NOT NULL DEFAULT 0` so a
    // *card* row can never be that NULL.
    if f.playable_only.unwrap_or(false) {
        p.wheres.push(format!("{alias}.legal_mask != 0"));
    }
}

/// The set codes a request really filters on: trimmed, lower-cased, blanks dropped, sorted,
/// deduplicated and capped at [`MAX_SET_FILTER`].
///
/// **An empty answer means "no set filter", never "match nothing".** A picker's cleared
/// state sends `[]` and some send `[""]`, and either taken literally would be `IN ()` — a
/// syntax error in SQLite and an empty result set anywhere else.
///
/// A function rather than eight lines inside [`push_card_filters`], because
/// [`crate::index::facets`] has to narrow by *exactly* this list: a facet counted over 70
/// picked sets while the search returns the 64 this cap leaves would report options as live
/// that the search cannot reach. Two copies of a normalisation that must agree will not.
pub fn picked_sets(sets: &[String]) -> Vec<String> {
    let mut picked: Vec<String> = sets
        .iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    picked.sort();
    picked.dedup();
    picked.truncate(MAX_SET_FILTER);
    picked
}

/// A filter the user actually set: trimmed, and `None` when blank.
///
/// A UI whose "Any set"/"Any format" option carries an empty value sends `Some("")`. Taken
/// literally that would mean `set_code = ''` (matches nothing) or a format no build has a
/// bit for, which the arm above spells `0` — an empty list where the user asked for every
/// card. Before the mask it was worse: the json path `'$.'` is a *SQLite error*, failing the
/// whole query rather than one filter.
pub fn nonblank(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The filter has to reach the index, and it cannot while it parses JSON per row.
    /// Measured 2026-08-11 with the widened `idx_cards_collapse` in place: 40.6 ms through
    /// the mask against 591 ms through `json_extract` — through `node:sqlite` against a
    /// page-for-page online backup of the live database, so the build named is SQLite's own
    /// and not a cargo profile (see [`super::push_card_filters`]).
    ///
    /// The only test here that reads the SQL rather than an answer, because the shape *is*
    /// the claim: what the filter matches is identical either way, and that is exactly why
    /// a results test cannot tell whether the query can use the index. The three behaviours
    /// that must *survive* the rewrite are pinned where they can be asked of a real query:
    /// `search::tests::format_filter_includes_restricted`,
    /// `search::tests::a_format_the_build_does_not_know_matches_nothing`, and the format arm
    /// of the collection's orphan test.
    #[test]
    fn the_format_filter_tests_the_mask_rather_than_parsing_json() {
        let mut p = Predicates::default();
        let f = CardFilters {
            format: Some("modern".into()),
            ..Default::default()
        };
        push_card_filters(&mut p, &f, "c", None);
        let sql = p.where_sql();
        assert!(sql.contains("legal_mask"), "{sql}");
        assert!(!sql.contains("json_extract"), "{sql}");
    }

    /// `playable_only` is the one filter here whose omission means **off**, and the asymmetry
    /// with `paper_only` two lines above it is exactly what a reader would get wrong. Every
    /// caller but the search view omits it, so a default of `true` would silently drop the
    /// art cards out of a collection someone owns them in — a list showing too little, which
    /// is the failure nobody reports either.
    #[test]
    fn playable_only_is_off_unless_it_is_asked_for() {
        let sql = |f: CardFilters| {
            let mut p = Predicates::default();
            push_card_filters(&mut p, &f, "c", None);
            p.where_sql()
        };

        assert!(
            !sql(CardFilters::default()).contains("legal_mask"),
            "omitted means no clause at all"
        );
        assert!(!sql(CardFilters {
            playable_only: Some(false),
            ..Default::default()
        })
        .contains("legal_mask"));

        let on = sql(CardFilters {
            playable_only: Some(true),
            ..Default::default()
        });
        assert!(on.contains("c.legal_mask != 0"), "{on}");
    }

    /// The X chip is an **alternative inside the mana group**, not a term beside it — which is
    /// the difference between "mana value 2 or variable" and "mana value 2 *and* variable",
    /// and the second of those is empty for most of the corpus.
    ///
    /// Read off the SQL rather than off an answer, for the reason the mask test above is: the
    /// two shapes differ in one character (`OR` against `AND`) and a fixture small enough to
    /// tell them apart is a fixture that proves nothing else. The behaviour they produce is
    /// pinned where it can be asked of a real query —
    /// `search::tests::the_x_chip_matches_a_variable_cost_and_ors_with_the_value_chips`.
    #[test]
    fn the_x_test_joins_the_mana_values_own_or_group() {
        let mut p = Predicates::default();
        push_card_filters(
            &mut p,
            &CardFilters {
                mana_values: Some(vec![2]),
                mana_x: Some(true),
                ..Default::default()
            },
            "c",
            None,
        );

        let mana: Vec<&String> = p.wheres.iter().filter(|w| w.contains("mana_")).collect();
        assert_eq!(mana.len(), 1, "one group, not two AND terms: {mana:?}");
        assert_eq!(
            mana[0], "(c.cmc IN (?) OR c.mana_cost LIKE ?)",
            "the chip and the X test are alternatives of each other"
        );
        // Push order is the binding order, and `?` binds by position: the chip's value first
        // because its fragment is first.
        assert_eq!(p.params.len(), 2);

        // No `rows` fallback on the cost, whatever alias the caller passes for its own table —
        // a printed cost is a claim only a card row can make, so an orphan fails it.
        let mut joined = Predicates::default();
        push_card_filters(
            &mut joined,
            &CardFilters {
                mana_x: Some(true),
                ..Default::default()
            },
            "c",
            Some("e"),
        );
        assert!(
            joined.wheres.iter().any(|w| w == "(c.mana_cost LIKE ?)"),
            "{:?}",
            joined.wheres
        );
    }

    /// `manaX` is omitted-means-**off**, like [`CardFilters::playable_only`] and unlike
    /// `paper_only`: every list that has never heard of this chip must keep the rows it had.
    /// And with the chip on alone it is still one group, so it narrows on its own rather than
    /// needing a mana value beside it.
    #[test]
    fn mana_x_adds_nothing_unless_it_is_asked_for() {
        let sql = |f: CardFilters| {
            let mut p = Predicates::default();
            push_card_filters(&mut p, &f, "c", None);
            p.where_sql()
        };

        assert!(!sql(CardFilters::default()).contains("mana_cost"));
        assert!(!sql(CardFilters {
            mana_x: Some(false),
            mana_values: Some(vec![2]),
            ..Default::default()
        })
        .contains("mana_cost"));

        let alone = sql(CardFilters {
            mana_x: Some(true),
            ..Default::default()
        });
        assert!(alone.contains("(c.mana_cost LIKE ?)"), "{alone}");
    }

    /// The pattern is a `const` and it is bound, so the braces never meet `format!` — which is
    /// the build error this constant exists to make unreachable. `{Y}` and `{Z}` are
    /// deliberately outside it: the chip is *named* X, and those un-cards do not have one.
    #[test]
    fn the_variable_cost_pattern_matches_x_and_not_its_two_siblings() {
        assert_eq!(VARIABLE_COST_LIKE, "%{X}%");

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let matches = |cost: &str| {
            conn.query_row(
                "SELECT ?1 LIKE ?2",
                rusqlite::params![cost, VARIABLE_COST_LIKE],
                |r| r.get::<_, bool>(0),
            )
            .unwrap()
        };
        assert!(matches("{X}{B}{B}{B}"));
        assert!(matches("{2}{X}"));
        assert!(!matches("{2}{W}{W}"));
        assert!(!matches("{Y}"), "Apocalypse Chime's siblings are not X");
        assert!(!matches("{Z}"));
    }
}
