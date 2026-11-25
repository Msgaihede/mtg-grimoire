//! `engine.ts`: how big the deck is, how many copies of a card it holds, whether the format's
//! card pool admits them, the mana-value ceiling — and the two entry points, `validate_deck` and
//! `validate_for_marks`.
//!
//! **Every rule is read from data**, as in the TypeScript: the sizes and copy limits come from the
//! seeded `format_specs` row, the pool from each card's own `legalities` blob, what `restricted`
//! means from `restricted_semantic`, whether a format is judged against a pool from
//! `has_legality_data`, and whether it is judged at all from `validates`. There is no format key
//! compared in this file and there must never be one.
//!
//! Copy limits are `f64` because the TypeScript's are numbers: `Infinity` for a basic land, a card
//! that permits any number, and a format with no `max_copies`.

use std::collections::HashMap;

use serde_json::{Map, Value};

use super::commanders::{color_identity_issues, commander_identity, validate_commander_zone};
use super::companions::companion_issues;
use super::faces_of;
use super::issue::ValidationIssue;
use super::singleton::{copy_exception, is_basic_land, unreadable_copy_count};
use crate::deck::{DeckCardRow, FormatSpecRow};

/// `kinds.ts`' `SIZE_KINDS`: the category kinds the format's deck size counts together. The
/// switch (`category_active`) decides whether a pile counts at all; the kind decides only whether
/// it is played *beside* the deck (`side`, `companion`) or *in* it. A switched-on Maybeboard is in
/// the deck.
pub const SIZE_KINDS: [&str; 3] = ["main", "commander", "maybe"];

/// `IDENTITY_KINDS`: the kinds the deck-wide colour-identity pass holds to the commander —
/// [`SIZE_KINDS`] less the command zone (which judges itself), plus the sideboard. The companion
/// is `companions.rs`' to judge. Spelled here; a test holds it to that derivation.
pub const IDENTITY_KINDS: [&str; 3] = ["main", "maybe", "side"];

/// Everything wrong with this deck under this format — `validateDeck`: the deck's own shape
/// (size, sideboard), then its copy counts, then each card in the read's order, then the command
/// zone and the companion. Never panics: bad data is a warning.
pub fn validate_deck(cards: &[DeckCardRow], spec: &FormatSpecRow) -> Vec<ValidationIssue> {
    // Read from the cell, never the key: `unspecified` judges nothing, not even a bad blob.
    if !spec.validates {
        return Vec::new();
    }
    let deck: Vec<&DeckCardRow> = cards.iter().filter(|c| c.category_active).collect();
    let legalities = read_legalities(&deck);
    let mut issues = deck_size_issues(&deck, spec);
    issues.extend(sideboard_issues(&deck, spec));
    issues.extend(copy_issues(&deck, spec, &legalities));
    issues.extend(card_issues(&deck, spec, &legalities));
    issues.extend(commander_issues(&deck, spec));
    let companions: Vec<&DeckCardRow> = deck
        .iter()
        .copied()
        .filter(|c| c.category_kind == "companion")
        .collect();
    issues.extend(companion_issues(&companions, &deck, spec));
    collapse(issues)
}

/// Everything a **card mark** may draw — `validateForMarks`: [`validate_deck`]'s findings filed
/// under the active rows, then [`inactive_card_issues`] filed under the parked ones. Two answers on
/// purpose: the deck's findings are about the deck, the parked ones say whether a switched-off
/// card could ever come in.
pub fn validate_for_marks(cards: &[DeckCardRow], spec: &FormatSpecRow) -> Vec<ValidationIssue> {
    if !spec.validates {
        return Vec::new();
    }
    let active: Vec<&DeckCardRow> = cards.iter().filter(|c| c.category_active).collect();
    let parked: Vec<&DeckCardRow> = cards.iter().filter(|c| !c.category_active).collect();
    let mut issues = on_rows(validate_deck(cards, spec), &active);
    issues.extend(on_rows(inactive_card_issues(cards, spec), &parked));
    issues
}

/// `onRows`: each finding with `row_ids` — the rows **this pass judged** whose printing it names
/// (issue #554: a mark is about a row, not a printing). A finding with no `card_ids` gains none;
/// one whose printing names none of these rows gains an empty list.
fn on_rows(issues: Vec<ValidationIssue>, rows: &[&DeckCardRow]) -> Vec<ValidationIssue> {
    issues
        .into_iter()
        .map(|mut issue| {
            if let Some(named) = &issue.card_ids {
                issue.row_ids = Some(
                    rows.iter()
                        .filter(|row| named.contains(&row.card_id))
                        .map(|row| row.id)
                        .collect(),
                );
            }
            issue
        })
        .collect()
}

/// `inactiveCardIssues`: what is wrong with the cards in switched-off piles — **the card's own
/// facts**: legality, the mana-value ceiling, and colour identity against the **active** command
/// zone (parked `commander` rows are left out, being alternatives rather than cards held to the
/// current one). Never size, sideboard, copies or the zone's eligibility — those are arithmetic
/// over a pile. Collapsed on its own, so a card in an active and a parked pile keeps a finding
/// each.
pub fn inactive_card_issues(cards: &[DeckCardRow], spec: &FormatSpecRow) -> Vec<ValidationIssue> {
    let parked: Vec<&DeckCardRow> = cards.iter().filter(|c| !c.category_active).collect();
    if parked.is_empty() {
        return Vec::new();
    }
    let mut issues = card_issues(&parked, spec, &read_legalities(&parked));
    let zone: Vec<&DeckCardRow> = cards
        .iter()
        .filter(|c| c.category_active && c.category_kind == "commander")
        .collect();
    let identity = match spec.commander_rule {
        None => None,
        Some(_) => commander_identity(&zone, spec),
    };
    if let Some(identity) = identity {
        let judged: Vec<&DeckCardRow> = parked
            .iter()
            .copied()
            .filter(|c| c.category_kind != "commander")
            .collect();
        issues.extend(color_identity_issues(&judged, identity));
    }
    collapse(issues)
}

/// `collapse`: one `(code, message)`, one finding — the first, taking every later duplicate's
/// `card_ids` with it, deduplicated in order. A finding about the deck carries no ids and gains
/// none.
fn collapse(issues: Vec<ValidationIssue>) -> Vec<ValidationIssue> {
    let mut first: HashMap<(&'static str, String), usize> = HashMap::new();
    let mut kept: Vec<ValidationIssue> = Vec::new();
    for issue in issues {
        let key = (issue.code, issue.message.clone());
        let Some(&at) = first.get(&key) else {
            first.insert(key, kept.len());
            kept.push(issue);
            continue;
        };
        let (Some(seen), Some(more)) = (kept[at].card_ids.as_mut(), issue.card_ids) else {
            continue;
        };
        // `[...new Set([...seen, ...more])]`: the whole list deduplicated, first sighting kept.
        let mut merged: Vec<String> = Vec::with_capacity(seen.len() + more.len());
        for id in seen.drain(..).chain(more) {
            if !merged.contains(&id) {
                merged.push(id);
            }
        }
        *seen = merged;
    }
    kept
}

/// `copyLimitFor`: copies of this card allowed under this spec — `INFINITY` for basic lands and
/// for a card whose own text permits any number, the printed count for the "up to N" cards, and
/// the format's `max_copies` otherwise (`None` there is unlimited). `restricted` is not folded
/// in: what it means is the format's, read in the copy pass.
pub fn copy_limit_for(card: &DeckCardRow, spec: &FormatSpecRow) -> f64 {
    if is_basic_land(card.type_line.as_deref()) {
        return f64::INFINITY;
    }
    if let Some(exception) = copy_exception(card.oracle_text.as_deref()) {
        return exception;
    }
    spec.max_copies.map_or(f64::INFINITY, |n| n as f64)
}

/// Every card fact null together — the deck read is a `LEFT JOIN` and this is what a miss looks
/// like: `layout`, `rarity`, `legalities` and `oracle_id` all `None`.
pub fn is_orphan(card: &DeckCardRow) -> bool {
    card.layout.is_none()
        && card.rarity.is_none()
        && card.legalities.is_none()
        && card.oracle_id.is_none()
}

/// The mana value of a printed cost: `{2}{U}` is 3, `{X}` is 0 (CR 202.3b), a hybrid counts its
/// greater half (`{2/W}` is 2), `{½}` is a half, and any other symbol is one mana.
///
/// The symbols are `/\{([^}]*)\}/g`'s matches: a `{`, then everything up to the next `}`.
pub fn mana_value_of(cost: Option<&str>) -> f64 {
    let Some(cost) = cost.filter(|c| !c.is_empty()) else {
        return 0.0;
    };
    // `let total = 0; total += …` — a fold from `0.0`, not `Sum`, which starts from `-0.0`.
    symbols(cost)
        .map(symbol_value)
        .fold(0.0, |total, value| total + value)
}

/// The brace-less symbols of a cost, in order — the captures of `/\{([^}]*)\}/g`.
///
/// A `{` with no `}` after it ends the matches, since no later `{` can have one either. A `{`
/// inside a symbol is part of it (`[^}]*` admits it), so `{{2}` is the one symbol `{2`.
pub fn symbols(cost: &str) -> impl Iterator<Item = &str> {
    let mut rest = cost;
    std::iter::from_fn(move || {
        let open = rest.find('{')?;
        let after = &rest[open + 1..];
        let close = after.find('}')?;
        let symbol = &after[..close];
        rest = &after[close + 1..];
        Some(symbol)
    })
}

/// One brace-less symbol's contribution — `engine.ts`' `symbolValue`.
fn symbol_value(token: &str) -> f64 {
    // A hybrid is paid one way or the other; its mana value is the greater half.
    if token.contains('/') {
        return token
            .split('/')
            .map(symbol_value)
            .fold(f64::NEG_INFINITY, f64::max);
    }
    let upper = token.to_uppercase();
    if upper == "X" || upper == "Y" || upper == "Z" {
        return 0.0;
    }
    if token == "½" {
        return 0.5;
    }
    super::js_number(token).unwrap_or(1.0)
}

/// `deckSizeIssue`: the deck-size rule over a count already taken — `validate_deck`'s own
/// sentence, for a caller that has only `DeckRow.card_count`. `None` when the size fits and when
/// the format judges nothing.
pub fn deck_size_issue(size: i64, spec: &FormatSpecRow) -> Option<ValidationIssue> {
    if !spec.validates {
        return None;
    }
    let (min, max, format) = (spec.deck_min, spec.deck_max, &spec.display_name);
    // An exactly-sized format is wrong in both directions, and says so in one sentence.
    if let Some(max) = max.filter(|max| *max == min) {
        if size == max {
            return None;
        }
        let including = if spec.requires_commander {
            " including the commander"
        } else {
            ""
        };
        return Some(ValidationIssue::error(
            "deck-size",
            format!("{format} decks are exactly {max} cards{including}; you have {size}."),
            None,
        ));
    }
    if size < min {
        return Some(ValidationIssue::error(
            "deck-size",
            format!("{format} decks need at least {min} cards; you have {size}."),
            None,
        ));
    }
    // CR 100.5: most formats have no maximum at all, which is what `deck_max` NULL means.
    match max {
        Some(max) if size > max => Some(ValidationIssue::error(
            "deck-size",
            format!("{format} decks are at most {max} cards; you have {size}."),
            None,
        )),
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------
// Legalities: parsed once per row, read many times.
// ---------------------------------------------------------------------------------------------

/// One row's `legalities` blob, as `readLegalities` leaves it.
enum Blob {
    /// The column is null: the format's list does not mention the card.
    Absent,
    /// Not JSON, or JSON that is not an object — evidence of nothing.
    Unreadable,
    Object(Map<String, Value>),
}

/// What a blob says about one format, or why it says nothing — `LegalityRead`.
enum LegalityRead<'a> {
    Status(&'a str),
    Missing,
    Unreadable,
}

/// `readLegalities`, one entry per row of `deck`, in its order. `JSON.parse` of a blob that is
/// not a JSON object is unreadable — never a panic.
fn read_legalities(deck: &[&DeckCardRow]) -> Vec<Blob> {
    deck.iter()
        .map(|card| match card.legalities.as_deref() {
            None => Blob::Absent,
            Some(text) => match serde_json::from_str::<Value>(text) {
                Ok(Value::Object(map)) => Blob::Object(map),
                _ => Blob::Unreadable,
            },
        })
        .collect()
}

/// `legalityOf`: `blob[spec.key]` when it is a string.
fn legality_of<'a>(blob: &'a Blob, spec: &FormatSpecRow) -> LegalityRead<'a> {
    match blob {
        Blob::Absent => LegalityRead::Missing,
        Blob::Unreadable => LegalityRead::Unreadable,
        Blob::Object(map) => match map.get(&spec.key).and_then(Value::as_str) {
            Some(status) => LegalityRead::Status(status),
            None => LegalityRead::Missing,
        },
    }
}

fn status_of<'a>(blob: &'a Blob, spec: &FormatSpecRow) -> Option<&'a str> {
    match legality_of(blob, spec) {
        LegalityRead::Status(status) => Some(status),
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------
// The rules.
// ---------------------------------------------------------------------------------------------

fn quantity_in(deck: &[&DeckCardRow], kinds: &[&str]) -> i64 {
    deck.iter()
        .filter(|card| kinds.contains(&card.category_kind.as_str()))
        .map(|card| card.quantity)
        .sum()
}

fn deck_size_issues(deck: &[&DeckCardRow], spec: &FormatSpecRow) -> Vec<ValidationIssue> {
    deck_size_issue(quantity_in(deck, &SIZE_KINDS), spec)
        .into_iter()
        .collect()
}

/// `sideboardIssues`: `sideboard_max` NULL is uncapped, 0 is no sideboard, and a companion takes
/// a sideboard slot only where there is a sideboard to take one from.
fn sideboard_issues(deck: &[&DeckCardRow], spec: &FormatSpecRow) -> Vec<ValidationIssue> {
    let Some(cap) = spec.sideboard_max else {
        return Vec::new();
    };
    let companions = if cap > 0 {
        quantity_in(deck, &["companion"])
    } else {
        0
    };
    let size = quantity_in(deck, &["side"]) + companions;
    if cap == 0 {
        if size > 0 {
            let message = format!("{} decks have no sideboard.", spec.display_name);
            return vec![ValidationIssue::error("sideboard-size", message, None)];
        }
        return Vec::new();
    }
    if size > cap {
        let message = format!("Sideboards are capped at {cap} cards; you have {size}.");
        return vec![ValidationIssue::error("sideboard-size", message, None)];
    }
    Vec::new()
}

/// Every row of one card, wherever in the deck it sits — `CopyGroup`. `rows` are indices into
/// the deck slice the group was taken from.
struct CopyGroup<'a> {
    name: &'a str,
    quantity: i64,
    card_ids: Vec<String>,
    rows: Vec<usize>,
}

/// `groupCopies`: grouped by `oracle_id`, falling back to the row's `name` (all an orphan has),
/// in first-seen order. Every row it is handed counts — the switch was applied a step earlier.
fn group_copies<'a>(deck: &[&'a DeckCardRow]) -> Vec<CopyGroup<'a>> {
    let mut at: HashMap<&'a str, usize> = HashMap::new();
    let mut groups: Vec<CopyGroup<'a>> = Vec::new();
    for (row, card) in deck.iter().enumerate() {
        let card: &'a DeckCardRow = card;
        let key = card.oracle_id.as_deref().unwrap_or(&card.name);
        let index = *at.entry(key).or_insert_with(|| {
            groups.push(CopyGroup {
                name: &card.name,
                quantity: 0,
                card_ids: Vec::new(),
                rows: Vec::new(),
            });
            groups.len() - 1
        });
        let group = &mut groups[index];
        group.quantity += card.quantity;
        if !group.card_ids.contains(&card.card_id) {
            group.card_ids.push(card.card_id.clone());
        }
        group.rows.push(row);
    }
    groups
}

/// `copyIssues`.
fn copy_issues(
    deck: &[&DeckCardRow],
    spec: &FormatSpecRow,
    legalities: &[Blob],
) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    for group in group_copies(deck) {
        let rows: Vec<&DeckCardRow> = group.rows.iter().map(|&i| deck[i]).collect();
        // A group of orphans only has no facts to count against (issue #554); the orphan warning
        // says the one true thing about it. One live row speaks for the card.
        if rows.iter().all(|row| is_orphan(row)) {
            continue;
        }
        // TRAP A: `restricted` is one copy only where the format says that is what it means; any
        // printing saying so speaks for the card.
        let restricted = spec.has_legality_data
            && spec.restricted_semantic == "max_one"
            && group
                .rows
                .iter()
                .any(|&i| status_of(&legalities[i], spec) == Some("restricted"));
        let printed = printed_exception(&rows);
        let limit = if restricted {
            1.0
        } else {
            rows.iter()
                .map(|row| copy_limit_for(row, spec))
                .fold(f64::NEG_INFINITY, f64::max)
        };
        let CopyGroup {
            name,
            quantity,
            card_ids,
            ..
        } = group;
        let format = &spec.display_name;

        if quantity as f64 <= limit {
            // A printed count this app could not read let the card past a limit it might not
            // clear. Warn only where the unread clause is doing work.
            let without_clause = spec.max_copies.map_or(f64::INFINITY, |n| n as f64);
            if let Some(unreadable) = unreadable_count(&rows) {
                if !restricted && quantity as f64 > without_clause {
                    issues.push(ValidationIssue::warning(
                        "unknown-copy-limit",
                        format!(
                            "Couldn't read {name}'s copy limit (\u{201C}{unreadable}\u{201D}), so its {quantity} copies weren't checked."
                        ),
                        Some(card_ids),
                    ));
                }
            }
            continue;
        }

        let limit_text = js_number_text(limit);
        let issue = if restricted {
            ValidationIssue::error(
                "restricted",
                format!("{name} is restricted in {format}: max 1 copy; you have {quantity}."),
                Some(card_ids),
            )
        } else if printed == Some(limit) {
            ValidationIssue::error(
                "copy-limit",
                format!(
                    "{name} allows up to {limit_text} copies by its own text; you have {quantity}."
                ),
                Some(card_ids),
            )
        } else if spec.singleton && limit == 1.0 {
            ValidationIssue::error(
                "singleton",
                format!("{format} decks are singleton: max 1 copy of {name}; you have {quantity}."),
                Some(card_ids),
            )
        } else {
            ValidationIssue::error(
                "copy-limit",
                format!(
                    "{format} decks allow up to {limit_text} copies of {name}; you have {quantity}."
                ),
                Some(card_ids),
            )
        };
        issues.push(issue);
    }
    issues
}

/// `unreadableCount`: the unreadable printed count from whichever row carries one.
fn unreadable_count<'a>(rows: &[&'a DeckCardRow]) -> Option<&'a str> {
    rows.iter()
        .find_map(|row| unreadable_copy_count(row.oracle_text.as_deref()))
}

/// `printedException`: the largest count the group's own text permits, read across the rows so
/// one orphaned printing cannot cancel the card's own permission.
fn printed_exception(rows: &[&DeckCardRow]) -> Option<f64> {
    let mut printed: Option<f64> = None;
    for row in rows {
        if let Some(exception) = copy_exception(row.oracle_text.as_deref()) {
            if printed.is_none_or(|p| exception > p) {
                printed = Some(exception);
            }
        }
    }
    printed
}

/// `cardIssues`: per row, the orphan warning — or legality against the pool and the mana-value
/// ceiling.
fn card_issues(
    deck: &[&DeckCardRow],
    spec: &FormatSpecRow,
    legalities: &[Blob],
) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    for (row, card) in deck.iter().enumerate() {
        if is_orphan(card) {
            // `card.needsReview ? … : …` — an empty sentence is no sentence.
            let message = match card.needs_review.as_deref().filter(|s| !s.is_empty()) {
                Some(why) => format!("{}: {why}", card.name),
                None => format!(
                    "{} isn't in your card data, so it wasn't checked against {} rules.",
                    card.name, spec.display_name
                ),
            };
            issues.push(ValidationIssue::warning(
                "orphan",
                message,
                Some(vec![card.card_id.clone()]),
            ));
            continue;
        }
        if spec.has_legality_data {
            issues.extend(legality_issues(card, spec, &legalities[row]));
        }
        issues.extend(mana_value_issue(card, spec));
    }
    issues
}

/// `legalityIssues`.
fn legality_issues(card: &DeckCardRow, spec: &FormatSpecRow, blob: &Blob) -> Vec<ValidationIssue> {
    let (name, format) = (&card.name, &spec.display_name);
    let ids = || Some(vec![card.card_id.clone()]);
    match legality_of(blob, spec) {
        LegalityRead::Unreadable => vec![ValidationIssue::warning(
            "unknown-legality",
            format!("Couldn't read {name}'s {format} legality."),
            ids(),
        )],
        // A list that does not mention a card is a pool that does not contain it.
        LegalityRead::Missing => outside_pool_issues(card, spec),
        LegalityRead::Status("legal") | LegalityRead::Status("restricted") => Vec::new(),
        LegalityRead::Status("banned") => vec![ValidationIssue::error(
            "banned",
            format!("{name} is banned in {format}."),
            ids(),
        )],
        LegalityRead::Status("not_legal") => outside_pool_issues(card, spec),
        LegalityRead::Status(other) => vec![ValidationIssue::warning(
            "unknown-legality",
            format!("{name} has an unrecognized {format} legality (\u{201C}{other}\u{201D})."),
            ids(),
        )],
    }
}

/// `outsidePoolIssues`, and TRAP C: under the `pdh` rule the pool key answers for the 99 (commons),
/// so it says nothing about the commander, which rarity judges instead. A ban still speaks.
fn outside_pool_issues(card: &DeckCardRow, spec: &FormatSpecRow) -> Vec<ValidationIssue> {
    if spec.commander_rule.as_deref() == Some("pdh") && card.category_kind == "commander" {
        return Vec::new();
    }
    vec![ValidationIssue::error(
        "not-legal",
        format!("{} isn't legal in {}.", card.name, spec.display_name),
        Some(vec![card.card_id.clone()]),
    )]
}

/// `commanderIssues`: the command zone (judged for every format), then — where there is a rule and
/// a zone to derive an identity from — every [`IDENTITY_KINDS`] card held to it.
fn commander_issues(deck: &[&DeckCardRow], spec: &FormatSpecRow) -> Vec<ValidationIssue> {
    let zone: Vec<&DeckCardRow> = deck
        .iter()
        .copied()
        .filter(|c| c.category_kind == "commander")
        .collect();
    let mut issues = validate_commander_zone(&zone, spec);
    let identity = match spec.commander_rule {
        None => None,
        Some(_) => commander_identity(&zone, spec),
    };
    let Some(identity) = identity else {
        return issues;
    };
    let judged: Vec<&DeckCardRow> = deck
        .iter()
        .copied()
        .filter(|c| IDENTITY_KINDS.contains(&c.category_kind.as_str()))
        .collect();
    issues.extend(color_identity_issues(&judged, identity));
    issues
}

/// `manaValueIssue`: Tiny Leaders' ceiling over "every card **and every face**".
fn mana_value_issue(card: &DeckCardRow, spec: &FormatSpecRow) -> Option<ValidationIssue> {
    let cap = spec.max_mana_value?;
    let own = own_mana_value(card);
    let face = face_mana_value(card);
    let worst = own
        .unwrap_or(f64::NEG_INFINITY)
        .max(face.unwrap_or(f64::NEG_INFINITY));
    if !worst.is_finite() || worst <= cap as f64 {
        return None;
    }
    let capped = format!(
        "{} caps every card and every face at {cap}.",
        spec.display_name
    );
    let ids = Some(vec![card.card_id.clone()]);
    let message = match face {
        Some(face) if face > own.unwrap_or(f64::NEG_INFINITY) => format!(
            "{} has a face with mana value {}; {capped}",
            card.name,
            js_number_text(face)
        ),
        _ => format!(
            "{} has mana value {}; {capped}",
            card.name,
            js_number_text(worst)
        ),
    };
    Some(ValidationIssue::error("mana-value", message, ids))
}

/// `ownManaValue`: the `cmc` column, or the printed cost's value when it is null.
fn own_mana_value(card: &DeckCardRow) -> Option<f64> {
    card.cmc.or_else(|| {
        card.mana_cost
            .as_deref()
            .map(|cost| mana_value_of(Some(cost)))
    })
}

/// `faceManaValue`: the largest of the faces' values — a face's own numeric `cmc` (reversible
/// cards), else its `mana_cost` — or `None` with no face to read.
fn face_mana_value(card: &DeckCardRow) -> Option<f64> {
    let mut worst: Option<f64> = None;
    for face in faces_of(card.faces.as_deref()) {
        // `typeof face.cmc === "number"`; a face that is not an object answers `None` to both.
        let value = face.get("cmc").and_then(Value::as_f64).or_else(|| {
            face.get("mana_cost")
                .and_then(Value::as_str)
                .map(|cost| mana_value_of(Some(cost)))
        });
        if let Some(value) = value {
            if worst.is_none_or(|w| value > w) {
                worst = Some(value);
            }
        }
    }
    worst
}

/// `String(n)` for a JavaScript number, as a template literal prints it: shortest round-trip
/// digits, a plain decimal from 1e-6 up to 1e21 and an exponent outside that, `Infinity`, and
/// `0` for negative zero.
pub(crate) fn js_number_text(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_owned();
    }
    if n == 0.0 {
        return "0".to_owned();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if n < 0.0 {
        return format!("-{}", js_number_text(-n));
    }
    // Rust's `{:e}` is the shortest round-trip digits: `d[.ddd]e<exp>`.
    let sci = format!("{n:e}");
    let (mantissa, exp) = sci.split_once('e').expect("`{:e}` writes an exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i64;
    let e: i64 = exp.parse().expect("`{:e}` writes an integer exponent");
    let n_exp = e + 1; // the decimal point sits after `n_exp` digits
    if k <= n_exp && n_exp <= 21 {
        return format!("{digits}{}", "0".repeat((n_exp - k) as usize));
    }
    if 0 < n_exp && n_exp <= 21 {
        let (int, frac) = digits.split_at(n_exp as usize);
        return format!("{int}.{frac}");
    }
    if -6 < n_exp && n_exp <= 0 {
        return format!("0.{}{digits}", "0".repeat((-n_exp) as usize));
    }
    let sign = if n_exp - 1 < 0 { '-' } else { '+' };
    let power = (n_exp - 1).abs();
    if k == 1 {
        format!("{digits}e{sign}{power}")
    } else {
        format!("{}.{}e{sign}{power}", &digits[..1], &digits[1..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck_golden::{assert_same, load, name};

    #[test]
    fn mana_value_reads_every_symbol_kind() {
        assert_eq!(mana_value_of(None), 0.0);
        assert_eq!(mana_value_of(Some("")), 0.0);
        assert_eq!(mana_value_of(Some("{2}{U}")), 3.0);
        assert_eq!(mana_value_of(Some("{X}{B}{B}{B}")), 3.0);
        assert_eq!(mana_value_of(Some("{2/W}{2/W}")), 4.0);
        assert_eq!(mana_value_of(Some("{W/U}{G/P}")), 2.0);
        assert_eq!(mana_value_of(Some("{½}")), 0.5);
        assert_eq!(mana_value_of(Some("{10}")), 10.0);
        assert_eq!(mana_value_of(Some("{}")), 0.0);
        assert_eq!(mana_value_of(Some("{2")), 0.0);
        assert_eq!(mana_value_of(Some("{{2}")), 1.0);
    }

    #[test]
    fn symbols_are_the_regex_s_captures() {
        assert_eq!(symbols("{2}{U}").collect::<Vec<_>>(), ["2", "U"]);
        assert_eq!(symbols("a{1}b{").collect::<Vec<_>>(), ["1"]);
        assert_eq!(symbols("{{2}}").collect::<Vec<_>>(), ["{2"]);
    }

    #[test]
    fn identity_kinds_are_size_kinds_less_the_zone_plus_the_sideboard() {
        let mut derived: Vec<&str> = SIZE_KINDS
            .iter()
            .copied()
            .filter(|k| *k != "commander")
            .collect();
        derived.push("side");
        assert_eq!(derived, IDENTITY_KINDS);
    }

    #[test]
    fn numbers_print_as_javascript_prints_them() {
        let cases: [(f64, &str); 16] = [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (6.0, "6"),
            (3.5, "3.5"),
            (0.5, "0.5"),
            (-2.25, "-2.25"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (0.000001, "0.000001"),
            (0.0000001, "1e-7"),
            (1.25e-7, "1.25e-7"),
            (123456.789, "123456.789"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
        ];
        for (n, text) in cases {
            assert_eq!(js_number_text(n), text, "{n}");
        }
        assert_eq!(js_number_text(0.1 + 0.2), "0.30000000000000004");
    }

    fn spec(validates: bool) -> FormatSpecRow {
        FormatSpecRow {
            key: "modern".into(),
            display_name: "Modern".into(),
            enabled_in_picker: true,
            deck_min: 60,
            deck_max: None,
            max_copies: Some(4),
            sideboard_max: Some(15),
            singleton: false,
            requires_commander: false,
            commander_rule: None,
            life: 20,
            restricted_semantic: "max_one".into(),
            has_legality_data: true,
            max_mana_value: None,
            allows_companion: true,
            sort_order: 7,
            games: vec!["paper".into()],
            validates,
        }
    }

    /// `engine.test.ts`' `deckSizeIssue` cases: a bare count gets `validate_deck`'s sentence.
    #[test]
    fn deck_size_issue_answers_a_bare_count() {
        let modern = spec(true);
        assert_eq!(
            deck_size_issue(59, &modern).map(|i| i.message),
            Some("Modern decks need at least 60 cards; you have 59.".to_owned())
        );
        assert!(deck_size_issue(60, &modern).is_none());
        assert!(deck_size_issue(247, &modern).is_none());
        let capped = FormatSpecRow {
            deck_max: Some(80),
            ..spec(true)
        };
        assert_eq!(
            deck_size_issue(81, &capped).map(|i| i.message),
            Some("Modern decks are at most 80 cards; you have 81.".to_owned())
        );
        let commander = FormatSpecRow {
            display_name: "Commander".into(),
            deck_min: 100,
            deck_max: Some(100),
            requires_commander: true,
            ..spec(true)
        };
        assert_eq!(
            deck_size_issue(73, &commander).map(|i| i.message),
            Some(
                "Commander decks are exactly 100 cards including the commander; you have 73."
                    .to_owned()
            )
        );
        assert!(deck_size_issue(3, &spec(false)).is_none());
    }

    #[test]
    fn collapse_dedupes_only_on_merge() {
        let issue = |ids: &[&str]| {
            ValidationIssue::error(
                "banned",
                "X is banned.",
                Some(ids.iter().map(|s| s.to_string()).collect()),
            )
        };
        let kept = collapse(vec![issue(&["a", "a"]), issue(&["b", "a"])]);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].card_ids, Some(vec!["a".to_owned(), "b".to_owned()]));
        let alone = collapse(vec![issue(&["a", "a"])]);
        assert_eq!(
            alone[0].card_ids,
            Some(vec!["a".to_owned(), "a".to_owned()])
        );
    }

    #[test]
    fn validation_golden() {
        let golden = load(include_str!(
            "../../../../packages/ui/features/decks/__golden__/validation.json"
        ));
        for case in &golden.cases {
            let cards = golden.cards(&case["cards"]);
            let spec = golden.spec(&case["spec"]);
            let deck = serde_json::to_value(validate_deck(&cards, &spec)).unwrap();
            assert_same(&deck, &case["deck"], &format!("{} (deck)", name(case)));
            let marks = serde_json::to_value(validate_for_marks(&cards, &spec)).unwrap();
            assert_same(&marks, &case["marks"], &format!("{} (marks)", name(case)));
        }
    }

    /// `whole-deck.json`: the same two entry points over decks with a companion, so the companion
    /// pass is held inside the pipeline (sideboard slot, copies, identity) and not only alone.
    #[test]
    fn whole_deck_golden() {
        let golden = load(include_str!(
            "../../../../packages/ui/features/decks/__golden__/whole-deck.json"
        ));
        for case in &golden.cases {
            let cards = golden.cards(&case["cards"]);
            let spec = golden.spec(&case["spec"]);
            let deck = serde_json::to_value(validate_deck(&cards, &spec)).unwrap();
            assert_same(&deck, &case["deck"], &format!("{} (deck)", name(case)));
            let marks = serde_json::to_value(validate_for_marks(&cards, &spec)).unwrap();
            assert_same(&marks, &case["marks"], &format!("{} (marks)", name(case)));
        }
    }
}
