//! The card predicates, in one place, so every list that filters cards filters them the
//! same way.
//!
//! Lifted out of [`crate::search`] when the collection needed the same six filters over a
//! *joined* query. Everything here is alias-parameterised (`c` in the search, `c` in the
//! collection's LEFT JOIN) and pushes its parameters in the order it pushes its SQL, which
//! is the invariant the whole builder rests on: `?` binds by position, so a fragment and
//! its parameter must never be separated.
//!
//! Only two kinds of thing are ever interpolated into the SQL — a colour letter from
//! [`COLORS`] and a `?`-placeholder list whose *length* is all it carries. No user text
//! reaches the parser.

use serde::Deserialize;

/// The five colour-identity letters, in WUBRG order. Interpolated into SQL, so it must
/// stay a hard-coded list.
pub const COLORS: [&str; 5] = ["W", "U", "B", "R", "G"];

/// Sets one request will filter on. The picker is a multi-select over ~1 050 sets; past a
/// few dozen the filter has stopped narrowing anything.
pub const MAX_SET_FILTER: usize = 64;

/// The last mana-value chip is open-ended: "8" means 8 *or more*.
pub const MANA_VALUE_OPEN_ENDED: u8 = 8;

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
    pub sets: Option<Vec<String>>,
    pub mana_values: Option<Vec<u8>>,
    pub rarity: Option<String>,
    /// Omitted means true in the search and false in the collection: a search offers cards
    /// to own, a collection lists cards that are owned.
    pub paper_only: Option<bool>,
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

    // `restricted` counts as playable — a Vintage search that hid Black Lotus would be
    // wrong. Formats the card has no entry for yield NULL, which fails the IN.
    if let Some(v) = nonblank(&f.format) {
        p.push(
            format!("json_extract({alias}.legalities, '$.' || ?) IN ('legal','restricted')"),
            Box::new(v.to_owned()),
        );
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

    // OR within, AND without. Blank entries are dropped rather than matched: a picker's
    // cleared state sends `[]`, and some send `[""]`.
    if let Some(sets) = f.sets.as_deref() {
        let mut picked: Vec<String> = sets
            .iter()
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        picked.sort();
        picked.dedup();
        picked.truncate(MAX_SET_FILTER);
        if !picked.is_empty() {
            let holes = vec!["?"; picked.len()].join(",");
            p.wheres.push(format!("{set_code} IN ({holes})"));
            for code in picked {
                p.params.push(Box::new(code));
            }
        }
    }

    // Discrete chips, not a range: 0–7 are exact and 8 is open-ended. `cmc` is REAL and
    // nullable — a fractional un-card cost matches no chip, and a card with no cost at all
    // matches none either, because `NULL IN (…)` and `NULL >= 8` are both NULL.
    //
    // Deduplicated first: a payload that repeats a chip would otherwise generate a
    // placeholder per repeat, which is a longer statement for the same answer (carryover
    // fold: "manaValues dedupe").
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
        let mut alternatives: Vec<String> = Vec::new();
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
        if !alternatives.is_empty() {
            p.wheres.push(format!("({})", alternatives.join(" OR ")));
        }
    }

    if let Some(r) = nonblank(&f.rarity) {
        p.push(format!("{alias}.rarity = ?"), Box::new(r.to_owned()));
    }
    if f.paper_only.unwrap_or(true) {
        p.wheres.push(format!("{alias}.is_paper = 1"));
    }
}

/// A filter the user actually set: trimmed, and `None` when blank.
///
/// A UI whose "Any set"/"Any format" option carries an empty value sends `Some("")`. Taken
/// literally that would mean `set_code = ''` (matches nothing) or the json path `'$.'` —
/// which is a *SQLite error*, failing the whole query rather than one filter.
pub fn nonblank(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}
