//! **Folder rules** (issue #980): criteria a card filed in a collection or wishlist folder is
//! expected to meet — "cards under $1", "blue cards", "printed 2001–2005" — and the read that
//! answers which filed cards do not meet them.
//!
//! **A rule never stops a card being filed.** Nothing here is asked by a write that moves a
//! card; [`conflicts`] is a read, and what it finds is drawn as a red outline and a count. Not to
//! be confused with deck validation, Scryfall tags, deck labels or the folder *lock*
//! (`docs/agent/DOMAIN_VOCABULARY.md`).
//!
//! **Rules combine with AND and OR** (issue #1053): a [`FolderRule::Group`] joins its rules with
//! one [`GroupOp`], and since a group is a rule, groups nest — "rare **or** (full art **and**
//! land)". A folder's own list, and what it inherits, is the outermost `and`. Every predicate is
//! built as a *pass* ([`passes`]) — `1` when the row satisfies the rule, a leaf's unknown already
//! read as a pass — so a group is a plain `AND`/`OR` of its rules' passes and the conflict test is
//! `NOT` of the whole.
//!
//! Three decisions carry the module (the folder-rules spec, §1–§2):
//!
//! * **Inheritance is computed on read, never stored.** A folder's effective rules are its own
//!   followed by each ancestor's, nearest first ([`effective`]); `rules` holds the folder's own
//!   list only. A stamped copy on every descendant would be a second copy of the parent's fact,
//!   wrong the first time a folder moves — `collection_folders::LOCKED_FOLDER_IDS`' argument.
//! * **A rule only breaks on a fact the app knows.** Every predicate here is three-valued, and
//!   the conflict test is `NOT coalesce(pred, 1)`: an unpriced card passes a price rule, a card
//!   with no `released_at` passes a date rule, and an entry whose printing has left `cards`
//!   breaks nothing at all.
//! * **An any-printing wish is judged against its oracle card**: it breaks its folder's rules
//!   only when *no* printing satisfies all of them together (one `EXISTS`, the card-level rules
//!   read on that printing and the row's own facts on the row), because the wish is for
//!   whichever printing the reader ends up buying.
//!
//! **The vocabularies are borrowed, never respelled**: the type, set, rarity, border and finish
//! words are [`crate::filters`]' own `picked_*` normalisations, and the type, set, rarity and
//! border SQL is [`crate::filters::push_card_filters`] itself, so a rule and the filter chip of
//! the same name cannot disagree about what `regular` or `Creature` means.

use crate::collection::{CONDITIONS, ENTRY_FINISH};
use crate::filters::{self, CardFilters, Predicates, COLORS};
use crate::sorting::Marketplace;
use crate::wishlist::WISH_PREFERRED_FINISH;
use rusqlite::{params_from_iter, Connection, ToSql};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// The most rules one folder may hold — its **own**, not counting what it inherits.
pub const MAX_RULES: usize = 20;

/// [`tidy`]'s refusal past [`MAX_RULES`].
pub const TOO_MANY_RULES: &str = "A folder can hold at most 20 rules.";

/// [`tidy`]'s refusal for a values rule left with nothing this build knows.
pub const NO_VALUES: &str = "Pick at least one value for each rule.";

/// [`tidy`]'s refusal for a range with neither end, its ends the wrong way round, or a negative
/// price or mana value.
pub const BAD_RANGE: &str = "Give each range at least one end, with the lower end first.";

/// [`tidy`]'s refusal for a release date in any other shape.
pub const BAD_DATE: &str = "Write dates as YYYY, YYYY-MM or YYYY-MM-DD.";

/// How deep groups may nest: a group in the folder's list is depth 1, a group inside it 2. Three
/// is "A or (B and (C or D))" — past that a folder's rules are a program, not a drawer label.
pub const MAX_GROUP_DEPTH: usize = 3;

/// [`tidy`]'s refusal for a group holding no rule.
pub const EMPTY_GROUP: &str = "Put at least one rule in each group.";

/// [`tidy`]'s refusal past [`MAX_GROUP_DEPTH`].
pub const TOO_DEEP: &str = "Groups can nest at most 3 deep.";

/// The colourless "colour" a `colors` rule may name beside [`COLORS`]. `cards.colors` stores a
/// colourless card as `''`, so this is a word of the rule's vocabulary and never of the column.
pub const COLORLESS: &str = "C";

/// One rule, as stored in `rules` and as carried on the wire (spec §4).
///
/// **A values rule is satisfied by any one of its values; a folder's rules are all enforced.**
/// Two rules of one kind are both enforced, which is how a reader says "blue *and* red". A
/// [`FolderRule::Group`] joins rules with `and` or `or` (issue #1053).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FolderRule {
    /// The unit price at the page's marketplace, inclusive at both ends.
    Price { min: Option<f64>, max: Option<f64> },
    /// `cards.cmc`, inclusive at both ends.
    ManaValue { min: Option<f64>, max: Option<f64> },
    /// [`COLORS`] and [`COLORLESS`]: every colour of the card is among them.
    Colors { values: Vec<String> },
    /// [`crate::cardtypes::TYPE_KEYS`].
    Types { values: Vec<String> },
    /// Set codes, lower-case.
    Sets { values: Vec<String> },
    /// `cards.rarity`'s six words.
    Rarities { values: Vec<String> },
    /// [`crate::schema::FINISHES`] — the copy's finish, or a wish's preferred one.
    Finishes { values: Vec<String> },
    /// [`CONDITIONS`]. Ignored on the wishlist, whose rows have no condition.
    Conditions { values: Vec<String> },
    /// [`filters::BORDER_KEYS`], with the border chips' meaning.
    Borders { values: Vec<String> },
    /// `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, each end compared at its own precision — so
    /// `to: "2000"` is through the end of 2000.
    Released {
        from: Option<String>,
        to: Option<String>,
    },
    /// Rules joined by `op` — a group is a rule, so groups nest (at most [`MAX_GROUP_DEPTH`]).
    /// **Read as leniently as the list** ([`read_rules`]): a member this build cannot read is
    /// skipped, never the group.
    Group {
        op: GroupOp,
        #[serde(deserialize_with = "lenient_rules")]
        rules: Vec<FolderRule>,
    },
}

/// How a [`FolderRule::Group`] joins its rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GroupOp {
    /// Every rule must pass.
    And,
    /// Any one rule is enough.
    Or,
}

/// How many of one folder's **own** entries break a rule — never its sub-tree's; the page sums
/// descendants (`lib/folderRules.ts`'s `subtreeConflicts`).
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderConflicts {
    pub folder_id: i64,
    /// Rows.
    pub entries: i64,
    /// `sum(quantity)` over those rows.
    pub copies: i64,
}

/// What [`conflicts`] answers: a row per folder holding at least one conflicting entry, by
/// `folder_id`, and every conflicting entry id, ascending.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleConflicts {
    pub folders: Vec<FolderConflicts>,
    pub ids: Vec<i64>,
}

/// Which cabinet a rule is judged in — the two differ in what an entry-level fact is read from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Collection,
    Wishlist,
}

// ---------------------------------------------------------------------------------------
// Tidying, reading and writing
// ---------------------------------------------------------------------------------------

/// The list a write stores: each values rule cut down to its vocabulary, deduplicated and
/// sorted; each range and date checked; each group non-empty and at most [`MAX_GROUP_DEPTH`]
/// deep. Refused in one sentence otherwise.
///
/// **[`MAX_RULES`] counts the rules that test a card**, wherever they sit — a group tests
/// nothing itself, and a reader who wrapped two rules in one should not lose a third to it.
///
/// **Order and shape are kept** — rules are a list the reader arranged, and [`effective`] reads
/// them in it; a group of one is the reader's, not folded away.
pub fn tidy(rules: Vec<FolderRule>) -> Result<Vec<FolderRule>, String> {
    if leaves(&rules) > MAX_RULES {
        return Err(TOO_MANY_RULES.to_owned());
    }
    rules.into_iter().map(|r| tidy_one(r, 0)).collect()
}

/// How many rules in `rules` test a card, counting into every group.
fn leaves(rules: &[FolderRule]) -> usize {
    rules
        .iter()
        .map(|r| match r {
            FolderRule::Group { rules, .. } => leaves(rules),
            _ => 1,
        })
        .sum()
}

/// One rule at `depth` — the number of groups it sits inside.
fn tidy_one(rule: FolderRule, depth: usize) -> Result<FolderRule, String> {
    use FolderRule as R;
    Ok(match rule {
        R::Group { op, rules } => {
            if depth + 1 > MAX_GROUP_DEPTH {
                return Err(TOO_DEEP.to_owned());
            }
            if rules.is_empty() {
                return Err(EMPTY_GROUP.to_owned());
            }
            R::Group {
                op,
                rules: rules
                    .into_iter()
                    .map(|r| tidy_one(r, depth + 1))
                    .collect::<Result<_, _>>()?,
            }
        }
        R::Price { min, max } => {
            range(min, max)?;
            R::Price { min, max }
        }
        R::ManaValue { min, max } => {
            range(min, max)?;
            R::ManaValue { min, max }
        }
        R::Colors { values } => R::Colors {
            values: some(picked_colors(&values))?,
        },
        R::Types { values } => {
            let mut values = filters::picked_types(&values);
            values.sort();
            values.dedup();
            R::Types {
                values: some(values)?,
            }
        }
        R::Sets { values } => R::Sets {
            values: some(filters::picked_sets(&values))?,
        },
        R::Rarities { values } => {
            // `picked_rarities` normalises and does not validate (the search reads an unknown
            // rarity as matching nothing); a stored rule keeps only the words `cards` holds.
            let values = filters::picked_rarities(&values)
                .into_iter()
                .filter(|r| filters::ALL_RARITIES.contains(&r.as_str()))
                .collect();
            R::Rarities {
                values: some(values)?,
            }
        }
        R::Finishes { values } => R::Finishes {
            values: some(filters::picked_finishes(&values))?,
        },
        R::Conditions { values } => R::Conditions {
            values: some(picked_upper(&values, &CONDITIONS))?,
        },
        R::Borders { values } => R::Borders {
            values: some(filters::picked_borders(&values))?,
        },
        R::Released { from, to } => {
            let from = date(from)?;
            let to = date(to)?;
            match (&from, &to) {
                (None, None) => return Err(BAD_RANGE.to_owned()),
                (Some(f), Some(t)) => {
                    // Compared at the coarser precision: `2001-05` through `2001` is May to the
                    // end of 2001, and `2002` through `2001-06` is backwards.
                    let n = f.len().min(t.len());
                    if f[..n] > t[..n] {
                        return Err(BAD_RANGE.to_owned());
                    }
                }
                _ => {}
            }
            R::Released { from, to }
        }
    })
}

fn some(values: Vec<String>) -> Result<Vec<String>, String> {
    (!values.is_empty())
        .then_some(values)
        .ok_or_else(|| NO_VALUES.to_owned())
}

fn range(min: Option<f64>, max: Option<f64>) -> Result<(), String> {
    let bad = |v: Option<f64>| v.is_some_and(|v| !v.is_finite() || v < 0.0);
    match (min, max) {
        (None, None) => Err(BAD_RANGE.to_owned()),
        _ if bad(min) || bad(max) => Err(BAD_RANGE.to_owned()),
        (Some(lo), Some(hi)) if lo > hi => Err(BAD_RANGE.to_owned()),
        _ => Ok(()),
    }
}

/// A date end, trimmed; blank is no end at all.
fn date(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let parts: Vec<&str> = value.split('-').collect();
    let number = |s: &str, len: usize, lo: u32, hi: u32| {
        s.len() == len
            && s.bytes().all(|b| b.is_ascii_digit())
            && s.parse::<u32>().is_ok_and(|n| (lo..=hi).contains(&n))
    };
    let ok = match parts.as_slice() {
        [y] => number(y, 4, 0, 9999),
        [y, m] => number(y, 4, 0, 9999) && number(m, 2, 1, 12),
        [y, m, d] => number(y, 4, 0, 9999) && number(m, 2, 1, 12) && number(d, 2, 1, 31),
        _ => false,
    };
    ok.then_some(Some(value)).ok_or_else(|| BAD_DATE.to_owned())
}

/// The colour letters a rule names: trimmed, upper-cased, [`COLORS`] and [`COLORLESS`] only,
/// sorted and deduplicated.
fn picked_colors(values: &[String]) -> Vec<String> {
    let mut vocabulary: Vec<&str> = COLORS.to_vec();
    vocabulary.push(COLORLESS);
    picked_upper(values, &vocabulary)
}

/// `filters`' private `picked_from`, upper-case: the colour letters and the condition codes are
/// upper-case words where the chips' ids are lower-case ones.
fn picked_upper(values: &[String], vocabulary: &[&str]) -> Vec<String> {
    let mut picked: Vec<String> = values
        .iter()
        .map(|v| v.trim().to_ascii_uppercase())
        .filter(|v| vocabulary.contains(&v.as_str()))
        .collect();
    picked.sort();
    picked.dedup();
    picked
}

/// A `rules` column as rules — **lenient by design** (spec §3): an element that does not read
/// as a rule this build knows (a newer peer's kind, a malformed object) is skipped, and NULL or
/// anything that is not a JSON array is no rules at all. Never an error, because a folder whose
/// list could not be read would be a folder the page could not draw.
pub fn read_rules(text: Option<&str>) -> Vec<FolderRule> {
    text.and_then(|t| serde_json::from_str::<Vec<serde_json::Value>>(t).ok())
        .map(readable)
        .unwrap_or_default()
}

/// The elements of a JSON array that read as rules, the rest skipped.
fn readable(values: Vec<serde_json::Value>) -> Vec<FolderRule> {
    values
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect()
}

/// A group's `rules`, read as [`read_rules`] reads a column: a member a newer peer wrote in a
/// kind this build does not know is skipped rather than costing the whole group — and, through
/// it, the whole folder's list. Still an array, so a group with no `rules` list is malformed.
fn lenient_rules<'de, D>(deserializer: D) -> Result<Vec<FolderRule>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Vec::<serde_json::Value>::deserialize(deserializer).map(readable)
}

/// What a write stores: `None` (SQL NULL, never `'[]'`) for no rules.
pub fn write_rules(rules: &[FolderRule]) -> Option<String> {
    if rules.is_empty() {
        return None;
    }
    serde_json::to_string(rules).ok()
}

// ---------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------

type Params = Vec<Box<dyn ToSql>>;

/// A folder's own rules followed by each ancestor's, nearest first.
///
/// The walk stops at a folder already seen or past `MAX_FOLDER_DEPTH` hops, so a hand-made
/// cycle in `parent_id` costs a short list rather than a hang — the same budget the move's own
/// cycle walk climbs on.
fn effective(
    id: i64,
    parents: &HashMap<i64, Option<i64>>,
    own: &HashMap<i64, Vec<FolderRule>>,
) -> Vec<FolderRule> {
    let mut rules = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor = Some(id);
    while let Some(folder) = cursor {
        if !seen.insert(folder) || seen.len() > crate::collection_folders::MAX_FOLDER_DEPTH {
            break;
        }
        if let Some(list) = own.get(&folder) {
            rules.extend(list.iter().cloned());
        }
        cursor = parents.get(&folder).copied().flatten();
    }
    rules
}

/// `-∞`/`+∞` for a missing range end, as REALs SQLite can compare against.
fn low(v: &Option<f64>) -> Box<dyn ToSql> {
    Box::new(v.unwrap_or(f64::MIN))
}

fn high(v: &Option<f64>) -> Box<dyn ToSql> {
    Box::new(v.unwrap_or(f64::MAX))
}

/// One SQL fragment out of [`filters::push_card_filters`] for a [`CardFilters`] that sets one
/// list — so a rule reads the chip of the same name's exact SQL. `paper_only` is switched off,
/// since that arm is on by default and is no part of any rule. `None` when the filter adds no
/// SQL, which is how it reads a list naming nothing this build knows.
fn through_filters(f: CardFilters, alias: &str, params: &mut Params) -> Option<String> {
    let f = CardFilters {
        paper_only: Some(false),
        ..f
    };
    let mut p = Predicates::default();
    filters::push_card_filters(&mut p, &f, alias, None);
    if p.wheres.is_empty() {
        return None;
    }
    let sql = p.where_sql();
    params.extend(p.params);
    Some(sql)
}

/// The predicate a **card-level** rule puts on the printing `a`, or `None` for an entry-level
/// rule (price, finish, condition) or one with nothing this build can test.
fn card_predicate(rule: &FolderRule, a: &str, params: &mut Params) -> Option<String> {
    use FolderRule as R;
    match rule {
        R::ManaValue { min, max } => {
            params.push(low(min));
            params.push(high(max));
            Some(format!("{a}.cmc BETWEEN ? AND ?"))
        }
        R::Colors { values } => {
            let picked = picked_colors(values);
            if picked.is_empty() {
                return None;
            }
            // `cards.colors` is concatenated letters (`card_row`), `''` for a colourless card
            // and NULL where Scryfall gave none — an unknown, and so a pass. The letters are
            // [`COLORS`]' own and interpolated, `push_card_filters`' colour arm's reason.
            let colorless = i32::from(picked.iter().any(|c| c == COLORLESS));
            let excluded: Vec<String> = COLORS
                .iter()
                .filter(|l| !picked.iter().any(|p| p == *l))
                .map(|l| format!("instr({a}.colors, '{l}') = 0"))
                .collect();
            let coloured = if excluded.is_empty() {
                "1".to_owned()
            } else {
                excluded.join(" AND ")
            };
            Some(format!(
                "CASE WHEN {a}.colors IS NULL THEN NULL WHEN {a}.colors = '' THEN {colorless} \
                 ELSE ({coloured}) END"
            ))
        }
        R::Types { values } => through_filters(
            CardFilters {
                types: Some(values.clone()),
                ..Default::default()
            },
            a,
            params,
        ),
        R::Sets { values } => through_filters(
            CardFilters {
                sets: Some(values.clone()),
                ..Default::default()
            },
            a,
            params,
        ),
        R::Rarities { values } => through_filters(
            CardFilters {
                rarities: Some(values.clone()),
                ..Default::default()
            },
            a,
            params,
        ),
        R::Borders { values } => through_filters(
            CardFilters {
                borders: Some(values.clone()),
                ..Default::default()
            },
            a,
            params,
        ),
        R::Released { from, to } => {
            let mut ends = Vec::new();
            // Each end at its own precision: the length is interpolated as a number, the date
            // itself is bound.
            if let Some(from) = from.as_deref().filter(|s| !s.is_empty()) {
                ends.push(format!("substr({a}.released_at, 1, {}) >= ?", from.len()));
                params.push(Box::new(from.to_owned()));
            }
            if let Some(to) = to.as_deref().filter(|s| !s.is_empty()) {
                ends.push(format!("substr({a}.released_at, 1, {}) <= ?", to.len()));
                params.push(Box::new(to.to_owned()));
            }
            (!ends.is_empty()).then(|| ends.join(" AND "))
        }
        R::Price { .. } | R::Finishes { .. } | R::Conditions { .. } | R::Group { .. } => None,
    }
}

/// The predicate an **entry-level** rule puts on the row, or `None` for a card-level one.
/// `price` is the scope's unit-price expression over `c`.
fn entry_predicate(
    rule: &FolderRule,
    scope: Scope,
    price: &str,
    params: &mut Params,
) -> Option<String> {
    use FolderRule as R;
    let one_of = |column: &str, picked: Vec<String>, params: &mut Params| {
        if picked.is_empty() {
            return None;
        }
        let holes = vec!["?"; picked.len()].join(",");
        for value in picked {
            params.push(Box::new(value));
        }
        Some(format!("{column} IN ({holes})"))
    };
    match rule {
        R::Price { min, max } => {
            // `BETWEEN` so the price — a correlated subquery at the two table-backed
            // marketplaces — is spelled once.
            params.push(low(min));
            params.push(high(max));
            Some(format!("({price}) BETWEEN ? AND ?"))
        }
        R::Finishes { values } => {
            // A wish with no preferred finish is `NULL IN (…)`: no fact, so a pass.
            let column = match scope {
                Scope::Collection => ENTRY_FINISH,
                Scope::Wishlist => WISH_PREFERRED_FINISH,
            };
            one_of(column, filters::picked_finishes(values), params)
        }
        R::Conditions { values } => match scope {
            Scope::Collection => one_of("e.condition", picked_upper(values, &CONDITIONS), params),
            Scope::Wishlist => None,
        },
        _ => None,
    }
}

/// The SQL that is `1` when a row **satisfies** `rule` — card-level rules read on the printing
/// `card`, entry-level ones on the row — or `None` when the rule tests nothing this build can
/// read, and so always passes.
///
/// **Never NULL**: each leaf is `coalesce((pred), 1)` (an unknown is a pass, the module's second
/// decision), so a group is a plain `AND`/`OR` of its members' passes. An `or` with a member
/// that always passes always passes; an `and` drops it.
fn passes(
    rule: &FolderRule,
    scope: Scope,
    price: &str,
    card: &str,
    params: &mut Params,
) -> Option<String> {
    if let FolderRule::Group { op, rules } = rule {
        return joined(*op, rules, scope, price, card, params);
    }
    entry_predicate(rule, scope, price, params)
        .or_else(|| card_predicate(rule, card, params))
        .map(|pred| format!("coalesce(({pred}), 1)"))
}

/// [`passes`] over `rules` joined by `op` — `None` when nothing in them tests anything, or, for
/// an `or`, when one member always passes.
fn joined(
    op: GroupOp,
    rules: &[FolderRule],
    scope: Scope,
    price: &str,
    card: &str,
    params: &mut Params,
) -> Option<String> {
    // Each member's parameters land in a scratch list and join `params` only with a term that
    // reaches the text, so an `or` cut short leaves no stray `?` values behind it.
    let mut terms = Vec::new();
    let mut bound: Params = Vec::new();
    for rule in rules {
        let mut own: Params = Vec::new();
        match passes(rule, scope, price, card, &mut own) {
            Some(term) => {
                terms.push(term);
                bound.extend(own);
            }
            None if op == GroupOp::Or => return None,
            None => {}
        }
    }
    if terms.is_empty() {
        return None;
    }
    params.extend(bound);
    let glue = match op {
        GroupOp::And => " AND ",
        GroupOp::Or => " OR ",
    };
    Some(format!("({})", terms.join(glue)))
}

/// Whether anything in `rules` reads the printing — what decides an any-printing wish needs the
/// `EXISTS` over its oracle card's printings at all.
fn reads_the_card(rules: &[FolderRule]) -> bool {
    rules.iter().any(|r| match r {
        FolderRule::Group { rules, .. } => reads_the_card(rules),
        _ => card_predicate(r, "c", &mut Vec::new()).is_some(),
    })
}

/// The SQL that is true when a row **breaks** `rules` (the folder's effective list, an `and`),
/// over the scope's aliases (`e`/`w`, and `c` the printing), with its parameters pushed in text
/// order. `None` when no rule tests anything.
fn breaks(rules: &[FolderRule], scope: Scope, price: &str, params: &mut Params) -> Option<String> {
    match scope {
        Scope::Collection => {
            joined(GroupOp::And, rules, scope, price, "c", params).map(|p| format!("NOT {p}"))
        }
        Scope::Wishlist if reads_the_card(rules) => {
            // An any-printing wish breaks only when no printing of its oracle card meets **all**
            // of the rules at once (spec §1), each card-level rule read on that printing `c2` and
            // each of the row's own on the row — so an `or` across the two is still one printing's
            // answer. A pinned wish is its printing.
            let any = joined(GroupOp::And, rules, scope, price, "c2", params)?;
            let pinned = joined(GroupOp::And, rules, scope, price, "c", params)?;
            Some(format!(
                "CASE WHEN w.card_id IS NULL THEN NOT EXISTS (SELECT 1 FROM cards c2 \
                 WHERE c2.oracle_id = w.oracle_id AND {any}) ELSE NOT {pinned} END"
            ))
        }
        Scope::Wishlist => {
            joined(GroupOp::And, rules, scope, price, "c", params).map(|p| format!("NOT {p}"))
        }
    }
}

/// Every entry that breaks a rule of the folder it is filed in, with the per-folder counts.
///
/// One query per folder with at least one effective rule, over that folder's own entries.
/// **`c.id IS NOT NULL` is the orphan fence**: an entry whose printing is gone (or a wish
/// whose oracle card has no printing here) is a row the app knows nothing about, and so it
/// breaks nothing — not even a finish rule it could be read against. On the wishlist `c` is
/// the printing the wall shows (`wishlist::priced_wishes`), so a price rule is judged on the
/// figure on screen. In the collection an entry is priced as a held copy
/// ([`crate::sorting::held_price_expr`]), the figure the collection page, its price filter and
/// the folder summaries show — a default `nonfoil` on a foil-only printing is that finish's
/// price, not no price (issue #1123).
pub fn conflicts(
    conn: &Connection,
    scope: Scope,
    marketplace: Marketplace,
) -> Result<RuleConflicts, String> {
    let (folders_table, row) = match scope {
        Scope::Collection => ("collection_folders", "e"),
        Scope::Wishlist => ("wishlist_folders", "w"),
    };
    let mut parents: HashMap<i64, Option<i64>> = HashMap::new();
    let mut own: HashMap<i64, Vec<FolderRule>> = HashMap::new();
    {
        let mut stmt = conn
            .prepare(&format!("SELECT id, parent_id, rules FROM {folders_table}"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, parent, rules) = row.map_err(|e| e.to_string())?;
            parents.insert(id, parent);
            let rules = read_rules(rules.as_deref());
            if !rules.is_empty() {
                own.insert(id, rules);
            }
        }
    }

    let price = match scope {
        Scope::Collection => crate::sorting::held_price_expr(marketplace, ENTRY_FINISH),
        Scope::Wishlist => crate::sorting::row_price_expr(marketplace, WISH_PREFERRED_FINISH),
    };
    let from = match scope {
        Scope::Collection => {
            "collection_entries e LEFT JOIN cards c ON c.id = e.card_id".to_owned()
        }
        Scope::Wishlist => crate::wishlist::priced_wishes(&price),
    };

    let mut ids: Vec<i64> = parents.keys().copied().collect();
    ids.sort_unstable();
    let mut answer = RuleConflicts {
        folders: Vec::new(),
        ids: Vec::new(),
    };
    for folder in ids {
        let rules = effective(folder, &parents, &own);
        if rules.is_empty() {
            continue;
        }
        let mut params: Params = vec![Box::new(folder)];
        let Some(broken) = breaks(&rules, scope, &price, &mut params) else {
            continue;
        };
        let sql = format!(
            "SELECT {row}.id, {row}.quantity FROM {from}
              WHERE {row}.folder_id = ? AND c.id IS NOT NULL AND ({broken})"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let found = stmt
            .query_map(params_from_iter(params.iter()), |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        if found.is_empty() {
            continue;
        }
        answer.folders.push(FolderConflicts {
            folder_id: folder,
            entries: found.len() as i64,
            copies: found.iter().map(|(_, q)| q).sum(),
        });
        answer.ids.extend(found.into_iter().map(|(id, _)| id));
    }
    answer.ids.sort_unstable();
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{collection_folders, wishlist_folders};
    use rusqlite::params;

    fn open() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn
    }

    const MARKET: Marketplace = Marketplace::Tcgplayer;

    /// One printing, holding exactly the facts a rule reads. The default is a Lightning Bolt in
    /// Alpha at a dollar; each test changes the one fact it is about.
    #[derive(Clone)]
    struct Printing {
        id: &'static str,
        oracle: &'static str,
        set: &'static str,
        cmc: Option<f64>,
        colors: Option<&'static str>,
        types: &'static [&'static str],
        rarity: Option<&'static str>,
        border: Option<&'static str>,
        full_art: bool,
        released: Option<&'static str>,
        usd: Option<&'static str>,
        usd_foil: Option<&'static str>,
        finishes: Option<&'static str>,
    }

    const BOLT: Printing = Printing {
        id: "bolt",
        oracle: "o-bolt",
        set: "lea",
        cmc: Some(1.0),
        colors: Some("R"),
        types: &["Instant"],
        rarity: Some("common"),
        border: Some("black"),
        full_art: false,
        released: Some("1993-08-05"),
        usd: Some("1.00"),
        usd_foil: None,
        finishes: Some(r#"["nonfoil"]"#),
    };

    fn print(conn: &Connection, p: &Printing) {
        let types: Vec<String> = p.types.iter().map(|t| t.to_string()).collect();
        let mut prices = serde_json::Map::new();
        if let Some(usd) = p.usd {
            prices.insert("usd".into(), usd.into());
        }
        if let Some(foil) = p.usd_foil {
            prices.insert("usd_foil".into(), foil.into());
        }
        let prices = (!prices.is_empty()).then(|| serde_json::Value::Object(prices).to_string());
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout, raw,
                                cmc, colors, type_mask, rarity, border_color, full_art,
                                released_at, prices, finishes)
             VALUES (?1, ?2, 'A card', ?3, '1', 'en', 'normal', '{}',
                     ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                p.id,
                p.oracle,
                p.set,
                p.cmc,
                p.colors,
                crate::cardtypes::mask_of(&types),
                p.rarity,
                p.border,
                p.full_art,
                p.released,
                prices,
                p.finishes,
            ],
        )
        .unwrap();
    }

    fn binder(conn: &Connection, parent: Option<i64>, name: &str) -> i64 {
        collection_folders::create_folder(conn, parent, name)
            .unwrap()
            .id
    }

    fn own(
        conn: &Connection,
        card: &str,
        folder: Option<i64>,
        finish: &str,
        condition: &str,
        quantity: i64,
    ) -> i64 {
        conn.query_row(
            "INSERT INTO collection_entries
                (card_id, set_code, collector_number, lang, finish, condition, quantity,
                 folder_id, created_at, updated_at)
             VALUES (?1, 'lea', '1', 'en', ?2, ?3, ?4, ?5, unixepoch(), unixepoch())
             RETURNING id",
            params![card, finish, condition, quantity, folder],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn collection_ids(conn: &Connection) -> Vec<i64> {
        collection_folders::rule_conflicts(conn, MARKET)
            .unwrap()
            .ids
    }

    /// Does one copy of `p` — in `finish` and `condition` — break `rule`, filed alone in a
    /// folder holding that one rule?
    fn breaks_in_binder(rule: FolderRule, p: &Printing, finish: &str, condition: &str) -> bool {
        let conn = open();
        print(&conn, p);
        let folder = binder(&conn, None, "Binder");
        collection_folders::set_folder_rules(&conn, folder, vec![rule]).unwrap();
        let entry = own(&conn, p.id, Some(folder), finish, condition, 1);
        collection_ids(&conn).contains(&entry)
    }

    fn breaks(rule: FolderRule, p: Printing) -> bool {
        breaks_in_binder(rule, &p, "nonfoil", "NM")
    }

    fn values(kind: fn(Vec<String>) -> FolderRule, words: &[&str]) -> FolderRule {
        kind(words.iter().map(|w| w.to_string()).collect())
    }

    fn colors(v: Vec<String>) -> FolderRule {
        FolderRule::Colors { values: v }
    }
    fn types(v: Vec<String>) -> FolderRule {
        FolderRule::Types { values: v }
    }
    fn sets(v: Vec<String>) -> FolderRule {
        FolderRule::Sets { values: v }
    }
    fn rarities(v: Vec<String>) -> FolderRule {
        FolderRule::Rarities { values: v }
    }
    fn finishes(v: Vec<String>) -> FolderRule {
        FolderRule::Finishes { values: v }
    }
    fn conditions(v: Vec<String>) -> FolderRule {
        FolderRule::Conditions { values: v }
    }
    fn borders(v: Vec<String>) -> FolderRule {
        FolderRule::Borders { values: v }
    }
    fn released(from: Option<&str>, to: Option<&str>) -> FolderRule {
        FolderRule::Released {
            from: from.map(str::to_owned),
            to: to.map(str::to_owned),
        }
    }

    // ---- the wire ------------------------------------------------------------------------

    /// **The wire is the spec's, letter for letter**: a `kind` tag, camelCase kinds, `null` for
    /// an open end — the shapes `packages/ui/lib/ipc.ts` sends.
    #[test]
    fn a_rule_reads_and_writes_the_specs_json() {
        for (json, rule) in [
            (
                r#"{"kind":"manaValue","min":null,"max":3}"#,
                FolderRule::ManaValue {
                    min: None,
                    max: Some(3.0),
                },
            ),
            (
                r#"{"kind":"price","min":0,"max":1}"#,
                FolderRule::Price {
                    min: Some(0.0),
                    max: Some(1.0),
                },
            ),
            (
                r#"{"kind":"released","from":"2001","to":null}"#,
                released(Some("2001"), None),
            ),
            (
                r#"{"kind":"borders","values":["fullart"]}"#,
                values(borders, &["fullart"]),
            ),
        ] {
            let read: FolderRule = serde_json::from_str(json).unwrap();
            assert_eq!(read, rule, "{json}");
            let written = serde_json::to_string(&read).unwrap();
            assert_eq!(
                serde_json::from_str::<FolderRule>(&written).unwrap(),
                rule,
                "{written}"
            );
            let kind = serde_json::from_str::<serde_json::Value>(json).unwrap()["kind"].clone();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&written).unwrap()["kind"],
                kind
            );
        }
        let conflicts = RuleConflicts {
            folders: vec![FolderConflicts {
                folder_id: 4,
                entries: 1,
                copies: 3,
            }],
            ids: vec![9],
        };
        assert_eq!(
            serde_json::to_value(&conflicts).unwrap(),
            serde_json::json!({ "folders": [{ "folderId": 4, "entries": 1, "copies": 3 }], "ids": [9] })
        );
    }

    /// **Lenient on read** (spec §3): a kind this build does not know, an element missing its
    /// payload and a stray number are skipped; NULL and anything that is not an array are none.
    #[test]
    fn read_rules_skips_what_it_cannot_read_and_never_fails() {
        let text = r#"[{"kind":"price","min":0,"max":1},{"kind":"flavour","values":["x"]},
                       {"kind":"sets"},42,{"kind":"sets","values":["lea"]}]"#;
        assert_eq!(
            read_rules(Some(text)),
            vec![
                FolderRule::Price {
                    min: Some(0.0),
                    max: Some(1.0)
                },
                values(sets, &["lea"]),
            ]
        );
        assert!(read_rules(None).is_empty());
        assert!(read_rules(Some("not json")).is_empty());
        assert!(read_rules(Some(r#"{"kind":"price","min":0,"max":1}"#)).is_empty());
        assert_eq!(write_rules(&[]), None, "no rules is NULL, never '[]'");
    }

    // ---- tidying -------------------------------------------------------------------------

    #[test]
    fn tidy_keeps_each_values_rules_vocabulary_sorted_and_once() {
        let tidied = tidy(vec![
            values(colors, &[" u", "R", "x", "U", "c"]),
            values(types, &["Instant", "creature", "Creature", "Instant"]),
            values(sets, &[" LEA ", "", "lea", "M10"]),
            values(rarities, &["Rare", "shiny", "bonus"]),
            values(finishes, &["FOIL", "glossy"]),
            values(conditions, &["nm", "LP", "mint"]),
            values(borders, &["Fullart", "gold"]),
            released(Some(" 2001 "), Some("")),
        ])
        .unwrap();
        assert_eq!(
            tidied,
            vec![
                values(colors, &["C", "R", "U"]),
                values(types, &["Creature", "Instant"]),
                values(sets, &["lea", "m10"]),
                values(rarities, &["bonus", "rare"]),
                values(finishes, &["foil"]),
                values(conditions, &["LP", "NM"]),
                values(borders, &["fullart"]),
                released(Some("2001"), None),
            ]
        );
    }

    #[test]
    fn tidy_refuses_in_one_sentence_each() {
        assert!(TOO_MANY_RULES.contains(&MAX_RULES.to_string()));
        let many = vec![values(sets, &["lea"]); MAX_RULES + 1];
        assert_eq!(tidy(many).unwrap_err(), TOO_MANY_RULES);
        assert_eq!(
            tidy(vec![values(sets, &["lea"]); MAX_RULES]).unwrap().len(),
            20
        );

        assert_eq!(tidy(vec![values(colors, &["x"])]).unwrap_err(), NO_VALUES);
        assert_eq!(tidy(vec![values(sets, &[" "])]).unwrap_err(), NO_VALUES);

        for (min, max) in [
            (None, None),
            (Some(3.0), Some(1.0)),
            (Some(-1.0), None),
            (None, Some(-0.5)),
        ] {
            assert_eq!(
                tidy(vec![FolderRule::Price { min, max }]).unwrap_err(),
                BAD_RANGE
            );
            assert_eq!(
                tidy(vec![FolderRule::ManaValue { min, max }]).unwrap_err(),
                BAD_RANGE
            );
        }
        assert!(tidy(vec![FolderRule::Price {
            min: Some(1.0),
            max: Some(1.0)
        }])
        .is_ok());

        for bad in ["01", "2001-13", "2001-1", "2001-02-32", "2001/02", "twenty"] {
            assert_eq!(
                tidy(vec![released(Some(bad), None)]).unwrap_err(),
                BAD_DATE,
                "{bad}"
            );
        }
        assert_eq!(
            tidy(vec![released(None, Some(" "))]).unwrap_err(),
            BAD_RANGE
        );
        assert_eq!(
            tidy(vec![released(Some("2002"), Some("2001-06"))]).unwrap_err(),
            BAD_RANGE
        );
        assert!(tidy(vec![released(Some("2001-05"), Some("2001"))]).is_ok());
    }

    // ---- what each kind means ------------------------------------------------------------

    #[test]
    fn a_price_rule_breaks_on_a_known_price_outside_the_range() {
        let under_a_dollar = || FolderRule::Price {
            min: None,
            max: Some(1.0),
        };
        assert!(
            !breaks(under_a_dollar(), BOLT),
            "$1.00 is inside, ends included"
        );
        assert!(breaks(
            under_a_dollar(),
            Printing {
                usd: Some("2.50"),
                ..BOLT
            }
        ));
        assert!(
            !breaks(under_a_dollar(), Printing { usd: None, ..BOLT }),
            "unpriced is no fact"
        );
        // The entry's own finish is what is priced: a foil copy of a printing quoted nonfoil
        // only has no price, and so passes.
        assert!(!breaks_in_binder(
            FolderRule::Price {
                min: Some(5.0),
                max: None
            },
            &BOLT,
            "foil",
            "NM"
        ));
        assert!(breaks(
            FolderRule::Price {
                min: Some(5.0),
                max: None
            },
            BOLT
        ));
    }

    /// **A held copy is priced as the collection page prices it** (issue #1123): a default
    /// `nonfoil` copy of a printing sold only in foil is that foil's price, not no price, so a
    /// "price ≤ $5" binder outlines it rather than passing it as unpriced.
    #[test]
    fn a_price_rule_reads_a_default_nonfoil_copy_of_a_foil_only_printing_at_its_foil_price() {
        let surge = Printing {
            usd: None,
            usd_foil: Some("47.97"),
            finishes: Some(r#"["foil"]"#),
            ..BOLT
        };
        let five_or_less = || FolderRule::Price {
            min: None,
            max: Some(5.0),
        };
        assert!(breaks(five_or_less(), surge.clone()));
        assert!(breaks_in_binder(five_or_less(), &surge, "foil", "NM"));
        assert!(!breaks(
            FolderRule::Price {
                min: Some(40.0),
                max: None
            },
            surge
        ));
        // A printing that is sold in nonfoil and not quoted in it stays unpriced.
        assert!(!breaks(
            five_or_less(),
            Printing {
                usd: None,
                usd_foil: Some("47.97"),
                finishes: Some(r#"["nonfoil","foil"]"#),
                ..BOLT
            }
        ));
    }

    #[test]
    fn a_mana_value_rule_reads_cmc_and_passes_an_unknown_one() {
        let two_or_three = || FolderRule::ManaValue {
            min: Some(2.0),
            max: Some(3.0),
        };
        assert!(breaks(two_or_three(), BOLT));
        assert!(!breaks(
            two_or_three(),
            Printing {
                cmc: Some(3.0),
                ..BOLT
            }
        ));
        assert!(!breaks(two_or_three(), Printing { cmc: None, ..BOLT }));
    }

    #[test]
    fn a_colors_rule_wants_every_colour_among_its_values() {
        let blue = || values(colors, &["U"]);
        let card = |c: Option<&'static str>| Printing { colors: c, ..BOLT };
        assert!(!breaks(blue(), card(Some("U"))));
        assert!(breaks(blue(), card(Some("UR"))), "red is not among them");
        assert!(breaks(blue(), card(Some(""))), "colourless needs C");
        assert!(!breaks(values(colors, &["U", "C"]), card(Some(""))));
        assert!(!breaks(values(colors, &["U", "R"]), card(Some("UR"))));
        assert!(!breaks(blue(), card(None)), "no colours given is no fact");
    }

    #[test]
    fn the_chip_rules_read_the_chips_sql() {
        let card = |p: Printing| p;
        assert!(breaks(values(types, &["Creature"]), BOLT));
        assert!(!breaks(values(types, &["Creature", "Instant"]), BOLT));
        assert!(!breaks(values(sets, &["lea"]), BOLT));
        assert!(breaks(values(sets, &["leb"]), BOLT));
        assert!(breaks(values(rarities, &["rare"]), BOLT));
        assert!(!breaks(values(rarities, &["common"]), BOLT));

        let borderless = card(Printing {
            border: Some("borderless"),
            ..BOLT
        });
        let full_art = card(Printing {
            full_art: true,
            ..BOLT
        });
        assert!(!breaks(values(borders, &["regular"]), BOLT));
        assert!(breaks(values(borders, &["regular"]), borderless.clone()));
        assert!(breaks(values(borders, &["regular"]), full_art.clone()));
        assert!(!breaks(values(borders, &["borderless"]), borderless));
        assert!(!breaks(values(borders, &["fullart"]), full_art));
        assert!(
            !breaks(
                values(borders, &["regular"]),
                Printing {
                    border: None,
                    ..BOLT
                }
            ),
            "no border given is not borderless — the chip's own reading"
        );
    }

    #[test]
    fn the_copy_rules_read_the_entry() {
        assert!(!breaks_in_binder(
            values(finishes, &["foil"]),
            &BOLT,
            "foil",
            "NM"
        ));
        assert!(breaks_in_binder(
            values(finishes, &["foil"]),
            &BOLT,
            "nonfoil",
            "NM"
        ));
        assert!(!breaks_in_binder(
            values(conditions, &["NM", "LP"]),
            &BOLT,
            "nonfoil",
            "LP"
        ));
        assert!(breaks_in_binder(
            values(conditions, &["NM"]),
            &BOLT,
            "nonfoil",
            "HP"
        ));
    }

    #[test]
    fn a_released_rule_compares_each_end_at_its_own_precision() {
        let on = |date: &'static str| Printing {
            released: Some(date),
            ..BOLT
        };
        let early_2000s = || released(Some("2001"), Some("2005"));
        assert!(!breaks(early_2000s(), on("2001-01-01")));
        assert!(
            !breaks(early_2000s(), on("2005-12-31")),
            "to 2005 is through 2005"
        );
        assert!(breaks(early_2000s(), on("2000-12-31")));
        assert!(breaks(early_2000s(), on("2006-01-01")));
        assert!(!breaks(released(Some("2005-06"), None), on("2005-06-01")));
        assert!(breaks(released(Some("2005-06"), None), on("2005-05-31")));
        assert!(!breaks(
            early_2000s(),
            Printing {
                released: None,
                ..BOLT
            }
        ));
    }

    /// **An entry whose printing is gone breaks nothing** — not even a finish rule its own row
    /// could be read against (spec §1).
    #[test]
    fn an_orphaned_entry_breaks_nothing() {
        let conn = open();
        let folder = binder(&conn, None, "Binder");
        collection_folders::set_folder_rules(
            &conn,
            folder,
            vec![values(finishes, &["foil"]), values(sets, &["leb"])],
        )
        .unwrap();
        own(&conn, "gone", Some(folder), "nonfoil", "NM", 2);
        assert_eq!(
            collection_folders::rule_conflicts(&conn, MARKET).unwrap(),
            RuleConflicts {
                folders: vec![],
                ids: vec![]
            }
        );
    }

    // ---- inheritance and counting --------------------------------------------------------

    /// **A subfolder adopts its parent's rules**, and a conflict is counted where the entry is
    /// filed, never in the parent — the page sums the sub-tree. Every rule is enforced: a copy
    /// meeting the child's own rule still breaks the grandparent's.
    #[test]
    fn a_subfolders_entry_breaks_its_ancestors_rules_and_is_counted_where_it_is() {
        let conn = open();
        print(&conn, &BOLT);
        print(
            &conn,
            &Printing {
                id: "bolt-leb",
                set: "leb",
                ..BOLT
            },
        );
        print(
            &conn,
            &Printing {
                id: "bolt-m10",
                set: "m10",
                usd: Some("9.00"),
                ..BOLT
            },
        );
        let cabinet = binder(&conn, None, "Cabinet");
        let drawer = binder(&conn, Some(cabinet), "Drawer");
        let tray = binder(&conn, Some(drawer), "Tray");
        let elsewhere = binder(&conn, None, "Elsewhere");
        collection_folders::set_folder_rules(
            &conn,
            cabinet,
            vec![FolderRule::Price {
                min: None,
                max: Some(5.0),
            }],
        )
        .unwrap();
        collection_folders::set_folder_rules(&conn, drawer, vec![values(sets, &["lea", "m10"])])
            .unwrap();

        let fine = own(&conn, "bolt", Some(tray), "nonfoil", "NM", 1);
        let wrong_set = own(&conn, "bolt-leb", Some(tray), "nonfoil", "NM", 3);
        let too_dear = own(&conn, "bolt-m10", Some(drawer), "nonfoil", "NM", 2);
        let in_cabinet = own(&conn, "bolt-leb", Some(cabinet), "nonfoil", "NM", 1);
        own(&conn, "bolt-m10", Some(elsewhere), "nonfoil", "NM", 4);
        own(&conn, "bolt-m10", None, "foil", "NM", 4);

        let answer = collection_folders::rule_conflicts(&conn, MARKET).unwrap();
        assert_eq!(answer.ids, vec![wrong_set, too_dear]);
        assert!(!answer.ids.contains(&fine));
        assert!(
            !answer.ids.contains(&in_cabinet),
            "the drawer's rule is not the cabinet's"
        );
        assert_eq!(
            answer.folders,
            vec![
                FolderConflicts {
                    folder_id: drawer,
                    entries: 1,
                    copies: 2
                },
                FolderConflicts {
                    folder_id: tray,
                    entries: 1,
                    copies: 3
                },
            ]
        );

        // Move the tray out from under the cabinet and what it inherits goes with it.
        collection_folders::move_folder(&conn, tray, None).unwrap();
        assert_eq!(collection_ids(&conn), vec![too_dear]);
    }

    // ---- the wishlist --------------------------------------------------------------------

    fn wish(
        conn: &Connection,
        oracle: &str,
        card: Option<&str>,
        finish: Option<&str>,
        folder: i64,
    ) -> i64 {
        conn.query_row(
            "INSERT INTO wishlist_entries
                (oracle_id, card_id, name, quantity, preferred_finish, folder_id,
                 created_at, updated_at)
             VALUES (?1, ?2, 'A card', 2, ?3, ?4, unixepoch(), unixepoch())
             RETURNING id",
            params![oracle, card, finish, folder],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn wishlist_ids(conn: &Connection) -> Vec<i64> {
        wishlist_folders::rule_conflicts(conn, MARKET).unwrap().ids
    }

    /// **An any-printing wish breaks a card-level rule only when no printing meets all of them
    /// at once** (spec §1); a pinned wish is judged on its own printing.
    #[test]
    fn an_any_printing_wish_is_judged_by_whether_some_printing_fits() {
        let conn = open();
        print(
            &conn,
            &Printing {
                rarity: Some("rare"),
                ..BOLT
            },
        );
        print(
            &conn,
            &Printing {
                id: "bolt-leb",
                set: "leb",
                ..BOLT
            },
        );
        let folder = wishlist_folders::create_folder(&conn, None, "Wants")
            .unwrap()
            .id;
        let any = wish(&conn, "o-bolt", None, None, folder);
        let pinned = wish(&conn, "o-bolt", Some("bolt"), None, folder);

        wishlist_folders::set_folder_rules(&conn, folder, vec![values(sets, &["leb"])]).unwrap();
        assert_eq!(wishlist_ids(&conn), vec![pinned], "Beta has a printing");

        wishlist_folders::set_folder_rules(&conn, folder, vec![values(sets, &["m10"])]).unwrap();
        assert_eq!(wishlist_ids(&conn), vec![any, pinned], "no printing in M10");

        // Alpha is rare and Beta common: each rule has a printing, the pair has none.
        wishlist_folders::set_folder_rules(
            &conn,
            folder,
            vec![values(sets, &["lea"]), values(rarities, &["common"])],
        )
        .unwrap();
        assert_eq!(wishlist_ids(&conn), vec![any, pinned]);

        let answer = wishlist_folders::rule_conflicts(&conn, MARKET).unwrap();
        assert_eq!(
            answer.folders,
            vec![FolderConflicts {
                folder_id: folder,
                entries: 2,
                copies: 4
            }]
        );
    }

    #[test]
    fn a_wish_is_judged_on_its_preferred_finish_its_row_price_and_never_a_condition() {
        let conn = open();
        print(&conn, &BOLT);
        print(
            &conn,
            &Printing {
                id: "bolt-leb",
                set: "leb",
                usd: Some("8.00"),
                ..BOLT
            },
        );
        let folder = wishlist_folders::create_folder(&conn, None, "Wants")
            .unwrap()
            .id;
        let unstated = wish(&conn, "o-bolt", None, None, folder);
        let nonfoil = wish(&conn, "o-bolt", None, Some("nonfoil"), folder);
        let dear = wish(&conn, "o-bolt", Some("bolt-leb"), None, folder);
        let orphan = wish(&conn, "o-nothing", None, Some("nonfoil"), folder);

        wishlist_folders::set_folder_rules(
            &conn,
            folder,
            vec![values(finishes, &["foil", "etched"])],
        )
        .unwrap();
        assert_eq!(
            wishlist_ids(&conn),
            vec![nonfoil],
            "no preferred finish is no fact"
        );
        assert!(!wishlist_ids(&conn).contains(&unstated));
        assert!(
            !wishlist_ids(&conn).contains(&orphan),
            "no printing at all is no fact"
        );

        // The any-printing wishes show Alpha's dollar; the pinned one shows Beta's eight.
        wishlist_folders::set_folder_rules(
            &conn,
            folder,
            vec![FolderRule::Price {
                min: None,
                max: Some(2.0),
            }],
        )
        .unwrap();
        assert_eq!(wishlist_ids(&conn), vec![dear]);

        wishlist_folders::set_folder_rules(&conn, folder, vec![values(conditions, &["NM"])])
            .unwrap();
        assert!(wishlist_ids(&conn).is_empty(), "a wish has no condition");
    }

    // ---- AND / OR groups (issue #1053) ---------------------------------------------------

    fn any_of(rules: Vec<FolderRule>) -> FolderRule {
        FolderRule::Group {
            op: GroupOp::Or,
            rules,
        }
    }

    fn all_of(rules: Vec<FolderRule>) -> FolderRule {
        FolderRule::Group {
            op: GroupOp::And,
            rules,
        }
    }

    /// **A group is a rule on the wire**: `kind: "group"`, a lower-case `op`, and its members
    /// as the list's own shapes — nested as deep as they were written.
    #[test]
    fn a_group_reads_and_writes_its_json() {
        let json = r#"{"kind":"group","op":"or","rules":[{"kind":"rarities","values":["rare"]},
                      {"kind":"group","op":"and","rules":[{"kind":"borders","values":["fullart"]},
                      {"kind":"types","values":["Land"]}]}]}"#;
        let rule = any_of(vec![
            values(rarities, &["rare"]),
            all_of(vec![
                values(borders, &["fullart"]),
                values(types, &["Land"]),
            ]),
        ]);
        assert_eq!(serde_json::from_str::<FolderRule>(json).unwrap(), rule);
        let written = serde_json::to_value(&rule).unwrap();
        assert_eq!(written["kind"], "group");
        assert_eq!(written["op"], "or");
        assert_eq!(written["rules"][1]["op"], "and");
        assert_eq!(
            read_rules(write_rules(std::slice::from_ref(&rule)).as_deref()),
            vec![rule]
        );
    }

    /// **A group is read as leniently as the list**: a member of a kind this build does not know
    /// costs that member, never the group; a group with no `rules` array is itself malformed and
    /// skipped like any other.
    #[test]
    fn a_group_skips_the_members_it_cannot_read() {
        let text = r#"[{"kind":"group","op":"or","rules":[{"kind":"flavour","values":["x"]},
                       {"kind":"sets","values":["lea"]}]},{"kind":"group","op":"or"},
                       {"kind":"group","op":"xor","rules":[]}]"#;
        assert_eq!(
            read_rules(Some(text)),
            vec![any_of(vec![values(sets, &["lea"])])]
        );
    }

    #[test]
    fn tidy_reaches_into_groups_and_refuses_an_empty_or_too_deep_one() {
        assert_eq!(
            tidy(vec![any_of(vec![
                values(sets, &[" LEA "]),
                values(colors, &["u"])
            ])])
            .unwrap(),
            vec![any_of(vec![values(sets, &["lea"]), values(colors, &["U"])])]
        );
        assert_eq!(tidy(vec![any_of(vec![])]).unwrap_err(), EMPTY_GROUP);
        assert_eq!(
            tidy(vec![all_of(vec![any_of(vec![])])]).unwrap_err(),
            EMPTY_GROUP
        );
        assert_eq!(
            tidy(vec![any_of(vec![values(sets, &[" "])])]).unwrap_err(),
            NO_VALUES
        );

        let deepest = any_of(vec![all_of(vec![any_of(vec![values(sets, &["lea"])])])]);
        assert!(tidy(vec![deepest.clone()]).is_ok());
        assert!(TOO_DEEP.contains(&MAX_GROUP_DEPTH.to_string()));
        assert_eq!(tidy(vec![all_of(vec![deepest])]).unwrap_err(), TOO_DEEP);

        // `MAX_RULES` counts what tests a card, wherever it sits; a group is not one.
        let twenty = vec![values(sets, &["lea"]); MAX_RULES];
        assert!(tidy(vec![any_of(twenty.clone())]).is_ok());
        assert_eq!(
            tidy(vec![any_of(twenty), values(sets, &["lea"])]).unwrap_err(),
            TOO_MANY_RULES
        );
    }

    /// **The issue's two examples**, as a reader builds them: "greater than $10 AND land" is
    /// two rules side by side; "rare OR full art AND land" is one `or` group holding an `and`.
    #[test]
    fn groups_join_rules_with_and_and_or() {
        let land = |p: Printing| Printing {
            types: &["Land"],
            ..p
        };
        let dear_land = || {
            vec![
                FolderRule::Price {
                    min: Some(10.0),
                    max: None,
                },
                values(types, &["Land"]),
            ]
        };
        let check = |rules: Vec<FolderRule>, p: Printing| {
            let conn = open();
            print(&conn, &p);
            let folder = binder(&conn, None, "Binder");
            collection_folders::set_folder_rules(&conn, folder, rules).unwrap();
            let entry = own(&conn, p.id, Some(folder), "nonfoil", "NM", 1);
            collection_ids(&conn).contains(&entry)
        };
        let pricey = |p: Printing| Printing {
            usd: Some("12.00"),
            ..p
        };
        assert!(!check(dear_land(), land(pricey(BOLT))));
        assert!(check(dear_land(), land(BOLT)), "a dollar is not over ten");
        assert!(check(dear_land(), pricey(BOLT)), "an instant is not a land");

        let rare_or_full_art_land = || {
            vec![any_of(vec![
                values(rarities, &["rare"]),
                all_of(vec![
                    values(borders, &["fullart"]),
                    values(types, &["Land"]),
                ]),
            ])]
        };
        let rare = |p: Printing| Printing {
            rarity: Some("rare"),
            ..p
        };
        let full_art = |p: Printing| Printing {
            full_art: true,
            ..p
        };
        assert!(!check(rare_or_full_art_land(), rare(BOLT)));
        assert!(!check(rare_or_full_art_land(), full_art(land(BOLT))));
        assert!(
            check(rare_or_full_art_land(), full_art(BOLT)),
            "full art, no land"
        );
        assert!(
            check(rare_or_full_art_land(), land(BOLT)),
            "land, not full art"
        );
        assert!(check(rare_or_full_art_land(), BOLT));

        // An unknown is still a pass inside an `or`: an unpriced common passes "over $10 or rare".
        let dear_or_rare = || {
            vec![any_of(vec![
                FolderRule::Price {
                    min: Some(10.0),
                    max: None,
                },
                values(rarities, &["rare"]),
            ])]
        };
        assert!(!check(dear_or_rare(), Printing { usd: None, ..BOLT }));
        assert!(check(dear_or_rare(), BOLT));
        assert!(!check(dear_or_rare(), pricey(BOLT)));
    }

    /// **A group joins a subfolder's rules to its ancestors' with AND**, as any rule does: the
    /// parent's `or` and the child's own rule are both enforced.
    #[test]
    fn a_group_is_inherited_like_any_rule() {
        let conn = open();
        print(&conn, &BOLT);
        let cabinet = binder(&conn, None, "Cabinet");
        let drawer = binder(&conn, Some(cabinet), "Drawer");
        collection_folders::set_folder_rules(
            &conn,
            cabinet,
            vec![any_of(vec![
                values(sets, &["leb"]),
                values(rarities, &["common"]),
            ])],
        )
        .unwrap();
        collection_folders::set_folder_rules(&conn, drawer, vec![values(colors, &["U"])]).unwrap();
        let red_common = own(&conn, "bolt", Some(drawer), "nonfoil", "NM", 1);
        assert_eq!(
            collection_ids(&conn),
            vec![red_common],
            "red breaks the drawer's own"
        );
        collection_folders::set_folder_rules(&conn, drawer, vec![]).unwrap();
        assert!(
            collection_ids(&conn).is_empty(),
            "a common meets the cabinet's `or`"
        );
    }

    /// **An any-printing wish is one printing's answer to the whole list**, an `or` included: a
    /// group reading the wish's own finish or the printing's set passes when the finish does,
    /// or when some printing is in the set.
    #[test]
    fn an_any_printing_wish_answers_a_group_with_one_printing() {
        let conn = open();
        print(&conn, &BOLT);
        let folder = wishlist_folders::create_folder(&conn, None, "Wants")
            .unwrap()
            .id;
        let any = wish(&conn, "o-bolt", None, Some("nonfoil"), folder);
        let foil_or_beta = || {
            vec![any_of(vec![
                values(finishes, &["foil"]),
                values(sets, &["leb"]),
            ])]
        };

        wishlist_folders::set_folder_rules(&conn, folder, foil_or_beta()).unwrap();
        assert_eq!(
            wishlist_ids(&conn),
            vec![any],
            "nonfoil, and no Beta printing"
        );

        print(
            &conn,
            &Printing {
                id: "bolt-leb",
                set: "leb",
                ..BOLT
            },
        );
        assert!(wishlist_ids(&conn).is_empty(), "a Beta printing exists");

        // Alpha's printing is not foil-wished and not Beta, Beta's is not Alpha: no one printing
        // meets both rules, so the wish breaks however its `or` reads.
        wishlist_folders::set_folder_rules(
            &conn,
            folder,
            vec![
                values(sets, &["lea"]),
                any_of(vec![values(finishes, &["foil"]), values(sets, &["leb"])]),
            ],
        )
        .unwrap();
        assert_eq!(wishlist_ids(&conn), vec![any]);

        // A wish has no condition, so an `or` holding a condition rule always passes.
        wishlist_folders::set_folder_rules(
            &conn,
            folder,
            vec![any_of(vec![
                values(conditions, &["NM"]),
                values(sets, &["m10"]),
            ])],
        )
        .unwrap();
        assert!(wishlist_ids(&conn).is_empty());
    }
}
