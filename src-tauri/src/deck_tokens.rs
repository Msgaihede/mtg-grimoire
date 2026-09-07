//! The tokens and emblems a deck needs — derived from `all_parts` on every open, with only the
//! reader's deviations stored.
//!
//! A deck that plays `Smothering Tithe` needs a Treasure; one that plays
//! `Elspeth, Sun's Champion` needs Soldiers **and** an emblem. Neither fact is in a column:
//! Scryfall publishes it inside each printing's `all_parts` array, which this crate stores gzipped
//! in `cards.raw`. So this module is [`crate::card::meld_parts`]' sibling — the same inflate,
//! the same parse, the same walk over `all_parts`, the same "every failure is an empty vec" —
//! pointed at a different `component`.
//!
//! ```text
//!   deck_cards ─▶ cards.raw (gzip) ─▶ all_parts ─▶ resolve each id in `cards`
//!                                                     │
//!                              keep: component == token  OR  target layout == emblem
//!                                                     │
//!                                group by ORACLE ID ──┴──▶ LEFT JOIN deck_tokens
//! ```
//!
//! # Derived, never stored
//!
//! The list is recomputed on every deck open — measured at ~5 ms in Node for a denser-than-typical
//! 100-card pool, and Rust beats that, because only the cards in the open deck are ever inflated.
//! A *stored* list would need a reconciliation pass on every deck edit and would go stale the next
//! time a Scryfall sync changed a card's `all_parts`, with nothing to notice. What is written down
//! is only the reader's deviation: [`crate::schema::DECK_TOKEN_GRAIN`], one row per token per deck,
//! and no row at all for a token nobody has touched.
//!
//! **Nothing is gated on `layout` before the blob is touched**, which is the one place this parts
//! company with [`crate::card::meld_parts`]. That function gates on `layout = 'meld'` and turns a
//! decompression on every card the reader opens into one on 72 rows of 117 621. There is no such
//! column here: token references sit on 15 161 printings and nothing predicts them, so a
//! corpus-wide index would have to be a new ingest-filled column and a cold full scan costs 6.5 s.
//! The question is never asked corpus-wide — only of the deck in front of the reader.
//!
//! # The boundary
//!
//! Rust supplies *facts* and TypeScript draws *conclusions*, the crate root's rule. The effective
//! quantity (`stored ?? 1`), the effective printing (`cardId ?? defaultCardId`), whether a
//! dismissed row is drawn and what order the wall is in are all `src/features/decks/deckTokens.ts`.
//! A `hidden` row is answered here like any other; hiding it is a decision.
//!
//! **A token's name does not identify it**, which is why [`DeckTokenRow`] carries four fields no
//! resolver needs. 104 token/emblem names in the corpus are shared by more than one `oracle_id` —
//! `Elemental` by 31, `Spirit` by 22, `Soldier` by 13 — and `Wurmcoil Engine` alone puts two
//! tokens both called `Wurm` in one deck, separated only by Deathtouch and Lifelink. Power,
//! toughness, colors and oracle text together told 8 of 8 apart in both sampled names (debug
//! corpus, 2026-09-07), and two tiles announcing one accessible name is a bug that has already
//! shipped once on the collection wall.

use crate::schema::DECK_TOKEN_GRAIN;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};

/// The `all_parts` `component` values that name a token outright.
///
/// **This is half the rule, and on its own it is wrong.** A full-corpus scan on 2026-09-07 found
/// exactly four component values — `combo_piece` 148 216, `token` 16 377, `meld_part` 164,
/// `meld_result` 81 — and emblems are *not* in the `token` half: `Elspeth, Sun's Champion` names
/// her emblem as a `combo_piece` with `type_line: "Emblem — Elspeth"`. The other half of the rule
/// is [`EXTRA_LAYOUTS`], tested against the row the entry resolves to.
const TOKEN_COMPONENTS: [&str; 1] = ["token"];

/// Layouts that make a resolved `all_parts` target one of the reader's extras whatever its
/// component said. Only `emblem` — a token already arrives as `component: "token"`.
///
/// **Not an allow-list for the component half.** The layouts a `component: "token"` entry resolves
/// to are `token` 16 216, `double_faced_token` 79, **`flip` 75** and `reversible_card` 3, so
/// gating the component half on layout would silently drop 78 real token relationships.
const EXTRA_LAYOUTS: [&str; 1] = ["emblem"];

/// The three words `deck_tokens.state` may hold, in the order the DDL's `CHECK` spells them.
///
/// * `auto` — the row exists only to carry a printing and/or a quantity for a token the deck
///   derives anyway.
/// * `hidden` — the reader dismissed it. Still derived, deliberately not drawn.
/// * `manual` — drawn whether or not anything derives it: a token the reader added by hand, and
///   also what a derived token becomes when they want it kept after cutting the card that made it.
///
/// A constant here as well as a `CHECK` in the table, so an unknown word is a **sentence**
/// ([`BAD_STATE`]) rather than a constraint failure — [`crate::deck::set_folder`]'s rule, and it
/// applies here because a command parameter reaches this column.
/// `an_unknown_state_word_is_refused_by_name` walks every word in this constant through the real
/// table, which is what holds the two spellings together.
const TOKEN_STATES: [&str; 3] = ["auto", "hidden", "manual"];

/// The column's own DEFAULT, by index rather than by spelling — [`crate::deck`]'s `LIVE`
/// arrangement, so the two cannot drift.
const AUTO_STATE: &str = TOKEN_STATES[0];

/// `TOKEN_STATES[2]`, by index for [`AUTO_STATE`]'s reason.
const MANUAL_STATE: &str = TOKEN_STATES[2];

/// What a write says when the state word is not one of [`TOKEN_STATES`].
pub const BAD_STATE: &str = "That is not something a token can be.";

/// What [`add_token`] says when the printing it was handed is not in the corpus.
///
/// A sentence rather than silence, because this arrives from a printings grid the reader was just
/// looking at: an id that has gone since means the corpus moved under them, and a press that
/// reported success and stored nothing would be worse.
pub const NO_SUCH_PRINTING: &str = "That printing is not in the card database any more.";

/// A deck card that makes a token — the answer to *why is this here*.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSource {
    pub card_id: String,
    pub name: String,
}

/// One token or emblem a deck needs, with the reader's stored override joined on.
///
/// `card_id`, `quantity` and `state` are all `None` when there is no stored row — the table holds
/// only deviations, so three nulls is the ordinary case and never a default in disguise.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckTokenRow {
    pub oracle_id: String,
    pub name: String,
    pub type_line: Option<String>,
    pub layout: String,
    /// The four disambiguation fields. **A token's name does not identify it** — see this
    /// module's header for the measurements, and note that `power` and `toughness` are
    /// **strings** because Scryfall writes `*`, `1+*` and `∞`, and there is a real `*/*`
    /// Elemental in the corpus.
    pub power: Option<String>,
    pub toughness: Option<String>,
    /// Concatenated letters — `""`, `"W"`, `"BGRUW"` — the way `cards.colors` is stored and the
    /// way `DeckCard.colors` already reaches the page. **Never a JSON array**: the column is
    /// built by `card_row`'s `joined_letters` precisely so a `colors LIKE '%R%'` can work, and a
    /// second shape on the wire would be a second thing for the page to know.
    pub colors: Option<String>,
    pub oracle_text: Option<String>,
    /// The printing the resolver names, deterministically. Never blank for a derived row.
    pub default_card_id: String,
    /// The deck cards that make it. Empty for a `manual` row nothing derives.
    pub sources: Vec<TokenSource>,
    pub derived: bool,
    /// The stored override, joined on. All three are `None` when there is no row.
    pub card_id: Option<String>,
    pub quantity: Option<i64>,
    pub state: Option<String>,
    /// Where the picture of the printing this row **effectively draws** is, per variant —
    /// **the web target's and the phone's only way to draw one**, and the reason this field is
    /// on a struct that is otherwise all facts about a token rather than about an image.
    ///
    /// `mtgimg://` is a Tauri custom protocol, so a browser has none to ask and `cardArtSrc`
    /// falls through to whatever URL the row carried: without this every tile on the wall
    /// draws the no-art frame there while the desktop draws art, which is the failure four
    /// other surfaces shipped with on 2026-08-31.
    ///
    /// **`card_id` first and `default_card_id` after, which is TypeScript's `printingId` and
    /// deliberately not the printing the resolver named.** Those two are the *same* row for
    /// every token nobody has picked art for and different for exactly the ones somebody has —
    /// so taking the resolver's would draw the deck's default Treasure on a tile the reader
    /// chose the other Treasure for, on the web and on the phone only, which is a wrong
    /// picture rather than a missing one. [`picture_for`] is where that precedence lives.
    ///
    /// Built by [`crate::image_uri::front_face_map`] rather than read off `image_uris`
    /// directly, because a `double_faced_token` carries **no** top-level blob — all 120 such
    /// rows in the corpus keep their URLs on `card_faces[0]` alone — and face-first precedence
    /// is that module's rule rather than one respelled here.
    pub image_uris: Option<BTreeMap<String, String>>,
}

/// One `cards` row as this module needs it: the display fields, plus the three the tie-break
/// orders by and the `oracle_id` that is the grain.
#[derive(Debug, Clone)]
struct Printing {
    id: String,
    oracle_id: String,
    name: String,
    type_line: Option<String>,
    layout: String,
    power: Option<String>,
    toughness: Option<String>,
    colors: Option<String>,
    oracle_text: Option<String>,
    released_at: Option<String>,
    set_code: String,
    collector_number: String,
    /// The front face's picture per variant, folded up by
    /// [`crate::image_uri::front_face_map`]. Read here rather than at [`row_of`] so that the
    /// derived row and the hand-added one cannot resolve it two ways.
    image_uris: Option<BTreeMap<String, String>>,
}

/// The columns [`Printing`] reads, in its own order.
///
/// **Every display column the wire shape needs, not just the layout the filter reads.** The row is
/// fetched once to answer the `emblem` half of the keep rule and once more would be a second query
/// per `all_parts` entry for fields that arrived with the first.
///
/// **A `LazyLock<String>` rather than a `const`, for [`crate::deck`]'s `DECK_SELECT` reason**: the
/// picture columns come from [`crate::image_uri::front_face_selects`], and how many there are is
/// [`crate::image_uri::LIST_VARIANTS`]' answer rather than anything spellable in a `const`. The
/// `format!` is spent once per process.
///
/// **The image expressions are last and every named column stands in front of them**, which is
/// [`crate::deck`]'s `deck_row` rule and holds here for the same reason: [`printing_from`] reads by
/// position, so a column added anywhere but the end shifts every later index into a field of the
/// same SQLite type, silently. Both queries below are a bare `FROM cards`, so `cards` is the alias
/// the expressions qualify with.
static PRINTING_COLUMNS: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    format!(
        "id, oracle_id, name, type_line, layout, power, toughness, colors,
     oracle_text, released_at, set_code, collector_number, {images}",
        images = crate::image_uri::front_face_selects("cards").join(", ")
    )
});

/// A [`Printing`], or `None` when the row carries no `oracle_id` and so cannot be grained.
///
/// The column is NULLABLE and **0 of 3 245 token, emblem and double-faced-token rows are missing
/// one** (debug corpus, 2026-09-07) — so this is a fence around a case that does not currently
/// occur, written the way [`crate::card::list_printings`] fences the blank.
fn printing_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<Option<Printing>> {
    /// Where [`PRINTING_COLUMNS`]' image expressions start - one past `collector_number`, the
    /// last named column. Named rather than inlined for `deck::deck_row`'s reason: the pairing
    /// arithmetic below is [`crate::image_uri::front_face_map`]'s and only the *offset* is this
    /// function's. It moves with every column added to the named list.
    const IMAGE_COL: usize = 12;

    let oracle_id: Option<String> = r.get(1)?;
    let Some(oracle_id) = oracle_id.filter(|o| !o.trim().is_empty()) else {
        return Ok(None);
    };
    Ok(Some(Printing {
        id: r.get(0)?,
        oracle_id,
        name: r.get(2)?,
        type_line: r.get(3)?,
        layout: r.get(4)?,
        power: r.get(5)?,
        toughness: r.get(6)?,
        colors: r.get(7)?,
        oracle_text: r.get(8)?,
        released_at: r.get(9)?,
        set_code: r.get(10)?,
        collector_number: r.get(11)?,
        // **From 12**, one past `collector_number`, the last named column — the
        // `crate::image_uri::FRONT_FACE_COLUMNS` expressions `front_face_selects` appended, in
        // the (top-level, face) pairs `front_face_map` folds back up.
        //
        // This read carries the failure `deck::deck_row` records and the eleven above it do
        // not: each of those is caught by a value of the wrong *kind* turning up in a field,
        // while here the pair is (top-level, face) and `for_face` prefers the face, so a read
        // one column out still answers a perfectly real URL - the right picture from the wrong
        // slot, or the crop where the card belongs.
        image_uris: crate::image_uri::front_face_map(|i| {
            r.get::<_, Option<String>>(IMAGE_COL + i)
        })?,
    }))
}

/// `released_at DESC, set_code ASC, collector_number ASC, id ASC` — the tail
/// [`crate::card::list_printings`] already orders by, so the art this names is the art at the top
/// of the picker the reader opens next.
///
/// **Deterministic, or the same deck draws different art on two opens.** `Option<String>` orders
/// `None` below every `Some`, so reversing it puts a printing with no release date last, which is
/// what SQLite's `released_at DESC` does with a NULL.
fn tie_break(a: &Printing, b: &Printing) -> std::cmp::Ordering {
    b.released_at
        .cmp(&a.released_at)
        .then_with(|| a.set_code.cmp(&b.set_code))
        .then_with(|| a.collector_number.cmp(&b.collector_number))
        .then_with(|| a.id.cmp(&b.id))
}

/// What one token `oracle_id` has accumulated across the deck's cards.
#[derive(Default)]
struct Group {
    /// Every printing of it the deck's cards named, and how many named that one.
    referenced: HashMap<String, (Printing, i64)>,
    sources: Vec<TokenSource>,
    /// The deck cards already in [`Self::sources`] — a card naming one token twice is one source.
    counted: HashSet<String>,
}

/// The stored override for one token: `(card_id, quantity, state)`.
type Override = (Option<String>, Option<i64>, String);

/// Every token and emblem one variant of one deck needs, with the reader's overrides joined on.
///
/// **Every way this can fail is `Ok(vec![])`, never an `Err`** — an unknown deck, an unknown
/// printing, a `raw` that will not inflate or will not parse, a missing `all_parts`, an
/// `all_parts` that is not an array. [`crate::card::meld_parts`] argues this at `card.rs:626` for
/// a control most cards do not have; here it is a whole area most decks use lightly, and a deck
/// that would not open over it is a worse answer than a wall that is empty.
///
/// Five things about the walk, and the fourth — which is a rule that is deliberately *absent* —
/// is the one to read twice:
///
/// 1. **Active categories only.** `deck_categories.is_active = 0` means *counts toward nothing*,
///    which is the whole of what the old `maybe` zone meant — so the Maybeboard makes no tokens.
///    The Sideboard and the Companion are active and do contribute, which is right: you sleeve
///    those.
/// 2. **`CAST(raw AS BLOB)` is required.** rusqlite will not hand a TEXT-declared value out as
///    `Vec<u8>`, and `json_extract` over a gzip member is a hard `malformed JSON` error rather
///    than a NULL — so this can never be done in SQL at all.
/// 3. **Keep on the union**, [`TOKEN_COMPONENTS`] or [`EXTRA_LAYOUTS`], the second tested against
///    the row the entry *resolves to*. An entry that resolves to no local row is dropped rather
///    than rendered as a hole: that is 3 or 4 printings in the whole corpus, and a token nobody
///    can draw or pick art for is not a row worth having.
/// 4. **There is no self-exclusion rule, because the keep rule already is one** — and this is
///    where the module parts company with [`crate::card::meld_parts`], which *must* exclude by
///    name at `card.rs:635`. There, the same-named entry **is the same card**: a meld result
///    naming Brisela while the reader is looking at Brisela. Here it is a token **of** that
///    card, which is a different oracle card that happens to wear the card's name.
///
///    A card's own printing arrives as `component: "combo_piece"` resolving to a row with the
///    card's own layout — `normal`, never `token` or `emblem` — so it fails the union in step 3
///    without anything else being asked. Measured over the 108 372 rows a deck can hold
///    (`legal_mask != 0`, non-token layouts) on the debug corpus, 2026-09-07: **154 same-name
///    entries pass the keep rule, all 154 resolve to `layout = 'token'`, and 0 of them share the
///    producing row's `id` or its `oracle_id`.** Not one is the card itself.
///
///    What all 154 are is Embalm and Eternalize — `Timeless Dragon`, `Sacred Cat`,
///    `Adorned Pouncer`, `Champion of Wits`, `Temmet, Vizier of Naktamun` and 50 more names —
///    where the token *is* a copy of the card and wears its name by rule. A name test subtracts
///    exactly those 55 cards' tokens and subtracts nothing else, which is why it is not here.
///
///    The only rows that do name themselves through this rule are tokens and emblems naming
///    their own printing (2 929 corpus-wide, every one of them a `token`, `emblem`,
///    `double_faced_token`, `flip` or `reversible_card` row, all `legal_mask = 0`). A deck that
///    somehow lists a Spirit token and shows a Spirit on its token wall is right rather than
///    wrong, so they need no fence either.
/// 5. **Group by `oracle_id`, never by name.** `Wurmcoil Engine` makes two tokens both called
///    `Wurm` under different oracle ids, and 104 token/emblem names are shared by more than one.
///
/// Order is `(name, oracle_id)`, derived rows first and hand-added ones after. Which order the
/// wall is actually in is TypeScript's — emblems last, then by name — and **its sort is stable**,
/// so an unordered answer here would make two `Wurm` tiles swap places between opens.
pub fn deck_token_rows(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
) -> Result<Vec<DeckTokenRow>, String> {
    let makers = deck_printings(conn, deck_id, variant)?;
    let overrides = stored_overrides(conn, deck_id)?;

    let mut printings = conn
        .prepare(&format!(
            "SELECT {columns} FROM cards WHERE id = ?1",
            columns = *PRINTING_COLUMNS
        ))
        .map_err(|e| e.to_string())?;
    let mut blobs = conn
        .prepare("SELECT name, CAST(raw AS BLOB) FROM cards WHERE id = ?1")
        .map_err(|e| e.to_string())?;

    // One lookup per distinct referenced printing, however many of the deck's cards name it.
    let mut cache: HashMap<String, Option<Printing>> = HashMap::new();
    let mut groups: HashMap<String, Group> = HashMap::new();

    for maker in &makers {
        let row: Option<(String, Option<Vec<u8>>)> = blobs
            .query_row(params![maker], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(|e| e.to_string())?;
        // A deck card whose printing has left the corpus is flagged elsewhere and makes nothing
        // here: there is no blob to read.
        let Some((own_name, stored)) = row else {
            continue;
        };
        let Some(json) = stored.as_deref().and_then(crate::card_row::raw_json) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) else {
            continue;
        };
        let Some(parts) = value.get("all_parts").and_then(serde_json::Value::as_array) else {
            continue;
        };

        for part in parts {
            // **The entry's own `name` is deliberately not read.** It is the one field on an
            // `all_parts` entry this module has no use for: the id is what resolves, and every
            // display field — the name included — comes off the row that resolves, which is
            // authoritative where the entry is a copy. `meld_parts` needs the entry's name
            // because it excludes self by it; step 4 above is why nothing here does.
            let (Some(part_id), Some(component)) =
                (str_field(part, "id"), str_field(part, "component"))
            else {
                continue;
            };
            let target = match cache.entry(part_id) {
                std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
                std::collections::hash_map::Entry::Vacant(e) => {
                    let found = printings
                        .query_row(params![e.key()], printing_from)
                        .optional()
                        .map_err(|err| err.to_string())?
                        .flatten();
                    e.insert(found)
                }
            };
            let Some(target) = target else {
                continue;
            };
            if !TOKEN_COMPONENTS.contains(&component.as_str())
                && !EXTRA_LAYOUTS.contains(&target.layout.as_str())
            {
                continue;
            }
            let group = groups.entry(target.oracle_id.clone()).or_default();
            group
                .referenced
                .entry(target.id.clone())
                .or_insert_with(|| (target.clone(), 0))
                .1 += 1;
            if group.counted.insert(maker.clone()) {
                group.sources.push(TokenSource {
                    card_id: maker.clone(),
                    name: own_name.clone(),
                });
            }
        }
    }

    let mut out: Vec<DeckTokenRow> = Vec::with_capacity(groups.len());
    for (oracle_id, group) in groups {
        // Most-referenced first, ties broken by the printings tail. `sort_by` rather than
        // `max_by`, because `max_by` answers the *last* of an equal run and the tie-break has to
        // be what chooses — across 40 Treasure makers, 12 distinct Treasure printings were
        // referenced, so two makers pointing at two printings is the common case rather than a
        // corner one.
        let mut referenced: Vec<(Printing, i64)> = group.referenced.into_values().collect();
        referenced.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| tie_break(&a.0, &b.0)));
        let best = &referenced[0].0;
        let mut sources = group.sources;
        sources.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.card_id.cmp(&b.card_id)));
        let stored = overrides.get(&oracle_id);
        let picture = picture_for(conn, best, stored)?;
        out.push(row_of(best, picture, sources, true, stored));
    }
    out.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| a.oracle_id.cmp(&b.oracle_id))
    });

    // The hand-added tail: a `manual` row the deck derives nothing for is on the wall because the
    // reader said so. Resolved by `oracle_id` rather than by the stored `card_id`, so a row whose
    // chosen printing has left the corpus still draws — `default_card_id` is what the page falls
    // back to, and it must be answerable without it.
    let mut added: Vec<DeckTokenRow> = Vec::new();
    let derived: HashSet<&str> = out.iter().map(|r| r.oracle_id.as_str()).collect();
    for (oracle_id, stored) in &overrides {
        if stored.2 != MANUAL_STATE || derived.contains(oracle_id.as_str()) {
            continue;
        }
        if let Some(printing) = newest_printing(conn, oracle_id)? {
            let picture = picture_for(conn, &printing, Some(stored))?;
            added.push(row_of(&printing, picture, Vec::new(), false, Some(stored)));
        }
    }
    added.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| a.oracle_id.cmp(&b.oracle_id))
    });
    out.append(&mut added);
    Ok(out)
}

/// A string field, if present and actually a string — [`crate::card`]'s helper, one file over.
fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_owned)
}

/// One wire row, built from the printing the resolver named and whatever the reader stored.
///
/// `picture` is [`picture_for`]'s answer and is passed in rather than taken off `printing`,
/// because the two disagree for exactly the rows the reader has picked art for — see
/// [`DeckTokenRow::image_uris`].
fn row_of(
    printing: &Printing,
    picture: Option<BTreeMap<String, String>>,
    sources: Vec<TokenSource>,
    derived: bool,
    stored: Option<&Override>,
) -> DeckTokenRow {
    DeckTokenRow {
        oracle_id: printing.oracle_id.clone(),
        name: printing.name.clone(),
        type_line: printing.type_line.clone(),
        layout: printing.layout.clone(),
        power: printing.power.clone(),
        toughness: printing.toughness.clone(),
        colors: printing.colors.clone(),
        oracle_text: printing.oracle_text.clone(),
        default_card_id: printing.id.clone(),
        sources,
        derived,
        card_id: stored.and_then(|s| s.0.clone()),
        quantity: stored.and_then(|s| s.1),
        state: stored.map(|s| s.2.clone()),
        image_uris: picture,
    }
}

/// The picture the tile will actually draw: the reader's pick where there is one, the printing
/// the resolver named otherwise.
///
/// **The order is `card_id` then `default_card_id`, which is `deckTokens.ts`' `printingId`**, and
/// getting it the other way round is a *wrong* picture rather than a missing one — the deck's
/// default Treasure drawn on the tile the reader chose the other Treasure for, on the web and on
/// the phone alone, where no `mtgimg://` corrects it.
///
/// The extra read is skipped whenever the two name the same row, which is every token nobody has
/// deviated on. **A pick that has left the corpus answers `None` rather than falling back to the
/// resolver's picture**: the tile is addressing that printing, so art from a different one would
/// be this function inventing a card.
fn picture_for(
    conn: &Connection,
    printing: &Printing,
    stored: Option<&Override>,
) -> Result<Option<BTreeMap<String, String>>, String> {
    match stored
        .and_then(|s| s.0.as_deref())
        .filter(|picked| *picked != printing.id)
    {
        Some(picked) => printing_picture(conn, picked),
        None => Ok(printing.image_uris.clone()),
    }
}

/// One printing's front-face picture and nothing else — the four image expressions on their own,
/// so a pick costs the columns it needs rather than a second whole [`Printing`].
fn printing_picture(
    conn: &Connection,
    card_id: &str,
) -> Result<Option<BTreeMap<String, String>>, String> {
    conn.query_row(
        &format!(
            "SELECT {images} FROM cards WHERE id = ?1",
            images = crate::image_uri::front_face_selects("cards").join(", ")
        ),
        params![card_id],
        |r| crate::image_uri::front_face_map(|i| r.get::<_, Option<String>>(i)),
    )
    .optional()
    .map(Option::flatten)
    .map_err(|e| e.to_string())
}

/// The distinct printings one variant of a deck plays, out of its **active** categories.
fn deck_printings(conn: &Connection, deck_id: i64, variant: &str) -> Result<Vec<String>, String> {
    conn.prepare(
        "SELECT DISTINCT dc.card_id
           FROM deck_cards dc
           JOIN deck_categories cat ON cat.id = dc.category_id
          WHERE dc.deck_id = ?1 AND dc.variant = ?2 AND cat.is_active = 1
          ORDER BY dc.card_id",
    )
    .and_then(|mut stmt| {
        stmt.query_map(params![deck_id, variant], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()
    })
    .map_err(|e| e.to_string())
}

/// Every stored override for one deck, keyed on the grain's second term.
fn stored_overrides(conn: &Connection, deck_id: i64) -> Result<HashMap<String, Override>, String> {
    conn.prepare("SELECT oracle_id, card_id, quantity, state FROM deck_tokens WHERE deck_id = ?1")
        .and_then(|mut stmt| {
            stmt.query_map(params![deck_id], |r| {
                Ok((r.get(0)?, (r.get(1)?, r.get(2)?, r.get(3)?)))
            })?
            .collect::<rusqlite::Result<HashMap<String, Override>>>()
        })
        .map_err(|e| e.to_string())
}

/// The printing of one oracle card the tie-break names first — [`tie_break`] as SQL, so a hand
/// row and a derived one cannot disagree about which art is the default.
fn newest_printing(conn: &Connection, oracle_id: &str) -> Result<Option<Printing>, String> {
    conn.query_row(
        &format!(
            "SELECT {columns} FROM cards WHERE oracle_id = ?1
              ORDER BY released_at DESC, set_code ASC, collector_number ASC, id ASC
              LIMIT 1",
            columns = *PRINTING_COLUMNS
        ),
        params![oracle_id],
        printing_from,
    )
    .optional()
    .map(Option::flatten)
    .map_err(|e| e.to_string())
}

/// Write one token's override, or **delete** it when the result would carry nothing.
///
/// A full replace and not a patch: the page composes the whole override out of the row it is
/// looking at and sends all three fields, `null` included, so an absent `token_state` means
/// [`AUTO_STATE`] rather than *leave it alone*.
///
/// **`state = 'auto'` with no printing and no quantity is not representable.** Such a row carries
/// no information, so this deletes instead of writing it — which keeps *the reader has not
/// deviated* one state rather than two that have to be kept in agreement. A quantity of **zero**
/// is not that case: it is a token the reader deliberately zeroed, and the row goes on carrying
/// the art they picked.
pub fn set_token_override(
    conn: &Connection,
    deck_id: i64,
    oracle_id: &str,
    card_id: Option<&str>,
    quantity: Option<i64>,
    token_state: Option<&str>,
) -> Result<(), String> {
    let state = token_state.unwrap_or(AUTO_STATE);
    if !TOKEN_STATES.contains(&state) {
        return Err(BAD_STATE.to_owned());
    }
    if state == AUTO_STATE && card_id.is_none() && quantity.is_none() {
        return clear_token_override(conn, deck_id, oracle_id);
    }
    // **`deck_tokens.deck_id` has an enforced foreign key and `PRAGMA foreign_keys` is
    // per-connection**, so a deck deleted in another window is `FOREIGN KEY constraint failed` on
    // the app's connections and a silent orphan on one without the pragma. A sentence in Rust
    // answers both, which is `deck::set_folder`'s rule about where a refusal belongs.
    let deck_exists: Option<i64> = conn
        .query_row("SELECT 1 FROM decks WHERE id = ?1", params![deck_id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    if deck_exists.is_none() {
        return Err(crate::deck::GONE.to_owned());
    }
    // **`DECK_TOKEN_GRAIN` interpolated and never retyped**: an `ON CONFLICT` target that does not
    // match `idx_deck_tokens_grain` verbatim is a runtime error at the first write, not a compile
    // error, so the index and this statement read one constant.
    conn.execute(
        &format!(
            "INSERT INTO deck_tokens
                 (deck_id, oracle_id, card_id, quantity, state, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, unixepoch(), unixepoch())
             ON CONFLICT ({DECK_TOKEN_GRAIN}) DO UPDATE SET
                 card_id = excluded.card_id,
                 quantity = excluded.quantity,
                 state = excluded.state,
                 updated_at = unixepoch()"
        ),
        params![deck_id, oracle_id, card_id, quantity, state],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Back to the derived defaults: the override row goes.
///
/// A grain that resolves to no row is a **success** — the caller wanted no override and there is
/// none. Not folded into [`set_token_override`]'s empty-row arm from the other direction: the two
/// spellings are the same write and this one says what the reader pressed.
pub fn clear_token_override(
    conn: &Connection,
    deck_id: i64,
    oracle_id: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM deck_tokens WHERE deck_id = ?1 AND oracle_id = ?2",
        params![deck_id, oracle_id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Put a token on the wall by hand — the one write that names a **printing** rather than the
/// grain.
///
/// The reader picks out of a printings grid, so a printing is what there is to send; the
/// `oracle_id` is resolved from it here and the printing is kept as the art. A `manual` row is
/// drawn whether or not the deck derives it.
///
/// **An existing quantity survives.** Adding is *put this on the wall with this art*, and a reader
/// who had set four Treasures, dismissed them and then added them back would otherwise find the
/// four silently gone — the one thing about the row this press has no opinion on.
pub fn add_token(conn: &Connection, deck_id: i64, card_id: &str) -> Result<(), String> {
    let oracle_id: Option<Option<String>> = conn
        .query_row(
            "SELECT oracle_id FROM cards WHERE id = ?1",
            params![card_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(oracle_id) = oracle_id.flatten().filter(|o| !o.trim().is_empty()) else {
        return Err(NO_SUCH_PRINTING.to_owned());
    };
    let quantity: Option<i64> = conn
        .query_row(
            "SELECT quantity FROM deck_tokens WHERE deck_id = ?1 AND oracle_id = ?2",
            params![deck_id, oracle_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    set_token_override(
        conn,
        deck_id,
        &oracle_id,
        Some(card_id),
        quantity,
        Some(MANUAL_STATE),
    )
}

// ---------------------------------------------------------------------------------------
// The four commands
// ---------------------------------------------------------------------------------------

/// [`deck_token_rows`]' command. Read-only connection on the blocking pool, as
/// [`crate::card::card_meld_parts`] is and for the same reason.
///
/// Takes no `marketplace`: nothing in the answer is priced. The art picker the reader opens next
/// is `card_printings`, which already answers on a token — its predicate is
/// `oracle_id = ?1 AND is_paper = 1` and every token row satisfies both — so this feature adds no
/// second read command.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_tokens(
    state: tauri::State<'_, std::sync::Arc<crate::sync::AppState>>,
    deck_id: i64,
    variant: String,
) -> Result<Vec<DeckTokenRow>, String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        deck_token_rows(&crate::sync::lock_db_read(&app), deck_id, &variant)
    })
    .await
    .map_err(|e| format!("this deck's tokens could not be read: {e}"))?
}

/// [`set_token_override`]'s command.
///
/// **The parameter is `token_state` and the wire key is `tokenState`**, because `state` is already
/// the managed [`crate::sync::AppState`] every command takes. `src/lib/ipc.ts` is the one place
/// on the other side that knows the rename; callers there pass `{ state }`, which is what the
/// column is called.
///
/// Plain [`crate::sync::with_write`] and **not** `with_write_owned`: that one is for the four
/// commands that move copies across the collection/deck boundary, and nothing here changes what
/// the reader owns.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_token_set(
    state: tauri::State<'_, std::sync::Arc<crate::sync::AppState>>,
    deck_id: i64,
    oracle_id: String,
    card_id: Option<String>,
    quantity: Option<i64>,
    token_state: Option<String>,
) -> Result<(), String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&app, |c| {
            set_token_override(
                c,
                deck_id,
                &oracle_id,
                card_id.as_deref(),
                quantity,
                token_state.as_deref(),
            )
        })
    })
    .await
    .map_err(|e| format!("that token could not be saved: {e}"))?
}

/// [`clear_token_override`]'s command.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_token_clear(
    state: tauri::State<'_, std::sync::Arc<crate::sync::AppState>>,
    deck_id: i64,
    oracle_id: String,
) -> Result<(), String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&app, |c| clear_token_override(c, deck_id, &oracle_id))
    })
    .await
    .map_err(|e| format!("that token could not be reset: {e}"))?
}

/// [`add_token`]'s command.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_token_add(
    state: tauri::State<'_, std::sync::Arc<crate::sync::AppState>>,
    deck_id: i64,
    card_id: String,
) -> Result<(), String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&app, |c| add_token(c, deck_id, &card_id))
    })
    .await
    .map_err(|e| format!("that token could not be added: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_uri::IMAGE_HOST;
    use rusqlite::{params, Connection};
    use serde_json::json;

    /// One `cards` row, written by hand.
    ///
    /// **Every fixture below lives in a `:memory:` pair that is dropped when the test returns**,
    /// which is the strongest available form of "delete the rows afterwards": nothing here can
    /// reach `data/user.db` or `data/corpus.db`, so no hand-written `cards` row can make a later
    /// measurement a fiction.
    #[derive(Clone)]
    struct Card<'a> {
        id: &'a str,
        oracle_id: &'a str,
        name: &'a str,
        type_line: &'a str,
        layout: &'a str,
        power: Option<&'a str>,
        toughness: Option<&'a str>,
        /// Concatenated letters, the way `card_row` stores them: `"W"`, `"BGRUW"`, `""`.
        colors: &'a str,
        oracle_text: &'a str,
        set_code: &'a str,
        collector_number: &'a str,
        released_at: &'a str,
        /// `all_parts` entries as `(id, component, name)`.
        parts: &'a [(&'a str, &'a str, &'a str)],
    }

    impl Default for Card<'_> {
        fn default() -> Self {
            Card {
                id: "c-1",
                oracle_id: "o-1",
                name: "A Card",
                type_line: "Creature — Human",
                layout: "normal",
                power: None,
                toughness: None,
                colors: "",
                oracle_text: "",
                set_code: "tst",
                collector_number: "1",
                released_at: "2020-01-01",
                parts: &[],
            }
        }
    }

    impl Card<'_> {
        /// The `raw` blob this card would have been ingested as — gzip, as schema v3 on stores
        /// it, so the fixture exercises [`crate::card_row::raw_json`]'s real path rather than
        /// the plain-text one only a pre-sync database has.
        fn raw(&self) -> Vec<u8> {
            let parts: Vec<_> = self
                .parts
                .iter()
                .map(|(id, component, name)| {
                    json!({
                        "object": "related_card",
                        "id": id,
                        "component": component,
                        "name": name,
                        "uri": format!("https://api.scryfall.com/cards/{id}"),
                    })
                })
                .collect();
            let mut body = json!({ "id": self.id, "name": self.name });
            if !self.parts.is_empty() {
                body["all_parts"] = json!(parts);
            }
            crate::card_row::gzip_raw(&body.to_string())
        }

        fn insert(&self, conn: &Connection) {
            self.insert_raw(conn, &self.raw());
        }

        /// The same row with a `raw` of the caller's choosing — the four failure shapes.
        fn insert_raw(&self, conn: &Connection, raw: &[u8]) {
            conn.execute(
                "INSERT INTO cards
                     (id, oracle_id, name, type_line, layout, power, toughness, colors,
                      oracle_text, set_code, collector_number, lang, released_at, raw)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'en',?12,?13)",
                params![
                    self.id,
                    self.oracle_id,
                    self.name,
                    self.type_line,
                    self.layout,
                    self.power,
                    self.toughness,
                    self.colors,
                    self.oracle_text,
                    self.set_code,
                    self.collector_number,
                    self.released_at,
                    raw,
                ],
            )
            .unwrap();
        }
    }

    // ── The four measured shapes, verbatim off the debug corpus on 2026-09-07 ──────────
    //
    // Ids, components, names, layouts, power/toughness, colors and oracle text are the real
    // ones. A fixture that invented them would be a test about a shape Scryfall does not
    // publish, which is exactly the failure the union rule exists for.

    /// `Smothering Tithe` — the plain case, and the one that shows the self-entry carrying a
    /// **different printing's id** (`da65d83c-…` against the row's own `2309fb66-…`).
    fn tithe() -> Card<'static> {
        Card {
            id: "2309fb66-3aa0-4ec5-9a8e-5a0caa19c270",
            oracle_id: "153376c9-dffd-458c-8ce3-a4c8269bc4e9",
            name: "Smothering Tithe",
            type_line: "Enchantment",
            colors: "W",
            set_code: "cmm",
            collector_number: "693",
            released_at: "2023-08-04",
            parts: &[
                (
                    "da65d83c-67bd-4d54-9c9a-50d57ca115bb",
                    "combo_piece",
                    "Smothering Tithe",
                ),
                ("cb7b5024-3a0b-4f14-977e-ba6c4c2567c9", "token", "Treasure"),
            ],
            ..Card::default()
        }
    }

    /// The Treasure `Smothering Tithe` names.
    fn treasure() -> Card<'static> {
        Card {
            id: "cb7b5024-3a0b-4f14-977e-ba6c4c2567c9",
            oracle_id: "3c549374-6c37-42e0-8d88-a8555d46732d",
            name: "Treasure",
            type_line: "Token Artifact — Treasure",
            layout: "token",
            colors: "",
            oracle_text: "{T}, Sacrifice this token: Add one mana of any color.",
            set_code: "tcmm",
            collector_number: "48",
            released_at: "2023-08-04",
            ..Card::default()
        }
    }

    /// `Elspeth, Sun's Champion` — the emblem arrives as a `combo_piece`, which is the whole
    /// reason the keep rule is a union.
    fn elspeth() -> Card<'static> {
        Card {
            id: "047f2cc9-3073-41f5-81c3-7b6b28b374d0",
            oracle_id: "05e6b243-48a6-4a42-bc5f-413441de9c33",
            name: "Elspeth, Sun's Champion",
            type_line: "Legendary Planeswalker — Elspeth",
            colors: "W",
            set_code: "moc",
            collector_number: "182",
            released_at: "2023-04-21",
            parts: &[
                (
                    "047f2cc9-3073-41f5-81c3-7b6b28b374d0",
                    "combo_piece",
                    "Elspeth, Sun's Champion",
                ),
                (
                    "610ed7d6-362b-434a-8cdc-b16bfe20eaa0",
                    "combo_piece",
                    "Elspeth, Sun's Champion Emblem",
                ),
                ("d0cc09a9-a21b-40ee-8b68-bc084f71737d", "token", "Soldier"),
            ],
            ..Card::default()
        }
    }

    fn elspeth_emblem() -> Card<'static> {
        Card {
            id: "610ed7d6-362b-434a-8cdc-b16bfe20eaa0",
            oracle_id: "2f12324a-e14e-4776-bc51-9fd42aaf3222",
            name: "Elspeth, Sun's Champion Emblem",
            type_line: "Emblem — Elspeth",
            layout: "emblem",
            colors: "",
            oracle_text: "Creatures you control get +2/+2 and have flying.",
            set_code: "tmoc",
            collector_number: "43",
            released_at: "2023-04-21",
            ..Card::default()
        }
    }

    fn soldier() -> Card<'static> {
        Card {
            id: "d0cc09a9-a21b-40ee-8b68-bc084f71737d",
            oracle_id: "eac25f12-6459-438c-a09e-93e23d2cf80d",
            name: "Soldier",
            type_line: "Token Creature — Soldier",
            layout: "token",
            power: Some("1"),
            toughness: Some("1"),
            colors: "W",
            set_code: "tmoc",
            collector_number: "8",
            released_at: "2023-04-21",
            ..Card::default()
        }
    }

    /// `Timeless Dragon` — Eternalize, so the token it makes **carries its own name** under a
    /// different printing id. This is the shape the `name`-vs-`id` self-test turns on.
    fn timeless_dragon() -> Card<'static> {
        Card {
            id: "044902aa-29a1-4627-a4fc-0beccd2a10b3",
            oracle_id: "a5ae93e9-0385-47fd-9d8f-306e9a6b7fe6",
            name: "Timeless Dragon",
            type_line: "Creature — Dragon",
            power: Some("5"),
            toughness: Some("5"),
            colors: "W",
            set_code: "khm",
            collector_number: "20",
            released_at: "2021-02-05",
            parts: &[
                (
                    "f7ab74f3-897a-4dd9-b460-f31a0f496bb4",
                    "token",
                    "Timeless Dragon",
                ),
                (
                    "044902aa-29a1-4627-a4fc-0beccd2a10b3",
                    "combo_piece",
                    "Timeless Dragon",
                ),
            ],
            ..Card::default()
        }
    }

    fn timeless_dragon_token() -> Card<'static> {
        Card {
            id: "f7ab74f3-897a-4dd9-b460-f31a0f496bb4",
            oracle_id: "849cba98-136f-43d6-a8f7-c71219821ef3",
            name: "Timeless Dragon",
            type_line: "Token Creature — Zombie Dragon",
            layout: "token",
            power: Some("4"),
            toughness: Some("4"),
            colors: "B",
            oracle_text: "Flying",
            set_code: "tkhm",
            collector_number: "5",
            released_at: "2021-02-05",
            ..Card::default()
        }
    }

    /// The **other** printing of `Smothering Tithe` — the one its own `all_parts` self-entry
    /// points at. Same `oracle_id`, different `id`, and it has to exist in `cards` or a test
    /// about the keep rule would really be a test about an unresolvable id.
    fn tithe_other_printing() -> Card<'static> {
        Card {
            id: "da65d83c-67bd-4d54-9c9a-50d57ca115bb",
            set_code: "clb",
            collector_number: "297",
            released_at: "2022-06-10",
            ..tithe()
        }
    }

    /// `Krenko, Mob Boss` — the self-entry that points at the row's **own** id, so the two
    /// shapes of self-reference are both covered.
    fn krenko() -> Card<'static> {
        Card {
            id: "0b9c68ff-1fe4-42ef-8d1f-43120de5c1ff",
            oracle_id: "68418069-f615-40ef-ae0d-764192acae00",
            name: "Krenko, Mob Boss",
            type_line: "Legendary Creature — Goblin Warrior",
            power: Some("3"),
            toughness: Some("3"),
            colors: "R",
            set_code: "j22",
            collector_number: "564",
            released_at: "2022-12-02",
            parts: &[
                ("09faad62-42ff-4e37-b8a5-d8e8a0f6d096", "token", "Goblin"),
                (
                    "0b9c68ff-1fe4-42ef-8d1f-43120de5c1ff",
                    "combo_piece",
                    "Krenko, Mob Boss",
                ),
            ],
            ..Card::default()
        }
    }

    fn goblin() -> Card<'static> {
        Card {
            id: "09faad62-42ff-4e37-b8a5-d8e8a0f6d096",
            oracle_id: "4465eff4-5851-4721-a248-866c686c2ab8",
            name: "Goblin",
            type_line: "Token Creature — Goblin",
            layout: "token",
            power: Some("1"),
            toughness: Some("1"),
            colors: "R",
            set_code: "sld",
            collector_number: "2421",
            released_at: "2026-05-18",
            ..Card::default()
        }
    }

    /// `Wurmcoil Engine` — two `token` entries, both named `Wurm`, under different oracle ids.
    fn wurmcoil() -> Card<'static> {
        Card {
            id: "219f1f03-e882-40ca-8854-1e466e37b8cd",
            oracle_id: "d1a60f44-7696-49ee-91fb-cab5b3102962",
            name: "Wurmcoil Engine",
            type_line: "Artifact Creature — Phyrexian Wurm",
            power: Some("6"),
            toughness: Some("6"),
            colors: "",
            set_code: "brr",
            collector_number: "63",
            released_at: "2022-11-18",
            parts: &[
                ("a6ee0db9-ac89-4ab6-ac2e-8a7527d9ecbd", "token", "Wurm"),
                ("b68e816f-f9ac-435b-ad0b-ceedbe72447a", "token", "Wurm"),
                (
                    "dcdbecfc-fc37-4327-9469-7139e16f7fbd",
                    "combo_piece",
                    "Wurmcoil Engine",
                ),
            ],
            ..Card::default()
        }
    }

    fn wurm_lifelink() -> Card<'static> {
        Card {
            id: "a6ee0db9-ac89-4ab6-ac2e-8a7527d9ecbd",
            oracle_id: "1b9ccdd7-4935-45e2-bb16-b09870dd965d",
            name: "Wurm",
            type_line: "Token Artifact Creature — Wurm",
            layout: "token",
            power: Some("3"),
            toughness: Some("3"),
            colors: "",
            oracle_text: "Lifelink",
            set_code: "t2xm",
            collector_number: "30",
            released_at: "2020-08-07",
            ..Card::default()
        }
    }

    fn wurm_deathtouch() -> Card<'static> {
        Card {
            id: "b68e816f-f9ac-435b-ad0b-ceedbe72447a",
            oracle_id: "5e3f41f7-9b42-437a-a9f9-f09250b083db",
            name: "Wurm",
            type_line: "Token Artifact Creature — Wurm",
            layout: "token",
            power: Some("3"),
            toughness: Some("3"),
            colors: "",
            oracle_text: "Deathtouch",
            set_code: "t2xm",
            collector_number: "29",
            released_at: "2020-08-07",
            ..Card::default()
        }
    }

    // ── The database the tests run against ────────────────────────────────────────────

    /// **`foreign_keys` is ON**, as [`crate::db::open`] sets it for every connection the app
    /// hands out: `deck_tokens.deck_id` CASCADEs off `decks`, and that is a per-connection
    /// setting. [`crate::schema::memory_pair`] already turns it on; this says so out loud.
    fn open() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn
    }

    /// A deck with one active `main` pile and one inactive `maybe` pile.
    fn deck_with_piles(conn: &Connection) -> (i64, i64, i64) {
        let deck = crate::schema::tests::deck(conn, "Tokens");
        let main = crate::schema::tests::category(conn, deck, "main", "Main deck");
        let maybe = crate::schema::tests::category(conn, deck, "maybe", "Maybeboard");
        (deck, main, maybe)
    }

    /// One `deck_cards` row, written straight into the table.
    fn play(conn: &Connection, deck: i64, category: i64, card: &Card<'_>, variant: &str) {
        conn.execute(
            "INSERT INTO deck_cards
                 (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                  name, quantity, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,'en',?7,1,unixepoch(),unixepoch())",
            params![
                deck,
                category,
                variant,
                card.id,
                card.set_code,
                card.collector_number,
                card.name
            ],
        )
        .unwrap();
    }

    /// The two picture columns, written onto a row already inserted.
    ///
    /// Separate from [`Card::insert_raw`] rather than two more fields on the fixture: 3.7% of
    /// printings carry no top-level blob and the rest carry no faces, so every existing fixture
    /// would have had to say `None` twice to keep saying nothing.
    fn pictures(conn: &Connection, id: &str, top: Option<&str>, faces: Option<&str>) {
        conn.execute(
            "UPDATE cards SET image_uris = ?2, face_image_uris = ?3 WHERE id = ?1",
            params![id, top, faces],
        )
        .unwrap();
    }

    /// A `display` URL that passes `image_uri::is_fetchable` — the host allowlist and the
    /// `?<epoch>` cache-buster both, since a URL failing either is dropped rather than carried.
    fn display_uri(tag: &str) -> String {
        format!("{IMAGE_HOST}normal/front/{tag}/{tag}.jpg?1757200000")
    }

    /// [`display_uri`]'s crop twin, so the two variants a list row carries can be told apart.
    fn art_uri(tag: &str) -> String {
        format!("{IMAGE_HOST}art_crop/front/{tag}/{tag}.jpg?1757200000")
    }

    /// The live list, which is what every test below but one is about.
    fn rows(conn: &Connection, deck: i64) -> Vec<DeckTokenRow> {
        deck_token_rows(conn, deck, "live").expect("the resolver must never answer Err")
    }

    fn names(rows: &[DeckTokenRow]) -> Vec<&str> {
        rows.iter().map(|r| r.name.as_str()).collect()
    }

    // ── The keep rule ─────────────────────────────────────────────────────────────────

    #[test]
    fn a_plain_token_resolves() {
        let conn = open();
        tithe().insert(&conn);
        treasure().insert(&conn);
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &tithe(), "live");

        let out = rows(&conn, deck);
        assert_eq!(names(&out), vec!["Treasure"], "one row, and only the token");
        let row = &out[0];
        assert_eq!(row.oracle_id, treasure().oracle_id);
        assert_eq!(row.layout, "token");
        assert_eq!(row.type_line.as_deref(), Some("Token Artifact — Treasure"));
        assert_eq!(
            row.default_card_id,
            treasure().id,
            "the only printing named"
        );
        assert!(row.derived, "the deck derives it");
        assert_eq!(
            row.sources
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Smothering Tithe"],
            "the source is the why"
        );
        assert_eq!(row.sources[0].card_id, tithe().id);
        assert_eq!(
            (row.card_id.as_deref(), row.quantity, row.state.as_deref()),
            (None, None, None),
            "no override stored means three nulls, never a default"
        );
    }

    /// The case a `component == "token"` filter misses, and the whole reason the rule is a
    /// union. Verified against the stored blob on 2026-09-07.
    #[test]
    fn an_emblem_arriving_as_a_combo_piece_resolves() {
        let conn = open();
        elspeth().insert(&conn);
        elspeth_emblem().insert(&conn);
        soldier().insert(&conn);
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &elspeth(), "live");

        let out = rows(&conn, deck);
        assert_eq!(
            names(&out),
            vec!["Elspeth, Sun's Champion Emblem", "Soldier"],
            "the emblem is kept on its layout, the Soldier on its component, and Elspeth \
             herself — a `combo_piece` resolving to a `normal` row — on neither"
        );
        let emblem = &out[0];
        assert_eq!(emblem.layout, "emblem");
        assert_eq!(emblem.oracle_id, elspeth_emblem().oracle_id);
        assert_eq!(emblem.default_card_id, elspeth_emblem().id);
    }

    /// **A token that wears its maker's name is still a token, and there is no name test to
    /// throw it away.** Eternalize and Embalm make a copy of the card, so the token's name *is*
    /// the card's name — and it is a different oracle card under a different printing id.
    ///
    /// This is the whole of what a same-name rule would cost: **154 same-name `all_parts` entries
    /// pass the keep rule across the 108 372 rows a deck can hold, all 154 resolve to
    /// `layout = 'token'`, and none shares its producer's `id` or `oracle_id`** (debug corpus,
    /// 2026-09-07). 55 distinct cards, every one of them Embalm or Eternalize.
    ///
    /// The contrast with `card::meld_parts`, which **must** exclude by name at `card.rs:635`:
    /// there the same-named entry is the same card, and here it is a token *of* it.
    #[test]
    fn an_embalm_token_sharing_its_makers_name_is_kept() {
        let conn = open();
        timeless_dragon().insert(&conn);
        timeless_dragon_token().insert(&conn);
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &timeless_dragon(), "live");

        let out = rows(&conn, deck);
        assert_eq!(
            names(&out),
            vec!["Timeless Dragon"],
            "the Eternalize token is the row the reader needs and shares its maker's name"
        );
        assert_eq!(
            out[0].oracle_id,
            timeless_dragon_token().oracle_id,
            "and it is the token's oracle card, not the creature's — the two only look alike"
        );
        assert_eq!(out[0].layout, "token");
        assert_eq!(
            out[0].type_line.as_deref(),
            Some("Token Creature — Zombie Dragon"),
            "which is the fact that tells the tile apart from the card that made it"
        );
        assert_eq!(
            (out[0].power.as_deref(), out[0].toughness.as_deref()),
            (Some("4"), Some("4")),
            "the token's 4/4, never the creature's 5/5"
        );
    }

    /// **The keep rule is the self-exclusion, and it needs no help.** A card's own printing
    /// arrives as `component: "combo_piece"` resolving to a row with the card's own layout, so it
    /// fails the union before anything else is asked — under the row's **own** id (`Krenko, Mob
    /// Boss`) and under a **different printing's** id (`Smothering Tithe`) alike.
    ///
    /// Both self-entries resolve to rows this fixture really inserts. Leaving either out would
    /// make this a test about an unresolvable id, which is a different rule one step earlier and
    /// would pass whatever the keep rule did.
    #[test]
    fn a_cards_own_printing_never_reaches_the_wall() {
        let conn = open();
        krenko().insert(&conn);
        goblin().insert(&conn);
        tithe().insert(&conn);
        tithe_other_printing().insert(&conn);
        treasure().insert(&conn);
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &krenko(), "live");
        play(&conn, deck, main, &tithe(), "live");

        let out = rows(&conn, deck);
        assert_eq!(
            names(&out),
            vec!["Goblin", "Treasure"],
            "the two tokens and neither maker — Krenko names his own printing and the Tithe \
             names a second printing of itself, and both are `combo_piece` over a `normal` row"
        );
    }

    #[test]
    fn an_all_parts_id_absent_from_cards_is_dropped() {
        let conn = open();
        // The Treasure row is deliberately never inserted: `all_parts` names a printing this
        // corpus does not have, which is 3 or 4 printings in the whole of it.
        tithe().insert(&conn);
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &tithe(), "live");

        assert!(
            rows(&conn, deck).is_empty(),
            "a token nobody can draw or pick art for is not a row worth rendering"
        );
    }

    /// `is_active = 0` means *counts toward nothing*, which is the whole of what the old `maybe`
    /// zone meant. The Sideboard and Companion are active and do contribute — you sleeve those.
    #[test]
    fn a_card_in_an_inactive_category_contributes_nothing() {
        let conn = open();
        tithe().insert(&conn);
        treasure().insert(&conn);
        let (deck, _, maybe) = deck_with_piles(&conn);
        play(&conn, deck, maybe, &tithe(), "live");

        assert!(
            rows(&conn, deck).is_empty(),
            "the Maybeboard makes no tokens"
        );
    }

    #[test]
    fn two_deck_cards_naming_one_token_collapse_and_keep_both_sources() {
        let conn = open();
        tithe().insert(&conn);
        treasure().insert(&conn);
        // A second maker of the same Treasure printing, so the collapse is by `oracle_id` and
        // the sources are two.
        let second = Card {
            id: "c-second-maker",
            oracle_id: "o-second-maker",
            name: "Another Tithe",
            parts: &[("cb7b5024-3a0b-4f14-977e-ba6c4c2567c9", "token", "Treasure")],
            ..Card::default()
        };
        second.insert(&conn);
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &tithe(), "live");
        play(&conn, deck, main, &second, "live");

        let out = rows(&conn, deck);
        assert_eq!(out.len(), 1, "one token, however many cards make it");
        assert_eq!(
            out[0]
                .sources
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Another Tithe", "Smothering Tithe"],
            "both, and in a deterministic order"
        );
    }

    /// **Grouping is by `oracle_id` and never by name.** `Wurmcoil Engine` makes two tokens both
    /// called `Wurm`, separated only by Deathtouch and Lifelink; 104 token/emblem names in the
    /// corpus are shared by more than one `oracle_id` (debug corpus, 2026-09-07).
    #[test]
    fn one_card_making_two_same_named_tokens_yields_two_rows() {
        let conn = open();
        wurmcoil().insert(&conn);
        wurm_lifelink().insert(&conn);
        wurm_deathtouch().insert(&conn);
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &wurmcoil(), "live");

        let out = rows(&conn, deck);
        assert_eq!(names(&out), vec!["Wurm", "Wurm"], "two rows, one name");
        let mut ids: Vec<&str> = out.iter().map(|r| r.oracle_id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(
            ids,
            vec![wurm_lifelink().oracle_id, wurm_deathtouch().oracle_id],
            "and they are the two oracle ids, not one counted twice"
        );
        // The four disambiguation fields are what tells them apart on screen, so they have to
        // reach the wire — and `power`/`toughness` as **strings**, because a real Elemental is
        // `*/*` and there is nothing to parse.
        let texts: Vec<&str> = out
            .iter()
            .map(|r| r.oracle_text.as_deref().unwrap_or(""))
            .collect();
        assert!(texts.contains(&"Lifelink") && texts.contains(&"Deathtouch"));
        assert_eq!(out[0].power.as_deref(), Some("3"));
        assert_eq!(out[0].toughness.as_deref(), Some("3"));
        assert_eq!(
            out[0].colors.as_deref(),
            Some(""),
            "colorless is empty, not null"
        );
    }

    // ── The default printing ──────────────────────────────────────────────────────────

    /// **The tie-break is the common path, not a corner case.** Across 40 Treasure makers, 12
    /// distinct Treasure printings were referenced (debug corpus, 2026-09-07), so a deck with
    /// two makers pointing at two printings gives both a count of 1 and the tie-break is what
    /// actually chooses the art.
    #[test]
    fn the_default_printing_is_stable_across_calls() {
        let conn = open();
        treasure().insert(&conn);
        // A second, *older* printing of the same Treasure: same `oracle_id`, different id.
        let older = Card {
            id: "c-treasure-older",
            set_code: "tvow",
            collector_number: "17",
            released_at: "2021-11-19",
            ..treasure()
        };
        older.insert(&conn);
        let maker_new = Card {
            id: "c-maker-new",
            oracle_id: "o-maker-new",
            name: "Maker New",
            parts: &[("cb7b5024-3a0b-4f14-977e-ba6c4c2567c9", "token", "Treasure")],
            ..Card::default()
        };
        let maker_old = Card {
            id: "c-maker-old",
            oracle_id: "o-maker-old",
            name: "Maker Old",
            parts: &[("c-treasure-older", "token", "Treasure")],
            ..Card::default()
        };
        maker_new.insert(&conn);
        maker_old.insert(&conn);
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &maker_new, "live");
        play(&conn, deck, main, &maker_old, "live");

        let first = rows(&conn, deck);
        let second = rows(&conn, deck);
        assert_eq!(first.len(), 1);
        assert_eq!(
            first[0].default_card_id,
            treasure().id,
            "both printings are referenced once, so `released_at DESC` decides and the 2023 \
             printing wins over the 2021 one"
        );
        assert_eq!(
            first[0].default_card_id, second[0].default_card_id,
            "unstable art on two opens of one deck is the bug this prevents"
        );
    }

    /// The count comes first and the tie-break only settles a draw — asserted with the *older*
    /// printing referenced twice, so a rule that read only the tail would answer the newer one.
    #[test]
    fn the_most_referenced_printing_wins_before_the_tie_break() {
        let conn = open();
        treasure().insert(&conn);
        let older = Card {
            id: "c-treasure-older",
            set_code: "tvow",
            collector_number: "17",
            released_at: "2021-11-19",
            ..treasure()
        };
        older.insert(&conn);
        let makers: [Card<'static>; 3] = [
            Card {
                id: "c-a",
                oracle_id: "o-a",
                name: "Maker A",
                parts: &[("c-treasure-older", "token", "Treasure")],
                ..Card::default()
            },
            Card {
                id: "c-b",
                oracle_id: "o-b",
                name: "Maker B",
                parts: &[("c-treasure-older", "token", "Treasure")],
                ..Card::default()
            },
            Card {
                id: "c-c",
                oracle_id: "o-c",
                name: "Maker C",
                parts: &[("cb7b5024-3a0b-4f14-977e-ba6c4c2567c9", "token", "Treasure")],
                ..Card::default()
            },
        ];
        let (deck, main, _) = deck_with_piles(&conn);
        for maker in &makers {
            maker.insert(&conn);
            play(&conn, deck, main, maker, "live");
        }

        let out = rows(&conn, deck);
        assert_eq!(out.len(), 1);
        assert_eq!(
            out[0].default_card_id, "c-treasure-older",
            "two cards point at the 2021 printing and one at the 2023 one, so the count wins \
             and the newest-first tail never runs"
        );
        assert_eq!(out[0].sources.len(), 3, "and all three are still the why");
    }

    // ── Every failure is an empty vec ─────────────────────────────────────────────────

    /// A deck must not fail to open over an area most decks use lightly — `meld_parts`' rule at
    /// `card.rs:626` applied to a second setting.
    #[test]
    fn every_failure_shape_is_an_empty_vec_not_an_err() {
        let conn = open();
        treasure().insert(&conn);
        let (deck, main, _) = deck_with_piles(&conn);

        let broken: [(&str, Vec<u8>); 4] = [
            // Begins `1f 8b`, so it is read as gzip and will not inflate.
            ("bad gzip", vec![0x1f, 0x8b, 0x00, 0x01, 0x02, 0x03]),
            ("not JSON at all", b"this is not a card".to_vec()),
            ("no all_parts", br#"{"id":"x","name":"x"}"#.to_vec()),
            (
                "all_parts is not an array",
                br#"{"id":"x","name":"x","all_parts":5}"#.to_vec(),
            ),
        ];
        for (i, (why, raw)) in broken.iter().enumerate() {
            let id = format!("c-broken-{i}");
            let card = Card {
                id: &id,
                oracle_id: "o-broken",
                name: "Broken",
                ..Card::default()
            };
            card.insert_raw(&conn, raw);
            play(&conn, deck, main, &card, "live");
            assert_eq!(
                deck_token_rows(&conn, deck, "live"),
                Ok(Vec::new()),
                "{why} must answer an empty list rather than an Err"
            );
            conn.execute("DELETE FROM deck_cards WHERE card_id = ?1", params![id])
                .unwrap();
        }

        assert_eq!(
            deck_token_rows(&conn, 9999, "live"),
            Ok(Vec::new()),
            "a deck that is not there has no tokens, which is an answer"
        );
    }

    // ── The stored override ───────────────────────────────────────────────────────────

    fn stored(conn: &Connection, deck: i64) -> Vec<(String, Option<String>, Option<i64>, String)> {
        conn.prepare(
            "SELECT oracle_id, card_id, quantity, state FROM deck_tokens
              WHERE deck_id = ?1 ORDER BY oracle_id",
        )
        .unwrap()
        .query_map(params![deck], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
    }

    #[test]
    fn a_stored_override_is_joined_onto_the_derived_row() {
        let conn = open();
        tithe().insert(&conn);
        treasure().insert(&conn);
        let older = Card {
            id: "c-treasure-older",
            set_code: "tvow",
            collector_number: "17",
            released_at: "2021-11-19",
            ..treasure()
        };
        older.insert(&conn);
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &tithe(), "live");

        set_token_override(
            &conn,
            deck,
            treasure().oracle_id,
            Some("c-treasure-older"),
            Some(4),
            None,
        )
        .unwrap();

        let out = rows(&conn, deck);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].card_id.as_deref(), Some("c-treasure-older"));
        assert_eq!(out[0].quantity, Some(4));
        assert_eq!(out[0].state.as_deref(), Some("auto"));
        assert_eq!(
            out[0].default_card_id,
            treasure().id,
            "the resolver goes on naming its own printing — which one to draw is TypeScript's \
             conclusion, not this answer"
        );
    }

    #[test]
    fn a_manual_row_the_deck_derives_nothing_for_is_appended() {
        let conn = open();
        treasure().insert(&conn);
        let (deck, _, _) = deck_with_piles(&conn);
        add_token(&conn, deck, treasure().id).unwrap();

        let out = rows(&conn, deck);
        assert_eq!(
            names(&out),
            vec!["Treasure"],
            "drawn on the reader's say-so"
        );
        assert!(!out[0].derived, "nothing in the deck makes it");
        assert!(out[0].sources.is_empty(), "so there is no why to give");
        assert_eq!(out[0].state.as_deref(), Some("manual"));
        assert_eq!(
            out[0].card_id.as_deref(),
            Some(treasure().id),
            "the printing the reader picked out of the grid"
        );
        assert_eq!(out[0].default_card_id, treasure().id);
    }

    #[test]
    fn a_hidden_row_is_still_answered_and_left_for_typescript_to_drop() {
        let conn = open();
        tithe().insert(&conn);
        treasure().insert(&conn);
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &tithe(), "live");
        set_token_override(
            &conn,
            deck,
            treasure().oracle_id,
            None,
            None,
            Some("hidden"),
        )
        .unwrap();

        let out = rows(&conn, deck);
        assert_eq!(
            out.len(),
            1,
            "Rust supplies the fact; the visibility is a conclusion"
        );
        assert_eq!(out[0].state.as_deref(), Some("hidden"));
    }

    /// A `manual` row for a token the deck *does* derive is one row, not two — the append pass
    /// must not double what the derivation already answered.
    #[test]
    fn a_manual_row_for_a_derived_token_is_not_appended_twice() {
        let conn = open();
        tithe().insert(&conn);
        treasure().insert(&conn);
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &tithe(), "live");
        add_token(&conn, deck, treasure().id).unwrap();

        let out = rows(&conn, deck);
        assert_eq!(out.len(), 1);
        assert!(out[0].derived, "the deck still makes it");
        assert_eq!(out[0].state.as_deref(), Some("manual"));
    }

    #[test]
    fn the_grain_refuses_a_duplicate_deck_and_oracle() {
        let conn = open();
        treasure().insert(&conn);
        let (deck, _, _) = deck_with_piles(&conn);

        set_token_override(&conn, deck, treasure().oracle_id, Some("c-a"), None, None).unwrap();
        set_token_override(
            &conn,
            deck,
            treasure().oracle_id,
            Some("c-b"),
            Some(2),
            None,
        )
        .unwrap();
        assert_eq!(
            stored(&conn, deck),
            vec![(
                treasure().oracle_id.to_owned(),
                Some("c-b".to_owned()),
                Some(2),
                "auto".to_owned()
            )],
            "the second write lands on the first through the grain's ON CONFLICT target"
        );

        let second = conn.execute(
            "INSERT INTO deck_tokens (deck_id, oracle_id, state, created_at, updated_at)
             VALUES (?1, ?2, 'auto', 0, 0)",
            params![deck, treasure().oracle_id],
        );
        assert!(
            second.is_err(),
            "and a write going round the command is refused by the index itself"
        );
    }

    /// **The empty row is not representable.** `state = 'auto'` with no printing and no quantity
    /// carries no information, so the write path deletes it — which keeps "no override" one
    /// state rather than two that have to be kept in agreement.
    #[test]
    fn an_override_that_carries_nothing_is_deleted_rather_than_stored() {
        let conn = open();
        treasure().insert(&conn);
        let (deck, _, _) = deck_with_piles(&conn);

        set_token_override(&conn, deck, treasure().oracle_id, None, None, None).unwrap();
        assert!(
            stored(&conn, deck).is_empty(),
            "nothing to say, so nothing written"
        );

        set_token_override(
            &conn,
            deck,
            treasure().oracle_id,
            Some("c-a"),
            Some(3),
            None,
        )
        .unwrap();
        assert_eq!(stored(&conn, deck).len(), 1);
        set_token_override(&conn, deck, treasure().oracle_id, None, None, Some("auto")).unwrap();
        assert!(
            stored(&conn, deck).is_empty(),
            "and a write that empties an existing row deletes it rather than leaving a husk"
        );
    }

    /// A quantity of **zero** is information — a token the reader zeroed while keeping the art
    /// they picked — so it is stored and not read as absent.
    #[test]
    fn a_quantity_of_zero_is_stored_rather_than_read_as_absent() {
        let conn = open();
        treasure().insert(&conn);
        let (deck, _, _) = deck_with_piles(&conn);
        set_token_override(&conn, deck, treasure().oracle_id, None, Some(0), None).unwrap();
        assert_eq!(
            stored(&conn, deck),
            vec![(
                treasure().oracle_id.to_owned(),
                None,
                Some(0),
                "auto".to_owned()
            )]
        );
    }

    #[test]
    fn clearing_an_override_deletes_the_row_and_an_absent_one_is_a_success() {
        let conn = open();
        treasure().insert(&conn);
        let (deck, _, _) = deck_with_piles(&conn);
        set_token_override(&conn, deck, treasure().oracle_id, Some("c-a"), None, None).unwrap();

        clear_token_override(&conn, deck, treasure().oracle_id).unwrap();
        assert!(stored(&conn, deck).is_empty());
        clear_token_override(&conn, deck, treasure().oracle_id)
            .expect("a grain that resolves to no row is a success: the caller wanted no override");
    }

    /// The vocabulary is closed in Rust as well as by the DDL `CHECK`, so an unknown word is a
    /// **sentence** rather than a constraint failure — `deck::set_folder`'s rule.
    #[test]
    fn an_unknown_state_word_is_refused_by_name() {
        let conn = open();
        treasure().insert(&conn);
        let (deck, _, _) = deck_with_piles(&conn);

        assert_eq!(
            set_token_override(
                &conn,
                deck,
                treasure().oracle_id,
                None,
                Some(1),
                Some("nonsense")
            ),
            Err(BAD_STATE.to_owned())
        );
        // Each word the constant carries is one the DDL's CHECK takes — the constant is held to
        // the table rather than to itself.
        for word in TOKEN_STATES {
            set_token_override(&conn, deck, treasure().oracle_id, None, Some(1), Some(word))
                .unwrap_or_else(|e| panic!("`{word}` must be a state the table accepts: {e}"));
        }
    }

    #[test]
    fn adding_a_token_resolves_its_oracle_id_and_refuses_a_printing_that_is_not_there() {
        let conn = open();
        treasure().insert(&conn);
        let (deck, _, _) = deck_with_piles(&conn);

        add_token(&conn, deck, treasure().id).unwrap();
        assert_eq!(
            stored(&conn, deck),
            vec![(
                treasure().oracle_id.to_owned(),
                Some(treasure().id.to_owned()),
                None,
                "manual".to_owned()
            )],
            "the grain is the oracle id and the printing is the art"
        );
        assert_eq!(
            add_token(&conn, deck, "c-nowhere"),
            Err(NO_SUCH_PRINTING.to_owned())
        );
    }

    // ── The variant ──────────────────────────────────────────────────────────────────

    /// The derived list is per-variant, because deck cards are. The **override** is not, which
    /// is why the grain omits it: choosing the Treasure art for a deck and finding it reverted
    /// in the theory build would be a surprise with nothing to recommend it.
    #[test]
    fn the_derivation_is_per_variant_and_the_override_is_not() {
        let conn = open();
        tithe().insert(&conn);
        treasure().insert(&conn);
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &tithe(), "theory");
        set_token_override(&conn, deck, treasure().oracle_id, Some("c-a"), None, None).unwrap();

        let theory = deck_token_rows(&conn, deck, "theory").unwrap();
        assert_eq!(theory.len(), 1, "the plan is what names the Treasure");
        assert!(theory[0].derived);
        assert_eq!(theory[0].card_id.as_deref(), Some("c-a"));
        assert!(
            deck_token_rows(&conn, deck, "live").unwrap().is_empty(),
            "and the live list derives nothing — an `auto` override is a deviation from a token \
             this list needs, so on its own it conjures no row"
        );

        // The same stored row, read from the other list once that list makes the token too.
        play(&conn, deck, main, &tithe(), "live");
        let live = deck_token_rows(&conn, deck, "live").unwrap();
        assert_eq!(
            live[0].card_id.as_deref(),
            Some("c-a"),
            "one art choice, read the same from both lists — the grain omits `variant`, so \
             picking a Treasure here cannot be reverted over there"
        );
    }

    // ── The wire ─────────────────────────────────────────────────────────────────────

    /// The keys `src/lib/ipc.ts` reads, and the two value shapes that cannot be checked by a
    /// name-for-name mirror: `colors` is a **concatenated letter string** (`""`, `"W"`,
    /// `"BGRUW"`) the way `cards.colors` is stored, and `power`/`toughness` are **strings**,
    /// because there is a real `*/*` Elemental in the corpus and nothing to parse.
    #[test]
    fn the_wire_shape_is_camel_case_with_string_power_and_letter_colors() {
        let conn = open();
        elspeth().insert(&conn);
        elspeth_emblem().insert(&conn);
        soldier().insert(&conn);
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &elspeth(), "live");

        let out = rows(&conn, deck);
        let json = serde_json::to_value(&out).unwrap();
        let soldier_row = &json[1];
        // **Sorted, because `serde_json::Value` is a `BTreeMap` and key order is not a fact about
        // the wire.** JSON objects are unordered and `ipc.test.ts`'s struct mirror sorts both
        // sides too; what has to be true is that the *set* of keys agrees name for name.
        assert_eq!(
            soldier_row
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec![
                "cardId",
                "colors",
                "defaultCardId",
                "derived",
                "imageUris",
                "layout",
                "name",
                "oracleId",
                "oracleText",
                "power",
                "quantity",
                "sources",
                "state",
                "toughness",
                "typeLine",
            ]
        );
        assert_eq!(soldier_row["power"], json!("1"), "a string, never a number");
        assert_eq!(soldier_row["colors"], json!("W"), "letters, never an array");
        assert_eq!(
            json[0]["colors"],
            json!(""),
            "and colorless is the empty one"
        );
        assert_eq!(
            soldier_row["sources"][0]
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["cardId", "name"]
        );
    }

    /// **The picture reaches the wire from both columns, and from both entrances.**
    ///
    /// The web build and the phone have no `mtgimg://` to ask, so `cardArtSrc` draws whatever
    /// URL the row carried and nothing else — a row with no `image_uris` is a wall of no-art
    /// frames there while the desktop draws art, which is the failure four other surfaces
    /// shipped with on 2026-08-31 and which no test in jsdom can see.
    ///
    /// Three things at once, because each is a separate way to get it wrong:
    ///
    /// 1. **The derived row**, resolved through the tie-break, off the top-level blob.
    /// 2. **The hand-added row**, resolved through [`newest_printing`] — a second query, so a
    ///    fix applied to one and not the other leaves a `manual` token blank beside a derived
    ///    one that draws.
    /// 3. **A `double_faced_token` with no top-level blob at all**, which is what
    ///    `front_face_selects`/`front_face_map` are here for rather than a bare read of
    ///    `image_uris`: all 120 such rows in the corpus keep their URLs on `card_faces[0]`
    ///    alone, so a top-level-only read answers `null` for every one of them.
    #[test]
    fn a_tokens_picture_reaches_the_wire_from_both_columns_and_both_entrances() {
        let conn = open();
        tithe().insert(&conn);
        treasure().insert(&conn);
        pictures(
            &conn,
            treasure().id,
            Some(&json!({ "display": display_uri("t"), "art": art_uri("t") }).to_string()),
            None,
        );

        // A hand-added emblem whose printing carries its pictures on the face alone.
        elspeth_emblem().insert(&conn);
        pictures(
            &conn,
            elspeth_emblem().id,
            None,
            Some(
                &json!([{ "display": display_uri("e"), "art": art_uri("e") }, serde_json::Value::Null])
                    .to_string(),
            ),
        );

        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &tithe(), "live");
        add_token(&conn, deck, elspeth_emblem().id).unwrap();

        let out = rows(&conn, deck);
        assert_eq!(
            names(&out),
            vec!["Treasure", "Elspeth, Sun's Champion Emblem"],
            "the Treasure is the derived row and the emblem the hand-added tail"
        );
        let map = |row: &DeckTokenRow| -> Vec<(String, String)> {
            row.image_uris
                .clone()
                .expect("a printing with a picture answers a map, never None")
                .into_iter()
                .collect()
        };
        assert_eq!(
            map(&out[0]),
            vec![
                ("art".to_owned(), art_uri("t")),
                ("display".to_owned(), display_uri("t")),
            ],
            "the derived row carries both variants off the top-level blob"
        );
        assert_eq!(
            map(&out[1]),
            vec![
                ("art".to_owned(), art_uri("e")),
                ("display".to_owned(), display_uri("e")),
            ],
            "and the hand-added row carries the front face's, out of the column a \
             `double_faced_token` is the only place with one"
        );
    }

    /// **The picture follows the art the reader picked, not the printing the resolver named.**
    ///
    /// Those two are the same row for every token nobody has deviated on, so the only fixture
    /// that can tell them apart is one holding a second printing with a picture of its own —
    /// and the failure is a *wrong* picture rather than a missing one, on the web and on the
    /// phone alone, which nothing in jsdom and nothing on the desktop can see.
    #[test]
    fn a_picked_printing_brings_its_own_picture() {
        let conn = open();
        tithe().insert(&conn);
        treasure().insert(&conn);
        pictures(
            &conn,
            treasure().id,
            Some(&json!({ "display": display_uri("resolver") }).to_string()),
            None,
        );
        let older = Card {
            id: "c-treasure-older",
            set_code: "tvow",
            collector_number: "17",
            released_at: "2021-11-19",
            ..treasure()
        };
        older.insert(&conn);
        pictures(
            &conn,
            older.id,
            Some(&json!({ "display": display_uri("picked") }).to_string()),
            None,
        );
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &tithe(), "live");

        // Before the pick: the resolver's printing, which is the only one the deck names.
        let out = rows(&conn, deck);
        assert_eq!(out[0].default_card_id, treasure().id);
        assert_eq!(
            out[0].image_uris.as_ref().and_then(|m| m.get("display")),
            Some(&display_uri("resolver"))
        );

        set_token_override(
            &conn,
            deck,
            treasure().oracle_id,
            Some(older.id),
            None,
            None,
        )
        .unwrap();
        let out = rows(&conn, deck);
        assert_eq!(
            out[0].default_card_id,
            treasure().id,
            "the resolver still names its own printing — the pick is a deviation beside it"
        );
        assert_eq!(
            out[0].image_uris.as_ref().and_then(|m| m.get("display")),
            Some(&display_uri("picked")),
            "and the picture is the picked printing's, because `card_id ?? default_card_id` is \
             what the tile addresses"
        );

        // A pick that has left the corpus draws the no-art frame rather than the resolver's
        // art: the tile is still addressing the printing that has gone.
        set_token_override(
            &conn,
            deck,
            treasure().oracle_id,
            Some("c-vanished"),
            None,
            None,
        )
        .unwrap();
        assert_eq!(rows(&conn, deck)[0].image_uris, None);
    }

    /// A URI this app would refuse to fetch is **not** on the wire, which is the half a
    /// present-key check would pass while handing a browser a URL that answers 200 with
    /// something that is not the card.
    ///
    /// Two refusals, both `image_uri::is_fetchable`'s and neither respelled here: a host that
    /// is not `cards.scryfall.io`, and a URL with no `?<epoch>` cache-buster — which is what
    /// Scryfall's `soon.jpg` placeholder is.
    #[test]
    fn a_uri_this_app_will_not_fetch_never_reaches_the_wire() {
        let conn = open();
        tithe().insert(&conn);
        treasure().insert(&conn);
        pictures(
            &conn,
            treasure().id,
            Some(
                &json!({
                    "display": "https://cards.scryfall.io.evil.test/normal/front/a.jpg?123",
                    "art": format!("{IMAGE_HOST}art_crop/front/soon.jpg"),
                })
                .to_string(),
            ),
            None,
        );
        let (deck, main, _) = deck_with_piles(&conn);
        play(&conn, deck, main, &tithe(), "live");

        assert_eq!(
            rows(&conn, deck)[0].image_uris,
            None,
            "an off-host URL and one with no cache-buster are both dropped, and a row left \
             with nothing answers None rather than an empty map"
        );
    }
}
